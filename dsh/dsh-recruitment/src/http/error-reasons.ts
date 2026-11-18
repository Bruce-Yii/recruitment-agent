// V6-2：终态失败任务的「人话原因」后端映射（纯函数，无 DB / 无前端依赖）。
//
// 语义（写死在这里，不在调用处分支）：
//   · 只有 error_class ∈ HUMAN_ERROR_CLASSES 的终态失败任务才算「需要人处理」；
//     WORKER_LOST / TIMEOUT / TRANSIENT（重试耗尽）**不算**——要么已自动重试、要么是环境抖动，
//     塞进人工队列只会制造噪音。
//   · error_code → 人话给 HR 看，绝不暴露机器码；未知 code 给通用兜底人话。
//   · 本模块只做「判定 + 翻译」，不碰 Task 状态机（FAILED 保持 FAILED，它是真相），
//     只供 `src/http/overview.ts` 构造读模型里的可选 `reason` 字段。
//
// 本文件可被单测直接导入（test/unit/v62-error-reasons.test.ts），不需要数据库。

/**
 * 需要人处理的 error_class 闭集。
 *
 * 与 `db/migrations/0001_init.sql::ck_task_attempt_error_class` 的 8 个取值对照：
 *   - 纳入：PERMANENT / INVALID_INPUT / AUTH_REQUIRED / BUSINESS_CONFLICT
 *   - 排除：TRANSIENT / WAIT_EXTERNAL / UNKNOWN_OUTCOME / WORKER_LOST
 *     （TIMEOUT 在库里表现为 attempt.status='TIMED_OUT'，不在这个集合里；
 *      它和 TRANSIENT 一样：环境抖动/已重试，不进人工队列）
 */
export const HUMAN_ERROR_CLASSES: readonly string[] = [
  'PERMANENT',
  'INVALID_INPUT',
  'AUTH_REQUIRED',
  'BUSINESS_CONFLICT',
]

/** 判据：终态失败 attempt 的 error_class 是否属于「需要人处理」闭集。 */
export function needsHuman(errorClass: string | null | undefined): boolean {
  if (typeof errorClass !== 'string') return false
  return HUMAN_ERROR_CLASSES.includes(errorClass.toUpperCase())
}

/** 人话兜底：未知/缺失 error_code 时用，既不暴露机器码也不假装知道原因。 */
export const GENERIC_FAILURE_REASON = '这次没能完成，需要你看看'

/** 已知 error_code → 人话（HR 视角；不含错误码、字段名、表名）。 */
const ERROR_REASONS: Readonly<Record<string, string>> = {
  UNKNOWN_MODEL: '模型配置不正确，这次没能读出来',
  INVALID_INPUT: '这个文件没法处理',
  AUTH_REQUIRED: '外部账号未就绪',
  BUSINESS_CONFLICT: '和已有事实冲突，需要你确认',
}

/**
 * error_code → 人话原因。
 *
 * 规则：
 *   - 先按 code 原样命中；未命中再忽略大小写重试一次（兼容历史大小写写法）；
 *   - 空值/未知 code 一律给通用兜底人话；
 *   - 返回值永不为空串、永不含机器码原文。
 */
export function humanizeFailureReason(errorCode: string | null | undefined): string {
  if (typeof errorCode !== 'string' || errorCode.trim() === '') return GENERIC_FAILURE_REASON
  const exact = ERROR_REASONS[errorCode]
  if (exact !== undefined) return exact
  const upper = errorCode.trim().toUpperCase()
  return ERROR_REASONS[upper] ?? GENERIC_FAILURE_REASON
}
