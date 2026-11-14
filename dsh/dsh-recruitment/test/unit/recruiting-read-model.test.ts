// Recruiting Workspace 只读投影（W2-A）的**单测**（不需要数据库）。
//
// 覆盖四块：
//   1. `actionCapabilities`：唯一动作判定点的形状（缺省全禁用 / 部分接线）；
//   2. `unconfiguredRecruitingOverview`：未配置时形状完整（configured=false、读数全 0、issues 透传）；
//   3. 纯派生函数（不碰 DB）：next-step / job next-step / transcript-state / field_states /
//      quote 截断 / PII 过滤 / 简历段映射 / 初筛证据投影；
//   4. 路由注册面（`database = null` 时在碰 DB 之前返回）：403 / 400 ACTOR_OVERRIDE_REJECTED /
//      未配置 overview 200 / 详情 503 / 非回环不注册。
//
// 全部断言都不连库；真库断言在 `test/integration/recruiting-overview.test.ts`。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionCapabilities,
  aggregateTranscriptState,
  deriveApplicationNextStep,
  deriveBasisKinds,
  deriveEducationEntries,
  deriveEntryCounts,
  deriveEvidenceSamples,
  deriveFieldStates,
  deriveJobNextStep,
  derivePageCount,
  deriveResumeFields,
  deriveScreeningEvaluation,
  deriveScreeningRubricVersionId,
  deriveSourceHashAligned,
  deriveWorkEntries,
  isPiiField,
  previewOf,
  RECRUITING_CONTRACT_VERSION,
  registerRecruitingHttp,
  transcriptStateOf,
  truncateQuote,
  unconfiguredRecruitingOverview,
  type ApplicationGateFacts,
  type RecruitingActionKey,
  type RecruitingHostContext,
} from '../../src/http/recruiting.ts'

const ACTION_KEYS: readonly RecruitingActionKey[] = [
  'screening_decide',
  'interview_schedule',
  'transcript_import',
  'stage_advance',
  'decision_record',
  'rubric_approve',
  'recruiting_settings_write',
]

/** 造一份「S6 材料已就绪、无待办」的基准事实（各用例只覆盖关心的字段）。 */
function facts(overrides: Partial<ApplicationGateFacts> = {}): ApplicationGateFacts {
  return {
    lifecycle_status: 'ACTIVE',
    current_stage_code: 'S6',
    has_material: true,
    parse_status: 'PARSED',
    has_current_screening_decision: false,
    has_scheduled_interview: false,
    has_post_interview_scorecard_gap: false,
    has_current_stage_decision: false,
    ...overrides,
  }
}

// =====================================================================
//  1. actionCapabilities（唯一判定点）
// =====================================================================

test('actionCapabilities({})：7 个动作全部 available=false / seam=null / pending=ACTION_SEAM_NOT_WIRED', () => {
  const capabilities = actionCapabilities({})
  assert.deepEqual(Object.keys(capabilities).sort(), [...ACTION_KEYS].sort(), '只允许封闭集里的 7 个键')
  for (const key of ACTION_KEYS) {
    assert.deepEqual(capabilities[key], {
      available: false,
      seam: null,
      pending: 'ACTION_SEAM_NOT_WIRED',
    }, `${key} 缺省必须禁用`)
  }
})

test('actionCapabilities 部分接线：给了 seam 的可用，空串/未给的一律禁用（不猜路径）', () => {
  const capabilities = actionCapabilities({
    screening_decide: '/recruitment/api/action/screening/decide',
    decision_record: '',
    rubric_approve: '/recruitment/api/action/rubric/approve',
  })
  assert.deepEqual(capabilities.screening_decide, {
    available: true,
    seam: '/recruitment/api/action/screening/decide',
    pending: null,
  })
  assert.deepEqual(capabilities.rubric_approve, {
    available: true,
    seam: '/recruitment/api/action/rubric/approve',
    pending: null,
  })
  assert.deepEqual(capabilities.decision_record, {
    available: false,
    seam: null,
    pending: 'ACTION_SEAM_NOT_WIRED',
  }, '空串 seam 不算接线')
  for (const key of ['interview_schedule', 'transcript_import', 'stage_advance', 'recruiting_settings_write'] as const) {
    assert.equal(capabilities[key].available, false, `${key} 未接线必须禁用`)
    assert.equal(capabilities[key].seam, null)
  }
})

// =====================================================================
//  2. unconfiguredRecruitingOverview（形状完整、读数全 0、issues 透传）
// =====================================================================

