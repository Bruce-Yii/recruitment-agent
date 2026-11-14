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
import {
  DEMO_DEPARTMENT,
  HR_ACTOR,
  TENANT,
  createTestPool,
  inRolledBackTx,
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

test.after(async () => {
  await pool.end()
})
