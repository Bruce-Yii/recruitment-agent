// 邮件连接器唯一出口（rec/31 §4.1/§4.2）。
// 本模块只 re-export，不注册 DSH 工具、不改 src/index.ts（接线归工具 B/C）。
// 显式逐个导出（不用 export *），避免同名导出互相遮蔽。

// contract.ts：传输契约 / 错误 / 配置解析
export {
  MailTransportError,
  mailSummary,
  resolveMailConfig,
  MAIL_SUMMARY_MAX_CHARS,
  MAIL_DEFAULT_PASSWORD_ENV,
  MAIL_DEFAULT_SINCE_DAYS,
} from './contract.ts'
export type {
  MailKind,
  SmtpKind,
  MailEnvelope,
  RawMailAttachment,
  RawMailMessage,
  MailTransport,
  ListNewInput,
  MailConfigInput,
  MailConfig,
  MailEnvMap,
} from './contract.ts'

// transport.ts：IMAP 收件
export {
  createImapTransport,
  classifyImapError,
  imapSinceDate,
  imapSearchCriteria,
  selectNewestUids,
  envelopeHeaders,
  classifyConnectError,
  isAmbiguousImapError,
  realTcpProbe,
  MAIL_TCP_PROBE_TIMEOUT_MS,
  __setImapFlowCtorForTest,
  __setTcpProbeForTest,
  type TcpProbe,
  MAIL_LIST_DEFAULT_LIMIT,
  MAIL_LIST_HARD_LIMIT,
} from './transport.ts'

// parse.ts：收件解析（mailparser + 安全化 + sha256）
export {
  parseRawMail,
  rawBytesOf,
  safeMailFileName,
  MAIL_ATTACHMENT_MAX_BYTES,
  MAIL_FILENAME_MAX_CHARS,
} from './parse.ts'
export type {
  ParsedAttachment,
  SkippedAttachment,
  ParsedMailSummary,
  ParsedMail,
} from './parse.ts'

// orchestrator.ts：收件 → intake 编排
export { fetchAndIngest, resolveTempRoot, makeJobResolver } from './orchestrator.ts'
export type {
  MailJobDecision,
  MailJobResolutionContext,
  FetchAndIngestInput,
  FetchAndIngestDeps,
  FetchAndIngestResult,
  EmailFetchResult,
  EmailFetchMessageResult,
  EmailAttachmentResult,
} from './orchestrator.ts'

// smtp.ts：发信传输 + 脱敏 + 分类
export {
  createSmtpTransport,
  classifySmtpError,
  redactSmtpDiagnostic,
  isSmtpKind,
  smtpTransportOptions,
} from './smtp.ts'
export type {
  MailConfig as SmtpMailConfig,
  SmtpConfig,
  SmtpSendInput,
  SmtpSendResult,
  SmtpTransport,
} from './smtp.ts'

// match.ts：自动分岗（精确编码 → 唯一标题，fail-closed + unmatched_reason）
export {
  resolveJobForMail,
  extractJobCodeTokens,
  normalizeJobTitle,
  toJobCandidates,
} from './match.ts'
export type { MailJobCandidate, JobMatchResult } from './match.ts'

// poll.ts：后台定时轮询（显式 env 启用；注入 timer/lock，可停止/清理）
export {
  MAIL_POLL_INTERVAL_ENV,
  resolvePollIntervalMs,
  createMailLock,
  createImapPoller,
} from './poll.ts'
export type {
  PollTimer,
  MailAsyncLock,
  PollTickResult,
  ImapPollerDeps,
  ImapPoller,
} from './poll.ts'

// job-lookup.ts：只读在招岗位（自动分岗用）
export { listOpenJobs, OPEN_JOB_STATUS } from './job-lookup.ts'

// durable-effect.ts：发信副作用 + 授权判定
export {
  enqueueEmailSend,
  claimPendingEffects,
  listSentForReadback,
  advanceEffect,
  resolveEmailAuthorization,
  emailEffectIdempotencyKey,
  mailBodySummary,
  buildEmailEffectPayload,
} from './durable-effect.ts'
export type {
  EffectStatus,
  EffectReadbackState,
  EnqueueEmailSendInput,
  EnqueueEmailSendResult,
  ClaimedEffect,
  EffectAdvancePatch,
  EffectAdvanceResult,
  EmailAuthorizationConfigLike,
  EmailAuthorizationInput,
  EmailAuthorizationDecision,
} from './durable-effect.ts'
