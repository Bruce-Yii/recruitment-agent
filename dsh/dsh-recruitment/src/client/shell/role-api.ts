// D5 P0-4 角色视图的 **客户端 HTTP / 归一化层**（可被 `node --test` 直接 import 的纯函数 + 一个同源 fetch 封装）。
//
// 依据：`work/d5/roles/CONTRACT.md` §3（冻结接口 B）、`work/d5/actions/CONTRACT.md`
// （P2 `job/rubric-approve` §4.1 / `config` §4.2）、`work/d5/decision/CONTRACT.md`
// （facts / record facade）、Notion 02 §04。
//
// 纪律：
//   * 成功事实只认服务端信封 `readback`（写事务后的独立 SQL 读回），2xx 不独立当成功；
//   * 客户端**不带** actor/tenant/alias 等身份键（服务端会 400 `ACTOR_OVERRIDE_REJECTED`）；
//   * 读模型缺失 / 未知形状一律降级（''/0/[]/null），不编造事实、不伪造审批行；
//   * 本文件不 import react/DOM，可在 node --test 里直接覆盖（`test/unit/role-api.test.ts`）。

// =====================================================================
//  端点常量（路径即契约）
// =====================================================================

/** 招聘工作区只读投影（W2）。 */
export const RECRUITING_OVERVIEW_PATH = '/recruitment/api/recruiting/overview'
/** 决策事实只读投影（task-56，`work/d5/decision/CONTRACT.md` §1）。 */
export const DECISION_FACTS_PATH = '/recruitment/api/decision/facts'
/** 正式决策 facade（§3；服务端从 facts 组装 basis_refs，前端不传 hash/digest）。 */
export const DECISION_RECORD_PATH = '/recruitment/api/decision/record'
/** Rubric 人类批准 Host Action（`work/d5/actions/CONTRACT.md` §4.1）。 */
export const RUBRIC_APPROVE_PATH = '/recruitment/api/action/job/rubric-approve'
/** 招聘设置统一写入口（§4.2；body.entity 分派 role/team/pipeline）。 */
export const CONFIG_PATH = '/recruitment/api/action/config'

/** 与 `work/d5/roles/CONTRACT.md` §1 一致：Host Action 只授权 recruiter alias。 */
const WRITE_AUTHORIZED_ALIASES: readonly string[] = ['recruiter']

// =====================================================================
//  通用形状
// =====================================================================

/** 一次同源 JSON 请求的结果（`json` 只在可解析对象时非 null）。 */
export interface JsonResponse {
  readonly ok: boolean
  readonly status: number
  readonly text: string
  readonly json: Readonly<Record<string, unknown>> | null
}

/** 标准写动作信封（`work/d5/actions/CONTRACT.md` §0.3）。 */
export interface ActionEnvelope {
  readonly action: string
  readonly actor: { readonly alias: string; readonly actorId: string; readonly sessionId: string }
  readonly approval: { readonly requested: number; readonly result: string; readonly toolNames: readonly string[] }
  readonly result: Readonly<Record<string, unknown>> | null
  readonly readback: Readonly<Record<string, unknown>> | null
}

/** 表单组包结果：不满足契约 → `ok:false` + 精确 reasonCode（客户端不发请求）。 */
export type BodyBuildResult =
  | { readonly ok: true; readonly body: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reasonCode: string; readonly reasonText: string; readonly missing: readonly string[] }

/** 读回区一行（键/值原样；`label` 只做有限中文化，未知键原样）。 */
export interface ReadbackLine {
  readonly key: string
  readonly label: string
  readonly value: string
}

// =====================================================================
//  基础取值（坏类型降级；不抛）
// =====================================================================

function rec(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {}
}
function arr(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function bool(value: unknown): boolean {
  return value === true
}
/** UUID 文本形态（服务端同一口径）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}
/** 带时区偏移的 ISO-8601（`Z` 或 `±HH:MM`）。 */
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/
function isOffsetIso(value: string): boolean {
  return value !== '' && OFFSET_ISO_RE.test(value) && Number.isFinite(Date.parse(value))
}
function preview(value: unknown, max: number): string {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return ''
    return serialized.length <= max ? serialized : `${serialized.slice(0, max)}…`
  } catch {
    return ''
  }
}
function fail(reasonCode: string, reasonText: string, missing: readonly string[]): BodyBuildResult {
  return { ok: false, reasonCode, reasonText, missing }
}

