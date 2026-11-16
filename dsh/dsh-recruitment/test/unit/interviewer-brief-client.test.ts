// 面试详情新增 `prior_rounds` + `reference_points` 的**客户端**纯函数测试（node --test，无 DOM / 无 React）。
//
// 两份合同：
//   * `work/d5/interviewer-brief/DESIGN.md` §1（服务端形状）/ §2（客户端形状与渲染口径）；
//   * D-141：渲染文本禁止 UUID / 64hex / snake_case 字段名 / 接口路径 / 枚举机器码。
//
// 覆盖三件事：
//   1. **归一化容错**：缺字段 / 坏类型 / 半个字段一律降级空数组或空字段，绝不抛；
//      既有字段（回归）一个都不受影响；
//   2. **文本映射**：prior / ref 转中文的纯函数逐句断言（状态、结论、覆盖/未覆盖、原因中文）；
//   3. **机检**：把归一化 + 渲染函数在"含 UUID / hex / 枚举码"的输入上跑一遍，
//      产出的每一行文本都不得出现 UUID（8-4-4-4-12）、64hex、32+ 连续 hex、snake_case 字段名、枚举码。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeInterviewerOverview,
  normalizeInterviewRow,
  normalizePriorRounds,
  normalizeReferencePoints,
  overallText,
  PRIOR_ROUNDS_EMPTY_TEXT,
  priorConclusionText,
  priorRoundCoverageLines,
  priorRoundHeadlineText,
  priorRoundInterviewerNames,
  priorRoundLines,
  priorRoundScorecardLine,
  priorRoundStatusText,
  priorScorecardStateText,
  REFERENCE_POINTS_EMPTY_TEXT,
  referencePointLines,
  uncoveredReasonText,
  type InterviewRow,
  type PriorRoundView,
  type ReferencePointView,
} from '../../src/client/interviewer/normalize.ts'

// ---------------------------------------------------------------------------
//  夹具（与 DESIGN §1 同形；id / hash 都是固定假值，不含任何真实数据）
// ---------------------------------------------------------------------------

const INT_2 = '11111111-1111-4111-8111-000000000802'
const INT_1 = '11111111-1111-4111-8111-000000000801'
const APP = '11111111-1111-4111-8111-000000000701'
const CANDIDATE = '11111111-1111-4111-8111-000000000601'
const JOB = '11111111-1111-4111-8111-000000000401'
const ACTOR_A = '11111111-1111-4111-8111-000000000104'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const HASH_64 = 'a'.repeat(64)
const SCORECARD = '11111111-1111-4111-8111-000000000821'

/** 三个岗位标准维度（与 `ra_iwbrief_1116_live` 的 rubric v2 同 label；这里只对文案负责）。 */
const DIM_WORK = { key: 'work_exists', label: '简历中存在可分割的工作经历条目', weight: 0.5 }
const DIM_TEAM = { key: 'team_lead', label: '有带团队经验', weight: 0.25 }
const DIM_EDU = { key: 'edu_exists', label: '简历中存在可分割的教育经历条目', weight: 0.25 }

/** 前置轮次（第 1 轮）的完整服务端形状：2 维覆盖（1 维 NOT_OBSERVED）、1 位面试官已提交。 */
function priorRoundRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    round_no: 1,
    interview_id: INT_1,
    status: 'POST_INTERVIEW',
    slot_code: 'DEFAULT',
    scheduled_start_at: '2026-11-12T06:00:00.000Z',
    interviewers: [
      {
        display_name: '演示-面试官',
        scorecard_state: 'SUBMITTED',
        scorecard_submitted: true,
        conclusion: 'ADVANCE',
      },
    ],
    dimensions_available: true,
    covered_dimensions: [
      { ...DIM_WORK, assessment: 'MET', score: 4 },
      { ...DIM_TEAM, assessment: 'NOT_MET', score: 2 },
    ],
    uncovered_dimensions: [{ ...DIM_EDU, reason: 'NOT_OBSERVED' }],
    ...overrides,
  }
}

