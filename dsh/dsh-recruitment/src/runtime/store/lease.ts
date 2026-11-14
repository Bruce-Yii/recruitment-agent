// 任务运行时租约/收尾层（`startAttempt` / `createAgentSession` / `finishAttempt` /
// `publishNotification` / `readMessageReceipt`）：从 `store.ts` 等价拆出。
//
// 收尾刻意**不**让 Worker 自报成功直接决定 Task 成功：`outcomeState='succeeded'`
// 只表示 Worker 报告并解析出了成功结果；真正的业务结果校验由领域服务负责
// （Notion §13「任务完成必须读回或校验业务结果，不能只相信 Worker 自报成功」）。

import type { DatabaseClient, DatabasePool } from '../../db/pool.ts'
import { withActor, withReadOnly } from '../../db/pool.ts'
import type {
  AttemptStatus,
  NotificationTarget,
  RuntimeNotification,
  TaskErrorClass,
  TaskStatus,
} from '../types.ts'
// runtime ↔ 引擎 Effects/Outbox 的唯一交界（type-only import，不会拉起同步桥 worker）。
import { readReceipt, recordOutbound } from '../../engine/app/effects-async.ts'
import { num } from './readback.ts'

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

/** 把 Attempt 从 CLAIMED 推到 RUNNING（执行前调用，开始计时）。 */
export async function startAttempt(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  attemptId: string,
  leaseMs: number,
): Promise<void> {
  await withActor(pool, actorId, async (client) => {
    await client.query(
      `update recruitment.task_attempt
            set status = 'RUNNING',
                started_at = now(),
                heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
          where tenant_id = $1::uuid and id = $3::uuid and status = 'CLAIMED'`,
      [tenantId, leaseMs, attemptId],
    )
  })
}

/**
 * 登记一次 Agent Session（执行上下文）。执行前登记，`runtime_session_id` 可后补。
 *
 * **续跑复用（G2 P0 缺陷修复，2026-11-15）**：`resumedRuntimeSessionId` 非空时，说明本次
 * Attempt 会用 `--session-id` 续跑**同一个 DSH Session**。契约
 * `contracts/runtime/task-runtime.md §1` 规定「一个 DSH Session 只能对应一行 agent_session」，
 * 因此这里按 `(tenant_id, runtime_kind, runtime_session_id)` 找既有行并**接管**它
 * （attempt_id=本次 Attempt、status=ACTIVE、last_heartbeat=now、ended_at=null），**不插新行**。
 *
 * 为什么必须这样做：旧实现每次都插新行，`finishAttempt` 再把同一个 `runtime_session_id`
 * 写回新行 → 撞 `uq_agent_session_runtime (tenant_id, runtime_kind, runtime_session_id)`，
 * 整个收尾事务回滚、Attempt 永久停在 RUNNING（现场证据见
 * `work/verify-2026-11-15-g2/B/logs/kill-worker-driver-b.log`）。
 * 找不到既有行（例如会话日志已被清理）→ 退回插入新行（正常新会话路径）。
 *
 * 接管时**不改** runtime_version / model_route：这两列描述该 DSH Session 被创建时的路由事实；
 * 续跑会话内部的模型由 DSH 会话自身钉住，改写历史会制造假审计。
 *
 * @param input - 含可选的 `resumedRuntimeSessionId`（= TaskClaim.lastRuntimeSessionId）。
 * @returns 本次 Attempt 关联的 `agent_session.id`（既有被接管行或新插入行）。
 */
