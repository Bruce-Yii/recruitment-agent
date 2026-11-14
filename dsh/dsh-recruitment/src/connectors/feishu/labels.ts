// 三维标签（R4）的唯一口径：`provenance` / `trigger` / `connection` 正交，永不压平。
//
// 本文件只有纯函数：不读 env、不发请求、不碰库、不取时钟（`node:crypto` 只做
// 确定性哈希，不是 I/O）。三条硬规则：
//
//   1. **没有连接就没有真实字节**：`connection !== 'CONNECTED'` 时，
//      `provenance` 只能是 `FIXTURE`、`trigger` 只能是 `MANUAL`；调用方硬传
//      `LIVE` → 抛 `LABEL_DISHONEST_LIVE`（TR-S4 / TR-S6）。
//   2. **`LIVE` 只能由证据算出**：`evaluateLiveGate()` 是唯一判定入口，
//      逐项核对证据后给出 `LIVE | BLOCKED`。证据不齐时**返回 BLOCKED 并列出
//      缺哪一项**，不是压成一句「全局 Gate 没开」。任何其它导出函数在任何
//      输入下都不可能凭空返回 `provenance='LIVE'`——这不是防御性编程，是
//      R4 的机检面：Fixture 冒充 LIVE、webhook payload 冒充逐字稿、MANUAL
//      冒充 EVENT 都在这里被拒绝（`contracts/interview/transcript-rules.md`
//      §2.1、§2.2）。
//   3. **回读不一致是失败，不是警告**：`content_sha256` 必须等于用
//      `raw_text` 重新算出的 sha256；`read_receipt_ref` 必须把
//      `@sha256:<64位hex 或前12位>` 绑到同一个哈希上；如果回读对象还带了
//      第二次独立回读的 `reread_sha256`，它也必须逐字相等。任何一处不等都
//      记成违规（`readbackConsistencyViolations()` 可单独取硬矛盾，供
//      适配器 / 工具直接 BLOCKED，而不是降级成 FIXTURE 后照常写库）。
//
// `trigger` 的判定只有一个来源：`contract.ts` 的 `hasEventTriggerEvidence()`，
// 避免「事件算不算事件」出现两份实现。
import { createHash } from 'node:crypto'

import {
  FEISHU_TRANSPORT,
  hasEventTriggerEvidence,
  type FeishuLiveGateState,
} from './contract.ts'

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

/** LIVE 的 provenance_basis 取值（证据齐全时出口回显这一串）。 */
export const LIVE_READBACK_PROVENANCE_BASIS = 'LIVE_READBACK_VERIFIED'

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
  /**
   * 读取回执，形如
   * `lark:minutes+detail:<minute_token>@sha256:<64位小写hex 或前12位>`。
   * 回执必须把 `minute_token` **绑到这次读到的字节的哈希**上（TR-C5）。
   */
  readonly read_receipt_ref?: unknown
  /** 回读时刻，带偏移的 ISO-8601。 */
  readonly fetched_at?: unknown
  /** 原文 sha256，64 位小写 hex。 */
  readonly content_sha256?: unknown
  /**
   * 第二次独立完整回读得到的 sha256（重读校验）。可选，但**只要出现**就必须
   * 是 64 位小写 hex 且与 `content_sha256` 逐字相等：不一致是失败，不是警告。
   */
  readonly reread_sha256?: unknown
  /** 完整性 Gate 结论（TR-C4）。必须**恰好** `true`。 */
  readonly is_complete?: unknown
  /** 原文，非空字符串。 */
  readonly raw_text?: unknown
  /** 触发方式，只收 `EVENT` / `MANUAL`。 */
  readonly trigger?: unknown
}

