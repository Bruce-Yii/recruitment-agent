// R4 三维标签的**真库**证据（N10 / `docs/23` P2-03 的回归）。
//
// 这个文件只做一件事：真实调 `interview_schedule` / `job_create` / `candidate_get`，
// 把它们**出口的 labels 原文**拿出来断言：
//   1. 在共享库 `ra_s6s7`（0002_seed 的演示租户 + 合成数据）里，三处都必须是
//      `FIXTURE / MANUAL / NOT_CONNECTED` —— **不许出现 `LIVE`**；
//   2. `LIVE` 不是写死也不是永不出现：在同一个事务里造一个**被显式声明为非合成**的租户
//      （`business_config(config_key='tenant_provenance').payload.synthetic=false`），
//      同一个 `job_create` / `candidate_get` 就会回 `LIVE` —— 证明标签按租户事实算；
//   3. 同一个租户一旦再加上合成标记（`stage_catalog.payload.demo=true`），标签立刻退回 `FIXTURE`
//      —— 合成标记优先于"非合成声明"（fail-closed）。
//
// 纪律：所有夹具都在 `inRolledBackTx` 里造，结束一律 ROLLBACK，不污染 `ra_s6s7`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { digestOf } from '../../src/tools/contract.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import { readCandidateValue } from '../../src/tools/candidate-get.ts'
import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import { createJobInTransaction } from '../../src/tools/job-create.ts'
// 2026-11-14 第二轮：三个**读库**工具的出口标签（`docs/23` P2-03 漏网的那三处）。
import { createJobGetTool, readJobValue } from '../../src/tools/job-get.ts'
import { getInTransaction } from '../../src/tools/interview-get.ts'
import { readTranscriptInTransaction } from '../../src/tools/transcript-read.ts'
import {
  DEMO_DEPARTMENT,
  DEMO_JOB,
  HR_ACTOR,
  TENANT,
  createTestPool,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 演示租户的种子候选人（0002_seed §7）。 */
const DEMO_CANDIDATE = '11111111-1111-4111-8111-000000000601'
/** 演示租户的种子面试官。 */
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
/** 演示租户里一场有转写产物的面试（`0002_seed`：meeting 0901 → artifact a01，provenance=FIXTURE）。 */
const DEMO_INTERVIEW = '11111111-1111-4111-8111-000000000801'

/** 服务端"现在"（与集成测试其它文件同一注入口径）。 */
const NOW = Date.parse('2026-11-13T00:00:00Z')
/** 远期时段（库里没有已提交数据，避免与其它 lane 的真实面试冲突）。 */
const START_MS = Date.parse('2031-06-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const START = new Date(START_MS).toISOString()

/** D-79 的人工批准替身（本文件验的是标签，不是闸门）。 */
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'

/** 推导用于 dimension 的 fixture（`seedScenario` 要求能 digest 的 dimensions）。 */
const DIMENSIONS = [
  {
    key: 'work_exists',
    label: '有工作经历',
    kind: 'MUST_HAVE',
    weight: 1,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
  },
]

/**
 * 断言一份 labels 是"三轴齐全 + 指定值"，且**没有**任何额外的、把两件事压成一维的取值。
 * @param labels - 工具出口的 labels。
 * @param expected - 期望的三轴取值。
 * @param label - 断言失败时的上下文。
 */
function assertThreeAxis(
  labels: unknown,
  expected: { provenance: 'LIVE' | 'FIXTURE'; trigger: string; connection: string },
  label: string,
): void {
  assert.ok(typeof labels === 'object' && labels !== null, `${label}: labels 必须是对象`)
  const value = labels as Record<string, unknown>
  assert.deepEqual(Object.keys(value).sort(), ['connection', 'provenance', 'trigger'], `${label}: 只能有三轴`)
  assert.deepEqual(value, expected, `${label}: 三维取值必须如实`)
}

/**
 * 造一个**被显式声明为非合成**的租户（同一事务内，结束回滚）。
 * @param client - 事务连接。
 * @returns 新租户的 id / actor id / department id / 该租户的配置副本。
 */
async function insertDeclaredRealTenant(client: DatabaseClient): Promise<{
  readonly cfg: ResolvedDatabaseConfig
  readonly departmentId: string
}> {
  const tenantId = randomUUID()
  const departmentId = randomUUID()
  const actorId = randomUUID()
  await client.query(
    'insert into recruitment.organization (id, name, timezone) values ($1, $2, $3)',
    [tenantId, '测试用非合成租户（本用例回滚）', 'Asia/Shanghai'],
  )
  await client.query(
    'insert into recruitment.department (id, tenant_id, name) values ($1, $2, $3)',
    [departmentId, tenantId, '测试部门'],
  )
  await client.query(
    `insert into recruitment.actor (id, tenant_id, kind, display_name, department_id)
     values ($1, $2, 'HUMAN', $3, $4)`,
    [actorId, tenantId, '测试 HR', departmentId],
  )
  const tenantCfg: ResolvedDatabaseConfig = { ...cfg, tenant_id: tenantId, actor_id: actorId }
  // 写库的 `set LOCAL` 责任人必须是该租户的 actor（复合外键），否则 fn_row_guard 会拒。
  await client.query("select set_config('recruitment.actor_id', $1, true)", [actorId])
  // 唯一能让 provenance=LIVE 的正面证据：该租户被显式声明为非合成。
  await insertBusinessConfig(client, tenantId, actorId, 'tenant_provenance', { synthetic: false })
  return { cfg: tenantCfg, departmentId }
}

/**
 * 插一行 `business_config`（payload_hash 按契约算）。
 * @param client - 事务连接。
 * @param tenantId - 租户。
 * @param actorId - 写入者。
 * @param configKey - `config_key`（闭集命名，见 `contracts/tenant-provenance.md`）。
 * @param payload - 配置载荷。
 */
async function insertBusinessConfig(
  client: DatabaseClient,
  tenantId: string,
  actorId: string,
  configKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into recruitment.business_config
       (tenant_id, scope, scope_id, config_key, version_no, payload, payload_hash, created_by_actor_id)
     values ($1, 'ORGANIZATION', null, $2, 1, $3::jsonb, $4, $5)`,
    [tenantId, configKey, JSON.stringify(payload), digestOf(payload), actorId],
  )
}

/** 造一份 CREATE 入参。 */
function scheduleArgs(applicationId: string): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `labels-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: INTERVIEWER_A }],
    scheduled_start_at: START,
    duration_minutes: 60,
  }
}

