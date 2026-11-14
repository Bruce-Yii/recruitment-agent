// 历史事件 cutover（启动水位）验收：真实 PG（空库 0001→0015 全链重放）上的行为。
//
// 验收点（每条都从库里读回，不看返回值自述）：
//   * 水位之前的事件 → tick 只标 IGNORED（原因 BEFORE_RUNTIME_CUTOVER），
//     不派发、不建 Task、不写唤醒、不加副作用；**事件主体逐列不变**；
//   * 水位之后的事件 → 正常派发（建 Task、标记 ROUTED）；
//   * 水位不能被"随手改小"：直接 UPDATE 被 `WATERMARK_REWIND_FORBIDDEN` 拒绝；
//     改小只能走 `fn_runtime_watermark_rewind`，且必须带 actor + 理由，并留下
//     REWIND 审计行；改小之后**尚未扫过**的历史事件会恢复正常派发；
//   * 审计表 append-only（禁改、禁删）、水位行禁删；
//   * 没有水位行的租户 → tick fail closed（CUTOVER_WATERMARK_MISSING），不猜"现在"；
//   * dry-run 预览只读，且计数与真实 tick 的产物一致。
//
// 为什么每条断言都查库：返回值可以被实现"顺手构造"，而"历史事件没被派发"
// 必须由 business_task / task_wakeup 的真实行数证明（不变量 1：无重复副作用）。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { RuntimeCutoverStore, BEFORE_CUTOVER_REASON_PREFIX } from '../../src/runtime/cutover.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'

let db: RuntimeTestDatabase
let store: RuntimeStore
let runtime: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('cutover')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  runtime = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

/** 当前水位（毫秒）。 */
async function cutoverMs(): Promise<number> {
  const cutover = await store.cutover.read()
  assert.ok(cutover !== null, 'the runtime tenant must have a watermark after 0015')
  return Date.parse(cutover.cutoverAt)
}

/**
 * 直接插一条**指定 received_at** 的事件（`store.insertEvent` 永远用 now()，
 * 造不出"历史"；这里刻意绕过 API 直写库，模拟"运行时上线前已在 Inbox 里"的事实）。
 */
async function insertEventAt(input: {
  readonly receivedAt: Date
  readonly providerEventId: string
  readonly eventType?: string
  readonly payload?: Record<string, unknown>
  readonly normalizerVersion?: string | null
}): Promise<string> {
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox (
       tenant_id, provider, provider_event_id, event_type, idempotency_key,
       payload, trust_level, received_at, recorded_at, normalizer_version
     ) values (
       $1::uuid, 'feishu', $2, $3, $4,
       $5::jsonb, 'UNTRUSTED_EXTERNAL', $6::timestamptz, $6::timestamptz, $7
     ) returning event_id::text`,
    [
      RUNTIME_TENANT,
      input.providerEventId,
      input.eventType ?? EVENT_TYPES.SCORECARD_SUBMIT,
      `feishu:${input.providerEventId}`,
      JSON.stringify(input.payload ?? { interview_id: '55555555-5555-4555-8555-000000000001' }),
      input.receivedAt.toISOString(),
      input.normalizerVersion ?? null,
    ],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId !== undefined, 'insert returned no event id')
  return eventId
}

/**
 * 插一条 `received_at` **恰好等于**当前水位的事件。
 *
 * 为什么要用 SQL 子查询取水位，而不是 `new Date(Date.parse(cutoverAt))`：
 * `runtime_watermark.cutover_at` 是 `timestamptz`（微秒精度），而 JS `Date` 只有
 * 毫秒。用 JS 读回再写进去会丢微秒 → 造出"看起来相等、实际早几百纳秒"的事件，
 * 边界用例会假红。边界的权威比较必须在数据库里做。
 */
async function insertEventAtExactCutover(input: {
  readonly providerEventId: string
  readonly payload: Record<string, unknown>
}): Promise<string> {
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox (
       tenant_id, provider, provider_event_id, event_type, idempotency_key,
       payload, trust_level, received_at, recorded_at, normalizer_version
     )
     select $1::uuid, 'feishu', $2, $3, $4,
            $5::jsonb, 'UNTRUSTED_EXTERNAL', w.cutover_at, w.cutover_at, null
       from recruitment.runtime_watermark w
      where w.tenant_id = $1::uuid
     returning event_id::text`,
    [
      RUNTIME_TENANT,
      input.providerEventId,
      EVENT_TYPES.SCORECARD_SUBMIT,
      `feishu:${input.providerEventId}`,
      JSON.stringify(input.payload),
    ],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId !== undefined, 'insert returned no event id')
  return eventId
}

