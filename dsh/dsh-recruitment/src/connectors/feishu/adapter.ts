// 飞书 Minutes Connector 适配器：授权检查 + 传输层装载 + 错误映射 + 三维标签 + 阻断语义。
//
// 传输层**已实现**（`transport.ts` 的 `lark-cli-transport`），但**不默认装配**：
// 本文件不 import 任何子进程模块，只有调用方显式注入 `transport` 才会发起外部
// 调用。理由有两条，都不是洁癖：
//   * `AGENTS.md §7.6` 禁止把「开发者全局 CLI profile」当产品连接器凭据，
//     所以 CLI 必须由调用方用绝对路径显式配置，不能悄悄调用 PATH 上的 `lark-cli`；
//   * 默认态没有任何外部读取，也就没有任何 LIVE 证据。
//
// **LIVE 由证据算出，不是一个全局开关**：`fetchTranscript()` 读到正文后调用
// `evaluateLiveGate()` 逐项核对回读证据（平台通道 / 回执 `@sha256:` /
// content_sha256 与 raw_text 重算一致 / 重读哈希 / 带偏移 fetched_at /
// is_complete / 非空正文 / MANUAL|EVENT）。全齐 → `provenance=LIVE`、
// `connection=CONNECTED`；缺任何一项 → `FIXTURE`、`live_eligible=false`，并把
// **缺哪一项**逐条放进 `live_gate_violations`（不压平成「Gate 没开」）。
//
// `fetchTranscript()` 有四种出口：
//   * `ERROR / INVALID_ARGS`：缺 `minute_token`；
//   * `BLOCKED`：凭据/传输层/读取任何一环不成立，带 `blocked_reason` 说清是哪一环；
//     回读对象**自相矛盾**（哈希不一致）也在这里失败（`READBACK_INVALID`，
//     回读不一致是失败，不是警告）；
//   * `WAITING_EXTERNAL`：平台说 `2091003`（生成中），不是失败（TR-F1）；
//   * `READ`：读到了正文；标签由 `evaluateLiveGate()` 算，可能在证据齐全时 LIVE。
//
// 三个必须记住的口径：
//   * `2091003` 生成中 → `WAITING_EXTERNAL`，不建 artifact；`2091005` 无权限 →
//     `WAITING_HUMAN` + `AUTH_REQUIRED`，不建 artifact（见 `contract.ts`）；
//   * `minutes.minute.generated_v1` 是 **user identity** 订阅，应用凭据不够，
//     缺用户令牌就是 `AUTH_REQUIRED`，不是 `NOT_CONNECTED` 也不是 `CONNECTED`；
//   * 令牌「存在」不等于「有效」：`probe()` 永远不把令牌存在当作 CONNECTED，
//     只有一次证据齐全的真实回读才在 `READ` 出口给 `CONNECTED`。
import {
  FEISHU_LIVE_GATE_POLICY,
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_MINUTES_EVENT_NOTES,
  mapFeishuError,
  readNonEmptyString,
  type FeishuLiveGatePolicy,
  type FeishuLiveGateState,
  type FeishuProviderError,
} from './contract.ts'
import {
  LIVE_EVIDENCE_ITEMS,
  buildConnectorLabels,
  evaluateLiveGate,
  readbackConsistencyViolations,
  type Connection,
  type LiveEvidenceItem,
  type ProvenanceBasis,
  type ThreeAxisLabels,
} from './labels.ts'
import {
  FEISHU_CLI_TRANSPORT_ID,
  FeishuTransportError,
  type FeishuCliTranscriptReadback,
  type FeishuMinutesTranscriptTransport,
} from './transport.ts'

/** 默认环境变量名。**只读存在性，不读也不打印值**（R7）。 */
export const FEISHU_DEFAULT_ENV = {
  app_id: 'FEISHU_APP_ID',
  app_secret: 'FEISHU_APP_SECRET',
  user_access_token: 'FEISHU_USER_ACCESS_TOKEN',
  tenant_access_token: 'FEISHU_TENANT_ACCESS_TOKEN',
} as const

