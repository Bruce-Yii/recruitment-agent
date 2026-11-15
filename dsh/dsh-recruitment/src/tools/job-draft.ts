// `recruitment_job_draft` —— 从一句人话需求生成「岗位草案 + Rubric 草案」的**纯只读工具**。
//
// 为什么它是一个独立工具而不是 job_create 的一个模式：
//   1. 产品负责人裁决（PRD §4.1–4.4 / task-51）要求"无外部输入也能用"——不连库、不调模型；
//      job_create 是**写库入口**，草案生成必须**零写入**，两者不能混。
//   2. 草案要带 reason/source/missing_items（人改后再确认），这些是**决策材料**，
//      不是 job_create 的入参；把它们塞进写工具会让"草案"和"已确认"在形状上不可区分。
//   3. 人确认闸门：本工具永远只返回 `confirmation.status='PENDING_HUMAN_CONFIRMATION'`；
//      建岗位/批标准仍必须由人走 `recruitment_job_create` / `recruitment_job_rubric_approve`。
//
// 与领域层的关系：`src/domain/job-draft.ts` 是唯一实现（纯函数），本文件只做
// 参数边界（封闭根 schema + 自己的校验）→ 领域函数 → 输出契约（DSH 支持的 schema 子集）。
//
// output schema 只用 DSH 官方子集：type / oneOf / properties / required / additionalProperties /
// items / enum / description。**没有** `type:'null'`、没有 type 数组：可缺省键一律"省略键"
// （缺了就不出现，不写 null）——这正是 `job-rubric-rules.md` §6.1 的单一裁决。

import { contractError } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import {
  CRITERION_KIND_VALUES,
  CRITERION_OPERATOR_VALUES,
  DRAFT_SOURCE_VALUES,
  JOB_DRAFT_CONTRACT_VERSION,
  JOB_TEMPLATE_LIBRARY,
  JobDraftError,
  buildJobDraft,
  parseJobDraftInput,
} from '../domain/job-draft.ts'

/** 工具名（模型可见，冻结）。 */
export const JOB_DRAFT_TOOL = 'recruitment_job_draft'

const TOOL_DESCRIPTION = [
  'Generate a job + rubric DRAFT from one plain-language hiring request. Pure read-only:',
  'no database, no network, no model call, zero writes. The result is NEVER a created job:',
  'every item carries a reason + source (USER_INPUT / DEPARTMENT_CONTEXT / HISTORY /',
  'TEMPLATE_LIBRARY / DEFAULT_SUGGESTION / MISSING), missing enterprise facts (department,',
  'headcount, level, location, salary, budget, priority, hiring reason) are returned in',
  '`missing_items` as questions instead of being made up, and the `confirmation` block is',
  'always PENDING_HUMAN_CONFIRMATION. `rubric_draft.criteria` already satisfies',
  'job-rubric-rules §6 R-VAL-1..13 (Σweight=1, >=1 MUST_HAVE/DISQUALIFIER, mechanical fields',
  'only from the §6.3 whitelist, everything else judgment questions), so after human review it',
  'can be fed to recruitment_job_create as-is. Templates: 6 families (backend/frontend/data/',
  'product/QA/SRE); pass template_id to force one, otherwise it is matched from the request text.',
].join(' ')

/** 参数里的模板 id 闭集（与模板库同源；模型看得到可选值）。 */
const TEMPLATE_IDS: readonly string[] = JOB_TEMPLATE_LIBRARY.map((template) => template.template_id)

// ---------------------------------------------------------------------------
//  parameters（封闭根 schema；嵌套对象也封闭）
// ---------------------------------------------------------------------------

const DEPARTMENT_CONTEXT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  description: 'Enterprise/department facts that are ALREADY known (all optional). Anything absent here is '
    + 'treated as missing and asked back in missing_items; this tool never invents these values.',
  properties: {
    department_id: { type: 'string', description: 'Department UUID (preferred over name when available).' },
    department_name: { type: 'string', description: 'Department name, 1..200 characters.' },
    location: { type: 'string', description: 'Work location already decided by the employer.' },
    level: { type: 'string', description: 'Job level/grade already decided (e.g. "P6", "资深").' },
    salary_range: { type: 'string', description: 'Salary range already decided (verbatim string).' },
    budget: { type: 'string', description: 'Headcount budget already decided (verbatim string).' },
    headcount: { type: 'integer', description: 'Planned number of hires, 1..10000.' },
    priority: { type: 'string', description: 'Hiring priority already decided (e.g. "P0", "急招").' },
    recruitment_reason: { type: 'string', description: 'Hiring reason already decided (replacement/new headcount/...).' },
  },
  required: [],
  additionalProperties: false,
}