/** 参考点（服务端已保证 point/why 里没有人读禁区；客户端只透传）。 */
function referencePointRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    point: '上一轮没有覆盖到「简历中存在可分割的教育经历条目」',
    why: '岗位标准里有这一条（权重 0.25），但上一轮的面评没有给出这一维的评价（上一轮标记为未观察到）。这一轮可以自己确认一下。',
    basis: { kind: 'PRIOR_GAP', ref: 'edu_exists' },
    ...overrides,
  }
}

/** 一条面试行（服务端 overview.interviews[] 元素的最小可用形状）。 */
function rowRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interview_id: INT_2,
    application_id: APP,
    candidate: { candidate_id: CANDIDATE, display_name: '演示候选人-张样例' },
    job: { job_id: JOB, code: 'DEMO-BE-001', title: '后端工程师（演示）' },
    round_no: 2,
    slot_code: 'DEFAULT',
    status: 'SCHEDULED',
    stage_code: 'S8',
    scheduled_start_at: '2026-11-20T06:00:00.000Z',
    scheduled_end_at: '2026-11-20T07:00:00.000Z',
    timezone: 'Asia/Shanghai',
    record_version: 2,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: true,
    scorecard_due_at: '',
    brief: { available: true, source: 'ROUND_CONFIG', objective: '二面', briefing: '', focus: [], questions: [] },
    rubric: null,
    materials: { authorization: '', available: false, reason: '', resume: null },
    transcript: { state: 'PENDING', reason_code: '', no_transcript: false, meeting_binding_state: 'UNBOUND', meetings_total: 0 },
    scorecard: { state: 'NONE', scorecard_id: '', status: '', revision_no: 0, record_version: 0, submitted_at: '', transcript_basis: '', overall: '' },
    required_action: 'SUBMIT_SCORECARD',
    prior_rounds: [priorRoundRaw()],
    reference_points: [referencePointRaw()],
    ...overrides,
  }
}

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

/** D-141 机检：一行文本里不得出现这些"机器痕迹"。 */
const FORBIDDEN_IN_TEXT: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'UUID(8-4-4-4-12)', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: '64hex', pattern: /[0-9a-f]{64}/i },
  { name: '32+连续hex', pattern: /[0-9a-f]{32,}/i },
  {
    name: 'snake_case 字段名',
    pattern:
      /\b(prior_rounds|reference_points|interview_id|application_id|scorecard_state|scorecard_submitted|dimensions_available|covered_dimensions|uncovered_dimensions|display_name|round_no|slot_code|work_exists|team_lead|edu_exists)\b/,
  },
  {
    name: '枚举机器码',
    pattern:
      /\b(ADVANCE|HOLD|REJECT|MET|NOT_MET|NOT_OBSERVED|UNREADABLE|NO_SCORECARD|NO_ITEMS|NOT_RATED|SUBMITTED|PENDING|WAIVED|NONE|POST_INTERVIEW|SCHEDULED|RUBRIC_DIMENSION|PRIOR_GAP|RESUME_HIGHLIGHT)\b/,
  },
]

