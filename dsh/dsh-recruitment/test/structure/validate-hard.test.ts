// 校验层 · 硬规则单测（任务书的 1–6 与 8）。
//
// 每个测试都从「应该被接受」的基线出发，只改一处，断言那个 code 出现且 accepted=false。
// 这样能证明失败是**这条规则**抓到的，不是别的规则顺带抓到的。
import test from 'node:test'
import assert from 'node:assert/strict'

import { validate, type ValidateResult } from '../../src/structure/validate.ts'
import { serialize } from '../../src/structure/serialize.ts'
import {
  BASIC_BLOCKS,
  basicDocument,
  basicValidResult,
  blockOf,
  clone,
  documentOf,
  entry,
  field,
  longChineseText,
  resultOf,
  section,
} from './fixtures.ts'

type TField = Record<string, unknown>
type TEntry = { block_ids?: unknown[]; fields?: Record<string, TField> }
type TSection = { label?: unknown; block_ids?: unknown[]; fields?: Record<string, TField>; entries?: TEntry[] }
type TResult = { sections?: TSection[]; ignored?: Array<Record<string, unknown>> }

/** 把夹具结果当成可改的普通对象（测试里只关心行为，不关心静态类型）。 */
function mut(result: unknown): TResult {
  return clone(result) as TResult
}

/** 拒绝码集合。 */
function codes(result: ValidateResult): string[] {
  return result.rejected.map((item) => item.code)
}

const DOC = basicDocument()
const BLOCKS = BASIC_BLOCKS

test('V1 正例：完整结果被接受，且没有任何 issue', () => {
  const result = validate({ result: basicValidResult(), blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.deepEqual(result.rejected, [])
  assert.deepEqual(result.issues, [])
  assert.equal(result.stats.index_entries, 6)
  assert.equal(result.stats.covered, 6)
  assert.equal(result.stats.hard, 0)
  assert.equal(result.stats.soft, 0)
  // 确定性：同一输入两次校验，结果逐字段相同
  const again = validate({ result: basicValidResult(), blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(again)))
})

test('V2 规则1：引用不存在的 block id -> UNKNOWN_BLOCK_ID', () => {
  const broken = mut(basicValidResult())
  broken.sections?.[2]?.block_ids?.push(99)
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNKNOWN_BLOCK_ID'])
  assert.equal(result.rejected[0]?.block_id, 99)
  assert.equal(result.rejected[0]?.path, 'sections[2].block_ids[1]')
})

test('V3 规则2：字段值不是所引用 block 的子串 -> VALUE_NOT_IN_BLOCK', () => {
  const broken = mut(basicValidResult())
  const phone = broken.sections?.[0]?.fields?.phone
  assert.ok(phone)
  phone.value = '13900009999'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
  assert.equal(result.rejected[0]?.path, 'sections[0].fields.phone')
})

test('V4 规则3：有 block 没被归类 -> UNCOVERED_BLOCK', () => {
  const broken = mut(basicValidResult())
  broken.sections![2]!.block_ids = []
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNCOVERED_BLOCK'])
  assert.equal(result.rejected[0]?.block_id, 6)
  assert.equal(result.stats.covered, 5)
})

test('V5 规则3：被标 ignored 且带 reason 的 block 算覆盖（结果仍被接受）', () => {
  const covered = mut(basicValidResult())
  covered.sections![2]!.block_ids = []
  covered.ignored = [{ block_id: 6, reason: '空白块，无正文' }]
  const result = validate({ result: covered, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.ignored, 1)
  assert.equal(result.stats.covered, 6)
})

test('V6 规则3：ignored 没有 reason -> IGNORED_MISSING_REASON + UNCOVERED_BLOCK', () => {
  const broken = mut(basicValidResult())
  broken.sections![2]!.block_ids = []
  broken.ignored = [{ block_id: 6 }]
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result).sort(), ['IGNORED_MISSING_REASON', 'UNCOVERED_BLOCK'])
})

test('V7 规则4：section 标签不在枚举内 -> UNKNOWN_SECTION_LABEL', () => {
  const broken = mut(basicValidResult())
  const other = broken.sections?.[2]
  assert.ok(other)
  other.label = 'misc'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNKNOWN_SECTION_LABEL'])
  assert.equal(result.rejected[0]?.path, 'sections[2]')
})

test('V8 规则5：字段缺 state -> STATE_MISSING', () => {
  const broken = mut(basicValidResult())
  const phone = broken.sections?.[0]?.fields?.phone
  assert.ok(phone)
  delete phone.state
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_MISSING'])
})

test('V9 规则5：state 不在枚举内 -> STATE_INVALID', () => {
  const broken = mut(basicValidResult())
  const phone = broken.sections?.[0]?.fields?.phone
  assert.ok(phone)
  phone.state = 'unknown'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_INVALID'])
})

test('V10 规则6 phone：值仍是子串但格式非法 -> PHONE_INVALID', () => {
  const broken = mut(basicValidResult())
  const phone = broken.sections?.[0]?.fields?.phone
  assert.ok(phone)
  phone.value = '电话：13800001234' // 确实是 block 2 的子串，但不是电话号码格式
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['PHONE_INVALID'])
})

