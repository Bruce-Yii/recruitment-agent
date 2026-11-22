// G-12（Issue #35）人才再发现：**只读** HTTP 投影。
//
// 端点：GET /recruitment/api/recruiting/jobs/:jobId/rediscovery
//
// 纪律（与 W2 `http/recruiting.ts` 同一口径）：
//   1. 所有查询跑在调用方给的 `DatabaseClient` 上；生产路径由 `withReadOnly`
//      （`begin transaction read only`）包住，任何写语句直接 25006；
//   2. 严格 loopback + `sameOrigin`（Host=127.0.0.1/localhost:<port> +
//      `x-recruitment-request: 1` + Origin 缺省/同源）+ `X-DSH-Session`（只认形状，
//      身份仍由插件配置的 tenant_id 决定，客户端不得覆盖）；
//   3. 只按库里真实历史事实（历史岗位/初筛结论/面试轮次/已交面评/历史材料字段）
//      召回**未投递当前岗位**的候选人；输出去重、不编造；
//   4. 呈现顺序 = 命中历史条件数 + 最近活跃时间（完全可解释），**不产百分比分数、
//      不产黑盒排名**；HR 可见文案不出现内部术语，全部用「历史记录 / 可复核历史条目」表达；
//   5. PII 最小化：只带 display_name / 岗位标题编码 / 阶段码 / 时间，不带联系方式、
//      简历正文、storage_ref、完整 hash。
//
// 本文件同时被 DSH 只读工具 `tools/talent-rediscovery.ts` 复用：工具与 HTTP 共用
// `readTalentRediscovery()` 一个读模型，避免两份投影漂移。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  isUuidText,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { sameOrigin } from './overview.ts'
import { RECRUITING_ROUTE_PREFIX, readJobDetail, type RecruitingActionSeams } from './recruiting.ts'

/** 契约版本（响应首字段，调用方据此判形态）。 */
export const REDISCOVERY_CONTRACT_VERSION = 'talent-rediscovery 1.0.0'
/** 本模块的路由前缀；与 recruiting prefix 同族，但更长（最长前缀优先命中本处理器）。 */
export const REDISCOVERY_ROUTE_PREFIX = `${RECRUITING_ROUTE_PREFIX}/jobs/`
/** 路由尾缀。 */
export const REDISCOVERY_PATH_SUFFIX = '/rediscovery'
/** 单次最多返回的候选人数（上限固定，不接受客户端覆盖）。 */
export const REDISCOVERY_LIMIT = 50
/** 每个候选人最多带出的可复核历史条目数。 */
export const REDISCOVERY_BASIS_LIMIT = 12

/** 只读投影的宿主上下文（与 recruiting 同一窄面）。 */
export interface TalentRediscoveryHostContext {
  readonly webServer: {
    readonly host: string
    readonly port?: number
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }): () => void
  }
  readonly logger?: { warn(message: string): void }
}

/** 稳定错误码（不引入新的工具错误类型）。 */
export type RediscoveryErrorCode = 'INVALID_ARGS' | 'NOT_FOUND' | 'NOT_CONFIGURED'

export class RediscoveryError extends Error {
  readonly code: RediscoveryErrorCode
  constructor(code: RediscoveryErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'RediscoveryError'
    this.code = code
  }
}

/** 当前岗位 rubric 的一条要求（只取人读字段，不取整份 dimensions）。 */
export interface RubricRequirement {
  readonly key: string
  readonly label: string
  readonly kind: string
  /** 机械条件对应的材料字段（判断型要求没有该字段）。 */
  readonly field?: string
}

/** 一条可复核历史条目：来源 + 人话描述 + 时间；没有时间的条目不编时间。 */
export interface RediscoveryBasis {
  readonly code: string
  readonly label: string
  readonly detail: string
  readonly source: 'APPLICATION' | 'DECISION' | 'INTERVIEW' | 'SCORECARD' | 'MATERIAL'
  readonly at: string | null
}

/** 一位被召回的历史候选人（每人只出现一次）。 */
export interface RediscoveryCandidate {
  readonly candidate_id: string
  readonly candidate_name: string
  /** 命中历史条件数（计数，不是评分；排序第一关键字）。 */
  readonly matched_condition_count: number
  /** 最近活跃时间（排序第二关键字；库里没有时间则为 null）。 */
  readonly last_active_at: string | null
  readonly basis: readonly RediscoveryBasis[]
}

