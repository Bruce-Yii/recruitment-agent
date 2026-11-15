// =====================================================================
//  task-50 轮次级评分标准与考察重点：**纯函数单测**（零 DB，`node --test` 可跑）
//
//  被测：`src/http/interviewer.ts::toInterviewRow({value, extension, actorId})`
//        —— 一个面试元素的行映射（含新增的 `round_focus` / `effective_rubric` 两块）。
//
//  方式：直接用假 `InterviewValue`（`readInterviewValue()` 的公开类型）+ 假扩展行
//        （`InterviewExtensionRow`，**按 owner-round 冻结的实现口径逐字造字段**）喂纯函数，
//        不连库、不 mock 时钟、不 import 任何 DB 代码。两个 actor 都出现，证明"只挑自己那一行"。
//
//  覆盖（任务书 A–G，逐组一个或多个 test）：
//    A 两轮不同模板配置 → 两行 round_focus/effective_rubric 不同（重点 key、问题、必覆盖、
//      scorecard.scale 多处差异），source=ROUND_OVERRIDE，focus/must_cover 标记正确，
//      submission.dimension_keys 恒 = 申请钉住 rubric 全部 key 且顺序一致。
//    B 无模板 → JOB_BASE 降级：available=false / 三个数组空 / title/description null / reason 非空；
//      effective_rubric.dimensions 全 focus=false、must_cover=false、origin=JOB_BASE、required=true；
//      scorecard.fields=全部 base 维度、scale=null；submission 键集正确。
//    C 模板 job 与申请 job 不符 / 模板 round_no 与面试不符 → 不套用（JOB_BASE）+ issues 非空，
//      且不泄露轮次模板的 focus 文本；模板版本信息**回显**（能显示"绑了哪个模板但没用"）。
//    D 模板声明不同的 rubric_version_id → 维度宇宙仍是申请钉住 rubric（不变），
//      declared_round_rubric_version_id 如实回显，reason/issues 写明冲突，submission.rubric_version_id 仍是 base。
//    E focus_attributes 含岗 rubric 没有的 key → 进 round_focus.focus_dimensions（in_rubric=false），
//      **不**进 effective_rubric.dimensions，issues 有说明。
//    F 越权/不泄露：interviewers[] 找不到当前 actor → NOT_FOUND(INTERVIEWER_ROW_MISSING)；
//      申请钉住 rubric 不属于该申请岗位（pinned 越界）→ effective_rubric.available=false，不把
//      别的岗位维度当作可用 schema。
//    G jsonb 容错：focus_attributes 是字符串/畸形数组、feedback_form 缺失/脏值时不抛错、不编造
//      （questions 空、scale null）。
//
//  纪律：本文件**不**放宽任何断言；所有"降级/不套用"都同时断言"没有泄露别处内容"。
// =====================================================================
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  toInterviewRow,
  type InterviewExtensionRow,
  type InterviewerRow,
  type ToInterviewRowInput,
} from '../../src/http/interviewer.ts'
import type { InterviewValue, InterviewerValue } from '../../src/tools/interview-get.ts'

// ---------------------------------------------------------------------------
//  夹具常量
// ---------------------------------------------------------------------------

const TENANT_ID = '11111111-1111-4111-8111-000000000001'
const INTERVIEW_ID = '11111111-1111-4111-8111-000000000e01'
const APPLICATION_ID = '11111111-1111-4111-8111-000000000701'
const CANDIDATE_ID = '11111111-1111-4111-8111-000000000601'
const JOB_ID = '11111111-1111-4111-8111-000000000401'
const OTHER_JOB_ID = '11111111-1111-4111-8111-0000000004ff'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const OTHER_RUBRIC_ID = '11111111-1111-4111-8111-0000000004fe'
const TEMPLATE_R1 = '11111111-1111-4111-8111-000000000f01'
const TEMPLATE_R2 = '11111111-1111-4111-8111-000000000f02'
const ACTOR_A = '11111111-1111-4111-8111-000000000104'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const SCORECARD_A = '11111111-1111-4111-8111-000000000a01'
const SCORECARD_B = '11111111-1111-4111-8111-000000000b01'

const HASH_T1 = '1'.repeat(64)
const HASH_T2 = '2'.repeat(64)
const HASH_RUBRIC = 'a'.repeat(64)

