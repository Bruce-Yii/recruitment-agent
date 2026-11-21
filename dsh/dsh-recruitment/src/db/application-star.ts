// application_star 的 DB 访问层（迁移 0021 建表；本文件只读写这一张表）。
//
// 纪律：
//   1. **append-only**：本文件没有任何 DELETE / UPDATE；星标切换只 INSERT 一行事实。
//   2. **当前值 = 最新一行**：按 (tenant_id, application_id) 取 created_at desc, id desc 的第一行；
//      无行 = false（在 HTTP 层处理，不在 DB 造默认行）。
//   3. **tenant 隔离**：所有语句都带 tenant_id（含外键列与查询条件）。
//   4. 自己不开/提交事务：写入跑在调用方 withActor(client) 里（actor_id 由 session 绑定注入）；
//      读取跑在调用方 withReadOnly(client) 里。
//   5. 字段名即契约（与 db/migrations/0021 的权威 schema 逐字一致），不要改名。

import type { DatabaseClient } from './pool.ts'

/** 一次星标切换事实（写）。 */
export interface ApplicationStarInsert {
  readonly tenant_id: string
  readonly application_id: string
  readonly starred: boolean
  readonly actor_id: string
  readonly confirmation_text_sha256: string
}

/** application_star 一行（只读查询的投影）。 */
export interface ApplicationStarRow {
  readonly id: string
  readonly tenant_id: string
  readonly application_id: string
  readonly starred: boolean
  readonly actor_id: string
  readonly confirmation_text_sha256: string
  readonly created_at: Date | string
}

/**
 * 在同一事务 client 里插一行星标事实；返回该行 id。
 * 不做"先查后插"去重：同一申请重复切换是**两次独立的人工判断**，各自留痕（append-only）。
 */
export async function insertApplicationStar(
  client: DatabaseClient,
  input: ApplicationStarInsert,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.application_star
       (tenant_id, application_id, starred, actor_id, confirmation_text_sha256)
     values ($1, $2, $3, $4, $5)
     returning id`,
    [
      input.tenant_id,
      input.application_id,
      input.starred,
      input.actor_id,
      input.confirmation_text_sha256,
    ],
  )
  const id = inserted.rows[0]?.id
  if (id === undefined) {
    throw new Error('insertApplicationStar: insert returned no id')
  }
  return id
}

/**
 * 在同一只读事务 client 里取某申请的最新一行星标事实；没有行 → undefined。
 * 排序与迁移的当前值索引一致（created_at desc, id desc 兜底）。
 */
export async function findLatestApplicationStar(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationStarRow | undefined> {
  const { rows } = await client.query<ApplicationStarRow>(
    `select id::text                         as id,
            tenant_id::text                  as tenant_id,
            application_id::text             as application_id,
            starred                          as starred,
            actor_id::text                   as actor_id,
            confirmation_text_sha256         as confirmation_text_sha256,
            created_at                       as created_at
       from recruitment.application_star
      where tenant_id = $1 and application_id = $2
      order by created_at desc, id desc
      limit 1`,
    [tenantId, applicationId],
  )
  return rows[0]
}

/**
 * 批量取多个申请的最新星标行（读投影用；表不存在时由调用方 to_regclass 探测后跳过）。
 * 返回 Map<application_id, starred>：只含"有星标行"的申请，无行 = 不在 map 里（调用方当 false）。
 */
export async function findLatestStarsForApplications(
  client: DatabaseClient,
  tenantId: string,
  applicationIds: readonly string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  if (applicationIds.length === 0) return out
  const { rows } = await client.query<{ application_id: string; starred: boolean; created_at: Date | string; id: string }>(
    `select distinct on (application_id)
            application_id::text as application_id,
            starred              as starred,
            created_at           as created_at,
            id::text             as id
       from recruitment.application_star
      where tenant_id = $1 and application_id = any($2::uuid[])
      order by application_id, created_at desc, id desc`,
    [tenantId, [...applicationIds]],
  )
  for (const row of rows) out.set(row.application_id, row.starred === true)
  return out
}
