// recruitment_job_rubric_approve —— S3 rubric 批准的**产品入口**（docs/23 N7 的修复）。
//
// 为什么需要它（N7 的真实后果）：`recruitment_job_create` / `recruitment_job_update`
// 只写 `approval(status='PENDING')`；在此之前"批准"只有 CLI（`manual/job-line/approve-rubric.mjs`），
// 而 CLI 不维护 `job.current_rubric_version_id`。于是：
//   批准已发生 → `job.current_rubric_version_id` 仍为空 → S7/S10 的 rubric pin 读不到
//   已批准版本 → F1（rubric pin 缺失）。本工具补的就是"人批准"这一步的产品入口。
//
// 五条不可协商的规则（每条都有库约束或台账依据）：
//
//   1. **批准是人的动作，Agent 不许自己批**（`APP-07`、`docs/20 §2`、D-79）。
//      写库前必须过 `ctx.approval`（DSH 自带 approval seam，fail-closed），只有宿主
//      收到人的 `allowed-once` 才继续；`unavailable` / `rejected` / `cancelled` / 120s
//      超时 → `FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED)`，**一行不写**。
//      决定者必须是本租户 `kind='HUMAN'` 的 actor（D-79：v1.0 单用户，取配置里的本地 actor）。
//
//   2. **批准状态只由 `approval` 行表达，不改历史行**（J-1 / J-5）：
//      `rubric_version` 整行不可变（`trg_rubric_version_immutable`），
//      `rubric_version.approved_by_approval_id` 永远保持 null；"已批准"=
//      `approval(status='APPROVED' ∧ hash 相同 ∧ 未过期 ∧ 未 supersede)`。
//      状态迁移本身复用 `decideRubricApprovalInTransaction()`（CLI 用的同一个函数），
//      `PENDING→APPROVED` 过 `fn_row_guard` 自动写 `approval.status.changed` 事件。
//
//   3. **批准后把 current 指针指向该版本**（D-21 / D-48）：
//      当前版本**不是** `max(version_no)`，而是显式指针 `job.current_rubric_version_id`；
//      本工具批准成功（或发现批准已成立但指针仍陈旧）时把指针指过去。
//      写入的是普通 UPDATE：`fk_job_current_rubric`（0004）会用
//      `(tenant_id, id, current_rubric_version_id) → rubric_version(tenant_id, job_id, id)`
//      保证"必须是本岗位本租户的版本"（0005 §2 的 `uq_rubric_version_tenant_id_job`
//      就是被引用键），**不绕触发器、不直接改表结构**。指针未变时**不发 UPDATE**，
//      否则 `fn_row_guard` 会白白 +1 `record_version`（幂等重试看起来像改动）。
//
//   4. **幂等：重复批准同一版本零额外写入**（D-95 同一精神：重复动作不得再落事实）：
//      - 批准已生效且指针已指向该版本 → `outcome='NO_OP'`、`replayed=true`、**不问人、不写任何行**；
//      - 批准已生效但指针陈旧（CLI 遗留）→ `outcome='CURRENT_UPDATED'`、`replayed=true`
//        （补指针；因为会改业务可见状态，仍要过闸门）；
//      - 本次真的把 PENDING 批成 APPROVED → `outcome='APPROVED'`、`replayed=false`。
//
//   5. **审计两条事件**：批准迁移由 `fn_row_guard` 写 `approval.status.changed`
//      （`approval.status_source_event_id` 可回查）；本工具另写一条内部事件
//      `job.rubric_version.approved`，payload 记 `{job_id, rubric_version_id, version_no,
//      payload_hash, approval_id, approved_by_actor_id, approved_at, previous/current
//      current_rubric_version_id, pointer_changed, outcome}`。幂等键每次唯一（内部事实），
//      去重靠上面的 NO_OP 分支而不是事件键。
//
// 输出 schema 只用 DSH 子集（`test/unit/output-schema.test.ts` 口径）：**无 type 数组、
// 无 `type:'null'`、值里无 null** —— 可缺的键（`job.previous_current_rubric_version_id`）
// 直接省略。
//
// 事务边界（D-101，2026-11-15 G11 修复）：产品入口 `execute()` 分两阶段——
//   ① 只读事务里做全部业务校验并取"写计划"（`prepareRubricApproval`，结束即提交、连接退回池）；
//   ② **事务之外**等 `ctx.approval.request`（等人期间连接是 idle，不是 idle in transaction，
//      120s 超时也无需回滚任何东西）；③ 写事务里 `for update` 复校验后仅做写入
//      （`writeRubricApproval`）。复校验若发现并发已批准且指针已对齐 → 返回 NO_OP、不写库。
// `approveRubricInTransaction` 保留"业务校验 → 问人 → 写库都在调用方事务里"的旧语义，
// 只作为事务内测试接缝（`src/index.ts` 只注册 `create*Tool`，不调它）。顺序不变：注定失败的
// 调用（岗位/版本不存在、审批已拒、哈希不匹配）**不弹窗**、不打扰人。

import { randomUUID } from 'node:crypto'

import {
  collectArgViolations,
  toParameterSchema,
  type ParamMap,
} from './args.ts'
import { contractError } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import {
  decideRubricApprovalInTransaction,
  mapDatabaseError,
} from './job-create.ts'
import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
// 事件名只从注册表取（`src/runtime/event-types.ts`）；机检测试会扫发射点。
import { EVENT_TYPES } from '../runtime/event-types.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'

/** 工具名（模型可见，冻结；与 `recruitment_job_create` / `_update` 同一命名风格）。 */
export const JOB_RUBRIC_APPROVE_TOOL = 'recruitment_job_rubric_approve'
/** 输出契约版本（与岗位线其它工具同一基线）。 */
export const CONTRACT_VERSION = '1.0.0'

/**
 * 人工批准等待上限：**120 秒**（D-101 第 1 条）。
 *
 * 超时按 `cancelled` 判 → 回滚 → `FORBIDDEN(APPROVAL_NOT_GRANTED, approval='timeout')`，
 * 一行不写；超时后才到的 Allow **不采纳**（防竞态写库）。这只是工具内的上界兜底；
 * DB 侧 `idle_in_transaction_session_timeout` 由 `db/pool.ts` 另配。
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/** DSH `ctx.approval.request` 的封闭结果（与 `decision-record.ts` / 排期工具同一封闭集）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 本工具 `approve()` 的最终结果：宿主四个封闭值 + 等待超时哨兵（超时按 `cancelled` 判）。 */
export type ApprovalDecision = ApprovalOutcome | 'timeout'

