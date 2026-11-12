// 确定性校验层（B 层）：模型返回的结构化结果 × block_index × 原始块文本。
//
// 这一层不调用任何模型、不联网、不读文件：输入是三个已经存在的内存值，输出是
// { accepted, rejected[], issues[] }。判定只看机械规则，不做语义判断。
//
// **形状以 contracts/schema.json 为权威**。模型看到的输出形状（`$defs`）是：
//
//   result
//   ├── prompt_version / schema_version / block_count        （$defs，本层只做透传，不核对常量）
//   ├── sections[]                                           （$defs.section）
//   │   └── { label, block_ids, ignored? }                   ← 只有这三个键（additionalProperties: false）
//   │        ignored = { reason, detail? }                   ← 存在即表示这些块不参与字段抽取
//   └── fields                                               （$defs.fields：五个键恒在）
//       ├── name / phone / email                             （$defs.identity_field：state + value? + block_ids + reason?）
//       ├── work_experience                                  （$defs.structural_field）
//       │   └── value: [ $defs.work_entry ]                  ← 条目挂在 **value[]**，不是 entries[]
//       └── education                                        （$defs.education_field）
//           └── value: [ $defs.education_entry ]
//
// 条目的**事实键是平铺的**（work_entry 的 company/title/start/end、education_entry 的
// school/major/degree/start/end），不是嵌在 `entry.fields` 里；每个事实是一个 `$defs.fact`
// = `{ value: string|null, block_ids }`。
//
// **本层不承认契约里不存在的位置**：`sections[].fields`、`sections[].entries`、
// `entries[].fields`、顶层 `ignored[]` 一律 → `SCHEMA_INVALID`（不静默忽略：静默忽略会让
// 一份「校验通过」的输出其实没被检查过）。
//
// 八条规则（每条都有单测）：
//   1. id 存在性      —— 结果里引用的每个 block id 必须在 block_index 里；
//   2. 值必须可回查   —— present 的 value / fact 的 value 必须在「所引用块按序拼接后的文本」里逐字找到
//                        （D-30：块粒度是视觉行，一句话可以跨连续块；只允许三种**固定**归一化，
//                         见 normalizeForMatch()。**不是**「语义相等」——D-32 明令不得放宽）；
//   3. id 分区        —— 每个 block 必须**恰好**归入一个 section 的 block_ids，或被带合法 ignored.reason
//                        的 section 标记排除（D-31：重复出现 = 拒绝；ignored 块不得再被引用；
//                        覆盖率证明的是「没漏块」，不证明「处理对了」）；
//   4. 标签枚举      —— section.label 必须在 SECTION_LABELS 内；
//   5. 状态枚举      —— 每个字段必须带 state ∈ {present, absent, unreadable}；
//   6. 数字专项      —— phone / email / date 各自的格式 + 与原文一致；
//   7. 跨字段一致性  —— 起始年份不得晚于结束年份、两段工作经历不得完全重叠（软：记 issue 不拒绝）；
//   8. 不允许省略字段 —— 顶层 fields 的五个键（契约 $defs.fields.required）与条目的事实键
//                        （$defs.work_entry.required / $defs.education_entry.required）缺一即拒绝
//                        （省略 ≠ absent）。
//
// 软 / 硬的分界：issues[] 里两类都记（severity = 'hard' | 'soft'），rejected[] 只装 hard。
// accepted === (rejected.length === 0)。
//
// 额外加的三条（都是为了让「账能平」，不是业务判断）：
//   * BLOCK_INDEX_INTEGRITY —— block_index 的 sha256 与传入的原始块文本对不上（索引/原文被换过）；
//   * BLOCK_INDEX_VERSION_UNSUPPORTED —— 不认识的索引版本（不猜结构）；
//   * UNREADABLE_MISSING_REASON —— unreadable 必须说明为什么读不出来（doc 11 §9.2 的红线）。
//
// D-30 / D-31 的四条（同样是机械检查，不是语义判断）：
//   * BLOCK_IDS_NOT_CONSECUTIVE —— **一个值**的引用列表必须连续且有序（相邻 id）；
//     字段级（`fields.<work_experience|education>.block_ids`）是**聚合超集**，只要求「升序、不重复」。
//     依据：`$defs.block_ids` 原文只写「按升序、不重复」；`$comment` (3) 说字段级 block_ids 是
//     entries 的**超集**、(5) 说 ignored 块不得进字段 block_ids——教育经历被中间的符号块
//     （ignored）分开时，(3)+(5)+「必须相邻」三者不可能同时成立；prompt.md §4 也明写
//     「`block_ids` 因此可以是不连续的，如 ["23","24","25","27"]」。
//   * BLOCK_DUPLICATED —— 同一个 block 被放进一个以上的 section（或同一 section 写两次）；
//   * IGNORED_BLOCK_REFERENCED —— 被 ignored 的 block 又被字段 / 条目引用；
//   * BLOCK_IDS_NOT_SUPERSET —— 条目 block_ids 必须覆盖它各事实引用的块；字段 block_ids 必须覆盖
//     它各条目引用的块（schema.json `$comment` 不变量 (3)：字段级 block_ids 是 entries 的超集）。
//
// 契约对齐（本轮）：字段的位置从 `sections[i].fields` 搬回顶层 `fields`；条目从
// `sections[i].entries` 搬到 `fields.<work_experience|education>.value[]`；条目事实从
// `entry.fields.<key>` 搬到 `entry.<key>`。旧的 `FIELD_BLOCK_NOT_IN_SECTION`（字段必须引用本
// section 的块）随之删除：契约 prompt.md §6.1 明写「取值不受 section 限制」，而且顶层字段
// 根本没有「所在 section」这个锚点。`REQUIRED_SECTION_FIELDS`（contact → name/phone/email）
// 在契约里没有对应位置，改成文档层的 `REQUIRED_DOCUMENT_FIELDS`（$defs.fields.required 五项）。
//
// 归一化只用于比较：**原文与 block_index 里保存的文本 / sha256 一个字符都不改**（D-30 §4）。

