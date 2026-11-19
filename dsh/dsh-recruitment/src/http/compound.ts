// 复合确认（D-159）：一次指令里的多个「业务决定 / 对外写」合并成一张确认卡：
//   全量预检 → 人点一次 → 按顺序执行、逐条回报；中途失败立刻停；不自动回滚已成功的
//   外部写；同一确认文本 + 同一批步骤重复提交不重复执行。
//
// 本文件是**自包含**的 Host 路由注册入口（不改 index.ts / actions.ts）：
//   POST /recruitment/api/action/compound
// 只做 ① HTTP 形状 / 身份 / 同源闸门 ② 只读 DB 事实预检 ③ allow-once 闸门
// ④ 按既有原子工具的真实入参补全并调用 ⑤ 逐条回报。
// **不复制任何业务写逻辑、不绕过闸门**：三个动作全部调用既有工具工厂的 .execute，
// 决定 / 事件 / 审计 / 幂等仍由各自工具完成。步骤解析 / 结构预检 / 人话摘要 / 指纹
// 全部来自 src/domain/compound-plan.ts（纯函数）。
//
// 身份：x-dsh-session → resolveSessionActor → alias 必须是 'recruiter'（否则 403 零写入）。
// body 里的 actor_id / tenant_id 一律 400；库未配置 → 503。
//
// 幂等局限（如实声明）：dedup store 与并发 claim 都是**进程内内存态**——Host 重启后
// 同一提交被当新请求：底层 interview_schedule / candidate_constraint 的持久幂等与
// screening 决策的 already-decided 守卫会拦住重复写，不会破坏数据安全，但用户看到的
// 是「某步被拒/冲突」而不是「这件事已经处理过了」。要跨重启的 replay 语义必须另立
// 持久化裁决（新表/迁移不在本任务授权范围）。本实现不新增工具、不改工具面。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  COMPOUND_ACTIONS,
  fingerprintOf,
  parseCompoundPlan,
  preflightShape,
  summarizeStep,
  type CompoundAction,
  type CompoundPlan,
  type ParsedStep,
  type ParseOutcome,
  type StepPreflight,
} from '../domain/compound-plan.ts'
import {
  confirmationTextSha256,
  createDecisionRecordTool,
  parseDecisionArgs,
} from '../tools/decision-record.ts'
import { createCandidateConstraintTool } from '../tools/candidate-constraint.ts'
import { createInterviewScheduleTool, type ApprovalRequester } from '../tools/interview-schedule.ts'

// =====================================================================
//  契约常量
// =====================================================================

const COMPOUND_PATH = '/recruitment/api/action/compound'
const MAX_BODY_BYTES = 64 * 1024
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

const FORBIDDEN_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias',
  'decided_by_actor_id', 'confirmed_by_actor_id', 'created_by_actor_id',
  'approved_by_actor_id', 'submitted_by_actor_id', 'confirmation_text_sha256',
  'human_confirmation', 'approval_id',
] as const
const FORBIDDEN_QUERY_KEYS = ['actor_id', 'tenant_id'] as const
const FORBIDDEN_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
const ALLOWED_ACTIONS: readonly string[] = COMPOUND_ACTIONS

const DECISION_TOOL_NAME = 'recruitment_decision_record'
const SCHEDULE_TOOL_NAME = 'recruitment_interview_schedule'

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  UNSUPPORTED_STEP: 400,
  COMPOUND_PRECONDITION_FAILED: 400,
  FORBIDDEN: 403,
  SAME_ORIGIN_REQUIRED: 403,
  SESSION_REQUIRED: 400,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_FOUND: 404,
  NOT_CONFIGURED: 503,
  ALREADY_DECIDED: 409,
  ALREADY_SCHEDULED: 409,
  DECISION_REQUIRES_HUMAN: 403,
  EVIDENCE_INSUFFICIENT: 422,
  VERSION_CONFLICT: 409,
  INTERNAL: 500,
  DB_CONSTRAINT_VIOLATION: 500,
  INVARIANT_VIOLATION: 500,
}