/** 与演示 rubric v1 同形的三个 base 维度（`0002_seed.sql` §5）；backend_depth 自带 question。 */
const BASE_DIMENSIONS = [
  {
    key: 'backend_depth',
    label: '后端工程深度',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: 'base 维度自带的问题（来自申请钉住的 rubric）',
  },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/** 契约错误消息 `<CODE>: <compact-json>` → JSON 体（与集成测试同口径）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
//  假 InterviewValue（`readInterviewValue()` 的公开类型；两个 actor 都在）
// ---------------------------------------------------------------------------

function interviewerValue(options: {
  actorId: string
  requiredScorecard?: boolean
  scorecard?: { id: string; status: string; revisionNo: number; submittedAt?: string; transcriptBasis: string }
}): InterviewerValue {
  return {
    interviewer_id: `ivr-${options.actorId.slice(-4)}`,
    actor_id: options.actorId,
    display_name: `演示-面试官 ${options.actorId.slice(-3)}`,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: options.requiredScorecard ?? true,
    ...(options.scorecard === undefined ? {} : {
      scorecard: {
        scorecard_id: options.scorecard.id,
        status: options.scorecard.status,
        revision_no: options.scorecard.revisionNo,
        ...(options.scorecard.submittedAt === undefined ? {} : { submitted_at: options.scorecard.submittedAt }),
        transcript_basis: options.scorecard.transcriptBasis,
      },
    }),
  }
}

/** 假 `InterviewValue`（默认 round_no=1，两个面试官都有面评）。 */
function interviewValue(overrides: {
  roundNo?: number
  interviewers?: readonly InterviewerValue[]
  status?: string
} = {}): InterviewValue {
  return {
    id: INTERVIEW_ID,
    application_id: APPLICATION_ID,
    candidate_id: CANDIDATE_ID,
    job_id: JOB_ID,
    round_no: overrides.roundNo ?? 1,
    slot_code: 'DEFAULT',
    stage_code: 'INTERVIEW',
    status: overrides.status ?? 'SCHEDULED',
    record_version: 3,
    scheduled_start_at: '2026-11-10T02:00:00.000Z',
    scheduled_end_at: '2026-11-10T03:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Shanghai',
    status_changed_at: '2026-11-01T00:00:00.000Z',
    is_overdue_start: true,
    interviewers: overrides.interviewers ?? [
      interviewerValue({
        actorId: ACTOR_A,
        scorecard: {
          id: SCORECARD_A,
          status: 'SUBMITTED',
          revisionNo: 1,
          submittedAt: '2026-11-10T03:00:00.000Z',
          transcriptBasis: 'TRANSCRIPT',
        },
      }),
      interviewerValue({
        actorId: ACTOR_B,
        scorecard: { id: SCORECARD_B, status: 'PENDING', revisionNo: 1, transcriptBasis: 'UNKNOWN' },
      }),
    ],
    meeting_binding: { state: 'BOUND_ACTIVE', count: 1, bindings: [] },
    transcript: { state: 'READY', reason_code: 'CANONICAL_STATUS', no_transcript: false },
    evaluation: {
      required_scorecards: 1,
      submitted: 1,
      waived: 0,
      pending: 0,
      evaluation_ready: false,
      blockers: [],
    },
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
//  假扩展行（`InterviewExtensionRow`；含 task-50 新增字段，逐字按实现口径）
// ---------------------------------------------------------------------------

function extensionRow(overrides: Partial<InterviewExtensionRow> = {}): InterviewExtensionRow {
  return {
    interview_id: INTERVIEW_ID,
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
    rubric_payload_hash: HASH_RUBRIC,
    rubric_dimensions: BASE_DIMENSIONS.map((dimension) => ({ ...dimension })),
    resume_version_id: null,
    resume_parse_status: null,
    resume_parser_name: null,
    resume_parser_version: null,
    resume_content_sha256: null,
    resume_parsed_fields: null,
    scorecard_id: null,
    scorecard_record_version: null,
    scorecard_overall: null,
    // ---- task-50 新增（可选；旧假行不造也能跑） ----
    template_version_no: null,
    template_round_no: null,
    template_job_id: null,
    template_feedback_form: null,
    template_declared_rubric_version_id: null,
    rubric_version_no: 1,
    ...overrides,
  }
}

/** 第 1 轮模板（两个重点；问题混合字符串/对象；feedback_form 含非 rubric 字段；量表 1–5）。 */
function round1Extension(overrides: Partial<InterviewExtensionRow> = {}): InterviewExtensionRow {
  return extensionRow({
    template_version_id: TEMPLATE_R1,
    template_version_no: 3,
    template_round_no: 1,
    template_job_id: JOB_ID,
    template_objective: '第 1 轮：技术基础与后端工程深度',
    template_briefing_summary: '验证后端工程深度与异步/队列流水线经验，避免与第 2 轮重复。',
    template_focus: [
      {
        key: 'backend_depth',
        label: '后端工程深度',
        weight: 0.5,
        required: true,
        must_cover: true,
        // 注意：focus_attributes 元素上的 question 不被读取（契约要求 effective 维度 question 来自 base rubric）
        question: '这条 focus question 不得出现在 effective_rubric.dimensions 里',
      },
      { key: 'async_pipeline', label: '异步/队列流水线经验', weight: 0.35, required: false, must_cover: true },
    ],
    template_questions: [
      '讲一个你设计过的分片方案。',
      { key: 'replay_failure', question: '消息重放/幂等你是怎么处理的？' },
    ],
    template_feedback_form: {
      scale: { min: 1, max: 5 },
      fields: [
        { key: 'backend_depth', label: '后端工程深度', kind: 'DIMENSION', required: true },
        { key: 'extra_note', label: '补充说明（非 rubric 字段）', kind: 'TEXT', required: false },
      ],
    },
    template_payload_hash: HASH_T1,
    ...overrides,
  })
}

/** 第 2 轮模板（frontend_basics 重点但非必覆盖；问题不同；量表 2–10；版本号不同）。 */
function round2Extension(overrides: Partial<InterviewExtensionRow> = {}): InterviewExtensionRow {
  return extensionRow({
    template_version_id: TEMPLATE_R2,
    template_version_no: 1,
    template_round_no: 2,
    template_job_id: JOB_ID,
    template_objective: '第 2 轮：跨团队协作与取舍',
    template_briefing_summary: '验证真实冲突下的取舍依据，避免重复第 1 轮技术题。',
    template_focus: [
      { key: 'frontend_basics', label: '基本前端能力', weight: 0.2, required: false, must_cover: false },
    ],
    template_questions: [
      '讲一次你推翻自己技术方案的经历：依据是什么？',
      { key: 'conflict_tradeoff', question: '和合作方目标冲突时，你依据什么做取舍？' },
    ],
    template_feedback_form: {
      scale: { min: 2, max: 10 },
      fields: [{ key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true }],
    },
    template_payload_hash: HASH_T2,
    ...overrides,
  })
}

/** 调一次映射（默认 actor A 视角）。 */
function mapRow(overrides: {
  value?: InterviewValue
  extension?: InterviewExtensionRow
  actorId?: string
} = {}): { row: InterviewerRow; issues: readonly string[]; input: ToInterviewRowInput } {
  const input: ToInterviewRowInput = {
    value: overrides.value ?? interviewValue(),
    extension: overrides.extension ?? extensionRow(),
    actorId: overrides.actorId ?? ACTOR_A,
  }
  return { ...toInterviewRow(input), input }
}

/** 取某个 key 的 effective 维度（不存在即失败：断言不能静默跳过）。 */
function dimensionOf(row: InterviewerRow, key: string) {
  const found = row.effective_rubric.dimensions.find((dimension) => dimension.key === key)
  assert.ok(found !== undefined, `effective_rubric.dimensions 必须包含 ${key}`)
  return found
}

// =====================================================================
//  A. 两轮不同模板配置 → 两行 round_focus / effective_rubric 真实不同
// =====================================================================

test('A1 两轮不同模板：round_focus.source=ROUND_CONFIG、effective_rubric.source=ROUND_OVERRIDE，重点/问题/量表多处不同', () => {
  const first = mapRow({ value: interviewValue({ roundNo: 1 }), extension: round1Extension() }).row
  const second = mapRow({ value: interviewValue({ roundNo: 2 }), extension: round2Extension() }).row

  // --- 来源与轮次 ---
  assert.equal(first.round_focus.source, 'ROUND_CONFIG')
  assert.equal(second.round_focus.source, 'ROUND_CONFIG')
  assert.equal(first.round_focus.available, true)
  assert.equal(second.round_focus.available, true)
  assert.equal(first.round_focus.round_no, 1)
  assert.equal(second.round_focus.round_no, 2)
  assert.equal(first.effective_rubric.source, 'ROUND_OVERRIDE')
  assert.equal(second.effective_rubric.source, 'ROUND_OVERRIDE')
  assert.equal(first.effective_rubric.round_no, 1)
  assert.equal(second.effective_rubric.round_no, 2)

  // --- 模板版本回显（每个字段都要能对上） ---
  assert.equal(first.round_focus.template_version_id, TEMPLATE_R1)
  assert.equal(first.round_focus.template_version_no, 3)
  assert.equal(first.round_focus.template_payload_hash, HASH_T1)
  assert.equal(second.round_focus.template_version_id, TEMPLATE_R2)
  assert.equal(second.round_focus.template_version_no, 1)
  assert.equal(second.round_focus.template_payload_hash, HASH_T2)
  assert.equal(first.effective_rubric.template_version_id, TEMPLATE_R1)
  assert.equal(second.effective_rubric.template_version_id, TEMPLATE_R2)

  // --- 本轮重点：key 集合不同（不是"统一岗位 Rubric 了事"） ---
  assert.deepEqual(first.round_focus.focus_dimensions.map((item) => item.key), ['backend_depth', 'async_pipeline'])
  assert.deepEqual(second.round_focus.focus_dimensions.map((item) => item.key), ['frontend_basics'])
  // required 口径：required===true OR must_cover===true；两者都 false → false
  assert.deepEqual(first.round_focus.focus_dimensions.map((item) => item.required), [true, true])
  assert.deepEqual(second.round_focus.focus_dimensions.map((item) => item.required), [false])
  assert.deepEqual(first.round_focus.focus_dimensions.map((item) => item.in_rubric), [true, true])
  assert.deepEqual(second.round_focus.focus_dimensions.map((item) => item.in_rubric), [true])
  // 权重：轮次配置里有有限数值 weight 时用它的值（async_pipeline 0.35 ≠ base 0.3）
  assert.equal(first.round_focus.focus_dimensions[1]?.weight, 0.35)

  // --- 问题不同（字符串与对象混合；对象自带 key 原样回显，字符串 key=null） ---
  assert.deepEqual(first.round_focus.questions, [
    { key: null, text: '讲一个你设计过的分片方案。' },
    { key: 'replay_failure', text: '消息重放/幂等你是怎么处理的？' },
  ])
  assert.deepEqual(second.round_focus.questions, [
    { key: null, text: '讲一次你推翻自己技术方案的经历：依据是什么？' },
    { key: 'conflict_tradeoff', text: '和合作方目标冲突时，你依据什么做取舍？' },
  ])

  // --- 本轮评分表 schema：非 rubric 字段也原样保留（不裁剪） ---
  assert.deepEqual(first.round_focus.scorecard_fields, [
    { key: 'backend_depth', label: '后端工程深度', kind: 'DIMENSION', required: true },
    { key: 'extra_note', label: '补充说明（非 rubric 字段）', kind: 'TEXT', required: false },
  ])
  assert.deepEqual(second.round_focus.scorecard_fields, [
    { key: 'frontend_basics', label: '基本前端能力', kind: 'DIMENSION', required: true },
  ])

  // --- 标题/描述来自模板 objective / briefing.summary ---
  assert.equal(first.round_focus.title, '第 1 轮：技术基础与后端工程深度')
  assert.equal(first.round_focus.description, '验证后端工程深度与异步/队列流水线经验，避免与第 2 轮重复。')
  assert.equal(second.round_focus.title, '第 2 轮：跨团队协作与取舍')
  assert.equal(second.round_focus.description, '验证真实冲突下的取舍依据，避免重复第 1 轮技术题。')
  assert.equal(first.round_focus.reason, null)
  assert.equal(second.round_focus.reason, null)

  // --- 两行整体不同（逐字段对比：至少这里列出的地方全都不同） ---
  assert.notEqual(JSON.stringify(first.round_focus), JSON.stringify(second.round_focus))
  assert.notEqual(JSON.stringify(first.effective_rubric), JSON.stringify(second.effective_rubric))
  assert.notDeepEqual(first.round_focus.focus_dimensions, second.round_focus.focus_dimensions)
  assert.notDeepEqual(first.round_focus.questions, second.round_focus.questions)
  assert.notDeepEqual(first.effective_rubric.scorecard.scale, second.effective_rubric.scorecard.scale)
})

test('A2 两轮 effective_rubric：维度宇宙恒 = 申请钉住 rubric（顺序不变），focus/must_cover 标记正确，weight/question 按口径', () => {
  const first = mapRow({ value: interviewValue({ roundNo: 1 }), extension: round1Extension() }).row
  const second = mapRow({ value: interviewValue({ roundNo: 2 }), extension: round2Extension() }).row
  const expectedKeys = ['backend_depth', 'async_pipeline', 'frontend_basics']

  assert.deepEqual(first.effective_rubric.dimensions.map((dimension) => dimension.key), expectedKeys)
  assert.deepEqual(second.effective_rubric.dimensions.map((dimension) => dimension.key), expectedKeys)

  for (const row of [first, second]) {
    for (const dimension of row.effective_rubric.dimensions) {
      assert.equal(dimension.required, true, `${dimension.key}: 面评必答 required 恒 true`)
      assert.equal(typeof dimension.weight, 'number')
      assert.equal(typeof dimension.label, 'string')
    }
  }

  // round 1：backend_depth / async_pipeline 是重点且必覆盖；frontend_basics 都不是
  assert.equal(dimensionOf(first, 'backend_depth').focus, true)
  assert.equal(dimensionOf(first, 'backend_depth').must_cover, true)
  assert.equal(dimensionOf(first, 'backend_depth').origin, 'ROUND_OVERRIDE')
  assert.equal(dimensionOf(first, 'async_pipeline').focus, true)
  assert.equal(dimensionOf(first, 'async_pipeline').must_cover, true)
  assert.equal(dimensionOf(first, 'async_pipeline').origin, 'ROUND_OVERRIDE')
  // weight 覆盖：focus attr 给了 0.35，base 是 0.3
  assert.equal(dimensionOf(first, 'async_pipeline').weight, 0.35)
  assert.equal(dimensionOf(first, 'frontend_basics').focus, false)
  assert.equal(dimensionOf(first, 'frontend_basics').must_cover, false)
  assert.equal(dimensionOf(first, 'frontend_basics').origin, 'JOB_BASE')
  assert.equal(dimensionOf(first, 'frontend_basics').weight, 0.2)

  // round 2：frontend_basics 是重点但**不是**必覆盖（focus 与 must_cover 不是同一个标记）
  assert.equal(dimensionOf(second, 'frontend_basics').focus, true)
  assert.equal(dimensionOf(second, 'frontend_basics').must_cover, false)
  assert.equal(dimensionOf(second, 'frontend_basics').origin, 'ROUND_OVERRIDE')
  assert.equal(dimensionOf(second, 'backend_depth').focus, false)
  assert.equal(dimensionOf(second, 'backend_depth').must_cover, false)
  assert.equal(dimensionOf(second, 'backend_depth').origin, 'JOB_BASE')

  // question：来自**申请钉住 rubric 的 base 维度**，不读 focus_attributes 的 question
  assert.equal(
    dimensionOf(first, 'backend_depth').question,
    'base 维度自带的问题（来自申请钉住的 rubric）',
    'effective 维度 question 必须来自 base rubric，focus_attributes.question 不得混入',
  )
  assert.equal(
    JSON.stringify(first.effective_rubric).includes('这条 focus question 不得出现在 effective_rubric.dimensions 里'),
    false,
  )
  assert.equal(dimensionOf(first, 'async_pipeline').question, null)

  // scale：两轮不同（1–5 vs 2–10，min 与 max 都不同）
  assert.deepEqual(first.effective_rubric.scorecard.scale, { min: 1, max: 5 })
  assert.deepEqual(second.effective_rubric.scorecard.scale, { min: 2, max: 10 })

  // scorecard.fields：恒 = 全部 base 维度映射（kind DIMENSION / required true），顺序与 rubric 一致
  const baseKeys = BASE_DIMENSIONS.map((dimension) => dimension.key)
  assert.deepEqual(first.effective_rubric.scorecard.fields.map((field) => field.key), baseKeys)
  assert.deepEqual(second.effective_rubric.scorecard.fields.map((field) => field.key), baseKeys)
  for (const field of first.effective_rubric.scorecard.fields) {
    assert.equal(field.kind, 'DIMENSION')
    assert.equal(field.required, true)
  }

  // submission：键集恒 = rubric 全部 key（SC-13 100% 覆盖），顺序一致；rubric 版本 = 申请钉住版本
  for (const row of [first, second]) {
    assert.deepEqual(row.effective_rubric.submission.dimension_keys, baseKeys)
    assert.equal(row.effective_rubric.submission.rubric_version_id, RUBRIC_ID)
    assert.equal(row.effective_rubric.rubric_version_id, RUBRIC_ID)
    assert.equal(row.effective_rubric.rubric_version_no, 1)
    assert.equal(row.effective_rubric.rubric_payload_hash, HASH_RUBRIC)
    assert.equal(row.effective_rubric.job_id, JOB_ID)
    assert.equal(row.effective_rubric.base_rubric_version_id, RUBRIC_ID)
    assert.equal(row.effective_rubric.available, true)
    assert.equal(row.effective_rubric.declared_round_rubric_version_id, null)
    assert.equal(row.effective_rubric.reason, null)
  }
})

// =====================================================================
//  B. 无模板 → JOB_BASE（如实降级，不伪造本轮重点）
// =====================================================================

test('B1 无模板（template_* 全 null）：round_focus.available=false + 数组空 + title/description null + reason 非空', () => {
  const { row, issues } = mapRow({ value: interviewValue({ roundNo: 3 }), extension: extensionRow() })
  const focus = row.round_focus

  assert.equal(focus.available, false)
  assert.equal(focus.source, 'JOB_BASE')
  assert.equal(focus.round_no, 3)
  assert.equal(focus.template_version_id, null)
  assert.equal(focus.template_version_no, null)
  assert.equal(focus.template_payload_hash, null)
  assert.equal(focus.title, null)
  assert.equal(focus.description, null)
  assert.deepEqual(focus.focus_dimensions, [])
  assert.deepEqual(focus.questions, [])
  assert.deepEqual(focus.scorecard_fields, [])
  assert.equal(typeof focus.reason, 'string')
  assert.ok((focus.reason ?? '').trim() !== '', '降级必须给中文 reason（不静默降级）')
  assert.match(focus.reason ?? '', /没有绑定可用的轮次模板/)
  assert.match(focus.reason ?? '', /JOB_BASE/)
  // 没有模板 → 不应产生"模板套用"类 issue
  assert.deepEqual(issues, [])
})

test('B2 无模板 → effective_rubric=JOB_BASE：dimensions 全 focus=false/must_cover=false/origin=JOB_BASE/required=true，scorecard.fields=全部 base 维度', () => {
  const { row } = mapRow({ value: interviewValue({ roundNo: 3 }), extension: extensionRow() })
  const rubric = row.effective_rubric
  const baseKeys = BASE_DIMENSIONS.map((dimension) => dimension.key)

  assert.equal(rubric.available, true, 'JOB_BASE 仍是可用的评分表（岗位底座）')
  assert.equal(rubric.source, 'JOB_BASE')
  assert.equal(rubric.round_no, 3)
  assert.equal(rubric.job_id, JOB_ID)
  assert.equal(rubric.rubric_version_id, RUBRIC_ID)
  assert.equal(rubric.rubric_version_no, 1)
  assert.equal(rubric.rubric_payload_hash, HASH_RUBRIC)
  assert.equal(rubric.base_rubric_version_id, RUBRIC_ID)
  assert.equal(rubric.template_version_id, null)
  assert.equal(rubric.template_version_no, null)
  assert.equal(rubric.template_payload_hash, null)
  assert.equal(rubric.declared_round_rubric_version_id, null)
  assert.equal(rubric.reason, null)

  assert.deepEqual(rubric.dimensions.map((dimension) => dimension.key), baseKeys)
  for (const dimension of rubric.dimensions) {
    assert.equal(dimension.focus, false, `${dimension.key}: JOB_BASE 无轮次重点`)
    assert.equal(dimension.must_cover, false, `${dimension.key}: JOB_BASE 无必覆盖`)
    assert.equal(dimension.origin, 'JOB_BASE')
    assert.equal(dimension.required, true)
  }
  // base 维度自带的 question 仍如实带出（不是编造）
  assert.equal(dimensionOf(row, 'backend_depth').question, 'base 维度自带的问题（来自申请钉住的 rubric）')

  // 无模板时不给量表（不编造 1–5），但字段仍 = 全部 base 维度
  assert.equal(rubric.scorecard.scale, null)
  assert.deepEqual(rubric.scorecard.fields.map((field) => field.key), baseKeys)
  for (const field of rubric.scorecard.fields) {
    assert.equal(field.kind, 'DIMENSION')
    assert.equal(field.required, true)
  }
  assert.deepEqual(rubric.submission, {
    rubric_version_id: RUBRIC_ID,
    dimension_keys: baseKeys,
  })
})

// =====================================================================
//  C. 模板 job / round 不符 → 不套用（JOB_BASE）+ issues 非空；不泄露模板文本
// =====================================================================

test('C1 模板 job 与申请 job 不符：不套用该轮次配置（JOB_BASE）+ issues 说明；轮次 focus 文本不得泄露', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({ template_job_id: OTHER_JOB_ID }),
  })

  // 没有套用：round_focus 降级，但**回显**"绑了哪个模板"（UI 能提示绑错）
  assert.equal(row.round_focus.available, false)
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.round_focus.template_version_id, TEMPLATE_R1)
  assert.equal(row.round_focus.template_version_no, 3)
  assert.equal(row.round_focus.template_payload_hash, HASH_T1)
  assert.deepEqual(row.round_focus.focus_dimensions, [])
  assert.deepEqual(row.round_focus.questions, [])
  assert.deepEqual(row.round_focus.scorecard_fields, [])
  assert.equal(row.round_focus.title, null)
  assert.equal(row.round_focus.description, null)
  assert.match(row.round_focus.reason ?? '', /不套用该轮次配置/)
  assert.match(row.round_focus.reason ?? '', /JOB_BASE/)

  // 维度宇宙 = 岗位底座（全 JOB_BASE），别岗位模板不能把维度带进来
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  assert.deepEqual(
    row.effective_rubric.dimensions.map((dimension) => dimension.key),
    BASE_DIMENSIONS.map((dimension) => dimension.key),
  )
  for (const dimension of row.effective_rubric.dimensions) {
    assert.equal(dimension.focus, false)
    assert.equal(dimension.must_cover, false)
    assert.equal(dimension.origin, 'JOB_BASE')
  }
  assert.deepEqual(row.effective_rubric.submission.dimension_keys, BASE_DIMENSIONS.map((dimension) => dimension.key))

  // issues 非空、可解释
  assert.ok(issues.length >= 1, 'job 不符必须有 issue（不能静默降级）')
  const text = issues.join('\n')
  assert.match(text, /^面试 /)
  assert.match(text, /轮次模板/)
  assert.match(text, /与申请岗位/)
  assert.match(text, /不一致，不套用该轮次配置/)

  // 反证：不泄露模板里的任何 focus 原文/问题原文
  const serialized = JSON.stringify(row)
  assert.equal(serialized.includes('这条 focus question'), false)
  assert.equal(serialized.includes('讲一个你设计过的分片方案。'), false)
  assert.equal(serialized.includes('验证后端工程深度与异步/队列流水线经验'), false)
})

