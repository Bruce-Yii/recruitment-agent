// D5 决策 facts / basis 纯函数的单元测试（不连库）。
//
// 覆盖 W2b 消费契约里"禁止前端假造 hash/digest"的组装逻辑：
//   * rubric dimensions 投影；
//   * 内容寻址 evaluation id（确定性、不随机）；
//   * domain 输出 / 持久化 basis 分片 → facts.screening_evaluation；
//   * facts.basis 的 missing[] 门禁（缺什么进 missing，不给假 basis）；
//   * 服务端 basis_refs 组装（缺 summary digest 直接拒绝）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assembleFactsBasis,
  buildRecordBasisRefs,
  deriveEvaluationId,
  isHex64,
  mapRubricDimensions,
  mapScreeningEvaluationFromPersistedBasis,
  mapScreeningEvaluationFromToolOutput,
  projectEvaluationSummary,
  type FactsAuthority,
} from '../../src/http/decision-read.ts'

const HEX_A = 'a'.repeat(64)
const HEX_B = 'b'.repeat(64)
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const RESUME_ID = '11111111-1111-4111-8111-000000000801'
const RESUME_SHA = 'c'.repeat(64)
const ACTOR_ID = '11111111-1111-4111-8111-000000000103'

const authority: FactsAuthority = {
  actor_id: ACTOR_ID,
  alias: 'recruiter',
  display_name: '演示-HR',
  roles: ['HR'],
  is_hiring_manager: false,
}

/** 一份完整的 `recruitment_screening_evaluate` 输出（自测夹具）。 */
function toolOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool: 'recruitment_screening_evaluate',
    status: 'OK',
    advisory: true,
    read_only: true,
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    as_of: '2026-11-15T10:00:00.000Z',
    verdict: 'PASS',
    verdict_summary: '全部 MUST_HAVE 满足',
    criteria_evaluated: true,
    required_human_action: 'CONFIRM_DECISION',
    reasons: [
      { code: 'MUST_HAVE_SATISFIED', failure_class: 'HARD_PASS', criterion_key: 'work_exists', kind: 'MUST_HAVE', outcome: 'SATISFIED' },
      { code: 'DISQUALIFIER_CLEAR', failure_class: 'HARD_PASS', criterion_key: 'too_short', kind: 'DISQUALIFIER', outcome: 'CLEAR' },
    ],
    bonus_signals: [],
    warnings: [{ code: 'FIXTURE_BASIS', message: '演练数据' }],
    snapshot: {
      application_record_version: 1,
      rubric_version_id: RUBRIC_ID,
      rubric_payload_hash: HEX_A,
      resume_version_id: RESUME_ID,
      resume_content_sha256: RESUME_SHA,
    },
    evaluation_digest: HEX_B,
    ...overrides,
  }
}

test('mapRubricDimensions：合法 jsonb（数组/字符串）→ 契约维度；非法条目跳过', () => {
  const dimensions = [
    { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.6 },
    { key: 'too_short', label: '不足 60 个月即排除', kind: 'DISQUALIFIER', weight: 0.4 },
    { key: 'bonus', label: '带团队', kind: 'NICE_TO_HAVE', weight: 0 },
    { key: '', label: '空 key 跳过' },
    { label: '无 key 跳过' },
  ]
  const mapped = mapRubricDimensions(dimensions)
  assert.equal(mapped.length, 3)
  assert.deepEqual(mapped[0], { key: 'work_exists', label: '有工作经历', weight: 0.6, required: true, kind: 'MUST_HAVE' })
  assert.deepEqual(mapped[2], { key: 'bonus', label: '带团队', weight: 0, required: false, kind: 'NICE_TO_HAVE' })
  // jsonb 字符串形态（历史数据）与数组等价
  assert.deepEqual(mapRubricDimensions(JSON.stringify(dimensions)), mapped)
  // 空 / 非数组 → []（不编造维度）
  assert.deepEqual(mapRubricDimensions(null), [])
  assert.deepEqual(mapRubricDimensions({}), [])
  assert.deepEqual(mapRubricDimensions([]), [])
})

test('isHex64：只接受 64 位小写 hex', () => {
  assert.equal(isHex64(HEX_A), true)
  assert.equal(isHex64('A'.repeat(64)), false)
  assert.equal(isHex64('a'.repeat(63)), false)
  assert.equal(isHex64(null), false)
})

