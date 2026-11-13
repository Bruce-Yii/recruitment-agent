// 三维标签（R4）的唯一口径：`provenance` / `trigger` / `connection` 正交，永不压平。
//
// 本文件只有纯函数：不读 env、不发请求、不碰库、不取时钟。两条硬规则：
//
//   1. **没有连接就没有真实字节**：`connection !== 'CONNECTED'` 时，
//      `provenance` 只能是 `FIXTURE`、`trigger` 只能是 `MANUAL`；调用方硬传
//      `LIVE` → 抛 `LABEL_DISHONEST_LIVE`（TR-S4 / TR-S6）。
//   2. **`LIVE` 只有一个合法入口**：`buildArtifactLabelsFromReadback()`，且
//      回读对象六项证据齐全。其它导出函数在任何输入下都不可能返回
//      `provenance='LIVE'`——这不是防御性编程，是 R4 的机检面：
//      Fixture 冒充 LIVE、webhook payload 冒充逐字稿、MANUAL 冒充 EVENT
//      都在这里被拒绝（`contracts/interview/transcript-rules.md` §2.1、§2.2）。
//
// `trigger` 的判定只有一个来源：`contract.ts` 的 `hasEventTriggerEvidence()`，
// 避免「事件算不算事件」出现两份实现。
import { FEISHU_TRANSPORT, hasEventTriggerEvidence } from './contract.ts'

/** 数据是真的还是造的。 */
export type Provenance = 'LIVE' | 'FIXTURE'

/** 怎么触发的。 */
export type Trigger = 'EVENT' | 'MANUAL'

/** 产品有没有能力自己读外部系统。 */
export type Connection = 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'

/** 三维标签。三个维度同时存在，缺一个就不是标签。 */
export interface ThreeAxisLabels {
  readonly provenance: Provenance
  readonly trigger: Trigger
  readonly connection: Connection
}

/** `LIVE` 的依据：有真实回读，还是根本没有读。 */
export type ProvenanceBasis = 'NO_LIVE_READ' | 'LIVE_READBACK_VERIFIED'

/** 造 `LIVE` 的错误码（message 前缀同值）。 */
export const LABEL_DISHONEST_LIVE = 'LABEL_DISHONEST_LIVE'

/**
 * 造一个「不诚实的 LIVE」错误：message 以 `LABEL_DISHONEST_LIVE: ` 开头，
 * 并在 `code` 上带同一个值（方便调用方与测试按码断言）。
 * @param reason - 为什么不诚实（人读）。
 */
function dishonestLive(reason: string): Error {
  const error = new Error(`${LABEL_DISHONEST_LIVE}: ${reason}`) as Error & { code: typeof LABEL_DISHONEST_LIVE }
  error.name = 'LabelDishonestyError'
  error.code = LABEL_DISHONEST_LIVE
  return error
}

/** `buildConnectorLabels()` 的输入。 */
export interface ConnectorLabelInput {
  /** 已知的连接状态（本骨架只可能给 `NOT_CONNECTED` / `AUTH_REQUIRED`）。 */
  readonly connection: Connection
  /** 调用方想声明的触发方式；无连接时会被强制改成 `MANUAL`。 */
  readonly trigger?: Trigger
  /** 调用方想声明的来源；只要不是完整回读，传 `LIVE` 就抛错。 */
  readonly provenance?: Provenance
}

/** `buildConnectorLabels()` 的输出：标签 + 依据。 */
export interface ConnectorLabelResult {
  readonly labels: ThreeAxisLabels
  readonly provenance_basis: ProvenanceBasis
}

/**
 * 构造 Connector 级三维标签。**永远**不会返回 `provenance='LIVE'`：
 * LIVE 只能由 `buildArtifactLabelsFromReadback()` 的成功路径给出。
 *
 * 规则：
 *   * `provenance === 'LIVE'` → 抛 `LABEL_DISHONEST_LIVE`（连接状态本身不是
 *     LIVE 的依据；有没有真实字节要由回读对象证明）；
 *   * `connection !== 'CONNECTED'` → `provenance='FIXTURE'`、`trigger='MANUAL'`
 *     （无连接 = 没有真实字节，也就不许自称 EVENT，TR-S6）；
 *   * 其余情况 → `provenance='FIXTURE'`，`trigger` 取调用方给的值（默认 MANUAL）。
 * @param input - 连接状态与可选的 trigger / provenance。
 * @returns 标签与 `provenance_basis`（恒 `NO_LIVE_READ`）。
 */
export function buildConnectorLabels(input: ConnectorLabelInput): ConnectorLabelResult {
  if (input.provenance === 'LIVE') {
    throw dishonestLive(
      'Connector 级标签不接受 provenance=LIVE：LIVE 只能来自完整回读对象（buildArtifactLabelsFromReadback），连接状态本身不构成 LIVE 依据。',
    )
  }
  const trigger: Trigger = input.connection === 'CONNECTED' ? (input.trigger ?? 'MANUAL') : 'MANUAL'
  return {
    labels: { provenance: 'FIXTURE', trigger, connection: input.connection },
    provenance_basis: 'NO_LIVE_READ',
  }
}

/** 回读对象的形状。全部字段都是不可信输入，逐项校验。 */
export interface TranscriptReadbackLike {
  /** `FEISHU_MINUTES_API` 才可能是平台回读；`FIXTURE` / `WEBHOOK_PAYLOAD` 一律不行。 */
  readonly transport?: unknown
  /** 读取回执，形如 `lark:minutes+detail:<token>@<revision>`（TR-C5 / T1）。 */
  readonly read_receipt_ref?: unknown
  /** 回读时刻，带偏移的 ISO-8601。 */
  readonly fetched_at?: unknown
  /** 原文 sha256，64 位小写 hex。 */
  readonly content_sha256?: unknown
  /** 完整性 Gate 结论（TR-C4）。必须**恰好** `true`。 */
  readonly is_complete?: unknown
  /** 原文，非空字符串。 */
  readonly raw_text?: unknown
  /** 触发方式，只收 `EVENT` / `MANUAL`。 */
  readonly trigger?: unknown
}

