// tick-loop 集成验收：**真 PG 一次性空库** + 真 RuntimeStore / EventRuntime / TaskRuntime / Router。
//
// 唯一的执行替身是 SCRIPTED WorkerLauncher（`test/runtime/scripted-worker.ts`）：
// 它**不是**真实 DSH Worker 的证据，只用来让 TaskRuntime 完成"认领 → 执行 → 收尾"
// 这条编排；本文件证明的是"事件自动驱动 → 任务落库 → 实例互斥 / 重启恢复"，不是
// "DSH 真的在独立 Session 里干活"（那需要 `src/runtime/evidence/` 的真 headless 进程）。
//
// 为什么必须连真库：本轮的验收点全是**跨连接、跨实例、跨进程生命周期**的事实：
//   * advisory lock 的互斥来自 PG 会话，进程内标志位证明不了；
//   * 事件 RECEIVED → ROUTED 必须真提交，ROLLBACK 掉就只剩"单事务内看起来对"；
//   * dispose 后锁能被新实例立刻接走（= 进程被 kill 的等价物）；
//   * 没有 ticker 时事件**不动**——否则"自动驱动"无从证明。
//
// 数据库纪律：`createIsolatedTestDatabase('v1_g1_tickloop')` → 独占 `ra_v1_g1_*` 空库，
// 绝不写共享 `ra_s6s7`（库里 `event_inbox` / `business_task` 有 no-delete 触发器）。
// 跑完在 after() 里 dispose 所有 loop → pool.end() → drop()，`node --test` 才能退出。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { Router } from '../../src/runtime/router.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import { TICK_LOCK_KEY, startTickLoop } from '../../src/runtime/tick-loop.ts'
import type { TickLockPool, TickLoop, TickLoopOptions } from '../../src/runtime/tick-loop.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  HR_ACTOR,
  TENANT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  createTestPool,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from '../runtime/scripted-worker.ts'

/** 自动 tick 周期：任务书要求 200–250ms（慢到能观察，快到 10s 预算内必达）。 */
const INTERVAL_MS = 220
/** RECEIVED→ROUTED 的硬预算（任务书要求 ≤10s；实测真实经过毫秒数会打进输出）。 */
const ROUTED_DEADLINE_MS = 10_000
/** 轮询步长。 */
const POLL_MS = 25

let database: IsolatedTestDatabase
let observerPool: ReturnType<typeof createTestPool>
let store: RuntimeStore
let events: EventRuntime
let tasks: TaskRuntime
let runtimeRouter: Router

// 所有启动过的 loop 都在 after() 里收尸（dispose 幂等，重复调用安全）。
const loops: TickLoop[] = []

/** 打日志的 logger：让"另一个实例让路 / tick 失败"的 warn 留在原始输出里。 */
const evidenceLogger = {
  warn(message: string): void {
    console.log(`[B][tick-loop][warn] ${message}`)
  },
}

/** 睡 `ms` 毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** `pg.Pool` 在结构上满足 `TickLockPool`；转换只为让调用点自解释。 */
function asTickLockPool(pool: unknown): TickLockPool {
  return pool as TickLockPool
}