// =====================================================================
//  宿主上下文 / 依赖
// =====================================================================

interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface CompoundHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

export interface CompoundHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  HTTP 小工具（封闭错误信封 `{error:{code,reason_code,message,detail?}}`）
// =====================================================================

class CompoundHttpProblem extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'CompoundHttpProblem'
    this.status = status
    this.body = body
  }
}

function httpProblem(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): CompoundHttpProblem {
  return new CompoundHttpProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

function methodNotAllowed(res: ServerResponse): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(405, { allow: 'POST', ...NO_STORE })
  res.end()
}

function isJsonContentType(value: string | undefined): boolean {
  return typeof value === 'string' && value.toLowerCase().split(';')[0]?.trim() === 'application/json'
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES) {
    throw httpProblem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw httpProblem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw httpProblem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE',
      '请求体必须是 Content-Type: application/json', { got: req.headers['content-type'] ?? '' })
  }
  const text = await readBody(req)
  let raw: unknown
  try {
    raw = JSON.parse(text) as unknown
  } catch {
    throw httpProblem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw httpProblem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

function assertSameOrigin(req: IncomingMessage, port: number): void {
  if (!sameOrigin(req, port)) {
    throw httpProblem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED',
      '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）')
  }
}

function rejectOverrides(req: IncomingMessage, url: URL): void {
  const rejected: string[] = []
  for (const key of FORBIDDEN_QUERY_KEYS) {
    if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  }
  for (const key of FORBIDDEN_HEADERS) {
    if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  }
  if (rejected.length > 0) {
    throw httpProblem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 只能来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）', { rejected })
  }
}

function rejectBodyOverrides(body: Record<string, unknown>): void {
  const rejected = FORBIDDEN_BODY_KEYS.filter((key) => Object.hasOwn(body, key)).sort()
  if (rejected.length > 0) {
    throw httpProblem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 与人工确认凭据只能来自服务端绑定，不接受客户端传入（D-33 / D-95）', { rejected })
  }
}

function readSessionHeader(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw httpProblem(400, 'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined
        ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）'
        : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID')
  }
  return normalized
}

function readReasonCode(message: string): string | undefined {
  const index = message.indexOf(': ')
  if (index <= 0) return undefined
  try {
    const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
    return typeof parsed.reason_code === 'string' && parsed.reason_code !== '' ? parsed.reason_code : undefined
  } catch {
    return undefined
  }
}

function requireRecruiter(identity: DemoActorIdentity, sessionId: string): ResolvedExecutionActor {
  let resolved: ResolvedExecutionActor
  try {
    resolved = resolveSessionActor(identity, sessionId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw httpProblem(409, 'DEMO_ACTOR_UNMAPPED', readReasonCode(message) ?? 'DEMO_ACTOR_UNMAPPED', message)
  }
  if (resolved.alias !== 'recruiter') {
    throw httpProblem(403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED',
      `当前身份（${resolved.alias}）无权执行复合确认（只允许 recruiter）`,
      { alias: resolved.alias, allowed_aliases: ['recruiter'] })
  }
  return resolved
}

function requireDatabase(deps: CompoundHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw httpProblem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，写动作不可用',
      { issues: [...deps.databaseIssues] })
  }
  return deps.database
}

/** 解析工具抛错 `<CODE>: <compact-json>`，记逐条失败。 */
function failureOf(error: unknown): { refusal: string; reason_code: string } {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
      const reasonCode = typeof parsed.reason_code === 'string' && parsed.reason_code !== ''
        ? parsed.reason_code : 'UNEXPECTED'
      const human = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      return { refusal: `${code}: ${human}`, reason_code: reasonCode }
    } catch {
      // 落到底部兜底。
    }
  }
  return { refusal: message, reason_code: 'UNEXPECTED' }
}