/** 回执格式：`lark:minutes+detail:<minute_token>@sha256:<64位hex|前12位>`。 */
const READ_RECEIPT_RE = /^lark:minutes\+detail:([^@\s]{1,255})@sha256:([0-9a-f]{64}|[0-9a-f]{12})$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const ISO_WITH_OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * `fetched_at` 是否「带时区偏移的合法 ISO-8601」。
 *
 * 比只看正则更严一格：日历分量必须真实存在（`2026-02-30` 这种会被 V8 自动进位
 * 成 3 月 2 日的日期不算合法），时分秒必须在范围内。偏移由正则保证。
 * @param value - 不可信输入。
 */
export function isIsoTimestampWithOffset(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = ISO_WITH_OFFSET_RE.exec(value)
  if (match === null) return false
  if (!Number.isFinite(Date.parse(value))) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  // 用 UTC 日历反查年月日是否真实存在（越界会进位，回读时不相等）。
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
    && probe.getUTCHours() === hour
    && probe.getUTCMinutes() === minute
    && probe.getUTCSeconds() === second
  )
}

/** 原文 sha256（64 位小写 hex）。传输层与本文件共用这一份实现，避免两份哈希口径。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 解析出来的读取回执。 */
export interface ParsedReadReceipt {
  /** 平台产物标识（妙记 minute_token）。 */
  readonly minute_token: string
  /** 回执里绑定的哈希：12 位（content_sha256 前 12 位）或 64 位全量。 */
  readonly digest: string
  /** 摘要长度（12 / 64）。 */
  readonly digest_length: 12 | 64
  /** 原始字符串（原样保留，便于回溯）。 */
  readonly raw: string
}

/**
 * 解析读取回执。形状不对返回 `null`（不抛异常）。
 * 只认**带内容哈希**的形态：`lark:minutes+detail:<minute_token>@sha256:<hex>`。
 * 旧形态 `...@<revision>` 不再算 LIVE 证据（回执没绑住字节，无法证明读的是同一份）。
 * @param value - 不可信输入。
 */
export function parseReadReceipt(value: unknown): ParsedReadReceipt | null {
  if (typeof value !== 'string') return null
  const match = READ_RECEIPT_RE.exec(value)
  if (match === null) return null
  const digest = match[2] as string
  return {
    minute_token: match[1] as string,
    digest,
    digest_length: digest.length === 64 ? 64 : 12,
    raw: value,
  }
}

/** 从回读对象里取「形状合法」的 content_sha256；不合法返回 null（不猜）。 */
function declaredContentSha(node: TranscriptReadbackLike): string | null {
  return typeof node.content_sha256 === 'string' && SHA256_HEX_RE.test(node.content_sha256)
    ? node.content_sha256
    : null
}

/** 从回读对象里取「形状合法」的 reread_sha256；缺省 / 不合法返回 null（不猜）。 */
function declaredRereadSha(node: TranscriptReadbackLike): string | null {
  return typeof node.reread_sha256 === 'string' && SHA256_HEX_RE.test(node.reread_sha256)
    ? node.reread_sha256
    : null
}

/**
 * 列出「这个回读对象为什么不能算 LIVE」。空数组 = 可以。
 * 纯函数，不抛异常（`isLiveEligible()` / `evaluateLiveGate()` /
 * `buildArtifactLabelsFromReadback()` 共用这一份判定，避免多处口径漂移）。
 *
 * 逐项证据（缺任何一项都不算 LIVE，且会在返回值里点名缺哪一项）：
 *   1. `transport === 'FEISHU_MINUTES_API'`（真实平台通道，不是 FIXTURE）；
 *   2. `read_receipt_ref` 形如 `lark:minutes+detail:<minute_token>@sha256:<64位hex|前12位>`；
 *   3. `content_sha256` 是 64 位小写 hex；
 *   4. **回读哈希一致**：用 `raw_text` 重新算出的 sha256 必须等于 `content_sha256`；
 *      回执里绑定的摘要必须等于 `content_sha256`（64 位全等 / 12 位前缀相等）；
 *      若给了 `reread_sha256`（第二次独立回读），也必须逐字相等；
 *   5. `fetched_at` 是带时区偏移的合法 ISO-8601；
 *   6. `is_complete === true`（分页全部取完，TR-C2/TR-C4）；
 *   7. `raw_text` 非空（没有正文就没有产物，P-2）；
 *   8. `trigger ∈ {EVENT, MANUAL}`。
 * @param readback - 待判定的回读对象。
 * @returns 违规原因列表（人读，中文；顺序稳定）。
 */