/** 适配器配置。`env` 缺省为 `process.env`，测试可注入只读副本。 */
export interface FeishuAdapterConfig {
  /** 环境变量源；只用来判存在性。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 应用 ID；可直接给，也可从 `app_id_env`（默认 `FEISHU_APP_ID`）读。 */
  readonly app_id?: string
  /** App Secret 的变量名，默认 `FEISHU_APP_SECRET`。 */
  readonly app_secret_env?: string
  /** 用户访问令牌的变量名，默认 `FEISHU_USER_ACCESS_TOKEN`。 */
  readonly user_access_token_env?: string
  /** 租户访问令牌的变量名，默认 `FEISHU_TENANT_ACCESS_TOKEN`。 */
  readonly tenant_token_env?: string
  /**
   * 传输层。**默认不装配**（见文件头注）：想真读就显式注入
   * `createLarkCliTransport({ runner: createProcessCliRunner({ command }) })`。
   * 不注入时 `fetchTranscript()` 只会返回 `BLOCKED / TRANSPORT_NOT_CONFIGURED`，
   * 绝不拉起任何进程。
   */
  readonly transport?: FeishuMinutesTranscriptTransport
}

/** 凭据存在性（**只有布尔**，绝不带值）。 */
export interface FeishuCredentialPresence {
  readonly app_id_present: boolean
  readonly app_secret_present: boolean
  readonly user_token_present: boolean
  readonly tenant_token_present: boolean
}

/** `describe()` 的返回。 */
export interface FeishuAdapterDescription {
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly contract_version: string
  /** 本适配器**做到**的事。 */
  readonly implemented: readonly string[]
  /** 本适配器**没做**的事。 */
  readonly not_implemented: readonly string[]
  /** Gate 口径名（不是开关）：`EVIDENCE_DRIVEN`，每次读取按证据算 LIVE/BLOCKED。 */
  readonly live_gate: FeishuLiveGatePolicy
  /** LIVE 需要的证据项（机器可读；缺一项就不会 LIVE）。 */
  readonly live_gate_evidence: readonly LiveEvidenceItem[]
}

/** `probe()` 的阻断原因（闭集）。 */
export type FeishuProbeBlockedReason = 'NO_APP_CREDENTIALS' | 'USER_IDENTITY_REQUIRED' | 'TOKEN_PRESENT_UNVERIFIED'

/** `probe()` 的返回。`labels.provenance` / `connection` 恒非 LIVE/CONNECTED。 */
export interface FeishuProbeResult {
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly contract_version: string
  readonly connection_state: Connection
  readonly labels: ThreeAxisLabels
  readonly provenance_basis: 'NO_LIVE_READ'
  readonly live_eligible: false
  readonly blocked_reason: FeishuProbeBlockedReason
  /** 还缺的环境**变量名**（不是值）。 */
  readonly missing: readonly string[]
  /** 下一步该做什么（人读）。 */
  readonly next_steps: readonly string[]
  readonly credentials: FeishuCredentialPresence
  /** 传输层有没有被显式装配（只有布尔）。 */
  readonly transport_configured: boolean
  /** 仅在 `TOKEN_PRESENT_UNVERIFIED` 时出现：为什么还不能算连上。 */
  readonly note?: string
}

/** `fetchTranscript()` 的入参。两个字段都只判存在性，不回显。 */
export interface FeishuTranscriptRequest {
  readonly minute_token?: unknown
  readonly external_meeting_id?: unknown
}

/** 请求字段存在性（只有布尔）。 */
export interface FeishuTranscriptRequestedFlags {
  readonly minute_token_present: boolean
  readonly external_meeting_id_present: boolean
}

