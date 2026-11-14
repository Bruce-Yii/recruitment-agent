// 飞书 Minutes **传输层**：`lark-cli-transport`（子进程读全文 + 重读校验 + 重试 + 超时）。
//
// 这是本连接器**唯一**允许发起外部调用的文件。2026-11-14 在本机对着真实
// lark-cli 1.0.81 核对过形态（`minutes +detail --help` + 两次真实读取，见
// `evidence/experiments/2026-11-14-feishu-live-read/`）：
//
//   命令：`lark-cli [--profile <name>] minutes +detail --as user --minute-tokens <token> --transcript --output-dir <相对目录>`
//         （`--profile` 是**全局 flag**，必须写在 `minutes` 之前；不传会回退默认档案，
//          接线层因此要求 `feishu.cli` 与 `feishu.profile` 同时配置，见 `wiring.ts`。）
//   stdout：`{ok, identity, data:{minutes:[{minute_token, title, artifacts:{transcript_file}}]}, meta}`
//   正文：**不在 stdout**，在 `transcript_file`（相对子进程 cwd 的落盘文件）里；
//         传输层把文件读成字节、算 sha256、再删掉临时目录（正文不留在仓库/日志里）。
//
// 三条不许破的规矩：
//
//   1. **通道身份由接线层负责，证据由本文件产出**：`createLarkCliTransport` 的
//      `platform_channel` 只有接线层（`wiring.ts`，插件配置里的 `feishu.cli`
//      绝对路径）才会置 true。置 false（默认）= 测试 / 回放通道，回读对象的
//      `transport` 恒 `FIXTURE`，读成功也不可能 LIVE。
//      platform_channel=true 时本文件会**再完整读一次**做重读校验：两次的
//      sha256 必须一致，不一致直接失败（`READBACK_INVALID`），不产出正文；
//      一致才把 `reread_sha256` 写进回读对象，交 `evaluateLiveGate()` 判定。
//   2. **失败要说清哪一步**：`stage` ∈ {locate-cli, invoke, parse, read-output,
//      validate}，外加原始退出码与脱敏后的 stderr 前 N 字节。诊断里**永不**
//      出现正文、argv、平台 `msg`（R7：不把候选人内容写进任何日志）。
//   3. **不猜、不补**：信封形状不认识、`transcript_file` 缺失、文件不存在 /
//      越出工作目录 / 不是合法 UTF-8、正文为空 —— 一律失败（fail-closed），
//      绝不用空串或默认值凑一个回读。
//
// 「生成中」不是失败：`2091003` 经 `mapFeishuError()` 映射成
// `task_state='WAITING_EXTERNAL'`，调用方去等新事件或人工重试（TR-F1）。
//
// `argument_flags_verified` / `envelope_verified` **不是常量**：前者由一次真实
// `--help` 探测（或成功真实调用）决定，后者只由成功解析过真实信封决定，
// 默认 false；见 `verifyContract()`。
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import {
  FEISHU_LARK_CLI,
  FEISHU_LIVE_GATE_POLICY,
  mapFeishuError,
  readNonEmptyString,
  FEISHU_TRANSPORT,
  type FeishuLiveGatePolicy,
  type FeishuTransport,
} from './contract.ts'
import {
  isLiveEligible,
  liveEligibilityViolations,
  sha256Hex,
} from './labels.ts'

export { sha256Hex }

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

/** 子进程 stdout / 转写文件硬上限（超了直接杀掉或拒绝，避免内存被灌爆）。 */
export const FEISHU_CLI_MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/** 工作目录前缀（`mkdtemp` 用；读完即删，正文不留在磁盘上）。 */
export const FEISHU_CLI_WORKDIR_PREFIX = 'feishu-minutes-'

/** 相对 `--output-dir`（真实 CLI 要求相对路径；工作目录由本层每次读取新建）。 */
export const FEISHU_CLI_DEFAULT_OUTPUT_DIR = 'minutes'

/** `--as` 的取值：妙记是 user identity（2026-11-14 实测 `--as user` 可用）。 */
export const FEISHU_CLI_IDENTITY = 'user'

/**
 * 全局 `--profile` flag（2026-11-15 实测：`lark-cli --profile <name> <domain> …`，
 * **必须写在子命令之前**）。不给 profile 时 lark-cli 会回退到默认档案（本机是
 * 开发者全局 profile `cli_aae49f8438f8dce4`），这正是 `AGENTS.md §7.6` 禁止的
 * 「拿开发者全局 CLI 当产品凭据」那条路，所以接线层要求 `cli` 与 `profile` 同时配置。
 */
export const FEISHU_CLI_PROFILE_FLAG = '--profile'

/**
 * `minutes +detail` 的真实 flag（2026-11-14 逐字核对 `lark-cli minutes +detail --help`）。
 * 复数 `--minute-tokens`（逗号分隔批量）是实测事实，不要改回单数。
 */
export const FEISHU_CLI_TRANSCRIPT_FLAGS = {
  as: '--as',
  minute_tokens: '--minute-tokens',
  transcript: '--transcript',
  output_dir: '--output-dir',
  /** 其它 artifact flag（本次只验证了 `--transcript` 可用，其余同名 flag 来自 --help）。 */
  summary: '--summary',
  chapter: '--chapter',
  todo: '--todo',
  keyword: '--keyword',
} as const

/** `+search` 的真实 flag（2026-11-14 实测；`data.items[].token` 不叫 minute_token）。 */
export const FEISHU_CLI_SEARCH_FLAGS = {
  as: '--as',
  owner_ids: '--owner-ids',
  page_size: '--page-size',
} as const

/** `minutes +detail --help` 的 argv（真实探测用，不带 token、不带输出目录）。 */
export const FEISHU_CLI_DETAIL_HELP_ARGS = ['minutes', '+detail', '--help'] as const

