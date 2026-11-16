// 招聘工作区（W2）**纯函数**测试（node --test，无 DOM、无 React）。
//
// 覆盖口径（`work/d5/w2/CONTRACT.md` §3）：
//   1. 空 overview / 坏类型 / NaN：一律降级成 '' / 0 / [] / null，序列化后不出现 NaN / undefined；
//   2. 下一步归并：岗位下一步只来自 `job.next_step`、申请下一步只来自 `progress.next_step`，
//      同一事项在视图模型里**只出现一次**（序列化计数 = 1；详情页头部类型里没有 nextStep 字段）；
//   3. 阶段与状态映射：job / lifecycle / parse / interview / scorecard / decision / transcript 枚举；
//   4. 时间 / 字节数 / sha256 格式化边界（null、非法日期、0）；
//   5. 写动作禁用态文案（available=false 必有 pending 文案；available=true 但 seam 为空 → fail-closed）；
//   6. 详情字段降级（材料 / 简历 / 初筛证据 / 面试 / 转写 / 决策 / 时间线 / transcript runs）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applicationRubricTextOf,
  buildApplicationHeader,
  buildInterviews,
  buildScorecardProgress,
  collectNextSteps,
  normalizeApplicationDetail,
  normalizeJobDetail,
  normalizeOverviewView,
  splitSidebarJobs,
  transcriptSummaryOf,
} from '../../src/client/recruiting/view-model.ts'
import { count, formatBytes, formatDateTime, shortSha, text } from '../../src/client/recruiting/format.ts'

/** 字符串出现次数（用于"同一事项只出现一次"的机检）。 */
function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

/** 本地时间 `YYYY-MM-DD HH:mm`（测试自己算期望值，避免依赖机器时区）。 */
function expectedLocalDateTime(raw: string): string {
  const date = new Date(raw)
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 一个结构完整、类型正确的 overview fixture（后续测试在它上面做坏类型替换）。 */
function fullOverview(): Record<string, unknown> {
  return {
    contract_version: 'recruiting-overview 1.0.0',
    configured: true,
    issues: [],
    evaluated_at: '2026-11-15T04:05:06.000Z',
    actor: { actor_id: '11111111-1111-4111-8111-000000000103', display_name: '演示-HR 专员', roles: ['RECRUITER'] },
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: {
      jobs_total: 2,
      jobs_open: 1,
      applications_total: 4,
      applications_active: 3,
      applications_by_stage: { S7: 2, S9: 1, S10: 1 },
      awaiting_screening: 2,
      interviewing: 1,
      awaiting_decision: 1,
      interviews_scheduled: 1,
      scorecards_required_total: 2,
      scorecards_submitted_total: 1,
      transcripts_ready: 1,
      transcripts_pending: 1,
    },
    jobs: [
      {
        job_id: 'job-1',
        code: 'JOB-001',
        title: 'AI 产品经理',
        status: 'OPEN',
        department_name: '产品与智能应用',
        created_at: '2026-11-10T02:00:00.000Z',
        status_changed_at: '2026-11-11T02:00:00.000Z',
        version_no: 3,
        rubric: { rubric_version_id: 'rv-1', version_no: 2, approved: true, dimension_count: 3 },
        postings: [
          { posting_id: 'post-1', channel_name: '企业招聘邮箱', status: 'PUBLISHED', external_url: null },
        ],
        application_counts: { total: 4, active: 3, by_stage: { S7: 2, S9: 1, S10: 1 } },
        next_step: { code: 'JOB_NEXT', label: '岗位下一步唯一文案', kind: 'INFO' },
      },
      {
        job_id: 'job-2',
        code: 'JOB-002',
        title: 'Agent 产品工程师',
        status: 'DRAFT',
        department_name: null,
        version_no: null,
        rubric: null,
        postings: [],
        application_counts: { total: 0, active: 0, by_stage: {} },
        next_step: { code: 'CLOSED', label: '岗位已归档', kind: 'INFO' },
      },
    ],
    applications: [
      {
        application_id: 'app-1',
        candidate: { candidate_id: 'cand-1', display_name: '林知远' },
        job: { job_id: 'job-1', code: 'JOB-001', title: 'AI 产品经理' },
        lifecycle_status: 'ACTIVE',
        current_stage_code: 'S7',
        stage_entered_at: '2026-11-12T02:00:00.000Z',
        applied_at: '2026-11-11T02:00:00.000Z',
        stage_blocked_reason: null,
        record_version: 5,
        material: {
          resume_version_id: 'resv-1',
          resume_id: 'res-1',
          asset_id: 'asset-1',
          file_name: '林知远_简历.pdf',
          mime_type: 'application/pdf',
          byte_size: 2621440,
          sha256: 'a'.repeat(64),
          source_asset_sha256: 'a'.repeat(64),
          source_hash_aligned: true,
          validation_status: 'VALID',
          parse_status: 'PARSED',
          parser_name: 'pymupdf',
          parser_version: '1.24.0',
          page_count: 3,
          field_states: { education: 'present', email: 'present' },
          entry_counts: { work: 2, education: 1 },
          evidence_count: 5,
        },
        screening: null,
        interviews: [],
        decisions: [],
        progress: {
          scorecards_required: 0,
          scorecards_submitted: 0,
          transcript_state: 'NOT_READY',
          next_step: { code: 'PROVIDE_SCREENING_DECISION', label: '等待初筛决定', kind: 'HUMAN_ACTION' },
        },
      },
    ],
    settings: {
      stage_catalog: {
        version_no: 2,
        effective_from: '2026-11-01T00:00:00.000Z',
        stages: [
          { code: 'S7', label: '初筛（目录）', kind: 'SCREENING', order: 7, in_v1_scope: true },
          { code: 'S10', label: '决策（目录）', kind: 'DECISION', order: 10, in_v1_scope: true },
        ],
      },
      configs: [
        {
          config_key: 'stage_catalog',
          scope: 'TENANT',
          scope_id: null,
          version_no: 2,
          effective_from: '2026-11-01T00:00:00.000Z',
          effective_to: null,
          payload_keys: ['stages'],
        },
      ],
      departments: [{ department_id: 'dept-1', name: '产品与智能应用' }],
      hiring_teams: [
        {
          team_id: 'team-1',
          code: 'TEAM-PROD',
          name: '产品招聘组',
          department_name: '产品与智能应用',
          members: [{ actor_id: 'actor-103', display_name: '演示-HR 专员', team_role: 'OWNER', actor_kind: 'HUMAN' }],
        },
      ],
      entry: { available: false, href: null, note: '设置写入口尚未接线（只读展示）' },
    },
    actions: {
      screening_decide: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      interview_schedule: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      transcript_import: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      stage_advance: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      decision_record: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      rubric_approve: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      recruiting_settings_write: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
    },
  }
}

test('空 overview：全部降级为空形状，写动作全禁用且带 pending 文案', () => {
  const view = normalizeOverviewView({})
  assert.equal(view.configured, false)
  assert.equal(view.contractVersion, '')
  assert.equal(view.evaluatedAt, '')
  assert.equal(view.evaluatedAtText, '')
  assert.deepEqual(view.issues, [])
  assert.deepEqual(view.jobs, [])
  assert.deepEqual(view.applications, [])
  assert.deepEqual(view.actor, { actorId: '', displayName: '', roles: [] })
  assert.deepEqual(
    view.labels.rows.map((row) => row.value),
    ['', '', ''],
  )

  for (const value of Object.values(view.counts)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value) && value >= 0, `计数必须是非负有限数：${String(value)}`)
  }
  assert.deepEqual(view.counts.byStage, [])
  assert.deepEqual(view.nextStepTotals, { info: 0, human: 0, wait: 0, missing: 0 })

  assert.equal(view.settings.stageCatalog, null)
  assert.deepEqual(view.settings.configs, [])
  assert.deepEqual(view.settings.departments, [])
  assert.deepEqual(view.settings.hiringTeams, [])
  assert.deepEqual(view.settings.entry, { available: false, href: '', note: '' })

  assert.equal(view.actionList.length, 7)
  for (const action of view.actionList) {
    assert.equal(action.available, false)
    assert.equal(action.seam, '')
    assert.equal(action.pending, 'ACTION_SEAM_NOT_WIRED')
    assert.equal(action.pendingText, '待后端接入（pending: ACTION_SEAM_NOT_WIRED）')
    assert.ok(action.reasonText !== '', '禁用动作必须给出原因文案')
  }
  assert.deepEqual(
    view.actionList.map((action) => action.key),
    ['screening_decide', 'interview_schedule', 'transcript_import', 'stage_advance', 'decision_record', 'rubric_approve', 'recruiting_settings_write'],
  )

  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('NaN'), false, '序列化后不能出现 NaN')
  assert.equal(serialized.includes('undefined'), false, '序列化后不能出现 undefined')
})