// =====================================================================
//  同源请求（浏览器里调用；node --test 不调用它）
// =====================================================================

/**
 * 发一次同源产品请求。
 * @param path - `/recruitment/...` 相对路径。
 * @param options - `{sessionId, method, body}`；sessionId 走受控 header，永不出现在 body。
 * @returns 状态码 + 原文 + 可解析 JSON（非对象/坏 JSON → null）。
 */
export async function requestJson(
  path: string,
  options: {
    readonly sessionId: string | null
    readonly method?: 'GET' | 'POST' | 'PUT'
    readonly body?: Readonly<Record<string, unknown>>
  },
): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'x-recruitment-request': '1' }
  if (options.sessionId !== null && options.sessionId !== '') headers['x-dsh-session'] = options.sessionId
  const init: RequestInit = { method: options.method ?? 'GET', credentials: 'same-origin', headers, cache: 'no-store' }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const res = await fetch(path, init)
  const textValue = await res.text()
  let json: Readonly<Record<string, unknown>> | null = null
  try {
    const parsed: unknown = JSON.parse(textValue)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Readonly<Record<string, unknown>>
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, text: textValue, json }
}

// =====================================================================
//  写动作信封
// =====================================================================

/**
 * 严格解析标准写动作信封；坏形状 → null（不猜）。
 * @param bodyText - 服务端响应原文。
 * @returns 信封或 null。
 */
export function parseActionEnvelope(bodyText: string): ActionEnvelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return null
  }
  const raw = rec(parsed)
  const action = text(raw.action)
  if (action === '') return null
  const actor = rec(raw.actor)
  const approval = rec(raw.approval)
  const readbackValue = raw.readback
  return {
    action,
    actor: { alias: text(actor.alias), actorId: text(actor.actor_id), sessionId: text(actor.session_id) },
    approval: {
      requested: num(approval.requested),
      result: text(approval.result),
      toolNames: arr(approval.tool_names).map((item) => text(item)).filter((item) => item !== ''),
    },
    result: typeof raw.result === 'object' && raw.result !== null && !Array.isArray(raw.result) ? raw.result as Readonly<Record<string, unknown>> : null,
    readback: typeof readbackValue === 'object' && readbackValue !== null && !Array.isArray(readbackValue) ? readbackValue as Readonly<Record<string, unknown>> : null,
  }
}

// =====================================================================
//  招聘工作区只读投影的派生（Approver / Hiring Manager 视图共用）
// =====================================================================

/** 一条「待批准 Rubric」（来源 = 岗位投影 `jobs[].rubric`，**不是** approval 表）。 */
export interface PendingRubricRow {
  readonly jobId: string
  readonly jobTitle: string
  readonly jobStatus: string
  readonly rubricVersionId: string
  readonly versionNo: number
}

/**
 * 从 recruiting overview 派生待批准 Rubric 列表。
 *
 * 来源口径（如实，不冒充 approval 表）：`jobs[].rubric.rubric_version_id` 非空且
 * `jobs[].rubric.approved !== true`。approval 表本身没有只读投影（`work/d5/roles/CONTRACT.md` §6）。
 * @param overview - overview JSON。
 * @returns 行数组（顺序 = 服务端 jobs 顺序）。
 */
export function derivePendingRubricApprovals(overview: unknown): readonly PendingRubricRow[] {
  const jobs = arr(rec(overview).jobs)
  const out: PendingRubricRow[] = []
  for (const item of jobs) {
    const job = rec(item)
    const jobId = text(job.job_id)
    const rubric = rec(job.rubric)
    const rubricVersionId = text(rubric.rubric_version_id)
    if (jobId === '' || rubricVersionId === '') continue
    if (bool(rubric.approved)) continue
    out.push({
      jobId,
      jobTitle: text(job.title) !== '' ? text(job.title) : text(job.code),
      jobStatus: text(job.status),
      rubricVersionId,
      versionNo: num(rubric.version_no),
    })
  }
  return out
}

