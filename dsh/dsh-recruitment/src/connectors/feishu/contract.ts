// 飞书 Minutes Connector 契约：纯常量 / 类型 / 纯函数，零 I/O。
//
// 本文件是「线 2」的合同面：把**平台事实**写成可断言的字符串常量与类型，
// 不 import 任何 I/O 模块、不发起任何请求、不调用子进程。
//
// **LIVE Gate 不是一个写死的状态**：它由 `labels.ts` 的 `evaluateLiveGate()`
// 按**每一次回读的证据**（平台通道 / 回执 `@sha256:` / content_sha256 与
// raw_text 重算一致 / 重读哈希 / 带偏移的 fetched_at / 完整分页 / 非空正文 /
// MANUAL|EVENT）算出。本文件只固定「口径名」，不固定「开还是关」，也不许
// 任何调用方传参自称 LIVE。
//
// 每个常量都按下面的口径标注依据，**不要把占位当成已核实**：
//
//   已核对（逐字）：
//     * 事件名、`2091003` / `2091005` 的语义、`minutes.minute.generated_v1`
//       的 user-identity 注记、`vc.recording.recording_transcript_generated_v1`
//       的片段事件注记 —— `docs/04-connectors-and-transcript.md §13`、
//       `contracts/interview/transcript-rules.md §2.1 / §2.2`。
//     * 取全文与反查 token 的 **CLI 形态**（`minutes +detail --transcript`、
//       `vc +recording`）—— 同上；`docs/04 §13` 明确「直接复用 Lark CLI（MIT）」。
//   未核对（骨架占位，编码前必须在飞书官方 API Explorer / 文档复核）：
//     * HTTP 路径、分页参数名、权限点（scope）名称、默认页大小。
//       `docs/04 §13` 对飞书只给了 CLI 形态，没有给 HTTP 形态；同一节对钉钉的
//       注记「不作最终契约…编码前必须在官方 API Explorer 复核字段、额度、分页
//       参数」对飞书同样成立，所以下面的路径全部按开放平台通用形态
//       （`/open-apis/<service>/v<ver>/<resource>`）写，只作为契约常量。
//
// 端点常量**不会**被本骨架使用：`adapter.ts` 故意没有传输层（见该文件头注）。

/** 本契约版本。端点/事件/错误码任何一处口径变化都必须 +1。 */
export const FEISHU_MINUTES_CONTRACT_VERSION = '1.0.0'

/** Connector 标识（与 `describe().connector`、`probe().connector` 同一个值）。 */
export const FEISHU_MINUTES_CONNECTOR_ID = 'feishu-minutes'

/** 会议平台标识（写入 `meeting.provider` 的那一个值）。 */
export const FEISHU_MINUTES_PROVIDER = 'FEISHU'

/**
 * LIVE Gate 的**判定口径**：`EVIDENCE_DRIVEN`。
 *
 * 这不是一个「开 / 关」开关，而是「没有证据就没有 LIVE」的口径名：
 * 每次读取由 `labels.ts` 的 `evaluateLiveGate()` 逐项核对证据，
 * 全齐才返回 `gate='LIVE'`，缺任何一项就是 `BLOCKED` 并列出缺哪一项。
 *
 * 之所以不再用一个常量表示 Gate 状态：常量只能表达「全开 / 全关」，
 * 会把「这次回读到底有哪些真实证据」压成一个布尔，正是 R4 禁止的压平。
 */
export const FEISHU_LIVE_GATE_POLICY = 'EVIDENCE_DRIVEN'

/** LIVE Gate 的判定口径类型。 */
export type FeishuLiveGatePolicy = typeof FEISHU_LIVE_GATE_POLICY

/** 一次读取的 Gate 结论：由证据算出，不接受调用方传入。 */
export type FeishuLiveGateState = 'LIVE' | 'BLOCKED'

/**
 * 飞书 Minutes 回读的 HTTP 端点。**仅作为契约常量，本骨架不发起请求。**
 * 路径全部「未核实/骨架占位」——依据见 `FEISHU_MINUTES_ENDPOINT_NOTES`。
 */
export const FEISHU_MINUTES_ENDPOINTS = {
  'minutes.detail': '/open-apis/minutes/v1/minutes/{minute_token}',
  'minutes.transcript': '/open-apis/minutes/v1/minutes/{minute_token}/transcript',
  'vc.recording.list': '/open-apis/vc/v1/recordings',
} as const

