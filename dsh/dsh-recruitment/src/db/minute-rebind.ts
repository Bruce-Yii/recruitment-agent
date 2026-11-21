// 妙记录音归属改绑 · DB 适配器（append-only 审计事实表；**不自己开事务**）。
//
// 职责边界：
//   * 本模块只认已解析好的 tenant_id / interview_id / from/to/requested actor / minute_token /
//     confirmation_text_sha256 / cli_summary；session→actor、本人可管校验、原话 sha256 计算
//     由 HTTP 层（src/http/minute-rebind.ts）在碰 DB 之前/事务里完成。
//   * 所有写操作跑在调用方的事务里（HTTP 用 withActor 包）；只读函数跑在只读事务里。
//   * **幂等**：唯一键 (tenant, interview, minute_token, to_actor_id)。外部写之前先只读查
//     `findByIdempotencyKey`，命中就不调 CLI、不再写；并发下由唯一约束兜底
//     （唯一冲突 → REBIND_ALREADY_DONE，零外部写、零审计行）。
//   * 失败的路径**不写审计表**（只有 CLI 成功/ dry-run 成功才 INSERT），失败可重试。
//
// 表契约见 db/migrations/0023_minute_rebind.sql。
import type { DatabaseClient } from './pool.ts'
import { RecruitmentToolError, type RecruitmentErrorCode } from '../tools/errors.ts'

/** 审计行（签名与库表一致）。 */
export interface MinuteRebindRow {
  readonly id: string
  readonly tenant_id: string
  readonly interview_id: string
  readonly from_actor_id: string
  readonly to_actor_id: string
  readonly requested_by_actor_id: string
  readonly minute_token: string
  readonly confirmation_text_sha256: string
  readonly cli_summary: Record<string, unknown>
  readonly dry_run: boolean
  readonly created_at: Date | string
}

/** 写一行审计事实的参数（身份全部由服务端解析，不接受客户端传 actor/tenant）。 */
export interface AppendMinuteRebindParams {
  readonly tenant_id: string
  readonly interview_id: string
  readonly from_actor_id: string
  readonly to_actor_id: string
  readonly requested_by_actor_id: string
  readonly minute_token: string
  readonly confirmation_text_sha256: string
  readonly cli_summary: Record<string, unknown>
  readonly dry_run: boolean
}

/** 幂等命中结果。 */
export type FindRebindResult =
  | { readonly found: true; readonly record: MinuteRebindRow }
  | { readonly found: false }

/** 写结果（供 HTTP 层独立读回）。 */
export interface AppendRebindResult {
  readonly rebind_id: string
}

function fail(code: RecruitmentErrorCode, reasonCode: string, message: string): never {
  throw new RecruitmentToolError(code, JSON.stringify({ reason_code: reasonCode, message }))
}

/**
 * 只读查幂等键（调用方应放在事务里，且必须在调 CLI 之前跑）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（服务端配置）。
 * @param interviewId - 面试 id。
 * @param minuteToken - 妙记 token。
 * @param toActorId - 新面试官 actor id。
 */
export async function findByIdempotencyKey(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  minuteToken: string,
  toActorId: string,
): Promise<FindRebindResult> {
  const { rows } = await client.query<MinuteRebindRow>(
    `select id::text, tenant_id::text, interview_id::text, from_actor_id::text, to_actor_id::text,
            requested_by_actor_id::text, minute_token, confirmation_text_sha256, cli_summary,
            dry_run, created_at
       from recruitment.minute_rebind
      where tenant_id = $1 and interview_id = $2 and minute_token = $3 and to_actor_id = $4
      limit 1`,
    [tenantId, interviewId, minuteToken, toActorId],
  )
  const row = rows[0]
  return row === undefined ? { found: false } : { found: true, record: row }
}

/**
 * 追加一行审计事实（调用方须在 withActor 事务里；失败整体回滚 = 零写入）。
 *
 * 唯一冲突 = 同一幂等键已有行（并发下另一个请求抢先写了）→ REBIND_ALREADY_DONE，
 * HTTP 层据此返回 409，且**不再调 CLI**（调用顺序：先 CLI、后写审计；冲突时 CLI 已经调过了，
 * 所以 HTTP 层必须在调 CLI 之前再做一次只读幂等检查以缩小窗口；这里只兜底并发写入）。
 * @param client - 事务内客户端。
 * @param params - 已校验的写参数。
 */
export async function appendMinuteRebind(
  client: DatabaseClient,
  params: AppendMinuteRebindParams,
): Promise<AppendRebindResult> {
  try {
    const inserted = await client.query<{ id: string }>(
      `insert into recruitment.minute_rebind
          (tenant_id, interview_id, from_actor_id, to_actor_id, requested_by_actor_id,
           minute_token, confirmation_text_sha256, cli_summary, dry_run)
        values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
        returning id::text as id`,
      [
        params.tenant_id, params.interview_id, params.from_actor_id, params.to_actor_id,
        params.requested_by_actor_id, params.minute_token, params.confirmation_text_sha256,
        JSON.stringify(params.cli_summary), params.dry_run,
      ],
    )
    const row = inserted.rows[0]
    if (row === undefined) throw new Error('insert into minute_rebind returned no row')
    return { rebind_id: row.id }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === '23505') {
      fail('FORBIDDEN', 'REBIND_ALREADY_DONE', '同一场面试的同一份妙记已改绑给这位面试官（幂等，不再执行第二次外部写）')
    }
    throw error
  }
}

/** 审计行 → 只读投影（不吐 tenant 等内部机器字段）。 */
export function toRebindProjection(row: MinuteRebindRow): Record<string, unknown> {
  return {
    rebind_id: row.id,
    interview_id: row.interview_id,
    from_actor_id: row.from_actor_id,
    to_actor_id: row.to_actor_id,
    requested_by_actor_id: row.requested_by_actor_id,
    minute_token: row.minute_token,
    dry_run: row.dry_run,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  }
}