import type { BlockIndex, BlockIndexEntry, SourceBlock } from './serialize.ts'
import { BLOCK_INDEX_VERSION, NEWLINE_ESCAPE, sha256Hex, toCodePoints } from './serialize.ts'

/** 允许的 section 标签（封闭集合；表外标签一律拒绝，不静默归类）。 */
// 与 contracts/schema.json 的 $defs.section.label 逐字一致（13 个，D-26 允许 research）。
// 契约是模型看到的那一份，校验器必须服从契约，不能各用一套。
export const SECTION_LABELS = [
  'contact',
  'summary',
  'work_experience',
  'internship',
  'project',
  'research',
  'education',
  'skill',
  'award',
  'certificate',
  'publication',
  'self_evaluation',
  'other',
] as const

/** section 标签类型。 */
export type SectionLabel = (typeof SECTION_LABELS)[number]

/**
 * section 允许的键（contracts/schema.json → `$defs.section`，`additionalProperties: false`）。
 * `fields` / `entries` **不在**这里：契约把它们放在顶层 `fields` 里。
 */
export const SECTION_KEYS = ['label', 'block_ids', 'ignored'] as const

/** `section.ignored` 允许的键（`$defs.ignored`）。 */
export const IGNORED_KEYS = ['reason', 'detail'] as const

/** 字段三态（doc 11 §9.2 / `$defs.state`）。 */
export const FIELD_STATES = ['present', 'absent', 'unreadable'] as const

/** 字段状态类型。 */
export type FieldState = (typeof FIELD_STATES)[number]

/**
 * 文档级五个字段（contracts/schema.json → `$defs.fields.required`）。
 * 五个键**恒在**：没读到就写 absent / unreadable，**不允许省略**（省略 ≠ absent）。
 */
export const REQUIRED_DOCUMENT_FIELDS = ['name', 'phone', 'email', 'work_experience', 'education'] as const

/** 文档级字段名类型。 */
export type DocumentFieldKey = (typeof REQUIRED_DOCUMENT_FIELDS)[number]

/** 单值字段（`$defs.identity_field`）。 */
export const IDENTITY_FIELD_KEYS = ['name', 'phone', 'email'] as const

/** 条目数组字段（`$defs.structural_field` / `$defs.education_field`）——条目在 `.value[]` 里。 */
export const ENTRY_FIELD_KEYS = ['work_experience', 'education'] as const

/** 条目数组字段名类型。 */
export type EntryFieldKey = (typeof ENTRY_FIELD_KEYS)[number]

/**
 * 每个条目必须出现的事实键（`$defs.work_entry.required` / `$defs.education_entry.required`
 * 里的事实部分；`block_ids` / `attribution` 是结构键，另查）。
 * 位置：`fields.<work_experience|education>.value[i].<key>`。
 */
export const REQUIRED_ENTRY_FIELDS: Readonly<Record<EntryFieldKey, readonly string[]>> = {
  work_experience: ['company', 'title', 'start', 'end'],
  education: ['school', 'major', 'degree', 'start', 'end'],
}

