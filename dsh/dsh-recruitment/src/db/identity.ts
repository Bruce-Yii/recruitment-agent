// 身份解析（S7 / S6 共用）：归一化 + 强标识匹配 + 存活档解析。
//
// 规则出处：`contracts/identity/identity-resolution-rules.md`（下称 IR）。
// 但**本 lane 的实现口径只保留三条**（`docs/16-design-rationale.md` §8 的
// 「D-46→D-52 身份规则简化到三条」+ 任务口径）：
//
//   1. 只有 phone / email 的**规范化后精确相等**才产生自动关联（IR-N1 / IR-N2 / IR-G1）。
//   2. **姓名不参与判定**：不归一化姓名、不比姓名、不为姓名差异建人工队列
//      （`docs/16 §7 坑 1/坑 2`）。所以 IR 的 D1/D5/D7/D12/D13 里依赖
//      `norm_name` 的分支在本实现里**不启用**；命中 ≥2 条时一律 fail-closed。
//   3. **读不出 ≠ 没有**：`state != present`（或来源不可自动）时，既不得判"新人"
//      也不得判"重复"——返回结构化拒绝，交人工（IR-G2/G3、`docs/16 §7 坑 2`）。
//
// 归一化**只进比较键**，绝不回写原文（IR-N5 / IR-G7；`doc11 §2 A3`）。
//
// D-110（2026-11-15 裁决）——证据闸门只管"可复核"，不管"有没有坐标"：
//   三条件同时成立才可自动通过：① 源文件字节级 sha256 独立重算一致；② 定位器解析到
//   原文唯一位置（PDF page+bbox / DOCX part+paragraph|table_row / RTF paragraph /
//   纯文本 line+offset）；③ quote 在定位范围内逐字命中（只允许换行/空白/断连字符
//   归一化，禁止语义匹配）。多处命中 = 歧义 → 转人工，**禁止取第一条**。
//   每条证据记录必须带 `locator_kind` + `verification_method`；无坐标格式（RTF）
//   **不得仅因缺 bbox 拒收**。
//   真正的三条件实现是 `src/document/evidence/locator.ts::verifyEvidence`；本文件
//   只做 converter 字段证据 → 证据项的投影与「字段整体 fail-closed」的闸门判定。
import type {
  EvidenceContextResult,
  EvidenceGateContext,
} from '../document/evidence/converter-adapter.ts'
import {
  isEvidenceLocator,
  verifyEvidence,
  type EvidenceLocator,
  type EvidenceRejectionCode,
  type LocatorKind,
  type VerificationMethod,
  type VerifiedEvidence,
} from '../document/evidence/locator.ts'
import type { DatabaseClient } from './pool.ts'

/** 比较键来源字段。 */
export type StrongIdField = 'phone' | 'email'

/** 一个可用作比较键的强标识（已过 `AUTO_OK` 闸门）。 */
export interface StrongId {
  readonly field: StrongIdField
  /** 原件里的原文（只用于审计，不进比较）。 */
  readonly raw: string
  /** 规范化后的比较键（写库时**必须**写这个值，IR-N5）。 */
  readonly norm: string
  /** 裸数字且无国际前缀 ⇒ true，此时**不得**单独作为自动依据（IR-N4）。 */
  readonly region_ambiguous: boolean
  /** 承载该值的块来源（`native_text` / `ocr_title` / `agent_read` / `unknown`）。 */
  readonly provenance: string
  /** 块级证据坐标（page / bbox / block / quote）。 */
  readonly evidence: readonly IdEvidence[]
}

