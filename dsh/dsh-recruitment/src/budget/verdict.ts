// task-78 / DESIGN §3.5：预算判定（纯函数，零副作用）。
//
// 判定规则（冻结，单测钉死）：
//   * `tokens.total > max_tokens` 或 `steps > max_steps` → `within = false`；
//   * **等于阈值仍算 within**（`<=`）；
//   * `over` 数组顺序固定：`tokens` 在前、`steps` 在后。
//
// 本文件不读配置、不读 usage、不抛异常；调用方（tracker / guard）负责提供输入。
import type {
  BudgetLimits,
  BudgetSnapshot,
  BudgetTaskClass,
  BudgetTokenBuckets,
  BudgetUsageSource,
} from './types.ts'

/** 按固定口径把「本次事实 + 额度」判成一份快照。 */
export function evaluateBudget(input: {
  readonly task_class: BudgetTaskClass
  readonly limits: BudgetLimits
  readonly tokens: BudgetTokenBuckets
  readonly steps: number
  readonly usage_source: BudgetUsageSource
  readonly dsh_step: number | null
  readonly last_tool: string | null
  readonly tools_used: Readonly<Record<string, number>>
  readonly session_id: string
  readonly task_class_source: 'auto' | 'configured'
}): BudgetSnapshot {
  const over: { dimension: 'tokens' | 'steps'; used: number; limit: number }[] = []
  if (input.tokens.total > input.limits.max_tokens) {
    over.push({ dimension: 'tokens', used: input.tokens.total, limit: input.limits.max_tokens })
  }
  if (input.steps > input.limits.max_steps) {
    over.push({ dimension: 'steps', used: input.steps, limit: input.limits.max_steps })
  }
  return {
    session_id: input.session_id,
    task_class: input.task_class,
    task_class_source: input.task_class_source,
    tokens: input.tokens,
    steps: input.steps,
    dsh_step: input.dsh_step,
    limits: input.limits,
    usage_source: input.usage_source,
    last_tool: input.last_tool,
    tools_used: input.tools_used,
    over,
    within: over.length === 0,
  }
}
