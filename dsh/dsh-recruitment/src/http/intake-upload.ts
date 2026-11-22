// 上传简历 → 立即返回 task_id → 后台异步解析入库（docs/29 ASYNC-1 / ASYNC-2；docs/35 G1）。
//
// 接口形态（冻结口径）：
//   POST /recruitment/api/intake/upload?job_id=<uuid>
//   body = 原始二进制（不是 JSON、不是 multipart）
//   headers: content-type / x-file-name(URL 编码) / x-dsh-session / x-recruitment-request: 1
//   202 { task_id, status: 'RUNNING', ...diagnostics }   ← 不等解析
//
// 闸门（V3 人的闸门，fail-closed 零写入）：
//   只回环 + 同源(x-recruitment-request:1) + x-dsh-session → 已绑定 HUMAN actor；
//   未绑定 / 越权 / 非回环 → 403/409/400，且在碰任何 DB/文件之前拒绝。
//
// 落盘：src/db/intake-upload.ts（子代理 A）负责 allowed_roots[0]/.intake/<id>/ + sha256 复算；
//   本文件不自己写文件、不自己拼路径、不碰 os.tmpdir()。
//
// 解析：复用现有 RESUME_PARSE 任务路径 + application-intake 的既有导出函数（只读引用，不修改该文件）。
//   上传同步创建业务任务（由 tick loop 可认领），后台用同一 actor 身份调用既有
//   `resolveIntakeSource → runConverter → buildMaterial → intakeInTransaction` 完成入库；
//   成功/失败都把任务推进到终态（FAILED 必带 error_code + 人话原因），绝不假报成功。
//
// G-01（Issue #24）：解析入库成功后，若该申请将用的 Rubric 此刻已批准，后台**串行**跑一次
// `recruitment_screening_evaluate` 的只读评估。评估与人工初筛工具走同一条只读路径
// （`withReadOnly` + `evaluateInTransaction`）：零 decision 写入、不钉 rubric、不破人类闸门。
// 没有已批准 Rubric 或评估本身失败 → 只记日志，绝不回滚已成功的入库、上传任务仍 SUCCEEDED。
//
// 不新增工具、不新增迁移、不加依赖、不改 db/verify.sql。
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ResolvedDatabaseConfig } from '../db/pool.ts'
import { withActor, withReadOnly, createPool, closePool } from '../db/pool.ts'
import { isRubricVersionApproved } from '../db/approval.ts'
import { createScreeningEvaluateTool } from '../tools/screening-evaluate.ts'
import {
  DEMO_SESSION_HEADER,
  normalizeSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
} from '../demo-actor/index.ts'
import { sameOrigin } from './overview.ts'
import {
  buildMaterial,
  intakeInTransaction,
  resolveIntakeSource,
} from '../tools/application-intake.ts'
import { runConverter, type ResolvedConverterConfig } from '../tools/converter.ts'
import {
  createIntakeUploadTask,
  INTAKE_UPLOAD_CONTENT_TYPES,
  MAX_UPLOAD_BYTES,
  type IntakeUploadResult,
} from '../db/intake-upload.ts'

// =====================================================================
//  契约常量 / 公共导出（测试直接引用，冻结签名）
// =====================================================================

/** 上传端点（exact path）。 */
export const UPLOAD_PATH = '/recruitment/api/intake/upload'
/** 文件体上限（20 MiB）：与子代理 A 的 DB 层同一常量。 */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES
/** 允许的 content-type（全小写，忽略 `; charset=…` 参数）。 */
export const UPLOAD_CONTENT_TYPES: readonly string[] = INTAKE_UPLOAD_CONTENT_TYPES
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 状态 → HTTP 映射（封闭集；未列出的码绝不猜 200）。 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  FORBIDDEN: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  NOT_CONFIGURED: 503,
  UNSUPPORTED_MEDIA_TYPE: 415,
  FILE_TOO_LARGE: 413,
  INVALID_FILE_NAME: 400,
  WRITE_IDENTITY_REQUIRED: 403,
  DB_ERROR: 500,
  SHA256_MISMATCH: 500,
  OUTSIDE_ALLOWED_ROOTS: 400,
  NOT_FOUND: 404,
}

// =====================================================================
//  宿主面 / 依赖
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

/** 宿主上下文（src/index.ts 把 cordis Context 窄成这个形状）。 */
export interface IntakeUploadHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void; info?(message: string): void }
}

