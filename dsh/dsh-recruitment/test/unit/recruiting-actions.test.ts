// W2b 写动作客户端契约层（`src/client/recruiting/actions.ts`）纯函数测试。
//
// 覆盖口径（`work/d5/w2b/INTERFACE.md` §2.1 + `work/d5/w2b/INTERFACE2.md` §2 + 任务书）：
//   1. 信封解析：标准 action 信封（合法 / 空体 / 非 JSON / 缺 readback）与 `job/close` 信封（八个计数键逐字）；
//   2. `terminatedLines` 顺序固定、`describeActionError` 已知码/未知码、路由探测 405/404/403；
//   3. 每个 build* 的正例/负例（缺键 / 长度 / 枚举 / 幂等键字符集 / 保留键）；
//   4. decision facts 归一化（坏类型/缺键 → null/缺省，不编造 hash/actor）；
//   5. SCREENING / facade 决策 body 的事实驱动：facts 缺 → 精确 reasonCode；basis_refs 不带 evaluation_id；
//      facade 只发五个键（前端不传 summary_digest/basis_refs）；
//   6. 发送前自检：保留键 / 空 body / 非同源路径 / 缺 session → 不发请求；
//   7. 读回显示（键/值原样）与 datetime-local → 带偏移 ISO。
//
// 本文件**只** import `actions.ts`（纯函数层，不 import react / use-recruiting / 组件），可被 `node --test` 直接跑。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_RESERVED_BODY_KEYS,
  DECISION_EVALUATE_PATH,
  DECISION_FACTS_PATH,
  DECISION_RECORD_PATH,
  JOB_CLOSE_PATH,
  JOB_CREATE_PATH,
  JOB_DRAFT_PATH,
  actionResultLines,
  buildDecisionRecordBody,
  buildInterviewScheduleBody,
  buildJobCloseBody,
  buildJobCreateBody,
  buildJobDraftBody,
  buildRubricApproveBody,
  buildScreeningDecisionBody,
  buildScreeningEvaluateBody,
  buildSettingsWriteBody,
  buildStageAdvanceBody,
  buildTranscriptImportBody,
  checkActionRequest,
  checkWriteRequest,
  decisionRecordBlockers,
  describeActionError,
  interpretCloseProbe,
  interpretRouteProbe,
  newIdempotencyKey,
  normalizeDecisionFacts,
  normalizeJobDraftResponse,
  parseActionEnvelope,
  parseActionPayload,
  parseJobCloseEnvelope,
  readbackLines,
  screeningDecisionBlockers,
  terminatedLines,
  toOffsetIso,
  type ActionEnvelope,
  type DecisionFacts,
} from '../../src/client/recruiting/actions.ts'
import type { ActionView } from '../../src/client/recruiting/view-model.ts'

// =====================================================================
//  fixtures（固定值，不依赖本机时间/路径）
// =====================================================================

const APP_ID = '11111111-1111-4111-8111-000000000001'
const JOB_ID = '11111111-1111-4111-8111-000000000002'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000003'
const ACTOR_ID = '11111111-1111-4111-8111-000000000103'
const EVAL_ID = '11111111-1111-4111-8111-000000000004'
const INTERVIEW_ID = '11111111-1111-4111-8111-000000000005'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const AS_OF = '2026-11-15T02:00:00.000+08:00'

/** 一个结构完整的 `GET /recruitment/api/decision/facts` fixture（`work/d5/decision/CONTRACT.md` §1）。 */
function factsWire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    contract_version: 'decision-facts 1.0.0',
    application_id: APP_ID,
    stage_code: 'S7',
    job: {
      job_id: JOB_ID,
      job_code: 'DEMO-BE-001',
      job_version_id: JOB_ID,
      job_payload_hash: SHA_A,
      current_job_version_id: JOB_ID,
      current_rubric_version_id: RUBRIC_ID,
    },
    rubric: {
      rubric_version_id: RUBRIC_ID,
      version_no: 1,
      payload_hash: SHA_A,
      dimensions: [{ key: 'backend_depth', label: '后端深度', weight: 0.4, required: true }],
    },
    authority: {
      actor_id: ACTOR_ID,
      alias: 'recruiter',
      display_name: '演示-HR',
      roles: ['HR'],
      is_hiring_manager: true,
    },
    screening_evaluation: {
      evaluation_id: EVAL_ID,
      evaluation_digest: SHA_B,
      verdict: 'ADVANCE',
      rubric_version_id: RUBRIC_ID,
      rubric_payload_hash: SHA_A,
      resume_version_id: INTERVIEW_ID,
      resume_content_sha256: SHA_A,
      as_of: AS_OF,
      criteria_evaluated: [],
      counts: {},
    },
    evaluation_summary: {
      available: true,
      as_of: AS_OF,
      summary_digest: SHA_B,
      warning_count: 0,
      warnings: [],
      source: 'EVALUATION_SUMMARIZE',
    },
    basis: {
      screening_decide: {
        rubric_version: { id: RUBRIC_ID, payload_hash: SHA_A },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        screening_evaluation: { evaluation_id: EVAL_ID, evaluation_digest: SHA_B, verdict: 'ADVANCE' },
      },
      decision_record: {
        as_of: AS_OF,
        summary_digest: SHA_B,
        rubric_version: { id: RUBRIC_ID, payload_hash: SHA_A },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        scorecards: [],
      },
    },
    missing: [],
  }
  return { ...wire, ...overrides }
}

/** facts fixture → 归一化后的 `DecisionFacts`（大部分用例从这里出发）。 */
function factsOf(overrides: Record<string, unknown> = {}): DecisionFacts {
  const facts = normalizeDecisionFacts(factsWire(overrides))
  assert.notEqual(facts, null, 'fixture 必须能归一化')
  return facts as DecisionFacts
}

/** 一个"无初筛评估"的 facts（basis.screening_decide 保留 rubric/authority，evaluation_summary 可给 as_of）。 */
function factsWithoutEvaluation(): DecisionFacts {
  return factsOf({
    screening_evaluation: null,
    basis: {
      screening_decide: {
        rubric_version: { id: RUBRIC_ID, payload_hash: SHA_A },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        screening_evaluation: null,
      },
      decision_record: {
        as_of: AS_OF,
        summary_digest: SHA_B,
        rubric_version: { id: RUBRIC_ID, payload_hash: SHA_A },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        scorecards: [],
      },
    },
    missing: [{ key: 'screening_evaluation', reason: '尚未执行初筛评估' }],
  })
}