/** 端点键（`minutes.detail` / `minutes.transcript` / `vc.recording.list`）。 */
export type FeishuMinutesEndpointKey = keyof typeof FEISHU_MINUTES_ENDPOINTS

/** 每个端点的依据与核实状态。占位就是占位，不许在文档里说成已核对。 */
export const FEISHU_MINUTES_ENDPOINT_NOTES: Readonly<Record<FeishuMinutesEndpointKey, string>> = {
  'minutes.detail': '未核实/骨架占位。docs/04 §13 只给 CLI 形态 `minutes +detail --transcript`；HTTP 路径与返回字段需在官方 API Explorer 复核。',
  'minutes.transcript': '未核实/骨架占位。取全文（含分页）的 HTTP 形态未在 docs/04 §13 给出；只能用 CLI 形态对照复核。',
  'vc.recording.list': '未核实/骨架占位。TR-S2 的「有 Meeting ID 无 minute_token」走 `vc +recording`；HTTP 路径未核对。',
}

/**
 * 飞书妙记的 **CLI 形态**（`docs/04 §9.6 / §13` 逐字「直接复用 Lark CLI（MIT）」）。
 * 一等契约常量：传输层若接入，首选实现是这两个命令，不是自己拼 HTTP。
 * 本骨架**不调用**它们（也不允许 import 子进程模块）。
 */
export const FEISHU_LARK_CLI = {
  minutesDetailTranscript: 'minutes +detail --transcript',
  vcRecording: 'vc +recording',
} as const

/** CLI 常量的依据注记。 */
export const FEISHU_LARK_CLI_NOTE =
  'docs/04 §13 指定复用 Lark CLI（MIT）：`minutes +detail --transcript` 取全文（能处理生成中），`vc +recording` 由 Meeting ID 反查 minute_token。本骨架只写常量，不执行 CLI。'

/**
 * 分页字段名。**未核实/骨架占位**：docs/04 §13 没有给飞书的分页参数，
 * 只要求「按平台分页规则读完全部内容」（TR-C2）。
 */
export const FEISHU_MINUTES_PAGINATION = {
  page_size: 'page_size',
  page_token: 'page_token',
  has_more: 'has_more',
  items: 'items',
} as const

/** 同一对象的别名（调用方按「分页字段」命名时用）。 */
export const FEISHU_MINUTES_PAGINATION_FIELDS = FEISHU_MINUTES_PAGINATION

/** 默认页大小。**未核实/骨架占位**，只是给实现者一个起点，不是平台事实。 */
export const FEISHU_MINUTES_DEFAULT_PAGE_SIZE = 50

/**
 * 权限点。**未核实/占位**：docs/04 §13 没有列 scope 名称，编码前必须按官方
 * 权限列表核对。`offline_access` 是用户 OAuth 拿 refresh token 所需，属
 * 产品自有 OAuth（F2 / P1）的能力，不是 demo 的 LIVE 证据（D-1：LIVE 由真实
 * 回读证据决定，MANUAL 读取不要求产品 OAuth）。
 */
export const FEISHU_MINUTES_SCOPES = {
  minutes_read: 'minutes:minutes:readonly',
  minutes_transcript_read: 'minutes:minutes.transcript:readonly',
  offline_access: 'offline_access',
} as const

/** 事件名（`docs/04 §13` 逐字）。 */
export const FEISHU_MINUTES_EVENTS = {
  minutes_generated: 'minutes.minute.generated_v1',
  vc_recording_transcript_generated: 'vc.recording.recording_transcript_generated_v1',
} as const

/** 事件订阅身份。`UNSPECIFIED` = 文档没写，**不得假设**。 */
export type FeishuEventIdentity = 'USER' | 'UNSPECIFIED'

/** 一条事件的订阅注记。 */
export interface FeishuEventNote {
  readonly event: string
  readonly identity: FeishuEventIdentity
  /** 能否作为「批量归档」的唯一依据。false = 不得单独用。 */
  readonly usable_as_batch_archive_basis: boolean
  readonly note: string
}

