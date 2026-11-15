// D5 岗位生命周期 · `job/close` Host Remote Action（task-51-B；W2b 写动作）。
//
// 唯一权威口径：`work/d5/joblife/CONTRACT.md`（owner-joblife 冻结）。
//   POST /recruitment/api/job-action/job/close
//   Headers: x-dsh-session: session-<uuid> ; x-recruitment-request: 1 ; content-type: application/json
//   Body:    { "job_id": "<uuid>", "confirm": true, "reason": "<可选，1..500>" }
//
// 为什么单独一个前缀（`/recruitment/api/job-action`）：`overview.ts` 已注册
// `/recruitment/api` 前缀、`actions.ts` 占着 `/recruitment/api/action`，而 webServer 对重复
// `(kind,path)` 直接 throw；本文件只注册 exact path，前缀留出余量给后续岗位生命周期动作。
//
// 身份（与 `http/actor.ts` / `http/actions.ts` **同一套**、共享 `src/index.ts` 的 identity 单例）：
//   `x-dsh-session` → `resolveSessionActor(identity, session)` → alias → HUMAN actor UUID。
//   body / query / header 里的 `actor_id` / `tenant_id` / `x-recruitment-actor` / `x-recruitment-tenant`
//   一律 400 `ACTOR_OVERRIDE_REJECTED`（身份只来自服务端绑定；D-33 / IR-M4d）。
//
// 人类闸门（CONTRACT §1）：`confirm` 必须**严格等于** `true`（缺失 / false / "true" / 1 都不算）。
// 不满足 → 400 `INVALID_ARGS(CONFIRM_REQUIRED)`，且在**碰 DB 之前**抛（零写入、连池都不建）。
//
// 原子终止（CONTRACT §2）：**一个** `withActor` 事务里
//   job(status<>'CLOSED')→CLOSED
//   application(ACTIVE/ON_HOLD)→CLOSED
//   interview(SCHEDULED/RESCHEDULED)→CANCELLED（IN_PROGRESS/POST_INTERVIEW/EVALUATION_READY 不动，只计数）
//   business_task(非终态且 business_refs 引用本岗位/其申请/其面试)→CANCELLED + completed_at
//   task_attempt(上述任务的 CLAIMED/RUNNING)→CANCELLED + ended_at
// 任一失败整体回滚（含动作级内部事件写失败）。**不**写 decision、**不**删行、**不**动 durable_effect/engine_*。
//
// 审计：每次状态迁移由 `recruitment.fn_row_guard()` 自动写 `event_inbox`（本文件不手写迁移事件）；
// 外加一条动作级内部事件 `job.closed`（幂等键 `job-close:<job_id>:<record_version_after>`）。
//
// 响应：`job` / `actor` 字段只来自事务提交后**另开只读事务**的 DB 读回（不回显请求）；
// `terminated` 计数是本事务 `RETURNING` 的真实行数，并逐项与提交后的库状态**双向核对**
// （对不上 → 500 `READBACK_MISMATCH`，不假装成功）。
//
// fail-closed（全部在碰 DB 之前）：非回环 host 不注册路由；同源/请求头/身份覆盖键先拒；
// 未绑定 session → 409 `DEMO_ACTOR_UNMAPPED`；alias 映射的 actor 非 HUMAN → 403 `ACTOR_NOT_HUMAN`；
// 数据库未配置 → 503 `NOT_CONFIGURED`（与 `actor.ts` 同码）。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { isUuid } from '../tools/contract.ts'
import { EVENT_TYPES } from '../runtime/event-types.ts'
import {
  JobDraftError,
  buildJobDraft,
  parseJobDraftInput,
  type JobDraft,
} from '../domain/job-draft.ts'
import { createJobInTransaction, mapDatabaseError } from '../tools/job-create.ts'
import { RecruitmentToolError } from '../tools/errors.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'

// =====================================================================
//  契约常量（CONTRACT §1 冻结；不另设更小的值）
// =====================================================================

/** 本动作的独立前缀（不注册 prefix 路由，只用于拼 exact path / 文档可检索）。 */
export const JOB_ACTION_PREFIX = '/recruitment/api/job-action'
/** `job/close` 的 exact path（冻结）。 */
export const JOB_CLOSE_PATH = `${JOB_ACTION_PREFIX}/job/close`
/** `job/draft` 的 exact path（W2b 契约：只读草案，不写库）。 */
export const JOB_DRAFT_PATH = `${JOB_ACTION_PREFIX}/job/draft`
/** `job/create` 的 exact path（W2b 契约：人确认后写库）。 */
export const JOB_CREATE_PATH = `${JOB_ACTION_PREFIX}/job/create`
/** 草案响应契约版本（`work/d5/joblife/CONTRACT-ACTIONS.md §1`）。 */
export const JOB_DRAFT_CONTRACT_VERSION = 'job-draft 1.0.0'
/** 创建响应契约版本（`work/d5/joblife/CONTRACT-ACTIONS.md §2`）。 */
export const JOB_CREATE_CONTRACT_VERSION = 'job-create 1.0.0'
/** 本动作的契约版本（响应 `contract_version`）。 */
export const JOB_CLOSE_CONTRACT_VERSION = '1.0.0'

/** body 的**封闭键集**（多一个键都不接受）。 */
const JOB_CLOSE_BODY_KEYS = ['confirm', 'job_id', 'reason'] as const
/** `reason` 的最大长度（CONTRACT §1：1..500，只进内部审计事件）。 */
const MAX_REASON_LENGTH = 500
/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 客户端**不许**覆盖的身份键（query / body；命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_KEYS = ['actor_id', 'tenant_id'] as const
/** 请求体上限：64 KiB（超限 413，零写入；与 `actor.ts` 同一暴露面）。 */
const MAX_BODY_BYTES = 64 * 1024
/** 受控的"这是同源面板发起"标记头（与 `overview.ts::REQUEST_HEADER` 同值）。 */
const REQUEST_HEADER = 'x-recruitment-request' as const

/** 响应绝不缓存（与 `actor.ts` 同口径）。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 契约错误的 HTTP 映射（与 `actor.ts::STATUS_BY_CODE` 同口径 + 本动作的 404/503）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VERSION_CONFLICT: 409,
  CONFLICT: 409,
  DB_CONSTRAINT_VIOLATION: 500,
  NOT_CONFIGURED: 503,
  DEMO_ACTOR_UNMAPPED: 409,
}

// ---------------------------------------------------------------------
//  `job/draft` / `job/create` 的 body 契约（`work/d5/joblife/CONTRACT-ACTIONS.md`）
// ---------------------------------------------------------------------

/** `job/draft` body 的封闭键集（§1；身份键不在内，命中即 400）。 */
const JOB_DRAFT_BODY_KEYS = [
  'request_text',
  'recruiter_supplement',
  'department_context',
  'historical_jobs',
  'historical_rubrics',
  'template_id',
] as const

/** `job/create` body 的封闭键集（§2）。 */
const JOB_CREATE_BODY_KEYS = ['job_create_args', 'draft_digest'] as const

/**
 * `job/create` 透传给**现有** `recruitment_job_create` 领域的键（封闭集）。
 *
 * 这里刻意**不**含 `actor_id` / `tenant_id` / `department` 以外的派生键：身份只来自服务端
 * session 绑定；未知键一律 400（不静默丢掉，避免"以为设置了却没生效"）。
 */
const JOB_CREATE_ARGS_KEYS = [
  'code',
  'title',
  'department_id',
  'department_name',
  'description_md',
  'requirements_md',
  'criteria',
  'status',
] as const

/** `draft_digest`（可选）：人确认的草案 canonical sha256（64 hex）；给了就必须合法。 */
const DRAFT_DIGEST_RE = /^[0-9a-f]{64}$/

// =====================================================================
//  终态闭集（严格照 CONTRACT §2；与 `db/migrations/0001_init.sql` 的 CHECK 一致）
// =====================================================================