/** 一条块级证据。 */
export interface IdEvidence {
  readonly page: number
  readonly bbox: readonly number[]
  readonly block: number
  readonly quote: string
  /**
   * D-110 定位器类型。**运行时总是赋值**（本文件产出的每一条证据都由两条路径之一写死）；
   * 类型上保持 optional 只为兼容其它文件里的旧对象字面量（如 `application-intake.ts` 的
   * 弱提示投影、既有测试的 `PHONE_ID` 字面量）——这些旧字面量不参与证据闸门，
   * 不该因为新增字段而被迫改动（改它们超出本 lane 写范围）。
   */
  readonly locator_kind?: LocatorKind
  /**
   * 验证方式。`LEGACY_BBOX_SHAPE_ONLY` = 旧路径只做 page/bbox 形状校验，
   * **不等于** D-110 三条件已验证（见 {@link toEvidence} 的兼容分派与 REPORT-A 债务条）。
   */
  readonly verification_method?: VerificationMethod | 'LEGACY_BBOX_SHAPE_ONLY'
  /** D-110 定位器（通过三条件核验时就是唯一位置；旧路径为 page+bbox 反推）。 */
  readonly locator?: EvidenceLocator
  /** 已核验的源文件字节 sha256；旧形状路径没有核验，故不填（不冒充已验证）。 */
  readonly source_sha256?: string
}

/** 身份观察结果：要么拿到可用强标识，要么带拒绝原因。 */
export interface IdentityObservation {
  readonly strong: readonly StrongId[]
  /** 不可自动的字段及原因（ordering 与 converter 的 `fields` 一致）。 */
  readonly blocked: readonly {
    readonly field: string
    readonly reason: string
    /**
     * 结构化细节（D-110 证据拒绝时带 `reason_code` / 候选 locator 等；
     * 旧路径不填）。类型 optional：既有调用方只读 field/reason。
     */
    readonly detail?: Readonly<Record<string, unknown>>
  }[]
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE_RE = /^\+?[0-9]{5,20}$/
const MOBILE_CN_RE = /^1[3-9]\d{9}$/
/** 零宽与不可见字符（IR-N1 ①）。 */
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g

/**
 * IR-N1 `norm_email`：去空白/零宽 → 取 `显示名 <a@b>` 的尖括号内 → 小写 →
 * 必须是 `local@domain.tld` 且**等于自身小写**。不做 Gmail 点号折叠、不做 `+tag` 折叠。
 * @param raw - 原件里的字符串（可为 `undefined`）。
 * @returns 规范形，或 `null`（格式不通过 = unreadable，不是 absent）。
 */
export function normEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.replace(INVISIBLE_RE, '').trim()
  const angled = /<([^<>]+)>/.exec(value)
  if (angled !== null && angled[1] !== undefined) value = angled[1].trim()
  const lower = value.toLowerCase()
  if (!EMAIL_RE.test(lower)) return null
  if (lower !== value.trim().toLowerCase()) return null
  return lower
}

/**
 * IR-N2 `norm_phone`：删分隔符 → 去前导 `00` → 去国情码 `86`（仅当剩余是国内手机号）
 * → 国内手机加 `+86` → 否则带显式国际前缀加 `+` → 否则裸数字且 `region_ambiguous=true`。
 * @param raw - 原件里的字符串。
 * @returns `{norm, region_ambiguous}`，或 `null`（格式不通过）。
 */
export function normPhone(
  raw: string | null | undefined,
): { norm: string; region_ambiguous: boolean } | null {
  if (typeof raw !== 'string') return null
  let digits = raw.replace(/[\s\-().·/]/g, '').replace(INVISIBLE_RE, '').trim()
  if (digits === '') return null
  const hadInternationalPrefix = digits.startsWith('+') || digits.startsWith('00')
  if (digits.startsWith('00')) digits = digits.slice(2)
  else if (digits.startsWith('+')) digits = digits.slice(1)
  if (digits.startsWith('86') && MOBILE_CN_RE.test(digits.slice(2))) digits = digits.slice(2)
  if (MOBILE_CN_RE.test(digits)) return { norm: `+86${digits}`, region_ambiguous: false }
  if (hadInternationalPrefix) {
    const plus = `+${digits}`
    return PHONE_RE.test(plus) ? { norm: plus, region_ambiguous: false } : null
  }
  // 裸数字：可能是本地固话，也可能只是没写区号。只能进人工复核（IR-N4）。
  return PHONE_RE.test(digits) ? { norm: digits, region_ambiguous: true } : null
}

