// Interviewer Workspace 的**纯函数**数据层：把宿主 HTTP 响应与 W1 form spec
// 归一化成安全形状，不 import react / 不碰 DOM / 不发请求，供 `node --test` 直接覆盖。
//
// 为什么单独一层：界面拿到的第一手数据是"服务端可能只给了一半的 JSON"。如果渲染层直接
// 取 `interview.brief.focus.map(...)`，一个坏字段就会把整页打成白屏或显示 `undefined`。
// 这里统一收紧成 string / number / boolean / 数组 / null，坏类型一律降级
// （'' / 0 / [] / null），**不编造业务值**——缺什么就显示"服务端未提供"。
//
// 三条业务纪律（W3 契约 §1.4 / §2.3，写死在纯函数里）：
//   1. `transcript` 与 `scorecard` 是两个独立分支：本文件只做"原文透传 + 文本映射"，
//      绝不用 interview.status 推导转写或面评状态。
//   2. 面评提交体的维度键**只能**来自 W1 form spec 的 `dimensions[].key`（`buildScorecardSubmitBody`）；
//      缺维度 / 维度不在 spec / 未知枚举一律拒绝，绝不把前端的自由键发给服务端。
//   3. counts 由服务端算：`deriveWorkspaceStats` 只透传，不用列表行数改写。

import { normalizeRoundEffective, type RoundEffectiveView } from './round.ts'

// 轮次有效评分标准（task-50 的 round_focus / effective_rubric）在 `round.ts` 里归一化；
// 这里只把投影挂到每行（W3B 契约 §2：InterviewRow 加法式新增 `round`，既有字段语义不变）。

/** 转写派生状态（TR-D 七条；客户端只做文本映射，不做二次推导）。 */
export const TRANSCRIPT_STATES = [
  'READY',
  'PARTIAL',
  'PENDING',
  'MISSING',
  'AUTH_REQUIRED',
  'NEEDS_LINKING',
  'RETRYABLE_FAILED',
] as const

/** 面评当前状态（与 overview 契约 §1.4 一致；`scorecard.status` 是另一根轴，不压平）。 */
export const SCORECARD_STATES = ['NONE', 'PENDING', 'SUBMITTED', 'WAIVED'] as const

/** 面评维度的 assessment 封闭枚举（scorecard-rules / D-89）。 */
export const ASSESSMENT_VALUES = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const

/** 面评 overall 封闭枚举（scorecard-rules）。 */
export const OVERALL_VALUES = ['ADVANCE', 'HOLD', 'REJECT'] as const

/** `items.transcript_basis` 保留键的封闭枚举（TR-E2）。 */
export const TRANSCRIPT_BASES = ['TRANSCRIPT', 'NO_TRANSCRIPT'] as const

/** 一句话说明 assessment 的中文含义（只做展示，不改变枚举值）。 */
const ASSESSMENT_TEXT: Readonly<Record<string, string>> = {
  MET: '符合',
  NOT_MET: '不符合',
  NOT_OBSERVED: '未观察到',
  UNREADABLE: '无法判读',
}

/** overall 的中文含义。 */
const OVERALL_TEXT: Readonly<Record<string, string>> = {
  ADVANCE: '推进',
  HOLD: '暂缓',
  REJECT: '不通过',
}

/**
 * 转写状态的中文含义（TR-D 七条）。
 *
 * D-133 口径：只给**事实时态**——已收到 / 还没收到 / 读不出来（处理失败如实写「处理失败」）；
 * 禁止「缺失 / 缺件 / 未就绪」叙事。枚举键与类型不变，这里只改给人看的文案。
 */
const TRANSCRIPT_STATE_TEXT: Readonly<Record<string, string>> = {
  READY: '已收到（完整）',
  PARTIAL: '已收到（部分）',
  PENDING: '还没收到',
  MISSING: '还没收到',
  AUTH_REQUIRED: '读不出来（需要重新授权）',
  NEEDS_LINKING: '读不出来（还没关联会议）',
  RETRYABLE_FAILED: '处理失败（可重试）',
}

/** 面评状态的中文含义（NONE/PENDING/SUBMITTED/WAIVED）。 */
const SCORECARD_STATE_TEXT: Readonly<Record<string, string>> = {
  NONE: '未填',
  PENDING: '草稿',
  SUBMITTED: '已提交',
  WAIVED: '已豁免',
}

/** 会议绑定状态的中文含义。 */
const MEETING_BINDING_TEXT: Readonly<Record<string, string>> = {
  BOUND_ACTIVE: '已绑定（有效）',
  UNBOUND: '未绑定',
  NONE_EXPECTED: '无需会议',
}

/** 简报来源的中文含义（服务端标注，客户端不冒充"原简报"）。 */
const BRIEF_SOURCE_TEXT: Readonly<Record<string, string>> = {
  TEMPLATE: '面试模板',
  JOB_RUBRIC: '岗位 Rubric 维度',
  NONE: '无简报',
}

/** 一条面试行里"我"的身份只可能是已登记的面试官（契约 §1.4）。 */
const ROLE_INTERVIEWER = 'INTERVIEWER'

/** 服务端 counts（归一化后全部为非负整数）。 */
export interface WorkspaceCounts {
  readonly assigned_total: number
  readonly open_interview_total: number
  readonly pending_scorecard_total: number
  readonly submitted_scorecard_total: number
  readonly transcript_ready_total: number
  readonly transcript_missing_total: number
}

/** 当前演示身份（只来自服务端；客户端不接受覆盖参数）。 */
export interface WorkspaceActor {
  readonly alias: string
  readonly actor_id: string
  readonly display_name: string
  readonly roles: readonly string[]
}

/** 三维外部能力标签（R4：不许混成一维枚举）。 */
export interface WorkspaceLabels {
  readonly provenance: string
  readonly trigger: string
  readonly connection: string
}

/** 本轮考察重点的一条（旧 brief：template.focus 或 rubric 维度回退）。 */
export interface BriefFocus {
  readonly key: string
  readonly label: string
  readonly weight: number
  /** 旧 brief 没有 required；轮次配置聚合时补 true（重点维度默认必答）。 */
  readonly required?: boolean
}

/** 本轮面试简报（`brief`）。 */
export interface InterviewBrief {
  readonly available: boolean
  /** `TEMPLATE` | `JOB_RUBRIC` | `NONE`（未知值原样保留，展示时说"未知来源"）。 */
  readonly source: string
  readonly objective: string
  readonly briefing: string
  readonly focus: readonly BriefFocus[]
  readonly questions: readonly string[]
  readonly template_version_id: string
  readonly template_payload_hash: string
  /** `source='NONE'` 时服务端给的原因（不猜）。 */
  readonly reason: string
}

/** rubric 维度元数据（只读展示）。 */
export interface RubricDimensionInfo {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly question: string
}

/** 申请钉住的 rubric 版本（没有就是 null：不猜版本）。 */
export interface InterviewRubric {
  readonly rubric_version_id: string
  readonly job_id: string
  readonly payload_hash: string
  readonly dimensions: readonly RubricDimensionInfo[]
}

/** 授权材料里的简历版本（`fields` 原样保留，由界面做安全拍平）。 */
export interface ResumeMaterialInfo {
  readonly resume_version_id: string
  readonly parse_status: string
  readonly parser_name: string
  readonly parser_version: string
  readonly content_sha256: string
  readonly fields: Readonly<Record<string, unknown>>
}

/** 授权材料（`authorization` 说明依据；不可用给 reason）。 */
export interface InterviewMaterials {
  readonly authorization: string
  readonly available: boolean
  readonly reason: string
  readonly resume: ResumeMaterialInfo | null
}

/** 转写分支（TR-D 派生结果的透传；客户端不二次推导）。 */
export interface TranscriptInfo {
  readonly state: string
  readonly reason_code: string
  readonly no_transcript: boolean
  readonly meeting_binding_state: string
  readonly meetings_total: number
}

/** 面评分支：**只看得到我自己的那一份**（服务端已按 actor 过滤）。 */
export interface ScorecardInfo {
  readonly state: string
  readonly scorecard_id: string
  readonly status: string
  readonly revision_no: number
  readonly record_version: number
  readonly submitted_at: string
  readonly transcript_basis: string
  readonly overall: string
}

/**
 * 前置轮次里一位面试官的面评结论（客户端视图；**不抄** note / rationale 原文）。
 *
 * 服务端字段名是 `display_name` / `scorecard_state` / `scorecard_submitted` / `conclusion`，
 * 客户端归一化成 camelCase；坏类型一律降级（'' / false / null），界面不编造结论。
 */
