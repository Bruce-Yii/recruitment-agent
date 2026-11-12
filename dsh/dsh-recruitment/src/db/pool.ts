// 数据库接入层：配置解析 + 连接池 + 事务封装。
//
// 为什么单独一层：S6（写）与 S7（读）共用同一份连接与事务语义，
// 而且三条硬约束必须只实现一次（复制粘贴就会有一份写错）：
//
//   1. **密码只从环境变量读**，不进配置、不进日志、不进错误消息。
//      配置里只有 `password_env`（变量名），默认 `RECRUITMENT_DB_PASSWORD`。
//   2. **actor 只能 `set_config(..., is_local = true)`**（等价 `SET LOCAL`）。
//      用 `SET` 的话连接池会把身份泄漏给下一个请求，责任人记错且**静默**
//      （`db/migrations/DECISIONS-2026-11-12.md` D-18、`contracts/identity/identity-resolution-rules.md` IR-M4d）。
//   3. **配置不全不假装能用**：`resolveDatabaseConfig` 返回 `{resolved: null, issues[]}`，
//      工具照常注册、调用时报 `NOT_CONFIGURED`（沿用 `src/index.ts`
//      `unconfiguredResumeReadTool` 的做法）。绝不静默退化成内存 stub。
//
// 驱动：`pg` 8.23.1 已在本包 dependencies（`package.json`），不重装、不换。
import pg from 'pg'

/** 插件配置里的 `database` 段（`cordis.patch.yml`）。 */
export interface DatabaseConfig {
  /** 主机名 / IP，必填。 */
  readonly host?: string
  /** 端口，默认 5432。 */
  readonly port?: number
  /** 用户名，必填。 */
  readonly user?: string
  /** 数据库名，必填。 */
  readonly database?: string
  /** 存放密码的**环境变量名**（默认 `RECRUITMENT_DB_PASSWORD`）；密码本身不进配置。 */
  readonly password_env?: string
  /** 租户 id（UUID）。不接受模型传入，只从这里来。 */
  readonly tenant_id?: string
  /**
   * 执行写库动作的 actor id（UUID）。同样不接受模型传入。
   * 必须是 `recruitment.actor` 里存在的行，且属于 `tenant_id`（工具会校验）。
   */
  readonly actor_id?: string
  /** 单条语句超时（毫秒），默认 15000。 */
  readonly statement_timeout_ms?: number
  /** 建连超时（毫秒），默认 10000。 */
  readonly connect_timeout_ms?: number
  /** 连接池上限，默认 2（本插件的工具调用是短事务，不需要大池）。 */
  readonly max?: number
}

/** 已补默认值并校验通过的配置。 */
export interface ResolvedDatabaseConfig {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly database: string
  /** 从环境变量取到的密码。**只用于建连，不序列化、不打印。** */
  readonly password: string
  readonly password_env: string
  readonly tenant_id: string
  readonly actor_id: string
  readonly statement_timeout_ms: number
  readonly connect_timeout_ms: number
  readonly max: number
}

