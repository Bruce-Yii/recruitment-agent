// 任务运行时的稳定错误码。
//
// 与 `src/tools/errors.ts` 同一约定：稳定 code 写进 message 前缀，日志/HTTP
// 响应/模型看到的是同一个 code，不解析自然语言。运行时错误**不吞**：事件路由
// 失败要落 `event_inbox.route_error`，任务派发失败要落 `task_attempt.error_*`。
export type RuntimeErrorCode =
  | 'INVALID_EVENT'
  | 'EVENT_STORE_FAILED'
  | 'EVENT_ROUTE_FAILED'
  | 'TASK_NOT_CLAIMABLE'
  | 'TASK_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'ATTEMPT_LEASE_CONFLICT'
  | 'WORKER_RUNTIME_NOT_CONFIGURED'
  | 'WORKER_SPAWN_FAILED'
  | 'WORKER_TIMEOUT'
  | 'WORKER_NO_FINAL'
  | 'WORKER_RESULT_UNPARSEABLE'
  | 'RUNTIME_NOT_ENABLED'

export class RuntimeError extends Error {
  /** 稳定错误码（同时是 message 的前缀）。 */
  readonly code: RuntimeErrorCode
  /** 可公开的结构化细节（不含密码等 secret）。 */
  readonly detail: Record<string, unknown>

  /**
   * @param code - 稳定错误码。
   * @param detail - 面向日志/调用方的细节。
   * @param extra - 结构化补充字段（可选）。
   */
  constructor(code: RuntimeErrorCode, detail: string, extra: Record<string, unknown> = {}) {
    super(`${code}: ${detail}`)
    this.name = 'RuntimeError'
    this.code = code
    this.detail = extra
  }
}

/** 把任意异常归一化成可写库的 `{ code, message }`（不泄露 secret）。 */
export function runtimeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof RuntimeError) {
    return { code: error.code, message: error.message.slice(0, 2000) }
  }
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code?: string }).code)
      : 'RUNTIME_ERROR'
    return { code, message: error.message.slice(0, 2000) }
  }
  return { code: 'RUNTIME_ERROR', message: String(error).slice(0, 2000) }
}