/** 动作视图 fixture（`available` 只在服务端声明可用且 seam 非空时为 true）。 */
function actionView(overrides: Partial<ActionView> = {}): ActionView {
  return {
    key: 'stage_advance',
    label: '推进阶段',
    available: true,
    seam: '/recruitment/api/action/stage/advance',
    pending: '',
    pendingText: '',
    reasonText: '',
    ...overrides,
  }
}

/** 断言 build 失败并返回 reasonCode（便于逐条断言码而不吞失败）。 */
function assertBuildFail(result: ReturnType<typeof buildStageAdvanceBody>, expected: string): void {
  assert.equal(result.ok, false, `期望 build 失败（${expected}）`)
  if (!result.ok) assert.equal(result.reasonCode, expected)
}

/** 断言 build 成功并返回 body。 */
function assertBuildOk(result: ReturnType<typeof buildStageAdvanceBody>): Readonly<Record<string, unknown>> {
  assert.equal(result.ok, true, `期望 build 成功，实际：${result.ok ? '' : result.reasonCode}`)
  if (!result.ok) throw new Error(result.reasonCode)
  return result.body
}

// =====================================================================
//  1. 信封解析
// =====================================================================

test('parseActionEnvelope：合法信封逐字段解析', () => {
  const body = JSON.stringify({
    action: 'stage/advance',
    actor: { session_id: 'session-abc', alias: 'recruiter', actor_id: ACTOR_ID },
    approval: { requested: 1, result: 'allowed-once', tool_names: ['recruitment_application_stage_advance'] },
    result: { status: 'ADVANCED' },
    readback: { application_id: APP_ID, stage_code: 'S8', record_version: 2 },
  })
  const envelope = parseActionEnvelope(body)
  assert.notEqual(envelope, null)
  const parsed = envelope as ActionEnvelope
  assert.equal(parsed.action, 'stage/advance')
  assert.equal(parsed.actor.sessionId, 'session-abc')
  assert.equal(parsed.actor.alias, 'recruiter')
  assert.equal(parsed.actor.actorId, ACTOR_ID)
  assert.equal(parsed.approval.requested, 1)
  assert.equal(parsed.approval.result, 'allowed-once')
  assert.deepEqual(parsed.approval.toolNames, ['recruitment_application_stage_advance'])
  assert.deepEqual(parsed.result, { status: 'ADVANCED' })
  assert.deepEqual(parsed.readback, { application_id: APP_ID, stage_code: 'S8', record_version: 2 })
})

test('parseActionEnvelope：空体 / 非 JSON / 数组 / 缺 action → null', () => {
  assert.equal(parseActionEnvelope(''), null)
  assert.equal(parseActionEnvelope('   '), null)
  assert.equal(parseActionEnvelope('not json'), null)
  assert.equal(parseActionEnvelope('[1,2,3]'), null)
  assert.equal(parseActionEnvelope('{}'), null)
  assert.equal(parseActionEnvelope(JSON.stringify({ action: '' })), null)
})

test('parseActionEnvelope：缺 readback → readback 为 null（界面据此不当作成功）', () => {
  const envelope = parseActionEnvelope(JSON.stringify({ action: 'decision/record', result: {} }))
  assert.notEqual(envelope, null)
  assert.equal((envelope as ActionEnvelope).readback, null)
  assert.equal(readbackLines(envelope).length, 0)
})

test('parseActionPayload：非对象 JSON（标量/数组）→ null', () => {
  assert.equal(parseActionPayload('42'), null)
  assert.equal(parseActionPayload('"text"'), null)
  assert.equal(parseActionPayload('[]'), null)
  assert.deepEqual(parseActionPayload('{"a":1}'), { a: 1 })
})

// =====================================================================
//  2. job/close 信封 + 终止计数行
// =====================================================================

/** 一个合法的 job/close 200 响应体（键名逐字对齐 `work/d5/joblife/CONTRACT.md` §1）。 */
function jobCloseBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: '1.0.0',
    job: {
      job_id: JOB_ID,
      status: 'CLOSED',
      record_version: 2,
      status_changed_at: '2026-11-15T03:00:00.000+08:00',
      status_changed_by_actor_id: ACTOR_ID,
    },
    terminated: {
      applications_total: 4,
      applications_closed: 4,
      applications_already_closed: 1,
      interviews_cancelled: 2,
      interviews_already_terminal: 1,
      interviews_occurred_kept: 2,
      tasks_cancelled: 3,
      task_attempts_cancelled: 1,
    },
    actor: { actor_id: ACTOR_ID, alias: 'recruiter', display_name: '演示-HR 专员' },
    replayed: false,
    ...overrides,
  })
}

test('parseJobCloseEnvelope：八个计数键逐字映射', () => {
  const envelope = parseJobCloseEnvelope(jobCloseBody())
  assert.notEqual(envelope, null)
  const parsed = envelope as NonNullable<ReturnType<typeof parseJobCloseEnvelope>>
  assert.equal(parsed.contractVersion, '1.0.0')
  assert.equal(parsed.job.jobId, JOB_ID)
  assert.equal(parsed.job.status, 'CLOSED')
  assert.equal(parsed.job.recordVersion, 2)
  assert.equal(parsed.job.statusChangedByActorId, ACTOR_ID)
  assert.equal(parsed.terminated.applicationsTotal, 4)
  assert.equal(parsed.terminated.applicationsClosed, 4)
  assert.equal(parsed.terminated.applicationsAlreadyClosed, 1)
  assert.equal(parsed.terminated.interviewsCancelled, 2)
  assert.equal(parsed.terminated.interviewsAlreadyTerminal, 1)
  assert.equal(parsed.terminated.interviewsOccurredKept, 2)
  assert.equal(parsed.terminated.tasksCancelled, 3)
  assert.equal(parsed.terminated.taskAttemptsCancelled, 1)
  assert.equal(parsed.actor.alias, 'recruiter')
  assert.equal(parsed.actor.displayName, '演示-HR 专员')
  assert.equal(parsed.replayed, false)
})

