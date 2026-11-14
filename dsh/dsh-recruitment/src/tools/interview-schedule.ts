// recruitment_interview_schedule —— S8 面试排期（**本切片只做 `intent=CREATE`**）。
//
// 合同（**不得修改**）：
//   * `contracts/interview/scheduling-rules.md`（§2 A1–A10 判定式、§3 冲突、§6.4 ALREADY_SCHEDULED、
//     §7 meeting_binding、§9 幂等）——`SC-*`。
//   * `contracts/interview/tool-contracts.md`（§1 通用、§3 schedule、§4 幂等、§5.1 写工具证明口径）。
//   * `manual/interview-line/SPEC.md` §2 / §4（本切片的落点与顺序）。
//
// 一次调用在**一个** `withActor` 事务里做这些事（任何一步失败整笔回滚）：
//   1. 幂等 STORE（`business_task.idempotency_key = 'interview_schedule:' || K`）→ 重放 / 键复用；
//   2. 申请（同租户 ACTIVE）；3. 语义幂等 `(application, round_no, slot_code)`；
//   4. 面试官（同租户 + `kind='HUMAN'`）；5. 冲突（`[start, end+buffer)`）；
//   5.5 **人机闸门（D-79）**：全部校验通过后、第一行 INSERT 前请求人工批准；approval 缺省 /
//      `rejected` / `cancelled` / `unavailable` → `FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED)`，
//      零写入（fail closed）。**幂等重放不写库，因此在闸门之前返回。**
//      等待人工批准超过 **120 秒** → 按 `cancelled` 判（`detail.approval='timeout'`）并回滚，
//      不占着连接等一个不在的人；超时后宿主晚到的 Allow 不采纳（D-101 两阶段见闸门段注释）。
//   6. `INSERT interview`（显式 `stage_code='S8'`）；7. `INSERT interviewer` 逐行；
//   8. meeting / meeting_binding（只**登记**调用方给的平台 ID）；9. 未给会议 → `INTERVIEW_MEETING_BIND` 任务；
//  10. 幂等 STORE 行；11. 用 `readInterviewValue` 读回（写完立刻可查的自证）。
//
// 本文件**不**做的事（写进 description，不假装）：
//   * `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER`（后续切片；`intent` 的 enum 只有 `CREATE`，
//     其它值由 `parseContractArgs` 的 enum 校验拒成 `INVALID_ARGS(OUT_OF_RANGE)`）；
//   * 任何外部调用（H-2）：无 fetch / http / 子进程 / SDK import，`effects.external_call_made` 恒 `false`，
//     `labels.connection` 恒 `NOT_CONNECTED`；
//   * 不写 `scorecard` / `decision`（`SC-I5`），不猜会议（`APP-04`），不猜 intent（§6.4）。
//
// R4 三维标签（`contracts/tenant-provenance.md`）：`provenance` **按租户的合成标记算**，
// 不写死 `LIVE`（演示租户 / 缺正面证据 ⇒ `FIXTURE`）；`trigger` 恒 `MANUAL`；
// `connection` 恒 `NOT_CONNECTED`（本工具不接日历/会议平台）。"这次真的写进了库"**不是**
// `LIVE` 的证据——演示租户的合成数据同样写进了库，那正是 R4 里 "Fixture 冒充 LIVE" 的入口。
//
// 只写 5 张表（`tool-contracts.md` §5.1 W1）：`interview` / `interviewer` / `meeting` /
// `meeting_binding` / `business_task`。
//
// 契约错误：`INVALID_ARGS` / `NOT_FOUND` 走 `contractError`（`contract.ts`）；S8 专有的
// `CONFLICT_SLOT` / `ALREADY_SCHEDULED` / `MEETING_ALREADY_BOUND` / `VERSION_CONFLICT` 不在
// `RecruitmentErrorCode` 的 S6/S7 封闭集里（`errors.ts` 不属本泳道写范围），这里以**同一消息格式**
// 构造（`Error: <CODE>: <单行 compact-json>`），运行时行为与 `contractError` 一致。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { canonicalJson, contractError, digestOf, isUuid } from './contract.ts'
import { RecruitmentToolError, type RecruitmentErrorCode } from './errors.ts'
// 与 `recruitment_interview_get` 共用**同一份** `interviews[]` 元素 schema 与**同一个**读回实现
// （`tool-contracts.md` §3.5：`schedule.interview` 与 `get.interviews[]` 同一形状、同一规则）。
// 复用而不是各写一份，是为了让两个工具的形状不可能漂移。
import { INTERVIEW_VALUE_SCHEMA, readInterviewValue } from './interview-get.ts'
// R4 三维标签：`provenance` 必须按**这次调用**的租户事实算，不许写死 `LIVE`
// （`contracts/tenant-provenance.md`；判定式与 candidate_get / job_create 共用同一份实现）。
import { buildThreeAxisLabels } from './candidate-get.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

const TOOL_NAME = 'recruitment_interview_schedule'
const CONTRACT_VERSION = '1.0.0'

/** 落库的 `interview.stage_code`：只能取自 `stage_catalog`（G-4 / D-22）。 */
const INTERVIEW_STAGE_CODE = 'S8'
const DEFAULT_SLOT_CODE = 'DEFAULT'
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const ONLY_DELIVERY_MODE = 'VIDEO'

/** 幂等 STORE 的键前缀（`scheduling-rules.md` §9 SC-K1）。 */
const STORE_KEY_PREFIX = 'interview_schedule:'
/** 补绑任务键前缀（`scheduling-rules.md` §7.3）。 */
const BIND_TASK_KEY_PREFIX = 'bind_meeting:'
const STORE_TASK_TYPE = 'INTERVIEW_SCHEDULE'
const BIND_TASK_TYPE = 'INTERVIEW_MEETING_BIND'
const SCHEDULING_POLICY_KEY = 'interview_scheduling_policy'

const MIN_ROUND_NO = 1
const MAX_ROUND_NO = 20
const MIN_DURATION_MINUTES = 15
const MAX_DURATION_MINUTES = 480

/**
 * 事务内保存点：`uq_business_task_idempotency` 撞键（并发同 key）时回到这里，
 * 让"重读 STORE → 重放"能在同一个事务里跑完（PG 里一条语句失败后事务即进入 aborted，
 * 不回滚到保存点就无法再查询；不回滚到**命令开头**则本次已写的行会留在库里，
 * 那时返回 `replayed=true, changes.created=[]` 就是撒谎）。
 */
const STORE_SAVEPOINT = 'interview_schedule_command'

/** 入参时间必须带偏移（`tool-contracts.md` §1.1 第 9 条）。 */
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
/** `ck_interview_slot_code`（`0001 L964`）。 */
const SLOT_CODE_RE = /^[A-Z][A-Z0-9_]{1,20}$/
/** `ck_interviewer_role`（`0001 L982`）。 */
const ROLE_IN_INTERVIEW_RE = /^[A-Z][A-Z0-9_]{1,30}$/
/** 幂等键字符集（`tool-contracts.md` §3.2）。 */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]+$/

/** 顶层声明的**标量**参数（交给 `parseContractArgs` 校验）。 */
const SCALAR_PARAMS: ParamMap = {
  intent: {
    kind: 'string',
    values: ['CREATE'],
    description:
      'Action. This slice implements CREATE only (default). RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER '
      + 'are NOT implemented and are rejected with INVALID_ARGS(OUT_OF_RANGE).',
  },
  idempotency_key: {
    kind: 'string',
    required: true,
    maxLength: 200,
    description:
      'Caller-generated idempotency key, 1..200 chars from [A-Za-z0-9_.:-]. '
      + 'Same key + same arguments replays the first result (replayed=true, changes empty); '
      + 'same key + different arguments fails with INVALID_ARGS(IDEMPOTENCY_KEY_REUSED).',
  },
  application_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Application id (UUID text form). The interview belongs to this application (INV-1).',
  },
  round_no: {
    kind: 'integer',
    required: true,
    // 上下界**不**放在这里：`args.ts` 会给 OUT_OF_RANGE，而 `scheduling-rules.md` §2.3 明确用
    // ROUND_OUT_OF_RANGE（§3.7 的 OUT_OF_RANGE 是同一格的另一种写法），所以这里自己判。
    description: 'Interview round number, integer 1..20 (INV-4). Out of range fails with ROUND_OUT_OF_RANGE.',
  },
  slot_code: {
    kind: 'string',
    maxLength: 21,
    description:
      "Parallel session code within the round, default 'DEFAULT', must match ^[A-Z][A-Z0-9_]{1,20}$. "
      + '(application_id, round_no, slot_code) is unique, including CANCELLED rows.',
  },
  scheduled_start_at: {
    kind: 'string',
    required: true,
    maxLength: 40,
    description:
      'Absolute start instant as ISO-8601 WITH an offset (e.g. 2026-11-20T10:00:00+08:00). '
      + 'Must be later than now; a bare local time is rejected (TIMESTAMP_WITHOUT_OFFSET).',
  },
  duration_minutes: {
    kind: 'integer',
    required: true,
    description:
      'Duration in minutes, integer 15..480 (required, never derived from an end time). '
      + 'scheduled_end_at is computed as start + duration and is always written (contract stricter than the table).',
  },
  timezone: {
    kind: 'string',
    maxLength: 64,
    description: "IANA time zone used for DISPLAY only (default 'Asia/Shanghai'); it never participates in comparisons.",
  },
  delivery_mode: {
    kind: 'string',
    maxLength: 16,
    description: "Interview form, default and only accepted value in v1.0: 'VIDEO' (no delivery_mode column yet, G-1).",
  },
  interview_template_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description:
      'Optional interview template version (UUID). It must belong to the same job as the application, '
      + 'otherwise INVALID_ARGS(TEMPLATE_JOB_MISMATCH).',
  },
}