test('unconfiguredRecruitingOverview：configured=false、读数全 0、列表空、issues 透传、动作全禁用', () => {
  const issues = ['config.database.host is required', 'environment variable RECRUITMENT_DB_PASSWORD is not set']
  const overview = unconfiguredRecruitingOverview(issues)
  assert.equal(overview.contract_version, RECRUITING_CONTRACT_VERSION)
  assert.equal(overview.configured, false)
  assert.deepEqual(overview.issues, issues, 'issues 必须原样透传（不含密码值）')
  assert.ok(Number.isFinite(Date.parse(overview.evaluated_at)), 'evaluated_at 必须是可解析的 ISO 时间')
  assert.deepEqual(overview.actor, { actor_id: '', display_name: '', roles: [] })
  assert.deepEqual(overview.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  // 13 个读数全部 0 / 空对象（形状完整，客户端不会渲染出 undefined/NaN）。
  assert.deepEqual(overview.counts, {
    jobs_total: 0,
    jobs_open: 0,
    applications_total: 0,
    applications_active: 0,
    applications_by_stage: {},
    awaiting_screening: 0,
    interviewing: 0,
    awaiting_decision: 0,
    interviews_scheduled: 0,
    scorecards_required_total: 0,
    scorecards_submitted_total: 0,
    transcripts_ready: 0,
    transcripts_pending: 0,
  })
  assert.deepEqual(overview.jobs, [])
  assert.deepEqual(overview.applications, [])
  assert.equal(overview.settings.stage_catalog, null)
  assert.deepEqual(overview.settings.configs, [])
  assert.deepEqual(overview.settings.departments, [])
  assert.deepEqual(overview.settings.hiring_teams, [])
  assert.deepEqual(overview.settings.entry, {
    available: false,
    href: null,
    note: '数据库未配置，设置数据不可读',
  })
  const capabilities = overview.actions
  for (const key of ACTION_KEYS) assert.equal(capabilities[key].available, false, `${key} 未配置时必须禁用`)
})

// =====================================================================
//  3. progress.next_step（契约 §2 的封闭 code 表；终态优先）
// =====================================================================

test('next-step：终态优先 → CLOSED（即便材料缺失/有面试也不会给出待办）', () => {
  for (const lifecycle of ['CLOSED', 'WITHDRAWN', 'ON_HOLD']) {
    const step = deriveApplicationNextStep(facts({
      lifecycle_status: lifecycle,
      has_material: false,
      has_scheduled_interview: true,
    }))
    assert.deepEqual(step, {
      code: 'CLOSED',
      label: '已结束：该申请不在办（lifecycle_status 非 ACTIVE）',
      kind: 'INFO',
    })
  }
})

test('next-step：无 material → WAIT_MATERIAL_INTAKE（WAIT）', () => {
  const step = deriveApplicationNextStep(facts({ has_material: false, parse_status: null }))
  assert.equal(step.code, 'WAIT_MATERIAL_INTAKE')
  assert.equal(step.kind, 'WAIT')
})

test('next-step：parse_status=FAILED → MATERIAL_PARSE_FAILED（HUMAN_ACTION）', () => {
  const step = deriveApplicationNextStep(facts({ parse_status: 'FAILED' }))
  assert.equal(step.code, 'MATERIAL_PARSE_FAILED')
  assert.equal(step.kind, 'HUMAN_ACTION')
})

test('next-step：PARSED / PARTIAL 都不算等待（Owner 2026-11-15 口径修正）', () => {
  // S7 + 无初筛决定：PARSED 与 PARTIAL 都走到同一条 PROVIDE_SCREENING_DECISION。
  for (const parseStatus of ['PARSED', 'PARTIAL', 'PENDING', 'NEEDS_REVIEW']) {
    const step = deriveApplicationNextStep(facts({ current_stage_code: 'S7', parse_status: parseStatus }))
    assert.equal(step.code, 'PROVIDE_SCREENING_DECISION', `parse_status=${parseStatus} 不应等待解析`)
  }
})

test('next-step：S7 且无 SCREENING 当前决定 → PROVIDE_SCREENING_DECISION；有决定则转为「安排面试」', () => {
  const pending = deriveApplicationNextStep(facts({ current_stage_code: 'S7' }))
  assert.equal(pending.code, 'PROVIDE_SCREENING_DECISION')
  assert.equal(pending.kind, 'HUMAN_ACTION')
  const decided = deriveApplicationNextStep(facts({ current_stage_code: 'S7', has_current_screening_decision: true }))
  assert.equal(decided.code, 'SCHEDULE_INTERVIEW', '初筛已有结论但还没排期 → 下一步是安排面试（Owner 2026-11-15 口径）')
})

test('next-step：初筛已有结论且未排期、停在 S7/S8/S9 → SCHEDULE_INTERVIEW；停在 S6 → ADVANCE_STAGE', () => {
  for (const stage of ['S7', 'S8', 'S9']) {
    const step = deriveApplicationNextStep(facts({
      current_stage_code: stage,
      has_current_screening_decision: true,
      has_scheduled_interview: false,
    }))
    assert.equal(step.code, 'SCHEDULE_INTERVIEW', `${stage} 应有「安排面试」下一步`)
    assert.equal(step.kind, 'HUMAN_ACTION')
    assert.ok(step.label.length > 0)
  }
  // S6 + 初筛已有结论 + 未排期 → ADVANCE_STAGE（Owner 2026-11-15 拍板：阶段指针还停在 S6）。
  const s6 = deriveApplicationNextStep(facts({
    current_stage_code: 'S6',
    has_current_screening_decision: true,
    has_scheduled_interview: false,
  }))
  assert.deepEqual(s6, {
    code: 'ADVANCE_STAGE',
    label: '推进阶段：初筛结论已记录，等待推进到下一阶段',
    kind: 'HUMAN_ACTION',
  })
  // S10 且已有当前 STAGE/FINAL 决定、未排期 → 不落到「安排面试」（S10 不在集合里）→ 兜底。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S10',
    has_current_screening_decision: true,
    has_current_stage_decision: true,
  })).code, 'IN_PROGRESS')
})

