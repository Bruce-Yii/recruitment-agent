// 工作台客户端**纯函数**测试（node --test，无 DOM、无 React）。
//
// 覆盖口径：
//   1. `normalizeOverview`：空响应 / 缺字段 / 坏类型一律降级成 '' / 0 / []，不出现 NaN；
//   2. 六个 actor 列表 + unassigned 四类：行 id 提取、needs_scorecard、计数原样透传；
//   3. `normalizeFormSpec`：dimensions 顺序 = 服务端顺序、未知 assessment/overall 被丢弃、
//      无 key 的维度被丢弃（fail-closed）、未知 mode 降级为只读；
//   4. HTTP 错误体解析：`{error:{code,reason_code,message,detail}}` 保留契约字段；
//   5. 提交结果归一化：200 但 status !== 'OK' 视为失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeFormSpec,
  normalizeOverview,
  normalizeSubmitResult,
  parseHttpError,
  submitResultError,
  RecruitmentHttpError,
} from '../../src/client/normalize.ts'

test('normalizeOverview：空对象全部降级，不出现 NaN/undefined', () => {
  const overview = normalizeOverview({})
  assert.equal(overview.configured, false)
  assert.equal(overview.contract_version, '')
  assert.equal(overview.evaluated_at, '')
  assert.equal(overview.actor.actor_id, '')
  assert.equal(overview.actor.display_name, '')
  assert.deepEqual(overview.actor.roles, [])
  assert.deepEqual(overview.issues, [])
  for (const value of Object.values(overview.counts)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value) && value >= 0, `计数必须是有限非负数：${String(value)}`)
  }
  assert.equal(overview.counts.pending_total, 0)
  assert.equal(overview.counts.my_interviews_total, 0)
  assert.equal(overview.lists.pending_decisions.length, 0)
  assert.equal(overview.lists.my_interviews.length, 0)
  assert.equal(overview.lists.overdue_scorecards.length, 0)
  assert.equal(overview.lists.pending_reviews.length, 0)
  assert.equal(overview.lists.connector_incidents.length, 0)
  assert.equal(overview.lists.waiting_human_tasks.length, 0)
  assert.equal(overview.unassigned.note, '')
  assert.equal(overview.unassigned.pending_decisions.length, 0)
  assert.equal(overview.unassigned.pending_reviews.length, 0)
  assert.equal(overview.unassigned.waiting_human_tasks.length, 0)
  assert.equal(overview.unassigned.connector_incidents.length, 0)
})

test('normalizeOverview：坏类型降级（字符串计数 → 0，坏列表 → 空，坏 issues 被过滤）', () => {
  const overview = normalizeOverview({
    configured: 'yes',
    contract_version: 42,
    evaluated_at: null,
    actor: [],
    labels: { stage_code: '阶段', bad: 3 },
    counts: { pending_total: '9', active_total: Number.NaN, overdue_scorecards_total: -3, pending_by_stage: { S7: '2', S10: 1 } },
    lists: {
      my_interviews: 'oops',
      pending_decisions: [null, 'row', { application_id: 'app-1' }, { stage_code: 'S7' }],
    },
    unassigned: null,
    issues: [1, '', '缺 RECRUITMENT_DB_PASSWORD'],
  })
  assert.equal(overview.configured, false)
  assert.equal(overview.contract_version, '')
  assert.equal(overview.evaluated_at, '')
  assert.deepEqual(overview.actor, { actor_id: '', display_name: '', roles: [] })
  assert.deepEqual(overview.counts.pending_by_stage, { S7: 0, S10: 1 })
  assert.equal(overview.counts.pending_total, 0)
  assert.equal(overview.counts.active_total, 0)
  assert.equal(overview.counts.overdue_scorecards_total, 0)
  assert.equal(overview.lists.my_interviews.length, 0)
  // 只有对象行保留；`application_id` 缺失行 → id 为空串（不伪造）
  assert.equal(overview.lists.pending_decisions.length, 2)
  assert.equal(overview.lists.pending_decisions[0]?.id, 'app-1')
  assert.equal(overview.lists.pending_decisions[1]?.id, '')
  assert.deepEqual(overview.issues, ['缺 RECRUITMENT_DB_PASSWORD'])
  assert.equal(overview.labels.stage_code, '阶段')
  assert.equal(overview.labels.bad, undefined)
})

