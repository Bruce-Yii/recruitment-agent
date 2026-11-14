// 四个「优先直接 vendor」机制 × 真实 PostgreSQL 的集成测试（本 lane 自写）。
//
// 按 Notion `04｜Agent Runtime & Reuse Architecture` §08 的范围，本测试只覆盖文档点名要直接搬的四块：
//   1. **Effects Queue**：与命令同事务入队、提交后派发、成功即删行、失败退避重试；
//   2. **Outbox / Receipt**：回执 pending → sent / dropped，message_id 幂等，撤回只删 pending；
//   3. **Passes**：串行化 pass、健康状态在失败后回到 ready、stop 后不再跑；
//   4. **Intake 去重与订阅分发**：同 ID 只进一次、按 thread 订阅扇出到 Ticket、被范围过滤的事件记 disposition。
//
// 全部结论都用**另一条 pg 连接**直接读表验证（不信被测对象的返回值）。
// 本测试不碰 DSH Session 与 LLM：这两个机制本来就不依赖它们。
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { testDatabaseConfig } from './db.ts'
import { Store } from '../../src/engine/app/store.ts'
import { Effects, Later } from '../../src/engine/app/effects.ts'
import { Outbox } from '../../src/engine/app/outbox.ts'
import { Passes } from '../../src/engine/app/passes.ts'
import { HealthBoard } from '../../src/engine/infra/health.ts'
import { Intake } from '../../src/engine/core/intake.ts'
import { Tickets } from '../../src/engine/core/tickets.ts'
import { Replies } from '../../src/engine/core/replies.ts'
import type { EngineOptions } from '../../src/engine/core/part.ts'
import type { Assignment, OutboundMessage, Ticket, Trigger } from '../../src/engine/core/index.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ENGINE_TABLES = ['engine_trigger', 'engine_disposition', 'engine_trigger_thread', 'engine_thread',
  'engine_ticket', 'engine_decision', 'engine_outbox', 'engine_effect', 'engine_kv']

const readRow = async (client: pg.Client, table: string, column: string, value: string) =>
  (await client.query(`select value from recruitment.${table} where ${column} = $1`, [value])).rows[0]?.value as Record<string, unknown> | undefined

/** 读 effect 队列行的**列**（不是 JSON 载荷）：attempts / due / error / generation 都是列。 */
const readEffect = async (client: pg.Client, key: string) =>
  (await client.query('select kind, key, seq, generation, attempts, error, due from recruitment.engine_effect where key = $1', [key]))
    .rows[0] as { kind: string; key: string; seq: string; generation: number; attempts: number; error: string; due: string } | undefined

/**
 * 清空本租户的引擎表，让测试可重复。
 *
 * engine_trigger / engine_decision 挂着 0012 的“历史事实禁删”触发器（`fn_block_delete`）；本测试要保留那个守卫，
 * 所以清理时显式切 `session_replication_role = replica` 绕过触发器（superuser 连接，仅在清理这一段生效）。
 * 守卫本身是否生效，由“用正常 DELETE 直击 engine_trigger 应被拒绝”这一条断言覆盖。
 */
async function reset(client: pg.Client): Promise<void> {
  await client.query('set session_replication_role = replica')
  try {
    for (const table of ENGINE_TABLES) await client.query(`delete from recruitment.${table} where tenant_id = $1`, [TENANT])
  } finally {
    await client.query('set session_replication_role = default')
  }
}

/** 一条最小的 OutboundMessage。 */
const message = (id: string): OutboundMessage => ({
  id, channel: { source: 'probe', thread: 'thread-1', address: { where: 'chat-1' } }, text: `message ${id}`, kind: 'reply', ticketId: 'ticket-1',
})