/** `--help` 输出里必须出现的 flag（缺一个就说明真实 CLI 形态变了）。 */
export const FEISHU_CLI_REQUIRED_HELP_FLAGS = [
  FEISHU_CLI_TRANSCRIPT_FLAGS.as,
  FEISHU_CLI_TRANSCRIPT_FLAGS.minute_tokens,
  FEISHU_CLI_TRANSCRIPT_FLAGS.transcript,
  FEISHU_CLI_TRANSCRIPT_FLAGS.output_dir,
] as const

/** 参数名的核实状态注记（引用这个常量，不要另写一份口径）。 */
export const FEISHU_CLI_TRANSCRIPT_FLAGS_NOTE =
  '已实测（2026-11-14，lark-cli 1.0.81，`minutes +detail --help` + 两次真实读取）：'
  + '`--as user`、`--minute-tokens`（**复数**、逗号分隔批量）、`--transcript`、`--output-dir`'
  + '（**必须相对路径**，绝对路径会被 CLI 拒绝）；另有 `--summary/--chapter/--todo/--keyword`。'
  + '`+search` 用 `--as user --owner-ids me --page-size N`。'

/** CLI 输出信封的核实状态注记（真实读取核对过）。 */
export const FEISHU_CLI_ENVELOPE_NOTE =
  '已实测（2026-11-14）：stdout 是纯 JSON（进度日志走 stderr），形状为 '
  + '`{ok, identity, data:{minutes:[{minute_token, title, note_id, artifacts:{transcript_file}}]}, meta:{count}}`；'
  + '**转写正文不在 stdout**，在 `artifacts.transcript_file` 指向的落盘文件里（相对子进程 cwd）。'
  + '形状不认识时一律失败（fail-closed），不猜。'

// ---------------------------------------------------------------------------
// 四段循环的第 0 段：把「跑一条 CLI」抽成可注入的 runner
// ---------------------------------------------------------------------------

/** 传输失败落在哪一段。诊断 message 必须点名这一段。 */
export type FeishuTransportStage = 'locate-cli' | 'invoke' | 'parse' | 'read-output' | 'validate'

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
  /** 落盘文件读不出来 / 越界 / 不是合法 UTF-8（read-output）。 */
  | 'OUTPUT_FILE_MISSING'
  | 'OUTPUT_FILE_INVALID'
  /** 回读对象自检不过（validate）。 */
  | 'TRANSCRIPT_EMPTY'
  | 'READBACK_INVALID'

/**
 * 一次子进程调用的入参。
 * 只给 **argv**：可执行文件由 runner 自己配置（`createProcessCliRunner({command})`），
 * 传输层不碰「CLI 从哪来」这件事，也就没有「悄悄用 PATH 上的全局 CLI」这条路。
 * **argv 永不进入任何诊断**（可能带会议标识）。
 */
