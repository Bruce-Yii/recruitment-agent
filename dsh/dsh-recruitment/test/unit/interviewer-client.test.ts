// Interviewer Workspace 客户端**纯函数 + HTTP 形状**测试（node --test，无 DOM、无 React）。
//
// 覆盖口径（W3-CONTRACT §3-B 的七组 + 提交体构造 + 请求形状）：
//   1. `normalizeInterviewerOverview`：空响应 / 坏类型一律降级成 '' / 0 / [] / null，不出现 NaN/undefined；
//      counts 由服务端算，不用列表长度改写；
//   2. `normalizeScorecardFormSpec`：维度键/顺序只来自服务端，未知 assessment/overall 丢弃，未知 mode 降级只读；
//   3. `parseHttpError`：契约错误体保留 status/code/reason_code/detail；
//   4. `canSubmitScorecard`：NONE/PENDING → true；SUBMITTED/WAIVED → false；非本场面试官（未分配）→ false；
//   5. `deriveWorkspaceStats`：服务端 counts 原样透传，本地行数只进 `row_count`；
//   6. `selectInterview`：未知 id → null（不回退第一行）；
//   7. 时间格式化 / 状态文本映射；
//   8. `buildScorecardSubmitBody`：提交体键只来自 spec，缺维度/未知枚举/超范围一律本地拒绝；
//   9. `http.ts` 请求形状：overview / form / submit 的 URL、方法、头、credentials；W1 未就绪识别。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildScorecardSubmitBody,
  canSubmitScorecard,
  deriveWorkspaceStats,
  formatSlotRange,
  formatSlotTime,
  groupRounds,
  isBindingPendingError,
  materialFieldEntries,
  normalizeInterviewerOverview,
  normalizeInterviewRow,
  normalizeScorecardFormSpec,
  normalizeSubmitResult,
  parseHttpError,
  RecruitmentHttpError,
  scorecardStateText,
  selectInterview,
  transcriptStateText,
  type InterviewerOverview,
  type InterviewRow,
  type ScorecardFormSpec,
} from '../../src/client/interviewer/normalize.ts'
import {
  fetchInterviewerOverview,
  fetchScorecardFormSpec,
  isScorecardEndpointUnavailable,
  submitScorecard,
} from '../../src/client/interviewer/http.ts'

const INT_1 = '11111111-1111-4111-8111-000000000801'
const INT_2 = '11111111-1111-4111-8111-000000000802'
const APP_1 = '11111111-1111-4111-8111-000000000701'
const APP_2 = '11111111-1111-4111-8111-000000000702'
const RUBRIC_1 = '11111111-1111-4111-8111-000000000403'
const ACTOR_B = '11111111-1111-4111-8111-000000000105'
const SESSION = 'session-fceba596-47fd-41b8-972a-76d166360a34'

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

/** 契约 §1.4 的完整 overview 夹具（两行：一行已交面评，一行待交）。 */
function overviewFixture(): Record<string, unknown> {
  return {
    contract_version: 'interviewer-workspace 1.0.0',
    configured: true,
    evaluated_at: '2026-11-15T06:00:00.000Z',
    actor: {
      alias: 'interviewer_b',
      actor_id: ACTOR_B,
      display_name: '演示-面试官 B',
      roles: ['INTERVIEWER'],
    },
    session: { session_id: SESSION },
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: {
      assigned_total: 7,
      open_interview_total: 1,
      pending_scorecard_total: 1,
      submitted_scorecard_total: 1,
      transcript_ready_total: 1,
      transcript_missing_total: 1,
    },
    interviews: [
      {
        interview_id: INT_1,
        application_id: APP_1,
        candidate: { candidate_id: '11111111-1111-4111-8111-000000000601', display_name: '陈芊' },
        job: { job_id: '11111111-1111-4111-8111-000000000401', code: 'JOB-AI-PM', title: 'AI 产品经理' },
        round_no: 2,
        slot_code: 'DEFAULT',
        status: 'POST_INTERVIEW',
        stage_code: 'S9',
        scheduled_start_at: '2026-11-20T14:00:00.000Z',
        scheduled_end_at: '2026-11-20T15:00:00.000Z',
        timezone: 'Asia/Shanghai',
        record_version: 3,
        role_in_interview: 'INTERVIEWER',
        required_scorecard: true,
        scorecard_due_at: null,
        brief: {
          available: true,
          source: 'TEMPLATE',
          objective: '深入考察方案设计、技术协作与落地能力',
          briefing: '围绕 Agent 架构与落地能力展开',
          focus: [
            { key: 'agent_arch', label: 'Agent 架构与工作流设计', weight: 0.5 },
            { key: 'data_eval', label: '数据与评测意识', weight: 0.5 },
          ],
          questions: ['请拆解一个你做过的 Agent 系统，说明关键取舍。'],
          template_version_id: '11111111-1111-4111-8111-0000000004a1',
          template_payload_hash: 'a'.repeat(64),
          reason: null,
        },
        rubric: {
          rubric_version_id: RUBRIC_1,
          job_id: '11111111-1111-4111-8111-000000000401',
          payload_hash: 'b'.repeat(64),
          dimensions: [
            { key: 'agent_arch', label: 'Agent 架构与工作流设计', kind: 'MUST_HAVE', weight: 0.5, question: null },
            { key: 'data_eval', label: '数据与评测意识', kind: 'PLUS', weight: 0.5, question: '如何验证质量提升？' },
          ],
        },
        materials: {
          authorization: 'INTERVIEW_ASSIGNMENT',
          available: true,
          reason: null,
          resume: {
            resume_version_id: '11111111-1111-4111-8111-000000000501',
            parse_status: 'PARSED',
            parser_name: 'pymupdf',
            parser_version: '1.0.0',
            content_sha256: 'c'.repeat(64),
            fields: { name: '陈芊', years: 8, current_title: 'AI 产品经理' },
          },
        },
        transcript: {
          state: 'READY',
          reason_code: 'CANONICAL_STATUS',
          no_transcript: false,
          meeting_binding_state: 'BOUND_ACTIVE',
          meetings_total: 1,
        },
        scorecard: {
          state: 'SUBMITTED',
          scorecard_id: '11111111-1111-4111-8111-000000000901',
          status: 'SUBMITTED',
          revision_no: 1,
          record_version: 2,
          submitted_at: '2026-11-15T05:00:00.000Z',
          transcript_basis: 'TRANSCRIPT',
          overall: 'ADVANCE',
        },
        required_action: 'REVIEW_SCORECARD',
      },
      {
        interview_id: INT_2,
        application_id: APP_2,
        candidate: { candidate_id: '11111111-1111-4111-8111-000000000602', display_name: '陆思远' },
        job: { job_id: '11111111-1111-4111-8111-000000000402', code: 'JOB-BE-002', title: '后端工程师' },
        round_no: 1,
        slot_code: 'DEFAULT',
        status: 'SCHEDULED',
        stage_code: 'S8',
        scheduled_start_at: null,
        scheduled_end_at: null,
        timezone: 'Asia/Shanghai',
        record_version: 1,
        role_in_interview: 'INTERVIEWER',
        required_scorecard: true,
        scorecard_due_at: null,
        brief: {
          available: true,
          source: 'JOB_RUBRIC',
          objective: '后端工程师',
          briefing: null,
          focus: [{ key: 'backend_depth', label: '后端工程深度', weight: 1 }],
          questions: [],
          template_version_id: null,
          template_payload_hash: null,
          reason: null,
        },
        rubric: null,
        materials: {
          authorization: 'INTERVIEW_ASSIGNMENT',
          available: false,
          reason: 'NO_MATERIAL_BOUND',
          resume: null,
        },
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
      },
    ],
    issues: [],
  }
}

