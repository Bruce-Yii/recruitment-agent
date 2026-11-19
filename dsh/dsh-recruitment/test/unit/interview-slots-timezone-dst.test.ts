// Owner 自测：IANA 路径的 computeFreeSlots 在 DST 切换周不漂移（P2 / 审计 §③-2）。
//
// 与 B 的纯函数单测互补：这里断言的是**时段算法**按 IANA 动态取偏移后的输出，
// 覆盖一个切换夏令时的时区（America/New_York，2026-03-08 02:00 跳到 -04:00）
// 与一个不切换的时区（Asia/Shanghai）。固定 +8 的旧路径不再参与 HTTP 入口。
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeFreeSlots, type BusyParticipant } from '../../src/domain/interview-slots.ts'
import { isValidIanaTimezone, localDateToUtcMs } from '../../src/domain/timezone.ts'

const day = (year: number, month: number, date: number): { year: number; month: number; day: number } => ({ year, month, day: date })

/** 无忙区间的一个参与人（只检验工作窗换算，不检验交集）。 */
const free: readonly BusyParticipant[] = [{ participant_id: 'p1', busy: [] }]

test('IANA 校验：UTC+5 / Not/AZone 被拒，Asia/Shanghai 与 America/New_York 通过', () => {
  assert.equal(isValidIanaTimezone('Asia/Shanghai'), true)
  assert.equal(isValidIanaTimezone('America/New_York'), true)
  assert.equal(isValidIanaTimezone('UTC+5'), false)
  assert.equal(isValidIanaTimezone('Not/AZone'), false)
})

test('DST 切换周：NY 03-07 的槽是 -05:00、03-08 的槽是 -04:00，墙上时间同为 09:00', () => {
  const slots = computeFreeSlots({
    participants: free,
    dates: [day(2026, 3, 7), day(2026, 3, 8)],
    iana_timezone: 'America/New_York',
    duration_minutes: 60,
    proposed: 4,
    // 窄工作窗让每天只切 2 个槽，避免首日占满 proposed 上限看不到切换日。
    work_window: { start_minute: 9 * 60, end_minute: 11 * 60 },
    source: 'FIXTURE',
  })
  assert.ok(slots.length >= 2, `期望至少 2 个槽，实际 ${slots.length}`)
  const first = slots[0]!
  assert.ok(first.start.endsWith('-05:00'), `03-07 应是冬令时 -05:00，实际 ${first.start}`)
  assert.ok(first.start.includes('T09:00:00.000'), `03-07 首槽应落在 09:00，实际 ${first.start}`)
  const after = slots.find((slot) => slot.start.startsWith('2026-03-08'))
  assert.ok(after !== undefined, '应有 03-08 的槽')
  assert.ok(after.start.endsWith('-04:00'), `03-08 已是夏令时 -04:00，实际 ${after.start}`)
  assert.ok(after.start.includes('T09:00:00.000'), `03-08 首槽应仍是 09:00（不漂移 1 小时），实际 ${after.start}`)
})

test('不切换夏令时的对照：Asia/Shanghai 两天都是 +08:00，墙上时间 09:00 不变', () => {
  const slots = computeFreeSlots({
    participants: free,
    dates: [day(2026, 3, 7), day(2026, 3, 8)],
    iana_timezone: 'Asia/Shanghai',
    duration_minutes: 60,
    proposed: 4,
    work_window: { start_minute: 9 * 60, end_minute: 11 * 60 },
    source: 'FIXTURE',
  })
  assert.ok(slots.length >= 2)
  for (const slot of slots) {
    assert.ok(slot.start.endsWith('+08:00'), `上海应恒 +08:00，实际 ${slot.start}`)
  }
  assert.ok(slots[0]!.start.includes('T09:00:00.000'))
})

test('绝对时刻比较：NY 09:00 两天相差 23 小时（epoch 差），上海相差 24 小时', () => {
  const ny7 = localDateToUtcMs('America/New_York', day(2026, 3, 7), 9 * 60)
  const ny8 = localDateToUtcMs('America/New_York', day(2026, 3, 8), 9 * 60)
  const sh7 = localDateToUtcMs('Asia/Shanghai', day(2026, 3, 7), 9 * 60)
  const sh8 = localDateToUtcMs('Asia/Shanghai', day(2026, 3, 8), 9 * 60)
  assert.equal(ny8 - ny7, 23 * 60 * 60_000)
  assert.equal(sh8 - sh7, 24 * 60 * 60_000)
})