function parseFailure(outcome: Extract<ParseOutcome, { ok: false }>): CompoundHttpProblem {
  return httpProblem(400, outcome.code, outcome.reason_code, outcome.message,
    outcome.step === undefined ? undefined : { step: outcome.step })
}

function guard(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      if (error instanceof CompoundHttpProblem) {
        json(res, error.status, error.body)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const index = message.indexOf(': ')
      if (index > 0) {
        try {
          const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
          const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
          json(res, STATUS_BY_CODE[code] ?? 500, {
            error: {
              code,
              reason_code: typeof parsed.reason_code === 'string' && parsed.reason_code !== '' ? parsed.reason_code : 'UNEXPECTED',
              message: typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message,
              ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
            },
          })
          return
        } catch {
          // 不是产品错误形态，落到底部 500。
        }
      }
      json(res, 500, { error: { code: 'INTERNAL', reason_code: 'UNEXPECTED', message } })
    }
  }
}

// =====================================================================
//  进程内幂等 store（**已知局限**：重启即失效；见文件头）
// =====================================================================

interface DedupEntry {
  readonly fingerprint: string
  readonly result: Record<string, unknown>
}

const COMPLETED: Map<string, DedupEntry> = new Map()

/**
 * 并发 claim：同一 key 的第二次请求在**同一个同步块**里看到 has + set，
 * 不会 double-execute（Node 单线程；跨进程仍无保护，见文件头）。
 * 等前一个执行结束再读 COMPLETED 返回 replay，不让并发提交拿到半成品。
 */
const INFLIGHT: Map<string, Promise<void>> = new Map()

/**
 * **仅供测试**模拟「Host 重启后内存 dedup 丢失」：清空进程内 replay / claim 状态。
 * 产品路径永不调用；它不碰数据库，也不改变底层工具的持久幂等 / already-decided 守卫。
 * 宿主真实重启时新进程天然得到空 Map，无需调用此函数。
 */
export function resetCompoundDedupStateForTests(): void {
  COMPLETED.clear()
  INFLIGHT.clear()
}

// =====================================================================
//  一次性 allow-once approval（与 actions.ts 同语义）
// =====================================================================

function createAllowOnceGate(expectedToolName: string): ApprovalRequester {
  let requested = 0
  return {
    async request(req: { agent?: unknown; toolName: string; reason?: string; signal?: AbortSignal }): Promise<string> {
      requested += 1
      if (requested > 1) return 'rejected'
      if (req.toolName !== expectedToolName) return 'unavailable'
      return 'allowed-once'
    },
  }
}

function execOf(resolved: ResolvedExecutionActor): Record<string, unknown> {
  return {
    agent: { id: resolved.session_id },
    headers: { [DEMO_SESSION_HEADER]: resolved.session_id },
  }
}

// =====================================================================
//  全量预检（一次性只读事务；零写入）
// =====================================================================

/** SCREENING 决策服务端补工具入参所需的最小事实（全部从库读，不复制业务判定）。 */
interface DecisionFacts {
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly resume_version_id: string | null
  readonly resume_content_sha256: string | null
  readonly hiring_manager_actor_id: string | null
  readonly is_hiring_manager: boolean
  readonly lifecycle_status: string
}

interface PreflightResult {
  readonly checks: readonly StepPreflight[]
  readonly decisions: Readonly<Map<number, DecisionFacts>>
}

interface ApplicationFacts {
  readonly rubric_version_id: string | null
  readonly rubric_payload_hash: string | null
  readonly resume_version_id: string | null
  readonly resume_content_sha256: string | null
  readonly hiring_manager_actor_id: string | null
  readonly lifecycle_status: string
}

