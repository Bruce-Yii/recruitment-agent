// 宿主侧只读 HTTP 路由：给 Web 工作台面板提供「actor 视角」投影 + D-89 动态面评表单。
//
// 本文件一次做两件事（G6 / G16 / D-89）：
//
//   A. `GET /recruitment/api/overview` —— actor 视角工作台投影
//      · actor/tenant **只来自插件配置**（`ResolvedDatabaseConfig.actor_id/.tenant_id`），
//        绝不接受客户端传：任何 query `actor_id`/`tenant_id` 或 header
//        `x-recruitment-actor`/`x-recruitment-tenant` → 400 `ACTOR_OVERRIDE_REJECTED`，且不碰 DB。
//      · 六个「我的」列表 + 四个「未分配（全租户共享）」列表。归属谓词严格照
//        `contracts/workbench/workbench-rules.md` §0–§3（R-WB-1..4 / D-33）：
//        只用有库约束的列过滤；`actor_role` 是**标签**，不参与归属（R-WB-4）；
//        推不出唯一责任人 ⇒ 进 `unassigned`，不猜给任何角色（R-WB-3）。
//      · 向后兼容：`configured`/`pending`/`counts`/`issues` 仍在；`pending` 与
//        `lists.pending_decisions` 同内容，`counts.pending_total` = owned 待决策数。
//      · **只读是数据库强制的**：投影全部跑在 `begin transaction read only` 里
//        （`db/pool.ts` 的 `withReadOnly`），任何写语句都会被 PG 以 25006 拒绝。
//
//   B. `GET/POST /recruitment/api/scorecard-form` —— D-89 动态表单
//      · GET：按申请钉住的 rubric 生成表单 spec。**维度键由服务端从 rubric 生成**，
//        客户端只拿到这些键（不给「自由拼键」的入口）。
//      · POST：body 的 `dimensions` 键集必须**恰好等于**该申请钉住 rubric 的
//        `dimensions[].key` 集合；多一个 → `DIMENSION_NOT_IN_RUBRIC`，少一个 →
//        `DIMENSION_COVERAGE_INCOMPLETE`，两者都在**写事务之前** fail-closed（零写入）。
//        校验通过后组装成 `items`，**复用产品既有写路径**（`prepareScorecard` /
//        `writeScorecard`，见 `src/tools/scorecard-submit.ts`），不自己写一条 SQL。
//
//   C. **人类表单路径不调用 DSH approval（关键裁决）**
//      D-79 的人机闸门约束的是 **Agent 工具路径**（模型可能替人写面评/替人决策）；
//      本路由是**真人亲手填表提交**的写路径：actor 来自插件配置、请求必须通过
//      loopback + `x-recruitment-request: 1` + Origin 同源校验（浏览器里只有本产品页面会带），
//      提交内容就是人在表单里逐个维度点选的值。因此这里不调用 `approval.request`，
//      也不复用 `createScorecardSubmitTool().execute()`（那是 Agent 工具入口）；
//      `recruitment_scorecard_submit` 工具路径保持原样未改（D-79 仍在其上生效）。
//
// 暴露面按最坏情况设计：**只允许 loopback + 同源**，非回环地址直接不注册路由
// （不是返回 403 之后还挂在那里）。所有响应 `cache-control: no-store`。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { digestOf, isUuid } from '../tools/contract.ts'
import { evalError, prepareScorecard, writeScorecard } from '../tools/scorecard-submit.ts'

// =====================================================================
//  契约常量（见 contracts/workbench/tool-contracts.md §1.7；实现不另设更小的值）
// =====================================================================