/** 申请的在途态（唯一会被终止的两种）。 */
const IN_FLIGHT_APPLICATION_STATUSES = ['ACTIVE', 'ON_HOLD'] as const
/** 面试「未开始」态：可以安全取消（不会伪造"未发生"的历史）。 */
const CANCELLABLE_INTERVIEW_STATUSES = ['SCHEDULED', 'RESCHEDULED'] as const
/** 面试「已发生/在途」态：**不自动改**，计入 `interviews_occurred_kept`，交人工。 */
const OCCURRED_INTERVIEW_STATUSES = ['IN_PROGRESS', 'POST_INTERVIEW', 'EVALUATION_READY'] as const
/** 面试终态：不碰，计入 `interviews_already_terminal`。 */
const TERMINAL_INTERVIEW_STATUSES = ['DECIDED', 'CANCELLED', 'NO_SHOW'] as const
/** business_task 终态：不在终止范围内（`ck_business_task_status` 的闭集子集）。 */
const TERMINAL_TASK_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED'] as const
/** task_attempt 的「活跃」态（唯一持有有效租约的两种）。 */
const ACTIVE_ATTEMPT_STATUSES = ['CLAIMED', 'RUNNING'] as const

// =====================================================================
//  写事务的输入 / 输出形状（导出给测试直调与后续动作复用）
// =====================================================================

/** `closeJobInTransaction` 的输入：身份只来自调用方（服务端绑定），不接受客户端字段。 */
export interface CloseJobInput {
  /** 要关闭的岗位（已过 UUID 形状校验）。 */
  readonly job_id: string
  /** 走事务 GUC 的作者（必须 = alias 映射出来的 HUMAN actor；再校验一次 kind）。 */
  readonly actor_id: string
  /** 受控 alias（只进审计事件 payload，便于回溯"谁点的"）。 */
  readonly actor_alias: string
  /** 关闭原因（可选；已过 1..500 校验，只进审计事件 payload，不写业务列）。 */
  readonly reason?: string
}

/** 终止计数（CONTRACT §1 响应 `terminated` 的精确键集）。 */
export interface JobCloseTerminated {
  /** 本次进入终止范围（调用前 ACTIVE/ON_HOLD）的申请数。 */
  readonly applications_total: number
  /** 本次真正改为 CLOSED 的行数（本事务 RETURNING 的真实行数）。 */
  readonly applications_closed: number
  /** 调用前已是 CLOSED 的申请数（不碰，只报告，便于核对"历史保留"）。 */
  readonly applications_already_closed: number
  /** 本次取消的面试数（SCHEDULED/RESCHEDULED → CANCELLED）。 */
  readonly interviews_cancelled: number
  /** 调用前已终态的面试数（DECIDED/CANCELLED/NO_SHOW，不碰）。 */
  readonly interviews_already_terminal: number
  /** 已发生/在途、**故意不改**的面试数（IN_PROGRESS/POST_INTERVIEW/EVALUATION_READY）。 */
  readonly interviews_occurred_kept: number
  /** 本次取消的未完成任务数。 */
  readonly tasks_cancelled: number
  /** 本次取消的活跃执行尝试数。 */
  readonly task_attempts_cancelled: number
}

/** 一次 `job/close` 事务的结果（写结果 + 读回核对所需的 id 集合）。 */
export interface CloseJobTransactionResult {
  readonly job_id: string
  /** 事务提交后的 `job.record_version`（幂等键后缀就是它）。 */
  readonly record_version_after: number
  /** 岗位在调用前就已经是 CLOSED（不再 UPDATE job 行，但残留仍在途的仍被终止）。 */
  readonly replayed: boolean
  /** 本次是否真的写了 job 行（`replayed === false` 时为 true）。 */
  readonly job_updated: boolean
  readonly terminated: JobCloseTerminated
  /** 本次被终止的申请 / 面试 / 任务 / 尝试 id（读回核对 + 证据用；不是响应字段）。 */
  readonly cancelled_application_ids: readonly string[]
  readonly cancelled_interview_ids: readonly string[]
  readonly cancelled_task_ids: readonly string[]
  readonly cancelled_attempt_ids: readonly string[]
  /** 动作级内部事件 `job.closed` 的 event_id；幂等重放时为 `null`（同一版本不重复落事件）。 */
  readonly job_closed_event_id: string | null
}

// =====================================================================
//  SQL（全部参数化；所有 SELECT 只读，写全部在本文件的写事务里）
// =====================================================================

/** 岗位行锁：并发双关闭由这一行 `for update` 串行化（CONTRACT §2 的第一步）。 */
const JOB_LOCK_SQL = `
  select j.id::text       as job_id,
         j.status         as status,
         j.record_version as record_version
    from recruitment.job j
   where j.id = $1::uuid and j.tenant_id = $2::uuid
     for update
`

/** actor（存在性 / 同租户 / kind / display_name）。 */
const ACTOR_SQL = `
  select a.id::text           as actor_id,
         a.kind               as kind,
         a.display_name       as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** 本岗位的全部申请（锁行；用于分类计数 + 面试/任务的范围）。 */
const APPLICATION_SCOPE_SQL = `
  select a.id::text             as id,
         a.lifecycle_status     as lifecycle_status
    from recruitment.application a
   where a.tenant_id = $1::uuid and a.job_id = $2::uuid
   order by a.id
     for update
`

/** 本岗位全部申请下的面试（锁行；用于分类计数）。 */
const INTERVIEW_SCOPE_SQL = `
  select i.id::text as id,
         i.status   as status
    from recruitment.interview i
   where i.tenant_id = $1::uuid and i.application_id = any($2::uuid[])
   order by i.id
     for update
`

/** 本岗位（或其申请/面试）关联的**未终态** business_task（锁行）。 */
const TASK_SCOPE_SQL_HEAD = `
  select t.id::text as id,
         t.status   as status
    from recruitment.business_task t
   where t.tenant_id = $1::uuid
     and t.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
     and (
`
const TASK_SCOPE_SQL_TAIL = `
     )
   order by t.id
     for update
`

/** 上述任务的活跃执行尝试（锁行）。 */
const ATTEMPT_SCOPE_SQL = `
  select ta.id::text as id
    from recruitment.task_attempt ta
   where ta.tenant_id = $1::uuid
     and ta.task_id = any($2::uuid[])
     and ta.status in ('CLAIMED', 'RUNNING')
   order by ta.id
     for update
`

/** 岗位迁移（`fn_row_guard` 自动写 `status_changed_*` + 内部事件 + record_version+1）。 */
const JOB_CLOSE_SQL = `
  update recruitment.job j
     set status = 'CLOSED'
   where j.id = $1::uuid and j.tenant_id = $2::uuid and j.status <> 'CLOSED'
  returning j.record_version as record_version
`

/** 在途申请 → CLOSED（`ck_application_lifecycle_status`；0009 只禁复活，不禁终止）。 */
const UPDATE_APPLICATIONS_SQL = `
  update recruitment.application a
     set lifecycle_status = 'CLOSED'
   where a.tenant_id = $1::uuid
     and a.id = any($2::uuid[])
     and a.lifecycle_status in ('ACTIVE', 'ON_HOLD')
  returning a.id::text as id
`

/** 未开始面试 → CANCELLED（`ck_interview_scheduled` 不约束 CANCELLED）。 */
const UPDATE_INTERVIEWS_SQL = `
  update recruitment.interview i
     set status = 'CANCELLED'
   where i.tenant_id = $1::uuid
     and i.id = any($2::uuid[])
     and i.status in ('SCHEDULED', 'RESCHEDULED')
  returning i.id::text as id
`

/** 未完成任务 → CANCELLED + completed_at（`ck_business_task_completed` 允许 CANCELLED 带完成时间）。 */
const UPDATE_TASKS_SQL = `
  update recruitment.business_task t
     set status = 'CANCELLED', completed_at = now()
   where t.tenant_id = $1::uuid
     and t.id = any($2::uuid[])
     and t.status not in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'SUPERSEDED')
  returning t.id::text as id
`

/** 活跃尝试 → CANCELLED + ended_at（释放 `uq_task_attempt_active_lease`）。 */
const UPDATE_ATTEMPTS_SQL = `
  update recruitment.task_attempt ta
     set status = 'CANCELLED', ended_at = now()
   where ta.tenant_id = $1::uuid
     and ta.id = any($2::uuid[])
     and ta.status in ('CLAIMED', 'RUNNING')
  returning ta.id::text as id
`

/**
 * 动作级内部事件 `job.closed`。
 *
 * 幂等键含 `job.record_version_after`：**同一次**关闭（含 `replayed=true` 的重放）不重复落事件；
 * `on conflict do nothing` 只吞掉"这个键已经写过"这一种情况，其它任何错误（约束/触发器/连接）
 * 都会抛 → `withActor` 回滚整笔事务（CONTRACT §2「事件写失败 → 事务回滚」）。
 */
const JOB_CLOSED_EVENT_SQL = `
  insert into recruitment.event_inbox (
    tenant_id, provider, provider_event_id, event_type, schema_version,
    occurred_at, received_at, recorded_at,
    idempotency_key, idempotency_source, source_object_id,
    payload_ref, payload, trust_level, normalized_event_type, normalizer_version
  ) values (
    $1::uuid, 'internal', null, '${EVENT_TYPES.JOB_CLOSED}', 1,
    now(), now(), now(),
    $2::text, 'FALLBACK_KEY', $3::text,
    null, $4::jsonb, 'INTERNAL', '${EVENT_TYPES.JOB_CLOSED}', 'schema/0001'
  )
  on conflict (tenant_id, idempotency_key) do nothing
  returning event_id::text as event_id
