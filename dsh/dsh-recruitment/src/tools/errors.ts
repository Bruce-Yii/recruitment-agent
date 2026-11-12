// 工具层错误。
//
// DSH 只对 HarnessError 实例保留结构化 error.info（docs/subsystems/tools.zh.md
// §执行:失败身份）。本插件无法 import @deepseek-ai/dsh-tools（见 CONTRACT.md §0
// 的实测报错），因此把稳定 code 直接写进 message 前缀：模型看到的失败内容为
// `Error: INVALID_ARGS: ...`，日志与模型看到的是同一个 code，不需要解析自然语言。
//
// 两代错误消息格式并存，且**各有出处**：
//   * 旧（stub 三工具）：散文，`CONTRACT.md` §2.2。
//   * 新（S6/S7 两工具）：`<CODE>: <compact-json>`，`contracts/job-screening/tool-contracts.md` §1.2。
//     该契约 §4 第 6 条要求"统一 or 明确记录例外"——本轮只让新工具用 JSON，
//     理由与回抄位置见 `README.md` §"错误格式"。

/** 本插件允许抛出的稳定错误码。 */
export type RecruitmentErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'READER_FAILED'
  | 'NOT_CONFIGURED'
  // S7 契约 §3.4 的另外两个（封闭集）。'INVALID_ARGS' / 'NOT_FOUND' 已在上面。
  | 'BLOCKED_BY_REVIEW'
  | 'NO_RUBRIC'

export class RecruitmentToolError extends Error {
  /** 稳定错误码（同时是 message 的前缀）。 */
  readonly code: RecruitmentErrorCode

  /**
   * @param code - 稳定错误码。
   * @param detail - 面向模型的细节（哪个参数错了、哪个 id 不存在）。
   */
  constructor(code: RecruitmentErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'RecruitmentToolError'
    this.code = code
  }
}