/** converter 的字段三态形状（只声明本文件用到的键）。 */
export interface ConverterFieldEntry {
  readonly state?: string
  readonly value?: string | null
  readonly provenance?: string
  readonly reason?: string
  readonly evidence?: readonly {
    readonly page?: number
    readonly bbox?: readonly number[]
    readonly block?: number
    readonly text?: string
    /** D-110：证据项自带的定位器（优先于由 page/bbox/block 反推）。 */
    readonly locator?: EvidenceLocator
    /** D-110：引用的原文；缺省依次回退 `entry.value` / `item.text`。 */
    readonly quote?: string
    /** DOCX 段落 / RTF 段落序号（0-based）。 */
    readonly paragraph?: number
    /** DOCX 部件名（如 `word/document.xml`）。 */
    readonly part?: string
    /** DOCX 表号 / 行号（0-based）。 */
    readonly table_id?: number
    readonly row?: number
    /** 纯文本行（1-based）与行内偏移（0-based）。 */
    readonly line?: number
    readonly offset?: number
  }[]
}

/** 一个 converter 证据项的别名（避免在签名里重复长类型）。 */
type ConverterEvidenceItem = NonNullable<ConverterFieldEntry['evidence']>[number]

/** 证据闸门模式：未给上下文（旧行为）/ 上下文可用 / 源不可用（结构化拒绝）。 */
type EvidenceGate =
  | { readonly kind: 'none' }
  | { readonly kind: 'verified'; readonly context: EvidenceGateContext }
  | { readonly kind: 'unavailable'; readonly reason_code: string; readonly message: string }

/** 一个字段的证据投影结果：要么得到证据，要么整字段被拒（fail-closed）。 */
interface EvidenceOutcome {
  readonly evidence: readonly IdEvidence[]
  readonly rejection?: {
    readonly reason: string
    readonly detail: Readonly<Record<string, unknown>>
  }
}

/** 证据拒绝码 → 身份闸门的 blocked reason（映射写死，见任务/REPORT-A 的对照表）。 */
const EVIDENCE_REASON_BY_CODE: Readonly<Record<EvidenceRejectionCode, string>> = {
  SHA256_MISMATCH: 'evidence_sha256_mismatch',
  SOURCE_EMPTY: 'evidence_source_unavailable',
  SOURCE_UNREADABLE: 'evidence_source_unavailable',
  QUOTE_EMPTY: 'evidence_quote_missing',
  LOCATOR_NOT_FOUND: 'evidence_locator_not_found',
  LOCATOR_AMBIGUOUS: 'evidence_locator_ambiguous',
  QUOTE_NOT_FOUND: 'evidence_quote_not_found',
  QUOTE_AMBIGUOUS: 'evidence_quote_ambiguous',
}

/** 由证据项反推定位器的结果。 */
type DerivedLocator =
  | { readonly kind: 'locator'; readonly locator: EvidenceLocator }
  | { readonly kind: 'quote_search' }
  | { readonly kind: 'invalid' }

/**
 * 证据项 → 定位器（D-110 分派顺序）：
 *   1. `item.locator`（显式给出；畸形 → invalid，fail-closed）；
 *   2. `item.block` 是有效下标且 `context.blocks[block]` 存在 → 用该块的 locator
 *      （RTF 就是这样：converter 证据只给块号，块号 → rtf_paragraph）；
 *   3. `item.paragraph` → `rtf_paragraph`（page 数字则带上；RTF 无 bbox 的正路）；
 *   4. `item.line` + `item.offset` → `text_line_offset`；
 *   5. 都没有 → `quote_search`（交给 verifyEvidence 按 quote 全文唯一命中反推）。
 *
 * 注意：合格 `page>=1 + bbox 四元组` 的证据项在进入本函数前已走旧形状路径，
 * 所以这里不再生成 `pdf_page_bbox`（见 {@link toEvidence}）。
 */