test('normalizeOverview：六个列表与 unassigned 四类的行/计数不被重算', () => {
  const overview = normalizeOverview({
    contract_version: 'recruitment-overview 1.0.0',
    configured: true,
    evaluated_at: '2026-11-15T04:00:00.000Z',
    actor: { actor_id: '11111111-1111-4111-8111-000000000104', display_name: '面试官 104', roles: ['INTERVIEWER'] },
    labels: { stage_code: '阶段', needs_scorecard: '需要面评' },
    counts: {
      pending_total: 1,
      pending_by_stage: { S10: 1 },
      active_total: 3,
      active_by_stage: { S7: 2, S10: 1 },
      my_interviews_total: 1,
      overdue_scorecards_total: 1,
      pending_reviews_total: 0,
      connector_incidents_total: 2,
      waiting_human_total: 1,
      unassigned_total: 4,
    },
    lists: {
      pending_decisions: [{ application_id: 'app-1', stage_code: 'S10', reason: '等决定' }],
      my_interviews: [
        { interview_id: 'iv-upcoming', round_no: 1, slot_code: 'A', status: 'SCHEDULED', needs_scorecard: false },
        { interview_id: 'iv-overdue', round_no: 1, status: 'POST_INTERVIEW', needs_scorecard: true },
      ],
      overdue_scorecards: [{ interview_id: 'iv-overdue', needs_scorecard: true, due_at: '2026-11-13T00:00:00Z' }],
      pending_reviews: [{ review_id: 'review-1', status: 'QUEUED' }],
      connector_incidents: [
        { run_id: 'run-1', status: 'FAILED', message: '转换失败' },
        { intake_id: 'intake-1', status: 'FAILED' },
      ],
      waiting_human_tasks: [{ task_id: 'task-1', title: '等待人工确认', business_refs: [{ kind: 'INTERVIEW', id: 'iv-overdue' }] }],
    },
    unassigned: {
      note: '全租户共享',
      pending_decisions: [{ application_id: 'app-unassigned', stage_code: 'S7' }],
      pending_reviews: [{ review_id: 'review-unassigned' }],
      waiting_human_tasks: [{ task_id: 'task-unassigned' }],
      connector_incidents: [{ run_id: 'run-unassigned' }],
    },
    issues: [],
  })

  assert.equal(overview.configured, true)
  assert.equal(overview.actor.display_name, '面试官 104')
  assert.deepEqual(overview.actor.roles, ['INTERVIEWER'])

  // 计数全部原样透传（不被列表长度改写：my_interviews 有 2 行但服务端计数是 1）
  assert.deepEqual(overview.counts, {
    pending_total: 1,
    pending_by_stage: { S10: 1 },
    active_total: 3,
    active_by_stage: { S7: 2, S10: 1 },
    my_interviews_total: 1,
    overdue_scorecards_total: 1,
    pending_reviews_total: 0,
    connector_incidents_total: 2,
    waiting_human_total: 1,
    unassigned_total: 4,
  })

  assert.equal(overview.lists.pending_decisions[0]?.id, 'app-1')
  assert.equal(overview.lists.pending_decisions[0]?.fields.find((field) => field.key === 'stage_code')?.label, '阶段')
  assert.equal(overview.lists.my_interviews.length, 2)
  assert.equal(overview.lists.my_interviews[1]?.id, 'iv-overdue')
  assert.equal(overview.lists.my_interviews[1]?.needs_scorecard, true)
  assert.equal(overview.lists.my_interviews[0]?.needs_scorecard, false)
  assert.equal(overview.lists.overdue_scorecards[0]?.id, 'iv-overdue')
  assert.equal(overview.lists.pending_reviews[0]?.id, 'review-1')
  assert.equal(overview.lists.connector_incidents[0]?.id, 'run-1')
  assert.equal(overview.lists.connector_incidents[1]?.id, 'intake-1')
  assert.equal(overview.lists.waiting_human_tasks[0]?.id, 'task-1')
  const refs = overview.lists.waiting_human_tasks[0]?.fields.find((field) => field.key === 'business_refs')?.value
  assert.equal(refs, 'INTERVIEW:iv-overdue')

  assert.equal(overview.unassigned.pending_decisions[0]?.id, 'app-unassigned')
  assert.equal(overview.unassigned.pending_reviews[0]?.id, 'review-unassigned')
  assert.equal(overview.unassigned.waiting_human_tasks[0]?.id, 'task-unassigned')
  assert.equal(overview.unassigned.connector_incidents[0]?.id, 'run-unassigned')
})

