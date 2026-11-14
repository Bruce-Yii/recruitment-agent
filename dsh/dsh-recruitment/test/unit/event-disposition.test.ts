// G10 事件处置的**纯单元验收**：不连库、不起进程，用假 store / 假 sink 逐条锁死
// `work/verify-2026-11-15-g10/wiring/API-CONTRACT.md` §1/§2 的可观察行为。
//
// 为什么这些断言值得写：处置是审计事实，它错不会让业务表立刻变脏，而是让"已终态"的事件
// 在审计里说谎（或悄悄缺失）。所以这里断言的是**外部可观察事实**：
//   * 终态迁移成功后才写、写什么（映射表逐条）；
//   * 迁移返回 false（并发竞态）/ 重复投递 / 路由失败一律不写，且回执状态来自库；
//   * 写失败不静默：receive 响亮抛错、processPending 不把终态回退成 FAILED、计数可读；
//   * sink 未挂时既有回执**逐字不变**（向后兼容），attach 冲突可机检。
//
// 真 PG 上的唯一约束 / append-only 触发器 / 真水位扫尾见 `test/integration/event-disposition.test.ts`，
// 两者不互相代替（假 store 只能证明"调用顺序与内容对"）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { CutoverSweepHit, RuntimeCutover } from '../../src/runtime/cutover.ts'
import {
  DISPOSITION_RECORD_FAILED,
  DISPOSITION_SINK_CONFLICT,
  EventRuntime,
  type EventDispositionHealth,
  type EventDispositionInput,
  type EventDispositionSink,
} from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import type { EventRow, InsertEventResult, RuntimeStore } from '../../src/runtime/store.ts'
import type { EventReceiveResult, InboundEvent } from '../../src/runtime/types.ts'

/** 与 0002_seed 的演示租户一致（只是字符串，不连库）。 */
const TENANT = '11111111-1111-4111-8111-000000000001'
const INTERVIEW_A = '22222222-2222-4222-8222-000000000001'
const INTERVIEW_B = '22222222-2222-4222-8222-000000000002'
/** 竞态用例里"赢家"路由到的业务对象（与本次尝试的 INTERVIEW_A 不同）。 */
const RACE_OBJECT_ID = '22222222-2222-4222-8222-0000000000ff'

