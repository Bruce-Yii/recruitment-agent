// 确定性校验层（B 层）：模型返回的结构化结果 × block_index × 原始块文本。
//
// 这一层不调用任何模型、不联网、不读文件：输入是三个已经存在的内存值，输出是
// { accepted, rejected[], issues[] }。判定只看机械规则，不做语义判断。
//
// 八条规则（对应任务书的 1–8，每条都有单测）：
//   1. id 存在性      —— 结果里引用的每个 block id 必须在 block_index 里；
//   2. 值必须可回查   —— present 字段的 value 必须在「所引用块按序拼接后的文本」里逐字找到
//                        （D-30：块粒度是视觉行，一句话可以跨连续块；只允许三种**固定**归一化，
//                         见 normalizeForMatch()。**不是**「语义相等」——D-32 明令不得放宽）；
//   3. id 分区        —— 每个 block 必须**恰好**归入一个 section 的 block_ids，或被标 ignored 且带
//                        reason（D-31：重复出现 = 拒绝；ignored 块不得再被引用；覆盖率证明的是
//                        「没漏块」，不证明「处理对了」）；
//   4. 标签枚举      —— section.label 必须在 SECTION_LABELS 内；
//   5. 状态枚举      —— 每个字段必须带 state ∈ {present, absent, unreadable}；
//   6. 数字专项      —— phone / email / date 各自的格式 + 与原文一致；
//   7. 跨字段一致性  —— 起始年份不得晚于结束年份、两段工作经历不得完全重叠（软：记 issue 不拒绝）；
//   8. 不允许省略字段 —— 必填字段缺失 = 拒绝（省略 ≠ absent）。
//
// 软 / 硬的分界：issues[] 里两类都记（severity = 'hard' | 'soft'），rejected[] 只装 hard。
// accepted === (rejected.length === 0)。
//
// 额外加的三条（都是为了让「账能平」，不是业务判断）：
//   * BLOCK_INDEX_INTEGRITY —— block_index 的 sha256 与传入的原始块文本对不上（索引/原文被换过）；
//   * BLOCK_INDEX_VERSION_UNSUPPORTED —— 不认识的索引版本（不猜结构）；
//   * UNREADABLE_MISSING_REASON —— unreadable 必须说明为什么读不出来（doc 11 §9.2 的红线）。
//
// D-30 / D-31 新增的四条（同样是机械检查，不是语义判断）：
//   * BLOCK_IDS_NOT_CONSECUTIVE —— 用于拼接匹配的引用列表必须连续且有序（相邻 id）；
//   * BLOCK_DUPLICATED —— 同一个 block 被放进一个以上的 section（或既 ignored 又放进 section）；
//   * IGNORED_BLOCK_REFERENCED —— 被 ignored 的 block 又被字段 / 条目引用；
//   * FIELD_BLOCK_NOT_IN_SECTION —— 字段引用的 block 不属于该字段所在 section（contact 类字段除外）。
//
// 归一化只用于比较：**原文与 block_index 里保存的文本 / sha256 一个字符都不改**（D-30 §4）。

import type { BlockIndex, BlockIndexEntry, SourceBlock } from './serialize.ts'
import { BLOCK_INDEX_VERSION, NEWLINE_ESCAPE, sha256Hex, toCodePoints } from './serialize.ts'

/** 允许的 section 标签（封闭集合；表外标签一律拒绝，不静默归类）。 */
export const SECTION_LABELS = [
  'basic',
  'summary',
  'work',
  'education',
  'project',
  'skill',
  'certificate',
  'award',
  'language',
  'other',
] as const

/** section 标签类型。 */
export type SectionLabel = (typeof SECTION_LABELS)[number]

/** 字段三态（doc 11 §9.2）。 */
export const FIELD_STATES = ['present', 'absent', 'unreadable'] as const

/** 字段状态类型。 */
export type FieldState = (typeof FIELD_STATES)[number]

/** 每个 section 必须出现的字段（省略 = 拒绝；没有就写 absent）。 */
export const REQUIRED_SECTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  basic: ['name', 'phone', 'email'],
}

/** 每个条目必须出现的字段（省略 = 拒绝）。 */
export const REQUIRED_ENTRY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  work: ['company', 'title', 'start', 'end'],
  education: ['school', 'degree', 'start', 'end'],
}

/** 需要做日期专项校验的字段名。 */
export const DATE_FIELD_KEYS = ['start', 'end', 'date'] as const

/**
 * contact 类字段（联络信息三件套）。
 * D-31 §3 的唯一例外：这些字段引用的块可以不在该字段所在 section 里——
 * 简历页眉里的电话 / 邮箱经常被归到别的 section，硬绑会让正确结果被拒。
 */
export const CONTACT_FIELD_KEYS = ['name', 'phone', 'email'] as const

/** 电话号码格式（任务书给定，逐字照抄）。 */
export const PHONE_PATTERN = /^\+?\d[\d\-\s]{6,}$/

/** 邮箱格式：必须有本地部分 + 带点的域名（"a@b" 不合格）。 */
export const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** 表示「至今」的开放区间标记（没有年份，不参与年份比较）。 */
const ONGOING_TOKENS = new Set(['至今', '今', '现在', '目前', 'present', 'now', 'current', 'ongoing'])

/** 日期形状：YYYY / YYYY-MM / YYYY-MM-DD（分隔符已归一为 -）。 */
const DATE_SHAPE = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/