/** 事件注记（`docs/04 §13` + `transcript-rules.md §2.2`）。 */
export const FEISHU_MINUTES_EVENT_NOTES: Readonly<Record<string, FeishuEventNote>> = {
  'minutes.minute.generated_v1': {
    event: 'minutes.minute.generated_v1',
    identity: 'USER',
    usable_as_batch_archive_basis: true,
    note: 'docs/04 §13：该订阅当前标注为 user identity，不能默认 Bot 也能订阅；事件给 minute_token + minute_source.source_entity_id(Meeting ID) + 唯一 event_id。',
  },
  'vc.recording.recording_transcript_generated_v1': {
    event: 'vc.recording.recording_transcript_generated_v1',
    identity: 'UNSPECIFIED',
    usable_as_batch_archive_basis: false,
    note: 'docs/04 §13：这是转写**片段**事件，不带完整 Meeting 关联，不得作为批量归档的唯一依据。',
  },
}

/** 业务任务状态（只取本链路用得上的两个，见 TR-F1 / TR-F2）。 */
export type FeishuTaskState = 'WAITING_EXTERNAL' | 'WAITING_HUMAN'

/** 错误分类。`UNKNOWN` = 不在已核对清单里，**不猜**。 */
export type FeishuProviderErrorKind = 'GENERATING' | 'NO_PERMISSION' | 'UNKNOWN'

/** 一条已核对错误码的处置规则。 */
export interface FeishuProviderErrorRule {
  readonly kind: FeishuProviderErrorKind
  readonly task_state: FeishuTaskState
  /** 落到 `business_task.error_code` 的值（只有无权限时给）。 */
  readonly error_code?: string
  /**
   * 是否允许建 `transcript_artifact` 行。恒 false：错误没有内容，
   * 而有内容的行才允许存在（P-2 / P-3 / TR-C7）。
   */
  readonly creates_artifact: false
}

/**
 * 已核对的飞书错误码（`docs/04 §13`、`transcript-rules.md §2.2`）。
 * 规则对象只放机器可判定的键，人读的注记在 `FEISHU_PROVIDER_ERROR_NOTES`。
 */
export const FEISHU_PROVIDER_ERRORS: Readonly<Record<string, FeishuProviderErrorRule>> = {
  '2091003': {
    kind: 'GENERATING',
    task_state: 'WAITING_EXTERNAL',
    creates_artifact: false,
  },
  '2091005': {
    kind: 'NO_PERMISSION',
    task_state: 'WAITING_HUMAN',
    error_code: 'AUTH_REQUIRED',
    creates_artifact: false,
  },
}

/**
 * 错误码注记（给人看，也供文档与测试引用）。
 * 两条都已核对；**不存在**「重试到底」这一条。
 * 也**没有**别名表：`docs/04 §13` 与 `transcript-rules.md §2.2` 只给了这两个码，
 * 任何别的码（含看起来同族的）一律走 `UNKNOWN`，不猜、不推断。
 */
export const FEISHU_PROVIDER_ERROR_NOTES: Readonly<Record<string, string>> = {
  '2091003': '产物仍在生成：不建 artifact 行；business_task.status=WAITING_EXTERNAL，等新事件或人工重试（TR-F1 / P-3）。',
  '2091005': '无读取权限：business_task.status=WAITING_HUMAN + error_code=AUTH_REQUIRED；保留原任务，重授权后从原 attempt 继续，不重试到死（TR-F2）。',
}

/** 已映射的错误（`mapFeishuError` 的返回形状）。 */
export interface FeishuProviderError {
  /** 平台错误码文本；取不到时是空串（不编一个码）。 */
  readonly provider_code: string
  readonly kind: FeishuProviderErrorKind
  readonly task_state: FeishuTaskState
  readonly error_code?: string
  /** 恒 false：任何错误都不建 artifact（P-3 / TR-C7）。 */
  readonly creates_artifact: false
  /** 一句给人看的中文说明。 */
  readonly message: string
}

/** 事件信封。`kind` 之外全是平台给的原始字段，一律当不可信输入。 */
export interface FeishuMinutesEventEnvelope {
  /** `WEBHOOK_EVENT` 才可能算事件触发；`WEBHOOK_PAYLOAD` 只是载荷，`FIXTURE` 是造的。 */
  readonly kind?: unknown
  readonly event_type?: unknown
  readonly event_id?: unknown
  readonly verified?: unknown
  readonly minute_token?: unknown
  readonly source_entity_id?: unknown
}