/** `interviewers[]` 元素的模型可见 schema（对象数组，`args.ts` 不支持，由本文件手写校验）。 */
const INTERVIEWER_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'One interviewer. actor_id is required (UUID, actor.kind must be HUMAN). '
    + 'role_in_interview defaults to INTERVIEWER (label only), required_scorecard defaults to true, '
    + 'scorecard_due_at is an optional ISO-8601 timestamp WITH an offset. Unknown keys are rejected.',
  properties: {
    actor_id: { type: 'string', description: 'Actor id (UUID text form). Must be a HUMAN actor in this tenant.' },
    role_in_interview: {
      type: 'string',
      description: "Label only (not used for authorization), default 'INTERVIEWER', must match ^[A-Z][A-Z0-9_]{1,30}$.",
    },
    required_scorecard: {
      type: 'boolean',
      description:
        'Whether this interviewer blocks Evaluation Ready and whether this row occupies the slot for conflict '
        + 'detection (default true; required_scorecard=false rows do NOT occupy, SC-C8).',
    },
    scorecard_due_at: {
      type: 'string',
      description: 'Optional reminder instant, ISO-8601 WITH an offset (interviewer.scorecard_due_at).',
    },
  },
  required: ['actor_id'],
  additionalProperties: false,
}

/** `meeting` 对象的模型可见 schema。 */
const MEETING_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'Meeting to REGISTER (this tool never creates calendars or sends invitations, H-2). Omit it entirely to leave '
    + 'the interview UNBOUND: scheduling still succeeds and an INTERVIEW_MEETING_BIND task is created (H-3). '
    + 'At least one of calendar_event_id / external_meeting_id is required; unknown keys are rejected.',
  properties: {
    provider: { type: 'string', description: "Platform id, 1..64 chars (e.g. 'FEISHU'). Required when meeting is given." },
    account_scope: { type: 'string', description: 'Optional tenant-local account discriminator, 1..200 chars.' },
    calendar_event_id: {
      type: 'string',
      description: 'Calendar event id, 1..200 chars. At least one of the two ids is required.',
    },
    external_meeting_id: {
      type: 'string',
      description:
        'Platform meeting id, 1..200 chars. It must not be actively bound to another interview '
        + '(MEETING_ALREADY_BOUND); an existing unbound meeting row is reused.',
    },
    meeting_role: {
      type: 'string',
      enum: ['PRIMARY', 'CONTINUATION'],
      description:
        "Default 'PRIMARY'. REPLACED / CANCELLED are written by the system on reschedule/cancel and are rejected here.",
    },
  },
  required: ['provider'],
  additionalProperties: false,
}

/** 模型可见的入参 schema（标量部分由 `toParameterSchema` 编译，两个结构化键手工追加）。 */
const PARAMETERS_SCHEMA: Record<string, unknown> = (() => {
  const scalar = toParameterSchema(SCALAR_PARAMS)
  const properties = { ...(scalar.properties as Record<string, unknown>) }
  properties.interviewers = {
    type: 'array',
    description:
      'Interviewers, minItems 1. Each element is { actor_id (UUID, required), role_in_interview?, '
      + 'required_scorecard?, scorecard_due_at? }. An empty array fails with INTERVIEWER_REQUIRED; '
      + 'a duplicated actor_id fails with DUPLICATE_INTERVIEWER.',
    items: INTERVIEWER_INPUT_SCHEMA,
  }
  properties.meeting = MEETING_INPUT_SCHEMA
  return {
    type: 'object',
    properties,
    required: [...(scalar.required as string[]), 'interviewers'],
    additionalProperties: false,
  }
})()

/** `changes.created/updated/unchanged` 的一项。 */
const CHANGES_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    table: {
      type: 'string',
      enum: ['interview', 'interviewer', 'meeting', 'meeting_binding', 'business_task'],
    },
    id: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['table', 'id'],
  additionalProperties: false,
}

const WARNING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      enum: ['MEETING_NOT_BOUND', 'ALREADY_ASSIGNED', 'BINDING_REUSED', 'MEETING_ROLE_DOWNGRADED'],
    },
    message: { type: 'string' },
  },
  required: ['code', 'message'],
  additionalProperties: false,
}

const NEXT_ACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: ['BIND_MEETING'] },
    task_id: { type: 'string' },
    due_at: { type: 'string' },
  },
  required: ['code', 'task_id', 'due_at'],
  additionalProperties: false,
}

/** 输出 schema（只用 DSH 强制子集；没有 `type: 'null'`，没有 type 数组）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string' },
    write: { type: 'boolean' },
    replayed: { type: 'boolean' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    intent: { type: 'string', enum: ['CREATE'] },
    command: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string' },
        args_digest: { type: 'string' },
      },
      required: ['idempotency_key', 'args_digest'],
      additionalProperties: false,
    },
    interview: INTERVIEW_VALUE_SCHEMA,
    changes: {
      type: 'object',
      properties: {
        created: { type: 'array', items: CHANGES_ITEM_SCHEMA },
        updated: { type: 'array', items: CHANGES_ITEM_SCHEMA },
        unchanged: { type: 'array', items: CHANGES_ITEM_SCHEMA },
      },
      required: ['created', 'updated', 'unchanged'],
      additionalProperties: false,
    },
    effects: {
      type: 'object',
      properties: {
        meeting_bound: { type: 'boolean' },
        external_call_made: { type: 'boolean' },
      },
      required: ['meeting_bound', 'external_call_made'],
      additionalProperties: false,
    },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    next_actions: { type: 'array', items: NEXT_ACTION_SCHEMA },
  },
  required: [
    'tool', 'contract_version', 'status', 'write', 'replayed', 'labels', 'intent', 'command',
    'interview', 'changes', 'effects', 'warnings', 'next_actions',
  ],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  类型
// ---------------------------------------------------------------------------

/** 校验后的一个面试官（`tool-contracts.md` §3.3）。 */
export interface ScheduleInterviewerArgs {
  /** `actor.actor_id`（小写 UUID 文本）。 */
  readonly actor_id: string
  /** 仅标签；默认 `INTERVIEWER`。 */
  readonly role_in_interview: string
  /** 是否阻塞 Evaluation Ready，且是否占位（SC-C8）。 */
  readonly required_scorecard: boolean
  /** 可选提醒时刻（ISO-8601 带偏移）。 */
  readonly scorecard_due_at?: string
}

/** 校验后的 `meeting` 对象（`tool-contracts.md` §3.4）。 */
export interface ScheduleMeetingArgs {
  readonly provider: string
  readonly account_scope?: string
  readonly calendar_event_id?: string
  readonly external_meeting_id?: string
  readonly meeting_role: 'PRIMARY' | 'CONTINUATION'
}

/** `parseScheduleArgs` 的返回：**已补默认值**的规范形态（`SPEC.md` §4.2）。 */
export interface ScheduleArgs {
  readonly intent: 'CREATE'
  readonly idempotency_key: string
  readonly application_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly interviewers: readonly ScheduleInterviewerArgs[]
  /** 规范化后的开始时刻（`toISOString()`，即 `Z`）。 */
  readonly scheduled_start_at: string
  /** `scheduled_start_at + duration_minutes`（契约严于库：必须写，S-2）。 */
  readonly scheduled_end_at: string
  /** 毫秒表示（冲突判定与"是否过去"都用它，避免重复解析）。 */
  readonly start_ms: number
  /** 同上。 */
  readonly end_ms: number
  readonly duration_minutes: number
  readonly timezone: string
  readonly delivery_mode: 'VIDEO'
  readonly meeting?: ScheduleMeetingArgs
  readonly interview_template_version_id?: string
  /**
   * `'sha256:' + sha256(canonicalJson(原始入参去掉 idempotency_key))`。
   * **原始**入参 = 调用方给什么算什么，**不补**默认值（`intent`/`slot_code`/`timezone`/`delivery_mode`
   * 和面试官元素的默认值都不进 digest），只有 `idempotency_key` 被剔除（`tool-contracts.md` §4.3）。
   */
  readonly args_digest: string
}

/** `changes.created` 的一项。 */
interface ChangeRow {
  readonly table: 'interview' | 'interviewer' | 'meeting' | 'meeting_binding' | 'business_task'
  readonly id: string
}

/** 一条冲突（`tool-contracts.md` §4.1）。 */
interface Conflict {
  readonly kind: 'INTERVIEWER' | 'CANDIDATE'
  readonly ref_kind: 'INTERVIEW'
  readonly ref_id: string
  readonly actor_id?: string
  readonly candidate_id?: string
  readonly window: { readonly start: string; readonly end: string }
}

/** `interview` 行（只取本工具用到的列）。 */
interface InterviewSlotRow {
  readonly id: string
  readonly status: string
}

/** `application` 行（排期需要的那几列）。 */
interface ApplicationRow {
  readonly id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly lifecycle_status: string
}

/** `actor` 行（判 `kind='HUMAN'`）。 */
interface ActorRow {
  readonly id: string
  readonly kind: string
  readonly display_name: string
}

/** 幂等 STORE 行。 */
interface StoreRow {
  readonly id: string
  readonly business_refs: unknown
}