/** Hiring Manager 视图的一行岗位（只读）。 */
export interface HiringJobRow {
  readonly jobId: string
  readonly title: string
  readonly code: string
  readonly status: string
  readonly departmentName: string
  readonly rubricVersionId: string
  readonly rubricApproved: boolean
  readonly totalApplications: number
  readonly activeApplications: number
  readonly nextStepLabel: string
}

/** Hiring Manager 视图的一行申请（只读）。 */
export interface HiringAppRow {
  readonly id: string
  readonly candidateName: string
  readonly jobTitle: string
  readonly stageCode: string
  readonly lifecycleStatus: string
  readonly nextStepCode: string
  readonly nextStepLabel: string
  readonly interviewCount: number
  readonly transcriptState: string
  readonly scorecardsSubmitted: number
  readonly scorecardsRequired: number
  /** 是否属于「待决策」：S10 或 next_step 明确要求决策（来自服务端事实，不猜）。 */
  readonly awaitingDecision: boolean
}

/** Hiring Manager 视图的归一化投影。 */
export interface HiringView {
  readonly configured: boolean
  readonly issues: readonly string[]
  readonly jobs: readonly HiringJobRow[]
  readonly applications: readonly HiringAppRow[]
  readonly pendingApplications: readonly HiringAppRow[]
  readonly interviewsScheduled: number
  readonly awaitingDecision: number
  readonly departments: readonly { readonly id: string; readonly name: string }[]
  readonly hiringTeams: readonly { readonly id: string; readonly code: string; readonly name: string; readonly memberCount: number }[]
}

/**
 * 归一化 hiring manager 视图（坏类型 → ''/0/[]；不编造业务结论）。
 * @param overview - recruiting overview JSON。
 * @returns 视图投影。
 */
export function deriveHiringView(overview: unknown): HiringView {
  const raw = rec(overview)
  const jobs = arr(raw.jobs).map((item): HiringJobRow => {
    const job = rec(item)
    const rubric = rec(job.rubric)
    const counts = rec(job.application_counts)
    const nextStep = rec(job.next_step)
    return {
      jobId: text(job.job_id),
      title: text(job.title) !== '' ? text(job.title) : text(job.code),
      code: text(job.code),
      status: text(job.status),
      departmentName: text(job.department_name),
      rubricVersionId: text(rubric.rubric_version_id),
      rubricApproved: bool(rubric.approved),
      totalApplications: num(counts.total),
      activeApplications: num(counts.active),
      nextStepLabel: text(nextStep.label),
    }
  })
  const applications = arr(raw.applications).map((item): HiringAppRow => {
    const app = rec(item)
    const candidate = rec(app.candidate)
    const job = rec(app.job)
    const progress = rec(app.progress)
    const nextStep = rec(progress.next_step)
    const stageCode = text(app.current_stage_code)
    const nextStepCode = text(nextStep.code)
    // 待决策 = 服务端事实：S10，或 next_step 精确为正式决策码（`PROVIDE_SCREENING_DECISION` 是初筛，不算）。
    const awaitingDecision = stageCode === 'S10' || nextStepCode === 'PROVIDE_DECISION' || nextStepCode === 'PROVIDE_FINAL_DECISION'
    return {
      id: text(app.application_id),
      candidateName: text(candidate.display_name),
      jobTitle: text(job.title),
      stageCode,
      lifecycleStatus: text(app.lifecycle_status),
      nextStepCode,
      nextStepLabel: text(nextStep.label),
      interviewCount: arr(app.interviews).length,
      transcriptState: text(progress.transcript_state),
      scorecardsSubmitted: num(progress.scorecards_submitted),
      scorecardsRequired: num(progress.scorecards_required),
      awaitingDecision,
    }
  }).filter((row) => row.id !== '')
  const counts = rec(raw.counts)
  const settings = rec(raw.settings)
  const departments = arr(settings.departments).map((item) => {
    const dept = rec(item)
    return { id: text(dept.department_id), name: text(dept.name) }
  }).filter((dept) => dept.id !== '')
  const hiringTeams = arr(settings.hiring_teams).map((item) => {
    const team = rec(item)
    return {
      id: text(team.team_id),
      code: text(team.code),
      name: text(team.name),
      memberCount: arr(team.members).length,
    }
  }).filter((team) => team.id !== '')
  const pendingApplications = applications.filter((row) => row.awaitingDecision)
  return {
    configured: bool(raw.configured),
    issues: arr(raw.issues).map((item) => text(item)).filter((item) => item !== ''),
    jobs,
    applications,
    pendingApplications,
    interviewsScheduled: num(counts.interviews_scheduled),
    awaitingDecision: num(counts.awaiting_decision),
    departments,
    hiringTeams,
  }
}

