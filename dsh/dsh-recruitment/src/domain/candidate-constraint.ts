// 候选人级约束（碎片约束置顶 + 下一轮交接提醒）—— 纯函数层（无 I/O）。
//
// 业务规则（docs/34 §2「碎片约束置顶 + 下一轮交接提醒」）：
//   * 一张 append-only 表 recruitment.candidate_constraint；每条约束是一次写入事实。
//   * kind='PIN' = 置顶约束（可多条并存，按 created_at 排序）；
//     kind='HANDOFF' = 传给下一轮的交接提醒（必须带 interview_id）。
//   * 模型（Agent）永远不能传服务端派生字段（tenant_id / actor_id / id / created_at /
//     record_version / superseded_by_constraint_id），在解析阶段 fail-closed 拒绝。
//   * 未知键也拒绝（UNKNOWN_PARAM）—— 与 candidate-constraint 工具的参数 schema
//     additionalProperties:false 对齐（由工具层保证）。
//   * 文本用 btrim 归一化（去掉首尾空白），再用 .length 计长度，1..500。
//
// 本文件不 import 任何工具/contract.ts，保持纯函数（UUID 正则内置）。
// ---------------------------------------------------------------------------

/** 约束种类闭集（顺序固定，测试按此断言不许悄悄扩集）。 */
export const CONSTRAINT_KINDS = ['PIN', 'HANDOFF'] as const
export type ConstraintKind = typeof CONSTRAINT_KINDS[number]

/** 约束来源闭集（顺序固定）。 */
export const CONSTRAINT_SOURCES = ['CHAT', 'WEIXIN', 'PHONE', 'OTHER'] as const
export type ConstraintSource = typeof CONSTRAINT_SOURCES[number]

/** action 闭集（含 UNPIN，UNPIN 不是表里的 kind，是工具动作）。 */
export const CONSTRAINT_ACTIONS = ['PIN', 'UNPIN', 'HANDOFF'] as const
export type ConstraintAction = typeof CONSTRAINT_ACTIONS[number]

/** 文本上限（与 DB 的 ck_candidate_constraint_text 对齐）。 */
export const MAX_CONSTRAINT_TEXT = 500

/** UNPIN 墓碑文本常量（读投影据此过滤；由 DB 适配器导出同样常量）。 */
export const UNPIN_TOMBSTONE_TEXT = '（已取消置顶）'

/** 简单 UUID 正则（八-四-四-四-十二，忽略大小写）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 本文件内的 UUID 形状判断（保持纯函数，不依赖 tools/contract.ts）。 */
export function isConstraintUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** 服务端派生字段：模型传入即拒绝（reason_code = SERVER_DERIVED_REJECTED）。 */
const SERVER_DERIVED_KEYS: readonly string[] = [
  'tenant_id', 'actor_id', 'created_by_actor_id', 'id', 'created_at',
  'record_version', 'superseded_by_constraint_id',
]

/** 允许出现在入参里的业务键（其余一律 UNKNOWN_PARAM）。 */
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'action', 'candidate_id', 'application_id', 'text', 'source', 'interview_id',
])

/** 已校验的入参。text 已 btrim 归一化。 */
export interface CandidateConstraintInput {
  readonly action: ConstraintKind | 'UNPIN'
  readonly candidate_id?: string
  readonly application_id?: string
  readonly text?: string
  readonly source?: ConstraintSource
  readonly interview_id?: string
}

/** 成功结果。 */
export interface ParseOk {
  readonly ok: true
  readonly value: CandidateConstraintInput
}

/** 失败结果：reason_code 是稳定机检码，message 给人看。 */
export interface ParseErr {
  readonly ok: false
  readonly reason_code: string
  readonly message: string
}

export type ParseResult<T> = { ok: true; value: T } | ParseErr

/**
 * 校验 Agent 传入的约束参数（纯函数，无 IO）。
 *
 * 检查顺序固定（便于测试与错误码稳定）：
 *   1. 非对象 / null / 数组 → TYPE_MISMATCH；
 *   2. 服务端派生键 → SERVER_DERIVED_REJECTED；未知键 → UNKNOWN_PARAM；
 *   3. action 必填且闭集 PIN/UNPIN/HANDOFF → MISSING_REQUIRED / ENUM_INVALID；
 *   4. candidate_id / application_id 至少给一个；给了都必须是合法 UUID
 *      （越权/不存在由 DB 层判定）→ MISSING_REQUIRED / ID_NOT_UUID；
 *   5. text：PIN/HANDOFF 必填，btrim 后 1..500；UNPIN 可选
 *      → MISSING_REQUIRED / TYPE_MISMATCH / OUT_OF_RANGE；
 *   6. source：PIN/HANDOFF 必填且闭集；UNPIN 可选 → MISSING_REQUIRED / ENUM_INVALID；
 *   7. interview_id：HANDOFF 必填且合法 UUID；PIN/UNPIN 若给了也校验 UUID
 *      → MISSING_REQUIRED / ID_NOT_UUID。
 *
 * 返回值里 text 做 btrim 归一化。
 * @param raw - Agent 传来的原始 args 对象。
 */
