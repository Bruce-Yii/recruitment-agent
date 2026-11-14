// 运行时测试的数据库底座：**每个测试文件一个一次性空库**，按 0001→0011 顺序
// 重放迁移，跑完 `DROP DATABASE ... WITH (FORCE)`。
//
// 为什么不用 `test/integration/db.ts` 的"事务里造夹具 + ROLLBACK"：
//   运行时的验收点恰恰是**跨事务、跨连接、进程重启后**仍然成立的事实：
//   `event_inbox` 的 provider 事件唯一、`task_wakeup` 同一事件只唤醒一次、
//   `task_attempt` 的租约回收。这些必须真提交才看得见；ROLLBACK 掉就只剩
//   "单事务内看起来对"。
//
// 为什么用空库而不是 `ra_s6s7`：
//   1. `event_inbox` / `business_task` 等表有 no-delete 触发器，测试数据无法清理；
//   2. 空库顺序重放本身就是一条验收（迁移 0001→0011 可在空库跑通）；
//   3. 每个文件独立库，`node --test` 并行跑互不干扰。
import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestPool, testDatabaseConfig } from '../integration/db.ts'

/** 一次性测试库的句柄。 */
export interface RuntimeTestDatabase {
  readonly name: string
  readonly pool: pg.Pool
  /** 已应用的迁移版本（按顺序）。 */
  readonly migrations: readonly string[]
  /** 关闭连接池并删库（`WITH (FORCE)`，幂等）。 */
  drop(): Promise<void>
}

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', '..', 'db', 'migrations')

/** 迁移文件清单：只取 0001..0011（0012/0013 属于其它 lane，不在本 lane 验收范围）。 */
function migrationFiles(): readonly string[] {
  const all = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .filter((name) => name <= '0011_task_runtime.sql')
    .sort()
  if (all.length !== 11) {
    throw new Error(`expected 11 migrations (0001..0011), found ${all.length}: ${all.join(', ')}`)
  }
  return all
}

/**
 * 建一个一次性库并把 0001→0011 全部应用。
 * @param label - 库名后缀（便于并发运行时定位）。
 * @returns 可用的连接池 + `drop()`。
 */
export async function createRuntimeTestDatabase(label: string): Promise<RuntimeTestDatabase> {
  const cfg = testDatabaseConfig()
  const suffix = `${process.pid.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)
  const name = `ra_rt_${safeLabel}_${suffix}`.slice(0, 60)
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`)

  const admin = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'postgres',
    application_name: 'recruitment-runtime-test-admin',
  })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${name} with (force)`)
    await admin.query(`create database ${name}`)
  } finally {
    await admin.end()
  }

  const pool = createTestPool({ ...cfg, database: name, max: 4 })
  const migrations = migrationFiles()
  const client = await pool.connect()
  try {
    for (const file of migrations) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      await client.query(sql)
    }
  } catch (error) {
    client.release()
    await pool.end().catch(() => {})
    await dropDatabase(name, cfg).catch(() => {})
    throw error
  }
  client.release()

  let dropped = false
  return {
    name,
    pool,
    migrations,
    async drop(): Promise<void> {
      if (dropped) return
      dropped = true
      await pool.end().catch(() => {})
      await dropDatabase(name, cfg)
    },
  }
}

async function dropDatabase(name: string, cfg: ReturnType<typeof testDatabaseConfig>): Promise<void> {
  const admin = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'postgres',
    application_name: 'recruitment-runtime-test-admin',
  })
  await admin.connect()
  try {
    await admin.query(`drop database if exists ${name} with (force)`)
  } finally {
    await admin.end()
  }
}

/** 测试用的租户 / actor 与 0002_seed 的演示数据一致。 */
export const RUNTIME_TENANT = '11111111-1111-4111-8111-000000000001'
export const RUNTIME_ACTOR = '11111111-1111-4111-8111-000000000103'

/** 一个稳定的 APPLICATION id（UUID 形状；business_refs 是 JSONB，不做外键）。 */
export const DEMO_APPLICATION = '22222222-2222-4222-8222-000000000001'