// =====================================================================
//  决策 facts（GET /recruitment/api/decision/facts）归一化
// =====================================================================

/** 决策事实投影的消费口径（只保留 hiring manager 视图要展示/使用的字段，不编造）。 */
export interface DecisionFactsView {
  readonly applicationId: string
  readonly stageCode: string
  readonly summaryAvailable: boolean
  readonly asOf: string
  readonly summaryDigest: string
  readonly missing: readonly { readonly key: string; readonly reason: string }[]
}

/**
 * 归一化 decision facts；缺 `application_id` → null。
 * @param value - 响应 JSON。
 * @returns 视图或 null。
 */
export function normalizeDecisionFacts(value: unknown): DecisionFactsView | null {
  const raw = rec(value)
  const applicationId = text(raw.application_id)
  if (applicationId === '') return null
  const summary = rec(raw.evaluation_summary)
  const evaluation = rec(raw.screening_evaluation)
  const asOf = text(summary.as_of) !== '' ? text(summary.as_of) : text(evaluation.as_of)
  return {
    applicationId,
    stageCode: text(raw.stage_code),
    summaryAvailable: bool(summary.available),
    asOf,
    summaryDigest: text(summary.summary_digest),
    missing: arr(raw.missing).map((item) => {
      const entry = rec(item)
      return { key: text(entry.key), reason: text(entry.reason) }
    }).filter((entry) => entry.key !== ''),
  }
}

/** facts 路由缺失（404）——`work/d5/decision/CONTRACT.md` §4 的消费规则。 */
export function isDecisionFactsMissing(status: number): boolean {
  return status === 404
}

// =====================================================================
//  body 组包（只做契约形状校验，不补业务事实）
// =====================================================================

/**
 * `job/rubric-approve` body：`{job_id, rubric_version_id, reason?}`（reason ≤500）。
 * 出处：`work/d5/actions/CONTRACT.md` §4.1。
 */
export function buildRubricApproveBody(input: {
  readonly jobId: string
  readonly rubricVersionId: string
  readonly reason?: string
}): BodyBuildResult {
  const jobId = text(input.jobId)
  const rubricVersionId = text(input.rubricVersionId)
  const missing: string[] = []
  if (!isUuid(jobId)) missing.push('job_id')
  if (!isUuid(rubricVersionId)) missing.push('rubric_version_id')
  if (missing.length > 0) {
    return fail('MISSING_OR_INVALID_ID', '批准 rubric 需要服务端投影里的 job_id 与 rubric_version_id（UUID）；客户端不编造 id', missing)
  }
  const body: Record<string, unknown> = { job_id: jobId, rubric_version_id: rubricVersionId }
  const reason = text(input.reason).trim()
  if (reason !== '') {
    if (Array.from(reason).length > 500) return fail('REASON_OUT_OF_RANGE', '批准理由不得超过 500 字', ['reason'])
    body.reason = reason
  }
  return { ok: true, body }
}

/**
 * 设置统一入口 body（team create）：`{entity:'team', operation:'create', code, name, department_id}`。
 * 出处：`work/d5/actions/CONTRACT.md` §4.2（`config/team` create）。
 */
