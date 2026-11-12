// 日期解析单测：规则 6 的 date 分支全靠它，必须逐种写法钉死。
//
// 解析只负责「能不能读成 YYYY-MM(-DD)」，**不改 value**：字段值仍必须逐字引用原文。
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseDateText } from '../../src/structure/validate.ts'

test('D1 接受 YYYY / YYYY-MM / YYYY-MM-DD 三种规范形状', () => {
  assert.deepEqual(parseDateText('2020'), { year: 2020, month: null, day: null, ongoing: false })
  assert.deepEqual(parseDateText('2020-07'), { year: 2020, month: 7, day: null, ongoing: false })
  assert.deepEqual(parseDateText('2020-07-15'), { year: 2020, month: 7, day: 15, ongoing: false })
})

test('D2 接受 converter 语料里的中文/点号写法（不要求模型改写原文）', () => {
  assert.deepEqual(parseDateText('2020.07'), { year: 2020, month: 7, day: null, ongoing: false })
  assert.deepEqual(parseDateText('2020/7'), { year: 2020, month: 7, day: null, ongoing: false })
  assert.deepEqual(parseDateText('2020年7月'), { year: 2020, month: 7, day: null, ongoing: false })
  assert.deepEqual(parseDateText('2020年7月15日'), { year: 2020, month: 7, day: 15, ongoing: false })
  assert.deepEqual(parseDateText(' 2023.12 '), { year: 2023, month: 12, day: null, ongoing: false })
})

test('D3 “至今”类开放区间：没有年份，不参与年份比较', () => {
  assert.deepEqual(parseDateText('至今'), { year: null, month: null, day: null, ongoing: true })
  assert.equal(parseDateText('Present')?.ongoing, true)
  assert.equal(parseDateText('现在')?.ongoing, true)
})

test('D4 非法值一律解析失败（不猜）', () => {
  assert.equal(parseDateText('最近'), null)
  assert.equal(parseDateText('去年'), null)
  assert.equal(parseDateText('2020-13'), null)
  assert.equal(parseDateText('2020-00'), null)
  assert.equal(parseDateText('2020-02-30'), null)
  assert.equal(parseDateText('2020.07.15.01'), null)
  assert.equal(parseDateText(''), null)
  assert.equal(parseDateText('   '), null)
})

test('D5 闰年 2 月按日历判定（2020-02-29 合法，2021-02-29 非法）', () => {
  assert.deepEqual(parseDateText('2020-02-29'), { year: 2020, month: 2, day: 29, ongoing: false })
  assert.equal(parseDateText('2019-02-29'), null)
  assert.equal(parseDateText('1900-02-29'), null)
  assert.deepEqual(parseDateText('2000-02-29'), { year: 2000, month: 2, day: 29, ongoing: false })
})
