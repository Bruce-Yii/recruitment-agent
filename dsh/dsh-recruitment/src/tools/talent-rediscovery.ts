// recruitment_talent_rediscovery —— G-12（Issue #35）历史人才再发现：**只读**工具。
//
// 与 `recruitment_workspace_overview` 同构：直接复用 `src/http/talent-rediscovery.ts`
// 的 `readTalentRediscovery()`，在 `withReadOnly`（`begin transaction read only`）里执行；
// 业务表零写入、不新建事实表、不返回联系方式/简历正文/机器路径。
//
// 输出纪律（产品口径）：
//   * 召回未投递当前 job 的历史候选人；只输出库里真实存在的历史条件，去重、不编造；
//   * 顺序 = 命中历史条件数 + 最近活跃时间（可解释），**没有百分比分数、没有黑盒排名**；
//   * HR 可见文案不出现内部术语，统一写「历史岗位 / 曾过初筛 / 曾进二面 / 当前岗位要求」；
//   * `render` 人读正文不放完整 UUID / hash；机器参数区照既有工具口径单独放行。
import { closePool, createPool, isUuidText, withReadOnly, type ResolvedDatabaseConfig } from '../db/pool.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  RediscoveryError,
  readTalentRediscovery,
  type RediscoveryResponse,
} from '../http/talent-rediscovery.ts'

export const TALENT_REDISCOVERY_TOOL_NAME = 'recruitment_talent_rediscovery'

/** 工具入参（只有一个必填 job_id；不接受 tenant/actor 覆盖，不接受 limit/score 等）。 */
export interface TalentRediscoveryArgs {
  readonly job_id: string
}

function invalid(detail: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', detail)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('arguments 必须是对象')
  return value as Record<string, unknown>
}

/**
 * 严格校验工具入参（纯函数，单测直接覆盖）。
 * @param raw - 模型给的 arguments。
 * @returns 只有 job_id 的归一化入参。
 */
export function normalizeTalentRediscoveryArgs(raw: unknown): TalentRediscoveryArgs {
  const record = asRecord(raw)
  const allowed = new Set(['job_id'])
  for (const key of Object.keys(record)) if (!allowed.has(key)) invalid(`未知参数 ${key}`)
  const rawId = record.job_id
  if (typeof rawId !== 'string') invalid('job_id 必须是 UUID 字符串')
  const trimmed = rawId.trim()
  if (trimmed === '' || !isUuidText(trimmed)) invalid('job_id 必须是合法 UUID')
  return { job_id: trimmed }
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['job_id'],
  properties: {
    job_id: {
      type: 'string',
      description: 'Target job UUID. Only candidates who have NOT applied to this job are recalled.',
    },
  },
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tool', 'contract_version', 'status', 'read_only', 'evaluated_at', 'labels',
    'job', 'candidates', 'total_matched', 'note',
  ],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean', enum: [true] },
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
    job: {
      type: 'object',
      additionalProperties: false,
      required: ['job_id', 'code', 'title', 'status', 'rubric_requirements'],
      properties: {
        job_id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        rubric_requirements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'label', 'kind'],
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string' },
              field: { type: 'string' },
            },
          },
        },
      },
    },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate_id', 'candidate_name', 'matched_condition_count', 'last_active_at', 'basis'],
        properties: {
          candidate_id: { type: 'string' },
          candidate_name: { type: 'string' },
          matched_condition_count: { type: 'integer' },
          last_active_at: { description: 'null, or an ISO-8601 timestamp' },
          basis: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'label', 'detail', 'source', 'at'],
              properties: {
                code: { type: 'string' },
                label: { type: 'string' },
                detail: { type: 'string' },
                source: { type: 'string', enum: ['APPLICATION', 'DECISION', 'INTERVIEW', 'SCORECARD', 'MATERIAL'] },
                at: { description: 'null, or an ISO-8601 timestamp' },
              },
            },
          },
        },
      },
    },
    total_matched: { type: 'integer' },
    note: { type: 'string' },
  },
}