test('next-step：ADVANCE_STAGE 与相邻分支的优先级（已排期 / 面评未齐 / 无初筛决定都不归它）', () => {
  // S6 + 初筛决定 + **已排期** → PREPARE_INTERVIEW（不是推进阶段）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S6', has_current_screening_decision: true, has_scheduled_interview: true,
  })).code, 'PREPARE_INTERVIEW')
  // S6 + 初筛决定 + 面评未齐 → WAIT_SCORECARDS（面评比推进阶段更紧急）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S6',
    has_current_screening_decision: true,
    has_post_interview_scorecard_gap: true,
  })).code, 'WAIT_SCORECARDS')
  // S6 + **无**初筛决定 → 仍是 PROVIDE_SCREENING_DECISION（不是推进阶段）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S6', has_current_screening_decision: false,
  })).code, 'PROVIDE_SCREENING_DECISION')
  // S7 + 初筛决定 + 未排期 → SCHEDULE_INTERVIEW（与 ADVANCE_STAGE 分属两个阶段）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S7', has_current_screening_decision: true,
  })).code, 'SCHEDULE_INTERVIEW')
})

test('next-step：优先级 —— 已排期 > 面评未齐 > 安排面试；S10 待决策优先于安排面试', () => {
  // 已排期：PREPARE_INTERVIEW（不因为"有初筛结论"变成安排面试）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S8', has_current_screening_decision: true, has_scheduled_interview: true,
  })).code, 'PREPARE_INTERVIEW')
  // 面试已结束但面评未齐：WAIT_SCORECARDS（不能只说"安排面试"）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S9', has_current_screening_decision: true, has_post_interview_scorecard_gap: true,
  })).code, 'WAIT_SCORECARDS')
  // S10 待决策：PROVIDE_DECISION 优先（即使有初筛结论且未排期）。
  assert.equal(deriveApplicationNextStep(facts({
    current_stage_code: 'S10', has_current_screening_decision: true, has_scheduled_interview: false,
  })).code, 'PROVIDE_DECISION')
})

test('next-step：S7 初筛优先于「已排期面试」（同一申请只给一条结论）', () => {
  const step = deriveApplicationNextStep(facts({
    current_stage_code: 'S7',
    has_scheduled_interview: true,
    has_post_interview_scorecard_gap: true,
  }))
  assert.equal(step.code, 'PROVIDE_SCREENING_DECISION')
})

test('next-step：有 SCHEDULED 面试 → PREPARE_INTERVIEW（INFO）', () => {
  const step = deriveApplicationNextStep(facts({ current_stage_code: 'S6', has_scheduled_interview: true }))
  assert.equal(step.code, 'PREPARE_INTERVIEW')
  assert.equal(step.kind, 'INFO')
})

test('next-step：POST_INTERVIEW 且 required 面评未齐 → WAIT_SCORECARDS（WAIT）', () => {
  const step = deriveApplicationNextStep(facts({ current_stage_code: 'S9', has_post_interview_scorecard_gap: true }))
  assert.equal(step.code, 'WAIT_SCORECARDS')
  assert.equal(step.kind, 'WAIT')
})

test('next-step：S10 且无 STAGE/FINAL 当前决定 → PROVIDE_DECISION（HUMAN_ACTION）', () => {
  const step = deriveApplicationNextStep(facts({ current_stage_code: 'S10' }))
  assert.equal(step.code, 'PROVIDE_DECISION')
  assert.equal(step.kind, 'HUMAN_ACTION')
})

test('next-step：S6 材料已就绪但初筛未做 → PROVIDE_SCREENING_DECISION（契约未列情形，复用同语义 code）', () => {
  const step = deriveApplicationNextStep(facts({ current_stage_code: 'S6', has_current_screening_decision: false }))
  assert.equal(step.code, 'PROVIDE_SCREENING_DECISION')
  assert.equal(step.kind, 'HUMAN_ACTION')
})