test('坏类型 overview：字符串/NaN/负数/坏数组一律降级，不抛错、不出现 [object Object]', () => {
  const view = normalizeOverviewView({
    configured: 'yes',
    contract_version: 42,
    evaluated_at: 'not-a-date',
    actor: [],
    labels: 'oops',
    issues: [1, '', ' 缺 RECRUITMENT_DB_PASSWORD '],
    counts: {
      jobs_total: '9',
      applications_total: Number.NaN,
      applications_active: -3,
      applications_by_stage: { S7: '2', S10: 1, '': 4 },
    },
    jobs: 'nope',
    applications: [
      null,
      'row',
      { application_id: 'app-1' },
      {
        candidate: { display_name: 7 },
        job: { title: 9 },
        current_stage_code: 'S7',
        progress: { next_step: { code: 'WAIT_X', label: '等待X', kind: 'WEIRD' } },
      },
    ],
    settings: {
      stage_catalog: {
        version_no: '2',
        effective_from: 'bad',
        stages: [
          { code: 'S7', label: '初筛', order: '7' },
          { code: '', label: '坏阶段' },
        ],
      },
      configs: 'x',
      departments: [{ department_id: 'd1', name: '产品' }],
      hiring_teams: {},
    },
    actions: {
      screening_decide: { available: true, seam: '', pending: '' },
      interview_schedule: { available: 'true', seam: '/recruitment/api/action/x' },
    },
  })

  assert.equal(view.configured, false)
  assert.equal(view.contractVersion, '')
  assert.equal(view.evaluatedAt, 'not-a-date')
  assert.equal(view.evaluatedAtText, '', '非法日期不得渲染成 Invalid Date')
  assert.deepEqual(view.issues, ['缺 RECRUITMENT_DB_PASSWORD'])
  assert.deepEqual(view.jobs, [], '坏 jobs 数组降级为空')
  assert.equal(view.counts.jobsTotal, 0, '字符串计数不得被当成数字')
  assert.equal(view.counts.applicationsTotal, 0)
  assert.equal(view.counts.applicationsActive, 0)
  assert.deepEqual(
    view.counts.byStage.map((row) => [row.code, row.count]),
    [
      ['S7', 0],
      ['S10', 1],
    ],
    '空阶段码应被丢弃；字符串计数降级为 0',
  )

  assert.equal(view.applications.length, 2, 'null / 字符串行必须被丢弃')
  const first = view.applications[0]
  const second = view.applications[1]
  assert.equal(first?.id, 'app-1')
  assert.equal(first?.candidateName, '（服务端未提供候选人姓名）')
  assert.equal(first?.stageLabel, '未提供阶段')
  assert.equal(first?.nextStep.hasStep, false)
  assert.equal(second?.id, '')
  assert.equal(second?.candidateName, '（服务端未提供候选人姓名）', '数字姓名不得伪装成文本')
  assert.equal(second?.jobTitle, '（服务端未提供岗位名称）')
  assert.equal(second?.stageLabel, '初筛', '阶段标签应来自 stage_catalog')
  assert.equal(second?.nextStep.code, 'WAIT_X')
  assert.equal(second?.nextStep.kind, '', '未知 kind 必须降级为空')
  assert.equal(second?.nextStep.kindLabel, '')
  assert.equal(second?.nextStep.tone, 'gray')

  assert.equal(view.settings.stageCatalog?.versionNo, 0, '字符串版本号降级为 0')
  assert.equal(view.settings.stageCatalog?.stages.length, 1, '空阶段码被丢弃')
  assert.equal(view.settings.departments.length, 1)

  // fail-closed：声明 available=true 但 seam 为空 → 仍禁用，并给出 ACTION_SEAM_MISSING
  assert.equal(view.actions.screening_decide?.available, false)
  assert.equal(view.actions.screening_decide?.pending, 'ACTION_SEAM_MISSING')
  assert.equal(view.actions.screening_decide?.pendingText, '待后端接入（pending: ACTION_SEAM_MISSING）')
  // 坏 available（字符串 'true'）不算可用
  assert.equal(view.actions.interview_schedule?.available, false)
  assert.equal(view.actions.interview_schedule?.pending, 'ACTION_SEAM_NOT_WIRED')

  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('NaN'), false)
  assert.equal(serialized.includes('undefined'), false)
  assert.equal(serialized.includes('[object Object]'), false)
})

