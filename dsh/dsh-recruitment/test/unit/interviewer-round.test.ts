// 轮次级评分标准（task-50 `round_focus` / `effective_rubric`）客户端纯函数测试（node --test，无 DOM / 无 React）。
//
// 覆盖口径（`work/d5/w3b/W3B-CONTRACT.md` §6 的九条）：
//   1. §1.1/§1.2 完整 JSON → 投影逐字段正确（source/title/description/focusDimensions/questions/
//      scorecardFields/dimensions/scale/submission/reason）；
//   2. `round_focus.available=false`（JOB_BASE 样例）→ focus 不 available、重点/问题为空、
//      rubric dims 全部 origin=JOB_BASE、reason 原样；
//   3. **两键都缺**（旧端点 payload）→ `serverFieldsMissing=true`、source='JOB_BASE'、
//      维度来自 row.rubric、不出现任何 title/description/questions；
//   4. 缺 rubric 且无轮次配置 → 空维度 + NONE 空态，不抛错；
//   5. round_no 不一致 / declared rubric 冲突 → conflict=true + 提示，维度宇宙不变；
//   6. `roundSourceText` 全分支（含未知 source 原样、旧端点 task-50 文案）；
//   7. 表单派生四条规则（spec==submission keys → usable 且顺序按 effective；effective 子集 →
//      usable 且 spec 全保留；submission keys ≠ spec / effective 含 spec 外 key → mismatch fail-closed）；
//   8. `normalizeInterviewerOverview` 旧 payload 不回归（既有字段不变，新字段默认降级）；
//   9. 列表右栏轮次分组（`groupRoundProjects` 轮次投影 + 既有 `groupRounds` 旧 brief 口径）。
//
// 夹具是契约 §1 的 mock JSON（不依赖 task-50 端点是否落地、不读 work/ 下的真抓包）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  groupRounds,
  normalizeInterviewerOverview,
  normalizeInterviewRow,
  normalizeScorecardFormSpec,
} from '../../src/client/interviewer/normalize.ts'
import {
  ROUND_SCHEMA_MISMATCH_TEXT,
  ROUND_SERVER_FIELDS_MISSING_TEXT,
  deriveScorecardFields,
  groupRoundProjects,
  normalizeEffectiveRubric,
  normalizeRoundEffective,
  normalizeRoundFocus,
  roundFocusDegradedText,
  roundSourceText,
  type RoundEffectiveView,
} from '../../src/client/interviewer/round.ts'

// ---------------------------------------------------------------------------
//  夹具（W3B-CONTRACT §1 的 mock JSON；uuid/hex 用固定假值，不含任何真实数据）
// ---------------------------------------------------------------------------

const INT_2 = '11111111-1111-4111-8111-000000000802'
const APP_2 = '11111111-1111-4111-8111-000000000702'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const TEMPLATE_ID = '11111111-1111-4111-8111-000000000f02'
const DECLARED_OTHER = '11111111-1111-4111-8111-000000000499'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const HASH = 'a'.repeat(64)

