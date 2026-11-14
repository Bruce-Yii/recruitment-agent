// 飞书 Minutes **传输层**：`lark-cli-transport`（子进程读全文 + 分页 + 重试 + 超时）。
//
// 这是本连接器**唯一**允许发起外部调用的文件。它复用 `docs/04 §13` 指定的
// Lark CLI（MIT）形态（`FEISHU_LARK_CLI.minutesDetailTranscript`），结构照抄
// `dsh-superagent-prototype/src/sources/feishu-loops.ts` + `infra/commands.ts`
// 的四段循环（**读 → 判 → 重试 → 报错**），但**不抄**它的领域逻辑。
//
// 三条不许破的规矩：
//
//   1. **本文件不产 LIVE**。`FEISHU_MINUTES_LIVE_GATE === 'BLOCKED'` 时，
//      即使 CLI 读成功，回读对象的 `transport` 也只会是 `FIXTURE`：本机没有
//      真实凭据，无法证明这些字节来自飞书平台（可能是假 CLI / 回放 / 缓存）。
//      想拿 `transport='FEISHU_MINUTES_API'`，必须先按 README §6 解锁 Gate。
//   2. **失败要说清哪一步**：`stage` ∈ {locate-cli, invoke, parse, paginate,
//      validate}，外加原始退出码与脱敏后的 stderr 前 N 字节。诊断里**永不**
//      出现正文、argv、平台 `msg`（R7：不把候选人内容写进任何日志）。
//   3. **不猜、不补**：`has_more` 缺省、分页游标不前进、正文形状不认识、缺
//      `revision` —— 一律失败（fail-closed），绝不用空串或默认值凑一个回读。
//
// 「生成中」不是失败：`2091003` 经 `mapFeishuError()` 映射成
// `task_state='WAITING_EXTERNAL'`，调用方去等新事件或人工重试（TR-F1）。
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  FEISHU_LARK_CLI,
  FEISHU_MINUTES_DEFAULT_PAGE_SIZE,
  FEISHU_MINUTES_LIVE_GATE,
  FEISHU_MINUTES_PAGINATION,
  FEISHU_TRANSPORT,
  isPageComplete,
  mapFeishuError,
  readNonEmptyString,
  type FeishuTransport,
} from './contract.ts'

/** 传输层标识（`describe().not_implemented` 里被移除的那一项就是这个值）。 */
export const FEISHU_CLI_TRANSPORT_ID = 'lark-cli-transport'

/** 默认超时：180 s。飞书妙记全文可能有几十万字，比普通 API 宽松。 */
export const FEISHU_CLI_DEFAULT_TIMEOUT_MS = 180_000

/** 默认最多尝试次数（含首次）。只对**可重试**的传输抖动重试。 */
export const FEISHU_CLI_DEFAULT_MAX_ATTEMPTS = 3

/** 默认重试退避基数（指数退避：1 s → 2 s → 4 s …）。 */
export const FEISHU_CLI_DEFAULT_RETRY_BASE_MS = 1_000

/** 退避上限，防止配置错误导致长时间挂起。 */
export const FEISHU_CLI_MAX_RETRY_DELAY_MS = 30_000

/** 默认保留多少**字节**的 stderr 诊断（已脱敏、已截断）。 */
export const FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES = 512

/** 分页上限：防止 `has_more` 永远为 true 的平台缺陷把进程拖死。 */
export const FEISHU_CLI_DEFAULT_MAX_PAGES = 200

/** 子进程 stdout 硬上限（超了直接杀掉，避免内存被灌爆）。 */
export const FEISHU_CLI_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/**
 * CLI 参数名（**未核实**）。
 * `docs/04 §13` 只给到命令形态 `minutes +detail --transcript`，没给参数名；
 * 这里的 `--minute-token` / `--page-size` / `--page-token` 按 lark-cli 既有
 * 习惯（参考实现确有 `--page-size` / `--page-token`）推断，接入真实 CLI 前
 * 必须在 `lark-cli minutes +detail --help` 下逐字核对。
 */
export const FEISHU_CLI_TRANSCRIPT_FLAGS = {
  minute_token: '--minute-token',
  page_size: '--page-size',
  page_token: '--page-token',
} as const

/** 参数名的核实状态注记（引用这个常量，不要另写一份口径）。 */
export const FEISHU_CLI_TRANSCRIPT_FLAGS_NOTE =
  '未核实：docs/04 §13 只给了 `minutes +detail --transcript` 的命令形态，没给参数名。--minute-token / --page-size / --page-token 是按 lark-cli 既有习惯推断的，接真实 CLI 前必须用 --help 逐字核对。'

/**
 * CLI 输出信封的核实状态注记。
 * 参考实现的 `commands.lark()` 读的是 `{ok, data, error:{code,message}}`；
 * 本实现按该形态解析，但飞书妙记是否真的走同一个信封**未核实**。
 */
export const FEISHU_CLI_ENVELOPE_NOTE =
  '未核实：按参考实现 lark-cli 的 {ok, data, error:{code,message}} 信封解析；飞书妙记 minutes 子命令是否同形需在真实 CLI 上复核。形状不认识时一律失败（fail-closed），不猜。'

// ---------------------------------------------------------------------------
// 四段循环的第 0 段：把「跑一条 CLI」抽成可注入的 runner
// ---------------------------------------------------------------------------