export interface PriorRoundInterviewerView {
  /** `actor.display_name` 原文；库里没有显示名 → ''（不编造）。 */
  readonly displayName: string
  /** 面评当前状态：`NONE` / `PENDING` / `SUBMITTED` / `WAIVED`（未知值保留原文，展示时降级）。 */
  readonly scorecardState: string
  readonly scorecardSubmitted: boolean
  /** `scorecard.overall` 原值（ADVANCE / HOLD / REJECT）；未提交/无面评/坏类型 → null。 */
  readonly conclusion: 'ADVANCE' | 'HOLD' | 'REJECT' | null
}

/** 前置轮次的一个岗位标准维度（`key` 只用于对齐/复核，客户端**不渲染**它）。 */
export interface PriorRoundDimensionView {
  readonly key: string
  readonly label: string
  readonly weight: number
}

/** 已被覆盖的维度 + 该轮面评里的判定原值（只有 MET / NOT_MET 算"给了实质判定"）。 */
export interface PriorRoundCoveredDimensionView extends PriorRoundDimensionView {
  readonly assessment: 'MET' | 'NOT_MET'
  /** 1..5 的整数；面评没给（违反契约的脏数据）→ null。 */
  readonly score: number | null
}

/** 未被覆盖的维度 + 可复核的原因码（原因码只在归一化层，渲染时映射成中文）。 */
export interface PriorRoundUncoveredDimensionView extends PriorRoundDimensionView {
  readonly reason: string
}

/**
 * 一场前置轮次的面试（紧邻上一轮；同一轮多场就是多个元素）。
 *
 * 只看结构化事实：面试官面评状态/结论、岗位标准维度覆盖情况。
 * 不渲染 `interviewId` / `key` / `reason` 机器码（D-141）。
 */
export interface PriorRoundView {
  readonly roundNo: number
  readonly interviewId: string
  readonly status: string
  readonly slotCode: string
  readonly scheduledStartAt: string
  readonly interviewers: readonly PriorRoundInterviewerView[]
  /** 该轮维度宇宙是否可用；false 时两个维度数组都是空（不判定覆盖、不推测）。 */
  readonly dimensionsAvailable: boolean
  readonly coveredDimensions: readonly PriorRoundCoveredDimensionView[]
  readonly uncoveredDimensions: readonly PriorRoundUncoveredDimensionView[]
}

/** 本轮的一条参考（面向面试官的两句中文；`basis*` 只用于复核，**不渲染**）。 */
export interface ReferencePointView {
  readonly point: string
  readonly why: string
  /** `RUBRIC_DIMENSION` / `PRIOR_GAP` / `RESUME_HIGHLIGHT`（原值保留，不渲染）。 */
  readonly basisKind: string
  /** 维度 key 或 `work_experience[<index>]`（原值保留，不渲染）。 */
  readonly basisRef: string
}

/** 一条"分配给我的面试"（§1.4 的 interviews[] 元素）。 */

/** 候选人置顶约束 / 上一轮交接追问（Task 06 · T6-1）。 */
export interface InterviewConstraintView {
  readonly kind: 'PIN' | 'HANDOFF'
  readonly text: string
  readonly source: string
  readonly from_previous_round: boolean
}

/** 面评草稿数据结构（Task 06 · T6-2：GET/POST /recruitment/api/action/scorecard/draft）。 */
export interface ScorecardDraftPayload {
  readonly assessments: Readonly<Record<string, string>>
  readonly note: string
}

export interface InterviewRow {
  readonly interview_id: string
  readonly application_id: string
  readonly candidate: { readonly candidate_id: string; readonly display_name: string }
  readonly job: { readonly job_id: string; readonly code: string; readonly title: string }
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
  readonly stage_code: string
  readonly scheduled_start_at: string
  readonly scheduled_end_at: string
  readonly timezone: string
  readonly record_version: number
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  readonly scorecard_due_at: string
  readonly brief: InterviewBrief
  readonly constraints: readonly InterviewConstraintView[]
  readonly iqs: readonly string[]
  /** 轮次级考察重点 + 本轮生效评分表（task-50 `round_focus`/`effective_rubric` 投影；缺字段时如实降级）。 */
  readonly round: RoundEffectiveView
  readonly rubric: InterviewRubric | null
  readonly materials: InterviewMaterials
  readonly transcript: TranscriptInfo
  readonly scorecard: ScorecardInfo
  readonly required_action: string
  /** 前置轮次摘要（服务端 `prior_rounds`；缺字段/坏类型 → 空数组，不抛）。 */
  readonly priorRounds: readonly PriorRoundView[]
  /** 本轮参考点（服务端 `reference_points`；缺字段/坏类型 → 空数组，不抛）。 */
  readonly referencePoints: readonly ReferencePointView[]
}

/** 面试官工作台读模型（`GET /recruitment/api/interviewer/overview`）。 */
export interface InterviewerOverview {
  readonly contract_version: string
  readonly configured: boolean
  readonly evaluated_at: string
  readonly actor: WorkspaceActor
  readonly session_id: string
  readonly labels: WorkspaceLabels
  readonly counts: WorkspaceCounts
  readonly interviews: readonly InterviewRow[]
  readonly issues: readonly string[]
}

/** W1 form spec 的一个维度控件（键、枚举、分值区间都只来自服务端）。 */
export interface FormDimension {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly question: string
  readonly assessmentOptions: readonly string[]
  readonly scoreMin: number
  readonly scoreMax: number
  readonly noteRequired: boolean
}

/** W1 `GET /recruitment/api/action/scorecard/form` 归一化后的形状。 */
export interface ScorecardFormSpec {
  readonly contract_version: string
  /** 一次性 nonce（绑 session+interview+application，短 TTL）；原样回传。 */
  readonly nonce: string
  readonly expires_at: string
  readonly actor_alias: string
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
    readonly dimensions: readonly RubricDimensionInfo[]
  }
  readonly dimensions: readonly FormDimension[]
  readonly transcript_basis: {
    readonly value: string
    readonly options: readonly string[]
    readonly locked: boolean
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
}

/** 一个维度的取值（提交体里的形状）。 */
export interface ScorecardDimensionAnswer {
  readonly assessment: string
  readonly score?: number
  readonly note?: string
}

/** 表单里人填的答案（只认可 spec 里出现过的维度键）。 */
export interface ScorecardAnswers {
  readonly dimensions: Readonly<Record<string, ScorecardDimensionAnswer>>
  readonly overall: string
}

/** W1 `POST /recruitment/api/action/scorecard/submit` 的提交体（2026-11-15 冻结形状）。 */
export interface ScorecardSubmitBody {
  readonly interview_id: string
  /** 可选：申请未钉 rubric 时服务端要求显式给（这里用 form spec 已解析出的版本 id）。 */
  readonly rubric_version_id?: string
  readonly dimensions: Readonly<Record<string, ScorecardDimensionAnswer>>
  readonly transcript_basis: string
  readonly overall: string
  readonly nonce: string
}

/** 提交体构造结果：失败给可读原因（fail-closed，不发请求）。 */
export type BuildSubmitBodyResult =
  | { readonly ok: true; readonly body: ScorecardSubmitBody }
  | { readonly ok: false; readonly message: string }

/** W1 提交成功的 DB 读回（服务端事实；界面必须逐字段展示）。 */
export interface ScorecardSubmitResult {
  readonly scorecard_id: string
  readonly status: string
  readonly actor_id: string
  readonly record_version: number
  readonly interviewer_id: string
  readonly interview_id: string
  readonly replayed: boolean
}

/** 工作台头部三格统计（值取服务端 counts，`row_count` 才是本地行数）。 */
export interface WorkspaceStats {
  readonly assigned_total: number
  readonly open_interview_total: number
  readonly pending_scorecard_total: number
  readonly submitted_scorecard_total: number
  readonly transcript_ready_total: number
  readonly transcript_missing_total: number
  /** 本地实际渲染的行数（只做诊断/展示，**不**用来改写 assigned_total）。 */
  readonly row_count: number
}