export function buildSettingsTeamCreateBody(input: {
  readonly code: string
  readonly name: string
  readonly departmentId: string
}): BodyBuildResult {
  const code = text(input.code).trim()
  const name = text(input.name).trim()
  const departmentId = text(input.departmentId).trim()
  const missing: string[] = []
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(code)) missing.push('code')
  if (name === '' || Array.from(name).length > 200) missing.push('name')
  if (!isUuid(departmentId)) missing.push('department_id')
  if (missing.length > 0) {
    return fail(
      'INVALID_SETTINGS_BODY',
      '招聘团队 create 需要 code（2–41 位大写，字母开头）、name（1–200 字）、department_id（UUID，来自服务端部门投影）',
      missing,
    )
  }
  return { ok: true, body: { entity: 'team', operation: 'create', code, name, department_id: departmentId } }
}

/**
 * 正式决策 facade body：`{application_id, decision_scope:'FINAL', result, reason, as_of?}`。
 * `as_of` 只能原样抄 facts（服务端汇总时用的那个），不允许用浏览器本地时间造。
 * 出处：`work/d5/decision/CONTRACT.md` §3。
 */
export function buildDecisionRecordBody(input: {
  readonly applicationId: string
  readonly result: string
  readonly reason: string
  readonly facts: DecisionFactsView | null
}): BodyBuildResult {
  const applicationId = text(input.applicationId)
  if (!isUuid(applicationId)) return fail('ID_NOT_UUID', '申请 id 必须是 UUID', ['application_id'])
  const result = text(input.result).trim()
  if (!['ADVANCE', 'HOLD', 'REJECT'].includes(result)) {
    return fail('ENUM_INVALID', '正式决策结果只能是 ADVANCE / HOLD / REJECT（HIRED 在 v1.0 禁用）', ['result'])
  }
  const reason = text(input.reason).trim()
  if (reason === '') return fail('MISSING_REASON', '正式决策必须填写理由（1..4000 字）', ['reason'])
  if (Array.from(reason).length > 4000) return fail('REASON_OUT_OF_RANGE', '理由不得超过 4000 字', ['reason'])
  const facts = input.facts
  if (facts === null) return fail('DECISION_FACTS_MISSING', '决策 facts 不可用：不要发送请求（不编造 as_of/summary）', ['facts'])
  if (!facts.summaryAvailable) return fail('SUMMARY_MISSING', 'facts 的 evaluation_summary 不可用（available=false）：正式决策需要服务端汇总', ['summary'])
  if (!isOffsetIso(facts.asOf)) return fail('MISSING_AS_OF', `facts 的 as_of 不是带偏移 ISO-8601：${facts.asOf}`, ['as_of'])
  return {
    ok: true,
    body: { application_id: applicationId, decision_scope: 'FINAL', result, reason, as_of: facts.asOf },
  }
}

// =====================================================================
//  错误码 → 人话（未知返回 ''；界面仍显示服务端原文）
// =====================================================================

