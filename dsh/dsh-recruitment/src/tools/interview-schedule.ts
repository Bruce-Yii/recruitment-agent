// recruitment_interview_schedule —— S8 面试排期（D-62 的**四合一** intent）。
//
// 合同（**不得修改**）：
//   * `contracts/interview/scheduling-rules.md`（§2 A1–A10 判定式、§3 冲突、§4 改期、§6 取消、
//     §8 状态机、§9 幂等）——`SC-*`。
//   * `contracts/interview/tool-contracts.md`（§1 通用、§3 schedule、§4 幂等、§5.1 写工具证明口径）。
//
// 四个 intent（`docs/17` D-62；`tool-contracts.md` §3.1）：
//   * `CREATE`               ∅ → SCHEDULED（新建一场 + 必要时登记会议绑定）；
//   * `RESCHEDULE`           SCHEDULED/RESCHEDULED/CANCELLED → SCHEDULED（**改同一行**，H-1）；
//   * `CANCEL`               SCHEDULED/RESCHEDULED → CANCELLED（已 CANCELLED → 幂等成功、零写入）；
//   * `WITHDRAW_INTERVIEWER` 不改 `interview.status`：`required_scorecard=false` + 内部事件（§4.3）。
//   **没有 `COMPLETE`**：`IN_PROGRESS → POST_INTERVIEW` 等边属 S9（`scheduling-rules.md` §8 末段），
//   本工具不实现、也不接受该取值（enum 之外 → `INVALID_ARGS(OUT_OF_RANGE)`）。
//
// 四个 intent **共用同一条管道**（这正是 D-62 不拆工具的理由，代码里也必须只有一份）：
//   1. 幂等 STORE（`business_task.idempotency_key = 'interview_schedule:' || K`）→ 重放 / 键复用；
//   2. 业务校验（申请 / 面试官 / 状态机 / 乐观并发 / 冲突 / 会议）；
//   3. **人机闸门（D-79）**：全部校验通过后、第一行写之前请求人工批准；approval 缺省 /
//      `rejected` / `cancelled` / `unavailable` → `FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED)`，
//      零写入（fail closed）。**幂等重放不写库，因此在闸门之前返回。**
//      等待人工批准超过 **120 秒** → 按 `cancelled` 判（`detail.approval='timeout'`）并回滚，
//      不占着连接等一个不在的人；超时后宿主晚到的 Allow 不采纳（D-101 两阶段见闸门段注释）。
//   4. 写（`interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `event_inbox`）
//      + 幂等 STORE + 用 `readInterviewValue` 读回（写完立刻可查的自证）。
//
// 审计事件为什么必须**显式**写（`event_inbox`；`scheduling-rules.md` §4.3 / §4.4 / SC-X5）：
//   `fn_row_guard` 只在**状态变化**时自动写事件；"同状态改时间"（`SCHEDULED → SCHEDULED`）零痕迹，
//   而 `interview` 没有 `cancel_reason` 列、`interviewer` 没有 `status` 列 —— 改期理由、取消理由、
//   退出理由都只能落内部事件 `interview.rescheduled` / `interview.cancelled` / `interviewer.withdrawn`。
//   `event_inbox` 因此是**允许写的第 6 张表**（`tool-contracts.md` §0/§1.3/§5.1 W1 已按
//   `scheduling-rules.md` 优先的口径补注：规则合同要求写的事件，形状合同必须给位置）。
//
// 本文件**不**做的事（写进 description，不假装）：
//   * 任何外部调用（H-2）：无 fetch / http / 子进程 / SDK import，`effects.external_call_made` 恒 `false`，
//     `labels.connection` 恒 `NOT_CONNECTED`；
//   * 不写 `scorecard` / `decision`（`SC-I5`），不猜会议（`APP-04`），不猜 intent（§6.4）。
//
// R4 三维标签（`contracts/tenant-provenance.md`）：`provenance` **按租户的合成标记算**，
// 不写死 `LIVE`（演示租户 / 缺正面证据 ⇒ `FIXTURE`）；`trigger` 恒 `MANUAL`；
// `connection` 恒 `NOT_CONNECTED`（本工具不接日历/会议平台）。"这次真的写进了库"**不是**
// `LIVE` 的证据——演示租户的合成数据同样写进了库，那正是 R4 里 "Fixture 冒充 LIVE" 的入口。
//
// 只写 6 张表（`tool-contracts.md` §5.1 W1）：`interview` / `interviewer` / `meeting` /
// `meeting_binding` / `business_task` / `event_inbox`。
//
// 契约错误：`INVALID_ARGS` / `NOT_FOUND` 走 `contractError`（`contract.ts`）；S8 专有的
// `CONFLICT_SLOT` / `ALREADY_SCHEDULED` / `MEETING_ALREADY_BOUND` / `VERSION_CONFLICT` 不在
// `RecruitmentErrorCode` 的 S6/S7 封闭集里（`errors.ts` 不属本泳道写范围），这里以**同一消息格式**
// 构造（`Error: <CODE>: <单行 compact-json>`），运行时行为与 `contractError` 一致。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap, ParamSpec } from './args.ts'
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
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
// 事件名常量来自唯一权威注册表（`src/runtime/event-types.ts`），不在本文件写死字面量。
import { EVENT_TYPES } from '../runtime/event-types.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
// render 口径 helper（O1 残留修复轮）：人读正文只放业务标识 / 短号；完整编号只允许出现在
// 末尾 machine arguments 区（模型要原样复制才能调下游工具），见 render-ref.ts 文件头。
import { machineArgumentLines, shortHash, shortRef } from './render-ref.ts'

const TOOL_NAME = 'recruitment_interview_schedule'
/**
 * 契约版本：`1.1.0`。
 *
 * 为什么从 `1.0.0` 升到 `1.1.0`：四个 intent 的语义与错误码在 `1.0.0` 里**已经**写全（D-62），
 * 本次只是把实现补齐；出参唯一变化是 `changes[].table` 的闭集新增 `event_inbox`
 * （`scheduling-rules.md` §4.4 要求服务层显式写审计事件，而旧闭集没有它的位置）。
 * 按契约 §7「出参增删字段 → bump `1.x.0`」，故为 `1.1.0`。
 */
const CONTRACT_VERSION = '1.1.0'

/** 落库的 `interview.stage_code`：只能取自 `stage_catalog`（G-4 / D-22）。 */
const INTERVIEW_STAGE_CODE = 'S8'
const DEFAULT_SLOT_CODE = 'DEFAULT'
const DEFAULT_TIMEZONE = 'Asia/Shanghai'
const ONLY_DELIVERY_MODE = 'VIDEO'

/** 四个 intent（D-62 / `tool-contracts.md` §3.1）。**没有** `COMPLETE`：面试结束属 S9。 */
const INTENTS = ['CREATE', 'RESCHEDULE', 'CANCEL', 'WITHDRAW_INTERVIEWER'] as const
/** 本工具接受的 `intent` 取值。 */
export type ScheduleIntent = (typeof INTENTS)[number]

/** `RESCHEDULE` 的合法源状态（`scheduling-rules.md` §8 + §6.3 的 CANCELLED 复活边）。 */
const RESCHEDULABLE_STATUSES: readonly string[] = ['SCHEDULED', 'RESCHEDULED', 'CANCELLED']
/** `CANCEL` 的合法源状态（§6.1：`CANCELLABLE = {SCHEDULED, RESCHEDULED}`）。 */
const CANCELLABLE_STATUSES: readonly string[] = ['SCHEDULED', 'RESCHEDULED']

/** 幂等 STORE 的键前缀（`scheduling-rules.md` §9 SC-K1）。 */
const STORE_KEY_PREFIX = 'interview_schedule:'
/** 补绑任务键前缀（`scheduling-rules.md` §7.3）。 */
const BIND_TASK_KEY_PREFIX = 'bind_meeting:'
const STORE_TASK_TYPE = 'INTERVIEW_SCHEDULE'
const BIND_TASK_TYPE = 'INTERVIEW_MEETING_BIND'
const SCHEDULING_POLICY_KEY = 'interview_scheduling_policy'

/** 内部审计事件（`scheduling-rules.md` §4.3 / §4.4 / SC-X5；`event_inbox` 的 provider/trust 契约）。 */
const EVENT_PROVIDER = 'internal'
const EVENT_TRUST_LEVEL = 'INTERNAL'
// 事件名只从注册表取（`src/runtime/event-types.ts`）；机检测试会扫发射点。
const RESCHEDULE_EVENT_TYPE = EVENT_TYPES.INTERVIEW_RESCHEDULED
const CANCEL_EVENT_TYPE = EVENT_TYPES.INTERVIEW_CANCELLED
const WITHDRAW_EVENT_TYPE = EVENT_TYPES.INTERVIEWER_WITHDRAWN
/** `meeting_binding.unbound_reason` 必须非空（`ck_meeting_binding_unbound`，0001 L1039）。 */
const UNBOUND_REASON_RESCHEDULED = 'INTERVIEW_RESCHEDULED'
const UNBOUND_REASON_CANCELLED = 'INTERVIEW_CANCELLED'

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

// ---------------------------------------------------------------------------
//  参数声明（`tool-contracts.md` §3.2：通用 / CREATE / RESCHEDULE / CANCEL / WITHDRAW）
// ---------------------------------------------------------------------------

/** `intent`（四个值，CREATE 缺省；D-62）。 */
const INTENT_PARAM: ParamSpec = {
  kind: 'string',
  values: [...INTENTS],
  description:
    'Action. CREATE (default) creates a session; RESCHEDULE moves the SAME row to a new time; CANCEL cancels '
    + 'SCHEDULED/RESCHEDULED sessions; WITHDRAW_INTERVIEWER only clears that interviewer\'s required_scorecard. '
    + 'There is no COMPLETE intent (post-interview edges belong to S9).',
}

/** `idempotency_key`（四个 intent 都必填）。 */
const IDEMPOTENCY_KEY_PARAM: ParamSpec = {
  kind: 'string',
  required: true,
  maxLength: 200,
  description:
    'Caller-generated idempotency key, 1..200 chars from [A-Za-z0-9_.:-]. '
    + 'Same key + same arguments replays the first result (replayed=true, changes empty); '
    + 'same key + different arguments fails with INVALID_ARGS(IDEMPOTENCY_KEY_REUSED).',
}

const APPLICATION_ID_PARAM: ParamSpec = {
  kind: 'string',
  required: true,
  uuid: true,
  maxLength: 36,
  description: 'Application id (UUID text form). The interview belongs to this application (INV-1).',
}

const ROUND_NO_PARAM: ParamSpec = {
  kind: 'integer',
  required: true,
  // 上下界**不**放在这里：`args.ts` 会给 OUT_OF_RANGE，而 `scheduling-rules.md` §2.3 明确用
  // ROUND_OUT_OF_RANGE（§3.7 的 OUT_OF_RANGE 是同一格的另一种写法），所以这里自己判。
  description: 'Interview round number, integer 1..20 (INV-4). Out of range fails with ROUND_OUT_OF_RANGE.',
}

const SLOT_CODE_PARAM: ParamSpec = {
  kind: 'string',
  maxLength: 21,
  description:
    "Parallel session code within the round, default 'DEFAULT', must match ^[A-Z][A-Z0-9_]{1,20}$. "
    + '(application_id, round_no, slot_code) is unique, including CANCELLED rows.',
}

/** CREATE 的 `scheduled_start_at`（必填）/ RESCHEDULE 的（可选，至少与 duration 给一个）。 */
const SCHEDULED_START_PARAM: ParamSpec = {
  kind: 'string',
  maxLength: 40,
  description:
    'Absolute instant as ISO-8601 WITH an offset (e.g. 2026-11-20T10:00:00+08:00). '
    + 'Must be later than now; a bare local time is rejected (TIMESTAMP_WITHOUT_OFFSET).',
}
const CREATE_START_PARAM: ParamSpec = {
  ...SCHEDULED_START_PARAM,
  required: true,
  description: `${SCHEDULED_START_PARAM.description} Required for CREATE.`,
}
const RESCHEDULE_START_PARAM: ParamSpec = {
  ...SCHEDULED_START_PARAM,
  description: `${SCHEDULED_START_PARAM.description} Optional for RESCHEDULE, but it (or duration_minutes) is required.`,
}

const DURATION_PARAM: ParamSpec = {
  kind: 'integer',
  description:
    'Duration in minutes, integer 15..480. scheduled_end_at is computed as start + duration and is always written '
    + '(contract stricter than the table: never derived from, or left as, an end time).',
}
const CREATE_DURATION_PARAM: ParamSpec = {
  ...DURATION_PARAM,
  required: true,
  description: `${DURATION_PARAM.description} Required for CREATE.`,
}

const TIMEZONE_PARAM: ParamSpec = {
  kind: 'string',
  maxLength: 64,
  description: "IANA time zone used for DISPLAY only (default 'Asia/Shanghai'); it never participates in comparisons.",
}

const DELIVERY_MODE_PARAM: ParamSpec = {
  kind: 'string',
  maxLength: 16,
  description: "Interview form, default and only accepted value in v1.0: 'VIDEO' (no delivery_mode column yet, G-1).",
}

const TEMPLATE_VERSION_PARAM: ParamSpec = {
  kind: 'string',
  uuid: true,
  maxLength: 36,
  description:
    'Optional interview template version (UUID). It must belong to the same job as the application, '
    + 'otherwise INVALID_ARGS(TEMPLATE_JOB_MISMATCH).',
}

const INTERVIEW_ID_PARAM: ParamSpec = {
  kind: 'string',
  required: true,
  uuid: true,
  maxLength: 36,
  description: 'Interview id (UUID text form): the SAME row is moved/cancelled, never a new row (H-1).',
}

/** 乐观并发（D-18 / SC-K6）：`interview.record_version` 的期望值。 */
const EXPECTED_RECORD_VERSION_PARAM: ParamSpec = {
  kind: 'integer',
  required: true,
  description:
    'Optimistic concurrency: the interview.record_version the caller last read (>= 1). '
    + 'A 0-row update fails with VERSION_CONFLICT(STALE_RECORD_VERSION); never reuse an old version on retry.',
}