/** 水位行：只用于 processPending 的前置条件（没有水位 → fail closed）。 */
const CUTOVER: RuntimeCutover = {
  tenantId: TENANT,
  cutoverAt: '2026-11-15T00:00:00.000Z',
  reason: 'unit-test cutover watermark',
  recordVersion: 1,
  updatedAt: '2026-11-15T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
//  假 store：结构上满足 EventRuntime 用到的 RuntimeStore 面（不连库）
// ---------------------------------------------------------------------------

/** 记录下来的调用（断言"写了几次 / 参数是什么"）。 */
interface FakeCalls {
  readonly insertEvent: InboundEvent[]
  readonly createOrWakeTask: { readonly eventId: string }[]
  readonly markEventRouted: { readonly eventId: string; readonly taskId: string }[]
  readonly markEventIgnored: { readonly eventId: string; readonly reason: string }[]
  readonly markEventFailed: { readonly eventId: string; readonly code: string; readonly message: string }[]
  sweepBeforeCalls: number
  listPendingCalls: number
}

/** 可逐用例改的行为开关（默认=一次成功的确定性新建 Task）。 */
interface FakeFlags {
  inserted: boolean
  wakeCreated: boolean
  wakeThrows: boolean
  markRouted: boolean
  markIgnored: boolean
  /** markEvent* 返回 false 时，库里"赢家"留下的真实状态。 */
  racedState: EventRow['dispatchState']
  swept: readonly CutoverSweepHit[]
  pending: readonly string[]
}

interface FakeStore {
  readonly store: RuntimeStore
  readonly flags: FakeFlags
  readonly calls: FakeCalls
  readonly rows: Map<string, EventRow>
  /** 直接种一条事件行（processPending 的输入）。 */
  seed(event: InboundEvent, overrides?: Partial<EventRow>): EventRow
}

/** 由 InboundEvent 造一条"库里读回"的事件行。 */
function rowFromInbound(eventId: string, event: InboundEvent): EventRow {
  return {
    eventId,
    provider: event.provider,
    providerEventId: event.providerEventId ?? null,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion ?? 1,
    occurredAt: event.occurredAt ?? null,
    payload: event.payload,
    sourceObjectId: event.sourceObjectId ?? null,
    payloadRef: event.payloadRef ?? null,
    trustLevel: event.trustLevel,
    idempotencyKey: `fake:${event.provider}:${event.providerEventId ?? eventId}`,
    correlationId: null,
    causationId: null,
    dispatchState: 'RECEIVED',
    routeAttempts: 0,
    businessObjectType: null,
    businessObjectId: null,
  }
}

/**
 * 造一个假 store。
 *
 * 为什么用可变 `flags` 而不是给每个用例写一份对象：EventRuntime 只看行为，用例要的是
 * "同一路径不同结果"（新建/唤醒、竞态赢/输、成功/抛错），一份可控替身更能证明这些
 * 分支真的被走到（而不是各造一份永远成功的假 store）。
 */
function createFakeStore(): FakeStore {
  const flags: FakeFlags = {
    inserted: true,
    wakeCreated: true,
    wakeThrows: false,
    markRouted: true,
    markIgnored: true,
    racedState: 'RECEIVED',
    swept: [],
    pending: [],
  }
  const calls: FakeCalls = {
    insertEvent: [],
    createOrWakeTask: [],
    markEventRouted: [],
    markEventIgnored: [],
    markEventFailed: [],
    sweepBeforeCalls: 0,
    listPendingCalls: 0,
  }
  const rows = new Map<string, EventRow>()
  let seq = 0

  /** 终态迁移在假库里的落库效果（与真 store 的 UPDATE 语义一致）。 */
  const applyTerminal = (eventId: string, state: EventRow['dispatchState']): void => {
    const row = rows.get(eventId)
    if (row === undefined) return
    rows.set(eventId, {
      ...row,
      dispatchState: state,
      businessObjectType: state === 'ROUTED' && flags.racedState === 'ROUTED' ? 'INTERVIEW' : row.businessObjectType,
      businessObjectId: state === 'ROUTED' && flags.racedState === 'ROUTED' ? RACE_OBJECT_ID : row.businessObjectId,
    })
  }

  const fake: FakeStore = {
    flags,
    calls,
    rows,
    seed(event: InboundEvent, overrides: Partial<EventRow> = {}): EventRow {
      seq += 1
      const eventId = `event-${seq}`
      const row: EventRow = { ...rowFromInbound(eventId, event), ...overrides }
      rows.set(eventId, row)
      return row
    },
    store: undefined as unknown as RuntimeStore,
  }

  const cutover = {
    async read(): Promise<RuntimeCutover | null> {
      return CUTOVER
    },
    async sweepBefore(): Promise<readonly CutoverSweepHit[]> {
      calls.sweepBeforeCalls += 1
      return flags.swept
    },
  }

  fake.store = {
    tenant: TENANT,
    cutover,
    async insertEvent(event: InboundEvent): Promise<InsertEventResult> {
      calls.insertEvent.push(event)
      if (!flags.inserted) {
        // 重复投递：返回已存在的那一行（不新增行）。
        const existing = [...rows.values()][0]
        assert.ok(existing !== undefined, 'duplicate case must seed the existing row first')
        return {
          eventId: existing.eventId,
          inserted: false,
          dispatchState: existing.dispatchState,
          routedTaskId: 'task-existing',
        }
      }
      const row = fake.seed(event)
      return { eventId: row.eventId, inserted: true, dispatchState: row.dispatchState, routedTaskId: null }
    },
    async getEvent(eventId: string): Promise<EventRow | null> {
      return rows.get(eventId) ?? null
    },
    async intakeRecordIdForEvent(): Promise<string | null> {
      // 本文件的用例都走 payload 里带对象 id / 已登记 IGNORED / 未登记语义三条路径。
      return null
    },
    async markEventRouted(eventId: string, taskId: string): Promise<boolean> {
      calls.markEventRouted.push({ eventId, taskId })
      if (!flags.markRouted) {
        applyTerminal(eventId, flags.racedState)
        return false
      }
      applyTerminal(eventId, 'ROUTED')
      return true
    },
    async markEventIgnored(eventId: string, reason: string): Promise<boolean> {
      calls.markEventIgnored.push({ eventId, reason })
      if (!flags.markIgnored) {
        applyTerminal(eventId, flags.racedState)
        return false
      }
      applyTerminal(eventId, 'IGNORED')
      return true
    },
    async markEventFailed(eventId: string, code: string, message: string): Promise<boolean> {
      calls.markEventFailed.push({ eventId, code, message })
      applyTerminal(eventId, 'FAILED')
      return true
    },
    async createOrWakeTask(input: { readonly eventId: string }): Promise<{
      taskId: string
      created: boolean
      wakeInserted: boolean
      wakeSeq: number | null
    }> {
      calls.createOrWakeTask.push({ eventId: input.eventId })
      if (flags.wakeThrows) throw new Error('injected createOrWakeTask failure')
      return {
        taskId: `task-${input.eventId}`,
        created: flags.wakeCreated,
        wakeInserted: true,
        wakeSeq: 1,
      }
    },
    async listPendingEvents(): Promise<readonly string[]> {
      calls.listPendingCalls += 1
      return flags.pending
    },
  } as unknown as RuntimeStore

  return fake
}

// ---------------------------------------------------------------------------
//  假 sink：记录每次写入，并可按次数注入失败
// ---------------------------------------------------------------------------

interface FakeSink {
  readonly sink: EventDispositionSink
  readonly attempts: EventDispositionInput[]
  readonly records: EventDispositionInput[]
  failNext: number
  failMessage: string
  readonly healthValue: EventDispositionHealth
  healthCalls: number
}

/** 造一个假 sink（records = 真正落库成功的行；attempts = 所有尝试）。 */
function createFakeSink(healthValue: Partial<EventDispositionHealth> = {}): FakeSink {
  const fake: FakeSink = {
    attempts: [],
    records: [],
    failNext: 0,
    failMessage: 'sink exploded',
    healthValue: {
      eventsTotal: 7,
      eventsInternalAudit: 2,
      eventsInScope: 5,
      eventsDisposed: 3,
      eventsDisposedInScope: 3,
      eventsUndisposed: 2,
      eventsUndisposedOldestWaitSeconds: 42,
      eventsUndisposedOldestReceivedAt: '2026-11-15T00:00:00.000Z',
      ...healthValue,
    },
    healthCalls: 0,
    sink: undefined as unknown as EventDispositionSink,
  }
  fake.sink = {
    async record(input: EventDispositionInput): Promise<boolean> {
      fake.attempts.push(input)
      if (fake.failNext > 0) {
        fake.failNext -= 1
        throw new Error(fake.failMessage)
      }
      fake.records.push(input)
      return true
    },
    async health(): Promise<EventDispositionHealth> {
      fake.healthCalls += 1
      return fake.healthValue
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
//  事件构造（名字一律取自 src/runtime/event-types.ts 的注册表）
// ---------------------------------------------------------------------------

/**
 * 断言 error.message 以稳定前缀开头。
 *
 * 为什么不用 `new RegExp('^PREFIX: ')`：`assert.throws/rejects` 的正则匹配的是
 * `String(error)`（= `"<name>: <message>"`），不是 message 本身——那会把"前缀是稳定 code"
 * 误判成失败。这里显式只看 message。
 */
function errorMessageStartsWith(prefix: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error, `expected an Error, got: ${String(error)}`)
    assert.ok(
      error.message.startsWith(prefix),
      `expected error.message to start with ${JSON.stringify(prefix)}, got: ${error.message}`,
    )
    return true
  }
}

/** 确定性事件：`scorecard.submit`（payload 带 interview_id → INTERVIEW 对象）。 */
function scorecardEvent(providerEventId: string, interviewId: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    occurredAt: '2026-11-15T00:00:00.000Z',
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  }
}

/** 语义事件：未登记 + INTERNAL + payload.intent → 过 Gate，建 ROUTER_TRIAGE。 */
function semanticEvent(providerEventId: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'internal',
    providerEventId,
    eventType: 'semantic.department_headcount_change',
    payload: { intent: 'headcount change in dept A' },
    trustLevel: 'INTERNAL',
  }
}