export interface FeishuCliInvocation {
  readonly args: readonly string[]
  readonly timeout_ms: number
  /** 本次是第几次尝试（从 1 开始），只用于日志/测试观察。 */
  readonly attempt: number
  /**
   * 子进程工作目录。`--output-dir` 是相对路径，CLI 会把转写写在 `cwd/<output-dir>/…`；
   * 传输层每次读取新建一个临时目录，读完即删（正文不留在仓库 / 日志里）。
   * 不给 = 继承 runner 配置 / 调用进程的 cwd。
   */
  readonly cwd?: string
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
  /** 固定工作目录；调用级 `invocation.cwd` 优先。默认继承当前进程 cwd。 */
  readonly cwd?: string
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
          cwd: invocation.cwd ?? config.cwd ?? process.cwd(),
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

/** lark-cli **配置/授权层**错误的结构投影（只取结构字段，不取 message）。 */
export interface FeishuCliConfigFailure {
  /** `error.type`；不是字符串时 null。 */
  readonly type: string | null
  /** `error.subtype`；不是字符串时 null。 */
  readonly subtype: string | null
}

/**
 * 识别「lark-cli 配置/授权层失败」。
 *
 * 2026-11-15 实测坏 profile 的形态：**exit 3、stdout 为空、stderr 是 JSON**：
 * `{"ok":false,"identity":"user","error":{"type":"config","subtype":"not_configured",
 *   "message":"profile \"…\" not found","hint":"available profiles: …"},"_notice":{…}}`。
 * 这类失败**不是传输抖动**（重试不可能变好），也不是「生成中」。只认：
 *   * `error.type ∈ {config, auth}`，或
 *   * `error.subtype === 'not_configured'`；
 * 其它形状（含非 JSON、别的 type）返回 null，交原有逻辑处理。
 * **不取 message**：平台/CLI 的 message 可能带租户内容或 profile 名，不进诊断文本
 * （原文只经 `sanitizeDiagnostic()` 之后才可能出现在 stderr 切片里）。
 * @param stderr - 子进程 stderr 原文。
 * @returns 结构投影；不是配置/授权层失败时返回 null（不猜）。
 */
export function detectCliConfigFailure(stderr: string): FeishuCliConfigFailure | null {
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  if (!text.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const nested = (parsed as Record<string, unknown>).error
  if (typeof nested !== 'object' || nested === null) return null
  const error = nested as Record<string, unknown>
  const type = typeof error.type === 'string' ? error.type : null
  const subtype = typeof error.subtype === 'string' ? error.subtype : null
  if (type === 'config' || type === 'auth') return { type, subtype }
  if (subtype === 'not_configured') return { type, subtype }
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
 * 但 `transport` 由**通道身份 + 本次证据**决定：`platform_channel=false`（测试 /
 * 回放通道）恒 `FIXTURE`；`platform_channel=true` 且重读校验一致才是
 * `FEISHU_MINUTES_API`。`transport` 不是自报来源，是「这条 runner 是不是平台通道」
 * 这一接线事实 + 「这次回读是否完整自洽」两个条件的合取。
 */
export interface FeishuCliTranscriptReadback {
  /** 平台通道 + 证据齐全时才是 `FEISHU_MINUTES_API`；否则恒 `FIXTURE`。 */
  readonly transport: FeishuTransport
  readonly minute_token: string
  /** 平台 revision（真实信封没给就省略；回执绑的是内容哈希，不是 revision）。 */
  readonly revision?: string
  /** `lark:minutes+detail:<minute_token>@sha256:<content_sha256>`。 */
  readonly read_receipt_ref: string
  /** 回读时刻，带本地时区偏移的 ISO-8601。 */
  readonly fetched_at: string
  /** 落盘正文的 sha256（对文件字节算，64 位小写 hex）。 */
  readonly content_sha256: string
  /**
   * 第二次独立完整回读得到的 sha256（重读校验）。只有 `platform_channel=true`
   * 才会出现；它与 `content_sha256` 逐字相等——不一致时本函数直接失败，不产出回读。
   */
  readonly reread_sha256?: string
  /**
   * 完整性结论。`+detail --transcript` 是**整文件写盘**操作（CLI 一次写完整份
   * 转写、没有分页），文件存在且非空 + token 回显一致即视为完整；`has_more` /
   * 分页概念不适用于本条路径（TR-C2 的「不许半截」由「整文件 + 非空 + token 一致」承担）。
   */
  readonly is_complete: boolean
  readonly raw_text: string
  /** 触发方式：CLI 回读不涉及事件，恒 `MANUAL`（D-1 口径）。 */
  readonly trigger: 'MANUAL'
  /** CLI stdout 里给出的落盘相对路径（`artifacts.transcript_file`，只作证据，不留存）。 */
  readonly transcript_file: string
  /** 落盘文件字节数（= sha256 的输入字节数）。 */
  readonly file_bytes: number
  /** 读取次数口径：整文件操作恒 1（保留字段给调用方渲染）。 */
  readonly page_count: number
  readonly transcript_chars: number
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

/**
 * CLI 形态的真实探测证据（`argument_flags_verified` / `envelope_verified` 的来源）。
 * 全部默认 false，**只有真实探测 / 真实成功调用**才会变成 true。
 */
export interface FeishuCliContractEvidence {
  /** `--help` 里是否逐字出现全部必需 flag（`FEISHU_CLI_REQUIRED_HELP_FLAGS`）。 */
  readonly argument_flags_verified: boolean
  /** 是否成功解析过一次真实 JSON 信封（`data.minutes[].artifacts.transcript_file`）。 */
  readonly envelope_verified: boolean
  /** 探测时刻（带偏移 ISO-8601）；从没探测过 = null。 */
  readonly checked_at: string | null
  /** 是否真的跑过 `--help`。 */
  readonly help_checked: boolean
  /** `--help` 的退出码（没跑过 = null）。 */
  readonly help_exit_code: number | null
  /** `--help` 里缺的必需 flag（空数组 = 全齐）。 */
  readonly missing_flags: readonly string[]
  readonly note: string
}

/** 传输层。`kind` 恒 `lark-cli-transport`（与 `describe()` 的口径同源）。 */
export interface FeishuMinutesTranscriptTransport {
  readonly kind: typeof FEISHU_CLI_TRANSPORT_ID
  readonly read: (request: { readonly minute_token: string }) => Promise<FeishuTransportReadResult>
  readonly describe: () => FeishuTransportDescription
  /**
   * 跑一次真实 `lark-cli minutes +detail --help`，按**真实输出**判定
   * `argument_flags_verified`（缺 flag 就是 false）。`envelope_verified` 不会被
   * `--help` 置 true——信封形状只能由一次成功的真实读取证明。不抛异常。
   */
  readonly verifyContract: () => Promise<FeishuCliContractEvidence>
}

/** `transport.describe()`：把「已核实 / 未核实」都写进机器可读出口。 */
export interface FeishuTransportDescription {
  readonly transport: typeof FEISHU_CLI_TRANSPORT_ID
  readonly command_constant: string
  readonly timeout_ms: number
  readonly max_attempts: number
  readonly retry_base_ms: number
  readonly diagnostic_bytes: number
  /** Gate 口径名（不是开关）：`EVIDENCE_DRIVEN`。 */
  readonly live_gate: FeishuLiveGatePolicy
  /** 这条 runner 是否被接线层声明为真实平台通道。 */
  readonly platform_channel: boolean
  /**
   * 是否配置了 lark-cli profile（`--profile <name>`）。**只报布尔、不输出名字**：
   * profile 名不是 secret，但诊断里也没有必要带它（argv 不外泄的既有纪律）。
   */
  readonly profile_configured: boolean
  /** 该通道的**标称**回读 transport；某个回读到底算不算 LIVE，由证据判定。 */
  readonly readback_transport: FeishuTransport
  /** 参数名核实状态：由真实 `--help` 探测 / 成功真实调用决定，默认 false。 */
  readonly argument_flags_verified: boolean
  /** 信封形状核实状态：由成功解析过真实信封决定，默认 false。 */
  readonly envelope_verified: boolean
  /** 最近一次真实探测 / 成功调用的时刻；从没有过 = null。 */
  readonly contract_checked_at: string | null
  /** `--help` 里缺的必需 flag（空数组 = 全齐 / 还没探测）。 */
  readonly missing_flags: readonly string[]
  readonly note: string
}

// ---------------------------------------------------------------------------
// 纯函数：回执 / 时间 / 哈希
// ---------------------------------------------------------------------------

/**
 * 构造读取回执 `lark:minutes+detail:<minute_token>@sha256:<content_sha256>`。
 *
 * 回执必须**绑到这次读到的字节**：只写 `@<revision>` 无法证明「回执说的那次读」
 * 与「这次产出的正文」是同一份字节，所以 D-1 口径要求回执带内容哈希。
 * 只做拼接，不做转义：`minute_token` 含 `@` 会被 `validate` 阶段拒绝（见 `read()`）。
 * @param minuteToken - 平台 minute_token。
 * @param contentSha256 - 原文的 64 位小写 sha256。
 */
export function buildReadReceipt(minuteToken: string, contentSha256: string): string {
  return `lark:minutes+detail:${minuteToken}@sha256:${contentSha256}`
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
 * 这条通道**标称**会给出的回读 `transport`。
 *
 * 只由接线事实决定：`platform_channel=true`（接线层声明它是真实 lark-cli）→
 * `FEISHU_MINUTES_API`；否则 → `FIXTURE`（测试 / 回放通道）。
 * 一个具体回读到底算不算 LIVE 仍要过 `evaluateLiveGate()`：这里的值只是
 * 「这条 runner 声称自己是哪种通道」，不是「这次读就一定是 LIVE」。
 * @param platformChannel - 接线层是否声明这条 runner 是真实平台通道。
 */
export function readbackTransport(platformChannel: boolean): FeishuTransport {
  return platformChannel ? FEISHU_TRANSPORT.api : FEISHU_TRANSPORT.fixture
}

// ---------------------------------------------------------------------------
// 解析：真实信封 → 落盘文件
// ---------------------------------------------------------------------------

/** 真实 `+detail` 信封里一个 minute 条目的关键字段。 */
interface ParsedDetailEntry {
  readonly minute_token: string
  /** stdout 给出的落盘相对路径（`data.minutes[].artifacts.transcript_file`）。 */
  readonly transcript_file: string
  /** 平台 revision（真实信封可能没有；没有就 null，不补默认值）。 */
  readonly revision: string | null
}

/**
 * 解析真实 `+detail` stdout（2026-11-14 实测形状）。fail-closed：形状不认识、
 * 回显里没有请求的 `minute_token`、没有 `artifacts.transcript_file` 一律失败。
 * stdout 内容**不回显**（可能含标题等租户内容）。
 * @param stdout - 子进程 stdout（真实 CLI 下是纯 JSON；进度日志走 stderr）。
 * @param minuteToken - 本次请求的 minute_token。
 * @param attempts - 尝试次数（进诊断）。
 */
function parseDetailEnvelope(stdout: string, minuteToken: string, attempts: number): ParsedDetailEntry {
  let root: unknown
  try {
    root = JSON.parse(stdout.trim())
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
  if (envelope.ok !== true) {
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
  const data = envelope.data
  if (typeof data !== 'object' || data === null) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'ENVELOPE_UNRECOGNIZED',
      detail: 'CLI 信封里没有 data 对象。',
      retryable: false,
      attempts,
    })
  }
  const minutes = (data as Record<string, unknown>).minutes
  if (!Array.isArray(minutes)) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'TRANSCRIPT_UNRECOGNIZED',
      detail: 'CLI 信封里没有 data.minutes 数组（真实形态应为 data.minutes[].artifacts.transcript_file）：拒绝把不认识的输出当逐字稿。',
      retryable: false,
      attempts,
    })
  }
  const entries = minutes.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  )
  const matched = entries.find((entry) => readNonEmptyString(entry.minute_token) === minuteToken)
  if (matched === undefined) {
    throw new FeishuTransportError({
      stage: 'validate',
      code: 'READBACK_INVALID',
      detail: `平台回显里没有请求的 minute_token（回显 ${entries.length} 条，均非本次请求）：拒绝把别的会议内容当本次产物。`,
      retryable: false,
      attempts,
    })
  }
  const artifacts = matched.artifacts
  const transcriptFile =
    typeof artifacts === 'object' && artifacts !== null
      ? readNonEmptyString((artifacts as Record<string, unknown>).transcript_file)
      : null
  if (transcriptFile === null) {
    throw new FeishuTransportError({
      stage: 'parse',
      code: 'TRANSCRIPT_UNRECOGNIZED',
      detail: '条目里没有 artifacts.transcript_file：拒绝把不认识的输出当逐字稿（本 CLI 版本把正文写盘，stdout 只给路径）。',
      retryable: false,
      attempts,
    })
  }
  return {
    minute_token: minuteToken,
    transcript_file: transcriptFile,
    revision: readNonEmptyString(matched.revision) ?? readNonEmptyString(matched.minute_revision),
  }
}