/**
 * DSH `ctx.approval` 的窄接口（只取 `request`）。
 * **缺省 = 一律拒绝**（D-79 fail closed）：不存在"没接 approval 就直接写库"的分支。
 */
export interface ApprovalRequester {
  request(req: {
    agent?: unknown
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<string>
}

/** 本工具的依赖：库配置是第一个位置参数，approval / identity 是可选的第二组依赖。 */
export interface JobRubricApproveDeps extends ToolActorDeps {
  /** DSH `ctx.approval` 的窄接口。缺省 = 一律拒绝（headless 恒 fail closed）。 */
  readonly approval?: ApprovalRequester
}

// ---------------------------------------------------------------------------
//  入参（封闭对象根；tenant_id / actor_id 不接受）
// ---------------------------------------------------------------------------

const APPROVE_SCALAR_PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Job id (UUID) of the rubric owner. Must belong to the configured tenant. '
      + 'Take it from recruitment_job_create / recruitment_job_update / recruitment_job_get.',
  },
  rubric_version_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Rubric version id (UUID) to approve. Must belong to job_id (fk_job_current_rubric). '
      + 'Take rubric.version_id from recruitment_job_create / _update / _get.',
  },
  reason: {
    kind: 'string',
    maxLength: 500,
    description: 'Optional human note (1..500 characters) recorded on the approval row and the audit event. '
      + 'Omit when there is nothing to say.',
  },
}

/** 已校验的入参。 */
export interface ApproveArgs {
  readonly job_id: string
  readonly rubric_version_id: string
  readonly reason: string | undefined
}

/**
 * 校验并归一化入参（纯函数：不连库，`execute()` 与事务核心共用同一份）。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参。
 * @throws RecruitmentToolError - `INVALID_ARGS`（未知键/缺必填/非 UUID/类型不符）。
 */
export function parseApproveArgs(raw: unknown): ApproveArgs {
  const { parsed, violations } = collectArgViolations(APPROVE_SCALAR_PARAMS, raw)
  if (violations.length === 0) {
    return {
      job_id: parsed.job_id as string,
      rubric_version_id: parsed.rubric_version_id as string,
      reason: parsed.reason as string | undefined,
    }
  }
  const first = violations[0] as { reason: string; path: string; message: string }
  throw contractError('INVALID_ARGS', {
    reason_code: first.reason,
    message: '参数不合法，逐条见 detail.violations',
    detail: {
      allowed: Object.keys(APPROVE_SCALAR_PARAMS),
      violations: violations.map((entry) => ({
        reason_code: entry.reason,
        path: entry.path,
        message: entry.message,
      })),
    },
  })
}

// ---------------------------------------------------------------------------
//  D-79 人机闸门（approval seam）
// ---------------------------------------------------------------------------

/**
 * 让"等宿主批准"与"等 timeoutMs"赛跑。超时返回哨兵；**不等待原 promise**。
 * 原 promise 之后 resolve / reject 都不影响本次结果（已挂空 handler，不产生 unhandledRejection）。
 * @param request - 宿主的批准 promise。
 * @param timeoutMs - 等待上限（毫秒）。
 * @returns 宿主结果或 `'timeout'`。
 */
async function raceApproval(request: Promise<string>, timeoutMs: number): Promise<string | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把 approval 依赖包成"可等待的批准结果"。**缺依赖 = `unavailable`**，
 * 因此 headless（没有 answerer）恒 fail closed（D-79）。等待超过 `timeoutMs` → `'timeout'`。
 * @param approval - 依赖里的 approval 服务（可缺省）。
 * @param exec - 执行上下文（`agent` / `signal` 透传给宿主）。
 * @param timeoutMs - 等待上限（默认 `APPROVAL_TIMEOUT_MS`；测试注入更短的值）。
 * @returns 一个返回 `ApprovalDecision` 的函数；结果不在封闭集内时归 `unavailable`（不猜）。
 */
export function makeApprovalRequest(
  approval: ApprovalRequester | undefined,
  exec: { readonly agent?: unknown; readonly signal?: AbortSignal } | undefined,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): () => Promise<ApprovalDecision> {
  return async (): Promise<ApprovalDecision> => {
    if (approval === undefined) return 'unavailable'
    const pending = approval.request({
      agent: exec?.agent,
      toolName: JOB_RUBRIC_APPROVE_TOOL,
      reason: 'S3 rubric 批准是人的动作（D-79）：请确认批准这个 rubric 版本。',
      signal: exec?.signal,
    })
    const raw = await raceApproval(pending, timeoutMs)
    if (raw === 'timeout') {
      // 超时后宿主才点的 Allow：**不采纳**（事务已回滚，写不了库）；仍挂空 handler 防未处理拒绝。
      pending.then(() => undefined, () => undefined)
      return 'timeout'
    }
    if (raw === 'allowed-once' || raw === 'rejected' || raw === 'cancelled' || raw === 'unavailable') return raw
    // 宿主返回了封闭集之外的字符串：**不猜**，按不可用处理（fail closed）。
    return 'unavailable'
  }
}

/**
 * 写库前最后一关：**只有 `allowed-once` 放行**；其余一律 `FORBIDDEN`。
 *
 * 位置约定（D-79）：参数校验与全部业务校验（岗位/版本/审批状态/哈希）之后、
 * 第一行 INSERT / UPDATE 之前。`'timeout'` 与 `cancelled` 同判
 * （`APPROVAL_NOT_GRANTED`，`detail.approval='timeout'`）。
 * @param outcome - `approve()` 的结果。
 * @throws RecruitmentToolError - `FORBIDDEN` + `reason_code`（`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`）。
 */
export function requireApprovalGranted(outcome: ApprovalDecision): void {
  if (outcome === 'allowed-once') return
  const unavailable = outcome === 'unavailable'
  const timedOut = outcome === 'timeout'
  throw contractError('FORBIDDEN', {
    reason_code: unavailable ? 'APPROVAL_UNAVAILABLE' : 'APPROVAL_NOT_GRANTED',
    message: unavailable
      ? '没有可用的批准通道（headless 无 answerer）：rubric 批准被拒绝（D-79，fail closed）'
      : timedOut
        ? `等待人工批准超时（${APPROVAL_TIMEOUT_MS / 1000} 秒）：rubric 批准被拒绝（D-79，fail closed）`
        : '人工没有批准这次 rubric 批准动作（D-79）',
    detail: { approval: outcome, tool: JOB_RUBRIC_APPROVE_TOOL },
  })
}

