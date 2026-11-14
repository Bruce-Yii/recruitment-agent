// PG 持久化实现（本 lane 自写；替换原型的 app/store.ts SQLite 实现，**方法签名保持一致**）。
// 原文件：dsh-superagent-prototype src/app/store.ts（SQLite / node:sqlite）。这里保留同一组方法与导出名，
// 只把底层换成 PostgreSQL —— 引擎的 `Repositories` 端口是同步的，因此底层走 `pg/bridge.ts` 的同步桥。
//
// 与原实现的差异（逐条列在 VENDORED.md）：
//   1. 构造参数：从 SQLite 文件路径改为 PG 连接配置（方法签名未变，仅构造入口变了）。
//   2. 迁移：不再做 SQLite 10→11 迁移，改为要求 db/migrations/0012_engine_state 已应用，否则构造即报错。
//   3. 表名：所有引擎表加 `engine_` 前缀，落在 `recruitment` schema。
//   4. 读路径：`read`（storeReads 的视图查询）不在本 vendor 子集使用，未实现。
//   5. 失败语义：同步桥超时/worker 失联时抛错，绝不静默返回空结果。
import type {
  ChannelRef, Decision, OutboundMessage, ReplyStatus, Repositories, Thread, Ticket, Trigger, TriggerDisposition,
} from '../core/index.ts'
import { key, threadKey } from '../core/index.ts'
import { SyncPg, type SyncPgConfig } from '../pg/bridge.ts'
import type { HealthEntry } from '../infra/health.ts'

/** A Trigger's position on its thread timeline, ordered by timestamp and then `id` as tie-breaker. */
export interface TimelinePlace { at: string; id: string }
/** Why a message was dropped: its conversation can never receive it (`channelGone`), or its Source no longer listens to it (`channelIgnored`). */
export type DropReason = 'channelGone' | 'channelIgnored'
/** Outbound message receipt tracked in the outbox from the moment it is queued (`pending`, `sent`, or `dropped`); delivery attempt counts live on its `reply` effect. */
export interface Receipt extends OutboundMessage { status: ReplyStatus; dropped?: { at: string; reason: DropReason } }
/** A dropped outbound message receipt, with the timestamp and reason it was dropped. */
export type Dropped = Receipt & { dropped: { at: string; reason: DropReason } }

/** The engine schema version recorded in `engine_kv`; the authoritative migration is db/migrations/0012_engine_state.sql. */
export const SCHEMA_VERSION = 12
/** The migration ledger row this store requires before it will open. */
const REQUIRED_MIGRATION = '0012_engine_state'

/** What the store needs to reach PostgreSQL; the password comes from the caller's resolved config, never from a file. */
export interface StoreConfig extends SyncPgConfig {
  /** Tenant every engine row is stamped with (FK to recruitment.organization). */
  readonly tenant_id: string
}

/** A prepared-statement handle mirroring the SQLite surface `Effects` uses (get / all / run). */
export interface EngineStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
  run(...params: unknown[]): { changes: number }
}

/** The tiny synchronous SQL surface the effect queue drives directly. */
export interface EngineDb {
  prepare(sql: string): EngineStatement
  exec(sql: string): void
}

/** Converts `?` placeholders to PostgreSQL's `$n`, leaving quoted strings untouched. */
function toPg(sql: string): string {
  let index = 0
  let out = ''
  let quoted = false
  for (const character of sql) {
    if (character === "'") quoted = !quoted
    if (character === '?' && !quoted) { index++; out += `$${index}`; continue }
    out += character
  }
  return out
}

/**
 * PostgreSQL backing store implementing the `Repositories` port, key-value state, and the channel outbox.
 * Every engine aggregate is one JSONB row keyed by its domain ID inside the tenant; insertion order is kept by a `seq` column
 * so the list/open/active queries match the SQLite store's `rowid` ordering.
 *
 * All methods are synchronous (the `Repositories` port requires it) and therefore block the host event loop for one PG round
 * trip each: see `pg/bridge.ts` for the measured cost and the timeout/crash behaviour.
 */
export class Store implements Repositories {
  readonly db: EngineDb
  readonly tenantId: string
  private readonly pg: SyncPg
  private readonly report: (error: unknown) => void
  private readonly health: HealthEntry | undefined
  private depth = 0
  private readonly committed: (() => void)[][] = []