/** 传输失败落在哪一段。诊断 message 必须点名这一段。 */
export type FeishuTransportStage = 'locate-cli' | 'invoke' | 'parse' | 'paginate' | 'validate'

/** 传输失败的机器可判码（闭集；新增要在这里写名字，并在 README 解释含义）。 */
export type FeishuTransportErrorCode =
  /** 找不到/不可执行的 CLI（locate-cli）。 */
  | 'CLI_NOT_FOUND'
  | 'CLI_NOT_EXECUTABLE'
  | 'CLI_SPAWN_FAILED'
  /** 调用本身失败（invoke）。 */
  | 'CLI_TIMEOUT'
  | 'CLI_NON_ZERO_EXIT'
  | 'PROVIDER_NO_PERMISSION'
  | 'PROVIDER_REJECTED'
  /** 输出形状不认识（parse）。 */
  | 'ENVELOPE_UNRECOGNIZED'
  | 'TRANSCRIPT_UNRECOGNIZED'
  /** 分页没走完（paginate）。 */
  | 'PAGINATION_STALLED'
  | 'PAGINATION_INCOMPLETE'
  | 'PAGE_LIMIT_EXCEEDED'
  /** 回读对象自检不过（validate）。 */
  | 'REVISION_REQUIRED'
  | 'TRANSCRIPT_EMPTY'
  | 'READBACK_INVALID'

/**
 * 一次子进程调用的入参。
 * 只给 **argv**：可执行文件由 runner 自己配置（`createProcessCliRunner({command})`），
 * 传输层不碰路径，也就没有「悄悄用 PATH 上的全局 CLI」这条路。
 * **argv 永不进入任何诊断**（可能带会议标识）。
 */
export interface FeishuCliInvocation {
  readonly args: readonly string[]
  readonly timeout_ms: number
  /** 本次是第几次尝试（从 1 开始），只用于日志/测试观察。 */
  readonly attempt: number
}

/** 子进程调用结局。`stderr` 是**未脱敏**原文，只有 `sanitizeDiagnostic()` 之后才许外出。 */
export type FeishuCliRunStatus = 'OK' | 'NON_ZERO_EXIT' | 'SPAWN_FAILED' | 'TIMEOUT' | 'SIGNALED'

/** 子进程调用结果。 */
export interface FeishuCliRunResult {
  readonly status: FeishuCliRunStatus
  readonly exit_code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** `SPAWN_FAILED` 时的系统错误码（`ENOENT` / `EACCES` / `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` …）。 */
  readonly spawn_error_code?: string
}

/** 可注入的 CLI runner。测试用假 runner，生产用 `createProcessCliRunner()`。 */
export type FeishuCliRunner = (invocation: FeishuCliInvocation) => Promise<FeishuCliRunResult>

/** `createProcessCliRunner()` 的配置。 */
export interface FeishuProcessCliRunnerConfig {
  /** 可执行文件；**必须显式给**，不读全局 profile（AGENTS.md §7.6）。 */
  readonly command: string
  /** 固定附加参数（例如 `['--format', 'json']`，或一个假 CLI 脚本的路径）。 */
  readonly extra_args?: readonly string[]
  /** 单次调用超时；默认 `FEISHU_CLI_DEFAULT_TIMEOUT_MS`。 */
  readonly timeout_ms?: number
  /** 子进程环境；默认继承 `process.env`。 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** SIGTERM 之后等多久再 SIGKILL；默认 5 s。 */
  readonly kill_grace_ms?: number
}

/** 把 stderr 截到上限字节数（UTF-8 安全：不切半个字符）。 */
function sliceUtf8(text: string, limitBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= limitBytes) return text
  let end = Math.max(0, limitBytes)
  // 回退到字符边界：0x80..0xBF 是续字节，一直退到起始字节。
  while (end > 0 && (buffer[end] !== undefined) && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/**
 * 造一个**真实子进程** runner。只负责跑进程、收 stdout/stderr、超时杀掉；
 * 不理解任何飞书语义（语义在 `read()` 里）。
 * @param config - 见 `FeishuProcessCliRunnerConfig`。
 * @returns 可注入 `createLarkCliTransport()` 的 runner。
 */
export function createProcessCliRunner(config: FeishuProcessCliRunnerConfig): FeishuCliRunner {
  const timeout = config.timeout_ms ?? FEISHU_CLI_DEFAULT_TIMEOUT_MS
  const grace = config.kill_grace_ms ?? 5_000
  const extra = config.extra_args ?? []
  const env = config.env === undefined ? process.env : config.env
  return async function run(invocation: FeishuCliInvocation): Promise<FeishuCliRunResult> {
    return await new Promise<FeishuCliRunResult>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let overflow = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let killer: ReturnType<typeof setTimeout> | undefined

      const finish = (result: FeishuCliRunResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (killer !== undefined) clearTimeout(killer)
        resolve(result)
      }

      let child
      try {
        child = spawn(config.command, [...extra, ...invocation.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: env as NodeJS.ProcessEnv,
          // 不用 shell：参数里可能有会议标识，shell 会多一层转义与注入面。
          shell: false,
          windowsHide: true,
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        finish({ status: 'SPAWN_FAILED', exit_code: null, signal: null, stdout: '', stderr: '', ...(code ? { spawn_error_code: code } : {}) })
        return
      }

      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        killer = setTimeout(() => child.kill('SIGKILL'), grace)
      }, invocation.timeout_ms)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        if (overflow) return
        stdout += chunk
        if (Buffer.byteLength(stdout, 'utf8') > FEISHU_CLI_MAX_OUTPUT_BYTES) {
          overflow = true
          child.kill('SIGKILL')
        }
      })
      child.stderr?.on('data', (chunk: string) => {
        if (overflow) return
        stderr += chunk
        if (Buffer.byteLength(stderr, 'utf8') > FEISHU_CLI_MAX_OUTPUT_BYTES) {
          overflow = true
          child.kill('SIGKILL')
        }
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({ status: 'SPAWN_FAILED', exit_code: null, signal: null, stdout: '', stderr: '', ...(error.code ? { spawn_error_code: error.code } : {}) })
      })
      child.on('close', (exitCode: number | null, signalName: NodeJS.Signals | null) => {
        if (overflow) {
          finish({ status: 'SPAWN_FAILED', exit_code: exitCode, signal: signalName, stdout: '', stderr: '', spawn_error_code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
          return
        }
        if (timedOut) {
          finish({ status: 'TIMEOUT', exit_code: exitCode, signal: signalName, stdout, stderr })
          return
        }
        if (signalName !== null) {
          finish({ status: 'SIGNALED', exit_code: exitCode, signal: signalName, stdout, stderr })
          return
        }
        finish({ status: exitCode === 0 ? 'OK' : 'NON_ZERO_EXIT', exit_code: exitCode, signal: null, stdout, stderr })
      })
    })
  }
}