/** `readTalentRediscovery()` 的入参。 */
export interface RediscoveryInput {
  readonly database: ResolvedDatabaseConfig
  readonly client: DatabaseClient
  readonly jobId: string
}

/** 冻结的响应契约。 */
export interface RediscoveryResponse {
  readonly tool: 'recruitment_talent_rediscovery'
  readonly contract_version: string
  readonly status: 'OK'
  readonly read_only: true
  readonly evaluated_at: string
  readonly labels: { readonly provenance: 'LIVE'; readonly trigger: 'MANUAL'; readonly connection: 'CONNECTED' }
  readonly job: {
    readonly job_id: string
    readonly code: string
    readonly title: string
    readonly status: string
    readonly rubric_requirements: readonly RubricRequirement[]
  }
  readonly candidates: readonly RediscoveryCandidate[]
  readonly total_matched: number
  readonly note: string
}

const NOTE = '按命中历史条件数与最近活跃时间呈现，仅供人工复核；这不是评分，也不是机器排名。未投递当前岗位的人才才会被召回；空结果表示当前库里没有符合条件的历史记录。'

// ---------------------------------------------------------------------------
//  只读 SQL 投影（纯函数式：只消费 client，不写任何表）
// ---------------------------------------------------------------------------

interface JobRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_rubric_version_id: string | null
}

interface AppRow {
  readonly id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly job_code: string
  readonly job_title: string
  readonly current_stage_code: string
  readonly applied_at: string | Date | null
  readonly status_changed_at: string | Date | null
  readonly updated_at: string | Date | null
}

interface DecisionRow {
  readonly id: string
  readonly application_id: string
  readonly decision_scope: string
  readonly result: string
  readonly stage_code: string | null
  readonly decided_at: string | Date
}

interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly round_no: number
  readonly status: string
  readonly status_changed_at: string | Date | null
}

interface ScorecardRow {
  readonly id: string
  readonly application_id: string
  readonly submitted_at: string | Date | null
}

interface ResumeRow {
  readonly candidate_id: string
  readonly id: string
  readonly created_at: string | Date | null
  readonly parsed_fields: Record<string, unknown> | null
}

