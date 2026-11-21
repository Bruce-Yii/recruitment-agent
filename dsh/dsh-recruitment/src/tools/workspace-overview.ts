// recruitment_workspace_overview —— 只读“工作台总览”工具（首页两条快捷词/跨岗位追问）。
//
// 同源复用（不复制投影查询）：直接调用 `src/http/recruiting.ts` 的
// `readRecruitingOverview()`，并在 `withReadOnly`（`begin transaction read only`）里执行；
// 业务表零写入、遵守既有 PII 脱敏口径（只取姓名/岗位/阶段，不取联系方式、简历正文、storage_ref）。
//
// 与 `recruitment_interview_free_slots` 同构：HTTP 路由与 DSH 工具共用同一读模型；
// 本文件只做“入参校验 + 精简投影”，不新增查询、不新增事实表。
import { closePool, createPool, isUuidText, withReadOnly, type ResolvedDatabaseConfig } from '../db/pool.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  readRecruitingOverview,
  type ApplicationCard,
  type JobCard,
  type RecruitingOverview,
} from '../http/recruiting.ts'

export const WORKSPACE_OVERVIEW_TOOL_NAME = 'recruitment_workspace_overview'
const CONTRACT_VERSION = '1.0.0'

export type WorkspaceStageFilter = 'all' | 'screening' | 'interviewing' | 'awaiting_decision'
const STAGE_FILTERS: readonly WorkspaceStageFilter[] = ['all', 'screening', 'interviewing', 'awaiting_decision']
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

export interface WorkspaceOverviewArgs {
  readonly job_id?: string
  readonly stage_filter: WorkspaceStageFilter
  readonly only_overdue_scorecards: boolean
  readonly limit: number
}

export interface WorkspaceOverviewResult {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  readonly read_only: true
  readonly evaluated_at: string
  readonly labels: RecruitingOverview['labels']
  readonly counts: {
    readonly jobs_open: number
    readonly applications_active: number
    readonly awaiting_screening: number
    readonly interviewing: number
    readonly awaiting_decision: number
    readonly scorecards_required: number
    readonly scorecards_submitted: number
    readonly overdue_scorecards_total: number
  }
  readonly jobs: ReadonlyArray<{
    readonly job_id: string
    readonly code: string
    readonly title: string
    readonly status: string
    readonly active_count: number
    readonly rubric_approved: boolean
    readonly by_stage: Readonly<Record<string, number>>
  }>
  readonly applications: ReadonlyArray<{
    readonly application_id: string
    readonly candidate_name: string
    readonly job_id: string
    readonly job_title: string
    readonly stage_code: string
    readonly stage_label: string
    readonly overdue_scorecards: number
    readonly stage_blocked_reason: string | null
    readonly next_step: {
      readonly code: string
      readonly label: string
      readonly kind: string
    }
  }>
}

function invalid(detail: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', detail)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('arguments 必须是对象')
  return value as Record<string, unknown>
}

/**
 * 校验并归一化工具入参（纯函数，单测直接覆盖）。
 * @param raw - 模型给的 arguments。
 * @returns 归一化参数（默认 stage=all / overdue=false / limit=20）。
 */