test('V11 规则6 phone：数字序列与原文不一致 -> PHONE_DIGITS_MISMATCH', () => {
  const doc = serialize({ blocks: [{ kind: 'paragraph', text: '备用号码 138000012345 分机 88' }] })
  const result = validate({
    result: resultOf([section('other', { block_ids: [1], fields: { phone: field('13800001234', 1) } })]),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text: '备用号码 138000012345 分机 88' }],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['PHONE_DIGITS_MISMATCH'])
})

test('V12 规则6 email：值仍是子串但格式非法 -> EMAIL_INVALID', () => {
  const broken = mut(basicValidResult())
  const email = broken.sections?.[0]?.fields?.email
  assert.ok(email)
  email.value = 'Zhang.San@Example' // block 2 的子串，但域名没有点
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['EMAIL_INVALID'])
})

test('V13 规则6 date：解析不出 -> DATE_INVALID', () => {
  const doc = documentOf(['最近  星河科技'])
  const result = validate({
    result: resultOf([section('other', { block_ids: [1], fields: { start: field('最近', 1) } })]),
    blockIndex: doc.blockIndex,
    blocks: [blockOf('最近  星河科技')],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['DATE_INVALID'])
})

test('V14 规则8：section 省略必填字段 -> MISSING_FIELD（省略 ≠ absent）', () => {
  const broken = mut(basicValidResult())
  const fields = broken.sections?.[0]?.fields
  assert.ok(fields)
  delete fields.phone
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_FIELD'])
  assert.equal(result.rejected[0]?.path, 'sections[0].fields.phone')
})

test('V15 规则8：经历条目省略必填字段 -> MISSING_ENTRY_FIELD', () => {
  const broken = mut(basicValidResult())
  const fields = broken.sections?.[1]?.entries?.[0]?.fields
  assert.ok(fields)
  delete fields.title
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_ENTRY_FIELD'])
})

test('V16 absent 不能携带 value -> STATE_VALUE_CONFLICT', () => {
  const broken = mut(basicValidResult())
  const name = broken.sections?.[0]?.fields?.name
  assert.ok(name)
  name.state = 'absent'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_VALUE_CONFLICT'])
})

test('V17 unreadable 必须带 reason -> UNREADABLE_MISSING_REASON', () => {
  const broken = mut(basicValidResult())
  const phone = broken.sections?.[0]?.fields?.phone
  assert.ok(phone)
  phone.state = 'unreadable'
  phone.value = null
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNREADABLE_MISSING_REASON'])
})

test('V18 索引被换过（sha256 对不上）-> BLOCK_INDEX_INTEGRITY', () => {
  const brokenIndex = {
    ...DOC.blockIndex,
    entries: DOC.blockIndex.entries.map((item, offset) =>
      offset === 0 ? { ...item, sha256: '0'.repeat(64) } : item,
    ),
  }
  const result = validate({
    result: basicValidResult(),
    blockIndex: brokenIndex,
    blocks: BLOCKS,
  })
  assert.equal(result.accepted, false)
  assert.ok(codes(result).includes('BLOCK_INDEX_INTEGRITY'))
})

test('V19 不认识的 block_index 版本 -> BLOCK_INDEX_VERSION_UNSUPPORTED', () => {
  const brokenIndex = { ...DOC.blockIndex, version: 99 }
  const result = validate({ result: basicValidResult(), blockIndex: brokenIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['BLOCK_INDEX_VERSION_UNSUPPORTED'])
})

test('V20 切分片段：跨片的值不算子串（模型只能引用它看到的那个 id）', () => {
  const text = longChineseText(12)
  const doc = documentOf([text])
  const crossing = text.slice(495, 505) // 跨越 id=1/2 的切分点（码点 500）
  const documents = [{ kind: 'paragraph', text }]
  const result = validate({
    result: resultOf([
      section('other', {
        block_ids: [1, 2, 3],
        fields: { note: field(crossing, 1) },
      }),
    ]),
    blockIndex: doc.blockIndex,
    blocks: documents,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('V21 email 大小写必须与原文一致：小写改写会被规则2 拒（规则6 只在小写后也找不到时才补刀）', () => {
  const broken = mut(basicValidResult())
  const email = broken.sections?.[0]?.fields?.email
  assert.ok(email)
  email.value = 'zhang.san@example.com' // 原文是 Zhang.San@Example.com
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('V22 凭空邮箱：格式对、原文没有 -> VALUE_NOT_IN_BLOCK + EMAIL_NOT_IN_SOURCE', () => {
  const broken = mut(basicValidResult())
  const email = broken.sections?.[0]?.fields?.email
  assert.ok(email)
  email.value = 'nobody@example.org'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result).sort(), ['EMAIL_NOT_IN_SOURCE', 'VALUE_NOT_IN_BLOCK'])
})

test('V23 日期是更长数字串的截断（2020 取自 202011）-> DATE_NOT_IN_SOURCE', () => {
  const text = '工号 202011 入职'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([section('other', { block_ids: [1], fields: { start: field('2020', 1) } })]),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['DATE_NOT_IN_SOURCE'])
})

test('V24 字段不是对象 -> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const fields = broken.sections?.[0]?.fields
  assert.ok(fields)
  fields.phone = '13800001234' // 直接给字符串，不是 {state, value, block_id}
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
})

test('V25 present 字段没有 block_id -> MISSING_BLOCK_ID', () => {
  const broken = mut(basicValidResult())
  const name = broken.sections?.[0]?.fields?.name
  assert.ok(name)
  delete name.block_id
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_BLOCK_ID'])
})
