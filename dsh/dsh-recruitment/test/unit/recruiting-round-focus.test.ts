// 轮次重点（task-50 `round_focus`）**纯函数**测试：归一化 / 降级 / 不编造 + 岗位 rubricVersionId。
//
// 契约出处：
//   · `work/d5/round/REPORT.md` §2：`round_focus` 字段名逐字；
//   · `work/d5/w2b/INTERFACE.md` §2.4：`normalizeRoundFocus` / `InterviewView.roundFocus` /
//     `JobView.rubric.rubricVersionId`。
// 无 DOM、无 React：只覆盖 view-model.ts 的纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeApplicationDetail,
  normalizeJobDetail,
  normalizeOverviewView,
  normalizeRoundFocus,
} from '../../src/client/recruiting/view-model.ts'

/** 一轮 ROUND_CONFIG 的合法投影（字段与 task-50 REPORT §2 逐字一致）。 */
function roundConfigWire(): Record<string, unknown> {
  return {
    available: true,
    source: 'ROUND_CONFIG',
    round_no: 2,
    template_version_id: 'tv-2',
    template_version_no: 1,
    template_payload_hash: 'a'.repeat(64),
    title: '第 2 轮：前端与工程素养（DEMO ONLY）',
    description: '本轮重点看前端工程化与跨端协作。',
    focus_dimensions: [
      { key: 'frontend_basics', label: '前端基础', weight: 0.4, required: true, in_rubric: true },
      { key: 'cross_team', label: '跨团队协作', weight: 0.2, required: false, in_rubric: false },
    ],
    questions: [
      { key: 'q1', text: '讲一次你排查前端性能问题的经历。' },
      { key: null, text: '你如何与后端约定接口契约？' },
    ],
    scorecard_fields: [
      { key: 'frontend_basics', label: '前端基础', kind: 'DIMENSION', required: true },
    ],
    reason: null,
  }
}

test('round_focus 合法投影：字段逐字归一化（不同轮不同内容，数据驱动）', () => {
  const focus = normalizeRoundFocus(roundConfigWire())
  assert.equal(focus.available, true)
  assert.equal(focus.source, 'ROUND_CONFIG')
  assert.equal(focus.roundNo, 2)
  assert.equal(focus.templateVersionId, 'tv-2')
  assert.equal(focus.templateVersionNo, 1)
  assert.equal(focus.templatePayloadHash, 'a'.repeat(64))
  assert.equal(focus.title, '第 2 轮：前端与工程素养（DEMO ONLY）')
  assert.equal(focus.description, '本轮重点看前端工程化与跨端协作。')
  assert.equal(focus.reason, '', 'null reason 归一化为空串（不编造原因）')

  assert.equal(focus.focusDimensions.length, 2)
  assert.deepEqual(focus.focusDimensions[0], {
    key: 'frontend_basics',
    label: '前端基础',
    weight: 0.4,
    required: true,
    inRubric: true,
  })
  assert.deepEqual(focus.focusDimensions[1], {
    key: 'cross_team',
    label: '跨团队协作',
    weight: 0.2,
    required: false,
    inRubric: false,
  })

  assert.deepEqual(focus.questions, [
    { key: 'q1', text: '讲一次你排查前端性能问题的经历。' },
    { key: '', text: '你如何与后端约定接口契约？' },
  ])
  assert.deepEqual(focus.scorecardFields, [
    { key: 'frontend_basics', label: '前端基础', kind: 'DIMENSION', required: true },
  ])

  // 另一轮（round 1）内容不同 → 归一化结果随数据变化（没有按轮次硬编码）。
  const round1 = normalizeRoundFocus({
    available: true,
    source: 'ROUND_CONFIG',
    round_no: 1,
    title: '第 1 轮：后端工程深度',
    focus_dimensions: [{ key: 'backend_depth', label: '后端深度', weight: 0.5, required: true, in_rubric: true }],
    questions: [{ key: null, text: '讲一次高并发改造。' }],
    scorecard_fields: [],
  })
  assert.equal(round1.roundNo, 1)
  assert.deepEqual(
    round1.focusDimensions.map((dimension) => dimension.key),
    ['backend_depth'],
  )
  assert.notDeepEqual(
    round1.focusDimensions.map((dimension) => dimension.key),
    focus.focusDimensions.map((dimension) => dimension.key),
  )
  assert.equal(round1.questions[0]?.text, '讲一次高并发改造。')
})

