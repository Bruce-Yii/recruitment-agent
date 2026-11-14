// vendored from dsh-superagent-prototype src/core/index.ts；改动：按 Notion 04 §08 的范围裁剪 —— 只导出
// Intake 去重/订阅分发所需的机制与 Port/模型参考层；Engine、Evals、Assignments、MemoryRepositories **不搬**
// （文档判定 core 不整体作为招聘 Domain Core；我们的领域对象是 Candidate/Application/Job/Interview，在 PG 里）。
/** 复用的机制与参考层：模型类型、Port 分层、Intake 去重与订阅分发、Ticket 订阅与回复。 */
export * from './model.ts'
export * from './ports.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { key } from './ids.ts'
export { Intake, type ReceiveResult } from './intake.ts'
export { Tickets } from './tickets.ts'
export { Replies, type Reply, type ReplyRequest } from './replies.ts'
export { EnginePart, type EngineOptions } from './part.ts'
