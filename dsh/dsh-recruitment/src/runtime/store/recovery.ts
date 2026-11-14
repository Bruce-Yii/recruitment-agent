// 任务运行时恢复层（`recoverExpiredAttempts`）：从 `store.ts` 等价拆出。
//
// 时间一律由数据库 `now()` 生成（除测试注入的 retry_after 外），不信任应用时钟。

import type { DatabasePool } from '../../db/pool.ts'
import { withActor } from '../../db/pool.ts'
import { num } from './readback.ts'

/** 回收失联 Attempt 的结果。 */
export interface RecoveredAttempt {
  readonly taskId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly errorCode: string
}

/**
 * 回收租约过期的 Attempt（重启恢复）。
 *
 * 只处理 CLAIMED/RUNNING 且 lease_expires_at < now() 的行：标记 ABANDONED +
 * WORKER_LOST，把 Task 拉回 RETRY_WAIT（**Task ID 不变**），并把对应 Session
 * 标记 LOST。下一个 tick 会为同一个 Task 建新的 Attempt。
 * @returns 本次回收的 Attempt 列表（空数组 = 没有失联执行）。
 */
export async function recoverExpiredAttempts(
  pool: DatabasePool,
  tenantId: string,
  actorId: string,
): Promise<readonly RecoveredAttempt[]> {
  return withActor(pool, actorId, async (client) => {
    const expired = await client.query<Record<string, unknown>>(
      `select id::text, task_id::text, attempt_no
           from recruitment.task_attempt
          where tenant_id = $1::uuid
            and status in ('CLAIMED', 'RUNNING')
            and lease_expires_at < now()
          order by lease_expires_at
          for update skip locked`,
      [tenantId],
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
        [tenantId, attemptId],
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
        [tenantId, taskId],
      )
      await client.query(
        `update recruitment.agent_session
              set status = 'LOST', ended_at = now(), last_heartbeat_at = now()
            where tenant_id = $1::uuid and attempt_id = $2::uuid and status = 'ACTIVE'`,
        [tenantId, attemptId],
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
