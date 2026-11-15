// task-78 / DESIGN §3.2：预算配置解析（单一来源 + fail-closed）。
//
// 单一来源 = 产品 profile `dsh/profile/recruitment/cordis.patch.yml` 的 recruitment row
// `config.budget.*`（Owner 交 patch 草稿给 W0 落）。env 只用于**部署注入**，不构成第二来源：
// 解析结果带 `sources` 逐键来源（`profile` | `env` | `default`），可逐键核对。
//
// raw 形状（Owner 裁决，冻结）= `config.budget` 这个**扁平记录**：
//   budget:
//     DECISION_MAX_TOKENS: 200000
//     DECISION_MAX_STEPS: 25
//     SCREENING_MAX_TOKENS: 100000
//     SCREENING_MAX_STEPS: 15
//     task_class: AUTO            # AUTO | SCREENING | DECISION
//     default_class: SCREENING
//     enabled: true               # 总开关（lead 2026-11-16 裁决；默认 true，显式 false = 关闭预算闸门）
//     status_tool: false          # 默认必须 false（D-128.2 工具数=30）
//     handoff:
//       owner: null               # 可选，非空字符串才生效
//     tool_class_map: {}          # 覆盖默认映射（与默认映射合并）
//
// 逐键优先级：profile 显式值（number / `${ENV_NAME}` 模板 / 数字字符串）
//   → env `RECRUITMENT_BUDGET_<CANONICAL_KEY>` → 默认值。
// 非法值（负数 / 0 / 非数字 / NaN / Infinity）→ `issues` 加一条 + 该键回退默认 + `sources=default`。
// `issues` 永不为 null；本函数**从不抛异常**（fail-closed，让宿主能继续启动并如实报告）。
import type {
  BudgetConfigIssues,
  BudgetLimits,
  BudgetSource,
  BudgetTaskClass,
  ResolvedBudgetConfig,
} from './types.ts'

/** 默认额度（DESIGN §2 = task-78 全文口径）。 */
export const DEFAULT_LIMITS: Readonly<Record<BudgetTaskClass, BudgetLimits>> = Object.freeze({
  DECISION: Object.freeze({ max_tokens: 200000, max_steps: 25 }),
  SCREENING: Object.freeze({ max_tokens: 100000, max_steps: 15 }),
})

/**
 * 默认工具→类映射（DESIGN §3.2 注释里的工具清单，精确名）。
 *
 * 用途：`task_class=AUTO` 时按首次命中的业务工具给会话定类。产品工具名以 `register`
 * 现场为准；未命中的工具不改变分类（继续用 `default_class`，严格侧兜底）。
 */
export const DEFAULT_TOOL_CLASS_MAP: Readonly<Record<string, BudgetTaskClass>> = Object.freeze({
  // 决策类：写下/推进正式决定
  record_human_decision: 'DECISION',
  recruitment_decision_record: 'DECISION',
  recruitment_stage_advance: 'DECISION',
  recruitment_evaluation_summarize: 'DECISION',
  // 初筛类：读材料 + 出初筛评估
  recruitment_screening_evaluate: 'SCREENING',
  recruitment_application_get: 'SCREENING',
  recruitment_candidate_get: 'SCREENING',
  recruitment_material_read: 'SCREENING',
  recruitment_resume_read: 'SCREENING',
  recruitment_job_get: 'SCREENING',
  recruitment_interview_get: 'SCREENING',
  recruitment_transcript_read: 'SCREENING',
  recruitment_transcript_get: 'SCREENING',
})

/** 四个额度键的 canonical 名（= profile 键 + env 后缀 + sources 键）。 */
const LIMIT_DIMENSIONS: readonly {
  readonly className: BudgetTaskClass
  readonly dimension: 'MAX_TOKENS' | 'MAX_STEPS'
}[] = [
  { className: 'DECISION', dimension: 'MAX_TOKENS' },
  { className: 'DECISION', dimension: 'MAX_STEPS' },
  { className: 'SCREENING', dimension: 'MAX_TOKENS' },
  { className: 'SCREENING', dimension: 'MAX_STEPS' },
]

/** `${ENV_NAME}` 模板（整值形态；不做字符串内插值）。 */
const ENV_TEMPLATE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

/** 严格数字字面量（不接受空串 / 前后缀垃圾 / `0x` / 千分位）。 */
const NUMERIC_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

type MutableSources = Record<string, BudgetSource>

type ParsedLimit =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: 'not_a_number' | 'out_of_range' }

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/** 只用于 issue 文案；env 的值不进 issue（避免把注入值回显到模型/日志）。 */
function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function reasonText(reason: 'not_a_number' | 'out_of_range'): string {
  return reason === 'not_a_number'
    ? '不是数字'
    : '必须为 > 0 的有限数字（0 / 负数 / NaN / Infinity 非法；max_steps 最小为 1）'
}