test('parseJobCloseEnvelope：缺计数键 / 非数字 / 缺 replayed / 缺契约版本 → null（不编造 0）', () => {
  // 缺一个计数键
  const missingOne = JSON.parse(jobCloseBody()) as Record<string, unknown>
  delete (missingOne.terminated as Record<string, unknown>).tasks_cancelled
  assert.equal(parseJobCloseEnvelope(JSON.stringify(missingOne)), null)
  // 计数键是字符串
  const stringCount = JSON.parse(jobCloseBody()) as Record<string, unknown>
  ;(stringCount.terminated as Record<string, unknown>).applications_total = '4'
  assert.equal(parseJobCloseEnvelope(JSON.stringify(stringCount)), null)
  // 负计数
  const negative = JSON.parse(jobCloseBody()) as Record<string, unknown>
  ;(negative.terminated as Record<string, unknown>).interviews_cancelled = -1
  assert.equal(parseJobCloseEnvelope(JSON.stringify(negative)), null)
  // 缺 replayed
  const noReplayed = JSON.parse(jobCloseBody()) as Record<string, unknown>
  delete noReplayed.replayed
  assert.equal(parseJobCloseEnvelope(JSON.stringify(noReplayed)), null)
  // 缺 contract_version
  const noVersion = JSON.parse(jobCloseBody()) as Record<string, unknown>
  delete noVersion.contract_version
  assert.equal(parseJobCloseEnvelope(JSON.stringify(noVersion)), null)
  // 空体
  assert.equal(parseJobCloseEnvelope(''), null)
})

test('terminatedLines：八行顺序固定（申请→实际终止→已关闭→面试三类→任务两类）', () => {
  const envelope = parseJobCloseEnvelope(jobCloseBody())
  assert.notEqual(envelope, null)
  const lines = terminatedLines((envelope as NonNullable<ReturnType<typeof parseJobCloseEnvelope>>).terminated)
  assert.equal(lines.length, 8)
  assert.match(lines[0] as string, /申请.*4 条/)
  assert.match(lines[1] as string, /实际终止.*4 条/)
  assert.match(lines[2] as string, /此前已关闭.*1 条/)
  assert.match(lines[3] as string, /取消的未开始面试.*2 场/)
  assert.match(lines[4] as string, /已终态面试.*1 场/)
  assert.match(lines[5] as string, /已发生\/进行中的面试.*2 场/)
  assert.match(lines[6] as string, /取消的未完成任务.*3 个/)
  assert.match(lines[7] as string, /取消的任务尝试.*1 个/)
})

// =====================================================================
//  3. 错误码人话 + 路由探测
// =====================================================================

test('describeActionError：已知 code/reason_code 有补救文案，未知返回空串（不吞服务端 message）', () => {
  assert.notEqual(describeActionError('FORBIDDEN', 'ACTOR_NOT_AUTHORIZED'), '')
  assert.notEqual(describeActionError('DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND'), '')
  assert.notEqual(describeActionError('INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED'), '')
  assert.notEqual(describeActionError('NOT_CONFIGURED', ''), '')
  assert.notEqual(describeActionError('DECISION_FACTS_ROUTE_MISSING', ''), '')
  assert.equal(describeActionError('SOMETHING_NEW', 'NEW_REASON'), '')
  assert.equal(describeActionError('', ''), '')
})

test('interpretRouteProbe / interpretCloseProbe：405=已注册 POST 路由、404=未接线、403=同源、其它=UNKNOWN', () => {
  assert.equal(interpretRouteProbe(405), 'AVAILABLE')
  assert.equal(interpretRouteProbe(404), 'MISSING')
  assert.equal(interpretRouteProbe(403), 'FORBIDDEN')
  assert.equal(interpretRouteProbe(200), 'UNKNOWN')
  assert.equal(interpretRouteProbe(0), 'UNKNOWN')
  const available = interpretCloseProbe(405)
  assert.equal(available.state, 'AVAILABLE')
  assert.equal(available.status, 405)
  assert.notEqual(available.reasonText, '')
  assert.equal(interpretCloseProbe(404).state, 'MISSING')
  assert.equal(interpretCloseProbe(403).state, 'FORBIDDEN')
  assert.equal(interpretCloseProbe(500).state, 'UNKNOWN')
})

// =====================================================================
//  4. decision facts 归一化
// =====================================================================

test('normalizeDecisionFacts：合法 facts 逐字段归一化', () => {
  const facts = factsOf()
  assert.equal(facts.contractVersion, 'decision-facts 1.0.0')
  assert.equal(facts.applicationId, APP_ID)
  assert.equal(facts.stageCode, 'S7')
  assert.equal(facts.missing.length, 0)
  assert.notEqual(facts.screeningEvaluation, null)
  assert.equal(facts.screeningEvaluation?.evaluationId, EVAL_ID)
  assert.equal(facts.screeningEvaluation?.rubricPayloadHash, SHA_A)
  assert.equal(facts.screeningEvaluation?.asOf, AS_OF)
  assert.notEqual(facts.evaluationSummary, null)
  assert.equal(facts.evaluationSummary?.available, true)
  assert.equal(facts.evaluationSummary?.summaryDigest, SHA_B)
  assert.notEqual(facts.basisScreeningDecide, null)
  assert.equal(facts.basisScreeningDecide?.rubricVersion?.payloadHash, SHA_A)
  assert.equal(facts.basisScreeningDecide?.authority?.isHiringManager, true)
  assert.notEqual(facts.basisDecisionRecord, null)
  assert.equal(facts.basisDecisionRecord?.summaryDigest, SHA_B)
})

test('normalizeDecisionFacts：缺 application_id / 非对象 → null', () => {
  assert.equal(normalizeDecisionFacts(null), null)
  assert.equal(normalizeDecisionFacts([]), null)
  assert.equal(normalizeDecisionFacts('text'), null)
  assert.equal(normalizeDecisionFacts({}), null)
  assert.equal(normalizeDecisionFacts({ application_id: '' }), null)
  assert.equal(normalizeDecisionFacts({ application_id: '   ' }), null)
})

test('normalizeDecisionFacts：坏类型降级（auth 非布尔/缺 hash → null，不编造）', () => {
  const facts = factsOf({
    screening_evaluation: null,
    evaluation_summary: null,
    basis: {
      screening_decide: {
        rubric_version: { id: RUBRIC_ID },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: 'yes' },
        screening_evaluation: null,
      },
      decision_record: {},
    },
    missing: 'not-an-array',
  })
  assert.equal(facts.screeningEvaluation, null)
  assert.equal(facts.evaluationSummary, null)
  assert.equal(facts.basisScreeningDecide?.rubricVersion, null)
  assert.equal(facts.basisScreeningDecide?.authority, null)
  assert.deepEqual(facts.missing, [])
  assert.equal(facts.basisDecisionRecord, null)
})