  constructor(config: StoreConfig, report: (error: unknown) => void = () => {}, health?: HealthEntry) {
    this.report = report
    this.health = health
    this.tenantId = config.tenant_id
    this.pg = new SyncPg(config)
    this.db = {
      prepare: (sql: string) => {
        const text = toPg(sql)
        return {
          get: (...params: unknown[]) => this.pg.call(text, params).rows[0],
          all: (...params: unknown[]) => this.pg.call(text, params).rows,
          run: (...params: unknown[]) => ({ changes: this.pg.call(text, params).rowCount }),
        }
      },
      exec: (sql: string) => { this.pg.call(sql) },
    }
    try {
      // 迁移没跑就明确报错，不静默降级成空库（R3：缺环境必须红，不能绿成"没跑"）。
      const applied = this.valueRows<{ version: string }>(
        'select version from recruitment.schema_migration where version = $1', [REQUIRED_MIGRATION])
      if (!applied.length) {
        throw new Error(`The engine state schema is missing: apply db/migrations/${REQUIRED_MIGRATION}.sql before starting the engine`)
      }
      this.db.exec(`set statement_timeout = ${Math.trunc(config.statementTimeoutMs ?? 5000)}`)

      this.health?.set({ state: 'ready', detail: `PostgreSQL engine store (tenant ${config.tenant_id})`, at: new Date().toISOString() })
    } catch (error) {
      this.pg.close()
      this.health?.set({ state: 'error', detail: String(error), at: new Date().toISOString() })
      throw error
    }
  }

  /** Runs one statement and returns its rows (text-typed for the read paths that parse JSON aggregates themselves). */
  private valueRows<T>(sql: string, params: readonly unknown[] = []): T[] {
    return this.pg.call(sql, params).rows as T[]
  }

  /** Parses the JSON `value` column of the rows `sql` returns. */
  private values<T>(sql: string, ...parameters: unknown[]): T[] {
    return this.valueRows<{ value: unknown }>(sql, parameters).map(row => row.value as T)
  }

  /** Closes the bridge worker and its connection. */
  close(): void { this.pg.close() }

  /** Health snapshot for panels: the bridge state plus the last failure, if any. */
  healthState(): { state: string; detail: string } {
    const state = this.pg.state
    return { state: state === 'ready' ? 'ready' : state === 'closed' ? 'stopped' : 'error', detail: this.pg.lastError ?? `PG bridge ${state}` }
  }

  /**
   * Executes `operation` in a savepoint transaction (nested inside the current transaction if any); a failure rolls back its changes.
   * Post-commit callbacks run only after the outermost transaction commits, and callback errors are reported without failing the committed transaction.
   */
  atomic<T>(operation: () => T): T {
    const level = this.depth++
    const name = `orchestrator_atomic_${level}`
    this.committed[level] = []
    const outermost = level === 0
    if (outermost) this.pg.call('begin')
    this.pg.call(`savepoint ${name}`)
    let value: T
    try { value = operation(); this.pg.call(`release savepoint ${name}`) }
    catch (error) {
      try { this.pg.call(`rollback to savepoint ${name}`); this.pg.call(`release savepoint ${name}`) } catch { /* 桥已失联时保留第一个错误 */ }
      this.depth--
      if (outermost) { try { this.pg.call('rollback') } catch { /* 同上 */ } }
      throw error
    }
    this.depth--
    if (outermost) this.pg.call('commit')
    const actions = this.committed.splice(level)[0] ?? []
    if (level) this.committed[level - 1]!.push(...actions)
    else for (const action of actions) { try { action() } catch (error) { this.report(error) } }
    return value
  }

  /**
   * Schedules `action` to run once the outermost transaction commits, or immediately if outside a transaction;
   * callbacks queued inside a transaction that rolls back are discarded and never run.
   */
  afterCommit(action: () => void): void {
    if (this.depth) this.committed[this.depth - 1]!.push(action)
    else action()
  }

  /** Reads a typed KV record by its key in `KV`. */
  get<T>(name: string): T | undefined {
    const row = this.db.prepare('select value from recruitment.engine_kv where key = ?').get(name)
    return row === undefined ? undefined : (row.value as T)
  }

  /** Writes a typed KV record under `name`. */
  set<T>(name: string, value: T): void {
    this.db.prepare(`insert into recruitment.engine_kv (tenant_id, key, value) values (?, ?, ?::jsonb)
      on conflict (key) do update set value = excluded.value`).run(this.tenantId, name, JSON.stringify(value))
  }

  /** Deletes the KV record at `name`. */
  delete(name: string): void { this.db.prepare('delete from recruitment.engine_kv where key = ?').run(name) }

  /** Returns all KV keys starting with `prefix` (the key families in the prototype's kv.ts are plain prefixes). */
  keys(prefix: string): string[] {
    const pattern = `${prefix.replace(/[\\%_]/g, match => `\\${match}`)}%`
    return this.valueRows<{ key: string }>("select key from recruitment.engine_kv where key like $1 escape '\\'", [pattern]).map(row => row.key)
  }



