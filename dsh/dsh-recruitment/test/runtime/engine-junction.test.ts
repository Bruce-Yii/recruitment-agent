// D-154 退役守则：engine 层（Effects/Outbox/写半边）已于 2026-11-18 退役。
//
// 本文件原先验收"runtime 异步事务写 engine_effect/engine_outbox → 插件侧 Effects/Outbox
// 派发 → 回执 pending→sent"的交界。交界已不存在，因此真值反过来了：
// **退役之后，任何产品路径都不该再往 engine_* 表写入**。本文件现在逐路径证明这一点，
// 同时保留与 engine 无关的业务断言（认领/唤醒/收尾）。
//
// ⚠️ 重新接线时本测试**必须一起改**：若有人再从 src/index.ts 或 runtime 入口装配 engine，
// 这里的"行数恒为 0"断言会正确地变红 —— 这正是它作为回归守卫的目的。
// 启用前须先在 docs/17 立裁决并复核 advisory-lock 不变量（见 src/engine/VENDORED.md 顶部）。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { InboundEvent, NotificationTarget } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from './scripted-worker.ts'

const NOTIFICATION: NotificationTarget = {
  source: 'probe',
  thread: 'thread-junction',
  address: { where: 'chat-1' },
  kind: 'notice',
}

interface Harness {
  readonly db: RuntimeTestDatabase
  readonly runtimeStore: RuntimeStore
  readonly events: EventRuntime
}

async function withHarness(notification: NotificationTarget | undefined, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const db = await createRuntimeTestDatabase('junction')
  const runtimeStore = new RuntimeStore({
    pool: db.pool,
    tenantId: RUNTIME_TENANT,
    actorId: RUNTIME_ACTOR,
    notification,
  })
  const events = new EventRuntime({ store: runtimeStore })
  try {
    await fn({ db, runtimeStore, events })
  } finally {
    await db.drop()
  }
}

/** 退役守则的统一读回：两张 engine 表必须保持零行。 */
async function assertEngineTablesEmpty(
  db: RuntimeTestDatabase,
  context: string,
): Promise<void> {
  const effect = await db.pool.query<{ n: string }>(
    'select count(*)::text as n from recruitment.engine_effect',
  )
  const outbox = await db.pool.query<{ n: string }>(
    'select count(*)::text as n from recruitment.engine_outbox',
  )
  assert.equal(Number(effect.rows[0]!.n), 0, `${context}: engine_effect 必须保持 0 行（D-154：无写入方）`)
  assert.equal(Number(outbox.rows[0]!.n), 0, `${context}: engine_outbox 必须保持 0 行（D-154：无写入方）`)
}

let eventCounter = 0
function scorecardEvent(interviewId: string): InboundEvent {
  eventCounter += 1
  return {
    tenantId: RUNTIME_TENANT,
    provider: 'internal',
    providerEventId: `junction-evt-${eventCounter}-${randomUUID()}`,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  }
}

describe('D-154 退役守则：产品路径不得向 engine_* 写入', () => {
  test('认领任务 + WAITING_EXTERNAL 收尾后 engine_effect / engine_outbox 仍为 0 行', async () => {
    await withHarness(NOTIFICATION, async (harness) => {
      const interviewId = randomUUID()
      const received = await harness.events.receive(scorecardEvent(interviewId))
      const taskId = received.taskId
      assert.ok(taskId !== null)

      const tasks = new TaskRuntime({
        store: harness.runtimeStore,
        launcher: new ScriptedWorkerLauncher([
          scriptedOutcome('waiting', {
            summary: 'candidate reply needed',
            runtimeSessionId: 'scripted-junction-session-1',
          }),
        ]),
        workerType: 'SCRIPTED_WORKER',
        workerId: 'junction-router',
        leaseMs: 60_000,
        maxAttempts: 2,
      })
      const dispatched = await tasks.dispatchTask(taskId, new AbortController().signal)

      // 非 engine 断言（保留）：WAITING_EXTERNAL 的收尾仍然产生通知标记。
      assert.ok(dispatched !== null)
      assert.ok(dispatched.notification !== null, 'WAITING_EXTERNAL must still produce a notification marker')
      assert.equal(dispatched.notification.status, 'NOT_CONFIGURED', 'engine 退役后不得假报 pending/sent')
      assert.equal(dispatched.notification.inserted, false, 'engine 退役后不再有出站登记方')
      assert.match(dispatched.notification.messageId, /^task:/)

      // 退役守则（原"launch + reply 必须入队"的反向断言 + 加强）：两条 engine 表恒 0。
      await assertEngineTablesEmpty(harness.db, 'dispatch/waiting')
      assert.equal(
        await harness.runtimeStore.readMessageReceipt(dispatched.notification.messageId),
        null,
        '没有回执写入方时 readMessageReceipt 必须返回 null，不造假',
      )
    })
  })

  test('事件唤醒 RUNNING 任务后 engine_effect / engine_outbox 仍为 0 行', async () => {
    await withHarness(undefined, async (harness) => {
      const interviewId = randomUUID()
      const received = await harness.events.receive(scorecardEvent(interviewId))
      const taskId = received.taskId
      assert.ok(taskId !== null)

      // 认领但不执行：任务停在 RUNNING，模拟"worker 正在跑"。
      const claim = await harness.runtimeStore.claimTask(taskId, {
        workerType: 'SCRIPTED_WORKER',
        workerId: 'junction-router',
        leaseMs: 60_000,
      })
      assert.ok(claim !== null)

      const wake = await harness.events.receive(scorecardEvent(interviewId))
      // 非 engine 断言（保留）：唤醒事实与任务回写照旧。
      assert.equal(wake.taskId, taskId)
      assert.equal(wake.wakeInserted, true)

      // 退役守则（原"必须入队一条 delivery"的反向断言）：无 delivery 行、两张表恒 0。
      await assertEngineTablesEmpty(harness.db, 'wake-on-RUNNING')
    })
  })

  test('重复通知登记后 engine_effect / engine_outbox 仍为 0 行，回执读回为 null', async () => {
    await withHarness(NOTIFICATION, async (harness) => {
      const taskId = randomUUID()
      const first = await harness.runtimeStore.publishNotification({
        taskId,
        attemptNo: 1,
        taskStatus: 'WAITING_HUMAN',
        summary: 'needs human review',
      })
      const duplicate = await harness.runtimeStore.publishNotification({
        taskId,
        attemptNo: 1,
        taskStatus: 'WAITING_HUMAN',
        summary: 'needs human review (duplicate call)',
      })

      // 非 engine 断言（保留形状，真值跟随退役）：两次调用都返回标记，messageId 同形。
      assert.ok(first !== null)
      assert.ok(duplicate !== null)
      assert.equal(first.inserted, false, 'engine 退役后不再有出站登记方')
      assert.equal(duplicate.inserted, false, 'engine 退役后不再有出站登记方')
      assert.equal(first.messageId, duplicate.messageId)
      assert.equal(first.status, 'NOT_CONFIGURED')
      assert.equal(duplicate.status, 'NOT_CONFIGURED')

      // 退役守则（原"一条回执 + 一条 reply effect + pending→sent"的反向断言 + 加强）。
      await assertEngineTablesEmpty(harness.db, 'duplicate-notification')
      assert.equal(
        await harness.runtimeStore.readMessageReceipt(first.messageId),
        null,
        '没有回执写入方时 readMessageReceipt 必须返回 null',
      )
    })
  })
})
