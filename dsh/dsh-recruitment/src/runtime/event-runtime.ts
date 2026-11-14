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
//
// G10（处置审计）：事件走到终态后，按 `event_disposition`（0016 §2）写一行 append-only
// 处置事实（FILTERED / EVALUATED / FANNED_OUT + 封闭 reason_code）。写入面是**可注入的
// sink**（默认不挂 = 不写，既有 13 个调用点行为逐字不变）；挂载/健康度由 index.ts 与
// HTTP 层使用。处置只在**终态迁移成功之后**写：重复投递 / 路由失败 / 并发竞态一律不写，
// 否则会出现"回执说 A、审计行说 B"的自相矛盾。
import { isUuidText } from '../db/pool.ts'
import { RuntimeError, runtimeFailure } from './errors.ts'
import { eventTypeRegistration } from './event-types.ts'
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
  /** 处置落库面（不传 = 不写处置；向后兼容既有调用点）。 */
  readonly dispositions?: EventDispositionSink
}

// ---------------------------------------------------------------------------
//  事件处置（event_disposition）：终态之后写一行 append-only 审计事实
//
//  为什么不往 `event_inbox` 加列：`dispatch_state` 是**派发投影**（可重试、可被
//  cutover 扫尾改写），处置是"这条事件最终被判了什么"的审计事实；重新评估不能被
//  覆盖（D-106 §2 / 0016 §2 的 append-only 约束）。因此写入一律
//  `insert ... on conflict (event_id) do nothing`，绝不 update/upsert。
// ---------------------------------------------------------------------------

/** 处置值：0016 ck_event_disposition_disposition 的封闭集，一个字都不能多。 */
export type EventDispositionKind = 'FILTERED' | 'EVALUATED' | 'FANNED_OUT'

/** 原因码：0016 ck_event_disposition_reason 的封闭集（8 值，逐字）。 */
export type EventDispositionReasonCode =
  | 'SEMANTIC_GATE_REJECTED'
  | 'ROUTE_IGNORED'
  | 'BEFORE_RUNTIME_CUTOVER'
  | 'DUPLICATE_EVENT'
  | 'DETERMINISTIC_ROUTE'
  | 'SEMANTIC_ROUTE'
  | 'TASK_CREATED'
  | 'TASK_WOKEN'

/** 一条待落库的处置（append-only；同一 event 只允许一行）。 */
export interface EventDispositionInput {
  readonly eventId: string
  readonly disposition: EventDispositionKind
  readonly reasonCode: EventDispositionReasonCode
  readonly targetTaskIds: readonly string[]
}

/** 由 PG 读回的处置健康度（全部是库事实，不是进程自述）。 */
export interface EventDispositionHealth {
  readonly eventsTotal: number
  readonly eventsInternalAudit: number
  readonly eventsInScope: number
  readonly eventsDisposed: number
  readonly eventsDisposedInScope: number
  readonly eventsUndisposed: number
  readonly eventsUndisposedOldestWaitSeconds: number | null
  readonly eventsUndisposedOldestReceivedAt: string | null
}

/** 处置落库面（可注入：PG 实现 / 测试替身）。 */
export interface EventDispositionSink {
  /** 写一行；true=本次插入，false=该 event 已有处置（on conflict do nothing，绝不覆盖）。 */
  record(input: EventDispositionInput): Promise<boolean>
  /** 库事实读回（无处置数 / 最老等待秒）。 */
  health(): Promise<EventDispositionHealth>
}

/** 最小查询面（pg.Pool / pg.PoolClient 结构上满足；与 tick-loop.ts 的窄接口同一风格）。 */
export interface DispositionQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
}

/** 处置写失败时抛出的稳定 message 前缀（errors.ts 不在本 lane 写范围，不新增 RuntimeErrorCode）。 */
export const DISPOSITION_RECORD_FAILED = 'DISPOSITION_RECORD_FAILED'
/** 重复挂载不同 sink 时的稳定 message 前缀。 */
export const DISPOSITION_SINK_CONFLICT = 'DISPOSITION_SINK_CONFLICT'