  readonly triggers = {
    get: (id: string): Trigger | undefined => this.values<Trigger>('select value from recruitment.engine_trigger where trigger_id = $1', id)[0],
    save: (trigger: Trigger): void => this.atomic(() => {
      this.db.prepare(`insert into recruitment.engine_trigger (tenant_id, trigger_id, value, at) values (?, ?, ?::jsonb, ?)
        on conflict (trigger_id) do update set value = excluded.value, at = excluded.at`)
        .run(this.tenantId, trigger.id, JSON.stringify(trigger), trigger.at)
      this.indexThreads(trigger)
    }),
    disposition: (id: string): TriggerDisposition | undefined =>
      this.values<TriggerDisposition>('select value from recruitment.engine_disposition where disposition_id = $1', id)[0],
    saveDisposition: (id: string, value: TriggerDisposition): void => {
      this.db.prepare(`insert into recruitment.engine_disposition (tenant_id, disposition_id, value) values (?, ?, ?::jsonb)
        on conflict (disposition_id) do update set value = excluded.value`).run(this.tenantId, id, JSON.stringify(value))
    },
  }

  /** Re-indexes which threads a Trigger belongs to, replacing any rows from an earlier save of the same Trigger. */
  private indexThreads(trigger: Trigger): void {
    this.db.prepare('delete from recruitment.engine_trigger_thread where trigger_id = ?').run(trigger.id)
    const insert = this.db.prepare(`insert into recruitment.engine_trigger_thread (tenant_id, thread_key, trigger_id, at, human)
      values (?, ?, ?, ?, ?) on conflict (thread_key, trigger_id) do nothing`)
    for (const ref of trigger.threads) insert.run(this.tenantId, threadKey(ref), trigger.id, trigger.at, trigger.human)
  }