/** 条目对象允许的键（`$defs.work_entry` / `$defs.education_entry` 的 properties）。 */
const ENTRY_KEYS: Readonly<Record<EntryFieldKey, readonly string[]>> = {
  work_experience: [...REQUIRED_ENTRY_FIELDS.work_experience, 'block_ids', 'attribution', 'reason', 'reason_note'],
  education: [...REQUIRED_ENTRY_FIELDS.education, 'block_ids', 'attribution', 'reason', 'reason_note'],
}

/** 字段对象允许的键（`$defs.identity_field` / `structural_field` / `education_field` 都是这五个）。 */
export const FIELD_KEYS = ['state', 'value', 'block_ids', 'reason', 'reason_note'] as const

/** 事实对象允许的键（`$defs.fact`）。 */
export const FACT_KEYS = ['value', 'block_ids'] as const

/** 归属枚举（`$defs.attribution`）。 */
export const ATTRIBUTIONS = ['single_block', 'same_row_multi_block'] as const

/** 需要做日期专项校验的事实键。 */
export const DATE_FIELD_KEYS = ['start', 'end'] as const

/** 顶层结果允许的键（`schema.json` 的根 `properties`，`additionalProperties: false`）。 */
export const RESULT_KEYS = ['prompt_version', 'schema_version', 'block_count', 'sections', 'fields'] as const

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
  | 'BLOCK_IDS_NOT_SUPERSET'
  | 'BLOCK_DUPLICATED'
  | 'IGNORED_BLOCK_REFERENCED'
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
  /** 结果里的位置，如 `fields.phone` / `fields.work_experience.value[0]` / `sections[2].block_ids[0]`。 */
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

