// 生产登录的库访问层（Issue #61 / D-178）。
//
// 只走 `pg` 参数绑定；租户来自服务端配置，不接受请求参数。
// 口令哈希与会话 token 都不明文落库：库里分别是 scrypt 串和 token 的 sha256。
// 每个调用自己建短连接池并在 finally 关闭（与 http/star.ts 同款，避免空闲 socket 挂宿主）。

import { createHash, randomBytes, randomUUID } from 'node:crypto'

import {
  closePool,
  createPool,
  type ResolvedDatabaseConfig,
} from './pool.ts'
import { normalizeUsername } from '../auth/credentials.ts'

/** 登录用户（库行投影；绝不包含明文口令）。 */
export interface AuthUserRow {
  readonly id: string
  readonly tenant_id: string
  readonly username: string
  readonly password_hash: string
  readonly display_name: string
  readonly alias: string
}

/** 会话记录（库行投影；token 只有 sha256）。 */
export interface AuthSessionRow {
  readonly session_id: string
  readonly username: string
  readonly alias: string
  readonly display_name: string
  readonly expires_at: Date
}

/** 一次成功登录的产物：token 只在这里出现一次（随后只留 sha256 在库里）。 */
export interface IssuedAuthSession {
  readonly token: string
  readonly sessionId: string
  readonly username: string
  readonly alias: string
  readonly displayName: string
  readonly expiresAt: Date
}

/** 会话有效期（小时）；cookie Max-Age 由同一值推导。 */
export const AUTH_SESSION_TTL_HOURS = 24

/** token 字节数（32 字节 → 64 hex）。 */
const TOKEN_BYTES = 32

export function tokenSha256(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 按用户名找未禁用用户（租户由服务端配置固定）。 */
export async function findAuthUser(
  config: ResolvedDatabaseConfig,
  usernameRaw: unknown,
): Promise<AuthUserRow | null> {
  const username = normalizeUsername(usernameRaw)
  if (username === null) return null
  const pool = createPool(config)
  try {
    const { rows } = await pool.query<AuthUserRow>(
      `select id::text as id, tenant_id::text as tenant_id, username, password_hash,
              display_name, alias
         from recruitment.auth_user
        where tenant_id = $1::uuid and username = $2 and disabled_at is null
        limit 1`,
      [config.tenant_id, username],
    )
    return rows[0] ?? null
  } finally {
    await closePool(pool)
  }
}

/** 新建一条持久会话；返回明文 token（只此一次可见）。 */
export async function insertAuthSession(
  config: ResolvedDatabaseConfig,
  user: AuthUserRow,
): Promise<IssuedAuthSession> {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const sessionId = `session-${randomUUID()}`
  const expiresAt = new Date(Date.now() + AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000)
  const pool = createPool(config)
  try {
    await pool.query(
      `insert into recruitment.auth_session
         (tenant_id, session_id, token_sha256, username, alias, display_name, expires_at)
       values ($1::uuid, $2, $3, $4, $5, $6, $7)`,
      [config.tenant_id, sessionId, tokenSha256(token), user.username, user.alias, user.display_name, expiresAt],
    )
  } finally {
    await closePool(pool)
  }
  return { token, sessionId, username: user.username, alias: user.alias, displayName: user.display_name, expiresAt }
}

/**
 * 按 token 读一条未撤销且未过期的会话。
 * 只读事务之外的普通查询即可；这里只做一行 select，不改任何数据。
 */
export async function findAuthSession(
  config: ResolvedDatabaseConfig,
  token: string,
): Promise<AuthSessionRow | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  const pool = createPool(config)
  try {
    const { rows } = await pool.query<{
      session_id: string
      username: string
      alias: string
      display_name: string
      expires_at: Date
    }>(
      `select session_id, username, alias, display_name, expires_at
         from recruitment.auth_session
        where tenant_id = $1::uuid and token_sha256 = $2
          and revoked_at is null and expires_at > now()
        limit 1`,
      [config.tenant_id, tokenSha256(token)],
    )
    const row = rows[0]
    return row === undefined ? null : { ...row }
  } finally {
    await closePool(pool)
  }
}

/** 撤销一条会话（logout 立即生效：之后同一 token 一律 401）。 */
export async function revokeAuthSession(
  config: ResolvedDatabaseConfig,
  token: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(token)) return
  const pool = createPool(config)
  try {
    await pool.query(
      `update recruitment.auth_session
          set revoked_at = now()
        where tenant_id = $1::uuid and token_sha256 = $2 and revoked_at is null`,
      [config.tenant_id, tokenSha256(token)],
    )
  } finally {
    await closePool(pool)
  }
}
