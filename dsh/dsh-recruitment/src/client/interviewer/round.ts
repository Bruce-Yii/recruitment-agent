// 轮次级评分标准的**纯函数**数据层：`round_focus` / `effective_rubric` 归一化、
// 每场面试的轮次有效投影（`RoundEffectiveView`）、来源文案、以及面评表单的 effective schema 派生。
//
// 服务端字段名逐字来自 task-50 冻结口径（`work/d5/w3b/W3B-CONTRACT.md` §1）。本文件只做
// "透传 + 收紧 + 投影"，**不 import react / 不碰 DOM / 不发请求**，供 `node --test` 直接覆盖。
//
// 三条业务纪律（W3B-CONTRACT §0 / §3）：
//   1. 每轮考察重点不同：有轮次配置就展示；没有就**如实降级 JOB_BASE**，绝不伪造 title/description/questions。
//   2. 两键都缺（task-50 端点未升级）→ `serverFieldsMissing=true`，维度回退旧 `row.rubric.dimensions`，
//      卡片必须显示"服务端未提供轮次配置（task-50 端点未就绪）"；`brief.focus` 只能当"旧 brief"辅助信息。
//   3. 面评提交键集只来自 W1 form spec：effective schema 只覆盖**顺序/标签/权重/重点标记**；
//      服务端自相矛盾（submission keys ≠ spec keys / effective 含 spec 外 key）时 fail-closed 不写库。
//
// 类型依赖说明：本文件只从 `normalize.ts` 取 **type-only** 依赖（运行时擦除），
// `normalize.ts` 反过来 value-import 本文件的 `normalizeRoundEffective`，因此运行时不构成循环依赖。

import type {
  BriefFocus,
  FormDimension,
  InterviewRubric,
  ScorecardFormSpec,
} from './normalize.ts'

/** 轮次考察重点的一个维度（服务端 `focus_dimensions[]`）。 */
export interface RoundFocusDimensionView {
  readonly key: string
  readonly label: string
  readonly weight: number
  readonly required: boolean
  readonly inRubric: boolean
}

/** 轮次配置里的一条建议问题（`questions[]`；`key` 可为 null → ''）。 */
export interface RoundQuestionView {
  readonly key: string
  readonly text: string
}

/** 评分表字段（`round_focus.scorecard_fields[]` / `effective_rubric.scorecard.fields[]` 同形）。 */
export interface RoundScorecardFieldView {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly required: boolean
}

/** 轮次考察重点（`round_focus`）的客户端投影。 */
export interface RoundFocusView {
  readonly available: boolean
  /** 服务端 source 原样：`'ROUND_CONFIG' | 'JOB_BASE' | 其他未知值 | ''`（字段缺失）。 */
  readonly source: string
  readonly round_no: number
  readonly title: string
  readonly description: string
  readonly reason: string
  readonly templateVersionId: string
  readonly templateVersionNo: number
  readonly templatePayloadHash: string
  readonly focusDimensions: readonly RoundFocusDimensionView[]
  readonly questions: readonly RoundQuestionView[]
  readonly scorecardFields: readonly RoundScorecardFieldView[]
}

/** 本轮生效评分表的一个维度（`effective_rubric.dimensions[]`）。 */
export interface EffectiveRubricDimensionView {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly required: boolean
  readonly focus: boolean
  readonly mustCover: boolean
  readonly origin: string
  readonly question: string
}

/** 本轮生效评分表（`effective_rubric`）的客户端投影。 */
export interface EffectiveRubricView {
  readonly available: boolean
  readonly source: string
  readonly round_no: number
  readonly jobId: string
  readonly rubricVersionId: string
  readonly rubricVersionNo: number
  readonly rubricPayloadHash: string
  readonly baseRubricVersionId: string
  readonly templateVersionId: string
  readonly templateVersionNo: number
  readonly declaredRoundRubricVersionId: string
  readonly dimensions: readonly EffectiveRubricDimensionView[]
  /** 0/0 = 服务端没给 scale（界面显示"服务端未提供"，不显示 `0–0`）。 */
  readonly scaleMin: number
  readonly scaleMax: number
  readonly scorecardFields: readonly RoundScorecardFieldView[]
  readonly submissionRubricVersionId: string
  readonly submissionDimensionKeys: readonly string[]
  readonly reason: string
}