/** 事件 → 绑定键。绑定只靠平台 ID（`transcript-rules.md §3.2`）。 */
export interface FeishuTranscriptBindingKey {
  readonly provider: typeof FEISHU_MINUTES_PROVIDER
  readonly minute_token: string
  readonly external_meeting_id: string
  /** 只有 `EVENT` 才代表「事件给的键」；否则是人/工具发起。 */
  readonly trigger: 'EVENT' | 'MANUAL'
  /** 平台事件唯一 ID；有才算 EVENT，没有就只能 MANUAL。 */
  readonly provider_event_id?: string
}

/** 绑定键构造失败（不给半成品）。 */
export type FeishuBindingKeyFailure = {
  readonly ok: false
  readonly reason_code: 'MINUTE_TOKEN_REQUIRED' | 'SOURCE_ENTITY_ID_REQUIRED'
  readonly message: string
}

/** 绑定键构造结果。 */
export type FeishuBindingKeyResult =
  | { readonly ok: true; readonly key: FeishuTranscriptBindingKey }
  | FeishuBindingKeyFailure

/**
 * 读一个非空字符串；空串/纯空白/非字符串一律 `null`（不当成有值）。
 * @param value - 任意输入（通常来自事件或 env）。
 * @returns 去掉首尾空白后的字符串，或 null。
 */
export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * 一条事件是否具备 **EVENT 触发**的证据。
 * 三条同时成立才算：`kind='WEBHOOK_EVENT'`、`verified===true`、事件唯一 ID 非空。
 * 事件 ID 认两个名字：规范化后的 `provider_event_id`（去重键用的名字，TR-U1）
 * 与平台原始信封字段 `event_id`——同一个事实的两种叫法，不另造第三个。
 * 少一条就是 MANUAL（TR-S1 / TR-S6）。
 * @param event - 事件信封（不可信输入）。
 */
export function hasEventTriggerEvidence(event: unknown): boolean {
  if (typeof event !== 'object' || event === null) return false
  const node = event as Record<string, unknown>
  const eventId = readNonEmptyString(node.provider_event_id) ?? readNonEmptyString(node.event_id)
  return node.kind === 'WEBHOOK_EVENT' && node.verified === true && eventId !== null
}

/**
 * 由事件构造绑定键：`minute_token` + `source_entity_id`(Meeting ID) + `event_id`。
 * 缺 `minute_token` 或 Meeting ID → 失败（不给半成品）；`event_id` 非空且事件
 * 已验证才算 `EVENT`，否则 `MANUAL`。**绝不**用标题/时间/参会人凑键（TR-L3）。
 * @param event - 事件信封。
 * @returns `{ok:true, key}` 或 `{ok:false, reason_code, message}`。
 */
export function buildBindingKey(event: FeishuMinutesEventEnvelope | null | undefined): FeishuBindingKeyResult {
  const minuteToken = readNonEmptyString(event?.minute_token)
  if (minuteToken === null) {
    return {
      ok: false,
      reason_code: 'MINUTE_TOKEN_REQUIRED',
      message: '事件缺 minute_token：既不能回读全文，也不能建绑定键。',
    }
  }
  const meetingId = readNonEmptyString(event?.source_entity_id)
  if (meetingId === null) {
    return {
      ok: false,
      reason_code: 'SOURCE_ENTITY_ID_REQUIRED',
      message: '事件缺 minute_source.source_entity_id（Meeting ID）：只能进 NEEDS_LINKING，不得按标题或时间猜。',
    }
  }
  const eventId = readNonEmptyString(event?.event_id)
  if (eventId === null) {
    return {
      ok: true,
      key: { provider: FEISHU_MINUTES_PROVIDER, minute_token: minuteToken, external_meeting_id: meetingId, trigger: 'MANUAL' },
    }
  }
  const trigger = hasEventTriggerEvidence(event) ? 'EVENT' : 'MANUAL'
  return {
    ok: true,
    key: {
      provider: FEISHU_MINUTES_PROVIDER,
      minute_token: minuteToken,
      external_meeting_id: meetingId,
      trigger,
      provider_event_id: eventId,
    },
  }
}

/** 一页响应的形状（只取分页相关字段）。 */
export interface FeishuPageLike {
  readonly has_more?: unknown
  readonly page_token?: unknown
  readonly items?: unknown
}