/** 列表右栏"分配轮次与考察重点"的一组。 */
export interface RoundFocusGroup {
  readonly round_no: number
  readonly objective: string
  readonly focus: readonly BriefFocus[]
  /** `'ROUND_CONFIG' | 'JOB_BASE' | 'LEGACY_BRIEF'`（旧端点无 round_focus 时用旧 brief 聚合）。 */
  readonly source: string
  /** 轮次配置标题（`round_focus.title`；降级/旧端点为空串）。 */
  readonly title: string
  /** 服务端是否明确提供该轮配置（false = JOB_BASE 降级，不展示伪造的重点）。 */
  readonly available: boolean
}

/** 授权材料里的一条可展示字段（拍平后的安全文本）。 */
export interface MaterialFieldEntry {
  readonly key: string
  readonly label: string
  readonly value: string
}

/** 带 HTTP 状态与契约字段的错误：界面按 code/reason_code 原样展示。 */
export class RecruitmentHttpError extends Error {
  /** HTTP 状态码（网络层失败为 0）。 */
  readonly status: number
  /** 契约错误码（`DEMO_ACTOR_UNMAPPED` 等）；解析不到为空串。 */
  readonly code: string
  /** 契约原因码；解析不到为空串。 */
  readonly reasonCode: string
  /** 服务端 detail 原样保留（展示用）。 */
  readonly detail: unknown

  constructor(status: number, code: string, reasonCode: string, message: string, detail: unknown) {
    super(message)
    this.name = 'RecruitmentHttpError'
    this.status = status
    this.code = code
    this.reasonCode = reasonCode
    this.detail = detail
  }
}

/** 取一个对象；null / 数组 / 非对象一律降级为空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 取一个非空字符串；数字/布尔不算文本（避免把坏类型伪装成业务值）。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取一个有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 取一个非负有限整数；否则 0。 */
function asCount(value: unknown): number {
  const number = asFiniteNumber(value)
  return number >= 0 ? Math.trunc(number) : 0
}

/** 取一个布尔；只认严格 true。 */
function asBool(value: unknown): boolean {
  return value === true
}

/** 字符串数组归一化（丢弃非字符串 / 空串；上限 200 项防止坏响应撑爆内存）。 */
function asStringArray(value: unknown, limit = 200): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= limit) break
    const text = asText(item)
    if (text !== '') out.push(text)
  }
  return out
}

/** 拍平标量字段为可展示文本；对象/数组降级为空串（避免 `[object Object]`）。 */
function asDisplayText(value: unknown, maxLength = 300): string {
  if (typeof value === 'string') {
    const text = value.trim()
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return ''
}

/** 归一化三维标签：缺项给空串（界面显示"未提供"，不借默认值冒充）。 */
function normalizeLabels(value: unknown): WorkspaceLabels {
  const raw = asRecord(value)
  return {
    provenance: asText(raw.provenance),
    trigger: asText(raw.trigger),
    connection: asText(raw.connection),
  }
}

/** 归一化 counts（不读列表长度，服务端算多少就是多少）。 */
function normalizeCounts(value: unknown): WorkspaceCounts {
  const raw = asRecord(value)
  return {
    assigned_total: asCount(raw.assigned_total),
    open_interview_total: asCount(raw.open_interview_total),
    pending_scorecard_total: asCount(raw.pending_scorecard_total),
    submitted_scorecard_total: asCount(raw.submitted_scorecard_total),
    transcript_ready_total: asCount(raw.transcript_ready_total),
    transcript_missing_total: asCount(raw.transcript_missing_total),
  }
}

/** 归一化 actor。 */
function normalizeActor(value: unknown): WorkspaceActor {
  const raw = asRecord(value)
  return {
    alias: asText(raw.alias),
    actor_id: asText(raw.actor_id),
    display_name: asText(raw.display_name),
    roles: asStringArray(raw.roles, 20),
  }
}

/** 归一化 brief：focus 允许对象（契约形状）或纯字符串（防御旧响应）。 */
function normalizeBrief(value: unknown): InterviewBrief {
  const raw = asRecord(value)
  const focus: BriefFocus[] = []
  if (Array.isArray(raw.focus)) {
    for (const item of raw.focus.slice(0, 50)) {
      if (typeof item === 'string') {
        const label = asText(item)
        if (label !== '') focus.push({ key: '', label, weight: 0 })
        continue
      }
      const entry = asRecord(item)
      const key = asText(entry.key)
      const label = asText(entry.label) || key
      if (key === '' && label === '') continue
      focus.push({ key, label, weight: asFiniteNumber(entry.weight) })
    }
  }
  return {
    available: asBool(raw.available),
    source: asText(raw.source),
    objective: asText(raw.objective),
    briefing: asText(raw.briefing),
    focus,
    questions: asStringArray(raw.questions, 50),
    template_version_id: asText(raw.template_version_id),
    template_payload_hash: asText(raw.template_payload_hash),
    reason: asText(raw.reason),
  }
}

/** 归一化 rubric 维度数组（key 为空的行丢弃：没有键就无法对齐面评）。 */
function normalizeRubricDimensions(value: unknown): RubricDimensionInfo[] {
  const out: RubricDimensionInfo[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    const raw = asRecord(item)
    const key = asText(raw.key)
    if (key === '') continue
    out.push({
      key,
      label: asText(raw.label) || key,
      kind: asText(raw.kind),
      weight: asFiniteNumber(raw.weight),
      question: asText(raw.question),
    })
  }
  return out
}

/** 归一化 rubric（没有版本 id 且没有维度 → null；不猜版本）。 */
function normalizeRubric(value: unknown): InterviewRubric | null {
  if (value === null || value === undefined) return null
  const raw = asRecord(value)
  const rawId = asText(raw.rubric_version_id) || asText(raw.id)
  const dimensions = normalizeRubricDimensions(raw.dimensions)
  if (rawId === '' && dimensions.length === 0) return null
  return {
    rubric_version_id: rawId,
    job_id: asText(raw.job_id),
    payload_hash: asText(raw.payload_hash),
    dimensions,
  }
}

/** 归一化授权材料。 */
function normalizeMaterials(value: unknown): InterviewMaterials {
  const raw = asRecord(value)
  const resumeRaw = raw.resume
  let resume: ResumeMaterialInfo | null = null
  if (resumeRaw !== null && typeof resumeRaw === 'object' && !Array.isArray(resumeRaw)) {
    const entry = asRecord(resumeRaw)
    resume = {
      resume_version_id: asText(entry.resume_version_id),
      parse_status: asText(entry.parse_status),
      parser_name: asText(entry.parser_name),
      parser_version: asText(entry.parser_version),
      content_sha256: asText(entry.content_sha256),
      fields: asRecord(entry.fields),
    }
  }
  return {
    authorization: asText(raw.authorization),
    available: asBool(raw.available),
    reason: asText(raw.reason),
    resume,
  }
}

/** 归一化转写分支（只透传 TR-D 的结果）。 */
function normalizeTranscript(value: unknown): TranscriptInfo {
  const raw = asRecord(value)
  return {
    state: asText(raw.state),
    reason_code: asText(raw.reason_code),
    no_transcript: asBool(raw.no_transcript),
    meeting_binding_state: asText(raw.meeting_binding_state),
    meetings_total: asCount(raw.meetings_total),
  }
}

/** 归一化面评分支（服务端只给"我"的那一行；缺 id 不代表没面评，state 说了算）。 */
function normalizeScorecard(value: unknown): ScorecardInfo {
  const raw = asRecord(value)
  return {
    state: asText(raw.state),
    scorecard_id: asText(raw.scorecard_id),
    status: asText(raw.status),
    revision_no: asCount(raw.revision_no),
    record_version: asCount(raw.record_version),
    submitted_at: asText(raw.submitted_at),
    transcript_basis: asText(raw.transcript_basis),
    overall: asText(raw.overall),
  }
}

/** 取一个 1..5 的整数分；其它（小数/越界/非数字/字符串数字）→ null（不猜分数）。 */
function asScore1to5(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
}

/** 取一个封闭枚举内的字符串；不在集合内 → ''（避免把机器码带进渲染）。 */
function asEnumText(value: unknown, allowed: readonly string[]): string {
  const text = asText(value)
  return (allowed as readonly string[]).includes(text) ? text : ''
}

/** 归一化前置轮次的一位面试官（坏类型降级，不抛）。 */
function normalizePriorRoundInterviewer(value: unknown): PriorRoundInterviewerView | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const state = asEnumText(raw.scorecard_state, SCORECARD_STATES)
  const conclusion = asEnumText(raw.conclusion, OVERALL_VALUES)
  return {
    displayName: asText(raw.display_name),
    scorecardState: state,
    scorecardSubmitted: asBool(raw.scorecard_submitted),
    conclusion:
      conclusion === 'ADVANCE' || conclusion === 'HOLD' || conclusion === 'REJECT' ? conclusion : null,
  }
}