test('next-step：S8 无面试 → PREPARE_INTERVIEW；无任何可执行动作 → IN_PROGRESS（最终兜底）', () => {
  const s8 = deriveApplicationNextStep(facts({ current_stage_code: 'S8' }))
  assert.equal(s8.code, 'PREPARE_INTERVIEW')
  assert.equal(s8.kind, 'INFO')
  // 最终兜底：S10 已有当前 STAGE/FINAL 决定、无排期、无其它待办 → IN_PROGRESS。
  const idle = deriveApplicationNextStep(facts({
    current_stage_code: 'S10',
    has_current_screening_decision: true,
    has_current_stage_decision: true,
  }))
  assert.equal(idle.code, 'IN_PROGRESS')
  assert.equal(idle.kind, 'INFO')
  assert.ok(idle.label.includes('推进'), 'IN_PROGRESS 的 label 要写清「等待流程推进」，不能含糊')
})

test('next-step：所有 code 的 label 非空且 kind 在封闭枚举内（INFO/HUMAN_ACTION/WAIT）', () => {
  const cases: ApplicationGateFacts[] = [
    facts({ lifecycle_status: 'CLOSED' }),
    facts({ has_material: false }),
    facts({ parse_status: 'FAILED' }),
    facts({ current_stage_code: 'S7' }),
    facts({ has_scheduled_interview: true }),
    facts({ has_post_interview_scorecard_gap: true }),
    facts({ current_stage_code: 'S10' }),
    facts({ current_stage_code: 'S8', has_current_screening_decision: true }),
    facts({ has_current_screening_decision: true }),
  ]
  for (const input of cases) {
    const step = deriveApplicationNextStep(input)
    assert.ok(typeof step.label === 'string' && step.label.length > 0, 'label 必须是非空中文句子')
    assert.ok(['INFO', 'HUMAN_ACTION', 'WAIT'].includes(step.kind), `kind 非法：${step.kind}`)
  }
})

// =====================================================================
//  4. job next_step（岗位状态 + 申请聚合）
// =====================================================================

test('job next-step：CLOSED/ARCHIVED → CLOSED；DRAFT 无申请 → JOB_DRAFT；OPEN 无申请 → WAITING_APPLICATIONS', () => {
  assert.equal(deriveJobNextStep({ status: 'ARCHIVED', application_next_steps: [] }).code, 'CLOSED')
  assert.equal(deriveJobNextStep({ status: 'CLOSED', application_next_steps: [] }).code, 'CLOSED')
  assert.equal(deriveJobNextStep({ status: 'DRAFT', application_next_steps: [] }).code, 'JOB_DRAFT')
  assert.equal(deriveJobNextStep({ status: 'PENDING_REVIEW', application_next_steps: [] }).code, 'JOB_DRAFT')
  assert.equal(deriveJobNextStep({ status: 'OPEN', application_next_steps: [] }).code, 'WAITING_APPLICATIONS')
  assert.equal(deriveJobNextStep({ status: 'PAUSED', application_next_steps: [] }).code, 'JOB_PAUSED')
})

test('job next-step：按 HUMAN_ACTION > WAIT > INFO 聚合，取最紧急的一条；label 非空', () => {
  const steps = [
    { code: 'PREPARE_INTERVIEW', label: 'x', kind: 'INFO' as const },
    { code: 'WAIT_SCORECARDS', label: 'y', kind: 'WAIT' as const },
    { code: 'PROVIDE_SCREENING_DECISION', label: 'z', kind: 'HUMAN_ACTION' as const },
  ]
  const chosen = deriveJobNextStep({ status: 'OPEN', application_next_steps: steps })
  assert.equal(chosen.code, 'PROVIDE_SCREENING_DECISION')
  assert.ok(chosen.label.length > 0)
  const waitOnly = deriveJobNextStep({
    status: 'OPEN',
    application_next_steps: steps.filter((step) => step.kind !== 'HUMAN_ACTION'),
  })
  assert.equal(waitOnly.code, 'WAIT_SCORECARDS')
  // ADVANCE_STAGE（HUMAN_ACTION）在岗位级同样有独立文案。
  const advance = deriveJobNextStep({
    status: 'OPEN',
    application_next_steps: [{ code: 'ADVANCE_STAGE', label: 'x', kind: 'HUMAN_ACTION' }],
  })
  assert.deepEqual(advance, { code: 'ADVANCE_STAGE', label: '岗位下申请等待阶段推进' })
})

// =====================================================================
//  5. transcript state（独立分支，不由排期状态推断）
// =====================================================================

test('transcriptStateOf：READY/PROCESSING/NOT_READY/FAILED/MISSING 的完整映射', () => {
  assert.equal(transcriptStateOf('READY'), 'READY')
  for (const status of ['DISCOVERED', 'FETCHING', 'PARTIAL']) {
    assert.equal(transcriptStateOf(status), 'PROCESSING', `${status} 应映射为 PROCESSING`)
  }
  for (const status of ['WAITING_EXTERNAL', 'AUTH_REQUIRED', 'NEEDS_LINKING']) {
    assert.equal(transcriptStateOf(status), 'NOT_READY', `${status} 应映射为 NOT_READY`)
  }
  assert.equal(transcriptStateOf('RETRYABLE_FAILED'), 'FAILED')
  assert.equal(transcriptStateOf(null), 'MISSING')
  assert.equal(transcriptStateOf(undefined), 'MISSING')
  assert.equal(transcriptStateOf(''), 'MISSING')
})

