// 判定算法的纯逻辑矩阵（不连库）：SR §4.2 的"有界量"、§3.3 的 absent 降级、
// §4.4 的 kind × 结果矩阵、§5 的 STEP 3/4/5 聚合。
//
// 这一层是"实现者最容易做错"的地方（TC §5.2 的 P1/P2/P3/P5 探针），
// 所以用**构造上下文**而不是真库来跑：每个用例只差一个字段值，读代码就能复核。
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateCriterion, validateDimensions, type EvalContext } from '../../src/tools/screening-evaluate.ts'

const SHA = 'a'.repeat(64)

/** 造一个"材料读完了、无 HARD issue"的上下文。 */
function makeCtx(overrides: {
  workState?: string
  eduState?: string
  entryCount?: number
  timeline?: Record<string, unknown>
  issues?: { code: string }[]
  parseStatus?: string
  hardIssueCount?: number
  ableFields?: string[]
  evidence?: unknown[]
  workExtra?: Record<string, unknown>
  eduExtra?: Record<string, unknown>
} = {}): EvalContext {
  const evidence = overrides.evidence ?? [
    { page: 1, bbox: [72, 200, 523, 224], block: 3, text: '2020.01 - 至今 某某科技 后端工程师' },
  ]
  const fields: Record<string, unknown> = {
    work_experience: {
      state: overrides.workState ?? 'present',
      provenance: 'native_text',
      reason: overrides.workState === 'unreadable' ? 'reading_order_unverified' : '',
      evidence: (overrides.workState ?? 'present') === 'present' ? evidence : [],
      ...(overrides.entryCount === undefined ? {} : { entry_count: overrides.entryCount }),
      ...(overrides.workExtra ?? {}),
    },
    education: {
      state: overrides.eduState ?? 'present',
      provenance: 'native_text',
      reason: overrides.eduState === 'unreadable' ? 'entries_not_segmentable' : '',
      evidence: (overrides.eduState ?? 'present') === 'present' ? evidence : [],
      ...(overrides.eduExtra ?? {}),
    },
  }
  return {
    client: {} as EvalContext['client'],
    cfg: {} as EvalContext['cfg'],
    app: {
      id: 'app-1', candidate_id: 'cand-1', job_id: 'job-1', job_version_id: 'jv-1',
      rubric_version_id: null, resume_version_id: 'rv-1', lifecycle_status: 'ACTIVE',
      current_stage_code: 'S7', stage_blocked_reason: null, record_version: 3,
      job_title: '后端工程师', job_status: 'OPEN', job_code: 'BE-001',
    },
    rv: {
      id: 'rv-1', version_no: 1, parse_status: overrides.parseStatus ?? 'PARSED',
      source_asset_sha256: SHA, content_sha256: 'b'.repeat(64),
      parser_name: 'pymupdf', parser_version: '1.0.0',
      parsed_fields: {}, evidence: [],
      resume_candidate_id: 'cand-1', intake_asset_id: 'ia-1', asset_validation_status: 'VALID',
      intake_record_id: 'ir-1', intake_record_status: 'RESOLVED', event_provider: 'internal',
    },
    asOfIso: '2026-11-13T00:00:00+08:00',
    warnings: [],
    parsed: {
      fields: fields as EvalContext['parsed']['fields'],
      timeline: overrides.timeline ?? {
        intervals: 1, closed_intervals: 1, open_ended_intervals: 0,
        year_only_intervals: 0, covered_months_closed: 74,
      },
      issues: overrides.issues ?? [],
      screening: { eligible_fields: overrides.ableFields ?? ['work_experience', 'education'] },
      meta: { pages: 1 },
    },
    hardIssueCount: overrides.hardIssueCount ?? 0,
    absentTrustworthy: (overrides.parseStatus ?? 'PARSED') === 'PARSED' && (overrides.hardIssueCount ?? 0) === 0,
  }
}

