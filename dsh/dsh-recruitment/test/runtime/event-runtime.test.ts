// 事件运行时验收：真实 PG（空库 0001→0011）上的幂等、唤醒、业务对象定位与两条路径。
//
// 每条断言都从库里读回行数/状态，不看返回值自述：
//   * 同一 provider 事件投递两次 → 1 个 Business Task、1 条唤醒、1 行 Event Inbox；
//   * 同一业务对象的新事件 → 同一 Task ID、wake_count+1，而不是第二个 Task；
//   * 同一 provider_event_id 换幂等键 → 库层唯一索引拦住（inserted=false）；
//   * 未登记的外部事件 → IGNORED，不建 Task（语义准入未放宽）；
//   * 已登记为 IGNORED 的内部事件 → IGNORED + REGISTERED_IGNORED（不是"落到 Gate"）；
//   * 语义准入 → ROUTER_TRIAGE / WAITING_HUMAN，且不进入自动派发队列。
//
// 事件名一律从 `src/runtime/event-types.ts` 取：手写事件名的测试曾经让"路由成功"
// 只在测试里成立（`resume_received` 没有任何发射方）。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeError } from '../../src/runtime/errors.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import type { InboundEvent } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'

/** 一个稳定的 INTERVIEW 形状 id（business_refs 是 JSONB，不做外键）。 */
const DEMO_INTERVIEW = '22222222-2222-4222-8222-000000000002'
/** 一个稳定的 APPLICATION 形状 id（只用于"payload 有对象 id 也明确不触发"的证据）。 */
const DEMO_APPLICATION = '22222222-2222-4222-8222-000000000001'

let db: RuntimeTestDatabase
let store: RuntimeStore
let runtime: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('event')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  runtime = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/**
 * 基线事件：`scorecard.submit`（INTERNAL，工具真实发射的名字；payload 带 interview_id）。
 *
 * 为什么不用 `resume_submitted` 这类"看着合理"的名字：注册表里没有的名字就是没有
 * 发射方的名字，用它做基线等于把测试与生产脱钩。
 */
function scorecardEvent(providerEventId: string, interviewId = DEMO_INTERVIEW, payloadHash = 'a'.repeat(64)): InboundEvent {
  return {
    tenantId: RUNTIME_TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    occurredAt: '2026-11-14T10:00:00.000Z',
    payload: { interview_id: interviewId, payload_hash: payloadHash },
    trustLevel: 'INTERNAL',
  }
}

