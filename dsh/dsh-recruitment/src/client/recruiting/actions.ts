// 招聘工作区（W2b）**写动作客户端契约层**：端点常量 / 信封解析 / body 组包 / 发送前自检 / 读回显示。
//
// 为什么单独一层：
//   · 写动作 body **必须**按契约逐个组包（`{}` 会被 400 MISSING_REQUIRED），组包与校验必须是纯函数，
//     否则无法在 `node --test` 里覆盖（组件没有 DOM 测试库，也不新增依赖）；
//   · 契约事实缺失时必须**不发请求**并给出精确 reasonCode，而不是让服务端猜；
//   · 成功事实只认响应信封的 `readback`（DB 独立读回）+ 随后重新 GET，本文件不做任何业务推断。
//
// 契约出处（逐字消费，不发明字段）：
//   · `work/d5/actions/CONTRACT.md` —— P0/P1/P2 端点 path/body/错误码/负例；
//   · `work/d5/w2b/INTERFACE.md` §2.1 —— 导出签名（`ActionOutcome` / `build*` / `readbackLines` 等）；
//   · `work/d5/w2b/INTERFACE2.md` §1/§2 —— decision facts / evaluate / record facade / job draft（覆盖旧 derive 段）；
//   · `work/d5/decision/CONTRACT.md` —— `GET /recruitment/api/decision/facts` 与三个新端点的响应形状；
//   · `work/d5/joblife/CONTRACT.md` §1 —— `job/close` 信封（`terminated` 八个计数键逐字）；
//   · `work/d5/joblife/CONTRACT-ACTIONS.md` —— `job/draft`、`job/create` body/响应。
//
// 硬约束：
//   · 本文件**不 import react、不碰 DOM、不发请求**（可被 `node --test` 直接 import）；
//   · 识别键/服务端派生键在组包末尾自检，命中即 `CLIENT_RESERVED_KEY`（服务端也会 400，但客户端不该发）；
//   · 任何需要服务端派生值（as_of / summary_digest / rubric payload_hash / evaluation digest）的字段，
//     只能从 facts 只读投影抄；facts 缺失 → `ok:false` + 精确 reasonCode。

import type { RecruitingErrorInfo } from './use-recruiting.ts'
import type { ActionView, ApplicationDetailView, SettingsView } from './view-model.ts'
import { count, items, numberOrNull, preview, record, stringList, text } from './format.ts'

// =====================================================================
//  端点常量（INTERFACE2 §1：A 写入并 re-export 给 B）
// =====================================================================

/** 决策事实只读投影（GET；`?application_id=<uuid>`）。 */
export const DECISION_FACTS_PATH = '/recruitment/api/decision/facts'
/** 执行初筛评估（POST，Human Host Action）。 */
export const DECISION_EVALUATE_PATH = '/recruitment/api/decision/screening/evaluate'
/** 正式决策 facade（POST，body 由服务端从 facts 组装 basis）。 */
export const DECISION_RECORD_PATH = '/recruitment/api/decision/record'
/** 岗位草案生成（POST，只读不写库）。 */
export const JOB_DRAFT_PATH = '/recruitment/api/job-action/job/draft'
/** 人确认后的岗位创建（POST）。 */
export const JOB_CREATE_PATH = '/recruitment/api/job-action/job/create'
/** 岗位关闭（POST；信封见 `work/d5/joblife/CONTRACT.md` §1）。 */
export const JOB_CLOSE_PATH = '/recruitment/api/job-action/job/close'

// =====================================================================
//  发送前自检：客户端永不上送的键
// =====================================================================

/**
 * 客户端永不上送的身份 / 服务端派生键（命中即 400 `ACTOR_OVERRIDE_REJECTED`，本层发送前就拒绝）。
 *
 * 出处：`work/d5/actions/CONTRACT.md` §0.4 的 11 个身份键 + 决策端点额外禁止的 5 个派生键。
 * 注意：只匹配**顶层精确键**；`basis_refs[].actor_id`、`interviewers[].actor_id` 是正常业务数据。
 */
export const ACTION_RESERVED_BODY_KEYS: readonly string[] = [
  // §0.4 身份键
  'actor_id',
  'tenant_id',
  'actor',
  'tenant',
  'alias',
  'actor_alias',
  'decided_by_actor_id',
  'confirmed_by_actor_id',
  'created_by_actor_id',
  'approved_by_actor_id',
  'submitted_by_actor_id',
  // 决策端点额外禁止（服务端派生：人工确认四要素 + decision 行字段）
  'human_confirmation',
  'approval_id',
  'stage_code',
  'decided_at',
  'status',
]

/** 决策端点封闭结果集（`HIRED` 在 v1.0 禁用）。 */
const SCREENING_RESULTS = ['ADVANCE', 'HOLD', 'WITHDRAW', 'REJECT'] as const
/** facade 决策结果集（`work/d5/decision/CONTRACT.md` §3）。 */
const RECORD_RESULTS = ['ADVANCE', 'HOLD', 'REJECT'] as const
/** 决策 scope。 */
const DECISION_SCOPES = ['STAGE', 'FINAL'] as const
/** transcript 来源封闭集（`work/d5/actions/CONTRACT.md` §3.2）。 */
const TRANSCRIPT_SOURCE_KINDS = ['PLATFORM_EXPORT', 'DEMO_SAMPLE'] as const
/** 设置实体封闭集（`work/d5/actions/CONTRACT.md` §4.2）。 */
const CONFIG_ENTITIES = ['role', 'team', 'pipeline'] as const
/** 设置写 operation 封闭集（读 operation 一律拒绝：`READ_OPERATION_NOT_EXPOSED`）。 */
const CONFIG_WRITE_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  role: ['create', 'update'],
  team: ['create', 'update', 'add_member', 'remove_member'],
  pipeline: ['create', 'update', 'add_stage', 'add_stage_template'],
}
/** 岗位创建初始状态（`src/tools/job-create.ts` 的 CREATE_STATUSES）。 */
const JOB_CREATE_STATUSES = ['DRAFT', 'OPEN'] as const
/** rubric criterion 的封闭 kind（`src/tools/job-create.ts`）。 */
const CRITERION_KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'DISQUALIFIER'] as const

/** UUID 文本形态（服务端 `isUuid` 同口径；不做版本位归一）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 64 位小写 hex（sha256 digest）。 */
const SHA256_RE = /^[0-9a-f]{64}$/
/** 带时区偏移的 ISO-8601（`Z` 或 `±HH:MM`；裸本地时间会被服务端拒绝）。 */
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
/** `idempotency_key` 字符集（`work/d5/actions/CONTRACT.md` §3.1）。 */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,200}$/
/** 岗位 code（`src/tools/job-create.ts`：`^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`）。 */
const JOB_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$/

// =====================================================================
//  通用形状
// =====================================================================

/** 一次写动作的最终结果（2xx 也不等于业务成功；业务事实看信封 `readback` + 重新 GET）。 */
export interface ActionOutcome {
  /** 动作键（`ActionView.key` / 端点名）。 */
  readonly key: string
  /** HTTP 2xx（**不代表业务成功**：成功事实只认 `envelope.readback` + 重新 GET）。 */
  readonly accepted: boolean
  /** HTTP 状态码（0 = 客户端拒绝 / 网络失败）。 */
  readonly status: number
  /** 标准写动作信封（含 `readback`）；非标准信封（evaluate/record/draft/create/job-close）为 null。 */
  readonly envelope: ActionEnvelope | null
  /** 失败信息（服务端 `{error:{code,reason_code,message}}` 原文）；成功为 null。 */
  readonly error: RecruitingErrorInfo | null
  /** 响应原文（≤2000 字符；界面显示"服务端原文"用）。 */
  readonly bodyText: string
  /** 2xx 响应体的宽松解析结果（非标准信封用它显示 readback/decision/evaluation 键值）。 */
  readonly payload: Readonly<Record<string, unknown>> | null
}

/** 标准写动作信封（`work/d5/actions/CONTRACT.md` §0.3）。 */
export interface ActionEnvelope {
  readonly action: string
  readonly actor: { readonly sessionId: string; readonly alias: string; readonly actorId: string }
  readonly approval: { readonly requested: number; readonly result: string; readonly toolNames: readonly string[] }
  readonly result: Readonly<Record<string, unknown>> | null
  readonly readback: Readonly<Record<string, unknown>> | null
}

/** `job/close` 200 信封（键名逐字对齐 `work/d5/joblife/CONTRACT.md` §1）。 */
export interface JobCloseEnvelope {
  readonly contractVersion: string
  readonly job: {
    readonly jobId: string
    readonly status: string
    readonly recordVersion: number
    readonly statusChangedAt: string
    readonly statusChangedByActorId: string
  }
  readonly terminated: {
    readonly applicationsTotal: number
    readonly applicationsClosed: number
    readonly applicationsAlreadyClosed: number
    readonly interviewsCancelled: number
    readonly interviewsAlreadyTerminal: number
    readonly interviewsOccurredKept: number
    readonly tasksCancelled: number
    readonly taskAttemptsCancelled: number
  }
  readonly actor: { readonly actorId: string; readonly alias: string; readonly displayName: string }
  readonly replayed: boolean
}

/** 表单预检结果：不满足契约 → 不出请求（`ok:false` 必带精确 reasonCode + missing 键）。 */
export type BodyBuildResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false
      readonly reasonCode: string
      readonly reasonText: string
      readonly missing: readonly string[]
    }

/** 读回区一行（键/值原样，不做业务推断）。 */
export interface ReadbackLine {
  readonly key: string
  readonly label: string
  readonly value: string
}

/** 发送前自检结果（不满足就不发请求：`CLIENT_REFUSED` / `CLIENT_RESERVED_KEY` …）。 */
export type WriteRequestCheck =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly status: 0
      readonly code: string
      readonly reasonCode: string
      readonly reasonText: string
      readonly missing: readonly string[]
    }

/** 造一个失败预检；reasonText 写给运维/验收看（含契约出处）。 */
function fail(reasonCode: string, reasonText: string, missing: readonly string[] = []): BodyBuildResult {
  return { ok: false, reasonCode, reasonText, missing: missing.length > 0 ? [...missing] : [reasonCode] }
}

/** 造一个成功预检。 */
function ok(body: Readonly<Record<string, unknown>>): BodyBuildResult {
  return { ok: true, body }
}

