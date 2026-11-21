// =====================================================================
//  task-51「面试详情新增 prior_rounds + reference_points」：**纯函数单测**（零 DB）
//
//  被测（`src/http/interviewer.ts`，冻结于 `work/d5/interviewer-brief/DESIGN.md` §1）：
//    · `buildPriorRounds(facts)`        —— 紧邻上一轮的维度覆盖判定（DESIGN §1.1）
//    · `buildReferencePoints(facts)`    —— 本轮参考点 2–4 条（DESIGN §1.2）
//    · `renderTextViolations(text)`     —— D-141 渲染文本禁令的纯函数机检
//    · `toInterviewRow(input)`          —— 唯一组合点（既有字段不动，只加两个键）
//
//  覆盖（任务书 ①–⑧，逐组一个或多个 test）：
//    ① 当前轮 1 → prior_rounds=[]，且 reference_points 里零 PRIOR_GAP；
//    ② 上一轮无面评 / 只有草稿（PENDING）→ 全部 uncovered，reason=NO_SCORECARD；
//    ③ 草稿里的 MET 不算覆盖（PENDING 不是证据）；
//    ④ NOT_OBSERVED / UNREADABLE / 缺键 / items 脏分别给对 reason；
//    ⑤ MET / NOT_MET 进 covered 且 score 原样（1..5 整数之外 → null）；
//    ⑥ 多维 / 多面试官 union；同一轮多场按元素返回 + gap 按轮 union；
//    ⑦ 2–4 条上限、池子顺序、权重回退、去重与确定性（同输入两次同输出）；v2：维度 key 跨 kind
//       去重（PRIOR_GAP 出过的维度不再出 RUBRIC_DIMENSION）+ 有可用简历时维度类最多 3 条（留 1 个
//       名额给 RESUME_HIGHLIGHT），没有简历时维度类填满 4 条；
//    ⑧ 文案禁令机检（UUID / 64hex / 32+ hex / snake_case / 路径 / 机器码 /「必须|应该|务必」），
//       并证明中文标签里的「异步/队列」**不会**被误判成路径。
//
//  纪律：不连库、不 mock 时钟、不 import 任何 DB 代码；坏 jsonb 一律断言"不抛错且不编造"。
// =====================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPriorRounds,
  buildReferencePoints,
  renderTextViolations,
  toInterviewRow,
  type InterviewerReferencePoint,
  type InterviewerRow,
  type InterviewExtensionRow,
  type PriorRound,
  type PriorRoundDimension,
  type PriorRoundFacts,
  type PriorRoundRow,
  type ReferencePointDimension,
  type ReferencePointFacts,
} from '../../src/http/interviewer.ts'
import type { InterviewValue, InterviewerValue } from '../../src/tools/interview-get.ts'

// ---------------------------------------------------------------------------
//  夹具常量
// ---------------------------------------------------------------------------

const APPLICATION_ID = '11111111-1111-4111-8111-000000000701'
const CURRENT_ID = '11111111-1111-4111-8111-000000000e10'
const PRIOR_ID = '11111111-1111-4111-8111-000000000e01'
const PRIOR_ID_B = '11111111-1111-4111-8111-000000000e02'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const CANDIDATE_ID = '11111111-1111-4111-8111-000000000601'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const ACTOR_A = '11111111-1111-4111-8111-000000000104'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const INTERVIEWER_ROW_A = '11111111-1111-4111-8111-00000000c0a1'
const INTERVIEWER_ROW_B = '11111111-1111-4111-8111-00000000c0b1'
const SCORECARD_A = '11111111-1111-4111-8111-000000000a01'
const SCORECARD_B = '11111111-1111-4111-8111-000000000b01'

/**
 * 维度宇宙：**逐字取演示 rubric v1**（`0002_seed.sql` §5），其中 `async_pipeline` 的 label
 * 是「异步/队列流水线经验」—— 中文里的 `/` 不是路径，D-141 不得误判（§1.2 第 4 条）。
 */