/** 合并域结构预检 + 独立只读 DB 事实预检（一次只读事务，零写入）。 */
async function preflight(
  database: ResolvedDatabaseConfig,
  plan: CompoundPlan,
  actorId: string,
): Promise<PreflightResult> {
  const checks: { step: number; action: CompoundAction; ok: boolean; blocked_reason: string }[] =
    preflightShape(plan).map((item) => ({ step: item.step, action: item.action, ok: item.ok, blocked_reason: item.blocked_reason }))
  const decisions = new Map<number, DecisionFacts>()
  const byStep = new Map(checks.map((item) => [item.step, item]))

  const pool = createPool(database)
  try {
    await withReadOnly(pool, async (client) => {
      for (const step of plan.steps) {
        const check = byStep.get(step.step)
        if (check === undefined) continue
        const args = step.args
        const applicationId = typeof args.application_id === 'string' ? args.application_id : ''
        if (!isUuid(applicationId)) continue

        const facts = await loadApplicationFacts(client, database.tenant_id, applicationId)
        if (facts === null) {
          if (check.ok) {
            check.ok = false
            check.blocked_reason = '申请不存在'
          }
          continue
        }

        if (step.action === 'screening_decide') {
          if (check.ok && await hasScreeningDecision(client, database.tenant_id, applicationId)) {
            check.ok = false
            check.blocked_reason = '这条申请已经有过初筛结论，不能重复决定'
          }
          await preflightScreening(check, step, facts, actorId, decisions)
        } else if (step.action === 'candidate_constraint') {
          if (check.ok && args.kind === 'HANDOFF' && typeof args.interview_id === 'string'
            && isUuid(args.interview_id)) {
            const belongs = await interviewBelongsTo(client, database.tenant_id, args.interview_id, applicationId)
            if (!belongs) {
              check.ok = false
              check.blocked_reason = '交接提醒指向的面试不存在或不属于这条申请'
            }
          }
        } else if (step.action === 'interview_schedule') {
          if (check.ok && (args.intent === undefined || args.intent === 'CREATE')) {
            const scheduled = await hasActiveInterview(client, database.tenant_id, applicationId)
            if (scheduled) {
              check.ok = false
              check.blocked_reason = '这条申请已经排过面试'
            }
          }
        }
      }
    })
  } finally {
    await closePool(pool)
  }
  return { checks, decisions }
}

/** SCREENING 事实预检：已决定 / 依据齐全 / 申请未终态；同时缓存执行期补全事实。 */
async function preflightScreening(
  check: { step: number; action: CompoundAction; ok: boolean; blocked_reason: string },
  step: ParsedStep,
  facts: ApplicationFacts,
  actorId: string,
  decisions: Map<number, DecisionFacts>,
): Promise<void> {
  const args = step.args
  const applicationId = String(args.application_id)
  // 下面几条 SQL 需要 client；由调用方 preflight 传入（这里拆出来只为注释清晰）。
  void applicationId
  const decisionFacts: DecisionFacts = {
    rubric_version_id: facts.rubric_version_id ?? '',
    rubric_payload_hash: facts.rubric_payload_hash ?? '',
    resume_version_id: facts.resume_version_id,
    resume_content_sha256: facts.resume_content_sha256,
    hiring_manager_actor_id: facts.hiring_manager_actor_id,
    is_hiring_manager: facts.hiring_manager_actor_id !== null
      && facts.hiring_manager_actor_id.toLowerCase() === actorId.toLowerCase(),
    lifecycle_status: facts.lifecycle_status,
  }
  decisions.set(step.step, decisionFacts)

  if (!check.ok) return
  if (facts.rubric_version_id === null || facts.rubric_payload_hash === null) {
    check.ok = false
    check.blocked_reason = '这条申请没有钉住可用的岗位标准，无法记录初筛结论'
    return
  }
  if (facts.lifecycle_status === 'HIRED' || facts.lifecycle_status === 'REJECTED'
    || facts.lifecycle_status === 'WITHDRAWN') {
    check.ok = false
    check.blocked_reason = '这条申请已经处于终态，不能重复决定'
    return
  }
  const needsEvaluation = args.result === 'PASS' || args.result === 'REJECT'
  if (needsEvaluation) {
    const evaluation = args.evaluation
    const problem = evaluationProblem(evaluation, facts)
    if (problem !== null) {
      check.ok = false
      check.blocked_reason = problem
    }
  }
}