test('C2 模板 round_no 与面试 round_no 不符：不套用 + issues 说明；重点/问题不泄露', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 2 }),
    // 模板是第 1 轮的，却绑在第 2 轮面试上
    extension: round1Extension(),
  })

  assert.equal(row.round_focus.available, false)
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.round_focus.round_no, 2, 'round_no 以面试事实为准')
  assert.equal(row.round_focus.template_version_id, TEMPLATE_R1)
  assert.deepEqual(row.round_focus.focus_dimensions, [])
  assert.deepEqual(row.round_focus.questions, [])
  assert.match(row.round_focus.reason ?? '', /不套用该轮次配置/)
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  for (const dimension of row.effective_rubric.dimensions) {
    assert.equal(dimension.focus, false)
    assert.equal(dimension.origin, 'JOB_BASE')
  }

  const text = issues.join('\n')
  assert.match(text, /round_no=/)
  assert.match(text, /与本场面试轮次/)
  assert.match(text, /不一致，不套用该轮次配置/)
  assert.equal(JSON.stringify(row).includes('讲一个你设计过的分片方案。'), false)
})

// =====================================================================
//  D. 模板声明不同 rubric_version_id → 不换维度宇宙 + 冲突说明
// =====================================================================

test('D1 模板声明不同 rubric 版本：declared 如实回显、维度仍来自申请钉住 rubric、issues/reason 写明冲突、submission 仍 base', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({ template_declared_rubric_version_id: OTHER_RUBRIC_ID }),
  })

  // declared 原样回显（不吞、不改写）
  assert.equal(row.effective_rubric.declared_round_rubric_version_id, OTHER_RUBRIC_ID)
  // 维度宇宙不变：仍是申请钉住 rubric 的三个维度、顺序不变
  assert.deepEqual(
    row.effective_rubric.dimensions.map((dimension) => dimension.key),
    BASE_DIMENSIONS.map((dimension) => dimension.key),
  )
  assert.equal(row.effective_rubric.rubric_version_id, RUBRIC_ID)
  assert.equal(row.effective_rubric.base_rubric_version_id, RUBRIC_ID)
  // 提交仍钉在 base 版本（不混用两个 rubric 版本）
  assert.equal(row.effective_rubric.submission.rubric_version_id, RUBRIC_ID)
  assert.deepEqual(row.effective_rubric.submission.dimension_keys, BASE_DIMENSIONS.map((dimension) => dimension.key))
  // source 不会因为 declared 冲突而"假装"成别的东西
  assert.ok(
    row.effective_rubric.source === 'ROUND_OVERRIDE' || row.effective_rubric.source === 'JOB_BASE',
    `effective_rubric.source 必须是封闭集里的值，实际 ${row.effective_rubric.source}`,
  )
  // reason 与 issues 都要写明冲突（不静默）
  assert.notEqual(row.effective_rubric.reason, null, 'declared 冲突必须给 reason')
  assert.match(row.effective_rubric.reason ?? '', /声明的 rubric 版本/)
  const text = issues.join('\n')
  assert.match(text, /声明的 rubric 版本/)
  assert.match(text, /与申请钉住的岗位 rubric 版本/)
  assert.match(text, /不一致，服务端不混用/)
})