/** 工作台投影契约版本。 */
const OVERVIEW_CONTRACT_VERSION = 'workbench-overview 1.0.0'
/** D-89 动态表单契约版本。 */
const FORM_CONTRACT_VERSION = 'scorecard-form 1.0.0'
/** 每个列表的上限（契约 `SECTION_LIMIT`，不可由入参调整）。 */
const SECTION_LIMIT = 20
/** 未分配区恒返回的说明文案（D-33 / R-WB-3）。 */
const UNASSIGNED_NOTE = '全租户共享，没有唯一责任人（D-33 / R-WB-3）'
/** `business_refs.id` 的形态 guard：库层只校验「是数组」，不加 guard 会在脏数据上 22P02。 */
const UUID_REGEX_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
/** 三个封闭枚举（与 `scorecard-submit.ts` / TC §1.1 同一份取值）。 */
const ASSESSMENTS = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const
const OVERALLS = ['ADVANCE', 'HOLD', 'REJECT'] as const
const TRANSCRIPT_BASES = ['TRANSCRIPT', 'NO_TRANSCRIPT'] as const
/** `items` 的保留键（TR-E2）：它与维度 key 同名是**非法**的。 */
const TRANSCRIPT_BASIS_KEY = 'transcript_basis'
/** 表单维度对象允许的键（D-89：只允许 assessment/score/note）。 */
const DIMENSION_FIELDS = ['assessment', 'score', 'note'] as const
/** POST body 允许的顶层键。 */
const FORM_BODY_KEYS = [
  'interview_id', 'rubric_version_id', 'dimensions', 'transcript_basis', 'overall',
  'reject_reasons', 'revision', 'idempotency_key',
] as const
/** POST body 上限：64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024
const MAX_NOTE_LENGTH = 2000
const MAX_IDEMPOTENCY_KEY_LENGTH = 128
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{1,128}$/

/** 路由前缀：本文件注册的所有端点都在它下面。 */
const ROUTE_PREFIX = '/recruitment/api'
/** 工作台投影端点。 */
const OVERVIEW_PATH = `${ROUTE_PREFIX}/overview`
/** D-89 动态面评表单端点（GET spec / POST 提交）。 */
const FORM_PATH = `${ROUTE_PREFIX}/scorecard-form`
/** 同源标记头：页面 fetch 必须带上它（阻止其它站点/表单发起「顺便读一下/顺便写一下」）。 */
const REQUEST_HEADER = 'x-recruitment-request'
/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 响应绝不缓存（读的是真实业务状态）。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** 三维标签（R4）：投影/表单都只读业务库，trigger 只能是 MANUAL。 */
const LABELS = { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' } as const

/**
 * 人工决策闸门的「为什么等」文案。
 * 只描述**库里确实缺什么**（没有当前有效决定），不猜业务原因。
 */
const GATE_REASON: Readonly<Record<string, string>> = {
  S7: 'S7 初筛：还没有人工作出的筛选决定（decision_scope=SCREENING 未记录）',
  S10: 'S10 综合评价：等待人工给出面试轮次或最终决定（decision_scope=STAGE/FINAL 未记录）',
}

/** 条目/列表的 relation 封闭集（workbench-rules §3.6）。 */
type Relation = 'OWNER' | 'REVIEWER' | 'HIRING_MANAGER' | 'INTERVIEWER' | 'UNCLAIMED'
/** 条目 required_action 封闭集（workbench-rules §3.6 的子集，只用本投影会产出的值）。 */
type RequiredAction =
  | 'PROVIDE_DECISION'
  | 'SUBMIT_SCORECARD'
  | 'RESOLVE_REVIEW_ITEM'
  | 'INVESTIGATE_CONNECTOR'
  | 'NONE'

// =====================================================================
//  出参类型（形状是契约：contracts/workbench/tool-contracts.md §3 的信封 + 本 lane 任务书）
// =====================================================================

/** 一条「在等真人决定」的申请。 */
export interface PendingDecisionRow {
  /** 申请 id（UUID 文本）。 */
  readonly application_id: string
  /** 申请当前所在的人工闸门阶段码（`S7` / `S10`）。 */
  readonly stage_code: string
  /** 为什么在等：闸门语义 + 是否被阶段阻断原因阻塞。 */
  readonly reason: string
  /** 我与这条申请的关系（owned 恒 `HIRING_MANAGER`；unassigned 恒 `UNCLAIMED`）。 */
  readonly relation: Relation
  readonly required_action: RequiredAction
}

/** 「我的面试」一行。 */
export interface MyInterviewRow {
  readonly interview_id: string
  readonly application_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
  readonly scheduled_start_at: string | null
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  readonly needs_scorecard: boolean
  readonly required_action: RequiredAction
}

/** 「逾期/缺面评」一行。 */
export interface OverdueScorecardRow {
  readonly interviewer_id: string
  readonly interview_id: string
  readonly application_id: string
  readonly round_no: number
  readonly due_at: string | null
  readonly overdue: true
  readonly latency_hours: number
  readonly reason: string
  readonly required_action: RequiredAction
}

/** 「待复核材料」一行（review_queue）。 */
export interface PendingReviewRow {
  /** 主 id（= `item_id`；同时给 `id` 别名，客户端 normalize 按 `id` 取键）。 */
  readonly item_id: string
  readonly id: string
  readonly run_id: string
  readonly status: string
  readonly deadline: string | null
  readonly overdue: boolean
  readonly reason: string
  readonly relation: Relation
  readonly required_action: RequiredAction
}

/** 「连接器异常」一行（全租户共享；三源并集）。 */
export interface ConnectorIncidentRow {
  readonly kind: 'CONVERSION_FAILED' | 'TRANSCRIPT_PROCESSING_FAILED' | 'INTAKE_FAILED'
  readonly entity_id: string
  /** 主 id 别名（= `entity_id`；客户端 normalize 按 `id` 取键）。 */
  readonly id: string
  readonly status: string
  readonly reason: string
  readonly occurred_at: string | null
  readonly scope: 'SHARED'
  readonly required_action: RequiredAction
}

/** 「等待人工的任务」一行（business_task WAITING_HUMAN）。 */
export interface WaitingHumanTaskRow {
  readonly task_id: string
  readonly task_type: string
  readonly title: string
  readonly status: string
  readonly due_at: string | null
  readonly relation: Relation
  readonly required_action: RequiredAction
}

/** 投影里的 actor（只来自插件配置）。 */
export interface WorkbenchActor {
  readonly actor_id: string
  readonly display_name: string
  readonly roles: readonly string[]
}

/** 计数（全部为非负整数；无数据时为 0，不是 `undefined` / `NaN`）。 */
export interface OverviewCounts {
  /** owned 待决策总条数（= `lists.pending_decisions.length`，向后兼容键）。 */
  readonly pending_total: number
  /** owned 待决策按闸门阶段码聚合（曾叫 `by_stage`，名字必须带 pending）。 */
  readonly pending_by_stage: Readonly<Record<string, number>>
  /** 在办（`lifecycle_status='ACTIVE'`）申请总数，作为分母/上下文。 */
  readonly active_total: number
  /** 在办申请按当前阶段码聚合（与 `pending_by_stage` 是两个不同集合，别混用）。 */
  readonly active_by_stage: Readonly<Record<string, number>>
  readonly my_interviews_total: number
  readonly overdue_scorecards_total: number
  readonly pending_reviews_total: number
  readonly connector_incidents_total: number
  readonly waiting_human_total: number
  /** 四类 unassigned 条数之和。 */
  readonly unassigned_total: number
}

/** 六个 actor 视角列表。 */
export interface WorkbenchLists {
  readonly pending_decisions: readonly PendingDecisionRow[]
  readonly my_interviews: readonly MyInterviewRow[]
  readonly overdue_scorecards: readonly OverdueScorecardRow[]
  readonly pending_reviews: readonly PendingReviewRow[]
  readonly connector_incidents: readonly ConnectorIncidentRow[]
  readonly waiting_human_tasks: readonly WaitingHumanTaskRow[]
}

/** 未分配（全租户共享）区块。 */
export interface WorkbenchUnassigned {
  readonly note: string
  readonly pending_decisions: readonly PendingDecisionRow[]
  readonly pending_reviews: readonly PendingReviewRow[]
  readonly waiting_human_tasks: readonly WaitingHumanTaskRow[]
  readonly connector_incidents: readonly ConnectorIncidentRow[]
}

/** 工作台投影响应（`configured=false` 时列表必为空，绝不编造数据）。 */
export interface OverviewResponse {
  readonly contract_version: string
  readonly configured: boolean
  /** 本次评估时刻（ISO-8601）；未配置时也带（形状完整）。 */
  readonly evaluated_at: string
  /** 未配置时 `null`：没有可信的 actor 来源，不编造。 */
  readonly actor: WorkbenchActor | null
  readonly labels: Readonly<Record<string, string>>
  /** 向后兼容：与 `lists.pending_decisions` 同内容。 */
  readonly pending: readonly PendingDecisionRow[]
  readonly counts: OverviewCounts
  readonly lists: WorkbenchLists
  readonly unassigned: WorkbenchUnassigned
  /** 仅 `configured=false` 时非空：缺失的配置项（不含密码值）。 */
  readonly issues?: readonly string[]
}

// =====================================================================
//  D-89 表单 spec / 提交类型
// =====================================================================

/** rubric 维度的只读元数据（顺序 = rubric 里的顺序）。 */
export interface RubricDimensionSpec {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly question?: string
}

/** 一个维度的控件规格（键由服务端生成，客户端只填值）。 */
export interface FormDimensionControl {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly question?: string
  readonly controls: {
    readonly assessment: readonly string[]
    readonly score: { readonly min: number; readonly max: number }
    readonly note_required: boolean
  }
}

/** `GET /recruitment/api/scorecard-form` 的响应。 */
export interface ScorecardFormSpec {
  readonly contract_version: string
  readonly tool: string
  readonly actor: { readonly actor_id: string; readonly display_name: string }
  readonly interview: {
    readonly id: string
    readonly application_id: string
    readonly round_no: number
    readonly slot_code: string
    readonly status: string
    readonly scheduled_start_at: string
  }
  readonly rubric: {
    readonly id: string
    readonly job_id: string
    readonly payload_hash: string
    readonly dimensions: readonly RubricDimensionSpec[]
  }
  readonly dimensions: readonly FormDimensionControl[]
  readonly transcript_basis: {
    readonly value: (typeof TRANSCRIPT_BASES)[number]
    readonly options: readonly string[]
    readonly locked: true
  }
  readonly overall_options: readonly string[]
  readonly mode: 'CREATE' | 'REVISE' | 'ALREADY_SUBMITTED'
  readonly current: {
    readonly id: string
    readonly status: string
    readonly revision_no: number
    readonly record_version: number
    readonly rubric_version_id: string
  } | null
  readonly labels: Readonly<Record<string, string>>
}

/** 通过形状校验后的 POST 提交体（只含已声明的键）。 */
export interface ScorecardFormSubmission {
  readonly interview_id: string
  readonly rubric_version_id?: string
  readonly dimensions: Readonly<Record<string, { assessment: string; score?: number; note?: string }>>
  readonly transcript_basis: (typeof TRANSCRIPT_BASES)[number]
  readonly overall: (typeof OVERALLS)[number]
  readonly reject_reasons?: readonly unknown[]
  readonly revision?: Readonly<Record<string, unknown>>
  readonly idempotency_key: string
}

// =====================================================================
//  SQL（全部 SELECT；走 withReadOnly 的只读事务）
// =====================================================================

/** 执行 actor（只来自插件配置；不存在时 NOT_FOUND，不猜一个 display_name）。 */
const ACTOR_SQL = `
  select a.id::text as actor_id, a.display_name as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** actor 的角色标签（D-33：标签，不参与归属判定）。 */
const ROLES_SQL = `
  select r.code as code
    from recruitment.actor_role ar
    join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
   where ar.actor_id = $1::uuid and ar.tenant_id = $2::uuid and ar.revoked_at is null
   order by r.code asc
`

/** 在办申请按当前阶段分组（只用于上下文计数，不参与「待人工」判定）。 */
const ACTIVE_BY_STAGE_SQL = `
  select a.current_stage_code as stage_code,
         count(*)::int        as n
    from recruitment.application a
   where a.tenant_id = $1::uuid
     and a.lifecycle_status = 'ACTIVE'
   group by a.current_stage_code
   order by a.current_stage_code
`

/**
 * owned 待决策（workbench-rules §2 / 任务书 1.1）：
 * 在办申请 `current_stage_code='S10'`、无当前有效 `decision(stage_code='S10', scope in ('STAGE','FINAL'))`，
 * 且该申请岗位的部门 `department.hiring_manager_actor_id = actor`。
 *
 * S7 闸门与「S10 但部门无用人经理」的申请**不属于任何个人**（R-WB-3）→ 进 unassigned。
 */
const PENDING_OWNED_SQL = `
  select a.id::text                 as application_id,
         a.current_stage_code       as stage_code,
         a.stage_blocked_reason     as stage_blocked_reason
    from recruitment.application a
    join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
    join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
   where a.tenant_id = $1::uuid
     and a.lifecycle_status = 'ACTIVE'
     and a.current_stage_code = 'S10'
     and d.hiring_manager_actor_id = $2::uuid
     and not exists (
           select 1
             from recruitment.decision dc
            where dc.tenant_id = a.tenant_id
              and dc.application_id = a.id
              and dc.superseded_by_decision_id is null
              and dc.stage_code = 'S10'
              and dc.decision_scope in ('STAGE', 'FINAL'))
   order by a.id asc
   limit ${SECTION_LIMIT}
`

/**
 * unassigned 待决策：**全租户共享，与调用者身份无关**（所以两个 actor 的 unassigned 必须逐项相同）。
 *   · S7 闸门：初筛没有「我是谁的人」这一列 → 不属于任何个人；
 *   · S10 但岗位部门的用人经理为空 → 推不出唯一责任人（R-WB-3/4，不猜给角色）。
 */
const PENDING_UNASSIGNED_SQL = `
  select a.id::text             as application_id,
         a.current_stage_code   as stage_code,
         a.stage_blocked_reason as stage_blocked_reason
    from recruitment.application a
    join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
    join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
   where a.tenant_id = $1::uuid
     and a.lifecycle_status = 'ACTIVE'
     and (
           (a.current_stage_code = 'S7'
            and not exists (
                  select 1 from recruitment.decision dc
                   where dc.tenant_id = a.tenant_id
                     and dc.application_id = a.id
                     and dc.superseded_by_decision_id is null
                     and dc.stage_code = 'S7'
                     and dc.decision_scope = 'SCREENING'))
           or
           (a.current_stage_code = 'S10'
            and d.hiring_manager_actor_id is null
            and not exists (
                  select 1 from recruitment.decision dc
                   where dc.tenant_id = a.tenant_id
                     and dc.application_id = a.id
                     and dc.superseded_by_decision_id is null
                     and dc.stage_code = 'S10'
                     and dc.decision_scope in ('STAGE', 'FINAL')))
         )
   order by a.current_stage_code asc, a.id asc
   limit ${SECTION_LIMIT}
`

/**
 * 我的面试（workbench-rules §2.2）：我是这场面试的 interviewer 行之一，
 * 且面试状态不在 `CANCELLED`/`DECIDED`。`needs_scorecard` 必须走
 * `superseded_by_scorecard_id is null`，否则交过一版就打不上勾。
 *
 * `role_in_interview` **只作展示**（R-WB-1：它只有正则约束，取值开放）。
 */
const MY_INTERVIEWS_SQL = `
  select iv.id::text            as interview_id,
         iv.application_id::text as application_id,
         iv.round_no             as round_no,
         iv.slot_code            as slot_code,
         iv.status               as status,
         iv.scheduled_start_at   as scheduled_start_at,
         ivr.role_in_interview   as role_in_interview,
         ivr.required_scorecard  as required_scorecard,
         (ivr.required_scorecard
          and not exists (
                select 1
                  from recruitment.scorecard sc
                 where sc.interview_id = iv.id
                   and sc.interviewer_id = ivr.id
                   and sc.tenant_id = ivr.tenant_id
                   and sc.superseded_by_scorecard_id is null
                   and sc.status in ('SUBMITTED', 'WAIVED'))) as needs_scorecard
    from recruitment.interview iv
    join recruitment.interviewer ivr
      on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
   where iv.tenant_id = $1::uuid
     and ivr.actor_id = $2::uuid
     and iv.status not in ('CANCELLED', 'DECIDED')
   order by iv.scheduled_start_at asc nulls last, iv.id asc
   limit ${SECTION_LIMIT}
`

/**
 * 逾期/缺面评（任务书 1.1）：`my_interviews` 里 `needs_scorecard=true` 且
 * `scorecard_due_at < now()`，或没有到期时间但 `scheduled_start_at < now()`。
 * `latency_hours = extract(epoch from now()-coalesce(due, scheduled_start))/3600`。
 */
const OVERDUE_SCORECARDS_SQL = `
  select ivr.id::text            as interviewer_id,
         iv.id::text             as interview_id,
         iv.application_id::text as application_id,
         iv.round_no             as round_no,
         ivr.scorecard_due_at    as due_at,
         iv.scheduled_start_at   as scheduled_start_at,
         extract(epoch from ($3::timestamptz - coalesce(ivr.scorecard_due_at, iv.scheduled_start_at))) / 3600.0
           as latency_hours
    from recruitment.interview iv
    join recruitment.interviewer ivr
      on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
   where iv.tenant_id = $1::uuid
     and ivr.actor_id = $2::uuid
     and ivr.required_scorecard
     and iv.status not in ('CANCELLED', 'DECIDED')
     and (ivr.scorecard_due_at < $3::timestamptz
          or (ivr.scorecard_due_at is null and iv.scheduled_start_at < $3::timestamptz))
     and not exists (
           select 1
             from recruitment.scorecard sc
            where sc.interview_id = iv.id
              and sc.interviewer_id = ivr.id
              and sc.tenant_id = ivr.tenant_id
              and sc.superseded_by_scorecard_id is null
              and sc.status in ('SUBMITTED', 'WAIVED'))
   order by coalesce(ivr.scorecard_due_at, iv.scheduled_start_at) asc, iv.id asc
   limit ${SECTION_LIMIT}
`

/**
 * 待复核材料（workbench-rules §2.5-B）：`review_queue.assignee = actor` 且
 * `status in ('QUEUED','IN_REVIEW','CORRECTED')`。`assignee` 是库里**唯一真正的指派字段**。
 */
const PENDING_REVIEWS_OWNED_SQL = `
  select q.id::text  as item_id,
         q.run_id::text as run_id,
         q.status     as status,
         q.deadline   as deadline
    from recruitment.review_queue q
   where q.tenant_id = $1::uuid
     and q.assignee = $2::uuid
     and q.status in ('QUEUED', 'IN_REVIEW', 'CORRECTED')
   order by q.deadline asc, q.id asc
   limit ${SECTION_LIMIT}
`

/** unassigned 待复核：`assignee is null and status='QUEUED'`（库级「待认领」，全租户共享）。 */
const PENDING_REVIEWS_UNASSIGNED_SQL = `
  select q.id::text  as item_id,
         q.run_id::text as run_id,
         q.status     as status,
         q.deadline   as deadline
    from recruitment.review_queue q
   where q.tenant_id = $1::uuid
     and q.assignee is null
     and q.status = 'QUEUED'
   order by q.deadline asc, q.id asc
   limit ${SECTION_LIMIT}
`

/**
 * 连接器异常（任务书 1.1）：**没有 actor 列 → 恒 shared**，
 * 同一内容同时出现在 `lists.connector_incidents` 与 `unassigned.connector_incidents`。
 * 三源并集：
 *   · `conversion_run.status in ('FAILED','CRASHED')` → `CONVERSION_FAILED`
 *   · `transcript_processing_run.status in ('FAILED','PARTIAL')` → `TRANSCRIPT_PROCESSING_FAILED`
 *   · `intake_record.status in ('FAILED','RETRY_WAIT')` → `INTAKE_FAILED`
 * reason 只写机器状态与计数，**不写文件名/候选人信息**（R7 最小化）。
 */
const CONNECTOR_INCIDENTS_SQL = `
  select 'CONVERSION_FAILED'::text as kind,
         cr.id::text               as entity_id,
         cr.status                 as status,
         coalesce(cr.finished_at, cr.recorded_at) as occurred_at,
         'conversion_run 状态 ' || cr.status || '（completeness=' || cr.completeness || '）' as reason
    from recruitment.conversion_run cr
   where cr.tenant_id = $1::uuid and cr.status in ('FAILED', 'CRASHED')
  union all
  select 'TRANSCRIPT_PROCESSING_FAILED'::text,
         tpr.id::text,
         tpr.status,
         tpr.status_changed_at,
         'transcript_processing_run 状态 ' || tpr.status || '（chunk_failed=' || tpr.chunk_failed || '）'
    from recruitment.transcript_processing_run tpr
   where tpr.tenant_id = $1::uuid and tpr.status in ('FAILED', 'PARTIAL')
  union all
  select 'INTAKE_FAILED'::text,
         ir.id::text,
         ir.status,
         ir.status_changed_at,
         'intake_record 状态 ' || ir.status
    from recruitment.intake_record ir
   where ir.tenant_id = $1::uuid and ir.status in ('FAILED', 'RETRY_WAIT')
   order by occurred_at desc, entity_id asc
   limit ${SECTION_LIMIT}
`

/**
 * 「我的」WAITING_HUMAN 任务（workbench-rules §2.1 三源并集）：
 *   1) `created_by_actor_id = actor` → OWNER
 *   2) `business_refs` 含 INTERVIEW 且该场面试的 interviewer.actor_id = actor → INTERVIEWER
 *   3) `business_refs` 含 APPLICATION 且该申请岗位部门的 hiring_manager_actor_id = actor → HIRING_MANAGER
 * `business_refs.id` 先用正则过滤再 `::uuid`：脏 ref 不许让整个查询 22P02。
 * relation 优先级按 §3.6：OWNER > HIRING_MANAGER > INTERVIEWER。
 */
const WAITING_TASKS_OWNED_SQL = `
  with refs as (
    select bt.id as task_id, bt.tenant_id, r.value as r
      from recruitment.business_task bt
      cross join lateral jsonb_array_elements(bt.business_refs) as r(value)
     where bt.tenant_id = $1::uuid and bt.status = 'WAITING_HUMAN'
  ), ref_owner as (
    select distinct rf.task_id, 'INTERVIEWER'::text as relation, ivr.actor_id as owner_actor_id
      from refs rf
      join recruitment.interviewer ivr
        on rf.r->>'kind' = 'INTERVIEW'
       and (rf.r->>'id') ~ $3
       and ivr.interview_id = (rf.r->>'id')::uuid
       and ivr.tenant_id = rf.tenant_id
    union
    select distinct rf.task_id, 'HIRING_MANAGER'::text, d.hiring_manager_actor_id
      from refs rf
      join recruitment.application a
        on rf.r->>'kind' = 'APPLICATION'
       and (rf.r->>'id') ~ $3
       and a.id = (rf.r->>'id')::uuid
       and a.tenant_id = rf.tenant_id
      join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
      join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
     where d.hiring_manager_actor_id is not null
  )
  select bt.id::text  as task_id,
         bt.task_type as task_type,
         bt.title     as title,
         bt.status    as status,
         bt.due_at    as due_at,
         case
           when bt.created_by_actor_id = $2::uuid then 'OWNER'
           when exists (select 1 from ref_owner o
                         where o.task_id = bt.id and o.owner_actor_id = $2::uuid
                           and o.relation = 'HIRING_MANAGER') then 'HIRING_MANAGER'
           else 'INTERVIEWER'
         end as relation
    from recruitment.business_task bt
   where bt.tenant_id = $1::uuid
     and bt.status = 'WAITING_HUMAN'
     and (bt.created_by_actor_id = $2::uuid
          or exists (select 1 from ref_owner o
                      where o.task_id = bt.id and o.owner_actor_id = $2::uuid))
   order by bt.due_at asc nulls last, bt.id asc
   limit ${SECTION_LIMIT}
`

/**
 * unassigned WAITING_HUMAN：`created_by_actor_id IS NULL` 且 `ref_owner` 里没有任何人。
 * `PENDING` 之类「不需要人」的任务不进 unassigned（否则无主区每天刷出几百条不需要处理的）。
 */
const WAITING_TASKS_UNASSIGNED_SQL = `
  with refs as (
    select bt.id as task_id, bt.tenant_id, r.value as r
      from recruitment.business_task bt
      cross join lateral jsonb_array_elements(bt.business_refs) as r(value)
     where bt.tenant_id = $1::uuid and bt.status = 'WAITING_HUMAN'
  ), ref_owner as (
    select distinct rf.task_id, 'INTERVIEWER'::text as relation, ivr.actor_id as owner_actor_id
      from refs rf
      join recruitment.interviewer ivr
        on rf.r->>'kind' = 'INTERVIEW'
       and (rf.r->>'id') ~ $2
       and ivr.interview_id = (rf.r->>'id')::uuid
       and ivr.tenant_id = rf.tenant_id
    union
    select distinct rf.task_id, 'HIRING_MANAGER'::text, d.hiring_manager_actor_id
      from refs rf
      join recruitment.application a
        on rf.r->>'kind' = 'APPLICATION'
       and (rf.r->>'id') ~ $2
       and a.id = (rf.r->>'id')::uuid
       and a.tenant_id = rf.tenant_id
      join recruitment.job j        on j.id = a.job_id        and j.tenant_id = a.tenant_id
      join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
     where d.hiring_manager_actor_id is not null
  )
  select bt.id::text  as task_id,
         bt.task_type as task_type,
         bt.title     as title,
         bt.status    as status,
         bt.due_at    as due_at
    from recruitment.business_task bt
   where bt.tenant_id = $1::uuid
     and bt.status = 'WAITING_HUMAN'
     and bt.created_by_actor_id is null
     and not exists (select 1 from ref_owner o where o.task_id = bt.id)
   order by bt.due_at asc nulls last, bt.id asc
   limit ${SECTION_LIMIT}
`

// =====================================================================
//  D-89 表单的读路径 SQL（面试归属 / rubric 三绑定 / current 面评 / 转写基准）
// =====================================================================

/** 面试 + 申请（rubric 三绑定需要 `application.rubric_version_id` 与 `job_id`）。 */
const FORM_INTERVIEW_SQL = `
  select i.id::text             as id,
         i.application_id::text as application_id,
         i.round_no             as round_no,
         i.slot_code            as slot_code,
         i.status               as status,
         i.scheduled_start_at   as scheduled_start_at,
         a.job_id::text         as job_id,
         a.rubric_version_id::text as pinned_rubric_version_id
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

/** 该 actor 是否这场面试已登记的 interviewer（SC-02；只作归属，不是权限拦截）。 */
const FORM_INTERVIEWER_SQL = `
  select ivr.id::text as id, ivr.required_scorecard as required_scorecard
    from recruitment.interviewer ivr
   where ivr.interview_id = $1::uuid and ivr.actor_id = $2::uuid and ivr.tenant_id = $3::uuid
`

/** rubric 版本（形状与 scorecard-submit 的 loadRubric 一致）。 */
const FORM_RUBRIC_SQL = `
  select rv.id::text as id, rv.job_id::text as job_id, rv.payload_hash as payload_hash,
         rv.dimensions as dimensions
    from recruitment.rubric_version rv
   where rv.id = $1::uuid and rv.tenant_id = $2::uuid
`

/** 当前面评（`superseded_by_scorecard_id is null`；`uq_scorecard_current` 保证至多一条）。 */
const FORM_CURRENT_SQL = `
  select sc.id::text as id, sc.status as status, sc.revision_no as revision_no,
         sc.record_version as record_version, sc.rubric_version_id::text as rubric_version_id
    from recruitment.scorecard sc
   where sc.interview_id = $1::uuid and sc.interviewer_id = $2::uuid and sc.tenant_id = $3::uuid
     and sc.superseded_by_scorecard_id is null
`

/**
 * 该场面试的 canonical transcript 是否 READY（与 `scorecard-submit.ts::isCanonicalTranscriptReady`
 * 同一语义 SQL：`meeting_binding` 链路 → `transcript_artifact.is_canonical` → `transcript_status='READY'`）。
 */
const FORM_TRANSCRIPT_READY_SQL = `
  select ta.transcript_status as transcript_status
    from recruitment.meeting_binding mb
    join recruitment.transcript_artifact ta
      on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
   where mb.interview_id = $1::uuid and mb.tenant_id = $2::uuid
     and mb.unbound_at is null and ta.is_canonical
`

/**
 * 预校验用：该申请**有效 rubric** 的维度（申请钉住优先；未钉住用显式 id）。
 * 只在「能确定有效 rubric 且它属于该申请岗位」时返回行——其它情形交给 `prepareScorecard`
 * 抛契约错误（RUBRIC_UNRESOLVED / RUBRIC_NOT_OF_JOB / RUBRIC_MISMATCH），避免抢在它前面
 * 用错的 rubric 报维度错误。
 */
const FORM_EFFECTIVE_RUBRIC_SQL = `
  select rv.dimensions as dimensions
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    join recruitment.rubric_version rv
      on rv.id = coalesce(a.rubric_version_id, $3::uuid)
     and rv.tenant_id = a.tenant_id
     and rv.job_id = a.job_id
   where i.id = $1::uuid and i.tenant_id = $2::uuid
`

// =====================================================================
//  小工具
// =====================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 pg 的 timestamptz（Date / ISO 文本）转 ISO 文本；无效返回 undefined。 */
function isoOf(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(ms)) return undefined
  return new Date(ms).toISOString()
}