const UNIVERSE: readonly PriorRoundDimension[] = [
  { key: 'backend_depth', label: '后端工程深度', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', weight: 0.2 },
]

/** 未在任何 dimensions 里被标重点的维度池（`focus=false, must_cover=false`）。 */
function plainUniverse(): ReferencePointDimension[] {
  return UNIVERSE.map((dimension) => ({ ...dimension, focus: false, must_cover: false }))
}

/** 一条上一轮的 SQL 行（默认：SUBMITTED / backend_depth=MET 4 / 结论 ADVANCE）。 */
function priorRow(overrides: Partial<PriorRoundRow> = {}): PriorRoundRow {
  return {
    current_interview_id: CURRENT_ID,
    prior_interview_id: PRIOR_ID,
    prior_round_no: 1,
    prior_status: 'POST_INTERVIEW',
    prior_slot_code: 'DEFAULT',
    prior_scheduled_start_at: new Date('2026-11-10T02:00:00.000Z'),
    interviewer_row_id: INTERVIEWER_ROW_A,
    interviewer_actor_id: ACTOR_A,
    interviewer_display_name: '演示-面试官',
    scorecard_id: SCORECARD_A,
    scorecard_status: 'SUBMITTED',
    scorecard_overall: 'ADVANCE',
    scorecard_items: { transcript_basis: 'TRANSCRIPT', backend_depth: { assessment: 'MET', score: 4 } },
    ...overrides,
  }
}

/** 一组"紧邻上一轮"的行 → `buildPriorRounds` 的入参（默认当前轮 2、维度宇宙可用）。 */
function priorFacts(
  rows: readonly PriorRoundRow[],
  overrides: {
    roundNo?: number
    dimensionsAvailable?: boolean
    dimensions?: readonly PriorRoundDimension[]
  } = {},
): PriorRoundFacts {
  return {
    round_no: overrides.roundNo ?? 2,
    dimensions_available: overrides.dimensionsAvailable ?? true,
    dimensions: overrides.dimensions ?? UNIVERSE.map((dimension) => ({ ...dimension })),
    rows,
  }
}

/** `buildReferencePoints` 的入参（默认：无前置轮次、无重点、无简历）。 */
function referenceFacts(options: {
  priorRounds?: readonly PriorRound[]
  dimensions?: readonly ReferencePointDimension[]
  resumeFields?: unknown
} = {}): ReferencePointFacts {
  return {
    prior_rounds: options.priorRounds ?? [],
    dimensions: options.dimensions ?? plainUniverse(),
    resume_fields: options.resumeFields ?? null,
  }
}

/** 只跑 `buildPriorRounds` 取第一个前置轮次（多数用例只有一场）。 */
function firstPriorRound(facts: PriorRoundFacts): PriorRound {
  const rounds = buildPriorRounds(facts)
  assert.ok(rounds.length > 0, '夹具必须造出至少一个前置轮次')
  return rounds[0] as PriorRound
}

/** 参考点的 `kind|ref` 列表（断言顺序用）。 */
function pointKeys(points: readonly InterviewerReferencePoint[]): string[] {
  return points.map((point) => `${point.basis.kind}|${point.basis.ref}`)
}

// ---------------------------------------------------------------------------
//  假 InterviewValue / 假扩展行（`toInterviewRow` 组合测试用；形状与既有单测同口径）
// ---------------------------------------------------------------------------

function interviewerValue(options: {
  actorId: string
  displayName?: string
  scorecard?: { id: string; status: string; revisionNo: number; transcriptBasis: string }
}): InterviewerValue {
  return {
    interviewer_id: `ivr-${options.actorId.slice(-4)}`,
    actor_id: options.actorId,
    display_name: options.displayName ?? `演示-面试官 ${options.actorId.slice(-3)}`,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: true,
    ...(options.scorecard === undefined ? {} : {
      scorecard: {
        scorecard_id: options.scorecard.id,
        status: options.scorecard.status,
        revision_no: options.scorecard.revisionNo,
        transcript_basis: options.scorecard.transcriptBasis,
      },
    }),
  }
}

function interviewValue(options: {
  roundNo?: number
  interviewers?: readonly InterviewerValue[]
} = {}): InterviewValue {
  return {
    id: CURRENT_ID,
    application_id: APPLICATION_ID,
    candidate_id: CANDIDATE_ID,
    job_id: JOB_ID,
    round_no: options.roundNo ?? 2,
    slot_code: 'DEFAULT',
    stage_code: 'INTERVIEW',
    status: 'SCHEDULED',
    record_version: 3,
    scheduled_start_at: '2026-11-12T02:00:00.000Z',
    scheduled_end_at: '2026-11-12T03:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Shanghai',
    status_changed_at: '2026-11-01T00:00:00.000Z',
    is_overdue_start: false,
    interviewers: options.interviewers ?? [
      interviewerValue({
        actorId: ACTOR_A,
        scorecard: { id: SCORECARD_A, status: 'PENDING', revisionNo: 1, transcriptBasis: 'UNKNOWN' },
      }),
    ],
    meeting_binding: { state: 'UNBOUND', count: 0, bindings: [] },
    transcript: { state: 'READY', reason_code: 'CANONICAL_STATUS', no_transcript: false },
    evaluation: {
      required_scorecards: 1,
      submitted: 0,
      waived: 0,
      pending: 1,
      evaluation_ready: false,
      blockers: [],
    },
    warnings: [],
  }
}

/** 假扩展行（默认：无模板 + 有 rubric 三维护 + 已解析简历 + 我自己的 SUBMITTED 面评列）。 */
function extensionRow(overrides: Partial<InterviewExtensionRow> = {}): InterviewExtensionRow {
  return {
    interview_id: CURRENT_ID,
    application_job_id: JOB_ID,
    candidate_display_name: '测试候选人',
    job_code: 'JOB-001',
    job_title: '后端工程师',
    template_version_id: null,
    template_objective: null,
    template_briefing_summary: null,
    template_focus: [],
    template_questions: [],
    template_payload_hash: null,
    pinned_rubric_version_id: RUBRIC_ID,
    rubric_version_id: RUBRIC_ID,
    rubric_payload_hash: 'a'.repeat(64),
    rubric_dimensions: [
      { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
      { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
      { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
    ],
    resume_version_id: '11111111-1111-4111-8111-000000000905',
    resume_parse_status: 'PARSED',
    resume_parser_name: 'pymupdf',
    resume_parser_version: '1.0.0',
    resume_content_sha256: 'b'.repeat(64),
    resume_parsed_fields: {
      fields: {
        work_experience: {
          state: 'present',
          entries: [
            { header_text: '2023.01-2024.12 | 某某公司 | 后端工程师', company: '某某公司', title: '后端工程师' },
            { header_text: '2021.03-2022.12 | 一家小公司', company: null, title: null },
          ],
        },
      },
    },
    scorecard_id: null,
    scorecard_record_version: null,
    scorecard_overall: null,
    ...overrides,
  }
}

function mapRowWithPrior(
  priorRoundRows: readonly PriorRoundRow[],
  options: { roundNo?: number; value?: InterviewValue; extension?: InterviewExtensionRow } = {},
): { row: InterviewerRow; issues: readonly string[] } {
  return toInterviewRow({
    value: options.value ?? interviewValue({ roundNo: options.roundNo ?? 2 }),
    extension: options.extension ?? extensionRow(),
    actorId: ACTOR_A,
    priorRoundRows,
  })
}

// =====================================================================
//  ① 当前轮 1 → prior_rounds=[]，reference_points 零 PRIOR_GAP
// =====================================================================

test('① 当前轮 1：prior_rounds=[]（误传上一轮行也不返回），reference_points 里零 PRIOR_GAP', () => {
  // 直接喂"上一轮"的行：round_no=1 时 buildPriorRounds 必须忽略它们（第 1 轮没有上一轮）。
  const rounds = buildPriorRounds(priorFacts([priorRow()], { roundNo: 1 }))
  assert.deepEqual(rounds, [])

  const points = buildReferencePoints(referenceFacts({
    priorRounds: rounds,
    resumeFields: { fields: { work_experience: { entries: [{ header_text: '没有展开的一段' }] } } },
  }))
  assert.deepEqual(points.map((point) => point.basis.kind).includes('PRIOR_GAP'), false, '第 1 轮不得出现 PRIOR_GAP')

  // 组合点：round 1 的行两字段恒为数组（不是 undefined）。
  const { row } = mapRowWithPrior([], { roundNo: 1 })
  assert.deepEqual(row.prior_rounds, [])
  assert.equal(row.reference_points.some((point) => point.basis.kind === 'PRIOR_GAP'), false)
  assert.ok(Array.isArray(row.reference_points))
})

// =====================================================================
//  ②③ 没面评 / 只有草稿 → 全部 uncovered NO_SCORECARD
// =====================================================================

test('② 上一轮没有面评（NONE）→ 三个维度全 uncovered 且 reason=NO_SCORECARD；面试官回显 NONE', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({ scorecard_id: null, scorecard_status: null, scorecard_overall: null, scorecard_items: null }),
  ]))
  assert.equal(round.dimensions_available, true)
  assert.deepEqual(round.covered_dimensions, [])
  assert.deepEqual(round.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]), [
    ['backend_depth', 'NO_SCORECARD'],
    ['async_pipeline', 'NO_SCORECARD'],
    ['frontend_basics', 'NO_SCORECARD'],
  ])
  assert.deepEqual(round.interviewers, [{
    display_name: '演示-面试官',
    scorecard_state: 'NONE',
    scorecard_submitted: false,
    conclusion: null,
  }])
})