/** 撞上唯一/外键约束时的 pg 错误形状。 */
interface PgErrorInfo {
  readonly code?: string
  readonly constraint?: string
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/** 抛一条 `INVALID_ARGS`。 */
function fail(reasonCode: string, message: string, detail?: unknown): never {
  throw contractError('INVALID_ARGS', { reason_code: reasonCode, message, detail })
}

/**
 * 抛一条 S8 专有 code（不在 `RecruitmentErrorCode` 的 S6/S7 封闭集里，格式与 `contractError` 相同）。
 * @param code - `CONFLICT_SLOT` / `ALREADY_SCHEDULED` / `MEETING_ALREADY_BOUND` / `VERSION_CONFLICT`。
 * @param parts - `reason_code` / `message` / 可选 `detail`。
 */
function s8Error(
  code: 'CONFLICT_SLOT' | 'ALREADY_SCHEDULED' | 'MEETING_ALREADY_BOUND' | 'VERSION_CONFLICT',
  parts: { readonly reason_code: string; readonly message: string; readonly detail?: unknown },
): RecruitmentToolError {
  const body: Record<string, unknown> = {
    code,
    reason_code: parts.reason_code,
    message: parts.message,
  }
  if (parts.detail !== undefined) body.detail = parts.detail
  // 运行期只需要一个字符串；类型层的封闭集属 S6/S7（`errors.ts`），本文件不改那份文件。
  return new RecruitmentToolError(code as RecruitmentErrorCode, canonicalJson(body))
}

// ---------------------------------------------------------------------------
//  D-79 人机闸门（approval seam）
// ---------------------------------------------------------------------------

/** DSH `ctx.approval.request` 的封闭结果（与 `decision-record.ts` 同一封闭集）。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 本工具 `approve()` 的最终结果：宿主的四个封闭值 + 等待超时哨兵（超时按 `cancelled` 判）。 */
export type ApprovalDecision = ApprovalOutcome | 'timeout'

/**
 * 人工批准等待上限：**120 秒**。
 *
 * 为什么是 120s：人点一次按钮的正常上限远小于它（Web 里真人点 Allow 是秒级）；
 * 再长说明人不在（或窗口已关）。此时**占着事务/连接等人回来**比让调用失败更糟：
 * 超时按 `cancelled` 判 → 回滚 → `FORBIDDEN(APPROVAL_NOT_GRANTED, detail.approval='timeout')`，
 * 一行不写；人要办就重来一次（D-95：人只决策一次，重来是新的决策）。
 * 这只是本工具内的上界兜底；DB 侧 `idle_in_transaction_session_timeout` 由 `db/pool.ts` 另配。
 */
export const APPROVAL_TIMEOUT_MS = 120_000

/**
 * DSH `ctx.approval` 的窄接口（只取 `request`）。
 *
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

/**
 * 让"等宿主批准"与"等 timeoutMs"赛跑。超时返回哨兵；**不等待原 promise**。
 * 原 promise 之后 resolve / reject 都不会影响本次结果（`Promise.race` 已给它挂了
 * handler，不会产生 unhandledRejection）。
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
      toolName: TOOL_NAME,
      reason: 'S8 面试排期是写库动作，需要人工批准（D-79）',
      signal: exec?.signal,
    })
    const raw = await raceApproval(pending, timeoutMs)
    if (raw === 'timeout') {
      // 超时后宿主才点的 Allow：**不采纳**（工具已返回、事务已回滚，写不了库）；
      // 仍挂空 handler，保证晚到的 resolve/reject 不会变成 unhandledRejection。
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
 * 位置约定（D-79）：参数校验与全部业务校验（A1–A10、冲突）之后、第一行 INSERT 之前。
 * `'timeout'` 与 `cancelled` 同判（`APPROVAL_NOT_GRANTED`，`detail.approval='timeout'`）。
 * @param outcome - `approve()` 的结果。
 * @throws RecruitmentToolError - `FORBIDDEN` + `reason_code`（`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`）。
 */
export function requireApprovalGranted(outcome: ApprovalDecision): void {
  if (outcome === 'allowed-once') return
  const unavailable = outcome === 'unavailable'
  const timedOut = outcome === 'timeout'
  throw new RecruitmentToolError('FORBIDDEN', canonicalJson({
    code: 'FORBIDDEN',
    reason_code: unavailable ? 'APPROVAL_UNAVAILABLE' : 'APPROVAL_NOT_GRANTED',
    message: unavailable
      ? '没有可用的批准通道（headless 无 answerer）：排期写库被拒绝（D-79，fail closed）'
      : timedOut
        ? `等待人工批准超时（${APPROVAL_TIMEOUT_MS / 1000} 秒）：排期写库被拒绝（D-79，fail closed）`
        : '人工没有批准这次排期写库（D-79）',
    detail: { approval: outcome, tool: TOOL_NAME },
  }))
}

// ---- D-101 技术债（2026-11-14）----
// 两阶段「只读校验 → 关连接 → 问人 → 写事务重校验」是"人等待不占连接 + 先判定再问人 +
// 重放不问人"三者同时成立的正解，但代价是双倍读 + TOCTOU。**现在不做**。
// 触发条件（写死）：出现"并发写导致人批准后仍被 VERSION_CONFLICT 拒"的实测案例，
// 或 Web UI 开始高频驱动本工具时，必须改成两阶段。

/** 从 pg 错误里取 `code` / `constraint`（不是对象就返回空）。 */
function pgInfo(error: unknown): PgErrorInfo {
  if (typeof error !== 'object' || error === null) return {}
  const record = error as { code?: unknown; constraint?: unknown }
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    constraint: typeof record.constraint === 'string' ? record.constraint : undefined,
  }
}

/** 是不是某条唯一约束的 23505？未给约束名时只看 SQLSTATE。 */
function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgInfo(error)
  if (info.code !== '23505') return false
  return constraint === undefined || info.constraint === constraint
}

/** 是不是某条外键约束的 23503？ */
function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const info = pgInfo(error)
  if (info.code !== '23503') return false
  return constraint === undefined || info.constraint === constraint
}

/** 一个普通对象（不是 null、不是数组）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `timestamptz` 可能是 pg 给的 `Date`，也可能是测试造的字符串 → 统一 ISO（`Z`）。 */
function toIso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** 可空时间列 → ISO 或 `undefined`（输出里**省略键**，不写 null）。 */
function isoOrUndefined(value: string | Date | null | undefined): string | undefined {
  return value === null || value === undefined ? undefined : toIso(value)
}

/** 把 `undefined` 从对象里删掉，保证输出值没有 `null`（也不留 `undefined` 键）。 */
function compact<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/**
 * 校验"带偏移的绝对时刻"（`tool-contracts.md` §1.1 第 9 条）。
 * @param value - 入参原值。
 * @param path - 参数路径（用于错误 detail）。
 * @returns 毫秒时间戳。
 */
function parseIsoWithOffset(value: unknown, path: string): number {
  if (typeof value !== 'string') fail('TYPE_MISMATCH', `"${path}" 必须是字符串`, { path })
  if (!ISO_WITH_OFFSET_RE.test(value)) {
    fail(
      'TIMESTAMP_WITHOUT_OFFSET',
      `"${path}" 必须是带时区偏移的 ISO-8601 时间（如 2026-11-20T10:00:00+08:00）`,
      { path, value },
    )
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) {
    fail('TIMESTAMP_WITHOUT_OFFSET', `"${path}" 不是可解析的时间`, { path, value })
  }
  return ms
}

/** 非空字符串 ≤ `max` 长度。 */
function requireText(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') fail('TYPE_MISMATCH', `"${path}" 必须是字符串`, { path })
  const text = value.trim()
  if (text === '') fail('TYPE_MISMATCH', `"${path}" 必须是非空字符串`, { path })
  if (value.length > max) fail('OUT_OF_RANGE', `"${path}" 不能超过 ${max} 个字符`, { path, length: value.length })
  return value
}

/**
 * 结构化键（`interviewers` / `meeting`）的未知键检测。`args.ts` 不认识对象数组与对象，
 * 所以这两处按 `additionalProperties:false` 的同一口径手写（`tool-contracts.md` §1.1 第 2 条）。
 * @param input - 对象。
 * @param allowed - 允许的键。
 * @param path - 参数路径。
 */
function assertNoUnknownKeys(input: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key)).sort()
  if (unknown.length === 0) return
  const first = unknown[0] as string
  const reason = first === 'tenant_id' || first === 'actor_id' ? 'TENANT_OR_ACTOR_NOT_ALLOWED' : 'UNKNOWN_PARAM'
  fail(reason, `"${path}.${first}" 不是已声明的参数（allowed: ${path}.{${allowed.join(', ')}}）`, {
    path: `${path}.${first}`,
    unknown,
    allowed,
  })
}

// ---------------------------------------------------------------------------
//  入参校验（纯函数，`SPEC.md` §4.1 / §4.2）
// ---------------------------------------------------------------------------

/** `interviewers[]` 元素允许的键。 */
const INTERVIEWER_KEYS: readonly string[] = [
  'actor_id', 'role_in_interview', 'required_scorecard', 'scorecard_due_at',
]
/** `meeting` 对象允许的键。 */
const MEETING_KEYS: readonly string[] = [
  'provider', 'account_scope', 'calendar_event_id', 'external_meeting_id', 'meeting_role',
]
/** 顶层允许的键（标量声明 + 两个结构化键）。 */
const TOP_LEVEL_KEYS: readonly string[] = [
  ...Object.keys(SCALAR_PARAMS), 'interviewers', 'meeting',
]

/**
 * 手写校验 `interviewers`（`SPEC.md` §4.1）：非空、无重复 actor、默认值补齐。
 * @param value - 入参原值。
 * @returns 规范化后的面试官数组。
 */
