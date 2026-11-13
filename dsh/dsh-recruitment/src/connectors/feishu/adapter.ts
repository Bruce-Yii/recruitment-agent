// 飞书 Minutes Connector **适配器骨架**：授权检查 + 错误映射 + 三维标签 + 阻断语义。
//
// 传输层**故意未实现**：本文件不 import 任何 HTTP 客户端 / 套接字 / 子进程模块，
// 也不调用全局取数函数。真实 LIVE Gate = BLOCKED（本机没有飞书应用与用户授权，
// 且不允许伪造凭据），所以任何出口都不可能给出 `provenance='LIVE'` 或
// `connection='CONNECTED'`——没有真实回读就没有 LIVE（TR-S4、R4）。
//
// 三个必须记住的口径：
//   * `2091003` 生成中 → `WAITING_EXTERNAL`，不建 artifact；`2091005` 无权限 →
//     `WAITING_HUMAN` + `AUTH_REQUIRED`，不建 artifact（见 `contract.ts`）；
//   * `minutes.minute.generated_v1` 是 **user identity** 订阅，应用凭据不够，
//     缺用户令牌就是 `AUTH_REQUIRED`，不是 `NOT_CONNECTED` 也不是 `CONNECTED`；
//   * 令牌「存在」不等于「有效」：本骨架没有传输层，无法校验，所以即使 env 里
//     四个值全在，也只能是 `AUTH_REQUIRED` + `TOKEN_PRESENT_UNVERIFIED`。
import {
  FEISHU_MINUTES_CONNECTOR_ID,
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_MINUTES_EVENT_NOTES,
  FEISHU_MINUTES_LIVE_GATE,
  mapFeishuError,
  readNonEmptyString,
  type FeishuProviderError,
} from './contract.ts'
import { buildConnectorLabels, type Connection, type ThreeAxisLabels } from './labels.ts'

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
  readonly tenant_access_token_env?: string
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
  /** 本骨架**做到**的事。 */
  readonly implemented: readonly string[]
  /** 本骨架**没做**的事；`live_gate` 为 BLOCKED 的直接原因。 */
  readonly not_implemented: readonly string[]
  readonly live_gate: typeof FEISHU_MINUTES_LIVE_GATE
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
  readonly error_code: 'AUTH_REQUIRED' | 'NOT_CONNECTED'
  readonly message: string
  readonly requested: FeishuTranscriptRequestedFlags
}

/** `fetchTranscript()` 的可能返回（永不返回正文）。 */
export type FeishuTranscriptResult = FeishuTranscriptInvalidArgs | FeishuTranscriptBlocked

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

/** 适配器（本骨架的全部能力）。 */
export interface FeishuMinutesAdapter {
  readonly describe: () => FeishuAdapterDescription
  readonly probe: () => FeishuProbeResult
  readonly fetchTranscript: (request: FeishuTranscriptRequest) => FeishuTranscriptResult
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
 * 创建一个飞书 Minutes 适配器。**零网络 I/O**：构造时只记下 env 引用、不读任何值，
 * 每次 `probe()` / `fetchTranscript()` 现读存在性（便于测试注入、便于观察）。
 * @param config - 见 `FeishuAdapterConfig`；全部可省略。
 * @returns 骨架适配器。
 */
export function createFeishuMinutesAdapter(config: FeishuAdapterConfig = {}): FeishuMinutesAdapter {
  const env = config.env ?? process.env
  const appIdEnv = FEISHU_DEFAULT_ENV.app_id
  const appSecretEnv = config.app_secret_env ?? FEISHU_DEFAULT_ENV.app_secret
  const userTokenEnv = config.user_access_token_env ?? FEISHU_DEFAULT_ENV.user_access_token
  const tenantTokenEnv = config.tenant_access_token_env ?? FEISHU_DEFAULT_ENV.tenant_access_token

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
      implemented: ['contract', 'auth-check', 'error-mapping', 'labels'],
      not_implemented: ['http-transport', 'lark-cli-transport', 'oauth-flow', 'event-subscription'],
      live_gate: FEISHU_MINUTES_LIVE_GATE,
    }
  }

  function probe(): FeishuProbeResult {
    const presence = credentials()
    const base = {
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      contract_version: FEISHU_MINUTES_CONTRACT_VERSION,
      live_eligible: false as const,
      credentials: presence,
    }
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
          `把令牌放进 ${userTokenEnv} 后重跑 probe()；本骨架仍无法校验令牌有效性，所以仍不会标 CONNECTED。`,
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
        '本骨架未实现 HTTP 传输与 Lark CLI 调用，无法校验令牌是否有效。',
        '实现传输层并完成一次真实 minute_token 完整回读（回执 + sha256 + is_complete）后，才允许把 connection 标为 CONNECTED。',
        '在那之前，任何出口都必须保持 provenance=FIXTURE、live_eligible=false。',
      ],
      note: '骨架未实现 HTTP 传输，无法验证令牌；不得据此宣称 CONNECTED',
    }
  }

  function fetchTranscript(request: FeishuTranscriptRequest): FeishuTranscriptResult {
    const minuteTokenPresent = readNonEmptyString(request?.minute_token) !== null
    const meetingIdPresent = readNonEmptyString(request?.external_meeting_id) !== null
    const requested: FeishuTranscriptRequestedFlags = {
      minute_token_present: minuteTokenPresent,
      external_meeting_id_present: meetingIdPresent,
    }
    const state = probe()
    const labels = state.labels
    if (!minuteTokenPresent) {
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
    return {
      kind: 'BLOCKED',
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      connection_state: state.connection_state,
      labels,
      creates_artifact: false,
      error_code: state.connection_state === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'AUTH_REQUIRED',
      message:
        '本骨架不发起任何平台请求：没有真实回读就没有正文，也就没有 artifact。' +
        (state.blocked_reason === 'TOKEN_PRESENT_UNVERIFIED'
          ? '令牌存在但无法验证（无传输层），不得据此宣称 CONNECTED。'
          : state.blocked_reason === 'USER_IDENTITY_REQUIRED'
            ? '还缺用户身份令牌：妙记事件是 user identity 订阅。'
            : '还缺应用凭据。'),
      requested,
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
        'webhook payload 只是触发信号，正文必须来自回读结果（TR-S7）；本骨架没有任何回读路径，所以没有正文。',
      ],
    }
  }

  return { describe, probe, fetchTranscript, mapProviderError, subscriptionNotes }
}
