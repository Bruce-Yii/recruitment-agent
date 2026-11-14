// G10 事件处置的**真 PG 集成验收**：每个测试文件独占一个一次性空库（0001→0016 全链
// 重放，绝不碰共享的 ra_s6s7）。
//
// 为什么必须是真库（而不是把单测的假 store 断言放大）：本 lane 的验收点是**跨事务的
// 审计事实 + 数据库守卫**，假 store 证明不了：
//   * `event_disposition` 的唯一约束 / FK / append-only 触发器（update、delete 必须被拒）；
//   * "终态迁移 + 处置写入是两个事务"时负例长什么样（路由失败 → dispatch FAILED 且 0 处置行）；
//   * cutover 扫尾（真 `runtime_watermark` + 真 `received_at`）的 FILTERED 处置；
//   * health() 的计数与 raw SQL 读回逐字段一致（最老等待只能由真时间产生）。
// 所有断言都从库里 raw SQL 读回（pg 直连），不看返回值自述；psql 独立读回由 C 子代理做。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import {
  createPgEventDispositionSink,
  EventRuntime,
  type EventDispositionHealth,
} from '../../src/runtime/event-runtime.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from '../runtime/db.ts'

/** 各用例各用一个业务对象，避免 Task 幂等键互相唤醒（scorecard.submit 按对象稳定）。 */
const INTERVIEW_A = '22222222-2222-4222-8222-0000000000a1'
const INTERVIEW_B = '22222222-2222-4222-8222-0000000000b2'
const INTERVIEW_C = '22222222-2222-4222-8222-0000000000c3'
const INTERVIEW_D = '22222222-2222-4222-8222-0000000000d4'
const INTERVIEW_E = '22222222-2222-4222-8222-0000000000e5'
const INTERVIEW_F = '22222222-2222-4222-8222-0000000000f6'
const INTERVIEW_G = '22222222-2222-4222-8222-0000000000a7'

let db: RuntimeTestDatabase
let store: RuntimeStore
let sink: ReturnType<typeof createPgEventDispositionSink>
let runtime: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('eventdisp')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  sink = createPgEventDispositionSink(db.pool, RUNTIME_TENANT)
  runtime = new EventRuntime({ store, dispositions: sink })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  raw SQL 读回（不 import 产品读取代码；SQL 是测试自己的）
// ---------------------------------------------------------------------------

/** 数一行（`::text` 读回再 Number）。 */
async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

/** `event_disposition` 一行的原始事实（jsonb 由 pg 解析成 JS 值）。 */
interface RawDisposition {
  readonly tenant_id: string
  readonly disposition: string
  readonly reason_code: string
  readonly decided_at: Date
  readonly target_task_ids: unknown
  readonly created_at: Date
}

/** raw SQL 读一条处置（没有 → null）。 */
async function rawDisposition(eventId: string): Promise<RawDisposition | null> {
  const { rows } = await db.pool.query<RawDisposition>(
    `select tenant_id::text as tenant_id, disposition, reason_code, decided_at,
            target_task_ids, created_at
       from recruitment.event_disposition
      where event_id = $1::uuid`,
    [eventId],
  )
  return rows[0] ?? null
}

/** `event_inbox` 的 dispatch 投影事实（用来证明处置与路由回执自洽）。 */
interface RawEventState {
  readonly dispatch_state: string
  readonly routed_task_id: string | null
  readonly business_object_type: string | null
  readonly business_object_id: string | null
  readonly route_error: string | null
  readonly route_attempts: number
}

/** raw SQL 读一条事件的 dispatch 投影。 */
async function rawEventState(eventId: string): Promise<RawEventState> {
  const { rows } = await db.pool.query<RawEventState>(
    `select dispatch_state, routed_task_id::text as routed_task_id,
            business_object_type, business_object_id, route_error, route_attempts
       from recruitment.event_inbox
      where tenant_id = $1::uuid and event_id = $2::uuid`,
    [RUNTIME_TENANT, eventId],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `event ${eventId} disappeared`)
  return row
}