test('normalizeDecisionFacts：只缺部分键时保留缺省值（不猜）', () => {
  const facts = factsOf({
    screening_evaluation: { evaluation_id: EVAL_ID },
    evaluation_summary: { available: false },
  })
  assert.equal(facts.screeningEvaluation?.evaluationDigest, '')
  assert.equal(facts.screeningEvaluation?.verdict, '')
  assert.equal(facts.evaluationSummary?.available, false)
  assert.equal(facts.evaluationSummary?.summaryDigest, '')
})

// =====================================================================
//  5. SCREENING 决策 body（facts 驱动）
// =====================================================================

test('buildStageAdvanceBody：唯一键 application_id（不发明 to_stage）', () => {
  const body = assertBuildOk(buildStageAdvanceBody({ applicationId: APP_ID }))
  assert.deepEqual(Object.keys(body), ['application_id'])
  assert.equal(body.application_id, APP_ID)
  assertBuildFail(buildStageAdvanceBody({ applicationId: '' }), 'MISSING_APPLICATION_ID')
  assertBuildFail(buildStageAdvanceBody({ applicationId: 'not-a-uuid' }), 'ID_NOT_UUID')
})

test('buildScreeningEvaluateBody：封闭键集只有 application_id', () => {
  const body = assertBuildOk(buildScreeningEvaluateBody({ applicationId: APP_ID }))
  assert.deepEqual(body, { application_id: APP_ID })
  assertBuildFail(buildScreeningEvaluateBody({ applicationId: '' }), 'MISSING_APPLICATION_ID')
})

test('buildScreeningDecisionBody：facts 缺失 → DECISION_FACTS_MISSING（不发请求）', () => {
  const result = buildScreeningDecisionBody({
    facts: null,
    result: 'HOLD',
    reason: '暂缓',
    applicationId: APP_ID,
  })
  assertBuildFail(result, 'DECISION_FACTS_MISSING')
})

test('buildScreeningDecisionBody：HOLD 可无初筛评估，basis_refs 只有 RUBRIC_VERSION + AUTHORITY', () => {
  const body = assertBuildOk(
    buildScreeningDecisionBody({
      facts: factsWithoutEvaluation(),
      result: 'HOLD',
      reason: '候选人与岗位方向不匹配，先暂缓',
      applicationId: APP_ID,
    }),
  )
  assert.deepEqual(Object.keys(body).sort(), ['application_id', 'as_of', 'basis_refs', 'reason', 'result'])
  assert.equal(body.as_of, AS_OF)
  const refs = body.basis_refs as Array<Record<string, unknown>>
  assert.deepEqual(
    refs.map((ref) => ref.kind),
    ['RUBRIC_VERSION', 'AUTHORITY'],
  )
  assert.equal(refs[0]?.payload_hash, SHA_A)
  assert.equal(refs[1]?.is_hiring_manager, true)
})

test('buildScreeningDecisionBody：ADVANCE 无 evaluation → MISSING_SCREENING_EVALUATION', () => {
  const result = buildScreeningDecisionBody({
    facts: factsWithoutEvaluation(),
    result: 'ADVANCE',
    reason: '通过',
    applicationId: APP_ID,
  })
  assertBuildFail(result, 'MISSING_SCREENING_EVALUATION')
})

test('buildScreeningDecisionBody：ADVANCE 带 evaluation → basis_refs 含六个事实键且不带 evaluation_id', () => {
  const body = assertBuildOk(
    buildScreeningDecisionBody({
      facts: factsOf(),
      result: 'ADVANCE',
      reason: '后端深度符合 rubric',
      applicationId: APP_ID,
    }),
  )
  const refs = body.basis_refs as Array<Record<string, unknown>>
  const evaluationRef = refs.find((ref) => ref.kind === 'SCREENING_EVALUATION')
  assert.notEqual(evaluationRef, undefined)
  assert.equal(evaluationRef?.evaluation_digest, SHA_B)
  assert.equal(evaluationRef?.verdict, 'ADVANCE')
  assert.equal(evaluationRef?.rubric_version_id, RUBRIC_ID)
  assert.equal(evaluationRef?.rubric_payload_hash, SHA_A)
  assert.equal(evaluationRef?.resume_version_id, INTERVIEW_ID)
  assert.equal(evaluationRef?.resume_content_sha256, SHA_A)
  assert.equal(Object.hasOwn(evaluationRef as object, 'evaluation_id'), false)
  assert.equal(body.decision_scope, undefined, 'screening 端点不传 decision_scope（scope 由端点固定）')
})

test('buildScreeningDecisionBody：缺 rubric payload_hash → MISSING_RUBRIC_PAYLOAD_HASH', () => {
  const facts = factsOf({
    basis: {
      screening_decide: {
        rubric_version: null,
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        screening_evaluation: { evaluation_id: EVAL_ID, evaluation_digest: SHA_B, verdict: 'ADVANCE' },
      },
      decision_record: {},
    },
  })
  assertBuildFail(
    buildScreeningDecisionBody({ facts, result: 'HOLD', reason: '暂缓', applicationId: APP_ID }),
    'MISSING_RUBRIC_PAYLOAD_HASH',
  )
})

test('buildScreeningDecisionBody：缺 as_of / 非法枚举 / 空理由 / 超长理由', () => {
  const noAsOf = factsOf({
    screening_evaluation: null,
    evaluation_summary: null,
    basis: {
      screening_decide: {
        rubric_version: { id: RUBRIC_ID, payload_hash: SHA_A },
        authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
        screening_evaluation: null,
      },
      decision_record: {},
    },
  })
  assertBuildFail(
    buildScreeningDecisionBody({ facts: noAsOf, result: 'HOLD', reason: '暂缓', applicationId: APP_ID }),
    'MISSING_AS_OF',
  )
  assertBuildFail(
    buildScreeningDecisionBody({
      facts: factsOf(),
      result: 'HIRED' as 'ADVANCE',
      reason: '通过',
      applicationId: APP_ID,
    }),
    'ENUM_INVALID',
  )
  assertBuildFail(
    buildScreeningDecisionBody({ facts: factsOf(), result: 'HOLD', reason: '   ', applicationId: APP_ID }),
    'MISSING_REASON',
  )
  assertBuildFail(
    buildScreeningDecisionBody({ facts: factsOf(), result: 'HOLD', reason: 'x'.repeat(4001), applicationId: APP_ID }),
    'REASON_OUT_OF_RANGE',
  )
})