/** W1 form spec 夹具（D-89 原形 + nonce/expires_at/actor_alias）。 */
function formSpecFixture(): Record<string, unknown> {
  return {
    contract_version: 'scorecard-form 1.0.0',
    tool: 'recruitment_scorecard_form',
    actor: { actor_id: ACTOR_B, display_name: '演示-面试官 B' },
    interview: {
      id: INT_1,
      application_id: APP_1,
      round_no: 2,
      slot_code: 'DEFAULT',
      status: 'POST_INTERVIEW',
      scheduled_start_at: '2026-11-20T14:00:00.000Z',
    },
    rubric: {
      id: RUBRIC_1,
      job_id: '11111111-1111-4111-8111-000000000401',
      payload_hash: 'b'.repeat(64),
      dimensions: [
        { key: 'agent_arch', label: 'Agent 架构与工作流设计', kind: 'MUST_HAVE', weight: 0.5 },
        { key: 'data_eval', label: '数据与评测意识', kind: 'PLUS', weight: 0.5 },
      ],
    },
    dimensions: [
      {
        key: 'agent_arch',
        label: 'Agent 架构与工作流设计',
        kind: 'MUST_HAVE',
        weight: 0.5,
        controls: { assessment: ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE', 'WAT'], score: { min: 1, max: 5 }, note_required: false },
      },
      {
        key: 'data_eval',
        label: '数据与评测意识',
        kind: 'PLUS',
        weight: 0.5,
        controls: { assessment: ['MET', 'NOT_MET'], score: { min: 2, max: 4 }, note_required: true },
      },
      { key: 'agent_arch', label: '重复键', controls: { assessment: ['MET'], score: { min: 1, max: 5 }, note_required: false } },
      { key: '', label: '无键维度', controls: { assessment: ['MET'], score: { min: 1, max: 5 }, note_required: false } },
    ],
    transcript_basis: { value: 'NO_TRANSCRIPT', options: ['NO_TRANSCRIPT', 'TRANSCRIPT', 'WEIRD'], locked: true },
    overall_options: ['ADVANCE', 'HOLD', 'REJECT', 'FOO'],
    mode: 'CREATE',
    current: null,
    labels: { stage_code: '阶段' },
    nonce: 'nonce-from-server',
    expires_at: '2026-11-15T06:02:00.000Z',
    actor_alias: 'interviewer_b',
  }
}

/** 把夹具归一化后取一条行（用于 canSubmit/渲染相关断言）。 */
function rowFixture(overrides: Record<string, unknown> = {}): InterviewRow {
  const fixture = overviewFixture()
  const rows = fixture.interviews as Record<string, unknown>[]
  return normalizeInterviewRow({ ...rows[1], ...overrides })
}

// =====================================================================
//  1. normalizeInterviewerOverview
// =====================================================================

test('normalizeInterviewerOverview：空对象全部降级为空串/0/[]，不出现 NaN/undefined', () => {
  const overview = normalizeInterviewerOverview({})
  assert.equal(overview.configured, false)
  assert.equal(overview.contract_version, '')
  assert.equal(overview.evaluated_at, '')
  assert.equal(overview.session_id, '')
  assert.deepEqual(overview.actor, { alias: '', actor_id: '', display_name: '', roles: [] })
  assert.deepEqual(overview.labels, { provenance: '', trigger: '', connection: '' })
  assert.deepEqual(overview.counts, {
    assigned_total: 0,
    open_interview_total: 0,
    pending_scorecard_total: 0,
    submitted_scorecard_total: 0,
    transcript_ready_total: 0,
    transcript_missing_total: 0,
  })
  assert.deepEqual(overview.interviews, [])
  assert.deepEqual(overview.issues, [])
  assertClean(overview)
  assert.ok(!JSON.stringify(overview).includes('NaN'))
})

test('normalizeInterviewerOverview：坏类型降级（字符串计数→0、坏列表→[]、坏 issues 过滤、坏行丢弃）', () => {
  const overview = normalizeInterviewerOverview({
    configured: 'yes',
    contract_version: 42,
    evaluated_at: null,
    actor: [],
    session: 'oops',
    labels: null,
    counts: {
      assigned_total: '9',
      open_interview_total: Number.NaN,
      pending_scorecard_total: -3,
      submitted_scorecard_total: 1.5,
      transcript_ready_total: Infinity,
      transcript_missing_total: null,
    },
    interviews: [null, 'row', { interview_id: INT_1 }, [], { interview_id: '', scorecard: 'bad' }],
    issues: [1, '', '缺 RECRUITMENT_DB_PASSWORD'],
  })
  assert.equal(overview.configured, false)
  assert.equal(overview.contract_version, '')
  assert.equal(overview.evaluated_at, '')
  assert.equal(overview.session_id, '')
  assert.deepEqual(overview.counts, {
    assigned_total: 0,
    open_interview_total: 0,
    pending_scorecard_total: 0,
    submitted_scorecard_total: 1,
    transcript_ready_total: 0,
    transcript_missing_total: 0,
  })
  assert.equal(overview.interviews.length, 2, '只有对象行保留（null/字符串/数组丢弃）')
  assert.equal(overview.interviews[0]?.interview_id, INT_1)
  assert.equal(overview.interviews[0]?.candidate.display_name, '')
  assert.equal(overview.interviews[0]?.brief.source, '')
  assert.deepEqual(overview.interviews[0]?.brief.focus, [])
  assert.equal(overview.interviews[0]?.rubric, null)
  assert.equal(overview.interviews[0]?.materials.resume, null)
  assert.equal(overview.interviews[0]?.scorecard.state, '')
  assert.equal(overview.interviews[1]?.interview_id, '')
  assert.deepEqual(overview.issues, ['缺 RECRUITMENT_DB_PASSWORD'])
  assertClean(overview)
})

test('normalizeInterviewerOverview：完整响应逐字段归一化（两个独立分支 + 授权材料原样）', () => {
  const overview = normalizeInterviewerOverview(overviewFixture())
  assert.equal(overview.configured, true)
  assert.equal(overview.contract_version, 'interviewer-workspace 1.0.0')
  assert.equal(overview.session_id, SESSION)
  assert.deepEqual(overview.actor, {
    alias: 'interviewer_b',
    actor_id: ACTOR_B,
    display_name: '演示-面试官 B',
    roles: ['INTERVIEWER'],
  })
  assert.deepEqual(overview.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(overview.counts.assigned_total, 7, '服务端 counts 原样透传（不等于行数 2）')
  assert.equal(overview.interviews.length, 2)

  const first = overview.interviews[0]
  assert.ok(first !== undefined)
  assert.equal(first.interview_id, INT_1)
  assert.equal(first.candidate.display_name, '陈芊')
  assert.equal(first.job.title, 'AI 产品经理')
  assert.equal(first.round_no, 2)
  assert.equal(first.scheduled_start_at, '2026-11-20T14:00:00.000Z')
  assert.equal(first.record_version, 3)
  assert.equal(first.required_scorecard, true)
  assert.equal(first.brief.source, 'TEMPLATE')
  assert.equal(first.brief.focus.length, 2)
  assert.equal(first.brief.focus[0]?.weight, 0.5)
  assert.deepEqual(first.brief.questions, ['请拆解一个你做过的 Agent 系统，说明关键取舍。'])
  assert.equal(first.rubric?.rubric_version_id, RUBRIC_1)
  assert.equal(first.rubric?.dimensions[1]?.question, '如何验证质量提升？')
  assert.equal(first.materials.available, true)
  assert.equal(first.materials.authorization, 'INTERVIEW_ASSIGNMENT')
  assert.equal(first.materials.resume?.parse_status, 'PARSED')
  assert.deepEqual(first.materials.resume?.fields, { name: '陈芊', years: 8, current_title: 'AI 产品经理' })
  assert.equal(first.transcript.state, 'READY')
  assert.equal(first.transcript.reason_code, 'CANONICAL_STATUS')
  assert.equal(first.transcript.meeting_binding_state, 'BOUND_ACTIVE')
  assert.equal(first.scorecard.state, 'SUBMITTED')
  assert.equal(first.scorecard.submitted_at, '2026-11-15T05:00:00.000Z')
  assert.equal(first.required_action, 'REVIEW_SCORECARD')

  const second = overview.interviews[1]
  assert.ok(second !== undefined)
  assert.equal(second.transcript.state, 'MISSING')
  assert.equal(second.transcript.no_transcript, true)
  assert.equal(second.scorecard.state, 'NONE')
  assert.equal(second.scorecard.scorecard_id, '')
  assert.equal(second.rubric, null)
  assert.equal(second.materials.available, false)
  assert.equal(second.materials.resume, null)
  assert.equal(second.scheduled_start_at, '')
  assertClean(overview)
})

// =====================================================================
//  2. normalizeScorecardFormSpec
// =====================================================================

test('normalizeScorecardFormSpec：维度顺序/键只来自服务端，未知枚举丢弃，重复/无键维度丢弃', () => {
  const spec = normalizeScorecardFormSpec(formSpecFixture())
  assert.equal(spec.contract_version, 'scorecard-form 1.0.0')
  assert.equal(spec.nonce, 'nonce-from-server')
  assert.equal(spec.expires_at, '2026-11-15T06:02:00.000Z')
  assert.equal(spec.actor_alias, 'interviewer_b')
  assert.equal(spec.interview.id, INT_1)
  assert.equal(spec.interview.application_id, APP_1)
  assert.equal(spec.rubric.id, RUBRIC_1)
  assert.equal(spec.mode, 'CREATE')
  assert.equal(spec.current, null)
  assert.deepEqual(
    spec.dimensions.map((dimension) => dimension.key),
    ['agent_arch', 'data_eval'],
    '重复键只保留第一条、无键维度丢弃、顺序 = 服务端顺序',
  )
  assert.deepEqual(spec.dimensions[0]?.assessmentOptions, ['MET', 'NOT_MET', 'NOT_OBSERVED', 'UNREADABLE'])
  assert.equal(spec.dimensions[0]?.scoreMin, 1)
  assert.equal(spec.dimensions[0]?.scoreMax, 5)
  assert.equal(spec.dimensions[1]?.scoreMin, 2)
  assert.equal(spec.dimensions[1]?.scoreMax, 4)
  assert.equal(spec.dimensions[1]?.noteRequired, true)
  assert.deepEqual(spec.overall_options, ['ADVANCE', 'HOLD', 'REJECT'], '未知 overall 选项丢弃')
  assert.equal(spec.transcript_basis.value, 'NO_TRANSCRIPT')
  assert.deepEqual(spec.transcript_basis.options, ['NO_TRANSCRIPT', 'TRANSCRIPT'])
  assert.equal(spec.transcript_basis.locked, true)
  assertClean(spec)
})

test('normalizeScorecardFormSpec：空/坏响应降级为只读空 spec（不抛错、不编造维度）', () => {
  const spec = normalizeScorecardFormSpec({
    mode: 'WEIRD',
    dimensions: 'nope',
    transcript_basis: { value: 'BOGUS', options: 'x' },
    overall_options: ['FOO', 3],
    current: { id: 'sc-1', status: 'SUBMITTED' },
    nonce: 42,
  })
  assert.equal(spec.mode, 'ALREADY_SUBMITTED', '未知 mode 降级为只读')
  assert.deepEqual(spec.dimensions, [])
  assert.equal(spec.nonce, '')
  assert.equal(spec.transcript_basis.value, '')
  assert.deepEqual(spec.transcript_basis.options, [])
  assert.deepEqual(spec.overall_options, [])
  assert.equal(spec.current?.id, 'sc-1')
  assert.equal(spec.current?.status, 'SUBMITTED')
  assert.equal(spec.current?.revision_no, 0)
  const empty = normalizeScorecardFormSpec(null)
  assert.equal(empty.interview.id, '')
  assert.equal(empty.rubric.id, '')
  assert.equal(empty.actor_alias, '')
  assertClean(empty)
})

// =====================================================================
//  3. parseHttpError
// =====================================================================

test('parseHttpError：契约错误体保留 status/code/reason_code/detail', () => {
  const error = parseHttpError(
    409,
    JSON.stringify({
      error: {
        code: 'DEMO_ACTOR_UNMAPPED',
        reason_code: 'SESSION_NOT_BOUND',
        message: '当前 Session 尚未绑定演示身份（fail-closed）',
        detail: { session_id: SESSION },
      },
    }),
  )
  assert.ok(error instanceof RecruitmentHttpError)
  assert.ok(error instanceof Error)
  assert.equal(error.status, 409)
  assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.equal(error.reasonCode, 'SESSION_NOT_BOUND')
  assert.ok(error.message.includes('DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND'))
  assert.ok(error.message.includes('尚未绑定'))
  assert.deepEqual(error.detail, { session_id: SESSION })
})

test('parseHttpError：{error:"文本"} / 纯文本 / 空体都能转成可读错误（并保留 status）', () => {
  const stringError = parseHttpError(403, JSON.stringify({ error: 'forbidden' }))
  assert.equal(stringError.status, 403)
  assert.equal(stringError.code, '')
  assert.ok(stringError.message.includes('forbidden'))

  const textError = parseHttpError(500, 'boom from server')
  assert.equal(textError.status, 500)
  assert.ok(textError.message.includes('HTTP 500'))
  assert.ok(textError.message.includes('boom from server'))

  const emptyError = parseHttpError(502, '')
  assert.equal(emptyError.status, 502)
  assert.equal(emptyError.message, '宿主返回 HTTP 502')

  const nestedDetail = parseHttpError(409, JSON.stringify({ error: { code: 'CONFLICT', detail: '版本冲突' } }))
  assert.ok(nestedDetail.message.includes('CONFLICT'))
  assert.ok(nestedDetail.message.includes('版本冲突'))
})

// =====================================================================
//  3b. isBindingPendingError（W0 shell 先改 props、后 PUT 的身份绑定竞态）
// =====================================================================

test('isBindingPendingError：只有 403 SESSION_ALIAS_MISMATCH / 409 DEMO_ACTOR_UNMAPPED 可重试，其它错误立即显示', () => {
  const aliasMismatch = parseHttpError(
    403,
    JSON.stringify({
      error: { code: 'ALIAS_MISMATCH', reason_code: 'SESSION_ALIAS_MISMATCH', message: 'query alias 与绑定不一致' },
    }),
  )
  assert.equal(isBindingPendingError(aliasMismatch), true, '切换身份后服务端 registry 仍是旧绑定 → 应退避重试')

  const unmapped = parseHttpError(
    409,
    JSON.stringify({
      error: { code: 'DEMO_ACTOR_UNMAPPED', reason_code: 'SESSION_NOT_BOUND', message: '未绑定' },
    }),
  )
  assert.equal(isBindingPendingError(unmapped), true, '首次绑定/刷新恢复的 409 → 应退避重试')

  const unmappedOtherReason = parseHttpError(
    409,
    JSON.stringify({ error: { code: 'DEMO_ACTOR_UNMAPPED', reason_code: 'ACTOR_ROW_MISSING', message: 'actor 缺行' } }),
  )
  assert.equal(isBindingPendingError(unmappedOtherReason), true, '判定按 code 层，reason_code 不改变"可重试"结论')

  const forbidden = parseHttpError(
    403,
    JSON.stringify({ error: { code: 'FORBIDDEN', reason_code: 'ACTOR_NOT_INTERVIEWER', message: '不是面试官' } }),
  )
  assert.equal(isBindingPendingError(forbidden), false, '业务 403 不得被重试掩盖')

  const otherConflict = parseHttpError(
    409,
    JSON.stringify({ error: { code: 'VERSION_CONFLICT', reason_code: 'RECORD_VERSION_STALE', message: '版本冲突' } }),
  )
  assert.equal(isBindingPendingError(otherConflict), false)

  const notFound = parseHttpError(404, JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'ROUTE_NOT_FOUND' } }))
  assert.equal(isBindingPendingError(notFound), false)

  const network = new RecruitmentHttpError(0, 'NETWORK_ERROR', 'NETWORK_UNREACHABLE', '网络失败', undefined)
  assert.equal(isBindingPendingError(network), false, '网络错不在身份竞态范围内（由调用方决定是否重试）')
  assert.equal(isBindingPendingError(new Error('boom')), false)
  assert.equal(isBindingPendingError(undefined), false)
})

