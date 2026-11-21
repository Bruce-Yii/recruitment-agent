// recruitment_workspace_overview 纯函数单测：入参 fail-closed、过滤、limit、空结果、精简投影。
// 不连库：`projectWorkspaceOverview` 只消费 HTTP overview 投影；真实库零写入由运行中的工具探针/全量测试覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeWorkspaceOverviewArgs,
  projectWorkspaceOverview,
  unconfiguredWorkspaceOverviewTool,
  WORKSPACE_OVERVIEW_TOOL_NAME,
  type WorkspaceOverviewArgs,
} from '../../src/tools/workspace-overview.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import type { ApplicationCard, JobCard, RecruitingOverview } from '../../src/http/recruiting.ts'

const JOB_A = '11111111-1111-4111-8111-000000000401'
const JOB_B = '11111111-1111-4111-8111-000000000402'
const APP_SCREENING = '11111111-1111-4111-8111-000000000701'
const APP_INTERVIEW = '11111111-1111-4111-8111-000000000702'
const APP_AWAITING = '11111111-1111-4111-8111-000000000703'
const APP_DECIDED = '11111111-1111-4111-8111-000000000704'

function interview(overdue: number, required = 1): ApplicationCard['interviews'][number] {
  return {
    interview_id: `iv-${overdue}`,
    round_no: 1,
    slot_code: 'R1',
    stage_code: 'S8',
    status: 'SCHEDULED',
    scheduled_start_at: null,
    scheduled_end_at: null,
    timezone: 'Asia/Shanghai',
    record_version: 1,
    interviewers: [],
    scorecards: { required_total: required, submitted: 0, missing_total: required, overdue },
    round_focus: { available: false, source: 'JOB_BASE', reason: 'test fixture' },
    transcript: { state: 'MISSING' },
  } as unknown as ApplicationCard['interviews'][number]
}

function application(overrides: {
  id: string
  jobId: string
  stage: string
  nextCode: string
  nextLabel: string
  overdue?: number
  blocked?: string | null
  currentStageDecision?: boolean
}): ApplicationCard {
  return {
    application_id: overrides.id,
    candidate: { candidate_id: `cand-${overrides.id}`, display_name: '演示候选人' },
    job: { job_id: overrides.jobId, code: 'DEMO-BE-001', title: '后端工程师（演示）' },
    rubric_version_id: null,
    rubric: null,
    lifecycle_status: 'ACTIVE',
    current_stage_code: overrides.stage,
    stage_entered_at: null,
    applied_at: null,
    stage_blocked_reason: overrides.blocked ?? null,
    record_version: 1,
    material: null,
    screening: null,
    interviews: overrides.overdue === undefined ? [] : [interview(overrides.overdue)],
    decisions: overrides.currentStageDecision
      ? [{
        decision_id: 'd-1',
        decision_scope: 'STAGE',
        stage_code: 'S10',
        result: 'PASS',
        reason: 'test',
        decided_at: null,
        decided_by_actor_id: null,
        decided_by_display_name: null,
        is_current: true,
        superseded_by_decision_id: null,
        basis_kinds: [],
      }]
      : [],
    constraints: [],
    starred: false,
    progress: {
      scorecards_required: overrides.overdue === undefined ? 0 : 1,
      scorecards_submitted: 0,
      transcript_state: 'MISSING',
      next_step: { code: overrides.nextCode, label: overrides.nextLabel, kind: 'HUMAN_ACTION' },
    },
  } as unknown as ApplicationCard
}

function job(jobId: string, code: string, active: number, approved: boolean): JobCard {
  return {
    job_id: jobId,
    code,
    title: '后端工程师（演示）',
    status: 'OPEN',
    department_name: null,
    created_at: null,
    status_changed_at: null,
    version_no: 1,
    rubric: approved ? { rubric_version_id: 'r-1', version_no: 1, approved: true, dimension_count: 1 } : null,
    postings: [],
    application_counts: { total: active, active, by_stage: { S7: active } },
    next_step: { code: 'CONTINUE', label: '继续' },
  } as unknown as JobCard
}

function overview(): RecruitingOverview {
  return {
    contract_version: '1.0.0',
    configured: true,
    issues: [],
    evaluated_at: '2026-11-21T00:00:00.000Z',
    actor: { actor_id: '', display_name: '', roles: [] },
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: {
      jobs_total: 2, jobs_open: 2,
      applications_total: 4, applications_active: 4,
      applications_by_stage: { S7: 1, S8: 1, S10: 2 },
      awaiting_screening: 1, interviewing: 1, awaiting_decision: 1,
      interviews_scheduled: 1,
      scorecards_required_total: 2, scorecards_submitted_total: 0,
      transcripts_ready: 0, transcripts_pending: 0,
    },
    jobs: [job(JOB_A, 'DEMO-BE-001', 2, true), job(JOB_B, 'DEMO-BE-002', 1, false)],
    applications: [
      application({
        id: APP_SCREENING, jobId: JOB_A, stage: 'S7',
        nextCode: 'PROVIDE_SCREENING_DECISION', nextLabel: '等待初筛决定',
        blocked: '材料已就绪，还没有人工作出筛选结论', overdue: 1,
      }),
      application({
        id: APP_INTERVIEW, jobId: JOB_A, stage: 'S8',
        nextCode: 'WAIT_SCORECARDS', nextLabel: '等待面评',
      }),
      application({
        id: APP_AWAITING, jobId: JOB_B, stage: 'S10',
        nextCode: 'AWAIT_DECISION', nextLabel: '等待决策',
      }),
      application({
        id: APP_DECIDED, jobId: JOB_B, stage: 'S10',
        nextCode: 'CONTINUE', nextLabel: '继续', currentStageDecision: true,
      }),
    ],
    settings: {
      stage_catalog: {
        version_no: 1,
        effective_from: '2026-11-01T00:00:00.000Z',
        stages: [
          { code: 'S7', label: '初筛 / Screening', kind: 'SCREENING', order: 7, in_v1_scope: true },
          { code: 'S8', label: '面试 / Interview', kind: 'INTERVIEW', order: 8, in_v1_scope: true },
          { code: 'S10', label: '决策 / Decision', kind: 'DECISION', order: 10, in_v1_scope: true },
        ],
      },
      configs: [],
      departments: [],
      hiring_teams: [],
      entry: { available: false, href: null, note: 'read-only' },
    },
    actions: {} as unknown as RecruitingOverview['actions'],
  } as unknown as RecruitingOverview
}