/** = EventDispositionHealth + 进程内写失败计数（写失败不静默）。 */
export interface EventDispositionHealthReport extends EventDispositionHealth {
  readonly writeFailures: number
  readonly lastWriteError: string | null
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

/**
 * 处置健康度 SQL（契约 §3 冻结口径）：**一条查询**返回 8 个值。
 *
 * 为什么必须一条 SQL：两个读数（例：无处置数 + 最老等待）分两次查会跨快照，
 * 并发路由下能凑出"没有积压但最老等待 > 0"这种不存在的状态。
 *
 * 为什么逐字复制而不 import `cutover.ts::EVENT_DISPATCHABLE_SQL`：那个常量同时含
 * `dispatch_state` / `route_attempts` 两条"此刻可派发"条件；健康度问的是"**应**处置"
 * （FAILED 且超重试上限的事件仍应有处置），拼进去会把它们从 scope 里漏掉。in-scope
 * 谓词与 `cutover.ts:43-45` 的 scope 部分**同一口径**，改口径时两处必须一起改。
 */
const DISPOSITION_HEALTH_SQL = `with scope as (
  select e.event_id, e.received_at
    from recruitment.event_inbox e
   where e.tenant_id = $1::uuid
     and (e.normalizer_version is distinct from 'schema/0001'
          or e.event_type like 'semantic.%'
          or e.event_type like 'router.%')
), undisposed as (
  select s.event_id, s.received_at
    from scope s
   where not exists (
     select 1 from recruitment.event_disposition d
      where d.tenant_id = $1::uuid and d.event_id = s.event_id)
)
select
  (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid)::text   as events_total,
  (select count(*) from recruitment.event_inbox
    where tenant_id = $1::uuid
      and not (normalizer_version is distinct from 'schema/0001'
               or event_type like 'semantic.%' or event_type like 'router.%'))::text as events_internal_audit,
  (select count(*) from scope)::text                                                 as events_in_scope,
  (select count(*) from recruitment.event_disposition where tenant_id = $1::uuid)::text as events_disposed,
  (select count(*) from scope s join recruitment.event_disposition d
      on d.tenant_id = $1::uuid and d.event_id = s.event_id)::text                   as events_disposed_in_scope,
  (select count(*) from undisposed)::text                                            as events_undisposed,
  (select floor(extract(epoch from (now() - min(received_at))))::text from undisposed) as oldest_wait_seconds,
  (select to_char(min(received_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     from undisposed)                                                                as oldest_received_at`

/** `count(*)::text` → number（bigint 以文本读回，避免 JSON 数字精度区）。 */
const countText = (value: unknown): number => Number(value ?? 0)

/** 可能为 SQL NULL 的秒数：无积压时是 null（契约要求**不是 0**）。 */
const nullableCountText = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value)

/**
 * PG 实现：append-only 写入 + 一条 SQL 读回健康度。
 *
 * `on conflict (event_id) do nothing returning id` 是唯一写法：返回 false = 该事件
 * 已有处置行（并发赢家先写了），**不算错误**、也不改任何列——处置是审计事实，
 * 第二次写必须无副作用。`target_task_ids` 用 JSON.stringify 走 `$5::jsonb`，
 * 让 PG 的 `jsonb_typeof(...) = 'array'` 约束来守形状，不靠应用自证。
 * @param db - 连接面（pool 或 client；构造上只需 `query`）。
 * @param tenantId - 运行时租户（与 store 同一个；不接受事件自带值覆盖）。
 * @returns 可注入 `EventRuntimeOptions.dispositions` 的 sink。
 */
