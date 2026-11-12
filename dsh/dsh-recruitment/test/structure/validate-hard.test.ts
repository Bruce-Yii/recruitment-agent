// 校验层 · 硬规则单测（任务书的 1–6 与 8）。
//
// 每个测试都从「应该被接受」的基线出发，只改一处，断言那个 code 出现且 accepted=false。
// 这样能证明失败是**这条规则**抓到的，不是别的规则顺带抓到的。
//
// 位置口径以 contracts/schema.json 为权威：字段在顶层 `fields`，条目在
// `fields.<work_experience|education>.value[]`，事实键平铺在条目上。
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
  entryField,
  fact,
  field,
  ignored,
  longChineseText,
  resultOf,
  section,
} from './fixtures.ts'

type TObject = Record<string, unknown>
type TResult = { sections?: TObject[]; fields?: Record<string, unknown>; ignored?: unknown }

/** 把夹具结果当成可改的普通对象（测试里只关心行为，不关心静态类型）。 */
function mut(result: unknown): TResult {
  return clone(result) as TResult
}

/** 取一个顶层字段（断言它存在并当成可改对象）。 */
function fieldAt(result: TResult, key: string): TObject {
  const fields = result.fields
  assert.ok(fields, 'result.fields must exist')
  const value = fields[key]
  assert.ok(value && typeof value === 'object', `fields.${key} must be an object`)
  return value as TObject
}

/** 取一条工作经历条目的 `value[i]`。 */
function workEntryAt(result: TResult, index: number): TObject {
  const work = fieldAt(result, 'work_experience')
  const entries = work.value
  assert.ok(Array.isArray(entries), 'fields.work_experience.value must be an array')
  const item = entries[index]
  assert.ok(item && typeof item === 'object', `fields.work_experience.value[${index}] must be an object`)
  return item as TObject
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
  assert.equal(result.stats.fields, 5)
  assert.equal(result.stats.entries, 2)
  assert.equal(result.stats.hard, 0)
  assert.equal(result.stats.soft, 0)
  // 确定性：同一输入两次校验，结果逐字段相同
  const again = validate({ result: basicValidResult(), blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(again)))
})

test('V2 规则1：引用不存在的 block id -> UNKNOWN_BLOCK_ID', () => {
  const broken = mut(basicValidResult())
  broken.sections?.[2]?.block_ids?.push('99')
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNKNOWN_BLOCK_ID'])
  assert.equal(result.rejected[0]?.block_id, 99)
  assert.equal(result.rejected[0]?.path, 'sections[2].block_ids[1]')
})

test('V3 规则2：字段值不是所引用 block 的子串 -> VALUE_NOT_IN_BLOCK', () => {
  const broken = mut(basicValidResult())
  const phone = fieldAt(broken, 'phone')
  phone.value = '13900009999'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
  assert.equal(result.rejected[0]?.path, 'fields.phone')
})

test('V4 规则3：有 block 没被归类 -> UNCOVERED_BLOCK', () => {
  const broken = mut(basicValidResult())
  broken.sections?.pop()
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['UNCOVERED_BLOCK'])
  assert.equal(result.rejected[0]?.block_id, 6)
  assert.equal(result.stats.covered, 5)
})

test('V5 规则3：被标 ignored 且带 reason 的 block 算覆盖（结果仍被接受）', () => {
  const covered = mut(basicValidResult())
  covered.sections?.pop()
  covered.sections?.push(section('other', { block_ids: [6], ignored: ignored('empty_or_symbol_only') }))
  const result = validate({ result: covered, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.ignored, 1)
  assert.equal(result.stats.covered, 6)
})

test('V6 规则3：ignored 没有 reason -> IGNORED_MISSING_REASON + UNCOVERED_BLOCK', () => {
  const broken = mut(basicValidResult())
  broken.sections?.pop()
  broken.sections?.push(section('other', { block_ids: [6], ignored: ignored() }))
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
  const phone = fieldAt(broken, 'phone')
  delete phone.state
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_MISSING'])
  assert.equal(result.rejected[0]?.path, 'fields.phone')
})

test('V9 规则5：state 不在枚举内 -> STATE_INVALID', () => {
  const broken = mut(basicValidResult())
  const phone = fieldAt(broken, 'phone')
  phone.state = 'unknown'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_INVALID'])
})

test('V10 规则6 phone：值仍是子串但格式非法 -> PHONE_INVALID', () => {
  const broken = mut(basicValidResult())
  const phone = fieldAt(broken, 'phone')
  phone.value = '电话：13800001234' // 确实是 block 2 的子串，但不是电话号码格式
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['PHONE_INVALID'])
})

test('V11 规则6 phone：数字序列与原文不一致 -> PHONE_DIGITS_MISMATCH', () => {
  const text = '备用号码 138000012345 分机 88'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([section('other', { block_ids: [1] })], { phone: field('13800001234', 1) }),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['PHONE_DIGITS_MISMATCH'])
})

test('V12 规则6 email：值仍是子串但格式非法 -> EMAIL_INVALID', () => {
  const broken = mut(basicValidResult())
  const email = fieldAt(broken, 'email')
  email.value = 'Zhang.San@Example' // block 2 的子串，但域名没有点
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['EMAIL_INVALID'])
})