/** 精确保留键自检（顶层精确键；命中即服务端 400，客户端不该发出）。 */
function reservedKeysOf(body: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(body)
    .filter((key) => ACTION_RESERVED_BODY_KEYS.includes(key))
    .sort()
}

/** 组包末尾统一做保留键自检（所有 build* 共用，避免某条漏掉）。 */
function finish(body: Readonly<Record<string, unknown>>): BodyBuildResult {
  const reserved = reservedKeysOf(body)
  if (reserved.length > 0) {
    return fail(
      'CLIENT_RESERVED_KEY',
      `body 含客户端禁止上送的身份/服务端派生键：${reserved.join(', ')}（服务端会 400 ACTOR_OVERRIDE_REJECTED，客户端不发送）`,
      reserved,
    )
  }
  return ok(body)
}

/** 字符串是否 UUID 形态。 */
function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** 字符串是否带时区偏移的 ISO-8601。 */
function isOffsetIso(value: string): boolean {
  return value !== '' && OFFSET_ISO_RE.test(value) && Number.isFinite(Date.parse(value))
}

/** 校验一个必填 UUID 字段；不合法时把 missing 键追加进去。 */
function requireUuid(value: string, field: string, missing: string[]): boolean {
  if (value === '') {
    missing.push(field)
    return false
  }
  if (!isUuid(value)) {
    missing.push(`${field}:ID_NOT_UUID`)
    return false
  }
  return true
}

/** 字符串长度（按 Unicode 码点，避免 emoji 撑爆长度校验）。 */
function charLength(value: string): number {
  return Array.from(value).length
}

/** 取人话标题（读回行的 label：已知键给中文，未知键原样）。 */
const READBACK_LABELS: Readonly<Record<string, string>> = {
  application_id: '申请 id',
  job_id: '岗位 id',
  interview_id: '面试 id',
  decision_id: '决策 id',
  artifact_id: '产物 id',
  status: '状态',
  lifecycle_status: '申请状态',
  stage_code: '阶段码',
  record_version: '记录版本',
  actor_id: '执行账号 actor',
  stage_changed_at: '阶段变更时间',
  stage_entered_at: '进入阶段时间',
  decision_scope: '决策范围',
  result: '结论',
  decided_at: '决策时间',
  is_current: '是否当前有效',
  superseded_by_decision_id: '被取代为',
  round_no: '轮次',
  slot_code: '时段码',
  scheduled_start_at: '开始时间',
  scheduled_end_at: '结束时间',
  timezone: '时区',
  interviewers: '面试官分配',
  job: '岗位',
  rubric: '评分标准',
  approval: '审批',
  members: '团队成员',
  stages: '流水线阶段',
  meeting_id: '会议 id',
  provenance: '数据来源',
  trigger_mode: '触发方式',
  connection_state: '连接状态',
  content_sha256: '正文 sha256',
  segment_count: '分段数',
  replayed: '是否幂等重放',
  contract_version: '版本',
  'readback.table': '读回表',
  decision: '决策行',
  evaluation: '初筛评估',
  basis_refs: '决策依据（服务端组装）',
}

/** 任意值 → 原样文本（对象/数组 JSON 序列化并截断；不做业务翻译）。 */
function rawValueText(value: unknown, maxLength = 400): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === undefined) return ''
  const serialized = preview(value, maxLength)
  return serialized !== '' ? serialized : ''
}

// =====================================================================
//  响应解析（信封）
// =====================================================================