test('normalizeFormSpec：dimensions 保持服务端顺序、未知枚举丢弃、无 key 维度丢弃', () => {
  const spec = normalizeFormSpec({
    contract_version: 'scorecard-form 1.0.0',
    actor: { actor_id: '11111111-1111-4111-8111-000000000104', display_name: '面试官 104', roles: ['INTERVIEWER'] },
    interview: {
      id: 'iv-1',
      application_id: 'app-1',
      round_no: 1,
      slot_code: 'A',
      status: 'POST_INTERVIEW',
      scheduled_start_at: '2026-11-13T00:00:00Z',
    },
    rubric: {
      id: 'rubric-1',
      job_id: 'job-1',
      payload_hash: 'a'.repeat(64),
      dimensions: [
        { key: 'd1', label: '深度', kind: 'SCALE', weight: 1 },
        { key: 'd2', label: '协作', kind: 'SCALE', weight: 2 },
      ],
    },
    dimensions: [
      { key: 'd2', label: '协作', kind: 'SCALE', weight: 2, controls: { assessment: ['MET', 'NOT_MET', 'WAT'], score: { min: 1, max: 5 }, note_required: false } },
      { key: 'd1', label: '深度', kind: 'SCALE', weight: 1, controls: { assessment: ['NOT_OBSERVED'], score: { min: 2, max: 4 }, note_required: true } },
      { key: '', label: '无键维度', controls: { assessment: ['MET'] } },
    ],
    transcript_basis: { value: 'NO_TRANSCRIPT', options: ['NO_TRANSCRIPT', 'TRANSCRIPT'], locked: true },
    overall_options: ['ADVANCE', 'HOLD', 'REJECT', 'FOO'],
    mode: 'CREATE',
    current: null,
  })

  assert.equal(spec.contract_version, 'scorecard-form 1.0.0')
  assert.equal(spec.interview.id, 'iv-1')
  assert.equal(spec.interview.round_no, 1)
  assert.equal(spec.rubric.id, 'rubric-1')
  assert.equal(spec.rubric.dimensions.length, 2)
  assert.equal(spec.dimensions.length, 2, '无 key 的维度必须被丢弃（不能生成动态键）')
  assert.deepEqual(spec.dimensions.map((dimension) => dimension.key), ['d2', 'd1'], '顺序必须与服务端一致')
  assert.deepEqual(spec.dimensions[0]?.assessmentOptions, ['MET', 'NOT_MET'], '未知 assessment 必须被丢弃')
  assert.equal(spec.dimensions[1]?.scoreMin, 2)
  assert.equal(spec.dimensions[1]?.scoreMax, 4)
  assert.equal(spec.dimensions[1]?.noteRequired, true)
  assert.deepEqual(spec.overall_options, ['ADVANCE', 'HOLD', 'REJECT'])
  assert.equal(spec.transcript_basis.value, 'NO_TRANSCRIPT')
  assert.equal(spec.transcript_basis.locked, true)
  assert.equal(spec.mode, 'CREATE')
  assert.equal(spec.current, null)
})

test('normalizeFormSpec：缺字段 / 未知 mode 降级为只读，不抛错', () => {
  const spec = normalizeFormSpec({ mode: 'WEIRD', dimensions: 'nope', transcript_basis: null, current: { id: 'sc-1', status: 'SUBMITTED' } })
  assert.equal(spec.mode, 'ALREADY_SUBMITTED')
  assert.equal(spec.dimensions.length, 0)
  assert.equal(spec.transcript_basis.value, '')
  assert.equal(spec.transcript_basis.locked, false)
  assert.deepEqual(spec.overall_options, [])
  assert.equal(spec.current?.id, 'sc-1')
  assert.equal(spec.current?.status, 'SUBMITTED')
  assert.equal(spec.current?.revision_no, 0)
  assert.equal(normalizeFormSpec(null).interview.id, '')
})