test('buildScreeningDecisionBody：facts 与当前申请不一致 → APPLICATION_MISMATCH（不串申请）', () => {
  const otherApp = '11111111-1111-4111-8111-000000000099'
  assertBuildFail(
    buildScreeningDecisionBody({ facts: factsOf(), result: 'HOLD', reason: '暂缓', applicationId: otherApp }),
    'APPLICATION_MISMATCH',
  )
})

test('screeningDecisionBlockers：facts 缺 rubric/authority/as_of 时逐项列出', () => {
  assert.deepEqual(screeningDecisionBlockers(null, false), ['DECISION_FACTS_MISSING'])
  const blocked = screeningDecisionBlockers(
    factsOf({
      screening_evaluation: null,
      evaluation_summary: null,
      basis: { screening_decide: { rubric_version: null, authority: null, screening_evaluation: null }, decision_record: {} },
    }),
    true,
  )
  assert.ok(blocked.includes('MISSING_RUBRIC_PAYLOAD_HASH'))
  assert.ok(blocked.includes('MISSING_AUTHORITY_FACTS'))
  assert.ok(blocked.includes('MISSING_AS_OF'))
  assert.ok(blocked.includes('MISSING_SCREENING_EVALUATION'))
})

// =====================================================================
//  6. 正式决策 facade body（前端不传 hash/basis）
// =====================================================================

test('buildDecisionRecordBody：facts 缺失 → DECISION_FACTS_MISSING', () => {
  assertBuildFail(
    buildDecisionRecordBody({ facts: null, applicationId: APP_ID, scope: 'STAGE', result: 'HOLD', reason: '暂缓' }),
    'DECISION_FACTS_MISSING',
  )
})

test('buildDecisionRecordBody：summary 缺失/不可用 → SUMMARY_MISSING', () => {
  const summaryNull = factsOf({ evaluation_summary: null })
  assertBuildFail(
    buildDecisionRecordBody({ facts: summaryNull, applicationId: APP_ID, scope: 'FINAL', result: 'HOLD', reason: '暂缓' }),
    'SUMMARY_MISSING',
  )
  const summaryUnavailable = factsOf({
    evaluation_summary: { available: false, as_of: AS_OF, summary_digest: SHA_B, warning_count: 0, source: '' },
  })
  assertBuildFail(
    buildDecisionRecordBody({ facts: summaryUnavailable, applicationId: APP_ID, scope: 'FINAL', result: 'HOLD', reason: '暂缓' }),
    'SUMMARY_MISSING',
  )
  const digestEmpty = factsOf({
    evaluation_summary: { available: true, as_of: AS_OF, summary_digest: '', warning_count: 0, source: 'EVALUATION_SUMMARIZE' },
  })
  assertBuildFail(
    buildDecisionRecordBody({ facts: digestEmpty, applicationId: APP_ID, scope: 'FINAL', result: 'HOLD', reason: '暂缓' }),
    'SUMMARY_MISSING',
  )
})

test('buildDecisionRecordBody：summary 可用 → 只有五个键（前端不传 summary_digest/basis_refs）', () => {
  const body = assertBuildOk(
    buildDecisionRecordBody({
      facts: factsOf(),
      applicationId: APP_ID,
      scope: 'FINAL',
      result: 'HOLD',
      reason: '综合面评后暂缓',
    }),
  )
  assert.deepEqual(Object.keys(body).sort(), ['application_id', 'as_of', 'decision_scope', 'reason', 'result'])
  assert.equal(body.application_id, APP_ID)
  assert.equal(body.decision_scope, 'FINAL')
  assert.equal(body.result, 'HOLD')
  assert.equal(body.as_of, AS_OF)
  assert.equal(Object.hasOwn(body, 'summary_digest'), false)
  assert.equal(Object.hasOwn(body, 'basis_refs'), false)
  assert.equal(Object.hasOwn(body, 'human_confirmation'), false)
})

test('buildDecisionRecordBody：WITHDRAW 不在 facade 封闭集 / scope 非法 / 理由空', () => {
  assertBuildFail(
    buildDecisionRecordBody({
      facts: factsOf(),
      applicationId: APP_ID,
      scope: 'STAGE',
      result: 'WITHDRAW' as 'HOLD',
      reason: '撤回',
    }),
    'ENUM_INVALID',
  )
  assertBuildFail(
    buildDecisionRecordBody({
      facts: factsOf(),
      applicationId: APP_ID,
      scope: 'SCREENING' as 'STAGE',
      result: 'HOLD',
      reason: '暂缓',
    }),
    'ENUM_INVALID',
  )
  assertBuildFail(
    buildDecisionRecordBody({ facts: factsOf(), applicationId: APP_ID, scope: 'STAGE', result: 'HOLD', reason: ' ' }),
    'MISSING_REASON',
  )
})

test('decisionRecordBlockers：summary 缺失 → SUMMARY_MISSING', () => {
  assert.deepEqual(decisionRecordBlockers(null), ['DECISION_FACTS_MISSING'])
  assert.ok(decisionRecordBlockers(factsOf({ evaluation_summary: null })).includes('SUMMARY_MISSING'))
  assert.deepEqual(decisionRecordBlockers(factsOf()), [])
})

// =====================================================================
//  7. 其余 build*（schedule / transcript / rubric / settings / job draft / job close）
// =====================================================================

test('buildInterviewScheduleBody：CREATE 正例（intent 显式、面试官 actor_id、幂等键原样）', () => {
  const body = assertBuildOk(
    buildInterviewScheduleBody({
      applicationId: APP_ID,
      roundNo: 1,
      scheduledStartAt: '2026-11-16T10:00:00+08:00',
      durationMinutes: 60,
      interviewers: [{ actorId: ACTOR_ID, requiredScorecard: true }],
      idempotencyKey: 'ui-schedule-test:1',
      timezone: 'Asia/Shanghai',
    }),
  )
  assert.equal(body.intent, 'CREATE')
  assert.equal(body.round_no, 1)
  assert.equal(body.duration_minutes, 60)
  assert.deepEqual(body.interviewers, [{ actor_id: ACTOR_ID, required_scorecard: true }])
  assert.equal(body.idempotency_key, 'ui-schedule-test:1')
  assert.equal(body.timezone, 'Asia/Shanghai')
})