export function normalizeWorkspaceOverviewArgs(raw: unknown): WorkspaceOverviewArgs {
  const record = asRecord(raw)
  const allowed = new Set(['job_id', 'stage_filter', 'only_overdue_scorecards', 'limit'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`未知参数 ${key}`)
  }

  const jobIdRaw = record.job_id
  let jobId: string | undefined
  if (jobIdRaw !== undefined) {
    if (typeof jobIdRaw !== 'string') invalid('job_id 必须是 UUID 字符串')
    const trimmed = jobIdRaw.trim()
    if (trimmed === '' || !isUuidText(trimmed)) invalid('job_id 必须是合法 UUID')
    jobId = trimmed
  }

  const stageFilterRaw = record.stage_filter
  let stageFilter: WorkspaceStageFilter = 'all'
  if (stageFilterRaw !== undefined) {
    if (typeof stageFilterRaw !== 'string' || !(STAGE_FILTERS as readonly string[]).includes(stageFilterRaw)) {
      invalid('stage_filter 必须是 all / screening / interviewing / awaiting_decision')
    }
    stageFilter = stageFilterRaw as WorkspaceStageFilter
  }

  const overdueRaw = record.only_overdue_scorecards
  let onlyOverdue = false
  if (overdueRaw !== undefined) {
    if (typeof overdueRaw !== 'boolean') invalid('only_overdue_scorecards 必须是布尔值')
    onlyOverdue = overdueRaw
  }

  const limitRaw = record.limit
  let limit = DEFAULT_LIMIT
  if (limitRaw !== undefined) {
    if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
      invalid(`limit 必须是 1..${MAX_LIMIT} 的整数`)
    }
    limit = limitRaw
  }

  return {
    ...(jobId === undefined ? {} : { job_id: jobId }),
    stage_filter: stageFilter,
    only_overdue_scorecards: onlyOverdue,
    limit,
  }
}

function overdueOf(app: ApplicationCard): number {
  return app.interviews.reduce((sum, iv) => sum + (iv.scorecards?.overdue ?? 0), 0)
}

function matchesStageFilter(app: ApplicationCard, filter: WorkspaceStageFilter): boolean {
  if (filter === 'all') return true
  const stage = app.current_stage_code
  const nextCode = app.progress.next_step.code
  if (filter === 'screening') {
    return nextCode === 'PROVIDE_SCREENING_DECISION' || stage === 'S7'
  }
  if (filter === 'interviewing') {
    return nextCode === 'PREPARE_INTERVIEW' || nextCode === 'WAIT_SCORECARDS' || stage === 'S8' || stage === 'S9'
  }
  // awaiting_decision：停在 S10 且没有当前有效的 STAGE/FINAL 决定（与 counts.awaiting_decision 同口径）。
  return stage === 'S10' && !app.decisions.some(
    (d) => d.is_current && d.stage_code === 'S10' && (d.decision_scope === 'STAGE' || d.decision_scope === 'FINAL'),
  )
}

function stageLabelOf(overview: RecruitingOverview, code: string): string {
  const stages = overview.settings.stage_catalog?.stages
  const found = stages?.find((stage) => stage.code === code)
  return found?.label ?? code
}

/**
 * 将 HTTP overview 精简成工具出参（纯函数，单测直接覆盖过滤/空结果/limit）。
 * @param overview - `readRecruitingOverview()` 的完整投影。
 * @param args - 已归一化入参。
 * @returns 精简总览（counts 为全局；jobs/applications 按过滤器裁剪，applications 再受 limit）。
 */