/** 同上，但缺失时给 `null`（列表行里的时间字段用契约给 null）。 */
function isoOrNull(value: unknown): string | null {
  return isoOf(value) ?? null
}

/** 把一行的阶段阻断原因拼进 reason（没有就原样返回闸门文案）。 */
function pendingReason(stageCode: string, blockedReason: string | null): string {
  const base = GATE_REASON[stageCode] ?? `阶段 ${stageCode} 在等人工决定`
  return blockedReason === null || blockedReason.trim() === ''
    ? base
    : `${base}；当前阶段受阻：${blockedReason}`
}

/** 未配置时的空计数：形状完整、全 0，面板因此不会渲染出 `undefined`/`NaN`。 */
function emptyCounts(): OverviewCounts {
  return {
    pending_total: 0,
    pending_by_stage: {},
    active_total: 0,
    active_by_stage: {},
    my_interviews_total: 0,
    overdue_scorecards_total: 0,
    pending_reviews_total: 0,
    connector_incidents_total: 0,
    waiting_human_total: 0,
    unassigned_total: 0,
  }
}

/** 未配置时的空列表：六个键与四个 unassigned 键都在（形状完整）。 */
function emptyLists(): WorkbenchLists {
  return {
    pending_decisions: [],
    my_interviews: [],
    overdue_scorecards: [],
    pending_reviews: [],
    connector_incidents: [],
    waiting_human_tasks: [],
  }
}