function parseInterviewers(value: unknown): readonly ScheduleInterviewerArgs[] {
  if (value === undefined) fail('MISSING_REQUIRED', '缺少必填参数 "interviewers"', { path: 'interviewers' })
  if (!Array.isArray(value)) fail('TYPE_MISMATCH', '"interviewers" 必须是对象数组', { path: 'interviewers' })
  if (value.length === 0) {
    fail('INTERVIEWER_REQUIRED', '至少需要一名面试官（A4）', { path: 'interviewers' })
  }
  const interviewers: ScheduleInterviewerArgs[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const path = `interviewers[${index}]`
    if (!isPlainObject(raw)) fail('TYPE_MISMATCH', `"${path}" 必须是对象`, { path })
    assertNoUnknownKeys(raw, INTERVIEWER_KEYS, path)

    if (raw.actor_id === undefined) fail('MISSING_REQUIRED', `"${path}.actor_id" 必填`, { path: `${path}.actor_id` })
    if (typeof raw.actor_id !== 'string') fail('TYPE_MISMATCH', `"${path}.actor_id" 必须是字符串`, { path })
    if (!isUuid(raw.actor_id)) {
      fail('ID_NOT_UUID', `"${path}.actor_id" 必须是 UUID 文本形式`, { path: `${path}.actor_id` })
    }
    const actorId = raw.actor_id.toLowerCase()
    if (seen.has(actorId)) {
      fail('DUPLICATE_INTERVIEWER', `面试官 ${actorId} 在 interviewers 里出现了两次`, { actor_id: actorId })
    }
    seen.add(actorId)

    const roleValue = raw.role_in_interview === undefined ? 'INTERVIEWER' : raw.role_in_interview
    if (typeof roleValue !== 'string') {
      fail('TYPE_MISMATCH', `"${path}.role_in_interview" 必须是字符串`, { path: `${path}.role_in_interview` })
    }
    if (!ROLE_IN_INTERVIEW_RE.test(roleValue)) {
      // 契约 §3.3 只给了正则，没给独立 reason_code；用封闭集里最接近的 OUT_OF_RANGE。
      fail('OUT_OF_RANGE', `"${path}.role_in_interview" 必须匹配 ^[A-Z][A-Z0-9_]{1,30}$`, {
        path: `${path}.role_in_interview`,
        value: roleValue,
      })
    }

    const requiredValue = raw.required_scorecard === undefined ? true : raw.required_scorecard
    if (typeof requiredValue !== 'boolean') {
      fail('TYPE_MISMATCH', `"${path}.required_scorecard" 必须是布尔值`, { path: `${path}.required_scorecard` })
    }

    const dueAt = raw.scorecard_due_at === undefined
      ? undefined
      : new Date(parseIsoWithOffset(raw.scorecard_due_at, `${path}.scorecard_due_at`)).toISOString()

    interviewers.push(compact({
      actor_id: actorId,
      role_in_interview: roleValue,
      required_scorecard: requiredValue,
      scorecard_due_at: dueAt,
    }) as unknown as ScheduleInterviewerArgs)
  }
  return interviewers
}

/**
 * 手写校验 `meeting`（`SPEC.md` §4.1 / `tool-contracts.md` §3.4）。
 * @param value - 入参原值。
 * @returns 规范化后的 meeting 对象。
 */
function parseMeeting(value: unknown): ScheduleMeetingArgs {
  if (!isPlainObject(value)) fail('TYPE_MISMATCH', '"meeting" 必须是对象', { path: 'meeting' })
  assertNoUnknownKeys(value, MEETING_KEYS, 'meeting')

  if (value.provider === undefined) fail('MISSING_REQUIRED', '缺少必填参数 "meeting.provider"', { path: 'meeting.provider' })
  const provider = requireText(value.provider, 'meeting.provider', 64)
  const accountScope = value.account_scope === undefined
    ? undefined
    : requireText(value.account_scope, 'meeting.account_scope', 200)
  const calendarEventId = value.calendar_event_id === undefined
    ? undefined
    : requireText(value.calendar_event_id, 'meeting.calendar_event_id', 200)
  const externalMeetingId = value.external_meeting_id === undefined
    ? undefined
    : requireText(value.external_meeting_id, 'meeting.external_meeting_id', 200)
  if (calendarEventId === undefined && externalMeetingId === undefined) {
    fail(
      'MEETING_IDENTITY_REQUIRED',
      'meeting 里 calendar_event_id 与 external_meeting_id 至少要给一个（对齐 ck_meeting_identity）',
      { path: 'meeting' },
    )
  }

  const roleValue = value.meeting_role === undefined ? 'PRIMARY' : value.meeting_role
  if (typeof roleValue !== 'string') {
    fail('TYPE_MISMATCH', '"meeting.meeting_role" 必须是字符串', { path: 'meeting.meeting_role' })
  }
  if (roleValue !== 'PRIMARY' && roleValue !== 'CONTINUATION') {
    fail(
      'MEETING_ROLE_NOT_ALLOWED',
      `meeting_role 只接受 PRIMARY / CONTINUATION；'${roleValue}' 由系统在改期/取消时写（或不是合法值）`,
      { meeting_role: roleValue },
    )
  }

  return compact({
    provider,
    account_scope: accountScope,
    calendar_event_id: calendarEventId,
    external_meeting_id: externalMeetingId,
    meeting_role: roleValue,
  }) as unknown as ScheduleMeetingArgs
}

/**
 * 形状校验（**不含**"时间是否已过去"）。`scheduleInTransaction` 用它先过形状，
 * 再查幂等 STORE，最后才判时点（`SPEC.md` §4.2：重放不能被"时间已过"影响）。
 * @param raw - 模型给的 arguments。
 * @returns 规范化后的 `ScheduleArgs`。
 */
function parseScheduleShape(raw: unknown): ScheduleArgs {
  if (!isPlainObject(raw)) {
    // 交给 args.ts 产出与其它工具一致的 `arguments must be a JSON object`。
    parseContractArgs(SCALAR_PARAMS, raw)
    fail('TYPE_MISMATCH', 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const input = raw as Record<string, unknown>

  // 1. 未知键（含 tenant_id / actor_id / force / allow_conflict / skip_conflict_check /
  //    status / record_version / reason）：声明键 = 标量声明 + interviewers + meeting。
  const unknown = Object.keys(input).filter((key) => !TOP_LEVEL_KEYS.includes(key)).sort()
  if (unknown.length > 0) {
    const first = unknown[0] as string
    const reason = first === 'tenant_id' || first === 'actor_id' ? 'TENANT_OR_ACTOR_NOT_ALLOWED' : 'UNKNOWN_PARAM'
    fail(reason, `未知参数 "${first}"（allowed: ${TOP_LEVEL_KEYS.join(', ')}）`, {
      param: first,
      unknown,
      allowed: [...TOP_LEVEL_KEYS],
    })
  }

  // 2. 标量参数交给 args.ts（两份声明合并后的未知键检测已在上面做完）。
  const scalarInput: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'interviewers' && key !== 'meeting') scalarInput[key] = value
  }
  const scalars = parseContractArgs(SCALAR_PARAMS, scalarInput)

  const intent = (scalars.intent as string | undefined) ?? 'CREATE'
  const idempotencyKey = scalars.idempotency_key as string
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    // 契约 §3.7 没有"键字符非法"的独立 reason_code，用封闭集里的 OUT_OF_RANGE。
    fail(
      'OUT_OF_RANGE',
      'idempotency_key 只能包含 [A-Za-z0-9_.:-]',
      { path: 'idempotency_key', value: idempotencyKey },
    )
  }

  const applicationId = (scalars.application_id as string).toLowerCase()
  const roundNo = scalars.round_no as number
  if (!Number.isInteger(roundNo) || roundNo < MIN_ROUND_NO || roundNo > MAX_ROUND_NO) {
    // `scheduling-rules.md` §2.3 的 A2 行：越界用 ROUND_OUT_OF_RANGE。
    fail(
      'ROUND_OUT_OF_RANGE',
      `round_no 必须是 ${MIN_ROUND_NO}..${MAX_ROUND_NO} 的整数`,
      { path: 'round_no', value: roundNo },
    )
  }

  const slotCode = (scalars.slot_code as string | undefined) ?? DEFAULT_SLOT_CODE
  if (!SLOT_CODE_RE.test(slotCode)) {
    fail('SLOT_CODE_INVALID', `slot_code 必须匹配 ^[A-Z][A-Z0-9_]{1,20}$（收到 "${slotCode}"）`, {
      path: 'slot_code',
      value: slotCode,
    })
  }

  const startMs = parseIsoWithOffset(scalars.scheduled_start_at, 'scheduled_start_at')
  const duration = scalars.duration_minutes as number
  if (!Number.isInteger(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    // `scheduling-rules.md` §2.3 明确 A5 用 DURATION_OUT_OF_RANGE（§3.7 的 OUT_OF_RANGE 是同一格的另一种写法）。
    fail(
      'DURATION_OUT_OF_RANGE',
      `duration_minutes 必须是 ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES} 的整数`,
      { path: 'duration_minutes', value: duration },
    )
  }
  const endMs = startMs + duration * 60_000

  const timezone = (scalars.timezone as string | undefined) ?? DEFAULT_TIMEZONE
  const deliveryMode = (scalars.delivery_mode as string | undefined) ?? ONLY_DELIVERY_MODE
  if (deliveryMode !== ONLY_DELIVERY_MODE) {
    fail(
      'UNSUPPORTED_DELIVERY_MODE',
      `v1.0 只接受 delivery_mode=VIDEO（收到 "${deliveryMode}"；interview 表没有形式列，G-1）`,
      { delivery_mode: deliveryMode },
    )
  }

  const interviewers = parseInterviewers(input.interviewers)
  const meeting = input.meeting === undefined ? undefined : parseMeeting(input.meeting)
  const templateId = scalars.interview_template_version_id === undefined
    ? undefined
    : (scalars.interview_template_version_id as string).toLowerCase()

  // 3. args_digest：**原始入参**去掉 idempotency_key（不补默认值），字典序规范化。
  const digestInput: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'idempotency_key') digestInput[key] = value
  }

  return compact({
    intent: intent as 'CREATE',
    idempotency_key: idempotencyKey,
    application_id: applicationId,
    round_no: roundNo,
    slot_code: slotCode,
    interviewers,
    scheduled_start_at: new Date(startMs).toISOString(),
    scheduled_end_at: new Date(endMs).toISOString(),
    start_ms: startMs,
    end_ms: endMs,
    duration_minutes: duration,
    timezone,
    delivery_mode: ONLY_DELIVERY_MODE,
    meeting,
    interview_template_version_id: templateId,
    args_digest: `sha256:${digestOf(digestInput)}`,
  }) as unknown as ScheduleArgs
}