/**
 * `fetchTranscript()` 的阻断原因（闭集，逐个说明含义；新增必须写进 README）：
 *   * `NO_APP_CREDENTIALS` —— 连应用凭据都没有；
 *   * `USER_IDENTITY_REQUIRED` —— 缺用户令牌（妙记事件是 user identity）；
 *   * `TOKEN_PRESENT_UNVERIFIED` —— 令牌在，但还没有一次真实成功的回读；
 *   * `TRANSPORT_NOT_CONFIGURED` —— 传输层没装配（本机默认状态）。
 *   * `CLI_UNAVAILABLE` —— 装配了但找不到/起不来 CLI（locate-cli 失败）；
 *   * `CLI_TIMEOUT` —— CLI 调用超时，重试也超时；
 *   * `CLI_FAILED` —— CLI 非零退出且诊断里没有已核对错误码；
 *   * `PROVIDER_NO_PERMISSION` —— 平台 2091005，需要人重新授权；
 *   * `READ_PARSE_FAILED` —— 输出信封/落盘文件形状不认识（fail-closed）；
 *   * `PAGINATION_INCOMPLETE` —— 保留值：`+detail` 是整文件写盘、没有分页；
 *     未来接 `+search` 分页传输时才可能用到；
 *   * `READBACK_INVALID` —— 回执、重读校验、落盘正文自检不过（含重读哈希不一致）。
 */
export type FeishuTranscriptBlockedReason =
  | 'NO_APP_CREDENTIALS'
  | 'USER_IDENTITY_REQUIRED'
  | 'TOKEN_PRESENT_UNVERIFIED'
  | 'TRANSPORT_NOT_CONFIGURED'
  | 'CLI_UNAVAILABLE'
  | 'CLI_TIMEOUT'
  | 'CLI_FAILED'
  | 'PROVIDER_NO_PERMISSION'
  | 'READ_PARSE_FAILED'
  | 'PAGINATION_INCOMPLETE'
  | 'READBACK_INVALID'

/** 阻断结果里允许出现的 `error_code`（闭集）。 */
export type FeishuTranscriptBlockedErrorCode = 'AUTH_REQUIRED' | 'NOT_CONNECTED' | 'READ_FAILED'

/** 参数不合法时的返回（形状稳定，不抛异常也能判）。 */
export interface FeishuTranscriptInvalidArgs {
  readonly kind: 'ERROR'
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly error_code: 'INVALID_ARGS'
  readonly reason_code: 'MINUTE_TOKEN_REQUIRED'
  readonly connection_state: Connection
  readonly labels: ThreeAxisLabels
  readonly creates_artifact: false
  readonly message: string
  readonly requested: FeishuTranscriptRequestedFlags
}

/** 被阻断时的返回：**没有正文**、**没有 artifact**、只有为什么与还差什么。 */
export interface FeishuTranscriptBlocked {
  readonly kind: 'BLOCKED'
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly connection_state: Connection
  readonly labels: ThreeAxisLabels
  readonly creates_artifact: false
  readonly error_code: FeishuTranscriptBlockedErrorCode
  /** 具体卡在哪一环（闭集，见 `FeishuTranscriptBlockedReason`）。 */
  readonly blocked_reason: FeishuTranscriptBlockedReason
  readonly message: string
  readonly requested: FeishuTranscriptRequestedFlags
  /** 传输层失败时的阶段/机器码（只有 `transport` 失败才会有）。 */
  readonly failure?: { readonly stage: string; readonly code: string; readonly attempts: number; readonly exit_code: number | null }
}

/**
 * 读成功的返回。标签由 `evaluateLiveGate()` 按**这次回读的证据**算出：
 *   * 证据齐全 → `provenance=LIVE`、`connection=CONNECTED`、`live_eligible=true`；
 *   * 缺任何一项 → `FIXTURE`、`live_eligible=false`，缺项逐条在
 *     `live_gate_violations` 里（不是压成一句「全局 Gate 没开」）。
 */