/** 校验随步骤传入的 screening 评估摘要（人/上层已算好的瞬态事实）。 */
function evaluationProblem(
  evaluation: unknown,
  facts: ApplicationFacts,
): string | null {
  if (typeof evaluation !== 'object' || evaluation === null || Array.isArray(evaluation)) {
    return '缺少初筛评估依据（evaluation），无法记录推进/淘汰结论'
  }
  const item = evaluation as Record<string, unknown>
  if (typeof item.evaluation_digest !== 'string' || !/^[0-9a-f]{64}$/.test(item.evaluation_digest)) {
    return '初筛评估依据缺合法的 evaluation_digest（64 位小写 hex）'
  }
  if (item.verdict !== 'PASS' && item.verdict !== 'FAIL' && item.verdict !== 'NEEDS_REVIEW') {
    return '初筛评估依据的 verdict 必须是 PASS / FAIL / NEEDS_REVIEW'
  }
  if (item.rubric_version_id !== facts.rubric_version_id) {
    return '初筛评估依据的岗位标准版本与这条申请钉住的不一致'
  }
  if (item.rubric_payload_hash !== facts.rubric_payload_hash) {
    return '初筛评估依据的岗位标准摘要与库里不一致'
  }
  if (facts.resume_version_id !== null) {
    if (item.resume_version_id !== facts.resume_version_id) {
      return '初筛评估依据用的材料版本不是这条申请钉住的那份'
    }
    if (item.resume_content_sha256 !== facts.resume_content_sha256) {
      return '初筛评估依据的材料摘要与库里不一致'
    }
  }
  return null
}

async function loadApplicationFacts(
  client: DatabaseClient, tenantId: string, applicationId: string,
): Promise<ApplicationFacts | null> {
  const { rows } = await client.query<{
    rubric_version_id: string | null
    rubric_payload_hash: string | null
    resume_version_id: string | null
    resume_content_sha256: string | null
    hiring_manager_actor_id: string | null
    lifecycle_status: string
  }>(
    `select a.rubric_version_id::text as rubric_version_id,
            rv.payload_hash as rubric_payload_hash,
            a.resume_version_id::text as resume_version_id,
            rv2.content_sha256 as resume_content_sha256,
            d.hiring_manager_actor_id::text as hiring_manager_actor_id,
            a.lifecycle_status as lifecycle_status
       from recruitment.application a
       left join recruitment.rubric_version rv
              on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
       left join recruitment.resume_version rv2
              on rv2.id = a.resume_version_id and rv2.tenant_id = a.tenant_id
       left join recruitment.job j
              on j.id = a.job_id and j.tenant_id = a.tenant_id
       left join recruitment.department d
              on d.id = j.department_id and d.tenant_id = j.tenant_id
      where a.id = $1::uuid and a.tenant_id = $2::uuid`,
    [applicationId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) return null
  return {
    rubric_version_id: row.rubric_version_id,
    rubric_payload_hash: row.rubric_payload_hash,
    resume_version_id: row.resume_version_id,
    resume_content_sha256: row.resume_content_sha256,
    hiring_manager_actor_id: row.hiring_manager_actor_id,
    lifecycle_status: row.lifecycle_status,
  }
}

async function hasScreeningDecision(
  client: DatabaseClient, tenantId: string, applicationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `select 1 as one from recruitment.decision
      where application_id = $1::uuid and tenant_id = $2::uuid
        and decision_scope = 'SCREENING'
        and superseded_by_decision_id is null
      limit 1`,
    [applicationId, tenantId],
  )
  return rows.length > 0
}

