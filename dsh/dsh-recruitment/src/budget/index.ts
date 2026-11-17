// ⚠️ 已撤回能力（D-140，2026-11-16）：产品**没有"预算"这回事**。
// 底座是 DSH，本身不计费/不限流；本目录的"token/步数超限拦工具"是总控自造，
// 产品负责人已裁决撤回。本模块**从未安装、也不允许再接线**（src/index.ts 已移除安装点）。
// 保留代码仅为历史参考 + 其纯逻辑单测；若真要复活，必须先在 docs/17 立新裁决。
// 成本/用量相关的产品能力 = **只做展示**（读 DSH 自带计量，见 src/http/display-usage.ts）。

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