// =====================================================================
//  E. focus_attributes 含岗 rubric 没有的 key → 进 round_focus（in_rubric=false），不进 effective 维度
// =====================================================================

test('E1 轮次重点含 rubric 之外的 key：进 round_focus.focus_dimensions（in_rubric=false），不进 effective_rubric.dimensions，issues 说明', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({
      template_focus: [
        { key: 'backend_depth', label: '后端工程深度', weight: 0.5, required: true, must_cover: true },
        { key: 'system_design', label: '系统设计（岗 rubric 没有）', weight: 0.4, required: true, must_cover: true },
      ],
    }),
  })

  // round_focus 如实展示本轮重点（不因为 rubric 没有就吞掉）
  const focus = row.round_focus
  assert.equal(focus.available, true)
  const systemDesign = focus.focus_dimensions.find((item) => item.key === 'system_design')
  assert.ok(systemDesign !== undefined, 'round_focus.focus_dimensions 必须包含 rubric 之外的轮次重点')
  assert.equal(systemDesign.in_rubric, false)
  assert.equal(systemDesign.label, '系统设计（岗 rubric 没有）')
  assert.equal(systemDesign.required, true)
  assert.equal(focus.focus_dimensions.find((item) => item.key === 'backend_depth')?.in_rubric, true)

  // effective_rubric 的维度宇宙仍只有岗位 rubric 的三个 key（越界 key 不进来）
  const dimensionKeys = row.effective_rubric.dimensions.map((dimension) => dimension.key)
  assert.deepEqual(dimensionKeys, BASE_DIMENSIONS.map((dimension) => dimension.key))
  assert.equal(dimensionKeys.includes('system_design'), false)
  assert.deepEqual(row.effective_rubric.submission.dimension_keys, BASE_DIMENSIONS.map((dimension) => dimension.key))
  // 面评提交键集不含它 → 不能靠轮次配置给面评加 key（D-89 的键只来自服务端 schema）
  assert.equal(row.effective_rubric.submission.dimension_keys.includes('system_design'), false)

  // issues 说明（非空且可定位）
  const text = issues.join('\n')
  assert.match(text, /本轮重点维度/)
  assert.match(text, /不在申请钉住的岗位 rubric 中/)
  assert.match(text, /面评提交键集不含/)
  assert.ok(text.includes('system_design'), 'issue 必须点名越界 key')
})