/** 把 2xx 响应体解析成普通对象；空体 / 非 JSON / 数组 → null（不编造）。 */
export function parseActionPayload(bodyText: string): Readonly<Record<string, unknown>> | null {
  const body = bodyText.trim()
  if (body === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

/** 解析标准写动作信封（`{action,actor,approval,result,readback}`）；不合法 → null。 */
export function parseActionEnvelope(bodyText: string): ActionEnvelope | null {
  const payload = parseActionPayload(bodyText)
  if (payload === null) return null
  const action = text(payload.action)
  if (action === '') return null
  const actorRaw = record(payload.actor)
  const approvalRaw = record(payload.approval)
  const toRecordOrNull = (value: unknown): Readonly<Record<string, unknown>> | null => {
    if (value === null || value === undefined) return null
    if (typeof value !== 'object' || Array.isArray(value)) return null
    return value as Record<string, unknown>
  }
  return {
    action,
    actor: {
      sessionId: text(actorRaw.session_id),
      alias: text(actorRaw.alias),
      actorId: text(actorRaw.actor_id),
    },
    approval: {
      requested: count(approvalRaw.requested),
      result: text(approvalRaw.result),
      toolNames: stringList(approvalRaw.tool_names),
    },
    result: toRecordOrNull(payload.result),
    readback: toRecordOrNull(payload.readback),
  }
}

/** `terminated` 的八个计数键（逐字；少一个就 parse 失败，不编造 0）。 */
const TERMINATED_COUNT_KEYS = [
  'applications_total',
  'applications_closed',
  'applications_already_closed',
  'interviews_cancelled',
  'interviews_already_terminal',
  'interviews_occurred_kept',
  'tasks_cancelled',
  'task_attempts_cancelled',
] as const

/** 读一个必填非负整数计数（缺失/非数字 → null）。 */
function requiredCount(source: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) return null
  return value
}

/** 解析 `job/close` 200 信封（键名逐字；任一必填键缺失/坏类型 → null）。 */
export function parseJobCloseEnvelope(bodyText: string): JobCloseEnvelope | null {
  const payload = parseActionPayload(bodyText)
  if (payload === null) return null
  const contractVersion = text(payload.contract_version)
  if (contractVersion === '') return null
  const job = record(payload.job)
  const actor = record(payload.actor)
  const terminatedRaw = record(payload.terminated)
  const jobId = text(job.job_id)
  const status = text(job.status)
  const recordVersion = job.record_version
  if (jobId === '' || status === '') return null
  if (typeof recordVersion !== 'number' || !Number.isFinite(recordVersion) || recordVersion < 0) return null
  if (typeof payload.replayed !== 'boolean') return null
  const counts: number[] = []
  for (const key of TERMINATED_COUNT_KEYS) {
    const value = requiredCount(terminatedRaw, key)
    if (value === null) return null
    counts.push(value)
  }
  return {
    contractVersion,
    job: {
      jobId,
      status,
      recordVersion,
      statusChangedAt: text(job.status_changed_at),
      statusChangedByActorId: text(job.status_changed_by_actor_id),
    },
    terminated: {
      applicationsTotal: counts[0] as number,
      applicationsClosed: counts[1] as number,
      applicationsAlreadyClosed: counts[2] as number,
      interviewsCancelled: counts[3] as number,
      interviewsAlreadyTerminal: counts[4] as number,
      interviewsOccurredKept: counts[5] as number,
      tasksCancelled: counts[6] as number,
      taskAttemptsCancelled: counts[7] as number,
    },
    actor: {
      actorId: text(actor.actor_id),
      alias: text(actor.alias),
      displayName: text(actor.display_name),
    },
    replayed: payload.replayed,
  }
}

/** 终止计数 → 人读行（顺序固定；缺失数值由 parse 拦掉，这里是纯展示）。 */
export function terminatedLines(terminated: JobCloseEnvelope['terminated']): readonly string[] {
  return [
    `本次进入终止范围的申请：${String(terminated.applicationsTotal)} 条`,
    `实际终止（UPDATE 命中）：${String(terminated.applicationsClosed)} 条`,
    `此前已关闭（只计数、不写）：${String(terminated.applicationsAlreadyClosed)} 条`,
    `取消的未开始面试：${String(terminated.interviewsCancelled)} 场`,
    `已终态面试（不碰）：${String(terminated.interviewsAlreadyTerminal)} 场`,
    `已发生/进行中的面试（保留、不伪造取消）：${String(terminated.interviewsOccurredKept)} 场`,
    `取消的未完成任务：${String(terminated.tasksCancelled)} 个`,
    `取消的任务尝试：${String(terminated.taskAttemptsCancelled)} 个`,
  ]
}

// =====================================================================
//  错误码 → 人话补救（未知返回 ''；不吞服务端 message）
// =====================================================================

/** 已知 `code` / `code/reason_code` → 人话补救说明（未知码返回 ''，界面仍显示服务端原文）。 */
const ERROR_ADVICE: Readonly<Record<string, string>> = {
  'FORBIDDEN/SAME_ORIGIN_REQUIRED': '这个操作只能在招聘工作台里执行，请从工作台页面重试',
  'FORBIDDEN/ACTOR_NOT_AUTHORIZED': '当前身份无权执行招聘写动作；请切换到 Recruiter 身份（面试官只能提交本人面评）',
  'FORBIDDEN/APPROVAL_UNAVAILABLE': '审批通道尚未就绪，本次没有写库',
  'FORBIDDEN/APPROVAL_NOT_GRANTED': '本次确认未获放行（可能已用过，或未获得授权）',
  'DECISION_REQUIRES_HUMAN/NO_HUMAN_CONFIRMATION':
    '缺少人工确认：服务端本应派生 IN_APP_CONFIRM，出现此码说明实现异常',
  'INVALID_ARGS/SESSION_REQUIRED': '尚未选择身份：请先在工作台顶部选择身份，再重试',
  'INVALID_ARGS/SESSION_ID_INVALID': '身份信息格式不正确，请重新选择身份后重试',
  'DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND': '当前身份没有绑定账号（刷新或重启工作台后会丢失）；请重新选择身份后重试',
  'INVALID_ARGS/ACTOR_OVERRIDE_REJECTED':
    '请求里出现了身份或服务端派生键，服务端一律拒绝；这是客户端实现缺陷（本 UI 已在发送前自检）',
  'INVALID_ARGS/MISSING_REQUIRED': '必填字段缺失：按表单提示补齐后重试',
  'INVALID_ARGS/ID_NOT_UUID': '编号格式不正确：请从列表里选择，不要手工输入',
  'INVALID_ARGS/ENUM_INVALID': '选项不在允许范围内',
  'INVALID_ARGS/OUT_OF_RANGE': '填写内容超出允许范围',
  'INVALID_ARGS/UNKNOWN_PARAM': '出现了不认识的字段',
  'INVALID_ARGS/SCOPE_MISMATCH': '决策范围与端点不符：初筛用 screening/decide，正式决策用 decision/record',
  'INVALID_ARGS/STAGE_REQUIRES_INTERVIEW': 'STAGE 决策必须带面试 id',
  'INVALID_ARGS/FINAL_SCOPE_NO_INTERVIEW': 'FINAL 决策不能带面试 id',
  'INVALID_ARGS/SCREENING_SCOPE_NO_SUMMARY': 'SCREENING 决策不能带 summary_digest',
  'INVALID_ARGS/AS_OF_IN_FUTURE': 'as_of 晚于服务端当前时间：必须原样使用 facts 里的 as_of，不要用本地时间',
  'INVALID_ARGS/TIMESTAMP_WITHOUT_OFFSET': '时间必须带时区偏移（ISO-8601），裸本地时间会被拒绝',
  'INVALID_ARGS/START_IN_PAST': '排期开始时间已过去：请选择将来时间',
  'INVALID_ARGS/ROUND_OUT_OF_RANGE': '轮次必须是 1..20 的整数',
  'INVALID_ARGS/DURATION_OUT_OF_RANGE': '面试时长必须是 15..480 分钟',
  'INVALID_ARGS/INTERVIEWER_REQUIRED': '至少需要一名面试官',
  'INVALID_ARGS/DUPLICATE_INTERVIEWER': '面试官重复：同一 actor 只能出现一次',
  'INVALID_ARGS/IDEMPOTENCY_KEY_REUSED': '同一 idempotency_key 用在了不同参数上（重试必须复用同一份参数）',
  'INVALID_ARGS/EXPORT_FILE_NAME_REQUIRED': 'PLATFORM_EXPORT 必须填写平台导出的文件名',
  'INVALID_ARGS/REASON_REQUIRED': '该动作需要填写理由',
  'INVALID_ARGS/SUMMARY_STALE': 'as_of 与汇总时不一致：必须原样回传 facts 里的 as_of',
  'INVALID_ARGS/CONFIRM_REQUIRED': '关闭岗位必须显式确认（confirm: true）',
  'INVALID_ARGS/UNKNOWN_BODY_KEY': '请求体出现封闭键集之外的键',
  'INVALID_ARGS/UNKNOWN_ENTITY': '设置实体只能是 role / team / pipeline',
  'INVALID_ARGS/READ_OPERATION_NOT_EXPOSED': '这里只能提交新增或修改；查看请到对应的列表页',
  'CLIENT_REFUSED': '客户端没有发送请求：动作不可用、入口不正确或缺少必要信息',
  'CLIENT_REFUSED/CLIENT_RESERVED_KEY': 'body 含身份/服务端派生键，客户端拒绝发送（服务端也会 400）',
  'CLIENT_REFUSED/EMPTY_BODY': '写请求 body 为空：必须由 build* 产出（固定发 {} 会被 400）',
  'CLIENT_REFUSED/SESSION_MISSING': '还没有识别到当前身份：请先在工作台顶部选择身份',
  'CLIENT_REFUSED/UNSAFE_SEAM': '动作入口不正确，客户端没有发送请求',
  'CLIENT_REFUSED/ACTION_NOT_AVAILABLE': '服务端声明该动作不可用（available=false）；客户端不发送请求',
  'CLIENT_RESERVED_KEY': 'body 含身份/服务端派生键，客户端拒绝发送（服务端也会 400）',
  'NOT_FOUND': '对象不存在（申请/面试/评分标准/岗位/会议）；先刷新页面再重试',
  'VERSION_CONFLICT': '并发冲突：记录版本已被他人更新；重新读取后用最新版本重试',
  'ALREADY_DECIDED': '这条申请已经有过决定；要改判请走重新决策，不要重复提交',
  'ALREADY_SCHEDULED': '该轮已排期；改时间要走 RESCHEDULE',
  'ALREADY_EXISTS': '同 code 的对象已存在；换一个 code',
  'CONFLICT_SLOT': '时段冲突：该面试官/时段已被占用',
  'BLOCKED_BY_REVIEW': '有评审未完成，动作被前置事实阻塞',
  'NO_RUBRIC': '岗位没有可用的评分标准；先批准评分标准',
  'NO_TRANSCRIPT': '该面试还没有可用的转写记录',
  'EVIDENCE_INSUFFICIENT': '决策汇总所需信息不足：先补面评/汇总',
  'NOT_CONFIGURED': '数据库/连接器未配置，写动作不可用（不是"没有数据"）',
  'INVALID_REFERENCE': '引用的部门 / actor / 阶段 / 面试模板不存在',
  'SUMMARY_MISSING': '正式决策需要 evaluation summary：facts 里 summary 不可用，不允许记录决策',
  'MISSING_SUMMARY': '服务端拿不到汇总，本次没有写库',
  'DECISION_FACTS_MISSING': '决策所需信息还没有读到：请先刷新页面，客户端暂不发送请求',
  'DECISION_FACTS_ROUTE_MISSING': '决策所需信息暂时读不到，请刷新页面后重试；本次没有提交',
  'DECISION_FACTS_ERROR': '决策事实读取失败（看服务端原文）；先修好 facts 路由/身份再重试',
  'DECISION_FACTS_LOADING': '正在读取决策所需信息：读完后表单才可提交',
  'MISSING_RUBRIC_PAYLOAD_HASH': '评分标准快照信息不全：客户端不会自行编造，初筛决策暂不可提交',
  'MISSING_AUTHORITY_FACTS': 'facts 缺 AUTHORITY（actor_id / is_hiring_manager）：客户端不编造权威事实',
  'MISSING_SCREENING_EVALUATION': 'ADVANCE/REJECT 必须先执行初筛评估（facts.screening_evaluation 六个字段齐全）',
  'MISSING_AS_OF': 'facts 没有 as_of：客户端不用本地时间造 as_of（会 SUMMARY_STALE），不发送',
  'APPLICATION_MISMATCH': 'facts 与当前申请不一致（页面数据过期）：刷新后重试',
  'SCREENING_EVALUATION_PRESENT': 'facts 已有初筛评估：无需重复执行（如需重评走服务端方法）',
  'SUMMARY_DIGEST_MISSING': '决策汇总信息不全，正式决策暂不可提交',
  'NETWORK': '网络请求失败：检查宿主是否还在运行',
  'BAD_RESPONSE': '宿主响应不是可解析 JSON / 信封不可用：不当作成功',
  'READBACK_MISSING': '服务端写事务已提交但读回不到行：数据异常，不要当作成功',
  'INTERNAL': '服务端内部错误（不是业务结论）',
}

/** 服务端错误码 → 人话补救（未知返回 ''；不吞服务端 message）。 */
export function describeActionError(code: string, reasonCode: string): string {
  const byPair = ERROR_ADVICE[`${code}/${reasonCode}`]
  if (byPair !== undefined) return byPair
  const byCode = ERROR_ADVICE[code]
  if (byCode !== undefined) return byCode
  const byReason = ERROR_ADVICE[reasonCode]
  if (byReason !== undefined) return byReason
  return ''
}

// =====================================================================
//  路由探测（零写入；405 = 已注册 POST 路由，404 = 未接线，403 = 同源/越权）
// =====================================================================

/** 路由探测状态：`AVAILABLE` 已注册 POST / `MISSING` 404 未接线 / `FORBIDDEN` 403 / `UNKNOWN` 其它。 */
export type RouteProbeState = 'AVAILABLE' | 'MISSING' | 'FORBIDDEN' | 'UNKNOWN'

/**
 * GET 同路径探测状态映射（**不许**用 POST 空 body 探测：会打日志/可能触发闸门）。
 * @param status - GET 同路径的 HTTP 状态码（0 = 网络失败）。
 */
export function interpretRouteProbe(status: number): RouteProbeState {
  if (status === 405) return 'AVAILABLE'
  if (status === 404) return 'MISSING'
  if (status === 403) return 'FORBIDDEN'
  return 'UNKNOWN'
}

/** 岗位关闭 seam 的探测状态（与 {@link RouteProbeState} 同集）。 */
export type CloseSeamState = RouteProbeState

/** 岗位关闭 seam 探测结果。 */
export interface CloseSeamProbe {
  readonly state: CloseSeamState
  readonly status: number
  readonly reasonText: string
}

/**
 * `GET /recruitment/api/job-action/job/close` 的状态 → 人读结论（405 = 已注册 POST 路由；404 = 未接线；403 = 同源问题）。
 * @param status - GET 同路径的 HTTP 状态码（0 = 网络失败）。
 */
export function interpretCloseProbe(status: number): CloseSeamProbe {
  const state = interpretRouteProbe(status)
  if (state === 'AVAILABLE') {
    return { state, status, reasonText: '可以关闭岗位；确认后会真正保存修改' }
  }
  if (state === 'MISSING') {
    return { state, status, reasonText: '关闭岗位当前不可用，客户端不发请求' }
  }
  if (state === 'FORBIDDEN') {
    return { state, status, reasonText: '身份校验未通过；请先在工作台顶部选择身份，再从本页面操作' }
  }
  return {
    state,
    status,
    reasonText: status === 0 ? '网络请求失败（工作台可能未运行）' : `请求返回了未预期的结果（${String(status)}）`,
  }
}

// =====================================================================
//  decision facts（GET /recruitment/api/decision/facts）
// =====================================================================

/** `screening_evaluation` 分片（`work/d5/decision/CONTRACT.md` §1）。 */
export interface DecisionFactsEvaluation {
  readonly evaluationId: string
  readonly evaluationDigest: string
  readonly verdict: string
  readonly rubricVersionId: string
  readonly rubricPayloadHash: string
  readonly resumeVersionId: string
  readonly resumeContentSha256: string
  readonly asOf: string
  readonly criteriaEvaluated: readonly unknown[]
  readonly counts: Readonly<Record<string, unknown>>
}

/** `evaluation_summary` 分片（summary 不可用时为 null，**不许编造**）。 */
export interface DecisionFactsSummary {
  readonly available: boolean
  readonly asOf: string
  readonly summaryDigest: string
  readonly warningCount: number
  readonly source: string
}

/** `basis.screening_decide`（SCREENING 决策的 basis 事实源；不完整 → null）。 */
export interface DecisionFactsScreeningBasis {
  readonly rubricVersion: null | { readonly id: string; readonly payloadHash: string }
  readonly authority: null | { readonly actorId: string; readonly isHiringManager: boolean }
  readonly screeningEvaluation: null | {
    readonly evaluationId: string
    readonly evaluationDigest: string
    readonly verdict: string
  }
}

/** `basis.decision_record`（facade 内部用的 basis；客户端只读不传）。 */
export interface DecisionFactsRecordBasis {
  readonly asOf: string
  readonly summaryDigest: string
  readonly rubricVersion: null | { readonly id: string; readonly payloadHash: string }
  readonly authority: null | { readonly actorId: string; readonly isHiringManager: boolean }
}

/** 决策事实只读投影（`GET /recruitment/api/decision/facts` 的归一化；缺 → null/缺省，不编造）。 */
export interface DecisionFacts {
  readonly contractVersion: string
  readonly applicationId: string
  readonly stageCode: string
  readonly missing: ReadonlyArray<{ readonly key: string; readonly reason: string }>
  readonly screeningEvaluation: DecisionFactsEvaluation | null
  readonly evaluationSummary: DecisionFactsSummary | null
  readonly basisScreeningDecide: DecisionFactsScreeningBasis | null
  readonly basisDecisionRecord: DecisionFactsRecordBasis | null
}

/** 归一化 facts 里的 `missing[]`（只保留有 key 的条目）。 */
function normalizeMissing(value: unknown): ReadonlyArray<{ readonly key: string; readonly reason: string }> {
  const out: { key: string; reason: string }[] = []
  for (const item of items(value)) {
    const entry = record(item)
    const key = text(entry.key)
    if (key === '') continue
    out.push({ key, reason: text(entry.reason) })
  }
  return out
}

/** 归一化 `rubric_version` 子对象（缺 id/payload_hash → null）。 */
function normalizeRubricBinding(value: unknown): null | { readonly id: string; readonly payloadHash: string } {
  const raw = record(value)
  const id = text(raw.id)
  const payloadHash = text(raw.payload_hash)
  if (id === '' || payloadHash === '') return null
  return { id, payloadHash }
}

/** 归一化 `authority` 子对象（缺 actor_id 或 is_hiring_manager 非布尔 → null，不猜 false）。 */
function normalizeAuthority(value: unknown): null | { readonly actorId: string; readonly isHiringManager: boolean } {
  const raw = record(value)
  const actorId = text(raw.actor_id)
  const isHiringManager = raw.is_hiring_manager
  if (actorId === '' || typeof isHiringManager !== 'boolean') return null
  return { actorId, isHiringManager }
}

/** 归一化 `screening_evaluation`（缺 evaluation_id 与 digest → null）。 */
function normalizeFactsEvaluation(value: unknown): DecisionFactsEvaluation | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const evaluationId = text(raw.evaluation_id)
  const evaluationDigest = text(raw.evaluation_digest)
  if (evaluationId === '' && evaluationDigest === '') return null
  return {
    evaluationId,
    evaluationDigest,
    verdict: text(raw.verdict),
    rubricVersionId: text(raw.rubric_version_id),
    rubricPayloadHash: text(raw.rubric_payload_hash),
    resumeVersionId: text(raw.resume_version_id),
    resumeContentSha256: text(raw.resume_content_sha256),
    asOf: text(raw.as_of),
    criteriaEvaluated: items(raw.criteria_evaluated),
    counts: record(raw.counts),
  }
}

