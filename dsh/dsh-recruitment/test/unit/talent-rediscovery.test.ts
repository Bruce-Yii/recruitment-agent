// G-12（Issue #35）人才再发现：纯函数 / 投影 / 路由形状 / 工具面单测。
// 不连库：`readTalentRediscovery` 用假 DatabaseClient 按 SQL 关键字分发，验证召回、
// 排除已投递、排序、去重、空结果与文案纪律；真实 SQL 与零写入由集成测试覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  REDISCOVERY_CONTRACT_VERSION,
  RediscoveryError,
  extractRubricRequirements,
  readTalentRediscovery,
  rediscoveryJobIdFromPath,
  type RediscoveryResponse,
} from '../../src/http/talent-rediscovery.ts'
import {
  TALENT_REDISCOVERY_TOOL_NAME,
  createTalentRediscoveryTool,
  normalizeTalentRediscoveryArgs,
  unconfiguredTalentRediscoveryTool,
} from '../../src/tools/talent-rediscovery.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const TARGET_JOB = '11111111-1111-4111-8111-000000000401'
const OLD_JOB = '11111111-1111-4111-8111-000000000402'
const CAND_A = '11111111-1111-4111-8111-0000000000a1'
const CAND_B = '11111111-1111-4111-8111-0000000000a2'
const CAND_C = '11111111-1111-4111-8111-0000000000a3'

const cfg: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'fake', password: 'x',
  password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103', statement_timeout_ms: 15000,
  connect_timeout_ms: 10000, max: 2,
}

type Row = Record<string, unknown>
interface FakeDb {
  readonly calls: string[]
  readonly client: DatabaseClient
}

function fakeDb(overrides: {
  candidates?: Row[]
  applications?: Row[]
  decisions?: Row[]
  interviews?: Row[]
  scorecards?: Row[]
  resumes?: Row[]
  rubric?: Row[]
  job?: Row
} = {}): FakeDb {
  const calls: string[] = []
  const client = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      calls.push(sql)
      let rows: Row[] = []
      if (sql.includes('from recruitment.job j')) {
        rows = overrides.job === undefined
          ? [{ id: TARGET_JOB, code: 'JOB-NEW', title: '新岗位', status: 'OPEN', current_rubric_version_id: null }]
          : overrides.job === null ? [] : [overrides.job]
      } else if (sql.includes('select dimensions from recruitment.rubric_version')) {
        rows = overrides.rubric ?? []
      } else if (sql.includes('from recruitment.candidate c')) {
        const appliedToTarget = new Set(
          (overrides.applications ?? [])
            .filter((app) => app.job_id === TARGET_JOB)
            .map((app) => app.candidate_id),
        )
        rows = (overrides.candidates ?? []).filter((candidate) => !appliedToTarget.has(candidate.id))
      } else if (sql.includes('select now()')) {
        rows = [{ now: new Date('2026-11-23T00:00:00.000Z') }]
      } else if (sql.includes('from recruitment.application a')) {
        rows = (overrides.applications ?? []).filter((app) => app.job_id !== TARGET_JOB)
      } else if (sql.includes('from recruitment.decision d')) {
        rows = overrides.decisions ?? []
      } else if (sql.includes('from recruitment.interview i')) {
        rows = overrides.interviews ?? []
      } else if (sql.includes('from recruitment.scorecard s')) {
        rows = overrides.scorecards ?? []
      } else if (sql.includes('from recruitment.resume_version rv')) {
        rows = overrides.resumes ?? []
      }
      return { rows: rows as T[] }
    },
  } as unknown as DatabaseClient
  return { calls, client }
}

function candidateRow(id: string, name: string): Row {
  return { id, display_name: name }
}

function appRow(candidateId: string, jobId = OLD_JOB): Row {
  return {
    id: `app-${candidateId}`,
    candidate_id: candidateId,
    job_id: jobId,
    job_code: 'JOB-OLD',
    job_title: '历史岗位',
    current_stage_code: 'S8',
    applied_at: '2026-10-01T00:00:00.000Z',
    status_changed_at: '2026-10-20T00:00:00.000Z',
    updated_at: '2026-10-20T00:00:00.000Z',
  }
}

test('normalizeTalentRediscoveryArgs：只接受单个合法 job_id', () => {
  assert.deepEqual(normalizeTalentRediscoveryArgs({ job_id: TARGET_JOB }), { job_id: TARGET_JOB })
  for (const bad of [
    {}, null, [], 'x', { job_id: 'not-a-uuid' }, { job_id: `${TARGET_JOB}/../x` },
    { job_id: TARGET_JOB, limit: 10 }, { job_id: TARGET_JOB, score: 0.9 }, { job_id: 1 },
  ]) {
    assert.throws(
      () => normalizeTalentRediscoveryArgs(bad),
      (error: unknown) => error instanceof RecruitmentToolError && error.code === 'INVALID_ARGS',
      `should reject ${JSON.stringify(bad)}`,
    )
  }
})

