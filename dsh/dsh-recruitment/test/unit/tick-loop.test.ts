// tick-loop 的纯单元验收：不连库、不起进程，用假 pool / 假 client / 假 router
// 逐条锁死 `work/verify-2026-11-15-g1/wiring/API-CONTRACT.md` §1/§2 的可观察行为。
//
// 为什么这些断言值得写：tick-loop 是"事件自动驱动"的唯一心跳。它错了不会立刻让业务
// 数据变脏，而是让整条链**看起来在跑**（或悄悄停摆）——即 R2 假接线。所以这里断言的是
// 外部可观察事实：抢锁 SQL 的形态与参数、首 tick 的时机、防重入、异常不上抛、
// dispose 的清理顺序与次数，而不是实现内部字段。
//
// 锁的真实跨连接互斥不在这里证明：假 pool 只能证明"调用顺序/次数对"。真 PG 上
// 两个实例互相让路的证据见 `test/integration/tick-loop.test.ts`（两者不互相代替）。
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import {
  DEFAULT_TICK_INTERVAL_MS,
  TICK_INTERVAL_MAX_MS,
  TICK_INTERVAL_MIN_MS,
  resolveRuntimeConfig,
} from '../../src/runtime/config.ts'
import type { RuntimeConfig } from '../../src/runtime/config.ts'
import { TICK_LOCK_KEY, startTickLoop } from '../../src/runtime/tick-loop.ts'
import type { TickLockConnection, TickLockPool, TickLoop, TickLoopOptions } from '../../src/runtime/tick-loop.ts'

// ---------------------------------------------------------------------------
//  测试替身：只实现 tick-loop 需要的最小连接面（与契约里的结构类型一一对应）
// ---------------------------------------------------------------------------

/** 一次 SQL 调用的记录（用于断言"发在哪条连接上 / 参数化没拼串"）。 */
interface QueryRecord {
  readonly sql: string
  readonly values: readonly unknown[]
  readonly clientId: number
}

/** 结构上满足 `TickLockConnection` 的假连接。 */
interface FakeClient extends TickLockConnection {
  readonly clientId: number
  readonly queries: QueryRecord[]
  releaseCount: number
}

/**
 * 造一条假连接。
 * @param clientId - 连接身份（断言 unlock 与 lock 在同一条连接上）。
 * @param locked - `pg_try_advisory_lock` 的返回值。
 */
function createFakeClient(clientId: number, locked: boolean): FakeClient {
  const client: FakeClient = {
    clientId,
    queries: [],
    releaseCount: 0,
    async query(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }> {
      client.queries.push({ sql, values: values ?? [], clientId })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ locked }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ unlocked: true }] }
      return { rows: [] }
    },
    release(): void {
      client.releaseCount += 1
    },
    on(_event: 'error', _listener: (error: Error) => void): unknown {
      return client
    },
  }
  return client
}

/** 假连接池：**每次 connect() 都给一条新连接**，这样"专用连接"才是可验证的事实。 */
function createFakePool(locked: boolean): {
  readonly pool: TickLockPool
  readonly clients: readonly FakeClient[]
  readonly state: { connectCalls: number }
} {
  const clients: FakeClient[] = []
  const state = { connectCalls: 0 }
  const pool: TickLockPool = {
    async connect(): Promise<TickLockConnection> {
      state.connectCalls += 1
      const client = createFakeClient(clients.length + 1, locked)
      clients.push(client)
      return client
    },
  }
  return { pool, clients, state }
}

/** 记录每次 tick 的假 router（含调用时刻与收到的取消信号）。 */
interface FakeRouter {
  readonly calls: { readonly at: number; readonly signal: AbortSignal }[]
  tick(signal: AbortSignal): Promise<unknown>
}

/**
 * 造一个假 router。
 * @param handler - 一次 tick 的实现（抛错用例也走这里）。
 */
