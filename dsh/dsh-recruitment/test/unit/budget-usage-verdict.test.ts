/**
 * task-78 / DESIGN §3.3 + §3.5：usage 读取 + 预算判定单测。
 *
 * usage 钉死：
 *   1. 顺序：`ctx.sessionProjections.stateOf(session,'tokenUsage')` → `ctx.tokenMeter.measure(session)` → unavailable；
 *   2. 投影路径：四桶 + total=四桶之和 + `last.step` → dsh_step；
 *   3. 兜底路径：只有 total 单值（其余桶 0），`source='tokenMeter.measure'`；
 *   4. 全部不可用 / 服务抛错 / 形态不符 / 异步面 → total 0 + `source='unavailable'`，**绝不抛**；
 *   5. 负数 / NaN / Infinity 的计数一律按 0（不伪造用量）。
 *
 * verdict 钉死（DESIGN §3.5）：`tokens.total > max_tokens` 或 `steps > max_steps` → within=false；
 * 等于阈值仍算 within（`<=`）；`over` 顺序 tokens 在前、steps 在后。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateBudget, readSessionUsage, type BudgetTokenBuckets } from '../../src/budget/index.ts'

function bucketsOf(uncachedInput: number, output = 0, cacheRead = 0, cacheWrite = 0): BudgetTokenBuckets {
  return {
    uncached_input: uncachedInput,
    output,
    cache_read: cacheRead,
    cache_write: cacheWrite,
    total: uncachedInput + output + cacheRead + cacheWrite,
  }
}

function projectionState(totals: Record<string, unknown>, last: unknown): Record<string, unknown> {
  return { totals, last }
}

test('usage 投影路径：四桶 + total=四桶之和 + dsh_step=last.step', () => {
  const ctx = {
    sessionProjections: {
      stateOf: (_session: unknown, name: string) =>
        name === 'tokenUsage'
          ? projectionState(
              {
                uncachedInputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 2000,
                cacheWriteTokens: 250,
              },
              { turn: 3, step: 7, buckets: {} },
            )
          : undefined,
    },
  }
  const usage = readSessionUsage(ctx, { id: 'session-1' })
  assert.deepEqual({ ...usage.buckets }, {
    uncached_input: 1000,
    output: 500,
    cache_read: 2000,
    cache_write: 250,
    total: 3750,
  })
  assert.equal(usage.source, 'session_projection.tokenUsage')
  assert.equal(usage.dsh_step, 7)
})

test('usage 投影路径：last=null → dsh_step=null；杂负值归零', () => {
  const ctx = {
    sessionProjections: {
      stateOf: () =>
        projectionState(
          {
            uncachedInputTokens: -5,
            outputTokens: Number.NaN,
            cacheReadTokens: Number.POSITIVE_INFINITY,
            cacheWriteTokens: 'not-a-number',
          },
          null,
        ),
    },
  }
  const usage = readSessionUsage(ctx, { id: 'session-1' })
  assert.deepEqual({ ...usage.buckets }, {
    uncached_input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  })
  assert.equal(usage.source, 'session_projection.tokenUsage')
  assert.equal(usage.dsh_step, null)
})

test('usage 兜底路径：投影缺失 → tokenMeter.measure 的 totalTokens（其余桶 0）', () => {
  const ctx = { tokenMeter: { measure: () => ({ totalTokens: 4321, inputTokens: 1 }) } }
  const usage = readSessionUsage(ctx, { id: 'session-1' })
  assert.deepEqual({ ...usage.buckets }, {
    uncached_input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    total: 4321,
  })
  assert.equal(usage.source, 'tokenMeter.measure')
  assert.equal(usage.dsh_step, null)
})

test('usage 投影抛错 / 形态不符 → 降级到 tokenMeter', () => {
  const throwing = {
    sessionProjections: {
      stateOf: () => {
        throw new Error('projection missing')
      },
    },
    tokenMeter: { measure: () => ({ totalTokens: 99 }) },
  }
  assert.equal(readSessionUsage(throwing, { id: 's' }).source, 'tokenMeter.measure')
  assert.equal(readSessionUsage(throwing, { id: 's' }).buckets.total, 99)

  const noTotals = {
    sessionProjections: { stateOf: () => ({ last: { step: 2 } }) },
    tokenMeter: { measure: () => ({ totalTokens: 77 }) },
  }
  assert.equal(readSessionUsage(noTotals, { id: 's' }).source, 'tokenMeter.measure')
})

test('usage 都不可用 → total 0 + source=unavailable（不抛，含 ctx/session 为 null）', () => {
  for (const ctx of [undefined, null, {}, { sessionProjections: {} }, { tokenMeter: {} }]) {
    const usage = readSessionUsage(ctx, undefined)
    assert.equal(usage.buckets.total, 0, `ctx=${String(ctx)}`)
    assert.equal(usage.source, 'unavailable', `ctx=${String(ctx)}`)
    assert.equal(usage.dsh_step, null)
  }
})

test('usage：异步 measure（thenable）按不可用处理（本契约是同步读取面）', () => {
  const ctx = { tokenMeter: { measure: async () => ({ totalTokens: 5 }) } }
  const usage = readSessionUsage(ctx, { id: 's' })
  assert.equal(usage.source, 'unavailable')
  assert.equal(usage.buckets.total, 0)
})

test('usage：measure 抛错 → unavailable（绝不抛给闸门）', () => {
  const ctx = {
    tokenMeter: {
      measure: () => {
        throw new Error('boom')
      },
    },
  }
  assert.equal(readSessionUsage(ctx, { id: 's' }).source, 'unavailable')
})

function snapshotOf(input: {
  total: number
  steps: number
  maxTokens: number
  maxSteps: number
}): ReturnType<typeof evaluateBudget> {
  return evaluateBudget({
    session_id: 'session-1',
    task_class: 'SCREENING',
    task_class_source: 'configured',
    tokens: bucketsOf(input.total),
    steps: input.steps,
    dsh_step: 3,
    limits: { max_tokens: input.maxTokens, max_steps: input.maxSteps },
    usage_source: 'session_projection.tokenUsage',
    last_tool: 'recruitment_resume_read',
    tools_used: { recruitment_resume_read: input.steps },
  })
}

test('verdict：等于阈值算 within（<=），超出才算 over', () => {
  const atLimit = snapshotOf({ total: 100, steps: 5, maxTokens: 100, maxSteps: 5 })
  assert.equal(atLimit.within, true)
  assert.deepEqual(atLimit.over, [])

  const overTokens = snapshotOf({ total: 101, steps: 5, maxTokens: 100, maxSteps: 5 })
  assert.equal(overTokens.within, false)
  assert.deepEqual(overTokens.over, [{ dimension: 'tokens', used: 101, limit: 100 }])

  const overSteps = snapshotOf({ total: 100, steps: 6, maxTokens: 100, maxSteps: 5 })
  assert.equal(overSteps.within, false)
  assert.deepEqual(overSteps.over, [{ dimension: 'steps', used: 6, limit: 5 }])
})

test('verdict：两维都超时 over 顺序 = tokens 在前、steps 在后', () => {
  const snapshot = snapshotOf({ total: 999, steps: 9, maxTokens: 100, maxSteps: 5 })
  assert.equal(snapshot.within, false)
  assert.deepEqual(snapshot.over, [
    { dimension: 'tokens', used: 999, limit: 100 },
    { dimension: 'steps', used: 9, limit: 5 },
  ])
})

test('verdict：快照字段原样透传（session_id / 分类来源 / usage 来源 / last_tool / tools_used）', () => {
  const snapshot = snapshotOf({ total: 1, steps: 1, maxTokens: 100, maxSteps: 5 })
  assert.equal(snapshot.session_id, 'session-1')
  assert.equal(snapshot.task_class, 'SCREENING')
  assert.equal(snapshot.task_class_source, 'configured')
  assert.equal(snapshot.usage_source, 'session_projection.tokenUsage')
  assert.equal(snapshot.dsh_step, 3)
  assert.equal(snapshot.last_tool, 'recruitment_resume_read')
  assert.deepEqual(snapshot.tools_used, { recruitment_resume_read: 1 })
  assert.deepEqual(snapshot.limits, { max_tokens: 100, max_steps: 5 })
})