/** 归一化一位前置轮次面试官数组（非数组 → 空；非对象元素丢弃；上限 20）。 */
function normalizePriorRoundInterviewers(value: unknown): PriorRoundInterviewerView[] {
  const out: PriorRoundInterviewerView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 20)) {
    const entry = normalizePriorRoundInterviewer(item)
    if (entry !== null) out.push(entry)
  }
  return out
}

/** 取维度公共部分（key / label / weight）；key 与 label 都空 → null（无法展示）。 */
function priorDimensionBase(raw: Record<string, unknown>): PriorRoundDimensionView | null {
  const key = asText(raw.key)
  const label = asText(raw.label)
  if (key === '' && label === '') return null
  return { key, label: label !== '' ? label : key, weight: asFiniteNumber(raw.weight) }
}

/** 归一化"已覆盖的维度"（只有 MET / NOT_MET 算覆盖；其它 assessment 一律丢弃）。 */
function normalizePriorRoundCoveredDimensions(value: unknown): PriorRoundCoveredDimensionView[] {
  const out: PriorRoundCoveredDimensionView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const base = priorDimensionBase(raw)
    if (base === null) continue
    const assessment = asEnumText(raw.assessment, ASSESSMENT_VALUES)
    if (assessment !== 'MET' && assessment !== 'NOT_MET') continue
    out.push({ ...base, assessment, score: asScore1to5(raw.score) })
  }
  return out
}

/** 归一化"未覆盖的维度"（原因码原样保留在归一化层；渲染时映射成中文）。 */
function normalizePriorRoundUncoveredDimensions(value: unknown): PriorRoundUncoveredDimensionView[] {
  const out: PriorRoundUncoveredDimensionView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const base = priorDimensionBase(raw)
    if (base === null) continue
    out.push({ ...base, reason: asText(raw.reason) })
  }
  return out
}

/**
 * 归一化服务端 `prior_rounds`（前置轮次摘要）。
 *
 * 契约：每行恒存在；缺字段 / 坏类型 / 半个字段一律降级为空数组或空字段，**绝不抛**。
 * 只保留可展示的结构化事实，不带 `items[*].note` / `rationale` 之类的原文。
 * @param value - 服务端原始值。
 * @returns 前置轮次数组（顺序按服务端；上限 10 场）。
 */
export function normalizePriorRounds(value: unknown): PriorRoundView[] {
  const out: PriorRoundView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 10)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    out.push({
      roundNo: asCount(raw.round_no),
      interviewId: asText(raw.interview_id),
      status: asText(raw.status),
      slotCode: asText(raw.slot_code),
      scheduledStartAt: asText(raw.scheduled_start_at),
      interviewers: normalizePriorRoundInterviewers(raw.interviewers),
      dimensionsAvailable: asBool(raw.dimensions_available),
      coveredDimensions: normalizePriorRoundCoveredDimensions(raw.covered_dimensions),
      uncoveredDimensions: normalizePriorRoundUncoveredDimensions(raw.uncovered_dimensions),
    })
  }
  return out
}

/**
 * 归一化服务端 `reference_points`（本轮参考）。
 *
 * 只保留 `point` / `why` 两句面向面试官的中文 + `basis` 复核字段；
 * `point` 为空的条目丢弃（没有要点就没有可渲染的内容）。
 * @param value - 服务端原始值。
 * @returns 参考点数组（上限 8 条）。
 */
export function normalizeReferencePoints(value: unknown): ReferencePointView[] {
  const out: ReferencePointView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 8)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    const point = asText(raw.point)
    if (point === '') continue
    const basis = asRecord(raw.basis)
    out.push({
      point,
      why: asText(raw.why),
      basisKind: asText(basis.kind),
      basisRef: asText(basis.ref),
    })
  }
  return out
}

/**
 * 归一化一条面试行。
 * @param value - 服务端原始行。
 * @returns 安全形状；所有嵌套分支都补齐（不出现 undefined）。
 */

function normalizeConstraints(value: unknown, legacy?: unknown): InterviewConstraintView[] {
  // 服务端真实形状：`candidate_constraints: { pins: [...], handoff: {...} | [...] }`（interviewer 读投影）。
  // 旧形状（数组）保留兼容；两者都没有 = 没有约束（不编造）。
  const out: InterviewConstraintView[] = []
  const pushAll = (input: unknown, kind: 'PIN' | 'HANDOFF'): void => {
    const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      const text = typeof raw.text === 'string' ? raw.text.trim() : ''
      if (text === '') continue
      out.push({
        kind,
        text,
        source: typeof raw.source === 'string' ? raw.source : '',
        from_previous_round: kind === 'HANDOFF' || Boolean(raw.from_previous_round),
      })
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const node = value as Record<string, unknown>
    pushAll(node.pins, 'PIN')
    pushAll(node.handoff, 'HANDOFF')
    return out
  }
  pushAll(value, 'PIN')
  pushAll(legacy, 'PIN')
  return out
}

function normalizeIqs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
    else if (item && typeof item === 'object') {
      const t = (item as Record<string, unknown>).t ?? (item as Record<string, unknown>).text
      if (typeof t === 'string' && t.trim() !== '') out.push(t.trim())
    }
  }
  return out
}

export function normalizeScorecardDraft(value: unknown): ScorecardDraftPayload | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const inner = (raw.payload && typeof raw.payload === 'object'
    ? raw.payload
    : raw.draft && typeof raw.draft === 'object'
      ? (raw.draft as Record<string, unknown>).payload ?? raw.draft
      : raw) as Record<string, unknown>
  const note = typeof inner.note === 'string' ? inner.note : ''
  const rawAss = inner.assessments && typeof inner.assessments === 'object' ? (inner.assessments as Record<string, unknown>) : {}
  const assessments: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawAss)) {
    if (typeof v === 'string' && v.trim() !== '') assessments[k] = v
  }
  if (note === '' && Object.keys(assessments).length === 0) return null
  return { assessments, note }
}

export function normalizeInterviewRow(value: unknown): InterviewRow {
  const raw = asRecord(value)
  const candidate = asRecord(raw.candidate)
  const job = asRecord(raw.job)
  const roundNo = asCount(raw.round_no)
  const brief = normalizeBrief(raw.brief)
  const rubric = normalizeRubric(raw.rubric)
  return {
    interview_id: asText(raw.interview_id),
    application_id: asText(raw.application_id),
    candidate: {
      candidate_id: asText(candidate.candidate_id),
      display_name: asText(candidate.display_name),
    },
    job: {
      job_id: asText(job.job_id),
      code: asText(job.code),
      title: asText(job.title),
    },
    round_no: roundNo,
    slot_code: asText(raw.slot_code),
    status: asText(raw.status),
    stage_code: asText(raw.stage_code),
    scheduled_start_at: asText(raw.scheduled_start_at),
    scheduled_end_at: asText(raw.scheduled_end_at),
    timezone: asText(raw.timezone),
    record_version: asCount(raw.record_version),
    role_in_interview: asText(raw.role_in_interview),
    required_scorecard: asBool(raw.required_scorecard),
    scorecard_due_at: asText(raw.scorecard_due_at),
    brief,
    constraints: normalizeConstraints(raw.candidate_constraints, raw.constraints),
    iqs: normalizeIqs(raw.iqs),
    round: normalizeRoundEffective(raw, { roundNo, brief, rubric }),
    rubric,
    materials: normalizeMaterials(raw.materials),
    transcript: normalizeTranscript(raw.transcript),
    scorecard: normalizeScorecard(raw.scorecard),
    required_action: asText(raw.required_action),
    priorRounds: normalizePriorRounds(raw.prior_rounds),
    referencePoints: normalizeReferencePoints(raw.reference_points),
  }
}

/**
 * 归一化面试官工作台读模型。
 *
 * 空响应 / 半个字段 / 坏类型都不抛错：界面靠 `configured` 与各字段的空值显示
 * "未提供"，而不是显示 `NaN` / `undefined` / 假数据。
 * @param value - 服务端原始响应。
 * @returns 安全形状。
 */
