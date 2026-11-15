// `src/client/shell/role-api.ts` 的纯函数单测（不连网、无 DOM）。
//
// 覆盖：写动作信封解析 / 待批准 Rubric 派生 / hiring 视图归一化降级 / 三个 body 组包的契约形状 /
// 错误码人话 / readback 展示。运行：`node --test test/unit/role-api.test.ts`。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDecisionRecordBody,
  buildRubricApproveBody,
  buildSettingsTeamCreateBody,
  deriveHiringView,
  derivePendingRubricApprovals,
  describeActionError,
  isDecisionFactsMissing,
  isWriteAuthorizedAliasValue,
  normalizeDecisionFacts,
  parseActionEnvelope,
  readbackLines,
  type DecisionFactsView,
} from '../../src/client/shell/role-api.ts'

const JOB = '11111111-1111-4111-8111-000000000401'
const RUBRIC = '11111111-1111-4111-8111-000000000404'
const DEPT = '11111111-1111-4111-8111-000000000010'
const APP = '11111111-1111-4111-8111-000000000701'

test('parseActionEnvelope：标准信封逐键解析；坏形状 → null（不猜）', () => {
  const body = JSON.stringify({
    action: 'job/rubric-approve',
    actor: { session_id: 'session-x', alias: 'recruiter', actor_id: JOB },
    approval: { requested: 1, result: 'allowed-once', tool_names: ['recruitment_job_rubric_approve'] },
    result: { outcome: 'APPROVED' },
    readback: { approval: { approval_id: JOB, status: 'APPROVED' } },
  })
  const envelope = parseActionEnvelope(body)
  assert.ok(envelope !== null)
  assert.equal(envelope.action, 'job/rubric-approve')
  assert.equal(envelope.actor.alias, 'recruiter')
  assert.equal(envelope.approval.result, 'allowed-once')
  assert.equal(envelope.readback?.approval !== undefined, true)
  assert.equal(parseActionEnvelope('not json'), null)
  assert.equal(parseActionEnvelope(JSON.stringify({ actor: {} })), null)
  assert.equal(parseActionEnvelope(JSON.stringify([])), null)
})

test('derivePendingRubricApprovals：只取 approved!==true 且有 rubric_version_id 的岗位', () => {
  const overview = {
    jobs: [
      { job_id: JOB, title: '岗 A', code: 'A', status: 'OPEN', rubric: { rubric_version_id: RUBRIC, version_no: 2, approved: false } },
      { job_id: 'job-2', title: '岗 B', status: 'OPEN', rubric: { rubric_version_id: 'r2', version_no: 1, approved: true } },
      { job_id: 'job-3', title: '岗 C', status: 'DRAFT', rubric: null },
      { job_id: 'job-4', title: '岗 D', status: 'OPEN', rubric: { rubric_version_id: '', version_no: 1, approved: false } },
    ],
  }
  const rows = derivePendingRubricApprovals(overview)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.jobId, JOB)
  assert.equal(rows[0]?.rubricVersionId, RUBRIC)
  assert.equal(rows[0]?.versionNo, 2)
  assert.deepEqual(derivePendingRubricApprovals({}), [])
  assert.deepEqual(derivePendingRubricApprovals(null), [])
})

test('deriveHiringView：坏类型降级为 空串/0/空数组，待决策 = S10 或 next_step 含 DECISION', () => {
  const overview = {
    configured: true,
    issues: [],
    counts: { interviews_scheduled: 3, awaiting_decision: 1 },
    jobs: [{ job_id: JOB, title: '岗', code: 'A', status: 'OPEN', department_name: '研发部', rubric: { rubric_version_id: RUBRIC, version_no: 1, approved: false }, application_counts: { total: 2, active: 1 }, next_step: { label: '等决策' } }],
    applications: [
      {
        application_id: APP,
        candidate: { display_name: '候选人甲' },
        job: { title: '岗' },
        lifecycle_status: 'ACTIVE',
        current_stage_code: 'S10',
        progress: { transcript_state: 'READY', scorecards_submitted: 2, scorecards_required: 2, next_step: { code: 'PROVIDE_DECISION', label: '等正式决策' } },
        interviews: [{}, {}],
      },
      {
        application_id: 'app-2',
        candidate: {},
        job: {},
        current_stage_code: 'S6',
        progress: { next_step: { code: 'PROVIDE_SCREENING_DECISION', label: '等初筛' } },
      },
    ],
    settings: {
      departments: [{ department_id: DEPT, name: '研发部（演示）' }],
      hiring_teams: [{ team_id: 'team-1', code: 'T1', name: '团队 1', members: [{ actor_id: 'a' }] }],
    },
  }
  const view = deriveHiringView(overview)
  assert.equal(view.jobs.length, 1)
  assert.equal(view.jobs[0]?.totalApplications, 2)
  assert.equal(view.applications.length, 2)
  assert.equal(view.applications[0]?.candidateName, '候选人甲')
  assert.equal(view.applications[0]?.interviewCount, 2)
  assert.equal(view.pendingApplications.length, 1, 'S10 申请进待决策')
  assert.equal(view.pendingApplications[0]?.id, APP)
  assert.equal(view.interviewsScheduled, 3)
  assert.equal(view.departments[0]?.id, DEPT)
  assert.equal(view.hiringTeams[0]?.memberCount, 1)
  const empty = deriveHiringView(null)
  assert.deepEqual(empty.jobs, [])
  assert.deepEqual(empty.applications, [])
  assert.equal(empty.interviewsScheduled, 0)
})