/** 数据库未配置时的空投影：形状完整、列表全空、带 issues——绝不编造数据。 */
function unconfiguredOverview(issues: readonly string[]): OverviewResponse {
  return {
    contract_version: OVERVIEW_CONTRACT_VERSION,
    configured: false,
    evaluated_at: new Date().toISOString(),
    actor: null,
    labels: LABELS,
    pending: [],
    counts: emptyCounts(),
    lists: emptyLists(),
    unassigned: {
      note: UNASSIGNED_NOTE,
      pending_decisions: [],
      pending_reviews: [],
      waiting_human_tasks: [],
      connector_incidents: [],
    },
    issues,
  }
}

// =====================================================================
//  A. 工作台投影（只读；调用方保证事务是 `begin transaction read only`）
// =====================================================================

interface PendingDbRow {
  application_id: string
  stage_code: string
  stage_blocked_reason: string | null
}

interface MyInterviewDbRow {
  interview_id: string
  application_id: string
  round_no: number
  slot_code: string
  status: string
  scheduled_start_at: Date | string | null
  role_in_interview: string
  required_scorecard: boolean
  needs_scorecard: boolean
}

interface OverdueDbRow {
  interviewer_id: string
  interview_id: string
  application_id: string
  round_no: number
  due_at: Date | string | null
  scheduled_start_at: Date | string | null
  latency_hours: string | number | null
}

interface ReviewDbRow {
  item_id: string
  run_id: string
  status: string
  deadline: Date | string | null
}

interface IncidentDbRow {
  kind: ConnectorIncidentRow['kind']
  entity_id: string
  status: string
  occurred_at: Date | string | null
  reason: string
}

interface TaskDbRow {
  task_id: string
  task_type: string
  title: string
  status: string
  due_at: Date | string | null
  relation?: Relation
}

/**
 * 读取 actor 视角工作台投影（**只读**；接收事务内 client，不自己建池/开事务）。
 *
 * @param client - 只读事务内的连接（生产路径由 `withReadOnly` 提供；测试可直接给回滚事务）。
 * @param cfg - 已解析配置（tenant 只从这里来，不接受入参覆盖）。
 * @param actorId - 视图身份；缺省 `cfg.actor_id`（**永不由 HTTP 客户端传入**）。
 * @returns 投影响应；空库返回空列表 + 0 计数（不是错误）。
 * @throws RecruitmentToolError - `NOT_FOUND(ACTOR_NOT_FOUND)`（配置的 actor 不在该租户）。
 */