/**
 * 把 CLI 给的相对路径安全地落到工作目录里。绝对路径 / `..` 越界一律返回 null
 * （不许读工作目录之外的文件）。
 * @param workDir - 本次读取的临时工作目录（子进程 cwd）。
 * @param relativePath - stdout 里的 `transcript_file`（Windows 用 `\`，POSIX 用 `/`）。
 */
export function resolveOutputFile(workDir: string, relativePath: string): string | null {
  const root = resolve(workDir)
  const normalized = relativePath.replace(/[\\/]+/g, sep)
  if (normalized === '' || resolve(root, normalized) === root) return null
  const absolute = resolve(root, normalized)
  if (!absolute.startsWith(root.endsWith(sep) ? root : root + sep)) return null
  return absolute
}

/** 去掉 UTF-8 BOM（真实 CLI 文件通常没有；有也按字节边界处理，不改变其余字节）。 */
function stripUtf8Bom(buffer: Buffer): Buffer {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3)
  }
  return buffer
}

/**
 * 读落盘转写文件 → 字节数 + 文本。fail-closed：文件不存在 / 越界 / 权限问题
 * 报 `OUTPUT_FILE_MISSING`，不是合法 UTF-8（再编码后字节不等）报 `OUTPUT_FILE_INVALID`。
 * @param workDir - 本次读取的临时工作目录。
 * @param relativePath - `artifacts.transcript_file`。
 * @param attempts - 尝试次数（进诊断）。
 */