/** 断言整棵结构里没有 undefined / NaN / Infinity（"坏字段降级"的机检口径）。 */
function assertClean(value: unknown, path = 'root'): void {
  if (value === undefined) throw new Error(`${path} 不得是 undefined`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} 必须是有限数字（实际 ${String(value)}）`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertClean(item, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertClean(item, `${path}.${key}`)
  }
}

/** 一条面试行（旧字段形状；round_focus/effective_rubric 由各用例决定是否挂上）。 */
function rowFixture(roundNo = 2): Record<string, unknown> {
  return {
    interview_id: INT_2,
    application_id: APP_2,
    candidate: { candidate_id: '11111111-1111-4111-8111-000000000602', display_name: '演示候选人-张样例' },
    job: { job_id: JOB_ID, code: 'DEMO-BE-001', title: '后端工程师（演示）' },
    round_no: roundNo,
    slot_code: 'DEFAULT',
    status: 'SCHEDULED',
    stage_code: 'S8',
    scheduled_start_at: '2026-11-20T14:00:00.000Z',
    scheduled_end_at: '2026-11-20T15:00:00.000Z',
    timezone: 'Asia/Shanghai',
    record_version: 1,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: true,
    scorecard_due_at: null,
    brief: {
      available: true,
      source: 'TEMPLATE',
      objective: '第 2 轮：跨团队协作与取舍',
      briefing: '验证真实冲突下的取舍依据，避免重复第 1 轮技术题。',
      focus: [{ key: 'frontend_basics', label: '基本前端能力', weight: 0.2 }],
      questions: ['和合作方目标冲突时，你依据什么做取舍？'],
      template_version_id: TEMPLATE_ID,
      template_payload_hash: HASH,
      reason: null,
    },
    rubric: {
      rubric_version_id: RUBRIC_ID,
      job_id: JOB_ID,
      payload_hash: HASH,
      dimensions: [
        { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5, question: null },
        { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3, question: null },
        { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2, question: null },
      ],
    },
    materials: { authorization: 'INTERVIEW_ASSIGNMENT', available: false, reason: 'NO_MATERIAL_BOUND', resume: null },
    transcript: {
      state: 'MISSING',
      reason_code: 'NO_MEETING_BOUND',
      no_transcript: true,
      meeting_binding_state: 'UNBOUND',
      meetings_total: 0,
    },
    scorecard: {
      state: 'NONE',
      scorecard_id: null,
      status: null,
      revision_no: null,
      record_version: null,
      submitted_at: null,
      transcript_basis: null,
      overall: null,
    },
    required_action: 'SUBMIT_SCORECARD',
  }
}

/** §1.1 完整 `round_focus`（ROUND_CONFIG；2 个重点维度 + 2 个问题 + 1 个评分表字段）。 */
function roundFocusFixture(): Record<string, unknown> {
  return {
    available: true,
    source: 'ROUND_CONFIG',
    round_no: 2,
    template_version_id: TEMPLATE_ID,
    template_version_no: 1,
    template_payload_hash: HASH,
    title: '第 2 轮：跨团队协作与取舍',
    description: '验证真实冲突下的取舍依据，避免重复第 1 轮技术题。',
    focus_dimensions: [
      { key: 'frontend_basics', label: '基本前端能力', weight: 0.2, required: true, in_rubric: true },
      { key: 'conflict_tradeoff', label: '冲突取舍', weight: 0.1, required: false, in_rubric: false },
    ],
    questions: [
      { key: null, text: '讲一次你推翻自己技术方案的经历：依据是什么？' },
      { key: 'conflict_tradeoff', text: '和合作方目标冲突时，你依据什么做取舍？事后怎么复盘？' },
    ],
    scorecard_fields: [{ key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true }],
    reason: null,
  }
}

/** §1.2 完整 `effective_rubric`（ROUND_OVERRIDE；3 个维度，frontend_basics = focus/must_cover）。 */
function effectiveRubricFixture(): Record<string, unknown> {
  return {
    available: true,
    source: 'ROUND_OVERRIDE',
    round_no: 2,
    job_id: JOB_ID,
    rubric_version_id: RUBRIC_ID,
    rubric_version_no: 1,
    rubric_payload_hash: HASH,
    base_rubric_version_id: RUBRIC_ID,
    template_version_id: TEMPLATE_ID,
    template_version_no: 1,
    template_payload_hash: HASH,
    declared_round_rubric_version_id: RUBRIC_ID,
    dimensions: [
      {
        key: 'backend_depth',
        label: '后端工程深度',
        kind: 'MUST_HAVE',
        weight: 0.5,
        required: true,
        focus: false,
        must_cover: false,
        origin: 'JOB_BASE',
        question: null,
      },
      {
        key: 'async_pipeline',
        label: '异步/队列流水线经验',
        kind: 'MUST_HAVE',
        weight: 0.3,
        required: true,
        focus: false,
        must_cover: false,
        origin: 'JOB_BASE',
        question: null,
      },
      {
        key: 'frontend_basics',
        label: '基本前端能力',
        kind: 'NICE_TO_HAVE',
        weight: 0.2,
        required: true,
        focus: true,
        must_cover: true,
        origin: 'ROUND_OVERRIDE',
        question: null,
      },
    ],
    scorecard: {
      scale: { min: 2, max: 10 },
      fields: [
        { key: 'backend_depth', label: '后端工程深度', kind: 'DIMENSION', required: true },
        { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'DIMENSION', required: true },
        { key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true },
      ],
    },
    submission: {
      rubric_version_id: RUBRIC_ID,
      dimension_keys: ['backend_depth', 'async_pipeline', 'frontend_basics'],
    },
    reason: null,
  }
}

/** JOB_BASE 降级 `round_focus`（available=false；服务端 reason 原样）。 */
function jobBaseFocusFixture(roundNo = 3): Record<string, unknown> {
  return {
    available: false,
    source: 'JOB_BASE',
    round_no: roundNo,
    template_version_id: null,
    template_version_no: null,
    template_payload_hash: null,
    title: null,
    description: null,
    focus_dimensions: [],
    questions: [],
    scorecard_fields: [],
    reason: '本场面试没有绑定可用的轮次模板，无法声称本轮重点；已如实降级到岗位 Rubric 底座（JOB_BASE）',
  }
}

/** JOB_BASE 降级 `effective_rubric`（dims 全部 origin=JOB_BASE；scale=null → 0/0）。 */
function jobBaseRubricFixture(roundNo = 3): Record<string, unknown> {
  return {
    available: true,
    source: 'JOB_BASE',
    round_no: roundNo,
    job_id: JOB_ID,
    rubric_version_id: RUBRIC_ID,
    rubric_version_no: 1,
    rubric_payload_hash: HASH,
    base_rubric_version_id: RUBRIC_ID,
    template_version_id: null,
    template_version_no: null,
    template_payload_hash: null,
    declared_round_rubric_version_id: null,
    dimensions: [
      {
        key: 'backend_depth',
        label: '后端工程深度',
        kind: 'MUST_HAVE',
        weight: 0.5,
        required: true,
        focus: false,
        must_cover: false,
        origin: 'JOB_BASE',
        question: null,
      },
      {
        key: 'async_pipeline',
        label: '异步/队列流水线经验',
        kind: 'MUST_HAVE',
        weight: 0.3,
        required: true,
        focus: false,
        must_cover: false,
        origin: 'JOB_BASE',
        question: null,
      },
      {
        key: 'frontend_basics',
        label: '基本前端能力',
        kind: 'NICE_TO_HAVE',
        weight: 0.2,
        required: true,
        focus: false,
        must_cover: false,
        origin: 'JOB_BASE',
        question: null,
      },
    ],
    scorecard: {
      scale: null,
      fields: [{ key: 'backend_depth', label: '后端工程深度', kind: 'DIMENSION', required: true }],
    },
    submission: {
      rubric_version_id: RUBRIC_ID,
      dimension_keys: ['backend_depth', 'async_pipeline', 'frontend_basics'],
    },
    reason: null,
  }
}

/** 新端点完整行（round_focus + effective_rubric 都在）。 */
function fullRow(): Record<string, unknown> {
  return { ...rowFixture(2), round_focus: roundFocusFixture(), effective_rubric: effectiveRubricFixture() }
}

/** 旧端点行（两键都缺；只有旧 brief/rubric）。 */
function legacyRow(): Record<string, unknown> {
  return rowFixture(1)
}

/** W1 form spec 夹具（3 个维度；控件枚举/分数区间/note 必填都来自服务端）。 */
function formSpecFixture(): ReturnType<typeof normalizeScorecardFormSpec> {
  const dimension = (key: string, label: string, kind: string, weight: number) => ({
    key,
    label,
    kind,
    weight,
    controls: {
      assessment: ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'],
      score: { min: 1, max: 5 },
      note_required: false,
    },
  })
  return normalizeScorecardFormSpec({
    contract_version: 'scorecard-form 1.0.0',
    actor: { actor_id: ACTOR_B, display_name: '演示-面试官 B' },
    interview: { id: INT_2, application_id: APP_2, round_no: 2, slot_code: 'DEFAULT', status: 'SCHEDULED', scheduled_start_at: null },
    rubric: { id: RUBRIC_ID, job_id: JOB_ID, payload_hash: HASH, dimensions: [] },
    dimensions: [
      dimension('backend_depth', '后端工程深度', 'MUST_HAVE', 0.5),
      dimension('async_pipeline', '异步/队列流水线经验', 'MUST_HAVE', 0.3),
      dimension('frontend_basics', '基本前端能力', 'NICE_TO_HAVE', 0.2),
    ],
    transcript_basis: { value: 'NO_TRANSCRIPT', options: ['NO_TRANSCRIPT'], locked: true },
    overall_options: ['ADVANCE', 'HOLD', 'REJECT'],
    mode: 'CREATE',
    current: null,
    nonce: 'nonce-from-server',
    expires_at: '2026-11-15T06:02:00.000Z',
    actor_alias: 'interviewer_b',
  })
}

/** 基于完整投影派生一个改过的投影（只用于表单派生的 mismatch 用例，避免构造整份 raw JSON）。 */
function roundVariant(
  round: RoundEffectiveView,
  override: {
    readonly dimensions?: RoundEffectiveView['rubric']['dimensions']
    readonly submissionKeys?: readonly string[]
    readonly serverFieldsMissing?: boolean
  },
): RoundEffectiveView {
  return {
    ...round,
    serverFieldsMissing: override.serverFieldsMissing ?? round.serverFieldsMissing,
    rubric: {
      ...round.rubric,
      dimensions: override.dimensions ?? round.rubric.dimensions,
      submissionDimensionKeys: override.submissionKeys ?? round.rubric.submissionDimensionKeys,
    },
  }
}

// ===========================================================================
//  1. §1.1/§1.2 完整 JSON → 投影逐字段正确
// ===========================================================================

test('完整 ROUND_CONFIG：round_focus/effective_rubric 逐字段投影（source/title/dims/questions/scorecard/submission）', () => {
  const view = normalizeRoundEffective(fullRow(), { roundNo: 2 })

  assert.equal(view.serverFieldsMissing, false)
  assert.equal(view.conflict, false)
  assert.equal(view.conflictReason, '')

  // round_focus
  assert.equal(view.focus.available, true)
  assert.equal(view.focus.source, 'ROUND_CONFIG')
  assert.equal(view.focus.round_no, 2)
  assert.equal(view.focus.title, '第 2 轮：跨团队协作与取舍')
  assert.equal(view.focus.description, '验证真实冲突下的取舍依据，避免重复第 1 轮技术题。')
  assert.equal(view.focus.reason, '')
  assert.equal(view.focus.templateVersionId, TEMPLATE_ID)
  assert.equal(view.focus.templateVersionNo, 1)
  assert.equal(view.focus.templatePayloadHash, HASH)
  assert.deepEqual(
    view.focus.focusDimensions.map((item) => [item.key, item.label, item.weight, item.required, item.inRubric]),
    [
      ['frontend_basics', '基本前端能力', 0.2, true, true],
      ['conflict_tradeoff', '冲突取舍', 0.1, false, false],
    ],
  )
  assert.equal(view.focus.questions.length, 2)
  assert.deepEqual(view.focus.questions[0], { key: '', text: '讲一次你推翻自己技术方案的经历：依据是什么？' })
  assert.deepEqual(view.focus.questions[1], {
    key: 'conflict_tradeoff',
    text: '和合作方目标冲突时，你依据什么做取舍？事后怎么复盘？',
  })
  assert.deepEqual(view.focus.scorecardFields, [
    { key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true },
  ])

  // effective_rubric
  assert.equal(view.rubric.available, true)
  assert.equal(view.rubric.source, 'ROUND_OVERRIDE')
  assert.equal(view.rubric.round_no, 2)
  assert.equal(view.rubric.jobId, JOB_ID)
  assert.equal(view.rubric.rubricVersionId, RUBRIC_ID)
  assert.equal(view.rubric.rubricVersionNo, 1)
  assert.equal(view.rubric.rubricPayloadHash, HASH)
  assert.equal(view.rubric.baseRubricVersionId, RUBRIC_ID)
  assert.equal(view.rubric.templateVersionId, TEMPLATE_ID)
  assert.equal(view.rubric.declaredRoundRubricVersionId, RUBRIC_ID)
  assert.deepEqual(
    view.rubric.dimensions.map((item) => [item.key, item.origin, item.required, item.focus, item.mustCover]),
    [
      ['backend_depth', 'JOB_BASE', true, false, false],
      ['async_pipeline', 'JOB_BASE', true, false, false],
      ['frontend_basics', 'ROUND_OVERRIDE', true, true, true],
    ],
  )
  assert.equal(view.rubric.scaleMin, 2)
  assert.equal(view.rubric.scaleMax, 10)
  assert.deepEqual(view.rubric.scorecardFields.map((field) => field.key), [
    'backend_depth',
    'async_pipeline',
    'frontend_basics',
  ])
  assert.equal(view.rubric.submissionRubricVersionId, RUBRIC_ID)
  assert.deepEqual(view.rubric.submissionDimensionKeys, ['backend_depth', 'async_pipeline', 'frontend_basics'])
  assert.equal(view.rubric.reason, '')
  assertClean(view)

  // 单函数直调与整行归一化结果一致（normalize.ts 只做加法，投影同一份 round.ts）。
  const row = normalizeInterviewRow(fullRow())
  assert.deepEqual(row.round, view)
  assert.equal(row.brief.source, 'TEMPLATE', '既有字段语义不变')
  assert.equal(row.rubric?.dimensions.length, 3)
})

test('normalizeRoundFocus / normalizeEffectiveRubric：坏类型降级为 ""/0/[]，未知 source 原样；scale 缺失 → 0/0', () => {
  const focus = normalizeRoundFocus({
    available: 'yes',
    source: 'MYSTERY_SOURCE',
    round_no: '3',
    title: 42,
    focus_dimensions: [{ key: 'k', label: 7, weight: '0.5', required: 1 }, {}, { key: '', label: '' }],
    questions: [{ text: '  ' }, { text: 42 }, ' 旧响应字符串问题 '],
    scorecard_fields: [{ key: 'k' }],
  })
  assert.equal(focus.available, false, '只认严格 true')
  assert.equal(focus.source, 'MYSTERY_SOURCE', '未知 source 原样保留')
  assert.equal(focus.round_no, 0, '字符串数字不算业务值')
  assert.equal(focus.title, '')
  assert.deepEqual(focus.focusDimensions, [
    { key: 'k', label: 'k', weight: 0, required: false, inRubric: false },
  ])
  assert.deepEqual(focus.questions, [{ key: '', text: '旧响应字符串问题' }], '问题纯字符串也兼容')
  assert.deepEqual(focus.scorecardFields, [{ key: 'k', label: 'k', kind: '', required: false }])
  assertClean(focus)

  const rubric = normalizeEffectiveRubric({ scorecard: { scale: { min: 'x', max: null } }, dimensions: [{}, { key: 'ok' }] })
  assert.equal(rubric.available, false)
  assert.equal(rubric.scaleMin, 0)
  assert.equal(rubric.scaleMax, 0, 'scale 缺失显示 0/0（界面不显示 0–0）')
  assert.deepEqual(rubric.dimensions.map((item) => item.key), ['ok'])
  assertClean(rubric)

  // 空投影（两个空对象）不抛错、不出现 undefined。
  assertClean(normalizeRoundFocus(null))
  assertClean(normalizeEffectiveRubric(undefined))
})

// ===========================================================================
//  2. round_focus.available=false（JOB_BASE 样例）→ 降级但不伪造
// ===========================================================================

test('JOB_BASE 降级：focus 不可用、重点/问题为空、rubric dims 全部 origin=JOB_BASE、reason 原样', () => {
  const row = { ...rowFixture(3), round_focus: jobBaseFocusFixture(3), effective_rubric: jobBaseRubricFixture(3) }
  const view = normalizeRoundEffective(row, { roundNo: 3 })

  assert.equal(view.serverFieldsMissing, false, '服务端字段存在（只是降级配置），不是旧端点')
  assert.equal(view.focus.available, false)
  assert.equal(view.focus.source, 'JOB_BASE')
  assert.equal(view.focus.round_no, 3)
  assert.deepEqual(view.focus.focusDimensions, [], '不得渲染轮次重点条目')
  assert.deepEqual(view.focus.questions, [], '不得渲染轮次问题')
  assert.equal(view.focus.title, '', '不得伪造标题')
  assert.equal(view.focus.description, '')
  assert.equal(view.focus.reason, '本场面试没有绑定可用的轮次模板，无法声称本轮重点；已如实降级到岗位 Rubric 底座（JOB_BASE）')
  assert.equal(roundFocusDegradedText(view), view.focus.reason, '降级卡原样展示服务端 reason')

  assert.equal(view.rubric.available, true)
  assert.equal(view.rubric.source, 'JOB_BASE')
  assert.equal(view.rubric.dimensions.length, 3)
  for (const dimension of view.rubric.dimensions) {
    assert.equal(dimension.origin, 'JOB_BASE', 'JOB_BASE 降级时不得出现轮次 override 来源')
    assert.equal(dimension.required, true, '面评必答（服务端 required=true）')
    assert.equal(dimension.focus, false)
    assert.equal(dimension.mustCover, false)
  }
  assert.equal(view.rubric.scaleMin, 0)
  assert.equal(view.rubric.scaleMax, 0, '服务端没给 scale → 0/0')
  assert.equal(view.conflict, false)
  assertClean(view)
})

// ===========================================================================
//  3. 两键都缺（旧端点 payload）→ serverFieldsMissing + 维度回退旧 row.rubric
// ===========================================================================

test('两键都缺（旧端点）：serverFieldsMissing=true、source=JOB_BASE、维度来自 row.rubric、不出现任何 title/description/questions', () => {
  const row = legacyRow()
  // 旧端点没有 effective_rubric → 只有旧的 row.rubric 能提供维度（按 normalize.ts 归一化后的形状传入）。
  const legacyRubric = {
    rubric_version_id: RUBRIC_ID,
    job_id: JOB_ID,
    payload_hash: HASH,
    dimensions: [
      { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5, question: '' },
      { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3, question: '' },
      { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2, question: '' },
    ],
  }
  const view = normalizeRoundEffective(row, { roundNo: 1, legacyRubric })

  assert.equal(view.serverFieldsMissing, true)
  assert.equal(view.focus.available, false)
  assert.equal(view.focus.source, 'JOB_BASE')
  assert.equal(view.focus.round_no, 1, 'round_no 只来自面试行')
  assert.equal(view.focus.title, '')
  assert.equal(view.focus.description, '')
  assert.deepEqual(view.focus.focusDimensions, [])
  assert.deepEqual(view.focus.questions, [])
  assert.deepEqual(view.focus.scorecardFields, [])
  assert.equal(view.focus.reason, ROUND_SERVER_FIELDS_MISSING_TEXT)
  assert.ok(roundFocusDegradedText(view).includes('task-50 端点未就绪'), '降级卡必须说明 task-50 未就绪')
  assert.ok(roundFocusDegradedText(view).includes('不伪造本轮重点'))

  // 维度来自旧 row.rubric（3 维；不伪造 focus/must_cover/submission）。
  assert.equal(view.rubric.available, true)
  assert.equal(view.rubric.source, 'JOB_BASE')
  assert.equal(view.rubric.rubricVersionId, RUBRIC_ID)
  assert.deepEqual(view.rubric.dimensions.map((item) => item.key), ['backend_depth', 'async_pipeline', 'frontend_basics'])
  for (const dimension of view.rubric.dimensions) {
    assert.equal(dimension.origin, 'JOB_BASE')
    assert.equal(dimension.focus, false)
    assert.equal(dimension.mustCover, false)
  }
  assert.deepEqual(view.rubric.submissionDimensionKeys, [], '旧端点没有 submission schema → 不编造')
  assert.deepEqual(view.rubric.scorecardFields, [])
  assert.equal(view.conflict, false)
  assertClean(view)

  // 整行归一化：既有的 brief/rubric 字段语义不变，只有新增 round 降级。
  const normalized = normalizeInterviewRow(row)
  assert.deepEqual(normalized.round, view)
  assert.equal(normalized.round_no, 1)
  assert.equal(normalized.brief.source, 'TEMPLATE')
  assert.deepEqual(normalized.brief.focus, [{ key: 'frontend_basics', label: '基本前端能力', weight: 0.2 }])
  assert.equal(normalized.rubric?.dimensions.length, 3)
})

// ===========================================================================
//  4. 缺 rubric 且无轮次配置 → 空维度 + NONE 空态，不抛错
// ===========================================================================

test('缺 rubric 且无轮次配置：空维度 + NONE 空态（不抛错、不伪造维度/标题）', () => {
  const row = { ...rowFixture(2), rubric: null, brief: { available: true, source: 'NONE', focus: [], questions: [], reason: 'NONE' } }
  const normalized = normalizeInterviewRow(row)

  assert.equal(normalized.round.serverFieldsMissing, true)
  assert.equal(normalized.round.rubric.available, false)
  assert.deepEqual(normalized.round.rubric.dimensions, [])
  assert.equal(normalized.round.focus.available, false)
  assert.deepEqual(normalized.round.focus.focusDimensions, [])
  assert.equal(normalized.round.focus.title, '')
  assert.ok(normalized.round.rubric.reason !== '', 'NONE 空态要有明确原因')
  assertClean(normalized.round)

  // 极端坏响应也不抛错（空对象 / null）。
  assertClean(normalizeRoundEffective({}, { roundNo: 0 }))
  assertClean(normalizeRoundEffective(null, { roundNo: 0 }))
  assertClean(normalizeInterviewRow(null).round)
})

// ===========================================================================
//  5. round_no 不一致 / declared rubric 冲突 → conflict=true，维度宇宙不变
// ===========================================================================

test('round_no 不一致：不套用轮次重点（conflict=true + 说明），维度宇宙不变', () => {
  const row = {
    ...rowFixture(1),
    // 服务端 round_focus 声称是第 2 轮，但面试行是第 1 轮。
    round_focus: { ...roundFocusFixture(), round_no: 2 },
    effective_rubric: effectiveRubricFixture(),
  }
  const view = normalizeRoundEffective(row, { roundNo: 1 })

  assert.equal(view.conflict, true)
  assert.ok(view.conflictReason.includes('round_no'), '冲突提示要说明 round_no')
  assert.ok(view.conflictReason.includes('2') && view.conflictReason.includes('1'))
  assert.equal(view.focus.available, false, '不套用轮次重点')
  assert.equal(view.focus.title, '')
  assert.equal(view.focus.description, '')
  assert.deepEqual(view.focus.focusDimensions, [])
  assert.deepEqual(view.focus.questions, [])
  assertClean(view)

  // 维度宇宙不变（仍是服务端 effective_rubric 的 3 维，frontend_basics 的 focus 标记也不改）。
  assert.deepEqual(view.rubric.dimensions.map((item) => item.key), [
    'backend_depth',
    'async_pipeline',
    'frontend_basics',
  ])
  assert.equal(view.rubric.dimensions[2]?.focus, true)
  assert.equal(view.rubric.dimensions[2]?.origin, 'ROUND_OVERRIDE')
})

test('declared rubric 冲突：conflict=true + 提示，维度保持 base/JOB_BASE（UI 不自行换版本）', () => {
  const row = {
    ...rowFixture(2),
    round_focus: roundFocusFixture(),
    effective_rubric: { ...effectiveRubricFixture(), declared_round_rubric_version_id: DECLARED_OTHER },
  }
  const view = normalizeRoundEffective(row, { roundNo: 2 })

  assert.equal(view.conflict, true)
  assert.ok(view.conflictReason.includes(DECLARED_OTHER), '提示要列出声明的版本 id')
  assert.equal(view.rubric.rubricVersionId, RUBRIC_ID, '维度宇宙仍是 base（不换版本）')
  assert.equal(view.rubric.baseRubricVersionId, RUBRIC_ID)
  assert.deepEqual(view.rubric.dimensions.map((item) => item.key), [
    'backend_depth',
    'async_pipeline',
    'frontend_basics',
  ])
  assert.equal(view.rubric.dimensions[2]?.focus, true, 'focus 标记来自服务端，不因冲突改动')
  assertClean(view)

  // declared == base（或 null）→ 不算冲突。
  const sameBase = { ...rowFixture(2), round_focus: roundFocusFixture(), effective_rubric: effectiveRubricFixture() }
  assert.equal(normalizeRoundEffective(sameBase, { roundNo: 2 }).conflict, false)
  const declaredNull = {
    ...rowFixture(2),
    round_focus: roundFocusFixture(),
    effective_rubric: { ...effectiveRubricFixture(), declared_round_rubric_version_id: null },
  }
  assert.equal(normalizeRoundEffective(declaredNull, { roundNo: 2 }).conflict, false)
})

test('只有 effective_rubric（round_focus 缺）：focus 按 JOB_BASE 降级，source 以 effective_rubric 为准', () => {
  const row = { ...rowFixture(2), effective_rubric: effectiveRubricFixture() }
  delete row.round_focus
  const view = normalizeRoundEffective(row, { roundNo: 2 })

  assert.equal(view.serverFieldsMissing, false, '只缺一个键不是"旧端点"')
  assert.equal(view.focus.available, false)
  assert.equal(view.focus.source, 'ROUND_OVERRIDE', 'source 以 effective_rubric.source 为准')
  assert.equal(view.focus.title, '')
  assert.deepEqual(view.focus.focusDimensions, [])
  assert.ok(view.focus.reason.includes('round_focus'), '降级原因要说明缺 round_focus')
  assert.equal(view.rubric.dimensions.length, 3)
  assertClean(view)
})

// ===========================================================================
//  6. roundSourceText 全分支
// ===========================================================================

test('roundSourceText：契约 §3 全部来源分支 + 未知 source 原样 + 旧端点 task-50 文案', () => {
  assert.equal(roundSourceText('ROUND_CONFIG'), '轮次配置（本场有专属考察重点与评分表覆盖）')
  assert.equal(roundSourceText('ROUND_OVERRIDE'), '轮次覆盖（本轮评分表在岗位底座上有覆盖）')
  assert.equal(roundSourceText('JOB_BASE'), '岗位基础（JOB_BASE 降级：服务端未提供该轮配置）')
  assert.equal(roundSourceText('TEMPLATE'), '面试模板（旧 brief，非轮次配置）')
  assert.equal(roundSourceText(''), '未知来源（服务端未提供 source）')
  assert.equal(roundSourceText('   '), '未知来源（服务端未提供 source）')

  const unknown = roundSourceText('MYSTERY_SOURCE')
  assert.ok(unknown.includes('MYSTERY_SOURCE'), '未知 source 原样显示')
  assert.ok(unknown.includes('未知来源'))

  const legacy = roundSourceText('JOB_BASE', true)
  assert.ok(legacy.includes('JOB_BASE'))
  assert.ok(legacy.includes('task-50 端点未就绪'), '旧端点降级文案要说明 task-50 未就绪')

  // 非字符串按"未提供 source"处理（不把数字/布尔伪装成来源）。
  assert.equal(roundSourceText(42 as unknown as string), '未知来源（服务端未提供 source）')
  assert.equal(roundSourceText(' ROUND_CONFIG '), '轮次配置（本场有专属考察重点与评分表覆盖）')
})

// ===========================================================================
//  7. 表单派生（spec vs effective schema）
// ===========================================================================

test('表单派生：spec==submission keys → usable，顺序/标签/权重/重点标记按 effective schema', () => {
  const spec = formSpecFixture()
  const round = normalizeRoundEffective(fullRow(), { roundNo: 2 })
  const derivation = deriveScorecardFields(spec, round)

  assert.equal(derivation.mismatch, false)
  assert.equal(derivation.usable, true)
  assert.deepEqual(derivation.mismatchKeys, [])
  assert.equal(derivation.mismatchText, ROUND_SCHEMA_MISMATCH_TEXT, '无差异时不拼 key 列表')

  assert.deepEqual(derivation.fields.map((field) => field.key), [
    'backend_depth',
    'async_pipeline',
    'frontend_basics',
  ])
  const frontend = derivation.fields[2]
  assert.ok(frontend !== undefined)
  assert.equal(frontend.label, '基本前端能力')
  assert.equal(frontend.kind, 'NICE_TO_HAVE')
  assert.equal(frontend.weight, 0.2)
  assert.equal(frontend.focus, true, '本轮重点标记来自 effective schema')
  assert.equal(frontend.mustCover, true, '本轮必覆盖标记来自 effective schema')
  assert.equal(frontend.origin, 'ROUND_OVERRIDE')
  assert.equal(frontend.overridden, true)
  // 控件仍只来自 W1 spec（枚举/分数区间/note 必填）。
  assert.deepEqual(frontend.spec.assessmentOptions, ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'])
  assert.equal(frontend.spec.scoreMin, 1)
  assert.equal(frontend.spec.scoreMax, 5)
  assert.equal(frontend.spec.noteRequired, false)
  assertClean(derivation)
})

test('表单派生：effective 维度是 spec 子集 → usable 且 spec 全集保留（其余追加在末尾）', () => {
  const spec = formSpecFixture()
  const round = normalizeRoundEffective(fullRow(), { roundNo: 2 })
  // 子集：去掉 async_pipeline（submission keys 仍是 spec 全集）。
  const subset = roundVariant(round, {
    dimensions: round.rubric.dimensions.filter((dimension) => dimension.key !== 'async_pipeline'),
    submissionKeys: ['backend_depth', 'async_pipeline', 'frontend_basics'],
  })
  const derivation = deriveScorecardFields(spec, subset)

  assert.equal(derivation.mismatch, false, 'effective 子集允许提交')
  assert.equal(derivation.usable, true)
  assert.deepEqual(derivation.fields.map((field) => field.key), [
    'backend_depth',
    'frontend_basics',
    'async_pipeline',
  ])
  for (const key of ['backend_depth', 'async_pipeline', 'frontend_basics']) {
    assert.ok(
      derivation.fields.some((field) => field.key === key && field.spec.key === key),
      `${key} 的控件必须保留（spec 全集仍必填）`,
    )
  }
  const appended = derivation.fields[2]
  assert.equal(appended?.overridden, false, 'spec 其余维度按原样渲染（不冒充满分覆盖）')
  assert.equal(appended?.origin, '')
})

test('表单派生：submission keys ≠ spec keys → mismatch fail-closed（列出差异 key）', () => {
  const spec = formSpecFixture()
  const round = normalizeRoundEffective(fullRow(), { roundNo: 2 })
  const missingOne = roundVariant(round, {
    submissionKeys: ['backend_depth', 'frontend_basics'],
  })
  const derivation = deriveScorecardFields(spec, missingOne)

  assert.equal(derivation.mismatch, true)
  assert.equal(derivation.usable, false, '不一致必须禁用提交（不写库）')
  assert.ok(derivation.mismatchKeys.includes('async_pipeline'), '列出 spec 有而 submission 缺的 key')
  assert.ok(derivation.mismatchText.includes(ROUND_SCHEMA_MISMATCH_TEXT))
  assert.ok(derivation.mismatchText.includes('async_pipeline'))

  // submission 里多出 spec 不存在的 key 同样 mismatch。
  const extraSubmission = roundVariant(round, {
    submissionKeys: ['backend_depth', 'async_pipeline', 'frontend_basics', 'ghost_key'],
  })
  const extraDerivation = deriveScorecardFields(spec, extraSubmission)
  assert.equal(extraDerivation.mismatch, true)
  assert.ok(extraDerivation.mismatchKeys.includes('ghost_key'))
})

test('表单派生：effective 含 spec 外 key → mismatch（该 key 无控件，不渲染）', () => {
  const spec = formSpecFixture()
  const round = normalizeRoundEffective(fullRow(), { roundNo: 2 })
  const withGhost = roundVariant(round, {
    dimensions: [
      ...round.rubric.dimensions,
      {
        key: 'ghost_key',
        label: '服务端多给的维度',
        kind: 'PLUS',
        weight: 0.1,
        required: true,
        focus: false,
        mustCover: false,
        origin: 'ROUND_OVERRIDE',
        question: '',
      },
    ],
    submissionKeys: ['backend_depth', 'async_pipeline', 'frontend_basics'],
  })
  const derivation = deriveScorecardFields(spec, withGhost)

  assert.equal(derivation.mismatch, true)
  assert.equal(derivation.usable, false)
  assert.ok(derivation.mismatchKeys.includes('ghost_key'))
  assert.equal(
    derivation.fields.some((field) => field.key === 'ghost_key'),
    false,
    'spec 外 key 不能生成控件（提交键集不可由 UI 增删）',
  )
})

test('表单派生：旧端点（serverFieldsMissing）不产生 mismatch、保持 spec 原样；空 spec/无 round 也安全', () => {
  const spec = formSpecFixture()
  const legacy = normalizeRoundEffective(legacyRow(), { roundNo: 1 })

  const legacyDerivation = deriveScorecardFields(spec, legacy)
  assert.equal(legacy.serverFieldsMissing, true)
  assert.equal(legacyDerivation.mismatch, false, '旧端点按现行为提交（不产生 mismatch）')
  assert.equal(legacyDerivation.usable, true)
  assert.deepEqual(legacyDerivation.fields.map((field) => field.key), [
    'backend_depth',
    'async_pipeline',
    'frontend_basics',
  ])
  assert.equal(legacyDerivation.fields[0]?.overridden, false)

  // 没有 round 投影（旧调用方）→ 全部按 spec。
  const noRound = deriveScorecardFields(spec, null)
  assert.equal(noRound.mismatch, false)
  assert.equal(noRound.fields.length, 3)
  assert.equal(deriveScorecardFields(spec).usable, true)

  // 空 spec / 未取到 spec → 无字段、不可用（现有提交规则仍 fail-closed）。
  const empty = deriveScorecardFields(undefined, normalizeRoundEffective(fullRow(), { roundNo: 2 }))
  assert.deepEqual(empty.fields, [])
  assert.equal(empty.usable, false)
  assertClean(empty)
})

// ===========================================================================
//  8. normalizeInterviewerOverview 旧 payload 不回归
// ===========================================================================

test('normalizeInterviewerOverview：旧 payload 新字段默认降级，既有字段语义不变', () => {
  const overview = normalizeInterviewerOverview({
    contract_version: 'interviewer-workspace 1.0.0',
    configured: true,
    evaluated_at: '2026-11-15T06:00:00.000Z',
    actor: { alias: 'interviewer_b', actor_id: ACTOR_B, display_name: '演示-面试官 B', roles: ['INTERVIEWER'] },
    session: { session_id: 'session-test' },
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: { assigned_total: 2 },
    interviews: [legacyRow(), { ...legacyRow(), interview_id: INT_2, round_no: 2 }],
    issues: [],
  })

  assert.equal(overview.interviews.length, 2)
  for (const row of overview.interviews) {
    assert.equal(row.round.serverFieldsMissing, true)
    assert.equal(row.round.focus.available, false)
    assert.equal(row.round.focus.source, 'JOB_BASE')
    assert.equal(row.round.focus.title, '')
    assert.equal(row.round.rubric.dimensions.length, 3)
  }
  // 既有字段：brief focus / rubric / transcript / scorecard 原样。
  const first = overview.interviews[0]
  assert.ok(first !== undefined)
  assert.equal(first.brief.source, 'TEMPLATE')
  assert.deepEqual(first.brief.focus, [{ key: 'frontend_basics', label: '基本前端能力', weight: 0.2 }])
  assert.equal(first.rubric?.rubric_version_id, RUBRIC_ID)
  assert.equal(first.transcript.state, 'MISSING')
  assert.equal(first.scorecard.state, 'NONE')
  assertClean(overview)

  // 空响应：interviews=[]、不抛错；单行空对象也能归一化。
  assert.deepEqual(normalizeInterviewerOverview({}).interviews, [])
  assert.equal(normalizeInterviewerOverview({ interviews: [{}] }).interviews[0]?.round.serverFieldsMissing, true)
})

// ===========================================================================
//  9. 列表右栏轮次分组（轮次投影口径 + 旧 brief 口径）
// ===========================================================================

test('groupRoundProjects：按 round_no 分组用轮次投影（available/source/title；JOB_BASE 不展示假重点）', () => {
  const rows = [
    normalizeInterviewRow(fullRow()), // 第 2 轮：ROUND_CONFIG
    normalizeInterviewRow({
      ...rowFixture(3),
      round_focus: jobBaseFocusFixture(3),
      effective_rubric: jobBaseRubricFixture(3),
    }), // 第 3 轮：JOB_BASE 降级
    normalizeInterviewRow(legacyRow()), // 第 1 轮：旧端点 → 旧 brief 辅助信息
  ]
  const groups = groupRoundProjects(rows)

  assert.deepEqual(groups.map((group) => group.round_no), [1, 2, 3])

  const round2 = groups[1]
  assert.ok(round2 !== undefined)
  assert.equal(round2.available, true)
  assert.equal(round2.source, 'ROUND_CONFIG')
  assert.equal(round2.title, '第 2 轮：跨团队协作与取舍')
  assert.deepEqual(round2.focusDimensions.map((item) => item.key), ['frontend_basics', 'conflict_tradeoff'])
  assert.equal(round2.interviewCount, 1)
  assert.equal(round2.legacyBriefFocus.length, 0, '有新端点配置时不混入旧 brief')

  const round3 = groups[2]
  assert.ok(round3 !== undefined)
  assert.equal(round3.available, false, 'JOB_BASE 降级组不展示伪造重点')
  assert.equal(round3.source, 'JOB_BASE')
  assert.deepEqual(round3.focusDimensions, [])
  assert.ok(round3.reason.includes('无法声称本轮重点'))

  const round1 = groups[0]
  assert.ok(round1 !== undefined)
  assert.equal(round1.available, false)
  assert.equal(round1.serverFieldsMissing, true)
  assert.equal(round1.legacyBriefSource, 'TEMPLATE', '旧端点组要标注旧 brief 来源')
  assert.deepEqual(round1.legacyBriefFocus.map((item) => item.key), ['frontend_basics'], '旧 brief 只作辅助信息')
  assertClean(groups)
})

test('groupRounds（既有导出）：旧端点保持 brief 口径（LEGACY_BRIEF），新端点只用 round_focus 维度', () => {
  const rows = [normalizeInterviewRow(legacyRow()), normalizeInterviewRow(fullRow())]
  const older = rows[0]
  assert.ok(older !== undefined)
  const newer = rows[1]
  assert.ok(newer !== undefined)
  const groups = groupRounds([older, newer])

  assert.deepEqual(groups.map((group) => group.round_no), [1, 2])
  const legacyGroup = groups[0]
  assert.ok(legacyGroup !== undefined)
  assert.equal(legacyGroup.source, 'LEGACY_BRIEF')
  assert.equal(legacyGroup.available, false)
  assert.deepEqual(legacyGroup.focus.map((item) => item.key), ['frontend_basics'], '旧端点回退旧 brief（兼容既有测试）')

  const newGroup = groups[1]
  assert.ok(newGroup !== undefined)
  assert.equal(newGroup.source, 'ROUND_CONFIG')
  assert.equal(newGroup.available, true)
  assert.equal(newGroup.title, '第 2 轮：跨团队协作与取舍')
  assert.deepEqual(newGroup.focus.map((item) => item.key), ['frontend_basics', 'conflict_tradeoff'])
  assert.equal(newGroup.focus[0]?.required, true, '轮次配置的重点维度带 required 标记')
})