export interface FeishuTranscriptRead {
  readonly kind: 'READ'
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly connection_state: Connection
  readonly labels: ThreeAxisLabels
  readonly provenance_basis: ProvenanceBasis
  readonly live_eligible: boolean
  readonly live_gate: FeishuLiveGateState
  /** 为什么不是 LIVE（LIVE 时为空数组；每条点名缺的证据）。 */
  readonly live_gate_violations: readonly string[]
  readonly creates_artifact: false
  /** 交给业务层决定是否落库；标签由本次回读的证据决定，不接受调用方自报。 */
  readonly readback: FeishuCliTranscriptReadback
  readonly requested: FeishuTranscriptRequestedFlags
  readonly note: string
}

/** 平台说「还在生成」：不是失败，去等新事件或人工重试。 */
export interface FeishuTranscriptWaitingExternal {
  readonly kind: 'WAITING_EXTERNAL'
  readonly connector: typeof FEISHU_MINUTES_CONNECTOR_ID
  readonly connection_state: Connection
  readonly labels: ThreeAxisLabels
  readonly creates_artifact: false
  readonly error_code: 'WAITING_EXTERNAL'
  readonly provider_code: string
  readonly task_state: 'WAITING_EXTERNAL'
  readonly message: string
  readonly requested: FeishuTranscriptRequestedFlags
}

/** `fetchTranscript()` 的可能返回（标签由证据算出，不接受调用方自报）。 */
export type FeishuTranscriptResult =
  | FeishuTranscriptInvalidArgs
  | FeishuTranscriptBlocked
  | FeishuTranscriptRead
  | FeishuTranscriptWaitingExternal

/** 一条事件订阅注记（由契约表生成，不在适配器里另写一份口径）。 */
export interface FeishuSubscriptionNote {
  readonly event: string
  readonly identity: string
  readonly usable_as_batch_archive_basis: boolean
  readonly note: string
}

/** `subscriptionNotes()` 的返回。 */
export interface FeishuSubscriptionNotes {
  readonly events: readonly FeishuSubscriptionNote[]
  /** webhook payload 永远不是逐字稿（TR-S7），恒 false。 */
  readonly webhook_payload_is_transcript: false
  readonly rules: readonly string[]
}

/** 适配器（本包的全部能力）。 */
export interface FeishuMinutesAdapter {
  readonly describe: () => FeishuAdapterDescription
  readonly probe: () => FeishuProbeResult
  readonly fetchTranscript: (request: FeishuTranscriptRequest) => Promise<FeishuTranscriptResult>
  readonly mapProviderError: (response: unknown) => FeishuProviderError
  readonly subscriptionNotes: () => FeishuSubscriptionNotes
}

/**
 * 取环境变量的**存在性**。空串/纯空白算不存在；值本身不离开本函数。
 * @param env - 环境变量源。
 * @param name - 变量名。
 */
function present(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  return readNonEmptyString(env[name]) !== null
}

/**
 * 传输层失败码 → 适配器级的阻断原因（两份口径合一，避免漂移）。
 * @param error - 传输层错误。
 */
function blockedReasonFor(error: FeishuTransportError): FeishuTranscriptBlockedReason {
  switch (error.code) {
    case 'CLI_NOT_FOUND':
    case 'CLI_NOT_EXECUTABLE':
    case 'CLI_SPAWN_FAILED':
      return 'CLI_UNAVAILABLE'
    case 'CLI_TIMEOUT':
      return 'CLI_TIMEOUT'
    case 'PROVIDER_NO_PERMISSION':
    case 'PROVIDER_REJECTED':
      return 'PROVIDER_NO_PERMISSION'
    case 'ENVELOPE_UNRECOGNIZED':
    case 'TRANSCRIPT_UNRECOGNIZED':
    case 'OUTPUT_FILE_MISSING':
    case 'OUTPUT_FILE_INVALID':
      return 'READ_PARSE_FAILED'
    case 'TRANSCRIPT_EMPTY':
    case 'READBACK_INVALID':
      return 'READBACK_INVALID'
    default:
      return 'CLI_FAILED'
  }
}