const DEFAULT_PASSWORD_ENV = 'RECRUITMENT_DB_PASSWORD'
const DEFAULT_PORT = 5432
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_POOL_MAX = 2

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 一个合法 UUID 文本？ */
export function isUuidText(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function nonEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 校验并补默认值。配置不完整时返回 `resolved: null` + 逐条 issues（不抛错）。
 * @param config - `cordis.patch.yml` 里的 `database` 段。
 * @param env - 环境变量表（默认 `process.env`；测试可注入）。
 * @returns 解析结果；`resolved === null` 时 `issues` 非空。
 */
export function resolveDatabaseConfig(
  config: DatabaseConfig,
  env: Readonly<Record<string, string | undefined>>,
): { resolved: ResolvedDatabaseConfig | null; issues: readonly string[] } {
  const issues: string[] = []
  const host = nonEmpty(config.host)
  const user = nonEmpty(config.user)
  const database = nonEmpty(config.database)
  const passwordEnv = nonEmpty(config.password_env) === '' ? DEFAULT_PASSWORD_ENV : nonEmpty(config.password_env)
  const tenantId = nonEmpty(config.tenant_id)
  const actorId = nonEmpty(config.actor_id)

  if (host === '') issues.push('config.database.host is required')
  if (user === '') issues.push('config.database.user is required')
  if (database === '') issues.push('config.database.database is required')
  if (tenantId === '') issues.push('config.database.tenant_id is required')
  else if (!isUuidText(tenantId)) issues.push('config.database.tenant_id must be a UUID')
  if (actorId === '') issues.push('config.database.actor_id is required')
  else if (!isUuidText(actorId)) issues.push('config.database.actor_id must be a UUID')

  const port = config.port === undefined ? DEFAULT_PORT : config.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push('config.database.port must be an integer in 1..65535')
  }

  // 密码只能来自环境变量。变量名进 issues，**变量值永远不进 issues**。
  const password = env[passwordEnv]
  if (typeof password !== 'string' || password === '') {
    issues.push(`environment variable ${passwordEnv} is not set (the database password is only read from the environment)`)
  }

  if (issues.length > 0) return { resolved: null, issues }

  return {
    resolved: {
      host,
      port,
      user,
      database,
      password: password as string,
      password_env: passwordEnv,
      tenant_id: tenantId,
      actor_id: actorId,
      statement_timeout_ms: positiveInt(config.statement_timeout_ms, DEFAULT_STATEMENT_TIMEOUT_MS),
      connect_timeout_ms: positiveInt(config.connect_timeout_ms, DEFAULT_CONNECT_TIMEOUT_MS),
      max: positiveInt(config.max, DEFAULT_POOL_MAX),
    },
    issues: [],
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}

/** 本插件用的连接池类型别名（只在类型层引用 pg，不额外引入 import）。 */
export type DatabasePool = pg.Pool
/** 事务内传给业务函数的客户端。 */
export type DatabaseClient = pg.PoolClient

/**
 * 建一个连接池。**每租户一个池**是调用方的事；这里只管建。
 * @param config - 已校验通过的配置。
 * @returns pg 连接池。
 */
export function createPool(config: ResolvedDatabaseConfig): DatabasePool {
  return new pg.Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    password: config.password,
    max: config.max,
    connectionTimeoutMillis: config.connect_timeout_ms,
    idleTimeoutMillis: 10_000,
    application_name: 'dsh-recruitment-s6s7',
  })
}

/**
 * 关掉连接池。工具调用都是短事务，所以每次调用 finally 里 `await closePool(pool)`，
 * 不让空闲 socket 把宿主进程的事件循环挂住。
 * @param pool - 待关闭的连接池。
 */
export async function closePool(pool: DatabasePool): Promise<void> {
  await pool.end()
}

/**
 * 在一个事务里以指定 actor 执行 `fn`。
 *
 * 顺序固定：`BEGIN` → `select set_config('recruitment.actor_id', $1, true)` → `fn` → `COMMIT`；
 * 出错 `ROLLBACK` 后原样抛出（错误分类交给调用方）。
 *
 * `record_version` 不在这里缓存：`fn` 必须自己用 `RETURNING record_version` 取新值（D-18）。
 * @param pool - 连接池。
 * @param actorId - 写这份数据的 actor（UUID，来自配置而非模型入参）。
 * @param fn - 事务体。
 * @returns `fn` 的返回值（COMMIT 之后）。
 */
export async function withActor<T>(
  pool: DatabasePool,
  actorId: string,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    // is_local = true ⇒ 事务结束自动失效。等价 SET LOCAL，但走参数绑定，不做字符串拼接。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // ROLLBACK 失败会随连接一起回收；不要用第二个错误盖住第一个。
    }
    throw error
  } finally {
    client.release()
  }
}

/**
 * 在一个**只读事务**里执行 `fn`。
 *
 * 为什么不是普通的 `BEGIN`：`begin transaction read only` 让"筛选工具只读"成为
 * **数据库强制**的性质，而不是"源码里没写 INSERT"这种自觉
 * （`contracts/job-screening/tool-contracts.md` §5.4 第 2 条、§1.3）。
 * 任何写语句在这里会直接 `25006 read_only_sql_transaction`。
 * @param pool - 连接池。
 * @param fn - 只读事务体。
 * @returns `fn` 的返回值（COMMIT 之后）。
 */
export async function withReadOnly<T>(
  pool: DatabasePool,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin transaction read only')
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 同上：保留第一个错误。
    }
    throw error
  } finally {
    client.release()
  }
}
