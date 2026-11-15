// 集成测试的公共底座（**不是**测试文件，文件名不含 .test）。
//
// 四条纪律：
//   1. 每个用例都在自己的事务里跑，**结束时一律 ROLLBACK** —— 测试不污染 ra_s6s7。
//   2. 连不上库就**失败**（不静默 skip）：R3 要求 `skipped === 0` 才算绿，
//      所以缺环境变量时这里直接抛，让红变红，而不是让绿变成"没跑"。
//   3. 只用 `ra_s6s7`（任务指定的自建库），不碰其它库。
//   4. **并发跑（`node --test` 默认并行）是常态**，所以：共享库里的断言只能在
//      REPEATABLE READ 的同一快照里比较；需要真提交的用例必须用 `createIsolatedTestDatabase()`
//      拿一个一次性空库，不许留在共享库里靠"加锁串行"糊过去。
import pg from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDatabaseConfig, type DatabaseClient, type ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { digestOf } from '../../src/tools/contract.ts'

export const TENANT = '11111111-1111-4111-8111-000000000001'
export const HR_ACTOR = '11111111-1111-4111-8111-000000000103'
export const DEMO_JOB = '11111111-1111-4111-8111-000000000401'
export const DEMO_DEPARTMENT = '11111111-1111-4111-8111-000000000010'

/** 集成测试的库配置（密码只从环境变量来，与生产路径同一份代码）。 */
export function testDatabaseConfig(): ResolvedDatabaseConfig {
  const { resolved, issues } = resolveDatabaseConfig({
    host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
    tenant_id: TENANT,
    actor_id: HR_ACTOR,
  }, process.env)
  if (resolved === null) {
    throw new Error(
      `集成测试需要可用的 ra_s6s7：${issues.join('; ')}。`
      + ' 先设 $env:RECRUITMENT_DB_PASSWORD 并跑完 db/migrations 0001..0006（见 README）。',
    )
  }
  return resolved
}

/** 建一个只有 2 条连接的池（测试是串行的，不需要大池）。 */
export function createTestPool(cfg: ResolvedDatabaseConfig): pg.Pool {
  return new pg.Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    database: cfg.database,
    password: cfg.password,
    max: 2,
    application_name: 'dsh-recruitment-integration-test',
  })
}

// ---------------------------------------------------------------------------
//  一次性空库：需要"真提交 + 跨事务可见"的测试只能独占数据库
// ---------------------------------------------------------------------------

/** 一次性测试库的句柄。 */
export interface IsolatedTestDatabase {
  /** 库名（`ra_<label>_<pid>_<rand>`，并发跑的每个文件都不同）。 */
  readonly name: string
  /** 只指向这个库的连接池。 */
  readonly pool: pg.Pool
  /** 已应用的迁移版本（按顺序）。 */
  readonly migrations: readonly string[]
  /** 关闭连接池并删库（`WITH (FORCE)`，幂等）。 */
  drop(): Promise<void>
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'db', 'migrations')

/**
 * 按 0001→N 顺序重放全部迁移（空库顺序重放本身就是一条验收：迁移链可在空库跑通）。
 * @returns 迁移文件名（有序）。
 */
export function migrationFiles(): readonly string[] {
  const all = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
  if (all.length < 12) {
    throw new Error(`expected at least 12 migrations (0001..0012), found ${all.length}: ${all.join(', ')}`)
  }
  return all
}

/**
 * 生成一个并发安全的一次性库名（含 pid + 随机串，重跑也不会撞）。
 * @param label - 可读后缀（≤20 个 `[a-z0-9_]`）。
 * @returns 合法的库名。
 */
export function nextIsolatedDatabaseName(label: string): string {
  const suffix = `${process.pid.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20)
  const name = `ra_${safeLabel}_${suffix}`.slice(0, 60)
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`)
  return name
}