// =====================================================================
//  4. canSubmitScorecard
// =====================================================================

test('canSubmitScorecard：NONE/PENDING → true；SUBMITTED/WAIVED → false；未知状态 → false', () => {
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: { state: 'NONE' } })), true)
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: { state: 'PENDING' } })), true)
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: { state: 'SUBMITTED' } })), false)
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: { state: 'WAIVED' } })), false)
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: { state: 'WEIRD' } })), false)
  assert.equal(canSubmitScorecard(rowFixture({ scorecard: {} })), false)
})

test('canSubmitScorecard：未分配（不是本场面试官 / 空 interview_id）→ false（fail-closed）', () => {
  assert.equal(canSubmitScorecard(rowFixture({ role_in_interview: '' })), false)
  assert.equal(canSubmitScorecard(rowFixture({ role_in_interview: 'OBSERVER' })), false)
  assert.equal(canSubmitScorecard(rowFixture({ interview_id: '' })), false)
  // 转写未 READY 不影响可提交（服务端记 NO_TRANSCRIPT，D-111）。
  assert.equal(canSubmitScorecard(rowFixture({ transcript: { state: 'MISSING' }, scorecard: { state: 'NONE' } })), true)
})

// =====================================================================
//  5. deriveWorkspaceStats
// =====================================================================