export function normalizeInterviewerOverview(value: unknown): InterviewerOverview {
  const raw = asRecord(value)
  const session = asRecord(raw.session)
  const interviews: InterviewRow[] = []
  if (Array.isArray(raw.interviews)) {
    for (const item of raw.interviews.slice(0, 100)) {
      // 非对象行丢弃（数组里混入字符串/ null 是坏响应，不能当面试渲染）。
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      interviews.push(normalizeInterviewRow(item))
    }
  }
  let sessionId = asText(session.session_id)
  if (sessionId === '') sessionId = asText(raw.session_id)
  return {
    contract_version: asText(raw.contract_version),
    configured: asBool(raw.configured),
    evaluated_at: asText(raw.evaluated_at),
    actor: normalizeActor(raw.actor),
    session_id: sessionId,
    labels: normalizeLabels(raw.labels),
    counts: normalizeCounts(raw.counts),
    interviews,
    issues: asStringArray(raw.issues, 50),
  }
}

/**
 * 归一化一个表单维度。
 * @returns 没有 key 的维度返回 null（没有键就无法生成动态键，fail-closed）。
 */
function normalizeFormDimension(value: unknown): FormDimension | null {
  const raw = asRecord(value)
  const key = asText(raw.key)
  if (key === '') return null
  const controls = asRecord(raw.controls)
  const score = asRecord(controls.score)
  const scoreMin = asCount(score.min)
  const scoreMax = asCount(score.max)
  return {
    key,
    label: asText(raw.label) || key,
    kind: asText(raw.kind),
    weight: asFiniteNumber(raw.weight),
    question: asText(raw.question),
    // 只保留封闭枚举内的值：服务端给了未知 assessment 也不渲染成可选项。
    assessmentOptions: asStringArray(controls.assessment, 10).filter((item) =>
      (ASSESSMENT_VALUES as readonly string[]).includes(item),
    ),
    scoreMin: scoreMin > 0 ? scoreMin : 1,
    scoreMax: scoreMax >= Math.max(scoreMin, 1) && scoreMax > 0 ? scoreMax : 5,
    noteRequired: asBool(controls.note_required),
  }
}

/** 把 `{key:label}` 之类的映射拍平成展示条目（保持服务端顺序）。 */
function flattenFields(fields: Readonly<Record<string, unknown>>): MaterialFieldEntry[] {
  const out: MaterialFieldEntry[] = []
  for (const [key, value] of Object.entries(fields)) {
    const text = asDisplayText(value)
    if (text === '') continue
    out.push({ key, label: key, value: text })
  }
  return out
}

/**
 * 归一化 W1 面评表单 spec（D-89 原形 + `nonce` / `expires_at` / `actor_alias`）。
 *
 * 关键约束：`dimensions` 顺序与键**只**来自服务端；未知 assessment / overall 选项丢弃
 * （不渲染成可选值）；未知 mode 降级为 `ALREADY_SUBMITTED`（只读，fail-closed）；
 * 重复维度键保留第一条（避免同一个键渲染两次），无键维度丢弃。
 * @param value - 服务端原始响应。
 * @returns 安全形状。
 */
export function normalizeScorecardFormSpec(value: unknown): ScorecardFormSpec {
  const raw = asRecord(value)
  const actorRaw = asRecord(raw.actor)
  const interviewRaw = asRecord(raw.interview)
  const rubricRaw = asRecord(raw.rubric)
  const transcriptRaw = asRecord(raw.transcript_basis)

  const dimensions: FormDimension[] = []
  const seen = new Set<string>()
  if (Array.isArray(raw.dimensions)) {
    for (const item of raw.dimensions.slice(0, 100)) {
      const dimension = normalizeFormDimension(item)
      if (dimension === null || seen.has(dimension.key)) continue
      seen.add(dimension.key)
      dimensions.push(dimension)
    }
  }

  const modeRaw = asText(raw.mode)
  const mode: ScorecardFormSpec['mode'] =
    modeRaw === 'CREATE' || modeRaw === 'REVISE' || modeRaw === 'ALREADY_SUBMITTED'
      ? modeRaw
      : 'ALREADY_SUBMITTED'

  const currentRaw = raw.current === null || raw.current === undefined ? null : asRecord(raw.current)
  const transcriptValue = asText(transcriptRaw.value)

  return {
    contract_version: asText(raw.contract_version),
    nonce: asText(raw.nonce),
    expires_at: asText(raw.expires_at),
    actor_alias: asText(raw.actor_alias),
    actor: {
      actor_id: asText(actorRaw.actor_id),
      display_name: asText(actorRaw.display_name),
    },
    interview: {
      id: asText(interviewRaw.id),
      application_id: asText(interviewRaw.application_id),
      round_no: asCount(interviewRaw.round_no),
      slot_code: asText(interviewRaw.slot_code),
      status: asText(interviewRaw.status),
      scheduled_start_at: asText(interviewRaw.scheduled_start_at),
    },
    rubric: {
      id: asText(rubricRaw.id),
      job_id: asText(rubricRaw.job_id),
      payload_hash: asText(rubricRaw.payload_hash),
      dimensions: normalizeRubricDimensions(rubricRaw.dimensions),
    },
    dimensions,
    transcript_basis: {
      value: (TRANSCRIPT_BASES as readonly string[]).includes(transcriptValue) ? transcriptValue : '',
      options: asStringArray(transcriptRaw.options, 5).filter((item) =>
        (TRANSCRIPT_BASES as readonly string[]).includes(item),
      ),
      locked: asBool(transcriptRaw.locked),
    },
    overall_options: asStringArray(raw.overall_options, 10).filter((item) =>
      (OVERALL_VALUES as readonly string[]).includes(item),
    ),
    mode,
    current:
      currentRaw === null
        ? null
        : {
            id: asText(currentRaw.id),
            status: asText(currentRaw.status),
            revision_no: asCount(currentRaw.revision_no),
            record_version: asCount(currentRaw.record_version),
            rubric_version_id: asText(currentRaw.rubric_version_id),
          },
  }
}

/** 归一化 W1 提交成功的 DB 读回（字段缺失降级为空串/0，界面如实显示"未返回"）。 */
export function normalizeSubmitResult(value: unknown): ScorecardSubmitResult {
  const raw = asRecord(value)
  // 容忍服务端把读回包在 `result` 下（两种都只读服务端字段，不编造）。
  const nested = asRecord(raw.result)
  const source = raw.scorecard_id !== undefined ? raw : nested
  return {
    scorecard_id: asText(source.scorecard_id),
    status: asText(source.status),
    actor_id: asText(source.actor_id),
    record_version: asCount(source.record_version),
    interviewer_id: asText(source.interviewer_id),
    interview_id: asText(source.interview_id),
    replayed: asBool(source.replayed),
  }
}

/**
 * 构造 W1 面评提交体（纯函数，键**只**来自 form spec）。
 *
 * 失败一律在本地拦住（不发请求）：缺维度、维度键不在 spec、assessment 未知、
 * score 非法、overall 不在可选集、transcript_basis / nonce 缺失。
 * @param spec - 归一化后的 form spec。
 * @param answers - 人填的答案。
 * @returns 成功给提交体；失败给可读原因。
 */