test('transcriptStateOf：未知字符串绝不升级成 READY（fail closed → NOT_READY）', () => {
  for (const garbage of ['whatever', 'READY ', 'ready']) {
    const state = transcriptStateOf(garbage)
    assert.notEqual(state, 'READY', '未知/脏数据不得谎报 READY')
    assert.equal(state, 'NOT_READY')
  }
  // 非字符串 = 没有状态字符串（库里 transcript_status 是 NOT NULL text）→ MISSING，不猜。
  for (const notAStatus of [42, {}, []]) {
    assert.equal(transcriptStateOf(notAStatus), 'MISSING')
  }
})

test('aggregateTranscriptState：空 → MISSING；取「离可推进最近」的状态', () => {
  assert.equal(aggregateTranscriptState([]), 'MISSING')
  assert.equal(aggregateTranscriptState(['MISSING', 'READY']), 'READY')
  assert.equal(aggregateTranscriptState(['NOT_READY', 'PROCESSING']), 'PROCESSING')
  assert.equal(aggregateTranscriptState(['MISSING', 'FAILED']), 'FAILED')
  assert.equal(aggregateTranscriptState(['MISSING', 'MISSING']), 'MISSING')
})

// =====================================================================
//  6. field_states / 简历段（PII：只给 state，不给值）
// =====================================================================

/** 与真库 `resume_version.parsed_fields` 同形的夹具（含 email/phone 原值）。 */
function parsedFieldsFixture(): Record<string, unknown> {
  return {
    meta: { pages: 8, backend: 'pymupdf/1.28.0' },
    fields: {
      name: { state: 'absent', provenance: 'unknown' },
      email: { state: 'present', provenance: 'native_text', value: 'fixture@example.com' },
      phone: { state: 'present', provenance: 'native_text', value: '138-0000-0000' },
      work_experience: {
        state: 'present',
        provenance: 'native_text',
        entry_count: 2,
        entries: [
          {
            header_text: '2025.05-2026.08 | 光合新知（北京）信息技术有限公司 | 洋葱学园 | 市场策略',
            company: '光合新知（北京）信息技术有限公司',
            title: '洋葱学园',
            dates: [{ start: { year: 2025, month: 5 }, end: { year: 2026, month: 8 }, open_ended: false }],
          },
          {
            header_text: '2024.01-2024.12 | 某公司 | 后端工程师',
            company: '某公司',
            title: '后端工程师',
            dates: [{ start: { year: 2024, month: 1 }, end: null, open_ended: true }],
          },
        ],
      },
      education: {
        state: 'present',
        provenance: 'native_text',
        entries: [
          {
            header_text: '2025.09-至今 北京语言大学 数字经济 硕士',
            dates: [{ start: { year: 2025, month: 9 }, end: null, open_ended: true }],
          },
        ],
      },
    },
  }
}

test('deriveFieldStates：只给 state；坏形状 → {}；state 非字符串的字段跳过', () => {
  assert.deepEqual(deriveFieldStates(parsedFieldsFixture()), {
    name: 'absent',
    email: 'present',
    phone: 'present',
    work_experience: 'present',
    education: 'present',
  })
  assert.deepEqual(deriveFieldStates(null), {})
  assert.deepEqual(deriveFieldStates({}), {})
  assert.deepEqual(deriveFieldStates({ fields: [] }), {})
  assert.deepEqual(deriveFieldStates({ fields: { email: { value: 'x' }, name: 'present' } }), {})
  // PII 红线：field_states 里绝不能出现邮箱/电话原值。
  const states = JSON.stringify(deriveFieldStates(parsedFieldsFixture()))
  assert.equal(states.includes('fixture@example.com'), false)
  assert.equal(states.includes('138-0000-0000'), false)
})

test('deriveEntryCounts / derivePageCount：entry_count 优先、entries 长度兜底、缺失 0/null', () => {
  assert.deepEqual(deriveEntryCounts(parsedFieldsFixture()), { work: 2, education: 1 })
  assert.deepEqual(deriveEntryCounts({ fields: { work_experience: { entries: [{}, {}, {}] } } }), { work: 3, education: 0 })
  assert.deepEqual(deriveEntryCounts(null), { work: 0, education: 0 })
  assert.equal(derivePageCount(parsedFieldsFixture()), 8)
  assert.equal(derivePageCount({ meta: { pages: 'x' } }), null)
  assert.equal(derivePageCount(null), null)
})