function deriveLocator(item: ConverterEvidenceItem, context: EvidenceGateContext): DerivedLocator {
  if (item.locator !== undefined) {
    return isEvidenceLocator(item.locator)
      ? { kind: 'locator', locator: item.locator }
      : { kind: 'invalid' }
  }
  const block = item.block
  if (typeof block === 'number' && Number.isInteger(block) && block >= 0 && block < context.blocks.length) {
    const blockLocator = context.blocks[block]?.locator
    return blockLocator === undefined
      ? { kind: 'quote_search' }
      : { kind: 'locator', locator: blockLocator }
  }
  const paragraph = item.paragraph
  if (typeof paragraph === 'number' && Number.isInteger(paragraph) && paragraph >= 0) {
    const page = typeof item.page === 'number' && Number.isInteger(item.page) && item.page >= 1
      ? item.page
      : undefined
    return {
      kind: 'locator',
      locator: page === undefined
        ? { kind: 'rtf_paragraph', paragraph }
        : { kind: 'rtf_paragraph', paragraph, page },
    }
  }
  const line = item.line
  const offset = item.offset
  if (
    typeof line === 'number' && Number.isInteger(line) && line >= 1 &&
    typeof offset === 'number' && Number.isInteger(offset) && offset >= 0
  ) {
    return { kind: 'locator', locator: { kind: 'text_line_offset', line, offset } }
  }
  return { kind: 'quote_search' }
}

/** 取证据项的引用原文：`item.quote ?? entry.value ?? item.text`（顺序固定，空串不跳过）。 */
function quoteOf(entry: ConverterFieldEntry | undefined, item: ConverterEvidenceItem): string {
  const quote = item.quote ?? entry?.value ?? item.text
  return typeof quote === 'string' ? quote : ''
}

/** 通过三条件核验的证据项 → 落库用 IdEvidence（page/bbox/block 由 locator 反推）。 */
function verifiedToIdEvidence(
  verified: VerifiedEvidence,
  item: ConverterEvidenceItem,
): IdEvidence {
  const locator = verified.locator
  let page = 0
  let bbox: readonly number[] = []
  if (locator.kind === 'pdf_page_bbox') {
    page = locator.page
    bbox = [...locator.bbox]
  } else if (locator.kind === 'rtf_paragraph' && typeof locator.page === 'number') {
    // RTF：page 只在读取器真的给出时存在；无 page → 0（不猜），bbox 恒为空数组。
    page = locator.page
  }
  return {
    page,
    bbox,
    block: typeof item.block === 'number' ? item.block : -1,
    quote: verified.quote,
    locator_kind: verified.locator_kind,
    verification_method: verified.verification_method,
    locator,
    source_sha256: verified.source_sha256,
  }
}

/**
 * converter 字段证据 → `IdEvidence[]`（D-110 三条件 + 兼容分派）。
 *
 * **兼容分派（owner 2026-11-15 复核指令，写进 REPORT-A 的债务条）**：
 * 既有集成测试（`intake-identity-gate.test.ts` / `intake.test.ts` 等）会手工构造
 * converter 输出：`meta.source_sha256` 是随机 64 hex（与构造的"文件"字节不一致），
 * evidence 是 PDF 形状的 `page+bbox+block+text`。这些测试不在本 lane 写范围、断言不能改。
 * 因此：
 *   1. `page>=1` 且 bbox 是 4 个有限数的证据项 → **旧形状路径**（与改动前逐字一致）：
 *      只做形状校验，`verification_method:'LEGACY_BBOX_SHAPE_ONLY'`，**不做 sha/quote 核验**。
 *      这是已知债务：S6 路径的 PDF 三条件升级另立任务（locator API 本身已完整，见
 *      `test/unit/evidence-locator.test.ts` 的 PDF 正负例）。
 *   2. 非 bbox 证据项（RTF paragraph / 纯文本 / 由 block 索引映射出的 locator）：
 *      给了 context → 走 `verifyEvidence` 三条件；没给 context → 与旧行为一致，
 *      该证据项不产生证据（字段最终 `evidence_missing`，fail-closed）。
 *   3. context 是 `{ok:false}`（源不可读/空/缺 sha）→ 非 bbox 证据字段整字段 blocked
 *      `evidence_source_unavailable`；bbox 证据字段仍走旧路径（否则会误伤上面那批测试）。
 *   4. **任一证据项被拒 → 该字段整体 blocked**（fail-closed，不静默丢单条、不保留
 *      "另一条看起来还行"的证据）。
 *
 * @param entry - converter 字段条目。
 * @param gate - 证据闸门模式。
 * @returns 证据投影结果（含拒绝原因）。
 */