/** issue code 闭合集合。 */
export type IssueCode =
  | 'SCHEMA_INVALID'
  | 'STATE_MISSING'
  | 'STATE_INVALID'
  | 'STATE_VALUE_CONFLICT'
  | 'UNKNOWN_SECTION_LABEL'
  | 'MISSING_BLOCK_ID'
  | 'UNKNOWN_BLOCK_ID'
  | 'VALUE_NOT_IN_BLOCK'
  | 'BLOCK_IDS_NOT_CONSECUTIVE'
  | 'BLOCK_DUPLICATED'
  | 'IGNORED_BLOCK_REFERENCED'
  | 'FIELD_BLOCK_NOT_IN_SECTION'
  | 'UNCOVERED_BLOCK'
  | 'IGNORED_MISSING_REASON'
  | 'UNREADABLE_MISSING_REASON'
  | 'MISSING_FIELD'
  | 'MISSING_ENTRY_FIELD'
  | 'PHONE_INVALID'
  | 'PHONE_DIGITS_MISMATCH'
  | 'EMAIL_INVALID'
  | 'EMAIL_NOT_IN_SOURCE'
  | 'DATE_INVALID'
  | 'DATE_NOT_IN_SOURCE'
  | 'BLOCK_INDEX_INTEGRITY'
  | 'BLOCK_INDEX_VERSION_UNSUPPORTED'
  | 'WORK_PERIOD_INVERTED'
  | 'WORK_PERIOD_OVERLAP'

/** 一条校验记录。 */
export interface ValidationIssue {
  readonly code: IssueCode
  /** hard = 拒绝；soft = 只记 issue（跨字段一致性用）。 */
  readonly severity: 'hard' | 'soft'
  readonly message: string
  /** 结果里的位置，如 `sections[0].fields.phone` / `ignored[2]` / `block_index[7]`。 */
  readonly path: string
  /** 相关 block id（能定位时给）。 */
  readonly block_id?: number
}

/** 一条拒绝原因（= severity 为 hard 的 issue）。 */
export interface Rejection {
  readonly code: IssueCode
  readonly message: string
  readonly path: string
  readonly block_id?: number
}

/** 校验统计（给报告用）。 */
export interface ValidateStats {
  /** block_index 的条目数（块被切分时条数 > 原始 block 数）。 */
  readonly index_entries: number
  readonly covered: number
  readonly ignored: number
  readonly fields: number
  readonly entries: number
  readonly hard: number
  readonly soft: number
}

/** 校验结果。 */
export interface ValidateResult {
  /** 没有任何 hard issue。 */
  readonly accepted: boolean
  /** 拒绝原因（hard）。 */
  readonly rejected: readonly Rejection[]
  /** 全部记录（hard + soft）。 */
  readonly issues: readonly ValidationIssue[]
  readonly stats: ValidateStats
}

/** 校验输入。 */
export interface ValidateInput {
  /** 模型返回的结构化结果（未校验，故意收 unknown）。 */
  readonly result: unknown
  /** serialize() 产出的 block_index。 */
  readonly blockIndex: BlockIndex
  /** 原始块文本：与序列化时同一份 blocks（对象数组或纯字符串数组）。 */
  readonly blocks: readonly (SourceBlock | string)[]
}

/** 解析出的日期；ongoing=true 时年月日全为 null。 */
export interface ParsedDate {
  readonly year: number | null
  readonly month: number | null
  readonly day: number | null
  readonly ongoing: boolean
}

/** 一个 section 的语境：字段 / 条目归属检查用（D-31 §3）。 */
interface SectionScope {
  /** section 在结果里的位置，如 `sections[1]`。 */
  readonly path: string
  /** 该 section 放进去的 block id 集合（`section.block_ids`）。 */
  readonly blocks: ReadonlySet<number>
}

/** 一次字段引用，留给「字段块必须属于所在 section」的统一判定（D-31 §3）。 */
interface FieldCitation {
  readonly path: string
  /** 字段名（name / phone / company / ...），用于 contact 类字段的例外。 */
  readonly key: string
  readonly sectionPath: string
  readonly sectionBlocks: ReadonlySet<number>
  readonly ids: readonly number[]
}

interface ValidationContext {
  readonly issues: ValidationIssue[]
  readonly entries: ReadonlyMap<number, BlockIndexEntry>
  readonly texts: ReadonlyMap<number, string>
  /** 被 section.block_ids 放进分区的 id -> 第一次放置它的 path（D-31 §1）。 */
  readonly placed: Map<number, string>
  /** 带 reason 的 ignored 条目：id -> `ignored[i]` 的 path（D-31 §2）。 */
  readonly ignoredCovered: Map<number, string>
  /** 字段 / 条目引用过的块（IGNORED_BLOCK_REFERENCED 用）。 */
  readonly refs: Array<{ readonly id: number; readonly path: string }>
  /** 字段的块引用（等全部 section 解析完再统一判定归属，诊断信息才准确）。 */
  readonly fieldCitations: FieldCitation[]
  fields: number
  entryCount: number
  ignored: number
}

/** 遍历过程中记住的工作经历区间，供跨字段一致性检查用。 */
interface WorkPeriod {
  readonly path: string
  readonly start: ParsedDate
  readonly end: ParsedDate
}

/** 一个字段的校验结论。 */
interface CheckedField {
  readonly state: FieldState
  readonly value: string | null
  readonly blockId: number | null
  readonly date: ParsedDate | null
}

/** 是否是普通对象（数组 / null 都不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 是否是 ASCII 数字。 */
function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