test('deriveResumeFields：email/phone 的 value_preview 恒 null（即使库里有原值）', () => {
  const fields = deriveResumeFields(parsedFieldsFixture())
  const byKey = new Map(fields.map((field) => [field.key, field]))
  assert.equal(byKey.get('email')?.value_preview, null, 'email 绝不能给预览')
  assert.equal(byKey.get('phone')?.value_preview, null, 'phone 绝不能给预览')
  assert.equal(byKey.get('email')?.state, 'present')
  assert.equal(byKey.get('work_experience')?.value_preview?.startsWith('2025.05-2026.08'), true)
  assert.equal(byKey.get('work_experience')?.entry_count, 2)
  assert.equal(byKey.get('education')?.value_preview?.startsWith('2025.09-至今'), true)
  const text = JSON.stringify(fields)
  assert.equal(text.includes('fixture@example.com'), false, 'JSON 里不得出现邮箱原值')
  assert.equal(text.includes('138-0000-0000'), false, 'JSON 里不得出现电话原值')
})

test('deriveResumeFields：无 state 的字段不出现（不猜）；value_preview 超 80 字符截断', () => {
  const longText = `${'长'.repeat(120)}`
  const fields = deriveResumeFields({
    fields: {
      name: { value: '张三' },
      work_experience: { state: 'present', entries: [{ header_text: longText }] },
    },
  })
  assert.deepEqual(fields.map((field) => field.key), ['work_experience'])
  assert.equal(fields[0]?.value_preview?.length, 80)
})

test('previewOf / isPiiField：PII 识别（大小写/空白/下划线）与预览截断', () => {
  for (const key of ['email', 'Email', ' phone ', 'normalized_email', 'email_address', 'mobile']) {
    assert.equal(isPiiField(key), true, `${key} 必须识别为 PII`)
  }
  for (const key of ['name', 'education', 'work_experience', 'company']) {
    assert.equal(isPiiField(key), false, `${key} 不是 PII`)
  }
  assert.equal(previewOf('email', 'fixture@example.com'), null)
  assert.equal(previewOf('company', '光合新知（北京）信息技术有限公司'), '光合新知（北京）信息技术有限公司')
  assert.equal(previewOf('company', 'x'.repeat(100))?.length, 80)
  assert.equal(previewOf('company', { nested: true }), null)
  assert.equal(previewOf('company', 42), '42')
})

test('deriveWorkEntries / deriveEducationEntries：条数与日期映射（open-ended 的 end = null）', () => {
  const work = deriveWorkEntries(parsedFieldsFixture())
  assert.equal(work.length, 2)
  assert.deepEqual(work[0], {
    company: '光合新知（北京）信息技术有限公司',
    title: '洋葱学园',
    start: '2025-05',
    end: '2026-08',
  })
  assert.equal(work[1]?.end, null, 'open-ended 区间 end 必须是 null（不编造结束时间）')
  const education = deriveEducationEntries(parsedFieldsFixture())
  assert.equal(education.length, 1)
  assert.deepEqual(education[0], {
    text: '2025.09-至今 北京语言大学 数字经济 硕士',
    start: '2025-09',
    end: null,
  })
  assert.deepEqual(deriveWorkEntries(null), [])
  assert.deepEqual(deriveEducationEntries({ fields: { education: { entries: [null, 3, 'x'] } } }), [])
})

// =====================================================================
//  7. quote 截断 / 证据样本（≤120 字符、≤12 条、跳过 PII）
// =====================================================================

test('truncateQuote：压平空白、≤120 字符、空/非字符串 → null', () => {
  assert.equal(truncateQuote('  a\n b\t c  '), 'a b c')
  assert.equal(truncateQuote('x'.repeat(200))?.length, 120)
  assert.equal(truncateQuote('短引文'), '短引文')
  assert.equal(truncateQuote(null), null)
  assert.equal(truncateQuote(undefined), null)
  assert.equal(truncateQuote('   '), null)
  assert.equal(truncateQuote(123), null)
})

test('deriveEvidenceSamples：跳过 email/phone 字段、quote 截断、上限 12 条、坏条目跳过', () => {
  const evidence = [
    { field: 'email', page: 1, block: 2, quote: 'fixture@example.com' },
    { field: 'phone', page: 1, block: 3, quote: '138-0000-0000' },
    { field: 'work_experience', page: 1, block: 10, quote: '2025.05-2026.08 | 光合新知（北京）信息技术有限公司' },
    { field: 'education', page: 1, block: 4, quote: 'y'.repeat(200) },
    { field: 'work_experience', block: 11 },
    null,
    42,
    { page: 2, quote: '没有 field 的条目' },
  ]
  const samples = deriveEvidenceSamples(evidence)
  assert.deepEqual(samples.map((sample) => sample.field), ['work_experience', 'education'])
  assert.equal(samples[0]?.page, 1)
  assert.equal(samples[0]?.block, 10)
  assert.equal(samples[1]?.quote.length, 120)
  const text = JSON.stringify(samples)
  assert.equal(text.includes('fixture@example.com'), false)
  assert.equal(text.includes('138-0000-0000'), false)

  const many = Array.from({ length: 20 }, (_, index) => ({
    field: 'work_experience',
    page: index + 1,
    block: index,
    quote: `条目 ${index}`,
  }))
  assert.equal(deriveEvidenceSamples(many).length, 12, '证据样本最多 12 条')
  assert.equal(deriveEvidenceSamples(many, 3).length, 3)
  assert.deepEqual(deriveEvidenceSamples(null), [])
  assert.deepEqual(deriveEvidenceSamples({ not: 'array' }), [])
})

