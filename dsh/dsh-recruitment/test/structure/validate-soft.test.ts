// 校验层 · 软校验单测（任务书第 7 条：跨字段一致性）。
//
// 软 = 记 issue、**不**拒绝。工作要求：起始年份不得晚于结束年份；两段工作经历不得完全重叠。
//
// 形状以 contracts/schema.json 为权威：工作经历条目在 `fields.work_experience.value[]`，
// 事实键（company/title/start/end）平铺在条目上（不再是 `entry.fields`）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { validate } from '../../src/structure/validate.ts'
import { serialize } from '../../src/structure/serialize.ts'
import {
  BASIC_BLOCKS,
  basicDocument,
  basicValidResult,
  clone,
  entry,
  entryField,
  fact,
  resultOf,
  section,
} from './fixtures.ts'

const DOC = basicDocument()

type TObject = Record<string, unknown>

/** 取一段工作经历条目。 */
function workEntryAt(result: unknown, index: number): TObject {
  const fields = (result as { fields?: Record<string, unknown> }).fields
  assert.ok(fields, 'result.fields must exist')
  const work = fields.work_experience
  assert.ok(work && typeof work === 'object', 'fields.work_experience must be an object')
  const entries = (work as { value?: unknown }).value
  assert.ok(Array.isArray(entries), 'fields.work_experience.value must be an array')
  const item = entries[index]
  assert.ok(item && typeof item === 'object', `value[${index}] must be an object`)
  return item as TObject
}

test('S1 基线没有任何软 issue（对照组：不得误报）', () => {
  const result = validate({ result: basicValidResult(), blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true)
  assert.equal(result.stats.soft, 0)
  assert.deepEqual(result.issues, [])
})

test('S2 时间倒挂（起始年份晚于结束年份）-> WORK_PERIOD_INVERTED，但不拒绝', () => {
  const broken = clone(basicValidResult())
  const first = workEntryAt(broken, 0)
  // 两段值都是 block 4 原文的子串，只是把起止对调了。
  first.start = fact('2023.06', 4)
  first.end = fact('2020.07', 4)
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.deepEqual(result.rejected, [])
  assert.equal(result.stats.soft, 1)
  assert.equal(result.issues[0]?.code, 'WORK_PERIOD_INVERTED')
  assert.equal(result.issues[0]?.severity, 'soft')
  assert.equal(result.issues[0]?.path, 'fields.work_experience.value[0]')
})

test('S3 两段工作经历完全重叠 -> WORK_PERIOD_OVERLAP，但不拒绝', () => {
  const broken = clone(basicValidResult())
  const second = workEntryAt(broken, 1)
  // 第二段改用 block 4 的起止，与第一段区间完全相同（完全重叠）。
  second.start = fact('2020.07', 4)
  second.end = fact('2023.06', 4)
  // 事实的块必须在条目自己的 block_ids 里（$comment 不变量 3）：company/title 来自 5，起止来自 4。
  second.block_ids = ['4', '5']
  const result = validate({ result: broken, blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.soft, 1)
  assert.equal(result.issues[0]?.code, 'WORK_PERIOD_OVERLAP')
  assert.equal(result.issues[0]?.severity, 'soft')
})

test('S4 只有月份倒挂（同年）不算倒挂：规则按「年份」判', () => {
  const text = '2023.06-2023.01  星河科技  后端工程师'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([section('work_experience', { block_ids: [1] })], {
      work_experience: entryField([1], [
        entry(1, {
          company: fact('星河科技', 1),
          title: fact('后端工程师', 1),
          start: fact('2023.06', 1),
          end: fact('2023.01', 1),
        }),
      ]),
    }),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.soft, 0, JSON.stringify(result.issues))
})

test('S5 部分重叠（不是完全包含）不报 -> 不误报', () => {
  const text = '2020.01-2022.06  星河科技  后端工程师\n2021.01-2023.06  蓝海数据  初级工程师'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([section('work_experience', { block_ids: [1] })], {
      work_experience: entryField([1], [
        entry(1, {
          company: fact('星河科技', 1),
          title: fact('后端工程师', 1),
          start: fact('2020.01', 1),
          end: fact('2022.06', 1),
        }),
        entry(1, {
          company: fact('蓝海数据', 1),
          title: fact('初级工程师', 1),
          start: fact('2021.01', 1),
          end: fact('2023.06', 1),
        }),
      ]),
    }),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.soft, 0, JSON.stringify(result.issues))
})