/** 归一化 `evaluation_summary`（null → null；字段缺失保留空值，由 build* 判 missing）。 */
function normalizeFactsSummary(value: unknown): DecisionFactsSummary | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  if (Object.keys(raw).length === 0) return null
  return {
    available: raw.available === true,
    asOf: text(raw.as_of),
    summaryDigest: text(raw.summary_digest),
    warningCount: count(raw.warning_count),
    source: text(raw.source),
  }
}

/** 归一化 `basis.screening_decide`（空对象 → null）。 */
function normalizeScreeningBasis(value: unknown): DecisionFactsScreeningBasis | null {
  const raw = record(value)
  if (Object.keys(raw).length === 0) return null
  const evaluationRaw = record(raw.screening_evaluation)
  const evaluationId = text(evaluationRaw.evaluation_id)
  const evaluationDigest = text(evaluationRaw.evaluation_digest)
  return {
    rubricVersion: normalizeRubricBinding(raw.rubric_version),
    authority: normalizeAuthority(raw.authority),
    screeningEvaluation:
      evaluationId === '' && evaluationDigest === ''
        ? null
        : { evaluationId, evaluationDigest, verdict: text(evaluationRaw.verdict) },
  }
}

/** 归一化 `basis.decision_record`（空对象 → null）。 */
function normalizeRecordBasis(value: unknown): DecisionFactsRecordBasis | null {
  const raw = record(value)
  if (Object.keys(raw).length === 0) return null
  return {
    asOf: text(raw.as_of),
    summaryDigest: text(raw.summary_digest),
    rubricVersion: normalizeRubricBinding(raw.rubric_version),
    authority: normalizeAuthority(raw.authority),
  }
}

/**
 * 归一化 `GET /recruitment/api/decision/facts` 响应（严格容错：坏类型 → null/缺省，不编造 hash/actor）。
 * @param value - 原始 JSON。
 * @returns 缺少 `application_id`（无法归属申请）时返回 null。
 */
export function normalizeDecisionFacts(value: unknown): DecisionFacts | null {
  const raw = record(value)
  const applicationId = text(raw.application_id)
  if (applicationId === '') return null
  const basisRaw = record(raw.basis)
  return {
    contractVersion: text(raw.contract_version),
    applicationId,
    stageCode: text(raw.stage_code),
    missing: normalizeMissing(raw.missing),
    screeningEvaluation: normalizeFactsEvaluation(raw.screening_evaluation),
    evaluationSummary: normalizeFactsSummary(raw.evaluation_summary),
    basisScreeningDecide: normalizeScreeningBasis(basisRaw.screening_decide),
    basisDecisionRecord: normalizeRecordBasis(basisRaw.decision_record),
  }
}

/** facts 里某键是否登记为 missing（key 精确匹配）。 */
function factsMissingKeys(facts: DecisionFacts): string[] {
  return facts.missing.map((entry) => entry.key)
}

// =====================================================================
//  build*：写动作 body 组包（只做契约形状/必填/长度/保留键校验，不补业务事实）
// =====================================================================

/**
 * `stage/advance` body（唯一键 `application_id`；目标阶段由服务端按已发生事实推导）。
 * 出处：`work/d5/actions/CONTRACT.md` §2.2。
 */
export function buildStageAdvanceBody(input: { readonly applicationId: string }): BodyBuildResult {
  const applicationId = text(input.applicationId)
  const missing: string[] = []
  if (!requireUuid(applicationId, 'application_id', missing)) {
    return fail(
      missing.some((entry) => entry.endsWith(':ID_NOT_UUID')) ? 'ID_NOT_UUID' : 'MISSING_APPLICATION_ID',
      '申请编号缺失或格式不正确；阶段推进只提交申请编号，服务端按已发生事实推导目标阶段',
      missing,
    )
  }
  return finish({ application_id: applicationId })
}

/**
 * `POST /recruitment/api/decision/screening/evaluate` body（封闭键集只有 `application_id`）。
 * 出处：`work/d5/decision/CONTRACT.md` §2。
 */
export function buildScreeningEvaluateBody(input: { readonly applicationId: string }): BodyBuildResult {
  const applicationId = text(input.applicationId)
  const missing: string[] = []
  if (!requireUuid(applicationId, 'application_id', missing)) {
    return fail(
      missing.some((entry) => entry.endsWith(':ID_NOT_UUID')) ? 'ID_NOT_UUID' : 'MISSING_APPLICATION_ID',
      '申请编号缺失或格式不正确；初筛评估必须指定申请',
      missing,
    )
  }
  return finish({ application_id: applicationId })
}

/** SCREENING 决策可用的 as_of（服务端原样值：优先初筛评估，其次汇总/记录 basis；都没有 → ''）。 */
function screeningDecisionAsOf(facts: DecisionFacts): string {
  if (facts.screeningEvaluation !== null && facts.screeningEvaluation.asOf !== '') return facts.screeningEvaluation.asOf
  if (facts.evaluationSummary !== null && facts.evaluationSummary.asOf !== '') return facts.evaluationSummary.asOf
  return facts.basisDecisionRecord?.asOf ?? ''
}

/**
 * SCREENING 决策表单的结构性阻塞原因（facts 事实缺失；**空数组 = 事实齐全，可提交**）。
 * 组件据此 disabled + 显示 reasonCode（不发请求）；与 `buildScreeningDecisionBody` 同一判据。
 * @param facts - 决策事实投影（null = 路由缺失/未读取）。
 * @param needsEvaluation - 当前选择的结论是否要求 SCREENING_EVALUATION（ADVANCE/REJECT 要求）。
 */
export function screeningDecisionBlockers(
  facts: DecisionFacts | null,
  needsEvaluation: boolean,
): readonly string[] {
  if (facts === null) return ['DECISION_FACTS_MISSING']
  const out: string[] = []
  const basis = facts.basisScreeningDecide
  if (basis === null || basis.rubricVersion === null) out.push('MISSING_RUBRIC_PAYLOAD_HASH')
  if (basis === null || basis.authority === null) out.push('MISSING_AUTHORITY_FACTS')
  const asOf = screeningDecisionAsOf(facts)
  if (asOf === '') out.push('MISSING_AS_OF')
  else if (!isOffsetIso(asOf)) out.push('AS_OF_WITHOUT_OFFSET')
  if (needsEvaluation) {
    const evaluation = facts.screeningEvaluation
    const complete =
      evaluation !== null &&
      evaluation.evaluationDigest !== '' &&
      evaluation.verdict !== '' &&
      evaluation.rubricVersionId !== '' &&
      evaluation.rubricPayloadHash !== '' &&
      evaluation.resumeVersionId !== '' &&
      evaluation.resumeContentSha256 !== ''
    if (!complete) out.push('MISSING_SCREENING_EVALUATION')
  }
  return out
}

/**
 * `POST /recruitment/api/decision/record`（facade）表单的结构性阻塞原因（**空数组 = 可提交**）。
 * summary 不可用 → `SUMMARY_MISSING`（契约 §3：facade 拿不到汇总时服务端如实 400，客户端先拦住）。
 * @param facts - 决策事实投影（null = 路由缺失/未读取）。
 */