export function buildScorecardSubmitBody(
  spec: ScorecardFormSpec,
  answers: ScorecardAnswers,
): BuildSubmitBodyResult {
  if (spec.interview.id === '') {
    return { ok: false, message: '服务端未返回面试 id（fail-closed，未提交）。' }
  }
  if (spec.mode !== 'CREATE') {
    return { ok: false, message: `服务端表单模式为 ${spec.mode}，本版只提交新建面评（未提交）。` }
  }
  if (spec.nonce === '') {
    return { ok: false, message: '服务端未返回一次性 nonce（W1），无法提交（fail-closed）。' }
  }
  if (spec.transcript_basis.value === '') {
    return { ok: false, message: '服务端未返回转写依据（transcript_basis），无法提交（fail-closed）。' }
  }
  if (spec.dimensions.length === 0) {
    return { ok: false, message: '服务端没有返回可填写的 rubric 维度，无法提交（fail-closed）。' }
  }
  const overall = asText(answers.overall)
  if (!(spec.overall_options as readonly string[]).includes(overall)) {
    return {
      ok: false,
      message:
        spec.overall_options.length === 0
          ? '服务端没有返回 overall 选项，无法提交（fail-closed）。'
          : `overall 必须是服务端给出的选项之一（${spec.overall_options.join(' / ')}）。`,
    }
  }

  const dimensions: Record<string, ScorecardDimensionAnswer> = {}
  for (const dimension of spec.dimensions) {
    const answer = answers.dimensions[dimension.key]
    if (answer === undefined) {
      return { ok: false, message: `维度 ${dimension.label}（${dimension.key}）还没有作答。` }
    }
    const assessment = asText(answer.assessment)
    if (assessment === '') {
      return { ok: false, message: `维度 ${dimension.label}（${dimension.key}）还没有选择 assessment。` }
    }
    if (!(dimension.assessmentOptions as readonly string[]).includes(assessment)) {
      return {
        ok: false,
        message:
          dimension.assessmentOptions.length === 0
            ? `维度 ${dimension.label}（${dimension.key}）没有服务端枚举选项，不能提交（fail-closed）。`
            : `维度 ${dimension.label}（${dimension.key}）的 assessment 不在服务端选项内。`,
      }
    }
    const scored = assessment === 'MET' || assessment === 'NOT_MET'
    let score: number | undefined
    if (answer.score !== undefined && answer.score !== null) {
      if (!scored) {
        return {
          ok: false,
          message: `维度 ${dimension.label}（${dimension.key}）只有 MET / NOT_MET 才能给 score。`,
        }
      }
      if (!Number.isInteger(answer.score) || answer.score < dimension.scoreMin || answer.score > dimension.scoreMax) {
        return {
          ok: false,
          message: `维度 ${dimension.label}（${dimension.key}）的 score 必须是 ${dimension.scoreMin}–${dimension.scoreMax} 的整数。`,
        }
      }
      score = answer.score
    }
    const note = asText(answer.note)
    if (dimension.noteRequired && note === '') {
      return { ok: false, message: `维度 ${dimension.label}（${dimension.key}）要求填写 note。` }
    }
    // W1 的 note 上限 2000 字（服务端会 400 OUT_OF_RANGE）；本地先拦一次，避免无意义往返。
    if (note.length > 2000) {
      return { ok: false, message: `维度 ${dimension.label}（${dimension.key}）的 note 不得超过 2000 字。` }
    }
    dimensions[dimension.key] = {
      assessment,
      ...(score !== undefined ? { score } : {}),
      ...(note !== '' ? { note } : {}),
    }
  }

  const body: ScorecardSubmitBody = {
    interview_id: spec.interview.id,
    ...(spec.rubric.id !== '' ? { rubric_version_id: spec.rubric.id } : {}),
    dimensions,
    transcript_basis: spec.transcript_basis.value,
    overall: answers.overall,
    nonce: spec.nonce,
  }
  return { ok: true, body }
}

/**
 * 把非 2xx 响应体解析成可读错误（保留 code / reason_code / detail）。
 *
 * 契约形状优先级：`{error:{code,reason_code,message,detail}}` → `{error:"文本"}` → 原文；
 * 解析不到时仍保留 HTTP 状态码（界面据此显示，不伪装成业务空态）。
 * @param status - HTTP 状态码。
 * @param bodyText - 响应体原文。
 * @returns 可读错误。
 */
export function parseHttpError(status: number, bodyText: string): RecruitmentHttpError {
  const text = typeof bodyText === 'string' ? bodyText.trim() : ''
  let parsed: unknown
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      parsed = undefined
    }
  }
  const parsedRecord = asRecord(parsed)
  const errorRaw = parsedRecord.error
  if (errorRaw !== null && typeof errorRaw === 'object' && !Array.isArray(errorRaw)) {
    const error = asRecord(errorRaw)
    const code = asText(error.code)
    const reasonCode = asText(error.reason_code)
    const message = asText(error.message) || asText(error.detail)
    const composed = [code, reasonCode].filter((part) => part !== '').join('/')
    const readable =
      composed === '' && message === ''
        ? `宿主返回 HTTP ${status}`
        : `${composed === '' ? '' : `${composed}：`}${message === '' ? `HTTP ${status}` : message}`
    return new RecruitmentHttpError(status, code, reasonCode, readable, error.detail)
  }
  if (typeof errorRaw === 'string' && errorRaw.trim() !== '') {
    return new RecruitmentHttpError(status, '', '', `宿主返回 HTTP ${status}：${errorRaw.trim()}`, undefined)
  }
  const raw = text === '' ? `宿主返回 HTTP ${status}` : `宿主返回 HTTP ${status}：${text.slice(0, 200)}`
  return new RecruitmentHttpError(status, '', '', raw, undefined)
}

/**
 * 判断一次 overview 读取失败是否属于"身份绑定尚未落定"（可重试，不是终态）。
 *
 * 为什么需要它：W0 shell 切换 Demo Actor 时先改 props、再 `await PUT /recruitment/api/actor`；
 * 本组件在 props 变化瞬间就 GET overview，服务端 registry 仍是旧绑定，会返回
 *   403 `ALIAS_MISMATCH / SESSION_ALIAS_MISMATCH`（换身份时），或
 *   409 `DEMO_ACTOR_UNMAPPED`（首次绑定/刷新恢复时）。
 * 这是**时序竞态**，不是业务错误：客户端应有界退避重试，而不是把界面钉死在错误态。
 * 除上述两类之外一律不重试（真 403/404/500 立即如实显示）。
 * @param failure - 捕获到的任意错误。
 * @returns true 表示"绑定可能马上落定，可退避重试"。
 */
export function isBindingPendingError(failure: unknown): boolean {
  if (!(failure instanceof RecruitmentHttpError)) return false
  if (failure.status === 403 && failure.reasonCode === 'SESSION_ALIAS_MISMATCH') return true
  if (failure.status === 409 && failure.code === 'DEMO_ACTOR_UNMAPPED') return true
  return false
}

/**
 * 用 id 找一条"分配给我的面试"。
 * @param overview - 已归一化的 overview。
 * @param interviewId - 面试 id（来自列表行）。
 * @returns 找不到（含空 id / 未知 id / 空 overview）返回 null，绝不回退到第一行。
 */
export function selectInterview(overview: InterviewerOverview | undefined, interviewId: string): InterviewRow | null {
  if (overview === undefined) return null
  const id = asText(interviewId)
  if (id === '') return null
  for (const row of overview.interviews) {
    if (row.interview_id === id) return row
  }
  return null
}

/**
 * 工作台头部统计：服务端 counts 原样透传，**不用列表行长度改写**。
 * @param overview - 已归一化的 overview。
 * @returns 三格统计 + 本地实际行数（单独字段，便于发现"服务端说 1 行、这次给了 2 行"这类偏差）。
 */
export function deriveWorkspaceStats(overview: InterviewerOverview): WorkspaceStats {
  return {
    assigned_total: overview.counts.assigned_total,
    open_interview_total: overview.counts.open_interview_total,
    pending_scorecard_total: overview.counts.pending_scorecard_total,
    submitted_scorecard_total: overview.counts.submitted_scorecard_total,
    transcript_ready_total: overview.counts.transcript_ready_total,
    transcript_missing_total: overview.counts.transcript_missing_total,
    row_count: overview.interviews.length,
  }
}

/**
 * 当前行是否允许打开"提交我的独立面评"。
 *
 * 规则（fail-closed）：
 *   - 必须是本场面试已登记的面试官（role_in_interview === INTERVIEWER）且行有 interview_id；
 *   - 面评状态 NONE / PENDING → true；SUBMITTED / WAIVED → false；未知状态 → false。
 * 注意：这里**不**判断转写是否 READY（转写还没收到不影响提交；面评仍可提交，后续由 HR 决定如何处理）。
 * @param row - 一条面试行。
 * @returns 是否可提交。
 */
export function canSubmitScorecard(row: InterviewRow): boolean {
  if (row.interview_id === '') return false
  if (row.role_in_interview !== ROLE_INTERVIEWER) return false
  switch (row.scorecard.state) {
    case 'NONE':
    case 'PENDING':
      return true
    case 'SUBMITTED':
    case 'WAIVED':
      return false
    default:
      return false
  }
}

/**
 * 转写状态的中文文本（TR-D 七条；未知值原样说明，不沉默）。
 * @param state - `transcript.state`。
 * @returns 可展示文本。
 */
export function transcriptStateText(state: string): string {
  const value = asText(state)
  if (value === '') return '状态未提供'
  return TRANSCRIPT_STATE_TEXT[value] ?? `未知状态（${value}）`
}

/**
 * 面评状态的中文文本（NONE/PENDING/SUBMITTED/WAIVED）。
 * @param state - `scorecard.state`。
 * @returns 可展示文本。
 */