  readonly threads = {
    get: (keyValue: string): Thread | undefined => this.values<Thread>('select value from recruitment.engine_thread where thread_key = $1', keyValue)[0],
    save: (thread: Thread): void => {
      this.db.prepare(`insert into recruitment.engine_thread (tenant_id, thread_key, value) values (?, ?, ?::jsonb)
        on conflict (thread_key) do update set value = excluded.value`).run(this.tenantId, thread.key, JSON.stringify(thread))
    },
    list: (): Thread[] => this.values('select value from recruitment.engine_thread order by seq'),
    active: (): Thread[] => this.values(`select value from recruitment.engine_thread
      where jsonb_array_length(coalesce(value -> 'pending', '[]'::jsonb)) > 0 or value ? 'evaluating' order by seq`),
    /** Updates human-facing thread metadata (`label`, `url`, and `facts`, where `null` removes a fact by ID); no-op if the thread does not exist. */
    describe: (keyValue: string, patch: { label?: string; url?: string; facts?: Record<string, import('../core/index.ts').ThreadFact | null> }): void => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const facts: import('../core/index.ts').ThreadFacts = { ...(thread.meta.facts as import('../core/index.ts').ThreadFacts | undefined) }
      for (const [id, fact] of Object.entries(patch.facts ?? {})) { if (fact) facts[id] = fact; else delete facts[id] }
      const meta = { ...thread.meta, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.url === undefined ? {} : { url: patch.url }), facts }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    },
    /** Atomically sets or removes (`undefined`) source-specific metadata keys on a thread after re-reading it; no-op if the thread does not exist. */
    patchMeta: (keyValue: string, patch: Record<string, unknown>): void => this.atomic(() => {
      const thread = this.threads.get(keyValue)
      if (!thread) return
      const meta = { ...thread.meta }
      for (const [name, value] of Object.entries(patch)) { if (value === undefined) delete meta[name]; else meta[name] = value }
      if (JSON.stringify(meta) !== JSON.stringify(thread.meta)) this.threads.save({ ...thread, meta })
    }),
  }

  readonly tickets = {
    get: (id: string): Ticket | undefined => this.values<Ticket>('select value from recruitment.engine_ticket where ticket_id = $1', id)[0],
    save: (ticket: Ticket): void => {
      this.db.prepare(`insert into recruitment.engine_ticket (tenant_id, ticket_id, value) values (?, ?, ?::jsonb)
        on conflict (ticket_id) do update set value = excluded.value`).run(this.tenantId, ticket.id, JSON.stringify(ticket))
    },
    /** Newest first. */
    list: (): Ticket[] => this.values('select value from recruitment.engine_ticket order by seq desc'),
    /** Newest first. */
    open: (): Ticket[] => this.values("select value from recruitment.engine_ticket where not (value ? 'ended') order by seq desc"),
    /** Newest first. */
    active: (): Ticket[] => this.values(`select value from recruitment.engine_ticket
      where jsonb_array_length(coalesce(value -> 'undelivered', '[]'::jsonb)) > 0
        or (value -> 'assignments' -> -1 ->> 'state') in ('pending', 'running') order by seq desc`),
  }

  readonly decisions = {
    get: (id: string): Decision | undefined => this.values<Decision>('select value from recruitment.engine_decision where decision_id = $1', id)[0],
    save: (decision: Decision): void => {
      this.db.prepare(`insert into recruitment.engine_decision (tenant_id, decision_id, thread_key, value) values (?, ?, ?, ?::jsonb)
        on conflict (decision_id) do update set value = excluded.value, thread_key = excluded.thread_key`)
        .run(this.tenantId, decision.id, decision.threadKey, JSON.stringify(decision))
    },
    byThread: (threadKeyValue: string): Decision[] =>
      this.values('select value from recruitment.engine_decision where thread_key = $1 order by seq', threadKeyValue),
  }

  /** Delivery status of a queued message; receipts are retained permanently so message IDs are idempotent. */
  replyStatus(id: string): ReplyStatus | undefined { return this.receipts.get(id)?.status }

  /** Outbox message receipts for channel delivery; only `Outbox` writes to `receipts`. */
  readonly receipts = {
    get: (id: string): Receipt | undefined => this.values<Receipt>('select value from recruitment.engine_outbox where message_id = $1', id)[0],
    /** Pending message receipts, oldest first. */
    waiting: (): Receipt[] => this.values("select value from recruitment.engine_outbox where value ->> 'status' = 'pending' order by seq"),
    /** True if an earlier message for the same ticket and conversation is still pending with fewer than `failures` consecutive failed `reply` effect attempts. */
    behind: (id: string, failures: number): boolean => this.valueRows('select 1 from recruitment.engine_outbox earlier'
      + ' join recruitment.engine_outbox message on message.message_id = $1'
      + " left join recruitment.engine_effect effect on effect.kind = 'reply' and effect.key = earlier.message_id"
      + ` where (case when earlier.value ->> 'status' = 'pending' and earlier.value ? 'ticketId'
          then (earlier.value ->> 'ticketId') || ' ' || (earlier.value #>> '{channel,thread}') end)
        is not distinct from (case when message.value ->> 'status' = 'pending' and message.value ? 'ticketId'
          then (message.value ->> 'ticketId') || ' ' || (message.value #>> '{channel,thread}') end)
        and earlier.seq < message.seq and coalesce(effect.attempts, 0) < $2 limit 1`, [id, failures]).length > 0,
    /**
     * Records a new pending message receipt; an already-recorded message ID keeps its original receipt.
     * @returns Whether the message ID was newly recorded.
     */
    add: (message: OutboundMessage): boolean => {
      const receipt: Receipt = { ...message, status: 'pending' }
      return this.db.prepare(`insert into recruitment.engine_outbox (tenant_id, message_id, value) values (?, ?, ?::jsonb)
        on conflict (message_id) do nothing`).run(this.tenantId, message.id, JSON.stringify(receipt)).changes > 0
    },
    /**
     * Marks a pending receipt as sent or dropped (with drop reason and timestamp), recreating the receipt if the message
     * was withdrawn while being sent so its ID cannot be queued again.
     */
    settle: (message: OutboundMessage, outcome: 'sent' | DropReason): void => {
      const settled = outcome === 'sent' ? { status: 'sent' } : { status: 'dropped', dropped: { at: new Date().toISOString(), reason: outcome } }
      const { id, channel, text, kind, ticketId } = message
      const updated = this.db.prepare(`update recruitment.engine_outbox set value = value || ?::jsonb
        where message_id = ? and value ->> 'status' = 'pending'`).run(JSON.stringify(settled), id)
      if (!updated.changes) this.db.prepare(`insert into recruitment.engine_outbox (tenant_id, message_id, value) values (?, ?, ?::jsonb)
        on conflict (message_id) do nothing`)
        .run(this.tenantId, id, JSON.stringify({ id, channel, text, kind, ...ticketId ? { ticketId } : {}, ...settled }))
    },
    /**
     * Withdraws a pending message that has not yet been sent.
     * @returns Whether a pending message with `id` was waiting and removed.
     */
    withdraw: (id: string): boolean =>
      this.db.prepare("delete from recruitment.engine_outbox where message_id = ? and value ->> 'status' = 'pending'").run(id).changes > 0,
  }
}

export { key, threadKey }
export type { ChannelRef }