/** 只留数字（归一化用）。 */
function digitsOnly(text: string): string {
  return text.replace(/\D/g, '')
}

/** 消息里展示一个值，避免把对象直接拼成 [object Object]。 */
function showValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return Array.isArray(value) ? 'array' : 'object'
}

/** 闰年判定（不依赖 Date，保证任何时区/任何年份都算出同一个结果）。 */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** 某年某月的天数。 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30
  return 31
}

/**
 * 解析日期文本。接受 `2020.07` / `2020-07` / `2020/7` / `2020年7月` / `2020-07-15` / `2020`，
 * 以及表示开放区间的 `至今` / `present` 等。
 * @param text - 字段值原文（通常就是 block 里的写法）。
 * @returns 解析结果；解析不出返回 null。
 */
export function parseDateText(text: string): ParsedDate | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (ONGOING_TOKENS.has(trimmed.toLowerCase())) {
    return { year: null, month: null, day: null, ongoing: true }
  }
  const normalized = trimmed
    .replace(/年/g, '-')
    .replace(/月/g, '-')
    .replace(/[日号]/g, '')
    .replace(/[./]/g, '-')
    .replace(/\s+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  const match = DATE_SHAPE.exec(normalized)
  if (match === null) return null
  const year = Number(match[1])
  const month = match[2] === undefined ? null : Number(match[2])
  const day = match[3] === undefined ? null : Number(match[3])
  if (month !== null && (month < 1 || month > 12)) return null
  if (day !== null) {
    if (month === null) return null
    if (day < 1 || day > daysInMonth(year, month)) return null
  }
  return { year, month, day, ongoing: false }
}

/** 月序号（用于区间比较）；缺月份起始按 1 月、结束按 12 月。 */
function monthOrdinal(date: ParsedDate, edge: 'start' | 'end'): number {
  const year = date.year === null ? 0 : date.year
  const month = date.month === null ? (edge === 'start' ? 1 : 12) : date.month
  return year * 12 + (month - 1)
}

/** 解析一个 id 对应的原文（片段按码点偏移精确切片）。 */
function resolveSourceText(blocks: readonly (SourceBlock | string)[], blockNo: number): string | null {
  const block = blocks[blockNo - 1]
  if (block === undefined || block === null) return null
  if (typeof block === 'string') return block
  return typeof block.text === 'string' ? block.text : ''
}

/** 记一条 hard issue。 */
function pushHard(
  ctx: ValidationContext,
  code: IssueCode,
  message: string,
  path: string,
  blockId?: number,
): void {
  ctx.issues.push(
    blockId === undefined
      ? { code, severity: 'hard', message, path }
      : { code, severity: 'hard', message, path, block_id: blockId },
  )
}

/** 记一条 soft issue。 */
function pushSoft(ctx: ValidationContext, code: IssueCode, message: string, path: string): void {
  ctx.issues.push({ code, severity: 'soft', message, path })
}

/**
 * 值匹配用的**固定**归一化（D-30 §3）。只用于比较，**不改原文**。
 *
 * 固定三步，顺序固定，没有第四种变换：
 *   1. 连字符断行：`seman-` + 换行（`\n` / `\r\n`）或序列化层的 `⏎` + `tics` → `semantics`；
 *      只删「断行造成的」连字符，行内真连字符（`well-known` / `2020-2023`）保留；
 *   2. `⏎` 是 serialize() 的「一行一块」转义符，按它代替的那个换行处理（即当空白）；
 *   3. 折叠空白：连续空白折成一个空格，再去首尾空白。
 *
 * 明确**不做**：不改大小写、不做同义改写、不做日期 / 数字规范化、不做「语义相等」（D-32）。
 * @param text - 原文或模型给的值。
 * @returns 归一化后的比较串（不写回任何地方）。
 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/([a-z])-[^\S\r\n]*(?:\r?\n|\u23ce)\s*([a-z])/g, '$1$2')
    .split(NEWLINE_ESCAPE)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 引用块按序拼接后用于匹配的候选文本（D-30 §1）。
 * 块边界只有两种固定拼法：当作一个空白（块之间是视觉换行），或直接相接
 * （PDF 把一句话切成两行，中文没有词间空格）；两种都试，任一命中即算逐字找到。
 * @param texts - 引用块原文（按 id 升序）。
 * @returns 候选比较串（1 或 2 个）。
 */
export function buildMatchTexts(texts: readonly string[]): string[] {
  if (texts.length === 0) return []
  const asLineBreak = normalizeForMatch(texts.join('\n'))
  if (texts.length === 1) return [asLineBreak]
  const straight = normalizeForMatch(texts.join(''))
  return straight === asLineBreak ? [asLineBreak] : [asLineBreak, straight]
}

/**
 * 值是否能在「引用块按序拼接后的文本」里逐字找到（D-30 §1/§3）。
 * 只做固定归一化后的子串判定，**不做**语义判断。
 */
export function valueMatchesTexts(texts: readonly string[], value: string): boolean {
  const needle = normalizeForMatch(value)
  if (needle === '') return false
  for (const haystack of buildMatchTexts(texts)) {
    if (haystack.includes(needle)) return true
  }
  return false
}

/** 引用 id 列表是否「连续且有序」（后一个必须正好是前一个 + 1）。 */
function isConsecutive(ids: readonly number[]): boolean {
  for (let i = 1; i < ids.length; i += 1) {
    if (ids[i] !== (ids[i - 1] as number) + 1) return false
  }
  return true
}