test('extractRubricRequirements：只带人读字段，判断型要求不编 field', () => {
  const requirements = extractRubricRequirements([
    { key: 'work', label: '后端经验', kind: 'MUST_HAVE', field: 'work_experience' },
    { key: 'team', label: '协作能力', kind: 'MUST_HAVE', question: '如何处理冲突？' },
    { label: '' },
    42,
  ])
  assert.deepEqual(requirements, [
    { key: 'work', label: '后端经验', kind: 'MUST_HAVE', field: 'work_experience' },
    { key: 'team', label: '协作能力', kind: 'MUST_HAVE' },
    { key: 'criterion_3', label: '要求 3', kind: 'MUST_HAVE' },
  ])
  assert.deepEqual(extractRubricRequirements('not-an-array'), [])
})

test('rediscoveryJobIdFromPath：只认 .../:uuid/rediscovery，非法形状 fail-closed', () => {
  const prefix = '/recruitment/api/recruiting/jobs/'
  assert.equal(rediscoveryJobIdFromPath(`${prefix}${TARGET_JOB}/rediscovery`), TARGET_JOB)
  for (const bad of [
    `${prefix}${TARGET_JOB}`,
    `${prefix}not-a-uuid/rediscovery`,
    `${prefix}${TARGET_JOB}/rediscovery/more`,
    `${prefix}${TARGET_JOB}/../rediscovery`,
    `${prefix}/rediscovery`,
    '/recruitment/api/recruiting/overview',
  ]) {
    assert.equal(rediscoveryJobIdFromPath(bad), null, bad)
  }
})

test('readTalentRediscovery：非法/不存在的 job fail-closed', async () => {
  const { client } = fakeDb()
  await assert.rejects(
    () => readTalentRediscovery({ database: cfg, client, jobId: 'bad-id' }),
    (error: unknown) => error instanceof RediscoveryError && error.code === 'INVALID_ARGS',
  )
  const missing = fakeDb({ job: null as unknown as Row })
  await assert.rejects(
    () => readTalentRediscovery({ database: cfg, client: missing.client, jobId: TARGET_JOB }),
    (error: unknown) => error instanceof RediscoveryError && error.code === 'NOT_FOUND',
  )
})

test('readTalentRediscovery：召回命中 + 排除已投递当前岗位 + 去重 + 可解释排序', async () => {
  const db = fakeDb({
    candidates: [candidateRow(CAND_A, '候选人甲'), candidateRow(CAND_B, '候选人乙'), candidateRow(CAND_C, '候选人丙')],
    // A 与 B 都有历史岗位；C 也投递过目标岗位（候选池 SQL 会排除，这里仍给行以验证双重过滤）。
    applications: [appRow(CAND_A), appRow(CAND_B), appRow(CAND_C), appRow(CAND_C, TARGET_JOB)],
    decisions: [
      { id: 'd1', application_id: `app-${CAND_A}`, decision_scope: 'SCREENING', result: 'ADVANCE', stage_code: 'S7', decided_at: '2026-10-18T00:00:00.000Z' },
      { id: 'd2', application_id: `app-${CAND_A}`, decision_scope: 'SCREENING', result: 'ADVANCE', stage_code: 'S7', decided_at: '2026-10-19T00:00:00.000Z' },
    ],
    interviews: [
      { id: 'i1', application_id: `app-${CAND_A}`, round_no: 2, status: 'POST_INTERVIEW', status_changed_at: '2026-10-21T00:00:00.000Z' },
      { id: 'i2', application_id: `app-${CAND_B}`, round_no: 1, status: 'POST_INTERVIEW', status_changed_at: '2026-10-22T00:00:00.000Z' },
    ],
    scorecards: [
      { id: 's1', application_id: `app-${CAND_B}`, submitted_at: '2026-10-23T00:00:00.000Z' },
    ],
    resumes: [
      { candidate_id: CAND_B, id: 'rv-b', created_at: '2026-10-24T00:00:00.000Z', parsed_fields: { fields: { work_experience: { state: 'present' } } } },
    ],
    rubric: [{ dimensions: [{ key: 'work', label: '后端经验', kind: 'MUST_HAVE', field: 'work_experience' }] }],
    job: { id: TARGET_JOB, code: 'JOB-NEW', title: '新岗位', status: 'OPEN', current_rubric_version_id: '11111111-1111-4111-8111-0000000000f1' },
  })
  const value = await readTalentRediscovery({ database: cfg, client: db.client, jobId: TARGET_JOB })

  assert.equal(value.contract_version, REDISCOVERY_CONTRACT_VERSION)
  assert.equal(value.status, 'OK')
  assert.equal(value.read_only, true)
  assert.equal(value.total_matched, 2)
  assert.deepEqual(value.candidates.map((c) => c.candidate_id), [CAND_B, CAND_A], '条件数多者在前')
  assert.equal(value.candidates.some((c) => c.candidate_id === CAND_C), false, '已投递目标岗位的人必须排除')

  const b = value.candidates[0]!
  assert.deepEqual(b.basis.map((item) => item.code).sort(), [
    'HISTORICAL_JOB', 'RUBRIC_FIELD:work', 'SCORECARD_SUBMITTED',
  ])
  assert.equal(b.last_active_at, '2026-10-24T00:00:00.000Z')
  const a = value.candidates[1]!
  assert.deepEqual(a.basis.map((item) => item.code).sort(), [
    'HISTORICAL_JOB', 'SCREENING_PASSED', 'SECOND_INTERVIEW',
  ])
  assert.equal(a.basis.filter((item) => item.code === 'SCREENING_PASSED').length, 1, '同码去重')
  assert.equal(a.last_active_at, '2026-10-21T00:00:00.000Z')

  // 文案纪律：没有百分比分数/黑盒排名字段，JSON 里不出现内部术语。
  const text = JSON.stringify(value)
  assert.equal(/证据/.test(text), false)
  assert.equal(/"score"|"percentage"|"rank"/i.test(text), false)
  assert.equal(/%/.test(text), false)
  assert.equal(text.includes('work_experience'), false, '内部材料字段名不进入出参')
})