before(async () => {
  database = await createIsolatedTestDatabase('v1_g1_tickloop')
  console.log(`[B][db] isolated database=${database.name} migrations=${database.migrations.length}`)
  assert.match(database.name, /^ra_v1_g1_/, 'integration tests must own their own ra_v1_g1_* database')
  assertPrivateDatabase(database.name)

  // 独立的"观察者连接池"：所有 SQL 读回都走这里（raw SQL，不经过产品 store 读路径）。
  observerPool = createTestPool({ ...testDatabaseConfig(), database: database.name, max: 2 })

  store = new RuntimeStore({ pool: database.pool, tenantId: TENANT, actorId: HR_ACTOR })
  events = new EventRuntime({ store })
  // SCRIPTED 替身：明确标注，不得被当成真实 DSH Worker 证据。
  //
  // 每次执行必须给**不同的** runtime_session_id：`uq_agent_session_runtime`
  // (tenant_id, runtime_kind, runtime_session_id) 是库层唯一约束（一个 DSH Session
  // 只能对应一行 Agent Session），复用同一个假 session id 会让第二次派发撞唯一键。
  // 预置足够多次（本文件最多 ~10 次派发；用完后 launcher 复用最后一个结果）。
  const scriptedOutcomes = Array.from({ length: 40 }, (_, index) => scriptedOutcome('succeeded', {
    summary: `SCRIPTED worker: G1 tick-loop integration task handled (#${index + 1})`,
    runtimeSessionId: `session-g1-tickloop-scripted-${index + 1}`,
  }))
  tasks = new TaskRuntime({
    store,
    launcher: new ScriptedWorkerLauncher(scriptedOutcomes),
    workerType: 'SCRIPTED_WORKER',
    workerId: `g1-tickloop:${process.pid}`,
    leaseMs: 60_000,
    maxAttempts: 3,
    workspaceRoot: `${process.cwd()}/.runtime-test-work`,
  })
  runtimeRouter = new Router({ store, events, tasks })
})

after(async () => {
  for (const loop of loops) {
    try {
      await loop.dispose()
    } catch {
      // after() 只负责收尸；dispose 的"永不抛"由单测断言。
    }
  }
  if (observerPool !== undefined) await observerPool.end().catch(() => {})
  if (database !== undefined) {
    const name = database.name
    await database.drop()
    console.log(`[B][db] dropped database=${name} (with force)`)
  }
})

// ---------------------------------------------------------------------------
//  事件 / 读回 / 轮询工具
// ---------------------------------------------------------------------------

/** 一条**真实注册**的确定性事件（`scorecard.submit`，INTERNAL），会建 EVALUATION_SYNTHESIZE 任务。 */
function scorecardEvent(interviewId: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'internal',
    providerEventId: `g1-tickloop-${randomUUID()}`,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  }
}

/** 用产品的 store 落一条事件（等价于"HTTP 收到事件、还没人 tick"的真实中间态）。 */
async function insertReceivedEvent(): Promise<string> {
  const event = scorecardEvent(randomUUID())
  const inserted = await store.insertEvent(event, {
    key: `g1:${event.providerEventId}`,
    source: 'PROVIDER_EVENT_ID',
  })
  assert.equal(inserted.inserted, true, 'the test event must be a fresh event_inbox row')
  return inserted.eventId
}

/** raw SQL 读回 dispatch_state（独立连接，不 import 产品读路径）。 */
async function dispatchStateOf(eventId: string): Promise<string | null> {
  const { rows } = await observerPool.query<{ dispatch_state: string }>(
    'select dispatch_state from recruitment.event_inbox where event_id = $1::uuid',
    [eventId],
  )
  return rows[0]?.dispatch_state ?? null
}

/** 该事件**触发建出来的**任务行数（business_task.trigger_event_id）。 */
async function countTriggeredTasks(eventId: string): Promise<number> {
  const { rows } = await observerPool.query<{ n: string }>(
    'select count(*)::text as n from recruitment.business_task where trigger_event_id = $1::uuid',
    [eventId],
  )
  return Number(rows[0]?.n ?? '0')
}

/** 该事件对应的唤醒事实行数（task_wakeup.event_id；唯一约束 = 同一事件只唤醒一次）。 */
async function countWakeups(eventId: string): Promise<number> {
  const { rows } = await observerPool.query<{ n: string }>(
    'select count(*)::text as n from recruitment.task_wakeup where event_id = $1::uuid',
    [eventId],
  )
  return Number(rows[0]?.n ?? '0')
}

/**
 * 轮询直到 `accept(read())` 为真。
 * @returns 最后一次读到的值 + 从调用到为真的真实毫秒数（用于断言截止时间并打进证据输出）。
 */