/** `reason` 由本文件手写校验（`REASON_REQUIRED` 优先于 `args.ts` 的 TYPE_MISMATCH），只进模型 schema。 */
const REASON_PARAM: ParamSpec = {
  kind: 'string',
  maxLength: 500,
  description:
    'Human-readable reason, 1..500 chars. Required for CANCEL / WITHDRAW_INTERVIEWER (SC-X5); optional for '
    + 'RESCHEDULE (it is written into the interview.rescheduled audit event).',
}

const INTERVIEWER_ID_PARAM: ParamSpec = {
  kind: 'string',
  required: true,
  uuid: true,
  maxLength: 36,
  description: 'interviewer row id (UUID) — NOT the actor_id (§3.2 WITHDRAW_INTERVIEWER).',
}

/** 四个 intent 都接受的标量（`intent` + 幂等键）。 */
const COMMON_PARAMS: ParamMap = {
  intent: INTENT_PARAM,
  idempotency_key: IDEMPOTENCY_KEY_PARAM,
}

/** `CREATE` 的标量（`tool-contracts.md` §3.2）。 */
const CREATE_PARAMS: ParamMap = {
  application_id: APPLICATION_ID_PARAM,
  round_no: ROUND_NO_PARAM,
  slot_code: SLOT_CODE_PARAM,
  scheduled_start_at: CREATE_START_PARAM,
  duration_minutes: CREATE_DURATION_PARAM,
  timezone: TIMEZONE_PARAM,
  delivery_mode: DELIVERY_MODE_PARAM,
  interview_template_version_id: TEMPLATE_VERSION_PARAM,
}

/** `RESCHEDULE` 的标量。 */
const RESCHEDULE_PARAMS: ParamMap = {
  interview_id: INTERVIEW_ID_PARAM,
  expected_record_version: EXPECTED_RECORD_VERSION_PARAM,
  scheduled_start_at: RESCHEDULE_START_PARAM,
  duration_minutes: DURATION_PARAM,
}

/** `CANCEL` 的标量。 */
const CANCEL_PARAMS: ParamMap = {
  interview_id: INTERVIEW_ID_PARAM,
  expected_record_version: EXPECTED_RECORD_VERSION_PARAM,
}

/** `WITHDRAW_INTERVIEWER` 的标量。 */
const WITHDRAW_PARAMS: ParamMap = {
  interviewer_id: INTERVIEWER_ID_PARAM,
  expected_record_version: EXPECTED_RECORD_VERSION_PARAM,
}

/** 每个 intent 交给 `parseContractArgs` 的标量声明（`reason` 不在这里：手写判 REASON_REQUIRED）。 */
const INTENT_PARAMS: Readonly<Record<ScheduleIntent, ParamMap>> = {
  CREATE: CREATE_PARAMS,
  RESCHEDULE: RESCHEDULE_PARAMS,
  CANCEL: CANCEL_PARAMS,
  WITHDRAW_INTERVIEWER: WITHDRAW_PARAMS,
}

/** 每个 intent 的结构化键（`args.ts` 不支持对象 / 对象数组，由本文件手写校验）。 */
const INTENT_STRUCTURED_KEYS: Readonly<Record<ScheduleIntent, readonly string[]>> = {
  CREATE: ['interviewers', 'meeting'],
  RESCHEDULE: ['meeting', 'interviewer_additions'],
  CANCEL: [],
  WITHDRAW_INTERVIEWER: [],
}

/** 每个 intent 额外接受、但不进 `args.ts` 的键（`reason` 的 `REASON_REQUIRED` 优先级更高）。 */
const INTENT_EXTRA_KEYS: Readonly<Record<ScheduleIntent, readonly string[]>> = {
  CREATE: [],
  RESCHEDULE: ['reason'],
  CANCEL: ['reason'],
  WITHDRAW_INTERVIEWER: ['reason'],
}

/**
 * 去掉 `required`：模型可见 schema 只把 `idempotency_key` 标成必填 —— JSON Schema 表达不了
 * "按 intent 条件必填"（DSH 子集没有 if/then），各 intent 的必填项由工具自己判
 * （缺失 → `INVALID_ARGS(MISSING_REQUIRED / REASON_REQUIRED)`，比让宿主静默放行更诚实）。
 */
function withoutRequired(map: ParamMap): ParamMap {
  const out: Record<string, ParamSpec> = {}
  for (const [key, spec] of Object.entries(map)) {
    out[key] = spec.required === true ? { ...spec, required: false } : spec
  }
  return out
}

/** 模型可见的标量参数（`intent` 缺省 CREATE；幂等键是唯一硬必填）。 */
const MODEL_SCALAR_PARAMS: ParamMap = {
  intent: INTENT_PARAM,
  idempotency_key: IDEMPOTENCY_KEY_PARAM,
  ...withoutRequired(CREATE_PARAMS),
  ...withoutRequired(RESCHEDULE_PARAMS),
  ...withoutRequired(CANCEL_PARAMS),
  ...withoutRequired(WITHDRAW_PARAMS),
  reason: REASON_PARAM,
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

/** 模型可见的入参 schema（标量由 `toParameterSchema` 编译，结构化键手工追加）。 */
const PARAMETERS_SCHEMA: Record<string, unknown> = (() => {
  const scalar = toParameterSchema(MODEL_SCALAR_PARAMS)
  const properties = { ...(scalar.properties as Record<string, unknown>) }
  properties.interviewers = {
    type: 'array',
    description:
      'CREATE only. Interviewers, minItems 1. Each element is { actor_id (UUID, required), role_in_interview?, '
      + 'required_scorecard?, scorecard_due_at? }. An empty array fails with INTERVIEWER_REQUIRED; '
      + 'a duplicated actor_id fails with DUPLICATE_INTERVIEWER.',
    items: INTERVIEWER_INPUT_SCHEMA,
  }
  properties.interviewer_additions = {
    type: 'array',
    description:
      'RESCHEDULE only. Interviewers to ADD (never remove; removal is WITHDRAW_INTERVIEWER). Elements have the same '
      + 'shape as interviewers[]. actor_ids already on the session are skipped with warning ALREADY_ASSIGNED; '
      + 'a duplicated actor_id in this array fails with DUPLICATE_INTERVIEWER.',
    items: INTERVIEWER_INPUT_SCHEMA,
  }
  properties.meeting = {
    ...MEETING_INPUT_SCHEMA,
    description: `${String(MEETING_INPUT_SCHEMA.description)} For RESCHEDULE it REPLACES the current meeting: `
      + 'the old binding is unbound (unbound_reason) and the old meeting is marked REPLACED (kept as history).',
  }
  return {
    type: 'object',
    properties,
    // 只有幂等键是硬必填：各 intent 的必填项由工具按 intent 自己判（见 withoutRequired 的说明）。
    required: ['idempotency_key'],
    additionalProperties: false,
  }
})()

/** `changes.created/updated/unchanged` 的一项。 */
const CHANGES_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    table: {
      type: 'string',
      // 第 6 项 `event_inbox`：`scheduling-rules.md` §4.3/§4.4/SC-X5 要求服务层显式写的审计事件。
      enum: ['interview', 'interviewer', 'meeting', 'meeting_binding', 'business_task', 'event_inbox'],
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
    intent: { type: 'string', enum: [...INTENTS] },
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

/** 四个 intent 共有的命令字段（`tool-contracts.md` §4.3 的幂等键 + digest）。 */
interface CommandBase {
  readonly idempotency_key: string
  /**
   * `'sha256:' + sha256(canonicalJson(原始入参去掉 idempotency_key))`。
   * **原始**入参 = 调用方给什么算什么，**不补**默认值（`intent`/`slot_code`/`timezone`/`delivery_mode`
   * 和面试官元素的默认值都不进 digest），只有 `idempotency_key` 被剔除（`tool-contracts.md` §4.3）。
   */
  readonly args_digest: string
}

/** `intent=CREATE` 的规范形态（**已补默认值**）。 */
export interface CreateCommand extends CommandBase {
  readonly intent: 'CREATE'
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
}

/** `intent=RESCHEDULE` 的规范形态。 */
export interface RescheduleCommand extends CommandBase {
  readonly intent: 'RESCHEDULE'
  readonly interview_id: string
  readonly expected_record_version: number
  /** 新开始时刻（规范化 ISO）；缺省 = 沿用现有 `scheduled_start_at`。 */
  readonly scheduled_start_at?: string
  readonly start_ms?: number
  /** 新时长；缺省 = 沿用现有 `scheduled_end_at - scheduled_start_at`。 */
  readonly duration_minutes?: number
  /** 换会议（旧 binding 解绑、旧 meeting 标 REPLACED）。 */
  readonly meeting?: ScheduleMeetingArgs
  /** 只增不减；已在该场的人 → `warnings: ALREADY_ASSIGNED`。 */
  readonly interviewer_additions: readonly ScheduleInterviewerArgs[]
  readonly reason?: string
}

/** `intent=CANCEL` 的规范形态。 */
export interface CancelCommand extends CommandBase {
  readonly intent: 'CANCEL'
  readonly interview_id: string
  readonly expected_record_version: number
  readonly reason: string
}

/** `intent=WITHDRAW_INTERVIEWER` 的规范形态。 */
export interface WithdrawInterviewerCommand extends CommandBase {
  readonly intent: 'WITHDRAW_INTERVIEWER'
  readonly interviewer_id: string
  readonly expected_record_version: number
  readonly reason: string
}

/** `parseScheduleArgs` 的返回：按 `intent` 区分的四选一命令。 */
export type ScheduleCommand = CreateCommand | RescheduleCommand | CancelCommand | WithdrawInterviewerCommand

/** 兼容旧名（`intent=CREATE` 的规范形态）。 */
export type ScheduleArgs = CreateCommand

/** `changes` 的收集器（一行真正被写的 `(table, id)`）。 */
interface ChangeRow {
  readonly table: 'interview' | 'interviewer' | 'meeting' | 'meeting_binding' | 'business_task' | 'event_inbox'
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

/** `RESCHEDULE` / `CANCEL` 需要读的 interview 行（`for update`）。 */
interface InterviewCommandRow {
  readonly id: string
  readonly application_id: string
  readonly status: string
  readonly record_version: number
  readonly scheduled_start_at: string | Date | null
  readonly scheduled_end_at: string | Date | null
  readonly round_no: number
  readonly slot_code: string
}

/** `interviewer` + 所属 `interview` 的行（`WITHDRAW_INTERVIEWER` 用）。 */
interface InterviewerCommandRow {
  readonly id: string
  readonly interview_id: string
  readonly actor_id: string
  readonly required_scorecard: boolean
  readonly interview_status: string
  readonly record_version: number
}

/** 一条 active 绑定 + 它的 meeting（`SC-X6` / §4.2 的换绑与解绑都要看 meeting 是否已发生）。 */
interface ActiveBindingRow {
  readonly binding_id: string
  readonly meeting_id: string
  readonly meeting_role: string
  readonly actual_start_at: string | Date | null
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

// ---- D-101 两阶段（2026-11-15 已实现）----
// 「只读校验 → 关连接 → 问人 → 写事务重校验 → 写库」把三件事同时做到了：
//   ① 人等待期间**不占连接**（不再 idle in transaction）；
//   ② 先判定再问人（无效参数/注定失败不打扰人）；
//   ③ 重放与零写入的幂等成功不问人（没有新行可写）。
// 只读阶段的 `prepareSchedule` 由 `withReadOnly`（`begin transaction read only`）从数据库层保证
// 不写库；`FOR UPDATE` 只能出现在写事务的复校验里（只读事务里会 25006），所以行锁是参数化的。
// 代价的双倍读由写事务里的**第二次 prepare 复校验**收窄 TOCTOU。

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
/**
 * 手写校验面试官数组（`SPEC.md` §4.1）：无重复 actor、默认值补齐。
 * @param value - 入参原值。
 * @param path - 参数路径（`interviewers` / `interviewer_additions`）。
 * @param mode - `CREATE` 要求非空（A4）；`ADDITIONS` 允许空数组（只增不减，空 = 没加人）。
 * @returns 规范化后的面试官数组。
 */
function parseInterviewerList(
  value: unknown,
  path: string,
  mode: 'CREATE' | 'ADDITIONS',
): readonly ScheduleInterviewerArgs[] {
  if (value === undefined) fail('MISSING_REQUIRED', `缺少必填参数 "${path}"`, { path })
  if (!Array.isArray(value)) fail('TYPE_MISMATCH', `"${path}" 必须是对象数组`, { path })
  if (value.length === 0 && mode === 'CREATE') {
    fail('INTERVIEWER_REQUIRED', '至少需要一名面试官（A4）', { path })
  }
  const interviewers: ScheduleInterviewerArgs[] = []
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    const elementPath = `${path}[${index}]`
    if (!isPlainObject(raw)) fail('TYPE_MISMATCH', `"${elementPath}" 必须是对象`, { path: elementPath })
    assertNoUnknownKeys(raw, INTERVIEWER_KEYS, elementPath)

    if (raw.actor_id === undefined) fail('MISSING_REQUIRED', `"${elementPath}.actor_id" 必填`, { path: `${elementPath}.actor_id` })
    if (typeof raw.actor_id !== 'string') fail('TYPE_MISMATCH', `"${elementPath}.actor_id" 必须是字符串`, { path: elementPath })
    if (!isUuid(raw.actor_id)) {
      fail('ID_NOT_UUID', `"${elementPath}.actor_id" 必须是 UUID 文本形式`, { path: `${elementPath}.actor_id` })
    }
    const actorId = raw.actor_id.toLowerCase()
    if (seen.has(actorId)) {
      fail('DUPLICATE_INTERVIEWER', `面试官 ${actorId} 在 ${path} 里出现了两次`, { path, actor_id: actorId })
    }
    seen.add(actorId)

    const roleValue = raw.role_in_interview === undefined ? 'INTERVIEWER' : raw.role_in_interview
    if (typeof roleValue !== 'string') {
      fail('TYPE_MISMATCH', `"${elementPath}.role_in_interview" 必须是字符串`, { path: `${elementPath}.role_in_interview` })
    }
    if (!ROLE_IN_INTERVIEW_RE.test(roleValue)) {
      // 契约 §3.3 只给了正则，没给独立 reason_code；用封闭集里最接近的 OUT_OF_RANGE。
      fail('OUT_OF_RANGE', `"${elementPath}.role_in_interview" 必须匹配 ^[A-Z][A-Z0-9_]{1,30}$`, {
        path: `${elementPath}.role_in_interview`,
        value: roleValue,
      })
    }

    const requiredValue = raw.required_scorecard === undefined ? true : raw.required_scorecard
    if (typeof requiredValue !== 'boolean') {
      fail('TYPE_MISMATCH', `"${elementPath}.required_scorecard" 必须是布尔值`, { path: `${elementPath}.required_scorecard` })
    }

    const dueAt = raw.scorecard_due_at === undefined
      ? undefined
      : new Date(parseIsoWithOffset(raw.scorecard_due_at, `${elementPath}.scorecard_due_at`)).toISOString()

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

/** 读 `intent`（缺省 `CREATE`；未知取值 → `INVALID_ARGS(OUT_OF_RANGE)`）。 */
function readIntentValue(input: Record<string, unknown>): ScheduleIntent {
  const raw = input.intent
  if (raw === undefined) return 'CREATE'
  if (typeof raw !== 'string') fail('TYPE_MISMATCH', '"intent" 必须是字符串', { path: 'intent' })
  if (!(INTENTS as readonly string[]).includes(raw)) {
    fail('OUT_OF_RANGE', `intent 必须是 ${INTENTS.join(' / ')} 之一（收到 "${raw}"）`, {
      path: 'intent',
      value: raw,
      allowed: [...INTENTS],
    })
  }
  return raw as ScheduleIntent
}

/** 顶层未知键（含 `tenant_id` / `actor_id`：**不静默忽略**，§0 第 4 条）。 */
function assertTopLevelKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key)).sort()
  if (unknown.length === 0) return
  const first = unknown[0] as string
  const reason = first === 'tenant_id' || first === 'actor_id' ? 'TENANT_OR_ACTOR_NOT_ALLOWED' : 'UNKNOWN_PARAM'
  fail(reason, `未知参数 "${first}"（allowed: ${allowed.join(', ')}）`, {
    param: first,
    unknown,
    allowed: [...allowed],
  })
}

/** 幂等键字符集（非空 / 长度已由 `args.ts` 判）。 */
function readIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string') fail('TYPE_MISMATCH', '"idempotency_key" 必须是字符串', { path: 'idempotency_key' })
  if (!IDEMPOTENCY_KEY_RE.test(value)) {
    // 契约 §3.7 没有"键字符非法"的独立 reason_code，用封闭集里的 OUT_OF_RANGE。
    fail('OUT_OF_RANGE', 'idempotency_key 只能包含 [A-Za-z0-9_.:-]', { path: 'idempotency_key', value })
  }
  return value
}

/**
 * `'sha256:' + sha256(canonicalJson(原始入参去掉 idempotency_key))`（§4.3）。
 * **原始**入参 = 调用方给什么算什么，**不补**默认值，所以"省略默认值"与"显式写默认值"是两组参数。
 */
function digestOfArgs(input: Record<string, unknown>): string {
  const digestInput: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'idempotency_key') digestInput[key] = value
  }
  return `sha256:${digestOf(digestInput)}`
}