interface ValidationContext {
  readonly issues: ValidationIssue[]
  readonly entries: ReadonlyMap<number, BlockIndexEntry>
  readonly texts: ReadonlyMap<number, string>
  /** 被 section.block_ids 放进分区的 id -> 第一次放置它的 path（D-31 §1）。 */
  readonly placed: Map<number, string>
  /** 带合法 reason 的 ignored section 覆盖的 id -> 该 section 的 path（D-31 §2）。 */
  readonly ignoredCovered: Map<number, string>
  /** ignored 标记不成立（缺 reason / 不是对象）的 section 的 id —— 不算归类，覆盖率会再报一次。 */
  readonly ignoredInvalid: Set<number>
  /** 字段 / 条目 / 事实引用过的块（IGNORED_BLOCK_REFERENCED 用）。 */
  readonly refs: Array<{ readonly id: number; readonly path: string }>
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

/** 一个值（字段 / 事实）的校验结论。 */
interface CheckedValue {
  readonly value: string | null
  readonly ids: readonly number[]
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

/**
 * 引用 id 列表是否「升序且不重复」——`$defs.block_ids` 的**原文**要求
 * （"引用块列表，按升序、不重复"；契约里没有「必须相邻」这一条）。
 */
function isAscendingUnique(ids: readonly number[]): boolean {
  for (let i = 1; i < ids.length; i += 1) {
    if ((ids[i] as number) <= (ids[i - 1] as number)) return false
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

/** 记一次字段 / 条目 / 事实的块引用（IGNORED_BLOCK_REFERENCED 用）。 */
function noteRef(ctx: ValidationContext, id: number, path: string): void {
  ctx.refs.push({ id, path })
}

/**
 * 只允许契约写明的键。契约的每个对象都是 `additionalProperties: false`，
 * 所以出现表外的键（尤其 `sections[].fields` / `sections[].entries` / `entries[].fields`）
 * 一律拒绝，**不静默忽略**。
 */
function checkAllowedKeys(
  ctx: ValidationContext,
  path: string,
  raw: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  for (const key of Object.keys(raw).sort()) {
    if (allowed.includes(key)) continue
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `${subject} ${path} carries key ${JSON.stringify(key)}, which the contract does not allow (allowed: ${allowed.join(', ')})`,
      `${path}.${key}`,
    )
  }
}

/** 建 ctx：解析索引、逐 id 校准原文与 sha256。 */
function createContext(index: BlockIndex, blocks: readonly (SourceBlock | string)[]): ValidationContext {
  const ctx: ValidationContext = {
    issues: [],
    entries: new Map<number, BlockIndexEntry>(),
    texts: new Map<number, string>(),
    placed: new Map<number, string>(),
    ignoredCovered: new Map<number, string>(),
    ignoredInvalid: new Set<number>(),
    refs: [],
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

/**
 * 解析一个 block 引用。
 *
 * 契约（contracts/schema.json 的 $defs.block_id）用**字符串** `"12"` 对应输入的 `#12`（D-27）；
 * 同时接受整数以兼容旧输出。空串、0、负数、带前导零、非数字一律返回 null（由调用方记 issue）。
 */
function parseBlockIdValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? raw : null
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!/^[1-9]\d{0,5}$/.test(trimmed)) return null
    return Number(trimmed)
  }
  return null
}

/** 校验一个 block 引用是否存在（不改变覆盖状态）。 */
function checkKnownBlockId(ctx: ValidationContext, raw: unknown, path: string): number | null {
  const id = parseBlockIdValue(raw)
  if (id === null) {
    pushHard(ctx, 'UNKNOWN_BLOCK_ID', `block id must be a positive integer or numeric string, got ${showValue(raw)}`, path)
    return null
  }
  if (!ctx.entries.has(id)) {
    pushHard(ctx, 'UNKNOWN_BLOCK_ID', `block id ${id} is not in block_index`, path, id)
    return null
  }
  return id
}

/**
 * 解析一个 `block_ids` 列表（契约里字段 / 条目 / 事实的唯一引用写法）。
 *
 * 校验：是数组、每项是存在的 block id、按升序不重复；`consecutive=true` 时还要求**相邻**
 * （D-30 §1/§2：一个**值**跨块拼接时，引用的必须是连续的视觉行）。
 * 契约（`$defs.identity_field` / `structural_field` / `fact` 的 required）要求这个键恒在，
 * 缺失 → `SCHEMA_INVALID`（不是「没引用」，是形状不对）。
 * @param required - 缺失时是否报 `SCHEMA_INVALID`。
 * @param consecutive - 是否要求相邻。**只有「一个值」的引用**才要求；聚合列表见 checkEntryField。
 * @returns 按序排列的 id 列表（空数组 = 合法但没引用）；不合法时已记 issue 并返回 null。
 */
function parseBlockIdList(
  ctx: ValidationContext,
  path: string,
  raw: Record<string, unknown>,
  required: boolean,
  consecutive = true,
): number[] | null {
  const listRaw = raw.block_ids
  if (listRaw === undefined || listRaw === null) {
    if (required) {
      pushHard(
        ctx,
        'SCHEMA_INVALID',
        `${path} is missing block_ids; the contract requires a block id list on every field, entry and fact`,
        path,
      )
      return null
    }
    return []
  }
  if (!Array.isArray(listRaw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `${path} block_ids must be an array`, path)
    return null
  }
  const ids: number[] = []
  let broken = false
  for (let i = 0; i < listRaw.length; i += 1) {
    const itemPath = `${path}.block_ids[${i}]`
    const id = checkKnownBlockId(ctx, listRaw[i], itemPath)
    if (id === null) {
      broken = true
      continue
    }
    ids.push(id)
    noteRef(ctx, id, itemPath)
  }
  if (broken) return null
  if (consecutive) {
    // 引用列表是「按序拼接」的证据，必须连续且有序（D-30 §1/§2）。
    if (!isConsecutive(ids)) {
      pushHard(
        ctx,
        'BLOCK_IDS_NOT_CONSECUTIVE',
        `${path} cites blocks ${ids.join(', ')}; a value may only be matched across consecutive, ascending block ids`,
        path,
        ids[0],
      )
      return null
    }
    return ids
  }
  // 聚合列表（字段级超集）：契约只要求「升序、不重复」。要求相邻会与 $comment (3)+(5) 打架，
  // 因为跨过一个 ignored 块（例如 education 中间的符号块）时，超集必然是不连续的。
  if (!isAscendingUnique(ids)) {
    pushHard(
      ctx,
      'BLOCK_IDS_NOT_CONSECUTIVE',
      `${path} block_ids must be ascending and unique, got ${ids.join(', ')}`,
      path,
      ids[0],
    )
    return null
  }
  return ids
}

/** 读取 state（三个字段类型 / 三个状态）。 */
function readState(ctx: ValidationContext, path: string, raw: Record<string, unknown>): FieldState | null {
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
  return stateRaw as FieldState
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

/** 单值字段层面的数字专项（按字段名分派）。 */
function checkScalarSpecial(
  ctx: ValidationContext,
  key: string,
  value: string,
  joined: string,
  path: string,
  blockId: number,
): void {
  if (key === 'phone') checkPhone(ctx, value, joined, path, blockId)
  else if (key === 'email') checkEmail(ctx, value, joined, path, blockId)
}

/**
 * 校验一个 `$defs.fact`（条目里的 company / title / start / end / school / major / degree）。
 * 事实**没有 state**：`value` 必须出现（读不出就写 null），`block_ids` 恒在。
 * @returns 校验结论；形状不对返回 null。
 */
function checkFact(
  ctx: ValidationContext,
  path: string,
  key: string,
  raw: unknown,
): CheckedValue | null {
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `fact ${path} must be an object ({ value, block_ids })`, path)
    return null
  }
  checkAllowedKeys(ctx, path, raw, FACT_KEYS, 'fact')
  if (!('value' in raw)) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `fact ${path} is missing value; the contract requires value on every fact (write null when it cannot be read)`,
      path,
    )
    return null
  }
  const valueRaw = raw.value
  let value: string | null = null
  if (typeof valueRaw === 'string') {
    if (valueRaw.trim() === '') {
      pushHard(ctx, 'SCHEMA_INVALID', `fact ${path} value must be a non-empty string or null`, path)
      return null
    }
    value = valueRaw
  } else if (valueRaw !== null) {
    pushHard(ctx, 'SCHEMA_INVALID', `fact ${path} value must be a string or null, got ${showValue(valueRaw)}`, path)
    return null
  }

  const cited = parseBlockIdList(ctx, path, raw, true)
  if (cited === null) return null
  if (value === null) return { value: null, ids: cited, date: null }
  if (cited.length === 0) {
    pushHard(ctx, 'MISSING_BLOCK_ID', `fact ${path} has a value but no block_ids to prove it`, path)
    return { value, ids: cited, date: null }
  }

  const texts: string[] = []
  for (const id of cited) {
    const text = ctx.texts.get(id)
    if (text === undefined) return { value, ids: cited, date: null } // 索引完整性问题已单独记过
    texts.push(text)
  }
  const first = cited[0] as number
  let substringOk = true
  if (!valueMatchesTexts(texts, value)) {
    pushHard(
      ctx,
      'VALUE_NOT_IN_BLOCK',
      `fact ${path} value ${JSON.stringify(value.trim())} is not found in the text of cited block(s) ${cited.join('+')} after the fixed normalizations (no semantic matching)`,
      path,
      first,
    )
    substringOk = false
  }
  let date: ParsedDate | null = null
  if ((DATE_FIELD_KEYS as readonly string[]).includes(key)) {
    const parsed = checkDate(ctx, value, texts.join(' '), path, first)
    // 值都不在原文里时，不拿它去做跨字段一致性（避免用幻觉值再派生软 issue）。
    date = substringOk ? parsed : null
  }
  return { value, ids: cited, date }
}

