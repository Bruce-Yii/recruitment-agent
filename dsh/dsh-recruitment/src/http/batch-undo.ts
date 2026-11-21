// 批量不通过 / 撤销（5 秒 Toast）两个 HTTP Host Remote Action。
//
// 前缀 `/recruitment/api/action`（与 actions.ts 同前缀但**不同 exact path**，webServer 的
// `(kind,path)` 去重不冲突）。只注册 exact path：
//   POST /recruitment/api/action/decision/batch-reject
//   POST /recruitment/api/action/undo
//
// 闸门照 `http/actions.ts` 既有模式（**逐条照抄判据，不复制业务逻辑**）：
//   * 非回环 host → 不注册任何路由（fail-closed）；
//   * sameOrigin（Host=127.0.0.1/localhost:<port> + x-recruitment-request:1）；
//   * `x-dsh-session` → resolveSessionActor（与写工具共享同一个 identity 单例）；
//     未绑定 → 409 DEMO_ACTOR_UNMAPPED；越权（非 recruiter）→ 403 FORBIDDEN；
//   * 身份覆盖键（actor_id/tenant_id/… 与 confirmation_text_sha256）在 body/query/header
//     出现即 400 **零写入**；
//   * `confirmation_text` 是人的原话，**sha256 只由服务端算**（sha256Text）；
//   * 数据库未配置 → 503（不假装成功）。
//
// 语义：
//   * batch-reject：逐个走既有决策域（子代理 C 的 `runBatchReject` 复用
//     `createRecordHumanDecisionTool`，每个申请独立事务；部分失败不回滚已成功的）。
//     每个成功项另起事务写一条 undo_log ORIGINAL 行（撤销窗口的事实来源）+ 一条批次级
//     batch_operation 行。两表 append-only，审计只存摘要与引用，不抄业务内容。
//   * undo：**补偿而非删除**——决策撤销走既有 decision 域 supersede，排期撤销走既有
//     interview_schedule CANCEL；写一条 undo_log COMPENSATION 行 + batch_operation(UNDO)
//     行，并把 ORIGINAL 行的 compensation_action_id 条件更新过去。历史行一律不物理删除。
//     时限/幂等/越权/后续影响由子代理 A 的 `precheckUndo` 纯函数判定，任一不过 **零写入**。
//
// 不做：不复制决策/排期业务规则、不新增工具（工具面 33 不变）、不新增事件类型
// （逐条审计靠既有 decision.record / interview.cancelled 事件）。
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { sha256Text } from '../domain/criterion-override.ts'
import { isUuid } from '../tools/contract.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorAlias,
  type DemoActorIdentity,
  type ResolvedExecutionActor,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import { parseBatchRejectInput, runBatchReject } from '../domain/batch-reject.ts'
import { planCompensation, precheckUndo, type UndoTargetRef } from '../domain/undo.ts'
import {
  findBatchOperation,
  findUndoLogCompensation,
  findUndoLogOriginal,
  insertBatchOperation,
  insertUndoLog,
  linkCompensation,
} from '../db/undo-log.ts'
// 静态 import：两条补偿路径都是既有域的唯一写入口（不另造事件、不自己写业务表）。
import { confirmationTextSha256, recordDecisionInTransaction } from '../tools/decision-record.ts'
import { scheduleInTransaction } from '../tools/interview-schedule.ts'

// =====================================================================
//  契约常量
// =====================================================================

const ACTION_PREFIX = '/recruitment/api/action'
const BATCH_REJECT_PATH = `${ACTION_PREFIX}/decision/batch-reject`
const UNDO_PATH = `${ACTION_PREFIX}/undo`

/** 允许调用写动作的受控 alias（与 http/actions.ts 同口径）。 */
const ALLOWED_ALIASES: readonly DemoActorAlias[] = ['recruiter']

/** 请求体上限 64 KiB（超限 413，零写入）。 */
const MAX_BODY_BYTES = 64 * 1024

/** 身份 / 服务端派生键：命中即 400（零写入）。 */
const ACTOR_OVERRIDE_BODY_KEYS = [
  'actor_id', 'tenant_id', 'actor', 'tenant', 'alias', 'actor_alias',
  'confirmed_by_actor_id', 'confirmation_text_sha256', 'confirmation_text_sha256_hex',
] as const
const ACTOR_OVERRIDE_QUERY_KEYS = ['actor_id', 'tenant_id'] as const
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const