export function decisionRecordBlockers(facts: DecisionFacts | null): readonly string[] {
  if (facts === null) return ['DECISION_FACTS_MISSING']
  const summary = facts.evaluationSummary
  const out: string[] = []
  if (summary === null || !summary.available || summary.summaryDigest === '' || summary.asOf === '') {
    out.push('SUMMARY_MISSING')
  } else if (!isOffsetIso(summary.asOf)) {
    out.push('MISSING_AS_OF')
  }
  if (facts.basisDecisionRecord === null) out.push('MISSING_DECISION_BASIS')
  return out
}

/** SCREENING 决策可用的 as_of（暴露给 UI 显示；没有 → ''）。 */
export function screeningDecisionAsOfOf(facts: DecisionFacts | null): string {
  return facts === null ? '' : screeningDecisionAsOf(facts)
}

/**
 * 结构性阻塞码 → HR 人话（O6：机器码不进可见文案；未知码给中性兜底，原文仍在数据层）。
 * @param code - `screeningDecisionBlockers` / `decisionRecordBlockers` 产出的封闭码。
 * @returns 可读的缺什么说明。
 */
export function blockerTextOf(code: string): string {
  const table: Readonly<Record<string, string>> = {
    DECISION_FACTS_MISSING: '决策依据还没有读取',
    MISSING_RUBRIC_PAYLOAD_HASH: '评分标准快照还没有准备好',
    MISSING_AUTHORITY_FACTS: '审批 / 授权依据还没有准备好',
    MISSING_AS_OF: '决策时点还没有生成',
    AS_OF_WITHOUT_OFFSET: '决策时点缺少时区（请刷新后重试）',
    MISSING_SCREENING_EVALUATION: '还没有初筛评估',
    SUMMARY_MISSING: '决策汇总还没有生成',
    MISSING_DECISION_BASIS: '决策依据还没有准备好',
  }
  return table[code] ?? '还有一项前置事实没有准备好'
}

/**
 * `screening/decide` body：`{application_id, as_of, result, reason, basis_refs[]}`。
 *
 * basis_refs **只能**从 facts 组装（`RUBRIC_VERSION` / `AUTHORITY` / `SCREENING_EVALUATION`）：
 *   · SCREENING_EVALUATION 不带 `evaluation_id`（不在允许键集）；
 *   · ADVANCE/REJECT 必须有 SCREENING_EVALUATION；HOLD/WITHDRAW 有则带、没有也可。
 * facts 缺失 → `DECISION_FACTS_MISSING`（不发请求，不编造 hash/as_of）。
 * 出处：`work/d5/w2b/INTERFACE2.md` §2 + `work/d5/actions/CONTRACT.md` §2.1。
 */
