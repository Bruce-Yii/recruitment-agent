// 客户端纯函数层：把宿主 HTTP 响应**归一化成安全形状**，不 import react。
//
// 为什么单独一个文件：归一化是面板唯一的"防脏数据"关口，且必须能被
// `node --test` 直接测（无 DOM、无 React）。`use-overview.ts` 负责取数/状态，
// 本文件只做纯函数转换。
//
// 归一化不是洁癖：HTTP 200 + 半个字段、或后端将来改了形状，界面会显示
// `undefined` / `NaN` / `[object Object]`。这里把所有字段收紧成
// 字符串 / 非负整数 / 数组，缺失一律降级（'' / 0 / []），**不编造业务值**。

/** 契约里的六个 actor 视角列表键。 */
export const OVERVIEW_LIST_KEYS = [
  'pending_decisions',
  'my_interviews',
  'overdue_scorecards',
  'pending_reviews',
  'connector_incidents',
  'waiting_human_tasks',
] as const

/** 未分配（全租户共享）区块里的四个列表键。 */
export const UNASSIGNED_LIST_KEYS = [
  'pending_decisions',
  'pending_reviews',
  'waiting_human_tasks',
  'connector_incidents',
] as const

/** 面评维度的 assessment 枚举（D-89 / scorecard 契约）。 */
export const ASSESSMENT_VALUES = ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'] as const

/** 面评 overall 枚举。 */
export const OVERALL_VALUES = ['ADVANCE', 'HOLD', 'REJECT'] as const

/** 动态表单的三种模式。 */
export const FORM_MODES = ['CREATE', 'REVISE', 'ALREADY_SUBMITTED'] as const

/** 一条列表行（已归一化）。 */
export interface OverviewListItem {
  /** 该行的主 id（按列表类型从不同字段取；取不到为空串，不伪造）。 */
  readonly id: string
  /** 面试 id（有就带上；"填写面评"按钮需要它）。 */
  readonly interview_id: string
  /** 是否需要填写面评（只有服务端显式给 true 才算）。 */
  readonly needs_scorecard: boolean
  /** 已拍平的只读字段（label 用服务端 labels 覆盖；缺失 label 时用键名）。 */
  readonly fields: readonly { readonly key: string; readonly label: string; readonly value: string }[]
}

/** 当归一化后的计数（全部为非负整数）。 */
export interface OverviewCounts {
  readonly pending_total: number
  readonly pending_by_stage: Readonly<Record<string, number>>
  readonly active_total: number
  readonly active_by_stage: Readonly<Record<string, number>>
  readonly my_interviews_total: number
  readonly overdue_scorecards_total: number
  readonly pending_reviews_total: number
  readonly connector_incidents_total: number
  readonly waiting_human_total: number
  readonly unassigned_total: number
}

/** actor 视角（只来自服务端配置，客户端不接受覆盖参数）。 */
export interface OverviewActor {
  readonly actor_id: string
  readonly display_name: string
  readonly roles: readonly string[]
}

/** 未分配（全租户共享）区块。 */
export interface OverviewUnassigned {
  readonly note: string
  readonly pending_decisions: readonly OverviewListItem[]
  readonly pending_reviews: readonly OverviewListItem[]
  readonly waiting_human_tasks: readonly OverviewListItem[]
  readonly connector_incidents: readonly OverviewListItem[]
}

/** 工作台投影响应（归一化后的安全形状）。 */
export interface OverviewResponse {
  readonly contract_version: string
  readonly configured: boolean
  readonly evaluated_at: string
  readonly actor: OverviewActor
  readonly labels: Readonly<Record<string, string>>
  /** 旧形状的待决策列表（保留兼容；新面板用 lists）。 */
  readonly pending: readonly OverviewListItem[]
  readonly counts: OverviewCounts
  readonly lists: {
    readonly pending_decisions: readonly OverviewListItem[]
    readonly my_interviews: readonly OverviewListItem[]
    readonly overdue_scorecards: readonly OverviewListItem[]
    readonly pending_reviews: readonly OverviewListItem[]
    readonly connector_incidents: readonly OverviewListItem[]
    readonly waiting_human_tasks: readonly OverviewListItem[]
  }
  readonly unassigned: OverviewUnassigned
  readonly issues: readonly string[]
}