/**
 * 纯函数：**只做形状/格式校验**（`SPEC.md` §4.2）。
 *
 * 明确**不**在这里判 `START_IN_PAST`：`SPEC.md` §4.2 要求"先查幂等 STORE，再判时点"，
 * 否则同一 key 同参的重放会因为"那场面试已经到点/过去了"被误判成 400。
 * 时点校验在 `scheduleInTransaction` 里、幂等命中判定之后抛（见该函数第 2 步）。
 * `_nowMs` 只为对齐 `SPEC.md` §4.2 的导出签名而保留，**不参与**任何判断。
 *
 * `args_digest` 只覆盖**原始入参去掉 idempotency_key**——默认值（`intent` / `slot_code` /
 * `timezone` / `delivery_mode` / 面试官的 `role_in_interview`+`required_scorecard`）一律不进 digest，
 * 所以"省略默认值"和"显式写默认值"会被当成两次不同请求（契约 §4.3 的逐字要求：digest 的对象是 args 本身）。
 * @param raw - 模型给的 arguments。
 * @param _nowMs - 服务端当前时刻（毫秒；保留签名，形状校验不需要它）。
 * @returns 规范化后的 `ScheduleArgs`。
 */
export function parseScheduleArgs(raw: unknown, _nowMs?: number): ScheduleArgs {
  return parseScheduleShape(raw)
}

// ---------------------------------------------------------------------------
//  事务内流程（`SPEC.md` §4.3）
// ---------------------------------------------------------------------------

/** 读幂等 STORE（`business_task.idempotency_key = 'interview_schedule:' || K`）。 */
async function loadStore(
  client: DatabaseClient,
  tenantId: string,
  idempotencyKey: string,
): Promise<StoreRow | null> {
  const { rows } = await client.query<StoreRow>(
    `select id, business_refs
       from recruitment.business_task
      where tenant_id = $1 and idempotency_key = $2`,
    [tenantId, `${STORE_KEY_PREFIX}${idempotencyKey}`],
  )
  return rows[0] ?? null
}

/** STORE 行 `business_refs` 里的 `args_digest`。 */
function storeDigest(store: StoreRow): string | null {
  const refs = Array.isArray(store.business_refs) ? store.business_refs : []
  for (const ref of refs) {
    if (isPlainObject(ref) && typeof ref.args_digest === 'string') return ref.args_digest
  }
  return null
}

/** STORE 行指向的 interview id（优先 `{kind:'INTERVIEW'}`，退回 `result_interview_id`）。 */
function storeInterviewId(store: StoreRow): string | null {
  const refs = Array.isArray(store.business_refs) ? store.business_refs : []
  for (const ref of refs) {
    if (isPlainObject(ref) && ref.kind === 'INTERVIEW' && typeof ref.id === 'string') return ref.id
  }
  for (const ref of refs) {
    if (isPlainObject(ref) && typeof ref.result_interview_id === 'string') return ref.result_interview_id
  }
  return null
}

/**
 * 读回一场面试：直接复用 `interview-get.ts` 的 `readInterviewValue`（`SPEC.md` §3.2 的运行时签名）。
 * 返回值的形状就是 `INTERVIEW_VALUE_SCHEMA`，也就是 `get.interviews[]` 的元素（契约 §3.5「同一形状」）。
 * @param client - 事务内客户端（写事务即可，读回只发 SELECT）。
 * @param tenantId - 租户（只来自配置）。
 * @param interviewId - 刚 `INSERT ... RETURNING id` 拿到的 id。
 * @param asOfIso - 本次判定的基准时刻。
 * @returns `interviews[]` 元素。
 */
async function readInterviewBack(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  asOfIso: string,
): Promise<Record<string, unknown>> {
  return await readInterviewValue(client, tenantId, interviewId, asOfIso) as unknown as Record<string, unknown>
}

/** 从读回的 `interview` 里取 `meeting_binding`（B 的形状，防御性读取）。 */
function meetingBindingOf(interview: Record<string, unknown>): Record<string, unknown> | null {
  const binding = interview.meeting_binding
  return isPlainObject(binding) ? binding : null
}

/** 本次没有绑定任何会议时的告警（H-3：排定照常成立）。 */
function meetingNotBoundWarning(): { readonly code: string; readonly message: string } {
  return {
    code: 'MEETING_NOT_BOUND',
    message: '该场面试已排定，但还没有绑定任何会议（S9 会因此取不到材料）；已落补绑任务',
  }
}

/** 重放：返回首次结果（`changes` 三数组全空，`interview` 从库重新读）。 */
async function replayFromStore(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  store: StoreRow,
  args: ScheduleArgs,
  asOfIso: string,
): Promise<Record<string, unknown>> {
  const storedDigest = storeDigest(store)
  const interviewId = storeInterviewId(store)
  if (storedDigest === null || interviewId === null) {
    fail(
      'IDEMPOTENCY_KEY_REUSED',
      `幂等键 "${args.idempotency_key}" 已被另一条无法解析的命令占用`,
      { idempotency_key: args.idempotency_key, store_task_id: store.id },
    )
  }
  if (storedDigest !== args.args_digest) {
    fail(
      'IDEMPOTENCY_KEY_REUSED',
      `幂等键 "${args.idempotency_key}" 已用于另一组参数（digest 不一致）`,
      {
        idempotency_key: args.idempotency_key,
        first_args_digest: storedDigest,
        this_args_digest: args.args_digest,
        first_interview_id: interviewId,
      },
    )
  }

  const interview = await readInterviewBack(client, config.tenant_id, interviewId, asOfIso)
  const binding = meetingBindingOf(interview)
  const warnings: { code: string; message: string }[] = []
  if (binding !== null && binding.state === 'UNBOUND') warnings.push(meetingNotBoundWarning())

  // 重放读的是同一租户的既有行：标签按租户事实重算（不缓、不写死）。
  const labels = await buildThreeAxisLabels(client, config.tenant_id)

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    write: true,
    replayed: true,
    labels,
    intent: 'CREATE',
    command: { idempotency_key: args.idempotency_key, args_digest: args.args_digest },
    interview,
    changes: { created: [], updated: [], unchanged: [] },
    effects: {
      meeting_bound: binding !== null && typeof binding.count === 'number' && binding.count >= 1,
      external_call_made: false,
    },
    warnings,
    // 重放没有写任何行，所以没有新待办（`next_actions` 只描述本次写出来的东西）。
    next_actions: [],
  }
}

/** 读冲突缓冲 `B`（`business_config(config_key='interview_scheduling_policy').payload.buffer_minutes`）。 */
async function readBufferMinutes(client: DatabaseClient, tenantId: string): Promise<number> {
  const { rows } = await client.query<{ payload: unknown }>(
    `select payload
       from recruitment.business_config
      where tenant_id = $1 and config_key = $2
      order by version_no desc
      limit 1`,
    [tenantId, SCHEDULING_POLICY_KEY],
  )
  const payload = rows[0]?.payload
  if (!isPlainObject(payload)) return 0
  const raw = payload.buffer_minutes
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return 0
  return raw
}

/** 面试官冲突（`scheduling-rules.md` §3.2，`required_scorecard=true` 才占位）。 */
async function findInterviewerConflicts(
  client: DatabaseClient,
  tenantId: string,
  actorIds: readonly string[],
  startIso: string,
  bufferedEndIso: string,
): Promise<readonly Conflict[]> {
  if (actorIds.length === 0) return []
  const { rows } = await client.query<{
    interview_id: string
    actor_id: string
    ew_start: string | Date
    ew_end: string | Date
  }>(
    `with occupied as (
       select i.id as interview_id, r.actor_id,
              min(coalesce(m.actual_start_at, i.scheduled_start_at)) as ew_start,
              max(coalesce(m.actual_end_at, i.scheduled_end_at)) as ew_end
         from recruitment.interview i
         join recruitment.interviewer r
           on r.interview_id = i.id and r.tenant_id = i.tenant_id
         left join recruitment.meeting_binding b
           on b.interview_id = i.id and b.tenant_id = i.tenant_id and b.unbound_at is null
         left join recruitment.meeting m
           on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where i.tenant_id = $1
          and i.status in ('SCHEDULED', 'IN_PROGRESS')
          and r.required_scorecard = true
          and r.actor_id = any($2::uuid[])
        group by i.id, r.actor_id
     )
     select interview_id, actor_id, ew_start, ew_end
       from occupied
      where ew_start < $3::timestamptz
        and $4::timestamptz < ew_end
      order by actor_id, interview_id`,
    [tenantId, actorIds, bufferedEndIso, startIso],
  )
  return rows.map((row) => compact({
    kind: 'INTERVIEWER' as const,
    ref_kind: 'INTERVIEW' as const,
    ref_id: row.interview_id,
    actor_id: row.actor_id,
    window: { start: toIso(row.ew_start), end: toIso(row.ew_end) },
  }) as unknown as Conflict)
}