// ---------------------------------------------------------------------------
//  出参 schema（只有官方子集：type/properties/required/additionalProperties/items/enum；
//  **没有 type 数组、没有 type:'null'** —— 可缺的键直接省略）
// ---------------------------------------------------------------------------

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [JOB_RUBRIC_APPROVE_TOOL] },
    contract_version: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        // 本工具不接任何外部系统：唯一如实取值是 NOT_CONNECTED。
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    outcome: { type: 'string', enum: ['APPROVED', 'CURRENT_UPDATED', 'NO_OP'] },
    replayed: { type: 'boolean' },
    gate: {
      type: 'object',
      properties: {
        requested: { type: 'boolean' },
        result: { type: 'string', enum: ['allowed-once', 'not-required'] },
      },
      required: ['requested', 'result'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        current_rubric_version_id: { type: 'string' },
        // 仅在指针真的移动过、且移动前非空时出现（无 null、无空串）。
        previous_current_rubric_version_id: { type: 'string' },
        record_version: { type: 'integer' },
      },
      required: ['id', 'code', 'title', 'status', 'current_rubric_version_id', 'record_version'],
      additionalProperties: false,
    },
    rubric: {
      type: 'object',
      properties: {
        version_id: { type: 'string' },
        version_no: { type: 'integer' },
        payload_hash: { type: 'string' },
        is_approved: { type: 'boolean' },
        is_current: { type: 'boolean' },
      },
      required: ['version_id', 'version_no', 'payload_hash', 'is_approved', 'is_current'],
      additionalProperties: false,
    },
    approval: {
      type: 'object',
      properties: {
        approval_id: { type: 'string' },
        status: { type: 'string', enum: ['APPROVED'] },
        decided_at: { type: 'string' },
        decided_by_actor_id: { type: 'string' },
        canonical_payload_hash: { type: 'string' },
        record_version: { type: 'integer' },
      },
      required: [
        'approval_id', 'status', 'decided_at', 'decided_by_actor_id',
        'canonical_payload_hash', 'record_version',
      ],
      additionalProperties: false,
    },
    changes: {
      type: 'object',
      properties: {
        written: { type: 'boolean' },
        tables: { type: 'array', items: { type: 'string' } },
        event_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['written', 'tables', 'event_ids'],
      additionalProperties: false,
    },
    next_action: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['READ_BACK'] },
        job_id: { type: 'string' },
        verify_with: { type: 'string', enum: ['recruitment_job_get'] },
      },
      required: ['kind', 'job_id', 'verify_with'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'labels', 'outcome', 'replayed', 'gate',
    'job', 'rubric', 'approval', 'changes', 'next_action',
  ],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  数据库行（只取本文件用到的列）
// ---------------------------------------------------------------------------

interface ActorRow {
  readonly kind: string
}

interface JobRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_rubric_version_id: string | null
  readonly record_version: number
}

interface RubricRow {
  readonly id: string
  readonly job_id: string
  readonly version_no: number
  readonly payload_hash: string
}

interface ApprovalRow {
  readonly id: string
  readonly status: string
  readonly payload_schema_version: number
  readonly canonical_payload_hash: string
  readonly decision_by_actor_id: string | null
  readonly decided_at: string | Date | null
  readonly record_version: number
  readonly expires_at: string | Date | null
  readonly superseded_by_approval_id: string | null
  readonly created_at: string | Date
}

// ---------------------------------------------------------------------------
//  规范输出值
// ---------------------------------------------------------------------------