function createRouter(handler: (signal: AbortSignal) => Promise<unknown>): FakeRouter {
  const calls: { at: number; signal: AbortSignal }[] = []
  return {
    calls,
    async tick(signal: AbortSignal): Promise<unknown> {
      calls.push({ at: Date.now(), signal })
      return handler(signal)
    },
  }
}

/** 记录 warn 的 logger（契约只依赖这一种日志级别）。 */
function createLogger(): { readonly warnings: string[]; readonly logger: { warn(message: string): void } } {
  const warnings: string[] = []
  return { warnings, logger: { warn(message: string): void { warnings.push(message) } } }
}

// ---------------------------------------------------------------------------
//  时间工具：等"事实发生"而不是等固定睡眠（避免慢 CI 上假红/假绿）
// ---------------------------------------------------------------------------

/** 睡 `ms` 毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 轮询直到 `predicate()` 为真。
 * @returns 从调用到为真的毫秒数（用来断言"立即发生"）。
 */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<number> {
  const startedAt = Date.now()
  for (;;) {
    if (predicate()) return Date.now() - startedAt
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(5)
  }
}

// 所有启动过的 loop 都在 after() 里收尸：契约 §4 要求**不 unref**（真实例进程靠
// interval 活着），代价就是测试必须自己 dispose，否则 `node --test` 永远不退出。
const loops: TickLoop[] = []

/**
 * 起一个 loop 并登记到收尸清单（断言中途失败也不会留下 interval）。
 * @param options - 与 `startTickLoop` 同参。
 */
async function start(options: TickLoopOptions): Promise<TickLoop> {
  const loop = await startTickLoop(options)
  loops.push(loop)
  return loop
}

after(async () => {
  for (const loop of loops) {
    try {
      await loop.dispose()
    } catch {
      // after() 只负责收尸；dispose 的"永不抛"由专门用例断言。
    }
  }
})

// ---------------------------------------------------------------------------
//  §1：锁生命周期 / tick 调度 / 异常 / dispose
// ---------------------------------------------------------------------------