export function createPgEventDispositionSink(
  db: DispositionQueryable,
  tenantId: string,
): EventDispositionSink {
  return {
    async record(input: EventDispositionInput): Promise<boolean> {
      const { rows } = await db.query<Record<string, unknown>>(
        `insert into recruitment.event_disposition
           (tenant_id, event_id, disposition, reason_code, target_task_ids)
         values ($1::uuid, $2::uuid, $3, $4, $5::jsonb)
         on conflict (event_id) do nothing
         returning id::text as id`,
        [tenantId, input.eventId, input.disposition, input.reasonCode, JSON.stringify(input.targetTaskIds)],
      )
      return rows.length > 0
    },
    async health(): Promise<EventDispositionHealth> {
      const { rows } = await db.query<Record<string, unknown>>(DISPOSITION_HEALTH_SQL, [tenantId])
      const row = rows[0] ?? {}
      return {
        eventsTotal: countText(row.events_total),
        eventsInternalAudit: countText(row.events_internal_audit),
        eventsInScope: countText(row.events_in_scope),
        eventsDisposed: countText(row.events_disposed),
        eventsDisposedInScope: countText(row.events_disposed_in_scope),
        eventsUndisposed: countText(row.events_undisposed),
        eventsUndisposedOldestWaitSeconds: nullableCountText(row.oldest_wait_seconds),
        eventsUndisposedOldestReceivedAt: row.oldest_received_at === null || row.oldest_received_at === undefined
          ? null
          : String(row.oldest_received_at),
      }
    },
  }
}

/** 任意异常 → 可读文本（非 Error 用 String；不吞成空串）。 */
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 处置写失败（内部信号）：事件已到终态，但审计行没落库。
 *
 * 为什么用内部类而不是 RuntimeError：`errors.ts` / `RuntimeErrorCode` 都不在本 lane
 * 写范围（契约只冻结 message 前缀）。内部类只干一件事：让 `processPending()` 能把
 * "终态写审计失败"与"路由失败"分开——前者**不许**标 `FAILED`，否则已派发的 Task /
 * 已 IGNORED 的事实会被下一轮当成失败重放。
 */
class DispositionWriteFailure extends Error {
  /** 本该返回的回执（状态已是终态，只差审计行）。 */
  readonly receipt: EventReceiveResult

  /**
   * @param detail - 失败细节（已截断，不含 secret）。
   * @param receipt - 终态回执；processPending 原样返回、只把 reason 换成失败原因。
   */
  constructor(detail: string, receipt: EventReceiveResult) {
    super(`${DISPOSITION_RECORD_FAILED}: ${detail}`)
    this.receipt = receipt
  }
}

/** 事件运行时：唯一入口是 `receive()` / `processPending()`。 */
export class EventRuntime {
  private readonly store: RuntimeStore
  private readonly gate: DefaultSemanticGate
  private readonly pendingBatchSize: number
  private readonly maxRouteAttempts: number
  /** 处置写入口；null = 未挂（本实例不写处置，既有行为不变）。 */
  private dispositionSink: EventDispositionSink | null
  /** 处置写失败次数（进程内计数；写失败必须能从 dispositionHealth 读到，不静默）。 */
  private dispositionWriteFailures = 0
  /** 最近一次处置写失败的可读原因（≤300 字，避免把整段 PG 错误灌进健康端点）。 */
  private lastDispositionWriteError: string | null = null

  /**
   * @param options - store + 可选 Gate/批量参数/处置 sink。
   */
  constructor(options: EventRuntimeOptions) {
    this.store = options.store
    this.gate = options.semanticGate ?? new DefaultSemanticGate()
    this.pendingBatchSize = options.pendingBatchSize ?? 20
    this.maxRouteAttempts = options.maxRouteAttempts ?? 5
    this.dispositionSink = options.dispositions ?? null
  }