async function readTranscriptOutput(workDir: string, relativePath: string, attempts: number): Promise<{ readonly text: string; readonly bytes: number }> {
  const absolute = resolveOutputFile(workDir, relativePath)
  if (absolute === null) {
    throw new FeishuTransportError({
      stage: 'read-output',
      code: 'OUTPUT_FILE_INVALID',
      detail: 'CLI 给的 transcript_file 不是工作目录内的相对路径（绝对路径或 .. 越界）：拒绝读取工作目录之外的文件。',
      retryable: false,
      attempts,
    })
  }
  let raw: Buffer
  try {
    raw = await readFile(absolute)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    throw new FeishuTransportError({
      stage: 'read-output',
      code: 'OUTPUT_FILE_MISSING',
      detail: `CLI 说转写已落盘，但读不到 transcript_file（${code === '' ? '未知文件错误' : code}）：不产出正文。`,
      retryable: false,
      attempts,
    })
  }
  if (raw.byteLength > FEISHU_CLI_MAX_OUTPUT_BYTES) {
    throw new FeishuTransportError({
      stage: 'read-output',
      code: 'OUTPUT_FILE_INVALID',
      detail: `转写文件 ${raw.byteLength} 字节，超过上限 ${FEISHU_CLI_MAX_OUTPUT_BYTES}：不截断、不产出正文。`,
      retryable: false,
      attempts,
    })
  }
  const bytes = stripUtf8Bom(raw)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new FeishuTransportError({
      stage: 'read-output',
      code: 'OUTPUT_FILE_INVALID',
      detail: '转写文件不是合法 UTF-8（重新编码后的字节与原文件不一致）：无法给出可核对的 content_sha256，不产出正文。',
      retryable: false,
      attempts,
    })
  }
  return { text, bytes: bytes.byteLength }
}

/**
 * 删掉本次读取的临时工作目录（**正文不留在磁盘上**）。只删自己用
 * `mkdtemp` 建出来的目录（按前缀校验）；删除失败不改变本次读取结论。
 * @param workDir - `mkdtemp` 返回的目录。
 */
async function removeWorkDir(workDir: string): Promise<void> {
  if (!basename(workDir).startsWith(FEISHU_CLI_WORKDIR_PREFIX)) return
  try {
    await rm(workDir, { recursive: true, force: true })
  } catch {
    // 清理失败不掩盖真实错误；正文仍不会进入仓库 / 日志。
  }
}

// ---------------------------------------------------------------------------
// 传输层
// ---------------------------------------------------------------------------