export function buildScreeningDecisionBody(input: {
  readonly facts: DecisionFacts | null
  readonly result: 'ADVANCE' | 'HOLD' | 'WITHDRAW' | 'REJECT'
  readonly reason: string
  readonly applicationId: string
}): BodyBuildResult {
  const facts = input.facts
  if (facts === null) {
    return fail(
      'DECISION_FACTS_MISSING',
      '决策所需信息还没有读到；客户端不会自行编造决策时点和依据，暂不发送请求',
      ['facts'],
    )
  }
  const applicationId = text(input.applicationId) || facts.applicationId
  const missing: string[] = []
  if (!requireUuid(applicationId, 'application_id', missing)) {
    return fail('ID_NOT_UUID', '申请编号缺失或格式不正确', missing)
  }
  if (applicationId !== facts.applicationId) {
    return fail(
      'APPLICATION_MISMATCH',
      `facts 属于申请 ${facts.applicationId}，与当前申请 ${applicationId} 不一致；请刷新后重试`,
      ['facts.application_id'],
    )
  }
  const result = text(input.result)
  if (!(SCREENING_RESULTS as readonly string[]).includes(result)) {
    return fail('ENUM_INVALID', `result 只能是 ${SCREENING_RESULTS.join(' / ')}（HIRED 在 v1.0 禁用）`, ['result'])
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') return fail('MISSING_REASON', '初筛结论必须填写理由（1..4000 字）', ['reason'])
  if (charLength(reason) > 4000) return fail('REASON_OUT_OF_RANGE', '理由不得超过 4000 字', ['reason'])

  const asOf = screeningDecisionAsOf(facts)
  if (asOf === '') {
    return fail(
      'MISSING_AS_OF',
      'facts 没有 as_of（screening_evaluation / evaluation_summary 均缺失）；SCREENING 决策必须原样回传服务端 as_of',
      ['as_of'],
    )
  }
  if (!isOffsetIso(asOf)) {
    return fail('AS_OF_WITHOUT_OFFSET', `facts 的 as_of 不是带时区偏移的 ISO-8601：${asOf}`, ['as_of'])
  }

  const basisScreening = facts.basisScreeningDecide
  const rubric = basisScreening?.rubricVersion ?? null
  if (rubric === null) {
    return fail(
      'MISSING_RUBRIC_PAYLOAD_HASH',
      '评分标准快照信息不全：缺少编号或校验值；客户端不会自行编造',
      ['rubric_version.payload_hash'],
    )
  }
  const authority = basisScreening?.authority ?? null
  if (authority === null) {
    return fail(
      'MISSING_AUTHORITY_FACTS',
      'facts.basis.screening_decide.authority 缺失（actor_id / is_hiring_manager）；客户端不编造权威事实',
      ['authority'],
    )
  }

  const basisRefs: Record<string, unknown>[] = [
    { kind: 'RUBRIC_VERSION', id: rubric.id, payload_hash: rubric.payloadHash },
    { kind: 'AUTHORITY', actor_id: authority.actorId, is_hiring_manager: authority.isHiringManager },
  ]
  const evaluation = facts.screeningEvaluation
  const needsEvaluation = result === 'ADVANCE' || result === 'REJECT'
  const evaluationComplete =
    evaluation !== null &&
    evaluation.evaluationDigest !== '' &&
    evaluation.verdict !== '' &&
    evaluation.rubricVersionId !== '' &&
    evaluation.rubricPayloadHash !== '' &&
    evaluation.resumeVersionId !== '' &&
    evaluation.resumeContentSha256 !== ''
  if (evaluationComplete && evaluation !== null) {
    // 注意：不带 evaluation_id（不在 SCREENING_EVALUATION 允许键集）。
    basisRefs.push({
      kind: 'SCREENING_EVALUATION',
      evaluation_digest: evaluation.evaluationDigest,
      verdict: evaluation.verdict,
      rubric_version_id: evaluation.rubricVersionId,
      rubric_payload_hash: evaluation.rubricPayloadHash,
      resume_version_id: evaluation.resumeVersionId,
      resume_content_sha256: evaluation.resumeContentSha256,
    })
  } else if (needsEvaluation) {
    const missingEvaluationKeys =
      evaluation === null
        ? ['screening_evaluation']
        : [
            evaluation.evaluationDigest === '' ? 'evaluation_digest' : '',
            evaluation.verdict === '' ? 'verdict' : '',
            evaluation.rubricVersionId === '' ? 'rubric_version_id' : '',
            evaluation.rubricPayloadHash === '' ? 'rubric_payload_hash' : '',
            evaluation.resumeVersionId === '' ? 'resume_version_id' : '',
            evaluation.resumeContentSha256 === '' ? 'resume_content_sha256' : '',
          ].filter((entry) => entry !== '')
    return fail(
      'MISSING_SCREENING_EVALUATION',
      'ADVANCE / REJECT 必须带 SCREENING_EVALUATION 六个字段；facts 尚未执行初筛评估或字段不全',
      missingEvaluationKeys,
    )
  }

  return finish({ application_id: applicationId, as_of: asOf, result, reason, basis_refs: basisRefs })
}

/**
 * `POST /recruitment/api/decision/record`（facade）body：`{application_id, decision_scope, result, reason, as_of?}`。
 *
 * 前端**不得**传 `summary_digest` / `basis_refs`（facade 自己从 facts 组装）；summary 不可用 → `SUMMARY_MISSING`。
 * 出处：`work/d5/decision/CONTRACT.md` §3 + `work/d5/w2b/INTERFACE2.md` §2。
 */
export function buildDecisionRecordBody(input: {
  readonly facts: DecisionFacts | null
  readonly applicationId: string
  readonly scope: 'STAGE' | 'FINAL'
  readonly result: 'ADVANCE' | 'HOLD' | 'REJECT'
  readonly reason: string
}): BodyBuildResult {
  const facts = input.facts
  if (facts === null) {
    return fail(
      'DECISION_FACTS_MISSING',
      '决策所需信息还没有读到；暂不发送请求',
      ['facts'],
    )
  }
  const applicationId = text(input.applicationId) || facts.applicationId
  const missing: string[] = []
  if (!requireUuid(applicationId, 'application_id', missing)) {
    return fail('ID_NOT_UUID', '申请编号缺失或格式不正确', missing)
  }
  if (applicationId !== facts.applicationId) {
    return fail(
      'APPLICATION_MISMATCH',
      `facts 属于申请 ${facts.applicationId}，与当前申请 ${applicationId} 不一致；请刷新后重试`,
      ['facts.application_id'],
    )
  }
  const scope = text(input.scope)
  if (!(DECISION_SCOPES as readonly string[]).includes(scope)) {
    return fail('ENUM_INVALID', 'decision_scope 只能是 STAGE / FINAL', ['decision_scope'])
  }
  const result = text(input.result)
  if (!(RECORD_RESULTS as readonly string[]).includes(result)) {
    return fail('ENUM_INVALID', `结论只能是 ${RECORD_RESULTS.join(' / ')}（不支持撤回/录用）`, ['result'])
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') return fail('MISSING_REASON', '正式决策必须填写理由（1..4000 字）', ['reason'])
  if (charLength(reason) > 4000) return fail('REASON_OUT_OF_RANGE', '理由不得超过 4000 字', ['reason'])

  const summary = facts.evaluationSummary
  const summaryMissingInFacts = factsMissingKeys(facts).includes('summary')
  if (summary === null || !summary.available || summary.summaryDigest === '' || summary.asOf === '') {
    return fail(
      'SUMMARY_MISSING',
      'facts.evaluation_summary 不可用（available=false / 缺 as_of / 缺 summary_digest）；正式决策必须先有服务端汇总',
      [
        summary === null ? 'evaluation_summary' : '',
        summary !== null && !summary.available ? 'evaluation_summary.available' : '',
        summary !== null && summary.asOf === '' ? 'evaluation_summary.as_of' : '',
        summary !== null && summary.summaryDigest === '' ? 'evaluation_summary.summary_digest' : '',
        summaryMissingInFacts ? 'missing.summary' : '',
      ].filter((entry) => entry !== ''),
    )
  }
  if (!isOffsetIso(summary.asOf)) {
    return fail('MISSING_AS_OF', `facts.evaluation_summary.as_of 不是带时区偏移的 ISO-8601：${summary.asOf}`, ['as_of'])
  }
  return finish({
    application_id: applicationId,
    decision_scope: scope,
    result,
    reason,
    as_of: summary.asOf,
  })
}

/** 一个面试官候选（来自 `settings.hiringTeams[].members[]`；`actorId` 是值、`displayName` 是展示）。 */
export interface InterviewerCandidate {
  readonly actorId: string
  readonly displayName: string
  readonly teamName: string
  readonly teamRole: string
}

/**
 * 从设置快照里取面试官候选（按 actorId 去重；招聘团队是唯一人员来源，不手工编 actor id）。
 * @param settings - `overview.settings`（未取到 undefined → 空候选）。
 */
export function interviewerCandidates(settings: SettingsView | undefined): readonly InterviewerCandidate[] {
  if (settings === undefined) return []
  const out: InterviewerCandidate[] = []
  const seen = new Set<string>()
  for (const team of settings.hiringTeams) {
    for (const member of team.members) {
      if (member.actorId === '' || seen.has(member.actorId)) continue
      seen.add(member.actorId)
      out.push({
        actorId: member.actorId,
        displayName: member.displayName,
        teamName: team.name !== '' ? team.name : team.code,
        teamRole: member.teamRole,
      })
    }
  }
  return out
}

/** 一个面试（供 transcript 导入 / 决策表单选择；id 是值）。 */
export interface InterviewChoice {
  readonly interviewId: string
  readonly roundNo: number
  readonly slotCode: string
  readonly statusLabel: string
  readonly label: string
}

/**
 * 从申请详情里取面试选项（不编造：只列服务端已返回的 interview 行）。
 * @param view - 申请详情（未取到 undefined → 空选项）。
 */
export function interviewChoices(view: ApplicationDetailView | undefined): readonly InterviewChoice[] {
  if (view === undefined) return []
  return view.interviews.map((interview) => {
    const roundText = `第 ${String(interview.roundNo)} 轮`
    const slotText = interview.slotCode !== '' ? ` · ${interview.slotCode}` : ''
    const statusText = interview.statusLabel !== '' ? ` · ${interview.statusLabel}` : ''
    return {
      interviewId: interview.id,
      roundNo: interview.roundNo,
      slotCode: interview.slotCode,
      statusLabel: interview.statusLabel,
      label: `${roundText}${slotText}${statusText}`,
    }
  })
}

/**
 * `interview/schedule` CREATE body（`intent` 显式 CREATE；四 intent 都必填 `idempotency_key`）。
 * 出处：`work/d5/actions/CONTRACT.md` §3.1。
 */
export function buildInterviewScheduleBody(input: {
  readonly applicationId: string
  readonly roundNo: number
  readonly scheduledStartAt: string
  readonly durationMinutes: number
  readonly interviewers: ReadonlyArray<{
    readonly actorId: string
    readonly roleInInterview?: string
    readonly requiredScorecard?: boolean
  }>
  readonly idempotencyKey: string
  readonly timezone?: string
}): BodyBuildResult {
  const missing: string[] = []
  const applicationId = text(input.applicationId)
  if (!requireUuid(applicationId, 'application_id', missing)) {
    return fail('ID_NOT_UUID', '申请编号缺失或格式不正确', missing)
  }
  const roundNo = input.roundNo
  if (typeof roundNo !== 'number' || !Number.isInteger(roundNo) || roundNo < 1 || roundNo > 20) {
    return fail('ROUND_OUT_OF_RANGE', '轮次必须是 1..20 的整数（服务端 INV-4）', ['round_no'])
  }
  const scheduledStartAt = text(input.scheduledStartAt)
  if (scheduledStartAt === '') return fail('MISSING_START', '排期必须给开始时间', ['scheduled_start_at'])
  if (!isOffsetIso(scheduledStartAt)) {
    return fail(
      'TIMESTAMP_WITHOUT_OFFSET',
      'scheduled_start_at 必须是带时区偏移的 ISO-8601（datetime-local 需经 toOffsetIso 转换）',
      ['scheduled_start_at'],
    )
  }
  const durationMinutes = input.durationMinutes
  if (
    typeof durationMinutes !== 'number' ||
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 15 ||
    durationMinutes > 480
  ) {
    return fail('DURATION_OUT_OF_RANGE', '面试时长必须是 15..480 分钟的整数', ['duration_minutes'])
  }
  if (input.interviewers.length === 0) {
    return fail('INTERVIEWER_REQUIRED', '至少需要一名面试官（来自招聘团队人员）', ['interviewers'])
  }
  const interviewers: Record<string, unknown>[] = []
  const seen = new Set<string>()
  for (const interviewer of input.interviewers) {
    const actorId = text(interviewer.actorId)
    if (actorId === '') return fail('MISSING_INTERVIEWER_ACTOR', '面试官候选缺 actorId', ['interviewers[].actor_id'])
    if (!isUuid(actorId)) {
      return fail('ID_NOT_UUID', `面试官编号格式不正确：${actorId}`, ['interviewers[].actor_id'])
    }
    if (seen.has(actorId)) {
      return fail('DUPLICATE_INTERVIEWER', `面试官重复：${actorId} 只能出现一次`, ['interviewers'])
    }
    seen.add(actorId)
    const element: Record<string, unknown> = { actor_id: actorId }
    const roleInInterview = text(interviewer.roleInInterview)
    if (roleInInterview !== '') element.role_in_interview = roleInInterview
    if (typeof interviewer.requiredScorecard === 'boolean') element.required_scorecard = interviewer.requiredScorecard
    interviewers.push(element)
  }
  const idempotencyKey = text(input.idempotencyKey)
  if (idempotencyKey === '') {
    return fail('MISSING_IDEMPOTENCY_KEY', '排期必须带 idempotency_key（前端生成并保留，重试复用同一 key）', [
      'idempotency_key',
    ])
  }
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return fail(
      'IDEMPOTENCY_KEY_INVALID',
      'idempotency_key 只能是 1..200 个 [A-Za-z0-9_.:-] 字符',
      ['idempotency_key'],
    )
  }
  const timezone = text(input.timezone)
  return finish({
    intent: 'CREATE',
    application_id: applicationId,
    round_no: roundNo,
    scheduled_start_at: scheduledStartAt,
    duration_minutes: durationMinutes,
    interviewers,
    idempotency_key: idempotencyKey,
    ...(timezone !== '' ? { timezone } : {}),
  })
}

/**
 * `transcript/import` 人工上传 body（`PLATFORM_EXPORT` 必带导出文件名；`DEMO_SAMPLE` = FIXTURE 演示文本）。
 * 出处：`work/d5/actions/CONTRACT.md` §3.2。
 */
export function buildTranscriptImportBody(input: {
  readonly interviewId: string
  readonly content: string
  readonly sourceKind: 'PLATFORM_EXPORT' | 'DEMO_SAMPLE'
  readonly exportedFileName?: string
  readonly language?: string
  readonly note?: string
}): BodyBuildResult {
  const missing: string[] = []
  const interviewId = text(input.interviewId)
  if (!requireUuid(interviewId, 'interview_id', missing)) {
    return fail('ID_NOT_UUID', '面试编号缺失或格式不正确（转写只能挂到已绑定的面试）', missing)
  }
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim() === '') return fail('MISSING_CONTENT', '转写正文不能为空（1..400000 字符）', ['content'])
  if (charLength(content) > 400_000) {
    return fail('CONTENT_OUT_OF_RANGE', '转写正文不得超过 400000 字符', ['content'])
  }
  const sourceKind = text(input.sourceKind)
  if (!(TRANSCRIPT_SOURCE_KINDS as readonly string[]).includes(sourceKind)) {
    return fail('ENUM_INVALID', '来源只能是「平台导出」或「演示样本」', ['source_kind'])
  }
  const exportedFileName = text(input.exportedFileName)
  if (sourceKind === 'PLATFORM_EXPORT') {
    if (exportedFileName === '') {
      return fail('EXPORT_FILE_NAME_REQUIRED', 'PLATFORM_EXPORT 必须填写平台导出的文件名', ['exported_file_name'])
    }
    if (charLength(exportedFileName) > 255 || exportedFileName.includes(';') || /[\r\n]/.test(exportedFileName)) {
      return fail(
        'EXPORT_FILE_NAME_INVALID',
        '导出文件名不得超过 255 字，且不得含 ";" 或换行',
        ['exported_file_name'],
      )
    }
  }
  const language = text(input.language)
  if (language !== '' && charLength(language) > 16) {
    return fail('LANGUAGE_INVALID', '语言标签不得超过 16 字符', ['language'])
  }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (charLength(note) > 500) return fail('NOTE_TOO_LONG', '备注不得超过 500 字', ['note'])
  const body: Record<string, unknown> = {
    interview_id: interviewId,
    content,
    source_kind: sourceKind,
  }
  // 导出文件名只对 PLATFORM_EXPORT 有意义（DEMO_SAMPLE 不冒充平台导出件）。
  if (sourceKind === 'PLATFORM_EXPORT' && exportedFileName !== '') body.exported_file_name = exportedFileName
  if (language !== '') body.language = language
  if (note !== '') body.note = note
  return finish(body)
}