const DEFAULTS: WorkspaceOverviewArgs = {
  stage_filter: 'all',
  only_overdue_scorecards: false,
  limit: 20,
}

test('normalizeWorkspaceOverviewArgs：默认值与合法过滤', () => {
  assert.deepEqual(normalizeWorkspaceOverviewArgs({}), DEFAULTS)
  assert.deepEqual(
    normalizeWorkspaceOverviewArgs({
      job_id: JOB_A,
      stage_filter: 'screening',
      only_overdue_scorecards: true,
      limit: 3,
    }),
    { job_id: JOB_A, stage_filter: 'screening', only_overdue_scorecards: true, limit: 3 },
  )
})

test('normalizeWorkspaceOverviewArgs：非法输入 fail-closed', () => {
  const badInputs: unknown[] = [
    { job_id: 'not-a-uuid' },
    { job_id: '11111111-1111-4111-8111-000000000401/../x' },
    { stage_filter: 'other' },
    { stage_filter: 'all', only_overdue_scorecards: 'yes' },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { unexpected: true },
    null,
  ]
  for (const input of badInputs) {
    assert.throws(
      () => normalizeWorkspaceOverviewArgs(input),
      (error: unknown) => error instanceof RecruitmentToolError && error.code === 'INVALID_ARGS',
      `should reject ${JSON.stringify(input)}`,
    )
  }
})

test('projectWorkspaceOverview：全局 counts/超时总数与精简字段', () => {
  const result = projectWorkspaceOverview(overview(), DEFAULTS)
  assert.equal(result.tool, WORKSPACE_OVERVIEW_TOOL_NAME)
  assert.equal(result.read_only, true)
  assert.deepEqual(result.counts, {
    jobs_open: 2,
    applications_active: 4,
    awaiting_screening: 1,
    interviewing: 1,
    awaiting_decision: 1,
    scorecards_required: 2,
    scorecards_submitted: 0,
    overdue_scorecards_total: 1,
  })
  assert.equal(result.jobs.length, 2)
  assert.equal(result.applications.length, 4)
  const screening = result.applications.find((app) => app.application_id === APP_SCREENING)
  assert.equal(screening?.stage_label, '初筛 / Screening')
  assert.equal(screening?.overdue_scorecards, 1)
  assert.equal(screening?.next_step.code, 'PROVIDE_SCREENING_DECISION')
  assert.equal(screening?.stage_blocked_reason, '材料已就绪，还没有人工作出筛选结论')
  assert.equal(screening?.candidate_name, '演示候选人')
})

test('projectWorkspaceOverview：job_id / stage_filter / overdue / limit 过滤', () => {
  const screening = projectWorkspaceOverview(overview(), { ...DEFAULTS, stage_filter: 'screening' })
  assert.deepEqual(screening.applications.map((app) => app.application_id), [APP_SCREENING])

  const interviewing = projectWorkspaceOverview(overview(), { ...DEFAULTS, stage_filter: 'interviewing' })
  assert.deepEqual(interviewing.applications.map((app) => app.application_id), [APP_INTERVIEW])

  const awaiting = projectWorkspaceOverview(overview(), { ...DEFAULTS, stage_filter: 'awaiting_decision' })
  assert.deepEqual(awaiting.applications.map((app) => app.application_id), [APP_AWAITING])

  const overdue = projectWorkspaceOverview(overview(), { ...DEFAULTS, only_overdue_scorecards: true })
  assert.deepEqual(overdue.applications.map((app) => app.application_id), [APP_SCREENING])

  const byJob = projectWorkspaceOverview(overview(), { ...DEFAULTS, job_id: JOB_B })
  assert.deepEqual(byJob.jobs.map((j) => j.job_id), [JOB_B])
  assert.deepEqual(byJob.applications.map((app) => app.application_id), [APP_AWAITING, APP_DECIDED])

  const limited = projectWorkspaceOverview(overview(), { ...DEFAULTS, limit: 2 })
  assert.deepEqual(limited.applications.map((app) => app.application_id), [APP_SCREENING, APP_INTERVIEW])
  assert.equal(limited.counts.applications_active, 4)
})

test('projectWorkspaceOverview：无匹配时返回空数组而不是编造', () => {
  const result = projectWorkspaceOverview(overview(), { ...DEFAULTS, job_id: '22222222-2222-4222-8222-000000000999' })
  assert.deepEqual(result.jobs, [])
  assert.deepEqual(result.applications, [])
  assert.equal(result.counts.applications_active, 4)
})

test('unconfiguredWorkspaceOverviewTool：如实 NOT_CONFIGURED', async () => {
  const tool = unconfiguredWorkspaceOverviewTool(['database.host is required'])
  assert.equal(tool.name, WORKSPACE_OVERVIEW_TOOL_NAME)
  await assert.rejects(
    () => tool.execute({}),
    (error: unknown) => error instanceof RecruitmentToolError && error.code === 'NOT_CONFIGURED',
  )
})
