// batch_operation / undo_log 的 DB 访问层（迁移 0020 建表；本文件只读写这两张表）。
//
// 纪律：
//   1. **幂等靠 SQL**：`insert ... on conflict (...) do nothing` + 读回 id。
//      绝不用应用层"先查后插"的竞态写法（两个并发撤销会各插一行）。
//   2. **tenant 隔离**：所有语句都带 tenant_id（含唯一键、条件更新）。
//   3. **只存摘要**：target_summary / before_summary / after_summary 只放 id、状态、
//      version、reason_code 等引用，不写简历原文或大段业务内容。
//   4. **append-only**：本文件没有任何 DELETE；补偿动作是新增行 + 条件更新指针。
//   5. 自己不开/提交事务；全部在调用方传入的事务 client 里执行。
//
// 字段名即契约（与 db/migrations/0020 的权威 schema 逐字一致），不要改名。

import type { DatabaseClient } from './pool.ts'

/** 一次批量不通过 = batch_operation 一行。 */
export interface BatchOperationInsert {
  readonly tenant_id: string
  readonly action_id: string
  readonly operation_type: 'BATCH_REJECT' | 'UNDO'
  readonly actor_id: string
  readonly reason: string
  readonly confirmation_text_sha256: string
  readonly target_count: number
  readonly succeeded_count: number
  readonly failed_count: number
  readonly target_summary: readonly { application_id: string; ok: boolean; reason_code?: string }[]
}

/** undo_log 一行（ORIGINAL 或 COMPENSATION）。 */
export interface UndoLogInsert {
  readonly tenant_id: string
  readonly action_id: string
  readonly kind: 'ORIGINAL' | 'COMPENSATION'
  readonly operation_type: 'BATCH_REJECT' | 'SINGLE_DECISION' | 'SINGLE_SCHEDULE' | 'UNDO'
  readonly actor_id: string
  readonly reason: string
  readonly confirmation_text_sha256: string
  readonly target_application_id?: string | null
  readonly target_decision_id?: string | null
  readonly target_interview_id?: string | null
  readonly action_type?: 'DECISION' | 'SCHEDULE' | null
  readonly before_summary?: Record<string, unknown>
  readonly after_summary?: Record<string, unknown>
  readonly compensation_action_id?: string | null
  readonly superseded_by_action_id?: string | null
}

/** undo_log 完整行（只读查询的投影）。 */
export interface UndoLogRow {
  readonly id: string
  readonly tenant_id: string
  readonly action_id: string
  readonly kind: 'ORIGINAL' | 'COMPENSATION'
  readonly operation_type: string
  readonly actor_id: string
  readonly occurred_at: Date
  readonly reason: string
  readonly confirmation_text_sha256: string
  readonly target_application_id: string | null
  readonly target_decision_id: string | null
  readonly target_interview_id: string | null
  readonly action_type: 'DECISION' | 'SCHEDULE' | null
  readonly before_summary: Record<string, unknown>
  readonly after_summary: Record<string, unknown>
  readonly compensation_action_id: string | null
  readonly superseded_by_action_id: string | null
}

/**
 * 在同一事务 client 里插一行 batch_operation；返回 id。
 * 幂等：同 (tenant_id, action_id) 已存在则不插，返回已有 id（零写入第二条）。
 */
export async function insertBatchOperation(
  client: DatabaseClient,
  input: BatchOperationInsert,
): Promise<string> {
  // ON CONFLICT DO NOTHING 是幂等的 SQL 层保证：重复提交根本没有第二条 INSERT 生效。
  // RETURNING 为空 ⇒ 已有同键行，读回其 id 即可（读回也在同一事务里）。
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.batch_operation
       (tenant_id, action_id, operation_type, actor_id, reason, confirmation_text_sha256,
        target_count, succeeded_count, failed_count, target_summary)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     on conflict (tenant_id, action_id) do nothing
     returning id`,
    [
      input.tenant_id,
      input.action_id,
      input.operation_type,
      input.actor_id,
      input.reason,
      input.confirmation_text_sha256,
      input.target_count,
      input.succeeded_count,
      input.failed_count,
      JSON.stringify(input.target_summary),
    ],
  )
  const id = inserted.rows[0]?.id
  if (id !== undefined) return id

  const existing = await client.query<{ id: string }>(
    `select id from recruitment.batch_operation where tenant_id = $1 and action_id = $2`,
    [input.tenant_id, input.action_id],
  )
  const existingId = existing.rows[0]?.id
  if (existingId === undefined) {
    throw new Error('insertBatchOperation: insert was swallowed but no existing row found')
  }
  return existingId
}

/**
 * 插一行 undo_log；幂等同 (tenant_id, action_id, kind) 已存在则返回已有 id，零写入第二条。
 */
export async function insertUndoLog(
  client: DatabaseClient,
  input: UndoLogInsert,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.undo_log
       (tenant_id, action_id, kind, operation_type,
        target_application_id, target_decision_id, target_interview_id, action_type,
        actor_id, reason, confirmation_text_sha256,
        before_summary, after_summary, compensation_action_id, superseded_by_action_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15)
     on conflict (tenant_id, action_id, kind) do nothing
     returning id`,
    [
      input.tenant_id,
      input.action_id,
      input.kind,
      input.operation_type,
      input.target_application_id ?? null,
      input.target_decision_id ?? null,
      input.target_interview_id ?? null,
      input.action_type ?? null,
      input.actor_id,
      input.reason,
      input.confirmation_text_sha256,
      JSON.stringify(input.before_summary ?? {}),
      JSON.stringify(input.after_summary ?? {}),
      input.compensation_action_id ?? null,
      input.superseded_by_action_id ?? null,
    ],
  )
  const id = inserted.rows[0]?.id
  if (id !== undefined) return id

  const existing = await client.query<{ id: string }>(
    `select id from recruitment.undo_log where tenant_id = $1 and action_id = $2 and kind = $3`,
    [input.tenant_id, input.action_id, input.kind],
  )
  const existingId = existing.rows[0]?.id
  if (existingId === undefined) {
    throw new Error('insertUndoLog: insert was swallowed but no existing row found')
  }
  return existingId
}