export function scorecardStateText(state: string): string {
  const value = asText(state)
  if (value === '') return '状态未提供'
  return SCORECARD_STATE_TEXT[value] ?? `未知状态（${value}）`
}

/** 会议绑定状态的中文文本。 */
export function meetingBindingStateText(state: string): string {
  const value = asText(state)
  if (value === '') return '未提供'
  return MEETING_BINDING_TEXT[value] ?? `未知状态（${value}）`
}

/** 简报来源的中文文本（服务端标注什么就说什么）。 */
export function briefSourceText(source: string): string {
  const value = asText(source)
  if (value === '') return '未提供'
  return BRIEF_SOURCE_TEXT[value] ?? `未知来源（${value}）`
}

/** required_action 的中文文本（行状态 chip；只映射服务端枚举，不推断阶段）。 */
export function requiredActionText(action: string): string {
  switch (asText(action)) {
    case 'SUBMIT_SCORECARD':
      return '待提交面评'
    case 'REVIEW_SCORECARD':
      return '面评已提交'
    case 'NONE':
      return '无需面评'
    default:
      return '状态未提供'
  }
}

/** assessment 的展示文本（枚举值原样附后，避免中文吞掉契约值）。 */
export function assessmentText(value: string): string {
  const text = asText(value)
  if (text === '') return ''
  const label = ASSESSMENT_TEXT[text]
  return label === undefined ? text : `${text}（${label}）`
}

/** overall 的展示文本。 */
export function overallText(value: string): string {
  const text = asText(value)
  if (text === '') return ''
  const label = OVERALL_TEXT[text]
  return label === undefined ? text : `${text}（${label}）`
}

// ---------------------------------------------------------------------------
//  前置轮次 / 本轮参考：**面向面试官的中文纯文本**（渲染层只用这些函数，不拼 key / id / 枚举码）
//
//  为什么单独一层：这两块卡的文案口径（DESIGN §2）是"只渲染人话"。把映射写成纯函数后
//  `node --test` 可以直接断言"任何输入都不产出 UUID / 64hex / snake_case 字段名 / 枚举码"，
//  不依赖 React、不依赖 DOM。
// ---------------------------------------------------------------------------

/** 前置轮次面评状态的中文（未提交不显示结论）。 */
const PRIOR_SCORECARD_STATE_TEXT: Readonly<Record<string, string>> = {
  SUBMITTED: '已提交',
  PENDING: '草稿未提交',
  NONE: '未填',
  WAIVED: '已豁免',
}

/**
 * 前置轮次结论的中文。
 *
 * 口径与既有面评分支的 `overallText()` 对齐（Owner 2026-11-16 裁决，DESIGN §2 已回抄）：
 * `ADVANCE=推进 / HOLD=暂缓 / REJECT=不通过`。**不要**在这里另造一套措辞——
 * 同一个 `scorecard.overall` 在两个卡片上必须是同一个中文词。
 */
const PRIOR_CONCLUSION_TEXT: Readonly<Record<string, string>> = {
  ADVANCE: '推进',
  HOLD: '暂缓',
  REJECT: '不通过',
}

/** 面试状态的中文（只表排期，不推断转写/面评；与 HR 侧 `INTERVIEW_STATUS_LABELS` 同口径）。 */
const INTERVIEW_STATUS_TEXT: Readonly<Record<string, string>> = {
  SCHEDULED: '已排期',
  IN_PROGRESS: '进行中',
  POST_INTERVIEW: '面试后',
  EVALUATION_READY: '评价就绪',
  DECIDED: '已决策',
  RESCHEDULED: '已改期',
  CANCELLED: '已取消',
  NO_SHOW: '未出席',
}

/** 未覆盖维度的原因码 → 中文（码本身只在归一化层，渲染时替换）。 */
const UNCOVERED_REASON_TEXT: Readonly<Record<string, string>> = {
  NO_SCORECARD: '没有已提交的面评',
  NO_ITEMS: '面评里没有维度明细',
  NOT_RATED: '面评没有评到这一维',
  NOT_OBSERVED: '上一轮标记为未观察到',
  UNREADABLE: '上一轮面评无法判读',
}

/** 维度覆盖读不到时的固定说法（DESIGN §2：不推测）。 */
const PRIOR_COVERAGE_UNREADABLE_TEXT = '这一轮的评分维度读不到，无法判断覆盖情况（不推测）。'

/** 无前置轮次时的空态文案（第 1 轮的面试官不该看到"上一轮"的伪内容）。 */
export const PRIOR_ROUNDS_EMPTY_TEXT = '这是第一轮，没有前置轮次可参考。'

/** 没有参考点时的空态文案（不伪造要点）。 */
export const REFERENCE_POINTS_EMPTY_TEXT = '暂时没有可参考的要点。'

/** 前置轮次面评状态的中文文本（未知状态 → 「状态未提供」，不渲染机器码）。 */
export function priorScorecardStateText(state: string): string {
  const value = asText(state)
  if (value === '') return '状态未提供'
  return PRIOR_SCORECARD_STATE_TEXT[value] ?? '状态未提供'
}

/** 前置轮次结论的中文文本（null / 未知 → ''，调用方据此**不显示结论**）。 */
export function priorConclusionText(conclusion: string | null): string {
  if (conclusion === null) return ''
  const value = asText(conclusion)
  if (value === '') return ''
  return PRIOR_CONCLUSION_TEXT[value] ?? ''
}

/** 面试状态的中文文本（未知 → 「状态未提供」）。 */
export function priorRoundStatusText(status: string): string {
  const value = asText(status)
  if (value === '') return '状态未提供'
  return INTERVIEW_STATUS_TEXT[value] ?? '状态未提供'
}

/** 未覆盖维度的原因中文（未知原因码 → 「原因未提供」，不渲染码）。 */
export function uncoveredReasonText(reason: string): string {
  const value = asText(reason)
  if (value === '') return '原因未提供'
  return UNCOVERED_REASON_TEXT[value] ?? '原因未提供'
}

/** 一场前置轮次的面试官显示名串（空显示名如实写「显示名未提供」；不编造人名）。 */
export function priorRoundInterviewerNames(round: PriorRoundView): string {
  if (round.interviewers.length === 0) return '未提供'
  return round.interviewers
    .map((interviewer) => (interviewer.displayName !== '' ? interviewer.displayName : '（显示名未提供）'))
    .join('、')
}

/**
 * 一场前置轮次的首行：`第 N 轮 · <状态中文> · 面试官：<显示名、…>`。
 * @param round - 归一化后的前置轮次。
 * @returns 可展示文本（不含 id / 枚举码）。
 */
export function priorRoundHeadlineText(round: PriorRoundView): string {
  const roundText = round.roundNo > 0 ? `第 ${round.roundNo} 轮` : '轮次未提供'
  return `${roundText} · ${priorRoundStatusText(round.status)} · 面试官：${priorRoundInterviewerNames(round)}`
}

/**
 * 一场前置轮次的面评行：`面评：<已提交/草稿未提交/未填/已豁免>[ · 结论：<推进/暂缓/不通过>]`。
 *
 * **未提交就不显示结论**（DESIGN §2；草稿里的分数不是证据）。
 * 多位面试官时逐位给状态（每人单独一句，不合并成可能误导的"已提交"）。
 * @param round - 归一化后的前置轮次。
 * @returns 可展示文本。
 */
export function priorRoundScorecardLine(round: PriorRoundView): string {
  if (round.interviewers.length === 0) return '面评：未提供'
  if (round.interviewers.length === 1) {
    const only = round.interviewers[0]
    if (only === undefined) return '面评：未提供'
    return `面评：${priorScorecardStateText(only.scorecardState)}${priorConclusionSuffix(only)}`
  }
  const parts = round.interviewers.map((interviewer) => {
    const name = interviewer.displayName !== '' ? interviewer.displayName : '（显示名未提供）'
    return `${name} ${priorScorecardStateText(interviewer.scorecardState)}${priorConclusionSuffix(interviewer)}`
  })
  return `面评：${parts.join('；')}`
}

/** 结论后缀（只有"已提交"才带结论；缺结论就不写，不编造）。 */
function priorConclusionSuffix(interviewer: PriorRoundInterviewerView): string {
  const submitted = interviewer.scorecardSubmitted || interviewer.scorecardState === 'SUBMITTED'
  if (!submitted) return ''
  const text = priorConclusionText(interviewer.conclusion)
  return text !== '' ? ` · 结论：${text}` : ''
}