test('③ 草稿 PENDING 里的 MET 不算覆盖（同 NO_SCORECARD）；WAIVED 也不算', () => {
  const draft = firstPriorRound(priorFacts([
    priorRow({
      scorecard_status: 'PENDING',
      scorecard_overall: null,
      scorecard_items: { backend_depth: { assessment: 'MET', score: 5 }, async_pipeline: { assessment: 'MET' } },
    }),
  ]))
  assert.deepEqual(draft.covered_dimensions, [])
  assert.deepEqual(draft.uncovered_dimensions.map((dimension) => dimension.reason), [
    'NO_SCORECARD', 'NO_SCORECARD', 'NO_SCORECARD',
  ])
  assert.equal(draft.interviewers[0]?.scorecard_state, 'PENDING')
  assert.equal(draft.interviewers[0]?.scorecard_submitted, false)
  assert.equal(draft.interviewers[0]?.conclusion, null)

  const waived = firstPriorRound(priorFacts([
    priorRow({
      scorecard_status: 'WAIVED',
      scorecard_overall: 'HOLD',
      scorecard_items: { backend_depth: { assessment: 'MET', score: 5 } },
    }),
  ]))
  assert.deepEqual(waived.covered_dimensions, [])
  assert.deepEqual(waived.uncovered_dimensions.map((dimension) => dimension.reason), [
    'NO_SCORECARD', 'NO_SCORECARD', 'NO_SCORECARD',
  ])
  assert.equal(waived.interviewers[0]?.scorecard_state, 'WAIVED')
  assert.equal(waived.interviewers[0]?.conclusion, null, '豁免不显示结论')
})

// =====================================================================
//  ④ 逐维 reason：NOT_OBSERVED / UNREADABLE / 缺键 / items 脏
// =====================================================================

test('④ NOT_OBSERVED / UNREADABLE / 缺键 分别给对 reason（同一份面评里逐个维度）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      scorecard_items: {
        transcript_basis: 'TRANSCRIPT',
        backend_depth: { assessment: 'MET', score: 4 },
        async_pipeline: { assessment: 'NOT_OBSERVED' },
      },
    }),
  ]))
  assert.deepEqual(round.covered_dimensions.map((dimension) => [dimension.key, dimension.assessment, dimension.score]), [
    ['backend_depth', 'MET', 4],
  ])
  const byKey = new Map(round.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]))
  assert.equal(byKey.get('async_pipeline'), 'NOT_OBSERVED')
  assert.equal(byKey.get('frontend_basics'), 'NOT_RATED', '键在所有 SUBMITTED 面评里都缺 → NOT_RATED')
  assert.equal(byKey.get('backend_depth'), undefined, 'MET 必须进 covered，不能同时进 uncovered')

  const unreadable = firstPriorRound(priorFacts([
    priorRow({ scorecard_items: { transcript_basis: 'TRANSCRIPT', async_pipeline: { assessment: 'UNREADABLE' } } }),
  ]))
  assert.equal(
    unreadable.uncovered_dimensions.find((dimension) => dimension.key === 'async_pipeline')?.reason,
    'UNREADABLE',
  )
})

test('④ items 不是对象 → NO_ITEMS；键值不是对象 / assessment 是契约外脏值 → UNREADABLE（不推测）', () => {
  const dirtyContainer = firstPriorRound(priorFacts([priorRow({ scorecard_items: 'NOT_A_JSON_OBJECT' })]))
  assert.deepEqual(dirtyContainer.uncovered_dimensions.map((dimension) => dimension.reason), [
    'NO_ITEMS', 'NO_ITEMS', 'NO_ITEMS',
  ])

  const dirtyValue = firstPriorRound(priorFacts([
    priorRow({ scorecard_items: { transcript_basis: 'TRANSCRIPT', backend_depth: 'MET' } }),
  ]))
  assert.deepEqual(dirtyValue.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]), [
    ['backend_depth', 'UNREADABLE'],
    ['async_pipeline', 'NOT_RATED'],
    ['frontend_basics', 'NOT_RATED'],
  ])

  const dirtyAssessment = firstPriorRound(priorFacts([
    priorRow({ scorecard_items: { backend_depth: { assessment: 'MAYBE' } } }),
  ]))
  assert.equal(
    dirtyAssessment.uncovered_dimensions.find((dimension) => dimension.key === 'backend_depth')?.reason,
    'UNREADABLE',
  )
})

// =====================================================================
//  ⑤ MET / NOT_MET → covered + score 原值（1..5 整数之外 → null）
// =====================================================================