export function projectWorkspaceOverview(
  overview: RecruitingOverview,
  args: WorkspaceOverviewArgs,
): WorkspaceOverviewResult {
  const jobs = overview.jobs
    .filter((job) => args.job_id === undefined || job.job_id === args.job_id)
    .map((job) => ({
      job_id: job.job_id,
      code: job.code,
      title: job.title,
      status: job.status,
      active_count: job.application_counts.active,
      rubric_approved: job.rubric?.approved === true,
      by_stage: job.application_counts.by_stage,
    }))

  const applications = overview.applications
    .filter((app) => args.job_id === undefined || app.job.job_id === args.job_id)
    .filter((app) => matchesStageFilter(app, args.stage_filter))
    .filter((app) => !args.only_overdue_scorecards || overdueOf(app) > 0)
    .slice(0, args.limit)
    .map((app) => ({
      application_id: app.application_id,
      candidate_name: app.candidate.display_name,
      job_id: app.job.job_id,
      job_title: app.job.title,
      stage_code: app.current_stage_code,
      stage_label: stageLabelOf(overview, app.current_stage_code),
      overdue_scorecards: overdueOf(app),
      stage_blocked_reason: app.stage_blocked_reason,
      next_step: {
        code: app.progress.next_step.code,
        label: app.progress.next_step.label,
        kind: app.progress.next_step.kind,
      },
    }))

  const overdueTotal = overview.applications.reduce((sum, app) => sum + overdueOf(app), 0)

  return {
    tool: WORKSPACE_OVERVIEW_TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    read_only: true,
    evaluated_at: overview.evaluated_at,
    labels: overview.labels,
    counts: {
      jobs_open: overview.counts.jobs_open,
      applications_active: overview.counts.applications_active,
      awaiting_screening: overview.counts.awaiting_screening,
      interviewing: overview.counts.interviewing,
      awaiting_decision: overview.counts.awaiting_decision,
      scorecards_required: overview.counts.scorecards_required_total,
      scorecards_submitted: overview.counts.scorecards_submitted_total,
      overdue_scorecards_total: overdueTotal,
    },
    jobs,
    applications,
  }
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'contract_version', 'status', 'read_only', 'evaluated_at', 'labels', 'counts', 'jobs', 'applications'],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean' },
    evaluated_at: { type: 'string' },
    labels: {
      type: 'object',
      additionalProperties: false,
      required: ['provenance', 'trigger', 'connection'],
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['EVENT', 'MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED', 'AUTH_REQUIRED'] },
      },
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: [
        'jobs_open', 'applications_active', 'awaiting_screening', 'interviewing',
        'awaiting_decision', 'scorecards_required', 'scorecards_submitted', 'overdue_scorecards_total',
      ],
      properties: {
        jobs_open: { type: 'integer' },
        applications_active: { type: 'integer' },
        awaiting_screening: { type: 'integer' },
        interviewing: { type: 'integer' },
        awaiting_decision: { type: 'integer' },
        scorecards_required: { type: 'integer' },
        scorecards_submitted: { type: 'integer' },
        overdue_scorecards_total: { type: 'integer' },
      },
    },
    jobs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id', 'code', 'title', 'status', 'active_count', 'rubric_approved', 'by_stage'],
        properties: {
          job_id: { type: 'string' },
          code: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          active_count: { type: 'integer' },
          rubric_approved: { type: 'boolean' },
          by_stage: { type: 'object', description: 'stage code -> application count' },
        },
      },
    },
    applications: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'application_id', 'candidate_name', 'job_id', 'job_title',
          'stage_code', 'stage_label', 'overdue_scorecards', 'stage_blocked_reason', 'next_step',
        ],
        properties: {
          application_id: { type: 'string' },
          candidate_name: { type: 'string' },
          job_id: { type: 'string' },
          job_title: { type: 'string' },
          stage_code: { type: 'string' },
          stage_label: { type: 'string' },
          overdue_scorecards: { type: 'integer' },
          stage_blocked_reason: { description: 'null, or the real blocking reason text' },
          next_step: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'label', 'kind'],
            properties: {
              code: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string' },
            },
          },
        },
      },
    },
  },
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    job_id: { type: 'string', description: 'Optional job UUID; filters jobs and applications to this job.' },
    stage_filter: {
      type: 'string',
      enum: [...STAGE_FILTERS],
      description: 'Optional stage filter; default all.',
    },
    only_overdue_scorecards: {
      type: 'boolean',
      description: 'When true, return only applications with at least one overdue scorecard. Default false.',
    },
    limit: {
      type: 'integer',
      description: 'Max applications to return (1..50, default 20).',
    },
  },
}