test('下一步归并：岗位只从 job.next_step 出、申请只从 progress.next_step 出，且各只出现一次', () => {
  const overview = {
    jobs: [
      {
        job_id: 'job-1',
        title: 'AI 产品经理',
        status: 'OPEN',
        next_step: { code: 'JOB_NEXT', label: '岗位下一步唯一文案', kind: 'HUMAN_ACTION' },
      },
    ],
    applications: [
      {
        application_id: 'app-1',
        candidate: { display_name: '林知远' },
        job: { job_id: 'job-1', title: 'AI 产品经理' },
        current_stage_code: 'S7',
        // 干扰项：申请对象根上不许有 next_step（只能从 progress.next_step 出）
        next_step: { code: 'WRONG_SOURCE', label: '错误来源文案', kind: 'INFO' },
        progress: {
          next_step: { code: 'PROVIDE_SCREENING_DECISION', label: '等待初筛决定', kind: 'HUMAN_ACTION' },
        },
      },
    ],
  }
  const view = normalizeOverviewView(overview)
  const job = view.jobs[0]
  const row = view.applications[0]
  assert.ok(job !== undefined && row !== undefined)
  assert.equal(job.nextStep.code, 'JOB_NEXT')
  assert.equal(job.nextStep.label, '岗位下一步唯一文案')
  assert.equal(job.nextStep.tone, 'amber')
  assert.equal(row.nextStep.code, 'PROVIDE_SCREENING_DECISION')
  assert.equal(row.nextStep.label, '等待初筛决定')
  assert.equal(row.nextStep.kindLabel, '需要人工处理')

  const serialized = JSON.stringify(view)
  assert.equal(occurrences(serialized, '岗位下一步唯一文案'), 1, '岗位下一步只能出现一次')
  assert.equal(occurrences(serialized, '等待初筛决定'), 1, '申请下一步只能出现一次')
  assert.equal(occurrences(serialized, '错误来源文案'), 0, '不得从 progress 之外的地方取下一步')

  const steps = collectNextSteps(view)
  assert.deepEqual(
    [...steps].sort(),
    ['JOB_NEXT', 'PROVIDE_SCREENING_DECISION', '岗位下一步唯一文案', '等待初筛决定'].sort(),
  )
  assert.deepEqual(view.nextStepTotals, { info: 0, human: 1, wait: 0, missing: 0 }, 'aside 只聚合申请级下一步（岗位级不重复计入）')
})

test('阶段与状态映射：job / lifecycle / parse / interview / scorecard / decision / transcript', () => {
  const view = normalizeOverviewView(fullOverview())
  const job = view.jobs[0]
  const row = view.applications[0]
  assert.ok(job !== undefined && row !== undefined)

  // 岗位状态
  assert.equal(job.statusLabel, '招聘中')
  assert.equal(job.statusTone, 'green')
  assert.equal(view.jobs[1]?.statusLabel, '草案')
  assert.equal(view.jobs[1]?.statusTone, 'gray')
  // rubric 摘要（O13：岗位**当前**评分标准自带标签，与「本申请钉住」分列）
  assert.equal(job.rubric?.summaryText, '岗位当前 Rubric v2 · 3 个维度 · 已批准')
  assert.equal(job.rubric?.tone, 'green')
  // 阶段：stage_catalog 的标签优先于内置默认
  assert.equal(row.stageCode, 'S7')
  assert.equal(row.stageLabel, '初筛（目录）')
  assert.equal(row.stageTone, 'amber')
  // lifecycle
  assert.equal(row.lifecycleLabel, '进行中')
  assert.equal(row.lifecycleTone, 'green')
  // 材料解析
  assert.equal(row.material?.parseLabel, '解析完成')
  assert.equal(row.material?.parseTone, 'green')
  assert.equal(row.material?.validationLabel, '校验通过')
  assert.equal(row.material?.byteSizeText, '2.5 MB')
  assert.equal(row.material?.sha256Text, 'aaaaaaaaaa…')
  assert.equal(row.material?.pageCountText, '3 页')
  assert.equal(row.material?.hashAligned, true)
  assert.equal(row.materialSummary, '解析完成 · 3 页')
  assert.equal(row.materialTone, 'green')
  // 初筛缺失 + 面试为空 + 面评 + 转写
  assert.equal(row.screening, null)
  assert.equal(row.screeningSummary, '未初筛')
  assert.equal(row.screeningTone, 'gray')
  assert.equal(row.interviewSummary, '未排期')
  assert.equal(row.interviewTone, 'gray')
  assert.equal(row.scorecardProgress.summaryText, '无需面评')
  assert.equal(row.transcriptSummary, '还没有转写')
  assert.equal(row.transcriptTone, 'amber')
  // 计数与设置
  assert.equal(view.counts.applicationsTotal, 4)
  assert.deepEqual(
    view.counts.byStage.map((entry) => [entry.code, entry.label, entry.count]),
    [
      ['S7', '初筛（目录）', 2],
      ['S9', '面试执行与材料获取', 1],
      ['S10', '决策（目录）', 1],
    ],
  )
  assert.equal(view.settings.stageCatalog?.versionNo, 2)
  assert.equal(view.settings.entry.note, '设置写入口尚未接线（只读展示）')
})

