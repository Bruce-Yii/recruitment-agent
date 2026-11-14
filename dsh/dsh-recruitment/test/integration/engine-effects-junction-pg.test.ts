// runtime ↔ Effects/Outbox 交界测试（本 lane 自写，真实 PostgreSQL）。
//
// 证明的是职责切分之后的**交界可用**：
//   1. `src/runtime/**` 那种**异步事务**（同一 DatabaseClient）用 `effects-async.ts` 把副作用的写半边
//      写进 `engine_effect` / `engine_outbox` —— 与业务写入同事务，崩溃窗口为零；
//   2. 持有**同步桥**的一侧（插件进程）用 vendor 的 `Effects` / `Outbox` 从同一批表里派发；
//   3. 两个进程视角看的是同一份队列：异步侧提交的行，同步侧下一次 dispatch 就能取到；
//   4. 幂等：同一 message_id 重复登记不产生第二条回执。
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { testDatabaseConfig } from './db.ts'
import { Store } from '../../src/engine/app/store.ts'
import { Effects } from '../../src/engine/app/effects.ts'
import { Outbox } from '../../src/engine/app/outbox.ts'
import { HealthBoard } from '../../src/engine/infra/health.ts'
import { enqueueEffect, readReceipt, recordOutbound } from '../../src/engine/app/effects-async.ts'
import type { OutboundMessage } from '../../src/engine/core/index.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ENGINE_TABLES = ['engine_trigger', 'engine_disposition', 'engine_trigger_thread', 'engine_thread',
  'engine_ticket', 'engine_decision', 'engine_outbox', 'engine_effect', 'engine_kv']

/**
 * 只清本文件自己的键（不清整表）：`node --test` 会并行跑多个测试文件，共用同一租户的 engine_* 表。
 * 本文件用到的键固定，重复跑前先按它们清理。
 */
async function reset(client: pg.Client): Promise<void> {
  await client.query('set session_replication_role = replica')
  try {
    await client.query("delete from recruitment.engine_effect where key = 'junction:notice:1'")
    await client.query("delete from recruitment.engine_outbox where message_id = 'm-junction-1'")
  } finally {
    await client.query('set session_replication_role = default')
  }
}

const message = (id: string): OutboundMessage => ({
  id, channel: { source: 'probe', thread: 'thread-junction', address: { where: 'chat-1' } },
  text: '面试安排已创建', kind: 'reply', ticketId: 'ticket-junction',
})

test('runtime 的异步事务写副作用 → 插件的 Effects/Outbox 派发（同一批表）', async () => {
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const sidecar = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await sidecar.connect()
  await acquireTestLock(sidecar)
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'engine-junction-test',
  }, undefined, board.claim('store'))
  // runtime 侧：独立的异步连接（与 src/runtime/store.ts 的 withActor 同一形态）。
  const runtimeClient = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await runtimeClient.connect()
  try {
    await reset(sidecar)

    // ── 1. 异步事务里写「通知」副作用 + 出站回执（与业务写入同事务）────────
    const effects = new Effects(store, board)
    const ran: string[] = []
    effects.handle('notice', async (_payload, key) => { ran.push(key) })

    await runtimeClient.query('begin')
    await enqueueEffect(runtimeClient, {
      tenantId: TENANT, kind: 'notice', key: 'junction:notice:1', payload: { value: { ticket_id: 'ticket-junction' }, summary: '任务已派发' },
    })
    const first = await recordOutbound(runtimeClient, { tenantId: TENANT, message: message('m-junction-1') })
    const duplicate = await recordOutbound(runtimeClient, { tenantId: TENANT, message: message('m-junction-1') })
    await runtimeClient.query('commit')
    assert.equal(first, true, '首次登记必须成功')
    assert.equal(duplicate, false, '同一 message_id 重复登记必须幂等忽略')

    // 事务提交后，旁路连接能读到两行（= 副作用不会因为派发进程不在而丢）。
    const queued = await sidecar.query("select kind, key, value from recruitment.engine_effect where key = 'junction:notice:1'")
    assert.equal(queued.rows.length, 1, '异步侧入队的 effect 必须已落库')
    assert.equal((await readReceipt(runtimeClient, 'm-junction-1') as { status?: string }).status, 'pending', '回执必须是 pending，不能假报 sent')

    // ── 2. 同步侧（插件进程）从同一批表派发 ─────────────────────────────
    assert.deepEqual(ran, [], '插件还没开始派发')
    effects.start()
    await effects.idle('notice')
    assert.deepEqual(ran, ['junction:notice:1'], '插件必须派发 runtime 侧入队的通知')
    assert.equal((await sidecar.query("select 1 from recruitment.engine_effect where key = 'junction:notice:1'")).rows.length, 0,
      '成功的 effect 必须从队列删行')

    // ── 3. Outbox 派发 runtime 登记的回执，并 settle 成 sent ─────────────
    const sent: string[] = []
    const outbox = new Outbox({
      store, effects,
      sources: {
        instance: source => source === 'probe' ? { enabled: true } : undefined,
        channelAllowed: () => true,
        send: async (outbound: OutboundMessage) => { sent.push(outbound.id); return 'sent' },
      },
      commands: undefined,
      paused: () => false,
    })
    await outbox.sent()
    assert.deepEqual(sent, ['m-junction-1'], 'Outbox 必须把 runtime 登记的消息真的发出去')
    const settled = await readReceipt(runtimeClient, 'm-junction-1') as { status?: string; ticketId?: string }
    assert.equal(settled.status, 'sent', '发出去后回执必须变 sent（runtime 侧读回即可确认）')
    assert.equal(settled.ticketId, 'ticket-junction', '回执必须保留原消息内容（不是只有状态）')
  } finally {
    await runtimeClient.end()
    await reset(sidecar)
    await releaseTestLock(sidecar)
    await sidecar.end()
    store.close()
  }
})

/**
 * 这三个集成测试文件共用同一个租户的 engine_* 表（尤其 engine_effect 是**单一队列**：
 * 任何持有 Effects 的进程都会消费同 kind 的行）。`node --test` 默认并行跑文件，
 * 两个进程同时消费同一队列会互相偷行，所以用 PG 会话级 advisory lock 把这三个文件串起来。
 * 锁超时 30s：上一个测试若崩溃没释放，这里会明确报错而不是永久挂住。
 */
async function acquireTestLock(client: pg.Client): Promise<void> {
  await client.query("set lock_timeout = '30s'")
  await client.query("select pg_advisory_lock(hashtext('recruitment_engine_integration'))")
}
async function releaseTestLock(client: pg.Client): Promise<void> {
  await client.query("select pg_advisory_unlock(hashtext('recruitment_engine_integration'))")
}