`

/** 提交后**独立只读读回**岗位行（响应 `job` 字段只来自这里，不回显请求）。 */
const JOB_READBACK_SQL = `
  select j.id::text                            as job_id,
         j.status                              as status,
         j.record_version                      as record_version,
         j.status_changed_at                   as status_changed_at,
         j.status_changed_by_actor_id::text    as status_changed_by_actor_id
    from recruitment.job j
   where j.id = $1::uuid and j.tenant_id = $2::uuid
`

/** 提交后读回 actor 行（响应 `actor.display_name` 只来自这里）。 */
const ACTOR_READBACK_SQL = `
  select a.id::text as actor_id, a.display_name as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/**
 * 提交后的**双向核对**（写结果 vs 库状态）：
 *   * 被终止的每个 id 必须真的落在终止态（且 completed_at / ended_at 非空）；
 *   * 本岗位不得再残留 ACTIVE/ON_HOLD 申请、SCHEDULED/RESCHEDULED 面试。
 */
const VERIFY_TERMINATED_SQL = `
  select
    (select count(*)::int from recruitment.application a
      where a.tenant_id = $1::uuid and a.id = any($2::uuid[])
        and a.lifecycle_status = 'CLOSED') as applications_closed,
    (select count(*)::int from recruitment.interview i
      where i.tenant_id = $1::uuid and i.id = any($3::uuid[])
        and i.status = 'CANCELLED') as interviews_cancelled,
    (select count(*)::int from recruitment.business_task t
      where t.tenant_id = $1::uuid and t.id = any($4::uuid[])
        and t.status = 'CANCELLED' and t.completed_at is not null) as tasks_cancelled,
    (select count(*)::int from recruitment.task_attempt ta
      where ta.tenant_id = $1::uuid and ta.id = any($5::uuid[])
        and ta.status = 'CANCELLED' and ta.ended_at is not null) as task_attempts_cancelled,
    (select count(*)::int from recruitment.application a
      where a.tenant_id = $1::uuid and a.job_id = $6::uuid
        and a.lifecycle_status in ('ACTIVE', 'ON_HOLD')) as residual_in_flight,
    (select count(*)::int
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
      where a.tenant_id = $1::uuid and a.job_id = $6::uuid
        and i.status in ('SCHEDULED', 'RESCHEDULED')) as residual_scheduled
`

// =====================================================================
//  行类型
// =====================================================================

interface JobLockRow {
  job_id: string
  status: string
  record_version: number
}

interface ActorRow {
  actor_id: string
  kind: string
  display_name: string
}

interface ApplicationScopeRow {
  id: string
  lifecycle_status: string
}

interface IdStatusRow {
  id: string
  status: string
}

interface IdRow {
  id: string
}

interface JobReadbackRow {
  job_id: string
  status: string
  record_version: number
  status_changed_at: Date | string
  status_changed_by_actor_id: string | null
}

interface ActorReadbackRow {
  actor_id: string
  display_name: string
}

interface VerifyTerminatedRow {
  applications_closed: number
  interviews_cancelled: number
  tasks_cancelled: number
  task_attempts_cancelled: number
  residual_in_flight: number
  residual_scheduled: number
}

// =====================================================================
//  宿主上下文 / 依赖（形状与 `actor.ts` / `actions.ts` 一致；`src/index.ts` 传同一个 webServer + identity）
// =====================================================================

/** 宿主侧用到的 `webServer` 最小面（与 overview / actor 的窄接口同形）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文（`src/index.ts` 把 cordis Context 窄成这个形状再传进来；与 `JobActionHostContext` 结构相同）。 */
export interface JobActionHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * `registerJobActionHttp` 的依赖：库配置 + 已装配的 Demo Actor 身份。
 *
 * 与 `JobActionHttpDeps` **结构相同**（`src/index.ts` 传的是同一个 `actorIdentity` 单例），
 * 但按本仓库既有口径（overview / actor / actions 各自声明自己的窄依赖面）在本文件单列：
 * 本动作只需要 `database` / `databaseIssues` / `identity`，不承诺 actor 模块的其它字段。
 */
export interface JobActionHttpDeps {
  /** 已解析的数据库配置；`null` = 未配置（路由仍注册，返回 503，不假装成功）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** `database === null` 时缺失的配置项（只含变量名，不含密码）。 */
  readonly databaseIssues: readonly string[]
  /** session → alias 注册表 + alias → HUMAN actor 映射（`src/index.ts` 持有的单例）。 */
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  HTTP 小工具（封闭错误信封：`{error:{code,reason_code,message,detail?}}`；照 `actor.ts` 同形）
// =====================================================================

/** 本文件自己产生的、可直接返回的 HTTP 问题（不经过域错误映射）。 */
class JobActionHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'JobActionHttpProblem'
    this.status = status
    this.body = body
  }
}

