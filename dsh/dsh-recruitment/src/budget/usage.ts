// task-78 / DESIGN §3.3：从 DSH 服务读**一次**真实 usage（只读 / 同步 / 绝不抛）。
//
// 现场核实的 DSH 0.2.2-rc.3 读取面（DESIGN §1）：
//   1) `ctx.sessionProjections.stateOf(session, 'tokenUsage')` →
//      `{ totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
//         last: { turn, step, buckets } | null }`
//      （registration 级 `stateOf` 已 deprecated，但**同步**可用；产品 profile 必装 token-meter）
//   2) 兜底 `ctx.tokenMeter.measure(session)` → `{ totalTokens, ... }`（只有单值）
//   3) 都不可用 → total 0 + `source='unavailable'`（如实标注，**禁止**伪造用量）
//
// 本文件是模块里唯一有「读服务」语义的文件：只读 DSH 内存态，不写、不连 DB、不连网络、
// 不读文件；服务缺失/抛错/形态不符一律降级，不把异常抛给工具闸门。
import type { BudgetTokenBuckets, BudgetUsageSource } from './types.ts'

/** 一次 usage 读取结果：四桶 + 来源 + DSH 步数（交叉核对用，无则 null）。 */
export interface SessionUsageRead {
  readonly buckets: BudgetTokenBuckets
  readonly source: BudgetUsageSource
  readonly dsh_step: number | null
}

const ZERO_BUCKETS: BudgetTokenBuckets = Object.freeze({
  uncached_input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  total: 0,
})

/** 取非负有限数字；负数 / NaN / Infinity / 非数字一律 0（不伪造用量）。 */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 四桶 + 合计（primary 路径保证 total = 四桶之和）。 */
function bucketsOf(uncachedInput: number, output: number, cacheRead: number, cacheWrite: number): BudgetTokenBuckets {
  return {
    uncached_input: uncachedInput,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: uncachedInput + output + cacheRead + cacheWrite,
  }
}

function unavailable(): SessionUsageRead {
  return { buckets: ZERO_BUCKETS, source: 'unavailable', dsh_step: null }
}

/** 1) 会话投影 `tokenUsage`（真实四桶 + last.step）。 */
function readProjection(ctx: unknown, session: unknown): SessionUsageRead | undefined {
  const services = ctx as
    | { readonly sessionProjections?: { readonly stateOf?: (session: unknown, name: string) => unknown } }
    | null
    | undefined
  const projections = services?.sessionProjections
  if (!projections || typeof projections.stateOf !== 'function') return undefined
  const state = projections.stateOf(session, 'tokenUsage')
  if (state === null || typeof state !== 'object') return undefined
  const stateRecord = state as { readonly totals?: unknown; readonly last?: unknown }
  const totals = stateRecord.totals
  if (totals === null || typeof totals !== 'object') return undefined
  const totalsRecord = totals as Record<string, unknown>
  const buckets = bucketsOf(
    readCount(totalsRecord.uncachedInputTokens),
    readCount(totalsRecord.outputTokens),
    readCount(totalsRecord.cacheReadTokens),
    readCount(totalsRecord.cacheWriteTokens),
  )
  const last = stateRecord.last
  let dshStep: number | null = null
  if (last !== null && typeof last === 'object') {
    const step = (last as Record<string, unknown>).step
    if (typeof step === 'number' && Number.isFinite(step)) dshStep = step
  }
  return { buckets, source: 'session_projection.tokenUsage', dsh_step: dshStep }
}

/**
 * 2) 兜底 `tokenMeter.measure()`：只有 total 单值。
 *
 * DESIGN §3.3 明确兜底路径「total 单值（其余桶 0）」——分桶不可知就**不臆造**分桶，
 * 因此本路径 `total ≠ Σ四桶`，由 `usage_source='tokenMeter.measure'` 如实标注。
 */
function readMeter(ctx: unknown, session: unknown): SessionUsageRead | undefined {
  const services = ctx as
    | { readonly tokenMeter?: { readonly measure?: (session: unknown) => unknown } }
    | null
    | undefined
  const meter = services?.tokenMeter
  if (!meter || typeof meter.measure !== 'function') return undefined
  const measurement = meter.measure(session)
  if (measurement === null || typeof measurement !== 'object') return undefined
  // 同步契约：异步测量面（thenable）不在这里 await，按不可用处理。
  if (typeof (measurement as { readonly then?: unknown }).then === 'function') return undefined
  const total = readCount((measurement as Record<string, unknown>).totalTokens)
  return {
    buckets: { uncached_input: 0, output: 0, cache_read: 0, cache_write: 0, total },
    source: 'tokenMeter.measure',
    dsh_step: null,
  }
}

/**
 * 读一次真实 usage（DESIGN §3.3，顺序固定：投影 → 计量兜底 → unavailable）。
 *
 * 只读、同步、**绝不抛**：整体 try/catch，服务缺失或状态异常一律降级为 unavailable。
 *
 * @param ctx - DSH 插件上下文（只按需读 `sessionProjections` / `tokenMeter`）。
 * @param session - live Agent 的 `session`（`exec.agent.session`）。
 */
export function readSessionUsage(ctx: unknown, session: unknown): SessionUsageRead {
  try {
    const projected = readProjection(ctx, session)
    if (projected !== undefined) return projected
  } catch {
    // 投影不可用 → 尝试计量兜底
  }
  try {
    const metered = readMeter(ctx, session)
    if (metered !== undefined) return metered
  } catch {
    // 计量也不可用 → unavailable
  }
  return unavailable()
}
