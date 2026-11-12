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
}

/** 身份观察结果：要么拿到可用强标识，要么带拒绝原因。 */
export interface IdentityObservation {
  readonly strong: readonly StrongId[]
  /** 不可自动的字段及原因（ordering 与 converter 的 `fields` 一致）。 */
  readonly blocked: readonly { readonly field: string; readonly reason: string }[]
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
  }[]
}

function toEvidence(entry: ConverterFieldEntry | undefined): IdEvidence[] {
  const out: IdEvidence[] = []
  for (const item of entry?.evidence ?? []) {
    const page = typeof item.page === 'number' ? item.page : 0
    const bbox = (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : Number.NaN))
    const block = typeof item.block === 'number' ? item.block : -1
    const quote = typeof item.text === 'string' ? item.text : ''
    const bboxOk = bbox.length === 4 && bbox.every((n) => Number.isFinite(n))
    if (page >= 1 && bboxOk && quote !== '') {
      out.push({ page, bbox, block, quote })
    }
  }
  return out
}

/**
 * 把 converter 的 `fields` + `screening` 投影成「可自动匹配的强标识」集合。
 *
 * `AUTO_OK` 判定（IR-G1，本实现对可机检部分逐条落地）：
 *   `state='present'` ∧ `provenance='native_text'` ∧ 归一化成功 ∧ 证据坐标齐全
 *   ∧ converter 把该字段列进 `screening.identity_merge_eligible`（平台噪声等已剔除）。
 *
 * @param fields - converter 输出的 `fields`。
 * @param identityMergeEligible - converter 输出的 `screening.identity_merge_eligible`。
 * @returns 观察结果（强标识 + 不可自动字段）。
 */
export function observeIdentity(
  fields: Readonly<Record<string, ConverterFieldEntry | undefined>>,
  identityMergeEligible: readonly string[] | undefined,
): IdentityObservation {
  const strong: StrongId[] = []
  const blocked: { field: string; reason: string }[] = []
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
    const evidence = toEvidence(entry)
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