// =====================================================================
//  F. 越权/不泄露 + rubric 越界
// =====================================================================

test('F1 当前 actor 不在 interviewers[]：抛 NOT_FOUND(INTERVIEWER_ROW_MISSING)，不猜空面评', () => {
  const input: ToInterviewRowInput = {
    value: interviewValue({
      interviewers: [interviewerValue({ actorId: ACTOR_B })],
    }),
    extension: round1Extension(),
    actorId: ACTOR_A,
  }
  assert.throws(
    () => toInterviewRow(input),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'NOT_FOUND')
      assert.equal(body.reason_code, 'INTERVIEWER_ROW_MISSING')
      assert.equal(JSON.stringify(body.detail).includes(INTERVIEW_ID), true)
      return true
    },
  )
})

test('F2 申请钉住 rubric 不属于该申请岗位（pinned 越界）：effective_rubric.available=false，不把别岗位维度当可用 schema', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    // join 不上：钉住了 RUBRIC_ID，但没有可用的 rubric 行（真实原因是版本不属于该申请岗位/已不存在）
    extension: round1Extension({
      pinned_rubric_version_id: RUBRIC_ID,
      rubric_version_id: null,
      rubric_payload_hash: null,
      rubric_version_no: null,
      rubric_dimensions: [],
    }),
  })

  // 不挑"看起来对"的版本：维度空、无 scale、提交键集空
  assert.equal(row.effective_rubric.available, false)
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  assert.equal(row.effective_rubric.job_id, JOB_ID)
  assert.equal(row.effective_rubric.rubric_version_id, '')
  assert.equal(row.effective_rubric.base_rubric_version_id, null)
  assert.deepEqual(row.effective_rubric.dimensions, [])
  assert.equal(row.effective_rubric.scorecard.scale, null)
  assert.deepEqual(row.effective_rubric.scorecard.fields, [])
  assert.deepEqual(row.effective_rubric.submission, { rubric_version_id: '', dimension_keys: [] })
  assert.notEqual(row.effective_rubric.reason, null)
  assert.match(row.effective_rubric.reason ?? '', /申请钉住的 rubric 版本/)
  assert.match(row.effective_rubric.reason ?? '', /不可用/)

  // 既有 issue 仍在（rubric 越界）；不泄露任何"别的岗位"维度
  const text = issues.join('\n')
  assert.match(text, /申请钉住的 rubric 版本/)
  assert.match(text, /不属于该申请的岗位/)
  // round_focus 仍按模板展示，但所有维度 in_rubric=false（rubric 不可用时不能声称在 rubric 里）
  assert.equal(row.round_focus.available, true)
  assert.equal(row.round_focus.source, 'ROUND_CONFIG')
  assert.ok(row.round_focus.focus_dimensions.length > 0)
  for (const item of row.round_focus.focus_dimensions) {
    assert.equal(item.in_rubric, false)
  }
  assert.equal(JSON.stringify(row.effective_rubric).includes('OTHER_RUBRIC'), false)
})

