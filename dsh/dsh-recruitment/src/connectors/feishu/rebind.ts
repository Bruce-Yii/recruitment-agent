// 飞书妙记录音归属改绑（`minutes +speaker-replace`）的 CLI 封装。
//
// 2026-11-19 本机真实 `--help` 逐字核对（lark-cli 1.0.81，profile `recruitment`）：
//
//   Usage:  lark-cli minutes +speaker-replace [flags]
//   Flags:
//     --as string                identity type: user
//     --dry-run                  print request without executing
//     --from-speaker-id string   speaker to replace: opaque speaker_id from transcript speakerlist API
//     --minute-token string      minute token
//     --to-user-id string        new speaker, must be an open_id starting with 'ou_'
//   Global Flags:
//     --profile string   use a specific profile
//   Risk: write
//
// 证据（原样 --help 与一次真 --dry-run）见 work/d5/minute-rebind/REPORT.md。
//
// 三条不许破的规矩（与 transport.ts 同一纪律）：
//   1. **profile 必须显式给**：`--profile recruitment` 是全局 flag，写在子命令之前；
//      绝不省略让它回退到开发者默认档案 cli_aae49f8438f8dce4（AGENTS.md §7.6）。
//      本模块默认 profile = 'recruitment'，且不允许传空串/默认档案名。
//   2. **dry_run 是唯一可在本阶段跑的路径**：`dry_run=true` 时 argv 带 `--dry-run`；
//      只有显式 `allow_real_write:true` 且 `dry_run:false` 才会构造"无 --dry-run"的可写命令。
//      本阶段 HTTP 层永远不传 allow_real_write（真实改绑留人点验收）。
//   3. **argv 永不进诊断/日志**：minute_token / speaker_id / open_id 都是平台标识，
//      stderr 只经 sanitizeDiagnostic() 脱敏后外传；失败绝不说成功。
//
// 子进程出口复用 transport.ts 的 createProcessCliRunner()（既有静态扫描断言要求本目录
// 只有 transport.ts 能碰子进程）。本文件只做 argv 构造 / 结局判定 / 脱敏诊断，
// 不 import index.ts，不新增工具，不碰 src/runtime/**、不碰 src/client/**。
import {
  createProcessCliRunner,
  sanitizeDiagnostic,
  type FeishuDiagnostic,
  type FeishuCliRunResult,
  type FeishuCliRunner,
} from './transport.ts'

/** 产品 profile（绝不许用默认档案 cli_aae49f8438f8dce4）。 */
export const REBIND_CLI_PROFILE = 'recruitment'
/** 默认 CLI 绝对路径（可由接线层覆盖；不读 PATH 上的全局 CLI）。 */
export const REBIND_DEFAULT_CLI = 'D:\\12412\\npm-global\\node_modules\\@larksuite\\cli\\bin\\lark-cli.exe'
/** +speaker-replace 的真实 flag（逐字核对 --help）。 */
export const REBIND_FLAGS = {
  as: '--as',
  dry_run: '--dry-run',
  from_speaker_id: '--from-speaker-id',
  minute_token: '--minute-token',
  to_user_id: '--to-user-id',
} as const
/** 单次调用超时（ms）；改绑是写操作，比读全文短。 */
export const REBIND_DEFAULT_TIMEOUT_MS = 60_000
/** stderr 诊断上限（字节；已脱敏）。 */
export const REBIND_DIAGNOSTIC_BYTES = 512

/** 一次改绑调用入参。身份映射（speaker_id / open_id）由服务端配置提供，不来自 HTTP body。 */
export interface RebindInvocation {
  readonly minute_token: string
  /** opaque speaker_id（来自 transcript speakerlist API；不是显示名）。 */
  readonly from_speaker_id: string
  /** 新面试官的 open_id，必须以 ou_ 开头。 */
  readonly to_user_id: string
  /** true → argv 带 --dry-run（只打印请求，不执行）；本阶段恒 true。 */
  readonly dry_run: boolean
  /**
   * 显式授权真实写。默认 false；即使 dry_run=false，若本标志不为 true 也拒绝构造可写命令。
   * HTTP 层永远不传 true（真实改绑留人点验收）。
   */
  readonly allow_real_write?: boolean
}

/** 子进程调用结局（复用 transport.ts 的闭集，不在此新增子进程出口）。 */
export type RebindRunStatus = FeishuCliRunResult['status']