/** 事件主体列的快照（用于断言"只改 dispatch 投影"）。 */
async function eventBody(eventId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `select provider, provider_event_id, event_type, schema_version,
            occurred_at, received_at, recorded_at, correlation_id, causation_id,
            idempotency_key, idempotency_source, source_object_id, payload_ref,
            payload, trust_level, normalized_event_type, normalizer_version
       from recruitment.event_inbox
      where tenant_id = $1::uuid and event_id = $2::uuid`,
    [RUNTIME_TENANT, eventId],
  )
  assert.ok(rows[0] !== undefined, 'event row disappeared')
  return rows[0]!
}

/** 以 actor 身份在事务里执行一条会失败的写（用来验证 DB 守卫）。 */
async function expectRejected(
  sql: string,
  params: readonly unknown[],
  pattern: RegExp,
): Promise<void> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [RUNTIME_ACTOR])
    await assert.rejects(() => client.query(sql, [...params]), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, pattern)
      return true
    })
  } finally {
    await client.query('rollback').catch(() => {})
    client.release()
  }
}

describe('runtime cutover watermark: bootstrap and fail-closed', () => {
  test('0015 bootstraps a watermark for the runtime tenant: cutover <= now, reason audited as INSERT', async () => {
    const cutover = await store.cutover.read()
    assert.ok(cutover !== null)
    assert.equal(cutover.tenantId, RUNTIME_TENANT)
    assert.ok(Date.parse(cutover.cutoverAt) <= Date.now(), 'bootstrap cutover must not be in the future')
    assert.match(cutover.reason, /BOOTSTRAP 0015/)
    assert.equal(cutover.recordVersion, 1)
    assert.equal(
      await count(
        `select count(*)::text as n
           from recruitment.runtime_watermark_change c
           join recruitment.runtime_watermark w on w.id = c.watermark_id
          where w.tenant_id = $1::uuid and c.change_kind = 'INSERT'`,
        [RUNTIME_TENANT],
      ),
      1,
      'bootstrap must be audited as one INSERT row',
    )
  })

  test('a tenant without a watermark fails closed instead of guessing "now"', async () => {
    const otherTenant = '99999999-9999-4999-8999-000000000001'
    const admin = await db.pool.connect()
    try {
      // 触发器绕行：模拟"该租户的水位从未被声明过"（0015 用组织创建触发器兜底，
      // 正常路径不会出现；这里要证明兜底失效时运行时仍然 fail closed）。
      await admin.query('begin')
      await admin.query("set local session_replication_role = 'replica'")
      await admin.query(
        `insert into recruitment.organization (id, name, timezone)
         values ($1::uuid, '无水位租户', 'Asia/Shanghai')`,
        [otherTenant],
      )
      await admin.query('commit')
    } finally {
      admin.release()
    }
    assert.equal(
      await count('select count(*)::text as n from recruitment.runtime_watermark where tenant_id = $1::uuid', [otherTenant]),
      0,
      'the replica-mode insert must not get a bootstrap watermark',
    )

    const otherStore = new RuntimeStore({ pool: db.pool, tenantId: otherTenant, actorId: RUNTIME_ACTOR })
    const otherRuntime = new EventRuntime({ store: otherStore })
    await assert.rejects(
      () => otherRuntime.processPending(),
      (error: unknown) => {
        assert.match(String((error as Error).message), /CUTOVER_WATERMARK_MISSING/)
        return true
      },
    )
    assert.equal(
      await count('select count(*)::text as n from recruitment.business_task where tenant_id = $1::uuid', [otherTenant]),
      0,
      'fail-closed tick must not create tasks',
    )
  })
})