export function parseCandidateConstraintArgs(raw: unknown): ParseResult<CandidateConstraintInput> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason_code: 'TYPE_MISMATCH', message: '参数必须是一个对象' }
  }
  const obj = raw as Record<string, unknown>

  for (const key of SERVER_DERIVED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      return {
        ok: false,
        reason_code: 'SERVER_DERIVED_REJECTED',
        message: `字段 ${key} 由服务端派生，不接受模型传入`,
      }
    }
  }
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, reason_code: 'UNKNOWN_PARAM', message: `未知参数 ${key}` }
    }
  }

  const action = obj.action
  if (action === undefined || action === null) {
    return { ok: false, reason_code: 'MISSING_REQUIRED', message: '缺少 action' }
  }
  if (typeof action !== 'string' || !CONSTRAINT_ACTIONS.includes(action as ConstraintAction)) {
    return { ok: false, reason_code: 'ENUM_INVALID', message: `action 必须是 ${CONSTRAINT_ACTIONS.join(' / ')} 之一` }
  }
  const kind = action as ConstraintAction

  const candidateIdRaw = obj.candidate_id
  const applicationIdRaw = obj.application_id
  if (candidateIdRaw === undefined && applicationIdRaw === undefined) {
    return { ok: false, reason_code: 'MISSING_REQUIRED', message: 'candidate_id 与 application_id 至少给一个' }
  }
  if (candidateIdRaw !== undefined && !isConstraintUuid(candidateIdRaw)) {
    return { ok: false, reason_code: 'ID_NOT_UUID', message: 'candidate_id 必须是合法 UUID' }
  }
  if (applicationIdRaw !== undefined && !isConstraintUuid(applicationIdRaw)) {
    return { ok: false, reason_code: 'ID_NOT_UUID', message: 'application_id 必须是合法 UUID' }
  }

  let normalizedText: string | undefined
  const textRaw = obj.text
  if (kind === 'UNPIN') {
    if (textRaw !== undefined && typeof textRaw !== 'string') {
      return { ok: false, reason_code: 'TYPE_MISMATCH', message: 'text 必须是字符串' }
    }
    if (typeof textRaw === 'string') {
      const trimmed = textRaw.trim()
      if (trimmed.length > MAX_CONSTRAINT_TEXT) {
        return { ok: false, reason_code: 'OUT_OF_RANGE', message: `text 不得超过 ${MAX_CONSTRAINT_TEXT} 字` }
      }
      normalizedText = trimmed
    }
  } else {
    if (textRaw === undefined || textRaw === null) {
      return { ok: false, reason_code: 'MISSING_REQUIRED', message: '缺少 text' }
    }
    if (typeof textRaw !== 'string') {
      return { ok: false, reason_code: 'TYPE_MISMATCH', message: 'text 必须是字符串' }
    }
    const trimmed = textRaw.trim()
    if (trimmed.length === 0) {
      return { ok: false, reason_code: 'MISSING_REQUIRED', message: 'text 不能为空' }
    }
    if (trimmed.length > MAX_CONSTRAINT_TEXT) {
      return { ok: false, reason_code: 'OUT_OF_RANGE', message: `text 不得超过 ${MAX_CONSTRAINT_TEXT} 字` }
    }
    normalizedText = trimmed
  }

  let source: ConstraintSource | undefined
  const sourceRaw = obj.source
  if (kind === 'UNPIN') {
    if (sourceRaw !== undefined) {
      if (typeof sourceRaw !== 'string' || !CONSTRAINT_SOURCES.includes(sourceRaw as ConstraintSource)) {
        return { ok: false, reason_code: 'ENUM_INVALID', message: `source 必须是 ${CONSTRAINT_SOURCES.join(' / ')} 之一` }
      }
      source = sourceRaw as ConstraintSource
    }
  } else {
    if (sourceRaw === undefined || sourceRaw === null) {
      return { ok: false, reason_code: 'MISSING_REQUIRED', message: '缺少 source' }
    }
    if (typeof sourceRaw !== 'string' || !CONSTRAINT_SOURCES.includes(sourceRaw as ConstraintSource)) {
      return { ok: false, reason_code: 'ENUM_INVALID', message: `source 必须是 ${CONSTRAINT_SOURCES.join(' / ')} 之一` }
    }
    source = sourceRaw as ConstraintSource
  }

  let interviewId: string | undefined
  const interviewIdRaw = obj.interview_id
  if (kind === 'HANDOFF') {
    if (interviewIdRaw === undefined || interviewIdRaw === null) {
      return { ok: false, reason_code: 'MISSING_REQUIRED', message: 'HANDOFF 必须给 interview_id' }
    }
    if (!isConstraintUuid(interviewIdRaw)) {
      return { ok: false, reason_code: 'ID_NOT_UUID', message: 'interview_id 必须是合法 UUID' }
    }
    interviewId = interviewIdRaw
  } else if (interviewIdRaw !== undefined && interviewIdRaw !== null) {
    if (!isConstraintUuid(interviewIdRaw)) {
      return { ok: false, reason_code: 'ID_NOT_UUID', message: 'interview_id 必须是合法 UUID' }
    }
    interviewId = interviewIdRaw
  }

  return {
    ok: true,
    value: {
      action: kind,
      ...(candidateIdRaw === undefined ? {} : { candidate_id: candidateIdRaw as string }),
      ...(applicationIdRaw === undefined ? {} : { application_id: applicationIdRaw as string }),
      ...(normalizedText === undefined ? {} : { text: normalizedText }),
      ...(source === undefined ? {} : { source }),
      ...(interviewId === undefined ? {} : { interview_id: interviewId }),
    },
  }
}

