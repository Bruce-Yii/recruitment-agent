// D-30 / D-31 / D-32 回归测试（总控裁定 2026-11-12）。
//
// 三个裁定改的是校验层的两条「账」：
//   D-30 值匹配：从「单块原文子串」改成「**连续块按序拼接**后的文本」+ 三种**固定**归一化；
//   D-31 覆盖率：从「被引用过就算覆盖」改成「每个 block **恰好**归入一个 section」；
//   D-32 红线：以上改动**不得**放宽成「语义相等」——所以本文件里有一组反例，
//        它们在改完之后必须**仍然被拒绝**（证明没有为了让模型通过而作弊）。
//
// 全部使用合成夹具（项目铁律 R7：不使用真实候选人数据）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMatchTexts,
  normalizeForMatch,
  validate,
  valueMatchesTexts,
  type ValidateResult,
} from '../../src/structure/validate.ts'
import { serialize } from '../../src/structure/serialize.ts'
import { blockOf, clone, entry, field, ignore, resultOf, section } from './fixtures.ts'

/** 拒绝码集合（只看 hard）。 */
function codes(result: ValidateResult): string[] {
  return result.rejected.map((item) => item.code)
}

/** 造夹具：同样的文本既序列化成 block_index，也作为原始 blocks 传给校验层。 */
function fixture(texts: readonly string[]) {
  const blocks = texts.map((text) => blockOf(text))
  return { blocks, doc: serialize({ blocks }) }
}

/** 多块引用：`block_id` 必须等于 `block_ids[0]`（两种写法同时给出）。 */
function multiField(value: string, ids: readonly number[]) {
  return { state: 'present', value, block_id: ids[0], block_ids: [...ids] }
}

// ---------------------------------------------------------------------------------------------
// D-30 · 连续块拼接匹配
// ---------------------------------------------------------------------------------------------