test('写动作禁用态：available=false 必有 pending 文案；available=true 才给 seam 与可用态', () => {
  const view = normalizeOverviewView({
    actions: {
      screening_decide: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      decision_record: { available: true, seam: '/recruitment/api/action/decision', pending: null },
      stage_advance: { available: false, seam: '/recruitment/api/action/stage', pending: null },
      transcript_import: { available: true, seam: '', pending: null },
    },
  })
  const screening = view.actions.screening_decide
  const decision = view.actions.decision_record
  const stage = view.actions.stage_advance
  const transcript = view.actions.transcript_import
  assert.ok(screening !== undefined && decision !== undefined && stage !== undefined && transcript !== undefined)

  assert.equal(screening.available, false)
  assert.equal(screening.pending, 'ACTION_SEAM_NOT_WIRED')
  assert.equal(screening.pendingText, '待后端接入（pending: ACTION_SEAM_NOT_WIRED）')
  assert.ok(screening.reasonText.includes('尚未接线'))

  assert.equal(decision.available, true)
  assert.equal(decision.seam, '/recruitment/api/action/decision')
  assert.equal(decision.pending, '')
  assert.equal(decision.pendingText, '')

  assert.equal(stage.available, false, 'available=false 即使有 seam 也不可用')
  assert.equal(stage.pending, 'ACTION_SEAM_NOT_WIRED')
  assert.ok(stage.pendingText.includes('ACTION_SEAM_NOT_WIRED'))

  assert.equal(transcript.available, false, 'available=true 但 seam 为空必须 fail-closed')
  assert.equal(transcript.pending, 'ACTION_SEAM_MISSING')
  assert.equal(transcript.seam, '')

  // 未声明的动作键按不可用渲染（按钮集合稳定）
  assert.equal(view.actions.rubric_approve?.available, false)
  assert.equal(view.actions.rubric_approve?.seam, '')
})