/** `job/rubric-approve` body：`{job_id, rubric_version_id, reason?}`（reason ≤500）。 */
export function buildRubricApproveBody(input: {
  readonly jobId: string
  readonly rubricVersionId: string
  readonly reason?: string
}): BodyBuildResult {
  const missing: string[] = []
  const jobId = text(input.jobId)
  const rubricVersionId = text(input.rubricVersionId)
  if (!requireUuid(jobId, 'job_id', missing)) {
    return fail('ID_NOT_UUID', '岗位编号缺失或格式不正确', missing)
  }
  if (!requireUuid(rubricVersionId, 'rubric_version_id', missing)) {
    return fail('ID_NOT_UUID', '评分标准版本编号缺失或格式不正确', missing)
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (charLength(reason) > 500) return fail('REASON_OUT_OF_RANGE', '批准理由不得超过 500 字', ['reason'])
  return finish({
    job_id: jobId,
    rubric_version_id: rubricVersionId,
    ...(reason !== '' ? { reason } : {}),
  })
}

/** 设置写 operation 的 create 必填字段（`work/d5/actions/CONTRACT.md` §4.2）。 */
const CONFIG_CREATE_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  role: ['code', 'name', 'permission_scopes'],
  team: ['code', 'name', 'department_id'],
  pipeline: ['code', 'name'],
}

/**
 * 设置统一入口 body：`{entity, operation, ...实体字段}`（只接受写 operation）。
 * 出处：`work/d5/actions/CONTRACT.md` §4.2 + INTERFACE §1 表（`recruiting_settings_write` → `/config`）。
 */
export function buildSettingsWriteBody(input: {
  readonly entity: 'role' | 'team' | 'pipeline'
  readonly operation: string
  readonly fields: Readonly<Record<string, unknown>>
}): BodyBuildResult {
  const entity = text(input.entity)
  if (!(CONFIG_ENTITIES as readonly string[]).includes(entity)) {
    return fail('UNKNOWN_ENTITY', 'entity 只能是 role / team / pipeline', ['entity'])
  }
  const operation = text(input.operation)
  const allowed = CONFIG_WRITE_OPERATIONS[entity] ?? []
  if (operation === '') return fail('MISSING_OPERATION', '请选择要执行的操作（新增或修改）', ['operation'])
  if (!allowed.includes(operation)) {
    const isReadOperation = ['list', 'get', 'read', 'search'].includes(operation)
    return fail(
      isReadOperation ? 'READ_OPERATION_NOT_EXPOSED' : 'OPERATION_INVALID',
      isReadOperation
        ? '这里只能提交新增或修改；查看请到对应的列表页'
        : `只能执行 ${allowed.join(' / ')} 操作`,
      ['operation'],
    )
  }
  const fields = record(input.fields)
  if (operation === 'create') {
    const required = CONFIG_CREATE_REQUIRED[entity] ?? []
    const missingInline = required.filter((key) => {
      const value = fields[key]
      if (key === 'permission_scopes') return !Array.isArray(value) || value.length === 0
      return typeof value !== 'string' || value.trim() === ''
    })
    if (missingInline.length > 0) {
      return fail('MISSING_REQUIRED', `create 缺必填字段：${missingInline.join(', ')}`, missingInline)
    }
  }
  return finish({ entity, operation, ...fields })
}

// =====================================================================
//  job draft / job create（P3；契约见 work/d5/joblife/CONTRACT-ACTIONS.md）
// =====================================================================

/** 草案里一轮的归一化（轮次重点/问题逐条原样展示）。 */
export interface JobDraftRound {
  readonly roundNo: number
  readonly title: string
  readonly focus: readonly string[]
  readonly questions: readonly string[]
}

/** 草案 rubric 维度（key/label/kind/weight/reason；weight 缺失 → null，不补 0）。 */
export interface JobDraftRubricDimension {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number | null
  readonly reason: string
}

/** 草案理由（path/reason/source：为什么这么写，契约要求逐条可追溯）。 */
export interface JobDraftReason {
  readonly path: string
  readonly reason: string
  readonly source: string
}

/** 草案缺失项（key/question：缺的企业事实，交给人工补，不编造）。 */
export interface JobDraftMissingItem {
  readonly key: string
  readonly question: string
}

/** `POST job/draft` 响应的归一化视图（不编造草案内容；缺字段降级成空）。 */
export interface JobDraftView {
  readonly contractVersion: string
  readonly recruitingReason: string
  readonly responsibilities: readonly string[]
  readonly successProfile: readonly string[]
  readonly mustHave: readonly string[]
  readonly niceToHave: readonly string[]
  readonly rounds: readonly JobDraftRound[]
  readonly rubricDimensions: readonly JobDraftRubricDimension[]
  readonly reasons: readonly JobDraftReason[]
  readonly missingItems: readonly JobDraftMissingItem[]
  readonly confirmation: {
    readonly required: boolean
    readonly status: string
    readonly next: readonly string[]
    readonly note: string
  }
}

/** 草案里的文本项：字符串原样；对象取常见文本键，否则 JSON 预览（不编造业务含义）。 */
function draftTextItem(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  const raw = record(value)
  for (const key of ['text', 'title', 'label', 'name', 'description', 'statement', 'focus']) {
    const candidate = text(raw[key])
    if (candidate !== '') return candidate
  }
  return preview(value, 200)
}

/** 文本数组归一化（丢弃空项）。 */
function draftTextList(value: unknown): string[] {
  const out: string[] = []
  for (const item of items(value)) {
    const rendered = draftTextItem(item)
    if (rendered !== '') out.push(rendered)
  }
  return out
}

/** 归一化 `POST job/draft` 响应；没有 `draft` 段 → null（不把空响应当草案）。 */
export function normalizeJobDraftResponse(value: unknown): JobDraftView | null {
  const raw = record(value)
  const draft = record(raw.draft)
  if (Object.keys(draft).length === 0) return null
  const jobDraft = record(draft.job_draft)
  const rubricDraft = record(draft.rubric_draft)
  const rounds: JobDraftRound[] = []
  for (const item of items(jobDraft.rounds)) {
    const entry = record(item)
    rounds.push({
      roundNo: count(entry.round_no),
      title: text(entry.title),
      focus: draftTextList(entry.focus),
      questions: draftTextList(entry.questions),
    })
  }
  const rubricDimensions: JobDraftRubricDimension[] = []
  for (const item of items(rubricDraft.dimensions)) {
    const entry = record(item)
    const key = text(entry.key)
    if (key === '') continue
    rubricDimensions.push({
      key,
      label: text(entry.label) !== '' ? text(entry.label) : key,
      kind: text(entry.kind),
      weight: numberOrNull(entry.weight),
      reason: text(entry.reason),
    })
  }
  const reasons: JobDraftReason[] = []
  for (const item of items(draft.reasons)) {
    const entry = record(item)
    const path = text(entry.path)
    if (path === '') continue
    reasons.push({ path, reason: text(entry.reason), source: text(entry.source) })
  }
  const missingItems: JobDraftMissingItem[] = []
  for (const item of items(draft.missing_items)) {
    const entry = record(item)
    const key = text(entry.key)
    if (key === '') continue
    missingItems.push({ key, question: text(entry.question) })
  }
  const confirmationRaw = record(raw.confirmation)
  return {
    contractVersion: text(raw.contract_version),
    recruitingReason: text(jobDraft.recruiting_reason),
    responsibilities: draftTextList(jobDraft.responsibilities),
    successProfile: draftTextList(jobDraft.success_profile),
    mustHave: draftTextList(jobDraft.must_have),
    niceToHave: draftTextList(jobDraft.nice_to_have),
    rounds,
    rubricDimensions,
    reasons,
    missingItems,
    confirmation: {
      required: confirmationRaw.required === true,
      status: text(confirmationRaw.status),
      next: stringList(confirmationRaw.next),
      note: text(confirmationRaw.note),
    },
  }
}

/** `POST job/draft` body（`request_text` 1..2000；其余可选键给了才带）。 */
export function buildJobDraftBody(input: {
  readonly requestText: string
  readonly recruiterSupplement?: string
  readonly templateId?: string
  readonly departmentContext?: string
}): BodyBuildResult {
  const requestText = typeof input.requestText === 'string' ? input.requestText.trim() : ''
  if (requestText === '') {
    return fail('MISSING_REQUEST_TEXT', '岗位需求原文不能为空（1..2000 字）', ['request_text'])
  }
  if (charLength(requestText) > 2000) {
    return fail('REQUEST_TEXT_TOO_LONG', '岗位需求原文不得超过 2000 字', ['request_text'])
  }
  const body: Record<string, unknown> = { request_text: requestText }
  const supplement = typeof input.recruiterSupplement === 'string' ? input.recruiterSupplement.trim() : ''
  if (supplement !== '') body.recruiter_supplement = supplement
  const departmentContext = typeof input.departmentContext === 'string' ? input.departmentContext.trim() : ''
  if (departmentContext !== '') body.department_context = departmentContext
  const templateId = text(input.templateId)
  if (templateId !== '') body.template_id = templateId
  return finish(body)
}

/**
 * `job/close` body（封闭键集 `job_id` / `confirm` / `reason?`；`confirm:true` 是人类裁决）。
 * 出处：`work/d5/joblife/CONTRACT.md` §1。
 */
