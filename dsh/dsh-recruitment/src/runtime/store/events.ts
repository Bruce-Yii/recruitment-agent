// 任务运行时的**事件写入与 Task 创建/唤醒**（G12 拆分自 runtime/store.ts）。
//
// 所有写操作在一个事务里（withActor）：事件入库 + 定位业务对象 + 创建/唤醒 Task
// 必须原子提交，否则会出现"事件进了 Inbox 但没有 Task"或反过来。
// 幂等与"只唤醒一次"靠库约束（uq_event_inbox_* / task_wakeup 唯一键），不靠进程内
// 内存集合；进程重启后语义不变。
import type { DatabasePool } from '../../db/pool.ts'
import { withActor } from '../../db/pool.ts'
import type {
  BusinessObjectRef,
  InboundEvent,
  RouteDecision,
} from '../types.ts'
import { taskIdempotencyKey } from '../routing.ts'
import { enqueueEffect } from '../../engine/app/effects-async.ts'
import { iso, num } from './readback.ts'

/** `insertEvent` 的结果：本次是新入库还是命中幂等。 */
export interface InsertEventResult {
  readonly eventId: string
  readonly inserted: boolean
  readonly dispatchState: string
  readonly routedTaskId: string | null
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
export async function insertEvent(
  pool: DatabasePool, tenantId: string, actorId: string,
  event: InboundEvent,
  idempotency: { key: string; source: 'PROVIDER_EVENT_ID' | 'FALLBACK_KEY' },
): Promise<InsertEventResult> {
  return withActor(pool, actorId, async (client) => {
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
        tenantId, event.provider, event.providerEventId ?? null, event.eventType,
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
      ? [tenantId, event.provider, event.providerEventId]
      : [tenantId, idempotency.key]
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

/**
 * 标记事件已路由：dispatch 状态 + 业务对象定位 + event→task 链接。
 * 只更新运行时投影列（0011 §1.9 的白名单），事件主体不可改。
 */
export async function markEventRouted(
  pool: DatabasePool, tenantId: string, actorId: string,
  eventId: string, taskId: string, businessObject: BusinessObjectRef | null,
): Promise<boolean> {
  return withActor(pool, actorId, async (client) => {
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
      [tenantId, businessObject?.type ?? null, businessObject?.id ?? null, taskId, eventId],
    )
    return (rowCount ?? 0) > 0
  })
}

/** 标记事件被确定性 Gate 忽略（不是失败；带可读原因）。 */
export async function markEventIgnored(
  pool: DatabasePool, tenantId: string, actorId: string, eventId: string, reason: string,
): Promise<boolean> {
  return withActor(pool, actorId, async (client) => {
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
      [tenantId, reason.slice(0, 2000), eventId],
    )
    return (rowCount ?? 0) > 0
  })
}

/** 标记事件路由失败；`processed_at` 保持 null，允许后续重试。 */
export async function markEventFailed(
  pool: DatabasePool, tenantId: string, actorId: string,
  eventId: string, errorCode: string, message: string,
): Promise<boolean> {
  return withActor(pool, actorId, async (client) => {
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
      [tenantId, `${errorCode}: ${message}`.slice(0, 2000), eventId],
    )
    return (rowCount ?? 0) > 0
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
export async function createOrWakeTask(
  pool: DatabasePool, tenantId: string, actorId: string,
  input: {
    readonly decision: Extract<RouteDecision, { kind: 'deterministic' | 'semantic' }>
    readonly eventId: string
    readonly eventType: string
    readonly createdByActorId: string | null
  },
): Promise<{ taskId: string; created: boolean; wakeInserted: boolean; wakeSeq: number | null }> {
  const { decision, eventId, eventType } = input
  const key = taskIdempotencyKey(decision, eventId)
  const businessRefs = decision.kind === 'deterministic' ? [decision.businessObject] : []
  const description = decision.kind === 'deterministic'
    ? `deterministic event ${eventType} (event ${eventId})`
    : `semantic admission candidate ${eventType} (event ${eventId}); gate: ${decision.reason}`
  const initialStatus = decision.kind === 'semantic' ? 'WAITING_HUMAN' : 'PENDING'

  return withActor(pool, actorId, async (client) => {
    let taskId: string | null = null
    let created = false
    let existingStatus: string | null = null
    const existing = await client.query<{ id: string; status: string }>(
      `select id::text, status from recruitment.business_task
          where tenant_id = $1::uuid and idempotency_key = $2
          for update`,
      [tenantId, key],
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
          tenantId, decision.taskType, JSON.stringify(businessRefs), decision.taskTitle,
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
          [tenantId, key],
        )
        taskId = raced.rows[0]?.id ?? null
      }
    }
    if (taskId === null) throw new Error('TASK_CREATE_FAILED: business_task row disappeared during upsert')

    if (created) {
      await client.query(
        `insert into recruitment.task_wakeup (tenant_id, task_id, event_id, wake_seq, wake_reason)
           values ($1::uuid, $2::uuid, $3::uuid, 1, 'EVENT')`,
        [tenantId, taskId, eventId],
      )
      await client.query(
        `update recruitment.business_task
              set wake_count = 1, last_wake_event_id = $2::uuid
            where tenant_id = $1::uuid and id = $3::uuid`,
        [tenantId, eventId, taskId],
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
      [tenantId, taskId, eventId],
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
        [tenantId, eventId, taskId],
      )
      // 调用点 1b：任务正在执行时又到达新事件 → 入队 `delivery` 副作用（同事务）。
      // 运行时记录唤醒事实；把"新输入交给运行中的 Worker"这件异步动作留给插件侧
      // Effects 处理器，避免 runtime 与引擎两套投递逻辑并存。
      if (existingStatus === 'RUNNING') {
        await enqueueEffect(client, {
          tenantId: tenantId,
          kind: 'delivery',
          key: taskId,
          payload: { ticketId: taskId },
        })
      }
    }
    return { taskId, created: false, wakeInserted, wakeSeq: wakeInserted ? num(wake.rows[0].wake_seq) : null }
  })
}