test('deriveEvaluationId：确定性 UUID 形态（同 digest 相同、不同 digest 不同）', () => {
  const first = deriveEvaluationId(HEX_A)
  const second = deriveEvaluationId(HEX_A)
  const other = deriveEvaluationId(HEX_B)
  assert.equal(first, second)
  assert.notEqual(first, other)
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('mapScreeningEvaluationFromToolOutput：只搬运 domain 事实，不重算/不编造', () => {
  const mapped = mapScreeningEvaluationFromToolOutput(toolOutput(), { asOf: '2026-11-15T10:00:00.000Z' })
  assert.ok(mapped !== null)
  assert.equal(mapped.evaluation_digest, HEX_B)
  assert.equal(mapped.evaluation_id, deriveEvaluationId(HEX_B))
  assert.equal(mapped.evaluation_id_kind, 'DERIVED_FROM_EVALUATION_DIGEST')
  assert.equal(mapped.verdict, 'PASS')
  assert.equal(mapped.rubric_version_id, RUBRIC_ID)
  assert.equal(mapped.rubric_payload_hash, HEX_A)
  assert.equal(mapped.resume_version_id, RESUME_ID)
  assert.equal(mapped.resume_content_sha256, RESUME_SHA)
  assert.equal(mapped.as_of, '2026-11-15T10:00:00.000Z')
  assert.equal(mapped.persisted, false)
  assert.equal(mapped.source, 'SCREENING_EVALUATE_LIVE')
  assert.equal(mapped.criteria_evaluated.length, 2)
  assert.equal(mapped.counts.reasons, 2)
  assert.equal(mapped.counts.satisfied, 1)
  // 缺 digest / snapshot → null（进 missing，不编造）
  assert.equal(mapScreeningEvaluationFromToolOutput(toolOutput({ evaluation_digest: undefined })), null)
  assert.equal(mapScreeningEvaluationFromToolOutput(toolOutput({ snapshot: undefined })), null)
  // verdict 只接受 S7 评估结论，不接受决策 result
  assert.equal(mapScreeningEvaluationFromToolOutput(toolOutput({ verdict: 'ADVANCE' })), null)
})

test('mapScreeningEvaluationFromPersistedBasis：缺必填键→null；完整→persisted=true', () => {
  const ref = {
    kind: 'SCREENING_EVALUATION',
    evaluation_digest: HEX_B,
    verdict: 'FAIL',
    rubric_version_id: RUBRIC_ID,
    rubric_payload_hash: HEX_A,
    resume_version_id: RESUME_ID,
    resume_content_sha256: RESUME_SHA,
    criteria_evaluated: true,
  }
  const mapped = mapScreeningEvaluationFromPersistedBasis(ref, {
    decision_id: '11111111-1111-4111-8111-0000000009f1',
    decided_at: '2026-11-15T09:00:00.000Z',
  })
  assert.ok(mapped !== null)
  assert.equal(mapped.persisted, true)
  assert.equal(mapped.source, 'SCREENING_DECISION_BASIS')
  assert.equal(mapped.decision_id, '11111111-1111-4111-8111-0000000009f1')
  assert.equal(mapped.as_of, '2026-11-15T09:00:00.000Z')
  assert.equal(mapped.verdict, 'FAIL')
  // 缺任一必填键 → null（不拿残留字段拼一个假事实）
  assert.equal(
    mapScreeningEvaluationFromPersistedBasis({ ...ref, rubric_payload_hash: undefined }, { decision_id: 'x' }),
    null,
  )
})

test('assembleFactsBasis：缺什么进 missing；齐全时 basis 值逐字来自事实', () => {
  const none = assembleFactsBasis({
    rubric: { id: null, payload_hash: null },
    authority: null,
    screeningEvaluation: null,
    evaluationSummary: null,
  })
  assert.equal(none.basis.screening_decide, null)
  assert.equal(none.basis.decision_record, null)
  assert.deepEqual(
    none.missing.map((entry) => entry.key).sort(),
    ['authority', 'rubric_version', 'screening_evaluation', 'summary'],
  )

  const evaluation = mapScreeningEvaluationFromToolOutput(toolOutput(), { asOf: '2026-11-15T10:00:00.000Z' })
  assert.ok(evaluation !== null)
  const summary = { as_of: '2026-11-15T10:00:00.000Z', summary_digest: HEX_B }
  const complete = assembleFactsBasis({
    rubric: { id: RUBRIC_ID, payload_hash: HEX_A },
    authority,
    screeningEvaluation: evaluation,
    evaluationSummary: summary,
  })
  assert.deepEqual(complete.missing, [])
  assert.equal(complete.basis.screening_decide?.rubric_version.payload_hash, HEX_A)
  assert.equal(complete.basis.screening_decide?.authority.actor_id, ACTOR_ID)
  assert.equal(complete.basis.screening_decide?.screening_evaluation?.evaluation_id, evaluation.evaluation_id)
  assert.equal(complete.basis.decision_record?.summary_digest, HEX_B)
  assert.equal(complete.basis.decision_record?.as_of, summary.as_of)

  // 只缺 assessment：screening_decide 仍给（HOLD/WITHDRAW 可用），但其分片为 null + missing
  const noEvaluation = assembleFactsBasis({
    rubric: { id: RUBRIC_ID, payload_hash: HEX_A },
    authority,
    screeningEvaluation: null,
    evaluationSummary: summary,
    screeningEvaluationReason: 'SCREENING_EVALUATION_UNAVAILABLE: MATERIAL_NOT_BOUND',
  })
  assert.ok(noEvaluation.basis.screening_decide !== null)
  assert.equal(noEvaluation.basis.screening_decide?.screening_evaluation, null)
  const missingEvaluation = noEvaluation.missing.find((entry) => entry.key === 'screening_evaluation')
  assert.ok(missingEvaluation !== undefined)
  assert.match(missingEvaluation.reason, /^SCREENING_EVALUATION_UNAVAILABLE:/)

  // 只缺 summary：decision_record 为 null + missing 带 SUMMARY_UNAVAILABLE 原因
  const noSummary = assembleFactsBasis({
    rubric: { id: RUBRIC_ID, payload_hash: HEX_A },
    authority,
    screeningEvaluation: evaluation,
    evaluationSummary: null,
    summaryReason: 'EVALUATION_SUMMARY_UNAVAILABLE: NOT_READY',
  })
  assert.equal(noSummary.basis.decision_record, null)
  const missingSummary = noSummary.missing.find((entry) => entry.key === 'summary')
  assert.ok(missingSummary !== undefined)
  assert.match(missingSummary.reason, /^EVALUATION_SUMMARY_UNAVAILABLE:/)
})

test('buildRecordBasisRefs：缺 summary digest 抛错；齐全时三件套值来自服务端事实', () => {
  assert.throws(
    () => buildRecordBasisRefs({
      summaryDigest: 'not-hex',
      asOf: '2026-11-15T10:00:00.000Z',
      rubric: { id: RUBRIC_ID, payload_hash: HEX_A },
      authority: { actor_id: ACTOR_ID, is_hiring_manager: false },
    }),
    /MISSING_SUMMARY/,
  )
  const refs = buildRecordBasisRefs({
    summaryDigest: HEX_B,
    asOf: '2026-11-15T10:00:00.000Z',
    rubric: { id: RUBRIC_ID, payload_hash: HEX_A },
    authority: { actor_id: ACTOR_ID, is_hiring_manager: true },
    scorecards: [{
      id: '11111111-1111-4111-8111-000000000901',
      overall: 'ADVANCE',
      transcript_basis: 'TRANSCRIPT',
      transcript_state: 'READY',
      revision_no: 1,
      interviewer_id: '11111111-1111-4111-8111-000000000104',
      payload_hash: 'd'.repeat(64),
    }],
  })
  assert.deepEqual(refs.map((ref) => ref.kind), ['SUMMARY', 'RUBRIC_VERSION', 'AUTHORITY', 'SCORECARD'])
  assert.equal(refs[0]?.summary_digest, HEX_B)
  assert.equal(refs[1]?.payload_hash, HEX_A)
  assert.equal(refs[2]?.actor_id, ACTOR_ID)
  assert.equal(refs[3]?.overall, 'ADVANCE')
})

test('projectEvaluationSummary：投影 warnings/blockers/coverage；缺 as_of/digest → null', () => {
  const raw = {
    as_of: '2026-11-15T10:00:00.000Z',
    summary_digest: HEX_B,
    decision_scope: 'FINAL',
    ready_for_decision: false,
    permitted_results: ['HOLD', 'WITHDRAW'],
    warnings: [{ code: 'PARTIAL_PANEL', message: '缺人' }],
    blockers: [{ code: 'SCORECARD_MISSING' }],
    coverage: { required_total: 2, submitted: 1, waived: 0, missing: 1 },
  }
  const projected = projectEvaluationSummary(raw)
  assert.ok(projected !== null)
  assert.equal(projected.available, true)
  assert.equal(projected.warning_count, 1)
  assert.deepEqual(projected.warnings.map((entry) => entry.code), ['PARTIAL_PANEL'])
  assert.deepEqual(projected.blockers, ['SCORECARD_MISSING'])
  assert.deepEqual(projected.permitted_results, ['HOLD', 'WITHDRAW'])
  assert.equal(projected.coverage.submitted, 1)
  assert.equal(projectEvaluationSummary({ ...raw, as_of: undefined }), null)
  assert.equal(projectEvaluationSummary({ ...raw, summary_digest: undefined }), null)
})