test('readTalentRediscovery：空结果诚实返回（没有候选人时 candidates 为空）', async () => {
  const db = fakeDb({ candidates: [] })
  const value = await readTalentRediscovery({ database: cfg, client: db.client, jobId: TARGET_JOB })
  assert.deepEqual(value.candidates, [])
  assert.equal(value.total_matched, 0)
  assert.equal(value.read_only, true)
  assert.match(value.note, /空结果/)
})

test('工具定义：只读/并发安全/未配置替身 fail-closed/render 无完整 UUID', async () => {
  const tool = createTalentRediscoveryTool(cfg)
  assert.equal(tool.name, TALENT_REDISCOVERY_TOOL_NAME)
  assert.equal(tool.isConcurrencySafe?.({}), true)
  const unconfigured = unconfiguredTalentRediscoveryTool(['database.host is required'])
  await assert.rejects(
    () => unconfigured.execute({ job_id: TARGET_JOB }, {}),
    (error: unknown) => error instanceof RecruitmentToolError && error.code === 'NOT_CONFIGURED',
  )

  const value: RediscoveryResponse = {
    tool: TALENT_REDISCOVERY_TOOL_NAME,
    contract_version: REDISCOVERY_CONTRACT_VERSION,
    status: 'OK',
    read_only: true,
    evaluated_at: '2026-11-23T00:00:00.000Z',
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    job: { job_id: TARGET_JOB, code: 'JOB-NEW', title: '新岗位', status: 'OPEN', rubric_requirements: [] },
    candidates: [{
      candidate_id: CAND_A,
      candidate_name: '候选人甲',
      matched_condition_count: 2,
      last_active_at: '2026-10-20T00:00:00.000Z',
      basis: [{ code: 'HISTORICAL_JOB', label: '历史岗位', detail: '历史岗位（JOB-OLD）· 阶段 S8', source: 'APPLICATION', at: '2026-10-20T00:00:00.000Z' }],
    }],
    total_matched: 1,
    note: '按命中历史条件数与最近活跃时间呈现，仅供人工复核。',
  }
  const rendered = tool.output.render({}, value).map((block) => block.text).join('\n')
  assert.equal(/证据/.test(rendered), false)
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(rendered.split('machine arguments')[0]!), false)
  assert.match(rendered, /machine arguments — copy verbatim into tool calls; never show ids or hashes to the human/)
  assert.match(tool.output.render({}, { ...value, candidates: [] })[0]!.text, /没有符合条件的历史候选人/)
})

test('工具面：CHAT_READ_TOOLS 19 个只读工具、0 写工具，含 recruitment_talent_rediscovery', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/http/agent-turn.ts', import.meta.url)),
    'utf8',
  )
  const block = source.match(/const CHAT_READ_TOOLS: readonly string\[\] = \[([\s\S]*?)\n\]/)
  assert.ok(block, '找不到 CHAT_READ_TOOLS 定义')
  const names = [...block![1]!.matchAll(/'([a-z_0-9]+)'/g)].map((match) => match[1]!)
  assert.equal(names.length, 19, `期望 19 个只读工具，实际 ${names.length}`)
  assert.equal(new Set(names).size, names.length, '只读工具名不得重复')
  assert.ok(names.includes(TALENT_REDISCOVERY_TOOL_NAME))
  for (const writeTool of [
    'recruitment_job_create', 'recruitment_scorecard_submit', 'recruitment_decision_record',
    'recruitment_stage_advance', 'recruitment_application_intake', 'recruitment_criterion_override',
  ]) {
    assert.equal(names.includes(writeTool), false, `写工具 ${writeTool} 不得进入 CHAT_READ_TOOLS`)
  }
})