/** 把一个 block 放进当前 section 的分区；同一个 id 只能放一次（D-31 §1）。 */
function placeBlock(ctx: ValidationContext, id: number, path: string): void {
  const existing = ctx.placed.get(id)
  if (existing !== undefined) {
    pushHard(
      ctx,
      'BLOCK_DUPLICATED',
      `block ${id} is placed more than once (first at ${existing}, again at ${path}); every block must appear in exactly one section`,
      path,
      id,
    )
    return
  }
  ctx.placed.set(id, path)
}

/** 记一次字段 / 条目的块引用（IGNORED_BLOCK_REFERENCED 用）。 */
function noteRef(ctx: ValidationContext, id: number, path: string): void {
  ctx.refs.push({ id, path })
}

/** 建 ctx：解析索引、逐 id 校准原文与 sha256。 */
function createContext(index: BlockIndex, blocks: readonly (SourceBlock | string)[]): ValidationContext {
  const ctx: ValidationContext = {
    issues: [],
    entries: new Map<number, BlockIndexEntry>(),
    texts: new Map<number, string>(),
    placed: new Map<number, string>(),
    ignoredCovered: new Map<number, string>(),
    refs: [],
    fieldCitations: [],
    fields: 0,
    entryCount: 0,
    ignored: 0,
  }
  for (const entry of index.entries) ctx.entries.set(entry.id, entry)

  for (const entry of index.entries) {
    const raw = resolveSourceText(blocks, entry.block_no)
    if (raw === null) {
      pushHard(
        ctx,
        'BLOCK_INDEX_INTEGRITY',
        `block_index[${entry.id}] points at block_no ${entry.block_no}, but only ${blocks.length} block(s) were passed`,
        `block_index[${entry.id}]`,
        entry.id,
      )
      continue
    }
    let text = raw
    if (entry.piece_count > 1) {
      const codePoints = toCodePoints(raw)
      if (
        entry.piece_start < 0 ||
        entry.piece_end > codePoints.length ||
        entry.piece_start >= entry.piece_end
      ) {
        pushHard(
          ctx,
          'BLOCK_INDEX_INTEGRITY',
          `block_index[${entry.id}] piece offsets ${entry.piece_start}..${entry.piece_end} exceed block text (${codePoints.length} code points)`,
          `block_index[${entry.id}]`,
          entry.id,
        )
        continue
      }
      text = codePoints.slice(entry.piece_start, entry.piece_end).join('')
    }
    if (sha256Hex(text) !== entry.sha256) {
      pushHard(
        ctx,
        'BLOCK_INDEX_INTEGRITY',
        `block_index[${entry.id}] sha256 does not match the source block text`,
        `block_index[${entry.id}]`,
        entry.id,
      )
      continue
    }
    ctx.texts.set(entry.id, text)
  }
  return ctx
}

/** 校验一个 block 引用是否存在（不改变覆盖状态）。 */
function checkKnownBlockId(ctx: ValidationContext, raw: unknown, path: string): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    pushHard(ctx, 'UNKNOWN_BLOCK_ID', `block id must be an integer, got ${showValue(raw)}`, path)
    return null
  }
  if (!ctx.entries.has(raw)) {
    pushHard(ctx, 'UNKNOWN_BLOCK_ID', `block id ${raw} is not in block_index`, path, raw)
    return null
  }
  return raw
}

/**
 * 解析字段的块引用：`block_ids`（有序列表，D-30 §1）或 `block_id`（单个，旧写法）。
 * 校验：整数、存在于 block_index、多个引用必须连续且有序。
 * @returns 按序排列的 id 列表（空数组 = 没引用块）；引用不合法时已记 issue 并返回 null。
 */
function parseFieldCitation(
  ctx: ValidationContext,
  path: string,
  raw: Record<string, unknown>,
): number[] | null {
  const singleRaw = raw.block_id
  let single: number | null = null
  if (singleRaw !== null && singleRaw !== undefined) {
    if (typeof singleRaw !== 'number' || !Number.isInteger(singleRaw)) {
      pushHard(ctx, 'UNKNOWN_BLOCK_ID', `field ${path} block_id must be an integer, got ${showValue(singleRaw)}`, path)
      return null
    }
    single = singleRaw
  }

  const listRaw = raw.block_ids
  let cited: number[] = []
  if (listRaw !== undefined && listRaw !== null) {
    if (!Array.isArray(listRaw)) {
      pushHard(ctx, 'SCHEMA_INVALID', `field ${path} block_ids must be an array`, path)
      return null
    }
    for (let i = 0; i < listRaw.length; i += 1) {
      const item = listRaw[i]
      if (typeof item !== 'number' || !Number.isInteger(item)) {
        pushHard(
          ctx,
          'UNKNOWN_BLOCK_ID',
          `field ${path} block_ids[${i}] must be an integer, got ${showValue(item)}`,
          path,
        )
        return null
      }
      cited.push(item)
    }
    if (single !== null) {
      // 两种写法同时出现时只接受「block_id 就是 block_ids[0]」这一种，避免两套证据。
      if (cited.length === 0 || cited[0] !== single) {
        pushHard(
          ctx,
          'SCHEMA_INVALID',
          `field ${path} gives block_id ${single} together with block_ids ${JSON.stringify(cited)}; block_id must equal block_ids[0]`,
          path,
        )
        return null
      }
    }
  } else if (single !== null) {
    cited = [single]
  }

  for (const id of cited) {
    if (!ctx.entries.has(id)) {
      pushHard(ctx, 'UNKNOWN_BLOCK_ID', `field ${path} cites block ${id}, which is not in block_index`, path, id)
      return null
    }
  }
  if (!isConsecutive(cited)) {
    pushHard(
      ctx,
      'BLOCK_IDS_NOT_CONSECUTIVE',
      `field ${path} cites blocks ${cited.join(', ')}; a value may only be matched across consecutive, ascending block ids`,
      path,
      cited[0],
    )
    return null
  }
  return cited
}

