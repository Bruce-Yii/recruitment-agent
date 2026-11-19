// IANA 时区纯函数底座单测（无 I/O、不连库、不读时钟）。
// 覆盖：合法/非法时区名、DST 偏移、墙上时间换算、读侧老数据兼容。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  displayTimezone,
  formatInTimezone,
  getTimezoneOffsetMinutes,
  isValidIanaTimezone,
  localDateToUtcMs,
} from '../../src/domain/timezone.ts'

const MAR_07 = { year: 2026, month: 3, day: 7 }
const MAR_08 = { year: 2026, month: 3, day: 8 } // NY DST 切换日（02:00 跳到 03:00）
const MAR_09 = { year: 2026, month: 3, day: 9 }

// ---------------------------------------------------------------------------
//  1. isValidIanaTimezone —— 9 个样例
// ---------------------------------------------------------------------------

test('isValidIanaTimezone：合法 IANA 名（含 Etc/GMT+5、UTC）', () => {
  assert.equal(isValidIanaTimezone('Asia/Shanghai'), true)
  assert.equal(isValidIanaTimezone('America/New_York'), true)
  assert.equal(isValidIanaTimezone('Etc/GMT+5'), true)
  assert.equal(isValidIanaTimezone('UTC'), true)
})

test('isValidIanaTimezone：伪名 / 非法 / 空串全部拒绝', () => {
  assert.equal(isValidIanaTimezone('UTC+5'), false)
  assert.equal(isValidIanaTimezone('Not/AZone'), false)
  assert.equal(isValidIanaTimezone('🕐'), false)
  assert.equal(isValidIanaTimezone(''), false)
})

// ---------------------------------------------------------------------------
//  2. DST 偏移
// ---------------------------------------------------------------------------

test('getTimezoneOffsetMinutes：NY 2026-03-07 = -300，03-09 = -240', () => {
  assert.equal(getTimezoneOffsetMinutes('America/New_York', MAR_07), -300)
  assert.equal(getTimezoneOffsetMinutes('America/New_York', MAR_09), -240)
})

test('getTimezoneOffsetMinutes：上海两天均 +480（无 DST）', () => {
  assert.equal(getTimezoneOffsetMinutes('Asia/Shanghai', MAR_07), 480)
  assert.equal(getTimezoneOffsetMinutes('Asia/Shanghai', MAR_09), 480)
})

// ---------------------------------------------------------------------------
//  3. localDateToUtcMs —— DST 小时的 epoch 差
// ---------------------------------------------------------------------------

// 23h / 24h 对应的是**相邻两天** 03-07 → 03-08：03-08 02:00 NY 跳到 03:00，
// 当天 09:00 已是 DST（-04:00），故 09:00(03-07)→09:00(03-08) 只隔 23 小时。
// 若取 03-07 → 03-09（相隔两天），NY 为 47h、上海为 48h。
test('localDateToUtcMs：NY 09:00 相邻两天差 23 小时（跨 DST 少一小时）', () => {
  const a = localDateToUtcMs('America/New_York', MAR_07, 9 * 60)
  const b = localDateToUtcMs('America/New_York', MAR_08, 9 * 60)
  assert.equal(b - a, 23 * 60 * 60 * 1000)
})

test('localDateToUtcMs：上海 09:00 相邻两天差 24 小时', () => {
  const a = localDateToUtcMs('Asia/Shanghai', MAR_07, 9 * 60)
  const b = localDateToUtcMs('Asia/Shanghai', MAR_08, 9 * 60)
  assert.equal(b - a, 24 * 60 * 60 * 1000)
})

test('localDateToUtcMs：相隔两天（03-07→03-09）NY 为 47h、上海为 48h', () => {
  assert.equal(
    localDateToUtcMs('America/New_York', MAR_09, 540) - localDateToUtcMs('America/New_York', MAR_07, 540),
    47 * 60 * 60 * 1000,
  )
  assert.equal(
    localDateToUtcMs('Asia/Shanghai', MAR_09, 540) - localDateToUtcMs('Asia/Shanghai', MAR_07, 540),
    48 * 60 * 60 * 1000,
  )
})

test('localDateToUtcMs：结果格式化回来等于请求的墙上时间', () => {
  const at = localDateToUtcMs('America/New_York', MAR_09, 9 * 60)
  assert.equal(formatInTimezone(at, 'America/New_York'), '2026-03-09T09:00:00.000-04:00')
})

// ---------------------------------------------------------------------------
//  4. formatInTimezone + displayTimezone 老数据兼容
// ---------------------------------------------------------------------------

test('formatInTimezone：按 DST 输出正确的偏移文本', () => {
  const winter = localDateToUtcMs('America/New_York', MAR_07, 9 * 60)
  const summer = localDateToUtcMs('America/New_York', MAR_09, 9 * 60)
  assert.equal(formatInTimezone(winter, 'America/New_York'), '2026-03-07T09:00:00.000-05:00')
  assert.equal(formatInTimezone(summer, 'America/New_York'), '2026-03-09T09:00:00.000-04:00')
})

test('formatInTimezone：非法时区抛错（不偷偷按 +8 展示）', () => {
  assert.throws(() => formatInTimezone(0, 'UTC+5'), RangeError)
})

test('displayTimezone：合法原样；非法与缺失如实显示', () => {
  assert.equal(displayTimezone('Asia/Shanghai'), 'Asia/Shanghai')
  assert.equal(displayTimezone('UTC+5'), '未知时区（原值：UTC+5）')
  assert.equal(displayTimezone('Not/AZone'), '未知时区（原值：Not/AZone）')
  assert.equal(displayTimezone(null), '未记录时区')
  assert.equal(displayTimezone(undefined), '未记录时区')
  assert.equal(displayTimezone(''), '未记录时区')
})