const HISTORICAL_JOBS_PARAMETERS: Record<string, unknown> = {
  type: 'array',
  description: 'At most 20 past jobs used ONLY as reference (never auto-merged into the draft).',
  items: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Job UUID.' },
      title: { type: 'string', description: 'Job title, 1..200 characters.' },
      code: { type: 'string', description: 'Job code (optional).' },
      status: { type: 'string', description: 'Job status (optional).' },
      department_name: { type: 'string', description: 'Department name (optional).' },
    },
    required: ['title'],
    additionalProperties: false,
  },
}

const HISTORICAL_RUBRICS_PARAMETERS: Record<string, unknown> = {
  type: 'array',
  description: 'At most 20 past rubric versions used ONLY as reference (never auto-merged).',
  items: {
    type: 'object',
    properties: {
      job_id: { type: 'string', description: 'Job UUID (optional).' },
      version_no: { type: 'integer', description: 'Rubric version number (>=1, optional).' },
      dimensions: {
        type: 'array',
        description: 'Dimension summaries (key/label/kind/weight only; max 50).',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Criterion key (^[a-z][a-z0-9_]{1,40}$).' },
            label: { type: 'string', description: 'Criterion label (optional).' },
            kind: { type: 'string', enum: [...CRITERION_KIND_VALUES], description: 'Criterion kind (optional).' },
            weight: { type: 'number', description: 'Weight 0..1 (optional).' },
          },
          required: ['key'],
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
}

const JOB_DRAFT_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    request_text: {
      type: 'string',
      description: 'Required. One plain-language hiring need, trimmed length 1..2000 characters. '
        + 'Facts the user explicitly states (role, years, education, city, salary, headcount, '
        + 'priority, reason, business direction) are extracted; nothing else is invented.',
    },
    recruiter_supplement: {
      type: 'string',
      description: 'Optional recruiter follow-up (same extraction rules as request_text; max 2000 characters).',
    },
    template_id: {
      type: 'string',
      enum: TEMPLATE_IDS,
      description: 'Optional template id. Omit to match a template from the request text '
        + '(no match -> INVALID_ARGS/TEMPLATE_UNRESOLVED instead of guessing).',
    },
    department_context: DEPARTMENT_CONTEXT_PARAMETERS,
    historical_jobs: HISTORICAL_JOBS_PARAMETERS,
    historical_rubrics: HISTORICAL_RUBRICS_PARAMETERS,
  },
  required: ['request_text'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  output schema（DSH 子集；可缺省键一律"省略"，不使用 type:'null'）
// ---------------------------------------------------------------------------

/** 造一个封闭对象节点。 */
function obj(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

/** 字符串数组节点。 */
function stringArray(description: string): Record<string, unknown> {
  return { type: 'array', items: { type: 'string' }, description }
}

const SOURCE_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: [...DRAFT_SOURCE_VALUES],
  description: 'Where this item came from (closed set).',
}

const SOURCED_TEXT_ITEM_SCHEMA = obj({
  text: { type: 'string' },
  reason: { type: 'string' },
  source: SOURCE_SCHEMA,
}, ['text', 'reason', 'source'])

const FACT_STRING_SCHEMA = obj({
  value: { type: 'string' },
  source: SOURCE_SCHEMA,
  reason: { type: 'string' },
}, ['value', 'source', 'reason'])

const FACT_NUMBER_SCHEMA = obj({
  value: { type: 'integer' },
  source: SOURCE_SCHEMA,
  reason: { type: 'string' },
}, ['value', 'source', 'reason'])

const DEPARTMENT_FACT_SCHEMA = obj({
  value: { type: 'string' },
  department_id: { type: 'string' },
  source: SOURCE_SCHEMA,
  reason: { type: 'string' },
}, ['source', 'reason'])

const TEMPLATE_REF_SCHEMA = obj({
  template_id: { type: 'string' },
  family: { type: 'string' },
  label: { type: 'string' },
  reason: { type: 'string' },
  source: { type: 'string', enum: ['TEMPLATE_LIBRARY'] },
}, ['template_id', 'family', 'label', 'reason', 'source'])

const ROUND_SCHEMA = obj({
  name: { type: 'string' },
  focus: stringArray('What this round focuses on.'),
  reason: { type: 'string' },
  source: SOURCE_SCHEMA,
}, ['name', 'focus', 'reason', 'source'])

const CRITERION_SCHEMA = obj({
  key: { type: 'string' },
  label: { type: 'string' },
  kind: { type: 'string', enum: [...CRITERION_KIND_VALUES] },
  weight: { type: 'number' },
  field: {
    type: 'string',
    description: 'Mechanical only, and only from job-rubric-rules §6.3; absent on judgment criteria.',
  },
  operator: { type: 'string', enum: [...CRITERION_OPERATOR_VALUES] },
  value: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
  question: { type: 'string', description: 'Judgment only; absent on mechanical criteria.' },
  notes: { type: 'string' },
}, ['key', 'label', 'kind', 'weight'])

const RATIONALE_SCHEMA = obj({
  criterion_key: { type: 'string' },
  reason: { type: 'string' },
  source: SOURCE_SCHEMA,
}, ['criterion_key', 'reason', 'source'])

const ROUND_FOCUS_SCHEMA = obj({
  round: { type: 'string' },
  criteria_keys: stringArray('Criterion keys probed in this round.'),
  reason: { type: 'string' },
  source: SOURCE_SCHEMA,
}, ['round', 'criteria_keys', 'reason', 'source'])

const HARD_GATES_SCHEMA = obj({
  must_have_keys: stringArray('MUST_HAVE criterion keys.'),
  disqualifier_keys: stringArray('DISQUALIFIER criterion keys (empty for all built-in templates).'),
}, ['must_have_keys', 'disqualifier_keys'])

const SCORECARD_FIELD_SCHEMA = obj({
  key: { type: 'string' },
  label: { type: 'string' },
  type: { type: 'string', enum: ['SCORE_1_5', 'TEXT'] },
  reason: { type: 'string' },
  source: SOURCE_SCHEMA,
}, ['key', 'label', 'type', 'reason', 'source'])

const RUBRIC_DRAFT_SCHEMA = obj({
  criteria: {
    type: 'array',
    items: CRITERION_SCHEMA,
    description: 'Pure criterion objects (9-key closed subset); already valid for recruitment_job_create.',
  },
  rationale: { type: 'array', items: RATIONALE_SCHEMA },
  hard_gates: HARD_GATES_SCHEMA,
  round_focus: { type: 'array', items: ROUND_FOCUS_SCHEMA },
  scorecard_fields: { type: 'array', items: SCORECARD_FIELD_SCHEMA },
  weight_sum: { type: 'number', description: 'Sum of criterion weights (1 within 1e-6).' },
}, ['criteria', 'rationale', 'hard_gates', 'round_focus', 'scorecard_fields', 'weight_sum'])

const MISSING_ITEM_SCHEMA = obj({
  field: { type: 'string' },
  question: { type: 'string' },
  why: { type: 'string' },
  source: { type: 'string', enum: ['MISSING'] },
  blocking: { type: 'boolean' },
}, ['field', 'question', 'why', 'source', 'blocking'])

const WARNING_SCHEMA = obj({
  code: { type: 'string' },
  message: { type: 'string' },
}, ['code', 'message'])

const HISTORY_SCHEMA = obj({
  matched_jobs: {
    type: 'array',
    items: obj({
      title: { type: 'string' },
      matched_because: { type: 'string' },
      source: { type: 'string', enum: ['HISTORY'] },
      code: { type: 'string' },
      status: { type: 'string' },
    }, ['title', 'matched_because', 'source']),
  },
  reference_rubrics: {
    type: 'array',
    items: obj({
      dimension_keys: stringArray('Dimension keys of the referenced historical rubric.'),
      note: { type: 'string' },
      source: { type: 'string', enum: ['HISTORY'] },
      version_no: { type: 'integer' },
      job_id: { type: 'string' },
    }, ['dimension_keys', 'note', 'source']),
  },
  reason: { type: 'string' },
}, ['matched_jobs', 'reference_rubrics', 'reason'])

const JOB_BLOCK_SCHEMA = obj({
  title: { type: 'string' },
  title_source: { type: 'string', enum: ['USER_INPUT', 'TEMPLATE_LIBRARY'] },
  responsibilities: { type: 'array', items: SOURCED_TEXT_ITEM_SCHEMA },
  success_profile: { type: 'array', items: SOURCED_TEXT_ITEM_SCHEMA },
  must_have: { type: 'array', items: SOURCED_TEXT_ITEM_SCHEMA },
  nice_to_have: { type: 'array', items: SOURCED_TEXT_ITEM_SCHEMA },
  rounds: { type: 'array', items: ROUND_SCHEMA },
  department: DEPARTMENT_FACT_SCHEMA,
  headcount: FACT_NUMBER_SCHEMA,
  level: FACT_STRING_SCHEMA,
  location: FACT_STRING_SCHEMA,
  salary: FACT_STRING_SCHEMA,
  budget: FACT_STRING_SCHEMA,
  priority: FACT_STRING_SCHEMA,
  recruitment_reason: FACT_STRING_SCHEMA,
  domain_context: FACT_STRING_SCHEMA,
}, ['title', 'title_source', 'responsibilities', 'success_profile', 'must_have', 'nice_to_have', 'rounds'])

const CONFIRMATION_SCHEMA = obj({
  required: { type: 'boolean' },
  status: { type: 'string', enum: ['PENDING_HUMAN_CONFIRMATION'] },
  next: stringArray('Tools the HUMAN must call after confirming/editing the draft.'),
  note: { type: 'string' },
}, ['required', 'status', 'next', 'note'])

const OUTPUT_SCHEMA: Record<string, unknown> = obj({
  tool: { type: 'string', enum: [JOB_DRAFT_TOOL] },
  contract_version: { type: 'string' },
  read_only: { type: 'boolean' },
  zero_write: { type: 'boolean' },
  status: { type: 'string', enum: ['OK'] },
  template: TEMPLATE_REF_SCHEMA,
  job: JOB_BLOCK_SCHEMA,
  rubric_draft: RUBRIC_DRAFT_SCHEMA,
  missing_items: { type: 'array', items: MISSING_ITEM_SCHEMA },
  warnings: { type: 'array', items: WARNING_SCHEMA },
  history: HISTORY_SCHEMA,
  confirmation: CONFIRMATION_SCHEMA,
}, [
  'tool', 'contract_version', 'read_only', 'zero_write', 'status', 'template', 'job',
  'rubric_draft', 'missing_items', 'warnings', 'confirmation',
])

// ---------------------------------------------------------------------------
//  render（模型可见的文本摘要；不做校验，校验由 output schema 负责）
// ---------------------------------------------------------------------------

/** 安全取对象。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 安全取字符串（渲染用；缺就是空串）。 */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 安全取数组。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 把草案输出渲染成模型可见的文本（逐项带来源/理由摘要 + 缺失项问题 + 确认闸门）。
 * @param _args - 模型入参（渲染不用）。
 * @param value - 已通过 output schema 的规范值。
 * @returns 一个文本块。
 */
function renderJobDraft(_args: unknown, value: unknown): readonly TextBlock[] {
  const root = asRecord(value)
  if (root === undefined) return [{ type: 'text', text: 'recruitment_job_draft: 输出形状异常（不是对象）' }]
  const template = asRecord(root.template) ?? {}
  const job = asRecord(root.job) ?? {}
  const rubric = asRecord(root.rubric_draft) ?? {}
  const criteria = asArray(rubric.criteria)
  const byKind = (kind: string): number => criteria.filter((criterion) => {
    const entry = asRecord(criterion)
    return entry !== undefined && entry.kind === kind
  }).length
  const lines: string[] = []
  lines.push('recruitment_job_draft · 岗位/Rubric 草案（read_only · zero_write · 零写入）')
  lines.push(`模板：${asText(template.template_id)}（${asText(template.family)} / ${asText(template.label)}，来源：${asText(template.source)}）`)
  lines.push(`岗位名称：${asText(job.title)}（来源：${asText(job.title_source)}）`)
  lines.push('')
  const listSection = (title: string, key: string): void => {
    const items = asArray(job[key])
    lines.push(`${title}（${items.length} 条）：`)
    for (const item of items) {
      const entry = asRecord(item)
      if (entry === undefined) continue
      lines.push(`  - ${asText(entry.text)}（来源：${asText(entry.source)}）`)
    }
  }
  listSection('职责', 'responsibilities')
  listSection('成功画像', 'success_profile')
  listSection('必备', 'must_have')
  listSection('加分', 'nice_to_have')
  const rounds = asArray(job.rounds)
  lines.push(`面试轮次（${rounds.length} 轮）：${rounds.map((round) => asText(asRecord(round)?.name)).join(' → ')}`)
  lines.push('')
  lines.push(`Rubric 草案：${criteria.length} 条（MUST_HAVE ${byKind('MUST_HAVE')} / NICE_TO_HAVE ${byKind('NICE_TO_HAVE')} / DISQUALIFIER ${byKind('DISQUALIFIER')}），Σweight=${typeof rubric.weight_sum === 'number' ? rubric.weight_sum : '?'}`)
  const hardGates = asRecord(rubric.hard_gates) ?? {}
  lines.push(`硬性门槛：${asArray(hardGates.must_have_keys).map((key) => asText(key)).join('、') || '（无）'}`)
  const rationales = asArray(rubric.rationale)
  if (rationales.length > 0) {
    lines.push('维度理由：')
    for (const entry of rationales) {
      const rationale = asRecord(entry)
      if (rationale === undefined) continue
      lines.push(`  - ${asText(rationale.criterion_key)}：${asText(rationale.reason)}（来源：${asText(rationale.source)}）`)
    }
  }
  lines.push('')
  const missing = asArray(root.missing_items)
  const blockingCount = missing.filter((item) => asRecord(item)?.blocking === true).length
  lines.push(`待人类确认（${missing.length} 项，其中 ${blockingCount} 项创建前必须确认）：`)
  for (const item of missing) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    lines.push(`  - [${entry.blocking === true ? '必须' : '建议'}] ${asText(entry.question)}`)
  }
  const warnings = asArray(root.warnings)
  if (warnings.length > 0) {
    lines.push('')
    lines.push('警告：')
    for (const warning of warnings) {
      const entry = asRecord(warning)
      if (entry === undefined) continue
      lines.push(`  - ${asText(entry.code)}：${asText(entry.message)}`)
    }
  }
  const confirmation = asRecord(root.confirmation) ?? {}
  lines.push('')
  lines.push(`确认闸门：required=${String(confirmation.required)}，status=${asText(confirmation.status)}`)
  lines.push(`确认/修改必须由人完成（${asText(confirmation.note)}）；确认后由人调用：${asArray(confirmation.next).map((name) => asText(name)).join(' / ')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
//  工具定义
// ---------------------------------------------------------------------------

/**
 * 造 `recruitment_job_draft` 工具（**无任何配置依赖**：DB 未配置的 profile 也能生成草案）。
 *
 * `execute` 只做三件事：边界校验 → 纯函数生成 → 返回规范值；**没有任何写入路径**。
 * 领域错误（`JobDraftError`）在这里统一映射成 `INVALID_ARGS`（`tool-contracts.md` §1.2 风格），
 * 非领域错误原样抛出（不伪装）。
 */
export function createJobDraftTool(): ReadonlyToolDefinition {
  return {
    name: JOB_DRAFT_TOOL,
    description: TOOL_DESCRIPTION,
    parameters: JOB_DRAFT_PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderJobDraft },
    isConcurrencySafe(): boolean {
      // 纯函数、零写入、无外部依赖：可以与其他只读调用并行。
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      try {
        const input = parseJobDraftInput(rawArgs)
        const draft = buildJobDraft(input)
        return { tool: JOB_DRAFT_TOOL, contract_version: JOB_DRAFT_CONTRACT_VERSION, ...draft }
      } catch (error) {
        if (error instanceof JobDraftError) {
          throw contractError('INVALID_ARGS', {
            reason_code: error.reason_code,
            message: error.message,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          })
        }
        throw error
      }
    },
  }
}
