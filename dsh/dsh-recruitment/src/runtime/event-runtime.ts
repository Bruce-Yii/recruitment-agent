// 事件运行时：事件到达 → 验源 → 幂等去重 → 定位业务对象 → 创建/唤醒 Business Task。
//
// 实现 Notion `04` §10 的十一步标准执行里**属于 Event Intake 的前五步**：
//   1. 接收并验证来源；
//   2. 标准化 + 定位业务对象；
//   3. 用来源事件 ID / 幂等键去重，保存 Event Inbox 事实；
//   4. 按事件类型选择确定性路径或语义准入 Gate；
//   5. 创建或唤醒稳定身份的 Business Task（需要执行时由 Router 建 Attempt）。
//
// 两条硬边界（本文件刻意不做的事）：
//   * **不在事件线程里做重活**：不下载转写、不跑 LLM、不调外部 API；只落事实 +
//     建/唤醒 Task（Notion §10 转写链路的逐字要求）。
//   * **语义准入不自动执行**：语义事件只创建 `ROUTER_TRIAGE` 任务，等待 Router
//     判断是否需要授权 / Mandate；本运行时不会把它派给 Worker。
import { isUuidText } from '../db/pool.ts'
import { RuntimeError, runtimeFailure } from './errors.ts'
import { decideRoute, idempotencyFor, DefaultSemanticGate } from './routing.ts'
import type { EventRow, RuntimeStore } from './store.ts'
import type { BusinessObjectRef, EventReceiveResult, InboundEvent } from './types.ts'

/** 事件运行时的配置。 */
export interface EventRuntimeOptions {
  readonly store: RuntimeStore
  /** 语义准入 Gate（默认 DefaultSemanticGate；可注入测试用的确定性 Gate）。 */
  readonly semanticGate?: DefaultSemanticGate
  /** 单轮最多重放多少条待路由事件（默认 20）。 */
  readonly pendingBatchSize?: number
  /** 单条事件最多重试路由几次（默认 5）。 */
  readonly maxRouteAttempts?: number
}

/** 把库里的行还原成 InboundEvent（重放待路由事件用）。 */
export function eventRowToInbound(row: EventRow, tenantId: string): InboundEvent {
  return {
    tenantId,
    provider: row.provider,
    providerEventId: row.providerEventId,
    eventType: row.eventType,
    schemaVersion: row.schemaVersion,
    occurredAt: row.occurredAt,
    payload: row.payload,
    sourceObjectId: row.sourceObjectId,
    payloadRef: row.payloadRef,
    trustLevel: row.trustLevel,
    idempotencyKey: row.idempotencyKey,
    correlationId: row.correlationId,
    causationId: row.causationId,
  }
}

/**
 * 校验进站事件 envelope。
 *
 * 不合法的事件**不落库**（否则 Inbox 会被垃圾行污染），直接抛 INVALID_EVENT；
 * 合法但不确定的事件落库后走 Gate / IGNORED，保留可追溯性。
 * @param event - 调用方给的事件。
 * @param tenantId - 运行时租户（配置注入，不接受事件自带值覆盖）。
 */
export function validateInboundEvent(event: InboundEvent, tenantId: string): InboundEvent {
  if (event === null || typeof event !== 'object') {
    throw new RuntimeError('INVALID_EVENT', 'event must be an object')
  }
  if (event.tenantId !== tenantId) {
    throw new RuntimeError('INVALID_EVENT', 'event.tenantId does not match the configured tenant')
  }
  if (typeof event.provider !== 'string' || event.provider.trim() === '') {
    throw new RuntimeError('INVALID_EVENT', 'provider is required')
  }
  if (typeof event.eventType !== 'string' || event.eventType.trim() === '') {
    throw new RuntimeError('INVALID_EVENT', 'eventType is required')
  }
  if (event.payload === null || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new RuntimeError('INVALID_EVENT', 'payload must be a JSON object')
  }
  if (event.trustLevel !== 'UNTRUSTED_EXTERNAL' && event.trustLevel !== 'INTERNAL') {
    throw new RuntimeError('INVALID_EVENT', 'trustLevel must be UNTRUSTED_EXTERNAL or INTERNAL')
  }
  if (event.provider === 'internal' && event.trustLevel !== 'INTERNAL') {
    throw new RuntimeError('INVALID_EVENT', "provider 'internal' requires trustLevel INTERNAL")
  }
  if (event.schemaVersion !== undefined
      && (!Number.isInteger(event.schemaVersion) || event.schemaVersion < 1)) {
    throw new RuntimeError('INVALID_EVENT', 'schemaVersion must be an integer >= 1')
  }
  if (event.occurredAt !== undefined && event.occurredAt !== null
      && Number.isNaN(Date.parse(event.occurredAt))) {
    throw new RuntimeError('INVALID_EVENT', 'occurredAt must be an ISO-8601 timestamp')
  }
  for (const field of ['correlationId', 'causationId'] as const) {
    const value = event[field]
    if (value !== undefined && value !== null && !isUuidText(value)) {
      throw new RuntimeError('INVALID_EVENT', `${field} must be a UUID`)
    }
  }
  if (event.providerEventId !== undefined && event.providerEventId !== null) {
    if (typeof event.providerEventId !== 'string' || event.providerEventId.trim() === '') {
      throw new RuntimeError('INVALID_EVENT', 'providerEventId must be a non-empty string when present')
    }
  }
  if (event.payloadRef !== undefined && event.payloadRef !== null && typeof event.payloadRef !== 'string') {
    throw new RuntimeError('INVALID_EVENT', 'payloadRef must be a string')
  }
  return event
}