test('round_focus 缺失 / 坏类型：一律降级为 available:false 空视图，不编造', () => {
  const empty = normalizeRoundFocus(undefined)
  assert.deepEqual(empty, {
    available: false,
    source: '',
    roundNo: 0,
    templateVersionId: '',
    templateVersionNo: 0,
    templatePayloadHash: '',
    title: '',
    description: '',
    focusDimensions: [],
    questions: [],
    scorecardFields: [],
    reason: '',
  })
  for (const bad of [null, 'oops', 42, [], {}, true]) {
    const focus = normalizeRoundFocus(bad)
    assert.equal(focus.available, false)
    assert.equal(focus.source, '')
    assert.equal(focus.roundNo, 0)
    assert.equal(focus.title, '')
    assert.equal(focus.description, '')
    assert.deepEqual(focus.focusDimensions, [])
    assert.deepEqual(focus.questions, [])
    assert.deepEqual(focus.scorecardFields, [])
    assert.equal(focus.reason, '')
    const serialized = JSON.stringify(focus)
    assert.equal(serialized.includes('NaN'), false)
    assert.equal(serialized.includes('undefined'), false)
  }
})

test('round_focus available=false（JOB_BASE 降级）：保留 source/round/reason，内容清空不冒充', () => {
  const focus = normalizeRoundFocus({
    available: false,
    source: 'JOB_BASE',
    round_no: 2,
    template_version_id: null,
    template_version_no: 0,
    template_payload_hash: null,
    title: '不该显示的标题',
    description: '不该显示的说明',
    focus_dimensions: [{ key: 'leak', label: '不该显示', weight: 1, required: true, in_rubric: true }],
    questions: [{ key: 'q1', text: '不该显示的问题' }],
    scorecard_fields: [{ key: 'x', label: '不该显示', kind: 'DIMENSION', required: true }],
    reason: '本场面试没有绑定可用的轮次模板，已如实降级到岗位 Rubric 底座（JOB_BASE）',
  })
  assert.equal(focus.available, false)
  assert.equal(focus.source, 'JOB_BASE')
  assert.equal(focus.roundNo, 2)
  assert.equal(focus.reason, '本场面试没有绑定可用的轮次模板，已如实降级到岗位 Rubric 底座（JOB_BASE）')
  assert.equal(focus.title, '', 'available=false 时不展示内容（不冒充本轮重点）')
  assert.equal(focus.description, '')
  assert.deepEqual(focus.focusDimensions, [])
  assert.deepEqual(focus.questions, [])
  assert.deepEqual(focus.scorecardFields, [])
})

test('round_focus available=true 内部坏类型：逐项丢弃 / 降级，不抛错、不出现 NaN 与 undefined', () => {
  const focus = normalizeRoundFocus({
    available: 'true',
    source: 42,
    round_no: '2',
    template_version_no: -1,
    template_payload_hash: 12345,
    title: 7,
    description: null,
    focus_dimensions: [
      { key: '', label: '无 key 丢弃' },
      { key: 'depth', label: '', weight: Number.NaN, required: 1, in_rubric: 'true' },
      { key: 'depth', label: '深度', weight: -0.5, required: true, in_rubric: true },
    ],
    questions: [{ key: 'q1' }, { key: 'q2', text: '  有效问题  ' }],
    scorecard_fields: [{ label: '无 key 丢弃' }, { key: 'depth', kind: 9, required: 'yes' }],
    reason: 123,
  })
  // available 只认严格 true：字符串 'true' 不算可用，整体降级（内容清空）。
  assert.equal(focus.available, false)
  assert.equal(focus.source, '')
  assert.equal(focus.roundNo, 0)
  assert.deepEqual(focus.focusDimensions, [])
  assert.deepEqual(focus.questions, [])
  assert.deepEqual(focus.scorecardFields, [])

  const usable = normalizeRoundFocus({
    available: true,
    source: 'ROUND_CONFIG',
    round_no: 1,
    focus_dimensions: [
      { key: '', label: '无 key 丢弃' },
      { key: 'depth', label: '', weight: Number.NaN, required: 1, in_rubric: 'true' },
      { key: 'breadth', label: '广度', weight: 0.5, required: true, in_rubric: true },
    ],
    questions: [{ key: 'q1' }, { key: 'q2', text: '  有效问题  ' }],
    scorecard_fields: [{ label: '无 key 丢弃' }, { key: 'depth', kind: 9, required: 'yes' }],
  })
  assert.equal(usable.available, true)
  assert.deepEqual(
    usable.focusDimensions.map((dimension) => dimension.key),
    ['depth', 'breadth'],
    '缺 key 的维度被丢弃，其余保留',
  )
  assert.equal(usable.focusDimensions[0]?.label, 'depth', 'label 缺失回退 key')
  assert.equal(usable.focusDimensions[0]?.weight, null, 'NaN 权重降级为 null（不当 0）')
  assert.equal(usable.focusDimensions[0]?.required, false, '非严格 true 的 required 降级为 false')
  assert.equal(usable.focusDimensions[0]?.inRubric, false, '字符串 true 不算 in_rubric')
  assert.equal(usable.focusDimensions[1]?.weight, 0.5)
  assert.deepEqual(usable.questions, [{ key: 'q2', text: '有效问题' }], '无原文的问题被丢弃；文本按 text() 去空白')
  assert.deepEqual(usable.scorecardFields, [{ key: 'depth', label: 'depth', kind: '', required: false }])

  const serialized = JSON.stringify(usable)
  assert.equal(serialized.includes('NaN'), false)
  assert.equal(serialized.includes('undefined'), false)
})