test('buildInterviewScheduleBody：轮次/时长/面试官/幂等键/时间偏移的负例', () => {
  const base = {
    applicationId: APP_ID,
    roundNo: 1,
    scheduledStartAt: '2026-11-16T10:00:00+08:00',
    durationMinutes: 60,
    interviewers: [{ actorId: ACTOR_ID }],
    idempotencyKey: 'k1',
  }
  assertBuildFail(buildInterviewScheduleBody({ ...base, roundNo: 0 }), 'ROUND_OUT_OF_RANGE')
  assertBuildFail(buildInterviewScheduleBody({ ...base, roundNo: 21 }), 'ROUND_OUT_OF_RANGE')
  assertBuildFail(buildInterviewScheduleBody({ ...base, durationMinutes: 10 }), 'DURATION_OUT_OF_RANGE')
  assertBuildFail(buildInterviewScheduleBody({ ...base, interviewers: [] }), 'INTERVIEWER_REQUIRED')
  assertBuildFail(
    buildInterviewScheduleBody({ ...base, interviewers: [{ actorId: ACTOR_ID }, { actorId: ACTOR_ID }] }),
    'DUPLICATE_INTERVIEWER',
  )
  assertBuildFail(buildInterviewScheduleBody({ ...base, interviewers: [{ actorId: 'x' }] }), 'ID_NOT_UUID')
  assertBuildFail(buildInterviewScheduleBody({ ...base, scheduledStartAt: '2026-11-16T10:00:00' }), 'TIMESTAMP_WITHOUT_OFFSET')
  assertBuildFail(buildInterviewScheduleBody({ ...base, idempotencyKey: '' }), 'MISSING_IDEMPOTENCY_KEY')
  assertBuildFail(buildInterviewScheduleBody({ ...base, idempotencyKey: '非法 key' }), 'IDEMPOTENCY_KEY_INVALID')
  assertBuildFail(buildInterviewScheduleBody({ ...base, idempotencyKey: 'x'.repeat(201) }), 'IDEMPOTENCY_KEY_INVALID')
})

test('buildTranscriptImportBody：PLATFORM_EXPORT 必带导出文件名；DEMO_SAMPLE 不冒充平台导出件', () => {
  const demo = assertBuildOk(
    buildTranscriptImportBody({
      interviewId: INTERVIEW_ID,
      content: '面试官：请自我介绍。\n候选人：好的。',
      sourceKind: 'DEMO_SAMPLE',
      exportedFileName: '不应被带上.csv',
    }),
  )
  assert.equal(demo.source_kind, 'DEMO_SAMPLE')
  assert.equal(Object.hasOwn(demo, 'exported_file_name'), false)
  const platform = assertBuildOk(
    buildTranscriptImportBody({
      interviewId: INTERVIEW_ID,
      content: '平台导出的逐字稿',
      sourceKind: 'PLATFORM_EXPORT',
      exportedFileName: 'meeting-1.txt',
      language: 'zh',
      note: '人工上传',
    }),
  )
  assert.equal(platform.exported_file_name, 'meeting-1.txt')
  assert.equal(platform.language, 'zh')
  assert.equal(platform.note, '人工上传')
  assertBuildFail(
    buildTranscriptImportBody({ interviewId: INTERVIEW_ID, content: '正文', sourceKind: 'PLATFORM_EXPORT' }),
    'EXPORT_FILE_NAME_REQUIRED',
  )
  assertBuildFail(
    buildTranscriptImportBody({
      interviewId: INTERVIEW_ID,
      content: '正文',
      sourceKind: 'PLATFORM_EXPORT',
      exportedFileName: 'bad;name.txt',
    }),
    'EXPORT_FILE_NAME_INVALID',
  )
  assertBuildFail(
    buildTranscriptImportBody({ interviewId: INTERVIEW_ID, content: '   ', sourceKind: 'DEMO_SAMPLE' }),
    'MISSING_CONTENT',
  )
  assertBuildFail(
    buildTranscriptImportBody({ interviewId: INTERVIEW_ID, content: '正文', sourceKind: 'MANUAL' as 'DEMO_SAMPLE' }),
    'ENUM_INVALID',
  )
})

test('buildRubricApproveBody：job/rubric 必填 UUID，理由可选且 ≤500', () => {
  const body = assertBuildOk(buildRubricApproveBody({ jobId: JOB_ID, rubricVersionId: RUBRIC_ID }))
  assert.deepEqual(body, { job_id: JOB_ID, rubric_version_id: RUBRIC_ID })
  const withReason = assertBuildOk(
    buildRubricApproveBody({ jobId: JOB_ID, rubricVersionId: RUBRIC_ID, reason: '确认维度权重' }),
  )
  assert.equal(withReason.reason, '确认维度权重')
  assertBuildFail(buildRubricApproveBody({ jobId: '', rubricVersionId: RUBRIC_ID }), 'ID_NOT_UUID')
  assertBuildFail(buildRubricApproveBody({ jobId: JOB_ID, rubricVersionId: 'x' }), 'ID_NOT_UUID')
  assertBuildFail(
    buildRubricApproveBody({ jobId: JOB_ID, rubricVersionId: RUBRIC_ID, reason: 'x'.repeat(501) }),
    'REASON_OUT_OF_RANGE',
  )
})

test('buildSettingsWriteBody：未知实体/读 operation/缺必填/保留键', () => {
  const role = assertBuildOk(
    buildSettingsWriteBody({
      entity: 'role',
      operation: 'create',
      fields: { code: 'R1', name: '招聘专员', permission_scopes: ['APPROVE_DECISION'] },
    }),
  )
  assert.equal(role.entity, 'role')
  assert.equal(role.operation, 'create')
  assert.equal(role.code, 'R1')
  assertBuildFail(
    buildSettingsWriteBody({ entity: 'unknown' as 'role', operation: 'create', fields: {} }),
    'UNKNOWN_ENTITY',
  )
  assertBuildFail(buildSettingsWriteBody({ entity: 'role', operation: 'list', fields: {} }), 'READ_OPERATION_NOT_EXPOSED')
  assertBuildFail(buildSettingsWriteBody({ entity: 'role', operation: 'nope', fields: {} }), 'OPERATION_INVALID')
  assertBuildFail(
    buildSettingsWriteBody({ entity: 'role', operation: 'create', fields: { code: 'R1', name: 'x' } }),
    'MISSING_REQUIRED',
  )
  assertBuildFail(
    buildSettingsWriteBody({
      entity: 'role',
      operation: 'create',
      fields: { code: 'R1', name: 'x', permission_scopes: ['X'], actor_id: 'forbidden' },
    }),
    'CLIENT_RESERVED_KEY',
  )
})

