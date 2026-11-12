// 校验层测试用的合成夹具。
//
// 约束：**不使用任何真实候选人数据**（项目铁律 R7）。这里的姓名 / 电话 / 邮箱 / 公司
// 全部是构造的假值，形状对齐 converter 的真实输出（blocks[] + location{page,bbox} + provenance）。
//
// 结果侧的形状**逐字对齐 contracts/schema.json**（这是权威）：
//   * `fields` 在**顶层**，五个键恒在；
//   * 条目在 `fields.work_experience.value[]` / `fields.education.value[]`（不是 `section.entries`）；
//   * 条目里的**事实键是平铺的**（`company` / `title` / ...），每个事实是 `{ value, block_ids }`；
//   * `section` 只有 `label` / `block_ids` / `ignored`；
//   * block id 按契约写成**字符串** `"12"`。
import { serialize, type SerializedDocument, type SourceBlock } from '../../src/structure/serialize.ts'

/** 契约版本常量（与 contracts/prompt.md、schema.json 一致）。 */
export const PROMPT_VERSION = '1.0.0'
export const SCHEMA_VERSION = '1.0.0'

/** 合成文本块（默认第 1 页、假 bbox、native_text）。 */
export function blockOf(text: string, page = 1): SourceBlock {
  return {
    kind: 'paragraph',
    text,
    location: { page, bbox: [28.92, 209.95, 566.39, 226.24] },
    provenance: 'native_text',
  }
}

/** 造一份序列化结果（只给文本，页号统一 1）。 */
export function documentOf(texts: readonly string[]): SerializedDocument {
  return serialize({ blocks: texts.map((text) => blockOf(text)) })
}

/** 契约里的 block id 是字符串（`$defs.block_id`）；夹具统一按字符串写。 */
export function ids(value: number | readonly number[]): string[] {
  return (typeof value === 'number' ? [value] : value).map((id) => String(id))
}

/** 一个 `$defs.fact`：`{ value, block_ids }`（读不出时 value=null）。 */
export function fact(
  value: string | null,
  blockIds: number | readonly number[],
): Record<string, unknown> {
  return { value, block_ids: ids(blockIds) }
}

/**
 * 一个单值字段（`$defs.identity_field`）：`{ state, value?, block_ids, reason? }`。
 * `blockIds === null` 表示不引用块（`absent` 必须如此）。
 */
export function field(
  value: string | null,
  blockIds: number | readonly number[] | null,
  state = 'present',
  reason?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    state,
    block_ids: blockIds === null ? [] : ids(blockIds),
  }
  if (value !== null) out.value = value
  if (reason !== undefined) out.reason = reason
  return out
}

/** 一个条目数组字段（`$defs.structural_field` / `education_field`）。 */
export function entryField(
  blockIds: number | readonly number[] | null,
  entries: readonly unknown[] | null,
  state = 'present',
  reason?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    state,
    block_ids: blockIds === null ? [] : ids(blockIds),
  }
  if (entries !== null) out.value = entries
  if (reason !== undefined) out.reason = reason
  return out
}

/**
 * 一个条目（`$defs.work_entry` / `education_entry`）：事实键平铺，没有 `fields` 子对象。
 * @param blockIds - 条目自己的整行来源块（必须是各事实块引用的超集）。
 * @param facts - 事实键（company/title/start/end 或 school/major/degree/start/end）。
 */
export function entry(
  blockIds: number | readonly number[],
  facts: Record<string, unknown>,
  extra: { attribution?: unknown; reason?: string } = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...facts, block_ids: ids(blockIds) }
  out.attribution = extra.attribution === undefined ? 'single_block' : extra.attribution
  if (extra.reason !== undefined) out.reason = extra.reason
  return out
}

/** `section.ignored`（`$defs.ignored`）：存在即表示这些块不参与字段抽取。 */
export function ignored(reason?: string): Record<string, unknown> {
  return reason === undefined ? {} : { reason }
}

/** 一个 section（`$defs.section`）：只有 label / block_ids / ignored。 */
export function section(
  label: string,
  body: { block_ids?: readonly number[]; ignored?: Record<string, unknown> },
): Record<string, unknown> {
  const out: Record<string, unknown> = { label }
  if (body.block_ids !== undefined) out.block_ids = ids(body.block_ids)
  if (body.ignored !== undefined) out.ignored = body.ignored
  return out
}

/** 五个字段的「没读到」基线：全部 absent + not_mentioned（契约合法且不产生任何 issue）。 */
function absentFields(): Record<string, unknown> {
  const absent = (): Record<string, unknown> => field(null, null, 'absent', 'not_mentioned')
  return {
    name: absent(),
    phone: absent(),
    email: absent(),
    work_experience: entryField(null, null, 'absent', 'not_mentioned'),
    education: entryField(null, null, 'absent', 'not_mentioned'),
  }
}

