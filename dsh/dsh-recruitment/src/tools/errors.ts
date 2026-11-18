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

/**
 * 「未绑定身份」的人话引导（O4）。
 *
 * 为什么放在这里：Demo Actor 解析（`src/demo-actor/**`）与 HTTP 各 `errorResponse` 都要说
 * 同一句话 —— 两处各写一份，措辞迟早漂移。**只补面向人的 message**；
 * `code` / `reason_code` / `session_id` 等机检字段一个都不动（排障仍按原字段）。
 */
export const ACTOR_UNBOUND_HUMAN_HINT =
  '请先在招聘工作台顶部选择身份（Recruiter / Interviewer A / B），再操作。'

/** 本插件允许抛出的稳定错误码。 */
export type RecruitmentErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'READER_FAILED'
  | 'NOT_CONFIGURED'
  // 配了但凭据/授权码不对（IMAP 认证失败）。与 NOT_CONFIGURED 严格区分：
  // NOT_CONFIGURED = 压根没配（缺 host/user/password_env/端口/tls 等，注册替身）；
  // AUTH_REQUIRED = 配置齐全但账号/授权码被拒（fail-closed，零写入，如实渲染 connection=AUTH_REQUIRED）。
  // 原为 email-fetch.ts 的局部 MailAuthError；本轮收编进共享闭集，统一用 RecruitmentToolError 构造。
  | 'AUTH_REQUIRED'
  // NOT_CONNECTED = 连接层不可用（网络/服务不可达）；与 AUTH_REQUIRED（凭据被拒）区分，同样 fail-closed 零写入。
  | 'NOT_CONNECTED'
  // S7 契约 §3.4 的另外两个（封闭集）。'INVALID_ARGS' / 'NOT_FOUND' 已在上面。
  | 'BLOCKED_BY_REVIEW'
  | 'NO_RUBRIC'
  // D5 Demo Actor（`work/d5/ACTOR-CONTRACT.md` §3）：执行上下文里拿不到
  // session → alias → HUMAN actor 的完整映射时**拒绝写入**（不回退 `config.actor_id`）。
  | 'DEMO_ACTOR_UNMAPPED'

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