test('演示租户（ra_s6s7 合成数据）：三个工具出口都是 FIXTURE/MANUAL/NOT_CONNECTED，**不出现 LIVE**', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 1) interview_schedule：真写库。
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const scheduled = await scheduleInTransaction(client, cfg, scheduleArgs(scenario.applicationId), NOW, allowOnce)
    assertThreeAxis(scheduled.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }, 'schedule')
    // `effects.external_call_made=false` 与 connection=NOT_CONNECTED 必须同向（没连外部系统）。
    assert.deepEqual(scheduled.effects, { meeting_bound: false, external_call_made: false })

    // 2) job_create：真写库。
    const created = await createJobInTransaction(client, cfg, {
      title: '标签探针岗位',
      code: `LBL-${uniqueSuffix()}`,
      department_id: DEMO_DEPARTMENT,
      description_md: '标签探针 JD',
    })
    assertThreeAxis(created.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }, 'job_create')

    // 3) candidate_get：真读库（种子候选人）。
    const candidate = await readCandidateValue(client, cfg, { candidate_id: DEMO_CANDIDATE })
    assertThreeAxis(candidate.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }, 'candidate_get')
    // `source:'DATABASE'` 回答"从哪读的"，不能替代 provenance（演示租户的数据照样是合成的）。
    assert.equal(candidate.source, 'DATABASE')

    for (const [label, labels] of [
      ['schedule', scheduled.labels],
      ['job_create', created.labels],
      ['candidate_get', candidate.labels],
    ] as const) {
      assert.notEqual((labels as Record<string, unknown>).provenance, 'LIVE', `${label}: 合成数据不许标 LIVE`)
    }
  })
})