/** 造一个契约形状的 HTTP 问题（`detail` 缺省不出现，避免 `undefined` 进 JSON）。 */
function jobActionError(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): JobActionHttpProblem {
  return new JobActionHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

/** 写 JSON 响应（固定 no-store + nosniff；防止重复写头）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 405（带 allow）。 */
function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

/** 读请求体（上限 64 KiB；超限 413）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > limit) {
    throw jobActionError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw jobActionError(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${limit} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Content-Type 必须是 JSON（允许带 charset）。 */
function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

/** 读 JSON 请求体 → 普通对象（415/413/400 的封闭映射；不做业务校验）。 */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw jobActionError(
      415,
      'INVALID_ARGS',
      'UNSUPPORTED_MEDIA_TYPE',
      '请求体必须是 Content-Type: application/json',
      { got: req.headers['content-type'] ?? '' },
    )
  }
  const text = await readBody(req, MAX_BODY_BYTES)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw jobActionError(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw jobActionError(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

/**
 * 同源判据：`Host` 必须是本机 Web 监听面的 `127.0.0.1:<port>` / `localhost:<port>`，
 * 必须带 `x-recruitment-request: 1`，`Origin` 缺省或同源。
 *
 * **与 `overview.ts::sameOrigin`（L1657）逐字同语义**；本文件不 import 该模块，是因为
 * `overview.ts` 的依赖链（`tools/scorecard-submit.ts`）在 HEAD `06537b8` 上有一条**既存**
 * 类型错误（`scorecard-submit.ts:1946 TS2339 'rationale'`，与本动作无关），一旦被 import
 * 本 lane 的 `tsc --noEmit` 就再也拿不到 exit 0（见 `work/d5/joblife/B-REPORT.md §类型检查`）。
 * 若 `overview.ts` 的同源判据变化，**这里必须同步**（测试覆盖缺标记头 / 跨源 Origin / 错 Host 三条）。
 * @param req - node 请求（只读 headers）。
 * @param port - 本机 Web 监听端口。
 */
function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  if (req.headers[REQUEST_HEADER] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${host}`
}

/**
 * 同源校验（语义 = `overview.ts::sameOrigin`；不能过就 403）。
 * @param req - node 请求。
 * @param port - 本机 Web 监听端口。
 */
function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw jobActionError(
      403,
      'FORBIDDEN',
      'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
    )
  }
}

/**
 * 拒绝客户端在 query / header 覆盖身份（`actor_id`/`tenant_id`、`x-recruitment-actor`/`x-recruitment-tenant`）。
 * **不碰 DB**。
 * @param req - node 请求。
 * @param url - 解析后的 URL。
 */
function rejectQueryOrHeaderOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/**
 * 拒绝 body 里的身份覆盖键（`actor_id`/`tenant_id`）。**不碰 DB**。
 * @param body - 已解析的 JSON body。
 */
function rejectBodyOverrides(body: Record<string, unknown>): void {
  const rejected = ACTOR_OVERRIDE_KEYS.filter((key) => Object.hasOwn(body, key)).map((key) => `body.${key}`)
  if (rejected.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
      { rejected },
    )
  }
}

/**
 * 读 `X-DSH-Session` 头并归一化（身份**有且只有**这个头）。
 * @param req - node 请求。
 * @returns 规范 session id（`session-<lowercase uuid>`）。
 */
function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined
        ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）'
        : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

/**
 * session → alias → actor（未绑定 / 别名无映射 → 409 `DEMO_ACTOR_UNMAPPED`，零写入）。
 * @param identity - 已装配身份。
 * @param sessionId - 已归一的 session id。
 */
function requireBoundActor(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  // `resolveSessionActor` 抛 `DEMO_ACTOR_UNMAPPED: {reason_code,…}`；外层 `errorResponse` 映射成 409。
  return resolveSessionActor(identity, sessionId)
}

/**
 * 把任意错误翻成 HTTP 状态 + 封闭错误信封（优先解析产品错误消息 `CODE: <compact-json>`）。
 * @param error - 任意错误。
 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof JobActionHttpProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const body: Record<string, unknown> = { code }
      if (typeof parsed.reason_code === 'string' && parsed.reason_code !== '') body.reason_code = parsed.reason_code
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status: STATUS_BY_CODE[code] ?? 500, body: { error: body } }
    } catch {
      // 不是产品错误形态：下面按最小形状兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

/** 路由处理函数的统一错误边界（每条路径都有 JSON 错误体，不把异常抛进宿主事件循环）。 */
function guard(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

// =====================================================================
//  身份 / 数据库读辅助
// =====================================================================

/** 未配置库时的 503（含缺失项；只含变量名，不含密码）。 */
function notConfigured(issues: readonly string[]): JobActionHttpProblem {
  return jobActionError(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，job/close 动作不可用', {
    issues: [...issues],
  })
}

/**
 * 在一个短连接池上执行 `fn`（HTTP 请求级；finally 关池，避免空闲 socket 挂住宿主）。
 * @param deps - 路由依赖。
 * @param fn - 拿到已解析配置与连接池。
 */
async function withDatabase<T>(
  deps: JobActionHttpDeps,
  fn: (cfg: ResolvedDatabaseConfig, pool: DatabasePool) => Promise<T>,
): Promise<T> {
  if (deps.database === null) throw notConfigured(deps.databaseIssues)
  const cfg = deps.database
  const pool = createPool(cfg)
  try {
    return await fn(cfg, pool)
  } finally {
    await closePool(pool)
  }
}

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** 把 timestamptz 读回值统一成 ISO-8601（`null` 原样返回）。 */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// =====================================================================
//  body 解析（封闭键集；全部在碰 DB 之前）
// =====================================================================

/** 已通过形状校验的请求体。 */
interface ParsedCloseJobBody {
  readonly job_id: string
  readonly reason?: string
}

/**
 * 解析 `POST …/job/close` 的 body。
 *
 * 顺序即纪律（每一类都 400，且都在碰 DB 之前）：
 *   1. 封闭键集（多键 → `UNKNOWN_BODY_KEY`）；
 *   2. 人类闸门 `confirm !== true`（缺失/false/"true"/1 → `CONFIRM_REQUIRED`）；
 *   3. `job_id` 必填且是 UUID 文本（否则 `JOB_ID_INVALID`）；
 *   4. 可选 `reason`：给了就必须是 1..500 的非空字符串（否则 `REASON_INVALID`）。
 * @param body - 已解析的 JSON body（已排除 actor/tenant 覆盖键）。
 */
function parseCloseJobBody(body: Record<string, unknown>): ParsedCloseJobBody {
  const unknown = Object.keys(body)
    .filter((key) => !(JOB_CLOSE_BODY_KEYS as readonly string[]).includes(key))
    .sort()
  if (unknown.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'UNKNOWN_BODY_KEY',
      `未声明的 body 键 "${unknown[0]}"（允许：${JOB_CLOSE_BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...JOB_CLOSE_BODY_KEYS] },
    )
  }
  // 人类闸门：必须**严格**是布尔 true（字符串 "true" / 数字 1 都不算确认）。
  if (body.confirm !== true) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'CONFIRM_REQUIRED',
      '关闭岗位必须显式确认（body.confirm 必须严格等于 true）；未确认不写库',
      { confirm: body.confirm === undefined ? 'missing' : typeof body.confirm },
    )
  }
  const jobId = body.job_id
  if (typeof jobId !== 'string' || !isUuid(jobId)) {
    throw jobActionError(400, 'INVALID_ARGS', 'JOB_ID_INVALID', 'job_id 必须是 UUID 文本', {
      job_id: typeof jobId === 'string' ? jobId.slice(0, 64) : `[${typeof jobId}]`,
    })
  }
  let reason: string | undefined
  if (Object.hasOwn(body, 'reason')) {
    const rawReason = body.reason
    if (typeof rawReason !== 'string') {
      throw jobActionError(400, 'INVALID_ARGS', 'REASON_INVALID', '"reason" 必须是非空字符串（1..500）', {
        reason: `[${typeof rawReason}]`,
      })
    }
    const trimmed = rawReason.trim()
    if (trimmed === '' || [...trimmed].length > MAX_REASON_LENGTH) {
      throw jobActionError(400, 'INVALID_ARGS', 'REASON_INVALID', '"reason" 必须是 1..500 个字符的非空文本', {
        length: [...trimmed].length,
        max: MAX_REASON_LENGTH,
      })
    }
    reason = trimmed
  }
  return { job_id: jobId, ...(reason === undefined ? {} : { reason }) }
}

// =====================================================================
//  写事务：closeJobInTransaction（一个 withActor 事务完成全部写）
// =====================================================================

/**
 * 读 actor 行并断言是 HUMAN（Demo Actor 只投影给人；Agent 不得借 alias 关岗）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（只来自服务端配置）。
 * @param actorId - alias 映射出来的 UUID。
 * @returns actor 行（含 display_name）。
 */
async function requireHumanActorRow(
  client: DatabaseClient,
  tenantId: string,
  actorId: string,
): Promise<ActorRow> {
  const { rows } = await client.query<ActorRow>(ACTOR_SQL, [actorId, tenantId])
  const row = rows[0]
  if (row === undefined) {
    throw jobActionError(
      409,
      'DEMO_ACTOR_UNMAPPED',
      'ACTOR_ROW_MISSING',
      'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）',
      { actor_id: actorId },
    )
  }
  if (row.kind !== 'HUMAN') {
    throw jobActionError(
      403,
      'FORBIDDEN',
      'ACTOR_NOT_HUMAN',
      `Demo Actor alias 只能映射到 HUMAN actor（实际 kind=${row.kind}）`,
      { actor_id: row.actor_id, kind: row.kind },
    )
  }
  return row
}

/**
 * 按 kinds 拼 business_task 的引用谓词（两个元素形状**都**要覆盖）：
 *   * 引擎适配层：`{"type":"application"|"job"|"interview","id":…}`（小写 kind，`recruitment-tasks.ts:183`）；
 *   * trace 口径：`{"kind":"APPLICATION"|"JOB"|"INTERVIEW","id":…}`（大写，`domain/trace.ts:330-341`）。
 *
 * 用单元素 jsonb `@>` 容器的析取：jsonb 数组包含是"任一元素包含"，因此
 * `business_refs @> '[{"type":"application","id":"X"}]'` 正好表达"存在这样的元素"。
 * 大小写必须分别枚举（`@>` 是结构化相等，不接受大小写归一）。
 * @param jobId - 岗位 id。
 * @param applicationIds - 本岗位全部申请 id。
 * @param interviewIds - 这些申请下的全部面试 id。
 * @returns `{containers, predicates}`：容器 JSON 文本（按顺序对应 `$2…$n`）与 SQL 谓词。
 */
function buildBusinessRefPredicates(
  jobId: string,
  applicationIds: readonly string[],
  interviewIds: readonly string[],
): { containers: string[]; predicates: string[] } {
  const containers: string[] = []
  const push = (kindLower: string, kindUpper: string, id: string): void => {
    containers.push(JSON.stringify([{ type: kindLower, id }]))
    containers.push(JSON.stringify([{ kind: kindUpper, id }]))
  }
  push('job', 'JOB', jobId)
  for (const id of applicationIds) push('application', 'APPLICATION', id)
  for (const id of interviewIds) push('interview', 'INTERVIEW', id)
  const predicates = containers.map((_, index) => `t.business_refs @> $${index + 2}::jsonb`)
  return { containers, predicates }
}