/** 对一组文本行做机检；命中即失败并给出命中类型/命中值/行原文。 */
function assertNoMachineIds(lines: readonly string[], where: string): void {
  for (const line of lines) {
    for (const rule of FORBIDDEN_IN_TEXT) {
      const match = rule.pattern.exec(line)
      if (match !== null) {
        throw new Error(`${where}：渲染文本命中 ${rule.name}「${match[0]}」——整行原文：${line}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
//  1. 归一化：完整形状 / 缺字段 / 坏类型 / 半个字段
// ---------------------------------------------------------------------------

test('normalizeInterviewRow：完整 prior_rounds + reference_points 归一化为 camelCase 客户端形状', () => {
  const row = normalizeInterviewRow(rowRaw())
  assertClean(row)

  assert.equal(row.priorRounds.length, 1)
  const round = row.priorRounds[0]
  assert.ok(round !== undefined)
  assert.equal(round.roundNo, 1)
  assert.equal(round.interviewId, INT_1)
  assert.equal(round.status, 'POST_INTERVIEW')
  assert.equal(round.slotCode, 'DEFAULT')
  assert.equal(round.scheduledStartAt, '2026-11-12T06:00:00.000Z')
  assert.equal(round.dimensionsAvailable, true)
  assert.equal(round.interviewers.length, 1)
  assert.deepEqual(round.interviewers[0], {
    displayName: '演示-面试官',
    scorecardState: 'SUBMITTED',
    scorecardSubmitted: true,
    conclusion: 'ADVANCE',
  })
  assert.deepEqual(round.coveredDimensions, [
    { key: 'work_exists', label: '简历中存在可分割的工作经历条目', weight: 0.5, assessment: 'MET', score: 4 },
    { key: 'team_lead', label: '有带团队经验', weight: 0.25, assessment: 'NOT_MET', score: 2 },
  ])
  assert.deepEqual(round.uncoveredDimensions, [
    { key: 'edu_exists', label: '简历中存在可分割的教育经历条目', weight: 0.25, reason: 'NOT_OBSERVED' },
  ])

  assert.equal(row.referencePoints.length, 1)
  assert.deepEqual(row.referencePoints[0], {
    point: referencePointRaw().point,
    why: referencePointRaw().why,
    basisKind: 'PRIOR_GAP',
    basisRef: 'edu_exists',
  })
})

test('normalizeInterviewRow：旧响应没有两个新字段 → 空数组（不是 undefined，也不抛）', () => {
  const raw = rowRaw()
  delete raw.prior_rounds
  delete raw.reference_points
  const row = normalizeInterviewRow(raw)
  assertClean(row)
  assert.deepEqual(row.priorRounds, [])
  assert.deepEqual(row.referencePoints, [])
  // 回归：既有字段不受影响。
  assert.equal(row.interview_id, INT_2)
  assert.equal(row.round_no, 2)
  assert.equal(row.scorecard.state, 'NONE')
})

test('normalizePriorRounds：坏类型整体降级为 []（null / 字符串 / 对象 / 数字 / undefined）', () => {
  for (const bad of [null, undefined, 'oops', 42, true, {}, { round_no: 1 }]) {
    assert.deepEqual(normalizePriorRounds(bad), [], `输入 ${JSON.stringify(bad)} 应降级为 []`)
  }
})

test('normalizePriorRounds：数组里混入非对象元素 → 丢弃；空对象 → 降级空字段（不抛）', () => {
  const rounds = normalizePriorRounds([null, 'x', 7, [], {}, priorRoundRaw()])
  assertClean(rounds)
  // 只有后两个对象元素保留（`{}` 是对象，降级为全空；第 6 个是完整夹具）。
  assert.equal(rounds.length, 2)
  const empty = rounds[0]
  assert.ok(empty !== undefined)
  assert.equal(empty.roundNo, 0)
  assert.equal(empty.interviewId, '')
  assert.equal(empty.dimensionsAvailable, false)
  assert.deepEqual(empty.interviewers, [])
  assert.deepEqual(empty.coveredDimensions, [])
  assert.deepEqual(empty.uncoveredDimensions, [])
  const full = rounds[1]
  assert.ok(full !== undefined)
  assert.equal(full.roundNo, 1)
})

test('normalizePriorRounds：半个字段 / 坏类型逐项降级（不把坏值当业务事实）', () => {
  const rounds = normalizePriorRounds([
    priorRoundRaw({
      round_no: '3', // 字符串数字不是数字
      status: 5,
      interviewers: [
        { display_name: 42, scorecard_state: 'SUBMITTED', scorecard_submitted: 'yes', conclusion: 'MAYBE' },
        { display_name: '  演示-面试官 B  ', scorecard_state: 'nope', scorecard_submitted: false, conclusion: 'HOLD' },
        'not-an-object',
      ],
      dimensions_available: 'true', // 只认严格 true
      covered_dimensions: [
        { ...DIM_WORK, assessment: 'MET', score: 9 }, // 越界分 → null
        { ...DIM_TEAM, assessment: 'NOT_MET', score: 3.5 }, // 小数 → null
        { ...DIM_EDU, assessment: 'NOT_OBSERVED', score: 3 }, // 不在 covered 语义内 → 丢弃
        { key: 'no_label', weight: 1, assessment: 'MET' }, // label 缺失 → 用 key 兜底
        { key: '', label: '  ', assessment: 'MET' }, // key/label 都空 → 丢弃
      ],
      uncovered_dimensions: [{ label: '有带团队经验' }, { key: '', label: '', reason: 'X' }],
    }),
  ])
  assertClean(rounds)
  const round = rounds[0]
  assert.ok(round !== undefined)
  assert.equal(round.roundNo, 0)
  assert.equal(round.status, '')
  assert.equal(round.dimensionsAvailable, false)
  assert.equal(round.interviewers.length, 2)
  assert.deepEqual(round.interviewers[0], {
    displayName: '',
    scorecardState: 'SUBMITTED',
    scorecardSubmitted: false,
    conclusion: null,
  })
  assert.deepEqual(round.interviewers[1], {
    displayName: '演示-面试官 B',
    scorecardState: '',
    scorecardSubmitted: false,
    conclusion: 'HOLD',
  })
  assert.deepEqual(round.coveredDimensions, [
    { key: 'work_exists', label: '简历中存在可分割的工作经历条目', weight: 0.5, assessment: 'MET', score: null },
    { key: 'team_lead', label: '有带团队经验', weight: 0.25, assessment: 'NOT_MET', score: null },
    { key: 'no_label', label: 'no_label', weight: 1, assessment: 'MET', score: null },
  ])
  assert.deepEqual(round.uncoveredDimensions, [
    { key: '', label: '有带团队经验', weight: 0, reason: '' },
  ])
})

test('normalizeReferencePoints：坏类型降级 + 无 point 的条目丢弃 + basis 缺失不抛', () => {
  for (const bad of [null, undefined, 'x', 3, {}]) {
    assert.deepEqual(normalizeReferencePoints(bad), [])
  }
  const points = normalizeReferencePoints([
    null,
    'x',
    {},
    { point: '  ', why: '有理由但没要点' },
    { point: '可以重点了解「有带团队经验」', why: '' },
    { point: '简历里有一段没有展开的经历：负责支付网关改造', why: '材料里这段经历只有一行摘要。', basis: { kind: 'RESUME_HIGHLIGHT' } },
  ])
  assertClean(points)
  assert.equal(points.length, 2)
  assert.deepEqual(points[0], {
    point: '可以重点了解「有带团队经验」',
    why: '',
    basisKind: '',
    basisRef: '',
  })
  assert.deepEqual(points[1], {
    point: '简历里有一段没有展开的经历：负责支付网关改造',
    why: '材料里这段经历只有一行摘要。',
    basisKind: 'RESUME_HIGHLIGHT',
    basisRef: '',
  })
})

test('normalizeInterviewerOverview：整包旧响应（无新字段）不回归、不抛', () => {
  const overview = normalizeInterviewerOverview({
    contract_version: 'v1',
    configured: true,
    evaluated_at: '2026-11-16T12:00:00.000Z',
    actor: { alias: 'interviewer_a', actor_id: ACTOR_A, display_name: '演示-面试官', roles: ['INTERVIEWER'] },
    session_id: 'session-0000',
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: { assigned_total: 2, open_interview_total: 2 },
    interviews: [rowRaw()],
    issues: [],
  })
  assertClean(overview)
  assert.equal(overview.interviews.length, 1)
  assert.equal(overview.interviews[0]?.priorRounds.length, 1)
  assert.equal(overview.interviews[0]?.referencePoints.length, 1)
})

// ---------------------------------------------------------------------------
//  2. 文本映射：每一句都按 DESIGN §2 / 任务口径逐字断言
// ---------------------------------------------------------------------------

test('priorScorecardStateText：四种状态的中文 + 未知降级不泄露机器码', () => {
  assert.equal(priorScorecardStateText('SUBMITTED'), '已提交')
  assert.equal(priorScorecardStateText('PENDING'), '草稿未提交')
  assert.equal(priorScorecardStateText('NONE'), '未填')
  assert.equal(priorScorecardStateText('WAIVED'), '已豁免')
  assert.equal(priorScorecardStateText(''), '状态未提供')
  assert.equal(priorScorecardStateText('SOMETHING_NEW'), '状态未提供')
})

test('priorConclusionText：ADVANCE/HOLD/REJECT → 推进/暂缓/不通过；未知 → 空（不显示结论）', () => {
  assert.equal(priorConclusionText('ADVANCE'), '推进')
  assert.equal(priorConclusionText('HOLD'), '暂缓')
  assert.equal(priorConclusionText('REJECT'), '不通过')
  assert.equal(priorConclusionText(null), '')
  assert.equal(priorConclusionText(''), '')
  assert.equal(priorConclusionText('MAYBE'), '')
})

test('口径唯一：新卡结论词 = 既有 overallText() 的中文词（Owner 裁决 HOLD=暂缓，禁两套措辞）', () => {
  for (const overall of ['ADVANCE', 'HOLD', 'REJECT']) {
    const existing = overallText(overall)
    const match = /（(.+)）/.exec(existing)
    assert.ok(match !== null, `overallText(${overall}) 形状异常：${existing}`)
    assert.equal(
      priorConclusionText(overall),
      match[1],
      `同一个 scorecard.overall 在新卡与既有面评分支上必须是同一个中文词（${overall}）`,
    )
  }
})

test('priorRoundStatusText / uncoveredReasonText：中文映射 + 未知不外泄码', () => {
  assert.equal(priorRoundStatusText('SCHEDULED'), '已排期')
  assert.equal(priorRoundStatusText('POST_INTERVIEW'), '面试后')
  assert.equal(priorRoundStatusText('IN_PROGRESS'), '进行中')
  assert.equal(priorRoundStatusText(''), '状态未提供')
  assert.equal(priorRoundStatusText('CANCELLED'), '已取消')
  assert.equal(priorRoundStatusText('WHATEVER'), '状态未提供')

  assert.equal(uncoveredReasonText('NO_SCORECARD'), '没有已提交的面评')
  assert.equal(uncoveredReasonText('NO_ITEMS'), '面评里没有维度明细')
  assert.equal(uncoveredReasonText('NOT_RATED'), '面评没有评到这一维')
  assert.equal(uncoveredReasonText('NOT_OBSERVED'), '上一轮标记为未观察到')
  assert.equal(uncoveredReasonText('UNREADABLE'), '上一轮面评无法判读')
  assert.equal(uncoveredReasonText(''), '原因未提供')
  assert.equal(uncoveredReasonText('BRAND_NEW_CODE'), '原因未提供')
})

test('priorRoundLines：第 1 轮（覆盖 2 维 / 未覆盖 1 维）逐行文案', () => {
  const round = normalizePriorRounds([priorRoundRaw()])[0]
  assert.ok(round !== undefined)
  assert.deepEqual(priorRoundLines(round), [
    '第 1 轮 · 面试后 · 面试官：演示-面试官',
    '面评：已提交 · 结论：推进',
    '覆盖到的维度：简历中存在可分割的工作经历条目、有带团队经验',
    '没有覆盖到的维度：简历中存在可分割的教育经历条目（上一轮标记为未观察到）',
  ])
  assertNoMachineIds(priorRoundLines(round), '第 1 轮')
})

test('priorRoundScorecardLine：未提交不显示结论（草稿里有分也不算证据）', () => {
  const draft = normalizePriorRounds([
    priorRoundRaw({
      interviewers: [{ display_name: '演示-面试官', scorecard_state: 'PENDING', scorecard_submitted: false, conclusion: 'ADVANCE' }],
    }),
  ])[0]
  assert.ok(draft !== undefined)
  assert.equal(priorRoundScorecardLine(draft), '面评：草稿未提交')
  assert.ok(!priorRoundScorecardLine(draft).includes('结论'))

  const none = normalizePriorRounds([priorRoundRaw({ interviewers: [] })])[0]
  assert.ok(none !== undefined)
  assert.equal(priorRoundScorecardLine(none), '面评：未提供')

  const waived = normalizePriorRounds([
    priorRoundRaw({
      interviewers: [{ display_name: '', scorecard_state: 'WAIVED', scorecard_submitted: false, conclusion: 'HOLD' }],
    }),
  ])[0]
  assert.ok(waived !== undefined)
  assert.equal(priorRoundScorecardLine(waived), '面评：已豁免')
  assert.equal(priorRoundInterviewerNames(waived), '（显示名未提供）')
})

test('priorRoundScorecardLine：多位面试官逐位给状态（不合并成可能误导的一句）', () => {
  const round = normalizePriorRounds([
    priorRoundRaw({
      interviewers: [
        { display_name: '演示-面试官', scorecard_state: 'SUBMITTED', scorecard_submitted: true, conclusion: 'ADVANCE' },
        { display_name: '演示-面试官 B', scorecard_state: 'NONE', scorecard_submitted: false, conclusion: null },
      ],
    }),
  ])[0]
  assert.ok(round !== undefined)
  assert.equal(
    priorRoundScorecardLine(round),
    '面评：演示-面试官 已提交 · 结论：推进；演示-面试官 B 未填',
  )
  assert.equal(priorRoundInterviewerNames(round), '演示-面试官、演示-面试官 B')
  assertNoMachineIds(priorRoundLines(round), '多面试官')
})

test('priorRoundCoverageLines：维度宇宙读不到 / 两数组都空 → 一句「不推测」', () => {
  // dimensions_available=false（服务端仍塞了数组）→ 仍不判定覆盖：以宇宙可用性为准。
  const unreadable = normalizePriorRounds([priorRoundRaw({ dimensions_available: false })])[0]
  assert.ok(unreadable !== undefined)
  assert.deepEqual(priorRoundCoverageLines(unreadable), [
    '这一轮的评分维度读不到，无法判断覆盖情况（不推测）。',
  ])

  const bothEmpty = normalizePriorRounds([
    priorRoundRaw({ dimensions_available: true, covered_dimensions: [], uncovered_dimensions: [] }),
  ])[0]
  assert.ok(bothEmpty !== undefined)
  assert.deepEqual(priorRoundCoverageLines(bothEmpty), ['这一轮的评分维度读不到，无法判断覆盖情况（不推测）。'])
})

test('priorRoundCoverageLines：全未覆盖 / 全覆盖都要如实写「无」', () => {
  const noneCovered = normalizePriorRounds([
    priorRoundRaw({ covered_dimensions: [], uncovered_dimensions: [{ ...DIM_EDU, reason: 'NO_SCORECARD' }] }),
  ])[0]
  assert.ok(noneCovered !== undefined)
  assert.deepEqual(priorRoundCoverageLines(noneCovered), [
    '覆盖到的维度：无',
    '没有覆盖到的维度：简历中存在可分割的教育经历条目（没有已提交的面评）',
  ])

  const allCovered = normalizePriorRounds([
    priorRoundRaw({
      covered_dimensions: [{ ...DIM_EDU, assessment: 'MET', score: 5 }],
      uncovered_dimensions: [],
    }),
  ])[0]
  assert.ok(allCovered !== undefined)
  assert.deepEqual(priorRoundCoverageLines(allCovered), [
    '覆盖到的维度：简历中存在可分割的教育经历条目',
    '没有覆盖到的维度：无',
  ])
})

test('referencePointLines：每条 `• point` + `值得问的原因：why`；空数组给空态；不改写成命令句', () => {
  const lines = referencePointLines(normalizeReferencePoints([referencePointRaw()]))
  assert.deepEqual(lines, [
    `• ${referencePointRaw().point}`,
    `值得问的原因：${referencePointRaw().why}`,
  ])
  assertNoMachineIds(lines, '参考点')

  // why 缺失 → 如实说"服务端未提供理由"，不编造。
  const noWhy = referencePointLines(normalizeReferencePoints([{ point: '可以重点了解「有带团队经验」', why: '' }]))
  assert.deepEqual(noWhy, ['• 可以重点了解「有带团队经验」', '值得问的原因：服务端未提供理由。'])

  assert.deepEqual(referencePointLines([]), [REFERENCE_POINTS_EMPTY_TEXT])
  assert.equal(REFERENCE_POINTS_EMPTY_TEXT, '暂时没有可参考的要点。')
  assert.equal(PRIOR_ROUNDS_EMPTY_TEXT, '这是第一轮，没有前置轮次可参考。')
  // 措辞纪律：不出现命令句（必须/应该/务必/按顺序/先问…再问）。
  for (const line of [...lines, ...noWhy]) {
    assert.ok(!/必须|应该|务必|一定要|按顺序|先问|再问/.test(line), `不得出现命令句：${line}`)
  }
})

test('referencePointLines：服务端 point/why 原样透传（客户端不改写、不拼 key/id）', () => {
  const point = '简历里有一段没有展开的经历：负责支付网关改造'
  const why = '材料里这段经历只有一行摘要，没有写具体做法；可以参考它了解真实的技术选择。'
  const lines = referencePointLines([{ point, why, basisKind: 'RESUME_HIGHLIGHT', basisRef: 'work_experience[0]' }])
  assert.deepEqual(lines, [`• ${point}`, `值得问的原因：${why}`])
  assert.ok(!lines.join('\n').includes('work_experience'), 'basis.ref 不得被渲染')
})

// ---------------------------------------------------------------------------
//  3. 机检：整条渲染链路（归一化 → 文本）不得出现 UUID / 64hex / 字段名 / 枚举码
// ---------------------------------------------------------------------------

test('机检：含 UUID / 64hex / snake_case / 枚举码的输入，渲染文本零命中', () => {
  // 故意把"机器痕迹"塞满每一个字段：只要客户端把 key/id/码拼进文本，这里必红。
  const raw = rowRaw({
    prior_rounds: [
      priorRoundRaw({
        interview_id: INT_1,
        slot_code: 'SLOT_1',
        interviewers: [
          {
            display_name: '演示-面试官',
            scorecard_state: 'SUBMITTED',
            scorecard_submitted: true,
            conclusion: 'ADVANCE',
            scorecard_id: SCORECARD,
            note: HASH_64,
          },
        ],
        covered_dimensions: [{ ...DIM_WORK, key: 'work_exists', assessment: 'MET', score: 4, payload_hash: HASH_64 }],
      }),
    ],
    reference_points: [
      referencePointRaw(),
      { point: '可以重点了解「有带团队经验」', why: '岗位标准里这一条权重较高（0.25）。', basis: { kind: 'RUBRIC_DIMENSION', ref: 'team_lead' } },
    ],
  })
  const row = normalizeInterviewRow(raw)
  assertClean(row)

  const lines = [
    ...row.priorRounds.flatMap((round) => priorRoundLines(round)),
    ...referencePointLines(row.referencePoints),
  ]
  assert.ok(lines.length >= 6, '渲染行数应覆盖两块卡')
  assertNoMachineIds(lines, '整条渲染链路')
  // 反向守卫：确实渲染出了人话（不是"全空所以通过"）。
  assert.ok(lines.join('\n').includes('第 1 轮'))
  assert.ok(lines.join('\n').includes('覆盖到的维度：'))
  assert.ok(lines.join('\n').includes('值得问的原因：'))
})

test('机检：未知枚举/未知原因码也不会被原样渲染（降级为中文"未提供"）', () => {
  const round = normalizePriorRounds([
    priorRoundRaw({
      status: 'TOTALLY_NEW_STATUS',
      interviewers: [{ display_name: '', scorecard_state: 'BRAND_NEW_STATE', scorecard_submitted: false, conclusion: 'ADVANCE' }],
      uncovered_dimensions: [{ ...DIM_EDU, reason: 'BRAND_NEW_REASON' }],
    }),
  ])[0]
  assert.ok(round !== undefined)
  const lines = priorRoundLines(round)
  assertNoMachineIds(lines, '未知枚举降级')
  assert.ok(lines.includes('面评：状态未提供'), `实际：${JSON.stringify(lines)}`)
  assert.ok(lines.some((line) => line.includes('原因未提供')), `实际：${JSON.stringify(lines)}`)
})

test('回归：既有的 rowStatus/requiredAction 之外，新字段不得改变既有归一化结果', () => {
  const before = normalizeInterviewRow(rowRaw({ prior_rounds: undefined, reference_points: undefined }))
  const after = normalizeInterviewRow(rowRaw())
  const { priorRounds: _beforePrior, referencePoints: _beforeRef, ...restBefore } = before as InterviewRow
  const { priorRounds: _afterPrior, referencePoints: _afterRef, ...restAfter } = after as InterviewRow
  assert.deepEqual(restAfter, restBefore)
})

/** 一个显式类型锚点：确保导出的视图类型在测试里可用（避免"只测了实现细节"）。 */
const _typeAnchors: readonly (PriorRoundView | ReferencePointView)[] = []
void _typeAnchors