/** `expected_record_version` 的 `>= 1` 判定（类型错已由 `args.ts` 判）。 */
function readExpectedRecordVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('TYPE_MISMATCH', '"expected_record_version" 必须是整数', { path: 'expected_record_version' })
  }
  if (value < 1) {
    fail('OUT_OF_RANGE', '"expected_record_version" 必须 >= 1', { path: 'expected_record_version', value })
  }
  return value
}

/** `duration_minutes` 的 15..480 判定（类型错已由 `args.ts` 判）。 */
function readDurationMinutes(value: unknown): number {
  const duration = value as number
  if (!Number.isInteger(duration) || duration < MIN_DURATION_MINUTES || duration > MAX_DURATION_MINUTES) {
    // `scheduling-rules.md` §2.3 明确 A5 用 DURATION_OUT_OF_RANGE（§3.7 的 OUT_OF_RANGE 是同一格的另一种写法）。
    fail(
      'DURATION_OUT_OF_RANGE',
      `duration_minutes 必须是 ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES} 的整数`,
      { path: 'duration_minutes', value },
    )
  }
  return duration
}

/**
 * `reason`（SC-X5）：`CANCEL` / `WITHDRAW_INTERVIEWER` 必填，`RESCHEDULE` 可省。
 *
 * 为什么手写而不交给 `args.ts`：契约把"为空"映射到 `INVALID_ARGS(REASON_REQUIRED)`，
 * 而 `args.ts` 对空串先给 `TYPE_MISMATCH`。两者同为 `INVALID_ARGS`，但 `reason_code` 必须按契约来。
 */
function readReason(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) fail('REASON_REQUIRED', '该 intent 必须给非空 reason（SC-X5）', { path: 'reason' })
    return undefined
  }
  if (typeof value !== 'string') fail('TYPE_MISMATCH', '"reason" 必须是字符串', { path: 'reason' })
  if (value.length > 500) {
    fail('OUT_OF_RANGE', '"reason" 不能超过 500 个字符', { path: 'reason', length: value.length })
  }
  if (value.trim() === '') {
    if (required) fail('REASON_REQUIRED', 'reason 不能为空（SC-X5）', { path: 'reason' })
    return undefined
  }
  return value
}

/** `CREATE` 的形状（原切片逻辑逐条保留）。 */
function parseCreateCommand(
  input: Record<string, unknown>,
  scalars: Record<string, unknown>,
  idempotencyKey: string,
  argsDigest: string,
): CreateCommand {
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
  const duration = readDurationMinutes(scalars.duration_minutes)
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

  const interviewers = parseInterviewerList(input.interviewers, 'interviewers', 'CREATE')
  const meeting = input.meeting === undefined ? undefined : parseMeeting(input.meeting)
  const templateId = scalars.interview_template_version_id === undefined
    ? undefined
    : (scalars.interview_template_version_id as string).toLowerCase()

  return compact({
    intent: 'CREATE',
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
    args_digest: argsDigest,
  }) as unknown as CreateCommand
}

/** `RESCHEDULE` 的形状（时点 / 状态 / 冲突在事务里、幂等 STORE 之后判）。 */
function parseRescheduleCommand(
  input: Record<string, unknown>,
  scalars: Record<string, unknown>,
  idempotencyKey: string,
  argsDigest: string,
): RescheduleCommand {
  const interviewId = (scalars.interview_id as string).toLowerCase()
  const expected = readExpectedRecordVersion(scalars.expected_record_version)

  let startIso: string | undefined
  let startMs: number | undefined
  if (scalars.scheduled_start_at !== undefined) {
    startMs = parseIsoWithOffset(scalars.scheduled_start_at, 'scheduled_start_at')
    startIso = new Date(startMs).toISOString()
  }
  const duration = scalars.duration_minutes === undefined
    ? undefined
    : readDurationMinutes(scalars.duration_minutes)
  if (startIso === undefined && duration === undefined) {
    // §3.2：`scheduled_start_at` 与 `duration_minutes` 至少要给一个 → 否则 NO_CHANGE。
    fail(
      'NO_CHANGE',
      'RESCHEDULE 至少要给 scheduled_start_at 或 duration_minutes 之一，否则没有任何可改字段',
      { path: 'scheduled_start_at', allowed: ['scheduled_start_at', 'duration_minutes'] },
    )
  }

  const meeting = input.meeting === undefined ? undefined : parseMeeting(input.meeting)
  const additions = input.interviewer_additions === undefined
    ? []
    : parseInterviewerList(input.interviewer_additions, 'interviewer_additions', 'ADDITIONS')
  const reason = readReason(input.reason, false)

  return compact({
    intent: 'RESCHEDULE',
    idempotency_key: idempotencyKey,
    interview_id: interviewId,
    expected_record_version: expected,
    scheduled_start_at: startIso,
    start_ms: startMs,
    duration_minutes: duration,
    meeting,
    interviewer_additions: additions,
    reason,
    args_digest: argsDigest,
  }) as unknown as RescheduleCommand
}

/** `CANCEL` 的形状。 */
function parseCancelCommand(
  input: Record<string, unknown>,
  scalars: Record<string, unknown>,
  idempotencyKey: string,
  argsDigest: string,
): CancelCommand {
  return compact({
    intent: 'CANCEL',
    idempotency_key: idempotencyKey,
    interview_id: (scalars.interview_id as string).toLowerCase(),
    expected_record_version: readExpectedRecordVersion(scalars.expected_record_version),
    reason: readReason(input.reason, true),
    args_digest: argsDigest,
  }) as unknown as CancelCommand
}

/** `WITHDRAW_INTERVIEWER` 的形状。 */
function parseWithdrawInterviewerCommand(
  input: Record<string, unknown>,
  scalars: Record<string, unknown>,
  idempotencyKey: string,
  argsDigest: string,
): WithdrawInterviewerCommand {
  return compact({
    intent: 'WITHDRAW_INTERVIEWER',
    idempotency_key: idempotencyKey,
    interviewer_id: (scalars.interviewer_id as string).toLowerCase(),
    expected_record_version: readExpectedRecordVersion(scalars.expected_record_version),
    reason: readReason(input.reason, true),
    args_digest: argsDigest,
  }) as unknown as WithdrawInterviewerCommand
}

/**
 * 形状校验（**不含**"时间是否已过去"，也不碰库）。`scheduleInTransaction` 用它先过形状，
 * 再查幂等 STORE，最后才判时点/状态（`SPEC.md` §4.2：重放不能被"时间已过"影响）。
 * @param raw - 模型给的 arguments。
 * @returns 按 `intent` 区分的四选一命令。
 */
function parseScheduleShape(raw: unknown): ScheduleCommand {
  if (!isPlainObject(raw)) {
    // 交给 args.ts 产出与其它工具一致的 `arguments must be a JSON object`。
    parseContractArgs(COMMON_PARAMS, raw)
    fail('TYPE_MISMATCH', 'arguments 必须是 JSON 对象', { path: 'arguments' })
  }
  const input = raw as Record<string, unknown>

  // 1. `intent` 决定后面所有键集（每个 intent 的入参表见 `tool-contracts.md` §3.2）。
  const intent = readIntentValue(input)
  const intentParams = INTENT_PARAMS[intent]
  const structuredKeys = INTENT_STRUCTURED_KEYS[intent]
  const allowedKeys = [
    ...Object.keys(COMMON_PARAMS),
    ...Object.keys(intentParams),
    ...structuredKeys,
    ...INTENT_EXTRA_KEYS[intent],
  ]

  // 2. 未知键（含 tenant_id / actor_id / force / allow_conflict / skip_conflict_check / status /
  //    record_version）一次性拒绝：声明键 = 通用 + 该 intent 的标量 + 该 intent 的结构化键。
  assertTopLevelKeys(input, allowedKeys)

  // 3. 标量交给 args.ts；`reason` 手写（见 readReason），结构化键手写。
  const scalarInput: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (structuredKeys.includes(key) || key === 'reason') continue
    scalarInput[key] = value
  }
  const scalars = parseContractArgs({ ...COMMON_PARAMS, ...intentParams }, scalarInput)
  const idempotencyKey = readIdempotencyKey(scalars.idempotency_key)
  const argsDigest = digestOfArgs(input)

  switch (intent) {
    case 'CREATE':
      return parseCreateCommand(input, scalars, idempotencyKey, argsDigest)
    case 'RESCHEDULE':
      return parseRescheduleCommand(input, scalars, idempotencyKey, argsDigest)
    case 'CANCEL':
      return parseCancelCommand(input, scalars, idempotencyKey, argsDigest)
    case 'WITHDRAW_INTERVIEWER':
      return parseWithdrawInterviewerCommand(input, scalars, idempotencyKey, argsDigest)
  }
}

/**
 * 纯函数：**只做形状/格式校验**（`SPEC.md` §4.2）。
 *
 * 明确**不**在这里判 `START_IN_PAST`：`SPEC.md` §4.2 要求"先查幂等 STORE，再判时点"，
 * 否则同一 key 同参的重放会因为"那场面试已经到点/过去了"被误判成 400。
 * 时点校验在 `scheduleInTransaction` 里、幂等命中判定之后抛（见各 run*Command 的说明）。
 * `_nowMs` 只为对齐 `SPEC.md` §4.2 的导出签名而保留，**不参与**任何判断。
 *
 * `args_digest` 只覆盖**原始入参去掉 idempotency_key**——默认值（`intent` / `slot_code` /
 * `timezone` / `delivery_mode` / 面试官的 `role_in_interview`+`required_scorecard`）一律不进 digest，
 * 所以"省略默认值"和"显式写默认值"会被当成两次不同请求（契约 §4.3 的逐字要求：digest 的对象是 args 本身）。
 * @param raw - 模型给的 arguments。
 * @param _nowMs - 服务端当前时刻（毫秒；保留签名，形状校验不需要它）。
 * @returns 按 `intent` 区分的四选一命令。
 */