/**
 * 关闭岗位并**原子**终止在途（CONTRACT §2 的唯一写入口）。
 *
 * 前置：调用方已经 `withActor(pool, actorId, …)`（事务 GUC = 作者）——`fn_row_guard` 在缺 actor 时
 * 直接 23514，所以本函数只负责业务顺序，不重复设身份。
 *
 * 顺序：**先锁岗位行**（并发双关闭串行化）→ 身份 HUMAN 断言 → 锁范围行 → 分类计数 →
 * 迁移（job → application → interview → business_task → task_attempt）→ 动作级事件。
 * 任一步抛错 → 整笔回滚（不写半条）。
 * @param client - `withActor` 事务内客户端。
 * @param cfg - 已解析配置（租户只从这里来）。
 * @param input - 岗位 id + 服务端绑定的作者 + 可选 reason。
 * @returns 写结果（计数 + 被终止 id + 幂等键后缀 record_version）。
 */
export async function closeJobInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  input: CloseJobInput,
): Promise<CloseJobTransactionResult> {
  const tenantId = cfg.tenant_id

  // ---- 1. 岗位行锁（第一步）：不存在/不属于本租户 → 404，零写入 ----
  const jobRows = await client.query<JobLockRow>(JOB_LOCK_SQL, [input.job_id, tenantId])
  const job = jobRows.rows[0]
  if (job === undefined) {
    throw jobActionError(404, 'NOT_FOUND', 'JOB_NOT_FOUND', '该租户下没有这个岗位', {
      job_id: input.job_id,
    })
  }

  // ---- 2. 身份：alias 映射的 actor 必须存在且是 HUMAN（否则 403/409，事务回滚）----
  await requireHumanActorRow(client, tenantId, input.actor_id)

  const replayed = job.status === 'CLOSED'

  // ---- 3. 范围（全部 `for update` 锁住；分类计数基于锁内快照）----
  const applications = await client.query<ApplicationScopeRow>(APPLICATION_SCOPE_SQL, [tenantId, input.job_id])
  const applicationIds = applications.rows.map((row) => row.id)
  const targetApplicationIds = applications.rows
    .filter((row) => (IN_FLIGHT_APPLICATION_STATUSES as readonly string[]).includes(row.lifecycle_status))
    .map((row) => row.id)
  const applicationsAlreadyClosed = applications.rows.filter((row) => row.lifecycle_status === 'CLOSED').length

  const interviewRows = applicationIds.length === 0
    ? []
    : (await client.query<IdStatusRow>(INTERVIEW_SCOPE_SQL, [tenantId, applicationIds])).rows
  const interviewIds = interviewRows.map((row) => row.id)
  const targetInterviewIds = interviewRows
    .filter((row) => (CANCELLABLE_INTERVIEW_STATUSES as readonly string[]).includes(row.status))
    .map((row) => row.id)
  const interviewsOccurredKept = interviewRows.filter((row) =>
    (OCCURRED_INTERVIEW_STATUSES as readonly string[]).includes(row.status)).length
  const interviewsAlreadyTerminal = interviewRows.filter((row) =>
    (TERMINAL_INTERVIEW_STATUSES as readonly string[]).includes(row.status)).length

  const refs = buildBusinessRefPredicates(input.job_id, applicationIds, interviewIds)
  const taskSql = `${TASK_SCOPE_SQL_HEAD}${refs.predicates.join(' or ')}${TASK_SCOPE_SQL_TAIL}`
  const taskRows = (await client.query<IdStatusRow>(taskSql, [tenantId, ...refs.containers])).rows
  const taskIds = taskRows.map((row) => row.id)

  const attemptRows = taskIds.length === 0
    ? []
    : (await client.query<IdRow>(ATTEMPT_SCOPE_SQL, [tenantId, taskIds])).rows
  const attemptIds = attemptRows.map((row) => row.id)

  // ---- 4. 迁移（顺序固定；每一行都由 fn_row_guard 自动写审计 + 内部事件）----
  let recordVersionAfter = job.record_version
  let jobUpdated = false
  if (!replayed) {
    const updated = await client.query<{ record_version: number }>(JOB_CLOSE_SQL, [input.job_id, tenantId])
    const row = updated.rows[0]
    if (row === undefined) {
      // 已持有行锁且状态 <> CLOSED，更新必然是 1 行；0 行只可能是数据异常 → 不猜、回滚。
      throw jobActionError(500, 'INTERNAL', 'JOB_UPDATE_MISSING', '岗位行已锁定但状态迁移未命中（数据异常）', {
        job_id: input.job_id,
      })
    }
    recordVersionAfter = row.record_version
    jobUpdated = true
  }

  const cancelledApplicationIds = targetApplicationIds.length === 0
    ? []
    : (await client.query<IdRow>(UPDATE_APPLICATIONS_SQL, [tenantId, targetApplicationIds])).rows.map((row) => row.id)
  const cancelledInterviewIds = targetInterviewIds.length === 0
    ? []
    : (await client.query<IdRow>(UPDATE_INTERVIEWS_SQL, [tenantId, targetInterviewIds])).rows.map((row) => row.id)
  const cancelledTaskIds = taskIds.length === 0
    ? []
    : (await client.query<IdRow>(UPDATE_TASKS_SQL, [tenantId, taskIds])).rows.map((row) => row.id)
  const cancelledAttemptIds = attemptIds.length === 0
    ? []
    : (await client.query<IdRow>(UPDATE_ATTEMPTS_SQL, [tenantId, attemptIds])).rows.map((row) => row.id)

  const terminated: JobCloseTerminated = {
    applications_total: targetApplicationIds.length,
    applications_closed: cancelledApplicationIds.length,
    applications_already_closed: applicationsAlreadyClosed,
    interviews_cancelled: cancelledInterviewIds.length,
    interviews_already_terminal: interviewsAlreadyTerminal,
    interviews_occurred_kept: interviewsOccurredKept,
    tasks_cancelled: cancelledTaskIds.length,
    task_attempts_cancelled: cancelledAttemptIds.length,
  }
  // 锁内快照与 UPDATE 命中数必须一致（否则说明状态在锁外被改过 → 不静默，回滚）。
  if (terminated.applications_closed !== targetApplicationIds.length
    || terminated.interviews_cancelled !== targetInterviewIds.length
    || terminated.tasks_cancelled !== taskIds.length
    || terminated.task_attempts_cancelled !== attemptIds.length) {
    throw jobActionError(409, 'VERSION_CONFLICT', 'TERMINATION_RACE', '终止范围内的行状态在锁内发生变化（并发写），已回滚', {
      applications: [targetApplicationIds.length, terminated.applications_closed],
      interviews: [targetInterviewIds.length, terminated.interviews_cancelled],
      tasks: [taskIds.length, terminated.tasks_cancelled],
      attempts: [attemptIds.length, terminated.task_attempts_cancelled],
    })
  }

  // ---- 5. 动作级内部事件 `job.closed`（写失败 → 抛 → 整笔回滚）----
  const payload = {
    job_id: input.job_id,
    reason: input.reason ?? null,
    actor_id: input.actor_id,
    alias: input.actor_alias,
    terminated,
    replayed,
  }
  const eventRows = await client.query<{ event_id: string }>(JOB_CLOSED_EVENT_SQL, [
    tenantId,
    `job-close:${input.job_id}:${recordVersionAfter}`,
    input.job_id,
    JSON.stringify(payload),
  ])
  const jobClosedEventId = eventRows.rows[0]?.event_id ?? null

  return {
    job_id: job.job_id,
    record_version_after: recordVersionAfter,
    replayed,
    job_updated: jobUpdated,
    terminated,
    cancelled_application_ids: cancelledApplicationIds,
    cancelled_interview_ids: cancelledInterviewIds,
    cancelled_task_ids: cancelledTaskIds,
    cancelled_attempt_ids: cancelledAttemptIds,
    job_closed_event_id: jobClosedEventId,
  }
}

// =====================================================================
//  提交后只读读回（响应只来自这里；同时做双向核对）
// =====================================================================

/** 提交后读回 + 核对的结果。 */
interface JobCloseReadback {
  readonly job: JobReadbackRow
  readonly actor: ActorReadbackRow
}

/**
 * 事务提交后另开只读事务读回岗位/actor 行，并把**写结果**与库状态逐项核对。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析配置。
 * @param written - 写事务的结果。
 * @returns 读回行（响应 `job` / `actor` 字段来源）。
 */