async function interviewBelongsTo(
  client: DatabaseClient, tenantId: string, interviewId: string, applicationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `select 1 as one from recruitment.interview
      where id = $1::uuid and tenant_id = $2::uuid and application_id = $3::uuid`,
    [interviewId, tenantId, applicationId],
  )
  return rows.length > 0
}

async function hasActiveInterview(
  client: DatabaseClient, tenantId: string, applicationId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ one: number }>(
    `select 1 as one from recruitment.interview
      where application_id = $1::uuid and tenant_id = $2::uuid
        and status not in ('CANCELLED', 'WITHDRAWN')
      limit 1`,
    [applicationId, tenantId],
  )
  return rows.length > 0
}

// =====================================================================
//  顺序执行（复用既有原子工具；不复制业务逻辑）
// =====================================================================

interface StepOutcome {
  readonly step: number
  readonly action: CompoundAction
  readonly ok: boolean
  readonly refusal?: string
  readonly reason_code?: string
}

/** 拼 SCREENING 工具的完整入参；basis_refs 服务端按库事实补全，确认哈希同 actions.ts 口径。 */
function buildDecisionArgs(
  step: ParsedStep,
  resolved: ResolvedExecutionActor,
  facts: DecisionFacts | undefined,
  database: ResolvedDatabaseConfig,
): Record<string, unknown> {
  const args = step.args
  const nowMs = Date.now()
  const result = args.result === 'PASS' ? 'ADVANCE' : args.result === 'REJECT' ? 'REJECT' : 'HOLD'
  const basisRefs: Record<string, unknown>[] = []
  if (facts !== undefined && facts.rubric_version_id !== '' && facts.rubric_payload_hash !== '') {
    basisRefs.push({
      kind: 'RUBRIC_VERSION',
      id: facts.rubric_version_id,
      payload_hash: facts.rubric_payload_hash,
    })
  }
  basisRefs.push({
    kind: 'AUTHORITY',
    actor_id: resolved.actor_id,
    is_hiring_manager: facts?.is_hiring_manager ?? false,
  })
  if ((result === 'ADVANCE' || result === 'REJECT') && args.evaluation !== undefined) {
    basisRefs.push(args.evaluation as Record<string, unknown>)
  }
  const raw: Record<string, unknown> = {
    application_id: args.application_id,
    decision_scope: 'SCREENING',
    as_of: new Date(nowMs).toISOString(),
    result,
    reason: args.reason,
    basis_refs: basisRefs,
  }
  const parsed = parseDecisionArgs(raw, nowMs)
  return {
    ...raw,
    human_confirmation: {
      confirmed_by_actor_id: resolved.actor_id,
      confirmed_at: new Date(nowMs).toISOString(),
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: confirmationTextSha256({
        result: parsed.result,
        reason: parsed.reason,
        override_rationale: parsed.override_rationale ?? null,
        basis_refs: parsed.basis_refs,
      }),
    },
  }
}

/** candidate_constraint：kind → action，其余字段透传。 */
function buildConstraintArgs(step: ParsedStep): Record<string, unknown> {
  const { kind, ...rest } = step.args
  return { ...rest, action: kind === 'HANDOFF' ? 'HANDOFF' : 'PIN' }
}