/** 路由依赖。 */
export interface IntakeUploadDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly databaseIssues: readonly string[]
  /**
   * 已解析的 converter 配置（含 allowed_roots / python_bin / converter_dir / timeout_ms）。
   * `null` = 未配置（路由仍注册，调用返回 503，不假装成功）。
   */
  readonly converter: ResolvedConverterConfig | null
  /** 与工具共享的 Demo Actor 身份单例（session → HUMAN actor）。 */
  readonly identity: DemoActorIdentity
  /** 目标岗位 UUID 的默认值（若 query 没给 job_id）；缺省 = 不提供，必须 query 给。 */
  readonly defaultJobId?: string
  /** 后台解析失败时的诊断日志（由注册器从 ctx 注入；不写进任何入库文件）。 */
  readonly logger?: { warn(message: string): void }
  /**
   * G-01 自动初筛的可注入面（测试用）：缺省 = 真库探针 + 既有只读评估工具。
   * 注入后不碰真库、不跑工具，便于断言"有已批准才评估 / 失败不影响入库"。
   */
  readonly autoScreeningHooks?: AutoScreeningHooks
}

// =====================================================================
//  纯校验辅助（供单测直接调用；不碰 DB、不碰文件）
// =====================================================================

/** 本文件自己产生的 HTTP 问题（带封闭错误信封）。 */
export class UploadHttpProblem extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, code: string, message: string, reasonCode?: string) {
    super(message)
    this.name = 'UploadHttpProblem'
    this.status = status
    this.body = {
      error: {
        code,
        reason_code: reasonCode ?? code,
        message,
      },
    }
  }
}

/** 归一 content-type：小写、去 `; charset=` 等参数；空值返回 ''。 */
export function normalizeContentType(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().split(';')[0]?.trim() ?? ''
}

/**
 * 校验回环 + 同源 + session + HUMAN actor 绑定（顺序即纪律，全部在碰 DB/文件之前）。
 * @returns 已解析的 actor id（写库身份只从这里来）。
 */
export function validateUploadHeaders(
  req: Pick<IncomingMessage, 'headers'>,
  port: number,
  identity: DemoActorIdentity,
): { actorId: string; sessionId: string } {
  if (!sameOrigin(req, port)) {
    throw new UploadHttpProblem(403, 'FORBIDDEN', '只接受同源 loopback 请求（Host=127.0.0.1|localhost:<port>，x-recruitment-request: 1）', 'SAME_ORIGIN_REQUIRED')
  }
  const rawSession = req.headers[DEMO_SESSION_HEADER]
  const sessionText = Array.isArray(rawSession) ? rawSession[0] : rawSession
  const sessionId = normalizeSessionId(sessionText)
  if (sessionId === null) {
    throw new UploadHttpProblem(
      400,
      'INVALID_ARGS',
      rawSession === undefined ? '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）' : 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID',
      rawSession === undefined ? 'SESSION_REQUIRED' : 'SESSION_ID_INVALID',
    )
  }
  let resolved
  try {
    resolved = resolveSessionActor(identity, sessionId)
  } catch {
    throw new UploadHttpProblem(409, 'DEMO_ACTOR_UNMAPPED', '当前 session 未绑定受控 alias（fail-closed，零写入）', 'DEMO_ACTOR_UNMAPPED')
  }
  return { actorId: resolved.actor_id, sessionId: resolved.session_id }
}

/**
 * 清洗 x-file-name：拒绝路径穿越 / 控制字符；返回安全的 basename。
 *
 * 规则（与子代理 A 的 DB 层一致，fail-closed 不静默strip）：
 *   * 先 decodeURIComponent（畸形的 % 序列 → INVALID_FILE_NAME）；
 *   * 任何 `/`、`\`、`..`、NUL、控制字符、超长（>200）→ 整头拒绝；
 *   * 通过后才只保留 `[A-Za-z0-9._ -]`，其余字符替换为 `_`，长度上限 80。
 */