/** 候选人冲突（跨轮次；不加 buffer，SC-C2）。 */
async function findCandidateConflicts(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  startIso: string,
  endIso: string,
): Promise<readonly Conflict[]> {
  const { rows } = await client.query<{
    interview_id: string
    ew_start: string | Date
    ew_end: string | Date
  }>(
    `with occupied as (
       select i.id as interview_id,
              min(coalesce(m.actual_start_at, i.scheduled_start_at)) as ew_start,
              max(coalesce(m.actual_end_at, i.scheduled_end_at)) as ew_end
         from recruitment.interview i
         join recruitment.application a
           on a.id = i.application_id and a.tenant_id = i.tenant_id
         left join recruitment.meeting_binding b
           on b.interview_id = i.id and b.tenant_id = i.tenant_id and b.unbound_at is null
         left join recruitment.meeting m
           on m.id = b.meeting_id and m.tenant_id = b.tenant_id
        where i.tenant_id = $1
          and i.status in ('SCHEDULED', 'IN_PROGRESS')
          and a.candidate_id = $2
        group by i.id
     )
     select interview_id, ew_start, ew_end
       from occupied
      where ew_start < $3::timestamptz
        and $4::timestamptz < ew_end
      order by interview_id`,
    [tenantId, candidateId, endIso, startIso],
  )
  return rows.map((row) => compact({
    kind: 'CANDIDATE' as const,
    ref_kind: 'INTERVIEW' as const,
    ref_id: row.interview_id,
    candidate_id: candidateId,
    window: { start: toIso(row.ew_start), end: toIso(row.ew_end) },
  }) as unknown as Conflict)
}

/** `conflicts[]` 按 `(kind, ref_id)` 字典序（`tool-contracts.md` §4.1 的排序要求）。 */
function sortConflicts(conflicts: readonly Conflict[]): readonly Conflict[] {
  return [...conflicts].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    if (left.ref_id === right.ref_id) return 0
    return left.ref_id < right.ref_id ? -1 : 1
  })
}

/**
 * 在给定事务里跑一次 `intent=CREATE`。
 *
 * 顺序（`SPEC.md` §4.3，重放优先于时点校验）：
 * 形状 → 幂等 STORE（重放 / 键复用）→ `START_IN_PAST` → 申请 → 模板 → 语义幂等 →
 * 面试官 → 冲突 → 五张表的写入 → 读回。
 *
 * **失败零写入的强口径**（`tool-contracts.md` §5.1 W3/W4）：函数开头建一个保存点，任何抛出都
 * `rollback to savepoint` 后原样再抛。这样即使调用方（集成测试、未来的编排器）把这个函数放进
 * **更大的事务**并吞掉错误，本次已写的 `interview` / `interviewer` / `meeting` / … 也不会残留成脏行。
 * 生产路径 `execute()` 里 `withActor` 还会整笔 ROLLBACK，两层互不冲突。
 * @param client - 已有事务的客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param config - 已解析的配置（tenant/actor 只从这里来）。
 * @param rawArgs - 模型给的 arguments。
 * @param nowMs - 服务端当前时刻（毫秒；测试可注入）。
 * @param approve - D-79 的人工批准通道；**缺省 = `unavailable` = 一律拒绝**（fail closed）。
 *   位置：参数/业务校验（A1–A10、冲突）全部通过之后、第一行 INSERT 之前；`allowed-once` 才写库；
 *   等待超过 `APPROVAL_TIMEOUT_MS`（120s）返回 `'timeout'` → 拒绝。
 * @returns 契约出参（`tool-contracts.md` §3.5）。
 */
export async function scheduleInTransaction(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  rawArgs: unknown,
  nowMs: number = Date.now(),
  approve?: () => Promise<ApprovalDecision>,
): Promise<Record<string, unknown>> {
  const args = parseScheduleShape(rawArgs)
  const asOfIso = new Date(nowMs).toISOString()

  // 保存点放在所有读写之前，有两个用处：
  //   ① 并发同键撞 `uq_business_task_idempotency` 时退回命令开头再重放；
  //   ② 任何失败在**调用方事务内**撤销本次已写的行（W3/W4，见上面的说明）。
  await client.query(`savepoint ${STORE_SAVEPOINT}`)
  try {
    return await runCreateCommand(client, config, args, nowMs, asOfIso, approve)
  } catch (error) {
    try {
      await client.query(`rollback to savepoint ${STORE_SAVEPOINT}`)
    } catch {
      // 回滚失败会随连接回收；不要用第二个错误盖住第一个（与 `withActor` 同一做法）。
    }
    throw error
  }
}

/**
 * `scheduleInTransaction` 的事务体（形状已校验、保存点已建立）。
 * @param client - 事务内客户端。
 * @param config - 已解析的配置。
 * @param args - 已校验的入参。
 * @param nowMs - 服务端当前时刻（毫秒）。
 * @param asOfIso - `nowMs` 的 ISO 形式（读回与错误 detail 用）。
 * @param approve - D-79 的人工批准通道（缺省 = 拒绝写入）。
 * @returns 契约出参。
 */