export function parseScheduleArgs(raw: unknown, _nowMs?: number): ScheduleCommand {
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

/**
 * 重放：返回首次结果（`changes` 三数组全空，`interview` 从库重新读）。
 *
 * 闭环口径（§4.3）：`STORE` 有行 ∧ digest 相同 → `replayed=true`、**不写任何新行**。
 * 四个 intent 共用同一个 STORE 前缀，所以重放与 intent 无关；`interview` 一律从库里重读，
 * 不会出现"用本次入参拼出一个没写过的结果"。
 * @param store - 首次执行留下的 STORE 行。
 * @param command - 本次命令（四个 intent 之一）。
 */
async function replayFromStore(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  store: StoreRow,
  command: ScheduleCommand,
  asOfIso: string,
): Promise<Record<string, unknown>> {
  const storedDigest = storeDigest(store)
  const interviewId = storeInterviewId(store)
  if (storedDigest === null || interviewId === null) {
    fail(
      'IDEMPOTENCY_KEY_REUSED',
      `幂等键 "${command.idempotency_key}" 已被另一条无法解析的命令占用`,
      { idempotency_key: command.idempotency_key, store_task_id: store.id },
    )
  }
  if (storedDigest !== command.args_digest) {
    fail(
      'IDEMPOTENCY_KEY_REUSED',
      `幂等键 "${command.idempotency_key}" 已用于另一组参数（digest 不一致）`,
      {
        idempotency_key: command.idempotency_key,
        first_args_digest: storedDigest,
        this_args_digest: command.args_digest,
        first_interview_id: interviewId,
      },
    )
  }

  const interview = await readInterviewBack(client, config.tenant_id, interviewId, asOfIso)
  const binding = meetingBindingOf(interview)
  const warnings: { code: string; message: string }[] = []
  // 只有排期类 intent 才谈"没绑会议"；CANCEL 之后 `binding_state` 是 `NONE_EXPECTED`，不是缺陷。
  if ((command.intent === 'CREATE' || command.intent === 'RESCHEDULE')
    && binding !== null && binding.state === 'UNBOUND') warnings.push(meetingNotBoundWarning())

  // 重放读的是同一租户的既有行：标签按租户事实重算（不缓、不写死）。
  const labels = await buildThreeAxisLabels(client, config.tenant_id)

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    write: true,
    replayed: true,
    labels,
    intent: command.intent,
    command: { idempotency_key: command.idempotency_key, args_digest: command.args_digest },
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

/**
 * 面试官冲突（`scheduling-rules.md` §3.2，`required_scorecard=true` 才占位）。
 * @param excludeInterviewId - 本次要改期的场次自身（`RESCHEDULE` 要排除自己，§4.2 第 1 步）。
 */
async function findInterviewerConflicts(
  client: DatabaseClient,
  tenantId: string,
  actorIds: readonly string[],
  startIso: string,
  bufferedEndIso: string,
  excludeInterviewId?: string,
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
          and ($5::uuid is null or i.id <> $5::uuid)
        group by i.id, r.actor_id
     )
     select interview_id, actor_id, ew_start, ew_end
       from occupied
      where ew_start < $3::timestamptz
        and $4::timestamptz < ew_end
      order by actor_id, interview_id`,
    [tenantId, actorIds, bufferedEndIso, startIso, excludeInterviewId ?? null],
  )
  return rows.map((row) => compact({
    kind: 'INTERVIEWER' as const,
    ref_kind: 'INTERVIEW' as const,
    ref_id: row.interview_id,
    actor_id: row.actor_id,
    window: { start: toIso(row.ew_start), end: toIso(row.ew_end) },
  }) as unknown as Conflict)
}

/**
 * 候选人冲突（跨轮次；不加 buffer，SC-C2）。
 * @param excludeInterviewId - 本次要改期的场次自身（`RESCHEDULE` 要排除自己）。
 */
async function findCandidateConflicts(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  startIso: string,
  endIso: string,
  excludeInterviewId?: string,
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
          and ($5::uuid is null or i.id <> $5::uuid)
        group by i.id
     )
     select interview_id, ew_start, ew_end
       from occupied
      where ew_start < $3::timestamptz
        and $4::timestamptz < ew_end
      order by interview_id`,
    [tenantId, candidateId, endIso, startIso, excludeInterviewId ?? null],
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

// ---------------------------------------------------------------------------
//  四个 intent 共用的读写小件（**只有一份**：D-62 不拆工具的理由）
// ---------------------------------------------------------------------------

/**
 * 读一场面试（`RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER` 都要它）。
 *
 * `forUpdate` 必须由调用方按事务性质给：**只读准备阶段必须 `false`**（PG 在
 * `read only` 事务里对 `SELECT ... FOR UPDATE` 直接 25006）；**写事务的复校验必须 `true`**，
 * 与两阶段之前"校验即加锁"的旧行为一致（并发改期的乐观并发 + 行锁语义不降级）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param interviewId - 面试 id。
 * @param forUpdate - 是否加 `FOR UPDATE` 行锁（默认 `true`：旧的单一事务语义）。
 */
async function loadInterviewForUpdate(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  forUpdate = true,
): Promise<InterviewCommandRow> {
  const { rows } = await client.query<InterviewCommandRow>(
    `select id, application_id, status, record_version, scheduled_start_at, scheduled_end_at,
            round_no, slot_code
       from recruitment.interview
      where id = $1 and tenant_id = $2${forUpdate ? ' for update' : ''}`,
    [interviewId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    // 跨租户一律 NOT_FOUND：不确认对方租户里那一行是否存在（IR-C7 同构）。
    throw contractError('NOT_FOUND', {
      reason_code: 'INTERVIEW_NOT_FOUND',
      message: `该租户下没有面试 ${interviewId}`,
      detail: { interview_id: interviewId },
    })
  }
  return row
}

/** 乐观并发（§4.4 / SC-K6 / D-18）：版本不匹配 → `VERSION_CONFLICT(STALE_RECORD_VERSION)`。 */
function assertExpectedVersion(row: InterviewCommandRow, expected: number, interviewId: string): void {
  if (row.record_version === expected) return
  throw s8Error('VERSION_CONFLICT', {
    reason_code: 'STALE_RECORD_VERSION',
    message: `该面试已被他人修改（期望版本 ${expected}，实际 ${row.record_version}）`,
    detail: {
      interview_id: interviewId,
      expected_record_version: expected,
      actual_record_version: row.record_version,
    },
  })
}

/** 状态机（§8）：不在允许边内 → `INVALID_ARGS(INVALID_STATE_TRANSITION)`，零写入。 */
function assertStatusAllowed(
  row: InterviewCommandRow,
  allowedStatuses: readonly string[],
  intent: ScheduleIntent,
): void {
  if (allowedStatuses.includes(row.status)) return
  fail(
    'INVALID_STATE_TRANSITION',
    `${intent} 不允许从状态 ${row.status} 出发（allowed: ${allowedStatuses.join(' / ')}；状态机见 scheduling-rules §8）`,
    { interview_id: row.id, status: row.status, allowed_statuses: [...allowedStatuses] },
  )
}

/** 读面试所属申请的候选人 id（候选人冲突 SC-C3 要用）。 */
async function loadCandidateOfInterview(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<string> {
  const { rows } = await client.query<{ candidate_id: string }>(
    `select a.candidate_id
       from recruitment.interview i
       join recruitment.application a
         on a.id = i.application_id and a.tenant_id = i.tenant_id
      where i.id = $1 and i.tenant_id = $2`,
    [interviewId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new RecruitmentToolError('READER_FAILED', `interview ${interviewId} 没有可读的 application`)
  }
  return row.candidate_id
}

/** 一场面试当前的面试官行。 */
async function listInterviewers(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<readonly { readonly id: string; readonly actor_id: string; readonly required_scorecard: boolean }[]> {
  const { rows } = await client.query<{ id: string; actor_id: string; required_scorecard: boolean }>(
    `select id, actor_id, required_scorecard
       from recruitment.interviewer
      where tenant_id = $1 and interview_id = $2
      order by actor_id`,
    [tenantId, interviewId],
  )
  return rows
}

/** 面试官集合的 A4 校验（同租户存在 + `kind='HUMAN'`，空集/重复在形状层已拒）。 */
async function assertInterviewerActors(
  client: DatabaseClient,
  tenantId: string,
  actorIds: readonly string[],
): Promise<void> {
  if (actorIds.length === 0) return
  const actorResult = await client.query<ActorRow>(
    `select id, kind, display_name
       from recruitment.actor
      where tenant_id = $1 and id = any($2::uuid[])`,
    [tenantId, actorIds],
  )
  const actors = new Map(actorResult.rows.map((row) => [row.id.toLowerCase(), row]))
  for (const actorId of actorIds) {
    const actor = actors.get(actorId)
    if (actor === undefined) {
      // 跨租户 / 不存在一律 NOT_FOUND，不确认对方存在（IR-C7 同构）。
      throw contractError('NOT_FOUND', {
        reason_code: 'INTERVIEWER_NOT_FOUND',
        message: `该租户下没有面试官 actor ${actorId}`,
        detail: { actor_id: actorId },
      })
    }
    if (actor.kind !== 'HUMAN') {
      fail(
        'INTERVIEWER_NOT_HUMAN',
        `actor ${actorId} 的 kind=${actor.kind}，Agent / SYSTEM 不能当面试官（A4）`,
        { actor_id: actorId, kind: actor.kind },
      )
    }
  }
}

/** 该面试的全部 active 绑定（`unbound_at is null`），带 meeting 的角色与"是否已发生"。 */
async function listActiveBindings(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
): Promise<readonly ActiveBindingRow[]> {
  const { rows } = await client.query<ActiveBindingRow>(
    `select b.id as binding_id, b.meeting_id, m.meeting_role, m.actual_start_at
       from recruitment.meeting_binding b
       join recruitment.meeting m on m.id = b.meeting_id and m.tenant_id = b.tenant_id
      where b.tenant_id = $1 and b.interview_id = $2 and b.unbound_at is null
      order by b.bound_at, b.id`,
    [tenantId, interviewId],
  )
  return rows
}

/** 按平台 ID 找已有 meeting 行（`external_meeting_id` 优先，与 CREATE 同一口径）。 */
async function findMeetingRowId(
  client: DatabaseClient,
  tenantId: string,
  meeting: ScheduleMeetingArgs,
): Promise<string | undefined> {
  if (meeting.external_meeting_id !== undefined) {
    const found = await client.query<{ id: string }>(
      `select id
         from recruitment.meeting
        where tenant_id = $1 and provider = $2 and external_meeting_id = $3
        order by created_at
        limit 1`,
      [tenantId, meeting.provider, meeting.external_meeting_id],
    )
    return found.rows[0]?.id
  }
  if (meeting.calendar_event_id !== undefined) {
    const found = await client.query<{ id: string }>(
      `select id
         from recruitment.meeting
        where tenant_id = $1 and provider = $2 and calendar_event_id = $3
        order by created_at desc
        limit 1`,
      [tenantId, meeting.provider, meeting.calendar_event_id],
    )
    return found.rows[0]?.id
  }
  return undefined
}

/** 某个 meeting 当前的 active binding（`uq_meeting_binding_active` 保证至多一条）。 */
async function findActiveBindingOfMeeting(
  client: DatabaseClient,
  tenantId: string,
  meetingId: string,
): Promise<{ readonly id: string; readonly interview_id: string } | undefined> {
  const { rows } = await client.query<{ id: string; interview_id: string }>(
    `select id, interview_id
       from recruitment.meeting_binding
      where tenant_id = $1 and meeting_id = $2 and unbound_at is null`,
    [tenantId, meetingId],
  )
  return rows[0]
}

/** `MEETING_ALREADY_BOUND(BOUND_TO_OTHER_INTERVIEW)`。 */
function meetingAlreadyBoundError(detail: Record<string, unknown>): RecruitmentToolError {
  return s8Error('MEETING_ALREADY_BOUND', {
    reason_code: 'BOUND_TO_OTHER_INTERVIEW',
    message: '该会议已被另一场面试的 active binding 占用（A9 / uq_meeting_binding_active）',
    detail,
  })
}

/** INSERT 一行 meeting（只登记平台 ID，绝不创建日历事件，H-2）。 */
async function insertMeetingRow(
  client: DatabaseClient,
  tenantId: string,
  meeting: ScheduleMeetingArgs,
  meetingRole: string,
): Promise<string> {
  try {
    const inserted = await client.query<{ id: string }>(
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
        meetingRole,
      ],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'meeting insert returned no row')
    return row.id
  } catch (error) {
    if (isUniqueViolation(error, 'uq_meeting_external')) {
      throw meetingAlreadyBoundError({
        provider: meeting.provider,
        external_meeting_id: meeting.external_meeting_id,
      })
    }
    throw error
  }
}

/** INSERT 一行 `meeting_binding(binding_method='SCHEDULED')`。 */
async function insertBindingRow(
  client: DatabaseClient,
  tenantId: string,
  meetingId: string,
  interviewId: string,
  actorId: string,
): Promise<string> {
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into recruitment.meeting_binding
         (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
       values ($1, $2, $3, 'SCHEDULED', $4)
       returning id`,
      [tenantId, meetingId, interviewId, actorId],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'meeting_binding insert returned no row')
    return row.id
  } catch (error) {
    if (isUniqueViolation(error, 'uq_meeting_binding_active')) {
      throw meetingAlreadyBoundError({ meeting_id: meetingId, this_interview_id: interviewId })
    }
    throw error
  }
}

/** 写一条**显式**内部审计事件（`event_inbox`；`scheduling-rules.md` §4.3/§4.4/SC-X5）。 */
async function insertInternalEvent(
  client: DatabaseClient,
  tenantId: string,
  event: {
    readonly eventType: string
    readonly idempotencyKey: string
    readonly sourceObjectId: string
    readonly payload: Record<string, unknown>
  },
): Promise<string> {
  const inserted = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
        idempotency_key, idempotency_source, source_object_id, payload, trust_level,
        normalized_event_type, normalizer_version)
     values ($1, $2, $3, 1, now(), now(), now(), $4, 'FALLBACK_KEY', $5, $6::jsonb, $7, $3,
             'schema/interview-schedule')
     returning event_id`,
    [
      tenantId,
      EVENT_PROVIDER,
      event.eventType,
      event.idempotencyKey,
      event.sourceObjectId,
      JSON.stringify(event.payload),
      EVENT_TRUST_LEVEL,
    ],
  )
  const row = inserted.rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'event_inbox insert returned no row')
  return row.event_id
}

/**
 * 审计事件的幂等键：同一命令（同一 `idempotency_key`）对同一事件类型只会写一次。
 * `uq_event_inbox_idempotency (tenant_id, idempotency_key)` 兜住并发重复写。
 */
function auditEventKey(command: ScheduleCommand, eventType: string): string {
  return `${STORE_KEY_PREFIX}${command.idempotency_key}:${eventType}`
}

/** 数该面试已有的某类事件（改期序号 `reschedule_no` / 幂等判重都要）。 */
async function countInterviewEvents(
  client: DatabaseClient,
  tenantId: string,
  eventType: string,
  interviewId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n
       from recruitment.event_inbox
      where tenant_id = $1 and event_type = $2 and payload->>'interview_id' = $3`,
    [tenantId, eventType, interviewId],
  )
  return rows[0]?.n ?? 0
}

/** 幂等 STORE 行的写入结果：成功给了 `taskId`；撞 `uq_business_task_idempotency` 返回 `conflict`。 */
type StoreWriteResult =
  | { readonly kind: 'created'; readonly taskId: string }
  | { readonly kind: 'conflict' }

/** 写幂等 STORE（§4.3：`business_task.idempotency_key = 'interview_schedule:' || K`）。 */
async function insertStoreCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  command: ScheduleCommand,
  interviewId: string,
  title: string,
  description: string,
): Promise<StoreWriteResult> {
  const storeRefs = [
    { kind: 'INTERVIEW', id: interviewId },
    { args_digest: command.args_digest, result_interview_id: interviewId },
  ]
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into recruitment.business_task
         (tenant_id, task_type, business_refs, title, description, priority, created_by_actor_id,
          idempotency_key, status, result_ref, completed_at, status_changed_by_actor_id)
       values ($1, $2, $3::jsonb, $4, $5, 2, $6, $7, 'SUCCEEDED', $8, now(), $6)
       returning id`,
      [
        config.tenant_id,
        STORE_TASK_TYPE,
        JSON.stringify(storeRefs),
        title,
        description,
        config.actor_id,
        `${STORE_KEY_PREFIX}${command.idempotency_key}`,
        interviewId,
      ],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'store task insert returned no row')
    return { kind: 'created', taskId: row.id }
  } catch (error) {
    // 并发同键（SC-K5）：交给调用方退回命令开头 → 重读 STORE → 重放。
    if (isUniqueViolation(error, 'uq_business_task_idempotency')) return { kind: 'conflict' }
    throw error
  }
}

/**
 * 并发同键（SC-K5）：退回命令开头（撤销本次已写的行）→ 重读 STORE → 按首次结果重放。
 * 服务层必须把它翻译成"重放"，**不得**抛 500。
 */
async function replayAfterStoreConflict(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  command: ScheduleCommand,
  asOfIso: string,
): Promise<Record<string, unknown>> {
  await client.query(`rollback to savepoint ${STORE_SAVEPOINT}`)
  const winner = await loadStore(client, config.tenant_id, command.idempotency_key)
  if (winner === null) {
    throw new RecruitmentToolError(
      'READER_FAILED',
      '同键并发写入后读不到 STORE 行（幂等 STORE 的 winner 应当已提交）',
    )
  }
  return await replayFromStore(client, config, winner, command, asOfIso)
}

/**
 * 四个 intent 共用的成功出参（`tool-contracts.md` §3.5）：读回 + 三维标签 + `changes`。
 * 读回就是"写完立刻可查"的自证（与 `get.interviews[]` 同一份实现）。
 */
async function buildCommandResult(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  command: ScheduleCommand,
  interviewId: string,
  asOfIso: string,
  changes: { readonly created: ChangeRow[]; readonly updated: ChangeRow[] },
  warnings: { code: string; message: string }[],
  nextActions: readonly { code: string; task_id: string; due_at: string }[],
): Promise<Record<string, unknown>> {
  const interview = await readInterviewBack(client, config.tenant_id, interviewId, asOfIso)
  const binding = meetingBindingOf(interview)
  const meetingBound = binding !== null && typeof binding.count === 'number' && binding.count >= 1
  // 排期类 intent 未绑会议 → 告警（H-3），与 CREATE 的历史行为一致。
  if ((command.intent === 'CREATE' || command.intent === 'RESCHEDULE') && !meetingBound) {
    warnings.unshift(meetingNotBoundWarning())
  }
  // R4 三维标签：按租户事实算（演示租户 ⇒ FIXTURE），不写死 LIVE。
  const labels = await buildThreeAxisLabels(client, config.tenant_id)
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    write: true,
    replayed: false,
    labels,
    intent: command.intent,
    command: { idempotency_key: command.idempotency_key, args_digest: command.args_digest },
    interview,
    changes: { created: [...changes.created], updated: [...changes.updated], unchanged: [] },
    effects: { meeting_bound: meetingBound, external_call_made: false },
    warnings,
    next_actions: [...nextActions],
  }
}

// ---------------------------------------------------------------------------
//  D-101 两阶段：prepare（只读校验/计划） → write（写库 + 读回）
// ---------------------------------------------------------------------------

/**
 * `prepareSchedule` 的 `write` 分支：四个 intent 各自的写库计划
 * （只读阶段已经算好、写阶段直接用的**事实**；写阶段不再重新判定"要不要写"）。
 */
export type ScheduleWritePlan =
  | {
    readonly intent: 'CREATE'
    readonly command: CreateCommand
    readonly asOfIso: string
  }
  | {
    readonly intent: 'RESCHEDULE'
    readonly command: RescheduleCommand
    /** 写事务复校验里拿到的行（`FOR UPDATE`；读取前的状态）。 */
    readonly row: InterviewCommandRow
    readonly startIso: string
    readonly endIso: string
    readonly durationMinutes: number
    /** 真正要新增的面试官（已在该场的不重复插，只留告警）。 */
    readonly additions: readonly ScheduleInterviewerArgs[]
    /** 已累积的告警（`ALREADY_ASSIGNED` 等；写入段还会追加）。 */
    readonly warnings: { code: string; message: string }[]
    readonly asOfIso: string
  }
  | {
    readonly intent: 'CANCEL'
    readonly command: CancelCommand
    readonly row: InterviewCommandRow
    readonly asOfIso: string
  }
  | {
    readonly intent: 'WITHDRAW_INTERVIEWER'
    readonly command: WithdrawInterviewerCommand
    readonly row: InterviewerCommandRow
    readonly asOfIso: string
  }

/**
 * `prepareSchedule` 的结论（**internal 导出**：生产路径与测试共用，不是契约面）。
 *
 * * `result`：本次**不写库**、直接返回（幂等重放 / 已 CANCELLED 的重复取消 /
 *   已退出的重复 withdraw）。它排在 D-79 闸门之前，所以**不问人**。
 * * `write`：全部参数/业务校验已通过，写库计划已定；调用方**必须**先过闸门再 `writeSchedule`。
 */
export type SchedulePreparation =
  | { readonly kind: 'result'; readonly value: Record<string, unknown> }
  | { readonly kind: 'write'; readonly plan: ScheduleWritePlan }

/** 两阶段 prepare 的选项：只有写事务的**复校验**才允许 `FOR UPDATE`（只读事务里是 25006）。 */
export interface SchedulePrepareOptions {
  readonly forUpdate: boolean
}

/**
 * 在命令开头建保存点，失败时退回保存点后**原样再抛**（`tool-contracts.md` §5.1 W3/W4）。
 *
 * 两个用处：① 并发同键撞 `uq_business_task_idempotency` 时退回命令开头再重放（SC-K5）；
 * ② 任何失败在**调用方事务内**撤销本次已写的行。`scheduleInTransaction` 与 `execute()`
 * 的写阶段都用它，保证"失败零写入"在两种入口下是同一份实现。
 * @param client - 事务内客户端。
 * @param fn - 命令体（可能写库）。
 * @returns `fn` 的返回值。
 */
async function inCommandSavepoint<T>(client: DatabaseClient, fn: () => Promise<T>): Promise<T> {
  await client.query(`savepoint ${STORE_SAVEPOINT}`)
  try {
    return await fn()
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
 * **阶段 1（只读）**：幂等 STORE 判定 + 全部业务校验 + 写库计划构造，**一行都不写**。
 *
 * 形状校验（`parseScheduleShape`，纯函数）由调用方先过。生产路径由 `execute()` 把它放进
 * `withReadOnly`（`begin transaction read only`：任何写都会 25006）；写事务里会**再跑一次**
 * （`forUpdate: true`）做复校验。四个 intent 共用这一条管道（D-62 不拆工具的理由）。
 * @param client - 事务内客户端（只读或写；本函数的读全部是 SELECT，行锁由 `options` 控制）。
 * @param config - 已解析配置（tenant/actor 只从这里来）。
 * @param command - 已过形状层的命令。
 * @param nowMs - 服务端"现在"（毫秒；测试可注入）。
 * @param options - 是否允许 `FOR UPDATE`（只读准备 `false`；写事务复校验 `true`）。
 * @returns `result`（直接返回且**不问人**）或 `write`（写库计划）。
 */
export async function prepareSchedule(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  command: ScheduleCommand,
  nowMs: number,
  options: SchedulePrepareOptions,
): Promise<SchedulePreparation> {
  const asOfIso = new Date(nowMs).toISOString()
  switch (command.intent) {
    case 'CREATE':
      return await prepareCreateCommand(client, config, command, nowMs, asOfIso)
    case 'RESCHEDULE':
      return await prepareRescheduleCommand(client, config, command, nowMs, asOfIso, options)
    case 'CANCEL':
      return await prepareCancelCommand(client, config, command, asOfIso, options)
    case 'WITHDRAW_INTERVIEWER':
      return await prepareWithdrawInterviewerCommand(client, config, command, asOfIso, options)
  }
}

/**
 * **阶段 2（写）**：只做写库 + 幂等 STORE 行 + 读回 + 组装出参，不再做"要不要写"的判定。
 *
 * 调用方**必须**先让 D-79 闸门放行（`requireApprovalGranted`）；本函数不调用 approval。
 * @param client - 写事务内客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param config - 已解析配置（tenant/actor 只从这里来）。
 * @param plan - `prepareSchedule` 的 `write` 分支（必须是**当前写事务里**重新跑出来的）。
 * @returns 契约出参（`tool-contracts.md` §3.5）。
 */
export async function writeSchedule(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  plan: ScheduleWritePlan,
): Promise<Record<string, unknown>> {
  switch (plan.intent) {
    case 'CREATE':
      return await writeCreateCommand(client, config, plan)
    case 'RESCHEDULE':
      return await writeRescheduleCommand(client, config, plan)
    case 'CANCEL':
      return await writeCancelCommand(client, config, plan)
    case 'WITHDRAW_INTERVIEWER':
      return await writeWithdrawInterviewerCommand(client, config, plan)
  }
}

/**
 * 在调用方事务里跑**一条**面试排期命令（**测试接缝**，保留旧签名与旧行为）。
 *
 * 顺序（`SPEC.md` §4.3，重放优先于时点校验）：
 * 形状 → 幂等 STORE（重放 / 键复用）→ 业务校验（时点/申请/模板/语义幂等/面试官/冲突/状态机）→
 * **D-79 闸门** → 写 → 幂等 STORE 行 → 读回。全部在**同一个调用方事务**里（旧行为不变）。
 *
 * 生产运行时入口是 `createInterviewScheduleTool().execute()`，它已经改成 D-101 两阶段
 * （只读 prepare → 事务外问人 → 写事务复校验）；`src/index.ts` 只注册 `create*Tool`，
 * **不引用**本函数。集成测试大量在"必回滚事务"里直接调它，所以保留。
 *
 * **失败零写入的强口径**（`tool-contracts.md` §5.1 W3/W4）：开头建保存点，任何抛出都
 * `rollback to savepoint` 后原样再抛。这样即使调用方把本函数放进**更大的事务**并吞掉错误，
 * 本次已写的行也不会残留成脏行。生产路径 `withActor` 还会整笔 ROLLBACK，两层互不冲突。
 * @param client - 已有事务的客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param config - 已解析的配置（tenant/actor 只从这里来）。
 * @param rawArgs - 模型给的 arguments。
 * @param nowMs - 服务端当前时刻（毫秒；测试可注入）。
 * @param approve - D-79 的人工批准通道；**缺省 = `unavailable` = 一律拒绝**（fail closed）。
 *   位置：参数/业务校验全部通过之后、第一行写之前；`allowed-once` 才写库；
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
  // 形状校验是纯函数：非法入参在**碰库/问人之前**就拒（零 SQL、approval 调用数 = 0）。
  const args = parseScheduleShape(rawArgs)
  // 保存点放在所有读写之前（并发同键重放 + W3/W4，见函数说明）。
  return await inCommandSavepoint(client, async () => {
    const prepared = await prepareSchedule(client, config, args, nowMs, { forUpdate: true })
    // 幂等重放 / 零写入的幂等成功不写库：闸门之前返回、不打扰人（D-95：人只决策一次）。
    if (prepared.kind === 'result') return prepared.value
    // D-79 闸门：全部参数/业务校验之后、第一行写之前。
    requireApprovalGranted(approve === undefined ? 'unavailable' : await approve())
    return await writeSchedule(client, config, prepared.plan)
  })
}

/**
 * `intent=CREATE` 的**只读准备段**（形状已校验）：幂等 STORE 判定 + 时点 + 申请 + 模板 +
 * 语义幂等 + 面试官 + 冲突，全部通过后只返回写库计划，**一行都不写**。
 * @param client - 事务内客户端（只读事务或写事务；本段只发 SELECT）。
 * @param config - 已解析的配置。
 * @param args - 已校验的 CREATE 命令。
 * @param nowMs - 服务端当前时刻（毫秒）。
 * @param asOfIso - `nowMs` 的 ISO 形式（错误 detail 用）。
 * @returns `result`（幂等重放）或 `write`（写库计划）。
 */
async function prepareCreateCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: CreateCommand,
  nowMs: number,
  asOfIso: string,
): Promise<SchedulePreparation> {
  const tenantId = config.tenant_id

  // 1. 幂等 STORE。
  const store = await loadStore(client, tenantId, args.idempotency_key)
  if (store !== null) {
    return { kind: 'result', value: await replayFromStore(client, config, store, args, asOfIso) }
  }

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
  await assertInterviewerActors(client, tenantId, actorIds)

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

  // 6.5. 计划就绪：**不在这里问人**。
  //      两阶段后闸门由调用方在**事务外**执行（`execute()`）或由测试接缝在调用方事务里执行
  //      （`scheduleInTransaction`）：这样人等待期间没有任何事务/连接被占（D-101）。
  return { kind: 'write', plan: { intent: 'CREATE', command: args, asOfIso } }
}

/**
 * `intent=CREATE` 的**写入段**（全部校验已过、D-79 闸门已放行）：只写库 + 幂等 STORE + 读回。
 * @param client - 写事务内客户端。
 * @param config - 已解析的配置。
 * @param plan - 只读准备段给出的写库计划。
 * @returns 契约出参。
 */
async function writeCreateCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  plan: Extract<ScheduleWritePlan, { readonly intent: 'CREATE' }>,
): Promise<Record<string, unknown>> {
  const args = plan.command
  const asOfIso = plan.asOfIso
  const tenantId = config.tenant_id
  const actorId = config.actor_id

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
  if (args.meeting !== undefined) {
    const meeting = args.meeting
    // 先按平台 ID 找已有 meeting 行（有则复用，未绑定才行）。
    let meetingId = await findMeetingRowId(client, tenantId, meeting)
    if (meetingId !== undefined) {
      // 已有 meeting 行：被别的场次 active 绑着 → 拒绝；未绑定 → 复用。
      const active = await findActiveBindingOfMeeting(client, tenantId, meetingId)
      if (active !== undefined && active.interview_id !== interviewId) {
        throw meetingAlreadyBoundError({
          meeting_id: meetingId,
          existing_interview_id: active.interview_id,
          existing_binding_id: active.id,
          this_interview_id: interviewId,
        })
      }
      warnings.push({
        code: 'BINDING_REUSED',
        message: `复用已存在的 meeting 行 ${meetingId}（未绑定），未新建 meeting`,
      })
    } else {
      meetingId = await insertMeetingRow(client, tenantId, meeting, meeting.meeting_role)
      created.push({ table: 'meeting', id: meetingId })
    }
    const bindingId = await insertBindingRow(client, tenantId, meetingId, interviewId, actorId)
    created.push({ table: 'meeting_binding', id: bindingId })
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
  const storeWrite = await insertStoreCommand(
    client,
    config,
    args,
    interviewId,
    `面试排期：第 ${args.round_no} 轮 ${args.slot_code}`,
    `CREATE interview ${interviewId}（${args.scheduled_start_at}，${args.duration_minutes} 分钟）`,
  )
  // 并发同键（SC-K5）：退回命令开头 → 重读 STORE → 重放；本次已写的行一并撤销。
  if (storeWrite.kind === 'conflict') return await replayAfterStoreConflict(client, config, args, asOfIso)
  created.push({ table: 'business_task', id: storeWrite.taskId })

  // 12. 读回（写完立刻可查的自证；输出 `interview` 与 get 同形）+ 出参。
  const nextActions: { code: string; task_id: string; due_at: string }[] = []
  if (args.meeting === undefined) {
    // `created` 里第一条 `business_task` 就是补绑任务（STORE 行在它之后才 push）。
    const bindTaskRow = created.find((row) => row.table === 'business_task')
    if (bindTaskRow !== undefined) {
      nextActions.push({ code: 'BIND_MEETING', task_id: bindTaskRow.id, due_at: args.scheduled_start_at })
    }
  }
  return await buildCommandResult(
    client, config, args, interviewId, asOfIso, { created, updated: [] }, warnings, nextActions,
  )
}

// ---------------------------------------------------------------------------
//  RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER 的事务体
// ---------------------------------------------------------------------------

/** `VERSION_CONFLICT(STALE_RECORD_VERSION)`（§4.4 / SC-K6 / D-18）。 */
function versionConflictError(interviewId: string, expected: number, actual: number): RecruitmentToolError {
  return s8Error('VERSION_CONFLICT', {
    reason_code: 'STALE_RECORD_VERSION',
    message: `该面试已被他人修改（期望版本 ${expected}，实际 ${actual}）`,
    detail: {
      interview_id: interviewId,
      expected_record_version: expected,
      actual_record_version: actual,
    },
  })
}

/** 一条冲突的完整 `CONFLICT_SLOT` 错误（§4.1：`conflicts[]` 必须逐条，`slot` 含 buffer 后的右端）。 */
function conflictSlotError(
  conflicts: readonly Conflict[],
  interviewerBusy: boolean,
  startIso: string,
  bufferedEndIso: string,
  bufferMinutes: number,
): RecruitmentToolError {
  return s8Error('CONFLICT_SLOT', {
    reason_code: interviewerBusy ? 'INTERVIEWER_BUSY' : 'CANDIDATE_BUSY',
    message: interviewerBusy
      ? `面试官在 ${startIso} 起的时段已有另一场面试（buffer=${bufferMinutes} 分钟）`
      : `候选人在 ${startIso} 起的时段已有另一场面试`,
    detail: { slot: { start: startIso, end: bufferedEndIso }, conflicts },
  })
}

/**
 * 解析 `interviewer_additions`：已在该场的 actor 只告警（`ALREADY_ASSIGNED`），不重复插入（§3.5）。
 * 真正要新增的人在这里做 A4 校验（同租户 + `HUMAN`）。
 */
async function resolveInterviewerAdditions(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  additions: readonly ScheduleInterviewerArgs[],
): Promise<{
  readonly toInsert: readonly ScheduleInterviewerArgs[]
  readonly warnings: readonly { code: string; message: string }[]
}> {
  const warnings: { code: string; message: string }[] = []
  if (additions.length === 0) return { toInsert: [], warnings }
  const current = await listInterviewers(client, tenantId, interviewId)
  const existing = new Set(current.map((row) => row.actor_id.toLowerCase()))
  const toInsert = additions.filter((addition) => {
    if (!existing.has(addition.actor_id)) return true
    warnings.push({
      code: 'ALREADY_ASSIGNED',
      message: `面试官 ${addition.actor_id} 已在该场次，忽略本次新增（幂等语义，不报错）`,
    })
    return false
  })
  await assertInterviewerActors(client, tenantId, toInsert.map((row) => row.actor_id))
  return { toInsert, warnings }
}

/**
 * `RESCHEDULE` 的换会议（`scheduling-rules.md` §4.2 第 2 步）：
 * 旧 binding 解绑（`unbound_at` + 非空 `unbound_reason`）→ 旧 meeting 标 `REPLACED`（保留历史）→
 * 新 meeting + 新 binding（`binding_method='SCHEDULED'`）。**只登记平台 ID，不发任何外部调用**（H-2）。
 */
async function bindMeetingForReschedule(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  interviewId: string,
  meeting: ScheduleMeetingArgs,
  created: ChangeRow[],
  updated: ChangeRow[],
  warnings: { code: string; message: string }[],
): Promise<void> {
  const tenantId = config.tenant_id
  let meetingId = await findMeetingRowId(client, tenantId, meeting)

  if (meetingId !== undefined) {
    const active = await findActiveBindingOfMeeting(client, tenantId, meetingId)
    if (active !== undefined && active.interview_id !== interviewId) {
      throw meetingAlreadyBoundError({
        meeting_id: meetingId,
        existing_interview_id: active.interview_id,
        existing_binding_id: active.id,
        this_interview_id: interviewId,
      })
    }
    if (active !== undefined) {
      // 目标会议已经绑在这场面试上：换会议是空操作，也不解绑别的会议（避免把"复用"写成破坏）。
      return
    }
  }

  // 解绑旧的 active binding（除目标会议），旧 meeting → REPLACED。
  for (const binding of await listActiveBindings(client, tenantId, interviewId)) {
    if (binding.meeting_id === meetingId) continue
    const unbound = await client.query(
      `update recruitment.meeting_binding
          set unbound_at = now(), unbound_reason = $1, updated_at = now()
        where id = $2 and tenant_id = $3 and unbound_at is null`,
      [UNBOUND_REASON_RESCHEDULED, binding.binding_id, tenantId],
    )
    if ((unbound.rowCount ?? 0) > 0) updated.push({ table: 'meeting_binding', id: binding.binding_id })
    if (binding.meeting_role !== 'REPLACED') {
      const replaced = await client.query(
        `update recruitment.meeting
            set meeting_role = 'REPLACED', updated_at = now()
          where id = $1 and tenant_id = $2`,
        [binding.meeting_id, tenantId],
      )
      if ((replaced.rowCount ?? 0) > 0) updated.push({ table: 'meeting', id: binding.meeting_id })
    }
  }

  // TR-B1：每条面试至多 1 个 PRIMARY；已有 PRIMARY → 本次强制 CONTINUATION + 告警。
  let role = meeting.meeting_role
  const remaining = await listActiveBindings(client, tenantId, interviewId)
  if (role === 'PRIMARY' && remaining.some((binding) => binding.meeting_role === 'PRIMARY')) {
    role = 'CONTINUATION'
    warnings.push({
      code: 'MEETING_ROLE_DOWNGRADED',
      message: '该面试已有 PRIMARY 会议，本次 meeting_role 被强制为 CONTINUATION（TR-B1）',
    })
  }

  if (meetingId === undefined) {
    meetingId = await insertMeetingRow(client, tenantId, meeting, role)
    created.push({ table: 'meeting', id: meetingId })
  } else {
    // 复用未绑定的旧行：角色以本次绑定的意图为准（REPLACED/CANCELLED 的旧行要能被重新启用）。
    const oldRole = await client.query<{ meeting_role: string }>(
      `select meeting_role from recruitment.meeting where id = $1 and tenant_id = $2`,
      [meetingId, tenantId],
    )
    if (oldRole.rows[0]?.meeting_role !== role) {
      await client.query(
        `update recruitment.meeting set meeting_role = $1, updated_at = now() where id = $2 and tenant_id = $3`,
        [role, meetingId, tenantId],
      )
      updated.push({ table: 'meeting', id: meetingId })
    }
    warnings.push({
      code: 'BINDING_REUSED',
      message: `复用已存在的 meeting 行 ${meetingId}（未绑定），未新建 meeting`,
    })
  }

  created.push({
    table: 'meeting_binding',
    id: await insertBindingRow(client, tenantId, meetingId, interviewId, config.actor_id),
  })
}

/**
 * `intent=RESCHEDULE` 的**只读准备段**（§4.2 改期三步；**改同一行**，H-1）。
 * 状态结论按 §4.2 表：给了新时间 → `SCHEDULED`（本工具要求至少给 start/duration，故不会产出 `RESCHEDULED`）。
 *
 * 行锁是参数化的：只读准备阶段 `options.forUpdate === false`（只读事务里 `FOR UPDATE` 会 25006），
 * 写事务复校验 `true`（与两阶段之前同一把行锁语义）。
 */
async function prepareRescheduleCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: RescheduleCommand,
  nowMs: number,
  asOfIso: string,
  options: SchedulePrepareOptions,
): Promise<SchedulePreparation> {
  const tenantId = config.tenant_id

  // 1. 幂等 STORE（重放优先于时点/状态判定：旧时间已过去也要能重放）。
  const store = await loadStore(client, tenantId, args.idempotency_key)
  if (store !== null) {
    return { kind: 'result', value: await replayFromStore(client, config, store, args, asOfIso) }
  }

  // 2. 目标行 + 乐观并发 + 状态机（§4.4 / §8）。
  const row = await loadInterviewForUpdate(client, tenantId, args.interview_id, options.forUpdate)
  assertExpectedVersion(row, args.expected_record_version, args.interview_id)
  assertStatusAllowed(row, RESCHEDULABLE_STATUSES, 'RESCHEDULE')

  // 3. 新窗口：缺的那一半沿用现有值（`RESCHEDULED` 行可能没有时间）。
  const currentStartMs = row.scheduled_start_at === null ? null : new Date(row.scheduled_start_at).getTime()
  const currentEndMs = row.scheduled_end_at === null ? null : new Date(row.scheduled_end_at).getTime()
  const startMs = args.start_ms ?? currentStartMs
  if (startMs === null) {
    fail(
      'MISSING_REQUIRED',
      '该场面试当前没有有效时间（RESCHEDULED 行），必须给 scheduled_start_at 才能重排',
      { path: 'scheduled_start_at', interview_id: args.interview_id },
    )
  }
  let durationMinutes = args.duration_minutes
  if (durationMinutes === undefined) {
    if (currentStartMs === null || currentEndMs === null) {
      fail(
        'MISSING_REQUIRED',
        '该场面试没有可推断的时长（scheduled_end_at 为空），必须给 duration_minutes',
        { path: 'duration_minutes', interview_id: args.interview_id },
      )
    }
    durationMinutes = Math.round((currentEndMs - currentStartMs) / 60_000)
    if (!Number.isInteger(durationMinutes)
      || durationMinutes < MIN_DURATION_MINUTES || durationMinutes > MAX_DURATION_MINUTES) {
      fail(
        'DURATION_OUT_OF_RANGE',
        `现有窗口换算出的时长 ${durationMinutes} 不是 ${MIN_DURATION_MINUTES}..${MAX_DURATION_MINUTES} 的整数分钟`,
        { path: 'duration_minutes', value: durationMinutes },
      )
    }
  }
  const endMs = startMs + durationMinutes * 60_000
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()
  // A5：改期后的窗口必须在未来（重放已在上一步返回，所以不影响重放）。
  if (startMs <= nowMs) {
    fail(
      'START_IN_PAST',
      `改期后的 scheduled_start_at 必须晚于当前时间（收到 ${startIso}）`,
      { path: 'scheduled_start_at', value: startIso, now: asOfIso },
    )
  }

  // 4. 面试官新增（不删行；已在该场的只告警）。
  const addition = await resolveInterviewerAdditions(
    client, tenantId, args.interview_id, args.interviewer_additions,
  )
  const warnings: { code: string; message: string }[] = [...addition.warnings]

  // 5. 冲突重算（§4.2 第 1 步：对新窗口重跑 §3.2，**排除自己**）。
  const currentInterviewers = await listInterviewers(client, tenantId, args.interview_id)
  const actorIds = [...new Set([
    ...currentInterviewers.map((interviewer) => interviewer.actor_id.toLowerCase()),
    ...addition.toInsert.map((interviewer) => interviewer.actor_id),
  ])]
  const candidateId = await loadCandidateOfInterview(client, tenantId, args.interview_id)
  const bufferMinutes = await readBufferMinutes(client, tenantId)
  const bufferedEndIso = new Date(endMs + bufferMinutes * 60_000).toISOString()
  const interviewerConflicts = await findInterviewerConflicts(
    client, tenantId, actorIds, startIso, bufferedEndIso, args.interview_id,
  )
  const candidateConflicts = await findCandidateConflicts(
    client, tenantId, candidateId, startIso, endIso, args.interview_id,
  )
  const conflicts = sortConflicts([...interviewerConflicts, ...candidateConflicts])
  if (conflicts.length > 0) {
    throw conflictSlotError(conflicts, interviewerConflicts.length > 0, startIso, bufferedEndIso, bufferMinutes)
  }

  // 6. 计划就绪：**不在这里问人**。闸门由调用方在事务外（`execute()`）或调用方事务里
  //    （`scheduleInTransaction`）执行；只读准备阶段也不写库。
  return {
    kind: 'write',
    plan: {
      intent: 'RESCHEDULE',
      command: args,
      row,
      startIso,
      endIso,
      durationMinutes,
      additions: addition.toInsert,
      warnings,
      asOfIso,
    },
  }
}

/**
 * `intent=RESCHEDULE` 的**写入段**（全部校验已过、D-79 闸门已放行）：换会议 / 加面试官 /
 * 改同一行 / 审计事件 / 幂等 STORE / 读回。任何失败由外层保存点撤销。
 * @param client - 写事务内客户端。
 * @param config - 已解析的配置。
 * @param plan - 只读准备段给出的写库计划（行锁已由复校验持有）。
 * @returns 契约出参。
 */
async function writeRescheduleCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  plan: Extract<ScheduleWritePlan, { readonly intent: 'RESCHEDULE' }>,
): Promise<Record<string, unknown>> {
  const args = plan.command
  const asOfIso = plan.asOfIso
  const row = plan.row
  const startIso = plan.startIso
  const endIso = plan.endIso
  const durationMinutes = plan.durationMinutes
  const warnings = plan.warnings
  const tenantId = config.tenant_id
  const actorId = config.actor_id

  // 7. 写（同一事务；任何失败由外层保存点撤销）。
  const created: ChangeRow[] = []
  const updated: ChangeRow[] = []

  // 7a. 换会议（给了 `meeting` 才动；不给 = 保持现有绑定）。
  if (args.meeting !== undefined) {
    await bindMeetingForReschedule(client, config, args.interview_id, args.meeting, created, updated, warnings)
  }

  // 7b. 新增面试官。
  for (const interviewer of plan.additions) {
    const inserted = await client.query<{ id: string }>(
      `insert into recruitment.interviewer
         (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
       values ($1, $2, $3, $4, $5, $6::timestamptz)
       returning id`,
      [
        tenantId,
        args.interview_id,
        interviewer.actor_id,
        interviewer.role_in_interview,
        interviewer.required_scorecard,
        interviewer.scorecard_due_at ?? null,
      ],
    )
    const insertedRow = inserted.rows[0]
    if (insertedRow === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'interviewer insert returned no row')
    }
    created.push({ table: 'interviewer', id: insertedRow.id })
  }

  // 7c. UPDATE 同一行（H-1）。状态按 §4.2：`SCHEDULED` 保持，`RESCHEDULED`/`CANCELLED` 回到 `SCHEDULED`。
  //     两条 SQL 的参数表**分开给**（PG 不允许参数编号出现空洞：未引用的 $n 会报 42P18）。
  const statusChanging = row.status !== 'SCHEDULED'
  const changed = statusChanging
    ? await client.query<{ id: string }>(
      `update recruitment.interview
          set scheduled_start_at = $1::timestamptz, scheduled_end_at = $2::timestamptz,
              status = 'SCHEDULED', status_changed_by_actor_id = $3
        where id = $4 and tenant_id = $5 and record_version = $6
        returning id`,
      [startIso, endIso, actorId, args.interview_id, tenantId, args.expected_record_version],
    )
    : await client.query<{ id: string }>(
      `update recruitment.interview
          set scheduled_start_at = $1::timestamptz, scheduled_end_at = $2::timestamptz
        where id = $3 and tenant_id = $4 and record_version = $5
        returning id`,
      [startIso, endIso, args.interview_id, tenantId, args.expected_record_version],
    )
  if (changed.rows[0] === undefined) {
    // 行锁已拿住仍 0 行 = 版本被并发改动（防御性翻译，不抛 500）。
    const fresh = await loadInterviewForUpdate(client, tenantId, args.interview_id)
    throw versionConflictError(args.interview_id, args.expected_record_version, fresh.record_version)
  }
  updated.push({ table: 'interview', id: args.interview_id })

  // 7d. 显式审计事件（§4.4 / §11-①：同状态改时间不会触发 fn_row_guard，服务层必须自己写）。
  const rescheduleNo = await countInterviewEvents(
    client, tenantId, RESCHEDULE_EVENT_TYPE, args.interview_id,
  ) + 1
  const eventId = await insertInternalEvent(client, tenantId, {
    eventType: RESCHEDULE_EVENT_TYPE,
    idempotencyKey: auditEventKey(args, RESCHEDULE_EVENT_TYPE),
    sourceObjectId: args.interview_id,
    payload: compact({
      interview_id: args.interview_id,
      from: compact({
        start: row.scheduled_start_at === null ? undefined : toIso(row.scheduled_start_at),
        end: row.scheduled_end_at === null ? undefined : toIso(row.scheduled_end_at),
      }),
      to: { start: startIso, end: endIso },
      actor_id: actorId,
      reason: args.reason,
      reschedule_no: rescheduleNo,
      status_from: row.status,
      status_to: 'SCHEDULED',
    }),
  })
  created.push({ table: 'event_inbox', id: eventId })

  // 8. 幂等 STORE。
  const storeWrite = await insertStoreCommand(
    client,
    config,
    args,
    args.interview_id,
    `面试改期：第 ${row.round_no} 轮 ${row.slot_code}`,
    `RESCHEDULE interview ${args.interview_id} → ${startIso}（${durationMinutes} 分钟）`,
  )
  if (storeWrite.kind === 'conflict') return await replayAfterStoreConflict(client, config, args, asOfIso)
  created.push({ table: 'business_task', id: storeWrite.taskId })

  return await buildCommandResult(
    client, config, args, args.interview_id, asOfIso, { created, updated }, warnings, [],
  )
}

