// 校验层 · 软校验单测（任务书第 7 条：跨字段一致性）。
//
// 软 = 记 issue、**不**拒绝。工作要求：起始年份不得晚于结束年份；两段工作经历不得完全重叠。
import test from 'node:test'
import assert from 'node:assert/strict'

import { validate } from '../../src/structure/validate.ts'
import { serialize } from '../../src/structure/serialize.ts'
import { BASIC_BLOCKS, basicDocument, basicValidResult, clone, field, resultOf, section } from './fixtures.ts'

const DOC = basicDocument()

type TField = Record<string, unknown>
type TEntry = { block_ids?: unknown[]; fields?: Record<string, TField> }

function mut(result: unknown): { sections?: Array<{ entries?: TEntry[] }> } {
  return clone(result) as { sections?: Array<{ entries?: TEntry[] }> }
}

test('S1 基线没有任何软 issue（对照组：不得误报）', () => {
  const result = validate({ result: basicValidResult(), blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true)
  assert.equal(result.stats.soft, 0)
  assert.deepEqual(result.issues, [])
})

test('S2 时间倒挂（起始年份晚于结束年份）-> WORK_PERIOD_INVERTED，但不拒绝', () => {
  const broken = mut(basicValidResult())
  const fields = broken.sections?.[1]?.entries?.[0]?.fields
  assert.ok(fields)
  // 两段值都是 block 4 原文的子串，只是把起止对调了。
  fields.start = field('2023.06', 4)
  fields.end = field('2020.07', 4)
  const result = validate({ result: { sections: broken.sections }, blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.deepEqual(result.rejected, [])
  assert.equal(result.stats.soft, 1)
  assert.equal(result.issues[0]?.code, 'WORK_PERIOD_INVERTED')
  assert.equal(result.issues[0]?.severity, 'soft')
  assert.equal(result.issues[0]?.path, 'sections[1].entries[0]')
})

test('S3 两段工作经历完全重叠 -> WORK_PERIOD_OVERLAP，但不拒绝', () => {
  const broken = mut(basicValidResult())
  const second = broken.sections?.[1]?.entries?.[1]?.fields
  assert.ok(second)
  // 第二段改用 block 4 的起止，与第一段区间完全相同（完全重叠）。
  second.start = field('2020.07', 4)
  second.end = field('2023.06', 4)
  const result = validate({ result: { sections: broken.sections }, blockIndex: DOC.blockIndex, blocks: BASIC_BLOCKS })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.soft, 1)
  assert.equal(result.issues[0]?.code, 'WORK_PERIOD_OVERLAP')
  assert.equal(result.issues[0]?.severity, 'soft')
})

test('S4 只有月份倒挂（同年）不算倒挂：规则按「年份」判', () => {
  const text = '2023.06-2023.01  星河科技  后端工程师'
  const doc = serialize({ blocks: [{ kind: 'paragraph', text }] })
  const result = validate({
    result: resultOf([
      section('work_experience', {
        block_ids: [1],
        entries: [
          {
            block_ids: [1],
            fields: {
              company: field('星河科技', 1),
              title: field('后端工程师', 1),
              start: field('2023.06', 1),
              end: field('2023.01', 1),
            },
          },
        ],
      }),
    ]),
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
    result: resultOf([
      section('work_experience', {
        block_ids: [1],
        entries: [
          {
            block_ids: [1],
            fields: {
              company: field('星河科技', 1),
              title: field('后端工程师', 1),
              start: field('2020.01', 1),
              end: field('2022.06', 1),
            },
          },
          {
            block_ids: [1],
            fields: {
              company: field('蓝海数据', 1),
              title: field('初级工程师', 1),
              start: field('2021.01', 1),
              end: field('2023.06', 1),
            },
          },
        ],
      }),
    ]),
    blockIndex: doc.blockIndex,
    blocks: [{ kind: 'paragraph', text }],
  })
  assert.equal(result.accepted, true, JSON.stringify(result.rejected))
  assert.equal(result.stats.soft, 0, JSON.stringify(result.issues))
})