test('deriveWorkspaceStats：服务端 counts 原样透传，不用行长度改写（row_count 只做诊断）', () => {
  const overview = normalizeInterviewerOverview(overviewFixture())
  const stats = deriveWorkspaceStats(overview)
  assert.equal(stats.assigned_total, 7, '服务端说 7 就是 7（行数是 2）')
  assert.equal(stats.open_interview_total, 1)
  assert.equal(stats.pending_scorecard_total, 1)
  assert.equal(stats.submitted_scorecard_total, 1)
  assert.equal(stats.transcript_ready_total, 1)
  assert.equal(stats.transcript_missing_total, 1)
  assert.equal(stats.row_count, 2)
  assert.deepEqual(stats, {
    assigned_total: 7,
    open_interview_total: 1,
    pending_scorecard_total: 1,
    submitted_scorecard_total: 1,
    transcript_ready_total: 1,
    transcript_missing_total: 1,
    row_count: 2,
  })
})

// =====================================================================
//  6. selectInterview
// =====================================================================

test('selectInterview：已知 id 返回该行；未知 / 空 / 空 overview → null（不回退第一行）', () => {
  const overview = normalizeInterviewerOverview(overviewFixture())
  assert.equal(selectInterview(overview, INT_1)?.interview_id, INT_1)
  assert.equal(selectInterview(overview, INT_2)?.interview_id, INT_2)
  assert.equal(selectInterview(overview, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), null)
  assert.equal(selectInterview(overview, ''), null)
  assert.equal(selectInterview(undefined, INT_1), null)
  assert.equal(selectInterview(normalizeInterviewerOverview({}), INT_1), null)
})