async function waitFor<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs: number,
  what: string,
): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = Date.now()
  for (;;) {
    const value = await read()
    if (accept(value)) return { value, elapsedMs: Date.now() - startedAt }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out after ${Date.now() - startedAt}ms waiting for ${what}`)
    }
    await sleep(POLL_MS)
  }
}

/** 起一个真 pool 的 tick-loop 并登记到收尸清单。 */
async function launch(options: TickLoopOptions): Promise<TickLoop> {
  const loop = await startTickLoop(options)
  loops.push(loop)
  return loop
}

/** 计数假 router：只用来证明"没拿到锁的实例一次都没 tick"（不碰库）。 */
function createCountingRouter(): {
  readonly calls: number
  readonly router: { tick(signal: AbortSignal): Promise<unknown> }
} {
  let calls = 0
  return {
    get calls(): number {
      return calls
    },
    router: {
      async tick(): Promise<unknown> {
        calls += 1
        return { idle: 'counting-router' }
      },
    },
  }
}

// ---------------------------------------------------------------------------
//  五个真库场景
// ---------------------------------------------------------------------------

describe('tick-loop: real database, real Router (SCRIPTED worker launcher)', () => {
  test('1) a stored RECEIVED event is auto-routed and creates exactly one business task', async () => {
    const eventId = await insertReceivedEvent()
    assert.equal(await dispatchStateOf(eventId), 'RECEIVED', 'the event must be stored but unrouted before any ticker exists')
    console.log(`[B][auto-drive] event=${eventId} dispatch_state=RECEIVED (raw SQL via observer pool, before startTickLoop)`)
    assert.equal(await countTriggeredTasks(eventId), 0, 'no business task exists before the loop starts')

    const startedAt = Date.now()
    const loop = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    try {
      const routed = await waitFor(
        () => dispatchStateOf(eventId),
        (state) => state === 'ROUTED',
        ROUTED_DEADLINE_MS,
        'event_inbox.dispatch_state = ROUTED',
      )
      const elapsedMs = Date.now() - startedAt
      console.log(`[B][auto-drive] RECEIVED->ROUTED elapsed_ms=${elapsedMs} (poll observed it after ${routed.elapsedMs}ms)`)
      assert.ok(elapsedMs < ROUTED_DEADLINE_MS, `routing took ${elapsedMs}ms, budget ${ROUTED_DEADLINE_MS}ms`)

      const taskCount = await waitFor(
        () => countTriggeredTasks(eventId),
        (n) => n >= 1,
        5_000,
        'a business_task triggered by the routed event',
      )
      assert.equal(taskCount.value, 1, 'exactly one business task per input event')
      assert.equal(await countWakeups(eventId), 1, 'exactly one wakeup row per input event')

      // ROUTED 只说明"事件已路由"；本轮 tick 还要继续认领/派发这条任务，所以
      // "首 tick 完成"必须单独等（ticks 计的是**完成**的 tick，不是开始）。
      const completed = await waitFor(
        () => Promise.resolve(loop.snapshot().ticks),
        (ticks) => ticks >= 1,
        5_000,
        'the immediate first tick to complete',
      )
      assert.ok(completed.value >= 1)

      const snapshot = loop.snapshot()
      assert.equal(snapshot.started, true)
      assert.equal(snapshot.lockHeld, true)
      assert.equal(snapshot.reason, null)
      assert.equal(snapshot.lockKey, TICK_LOCK_KEY)
      assert.equal(snapshot.failures, 0, 'the healthy path must not record failures')
      console.log(`[B][auto-drive] snapshot ticks=${snapshot.ticks} failures=${snapshot.failures} lockHeld=${snapshot.lockHeld}`)
    } finally {
      await loop.dispose()
    }
  })

  test('2) a second instance on the same database loses the lock and never ticks, while the first one keeps routing', async () => {
    const loopA = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    const secondPool = createTestPool({ ...testDatabaseConfig(), database: database.name, max: 2 })
    try {
      await waitFor(
        () => Promise.resolve(loopA.snapshot().lockHeld && loopA.snapshot().ticks >= 1),
        (ready) => ready,
        10_000,
        'instance A to hold the lock and complete a tick',
      )
      assert.equal(loopA.snapshot().lockHeld, true)

      const counting = createCountingRouter()
      const loopB = await launch({
        pool: asTickLockPool(secondPool),
        router: counting.router,
        intervalMs: INTERVAL_MS,
        logger: evidenceLogger,
      })
      try {
        const snapshotB = loopB.snapshot()
        assert.equal(snapshotB.lockHeld, false, 'the second instance must not report holding the lock')
        assert.equal(snapshotB.started, false, 'the second instance must not start ticking')
        assert.equal(snapshotB.ticks, 0, 'the second instance must not tick at all')
        assert.equal(snapshotB.reason, 'LOCK_NOT_ACQUIRED')
        assert.equal(counting.calls, 0, 'the losing instance must never call router.tick')
        console.log(`[B][two-instances] instance B lockHeld=${snapshotB.lockHeld} ticks=${snapshotB.ticks} router_calls=${counting.calls}`)

        // 期间再落一条事件：必须由 A 路由（不是 B），且任务恰好一行。
        const eventId = await insertReceivedEvent()
        const routed = await waitFor(
          () => dispatchStateOf(eventId),
          (state) => state === 'ROUTED',
          ROUTED_DEADLINE_MS,
          'instance A to route the new event while B is running',
        )
        console.log(`[B][two-instances] new event RECEIVED->ROUTED elapsed_ms=${routed.elapsedMs} (routed by instance A)`)
        assert.ok(routed.elapsedMs < ROUTED_DEADLINE_MS)
        assert.equal(await countTriggeredTasks(eventId), 1, 'the routed event must produce exactly one business task')
        assert.equal(await countWakeups(eventId), 1)

        // B 全程没有动作（再读一次，排除"迟到才抢到锁"）。
        assert.equal(loopB.snapshot().lockHeld, false)
        assert.equal(loopB.snapshot().ticks, 0)
        assert.equal(counting.calls, 0)
      } finally {
        await loopB.dispose()
      }
    } finally {
      await secondPool.end()
      await loopA.dispose()
    }
  })

  test('3) kill/restart: a new event stays RECEIVED with no ticker, then the restarted loop routes it without duplicating tasks', async () => {
    // 先让 A 路由一条"旧事件"，作为"重启后不得重复建任务"的基线。
    const oldEventId = await insertReceivedEvent()
    const killed = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    try {
      const routedOld = await waitFor(
        () => dispatchStateOf(oldEventId),
        (state) => state === 'ROUTED',
        ROUTED_DEADLINE_MS,
        'the pre-kill event to be routed',
      )
      console.log(`[B][kill-restart] old event RECEIVED->ROUTED elapsed_ms=${routedOld.elapsedMs}`)
      assert.ok(routedOld.elapsedMs < ROUTED_DEADLINE_MS, `pre-kill routing took ${routedOld.elapsedMs}ms, budget ${ROUTED_DEADLINE_MS}ms`)
      assert.equal(await countTriggeredTasks(oldEventId), 1)
      assert.equal(await countWakeups(oldEventId), 1)
    } finally {
      await killed.dispose() // = 进程被 kill：锁随会话释放
    }

    // 没有 ticker 时落的新事件必须**不动**（否则无法证明 ticker 是驱动来源）。
    const newEventId = await insertReceivedEvent()
    const inertWaitStartedAt = Date.now()
    await sleep(INTERVAL_MS * 3)
    const inertWaitMs = Date.now() - inertWaitStartedAt
    assert.equal(await dispatchStateOf(newEventId), 'RECEIVED', 'without a running ticker a stored event must stay RECEIVED')
    console.log(`[B][kill-restart] no ticker: waited ${inertWaitMs}ms (3x interval), new event still RECEIVED`)

    // 启动新实例 A2：必须 10s 内补路由，且旧事件不重复建任务。
    const restartedAt = Date.now()
    const restarted = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    try {
      const routedNew = await waitFor(
        () => dispatchStateOf(newEventId),
        (state) => state === 'ROUTED',
        ROUTED_DEADLINE_MS,
        'the restarted loop to recover the pending event',
      )
      const elapsedMs = Date.now() - restartedAt
      console.log(`[B][kill-restart] restarted instance RECEIVED->ROUTED elapsed_ms=${elapsedMs}`)
      assert.ok(elapsedMs < ROUTED_DEADLINE_MS, `restart recovery took ${elapsedMs}ms, budget ${ROUTED_DEADLINE_MS}ms`)
      assert.equal(await countTriggeredTasks(newEventId), 1, 'the recovered event must create exactly one task')
      assert.equal(await countWakeups(newEventId), 1, 'the recovered event must wake the task exactly once')
      assert.equal(await countTriggeredTasks(oldEventId), 1, 'restart must not duplicate the old event task')
      assert.equal(await countWakeups(oldEventId), 1, 'restart must not duplicate the old wakeup')
      console.log('[B][kill-restart] old_event tasks=1 wakeups=1; new_event tasks=1 wakeups=1 (no duplicates)')
    } finally {
      await restarted.dispose()
    }
  })

  test('4) dispose releases the advisory lock so a replacement instance acquires it immediately, and a disposed loop stops ticking', async () => {
    const loop = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    await waitFor(
      () => Promise.resolve(loop.snapshot().ticks >= 2),
      (ready) => ready,
      10_000,
      'two ticks before dispose',
    )
    await loop.dispose()
    const disposedSnapshot = loop.snapshot()
    assert.equal(disposedSnapshot.reason, 'DISPOSED')
    assert.equal(disposedSnapshot.lockHeld, false)
    const ticksAfterDispose = disposedSnapshot.ticks

    const replacement = await launch({
      pool: asTickLockPool(database.pool),
      router: runtimeRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    try {
      // 锁是被**显式**释放的：新实例在 startTickLoop 返回时就已持锁（不用等连接超时）。
      assert.equal(replacement.snapshot().started, true, 'a replacement must acquire the released lock immediately')
      assert.equal(replacement.snapshot().lockHeld, true)
      console.log(`[B][lock-release] replacement lockHeld=${replacement.snapshot().lockHeld} (acquired synchronously after dispose)`)

      await sleep(INTERVAL_MS * 3)
      assert.equal(loop.snapshot().ticks, ticksAfterDispose, 'a disposed loop must not tick any more')
      console.log(`[B][lock-release] disposed loop ticks frozen at ${ticksAfterDispose} after ${INTERVAL_MS * 3}ms`)
    } finally {
      await replacement.dispose()
    }
  })

  test('5) a throwing router does not break the loop and never surfaces an unhandled rejection', async () => {
    let calls = 0
    const throwingRouter = {
      async tick(): Promise<unknown> {
        calls += 1
        throw new Error('G1_INTEGRATION_TICK_BOOM')
      },
    }
    let unhandledFired = false
    const onUnhandled = (): void => { unhandledFired = true }
    process.once('unhandledRejection', onUnhandled)
    const loop = await launch({
      pool: asTickLockPool(database.pool),
      router: throwingRouter,
      intervalMs: INTERVAL_MS,
      logger: evidenceLogger,
    })
    try {
      await waitFor(
        () => Promise.resolve(loop.snapshot().failures >= 2),
        (ready) => ready,
        10_000,
        'two failed ticks',
      )
      const before = loop.snapshot().ticks
      await sleep(INTERVAL_MS * 2)
      const snapshot = loop.snapshot()
      console.log(`[B][errors] ticks=${snapshot.ticks} failures=${snapshot.failures} calls=${calls} lastError=${snapshot.lastError}`)
      assert.ok(snapshot.ticks > before, 'the loop must keep ticking after router.tick throws')
      assert.ok(snapshot.failures > 0, 'failures must be counted')
      assert.ok(snapshot.lastError !== null && snapshot.lastError.includes('G1_INTEGRATION_TICK_BOOM'),
        `lastError must carry the thrown error, got ${JSON.stringify(snapshot.lastError)}`)
      assert.equal(unhandledFired, false, 'a thrown tick must never become an unhandled rejection')
      assert.ok(calls >= 3, 'the loop must keep calling router.tick')
    } finally {
      await loop.dispose()
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })
})