/** 严格的额度数字解析（不产生 issue，调用方决定文案）。 */
function parseLimit(value: unknown): ParsedLimit {
  let numeric: number | undefined
  if (typeof value === 'number') {
    numeric = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '' && NUMERIC_LITERAL.test(trimmed)) numeric = Number(trimmed)
  }
  if (numeric === undefined) return { ok: false, reason: 'not_a_number' }
  if (!Number.isFinite(numeric) || numeric <= 0) return { ok: false, reason: 'out_of_range' }
  return { ok: true, value: numeric }
}

function normalizeClass(value: unknown): BudgetTaskClass | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toUpperCase()
  if (normalized === 'SCREENING' || normalized === 'DECISION') return normalized
  return undefined
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off' || normalized === '')
      return false
  }
  return undefined
}

/**
 * 展开 `${ENV_NAME}`（DESIGN §3.2 注释）。
 *
 * - 只有**整值模板** `'${NAME}'` 才展开；非模板（含普通字符串 / 数字）返回 `undefined`，由调用方走数字解析；
 * - 模板值必须是**数字字符串**且为 > 0 的有限数；env 未定义 / 空串 / 非数字 → issue 一条 + `undefined`；
 * - issue 文案只点名变量，**不回显环境变量的值**。
 */
export function expandBudgetEnvValue(
  value: unknown,
  key: string,
  env: Readonly<Record<string, string | undefined>>,
  issues: BudgetConfigIssues[],
): number | undefined {
  if (typeof value !== 'string') return undefined
  const match = ENV_TEMPLATE.exec(value.trim())
  if (!match) return undefined
  const envName = match[1] as string
  const envValue = env?.[envName]
  if (envValue === undefined || envValue.trim() === '') {
    issues.push({
      key,
      message: `${key}: 环境变量 ${envName} 未定义或为空（模板值 \${${envName}} 无法展开），已回退默认值`,
    })
    return undefined
  }
  const parsed = parseLimit(envValue)
  if (!parsed.ok) {
    issues.push({
      key,
      message: `${key}: 环境变量 ${envName} 不是合法数字（模板值 \${${envName}} 无法展开；${reasonText(parsed.reason)}），已回退默认值`,
    })
    return undefined
  }
  return parsed.value
}

function resolveLimit(
  className: BudgetTaskClass,
  dimension: 'MAX_TOKENS' | 'MAX_STEPS',
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): number {
  const key = `${className}_${dimension}`
  const fallback =
    dimension === 'MAX_TOKENS' ? DEFAULT_LIMITS[className].max_tokens : DEFAULT_LIMITS[className].max_steps
  const explicit = raw[key]

  // 1) profile 显式值（null = 未设置，落到 env / 默认）
  if (explicit !== undefined && explicit !== null) {
    const isTemplate = typeof explicit === 'string' && ENV_TEMPLATE.test(explicit.trim())
    if (isTemplate) {
      // expand 内部已对「未定义 / 非数字」各加一条 issue
      const expanded = expandBudgetEnvValue(explicit, key, env, issues)
      if (expanded !== undefined) {
        sources[key] = 'profile'
        return expanded
      }
      sources[key] = 'default'
      return fallback
    }
    const parsed = parseLimit(explicit)
    if (parsed.ok) {
      sources[key] = 'profile'
      return parsed.value
    }
    issues.push({
      key,
      message: `${key}: profile 显式值 ${describeValue(explicit)} 非法（${reasonText(parsed.reason)}），已回退默认值 ${fallback}`,
    })
    sources[key] = 'default'
    return fallback
  }

  // 2) env `RECRUITMENT_BUDGET_<CANONICAL_KEY>`
  const envName = `RECRUITMENT_BUDGET_${key}`
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = parseLimit(envValue)
    if (parsed.ok) {
      sources[key] = 'env'
      return parsed.value
    }
    issues.push({
      key,
      message: `${key}: 环境变量 ${envName} 非法（${reasonText(parsed.reason)}），已回退默认值 ${fallback}`,
    })
  }

  // 3) 默认值
  sources[key] = 'default'
  return fallback
}

