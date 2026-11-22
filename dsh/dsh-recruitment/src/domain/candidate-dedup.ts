// Issue #36 / G-10 · 候选人去重「提示」的**纯领域模块**。
//
// 目标：在一次投递（application）上，识别「疑似同一候选人的其它投递 / 其它渠道申请」，
// 返回**命中原因**，供 HR 人工核对。硬约束：
//   · 只读、纯函数：不改任何库行、不自动删除、不自动合并历史档案；
//   · 跨投递 / 跨渠道：比对键来自候选人的规范化手机 / 邮箱 / 姓名 + 历史档案线索；
//   · PII 不明文：出参里的手机 / 邮箱只能是**脱敏**形式（mask*），绝不回传原文；
//   · 排除自身：按 applicationId（以及 candidateId）过滤，不把自己算成重复。
//
// 归一化口径与 `src/db/identity.ts` 的 `normPhone` / `normEmail` **共享同一实现**
// （IR-N1 / IR-N2）：比较键只在内存里用，绝不回写原文。姓名归一化只用于提示，
// **不参与自动合并判定**（见 `docs/16 §7 坑 1/2`）。
import { normEmail, normPhone } from '../db/identity.ts'

// ---------------------------------------------------------------------
//  类型（出参即契约：本模块冻结这些形状）
// ---------------------------------------------------------------------

/** 一条可用于去重比对的候选人事实（全部来自只读投影，不含服务端派生写入字段）。 */
export interface DedupCandidateFact {
  /** 申请 id（唯一；排除自身用）。 */
  readonly applicationId: string
  /** 候选人 id（同一 candidate 的多条投递也算跨投递，但同一 application 排除）。 */
  readonly candidateId: string
  /** 展示名（原文，只用于比较/脱敏，不直接出参）。 */
  readonly displayName: string | null
  /** 手机原文（只进比较键；出参恒脱敏）。 */
  readonly phone: string | null
  /** 邮箱原文（只进比较键；出参恒脱敏）。 */
  readonly email: string | null
  /** 渠道 id / 名称（只用于「同名 + 跨渠道」提示，不泄漏 PII）。 */
  readonly channelId?: string | null
  readonly channelName?: string | null
  /**
   * 历史档案线索：该候选人过去的合并 / 复用标识（来自 candidate_merge 等只读事实）。
   * 每条是一个不透明的字符串标记（例如 `MERGED:<candidate_id>` / `RESUME_SHA:<sha>`），
   * 只用于判断「是否指向同一历史档案」，**不原样出参**。
   */
  readonly historyKeys?: ReadonlyArray<string>
}

/** 命中原因机器码（封闭集合）。 */
export type DuplicateReasonCode =
  | 'SAME_PHONE'
  | 'SAME_EMAIL'
  | 'SAME_NAME_SAME_CHANNEL'
  | 'SAME_HISTORY_ARCHIVE'

/** 一条疑似重复（出参：不含手机/邮箱原文）。 */
export interface DuplicateMatch {
  /** 命中的另一条申请 id。 */
  readonly applicationId: string
  /** 命中的候选人 id（只用于人工核对定位，不是合并指令）。 */
  readonly candidateId: string
  /** 展示名（可含，因为姓名不属于手机/邮箱这类强 PII；仍做保守截断）。 */
  readonly displayName: string | null
  /** 渠道名称（可为 null；跨渠道提示用）。 */
  readonly channelName: string | null
  /** 全部命中原因（可能多码：同手机 + 同邮箱）。 */
  readonly reasons: ReadonlyArray<DuplicateReasonCode>
  /** 命中的比较键种类（用于 UI 图标；只有种类，没有值）。 */
  readonly matchedKeyKinds: ReadonlyArray<'phone' | 'email' | 'name_channel' | 'history'>
  /** 脱敏后的命中值（形如 `+86 138****8000` / `a***@example.com`）；绝不返回原文。 */
  readonly matchedValueHints: ReadonlyArray<string>
}

/** findDuplicateCandidates 的选项。 */
export interface FindDuplicateOptions {
  /** 最多返回几条（默认 20；0/负数视为默认）。 */
  readonly limit?: number
}

