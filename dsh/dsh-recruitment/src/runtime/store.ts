// 任务运行时的 PostgreSQL 读写层。
//
// 设计原则（与仓库既有 Db 层一致）：
//   * **所有写操作在一个事务里**：事件入库 + 定位业务对象 + 创建/唤醒 Task 必须
//     原子提交，否则会出现"事件进了 Inbox 但没有 Task"或反过来；
//   * actor 通过 `withActor` 的 `SET LOCAL recruitment.actor_id` 传入，不用全局 SET
//     （0001 的 fn_row_guard 要求状态迁移可以确定 actor）；
//   * 幂等与"同一时刻只有一个有效租约"靠**库约束**（0011/index/unique），不靠
//     进程内内存集合；进程重启后语义不变；
//   * 时间一律由数据库 `now()` 生成（除测试注入的 retry_after 外），不信任应用时钟。
//
// 这里只做 SQL 和行映射，不做业务判断：事件走哪条路径在 routing.ts，Attempt 怎么
// 收尾在 task-runtime.ts。
import type { DatabaseClient, DatabasePool } from '../db/pool.ts'
import { withActor, withReadOnly } from '../db/pool.ts'
import type {
  AgentSessionRecord,
  AttemptStatus,
  BusinessObjectRef,
  BusinessTaskRecord,
  InboundEvent,
  NotificationTarget,
  RuntimeNotification,
  TaskAttemptRecord,
  TaskErrorClass,
  TaskRuntimeView,
  TaskStatus,
  TaskWakeupRecord,
} from './types.ts'
import type { RouteDecision } from './types.ts'
import { taskIdempotencyKey } from './routing.ts'
// runtime ↔ 引擎 Effects/Outbox 的唯一交界（type-only import，不会拉起同步桥 worker）。
// 三个函数都接收**调用方事务里的异步 client**：业务写入与副作用入队同事务提交。
import { enqueueEffect, readReceipt, recordOutbound } from '../engine/app/effects-async.ts'

/** 运行时写库需要的配置（tenant/actor 来自插件配置，不接受模型入参）。 */
export interface RuntimeStoreOptions {
  readonly pool: DatabasePool
  readonly tenantId: string
  readonly actorId: string
  /**
   * 出站通知目标（可选）。配置后才在 Task 进入 WAITING_* / FAILED 时登记消息；
   * 默认不配 = 不发消息。
   */
  readonly notification?: NotificationTarget
}

/** `insertEvent` 的结果：本次是新入库还是命中幂等。 */
export interface InsertEventResult {
  readonly eventId: string
  readonly inserted: boolean
  readonly dispatchState: string
  readonly routedTaskId: string | null
}

/** 事件行（重放待路由事件用；字段只取运行时需要的）。 */
export interface EventRow {
  readonly eventId: string
  readonly provider: string
  readonly providerEventId: string | null
  readonly eventType: string
  readonly schemaVersion: number
  readonly occurredAt: string | null
  readonly payload: Record<string, unknown>
  readonly sourceObjectId: string | null
  readonly payloadRef: string | null
  readonly trustLevel: 'UNTRUSTED_EXTERNAL' | 'INTERNAL'
  readonly idempotencyKey: string
  readonly correlationId: string | null
  readonly causationId: string | null
  readonly dispatchState: string
  readonly routeAttempts: number
  readonly businessObjectType: string | null
  readonly businessObjectId: string | null
}

/** 一次被 Router 认领的执行。 */
export interface TaskClaim {
  readonly taskId: string
  readonly taskType: string
  readonly title: string
  readonly description: string | null
  readonly businessRefs: readonly BusinessObjectRef[]
  readonly priority: number
  readonly attemptId: string
  readonly attemptNo: number
  readonly fencingToken: number
  readonly leaseExpiresAt: string
  /** 上一次执行用过的 DSH Session id（默认不续跑，只作为 Router 的决策输入）。 */
  readonly lastRuntimeSessionId: string | null
}

/** `finishAttempt` 的输入：来自 WorkerOutcome + 执行前拿到的 id。 */
export interface FinishAttemptInput {
  readonly taskId: string
  readonly attemptId: string
  readonly agentSessionId: string
  readonly outcomeState: 'succeeded' | 'failed' | 'waiting' | 'blocked'
  readonly summary: string
  readonly resultRef: string | null
  readonly errorCode: string | null
  readonly errorClass: TaskErrorClass | null
  readonly retryable: boolean
  readonly retryAfter: string | null
  readonly autoRetryAllowed: boolean
  readonly runtimeSessionId: string | null
  readonly rawOutputRef: string | null
  readonly durationMs: number
}

/** `finishAttempt` 写回后的状态（供 tick 回执使用）。 */
export interface FinishAttemptResult {
  readonly taskStatus: TaskStatus
  readonly attemptStatus: AttemptStatus
  readonly errorCode: string | null
  /** 本次收尾登记的出站通知（同事务读回 pending；未配置/不需要通知时为 null）。 */
  readonly notification: RuntimeNotification | null
}

/** 回收失联 Attempt 的结果。 */
export interface RecoveredAttempt {
  readonly taskId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly errorCode: string
}

const num = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return 0
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

const isoRequired = (value: unknown): string => iso(value) ?? ''

function mapBusinessRefs(value: unknown): BusinessObjectRef[] {
  if (!Array.isArray(value)) return []
  const out: BusinessObjectRef[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const type = (item as Record<string, unknown>).type
    const id = (item as Record<string, unknown>).id
    if (typeof type === 'string' && typeof id === 'string') {
      out.push({ type: type as BusinessObjectRef['type'], id })
    }
  }
  return out
}