// =====================================================================
//  7. 时间格式化 / 状态文本
// =====================================================================

test('formatSlotTime：给 IANA 时区按该时区换算；不给时区保留原文并附偏移标记；坏输入为 ""', () => {
  assert.equal(formatSlotTime('2026-11-20T14:00:00.000Z', 'Asia/Shanghai'), '2026-11-20 22:00')
  assert.equal(formatSlotTime('2026-11-20T14:00:00.000Z'), '2026-11-20 14:00Z')
  assert.equal(formatSlotTime('2026-11-20T14:00:00+08:00'), '2026-11-20 14:00+08:00')
  assert.equal(formatSlotTime('2026-11-20', 'Asia/Shanghai'), '2026-11-20')
  assert.equal(formatSlotTime('not-a-time'), '')
  assert.equal(formatSlotTime(''), '')
  assert.equal(formatSlotTime(null as unknown as string), '')
  // 非法时区不猜本地时区：退回原文时间 + 偏移。
  assert.equal(formatSlotTime('2026-11-20T14:00:00.000Z', 'Mars/Olympus'), '2026-11-20 14:00Z')
})

test('formatSlotRange：同日折叠结束日期；跨日保留两侧；空开始为 ""', () => {
  assert.equal(
    formatSlotRange('2026-11-20T14:00:00.000Z', '2026-11-20T15:00:00.000Z', 'Asia/Shanghai'),
    '2026-11-20 22:00 – 23:00',
  )
  assert.equal(
    formatSlotRange('2026-11-20T14:00:00.000Z', '2026-11-21T01:00:00.000Z', 'Asia/Shanghai'),
    '2026-11-20 22:00 – 2026-11-21 09:00',
  )
  assert.equal(formatSlotRange('2026-11-20T14:00:00.000Z', '', 'Asia/Shanghai'), '2026-11-20 22:00')
  assert.equal(formatSlotRange('', '2026-11-20T15:00:00.000Z', 'Asia/Shanghai'), '')
})

test('transcriptStateText / scorecardStateText：七条转写 + 四面评状态；未知值如实说明，不沉默', () => {
  assert.equal(transcriptStateText('READY'), '已取得（完整）')
  assert.equal(transcriptStateText('PARTIAL'), '部分取得（不完整）')
  assert.equal(transcriptStateText('PENDING'), '等待转写中')
  assert.equal(transcriptStateText('MISSING'), '缺失（无原文）')
  assert.equal(transcriptStateText('AUTH_REQUIRED'), '需要重新授权')
  assert.equal(transcriptStateText('NEEDS_LINKING'), '待人工关联会议')
  assert.equal(transcriptStateText('RETRYABLE_FAILED'), '可重试的失败')
  assert.equal(transcriptStateText('WEIRD'), '未知状态（WEIRD）')
  assert.equal(transcriptStateText(''), '状态未提供')

  assert.equal(scorecardStateText('NONE'), '未填')
  assert.equal(scorecardStateText('PENDING'), '草稿')
  assert.equal(scorecardStateText('SUBMITTED'), '已提交')
  assert.equal(scorecardStateText('WAIVED'), '已豁免')
  assert.equal(scorecardStateText('WEIRD'), '未知状态（WEIRD）')
  assert.equal(scorecardStateText(''), '状态未提供')
})