/** 每场面试的轮次有效评分标准投影（挂到 `InterviewRow.round`）。 */
export interface RoundEffectiveView {
  readonly focus: RoundFocusView
  readonly rubric: EffectiveRubricView
  /** true = 服务端响应里**没有**可用 round_focus/effective_rubric（task-50 端点未升级）→ 旧 brief/rubric 降级。 */
  readonly serverFieldsMissing: boolean
  /** true = 服务端字段存在但自相矛盾（round_no 不一致 / declared rubric 与 base 冲突等），展示提示、不猜。 */
  readonly conflict: boolean
  readonly conflictReason: string
}

/** 列表右栏"分配轮次与考察重点"的一组（轮次投影；旧 `groupRounds` 的 brief 口径不再冒充轮次配置）。 */
export interface RoundProjectGroup {
  readonly round_no: number
  readonly source: string
  readonly available: boolean
  readonly title: string
  readonly focusDimensions: readonly RoundFocusDimensionView[]
  readonly mustCoverCount: number
  readonly serverFieldsMissing: boolean
  readonly interviewCount: number
  /** 旧 brief（TEMPLATE/JOB_RUBRIC/NONE）辅助信息：只在旧端点降级时展示，且标注"非轮次配置"。 */
  readonly legacyBriefSource: string
  readonly legacyBriefFocus: readonly BriefFocus[]
  readonly reason: string
}

/** 表单派生出的一个字段（控件仍来自 spec；顺序/标签/权重/重点标记来自 effective schema）。 */
export interface DerivedScorecardField {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly focus: boolean
  readonly mustCover: boolean
  readonly origin: string
  /** true = 该字段的展示信息被 effective schema 覆盖（控件仍是 spec 的）。 */
  readonly overridden: boolean
  /** 控件来源：W1 form spec 的维度（枚举/分数区间/note 必填只认它）。 */
  readonly spec: FormDimension
}

/** `deriveScorecardFields` 的结果（含 fail-closed 判定）。 */
export interface ScorecardFieldDerivation {
  readonly fields: readonly DerivedScorecardField[]
  /** true = 可提交（有字段且无 schema 矛盾）。 */
  readonly usable: boolean
  readonly mismatch: boolean
  /** 差异 key：submission 多出 / spec 缺少 / effective 含 spec 外（去重）。 */
  readonly mismatchKeys: readonly string[]
  readonly mismatchText: string
}

/** 旧端点（两键都缺）的固定文案：明确"不伪造本轮重点"。 */
export const ROUND_SERVER_FIELDS_MISSING_TEXT =
  '服务端未提供轮次配置（task-50 端点未就绪）→ JOB_BASE 降级，不伪造本轮重点'

/** fail-closed 的固定文案（W3B-CONTRACT §4.2 逐字）。 */
export const ROUND_SCHEMA_MISMATCH_TEXT = '本轮评分表与面评表单 spec 不一致，已 fail-closed（不写库）'

/** 来源文案表（W3B-CONTRACT §3 逐字）。 */
const ROUND_SOURCE_TEXT: Readonly<Record<string, string>> = {
  ROUND_CONFIG: '轮次配置（本场有专属考察重点与评分表覆盖）',
  ROUND_OVERRIDE: '轮次覆盖（本轮评分表在岗位底座上有覆盖）',
  JOB_BASE: '岗位基础（JOB_BASE 降级：服务端未提供该轮配置）',
  TEMPLATE: '面试模板（旧 brief，非轮次配置）',
}