const READ_RECEIPT_RE = /^lark:minutes\+detail:/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * 列出「这个回读对象为什么不能算 LIVE」。空数组 = 可以。
 * 纯函数，不抛异常（`isLiveEligible()` 与 `buildArtifactLabelsFromReadback()`
 * 共用这一份判定，避免两处口径漂移）。
 * @param readback - 待判定的回读对象。
 * @returns 违规原因列表（人读，中文）。
 */
export function liveEligibilityViolations(readback: unknown): readonly string[] {
  if (typeof readback !== 'object' || readback === null) return ['回读对象不是对象']
  const node = readback as TranscriptReadbackLike
  const violations: string[] = []
  if (node.transport !== FEISHU_TRANSPORT.api) {
    violations.push(`transport 必须是 ${FEISHU_TRANSPORT.api}（当前 ${String(node.transport)}）：Fixture 与 webhook payload 都不是逐字稿`)
  }
  if (typeof node.read_receipt_ref !== 'string' || !READ_RECEIPT_RE.test(node.read_receipt_ref)) {
    violations.push('缺读取回执：read_receipt_ref 必须形如 lark:minutes+detail:<minute_token>@<revision>')
  }
  if (typeof node.fetched_at !== 'string' || !ISO_WITH_OFFSET_RE.test(node.fetched_at) || !Number.isFinite(Date.parse(node.fetched_at))) {
    violations.push('fetched_at 必须是带偏移的合法 ISO-8601 时间')
  }
  if (typeof node.content_sha256 !== 'string' || !SHA256_HEX_RE.test(node.content_sha256)) {
    violations.push('content_sha256 必须是 64 位小写 hex')
  }
  if (node.is_complete !== true) {
    violations.push('is_complete 必须恰好是 true（分页没取完就不能算完整，TR-C2/TR-C4）')
  }
  if (typeof node.raw_text !== 'string' || node.raw_text.trim() === '') {
    violations.push('raw_text 必须是非空字符串（没有正文就没有产物，P-2）')
  }
  if (node.trigger !== 'EVENT' && node.trigger !== 'MANUAL') {
    violations.push(`trigger 只能是 EVENT 或 MANUAL（当前 ${String(node.trigger)}）`)
  }
  return violations
}

/**
 * 这个回读对象是否足以支撑 `provenance='LIVE'`（布尔纯函数，不抛异常）。
 * @param readback - 待判定的回读对象。
 */
export function isLiveEligible(readback: unknown): boolean {
  return liveEligibilityViolations(readback).length === 0
}

/**
 * 由**完整回读对象**构造 artifact 级三维标签。这是本包唯一能产出
 * `provenance='LIVE'` 的函数：六项证据缺一项就抛 `LABEL_DISHONEST_LIVE`。
 *
 * 证据清单（全部必须成立）：`transport='FEISHU_MINUTES_API'`、
 * `read_receipt_ref` 匹配 `/^lark:minutes\+detail:/`、`fetched_at` 合法
 * ISO-8601、`content_sha256` 64 位小写 hex、`is_complete===true`、`raw_text`
 * 非空、`trigger ∈ {EVENT, MANUAL}`。
 * @param readback - 平台回读对象。
 * @returns `{provenance:'LIVE', trigger, connection:'CONNECTED'}`。
 */
export function buildArtifactLabelsFromReadback(readback: TranscriptReadbackLike): ThreeAxisLabels {
  const violations = liveEligibilityViolations(readback)
  if (violations.length > 0) {
    throw dishonestLive(`回读对象不满足 LIVE 条件：${violations.join('；')}`)
  }
  return { provenance: 'LIVE', trigger: readback.trigger as Trigger, connection: 'CONNECTED' }
}

/** 可作为触发证据的事件形状（不可信输入）。 */
export interface ConnectorEventLike {
  /** 只有 `WEBHOOK_EVENT` 才可能算事件触发。 */
  readonly kind?: unknown
  /** 验源结果：必须**恰好** `true`。 */
  readonly verified?: unknown
  /** 平台事件唯一 ID：必须非空字符串。 */
  readonly provider_event_id?: unknown
  /** 自称「请求体就是逐字稿」的载荷；出现即按 MANUAL 处理，不得当事件证据。 */
  readonly request_body_is_transcript?: unknown
}

/**
 * webhook 请求体**不是**逐字稿（TR-S7）。常量，恒 false。
 * 任何实现都不得把 `event_inbox.payload` 当正文；正文只能来自回读。
 */
export const REQUEST_BODY_IS_TRANSCRIPT = false

/**
 * 由事件推导 `trigger`：只有 `kind='WEBHOOK_EVENT'` **且** `verified===true`
 * **且** `provider_event_id` 非空 → `EVENT`，否则 `MANUAL`。
 * 载荷自称「就是逐字稿」时一律 `MANUAL`（那不是触发证据，是自我声明）。
 * @param event - 事件信封（不可信输入）。
 * @returns `'EVENT'` 或 `'MANUAL'`。
 */
export function triggerModeForEvent(event: ConnectorEventLike | null | undefined): Trigger {
  if (typeof event === 'object' && event !== null && event.request_body_is_transcript === true) {
    return 'MANUAL'
  }
  return hasEventTriggerEvidence(event) ? 'EVENT' : 'MANUAL'
}