// =====================================================================
//  8. buildScorecardSubmitBody
// =====================================================================

/** 构造一份"人可以提交"的合法 spec。 */
function submittableSpec(): ScorecardFormSpec {
  return normalizeScorecardFormSpec(formSpecFixture())
}

test('buildScorecardSubmitBody：提交体键只来自 spec（dimensions 全集），transcript_basis/overall/nonce 原样来自 spec', () => {
  const spec = submittableSpec()
  const built = buildScorecardSubmitBody(spec, {
    dimensions: {
      agent_arch: { assessment: 'MET', score: 4, note: '拆解清楚' },
      data_eval: { assessment: 'NOT_MET', score: 2, note: '缺少评测设计' },
      forged_key: { assessment: 'MET' },
    },
    overall: 'HOLD',
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.deepEqual(Object.keys(built.body.dimensions), ['agent_arch', 'data_eval'], '自由键不会进入提交体')
  assert.deepEqual(built.body.dimensions.agent_arch, { assessment: 'MET', score: 4, note: '拆解清楚' })
  assert.deepEqual(built.body.dimensions.data_eval, { assessment: 'NOT_MET', score: 2, note: '缺少评测设计' })
  assert.equal(built.body.interview_id, INT_1)
  assert.equal(built.body.rubric_version_id, RUBRIC_1)
  assert.equal(built.body.transcript_basis, 'NO_TRANSCRIPT', '转写缺失不是错误：用服务端锁定的值')
  assert.equal(built.body.overall, 'HOLD')
  assert.equal(built.body.nonce, 'nonce-from-server')
  assertClean(built.body)
})

test('buildScorecardSubmitBody：缺维度 / 未知 assessment / 分数非法 / overall 非法 / note 缺失 → 本地拒绝', () => {
  const spec = submittableSpec()
  const base = {
    agent_arch: { assessment: 'MET', score: 4 },
    data_eval: { assessment: 'MET', note: 'ok' },
  }
  const missing = buildScorecardSubmitBody(spec, { dimensions: { agent_arch: base.agent_arch }, overall: 'HOLD' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.ok(missing.message.includes('data_eval'))

  const unknownAssessment = buildScorecardSubmitBody(spec, {
    dimensions: { ...base, agent_arch: { assessment: 'WAT' } },
    overall: 'HOLD',
  })
  assert.equal(unknownAssessment.ok, false)
  if (!unknownAssessment.ok) assert.ok(unknownAssessment.message.includes('assessment'))

  const outOfRange = buildScorecardSubmitBody(spec, {
    dimensions: { ...base, agent_arch: { assessment: 'MET', score: 9 } },
    overall: 'HOLD',
  })
  assert.equal(outOfRange.ok, false)
  if (!outOfRange.ok) assert.ok(outOfRange.message.includes('1–5'))

  const scoreWithNotObserved = buildScorecardSubmitBody(spec, {
    dimensions: { ...base, agent_arch: { assessment: 'NOT_OBSERVED', score: 3 } },
    overall: 'HOLD',
  })
  assert.equal(scoreWithNotObserved.ok, false)

  const badOverall = buildScorecardSubmitBody(spec, { dimensions: base, overall: 'FOO' })
  assert.equal(badOverall.ok, false)
  if (!badOverall.ok) assert.ok(badOverall.message.includes('overall'))

  const missingNote = buildScorecardSubmitBody(spec, {
    dimensions: { ...base, data_eval: { assessment: 'MET' } },
    overall: 'HOLD',
  })
  assert.equal(missingNote.ok, false, 'data_eval 维度 note 必填')
  if (!missingNote.ok) assert.ok(missingNote.message.includes('note'))

  const emptyAssessment = buildScorecardSubmitBody(spec, {
    dimensions: { ...base, agent_arch: { assessment: '' } },
    overall: 'HOLD',
  })
  assert.equal(emptyAssessment.ok, false)
})

test('buildScorecardSubmitBody：REVISE 模式 / 缺 nonce / 缺 transcript_basis / 无维度 → 一律 fail-closed', () => {
  const revise = normalizeScorecardFormSpec({ ...formSpecFixture(), mode: 'REVISE' })
  assert.equal(buildScorecardSubmitBody(revise, { dimensions: {}, overall: 'ADVANCE' }).ok, false)

  const noNonce = normalizeScorecardFormSpec({ ...formSpecFixture(), nonce: '' })
  const noNonceBuilt = buildScorecardSubmitBody(noNonce, {
    dimensions: {
      agent_arch: { assessment: 'MET' },
      data_eval: { assessment: 'MET', note: 'ok' },
    },
    overall: 'ADVANCE',
  })
  assert.equal(noNonceBuilt.ok, false)
  if (!noNonceBuilt.ok) assert.ok(noNonceBuilt.message.includes('nonce'))

  const noBasis = normalizeScorecardFormSpec({ ...formSpecFixture(), transcript_basis: { value: 'BOGUS' } })
  const noBasisBuilt = buildScorecardSubmitBody(noBasis, {
    dimensions: {
      agent_arch: { assessment: 'MET' },
      data_eval: { assessment: 'MET', note: 'ok' },
    },
    overall: 'ADVANCE',
  })
  assert.equal(noBasisBuilt.ok, false)
  if (!noBasisBuilt.ok) assert.ok(noBasisBuilt.message.includes('transcript_basis'))

  const emptyDimensions = normalizeScorecardFormSpec({ ...formSpecFixture(), dimensions: [] })
  const emptyBuilt = buildScorecardSubmitBody(emptyDimensions, { dimensions: {}, overall: 'ADVANCE' })
  assert.equal(emptyBuilt.ok, false)
})

// =====================================================================
//  9. 其余纯函数（DB 读回 / 材料 / 轮次）
// =====================================================================

test('normalizeSubmitResult：成功读回逐字段归一化（兼容包在 result 下）；缺字段降级为 ""/0', () => {
  const readback = normalizeSubmitResult({
    scorecard_id: '11111111-1111-4111-8111-000000000901',
    status: 'SUBMITTED',
    actor_id: ACTOR_B,
    record_version: 1,
    interviewer_id: '11111111-1111-4111-8111-000000000a01',
    interview_id: INT_1,
    replayed: false,
  })
  assert.deepEqual(readback, {
    scorecard_id: '11111111-1111-4111-8111-000000000901',
    status: 'SUBMITTED',
    actor_id: ACTOR_B,
    record_version: 1,
    interviewer_id: '11111111-1111-4111-8111-000000000a01',
    interview_id: INT_1,
    replayed: false,
  })
  const nested = normalizeSubmitResult({ result: { scorecard_id: 'sc-1', status: 'SUBMITTED', record_version: 2 } })
  assert.equal(nested.scorecard_id, 'sc-1')
  assert.equal(nested.record_version, 2)
  const empty = normalizeSubmitResult(null)
  assert.deepEqual(empty, {
    scorecard_id: '',
    status: '',
    actor_id: '',
    record_version: 0,
    interviewer_id: '',
    interview_id: '',
    replayed: false,
  })
  assertClean(empty)
})

test('materialFieldEntries：标量拍平、对象/数组不渲染成 [object Object]、长文本截断、空字段丢弃', () => {
  const fields = {
    name: '陈芊',
    years: 8,
    remote: true,
    empty: '',
    skills: { a: 1 },
    list: ['x'],
    note: 'x'.repeat(400),
  }
  const entries = materialFieldEntries(fields)
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.value]),
    [
      ['name', '陈芊'],
      ['years', '8'],
      ['remote', '是'],
      ['note', `${'x'.repeat(300)}…`],
    ],
  )
  assert.deepEqual(materialFieldEntries({}), [])
})

test('groupRounds：按轮次升序汇总 focus 并去重（列表页右栏用）', () => {
  const fixtureRows = overviewFixture().interviews as Record<string, unknown>[]
  const secondRound = normalizeInterviewRow(fixtureRows[0])
  const firstRound = normalizeInterviewRow(fixtureRows[1])
  const third = normalizeInterviewRow({
    interview_id: '11111111-1111-4111-8111-000000000803',
    round_no: 2,
    brief: { objective: '第二轮目标', focus: [{ key: 'agent_arch', label: '重复维度', weight: 0.5 }] },
  })
  const groups = groupRounds([secondRound, firstRound, third])
  assert.deepEqual(
    groups.map((group) => group.round_no),
    [1, 2],
  )
  assert.equal(groups[0]?.focus.length, 1)
  assert.equal(groups[1]?.focus.length, 2, '同一 key 的维度只保留一次')
  // 同轮次的第一条行决定 objective（后续行不覆盖已有目标）。
  assert.equal(groups[1]?.objective, '深入考察方案设计、技术协作与落地能力')
})

// =====================================================================
//  10. http.ts 请求形状（stub globalThis.fetch，无 DOM / 无真实网络）
// =====================================================================

interface FetchCall {
  readonly url: string
  readonly init: RequestInit
}

/** 用假 fetch 跑一段逻辑，返回调用记录（结束后恢复原 fetch）。 */
async function withStubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: (calls: readonly FetchCall[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const requestInit = init ?? {}
    calls.push({ url, init: requestInit })
    return handler(url, requestInit)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

test('http：fetchInterviewerOverview 带同源头/credentials，URL 只带 alias，返回归一化响应', async () => {
  await withStubFetch(
    () => Promise.resolve(new Response(JSON.stringify(overviewFixture()), { status: 200 })),
    async (calls) => {
      const overview = await fetchInterviewerOverview({ sessionId: SESSION, alias: 'interviewer_b' })
      assert.equal(overview.actor.alias, 'interviewer_b')
      assert.equal(overview.interviews.length, 2)
      assert.equal(calls.length, 1)
      const call = calls[0]
      assert.ok(call !== undefined)
      assert.equal(call.url, '/recruitment/api/interviewer/overview?alias=interviewer_b')
      assert.equal(call.init.method, 'GET')
      assert.equal(call.init.credentials, 'same-origin')
      assert.equal(call.init.cache, 'no-store')
      const headers = call.init.headers as Record<string, string>
      assert.equal(headers['x-recruitment-request'], '1')
      assert.equal(headers['X-DSH-Session'], SESSION)
    },
  )
})

test('http：fetchInterviewerOverview 空 session/alias 本地 fail-closed（不发请求）', async () => {
  await withStubFetch(
    () => Promise.resolve(new Response('{}', { status: 200 })),
    async (calls) => {
      await assert.rejects(
        () => fetchInterviewerOverview({ sessionId: '', alias: 'interviewer_b' }),
        (failure: unknown) => failure instanceof RecruitmentHttpError && failure.code === 'DEMO_ACTOR_UNMAPPED',
      )
      await assert.rejects(
        () => fetchInterviewerOverview({ sessionId: SESSION, alias: '' }),
        (failure: unknown) => failure instanceof RecruitmentHttpError && failure.code === 'DEMO_ACTOR_UNMAPPED',
      )
      assert.equal(calls.length, 0, '没有身份就不该发请求')
    },
  )
})

test('http：fetchScorecardFormSpec 带 interview_id/application_id/rubric_version_id，404 → W1 未就绪', async () => {
  await withStubFetch(
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ ...formSpecFixture(), nonce: 'nonce-1' }), { status: 200 }),
      ),
    async (calls) => {
      const spec = await fetchScorecardFormSpec({
        sessionId: SESSION,
        interviewId: INT_1,
        applicationId: APP_1,
        rubricVersionId: RUBRIC_1,
      })
      assert.equal(spec.nonce, 'nonce-1')
      assert.deepEqual(
        spec.dimensions.map((dimension) => dimension.key),
        ['agent_arch', 'data_eval'],
      )
      const call = calls[0]
      assert.ok(call !== undefined)
      assert.equal(
        call.url,
        `/recruitment/api/action/scorecard/form?interview_id=${INT_1}&application_id=${APP_1}&rubric_version_id=${RUBRIC_1}`,
      )
      const headers = call.init.headers as Record<string, string>
      assert.equal(headers['x-recruitment-request'], '1')
      assert.equal(headers['X-DSH-Session'], SESSION)
    },
  )

  await withStubFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'ROUTE_NOT_FOUND', message: 'no route' } }),
          { status: 404 },
        ),
      ),
    async () => {
      await assert.rejects(
        () => fetchScorecardFormSpec({ sessionId: SESSION, interviewId: INT_1, applicationId: APP_1 }),
        (failure: unknown) => {
          assert.ok(failure instanceof RecruitmentHttpError)
          assert.equal(failure.status, 404)
          assert.equal(failure.code, 'NOT_FOUND')
          assert.equal(isScorecardEndpointUnavailable(failure), true)
          return true
        },
      )
    },
  )
})