function toEvidence(entry: ConverterFieldEntry | undefined, gate: EvidenceGate): EvidenceOutcome {
  const out: IdEvidence[] = []
  for (const item of entry?.evidence ?? []) {
    const page = typeof item.page === 'number' ? item.page : 0
    const bbox = (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : Number.NaN))
    const block = typeof item.block === 'number' ? item.block : -1
    const bboxOk = bbox.length === 4 && bbox.every((n) => Number.isFinite(n))

    // (1) 合格 page+bbox：旧形状路径（与改动前逐字一致 + 标注证据种类）。
    if (page >= 1 && bboxOk) {
      const quote = typeof item.text === 'string' ? item.text : ''
      if (quote !== '') {
        out.push({
          page,
          bbox,
          block,
          quote,
          locator_kind: 'pdf_page_bbox',
          verification_method: 'LEGACY_BBOX_SHAPE_ONLY',
          locator: {
            kind: 'pdf_page_bbox',
            page,
            bbox: [bbox[0] as number, bbox[1] as number, bbox[2] as number, bbox[3] as number],
          },
        })
      }
      continue
    }

    // (2) 非 bbox 证据项：没有 context → 保持旧行为（不产生证据）。
    if (gate.kind === 'none') continue
    // (3) 源不可用 → 非 bbox 证据字段 fail-closed。
    if (gate.kind === 'unavailable') {
      return {
        evidence: out,
        rejection: {
          reason: 'evidence_source_unavailable',
          detail: { reason_code: gate.reason_code, message: gate.message },
        },
      }
    }

    // (4) 有 context：定位器反推 + 三条件核验。
    const derived = deriveLocator(item, gate.context)
    if (derived.kind === 'invalid') {
      return {
        evidence: out,
        rejection: {
          reason: 'evidence_locator_not_found',
          detail: {
            reason_code: 'LOCATOR_NOT_FOUND',
            message: 'evidence item carries a malformed locator; refusing to guess a position',
          },
        },
      }
    }
    const quote = quoteOf(entry, item)
    const verified = derived.kind === 'locator'
      ? verifyEvidence(gate.context, { locator: derived.locator, quote })
      : verifyEvidence(gate.context, { quote })
    if (verified.ok === false) {
      return {
        evidence: out,
        rejection: {
          reason: EVIDENCE_REASON_BY_CODE[verified.reason_code],
          detail: {
            reason_code: verified.reason_code,
            requires_human: verified.requires_human,
            ...verified.detail,
          },
        },
      }
    }
    out.push(verifiedToIdEvidence(verified, item))
  }
  return { evidence: out }
}

/** 把可选的第三参（上下文 / 上下文构造结果 / 未给）规范化成内部闸门模式。 */
function evidenceGateOf(
  context: EvidenceGateContext | EvidenceContextResult | undefined,
): EvidenceGate {
  if (context === undefined) return { kind: 'none' }
  if ('ok' in context) {
    if (context.ok === false) {
      return {
        kind: 'unavailable',
        reason_code: context.reason_code,
        message: context.message,
      }
    }
    return { kind: 'verified', context: context.context }
  }
  return { kind: 'verified', context }
}

/**
 * 把 converter 的 `fields` + `screening` 投影成「可自动匹配的强标识」集合。
 *
 * `AUTO_OK` 判定（IR-G1，本实现对可机检部分逐条落地）：
 *   `state='present'` ∧ `provenance='native_text'` ∧ 归一化成功 ∧ **证据通过闸门**
 *   ∧ converter 把该字段列进 `screening.identity_merge_eligible`（平台噪声等已剔除）。
 *
 * 证据闸门二选一（D-110）：
 *   * 传了 `context`（`EvidenceGateContext` 或其构造结果 `EvidenceContextResult`）：
 *     **非 bbox 证据**（RTF paragraph / 纯文本 / 由块号映射出的 locator）走
 *     `verifyEvidence` 三条件（sha256 独立重算 + 定位唯一 + quote 逐字命中），
 *     歧义一律拒绝、不取第一条；源不可读/空/缺 sha → 非 bbox 证据字段 blocked
 *     `evidence_source_unavailable`。**合格 page+bbox 证据仍走旧形状路径**
 *     （兼容分派，见 {@link toEvidence}）；任一证据项被拒 → 该字段整体 blocked。
 *   * 没传 `context`：维持历史行为（只有 page+bbox 齐全的证据才被收下），
 *     并给这些证据标 `verification_method:'LEGACY_BBOX_SHAPE_ONLY'`——它只做了形状校验，
 *     **不等于** D-110 三条件已验证，下游可按证据强度区分（这是本 lane 明确记录的债务：
 *     S6 的 PDF 路径三条件升级另立任务；定位器 API 本身已完整实现）。
 *
 * @param fields - converter 输出的 `fields`。
 * @param identityMergeEligible - converter 输出的 `screening.identity_merge_eligible`。
 * @param context - 可选证据闸门上下文（由 `evidenceContextFromConverter()` 构造）；
 *   省略时行为与改动前一致（向后兼容）。
 * @returns 观察结果（强标识 + 不可自动字段）。
 */