/**
 * `intent=CANCEL` 的**只读准备段**（§6：行保留、面评保留、`status='CANCELLED'`）。
 * 已 `CANCELLED` 的重复取消 → 幂等成功且**零写入**（§6.1；连 STORE 也不写，见函数内注释）——
 * 这个分支**不问人**，直接返回 `result`。
 */
async function prepareCancelCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: CancelCommand,
  asOfIso: string,
  options: SchedulePrepareOptions,
): Promise<SchedulePreparation> {
  const tenantId = config.tenant_id

  const store = await loadStore(client, tenantId, args.idempotency_key)
  if (store !== null) {
    return { kind: 'result', value: await replayFromStore(client, config, store, args, asOfIso) }
  }

  const row = await loadInterviewForUpdate(client, tenantId, args.interview_id, options.forUpdate)
  assertExpectedVersion(row, args.expected_record_version, args.interview_id)

  // §6.1：`CANCELLED` 上重复取消是幂等成功，"成功且不写行、不重复写事件"。
  // 这里连幂等 STORE 都不写（§6.1 的"不写行"取强口径）；重试仍安全：状态检查本身就是幂等的，
  // 两次调用返回同一个库内事实（输出只差 `replayed` 标记）。
  if (row.status === 'CANCELLED') {
    return {
      kind: 'result',
      value: await buildCommandResult(
        client, config, args, args.interview_id, asOfIso, { created: [], updated: [] }, [], [],
      ),
    }
  }
  assertStatusAllowed(row, CANCELLABLE_STATUSES, 'CANCEL')

  // 计划就绪：闸门由调用方执行（事务外 / 测试接缝）；只读准备段不写库。
  return { kind: 'write', plan: { intent: 'CANCEL', command: args, row, asOfIso } }
}