/** 被语义 Gate 拒绝的外部事件（reason 以 SEMANTIC_GATE_REJECTED 开头）。 */
function rejectedExternalEvent(providerEventId: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'feishu',
    providerEventId,
    eventType: 'unclassified.external.signal',
    payload: { text: 'hello' },
    trustLevel: 'UNTRUSTED_EXTERNAL',
  }
}

/** 已登记为 IGNORED 的内部事件（`decision.record` → REGISTERED_IGNORED）。 */
function registeredIgnoredEvent(providerEventId: string): InboundEvent {
  return {
    tenantId: TENANT,
    provider: 'internal',
    providerEventId,
    eventType: EVENT_TYPES.DECISION_RECORD,
    payload: { application_id: INTERVIEW_A },
    trustLevel: 'INTERNAL',
  }
}

/** 一条历史扫尾命中（processPending 的 cutover 路径）。 */
const HISTORY_HIT: CutoverSweepHit = {
  eventId: 'event-history-1',
  eventType: EVENT_TYPES.SCORECARD_SUBMIT,
  receivedAt: '2026-11-14T00:00:00.000Z',
  reason: 'BEFORE_RUNTIME_CUTOVER: received_at 2026-11-14 < runtime cutover 2026-11-15; not dispatched',
}

// ---------------------------------------------------------------------------
//  §2 映射表：三种路由 × 原因码
// ---------------------------------------------------------------------------

