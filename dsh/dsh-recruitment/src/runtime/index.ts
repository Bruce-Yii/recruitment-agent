// 任务运行时的公共出口。
//
// 分层：
//   config.ts        插件 `runtime` 段解析（默认关闭、缺配置列 issues）
//   routing.ts       事件 → 业务对象 → Task 的确定性路由 + 语义准入 Gate
//   store.ts         PG 读写（事件幂等 / 唤醒 / 三层身份 / 租约回收）
//   event-runtime.ts 事件到达 → 验源 → 去重 → 定位 → 建/唤醒 Task
//   worker.ts        DSH headless Worker Session 启动器（独立进程 + NDJSON）
//   task-runtime.ts  Attempt 认领 / Session 登记 / 结果回写 / 恢复
//   router.ts        Router.tick：事件 → Attempt → Worker → Task
//   http.ts          回环 + 同源的 HTTP 入口（默认不注册）
export { resolveRuntimeConfig } from './config.ts'
export type { ResolvedRuntimeConfig, RuntimeConfig } from './config.ts'
export { EventRuntime, eventRowToInbound, validateInboundEvent } from './event-runtime.ts'
export type { EventRuntimeOptions } from './event-runtime.ts'
export { RuntimeError, runtimeFailure } from './errors.ts'
export type { RuntimeErrorCode } from './errors.ts'
export { registerRuntimeHttp } from './http.ts'
export type { RuntimeHostContext, RuntimeHttpOptions } from './http.ts'
export { Router, composeRuntime } from './router.ts'
export type { ComposeRuntimeOptions, ComposedRuntime, RouterOptions } from './router.ts'
export {
  DefaultSemanticGate,
  canonicalJson,
  decideRoute,
  idempotencyFor,
  normalizeEventType,
  resolveBusinessObject,
  ROUTER_ONLY_TASK_TYPES,
  taskIdempotencyKey,
} from './routing.ts'
export type { SemanticGateResult } from './routing.ts'
export { RuntimeStore } from './store.ts'
export type {
  EventRow,
  FinishAttemptInput,
  FinishAttemptResult,
  InsertEventResult,
  RecoveredAttempt,
  RuntimeStoreOptions,
  TaskClaim,
} from './store.ts'
export { TaskRuntime } from './task-runtime.ts'
export type { DispatchResult, TaskRuntimeOptions } from './task-runtime.ts'
export type {
  AgentSessionRecord,
  AttemptStatus,
  BusinessObjectRef,
  BusinessObjectType,
  BusinessTaskRecord,
  EventDispatchState,
  EventReceiveResult,
  InboundEvent,
  RouteDecision,
  TaskAttemptRecord,
  TaskErrorClass,
  TaskRuntimeView,
  TaskStatus,
  TaskWakeupRecord,
  TickReceipt,
  TrustLevel,
  WorkerLauncher,
  WorkerOutcome,
  WorkerTaskRequest,
} from './types.ts'
export { buildWorkerPrompt, DshHeadlessWorkerLauncher, extractJsonObject, parseWorkerEvents } from './worker.ts'
export type { DshWorkerConfig } from './worker.ts'