export function sanitizeUploadFileName(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '缺 x-file-name 请求头或文件名为空', 'INVALID_FILE_NAME')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', 'x-file-name 不是合法的 URL 编码', 'INVALID_FILE_NAME')
  }
  if (decoded.trim().length === 0 || decoded.length > 200) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '文件名必须在 1–200 字符之间且不能全为空白', 'INVALID_FILE_NAME')
  }
  // 二次 URL 编码（%252E → %2E → .）用一轮 decode 后仍可能留下 %2e2f 之类的穿越意图；
  // 只要再 decode 一轮能冒出路径分隔符/..，就按穿越意图拒绝（fail-closed）。
  let twice = decoded
  try {
    twice = decodeURIComponent(decoded)
  } catch {
    // 解不动就当普通字面量，下面仍按字面字符判（不会更宽松）。
  }
  const traversal = [decoded, twice]
  if (traversal.some((value) => value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0'))) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '文件名不许包含路径分隔符或 ..（零写入）', 'INVALID_FILE_NAME')
  }
  // eslint-disable-next-line no-control-regex
  if (traversal.some((value) => /[\x00-\x1f\x7f]/.test(value))) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '文件名不许包含控制字符（零写入）', 'INVALID_FILE_NAME')
  }
  const safe = decoded.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 80)
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '清洗后的文件名为空（零写入）', 'INVALID_FILE_NAME')
  }
  return safe
}

/** 校验 content-type 白名单（归一后）。 */
export function validateContentType(value: string | undefined): string {
  const normalized = normalizeContentType(value)
  if (!(UPLOAD_CONTENT_TYPES as readonly string[]).includes(normalized)) {
    throw new UploadHttpProblem(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      '不支持的文件类型；只接受 PDF / DOCX / PNG / JPEG（零写入）',
      'UNSUPPORTED_MEDIA_TYPE',
    )
  }
  return normalized
}

/** 从 query 校验 job_id（UUID 形状；不合法 400，零写入）。 */
export function validateJobId(url: URL, defaultJobId: string | undefined): string {
  const value = url.searchParams.get('job_id') ?? defaultJobId
  if (value === undefined || value === '') {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '缺必填查询参数 job_id', 'MISSING_REQUIRED')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', 'job_id 必须是 UUID 文本', 'ID_NOT_UUID')
  }
  return value
}

/** 客户端不许覆盖的身份头/查询键（命中即 400，且不碰 DB）。 */
function rejectOverrides(req: Pick<IncomingMessage, 'headers'>, url: URL): void {
  const found: string[] = []
  for (const key of ['actor_id', 'tenant_id', 'job_id_actor'] as const) {
    if (url.searchParams.has(key)) found.push(`query.${key}`)
  }
  for (const key of ['x-recruitment-actor', 'x-recruitment-tenant'] as const) {
    if (req.headers[key] !== undefined) found.push(`header.${key}`)
  }
  if (found.length > 0) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', 'actor/tenant 只能来自服务端绑定，不接受客户端传入', 'ACTOR_OVERRIDE_REJECTED')
  }
}

// =====================================================================
//  HTTP 读体 / 响应工具
// =====================================================================

/** 读原始二进制体（上限 20 MiB，超限立即 413 且不继续读）。 */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string' && Number.isFinite(Number(declared)) && Number(declared) > MAX_UPLOAD_BODY_BYTES) {
    throw new UploadHttpProblem(413, 'INVALID_ARGS', `文件不得超过 ${MAX_UPLOAD_BODY_BYTES} 字节`, 'FILE_TOO_LARGE')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_UPLOAD_BODY_BYTES) {
      throw new UploadHttpProblem(413, 'INVALID_ARGS', `文件不得超过 ${MAX_UPLOAD_BODY_BYTES} 字节`, 'FILE_TOO_LARGE')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0 || total === 0) {
    throw new UploadHttpProblem(400, 'INVALID_ARGS', '请求体为空（零写入）', 'EMPTY_BODY')
  }
  return Buffer.concat(chunks, total)
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 把子代理 A 的失败码映射为 HTTP 问题。 */
function problemOfFailure(failure: Extract<IntakeUploadResult, { ok: false }>): UploadHttpProblem {
  const status = STATUS_BY_CODE[failure.code] ?? 500
  return new UploadHttpProblem(status, failure.code, failure.reason, failure.code)
}

// =====================================================================
//  G-01：入库成功后的自动初筛评估（只读、串行、零 decision 写入）
// =====================================================================

/** Rubric 探针结论：`NONE` 必须带人话原因（日志要能说明为什么不评估）。 */
export type AutoScreeningRubricProbe =
  | { readonly kind: 'APPROVED'; readonly rubricVersionId: string }
  | { readonly kind: 'NONE'; readonly reason: string }

