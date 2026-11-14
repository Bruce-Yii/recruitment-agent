// §11.6 / §9.12 中「事件去重、进程重启、模型不可用、授权撤销、无回执重发、乱序晚到」
// 六条门槛，用 vendored 执行器引擎（src/engine/**，真 PostgreSQL 表）现场验证。
//
// 为什么这一组放引擎层：这六条问的是「事件 / 任务 / 副作用」的运行时事实，
// 引擎的 engine_trigger / engine_effect / engine_outbox / engine_ticket 正是这些事实的落库处；
// 用真表读回才算证据（不信被测对象的返回值）。
//
// 隔离：本文件独占 `TENANT` 的 engine_* 表；用例串行执行，前后都清理（历史事实禁删 → 用
// `session_replication_role=replica` 绕过触发器清理，守卫本身另有断言）。
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { cfg, TENANT } from './harness.ts'
import { Store } from '../../src/engine/app/store.ts'
import { Effects } from '../../src/engine/app/effects.ts'
import { Outbox } from '../../src/engine/app/outbox.ts'
import { HealthBoard } from '../../src/engine/infra/health.ts'
import { Intake } from '../../src/engine/core/intake.ts'
import { Tickets } from '../../src/engine/core/tickets.ts'
import { Replies } from '../../src/engine/core/replies.ts'
import type { EngineOptions } from '../../src/engine/core/part.ts'
import type { OutboundMessage, Ticket, Trigger } from '../../src/engine/core/index.ts'

const ENGINE_TABLES = ['engine_trigger', 'engine_disposition', 'engine_trigger_thread', 'engine_thread',
  'engine_ticket', 'engine_decision', 'engine_outbox', 'engine_effect', 'engine_kv']

/** 清空本租户的引擎表（保留禁删触发器；只在这一段临时切 replica）。 */
async function reset(client: pg.Client): Promise<void> {
  await client.query('set session_replication_role = replica')
  try {
    for (const table of ENGINE_TABLES) await client.query(`delete from recruitment.${table} where tenant_id = $1`, [TENANT])
  } finally {
    await client.query('set session_replication_role = default')
  }
}

/** 一条最小的 OutboundMessage（合成 id / 文本，不含任何真实内容）。 */
function outbound(id: string): OutboundMessage {
  return {
    id,
    channel: { source: 'acceptance', thread: 'thread-1', address: { where: 'chat-1' } },
    text: `synthetic message ${id}`,
    kind: 'reply',
    ticketId: 'ticket-1',
  }
}

/** 一条测试 Trigger（合成）。 */
function trigger(id: string, at = new Date().toISOString(), source = 'acceptance'): Trigger {
  return {
    id,
    source,
    threads: [{ source, id: 'thread-1' }],
    actor: { source, id: 'u-1' },
    human: true,
    at,
    text: `synthetic trigger ${id}`,
    channel: { source, thread: 'thread-1', address: { where: 'chat-1' } },
    meta: {},
  }
}

/** 一条最小 Ticket（业务任务身份）。 */
function ticket(id: string): Ticket {
  return {
    id,
    title: '验收任务',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'acceptance-1',
      basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'acceptance', id: 'u-1' },
      scope: 'acceptance',
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    origin: { triggerId: 'tg-1', triggerIds: ['tg-1'] },
  }
}

/** 引擎测试的装配（一个 Store + 一个可注入 policy 的 EngineOptions）。 */
interface Rig {
  readonly store: Store
  readonly board: HealthBoard
  readonly sidecar: pg.Client
  readonly options: (policy: () => { revalidate: () => boolean; paused?: boolean }) => EngineOptions
}

async function rig(): Promise<Rig> {
  const board = new HealthBoard()
  const sidecar = new pg.Client({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
  })
  await sidecar.connect()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'acceptance-gates',
  }, error => console.error('store.report:', error), board.claim('store'))
  const options = (policy: () => { revalidate: () => boolean; paused?: boolean }): EngineOptions => {
    let current = policy()
    return {
      repo: store,
      policy: () => {
        current = policy()
        return {
          version: 'acceptance-1',
          paused: current.paused ?? false,
          evalTimeoutMs: 60_000,
          gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'addressed', addressed: 'mention' } }),
          revalidate: () => current.revalidate(),
          admitsInferred: () => true,
        }
      },
      scope: { scope: () => ({ listened: true, observed: false }) },
      assessor: { request: () => {} },
      executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      now: () => new Date().toISOString(),
    }
  }
  return { store, board, sidecar, options }
}