describe('tick-loop: advisory lock + periodic ticks (fake pool, no database)', () => {
  test('takes the lock with a parameterized hashtext call, ticks immediately and then every intervalMs', async () => {
    const intervalMs = 120
    const fake = createFakePool(true)
    const { warnings, logger } = createLogger()
    const router = createRouter(async () => ({ idle: true }))
    const startedAt = Date.now()
    const loop = await start({ pool: fake.pool, router, intervalMs, logger })
    try {
      // 首 tick 必须是**立即**的：不能等一个 interval 才动（否则启动到首次派发凭空多一个周期）。
      const firstDelayMs = await waitFor(() => router.calls.length >= 1, 5_000, 'the immediate first tick')
      assert.ok(firstDelayMs < intervalMs, `first tick must not wait for the interval (waited ${firstDelayMs}ms, interval ${intervalMs}ms)`)

      // 后续 tick 由 interval 驱动：等第 3 次，再看相邻间隔也都是"约一个周期"而不是连珠炮。
      await waitFor(() => router.calls.length >= 3, intervalMs * 10, 'two more interval-driven ticks')
      const gapOne = router.calls[1]!.at - router.calls[0]!.at
      const gapTwo = router.calls[2]!.at - router.calls[1]!.at
      assert.ok(gapOne >= intervalMs * 0.8, `second tick must wait about intervalMs (gap ${gapOne}ms)`)
      assert.ok(gapTwo >= intervalMs * 0.8, `third tick must wait about intervalMs (gap ${gapTwo}ms)`)
      assert.ok(router.calls[2]!.at - startedAt >= intervalMs * 1.6, 'interval ticks must be spread over time, not burst together')

      // 抢锁 SQL：`pg_try_advisory_lock(hashtext($1))` + 参数；lock key **不**拼进 SQL 文本。
      const lockQuery = fake.clients[0]!.queries.find((record) => /pg_try_advisory_lock/.test(record.sql))
      assert.ok(lockQuery !== undefined, 'the loop must acquire an advisory lock before ticking')
      assert.match(lockQuery.sql, /pg_try_advisory_lock\(hashtext\(\$1\)\)/)
      assert.deepEqual(lockQuery.values, [TICK_LOCK_KEY])
      assert.equal(lockQuery.sql.includes(TICK_LOCK_KEY), false, 'lock key must be a query parameter, never spliced into SQL')
      assert.equal(fake.state.connectCalls, 1, 'the lock lifetime uses exactly one dedicated connection')

      // 等前 3 次 tick 全部完成再看 snapshot（契约 §1：ticks 计的是"完成"的 tick）。
      await waitFor(() => loop.snapshot().ticks >= 3, 5_000, 'three completed ticks')
      const snapshot = loop.snapshot()
      assert.equal(snapshot.started, true)
      assert.equal(snapshot.lockHeld, true)
      assert.equal(snapshot.reason, null)
      assert.equal(snapshot.lockKey, TICK_LOCK_KEY)
      assert.equal(snapshot.failures, 0)
      assert.equal(snapshot.skippedOverlaps, 0)
      assert.ok(snapshot.ticks >= 3)
      assert.ok(snapshot.lastTickStartedAt !== null && Number.isFinite(Date.parse(snapshot.lastTickStartedAt)))
      assert.ok(snapshot.lastTickFinishedAt !== null && Number.isFinite(Date.parse(snapshot.lastTickFinishedAt)))
      assert.equal(fake.clients[0]!.releaseCount, 0, 'the dedicated connection stays checked out while the loop runs')

      // snapshot 必须是"每次新的冻结副本"：调用方拿不到内部可变对象。
      const copy = loop.snapshot()
      assert.notEqual(copy, snapshot, 'each snapshot() must return a fresh copy')
      assert.equal(Object.isFrozen(snapshot), true)
      assert.equal(Object.isFrozen(copy), true)
      assert.deepEqual(warnings, [], 'a healthy first instance must not warn')
    } finally {
      await loop.dispose()
    }
  })

  test('a losing instance warns exactly once, never ticks, releases its connection once and never sends unlock', async () => {
    const fake = createFakePool(false)
    const { warnings, logger } = createLogger()
    const router = createRouter(async () => ({ idle: true }))
    const loop = await start({ pool: fake.pool, router, intervalMs: 50, logger })
    const snapshot = loop.snapshot()
    assert.equal(snapshot.started, false)
    assert.equal(snapshot.lockHeld, false)
    assert.equal(snapshot.ticks, 0)
    assert.equal(snapshot.reason, 'LOCK_NOT_ACQUIRED', 'a lost lock is a normal state, not a started loop')
    assert.equal(snapshot.lockKey, TICK_LOCK_KEY)

    assert.equal(warnings.length, 1, 'lock contention must be logged exactly once')
    assert.ok(warnings[0]!.includes(TICK_LOCK_KEY), 'the warn message must carry the lock key for operators')
    assert.ok(warnings[0]!.includes('另一个实例持有 tick 锁，本实例不派发'), 'the warn message must say this instance stands down')

    assert.equal(router.calls.length, 0, 'a losing instance must never call router.tick')
    assert.equal(fake.state.connectCalls, 1)
    assert.equal(fake.clients[0]!.releaseCount, 1, 'the checked-out connection must be released exactly once')
    assert.equal(fake.clients[0]!.queries.filter((record) => /pg_advisory_unlock/.test(record.sql)).length, 0,
      'never unlock a lock this instance does not hold')
    assert.equal(fake.clients[0]!.queries.length, 1, 'only the try-lock query is allowed on a losing instance')

    // dispose 是安全 no-op：不重复 release、不发 unlock、不抛。
    await loop.dispose()
    await loop.dispose()
    assert.equal(fake.clients[0]!.releaseCount, 1, 'dispose must not release a second time')
    assert.equal(fake.clients[0]!.queries.filter((record) => /pg_advisory_unlock/.test(record.sql)).length, 0,
      'dispose of a lock-less handle must not send unlock')
    assert.equal(router.calls.length, 0)
  })

  test('pool.connect rejection becomes reason=POOL_CONNECT_FAILED instead of throwing', async () => {
    const state = { connectCalls: 0 }
    const pool: TickLockPool = {
      async connect(): Promise<TickLockConnection> {
        state.connectCalls += 1
        throw new Error('ECONNREFUSED 127.0.0.1:5432')
      },
    }
    const { warnings, logger } = createLogger()
    const router = createRouter(async () => ({ idle: true }))
    const loop = await start({ pool, router, intervalMs: 50, logger })
    const snapshot = loop.snapshot()
    assert.equal(snapshot.started, false)
    assert.equal(snapshot.lockHeld, false)
    assert.equal(snapshot.ticks, 0)
    assert.equal(snapshot.reason, 'POOL_CONNECT_FAILED', 'a dead pool must be reported, not thrown')
    assert.equal(snapshot.lockKey, TICK_LOCK_KEY)
    assert.equal(state.connectCalls, 1)
    assert.equal(warnings.length, 1, 'connection failure must be logged exactly once')
    assert.equal(router.calls.length, 0, 'no tick without a connection')

    await loop.dispose() // 安全 no-op（没有连接可 release）
    assert.equal(state.connectCalls, 1)
    assert.equal(router.calls.length, 0)
  })

  test('a slow tick never runs concurrently with itself; overlapping schedules are skipped and counted', async () => {
    const intervalMs = 60
    const fake = createFakePool(true)
    const { logger } = createLogger()
    let concurrent = 0
    let maxConcurrent = 0
    const router = createRouter(async () => {
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        await sleep(intervalMs * 2.5) // 一次 tick 跨过 2 个周期
      } finally {
        concurrent -= 1
      }
      return { idle: true }
    })
    const loop = await start({ pool: fake.pool, router, intervalMs, logger })
    try {
      await waitFor(() => loop.snapshot().skippedOverlaps > 0, 5_000, 'an overlapping schedule to be skipped')
      assert.equal(maxConcurrent, 1, 'concurrent ticks must never exceed 1')

      await waitFor(() => loop.snapshot().ticks >= 1, 5_000, 'the slow tick to finish')
      const snapshot = loop.snapshot()
      assert.ok(snapshot.ticks >= 1)
      assert.equal(snapshot.failures, 0)
      assert.ok(snapshot.skippedOverlaps > 0, 'skippedOverlaps is the evidence that overlap protection actually fired')
      assert.equal(maxConcurrent, 1, 'still exactly one in-flight tick after the slow one finished')
    } finally {
      await loop.dispose()
    }
  })

  test('router.tick exceptions never become unhandled rejections and the loop keeps ticking', async () => {
    const intervalMs = 60
    const fake = createFakePool(true)
    const { warnings, logger } = createLogger()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    const router = createRouter(async () => { throw new Error('router-tick-boom') })
    const loop = await start({ pool: fake.pool, router, intervalMs, logger })
    try {
      await waitFor(() => loop.snapshot().failures >= 2, 5_000, 'two failed ticks')
      const firstCheck = loop.snapshot()
      assert.ok(firstCheck.failures >= 2)
      assert.ok(firstCheck.failures < 30, 'the warn-throttling assertion below assumes fewer than 30 failures')
      assert.equal(warnings.length, 1, 'failure warn must be throttled (first failure only, not every interval)')
      assert.ok(firstCheck.lastError !== null && firstCheck.lastError.includes('router-tick-boom'),
        `lastError must carry the thrown error, got ${JSON.stringify(firstCheck.lastError)}`)

      const ticksBefore = firstCheck.ticks
      await sleep(intervalMs * 2)
      const snapshot = loop.snapshot()
      assert.ok(snapshot.ticks > ticksBefore, 'the loop must keep ticking after a failed tick')
      assert.equal(snapshot.ticks, snapshot.failures, 'ticks counts both successes and failures, so all-failing ticks are equal')
      assert.deepEqual(unhandled, [], 'a failed tick must never surface as an unhandled rejection')

      await sleep(intervalMs) // 再让一轮微任务/异常处理跑完，确认没有迟到的 unhandledRejection
      assert.deepEqual(unhandled, [], 'no late unhandled rejection either')
    } finally {
      await loop.dispose()
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })

  test('dispose stops ticking, aborts the signal, unlocks on the same connection and releases exactly once (idempotent)', async () => {
    const intervalMs = 60
    const fake = createFakePool(true)
    const { logger } = createLogger()
    const router = createRouter(async () => ({ idle: true }))
    const loop = await start({ pool: fake.pool, router, intervalMs, logger })
    await waitFor(() => loop.snapshot().ticks >= 2, 5_000, 'two ticks before dispose')

    await loop.dispose()
    const disposed = loop.snapshot()
    assert.equal(disposed.started, false)
    assert.equal(disposed.lockHeld, false)
    assert.equal(disposed.reason, 'DISPOSED')
    const ticksAfterDispose = disposed.ticks
    const callsAfterDispose = router.calls.length

    // unlock 必须在**同一条**专用连接上、参数化发一次。
    const client = fake.clients[0]!
    assert.equal(fake.state.connectCalls, 1, 'the loop must keep using the one connection it locked on')
    const unlockQueries = client.queries.filter((record) => /pg_advisory_unlock/.test(record.sql))
    assert.equal(unlockQueries.length, 1, 'dispose must send exactly one unlock')
    assert.match(unlockQueries[0]!.sql, /pg_advisory_unlock\(hashtext\(\$1\)\)/)
    assert.deepEqual(unlockQueries[0]!.values, [TICK_LOCK_KEY])
    assert.equal(unlockQueries[0]!.clientId, client.queries[0]!.clientId, 'unlock must be issued on the same connection that locked')
    assert.equal(client.releaseCount, 1, 'client.release must happen exactly once on dispose')

    // 取消信号：dispose 必须 abort 启动时创建的那个 controller（在途 tick 才能立刻感知）。
    assert.ok(router.calls.length > 0)
    assert.ok(router.calls.every((call) => call.signal === router.calls[0]!.signal),
      'every tick must receive the AbortController signal created at start')
    assert.equal(router.calls[0]!.signal.aborted, true, 'dispose must abort the loop signal')

    // clearInterval：等 3×interval，不再有新的 tick（snapshot 与 router 调用数都冻住）。
    await sleep(intervalMs * 3)
    assert.equal(loop.snapshot().ticks, ticksAfterDispose, 'a disposed loop must not tick again')
    assert.equal(router.calls.length, callsAfterDispose, 'a disposed loop must not call router.tick again')

    // 重复 dispose 幂等：不重复 unlock / release，不抛。
    await loop.dispose()
    assert.equal(client.queries.filter((record) => /pg_advisory_unlock/.test(record.sql)).length, 1)
    assert.equal(client.releaseCount, 1)
    assert.equal(loop.snapshot().reason, 'DISPOSED')
  })
})