/** 一次批准的结果（三个 outcome 由 §5 的规则决定）。 */
export interface JobRubricApproveValue {
  readonly tool: typeof JOB_RUBRIC_APPROVE_TOOL
  readonly contract_version: string
  readonly labels: ThreeAxisLabels
  readonly outcome: 'APPROVED' | 'CURRENT_UPDATED' | 'NO_OP'
  readonly replayed: boolean
  readonly gate: { readonly requested: boolean; readonly result: 'allowed-once' | 'not-required' }
  readonly job: {
    readonly id: string
    readonly code: string
    readonly title: string
    readonly status: string
    readonly current_rubric_version_id: string
    readonly previous_current_rubric_version_id?: string
    readonly record_version: number
  }
  readonly rubric: {
    readonly version_id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly is_approved: boolean
    readonly is_current: boolean
  }
  readonly approval: {
    readonly approval_id: string
    readonly status: 'APPROVED'
    readonly decided_at: string
    readonly decided_by_actor_id: string
    readonly canonical_payload_hash: string
    readonly record_version: number
  }
  readonly changes: {
    readonly written: boolean
    readonly tables: readonly string[]
    readonly event_ids: readonly string[]
  }
  readonly next_action: {
    readonly kind: 'READ_BACK'
    readonly job_id: string
    readonly verify_with: 'recruitment_job_get'
  }
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/**
 * `timestamptz` 列 → ISO 文本。
 * @param value - pg 给的 Date 或字符串；null 原样返回 null。
 */
function iso(value: string | Date | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/**
 * 审批是否**此刻生效**（J-5 / JR §4.2）：未 supersede、未过期。
 * 过期的 APPROVED 行仍然是历史事实，但不再是"可用标准"。
 * @param row - approval 行。
 * @param nowMs - 服务端当前时刻（毫秒）。
 */
function isEffectiveApproved(row: ApprovalRow, nowMs: number): boolean {
  if (row.status !== 'APPROVED') return false
  if (row.superseded_by_approval_id !== null) return false
  if (row.expires_at === null) return true
  const expires = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at)
  return Number.isFinite(expires) && expires > nowMs
}

/**
 * 写一条内部审计事件（`event_inbox`）。**只在真的发生了状态变化时调用**：
 * `NO_OP` 分支在它之前返回，因此重复批准不会产生第二条事件。
 *
 * 幂等键每次唯一：`rubric-approve:<uuid>`（内部事实，去重靠 `NO_OP` 分支，而不是事件键）。
 * 若用"每版本固定键"，则"先批准 v1、后临时回滚到 v1"这类合法序列会被 23505 挡住。
 * @param client - 事务内客户端。
 * @param input - 事件字段。
 * @returns 新事件 id。
 */
async function insertApprovedEvent(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly jobId: string
    readonly rubric: RubricRow
    readonly approvalId: string
    readonly approvedBy: string
    readonly approvedAt: string
    readonly previousCurrentRubricVersionId: string | null
    readonly outcome: JobRubricApproveValue['outcome']
    readonly reason: string | undefined
  },
): Promise<string> {
  const payload = {
    job_id: input.jobId,
    rubric_version_id: input.rubric.id,
    rubric_version_no: input.rubric.version_no,
    rubric_payload_hash: input.rubric.payload_hash,
    approval_id: input.approvalId,
    approved_by_actor_id: input.approvedBy,
    approved_at: input.approvedAt,
    previous_current_rubric_version_id: input.previousCurrentRubricVersionId,
    current_rubric_version_id: input.rubric.id,
    pointer_changed: input.previousCurrentRubricVersionId !== input.rubric.id,
    outcome: input.outcome,
    source: JOB_RUBRIC_APPROVE_TOOL,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  }
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at, correlation_id, causation_id,
        idempotency_key, idempotency_source, source_object_id,
        payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, 'internal', null, '${EVENT_TYPES.JOB_RUBRIC_VERSION_APPROVED}', 1,
             now(), now(), now(), null, null,
             $2, 'FALLBACK_KEY', $3,
             null, $4::jsonb, 'INTERNAL', '${EVENT_TYPES.JOB_RUBRIC_VERSION_APPROVED}', 'schema/0001')
     returning event_id`,
    [
      input.tenantId,
      `rubric-approve:${randomUUID()}`,
      input.rubric.id,
      JSON.stringify(payload),
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'event_inbox insert returned no row')
  }
  return row.event_id
}

// ---------------------------------------------------------------------------
//  两阶段（D-101）：只读准备 → 事务外问人 → 写事务复校验 → 写入
// ---------------------------------------------------------------------------

/**
 * 只读阶段产出的**写计划**（此时还没问人、也没写库）。
 * 只带"写库需要的最小事实"：入参 + 岗位/版本行 + 审批行判定 + 指针是否已对齐。
 */
export interface RubricApprovalWritePlan {
  readonly kind: 'WRITE'
  /** 已校验的入参（`reason` 会写进审批行与审计事件）。 */
  readonly args: ApproveArgs
  /** 读阶段看到的岗位行（指针旧值 + `record_version` 基线）。 */
  readonly job: JobRow
  /** 审批的目标版本行。 */
  readonly rubric: RubricRow
  /** 待决的 PENDING 审批行（已生效 APPROVED 时为 undefined）。 */
  readonly pending: ApprovalRow | undefined
  /** 已生效的 APPROVED 行（需把陈旧指针补过去时；待决 PENDING 时为 undefined）。 */
  readonly effectiveApproved: ApprovalRow | undefined
  /** 读阶段看到的指针是否已指向目标版本（写阶段在同一事务里重判，不再跨事务信任）。 */
  readonly pointerAligned: boolean
}

/** `prepareRubricApproval()` 的结果：纯重放（直接带输出值）或一份写计划。 */
export type PreparedRubricApproval =
  | { readonly kind: 'NO_OP'; readonly value: JobRubricApproveValue }
  | RubricApprovalWritePlan

// ---------------------------------------------------------------------------
//  事务核心
// ---------------------------------------------------------------------------

/**
 * 两阶段批准的**只读准备阶段**（D-101）：做完全部业务校验、判定是否纯重放；需要写时
 * 返回一份写计划 —— 这一阶段**一行不写**；`forUpdate=false` 时连行锁都不拿。
 *
 * 顺序（与旧事务内实现完全一致，注定失败的调用不会先弹窗打扰人）：
 *   1. 入参形状（纯函数，最早就拒，不连库）；
 *   2. 决定者必须是本租户的 **HUMAN**（D-79：Agent/SYSTEM 不能替人签字）；
 *   3. 岗位行：`forUpdate=true` 时 `select ... for update`（写事务复校验；与岗位更新同一把锁），
 *      `forUpdate=false` 时普通 `select`（只读事务里不允许 `for update`）；
 *   4. 版本必须属于该 job（否则 `RUBRIC_VERSION_NOT_FOUND`，detail 带现有版本号）；
 *   5. 审批行：取生效的 APPROVED（须 hash 相同）或最新 PENDING（须 hash/schema 相同）；
 *      都已失效/已拒 → 失败（不打扰人）；没有审批行 → `APPROVAL_NOT_FOUND`；
 *   6. **纯重放**（已生效且指针已对齐）→ 直接返回 `NO_OP` 输出（不问人、不写任何行）；
 *   7. 否则返回写计划（`PENDING → 决定` 或 `已批准但指针陈旧 → 只补指针`）。
 * @param client - 事务内客户端（只读事务或写事务；`withActor` 的写事务已设 actor GUC）。
 * @param cfg - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param rawArgs - 模型给的 arguments（本函数自己再校验一次，保证测试直调也安全）。
 * @param options.forUpdate - 写阶段 `true`（锁岗位行）；只读阶段 `false`（普通 select）。
 * @returns NO_OP 的完整输出值；或一份尚未执行的写计划。
 * @internal 允许测试直调；**产品入口是 `createJobRubricApproveTool().execute()`**。
 */
export async function prepareRubricApproval(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  options: { readonly forUpdate: boolean },
): Promise<PreparedRubricApproval> {
  const args = parseApproveArgs(rawArgs)
  const nowMs = Date.now()

  try {
    // 1. 决定者必须是本租户的 HUMAN（D-79：批准是人的动作）。
    //    与 `decideRubricApprovalInTransaction` 同一判据，这里提前失败是为了"不打扰人"。
    const actorResult = await client.query<ActorRow>(
      `select kind from recruitment.actor where id = $1 and tenant_id = $2`,
      [cfg.actor_id, cfg.tenant_id],
    )
    const actor = actorResult.rows[0]
    if (actor === undefined) {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_IN_TENANT',
        message: `actor ${cfg.actor_id} 不存在或不属于租户 ${cfg.tenant_id}`,
        detail: { actor_id: cfg.actor_id, tenant_id: cfg.tenant_id },
      })
    }
    if (actor.kind !== 'HUMAN') {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_HUMAN',
        message: `actor ${cfg.actor_id} 的 kind 是 ${actor.kind}，rubric 批准只允许 HUMAN`,
        detail: { actor_id: cfg.actor_id, kind: actor.kind },
      })
    }

    // 2. 岗位行（同时取指针的旧值）。写阶段 `for update`（与岗位更新同一把行锁，避免并发写
    //    指针互相覆盖）；只读阶段普通 select —— `begin transaction read only` 里不允许 `for update`。
    const jobResult = await client.query<JobRow>(
      `select id, code, title, status, current_rubric_version_id, record_version
         from recruitment.job
        where id = $1 and tenant_id = $2${options.forUpdate ? '\n        for update' : ''}`,
      [args.job_id, cfg.tenant_id],
    )
    const job = jobResult.rows[0]
    if (job === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'JOB_NOT_FOUND',
        message: `该租户下没有岗位 ${args.job_id}`,
        detail: { job_id: args.job_id },
      })
    }

    // 3. 版本必须属于这个岗位（0005 的 (tenant_id,id,job_id) 唯一键是库层同一事实）。
    const rubricResult = await client.query<RubricRow>(
      `select id, job_id, version_no, payload_hash
         from recruitment.rubric_version
        where id = $1 and tenant_id = $2 and job_id = $3`,
      [args.rubric_version_id, cfg.tenant_id, job.id],
    )
    const rubric = rubricResult.rows[0]
    if (rubric === undefined) {
      const known = await client.query<{ version_no: number }>(
        `select version_no from recruitment.rubric_version
          where tenant_id = $1 and job_id = $2 order by version_no`,
        [cfg.tenant_id, job.id],
      )
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `岗位 ${args.job_id} 下没有 Rubric 版本 ${args.rubric_version_id}`,
        detail: {
          job_id: args.job_id,
          rubric_version_id: args.rubric_version_id,
          known_version_nos: known.rows.map((row) => row.version_no),
        },
      })
    }

    // 4. 审批行（同一版本理论上只有一条；按创建时间取最新，兼容历史数据）。
    const approvalResult = await client.query<ApprovalRow>(
      `select id, status, payload_schema_version, canonical_payload_hash,
              decision_by_actor_id, decided_at, record_version, expires_at,
              superseded_by_approval_id, created_at
         from recruitment.approval
        where tenant_id = $1 and resource_type = 'RUBRIC_VERSION' and resource_id = $2
        order by created_at desc, id desc`,
      [cfg.tenant_id, rubric.id],
    )
    const approvals = approvalResult.rows
    if (approvals.length === 0) {
      throw contractError('NOT_FOUND', {
        reason_code: 'APPROVAL_NOT_FOUND',
        message: `Rubric 版本 ${rubric.id} 没有任何审批行（先经 recruitment_job_create/_update 创建）`,
        detail: { job_id: job.id, rubric_version_id: rubric.id },
      })
    }
    const effectiveApproved = approvals.find((row) => isEffectiveApproved(row, nowMs))
    const pending = approvals.find((row) => row.status === 'PENDING')
    const latest = approvals[0] as ApprovalRow

    // 5. 状态判定：已生效 / 可批（PENDING）/ 不可批。**先判哈希再问人**（注定失败的调用不弹窗）。
    if (effectiveApproved !== undefined) {
      if (effectiveApproved.canonical_payload_hash !== rubric.payload_hash) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'PAYLOAD_HASH_MISMATCH',
          message: `审批 ${effectiveApproved.id} 绑定的 hash 与 rubric v${rubric.version_no} 不一致`,
          detail: {
            approval_id: effectiveApproved.id,
            approval_hash: effectiveApproved.canonical_payload_hash,
            rubric_hash: rubric.payload_hash,
          },
        })
      }
    } else if (pending !== undefined) {
      if (pending.payload_schema_version !== 1) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'UNSUPPORTED_PAYLOAD_SCHEMA_VERSION',
          message: `审批 ${pending.id} 的 payload_schema_version 是 ${pending.payload_schema_version}，本契约只支持 1`,
          detail: { approval_id: pending.id, payload_schema_version: pending.payload_schema_version },
        })
      }
      if (pending.canonical_payload_hash !== rubric.payload_hash) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'PAYLOAD_HASH_MISMATCH',
          message: `审批 ${pending.id} 绑定的 hash 与 rubric v${rubric.version_no} 不一致`,
          detail: {
            approval_id: pending.id,
            approval_hash: pending.canonical_payload_hash,
            rubric_hash: rubric.payload_hash,
          },
        })
      }
    } else {
      const status = latest.status
      if (status === 'APPROVED' && latest.superseded_by_approval_id !== null) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'APPROVAL_SUPERSEDED',
          message: `审批 ${latest.id} 已被 ${latest.superseded_by_approval_id} 取代，不能作为当前批准`,
          detail: { approval_id: latest.id, superseded_by_approval_id: latest.superseded_by_approval_id },
        })
      }
      if (status === 'APPROVED') {
        throw contractError('INVALID_ARGS', {
          reason_code: 'APPROVAL_EXPIRED',
          message: `审批 ${latest.id} 已过期（expires_at=${iso(latest.expires_at) ?? 'unknown'}），不能作为当前批准`,
          detail: { approval_id: latest.id, expires_at: iso(latest.expires_at) ?? 'unknown' },
        })
      }
      throw contractError('INVALID_ARGS', {
        reason_code: 'APPROVAL_NOT_PENDING',
        message: `审批 ${latest.id} 已经是 ${status}，不能批准（已决审批不可改判，需新建审批）`,
        detail: { approval_id: latest.id, status },
      })
    }

    const pointerAligned = job.current_rubric_version_id === rubric.id

    // 6. 纯重放：批准已生效且指针已对齐 → NO_OP（不问人、零写入）。
    if (effectiveApproved !== undefined && pointerAligned) {
      const decidedAt = iso(effectiveApproved.decided_at)
      const decidedBy = effectiveApproved.decision_by_actor_id
      if (decidedAt === null || decidedBy === null) {
        throw new RecruitmentToolError('READER_FAILED', 'approval row is APPROVED but lacks decided_at / decided_by_actor_id')
      }
      const labels = await buildThreeAxisLabels(client, cfg.tenant_id)
      return {
        kind: 'NO_OP',
        value: buildValue({
          labels,
          outcome: 'NO_OP',
          replayed: true,
          gate: { requested: false, result: 'not-required' },
          job,
          rubric,
          approvalHash: effectiveApproved.canonical_payload_hash,
          approvalRecordVersion: effectiveApproved.record_version,
          approvalId: effectiveApproved.id,
          decidedAt,
          decidedBy,
          previousCurrentRubricVersionId: null,
          changes: { written: false, tables: [], event_ids: [] },
        }),
      }
    }

    // 7. 写计划（还没问人、也没写库）：PENDING → 决定；已生效但指针陈旧 → 只补指针。
    //    前面的状态判定保证走到这里时 `pending` / `effectiveApproved` 必有其一。
    if (effectiveApproved === undefined && pending === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'no approval row is approvable but no error was raised')
    }
    return {
      kind: 'WRITE',
      args,
      job,
      rubric,
      pending,
      effectiveApproved,
      pointerAligned,
    }
  } catch (error) {
    // 只映射当前错误，不在 catch 里补查询（25P02：事务已被终止）。
    throw mapDatabaseError(error)
  }
}

/**
 * 两阶段批准的**写入阶段**（D-101）：把只读阶段判定的写计划落库。
 *
 * **调用前提**：写事务内 + 已过 D-79 闸门（`allowed-once`）。本函数不再问人、不再做业务
 * 校验（并发竞态由写事务里 `prepareRubricApproval({forUpdate:true})` 复校验兜住）。
 *
 * 顺序：PENDING → 复用 CLI 同一个 `decideRubricApprovalInTransaction()` 落 APPROVED
 * （触发 `fn_row_guard` 写 `approval.status.changed` 事件）；已生效但指针陈旧 → 跳过决定
 * （`CURRENT_UPDATED`）；指针未对齐才 UPDATE job（`fk_job_current_rubric` 在库层兜底，
 * `fn_row_guard` 自增 `record_version`，所以用 `RETURNING` 真实值，绝不自己 +1）；
 * 最后写内部审计事件 `job.rubric_version.approved`。
 * @param client - 写事务内客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param cfg - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param plan - `prepareRubricApproval()` 返回的写计划。
 * @returns 契约出参。
 * @internal 允许测试直调；**产品入口是 `createJobRubricApproveTool().execute()`**。
 */
export async function writeRubricApproval(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  plan: RubricApprovalWritePlan,
): Promise<JobRubricApproveValue> {
  const { args, job, rubric, pending, effectiveApproved } = plan
  const pointerAligned = plan.pointerAligned

  try {
    // 8. 落决定：PENDING → APPROVED（复用 CLI 同一个函数）；已批准但指针陈旧 → 只补指针。
    let decidedAt: string
    let decidedBy: string
    let approvalRecordVersion: number
    let approvalId: string
    let outcome: JobRubricApproveValue['outcome']
    const tables: string[] = []
    const eventIds: string[] = []

    if (pending !== undefined) {
      const decided = await decideRubricApprovalInTransaction(client, cfg, {
        approval_id: pending.id,
        decision: 'APPROVE',
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      })
      decidedAt = decided.decided_at
      decidedBy = decided.decided_by_actor_id
      approvalRecordVersion = decided.record_version
      approvalId = decided.approval_id
      outcome = 'APPROVED'
      tables.push('approval')
    } else {
      const approved = effectiveApproved as ApprovalRow
      const decidedAtIso = iso(approved.decided_at)
      const decidedByActor = approved.decision_by_actor_id
      if (decidedAtIso === null || decidedByActor === null) {
        throw new RecruitmentToolError('READER_FAILED', 'approval row is APPROVED but lacks decided_at / decided_by_actor_id')
      }
      decidedAt = decidedAtIso
      decidedBy = decidedByActor
      approvalRecordVersion = approved.record_version
      approvalId = approved.id
      outcome = 'CURRENT_UPDATED'
    }

    // 走到写库分支时必然二者其一：有待批的 PENDING，或已生效但指针陈旧。
    if (pending === undefined && effectiveApproved === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'write plan has neither a pending nor an effective approval')
    }
    const decisionRow: ApprovalRow = pending ?? (effectiveApproved as ApprovalRow)

    // 9. 指针未对齐才 UPDATE（否则 fn_row_guard 会白白 +1 record_version）。
    let finalRecordVersion = job.record_version
    const previousCurrentRubricVersionId = job.current_rubric_version_id
    if (!pointerAligned) {
      const updated = await client.query<{ record_version: number }>(
        `update recruitment.job
            set current_rubric_version_id = $3
          where id = $1 and tenant_id = $2
          returning record_version`,
        [job.id, cfg.tenant_id, rubric.id],
      )
      const row = updated.rows[0]
      if (row === undefined) {
        throw new RecruitmentToolError('READER_FAILED', 'job pointer update returned no row')
      }
      finalRecordVersion = row.record_version
      tables.push('job')
    }

    // 10. 审计事件（只在真的发生了写入/状态变化时）。
    const eventId = await insertApprovedEvent(client, {
      tenantId: cfg.tenant_id,
      jobId: job.id,
      rubric,
      approvalId,
      approvedBy: decidedBy,
      approvedAt: decidedAt,
      previousCurrentRubricVersionId,
      outcome,
      reason: args.reason,
    })
    eventIds.push(eventId)
    tables.push('event_inbox')

    const labels = await buildThreeAxisLabels(client, cfg.tenant_id)
    return buildValue({
      labels,
      outcome,
      replayed: outcome === 'CURRENT_UPDATED',
      gate: { requested: true, result: 'allowed-once' },
      job: { ...job, current_rubric_version_id: rubric.id, record_version: finalRecordVersion },
      rubric,
      approvalHash: decisionRow.canonical_payload_hash,
      approvalRecordVersion,
      approvalId,
      decidedAt,
      decidedBy,
      previousCurrentRubricVersionId: previousCurrentRubricVersionId !== null
        && previousCurrentRubricVersionId !== rubric.id
        ? previousCurrentRubricVersionId
        : null,
      changes: { written: true, tables, event_ids: eventIds },
    })
  } catch (error) {
    // 只映射当前错误，不在 catch 里补查询（25P02：事务已被终止）。
    throw mapDatabaseError(error)
  }
}

/**
 * 在**调用方给的事务**里批准一个 rubric 版本并把 `job.current_rubric_version_id` 指过去。
 *
 * **这是事务内测试接缝**（`test/integration/job-create.test.ts` / `scorecard-rubric-version-gate.test.ts`
 * 用它验证"批准动作 + 零写入"），`src/index.ts` 只注册 `create*Tool`，不调它。
 * 产品入口的慢应答路径见 `createJobRubricApproveTool().execute()`（两阶段，问人在事务外）。
 *
 * 顺序（与旧实现完全一致：全部业务校验 → 纯重放短路 → 人机闸门 → 写库，全在一个事务里）：
 *   1. `prepareRubricApproval(forUpdate=true)`：参数/actor/岗位（`for update`）/版本/审批行/NO_OP；
 *   2. `NO_OP` 直接返回（不问人、零写入）；
 *   3. `requireApprovalGranted(await approve())`：只有 `allowed-once` 继续（缺省 = 拒绝）；
 *   4. `writeRubricApproval()`：决定 + 补指针 + 审计事件。
 * @param client - 事务内客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param cfg - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param rawArgs - 模型给的 arguments（本函数自己再校验一次，保证测试直调也安全）。
 * @param approve - D-79 的人工批准通道；**缺省 = `unavailable` = 一律拒绝**（fail closed）。
 * @returns 契约出参。
 */
export async function approveRubricInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  approve?: () => Promise<ApprovalDecision>,
): Promise<JobRubricApproveValue> {
  // 入参形状仍在 try 之外先拒（与旧实现同一位置：不连库、不进事务错误映射）。
  parseApproveArgs(rawArgs)
  try {
    const prepared = await prepareRubricApproval(client, cfg, rawArgs, { forUpdate: true })
    // 纯重放：批准已生效且指针已对齐 → NO_OP（不问人、零写入，D-95）。
    if (prepared.kind === 'NO_OP') return prepared.value

    // D-79 人机闸门：业务校验全部通过，但仍在第一行写入之前。
    // 任何会改库的调用（含把陈旧指针修到已批准版本）都要过闸门 —— 改 current 指针
    // 是业务可见变化；只有完全幂等的 NO_OP 才不问人（D-95：不重复打扰）。
    const gateOutcome: ApprovalDecision = approve === undefined ? 'unavailable' : await approve()
    requireApprovalGranted(gateOutcome)

    return await writeRubricApproval(client, cfg, prepared)
  } catch (error) {
    // 只映射当前错误，不在 catch 里补查询（25P02：事务已被终止）。
    throw mapDatabaseError(error)
  }
}

/**
 * 组装规范输出值（三个 outcome 同形；可缺的键直接省略，不写 null）。
 * @param input - 已解析的字段。
 */
function buildValue(input: {
  readonly labels: ThreeAxisLabels
  readonly outcome: JobRubricApproveValue['outcome']
  readonly replayed: boolean
  readonly gate: JobRubricApproveValue['gate']
  readonly job: JobRow
  readonly rubric: RubricRow
  readonly approvalHash: string
  readonly approvalRecordVersion: number
  readonly approvalId: string
  readonly decidedAt: string
  readonly decidedBy: string
  readonly previousCurrentRubricVersionId: string | null
  readonly changes: JobRubricApproveValue['changes']
}): JobRubricApproveValue {
  const job: JobRubricApproveValue['job'] = {
    id: input.job.id,
    code: input.job.code,
    title: input.job.title,
    status: input.job.status,
    current_rubric_version_id: input.rubric.id,
    record_version: input.job.record_version,
    ...(input.previousCurrentRubricVersionId === null
      ? {}
      : { previous_current_rubric_version_id: input.previousCurrentRubricVersionId }),
  }
  return {
    tool: JOB_RUBRIC_APPROVE_TOOL,
    contract_version: CONTRACT_VERSION,
    labels: input.labels,
    outcome: input.outcome,
    replayed: input.replayed,
    gate: input.gate,
    job,
    rubric: {
      version_id: input.rubric.id,
      version_no: input.rubric.version_no,
      payload_hash: input.rubric.payload_hash,
      // 走到这里就是"生效的 APPROVED + hash 一致"（否则前面已经抛错）。
      is_approved: true,
      is_current: input.job.current_rubric_version_id === input.rubric.id,
    },
    approval: {
      approval_id: input.approvalId,
      status: 'APPROVED',
      decided_at: input.decidedAt,
      decided_by_actor_id: input.decidedBy,
      canonical_payload_hash: input.approvalHash,
      record_version: input.approvalRecordVersion,
    },
    changes: input.changes,
    next_action: {
      kind: 'READ_BACK',
      job_id: input.job.id,
      verify_with: 'recruitment_job_get',
    },
  }
}

// ---------------------------------------------------------------------------
//  模型可见说明
// ---------------------------------------------------------------------------

const DESCRIPTION = [
  'Approve ONE rubric version of a job as a HUMAN action and point job.current_rubric_version_id at it. '
    + 'This is the product entry for S3 rubric approval (docs/23 N7): recruitment_job_create / _update only '
    + 'write approval(status=PENDING); until a human approves it, recruitment_job_get answers NO_APPROVED_RUBRIC.',
  '',
  'D-79 HUMAN GATE (why an agent cannot approve by itself)',
  '- Before ANY write the tool asks the host for human approval (ctx.approval). Only an explicit human '
    + '"allowed-once" continues; rejected / cancelled / unavailable / 120s timeout => '
    + 'FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED) and NOTHING is written.',
  '- Call this tool only when the user explicitly asks to approve this rubric version. Never invent a user '
    + 'instruction and never describe a rubric as approved before this tool returns outcome=APPROVED / NO_OP / '
    + 'CURRENT_UPDATED.',
  '',
  'WHAT IT WRITES (one transaction)',
  '- approval: PENDING -> APPROVED via the same human decision function the CLI uses. The rubric_version row is '
    + 'never touched (it is immutable); rubric_version.approved_by_approval_id stays null by contract (J-1/J-5).',
  '- job.current_rubric_version_id -> the approved version (only when it differs). This is the explicit current '
    + 'pointer (D-21/D-48), not max(version_no); the composite FK fk_job_current_rubric rejects versions of '
    + 'another job/tenant.',
  '- event_inbox: one internal event job.rubric_version.approved with job/rubric/approval ids and the '
    + 'previous -> current pointer values. The approval status transition itself is audited by the database '
    + 'trigger (approval.status_source_event_id).',
  '',
  'IDEMPOTENCY',
  '- Already approved AND pointer already points at it => outcome=NO_OP, replayed=true, the human is NOT asked '
    + 'and NOTHING is written (record_version and event count stay unchanged).',
  '- Already approved but the pointer is stale (legacy CLI approval) => outcome=CURRENT_UPDATED, replayed=true; '
    + 'the human gate is still required because moving the current pointer is business-visible.',
  '- This call performed the PENDING -> APPROVED decision => outcome=APPROVED, replayed=false.',
  '',
  'INPUTS',
  '- job_id: UUID of the job (from recruitment_job_create / _update / _get).',
  '- rubric_version_id: UUID of the rubric version (rubric.version_id from the same tools). It must belong to '
    + 'job_id, otherwise NOT_FOUND(RUBRIC_VERSION_NOT_FOUND) lists the job\'s known version numbers.',
  '- reason: optional human note (1..500 characters), recorded on the approval row and the audit event.',
  '- tenant_id / actor_id are never accepted from the model: identity comes from the execution context.',
  '',
  'FAILURES (closed set)',
  '- INVALID_ARGS: bad arguments, PAYLOAD_HASH_MISMATCH (approval hash != rubric payload hash), '
    + 'APPROVAL_NOT_PENDING / APPROVAL_EXPIRED / APPROVAL_SUPERSEDED, UNSUPPORTED_PAYLOAD_SCHEMA_VERSION.',
  '- NOT_FOUND: JOB_NOT_FOUND, RUBRIC_VERSION_NOT_FOUND, APPROVAL_NOT_FOUND.',
  '- FORBIDDEN: ACTOR_NOT_IN_TENANT, ACTOR_NOT_HUMAN, APPROVAL_UNAVAILABLE, APPROVAL_NOT_GRANTED.',
  '',
  'Verify the result with recruitment_job_get(job_id=...): rubric.is_current=true, rubric.is_approved=true.',
].join('\n')

// ---------------------------------------------------------------------------
//  工具定义
// ---------------------------------------------------------------------------

/**
 * 造真实的 rubric 批准工具。
 * @param database - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖；`approval` 缺省时写库一律被拒（D-79 fail closed）；
 *   `identity` 由 `src/index.ts` 装配（产品路径），缺省 = 仅测试兼容的 legacy actor。
 */
export function createJobRubricApproveTool(
  database: ResolvedDatabaseConfig,
  deps: JobRubricApproveDeps = {},
): ReadonlyToolDefinition {
  return {
    name: JOB_RUBRIC_APPROVE_TOOL,
    description: DESCRIPTION,
    parameters: toParameterSchema(APPROVE_SCALAR_PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderApproveValue },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于建连解析：identity 已装配时缺失映射在此 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, database.actor_id)
      const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: writeActor.actor_id }
      // 先做契约层校验（不连库就失败），再把原始入参交给两阶段核心（核心会再校验一次，
      // 保证集成测试直调 in-transaction 函数时行为一致）。
      parseApproveArgs(rawArgs)
      const approve = makeApprovalRequest(deps.approval, readExecContext(exec))
      const pool = createPool(database)
      try {
        // 阶段 1（只读事务）：全部业务校验 + 纯重放短路。结束即提交，连接退回池里。
        const prepared = await withReadOnly(pool, (client) =>
          prepareRubricApproval(client, writeConfig, rawArgs, { forUpdate: false }))
        if (prepared.kind === 'NO_OP') return prepared.value

        // 阶段 2（**事务之外**问人）：D-101 的修复点 —— 等人期间没有任何未结束的事务，
        // 工具连接在池里是 idle（不是 idle in transaction）；120s 超时也只是放弃这次等待。
        requireApprovalGranted(await approve())

        // 阶段 3（写事务）：`for update` 复校验 —— 并发窗口里别人已批准且指针已对齐
        // ⇒ 返回该 NO_OP 结果、不写库；否则只做写入（不再重复问人）。
        return await withActor(pool, writeActor.actor_id, async (client) => {
          const confirmed = await prepareRubricApproval(client, writeConfig, rawArgs, { forUpdate: true })
          if (confirmed.kind === 'NO_OP') return confirmed.value
          return writeRubricApproval(client, writeConfig, confirmed)
        })
      } catch (error) {
        throw mapDatabaseError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 未配置替身：工具照常注册，调用时报 `NOT_CONFIGURED` 并列出缺什么。
 * 这比让工具消失更好——模型能看到"为什么批不了"，而不是以为工具不存在。
 * @param issues - `resolveDatabaseConfig` 给出的缺陷清单。
 */
export function unconfiguredJobRubricApproveTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: JOB_RUBRIC_APPROVE_TOOL,
    description: `${DESCRIPTION}\n\nCurrently NOT CONFIGURED: the plugin config is missing database settings `
      + '(or the database password environment variable). Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(APPROVE_SCALAR_PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${JOB_RUBRIC_APPROVE_TOOL} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，rubric 批准不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/** 从执行上下文里取 `agent` / `signal`（DSH 的 `exec` 是 unknown）。 */
function readExecContext(exec: unknown): { agent?: unknown; signal?: AbortSignal } | undefined {
  if (typeof exec !== 'object' || exec === null || Array.isArray(exec)) return undefined
  const record = exec as { agent?: unknown; signal?: unknown }
  return {
    ...(record.agent === undefined ? {} : { agent: record.agent }),
    ...(record.signal instanceof AbortSignal ? { signal: record.signal } : {}),
  }
}

/**
 * 渲染模型可见文本（批准结果 + 证据位点 + 读回命令）。
 * 签名必须是 `(args, value)`：DSH 运行时按两参调用 `output.render`。
 * @param _args - 本次调用的入口（渲染不依赖它）。
 * @param value - 本工具的规范输出值。
 */
function renderApproveValue(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as JobRubricApproveValue
  const labels = v.labels === undefined
    ? 'LABELS_MISSING'
    : `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
  const previous = v.job.previous_current_rubric_version_id === undefined
    ? 'none'
    : v.job.previous_current_rubric_version_id
  const lines: string[] = [
    `${v.outcome.toLowerCase()} rubric v${v.rubric.version_no} approval for job ${v.job.code} `
      + `${v.job.title} [${v.job.status}]  (labels: ${labels})`,
    `  job_id=${v.job.id}  record_version=${v.job.record_version}`,
    `  rubric version_id=${v.rubric.version_id}  payload_hash=${v.rubric.payload_hash.slice(0, 8)}…  `
      + `is_approved=${String(v.rubric.is_approved)}  is_current=${String(v.rubric.is_current)}`,
    `  approval ${v.approval.approval_id} ${v.approval.status} by ${v.approval.decided_by_actor_id} `
      + `at ${v.approval.decided_at}`,
    `  current_rubric_version_id: ${previous} -> ${v.job.current_rubric_version_id}`,
    `  replayed=${String(v.replayed)}  gate: requested=${String(v.gate.requested)} result=${v.gate.result}`,
    `  changes: written=${String(v.changes.written)} tables=[${v.changes.tables.join(', ')}] `
      + `events=[${v.changes.event_ids.join(', ')}]`,
    `next: recruitment_job_get(job_id=${v.job.id})`,
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}