test('normalizeFormSpec：rubric.dimensions 降级路径只生成骨架（没有可选项就不编造）', () => {
  const spec = normalizeFormSpec({
    interview: { id: 'iv-1', round_no: '2' },
    rubric: { id: 'rub-1', dimensions: [{ key: 'dx', label: 'X', kind: 'SCALE', weight: 3 }] },
    mode: 'CREATE',
  })
  assert.equal(spec.dimensions.length, 1)
  assert.equal(spec.dimensions[0]?.key, 'dx')
  assert.deepEqual(spec.dimensions[0]?.assessmentOptions, [], '服务端没给枚举就不能自己编')
  assert.equal(spec.dimensions[0]?.scoreMin, 1)
  assert.equal(spec.dimensions[0]?.scoreMax, 5)
})

test('parseHttpError：契约错误体保留 status/code/reason_code/detail', () => {
  const error = parseHttpError(
    400,
    JSON.stringify({
      error: {
        code: 'INVALID_ARGS',
        reason_code: 'DIMENSION_NOT_IN_RUBRIC',
        message: 'dimensions 含 rubric 没有的键',
        detail: { unexpected: ['free_forged_key'] },
      },
    }),
  )
  assert.ok(error instanceof RecruitmentHttpError)
  assert.ok(error instanceof Error)
  assert.equal(error.status, 400)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.equal(error.reasonCode, 'DIMENSION_NOT_IN_RUBRIC')
  assert.equal(error.message, 'INVALID_ARGS/DIMENSION_NOT_IN_RUBRIC：dimensions 含 rubric 没有的键')
  assert.deepEqual(error.detail, { unexpected: ['free_forged_key'] })
})

test('parseHttpError：{error:"文本"} / 纯文本 / 空体都能转成可读错误', () => {
  const stringError = parseHttpError(403, JSON.stringify({ error: 'forbidden' }))
  assert.equal(stringError.status, 403)
  assert.equal(stringError.code, '')
  assert.ok(stringError.message.includes('forbidden'))

  const textError = parseHttpError(500, 'boom from server')
  assert.equal(textError.status, 500)
  assert.ok(textError.message.includes('HTTP 500'))
  assert.ok(textError.message.includes('boom from server'))

  const emptyError = parseHttpError(502, '')
  assert.equal(emptyError.status, 502)
  assert.equal(emptyError.message, '宿主返回 HTTP 502')

  const nestedDetail = parseHttpError(409, JSON.stringify({ error: { code: 'CONFLICT', detail: '版本冲突' } }))
  assert.ok(nestedDetail.message.includes('CONFLICT'))
  assert.ok(nestedDetail.message.includes('版本冲突'))
})

test('normalizeSubmitResult + submitResultError：成功回显字段齐全，工具层失败不当成功', () => {
  const ok = normalizeSubmitResult({
    status: 'OK',
    replayed: false,
    scorecard: { id: 'sc-1', revision_no: 1, status: 'SUBMITTED' },
    coverage: { dimensions: 3, transcript_basis: true },
  })
  assert.equal(ok.status, 'OK')
  assert.equal(ok.replayed, false)
  assert.equal(ok.scorecard.id, 'sc-1')
  assert.equal(ok.scorecard.revision_no, 1)
  assert.equal(ok.scorecard.status, 'SUBMITTED')
  assert.deepEqual(ok.coverage, { dimensions: 3, transcript_basis: true })
  assert.equal(submitResultError({ status: 'OK' }), null)

  const failure = submitResultError({
    status: 'ERROR',
    error: { code: 'FAIL_PRECONDITION', reason_code: 'RUBRIC_VERSION_MISMATCH', message: 'rubric 版本不一致' },
  })
  assert.ok(failure instanceof RecruitmentHttpError)
  assert.equal(failure.code, 'FAIL_PRECONDITION')
  assert.equal(failure.reasonCode, 'RUBRIC_VERSION_MISMATCH')
  assert.ok(failure.message.includes('rubric 版本不一致'))

  const emptyFailure = submitResultError(undefined)
  assert.ok(emptyFailure instanceof RecruitmentHttpError, '空响应不能被当成成功')
  assert.ok(emptyFailure.message.includes('空响应'))
})