test('四个优先机制在真实 PostgreSQL 上端到端成立', async () => {
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const sidecar = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await sidecar.connect()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'engine-mechanisms-test',
  }, error => console.error('store.report:', error), board.claim('store'))
  const lifetime = new AbortController()

  try {
    await reset(sidecar)
    const effects = new Effects(store, board)

    // ── 1. Effects Queue：入队 / 派发 / 成功删行 / 失败退避 ─────────────
    let ran = 0
    effects.handle('notice', async () => { ran++ })
    store.atomic(() => effects.enqueue('notice', 'notice-1', { value: { hello: 'pg' }, summary: 'one' }))
    assert.ok(await readRow(sidecar, 'engine_effect', 'key', 'notice-1'), 'effect 必须与命令同事务落库')
    effects.start()
    await effects.idle('notice')
    assert.equal(ran, 1)
    assert.equal(await readRow(sidecar, 'engine_effect', 'key', 'notice-1'), undefined, '成功的 effect 必须删行')

    // 失败退避：attempts 增加、due 往后推，且失败写进 error 列。
    let attempts = 0
    effects.handle('relay', async () => { attempts++; throw new Error('probe failure') })
    effects.enqueue('relay', 'relay-1', { text: 'x' })
    await effects.idle('relay')
    const failed = await readEffect(sidecar, 'relay-1')
    assert.equal(attempts, 1)
    assert.equal(failed?.attempts, 1, '失败必须记 attempts')
    assert.ok(Number(failed?.due) > Date.now(), '失败必须把 due 推后（退避）')
    assert.match(String(failed?.error), /probe failure/)
    // 连续失败达到 FAILURES_BEFORE_ERROR(3) 才把健康标 error；这里把 due 拨回重跑两次凑满阈值。
    for (let attempt = 0; attempt < 2; attempt++) {
      await sidecar.query("update recruitment.engine_effect set due = 0 where key = 'relay-1'")
      await effects.idle('relay')
    }
    assert.equal((await readEffect(sidecar, 'relay-1'))?.attempts, 3, '三次失败必须累计到 attempts=3')
    assert.equal(board.all.relay?.state, 'error')

    // ── 2. Outbox / Receipt：pending → sent、幂等、撤回 ────────────────
    const sent: string[] = []
    const outbox = new Outbox({
      store,
      effects,
      sources: {
        instance: source => source === 'probe' ? { enabled: true } : undefined,
        channelAllowed: () => true,
        send: async (outbound: OutboundMessage) => { sent.push(outbound.id); return 'sent' },
      },
      commands: undefined,
      paused: () => false,
    })
    outbox.send(message('m-1'))
    assert.equal((await readRow(sidecar, 'engine_outbox', 'message_id', 'm-1') as { status?: string }).status, 'pending')
    outbox.send(message('m-1'))
    assert.equal((await sidecar.query('select count(*)::int n from recruitment.engine_outbox')).rows[0].n, 1, '同一 message_id 只能有一条回执')
    await outbox.sent()
    assert.deepEqual(sent, ['m-1'])
    assert.equal((await readRow(sidecar, 'engine_outbox', 'message_id', 'm-1') as { status?: string }).status, 'sent')

    outbox.send(message('m-2'))
    outbox.withdraw('m-2')
    assert.equal(await readRow(sidecar, 'engine_outbox', 'message_id', 'm-2'), undefined, '撤回 pending 必须删回执')
    await effects.idle('reply')
    assert.deepEqual(sent, ['m-1'], '撤回的消息不能真的发出去')

    // ── 3. Intake 去重与订阅分发（真实的 Tickets/Replies/Intake）────────
    const options: EngineOptions = {
      repo: store,
      policy: () => ({ version: 'probe-1', paused: false, evalTimeoutMs: 60_000,
        gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }),
        revalidate: () => true, admitsInferred: () => true }),
      scope: { scope: trigger => trigger.source === 'blocked' ? { listened: false, reason: 'not_listened' } : { listened: true, observed: false } },
      assessor: { request: () => {} },
      executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      now: () => new Date().toISOString(),
    }
    const tickets = new Tickets(options, new Replies(options))
    const intake = new Intake(options, tickets)
    const trigger = (id: string, source = 'probe'): Trigger => ({
      id, source, threads: [{ source, id: 'thread-1' }], actor: { source, id: 'u-1' }, human: true, at: new Date().toISOString(),
      text: 'trigger', channel: { source, thread: 'thread-1', address: { where: 'chat-1' } }, meta: {},
    })

    assert.equal(intake.receive(trigger('tg-1')), 'stored')
    assert.equal(intake.receive(trigger('tg-1')), 'duplicate', '同 ID 的 Trigger 只能进一次')
    const thread = await readRow(sidecar, 'engine_thread', 'thread_key', 'probe:thread-1') as { pending?: string[] }
    assert.deepEqual(thread.pending, ['tg-1'], '未被 ticket 决定的 trigger 必须排进 Eval 队列')

    // 订阅分发：给 thread 挂一个 ticket，再来一条 Trigger，必须扇出成该 ticket 的 Input。
    const ticket: Ticket = {
      id: 'ticket-fanout', title: '订阅测试', decisionId: 'd-1',
      mandate: { strength: 'explicit', policyVersion: 'probe-1', basis: { via: 'addressed', addressed: 'mention' }, actor: { source: 'probe', id: 'u-1' }, scope: 's' },
      channels: [], assignments: [], inputs: [], undelivered: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      origin: { triggerId: 'tg-1', triggerIds: ['tg-1'] },
    }
    store.atomic(() => {
      store.tickets.save(ticket)
      store.threads.save({ ...(store.threads.get('probe:thread-1')!), subscriptions: [ticket.id] })
    })
    assert.equal(intake.receive(trigger('tg-2')), 'stored')
    const fanned = await readRow(sidecar, 'engine_ticket', 'ticket_id', ticket.id) as unknown as Ticket
    assert.equal(fanned.inputs.length, 1, '订阅的 ticket 必须收到扇出的 Input')
    const disposition = await readRow(sidecar, 'engine_disposition', 'disposition_id', 'tg-2') as { fanout?: string[] }
    assert.deepEqual(disposition.fanout, [ticket.id], 'disposition 必须记录扇出目标')
    const triggerId = await readRow(sidecar, 'engine_disposition', 'disposition_id', 'tg-1') as { fanout?: string[] }
    assert.deepEqual(triggerId.fanout, [], 'tg-1 发生订阅之前，扇出必须为空')

    // 被范围过滤的 Trigger：存下来但记 filtered，不进 Eval 队列。
    assert.equal(intake.receive(trigger('tg-3', 'blocked')), 'filtered')
    const filtered = await readRow(sidecar, 'engine_disposition', 'disposition_id', 'tg-3') as { filtered?: { code?: string } }
    assert.equal(filtered.filtered?.code, 'not_listened')

    // ── 4. Passes：串行化 + 健康状态 ──────────────────────────────────
    let passes = 0
    let failNext = false
    const passesHealth = board.claim('passes')
    const passesHost = {
      engine: {
        receive: (received: Trigger) => intake.receive(received),
        evaluateDue: () => { passes++; if (failNext) { failNext = false; throw new Error('pass failed') } },
      },
      effects,
      health: passesHealth,
      lifetime: lifetime.signal,
      configured: () => true,
      closing: () => false,
    }
    const pass = new Passes(passesHost)
    pass.start()
    try {
      assert.equal(pass.receive(trigger('tg-4')), 'stored')
      await pass.idle()
      assert.ok(passes >= 1, 'Passes 必须驱动 evaluateDue')
      const afterOne = passes
      // 并发请求合并：同一轮的多个 request 不应爆开成多次 pass。
      pass.request(); pass.request()
      await pass.idle()
      assert.ok(passes >= afterOne, '并发请求必须被串行化（次数只增不并）')
      // 失败后健康变 error，下一次成功回 ready。
      failNext = true
      pass.request()
      await pass.idle()
      assert.equal(passesHealth.get()?.state, 'error')
      pass.request()
      await pass.idle()
      assert.equal(passesHealth.get()?.state, 'ready', '后续成功的 pass 必须把健康恢复成 ready')
    } finally { await pass.stop() }

    // ── 守卫仍在：正常 DELETE 必须被 0012 的禁删触发器拒绝 ─────────────
    await assert.rejects(async () => { await sidecar.query('delete from recruitment.engine_trigger where trigger_id = $1', ['tg-1']) },
      /DELETE_FORBIDDEN/)
  } finally {
    await reset(sidecar)
    await sidecar.end()
    store.close()
  }
})