/**
 * 建一个一次性空库并把 0001→N 全部应用。
 *
 * 为什么需要它（而不是往 `ra_s6s7` 里写）：有些验收点恰恰是**跨事务、跨连接**的事实
 * （引擎的 effect 队列是**全局按 kind 消费**的 —— `src/engine/app/effects.ts:110-119`
 * 没有 tenant 过滤；Outbox 的 `message_id` 全局唯一；`event_inbox` / `business_task`
 * 有 no-delete 触发器不许清理）。这类测试如果共用 `ra_s6s7`，两个进程会互相偷行
 * （实测：effect 行凭空消失、`count(*)` 断言 1 !== 0），加锁串行只是掩盖症状。
 * 每个文件一个库，才是根因隔离。
 * @param label - 库名后缀（便于并发运行时定位）。
 * @returns 可用的连接池 + `drop()`。
 */
export async function createIsolatedTestDatabase(label: string): Promise<IsolatedTestDatabase> {
  const cfg = testDatabaseConfig()
  const name = nextIsolatedDatabaseName(label)

  await withAdminClient(cfg, async (admin) => {
    await admin.query(`drop database if exists ${name} with (force)`)
    await admin.query(`create database ${name}`)
  })

  const pool = createTestPool({ ...cfg, database: name, max: 4 })
  const migrations = migrationFiles()
  const client = await pool.connect()
  try {
    for (const file of migrations) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      await client.query(sql)
    }
    // runtime ↔ 引擎 Effects/Outbox 交界的表必须真的存在（否则测试会绿成"没接线"）。
    const engine = await client.query<{ effect: string | null; outbox: string | null }>(
      "select to_regclass('recruitment.engine_effect')::text as effect, to_regclass('recruitment.engine_outbox')::text as outbox",
    )
    if (engine.rows[0]?.effect === null || engine.rows[0]?.outbox === null) {
      throw new Error('engine_effect/engine_outbox tables are missing: apply 0012_engine_state.sql')
    }
  } catch (error) {
    client.release()
    await pool.end().catch(() => {})
    await dropIsolatedDatabase(name, cfg).catch(() => {})
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
      await dropIsolatedDatabase(name, cfg)
    },
  }
}

/**
 * 守卫：这个库必须**不是**共享的 `ra_s6s7`。
 * 真提交的用例（引擎队列 / Outbox / 禁删表）用共享库就会与并行跑的别的文件互相偷数据。
 * @param name - 用例实际连接的库名。
 */
export function assertPrivateDatabase(name: string): void {
  const shared = process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7'
  if (name === shared) {
    throw new Error(
      `并行跑会互相偷数据：这个用例必须用 createIsolatedTestDatabase() 独占一个空库，`
      + `不许直接写共享库 ${shared}（见 test/isolation.test.ts）`,
    )
  }
}

/** 用一条 postgres 管理连接执行 `fn`（建库 / 删库）。 */
async function withAdminClient(
  cfg: ResolvedDatabaseConfig,
  fn: (admin: pg.Client) => Promise<void>,
): Promise<void> {
  const admin = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: 'postgres',
    application_name: 'recruitment-test-admin',
  })
  await admin.connect()
  try {
    await fn(admin)
  } finally {
    await admin.end()
  }
}

/** 删掉一次性测试库（`WITH (FORCE)`，幂等）。 */
async function dropIsolatedDatabase(name: string, cfg: ResolvedDatabaseConfig): Promise<void> {
  await withAdminClient(cfg, async (admin) => {
    await admin.query(`drop database if exists ${name} with (force)`)
  })
}

/**
 * 在**必然回滚**的事务里执行 `fn`。
 *
 * `REPEATABLE READ` 是并发跑的硬前提：并行跑的另一个测试文件会往共享库提交行，
 * READ COMMITTED 下每条语句取新快照，"写之前 count / 写之后 count"这类零写入断言
 * 会被别人的提交污染（实测：全局 `count(*) from event_inbox` 在同一用例里 138 → 139）。
 * REPEATABLE READ 让整笔事务只看同一个快照 + 自己的写，别人的提交既不会偷走行、
 * 也不会让行数漂移。
 * @param pool - 测试连接池。
 * @param fn - 事务体（可以做 INSERT 造夹具）。
 * @returns `fn` 的返回值（ROLLBACK 之后）。
 */