test('正面证据存在时 provenance=LIVE：同一 job_create / candidate_get 在"显式声明非合成"的租户里回 LIVE', async () => {
  await inRolledBackTx(pool, async (client) => {
    const real = await insertDeclaredRealTenant(client)
    // 注意：本用例只证明"标签按事实算"。该租户的声明本身是本用例造的，不是生产租户。
    const created = await createJobInTransaction(client, real.cfg, {
      title: '非合成租户的岗位',
      code: `LBL-${uniqueSuffix()}`,
      department_id: real.departmentId,
      description_md: 'JD',
    })
    assertThreeAxis(created.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }, 'job_create(LIVE)')

    const candidateId = randomUUID()
    await client.query(
      `insert into recruitment.candidate (id, tenant_id, display_name, identity_status)
       values ($1, $2, $3, 'ACTIVE')`,
      [candidateId, real.cfg.tenant_id, '非合成租户的候选人'],
    )
    const candidate = await readCandidateValue(client, real.cfg, { candidate_id: candidateId })
    assertThreeAxis(candidate.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' }, 'candidate_get(LIVE)')

    // 合成标记优先：同一租户再加一条 stage_catalog(demo=true)，LIVE 必须退回（fail-closed）。
    await insertBusinessConfig(client, real.cfg.tenant_id, real.cfg.actor_id, 'stage_catalog', {
      catalog_version: 1,
      demo: true,
      stages: [],
    })
    const downgraded = await createJobInTransaction(client, real.cfg, {
      title: '有合成标记后新建的岗位',
      code: `LBL-${uniqueSuffix()}`,
      department_id: real.departmentId,
      description_md: 'JD',
    })
    assertThreeAxis(
      downgraded.labels,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
      'job_create(合成标记优先)',
    )
  })
})

/**
 * 在"被显式声明为非合成"的租户里造一条最小可读链：job → job_version → candidate → application → interview。
 *
 * 为什么要造链：`provenance=LIVE` 只有在**同一个租户**里真的读到行才算证明；
 * 只验 FIXTURE 不能排除"把标签写死成 FIXTURE"这种反向的谎。
 * @param client - 事务连接（结束回滚）。
 * @returns 该租户的配置 + 岗位 id + 面试 id。
 */
async function seedDeclaredRealReadChain(client: DatabaseClient): Promise<{
  readonly cfg: ResolvedDatabaseConfig
  readonly jobId: string
  readonly interviewId: string
}> {
  const real = await insertDeclaredRealTenant(client)
  // 阶段目录是**按租户**的（`fk_application_stage_catalog` = (tenant_id, code)）：新租户必须自己有行，
  // 否则连"造一个 use case 的申请"都过不了外键。从演示租户复制 12 个阶段（同一事务，结束回滚）。
  await client.query(
    `insert into recruitment.stage_catalog (tenant_id, code, name, sort_order, in_v1_scope)
     select $1, code, name, sort_order, in_v1_scope
       from recruitment.stage_catalog where tenant_id = $2`,
    [real.cfg.tenant_id, TENANT],
  )
  const suffix = uniqueSuffix()
  const jobId = await one(client,
    `insert into recruitment.job (tenant_id, department_id, code, title, status)
     values ($1, $2, $3, $4, 'OPEN') returning id`,
    [real.cfg.tenant_id, real.departmentId, `LBL-${suffix}`.slice(0, 40), '非合成租户的岗位'])
  const jobVersionId = await one(client,
    `insert into recruitment.job_version
       (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
     values ($1, $2, 1, 'JD', $3, $4) returning id`,
    [real.cfg.tenant_id, jobId, digestOf({ md: 'JD' }), real.cfg.actor_id])
  const candidateId = await one(client,
    `insert into recruitment.candidate (tenant_id, display_name, identity_status)
     values ($1, $2, 'ACTIVE') returning id`,
    [real.cfg.tenant_id, `非合成候选人-${suffix}`])
  const applicationId = await one(client,
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, 'ACTIVE', 'S7') returning id`,
    [real.cfg.tenant_id, candidateId, jobId, jobVersionId])
  const interviewId = await one(client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at, timezone)
     values ($1, $2, 1, 'DEFAULT', 'S8', 'SCHEDULED', $3, $4, 'Asia/Shanghai') returning id`,
    // ck_interview_scheduled：SCHEDULED 必须有起止（本用例只验标签，取远期时段避免与真人时段撞车）。
    [real.cfg.tenant_id, applicationId, START, new Date(START_MS + 60 * 60_000).toISOString()])
  return { cfg: real.cfg, jobId, interviewId }
}