/**
 * 校验一个 `$defs.identity_field`（name / phone / email）：三态 + 块引用 + 值匹配 + 数字专项。
 * 位置：`fields.<name|phone|email>`。
 */
function checkIdentityField(
  ctx: ValidationContext,
  path: string,
  key: string,
  raw: unknown,
): CheckedValue | null {
  ctx.fields += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `field ${path} must be an object`, path)
    return null
  }
  checkAllowedKeys(ctx, path, raw, FIELD_KEYS, 'field')
  const state = readState(ctx, path, raw)
  if (state === null) return null

  const valueRaw = raw.value
  let value: string | null = null
  if (typeof valueRaw === 'string') value = valueRaw
  else if (valueRaw !== null && valueRaw !== undefined) {
    pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} value must be a string or null`, path)
    return null
  }

  const cited = parseBlockIdList(ctx, path, raw, true)
  if (cited === null) return null

  if (state === 'present') {
    if (value === null || value.trim() === '') {
      pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is present but has no value`, path)
      return null
    }
    if (cited.length === 0) {
      pushHard(ctx, 'MISSING_BLOCK_ID', `field ${path} is present but has no block_ids`, path)
      return null
    }
    const first = cited[0] as number
    const texts: string[] = []
    for (const id of cited) {
      const text = ctx.texts.get(id)
      if (text === undefined) return { value, ids: cited, date: null } // 索引完整性问题已单独记过
      texts.push(text)
    }
    if (!valueMatchesTexts(texts, value)) {
      pushHard(
        ctx,
        'VALUE_NOT_IN_BLOCK',
        `field ${path} value ${JSON.stringify(value.trim())} is not found in the text of cited block(s) ${cited.join('+')} after the fixed normalizations (no semantic matching)`,
        path,
        first,
      )
    }
    // 数字专项独立判定（规则 6 不因为规则 2 失败就不查）。
    checkScalarSpecial(ctx, key, value, texts.join(' '), path, first)
    return { value, ids: cited, date: null }
  }

  if (value !== null) {
    pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is ${state} but carries a value`, path)
    return null
  }
  if (state === 'absent' && cited.length > 0) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `field ${path} is absent but cites block(s) ${cited.join(', ')}; absent must carry an empty block_ids (prompt.md §3.1)`,
      path,
    )
  }
  if (state === 'unreadable') {
    const reason = raw.reason
    if (typeof reason !== 'string' || reason.trim() === '') {
      pushHard(ctx, 'UNREADABLE_MISSING_REASON', `field ${path} is unreadable but has no reason`, path)
    }
  }
  return { value: null, ids: cited, date: null }
}

/**
 * 校验一个条目（`fields.<work_experience|education>.value[i]`）。
 *
 * 契约里条目是**平铺**的：事实键（company/title/start/end 或 school/major/degree/start/end）
 * 与 `block_ids` / `attribution` / `reason` 同级，没有 `fields` 子对象。
 * @returns 条目自己声明的块 id（字段级超集检查用）；形状不对返回 null。
 */
function checkEntry(
  ctx: ValidationContext,
  path: string,
  fieldKey: EntryFieldKey,
  raw: unknown,
  workPeriods: WorkPeriod[],
): readonly number[] | null {
  ctx.entryCount += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `entry ${path} must be an object`, path)
    return null
  }
  checkAllowedKeys(ctx, path, raw, ENTRY_KEYS[fieldKey], 'entry')
  const declared = new Set(Object.keys(raw))

  const entryIds = parseBlockIdList(ctx, path, raw, true)

  const checked = new Map<string, CheckedValue>()
  for (const key of REQUIRED_ENTRY_FIELDS[fieldKey]) {
    // 「省略」才报 MISSING_*；写坏了是别的 code 的事，不重复报成缺失。
    if (!declared.has(key)) {
      pushHard(
        ctx,
        'MISSING_ENTRY_FIELD',
        `entry ${path} omits field "${key}"; omission is not "absent"`,
        `${path}.${key}`,
      )
      continue
    }
    const fact = checkFact(ctx, `${path}.${key}`, key, raw[key])
    if (fact !== null) checked.set(key, fact)
  }

  if (!declared.has('attribution')) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `entry ${path} is missing attribution; the contract requires it on every entry`,
      path,
    )
  } else if (!(ATTRIBUTIONS as readonly string[]).includes(String(raw.attribution))) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `entry ${path} attribution ${showValue(raw.attribution)} is not one of: ${ATTRIBUTIONS.join(', ')}`,
      `${path}.attribution`,
    )
  }

  // $comment 不变量 (3) 的前半：条目 block_ids 必须覆盖它各事实引用的块。
  if (entryIds !== null) {
    const own = new Set(entryIds)
    for (const [key, fact] of checked) {
      for (const id of fact.ids) {
        if (own.has(id)) continue
        pushHard(
          ctx,
          'BLOCK_IDS_NOT_SUPERSET',
          `entry ${path} block_ids do not include block ${id}, which its fact "${key}" cites; entry block_ids must cover every fact block`,
          `${path}.block_ids`,
          id,
        )
      }
    }
  }

  if (fieldKey === 'work_experience') {
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
  return entryIds
}

/**
 * 校验一个条目数组字段（`$defs.structural_field` / `education_field`）。
 * 位置：`fields.work_experience` / `fields.education`；条目在 **`value[]`**（不是 `entries[]`）。
 *
 * 字段自己的 `block_ids` 是 `$comment` (3) 说的**超集**（entries[*].block_ids ∪ 证据块），
 * 不是「一个值的拼接范围」：它只要求升序、不重复，**不要求相邻**——否则跨过一个 ignored 块
 * （如 education 中间那个 `•`）就必然自相矛盾（$comment (3)+(5)）。
 */
function checkEntryField(
  ctx: ValidationContext,
  path: string,
  fieldKey: EntryFieldKey,
  raw: unknown,
  workPeriods: WorkPeriod[],
): void {
  ctx.fields += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `field ${path} must be an object`, path)
    return
  }
  checkAllowedKeys(ctx, path, raw, FIELD_KEYS, 'field')
  const state = readState(ctx, path, raw)
  if (state === null) return
  const cited = parseBlockIdList(ctx, path, raw, true, false)

  const valueRaw = raw.value
  const hasValue = valueRaw !== undefined && valueRaw !== null

  if (state !== 'present') {
    if (hasValue) {
      pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is ${state} but carries a value`, path)
      return
    }
    if (state === 'absent' && cited !== null && cited.length > 0) {
      pushHard(
        ctx,
        'SCHEMA_INVALID',
        `field ${path} is absent but cites block(s) ${cited.join(', ')}; absent must carry an empty block_ids (prompt.md §3.1)`,
        path,
      )
    }
    if (state === 'unreadable') {
      const reason = raw.reason
      if (typeof reason !== 'string' || reason.trim() === '') {
        pushHard(ctx, 'UNREADABLE_MISSING_REASON', `field ${path} is unreadable but has no reason`, path)
      }
    }
    return
  }

  if (!hasValue) {
    pushHard(ctx, 'STATE_VALUE_CONFLICT', `field ${path} is present but has no value array`, path)
    return
  }
  if (!Array.isArray(valueRaw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `field ${path} value must be an array of entries when present`, path)
    return
  }
  if (valueRaw.length === 0) {
    pushHard(ctx, 'SCHEMA_INVALID', `field ${path} value must not be empty when present`, path)
    return
  }
  if (cited !== null && cited.length === 0) {
    pushHard(ctx, 'MISSING_BLOCK_ID', `field ${path} is present but has no block_ids`, path)
  }

  const fieldSet = cited === null ? null : new Set(cited)
  for (let i = 0; i < valueRaw.length; i += 1) {
    const entryPath = `${path}.value[${i}]`
    const entryIds = checkEntry(ctx, entryPath, fieldKey, valueRaw[i], workPeriods)
    // $comment 不变量 (3)：字段级 block_ids 必须是其 entries[*].block_ids 的超集。
    if (entryIds === null || fieldSet === null || fieldSet.size === 0) continue
    for (const id of entryIds) {
      if (fieldSet.has(id)) continue
      pushHard(
        ctx,
        'BLOCK_IDS_NOT_SUPERSET',
        `field ${path} block_ids do not include block ${id}, which ${entryPath} cites; field block_ids must be a superset of every entry's block_ids`,
        `${path}.block_ids`,
        id,
      )
    }
  }
}