/** 表单一个维度的控件规格（全部来自服务端 spec，客户端不自由生成键）。 */
export interface FormDimensionControl {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly assessmentOptions: readonly string[]
  readonly scoreMin: number
  readonly scoreMax: number
  readonly noteRequired: boolean
}

/** rubric 维度的只读元数据（标题/说明用）。 */
export interface RubricDimensionMeta {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
}

/** `GET /recruitment/api/scorecard-form` 的归一化形状。 */
export interface ScorecardFormSpec {
  readonly contract_version: string
  readonly actor: OverviewActor
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
    readonly dimensions: readonly RubricDimensionMeta[]
  }
  /** 按服务端顺序渲染的控件列表；只有这里的 key 才会出现在表单里。 */
  readonly dimensions: readonly FormDimensionControl[]
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
  readonly labels: Readonly<Record<string, string>>
}

/** `POST /recruitment/api/scorecard-form` 成功后回显所需的最小形状。 */
export interface ScorecardSubmitResult {
  readonly status: string
  readonly replayed: boolean
  readonly scorecard: {
    readonly id: string
    readonly revision_no: number
    readonly status: string
  }
  /** coverage 原样保留（展示用），非对象时降级为空串。 */
  readonly coverage: unknown
}

/** 取一个非空字符串；否则兜底（数字/布尔不算字符串，避免把坏类型伪装成文本）。 */
export function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? fallback : trimmed
  }
  return fallback
}

/** 取一个非负有限整数；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
export function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0
}

/** 取一个布尔；只认严格 true。 */
function asBool(value: unknown): boolean {
  return value === true
}

/** 取一个对象（null / 数组 / 非对象一律降级为空对象）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 字符串数组归一化（丢弃非字符串项）。 */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') out.push(item.trim())
  }
  return out
}

/** labels 映射归一化（只保留字符串值）。 */
function normalizeLabels(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, label] of Object.entries(asRecord(value))) {
    if (typeof label === 'string' && label.trim() !== '') out[key] = label.trim()
  }
  return out
}

/** 单条列表行拍平：只展示标量字段与业务引用，不展示嵌套对象（避免 `[object Object]`）。 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  return ''
}

/** 拍平一行的字段（业务引用数组按 `kind:id` 拼；其余嵌套对象跳过）。 */
function flattenFields(
  row: Record<string, unknown>,
  labels: Readonly<Record<string, string>>,
  skipKeys: ReadonlySet<string>,
): { key: string; label: string; value: string }[] {
  const fields: { key: string; label: string; value: string }[] = []
  const seen = new Set<string>()
  const preferred = [
    'title',
    'display_name',
    'summary',
    'stage_code',
    'status',
    'round_no',
    'slot_code',
    'scheduled_start_at',
    'due_at',
    'deadline_at',
    'assignee_display_name',
    'assignee_actor_id',
    'created_by_display_name',
    'created_by_actor_id',
    'reason',
    'note',
    'source_kind',
    'error_code',
    'message',
    'business_refs',
  ]

  const push = (key: string, value: string): void => {
    if (seen.has(key) || value === '') return
    seen.add(key)
    fields.push({ key, label: labels[key] ?? key, value })
  }

  const render = (key: string, value: unknown): void => {
    if (key === 'business_refs' && Array.isArray(value)) {
      const refs: string[] = []
      for (const item of value) {
        const ref = asRecord(item)
        const kind = asText(ref.kind)
        const id = asText(ref.id)
        if (kind !== '' && id !== '') refs.push(`${kind}:${id}`)
      }
      if (refs.length > 0) push(key, refs.join('、'))
      return
    }
    if (Array.isArray(value)) return
    push(key, describeValue(value))
  }

  for (const key of preferred) {
    if (skipKeys.has(key)) continue
    if (key in row) render(key, row[key])
  }
  for (const [key, value] of Object.entries(row)) {
    if (skipKeys.has(key) || seen.has(key) || preferred.includes(key)) continue
    render(key, value)
  }
  return fields
}

