// 飞书 Minutes Connector 的唯一出口。
//
// 这里**不**注册任何 DSH 工具、**不**改 `src/index.ts`（R2 接线归 W0/子代理 A）：
// 本模块只是一组可被 import 的契约、标签、传输层与骨架。
//
// **LIVE Gate 不是一个写死的常量**：`FEISHU_LIVE_GATE_POLICY` 只是口径名
// （`EVIDENCE_DRIVEN`），每次读取由 `evaluateLiveGate(readback)` 按证据算出
// `LIVE | BLOCKED`。缺任何一项证据就不是 LIVE，且违规列表会点名缺什么。
// 显式逐个导出（不用 `export *`），新增导出必须在这里写名字，避免两个文件
// 同名导出时悄悄变成「谁先谁赢」。
export {
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_PROVIDER,
  FEISHU_LIVE_GATE_POLICY,
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
  FeishuLiveGatePolicy,
  FeishuLiveGateState,
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
  LIVE_EVIDENCE_ITEMS,
  LIVE_READBACK_PROVENANCE_BASIS,
  REQUEST_BODY_IS_TRANSCRIPT,
  buildConnectorLabels,
  buildArtifactLabelsFromReadback,
  evaluateLiveGate,
  isLiveEligible,
  liveEligibilityViolations,
  liveGateEvidence,
  parseReadReceipt,
  readbackConsistencyViolations,
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
  ParsedReadReceipt,
  LiveEvidenceItem,
  LiveGateEvidence,
  LiveGateDecision,
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

// 接线层：**唯一**允许把插件配置翻译成「适配器 + 传输层」的地方。
// 只有 `feishu.cli`（绝对路径）才会装配传输层；不给 = 默认态（不碰任何进程）。
export { resolveFeishuConnector } from './wiring.ts'

export type {
  FeishuConnectorConfig,
  FeishuConnectorDependency,
  ResolvedFeishuConnector,
} from './wiring.ts'

