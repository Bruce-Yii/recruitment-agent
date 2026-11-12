// 集成测试的公共底座（**不是**测试文件，文件名不含 .test）。
//
// 三条纪律：
//   1. 每个用例都在自己的事务里跑，**结束时一律 ROLLBACK** —— 测试不污染 ra_s6s7。
//   2. 连不上库就**失败**（不静默 skip）：R3 要求 `skipped === 0` 才算绿，
//      所以缺环境变量时这里直接抛，让红变红，而不是让绿变成"没跑"。
//   3. 只用 `ra_s6s7`（任务指定的自建库），不碰其它库。
import pg from 'pg'

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

/**
 * 在**必然回滚**的事务里执行 `fn`。
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
    await client.query('begin')
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
}): Promise<Scenario> {
  const suffix = uniqueSuffix()
  const jobId = input.jobId ?? (await one(client, `insert into recruitment.job
      (tenant_id, department_id, code, title, status)
      values ($1, $2, $3, $4, $5) returning id`, [
    TENANT, input.departmentId ?? DEMO_DEPARTMENT, `T-${suffix}`.slice(0, 40), '集成测试岗位', input.jobStatus ?? 'OPEN',
  ]))

  const jobVersionId = await one(client, `insert into recruitment.job_version
      (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
      values ($1, $2, 1, '测试 JD', $3, $4) returning id`, [
    TENANT, jobId, hex64(`jv${suffix}`), HR_ACTOR,
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