describe('event disposition: 终态迁移成功后才写，映射表逐条', () => {
  test('确定性路由且新建 Task → FANNED_OUT / TASK_CREATED / [真实 taskId]', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })

    const result = await runtime.receive(scorecardEvent('evt-created', INTERVIEW_A))

    assert.deepEqual(result, {
      outcome: 'stored',
      eventId: 'event-1',
      dispatchState: 'ROUTED',
      taskId: 'task-event-1',
      taskCreated: true,
      wakeInserted: true,
      businessObject: { type: 'INTERVIEW', id: INTERVIEW_A },
      reason: null,
    })
    assert.deepEqual(sink.attempts, [{
      eventId: 'event-1',
      disposition: 'FANNED_OUT',
      reasonCode: 'TASK_CREATED',
      targetTaskIds: ['task-event-1'],
    }])
    assert.equal(sink.records.length, 1, 'exactly one disposition row is written')
    assert.equal(fake.calls.markEventRouted.length, 1)
  })

  test('确定性路由且唤醒已有 Task → FANNED_OUT / TASK_WOKEN / [同一个 taskId]', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    fake.flags.wakeCreated = false

    const result = await runtime.receive(scorecardEvent('evt-woken', INTERVIEW_A))

    assert.equal(result.dispatchState, 'ROUTED')
    assert.equal(result.taskCreated, false, 'waking an existing task is not a creation')
    assert.equal(result.wakeInserted, true)
    assert.deepEqual(sink.attempts, [{
      eventId: result.eventId,
      disposition: 'FANNED_OUT',
      reasonCode: 'TASK_WOKEN',
      targetTaskIds: [result.taskId],
    }])
  })

  test('语义准入 → EVALUATED / SEMANTIC_ROUTE / []（评估不是扇出）', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })

    const result = await runtime.receive(semanticEvent('evt-semantic'))

    assert.equal(result.dispatchState, 'ROUTED')
    assert.equal(result.taskCreated, true)
    assert.equal(result.businessObject, null, 'semantic admission has no business object')
    assert.match(result.reason ?? '', /payload\.intent supplied/, 'admission came from the deterministic gate')
    assert.deepEqual(sink.attempts, [{
      eventId: result.eventId,
      disposition: 'EVALUATED',
      reasonCode: 'SEMANTIC_ROUTE',
      targetTaskIds: [],
    }])
  })

  test('被语义 Gate 拒绝 → FILTERED / SEMANTIC_GATE_REJECTED / []', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })

    const result = await runtime.receive(rejectedExternalEvent('feishu-evt-rejected'))

    assert.equal(result.dispatchState, 'IGNORED')
    assert.match(result.reason ?? '', /^SEMANTIC_GATE_REJECTED: /)
    assert.equal(fake.calls.markEventIgnored.length, 1)
    assert.deepEqual(sink.attempts, [{
      eventId: result.eventId,
      disposition: 'FILTERED',
      reasonCode: 'SEMANTIC_GATE_REJECTED',
      targetTaskIds: [],
    }])
  })

  test('其他 ignored（REGISTERED_IGNORED 等）→ FILTERED / ROUTE_IGNORED / []', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })

    const result = await runtime.receive(registeredIgnoredEvent('decision-evt-1'))

    assert.equal(result.dispatchState, 'IGNORED')
    assert.match(result.reason ?? '', /^REGISTERED_IGNORED: /)
    assert.deepEqual(sink.attempts, [{
      eventId: result.eventId,
      disposition: 'FILTERED',
      reasonCode: 'ROUTE_IGNORED',
      targetTaskIds: [],
    }])
  })
})