/**
 * 归一化一条列表行。
 * @param value - 服务端原始行。
 * @param labels - 服务端 labels（键 → 中文标签）。
 * @param idKeys - 该列表行主 id 的候选字段（按优先级）。
 * @returns 安全形状；`id` 取不到时为空串（不伪造）。
 */
export function normalizeListItem(
  value: unknown,
  labels: Readonly<Record<string, string>>,
  idKeys: readonly string[],
): OverviewListItem {
  const row = asRecord(value)
  let id = ''
  for (const key of idKeys) {
    id = asText(row[key])
    if (id !== '') break
  }
  if (id === '') id = asText(row.id)

  const nestedInterview = asRecord(row.interview)
  const interviewId = asText(row.interview_id) || asText(nestedInterview.id)
  const needsScorecard = asBool(row.needs_scorecard)

  const skip = new Set<string>([...idKeys, 'id', 'needs_scorecard', 'interview'])
  const fields = flattenFields(row, labels, skip)
  // 嵌套 interview 对象里的标量也展示，但加前缀以免与顶层同名字段混淆。
  for (const [key, value] of Object.entries(nestedInterview)) {
    if (key === 'id') continue
    const rendered = describeValue(value)
    if (rendered !== '' && !fields.some((field) => field.key === `interview_${key}`)) {
      fields.push({ key: `interview_${key}`, label: `面试·${labels[key] ?? key}`, value: rendered })
    }
  }

  return { id, interview_id: interviewId, needs_scorecard: needsScorecard, fields }
}

/** 归一化一个列表；非数组降级为空数组，非对象行丢弃。 */
export function normalizeList(
  value: unknown,
  labels: Readonly<Record<string, string>>,
  idKeys: readonly string[],
): OverviewListItem[] {
  if (!Array.isArray(value)) return []
  const out: OverviewListItem[] = []
  for (const item of value.slice(0, 500)) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    out.push(normalizeListItem(item, labels, idKeys))
  }
  return out
}

/** 每个列表的主 id 字段优先级（与服务端投影行的自然主键对齐）。 */
const LIST_ID_KEYS: Readonly<Record<string, readonly string[]>> = {
  pending_decisions: ['application_id', 'interview_id', 'id'],
  my_interviews: ['interview_id', 'application_id', 'id'],
  overdue_scorecards: ['interview_id', 'scorecard_id', 'application_id', 'id'],
  pending_reviews: ['review_id', 'id'],
  connector_incidents: ['run_id', 'incident_id', 'intake_id', 'task_id', 'id'],
  waiting_human_tasks: ['task_id', 'business_task_id', 'id'],
}

/** 归一化按阶段聚合的计数表。 */
function normalizeStageMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [stageCode, count] of Object.entries(asRecord(value))) {
    const key = asText(stageCode)
    if (key !== '') out[key] = asCount(count)
  }
  return out
}