async function readJobCloseReadback(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  written: CloseJobTransactionResult,
  actorId: string,
): Promise<JobCloseReadback> {
  const jobRows = await client.query<JobReadbackRow>(JOB_READBACK_SQL, [written.job_id, cfg.tenant_id])
  const job = jobRows.rows[0]
  if (job === undefined) {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISSING', '关闭事务已提交但读回不到岗位行（数据异常）', {
      job_id: written.job_id,
    })
  }
  if (job.status !== 'CLOSED') {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISMATCH', '关闭事务已提交但岗位状态不是 CLOSED（数据异常）', {
      job_id: written.job_id,
      status: job.status,
    })
  }
  if (job.record_version !== written.record_version_after) {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISMATCH', '岗位 record_version 与写事务结果不一致（数据异常）', {
      expected: written.record_version_after,
      actual: job.record_version,
    })
  }
  if (job.status_changed_by_actor_id !== actorId) {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISMATCH', '岗位状态迁移的作者不是本次确认人（数据异常）', {
      expected: actorId,
      actual: job.status_changed_by_actor_id,
    })
  }

  const actorRows = await client.query<ActorReadbackRow>(ACTOR_READBACK_SQL, [actorId, cfg.tenant_id])
  const actor = actorRows.rows[0]
  if (actor === undefined) {
    throw jobActionError(409, 'DEMO_ACTOR_UNMAPPED', 'ACTOR_ROW_MISSING', 'alias 映射的 actor 在库里不存在或不属于该租户（fail-closed）', {
      actor_id: actorId,
    })
  }

  const verifyRows = await client.query<VerifyTerminatedRow>(VERIFY_TERMINATED_SQL, [
    cfg.tenant_id,
    written.cancelled_application_ids,
    written.cancelled_interview_ids,
    written.cancelled_task_ids,
    written.cancelled_attempt_ids,
    written.job_id,
  ])
  const verify = verifyRows.rows[0]
  if (verify === undefined) {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISSING', '读回核对查询没有返回行（数据异常）')
  }
  const mismatch: Record<string, [number, number]> = {}
  if (verify.applications_closed !== written.terminated.applications_closed) {
    mismatch.applications_closed = [written.terminated.applications_closed, verify.applications_closed]
  }
  if (verify.interviews_cancelled !== written.terminated.interviews_cancelled) {
    mismatch.interviews_cancelled = [written.terminated.interviews_cancelled, verify.interviews_cancelled]
  }
  if (verify.tasks_cancelled !== written.terminated.tasks_cancelled) {
    mismatch.tasks_cancelled = [written.terminated.tasks_cancelled, verify.tasks_cancelled]
  }
  if (verify.task_attempts_cancelled !== written.terminated.task_attempts_cancelled) {
    mismatch.task_attempts_cancelled = [written.terminated.task_attempts_cancelled, verify.task_attempts_cancelled]
  }
  if (verify.residual_in_flight !== 0) {
    mismatch.residual_in_flight = [0, verify.residual_in_flight]
  }
  if (verify.residual_scheduled !== 0) {
    mismatch.residual_scheduled = [0, verify.residual_scheduled]
  }
  if (Object.keys(mismatch).length > 0) {
    throw jobActionError(
      500,
      'INTERNAL',
      'READBACK_MISMATCH',
      '关闭事务写结果与提交后的库状态不一致（数据异常，请人工核查）',
      { expected_actual: mismatch },
    )
  }
  return { job, actor }
}

// =====================================================================
//  job/draft（只读）· job/create（人确认后写）—— W2b 契约 CONTRACT-ACTIONS.md
// =====================================================================

/**
 * `job/draft` 的 body 校验 + 草案生成（**纯函数路径：不碰 DB、不写任何行**）。
 *
 * 契约：`work/d5/joblife/CONTRACT-ACTIONS.md §1`（封闭键集；空白/超长 → 400 INVALID_ARGS；
 * 缺企业事实必须进 `missing_items`，不得编造）。
 * @param body - 已解析的 JSON body（顶层 actor/tenant 覆盖键已先被拒绝）。
 * @returns 草案（含理由/缺失项/人确认闸门）。
 */
function parseDraftBody(body: Record<string, unknown>): JobDraft {
  const unknown = Object.keys(body)
    .filter((key) => !(JOB_DRAFT_BODY_KEYS as readonly string[]).includes(key))
    .sort()
  if (unknown.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'UNKNOWN_BODY_KEY',
      `未声明的 body 键 "${unknown[0]}"（允许：${JOB_DRAFT_BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...JOB_DRAFT_BODY_KEYS] },
    )
  }
  try {
    return buildJobDraft(parseJobDraftInput(body))
  } catch (error) {
    // 草案领域错误 → 400（保留封闭 reason_code / detail，不把领域消息当 500）。
    if (error instanceof JobDraftError) {
      throw jobActionError(400, 'INVALID_ARGS', error.reason_code, error.message, error.detail)
    }
    throw error
  }
}

/** 一条草案文本条目（`job-draft.ts` 的 `SourcedTextItem` 结构子集）。 */
interface DraftTextItemView {
  readonly text: string
  readonly reason: string
  readonly source: string
}

/**
 * 把 `buildJobDraft` 的**领域输出**映射成 W2b 契约形状（`CONTRACT-ACTIONS.md §1`）。
 *
 * 为什么要映射而不是直接返回：领域输出是给 Agent 工具的形状（每项 `{text,reason,source}`），
 * 契约的 UI 形状是 `job_draft/responsibilities[]` 纯文本 + 独立 `reasons[]`（带 path）。两件事
 * 都不改变事实，只是视图；**不在这里补任何企业事实**（缺失一律 null + missing_items）。
 * @param draft - 领域草案。
 * @returns 契约视图（job_draft / rubric_draft / reasons / missing_items）。
 */
function jobDraftContractView(draft: JobDraft): {
  readonly job_draft: Record<string, unknown>
  readonly rubric_draft: Record<string, unknown>
  readonly reasons: readonly { path: string; reason: string; source: string }[]
  readonly missing_items: readonly { key: string; question: string }[]
} {
  const reasons: { path: string; reason: string; source: string }[] = []
  const textList = (path: string, items: readonly DraftTextItemView[]): string[] => {
    items.forEach((item, index) => {
      reasons.push({ path: `${path}[${index}]`, reason: item.reason, source: item.source })
    })
    return items.map((item) => item.text)
  }
  const factReason = (path: string, block: { readonly reason: string; readonly source: string } | undefined): void => {
    if (block !== undefined) reasons.push({ path, reason: block.reason, source: block.source })
  }
  const job = draft.job
  const rationaleByKey = new Map(draft.rubric_draft.rationale.map((item) => [item.criterion_key, item]))
  const dimensions = draft.rubric_draft.criteria.map((criterion, index) => {
    const key = String(criterion.key ?? '')
    const rationale = rationaleByKey.get(key)
    if (rationale !== undefined) {
      reasons.push({ path: `rubric_draft.dimensions[${index}]`, reason: rationale.reason, source: rationale.source })
    }
    return {
      key,
      label: criterion.label,
      kind: criterion.kind,
      weight: criterion.weight,
      reason: rationale?.reason ?? '',
    }
  })
  const rounds = job.rounds.map((round, index) => {
    reasons.push({ path: `job_draft.rounds[${index}]`, reason: round.reason, source: round.source })
    return { round_no: index + 1, title: round.name, focus: [...round.focus], questions: [] as string[] }
  })
  factReason('job_draft.recruiting_reason', job.recruitment_reason)
  factReason('job_draft.location', job.location)
  factReason('job_draft.level', job.level)
  factReason('job_draft.salary', job.salary)
  factReason('job_draft.headcount', job.headcount)
  return {
    job_draft: {
      title: job.title,
      recruiting_reason: job.recruitment_reason?.value ?? null,
      responsibilities: textList('job_draft.responsibilities', job.responsibilities),
      success_profile: textList('job_draft.success_profile', job.success_profile),
      must_have: textList('job_draft.must_have', job.must_have),
      nice_to_have: textList('job_draft.nice_to_have', job.nice_to_have),
      rounds,
      location: job.location?.value ?? null,
      level: job.level?.value ?? null,
      salary: job.salary?.value ?? null,
      headcount: job.headcount?.value ?? null,
    },
    rubric_draft: {
      dimensions,
      hard_gates: [
        ...draft.rubric_draft.hard_gates.must_have_keys.map((key) => ({ key, kind: 'MUST_HAVE' as const })),
        ...draft.rubric_draft.hard_gates.disqualifier_keys.map((key) => ({ key, kind: 'DISQUALIFIER' as const })),
      ],
      round_focus: draft.rubric_draft.round_focus.map((focus) => ({
        round: focus.round,
        criteria_keys: [...focus.criteria_keys],
      })),
      scorecard_fields: draft.rubric_draft.scorecard_fields.map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
      })),
    },
    reasons,
    missing_items: draft.missing_items.map((item) => ({ key: item.field, question: item.question })),
  }
}

/** 已通过形状校验的 `job/create` body。 */
interface ParsedCreateJobBody {
  readonly args: Record<string, unknown>
  readonly draft_digest?: string
}

/**
 * 解析 `POST …/job/create` 的 body。
 *
 * 顺序即纪律（全部在碰 DB 之前）：
 *   1. 顶层封闭键集（`job_create_args` / `draft_digest`）；
 *   2. `job_create_args` 必须是对象；
 *   3. 参数内**不接受**身份键（actor_id / tenant_id / alias）；
 *   4. 参数键封闭集（只接受现有 `job_create` 的 8 个字段）；
 *   5. 可选 `draft_digest` 必须是 64 位小写 sha256。
 * @param body - 已解析的 JSON body（顶层 actor/tenant 覆盖键已先被拒绝）。
 * @returns 透传给 `createJobInTransaction` 的参数 + 可选草案摘要。
 */
function parseCreateJobBody(body: Record<string, unknown>): ParsedCreateJobBody {
  const unknown = Object.keys(body)
    .filter((key) => !(JOB_CREATE_BODY_KEYS as readonly string[]).includes(key))
    .sort()
  if (unknown.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'UNKNOWN_BODY_KEY',
      `未声明的 body 键 "${unknown[0]}"（允许：${JOB_CREATE_BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...JOB_CREATE_BODY_KEYS] },
    )
  }
  const rawArgs = body.job_create_args
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    throw jobActionError(400, 'INVALID_ARGS', 'JOB_CREATE_ARGS_INVALID', 'job_create_args 必须是 JSON 对象', {
      path: 'job_create_args',
    })
  }
  const args = rawArgs as Record<string, unknown>
  const overrides = (['actor_id', 'tenant_id', 'alias'] as const).filter((key) => Object.hasOwn(args, key))
  if (overrides.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'ACTOR_OVERRIDE_REJECTED',
      '身份只能来自服务端 session 绑定，不接受 job_create_args 内的身份键',
      { rejected: overrides.map((key) => `job_create_args.${key}`) },
    )
  }
  const unknownArgs = Object.keys(args)
    .filter((key) => !(JOB_CREATE_ARGS_KEYS as readonly string[]).includes(key))
    .sort()
  if (unknownArgs.length > 0) {
    throw jobActionError(
      400,
      'INVALID_ARGS',
      'UNKNOWN_JOB_CREATE_ARG',
      `job_create_args 里有未声明的键 "${unknownArgs[0]}"（允许：${JOB_CREATE_ARGS_KEYS.join(', ')}）`,
      { unknown: unknownArgs, allowed: [...JOB_CREATE_ARGS_KEYS] },
    )
  }
  const rawDigest = body.draft_digest
  if (rawDigest !== undefined) {
    if (typeof rawDigest !== 'string' || !DRAFT_DIGEST_RE.test(rawDigest)) {
      throw jobActionError(400, 'INVALID_ARGS', 'DRAFT_DIGEST_INVALID', 'draft_digest 必须是 64 位小写 sha256', {
        path: 'draft_digest',
      })
    }
  }
  return {
    args,
    ...(typeof rawDigest === 'string' ? { draft_digest: rawDigest } : {}),
  }
}