// ---------------------------------------------------------------------------
//  §2 不写的情形：重复投递 / 路由失败 / 并发竞态
// ---------------------------------------------------------------------------

describe('event disposition: 不该写的三条路径一个字都不写', () => {
  test('重复投递（outcome=duplicate）不写处置、不重新路由', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    fake.seed(scorecardEvent('evt-dup', INTERVIEW_A), {
      dispatchState: 'ROUTED',
      businessObjectType: 'INTERVIEW',
      businessObjectId: INTERVIEW_A,
    })
    fake.flags.inserted = false

    const result = await runtime.receive(scorecardEvent('evt-dup', INTERVIEW_A))

    assert.equal(result.outcome, 'duplicate')
    assert.equal(result.taskCreated, false)
    assert.equal(result.wakeInserted, false)
    assert.equal(fake.calls.markEventRouted.length, 0, 'a duplicate must not be re-routed')
    assert.equal(sink.attempts.length, 0, 'a duplicate must not write a fake disposition')
  })

  test('路由失败（createOrWakeTask 抛错）→ 标 FAILED、不写处置', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    const row = fake.seed(scorecardEvent('evt-route-boom', INTERVIEW_A))
    fake.flags.wakeThrows = true
    fake.flags.pending = [row.eventId]

    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === row.eventId)

    assert.ok(own !== undefined, 'the failed event must appear in the tick receipt')
    assert.equal(own.dispatchState, 'FAILED')
    assert.match(own.reason ?? '', /injected createOrWakeTask failure/)
    assert.deepEqual(fake.calls.markEventFailed, [{
      eventId: row.eventId,
      code: 'RUNTIME_ERROR',
      message: 'injected createOrWakeTask failure',
    }])
    assert.equal(sink.attempts.length, 0, 'FAILED is not a terminal routing state: never write a disposition')
    assert.equal((await runtime.dispositionHealth())!.writeFailures, 0)
  })

  test('markEventRouted 返回 false（并发竞态）→ 不写，回执状态来自库里的赢家', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    fake.flags.markRouted = false
    fake.flags.racedState = 'IGNORED'

    const result = await runtime.receive(scorecardEvent('evt-race-routed', INTERVIEW_A))

    assert.equal(result.dispatchState, 'IGNORED', 'the loser receipt must report the winner state, not its own intent')
    assert.equal(result.taskId, null)
    assert.equal(result.taskCreated, false)
    assert.equal(result.reason, null, 'route_error belongs to the winner; the loser must not invent a reason')
    assert.equal(fake.calls.markEventRouted.length, 1, 'the transition was attempted once')
    assert.equal(sink.attempts.length, 0, 'the losing attempt must not write a disposition')
  })

  test('markEventIgnored 返回 false（并发竞态）→ 不写，回执业务对象来自库', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    fake.flags.markIgnored = false
    fake.flags.racedState = 'ROUTED'

    const result = await runtime.receive(registeredIgnoredEvent('decision-evt-race'))

    assert.equal(result.dispatchState, 'ROUTED')
    assert.equal(result.taskId, null)
    assert.deepEqual(result.businessObject, { type: 'INTERVIEW', id: RACE_OBJECT_ID })
    assert.equal(fake.calls.markEventIgnored.length, 1)
    assert.equal(sink.attempts.length, 0)
  })
})