/** 把任意 overview 响应体归一化成 `OverviewResponse`：字段缺失不抛错，只降级。 */
export function normalizeOverview(value: unknown): OverviewResponse {
  const raw = asRecord(value)
  const labels = normalizeLabels(raw.labels)
  const countsRaw = asRecord(raw.counts)
  const listsRaw = asRecord(raw.lists)
  const unassignedRaw = asRecord(raw.unassigned)

  const lists: Record<string, OverviewListItem[]> = {}
  for (const key of OVERVIEW_LIST_KEYS) {
    lists[key] = normalizeList(listsRaw[key], labels, LIST_ID_KEYS[key] ?? ['id'])
  }
  const unassigned: Record<string, OverviewListItem[]> = {}
  for (const key of UNASSIGNED_LIST_KEYS) {
    unassigned[key] = normalizeList(unassignedRaw[key], labels, LIST_ID_KEYS[key] ?? ['id'])
  }

  const actorRaw = asRecord(raw.actor)
  const issues: string[] = []
  if (Array.isArray(raw.issues)) {
    for (const issue of raw.issues) {
      if (typeof issue === 'string' && issue.trim() !== '') issues.push(issue)
    }
  }

  return {
    contract_version: asText(raw.contract_version),
    configured: raw.configured === true,
    evaluated_at: asText(raw.evaluated_at),
    actor: {
      actor_id: asText(actorRaw.actor_id),
      display_name: asText(actorRaw.display_name),
      roles: asStringArray(actorRaw.roles),
    },
    labels,
    pending: normalizeList(raw.pending, labels, LIST_ID_KEYS.pending_decisions),
    counts: {
      pending_total: asCount(countsRaw.pending_total),
      pending_by_stage: normalizeStageMap(countsRaw.pending_by_stage),
      active_total: asCount(countsRaw.active_total),
      active_by_stage: normalizeStageMap(countsRaw.active_by_stage),
      my_interviews_total: asCount(countsRaw.my_interviews_total),
      overdue_scorecards_total: asCount(countsRaw.overdue_scorecards_total),
      pending_reviews_total: asCount(countsRaw.pending_reviews_total),
      connector_incidents_total: asCount(countsRaw.connector_incidents_total),
      waiting_human_total: asCount(countsRaw.waiting_human_total),
      unassigned_total: asCount(countsRaw.unassigned_total),
    },
    lists: {
      pending_decisions: lists.pending_decisions,
      my_interviews: lists.my_interviews,
      overdue_scorecards: lists.overdue_scorecards,
      pending_reviews: lists.pending_reviews,
      connector_incidents: lists.connector_incidents,
      waiting_human_tasks: lists.waiting_human_tasks,
    },
    unassigned: {
      note: asText(unassignedRaw.note),
      pending_decisions: unassigned.pending_decisions,
      pending_reviews: unassigned.pending_reviews,
      waiting_human_tasks: unassigned.waiting_human_tasks,
      connector_incidents: unassigned.connector_incidents,
    },
    issues,
  }
}

/** 只保留允许枚举里的值（服务端给了未知枚举值时丢弃，不渲染成可选项）。 */
function filterAllowed(value: unknown, allowed: readonly string[]): string[] {
  const out: string[] = []
  for (const item of asStringArray(value)) {
    if (allowed.includes(item) && !out.includes(item)) out.push(item)
  }
  return out
}

/** 归一化一个维度控件（key 为空则返回 null：没有 key 就无法构造动态键，fail-closed）。 */
function normalizeDimension(value: unknown): FormDimensionControl | null {
  const raw = asRecord(value)
  const key = asText(raw.key)
  if (key === '') return null
  const controls = asRecord(raw.controls)
  const score = asRecord(controls.score)
  const scoreMin = asCount(score.min)
  const scoreMax = asCount(score.max)
  return {
    key,
    label: asText(raw.label, key),
    kind: asText(raw.kind),
    weight: typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 0,
    assessmentOptions: filterAllowed(controls.assessment, ASSESSMENT_VALUES),
    scoreMin: scoreMin > 0 ? scoreMin : 1,
    scoreMax: scoreMax >= scoreMin && scoreMax > 0 ? scoreMax : 5,
    noteRequired: asBool(controls.note_required),
  }
}

/** 归一化 rubric 维度元数据（标题展示用）。 */
function normalizeRubricDimension(value: unknown): RubricDimensionMeta | null {
  const raw = asRecord(value)
  const key = asText(raw.key)
  if (key === '') return null
  return {
    key,
    label: asText(raw.label, key),
    kind: asText(raw.kind),
    weight: typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : 0,
  }
}