test('格式化边界：时间 / 字节数 / sha256 / 文本 / 计数', () => {
  assert.equal(formatDateTime(null), '')
  assert.equal(formatDateTime(''), '')
  assert.equal(formatDateTime('not-a-date'), '')
  assert.equal(formatDateTime('2026-11-15T04:05:06.000Z'), expectedLocalDateTime('2026-11-15T04:05:06.000Z'))
  assert.match(formatDateTime('2026-11-15T04:05:06.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(1048576), '1.0 MB')
  assert.equal(formatBytes(2621440), '2.5 MB')
  assert.equal(formatBytes(null), '')
  assert.equal(formatBytes(-1), '')
  assert.equal(formatBytes(Number.NaN), '')
  assert.equal(formatBytes('1048576'), '')

  assert.equal(shortSha(''), '')
  assert.equal(shortSha(null), '')
  assert.equal(shortSha('short'), 'short')
  assert.equal(shortSha('a'.repeat(64)), 'aaaaaaaaaa…')
  assert.equal(shortSha('A'.repeat(16)), 'AAAAAAAAAA…')

  assert.equal(text(42), '')
  assert.equal(text('  值  '), '值')
  assert.equal(count('9'), 0)
  assert.equal(count(Number.NaN), 0)
  assert.equal(count(-3), 0)
  assert.equal(count(3.7), 3)
})

/** 一个结构完整、类型正确的申请详情 fixture。 */
function fullDetail(): Record<string, unknown> {
  const material = {
    resume_version_id: 'resv-1',
    resume_id: 'res-1',
    asset_id: 'asset-1',
    file_name: '陈芊_简历.pdf',
    mime_type: 'application/pdf',
    byte_size: 2621440,
    sha256: 'b'.repeat(64),
    source_asset_sha256: 'b'.repeat(64),
    source_hash_aligned: true,
    validation_status: 'VALID',
    parse_status: 'PARSED',
    parser_name: 'pymupdf',
    parser_version: '1.24.0',
    page_count: 4,
    field_states: { education: 'present', email: 'present' },
    entry_counts: { work: 2, education: 1 },
    evidence_count: 6,
  }
  return {
    contract_version: 'recruiting-overview 1.0.0',
    evaluated_at: '2026-11-15T04:05:06.000Z',
    actor: { actor_id: 'actor-103', display_name: '演示-HR 专员', roles: ['RECRUITER'] },
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    application: {
      application_id: 'app-1',
      candidate: { candidate_id: 'cand-1', display_name: '陈芊' },
      job: { job_id: 'job-1', code: 'JOB-001', title: 'AI 产品经理' },
      lifecycle_status: 'ACTIVE',
      current_stage_code: 'S10',
      stage_entered_at: '2026-11-14T02:00:00.000Z',
      applied_at: '2026-11-11T02:00:00.000Z',
      stage_blocked_reason: null,
      record_version: 7,
      material,
      screening: {
        decision_id: 'dec-1',
        result: 'ADVANCE',
        stage_code: 'S7',
        reason: '简历与岗位要求匹配',
        decided_at: '2026-11-12T02:00:00.000Z',
        decided_by_actor_id: 'actor-103',
        decided_by_display_name: '演示-HR 专员',
        rubric_version_id: 'rv-1',
        basis_kinds: ['SCREENING_EVALUATION', 'RESUME_EVIDENCE'],
        evaluation: {
          verdict: 'ADVANCE',
          provenance: 'LIVE',
          criteria_evaluated: true,
          evaluation_digest: 'c'.repeat(64),
          resume_version_id: 'resv-1',
          rubric_version_id: 'rv-1',
        },
      },
      interviews: [
        {
          interview_id: 'iv-1',
          round_no: 1,
          slot_code: 'A',
          stage_code: 'S9',
          status: 'POST_INTERVIEW',
          scheduled_start_at: '2026-11-14T06:00:00.000Z',
          scheduled_end_at: '2026-11-14T07:00:00.000Z',
          timezone: 'Asia/Shanghai',
          interviewers: [
            {
              interviewer_row_id: 'ir-1',
              actor_id: 'a1',
              display_name: '面试官 甲',
              role_in_interview: '主面',
              required_scorecard: true,
              scorecard_due_at: '2026-11-13T00:00:00.000Z',
              scorecard: {
                scorecard_id: 'sc-1',
                interview_id: 'iv-1',
                interviewer_id: 'a1',
                interviewer_display_name: '面试官 甲',
                status: 'SUBMITTED',
                overall: 'ADVANCE',
                revision_no: 1,
                submitted_at: '2026-11-14T08:00:00.000Z',
              },
            },
            {
              interviewer_row_id: 'ir-2',
              actor_id: 'a2',
              display_name: '面试官 乙',
              required_scorecard: true,
              scorecard_due_at: '2026-11-13T00:00:00.000Z',
              scorecard: null,
            },
          ],
          scorecards: { required_total: 2, submitted: 1, missing_total: 1, overdue: 1 },
          transcript: {
            state: 'READY',
            artifact_id: 'd'.repeat(64),
            transcript_status: 'READY',
            provenance: 'LIVE',
            trigger_mode: 'EVENT',
            connection_state: 'CONNECTED',
            is_complete: true,
            is_canonical: true,
            segment_count: 42,
            interview_record: {
              interview_record_id: 'rec-1',
              status: 'VERIFIED',
              verification_status: 'OK',
              evidence_ok: true,
              is_current: true,
              chunk_coverage: 1,
            },
          },
        },
      ],
      decisions: [
        {
          decision_id: 'dec-1',
          decision_scope: 'SCREENING',
          stage_code: 'S7',
          result: 'ADVANCE',
          reason: '简历与岗位要求匹配',
          decided_at: '2026-11-12T02:00:00.000Z',
          decided_by_display_name: '演示-HR 专员',
          is_current: true,
          superseded_by_decision_id: null,
          basis_kinds: ['SCREENING_EVALUATION'],
        },
        {
          decision_id: 'dec-0',
          decision_scope: 'FINAL',
          stage_code: 'S10',
          result: 'HOLD',
          reason: '历史结论',
          decided_at: '2026-11-13T02:00:00.000Z',
          decided_by_display_name: '演示-HR 专员',
          is_current: false,
          superseded_by_decision_id: 'dec-1',
          basis_kinds: [],
        },
      ],
      progress: {
        scorecards_required: 2,
        scorecards_submitted: 1,
        transcript_state: 'READY',
        next_step: { code: 'PROVIDE_DECISION', label: '等待招聘决策', kind: 'HUMAN_ACTION' },
      },
    },
    resume: {
      material,
      fields: [
        { key: 'education', state: 'present', provenance: 'RESUME_TEXT', entry_count: 2, value_preview: '某大学 学士' },
        { key: 'email', state: 'present', provenance: null, entry_count: null, value_preview: null },
      ],
      work_entries: [{ company: 'ACME', title: '产品经理', start: '2023-01', end: null }],
      education_entries: [{ text: '某大学 学士', start: '2019', end: '2023' }],
      evidence_samples: [{ field: 'work', page: 2, quote: '负责 Agent 产品设计', block: 5 }],
    },
    screening_evidence: {
      decision: {
        decision_id: 'dec-1',
        result: 'ADVANCE',
        stage_code: 'S7',
        reason: '简历与岗位要求匹配',
        decided_at: '2026-11-12T02:00:00.000Z',
        decided_by_display_name: '演示-HR 专员',
        rubric_version_id: 'rv-1',
        basis_kinds: ['SCREENING_EVALUATION'],
        evaluation: {
          verdict: 'ADVANCE',
          provenance: 'LIVE',
          criteria_evaluated: true,
          evaluation_digest: 'c'.repeat(64),
          resume_version_id: 'resv-1',
          rubric_version_id: 'rv-1',
        },
      },
      rubric: {
        rubric_version_id: 'rv-1',
        version_no: 3,
        dimensions: [
          { key: 'depth', kind: 'SCALE', label: '深度', weight: 1, operator: 'gte', value: 3, question: '讲一个复杂项目' },
        ],
      },
      basis: [{ kind: 'SCREENING_EVALUATION', detail: { verdict: 'ADVANCE' } }],
    },
    transcript_runs: [
      {
        run_id: 'run-1',
        artifact_id: 'd'.repeat(64),
        status: 'SUCCEEDED',
        chunk_total: 12,
        chunk_succeeded: 12,
        chunk_failed: 0,
        model_id: 'asr-demo',
      },
    ],
    timeline: [
      { at: '2026-11-11T02:00:00.000Z', kind: 'APPLIED', label: '候选人提交申请', ref_id: 'app-1' },
    ],
    actions: {
      screening_decide: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      interview_schedule: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      transcript_import: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      stage_advance: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      decision_record: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      rubric_approve: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
      recruiting_settings_write: { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' },
    },
  }
}

test('岗位排序与 title 兜底：OPEN 且申请最多优先；空白 title 回退 code；侧栏只列在招/草案', () => {
  const view = normalizeOverviewView({
    jobs: [
      // 真实演示库里存在这类脏岗位：title 为空串、已归档、0 申请（曾经被默认选中）
      {
        job_id: 'job-arch',
        code: 'JOB-20261114-77CD5B',
        title: '',
        status: 'ARCHIVED',
        application_counts: { total: 0, active: 0, by_stage: {} },
        created_at: '2026-11-14T01:00:00.000Z',
      },
      {
        job_id: 'job-open-old',
        code: 'DEMO-OLD',
        title: '老岗位',
        status: 'OPEN',
        application_counts: { total: 5, active: 5, by_stage: {} },
        created_at: '2026-11-10T01:00:00.000Z',
      },
      {
        job_id: 'job-open-main',
        code: 'DEMO-BE-001',
        title: '后端工程师（演示）',
        status: 'OPEN',
        application_counts: { total: 44, active: 40, by_stage: { S8: 2 } },
        created_at: '2026-11-12T01:00:00.000Z',
      },
      {
        job_id: 'job-draft',
        code: 'JOB-DRAFT',
        title: '   ',
        status: 'DRAFT',
        application_counts: { total: 1, active: 1, by_stage: {} },
        created_at: '2026-11-13T01:00:00.000Z',
      },
      {
        job_id: 'job-tie-new',
        code: 'TIE-NEW',
        title: '同量新岗位',
        status: 'OPEN',
        application_counts: { total: 5, active: 5, by_stage: {} },
        created_at: '2026-11-13T01:00:00.000Z',
      },
      {
        job_id: 'job-paused',
        code: 'JOB-PAUSED',
        title: '暂停岗位',
        status: 'PAUSED',
        application_counts: { total: 9, active: 0, by_stage: {} },
      },
      {
        job_id: 'job-unknown',
        code: 'JOB-WEIRD',
        title: '未知状态岗位',
        status: 'WEIRD',
        application_counts: { total: 99, active: 0, by_stage: {} },
      },
    ],
  })

  // 排序：OPEN(申请数降序 → created_at 降序) → DRAFT → PAUSED → 未知 → ARCHIVED
  assert.deepEqual(
    view.jobs.map((job) => job.id),
    ['job-open-main', 'job-tie-new', 'job-open-old', 'job-draft', 'job-paused', 'job-unknown', 'job-arch'],
  )
  // 默认选中 = 排序后的第一个岗位
  assert.equal(view.jobs[0]?.id, 'job-open-main')
  assert.equal(view.jobs[0]?.code, 'DEMO-BE-001')
  assert.equal(view.jobs[0]?.title, '后端工程师（演示）')
  assert.equal(view.jobs[0]?.applicationCounts.total, 44)
  // 空白 / 空串 title 回退 code；未知状态原样显示
  assert.equal(view.jobs.find((job) => job.id === 'job-arch')?.title, 'JOB-20261114-77CD5B')
  assert.equal(view.jobs.find((job) => job.id === 'job-draft')?.title, 'JOB-DRAFT')
  assert.equal(view.jobs.find((job) => job.id === 'job-unknown')?.statusLabel, 'WEIRD')
  assert.ok(view.jobs.every((job) => job.title !== ''), '任何岗位都不应渲染空标题')

  // 侧栏分组：OPEN + DRAFT 进"正在招聘"，其余进归档折叠区；两组都不丢岗位
  const { active, archived } = splitSidebarJobs(view.jobs)
  assert.deepEqual(
    active.map((job) => job.id),
    ['job-open-main', 'job-tie-new', 'job-open-old', 'job-draft'],
  )
  assert.deepEqual(
    archived.map((job) => job.id),
    ['job-paused', 'job-unknown', 'job-arch'],
  )
  assert.equal(active.length + archived.length, view.jobs.length)
})

test('详情：下一步只出现一次；头部没有 nextStep；材料/面试/面评/转写/决策各自归一化', () => {
  const detail = normalizeApplicationDetail(fullDetail())

  assert.equal(detail.nextStep.code, 'PROVIDE_DECISION')
  assert.equal(detail.nextStep.label, '等待招聘决策')
  assert.equal(detail.nextStep.kindLabel, '需要人工处理')
  assert.equal(detail.header.stageLabel, '综合评价与招聘决策', 'S10 默认阶段名')
  assert.equal(detail.header.lifecycleLabel, '进行中')
  assert.equal('nextStep' in detail.header, false, '头部不得再带一份下一步（同一事项只出现一次）')
  assert.equal('application' in detail, false, '详情不应再嵌套一份 application 行')
  assert.equal(occurrences(JSON.stringify(detail), '等待招聘决策'), 1)

  // 材料
  assert.equal(detail.material?.fileName, '陈芊_简历.pdf')
  assert.equal(detail.material?.byteSizeText, '2.5 MB')
  assert.equal(detail.material?.sha256Text, 'bbbbbbbbbb…')
  assert.equal(detail.material?.fieldStates.length, 2)
  // 简历
  assert.equal(detail.resume?.fields[0]?.valuePreview, '某大学 学士')
  assert.equal(detail.resume?.fields[1]?.valuePreview, '', 'PII 字段（email）preview 恒为空')
  assert.equal(detail.resume?.workEntries[0]?.end, '', 'null end 降级为空串')
  assert.equal(detail.resume?.evidenceSamples[0]?.quote, '负责 Agent 产品设计')
  // 初筛证据
  assert.equal(detail.screeningEvidence.decision?.resultLabel, '通过')
  assert.equal(detail.screeningEvidence.decision?.resultTone, 'green')
  assert.equal(detail.screeningEvidence.decision?.evaluation?.criteriaEvaluated, true)
  assert.equal(detail.screeningEvidence.decision?.evaluation?.evaluationDigestText, 'cccccccccc…')
  assert.equal(detail.screeningEvidence.rubric?.versionNo, 3)
  assert.equal(detail.screeningEvidence.rubric?.dimensions[0]?.valuePreview, '3')
  assert.equal(detail.screeningEvidence.basis[0]?.kind, 'SCREENING_EVALUATION')
  assert.ok(detail.screeningEvidence.basis[0]?.detailText.includes('ADVANCE'))
  // 面试
  const interview = detail.interviews[0]
  assert.ok(interview !== undefined)
  assert.equal(interview.stageLabel, '面试执行与材料获取')
  assert.equal(interview.statusLabel, '面试后')
  assert.equal(interview.statusTone, 'amber')
  assert.match(interview.scheduledStartText, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(interview.interviewers.length, 2)
  assert.equal(interview.interviewers[0]?.scorecard?.statusLabel, '已提交')
  assert.equal(interview.interviewers[0]?.scorecard?.overallLabel, '建议推进')
  assert.equal(interview.interviewers[1]?.scorecard, null)
  assert.equal(interview.scorecards.summaryText, '已提交 1/2（第 1 轮）')
  assert.equal(interview.scorecards.tone, 'red', '有逾期未提交的面评 → 红色')
  // 转写（独立分支，不由排期推断）
  const transcript = interview.transcript
  assert.equal(transcript.stateLabel, '已收到')
  assert.equal(transcript.stateTone, 'green')
  assert.equal(transcript.artifactIdText, 'dddddddddd…')
  assert.equal(transcript.isCanonical, true)
  assert.equal(transcript.segmentCount, 42)
  assert.equal(transcript.record?.chunkCoverageText, '100%')
  assert.equal(transcript.labels.rows[0]?.value, 'LIVE')
  // 面评进度 / 转写摘要
  assert.equal(detail.scorecardProgress.summaryText, '已提交 1/2')
  assert.equal(detail.transcriptSummary, '已收到')
  assert.equal(detail.transcriptRuns[0]?.chunkTotal, 12)
  // 决策（含历史）
  assert.equal(detail.decisions.length, 2)
  assert.equal(detail.decisions[0]?.scopeLabel, '初筛')
  assert.equal(detail.decisions[0]?.isCurrent, true)
  assert.equal(detail.decisions[1]?.isCurrent, false)
  assert.equal(detail.decisions[1]?.supersededBy, 'dec-1')
  // 时间线
  assert.equal(detail.timeline[0]?.kindLabel, '提交申请')
  // 动作
  assert.equal(detail.actionList.length, 7)
  assert.equal(detail.actions.decision_record?.available, false)

  const serialized = JSON.stringify(detail)
  assert.equal(serialized.includes('NaN'), false)
  assert.equal(serialized.includes('undefined'), false)
})

test('详情坏类型：material/resume/decision/面试/时间线/transcript_runs 一律降级为空，不抛错', () => {
  const detail = normalizeApplicationDetail({
    application: {
      application_id: 'app-9',
      candidate: { display_name: null },
      job: { title: 9 },
      lifecycle_status: 'WEIRD',
      current_stage_code: 'S10',
      progress: { scorecards_required: '2', scorecards_submitted: -1, transcript_state: 'WEIRD', next_step: null },
    },
    resume: {
      material: { file_name: '', resume_version_id: '', sha256: '' },
      fields: [
        { key: '', state: 'present' },
        { key: 'education', state: 'present', entry_count: '2', value_preview: null },
      ],
      work_entries: [{}],
      education_entries: [{}],
      evidence_samples: [{ field: 'work', quote: '' }],
    },
    screening_evidence: {
      decision: { decision_id: '', result: '', reason: '' },
      rubric: {
        version_no: 0,
        dimensions: [
          { key: '', label: 'x' },
          { key: 'd1', label: '' },
        ],
      },
      basis: [{ kind: '', detail: {} }, { kind: 'SCREENING_EVALUATION', detail: { verdict: 'ADVANCE' } }],
    },
    transcript_runs: [
      { run_id: '', artifact_id: '' },
      { run_id: 'r1', artifact_id: 'e'.repeat(64), chunk_total: '3', chunk_succeeded: 2, chunk_failed: 0 },
    ],
    timeline: [null, { at: 'bad', kind: 'WEIRD', label: '' }, 'x'],
    actions: {},
  })

  assert.equal(detail.header.candidateName, '（服务端未提供候选人姓名）')
  assert.equal(detail.header.jobTitle, '（服务端未提供岗位名称）')
  assert.equal(detail.header.lifecycleLabel, 'WEIRD', '未知 lifecycle 原样显示，不编造中文')
  assert.equal(detail.header.lifecycleTone, 'gray')
  assert.equal(detail.nextStep.hasStep, false)
  assert.equal(detail.material, null, '空材料降级为 null')
  assert.equal(detail.resume, null, '没有材料就没有简历段')
  assert.equal(detail.screeningEvidence.decision, null, '空决定降级为 null')
  assert.equal(detail.screeningEvidence.rubric?.dimensions.length, 1, '无 key 维度被丢弃')
  assert.equal(detail.screeningEvidence.rubric?.dimensions[0]?.label, 'd1', '缺 label 时用 key 兜底')
  assert.equal(detail.screeningEvidence.basis.length, 1, '空 kind 的 basis 被丢弃')
  assert.equal(detail.interviews.length, 0)
  assert.equal(detail.transcriptRuns.length, 1)
  assert.equal(detail.transcriptRuns[0]?.chunkTotal, 0, '字符串计数降级为 0')
  assert.equal(detail.transcriptRuns[0]?.artifactIdText, 'eeeeeeeeee…')
  assert.equal(detail.timeline.length, 1)
  assert.equal(detail.timeline[0]?.kindLabel, 'WEIRD')
  assert.equal(detail.timeline[0]?.atText, '', '非法时间降级为空串')
  assert.equal(detail.scorecardProgress.required, 0)
  assert.equal(detail.scorecardProgress.summaryText, '无需面评')
  assert.equal(detail.transcriptSummary, '状态未知')
  assert.equal(detail.transcriptTone, 'gray')
  assert.equal(detail.actionList.length, 7)
  for (const action of detail.actionList) assert.equal(action.available, false)

  const serialized = JSON.stringify(detail)
  assert.equal(serialized.includes('NaN'), false)
  assert.equal(serialized.includes('undefined'), false)
})

test('岗位详情：空响应降级；rubric 的 approved 从岗位卡合并，不另造字段', () => {
  const empty = normalizeJobDetail({})
  assert.equal(empty.job.title, '（服务端未提供岗位名称）')
  assert.equal(empty.job.statusLabel, '状态未知')
  assert.equal(empty.descriptionMd, '')
  assert.equal(empty.requirementsMd, '')
  assert.deepEqual(empty.versions, [])
  assert.equal(empty.rubric, null)
  assert.deepEqual(empty.applications, [])
  assert.equal(empty.actionList.length, 7)
  assert.equal(JSON.stringify(empty).includes('NaN'), false)

  const detail = normalizeJobDetail({
    job: {
      job_id: 'job-1',
      code: 'JOB-001',
      title: 'AI 产品经理',
      status: 'OPEN',
      version_no: 3,
      rubric: { rubric_version_id: 'rv-1', version_no: 2, approved: true, dimension_count: 1 },
      next_step: { code: 'JOB_NEXT', label: '岗位待补充 rubric', kind: 'HUMAN_ACTION' },
    },
    versions: [
      { job_version_id: 'jv-1', version_no: 3, payload_hash: 'f'.repeat(64), created_at: '2026-11-10T02:00:00.000Z', approved: true },
      { job_version_id: '', version_no: 0, payload_hash: '', created_at: null, approved: false },
    ],
    rubric: { version_no: 2, dimensions: [{ key: 'depth', label: '深度', kind: 'SCALE', weight: 1 }] },
    applications: [{ application_id: 'app-1', candidate: { display_name: '林知远' }, current_stage_code: 'S7' }],
    actions: {},
  })
  assert.equal(detail.job.statusLabel, '招聘中')
  assert.equal(detail.versions.length, 1, '空版本行被丢弃')
  assert.equal(detail.versions[0]?.payloadHashText, 'ffffffffff…')
  assert.equal(detail.rubric?.approved, true, 'approved 来自 job.rubric，不编造')
  assert.equal(detail.rubric?.dimensions[0]?.label, '深度')
  assert.equal(detail.applications.length, 1)
  assert.equal(detail.applications[0]?.stageLabel, '初筛', '岗位详情没有 stage_catalog 时用内置默认阶段名')
  assert.equal(detail.job.nextStep.code, 'JOB_NEXT')
  assert.equal(occurrences(JSON.stringify(detail), '岗位待补充 rubric'), 1)
  assert.equal(detail.actionList.length, 7)
})

test('O9/O13/O7 口径：面评跨轮份数读出轮次；申请钉住 Rubric 与岗位当前分开；转写只给事实时态', () => {
  // O9：0/3 的 3 是「跨轮应提交份数」（第 1 轮 1 份 + 第 2 轮 2 份），不是 3 个面试官。
  const interviews = buildInterviews([
    { interview_id: 'iv-1', round_no: 1, scorecards: { required_total: 1, submitted: 0, missing_total: 1, overdue: 0 } },
    { interview_id: 'iv-2', round_no: 2, scorecards: { required_total: 2, submitted: 0, missing_total: 2, overdue: 0 } },
  ])
  const progress = buildScorecardProgress({ scorecards_required: 3, scorecards_submitted: 0 }, interviews)
  assert.equal(progress.summaryText, '已提交 0/3（第 1 轮 1 份 / 第 2 轮 2 份）')
  assert.deepEqual(
    progress.rounds.map((round) => [round.roundNo, round.required]),
    [
      [1, 1],
      [2, 2],
    ],
  )
  // 逐轮之和 ≠ 聚合 required 时只给总数（不编造轮次口径）。
  const mismatch = buildScorecardProgress({ scorecards_required: 9, scorecards_submitted: 0 }, interviews)
  assert.equal(mismatch.summaryText, '已提交 0/9（跨 2 轮合计）')
  assert.deepEqual(mismatch.rounds, [])

  // O13：申请钉住的版本（wire `application.rubric`）与岗位当前版本是两个事实，各自带标签。
  const pinned = buildApplicationHeader({
    application_id: 'app-9',
    job: { job_id: 'job-1' },
    rubric: { version_no: 1, approved: false },
  })
  assert.deepEqual(pinned.applicationRubric, { versionNo: 1, approved: false })
  assert.equal(applicationRubricTextOf(pinned.applicationRubric), 'v1 · 未批准')
  assert.equal(applicationRubricTextOf(null), '未钉住')
  const noPin = buildApplicationHeader({ application_id: 'app-9', job: { job_id: 'job-1' } })
  assert.equal(noPin.applicationRubric, null, '没有钉住就是 null，不猜一个看起来对的版本')

  // O7：转写只允许事实时态（D-133：禁止「缺失」缺件叙事）。
  assert.equal(transcriptSummaryOf('MISSING').summary, '还没有转写')
  assert.equal(transcriptSummaryOf('NOT_READY').summary, '还没有转写')
  assert.equal(transcriptSummaryOf('FAILED').summary, '处理失败')
  assert.equal(transcriptSummaryOf('READY').summary, '已收到')
})