// ---------------------------------------------------------------------------
//  §2 cutover 扫尾（processPending 的历史事件）
// ---------------------------------------------------------------------------

describe('event disposition: cutover 扫尾', () => {
  test('sweepBefore 返回的每一条都写 FILTERED / BEFORE_RUNTIME_CUTOVER / []', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    fake.flags.swept = [HISTORY_HIT]

    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === HISTORY_HIT.eventId)

    assert.ok(own !== undefined)
    assert.equal(own.dispatchState, 'IGNORED')
    assert.equal(own.reason, HISTORY_HIT.reason, 'the receipt keeps the cutover reason on the happy path')
    assert.equal(fake.calls.sweepBeforeCalls, 1)
    assert.deepEqual(sink.attempts, [{
      eventId: HISTORY_HIT.eventId,
      disposition: 'FILTERED',
      reasonCode: 'BEFORE_RUNTIME_CUTOVER',
      targetTaskIds: [],
    }])
  })
})

// ---------------------------------------------------------------------------
//  §1 未挂 sink：既有行为逐字不变（向后兼容）
// ---------------------------------------------------------------------------

describe('event disposition: 未挂 sink 时既有回执逐字不变', () => {
  test('receive 的确定性回执与 dispositionHealth()=null', async () => {
    const fake = createFakeStore()
    const runtime = new EventRuntime({ store: fake.store })

    const result = await runtime.receive(scorecardEvent('evt-no-sink', INTERVIEW_A))

    assert.deepEqual(result, {
      outcome: 'stored',
      eventId: 'event-1',
      dispatchState: 'ROUTED',
      taskId: 'task-event-1',
      taskCreated: true,
      wakeInserted: true,
      businessObject: { type: 'INTERVIEW', id: INTERVIEW_A },
      reason: null,
    })
    assert.equal(await runtime.dispositionHealth(), null, 'unattached sink must be reported as null, never as zeroed counts')
  })

  test('processPending 的扫尾回执与未挂 sink 时完全一致', async () => {
    const fake = createFakeStore()
    const runtime = new EventRuntime({ store: fake.store })
    fake.flags.swept = [HISTORY_HIT]

    const results = await runtime.processPending()

    assert.deepEqual(results, [{
      outcome: 'stored',
      eventId: HISTORY_HIT.eventId,
      dispatchState: 'IGNORED',
      taskId: null,
      taskCreated: false,
      wakeInserted: false,
      businessObject: null,
      reason: HISTORY_HIT.reason,
    }])
  })
})

// ---------------------------------------------------------------------------
//  §1 attachDispositionSink / dispositionHealth
// ---------------------------------------------------------------------------