/** 事件运行时：唯一入口是 `receive()` / `processPending()`。 */
export class EventRuntime {
  private readonly store: RuntimeStore
  private readonly gate: DefaultSemanticGate
  private readonly pendingBatchSize: number
  private readonly maxRouteAttempts: number

  /**
   * @param options - store + 可选 Gate/批量参数。
   */
  constructor(options: EventRuntimeOptions) {
    this.store = options.store
    this.gate = options.semanticGate ?? new DefaultSemanticGate()
    this.pendingBatchSize = options.pendingBatchSize ?? 20
    this.maxRouteAttempts = options.maxRouteAttempts ?? 5
  }

  /**
   * 接收一个事件并完成路由（或返回 duplicate）。
   *
   * 两步事务：先把事件**持久化**（即使路由崩了，事实也在 Inbox 里），再在一个
   * 独立事务里定位业务对象 + 建/唤醒 Task。路由失败时事件标记 FAILED，可被
   * `processPending()` 重试；不会出现"事件丢了"或"Task 建了但事件没记"。
   * @param raw - 调用方给的事件。
   * @returns 可直接用于验收/HTTP 回执的结果。
   */
  async receive(raw: InboundEvent): Promise<EventReceiveResult> {
    const event = validateInboundEvent(raw, this.store.tenant)
    let idempotency: { key: string; source: 'PROVIDER_EVENT_ID' | 'FALLBACK_KEY' }
    try {
      idempotency = idempotencyFor(event)
    } catch (error) {
      throw new RuntimeError('INVALID_EVENT', error instanceof Error ? error.message : String(error))
    }
    const inserted = await this.store.insertEvent(event, idempotency)
    if (!inserted.inserted) {
      // 同一个 provider 事件重复到达：不重新路由、不新建 Task、不新增唤醒。
      const existing = await this.store.getEvent(inserted.eventId)
      return {
        outcome: 'duplicate',
        eventId: inserted.eventId,
        dispatchState: (existing?.dispatchState ?? inserted.dispatchState) as EventReceiveResult['dispatchState'],
        taskId: inserted.routedTaskId,
        taskCreated: false,
        wakeInserted: false,
        businessObject: existing !== null && existing.businessObjectType !== null && existing.businessObjectId !== null
          ? { type: existing.businessObjectType as BusinessObjectRef['type'], id: existing.businessObjectId }
          : null,
        reason: existing?.dispatchState === 'FAILED' ? 'event stored earlier and its routing failed; call processPending() to retry' : null,
      }
    }
    return this.routeStoredEvent(inserted.eventId, event)
  }

  /**
   * 重放"已落库但未路由完"的事件（进程重启 / 路由崩溃后的恢复入口）。
   * @returns 本轮处理的事件结果（单条失败不阻断其它事件）。
   */
  async processPending(): Promise<readonly EventReceiveResult[]> {
    const ids = await this.store.listPendingEvents(this.pendingBatchSize, this.maxRouteAttempts)
    const results: EventReceiveResult[] = []
    for (const eventId of ids) {
      const row = await this.store.getEvent(eventId)
      if (row === null) continue
      const event: InboundEvent = eventRowToInbound(row, this.store.tenant)
      try {
        results.push(await this.routeStoredEvent(eventId, event))
      } catch (error) {
        const failure = runtimeFailure(error)
        await this.store.markEventFailed(eventId, failure.code, failure.message)
        results.push({
          outcome: 'stored',
          eventId,
          dispatchState: 'FAILED',
          taskId: null,
          taskCreated: false,
          wakeInserted: false,
          businessObject: null,
          reason: failure.message,
        })
      }
    }
    return results
  }

  /** 对一个**已持久化**的事件执行路由（receive 与 processPending 共用）。 */
  private async routeStoredEvent(eventId: string, event: InboundEvent): Promise<EventReceiveResult> {
    const decision = decideRoute(event, this.gate)
    if (decision.kind === 'ignored') {
      await this.store.markEventIgnored(eventId, decision.reason)
      return {
        outcome: 'stored',
        eventId,
        dispatchState: 'IGNORED',
        taskId: null,
        taskCreated: false,
        wakeInserted: false,
        businessObject: null,
        reason: decision.reason,
      }
    }
    const wake = await this.store.createOrWakeTask({
      decision,
      eventId,
      eventType: event.eventType,
      createdByActorId: null,
    })
    const businessObject = decision.kind === 'deterministic' ? decision.businessObject : null
    await this.store.markEventRouted(eventId, wake.taskId, businessObject)
    return {
      outcome: 'stored',
      eventId,
      dispatchState: 'ROUTED',
      taskId: wake.taskId,
      taskCreated: wake.created,
      wakeInserted: wake.wakeInserted,
      businessObject,
      reason: decision.kind === 'semantic' ? decision.reason : null,
    }
  }
}

