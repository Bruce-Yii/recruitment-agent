// 任务运行时认领层（`claimNextTask` / `claimTask`）：从 `store.ts` 等价拆出。
//
//   * **所有写操作在一个事务里**：事件入库 + 定位业务对象 + 创建/唤醒 Task 必须
//     原子提交，否则会出现"事件进了 Inbox 但没有 Task"或反过来；
//   * actor 通过 `withActor` 的 `SET LOCAL recruitment.actor_id` 传入，不用全局 SET
//     （0001 的 fn_row_guard 要求状态迁移可以确定 actor）；

import type { DatabaseClient, DatabasePool } from '../../db/pool.ts'
import { withActor } from '../../db/pool.ts'
import type { BusinessObjectRef } from '../types.ts'
// runtime ↔ 引擎 Effects/Outbox 的唯一交界（type-only import，不会拉起同步桥 worker）。
import { enqueueEffect } from '../../engine/app/effects-async.ts'
import { iso, isoRequired, mapBusinessRefs, num } from './readback.ts'

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

/**
 * 认领下一个可执行 Task（Router 调用）。
 *
 * 用 `FOR UPDATE SKIP LOCKED` + `uq_task_attempt_active_lease` 双保险：
 * 即使两个 Router 进程同时 tick，也只有一个能拿到同一个 Task；状态改写为
 * RUNNING 后，第二个 tick 的 where 条件自然不再命中。
 * @param input - worker 身份 + 租约 + 不自动派发的任务类型。
 * @returns 认领结果；没有可执行任务时返回 null。
 */
export async function claimNextTask(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
    readonly excludedTaskTypes: readonly string[]
  },
): Promise<TaskClaim | null> {
  return withActor(pool, actorId, async (client) => {
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
      [tenantId, [...input.excludedTaskTypes]],
    )
    const row = candidate.rows[0]
    if (row === undefined) return null
    return insertAttemptAndMarkRunning(client, tenantId, {
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
export async function claimTask(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  taskId: string,
  input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
  },
): Promise<TaskClaim | null> {
  return withActor(pool, actorId, async (client) => {
    const candidate = await client.query<Record<string, unknown>>(
      `select id::text, task_type, title, description, business_refs, priority
           from recruitment.business_task
          where tenant_id = $1::uuid and id = $2::uuid
            and status in ('PENDING', 'READY', 'RETRY_WAIT')
            and (next_run_at is null or next_run_at <= now())
          for update`,
      [tenantId, taskId],
    )
    const row = candidate.rows[0]
    if (row === undefined) return null
    return insertAttemptAndMarkRunning(client, tenantId, {
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

async function insertAttemptAndMarkRunning(
  client: DatabaseClient,
  tenantId: string,
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
    [tenantId, input.taskId],
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
      tenantId, input.taskId, attemptNo, input.workerType, input.workerId,
      input.leaseMs, `runtime:${tenantId}:${input.taskId}:${attemptNo}`,
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
    [tenantId, attemptId, attemptNo, input.taskId],
  )
  // 调用点 1a：派发任务前把 `launch` 副作用原子入队（与 Attempt/Task 写入同事务）。
  // payload 用引擎的 launch 形状；runtime 的 task/attempt 映射到 ticket/assignment 两个字段，
  // 插件侧的 Effects 处理器据 key（= attemptId）决定要做什么，不反写任务身份。
  await enqueueEffect(client, {
    tenantId: tenantId,
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
    [tenantId, input.taskId],
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
