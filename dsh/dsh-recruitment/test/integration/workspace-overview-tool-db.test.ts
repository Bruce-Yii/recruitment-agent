// recruitment_workspace_overview 真库集成测试：独立一次性库（迁移 0001→N + 0002_seed 演示数据），
// 覆盖过滤参数、空结果、非法 UUID fail-closed 与业务表零写入（只读事务由工具内部保证）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createWorkspaceOverviewTool,
  WORKSPACE_OVERVIEW_TOOL_NAME,
} from '../../src/tools/workspace-overview.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import { createIsolatedTestDatabase, testDatabaseConfig } from './db.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'

const db = await createIsolatedTestDatabase('overview_tool')
const cfg: ResolvedDatabaseConfig = { ...testDatabaseConfig(), database: db.name }
const tool = createWorkspaceOverviewTool(cfg)

test.after(async () => { await db.drop() })

const TABLES = ['application', 'interview', 'scorecard', 'scorecard_draft', 'decision', 'candidate_constraint'] as const

async function counts(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const table of TABLES) {
    const r = await db.pool.query(`select count(*)::text as n from recruitment.${table}`)
    out[table] = String(r.rows[0]?.n)
  }
  return out
}

test('workspace overview：默认读取真实数据 + 业务表零写入', async () => {
  const before = await counts()
  const value = (await tool.execute({})) as {
    tool: string
    read_only: boolean
    counts: { applications_active: number; jobs_open: number }
    jobs: Array<{ job_id: string; rubric_approved: boolean }>
    applications: Array<{
      application_id: string
      candidate_name: string
      stage_code: string
      stage_label: string
      overdue_scorecards: number
      stage_blocked_reason: string | null
      next_step: { code: string; label: string; kind: string }
    }>
  }
  const after = await counts()
  assert.equal(value.tool, WORKSPACE_OVERVIEW_TOOL_NAME)
  assert.equal(value.read_only, true)
  assert.ok(value.counts.jobs_open >= 1)
  assert.ok(value.counts.applications_active >= 1)
  assert.ok(value.jobs.length >= 1)
  assert.ok(value.applications.length >= 1)
  const app = value.applications[0]
  assert.match(app.application_id, /^[0-9a-f-]{36}$/i)
  assert.ok(app.candidate_name.length > 0)
  assert.ok(app.stage_label.length > 0)
  assert.equal(typeof app.overdue_scorecards, 'number')
  assert.equal(typeof app.next_step.code, 'string')
  assert.deepEqual(before, after, '只读工具不得改动业务表')
})

test('workspace overview：过滤参数生效且不改变全局 counts', async () => {
  const all = (await tool.execute({ limit: 50 })) as {
    counts: { applications_active: number }
    jobs: Array<{ job_id: string }>
  }
  const jobId = all.jobs[0]?.job_id
  assert.ok(jobId)

  const byJob = (await tool.execute({ job_id: jobId, limit: 50 })) as {
    counts: { applications_active: number }
    jobs: Array<{ job_id: string }>
    applications: Array<{ application_id: string }>
  }
  assert.deepEqual(byJob.jobs.map((j) => j.job_id), [jobId])
  assert.equal(byJob.counts.applications_active, all.counts.applications_active)

  const screening = (await tool.execute({ stage_filter: 'screening', limit: 50 })) as {
    applications: Array<{ stage_code: string; next_step: { code: string } }>
  }
  for (const app of screening.applications) {
    assert.ok(app.stage_code === 'S7' || app.next_step.code === 'PROVIDE_SCREENING_DECISION')
  }

  const overdue = (await tool.execute({ only_overdue_scorecards: true, limit: 50 })) as {
    applications: Array<{ overdue_scorecards: number }>
  }
  for (const app of overdue.applications) assert.ok(app.overdue_scorecards > 0)

  const one = (await tool.execute({ limit: 1 })) as { applications: unknown[] }
  assert.equal(one.applications.length, 1)
})

test('workspace overview：非法 UUID / 非法 stage / 越界 limit fail-closed，且零写入', async () => {
  const before = await counts()
  for (const bad of [
    { job_id: 'not-a-uuid' },
    { stage_filter: 'other' },
    { limit: 0 },
    { limit: 51 },
    { unexpected: true },
  ]) {
    await assert.rejects(
      () => tool.execute(bad),
      (error: unknown) => error instanceof RecruitmentToolError && error.code === 'INVALID_ARGS',
      `should reject ${JSON.stringify(bad)}`,
    )
  }
  const missing = (await tool.execute({ job_id: '22222222-2222-4222-8222-000000000999' })) as {
    jobs: unknown[]
    applications: unknown[]
  }
  assert.deepEqual(missing.jobs, [])
  assert.deepEqual(missing.applications, [])
  assert.deepEqual(await counts(), before)
})
