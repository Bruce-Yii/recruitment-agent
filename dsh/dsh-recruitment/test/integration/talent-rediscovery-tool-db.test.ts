// G-12（Issue #35）人才再发现：真库集成测试（一次性库 + 全量迁移）。
// 覆盖：召回命中、排除已投递当前岗位、按命中条件数/最近活跃排序、非法 job fail-closed、
// 空结果诚实返回、业务表零写入、无百分比分数/无内部术语。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  TALENT_REDISCOVERY_TOOL_NAME,
  createTalentRediscoveryTool,
} from '../../src/tools/talent-rediscovery.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import {
  createIsolatedTestDatabase,
  one,
  seedScenario,
  testDatabaseConfig,
  TENANT,
} from './db.ts'

const db = await createIsolatedTestDatabase('talent_rediscovery')
const cfg: ResolvedDatabaseConfig = { ...testDatabaseConfig(), database: db.name }
const tool = createTalentRediscoveryTool(cfg)

test.after(async () => { await db.drop() })

const DIMENSIONS = [{
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1,
  field: 'work_experience', operator: 'EXISTS', value: true,
}]

const TABLES = ['application', 'candidate', 'decision', 'interview', 'scorecard', 'resume_version'] as const

async function counts(client: DatabaseClient): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    // 顺序 await：pg 同一个 client 并行 query 会触发弃用告警。
    const result = await client.query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
    out[table] = result.rows[0]?.n ?? -1
  }
  return out
}

async function seedDecision(client: DatabaseClient, applicationId: string, decidedAt: string): Promise<string> {
  return one(client,
    `insert into recruitment.decision
       (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason, basis_refs, decided_at)
     values ($1, $2, 'SCREENING', 'S7', 'ADVANCE', $3, '集成测试：历史初筛通过', '[]'::jsonb, $4)
     returning id`,
    [TENANT, applicationId, cfg.actor_id, decidedAt],
  )
}

async function seedInterview(client: DatabaseClient, applicationId: string, roundNo: number, changedAt: string): Promise<string> {
  return one(client,
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, status, scheduled_start_at, status_changed_at)
     values ($1, $2, $3, 'POST_INTERVIEW', now(), $4)
     returning id`,
    [TENANT, applicationId, roundNo, changedAt],
  )
}

interface Result {
  tool: string
  contract_version: string
  read_only: boolean
  job: {
    job_id: string
    code: string
    title: string
    rubric_requirements: Array<{ key: string; label: string; kind: string; field?: string }>
  }
  candidates: Array<{
    candidate_id: string
    candidate_name: string
    matched_condition_count: number
    last_active_at: string | null
    basis: Array<{ code: string; label: string; detail: string; source: string; at: string | null }>
  }>
  total_matched: number
  note: string
}

test('talent rediscovery：召回命中、排除已投递、排序、零写入', async () => {
  const client = await db.pool.connect()
  let targetJobId: string
  let recalledCandidateId: string
  let appliedCandidateId: string
  try {
    await client.query('begin')
    // 目标岗位（有当前 rubric）+ 一个历史岗位（不同 job）。
    const target = await seedScenario(client, { dimensions: DIMENSIONS, fields: { work_experience: { state: 'present' } } })
    const old = await seedScenario(client, { dimensions: DIMENSIONS, jobStatus: 'CLOSED' })
    // 候选人甲只投递过历史岗位（应被召回）。
    recalledCandidateId = old.candidateId
    await seedDecision(client, old.applicationId, '2026-10-18T00:00:00.000Z')
    await seedInterview(client, old.applicationId, 2, '2026-10-20T00:00:00.000Z')
    // 候选人乙投递了目标岗位（必须被排除）：手工建 candidate + application（复用目标岗位的版本）。
    appliedCandidateId = await one(client,
      `insert into recruitment.candidate (tenant_id, display_name, identity_status)
       values ($1, '已投递目标岗位的人', 'ACTIVE') returning id`, [TENANT])
    await client.query(
      `insert into recruitment.application
         (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, current_stage_code)
       values ($1, $2, $3, $4, $5, 'S7')`,
      [TENANT, appliedCandidateId, target.jobId, target.jobVersionId, target.rubricId],
    )
    targetJobId = target.jobId
    await client.query('commit')

    const before = await counts(client)
    const value = (await tool.execute({ job_id: targetJobId }, {})) as Result
    const after = await counts(client)

    assert.equal(value.tool, TALENT_REDISCOVERY_TOOL_NAME)
    assert.equal(value.read_only, true)
    assert.equal(value.job.job_id, targetJobId)
    assert.equal(value.job.rubric_requirements[0]?.label, '有工作经历')
    assert.equal(value.job.rubric_requirements[0]?.field, undefined, '内部材料字段名不进入出参')
    assert.ok(value.candidates.some((c) => c.candidate_id === recalledCandidateId), '历史候选人应被召回')
    assert.equal(value.candidates.some((c) => c.candidate_id === appliedCandidateId), false, '已投递目标岗位的人必须排除')
    const recalled = value.candidates.find((c) => c.candidate_id === recalledCandidateId)!
    const codes = recalled.basis.map((b) => b.code)
    assert.ok(codes.includes('HISTORICAL_JOB'))
    assert.ok(codes.includes('SCREENING_PASSED'))
    assert.ok(codes.includes('SECOND_INTERVIEW'))
    assert.ok(codes.includes('RUBRIC_FIELD:work_exists'), '当前 rubric 要求命中应可复核')
    assert.equal(recalled.matched_condition_count, recalled.basis.length)
    assert.deepEqual(before, after, '只读工具不得改动任何业务表')

    const text = JSON.stringify(value)
    assert.equal(/证据/.test(text), false)
    assert.equal(/"score"|"percentage"|"rank"|%/i.test(text), false)
    // 排序第一关键字：条件数多者在前；第二关键字：最近活跃时间倒序。
    for (let i = 1; i < value.candidates.length; i += 1) {
      const prev = value.candidates[i - 1]!
      const cur = value.candidates[i]!
      assert.ok(
        prev.matched_condition_count > cur.matched_condition_count
          || (prev.matched_condition_count === cur.matched_condition_count
            && (prev.last_active_at ?? '') >= (cur.last_active_at ?? '')),
        '顺序必须可按条件数 + 最近活跃时间解释',
      )
    }
  } finally {
    try { await client.query('rollback') } catch { /* 已 commit，忽略 */ }
    client.release()
  }
})

test('talent rediscovery：非法/不存在的 job fail-closed，零写入', async () => {
  const client = await db.pool.connect()
  try {
    const before = await counts(client)
    for (const bad of [
      { job_id: 'not-a-uuid' },
      { job_id: `${'1'.repeat(8)}-1111-4111-8111-000000000401/../x` },
      { job_id: '11111111-1111-4111-8111-000000000401', limit: 5 },
    ]) {
      await assert.rejects(
        () => tool.execute(bad, {}),
        (error: unknown) => error instanceof RecruitmentToolError && error.code === 'INVALID_ARGS',
        `should reject ${JSON.stringify(bad)}`,
      )
    }
    await assert.rejects(
      () => tool.execute({ job_id: '22222222-2222-4222-8222-000000000999' }, {}),
      (error: unknown) => error instanceof RecruitmentToolError && error.code === 'NOT_FOUND',
    )
    assert.deepEqual(await counts(client), before)
  } finally {
    client.release()
  }
})
