// 飞书 Minutes Connector 的唯一出口。
//
// 这里**不**注册任何 DSH 工具、**不**改 `src/index.ts`（R2 接线归 W0/子代理 A）：
// 本模块只是一组可被 import 的契约、标签与骨架，真实 LIVE Gate = BLOCKED。
// 显式逐个导出（不用 `export *`），新增导出必须在这里写名字，避免两个文件
// 同名导出时悄悄变成「谁先谁赢」。
export {
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_PROVIDER,
  FEISHU_MINUTES_LIVE_GATE,
  FEISHU_MINUTES_ENDPOINTS,
  FEISHU_MINUTES_ENDPOINT_NOTES,
  FEISHU_LARK_CLI,
  FEISHU_LARK_CLI_NOTE,
  FEISHU_MINUTES_PAGINATION,
  FEISHU_MINUTES_PAGINATION_FIELDS,
  FEISHU_MINUTES_DEFAULT_PAGE_SIZE,
  FEISHU_MINUTES_SCOPES,
  FEISHU_MINUTES_EVENTS,
  FEISHU_MINUTES_EVENT_NOTES,
  FEISHU_PROVIDER_ERRORS,
  FEISHU_PROVIDER_ERROR_NOTES,
  FEISHU_TRANSPORT,
  readNonEmptyString,
  hasEventTriggerEvidence,
  buildBindingKey,
  isPageComplete,
  mapFeishuError,
} from './contract.ts'

export type {
  FeishuMinutesEndpointKey,
  FeishuEventIdentity,
  FeishuEventNote,
  FeishuTaskState,
  FeishuProviderErrorKind,
  FeishuProviderErrorRule,
  FeishuProviderError,
  FeishuMinutesEventEnvelope,
  FeishuTranscriptBindingKey,
  FeishuBindingKeyFailure,
  FeishuBindingKeyResult,
  FeishuPageLike,
  FeishuTransport,
} from './contract.ts'

export {
  LABEL_DISHONEST_LIVE,
  REQUEST_BODY_IS_TRANSCRIPT,
  buildConnectorLabels,
  buildArtifactLabelsFromReadback,
  isLiveEligible,
  liveEligibilityViolations,
  triggerModeForEvent,
} from './labels.ts'

export type {
  Provenance,
  Trigger,
  Connection,
  ThreeAxisLabels,
  ProvenanceBasis,
  ConnectorLabelInput,
  ConnectorLabelResult,
  TranscriptReadbackLike,
  ConnectorEventLike,
} from './labels.ts'

export {
  FEISHU_DEFAULT_ENV,
  createFeishuMinutesAdapter,
} from './adapter.ts'

export type {
  FeishuAdapterConfig,
  FeishuCredentialPresence,
  FeishuAdapterDescription,
  FeishuProbeBlockedReason,
  FeishuProbeResult,
  FeishuTranscriptRequest,
  FeishuTranscriptRequestedFlags,
  FeishuTranscriptInvalidArgs,
  FeishuTranscriptBlocked,
  FeishuTranscriptBlockedReason,
  FeishuTranscriptBlockedErrorCode,
  FeishuTranscriptRead,
  FeishuTranscriptWaitingExternal,
  FeishuTranscriptResult,
  FeishuSubscriptionNote,
  FeishuSubscriptionNotes,
  FeishuMinutesAdapter,
} from './adapter.ts'

// 传输层（`lark-cli-transport`）。**默认不装配**：只有显式注入 runner 才会真去调 CLI。
export {
  FEISHU_CLI_TRANSPORT_ID,
  FEISHU_CLI_DEFAULT_TIMEOUT_MS,
  FEISHU_CLI_DEFAULT_MAX_ATTEMPTS,
  FEISHU_CLI_DEFAULT_RETRY_BASE_MS,
  FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES,
  FEISHU_CLI_DEFAULT_MAX_PAGES,
  FEISHU_CLI_TRANSCRIPT_FLAGS,
  FEISHU_CLI_TRANSCRIPT_FLAGS_NOTE,
  FEISHU_CLI_ENVELOPE_NOTE,
  FeishuTransportError,
  buildTranscriptArgs,
  buildReadReceipt,
  createLarkCliTransport,
  createProcessCliRunner,
  extractProviderCode,
  isoWithOffset,
  readbackTransport,
  sanitizeDiagnostic,
  sha256Hex,
} from './transport.ts'

export type {
  FeishuCliInvocation,
  FeishuCliRunResult,
  FeishuCliRunStatus,
  FeishuCliRunner,
  FeishuCliTranscriptReadback,
  FeishuDiagnostic,
  FeishuLarkCliTransportConfig,
  FeishuMinutesTranscriptTransport,
  FeishuProcessCliRunnerConfig,
  FeishuTransportDescription,
  FeishuTransportErrorCode,
  FeishuTransportReadResult,
  FeishuTransportStage,
} from './transport.ts'