describe('runtime cutover watermark: history is never dispatched', () => {
  test('an event received before the cutover is IGNORED with BEFORE_RUNTIME_CUTOVER, creates no task', async () => {
    const cut = await cutoverMs()
    const eventId = await insertEventAt({
      // 刚好早于水位 1 秒：边界侧必须判"历史"（< cutover_at）
      receivedAt: new Date(cut - 1000),
      providerEventId: 'cutover-history-1',
      payload: { interview_id: '55555555-5555-4555-8555-000000000002' },
    })
    const beforeBody = await eventBody(eventId)
    const tasksBefore = await count('select count(*)::text as n from recruitment.business_task')
    const wakeupsBefore = await count('select count(*)::text as n from recruitment.task_wakeup')

    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === eventId)
    assert.ok(own !== undefined, 'the historical event must appear in the tick receipt')
    assert.equal(own.outcome, 'stored')
    assert.equal(own.dispatchState, 'IGNORED')
    assert.equal(own.taskId, null)
    assert.equal(own.taskCreated, false)
    assert.equal(own.wakeInserted, false)
    assert.ok(own.reason !== null && own.reason.startsWith(BEFORE_CUTOVER_REASON_PREFIX), `unexpected reason: ${own.reason}`)

    // 库层读回：dispatch 投影变了，业务副作用没有，事件主体没变
    const { rows } = await db.pool.query<Record<string, unknown>>(
      `select dispatch_state, routed_at, processed_at, route_attempts, route_error,
              business_object_type, business_object_id, routed_task_id
         from recruitment.event_inbox
        where tenant_id = $1::uuid and event_id = $2::uuid`,
      [RUNTIME_TENANT, eventId],
    )
    const row = rows[0]!
    assert.equal(row.dispatch_state, 'IGNORED')
    assert.notEqual(row.routed_at, null)
    assert.notEqual(row.processed_at, null)
    assert.equal(Number(row.route_attempts), 1)
    assert.match(String(row.route_error), new RegExp(`^${BEFORE_CUTOVER_REASON_PREFIX}: received_at .* < runtime cutover `))
    assert.equal(row.business_object_type, null)
    assert.equal(row.business_object_id, null)
    assert.equal(row.routed_task_id, null)

    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), tasksBefore)
    assert.equal(await count('select count(*)::text as n from recruitment.task_wakeup'), wakeupsBefore)
    assert.deepEqual(await eventBody(eventId), beforeBody, 'the event body must stay byte-for-byte identical')
  })

  test('sweep is idempotent: a second tick does not touch the already-ignored historical event', async () => {
    const { rows } = await db.pool.query<{ event_id: string; route_attempts: number; route_error: string }>(
      `select event_id::text, route_attempts, route_error
         from recruitment.event_inbox
        where tenant_id = $1::uuid and provider_event_id = 'cutover-history-1'`,
      [RUNTIME_TENANT],
    )
    const before = rows[0]!
    const results = await runtime.processPending()
    assert.equal(results.some((item) => item.eventId === before.event_id), false, 'IGNORED events must not be swept twice')
    const after = await db.pool.query<{ route_attempts: number; route_error: string }>(
      `select route_attempts, route_error from recruitment.event_inbox where event_id = $1::uuid`,
      [before.event_id],
    )
    assert.equal(Number(after.rows[0]!.route_attempts), Number(before.route_attempts))
    assert.equal(after.rows[0]!.route_error, before.route_error)
  })

  test('an event received exactly at the cutover is dispatched normally (task + wakeup + ROUTED)', async () => {
    const tasksBefore = await count('select count(*)::text as n from recruitment.business_task')
    // received_at **恰等于** cutover_at（数据库微秒精度）：边界是 >=，必须派发。
    const eventId = await insertEventAtExactCutover({
      providerEventId: 'cutover-new-1',
      payload: { interview_id: '55555555-5555-4555-8555-000000000003' },
    })
    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === eventId)
    assert.ok(own !== undefined)
    assert.equal(own.dispatchState, 'ROUTED')
    assert.ok(own.taskId !== null)
    assert.equal(own.taskCreated, true)
    assert.equal(own.wakeInserted, true)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), tasksBefore + 1)
    const task = await store.readTask(own.taskId!)
    assert.ok(task !== null)
    assert.equal(task.task.triggerEventId, eventId)
    assert.equal(task.wakeups.length, 1)
  })

  test('row-guard audit events (normalizer_version=schema/0001) stay out of both sweep and dispatch', async () => {
    const cut = await cutoverMs()
    const eventId = await insertEventAt({
      receivedAt: new Date(cut - 60_000),
      providerEventId: 'cutover-rowguard-1',
      // 真实的库触发器事件名（`event-types.ts` 的 ROW_GUARD_TRIGGERS 派生），
      // 不是"随便编一个 status.changed"；它必须既不被扫尾、也不被派发。
      eventType: 'application.lifecycle_status.changed',
      normalizerVersion: 'schema/0001',
      payload: { interview_id: '55555555-5555-4555-8555-000000000004' },
    })
    await runtime.processPending()
    const { rows } = await db.pool.query<{ dispatch_state: string; route_attempts: number }>(
      `select dispatch_state, route_attempts from recruitment.event_inbox where event_id = $1::uuid`,
      [eventId],
    )
    assert.equal(rows[0]!.dispatch_state, 'RECEIVED', 'audit events are not dispatch candidates at all')
    assert.equal(Number(rows[0]!.route_attempts), 0)
  })
})