async function runCreateCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: ScheduleArgs,
  nowMs: number,
  asOfIso: string,
  approve: (() => Promise<ApprovalDecision>) | undefined,
): Promise<Record<string, unknown>> {
  const tenantId = config.tenant_id
  const actorId = config.actor_id

  // 1. 幂等 STORE。
  const store = await loadStore(client, tenantId, args.idempotency_key)
  if (store !== null) return await replayFromStore(client, config, store, args, asOfIso)

  // 2. 时点（重放不受它影响，所以放在 STORE 之后）。
  if (args.start_ms <= nowMs) {
    fail(
      'START_IN_PAST',
      `scheduled_start_at 必须晚于当前时间（收到 ${args.scheduled_start_at}）`,
      { path: 'scheduled_start_at', value: args.scheduled_start_at, now: asOfIso },
    )
  }

  // 3. 申请（同租户，A1）。
  const applicationResult = await client.query<ApplicationRow>(
    `select id, candidate_id, job_id, lifecycle_status
       from recruitment.application
      where id = $1 and tenant_id = $2`,
    [args.application_id, tenantId],
  )
  const application = applicationResult.rows[0]
  if (application === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'APPLICATION_NOT_FOUND',
      message: `该租户下没有申请 ${args.application_id}`,
      detail: { application_id: args.application_id },
    })
  }
  if (application.lifecycle_status !== 'ACTIVE') {
    // 合同没给这个 reason_code（`SPEC.md` §4.3 第 2 步已记为缺口），这里按 A1 的字面要求拒绝。
    fail(
      'APPLICATION_NOT_ACTIVE',
      `申请 ${args.application_id} 的 lifecycle_status=${application.lifecycle_status}，不是 ACTIVE（A1）`,
      { application_id: args.application_id, lifecycle_status: application.lifecycle_status },
    )
  }

  // 3b. 模板必须属于该申请的岗位（A10）。
  if (args.interview_template_version_id !== undefined) {
    const templateResult = await client.query<{ id: string }>(
      `select id
         from recruitment.interview_template_version
        where id = $1 and tenant_id = $2 and job_id = $3`,
      [args.interview_template_version_id, tenantId, application.job_id],
    )
    if (templateResult.rows[0] === undefined) {
      fail(
        'TEMPLATE_JOB_MISMATCH',
        `模板版本 ${args.interview_template_version_id} 不属于该申请的岗位 ${application.job_id}（A10）`,
        {
          interview_template_version_id: args.interview_template_version_id,
          job_id: application.job_id,
        },
      )
    }
  }

  // 4. 语义幂等（§6.4：**任何**状态都算已存在，含 CANCELLED）。
  const slotResult = await client.query<InterviewSlotRow>(
    `select id, status
       from recruitment.interview
      where tenant_id = $1 and application_id = $2 and round_no = $3 and slot_code = $4
      order by created_at
      limit 1`,
    [tenantId, args.application_id, args.round_no, args.slot_code],
  )
  const existingSlot = slotResult.rows[0]
  if (existingSlot !== undefined) {
    throw s8Error('ALREADY_SCHEDULED', {
      reason_code: 'SLOT_OCCUPIED',
      message: `该申请第 ${args.round_no} 轮 ${args.slot_code} 场次已存在（状态 ${existingSlot.status}）`,
      detail: {
        existing_interview_id: existingSlot.id,
        existing_status: existingSlot.status,
        hint: '如需改时间请用 intent=RESCHEDULE',
      },
    })
  }

  // 5. 面试官（A4：同租户存在 + kind='HUMAN'；空集/重复已在形状校验里拒掉）。
  const actorIds = args.interviewers.map((interviewer) => interviewer.actor_id)
  const actorResult = await client.query<ActorRow>(
    `select id, kind, display_name
       from recruitment.actor
      where tenant_id = $1 and id = any($2::uuid[])`,
    [tenantId, actorIds],
  )
  const actors = new Map(actorResult.rows.map((row) => [row.id.toLowerCase(), row]))
  for (const interviewer of args.interviewers) {
    const actor = actors.get(interviewer.actor_id)
    if (actor === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'INTERVIEWER_NOT_FOUND',
        message: `该租户下没有面试官 actor ${interviewer.actor_id}`,
        detail: { actor_id: interviewer.actor_id },
      })
    }
    if (actor.kind !== 'HUMAN') {
      fail(
        'INTERVIEWER_NOT_HUMAN',
        `actor ${interviewer.actor_id} 的 kind=${actor.kind}，Agent / SYSTEM 不能当面试官（A4）`,
        { actor_id: interviewer.actor_id, kind: actor.kind },
      )
    }
  }

  // 6. 冲突（`[start, end+buffer)` 对 `EW(x)`；buffer 只加在面试官一侧）。
  const bufferMinutes = await readBufferMinutes(client, tenantId)
  const bufferedEndIso = new Date(args.end_ms + bufferMinutes * 60_000).toISOString()
  const interviewerConflicts = await findInterviewerConflicts(
    client, tenantId, actorIds, args.scheduled_start_at, bufferedEndIso,
  )
  const candidateConflicts = await findCandidateConflicts(
    client, tenantId, application.candidate_id, args.scheduled_start_at, args.scheduled_end_at,
  )
  const conflicts = sortConflicts([...interviewerConflicts, ...candidateConflicts])
  if (conflicts.length > 0) {
    const interviewerBusy = interviewerConflicts.length > 0
    throw s8Error('CONFLICT_SLOT', {
      reason_code: interviewerBusy ? 'INTERVIEWER_BUSY' : 'CANDIDATE_BUSY',
      message: interviewerBusy
        ? `面试官在 ${args.scheduled_start_at} 起的时段已有另一场面试（buffer=${bufferMinutes} 分钟）`
        : `候选人在 ${args.scheduled_start_at} 起的时段已有另一场面试`,
      detail: {
        slot: { start: args.scheduled_start_at, end: bufferedEndIso },
        conflicts,
      },
    })
  }

  // 6.5. 人机闸门（D-79）：参数校验与全部业务校验（申请/模板/语义幂等/面试官/冲突）都过了，
  //      但还在**第一行 INSERT 之前** —— 没有 `allowed-once` 就一行都不写（fail closed）。
  //      等待超过 120s 按 `cancelled` 判（`detail.approval='timeout'`），见 `APPROVAL_TIMEOUT_MS`。
  // 幂等重放不写库：闸门之前返回、不打扰人（D-95：人只决策一次）
  requireApprovalGranted(approve === undefined ? 'unavailable' : await approve())

  // 7. INSERT interview（显式 stage_code / status / actor：INSERT 不触发 fn_row_guard）。
  const created: ChangeRow[] = []
  let interviewId: string
  try {
    const interviewResult = await client.query<{ id: string; record_version: number }>(
      `insert into recruitment.interview
         (tenant_id, application_id, interview_template_version_id, round_no, slot_code, stage_code,
          status, scheduled_start_at, scheduled_end_at, timezone, status_changed_by_actor_id)
       values ($1, $2, $3, $4, $5, $6, 'SCHEDULED', $7::timestamptz, $8::timestamptz, $9, $10)
       returning id, record_version`,
      [
        tenantId,
        args.application_id,
        args.interview_template_version_id ?? null,
        args.round_no,
        args.slot_code,
        INTERVIEW_STAGE_CODE,
        args.scheduled_start_at,
        args.scheduled_end_at,
        args.timezone,
        actorId,
      ],
    )
    const inserted = interviewResult.rows[0]
    if (inserted === undefined) throw new RecruitmentToolError('READER_FAILED', 'interview insert returned no row')
    interviewId = inserted.id
  } catch (error) {
    if (isUniqueViolation(error, 'uq_interview_slot')) {
      throw s8Error('ALREADY_SCHEDULED', {
        reason_code: 'SLOT_OCCUPIED',
        message: `该申请第 ${args.round_no} 轮 ${args.slot_code} 场次已被占用（并发）`,
        detail: { application_id: args.application_id, round_no: args.round_no, slot_code: args.slot_code },
      })
    }
    if (isForeignKeyViolation(error, 'fk_interview_stage_catalog')) {
      fail(
        'STAGE_CODE_NOT_IN_CATALOG',
        `stage_code=${INTERVIEW_STAGE_CODE} 不在 stage_catalog 里（0006 的外键）`,
        { stage_code: INTERVIEW_STAGE_CODE },
      )
    }
    throw error
  }
  created.push({ table: 'interview', id: interviewId })

  // 8. INSERT interviewer 逐行。
  for (const interviewer of args.interviewers) {
    const interviewerResult = await client.query<{ id: string }>(
      `insert into recruitment.interviewer
         (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)
       returning id`,
      [
        tenantId,
        interviewId,
        interviewer.actor_id,
        interviewer.role_in_interview,
        interviewer.required_scorecard,
        interviewer.scorecard_due_at ?? null,
      ],
    )
    const inserted = interviewerResult.rows[0]
    if (inserted === undefined) throw new RecruitmentToolError('READER_FAILED', 'interviewer insert returned no row')
    created.push({ table: 'interviewer', id: inserted.id })
  }

  // 9. meeting / meeting_binding（只登记，不创建日历、不发邀请）。
  const warnings: { code: string; message: string }[] = []
  let meetingBound = false
  if (args.meeting !== undefined) {
    const meeting = args.meeting
    let meetingId: string | undefined

    // 先按平台 ID 找已有 meeting 行（有则复用，未绑定才行）。
    if (meeting.external_meeting_id !== undefined) {
      const found = await client.query<{ id: string }>(
        `select id
           from recruitment.meeting
          where tenant_id = $1 and provider = $2 and external_meeting_id = $3
          order by created_at
          limit 1`,
        [tenantId, meeting.provider, meeting.external_meeting_id],
      )
      meetingId = found.rows[0]?.id
    } else if (meeting.calendar_event_id !== undefined) {
      const found = await client.query<{ id: string }>(
        `select id
           from recruitment.meeting
          where tenant_id = $1 and provider = $2 and calendar_event_id = $3
          order by created_at desc
          limit 1`,
        [tenantId, meeting.provider, meeting.calendar_event_id],
      )
      meetingId = found.rows[0]?.id
    }

    if (meetingId !== undefined) {
      // 已有 meeting 行：被别的场次 active 绑着 → 拒绝；未绑定 → 复用。
      const binding = await client.query<{ id: string; interview_id: string }>(
        `select id, interview_id
           from recruitment.meeting_binding
          where tenant_id = $1 and meeting_id = $2 and unbound_at is null`,
        [tenantId, meetingId],
      )
      const active = binding.rows[0]
      if (active !== undefined && active.interview_id !== interviewId) {
        throw s8Error('MEETING_ALREADY_BOUND', {
          reason_code: 'BOUND_TO_OTHER_INTERVIEW',
          message: `会议已被另一场面试绑定（interview ${active.interview_id}）`,
          detail: {
            meeting_id: meetingId,
            existing_interview_id: active.interview_id,
            existing_binding_id: active.id,
            this_interview_id: interviewId,
          },
        })
      }
      warnings.push({
        code: 'BINDING_REUSED',
        message: `复用已存在的 meeting 行 ${meetingId}（未绑定），未新建 meeting`,
      })
    } else {
      try {
        const insertedMeeting = await client.query<{ id: string }>(
          `insert into recruitment.meeting
             (tenant_id, provider, account_scope, external_meeting_id, calendar_event_id, meeting_role)
           values ($1, $2, $3, $4, $5, $6)
           returning id`,
          [
            tenantId,
            meeting.provider,
            meeting.account_scope ?? null,
            meeting.external_meeting_id ?? null,
            meeting.calendar_event_id ?? null,
            meeting.meeting_role,
          ],
        )
        const inserted = insertedMeeting.rows[0]
        if (inserted === undefined) throw new RecruitmentToolError('READER_FAILED', 'meeting insert returned no row')
        meetingId = inserted.id
        created.push({ table: 'meeting', id: meetingId })
      } catch (error) {
        if (isUniqueViolation(error, 'uq_meeting_external')) {
          throw s8Error('MEETING_ALREADY_BOUND', {
            reason_code: 'BOUND_TO_OTHER_INTERVIEW',
            message: '该 external_meeting_id 已被占用（并发）',
            detail: {
              provider: meeting.provider,
              external_meeting_id: meeting.external_meeting_id,
              this_interview_id: interviewId,
            },
          })
        }
        throw error
      }
    }

    try {
      const bindingResult = await client.query<{ id: string; bound_at: string | Date }>(
        `insert into recruitment.meeting_binding
           (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
         values ($1, $2, $3, 'SCHEDULED', $4)
         returning id, bound_at`,
        [tenantId, meetingId, interviewId, actorId],
      )
      const inserted = bindingResult.rows[0]
      if (inserted === undefined) throw new RecruitmentToolError('READER_FAILED', 'meeting_binding insert returned no row')
      created.push({ table: 'meeting_binding', id: inserted.id })
      meetingBound = true
    } catch (error) {
      if (isUniqueViolation(error, 'uq_meeting_binding_active')) {
        throw s8Error('MEETING_ALREADY_BOUND', {
          reason_code: 'BOUND_TO_OTHER_INTERVIEW',
          message: '该会议已被另一场面试的 active binding 占用（并发）',
          detail: { meeting_id: meetingId, this_interview_id: interviewId },
        })
      }
      throw error
    }
  } else {
    // 10. 没给会议：排定照常成立（H-3），落补绑任务。
    const bindTaskResult = await client.query<{ id: string; due_at: string | Date }>(
      `insert into recruitment.business_task
         (tenant_id, task_type, business_refs, title, description, priority, created_by_actor_id,
          idempotency_key, status, due_at, status_changed_by_actor_id)
       values ($1, $2, $3::jsonb, $4, $5, 2, $6, $7, 'WAITING_EXTERNAL', $8::timestamptz, $6)
       returning id, due_at`,
      [
        tenantId,
        BIND_TASK_TYPE,
        JSON.stringify([{ kind: 'INTERVIEW', id: interviewId }]),
        `补绑会议：第 ${args.round_no} 轮 ${args.slot_code}`,
        '排期成功但没有会议信息，需要在外部平台建会/取 ID 后补绑（S8 §7.3）',
        actorId,
        `${BIND_TASK_KEY_PREFIX}${interviewId}`,
        args.scheduled_start_at,
      ],
    )
    const bindTask = bindTaskResult.rows[0]
    if (bindTask === undefined) throw new RecruitmentToolError('READER_FAILED', 'bind task insert returned no row')
    created.push({ table: 'business_task', id: bindTask.id })
  }

  // 11. 幂等 STORE（`business_refs` 带 args_digest + result_interview_id）。
  const storeRefs = [
    { kind: 'INTERVIEW', id: interviewId },
    { args_digest: args.args_digest, result_interview_id: interviewId },
  ]
  let storeTaskId: string
  try {
    const storeResult = await client.query<{ id: string }>(
      `insert into recruitment.business_task
         (tenant_id, task_type, business_refs, title, description, priority, created_by_actor_id,
          idempotency_key, status, result_ref, completed_at, status_changed_by_actor_id)
       values ($1, $2, $3::jsonb, $4, $5, 2, $6, $7, 'SUCCEEDED', $8, now(), $6)
       returning id`,
      [
        tenantId,
        STORE_TASK_TYPE,
        JSON.stringify(storeRefs),
        `面试排期：第 ${args.round_no} 轮 ${args.slot_code}`,
        `CREATE interview ${interviewId}（${args.scheduled_start_at}，${args.duration_minutes} 分钟）`,
        actorId,
        `${STORE_KEY_PREFIX}${args.idempotency_key}`,
        interviewId,
      ],
    )
    const inserted = storeResult.rows[0]
    if (inserted === undefined) throw new RecruitmentToolError('READER_FAILED', 'store task insert returned no row')
    storeTaskId = inserted.id
    created.push({ table: 'business_task', id: storeTaskId })
  } catch (error) {
    // 并发同键（SC-K5）：退回命令开头 → 重读 STORE → 重放；本次已写的行一并撤销。
    if (isUniqueViolation(error, 'uq_business_task_idempotency')) {
      await client.query(`rollback to savepoint ${STORE_SAVEPOINT}`)
      const winner = await loadStore(client, tenantId, args.idempotency_key)
      if (winner === null) throw error
      return await replayFromStore(client, config, winner, args, asOfIso)
    }
    throw error
  }

  // 12. 读回（写完立刻可查的自证；输出 `interview` 与 get 同形）。
  const interview = await readInterviewBack(client, tenantId, interviewId, asOfIso)
  if (!meetingBound) warnings.unshift(meetingNotBoundWarning())
  const nextActions: { code: string; task_id: string; due_at: string }[] = []
  if (!meetingBound) {
    const bindTaskRow = created.find((row) => row.table === 'business_task')
    if (bindTaskRow !== undefined) {
      nextActions.push({
        code: 'BIND_MEETING',
        task_id: bindTaskRow.id,
        due_at: args.scheduled_start_at,
      })
    }
  }

  // R4 三维标签：按租户事实算（演示租户 ⇒ FIXTURE），不写死 LIVE。
  const labels = await buildThreeAxisLabels(client, tenantId)

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    write: true,
    replayed: false,
    labels,
    intent: 'CREATE',
    command: { idempotency_key: args.idempotency_key, args_digest: args.args_digest },
    interview,
    changes: { created, updated: [], unchanged: [] },
    effects: { meeting_bound: meetingBound, external_call_made: false },
    warnings,
    next_actions: nextActions,
  }
}