/** 从 `<CODE>: <compact-json>` 形态的工具错误里取 `reason_code`（取不到就 undefined）。 */
function reasonCodeOfToolError(error: RecruitmentToolError): string | undefined {
  const index = error.message.indexOf(': ')
  if (index < 0) return undefined
  try {
    const parsed = JSON.parse(error.message.slice(index + 2)) as { reason_code?: unknown }
    return typeof parsed.reason_code === 'string' ? parsed.reason_code : undefined
  } catch {
    return undefined
  }
}

/**
 * 把 `job_create` 领域的错误翻成 HTTP：唯一特例是**岗位 code 冲突 → 409 CONFLICT**
 * （契约 CONTRACT-ACTIONS §2 要求 409；领域层按 23505 映射成 INVALID_ARGS/DUPLICATE_JOB_CODE，
 * 这里只改 HTTP 语义，不放宽任何校验）。其余交回 `errorResponse`（400 INVALID_ARGS / 500 等）。
 * @param error - 领域/数据库错误。
 */
function translateJobCreateError(error: unknown): never {
  let mapped: unknown = error
  if (!(error instanceof RecruitmentToolError)) {
    mapped = mapDatabaseError(error)
  }
  if (mapped instanceof RecruitmentToolError) {
    if (mapped.code === 'INVALID_ARGS' && reasonCodeOfToolError(mapped) === 'DUPLICATE_JOB_CODE') {
      throw jobActionError(409, 'CONFLICT', 'DUPLICATE_JOB_CODE', '岗位 code 已存在（同租户唯一）；未创建任何行', {
        reason_code: 'DUPLICATE_JOB_CODE',
      })
    }
    throw mapped
  }
  throw mapped
}

// ---- job/create 提交后读回（响应只来自库，不回显请求）----

const JOB_CREATE_JOB_READBACK_SQL = `
  select j.id::text                          as job_id,
         j.code                              as code,
         j.title                             as title,
         j.status                            as status,
         j.department_id::text               as department_id,
         j.current_job_version_id::text      as current_job_version_id,
         j.current_rubric_version_id::text   as current_rubric_version_id,
         j.record_version                    as record_version,
         j.status_changed_at                 as status_changed_at,
         j.status_changed_by_actor_id::text  as status_changed_by_actor_id
    from recruitment.job j
   where j.id = $1::uuid and j.tenant_id = $2::uuid
`

const JOB_CREATE_JOB_VERSION_READBACK_SQL = `
  select v.id::text as job_version_id, v.version_no as version_no, v.payload_hash as payload_hash
    from recruitment.job_version v
   where v.id = $1::uuid and v.tenant_id = $2::uuid
`

const JOB_CREATE_RUBRIC_READBACK_SQL = `
  select rv.id::text as rubric_version_id, rv.version_no as version_no, rv.payload_hash as payload_hash
    from recruitment.rubric_version rv
   where rv.id = $1::uuid and rv.tenant_id = $2::uuid
`

const JOB_CREATE_APPROVAL_READBACK_SQL = `
  select ap.id::text as approval_id, ap.status as status
    from recruitment.approval ap
   where ap.tenant_id = $1::uuid
     and ap.resource_type = 'RUBRIC_VERSION'
     and ap.resource_id = $2::uuid
   order by ap.created_at desc
   limit 1
`

interface JobCreateJobRow {
  readonly job_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly department_id: string
  readonly current_job_version_id: string | null
  readonly current_rubric_version_id: string | null
  readonly record_version: number
  readonly status_changed_at: Date | string
  readonly status_changed_by_actor_id: string | null
}

interface JobCreateVersionRow {
  readonly job_version_id: string
  readonly version_no: number
  readonly payload_hash: string
}

interface JobCreateRubricRow {
  readonly rubric_version_id: string
  readonly version_no: number
  readonly payload_hash: string
}

interface JobCreateApprovalRow {
  readonly approval_id: string
  readonly status: string
}

/** `job/create` 的读回结果。 */
interface JobCreateReadback {
  readonly row: JobCreateJobRow
  readonly versions: Record<string, unknown>
}

/**
 * 事务提交后另开只读事务读回 job / job_version / rubric_version / approval。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析配置。
 * @param written - `createJobInTransaction` 的返回值（只用它给 id，不复用其内容当响应）。
 * @returns 读回行 + versions 块。
 */