// =====================================================================
//  G. jsonb 容错（脏值不抛错、不编造）
// =====================================================================

test('G1 focus_attributes 是字符串 / question_templates 是对象 / feedback_form 是空对象：不抛错、不编造，无轮次内容 → JOB_BASE', () => {
  const { row, issues } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({
      // 契约：objective/briefing/focus/questions/feedback_form 全空才算"模板没有轮次内容"；
      // 这里把 objective/briefing 也清空，只留脏 jsonb，验证"脏值不抛错、不编造"。
      template_objective: null,
      template_briefing_summary: null,
      template_focus: 'not-an-array（脏 jsonb：字符串）',
      template_questions: { bad: 'shape' },
      template_feedback_form: {},
    }),
  })

  // 不抛错，且不编造本轮重点；绑定了模板但没有可用内容 → 降级 + reason
  assert.equal(row.round_focus.available, false)
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.round_focus.template_version_id, TEMPLATE_R1, '绑了哪个模板仍如实回显')
  assert.deepEqual(row.round_focus.focus_dimensions, [])
  assert.deepEqual(row.round_focus.questions, [])
  assert.deepEqual(row.round_focus.scorecard_fields, [])
  assert.match(row.round_focus.reason ?? '', /已绑定轮次模板/)
  assert.match(row.round_focus.reason ?? '', /未配置任何轮次重点/)

  // effective_rubric 仍是岗位底座（rubric 本身没坏）
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  assert.deepEqual(
    row.effective_rubric.dimensions.map((dimension) => dimension.key),
    BASE_DIMENSIONS.map((dimension) => dimension.key),
  )
  for (const dimension of row.effective_rubric.dimensions) {
    assert.equal(dimension.focus, false)
    assert.equal(dimension.must_cover, false)
  }
  assert.equal(row.effective_rubric.scorecard.scale, null, '脏 scale 不得被硬转成数字')
  assert.deepEqual(row.effective_rubric.scorecard.fields.map((field) => field.key), BASE_DIMENSIONS.map((d) => d.key))
  assert.deepEqual(issues, [])

  // 对照：模板有 objective（= 有轮次内容）但 scale 是脏值时，轮次配置可用，scale 仍不得编造
  const dirtyScale = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({ template_feedback_form: { scale: { min: '1', max: 'five' } } }),
  })
  assert.equal(dirtyScale.row.round_focus.available, true, '有 objective 就是可用的轮次配置')
  assert.equal(dirtyScale.row.effective_rubric.scorecard.scale, null, '脏 scale 不得硬转成 1..NaN')
})