async function count(sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

describe('event runtime: idempotency and business-object routing', () => {
  test('same provider event delivered twice → 1 task, 1 wakeup, 1 inbox row, 0 duplicate side effects', async () => {
    const first = await runtime.receive(scorecardEvent('evt-0001'))
    assert.equal(first.outcome, 'stored')
    assert.equal(first.dispatchState, 'ROUTED')
    assert.equal(first.taskCreated, true)
    assert.equal(first.wakeInserted, true)
    assert.deepEqual(first.businessObject, { type: 'INTERVIEW', id: DEMO_INTERVIEW })

    const second = await runtime.receive(scorecardEvent('evt-0001'))
    assert.equal(second.outcome, 'duplicate')
    assert.equal(second.taskId, first.taskId)
    assert.equal(second.taskCreated, false)
    assert.equal(second.wakeInserted, false)

    // 断言行数（不只看返回值）
    assert.equal(await count("select count(*)::text as n from recruitment.event_inbox where provider_event_id like 'evt-%'"), 1)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), 1)
    assert.equal(await count('select count(*)::text as n from recruitment.task_wakeup'), 1)
    assert.equal(await count('select count(*)::text as n from recruitment.task_attempt'), 0)
    const task = await store.readTask(first.taskId!)
    assert.ok(task !== null)
    assert.equal(task.task.wakeCount, 1)
    assert.equal(task.wakeups.length, 1)
    assert.equal(task.task.triggerEventId, first.eventId)
    assert.equal(task.task.lastWakeEventId, first.eventId)
  })

  test('a new event for the same business object wakes the same task (no second task, wake_count +1)', async () => {
    const beforeTasks = await count('select count(*)::text as n from recruitment.business_task')
    const result = await runtime.receive({
      ...scorecardEvent('evt-0002'),
      payload: { interview_id: DEMO_INTERVIEW, payload_hash: 'b'.repeat(64) },
    })
    assert.equal(result.outcome, 'stored')
    assert.equal(result.taskCreated, false)
    assert.equal(result.wakeInserted, true)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), beforeTasks)
    const task = await store.readTask(result.taskId!)
    assert.equal(task!.task.wakeCount, 2)
    assert.equal(task!.wakeups.length, 2)
    assert.equal(task!.wakeups[1]!.wakeSeq, 2)
    assert.equal(task!.task.lastWakeEventId, result.eventId)
    // 同一业务对象的 Task 幂等键稳定：重试不会换 ID
    assert.match(task!.task.idempotencyKey, /^task:EVALUATION_SYNTHESIZE:INTERVIEW:/)
  })

  test('provider_event_id uniqueness holds even when a different idempotency key is supplied', async () => {
    const before = await count("select count(*)::text as n from recruitment.event_inbox where provider_event_id = 'evt-0001'")
    const duplicate = await store.insertEvent(scorecardEvent('evt-0001'), {
      key: 'attacker:different-key',
      source: 'PROVIDER_EVENT_ID',
    })
    assert.equal(duplicate.inserted, false, 'same provider event id must not insert a second row')
    assert.equal(await count("select count(*)::text as n from recruitment.event_inbox where provider_event_id = 'evt-0001'"), before)
  })

  test('unknown external event is IGNORED with a readable reason and creates no task', async () => {
    const beforeTasks = await count('select count(*)::text as n from recruitment.business_task')
    const result = await runtime.receive({
      tenantId: RUNTIME_TENANT,
      provider: 'feishu',
      providerEventId: 'feishu-evt-unknown-1',
      eventType: 'unclassified.external.signal',
      payload: { text: 'hello' },
      trustLevel: 'UNTRUSTED_EXTERNAL',
    })
    assert.equal(result.dispatchState, 'IGNORED')
    assert.equal(result.taskId, null)
    assert.match(result.reason ?? '', /SEMANTIC_GATE_REJECTED/)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), beforeTasks)
    assert.equal(
      await count("select count(*)::text as n from recruitment.event_inbox where provider_event_id = 'feishu-evt-unknown-1' and dispatch_state = 'IGNORED'"),
      1,
    )
  })

  test('internal semantic event creates ROUTER_TRIAGE/WAITING_HUMAN and is not auto-dispatched', async () => {
    const result = await runtime.receive({
      tenantId: RUNTIME_TENANT,
      provider: 'internal',
      providerEventId: 'internal-semantic-1',
      eventType: 'semantic.organization_change',
      payload: { intent: 'headcount change in dept A' },
      trustLevel: 'INTERNAL',
    })
    assert.equal(result.dispatchState, 'ROUTED')
    assert.equal(result.taskCreated, true)
    const view = await store.readTask(result.taskId!)
    assert.equal(view!.task.taskType, 'ROUTER_TRIAGE')
    assert.equal(view!.task.status, 'WAITING_HUMAN')
    // 自动派发只认 PENDING/READY/RETRY_WAIT，排除 ROUTER_TRIAGE；语义任务不在其中。
    assert.equal(
      await count("select count(*)::text as n from recruitment.business_task where task_type = 'ROUTER_TRIAGE' and status in ('PENDING','READY','RETRY_WAIT')"),
      0,
      'semantic triage must not be auto-dispatched to a worker',
    )
  })

  test('a registered-but-IGNORED internal event is explicitly ignored, not swallowed by the semantic gate', async () => {
    // `decision.record` 是工具真实发射的事件，注册表里裁决为 IGNORED（人工决策已落库，
    // 没有后续自动任务）。它**必须**给出 REGISTERED_IGNORED 原因，而不是落进语义 Gate
    // ——"表里没有所以被 Gate 拒掉"是不可审计的隐式行为（旧缺陷的隐身方式）。
    const beforeTasks = await count('select count(*)::text as n from recruitment.business_task')
    const result = await runtime.receive({
      tenantId: RUNTIME_TENANT,
      provider: 'internal',
      providerEventId: 'decision-evt-0001',
      eventType: EVENT_TYPES.DECISION_RECORD,
      payload: { application_id: DEMO_APPLICATION },
      trustLevel: 'INTERNAL',
    })
    assert.equal(result.dispatchState, 'IGNORED')
    assert.equal(result.taskId, null)
    assert.match(result.reason ?? '', /^REGISTERED_IGNORED: /)
    assert.doesNotMatch(result.reason ?? '', /SEMANTIC_GATE_REJECTED/)
    assert.equal(await count('select count(*)::text as n from recruitment.business_task'), beforeTasks)
    // 审计可读：原因逐字落进 event_inbox.route_error。
    assert.equal(
      await count("select count(*)::text as n from recruitment.event_inbox where event_type = $1 and dispatch_state = 'IGNORED' and route_error like 'REGISTERED_IGNORED:%'", [EVENT_TYPES.DECISION_RECORD]),
      1,
    )
  })

  test('fallback idempotency key requires a real source object and dedupes identical fallback events', async () => {
    const interviewId = '44444444-4444-4444-8444-000000000001'
    const base: InboundEvent = {
      tenantId: RUNTIME_TENANT,
      provider: 'internal',
      providerEventId: null,
      eventType: EVENT_TYPES.SCORECARD_SUBMIT,
      payload: { interview_id: interviewId },
      sourceObjectId: interviewId,
      trustLevel: 'INTERNAL',
    }
    const a = await runtime.receive(base)
    assert.equal(a.outcome, 'stored')
    assert.equal(a.dispatchState, 'ROUTED')
    const b = await runtime.receive(base)
    assert.equal(b.outcome, 'duplicate')
    assert.equal(await count("select count(*)::text as n from recruitment.event_inbox where source_object_id = '44444444-4444-4444-8444-000000000001' and idempotency_source = 'FALLBACK_KEY'"), 1)
  })

  test('envelope validation rejects tenant mismatch and fallback without source object', async () => {
    await assert.rejects(
      () => runtime.receive({ ...scorecardEvent('evt-bad-tenant'), tenantId: '99999999-9999-4999-8999-999999999999' }),
      (error: unknown) => error instanceof RuntimeError && error.code === 'INVALID_EVENT',
    )
    await assert.rejects(
      () => runtime.receive({
        tenantId: RUNTIME_TENANT,
        provider: 'internal',
        providerEventId: null,
        eventType: EVENT_TYPES.SCORECARD_SUBMIT,
        payload: {},
        trustLevel: 'INTERNAL',
      }),
      (error: unknown) => error instanceof RuntimeError && error.code === 'INVALID_EVENT',
    )
    assert.equal(await count("select count(*)::text as n from recruitment.event_inbox where provider = 'internal' and event_type = $1 and provider_event_id is null and source_object_id is null", [EVENT_TYPES.SCORECARD_SUBMIT]), 0)
  })
})