function resolveTaskClass(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): BudgetTaskClass | 'AUTO' {
  const key = 'TASK_CLASS'
  const explicit = raw.task_class
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit === 'string' && explicit.trim().toUpperCase() === 'AUTO') {
      sources[key] = 'profile'
      return 'AUTO'
    }
    const normalized = normalizeClass(explicit)
    if (normalized !== undefined) {
      sources[key] = 'profile'
      return normalized
    }
    issues.push({
      key,
      message: `${key}: 未知任务类 ${describeValue(explicit)}（可选 AUTO | SCREENING | DECISION），已回退 AUTO`,
    })
    sources[key] = 'default'
    return 'AUTO'
  }

  const envName = 'RECRUITMENT_BUDGET_TASK_CLASS'
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    if (envValue.trim().toUpperCase() === 'AUTO') {
      sources[key] = 'env'
      return 'AUTO'
    }
    const normalized = normalizeClass(envValue)
    if (normalized !== undefined) {
      sources[key] = 'env'
      return normalized
    }
    issues.push({ key, message: `${key}: 环境变量 ${envName} 不是 AUTO | SCREENING | DECISION，已回退 AUTO` })
  }
  sources[key] = 'default'
  return 'AUTO'
}

function resolveDefaultClass(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): BudgetTaskClass {
  const key = 'DEFAULT_CLASS'
  const explicit = raw.default_class
  if (explicit !== undefined && explicit !== null) {
    const normalized = normalizeClass(explicit)
    if (normalized !== undefined) {
      sources[key] = 'profile'
      return normalized
    }
    issues.push({
      key,
      message: `${key}: 未知任务类 ${describeValue(explicit)}（可选 SCREENING | DECISION），已回退 SCREENING`,
    })
    sources[key] = 'default'
    return 'SCREENING'
  }

  const envName = 'RECRUITMENT_BUDGET_DEFAULT_CLASS'
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    const normalized = normalizeClass(envValue)
    if (normalized !== undefined) {
      sources[key] = 'env'
      return normalized
    }
    issues.push({ key, message: `${key}: 环境变量 ${envName} 不是 SCREENING | DECISION，已回退 SCREENING` })
  }
  sources[key] = 'default'
  return 'SCREENING'
}

function resolveStatusTool(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): boolean {
  const key = 'STATUS_TOOL'
  const explicit = raw.status_tool
  if (explicit !== undefined && explicit !== null) {
    const parsed = parseBoolean(explicit)
    if (parsed !== undefined) {
      sources[key] = 'profile'
      return parsed
    }
    issues.push({
      key,
      message: `${key}: 值 ${describeValue(explicit)} 不是布尔（true | false），已回退 false（D-128.2 工具数=30 默认关闭）`,
    })
    sources[key] = 'default'
    return false
  }

  const envName = 'RECRUITMENT_BUDGET_STATUS_TOOL'
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = parseBoolean(envValue)
    if (parsed !== undefined) {
      sources[key] = 'env'
      return parsed
    }
    issues.push({ key, message: `${key}: 环境变量 ${envName} 不是布尔（true | false），已回退 false` })
  }
  sources[key] = 'default'
  return false
}

/**
 * 预算闸门总开关 `enabled`（lead 2026-11-16 裁决，additive）。
 *
 * - profile 的 raw 值**只接受布尔**：字符串 `'true'` / `'false'` 一律视为非法（避免 YAML 引号
 *   把「关闭」静默变成「开启」或反之）；非法 → issue 一条 + 回退 `true`（fail-closed 到「开」并显式报错）。
 * - env `RECRUITMENT_BUDGET_ENABLED` 是环境变量注入面，值是字符串，按 `true|false|1|0|yes|no|on|off`
 *   解析（否则 env 层对布尔键永远不可用）；无法解析 → issue + 回退 `true`。
 * - 默认 `true`。
 */
function resolveEnabled(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): boolean {
  const key = 'ENABLED'
  const explicit = raw.enabled
  if (explicit !== undefined) {
    if (typeof explicit === 'boolean') {
      sources[key] = 'profile'
      return explicit
    }
    issues.push({
      key,
      message:
        `${key}: 值 ${describeValue(explicit)} 不是布尔（只接受 true | false；字符串 'true'/'false' 也视为非法），`
        + '已回退 true（预算保持开启并显式报 issue）',
    })
    sources[key] = 'default'
    return true
  }

  const envName = 'RECRUITMENT_BUDGET_ENABLED'
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    const parsed = parseBoolean(envValue)
    if (parsed !== undefined) {
      sources[key] = 'env'
      return parsed
    }
    issues.push({ key, message: `${key}: 环境变量 ${envName} 不是 true | false，已回退 true` })
  }
  sources[key] = 'default'
  return true
}