async function readJobCreateReadback(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  written: {
    readonly job: { readonly id: string }
    readonly job_version: { readonly id: string } | null
    readonly rubric: { readonly version_id: string } | null
  },
): Promise<JobCreateReadback> {
  const jobRows = await client.query<JobCreateJobRow>(JOB_CREATE_JOB_READBACK_SQL, [written.job.id, cfg.tenant_id])
  const row = jobRows.rows[0]
  if (row === undefined) {
    throw jobActionError(500, 'INTERNAL', 'READBACK_MISSING', '创建事务已提交但读回不到岗位行（数据异常）', {
      job_id: written.job.id,
    })
  }
  const versions: Record<string, unknown> = {}
  if (written.job_version !== null) {
    const rows = await client.query<JobCreateVersionRow>(JOB_CREATE_JOB_VERSION_READBACK_SQL, [
      written.job_version.id,
      cfg.tenant_id,
    ])
    const version = rows.rows[0]
    if (version === undefined) {
      throw jobActionError(500, 'INTERNAL', 'READBACK_MISSING', '读回不到 job_version 行（数据异常）', {
        job_version_id: written.job_version.id,
      })
    }
    versions.job_version_id = version.job_version_id
    versions.version_no = version.version_no
  }
  if (written.rubric !== null) {
    const rows = await client.query<JobCreateRubricRow>(JOB_CREATE_RUBRIC_READBACK_SQL, [
      written.rubric.version_id,
      cfg.tenant_id,
    ])
    const rubric = rows.rows[0]
    if (rubric === undefined) {
      throw jobActionError(500, 'INTERNAL', 'READBACK_MISSING', '读回不到 rubric_version 行（数据异常）', {
        rubric_version_id: written.rubric.version_id,
      })
    }
    versions.rubric_version_id = rubric.rubric_version_id
    const approvals = await client.query<JobCreateApprovalRow>(JOB_CREATE_APPROVAL_READBACK_SQL, [
      cfg.tenant_id,
      rubric.rubric_version_id,
    ])
    const approval = approvals.rows[0]
    if (approval !== undefined) {
      versions.approval_id = approval.approval_id
      versions.approval_status = approval.status
    }
  }
  return { row, versions }
}

// =====================================================================
//  路由：POST /recruitment/api/job-action/job/draft
// =====================================================================

/**
 * `POST /recruitment/api/job-action/job/draft`（**只读**：不建池、不碰 DB、不写任何行）。
 *
 * 契约：`CONTRACT-ACTIONS.md §1`。身份只来自 `X-DSH-Session`（绑定 HUMAN alias；
 * 草案不消费 actor，但仍要求已绑定会话，保证只有受控面板能触发）。
 * @param deps - 路由依赖（只需要 identity）。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleJobDraft(
  deps: JobActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  requireBoundActor(deps.identity, sessionId)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)
  const draft = parseDraftBody(body)
  const view = jobDraftContractView(draft)
  json(res, 200, {
    contract_version: JOB_DRAFT_CONTRACT_VERSION,
    draft: view,
    confirmation: draft.confirmation,
  })
}

// =====================================================================
//  路由：POST /recruitment/api/job-action/job/create
// =====================================================================

/**
 * `POST /recruitment/api/job-action/job/create`（**人确认后写**）。
 *
 * 契约：`CONTRACT-ACTIONS.md §2`。实现方式：
 *   1. 同源 loopback + `X-DSH-Session` 绑定 HUMAN alias（未绑定 409 / 越权 403 在碰 DB 前）；
 *   2. body 只接受 `job_create_args`（现有 job_create 的 8 个字段）+ 可选 `draft_digest`；
 *      顶层/参数内的 actor_id/tenant_id 一律 400（身份只来自服务端绑定）；
 *   3. **复用现有领域函数** `createJobInTransaction`（参数校验/版本化/approval=PENDING 全在它里面，
 *      本文件不重写任何业务规则），单个 `withActor` 事务；
 *   4. 提交后另开只读事务读回 job / job_version / rubric_version / approval；
 *   5. 创建后 rubric 仍是 **PENDING**，本端点**不**自动批准（批准只能走 `job_rubric_approve` 的人动作）。
 *
 * "allow-once"：`recruitment_job_create` 本身没有 DSH approval seam（它写的是 approval=PENDING，
 * 批准是另一条人动作），所以本端点不做假 approval 调用；一次同源 POST = 一次人确认，
 * 且**绝不会**顺带批准 rubric（不造假人类动作）。
 * @param deps - 路由依赖（库配置 + identity）。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleJobCreate(
  deps: JobActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)
  const parsed = parseCreateJobBody(body)

  await withDatabase(deps, async (cfg, pool) => {
    const writeCfg: ResolvedDatabaseConfig = { ...cfg, actor_id: resolved.actor_id }
    // 单事务：复用现有 job_create 领域（错误统一翻译；code 冲突 → 409）。
    const written = await withActor(pool, resolved.actor_id, (client) =>
      createJobInTransaction(client, writeCfg, parsed.args),
    ).catch((error: unknown) => translateJobCreateError(error))

    const readback = await withReadOnly(pool, (client) => readJobCreateReadback(client, cfg, written))
    json(res, 200, {
      contract_version: JOB_CREATE_CONTRACT_VERSION,
      job: {
        job_id: readback.row.job_id,
        code: readback.row.code,
        status: readback.row.status,
        record_version: readback.row.record_version,
      },
      versions: readback.versions,
      readback: {
        table: 'job',
        row: {
          ...readback.row,
          status_changed_at: toIso(readback.row.status_changed_at),
        },
      },
      replayed: false,
    })
  })
}

// =====================================================================
//  路由：POST /recruitment/api/job-action/job/close
// =====================================================================

/**
 * `POST /recruitment/api/job-action/job/close`
 *
 * 流程（顺序即纪律）：同源 → `x-dsh-session` → 已绑定 alias → body 形状（封闭键 +
 * `confirm===true` + job_id + reason）→ 单事务（锁行 → HUMAN → 分类终止 → 动作级事件）→
 * 提交后只读读回 → 精确键响应。
 * @param deps - 路由依赖。
 * @param req - node 请求。
 * @param res - node 响应。
 */
async function handleJobClose(
  deps: JobActionHttpDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireBoundActor(deps.identity, sessionId)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)
  const input = parseCloseJobBody(body)

  await withDatabase(deps, async (cfg, pool) => {
    // ---- 单事务：全部写在这里；任何一步失败整体回滚（withActor 负责 rollback）----
    const written = await withActor(pool, resolved.actor_id, (client) =>
      closeJobInTransaction(client, cfg, {
        job_id: input.job_id,
        actor_id: resolved.actor_id,
        actor_alias: resolved.alias,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }))

    // ---- 提交后独立只读读回（响应 job/actor 字段只来自库，不回显请求）----
    const readback = await withReadOnly(pool, (client) =>
      readJobCloseReadback(client, cfg, written, resolved.actor_id))

    json(res, 200, {
      contract_version: JOB_CLOSE_CONTRACT_VERSION,
      job: {
        job_id: readback.job.job_id,
        status: readback.job.status,
        record_version: readback.job.record_version,
        status_changed_at: toIso(readback.job.status_changed_at),
        status_changed_by_actor_id: readback.job.status_changed_by_actor_id,
      },
      terminated: written.terminated,
      actor: {
        actor_id: readback.actor.actor_id,
        alias: resolved.alias,
        display_name: readback.actor.display_name,
      },
      replayed: written.replayed,
    })
  })
}

// =====================================================================
//  注册入口
// =====================================================================

/**
 * 注册 job 生命周期 Host Remote Action 路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed：宁可按钮 404，也不把写动作挂到网络可达地址）。
 * 三条 exact 路由（同一前缀，避免 webServer 对 `(kind,path)` 重复注册抛错）：
 *   - `POST /recruitment/api/job-action/job/draft`  （只读草案生成，不碰 DB）
 *   - `POST /recruitment/api/job-action/job/create` （人确认后写；复用现有 job_create 领域）
 *   - `POST /recruitment/api/job-action/job/close`  （原子终止在途）
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 库配置 + Demo Actor 身份（与 `actor.ts` / `actions.ts` **同一个** identity 实例）。
 * @returns 注销函数。
 */
export function registerJobActionHttp(ctx: JobActionHostContext, deps: JobActionHttpDeps): () => void {
  const webServer: WebServerFace = ctx.webServer
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: job-action 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const draftHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleJobDraft(deps, req, res)
  })

  const createHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleJobCreate(deps, req, res)
  })

  const closeHandler = guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    assertSameOrigin(req, port)
    rejectQueryOrHeaderOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleJobClose(deps, req, res)
  })

  const disposers = [
    webServer.register({ kind: 'exact', path: JOB_DRAFT_PATH, handler: draftHandler }),
    webServer.register({ kind: 'exact', path: JOB_CREATE_PATH, handler: createHandler }),
    webServer.register({ kind: 'exact', path: JOB_CLOSE_PATH, handler: closeHandler }),
  ]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 注销失败不掩盖别的问题（宿主卸载本来就是尽力而为）。
      }
    }
  }
}