  /**
   * 迟绑定处置 sink（index.ts 在 composeRuntime 之后调用；必须在注册 HTTP 与启动
   * tick-loop **之前**挂上，否则第一轮 tick 路由掉的事件会"已终态但没有处置"）。
   *
   * 同一对象重复挂载 = no-op（装配可能被重入）；已挂**不同**对象 = 抛
   * `DISPOSITION_SINK_CONFLICT`——一个运行时实例只允许一个处置写入口，否则同一租户的
   * 处置会分裂到两个 sink，健康度读数也会各说各话。
   * @param sink - PG 实现或测试替身。
   */
  attachDispositionSink(sink: EventDispositionSink): void {
    if (this.dispositionSink === sink) return
    if (this.dispositionSink !== null) {
      throw new Error(
        `${DISPOSITION_SINK_CONFLICT}: a different disposition sink is already attached `
        + '(one runtime instance must not split one tenant\'s disposition writes across two sinks)',
      )
    }
    this.dispositionSink = sink
  }

  /**
   * 处置健康度（库事实 + 进程内写失败计数）。
   * @returns 未挂 sink → `null`（HTTP 层必须如实报 available:false，不许编 0）。
   */
  async dispositionHealth(): Promise<EventDispositionHealthReport | null> {
    const sink = this.dispositionSink
    if (sink === null) return null
    const health = await sink.health()
    return {
      ...health,
      writeFailures: this.dispositionWriteFailures,
      lastWriteError: this.lastDispositionWriteError,
    }
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
      // 同一个 provider 事件重复到达：不重新路由、不新建 Task、不新增唤醒，**也不写处置**
      // （唯一约束下同一 event 只有一行；重复投递不得写"假处置"）。
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
   *
   * **cutover 水位是这里的第一步**（顺序不能换）：
   *   1. 读该租户的水位；没有 → 抛 `CUTOVER_WATERMARK_MISSING`（fail closed：
   *      没有声明过"历史边界"就不派发任何事件，绝不猜一个"现在"）；
   *   2. 把本批次 `received_at < cutover_at` 的事件标 `IGNORED`
   *      （原因 `BEFORE_RUNTIME_CUTOVER`）：只改 dispatch 投影，不建 Task、
   *      不写唤醒、不入队副作用、事件主体不可变；
   *   3. 再重放跨过水位的待路由事件（`listPendingEvents` 的 SQL 里已 join 水位，
   *      即使第 2 步漏掉也不可能取到历史事件）。
   *
   * 挂了处置 sink 时，第 2 步的每条历史事件写 `FILTERED/BEFORE_RUNTIME_CUTOVER`，第 3 步
   * 路由成功的事件按映射表写对应处置。**写失败不标 FAILED**（事件已是终态）：只累加
   * `writeFailures` 并把回执的 reason 换成 `DISPOSITION_RECORD_FAILED: ...`。
   *
   * 为什么先扫历史再派发，而不是先派发：历史扫尾的代价是常量的（一条 UPDATE），
   * 而派发会建 Task / 起 Worker。顺序反了会出现"这一轮先把新事件派出去、历史
   * 还没标完"的中间态，虽然最终一致，但可解释性差（tick 回执会混着两类结果）。
   * @returns 本轮处理的事件结果（历史扫尾结果 + 正常重放结果；单条失败不阻断其它事件）。
   */
  async processPending(): Promise<readonly EventReceiveResult[]> {
    const cutover = await this.store.cutover.read()
    if (cutover === null) {
      throw new RuntimeError(
        'CUTOVER_WATERMARK_MISSING',
        `tenant ${this.store.tenant} has no runtime watermark row; refusing to dispatch any pending event. `
        + 'Declare the history boundary first (recruitment.fn_runtime_watermark_upsert / 0015 migration bootstrap).',
      )
    }

    const swept = await this.store.cutover.sweepBefore(this.pendingBatchSize, this.maxRouteAttempts)
    const results: EventReceiveResult[] = []
    for (const hit of swept) {
      const receipt: EventReceiveResult = {
        outcome: 'stored',
        eventId: hit.eventId,
        dispatchState: 'IGNORED',
        taskId: null,
        taskCreated: false,
        wakeInserted: false,
        businessObject: null,
        reason: hit.reason,
      }
      try {
        // 扫尾已经把它标成 IGNORED（终态）：处置固定 FILTERED/BEFORE_RUNTIME_CUTOVER，
        // 目标 Task 恒为空（历史事件不建 Task、不写唤醒）。
        await this.recordDisposition({
          eventId: hit.eventId,
          disposition: 'FILTERED',
          reasonCode: 'BEFORE_RUNTIME_CUTOVER',
          targetTaskIds: [],
        }, receipt)
        results.push(receipt)
      } catch (error) {
        // 终态已提交，不许回退成 FAILED：只把审计失败如实带回执（reason 带稳定前缀）。
        results.push({ ...receipt, reason: describeError(error) })
      }
    }

    const ids = await this.store.listPendingEvents(this.pendingBatchSize, this.maxRouteAttempts)
    for (const eventId of ids) {
      const row = await this.store.getEvent(eventId)
      if (row === null) continue
      const event: InboundEvent = eventRowToInbound(row, this.store.tenant)
      try {
        results.push(await this.routeStoredEvent(eventId, event))
      } catch (error) {
        if (error instanceof DispositionWriteFailure) {
          // 路由本身已到终态（ROUTED/IGNORED 已提交），只是审计行没落库：
          // 绝不能标 FAILED —— 那会让下一轮把已派发的 Task 重放一遍。
          results.push({ ...error.receipt, reason: error.message })
          continue
        }
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

  /**
   * 对一个**已持久化**的事件执行路由（receive 与 processPending 共用）。
   *
   * 处置只在终态迁移**成功后**写（`markEvent*` 返回 true）：返回 false 说明并发路径
   * 已经抢先迁移，本尝试不写处置、按库里真实状态回执——否则会出现"回执说 ROUTED、
   * 审计行说 IGNORED"这种自相矛盾的组合（赢家写它自己的那一行）。
   */
  private async routeStoredEvent(eventId: string, event: InboundEvent): Promise<EventReceiveResult> {
    const decision = decideRoute(event, this.gate, await this.resolveEventRowObject(eventId, event))
    if (decision.kind === 'ignored') {
      const receipt: EventReceiveResult = {
        outcome: 'stored',
        eventId,
        dispatchState: 'IGNORED',
        taskId: null,
        taskCreated: false,
        wakeInserted: false,
        businessObject: null,
        reason: decision.reason,
      }
      if (!(await this.store.markEventIgnored(eventId, decision.reason))) {
        return this.eventReceiptAfterRace(eventId)
      }
      await this.recordDisposition({
        eventId,
        disposition: 'FILTERED',
        reasonCode: decision.reason.startsWith('SEMANTIC_GATE_REJECTED')
          ? 'SEMANTIC_GATE_REJECTED'
          : 'ROUTE_IGNORED',
        targetTaskIds: [],
      }, receipt)
      return receipt
    }
    const wake = await this.store.createOrWakeTask({
      decision,
      eventId,
      eventType: event.eventType,
      createdByActorId: null,
    })
    const businessObject = decision.kind === 'deterministic' ? decision.businessObject : null
    if (!(await this.store.markEventRouted(eventId, wake.taskId, businessObject))) {
      return this.eventReceiptAfterRace(eventId)
    }
    const receipt: EventReceiveResult = {
      outcome: 'stored',
      eventId,
      dispatchState: 'ROUTED',
      taskId: wake.taskId,
      taskCreated: wake.created,
      wakeInserted: wake.wakeInserted,
      businessObject,
      reason: decision.kind === 'semantic' ? decision.reason : null,
    }
    // 语义准入只是评估（triage task 已在 routed_task_id 里），不算扇出；确定性路由
    // 按"新建 Task / 唤醒已有 Task"区分原因码，target_task_ids 用真实 taskId。
    await this.recordDisposition(decision.kind === 'semantic'
      ? { eventId, disposition: 'EVALUATED', reasonCode: 'SEMANTIC_ROUTE', targetTaskIds: [] }
      : {
          eventId,
          disposition: 'FANNED_OUT',
          reasonCode: wake.created ? 'TASK_CREATED' : 'TASK_WOKEN',
          targetTaskIds: [wake.taskId],
        }, receipt)
    return receipt
  }

  /**
   * 落一条处置（append-only）。
   *
   * 失败不吞：终态已经提交，回执改不了库状态，只能把失败**记账**（writeFailures /
   * lastWriteError）并抛给调用方按 receive / processPending 各自的语义处理。
   * `record()` 返回 false = 该 event 已有处置行（on conflict do nothing），不是错误。
   * @param input - 待落库的处置。
   * @param receipt - 本次路由回执（写失败时 processPending 原样返回、只换 reason）。
   */
  private async recordDisposition(input: EventDispositionInput, receipt: EventReceiveResult): Promise<void> {
    const sink = this.dispositionSink
    if (sink === null) return
    try {
      await sink.record(input)
    } catch (error) {
      this.dispositionWriteFailures += 1
      const detail = describeError(error).slice(0, 300)
      this.lastDispositionWriteError = detail
      throw new DispositionWriteFailure(detail, receipt)
    }
  }

  /**
   * 并发竞态：终态迁移返回 false，说明另一个执行路径抢先迁移，本尝试**不写**处置。
   *
   * 回执按库里真实状态重建。`taskId` 不填本尝试的 `wake.taskId`：赢家可能路由到另一条
   * Task，回执不许编造；`route_error` 属于赢家，这里只报状态、不转述原因。
   * @param eventId - 已落库事件 id。
   * @returns 库里真实状态构成回执。
   */
  private async eventReceiptAfterRace(eventId: string): Promise<EventReceiveResult> {
    const current = await this.store.getEvent(eventId)
    if (current === null) {
      // 事件行消失不是正常竞态（append-only + 禁删）：当作存储异常暴露。
      throw new RuntimeError('EVENT_STORE_FAILED', `event ${eventId} disappeared while resolving a concurrent terminal transition`)
    }
    return {
      outcome: 'stored',
      eventId,
      dispatchState: current.dispatchState as EventReceiveResult['dispatchState'],
      taskId: null,
      taskCreated: false,
      wakeInserted: false,
      businessObject: current.businessObjectType !== null && current.businessObjectId !== null
        ? { type: current.businessObjectType as BusinessObjectRef['type'], id: current.businessObjectId }
        : null,
      reason: null,
    }
  }

  /**
   * 按**事件行事实**解析业务对象（payload 里没有对象 id 的类型才查）。
   *
   * 只对注册表里显式声明了 `byEventRow` 的确定性事件做查询——这是登记表告诉运行时
   * "这个事件的对象不在 payload 里"的唯一方式；其它类型不查库（保持路由轻）。
   * @param eventId - 已落库的事件 id。
   * @param event - 事件信封。
   * @returns 解析到的对象引用；不需要/解析不到 → `null`（路由层落 BUSINESS_OBJECT_NOT_FOUND）。
   */
  private async resolveEventRowObject(eventId: string, event: InboundEvent): Promise<BusinessObjectRef | null> {
    const registration = eventTypeRegistration(event.eventType)
    if (registration === null || registration.routing.kind !== 'DETERMINISTIC') return null
    const byEventRow = registration.routing.object.byEventRow
    if (byEventRow === null) return null
    if (byEventRow === 'INTAKE_RECORD') {
      const id = await this.store.intakeRecordIdForEvent(eventId)
      return id === null ? null : { type: 'INTAKE_RECORD', id }
    }
    // 不可达：`byEventRow` 是联合类型，新增取值时必须在这里实现解析。
    throw new RuntimeError('EVENT_ROUTE_FAILED', `unsupported event-row object lookup: ${String(byEventRow)}`)
  }
}