export function liveEligibilityViolations(readback: unknown): readonly string[] {
  if (typeof readback !== 'object' || readback === null) return ['回读对象不是对象']
  const node = readback as TranscriptReadbackLike
  const violations: string[] = []

  // ---- 1. 真实平台通道 ------------------------------------------------------
  if (node.transport !== FEISHU_TRANSPORT.api) {
    violations.push(`transport 必须是 ${FEISHU_TRANSPORT.api}（当前 ${String(node.transport)}）：Fixture 与 webhook payload 都不是逐字稿`)
  }

  // ---- 2. 读取回执（绑定 content_sha256）------------------------------------
  const receipt = parseReadReceipt(node.read_receipt_ref)
  if (typeof node.read_receipt_ref !== 'string' || node.read_receipt_ref.trim() === '') {
    violations.push('缺读取回执：read_receipt_ref 必须形如 lark:minutes+detail:<minute_token>@sha256:<64位hex 或前12位>')
  } else if (receipt === null) {
    violations.push('读取回执形状不对：read_receipt_ref 必须形如 lark:minutes+detail:<minute_token>@sha256:<64位hex 或前12位>（回执必须绑定内容哈希，不接受只有 revision 的旧形态）')
  }

  // ---- 3. content_sha256 形态 ----------------------------------------------
  const declared = declaredContentSha(node)
  if (declared === null) {
    violations.push('content_sha256 必须是 64 位小写 hex')
  }

  // ---- 4. 回读哈希一致（失败，不是警告）------------------------------------
  const rawText = typeof node.raw_text === 'string' ? node.raw_text : null
  if (rawText === null || rawText.trim() === '') {
    violations.push('raw_text 必须是非空字符串（没有正文就没有产物，P-2）')
  } else if (declared !== null) {
    const recomputed = sha256Hex(rawText)
    if (recomputed !== declared) {
      violations.push(`回读哈希不一致：content_sha256=${declared}，但用 raw_text 重新读取算出的 sha256=${recomputed}（不一致是失败，不是警告）`)
    }
  }
  if (node.reread_sha256 !== undefined) {
    if (typeof node.reread_sha256 !== 'string' || !SHA256_HEX_RE.test(node.reread_sha256)) {
      violations.push('reread_sha256 必须是 64 位小写 hex（重读校验哈希）')
    } else if (declared !== null && node.reread_sha256 !== declared) {
      violations.push(`重读哈希不一致：reread_sha256=${node.reread_sha256}，但 content_sha256=${declared}（不一致是失败，不是警告）`)
    }
  }
  if (receipt !== null && declared !== null) {
    const expected = receipt.digest_length === 64 ? declared : declared.slice(0, 12)
    if (receipt.digest !== expected) {
      violations.push(`回执哈希与内容不一致：read_receipt_ref 绑定的是 ${receipt.digest}，但 content_sha256=${declared}（回执必须绑定这次读到的字节）`)
    }
  }

  // ---- 5. 时间 --------------------------------------------------------------
  if (!isIsoTimestampWithOffset(node.fetched_at)) {
    violations.push('fetched_at 必须是带偏移的合法 ISO-8601 时间')
  }

  // ---- 6. 完整性 ------------------------------------------------------------
  if (node.is_complete !== true) {
    violations.push('is_complete 必须恰好是 true（分页没取完就不能算完整，TR-C2/TR-C4）')
  }

  // ---- 7. 触发方式 ----------------------------------------------------------
  if (node.trigger !== 'EVENT' && node.trigger !== 'MANUAL') {
    violations.push(`trigger 只能是 EVENT 或 MANUAL（当前 ${String(node.trigger)}）`)
  }
  return violations
}