// ---------------------------------------------------------------------------
//  §2：config 新增的 auto_tick / tick_interval_ms（既有行为一个字都不许改）
// ---------------------------------------------------------------------------

/** 一份既有必填键都齐全的 runtime 配置（与 worker-protocol.test.ts 同一形状）。 */
const VALID_RUNTIME = {
  enabled: true,
  worker_profile: 'rec-worker-probe',
  dsh_bin: 'D:/runtime/dsh/lib/bin.js',
  runtime_version: '0.2.2-rc.3',
  model_route: 'scripted/test-double',
} as const

describe('runtime config: auto tick knobs', () => {
  test('exports the frozen interval constants', () => {
    assert.equal(DEFAULT_TICK_INTERVAL_MS, 2000)
    assert.equal(TICK_INTERVAL_MIN_MS, 100)
    assert.equal(TICK_INTERVAL_MAX_MS, 600_000)
  })

  test('auto tick defaults to true with a 2000ms interval', () => {
    const { resolved, issues } = resolveRuntimeConfig({ ...VALID_RUNTIME }, {})
    assert.deepEqual(issues, [])
    assert.ok(resolved !== null)
    assert.equal(resolved.autoTick, true)
    assert.equal(resolved.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS)
  })

  test('explicit auto_tick / tick_interval_ms win over the defaults and existing fields stay unchanged', () => {
    const off = resolveRuntimeConfig({ ...VALID_RUNTIME, auto_tick: false }, {})
    assert.deepEqual(off.issues, [])
    assert.ok(off.resolved !== null)
    assert.equal(off.resolved.autoTick, false, 'explicit auto_tick:false must disable the loop')
    assert.equal(off.resolved.tickIntervalMs, DEFAULT_TICK_INTERVAL_MS)

    const custom = resolveRuntimeConfig({ ...VALID_RUNTIME, auto_tick: true, tick_interval_ms: 250 }, {})
    assert.deepEqual(custom.issues, [])
    assert.ok(custom.resolved !== null)
    assert.equal(custom.resolved.autoTick, true)
    assert.equal(custom.resolved.tickIntervalMs, 250, 'explicit tick_interval_ms must be used')
    // 既有字段的解析结果不变（默认值不是本 lane 改的）。
    assert.equal(custom.resolved.leaseMs, 900_000)
    assert.equal(custom.resolved.maxAttempts, 3)
    assert.equal(custom.resolved.resumeSessions, false)
    assert.equal(custom.resolved.pendingBatchSize, 20)
    assert.equal(custom.resolved.maxRouteAttempts, 5)
  })

  test('non-boolean auto_tick fails closed with the exact issue text', () => {
    const { resolved, issues } = resolveRuntimeConfig({ ...VALID_RUNTIME, auto_tick: 'yes' } as unknown as RuntimeConfig, {})
    assert.equal(resolved, null, 'a bad auto_tick must fail closed (no routes registered)')
    assert.deepEqual(issues, ['config.runtime.auto_tick must be a boolean'])
  })

  test('tick_interval_ms outside [100, 600000] or non-integer fails closed with the exact issue text', () => {
    for (const value of [0, 99, 600_001, 1.5]) {
      const { resolved, issues } = resolveRuntimeConfig({ ...VALID_RUNTIME, tick_interval_ms: value }, {})
      assert.equal(resolved, null, `tick_interval_ms ${value} must be rejected`)
      assert.deepEqual(issues, [`config.runtime.tick_interval_ms must be an integer between 100 and 600000 (got ${value})`])
    }
  })

  test('interval boundaries 100 and 600000 are legal', () => {
    for (const value of [100, 600_000]) {
      const { resolved, issues } = resolveRuntimeConfig({ ...VALID_RUNTIME, tick_interval_ms: value }, {})
      assert.deepEqual(issues, [], `tick_interval_ms ${value} must be accepted`)
      assert.ok(resolved !== null)
      assert.equal(resolved.tickIntervalMs, value)
    }
  })

  test('existing enabled:false short-circuit is unchanged (new keys are not even looked at)', () => {
    const { resolved, issues } = resolveRuntimeConfig(
      { enabled: false, auto_tick: 'yes', tick_interval_ms: 1 } as unknown as RuntimeConfig,
      {},
    )
    assert.equal(resolved, null)
    assert.deepEqual(issues, ['runtime.enabled is false (runtime routes are not registered)'])
  })

  test('existing required-key issues are unchanged when the new keys are present', () => {
    const { resolved, issues } = resolveRuntimeConfig({ enabled: true, auto_tick: false, tick_interval_ms: 500 }, {})
    assert.equal(resolved, null)
    assert.ok(issues.some((issue) => issue.includes('worker_profile')))
    assert.ok(issues.some((issue) => issue.includes('runtime_version')))
    assert.ok(issues.some((issue) => issue.includes('model_route')))
    assert.ok(issues.some((issue) => issue.includes('dsh_bin') && issue.includes('DSH_INSTALL_DIR')))
    assert.equal(issues.some((issue) => issue.includes('auto_tick') || issue.includes('tick_interval_ms')), false,
      'valid new keys must not add issues of their own')
  })
})