/** 旧端点降级的来源文案（两键都缺；与普通 JOB_BASE 区分，说明 task-50 未就绪）。 */
const ROUND_OLD_ENDPOINT_SOURCE_TEXT =
  '岗位基础（JOB_BASE 降级：服务端未提供轮次配置，task-50 端点未就绪）'

/** 取一个对象；null / 数组 / 非对象一律降级为空对象。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 是否是一个"可用对象"（null/数组/标量都不算服务端给了配置）。 */
function isRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 取一个字符串；非字符串降级为 ''（坏类型不伪装成业务值）。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 取一个有限数字；否则 0（杜绝 NaN / Infinity / 字符串数字）。 */
function asFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 取一个非负整数；否则 0。 */
function asCount(value: unknown): number {
  const number = asFiniteNumber(value)
  return number >= 0 ? Math.trunc(number) : 0
}

/** 只认严格 true。 */
function asBool(value: unknown): boolean {
  return value === true
}

/** 字符串数组归一化（丢弃非字符串/空串；上限 100 项）。 */
function asStringArray(value: unknown, limit = 100): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= limit) break
    const text = asText(item)
    if (text !== '') out.push(text)
  }
  return out
}

/** 归一化一条 `focus_dimensions[]`。 */
function normalizeFocusDimensions(value: unknown): RoundFocusDimensionView[] {
  const out: RoundFocusDimensionView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    const raw = asRecord(item)
    const key = asText(raw.key)
    const label = asText(raw.label) || key
    if (key === '' && label === '') continue
    out.push({
      key,
      label: label !== '' ? label : key,
      weight: asFiniteNumber(raw.weight),
      required: asBool(raw.required),
      inRubric: asBool(raw.in_rubric),
    })
  }
  return out
}

/** 归一化一条 `questions[]`（text 必填；key 可为 null → ''）。 */
function normalizeQuestions(value: unknown): RoundQuestionView[] {
  const out: RoundQuestionView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    // 防御旧响应：问题也可能是纯字符串。
    const text = typeof item === 'string' ? asText(item) : asText(asRecord(item).text)
    if (text === '') continue
    out.push({ key: typeof item === 'string' ? '' : asText(asRecord(item).key), text })
  }
  return out
}

/** 归一化 `scorecard_fields[]` / `scorecard.fields[]`（同形）。 */
function normalizeScorecardFields(value: unknown): RoundScorecardFieldView[] {
  const out: RoundScorecardFieldView[] = []
  if (!Array.isArray(value)) return out
  for (const item of value.slice(0, 100)) {
    const raw = asRecord(item)
    const key = asText(raw.key)
    const label = asText(raw.label) || key
    if (key === '' && label === '') continue
    out.push({ key, label: label !== '' ? label : key, kind: asText(raw.kind), required: asBool(raw.required) })
  }
  return out
}

/** 归一化 `effective_rubric.dimensions[]`（key 为空的行丢弃：没有键就无法对齐面评）。 */
function normalizeEffectiveDimensions(value: unknown): EffectiveRubricDimensionView[] {
  const out: EffectiveRubricDimensionView[] = []
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
      required: asBool(raw.required),
      focus: asBool(raw.focus),
      mustCover: asBool(raw.must_cover),
      origin: asText(raw.origin),
      question: asText(raw.question),
    })
  }
  return out
}

/** 空轮次重点（`round_no` 用面试行的轮次；source='' 表示服务端没给）。 */
export function emptyRoundFocus(roundNo = 0): RoundFocusView {
  return {
    available: false,
    source: '',
    round_no: asCount(roundNo),
    title: '',
    description: '',
    reason: '',
    templateVersionId: '',
    templateVersionNo: 0,
    templatePayloadHash: '',
    focusDimensions: [],
    questions: [],
    scorecardFields: [],
  }
}