/** 读某表某业务键的 JSON 聚合（engine_* 的 `value` 列）。 */
async function readAggregate(
  sidecar: pg.Client,
  table: string,
  keyColumn: string,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const { rows } = await sidecar.query<{ value: Record<string, unknown> }>(
    `select value from recruitment.${table} where ${keyColumn} = $1`, [key],
  )
  return rows[0]?.value
}

/** 某表本租户行数。 */
async function countRows(sidecar: pg.Client, table: string): Promise<number> {
  const { rows } = await sidecar.query<{ n: string }>(
    `select count(*)::int as n from recruitment.${table} where tenant_id = $1`, [TENANT],
  )
  return Number(rows[0]?.n ?? 0)
}

/** 让失败后等待退避的 effect 立刻到期（模拟"时间已经过去"）。 */
async function makeDueNow(sidecar: pg.Client, kind: string): Promise<void> {
  await sidecar.query(
    `update recruitment.engine_effect set due = 0 where tenant_id = $1 and kind = $2`, [TENANT, kind],
  )
}

test.describe('§11.6 / §9.12 运行时门槛（真 PostgreSQL）', () => {
  test('§11.6-1 同一外部事件重复投递，不产生重复 Intake / Task / Effect', async () => {
    const { store, board, sidecar, options } = await rig()
    try {
      await reset(sidecar)
      const engine = options(() => ({ revalidate: () => true }))
      const intake = new Intake(engine, new Tickets(engine, new Replies(engine)))

      // 同一 trigger_id 投递两次：第二次必须判 duplicate，库里只有一行。
      assert.equal(intake.receive(trigger('evt-1')), 'stored')
      assert.equal(intake.receive(trigger('evt-1')), 'duplicate', '同 ID 事件只能进一次')

      // 同一业务键 enqueue 两次：ON CONFLICT 合并成一行；派发成功后删行。
      const effects = new Effects(store, new HealthBoard())
      let ran = 0
      effects.handle('notice', async () => { ran += 1 })
      effects.enqueue('notice', 'evt-1:notice', { value: { synthetic: true }, summary: 'one' })
      effects.enqueue('notice', 'evt-1:notice', { value: { synthetic: true }, summary: 'one' })
      effects.start()
      await effects.idle('notice')

      // 真实行数读回（不是看返回值）。
      assert.equal(await countRows(sidecar, 'engine_trigger'), 1, '重复事件只能落一条 trigger')
      assert.equal(await countRows(sidecar, 'engine_disposition'), 1, '重复事件只能有一条处置记录')
      assert.equal(ran, 1, '同一 effect 键只能执行一次')
      assert.equal(await countRows(sidecar, 'engine_effect'), 0, '成功的 effect 必须出队')
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })

  test('§11.6-7 进程重启后 Business Task 可恢复，外部副作用不会因盲目重试而重复', async () => {
    const { store, board, sidecar, options } = await rig()
    try {
      await reset(sidecar)

      // ① 崩溃前只落库、不派发：effect 行在库里等重启。
      const first = new Effects(store, new HealthBoard())
      let ran = 0
      first.enqueue('notice', 'restart-1', { value: { synthetic: true }, summary: 'restart' })
      assert.equal(await countRows(sidecar, 'engine_effect'), 1, '崩溃前 effect 必须已持久化')

      // ② 模拟新进程：新 Effects 实例从表里接走未完成的 effect，只执行一次。
      const second = new Effects(store, new HealthBoard())
      second.handle('notice', async () => { ran += 1 })
      second.start()
      await second.idle('notice')
      assert.equal(ran, 1, '重启后未完成的 effect 必须被恢复执行')
      assert.equal(await countRows(sidecar, 'engine_effect'), 0)

      // ③ 再重启一次：已完成的不能重放（行已删除，不靠内存状态）。
      const third = new Effects(store, new HealthBoard())
      third.handle('notice', async () => { ran += 1 })
      third.start()
      await third.idle('notice')
      assert.equal(ran, 1, '已完成 effect 不得因再次重启而重复执行')

      // ④ Outbox 回执跨重启：pending 回执 + reply effect 落库；新进程只发一次。
      const sendLog: string[] = []
      const channels = {
        instance: () => ({ enabled: true }),
        channelAllowed: () => true,
        send: async (message: OutboundMessage) => { sendLog.push(message.id); return 'sent' as const },
      }
      const beforeCrash = new Effects(store, new HealthBoard())
      const outboxBefore = new Outbox({
        store, effects: beforeCrash, sources: channels, commands: undefined, paused: () => false,
      })
      outboxBefore.send(outbound('m-restart-1'))
      assert.equal(outboxBefore.status('m-restart-1'), 'pending', '回执 must be pending before dispatch')
      assert.equal(await countRows(sidecar, 'engine_outbox'), 1)

      const afterRestart = new Effects(store, new HealthBoard())
      const outboxAfter = new Outbox({
        store, effects: afterRestart, sources: channels, commands: undefined, paused: () => false,
      })
      afterRestart.start()
      await outboxAfter.sent()
      assert.deepEqual(sendLog, ['m-restart-1'], '重启后 pending 回执必须恰好发送一次')
      assert.equal(outboxAfter.status('m-restart-1'), 'sent')
      assert.equal(await countRows(sidecar, 'engine_effect'), 0)

      const secondRestart = new Effects(store, new HealthBoard())
      const outboxAgain = new Outbox({
        store, effects: secondRestart, sources: channels, commands: undefined, paused: () => false,
      })
      secondRestart.start()
      await outboxAgain.sent()
      assert.deepEqual(sendLog, ['m-restart-1'], '已 sent 的回执不得再次发送')
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })

  test('§9.12-2 模型不可用/超时：业务状态仍正确，任务可恢复', async () => {
    const { store, board, sidecar, options } = await rig()
    try {
      await reset(sidecar)
      const engine = options(() => ({ revalidate: () => true }))
      // 业务任务身份先落库（模型调用失败不得改动它）。
      store.atomic(() => store.tickets.save(ticket('ticket-model-timeout')))
      const before = JSON.stringify(await readAggregate(sidecar, 'engine_ticket', 'ticket_id', 'ticket-model-timeout'))

      const effects = new Effects(store, new HealthBoard())
      let calls = 0
      effects.handle('relay', async () => {
        calls += 1
        throw new Error('MODEL_PROVIDER_UNAVAILABLE: request timed out')
      }, { retry: [1_000, 60_000] })
      effects.enqueue('relay', 'model-call-1', { text: 'synthetic prompt' })
      effects.start()
      await effects.idle('relay')

      const failed = (await sidecar.query<{ attempts: number; due: number; error: string }>(
        `select attempts, due, error from recruitment.engine_effect where tenant_id = $1 and kind = 'relay' and key = 'model-call-1'`,
        [TENANT],
      )).rows[0]
      assert.ok(failed !== undefined, '模型调用失败后任务必须仍在持久队列里（可恢复）')
      assert.equal(failed.attempts, 1, '失败必须记 attempts')
      assert.ok(failed.due > Date.now(), '失败必须退避等待，而不是忙重试')
      assert.match(String(failed.error), /MODEL_PROVIDER_UNAVAILABLE/)
      assert.equal(
        JSON.stringify(await readAggregate(sidecar, 'engine_ticket', 'ticket_id', 'ticket-model-timeout')),
        before,
        '模型不可用不得改动业务状态',
      )

      // 恢复：时间到达后由新进程重试成功，任务出队，业务状态仍不变。
      await makeDueNow(sidecar, 'relay')
      const recovered = new Effects(store, new HealthBoard())
      recovered.handle('relay', async () => { calls += 1 })
      recovered.start()
      await recovered.idle('relay')
      assert.equal(calls, 2, '失败一次后必须能重试成功')
      assert.equal(await countRows(sidecar, 'engine_effect'), 0)
      assert.equal(
        JSON.stringify(await readAggregate(sidecar, 'engine_ticket', 'ticket_id', 'ticket-model-timeout')),
        before,
      )
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })

  test('§9.12-10 授权撤销后，待执行的 Ticket 必须重新校验并拒绝', async () => {
    const { store, board, sidecar, options } = await rig()
    try {
      await reset(sidecar)
      let allowed = true
      const engine = options(() => ({ revalidate: () => allowed }))
      const intake = new Intake(engine, new Tickets(engine, new Replies(engine)))
      intake.receive(trigger('tg-revoke'))
      // 只对**已结束**的 Ticket 才走 revalidate（活着的 Ticket 仍在授权范围内）。
      const ended = ticket('ticket-revoke')
      ended.ended = { at: new Date().toISOString(), by: 'executor', outcome: 'completed' }
      store.atomic(() => store.tickets.save(ended))

      const tickets = new Tickets(engine, new Replies(engine))
      // 正例：授权仍在时，attachable 正常返回 trigger。
      assert.equal(tickets.attachable('ticket-revoke', 'tg-revoke').id, 'tg-revoke')

      // 撤销授权：同一个 Ticket 的 Mandate 不再成立 → 必须拒绝，且不落任何新事实。
      allowed = false
      assert.throws(
        () => tickets.attachable('ticket-revoke', 'tg-revoke'),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'mandateRevoked', '撤销授权必须映射为 mandateRevoked')
          return true
        },
      )
      const row = await readAggregate(sidecar, 'engine_ticket', 'ticket_id', 'ticket-revoke')
      assert.equal((row?.inputs as unknown[]).length, 0, '被拒的调用不得追加 input')
      assert.equal(await countRows(sidecar, 'engine_effect'), 0, '被拒的调用不得排副作用')
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })

  test('§9.12-11 乱序 / 晚到事件：每个事件只处理一次，不重复建档', async () => {
    const { store, board, sidecar, options } = await rig()
    try {
      await reset(sidecar)
      const engine = options(() => ({ revalidate: () => true }))
      const intake = new Intake(engine, new Tickets(engine, new Replies(engine)))
      // 先到一条引导事件建出 thread；再建 Ticket 并订阅，最后按相反顺序投递 t2 / t1。
      assert.equal(intake.receive(trigger('tg-bootstrap')), 'stored')
      store.atomic(() => {
        store.tickets.save(ticket('ticket-order'))
        store.threads.save({ ...(store.threads.get('acceptance:thread-1')!), subscriptions: ['ticket-order'] })
      })

      // 后发生的事件先到（t2），先发生的事件晚到（t1）；再迟到重投 t1。
      assert.equal(intake.receive(trigger('t2', '2026-11-14T02:00:00Z')), 'stored')
      assert.equal(intake.receive(trigger('t1', '2026-11-14T01:00:00Z')), 'stored')
      assert.equal(intake.receive(trigger('t1', '2026-11-14T01:00:00Z')), 'duplicate')

      assert.equal(await countRows(sidecar, 'engine_trigger'), 3, '引导事件 + 两个不同事件共三行，晚到重投不得新增')
      assert.equal(await countRows(sidecar, 'engine_ticket'), 1, '不得因乱序/晚到重复建档')
      const row = await readAggregate(sidecar, 'engine_ticket', 'ticket_id', 'ticket-order')
      const inputs = row?.inputs as { kind: string; triggerId?: string }[]
      const triggerInputs = inputs.filter(input => input.kind === 'trigger')
      assert.equal(triggerInputs.length, 2, '每个事件只扇出一次 Input（共 2 条）')
      assert.deepEqual(
        triggerInputs.map(input => input.triggerId).sort(),
        ['t1', 't2'],
      )
      for (const id of ['t1', 't2']) {
        const disposition = await readAggregate(sidecar, 'engine_disposition', 'disposition_id', id)
        assert.deepEqual(disposition?.fanout, ['ticket-order'], `${id} 的扇出必须恰好一次`)
      }
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })

  test('§9.12-9 外部动作已成功但本地未收到回执：必须对账而不是重复执行（预期红）', async () => {
    const { store, board, sidecar } = await rig()
    try {
      await reset(sidecar)
      // 外部通道替身：第一次调用"确实把消息发出去了"，然后在写回执前抛错（模拟回执丢失/进程崩溃）。
      const wire: string[] = []
      let firstAttempt = true
      const channels = {
        instance: () => ({ enabled: true }),
        channelAllowed: () => true,
        send: async (message: OutboundMessage) => {
          wire.push(message.id)
          if (firstAttempt) {
            firstAttempt = false
            throw new Error('ACK_LOST: external action succeeded but local receipt was not recorded')
          }
          return 'sent' as const
        },
      }

      const effects = new Effects(store, new HealthBoard())
      effects.start()
      const outbox = new Outbox({ store, effects, sources: channels, commands: undefined, paused: () => false })
      outbox.send(outbound('m-ack-lost'))
      await outbox.sent()
      assert.equal(wire.length, 1, '第一次必须真的发出去（模拟外部已成功）')
      assert.equal(outbox.status('m-ack-lost'), 'pending', '本地没有回执：状态必须仍是 pending 而不是假的 sent')

      // 模拟"过了一段时间后重启并重试"：让退避到期，由新进程再派发。
      await makeDueNow(sidecar, 'reply')
      const restarted = new Effects(store, new HealthBoard())
      const outbox2 = new Outbox({ store, effects: restarted, sources: channels, commands: undefined, paused: () => false })
      restarted.start()
      await outbox2.sent()

      // 门槛（§9.12-9 / §11.6-7）：外部副作用不应因丢失回执而重复执行 → 线上只能出现 1 条。
      assert.equal(
        wire.length,
        1,
        `外部动作被执行了 ${wire.length} 次：本地回执丢失后系统直接重发，没有对账/回读，违反"不重复执行"门槛`,
      )
    } finally {
      await reset(sidecar)
      await sidecar.end()
      store.close()
    }
  })
})