interface CandidateRow {
  readonly id: string
  readonly display_name: string
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function maxIso(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current
  if (current === null) return candidate
  return candidate > current ? candidate : current
}

/** 从 `resume_version.parsed_fields` 里保守地读一个字段的 state（只认 present）。 */
function fieldPresent(parsed: Record<string, unknown> | null, field: string): boolean {
  if (parsed === null) return false
  // converter 的 parsed_fields 把字段放在顶层 `fields` 下；历史数据也可能直接放顶层，两种都认。
  const fields = typeof parsed.fields === 'object' && parsed.fields !== null && !Array.isArray(parsed.fields)
    ? parsed.fields as Record<string, unknown>
    : parsed
  const entry = fields[field]
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false
  const state = (entry as Record<string, unknown>).state
  return state === 'present'
}

function requirementLabel(dimension: Record<string, unknown>, index: number): string {
  const label = dimension.label
  if (typeof label === 'string' && label.trim().length > 0) return label.trim().slice(0, 200)
  return `要求 ${index + 1}`
}

/** 从当前 rubric 提取人读要求（机械条件带 field，判断型只带 label）。 */
export function extractRubricRequirements(dimensions: unknown): readonly RubricRequirement[] {
  if (!Array.isArray(dimensions)) return []
  const out: RubricRequirement[] = []
  for (const [index, raw] of dimensions.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const dimension = raw as Record<string, unknown>
    const key = typeof dimension.key === 'string' && dimension.key.trim().length > 0
      ? dimension.key.trim().slice(0, 60)
      : `criterion_${index + 1}`
    const kind = typeof dimension.kind === 'string' ? dimension.kind : 'MUST_HAVE'
    const field = typeof dimension.field === 'string' && dimension.field.trim().length > 0
      ? dimension.field.trim().slice(0, 60)
      : undefined
    out.push({ key, label: requirementLabel(dimension, index), kind, ...(field === undefined ? {} : { field }) })
    if (out.length >= 20) break
  }
  return out
}

/** 最近一条历史材料（按 created_at 降序，同时间按 id 稳定）。 */
function latestResumeByCandidate(rows: readonly ResumeRow[]): Map<string, ResumeRow> {
  const out = new Map<string, ResumeRow>()
  for (const row of rows) {
    const known = out.get(row.candidate_id)
    if (known === undefined) {
      out.set(row.candidate_id, row)
      continue
    }
    const a = toIso(row.created_at) ?? ''
    const b = toIso(known.created_at) ?? ''
    if (a > b || (a === b && row.id > known.id)) out.set(row.candidate_id, row)
  }
  return out
}

/**
 * 只读召回投影（**不建新事实表、不算分、不排名**）。
 * @param input - 已解析配置 + 只读事务里的 client + 严格校验过的 jobId。
 * @returns 冻结的响应契约；没有命中时 `candidates: []`。
 */
export async function readTalentRediscovery(input: RediscoveryInput): Promise<RediscoveryResponse> {
  const { database, client, jobId } = input
  if (!isUuidText(jobId)) throw new RediscoveryError('INVALID_ARGS', 'job_id 必须是合法 UUID')

  const tenantId = database.tenant_id
  const jobRows = await client.query<JobRow>(
    `select j.id, j.code, j.title, j.status, j.current_rubric_version_id
       from recruitment.job j
      where j.id = $1 and j.tenant_id = $2`,
    [jobId, tenantId],
  )
  const job = jobRows.rows[0]
  if (job === undefined) throw new RediscoveryError('NOT_FOUND', `岗位 ${jobId} 不存在`)

  let requirements: readonly RubricRequirement[] = []
  if (job.current_rubric_version_id !== null && isUuidText(job.current_rubric_version_id)) {
    const rubricRows = await client.query<{ dimensions: unknown }>(
      `select dimensions from recruitment.rubric_version
        where id = $1 and tenant_id = $2 and job_id = $3`,
      [job.current_rubric_version_id, tenantId, jobId],
    )
    const rubric = rubricRows.rows[0]
    if (rubric !== undefined) requirements = extractRubricRequirements(rubric.dimensions)
  }

  // 候选池：本租户 ACTIVE 候选人；排除已投递当前岗位（任意生命周期状态）的人。
  // 用 NOT EXISTS 而不是程序里过滤：即使并发插入也以同一只读快照为准。
  const candidateRows = await client.query<CandidateRow>(
    `select c.id, c.display_name
       from recruitment.candidate c
      where c.tenant_id = $1
        and c.identity_status = 'ACTIVE'
        and exists (select 1 from recruitment.application ha
                     where ha.tenant_id = c.tenant_id and ha.candidate_id = c.id)
        and not exists (select 1 from recruitment.application ta
                     where ta.tenant_id = c.tenant_id and ta.candidate_id = c.id and ta.job_id = $2)
      order by c.id`,
    [tenantId, jobId],
  )
  const nowIso = toIso((await client.query<{ now: Date }>('select now() as now')).rows[0]?.now)
    ?? new Date().toISOString()

  const empty: RediscoveryResponse = {
    tool: 'recruitment_talent_rediscovery',
    contract_version: REDISCOVERY_CONTRACT_VERSION,
    status: 'OK',
    read_only: true,
    evaluated_at: nowIso,
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    job: {
      job_id: job.id,
      code: job.code,
      title: job.title,
      status: job.status,
      rubric_requirements: requirements.map(({ key, label, kind }) => ({ key, label, kind })),
    },
    candidates: [],
    total_matched: 0,
    note: NOTE,
  }
  if (candidateRows.rows.length === 0) return empty

  // 只取候选池相关的历史行；全部 SELECT，无 write。
  // 顺序 await：pg 的同一个 client 上并行 query 会触发弃用告警（与仓库其它读模型同口径）。
  const appRows = await client.query<AppRow>(
    `select a.id, a.candidate_id, a.job_id, j.code as job_code, j.title as job_title,
            a.current_stage_code, a.applied_at, a.status_changed_at, a.updated_at
       from recruitment.application a
       join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.job_id <> $2`,
    [tenantId, jobId],
  )
  const decisionRows = await client.query<DecisionRow>(
    `select d.id, d.application_id, d.decision_scope, d.result, d.stage_code, d.decided_at
       from recruitment.decision d
      where d.tenant_id = $1 and d.superseded_by_decision_id is null`,
    [tenantId],
  )
  const interviewRows = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no, i.status, i.status_changed_at
       from recruitment.interview i
      where i.tenant_id = $1 and i.status not in ('CANCELLED', 'NO_SHOW')`,
    [tenantId],
  )
  const scorecardRows = await client.query<ScorecardRow>(
    `select s.id, i.application_id, s.submitted_at
       from recruitment.scorecard s
       join recruitment.interview i on i.id = s.interview_id and i.tenant_id = s.tenant_id
      where s.tenant_id = $1 and s.status = 'SUBMITTED' and s.superseded_by_scorecard_id is null`,
    [tenantId],
  )
  const resumeRows = await client.query<ResumeRow>(
    `select r.candidate_id, rv.id, rv.created_at, rv.parsed_fields
       from recruitment.resume_version rv
       join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
      where rv.tenant_id = $1 and rv.parse_status in ('PARSED', 'PARTIAL')`,
    [tenantId],
  )

  const candidatesById = new Map(candidateRows.rows.map((c) => [c.id, c]))
  const appsByCandidate = new Map<string, AppRow[]>()
  for (const row of appRows.rows) {
    if (!candidatesById.has(row.candidate_id)) continue
    const list = appsByCandidate.get(row.candidate_id)
    if (list === undefined) appsByCandidate.set(row.candidate_id, [row])
    else list.push(row)
  }
  const appById = new Map(appRows.rows.map((a) => [a.id, a]))
  const byApplication = <T extends { application_id: string }>(rows: readonly T[]): Map<string, T[]> => {
    const out = new Map<string, T[]>()
    for (const row of rows) {
      const list = out.get(row.application_id)
      if (list === undefined) out.set(row.application_id, [row])
      else list.push(row)
    }
    return out
  }
  const decisionsByApp = byApplication(decisionRows.rows)
  const interviewsByApp = byApplication(interviewRows.rows)
  const scorecardsByApp = byApplication(scorecardRows.rows)
  const resumes = latestResumeByCandidate(resumeRows.rows)

  const candidates: RediscoveryCandidate[] = []
  for (const candidate of candidateRows.rows) {
    const basis: RediscoveryBasis[] = []
    const seen = new Set<string>()
    let lastActive: string | null = null
    const add = (item: RediscoveryBasis): void => {
      if (seen.has(item.code)) return
      seen.add(item.code)
      basis.push(item)
      lastActive = maxIso(lastActive, item.at)
    }

    const apps = appsByCandidate.get(candidate.id) ?? []
    for (const app of apps) {
      lastActive = maxIso(lastActive, toIso(app.status_changed_at) ?? toIso(app.updated_at) ?? toIso(app.applied_at))
    }
    const mostRecentApp = [...apps].sort((a, b) => {
      const left = toIso(a.status_changed_at) ?? toIso(a.updated_at) ?? toIso(a.applied_at) ?? ''
      const right = toIso(b.status_changed_at) ?? toIso(b.updated_at) ?? toIso(b.applied_at) ?? ''
      return right.localeCompare(left)
    })[0]

    if (mostRecentApp !== undefined) {
      add({
        code: 'HISTORICAL_JOB',
        label: '历史岗位',
        detail: `${mostRecentApp.job_title}（${mostRecentApp.job_code}）· 阶段 ${mostRecentApp.current_stage_code}`,
        source: 'APPLICATION',
        at: toIso(mostRecentApp.status_changed_at) ?? toIso(mostRecentApp.updated_at) ?? toIso(mostRecentApp.applied_at),
      })
    }
    for (const app of apps) {
      for (const decision of decisionsByApp.get(app.id) ?? []) {
        lastActive = maxIso(lastActive, toIso(decision.decided_at))
        if (decision.decision_scope === 'SCREENING' && decision.result === 'ADVANCE') {
          add({
            code: 'SCREENING_PASSED',
            label: '曾过初筛',
            detail: `${app.job_title} 的历史初筛结论为通过`,
            source: 'DECISION',
            at: toIso(decision.decided_at),
          })
        }
      }
      for (const interview of interviewsByApp.get(app.id) ?? []) {
        lastActive = maxIso(lastActive, toIso(interview.status_changed_at))
        if (interview.round_no >= 2) {
          add({
            code: 'SECOND_INTERVIEW',
            label: '曾进二面',
            detail: `${app.job_title} 的历史面试到第 ${interview.round_no} 轮`,
            source: 'INTERVIEW',
            at: toIso(interview.status_changed_at),
          })
        }
      }
      for (const scorecard of scorecardsByApp.get(app.id) ?? []) {
        lastActive = maxIso(lastActive, toIso(scorecard.submitted_at))
        add({
          code: 'SCORECARD_SUBMITTED',
          label: '已交面评',
          detail: `${app.job_title} 的历史面评已提交`,
          source: 'SCORECARD',
          at: toIso(scorecard.submitted_at),
        })
      }
    }

    const resume = resumes.get(candidate.id)
    if (resume !== undefined) {
      lastActive = maxIso(lastActive, toIso(resume.created_at))
      for (const requirement of requirements) {
        if (requirement.field === undefined) continue
        if (!fieldPresent(resume.parsed_fields, requirement.field)) continue
        add({
          code: `RUBRIC_FIELD:${requirement.key}`,
          label: '当前岗位要求',
          detail: `${requirement.label}：历史材料中读到与当前要求对应的记录`,
          source: 'MATERIAL',
          at: toIso(resume.created_at),
        })
        if (basis.length >= REDISCOVERY_BASIS_LIMIT) break
      }
    }
    if (basis.length === 0) continue

    // 稳定排序：条件数多在前；同数按最近活跃时间倒序；再按 candidate id 兜底。
    candidates.push({
      candidate_id: candidate.id,
      candidate_name: candidate.display_name,
      matched_condition_count: basis.length,
      last_active_at: lastActive,
      basis: basis.slice(0, REDISCOVERY_BASIS_LIMIT),
    })
  }
  candidates.sort((a, b) => (
    b.matched_condition_count - a.matched_condition_count
    || (b.last_active_at ?? '').localeCompare(a.last_active_at ?? '')
    || a.candidate_id.localeCompare(b.candidate_id)
  ))
  const limited = candidates.slice(0, REDISCOVERY_LIMIT)
  return { ...empty, candidates: limited, total_matched: limited.length }
}

// ---------------------------------------------------------------------------
//  HTTP 路由
// ---------------------------------------------------------------------------

/** 与 W2 接线一致；仅供本 prefix 接管 `/jobs/:id` 时原样回退岗位详情（不改既有行为）。 */
const FALLBACK_ACTION_SEAMS: RecruitingActionSeams = {
  screening_decide: '/recruitment/api/action/screening/decide',
  stage_advance: '/recruitment/api/action/stage/advance',
  decision_record: '/recruitment/api/action/decision/record',
  interview_schedule: '/recruitment/api/action/interview/schedule',
  transcript_import: '/recruitment/api/action/transcript/import',
  rubric_approve: '/recruitment/api/action/job/rubric-approve',
  recruiting_settings_write: '/recruitment/api/action/config',
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

/**
 * 判断路径是不是 `.../jobs/<uuid>/rediscovery`，并从中间段取出 jobId。
 * 中间段必须是单个合法 UUID（不允许 `/`、`..`、查询串残留）。
 */
export function rediscoveryJobIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(REDISCOVERY_ROUTE_PREFIX)) return null
  if (!pathname.endsWith(REDISCOVERY_PATH_SUFFIX)) return null
  const middle = pathname.slice(REDISCOVERY_ROUTE_PREFIX.length, pathname.length - REDISCOVERY_PATH_SUFFIX.length)
  if (middle === '' || middle.includes('/') || !isUuidText(middle)) return null
  return middle
}

/** 岗位详情路径：`.../jobs/<uuid>`（本 prefix 需要原样回退既有行为）。 */
function jobDetailIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(REDISCOVERY_ROUTE_PREFIX)) return null
  const middle = pathname.slice(REDISCOVERY_ROUTE_PREFIX.length)
  if (middle === '' || middle.includes('/') || !isUuidText(middle)) return null
  return middle
}

/** 读 `X-DSH-Session` 头（身份只来自当前 DSH Session；形状非法 fail-closed）。 */
function requireSessionId(req: IncomingMessage): string {
  const raw = req.headers['x-dsh-session']
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new RediscoveryError('INVALID_ARGS', '缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）')
  }
  const trimmed = raw.trim()
  const uuid = trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
  if (!isUuidText(uuid)) throw new RediscoveryError('INVALID_ARGS', 'X-DSH-Session 必须是 session-<uuid> 或裸 UUID')
  return trimmed
}

/**
 * 注册人才再发现只读路由；返回 disposer。
 *
 * 非回环监听**不注册**（fail closed）。本模块注册的是比 recruiting 更长的
 * `/recruitment/api/recruiting/jobs/` prefix：命中 `:jobId/rediscovery` 时给本投影；
 * 命中 `:jobId` 时原样回退 `readJobDetail`（保持 W2 岗位详情不变）；其余 404。
 * @param ctx - 宿主上下文（webServer）。
 * @param database - 已解析数据库配置；null = 未配置。
 * @param issues - 未配置时的缺失项（仅用于日志）。
 */
export function registerTalentRediscoveryHttp(
  ctx: TalentRediscoveryHostContext,
  database: ResolvedDatabaseConfig | null,
  issues: readonly string[] = [],
): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: talent-rediscovery 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    // 1. 同源 + session（严格 loopback；sameOrigin 判据只有一个实现）。
    if (!sameOrigin(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    try { requireSessionId(req) } catch (error) {
      const code = error instanceof RediscoveryError ? error.code : 'INVALID_ARGS'
      const message = error instanceof Error ? error.message : String(error)
      json(res, 400, { error: { code, reason_code: 'SESSION_REQUIRED', message } })
      return
    }
    for (const key of ['actor_id', 'tenant_id'] as const) {
      if (url.searchParams.has(key)) {
        json(res, 400, {
          error: {
            code: 'INVALID_ARGS',
            reason_code: 'ACTOR_OVERRIDE_REJECTED',
            message: 'actor/tenant 只来自插件配置，不接受客户端传入',
          },
        })
        return
      }
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }

    const rediscoveryJobId = rediscoveryJobIdFromPath(pathname)
    if (rediscoveryJobId !== null) {
      if (database === null) {
        json(res, 503, { error: { code: 'NOT_CONFIGURED', reason_code: 'NOT_CONFIGURED', message: '数据库未配置' } })
        return
      }
      const pool = createPool(database)
      try {
        const value = await withReadOnly(pool, (client) => readTalentRediscovery({ database, client, jobId: rediscoveryJobId }))
        json(res, 200, value)
      } catch (error) {
        const code = error instanceof RediscoveryError ? error.code : 'INTERNAL'
        const message = error instanceof Error ? error.message : String(error)
        json(res, code === 'INVALID_ARGS' ? 400 : code === 'NOT_FOUND' ? 404 : 500, {
          error: { code, reason_code: code, message },
        })
      } finally {
        await closePool(pool)
      }
      return
    }

    // 回退：岗位详情与 W2 完全同实现（含同一份 action seam 接线），避免本 prefix 改变既有行为。
    const detailJobId = jobDetailIdFromPath(pathname)
    if (detailJobId !== null) {
      if (database === null) {
        json(res, 503, { error: { code: 'NOT_CONFIGURED', reason_code: 'NOT_CONFIGURED', message: '数据库未配置' } })
        return
      }
      const pool = createPool(database)
      try {
        const value = await withReadOnly(pool, (client) => readJobDetail(
          { database, client, actionSeams: FALLBACK_ACTION_SEAMS },
          detailJobId,
        ))
        json(res, 200, value)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.startsWith('NOT_FOUND:')) {
          json(res, 404, { error: { code: 'NOT_FOUND', message } })
          return
        }
        json(res, 500, { error: { code: 'INTERNAL', message } })
      } finally {
        await closePool(pool)
      }
      return
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } })
  }

  // 宿主 prefix 匹配会检查 `pathname.startsWith(`${prefix}/`)`；注册路径不能带尾斜杠，
  // 否则 `.../jobs//<id>/rediscovery` 永不命中。解析常量保留尾斜杠。
  return webServer.register({ kind: 'prefix', path: REDISCOVERY_ROUTE_PREFIX.replace(/\/$/, ''), handler })
}

/** 未配置数据库时的占位（只用于测试/诊断，不返回假数据）。 */
export function unconfiguredRediscovery(issues: readonly string[]): { configured: false; issues: readonly string[] } {
  return { configured: false, issues: [...issues] }
}