/**
 * 落进 `business_task.result_ref` 的**只读建议**摘要（非决定）。
 *
 * 设计纪律（Issue #24 / G-01 补完）：
 *   * 这是**评估工具输出的结构化投影**，不是决定——`verdict` 是工具的只读结论，
 *     UI 必须同时展示 `advisory_note`（"这是建议，不是决定"）；
 *   * 三态字段（`present`/`absent`/`unreadable`）逐条随 reason 保留，供读模型还原结论；
 *   * 绝不写 `decision`、不钉 rubric、不新增表/列/迁移；只改既有 `business_task.result_ref`（text）
 *     与 `business_refs`（jsonb）；
 *   * `material_sha256` 必须保留——`result_ref` 原文 hash 不能丢（上传落盘证据）。
 */
export interface AutoScreeningSummary {
  readonly verdict: string
  readonly verdict_summary: string
  readonly required_human_action: string
  readonly rubric_version_id: string
  readonly evaluation_digest: string
  readonly reasons: readonly {
    readonly code: string
    readonly criterion_key: string
    readonly tri_state: string
    readonly outcome: string
    readonly message: string
  }[]
  readonly advisory: true
  readonly advisory_note: string
}

/** `business_task.result_ref` 里存的结构（JSON 文本）：material hash + 可选自动初筛建议。 */
export interface AutoScreeningResultRef {
  readonly material_sha256: string
  readonly auto_screening?: AutoScreeningSummary
}

/**
 * `business_task.description` 里追加的自动初筛摘要标记。
 *
 * 为什么还要写 description：上传任务同时可能被 runtime worker 认领；worker 的
 * `finishAttempt` 会用 `result_ref = taskResultRef` 覆盖 result_ref（失败时为 null）。
 * description 不被 worker 收尾更新，因此把同一 JSON 追加到这里作为**可读兜底**，
 * 保证“入库成功但任务状态被 worker 竞争改写”时，HR 仍能看到自动初筛建议。
 */
export const AUTO_SCREENING_DESCRIPTION_MARKER = '\n[auto-screening] '


/** 一次自动初筛的结果（可观测；不写任何业务表）。 */
export type AutoScreeningOutcome =
  | {
      readonly kind: 'EVALUATED'
      readonly applicationId: string
      readonly rubricVersionId: string
      readonly summary: AutoScreeningSummary | null
    }
  | { readonly kind: 'SKIPPED_NO_APPROVED_RUBRIC'; readonly applicationId: string; readonly reason: string }
  | { readonly kind: 'SKIPPED_DUPLICATE'; readonly applicationId: string; readonly reason: string }
  | { readonly kind: 'FAILED'; readonly applicationId: string; readonly reason: string }

/** 建议口径常量：前端/读模型与此处共用同一句，避免各处措辞漂移。 */
export const AUTO_SCREENING_ADVISORY_NOTE = '这是只读评估给出的建议，不是录用决定；请由招聘团队成员确认。'

/**
 * 把评估工具的规范输出投影成紧凑的**建议摘要**（纯函数，不连库）。
 *
 * 只取读模型/UI 真正需要的字段；任何字段缺失都回退为空串，**不猜**：
 * `verdict` 用工具原值（PASS / FAIL / NEEDS_REVIEW），三态随每条 reason 原样保留。
 * 输出的 `advisory: true` + `advisory_note` 保证"建议不是决定"在系统里是可观测事实。
 */
export function buildAutoScreeningSummary(value: unknown): AutoScreeningSummary {
  const obj = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const reasons: Array<AutoScreeningSummary['reasons'][number]> = []
  const rawReasons = Array.isArray(obj.reasons) ? obj.reasons : []
  for (const item of rawReasons) {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    reasons.push({
      code: typeof r.code === 'string' ? r.code : '',
      criterion_key: typeof r.criterion_key === 'string' ? r.criterion_key : '',
      tri_state: typeof r.tri_state === 'string' ? r.tri_state : '',
      outcome: typeof r.outcome === 'string' ? r.outcome : '',
      message: typeof r.message === 'string' ? r.message : '',
    })
  }
  const rubric = (typeof obj.rubric === 'object' && obj.rubric !== null ? obj.rubric : {}) as Record<string, unknown>
  const snapshot = (typeof obj.snapshot === 'object' && obj.snapshot !== null ? obj.snapshot : {}) as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return {
    verdict: text(obj.verdict),
    verdict_summary: text(obj.verdict_summary),
    required_human_action: text(obj.required_human_action),
    rubric_version_id: text(rubric.version_id) || text(snapshot.rubric_version_id),
    evaluation_digest: text(obj.evaluation_digest),
    reasons,
    advisory: true,
    advisory_note: AUTO_SCREENING_ADVISORY_NOTE,
  }
}

