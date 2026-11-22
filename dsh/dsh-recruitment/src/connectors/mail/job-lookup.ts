// 在招岗位查询（自动分岗用）。只读 recruitment.job，零写入。
// 只从 mail 连接器目录内调用；不触碰 recruiting.ts / intake-upload.ts / 写链路。

import { withActor, type DatabaseClient, type DatabasePool, type ResolvedDatabaseConfig } from '../../db/pool.ts'
import { toJobCandidates, type MailJobCandidate } from './match.ts'

/** 在招岗位状态（与 job-create.ts 的 ck_job_status 一致：只有 OPEN 算在招）。 */
export const OPEN_JOB_STATUS = 'OPEN'

/**
 * 查询租户下所有在招岗位（code/title/id）。只读；查询失败向上抛，
 * 由调用方 fail-closed（本轮不分岗，下周期重试）。
 */
export async function listOpenJobs(
  pool: DatabasePool,
  db: ResolvedDatabaseConfig,
): Promise<readonly MailJobCandidate[]> {
  const rows = await withActor(pool, db.actor_id, (client: DatabaseClient) =>
    client.query<{ id: string; code: string | null; title: string | null; status: string }>(
      `select id, code, title, status from recruitment.job
        where tenant_id = $1 and status = $2`,
      [db.tenant_id, OPEN_JOB_STATUS],
    ))
  return toJobCandidates(rows.rows)
}
