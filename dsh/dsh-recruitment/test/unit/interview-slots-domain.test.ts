// 面试空闲时段交集算法单测（纯函数，真样例，不连网、不连库）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeFreeSlots,
  DEFAULT_WORK_WINDOW,
  formatWithOffset,
  intersectFree,
  mergeIntervals,
  SLOT_GRID_MINUTES,
  type BusyParticipant,
  type Interval,
} from '../../src/domain/interview-slots.ts'

const OFFSET = 8 * 60 // +08:00
const DATE = { year: 2026, month: 11, day: 20 }

/** 本地墙上时间（分钟）→ epoch ms，测试里用与生产同源的换算。 */
function localMs(minuteOfDay: number, date = DATE): number {
  return Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0) + (minuteOfDay - OFFSET) * 60_000
}

function participant(id: string, busyMinutes: ReadonlyArray<readonly [number, number]>): BusyParticipant {
  return { participant_id: id, busy: busyMinutes.map(([s, e]) => ({ start_ms: localMs(s), end_ms: localMs(e) })) }
}

// ---------------------------------------------------------------------------

test('mergeIntervals：重叠/相接合并，乱序输入也归一', () => {
  const merged = mergeIntervals([
    { start_ms: 300, end_ms: 400 },
    { start_ms: 100, end_ms: 200 },
    { start_ms: 200, end_ms: 250 }, // 与上一条相接 → 合并成 [100,250)
    { start_ms: 180, end_ms: 220 }, // 与合并后的重叠 → 吞掉
    { start_ms: 500, end_ms: 500 }, // 空区间丢弃
  ])
  assert.deepEqual(merged, [
    { start_ms: 100, end_ms: 250 },
    { start_ms: 300, end_ms: 400 },
  ])
})

test('intersectFree：两段空闲求交只剩真正重叠的部分', () => {
  const a: Interval[] = [{ start_ms: 0, end_ms: 100 }, { start_ms: 200, end_ms: 300 }]
  const b: Interval[] = [{ start_ms: 50, end_ms: 250 }]
  assert.deepEqual(intersectFree(a, b), [
    { start_ms: 50, end_ms: 100 },
    { start_ms: 200, end_ms: 250 },
  ])
})

test('formatWithOffset：epoch ms → 带 +08:00 的 ISO-8601', () => {
  const ms = localMs(9 * 60)
  assert.equal(formatWithOffset(ms, OFFSET), '2026-11-20T09:00:00.000+08:00')
})

test('交集真样例：两名面试官都空的时间才给槽，忙时绝不出现', () => {
  // 面试官 A：10:00–11:00 忙；面试官 B：11:00–12:00 忙。
  // 工作窗 09:00–19:00；共同空闲 = 09:00–10:00 + 12:00–19:00。
  // duration=45 → 09:00/09:30? 09:30+45=10:15 越过 10:00 → 只有 09:00；
  // 12:00 起每 30 分钟一个，直到不超过 19:00。
  const slots = computeFreeSlots({
    participants: [
      participant('A', [[10 * 60, 11 * 60]]),
      participant('B', [[11 * 60, 12 * 60]]),
    ],
    dates: [DATE],
    timezone_offset_minutes: OFFSET,
    duration_minutes: 45,
    proposed: 3,
  })
  assert.equal(slots.length, 3)
  assert.deepEqual(slots.map((s) => s.start), [
    '2026-11-20T09:00:00.000+08:00',
    '2026-11-20T12:00:00.000+08:00',
    '2026-11-20T12:30:00.000+08:00',
  ])
  for (const s of slots) assert.equal(s.busy_conflicts, 0)
  assert.ok(slots.every((s) => s.source === 'LIVE'))
  // 每个槽的 end - start = 45 分钟。
  for (const s of slots) assert.equal(Date.parse(s.end) - Date.parse(s.start), 45 * 60_000)
})

test('三人交集：任一人忙就砍掉那段，网格 30 分钟对齐', () => {
  const slots = computeFreeSlots({
    participants: [
      participant('A', [[9 * 60, 10 * 60]]),
      participant('B', [[10 * 60, 11 * 60]]),
      participant('C', [[9 * 60 + 15, 10 * 60 + 45]]), // 9:15–10:45
    ],
    dates: [DATE],
    timezone_offset_minutes: OFFSET,
    duration_minutes: 30,
    proposed: 2,
  })
  // A 空 10:00–19:00，B 空 09:00–10:00 + 11:00–19:00，C 空 …10:45–19:00
  // 交集 11:00–19:00 → 从 11:00 起每 30 分钟。
  assert.deepEqual(slots.map((s) => s.start), [
    '2026-11-20T11:00:00.000+08:00',
    '2026-11-20T11:30:00.000+08:00',
  ])
  assert.equal(SLOT_GRID_MINUTES, 30)
})

test('无参与人 / 无日期 / 时长非法 → 空（绝不编时段）', () => {
  assert.deepEqual(computeFreeSlots({ participants: [], dates: [DATE], timezone_offset_minutes: OFFSET, duration_minutes: 45 }), [])
  assert.deepEqual(computeFreeSlots({ participants: [participant('A', [])], dates: [], timezone_offset_minutes: OFFSET, duration_minutes: 45 }), [])
  assert.deepEqual(computeFreeSlots({ participants: [participant('A', [])], dates: [DATE], timezone_offset_minutes: OFFSET, duration_minutes: 0 }), [])
})

test('全天被占满 → 空（不伪造「没忙碌=有空」）', () => {
  const slots = computeFreeSlots({
    participants: [participant('A', [[9 * 60, 19 * 60]])],
    dates: [DATE],
    timezone_offset_minutes: OFFSET,
    duration_minutes: 45,
  })
  assert.deepEqual(slots, [])
})

test('工作时间外（午休自定义）也按工作窗裁剪', () => {
  const slots = computeFreeSlots({
    participants: [participant('A', [])],
    dates: [DATE],
    timezone_offset_minutes: OFFSET,
    duration_minutes: 60,
    proposed: 1,
    work_window: { start_minute: 14 * 60, end_minute: 15 * 60 },
  })
  assert.deepEqual(slots.map((s) => s.start), ['2026-11-20T14:00:00.000+08:00'])
})

test('跨多天：日期升序、每天独立切槽（不跨夜）', () => {
  const day2 = { year: 2026, month: 11, day: 21 }
  const slots = computeFreeSlots({
    participants: [participant('A', [], )],
    dates: [DATE, day2],
    timezone_offset_minutes: OFFSET,
    duration_minutes: 60,
    proposed: 4,
  })
  // 网格是 30 分钟：60 分钟的槽也从 09:00 / 09:30 / 10:00 / 10:30 起。
  assert.deepEqual(slots.map((s) => s.start), [
    '2026-11-20T09:00:00.000+08:00',
    '2026-11-20T09:30:00.000+08:00',
    '2026-11-20T10:00:00.000+08:00',
    '2026-11-20T10:30:00.000+08:00',
  ])
  assert.deepEqual(DEFAULT_WORK_WINDOW, { start_minute: 540, end_minute: 1140 })
})