/**
 * 自动初筛的注入面：把"查已批准 Rubric"与"跑评估"两个动作拆开，测试可直接 spy。
 * 生产缺省实现见 `defaultAutoScreeningHooks()`（真库只读探针 + 既有只读工具）。
 */
export interface AutoScreeningHooks {
  readonly probeApprovedRubric: (input: { readonly applicationId: string }) => Promise<AutoScreeningRubricProbe>
  readonly evaluate: (input: {
    readonly applicationId: string
    readonly rubricVersionId: string
  }) => Promise<unknown>
}

/** 进程内串行闸门：同一时刻最多一个自动初筛在跑（不引入队列/新依赖）。 */
let autoScreeningTail: Promise<void> = Promise.resolve()
/** 同一申请的重复/并发触发防护（先到先跑，后到只记日志跳过）。 */
const autoScreeningInFlight = new Set<string>()

/**
 * 缺省探针：按评估工具自己的解析口径找"将用的 Rubric"——
 * 申请钉住的版本优先，否则岗位当前版本（`job.current_rubric_version_id`，D-21/D-48 不按 max 推导）。
 * 批准判定复用 `isRubricVersionApproved`（唯一口径），只读事务内完成。
 */
function defaultAutoScreeningHooks(cfg: ResolvedDatabaseConfig): AutoScreeningHooks {
  return {
    async probeApprovedRubric({ applicationId }) {
      const pool = createPool(cfg)
      try {
        return await withReadOnly(pool, async (client) => {
          const { rows } = await client.query<{
            readonly rubric_version_id: string | null
            readonly current_rubric_version_id: string | null
          }>(
            `select a.rubric_version_id::text as rubric_version_id,
                    j.current_rubric_version_id::text as current_rubric_version_id
               from recruitment.application a
               join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
              where a.id = $1::uuid and a.tenant_id = $2::uuid`,
            [applicationId, cfg.tenant_id],
          )
          const row = rows[0]
          if (row === undefined) {
            return { kind: 'NONE', reason: `申请不存在 application=${applicationId}` }
          }
          const candidate = row.rubric_version_id ?? row.current_rubric_version_id
          if (candidate === null) {
            return { kind: 'NONE', reason: '岗位没有当前 Rubric 版本且申请未钉住 Rubric' }
          }
          const approved = await isRubricVersionApproved(client, cfg.tenant_id, candidate)
          if (!approved) {
            return { kind: 'NONE', reason: `Rubric 版本此刻未批准 rubric_version_id=${candidate}` }
          }
          return { kind: 'APPROVED', rubricVersionId: candidate }
        })
      } finally {
        await closePool(pool)
      }
    },
    async evaluate({ applicationId }) {
      // 复用既有只读工具，与手动触发完全同一路径：零 decision 写入、只读事务、7 条阻断检查。
      // **不传 rubric_version_id**：避免把评估变成 what_if（what_if 不可用于决策）。
      // `exec` 参数由宿主传入；评估工具不消费它（只读），给空对象即可。
      // 必须 return 工具结果：自动初筛要把结构化 verdict/reasons 持久化给读模型，而不是丢弃。
      return await createScreeningEvaluateTool(cfg).execute({ application_id: applicationId }, {})
    },
  }
}

/**
 * 把自动初筛的只读建议持久化到**既有** `business_task` 行（非 decision、无新 schema）。
 *
 * 两件事在同一个 UPDATE 里完成：
 *   1. `result_ref` = JSON 文本 `{ material_sha256, auto_screening }`——保留原文 hash，
 *      并把评估摘要写进可读字段（此前这里只有裸 sha256，评估输出被丢弃）；
 *   2. `business_refs` 追加 `{ kind:'APPLICATION', id:applicationId }`——只用于读模型按申请定位，
 *      不动任务状态/身份/乐观锁以外的任何业务事实。
 *
 * 幂等：重复调用不会重复追加 APPLICATION ref（先按 kind+id 过滤）。
 * 失败只记日志：评估已成功，绝不能因为"写摘要失败"把上传任务翻成 FAILED。
 */