/** interview_schedule：把域层字段映射成工具真实入参（duration_minutes 代替结束时间）。 */
function buildScheduleArgs(step: ParsedStep, fingerprint: string): Record<string, unknown> {
  const args = step.args
  const intent = typeof args.intent === 'string' ? args.intent : 'CREATE'
  const idempotencyKey = `compound:${fingerprint}:${step.step}`
  const base: Record<string, unknown> = { intent, idempotency_key: idempotencyKey }
  if (intent === 'CREATE') {
    const startMs = Date.parse(String(args.scheduled_start_at))
    const endMs = Date.parse(String(args.scheduled_end_at))
    return {
      ...base,
      application_id: args.application_id,
      round_no: typeof args.round_no === 'number' ? args.round_no : 1,
      slot_code: typeof args.slot_code === 'string' ? args.slot_code : 'DEFAULT',
      scheduled_start_at: new Date(startMs).toISOString(),
      duration_minutes: Math.round((endMs - startMs) / 60_000),
      interviewers: (Array.isArray(args.interviewer_actor_ids) ? args.interviewer_actor_ids : [])
        .map((actorId) => ({
          actor_id: actorId,
          role_in_interview: 'INTERVIEWER',
          required_scorecard: true,
        })),
      timezone: typeof args.timezone === 'string' ? args.timezone : 'Asia/Shanghai',
      delivery_mode: 'VIDEO',
    }
  }
  // 其余 intent：把域层字段透传（去掉 compound 专用的 end/ids，避免工具 UNKNOWN_PARAM）。
  const { scheduled_end_at: _end, interviewer_actor_ids: _ids, ...rest } = args
  return { ...base, ...rest }
}

/** 执行整张卡：逐步调用既有工具；任一步失败立刻停，已成功的外部写不回滚。 */
async function executePlan(
  database: ResolvedDatabaseConfig,
  deps: CompoundHttpDeps,
  resolved: ResolvedExecutionActor,
  plan: CompoundPlan,
  fingerprint: string,
  decisions: Readonly<Map<number, DecisionFacts>>,
): Promise<Record<string, unknown>> {
  const exec = execOf(resolved)
  const outcomes: StepOutcome[] = []
  let succeeded = 0
  let failed = 0
  let stoppedAt: number | null = null

  for (const step of plan.steps) {
    if (!ALLOWED_ACTIONS.includes(step.action)) {
      stoppedAt = step.step
      failed += 1
      outcomes.push({
        step: step.step, action: step.action, ok: false,
        refusal: `不支持的步骤 ${step.action}`, reason_code: 'UNSUPPORTED_STEP',
      })
      break
    }
    try {
      if (step.action === 'screening_decide') {
        const gate = createAllowOnceGate(DECISION_TOOL_NAME)
        const tool = createDecisionRecordTool({
          database, approval: gate, identity: deps.identity,
        })
        await tool.execute(buildDecisionArgs(step, resolved, decisions.get(step.step), database), exec)
      } else if (step.action === 'candidate_constraint') {
        const tool = createCandidateConstraintTool({ database, identity: deps.identity })
        await tool.execute(buildConstraintArgs(step), exec)
      } else {
        const gate = createAllowOnceGate(SCHEDULE_TOOL_NAME)
        const tool = createInterviewScheduleTool(database, {
          approval: gate, identity: deps.identity,
        })
        await tool.execute(buildScheduleArgs(step, fingerprint), exec)
      }
      succeeded += 1
      outcomes.push({ step: step.step, action: step.action, ok: true })
    } catch (error) {
      const failure = failureOf(error)
      failed += 1
      stoppedAt = step.step
      outcomes.push({ step: step.step, action: step.action, ok: false, ...failure })
      break
    }
  }

  const notExecuted = plan.steps.slice(succeeded + failed).map((step) => step.step)
  return {
    steps: outcomes,
    succeeded,
    failed,
    not_executed: notExecuted,
    ...(stoppedAt === null ? {} : { stopped_at: stoppedAt }),
    fingerprint,
    replay: false,
    notes: failed > 0
      ? '已完成步骤不自动回滚；失败步骤与其后未执行步骤如实列出，请人工处理'
      : '全部步骤已按顺序执行完成',
  }
}

// =====================================================================
//  请求处理
// =====================================================================