export async function inRolledBackTx<T>(
  pool: pg.Pool,
  fn: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin isolation level repeatable read')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    return await fn(client)
  } finally {
    try {
      await client.query('rollback')
    } finally {
      client.release()
    }
  }
}

// ---------------------------------------------------------------------------
//  命名空间：每个测试文件（= 每个 node --test 子进程）独占一套键
// ---------------------------------------------------------------------------

/**
 * 本测试**文件**的命名空间。
 *
 * `node --test` 每个测试文件一个子进程 ⇒ `pid` 就是文件身份；再叠 4 位随机串，
 * 保证「同一个文件被并行跑两份」（或 pid 被复用）也不会共用键空间。
 * 需要真提交的夹具一律用 `namespacedKey()` 加这个前缀。
 */
export const FILE_NAMESPACE = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 6)}`

/**
 * 把业务键加上本文件的命名空间前缀。
 * @param key - 业务键（如 `notice-1`）。
 * @returns `<FILE_NAMESPACE>:<key>`。
 */
export function namespacedKey(key: string): string {
  const full = `${FILE_NAMESPACE}:${key}`
  assertOwnNamespace(full)
  return full
}

/**
 * 守卫：这个键必须属于本文件的命名空间。
 *
 * 用来**发现**"测试用了共享的可变全局状态"：如果某个键是写死的全局键，
 * 并行跑的另一个测试文件会消费/覆盖它（引擎租约、唯一键、审计事件）。
 * @param key - 要检查的键。
 */
export function assertOwnNamespace(key: string): void {
  if (!key.startsWith(`${FILE_NAMESPACE}:`)) {
    throw new Error(
      `键 ${JSON.stringify(key)} 不在本测试文件的命名空间 ${FILE_NAMESPACE} 里：`
      + '共享库的全局键会被并行跑的另一份/另一个测试文件偷走（见 test/isolation.test.ts）',
    )
  }
}

/** 6 位随机后缀（只用于唯一键，不用随机数做断言）。 */
let counter = 0
export function uniqueSuffix(): string {
  counter += 1
  return `${process.pid.toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.slice(-10)
}

/** 造一个 64 位 hex（sha256 形状）。 */
export function hex64(seed: string): string {
  let out = ''
  for (let i = 0; out.length < 64; i += 1) {
    out += Buffer.from(`${seed}:${i}`, 'utf8').toString('hex')
  }
  return out.slice(0, 64)
}

/** 默认的"能干活的材料"（work_experience present + 74 个月闭区间 + education absent）。 */
export function parsedFields(options: {
  workState?: string
  eduState?: string
  entryCount?: number
  coveredMonths?: number
  openEnded?: number
  yearOnly?: number
  issues?: { code: string }[]
  evidence?: unknown[]
} = {}): Record<string, unknown> {
  const evidence = options.evidence ?? [
    { page: 1, bbox: [72, 248, 523, 271.2], block: 9, text: '2019.03 - 至今 某某科技 后端工程师' },
  ]
  const workState = options.workState ?? 'present'
  const eduState = options.eduState ?? 'absent'
  return {
    fields: {
      name: { state: 'present', value: '测试候选人', provenance: 'native_text', evidence },
      phone: { state: 'absent', provenance: 'native_text', evidence: [] },
      email: { state: 'absent', provenance: 'native_text', evidence: [] },
      work_experience: {
        state: workState,
        provenance: 'native_text',
        evidence: workState === 'present' ? evidence : [],
        ...(options.entryCount === undefined ? {} : { entry_count: options.entryCount }),
      },
      education: {
        state: eduState,
        provenance: 'native_text',
        evidence: eduState === 'present' ? evidence : [],
      },
    },
    timeline: {
      intervals: 1,
      closed_intervals: 1,
      open_ended_intervals: options.openEnded ?? 0,
      year_only_intervals: options.yearOnly ?? 0,
      covered_months_closed: options.coveredMonths ?? 74,
    },
    issues: options.issues ?? [],
    screening: {
      eligible_fields: workState === 'present' ? ['work_experience', 'name'] : ['name'],
      blocked_fields: [],
    },
    meta: { pages: 1 },
  }
}