// ---------------------------------------------------------------------
//  纯归一化 / 脱敏函数（可直接单测）
// ---------------------------------------------------------------------

/** 零宽 / 不可见字符（与 identity.ts 同口径）。 */
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g

/**
 * 姓名归一化（只做提示，不做自动合并判据）：去零宽、压空白、去常见分隔符、ASCII 小写。
 * @param raw - 姓名原文（可空）。
 * @returns 归一化比较键；空 / 非法 → null。
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(INVISIBLE_RE, '')
    .replace(/[\s\u00A0]+/g, ' ')
    .replace(/[.,;:'"`·•\-—_()\[\]{}<>]/g, '')
    .trim()
  if (cleaned === '') return null
  // 拉丁字母统一小写；CJK 原样保留（中文姓名大小写无意义）。
  return cleaned.replace(/[A-Z]/g, (ch) => ch.toLowerCase())
}

/**
 * 手机归一化：复用 `identity.ts::normPhone`，比较键只在内存里用。
 * 对「裸数字、地区歧义」的值仍返回比较键（用于提示），但会标记为 region_ambiguous，
 * 调用方可据此降低置信度——本模块只产出提示，不自动合并。
 * @param raw - 手机原文。
 * @returns `{ norm, region_ambiguous }` 或 null。
 */
export function normalizePhone(
  raw: string | null | undefined,
): { readonly norm: string; readonly regionAmbiguous: boolean } | null {
  const result = normPhone(raw)
  return result === null ? null : { norm: result.norm, regionAmbiguous: result.region_ambiguous }
}

/**
 * 邮箱归一化：复用 `identity.ts::normEmail`（去尖括号/空白/零宽 + 小写）。
 * @param raw - 邮箱原文。
 * @returns 规范化邮箱，或 null。
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  return normEmail(raw)
}

/**
 * 手机脱敏：保留前 3 / 后 4 位，中间以 `*` 代替；不足位数只留末位。
 * 例子：`+8613800138000` → `+86 138****8000`；`13800138000` → `138****8000`。
 * @param raw - 手机原文（可空）。
 * @returns 脱敏文本；无法识别 → null。
 */
export function maskPhone(raw: string | null | undefined): string | null {
  const normalized = normalizePhone(raw)
  if (normalized === null) return null
  const digits = normalized.norm.replace(/[^0-9]/g, '')
  const plus = normalized.norm.startsWith('+') ? '+' : ''
  const country = plus !== '' && digits.length > 10 ? `${plus}${digits.slice(0, digits.length - 11)} ` : plus
  const national = digits.slice(-11)
  if (national.length < 7) return `${country}${national.slice(0, 1)}***${national.slice(-1)}`
  return `${country}${national.slice(0, 3)}****${national.slice(-4)}`
}

/**
 * 邮箱脱敏：本地部分只留首字母，域名保留（域名不是个人身份标识，且便于 HR 核对来源）。
 * 例子：`Zhang.San@example.com` → `z***@example.com`。
 * @param raw - 邮箱原文（可空）。
 * @returns 脱敏文本；无法识别 → null。
 */
export function maskEmail(raw: string | null | undefined): string | null {
  const normalized = normalizeEmail(raw)
  if (normalized === null) return null
  const at = normalized.indexOf('@')
  if (at <= 0) return null
  const local = normalized.slice(0, at)
  const domain = normalized.slice(at + 1)
  return `${local.slice(0, 1)}***@${domain}`
}

// ---------------------------------------------------------------------
//  去重提示（纯函数：只比对入参，不访问任何存储）
// ---------------------------------------------------------------------

function normalizedHistoryKeys(fact: DedupCandidateFact): ReadonlySet<string> {
  const out = new Set<string>()
  for (const key of fact.historyKeys ?? []) {
    if (typeof key === 'string' && key.trim() !== '') out.add(key.trim())
  }
  return out
}

/**
 * 在两个候选人事实之间计算命中原因（**不含 PII 原文**，只返回 machine code + 脱敏提示）。
 * @param subject - 当前申请对应候选人事实。
 * @param other - 被比对的其它申请事实。
 * @returns 命中结果；没有任何命中 → null。
 */