// ---------------------------------------------------------------------------
//  工具定义
// ---------------------------------------------------------------------------

/** 模型可见的一行时间窗口。 */
function windowLine(interview: Record<string, unknown>): string {
  const start = typeof interview.scheduled_start_at === 'string' ? interview.scheduled_start_at : '?'
  const end = typeof interview.scheduled_end_at === 'string' ? interview.scheduled_end_at : null
  return end === null ? start : `${start} → ${end}`
}

/** 模型可见的面试官列表。 */
function interviewersLine(interview: Record<string, unknown>): string {
  const rows = Array.isArray(interview.interviewers) ? interview.interviewers : []
  if (rows.length === 0) return '(none)'
  return rows
    .filter(isPlainObject)
    .map((row) => {
      const name = typeof row.display_name === 'string' ? row.display_name : String(row.actor_id)
      const role = typeof row.role_in_interview === 'string' ? row.role_in_interview : '?'
      const required = row.required_scorecard === true ? 'required' : 'optional'
      return `${name}(${role}, ${required})`
    })
    .join(' · ')
}

/** 排期工具的依赖：库配置保持第一个位置参数，approval 是可选的第二组依赖（D-79）。 */
export interface InterviewScheduleDeps {
  /** DSH `ctx.approval` 的窄接口。**缺省 = 一律拒绝**，不存在"直接写库"的分支（D-79）。 */
  readonly approval?: ApprovalRequester
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
 * 造真实的排期工具（`intent=CREATE` 切片）。
 * @param config - 已解析的数据库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖；`approval` 缺省时写库一律被拒（D-79 fail closed）。
 */
export function createInterviewScheduleTool(
  config: ResolvedDatabaseConfig,
  deps: InterviewScheduleDeps = {},
): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S8 interview scheduling — CREATE slice. Creates one interview session (application + round_no + slot_code), '
      + 'its interviewer rows, and optionally registers an existing meeting + binding in the LOCAL database. '
      + 'It never calls any external system (no calendar creation, no invitations), so labels.connection is always '
      + 'NOT_CONNECTED and effects.external_call_made is always false. labels.provenance is computed from the '
      + 'tenant\'s synthetic marker (FIXTURE unless the tenant is explicitly declared non-synthetic; never '
      + 'hard-coded LIVE) and labels.trigger is always MANUAL. '
      + 'Requires a caller-generated idempotency_key: same key + same arguments replays the first result '
      + '(replayed=true, changes.created empty); same key + different arguments fails with '
      + 'INVALID_ARGS(IDEMPOTENCY_KEY_REUSED). Semantic idempotency is independent of the key: an existing '
      + '(application_id, round_no, slot_code) — any status, including CANCELLED — fails with ALREADY_SCHEDULED. '
      + 'Interviewer and candidate conflicts reject the request with CONFLICT_SLOT and write nothing. '
      + 'Omitting meeting is allowed and honest: the interview is still scheduled, warning MEETING_NOT_BOUND is '
      + 'returned and an INTERVIEW_MEETING_BIND task is created (next_actions BIND_MEETING). '
      + 'Only CREATE is implemented; RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER are later slices and are rejected. '
      + 'D-79 human gate: after every parameter/business check and BEFORE any write it asks the human for approval '
      + '(missing/unavailable answerer => rejected => nothing is written; FORBIDDEN with reason_code). '
      + 'This tool never writes scorecards or decisions.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as Record<string, unknown>
        const interview = isPlainObject(v.interview) ? v.interview : {}
        const labels = isPlainObject(v.labels) ? v.labels : {}
        const changes = isPlainObject(v.changes) ? v.changes : {}
        const created = Array.isArray(changes.created) ? changes.created : []
        const warnings = Array.isArray(v.warnings) ? v.warnings : []
        const nextActions = Array.isArray(v.next_actions) ? v.next_actions : []
        const binding = meetingBindingOf(interview)
        const lines: string[] = [
          `interview ${String(interview.id)} round=${String(interview.round_no)} `
            + `slot=${String(interview.slot_code)} [${String(interview.status)}] `
            + `stage=${String(interview.stage_code)}  ${windowLine(interview)}`,
          `  application=${String(interview.application_id)} candidate=${String(interview.candidate_id)} `
            + `job=${String(interview.job_id)} timezone=${String(interview.timezone)}`,
          `  interviewers: ${interviewersLine(interview)}`,
          `  meeting_binding: ${binding === null ? 'unknown' : String(binding.state)} `
            + `(${binding === null ? 0 : String(binding.count)} active)`,
          `  replayed=${String(v.replayed)}  changes.created=${created.length}  `
            + `labels: ${String(labels.provenance)}/${String(labels.trigger)}/${String(labels.connection)}`,
        ]
        for (const change of created) {
          if (isPlainObject(change)) lines.push(`    + ${String(change.table)} ${String(change.id)}`)
        }
        for (const warning of warnings) {
          if (isPlainObject(warning)) lines.push(`  warning ${String(warning.code)}: ${String(warning.message)}`)
        }
        for (const action of nextActions) {
          if (isPlainObject(action)) {
            lines.push(`  next: ${String(action.code)} task=${String(action.task_id)} due=${String(action.due_at)}`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // D-79：approval 缺省时 `makeApprovalRequest` 恒返回 `unavailable`（= 拒绝写库）。
      const approve = makeApprovalRequest(deps.approval, readExecContext(exec))
      const pool = createPool(config)
      try {
        return await withActor(pool, config.actor_id, async (client) =>
          scheduleInTransaction(client, config, rawArgs, Date.now(), approve))
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 造一个"数据库没配置"的替身：工具照常注册，调用时报 `NOT_CONFIGURED` 并列出缺什么。
 * @param issues - 缺哪些配置。
 */
export function unconfiguredInterviewScheduleTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S8 interview scheduling (CREATE slice). Currently NOT CONFIGURED: the plugin config is missing database '
      + 'settings (or the database password environment variable). Calls return NOT_CONFIGURED.',
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，面试排期不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
