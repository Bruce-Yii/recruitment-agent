// task-78 / DESIGN §3.9：预算模块唯一公共入口。
//
// 只做 re-export，零副作用、零逻辑。宿主接线（`src/index.ts`）只从这里 import，
// 保证模块内部文件可自由重构而对外导出面冻结。
export * from './types.ts'
export * from './usage.ts'
export { DEFAULT_LIMITS, DEFAULT_TOOL_CLASS_MAP, expandBudgetEnvValue, resolveBudgetConfig } from './config.ts'
export { BudgetTracker } from './tracker.ts'
export { evaluateBudget } from './verdict.ts'
export { BUDGET_EXCEEDED_HANDOFF, buildHandoffText } from './handoff.ts'
export { evaluateToolCall, installBudgetGuard } from './guard.ts'
export { createBudgetStatusTool } from './status-tool.ts'
export type { BudgetGuardHooks, BudgetGuardRuntime } from './guard.ts'
export type { HandoffInput } from './handoff.ts'
export type { ToolDefinitionLike } from './status-tool.ts'
export type { BudgetTrackerOptions } from './tracker.ts'