/** 归一化 `GET /recruitment/api/scorecard-form` 响应（字段缺失一律降级，不抛错）。 */
export function normalizeFormSpec(value: unknown): ScorecardFormSpec {
  const raw = asRecord(value)
  const actorRaw = asRecord(raw.actor)
  const interviewRaw = asRecord(raw.interview)
  const rubricRaw = asRecord(raw.rubric)
  const transcriptRaw = asRecord(raw.transcript_basis)
  const currentRaw = raw.current === null || raw.current === undefined ? null : asRecord(raw.current)

  const dimensions: FormDimensionControl[] = []
  if (Array.isArray(raw.dimensions)) {
    for (const item of raw.dimensions) {
      const dimension = normalizeDimension(item)
      if (dimension !== null) dimensions.push(dimension)
    }
  } else if (Array.isArray(rubricRaw.dimensions)) {
    // 拓扑降级：服务端没给控件列表时，用 rubric 维度生成**无枚举选项**的控件骨架。
    for (const item of rubricRaw.dimensions) {
      const meta = normalizeRubricDimension(item)
      if (meta === null) continue
      dimensions.push({
        key: meta.key,
        label: meta.label,
        kind: meta.kind,
        weight: meta.weight,
        assessmentOptions: [],
        scoreMin: 1,
        scoreMax: 5,
        noteRequired: false,
      })
    }
  }

  const rubricDimensions: RubricDimensionMeta[] = []
  if (Array.isArray(rubricRaw.dimensions)) {
    for (const item of rubricRaw.dimensions) {
      const meta = normalizeRubricDimension(item)
      if (meta !== null) rubricDimensions.push(meta)
    }
  }

  const modeRaw = asText(raw.mode)
  const mode = (FORM_MODES as readonly string[]).includes(modeRaw)
    ? (modeRaw as ScorecardFormSpec['mode'])
    : 'ALREADY_SUBMITTED'

  const overallOptions = filterAllowed(raw.overall_options, OVERALL_VALUES)

  return {
    contract_version: asText(raw.contract_version),
    actor: {
      actor_id: asText(actorRaw.actor_id),
      display_name: asText(actorRaw.display_name),
      roles: asStringArray(actorRaw.roles),
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
      dimensions: rubricDimensions,
    },
    dimensions,
    transcript_basis: {
      value: asText(transcriptRaw.value),
      options: asStringArray(transcriptRaw.options),
      locked: asBool(transcriptRaw.locked),
    },
    overall_options: overallOptions,
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
    labels: normalizeLabels(raw.labels),
  }
}

/** 归一化提交成功响应（scorecard 子对象缺失时降级为空串/0，绝不当作成功依据）。 */
export function normalizeSubmitResult(value: unknown): ScorecardSubmitResult {
  const raw = asRecord(value)
  const scorecardRaw = asRecord(raw.scorecard)
  return {
    status: asText(raw.status),
    replayed: asBool(raw.replayed),
    scorecard: {
      id: asText(scorecardRaw.id),
      revision_no: asCount(scorecardRaw.revision_no),
      status: asText(scorecardRaw.status),
    },
    coverage: raw.coverage ?? null,
  }
}

/** 带 status / code / reason_code 的 HTTP 错误：界面按契约字段原样显示。 */
export class RecruitmentHttpError extends Error {
  /** HTTP 状态码（网络层失败为 0）。 */
  readonly status: number
  /** 契约错误码（`INVALID_ARGS` 等）；解析不到为空串。 */
  readonly code: string
  /** 契约原因码（`DIMENSION_NOT_IN_RUBRIC` 等）；解析不到为空串。 */
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

/**
 * 把非 2xx 响应体解析成可读 `RecruitmentHttpError`。
 *
 * 契约形状优先级：`{error:{code,reason_code,message,detail}}` →
 * `{error:"文本"}` → 原文。解析不到时仍保留 HTTP 状态码。
 * @param status - HTTP 状态码。
 * @param bodyText - 响应体原文。
 * @returns 可读错误（保留 code / reason_code / detail）。
 */
export function parseHttpError(status: number, bodyText: string): RecruitmentHttpError {
  const text = bodyText.trim()
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
    const message = asText(error.message, asText(error.detail))
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
 * 从 JSON 响应体里抽取 scorecard 工具错误（200 但 `status !== 'OK'` 的失败要按失败展示）。
 * @returns 失败时返回错误；`status === 'OK'` 返回 null。
 */
export function submitResultError(value: unknown): RecruitmentHttpError | null {
  const raw = asRecord(value)
  const status = asText(raw.status)
  if (status === 'OK') return null
  const error = asRecord(raw.error)
  const code = asText(error.code, asText(raw.code))
  const reasonCode = asText(error.reason_code, asText(raw.reason_code))
  const message = asText(error.message, asText(raw.message, status === '' ? '面评提交返回了空响应' : status))
  const composed = [code, reasonCode].filter((part) => part !== '').join('/')
  return new RecruitmentHttpError(
    200,
    code,
    reasonCode,
    composed === '' ? message : `${composed}：${message}`,
    error.detail ?? raw.detail,
  )
}