// ---------------------------------------------------------------------------
// 脱敏：R7 的唯一闸门
// ---------------------------------------------------------------------------

/** stderr 的诊断切片（已脱敏、已截断）。**只有这个形状允许进入错误 message**。 */
export interface FeishuDiagnostic {
  /** 脱敏 + 截断后的 stderr 前缀；可能为空串。 */
  readonly stderr_head: string
  /** 原始 stderr 的字节数（不包含内容）。 */
  readonly stderr_bytes_seen: number
  /** 是否发生过截断。 */
  readonly truncated: boolean
}

/** JSON 里可能装正文/人名/标题的键，值一律抹掉。 */
const CONTENT_BEARING_KEY =
  /"(msg|message|content|text|plain_text|transcript|sentences|paragraphs|title|summary|topic|body|speakers?|participants?|sentences_text)"\s*:\s*("(?:[^"\\]|\\.)*"|\[[\s\S]*?\]|\{[\s\S]*?\})/gi

/** 连续中文/全角字符：≥8 个几乎只可能是正文或平台消息，整段抹掉。 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]{8,}/g

/** 长 token / base64 / 长 ID：抹掉（顺手防 secret 泄漏）。 */
const LONG_BLOB = /[A-Za-z0-9+/=_.-]{64,}/g

/**
 * 把 stderr 变成**可安全外传**的诊断。三层处理，顺序固定：
 *   1. 按 UTF-8 字节截断到 `limitBytes`；
 *   2. 抹掉 JSON 里 content-bearing 键的值（平台 `msg` 可能带租户内容）；
 *   3. 抹掉 ≥8 字的连续中文与 ≥64 字符的长 blob（正文/令牌形态）。
 * 诊断的价值由 `stage` + `code` + `exit_code` 承担；stderr 只是补充线索。
 * @param stderr - 子进程原始 stderr。
 * @param limitBytes - 保留多少字节；默认 `FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES`。
 * @returns 诊断切片（不含正文）。
 */
export function sanitizeDiagnostic(stderr: string, limitBytes: number = FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES): FeishuDiagnostic {
  const trimmed = typeof stderr === 'string' ? stderr.trim() : ''
  const bytesSeen = Buffer.byteLength(trimmed, 'utf8')
  const head = sliceUtf8(trimmed, Math.max(0, limitBytes))
    .replace(CONTENT_BEARING_KEY, (_match: string, key: string) => `"${String(key)}":"<redacted>"`)
    .replace(CJK_RUN, '[redacted:cjk]')
    .replace(LONG_BLOB, '[redacted:blob]')
  return { stderr_head: head, stderr_bytes_seen: bytesSeen, truncated: bytesSeen > Math.max(0, limitBytes) }
}

/**
 * 从一个（未脱敏的）诊断文本里只取飞书错误码，**不取 msg**。
 * 只认 `error.code` / `code` 的数值或数字字符串；取不到就是 `null`。
 * @param text - stderr 原文。
 */
export function extractProviderCode(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start))
  } catch {
    return null
  }
  return providerCodeOf(parsed)
}

/** 从一个对象里取飞书错误码（只认 `code` / `error.code` / `data.code`，不取 msg）。 */
function providerCodeOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const node = value as Record<string, unknown>
  const candidates: unknown[] = [node.code]
  for (const key of ['error', 'data']) {
    const nested = node[key]
    if (typeof nested === 'object' && nested !== null) candidates.push((nested as Record<string, unknown>).code)
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
    const code = readNonEmptyString(candidate)
    if (code !== null) return code
  }
  return null
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/**
 * 传输层失败。**message** 已包含 stage / code / 退出码 / 脱敏 stderr，可直接
 * 给人看；**不含**正文、argv、平台 msg（R7）。
 */