export function observeIdentity(
  fields: Readonly<Record<string, ConverterFieldEntry | undefined>>,
  identityMergeEligible: readonly string[] | undefined,
  context?: EvidenceGateContext | EvidenceContextResult,
): IdentityObservation {
  const strong: StrongId[] = []
  const blocked: { field: string; reason: string; detail?: Readonly<Record<string, unknown>> }[] = []
  const gate = evidenceGateOf(context)
  const eligible = identityMergeEligible === undefined ? null : new Set(identityMergeEligible)
  for (const field of ['phone', 'email'] as const) {
    const entry = fields[field]
    const state = entry?.state
    if (state !== 'present') {
      // 读不出/没写：都不能当"新人"依据，也不能当"重复"依据。
      blocked.push({ field, reason: `field_state_${state ?? 'missing'}` })
      continue
    }
    const provenance = typeof entry?.provenance === 'string' ? entry.provenance : 'unknown'
    if (provenance !== 'native_text') {
      blocked.push({ field, reason: `provenance_${provenance}` })
      continue
    }
    if (eligible !== null && !eligible.has(field)) {
      blocked.push({ field, reason: 'not_identity_merge_eligible' })
      continue
    }
    const outcome = toEvidence(entry, gate)
    if (outcome.rejection !== undefined) {
      // fail-closed：任一证据项被拒 → 该字段整体 blocked（不静默丢单条、不保留半套证据）。
      blocked.push({
        field,
        reason: outcome.rejection.reason,
        detail: outcome.rejection.detail,
      })
      continue
    }
    const evidence = outcome.evidence
    if (evidence.length === 0) {
      blocked.push({ field, reason: 'evidence_missing' })
      continue
    }
    const raw = typeof entry?.value === 'string' ? entry.value : ''
    if (field === 'phone') {
      const normalized = normPhone(raw)
      if (normalized === null) {
        blocked.push({ field, reason: 'format_not_normalizable' })
        continue
      }
      strong.push({
        field,
        raw,
        norm: normalized.norm,
        region_ambiguous: normalized.region_ambiguous,
        provenance,
        evidence,
      })
      continue
    }
    const normalized = normEmail(raw)
    if (normalized === null) {
      blocked.push({ field, reason: 'format_not_normalizable' })
      continue
    }
    strong.push({ field, raw, norm: normalized, region_ambiguous: false, provenance, evidence })
  }
  return { strong, blocked }
}

/**
 * 强标识集合的**规范化指纹**。只服务一件事：把"同一个自然人"的并发接入串行化
 * （`pg_advisory_xact_lock` 的 key 成分）。
 *
 * 它**不是**身份判据、更不是申请身份：申请身份只由
 * `(tenant_id, candidate_id, job_id, lifecycle_status='ACTIVE')` 决定，
 * 文件 sha / 内容 sha 一律不参与（Issue #1 §1.1/§1.2）。
 *
 * 只有真正能进自动匹配的标识才进指纹（`region_ambiguous` 的不进——它本来就不产生关联，
 * 若把它算进来会让两笔本可并行的接入互相等）。
 * @param strong - 本次材料可自动的强标识。
 * @returns 排序去重后的 `field=norm`（`|` 连接）；没有可用标识时为 `null`。
 */
export function strongIdentityKey(strong: readonly StrongId[]): string | null {
  const parts = strong
    .filter((id) => !id.region_ambiguous)
    .map((id) => `${id.field}=${id.norm}`)
  if (parts.length === 0) return null
  return [...new Set(parts)].sort().join('|')
}