describe('event disposition: sink 挂载与健康度', () => {
  test('同一对象重复挂载 = no-op；不同对象 → DISPOSITION_SINK_CONFLICT', async () => {
    const fake = createFakeStore()
    const a = createFakeSink()
    const b = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store })

    runtime.attachDispositionSink(a.sink)
    runtime.attachDispositionSink(a.sink)
    assert.throws(
      () => runtime.attachDispositionSink(b.sink),
      errorMessageStartsWith(`${DISPOSITION_SINK_CONFLICT}: `),
      'a different sink must be rejected, not silently swapped',
    )

    await runtime.receive(scorecardEvent('evt-attach', INTERVIEW_A))
    assert.equal(a.records.length, 1, 'the first attached sink keeps writing')
    assert.equal(b.records.length, 0, 'the rejected sink must never receive a write')
  })

  test('构造时注入的 sink 也算已挂：attach 同一对象 no-op，不同对象抛冲突', () => {
    const fake = createFakeStore()
    const a = createFakeSink()
    const b = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: a.sink })

    runtime.attachDispositionSink(a.sink)
    assert.throws(
      () => runtime.attachDispositionSink(b.sink),
      errorMessageStartsWith(`${DISPOSITION_SINK_CONFLICT}: `),
    )
  })

  test('dispositionHealth 透传库事实并附上进程内写失败计数', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink({ eventsTotal: 20, eventsUndisposed: 0, eventsUndisposedOldestWaitSeconds: null, eventsUndisposedOldestReceivedAt: null })
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })

    const health = await runtime.dispositionHealth()

    assert.deepEqual(health, {
      eventsTotal: 20,
      eventsInternalAudit: 2,
      eventsInScope: 5,
      eventsDisposed: 3,
      eventsDisposedInScope: 3,
      eventsUndisposed: 0,
      eventsUndisposedOldestWaitSeconds: null,
      eventsUndisposedOldestReceivedAt: null,
      writeFailures: 0,
      lastWriteError: null,
    })
    assert.equal(sink.healthCalls, 1, 'health must be a library fact read, not process self-reporting')
  })
})

// ---------------------------------------------------------------------------
//  §2 写失败语义（冻结）：receive 抛 / processPending 不回退 / 计数可读
// ---------------------------------------------------------------------------

describe('event disposition: 处置写失败不静默', () => {
  test('receive 写失败 → 抛 DISPOSITION_RECORD_FAILED，writeFailures/lastWriteError 可读', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    sink.failNext = 1

    await assert.rejects(
      () => runtime.receive(scorecardEvent('evt-write-boom', INTERVIEW_A)),
      errorMessageStartsWith(`${DISPOSITION_RECORD_FAILED}: `),
    )

    assert.equal(sink.attempts.length, 1, 'the write was attempted')
    assert.equal(sink.records.length, 0, 'nothing was persisted')
    const health = await runtime.dispositionHealth()
    assert.ok(health !== null)
    assert.equal(health.writeFailures, 1)
    assert.equal(health.lastWriteError, 'sink exploded')
  })

  test('processPending 写失败 → 不回退成 FAILED，回执 reason 带前缀', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    const row = fake.seed(scorecardEvent('evt-pending-write-boom', INTERVIEW_A))
    fake.flags.pending = [row.eventId]
    sink.failNext = 1

    const results = await runtime.processPending()
    const own = results.find((item) => item.eventId === row.eventId)

    assert.ok(own !== undefined)
    assert.equal(own.dispatchState, 'ROUTED', 'the terminal transition is already committed; it must not be rolled back')
    assert.equal(own.taskCreated, true)
    assert.match(own.reason ?? '', new RegExp(`^${DISPOSITION_RECORD_FAILED}: `))
    assert.equal(fake.calls.markEventFailed.length, 0, 'a terminal event must never be marked FAILED because its audit write failed')
    assert.equal((await runtime.dispositionHealth())!.writeFailures, 1)
  })

  test('多次写失败累加计数，lastWriteError 截断到 300 字', async () => {
    const fake = createFakeStore()
    const sink = createFakeSink()
    const runtime = new EventRuntime({ store: fake.store, dispositions: sink.sink })
    sink.failMessage = 'x'.repeat(500)
    sink.failNext = 2

    await assert.rejects(() => runtime.receive(scorecardEvent('evt-boom-1', INTERVIEW_A)), errorMessageStartsWith(`${DISPOSITION_RECORD_FAILED}: `))
    await assert.rejects(() => runtime.receive(scorecardEvent('evt-boom-2', INTERVIEW_B)), errorMessageStartsWith(`${DISPOSITION_RECORD_FAILED}: `))

    const health = await runtime.dispositionHealth()
    assert.ok(health !== null)
    assert.equal(health.writeFailures, 2)
    assert.equal(health.lastWriteError?.length, 300, 'lastWriteError must be truncated to 300 chars')
  })
})
