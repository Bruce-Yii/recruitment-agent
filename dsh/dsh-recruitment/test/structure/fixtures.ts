// 校验层测试用的合成夹具。
//
// 约束：**不使用任何真实候选人数据**（项目铁律 R7）。这里的姓名 / 电话 / 邮箱 / 公司
// 全部是构造的假值，形状对齐 converter 的真实输出（blocks[] + location{page,bbox} + provenance）。
import { serialize, type SerializedDocument, type SourceBlock } from '../../src/structure/serialize.ts'

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

/** 字段引用。 */
export function field(
  value: string | null,
  blockId: number | null,
  state = 'present',
  reason?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { state, value, block_id: blockId }
  if (reason !== undefined) out.reason = reason
  return out
}

/** ignored 条目。 */
export function ignore(blockId: number, reason?: string): Record<string, unknown> {
  return reason === undefined ? { block_id: blockId } : { block_id: blockId, reason }
}

/** 一个 section。 */
export function section(
  label: string,
  body: { block_ids?: readonly number[]; fields?: Record<string, unknown>; entries?: readonly unknown[] },
): Record<string, unknown> {
  const out: Record<string, unknown> = { label }
  if (body.block_ids !== undefined) out.block_ids = body.block_ids
  if (body.fields !== undefined) out.fields = body.fields
  if (body.entries !== undefined) out.entries = body.entries
  return out
}

/** 一个经历条目。 */
export function entry(
  blockIds: readonly number[],
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return { block_ids: blockIds, fields }
}

/** 结果外壳。 */
export function resultOf(
  sections: readonly unknown[],
  ignored?: readonly unknown[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { sections }
  if (ignored !== undefined) out.ignored = ignored
  return out
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

/** 一份**应该被接受**的结果：每个 block 恰好归入一个 section 或 ignore，硬规则全过。 */
export function basicValidResult(): Record<string, unknown> {
  return resultOf([
    section('basic', {
      block_ids: [1, 2],
      fields: {
        name: field('张三', 1),
        phone: field('13800001234', 2),
        email: field('Zhang.San@Example.com', 2),
      },
    }),
    section('work', {
      // D-31：section.block_ids 是「这个 section 拥有哪些块」的唯一声明，
      // 条目的块必须也在里面（否则字段块的归属检查会拒）。
      block_ids: [3, 4, 5],
      entries: [
        entry([4], {
          company: field('星河科技', 4),
          title: field('后端工程师', 4),
          start: field('2020.07', 4),
          end: field('2023.06', 4),
        }),
        entry([5], {
          company: field('蓝海数据', 5),
          title: field('初级工程师', 5),
          start: field('2019.01', 5),
          end: field('2019.12', 5),
        }),
      ],
    }),
    section('other', { block_ids: [6] }),
  ])
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