/** `createLarkCliTransport()` 的配置。除 `runner` 外全部有默认值。 */
export interface FeishuLarkCliTransportConfig {
  /** **必填**：怎么跑 CLI。生产用 `createProcessCliRunner()`，测试用假 runner。 */
  readonly runner: FeishuCliRunner
  /**
   * lark-cli 的 profile 名（`--profile <name>`，**全局 flag，必须在子命令前**）。
   * 给了 profile 时每次真实调用（含 `--help` 形态探测与重读校验）的 argv 最前面
   * 都会插入 `['--profile', name]`；不给 = argv 与旧形态一致，**由调用方保证**
   * 这不是「隐式回退开发者全局档案」——接线层（`wiring.ts`）已经拒绝这种配置。
   */
  readonly profile?: string
  /**
   * 这条 runner 是否指向**真实平台通道**（lark-cli）。**只有接线层**按部署配置
   * 置 true（`wiring.ts`：插件配置里的 `feishu.cli` 绝对路径）；直接 new 一个
   * 传输层（单测 / 回放）默认 false = 测试通道，回读 `transport` 恒 `FIXTURE`。
   *
   * 这是「这条通道是不是平台通道」的接线事实，不是数据证据；把它指向假 CLI
   * 就是运维在撒谎，本地代码无法识别。LIVE 仍要过 `evaluateLiveGate()` 的全部证据。
   */
  readonly platform_channel?: boolean
  readonly timeout_ms?: number
  readonly max_attempts?: number
  readonly retry_base_ms?: number
  readonly diagnostic_bytes?: number
  /** 追加到真实 argv 之后的固定参数（默认无；不要塞 `--page-size` 之类 `+detail` 不认的 flag）。 */
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

/** `buildTranscriptArgs()` 的入参。 */
export interface FeishuTranscriptArgsInput {
  /** minute_token（一个即可；批量由 CLI 的逗号分隔形态承担）。 */
  readonly tokens: readonly string[]
  /** 相对 `--output-dir`（真实 CLI 只收相对路径）。 */
  readonly output_dir?: string
  /** 追加参数。 */
  readonly extra_args?: readonly string[]
  /** lark-cli profile 名；给了就插到 argv **最前面**（全局 flag 必须在子命令前）。 */
  readonly profile?: string
}

/**
 * 按**实测真实形态**拼 `minutes +detail` 的 argv：
 * 不带 profile：`minutes +detail --as user --minute-tokens <tokens> --transcript --output-dir <dir>`；
 * 带 profile：`--profile <name> minutes +detail …`（`--profile` 是全局 flag，实测必须
 * 写在子命令之前；2026-11-15）。
 *
 * 不消费 `FEISHU_LARK_CLI.minutesDetailTranscript` 的空格切分（那只是人读模板，
 * 含 `<tokens>` 占位符）；flag 来自 `FEISHU_CLI_TRANSCRIPT_FLAGS`，两者同源。
 * @param input - token 列表 / 相对输出目录 / 追加参数 / profile。
 */
export function buildTranscriptArgs(input: FeishuTranscriptArgsInput): string[] {
  if (input.tokens.length === 0) throw new Error('buildTranscriptArgs: tokens 不能为空')
  const outputDir = input.output_dir ?? FEISHU_CLI_DEFAULT_OUTPUT_DIR
  const profile = readNonEmptyString(input.profile)
  return [
    ...(profile === null ? [] : [FEISHU_CLI_PROFILE_FLAG, profile]),
    'minutes',
    '+detail',
    FEISHU_CLI_TRANSCRIPT_FLAGS.as,
    FEISHU_CLI_IDENTITY,
    FEISHU_CLI_TRANSCRIPT_FLAGS.minute_tokens,
    input.tokens.join(','),
    FEISHU_CLI_TRANSCRIPT_FLAGS.transcript,
    FEISHU_CLI_TRANSCRIPT_FLAGS.output_dir,
    outputDir,
    ...(input.extra_args ?? []),
  ]
}

/**
 * 造一个 `lark-cli-transport`。
 *
 * 读一次的流程（真实 CLI 实测形态）：
 *   invoke（`+detail` 整文件写盘；带超时 + 指数退避重试）→ parse（stdout 元数据
 *   → `artifacts.transcript_file`）→ read-output（读落盘文件，算字节数/sha256）
 *   → validate（回执 / 时间 / 删临时目录）。
 *   **没有分页**：`+detail --transcript` 一次写完整份转写；`+search` 才用 `--page-size`。
 *
 * `platform_channel=true` 时还会**再完整读一次**做重读校验：两次原始正文的
 * sha256 与 revision 必须一致，不一致直接 `READBACK_INVALID` 失败（不产出正文）。
 * 重读一致才把 `reread_sha256` 写进回读对象，供 `evaluateLiveGate()` 核对。
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
  const diagnosticBytes = Math.max(0, config.diagnostic_bytes ?? FEISHU_CLI_DEFAULT_DIAGNOSTIC_BYTES)
  const extraArgs = config.extra_args ?? []
  const now = config.now ?? ((): Date => new Date())
  const sleep = config.sleep ?? defaultSleep
  const platformChannel = config.platform_channel === true
  // profile 语义：给了就每次调用都带 `--profile <name>`（含重读校验与 --help 探测）。
  // 空串/空白按「没配」处理（接线层已经拒绝这种配置，这里只是不让空 flag 进 argv）。
  const profile = readNonEmptyString(config.profile)

  // ---- CLI 形态探测状态（**默认 false**；只由真实 --help / 真实成功调用置 true）----
  let argumentFlagsVerified = false
  let envelopeVerified = false
  let contractCheckedAt: string | null = null
  let helpChecked = false
  let helpExitCode: number | null = null
  let missingFlags: string[] = [...FEISHU_CLI_REQUIRED_HELP_FLAGS]

  /** 当前探测证据（`describe()` / `verifyContract()` 共用）。 */
  function contractEvidence(): FeishuCliContractEvidence {
    return {
      argument_flags_verified: argumentFlagsVerified,
      envelope_verified: envelopeVerified,
      checked_at: contractCheckedAt,
      help_checked: helpChecked,
      help_exit_code: helpExitCode,
      missing_flags: [...missingFlags],
      note: argumentFlagsVerified
        ? (envelopeVerified
          ? '参数名与信封形状都由真实 --help / 真实成功读取核对过。'
          : '参数名由真实 --help 核对过；信封形状还没有一次成功真实读取证明。')
        : '还没有一次真实 --help 或成功真实读取：参数名/信封都按未核实处理（argument_flags_verified=false、envelope_verified=false）。',
    }
  }