/** 电话号码专项：格式 + 数字序列必须与原文里那个数字串一致。 */
function checkPhone(ctx: ValidationContext, value: string, text: string, path: string, blockId: number): void {
  const trimmed = value.trim()
  if (!PHONE_PATTERN.test(trimmed)) {
    pushHard(
      ctx,
      'PHONE_INVALID',
      `phone ${JSON.stringify(trimmed)} does not match ${PHONE_PATTERN.source}`,
      path,
      blockId,
    )
    return
  }
  const at = text.indexOf(trimmed)
  if (at < 0) return // 子串规则已经报过了，这里不重复
  let start = at
  let end = at + trimmed.length
  while (start > 0 && isDigit(text[start - 1])) start -= 1
  while (end < text.length && isDigit(text[end])) end += 1
  const run = text.slice(start, end)
  if (digitsOnly(run) !== digitsOnly(trimmed)) {
    pushHard(
      ctx,
      'PHONE_DIGITS_MISMATCH',
      `phone digits ${digitsOnly(trimmed)} do not match the number in the source text (${digitsOnly(run)})`,
      path,
      blockId,
    )
  }
}

/** 邮箱专项：格式 + 小写后必须能在原文里找到（大小写不作为凭据）。 */
function checkEmail(ctx: ValidationContext, value: string, text: string, path: string, blockId: number): void {
  const trimmed = value.trim()
  if (!EMAIL_PATTERN.test(trimmed)) {
    pushHard(ctx, 'EMAIL_INVALID', `email ${JSON.stringify(trimmed)} is not a valid address`, path, blockId)
    return
  }
  if (!text.toLowerCase().includes(trimmed.toLowerCase())) {
    pushHard(
      ctx,
      'EMAIL_NOT_IN_SOURCE',
      `email ${JSON.stringify(trimmed)} (lowercased) does not appear in the source block`,
      path,
      blockId,
    )
  }
}

/** 日期专项：能解析 + 原文里是一个完整日期记号（不是更长数字串的截断）。 */
function checkDate(
  ctx: ValidationContext,
  value: string,
  text: string,
  path: string,
  blockId: number,
): ParsedDate | null {
  const trimmed = value.trim()
  const parsed = parseDateText(trimmed)
  if (parsed === null) {
    pushHard(
      ctx,
      'DATE_INVALID',
      `date ${JSON.stringify(trimmed)} is not parseable as YYYY / YYYY-MM / YYYY-MM-DD`,
      path,
      blockId,
    )
    return null
  }
  if (parsed.ongoing) return parsed
  const at = text.indexOf(trimmed)
  if (at < 0) return parsed // 子串规则已经报过了
  const before = at > 0 ? text[at - 1] : undefined
  const after = at + trimmed.length < text.length ? text[at + trimmed.length] : undefined
  if (isDigit(before) || isDigit(after)) {
    pushHard(
      ctx,
      'DATE_NOT_IN_SOURCE',
      `date ${JSON.stringify(trimmed)} is a partial token of a longer number in the source block`,
      path,
      blockId,
    )
  }
  return parsed
}

/**
 * 校验一个字段（三态 + 块引用 + 值匹配 + 数字专项）。
 * 引用有两种写法：单个 `block_id`，或有序列表 `block_ids`（D-30：一句话可以跨连续块）。
 */