function render(args: unknown, value: unknown): readonly TextBlock[] {
  const result = value as WorkspaceOverviewResult | null
  if (result === null) return [{ type: 'text', text: '没有读到工作台总览。' }]
  const c = result.counts
  const lines: string[] = [
    `工作台总览（${result.labels.provenance}/${result.labels.trigger}/${result.labels.connection}）`,
    `计数：在招岗位 ${c.jobs_open} · 在办申请 ${c.applications_active} · 待初筛 ${c.awaiting_screening} · 面试中 ${c.interviewing} · 待决策 ${c.awaiting_decision} · 面评 ${c.scorecards_submitted}/${c.scorecards_required}（超时 ${c.overdue_scorecards_total}）`,
  ]
  const parsed = args as Partial<WorkspaceOverviewArgs> | null
  const filterText = [
    parsed?.job_id === undefined ? '' : `岗位=${parsed.job_id}`,
    parsed?.stage_filter === undefined || parsed.stage_filter === 'all' ? '' : `阶段=${parsed.stage_filter}`,
    parsed?.only_overdue_scorecards === true ? '仅超时面评' : '',
    parsed?.limit === undefined ? '' : `limit=${parsed.limit}`,
  ].filter(Boolean).join(' · ')
  if (filterText !== '') lines.push(`过滤：${filterText}`)
  if (result.jobs.length > 0) {
    lines.push(`岗位（${result.jobs.length}）：`)
    for (const job of result.jobs) {
      lines.push(`- ${job.code} ${job.title}（${job.status}）· 在办 ${job.active_count} · rubric ${job.rubric_approved ? '已批准' : '未批准'}`)
    }
  }
  if (result.applications.length === 0) {
    lines.push('申请：没有符合条件的记录。')
  } else {
    lines.push(`申请（${result.applications.length}）：`)
    for (const app of result.applications) {
      const overdue = app.overdue_scorecards > 0 ? ` · 面评超时 ${app.overdue_scorecards} 份` : ''
      const blocked = app.stage_blocked_reason ? ` · 阻塞：${app.stage_blocked_reason}` : ''
      lines.push(`- ${app.candidate_name} · ${app.job_title} · ${app.stage_label}${overdue}${blocked} · 下一步：${app.next_step.label}`)
    }
    lines.push('')
    lines.push('next tools (machine arguments — copy verbatim into tool calls; never show ids or hashes to the human):')
    for (const app of result.applications) {
      lines.push(`  application_id=${app.application_id} job_id=${app.job_id}`)
    }
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 构造只读工作台总览工具。
 * @param config - 已解析数据库配置（租户只来自配置，模型不可传入）。
 * @returns 可注册的 ReadonlyToolDefinition。
 */
export function createWorkspaceOverviewTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: WORKSPACE_OVERVIEW_TOOL_NAME,
    description:
      'Read-only workspace overview straight from the business database (same projection as the v4 queue/jobs pages). '
      + 'Use it for questions like which candidates should be prioritized today, which scorecards are pending/overdue, '
      + 'or bottlenecks across jobs. Optional filters: job_id (UUID), stage_filter (all/screening/interviewing/awaiting_decision), '
      + 'only_overdue_scorecards (boolean), limit (1..50, default 20). Returns compact counts, jobs[] and applications[] '
      + 'with real stage/blocked/next-step fields. Fields are already PII-minimized; never invent missing records.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render,
    },
    isConcurrencySafe: () => true,
    execute: async (rawArgs: unknown): Promise<unknown> => {
      const args = normalizeWorkspaceOverviewArgs(rawArgs)
      const pool = createPool(config)
      try {
        return await withReadOnly(pool, async (client) => {
          const overview = await readRecruitingOverview({ database: config, client })
          return projectWorkspaceOverview(overview, args)
        })
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 数据库缺配置时的同名替身（如实 NOT_CONFIGURED，不返回空总览冒充成功）。
 * @param issues - 缺配置原因。
 * @returns 可注册的工具定义（execute 恒定抛错）。
 */
export function unconfiguredWorkspaceOverviewTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: WORKSPACE_OVERVIEW_TOOL_NAME,
    description: 'Read-only workspace overview (database is not configured in this deployment).',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: () => [{ type: 'text', text: '数据库未配置，无法读取工作台总览。' }],
    },
    execute: async (): Promise<unknown> => {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; ') || 'database not configured')
    },
  }
}
