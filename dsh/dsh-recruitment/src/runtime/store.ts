// 任务运行时 PostgreSQL 读写层的公共出口（**薄 barrel**，零逻辑）。
//
// G12 等价拆分（2026-11-15）：实现按职责搬进 `store/{readback,events,claim,lease,
// recovery,counts,index}.ts`；本文件只 re-export，保证所有既有导入路径
// （`./store.ts`）不变。SQL、错误码、事务语义与拆分前逐字一致。
export { RuntimeStore } from './store/index.ts'
export type {
  EventRow,
  FinishAttemptInput,
  FinishAttemptResult,
  InsertEventResult,
  RecoveredAttempt,
  RuntimeStoreOptions,
  TaskClaim,
} from './store/index.ts'
