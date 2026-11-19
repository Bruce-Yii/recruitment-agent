// 面试时段交集算法（纯函数，零 I/O、零时钟、零库、零网络）。
//
// 目标（docs/34 §二.2-3 / docs/36 C1）：排期/改期前，给出候选人与面试官的
// **空闲时段交集**（2–3 个槽）。本文件只做「算法」：把每个参与人的忙区间
// （来自日历只读回读）转成空闲窗口，再对全体参与人求交，切成 duration_minutes
// 长的候选槽，按开始时间升序返回前 `proposed` 个。
//
// 三条不许破的规矩：
//   1. **只给交集，不编时段**：任何一个参与人的回读失败 / 无绑定，都不得由本
//      算法补时段。调用方（HTTP 路由）必须先把这些人放进 unsatisfied，并把
//      他们的回读从输入里剔除；本算法在参与者集合为空、区间为空、窗口不足以
//      容纳 duration 时返回空数组（`[]`），**不会**造一个「看起来合理」的槽。
//   2. **忙区间的合并与裁剪是纯几何**：半开区间 `[start, end)`；相交/相接的
//      忙区间先合并（避免把同一场会切成两段空闲），再用工作时段（默认 09:00–
//      19:00，本地时区偏移由调用方给定）裁剪。日期与偏移只由入参提供，不读
//      `Date.now()`、不读进程时区。
//   3. **冲突计数诚实**：`busy_conflicts` 是该槽与所有参与人原始忙区间直接重叠
//      的条数（合并前计数）。交集算法保证输出槽与已合并忙区间不相交，因此正常
//      情况下为 0；若调用方传入的原始忙区间与合并结果不一致（不应发生），计数
//      会如实 > 0，而不是写死 0。
//
// 时间统一用 **epoch 毫秒整数**做几何运算（避免时区/夏令时算错），对外再
// 用入参里的 `timezone_offset_minutes` 还原成带偏移的 ISO-8601 字符串。

/** 半开区间 `[start_ms, end_ms)`，`source` 只作诊断，不参与几何。 */
export interface Interval {
  readonly start_ms: number
  readonly end_ms: number
}

/** 一个参与人（候选人或面试官）的忙区间集合。 */
export interface BusyParticipant {
  /** 稳定标识（候选人或面试官 actor id），仅用于透传，不参与几何。 */
  readonly participant_id: string
  /** 该参与人的忙区间（可能重叠/相接；算法内部合并）。 */
  readonly busy: readonly Interval[]
}

/** 一天的工作窗（本地墙上时间，分钟）。半开 `[start_minute, end_minute)`。 */
export interface WorkWindow {
  readonly start_minute: number
  readonly end_minute: number
}

/** 默认工作窗：09:00–19:00（本地时间，含 10 小时）。 */
export const DEFAULT_WORK_WINDOW: WorkWindow = { start_minute: 9 * 60, end_minute: 19 * 60 }

/** 时间槽步长（分钟）：候选槽按 30 分钟网格对齐，便于人读与排期。 */
export const SLOT_GRID_MINUTES = 30

/** 最多提议多少个槽（契约 2–3 个）。 */
export const DEFAULT_PROPOSED = 3

/** 一天最多能产生的候选槽数上限（防御性：防止 duration=1 时爆量）。 */
export const MAX_SLOTS_PER_DAY = 48

/** 一个候选槽（对外形状）。 */
export interface FreeSlot {
  /** 带时区偏移的 ISO-8601 开始时间，例如 `2026-11-20T10:00:00.000+08:00`。 */
  readonly start: string
  readonly end: string
  /** 与该槽直接重叠的原始忙区间条数（正常为 0）。 */
  readonly busy_conflicts: number
  /** 时段来源：`LIVE`（真实日历回读）或 `FIXTURE`（回放/测试通道）。 */
  readonly source: 'LIVE' | 'FIXTURE'
}