test('⑤ MET / NOT_MET 进 covered，score 只在 1..5 整数时原样带上（其余 null）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      scorecard_items: {
        transcript_basis: 'NO_TRANSCRIPT',
        backend_depth: { assessment: 'MET', score: 4 },
        async_pipeline: { assessment: 'NOT_MET', score: 2 },
        frontend_basics: { assessment: 'MET', score: 7 },
      },
    }),
  ]))
  assert.deepEqual(round.covered_dimensions, [
    { key: 'backend_depth', label: '后端工程深度', weight: 0.5, assessment: 'MET', score: 4 },
    { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.3, assessment: 'NOT_MET', score: 2 },
    { key: 'frontend_basics', label: '基本前端能力', weight: 0.2, assessment: 'MET', score: null },
  ])
  assert.deepEqual(round.uncovered_dimensions, [])

  const noScore = firstPriorRound(priorFacts([
    priorRow({
      scorecard_items: {
        backend_depth: { assessment: 'NOT_MET' },
        async_pipeline: { assessment: 'MET', score: 3.5 },
        frontend_basics: { assessment: 'MET', score: '5' },
      },
    }),
  ]))
  assert.deepEqual(
    noScore.covered_dimensions.map((dimension) => [dimension.key, dimension.assessment, dimension.score]),
    [['backend_depth', 'NOT_MET', null], ['async_pipeline', 'MET', null], ['frontend_basics', 'MET', null]],
  )
})

// =====================================================================
//  ⑥ union（多面试官 / 同一轮多场）
// =====================================================================

test('⑥ 多面试官 union：任一 SUBMITTED 覆盖即 covered；两人都判时取面评顺序第一条（不调和）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      interviewer_row_id: INTERVIEWER_ROW_A,
      interviewer_actor_id: ACTOR_A,
      interviewer_display_name: '演示-面试官A',
      scorecard_id: SCORECARD_A,
      scorecard_items: { backend_depth: { assessment: 'MET', score: 4 } },
    }),
    priorRow({
      interviewer_row_id: INTERVIEWER_ROW_B,
      interviewer_actor_id: ACTOR_B,
      interviewer_display_name: '演示-面试官B',
      scorecard_id: SCORECARD_B,
      scorecard_items: {
        backend_depth: { assessment: 'NOT_MET', score: 2 },
        async_pipeline: { assessment: 'NOT_MET', score: 1 },
      },
    }),
  ]))
  assert.deepEqual(round.interviewers.map((interviewer) => [interviewer.display_name, interviewer.scorecard_state]), [
    ['演示-面试官A', 'SUBMITTED'],
    ['演示-面试官B', 'SUBMITTED'],
  ])
  assert.deepEqual(
    round.covered_dimensions.map((dimension) => [dimension.key, dimension.assessment, dimension.score]),
    [
      ['backend_depth', 'MET', 4],
      ['async_pipeline', 'NOT_MET', 1],
    ],
  )
  assert.deepEqual(round.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]), [
    ['frontend_basics', 'NOT_RATED'],
  ])
})

test('⑥ 同一轮多场：每场一个元素（slot_code 顺序保持 SQL 顺序）；PRIOR_GAP 按"轮" union', () => {
  const rounds = buildPriorRounds(priorFacts([
    priorRow({
      prior_interview_id: PRIOR_ID,
      prior_slot_code: 'DEFAULT',
      scorecard_items: { backend_depth: { assessment: 'MET', score: 4 } },
    }),
    priorRow({
      prior_interview_id: PRIOR_ID_B,
      prior_slot_code: 'MANAGER',
      interviewer_row_id: INTERVIEWER_ROW_B,
      interviewer_actor_id: ACTOR_B,
      scorecard_id: SCORECARD_B,
      scorecard_items: { async_pipeline: { assessment: 'NOT_MET', score: 2 } },
    }),
  ]))
  assert.deepEqual(rounds.map((round) => [round.interview_id, round.slot_code]), [
    [PRIOR_ID, 'DEFAULT'],
    [PRIOR_ID_B, 'MANAGER'],
  ])
  // 场 1 只覆盖 backend；场 2 只覆盖 async —— frontend 两场都没覆盖，才是这一轮的 gap。
  assert.deepEqual(rounds[0]?.covered_dimensions.map((dimension) => dimension.key), ['backend_depth'])
  assert.deepEqual(rounds[1]?.covered_dimensions.map((dimension) => dimension.key), ['async_pipeline'])

  const points = buildReferencePoints(referenceFacts({ priorRounds: rounds }))
  const gaps = points.filter((point) => point.basis.kind === 'PRIOR_GAP')
  assert.deepEqual(gaps.map((point) => point.basis.ref), ['frontend_basics'], '按轮 union：只有 frontend_basics 是 gap')
  assert.equal(gaps[0]?.point, '上一轮没有覆盖到「基本前端能力」')
})

test('⑥ 结论只在 SUBMITTED 时给；显示名缺失 → 空串（不编造）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      interviewer_display_name: null,
      scorecard_status: 'SUBMITTED',
      scorecard_overall: 'HOLD',
      scorecard_items: {},
    }),
  ]))
  assert.deepEqual(round.interviewers, [{
    display_name: '',
    scorecard_state: 'SUBMITTED',
    scorecard_submitted: true,
    conclusion: 'HOLD',
  }])
})

// =====================================================================
//  维度宇宙不可用 / 只看紧邻上一轮 / 元素字段原样透传
// =====================================================================

test('dimensions_available=false（岗位 rubric 读不到）→ 两个数组空、不判定；面试官事实仍回显', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({ scorecard_items: { backend_depth: { assessment: 'MET', score: 4 } } }),
  ], { dimensionsAvailable: false }))
  assert.equal(round.dimensions_available, false)
  assert.deepEqual(round.covered_dimensions, [], '不可用时不判定覆盖（两个数组都空）')
  assert.deepEqual(round.uncovered_dimensions, [], '不可用时不推测哪些维度没覆盖')
  assert.deepEqual(round.interviewers.map((interviewer) => interviewer.scorecard_state), ['SUBMITTED'])

  const points = buildReferencePoints(referenceFacts({ priorRounds: [round] }))
  assert.equal(points.some((point) => point.basis.kind === 'PRIOR_GAP'), false, '维度读不到时不得凭空说"上一轮没覆盖"')
})