test('G2 focus_attributes 数组里混入脏元素：只保留合法元素，不补假 key、不抛错', () => {
  const { row } = mapRow({
    value: interviewValue({ roundNo: 1 }),
    extension: round1Extension({
      template_focus: [
        { key: 'backend_depth', label: '后端工程深度', weight: 0.5, required: true },
        'junk',
        { label: '没有 key 的维度' },
        { key: 123, label: 'key 不是字符串' },
        null,
        { key: 'async_pipeline', weight: '0.3（字符串权重）' },
      ],
    }),
  })

  assert.equal(row.round_focus.available, true)
  assert.deepEqual(row.round_focus.focus_dimensions.map((item) => item.key), ['backend_depth', 'async_pipeline'])
  // label 缺省：命中岗位 rubric 时用 rubric 的 label（契约冻结口径），否则才回退 key；
  // 字符串权重不硬转 → 回退 base weight。
  assert.equal(row.round_focus.focus_dimensions[1]?.label, '异步/队列流水线经验')
  assert.equal(row.round_focus.focus_dimensions[1]?.weight, 0.3)
  assert.equal(row.round_focus.focus_dimensions[1]?.required, false)
})

test('G3 feedback_form 是脏对象 / 缺失：scorecard_fields 空、scale null，字段仍 = base 维度映射（不编造）', () => {
  for (const dirty of [undefined, null, 'garbage', [{ fields: [] }], { fields: 'not-array', scale: [] }]) {
    const { row } = mapRow({
      value: interviewValue({ roundNo: 1 }),
      extension: round1Extension({ template_feedback_form: dirty }),
    })
    assert.deepEqual(row.round_focus.scorecard_fields, [], `feedback_form=${JSON.stringify(dirty)} 时不得编造字段`)
    assert.equal(row.effective_rubric.scorecard.scale, null, `feedback_form=${JSON.stringify(dirty)} 时不得编造量表`)
    assert.deepEqual(
      row.effective_rubric.scorecard.fields.map((field) => field.key),
      BASE_DIMENSIONS.map((dimension) => dimension.key),
      '评分表字段仍来自 base rubric（不是轮次表单）',
    )
  }
})