/**
 * `intent=CANCEL` 的**写入段**（全部校验已过、D-79 闸门已放行）：改状态 / 释放未发生会议 /
 * 审计事件 / 幂等 STORE / 读回。任何失败由外层保存点撤销。
 * @param client - 写事务内客户端。
 * @param config - 已解析的配置。
 * @param plan - 只读准备段给出的写库计划（行锁已由复校验持有）。
 * @returns 契约出参。
 */
async function writeCancelCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  plan: Extract<ScheduleWritePlan, { readonly intent: 'CANCEL' }>,
): Promise<Record<string, unknown>> {
  const args = plan.command
  const asOfIso = plan.asOfIso
  const row = plan.row
  const tenantId = config.tenant_id
  const actorId = config.actor_id

  const created: ChangeRow[] = []
  const updated: ChangeRow[] = []

  // 1. UPDATE 同一行 → CANCELLED（fn_row_guard 自动写 `interview.status.changed` 事件）。
  const cancelled = await client.query<{ id: string }>(
    `update recruitment.interview
        set status = 'CANCELLED', status_changed_by_actor_id = $1
      where id = $2 and tenant_id = $3 and record_version = $4
      returning id`,
    [actorId, args.interview_id, tenantId, args.expected_record_version],
  )
  if (cancelled.rows[0] === undefined) {
    const fresh = await loadInterviewForUpdate(client, tenantId, args.interview_id)
    throw versionConflictError(args.interview_id, args.expected_record_version, fresh.record_version)
  }
  updated.push({ table: 'interview', id: args.interview_id })

  // 2. 会议（SC-X6）：未发生 → 解绑 + `meeting_role='CANCELLED'`；已发生 → 不解绑（仍可能有材料要取）。
  for (const binding of await listActiveBindings(client, tenantId, args.interview_id)) {
    if (binding.actual_start_at !== null) continue
    const unbound = await client.query(
      `update recruitment.meeting_binding
          set unbound_at = now(), unbound_reason = $1, updated_at = now()
        where id = $2 and tenant_id = $3 and unbound_at is null`,
      [UNBOUND_REASON_CANCELLED, binding.binding_id, tenantId],
    )
    if ((unbound.rowCount ?? 0) > 0) updated.push({ table: 'meeting_binding', id: binding.binding_id })
    if (binding.meeting_role !== 'CANCELLED') {
      const marked = await client.query(
        `update recruitment.meeting
            set meeting_role = 'CANCELLED', updated_at = now()
          where id = $1 and tenant_id = $2`,
        [binding.meeting_id, tenantId],
      )
      if ((marked.rowCount ?? 0) > 0) updated.push({ table: 'meeting', id: binding.meeting_id })
    }
  }

  // 3. 显式审计事件（SC-X5：`interview` 没有 cancel_reason 列，理由只能落事件 payload）。
  const eventId = await insertInternalEvent(client, tenantId, {
    eventType: CANCEL_EVENT_TYPE,
    idempotencyKey: auditEventKey(args, CANCEL_EVENT_TYPE),
    sourceObjectId: args.interview_id,
    payload: {
      interview_id: args.interview_id,
      reason: args.reason,
      from_status: row.status,
      to_status: 'CANCELLED',
      actor_id: actorId,
    },
  })
  created.push({ table: 'event_inbox', id: eventId })

  // 4. 幂等 STORE。
  const storeWrite = await insertStoreCommand(
    client,
    config,
    args,
    args.interview_id,
    `面试取消：第 ${row.round_no} 轮 ${row.slot_code}`,
    `CANCEL interview ${args.interview_id}（${args.reason}）`,
  )
  if (storeWrite.kind === 'conflict') return await replayAfterStoreConflict(client, config, args, asOfIso)
  created.push({ table: 'business_task', id: storeWrite.taskId })

  return await buildCommandResult(
    client, config, args, args.interview_id, asOfIso, { created, updated }, [], [],
  )
}