/** 一条 criterion 的简写（weight 由调用方保证 Σ=1）。 */
export function criterion(partial: Record<string, unknown>): Record<string, unknown> {
  return { label: partial.key, ...partial }
}

/** 造好夹具后的 id 集合。 */
export interface Scenario {
  readonly applicationId: string
  readonly candidateId: string
  readonly jobId: string
  readonly jobVersionId: string
  readonly rubricId: string
  readonly resumeVersionId: string
}

/**
 * 在事务里造一份完整夹具：job → job_version → rubric(+approval) → candidate →
 * event/intake 链 → resume_version → application。
 *
 * 这是测试代码，**故意**直接写库（工具端点不提供造夹具的入口）。
 */
export async function seedScenario(client: DatabaseClient, input: {
  readonly dimensions: readonly Record<string, unknown>[]
  readonly fields?: Record<string, unknown>
  readonly jobStatus?: string
  readonly lifecycleStatus?: string
  readonly parseStatus?: string
  readonly parseError?: string | null
  readonly approve?: boolean
  readonly pinRubric?: boolean
  readonly bindMaterial?: boolean
  readonly assetValidation?: string
  readonly rubricHashOverride?: string
  readonly approvalSchemaVersion?: number
  readonly jobId?: string
  readonly candidateId?: string
  readonly departmentId?: string
  /**
   * 可选：`job_version.description_md`（默认 `'测试 JD'` = 既有行为）。
   * 质量门槛（`rubric_quality`）在 `requirements_md` 为空时回退读它。
   */
  readonly descriptionMd?: string
  /**
   * 可选：`job_version.requirements_md`（默认 `null` = 既有行为，那时 `requirements_md` 列就是空）。
   * 质量门槛**优先**读这一列：它是岗位 JD 的"要求"部分。
   */
  readonly requirementsMd?: string
}): Promise<Scenario> {
  const suffix = uniqueSuffix()
  const jobId = input.jobId ?? (await one(client, `insert into recruitment.job
      (tenant_id, department_id, code, title, status)
      values ($1, $2, $3, $4, $5) returning id`, [
    TENANT, input.departmentId ?? DEMO_DEPARTMENT, `T-${suffix}`.slice(0, 40), '集成测试岗位', input.jobStatus ?? 'OPEN',
  ]))

  const jobVersionId = await one(client, `insert into recruitment.job_version
      (tenant_id, job_id, version_no, description_md, requirements_md, payload_hash, created_by_actor_id)
      values ($1, $2, 1, $3, $4, $5, $6) returning id`, [
    TENANT, jobId, input.descriptionMd ?? '测试 JD', input.requirementsMd ?? null,
    hex64(`jv${suffix}`), HR_ACTOR,
  ])
  await client.query(
    'update recruitment.job set current_job_version_id = $2 where id = $1',
    [jobId, jobVersionId],
  )

  const dimensions = input.dimensions
  // payload_hash 必须等于 sha256(canonical_json(dimensions))（R-VAL-14）
  const payloadHash = input.rubricHashOverride ?? digestOf(dimensions)
  const rubricId = await one(client, `insert into recruitment.rubric_version
      (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
      values ($1, $2, 1, $3::jsonb, $4, $5) returning id`, [
    TENANT, jobId, JSON.stringify(dimensions), payloadHash, HR_ACTOR,
  ])
  if (input.approve !== false) {
    await client.query(`insert into recruitment.approval
        (tenant_id, resource_type, resource_id, resource_record_version,
         payload_schema_version, canonical_payload_hash, status,
         requested_by_actor_id, decision_by_actor_id, decided_at, reason)
        values ($1, 'RUBRIC_VERSION', $2, 1, $3, $4, 'APPROVED', $5, $5, now(), '集成测试批准')`, [
      TENANT, rubricId, input.approvalSchemaVersion ?? 1, payloadHash, HR_ACTOR,
    ])
    // D-21 / D-48：**"当前"只由 job.current_rubric_version_id 说话**。
    // 批准了就得把这个指针指过去，否则夹具造出的是"已批准但没有当前版本"这种另一种真实状态
    // （要测它时用 `approve: false`，或显式再清空指针）。
    await client.query(
      'update recruitment.job set current_rubric_version_id = $2 where id = $1',
      [jobId, rubricId],
    )
  }

  const candidateId = input.candidateId ?? (await one(client, `insert into recruitment.candidate
      (tenant_id, display_name, identity_status) values ($1, $2, 'ACTIVE') returning id`, [
    TENANT, `测试候选人-${suffix}`,
  ]))

  const sha = hex64(`asset${suffix}`)
  const eventId = await one(client, `insert into recruitment.event_inbox
      (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
      values ($1, 'internal', 'test.seed', $2, '{}'::jsonb, 'INTERNAL') returning event_id`, [
    TENANT, `test:${suffix}`,
  ])
  const intakeRecordId = await one(client, `insert into recruitment.intake_record
      (tenant_id, event_id, subject, status) values ($1, $2, '测试收件', 'RESOLVED') returning id`, [
    TENANT, eventId,
  ])
  const assetId = await one(client, `insert into recruitment.intake_asset
      (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref,
       validation_status, validation_error)
      values ($1, $2, 'test.pdf', 'application/pdf', 1024, $3, 'test', $4, $5) returning id`, [
    TENANT, intakeRecordId, sha, input.assetValidation ?? 'VALID',
    // ck_intake_asset_error：INVALID 必须有非空 validation_error
    input.assetValidation === 'INVALID' ? '集成测试：原件校验失败' : null,
  ])
  const resumeId = await one(client, `insert into recruitment.resume
      (tenant_id, candidate_id, intake_asset_id) values ($1, $2, $3) returning id`, [
    TENANT, candidateId, assetId,
  ])
  const resumeVersionId = await one(client, `insert into recruitment.resume_version
      (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
       parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
      values ($1, $2, 1, $3, $4, 'pymupdf', '1.0.0', $5, $6, $7::jsonb, '[]'::jsonb) returning id`, [
    TENANT, resumeId, sha, hex64(`content${suffix}`), input.parseStatus ?? 'PARSED',
    input.parseStatus === 'FAILED' ? (input.parseError ?? 'pdf_no_text') : null,
    JSON.stringify(input.fields ?? parsedFields()),
  ])

  const applicationId = await one(client, `insert into recruitment.application
      (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
       lifecycle_status, current_stage_code)
      values ($1, $2, $3, $4, $5, $6, $7, 'S7') returning id`, [
    TENANT, candidateId, jobId, jobVersionId,
    input.pinRubric === false ? null : rubricId,
    input.bindMaterial === false ? null : resumeVersionId,
    input.lifecycleStatus ?? 'ACTIVE',
  ])

  return { applicationId, candidateId, jobId, jobVersionId, rubricId, resumeVersionId }
}

/** 跑一条 returning 单列的 insert/select 并取回值。 */
export async function one(client: DatabaseClient, sql: string, params: readonly unknown[]): Promise<string> {
  const { rows } = await client.query<Record<string, string>>(sql, [...params])
  const row = rows[0]
  if (row === undefined) throw new Error(`no row returned by: ${sql.slice(0, 60)}`)
  const value = Object.values(row)[0]
  if (typeof value !== 'string') throw new Error(`first column is not a string: ${sql.slice(0, 60)}`)
  return value
}

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
export function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}