function resolveHandoffOwner(
  raw: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): string | null {
  const key = 'HANDOFF_OWNER'
  const handoff = asRecord(raw.handoff)
  // 冻结形状 = `handoff: { owner: ... }`；同时容忍扁平 `handoff_owner`（同一语义，便于单测/脚本注入）。
  const explicit = handoff.owner !== undefined && handoff.owner !== null ? handoff.owner : raw.handoff_owner
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit === 'string') {
      const trimmed = explicit.trim()
      if (trimmed === '') {
        sources[key] = 'default'
        return null
      }
      sources[key] = 'profile'
      return trimmed
    }
    issues.push({
      key,
      message: `${key}: handoff.owner 必须是字符串（null / 空串表示不覆盖），已忽略`,
    })
    sources[key] = 'default'
    return null
  }

  const envName = 'RECRUITMENT_BUDGET_HANDOFF_OWNER'
  const envValue = env?.[envName]
  if (envValue !== undefined && envValue.trim() !== '') {
    sources[key] = 'env'
    return envValue.trim()
  }
  sources[key] = 'default'
  return null
}

function resolveToolClassMap(
  raw: Record<string, unknown>,
  sources: MutableSources,
  issues: BudgetConfigIssues[],
): Record<string, BudgetTaskClass> {
  const key = 'TOOL_CLASS_MAP'
  // 默认映射始终是底座（覆盖是 merge，不是替换）
  const merged: Record<string, BudgetTaskClass> = { ...DEFAULT_TOOL_CLASS_MAP }
  const explicit = raw.tool_class_map
  if (explicit === undefined || explicit === null) {
    sources[key] = 'default'
    return merged
  }
  if (typeof explicit !== 'object' || Array.isArray(explicit)) {
    issues.push({
      key,
      message: `${key}: 必须是「工具名 → SCREENING | DECISION」的记录，已忽略并只使用默认映射`,
    })
    sources[key] = 'default'
    return merged
  }
  for (const [toolName, classValue] of Object.entries(explicit as Record<string, unknown>)) {
    if (toolName.trim() === '') {
      issues.push({ key, message: `${key}: 工具名不能为空，该覆盖已忽略` })
      continue
    }
    const normalized = normalizeClass(classValue)
    if (normalized === undefined) {
      issues.push({
        key,
        message: `${key}.${toolName}: 未知任务类 ${describeValue(classValue)}（可选 SCREENING | DECISION），该覆盖已忽略`,
      })
      continue
    }
    merged[toolName] = normalized
  }
  sources[key] = 'profile'
  return merged
}

/**
 * 解析 `config.budget`（扁平记录）为冻结的 `ResolvedBudgetConfig`。
 *
 * @param raw - profile 的 `config.budget` 段（未知/缺失一律按默认值处理）。
 * @param env - 环境变量表；缺省用 `process.env`（与 `src/tools/converter.ts` 既有约定一致，测试可注入）。
 * @returns 解析结果；非法值只进 `issues`，**从不抛异常**。
 */
export function resolveBudgetConfig(
  raw?: unknown,
  env?: Readonly<Record<string, string | undefined>>,
): ResolvedBudgetConfig {
  const rawRecord = asRecord(raw)
  const envRecord: Readonly<Record<string, string | undefined>> =
    env === undefined || env === null ? process.env : env
  const issues: BudgetConfigIssues[] = []
  const sources: MutableSources = {}

  const decTokens = resolveLimit('DECISION', 'MAX_TOKENS', rawRecord, envRecord, sources, issues)
  const decSteps = resolveLimit('DECISION', 'MAX_STEPS', rawRecord, envRecord, sources, issues)
  const scrTokens = resolveLimit('SCREENING', 'MAX_TOKENS', rawRecord, envRecord, sources, issues)
  const scrSteps = resolveLimit('SCREENING', 'MAX_STEPS', rawRecord, envRecord, sources, issues)

  const taskClass = resolveTaskClass(rawRecord, envRecord, sources, issues)
  const defaultClass = resolveDefaultClass(rawRecord, envRecord, sources, issues)
  const enabled = resolveEnabled(rawRecord, envRecord, sources, issues)
  const statusTool = resolveStatusTool(rawRecord, envRecord, sources, issues)
  const handoffOwner = resolveHandoffOwner(rawRecord, envRecord, sources, issues)
  const toolClassMap = resolveToolClassMap(rawRecord, sources, issues)

  const issuesCopy: BudgetConfigIssues[] = []
  for (const issue of issues) issuesCopy.push({ key: issue.key, message: issue.message })

  return {
    limits: {
      DECISION: { max_tokens: decTokens, max_steps: decSteps },
      SCREENING: { max_tokens: scrTokens, max_steps: scrSteps },
    },
    task_class: taskClass,
    default_class: defaultClass,
    tool_class_map: toolClassMap,
    status_tool: statusTool,
    enabled,
    handoff_owner: handoffOwner,
    sources,
    issues: issuesCopy,
  }
}