/**
 * 校验顶层 `fields`（`$defs.fields`）：五个键**恒在**，缺一 → MISSING_FIELD（省略 ≠ absent）。
 * 受保护属性（年龄/性别/婚育/籍贯/民族/照片）在契约里**没有位置**，出现即 SCHEMA_INVALID。
 */
function checkDocumentFields(
  ctx: ValidationContext,
  raw: unknown,
  workPeriods: WorkPeriod[],
): void {
  if (raw === undefined) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      'result.fields is required; the five fields (name / phone / email / work_experience / education) are always present',
      'fields',
    )
    return
  }
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', 'result.fields must be an object', 'fields')
    return
  }
  checkAllowedKeys(ctx, 'fields', raw, REQUIRED_DOCUMENT_FIELDS, 'fields')
  for (const key of REQUIRED_DOCUMENT_FIELDS) {
    if (!(key in raw)) {
      pushHard(
        ctx,
        'MISSING_FIELD',
        `field "fields.${key}" is omitted; the contract requires all five keys (omission is not "absent")`,
        `fields.${key}`,
      )
      continue
    }
    if (key === 'work_experience' || key === 'education') {
      checkEntryField(ctx, `fields.${key}`, key, raw[key], workPeriods)
    } else {
      checkIdentityField(ctx, `fields.${key}`, key, raw[key])
    }
  }
}

