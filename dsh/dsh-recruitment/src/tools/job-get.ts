// recruitment_job_get —— 取一个岗位及其 Rubric 版本（只读，stub 数据）。
//
// 只读证据：本文件不 import 任何 fs / net / DB 模块；execute 只做「按 id 取常量
// + 选版本」，不修改任何模块级状态。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { CRITERION_KINDS, JOB_STATUSES, JOB_STUBS, STUB_PROVENANCE } from './stubs.ts'

/** 入参声明。 */
const PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    required: true,
    maxLength: 64,
    description: 'Job (requisition) identifier, e.g. "job_0001". Non-empty, at most 64 characters.',
  },
  rubric_version: {
    kind: 'string',
    maxLength: 16,
    description: 'Rubric version to read, e.g. "v1". Defaults to the current version of the job.',
  },
}

/** 输出：一条 Rubric 判据。 */
interface CriterionValue {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
}

/** 输出：Rubric 版本内容。 */
interface RubricValue {
  readonly version: string
  readonly is_current: boolean
  readonly criteria: readonly CriterionValue[]
}

/** 输出：规范值。 */
interface JobGetValue {
  readonly job_id: string
  readonly title: string
  readonly status: string
  readonly location: string
  readonly provenance: string
  readonly stub: boolean
  readonly rubric: RubricValue
  readonly rubric_versions: readonly string[]
}

/** 规范输出 schema（只用官方强制子集里的关键字）。 */
const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    job_id: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: [...JOB_STATUSES] },
    location: { type: 'string' },
    provenance: { type: 'string', enum: ['FIXTURE', 'LIVE'] },
    stub: { type: 'boolean' },
    rubric: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        is_current: { type: 'boolean' },
        criteria: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string', enum: [...CRITERION_KINDS] },
              weight: { type: 'number' },
            },
            required: ['key', 'label', 'kind', 'weight'],
            additionalProperties: false,
          },
        },
      },
      required: ['version', 'is_current', 'criteria'],
      additionalProperties: false,
    },
    rubric_versions: { type: 'array', items: { type: 'string' } },
  },
  required: ['job_id', 'title', 'status', 'location', 'provenance', 'stub', 'rubric', 'rubric_versions'],
  additionalProperties: false,
}

/** 只读岗位/Rubric 工具。 */
export const jobGetTool: ReadonlyToolDefinition = {
  name: 'recruitment_job_get',
  description:
    'Get one job (requisition) together with one version of its screening rubric. '
    + 'Read-only stub over fixture data: provenance is always FIXTURE and no database is touched. '
    + 'Defaults to the current rubric version. Returns NOT_FOUND for an unknown job id or rubric version.',
  parameters: toParameterSchema(PARAMS),
  output: {
    schema: OUTPUT_SCHEMA,
    render(_args: unknown, value: unknown): readonly TextBlock[] {
      const v = value as JobGetValue
      const lines: string[] = [
        `job ${v.job_id} / ${v.title} (status=${v.status}, location=${v.location}, `
          + `provenance=${v.provenance}, stub=${String(v.stub)})`,
        `rubric ${v.rubric.version} (is_current=${String(v.rubric.is_current)}), `
          + `versions: ${v.rubric_versions.join(', ')}`,
      ]
      for (const criterion of v.rubric.criteria) {
        lines.push(`  ${criterion.key} [${criterion.kind}] weight=${criterion.weight} — ${criterion.label}`)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  isConcurrencySafe(): boolean {
    return true
  },
  async execute(rawArgs: unknown): Promise<unknown> {
    const args = parseArgs(PARAMS, rawArgs)
    const jobId = args.job_id as string
    const record = JOB_STUBS[jobId]
    if (record === undefined) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        `job "${jobId}" not found; known stub ids: ${Object.keys(JOB_STUBS).join(', ')}`,
      )
    }
    const versions = Object.keys(record.rubrics)
    const version = args.rubric_version === undefined
      ? record.current_rubric_version
      : (args.rubric_version as string)
    const criteria = record.rubrics[version]
    if (criteria === undefined) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        `rubric version "${version}" not found for job "${jobId}"; known versions: ${versions.join(', ')}`,
      )
    }
    const value: JobGetValue = {
      job_id: record.job_id,
      title: record.title,
      status: record.status,
      location: record.location,
      provenance: STUB_PROVENANCE,
      stub: true,
      rubric: {
        version,
        is_current: version === record.current_rubric_version,
        criteria: criteria.map((criterion) => ({
          key: criterion.key,
          label: criterion.label,
          kind: criterion.kind,
          weight: criterion.weight,
        })),
      },
      rubric_versions: versions,
    }
    return value
  },
}