/**
 * PIN 幂等判定：同 text + 同 source 即视为同一条约束（不重复插入）。
 * 比较前各自 btrim 归一化（与 parse 对齐）。
 */
export function isIdempotentPin(
  existingText: string,
  newText: string,
  existingSource: string,
  newSource: string,
): boolean {
  return existingText.trim() === newText.trim() && existingSource === newSource
}

/** recruitment.candidate_constraint 的一行（全部列）；created_at 用 Date | string。 */
export interface CandidateConstraintRow {
  readonly id: string
  readonly tenant_id: string
  readonly candidate_id: string
  readonly kind: ConstraintKind
  readonly text: string
  readonly source: ConstraintSource
  readonly application_id: string | null
  readonly interview_id: string | null
  readonly created_by_actor_id: string
  readonly created_at: Date | string
  readonly superseded_by_constraint_id: string | null
  readonly record_version: number
}

/** 置顶约束读投影（不吐任何 id）。 */
export interface PinProjection {
  readonly text: string
  readonly source: ConstraintSource
  readonly created_by: string
  readonly created_at: string
}

/** 交接提醒读投影（多一个固定标记，仍不吐 id）。 */
export interface HandoffProjection extends PinProjection {
  readonly from_previous_round: true
}

/** Date | string → ISO-8601 字符串。 */
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * 当前 PIN 行的读投影。
 *
 * 过滤规则：只保留 superseded is null 且 **非墓碑**（text !== UNPIN_TOMBSTONE_TEXT）的行；
 * 排序按 created_at asc、同刻按 id asc；只输出 text/source/created_by/created_at 四字段。
 */
export function toPinProjection(rows: readonly CandidateConstraintRow[]): PinProjection[] {
  return rows
    .filter((row) => row.kind === 'PIN'
      && row.superseded_by_constraint_id === null
      && row.text !== UNPIN_TOMBSTONE_TEXT)
    .slice()
    .sort((a, b) => {
      const ta = iso(a.created_at)
      const tb = iso(b.created_at)
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((row) => ({
      text: row.text,
      source: row.source,
      created_by: row.created_by_actor_id,
      created_at: iso(row.created_at),
    }))
}

/**
 * 当前 HANDOFF 行的读投影（标记 from_previous_round=true）。
 * 过滤/排序与 toPinProjection 同口径，不吐任何 id。
 */
export function toHandoffProjection(rows: readonly CandidateConstraintRow[]): HandoffProjection[] {
  return rows
    .filter((row) => row.kind === 'HANDOFF' && row.superseded_by_constraint_id === null)
    .slice()
    .sort((a, b) => {
      const ta = iso(a.created_at)
      const tb = iso(b.created_at)
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .map((row) => ({
      text: row.text,
      source: row.source,
      created_by: row.created_by_actor_id,
      created_at: iso(row.created_at),
      from_previous_round: true as const,
    }))
}