test('元素字段原样透传（status/slot_code/时间/round_no）；非紧邻轮次的误传行被丢弃', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({ prior_scheduled_start_at: '2026-11-10T02:00:00.000Z' }),
    // 误传的"更早一轮"：currentRound=2 时它不该出现（只看紧邻上一轮）。
    priorRow({ prior_interview_id: '11111111-1111-4111-8111-000000000eff', prior_round_no: 0 }),
  ]))
  assert.equal(round.round_no, 1)
  assert.equal(round.status, 'POST_INTERVIEW')
  assert.equal(round.slot_code, 'DEFAULT')
  assert.equal(round.scheduled_start_at, '2026-11-10T02:00:00.000Z')
})

test('prior_scheduled_start_at 脏值 → null（不抛错）；round_no 缺失时回退到当前轮 - 1', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({ prior_scheduled_start_at: 'not-a-date' }),
  ]))
  assert.equal(round.scheduled_start_at, null)
  assert.equal(round.round_no, 1)
  assert.equal(
    buildPriorRounds(priorFacts([priorRow({ prior_round_no: 1 })], { roundNo: 3 })).length,
    0,
    'currentRound=3 时 round_no=2 才是紧邻上一轮，round_no=1 的行必须被丢弃',
  )
})

// =====================================================================
//  ⑦ reference_points：池子顺序 / 上限 / 权重回退 / 去重 / 确定性 / 不足如实少给
// =====================================================================

test('⑦ 池子顺序 PRIOR_GAP → RUBRIC_DIMENSION → RESUME_HIGHLIGHT，上限 4 条；有简历时维度类最多 3 条', () => {
  // 上一轮一个维度都没覆盖（NO_SCORECARD）→ 3 个 gap，但 PRIOR_GAP 最多 2 条。
  const round = firstPriorRound(priorFacts([
    priorRow({ scorecard_id: null, scorecard_status: null, scorecard_items: null }),
  ]))
  const points = buildReferencePoints(referenceFacts({
    priorRounds: [round],
    resumeFields: { fields: { work_experience: { entries: [{ header_text: '只有一行摘要的经历' }] } } },
  }))
  assert.equal(points.length, 4, '上限 4 条（20 → 截断）')
  assert.deepEqual(pointKeys(points), [
    'PRIOR_GAP|backend_depth',
    'PRIOR_GAP|async_pipeline',
    // backend/async 已经是 PRIOR_GAP → 不再出 RUBRIC_DIMENSION（维度 key 跨 kind 去重）；
    // 有可用简历 → 维度类只能占 3 条，第 4 条留给 RESUME_HIGHLIGHT。
    'RUBRIC_DIMENSION|frontend_basics',
    'RESUME_HIGHLIGHT|work_experience[0]',
  ])
})

test('⑦ v2 跨 kind 去重：同一维度出过 PRIOR_GAP 就不再出 RUBRIC_DIMENSION（每个维度最多一条）', () => {
  // 上一轮只覆盖 backend → gap = async, frontend；本轮无重点 → 权重降序池 = 全部三维。
  const round = firstPriorRound(priorFacts([
    priorRow({ scorecard_items: { backend_depth: { assessment: 'MET', score: 4 } } }),
  ]))
  const points = buildReferencePoints(referenceFacts({ priorRounds: [round] }))
  assert.deepEqual(pointKeys(points), [
    'PRIOR_GAP|async_pipeline',
    'PRIOR_GAP|frontend_basics',
    'RUBRIC_DIMENSION|backend_depth',
  ], 'gap 维度不再重复出 RUBRIC_DIMENSION；没占满 4 条也如实少给')
  const refs = points.map((point) => point.basis.ref)
  assert.equal(new Set(refs).size, refs.length, '维度类 + 简历类的 ref 不重复（本组全是维度类）')
  // 把"同一维度两条"反证掉：async/frontend 都只有一条，且 kind=PRIOR_GAP。
  for (const key of ['async_pipeline', 'frontend_basics']) {
    const matched = points.filter((point) => point.basis.ref === key)
    assert.equal(matched.length, 1)
    assert.equal(matched[0]?.basis.kind, 'PRIOR_GAP')
  }
})

test('⑦ v2 简历名额保留：有可用未展开经历 → 3 条维度类 + 1 条简历类；没有简历 → 维度类填满 4 条', () => {
  const fourDimensions: ReferencePointDimension[] = [
    { key: 'd1', label: '维度一', weight: 0.4, focus: false, must_cover: false },
    { key: 'd2', label: '维度二', weight: 0.3, focus: false, must_cover: false },
    { key: 'd3', label: '维度三', weight: 0.2, focus: false, must_cover: false },
    { key: 'd4', label: '维度四', weight: 0.1, focus: false, must_cover: false },
  ]
  const withResume = buildReferencePoints(referenceFacts({
    dimensions: fourDimensions,
    resumeFields: { fields: { work_experience: { entries: [{ header_text: '只有一行摘要的经历' }] } } },
  }))
  assert.deepEqual(pointKeys(withResume), [
    'RUBRIC_DIMENSION|d1',
    'RUBRIC_DIMENSION|d2',
    'RUBRIC_DIMENSION|d3',
    'RESUME_HIGHLIGHT|work_experience[0]',
  ], '有简历 → 维度类封顶 3 条，第 4 条是简历（不能把简历挤掉）')

  const withoutResume = buildReferencePoints(referenceFacts({ dimensions: fourDimensions }))
  assert.deepEqual(pointKeys(withoutResume), [
    'RUBRIC_DIMENSION|d1',
    'RUBRIC_DIMENSION|d2',
    'RUBRIC_DIMENSION|d3',
    'RUBRIC_DIMENSION|d4',
  ], '没有可用简历 → 维度类填满 4 条（名额不空转）')
})