/** 空生效评分表（0/0 scale = 服务端没给；不显示 `0–0`）。 */
export function emptyEffectiveRubric(roundNo = 0): EffectiveRubricView {
  return {
    available: false,
    source: '',
    round_no: asCount(roundNo),
    jobId: '',
    rubricVersionId: '',
    rubricVersionNo: 0,
    rubricPayloadHash: '',
    baseRubricVersionId: '',
    templateVersionId: '',
    templateVersionNo: 0,
    declaredRoundRubricVersionId: '',
    dimensions: [],
    scaleMin: 0,
    scaleMax: 0,
    scorecardFields: [],
    submissionRubricVersionId: '',
    submissionDimensionKeys: [],
    reason: '',
  }
}

/**
 * 归一化 `round_focus`（服务端字段名逐字来自 task-50 冻结口径）。
 * @param value - 服务端原始 `round_focus`。
 * @returns 安全投影；未知字段值原样保留（''/0/[]，不猜、不补默认文案）。
 */
export function normalizeRoundFocus(value: unknown): RoundFocusView {
  const raw = asRecord(value)
  return {
    available: asBool(raw.available),
    source: asText(raw.source),
    round_no: asCount(raw.round_no),
    title: asText(raw.title),
    description: asText(raw.description),
    reason: asText(raw.reason),
    templateVersionId: asText(raw.template_version_id),
    templateVersionNo: asCount(raw.template_version_no),
    templatePayloadHash: asText(raw.template_payload_hash),
    focusDimensions: normalizeFocusDimensions(raw.focus_dimensions),
    questions: normalizeQuestions(raw.questions),
    scorecardFields: normalizeScorecardFields(raw.scorecard_fields),
  }
}

/**
 * 归一化 `effective_rubric`（服务端字段名逐字来自 task-50 冻结口径）。
 * @param value - 服务端原始 `effective_rubric`。
 * @returns 安全投影（scale 缺失时 0/0；submission 只供展示/核对，提交仍走 W1）。
 */
export function normalizeEffectiveRubric(value: unknown): EffectiveRubricView {
  const raw = asRecord(value)
  const scorecard = asRecord(raw.scorecard)
  const scale = asRecord(scorecard.scale)
  const submission = asRecord(raw.submission)
  return {
    available: asBool(raw.available),
    source: asText(raw.source),
    round_no: asCount(raw.round_no),
    jobId: asText(raw.job_id),
    rubricVersionId: asText(raw.rubric_version_id),
    rubricVersionNo: asCount(raw.rubric_version_no),
    rubricPayloadHash: asText(raw.rubric_payload_hash),
    baseRubricVersionId: asText(raw.base_rubric_version_id),
    templateVersionId: asText(raw.template_version_id),
    templateVersionNo: asCount(raw.template_version_no),
    declaredRoundRubricVersionId: asText(raw.declared_round_rubric_version_id),
    dimensions: normalizeEffectiveDimensions(raw.dimensions),
    scaleMin: asCount(scale.min),
    scaleMax: asCount(scale.max),
    scorecardFields: normalizeScorecardFields(scorecard.fields),
    submissionRubricVersionId: asText(submission.rubric_version_id),
    submissionDimensionKeys: asStringArray(submission.dimension_keys, 100),
    reason: asText(raw.reason),
  }
}

/** 旧 `row.rubric.dimensions` → effective 维度宇宙（JOB_BASE 底座；不伪造 focus/must_cover）。 */
function legacyRubricDimensions(legacy: InterviewRubric | null): EffectiveRubricDimensionView[] {
  if (legacy === null) return []
  return legacy.dimensions.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    kind: dimension.kind,
    weight: dimension.weight,
    // 面评必答（契约 §1.2：required 恒 true）；focus/must_cover 只有轮次模板能给 → false。
    required: true,
    focus: false,
    mustCover: false,
    origin: 'JOB_BASE',
    question: dimension.question,
  }))
}