export async function readWorkbenchProjection(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  actorId: string = cfg.actor_id,
): Promise<OverviewResponse> {
  const tenantId = cfg.tenant_id
  const nowRow = await client.query<{ now_ts: Date | string }>('select now() as now_ts')
  const nowIso = isoOf(nowRow.rows[0]?.now_ts) ?? new Date().toISOString()

  const actorRows = await client.query<{ actor_id: string; display_name: string }>(ACTOR_SQL, [actorId, tenantId])
  const actor = actorRows.rows[0]
  if (actor === undefined) {
    throw evalError('NOT_FOUND', 'ACTOR_NOT_FOUND', '配置的 actor 不在该租户下（actor/tenant 只来自插件配置）', {
      actor_id: actorId,
    })
  }
  const rolesResult = await client.query<{ code: string }>(ROLES_SQL, [actorId, tenantId])

  const activeResult = await client.query<{ stage_code: string; n: number }>(ACTIVE_BY_STAGE_SQL, [tenantId])

  const pendingOwnedResult = await client.query<PendingDbRow>(PENDING_OWNED_SQL, [tenantId, actorId])
  const pendingUnassignedResult = await client.query<PendingDbRow>(PENDING_UNASSIGNED_SQL, [tenantId])

  const myInterviewsResult = await client.query<MyInterviewDbRow>(MY_INTERVIEWS_SQL, [tenantId, actorId])
  const overdueResult = await client.query<OverdueDbRow>(OVERDUE_SCORECARDS_SQL, [tenantId, actorId, nowIso])

  const reviewsOwnedResult = await client.query<ReviewDbRow>(PENDING_REVIEWS_OWNED_SQL, [tenantId, actorId])
  const reviewsUnassignedResult = await client.query<ReviewDbRow>(PENDING_REVIEWS_UNASSIGNED_SQL, [tenantId])

  const incidentsResult = await client.query<IncidentDbRow>(CONNECTOR_INCIDENTS_SQL, [tenantId])

  const tasksOwnedResult = await client.query<TaskDbRow>(WAITING_TASKS_OWNED_SQL, [tenantId, actorId, UUID_REGEX_SQL])
  const tasksUnassignedResult = await client.query<TaskDbRow>(WAITING_TASKS_UNASSIGNED_SQL, [tenantId, UUID_REGEX_SQL])

  // ---- 在办按阶段（细节不能丢：之前只取总和）----
  const activeByStage: Record<string, number> = {}
  let activeTotal = 0
  for (const row of activeResult.rows) {
    const n = Number.isFinite(row.n) ? row.n : 0
    activeByStage[row.stage_code] = (activeByStage[row.stage_code] ?? 0) + n
    activeTotal += n
  }

  // ---- 待决策 ----
  const pendingOwned: PendingDecisionRow[] = pendingOwnedResult.rows.map((row) => ({
    application_id: row.application_id,
    stage_code: row.stage_code,
    reason: pendingReason(row.stage_code, row.stage_blocked_reason),
    relation: 'HIRING_MANAGER',
    required_action: 'PROVIDE_DECISION',
  }))
  const pendingUnassigned: PendingDecisionRow[] = pendingUnassignedResult.rows.map((row) => ({
    application_id: row.application_id,
    stage_code: row.stage_code,
    reason: pendingReason(row.stage_code, row.stage_blocked_reason),
    relation: 'UNCLAIMED',
    required_action: 'PROVIDE_DECISION',
  }))
  const pendingByStage: Record<string, number> = {}
  for (const row of pendingOwned) pendingByStage[row.stage_code] = (pendingByStage[row.stage_code] ?? 0) + 1

  // ---- 我的面试 ----
  const myInterviews: MyInterviewRow[] = myInterviewsResult.rows.map((row) => ({
    interview_id: row.interview_id,
    application_id: row.application_id,
    round_no: row.round_no,
    slot_code: row.slot_code,
    status: row.status,
    scheduled_start_at: isoOrNull(row.scheduled_start_at),
    role_in_interview: row.role_in_interview,
    required_scorecard: row.required_scorecard,
    needs_scorecard: row.needs_scorecard,
    required_action: row.needs_scorecard ? 'SUBMIT_SCORECARD' : 'NONE',
  }))

  // ---- 逾期/缺面评 ----
  const overdueScorecards: OverdueScorecardRow[] = overdueResult.rows.map((row) => {
    const raw = Number(row.latency_hours)
    const latency = Number.isFinite(raw) ? Math.round(raw * 10) / 10 : 0
    return {
      interviewer_id: row.interviewer_id,
      interview_id: row.interview_id,
      application_id: row.application_id,
      round_no: row.round_no,
      due_at: isoOrNull(row.due_at),
      overdue: true,
      latency_hours: latency,
      reason: `面评未提交：已超过期限 ${latency} 小时（required_scorecard=true）`,
      required_action: 'SUBMIT_SCORECARD',
    }
  })

  // ---- 待复核材料 ----
  const nowMs = Date.parse(nowIso)
  const toReviewRow = (row: ReviewDbRow, relation: Relation): PendingReviewRow => {
    const deadlineIso = isoOrNull(row.deadline)
    const deadlineMs = deadlineIso === null ? Number.NaN : Date.parse(deadlineIso)
    const overdue = Number.isFinite(deadlineMs) && deadlineMs < nowMs
    return {
      item_id: row.item_id,
      id: row.item_id,
      run_id: row.run_id,
      status: row.status,
      deadline: deadlineIso,
      overdue,
      reason: `人工复核队列条目（status=${row.status}）${overdue ? '，已过截止时间' : ''}`,
      relation,
      required_action: 'RESOLVE_REVIEW_ITEM',
    }
  }
  const pendingReviewsOwned = reviewsOwnedResult.rows.map((row) => toReviewRow(row, 'REVIEWER'))
  const pendingReviewsUnassigned = reviewsUnassignedResult.rows.map((row) => toReviewRow(row, 'UNCLAIMED'))

  // ---- 连接器异常（恒 shared：同一数组同时给 lists 与 unassigned）----
  const connectorIncidents: ConnectorIncidentRow[] = incidentsResult.rows.map((row) => ({
    kind: row.kind,
    entity_id: row.entity_id,
    id: row.entity_id,
    status: row.status,
    reason: row.reason,
    occurred_at: isoOrNull(row.occurred_at),
    scope: 'SHARED',
    required_action: 'INVESTIGATE_CONNECTOR',
  }))

  // ---- 等待人工的任务 ----
  const toTaskRow = (row: TaskDbRow, relation: Relation): WaitingHumanTaskRow => ({
    task_id: row.task_id,
    task_type: row.task_type,
    title: row.title,
    status: row.status,
    due_at: isoOrNull(row.due_at),
    relation,
    required_action: 'PROVIDE_DECISION',
  })
  const waitingHumanOwned = tasksOwnedResult.rows.map((row) => toTaskRow(row, row.relation ?? 'OWNER'))
  const waitingHumanUnassigned = tasksUnassignedResult.rows.map((row) => toTaskRow(row, 'UNCLAIMED'))

  const unassignedTotal =
    pendingUnassigned.length + pendingReviewsUnassigned.length
    + waitingHumanUnassigned.length + connectorIncidents.length

  return {
    contract_version: OVERVIEW_CONTRACT_VERSION,
    configured: true,
    evaluated_at: nowIso,
    actor: {
      actor_id: actor.actor_id,
      display_name: actor.display_name,
      roles: rolesResult.rows.map((row) => row.code),
    },
    labels: LABELS,
    pending: pendingOwned,
    counts: {
      pending_total: pendingOwned.length,
      pending_by_stage: pendingByStage,
      active_total: activeTotal,
      active_by_stage: activeByStage,
      my_interviews_total: myInterviews.length,
      overdue_scorecards_total: overdueScorecards.length,
      pending_reviews_total: pendingReviewsOwned.length,
      connector_incidents_total: connectorIncidents.length,
      waiting_human_total: waitingHumanOwned.length,
      unassigned_total: unassignedTotal,
    },
    lists: {
      pending_decisions: pendingOwned,
      my_interviews: myInterviews,
      overdue_scorecards: overdueScorecards,
      pending_reviews: pendingReviewsOwned,
      connector_incidents: connectorIncidents,
      waiting_human_tasks: waitingHumanOwned,
    },
    unassigned: {
      note: UNASSIGNED_NOTE,
      pending_decisions: pendingUnassigned,
      pending_reviews: pendingReviewsUnassigned,
      waiting_human_tasks: waitingHumanUnassigned,
      connector_incidents: connectorIncidents,
    },
  }
}

/**
 * 读取工作台投影（自建短连接池 + `withReadOnly`；每次调用在 `finally` 里关池）。
 *
 * 保留它作为既有公开入口（`src/index.ts` 的路由 handler 用它）；
 * 真正的查询在 `readWorkbenchProjection` 里，测试可以拿事务内 client 直接调。
 * @param database - 已校验通过的数据库配置。
 * @returns 投影响应；空库返回空列表 + 0 计数（不是错误）。
 */