/**
 * 只列**回读对象自相矛盾**（不一致）的硬错误：`content_sha256` 与 `raw_text`
 * 重算结果不等、`reread_sha256` 与 `content_sha256` 不等、回执摘要与
 * `content_sha256` 不等。空数组 = 没有矛盾。
 *
 * 与 `liveEligibilityViolations()` 的分工：这里是**失败**（适配器 / 工具会
 * `BLOCKED / READBACK_INVALID`，不写任何行），那里是**不能算 LIVE**（可以降级
 * 成 FIXTURE 继续，但必须把缺的证据写出来）。
 * @param readback - 待判定的回读对象。
 */
export function readbackConsistencyViolations(readback: unknown): readonly string[] {
  if (typeof readback !== 'object' || readback === null) return []
  const node = readback as TranscriptReadbackLike
  const violations: string[] = []
  const declared = declaredContentSha(node)
  const reread = declaredRereadSha(node)
  const receipt = parseReadReceipt(node.read_receipt_ref)

  if (declared !== null) {
    if (typeof node.raw_text === 'string' && node.raw_text.trim() !== '') {
      const recomputed = sha256Hex(node.raw_text)
      if (recomputed !== declared) {
        violations.push(`content_sha256=${declared} 与 raw_text 重新计算出的 sha256=${recomputed} 不一致`)
      }
    }
    if (reread !== null && reread !== declared) {
      violations.push(`reread_sha256=${reread} 与 content_sha256=${declared} 不一致`)
    }
    if (receipt !== null) {
      const expected = receipt.digest_length === 64 ? declared : declared.slice(0, 12)
      if (receipt.digest !== expected) {
        violations.push(`read_receipt_ref 绑定的 ${receipt.digest} 与 content_sha256=${declared} 不一致`)
      }
    }
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

/** LIVE 证据项（机器可读的名字，顺序稳定；`describe()` 与测试都引用这一份）。 */
export const LIVE_EVIDENCE_ITEMS = [
  'platform_transport',
  'read_receipt_ref',
  'content_sha256',
  'readback_hash_consistency',
  'fetched_at_with_offset',
  'is_complete',
  'raw_text',
  'trigger',
] as const

/** LIVE 证据项类型。 */
export type LiveEvidenceItem = (typeof LIVE_EVIDENCE_ITEMS)[number]

/** 一次回读的证据快照（不可信输入经校验后的取值；不合法的一律给 null / false）。 */
export interface LiveGateEvidence {
  /** 回读对象声明的通道（原样，便于看出是不是 FIXTURE）。 */
  readonly transport: string | null
  /** 回执里的 minute_token（平台产物标识）；回执形状不对时为 null。 */
  readonly minute_token: string | null
  /** 声明的 content_sha256（形态合法时）。 */
  readonly content_sha256: string | null
  /** 用 raw_text 重新算出的 sha256（重新读取的哈希）。 */
  readonly content_sha256_recomputed: string | null
  /** 第二次独立回读的哈希（回读对象没带就是 null）。 */
  readonly reread_sha256: string | null
  /** 回执里绑定的摘要（没回执 / 形状不对就是 null）。 */
  readonly receipt_digest: string | null
  /** 带偏移的回读时刻（形态合法时）。 */
  readonly fetched_at: string | null
  readonly is_complete: boolean
  readonly raw_text_chars: number
  readonly trigger: string | null
}

/**
 * 抽取证据快照（纯函数，不抛异常）。**只做投影，不做判定**：
 * 判定在 `liveEligibilityViolations()`，两者分开是为了让出口能同时给出
 * 「缺什么」和「实际读到了什么」。
 * @param readback - 待判定的回读对象。
 */
export function liveGateEvidence(readback: unknown): LiveGateEvidence {
  if (typeof readback !== 'object' || readback === null) {
    return {
      transport: null,
      minute_token: null,
      content_sha256: null,
      content_sha256_recomputed: null,
      reread_sha256: null,
      receipt_digest: null,
      fetched_at: null,
      is_complete: false,
      raw_text_chars: 0,
      trigger: null,
    }
  }
  const node = readback as TranscriptReadbackLike
  const receipt = parseReadReceipt(node.read_receipt_ref)
  const rawText = typeof node.raw_text === 'string' ? node.raw_text : null
  return {
    transport: typeof node.transport === 'string' ? node.transport : null,
    minute_token: receipt?.minute_token ?? null,
    content_sha256: declaredContentSha(node),
    content_sha256_recomputed: rawText === null || rawText.trim() === '' ? null : sha256Hex(rawText),
    reread_sha256: declaredRereadSha(node),
    receipt_digest: receipt?.digest ?? null,
    fetched_at: typeof node.fetched_at === 'string' ? node.fetched_at : null,
    is_complete: node.is_complete === true,
    raw_text_chars: rawText === null ? 0 : rawText.length,
    trigger: typeof node.trigger === 'string' ? node.trigger : null,
  }
}

/** Gate 结论：由证据算出，不接受调用方传入。 */
export interface LiveGateDecision {
  /** `LIVE` = 证据全齐；`BLOCKED` = 有违规（见 `violations`）。 */
  readonly gate: FeishuLiveGateState
  /** 该结论对应的三维标签（BLOCKED 时给保守值 FIXTURE/MANUAL/AUTH_REQUIRED）。 */
  readonly labels: ThreeAxisLabels
  /** `LIVE_READBACK_VERIFIED` / `NO_LIVE_READ`。 */
  readonly provenance_basis: ProvenanceBasis
  /** 为什么不是 LIVE（`gate==='LIVE'` 时为空数组）。 */
  readonly violations: readonly string[]
  /** 证据快照（实际读到了什么）。 */
  readonly evidence: LiveGateEvidence
}

/**
 * **LIVE Gate 的唯一判定函数**：把一次回读对象算成 `LIVE | BLOCKED`。
 *
 * 纯函数，不抛异常、不读时钟、不读 env。判定规则只有一份：
 * `liveEligibilityViolations()` 为空 → `LIVE`（`connection='CONNECTED'`、
 * `provenance_basis='LIVE_READBACK_VERIFIED'`）；否则 `BLOCKED`，并把
 * 缺哪一项逐条放进 `violations`（供出口原样透出，不要改写成「全局没开」）。
 * @param readback - 待判定的回读对象（不可信输入）。
 */
export function evaluateLiveGate(readback: unknown): LiveGateDecision {
  const evidence = liveGateEvidence(readback)
  const violations = liveEligibilityViolations(readback)
  if (violations.length === 0) {
    const trigger = (readback as TranscriptReadbackLike).trigger as Trigger
    return {
      gate: 'LIVE',
      labels: { provenance: 'LIVE', trigger, connection: 'CONNECTED' },
      provenance_basis: LIVE_READBACK_PROVENANCE_BASIS,
      violations: [],
      evidence,
    }
  }
  return {
    gate: 'BLOCKED',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' },
    provenance_basis: 'NO_LIVE_READ',
    violations,
    evidence,
  }
}

/**
 * 由**完整回读对象**构造 artifact 级三维标签。这是本包唯一能产出
 * `provenance='LIVE'` 的函数：证据缺一项就抛 `LABEL_DISHONEST_LIVE`
 * （错误 message 里逐条写清缺什么，不做「全局 Gate 没开」这种压平解释）。
 * @param readback - 平台回读对象。
 * @returns `{provenance:'LIVE', trigger, connection:'CONNECTED'}`。
 */
export function buildArtifactLabelsFromReadback(readback: TranscriptReadbackLike): ThreeAxisLabels {
  const decision = evaluateLiveGate(readback)
  if (decision.gate !== 'LIVE') {
    throw dishonestLive(`回读对象不满足 LIVE 条件：${decision.violations.join('；')}`)
  }
  return decision.labels
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