function mapTask(row: Record<string, unknown>): BusinessTaskRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    taskType: String(row.task_type),
    title: String(row.title),
    description: iso(row.description),
    businessRefs: mapBusinessRefs(row.business_refs),
    status: String(row.status) as TaskStatus,
    priority: num(row.priority),
    idempotencyKey: String(row.idempotency_key),
    triggerEventId: iso(row.trigger_event_id),
    lastWakeEventId: iso(row.last_wake_event_id),
    wakeCount: num(row.wake_count),
    attemptCount: num(row.attempt_count),
    currentAttemptId: iso(row.current_attempt_id),
    resultRef: iso(row.result_ref),
    errorCode: iso(row.error_code),
    errorSummary: iso(row.error_summary),
    nextRunAt: iso(row.next_run_at),
    completedAt: iso(row.completed_at),
    recordVersion: num(row.record_version),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  }
}

function mapAttempt(row: Record<string, unknown>): TaskAttemptRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    attemptNo: num(row.attempt_no),
    workerType: String(row.worker_type),
    workerId: String(row.worker_id),
    status: String(row.status) as AttemptStatus,
    fencingToken: num(row.fencing_token),
    claimedAt: isoRequired(row.claimed_at),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    leaseExpiresAt: isoRequired(row.lease_expires_at),
    outputRef: iso(row.output_ref),
    errorClass: iso(row.error_class) as TaskErrorClass | null,
    errorCode: iso(row.error_code),
    errorDetail: iso(row.error_detail),
    retryable: row.retryable === true,
    retryAfter: iso(row.retry_after),
    executionDurationMs: row.execution_duration_ms === null || row.execution_duration_ms === undefined
      ? null
      : num(row.execution_duration_ms),
    createdAt: isoRequired(row.created_at),
  }
}

function mapSession(row: Record<string, unknown>): AgentSessionRecord {
  return {
    id: String(row.id),
    taskId: iso(row.task_id),
    attemptId: iso(row.attempt_id),
    runtimeKind: String(row.runtime_kind),
    runtimeVersion: String(row.runtime_version),
    modelRoute: String(row.model_route),
    runtimeSessionId: iso(row.runtime_session_id),
    runtimeWorkerRole: String(row.runtime_worker_role) as 'ROUTER' | 'WORKER',
    status: String(row.status) as 'ACTIVE' | 'ENDED' | 'LOST',
    startedAt: isoRequired(row.started_at),
    endedAt: iso(row.ended_at),
  }
}

function mapWakeup(row: Record<string, unknown>): TaskWakeupRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    eventId: String(row.event_id),
    wakeSeq: num(row.wake_seq),
    wakeReason: String(row.wake_reason),
    createdAt: isoRequired(row.created_at),
  }
}

/** 任务运行时库层。所有方法都是异步的，且各自拥有完整事务。 */
export class RuntimeStore {
  private readonly pool: DatabasePool
  private readonly tenantId: string
  private readonly actorId: string
  private readonly notification: NotificationTarget | undefined

  /**
   * @param options - 连接池 + 租户 + actor（全部来自插件配置）。
   */
  constructor(options: RuntimeStoreOptions) {
    this.pool = options.pool
    this.tenantId = options.tenantId
    this.actorId = options.actorId
    this.notification = options.notification
  }

  /** 当前租户 id（测试/HTTP 回执用）。 */
  get tenant(): string {
    return this.tenantId
  }

  /**
   * 幂等写入 Event Inbox。
   *
   * 先尝试 INSERT ... ON CONFLICT DO NOTHING（**不带目标**，同时覆盖
   * `uq_event_inbox_idempotency` 和 `uq_event_inbox_provider_event`），
   * 没插进去再按 provider 事件 ID / 幂等键读回已有行。并发下的语义：
   * 后到的事务会等先到者提交，然后拿到 0 行并在 SELECT 里读到同一行。
   * @param event - 已通过 envelope 校验的事件。
   * @param idempotency - `{ key, source }`（routing.idempotencyFor 的结果）。
   * @returns 事件 id + 是否新插入 + 已有分发状态。
   */
  async insertEvent(
    event: InboundEvent,
    idempotency: { key: string; source: 'PROVIDER_EVENT_ID' | 'FALLBACK_KEY' },
  ): Promise<InsertEventResult> {
    return withActor(this.pool, this.actorId, async (client) => {
      const inserted = await client.query<Record<string, unknown>>(
        `insert into recruitment.event_inbox (
           tenant_id, provider, provider_event_id, event_type, schema_version,
           occurred_at, correlation_id, causation_id, idempotency_key, idempotency_source,
           source_object_id, payload_ref, payload, trust_level,
           normalized_event_type, normalizer_version
         ) values (
           $1::uuid, $2, $3, $4, $5,
           $6::timestamptz, $7::uuid, $8::uuid, $9, $10,
           $11, $12, $13::jsonb, $14,
           $15, 'runtime/0011'
         )
         on conflict do nothing
         returning event_id::text as event_id, dispatch_state, routed_task_id::text as routed_task_id`,
        [
          this.tenantId, event.provider, event.providerEventId ?? null, event.eventType,
          event.schemaVersion ?? 1, event.occurredAt ?? null,
          event.correlationId ?? null, event.causationId ?? null,
          idempotency.key, idempotency.source,
          event.sourceObjectId ?? null, event.payloadRef ?? null,
          JSON.stringify(event.payload), event.trustLevel,
          event.eventType.trim().toLowerCase().replace(/[\s-]+/g, '_'),
        ],
      )
      if (inserted.rows[0] !== undefined) {
        const row = inserted.rows[0]
        return {
          eventId: String(row.event_id),
          inserted: true,
          dispatchState: String(row.dispatch_state),
          routedTaskId: iso(row.routed_task_id),
        }
      }
      const hasProviderEvent = event.providerEventId !== undefined && event.providerEventId !== null
      const where = hasProviderEvent
        ? `tenant_id = $1::uuid and provider = $2 and provider_event_id = $3`
        : `tenant_id = $1::uuid and idempotency_key = $2`
      const params = hasProviderEvent
        ? [this.tenantId, event.provider, event.providerEventId]
        : [this.tenantId, idempotency.key]
      const existing = await client.query<Record<string, unknown>>(
        `select event_id::text as event_id, dispatch_state, routed_task_id::text as routed_task_id
           from recruitment.event_inbox
          where ${where}
          order by received_at
          limit 1`,
        params,
      )
      const row = existing.rows[0]
      if (row === undefined) {
        throw new Error('EVENT_STORE_FAILED: insert conflicted but the existing event row is not readable')
      }
      return {
        eventId: String(row.event_id),
        inserted: false,
        dispatchState: String(row.dispatch_state),
        routedTaskId: iso(row.routed_task_id),
      }
    })
  }