async function persistAutoScreeningSummary(
  cfg: ResolvedDatabaseConfig,
  actorId: string,
  taskId: string,
  applicationId: string,
  materialSha256: string,
  summary: AutoScreeningSummary,
  logger: IntakeUploadDeps['logger'],
): Promise<void> {
  const resultRef: AutoScreeningResultRef = { material_sha256: materialSha256, auto_screening: summary }
  const json = JSON.stringify(resultRef)
  const pool = createPool(cfg)
  try {
    await withActor(pool, actorId, async (client) => {
      const current = await client.query<{ business_refs: unknown; result_ref: string | null; description: string | null }>(
        `select business_refs, result_ref, description
           from recruitment.business_task
          where tenant_id = $1::uuid and id = $2::uuid`,
        [cfg.tenant_id, taskId],
      )
      const row = current.rows[0]
      if (row === undefined) {
        logger?.warn(`intake-upload: 自动初筛摘要未写入（任务不存在）task=${taskId}`)
        return
      }
      // 保留既有 refs；去掉同 kind+id 的旧项后追加，避免重复。
      const refs = Array.isArray(row.business_refs)
        ? row.business_refs.filter((ref) => {
            const r = ref as Record<string, unknown>
            return !(r?.kind === 'APPLICATION' && r?.id === applicationId)
          })
        : []
      refs.push({ kind: 'APPLICATION', id: applicationId })
      // description 兜底：去掉旧标记后追加同一 JSON（worker 的 finishAttempt 不碰 description）。
      const baseDescription = (row.description ?? '').split(AUTO_SCREENING_DESCRIPTION_MARKER)[0].trimEnd()
      const description = `${baseDescription}${AUTO_SCREENING_DESCRIPTION_MARKER}${json}`
      await client.query(
        `update recruitment.business_task
            set result_ref = $3,
                description = $5,
                business_refs = $4::jsonb,
                record_version = record_version + 1
          where tenant_id = $1::uuid and id = $2::uuid`,
        [cfg.tenant_id, taskId, json, JSON.stringify(refs), description],
      )
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn(`intake-upload: 自动初筛摘要写入失败（不影响入库）task=${taskId}: ${message.slice(0, 300)}`)
  } finally {
    await closePool(pool)
  }
}

async function executeAutoScreening(
  applicationId: string,
  hooks: AutoScreeningHooks,
  logger: IntakeUploadDeps['logger'],
  persist?: {
    readonly cfg: ResolvedDatabaseConfig
    readonly actorId: string
    readonly taskId: string
    readonly materialSha256: string
  },
): Promise<AutoScreeningOutcome> {
  try {
    const probe = await hooks.probeApprovedRubric({ applicationId })
    if (probe.kind !== 'APPROVED') {
      const reason = `自动初筛未触发：${probe.reason}（application=${applicationId}）`
      logger?.warn(`intake-upload: ${reason}`)
      return { kind: 'SKIPPED_NO_APPROVED_RUBRIC', applicationId, reason }
    }
    const evaluateOutput: unknown = await hooks.evaluate({ applicationId, rubricVersionId: probe.rubricVersionId })
    const summary = buildAutoScreeningSummary(evaluateOutput)
    if (persist !== undefined) {
      await persistAutoScreeningSummary(
        persist.cfg, persist.actorId, persist.taskId, applicationId,
        persist.materialSha256, summary, logger,
      )
    }
    return { kind: 'EVALUATED', applicationId, rubricVersionId: probe.rubricVersionId, summary }
  } catch (error) {
    // 失败只记日志：绝不向上抛、绝不回滚已成功的入库。
    const message = error instanceof Error ? error.message : String(error)
    logger?.warn(`intake-upload: 自动初筛评估失败（不影响入库）application=${applicationId}: ${message.slice(0, 300)}`)
    return { kind: 'FAILED', applicationId, reason: message }
  }
}

/**
 * 入库成功后调用一次：串行排队 + 同申请去重 + 全程失败隔离（**永不抛错**）。
 * 返回值只用于观测/单测；生产调用方忽略它，上传任务状态不受影响。
 */
export async function runAutoScreeningAfterIntake(
  cfg: ResolvedDatabaseConfig,
  applicationId: string,
  hooks: AutoScreeningHooks | undefined,
  logger: IntakeUploadDeps['logger'],
  persist?: {
    readonly actorId: string
    readonly taskId: string
    readonly materialSha256: string
  },
): Promise<AutoScreeningOutcome> {
  if (autoScreeningInFlight.has(applicationId)) {
    const reason = `同一申请已有自动初筛在跑 application=${applicationId}`
    logger?.warn(`intake-upload: 自动初筛跳过（重复触发）：${reason}`)
    return { kind: 'SKIPPED_DUPLICATE', applicationId, reason }
  }
  autoScreeningInFlight.add(applicationId)
  const persistInput = persist === undefined ? undefined : { cfg, ...persist }
  const task = autoScreeningTail.then(() =>
    executeAutoScreening(applicationId, hooks ?? defaultAutoScreeningHooks(cfg), logger, persistInput))
  // 链尾归一为 resolved：上一轮的失败不会阻塞下一轮。
  autoScreeningTail = task.then(() => {}, () => {})
  try {
    return await task
  } finally {
    autoScreeningInFlight.delete(applicationId)
  }
}

// =====================================================================
//  后台解析（不阻塞响应；复用既有 RESUME_PARSE 解析链）
// =====================================================================

/** 后台解析入参（任务 id 与落盘证据都来自同步阶段）。 */
interface BackgroundParseInput {
  readonly taskId: string
  readonly eventId: string
  readonly materialPath: string
  readonly fileName: string
  readonly sha256: string
  readonly actorId: string
  readonly jobId: string
}

/**
 * 把任务推到终态（成功/失败都留人话原因）。**只改业务任务行**，不动任何业务表。
 * FAILED 必须写 error_code（0001 的 ck_business_task_failed 约束）。
 */
async function finalizeTask(
  cfg: ResolvedDatabaseConfig,
  actorId: string,
  taskId: string,
  outcome: 'SUCCEEDED' | 'FAILED',
  errorCode: string | null,
  summary: string,
  resultRef: string | null,
): Promise<void> {
  const pool = createPool(cfg)
  try {
    await withActor(pool, actorId, async (client) => {
      await client.query(
        `update recruitment.business_task
            set status = $3,
                error_code = $4,
                error_summary = $5,
                result_ref = $6,
                completed_at = case when $3 in ('SUCCEEDED','FAILED') then now() else null end,
                status_changed_at = now(),
                status_changed_by_actor_id = $2::uuid,
                record_version = record_version + 1
          where tenant_id = $1::uuid and id = $7::uuid`,
        [cfg.tenant_id, actorId, outcome, errorCode, summary, resultRef, taskId],
      )
    })
  } finally {
    await closePool(pool)
  }
}

/**
 * 真解析：复用 application-intake 的既有导出（不修改它），写 candidate/application/resume_version。
 * 成功后业务任务 SUCCEEDED；任何失败 → FAILED + error_code + 人话原因，**绝不**假报已入库。
 */
async function runBackgroundParse(
  deps: IntakeUploadDeps,
  input: BackgroundParseInput,
): Promise<void> {
  if (deps.database === null || deps.converter === null) return
  const cfg: ResolvedDatabaseConfig = deps.database
  try {
    const source = await resolveIntakeSource(input.materialPath, deps.converter)
    const output = await runConverter(deps.converter, source.real_path)
    const material = buildMaterial(source.real_path, output, source.media_type)
    const pool = createPool(cfg)
    let value
    try {
      value = await withActor(pool, input.actorId, (client) =>
        intakeInTransaction(client, { ...cfg, actor_id: input.actorId }, material, input.jobId))
    } finally {
      await closePool(pool)
    }
    // G-01：入库已成功。自动初筛必须独立于任务终态写入：上传任务可能同时被 runtime
    // worker 认领并竞争改写 status/result_ref；这里把自动初筛放进 finally，确保即使
    // finalizeTask 失败（或被 worker 抢先）也执行一次。persist 另把摘要写进 description，
    // 不会因 worker 的 result_ref 覆盖而丢失。
    try {
      await finalizeTask(
        cfg, input.actorId, input.taskId, 'SUCCEEDED', null,
        `解析完成：申请 ${value.application_id}，简历版本 ${value.resume_version_id}`,
        input.sha256,
      )
    } finally {
      await runAutoScreeningAfterIntake(
        cfg, value.application_id, deps.autoScreeningHooks, deps.logger,
        { actorId: input.actorId, taskId: input.taskId, materialSha256: input.sha256 },
      ).catch((error: unknown) => {
        deps.logger?.warn(`intake-upload: 自动初筛调度异常（不影响入库）${input.taskId}: ${String(error).slice(0, 200)}`)
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finalizeTask(
      cfg, input.actorId, input.taskId, 'FAILED', 'PARSE_FAILED',
      `简历解析失败（未入库）：${message.slice(0, 300)}`,
      null,
    ).catch((finalError: unknown) => {
      deps.logger?.warn(`intake-upload: 任务终态写入失败 ${input.taskId}: ${String(finalError).slice(0, 200)}`)
    })
  }
}

/** 后台任务调度：用 setImmediate 让 202 先发出去；进程内无队列、无新依赖。 */
function startBackgroundParse(deps: IntakeUploadDeps, input: BackgroundParseInput): void {
  setImmediate(() => {
    void runBackgroundParse(deps, input).catch((error: unknown) => {
      deps.logger?.warn(`intake-upload: 后台解析异常 ${input.taskId}: ${String(error).slice(0, 200)}`)
    })
  })
}

// =====================================================================
//  Handler + 注册器
// =====================================================================

/**
 * 处理一次上传：闸门 → 校验 → 落盘+建任务（同步）→ 202 → 后台解析。
 */
async function handleUpload(
  deps: IntakeUploadDeps,
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  rejectOverrides(req, url)
  const { actorId } = validateUploadHeaders(req, port, deps.identity)
  const contentType = validateContentType(req.headers['content-type'])
  const fileName = sanitizeUploadFileName(
    (() => {
      const raw = req.headers['x-file-name']
      return Array.isArray(raw) ? raw[0] : raw
    })(),
  )
  const jobId = validateJobId(url, deps.defaultJobId)
  if (deps.database === null) {
    throw new UploadHttpProblem(503, 'NOT_CONFIGURED', '数据库未配置，上传不可用（零写入）', 'NOT_CONFIGURED')
  }
  if (deps.converter === null || deps.converter.allowed_roots.length === 0) {
    throw new UploadHttpProblem(503, 'NOT_CONFIGURED', '未配置 allowed_roots，拒绝落盘（零写入，不用临时目录）', 'NOT_CONFIGURED')
  }
  const bytes = await readRawBody(req)

  const landed: IntakeUploadResult = await createIntakeUploadTask(
    { database: deps.database, converter: { allowed_roots: deps.converter.allowed_roots } },
    { bytes, contentType, fileName, tenantId: deps.database.tenant_id, actorId, jobId },
  )
  if (!landed.ok) throw problemOfFailure(landed)

  // 同步阶段结束：任务已存在且可被现有 tick loop 认领；先回 202，再让后台跑解析。
  json(res, 202, {
    task_id: landed.task_id,
    status: 'RUNNING',
    event_id: landed.event_id,
    file_name: landed.file_name,
    byte_size: landed.byte_size,
    sha256: landed.sha256,
  })

  startBackgroundParse(deps, {
    taskId: landed.task_id,
    eventId: landed.event_id,
    materialPath: landed.material_path,
    fileName: landed.file_name,
    sha256: landed.sha256,
    actorId,
    jobId,
  })
}

/**
 * 注册上传路由；返回 disposer（供 `child.effect` 使用）。
 * 非回环 host 不注册（fail-closed，返回空 disposer）。
 */
export function registerIntakeUploadHttp(
  ctx: IntakeUploadHostContext,
  deps: IntakeUploadDeps,
): () => void {
  const host = ctx.webServer.host
  const port = ctx.webServer.port ?? (host.startsWith('127.0.0.1') || host.startsWith('localhost') ? 49347 : 0)
  if (host !== '127.0.0.1' && host !== '::1' && !host.startsWith('localhost')) {
    ctx.logger?.warn(`intake-upload: 非回环 host=${host}，不注册上传路由（fail-closed）`)
    return () => { /* 没注册任何东西 */ }
  }
  // 注入 logger（只用于后台诊断，不写业务表、不写入库文件）。
  const depsWithLogger: IntakeUploadDeps = { ...deps, ...(deps.logger === undefined && ctx.logger !== undefined ? { logger: ctx.logger } : {}) }
  return ctx.webServer.register({
    kind: 'exact',
    path: UPLOAD_PATH,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          if (!res.headersSent) res.writeHead(405, { allow: 'POST', ...NO_STORE })
          res.end()
          return
        }
        await handleUpload(depsWithLogger, req, res, port)
      } catch (error) {
        if (error instanceof UploadHttpProblem) {
          json(res, error.status, error.body)
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn(`intake-upload: 未预期错误 ${message.slice(0, 200)}`)
        json(res, 500, { error: { code: 'INTERNAL', reason_code: 'UNEXPECTED', message: '上传失败（零写入）' } })
      }
    },
  })
}