// =====================================================================
//  8. 材料哈希一致性 / 初筛证据投影
// =====================================================================

test('deriveSourceHashAligned：一致 true；不一致/缺失 false（不假定对齐）', () => {
  assert.equal(deriveSourceHashAligned('a'.repeat(64), 'a'.repeat(64)), true)
  assert.equal(deriveSourceHashAligned('a'.repeat(64), 'b'.repeat(64)), false)
  assert.equal(deriveSourceHashAligned(null, 'a'.repeat(64)), false)
  assert.equal(deriveSourceHashAligned('a'.repeat(64), ''), false)
})

test('deriveBasisKinds：保持顺序、去重、跳过坏条目', () => {
  const refs = [
    { kind: 'RUBRIC_VERSION', id: 'r1' },
    { kind: 'AUTHORITY' },
    { kind: 'SCREENING_EVALUATION', verdict: 'PASS' },
    { kind: 'RUBRIC_VERSION', id: 'r2' },
    null,
    { kind: 42 },
  ]
  assert.deepEqual(deriveBasisKinds(refs), ['RUBRIC_VERSION', 'AUTHORITY', 'SCREENING_EVALUATION'])
  assert.deepEqual(deriveBasisKinds(null), [])
})

test('deriveScreeningEvaluation：只认 SCREENING_EVALUATION 分片；provenance 非 LIVE/FIXTURE → null', () => {
  const refs = [
    { kind: 'RUBRIC_VERSION', id: 'rubric-1' },
    {
      kind: 'SCREENING_EVALUATION',
      verdict: 'PASS',
      provenance: 'FIXTURE',
      criteria_evaluated: true,
      evaluation_digest: 'd'.repeat(64),
      resume_version_id: 'rv-1',
      rubric_version_id: 'rubric-1',
      resume_content_sha256: 'c'.repeat(64),
    },
  ]
  assert.deepEqual(deriveScreeningEvaluation(refs), {
    verdict: 'PASS',
    provenance: 'FIXTURE',
    criteria_evaluated: true,
    evaluation_digest: 'd'.repeat(64),
    resume_version_id: 'rv-1',
    rubric_version_id: 'rubric-1',
    resume_content_sha256: 'c'.repeat(64),
  })
  assert.equal(deriveScreeningEvaluation([{ kind: 'RUBRIC_VERSION' }]), null)
  const lying = deriveScreeningEvaluation([{ kind: 'SCREENING_EVALUATION', verdict: 'PASS', provenance: 'UNKNOWN' }])
  assert.equal(lying?.provenance, null, 'provenance 只认 LIVE/FIXTURE，不谎报')
  assert.equal(lying?.criteria_evaluated, null)
})

test('deriveScreeningRubricVersionId：RUBRIC_VERSION id 优先 → evaluation → 申请钉住的 rubric', () => {
  const refs = [
    { kind: 'SCREENING_EVALUATION', rubric_version_id: 'from-evaluation' },
    { kind: 'RUBRIC_VERSION', id: 'from-rubric-ref' },
  ]
  assert.equal(deriveScreeningRubricVersionId(refs, 'pinned'), 'from-rubric-ref')
  assert.equal(
    deriveScreeningRubricVersionId([{ kind: 'SCREENING_EVALUATION', rubric_version_id: 'from-evaluation' }], 'pinned'),
    'from-evaluation',
  )
  assert.equal(deriveScreeningRubricVersionId([], 'pinned'), 'pinned')
  assert.equal(deriveScreeningRubricVersionId(null, null), null)
})

// =====================================================================
//  9. 路由注册面（database=null：所有断言都发生在碰 DB 之前）
// =====================================================================

interface Captured {
  readonly status: number
  readonly headers: Record<string, unknown>
  readonly json: Record<string, unknown>
}

class FakeResponse {
  status = 0
  headers: Record<string, unknown> = {}
  private chunks: string[] = []
  private settle!: (value: Captured) => void
  readonly done = new Promise<Captured>((resolve) => { this.settle = resolve })

  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.status = status
    this.headers = headers ?? {}
    return this
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined && chunk !== null) this.chunks.push(String(chunk))
    const text = this.chunks.join('')
    let json: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      json = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      json = {}
    }
    this.settle({ status: this.status, headers: this.headers, json })
  }
}

class FakeRequest {
  readonly headers: Record<string, string | undefined>
  readonly method: string
  readonly url: string