/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 领域/HTTP 错误码 → HTTP 状态（未列出的码一律 500，不猜）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  DECISION_REQUIRES_HUMAN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  UNDO_WINDOW_EXPIRED: 409,
  UNDO_SUPERSEDED: 409,
  ALREADY_UNDONE: 409,
  VERSION_CONFLICT: 409,
  ALREADY_DECIDED: 409,
  BLOCKED: 409,
  EVIDENCE_INSUFFICIENT: 422,
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

/** `src/index.ts` 把 cordis Context 窄成这个形状再传进来。 */
export interface BatchUndoHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 两条路由的依赖：库配置 + 与写工具共享的 Demo Actor 身份单例。 */
export interface BatchUndoHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  readonly identity: DemoActorIdentity
}

// =====================================================================
//  HTTP 小工具（封闭错误信封）
// =====================================================================

class BatchUndoProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'BatchUndoProblem'
    this.status = status
    this.body = body
  }
}

function problem(status: number, code: string, reasonCode: string, message: string, detail?: unknown): BatchUndoProblem {
  return new BatchUndoProblem(status, {
    error: { code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) },
  })
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(405, { allow, ...NO_STORE })
  res.end()
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > MAX_BODY_BYTES) {
    throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw problem(413, 'INVALID_ARGS', 'BODY_TOO_LARGE', `请求体不得超过 ${MAX_BODY_BYTES} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = req.headers['content-type']
  if (typeof contentType !== 'string' || contentType.toLowerCase().split(';')[0]?.trim() !== 'application/json') {
    throw problem(415, 'INVALID_ARGS', 'UNSUPPORTED_MEDIA_TYPE', '请求体必须是 Content-Type: application/json')
  }
  const text = await readBody(req)
  let raw: unknown
  try { raw = JSON.parse(text) as unknown } catch {
    throw problem(400, 'INVALID_ARGS', 'INVALID_JSON', '请求体不是合法 JSON（零写入）')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw problem(400, 'INVALID_ARGS', 'TYPE_MISMATCH', '请求体必须是 JSON 对象', { path: 'body' })
  }
  return raw as Record<string, unknown>
}

function rejectOverrides(req: IncomingMessage, url: URL, body: Record<string, unknown>): void {
  const rejected: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY_KEYS) if (url.searchParams.has(key)) rejected.push(`query.${key}`)
  for (const key of ACTOR_OVERRIDE_HEADERS) if (req.headers[key] !== undefined) rejected.push(`header.${key}`)
  for (const key of ACTOR_OVERRIDE_BODY_KEYS) if (Object.hasOwn(body, key)) rejected.push(`body.${key}`)
  if (rejected.length > 0) {
    throw problem(
      400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
      'actor/tenant 与服务端派生 hash 只能来自服务端，不接受客户端传入（D-33 / D-95，零写入）',
      { rejected },
    )
  }
}

function readSession(req: IncomingMessage): string {
  const rawValue = req.headers[DEMO_SESSION_HEADER]
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue
  const normalized = normalizeSessionId(raw)
  if (normalized === null) {
    throw problem(
      400, 'INVALID_ARGS',
      raw === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
      raw === undefined ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
    )
  }
  return normalized
}

function requireActor(deps: BatchUndoHttpDeps, req: IncomingMessage): ResolvedExecutionActor {
  const resolved = resolveSessionActor(deps.identity, readSession(req))
  if (!(ALLOWED_ALIASES as readonly string[]).includes(resolved.alias)) {
    throw problem(
      403, 'FORBIDDEN', 'ACTOR_NOT_AUTHORIZED',
      `当前身份（${resolved.alias}）无权执行该招聘写动作（只允许 ${ALLOWED_ALIASES.join(', ')}）`,
      { alias: resolved.alias, allowed_aliases: [...ALLOWED_ALIASES] },
    )
  }
  return resolved
}

function requireDatabase(deps: BatchUndoHttpDeps): ResolvedDatabaseConfig {
  if (deps.database === null) {
    throw problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，写动作不可用', {
      issues: [...deps.databaseIssues],
    })
  }
  return deps.database
}

/** 服务端算 confirmation_text 的 sha256（人的原话；派生 hash 禁从 body 传入）。 */
function confirmationSha256(body: Record<string, unknown>): { text: string; sha256: string } {
  const text = body.confirmation_text
  if (typeof text !== 'string' || text.trim() === '' || text.length > 2000) {
    throw problem(
      400, 'INVALID_ARGS', 'MISSING_REQUIRED',
      '缺必填字段 "confirmation_text"（人的原话，非空且 ≤2000 字符）',
      { missing: ['confirmation_text'] },
    )
  }
  return { text, sha256: sha256Text(text) }
}

/** 把任意错误翻成 HTTP 状态 + 封闭信封（生产错误 `CODE: {compact-json}` 优先）。 */
function errorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof BatchUndoProblem) return { status: error.status, body: error.body }
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : message.slice(0, index)
      const detail: Record<string, unknown> = {}
      if (typeof parsed.reason_code === 'string') detail.reason_code = parsed.reason_code
      if (typeof parsed.message === 'string') detail.message = parsed.message
      if (parsed.detail !== undefined) detail.detail = parsed.detail
      return {
        status: STATUS_BY_CODE[code] ?? 500,
        body: {
          error: {
            code,
            ...(typeof parsed.reason_code === 'string' ? { reason_code: parsed.reason_code } : {}),
            message: typeof parsed.message === 'string' ? parsed.message : message,
            ...(parsed.detail === undefined ? {} : { detail: parsed.detail }),
          },
        },
      }
    } catch { /* 不是产品错误形态，下面兜底 */ }
  }
  // 域层（如 parseBatchRejectInput）抛普通 Error 时把 `code` 属性解出来映射成 HTTP 状态，
  // 不是一律 500（契约错误必须是 4xx，否则人看到"服务器坏了"而不是"参数不对"）。
  const maybeCode = (error as { code?: unknown } | null)?.code
  const code = typeof maybeCode === 'string' && maybeCode !== '' ? maybeCode : 'INTERNAL'
  return {
    status: STATUS_BY_CODE[code] ?? 500,
    body: { error: { code, reason_code: 'UNEXPECTED', message } },
  }
}

function guard(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try { await handler(req, res) } catch (error) {
      const { status, body } = errorResponse(error)
      json(res, status, body)
    }
  }
}

// =====================================================================
//  POST /recruitment/api/action/decision/batch-reject
// =====================================================================

/** 批量不通过响应（每条如实，部分失败也是 HTTP 200）。 */
interface BatchRejectResponse {
  readonly action: 'decision/batch-reject'
  readonly action_id: string
  readonly actor: { readonly session_id: string; readonly alias: string; readonly actor_id: string }
  readonly results: readonly {
    readonly application_id: string
    readonly ok: boolean
    readonly action_id?: string
    readonly decision_id?: string
    readonly reason_code?: string
    readonly message?: string
  }[]
  readonly succeeded: number
  readonly failed: number
  readonly confirmation_text_sha256: string
  readonly audit: { readonly batch_operation_id: string; readonly undo_log_rows: number }
}

async function handleBatchReject(deps: BatchUndoHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const resolved = requireActor(deps, req)
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const database = requireDatabase(deps)
  const confirmation = confirmationSha256(body)
  const input = parseBatchRejectInput(body)
  const batchActionId = randomUUID()
  const nowMs = Date.now()

  // 1) 逐条走既有决策域（每条独立池/独立事务；部分失败不回滚已成功的）。
  const batch = await runBatchReject({
    database,
    identity: deps.identity,
    session_id: resolved.session_id,
    actor_id: resolved.actor_id,
    now_ms: nowMs,
  }, input)

  // 2) 审计写入：批次级 batch_operation + 每条成功的 undo_log ORIGINAL 行。
  //    用短连接池；每条一个独立 withActor 事务，审计写失败不回滚业务成功（如实报错给前端）。
  const targetSummary = batch.results.map((item) => ({
    application_id: item.application_id,
    ok: item.ok,
    ...(item.reason_code === undefined ? {} : { reason_code: item.reason_code }),
  }))
  const pool = createPool(database)
  let batchOperationId = ''
  let undoLogRows = 0
  try {
    batchOperationId = await withActor(pool, resolved.actor_id, (client) => insertBatchOperation(client, {
      tenant_id: database.tenant_id,
      action_id: batchActionId,
      operation_type: 'BATCH_REJECT',
      actor_id: resolved.actor_id,
      reason: input.reason,
      confirmation_text_sha256: confirmation.sha256,
      target_count: batch.results.length,
      succeeded_count: batch.succeeded,
      failed_count: batch.failed,
      target_summary: targetSummary,
    }))
    for (const item of batch.results) {
      if (item.ok !== true) continue
      const perItemActionId = randomUUID()
      await withActor(pool, resolved.actor_id, (client) => insertUndoLog(client, {
        tenant_id: database.tenant_id,
        action_id: perItemActionId,
        kind: 'ORIGINAL',
        operation_type: 'SINGLE_DECISION',
        actor_id: resolved.actor_id,
        reason: input.reason,
        confirmation_text_sha256: confirmation.sha256,
        target_application_id: item.application_id,
        target_decision_id: item.decision_id ?? null,
        action_type: 'DECISION',
        before_summary: { batch_action_id: batchActionId, stage_before: 'S6/S7' },
        after_summary: { decision_id: item.decision_id ?? null, result: 'REJECT' },
      }))
      ;(item as { action_id?: string }).action_id = perItemActionId
      undoLogRows += 1
    }
  } finally {
    await closePool(pool)
  }

  const response: BatchRejectResponse = {
    action: 'decision/batch-reject',
    action_id: batchActionId,
    actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
    results: batch.results,
    succeeded: batch.succeeded,
    failed: batch.failed,
    confirmation_text_sha256: confirmation.sha256,
    audit: { batch_operation_id: batchOperationId, undo_log_rows: undoLogRows },
  }
  json(res, 200, response)
}

// =====================================================================
//  POST /recruitment/api/action/undo
// =====================================================================

interface UndoResponse {
  readonly action: 'undo'
  readonly action_id: string
  readonly actor: { readonly session_id: string; readonly alias: string; readonly actor_id: string }
  readonly status: 'undone' | 'already_undone'
  readonly compensation_action_id?: string
  readonly target: { readonly application_id?: string; readonly decision_id?: string; readonly interview_id?: string }
  readonly confirmation_text_sha256: string
  readonly audit?: { readonly undo_log_id: string; readonly batch_operation_id: string }
}

async function handleUndo(deps: BatchUndoHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const resolved = requireActor(deps, req)
  const body = await readJsonObject(req)
  rejectOverrides(req, url, body)
  const database = requireDatabase(deps)
  const confirmation = confirmationSha256(body)
  const actionId = body.action_id
  if (typeof actionId !== 'string' || !isUuid(actionId)) {
    throw problem(400, 'INVALID_ARGS', 'INVALID_UUID', 'action_id 必须是 UUID', { path: 'action_id' })
  }

  // ---- 只读预检（零写入）：原记录 / 是否已有补偿 / 时限 / 越权 / 后续影响 ----
  const pool = createPool(database)
  let originalRow: Awaited<ReturnType<typeof findUndoLogOriginal>>
  let existingCompensation: Awaited<ReturnType<typeof findUndoLogCompensation>>
  try {
    originalRow = await withReadOnly(pool, (client) => findUndoLogOriginal(client, database.tenant_id, actionId))
    if (originalRow === undefined) {
      throw problem(404, 'NOT_FOUND', 'ACTION_NOT_FOUND', '该 action_id 在本租户下没有可撤销的原记录（零写入）', {
        action_id: actionId,
      })
    }
    // COMPENSATION 行的 action_id = 补偿动作自己的 id；ORIGINAL 行通过
    // compensation_action_id 指向它。先读 ORIGINAL 的指针，再按指针查补偿行。
    const compensationPointer = originalRow.compensation_action_id
    existingCompensation = compensationPointer === null
      ? undefined
      : await withReadOnly(pool, (client) => findUndoLogCompensation(client, database.tenant_id, compensationPointer))
  } finally {
    await closePool(pool)
  }
  // 上面已判空：此处 originalRow 一定存在（TS 控制流在 try/finally 后收窄）。
  if (originalRow === undefined) throw new Error('unreachable: undo log original checked above')
  const original = originalRow
  // 幂等：同一 action_id 撤销两次 → 第二次 already_undone，零写入。
  if (existingCompensation !== undefined) {
    json(res, 200, {
      action: 'undo',
      action_id: actionId,
      actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
      status: 'already_undone',
      compensation_action_id: existingCompensation.action_id,
      target: {
        ...(original.target_application_id === null ? {} : { application_id: original.target_application_id }),
        ...(original.target_decision_id === null ? {} : { decision_id: original.target_decision_id }),
        ...(original.target_interview_id === null ? {} : { interview_id: original.target_interview_id }),
      },
      confirmation_text_sha256: confirmation.sha256,
    } satisfies UndoResponse)
    return
  }
  const precheck = precheckUndo({
    tenant_id: database.tenant_id,
    actor_id: resolved.actor_id,
    action_id: actionId,
    action_type: original.action_type as 'DECISION' | 'SCHEDULE',
    occurred_at: original.occurred_at,
    actor_id_of_action: original.actor_id,
    compensation_action_id: original.compensation_action_id,
    superseded_by_action_id: original.superseded_by_action_id,
    now_ms: Date.now(),
  })
  if (precheck.ok !== true) {
    // 409：UNDO_WINDOW_EXPIRED / UNDO_SUPERSEDED / ACTOR_MISMATCH，零写入。
    throw problem(
      precheck.code === 'ACTOR_MISMATCH' ? 403 : 409,
      precheck.code, precheck.code, precheck.message, precheck.detail,
    )
  }

  // ---- 补偿计划（纯函数，决定走哪条既有域路径）----
  const targetRef: UndoTargetRef = {
    application_id: original.target_application_id ?? '',
    ...(original.target_decision_id === null ? {} : { decision_id: original.target_decision_id }),
    ...(original.operation_type === 'SINGLE_DECISION' || original.operation_type === 'BATCH_REJECT'
      ? { decision_scope: 'SCREENING' as const, decision_stage_code: 'S7' }
      : {}),
    ...(original.target_interview_id === null ? {} : { interview_id: original.target_interview_id }),
    reason: `撤销：${original.reason}`,
    confirmation_text: confirmation.text,
  }
  const plan = planCompensation(targetRef, original.action_type as 'DECISION' | 'SCHEDULE', resolved.actor_id, new Date().toISOString())
  if (plan.kind === 'DECISION' && targetRef.decision_id === undefined) {
    throw problem(400, 'INVALID_ARGS', 'UNDO_TARGET_INCOMPLETE', '决策撤销缺 decision_id（零写入）', {
      action_id: actionId,
    })
  }
  if (plan.kind === 'SCHEDULE' && targetRef.interview_id === undefined) {
    throw problem(400, 'INVALID_ARGS', 'UNDO_TARGET_INCOMPLETE', '排期撤销缺 interview_id（零写入）', {
      action_id: actionId,
    })
  }

  // ---- 执行补偿（既有域路径）+ 写撤销审计（同事务；失败整体回滚）----
  const compensationActionId = randomUUID()
  const compPool = createPool(database)
  let undoLogId = ''
  let batchOperationId = ''
  try {
    await withActor(compPool, resolved.actor_id, async (client) => {
      if (plan.kind === 'DECISION') {
        // 决策撤销：既有 decision 域 supersede 路径（反向插 + 换指针 + 旧行版本 +1）。
        // supersedes.expected_record_version 占位 0 由库里当前 decision 行真值覆盖（DC-39）。
        const current = await client.query<{ record_version: number }>(
          `select record_version from recruitment.decision
            where id = $1::uuid and tenant_id = $2::uuid and superseded_by_decision_id is null`,
          [targetRef.decision_id, database.tenant_id],
        )
        const row = current.rows[0]
        if (row === undefined) {
          throw problem(409, 'UNDO_SUPERSEDED', 'UNDO_SUPERSEDED', '目标决策已不在当前状态（可能已被后续动作影响），零写入', {
            decision_id: targetRef.decision_id,
          })
        }
        const args = plan.args as Record<string, unknown>
        const supersedes = { ...(args.supersedes as Record<string, unknown>), expected_record_version: row.record_version }
        // SCREENING 域闸门要求 basis_refs 除 SUPERSEDES 外还必带 RUBRIC_VERSION + AUTHORITY
        // （§17.1；WITHDRAW 不要求 SCREENING_EVALUATION）。这些事实只能来自库，不复制规则。
        const facts = await client.query<{
          rubric_version_id: string | null
          payload_hash: string | null
          hiring_manager_actor_id: string | null
        }>(
          `select a.rubric_version_id::text as rubric_version_id,
                  rv.payload_hash,
                  d.hiring_manager_actor_id::text as hiring_manager_actor_id
             from recruitment.application a
             left join recruitment.rubric_version rv
               on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
             left join recruitment.job j
               on j.id = a.job_id and j.tenant_id = a.tenant_id
             left join recruitment.department d
               on d.id = j.department_id and d.tenant_id = j.tenant_id
            where a.id = $1::uuid and a.tenant_id = $2::uuid`,
          [targetRef.application_id, database.tenant_id],
        )
        const fact = facts.rows[0]
        if (fact?.rubric_version_id === null || fact?.rubric_version_id === undefined
          || typeof fact.payload_hash !== 'string') {
          throw problem(409, 'INVALID_ARGS', 'NO_RUBRIC', '申请没有钉住可用的 Rubric 版本，撤销无法绑定标准（零写入）', {
            application_id: targetRef.application_id,
          })
        }
        const isHiringManager = fact.hiring_manager_actor_id !== null
          && fact.hiring_manager_actor_id.toLowerCase() === resolved.actor_id.toLowerCase()
        const basisRefs: Record<string, unknown>[] = [
          ...(args.basis_refs as Record<string, unknown>[]),
          { kind: 'RUBRIC_VERSION', id: fact.rubric_version_id, payload_hash: fact.payload_hash },
          { kind: 'AUTHORITY', actor_id: resolved.actor_id, is_hiring_manager: isHiringManager },
        ]
        // 人的原话是 v2 授权凭据：sha256 必须按决策域的 pre-image 算（{result, reason,
        // override_rationale, basis_refs, preimage_version:2, confirmation_text,
        // confirmed_by_actor_id, confirmed_at}），不能用 sha256(原话) 顶替（会触发
        // DECISION_REQUIRES_HUMAN / CONFIRMATION_TEXT_MISMATCH）。这里复用权威函数。
        const confirmation = args.human_confirmation as Record<string, unknown>
        const decisionHash = confirmationTextSha256({
          result: args.result as 'WITHDRAW',
          reason: args.reason as string,
          override_rationale: null,
          basis_refs: basisRefs,
          confirmation_text: confirmation.confirmation_text as string,
          confirmed_by_actor_id: confirmation.confirmed_by_actor_id as string,
          confirmed_at: confirmation.confirmed_at as string,
        })
        await recordDecisionInTransaction(client, database, {
          ...args,
          supersedes,
          basis_refs: basisRefs,
          human_confirmation: { ...confirmation, confirmation_text_sha256: decisionHash },
        }, Date.now(), async () => 'allowed-once' as never)
      } else {
        // 排期撤销：既有 interview_schedule 的 CANCEL 路径（CANCELLED，不删行）。
        // expected_record_version 占位 0 由库里当前 interview 行真值覆盖（乐观锁）。
        const current = await client.query<{ record_version: number }>(
          `select record_version from recruitment.interview
            where id = $1::uuid and tenant_id = $2::uuid`,
          [targetRef.interview_id, database.tenant_id],
        )
        const row = current.rows[0]
        if (row === undefined) {
          throw problem(404, 'NOT_FOUND', 'INTERVIEW_NOT_FOUND', '目标面试不在本租户下（零写入）', {
            interview_id: targetRef.interview_id,
          })
        }
        // CANCEL 必填 idempotency_key（域幂等 STORE）；用补偿 action_id 派生，
        // 同一次撤销重试落同一个键，不重复取消（既有幂等行为）。
        const args = {
          ...(plan.args as Record<string, unknown>),
          expected_record_version: row.record_version,
          idempotency_key: `undo:${compensationActionId}`,
        }
        await scheduleInTransaction(client, database, args, Date.now(), async () => 'allowed-once' as never)
      }
      undoLogId = await insertUndoLog(client, {
        tenant_id: database.tenant_id,
        action_id: compensationActionId,
        kind: 'COMPENSATION',
        operation_type: 'UNDO',
        actor_id: resolved.actor_id,
        reason: targetRef.reason,
        confirmation_text_sha256: confirmation.sha256,
        target_application_id: original.target_application_id,
        target_decision_id: original.target_decision_id,
        target_interview_id: original.target_interview_id,
        before_summary: { action_id: actionId, kind: original.operation_type },
        after_summary: { kind: plan.kind, compensation_of: actionId },
      })
      const linked = await linkCompensation(client, database.tenant_id, actionId, compensationActionId)
      if (linked === 0) {
        // 条件更新没命中 = 已有人抢先撤销（竞态）；抛错让整个补偿事务回滚，零写入。
        throw problem(409, 'ALREADY_UNDONE', 'ALREADY_UNDONE', '该动作已被并发撤销（零写入）', { action_id: actionId })
      }
    })
    batchOperationId = await withActor(compPool, resolved.actor_id, (client) => insertBatchOperation(client, {
      tenant_id: database.tenant_id,
      action_id: compensationActionId,
      operation_type: 'UNDO',
      actor_id: resolved.actor_id,
      reason: targetRef.reason,
      confirmation_text_sha256: confirmation.sha256,
      target_count: 1,
      succeeded_count: 1,
      failed_count: 0,
      target_summary: [{ application_id: original.target_application_id ?? '', ok: true }],
    }))
  } finally {
    await closePool(compPool)
  }

  // ---- 独立只读读回（写后事实：确认撤销审计两行都真的落库）----
  const auditPool = createPool(database)
  try {
    const verified = await withReadOnly(auditPool, async (client) => {
      const compensation = await findUndoLogCompensation(client, database.tenant_id, compensationActionId)
      const batch = await findBatchOperation(client, database.tenant_id, compensationActionId)
      return compensation !== undefined && batch !== undefined
    })
    if (!verified) {
      throw problem(500, 'INTERNAL', 'UNDO_READBACK_MISSING', '撤销写事务已提交但读回不到审计行', {
        action_id: actionId,
      })
    }
  } finally {
    await closePool(auditPool)
  }
  json(res, 200, {
    action: 'undo',
    action_id: actionId,
    actor: { session_id: resolved.session_id, alias: resolved.alias, actor_id: resolved.actor_id },
    status: 'undone',
    compensation_action_id: compensationActionId,
    target: {
      ...(original.target_application_id === null ? {} : { application_id: original.target_application_id }),
      ...(original.target_decision_id === null ? {} : { decision_id: original.target_decision_id }),
      ...(original.target_interview_id === null ? {} : { interview_id: original.target_interview_id }),
    },
    confirmation_text_sha256: confirmation.sha256,
    audit: { undo_log_id: undoLogId, batch_operation_id: batchOperationId },
  } satisfies UndoResponse)
}

// =====================================================================
//  注册入口
// =====================================================================

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function postRoute(port: number, handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return guard(async (req, res) => {
    if (!sameOrigin(req, port)) {
      throw problem(403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）')
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const key of ACTOR_OVERRIDE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 不接受 query 覆盖', { rejected: [`query.${key}`] })
      }
    }
    for (const key of ACTOR_OVERRIDE_HEADERS) {
      if (req.headers[key] !== undefined) {
        throw problem(400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED', 'actor/tenant 不接受 header 覆盖', { rejected: [`header.${key}`] })
      }
    }
    if (req.method !== 'POST') { methodNotAllowed(res, 'POST'); return }
    await handle(req, res)
  })
}

/** 注册两条新写路由；非回环不注册（fail-closed），返回 disposer。 */
export function registerBatchUndoHttp(ctx: BatchUndoHostContext, deps: BatchUndoHttpDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 批量不通过/撤销路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const routes = [
    [BATCH_REJECT_PATH, postRoute(port, (req, res) => handleBatchReject(deps, req, res))],
    [UNDO_PATH, postRoute(port, (req, res) => handleUndo(deps, req, res))],
  ] as const
  const disposers = routes.map(([path, handler]) => webServer.register({ kind: 'exact', path, handler }))
  return () => {
    for (const dispose of disposers) { try { dispose() } catch { /* 卸载尽力而为 */ } }
  }
}