/**
 * 一场前置轮次的维度覆盖行（1–2 行）。
 *
 * 口径（DESIGN §2）：
 *   * 维度宇宙读不到、或两个数组都空 → 一句「读不到，无法判断（不推测）」；
 *   * 否则分别给「覆盖到的维度」与「没有覆盖到的维度（原因中文）」。
 * @param round - 归一化后的前置轮次。
 * @returns 可展示文本行。
 */
export function priorRoundCoverageLines(round: PriorRoundView): string[] {
  const covered = round.coveredDimensions
  const uncovered = round.uncoveredDimensions
  if (!round.dimensionsAvailable || (covered.length === 0 && uncovered.length === 0)) {
    return [PRIOR_COVERAGE_UNREADABLE_TEXT]
  }
  const coveredText = covered.length === 0 ? '无' : covered.map((item) => item.label).join('、')
  const uncoveredText =
    uncovered.length === 0
      ? '无'
      : uncovered.map((item) => `${item.label}（${uncoveredReasonText(item.reason)}）`).join('、')
  return [`覆盖到的维度：${coveredText}`, `没有覆盖到的维度：${uncoveredText}`]
}

/**
 * 一场前置轮次的完整文本块（首行 + 面评行 + 覆盖行）。
 * @param round - 归一化后的前置轮次。
 * @returns 按渲染顺序的文本行（全部是给人看的中文）。
 */
export function priorRoundLines(round: PriorRoundView): string[] {
  return [priorRoundHeadlineText(round), priorRoundScorecardLine(round), ...priorRoundCoverageLines(round)]
}

/**
 * 本轮参考的文本行：每条 `• <point>` + `值得问的原因：<why>`。
 *
 * 措辞纪律（DESIGN §0/§1.2）：不改写成命令句，不排顺序、不定深度。
 * @param points - 归一化后的参考点。
 * @returns 可展示文本行；空数组 → 一句空态说明。
 */
export function referencePointLines(points: readonly ReferencePointView[]): string[] {
  if (points.length === 0) return [REFERENCE_POINTS_EMPTY_TEXT]
  const lines: string[] = []
  for (const point of points) {
    lines.push(`• ${point.point}`)
    lines.push(`值得问的原因：${point.why !== '' ? point.why : '服务端未提供理由。'}`)
  }
  return lines
}

/**
 * 把 ISO 时间格式化成可读文本；**不做静默时区换算**。
 *
 * - 给了合法 IANA 时区（overview 行里的 `timezone`）→ 用 `Intl` 换算到该时区；
 * - 没给 / 时区非法 → 保留 ISO 原文里的日期与时间，并附上原文的 `Z` / `+08:00` 标记
 *   （宁可显示 `Z`，也不假装这是本地时间）。
 * @param iso - ISO 时间文本（可空/坏类型）。
 * @param timeZone - 可选 IANA 时区（如 `Asia/Shanghai`）。
 * @returns 可展示文本；解析不出返回 ''。
 */
export function formatSlotTime(iso: string, timeZone = ''): string {
  const text = asText(iso)
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text)
  if (match === null) return ''
  const year = match[1] ?? ''
  const month = match[2] ?? ''
  const day = match[3] ?? ''
  const hour = match[4] ?? ''
  const minute = match[5] ?? ''
  const zone = asText(timeZone)
  if (zone !== '' && hour !== '') {
    const stamp = Date.parse(text)
    if (!Number.isNaN(stamp)) {
      try {
        const formatter = new Intl.DateTimeFormat('sv-SE', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        })
        return formatter.format(new Date(stamp))
      } catch {
        // 非法时区 → 退回"原文时间 + 偏移标记"，不猜测用户的本地时区。
      }
    }
  }
  if (hour === '') return `${year}-${month}-${day}`
  const suffix = /Z$/i.test(text) ? 'Z' : (/([+-]\d{2}:\d{2})$/.exec(text)?.[1] ?? '')
  return `${year}-${month}-${day} ${hour}:${minute}${suffix}`
}

/**
 * 格式化一段面试时间（开始–结束）；同一天只显示一次日期。
 * @param startIso - 开始时间。
 * @param endIso - 结束时间（可为空）。
 * @param timeZone - 可选 IANA 时区。
 * @returns 可展示文本；开始时间解析不出返回 ''。
 */
export function formatSlotRange(startIso: string, endIso: string, timeZone = ''): string {
  const start = formatSlotTime(startIso, timeZone)
  if (start === '') return ''
  const end = formatSlotTime(endIso, timeZone)
  if (end === '') return start
  const startDate = start.slice(0, 10)
  const endDate = end.slice(0, 10)
  if (startDate === endDate && start.length > 10 && end.length > 10) {
    // 同一天：`2026-11-20 22:00 – 23:00`（只保留开始侧日期，减少噪音）。
    return `${start} – ${end.slice(11)}`
  }
  return `${start} – ${end}`
}

/**
 * 把授权材料的 `parsed_fields` 拍平成可展示条目（简历材料授权给面试官，原样展示）。
 * 嵌套对象/数组不 json 化（避免 `[object Object]`），只显示标量；空字段丢弃。
 * @param fields - 服务端原样 `fields`。
 * @returns 展示条目（保持服务端键顺序）。
 */
export function materialFieldEntries(fields: Readonly<Record<string, unknown>>): MaterialFieldEntry[] {
  return flattenFields(fields)
}

/**
 * 按轮次汇总考察重点（列表页右栏用）；同一轮 focus 去重。
 *
 * 两种口径（不混用）：
 *   * 服务端有轮次字段（task-50）→ 只用 `round_focus.focus_dimensions`；`available=false`
 *     （JOB_BASE 降级）时**不展示**任何"本轮重点"（不编译器把岗位维度冒充轮次重点）。
 *   * 旧端点（`serverFieldsMissing`）→ 保持 W3 旧行为：用 `brief.focus`/`brief.objective` 聚合
 *     （既有测试与旧 Host 兼容），来源标 `LEGACY_BRIEF`。
 * @param rows - 面试行。
 * @returns 按轮次升序的分组（无 focus 的轮次也保留 objective/来源）。
 */
export function groupRounds(rows: readonly InterviewRow[]): RoundFocusGroup[] {
  const groups = new Map<
    number,
    {
      round_no: number
      objective: string
      focus: BriefFocus[]
      seen: Set<string>
      source: string
      title: string
      available: boolean
      /** true = 本轮已至少有一行带服务端轮次字段（此后不再混入旧 brief focus）。 */
      serverProjection: boolean
    }
  >()
  for (const row of rows) {
    const round = row.round_no
    const legacy = row.round.serverFieldsMissing
    let group = groups.get(round)
    if (group === undefined) {
      group = {
        round_no: round,
        objective: row.brief.objective,
        focus: [],
        seen: new Set<string>(),
        source: legacy ? 'LEGACY_BRIEF' : row.round.focus.source,
        title: legacy ? '' : row.round.focus.title,
        available: legacy ? false : row.round.focus.available,
        serverProjection: !legacy,
      }
      groups.set(round, group)
    }
    if (group.objective === '') group.objective = row.brief.objective
    if (legacy) {
      // 同一轮里只要有一行来自新端点，就不把旧 brief focus 混进"轮次配置"展示。
      if (group.serverProjection) continue
      for (const item of row.brief.focus) {
        const key = item.key !== '' ? item.key : item.label
        if (key === '' || group.seen.has(key)) continue
        group.seen.add(key)
        group.focus.push(item)
      }
      continue
    }
    group.serverProjection = true
    // 服务端轮次字段存在：JOB_BASE 降级时绝不回退到 brief.focus（避免"岗位维度冒充本轮重点"）。
    if (!group.available && row.round.focus.available) {
      group.available = true
      group.source = row.round.focus.source
      group.title = row.round.focus.title
    }
    if (!row.round.focus.available) continue
    if (group.title === '') group.title = row.round.focus.title
    for (const item of row.round.focus.focusDimensions) {
      const key = item.key !== '' ? item.key : item.label
      if (key === '' || group.seen.has(key)) continue
      group.seen.add(key)
      group.focus.push({ key: item.key, label: item.label, weight: item.weight, required: item.required })
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.round_no - right.round_no)
    .map((group) => ({
      round_no: group.round_no,
      objective: group.objective,
      focus: group.focus,
      source: group.source,
      title: group.title,
      available: group.available,
    }))
}