  constructor(options: { url: string; method?: string; headers?: Record<string, string | undefined> }) {
    this.url = options.url
    this.method = options.method ?? 'GET'
    this.headers = { host: '127.0.0.1:3181', 'x-recruitment-request': '1', ...(options.headers ?? {}) }
  }
}

interface CapturingServer {
  readonly ctx: RecruitingHostContext
  readonly registered: Array<{ kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }>
}

/** 假 webServer：记录注册（真实宿主对同 (kind,path) 重复注册会抛错，这里只统计）。 */
function fakeServer(host: string): CapturingServer {
  const registered: CapturingServer['registered'] = []
  const ctx: RecruitingHostContext = {
    webServer: {
      host,
      port: 3181,
      register: (route) => {
        registered.push(route as unknown as CapturingServer['registered'][number])
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

async function send(
  handler: (req: unknown, res: unknown) => void | Promise<void>,
  request: FakeRequest,
): Promise<Captured> {
  const response = new FakeResponse()
  await handler(request, response)
  return response.done
}

test('路由：非回环 host（0.0.0.0）不注册，返回 disposer', () => {
  const server = fakeServer('0.0.0.0')
  const dispose = registerRecruitingHttp(server.ctx, null, ['config.database.host is required'])
  assert.equal(typeof dispose, 'function')
  assert.equal(server.registered.length, 0, '非回环地址不得注册任何路由')
})

test('路由：回环 host 注册一个 /recruitment/api/recruiting 前缀', () => {
  const server = fakeServer('127.0.0.1')
  registerRecruitingHttp(server.ctx, null, [])
  assert.equal(server.registered.length, 1)
  assert.equal(server.registered[0]?.kind, 'prefix')
  assert.equal(server.registered[0]?.path, '/recruitment/api/recruiting')
})

function registeredHandler(server: CapturingServer): (req: unknown, res: unknown) => void | Promise<void> {
  const route = server.registered[0]
  assert.ok(route !== undefined, '路由未注册')
  return route.handler
}

test('路由：无 x-recruitment-request → 403；带 non-local Host → 403', async () => {
  const server = fakeServer('127.0.0.1')
  registerRecruitingHttp(server.ctx, null, [])
  const handler = registeredHandler(server)
  const missingHeader = await send(handler, new FakeRequest({
    url: '/recruitment/api/recruiting/overview',
    headers: { 'x-recruitment-request': undefined },
  }))
  assert.equal(missingHeader.status, 403)
  assert.equal((missingHeader.json.error as Record<string, unknown>).code, 'FORBIDDEN')
  const badHost = await send(handler, new FakeRequest({
    url: '/recruitment/api/recruiting/overview',
    headers: { host: 'evil.example:3181' },
  }))
  assert.equal(badHost.status, 403)
})

test('路由：?actor_id= / ?tenant_id= → 400 ACTOR_OVERRIDE_REJECTED（不碰 DB，database=null 也能证明）', async () => {
  const server = fakeServer('127.0.0.1')
  registerRecruitingHttp(server.ctx, null, [])
  const handler = registeredHandler(server)
  for (const key of ['actor_id', 'tenant_id']) {
    const response = await send(handler, new FakeRequest({
      url: `/recruitment/api/recruiting/overview?${key}=11111111-1111-4111-8111-000000000103`,
    }))
    assert.equal(response.status, 400)
    assert.equal((response.json.error as Record<string, unknown>).reason_code, 'ACTOR_OVERRIDE_REJECTED')
  }
})

test('路由：database=null 时 overview 返回 200 未配置投影（issues 透传、读数全 0），详情 503', async () => {
  const server = fakeServer('127.0.0.1')
  const issues = ['config.database.host is required']
  registerRecruitingHttp(server.ctx, null, issues)
  const handler = registeredHandler(server)
  const overview = await send(handler, new FakeRequest({ url: '/recruitment/api/recruiting/overview' }))
  assert.equal(overview.status, 200)
  assert.equal(overview.headers['cache-control'], 'no-store')
  assert.equal(overview.json.configured, false)
  assert.deepEqual(overview.json.issues, issues)
  assert.equal((overview.json.counts as Record<string, unknown>).jobs_total, 0)
  const detail = await send(handler, new FakeRequest({
    url: '/recruitment/api/recruiting/applications/11111111-1111-4111-8111-000000000701',
  }))
  assert.equal(detail.status, 503)
  assert.equal((detail.json.error as Record<string, unknown>).code, 'NOT_CONFIGURED')
})

test('路由：未知路径 → 404；非 GET → 405 allow:GET', async () => {
  const server = fakeServer('127.0.0.1')
  registerRecruitingHttp(server.ctx, null, [])
  const handler = registeredHandler(server)
  const notFound = await send(handler, new FakeRequest({ url: '/recruitment/api/recruiting/nope' }))
  assert.equal(notFound.status, 404)
  const method = await send(handler, new FakeRequest({ url: '/recruitment/api/recruiting/overview', method: 'POST' }))
  assert.equal(method.status, 405)
  assert.equal(method.headers.allow, 'GET')
})