test('normalizeDecisionFacts：缺 application_id → null；summary 字段如实', () => {
  assert.equal(normalizeDecisionFacts({}), null)
  const facts = normalizeDecisionFacts({
    application_id: APP,
    stage_code: 'S10',
    evaluation_summary: { available: true, as_of: '2026-11-15T10:00:00+08:00', summary_digest: 'a'.repeat(64) },
    missing: [{ key: 'scorecards', reason: '缺面评' }],
  })
  assert.ok(facts !== null)
  assert.equal(facts.summaryAvailable, true)
  assert.equal(facts.asOf, '2026-11-15T10:00:00+08:00')
  assert.equal(facts.missing[0]?.key, 'scorecards')
  assert.equal(isDecisionFactsMissing(404), true)
  assert.equal(isDecisionFactsMissing(500), false)
})

test('buildRubricApproveBody：UUID 必填 + reason ≤500；正例 body 精确', () => {
  const ok = buildRubricApproveBody({ jobId: JOB, rubricVersionId: RUBRIC })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.deepEqual(ok.body, { job_id: JOB, rubric_version_id: RUBRIC })
  const withReason = buildRubricApproveBody({ jobId: JOB, rubricVersionId: RUBRIC, reason: '  人确认批准  ' })
  assert.equal(withReason.ok, true)
  if (withReason.ok) assert.equal(withReason.body.reason, '人确认批准')
  const bad = buildRubricApproveBody({ jobId: 'x', rubricVersionId: '' })
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.equal(bad.reasonCode, 'MISSING_OR_INVALID_ID')
    assert.deepEqual([...bad.missing].sort(), ['job_id', 'rubric_version_id'])
  }
  const tooLong = buildRubricApproveBody({ jobId: JOB, rubricVersionId: RUBRIC, reason: 'x'.repeat(501) })
  assert.equal(tooLong.ok, false)
})

test('buildSettingsTeamCreateBody：code 正则 / name / department_id；正例 body 精确（config 统一入口）', () => {
  const ok = buildSettingsTeamCreateBody({ code: 'D5ROLES_T1', name: 'D5 演示团队', departmentId: DEPT })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.body, { entity: 'team', operation: 'create', code: 'D5ROLES_T1', name: 'D5 演示团队', department_id: DEPT })
  }
  for (const code of ['d5roles', 'A', '1ABC', 'D5-ROLES']) {
    assert.equal(buildSettingsTeamCreateBody({ code, name: 'x', departmentId: DEPT }).ok, false, code)
  }
  assert.equal(buildSettingsTeamCreateBody({ code: 'D5_T1', name: '', departmentId: DEPT }).ok, false)
  assert.equal(buildSettingsTeamCreateBody({ code: 'D5_T1', name: 'x', departmentId: 'nope' }).ok, false)
})

test('buildDecisionRecordBody：summary 不可用 / as_of 无偏移均拒绝；正例只含业务选择', () => {
  const goodFacts: DecisionFactsView = {
    applicationId: APP,
    stageCode: 'S10',
    summaryAvailable: true,
    asOf: '2026-11-15T10:00:00+08:00',
    summaryDigest: 'a'.repeat(64),
    missing: [],
  }
  const ok = buildDecisionRecordBody({ applicationId: APP, result: 'HOLD', reason: '暂缓保留候选人', facts: goodFacts })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.deepEqual(ok.body, { application_id: APP, decision_scope: 'FINAL', result: 'HOLD', reason: '暂缓保留候选人', as_of: goodFacts.asOf })
  }
  assert.equal(buildDecisionRecordBody({ applicationId: APP, result: 'HIRED', reason: 'x', facts: goodFacts }).ok, false, 'HIRED 禁用')
  assert.equal(buildDecisionRecordBody({ applicationId: APP, result: 'HOLD', reason: '', facts: goodFacts }).ok, false)
  const noSummary = buildDecisionRecordBody({ applicationId: APP, result: 'HOLD', reason: 'x', facts: { ...goodFacts, summaryAvailable: false } })
  assert.equal(noSummary.ok, false)
  if (!noSummary.ok) assert.equal(noSummary.reasonCode, 'SUMMARY_MISSING')
  const badAsOf = buildDecisionRecordBody({ applicationId: APP, result: 'HOLD', reason: 'x', facts: { ...goodFacts, asOf: '2026-11-15 10:00' } })
  assert.equal(badAsOf.ok, false)
  const noFacts = buildDecisionRecordBody({ applicationId: APP, result: 'HOLD', reason: 'x', facts: null })
  assert.equal(noFacts.ok, false)
  if (!noFacts.ok) assert.equal(noFacts.reasonCode, 'DECISION_FACTS_MISSING')
})

test('describeActionError / readbackLines / 写授权别名', () => {
  assert.match(describeActionError('FORBIDDEN', 'ACTOR_NOT_AUTHORIZED'), /Recruiter/)
  assert.equal(describeActionError('X', 'Y'), '')
  const lines = readbackLines({ approval_id: JOB, status: 'APPROVED', extra: { a: 1 } })
  assert.equal(lines.length, 3)
  assert.equal(lines[0]?.key, 'approval_id')
  assert.equal(lines[0]?.label, '审批行 id')
  assert.equal(lines[1]?.value, 'APPROVED')
  assert.match(lines[2]?.value ?? '', /"a":1/)
  assert.deepEqual(readbackLines(null), [])
  assert.equal(isWriteAuthorizedAliasValue('recruiter'), true)
  for (const alias of ['approver', 'hiring_manager', 'interviewer_a', '', null, undefined]) {
    assert.equal(isWriteAuthorizedAliasValue(alias), false, String(alias))
  }
})