/** 从 sections 推断 block_count（这些合成结果都覆盖 1..N，最大值即块数）。 */
function blockCountOf(sections: readonly unknown[]): number {
  let max = 0
  for (const item of sections) {
    const blockIds = (item as { block_ids?: readonly string[] }).block_ids
    if (!Array.isArray(blockIds)) continue
    for (const raw of blockIds) {
      const id = Number(raw)
      if (Number.isInteger(id) && id > max) max = id
    }
  }
  return max === 0 ? 1 : max
}

/**
 * 结果外壳（契约根形状）。
 * `overrides` 覆盖五个字段里的任意键；未覆盖的都是 absent（合法、零 issue）。
 */
export function resultOf(
  sections: readonly unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prompt_version: PROMPT_VERSION,
    schema_version: SCHEMA_VERSION,
    block_count: blockCountOf(sections),
    sections,
    fields: { ...absentFields(), ...overrides },
  }
}

/**
 * 基线夹具：6 个 block（含 1 个空块），覆盖姓名 / 电话 / 邮箱 / 两段工作经历。
 * id 对应关系（序列化后）：
 *   1 姓名  2 电话+邮箱  3 章节标题  4 工作A  5 工作B  6 空块
 */
export const BASIC_BLOCKS: readonly SourceBlock[] = [
  { kind: 'heading', text: '张三', location: { page: 1, bbox: [161.28, 45.59, 205.19, 73.93] }, provenance: 'native_text' },
  {
    kind: 'paragraph',
    text: '电话：13800001234\n邮箱：Zhang.San@Example.com',
    location: { page: 1, bbox: [161.28, 97.14, 508.85, 109.99] },
    provenance: 'native_text',
  },
  { kind: 'heading', text: '工作经历', location: { page: 1, bbox: [59.88, 173.59, 111.83, 190.31] }, provenance: 'native_text' },
  {
    kind: 'paragraph',
    text: '2020.07-2023.06  星河科技  后端工程师',
    location: { page: 1, bbox: [28.92, 209.95, 566.39, 226.24] },
    provenance: 'native_text',
  },
  {
    kind: 'paragraph',
    text: '2019.01-2019.12  蓝海数据  初级工程师',
    location: { page: 1, bbox: [28.92, 240.02, 566.39, 256.31] },
    provenance: 'native_text',
  },
  { kind: 'paragraph', text: '', location: { page: 2, bbox: [0, 0, 0, 0] }, provenance: 'native_text' },
]

/** 基线文档。 */
export function basicDocument(): SerializedDocument {
  return serialize({ blocks: BASIC_BLOCKS, meta: { source_sha256: 'f'.repeat(64) } })
}

/** 一段工作经历条目（基线里两段）。 */
function workEntry(blockId: number, company: string, title: string, start: string, end: string): Record<string, unknown> {
  return entry(blockId, {
    company: fact(company, blockId),
    title: fact(title, blockId),
    start: fact(start, blockId),
    end: fact(end, blockId),
  })
}

/** 一份**应该被接受**的结果：每个 block 恰好归入一个 section，硬规则全过。 */
export function basicValidResult(): Record<string, unknown> {
  return resultOf(
    [
      section('contact', { block_ids: [1, 2] }),
      // D-31：section.block_ids 是「这个 section 拥有哪些块」的唯一声明。
      section('work_experience', { block_ids: [3, 4, 5] }),
      section('other', { block_ids: [6] }),
    ],
    {
      name: field('张三', 1),
      phone: field('13800001234', 2),
      email: field('Zhang.San@Example.com', 2),
      work_experience: entryField([4, 5], [
        workEntry(4, '星河科技', '后端工程师', '2020.07', '2023.06'),
        workEntry(5, '蓝海数据', '初级工程师', '2019.01', '2019.12'),
      ]),
    },
  )
}

/** 深拷贝（避免测试之间互相污染）。 */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

/** 造一段中文长文本：n 句，每句 100 字（以句号结尾）。 */
export function longChineseText(sentences: number): string {
  const parts: string[] = []
  for (let i = 0; i < sentences; i += 1) {
    parts.push(`第${String(i).padStart(3, '0')}句${'甲'.repeat(94)}。`)
  }
  return parts.join('')
}

/** 造一段英文长文本：n 句，句子间用 ". " 分隔。 */
export function longEnglishText(sentences: number): string {
  const parts: string[] = []
  for (let i = 0; i < sentences; i += 1) {
    parts.push(`Sentence ${String(i).padStart(3, '0')} ${'x'.repeat(86)}. `)
  }
  return parts.join('')
}