test('http：submitScorecard POST JSON（无顶层 note、dimensions 来自 spec），成功读回归一化', async () => {
  const spec = submittableSpec()
  const built = buildScorecardSubmitBody(spec, {
    dimensions: {
      agent_arch: { assessment: 'MET', score: 4, note: '拆解清楚' },
      data_eval: { assessment: 'NOT_MET', score: 2, note: '缺少评测' },
    },
    overall: 'HOLD',
  })
  assert.equal(built.ok, true)
  if (!built.ok) return
  await withStubFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            scorecard_id: '11111111-1111-4111-8111-000000000901',
            status: 'SUBMITTED',
            actor_id: ACTOR_B,
            record_version: 1,
            interviewer_id: '11111111-1111-4111-8111-000000000a01',
            interview_id: INT_1,
            replayed: false,
          }),
          { status: 200 },
        ),
      ),
    async (calls) => {
      const result = await submitScorecard({ sessionId: SESSION, body: built.body })
      assert.equal(result.scorecard_id, '11111111-1111-4111-8111-000000000901')
      assert.equal(result.status, 'SUBMITTED')
      assert.equal(result.record_version, 1)
      const call = calls[0]
      assert.ok(call !== undefined)
      assert.equal(call.url, '/recruitment/api/action/scorecard/submit')
      assert.equal(call.init.method, 'POST')
      const headers = call.init.headers as Record<string, string>
      assert.equal(headers['content-type'], 'application/json')
      assert.equal(headers['x-recruitment-request'], '1')
      assert.equal(headers['X-DSH-Session'], SESSION)
      const parsed = JSON.parse(String(call.init.body)) as Record<string, unknown>
      assert.deepEqual(parsed, built.body)
      assert.equal(Object.hasOwn(parsed, 'note'), false, 'W1 冻结形状没有顶层 note')
      assert.equal(Object.hasOwn(parsed, 'items'), false, '用 dimensions 而不是 items')
    },
  )
})

