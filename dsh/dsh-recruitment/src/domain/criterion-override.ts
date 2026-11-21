// 人对 AI 的 rubric-criterion 判定的**追加式覆盖**——纯函数层（无 I/O）。
//
// 业务规则（D-… / 本轮裁决）：
//   * AI 原判定是历史事实，人的覆盖是**另一条**事实，不改写 AI 的原值。
//   * human_state 三态：PRESENT（有对应）/ ABSENT（没有对应）/ UNREADABLE（读不出来）。
//   * 模型（Agent）永远不能传服务端派生字段（actor_id / tenant_id / 哈希 / 版本 / id），
//     以防它伪造责任人或绕过确认。这里在参数解析阶段 fail-closed 拒绝。
//   * confirmation_text 只用于计算 sha256（原文不落库），hash 合同是
//     `sha256(utf8(text))` 的小写 hex（64 位），**不是** decision-record 的结构化 preimage hash。
import { createHash } from 'node:crypto'

import { isUuid } from '../tools/contract.ts'

/** 人的三态判定（有对应 / 没有对应 / 读不出来）。 */
export type HumanState = 'PRESENT' | 'ABSENT' | 'UNREADABLE'

/** human_state 的闭集（顺序固定，测试按此断言不许悄悄扩集）。 */
export const HUMAN_STATES: readonly HumanState[] = ['PRESENT', 'ABSENT', 'UNREADABLE']

/** 服务端派生字段：模型传入即拒绝（reason_code = SERVER_DERIVED_REJECTED）。 */
const SERVER_DERIVED_KEYS: readonly string[] = [
  'actor_id', 'tenant_id', 'confirmation_text_sha256', 'confirmation_method', 'record_version', 'id',
]

/** 一次人覆盖的已校验入参（不含任何服务端派生字段）。 */
export interface CriterionOverrideInput {
  readonly application_id: string
  readonly criterion_key: string
  readonly human_state: HumanState
  /** 可选；非空时不许超过 2000 字（与 DB CHECK 对齐）。 */
  readonly note?: string
  /** 人的确认话术原文；只用于算 sha256，不落库。 */
  readonly confirmation_text: string
}

/** 成功结果。 */
export interface ParseOk {
  readonly ok: true
  readonly value: CriterionOverrideInput
}

/** 失败结果：reason_code 是稳定机检码，message 给人看。 */
export interface ParseErr {
  readonly ok: false
  readonly reason_code: string
  readonly message: string
}

export type ParseResult = ParseOk | ParseErr

/**
 * 校验 Agent 传入的覆盖参数。
 *
 * 检查顺序固定（便于测试与错误码稳定）：
 *   1. 必须是非 null 的普通对象（数组也算失败）；
 *   2. 服务端派生字段出现即 SERVER_DERIVED_REJECTED；
 *   3. application_id 必须是合法 UUID（INVALID_ARGS）；
 *   4. criterion_key 必须是 1..200 字的非空字符串（INVALID_ARGS）；
 *   5. human_state 必须在 HUMAN_STATES 闭集（INVALID_HUMAN_STATE）；
 *   6. note 若给了必须是字符串且 <= 2000 字（NOTE_TOO_LONG / INVALID_ARGS）；
 *   7. confirmation_text 必须是非空字符串（缺 → MISSING_CONFIRMATION_TEXT，
 *      其它非法 → INVALID_CONFIRMATION_TEXT）。
 *
 * 未知但非业务语义的额外键（如 trace_id）**不拒绝**；
 * 只有 SERVER_DERIVED_KEYS 里的键才拒绝。
 * @param raw - Agent 传来的原始 args 对象。
 */
export function parseCriterionOverrideArgs(raw: unknown): ParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason_code: 'INVALID_ARGS', message: '参数必须是一个对象' }
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

  const applicationId = obj.application_id
  if (typeof applicationId !== 'string' || !isUuid(applicationId)) {
    return { ok: false, reason_code: 'INVALID_ARGS', message: 'application_id 必须是合法 UUID' }
  }

  const criterionKey = obj.criterion_key
  if (typeof criterionKey !== 'string' || criterionKey.trim().length < 1 || criterionKey.length > 200) {
    return { ok: false, reason_code: 'INVALID_ARGS', message: 'criterion_key 必须是 1..200 字的非空字符串' }
  }

  const humanState = obj.human_state
  if (typeof humanState !== 'string' || !HUMAN_STATES.includes(humanState as HumanState)) {
    return {
      ok: false,
      reason_code: 'INVALID_HUMAN_STATE',
      message: `human_state 必须是 ${HUMAN_STATES.join(' / ')} 之一`,
    }
  }

  let note: string | undefined
  if (obj.note !== undefined) {
    if (typeof obj.note !== 'string') {
      return { ok: false, reason_code: 'INVALID_ARGS', message: 'note 必须是字符串' }
    }
    if (obj.note.length > 2000) {
      return { ok: false, reason_code: 'NOTE_TOO_LONG', message: 'note 不得超过 2000 字' }
    }
    note = obj.note
  }

  const confirmationText = obj.confirmation_text
  if (confirmationText === undefined) {
    return { ok: false, reason_code: 'MISSING_CONFIRMATION_TEXT', message: '缺少 confirmation_text' }
  }
  if (typeof confirmationText !== 'string' || confirmationText.length === 0) {
    return { ok: false, reason_code: 'INVALID_CONFIRMATION_TEXT', message: 'confirmation_text 必须是非空字符串' }
  }

  return {
    ok: true,
    value: {
      application_id: applicationId,
      criterion_key: criterionKey,
      human_state: humanState as HumanState,
      ...(note === undefined ? {} : { note }),
      confirmation_text: confirmationText,
    },
  }
}

/**
 * `sha256(text)` 的**原始 UTF-8 字节**摘要，小写 hex（64 位）。
 *
 * 注意：这不是 decision-record 的结构化 preimage hash —— 覆盖确认只承诺"人说了这句话"，
 * 原文在会话/事件里，不在此表。已知向量：sha256('abc') =
 * `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`。
 */
export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 有效判定 = 人覆盖优先，否则 AI 原判定，都没有则 null。
 * 纯函数：不改写任何入参。
 */
export function effectiveState(
  aiState: string | null | undefined,
  humanState: HumanState | null | undefined,
): string | null {
  if (humanState !== null && humanState !== undefined) return humanState
  if (aiState !== null && aiState !== undefined) return aiState
  return null
}

/**
 * 「同判定 + 同 note」判定（幂等用的 note-only 版本）。
 *
 * 为什么比较 note：`note` 是人给出的理由，改理由是一次新覆盖（即使三态相同），
 * 所以不能只看 human_state。**确认文本不在这里比**——它的 sha256 由调用方在拿到
 * confirmation_text 后单独比（本函数只拿得到 note，拿不到原文）。
 * null / undefined 统一归一化成空串（''），与 DB 里 note 可为 NULL 对齐。
 */
export function isIdempotentSameState(
  currentHumanState: HumanState | null | undefined,
  nextHumanState: HumanState,
  currentNote?: string | null,
  nextNote?: string | null,
): boolean {
  const norm = (value: string | null | undefined): string => value ?? ''
  return currentHumanState === nextHumanState && norm(currentNote) === norm(nextNote)
}