const MUST_WORK = { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE' as const, weight: 0.5, field: 'work_experience', operator: 'EXISTS' as const, value: true }
const MUST_MONTHS_GTE60 = { key: 'years', label: '后端 5 年', kind: 'MUST_HAVE' as const, weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE' as const, value: 60 }
const DISQ_MONTHS_LTE60 = { key: 'too_short', label: '不足 5 年即排除', kind: 'DISQUALIFIER' as const, weight: 0.5, field: 'timeline.covered_months_closed', operator: 'LTE' as const, value: 60 }
const MUST_ENTRY_GTE3 = { key: 'entries', label: '≥3 段经历', kind: 'MUST_HAVE' as const, weight: 0.5, field: 'work_experience.entry_count', operator: 'GTE' as const, value: 3 }
const BONUS_LEAD = { key: 'team_lead', label: '带团队', kind: 'NICE_TO_HAVE' as const, weight: 0.5, question: '是否有 ≥1 年、≥3 人的直接带团队经历？' }

test('P1：有"至今"区间但闭区间已覆盖 74 个月 → GTE 60 判 SATISFIED（下界够就是够）', () => {
  const ctx = makeCtx({ timeline: { open_ended_intervals: 1, year_only_intervals: 0, covered_months_closed: 74 } })
  const result = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(result.outcome, 'SATISFIED')
  assert.equal(result.reason.bounds, 'LOWER_BOUND')
  assert.equal(result.reason.code, 'MUST_HAVE_SATISFIED')
  assert.equal(result.reason.observed?.lower_bound, 74)
})

test('P2：同样有"至今"但闭区间只有 41 个月 → INDETERMINATE（不得判 UNSATISFIED）', () => {
  const ctx = makeCtx({ timeline: { open_ended_intervals: 1, year_only_intervals: 0, covered_months_closed: 41 } })
  const result = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(result.outcome, 'INDETERMINATE')
  assert.equal(result.reason.code, 'MUST_HAVE_INDETERMINATE')
  assert.equal(result.reason.bounds, 'LOWER_BOUND')
  assert.equal(result.uncertain, true)
})

test('P2b：EXACT 且 41 个月 → UNSATISFIED（无开放区间时反证成立）', () => {
  const ctx = makeCtx({ timeline: { open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 41 } })
  const result = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(result.outcome, 'UNSATISFIED')
  assert.equal(result.reason.bounds, 'EXACT')
})

test('P2c：DISQUALIFIER 的 LTE —— 下界已超上限 → CLEAR（反证不命中）；下界不够 → INDETERMINATE', () => {
  const exceeded = makeCtx({ timeline: { open_ended_intervals: 1, year_only_intervals: 0, covered_months_closed: 90 } })
  // ≤60 已被 90 反证 ⇒ UNSATISFIED ⇒ DISQUALIFIER 映射为 CLEAR
  assert.equal(evaluateCriterion(exceeded, DISQ_MONTHS_LTE60, 0).outcome, 'CLEAR')
  const unknown = makeCtx({ timeline: { open_ended_intervals: 1, year_only_intervals: 0, covered_months_closed: 30 } })
  assert.equal(evaluateCriterion(unknown, DISQ_MONTHS_LTE60, 0).outcome, 'INDETERMINATE')
  const triggered = makeCtx({ timeline: { open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 30 } })
  assert.equal(evaluateCriterion(triggered, DISQ_MONTHS_LTE60, 0).outcome, 'TRIGGERED')
})

test('P3：MUST_HAVE 只有 absent → MISSING（不是 FAIL），并带 absence 对象', () => {
  const ctx = makeCtx({ workState: 'present', eduState: 'absent' })
  const result = evaluateCriterion(ctx, { ...MUST_WORK, field: 'education' }, 0)
  assert.equal(result.outcome, 'MISSING')
  assert.equal(result.uncertain, true)
  assert.equal(result.reason.tri_state, 'absent')
  assert.ok(result.reason.absence)
  assert.equal(result.reason.absence?.hard_issue_count, 0)
  assert.deepEqual(result.reason.evidence, [])
})

test('P3b：unreadable 绝不当 absent → UNREADABLE + issue_codes 非空', () => {
  const ctx = makeCtx({ eduState: 'unreadable' })
  const result = evaluateCriterion(ctx, { ...MUST_WORK, field: 'education' }, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.equal(result.reason.tri_state, 'unreadable')
  assert.ok((result.reason.issue_codes ?? []).length >= 1)
})

test('P5：NICE_TO_HAVE 判断型 → NEEDS_JUDGMENT，uncertain=false（不阻塞 PASS）', () => {
  const ctx = makeCtx()
  const result = evaluateCriterion(ctx, BONUS_LEAD, 0)
  assert.equal(result.outcome, 'NEEDS_JUDGMENT')
  assert.equal(result.uncertain, false)
  assert.equal(result.reason.code, 'BONUS_NEEDS_JUDGMENT')
  assert.equal(result.reason.failure_class, 'JUDGMENT')
  assert.equal(result.reason.tri_state, undefined)
  assert.equal(result.reason.question, BONUS_LEAD.question)
})

test('SR §3.3：PARTIAL + HARD issue 时上游给的 absent 降级为 unreadable + ABSENT_DOWNGRADED', () => {
  const ctx = makeCtx({ eduState: 'absent', parseStatus: 'PARTIAL', hardIssueCount: 1 })
  const result = evaluateCriterion(ctx, { ...MUST_WORK, field: 'education' }, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.equal(result.reason.tri_state, 'unreadable')
  assert.ok(ctx.warnings.some((w) => w.code === 'ABSENT_DOWNGRADED'))
})

test('SR §3.2：字段在 parsed_fields 里没有三态 → UNREADABLE + FIELD_STATE_UNDECLARED（不推定 absent）', () => {
  const ctx = makeCtx()
  delete (ctx.parsed.fields as Record<string, unknown>).education
  const result = evaluateCriterion(ctx, { ...MUST_WORK, field: 'education' }, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.ok(ctx.warnings.some((w) => w.code === 'FIELD_STATE_UNDECLARED'))
})

test('SR §3.2 第 3 条：eligible_fields 与 state 不一致 → SCREENING_INDEX_INCONSISTENT，以 state 为准', () => {
  const ctx = makeCtx({ ableFields: [] })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'SATISFIED')
  assert.ok(ctx.warnings.some((w) => w.code === 'SCREENING_INDEX_INCONSISTENT'))
})

test('SR §8.2：present 但 evidence 为空 → 降为 UNREADABLE（证据缺失等于没读出）', () => {
  const ctx = makeCtx({ evidence: [] })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.deepEqual(result.reason.issue_codes, ['evidence_missing'])
})

test('SR §8.2：evidence 的 source_asset_sha256 不一致 → 该证据作废 + EVIDENCE_SHA_MISMATCH', () => {
  const ctx = makeCtx({
    evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 1, text: 'x', source_asset_sha256: 'c'.repeat(64) }],
  })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.ok(ctx.warnings.some((w) => w.code === 'EVIDENCE_SHA_MISMATCH'))
})

test('机械型 GTE 在 entry_count 上：1 ≥ 3 不成立 → UNSATISFIED；缺分量 → INDETERMINATE', () => {
  const one = makeCtx({ entryCount: 1 })
  assert.equal(evaluateCriterion(one, MUST_ENTRY_GTE3, 0).outcome, 'UNSATISFIED')
  const missing = makeCtx()
  assert.equal(evaluateCriterion(missing, MUST_ENTRY_GTE3, 0).outcome, 'INDETERMINATE')
})

test('timeline 在 work_experience 未 present 时 → UNAVAILABLE → UNREADABLE', () => {
  const ctx = makeCtx({ workState: 'unreadable' })
  const result = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.equal(result.reason.bounds, 'UNAVAILABLE')
})

// ---------------------------------------------------------------------------
//  Issue #1 §1.4 / 用例 J：同一有效版本
//  agent 把 work_experience 从 unreadable 升级成 present 后，converter 的 timeline
//  是在旧字段上算的，不得继续用来比较——否则旧值 0 会让 GTE 60 变成 UNSATISFIED
//  （虚假 FAIL），或让 DISQUALIFIER LTE 60 变成 TRIGGERED（同样虚假 FAIL）。
// ---------------------------------------------------------------------------

test('J：work_experience 被 agent 升级后，旧 converter timeline 不得产生虚假 FAIL', () => {
  const ctx = makeCtx({
    workState: 'present',
    workExtra: { state_source: 'agent_structured', converter_state: 'unreadable', block_ids: [11, 12], entry_count: 2 },
    timeline: { open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0 },
  })
  const gte = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(gte.outcome, 'UNREADABLE', '旧 timeline 的 0 个月不能判 UNSATISFIED')
  assert.equal(gte.reason.bounds, 'UNAVAILABLE')
  assert.equal(gte.reason.tri_state, 'present', '有效字段本身是 present，只是量未确认')
  assert.ok(gte.reason.issue_codes.includes('timeline_unconfirmed:work_experience_upgraded_by_agent'))
  assert.ok(gte.reason.issue_codes.includes('converter_timeline_ignored:covered_months_closed=0'))
  assert.match(gte.reason.message, /未确认/)

  const lte = evaluateCriterion(ctx, DISQ_MONTHS_LTE60, 0)
  assert.equal(lte.outcome, 'UNREADABLE', '旧 timeline 的 0 个月不能判 DISQUALIFIER TRIGGERED')
  assert.notEqual(lte.outcome, 'TRIGGERED')
})

test('J：三态没变（agent 也看到 present）时，converter timeline 仍是同一版本的事实', () => {
  const ctx = makeCtx({
    workState: 'present',
    workExtra: { state_source: 'agent_structured', converter_state: 'present', block_ids: [3] },
    timeline: { open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 74 },
  })
  const result = evaluateCriterion(ctx, MUST_MONTHS_GTE60, 0)
  assert.equal(result.outcome, 'SATISFIED')
  assert.equal(result.reason.bounds, 'EXACT')
  assert.deepEqual(result.reason.issue_codes, [])
})

test('J：升级后 present 但证据缺 page/bbox → 不静默降级，issue_codes 写明 block_ids 与缺坐标计数', () => {
  const ctx = makeCtx({
    workExtra: {
      state_source: 'agent_structured',
      converter_state: 'unreadable',
      block_ids: [24, 25, 30],
      evidence: [],
      evidence_unlocatable: true,
      agent_evidence: [
        { block_id: 24, block_no: 24, page: 1, bbox: null, quote: '教育背景' },
        { block_id: 25, block_no: 25, page: 1, bbox: [1, 2, 3, 4], quote: '某大学' },
      ],
    },
  })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.ok(result.reason.issue_codes.includes('evidence_unlocatable'))
  assert.ok(result.reason.issue_codes.includes('agent_evidence_total:2'))
  assert.ok(result.reason.issue_codes.includes('agent_evidence_with_page_and_bbox:1'))
  assert.ok(result.reason.issue_codes.includes('field_block_ids:24,25,30'))
  assert.match(result.reason.message, /没有可定位的证据/)
})

test('J：证据的 block_id 不在字段 block_ids 里 → 该证据作废并写明原因', () => {
  const ctx = makeCtx({
    workExtra: {
      state_source: 'agent_structured',
      converter_state: 'unreadable',
      block_ids: [24],
      evidence: [{
        page: 1, bbox: [1, 2, 3, 4], block: 99, block_id: 30,
        text: '引用了别的块', source: 'agent_structured', source_asset_sha256: SHA,
      }],
    },
  })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'UNREADABLE')
  assert.ok(result.reason.issue_codes.includes('evidence_block_id_not_in_field_block_ids:30'))
})

test('J：升级字段的索引不一致只产生说明性 warning，不改变按有效字段得出的结论', () => {
  const ctx = makeCtx({
    ableFields: [],
    workExtra: { state_source: 'agent_structured', converter_state: 'unreadable', block_ids: [11] },
  })
  const result = evaluateCriterion(ctx, MUST_WORK, 0)
  assert.equal(result.outcome, 'SATISFIED')
  const warning = ctx.warnings.find((w) => w.code === 'SCREENING_INDEX_INCONSISTENT')
  assert.ok(warning)
  assert.match(warning.message, /忽略旧索引/)
})

test('R-VAL-1..13：合法 rubric 零违反；各种坏 rubric 各自命中对应 reason_code', () => {
  const good = [
    { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
  ]
  assert.deepEqual(validateDimensions(good), [])

  const cases: { dims: unknown[]; reason: string; rule: string }[] = [
    { dims: [], reason: 'DIMENSIONS_SHAPE', rule: 'R-VAL-1' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MAYBE', weight: 1 }], reason: 'CRITERION_KIND', rule: 'R-VAL-5' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 0.9, question: 'q' }], reason: 'WEIGHT_SUM', rule: 'R-VAL-6' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, field: 'work_experience' }], reason: 'CRITERION_PARTIAL', rule: 'R-VAL-7' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, field: 'skills.k8s', operator: 'EXISTS', value: true }], reason: 'CRITERION_FIELD', rule: 'R-VAL-8' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, field: 'phone', operator: 'EXISTS', value: true }], reason: 'PROTECTED_ATTRIBUTE_IN_CRITERIA', rule: 'R-VAL-8' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: false }], reason: 'CRITERION_VALUE', rule: 'R-VAL-11' },
    { dims: [{ key: 'k1', label: 'l', kind: 'NICE_TO_HAVE', weight: 1, question: 'q' }], reason: 'NO_DECIDING_CRITERIA', rule: 'R-VAL-13' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'GTE', value: 1 }], reason: 'CRITERION_TYPE', rule: 'R-VAL-10' },
    { dims: [{ key: 'k1', label: 'l', kind: 'MUST_HAVE', weight: 1, extra: 1, question: 'q' }], reason: 'CRITERION_UNKNOWN_KEY', rule: 'R-VAL-2' },
  ]
  for (const item of cases) {
    const violations = validateDimensions(item.dims)
    assert.ok(
      violations.some((v) => v.reason_code === item.reason),
      `期望命中 ${item.reason}，实际 ${JSON.stringify(violations)}`,
    )
  }
})

test('validateDimensions：只禁 protected/身份字段，不禁白名单内字段', () => {
  assert.deepEqual(validateDimensions([
    { key: 'm1', label: '月数', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 },
    { key: 'q1', label: '问句', kind: 'NICE_TO_HAVE', weight: 0.5, question: '是否有带团队经验？' },
  ]), [])
})

// ---------------------------------------------------------------------------
//  2026-11-14 P0 回归：判断型准则的 `field` 形状
//
//  缺陷现场：`recruitment_job_create` 把判断型准则归一化成 `"field": null`，
//  而 `evaluateCriterion` 只认 `field === undefined` → `null` 掉进
//  `resolveFieldFact(ctx, null)` → `TypeError: Cannot read properties of null (reading 'startsWith')`。
//  下面三条钉住**读侧的两种合法历史形状**（键缺失 / 键值为 null）与"null 不得漏进输出"。
// ---------------------------------------------------------------------------

/** 历史形状：2026-11-14 之前 `job_create` 写出的判断型准则（field/operator/value 都是 null）。 */
const JUDGMENT_LEGACY = {
  key: 'degree', label: '本科及以上', kind: 'MUST_HAVE' as const, weight: 0.5,
  field: null, operator: null, value: null,
  question: '候选人是否具备本科及以上学历？', notes: null,
}

test('P0 回归：判断型准则 field=null（历史 job_create 形状）→ NEEDS_JUDGMENT，不进 resolveFieldFact', () => {
  const ctx = makeCtx()
  const result = evaluateCriterion(ctx, JUDGMENT_LEGACY, 0)
  assert.equal(result.outcome, 'NEEDS_JUDGMENT')
  assert.equal(result.reason.code, 'MUST_HAVE_NEEDS_JUDGMENT')
  assert.equal(result.reason.failure_class, 'JUDGMENT')
  assert.equal(result.uncertain, true)
  assert.equal(result.reason.question, JUDGMENT_LEGACY.question)
  // 判断型没有机械三态/字段/期望：一个都不能用 null 占位（输出 schema 不收 null）
  for (const key of ['field', 'tri_state', 'bounds', 'expected', 'notes']) {
    assert.equal(Object.hasOwn(result.reason, key), false, `判断型的 reason 不允许有 ${key} 键`)
  }
  assert.deepEqual(result.reason.issue_codes, [])
  assert.deepEqual(result.reason.evidence, [])
})

test('P0 回归：field 缺失（契约形状/手工 SQL 夹具）与 field=null 得到完全相同的判定与 reason', () => {
  const ctx = makeCtx()
  const { field: _field, operator: _operator, value: _value, notes: _notes, ...noFieldKeys } = JUDGMENT_LEGACY
  const fromNull = evaluateCriterion(ctx, JUDGMENT_LEGACY, 2)
  const fromMissing = evaluateCriterion(ctx, noFieldKeys, 2)
  assert.deepEqual(fromNull, fromMissing)
})

test('P0 回归：机械型准则的历史 null 占位（question:null / notes:null）不得漏进输出', () => {
  const legacyMechanical = {
    key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE' as const, weight: 1,
    field: 'work_experience', operator: 'EXISTS' as const, value: true,
    question: null, notes: null,
  }
  const result = evaluateCriterion(makeCtx(), legacyMechanical, 0)
  assert.equal(result.outcome, 'SATISFIED')
  assert.equal(result.reason.code, 'MUST_HAVE_SATISFIED')
  assert.equal(Object.hasOwn(result.reason, 'question'), false)
  assert.equal(Object.hasOwn(result.reason, 'notes'), false)
  assert.deepEqual(result.reason.expected, { operator: 'EXISTS', value_boolean: true })
})

test('P0 回归：极端形状（field=null 且 question=null）也不崩，question 省略而不是写 null', () => {
  const result = evaluateCriterion(makeCtx(), {
    key: 'weird', label: '怪形状', kind: 'NICE_TO_HAVE', weight: 0, field: null, question: null,
  }, 0)
  assert.equal(result.outcome, 'NEEDS_JUDGMENT')
  assert.equal(result.uncertain, false)
  assert.equal(Object.hasOwn(result.reason, 'field'), false)
  assert.equal(Object.hasOwn(result.reason, 'question'), false)
  assert.equal(Object.hasOwn(result.reason, 'expected'), false)
})
