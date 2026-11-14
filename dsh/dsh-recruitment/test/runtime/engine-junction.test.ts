// runtime ↔ 引擎 Effects/Outbox 交界验收（真实 PostgreSQL + 真实同步桥）。
//
// 证明四件事：
//   1. `src/runtime/**` 的**异步事务**（同一 DatabaseClient）把副作用写进
//      `engine_effect` / `engine_outbox` —— 与业务写入同一提交点；
//   2. 插件侧（持有同步桥的进程）用 vendor 的 `Effects` / `Outbox` 从**同一批表**
//      派发这些行；
//   3. 回执从 `pending` 变成 `sent`，runtime 侧用 `readMessageReceipt` 读回；
//   4. 同一 message id 重复登记幂等（只有一条回执、只有一条 reply effect）。
//
// 本文件只在测试里 **import** `src/engine/**`（不修改它）；runtime 侧的依赖方向见
// `src/engine/app/effects-async.ts` 的抬头。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { Store } from '../../src/engine/app/store.ts'
import { Effects } from '../../src/engine/app/effects.ts'
import { Outbox } from '../../src/engine/app/outbox.ts'
import { HealthBoard } from '../../src/engine/infra/health.ts'
import type { OutboundMessage } from '../../src/engine/core/index.ts'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { InboundEvent, NotificationTarget } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'
import { testDatabaseConfig } from '../integration/db.ts'
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
  readonly engineStore: Store
  readonly effects: Effects
  readonly outbox: Outbox
  readonly launched: string[]
  readonly delivered: string[]
  readonly sent: string[]
}

async function withHarness(notification: NotificationTarget | undefined, fn: (harness: Harness) => Promise<void>): Promise<void> {
  const db = await createRuntimeTestDatabase('junction')
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const engineStore = new Store({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: db.name,
    password: cfg.password,
    tenant_id: RUNTIME_TENANT,
    statementTimeoutMs: 5_000,
    applicationName: 'runtime-engine-junction-test',
  }, undefined, board.claim('store'))
  const effects = new Effects(engineStore, board)
  const launched: string[] = []
  const delivered: string[] = []
  effects.handle('launch', async (_payload, key) => { launched.push(key) })
  effects.handle('delivery', async (_payload, key) => { delivered.push(key) })
  const sent: string[] = []
  const outbox = new Outbox({
    store: engineStore,
    effects,
    sources: {
      instance: (source) => source === 'probe' ? { enabled: true } : undefined,
      channelAllowed: () => true,
      send: async (message: OutboundMessage) => { sent.push(message.id); return 'sent' as const },
    },
    commands: undefined,
    paused: () => false,
  })
  const runtimeStore = new RuntimeStore({
    pool: db.pool,
    tenantId: RUNTIME_TENANT,
    actorId: RUNTIME_ACTOR,
    notification,
  })
  const events = new EventRuntime({ store: runtimeStore })
  try {
    await fn({ db, runtimeStore, events, engineStore, effects, outbox, launched, delivered, sent })
  } finally {
    await effects.drain()
    engineStore.close()
    await db.drop()
  }
}

let eventCounter = 0
function resumeEvent(applicationId: string): InboundEvent {
  eventCounter += 1
  return {
    tenantId: RUNTIME_TENANT,
    provider: 'feishu',
    providerEventId: `junction-evt-${eventCounter}-${randomUUID()}`,
    eventType: 'resume_received',
    payload: { application_id: applicationId },
    trustLevel: 'UNTRUSTED_EXTERNAL',
  }
}