  /** 一次真实成功读取（解析信封 + 读到落盘文件）就是信封形状的真实证据。 */
  function markEnvelopeVerified(): void {
    argumentFlagsVerified = true
    envelopeVerified = true
    contractCheckedAt = isoWithOffset(now())
    missingFlags = []
  }

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
    // CLI **配置/授权层**失败（坏 profile / 未授权 / 没有可用 profile 等）：重试不可能
    // 变好，也不是「生成中」。复用既有错误码 PROVIDER_REJECTED 而不是新造一个：
    // `adapter.ts` 的 `blockedReasonFor()` 只把 PROVIDER_NO_PERMISSION / PROVIDER_REJECTED
    // 映射到 `error_code=AUTH_REQUIRED` —— 这是「坏 profile → AUTH_REQUIRED」在既有闭集
    // 里唯一可达的路径（adapter.ts 不在本 lane 写范围，不得为此改它）。
    // detail 只写通用文案：不带 profile 名、不带 argv（argv 可能含会议标识）。
    if (detectCliConfigFailure(result.stderr) !== null) {
      return new FeishuTransportError({
        stage: 'invoke',
        code: 'PROVIDER_REJECTED',
        detail:
          'lark-cli 配置/凭据错误：profile 不存在或未授权；不重试、不产出正文，'
          + '交人工修复 profile / 重新授权（本次没有正文，也没有 artifact）。',
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

  /** 调一次（含重试）；`2091003` 不算失败，直接返回 GENERATING 信号。 */
  async function callOnce(
    args: readonly string[],
    workDir: string,
  ): Promise<{ readonly kind: 'OK'; readonly stdout: string; readonly attempts: number } | { readonly kind: 'GENERATING'; readonly attempts: number }> {
    let lastError: FeishuTransportError | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await runner({ args, timeout_ms: timeoutMs, attempt, cwd: workDir })
      if (result.status === 'OK') {
        // 先看信封里的飞书错误码：ok=false + 2091003 是「生成中」，不是失败。
        const providerCode = extractProviderCode(result.stdout)
        if (providerCode === '2091003') return { kind: 'GENERATING', attempts: attempt }
        return { kind: 'OK', stdout: result.stdout, attempts: attempt }
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

  /**
   * 一次**完整**读取：跑一次 CLI（整文件写盘）→ 解析 stdout → 读落盘正文 →
   * 算字节数 / sha256 / 回执 → 删掉临时工作目录。`platform_channel` 的通道
   * 身份会写进 `transport`；重读校验在 `read()` 里做。
   *
   * 临时目录是必要的：CLI 的 `--output-dir` 只收相对路径，正文按相对子进程 cwd
   * 落盘；读完即删（R7：真实转写正文不留在仓库 / 日志 / 磁盘上）。
   * @param minuteToken - 已校验非空的平台 minute_token（不含 `@`）。
   */
  async function readOnce(minuteToken: string): Promise<FeishuTransportReadResult> {
    if (minuteToken.includes('@') || /[\r\n]/.test(minuteToken)) {
      return {
        status: 'FAILED',
        attempts: 0,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'READBACK_INVALID',
          detail: 'minute_token 含 "@" 或换行：会破坏读取回执格式，拒绝调用。',
          retryable: false,
          attempts: 0,
        }),
      }
    }
    let workDir: string
    try {
      workDir = await mkdtemp(join(tmpdir(), FEISHU_CLI_WORKDIR_PREFIX))
    } catch (error) {
      return {
        status: 'FAILED',
        attempts: 0,
        error: new FeishuTransportError({
          stage: 'read-output',
          code: 'OUTPUT_FILE_INVALID',
          detail: `无法创建临时工作目录（${error instanceof Error ? error.name : typeof error}）：不调用 CLI、不产出正文。`,
          retryable: false,
          attempts: 0,
        }),
      }
    }
    try {
      const args = buildTranscriptArgs({
        tokens: [minuteToken],
        extra_args: extraArgs,
        ...(profile === null ? {} : { profile }),
      })
      let outcome: Awaited<ReturnType<typeof callOnce>>
      try {
        outcome = await callOnce(args, workDir)
      } catch (error) {
        const failure =
          error instanceof FeishuTransportError
            ? error
            : new FeishuTransportError({
                stage: 'invoke',
                code: 'CLI_SPAWN_FAILED',
                detail: '调用 CLI 时抛出非预期异常。',
                retryable: false,
                attempts: 1,
              })
        return { status: 'FAILED', error: failure, attempts: failure.attempts }
      }
      if (outcome.kind === 'GENERATING') {
        // 「生成中」按已核对错误码映射成 WAITING_EXTERNAL，不当失败（TR-F1 / P-3）。
        const mapped = mapFeishuError('2091003')
        return {
          status: 'WAITING_EXTERNAL',
          reason: 'GENERATING',
          provider_code: '2091003',
          task_state: mapped.task_state as 'WAITING_EXTERNAL',
          attempts: outcome.attempts,
          message: mapped.message,
          creates_artifact: false,
        }
      }

      let entry: ParsedDetailEntry
      try {
        entry = parseDetailEnvelope(outcome.stdout, minuteToken, outcome.attempts)
      } catch (error) {
        const failure =
          error instanceof FeishuTransportError
            ? error
            : new FeishuTransportError({
                stage: 'parse',
                code: 'ENVELOPE_UNRECOGNIZED',
                detail: `解析 CLI 输出时抛出非预期异常（${error instanceof Error ? error.name : typeof error}）。`,
                retryable: false,
                attempts: outcome.attempts,
              })
        return { status: 'FAILED', error: failure, attempts: outcome.attempts }
      }

      let output: { readonly text: string; readonly bytes: number }
      try {
        output = await readTranscriptOutput(workDir, entry.transcript_file, outcome.attempts)
      } catch (error) {
        const failure =
          error instanceof FeishuTransportError
            ? error
            : new FeishuTransportError({
                stage: 'read-output',
                code: 'OUTPUT_FILE_INVALID',
                detail: '读取落盘转写文件时抛出非预期异常。',
                retryable: false,
                attempts: outcome.attempts,
              })
        return { status: 'FAILED', error: failure, attempts: outcome.attempts }
      }
      if (output.text.trim() === '') {
        return {
          status: 'FAILED',
          attempts: outcome.attempts,
          error: new FeishuTransportError({
            stage: 'validate',
            code: 'TRANSCRIPT_EMPTY',
            detail: 'CLI 写出的转写文件是空的：空正文不能当产物（P-2）。',
            retryable: false,
            attempts: outcome.attempts,
          }),
        }
      }

      // 成功解析真实信封 + 用户要求的文件确实写出并被读到：信封形状由此被真实调用证明。
      markEnvelopeVerified()

      const contentSha256 = sha256Hex(output.text)
      const readback: FeishuCliTranscriptReadback = {
        transport: readbackTransport(platformChannel),
        minute_token: minuteToken,
        ...(entry.revision === null ? {} : { revision: entry.revision }),
        read_receipt_ref: buildReadReceipt(minuteToken, contentSha256),
        fetched_at: isoWithOffset(now()),
        content_sha256: contentSha256,
        is_complete: true,
        raw_text: output.text,
        trigger: 'MANUAL',
        transcript_file: entry.transcript_file,
        file_bytes: output.bytes,
        page_count: 1,
        transcript_chars: output.text.length,
      }
      return { status: 'READ', readback, attempts: outcome.attempts, pages: 1 }
    } finally {
      await removeWorkDir(workDir)
    }
  }

  /**
   * 对外读取入口。`platform_channel=true` 时做**重读校验**：
   *   * 再完整读一次，两次的 `content_sha256` 与 `revision` 必须一致；
   *   * 不一致 → `FAILED / READBACK_INVALID`（不一致是失败，不产出正文）；
   *   * 一致 → 回读对象带上 `reread_sha256`（= 第二次的哈希），交 Gate 判定。
   * 非平台通道（测试 / 回放）只读一次，回读 `transport` 恒 `FIXTURE`。
   */
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

    const first = await readOnce(minuteToken)
    if (first.status !== 'READ') return first

    let attempts = first.attempts
    let rereadSha256: string | undefined
    if (platformChannel) {
      const second = await readOnce(minuteToken)
      attempts += second.attempts
      if (second.status === 'WAITING_EXTERNAL') return second
      if (second.status === 'FAILED') return { ...second, attempts }
      if (second.readback.content_sha256 !== first.readback.content_sha256
        || (second.readback.revision ?? '') !== (first.readback.revision ?? '')) {
        return {
          status: 'FAILED',
          attempts,
          error: new FeishuTransportError({
            stage: 'validate',
            code: 'READBACK_INVALID',
            detail:
              '重读校验失败：第二次完整回读的 content_sha256 / revision 与第一次不一致。'
              + '回读不一致是失败，不是警告：本次不产出正文，也不写任何 artifact。',
            retryable: false,
            attempts: second.attempts,
          }),
        }
      }
      rereadSha256 = second.readback.content_sha256
    }

    const readback: FeishuCliTranscriptReadback = {
      ...first.readback,
      ...(rereadSha256 === undefined ? {} : { reread_sha256: rereadSha256 }),
    }
    // fail-closed 自检：平台通道却没拿到完整 LIVE 证据 → 不产出回读对象
    // （否则会退化成「读到了但不能证明」的 FIXTURE 假阳性，且掩盖真正的缺项）。
    if (platformChannel && !isLiveEligible(readback)) {
      return {
        status: 'FAILED',
        attempts,
        error: new FeishuTransportError({
          stage: 'validate',
          code: 'READBACK_INVALID',
          detail: `平台通道回读未通过 LIVE 证据自检：${liveEligibilityViolations(readback).join('；')}`,
          retryable: false,
          attempts,
        }),
      }
    }
    return { status: 'READ', readback, attempts, pages: first.pages }
  }

  /**
   * 真实 `--help` 探测：跑一次 `minutes +detail --help`，按**真实输出**判断
   * 必需 flag 是否全在。不抛异常；`envelope_verified` 不在这里置 true
   * （信封形状只能由一次成功的真实读取证明）。
   */
  async function verifyContract(): Promise<FeishuCliContractEvidence> {
    helpChecked = true
    let result: FeishuCliRunResult | null = null
    try {
      result = await runner({
        // 形态探测与真实调用走同一条 argv 纪律：配了 profile 就先带 `--profile`。
        args: [...(profile === null ? [] : [FEISHU_CLI_PROFILE_FLAG, profile]), ...FEISHU_CLI_DETAIL_HELP_ARGS],
        timeout_ms: Math.min(timeoutMs, 30_000),
        attempt: 1,
      })
    } catch {
      result = null
    }
    if (result === null) {
      missingFlags = [...FEISHU_CLI_REQUIRED_HELP_FLAGS]
      contractCheckedAt = isoWithOffset(now())
      return contractEvidence()
    }
    helpExitCode = result.exit_code
    const text = result.status === 'OK' ? `${result.stdout}\n${result.stderr}` : result.stderr
    const missing = FEISHU_CLI_REQUIRED_HELP_FLAGS.filter((flag) => !text.includes(flag))
    missingFlags = [...missing]
    // 一次真实 --help 跑通且 flag 全在 = 参数名核实；已核实过就不会被后续偶发失败降级。
    argumentFlagsVerified = argumentFlagsVerified || (result.status === 'OK' && missing.length === 0)
    contractCheckedAt = isoWithOffset(now())
    return contractEvidence()
  }

  function describe(): FeishuTransportDescription {
    const evidence = contractEvidence()
    return {
      transport: FEISHU_CLI_TRANSPORT_ID,
      command_constant: FEISHU_LARK_CLI.minutesDetailTranscript,
      timeout_ms: timeoutMs,
      max_attempts: maxAttempts,
      retry_base_ms: retryBase,
      diagnostic_bytes: diagnosticBytes,
      live_gate: FEISHU_LIVE_GATE_POLICY,
      platform_channel: platformChannel,
      profile_configured: profile !== null,
      readback_transport: readbackTransport(platformChannel),
      argument_flags_verified: evidence.argument_flags_verified,
      envelope_verified: evidence.envelope_verified,
      contract_checked_at: evidence.checked_at,
      missing_flags: evidence.missing_flags,
      note:
        'lark-cli-transport：`minutes +detail --as user --minute-tokens <token> --transcript --output-dir <dir>`；'
        + 'stdout 只给 `artifacts.transcript_file`，正文从落盘文件读、算 sha 后删临时目录。'
        + `参数名核实=${String(evidence.argument_flags_verified)}（由真实 --help 决定），`
        + `信封核实=${String(evidence.envelope_verified)}（由真实成功读取决定）。`
        + (profile === null
          ? '本 transport 未配置 lark-cli profile（argv 不带 --profile）：只有接线层保证不会隐式回退开发者全局档案时才允许这样装配。'
          : '本 transport 配置了 lark-cli profile：每次真实调用（含 --help 探测与重读校验）的 argv 最前面都带 --profile（名字不输出）。')
        + 'LIVE 由证据算出（evaluateLiveGate）；'
        + (platformChannel
          ? '本 transport 被接线层声明为平台通道：成功读取后会再读一次做重读校验，两次哈希/版本一致才把 transport 标为 FEISHU_MINUTES_API。'
          : '本 transport 不是平台通道（测试 / 回放）：回读 transport 恒 FIXTURE，读成功也不可能 LIVE。'),
    }
  }

  return { kind: FEISHU_CLI_TRANSPORT_ID, read, describe, verifyContract }
}