export async function createAgentSession(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  input: {
    readonly taskId: string
    readonly attemptId: string
    readonly runtimeKind: string
    readonly runtimeVersion: string
    readonly modelRoute: string
    readonly runtimeWorkerRole?: 'ROUTER' | 'WORKER'
    /** 本次要续跑的 DSH Session id（`null`/缺省 = 新会话）。 */
    readonly resumedRuntimeSessionId?: string | null
  },
): Promise<string> {
  return withActor(pool, actorId, async (client) => {
    const resumed = typeof input.resumedRuntimeSessionId === 'string'
      ? input.resumedRuntimeSessionId.trim()
      : ''
    if (resumed !== '') {
      const existing = await client.query<{ id: string }>(
        `select id::text
           from recruitment.agent_session
          where tenant_id = $1::uuid
            and task_id = $2::uuid
            and runtime_kind = $3
            and runtime_session_id = $4
          for update`,
        [tenantId, input.taskId, input.runtimeKind, resumed],
      )
      const adopted = existing.rows[0]
      if (adopted !== undefined) {
        await client.query(
          `update recruitment.agent_session
              set task_id = $2::uuid,
                  attempt_id = $3::uuid,
                  status = 'ACTIVE',
                  ended_at = null,
                  last_heartbeat_at = now()
            where tenant_id = $1::uuid and id = $4::uuid`,
          [tenantId, input.taskId, input.attemptId, adopted.id],
        )
        return adopted.id
      }
    }
    const { rows } = await client.query<{ id: string }>(
      `insert into recruitment.agent_session (
           tenant_id, task_id, attempt_id, runtime_kind, runtime_version, model_route,
           status, runtime_worker_role, last_heartbeat_at
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
           'ACTIVE', $7, now()
         ) returning id::text`,
      [
        tenantId, input.taskId, input.attemptId, input.runtimeKind,
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
export async function finishAttempt(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  notification: NotificationTarget | undefined,
  input: FinishAttemptInput,
): Promise<FinishAttemptResult> {
  return withActor(pool, actorId, async (client) => {
    const attemptRow = await client.query<Record<string, unknown>>(
      `select id, attempt_no from recruitment.task_attempt
          where tenant_id = $1::uuid and id = $2::uuid and task_id = $3::uuid
          for update`,
      [tenantId, input.attemptId, input.taskId],
    )
    if (attemptRow.rows[0] === undefined) {
      throw new Error(`ATTEMPT_NOT_FOUND: ${input.attemptId} for task ${input.taskId}`)
    }
    const attemptNo = num(attemptRow.rows[0].attempt_no)
    const errorClass = input.errorClass ?? (
      input.outcomeState === 'succeeded'
        ? null
        // 契约 §3.1：waiting → WAIT_EXTERNAL；blocked → WAIT_EXTERNAL（= 等外部/人等事实，
        // 不是瞬态故障）。此前一律落 TRANSIENT，审计会把"等人"误读成"网络抖动"（C 复核 D-5）。
        : input.outcomeState === 'waiting' || input.outcomeState === 'blocked'
          ? 'WAIT_EXTERNAL'
          : 'TRANSIENT'
    )
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
        tenantId, attemptStatus, input.resultRef ?? input.rawOutputRef, errorClass,
        input.errorCode, input.outcomeState === 'succeeded' ? null : input.summary.slice(0, 4000),
        input.retryable,
        // FAILED_RETRYABLE 的 CHECK 要求 retry_after 非空。
        // 口径与 Task 的 next_run_at **同源**（failed=retryAfter??30s / waiting=1h / blocked=24h）：
        // 此前 Attempt 一律写 +30s，导致 attempt.retry_after 与 task.next_run_at 打架（C 复核 D-6），
        // 审计读回会误判"什么时候会再跑"。
        attemptStatus === 'FAILED_RETRYABLE' ? (taskNextRunAt ?? new Date(Date.now() + 30_000).toISOString()) : null,
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
        tenantId, taskStatus, taskResultRef, taskErrorCode, taskErrorSummary,
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
        tenantId,
        input.outcomeState === 'failed' && errorClass === 'WORKER_LOST' ? 'LOST' : 'ENDED',
        input.runtimeSessionId, input.agentSessionId,
      ],
    )

    // 4) 调用点 2/3：需要人/最终失败时登记出站通知，并**同事务读回**回执状态。
    //    `recordOutbound` 会同时入队 `reply` effect；runtime 不再单独写
    //    `engine_outbox`/`durable_effect`，避免两套回执。
    const notificationReceipt = await writeNotification(client, tenantId, notification, {
      taskId: input.taskId,
      attemptNo,
      taskStatus,
      summary: input.summary,
    })

    return {
      taskStatus,
      attemptStatus,
      errorCode: taskErrorCode,
      notification: notificationReceipt,
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
async function writeNotification(
  client: DatabaseClient,
  tenantId: string,
  notification: NotificationTarget | undefined,
  input: {
    readonly taskId: string
    readonly attemptNo: number
    readonly taskStatus: TaskStatus
    readonly summary: string
  },
): Promise<RuntimeNotification | null> {
  const target = notification
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
  const inserted = await recordOutbound(client, { tenantId: tenantId, message })
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
export async function publishNotification(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
  notification: NotificationTarget | undefined,
  input: {
    readonly taskId: string
    readonly attemptNo: number
    readonly taskStatus: TaskStatus
    readonly summary: string
  },
): Promise<RuntimeNotification | null> {
  return withActor(pool, actorId, async (client) => writeNotification(client, tenantId, notification, input))
}

/**
 * 读一条出站消息的当前回执（调用点 3 的读路径；插件侧派发后用同一函数确认）。
 * @param messageId - `engine_outbox.message_id`。
 * @returns 回执 JSON（status 等）；不存在返回 null。
 */
export async function readMessageReceipt(
  pool: DatabasePool,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  return withReadOnly(pool, async (client) => {
    const receipt = await readReceipt(client, messageId)
    return receipt ?? null
  })
}