/** 取小段人话（at 只给日期部分，不给完整时间戳噪音；非字符串一律不显示）。 */
function dayOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, 10)
}

function render(args: unknown, value: unknown): readonly TextBlock[] {
  const result = value as RediscoveryResponse | null | undefined
  if (result === null || result === undefined) return [{ type: 'text', text: '没有读到历史人才再发现结果。' }]
  const job = result.job ?? {}
  const requirements = Array.isArray(job.rubric_requirements) ? job.rubric_requirements : []
  const candidates = Array.isArray(result.candidates) ? result.candidates : []
  const text = (input: unknown): string => (typeof input === 'string' ? input : '')
  const lines: string[] = [
    `历史人才再发现（${text(result.contract_version)}）· 岗位 ${text(job.code)} ${text(job.title)}`,
    text(result.note),
  ]
  if (requirements.length > 0) {
    lines.push(`当前岗位要求（${requirements.length}）：${requirements.map((r) => text(r?.label)).join('；')}`)
  }
  if (candidates.length === 0) {
    lines.push('召回：没有符合条件的历史候选人。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  lines.push(`召回（${candidates.length} 人；按命中历史条件数与最近活跃时间呈现）：`)
  for (const candidate of candidates) {
    const active = candidate.last_active_at === null ? '' : ` · 最近活跃 ${dayOf(candidate.last_active_at)}`
    const basis = Array.isArray(candidate.basis) ? candidate.basis : []
    lines.push(`- ${text(candidate.candidate_name)} · 命中 ${typeof candidate.matched_condition_count === 'number' ? candidate.matched_condition_count : basis.length} 条历史条件${active}`)
    for (const item of basis) {
      const at = item.at === null ? '' : `（${dayOf(item.at)}）`
      lines.push(`    ${text(item.label)}：${text(item.detail)}${at}`)
    }
  }
  lines.push('')
  lines.push('next tools (machine arguments — copy verbatim into tool calls; never show ids or hashes to the human):')
  for (const candidate of candidates) {
    lines.push(`  recruitment_candidate_get {"candidate_id":"${text(candidate.candidate_id)}"} — read candidate profile`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 构造只读人才再发现工具。
 * @param config - 已解析数据库配置（tenant 只来自配置，模型不可传入）。
 */
export function createTalentRediscoveryTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TALENT_REDISCOVERY_TOOL_NAME,
    description:
      'Read-only historical talent rediscovery. Given a target job UUID, recall ACTIVE candidates in the same tenant '
      + 'who have NOT applied to that job, based only on real historical facts: past jobs, passed screening decisions, '
      + 'second-round interviews, submitted scorecards and parsed material fields matching the current rubric. '
      + 'Returns deduplicated candidates with reviewable historical basis and a deterministic, explainable order '
      + '(number of matched historical conditions + most recent activity). No score, no percentage, no black-box rank. '
      + 'Never invent records and never expose contact details or resume text.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    isConcurrencySafe: () => true,
    execute: async (rawArgs: unknown): Promise<unknown> => {
      const args = normalizeTalentRediscoveryArgs(rawArgs)
      const pool = createPool(config)
      try {
        return await withReadOnly(pool, (client) => readTalentRediscovery({
          database: config,
          client,
          jobId: args.job_id,
        }))
      } catch (error) {
        if (error instanceof RediscoveryError) {
          throw new RecruitmentToolError(error.code, error.message)
        }
        throw error
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 数据库未配置时的同名替身：如实 NOT_CONFIGURED，不返回空结果冒充成功。
 */
export function unconfiguredTalentRediscoveryTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TALENT_REDISCOVERY_TOOL_NAME,
    description: 'Read-only historical talent rediscovery (database is not configured in this deployment).',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: () => [{ type: 'text', text: '数据库未配置，无法读取历史人才再发现结果。' }],
    },
    execute: async (): Promise<unknown> => {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; ') || 'database not configured')
    },
  }
}