/**
 * 这一页是否已经读完：`has_more === false` 且没有下一页游标（TR-C2）。
 * 只认平台明确说 `false`；缺失/其它值都按「没读完」处理（不猜）。
 * @param page - 一页响应。
 */
export function isPageComplete(page: FeishuPageLike | null | undefined): boolean {
  if (typeof page !== 'object' || page === null) return false
  if (page.has_more !== false) return false
  return page.page_token === undefined || page.page_token === null || page.page_token === ''
}

/**
 * 从错误码 / 平台响应里取出错误码文本。取不到就是 `null`。
 * @param codeOrResponse - 字符串、数字，或 `{code}` / `{error:{code}}` / `{data:{code}}`。
 */
function extractProviderCode(codeOrResponse: unknown): string | null {
  if (typeof codeOrResponse === 'number') {
    return Number.isFinite(codeOrResponse) ? String(codeOrResponse) : null
  }
  const direct = readNonEmptyString(codeOrResponse)
  if (direct !== null) return direct
  if (typeof codeOrResponse !== 'object' || codeOrResponse === null) return null
  const node = codeOrResponse as Record<string, unknown>
  for (const candidate of [node.code, node.status_code]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    const text = readNonEmptyString(candidate)
    if (text !== null) return text
  }
  for (const key of ['error', 'data']) {
    const nested = node[key]
    if (typeof nested !== 'object' || nested === null) continue
    const candidate = (nested as Record<string, unknown>).code
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    const text = readNonEmptyString(candidate)
    if (text !== null) return text
  }
  return null
}

/**
 * 错误码 → 处置。纯函数，不抛异常、不建 artifact。
 *
 * 已核对：`2091003` → `GENERATING`/`WAITING_EXTERNAL`（不建 artifact）；
 * `2091005` → `NO_PERMISSION`/`WAITING_HUMAN`/`AUTH_REQUIRED`（不建 artifact）。
 * 未知码 → `UNKNOWN` + `WAITING_HUMAN`：不猜语义、不自动重试、不建 artifact。
 * 平台返回的 `msg` 文本**不回显**（可能带租户内容，R7）。
 * @param codeOrResponse - 错误码或平台错误响应。
 * @returns 稳定的映射对象。
 */
export function mapFeishuError(codeOrResponse: unknown): FeishuProviderError {
  const providerCode = extractProviderCode(codeOrResponse)
  if (providerCode === null) {
    return {
      provider_code: '',
      kind: 'UNKNOWN',
      task_state: 'WAITING_HUMAN',
      creates_artifact: false,
      message: '无法从响应里取出飞书错误码：不猜语义、不自动重试、不建 artifact，交人工判定。',
    }
  }
  const rule = FEISHU_PROVIDER_ERRORS[providerCode]
  if (rule === undefined) {
    return {
      provider_code: providerCode,
      kind: 'UNKNOWN',
      task_state: 'WAITING_HUMAN',
      creates_artifact: false,
      message: `飞书错误码 ${providerCode} 不在已核对清单里：不猜语义、不自动重试、不建 artifact，交人工判定。`,
    }
  }
  const note = FEISHU_PROVIDER_ERROR_NOTES[providerCode] ?? ''
  const message = `${providerCode}：${note}`
  if (rule.error_code !== undefined) {
    return {
      provider_code: providerCode,
      kind: rule.kind,
      task_state: rule.task_state,
      error_code: rule.error_code,
      creates_artifact: false,
      message,
    }
  }
  return {
    provider_code: providerCode,
    kind: rule.kind,
    task_state: rule.task_state,
    creates_artifact: false,
    message,
  }
}

/**
 * 通道标识：正文到底从哪来。三维标签要判 LIVE，先看这个。
 *   * `FEISHU_MINUTES_API` —— 平台回读（唯一可能 LIVE 的通道）；
 *   * `WEBHOOK_PAYLOAD` —— 事件载荷，**不是逐字稿**（TR-S7）；
 *   * `FIXTURE` —— 造的数据。
 */
export const FEISHU_TRANSPORT = {
  api: 'FEISHU_MINUTES_API',
  webhook_payload: 'WEBHOOK_PAYLOAD',
  fixture: 'FIXTURE',
} as const

/** 通道标识的取值类型。 */
export type FeishuTransport = (typeof FEISHU_TRANSPORT)[keyof typeof FEISHU_TRANSPORT]