test('⑦ v2 简历文案命中 D-141 → 该条不可用、不留名额（维度类仍填满 4 条）', () => {
  const fourDimensions: ReferencePointDimension[] = [
    { key: 'd1', label: '维度一', weight: 0.4, focus: false, must_cover: false },
    { key: 'd2', label: '维度二', weight: 0.3, focus: false, must_cover: false },
    { key: 'd3', label: '维度三', weight: 0.2, focus: false, must_cover: false },
    { key: 'd4', label: '维度四', weight: 0.1, focus: false, must_cover: false },
  ]
  const points = buildReferencePoints(referenceFacts({
    dimensions: fourDimensions,
    resumeFields: {
      fields: { work_experience: { entries: [{ header_text: 'backend_depth 必须确认的一段经历' }] } },
    },
  }))
  assert.deepEqual(pointKeys(points), [
    'RUBRIC_DIMENSION|d1',
    'RUBRIC_DIMENSION|d2',
    'RUBRIC_DIMENSION|d3',
    'RUBRIC_DIMENSION|d4',
  ], '简历条目文案不合规 → 不出该条，也不占名额（维度类填满）')
})

test('⑦ focus/must_cover 优先且按原顺序；一个都没有时按 weight desc（同权重保持原顺序）', () => {
  const dimensions: ReferencePointDimension[] = [
    { key: 'backend_depth', label: '后端工程深度', weight: 0.2, focus: false, must_cover: false },
    { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.5, focus: true, must_cover: false },
    { key: 'frontend_basics', label: '基本前端能力', weight: 0.3, focus: false, must_cover: true },
  ]
  const focused = buildReferencePoints(referenceFacts({ dimensions }))
  assert.deepEqual(pointKeys(focused), [
    'RUBRIC_DIMENSION|async_pipeline',
    'RUBRIC_DIMENSION|frontend_basics',
  ], 'focus||must_cover 的维度按原顺序；只说重点，不补非重点')
  assert.equal(focused[0]?.why, '岗位标准里有这一条（权重 0.5），本轮轮次配置把它标为重点。')
  assert.equal(focused[1]?.why, '岗位标准里有这一条（权重 0.3），本轮轮次配置把它标为重点。')

  const plain: ReferencePointDimension[] = [
    { key: 'backend_depth', label: '后端工程深度', weight: 0.2, focus: false, must_cover: false },
    { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.5, focus: false, must_cover: false },
    { key: 'frontend_basics', label: '基本前端能力', weight: 0.5, focus: false, must_cover: false },
  ]
  const byWeight = buildReferencePoints(referenceFacts({ dimensions: plain }))
  assert.deepEqual(pointKeys(byWeight), [
    'RUBRIC_DIMENSION|async_pipeline',
    'RUBRIC_DIMENSION|frontend_basics',
    'RUBRIC_DIMENSION|backend_depth',
  ], 'weight desc；同权重（0.5 vs 0.5）保持原顺序')
  assert.equal(byWeight[0]?.why, '岗位标准里这一条权重较高（0.5），前面的轮次还没有聊到这一条，材料里也没有对应的原文。')
})

test('⑦ 同 kind|ref 去重（多行重复喂同一维度 key 只出一条）；不足 2 条如实少给（不编造）', () => {
  // 同一场两个面试官都判了 backend_depth 未覆盖？不会（union）——这里用"两个前置元素"制造重复 ref：
  const roundA = buildPriorRounds(priorFacts([
    priorRow({ prior_interview_id: PRIOR_ID, scorecard_status: 'PENDING', scorecard_items: null }),
  ]))[0] as PriorRound
  const roundB = buildPriorRounds(priorFacts([
    priorRow({ prior_interview_id: PRIOR_ID_B, prior_slot_code: 'MANAGER', scorecard_status: 'PENDING', scorecard_items: null }),
  ]))[0] as PriorRound
  const points = buildReferencePoints(referenceFacts({ priorRounds: [roundA, roundB] }))
  const gapKeys = points.filter((point) => point.basis.kind === 'PRIOR_GAP').map((point) => point.basis.ref)
  assert.deepEqual(gapKeys, ['backend_depth', 'async_pipeline'], '同一个 gap 只出现一次；PRIOR_GAP 上限 2 条')

  // 空池 → 0 条（如实少给，不编造）。
  assert.deepEqual(buildReferencePoints(referenceFacts({ dimensions: [] })), [])
  // 只有一条简历经历 → 1 条。
  const resumeOnly = buildReferencePoints(referenceFacts({
    dimensions: [],
    resumeFields: { fields: { work_experience: { entries: [{ header_text: '只有一行摘要的经历' }] } } },
  }))
  assert.equal(resumeOnly.length, 1)
  assert.equal(resumeOnly[0]?.basis.kind, 'RESUME_HIGHLIGHT')
})

test('⑦ 确定性：同一输入两次输出逐字相同（含多元素排序与原因选择）', () => {
  const rows = [
    priorRow({
      interviewer_row_id: INTERVIEWER_ROW_A,
      scorecard_items: { backend_depth: { assessment: 'NOT_OBSERVED' }, async_pipeline: { assessment: 'UNREADABLE' } },
    }),
    priorRow({
      interviewer_row_id: INTERVIEWER_ROW_B,
      interviewer_actor_id: ACTOR_B,
      scorecard_id: SCORECARD_B,
      scorecard_items: { backend_depth: { assessment: 'UNREADABLE' }, async_pipeline: { assessment: 'UNREADABLE' } },
    }),
  ]
  const once = buildReferencePoints(referenceFacts({ priorRounds: buildPriorRounds(priorFacts(rows)) }))
  const twice = buildReferencePoints(referenceFacts({ priorRounds: buildPriorRounds(priorFacts(rows)) }))
  assert.deepEqual(once, twice)
  assert.equal(JSON.stringify(once), JSON.stringify(twice))
  // backend_depth 两个面试官一个 NOT_OBSERVED 一个 UNREADABLE → 取更"有观察"的 NOT_OBSERVED（稳定）。
  assert.equal(once[0]?.why.includes('上一轮没有观察到这一维'), true)
})

// =====================================================================
//  ⑧ D-141 文案禁令机检 + 逐字文案
// =====================================================================