test('演示租户（ra_s6s7 合成数据）：三个**读库**工具出口都是 FIXTURE，**不出现 LIVE**', async () => {
  // 1) recruitment_job_get：走生产入口（工具自己开池 + 只读事务）。
  const jobGet = await createJobGetTool(cfg).execute({ job_id: DEMO_JOB }) as {
    labels: Record<string, string>
    rubric: { version_no: number } | null
  }
  assertThreeAxis(jobGet.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' }, 'job_get')

  await inRolledBackTx(pool, async (client) => {
    // 2) recruitment_interview_get：真读演示租户的一场面试。
    const interviewGet = await getInTransaction(client, cfg, { interview_id: DEMO_INTERVIEW }, NOW)
    assertThreeAxis(
      interviewGet.labels as Record<string, string>,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'interview_get',
    )

    // 3) recruitment_transcript_read：顶层的 provenance 与逐条产物的 provenance 不许互相矛盾。
    const transcriptRead = await readTranscriptInTransaction(
      client, cfg, { interview_id: DEMO_INTERVIEW, include_text: false }, NOW,
    )
    assertThreeAxis(
      transcriptRead.labels as Record<string, string>,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'transcript_read',
    )
    const artifacts = (transcriptRead.transcript as { artifacts: Record<string, unknown>[] }).artifacts
    assert.ok(artifacts.length > 0, '演示租户这场面试应当有产物（否则本轮不构成"读到了行"的证据）')
    for (const artifact of artifacts) {
      // 旧实现在这里会输出顶层 LIVE 而每条产物 FIXTURE —— 同一个响应自相矛盾。
      assert.notEqual(artifact.provenance, 'LIVE', '演示租户的转写产物不许标 LIVE')
    }

    // 三处一起再断言一次：合成数据里没有任何一个读工具能靠"读到了库里的行"拿到 LIVE。
    for (const [label, labels] of [
      ['job_get', jobGet.labels],
      ['interview_get', interviewGet.labels],
      ['transcript_read', transcriptRead.labels],
    ] as const) {
      assert.notEqual((labels as Record<string, unknown>).provenance, 'LIVE', `${label}: 合成数据不许标 LIVE`)
    }
  })
})

test('正面证据存在时三个读库工具回 LIVE：被显式声明为非合成的租户里，标签随租户事实变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const real = await seedDeclaredRealReadChain(client)
    const asOfIso = new Date(NOW).toISOString()

    // 1) job_get（同一事务内的入口：与 execute 共用 queryJob + resolveTenantProvenance）。
    const jobGet = await readJobValue(client, real.cfg, { job_id: real.jobId }, asOfIso)
    assertThreeAxis(jobGet.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' }, 'job_get(LIVE)')

    // 2) interview_get。
    const interviewGet = await getInTransaction(client, real.cfg, { interview_id: real.interviewId }, NOW)
    assertThreeAxis(
      interviewGet.labels as Record<string, string>,
      { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'interview_get(LIVE)',
    )

    // 3) transcript_read（该面试还没有产物：一条都没标 FIXTURE，租户声明是唯一变量）。
    const transcriptRead = await readTranscriptInTransaction(
      client, real.cfg, { interview_id: real.interviewId, include_text: false }, NOW,
    )
    assertThreeAxis(
      transcriptRead.labels as Record<string, string>,
      { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'transcript_read(LIVE)',
    )

    // 合成标记优先：同一租户加一条 stage_catalog(demo=true)，三个读工具都必须退回 FIXTURE。
    await insertBusinessConfig(client, real.cfg.tenant_id, real.cfg.actor_id, 'stage_catalog', {
      catalog_version: 1,
      demo: true,
      stages: [],
    })
    const downgradedJob = await readJobValue(client, real.cfg, { job_id: real.jobId }, asOfIso)
    assertThreeAxis(
      downgradedJob.labels,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'job_get(合成标记优先)',
    )
    const downgradedInterview = await getInTransaction(client, real.cfg, { interview_id: real.interviewId }, NOW)
    assertThreeAxis(
      downgradedInterview.labels as Record<string, string>,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'interview_get(合成标记优先)',
    )
    const downgradedTranscript = await readTranscriptInTransaction(
      client, real.cfg, { interview_id: real.interviewId, include_text: false }, NOW,
    )
    assertThreeAxis(
      downgradedTranscript.labels as Record<string, string>,
      { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
      'transcript_read(合成标记优先)',
    )
  })
})

test.after(async () => {
  await pool.end()
})