export class FeishuTransportError extends Error {
  readonly stage: FeishuTransportStage
  readonly code: FeishuTransportErrorCode
  readonly exit_code: number | null
  /** 从诊断里抽出的飞书错误码；取不到为空串（不编一个）。 */
  readonly provider_code: string
  readonly retryable: boolean
  readonly attempts: number
  readonly diagnostic: FeishuDiagnostic | null

  constructor(init: {
    readonly stage: FeishuTransportStage
    readonly code: FeishuTransportErrorCode
    readonly detail: string
    readonly exit_code?: number | null
    readonly provider_code?: string
    readonly retryable: boolean
    readonly attempts: number
    readonly diagnostic?: FeishuDiagnostic | null
  }) {
    const parts = [`stage=${init.stage}`, `code=${init.code}`]
    if (init.exit_code !== undefined && init.exit_code !== null) parts.push(`exit=${init.exit_code}`)
    if (init.provider_code !== undefined && init.provider_code !== '') parts.push(`provider_code=${init.provider_code}`)
    parts.push(`attempts=${init.attempts}`)
    const diagnostic = init.diagnostic ?? null
    const tail =
      diagnostic === null || diagnostic.stderr_head === ''
        ? ''
        : `；stderr[:${FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES}]=${diagnostic.stderr_head}${diagnostic.truncated ? '…' : ''}`
    super(`飞书 Lark CLI 传输失败（${parts.join('，')}）：${init.detail}${tail}`)
    this.name = 'FeishuTransportError'
    this.stage = init.stage
    this.code = init.code
    this.exit_code = init.exit_code ?? null
    this.provider_code = init.provider_code ?? ''
    this.retryable = init.retryable
    this.attempts = init.attempts
    this.diagnostic = diagnostic
  }
}

// ---------------------------------------------------------------------------
// 回读对象
// ---------------------------------------------------------------------------

/**
 * CLI 读回来的全文回读对象。**形状对齐 `labels.ts` 的 `TranscriptReadbackLike`**，
 * 但 `transport` 由 LIVE Gate 决定：Gate=BLOCKED 时恒 `FIXTURE`（见文件头注 1）。
 */
export interface FeishuCliTranscriptReadback {
  /** Gate 未解锁时恒 `FIXTURE`：本机无法证明字节来自飞书平台。 */
  readonly transport: FeishuTransport
  readonly minute_token: string
  /** 平台 revision（用于回执 `@<revision>`）；缺失即失败，不补默认值。 */
  readonly revision: string
  /** `lark:minutes+detail:<minute_token>@<revision>`。 */
  readonly read_receipt_ref: string
  /** 回读时刻，带本地时区偏移的 ISO-8601。 */
  readonly fetched_at: string
  /** 原文 sha256，64 位小写 hex。 */
  readonly content_sha256: string
  /** 分页全部取完才为 true（TR-C2）。 */
  readonly is_complete: boolean
  readonly raw_text: string
  readonly page_count: number
  readonly transcript_chars: number
}

/** 一页的解析结果（内部形状）。 */
interface ParsedCliPage {
  readonly has_more: unknown
  readonly page_token: string | null
  readonly revision: string | null
  readonly minute_token: string | null
  readonly text: string
  /** 本页是否存在可识别的正文容器。false + 空文本 = 形状不认识。 */
  readonly transcript_present: boolean
}

/** 传输层读一次的结局。 */
export type FeishuTransportReadResult =
  | { readonly status: 'READ'; readonly readback: FeishuCliTranscriptReadback; readonly attempts: number; readonly pages: number }
  | {
      readonly status: 'WAITING_EXTERNAL'
      readonly reason: 'GENERATING'
      readonly provider_code: string
      readonly task_state: 'WAITING_EXTERNAL'
      readonly attempts: number
      readonly message: string
      readonly creates_artifact: false
    }
  | { readonly status: 'FAILED'; readonly error: FeishuTransportError; readonly attempts: number }

/** 传输层。`kind` 恒 `lark-cli-transport`（与 `describe()` 的口径同源）。 */
export interface FeishuMinutesTranscriptTransport {
  readonly kind: typeof FEISHU_CLI_TRANSPORT_ID
  readonly read: (request: { readonly minute_token: string }) => Promise<FeishuTransportReadResult>
  readonly describe: () => FeishuTransportDescription
}

/** `transport.describe()`：把「未核实的部分」也写进机器可读出口。 */
export interface FeishuTransportDescription {
  readonly transport: typeof FEISHU_CLI_TRANSPORT_ID
  readonly command_constant: string
  readonly timeout_ms: number
  readonly max_attempts: number
  readonly retry_base_ms: number
  readonly page_size: number
  readonly max_pages: number
  readonly diagnostic_bytes: number
  readonly live_gate: typeof FEISHU_MINUTES_LIVE_GATE
  /** Gate 未解锁时恒 `FIXTURE`：读成功也不冒充平台来源。 */
  readonly readback_transport: FeishuTransport
  /** 参数名核实状态（恒 false，直到有人对着 --help 核对过）。 */
  readonly argument_flags_verified: false
  /** 信封形状核实状态（恒 false）。 */
  readonly envelope_verified: false
  readonly note: string
}

