// Router 验收：tick 的幂等、恢复重放、以及"事件 → Task → Attempt → Worker"全链。
//
// 重点证明两件事：
//   1. `tick()` 可以被重复调用而不会重复派发（幂等在库里：Task 状态 + Attempt
//      唯一租约 + FOR UPDATE SKIP LOCKED，不是进程内标志位）；
//   2. 事件先落库、路由崩溃后，下一次 tick 会把 RECEIVED 事件补路由并派发
//      （进程重启恢复路径）。
//
// Worker 仍是 scripted 替身；真实 DSH Worker 证据见 src/runtime/evidence/。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { Router } from '../../src/runtime/router.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from './scripted-worker.ts'

let db: RuntimeTestDatabase
let store: RuntimeStore
let events: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('router')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  events = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/**
 * 一条**真实发射的**确定性事件（`scorecard.submit`，INTERNAL）。
 *
 * 事件名从注册表取：这里曾经手写 `resume_received`（没有发射方的假名字），
 * 导致"路由成功"只在测试里成立。
 */
function scorecardEvent(interviewId: string, providerEventId: string): InboundEvent {
  return {
    tenantId: RUNTIME_TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  }
}

function buildRouter(launcher: ScriptedWorkerLauncher, options: Partial<{ leaseMs: number; maxAttempts: number }> = {}): Router {
  const tasks = new TaskRuntime({
    store,
    launcher,
    workerType: 'SCRIPTED_WORKER',
    workerId: 'router-test',
    leaseMs: options.leaseMs ?? 60_000,
    maxAttempts: options.maxAttempts ?? 3,
    workspaceRoot: `${process.cwd()}/.runtime-test-work`,
  })
  return new Router({ store, events, tasks })
}

async function count(sql: string): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(sql)
  return Number(rows[0]?.n ?? '0')
}

describe('router: event → task → attempt → worker', () => {
  test('duplicate event + repeated ticks do not duplicate tasks, wakeups, or attempts', async () => {
    const interviewId = randomUUID()
    const launcher = new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'handled once', runtimeSessionId: 'session-router-1' }),
    ])
    const router = buildRouter(launcher)
    const requestedEvent = scorecardEvent(interviewId, `evt-${randomUUID()}`)

    const first = await router.submit(requestedEvent)
    const duplicate = await router.submit(requestedEvent)
    assert.equal(first.dispatchState, 'ROUTED')
    assert.equal(duplicate.outcome, 'duplicate')
    assert.equal(duplicate.taskId, first.taskId)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), 1)
    assert.equal(await count('select count(*)::text as n from recruitment.task_wakeup'), 1)

    const tickOne = await router.tick(new AbortController().signal)
    assert.ok(tickOne.dispatched !== null)
    assert.equal(tickOne.dispatched.outcome, 'succeeded')
    assert.equal(tickOne.dispatched.taskStatus, 'SUCCEEDED')
    assert.equal(tickOne.dispatched.runtimeSessionId, 'session-router-1')

    const tickTwo = await router.tick(new AbortController().signal)
    assert.equal(tickTwo.dispatched, null)
    assert.match(tickTwo.idleReason ?? '', /NO_CLAIMABLE_TASK/)
    assert.equal(await count('select count(*)::text as n from recruitment.task_attempt'), 1)
    assert.equal(await count('select count(*)::text as n from recruitment.agent_session'), 1)
    const receiptCounts = await router.counts()
    assert.equal(receiptCounts.tasks, 1)
    assert.equal(receiptCounts.attempts, 1)
    assert.equal(receiptCounts.sessions, 1)
  })

  test('a stored-but-unrouted event is recovered by the next tick (crash after Event Inbox insert)', async () => {
    const interviewId = randomUUID()
    const event = scorecardEvent(interviewId, `evt-${randomUUID()}`)
    // 模拟"事件已落库、进程在路由前崩溃"：只 insertEvent，不 route。
    const inserted = await store.insertEvent(event, {
      key: `feishu:${event.providerEventId}`,
      source: 'PROVIDER_EVENT_ID',
    })
    assert.equal(inserted.inserted, true)
    assert.equal(await count(`select count(*)::text as n from recruitment.event_inbox where provider_event_id = '${event.providerEventId}' and dispatch_state = 'RECEIVED'`), 1)

    const router = buildRouter(new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'recovered event handled', runtimeSessionId: 'session-router-2' }),
    ]))
    const tick = await router.tick(new AbortController().signal)
    assert.equal(tick.routedEvents.length, 1)
    assert.equal(tick.routedEvents[0]!.dispatchState, 'ROUTED')
    assert.ok(tick.dispatched !== null)
    assert.equal(tick.dispatched.taskStatus, 'SUCCEEDED')
    assert.equal(await count(`select count(*)::text as n from recruitment.event_inbox where provider_event_id = '${event.providerEventId}' and dispatch_state = 'RECEIVED'`), 0)
  })

  test('failed attempt is retried on the same task by a later tick', async () => {
    const interviewId = randomUUID()
    const launcher = new ScriptedWorkerLauncher([
      scriptedOutcome('failed', {
        summary: 'worker failed transiently',
        errorCode: 'TRANSIENT_REMOTE_FAILURE',
        errorClass: 'TRANSIENT',
        retryable: true,
        retryAfter: new Date(Date.now() - 1000).toISOString(),
        runtimeSessionId: 'session-fail-1',
      }),
      scriptedOutcome('succeeded', { summary: 'retry succeeded', runtimeSessionId: 'session-retry-2' }),
    ])
    const router = buildRouter(launcher)
    const submitted = await router.submit(scorecardEvent(interviewId, `evt-${randomUUID()}`))
    assert.ok(submitted.taskId !== null)

    const tickOne = await router.tick(new AbortController().signal)
    assert.ok(tickOne.dispatched !== null)
    assert.equal(tickOne.dispatched.attemptNo, 1)
    assert.equal(tickOne.dispatched.taskStatus, 'RETRY_WAIT')

    const tickTwo = await router.tick(new AbortController().signal)
    assert.ok(tickTwo.dispatched !== null)
    assert.equal(tickTwo.dispatched.taskId, submitted.taskId, 'task identity is stable across attempts')
    assert.equal(tickTwo.dispatched.attemptNo, 2)
    assert.equal(tickTwo.dispatched.taskStatus, 'SUCCEEDED')

    const view = await store.readTask(submitted.taskId)
    assert.deepEqual(view!.attempts.map((a) => a.status), ['FAILED_RETRYABLE', 'SUCCEEDED'])
    assert.deepEqual(view!.sessions.map((s) => s.status), ['ENDED', 'ENDED'])
  })
})