/** 用旧 `row.rubric` 合成 JOB_BASE 评分表（服务端没给 effective schema 时的唯一诚实来源）。 */
function legacyRubricFallback(
  legacy: InterviewRubric | null,
  roundNo: number,
  reason: string,
): EffectiveRubricView {
  const dimensions = legacyRubricDimensions(legacy)
  return {
    ...emptyEffectiveRubric(roundNo),
    available: dimensions.length > 0,
    source: 'JOB_BASE',
    jobId: legacy !== null ? legacy.job_id : '',
    rubricVersionId: legacy !== null ? legacy.rubric_version_id : '',
    rubricPayloadHash: legacy !== null ? legacy.payload_hash : '',
    dimensions,
    reason: reason !== '' ? reason : dimensions.length === 0 ? '服务端未提供评分维度（不伪造）' : '',
  }
}

/** 归一化入参（`round_no` 只来自面试行；旧 rubric 只用于降级）。 */
export interface NormalizeRoundOptions {
  /** 面试行的 `round_no`（**不**按列表顺序推断）。 */
  readonly roundNo: number
  /** 归一化后的旧 `row.rubric`（没有就 null）。 */
  readonly legacyRubric?: InterviewRubric | null
  /** 兼容另一写入方的键名（与 `legacyRubric` 同义，优先 `legacyRubric`）。 */
  readonly rubric?: InterviewRubric | null
  /** 旧 brief 辅助信息（只在旧端点降级时标注来源，**不**冒充轮次配置）。 */
  readonly brief?: unknown
}

/** 取 options 里的旧 rubric（两种键名都接受，避免并行写入方的键名差异导致构建失败）。 */
function optionsLegacyRubric(options: NormalizeRoundOptions): InterviewRubric | null {
  if (options.legacyRubric !== undefined) return options.legacyRubric
  return options.rubric !== undefined ? options.rubric : null
}

/**
 * 归一化并投影一场面试的轮次有效评分标准（`InterviewRow.round`）。
 *
 * 优先级（W3B-CONTRACT §3）：
 *   1. 两键都在 → 逐字段归一化；
 *   2. `round_focus.available=false` → focus 降级（保留服务端 reason/source），维度用 effective_rubric；
 *   3. 只有 effective_rubric → focus 降级，source 以 effective_rubric.source 为准；
 *   4. 两键都缺（旧端点）→ `serverFieldsMissing=true` + focus.source='JOB_BASE'，维度回退旧 row.rubric；
 *   5. declared rubric 与 base 冲突 → `conflict=true`，**维度宇宙不变**（不自行换版本）；
 *   6. `round_focus.round_no` ≠ 面试 `round_no` → 不套用轮次重点（`conflict=true`），只显示降级卡。
 * @param value - 服务端原始面试行（用来判断两个键是否存在）。
 * @param options - 面试行 round_no + 旧 rubric。
 * @returns 轮次有效投影（绝不抛错）。
 */