// ---------------------------------------------------------------------------
// 纯函数：回执 / 时间 / 哈希
// ---------------------------------------------------------------------------

/**
 * 构造读取回执 `lark:minutes+detail:<minute_token>@<revision>`。
 * 只做拼接，不做转义：`minute_token` / `revision` 由平台给，含 `@` 会被
 * `validate` 阶段拒绝（见 `read()`）。
 * @param minuteToken - 平台 minute_token。
 * @param revision - 平台 revision。
 */
export function buildReadReceipt(minuteToken: string, revision: string): string {
  return `lark:minutes+detail:${minuteToken}@${revision}`
}

/** 原文 sha256（64 位小写 hex）。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 两位补零。 */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * ISO-8601 + **本地时区偏移**（`labels.ts` 的 `fetched_at` 只收带偏移的时间）。
 * @param date - 时刻，默认现在。
 */
export function isoWithOffset(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const abs = Math.abs(offsetMinutes)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

/**
 * 回读对象应当声明的 `transport`。
 * **Gate=BLOCKED 时恒 `FIXTURE`**：本机没有真实凭据，读成功也不能自称平台来源。
 * 只有人按 README §6 解锁 Gate 之后，这里才可能给出 `FEISHU_MINUTES_API`。
 */
export function readbackTransport(): FeishuTransport {
  return FEISHU_MINUTES_LIVE_GATE === 'BLOCKED' ? FEISHU_TRANSPORT.fixture : FEISHU_TRANSPORT.api
}

// ---------------------------------------------------------------------------
// 解析：信封 → 一页
// ---------------------------------------------------------------------------

/** 读 `has_more`：只接受布尔；缺省即「不知道」，由调用方按未读完处理。 */
function readHasMore(value: unknown): unknown {
  return typeof value === 'boolean' ? value : undefined
}

/** 从 `transcript` 容器里取正文；形状不认识返回 null。 */
function textFromTranscript(container: unknown): string | null {
  if (typeof container === 'string') return container
  if (typeof container !== 'object' || container === null) return null
  const node = container as Record<string, unknown>
  const chars = readNonEmptyString(node.text)
  if (chars !== null) return chars
  for (const key of ['sentences', 'paragraphs']) {
    const list = node[key]
    if (!Array.isArray(list)) continue
    const lines: string[] = []
    for (const item of list) {
      if (typeof item === 'string') {
        lines.push(item)
        continue
      }
      if (typeof item !== 'object' || item === null) continue
      const text = readNonEmptyString((item as Record<string, unknown>).text)
      if (text !== null) lines.push(text)
    }
    if (lines.length > 0) return lines.join('\n')
  }
  return null
}

/**
 * 解析 CLI 的一页输出。fail-closed：形状不认识就抛 `parse` 阶段错误。
 * @param stdout - 子进程 stdout。
 * @param attempts - 本次尝试次数（进诊断）。
 */
function parseCliPage(stdout: string, attempts: number): ParsedCliPage {
  let root: unknown
  try {
    root = JSON.parse(stdout)
  } catch {
    // 非 JSON 输出里可能有正文：**整段丢弃**，只报字节数。
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'ENVELOPE_UNRECOGNIZED',
      detail: `CLI 输出不是 JSON（${Buffer.byteLength(stdout, 'utf8')} 字节，内容不保留、不回显）。`,
      retryable: false,
      attempts,
    })
  }
  if (typeof root !== 'object' || root === null) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'ENVELOPE_UNRECOGNIZED',
      detail: 'CLI 输出的 JSON 根不是对象。',
      retryable: false,
      attempts,
    })
  }
  const envelope = root as Record<string, unknown>
  if ('ok' in envelope && envelope.ok !== true) {
    // `{ok:false, error:{code}}`：这里只认错误码，不回显 msg。
    const code = providerCodeOf(envelope)
    throw new FeishuTransportError({
      stage: 'invoke',
      code: code === '2091005' ? 'PROVIDER_NO_PERMISSION' : 'PROVIDER_REJECTED',
      detail:
        code === '2091005'
          ? '飞书返回 2091005（无读取权限）：不重试、不产出正文，交人工重新授权（TR-F2）。'
          : 'CLI 报 ok=false 且不是已核对的可重试错误：不猜语义、不产出正文。',
      provider_code: code ?? '',
      retryable: false,
      attempts,
      diagnostic: sanitizeDiagnostic(JSON.stringify(envelope.error ?? '')),
    })
  }
  const data = envelope.ok === true ? envelope.data : envelope
  if (typeof data !== 'object' || data === null) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'ENVELOPE_UNRECOGNIZED',
      detail: 'CLI 信封里没有 data 对象。',
      retryable: false,
      attempts,
    })
  }
  const page = data as Record<string, unknown>
  const transcript = textFromTranscript(page.transcript)
  const flat = transcript === null ? readNonEmptyString(page.text) : transcript
  const text = flat ?? ''
  if (flat === null && text === '' && page.transcript === undefined && page.text === undefined) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'TRANSCRIPT_UNRECOGNIZED',
      detail: 'CLI 返回里找不到可识别的正文容器（transcript.sentences / transcript.paragraphs / transcript.text）：拒绝把不认识的输出当逐字稿。',
      retryable: false,
      attempts,
    })
  }
  return {
    has_more: readHasMore(page[FEISHU_MINUTES_PAGINATION.has_more]),
    page_token: readNonEmptyString(page[FEISHU_MINUTES_PAGINATION.page_token]),
    revision: readNonEmptyString(page.revision) ?? readNonEmptyString(page.minute_revision),
    minute_token: readNonEmptyString(page.minute_token),
    text,
    transcript_present: flat !== null,
  }
}

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