describe('runtime cutover watermark: "cannot shrink casually" is enforced and audited', () => {
  test('a plain UPDATE that moves the cutover backwards is rejected (WATERMARK_REWIND_FORBIDDEN)', async () => {
    const cutover = (await store.cutover.read())!
    const rewindsBefore = await count(
      `select count(*)::text as n from recruitment.runtime_watermark_change where change_kind = 'REWIND'`,
    )
    await expectRejected(
      `update recruitment.runtime_watermark
          set cutover_at = cutover_at - interval '1 hour',
              reason = 'plain update must not be able to rewind'
        where tenant_id = $1::uuid`,
      [RUNTIME_TENANT],
      /WATERMARK_REWIND_FORBIDDEN/,
    )
    const after = (await store.cutover.read())!
    assert.equal(after.cutoverAt, cutover.cutoverAt, 'a rejected rewind must not change the value')
    assert.equal(after.recordVersion, cutover.recordVersion)
    assert.equal(
      await count(`select count(*)::text as n from recruitment.runtime_watermark_change where change_kind = 'REWIND'`),
      rewindsBefore,
      'a rejected rewind must not leave an audit row',
    )
  })

  test('rewind requires an actor and a non-empty reason before touching the row', async () => {
    const cutover = (await store.cutover.read())!
    // 无 actor：即使调用的是"合法"函数也必须拒绝
    await assert.rejects(
      () => db.pool.query(`select recruitment.fn_runtime_watermark_rewind($1::uuid, now() - interval '2 day', 'no actor')`, [RUNTIME_TENANT]),
      (error: unknown) => {
        assert.match(String((error as Error).message), /ACTOR_REQUIRED/)
        return true
      },
    )
    // 有 actor 但理由为空：拒绝
    await expectRejected(
      `select recruitment.fn_runtime_watermark_rewind($1::uuid, now() - interval '2 day', '   ')`,
      [RUNTIME_TENANT],
      /WATERMARK_REASON_REQUIRED/,
    )
    assert.equal((await store.cutover.read())!.cutoverAt, cutover.cutoverAt)
  })

  test('an explicit rewind is audited (REWIND + reason + actor) and makes not-yet-swept history dispatchable again', async () => {
    const cut = await cutoverMs()
    // 先造一条"当前是历史、但还没被 tick 扫过"的事件（水位回退后它应恢复正常派发）
    const eventId = await insertEventAt({
      receivedAt: new Date(cut - 6 * 60 * 60 * 1000),
      providerEventId: 'cutover-rewind-target-1',
      payload: { interview_id: '55555555-5555-4555-8555-000000000005' },
    })

    const client = await db.pool.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('recruitment.actor_id', $1, true)", [RUNTIME_ACTOR])
      await client.query(
        `select recruitment.fn_runtime_watermark_rewind($1::uuid, now() - interval '2 day', '验收：显式回退以补处理一条历史 intake')`,
        [RUNTIME_TENANT],
      )
      await client.query('commit')
    } finally {
      client.release()
    }

    const rewound = (await store.cutover.read())!
    assert.ok(Date.parse(rewound.cutoverAt) < cut, 'rewind must move the cutover earlier')
    assert.equal(rewound.recordVersion, 2)
    const audit = await db.pool.query<Record<string, unknown>>(
      `select change_kind, old_cutover_at, new_cutover_at, reason, changed_by_actor_id::text as actor
         from recruitment.runtime_watermark_change
        where change_kind = 'REWIND'
        order by changed_at desc limit 1`,
    )
    const row = audit.rows[0]!
    assert.equal(row.change_kind, 'REWIND')
    assert.ok(Date.parse(String(row.new_cutover_at)) < Date.parse(String(row.old_cutover_at)))
    assert.match(String(row.reason), /验收：显式回退/)
    assert.equal(row.actor, RUNTIME_ACTOR)

    // 回退之后，那条之前算历史的事件现在应该正常派发（证明水位是"每次 tick 重新读"的持续约束）
    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === eventId)
    assert.ok(own !== undefined)
    assert.equal(own.dispatchState, 'ROUTED')
    assert.ok(own.taskId !== null)
  })

  test('moving the cutover forward is allowed, audited as FORWARD, and cannot be a no-op', async () => {
    const cutover = (await store.cutover.read())!
    // 上一条用例把水位回退到 2 天前；这里前进到 1 小时前（严格变大且不晚于 now）。
    const target = new Date(Date.now() - 3_600_000).toISOString()
    assert.ok(Date.parse(target) > Date.parse(cutover.cutoverAt), 'forward must be strictly later')
    const client = await db.pool.connect()
    try {
      await client.query('begin')
      await client.query("select set_config('recruitment.actor_id', $1, true)", [RUNTIME_ACTOR])
      await client.query(
        `select recruitment.fn_runtime_watermark_forward($1::uuid, $2::timestamptz, '验收：前进到当前时刻之前')`,
        [RUNTIME_TENANT, target],
      )
      await client.query('commit')
    } finally {
      client.release()
    }
    const moved = (await store.cutover.read())!
    assert.equal(Date.parse(moved.cutoverAt), Date.parse(target))
    assert.equal(moved.recordVersion, cutover.recordVersion + 1)
    assert.equal(
      await count(`select count(*)::text as n from recruitment.runtime_watermark_change where change_kind = 'FORWARD'`),
      1,
    )
    // 同一时间值的第二次"前进"必须被拒绝（WATERMARK_NOT_FORWARD：不允许假调整）
    await expectRejected(
      `select recruitment.fn_runtime_watermark_forward($1::uuid, $2::timestamptz, 'noop')`,
      [RUNTIME_TENANT, target],
      /WATERMARK_NOT_FORWARD/,
    )
  })
})