/** 该 interviewer 行是否已有 `interviewer.withdrawn` 事件（§4.3 / §11-⑦：退出只看事件，不看布尔值）。 */
async function countInterviewerWithdrawEvents(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  interviewerId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n
       from recruitment.event_inbox
      where tenant_id = $1 and event_type = $2
        and payload->>'interview_id' = $3 and payload->>'interviewer_id' = $4`,
    [tenantId, WITHDRAW_EVENT_TYPE, interviewId, interviewerId],
  )
  return rows[0]?.n ?? 0
}

/**
 * `intent=WITHDRAW_INTERVIEWER` 的**只读准备段**（§4.3）：
 * **不改 `interview.status`**，`required_scorecard=false` + `interviewer.withdrawn` 事件，
 * 并在同一事务里 touch `interview` 借版本（SC-K7：`interviewer` 没有 `record_version` 列）。
 * 已退出（有事件）→ 幂等成功且零写入 → 直接返回 `result`（**不问人**）。
 *
 * `for update of i` 同样参数化：只读准备阶段不允许行锁（25006），写事务复校验才加。
 */
async function prepareWithdrawInterviewerCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: WithdrawInterviewerCommand,
  asOfIso: string,
  options: SchedulePrepareOptions,
): Promise<SchedulePreparation> {
  const tenantId = config.tenant_id

  const store = await loadStore(client, tenantId, args.idempotency_key)
  if (store !== null) {
    return { kind: 'result', value: await replayFromStore(client, config, store, args, asOfIso) }
  }

  const loaded = await client.query<InterviewerCommandRow>(
    `select r.id, r.interview_id, r.actor_id, r.required_scorecard,
            i.status as interview_status, i.record_version
       from recruitment.interviewer r
       join recruitment.interview i
         on i.id = r.interview_id and i.tenant_id = r.tenant_id
      where r.id = $1 and r.tenant_id = $2${options.forUpdate ? ' for update of i' : ''}`,
    [args.interviewer_id, tenantId],
  )
  const row = loaded.rows[0]
  if (row === undefined) {
    // `interviewer_id` 必须属于**本租户**的面试（跨租户一律 NOT_FOUND，不确认对方存在）。
    throw contractError('NOT_FOUND', {
      reason_code: 'INTERVIEWER_NOT_FOUND',
      message: `该租户下没有 interviewer 行 ${args.interviewer_id}`,
      detail: { interviewer_id: args.interviewer_id },
    })
  }
  if (row.record_version !== args.expected_record_version) {
    throw versionConflictError(row.interview_id, args.expected_record_version, row.record_version)
  }

  // 已退出（有 `interviewer.withdrawn` 事件）→ 幂等成功且零写入（不重复写事件、不重复 touch 版本）。
  if (await countInterviewerWithdrawEvents(client, tenantId, row.interview_id, row.id) > 0) {
    return {
      kind: 'result',
      value: await buildCommandResult(
        client, config, args, row.interview_id, asOfIso, { created: [], updated: [] }, [], [],
      ),
    }
  }

  // 计划就绪：闸门由调用方执行（事务外 / 测试接缝）；只读准备段不写库。
  return { kind: 'write', plan: { intent: 'WITHDRAW_INTERVIEWER', command: args, row, asOfIso } }
}

/**
 * `intent=WITHDRAW_INTERVIEWER` 的**写入段**（全部校验已过、D-79 闸门已放行）：
 * touch `interview` 借版本 → `required_scorecard=false` → 审计事件 → 幂等 STORE → 读回。
 * @param client - 写事务内客户端。
 * @param config - 已解析的配置。
 * @param plan - 只读准备段给出的写库计划（行锁已由复校验持有）。
 * @returns 契约出参。
 */
async function writeWithdrawInterviewerCommand(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  plan: Extract<ScheduleWritePlan, { readonly intent: 'WITHDRAW_INTERVIEWER' }>,
): Promise<Record<string, unknown>> {
  const args = plan.command
  const asOfIso = plan.asOfIso
  const row = plan.row
  const tenantId = config.tenant_id

  const created: ChangeRow[] = []
  const updated: ChangeRow[] = []

  // 1. touch `interview`（SC-K7：面试官集合变更必须借 interview 的版本，否则并发"各加一人"互不可见）。
  const touched = await client.query<{ id: string }>(
    `update recruitment.interview
        set updated_at = now()
      where id = $1 and tenant_id = $2 and record_version = $3
      returning id`,
    [row.interview_id, tenantId, args.expected_record_version],
  )
  if (touched.rows[0] === undefined) {
    const fresh = await loadInterviewForUpdate(client, tenantId, row.interview_id)
    throw versionConflictError(row.interview_id, args.expected_record_version, fresh.record_version)
  }
  updated.push({ table: 'interview', id: row.interview_id })

  // 2. `required_scorecard = false`（不删行：`trg_interviewer_no_delete`；也不改 actor）。
  if (row.required_scorecard) {
    await client.query(
      `update recruitment.interviewer
          set required_scorecard = false, updated_at = now()
        where id = $1 and tenant_id = $2`,
      [row.id, tenantId],
    )
    updated.push({ table: 'interviewer', id: row.id })
  }

  // 3. 显式审计事件（§4.3 第 2 步：payload 必须含 interview_id/actor_id/interviewer_id/reason/effective_from）。
  const eventId = await insertInternalEvent(client, tenantId, {
    eventType: WITHDRAW_EVENT_TYPE,
    idempotencyKey: auditEventKey(args, WITHDRAW_EVENT_TYPE),
    sourceObjectId: row.id,
    payload: {
      interview_id: row.interview_id,
      actor_id: row.actor_id,
      interviewer_id: row.id,
      reason: args.reason,
      effective_from: asOfIso,
    },
  })
  created.push({ table: 'event_inbox', id: eventId })

  // 4. 幂等 STORE。
  const storeWrite = await insertStoreCommand(
    client,
    config,
    args,
    row.interview_id,
    `面试官退出：${row.actor_id}`,
    `WITHDRAW_INTERVIEWER ${row.id}（${args.reason}）`,
  )
  if (storeWrite.kind === 'conflict') return await replayAfterStoreConflict(client, config, args, asOfIso)
  created.push({ table: 'business_task', id: storeWrite.taskId })

  return await buildCommandResult(
    client, config, args, row.interview_id, asOfIso, { created, updated }, [], [],
  )
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
      // 显示名缺失时**不能**退回完整 actor_id（内部编号不进人读正文）→ 用短号。
      const name = typeof row.display_name === 'string' && row.display_name !== ''
        ? row.display_name
        : shortRef(typeof row.actor_id === 'string' ? row.actor_id : undefined)
      const role = typeof row.role_in_interview === 'string' ? row.role_in_interview : '?'
      const required = row.required_scorecard === true ? 'required' : 'optional'
      return `${name}(${role}, ${required})`
    })
    .join(' · ')
}

/** `changes.*[].table` → 人读业务说法（表名是实现细节，不念给 HR；未知表名原样保留）。 */
const CHANGE_TABLE_LABELS: Record<string, string> = {
  interview: '面试场次',
  interviewer: '面试官',
  meeting: '会议',
  meeting_binding: '会议绑定',
  business_task: '待办任务',
  event_inbox: '审计事件',
}

/** 取结构化值里的字符串（缺失 = 空串；`machineArgumentLines` 会过滤空值）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 告警文案里可能夹带的完整 UUID（8-4-4-4-12）。 */
const UUID_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** 告警文案里可能夹带的 32+ 连续 hex（去连字符 UUID / sha256）。 */
const LONG_HEX_TEXT_RE = /\b[0-9a-f]{32,}\b/gi

/**
 * 把告警文案里的内部编号收成短号。
 *
 * 为什么在 render 里做而不是改来源：`warnings[].message` 是**结构化值**（业务层拼好的句子，
 * 例如 ALREADY_ASSIGNED 带上完整 actor_id、BINDING_REUSED 带上完整 meeting id），结构化字段
 * 一个都不许改；而模型只读 render 文本，所以在这里收口，正文不再出现完整编号。
 * @param message - 业务层给的告警原文。
 * @returns 编号换成短号后的文案。
 */
function scrubInternalRefs(message: string): string {
  return message
    .replace(UUID_TEXT_RE, (match) => shortRef(match))
    .replace(LONG_HEX_TEXT_RE, (match) => shortHash(match))
}

/** 排期工具的依赖：库配置保持第一个位置参数，approval / identity 是可选的第二组依赖。 */
export interface InterviewScheduleDeps extends ToolActorDeps {
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
 * 造真实的排期工具（D-62 四合一 intent：CREATE / RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER）。
 *
 * `execute()` 是 **D-101 两阶段**：① `withReadOnly` 只读事务里 `prepareSchedule`（幂等判定 +
 * 全部业务校验 + 写库计划，行锁 `forUpdate:false`）→ 事务提交、连接归还；② 重放 /
 * 零写入的幂等成功直接返回、不问人；③ 否则 `requireApprovalGranted(await approve())` 在
 * **事务外**问人（等人期间不占连接）；④ `withActor` 写事务里重跑 `prepareSchedule`
 * （`forUpdate:true`）复校验再 `writeSchedule`；`finally` 关池。
 * @param config - 已解析的数据库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖；`approval` 缺省时写库一律被拒（D-79 fail closed）；
 *   `identity` 由 `src/index.ts` 装配（产品路径），缺省 = 仅测试兼容的 legacy actor。
 */
export function createInterviewScheduleTool(
  config: ResolvedDatabaseConfig,
  deps: InterviewScheduleDeps = {},
): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S8 interview scheduling with four intents (D-62): CREATE (default) creates one interview session '
      + '(application_id + round_no + slot_code) with its interviewer rows and optionally registers an existing '
      + 'meeting + binding; RESCHEDULE moves the SAME interview row to a new time (at least one of '
      + 'scheduled_start_at / duration_minutes), re-runs the conflict check on the new window excluding itself, '
      + 'optionally replaces the meeting (old binding unbound + old meeting marked REPLACED) and adds interviewers '
      + '(add-only; already assigned => warning ALREADY_ASSIGNED); CANCEL marks SCHEDULED/RESCHEDULED as CANCELLED '
      + 'with a required reason and releases not-yet-happened meetings (already-cancelled => idempotent success, '
      + 'zero writes); WITHDRAW_INTERVIEWER clears that interviewer\'s required_scorecard (never deletes the row, '
      + 'never changes interview.status) and records an interviewer.withdrawn event. There is NO COMPLETE intent: '
      + 'post-interview edges belong to S9. '
      + 'Every intent shares one pipeline: caller-generated idempotency_key (same key + same arguments replays the '
      + 'first result with replayed=true and empty changes; same key + different arguments fails with '
      + 'INVALID_ARGS(IDEMPOTENCY_KEY_REUSED)), optimistic concurrency via expected_record_version on '
      + 'RESCHEDULE/CANCEL/WITHDRAW_INTERVIEWER (0-row update => VERSION_CONFLICT), the §8 state machine '
      + '(illegal edge => INVALID_ARGS(INVALID_STATE_TRANSITION)), and one D-79 human approval gate after every '
      + 'parameter/business check and BEFORE the first write (missing/unavailable answerer => rejected => nothing '
      + 'written; FORBIDDEN with reason_code; 120s timeout => cancelled). Failures write nothing (savepoint rollback). '
      + 'Audit facts that no column can hold are written explicitly to event_inbox: interview.rescheduled '
      + '(from/to/actor/reason/reschedule_no), interview.cancelled (reason) and interviewer.withdrawn '
      + '(interview_id/actor_id/interviewer_id/reason/effective_from). '
      + 'It never calls any external system (no calendar creation, no invitations), so labels.connection is always '
      + 'NOT_CONNECTED and effects.external_call_made is always false. labels.provenance is computed from the '
      + 'tenant\'s synthetic marker (FIXTURE unless the tenant is explicitly declared non-synthetic; never '
      + 'hard-coded LIVE) and labels.trigger is always MANUAL. '
      + 'Semantic idempotency is independent of the key: CREATE on an existing (application_id, round_no, slot_code) '
      + '— any status, including CANCELLED — fails with ALREADY_SCHEDULED. Interviewer and candidate conflicts '
      + 'reject the request with CONFLICT_SLOT and write nothing. Omitting meeting on CREATE is allowed and honest: '
      + 'the interview is still scheduled, warning MEETING_NOT_BOUND is returned and an INTERVIEW_MEETING_BIND task '
      + 'is created (next_actions BIND_MEETING). This tool never writes scorecards or decisions.',
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
        // O1 残留修复：人读正文只给业务标识（第几轮 / slot / 阶段 / 状态 / 面试官）与短号。
        // 完整 interview id 只出现在末尾 machine arguments 区 —— S9/S10 的下游工具
        // （interview_get / transcript_import / scorecard_submit / evaluation_summarize）的参数
        // 校验是严格 UUID（短号解析不了），而新建出来的 interview id 模型只能从本工具发现。
        const interviewId = textOf(interview.id)
        const applicationId = textOf(interview.application_id)
        const lines: string[] = [
          `面试 第${String(interview.round_no)}轮 slot=${String(interview.slot_code)} `
            + `[${String(interview.status)}] 阶段=${String(interview.stage_code)} `
            + `· 本场 ${shortRef(interviewId)}  ${windowLine(interview)}`,
          `  申请 ${shortRef(applicationId)} · 候选人 ${shortRef(textOf(interview.candidate_id))} `
            + `· 岗位 ${shortRef(textOf(interview.job_id))} · timezone=${String(interview.timezone)}`,
          `  interviewers: ${interviewersLine(interview)}`,
          `  meeting_binding: ${binding === null ? 'unknown' : String(binding.state)} `
            + `(${binding === null ? 0 : String(binding.count)} active)`,
          `  intent=${String(v.intent)} replayed=${String(v.replayed)}  changes.created=${created.length}  `
            + `labels: ${String(labels.provenance)}/${String(labels.trigger)}/${String(labels.connection)}`,
        ]
        for (const change of created) {
          if (isPlainObject(change)) {
            const table = textOf(change.table)
            lines.push(`    + 新建 ${CHANGE_TABLE_LABELS[table] ?? (table === '' ? '记录' : table)} `
              + `${shortRef(textOf(change.id))}`)
          }
        }
        for (const warning of warnings) {
          if (isPlainObject(warning)) {
            lines.push(`  warning ${String(warning.code)}: ${scrubInternalRefs(String(warning.message))}`)
          }
        }
        for (const action of nextActions) {
          if (isPlainObject(action)) {
            // 待办 task id 不是任何已注册工具的入参 → 只给短号（保留可追溯性，不念内部编号）。
            lines.push(`  next: 已建绑定会议待办（${String(action.code)}）${shortRef(textOf(action.task_id))} `
              + `· 截止 ${String(action.due_at)}`)
          }
        }
        // 机器参数区：interview_id 是 S9/S10 下游工具的必填入参；application_id 是
        // evaluation_summarize / record_human_decision 的必填入参，而 RESCHEDULE / CANCEL /
        // WITHDRAW_INTERVIEWER 路径下模型此前只拿到 interview_id、从没拿过 application_id。
        // 完整值只允许出现在这里（header 逐字带"不要给用户看"的告诫）。
        lines.push(...machineArgumentLines([
          { key: 'interview_id', value: interviewId },
          { key: 'application_id', value: applicationId },
        ]))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先解析一次、两阶段共用：prepare（只读）与 write（写事务）看到的 actor 必须一致。
      // identity 已装配时任何缺失映射都在**建池/开事务之前** fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, config.actor_id)
      const writeConfig: ResolvedDatabaseConfig = { ...config, actor_id: writeActor.actor_id }
      // D-79：approval 缺省时 `makeApprovalRequest` 恒返回 `unavailable`（= 拒绝写库）。
      const approve = makeApprovalRequest(deps.approval, readExecContext(exec))
      const pool = createPool(config)
      try {
        // 形状校验是纯函数：非法入参在**碰库/问人之前**就拒（零 SQL、approval 调用数 = 0）。
        const command = parseScheduleShape(rawArgs)
        // ---- 阶段 1（D-101）：只读事务里做幂等判定 + 全部业务校验 + 写库计划 ----
        // 只读是数据库强制的（`begin transaction read only`）；行锁参数为 false（`FOR UPDATE` 会 25006）。
        const prepared = await withReadOnly(pool, async (client) =>
          prepareSchedule(client, writeConfig, command, Date.now(), { forUpdate: false }))
        // ---- 重放 / 零写入的幂等成功：直接返回，**不问人**（approval 调用次数 = 0）----
        if (prepared.kind === 'result') return prepared.value
        // ---- 阶段 2（D-79）：事务外问人。此刻没有任何事务/连接被占（不会 idle in transaction）----
        requireApprovalGranted(await approve())
        // ---- 阶段 3：写事务里**重跑 prepare 复校验**（行锁 `FOR UPDATE`，与旧行为一致）+ 写入 ----
        return await withActor(pool, writeActor.actor_id, async (client) =>
          inCommandSavepoint(client, async () => {
            const fresh = await prepareSchedule(client, writeConfig, command, Date.now(), { forUpdate: true })
            // 并发窗口内别人先提交了同一幂等键/同一状态：直接返回那个结果，不写库（TOCTOU 收窄）。
            if (fresh.kind === 'result') return fresh.value
            return await writeSchedule(client, writeConfig, fresh.plan)
          }))
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
      'S8 interview scheduling (CREATE / RESCHEDULE / CANCEL / WITHDRAW_INTERVIEWER). Currently NOT CONFIGURED: '
      + 'the plugin config is missing database settings (or the database password environment variable). '
      + 'Calls return NOT_CONFIGURED.',
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