test('D30-1 跨两块的一句话被接受（真实失败形态：上一块以「佣金结算及分账」结尾，下一块以「中台等复杂业务。」开头）', () => {
  const { blocks, doc } = fixture(['主导交易系统重构，覆盖佣金结算及分账', '中台等复杂业务。'])
  const value = '佣金结算及分账中台等复杂业务。'
  // 先证明它确实跨块：任何单块里都没有这句话（旧规则必拒）。
  assert.equal(blocks[0]?.text?.includes(value), false)
  assert.equal(blocks[1]?.text?.includes(value), false)

  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2], fields: { note: multiField(value, [1, 2]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.deepEqual(result.issues, [])
})

test('D30-2 跨块连字符断行被接受（seman- + tics → semantics）', () => {
  const { blocks, doc } = fixture(['We shipped a seman-', 'tics aware search layer.'])
  const view = validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2], fields: { note: multiField('semantics aware search layer', [1, 2]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(view.accepted, true, JSON.stringify(view.rejected))

  // 同一份块，模型把连字符照抄下来也必须被接受（直接相接的拼法）。
  const literal = validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2], fields: { note: multiField('seman-tics aware search layer', [1, 2]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(literal.accepted, true, JSON.stringify(literal.rejected))

  // 归一化是「拼接后」的：拼出来的原文确实是 semantics...
  assert.equal(
    buildMatchTexts([blocks[0]!.text!, blocks[1]!.text!]).some((text) => text.includes('semantics aware search layer.')),
    true,
  )
})

test('D30-3 固定归一化：⏎ 按它代替的换行处理、空白折叠', () => {
  assert.equal(normalizeForMatch('13800001234⏎邮箱：a@b.example'), '13800001234 邮箱：a@b.example')
  assert.equal(normalizeForMatch('a-\n  b'), 'ab') // 只删「断行造成的」连字符
  assert.equal(normalizeForMatch('Seman-\nTICS'), 'Seman- TICS') // 大写不是断词，连字符保留

  const { blocks, doc } = fixture(['电话：13800001234\n邮箱：zhang.san@example.com'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [1], fields: { note: field('13800001234⏎邮箱', 1) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(valueMatchesTexts([blocks[0]!.text!], '13800001234⏎邮箱'), true)
})

test('D30-4 引用块不连续 / 逆序 -> BLOCK_IDS_NOT_CONSECUTIVE', () => {
  const { blocks, doc } = fixture(['第一段', '第二段', '第三段'])

  const gap = validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2, 3], fields: { note: multiField('第一段第三段', [1, 3]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(gap.accepted, false)
  assert.deepEqual(codes(gap), ['BLOCK_IDS_NOT_CONSECUTIVE'])

  const reversed = validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2, 3], fields: { note: multiField('第三段第一段', [3, 1]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(reversed.accepted, false)
  assert.deepEqual(codes(reversed), ['BLOCK_IDS_NOT_CONSECUTIVE'])

  // 条目的 block_ids 同样必须连续且有序（D-30 §2 对「引用块」一律成立）。
  const entryGap = validate({
    result: resultOf([
      section('project', {
        block_ids: [1, 2, 3],
        entries: [entry([1, 3], {})],
      }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(entryGap.accepted, false)
  assert.deepEqual(codes(entryGap), ['BLOCK_IDS_NOT_CONSECUTIVE'])
})

test('D30-5 归一化只用于匹配：block_index 与原始块文本一个字符都不改（D-30 §4）', () => {
  const { blocks, doc } = fixture(['We shipped a seman-', 'tics aware search layer.'])
  const before = JSON.stringify({ index: doc.blockIndex, blocks })
  validate({
    result: resultOf([
      section('summary', { block_ids: [1, 2], fields: { note: multiField('semantics aware search layer', [1, 2]) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(JSON.stringify({ index: doc.blockIndex, blocks }), before)
  // 原文里的连字符还在（归一化没有写回）。
  assert.equal(blocks[0]?.text, 'We shipped a seman-')
  assert.equal(doc.blockIndex.entries[0]?.sha256, serialize({ blocks }).blockIndex.entries[0]?.sha256)
})

// ---------------------------------------------------------------------------------------------
// D-31 · 每块恰好归入一个 section
// ---------------------------------------------------------------------------------------------

test('D31-1 同一个 block 出现在两个 section -> BLOCK_DUPLICATED', () => {
  const { blocks, doc } = fixture(['甲', '乙'])
  const result = validate({
    result: resultOf([
      section('other', { block_ids: [1] }),
      section('summary', { block_ids: [1, 2] }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_DUPLICATED'])
  assert.equal(result.stats.covered, 2)
})

test('D31-2 同一个 block 在一个 section 里写两次 -> BLOCK_DUPLICATED', () => {
  const { blocks, doc } = fixture(['甲', '乙'])
  const result = validate({
    result: resultOf([section('other', { block_ids: [1, 1, 2] })]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_DUPLICATED'])
})

test('D31-3 被 ignored 的 block 又被字段引用 -> IGNORED_BLOCK_REFERENCED（contact 字段也照查）', () => {
  const { blocks, doc } = fixture(['张三', '邮箱：zhang.san@example.com'])
  const result = validate({
    result: resultOf(
      [section('summary', { block_ids: [1], fields: { email: field('zhang.san@example.com', 2) } })],
      [ignore(2, '与页眉重复')],
    ),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['IGNORED_BLOCK_REFERENCED'])
  assert.equal(result.rejected[0]?.block_id, 2)
})

test('D31-4 既 ignored 又放进 section -> BLOCK_DUPLICATED（忽略与分区互斥）', () => {
  const { blocks, doc } = fixture(['甲', '乙'])
  const result = validate({
    result: resultOf([section('other', { block_ids: [1, 2] })], [ignore(1, '重复')]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_DUPLICATED'])
})

test('D31-5 字段引用了别的 section 的块 -> FIELD_BLOCK_NOT_IN_SECTION', () => {
  const { blocks, doc } = fixture(['张三', '星河科技'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [], fields: { company: field('星河科技', 2) } }),
      section('other', { block_ids: [1, 2] }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['FIELD_BLOCK_NOT_IN_SECTION'])
  assert.equal(result.rejected[0]?.path, 'sections[0].fields.company')
})

test('D31-6 contact 类字段豁免：phone 可以引用别的 section 里的块（D-31 §3 的例外）', () => {
  const { blocks, doc } = fixture(['电话：13800001234', '其它内容'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [], fields: { phone: field('13800001234', 1) } }),
      section('other', { block_ids: [1, 2] }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.deepEqual(result.issues, [])
})

test('D31-7 只被字段引用、没归入任何 section 的块 -> 仍然 UNCOVERED_BLOCK（引用过不再算覆盖）', () => {
  const { blocks, doc } = fixture(['张三', 'zhang.san@example.com'])
  const result = validate({
    result: resultOf([section('summary', { block_ids: [1], fields: { email: field('zhang.san@example.com', 2) } })]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNCOVERED_BLOCK'])
  assert.equal(result.rejected[0]?.block_id, 2)
  assert.equal(result.stats.covered, 1)
})

test('D31-8 同一个 block 在 ignored 里出现两次 -> BLOCK_DUPLICATED（也是「恰好一次」）', () => {
  const { blocks, doc } = fixture(['张三', '空白块'])
  const result = validate({
    result: resultOf([section('other', { block_ids: [1] })], [ignore(2, '空白'), ignore(2, '无正文')]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_DUPLICATED'])
  assert.equal(result.stats.ignored, 1)
})

// ---------------------------------------------------------------------------------------------
// D-32 · 反例：不得放宽成「语义相等」
// ---------------------------------------------------------------------------------------------

test('D32-1 反例：语义相等但换了写法（2020年7月 vs 2020.07）-> 仍 VALUE_NOT_IN_BLOCK', () => {
  const { blocks, doc } = fixture(['入职时间 2020.07'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [1], fields: { start: field('2020年7月', 1) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('D32-2 反例：值比原文"更完整"（星河科技有限公司 vs 星河科技）-> 仍 VALUE_NOT_IN_BLOCK', () => {
  const { blocks, doc } = fixture(['2020.07-2023.06  星河科技  后端工程师'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [1], fields: { company: field('星河科技有限公司', 1) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('D32-3 反例：空白折叠不等于删空白（「星 河 科 技」不能匹配「星河科技」）', () => {
  const { blocks, doc } = fixture(['星 河 科 技'])
  const result = validate({
    result: resultOf([
      section('summary', { block_ids: [1], fields: { company: field('星河科技', 1) } }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('D32-4 反例：跨块但顺序反了 -> 仍拒绝（拼接必须按 block_ids 的顺序）', () => {
  const { blocks, doc } = fixture(['佣金结算及分账', '中台等复杂业务。'])
  const result = validate({
    result: resultOf([
      section('summary', {
        block_ids: [1, 2],
        fields: { note: multiField('中台等复杂业务。佣金结算及分账', [2, 1]) },
      }),
    ]),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_IDS_NOT_CONSECUTIVE'])
})

test('D32-5 基线仍然零 issue（没有为了新规则顺手放宽旧规则）', () => {
  const { blocks, doc } = fixture(['任意内容'])
  const baseline = validate({
    result: clone(resultOf([section('other', { block_ids: [1] })])),
    blockIndex: doc.blockIndex,
    blocks,
  })
  assert.equal(baseline.accepted, true, JSON.stringify(baseline.rejected))
  assert.deepEqual(baseline.issues, [])
})