test('G4 template_* 旧字段缺失（undefined，老假行形状）：不抛错，按 JOB_BASE 降级', () => {
  const oldShape = extensionRow()
  // 模拟 task-50 之前的假扩展行：新字段整个不存在
  delete (oldShape as Record<string, unknown>).template_version_no
  delete (oldShape as Record<string, unknown>).template_round_no
  delete (oldShape as Record<string, unknown>).template_job_id
  delete (oldShape as Record<string, unknown>).template_feedback_form
  delete (oldShape as Record<string, unknown>).template_declared_rubric_version_id
  delete (oldShape as Record<string, unknown>).rubric_version_no
  const { row } = mapRow({ value: interviewValue({ roundNo: 1 }), extension: oldShape })
  assert.equal(row.round_focus.available, false)
  assert.equal(row.round_focus.source, 'JOB_BASE')
  assert.equal(row.effective_rubric.available, true)
  assert.equal(row.effective_rubric.source, 'JOB_BASE')
  assert.equal(row.effective_rubric.scorecard.scale, null)
})

// =====================================================================
//  附加（不计入 A–G，但保证"新字段不改变旧行为"）
// =====================================================================

test('附加：新增 round_focus/effective_rubric 不改变 brief/rubric/materials/scorecard 的既有语义', () => {
  const { row } = mapRow({ value: interviewValue({ roundNo: 1 }), extension: round1Extension() })
  // brief 仍是旧三态逻辑（TEMPLATE），不是轮次配置的替代品
  assert.equal(row.brief.available, true)
  assert.equal(row.brief.source, 'TEMPLATE')
  assert.equal(row.brief.objective, '第 1 轮：技术基础与后端工程深度')
  assert.equal(row.brief.template_version_id, TEMPLATE_R1)
  // 旧 rubric 块仍只暴露 {rubric_version_id, job_id, payload_hash, dimensions}
  assert.deepEqual(Object.keys(row.rubric ?? {}).sort(), ['dimensions', 'job_id', 'payload_hash', 'rubric_version_id'])
  assert.equal(row.rubric?.rubric_version_id, RUBRIC_ID)
  // 没有材料时 materials 如实 NO_MATERIAL_BOUND
  assert.equal(row.materials.available, false)
  assert.equal(row.materials.reason, 'NO_MATERIAL_BOUND')
})
