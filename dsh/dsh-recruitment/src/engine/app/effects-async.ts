// 持久副作用的「写半边」异步接口（本 lane 自写；不是 vendor）。
//
// 为什么需要它：`src/runtime/**` 的持久化是**异步**的（`withActor`/`withReadOnly` + `DatabaseClient`），
// 而 vendor 进来的 `Effects`/`Outbox` 建在**同步** `Store` 端口上（引擎命令需要同步事务）。
// 两者不能直接拼在一起：同步桥有自己的连接，无法加入 runtime 的异步事务。
//
// 切分方式（Notion 04 §08 + 总控裁决）：
//   * 任务身份与执行 → `src/runtime/**`（已接线、有真实证据）；
//   * 持久副作用（队列/回执/对账）→ 本目录的 `Effects`/`Outbox`/`Passes`；
//   * **交界**：runtime 在自己的异步事务里，用本文件把副作用**原子地**写进同一批表；
//     派发与对账由持有同步桥的一方（插件进程）用 `Effects`/`Outbox` 完成。
//
// 这样崩溃窗口是零：业务写入与副作用入队同一个 PG 事务；派发进程重启后从表里继续。
//
// 表：`recruitment.engine_effect`（队列）与 `recruitment.engine_outbox`（回执），与同步侧完全同一套。
import type { OutboundMessage } from '../core/index.ts'
import type { EffectKind, EffectPayloads } from './effects.ts'

/** runtime 侧的最小异步查询面（`pg.PoolClient` / `pg.Client` / `withActor` 的 client 都满足）。 */
export interface AsyncEffectClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>
}

/** 入队一条副作用；与调用方的业务写入同事务（必须在同一个 `DatabaseClient` 上调用）。 */
export interface EnqueueEffectInput<K extends EffectKind = EffectKind> {
  readonly tenantId: string
  readonly kind: K
  readonly key: string
  readonly payload: EffectPayloads[K]
  /** 何时可派发（epoch ms）；缺省立即。 */
  readonly dueMs?: number
}

/**
 * 队列序号的分配用 PG 事务级 advisory lock 串行化，避免"插件进程 + runtime 进程"同时写时拿重号。
 * `seq` 只影响同类内派发先后，不影响唯一性（唯一性是 `(kind, key)`）。
 */
const SEQ_LOCK = 'engine_effect_seq'

/**
 * 把一条副作用写进队列（与业务写入同事务）。
 *
 * 语义与同步侧 `Effects.enqueue` 一致：同 `(kind, key)` 的等待行被**覆盖**（payload 更新、generation+1、
 * attempts 归零、error 清空、due 刷新），从而保持队列位置与"最新 payload 生效"。
 */
export async function enqueueEffect<K extends EffectKind>(client: AsyncEffectClient, input: EnqueueEffectInput<K>): Promise<void> {
  const now = Date.now()
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [SEQ_LOCK])
  const seq = await client.query('select coalesce(max(seq), 0) + 1 as next from recruitment.engine_effect')
  const next = Number((seq.rows[0] as { next: string | number }).next)
  await client.query(
    `insert into recruitment.engine_effect
       (tenant_id, kind, key, value, seq, due, since)
     values ($1, $2, $3, $4::jsonb, $5, $6, to_timestamp($7 / 1000.0))
     on conflict (kind, key) do update set
       value = excluded.value,
       generation = recruitment.engine_effect.generation + 1,
       attempts = 0,
       error = '',
       due = excluded.due`,
    [input.tenantId, input.kind, input.key, JSON.stringify(input.payload), next, input.dueMs ?? now, now],
  )
}

/** 登记一条出站消息回执并同事务入队 `reply` effect；同一 `message_id` 重复登记不产生第二条。 */
export interface RecordOutboundInput {
  readonly tenantId: string
  readonly message: OutboundMessage
}

/**
 * 返回是否**新**登记（false = 该 message_id 已有回执，按幂等忽略）。
 * 与同步侧 `Outbox.send` 等价，只是接收调用方的事务。
 */
export async function recordOutbound(client: AsyncEffectClient, input: RecordOutboundInput): Promise<boolean> {
  const { tenantId, message } = input
  const receipt = JSON.stringify({ ...message, status: 'pending' })
  const inserted = await client.query(
    `insert into recruitment.engine_outbox (tenant_id, message_id, value)
     values ($1, $2, $3::jsonb)
     on conflict (message_id) do nothing`,
    [tenantId, message.id, receipt],
  )
  if ((inserted.rowCount ?? 0) === 0) return false
  await enqueueEffect(client, { tenantId, kind: 'reply', key: message.id, payload: {} as EffectPayloads['reply'] })
  return true
}

/** 读一条出站回执的当前状态（runtime 想确认"这条消息到底发出去没有"时用；对账走 Outbox.lookup）。 */
export async function readReceipt(client: AsyncEffectClient, messageId: string): Promise<Record<string, unknown> | undefined> {
  const result = await client.query('select value from recruitment.engine_outbox where message_id = $1', [messageId])
  return (result.rows[0] as { value?: Record<string, unknown> } | undefined)?.value
}