export function buildJobCloseBody(input: { readonly jobId: string; readonly reason: string }): BodyBuildResult {
  const jobId = text(input.jobId)
  const missing: string[] = []
  if (!requireUuid(jobId, 'job_id', missing)) {
    return fail('JOB_ID_INVALID', '岗位编号缺失或格式不正确（关闭岗位只按编号操作）', missing)
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (charLength(reason) > 500) return fail('REASON_INVALID', '关闭原因不得超过 500 字', ['reason'])
  return finish({ job_id: jobId, confirm: true, ...(reason !== '' ? { reason } : {}) })
}

/** job-create 的 criteria 权重和容差（`src/tools/job-create.ts`：Σweight = 1，tolerance 1e-6）。 */
const CRITERIA_WEIGHT_TOLERANCE = 1e-6

/**
 * `POST job/create` body：`{job_create_args:{code,title,department_id,description_md,requirements_md,criteria[],status}}`。
 * 客户端只做封闭形状校验（criteria 非空、Σweight≈1、≥1 MUST_HAVE/DISQUALIFIER），业务规则仍在服务端。
 * 出处：`work/d5/joblife/CONTRACT-ACTIONS.md` §2 + `src/tools/job-create.ts` 的 validateDimensions 口径。
 */
export function buildJobCreateBody(input: {
  readonly code: string
  readonly title: string
  readonly departmentId: string
  readonly descriptionMd: string
  readonly requirementsMd: string
  readonly criteria: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly status?: string
}): BodyBuildResult {
  const missing: string[] = []
  const code = text(input.code)
  const title = text(input.title)
  const departmentId = text(input.departmentId)
  if (code === '') missing.push('code')
  else if (!JOB_CODE_RE.test(code)) return fail('CODE_INVALID', '岗位 code 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$', ['code'])
  if (title === '') missing.push('title')
  if (charLength(title) > 200) return fail('TITLE_OUT_OF_RANGE', '岗位名称不得超过 200 字', ['title'])
  if (!requireUuid(departmentId, 'department_id', missing)) {
    if (missing.includes('department_id:ID_NOT_UUID')) {
      return fail('ID_NOT_UUID', '部门编号格式不正确（必须从部门列表中选择）', ['department_id'])
    }
  }
  const descriptionMd = typeof input.descriptionMd === 'string' ? input.descriptionMd : ''
  const requirementsMd = typeof input.requirementsMd === 'string' ? input.requirementsMd : ''
  if (charLength(descriptionMd) > 20_000) return fail('DESCRIPTION_OUT_OF_RANGE', 'description_md 不得超过 20000 字', ['description_md'])
  if (charLength(requirementsMd) > 20_000) return fail('REQUIREMENTS_OUT_OF_RANGE', 'requirements_md 不得超过 20000 字', ['requirements_md'])
  if (missing.length > 0) return fail('MISSING_REQUIRED', `岗位创建缺必填字段：${missing.join(', ')}`, missing)
  if (input.criteria.length === 0) {
    return fail('CRITERIA_REQUIRED', '岗位创建至少需要 1 条评分维度（1..50）', ['criteria'])
  }
  if (input.criteria.length > 50) {
    return fail('CRITERIA_OUT_OF_RANGE', 'criteria 最多 50 条', ['criteria'])
  }
  const criteria: Record<string, unknown>[] = []
  let weightSum = 0
  let hasGate = false
  for (const dimension of input.criteria) {
    const entry = record(dimension)
    const key = text(entry.key)
    const label = text(entry.label)
    const kind = text(entry.kind)
    const weight = entry.weight
    if (key === '' || label === '') {
      return fail('CRITERIA_INCOMPLETE', '每条 criteria 必须有 key/label', ['criteria[].key'])
    }
    if (!(CRITERION_KINDS as readonly string[]).includes(kind)) {
      return fail('CRITERIA_KIND_INVALID', `criteria[].kind 只能是 ${CRITERION_KINDS.join(' / ')}`, ['criteria[].kind'])
    }
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      return fail('CRITERIA_WEIGHT_INVALID', 'criteria[].weight 必须是 0..1 的数字', ['criteria[].weight'])
    }
    weightSum += weight
    if (kind === 'MUST_HAVE' || kind === 'DISQUALIFIER') hasGate = true
    const shaped: Record<string, unknown> = { key, label, kind, weight }
    for (const optionalKey of ['field', 'operator', 'question', 'notes']) {
      const value = entry[optionalKey]
      if (typeof value === 'string' && value.trim() !== '') shaped[optionalKey] = value
    }
    const rawValue = entry.value
    if (
      typeof rawValue === 'boolean' ||
      (typeof rawValue === 'number' && Number.isFinite(rawValue)) ||
      (typeof rawValue === 'string' && rawValue.trim() !== '')
    ) {
      shaped.value = rawValue
    }
    criteria.push(shaped)
  }
  if (Math.abs(weightSum - 1) > CRITERIA_WEIGHT_TOLERANCE) {
    return fail(
      'CRITERIA_WEIGHT_SUM',
      `criteria 的 weight 之和必须为 1（当前 ${weightSum.toFixed(6)}；服务端容差 1e-6）`,
      ['criteria[].weight'],
    )
  }
  if (!hasGate) {
    return fail('CRITERIA_KIND_REQUIRED', 'criteria 至少要有一条 MUST_HAVE 或 DISQUALIFIER', ['criteria[].kind'])
  }
  const status = text(input.status)
  if (status !== '' && !(JOB_CREATE_STATUSES as readonly string[]).includes(status)) {
    return fail('STATUS_INVALID', '初始状态只能是 DRAFT / OPEN', ['status'])
  }
  const jobCreateArgs: Record<string, unknown> = {
    code,
    title,
    department_id: departmentId,
    description_md: descriptionMd,
    requirements_md: requirementsMd,
    criteria,
    status: status !== '' ? status : 'DRAFT',
  }
  return finish({ job_create_args: jobCreateArgs })
}

// =====================================================================
//  发送前自检（用-recruiting 的 post* 都先过这里；纯函数，可单测）
// =====================================================================

/** 造一个发送前拒绝结果。 */
function refuse(reasonCode: string, reasonText: string, missing: readonly string[] = []): WriteRequestCheck {
  return { ok: false, status: 0, code: 'CLIENT_REFUSED', reasonCode, reasonText, missing }
}

/**
 * 任意写请求的发送前自检：`sessionId` 非空、body 非空、body 顶层无保留键、path 是同源相对路径。
 * @param path - 待 POST 的同源相对路径。
 * @param body - 已由 build* 产出的 body。
 * @param sessionId - 宿主传入的 session id（**只从形参来，不读 localStorage**）。
 */
export function checkWriteRequest(
  path: string,
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): WriteRequestCheck {
  if (text(sessionId) === '') {
    return refuse('SESSION_MISSING', '还没有识别到当前身份：请先在工作台顶部选择身份', ['sessionId'])
  }
  if (path === '' || !path.startsWith('/recruitment/') || path.startsWith('//')) {
    return refuse('UNSAFE_SEAM', `写动作必须通过本页面发起（当前路径：${path}），客户端不发送请求`, ['path'])
  }
  const keys = Object.keys(body)
  if (keys.length === 0) {
    return refuse('EMPTY_BODY', '写请求 body 为空（固定发 {} 会被服务端 400 MISSING_REQUIRED）', ['body'])
  }
  const reserved = reservedKeysOf(body)
  if (reserved.length > 0) {
    return refuse(
      'CLIENT_RESERVED_KEY',
      `body 含客户端禁止上送的身份/服务端派生键：${reserved.join(', ')}；客户端不发送`,
      reserved,
    )
  }
  return { ok: true }
}

/** 动作写请求的自检：在 {@link checkWriteRequest} 之前先看服务端可用性。 */
export function checkActionRequest(
  action: ActionView,
  body: Readonly<Record<string, unknown>>,
  sessionId: string,
): WriteRequestCheck {
  if (!action.available) {
    return refuse(
      'ACTION_NOT_AVAILABLE',
      `动作 ${action.key} 当前不可用（${action.pending !== '' ? action.pending : '尚未提供入口'}）；客户端不发送`,
      ['action.available'],
    )
  }
  return checkWriteRequest(action.seam, body, sessionId)
}

// =====================================================================
//  读回显示（键/值原样，不做业务推断）
// =====================================================================

/** 读回行的 label：已知键给中文，未知键原样（记录里没有业务结论）。 */
function labelOf(key: string): string {
  const direct = READBACK_LABELS[key]
  if (direct !== undefined) return direct
  const segments = key.split('.')
  const last = segments[segments.length - 1] ?? key
  return READBACK_LABELS[last] ?? key
}

/** 造一行读回显示。 */
function lineOf(key: string, value: unknown): ReadbackLine {
  return { key, label: labelOf(key), value: rawValueText(value) }
}

/** 把普通对象铺成 `prefix.key` 行（数组/标量当值原样；不递归推断业务含义）。 */
function objectLines(prefix: string, value: Readonly<Record<string, unknown>>): ReadbackLine[] {
  const out: ReadbackLine[] = []
  for (const [key, child] of Object.entries(value)) {
    out.push(lineOf(prefix === '' ? key : `${prefix}.${key}`, child))
  }
  return out
}

/**
 * 标准信封 `readback` → 显示行（键/值原样，顺序 = 服务端 JSON 键序）。
 * @param envelope - `parseActionEnvelope` 的结果；null → 空数组。
 */
export function readbackLines(envelope: ActionEnvelope | null): readonly ReadbackLine[] {
  if (envelope === null || envelope.readback === null) return []
  return objectLines('', envelope.readback)
}

/**
 * 任意写动作响应 → 显示行：标准信封用 `readback`；非标准信封（evaluate/record/draft/create/job-close）
 * 把 `readback`/`decision`/`evaluation`/`job`/`draft` 等段铺成 `段.键` 行（键/值原样）。
 * @param outcome - 最近一次写动作结果；undefined → 空数组。
 */
export function actionResultLines(outcome: ActionOutcome | undefined | null): readonly ReadbackLine[] {
  if (outcome === undefined || outcome === null) return []
  const envelopeLines = readbackLines(outcome.envelope)
  if (envelopeLines.length > 0) return envelopeLines
  const payload = outcome.payload
  if (payload === null) return []
  const out: ReadbackLine[] = []
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'error') continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>
      const row = nested.row
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
        out.push(lineOf(`${key}.table`, nested.table))
        out.push(...objectLines(`${key}.row`, row as Record<string, unknown>))
        continue
      }
      out.push(...objectLines(key, nested))
      continue
    }
    out.push(lineOf(key, value))
  }
  return out
}

// =====================================================================
//  时间：datetime-local → 带偏移 ISO-8601
// =====================================================================

/**
 * 把 `<input type="datetime-local">` 的 `YYYY-MM-DDTHH:mm[:ss]` 解释为**浏览器本地时间**，
 * 输出带时区偏移的 ISO-8601（服务端 `TIMESTAMP_WITHOUT_OFFSET` 会拒绝裸本地时间）。
 * @param localValue - datetime-local 的原始值。
 * @returns 带偏移 ISO-8601；无法解析 → ''（调用方按 MISSING_START 处理）。
 */
export function toOffsetIso(localValue: string): string {
  const raw = text(localValue)
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (match === null) return ''
  const year = match[1] as string
  const month = match[2] as string
  const day = match[3] as string
  const hour = match[4] as string
  const minute = match[5] as string
  const second = match[6] ?? '00'
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  )
  if (!Number.isFinite(date.valueOf())) return ''
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const offsetHours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const offsetRest = String(absolute % 60).padStart(2, '0')
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHours}:${offsetRest}`
}

/** 生成一个符合 `[A-Za-z0-9_.:-]{1,200}` 的排期幂等键（前端生成并保留，重试复用同一 key）。 */
export function newIdempotencyKey(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return `ui-schedule-${random}`
}