describe('runtime ↔ engine effects/outbox junction', () => {
  test('async runtime transaction writes launch + notice/reply; plugin Effects/Outbox dispatch; receipt pending → sent', async () => {
    await withHarness(NOTIFICATION, async (harness) => {
      const applicationId = randomUUID()
      const received = await harness.events.receive(resumeEvent(applicationId))
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
      assert.ok(dispatched !== null)
      assert.ok(dispatched.notification !== null, 'WAITING_EXTERNAL must record an outbound notification')
      assert.equal(dispatched.notification.status, 'pending', 'same-transaction read must see pending, never fake sent')
      const messageId = dispatched.notification.messageId

      // 提交后、插件派发前：副作用已经在同一批引擎表里。
      const queued = await harness.db.pool.query<{ kind: string; key: string }>(
        "select kind, key from recruitment.engine_effect where kind in ('launch','reply') order by seq",
      )
      assert.deepEqual(
        queued.rows.map((row) => row.kind),
        ['launch', 'reply'],
        'launch (dispatch) and reply (outbound delivery) must both be queued by the runtime transaction',
      )
      assert.equal(queued.rows[0]!.key, dispatched.attemptId, 'launch key is the attempt id')
      assert.equal(queued.rows[1]!.key, messageId, 'reply key is the outbound message id')

      const pending = await harness.runtimeStore.readMessageReceipt(messageId)
      assert.equal(pending?.status, 'pending', 'receipt is durable and pending before the plugin dispatches')

      // 插件侧派发（同一个 PG，但独立同步桥进程/连接）。
      harness.effects.start()
      await harness.effects.idle('launch')
      assert.deepEqual(harness.launched, [dispatched.attemptId], 'plugin Effects must dispatch the runtime launch effect')

      await harness.outbox.sent()
      assert.deepEqual(harness.sent, [messageId], 'plugin Outbox must deliver the runtime-registered message')

      const settled = await harness.runtimeStore.readMessageReceipt(messageId)
      assert.equal(settled?.status, 'sent', 'runtime reads the same receipt as sent after plugin delivery')
      assert.equal(settled?.ticketId, taskId, 'receipt keeps the task content, not just the status')
    })
  })

  test('an event that wakes a RUNNING task enqueues a delivery effect in the same transaction', async () => {
    await withHarness(undefined, async (harness) => {
      const applicationId = randomUUID()
      const received = await harness.events.receive(resumeEvent(applicationId))
      const taskId = received.taskId
      assert.ok(taskId !== null)

      // 认领但不执行：任务停在 RUNNING，模拟"worker 正在跑"。
      const claim = await harness.runtimeStore.claimTask(taskId, {
        workerType: 'SCRIPTED_WORKER',
        workerId: 'junction-router',
        leaseMs: 60_000,
      })
      assert.ok(claim !== null)

      const wake = await harness.events.receive(resumeEvent(applicationId))
      assert.equal(wake.taskId, taskId)
      assert.equal(wake.wakeInserted, true)

      const queued = await harness.db.pool.query<{ kind: string; key: string }>(
        "select kind, key from recruitment.engine_effect where kind = 'delivery'",
      )
      assert.equal(queued.rows.length, 1, 'a wake on a RUNNING task must queue exactly one delivery effect')
      assert.equal(queued.rows[0]!.key, taskId)

      harness.effects.start()
      await harness.effects.idle('delivery')
      assert.deepEqual(harness.delivered, [taskId], 'plugin Effects must dispatch the delivery effect')
    })
  })

  test('duplicate outbound registration is idempotent (one receipt, one reply effect) and settles to sent', async () => {
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
      assert.ok(first !== null)
      assert.ok(duplicate !== null)
      assert.equal(first.inserted, true)
      assert.equal(duplicate.inserted, false, 'same message id must be ignored idempotently')
      assert.equal(first.messageId, duplicate.messageId)

      const receipts = await harness.db.pool.query<{ n: string }>(
        'select count(*)::text as n from recruitment.engine_outbox where message_id = $1',
        [first.messageId],
      )
      assert.equal(Number(receipts.rows[0]!.n), 1, 'only one outbox receipt may exist')
      const replies = await harness.db.pool.query<{ n: string }>(
        "select count(*)::text as n from recruitment.engine_effect where kind = 'reply' and key = $1",
        [first.messageId],
      )
      assert.equal(Number(replies.rows[0]!.n), 1, 'only one reply effect may exist')

      harness.effects.start()
      await harness.outbox.sent()
      assert.deepEqual(harness.sent, [first.messageId])
      const settled = await harness.runtimeStore.readMessageReceipt(first.messageId)
      assert.equal(settled?.status, 'sent')
    })
  })
})