/** `createLarkCliTransport()` 的配置。除 `runner` 外全部有默认值。 */
export interface FeishuLarkCliTransportConfig {
  /** **必填**：怎么跑 CLI。生产用 `createProcessCliRunner()`，测试用假 runner。 */
  readonly runner: FeishuCliRunner
  readonly timeout_ms?: number
  readonly max_attempts?: number
  readonly retry_base_ms?: number
  readonly page_size?: number
  readonly max_pages?: number
  readonly diagnostic_bytes?: number
  /** 追加到 `FEISHU_LARK_CLI.minutesDetailTranscript` 之后的固定参数。 */
  readonly extra_args?: readonly string[]
  /** 时钟（测试注入）。 */
  readonly now?: () => Date
  /** 退避等待（测试注入；`retry_base_ms=0` 时不调用）。 */
  readonly sleep?: (ms: number) => Promise<void>
}

/** 默认 sleep。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * 把 `FEISHU_LARK_CLI.minutesDetailTranscript` 拆成 argv。
 * 只做空格切分（该常量里没有引号），保证「契约常量 → 实际调用」是同一份。
 * @param extraArgs - 追加参数。
 */
export function buildTranscriptArgs(extraArgs: readonly string[] = []): string[] {
  return [...FEISHU_LARK_CLI.minutesDetailTranscript.split(/\s+/).filter((part) => part !== ''), ...extraArgs]
}

/**
 * 造一个 `lark-cli-transport`。
 *
 * 读一次的流程（照抄参考实现的四段循环）：
 *   locate → invoke（带超时 + 指数退避重试）→ parse（信封/正文）→
 *   paginate（`isPageComplete` 走到 `has_more=false`）→ validate（回执/sha/时间）。
 *
 * 失败的三种落点：`WAITING_EXTERNAL`（2091003，不是失败）、`FAILED`（带
 * `stage`/`code`/退出码/脱敏 stderr）、`READ`（带完整回读对象）。
 * @param config - 见 `FeishuLarkCliTransportConfig`；`runner` 必填。
 */