describe('runtime cutover watermark: audit trail is append-only and dry-run is read-only', () => {
  test('audit rows cannot be modified or deleted, and the watermark row cannot be deleted', async () => {
    const watermarkId = (await store.cutover.read())!
    const auditId = await count(`select count(*)::text as n from recruitment.runtime_watermark_change`)
    assert.ok(auditId > 0)
    await expectRejected(
      `update recruitment.runtime_watermark_change set reason = 'tampered' where watermark_id =
         (select id from recruitment.runtime_watermark where tenant_id = $1::uuid)`,
      [RUNTIME_TENANT],
      /IMMUTABLE_COLUMN/,
    )
    await expectRejected(
      `delete from recruitment.runtime_watermark_change where watermark_id =
         (select id from recruitment.runtime_watermark where tenant_id = $1::uuid)`,
      [RUNTIME_TENANT],
      /DELETE_FORBIDDEN/,
    )
    await expectRejected(
      `delete from recruitment.runtime_watermark where tenant_id = $1::uuid`,
      [RUNTIME_TENANT],
      /DELETE_FORBIDDEN/,
    )
    assert.equal((await store.cutover.read())!.tenantId, watermarkId.tenantId)
  })

  test('dry-run preview reports the same split the real tick then performs', async () => {
    const cut = await cutoverMs()
    const historyId = await insertEventAt({
      receivedAt: new Date(cut - 120_000),
      providerEventId: 'cutover-preview-history-1',
      payload: { interview_id: '55555555-5555-4555-8555-000000000006' },
    })
    const newId = await insertEventAt({
      receivedAt: new Date(cut + 1_000),
      providerEventId: 'cutover-preview-new-1',
      payload: { interview_id: '55555555-5555-4555-8555-000000000007' },
    })

    const previews = new RuntimeCutoverStore({ pool: db.pool, tenantId: RUNTIME_TENANT })
    const preview = await previews.preview(20, 5)
    assert.ok(preview.cutover !== null)
    assert.equal(preview.pendingBeforeCutover, 1, 'exactly one pending event is history')
    assert.equal(preview.pendingAfterCutover, 1, 'exactly one pending event is new')
    const historyRow = preview.byEventType.find((item) => item.beforeCutover === 1)
    assert.ok(historyRow !== undefined)
    assert.equal(historyRow.eventType, EVENT_TYPES.SCORECARD_SUBMIT)

    const results = await runtime.processPending()
    assert.equal(results.find((item) => item.eventId === historyId)?.dispatchState, 'IGNORED')
    assert.equal(results.find((item) => item.eventId === newId)?.dispatchState, 'ROUTED')

    // 再预览：历史那条已经不在待派发集合里，且被单独计数（幂等、不重复算）
    const after = await previews.preview(20, 5)
    assert.equal(after.pendingBeforeCutover, 0)
    assert.equal(after.pendingAfterCutover, 0)
    assert.equal(after.alreadyIgnoredByCutover, 2, 'both swept history events are counted once each')
  })

  test('the sweep never dispatches a semantic-gate-rejected event as ROUTED (dispatch projection only)', async () => {
    // 回归：水位扫尾与语义 Gate 是两条独立路径。历史事件即使"本该被 Gate 拒"，
    // 也只会得到 BEFORE_RUNTIME_CUTOVER，不会因为扫尾而多出 task 行。
    const tasksBefore = await count('select count(*)::text as n from recruitment.business_task')
    const cut = await cutoverMs()
    await insertEventAt({
      receivedAt: new Date(cut - 5000),
      providerEventId: 'cutover-history-unknown-1',
      eventType: 'unclassified.external.signal',
      payload: { text: 'hello' },
    })
    const results = await runtime.processPending()
    const ignored = results.filter((item) => item.reason?.startsWith(BEFORE_CUTOVER_REASON_PREFIX))
    assert.ok(ignored.length >= 1)
    assert.equal(ignored.every((item) => item.taskId === null && item.taskCreated === false), true)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), tasksBefore)
  })
})
