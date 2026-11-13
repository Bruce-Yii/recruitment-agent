// U2 恢复层入口。plan() 是纯函数：只生成计划，不调模型、不渲染、不写库。
// executePlan() 是计划执行器：只通过调用方注入的能力动作；human_review 永不自动执行。

export type {
  HumanPayload,
  PlanOptions,
  RecoveryPlan,
  RecoveryStep,
  RecoverySummary,
  ResponsibilityRole,
  RetryPayload,
  SwitchReaderPayload,
  VisionPageRequest,
  VisionRender,
} from './types.ts'

export { plan } from './plan.ts'

export type {
  ExecutePlanOptions,
  ExecutePlanResult,
  RecoveryBlockingSnapshot,
  RecoveryCapabilities,
  RecoveryExecutionStatus,
  RecoveryStepResult,
} from './execute.ts'

export { executePlan } from './execute.ts'