function checkField(
  ctx: ValidationContext,
  path: string,
  key: string,
  raw: unknown,
  scope: SectionScope,
): CheckedField | null {
  ctx.fields += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `field ${path} must be an object`, path)
    return null
  }
  const stateRaw = raw.state
  if (typeof stateRaw !== 'string' || stateRaw === '') {
    pushHard(ctx, 'STATE_MISSING', `field ${path} is missing state`, path)
    return null
  }
  if (!(FIELD_STATES as readonly string[]).includes(stateRaw)) {
    pushHard(
      ctx,
      'STATE_INVALID',
      `field ${path} has state ${JSON.stringify(stateRaw)}; allowed: ${FIELD_STATES.join(', ')}`,
      path,
    )
    return null
  }
  const state = stateRaw as FieldState

  const valueRaw = raw.value
  let value: string | null = null
  if (typeof valueRaw === 'string') value = valueRaw
  else if (valueRaw !== null && valueRaw !== undefined) {
    pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} value must be a string or null`, path)
    return null
  }

  const cited = parseFieldCitation(ctx, path, raw)
  if (cited === null) return null
  for (const id of cited) noteRef(ctx, id, path)
  // 归属（D-31 §3）留到所有 section 解析完再判：那时「这个块到底被放在哪」才是准确的。
  ctx.fieldCitations.push({ path, key, sectionPath: scope.path, sectionBlocks: scope.blocks, ids: cited })

  if (state === 'present') {
    if (value === null || value.trim() === '') {
      pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is present but has no value`, path)
      return null
    }
    if (cited.length === 0) {
      pushHard(ctx, 'MISSING_BLOCK_ID', `field ${path} is present but has no block_id`, path)
      return null
    }
    const first = cited[0] as number
    const texts: string[] = []
    for (const id of cited) {
      const text = ctx.texts.get(id)
      if (text === undefined) return { state, value, blockId: first, date: null } // 索引完整性问题已单独记过
      texts.push(text)
    }
    let substringOk = true
    if (!valueMatchesTexts(texts, value)) {
      pushHard(
        ctx,
        'VALUE_NOT_IN_BLOCK',
        `field ${path} value ${JSON.stringify(value.trim())} is not found in the text of cited block(s) ${cited.join('+')} after the fixed normalizations (no semantic matching)`,
        path,
        first,
      )
      substringOk = false
    }
    // 数字专项独立判定（规则 6 不因为规则 2 失败就不查）：格式永远查，与原文比对在找得到时才查。
    const joined = texts.join(' ')
    let date: ParsedDate | null = null
    if (key === 'phone') checkPhone(ctx, value, joined, path, first)
    else if (key === 'email') checkEmail(ctx, value, joined, path, first)
    else if ((DATE_FIELD_KEYS as readonly string[]).includes(key)) {
      const parsed = checkDate(ctx, value, joined, path, first)
      // 值都不在原文里时，不拿它去做跨字段一致性（避免用幻觉值再派生软 issue）。
      date = substringOk ? parsed : null
    }
    return { state, value, blockId: first, date }
  }

  if (value !== null) {
    pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is ${state} but carries a value`, path)
    return null
  }

  if (state === 'unreadable') {
    const reason = raw.reason
    if (typeof reason !== 'string' || reason.trim() === '') {
      pushHard(ctx, 'UNREADABLE_MISSING_REASON', `field ${path} is unreadable but has no reason`, path)
    }
  }

  return { state, value: null, blockId: cited.length > 0 ? (cited[0] as number) : null, date: null }
}

/** 校验一个条目（entries[i]）：block 引用 + 各字段 + 必填字段。 */
function checkEntry(
  ctx: ValidationContext,
  path: string,
  label: string | null,
  raw: unknown,
  workPeriods: WorkPeriod[],
  scope: SectionScope,
): void {
  ctx.entryCount += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `entry ${path} must be an object`, path)
    return
  }
  const blockIds = raw.block_ids
  if (blockIds !== undefined) {
    if (!Array.isArray(blockIds)) {
      pushHard(ctx, 'SCHEMA_INVALID', `entry ${path} block_ids must be an array`, path)
    } else {
      const ids: number[] = []
      for (let i = 0; i < blockIds.length; i += 1) {
        const idPath = `${path}.block_ids[${i}]`
        const id = checkKnownBlockId(ctx, blockIds[i], idPath)
        if (id === null) continue
        ids.push(id)
        noteRef(ctx, id, idPath)
      }
      // 条目的引用也是「按序拼接」的证据，同样必须连续且有序（D-30 §2）。
      if (!isConsecutive(ids)) {
        pushHard(
          ctx,
          'BLOCK_IDS_NOT_CONSECUTIVE',
          `entry ${path} cites blocks ${ids.join(', ')}; entry block ids must be consecutive and ascending`,
          `${path}.block_ids`,
          ids[0],
        )
      }
    }
  }

  const checked = new Map<string, CheckedField>()
  const declaredKeys = new Set<string>()
  const fields = raw.fields
  if (fields !== undefined) {
    if (!isPlainObject(fields)) {
      pushHard(ctx, 'SCHEMA_INVALID', `entry ${path} fields must be an object`, path)
    } else {
      for (const key of Object.keys(fields).sort()) {
        declaredKeys.add(key)
        const field = checkField(ctx, `${path}.fields.${key}`, key, fields[key], scope)
        if (field !== null) checked.set(key, field)
      }
    }
  }

  if (label !== null) {
    const required = REQUIRED_ENTRY_FIELDS[label]
    if (required !== undefined) {
      for (const key of required) {
        // 「省略」才报 MISSING_*；写坏了是别的 code 的事，不重复报成缺失。
        if (!declaredKeys.has(key)) {
          pushHard(
            ctx,
            'MISSING_ENTRY_FIELD',
            `entry ${path} (section label "${label}") omits field "${key}"; omission is not "absent"`,
            `${path}.fields.${key}`,
          )
        }
      }
    }
  }

  if (label === 'work') {
    const start = checked.get('start')
    const end = checked.get('end')
    if (
      start !== undefined &&
      end !== undefined &&
      start.date !== null &&
      end.date !== null &&
      !start.date.ongoing &&
      !end.date.ongoing
    ) {
      workPeriods.push({ path, start: start.date, end: end.date })
    }
  }
}

/**
 * 校验一个 section：标签 + block 分区 + 字段 + 条目 + 必填字段。
 * 分区（D-31 §1）：section.block_ids 是「这个 section 拥有哪些块」的**唯一**声明，
 * 同一个块只能出现在一个 section 里。
 */
function checkSection(
  ctx: ValidationContext,
  path: string,
  raw: unknown,
  workPeriods: WorkPeriod[],
): void {
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `section ${path} must be an object`, path)
    return
  }

  const labelRaw = raw.label
  let label: string | null = null
  if (typeof labelRaw !== 'string' || labelRaw === '') {
    pushHard(ctx, 'UNKNOWN_SECTION_LABEL', `section ${path} label must be a non-empty string`, path)
  } else if (!(SECTION_LABELS as readonly string[]).includes(labelRaw)) {
    pushHard(
      ctx,
      'UNKNOWN_SECTION_LABEL',
      `section ${path} label ${JSON.stringify(labelRaw)} is not one of: ${SECTION_LABELS.join(', ')}`,
      path,
    )
  } else {
    label = labelRaw
  }

  const placedHere = new Set<number>()
  const blockIds = raw.block_ids
  if (blockIds !== undefined) {
    if (!Array.isArray(blockIds)) {
      pushHard(ctx, 'SCHEMA_INVALID', `section ${path} block_ids must be an array`, path)
    } else {
      for (let i = 0; i < blockIds.length; i += 1) {
        const idPath = `${path}.block_ids[${i}]`
        const id = checkKnownBlockId(ctx, blockIds[i], idPath)
        if (id === null) continue
        placeBlock(ctx, id, idPath)
        placedHere.add(id)
      }
    }
  }
  const scope: SectionScope = { path, blocks: placedHere }

  const declaredFieldKeys = new Set<string>()
  const fields = raw.fields
  if (fields !== undefined) {
    if (!isPlainObject(fields)) {
      pushHard(ctx, 'SCHEMA_INVALID', `section ${path} fields must be an object`, path)
    } else {
      for (const key of Object.keys(fields).sort()) {
        declaredFieldKeys.add(key)
        checkField(ctx, `${path}.fields.${key}`, key, fields[key], scope)
      }
    }
  }

  const entries = raw.entries
  if (entries !== undefined) {
    if (!Array.isArray(entries)) {
      pushHard(ctx, 'SCHEMA_INVALID', `section ${path} entries must be an array`, path)
    } else {
      for (let i = 0; i < entries.length; i += 1) {
        checkEntry(ctx, `${path}.entries[${i}]`, label, entries[i], workPeriods, scope)
      }
    }
  }

  if (label !== null) {
    const required = REQUIRED_SECTION_FIELDS[label]
    if (required !== undefined) {
      for (const key of required) {
        if (!declaredFieldKeys.has(key)) {
          pushHard(
            ctx,
            'MISSING_FIELD',
            `section ${path} (label "${label}") omits field "${key}"; omission is not "absent"`,
            `${path}.fields.${key}`,
          )
        }
      }
    }
  }
}

/** 跨字段一致性（软）：起始年不晚于结束年、两段工作经历不完全重叠。 */
function checkWorkPeriods(ctx: ValidationContext, periods: readonly WorkPeriod[]): void {
  for (const period of periods) {
    const startYear = period.start.year
    const endYear = period.end.year
    if (startYear !== null && endYear !== null && startYear > endYear) {
      pushSoft(
        ctx,
        'WORK_PERIOD_INVERTED',
        `work period starts in ${startYear} but ends in ${endYear}`,
        period.path,
      )
    }
  }
  for (let i = 0; i < periods.length; i += 1) {
    for (let j = i + 1; j < periods.length; j += 1) {
      const a = periods[i]
      const b = periods[j]
      if (a === undefined || b === undefined) continue
      const aStart = monthOrdinal(a.start, 'start')
      const aEnd = monthOrdinal(a.end, 'end')
      const bStart = monthOrdinal(b.start, 'start')
      const bEnd = monthOrdinal(b.end, 'end')
      const aCoversB = aStart <= bStart && bEnd <= aEnd
      const bCoversA = bStart <= aStart && aEnd <= bEnd
      if (aCoversB || bCoversA) {
        pushSoft(
          ctx,
          'WORK_PERIOD_OVERLAP',
          `work periods fully overlap: ${a.path} and ${b.path}`,
          a.path,
        )
      }
    }
  }
}

/**
 * 校验模型返回的结构化结果。
 * 纯函数：不读文件、不写文件、不调用模型、不取当前时间。
 * @param input - 结果 + block_index + 原始块文本。
 * @returns accepted / rejected / issues（+ stats）。
 */
export function validate(input: ValidateInput): ValidateResult {
  const index = input.blockIndex
  if (!isPlainObject(index) || !Array.isArray(index.entries)) {
    return {
      accepted: false,
      rejected: [
        { code: 'SCHEMA_INVALID', message: 'block_index must be an object with an entries array', path: 'block_index' },
      ],
      issues: [
        {
          code: 'SCHEMA_INVALID',
          severity: 'hard',
          message: 'block_index must be an object with an entries array',
          path: 'block_index',
        },
      ],
      stats: { index_entries: 0, covered: 0, ignored: 0, fields: 0, entries: 0, hard: 1, soft: 0 },
    }
  }

  const blocks = Array.isArray(input.blocks) ? input.blocks : []
  const ctx = createContext(index, blocks)
  if (index.version !== BLOCK_INDEX_VERSION) {
    pushHard(
      ctx,
      'BLOCK_INDEX_VERSION_UNSUPPORTED',
      `block_index version ${showValue(index.version)} is not supported (expected ${BLOCK_INDEX_VERSION})`,
      'block_index.version',
    )
  }

  const result = input.result
  const workPeriods: WorkPeriod[] = []
  if (!isPlainObject(result)) {
    pushHard(ctx, 'SCHEMA_INVALID', `result must be an object, got ${showValue(result)}`, 'result')
  } else {
    const sections = result.sections
    if (sections === undefined) {
      pushHard(ctx, 'SCHEMA_INVALID', 'result.sections is required (an empty array is allowed)', 'sections')
    } else if (!Array.isArray(sections)) {
      pushHard(ctx, 'SCHEMA_INVALID', 'result.sections must be an array', 'sections')
    } else {
      for (let i = 0; i < sections.length; i += 1) {
        checkSection(ctx, `sections[${i}]`, sections[i], workPeriods)
      }
    }

    const ignored = result.ignored
    if (ignored !== undefined) {
      if (!Array.isArray(ignored)) {
        pushHard(ctx, 'SCHEMA_INVALID', 'result.ignored must be an array', 'ignored')
      } else {
        for (let i = 0; i < ignored.length; i += 1) {
          const item = ignored[i]
          const path = `ignored[${i}]`
          if (!isPlainObject(item)) {
            pushHard(ctx, 'SCHEMA_INVALID', `ignored entry ${path} must be an object`, path)
            continue
          }
          const blockId = checkKnownBlockId(ctx, item.block_id, `${path}.block_id`)
          const reason = item.reason
          const reasonOk = typeof reason === 'string' && reason.trim() !== ''
          if (!reasonOk) {
            // reason 不合法的 ignored 不算归类：这条 block 仍然没被归入任何 section（覆盖率会再报一次）。
            pushHard(
              ctx,
              'IGNORED_MISSING_REASON',
              `ignored entry ${path} must carry a non-empty reason`,
              `${path}.reason`,
            )
            continue
          }
          if (blockId !== null) {
            const alreadyIgnored = ctx.ignoredCovered.get(blockId)
            if (alreadyIgnored !== undefined) {
              // 同一个块被 ignore 两次同样是双记账（D-31 §1 的「恰好一次」）。
              pushHard(
                ctx,
                'BLOCK_DUPLICATED',
                `block ${blockId} is ignored more than once (first at ${alreadyIgnored}, again at ${path})`,
                path,
                blockId,
              )
              continue
            }
            ctx.ignoredCovered.set(blockId, path)
            ctx.ignored += 1
          }
        }
      }
    }

    // D-31 §2：被 ignored 的块不得再被任何字段 / 条目引用（引用 = 把 ignored 当逃生舱）。
    for (const ref of ctx.refs) {
      const ignoredAt = ctx.ignoredCovered.get(ref.id)
      if (ignoredAt !== undefined) {
        pushHard(
          ctx,
          'IGNORED_BLOCK_REFERENCED',
          `block ${ref.id} is ignored at ${ignoredAt} but is still cited at ${ref.path}; an ignored block must not be used as evidence`,
          ref.path,
          ref.id,
        )
      }
    }

    // D-31 §2：ignored 与 section 分区互斥——既 ignored 又放进 section 是双记账，直接拒绝。
    for (const [id, ignoredAt] of ctx.ignoredCovered) {
      const placedAt = ctx.placed.get(id)
      if (placedAt !== undefined) {
        pushHard(
          ctx,
          'BLOCK_DUPLICATED',
          `block ${id} is ignored at ${ignoredAt} and also placed at ${placedAt}; ignored blocks must not belong to a section`,
          ignoredAt,
          id,
        )
      }
    }

    // D-31 §3：字段引用的块必须属于该字段所在 section（contact 类字段除外）。
    for (const citation of ctx.fieldCitations) {
      if ((CONTACT_FIELD_KEYS as readonly string[]).includes(citation.key)) continue
      for (const id of citation.ids) {
        if (citation.sectionBlocks.has(id)) continue
        const placedAt = ctx.placed.get(id)
        pushHard(
          ctx,
          'FIELD_BLOCK_NOT_IN_SECTION',
          `field ${citation.path} cites block ${id}, which ${placedAt === undefined ? 'is not placed in any section' : `is placed at ${placedAt}`}; ${citation.sectionPath} does not own it (a field may only cite blocks of its own section; contact fields are exempt)`,
          citation.path,
          id,
        )
      }
    }

    checkWorkPeriods(ctx, workPeriods)
  }

  // 覆盖率（D-31 §1）：每个 block 必须**恰好**归入一个 section，或被带 reason 的 ignored 明确排除。
  for (const entry of index.entries) {
    if (!ctx.placed.has(entry.id) && !ctx.ignoredCovered.has(entry.id)) {
      pushHard(
        ctx,
        'UNCOVERED_BLOCK',
        `block ${entry.id} (page ${entry.page === null ? '?' : String(entry.page)}) is neither placed in a section nor ignored with a reason`,
        `block_index[${entry.id}]`,
        entry.id,
      )
    }
  }

  const rejected: Rejection[] = []
  let hard = 0
  let soft = 0
  for (const issue of ctx.issues) {
    if (issue.severity === 'hard') hard += 1
    else soft += 1
  }
  for (const issue of ctx.issues) {
    if (issue.severity !== 'hard') continue
    rejected.push(
      issue.block_id === undefined
        ? { code: issue.code, message: issue.message, path: issue.path }
        : { code: issue.code, message: issue.message, path: issue.path, block_id: issue.block_id },
    )
  }

  const coveredIds = new Set<number>()
  for (const id of ctx.placed.keys()) coveredIds.add(id)
  for (const id of ctx.ignoredCovered.keys()) coveredIds.add(id)

  return {
    accepted: rejected.length === 0,
    rejected,
    issues: ctx.issues,
    stats: {
      index_entries: index.entries.length,
      covered: coveredIds.size,
      ignored: ctx.ignored,
      fields: ctx.fields,
      entries: ctx.entryCount,
      hard,
      soft,
    },
  }
}
