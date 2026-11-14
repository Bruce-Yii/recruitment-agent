// 任务运行时 PostgreSQL 读层的**行映射与事件读回**（G12 拆分自 runtime/store.ts）。
//
// 职责：只读事务里的 SQL 读 + 行映射（事件行、三层身份投影）。这里只做 SQL 和行
// 映射，不做业务判断：事件走哪条路径在 routing.ts，Attempt 怎么收尾在 task-runtime.ts。
//
// 本模块是拆分层里的叶子底座：标量/行映射辅助函数（num/iso/isoRequired/mapBusinessRefs）
// 导出给 events/counts/claim/lease 复用；mapTask/mapAttempt/mapSession/mapWakeup 仅本
// 模块内部使用（readTask 组装 TaskRuntimeView）。
import type { DatabasePool } from '../../db/pool.ts'
import { withReadOnly } from '../../db/pool.ts'
import { EVENT_DISPATCHABLE_SQL } from '../cutover.ts'
import type {
  AgentSessionRecord,
  AttemptStatus,
  BusinessObjectRef,
  BusinessTaskRecord,
  TaskAttemptRecord,
  TaskErrorClass,
  TaskRuntimeView,
  TaskStatus,
  TaskWakeupRecord,
} from '../types.ts'

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

export const num = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return 0
}

export const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export const isoRequired = (value: unknown): string => iso(value) ?? ''

export function mapBusinessRefs(value: unknown): BusinessObjectRef[] {
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

/** 读回一条事件（重放待路由事件 / 重复事件回执用）。 */
export async function getEvent(
  pool: DatabasePool, tenantId: string, eventId: string,
): Promise<EventRow | null> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select event_id::text, provider, provider_event_id, event_type, schema_version,
                occurred_at, payload, source_object_id, payload_ref, trust_level,
                idempotency_key, correlation_id, causation_id, dispatch_state, route_attempts,
                business_object_type, business_object_id
           from recruitment.event_inbox
          where tenant_id = $1::uuid and event_id = $2::uuid`,
      [tenantId, eventId],
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

/**
 * 按**事件行自身的事实**解析业务对象：材料到达事件 → `intake_record.event_id`。
 *
 * 为什么需要它（不是"顺手加个查询"）：
 * `resume.intake.received` 的 payload 只有 `sha256 / file_name / pages / source_kind`
 * （`application-intake.ts` 的 `upsertIntakeEvent`），`source_object_id` 是原件 sha256
 * ——**都不是 UUID**。而 `intake` 是先写事件、后建 application，所以这层里唯一真实
 * 存在的业务对象是那条 `intake_record`（它的 `event_id` 指回本事件）。
 *
 * 纪律：查不到就返回 `null`，由路由层落 `BUSINESS_OBJECT_NOT_FOUND`（不猜 ID）。
 * @param eventId - 事件 id。
 * @returns `intake_record.id`；没有（或不止一条的异常情况按最早一条）→ 取最早一条。
 */
export async function intakeRecordIdForEvent(
  pool: DatabasePool, tenantId: string, eventId: string,
): Promise<string | null> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `select id::text
           from recruitment.intake_record
          where tenant_id = $1::uuid and event_id = $2::uuid
          order by created_at, id
          limit 1`,
      [tenantId, eventId],
    )
    return rows[0]?.id ?? null
  })
}

/**
 * 待路由事件（RECEIVED 或 FAILED 且未到重试上限，**且已跨过 cutover 水位**）。
 *
 * `received_at >= runtime_watermark.cutover_at` 是 SQL 的结构条件（JOIN），不是
 * 可选参数：没有水位行时这里一行都取不到 —— "取数必须尊重水位"不能依赖调用方
 * 记得传值。历史事件由 `RuntimeCutoverStore.sweepBefore()` 标 IGNORED，不进本查询。
 */
export async function listPendingEvents(
  pool: DatabasePool, tenantId: string, limit: number, maxAttempts: number,
): Promise<readonly string[]> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<{ event_id: string }>(
      `select e.event_id::text
           from recruitment.event_inbox e
           join recruitment.runtime_watermark w
             on w.tenant_id = e.tenant_id
            and e.received_at >= w.cutover_at
          where e.tenant_id = $1::uuid
            and ${EVENT_DISPATCHABLE_SQL}
          order by e.received_at
          limit $3`,
      [tenantId, maxAttempts, limit],
    )
    return rows.map((row) => row.event_id)
  })
}

/** 已有事件对应的 Task（重复事件回执；没路由过返回 null）。 */
export async function taskForEvent(
  pool: DatabasePool, tenantId: string, eventId: string,
): Promise<string | null> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<{ routed_task_id: string | null }>(
      `select routed_task_id::text from recruitment.event_inbox
          where tenant_id = $1::uuid and event_id = $2::uuid`,
      [tenantId, eventId],
    )
    return rows[0]?.routed_task_id ?? null
  })
}

/** 读回三层身份投影。 */
export async function readTask(
  pool: DatabasePool, tenantId: string, taskId: string,
): Promise<TaskRuntimeView | null> {
  return withReadOnly(pool, async (client) => {
    const task = await client.query<Record<string, unknown>>(
      `select * from recruitment.business_task
          where tenant_id = $1::uuid and id = $2::uuid`,
      [tenantId, taskId],
    )
    if (task.rows[0] === undefined) return null
    const attempts = await client.query<Record<string, unknown>>(
      `select * from recruitment.task_attempt
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by attempt_no`,
      [tenantId, taskId],
    )
    const sessions = await client.query<Record<string, unknown>>(
      `select * from recruitment.agent_session
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by started_at, id`,
      [tenantId, taskId],
    )
    const wakeups = await client.query<Record<string, unknown>>(
      `select * from recruitment.task_wakeup
          where tenant_id = $1::uuid and task_id = $2::uuid
          order by wake_seq`,
      [tenantId, taskId],
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
export async function listTasks(
  pool: DatabasePool, tenantId: string, limit: number,
): Promise<readonly BusinessTaskRecord[]> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select * from recruitment.business_task
          where tenant_id = $1::uuid
          order by updated_at desc
          limit $2`,
      [tenantId, limit],
    )
    return rows.map(mapTask)
  })
}