async function handleCompound(
  deps: CompoundHttpDeps, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const sessionId = readSessionHeader(req)
  const resolved = requireRecruiter(deps.identity, sessionId)
  const body = await readJsonObject(req)
  rejectBodyOverrides(body)
  const database = requireDatabase(deps)

  const parsed = parseCompoundPlan(body)
  if (!parsed.ok) throw parseFailure(parsed)
  const plan = parsed.plan
  const fingerprint = fingerprintOf(plan.confirmation_text, plan.steps)

  // 预览必须跑只读预检给人看 blocked_reason，不参与 dedup。
  if (plan.preview_only) {
    const pre = await preflight(database, plan, resolved.actor_id)
    const checks = pre.checks.map((item) => ({
      step: item.step,
      action: item.action,
      ok: item.ok,
      blocked_reason: item.blocked_reason,
      ...(item.ok ? { summary: summarizeStep(plan.steps[item.step] as ParsedStep) } : {}),
    }))
    json(res, 200, {
      preview: true,
      fingerprint,
      steps: checks,
      all_ok: checks.every((item) => item.ok),
    })
    return
  }

  // 重放检测**先于**任何预检 / 写操作（含只读 DB 连接）：
  // 已执行过的指纹直接回放原结果，不重复执行、不重复建连接。
  const key = `${database.tenant_id}:${fingerprint}`
  const replay = COMPLETED.get(key)
  if (replay !== undefined) {
    // 人话口径：明确"已处理过、这次没重复执行"，不与底层冲突/拒绝混为一谈。
    json(res, 200, {
      ...replay.result,
      replay: true,
      notes: '这件事已经处理过了（这次没有重复执行）',
    })
    return
  }

  // 并发 claim：has + set 在同一个同步代码块，无 await 间隔（Node 单线程）。
  const running = INFLIGHT.get(key)
  if (running !== undefined) {
    await running
    const done = COMPLETED.get(key)
    if (done !== undefined) {
      json(res, 200, {
        ...done.result,
        replay: true,
        notes: '这件事已经处理过了（这次没有重复执行）',
      })
      return
    }
    throw httpProblem(409, 'COMPOUND_IN_FLIGHT', 'COMPOUND_IN_FLIGHT',
      '同一确认卡正在执行中，请稍后重试（不重复执行）')
  }
  let release!: () => void
  const completion = new Promise<void>((resolvePromise) => { release = resolvePromise })
  INFLIGHT.set(key, completion)

  try {
    const pre = await preflight(database, plan, resolved.actor_id)
    const checks = pre.checks.map((item) => ({
      step: item.step,
      action: item.action,
      ok: item.ok,
      blocked_reason: item.blocked_reason,
      ...(item.ok ? { summary: summarizeStep(plan.steps[item.step] as ParsedStep) } : {}),
    }))
    const blocked = checks.filter((item) => !item.ok)
    if (blocked.length > 0) {
      throw httpProblem(400, 'COMPOUND_PRECONDITION_FAILED', 'COMPOUND_PRECONDITION_FAILED',
        `整张确认卡未执行：${blocked[0]?.blocked_reason ?? '有步骤缺少前置条件'}`,
        { steps: blocked.map((item) => ({
          step: item.step, action: item.action, blocked_reason: item.blocked_reason,
        })) })
    }
    const result = await executePlan(database, deps, resolved, plan, fingerprint, pre.decisions)
    // 整张卡执行完毕（含部分失败）后写入：重复提交不重复执行。
    COMPLETED.set(key, { fingerprint, result })
    json(res, 200, result)
  } finally {
    INFLIGHT.delete(key)
    release()
  }
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 注册复合确认 Host Action；返回 disposer。非回环监听不注册并告警（fail-closed）。
 */
export function registerCompoundHttp(ctx: CompoundHostContext, deps: CompoundHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 复合确认路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const handler = guard(async (req: IncomingMessage, res: ServerResponse) => {
    assertSameOrigin(req, port)
    const url = new URL(req.url ?? '/', 'http://localhost')
    rejectOverrides(req, url)
    if (req.method !== 'POST') {
      methodNotAllowed(res)
      return
    }
    await handleCompound(deps, req, res)
  })
  return webServer.register({ kind: 'exact', path: COMPOUND_PATH, handler })
}