/**
 * 校验一个 section（`$defs.section`）：标签 + block 分区 + ignored。
 *
 * **契约里 section 没有 fields / entries**（additionalProperties: false）：这两个键由
 * checkAllowedKeys() 记成 SCHEMA_INVALID——它们属于顶层 `fields`。
 * 分区（D-31 §1）：section.block_ids 是「这个 section 拥有哪些块」的**唯一**声明，
 * 同一个块只能出现在一个 section 里。
 */
function checkSection(ctx: ValidationContext, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'SCHEMA_INVALID', `section ${path} must be an object`, path)
    return
  }
  checkAllowedKeys(ctx, path, raw, SECTION_KEYS, 'section')

  const labelRaw = raw.label
  if (typeof labelRaw !== 'string' || labelRaw === '') {
    pushHard(ctx, 'UNKNOWN_SECTION_LABEL', `section ${path} label must be a non-empty string`, path)
  } else if (!(SECTION_LABELS as readonly string[]).includes(labelRaw)) {
    pushHard(
      ctx,
      'UNKNOWN_SECTION_LABEL',
      `section ${path} label ${JSON.stringify(labelRaw)} is not one of: ${SECTION_LABELS.join(', ')}`,
      path,
    )
  }

  const placedHere = new Set<number>()
  const blockIds = raw.block_ids
  if (blockIds === undefined) {
    pushHard(
      ctx,
      'SCHEMA_INVALID',
      `section ${path} is missing block_ids; the contract requires it on every section`,
      path,
    )
  } else if (!Array.isArray(blockIds)) {
    pushHard(ctx, 'SCHEMA_INVALID', `section ${path} block_ids must be an array`, path)
  } else {
    if (blockIds.length === 0) {
      pushHard(ctx, 'SCHEMA_INVALID', `section ${path} block_ids must not be empty`, `${path}.block_ids`)
    }
    for (let i = 0; i < blockIds.length; i += 1) {
      const idPath = `${path}.block_ids[${i}]`
      const id = checkKnownBlockId(ctx, blockIds[i], idPath)
      if (id === null) continue
      placeBlock(ctx, id, idPath)
      placedHere.add(id)
    }
  }

  if (raw.ignored !== undefined) {
    const ignored = raw.ignored
    let valid = true
    if (!isPlainObject(ignored)) {
      pushHard(ctx, 'SCHEMA_INVALID', `section ${path} ignored must be an object ({ reason, detail? })`, `${path}.ignored`)
      valid = false
    } else {
      checkAllowedKeys(ctx, `${path}.ignored`, ignored, IGNORED_KEYS, 'ignored')
      const reason = ignored.reason
      if (typeof reason !== 'string' || reason.trim() === '') {
        pushHard(
          ctx,
          'IGNORED_MISSING_REASON',
          `section ${path} ignored must carry a non-empty reason (contracts/schema.json $defs.ignored.reason)`,
          `${path}.ignored.reason`,
        )
        valid = false
      }
    }
    if (valid) {
      for (const id of placedHere) {
        // 同一个块被两个 ignored section 覆盖是重复记账（placeBlock 已报 BLOCK_DUPLICATED），
        // 这里只数第一次，stats.ignored 才不会超过块数。
        if (ctx.ignoredCovered.has(id)) continue
        ctx.ignoredCovered.set(id, path)
        ctx.ignored += 1
      }
    } else {
      // ignored 不成立 = 这些块既没被正常归类、也没被合法排除：覆盖率会再报一次（D-31 §2）。
      for (const id of placedHere) ctx.ignoredInvalid.add(id)
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
    // 契约的根是 additionalProperties: false：顶层 `ignored[]` 之类的键在这里被拒（它们在 section 里）。
    checkAllowedKeys(ctx, 'result', result, RESULT_KEYS, 'result')

    const sections = result.sections
    if (sections === undefined) {
      pushHard(ctx, 'SCHEMA_INVALID', 'result.sections is required', 'sections')
    } else if (!Array.isArray(sections)) {
      pushHard(ctx, 'SCHEMA_INVALID', 'result.sections must be an array', 'sections')
    } else {
      for (let i = 0; i < sections.length; i += 1) {
        checkSection(ctx, `sections[${i}]`, sections[i])
      }
    }

    checkDocumentFields(ctx, result.fields, workPeriods)

    // D-31 §2：被 ignored 的块不得再被任何字段 / 条目 / 事实引用（引用 = 把 ignored 当逃生舱）。
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

    checkWorkPeriods(ctx, workPeriods)
  }

  // 覆盖率（D-31 §1）：每个 block 必须**恰好**归入一个 section，或被带 reason 的 ignored 明确排除。
  let covered = 0
  for (const entry of index.entries) {
    const invalidIgnored = ctx.ignoredInvalid.has(entry.id)
    const placed = ctx.placed.has(entry.id)
    if (!invalidIgnored && placed) covered += 1
    if (invalidIgnored) {
      pushHard(
        ctx,
        'UNCOVERED_BLOCK',
        `block ${entry.id} (page ${entry.page === null ? '?' : String(entry.page)}) sits in a section whose ignored marker is invalid, so it is neither classified nor excluded`,
        `block_index[${entry.id}]`,
        entry.id,
      )
      continue
    }
    if (!placed && !ctx.ignoredCovered.has(entry.id)) {
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

  return {
    accepted: rejected.length === 0,
    rejected,
    issues: ctx.issues,
    stats: {
      index_entries: index.entries.length,
      covered,
      ignored: ctx.ignored,
      fields: ctx.fields,
      entries: ctx.entryCount,
      hard,
      soft,
    },
  }
}