export function compareForDuplicate(
  subject: DedupCandidateFact,
  other: DedupCandidateFact,
): Omit<DuplicateMatch, 'displayName' | 'channelName'> | null {
  const reasons: DuplicateReasonCode[] = []
  const kinds: DuplicateMatch['matchedKeyKinds'][number][] = []
  const hints: string[] = []

  const phoneA = normalizePhone(subject.phone)
  const phoneB = normalizePhone(other.phone)
  if (phoneA !== null && phoneB !== null && phoneA.norm === phoneB.norm) {
    reasons.push('SAME_PHONE')
    kinds.push('phone')
    const hint = maskPhone(other.phone)
    if (hint !== null) hints.push(hint)
  }

  const emailA = normalizeEmail(subject.email)
  const emailB = normalizeEmail(other.email)
  if (emailA !== null && emailB !== null && emailA === emailB) {
    reasons.push('SAME_EMAIL')
    kinds.push('email')
    const hint = maskEmail(other.email)
    if (hint !== null) hints.push(hint)
  }

  const nameA = normalizeName(subject.displayName)
  const nameB = normalizeName(other.displayName)
  const channelA = subject.channelId ?? subject.channelName ?? null
  const channelB = other.channelId ?? other.channelName ?? null
  if (nameA !== null && nameA === nameB && channelA !== null && channelB !== null && channelA !== channelB) {
    reasons.push('SAME_NAME_SAME_CHANNEL')
    kinds.push('name_channel')
    // 姓名/渠道不属于手机/邮箱，按保守截断给 HR 核对用。
    const trimmed = nameB.slice(0, 40)
    if (trimmed !== '') hints.push(trimmed)
  }

  const historyA = normalizedHistoryKeys(subject)
  const historyB = normalizedHistoryKeys(other)
  for (const key of historyA) {
    if (historyB.has(key)) {
      reasons.push('SAME_HISTORY_ARCHIVE')
      kinds.push('history')
      hints.push('同一历史档案标记')
      break
    }
  }

  if (reasons.length === 0) return null
  return {
    applicationId: other.applicationId,
    candidateId: other.candidateId,
    reasons,
    matchedKeyKinds: kinds,
    matchedValueHints: hints,
  }
}

/**
 * 找出与 subject 疑似同一候选人的其它申请（**排除自身**，不删除/合并任何历史）。
 * @param subject - 当前申请事实。
 * @param others - 候选池（通常是同租户全部申请投影；函数本身不查库）。
 * @param options - 条数上限。
 * @returns 命中数组（按传入顺序稳定）；无命中 → 空数组。
 */
export function findDuplicateCandidates(
  subject: DedupCandidateFact,
  others: ReadonlyArray<DedupCandidateFact>,
  options: FindDuplicateOptions = {},
): DuplicateMatch[] {
  const rawLimit = options.limit ?? 20
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : 20
  const out: DuplicateMatch[] = []
  for (const other of others) {
    if (out.length >= limit) break
    // 排除自身：同一申请 id 或同一候选人 id 都不算「跨投递」命中。
    if (other.applicationId === subject.applicationId) continue
    if (other.candidateId !== '' && other.candidateId === subject.candidateId) continue
    const hit = compareForDuplicate(subject, other)
    if (hit === null) continue
    out.push({
      ...hit,
      displayName: typeof other.displayName === 'string' && other.displayName !== ''
        ? other.displayName.replace(INVISIBLE_RE, '').replace(/[\s\u00A0]+/g, ' ').trim().slice(0, 40)
        : null,
      channelName: typeof other.channelName === 'string' && other.channelName !== ''
        ? other.channelName.slice(0, 120)
        : null,
    })
  }
  return out
}

/**
 * 校验 application id 形状（fail-closed 用）：只接受非空、无空白 / 控制字符、无路径分隔符。
 * @param value - 原始 id（来自 URL 路径段，已 decodeURIComponent）。
 * @returns 合法 → true。
 */
export function isValidApplicationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\s/\\\u0000-\u001F\u007F]/.test(value)
}