export function normalizeRoundEffective(value: unknown, options: NormalizeRoundOptions): RoundEffectiveView {
  const raw = asRecord(value)
  const roundNo = asCount(options.roundNo)
  const legacyRubric = optionsLegacyRubric(options)
  const hasFocus = isRecord(raw.round_focus)
  const hasRubric = isRecord(raw.effective_rubric)
  const conflictReasons: string[] = []

  // 4. 两键都缺：旧端点 → 不伪造任何轮次重点；维度回退旧 row.rubric（有 rubric 时）。
  if (!hasFocus && !hasRubric) {
    return {
      focus: { ...emptyRoundFocus(roundNo), source: 'JOB_BASE', reason: ROUND_SERVER_FIELDS_MISSING_TEXT },
      rubric: legacyRubricFallback(legacyRubric, roundNo, ROUND_SERVER_FIELDS_MISSING_TEXT),
      serverFieldsMissing: true,
      conflict: false,
      conflictReason: '',
    }
  }

  let rubric = hasRubric ? normalizeEffectiveRubric(raw.effective_rubric) : emptyEffectiveRubric(roundNo)
  let focus = hasFocus ? normalizeRoundFocus(raw.round_focus) : emptyRoundFocus(roundNo)

  // 3. 只有 effective_rubric：focus 降级，source 以 effective_rubric.source 为准。
  if (!hasFocus) {
    const source = rubric.source
    focus = {
      ...emptyRoundFocus(roundNo),
      available: false,
      source,
      reason:
        '服务端未提供 round_focus（仅有 effective_rubric）→ 本轮重点如实降级；评分维度取自 effective_rubric（不伪造轮次重点）',
    }
  }

  // 只有 round_focus：评分表回退旧 row.rubric（不伪造轮次覆盖）。
  if (!hasRubric) {
    rubric = legacyRubricFallback(legacyRubric,
      roundNo,
      '服务端未提供 effective_rubric（仅有 round_focus）→ 评分维度回退到旧 row.rubric（不伪造轮次覆盖）',
    )
  }

  // 6. round_no 不一致：不套用轮次重点（只显示降级卡），把冲突写进 reason。
  if (hasFocus && focus.round_no > 0 && roundNo > 0 && focus.round_no !== roundNo) {
    conflictReasons.push(
      `round_focus.round_no=${focus.round_no} 与面试 round_no=${roundNo} 不一致；不套用轮次考察重点，只显示 JOB_BASE 降级`,
    )
    focus = {
      ...focus,
      available: false,
      title: '',
      description: '',
      focusDimensions: [],
      questions: [],
      scorecardFields: [],
      reason:
        focus.reason !== ''
          ? `${focus.reason}；${ROUND_SERVER_FIELDS_MISSING_TEXT}`
          : `round_focus.round_no=${focus.round_no} 与面试 round_no=${roundNo} 不一致，不套用轮次考察重点`,
    }
  }

  // 5. 轮次模板声明的 rubric 版本 ≠ 申请钉住的 base：维度宇宙保持 base/JOB_BASE，禁止 UI 自行换版本。
  if (
    rubric.declaredRoundRubricVersionId !== '' &&
    rubric.declaredRoundRubricVersionId !== rubric.baseRubricVersionId
  ) {
    conflictReasons.push(
      `轮次模板声明的 rubric 版本（${rubric.declaredRoundRubricVersionId}）与申请钉住的 base（${
        rubric.baseRubricVersionId !== '' ? rubric.baseRubricVersionId : '服务端未提供'
      }）不一致；按 base/JOB_BASE 维度渲染，UI 不自行换版本`,
    )
  }

  return {
    focus,
    rubric,
    serverFieldsMissing: false,
    conflict: conflictReasons.length > 0,
    conflictReason: conflictReasons.join('；'),
  }
}

/**
 * 来源文案（W3B-CONTRACT §3 表；未知 source 原样显示，不猜）。
 * @param source - 服务端 source（可为空/未知）。
 * @param serverFieldsMissing - true = 旧端点（两键都缺）降级。
 * @returns 可展示文案。
 */
export function roundSourceText(source: string, serverFieldsMissing = false): string {
  if (serverFieldsMissing) return ROUND_OLD_ENDPOINT_SOURCE_TEXT
  const value = asText(source)
  if (value === '') return '未知来源（服务端未提供 source）'
  return ROUND_SOURCE_TEXT[value] ?? `未知来源（${value}，原样显示）`
}

/**
 * 降级卡文案：优先原样使用服务端 `reason`；没有 reason 时给"没有配置"的事实说明。
 * @param view - 轮次有效投影。
 * @returns 可展示文案（绝不出现伪造的本轮重点）。
 */
export function roundFocusDegradedText(view: RoundEffectiveView): string {
  if (view.serverFieldsMissing) return ROUND_SERVER_FIELDS_MISSING_TEXT
  if (view.focus.reason !== '') return view.focus.reason
  if (view.conflict && view.conflictReason !== '') return view.conflictReason
  return '服务端未提供本轮轮次配置（JOB_BASE 降级，不伪造本轮重点；评分维度见下方 effective schema）'
}