export async function readOverview(database: ResolvedDatabaseConfig): Promise<OverviewResponse> {
  const pool = createPool(database)
  try {
    return await withReadOnly(pool, async (client) => readWorkbenchProjection(client, database))
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  B1. GET 表单 spec（纯函数 buildFormSpec + 读路径 readFormSpec）
// =====================================================================

interface FormInterviewDbRow {
  id: string
  application_id: string
  round_no: number
  slot_code: string
  status: string
  scheduled_start_at: Date | string | null
  job_id: string
  pinned_rubric_version_id: string | null
}

interface FormRubricDbRow {
  id: string
  job_id: string
  payload_hash: string
  dimensions: readonly unknown[]
}

interface FormCurrentDbRow {
  id: string
  status: string
  revision_no: number
  record_version: number
  rubric_version_id: string
}

/** `buildFormSpec` 的输入：全部来自已读行（纯函数，不碰 DB）。 */
export interface BuildFormSpecInput {
  readonly actor: { readonly actor_id: string; readonly display_name: string }
  readonly interview: FormInterviewDbRow
  readonly rubric: FormRubricDbRow
  readonly current: FormCurrentDbRow | undefined
  readonly transcriptReady: boolean
}

/** rubric 的维度 key 列表（只认对象且有非空 `key`）。 */
function rubricDimensionKeys(rubric: { dimensions: readonly unknown[] }): string[] {
  const keys: string[] = []
  for (const raw of rubric.dimensions) {
    if (isPlainObject(raw) && typeof raw.key === 'string' && raw.key !== '') keys.push(raw.key)
  }
  return keys
}

/** 规范 rubric 维度：只保留 key/label/kind/weight/question 五个字段（顺序不变）。 */
function rubricDimensionSpecs(rubric: { dimensions: readonly unknown[] }): RubricDimensionSpec[] {
  const out: RubricDimensionSpec[] = []
  for (const raw of rubric.dimensions) {
    if (!isPlainObject(raw) || typeof raw.key !== 'string' || raw.key === '') continue
    out.push({
      key: raw.key,
      label: typeof raw.label === 'string' && raw.label !== '' ? raw.label : raw.key,
      kind: typeof raw.kind === 'string' ? raw.kind : '',
      weight: typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 0,
      ...(typeof raw.question === 'string' && raw.question !== '' ? { question: raw.question } : {}),
    })
  }
  return out
}

/**
 * 由已读行构造 GET 表单 spec（**纯函数**，不碰 DB —— 单测可直接喂假行）。
 *
 * 三条硬规矩：
 *   1. `dimensions` 顺序 = rubric dimensions 顺序，键**只**来自 rubric（客户端只拿到这些键）；
 *   2. `transcript_basis` 由 canonical transcript 是否 READY 决定，且 `locked: true`；
 *   3. `mode` 由 current 面评决定：无 / PENDING → `CREATE`；SUBMITTED → `REVISE`；
 *      WAIVED → `ALREADY_SUBMITTED`（豁免是人的决定，表单不再重复提交）。
 * @param input - 已读行（面试 / rubric / current / 转写状态 / actor）。
 * @returns 表单 spec。
 */
export function buildFormSpec(input: BuildFormSpecInput): ScorecardFormSpec {
  const rubricDimensions = rubricDimensionSpecs(input.rubric)
  const dimensions: FormDimensionControl[] = rubricDimensions.map((dimension) => ({
    ...dimension,
    controls: {
      assessment: [...ASSESSMENTS],
      score: { min: 1, max: 5 },
      // 表单层不强制 note；`NOT_MET` 必填 note 由写路径的语义校验负责（SC-30），
      // 这里写死 `false` 表示「不是无条件必填」。
      note_required: false,
    },
  }))

  const current = input.current
  let mode: ScorecardFormSpec['mode']
  if (current === undefined || current.status === 'PENDING') mode = 'CREATE'
  else if (current.status === 'SUBMITTED') mode = 'REVISE'
  else mode = 'ALREADY_SUBMITTED'

  return {
    contract_version: FORM_CONTRACT_VERSION,
    tool: 'recruitment_scorecard_form',
    actor: { actor_id: input.actor.actor_id, display_name: input.actor.display_name },
    interview: {
      id: input.interview.id,
      application_id: input.interview.application_id,
      round_no: input.interview.round_no,
      slot_code: input.interview.slot_code,
      status: input.interview.status,
      scheduled_start_at: isoOf(input.interview.scheduled_start_at) ?? '',
    },
    rubric: {
      id: input.rubric.id,
      job_id: input.rubric.job_id,
      payload_hash: input.rubric.payload_hash,
      dimensions: rubricDimensions,
    },
    dimensions,
    transcript_basis: {
      value: input.transcriptReady ? 'TRANSCRIPT' : 'NO_TRANSCRIPT',
      options: [...TRANSCRIPT_BASES],
      locked: true,
    },
    overall_options: [...OVERALLS],
    mode,
    current: current === undefined
      ? null
      : {
          id: current.id,
          status: current.status,
          revision_no: current.revision_no,
          record_version: current.record_version,
          rubric_version_id: current.rubric_version_id,
        },
    labels: LABELS,
  }
}

/**
 * 读取一场面试的表单 spec（只读事务内调用）。
 *
 * rubric 解析与 `scorecard-submit.ts::resolveRubric` **同语义**：
 * 申请钉住优先（APPLICATION_PINNED）；未钉住必须显式给（否则 RUBRIC_UNRESOLVED）；
 * 给了就必须等于钉住的（RUBRIC_MISMATCH）；且必须属于该申请的岗位（RUBRIC_NOT_OF_JOB）。
 * @param client - 只读事务内连接。
 * @param cfg - 已解析配置（tenant 只从这里来）。
 * @param interviewId - 面试 id。
 * @param rubricVersionId - 可选显式 rubric 版本 id。
 * @returns 表单 spec。
 * @throws RecruitmentToolError - NOT_FOUND / INTERVIEWER_MISMATCH / INVALID_ARGS(rubric)。
 */
async function readFormSpec(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  interviewId: string,
  rubricVersionId: string | undefined,
): Promise<ScorecardFormSpec> {
  const tenantId = cfg.tenant_id

  const interviewRows = await client.query<FormInterviewDbRow>(FORM_INTERVIEW_SQL, [interviewId, tenantId])
  const interview = interviewRows.rows[0]
  if (interview === undefined) {
    throw evalError('NOT_FOUND', 'INTERVIEW_NOT_FOUND', '该租户下没有这场面试', { interview_id: interviewId })
  }

  // 归属：actor 必须是这场面试已登记的 interviewer（否则 403 INTERVIEWER_MISMATCH）。
  const interviewerRows = await client.query<{ id: string }>(FORM_INTERVIEWER_SQL, [interviewId, cfg.actor_id, tenantId])
  const interviewer = interviewerRows.rows[0]
  if (interviewer === undefined) {
    throw evalError(
      'INTERVIEWER_MISMATCH',
      'ACTOR_NOT_INTERVIEWER',
      '当前 actor 不是这场面试已登记的面试官（表单只给本人填）',
      { interview_id: interviewId, actor_id: cfg.actor_id },
    )
  }

  // rubric 三绑定（与 scorecard-submit 同语义）。
  const pinned = interview.pinned_rubric_version_id
  let rubricId: string
  if (pinned !== null) {
    if (rubricVersionId !== undefined && rubricVersionId !== pinned) {
      throw evalError(
        'INVALID_ARGS',
        'RUBRIC_MISMATCH',
        '入参的 rubric_version_id 与申请钉住的版本不一致；没有 what-if 面评（SC-11）',
        { pinned_rubric_version_id: pinned, rubric_version_id: rubricVersionId },
      )
    }
    rubricId = pinned
  } else {
    if (rubricVersionId === undefined) {
      throw evalError(
        'INVALID_ARGS',
        'RUBRIC_UNRESOLVED',
        '该申请没有钉住 rubric 版本，必须显式给 rubric_version_id（不做 fallback，SC-10）',
        { application_id: interview.application_id },
      )
    }
    rubricId = rubricVersionId
  }
  const rubricRows = await client.query<FormRubricDbRow>(FORM_RUBRIC_SQL, [rubricId, tenantId])
  const rubric = rubricRows.rows[0]
  if (rubric === undefined) {
    throw evalError('NOT_FOUND', 'RUBRIC_VERSION_NOT_FOUND', '该租户下没有这个 rubric 版本', {
      rubric_version_id: rubricId,
    })
  }
  if (rubric.job_id !== interview.job_id) {
    throw evalError(
      'INVALID_ARGS',
      'RUBRIC_NOT_OF_JOB',
      '这个 rubric 版本不属于该申请的岗位（拿别的岗位的标准打分不被接受，SC-47）',
      { rubric_version_id: rubric.id, rubric_job_id: rubric.job_id, application_job_id: interview.job_id },
    )
  }

  const currentRows = await client.query<FormCurrentDbRow>(FORM_CURRENT_SQL, [interviewId, interviewer.id, tenantId])
  const transcriptRows = await client.query<{ transcript_status: string }>(FORM_TRANSCRIPT_READY_SQL, [interviewId, tenantId])
  const transcriptReady = transcriptRows.rows.some((row) => row.transcript_status === 'READY')

  const actorRows = await client.query<{ display_name: string }>(ACTOR_SQL, [cfg.actor_id, tenantId])
  const displayName = actorRows.rows[0]?.display_name ?? ''

  return buildFormSpec({
    actor: { actor_id: cfg.actor_id, display_name: displayName },
    interview,
    rubric,
    current: currentRows.rows[0],
    transcriptReady,
  })
}

// =====================================================================
//  B2. POST 提交：纯函数（形状 + 维度键覆盖）→ 产品写路径
// =====================================================================

/** 把一条违反项包成 `INVALID_ARGS(_: compact-json)` 错误（消息形态与工具契约一致）。 */
function formArgsError(reasonCode: string, message: string, detail?: unknown): Error {
  return evalError('INVALID_ARGS', reasonCode, message, detail)
}

/**
 * 校验维度键覆盖（**纯函数**）：
 *   · 多出 rubric 里没有的键 → `INVALID_ARGS(DIMENSION_NOT_IN_RUBRIC)`（detail.unexpected）
 *   · 缺少 rubric 的键 → `INVALID_ARGS(DIMENSION_COVERAGE_INCOMPLETE)`（detail.missing）
 * 这是「模型/客户端不能自由拼动态键」的 fail-closed 证明点：键集必须**恰好相等**。
 * @param submittedKeys - 客户端提交的维度键（不含保留键 transcript_basis）。
 * @param rubricKeys - 服务端从 rubric 读出的权威维度键。
 * @returns `{ok:true}`；不覆盖时抛错。
 */
export function validateDimensionKeys(
  submittedKeys: readonly string[],
  rubricKeys: readonly string[],
): { readonly ok: true } {
  const rubricSet = new Set(rubricKeys)
  const submittedSet = new Set(submittedKeys)
  const unexpected = [...submittedSet].filter((key) => !rubricSet.has(key)).sort()
  if (unexpected.length > 0) {
    throw formArgsError(
      'DIMENSION_NOT_IN_RUBRIC',
      '提交里有 rubric 里没有的维度键（键必须由服务端从 rubric 生成）',
      { unexpected, dimension_keys: [...rubricKeys] },
    )
  }
  const missing = rubricKeys.filter((key) => !submittedSet.has(key))
  if (missing.length > 0) {
    throw formArgsError(
      'DIMENSION_COVERAGE_INCOMPLETE',
      '有 rubric 维度没有评（覆盖率必须 100%）',
      { missing, dimension_keys: [...rubricKeys], dimensions_assessed: rubricKeys.length - missing.length },
    )
  }
  return { ok: true }
}

/**
 * 校验 POST body 的形状（**纯函数**，不碰 DB、不写库）。
 *
 * 允许的顶层键只有 `FORM_BODY_KEYS`；`dimensions` 里每个维度对象只允许
 * `assessment`/`score`/`note`，assessment ∈ 封闭集，score 1..5 整数（仅 MET/NOT_MET 允许），
 * note ≤2000 字。保留键 `transcript_basis` 出现在 `dimensions` 里 → `UNKNOWN_PARAM`。
 * 一次收集全部违反项（TC §1.1 第 7 条），抛第一条。
 * @param raw - 解析后的 JSON body。
 * @returns 规范化后的提交体（只含已声明键）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（reason_code 见各分支）。
 */
export function parseScorecardFormSubmission(raw: unknown): ScorecardFormSubmission {
  if (!isPlainObject(raw)) {
    throw formArgsError('TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body', expected: 'object' })
  }

  // 1) 未知顶层键（字典序，逐条进 detail.unknown）。
  const unknown = Object.keys(raw).filter((key) => !(FORM_BODY_KEYS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw formArgsError(
      'UNKNOWN_PARAM',
      `未声明的键 "${unknown[0]}"（允许：${FORM_BODY_KEYS.join(', ')}）`,
      { unknown, allowed: [...FORM_BODY_KEYS] },
    )
  }

  // 2) 必填。
  const missing: string[] = []
  for (const key of ['interview_id', 'dimensions', 'transcript_basis', 'overall'] as const) {
    if (!Object.hasOwn(raw, key)) missing.push(key)
  }
  if (missing.length > 0) {
    throw formArgsError('MISSING_REQUIRED', `缺必填参数 "${missing[0]}"`, { missing })
  }

  // 3) interview_id / rubric_version_id 的形状。
  const interviewId = raw.interview_id
  if (typeof interviewId !== 'string' || interviewId === '') {
    throw formArgsError('TYPE_MISMATCH', '"interview_id" 必须是非空字符串', { path: 'interview_id', expected: 'uuid' })
  }
  if (!isUuid(interviewId)) {
    throw formArgsError('ID_NOT_UUID', '"interview_id" 必须是 UUID 文本', { field: 'interview_id', got: interviewId })
  }
  let rubricVersionId: string | undefined
  if (Object.hasOwn(raw, 'rubric_version_id')) {
    const value = raw.rubric_version_id
    if (typeof value !== 'string' || value === '') {
      throw formArgsError('TYPE_MISMATCH', '"rubric_version_id" 必须是非空字符串', { path: 'rubric_version_id' })
    }
    if (!isUuid(value)) {
      throw formArgsError('ID_NOT_UUID', '"rubric_version_id" 必须是 UUID 文本', { field: 'rubric_version_id', got: value })
    }
    rubricVersionId = value
  }

  // 4) transcript_basis / overall 的封闭集。
  const basis = raw.transcript_basis
  if (typeof basis !== 'string') {
    throw formArgsError('TYPE_MISMATCH', '"transcript_basis" 必须是字符串', { path: 'transcript_basis' })
  }
  if (!(TRANSCRIPT_BASES as readonly string[]).includes(basis)) {
    throw formArgsError('ENUM_INVALID', `"transcript_basis" 只能是 ${TRANSCRIPT_BASES.join(' | ')}`, {
      path: 'transcript_basis', allowed: [...TRANSCRIPT_BASES], got: basis,
    })
  }
  const overall = raw.overall
  if (typeof overall !== 'string') {
    throw formArgsError('TYPE_MISMATCH', '"overall" 必须是字符串', { path: 'overall' })
  }
  if (!(OVERALLS as readonly string[]).includes(overall)) {
    throw formArgsError('ENUM_INVALID', `"overall" 只能是 ${OVERALLS.join(' | ')}`, {
      path: 'overall', allowed: [...OVERALLS], got: overall,
    })
  }

  // 5) dimensions：对象、保留键、单维度形状。
  const rawDimensions = raw.dimensions
  if (!isPlainObject(rawDimensions)) {
    throw formArgsError('TYPE_MISMATCH', '"dimensions" 必须是对象（键 = rubric 维度 key）', { path: 'dimensions' })
  }
  if (Object.hasOwn(rawDimensions, TRANSCRIPT_BASIS_KEY)) {
    throw formArgsError(
      'UNKNOWN_PARAM',
      `"dimensions" 里不得出现保留键 "${TRANSCRIPT_BASIS_KEY}"（转写基准是顶层字段）`,
      { path: 'dimensions', unknown: [TRANSCRIPT_BASIS_KEY] },
    )
  }
  const dimensions: Record<string, { assessment: string; score?: number; note?: string }> = {}
  for (const [key, value] of Object.entries(rawDimensions)) {
    const path = `dimensions.${key}`
    if (!isPlainObject(value)) {
      throw formArgsError('TYPE_MISMATCH', `${path} 必须是对象（assessment/score/note）`, { path })
    }
    const extraKeys = Object.keys(value).filter((field) => !(DIMENSION_FIELDS as readonly string[]).includes(field))
    if (extraKeys.length > 0) {
      throw formArgsError('UNKNOWN_PARAM', `${path} 只允许 assessment/score/note 三个键`, {
        path, unknown: extraKeys, allowed: [...DIMENSION_FIELDS],
      })
    }
    const assessment = value.assessment
    if (!Object.hasOwn(value, 'assessment')) {
      throw formArgsError('MISSING_REQUIRED', `${path}.assessment 必填`, { path: `${path}.assessment` })
    }
    if (typeof assessment !== 'string') {
      throw formArgsError('TYPE_MISMATCH', `${path}.assessment 必须是字符串`, { path: `${path}.assessment` })
    }
    if (!(ASSESSMENTS as readonly string[]).includes(assessment)) {
      throw formArgsError('ENUM_INVALID', `${path}.assessment 只能是 ${ASSESSMENTS.join(' | ')}`, {
        path: `${path}.assessment`, allowed: [...ASSESSMENTS], got: assessment,
      })
    }
    let score: number | undefined
    if (Object.hasOwn(value, 'score') && value.score !== null && value.score !== undefined) {
      const rawScore = value.score
      if (typeof rawScore !== 'number' || !Number.isInteger(rawScore)) {
        throw formArgsError('TYPE_MISMATCH', `${path}.score 必须是整数（1..5）`, { path: `${path}.score` })
      }
      if (rawScore < 1 || rawScore > 5) {
        throw formArgsError('OUT_OF_RANGE', `${path}.score 必须在 1..5`, { path: `${path}.score`, got: rawScore })
      }
      if (assessment !== 'MET' && assessment !== 'NOT_MET') {
        throw formArgsError(
          'ASSESSMENT_SCORE_CONFLICT',
          `assessment=${assessment} 时不得打分（"判不了"不能当"不满足"）`,
          { path, assessment, score: rawScore },
        )
      }
      score = rawScore
    }
    let note: string | undefined
    if (Object.hasOwn(value, 'note') && value.note !== null && value.note !== undefined) {
      const rawNote = value.note
      if (typeof rawNote !== 'string') {
        throw formArgsError('TYPE_MISMATCH', `${path}.note 必须是字符串`, { path: `${path}.note` })
      }
      if (rawNote.length > MAX_NOTE_LENGTH) {
        throw formArgsError('OUT_OF_RANGE', `${path}.note 不得超过 ${MAX_NOTE_LENGTH} 字`, {
          path: `${path}.note`, length: rawNote.length,
        })
      }
      note = rawNote
    }
    dimensions[key] = {
      assessment,
      ...(score === undefined ? {} : { score }),
      ...(note === undefined ? {} : { note }),
    }
  }

  // 6) reject_reasons / revision 原样透传（语义校验在 scorecard-submit 里）。
  let rejectReasons: readonly unknown[] | undefined
  if (Object.hasOwn(raw, 'reject_reasons')) {
    if (!Array.isArray(raw.reject_reasons)) {
      throw formArgsError('TYPE_MISMATCH', '"reject_reasons" 必须是数组', { path: 'reject_reasons' })
    }
    rejectReasons = raw.reject_reasons
  }
  let revision: Readonly<Record<string, unknown>> | undefined
  if (Object.hasOwn(raw, 'revision')) {
    if (!isPlainObject(raw.revision)) {
      throw formArgsError(
        'TYPE_MISMATCH',
        '"revision" 必须是对象（supersedes_scorecard_id / expected_record_version / revision_reason）',
        { path: 'revision' },
      )
    }
    revision = raw.revision
  }

  // 7) idempotency_key（给了就校验；没给由服务端派生）。
  let idempotencyKey: string
  if (Object.hasOwn(raw, 'idempotency_key')) {
    const value = raw.idempotency_key
    if (typeof value !== 'string' || value === '') {
      throw formArgsError('TYPE_MISMATCH', '"idempotency_key" 必须是非空字符串', { path: 'idempotency_key' })
    }
    if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH || !IDEMPOTENCY_KEY_RE.test(value)) {
      throw formArgsError(
        'OUT_OF_RANGE',
        `"idempotency_key" 必须匹配 ^[A-Za-z0-9:_-]{1,${MAX_IDEMPOTENCY_KEY_LENGTH}}$`,
        { path: 'idempotency_key' },
      )
    }
    idempotencyKey = value
  } else {
    idempotencyKey = ''
  }

  return {
    interview_id: interviewId,
    ...(rubricVersionId === undefined ? {} : { rubric_version_id: rubricVersionId }),
    dimensions,
    transcript_basis: basis as (typeof TRANSCRIPT_BASES)[number],
    overall: overall as (typeof OVERALLS)[number],
    ...(rejectReasons === undefined ? {} : { reject_reasons: rejectReasons }),
    ...(revision === undefined ? {} : { revision }),
    idempotency_key: idempotencyKey,
  }
}

/**
 * 派生幂等键：`scform:` + sha256(canonicalJson({actor_id, interview_id, rubric_version_id,
 * dimensions(键排序), transcript_basis, overall, reject_reasons, revision}))。
 *
 * 双击/重放（同一人 + 同一场面试 + 同一份内容）→ 命中 `event_inbox` 的幂等记录，
 * `prepareScorecard` 直接返回 `replayed=true` 的原结果，**不新增行**。
 * @param actorId - 执行 actor（插件配置）。
 * @param submission - 已过形状校验的提交体。
 * @returns 满足 `^[A-Za-z0-9:_-]{1,128}$` 的幂等键（`scform:` + 64 hex）。
 */
export function deriveFormIdempotencyKey(actorId: string, submission: ScorecardFormSubmission): string {
  const sortedDimensions: Record<string, unknown> = {}
  for (const key of Object.keys(submission.dimensions).sort()) sortedDimensions[key] = submission.dimensions[key]
  const digest = digestOf({
    actor_id: actorId,
    interview_id: submission.interview_id,
    rubric_version_id: submission.rubric_version_id ?? null,
    dimensions: sortedDimensions,
    transcript_basis: submission.transcript_basis,
    overall: submission.overall,
    reject_reasons: submission.reject_reasons ?? [],
    revision: submission.revision ?? null,
  })
  return `scform:${digest}`
}

/** 把提交体组装成 `recruitment_scorecard_submit` 的原始入参（复用同一条产品写路径）。 */
function formSubmissionToSubmitArgs(
  submission: ScorecardFormSubmission,
  idempotencyKey: string,
): Record<string, unknown> {
  const items: Record<string, unknown> = { ...submission.dimensions }
  items[TRANSCRIPT_BASIS_KEY] = submission.transcript_basis
  return {
    interview_id: submission.interview_id,
    ...(submission.rubric_version_id === undefined ? {} : { rubric_version_id: submission.rubric_version_id }),
    items,
    overall: submission.overall,
    ...(submission.reject_reasons === undefined ? {} : { reject_reasons: submission.reject_reasons }),
    ...(submission.revision === undefined ? {} : { revision: submission.revision }),
    idempotency_key: idempotencyKey,
  }
}

/**
 * 预校验维度覆盖（读有效 rubric 的维度 → `validateDimensionKeys`）。
 *
 * 只在能确定「有效 rubric 且属于该申请岗位」时校验；其它情形返回 `false`，
 * 交给 `prepareScorecard` 抛它自己的契约错误（错误归因更准，不抢在它前面）。
 * @returns 是否完成了覆盖校验。
 */
async function prevalidateDimensionCoverage(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  submission: ScorecardFormSubmission,
): Promise<boolean> {
  const { rows } = await client.query<{ dimensions: readonly unknown[] }>(FORM_EFFECTIVE_RUBRIC_SQL, [
    submission.interview_id,
    cfg.tenant_id,
    submission.rubric_version_id ?? null,
  ])
  const rubric = rows[0]
  if (rubric === undefined) return false
  const rubricKeys = rubricDimensionKeys({ dimensions: Array.isArray(rubric.dimensions) ? rubric.dimensions : [] })
  if (rubricKeys.length === 0) return false
  validateDimensionKeys(Object.keys(submission.dimensions), rubricKeys)
  return true
}

// =====================================================================
//  HTTP 层
// =====================================================================

/** 写一个 JSON 响应（固定 no-store + nosniff）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/**
 * 同源校验：必须同时满足
 *   1. `Host` 是本机监听地址（`127.0.0.1:<port>` 或 `localhost:<port>`）；
 *   2. 带 `x-recruitment-request: 1`（浏览器里只有本产品页面会带）；
 *   3. `Origin` 缺省（同源 GET 通常不带）或等于 `http://<host>`。
 * @param req - node 请求对象（只读 headers）。
 * @param port - 本机 Web 监听端口。
 * @returns 是否放行。
 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  if (req.headers[REQUEST_HEADER] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${host}`
}

/** 回环地址判据（只接受 127.0.0.1 / ::1；其余地址不注册路由）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** 试图从客户端覆盖身份的参数/头（命中即 400，且**不碰 DB**）。 */
function findActorOverride(req: Pick<IncomingMessage, 'headers'>, url: URL): string[] {
  const found: string[] = []
  for (const key of ['actor_id', 'tenant_id'] as const) {
    if (url.searchParams.has(key)) found.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) found.push(`header.${key}`)
  }
  return found
}