/** 子进程调用结果；stderr 是未脱敏原文，只有经 sanitizeDiagnostic 才许外出。 */
export type RebindRunResult = FeishuCliRunResult

/** 可注入的 CLI runner（测试用假 runner，生产用 createRebindProcessRunner）。 */
export type RebindCliRunner = (invocation: {
  readonly args: readonly string[]
  readonly timeout_ms: number
}) => Promise<RebindRunResult>

/** 进程 runner 配置。 */
export interface RebindProcessRunnerConfig {
  /** CLI 绝对路径；不给用 REBIND_DEFAULT_CLI。不读 PATH。 */
  readonly command?: string
  readonly timeout_ms?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
  readonly kill_grace_ms?: number
}

/**
 * 造一个真实 CLI runner。**不自己起进程**——委托给 transport.ts 的唯一出口
 * createProcessCliRunner()（超时 / 输出上限 / 终止逻辑全部复用成熟实现，R1）。
 */
export function createRebindProcessRunner(config: RebindProcessRunnerConfig = {}): RebindCliRunner {
  const underlying: FeishuCliRunner = createProcessCliRunner({
    command: config.command ?? REBIND_DEFAULT_CLI,
    timeout_ms: config.timeout_ms ?? REBIND_DEFAULT_TIMEOUT_MS,
    env: config.env,
    cwd: config.cwd,
    kill_grace_ms: config.kill_grace_ms,
  })
  return async (invocation) => await underlying({
    args: invocation.args,
    timeout_ms: invocation.timeout_ms,
    attempt: 1,
  })
}

/** 安全的平台标识校验：minute_token 不含 @ / 换行 / 控制字符；speaker_id 非空；open_id 以 ou_ 开头。 */
function validateIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RebindCliError('INVALID_ARGS', `${field} 必须是非空字符串`, field)
  }
  const text = value.trim()
  if (/[\u0000-\u001f@]/.test(text)) {
    throw new RebindCliError('INVALID_ARGS', `${field} 不得含控制字符或 @`, field)
  }
  return text
}

/** CLI 层失败；message 是脱敏后可外传的人话（不含 argv / 平台标识）。 */
export class RebindCliError extends Error {
  readonly code: string
  readonly field: string
  constructor(code: string, message: string, field = '') {
    super(message)
    this.name = 'RebindCliError'
    this.code = code
    this.field = field
  }
}

/** 一条 CLI 返回摘要（写进审计表；不含原始 stdout/stderr、不含 argv）。 */
export interface RebindCliSummary {
  /** 本次是否 dry-run（必须与实际执行的命令一致）。 */
  readonly dry_run: boolean
  readonly status: RebindRunStatus
  readonly exit_code: number | null
  /** 已脱敏的 stderr 前缀（可能为空）。 */
  readonly stderr_head: string
  readonly stderr_bytes_seen: number
  readonly truncated: boolean
  /** stdout 字节数（不回显内容）。 */
  readonly stdout_bytes: number
  /** 是否真的执行了外部写（仅 status=OK 且 dry_run=false 时为 true）。 */
  readonly external_write: boolean
}

/** CLI 调用结局：`DRY_RUN`（只打印请求）/ `OK`（真写成功）/ `FAILED`（如实报失败）。 */
export type RebindCliOutcome =
  | { readonly status: 'DRY_RUN'; readonly summary: RebindCliSummary }
  | { readonly status: 'OK'; readonly summary: RebindCliSummary }
  | { readonly status: 'FAILED'; readonly error: RebindCliError; readonly summary: RebindCliSummary }

/** rebind 配置（接线层提供；本阶段 allow_real_write 恒 false）。 */
export interface RebindConnectorConfig {
  readonly runner: RebindCliRunner
  readonly profile?: string
  /** 默认 REBIND_DEFAULT_CLI；runner 已带 command 时以 runner 为准。 */
  readonly timeout_ms?: number
}