const UNDO_LOG_COLUMNS = `
  id, tenant_id, action_id, kind, operation_type, actor_id, occurred_at,
  reason, confirmation_text_sha256,
  target_application_id, target_decision_id, target_interview_id, action_type,
  before_summary, after_summary, compensation_action_id, superseded_by_action_id`

/** 只读查某 action_id 的 ORIGINAL 行；没有 → undefined。 */
export async function findUndoLogOriginal(
  client: DatabaseClient,
  tenantId: string,
  actionId: string,
): Promise<UndoLogRow | undefined> {
  const { rows } = await client.query<UndoLogRow>(
    `select ${UNDO_LOG_COLUMNS} from recruitment.undo_log
      where tenant_id = $1 and action_id = $2 and kind = 'ORIGINAL'`,
    [tenantId, actionId],
  )
  return rows[0]
}

/** 只读查某 action_id 是否已有 COMPENSATION 行（用于幂等第二次撤销）。 */
export async function findUndoLogCompensation(
  client: DatabaseClient,
  tenantId: string,
  actionId: string,
): Promise<UndoLogRow | undefined> {
  const { rows } = await client.query<UndoLogRow>(
    `select ${UNDO_LOG_COLUMNS} from recruitment.undo_log
      where tenant_id = $1 and action_id = $2 and kind = 'COMPENSATION'`,
    [tenantId, actionId],
  )
  return rows[0]
}

/**
 * 在同一事务里把 ORIGINAL 行的 compensation_action_id 指到新补偿行
 * （带 tenant + compensation_action_id is null 条件）。
 * 返回影响行数；0 表示已被别人抢先撤销（调用方据此判 UNDO_SUPERSEDED / ALREADY_UNDONE）。
 */
export async function linkCompensation(
  client: DatabaseClient,
  tenantId: string,
  actionId: string,
  compensationActionId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `update recruitment.undo_log
        set compensation_action_id = $3
      where tenant_id = $1 and action_id = $2 and kind = 'ORIGINAL'
        and compensation_action_id is null`,
    [tenantId, actionId, compensationActionId],
  )
  return rowCount ?? 0
}

/** 把某 action_id 的 ORIGINAL 行标记为"已被后续动作影响"（条件更新；返回影响行数）。 */
export async function markSuperseded(
  client: DatabaseClient,
  tenantId: string,
  actionId: string,
  supersedingActionId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `update recruitment.undo_log
        set superseded_by_action_id = $3
      where tenant_id = $1 and action_id = $2 and kind = 'ORIGINAL'
        and superseded_by_action_id is null`,
    [tenantId, actionId, supersedingActionId],
  )
  return rowCount ?? 0
}

/** 只读查 batch_operation 行（写后读回审计用）。 */
export async function findBatchOperation(
  client: DatabaseClient,
  tenantId: string,
  actionId: string,
): Promise<{ id: string; target_count: number; succeeded_count: number; failed_count: number; target_summary: Record<string, unknown> } | undefined> {
  const { rows } = await client.query<{
    id: string
    target_count: number
    succeeded_count: number
    failed_count: number
    target_summary: Record<string, unknown>
  }>(
    `select id, target_count, succeeded_count, failed_count, target_summary
       from recruitment.batch_operation
      where tenant_id = $1 and action_id = $2`,
    [tenantId, actionId],
  )
  return rows[0]
}