/** `computeFreeSlots` 的入参（全部显式，不读全局状态）。 */
export interface FreeSlotsInput {
  /** 参与人（至少一人；为空返回空）。 */
  readonly participants: readonly BusyParticipant[]
  /**
   * 要覆盖的本地日期（年月日，按 `timezone_offset_minutes` 解释）。
   * 每天独立求交；跨天不连成一个槽（面试不跨夜）。
   */
  readonly dates: readonly { year: number; month: number; day: number }[]
  /** 本地时区偏移（分钟，东为正，例如 +08:00 = 480）。 */
  readonly timezone_offset_minutes: number
  /** 单个槽时长（分钟，1..480）。 */
  readonly duration_minutes: number
  /** 工作窗（默认 `DEFAULT_WORK_WINDOW`）。 */
  readonly work_window?: WorkWindow
  /** 最多返回几个槽（默认 `DEFAULT_PROPOSED`）。 */
  readonly proposed?: number
  /** 槽的来源标签（默认 `LIVE`；调用方按 R4 在拿不到日历时改成 `FIXTURE`）。 */
  readonly source?: 'LIVE' | 'FIXTURE'
}

/** 把本地日期的某分钟换算成 epoch 毫秒（纯函数，不读进程时区）。 */
function localMinuteToMs(
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
  offsetMinutes: number,
): number {
  const utcMs = Date.UTC(date.year, date.month - 1, date.day, 0, 0, 0, 0)
  return utcMs + (minuteOfDay - offsetMinutes) * 60_000
}

/** 把 epoch 毫秒格式化成带给定偏移的 ISO-8601（毫秒恒 000）。 */
export function formatWithOffset(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60_000)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  const offsetText = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    + `.000${offsetText}`
  )
}

/** 合并重叠/相接的区间（闭开 `[start,end)`；`a.end === b.start` 视为相接）。 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const valid = intervals
    .filter((it) => Number.isFinite(it.start_ms) && Number.isFinite(it.end_ms) && it.end_ms > it.start_ms)
    .map((it) => ({ start_ms: it.start_ms, end_ms: it.end_ms }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
  const merged: Interval[] = []
  for (const it of valid) {
    const last = merged[merged.length - 1]
    if (last !== undefined && it.start_ms <= last.end_ms) {
      merged[merged.length - 1] = { start_ms: last.start_ms, end_ms: Math.max(last.end_ms, it.end_ms) }
    } else {
      merged.push({ ...it })
    }
  }
  return merged
}

/**
 * 从一个忙区间集合里，算出工作窗内的空闲子区间列表。
 * @param busy - 原始忙区间（内部先合并）。
 * @param windowStartMs - 工作窗开始（epoch ms）。
 * @param windowEndMs - 工作窗结束（epoch ms）。
 */
function freeWithin(busy: readonly Interval[], windowStartMs: number, windowEndMs: number): Interval[] {
  const merged = mergeIntervals(busy)
  const free: Interval[] = []
  let cursor = windowStartMs
  for (const it of merged) {
    if (it.end_ms <= windowStartMs) continue
    if (it.start_ms >= windowEndMs) break
    const overlapStart = Math.max(it.start_ms, windowStartMs)
    if (overlapStart > cursor) free.push({ start_ms: cursor, end_ms: overlapStart })
    cursor = Math.max(cursor, Math.min(it.end_ms, windowEndMs))
    if (cursor >= windowEndMs) break
  }
  if (cursor < windowEndMs) free.push({ start_ms: cursor, end_ms: windowEndMs })
  return free
}

/** 两个空闲区间列表的交集（双指针）。 */
export function intersectFree(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i]!.start_ms, b[j]!.start_ms)
    const end = Math.min(a[i]!.end_ms, b[j]!.end_ms)
    if (end > start) out.push({ start_ms: start, end_ms: end })
    if (a[i]!.end_ms <= b[j]!.end_ms) i += 1
    else j += 1
  }
  return out
}

/** 一条槽与原始忙区间（合并后）直接重叠的条数。正常交集算法输出应为 0。 */
function conflictCount(mergedBusy: readonly Interval[], startMs: number, endMs: number): number {
  let count = 0
  for (const it of mergedBusy) {
    if (it.start_ms < endMs && it.end_ms > startMs) count += 1
  }
  return count
}