/** 契约错误的 HTTP 映射（TC §5.3 的封闭集；未列出的码按 500 兜底，不猜 200）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  INTERVIEWER_MISMATCH: 403,
  FORBIDDEN: 403,
  ALREADY_SUBMITTED: 409,
  VERSION_CONFLICT: 409,
  EVIDENCE_INSUFFICIENT: 422,
  DB_CONSTRAINT_VIOLATION: 500,
  NOT_CONFIGURED: 503,
}

/**
 * 把任意错误翻成 HTTP 状态 + `{error:{code,reason_code,message,detail?}}`。
 * 优先解析产品错误消息形态 `CODE: <compact-json>`；解析不了就只给 code+message。
 */
function errorResponse(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
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

/** 一个可被 HTTP 层直接返回的问题（body 读不出来 / 类型不对 / 超限）。 */
class HttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'HttpProblem'
    this.status = status
    this.body = body
  }
}

/** 读请求体（上限 64 KiB；超限 413、读失败 400）。 */
async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > limit) {
    throw new HttpProblem(413, {
      error: { code: 'INVALID_ARGS', reason_code: 'BODY_TOO_LARGE', message: `请求体不得超过 ${limit} 字节` },
    })
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > limit) {
      throw new HttpProblem(413, {
        error: { code: 'INVALID_ARGS', reason_code: 'BODY_TOO_LARGE', message: `请求体不得超过 ${limit} 字节` },
      })
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Content-Type 必须是 JSON（允许带 charset）。 */
function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

/** 宿主侧用到的 `webServer` 最小面（只取注册、host、port）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * 宿主上下文的窄接口（`webServer` 由 cordis 服务注入；`logger` 可选）。
 * 导出它是因为 `src/index.ts` 需要把 cordis 的 `Context` 窄成这个形状再传进来——
 * 插件包不依赖 `@deepseek-ai/dsh-host-webserver` 的类型，收窄面就够用。
 */
export interface OverviewHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * 注册工作台 + D-89 表单路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警：这是 fail-closed——宁可面板读不到，
 * 也不把业务投影挂到一个网络可达的地址上。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param database - 已解析的数据库配置；`null` 表示未配置（路由仍存在，返回空投影 + issues / 503）。
 * @param issues - 未配置时缺失的配置项。
 * @returns 注销函数。
 */
export function registerOverviewHttp(
  ctx: OverviewHostContext,
  database: ResolvedDatabaseConfig | null,
  issues: readonly string[],
): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 工作台路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  // ---- GET /recruitment/api/overview ----
  const handleOverview = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET', ...NO_STORE })
      res.end()
      return
    }
    if (database === null) {
      json(res, 200, unconfiguredOverview(issues))
      return
    }
    try {
      json(res, 200, await readOverview(database))
    } catch (error) {
      // 读库失败必须可解释：面板显示错误，而不是显示「没有待办」（那是把故障说成空）。
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }

  // ---- GET /recruitment/api/scorecard-form ----
  const handleFormGet = async (req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> => {
    const allowed = ['interview_id', 'rubric_version_id'] as const
    const unknown = [...url.searchParams.keys()].filter((key) => !(allowed as readonly string[]).includes(key))
    if (unknown.length > 0) {
      json(res, 400, {
        error: {
          code: 'INVALID_ARGS',
          reason_code: 'UNKNOWN_PARAM',
          message: `未声明的查询参数 "${unknown[0]}"（允许：${allowed.join(', ')}）`,
          detail: { unknown, allowed: [...allowed] },
        },
      })
      return
    }
    const interviewId = url.searchParams.get('interview_id')
    if (interviewId === null || interviewId === '') {
      json(res, 400, {
        error: { code: 'INVALID_ARGS', reason_code: 'MISSING_REQUIRED', message: '缺必填查询参数 interview_id', detail: { missing: ['interview_id'] } },
      })
      return
    }
    if (!isUuid(interviewId)) {
      json(res, 400, {
        error: { code: 'INVALID_ARGS', reason_code: 'ID_NOT_UUID', message: 'interview_id 必须是 UUID 文本', detail: { field: 'interview_id' } },
      })
      return
    }
    const rubricVersionIdRaw = url.searchParams.get('rubric_version_id')
    if (rubricVersionIdRaw !== null && !isUuid(rubricVersionIdRaw)) {
      json(res, 400, {
        error: { code: 'INVALID_ARGS', reason_code: 'ID_NOT_UUID', message: 'rubric_version_id 必须是 UUID 文本', detail: { field: 'rubric_version_id' } },
      })
      return
    }
    if (database === null) {
      json(res, 503, {
        error: { code: 'NOT_CONFIGURED', reason_code: 'NOT_CONFIGURED', message: '数据库未配置，读不到面评表单' },
      })
      return
    }
    const pool = createPool(database)
    try {
      const spec = await withReadOnly(pool, async (client) =>
        readFormSpec(client, database, interviewId, rubricVersionIdRaw ?? undefined))
      json(res, 200, spec)
    } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    } finally {
      await closePool(pool)
    }
  }

  // ---- POST /recruitment/api/scorecard-form ----
  const handleFormPost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isJsonContentType(req.headers['content-type'])) {
      json(res, 415, {
        error: {
          code: 'INVALID_ARGS',
          reason_code: 'UNSUPPORTED_MEDIA_TYPE',
          message: '提交面评表单必须是 Content-Type: application/json',
          detail: { got: req.headers['content-type'] ?? '' },
        },
      })
      return
    }
    let text: string
    try {
      text = await readBody(req, MAX_BODY_BYTES)
    } catch (error) {
      if (error instanceof HttpProblem) {
        json(res, error.status, error.body)
        return
      }
      throw error
    }
    let raw: unknown
    try {
      raw = JSON.parse(text) as unknown
    } catch {
      json(res, 400, {
        error: { code: 'INVALID_ARGS', reason_code: 'INVALID_JSON', message: '请求体不是合法 JSON（零写入）' },
      })
      return
    }
    if (database === null) {
      json(res, 503, {
        error: { code: 'NOT_CONFIGURED', reason_code: 'NOT_CONFIGURED', message: '数据库未配置，面评写库被拒绝' },
      })
      return
    }

    try {
      const submission = parseScorecardFormSubmission(raw)
      const idempotencyKey = submission.idempotency_key !== ''
        ? submission.idempotency_key
        : deriveFormIdempotencyKey(database.actor_id, { ...submission, idempotency_key: '' })
      const rawArgs = formSubmissionToSubmitArgs(submission, idempotencyKey)

      const pool = createPool(database)
      try {
        // ---- 阶段 1：只读事务里（a）按 DB 权威维度集合校验动态键覆盖，（b）产品写路径 prepare ----
        // 只读是数据库强制的（`begin transaction read only`）：这一段任何写都会 25006。
        const prepared = await withReadOnly(pool, async (client) => {
          await client.query("select set_config('recruitment.actor_id', $1, true)", [database.actor_id])
          await prevalidateDimensionCoverage(client, database, submission)
          return await prepareScorecard(client, database, rawArgs)
        })
        // ---- 幂等重放不写库、不问人：直接返回原结果（replayed=true）----
        if (prepared.kind === 'result') {
          json(res, 200, prepared.value)
          return
        }
        // ---- 阶段 2：写事务里**重跑 prepare 复校验**（TOCTOU 收窄），再写库 ----
        // 人类表单路径**不调用 DSH approval**：见文件头 §C 的裁决依据（D-79 约束 Agent 工具路径）。
        const output = await withActor(pool, database.actor_id, async (client) => {
          const fresh = await prepareScorecard(client, database, rawArgs)
          if (fresh.kind === 'result') return fresh.value
          return await writeScorecard(client, database, fresh)
        })
        json(res, 200, output)
      } finally {
        await closePool(pool)
      }
    } catch (error) {
      // 任何错误要么发生在写事务之前、要么让写事务回滚：零写入。
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!sameOrigin(req, port)) {
      json(res, 403, { error: 'same-origin loopback request required' })
      return
    }
    // 身份只能来自插件配置：任何客户端覆盖企图都在**碰 DB 之前**拒掉。
    const overrides = findActorOverride(req, url)
    if (overrides.length > 0) {
      json(res, 400, {
        error: {
          code: 'INVALID_ARGS',
          reason_code: 'ACTOR_OVERRIDE_REJECTED',
          message: 'actor/tenant 只来自插件配置，不接受客户端传入（D-33 / IR-M4d）',
          detail: { rejected: overrides },
        },
      })
      return
    }

    if (url.pathname === OVERVIEW_PATH) {
      await handleOverview(req, res)
      return
    }
    if (url.pathname === FORM_PATH) {
      if (req.method === 'GET') {
        await handleFormGet(req, url, res)
        return
      }
      if (req.method === 'POST') {
        await handleFormPost(req, res)
        return
      }
      res.writeHead(405, { allow: 'GET, POST', ...NO_STORE })
      res.end()
      return
    }
    json(res, 404, { error: 'not found' })
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