test('buildJobDraftBody / buildJobCloseBody：长度与必填', () => {
  const draft = assertBuildOk(buildJobDraftBody({ requestText: '  招一名后端工程师  ' }))
  assert.equal(draft.request_text, '招一名后端工程师')
  assertBuildFail(buildJobDraftBody({ requestText: '   ' }), 'MISSING_REQUEST_TEXT')
  assertBuildFail(buildJobDraftBody({ requestText: 'x'.repeat(2001) }), 'REQUEST_TEXT_TOO_LONG')

  const close = assertBuildOk(buildJobCloseBody({ jobId: JOB_ID, reason: '停招' }))
  assert.deepEqual(close, { job_id: JOB_ID, confirm: true, reason: '停招' })
  assertBuildFail(buildJobCloseBody({ jobId: '', reason: '' }), 'JOB_ID_INVALID')
  assertBuildFail(buildJobCloseBody({ jobId: JOB_ID, reason: 'x'.repeat(501) }), 'REASON_INVALID')
})

test('buildJobCreateBody：criteria 非空、Σweight≈1、≥1 MUST_HAVE/DISQUALIFIER', () => {
  const criteria = [
    { key: 'backend_depth', label: '后端深度', kind: 'MUST_HAVE', weight: 0.6 },
    { key: 'communication', label: '沟通', kind: 'NICE_TO_HAVE', weight: 0.4 },
  ]
  const body = assertBuildOk(
    buildJobCreateBody({
      code: 'DEMO-BE-002',
      title: '后端工程师（演示）',
      departmentId: APP_ID,
      descriptionMd: '岗位描述',
      requirementsMd: '任职要求',
      criteria,
    }),
  )
  const args = body.job_create_args as Record<string, unknown>
  assert.equal(args.code, 'DEMO-BE-002')
  assert.equal(args.status, 'DRAFT')
  assert.equal((args.criteria as unknown[]).length, 2)
  assertBuildFail(
    buildJobCreateBody({
      code: 'DEMO-BE-002',
      title: '后端工程师',
      departmentId: APP_ID,
      descriptionMd: '',
      requirementsMd: '',
      criteria: [],
    }),
    'CRITERIA_REQUIRED',
  )
  assertBuildFail(
    buildJobCreateBody({
      code: 'DEMO-BE-002',
      title: '后端工程师',
      departmentId: APP_ID,
      descriptionMd: '',
      requirementsMd: '',
      criteria: [{ key: 'a', label: 'A', kind: 'MUST_HAVE', weight: 0.5 }],
    }),
    'CRITERIA_WEIGHT_SUM',
  )
  assertBuildFail(
    buildJobCreateBody({
      code: 'DEMO-BE-002',
      title: '后端工程师',
      departmentId: APP_ID,
      descriptionMd: '',
      requirementsMd: '',
      criteria: [
        { key: 'a', label: 'A', kind: 'NICE_TO_HAVE', weight: 0.5 },
        { key: 'b', label: 'B', kind: 'NICE_TO_HAVE', weight: 0.5 },
      ],
    }),
    'CRITERIA_KIND_REQUIRED',
  )
  assertBuildFail(
    buildJobCreateBody({
      code: 'bad code!',
      title: 't',
      departmentId: APP_ID,
      descriptionMd: '',
      requirementsMd: '',
      criteria: [{ key: 'a', label: 'A', kind: 'MUST_HAVE', weight: 1 }],
    }),
    'CODE_INVALID',
  )
})

test('normalizeJobDraftResponse：草案响应归一化；无 draft → null', () => {
  const draft = normalizeJobDraftResponse({
    contract_version: 'job-draft 1.0.0',
    draft: {
      job_draft: {
        recruiting_reason: '业务扩张',
        responsibilities: ['负责支付系统'],
        success_profile: [],
        must_have: ['5 年后端经验'],
        nice_to_have: [],
        rounds: [{ round_no: 1, title: '技术面', focus: ['后端深度'], questions: ['讲一个高并发案例'] }],
      },
      rubric_draft: {
        dimensions: [{ key: 'backend_depth', label: '后端深度', kind: 'MUST_HAVE', weight: 0.6, reason: '岗位核心' }],
      },
      reasons: [{ path: 'job_draft.must_have[0]', reason: '来自模板', source: 'TEMPLATE_LIBRARY' }],
      missing_items: [{ key: 'headcount', question: '招几个人？' }],
    },
    confirmation: { required: true, status: 'PENDING_HUMAN_CONFIRMATION', next: ['recruitment_job_create'], note: '人工确认' },
  })
  assert.notEqual(draft, null)
  assert.equal(draft?.recruitingReason, '业务扩张')
  assert.deepEqual(draft?.responsibilities, ['负责支付系统'])
  assert.equal(draft?.rounds[0]?.roundNo, 1)
  assert.deepEqual(draft?.rounds[0]?.questions, ['讲一个高并发案例'])
  assert.equal(draft?.rubricDimensions[0]?.weight, 0.6)
  assert.equal(draft?.reasons[0]?.source, 'TEMPLATE_LIBRARY')
  assert.equal(draft?.missingItems[0]?.key, 'headcount')
  assert.equal(draft?.confirmation.status, 'PENDING_HUMAN_CONFIRMATION')
  assert.equal(normalizeJobDraftResponse({}), null)
  assert.equal(normalizeJobDraftResponse(null), null)
})

// =====================================================================
//  8. 发送前自检（保留键 / 空 body / 非同源 / 缺 session / 动作不可用）
// =====================================================================