test('http：submitScorecard 网络失败 → RecruitmentHttpError(status 0) 且识别为入口未就绪；409 保留契约字段', async () => {
  await withStubFetch(
    () => Promise.reject(new TypeError('connect ECONNREFUSED 127.0.0.1:49303')),
    async () => {
      await assert.rejects(
        () =>
          submitScorecard({
            sessionId: SESSION,
            body: { interview_id: INT_1, dimensions: {}, transcript_basis: 'NO_TRANSCRIPT', overall: 'HOLD', nonce: 'n' },
          }),
        (failure: unknown) => {
          assert.ok(failure instanceof RecruitmentHttpError)
          assert.equal(failure.status, 0)
          assert.equal(failure.code, 'NETWORK_ERROR')
          assert.equal(isScorecardEndpointUnavailable(failure), true)
          return true
        },
      )
    },
  )

  await withStubFetch(
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: 'NONCE_ALREADY_USED',
              reason_code: 'NONCE_ALREADY_USED',
              message: 'nonce 已被使用过（一次性）；重放不会写库',
            },
          }),
          { status: 409 },
        ),
      ),
    async () => {
      await assert.rejects(
        () =>
          submitScorecard({
            sessionId: SESSION,
            body: { interview_id: INT_1, dimensions: {}, transcript_basis: 'NO_TRANSCRIPT', overall: 'HOLD', nonce: 'n' },
          }),
        (failure: unknown) => {
          assert.ok(failure instanceof RecruitmentHttpError)
          assert.equal(failure.status, 409)
          assert.equal(failure.code, 'NONCE_ALREADY_USED')
          assert.equal(isScorecardEndpointUnavailable(failure), false, '业务拒绝不能被当成"入口未就绪"')
          return true
        },
      )
    },
  )
})

// =====================================================================
//  11. 归一化后的 overview 可直接用于 UI 读取（不出现 undefined 分支）
// =====================================================================

test('overview 归一化后可安全读取所有界面分支字段（transcript/scorecard 互不推导）', () => {
  const overview: InterviewerOverview = normalizeInterviewerOverview(overviewFixture())
  const rows: readonly InterviewRow[] = overview.interviews
  for (const row of rows) {
    // 界面实际读取的字段全部有值（''/0/[]/null 而不是 undefined）。
    assert.notEqual(row.transcript.state, undefined)
    assert.notEqual(row.scorecard.state, undefined)
    assert.notEqual(row.brief.focus, undefined)
    assert.notEqual(row.materials.reason, undefined)
    // 两条分支独立：第一行 READY + SUBMITTED；第二行 MISSING + NONE（不互相推导）。
    assert.equal(row.transcript.state === 'READY', row.scorecard.state === 'SUBMITTED')
  }
  assert.equal(rows[0]?.transcript.state, 'READY')
  assert.equal(rows[0]?.scorecard.state, 'SUBMITTED')
  assert.equal(rows[1]?.transcript.state, 'MISSING')
  assert.equal(rows[1]?.scorecard.state, 'NONE')
})