test('⑧ renderTextViolations：UUID / 64hex / 32+ hex / snake_case / 路径 / 机器码 / 指令措辞 都能检出', () => {
  assert.deepEqual(renderTextViolations(`面试 ${'11111111-1111-4111-8111-000000000104'} 已提交`), ['UUID'])
  assert.deepEqual(renderTextViolations(`哈希 ${'a'.repeat(64)}`), ['64HEX', 'LONG_HEX'])
  assert.deepEqual(renderTextViolations(`摘要 ${'b'.repeat(32)}`), ['LONG_HEX'])
  assert.deepEqual(renderTextViolations('维度 backend_depth 没评'), ['SNAKE_CASE'])
  assert.deepEqual(renderTextViolations('见 src/http/interviewer.ts'), ['PATH'])
  assert.deepEqual(renderTextViolations('结论是 ADVANCE'), ['MACHINE_CODE'])
  assert.deepEqual(renderTextViolations('维度判定 NOT_OBSERVED'), ['MACHINE_CODE'])
  for (const wording of ['必须确认', '应该先问', '务必补齐', '一定要问', '按顺序问', '先问 A 再问 B']) {
    assert.deepEqual(renderTextViolations(wording), ['INSTRUCTIONAL_WORDING'], `${wording} 必须命中指令措辞禁令`)
  }
  // 干净的中文（含演示 rubric 真实标签里的「异步/队列」）不得误判。
  assert.deepEqual(renderTextViolations('上一轮没有覆盖到「异步/队列流水线经验」'), [])
  assert.deepEqual(renderTextViolations('岗位标准里有这一条（权重 0.3），本轮轮次配置把它标为重点。'), [])
})

test('⑧ 生成的 point/why 全部合规；含 snake_case 的脏标签 → 跳过该条（宁缺不脏）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({ scorecard_status: 'PENDING', scorecard_items: null }),
  ]))
  const points = buildReferencePoints(referenceFacts({
    priorRounds: [round],
    resumeFields: { fields: { work_experience: { entries: [{ header_text: '只有一行摘要的经历' }] } } },
  }))
  assert.ok(points.length >= 2)
  for (const point of points) {
    assert.deepEqual(renderTextViolations(point.point), [], `point 命中禁令：${point.point}`)
    assert.deepEqual(renderTextViolations(point.why), [], `why 命中禁令：${point.why}`)
  }

  // 脏标签（字段名/机器码）只允许活在结构化 key 里，绝不能被渲染成文案。
  const hostileDimensions: ReferencePointDimension[] = [
    { key: 'backend_depth', label: 'backend_depth', weight: 0.5, focus: false, must_cover: false },
    { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.3, focus: false, must_cover: false },
    { key: 'frontend_basics', label: '基本前端能力', weight: 0.2, focus: false, must_cover: false },
  ]
  const hostile = buildReferencePoints(referenceFacts({ dimensions: hostileDimensions }))
  assert.deepEqual(pointKeys(hostile), [
    'RUBRIC_DIMENSION|async_pipeline',
    'RUBRIC_DIMENSION|frontend_basics',
  ], 'snake_case 标签那条被跳过，其余照常')
})

test('⑧ 文案逐字：PRIOR_GAP / RUBRIC_DIMENSION 两个分支 / RESUME_HIGHLIGHT（DESIGN §1.2）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      scorecard_items: {
        transcript_basis: 'TRANSCRIPT',
        backend_depth: { assessment: 'MET', score: 4 },
        async_pipeline: { assessment: 'NOT_OBSERVED' },
      },
    }),
  ]))
  const gapPoints = buildReferencePoints(referenceFacts({ priorRounds: [round] }))
    .filter((point) => point.basis.kind === 'PRIOR_GAP')
  assert.deepEqual(gapPoints.map((point) => point.point), [
    '上一轮没有覆盖到「异步/队列流水线经验」',
    '上一轮没有覆盖到「基本前端能力」',
  ])
  assert.deepEqual(gapPoints.map((point) => point.why), [
    '岗位标准里有这一条（权重 0.3），但上一轮的面评没有给出这一维的评价（上一轮没有观察到这一维）。这一轮可以自己确认一下。',
    '岗位标准里有这一条（权重 0.2），但上一轮的面评没有给出这一维的评价（上一轮的面评里没有这一维）。这一轮可以自己确认一下。',
  ])

  const resumePoints = buildReferencePoints(referenceFacts({
    dimensions: [],
    resumeFields: {
      fields: {
        work_experience: {
          entries: [
            { header_text: '2021.03-2022.12 | 一家小公司', company: null, title: null },
            { header_text: '2019.01-2020.12 | 已拆开的经历', company: '某公司', title: '工程师' },
            { header_text: '只有一行摘要的经历', company: null, title: null },
          ],
        },
      },
    },
  }))
  assert.deepEqual(resumePoints, [{
    point: '简历里有一段没有展开的经历：2021.03-2022.12 | 一家小公司',
    why: '材料里这段经历只有一行摘要，没有写具体做法；可以参考它了解真实的技术选择。',
    basis: { kind: 'RESUME_HIGHLIGHT', ref: 'work_experience[0]' },
  }], '未展开 = header_text 非空且 title/company 都空；最多 1 条；ref 用 entries 数组下标')

  const noResume = buildReferencePoints(referenceFacts({
    dimensions: [],
    resumeFields: { fields: { work_experience: { entries: 'NOT_AN_ARRAY' } } },
  }))
  assert.deepEqual(noResume, [], '简历脏数据 → 空数组（不抛错、不编造）')
})

// =====================================================================
//  toInterviewRow 组合：两字段恒为数组；round 1 / round 2 行各自语义
// =====================================================================