// ---------------------------------------------------------------------------
//  事件构造 / 直写库（造"运行时上线前就在 Inbox 里"或"本轮 tick 会取到"的事实）
// ---------------------------------------------------------------------------

/** 确定性事件：`scorecard.submit`（payload 带 interview_id → INTERVIEW 对象）。 */
function scorecardEvent(providerEventId: string, interviewId: string): InboundEvent {
  return {
    tenantId: RUNTIME_TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    occurredAt: '2026-11-15T00:00:00.000Z',
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  }
}

/**
 * 直接插一条**指定 received_at** 的事件（store.insertEvent 永远用 now()，造不出历史）。
 * @param input - 事件 id / 入库时间 / 可选类型与 payload。
 * @returns event_id。
 */
async function insertRawEvent(input: {
  readonly providerEventId: string
  readonly receivedAt: Date
  readonly eventType?: string
  readonly payload?: Record<string, unknown>
  readonly normalizerVersion?: string | null
}): Promise<string> {
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox (
       tenant_id, provider, provider_event_id, event_type, idempotency_key,
       payload, trust_level, received_at, recorded_at, normalizer_version
     ) values (
       $1::uuid, 'internal', $2, $3, $4,
       $5::jsonb, 'INTERNAL', $6::timestamptz, $6::timestamptz, $7
     ) returning event_id::text`,
    [
      RUNTIME_TENANT,
      input.providerEventId,
      input.eventType ?? EVENT_TYPES.SCORECARD_SUBMIT,
      `internal:${input.providerEventId}`,
      JSON.stringify(input.payload ?? { interview_id: INTERVIEW_F }),
      input.receivedAt.toISOString(),
      input.normalizerVersion ?? null,
    ],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId !== undefined, 'raw event insert returned no event_id')
  return eventId
}

/**
 * 注入路由失败：只对**指定事件**让 createOrWakeTask 抛错，其它调用原样委托真 store。
 *
 * 为什么用 Proxy 而不是改 store.ts：store 不在本 lane 写范围；Proxy 只替换一个方法，
 * 其余（cutover / listPendingEvents / getEvent / markEventFailed）仍走真实现——负例证明
 * 的是"路由失败路径不写假处置"，不是"假 store 的行为"。
 * @param base - 真 RuntimeStore。
 * @param eventId - 要注入失败的事件。
 * @returns 结构上仍是 RuntimeStore 的包装。
 */
function storeThrowingFor(base: RuntimeStore, eventId: string): RuntimeStore {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'createOrWakeTask') {
        return async (input: Parameters<RuntimeStore['createOrWakeTask']>[0]) => {
          if (input.eventId === eventId) throw new Error('INJECTED_CREATE_OR_WAKE_FAILURE')
          return target.createOrWakeTask(input)
        }
      }
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as RuntimeStore
}

// ---------------------------------------------------------------------------
//  §2 映射表（真写行 + raw SQL 读回）
// ---------------------------------------------------------------------------

describe('event disposition (PG): 终态后真写一行', () => {
  test('确定性路由新建 Task → FANNED_OUT / TASK_CREATED / [真实 taskId]（raw SQL 读回）', async () => {
    const result = await runtime.receive(scorecardEvent('g10-evt-created-1', INTERVIEW_A))
    assert.equal(result.outcome, 'stored')
    assert.equal(result.dispatchState, 'ROUTED')
    assert.equal(result.taskCreated, true)
    assert.ok(result.taskId !== null)

    const row = await rawDisposition(result.eventId)
    assert.ok(row !== null, 'a terminal event must have exactly one disposition row')
    assert.equal(row.tenant_id, RUNTIME_TENANT)
    assert.equal(row.disposition, 'FANNED_OUT')
    assert.equal(row.reason_code, 'TASK_CREATED')
    assert.deepEqual(row.target_task_ids, [result.taskId], 'target_task_ids must carry the real task id')
    assert.ok(row.decided_at instanceof Date && Number.isFinite(row.decided_at.getTime()), 'decided_at must be a DB timestamp')
    assert.ok(Math.abs(Date.now() - row.decided_at.getTime()) < 300_000, 'decided_at must be DB now(), not a fixed value')

    // 处置与路由回执自洽：事件行自己也是 ROUTED + 同一个 routed_task_id。
    const event = await rawEventState(result.eventId)
    assert.equal(event.dispatch_state, 'ROUTED')
    assert.equal(event.routed_task_id, result.taskId)
    assert.equal(
      await count('select count(*)::text as n from recruitment.event_disposition where event_id = $1::uuid', [result.eventId]),
      1,
      'the unique constraint allows exactly one row per event',
    )
  })

  test('同一 provider 事件重复投递 → 仍只有 1 行，decided_at / reason_code / targets 全部不变', async () => {
    const first = await runtime.receive(scorecardEvent('g10-evt-idem-1', INTERVIEW_B))
    const before = await rawDisposition(first.eventId)
    assert.ok(before !== null)

    const second = await runtime.receive(scorecardEvent('g10-evt-idem-1', INTERVIEW_B))
    assert.equal(second.outcome, 'duplicate')
    assert.equal(second.eventId, first.eventId)

    const after = await rawDisposition(first.eventId)
    assert.ok(after !== null)
    assert.equal(after.decided_at.getTime(), before.decided_at.getTime(), 'a duplicate must not rewrite decided_at')
    assert.equal(after.reason_code, before.reason_code)
    assert.deepEqual(after.target_task_ids, before.target_task_ids)
    assert.equal(
      await count('select count(*)::text as n from recruitment.event_disposition where event_id = $1::uuid', [first.eventId]),
      1,
    )
  })

  test('同一业务对象的第二个事件 → FANNED_OUT / TASK_WOKEN / [同一个 taskId]', async () => {
    const first = await runtime.receive(scorecardEvent('g10-evt-wake-1', INTERVIEW_C))
    assert.equal(first.taskCreated, true)
    const second = await runtime.receive(scorecardEvent('g10-evt-wake-2', INTERVIEW_C))
    assert.equal(second.taskCreated, false, 'the second event wakes the existing task')
    assert.equal(second.taskId, first.taskId, 'the task id is stable per business object')

    const row = await rawDisposition(second.eventId)
    assert.ok(row !== null)
    assert.equal(row.disposition, 'FANNED_OUT')
    assert.equal(row.reason_code, 'TASK_WOKEN')
    assert.deepEqual(row.target_task_ids, [first.taskId])

    // 库里确实只有一条 Task（不是每事件一条）。
    assert.equal(
      await count(
        'select count(*)::text as n from recruitment.business_task where id = $1::uuid',
        [first.taskId],
      ),
      1,
    )
  })

  test('sink.record 对同一 event 幂等：返回 false 且不覆盖任何列', async () => {
    const created = await runtime.receive(scorecardEvent('g10-evt-record-conflict', INTERVIEW_D))
    const before = await rawDisposition(created.eventId)
    assert.ok(before !== null)

    const inserted = await sink.record({
      eventId: created.eventId,
      disposition: 'FILTERED',
      reasonCode: 'ROUTE_IGNORED',
      targetTaskIds: [],
    })
    assert.equal(inserted, false, 'on conflict (event_id) do nothing must report "already exists"')

    const after = await rawDisposition(created.eventId)
    assert.ok(after !== null)
    assert.equal(after.disposition, before.disposition, 'a conflicting insert must never overwrite')
    assert.equal(after.reason_code, before.reason_code)
    assert.deepEqual(after.target_task_ids, before.target_task_ids)
    assert.equal(after.decided_at.getTime(), before.decided_at.getTime())
  })
})

// ---------------------------------------------------------------------------
//  0016 append-only 守卫（负例：update / delete 必须被拒且行不变）
// ---------------------------------------------------------------------------

describe('event disposition (PG): append-only 触发器', () => {
  test('update 被 EVENT_DISPOSITION_IMMUTABLE 拒绝（SQLSTATE P0001），行内容与行数不变', async () => {
    const created = await runtime.receive(scorecardEvent('g10-evt-immutable-1', INTERVIEW_E))
    const before = await rawDisposition(created.eventId)
    assert.ok(before !== null)
    const rowsBefore = await count('select count(*)::text as n from recruitment.event_disposition where tenant_id = $1::uuid', [RUNTIME_TENANT])

    await assert.rejects(
      () => db.pool.query(
        `update recruitment.event_disposition set reason_code = 'DUPLICATE_EVENT' where event_id = $1::uuid`,
        [created.eventId],
      ),
      (error: unknown) => {
        const pgError = error as { readonly code?: string; readonly message?: string }
        assert.equal(pgError.code, 'P0001', 'the immutable trigger raises a plpgsql exception')
        assert.match(String(pgError.message), /EVENT_DISPOSITION_IMMUTABLE: event_disposition 是 append-only 审计表，禁止 UPDATE/)
        return true
      },
    )

    const after = await rawDisposition(created.eventId)
    assert.ok(after !== null)
    assert.equal(after.reason_code, before.reason_code, 'the rejected update must not change the row')
    assert.equal(
      await count('select count(*)::text as n from recruitment.event_disposition where tenant_id = $1::uuid', [RUNTIME_TENANT]),
      rowsBefore,
    )
  })

  test('delete 被 DELETE_FORBIDDEN 拒绝（SQLSTATE 23514），行数不变', async () => {
    const created = await runtime.receive(scorecardEvent('g10-evt-immutable-2', INTERVIEW_E))
    const rowsBefore = await count('select count(*)::text as n from recruitment.event_disposition where tenant_id = $1::uuid', [RUNTIME_TENANT])

    await assert.rejects(
      () => db.pool.query('delete from recruitment.event_disposition where event_id = $1::uuid', [created.eventId]),
      (error: unknown) => {
        const pgError = error as { readonly code?: string; readonly message?: string }
        assert.equal(pgError.code, '23514', 'fn_block_delete raises check_violation (23514)')
        assert.match(String(pgError.message), /DELETE_FORBIDDEN: recruitment\.event_disposition 是历史事实，不允许物理删除/)
        return true
      },
    )

    assert.ok(await rawDisposition(created.eventId) !== null, 'the row must still be there')
    assert.equal(
      await count('select count(*)::text as n from recruitment.event_disposition where tenant_id = $1::uuid', [RUNTIME_TENANT]),
      rowsBefore,
    )
  })
})

// ---------------------------------------------------------------------------
//  §2 负例：路由失败（真 store + 注入 createOrWakeTask 抛错）→ FAILED 且 0 处置行
// ---------------------------------------------------------------------------

describe('event disposition (PG): 路由失败不写假处置', () => {
  test('注入 createOrWakeTask 抛错 → 该事件 dispatch_state=FAILED，处置行 0', async () => {
    const eventId = await insertRawEvent({
      providerEventId: 'g10-evt-injected-fail-1',
      receivedAt: new Date(),
      payload: { interview_id: INTERVIEW_G },
    })
    const failingRuntime = new EventRuntime({ store: storeThrowingFor(store, eventId), dispositions: sink })

    const results = await failingRuntime.processPending()
    const own = results.find((item) => item.eventId === eventId)
    assert.ok(own !== undefined, 'the failing event must appear in the tick receipt')
    assert.equal(own.dispatchState, 'FAILED')
    assert.equal(own.taskId, null)

    // 库层读回：FAILED 是"可重试"，不是终态；处置一行都不许有。
    const event = await rawEventState(eventId)
    assert.equal(event.dispatch_state, 'FAILED')
    assert.match(String(event.route_error), /^RUNTIME_ERROR: INJECTED_CREATE_OR_WAKE_FAILURE/)
    assert.equal(event.routed_task_id, null)
    assert.equal(
      await count('select count(*)::text as n from recruitment.event_disposition where event_id = $1::uuid', [eventId]),
      0,
      'a FAILED routing attempt must not write a disposition',
    )
  })
})

// ---------------------------------------------------------------------------
//  §2 cutover 扫尾（真水位 + 真 received_at）
// ---------------------------------------------------------------------------

describe('event disposition (PG): cutover 扫尾写 BEFORE_RUNTIME_CUTOVER', () => {
  test('received_at 早于水位的事件 → FILTERED / BEFORE_RUNTIME_CUTOVER / []（不建 Task）', async () => {
    const cutover = await store.cutover.read()
    assert.ok(cutover !== null, '0015 must bootstrap a watermark for the demo tenant')
    const historicalId = await insertRawEvent({
      providerEventId: 'g10-evt-history-1',
      receivedAt: new Date(Date.parse(cutover.cutoverAt) - 60_000),
      payload: { interview_id: INTERVIEW_F },
    })

    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === historicalId)
    assert.ok(own !== undefined, 'the historical event must appear in the tick receipt')
    assert.equal(own.dispatchState, 'IGNORED')
    assert.match(String(own.reason), /^BEFORE_RUNTIME_CUTOVER: received_at /)

    const row = await rawDisposition(historicalId)
    assert.ok(row !== null)
    assert.equal(row.disposition, 'FILTERED')
    assert.equal(row.reason_code, 'BEFORE_RUNTIME_CUTOVER')
    assert.deepEqual(row.target_task_ids, [], 'a cutover-swept event fans out to no task')

    const event = await rawEventState(historicalId)
    assert.equal(event.dispatch_state, 'IGNORED')
    assert.equal(event.routed_task_id, null, 'history is never dispatched')
  })
})

// ---------------------------------------------------------------------------
//  §3 health()：与独立 raw SQL 逐字段一致
// ---------------------------------------------------------------------------

describe('event disposition (PG): health 与 raw SQL 一致', () => {
  test('计数 / 最老等待与独立 raw SQL 读回一致（含 internal audit 与 undisposed 两态）', async () => {
    // 造出"三类事件同时存在"的可判别状态：
    //   * 一条库触发器审计事实（normalizer_version='schema/0001'）→ 只计 internal audit；
    //   * 一条 in-scope 的 RECEIVED 事件（不派发）→ 计入 undisposed 与最老等待。
    await insertRawEvent({
      providerEventId: 'g10-evt-audit-1',
      receivedAt: new Date(),
      eventType: 'job.status.changed',
      normalizerVersion: 'schema/0001',
      payload: {},
    })
    const waitingId = await insertRawEvent({
      providerEventId: 'g10-evt-waiting-1',
      receivedAt: new Date(),
      payload: { interview_id: INTERVIEW_F },
    })

    const health = await runtime.dispositionHealth()
    assert.ok(health !== null, 'the sink is attached in this file: health must not be null')

    // ---- 独立 raw SQL（不复用产品 health SQL；逐项自己算）----
    const scope = `(e.normalizer_version is distinct from 'schema/0001'
                    or e.event_type like 'semantic.%'
                    or e.event_type like 'router.%')`
    const oldest = await db.pool.query<{ wait_seconds: string | null; received_at: string | null }>(
      `select floor(extract(epoch from (now() - min(e.received_at))))::text as wait_seconds,
              to_char(min(e.received_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at
         from recruitment.event_inbox e
        where e.tenant_id = $1::uuid and ${scope}
          and not exists (
            select 1 from recruitment.event_disposition d
             where d.tenant_id = $1::uuid and d.event_id = e.event_id)`,
      [RUNTIME_TENANT],
    )
    const oldestRow = oldest.rows[0]!
    const raw: EventDispositionHealth = {
      eventsTotal: await count(
        'select count(*)::text as n from recruitment.event_inbox e where e.tenant_id = $1::uuid',
        [RUNTIME_TENANT],
      ),
      eventsInternalAudit: await count(
        `select count(*)::text as n from recruitment.event_inbox e
          where e.tenant_id = $1::uuid and not ${scope}`,
        [RUNTIME_TENANT],
      ),
      eventsInScope: await count(
        `select count(*)::text as n from recruitment.event_inbox e
          where e.tenant_id = $1::uuid and ${scope}`,
        [RUNTIME_TENANT],
      ),
      eventsDisposed: await count(
        'select count(*)::text as n from recruitment.event_disposition where tenant_id = $1::uuid',
        [RUNTIME_TENANT],
      ),
      eventsDisposedInScope: await count(
        `select count(*)::text as n
           from recruitment.event_inbox e
           join recruitment.event_disposition d
             on d.tenant_id = $1::uuid and d.event_id = e.event_id
          where e.tenant_id = $1::uuid and ${scope}`,
        [RUNTIME_TENANT],
      ),
      eventsUndisposed: await count(
        `select count(*)::text as n
           from recruitment.event_inbox e
          where e.tenant_id = $1::uuid and ${scope}
            and not exists (
              select 1 from recruitment.event_disposition d
               where d.tenant_id = $1::uuid and d.event_id = e.event_id)`,
        [RUNTIME_TENANT],
      ),
      eventsUndisposedOldestWaitSeconds: oldestRow.wait_seconds === null ? null : Number(oldestRow.wait_seconds),
      eventsUndisposedOldestReceivedAt: oldestRow.received_at === null ? null : String(oldestRow.received_at),
    }

    assert.deepEqual(
      {
        eventsTotal: health.eventsTotal,
        eventsInternalAudit: health.eventsInternalAudit,
        eventsInScope: health.eventsInScope,
        eventsDisposed: health.eventsDisposed,
        eventsDisposedInScope: health.eventsDisposedInScope,
        eventsUndisposed: health.eventsUndisposed,
      },
      {
        eventsTotal: raw.eventsTotal,
        eventsInternalAudit: raw.eventsInternalAudit,
        eventsInScope: raw.eventsInScope,
        eventsDisposed: raw.eventsDisposed,
        eventsDisposedInScope: raw.eventsDisposedInScope,
        eventsUndisposed: raw.eventsUndisposed,
      },
      'every count must match an independent raw SQL read',
    )
    assert.equal(
      health.eventsUndisposedOldestReceivedAt,
      raw.eventsUndisposedOldestReceivedAt,
      'oldest_received_at is the precise cross-check (seconds drift with wall clock)',
    )
    assert.ok(health.eventsUndisposedOldestWaitSeconds !== null)
    assert.ok(
      Math.abs(health.eventsUndisposedOldestWaitSeconds - (raw.eventsUndisposedOldestWaitSeconds ?? 0)) <= 2,
      'oldest wait seconds must agree within 2s (two reads at slightly different wall-clock times)',
    )

    // 分区恒等式（health 自身必须自洽）：
    //   total = internal_audit + in_scope；in_scope = disposed_in_scope + undisposed
    assert.equal(health.eventsTotal, health.eventsInternalAudit + health.eventsInScope)
    assert.equal(health.eventsInScope, health.eventsDisposedInScope + health.eventsUndisposed)

    // 本文件造出来的 in-scope 未处置事件必须真的被看见（否则"0 积压"只是空库假象）。
    assert.ok(health.eventsUndisposed >= 1, 'the deliberately waiting event must be counted as undisposed')
    assert.ok(
      await count(
        'select count(*)::text as n from recruitment.event_disposition where event_id = $1::uuid',
        [waitingId],
      ) === 0,
      'the waiting event must not have a disposition row',
    )
    assert.ok(health.eventsInternalAudit >= 1, 'the schema/0001 audit fact must be reported transparently, not hidden')
    assert.equal(health.writeFailures, 0, 'no injected write failure happened in this file')
    assert.equal(health.lastWriteError, null)
  })
})