const ERROR_ADVICE: Readonly<Record<string, string>> = {
  'FORBIDDEN/ACTOR_NOT_AUTHORIZED':
    '当前 Demo Actor 没有 Host Action 写授权（服务端只授权 recruiter）；这是 fail-closed、零写入。请显式切换为 Recruiter 身份后再执行。',
  'DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND': '当前 session 未绑定 Demo Actor（刷新/宿主重启会丢失）；请重新选择身份。',
  'DEMO_ACTOR_UNMAPPED': '未绑定 Demo Actor：写动作 fail-closed，不发送身份猜测。',
  'INVALID_ARGS/SESSION_REQUIRED': '缺 x-dsh-session：先在工作台选择 Demo Actor。',
  'INVALID_ARGS/UNKNOWN_ACTOR_ALIAS': 'alias 不在受控集合内（服务端 5 个受控 alias）。',
  'INVALID_ARGS/ACTOR_OVERRIDE_REJECTED': '请求里出现了身份/服务端派生键，服务端一律拒绝（客户端不应发送）。',
  'INVALID_ARGS/MISSING_REQUIRED': '必填字段缺失（服务端原文见下）。',
  'INVALID_ARGS/PAYLOAD_HASH_MISMATCH': '审批行绑定的 payload hash 与 rubric 版本不一致：拒绝批准（不猜）。',
  'INVALID_ARGS/APPROVAL_NOT_PENDING': '该审批行已经不是 PENDING（已决/过期/被取代）：不可改判，需新建审批。',
  'NOT_FOUND/APPROVAL_NOT_FOUND': '该 rubric 版本没有审批行（先经岗位创建/更新产生 PENDING 审批）。',
  'NOT_FOUND': '对象不存在（服务端原文见下）。',
  'SUMMARY_MISSING': '正式决策需要服务端 evaluation summary：缺失时 disabled，不发送请求。',
  'DECISION_FACTS_ROUTE_MISSING': '决策 facts 只读投影未接线（GET 404）：决策入口 disabled，不编造 as_of/basis。',
  'DECISION_FACTS_UNAVAILABLE': '决策 facts 读取失败（服务端错误原文见下）：决策入口 disabled。',
  'VERSION_CONFLICT': '并发冲突：记录版本已被更新；刷新后重试。',
  'ALREADY_EXISTS': '同 code 的对象已存在（换一个 code）。',
  'INVALID_ARGS/INVALID_REFERENCE': '引用的部门/actor/阶段/模板不存在。',
  'NETWORK': '网络请求失败：宿主可能未运行。',
  'BAD_RESPONSE': '宿主响应不是可解析 JSON：不当作成功。',
  'READBACK_MISSING': '服务端写后读回不到行：数据异常，不当作成功。',
}

/**
 * 服务端错误码 → 人话补救（未知返回 ''，不吞服务端 message）。
 * @param code - `error.code`。
 * @param reasonCode - `error.reason_code`（可缺省）。
 * @returns 人话或 ''。
 */
export function describeActionError(code: string, reasonCode: string): string {
  return ERROR_ADVICE[`${code}/${reasonCode}`] ?? ERROR_ADVICE[code] ?? ERROR_ADVICE[reasonCode] ?? ''
}

// =====================================================================
//  读回展示
// =====================================================================

const READBACK_LABELS: Readonly<Record<string, string>> = {
  approval_id: '审批行 id',
  status: '状态',
  record_version: '记录版本',
  actor_id: '执行账号 actor',
  decided_at: '决定时间',
  resource_type: '审批对象类型',
  resource_id: '审批对象 id',
  canonical_payload_hash: '审批 payload hash',
  rubric_version_id: 'Rubric 版本 id',
  version_no: '版本号',
  created_by_actor_id: '创建人 actor',
  payload_hash: 'payload hash',
  job_id: '岗位 id',
  current_rubric_version_id: '当前 rubric 指针',
  team_id: '团队 id',
  code: 'code',
  name: '名称',
  decision_id: '决策 id',
  decision_scope: '决策范围',
  result: '结论',
  table: '读回表',
  row: '读回行',
}

/**
 * 把信封 `readback` 摊成展示行（值原样；对象/数组 JSON 序列化并截断）。
 * @param readback - 信封 readback（可 null）。
 * @returns 行数组（键顺序 = 对象顺序）。
 */
export function readbackLines(readback: Readonly<Record<string, unknown>> | null): readonly ReadbackLine[] {
  if (readback === null) return []
  const out: ReadbackLine[] = []
  for (const [key, value] of Object.entries(readback)) {
    const rendered = typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : value === null
          ? 'null'
          : preview(value, 400)
    out.push({ key, label: READBACK_LABELS[key] ?? key, value: rendered })
  }
  return out
}

/**
 * 该 alias 在 v1.0 是否有 Host Action 写授权（与 `role-views.ts` 的 `canExecuteWriteActions` 同源口径）。
 * @param alias - Demo Actor alias。
 */
export function isWriteAuthorizedAliasValue(alias: string | null | undefined): boolean {
  return typeof alias === 'string' && WRITE_AUTHORIZED_ALIASES.includes(alias)
}