test('toInterviewRow：round 1 行 → prior_rounds=[]；round 2 行从 priorRoundRows 组装 prior_rounds + reference_points', () => {
  // round 1：没有前置轮次。
  const round1 = mapRowWithPrior([], { roundNo: 1 }).row
  assert.deepEqual(round1.prior_rounds, [])
  assert.equal(round1.reference_points.some((point) => point.basis.kind === 'PRIOR_GAP'), false)

  // round 2：上一轮只覆盖 backend_depth；本轮无重点 → 参考点 = 2 个 gap + 权重降序。
  const priorRows = [
    priorRow({
      current_interview_id: CURRENT_ID,
      scorecard_items: {
        transcript_basis: 'TRANSCRIPT',
        backend_depth: { assessment: 'MET', score: 4 },
        async_pipeline: { assessment: 'NOT_OBSERVED' },
      },
      scorecard_overall: 'ADVANCE',
    }),
  ]
  const { row } = mapRowWithPrior(priorRows, { roundNo: 2 })
  assert.equal(row.prior_rounds.length, 1)
  assert.equal(row.prior_rounds[0]?.interview_id, PRIOR_ID)
  assert.equal(row.prior_rounds[0]?.round_no, 1)
  assert.deepEqual(row.prior_rounds[0]?.covered_dimensions.map((dimension) => dimension.key), ['backend_depth'])
  assert.deepEqual(
    row.prior_rounds[0]?.uncovered_dimensions.map((dimension) => [dimension.key, dimension.reason]),
    [['async_pipeline', 'NOT_OBSERVED'], ['frontend_basics', 'NOT_RATED']],
  )
  assert.deepEqual(pointKeys(row.reference_points), [
    'PRIOR_GAP|async_pipeline',
    'PRIOR_GAP|frontend_basics',
    // 维度 key 跨 kind 去重：async/frontend 已在 PRIOR_GAP 出现；backend 是唯一没占用的维度。
    'RUBRIC_DIMENSION|backend_depth',
    // 有可用简历条目 → 维度类 3 条封顶，第 4 条是简历（extension 夹具里 entries[1] 未展开）。
    'RESUME_HIGHLIGHT|work_experience[1]',
  ])
  // 既有字段语义不变（这里做一次最小回归：两字段之外的行为没被改写）。
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.effective_rubric.available, true)
  assert.equal(row.brief.source, 'JOB_RUBRIC')
  assert.equal(row.scorecard.state, 'PENDING')
  assert.equal(row.required_action, 'SUBMIT_SCORECARD')
})

test('toInterviewRow：简历未解析（materials 不可用）→ 不产出 RESUME_HIGHLIGHT（不读半成品）', () => {
  const parsed = {
    fields: {
      work_experience: { entries: [{ header_text: '半成品里的一段经历', company: null, title: null }] },
    },
  }
  const unparsed = mapRowWithPrior([], {
    roundNo: 1,
    extension: extensionRow({ resume_parse_status: 'PENDING', resume_parsed_fields: parsed }),
  }).row
  assert.equal(unparsed.materials.available, false)
  assert.equal(unparsed.reference_points.some((point) => point.basis.kind === 'RESUME_HIGHLIGHT'), false)

  // 解析成功时同一份字段会被用上（证明上面不是"永远没有"）。
  const parsedRow = mapRowWithPrior([], {
    roundNo: 1,
    extension: extensionRow({ resume_parsed_fields: parsed }),
  }).row
  assert.equal(parsedRow.materials.available, true)
  assert.equal(parsedRow.reference_points.some((point) => point.basis.kind === 'RESUME_HIGHLIGHT'), true)
  const highlight = parsedRow.reference_points.find((point) => point.basis.kind === 'RESUME_HIGHLIGHT')
  assert.equal(highlight?.basis.ref, 'work_experience[0]')
})

test('toInterviewRow：dimensions_available=false（rubric 越界）→ prior_rounds 不判定、reference_points 无 PRIOR_GAP', () => {
  const { row, issues } = mapRowWithPrior([priorRow()], {
    roundNo: 2,
    extension: extensionRow({
      // 钉住了 rubric 但 join 不上（越界）→ effective_rubric.available=false。
      pinned_rubric_version_id: RUBRIC_ID,
      rubric_version_id: null,
      rubric_dimensions: null,
    }),
  })
  assert.equal(row.effective_rubric.available, false)
  assert.equal(row.prior_rounds.length, 1)
  assert.equal(row.prior_rounds[0]?.dimensions_available, false)
  assert.deepEqual(row.prior_rounds[0]?.covered_dimensions, [])
  assert.deepEqual(row.prior_rounds[0]?.uncovered_dimensions, [])
  assert.equal(row.reference_points.some((point) => point.basis.kind === 'PRIOR_GAP'), false)
  assert.ok(issues.some((issue) => issue.includes('rubric')), '越界仍由既有 issue 说明（行为不变）')
})

test('toInterviewRow：旧调用方不传 priorRoundRows → prior_rounds=[]（向后兼容，恒为数组不是 undefined）', () => {
  // 既有单测/其它宿主适配只传 {value, extension, actorId}：行为不得改变，两个新键仍是数组。
  const row = toInterviewRow({
    value: interviewValue({ roundNo: 2 }),
    extension: extensionRow(),
    actorId: ACTOR_A,
  }).row
  assert.deepEqual(row.prior_rounds, [])
  assert.ok(Array.isArray(row.reference_points))
  assert.equal(row.reference_points.some((point) => point.basis.kind === 'PRIOR_GAP'), false)
})

test('单独验证 buildPriorRounds 不读取 note / rationale（输出里没有这些键）', () => {
  const round = firstPriorRound(priorFacts([
    priorRow({
      scorecard_items: {
        backend_depth: {
          assessment: 'NOT_MET',
          score: 2,
          note: '主观评语不该被投影',
          evidence: [{ quote: '同样不该出现' }],
        },
      },
      scorecard_overall: 'REJECT',
    }),
  ]))
  const serialized = JSON.stringify(round)
  assert.equal(serialized.includes('主观评语'), false, '不得把 items[*].note 抄进投影')
  assert.equal(serialized.includes('同样不该出现'), false, '不得把 items[*].evidence 抄进投影')
  assert.deepEqual(round.covered_dimensions.map((dimension) => [dimension.key, dimension.assessment, dimension.score]), [
    ['backend_depth', 'NOT_MET', 2],
  ])
})