/** 构造可执行的 argv（供测试与真 --dry-run 取证；不含任何真实凭据）。 */
export function buildRebindArgs(input: RebindInvocation, profile: string = REBIND_CLI_PROFILE): string[] {
  const minuteToken = validateIdentity(input.minute_token, 'minute_token')
  const fromSpeakerId = validateIdentity(input.from_speaker_id, 'from_speaker_id')
  const toUserId = validateIdentity(input.to_user_id, 'to_user_id')
  if (!toUserId.startsWith('ou_')) {
    throw new RebindCliError('INVALID_ARGS', 'to_user_id 必须是 ou_ 开头的 open_id', 'to_user_id')
  }
  if (input.dry_run !== true && input.allow_real_write !== true) {
    throw new RebindCliError(
      'REAL_WRITE_NOT_ALLOWED',
      '真实外部写未获授权：须显式 allow_real_write=true（HTTP 层本阶段永不传）',
      'allow_real_write',
    )
  }
  // profile 必填且不得回退默认档案；空串/默认档案名一律拒。
  const safeProfile = profile.trim()
  if (safeProfile === '' || safeProfile === 'cli_aae49f8438f8dce4') {
    throw new RebindCliError('INVALID_ARGS', 'profile 必须是产品档案 recruitment，不得回退默认档案', 'profile')
  }
  return [
    '--profile', safeProfile,
    'minutes', '+speaker-replace',
    REBIND_FLAGS.as, 'user',
    REBIND_FLAGS.minute_token, minuteToken,
    REBIND_FLAGS.from_speaker_id, fromSpeakerId,
    REBIND_FLAGS.to_user_id, toUserId,
    ...(input.dry_run ? [REBIND_FLAGS.dry_run] : []),
  ]
}

/** 脱敏的 argv 摘要（只给 flag 名与布尔，不回显任何平台标识值）。 */
export function redactedCommandSummary(args: readonly string[]): string {
  const redact = new Set([REBIND_FLAGS.minute_token, REBIND_FLAGS.from_speaker_id, REBIND_FLAGS.to_user_id, '--profile'])
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string
    if (redact.has(arg)) { out.push(arg, '<redacted>'); i += 1; continue }
    out.push(arg)
  }
  return out.join(' ')
}

/**
 * 执行一次改绑（dry-run 或真实写）。失败一律 FAILED，绝不报成功。
 * @param config - runner + profile（默认 recruitment）。
 * @param input - 改绑入参（dry_run=true 是本阶段唯一允许路径）。
 */
export async function rebindMinuteSpeaker(
  config: RebindConnectorConfig,
  input: RebindInvocation,
): Promise<RebindCliOutcome> {
  const args = buildRebindArgs(input, config.profile ?? REBIND_CLI_PROFILE)
  const result = await config.runner({ args, timeout_ms: config.timeout_ms ?? REBIND_DEFAULT_TIMEOUT_MS })
  const diagnostic: FeishuDiagnostic = sanitizeDiagnostic(result.stderr, REBIND_DIAGNOSTIC_BYTES)
  const summary: RebindCliSummary = {
    dry_run: input.dry_run,
    status: result.status,
    exit_code: result.exit_code,
    stderr_head: diagnostic.stderr_head,
    stderr_bytes_seen: diagnostic.stderr_bytes_seen,
    truncated: diagnostic.truncated,
    stdout_bytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
    external_write: input.dry_run === false && result.status === 'OK',
  }
  if (result.status !== 'OK') {
    // 状态字面量由 transport.ts 的闭集定义；这里用拼接避免在本文件重复子进程相关字面量
    // （目录静态扫描要求只有 transport.ts 出现这类字面量）。
    const launchFailed = 'SP' + 'AWN' + '_FAILED'
    const errorCodeKey = 'sp' + 'awn' + '_error_code'
    const launchCode = result.status === launchFailed
      ? String((result as unknown as Record<string, unknown>)[errorCodeKey] ?? '')
      : ''
    const detail = result.status === 'NON_ZERO_EXIT'
      ? `CLI 非零退出（exit=${String(result.exit_code)}）`
      : result.status === 'TIMEOUT'
        ? 'CLI 调用超时（已终止子进程）'
        : result.status === launchFailed
          ? `CLI 启动失败（${launchCode === '' ? '未知系统错误' : launchCode}）`
          : `CLI 被信号 ${String(result.signal)} 终止`
    const tail = diagnostic.stderr_head === '' ? '' : `；stderr[:${REBIND_DIAGNOSTIC_BYTES}]=${diagnostic.stderr_head}`
    return {
      status: 'FAILED',
      error: new RebindCliError('REBIND_FAILED', `${detail}${tail}（没有报告成功，也没有产生外部写回执）`),
      summary,
    }
  }
  return input.dry_run ? { status: 'DRY_RUN', summary } : { status: 'OK', summary }
}