test('checkWriteRequest：正常通过，其余逐项拒绝且不发请求（status=0）', () => {
  const ok = checkWriteRequest('/recruitment/api/action/stage/advance', { application_id: APP_ID }, 'session-abc')
  assert.equal(ok.ok, true)

  const noSession = checkWriteRequest('/recruitment/api/action/stage/advance', { application_id: APP_ID }, '')
  assert.equal(noSession.ok, false)
  if (!noSession.ok) {
    assert.equal(noSession.reasonCode, 'SESSION_MISSING')
    assert.equal(noSession.status, 0)
  }

  const emptyBody = checkWriteRequest('/recruitment/api/action/stage/advance', {}, 'session-abc')
  assert.equal(emptyBody.ok, false)
  if (!emptyBody.ok) assert.equal(emptyBody.reasonCode, 'EMPTY_BODY')

  const unsafe = checkWriteRequest('https://evil.example/x', { application_id: APP_ID }, 'session-abc')
  assert.equal(unsafe.ok, false)
  if (!unsafe.ok) assert.equal(unsafe.reasonCode, 'UNSAFE_SEAM')

  const unsafeDoubleSlash = checkWriteRequest('//evil.example/x', { application_id: APP_ID }, 'session-abc')
  assert.equal(unsafeDoubleSlash.ok, false)
  if (!unsafeDoubleSlash.ok) assert.equal(unsafeDoubleSlash.reasonCode, 'UNSAFE_SEAM')

  for (const reserved of ACTION_RESERVED_BODY_KEYS) {
    const result = checkWriteRequest(
      '/recruitment/api/action/stage/advance',
      { application_id: APP_ID, [reserved]: 'x' },
      'session-abc',
    )
    assert.equal(result.ok, false, `保留键 ${reserved} 必须被拒绝`)
    if (!result.ok) {
      assert.equal(result.reasonCode, 'CLIENT_RESERVED_KEY')
      assert.deepEqual(result.missing, [reserved])
    }
  }
})

test('ACTION_RESERVED_BODY_KEYS：11 个身份键 + 5 个决策派生键（逐字）', () => {
  assert.deepEqual(
    [...ACTION_RESERVED_BODY_KEYS].sort(),
    [
      'actor',
      'actor_alias',
      'actor_id',
      'alias',
      'approved_by_actor_id',
      'approval_id',
      'confirmed_by_actor_id',
      'created_by_actor_id',
      'decided_at',
      'decided_by_actor_id',
      'human_confirmation',
      'stage_code',
      'status',
      'submitted_by_actor_id',
      'tenant',
      'tenant_id',
    ].sort(),
  )
})

test('checkActionRequest：服务端声明不可用 → ACTION_NOT_AVAILABLE（不发请求）', () => {
  const unavailable = checkActionRequest(
    actionView({ available: false, seam: '', pending: 'ACTION_SEAM_NOT_WIRED' }),
    { application_id: APP_ID },
    'session-abc',
  )
  assert.equal(unavailable.ok, false)
  if (!unavailable.ok) assert.equal(unavailable.reasonCode, 'ACTION_NOT_AVAILABLE')
  const available = checkActionRequest(actionView(), { application_id: APP_ID }, 'session-abc')
  assert.equal(available.ok, true)
})

// =====================================================================
//  9. 读回显示 + 时间工具 + 端点常量
// =====================================================================

test('readbackLines：键/值原样、顺序 = 服务端 JSON 键序；null 信封 → 空', () => {
  const envelope = parseActionEnvelope(
    JSON.stringify({
      action: 'stage/advance',
      readback: { application_id: APP_ID, stage_code: 'S8', record_version: 2, status: null },
    }),
  )
  const lines = readbackLines(envelope)
  assert.deepEqual(
    lines.map((line) => line.key),
    ['application_id', 'stage_code', 'record_version', 'status'],
  )
  assert.equal(lines[0]?.value, APP_ID)
  assert.equal(lines[2]?.value, '2')
  assert.equal(lines[3]?.value, 'null')
  assert.equal(lines[0]?.label, '申请 id')
  assert.equal(readbackLines(null).length, 0)
})

test('actionResultLines：标准信封用 readback；非标准信封铺 readback.row/decision/evaluation', () => {
  const outcomeEnvelope = {
    key: 'stage_advance',
    accepted: true,
    status: 200,
    envelope: parseActionEnvelope(
      JSON.stringify({ action: 'stage/advance', readback: { application_id: APP_ID, stage_code: 'S8' } }),
    ),
    error: null,
    bodyText: '',
    payload: null,
  }
  assert.deepEqual(
    actionResultLines(outcomeEnvelope).map((line) => line.key),
    ['application_id', 'stage_code'],
  )

  const outcomeFacade = {
    key: 'decision_record_facade',
    accepted: true,
    status: 200,
    envelope: null,
    error: null,
    bodyText: '',
    payload: {
      contract_version: 'decision-record 1.0.0',
      decision: { decision_id: 'd-1', decision_scope: 'FINAL', result: 'HOLD' },
      readback: { table: 'decision', row: { record_version: 1 } },
      replayed: false,
    },
  }
  const lines = actionResultLines(outcomeFacade)
  assert.ok(lines.some((line) => line.key === 'readback.row.record_version'))
  assert.ok(lines.some((line) => line.key === 'decision.decision_id'))
  assert.ok(lines.some((line) => line.key === 'replayed'))
  assert.equal(actionResultLines(undefined).length, 0)
})

test('toOffsetIso：datetime-local → 带偏移 ISO（同一瞬间），非法输入 → 空串', () => {
  const iso = toOffsetIso('2026-11-16T10:30')
  assert.match(iso, /^2026-11-16T10:30:00[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(iso), new Date(2026, 10, 16, 10, 30, 0).valueOf())
  assert.equal(toOffsetIso(''), '')
  assert.equal(toOffsetIso('2026-11-16'), '')
  assert.equal(toOffsetIso('not-a-time'), '')
  const withSeconds = toOffsetIso('2026-11-16T10:30:15')
  assert.match(withSeconds, /^2026-11-16T10:30:15[+-]\d{2}:\d{2}$/)
})

test('newIdempotencyKey：满足 [A-Za-z0-9_.:-]{1,200}', () => {
  const key = newIdempotencyKey()
  assert.match(key, /^[A-Za-z0-9_.:-]{1,200}$/)
  assert.notEqual(newIdempotencyKey(), key)
})

test('端点常量：INTERFACE2 §1 逐字', () => {
  assert.equal(DECISION_FACTS_PATH, '/recruitment/api/decision/facts')
  assert.equal(DECISION_EVALUATE_PATH, '/recruitment/api/decision/screening/evaluate')
  assert.equal(DECISION_RECORD_PATH, '/recruitment/api/decision/record')
  assert.equal(JOB_DRAFT_PATH, '/recruitment/api/job-action/job/draft')
  assert.equal(JOB_CREATE_PATH, '/recruitment/api/job-action/job/create')
  assert.equal(JOB_CLOSE_PATH, '/recruitment/api/job-action/job/close')
})