  /** 读回一条事件（重放待路由事件 / 重复事件回执用）。 */
  async getEvent(eventId: string): Promise<EventRow | null> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `select event_id::text, provider, provider_event_id, event_type, schema_version,
                occurred_at, payload, source_object_id, payload_ref, trust_level,
                idempotency_key, correlation_id, causation_id, dispatch_state, route_attempts,
                business_object_type, business_object_id
           from recruitment.event_inbox
          where tenant_id = $1::uuid and event_id = $2::uuid`,
        [this.tenantId, eventId],
      )
      const row = rows[0]
      if (row === undefined) return null
      return {
        eventId: String(row.event_id),
        provider: String(row.provider),
        providerEventId: iso(row.provider_event_id),
        eventType: String(row.event_type),
        schemaVersion: num(row.schema_version),
        occurredAt: iso(row.occurred_at),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        sourceObjectId: iso(row.source_object_id),
        payloadRef: iso(row.payload_ref),
        trustLevel: String(row.trust_level) as 'UNTRUSTED_EXTERNAL' | 'INTERNAL',
        idempotencyKey: String(row.idempotency_key),
        correlationId: iso(row.correlation_id),
        causationId: iso(row.causation_id),
        dispatchState: String(row.dispatch_state),
        routeAttempts: num(row.route_attempts),
        businessObjectType: iso(row.business_object_type),
        businessObjectId: iso(row.business_object_id),
      }
    })
  }

  /** 待路由事件（RECEIVED 或 FAILED 且未到重试上限）。 */
  async listPendingEvents(limit: number, maxAttempts: number): Promise<readonly string[]> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<{ event_id: string }>(
        `select event_id::text
           from recruitment.event_inbox
          where tenant_id = $1::uuid
            and dispatch_state in ('RECEIVED', 'FAILED')
            and route_attempts < $2
            -- 0001 的 fn_row_guard 在每次状态迁移时写一条内部审计事件
            -- （provider='internal', normalizer_version='schema/0001'）。
            -- 那是**状态审计事实**，不是进站的触发事件；把它们当待路由事件会
            -- 让每次 tick 都去"路由"业务表的状态变化。语义准入事件（semantic.*）
            -- 虽然是 internal provider，但确实是触发，保留。
            and (normalizer_version is distinct from 'schema/0001'
                 or event_type like 'semantic.%'
                 or event_type like 'router.%')
          order by received_at
          limit $3`,
        [this.tenantId, maxAttempts, limit],
      )
      return rows.map((row) => row.event_id)
    })
  }

  /**
   * 标记事件已路由：dispatch 状态 + 业务对象定位 + event→task 链接。
   * 只更新运行时投影列（0011 §1.9 的白名单），事件主体不可改。
   */
  async markEventRouted(
    eventId: string,
    taskId: string,
    businessObject: BusinessObjectRef | null,
  ): Promise<boolean> {
    return withActor(this.pool, this.actorId, async (client) => {
      const { rowCount } = await client.query(
        `update recruitment.event_inbox
            set dispatch_state = 'ROUTED',
                routed_at = now(),
                processed_at = now(),
                route_attempts = route_attempts + 1,
                route_error = null,
                business_object_type = $2,
                business_object_id = $3,
                routed_task_id = $4::uuid
          where tenant_id = $1::uuid and event_id = $5::uuid
            and dispatch_state in ('RECEIVED', 'FAILED')`,
        [this.tenantId, businessObject?.type ?? null, businessObject?.id ?? null, taskId, eventId],
      )
      return (rowCount ?? 0) > 0
    })
  }

  /** 标记事件被确定性 Gate 忽略（不是失败；带可读原因）。 */
  async markEventIgnored(eventId: string, reason: string): Promise<boolean> {
    return withActor(this.pool, this.actorId, async (client) => {
      const { rowCount } = await client.query(
        `update recruitment.event_inbox
            set dispatch_state = 'IGNORED',
                routed_at = now(),
                processed_at = now(),
                route_attempts = route_attempts + 1,
                route_error = $2,
                business_object_type = null,
                business_object_id = null,
                routed_task_id = null
          where tenant_id = $1::uuid and event_id = $3::uuid
            and dispatch_state in ('RECEIVED', 'FAILED')`,
        [this.tenantId, reason.slice(0, 2000), eventId],
      )
      return (rowCount ?? 0) > 0
    })
  }

  /** 标记事件路由失败；`processed_at` 保持 null，允许后续重试。 */
  async markEventFailed(eventId: string, errorCode: string, message: string): Promise<boolean> {
    return withActor(this.pool, this.actorId, async (client) => {
      const { rowCount } = await client.query(
        `update recruitment.event_inbox
            set dispatch_state = 'FAILED',
                routed_at = now(),
                route_attempts = route_attempts + 1,
                route_error = $2,
                business_object_type = null,
                business_object_id = null,
                routed_task_id = null
          where tenant_id = $1::uuid and event_id = $3::uuid
            and dispatch_state in ('RECEIVED', 'FAILED')`,
        [this.tenantId, `${errorCode}: ${message}`.slice(0, 2000), eventId],
      )
      return (rowCount ?? 0) > 0
    })
  }

  /** 已有事件对应的 Task（重复事件回执；没路由过返回 null）。 */
  async taskForEvent(eventId: string): Promise<string | null> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<{ routed_task_id: string | null }>(
        `select routed_task_id::text from recruitment.event_inbox
          where tenant_id = $1::uuid and event_id = $2::uuid`,
        [this.tenantId, eventId],
      )
      return rows[0]?.routed_task_id ?? null
    })
  }

  /**
   * 创建或唤醒一个 Business Task。
   *
   * 幂等键来自 routing.taskIdempotencyKey：确定性事件按业务对象稳定，因此
   * **同一事件重复到达不会建第二个 Task**，第二次只会命中已有 Task；唤醒事实
   * 由 `task_wakeup` 的 (task_id, event_id) 唯一约束保证只写一次。
   * @param input - 路由结论 + 事件 id。
   * @returns taskId / 是否新建 / 是否新增唤醒。
   */
  async createOrWakeTask(input: {
    readonly decision: Extract<RouteDecision, { kind: 'deterministic' | 'semantic' }>
    readonly eventId: string
    readonly eventType: string
    readonly createdByActorId: string | null
  }): Promise<{ taskId: string; created: boolean; wakeInserted: boolean; wakeSeq: number | null }> {
    const { decision, eventId, eventType } = input
    const key = taskIdempotencyKey(decision, eventId)
    const businessRefs = decision.kind === 'deterministic' ? [decision.businessObject] : []
    const description = decision.kind === 'deterministic'
      ? `deterministic event ${eventType} (event ${eventId})`
      : `semantic admission candidate ${eventType} (event ${eventId}); gate: ${decision.reason}`
    const initialStatus = decision.kind === 'semantic' ? 'WAITING_HUMAN' : 'PENDING'

    return withActor(this.pool, this.actorId, async (client) => {
      let taskId: string | null = null
      let created = false
      let existingStatus: string | null = null
      const existing = await client.query<{ id: string; status: string }>(
        `select id::text, status from recruitment.business_task
          where tenant_id = $1::uuid and idempotency_key = $2
          for update`,
        [this.tenantId, key],
      )
      if (existing.rows[0] !== undefined) {
        taskId = existing.rows[0].id
        existingStatus = existing.rows[0].status
      } else {
        const inserted = await client.query<{ id: string }>(
          `insert into recruitment.business_task (
             tenant_id, task_type, business_refs, title, description, priority,
             trigger_event_id, created_by_actor_id, idempotency_key, status, next_run_at
           ) values (
             $1::uuid, $2, $3::jsonb, $4, $5, $6,
             $7::uuid, $8::uuid, $9, $10, now()
           )
           on conflict (tenant_id, idempotency_key) do nothing
           returning id::text`,
          [
            this.tenantId, decision.taskType, JSON.stringify(businessRefs), decision.taskTitle,
            description, decision.priority, eventId, input.createdByActorId, key, initialStatus,
          ],
        )
        if (inserted.rows[0] !== undefined) {
          taskId = inserted.rows[0].id
          created = true
        } else {
          const raced = await client.query<{ id: string }>(
            `select id::text from recruitment.business_task
              where tenant_id = $1::uuid and idempotency_key = $2
              for update`,
            [this.tenantId, key],
          )
          taskId = raced.rows[0]?.id ?? null
        }
      }
      if (taskId === null) throw new Error('TASK_CREATE_FAILED: business_task row disappeared during upsert')

      if (created) {
        await client.query(
          `insert into recruitment.task_wakeup (tenant_id, task_id, event_id, wake_seq, wake_reason)
           values ($1::uuid, $2::uuid, $3::uuid, 1, 'EVENT')`,
          [this.tenantId, taskId, eventId],
        )
        await client.query(
          `update recruitment.business_task
              set wake_count = 1, last_wake_event_id = $2::uuid
            where tenant_id = $1::uuid and id = $3::uuid`,
          [this.tenantId, eventId, taskId],
        )
        return { taskId, created: true, wakeInserted: true, wakeSeq: 1 }
      }

      const wake = await client.query<{ wake_seq: number }>(
        `insert into recruitment.task_wakeup (tenant_id, task_id, event_id, wake_seq, wake_reason)
         select $1::uuid, $2::uuid, $3::uuid, coalesce(max(wake_seq), 0) + 1, 'EVENT'
           from recruitment.task_wakeup
          where tenant_id = $1::uuid and task_id = $2::uuid
         on conflict (task_id, event_id) do nothing
         returning wake_seq`,
        [this.tenantId, taskId, eventId],
      )
      const wakeInserted = wake.rows[0] !== undefined
      if (wakeInserted) {
        // 同一个业务对象的后续事件唤醒已有 Task：保留 Task ID，把等待/终态拉回可执行。
        // 只有"在等工作"或"已结束"的任务需要重新排期；RUNNING 的任务不打断当前执行。
        await client.query(
          `update recruitment.business_task
              set wake_count = wake_count + 1,
                  last_wake_event_id = $2::uuid,
                  status = case
                    when status in ('WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
                                    'SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
                      then 'PENDING' else status end,
                  completed_at = case
                    when status in ('WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
                                    'SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
                      then null else completed_at end,
                  error_code = case
                    when status in ('WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
                                    'SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
                      then null else error_code end,
                  error_summary = case
                    when status in ('WAITING_EXTERNAL','WAITING_HUMAN','RETRY_WAIT',
                                    'SUCCEEDED','FAILED','CANCELLED','SUPERSEDED')
                      then null else error_summary end,
                  result_ref = case
                    when status = 'SUCCEEDED' then null else result_ref end,
                  next_run_at = least(coalesce(next_run_at, now()), now())
            where tenant_id = $1::uuid and id = $3::uuid`,
          [this.tenantId, eventId, taskId],
        )
        // 调用点 1b：任务正在执行时又到达新事件 → 入队 `delivery` 副作用（同事务）。
        // 运行时记录唤醒事实；把"新输入交给运行中的 Worker"这件异步动作留给插件侧
        // Effects 处理器，避免 runtime 与引擎两套投递逻辑并存。
        if (existingStatus === 'RUNNING') {
          await enqueueEffect(client, {
            tenantId: this.tenantId,
            kind: 'delivery',
            key: taskId,
            payload: { ticketId: taskId },
          })
        }
      }
      return { taskId, created: false, wakeInserted, wakeSeq: wakeInserted ? num(wake.rows[0].wake_seq) : null }
    })
  }

  /**
   * 认领下一个可执行 Task（Router 调用）。
   *
   * 用 `FOR UPDATE SKIP LOCKED` + `uq_task_attempt_active_lease` 双保险：
   * 即使两个 Router 进程同时 tick，也只有一个能拿到同一个 Task；状态改写为
   * RUNNING 后，第二个 tick 的 where 条件自然不再命中。
   * @param input - worker 身份 + 租约 + 不自动派发的任务类型。
   * @returns 认领结果；没有可执行任务时返回 null。
   */
  async claimNextTask(input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
    readonly excludedTaskTypes: readonly string[]
  }): Promise<TaskClaim | null> {
    return withActor(this.pool, this.actorId, async (client) => {
      const candidate = await client.query<Record<string, unknown>>(
        `select id::text, task_type, title, description, business_refs, priority
           from recruitment.business_task
          where tenant_id = $1::uuid
            and status in ('PENDING', 'READY', 'RETRY_WAIT')
            and (next_run_at is null or next_run_at <= now())
            and not (task_type = any($2::text[]))
          order by priority, next_run_at nulls first, created_at
          limit 1
          for update skip locked`,
        [this.tenantId, [...input.excludedTaskTypes]],
      )
      const row = candidate.rows[0]
      if (row === undefined) return null
      return this.insertAttemptAndMarkRunning(client, {
        taskId: String(row.id),
        taskType: String(row.task_type),
        title: String(row.title),
        description: iso(row.description),
        businessRefs: mapBusinessRefs(row.business_refs),
        priority: num(row.priority),
        workerType: input.workerType,
        workerId: input.workerId,
        leaseMs: input.leaseMs,
      })
    })
  }

  /** 认领**指定** Task（验收/运维定向执行用；同样受状态与唯一租约约束）。 */
  async claimTask(taskId: string, input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
  }): Promise<TaskClaim | null> {
    return withActor(this.pool, this.actorId, async (client) => {
      const candidate = await client.query<Record<string, unknown>>(
        `select id::text, task_type, title, description, business_refs, priority
           from recruitment.business_task
          where tenant_id = $1::uuid and id = $2::uuid
            and status in ('PENDING', 'READY', 'RETRY_WAIT')
            and (next_run_at is null or next_run_at <= now())
          for update`,
        [this.tenantId, taskId],
      )
      const row = candidate.rows[0]
      if (row === undefined) return null
      return this.insertAttemptAndMarkRunning(client, {
        taskId: String(row.id),
        taskType: String(row.task_type),
        title: String(row.title),
        description: iso(row.description),
        businessRefs: mapBusinessRefs(row.business_refs),
        priority: num(row.priority),
        workerType: input.workerType,
        workerId: input.workerId,
        leaseMs: input.leaseMs,
      })
    })
  }

  private async insertAttemptAndMarkRunning(
    client: DatabaseClient,
    input: {
      readonly taskId: string
      readonly taskType: string
      readonly title: string
      readonly description: string | null
      readonly businessRefs: readonly BusinessObjectRef[]
      readonly priority: number
      readonly workerType: string
      readonly workerId: string
      readonly leaseMs: number
    },
  ): Promise<TaskClaim> {
    const lastAttempt = await client.query<{ n: number }>(
      `select coalesce(max(attempt_no), 0) as n from recruitment.task_attempt
        where tenant_id = $1::uuid and task_id = $2::uuid`,
      [this.tenantId, input.taskId],
    )
    const attemptNo = num(lastAttempt.rows[0]?.n) + 1
    const attempt = await client.query<Record<string, unknown>>(
      `insert into recruitment.task_attempt (
         tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at, trace_id
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, 'CLAIMED',
         now() + make_interval(secs => $6::double precision / 1000.0), $7
       ) returning id::text, attempt_no, fencing_token::text, lease_expires_at`,
      [
        this.tenantId, input.taskId, attemptNo, input.workerType, input.workerId,
        input.leaseMs, `runtime:${this.tenantId}:${input.taskId}:${attemptNo}`,
      ],
    )
    const attemptRow = attempt.rows[0]
    if (attemptRow === undefined) throw new Error('ATTEMPT_CREATE_FAILED: insert returned no row')
    const attemptId = String(attemptRow.id)
    await client.query(
      `update recruitment.business_task
          set status = 'RUNNING',
              current_attempt_id = $2::uuid,
              attempt_count = $3,
              error_code = null,
              error_summary = null,
              completed_at = null
        where tenant_id = $1::uuid and id = $4::uuid`,
      [this.tenantId, attemptId, attemptNo, input.taskId],
    )
    // 调用点 1a：派发任务前把 `launch` 副作用原子入队（与 Attempt/Task 写入同事务）。
    // payload 用引擎的 launch 形状；runtime 的 task/attempt 映射到 ticket/assignment 两个字段，
    // 插件侧的 Effects 处理器据 key（= attemptId）决定要做什么，不反写任务身份。
    await enqueueEffect(client, {
      tenantId: this.tenantId,
      kind: 'launch',
      key: attemptId,
      payload: { ticketId: input.taskId, assignmentId: attemptId },
    })
    const lastSession = await client.query<{ runtime_session_id: string | null }>(
      `select s.runtime_session_id
         from recruitment.agent_session s
         join recruitment.task_attempt a on a.id = s.attempt_id and a.tenant_id = s.tenant_id
        where s.tenant_id = $1::uuid and a.task_id = $2::uuid
          and s.runtime_session_id is not null
        order by s.started_at desc
        limit 1`,
      [this.tenantId, input.taskId],
    )
    return {
      taskId: input.taskId,
      taskType: input.taskType,
      title: input.title,
      description: input.description,
      businessRefs: input.businessRefs,
      priority: input.priority,
      attemptId,
      attemptNo: num(attemptRow.attempt_no),
      fencingToken: num(attemptRow.fencing_token),
      leaseExpiresAt: isoRequired(attemptRow.lease_expires_at),
      lastRuntimeSessionId: iso(lastSession.rows[0]?.runtime_session_id),
    }
  }

  /** 把 Attempt 从 CLAIMED 推到 RUNNING（执行前调用，开始计时）。 */
  async startAttempt(attemptId: string, leaseMs: number): Promise<void> {
    await withActor(this.pool, this.actorId, async (client) => {
      await client.query(
        `update recruitment.task_attempt
            set status = 'RUNNING',
                started_at = now(),
                heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
          where tenant_id = $1::uuid and id = $3::uuid and status = 'CLAIMED'`,
        [this.tenantId, leaseMs, attemptId],
      )
    })
  }

  /** 登记一次 Agent Session（执行上下文）。执行前插入，`runtime_session_id` 可后补。 */
  async createAgentSession(input: {
    readonly taskId: string
    readonly attemptId: string
    readonly runtimeKind: string
    readonly runtimeVersion: string
    readonly modelRoute: string
    readonly runtimeWorkerRole?: 'ROUTER' | 'WORKER'
  }): Promise<string> {
    return withActor(this.pool, this.actorId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into recruitment.agent_session (
           tenant_id, task_id, attempt_id, runtime_kind, runtime_version, model_route,
           status, runtime_worker_role, last_heartbeat_at
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           'ACTIVE', $7, now()
         ) returning id::text`,
        [
          this.tenantId, input.taskId, input.attemptId, input.runtimeKind,
          input.runtimeVersion, input.modelRoute, input.runtimeWorkerRole ?? 'WORKER',
        ],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('AGENT_SESSION_CREATE_FAILED: insert returned no row')
      return row.id
    })
  }

  /**
   * 收尾一次 Attempt：Attempt 状态 + Task 状态 + Agent Session 状态在同一事务里写。
   *
   * 这里刻意**不**让 Worker 自报成功直接决定 Task 成功：`outcomeState='succeeded'`
   * 只表示 Worker 报告并解析出了成功结果；真正的业务结果校验由领域服务负责
   * （Notion §13「任务完成必须读回或校验业务结果，不能只相信 Worker 自报成功」）。
   * 本运行时能校验的是**结构**（结果 JSON、result_ref、session 存在），并在
   * `contracts/runtime/task-runtime.md` 里写明这条边界。
   */
  async finishAttempt(input: FinishAttemptInput): Promise<FinishAttemptResult> {
    return withActor(this.pool, this.actorId, async (client) => {
      const attemptRow = await client.query<Record<string, unknown>>(
        `select id, attempt_no from recruitment.task_attempt
          where tenant_id = $1::uuid and id = $2::uuid and task_id = $3::uuid
          for update`,
        [this.tenantId, input.attemptId, input.taskId],
      )
      if (attemptRow.rows[0] === undefined) {
        throw new Error(`ATTEMPT_NOT_FOUND: ${input.attemptId} for task ${input.taskId}`)
      }
      const attemptNo = num(attemptRow.rows[0].attempt_no)
      const errorClass = input.errorClass ?? (input.outcomeState === 'succeeded' ? null : 'TRANSIENT')
      const retryAfter = input.retryAfter
      let attemptStatus: AttemptStatus
      let taskStatus: TaskStatus
      let taskNextRunAt: string | null = null
      let taskCompleted = false
      let taskErrorCode: string | null = input.errorCode
      let taskErrorSummary: string | null = input.summary.slice(0, 2000)
      let taskResultRef: string | null = input.resultRef

      switch (input.outcomeState) {
        case 'succeeded':
          attemptStatus = 'SUCCEEDED'
          taskStatus = 'SUCCEEDED'
          taskCompleted = true
          taskErrorCode = null
          taskErrorSummary = null
          break
        case 'failed':
          if (input.retryable && input.autoRetryAllowed) {
            attemptStatus = 'FAILED_RETRYABLE'
            taskStatus = 'RETRY_WAIT'
            taskNextRunAt = retryAfter ?? new Date(Date.now() + 30_000).toISOString()
            taskErrorCode = input.errorCode ?? 'WORKER_FAILED'
          } else {
            attemptStatus = 'FAILED_FINAL'
            taskStatus = 'FAILED'
            taskCompleted = true
            taskErrorCode = input.errorCode ?? 'WORKER_FAILED'
            taskResultRef = null
          }
          break
        case 'waiting':
          attemptStatus = 'FAILED_RETRYABLE'
          taskStatus = 'WAITING_EXTERNAL'
          taskNextRunAt = retryAfter ?? new Date(Date.now() + 3_600_000).toISOString()
          taskErrorCode = null
          taskErrorSummary = null
          taskResultRef = null
          break
        case 'blocked':
          attemptStatus = 'FAILED_RETRYABLE'
          taskStatus = 'WAITING_HUMAN'
          // 人工等待没有自动 next_run_at：只有新事件唤醒或人工处置才会重新可执行。
          taskNextRunAt = retryAfter ?? new Date(Date.now() + 86_400_000).toISOString()
          taskErrorCode = null
          taskErrorSummary = null
          taskResultRef = null
          break
      }

      // 1) Attempt
      await client.query(
        `update recruitment.task_attempt
            set status = $2,
                ended_at = now(),
                heartbeat_at = now(),
                started_at = coalesce(started_at, claimed_at),
                output_ref = $3,
                error_class = $4,
                error_code = $5,
                error_detail = $6,
                retryable = $7,
                retry_after = $8::timestamptz,
                execution_duration_ms = $9
          where tenant_id = $1::uuid and id = $10::uuid`,
        [
          this.tenantId, attemptStatus, input.resultRef ?? input.rawOutputRef, errorClass,
          input.errorCode, input.outcomeState === 'succeeded' ? null : input.summary.slice(0, 4000),
          input.retryable,
          // FAILED_RETRYABLE 的 CHECK 要求 retry_after 非空
          attemptStatus === 'FAILED_RETRYABLE' ? (retryAfter ?? new Date(Date.now() + 30_000).toISOString()) : null,
          Math.max(0, Math.round(input.durationMs)), input.attemptId,
        ],
      )

      // 2) Task（保持同一个 task id；重试只新增 Attempt）
      await client.query(
        `update recruitment.business_task
            set status = $2,
                current_attempt_id = case when $2 = 'RUNNING' then current_attempt_id else null end,
                result_ref = $3,
                error_code = $4,
                error_summary = $5,
                next_run_at = $6::timestamptz,
                completed_at = case when $7 then now() else null end
          where tenant_id = $1::uuid and id = $8::uuid`,
        [
          this.tenantId, taskStatus, taskResultRef, taskErrorCode, taskErrorSummary,
          taskNextRunAt, taskCompleted, input.taskId,
        ],
      )

      // 3) Agent Session：正常结束 = ENDED；超时/丢进程 = LOST。Session 结束不影响 Task。
      await client.query(
        `update recruitment.agent_session
            set status = $2,
                ended_at = now(),
                last_heartbeat_at = now(),
                runtime_session_id = coalesce($3, runtime_session_id)
          where tenant_id = $1::uuid and id = $4::uuid`,
        [
          this.tenantId,
          input.outcomeState === 'failed' && errorClass === 'WORKER_LOST' ? 'LOST' : 'ENDED',
          input.runtimeSessionId, input.agentSessionId,
        ],
      )

      // 4) 调用点 2/3：需要人/最终失败时登记出站通知，并**同事务读回**回执状态。
      //    `recordOutbound` 会同时入队 `reply` effect；runtime 不再单独写
      //    `engine_outbox`/`durable_effect`，避免两套回执。
      const notification = await this.writeNotification(client, {
        taskId: input.taskId,
        attemptNo,
        taskStatus,
        summary: input.summary,
      })

      return {
        taskStatus,
        attemptStatus,
        errorCode: taskErrorCode,
        notification,
      }
    })
  }

  /**
   * 登记一条任务通知并读回回执（调用点 2/3 的实现；必须在调用方事务里）。
   *
   * 只有 `WAITING_EXTERNAL` / `WAITING_HUMAN` / `FAILED` 才发消息：正常自动化
   * 保持安静（Notion `04` §10）。message id 由 (task, attempt, status) 决定，
   * 同一状态重复收尾不会产生第二条回执。
   */
  private async writeNotification(
    client: DatabaseClient,
    input: {
      readonly taskId: string
      readonly attemptNo: number
      readonly taskStatus: TaskStatus
      readonly summary: string
    },
  ): Promise<RuntimeNotification | null> {
    const target = this.notification
    if (target === undefined) return null
    if (input.taskStatus !== 'WAITING_EXTERNAL'
        && input.taskStatus !== 'WAITING_HUMAN'
        && input.taskStatus !== 'FAILED') {
      return null
    }
    const messageId = `task:${input.taskId}:attempt:${input.attemptNo}:${input.taskStatus}`
    const message = {
      id: messageId,
      channel: {
        source: target.source,
        thread: target.thread,
        address: { ...target.address },
      },
      text: `task ${input.taskId} attempt ${input.attemptNo} -> ${input.taskStatus}: ${input.summary}`.slice(0, 1000),
      kind: target.kind,
      ticketId: input.taskId,
    }
    const inserted = await recordOutbound(client, { tenantId: this.tenantId, message })
    const receipt = await readReceipt(client, messageId)
    const status = receipt !== undefined && typeof receipt.status === 'string' ? receipt.status : 'missing'
    return { messageId, inserted, status }
  }

  /**
   * 运行时主动登记一条任务通知（运维/旁路入口；与 `finishAttempt` 同一实现）。
   * 重复调用同一 (task, attempt, status) 幂等：第二次 `inserted=false`。
   * @param input - 任务 + attempt + 状态 + 摘要。
   * @returns 回执登记结果（同事务读回 pending）。
   */
  async publishNotification(input: {
    readonly taskId: string
    readonly attemptNo: number
    readonly taskStatus: TaskStatus
    readonly summary: string
  }): Promise<RuntimeNotification | null> {
    return withActor(this.pool, this.actorId, async (client) => this.writeNotification(client, input))
  }

  /**
   * 读一条出站消息的当前回执（调用点 3 的读路径；插件侧派发后用同一函数确认）。
   * @param messageId - `engine_outbox.message_id`。
   * @returns 回执 JSON（status 等）；不存在返回 null。
   */
  async readMessageReceipt(messageId: string): Promise<Record<string, unknown> | null> {
    return withReadOnly(this.pool, async (client) => {
      const receipt = await readReceipt(client, messageId)
      return receipt ?? null
    })
  }

  /**
   * 回收租约过期的 Attempt（重启恢复）。
   *
   * 只处理 CLAIMED/RUNNING 且 lease_expires_at < now() 的行：标记 ABANDONED +
   * WORKER_LOST，把 Task 拉回 RETRY_WAIT（**Task ID 不变**），并把对应 Session
   * 标记 LOST。下一个 tick 会为同一个 Task 建新的 Attempt。
   * @returns 本次回收的 Attempt 列表（空数组 = 没有失联执行）。
   */
  async recoverExpiredAttempts(): Promise<readonly RecoveredAttempt[]> {
    return withActor(this.pool, this.actorId, async (client) => {
      const expired = await client.query<Record<string, unknown>>(
        `select id::text, task_id::text, attempt_no
           from recruitment.task_attempt
          where tenant_id = $1::uuid
            and status in ('CLAIMED', 'RUNNING')
            and lease_expires_at < now()
          order by lease_expires_at
          for update skip locked`,
        [this.tenantId],
      )
      const recovered: RecoveredAttempt[] = []
      for (const row of expired.rows) {
        const attemptId = String(row.id)
        const taskId = String(row.task_id)
        await client.query(
          `update recruitment.task_attempt
              set status = 'ABANDONED',
                  ended_at = now(),
                  heartbeat_at = now(),
                  error_class = 'WORKER_LOST',
                  error_code = 'LEASE_EXPIRED',
                  error_detail = 'lease expired; recovered by runtime sweep',
                  retryable = true,
                  retry_after = now()
            where tenant_id = $1::uuid and id = $2::uuid`,
          [this.tenantId, attemptId],
        )
        await client.query(
          `update recruitment.business_task
              set status = 'RETRY_WAIT',
                  current_attempt_id = null,
                  next_run_at = now(),
                  error_code = 'WORKER_LOST',
                  error_summary = 'leased worker was lost; task retried with the same business task id',
                  completed_at = null
            where tenant_id = $1::uuid and id = $2::uuid and status = 'RUNNING'`,
          [this.tenantId, taskId],
        )
        await client.query(
          `update recruitment.agent_session
              set status = 'LOST', ended_at = now(), last_heartbeat_at = now()
            where tenant_id = $1::uuid and attempt_id = $2::uuid and status = 'ACTIVE'`,
          [this.tenantId, attemptId],
        )
        recovered.push({
          taskId,
          attemptId,
          attemptNo: num(row.attempt_no),
          errorCode: 'WORKER_LOST',
        })
      }
      return recovered
    })
  }

  /** 当前可派发任务数（用于生成"可解释的空闲"原因）。 */
  async claimableTaskCount(excludedTaskTypes: readonly string[]): Promise<number> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n
           from recruitment.business_task
          where tenant_id = $1::uuid
            and status in ('PENDING', 'READY', 'RETRY_WAIT')
            and (next_run_at is null or next_run_at <= now())
            and not (task_type = any($2::text[]))`,
        [this.tenantId, [...excludedTaskTypes]],
      )
      return num(rows[0]?.n)
    })
  }
  /** 读回三层身份投影。 */
  async readTask(taskId: string): Promise<TaskRuntimeView | null> {
    return withReadOnly(this.pool, async (client) => {
      const task = await client.query<Record<string, unknown>>(
        `select * from recruitment.business_task
          where tenant_id = $1::uuid and id = $2::uuid`,
        [this.tenantId, taskId],
      )
      if (task.rows[0] === undefined) return null
      const attempts = await client.query<Record<string, unknown>>(
        `select * from recruitment.task_attempt
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by attempt_no`,
        [this.tenantId, taskId],
      )
      const sessions = await client.query<Record<string, unknown>>(
        `select * from recruitment.agent_session
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by started_at, id`,
        [this.tenantId, taskId],
      )
      const wakeups = await client.query<Record<string, unknown>>(
        `select * from recruitment.task_wakeup
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by wake_seq`,
        [this.tenantId, taskId],
      )
      return {
        task: mapTask(task.rows[0]),
        attempts: attempts.rows.map(mapAttempt),
        sessions: sessions.rows.map(mapSession),
        wakeups: wakeups.rows.map(mapWakeup),
      }
    })
  }

  /** 列出最近变更的 Task（工作台/HTTP 读回用）。 */
  async listTasks(limit: number): Promise<readonly BusinessTaskRecord[]> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `select * from recruitment.business_task
          where tenant_id = $1::uuid
          order by updated_at desc
          limit $2`,
        [this.tenantId, limit],
      )
      return rows.map(mapTask)
    })
  }

  /** 运行时计数（健康检查/证据用；不参与业务判断）。 */
  async runtimeCounts(): Promise<Record<string, number>> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `select
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid) as events,
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid and dispatch_state = 'ROUTED') as events_routed,
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid and dispatch_state = 'FAILED') as events_failed,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid) as tasks,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid and status = 'SUCCEEDED') as tasks_succeeded,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid and status = 'FAILED') as tasks_failed,
           (select count(*) from recruitment.task_attempt where tenant_id = $1::uuid) as attempts,
           (select count(*) from recruitment.agent_session where tenant_id = $1::uuid) as sessions`,
        [this.tenantId],
      )
      const row = rows[0] ?? {}
      const out: Record<string, number> = {}
      for (const [key, value] of Object.entries(row)) out[key] = num(value)
      return out
    })
  }
}