test('面试归一化：interviews[].roundFocus 必存在；缺投影 → available:false 空视图', () => {
  const detail = normalizeApplicationDetail({
    application: {
      application_id: 'app-1',
      progress: { next_step: { code: 'STEP', label: '下一步', kind: 'INFO' } },
      interviews: [
        {
          interview_id: 'iv-1',
          round_no: 2,
          status: 'SCHEDULED',
          round_focus: roundConfigWire(),
          transcript: {},
          scorecards: {},
        },
        {
          interview_id: 'iv-2',
          round_no: 3,
          status: 'SCHEDULED',
          // 旧端点：没有 round_focus
          transcript: {},
          scorecards: {},
        },
      ],
    },
  })
  assert.equal(detail.interviews.length, 2)
  assert.equal(detail.interviews[0]?.roundFocus.available, true)
  assert.equal(detail.interviews[0]?.roundFocus.source, 'ROUND_CONFIG')
  assert.equal(detail.interviews[0]?.roundFocus.roundNo, 2)
  assert.deepEqual(
    detail.interviews[0]?.roundFocus.focusDimensions.map((dimension) => dimension.key),
    ['frontend_basics', 'cross_team'],
  )
  assert.equal(detail.interviews[1]?.roundFocus.available, false)
  assert.equal(detail.interviews[1]?.roundFocus.roundNo, 0)
  assert.deepEqual(detail.interviews[1]?.roundFocus.focusDimensions, [])
  const serialized = JSON.stringify(detail)
  assert.equal(serialized.includes('NaN'), false)
  assert.equal(serialized.includes('undefined'), false)
})

test('JobView.rubric.rubricVersionId：wire rubric_version_id 归一化（批准动作必需字段）', () => {
  const view = normalizeOverviewView({
    jobs: [
      {
        job_id: 'job-1',
        title: '后端工程师',
        status: 'OPEN',
        rubric: { rubric_version_id: 'rv-9', version_no: 2, approved: false, dimension_count: 4 },
      },
      {
        job_id: 'job-2',
        title: '无 rubric 岗位',
        status: 'DRAFT',
        rubric: null,
      },
      {
        job_id: 'job-3',
        title: '缺版本 id 岗位',
        status: 'OPEN',
        rubric: { version_no: 1, approved: false, dimension_count: 2 },
      },
    ],
  })
  const withRubric = view.jobs.find((job) => job.id === 'job-1')
  assert.ok(withRubric !== undefined && withRubric.rubric !== null)
  assert.equal(withRubric.rubric.rubricVersionId, 'rv-9')
  assert.equal(withRubric.rubric.versionNo, 2)
  assert.equal(withRubric.rubric.approved, false)
  assert.equal(withRubric.rubric.summaryText, 'Rubric r2 · 4 个维度 · 未批准')

  const noRubric = view.jobs.find((job) => job.id === 'job-2')
  assert.equal(noRubric?.rubric, null, '没有 rubric 时保持 null（不造空对象）')

  const missingId = view.jobs.find((job) => job.id === 'job-3')
  assert.ok(missingId !== undefined && missingId.rubric !== null)
  assert.equal(missingId.rubric.rubricVersionId, '', '缺 id 时为空串（不编造）')
})

test('岗位详情 rubric 也暴露 rubricVersionId（批准动作与 readback 对齐）', () => {
  const detail = normalizeJobDetail({
    job: {
      job_id: 'job-1',
      title: '后端工程师',
      status: 'OPEN',
      rubric: { rubric_version_id: 'rv-9', version_no: 2, approved: true, dimension_count: 1 },
    },
    rubric: {
      rubric_version_id: 'rv-9',
      version_no: 2,
      dimensions: [{ key: 'depth', label: '深度', kind: 'SCALE', weight: 1 }],
    },
  })
  assert.equal(detail.rubric?.rubricVersionId, 'rv-9')
  assert.equal(detail.rubric?.approved, true, 'approved 从 job.rubric 合并')
  // 空详情：rubric 仍为 null（不编造）
  assert.equal(normalizeJobDetail({}).rubric, null)
  // 只有版本 id、没有维度：仍然如实返回（版本事实存在，维度为空）
  const idOnly = normalizeJobDetail({ rubric: { rubric_version_id: 'rv-only' } })
  assert.equal(idOnly.rubric?.rubricVersionId, 'rv-only')
  assert.equal(idOnly.rubric?.versionNo, 0)
  assert.deepEqual(idOnly.rubric?.dimensions, [])
})