export function createLarkCliTransport(config: FeishuLarkCliTransportConfig): FeishuMinutesTranscriptTransport {
  const runner = config.runner
  const timeoutMs = config.timeout_ms ?? FEISHU_CLI_DEFAULT_TIMEOUT_MS
  const maxAttempts = Math.max(1, config.max_attempts ?? FEISHU_CLI_DEFAULT_MAX_ATTEMPTS)
  const retryBase = Math.max(0, config.retry_base_ms ?? FEISHU_CLI_DEFAULT_RETRY_BASE_MS)
  const pageSize = Math.max(1, config.page_size ?? FEISHU_MINUTES_DEFAULT_PAGE_SIZE)
  const maxPages = Math.max(1, config.max_pages ?? FEISHU_CLI_DEFAULT_MAX_PAGES)
  const diagnosticBytes = Math.max(0, config.diagnostic_bytes ?? FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES)
  const extraArgs = config.extra_args ?? []
  const now = config.now ?? ((): Date => new Date())
  const sleep = config.sleep ?? defaultSleep

  /** 退避：base * 2^(n-1)，封顶 `FEISHU_CLI_MAX_RETRY_DELAY_MS`。 */
  function backoff(attempt: number): number {
    if (retryBase === 0) return 0
    return Math.min(retryBase * 2 ** Math.max(0, attempt - 1), FEISHU_CLI_MAX_RETRY_DELAY_MS)
  }

  /** 一次调用的失败 → `FeishuTransportError`（含脱敏诊断）。 */
  function errorFromRun(result: FeishuCliRunResult, attempt: number): FeishuTransportError {
    const diagnostic = sanitizeDiagnostic(result.stderr, diagnosticBytes)
    const providerCode = extractProviderCode(result.stderr) ?? ''
    if (result.status === 'SPAWN_FAILED') {
      const spawnCode = result.spawn_error_code ?? ''
      const notFound = spawnCode === 'ENOENT'
      const detail = notFound
        ? '找不到可执行的 Lark CLI（ENOENT）：CLI 未安装或不在配置的绝对路径上。不得依赖开发者全局 profile 当产品凭据。'
        : spawnCode === 'EACCES' || spawnCode === 'EPERM'
          ? `Lark CLI 不可执行（${spawnCode}）：检查文件权限。`
          : `Lark CLI 起不来（${spawnCode === '' ? '未知系统错误' : spawnCode}）。`
      return new FeishuTransportError({
        stage: 'locate-cli',
        code: notFound ? 'CLI_NOT_FOUND' : spawnCode === 'EACCES' || spawnCode === 'EPERM' ? 'CLI_NOT_EXECUTABLE' : 'CLI_SPAWN_FAILED',
        detail,
        retryable: !notFound && spawnCode !== 'EACCES' && spawnCode !== 'EPERM',
        attempts: attempt,
        diagnostic,
        provider_code: providerCode,
      })
    }
    if (result.status === 'TIMEOUT') {
      return new FeishuTransportError({
        stage: 'invoke',
        code: 'CLI_TIMEOUT',
        detail: `调用 Lark CLI 超时（timeout=${timeoutMs} ms）：已终止子进程，重试仍失败则不产出正文。`,
        retryable: true,
        attempts: attempt,
        diagnostic,
        provider_code: providerCode,
      })
    }
    if (result.status === 'SIGNALED') {
      return new FeishuTransportError({
        stage: 'invoke',
        code: 'CLI_SPAWN_FAILED',
        detail: `Lark CLI 被信号 ${String(result.signal)} 终止。`,
        retryable: true,
        attempts: attempt,
        diagnostic,
        provider_code: providerCode,
      })
    }
    if (providerCode === '2091005') {
      return new FeishuTransportError({
        stage: 'invoke',
        code: 'PROVIDER_NO_PERMISSION',
        detail: '飞书返回 2091005（无读取权限）：不重试、不产出正文，交人工重新授权（TR-F2）。',
        exit_code: result.exit_code,
        provider_code: providerCode,
        retryable: false,
        attempts: attempt,
        diagnostic,
      })
    }
    return new FeishuTransportError({
      stage: 'invoke',
      code: 'CLI_NON_ZERO_EXIT',
      detail: 'Lark CLI 退出码非 0，且诊断里没有已核对的可重试错误码：不猜语义、不产出正文。',
      exit_code: result.exit_code,
      provider_code: providerCode,
      retryable: true,
      attempts: attempt,
      diagnostic,
    })
  }

  /** 调一次（含重试）；`2091003` 不算失败，直接返回 WAITING_EXTERNAL 信号。 */
  async function callOnce(args: readonly string[]): Promise<
    { readonly kind: 'PAGE'; readonly page: ParsedCliPage; readonly attempts: number } | { readonly kind: 'GENERATING'; readonly attempts: number }
  > {
    let lastError: FeishuTransportError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runner({ args, timeout_ms: timeoutMs, attempt })
      if (result.status === 'OK') {
        // 先看信封里的飞书错误码：ok=false + 2091003 是「生成中」，不是失败。
        const providerCode = extractProviderCode(result.stdout)
        if (providerCode === '2091003') return { kind: 'GENERATING', attempts: attempt }
        try {
          return { kind: 'PAGE', page: parseCliPage(result.stdout, attempt), attempts: attempt }
        } catch (error) {
          if (error instanceof FeishuTransportError) {
            // 解析/权限类错误不重试：同样的输入重跑一次还是同样的形状。
            throw error
          }
          throw new FeishuTransportError({
            stage: 'parse',
            code: 'ENVELOPE_UNRECOGNIZED',
            detail: `解析 CLI 输出时抛出非预期异常（${error instanceof Error ? error.name : typeof error}）。`,
            retryable: false,
            attempts: attempt,
          })
        }
      }
      const failure = errorFromRun(result, attempt)
      // 非零退出也可能是「生成中」：lark-cli 会把平台错误码打到 stderr，同样按 2091003 处理。
      if (failure.provider_code === '2091003') return { kind: 'GENERATING', attempts: attempt }
      if (!failure.retryable) throw failure
      lastError = failure
      if (attempt < maxAttempts) {
        const delay = backoff(attempt)
        if (delay > 0) await sleep(delay)
      }
    }
    throw lastError ?? new FeishuTransportError({ stage: 'invoke', code: 'CLI_SPAWN_FAILED', detail: '没有拿到任何结果。', retryable: false, attempts: maxAttempts })
  }

  async function read(request: { readonly minute_token: string }): Promise<FeishuTransportReadResult> {
    const minuteToken = readNonEmptyString(request?.minute_token)
    if (minuteToken === null) {
      return {
        status: 'FAILED',
        attempts: 0,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'READBACK_INVALID',
          detail: '缺 minute_token：没有平台产物标识就不能调用 CLI。',
          retryable: false,
          attempts: 0,
        }),
      }
    }

    const base = buildTranscriptArgs(extraArgs)
    let cursor: string | null = null
    const texts: string[] = []
    let revision: string | null = null
    let pageCount = 0
    let totalAttempts = 0
    let complete = false

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const args = [...base, FEISHU_CLI_TRANSCRIPT_FLAGS.minute_token, minuteToken, FEISHU_CLI_TRANSCRIPT_FLAGS.page_size, String(pageSize)]
      if (cursor !== null) args.push(FEISHU_CLI_TRANSCRIPT_FLAGS.page_token, cursor)
      let outcome
      try {
        outcome = await callOnce(args)
      } catch (error) {
        const failure =
          error instanceof FeishuTransportError
            ? error
            : new FeishuTransportError({
                stage: 'invoke',
                code: 'CLI_SPAWN_FAILED',
                detail: '调用 CLI 时抛出非预期异常。',
                retryable: false,
                attempts: pageIndex + 1,
              })
        return { status: 'FAILED', error: failure, attempts: totalAttempts + failure.attempts }
      }
      totalAttempts += outcome.attempts
      if (outcome.kind === 'GENERATING') {
        // 「生成中」按已核对错误码映射成 WAITING_EXTERNAL，不当失败（TR-F1 / P-3）。
        const mapped = mapFeishuError('2091003')
        return {
          status: 'WAITING_EXTERNAL',
          reason: 'GENERATING',
          provider_code: '2091003',
          task_state: mapped.task_state as 'WAITING_EXTERNAL',
          attempts: totalAttempts,
          message: mapped.message,
          creates_artifact: false,
        }
      }
      const page = outcome.page
      pageCount += 1
      if (revision === null) revision = page.revision
      if (page.minute_token !== null && page.minute_token !== minuteToken) {
        return {
          status: 'FAILED',
          attempts: totalAttempts,
          error: new FeishuTransportError({
            stage: 'validate',
            code: 'READBACK_INVALID',
            detail: '平台回显的 minute_token 与请求的不一致：拒绝把别的会议内容当本次产物。',
            retryable: false,
            attempts: outcome.attempts,
          }),
        }
      }
      if (page.transcript_present && page.text.trim() !== '') texts.push(page.text)
      if (isPageComplete({ has_more: page.has_more, page_token: page.page_token ?? undefined })) {
        complete = true
        break
      }
      // 没读完：必须给出**前进**的游标，否则就是分页缺陷，不能拿半截当全文。
      if (page.has_more !== true) {
        return {
          status: 'FAILED',
          attempts: totalAttempts,
          error: new FeishuTransportError({
            stage: 'paginate',
            code: 'PAGINATION_INCOMPLETE',
            detail: 'has_more 缺失或不是布尔：按「没读完」处理，内容不完整就不产出 artifact（TR-C2）。',
            retryable: false,
            attempts: outcome.attempts,
          }),
        }
      }
      if (page.page_token === null) {
        return {
          status: 'FAILED',
          attempts: totalAttempts,
          error: new FeishuTransportError({
            stage: 'paginate',
            code: 'PAGINATION_STALLED',
            detail: 'has_more=true 但没有下一页游标：分页卡住，不能拿半截当全文。',
            retryable: false,
            attempts: outcome.attempts,
          }),
        }
      }
      if (cursor !== null && page.page_token === cursor) {
        return {
          status: 'FAILED',
          attempts: totalAttempts,
          error: new FeishuTransportError({
            stage: 'paginate',
            code: 'PAGINATION_STALLED',
            detail: '下一页游标与本次相同：分页没有前进，不能拿半截当全文。',
            retryable: false,
            attempts: outcome.attempts,
          }),
        }
      }
      cursor = page.page_token
    }

    if (!complete) {
      return {
        status: 'FAILED',
        attempts: totalAttempts,
        error: new FeishuTransportError({
          stage: 'paginate',
          code: 'PAGE_LIMIT_EXCEEDED',
          detail: `分页超过上限 ${maxPages} 页仍未走完：内容可能不完整，不产出 artifact。`,
          retryable: false,
          attempts: 1,
        }),
      }
    }

    const rawText = texts.join('\n')
    if (revision === null) {
      return {
        status: 'FAILED',
        attempts: totalAttempts,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'REVISION_REQUIRED',
          detail: 'CLI 返回里没有 revision：回执 lark:minutes+detail:<token>@<revision> 拼不出来，不补默认值。',
          retryable: false,
          attempts: 1,
        }),
      }
    }
    if (rawText.trim() === '') {
      return {
        status: 'FAILED',
        attempts: totalAttempts,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'TRANSCRIPT_EMPTY',
          detail: '分页走完但正文为空：空正文不能当产物（P-2）。',
          retryable: false,
          attempts: 1,
        }),
      }
    }
    if (minuteToken.includes('@') || revision.includes('@')) {
      return {
        status: 'FAILED',
        attempts: totalAttempts,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'READBACK_INVALID',
          detail: 'minute_token 或 revision 含 @：回执格式会被破坏，拒绝产出。',
          retryable: false,
          attempts: 1,
        }),
      }
    }

    const readback: FeishuCliTranscriptReadback = {
      transport: readbackTransport(),
      minute_token: minuteToken,
      revision,
      read_receipt_ref: buildReadReceipt(minuteToken, revision),
      fetched_at: isoWithOffset(now()),
      content_sha256: sha256Hex(rawText),
      is_complete: true,
      raw_text: rawText,
      page_count: pageCount,
      transcript_chars: rawText.length,
    }
    return { status: 'READ', readback, attempts: totalAttempts, pages: pageCount }
  }

  function describe(): FeishuTransportDescription {
    return {
      transport: FEISHU_CLI_TRANSPORT_ID,
      command_constant: FEISHU_LARK_CLI.minutesDetailTranscript,
      timeout_ms: timeoutMs,
      max_attempts: maxAttempts,
      retry_base_ms: retryBase,
      page_size: pageSize,
      max_pages: maxPages,
      diagnostic_bytes: diagnosticBytes,
      live_gate: FEISHU_MINUTES_LIVE_GATE,
      readback_transport: readbackTransport(),
      argument_flags_verified: false,
      envelope_verified: false,
      note:
        'lark-cli-transport 已实现：子进程调 FEISHU_LARK_CLI.minutesDetailTranscript，带超时/指数退避/分页/回执。' +
        '但参数名与信封形状**未核实**，且本机 Live Gate=BLOCKED，所以读成功也只给 transport=FIXTURE。',
    }
  }

  return { kind: FEISHU_CLI_TRANSPORT_ID, read, describe }
}