/** 一个命中的旧档案。 */
export interface CandidateHit {
  readonly candidate_id: string
  readonly display_name: string
  readonly identity_status: string
  readonly record_version: number
  readonly field: StrongIdField
  /** 初始命中行的 id；若它已 MERGED，则与 candidate_id 不同（已解析到存活档）。 */
  readonly matched_row_id: string
}

/** 存活档解析结果（IR §7.1 / merge-state-machine §7.1）。 */
export interface ResolvedCandidate {
  readonly id: string
  readonly display_name: string
  readonly normalized_email: string | null
  readonly normalized_phone: string | null
  readonly identity_status: string
  readonly record_version: number
}

const MAX_CHAIN_DEPTH = 8

/**
 * `resolve(candidate)`：沿 `merged_into_candidate_id` 走到 `ACTIVE` 存活档。
 * 链是合法的（merge A→B 再 merge B→C，A 必须解析到 C）；环与超深必须报错，
 * **不得**静默返回自身（IR §12-②、merge-state-machine IN-8）。
 * @param client - 事务内客户端。
 * @param id - 起点候选人 id。
 * @returns 存活档；不存在时返回 `null`。
 * @throws Error - `IDENTITY_STATE_INCONSISTENT` / `IDENTITY_CHAIN_CYCLE` / `IDENTITY_CHAIN_DEPTH_EXCEEDED`。
 */
export async function resolveCandidate(
  client: DatabaseClient,
  id: string,
): Promise<ResolvedCandidate | null> {
  const seen = new Set<string>()
  let current = id
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH; depth += 1) {
    const { rows } = await client.query<ResolvedCandidate>(
      `select id, display_name, normalized_email, normalized_phone,
              identity_status, record_version
         from recruitment.candidate where id = $1`,
      [current],
    )
    const row = rows[0]
    if (row === undefined) return depth === 0 ? null : null
    if (row.identity_status !== 'MERGED') return row
    if (seen.has(current)) throw new Error('IDENTITY_CHAIN_CYCLE')
    seen.add(current)
    const next = await client.query<{ merged_into_candidate_id: string | null; merge_id: string | null }>(
      'select merged_into_candidate_id, merge_id from recruitment.candidate where id = $1',
      [current],
    )
    const link = next.rows[0]
    if (link === undefined || link.merged_into_candidate_id === null || link.merge_id === null) {
      throw new Error('IDENTITY_STATE_INCONSISTENT')
    }
    current = link.merged_into_candidate_id
  }
  throw new Error('IDENTITY_CHAIN_DEPTH_EXCEEDED')
}

/**
 * 按强标识找同租户的旧档案，并把 `MERGED` 命中解析到存活档。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param strong - 本次材料可自动的强标识。
 * @returns 命中集（按 `candidate_id + field` 去重）。`≥2` 条即需人工（本 lane fail-closed）。
 */
export async function matchByStrongIds(
  client: DatabaseClient,
  tenantId: string,
  strong: readonly StrongId[],
): Promise<CandidateHit[]> {
  const hits: CandidateHit[] = []
  for (const id of strong) {
    if (id.region_ambiguous) continue
    const column = id.field === 'phone' ? 'normalized_phone' : 'normalized_email'
    const { rows } = await client.query<{
      id: string
      display_name: string
      identity_status: string
      record_version: number
    }>(
      `select id, display_name, identity_status, record_version
         from recruitment.candidate
        where tenant_id = $1 and ${column} = $2`,
      [tenantId, id.norm],
    )
    for (const row of rows) {
      const resolved = row.identity_status === 'MERGED'
        ? await resolveCandidate(client, row.id)
        : row
      if (resolved === null) continue
      const survivor = resolved as ResolvedCandidate
      const key = `${survivor.id}|${id.field}`
      if (hits.some((h) => `${h.candidate_id}|${h.field}` === key)) continue
      hits.push({
        candidate_id: survivor.id,
        display_name: survivor.display_name,
        identity_status: survivor.identity_status,
        record_version: survivor.record_version,
        field: id.field,
        matched_row_id: row.id,
      })
    }
  }
  return hits
}