/**
 * 创建一个飞书 Minutes 适配器。**默认零网络 I/O / 零子进程**：传输层必须由
 * 调用方显式注入（见 `FeishuAdapterConfig.transport`），否则 `fetchTranscript()`
 * 只会说「传输层没装配」。
 * @param config - 见 `FeishuAdapterConfig`；全部可省略。
 * @returns 适配器。
 */
export function createFeishuMinutesAdapter(config: FeishuAdapterConfig = {}): FeishuMinutesAdapter {
  const env = config.env ?? process.env
  const appIdEnv = FEISHU_DEFAULT_ENV.app_id
  const appSecretEnv = config.app_secret_env ?? FEISHU_DEFAULT_ENV.app_secret
  const userTokenEnv = config.user_access_token_env ?? FEISHU_DEFAULT_ENV.user_access_token
  const tenantTokenEnv = config.tenant_token_env ?? FEISHU_DEFAULT_ENV.tenant_access_token
  const transport = config.transport

  /** 凭据存在性；`config.app_id` 优先于变量。 */
  function credentials(): FeishuCredentialPresence {
    return {
      app_id_present: readNonEmptyString(config.app_id) !== null || present(env, appIdEnv),
      app_secret_present: present(env, appSecretEnv),
      user_token_present: present(env, userTokenEnv),
      tenant_token_present: present(env, tenantTokenEnv),
    }
  }

  function describe(): FeishuAdapterDescription {
    return {
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      contract_version: FEISHU_MINUTES_CONTRACT_VERSION,
      // `lark-cli-transport` 已实现（`transport.ts`）；HTTP 传输 / OAuth / 事件订阅没有。
      implemented: ['contract', 'auth-check', 'error-mapping', 'labels', FEISHU_CLI_TRANSPORT_ID],
      not_implemented: ['http-transport', 'oauth-flow', 'event-subscription'],
      live_gate: FEISHU_LIVE_GATE_POLICY,
      live_gate_evidence: [...LIVE_EVIDENCE_ITEMS],
    }
  }

  function probe(): FeishuProbeResult {
    const presence = credentials()
    const base = {
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      contract_version: FEISHU_MINUTES_CONTRACT_VERSION,
      live_eligible: false as const,
      credentials: presence,
      transport_configured: transport !== undefined,
    } as const
    if (!presence.app_id_present || !presence.app_secret_present) {
      const missing = [
        ...(presence.app_id_present ? [] : [appIdEnv]),
        ...(presence.app_secret_present ? [] : [appSecretEnv]),
      ]
      return {
        ...base,
        connection_state: 'NOT_CONNECTED',
        labels: buildConnectorLabels({ connection: 'NOT_CONNECTED' }).labels,
        provenance_basis: 'NO_LIVE_READ',
        blocked_reason: 'NO_APP_CREDENTIALS',
        missing,
        next_steps: [
          '在飞书开放平台创建自建应用，取得 App ID / App Secret（不得写进任何文件或日志）。',
          `把凭据放进进程环境变量 ${appIdEnv} / ${appSecretEnv} 后重跑 probe()。`,
          '再用用户身份完成 OAuth（含 offline_access）取得用户令牌——妙记事件是 user identity，应用凭据不够。',
        ],
      }
    }
    if (!presence.user_token_present) {
      return {
        ...base,
        connection_state: 'AUTH_REQUIRED',
        labels: buildConnectorLabels({ connection: 'AUTH_REQUIRED' }).labels,
        provenance_basis: 'NO_LIVE_READ',
        blocked_reason: 'USER_IDENTITY_REQUIRED',
        missing: [userTokenEnv],
        next_steps: [
          'minutes.minute.generated_v1 标注为 user identity，不能用 Bot / 租户身份代替（docs/04 §13）。',
          '用应用凭据走用户 OAuth（含 offline_access）取得 user access token。',
          `把令牌放进 ${userTokenEnv} 后重跑 probe()；本适配器仍不会仅凭令牌存在就标 CONNECTED。`,
        ],
      }
    }
    return {
      ...base,
      connection_state: 'AUTH_REQUIRED',
      labels: buildConnectorLabels({ connection: 'AUTH_REQUIRED' }).labels,
      provenance_basis: 'NO_LIVE_READ',
      blocked_reason: 'TOKEN_PRESENT_UNVERIFIED',
      missing: [],
      next_steps: [
        transport === undefined
          ? '本机没有装配传输层：注入 transport（Lark CLI + 绝对路径）后才可能真读。'
          : '传输层已装配：还需要用真实 minute_token 成功回读一次（回执 + sha256 + is_complete）。',
        '完成一次真实 minute_token 完整回读后，才允许把 connection 标为 CONNECTED。',
        '在那之前，任何出口都必须保持 provenance=FIXTURE、live_eligible=false。',
      ],
      note:
        transport === undefined
          ? '令牌存在但本机未装配传输层（且不得把开发者全局 CLI 当产品凭据），无法验证令牌；不得据此宣称 CONNECTED'
          : '传输层已装配，但还没有一次成功回读，令牌仍无法验证；不得据此宣称 CONNECTED',
    }
  }

  /** 传输层失败 → BLOCKED（带阶段/机器码，不回声 token、不退正文）。 */
  function blockedFromTransportFailure(
    failure: FeishuTransportError,
    requested: FeishuTranscriptRequestedFlags,
    state: FeishuProbeResult,
  ): FeishuTranscriptBlocked {
    const reason = blockedReasonFor(failure)
    return {
      kind: 'BLOCKED',
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connection_state: state.connection_state,
      labels: state.labels,
      creates_artifact: false,
      error_code: reason === 'PROVIDER_NO_PERMISSION' ? 'AUTH_REQUIRED' : 'READ_FAILED',
      blocked_reason: reason,
      message: `传输层失败，没有正文也没有 artifact。${failure.message}`,
      requested,
      failure: {
        stage: failure.stage,
        code: failure.code,
        attempts: failure.attempts,
        exit_code: failure.exit_code,
      },
    }
  }

  async function fetchTranscript(request: FeishuTranscriptRequest): Promise<FeishuTranscriptResult> {
    const minuteToken = readNonEmptyString(request?.minute_token)
    const meetingIdPresent = readNonEmptyString(request?.external_meeting_id) !== null
    const requested: FeishuTranscriptRequestedFlags = {
      minute_token_present: minuteToken !== null,
      external_meeting_id_present: meetingIdPresent,
    }
    const state = probe()
    const labels = state.labels
    if (minuteToken === null) {
      return {
        kind: 'ERROR',
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        error_code: 'INVALID_ARGS',
        reason_code: 'MINUTE_TOKEN_REQUIRED',
        connection_state: state.connection_state,
        labels,
        creates_artifact: false,
        message: '缺 minute_token：没有平台产物标识就不能回读，也不猜、不建 artifact。',
        requested,
      }
    }

    /** 凭据这一环：缺任何一个都直接阻断，不去碰 CLI。 */
    const locked = (reason: FeishuTranscriptBlockedReason, message: string, errorCode: FeishuTranscriptBlockedErrorCode): FeishuTranscriptBlocked => ({
      kind: 'BLOCKED',
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connection_state: state.connection_state,
      labels,
      creates_artifact: false,
      error_code: errorCode,
      blocked_reason: reason,
      message,
      requested,
    })

    if (state.blocked_reason === 'NO_APP_CREDENTIALS') {
      return locked('NO_APP_CREDENTIALS', '没有真实回读就没有正文，也就没有 artifact。还缺应用凭据。', 'NOT_CONNECTED')
    }
    if (state.blocked_reason === 'USER_IDENTITY_REQUIRED') {
      return locked(
        'USER_IDENTITY_REQUIRED',
        '没有真实回读就没有正文，也就没有 artifact。还缺用户身份令牌：妙记事件是 user identity 订阅。',
        'AUTH_REQUIRED',
      )
    }
    /** 凭据齐了（但未验证）。下一环是传输层。 */
    if (transport === undefined) {
      return locked(
        'TRANSPORT_NOT_CONFIGURED',
        '本机没有装配传输层：本适配器默认不拉起任何子进程（也不允许把开发者全局 CLI 当产品凭据）。' +
          '要用真实读取，先注入 createLarkCliTransport({ runner: createProcessCliRunner({ command: <绝对路径> }) })。',
        'AUTH_REQUIRED',
      )
    }

    const result = await transport.read({ minute_token: minuteToken })
    if (result.status === 'WAITING_EXTERNAL') {
      return {
        kind: 'WAITING_EXTERNAL',
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        connection_state: state.connection_state,
        labels,
        creates_artifact: false,
        error_code: 'WAITING_EXTERNAL',
        provider_code: result.provider_code,
        task_state: 'WAITING_EXTERNAL',
        message: `平台说产物还在生成（${result.provider_code}）：不是失败，等新事件或人工重试即可。${result.message}`,
        requested,
      }
    }
    if (result.status === 'FAILED') {
      return blockedFromTransportFailure(result.error, requested, state)
    }
    // 读成功也要过证据闸门：自相矛盾（哈希不一致）直接失败；证据不齐 → 说清缺哪项。
    const contradictions = readbackConsistencyViolations(result.readback)
    if (contradictions.length > 0) {
      return {
        kind: 'BLOCKED',
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        connection_state: state.connection_state,
        labels,
        creates_artifact: false,
        error_code: 'READ_FAILED',
        blocked_reason: 'READBACK_INVALID',
        message: `回读对象自相矛盾，按失败处理（不一致不是警告）：${contradictions.join('；')}。本次没有正文，也没有 artifact。`,
        requested,
      }
    }
    const decision = evaluateLiveGate(result.readback)
    const isLive = decision.gate === 'LIVE'
    return {
      kind: 'READ',
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connection_state: isLive ? 'CONNECTED' : state.connection_state,
      labels: isLive ? decision.labels : labels,
      provenance_basis: decision.provenance_basis,
      live_eligible: isLive,
      live_gate: decision.gate,
      live_gate_violations: decision.violations,
      creates_artifact: false,
      readback: result.readback,
      requested,
      note: isLive
        ? '本次回读的 LIVE 证据齐全（平台通道 + 回执绑定内容哈希 + 哈希重算一致'
          + (result.readback.reread_sha256 === undefined ? '' : ' + 重读校验一致')
          + ' + 带偏移 fetched_at + 完整分页 + 非空正文）：provenance=LIVE、trigger=MANUAL、connection=CONNECTED。'
          + '产品自有 OAuth / 事件订阅（F2）仍是 P1，不阻塞本 demo。'
        : `读到了字节，但证据不齐，只能是 FIXTURE：${decision.violations.join('；')}。`
          + '这不是「全局 Gate 没开」，而是这次回读确实缺上面的证据；补齐后才可能 LIVE。',
    }
  }

  function mapProviderError(response: unknown): FeishuProviderError {
    return mapFeishuError(response)
  }

  function subscriptionNotes(): FeishuSubscriptionNotes {
    return {
      events: Object.values(FEISHU_MINUTES_EVENT_NOTES).map((entry) => ({
        event: entry.event,
        identity: entry.identity,
        usable_as_batch_archive_basis: entry.usable_as_batch_archive_basis,
        note: entry.note,
      })),
      webhook_payload_is_transcript: false,
      rules: [
        'minutes.minute.generated_v1 当前标注为 user identity，不能默认 Bot 也能订阅（docs/04 §13）。',
        'vc.recording.recording_transcript_generated_v1 是转写片段事件，不带完整 Meeting 关联，不得作为批量归档的唯一依据（transcript-rules §2.2）。',
        'webhook payload 只是触发信号，正文必须来自回读结果（TR-S7）；本适配器只有显式注入的 Lark CLI 传输层才能回读。',
      ],
    }
  }

  return { describe, probe, fetchTranscript, mapProviderError, subscriptionNotes }
}