/**
 * 计算全体参与人的空闲交集槽（纯函数）。
 *
 * 流程：对每个日期：
 *   ① 参与人忙区间 → 工作窗内空闲窗口；
 *   ② 对全体参与人空闲窗口求交（n 元交集）；
 *   ③ 在每个交集窗口上，按 30 分钟网格对齐、切出 `duration_minutes` 长的槽；
 *   ④ 按开始时间升序汇总，返回前 `proposed` 个。
 * 无参与人 / 无日期 / 交集为空 / 窗口不足时长 → 返回空数组（不编时段）。
 */
export function computeFreeSlots(input: FreeSlotsInput): FreeSlot[] {
  const participants = input.participants
  if (participants.length === 0) return []
  if (input.dates.length === 0) return []
  const durationMs = input.duration_minutes * 60_000
  if (!Number.isFinite(durationMs) || durationMs <= 0 || input.duration_minutes > 480) return []
  const work = input.work_window ?? DEFAULT_WORK_WINDOW
  if (!Number.isFinite(work.start_minute) || !Number.isFinite(work.end_minute) || work.end_minute <= work.start_minute) {
    return []
  }
  const proposed = input.proposed ?? DEFAULT_PROPOSED
  const limit = Math.max(0, Math.min(proposed, 10))
  const source = input.source ?? 'LIVE'
  const offset = input.timezone_offset_minutes
  const gridMs = SLOT_GRID_MINUTES * 60_000

  // 每个参与人的原始忙区间先合并一次（冲突计数也用这份，避免口径漂移）。
  const mergedBusyByParticipant = participants.map((p) => mergeIntervals(p.busy))

  const slots: Array<{ start_ms: number; end_ms: number; conflicts: number }> = []
  for (const date of input.dates) {
    if (!Number.isInteger(date.year) || !Number.isInteger(date.month) || !Number.isInteger(date.day)) continue
    const windowStartMs = localMinuteToMs(date, work.start_minute, offset)
    const windowEndMs = localMinuteToMs(date, work.end_minute, offset)
    if (windowEndMs <= windowStartMs) continue

    // ① 每个参与人在工作窗内的空闲窗口。
    let common = freeWithin(participants[0]!.busy, windowStartMs, windowEndMs)
    // ② 与其余参与人求交。
    for (let i = 1; i < participants.length && common.length > 0; i += 1) {
      const otherFree = freeWithin(participants[i]!.busy, windowStartMs, windowEndMs)
      common = intersectFree(common, otherFree)
    }
    if (common.length === 0) continue

    // ③ 在每个交集窗口上切槽（网格对齐，最多 MAX_SLOTS_PER_DAY 个）。
    for (const window of common) {
      const firstGrid = Math.ceil(window.start_ms / gridMs) * gridMs
      let produced = 0
      for (let start = firstGrid; start + durationMs <= window.end_ms && produced < MAX_SLOTS_PER_DAY; start += gridMs) {
        let conflicts = 0
        for (let i = 0; i < mergedBusyByParticipant.length; i += 1) {
          conflicts += conflictCount(mergedBusyByParticipant[i]!, start, start + durationMs)
        }
        slots.push({ start_ms: start, end_ms: start + durationMs, conflicts })
        produced += 1
      }
    }
  }

  slots.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
  return slots.slice(0, limit).map((slot) => ({
    start: formatWithOffset(slot.start_ms, offset),
    end: formatWithOffset(slot.end_ms, offset),
    busy_conflicts: slot.conflicts,
    source,
  }))
}

/**
 * 把一个参与人的忙区间列表投影到「只含 epoch 毫秒」的形状（供 HTTP 层把
 * 外部回读的 ISO 时间转成算法输入；转换本身在 HTTP 层做，本函数只做归一化）。
 */
export function toInterval(startMs: number, endMs: number): Interval {
  return { start_ms: startMs, end_ms: endMs }
}