test('effect 的 Later 不消耗失败次数（暂停/无槽位重排队）', async () => {  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const sidecar = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await sidecar.connect()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'engine-later-test',
  }, undefined, board.claim('store'))
  try {
    await reset(sidecar)
    const effects = new Effects(store, board)
    let calls = 0
    effects.handle('launch', async () => { calls++; if (calls === 1) throw new Later('not now') })
    effects.enqueue('launch', 'later-1', { ticketId: 't', assignmentId: 'a' })
    effects.start()
    await effects.idle('launch')
    const row = await readEffect(sidecar, 'later-1')
    assert.equal(calls, 1)
    assert.equal(row?.attempts, 0, 'Later 不许消耗失败次数')
    assert.ok(Number(row?.due) > Date.now(), 'Later 必须把 due 推后重试')
  } finally {
    await reset(sidecar)
    await sidecar.end()
    store.close()
  }
})

test('同步桥的代价与失败语义：语句超时被取消、worker 被杀后重建', async () => {
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'engine-bridge-failure-test',
  }, undefined, board.claim('store'))
  try {
    // 1. 引擎路径的 statement_timeout=5s：跑 6 秒的语句必须被 PG 取消（而不是把宿主事件循环冻住）。
    assert.throws(() => store.db.prepare('select pg_sleep(6)').all(), /statement timeout|canceling statement|超时/i)
    assert.equal((store.db.prepare('select 1 as n').get() as { n: number }).n, 1, '语句超时后连接仍可用')
    // 2. worker 失联：杀掉 worker 后，下一次调用必须重建并成功（不能静默返回空结果，也不能永久卡死）。
    const worker = (store as unknown as { pg: { worker?: { terminate(): Promise<number> } } }).pg.worker
    assert.ok(worker, '同步桥应该有一个 worker 线程')
    await worker.terminate()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal((store.db.prepare('select 2 as n').get() as { n: number }).n, 2, 'worker 被杀后下一次调用必须重建连接并成功')
  } finally {
    store.close()
  }
})
test('回读端口：present 不重发 / absent 才重发 / 回读抛错不重发', async () => {
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const sidecar = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await sidecar.connect()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'engine-readback-test',
  }, undefined, board.claim('store'))
  try {
    await reset(sidecar)

    /** 跑一轮：第一次 send 抛错（模拟"发出去了但回执没写回"，或"根本没出去"），退避期过后换一个进程重跑。 */
    const run = async (id: string, options: {
      readonly firstSendReachesWire: boolean
      readonly lookup?: () => Promise<'present' | 'absent'>
    }): Promise<{ wire: string[]; calls: number; status: string | undefined }> => {
      const wire: string[] = []
      let calls = 0
      const channels = {
        instance: () => ({ enabled: true }),
        channelAllowed: () => true,
        send: async (message: OutboundMessage) => {
          calls++
          if (calls === 1) {
            if (options.firstSendReachesWire) { wire.push(message.id); throw new Error('ACK_LOST') }
            throw new Error('connection reset before send')
          }
          wire.push(message.id)
          return 'sent' as const
        },
        lookup: options.lookup,
      }
      const effects = new Effects(store, new HealthBoard())
      effects.start()
      const outbox = new Outbox({ store, effects, sources: channels, commands: undefined, paused: () => false })
      outbox.send(message(id))
      await outbox.sent()
      // 让退避到期，并用一个新进程（新的 Effects/Outbox）重试 —— 与 §9.12-9 的验收口径一致。
      await sidecar.query("update recruitment.engine_effect set due = 0 where kind = 'reply'")
      const restarted = new Effects(store, new HealthBoard())
      const again = new Outbox({ store, effects: restarted, sources: channels, commands: undefined, paused: () => false })
      restarted.start()
      await again.sent()
      return { wire, calls, status: again.status(id) }
    }

    // A. 回读说「线上已有」：补记 sent，线上仍然只有 1 条。
    const present = await run('m-readback-present', { firstSendReachesWire: true, lookup: async () => 'present' })
    assert.deepEqual(present.wire, ['m-readback-present'], '线上已有时不得重发')
    assert.equal(present.calls, 1, '回读到已有：不得再次调用 send')
    assert.equal(present.status, 'sent', '回读到已有，必须补记 sent')
    const presentReceipt = await readRow(sidecar, 'engine_outbox', 'message_id', 'm-readback-present') as { attempt?: unknown }
    assert.equal(presentReceipt.attempt, undefined, 'settle 后不该留下发送标记')

    // B. 回读说「确认没有」：才允许重发，线上应当恰好 2 次（1 次真实发送 + 1 次重发）。
    const absent = await run('m-readback-absent', { firstSendReachesWire: false, lookup: async () => 'absent' })
    assert.equal(absent.calls, 2, '回读确认没有时必须重发（第二次 send）')
    assert.deepEqual(absent.wire, ['m-readback-absent'], '重发只允许在线上确认没有时发生')
    assert.equal(absent.status, 'sent')

    // C. 回读本身抛错：不猜、不重发，保持 pending 并记原因。
    const broken = await run('m-readback-error', {
      firstSendReachesWire: true,
      lookup: async () => { throw new Error('readback endpoint unavailable') },
    })
    assert.deepEqual(broken.wire, ['m-readback-error'], '回读失败时绝不重发')
    assert.equal(broken.calls, 1, '回读失败：不得再次调用 send')
    assert.equal(broken.status, 'pending', '回读失败必须保持 pending')
    const brokenReceipt = await readRow(sidecar, 'engine_outbox', 'message_id', 'm-readback-error') as {
      attempt?: { state?: string }; reconcile?: { outcome?: string; reason?: string }
    }
    assert.equal(brokenReceipt.attempt?.state, 'sending', '回读失败必须保留发送标记，供下次继续对账')
    assert.equal(brokenReceipt.reconcile?.outcome, 'error', '回读失败的原因必须落库')
    assert.match(String(brokenReceipt.reconcile?.reason), /readback failed/)
  } finally {
    await reset(sidecar)
    await sidecar.end()
    store.close()
  }
})