/**
 * 列表右栏按轮次分组（用轮次投影，不用 brief.focus 冒充轮次配置）。
 * @param rows - 面试行（已归一化）。
 * @returns 按 `round_no` 升序的分组；同轮次的重点维度去重。
 */
export function groupRoundProjects(rows: readonly InterviewRowLike[]): RoundProjectGroup[] {
  interface Draft {
    round_no: number
    source: string
    available: boolean
    title: string
    focusDimensions: RoundFocusDimensionView[]
    seen: Set<string>
    mustCoverCount: number
    serverFieldsMissing: boolean
    interviewCount: number
    legacyBriefSource: string
    legacyBriefFocus: BriefFocus[]
    legacySeen: Set<string>
    reason: string
  }
  const groups = new Map<number, Draft>()
  for (const row of rows) {
    const roundNo = row.round_no
    let group = groups.get(roundNo)
    if (group === undefined) {
      group = {
        round_no: roundNo,
        source: '',
        available: false,
        title: '',
        focusDimensions: [],
        seen: new Set<string>(),
        mustCoverCount: 0,
        serverFieldsMissing: false,
        interviewCount: 0,
        legacyBriefSource: '',
        legacyBriefFocus: [],
        legacySeen: new Set<string>(),
        reason: '',
      }
      groups.set(roundNo, group)
    }
    group.interviewCount += 1
    const projection = row.round
    if (!group.available && projection.focus.available) {
      group.available = true
      group.source = projection.focus.source
      group.title = projection.focus.title
      for (const dimension of projection.focus.focusDimensions) {
        const key = dimension.key !== '' ? dimension.key : dimension.label
        if (key === '' || group.seen.has(key)) continue
        group.seen.add(key)
        group.focusDimensions.push(dimension)
      }
      group.mustCoverCount = projection.rubric.dimensions.filter((dimension) => dimension.mustCover).length
    }
    if (!group.serverFieldsMissing && projection.serverFieldsMissing) {
      group.serverFieldsMissing = true
      group.reason = projection.focus.reason
    }
    if (group.source === '') group.source = projection.focus.source || projection.rubric.source
    if (group.reason === '' && !projection.focus.available) group.reason = projection.focus.reason
    if (group.legacyBriefSource === '' && row.brief.source !== '') group.legacyBriefSource = row.brief.source
    // 旧 brief 只在旧端点降级时作为"非轮次配置"辅助信息展示。
    if (projection.serverFieldsMissing) {
      for (const item of row.brief.focus) {
        const key = item.key !== '' ? item.key : item.label
        if (key === '' || group.legacySeen.has(key)) continue
        group.legacySeen.add(key)
        group.legacyBriefFocus.push(item)
      }
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.round_no - right.round_no)
    .map((group) => ({
      round_no: group.round_no,
      source: group.source,
      available: group.available,
      title: group.title,
      focusDimensions: group.focusDimensions,
      mustCoverCount: group.mustCoverCount,
      serverFieldsMissing: group.serverFieldsMissing,
      interviewCount: group.interviewCount,
      legacyBriefSource: group.legacyBriefSource,
      legacyBriefFocus: group.legacyBriefFocus,
      reason: group.reason,
    }))
}

/** `groupRoundProjects` 只需要"轮次投影 + 旧 brief"这几项（避免 value-import normalize 造成环）。 */
export interface InterviewRowLike {
  readonly round_no: number
  readonly round: RoundEffectiveView
  readonly brief: { readonly source: string; readonly focus: readonly BriefFocus[] }
}

/**
 * 面评表单的 effective schema 派生（W3B-CONTRACT §4.2）。
 *
 * 规则：
 *   - 控件仍只来自 W1 spec（枚举/分数区间/note 必填）；effective schema 只覆盖顺序/标签/权重/重点标记；
 *   - effective key ∈ spec key 才覆盖；spec 其余维度按原样追加在末尾；
 *   - `submission.dimension_keys` 非空且 ≠ spec key 集合 → mismatch；effective 含 spec 外 key → mismatch；
 *   - effective 子集 → 允许提交（spec 全集仍必填）；
 *   - `serverFieldsMissing`（旧端点）→ 不产生 mismatch，按现行为提交。
 * @param spec - 归一化后的 W1 form spec（可为空，表示还没取到）。
 * @param round - 父组件传入的轮次投影（可为空以兼容旧调用）。
 * @returns 字段顺序 + fail-closed 判定。
 */
export function deriveScorecardFields(
  spec: ScorecardFormSpec | null | undefined,
  round?: RoundEffectiveView | null,
): ScorecardFieldDerivation {
  const specDimensions = spec !== null && spec !== undefined ? spec.dimensions : []
  const roundView = round !== null && round !== undefined ? round : null
  // 旧端点没有真实 effective schema：保持 W1 spec 原样（不把旧 rubric 当轮次覆盖）。
  const effectiveDimensions =
    roundView !== null && !roundView.serverFieldsMissing && roundView.rubric.available
      ? roundView.rubric.dimensions
      : []

  const specByKey = new Map<string, FormDimension>()
  const specKeys: string[] = []
  for (const dimension of specDimensions) {
    if (specByKey.has(dimension.key)) continue
    specByKey.set(dimension.key, dimension)
    specKeys.push(dimension.key)
  }
  const specKeySet = new Set(specKeys)

  const fields: DerivedScorecardField[] = []
  const rendered = new Set<string>()
  for (const dimension of effectiveDimensions) {
    const specDimension = specByKey.get(dimension.key)
    if (specDimension === undefined || rendered.has(dimension.key)) continue
    rendered.add(dimension.key)
    fields.push({
      key: dimension.key,
      label: dimension.label !== '' ? dimension.label : specDimension.label,
      kind: dimension.kind !== '' ? dimension.kind : specDimension.kind,
      weight: dimension.weight !== 0 ? dimension.weight : specDimension.weight,
      focus: dimension.focus,
      mustCover: dimension.mustCover,
      origin: dimension.origin,
      overridden: true,
      spec: specDimension,
    })
  }
  for (const specDimension of specDimensions) {
    if (rendered.has(specDimension.key)) continue
    rendered.add(specDimension.key)
    fields.push({
      key: specDimension.key,
      label: specDimension.label,
      kind: specDimension.kind,
      weight: specDimension.weight,
      focus: false,
      mustCover: false,
      origin: '',
      overridden: false,
      spec: specDimension,
    })
  }

  const submissionKeys = roundView !== null ? roundView.rubric.submissionDimensionKeys : []
  const extraInSubmission = submissionKeys.filter((key) => !specKeySet.has(key))
  const missingFromSubmission = specKeys.filter((key) => !submissionKeys.includes(key))
  const extraEffective = effectiveDimensions
    .filter((dimension) => !specKeySet.has(dimension.key))
    .map((dimension) => dimension.key)

  const mismatchKeys: string[] = []
  for (const key of [...extraInSubmission, ...missingFromSubmission, ...extraEffective]) {
    if (key !== '' && !mismatchKeys.includes(key)) mismatchKeys.push(key)
  }
  const submissionMismatch =
    submissionKeys.length > 0 && (extraInSubmission.length > 0 || missingFromSubmission.length > 0)
  const mismatch =
    roundView !== null && !roundView.serverFieldsMissing && (submissionMismatch || extraEffective.length > 0)

  return {
    fields,
    usable: fields.length > 0 && !mismatch,
    mismatch,
    mismatchKeys,
    mismatchText:
      mismatchKeys.length > 0
        ? `${ROUND_SCHEMA_MISMATCH_TEXT}（差异 key：${mismatchKeys.join('、')}）`
        : ROUND_SCHEMA_MISMATCH_TEXT,
  }
}