test('V13 规则6 date：解析不出 -> DATE_INVALID', () => {
  const doc = documentOf(['最近  星河科技'])
  const result = validate({
    result: resultOf([section('other', { block_ids: [1] })], {
      work_experience: entryField([1], [
        entry(1, {
          company: fact('星河科技', 1),
          title: fact(null, 1),
          start: fact('最近', 1),
          end: fact(null, 1),
        }, { reason: 'section_present_unsplittable' }),
      ]),
    }),
    blockIndex: doc.blockIndex,
    blocks: [blockOf('最近  星河科技')],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['DATE_INVALID'])
  assert.equal(result.rejected[0]?.path, 'fields.work_experience.value[0].start')
})

test('V14 规则8：省略顶层必填字段 -> MISSING_FIELD（省略 ≠ absent）', () => {
  // 契约位置：五个字段在**顶层 fields**（$defs.fields.required），不在 section 里。
  const broken = mut(basicValidResult())
  const fields = broken.fields
  assert.ok(fields)
  delete fields.phone
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_FIELD'])
  assert.equal(result.rejected[0]?.path, 'fields.phone')
})

test('V15 规则8：经历条目省略必填字段 -> MISSING_ENTRY_FIELD（条目在 value[] 里、事实键平铺）', () => {
  const broken = mut(basicValidResult())
  const first = workEntryAt(broken, 0)
  delete first.title
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_ENTRY_FIELD'])
  assert.equal(result.rejected[0]?.path, 'fields.work_experience.value[0].title')
})

test('V16 absent 不能携带 value -> STATE_VALUE_CONFLICT', () => {
  const broken = mut(basicValidResult())
  const name = fieldAt(broken, 'name')
  name.state = 'absent'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['STATE_VALUE_CONFLICT'])
})

test('V17 unreadable 必须带 reason -> UNREADABLE_MISSING_REASON', () => {
  const broken = mut(basicValidResult())
  const phone = fieldAt(broken, 'phone')
  phone.state = 'unreadable'
  delete phone.value
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
    result: resultOf([section('other', { block_ids: [1, 2, 3] })], {
      name: field(crossing, 1),
    }),
    blockIndex: doc.blockIndex,
    blocks: documents,
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('V21 email 大小写必须与原文一致：小写改写会被规则2 拒（规则6 只在小写后也找不到时才补刀）', () => {
  const broken = mut(basicValidResult())
  const email = fieldAt(broken, 'email')
  email.value = 'zhang.san@example.com' // 原文是 Zhang.San@Example.com
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['VALUE_NOT_IN_BLOCK'])
})

test('V22 凭空邮箱：格式对、原文没有 -> VALUE_NOT_IN_BLOCK + EMAIL_NOT_IN_SOURCE', () => {
  const broken = mut(basicValidResult())
  const email = fieldAt(broken, 'email')
  email.value = 'nobody@example.org'
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result).sort(), ['EMAIL_NOT_IN_SOURCE', 'VALUE_NOT_IN_BLOCK'])
})

test('V23 日期是更长数字串的截断（2020 取自 202011）-> DATE_NOT_IN_SOURCE', () => {
  const text = '工号 202011 入职'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([section('other', { block_ids: [1] })], {
      work_experience: entryField([1], [
        entry(1, {
          company: fact(null, 1),
          title: fact(null, 1),
          start: fact('2020', 1),
          end: fact(null, 1),
        }, { reason: 'section_present_unsplittable' }),
      ]),
    }),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['DATE_NOT_IN_SOURCE'])
})

test('V24 字段不是对象 -> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const fields = broken.fields
  assert.ok(fields)
  fields.phone = '13800001234' // 直接给字符串，不是 {state, block_ids}
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
})

test('V25 present 字段带空 block_ids -> MISSING_BLOCK_ID', () => {
  const broken = mut(basicValidResult())
  const name = fieldAt(broken, 'name')
  name.block_ids = []
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['MISSING_BLOCK_ID'])
  assert.equal(result.rejected[0]?.path, 'fields.name')
})

// ---------------------------------------------------------------------------------------------
// 契约位置：契约里不存在的位置一律 SCHEMA_INVALID（不静默忽略）
// ---------------------------------------------------------------------------------------------

test('V26 section 里出现 fields（契约没有这个位置）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const contact = broken.sections?.[0]
  assert.ok(contact)
  contact.fields = { name: field('张三', 1) }
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'sections[0].fields')
})

test('V27 section 里出现 entries（契约没有这个位置：条目在 fields.<字段>.value[]）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const work = broken.sections?.[1]
  assert.ok(work)
  work.entries = []
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'sections[1].entries')
})

test('V28 条目里出现 fields 子对象（事实键是平铺的）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const first = workEntryAt(broken, 0)
  first.fields = { title: field('后端工程师', 4) }
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'fields.work_experience.value[0].fields')
})

test('V29 顶层出现 ignored（契约把它放在每个 section 里）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  broken.ignored = [{ block_id: '6', reason: 'empty_or_symbol_only' }]
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'result.ignored')
})

test('V30 整个 fields 缺失（契约根 required）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  delete broken.fields
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'fields')
})

test('V31 条目缺 attribution（契约 required）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const first = workEntryAt(broken, 0)
  delete first.attribution
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'fields.work_experience.value[0]')
})

test('V32 absent 却引用了块（契约要求 absent 的 block_ids 为空数组）-> SCHEMA_INVALID', () => {
  const broken = mut(basicValidResult())
  const name = fieldAt(broken, 'name')
  name.state = 'absent'
  delete name.value
  name.block_ids = ['1']
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BLOCKS })
  assert.equal(result.accepted, false)
  assert.deepEqual(codes(result), ['SCHEMA_INVALID'])
  assert.equal(result.rejected[0]?.path, 'fields.name')
})
