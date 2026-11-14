// `lark-cli-transport` 的机检：真实 CLI 形态（2026-11-14 实测）下的 argv / stdout
// 解析 / 落盘文件读取 / 重读校验 / 临时目录清理 / 超时重试 / 脱敏 / 形态探测。
//
// 两个层次：
//   1. **注入的 runner**（内存 + 测试自己写落盘文件）：验证 argv、信封解析、
//      token 回显、文件缺失 / 越界 / 空文件、重读校验、重试计数；
//   2. **真实子进程跑 `test/fixtures/feishu/fake-lark-cli.mjs`**：验证进程管理
//      （ENOENT、非零退出、超时杀进程、cwd/落盘文件）。
//
// 贯穿全文件的一条硬断言：**默认测试通道读到的假数据永远不可能被标成 LIVE**：
// `readback.transport=FIXTURE`，`buildArtifactLabelsFromReadback()` 抛
// `LABEL_DISHONEST_LIVE`。只有接线层声明 `platform_channel=true` 且两次完整
// 回读哈希一致时，回读才可能证据齐全（本文件有正例；正文都是合成语料，R7）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_LARK_CLI,
  FEISHU_LIVE_GATE_POLICY,
  FEISHU_MINUTES_CONTRACT_VERSION,
  FEISHU_TRANSPORT,
} from '../../src/connectors/feishu/contract.ts'
import {
  LIVE_READBACK_PROVENANCE_BASIS,
  buildArtifactLabelsFromReadback,
  evaluateLiveGate,
  isLiveEligible,
  liveEligibilityViolations,
} from '../../src/connectors/feishu/labels.ts'
import { createFeishuMinutesAdapter } from '../../src/connectors/feishu/index.ts'
import {
  FEISHU_CLI_DETAIL_HELP_ARGS,
  FEISHU_CLI_IDENTITY,
  FEISHU_CLI_REQUIRED_HELP_FLAGS,
  FEISHU_CLI_SEARCH_FLAGS,
  FEISHU_CLI_TRANSCRIPT_FLAGS,
  FeishuTransportError,
  buildReadReceipt,
  buildTranscriptArgs,
  createLarkCliTransport,
  createProcessCliRunner,
  isoWithOffset,
  resolveOutputFile,
  sanitizeDiagnostic,
  sha256Hex,
  type FeishuCliInvocation,
  type FeishuCliRunResult,
  type FeishuCliRunner,
} from '../../src/connectors/feishu/transport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const FAKE_CLI = join(PLUGIN_DIR, 'test', 'fixtures', 'feishu', 'fake-lark-cli.mjs')

/** 应用凭据 + 用户令牌：本机最接近「看起来能连上」的形态（**假值**，不是真实凭据）。 */
const USER_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}

/** 合成正文（R7：只用合成文本，不是真实转写）。 */
const LINE_1 = '面试官：开始吧。'
const LINE_2 = '候选人：好的，先讲一个合成项目。'
const TEXT = `${LINE_1}\n${LINE_2}`

/** 假正文里的一段（用来证明诊断里不会出现它）。 */
const SECRET_BODY = '候选人：我主要负责订单链路的稳定性，把超时率从百分之三降到千分之二'

/** `assert.throws` 的校验器：必须是 `LABEL_DISHONEST_LIVE`。 */
function isDishonestLive(error: unknown): boolean {
  assert.ok(error instanceof Error, '必须抛 Error')
  assert.equal((error as Error & { code?: string }).code, 'LABEL_DISHONEST_LIVE')
  return true
}

/** 一次 `OK` 结局。 */
function ok(stdout: string): FeishuCliRunResult {
  return { status: 'OK', exit_code: 0, signal: null, stdout, stderr: '' }
}

/** 一次非零退出。 */
function exitWith(code: number, stderr = ''): FeishuCliRunResult {
  return { status: 'NON_ZERO_EXIT', exit_code: code, signal: null, stdout: '', stderr }
}

/** 真实形态的 stdout 信封（只有元数据 + 落盘路径，没有正文）。 */
function detailEnvelope(token: string, transcriptFile: string | null, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    identity: 'user',
    data: {
      minutes: [{
        minute_token: token,
        title: 'synthetic',
        note_id: '',
        artifacts: transcriptFile === null ? {} : { transcript_file: transcriptFile },
        ...overrides,
      }],
    },
    meta: { count: 1 },
  })
}

/** 在调用给的临时 cwd 里写一个落盘转写文件（模拟真实 CLI 的 `--output-dir`）。 */
async function writeOutput(cwd: string, relativePath: string, text: string): Promise<void> {
  const absolute = join(cwd, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, text, 'utf8')
}

/** 相对路径（正斜杠；传输层两种分隔符都认）。 */
function transcriptPath(token: string): string {
  return `minutes/artifact-synthetic-${token}/transcript.txt`
}

/** 记录调用、按顺序写落盘文件并回真实形态信封的假 runner（每次调用可给不同正文）。 */
function writingRunner(
  texts: readonly string[],
  options: { token?: string; relativePath?: string } = {},
): { runner: FeishuCliRunner; calls: FeishuCliInvocation[] } {
  const token = options.token ?? 'mt_1'
  const relativePath = options.relativePath ?? transcriptPath(token)
  const calls: FeishuCliInvocation[] = []
  const runner: FeishuCliRunner = async (invocation) => {
    calls.push(invocation)
    if (invocation.cwd === undefined) throw new Error('测试 runner 需要 invocation.cwd')
    const text = texts[Math.min(calls.length - 1, texts.length - 1)]
    await writeOutput(invocation.cwd, relativePath, text)
    return ok(detailEnvelope(token, relativePath))
  }
  return { runner, calls }
}

/** 记录调用、不写文件、按顺序回放给定结果的假 runner（失败/探测类用）。 */
function scripted(results: readonly FeishuCliRunResult[]): { runner: FeishuCliRunner; calls: FeishuCliInvocation[] } {
  const calls: FeishuCliInvocation[] = []
  const runner: FeishuCliRunner = async (invocation) => {
    calls.push(invocation)
    const next = results[calls.length - 1]
    if (next === undefined) throw new Error(`假 runner 没有第 ${calls.length} 次结果`)
    return next
  }
  return { runner, calls }
}

/** 一个只跑假 CLI 的传输层（真实子进程；默认是**测试通道**，回读 transport=FIXTURE）。 */
function processTransport(
  scenario: string,
  options: { timeout_ms?: number; max_attempts?: number; extra_env?: Record<string, string>; platform_channel?: boolean } = {},
) {
  const env: Record<string, string> = { ...process.env, FAKE_LARK_CLI_SCENARIO: scenario, ...options.extra_env }
  const runner = createProcessCliRunner({
    command: process.execPath,
    extra_args: [FAKE_CLI],
    env,
    timeout_ms: options.timeout_ms,
  })
  return createLarkCliTransport({
    runner,
    max_attempts: options.max_attempts ?? 1,
    retry_base_ms: 0,
    timeout_ms: options.timeout_ms,
    platform_channel: options.platform_channel === true,
  })
}

// ---------------------------------------------------------------------------
// argv 与 flag：契约常量是唯一来源（实测形态）
// ---------------------------------------------------------------------------

test('buildTranscriptArgs：实测真实 argv（复数 --minute-tokens / --as user / --transcript / 相对 --output-dir）', () => {
  assert.deepEqual(buildTranscriptArgs({ tokens: ['mt_1'] }), [
    'minutes', '+detail', '--as', 'user', '--minute-tokens', 'mt_1',
    '--transcript', '--output-dir', 'minutes',
  ])
  assert.deepEqual(buildTranscriptArgs({ tokens: ['mt_1', 'mt_2'], output_dir: 'out', extra_args: ['--format', 'json'] }), [
    'minutes', '+detail', '--as', 'user', '--minute-tokens', 'mt_1,mt_2',
    '--transcript', '--output-dir', 'out', '--format', 'json',
  ])
  assert.throws(() => buildTranscriptArgs({ tokens: [] }), /tokens 不能为空/)
})

test('flag 常量：与真实 --help 一致（复数 minute_tokens、output_dir、as user）', () => {
  assert.equal(FEISHU_CLI_TRANSCRIPT_FLAGS.minute_tokens, '--minute-tokens')
  assert.equal(FEISHU_CLI_TRANSCRIPT_FLAGS.transcript, '--transcript')
  assert.equal(FEISHU_CLI_TRANSCRIPT_FLAGS.output_dir, '--output-dir')
  assert.equal(FEISHU_CLI_TRANSCRIPT_FLAGS.as, '--as')
  assert.equal(FEISHU_CLI_IDENTITY, 'user')
  assert.deepEqual([...FEISHU_CLI_REQUIRED_HELP_FLAGS], ['--as', '--minute-tokens', '--transcript', '--output-dir'])
  assert.deepEqual([...FEISHU_CLI_DETAIL_HELP_ARGS], ['minutes', '+detail', '--help'])
  // +search 的形态（实测：data.items[].token，不是 minute_token）。
  assert.equal(FEISHU_CLI_SEARCH_FLAGS.owner_ids, '--owner-ids')
  assert.equal(FEISHU_CLI_SEARCH_FLAGS.page_size, '--page-size')
  // 契约版本随 CLI 形态变更加一档。
  assert.equal(FEISHU_MINUTES_CONTRACT_VERSION, '1.1.0')
  assert.match(FEISHU_LARK_CLI.minutesDetailTranscript, /--minute-tokens <tokens>/)
})

test('回执 / sha / 时间：都是纯函数，格式与 labels.ts 的闸门一致', () => {
  const digest = sha256Hex(TEXT)
  assert.equal(buildReadReceipt('mt_1', digest), `lark:minutes+detail:mt_1@sha256:${digest}`)
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const iso = isoWithOffset(new Date('2026-11-13T10:00:00Z'))
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  assert.equal(Number.isFinite(Date.parse(iso)), true)
})

test('resolveOutputFile：只接受工作目录内的相对路径（绝对路径 / .. 越界一律拒绝）', () => {
  // 工作目录必须是**本平台**的绝对路径：`join('C:', ...)` 在 POSIX 上是相对路径
  // （`resolve()` 会把它挂到 cwd 下面），旧写法等于在测宿主平台。
  const workdir = join(sep === '\\' ? 'C:\\' : '/', 'tmp', 'feishu-work')
  // CLI 在 Windows 上写 `\`、在 POSIX 上写 `/`（`transport.ts:730` 已明确两种都可能来），
  // 两种分隔符都必须落到同一个工作目录里。
  assert.equal(resolveOutputFile(workdir, 'minutes\\a\\transcript.txt')?.endsWith(join('minutes', 'a', 'transcript.txt')), true)
  assert.equal(resolveOutputFile(workdir, 'minutes/a/transcript.txt')?.endsWith(join('minutes', 'a', 'transcript.txt')), true)
  // 绝对路径一律拒绝。这里必须用**本平台**的绝对路径：
  // `C:\outside\x.txt` 只在 win32 上是绝对路径，在 POSIX 上它是一个含盘符的**相对名**
  // （`node:path` 的 isAbsolute 为 false），拿它断言"绝对路径被拒"在 Linux CI 上必然红
  // （2026-11-14 真实 CI：expected null，actual `…/C:/tmp/feishu-work/C:/outside/x.txt`）。
  const absoluteOutside = sep === '\\' ? 'C:\\outside\\x.txt' : '/outside/x.txt'
  assert.equal(resolveOutputFile(workdir, absoluteOutside), null)
  assert.equal(resolveOutputFile(workdir, '..\\outside.txt'), null)
  assert.equal(resolveOutputFile(workdir, 'minutes\\..\\..\\outside.txt'), null)
  assert.equal(resolveOutputFile(workdir, ''), null)
})

// ---------------------------------------------------------------------------
// 测试通道成功路径：读落盘文件 + 回执绑哈希 + 临时目录删除
// ---------------------------------------------------------------------------

test('测试通道（脚本 runner）：读落盘文件 → 回执绑哈希 / sha 自洽 / transport=FIXTURE / 临时目录已删', async () => {
  const { runner, calls } = writingRunner([TEXT])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, now: () => new Date('2026-11-13T10:00:00Z') })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  const readback = result.readback
  assert.equal(readback.raw_text, TEXT)
  assert.equal(readback.content_sha256, sha256Hex(TEXT))
  assert.equal(readback.file_bytes, Buffer.byteLength(TEXT, 'utf8'))
  assert.equal(readback.read_receipt_ref, `lark:minutes+detail:mt_1@sha256:${sha256Hex(TEXT)}`)
  assert.equal(readback.is_complete, true)
  assert.equal(readback.trigger, 'MANUAL')
  assert.equal(readback.transcript_file, transcriptPath('mt_1'))
  assert.equal(readback.page_count, 1)
  assert.equal(readback.revision, undefined)

  // 关键：默认 platform_channel=false → 读成功也不冒充平台来源 → 永远不可能 LIVE。
  assert.equal(readback.transport, FEISHU_TRANSPORT.fixture)
  assert.equal(isLiveEligible(readback), false)
  assert.ok(liveEligibilityViolations(readback).some((violation) => violation.includes('transport')))
  assert.throws(() => buildArtifactLabelsFromReadback(readback), isDishonestLive)

  // argv 是实测形态；临时 cwd 在读完后就删了（正文不留在磁盘上）。
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args.slice(0, 9), [
    'minutes', '+detail', '--as', 'user', '--minute-tokens', 'mt_1', '--transcript', '--output-dir', 'minutes',
  ])
  assert.equal(typeof calls[0]!.cwd, 'string')
  assert.equal(existsSync(calls[0]!.cwd as string), false, '临时工作目录必须删除')
})

test('平台通道（脚本 runner）：两次完整回读哈希一致 → READ + LIVE 证据（transport=API / reread_sha256）', async () => {
  const { runner, calls } = writingRunner([TEXT, TEXT])
  const transport = createLarkCliTransport({
    runner,
    retry_base_ms: 0,
    platform_channel: true,
    now: () => new Date('2026-11-13T10:00:00Z'),
  })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  const readback = result.readback
  assert.equal(readback.transport, FEISHU_TRANSPORT.api)
  assert.equal(readback.reread_sha256, sha256Hex(TEXT))
  assert.equal(readback.content_sha256, sha256Hex(TEXT))
  assert.equal(calls.length, 2, '平台通道必须完整读两次做重读校验')

  const decision = evaluateLiveGate(readback)
  assert.equal(decision.gate, 'LIVE')
  assert.deepEqual(decision.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(decision.provenance_basis, LIVE_READBACK_PROVENANCE_BASIS)
  assert.deepEqual(decision.violations, [])
  assert.deepEqual(buildArtifactLabelsFromReadback(readback), decision.labels)

  // 一次真实成功读取也是「信封形状被真实调用证明」的证据。
  const described = transport.describe()
  assert.equal(described.argument_flags_verified, true)
  assert.equal(described.envelope_verified, true)
  assert.equal(described.contract_checked_at !== null, true)
  assert.deepEqual([...described.missing_flags], [])
})

test('平台通道：两次回读哈希不一致 → FAILED/READBACK_INVALID（不一致是失败，不是警告）', async () => {
  const { runner, calls } = writingRunner([TEXT, `${TEXT}\n改了一个字。`])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, platform_channel: true })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'validate')
  assert.equal(result.error.code, 'READBACK_INVALID')
  assert.match(result.error.message, /重读校验失败/)
  assert.equal(result.error.message.includes('合成项目'), false, '诊断不得回显正文')
  assert.equal(calls.length, 2)
})

test('平台通道：第二次读取失败 → 整个读取 FAILED（不拿第一次的半证据当结果）', async () => {
  let call = 0
  const runner: FeishuCliRunner = async (invocation) => {
    call += 1
    if (call === 1) {
      await writeOutput(invocation.cwd as string, transcriptPath('mt_1'), TEXT)
      return ok(detailEnvelope('mt_1', transcriptPath('mt_1')))
    }
    return exitWith(3, 'boom')
  }
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, platform_channel: true })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'CLI_NON_ZERO_EXIT')
})

// ---------------------------------------------------------------------------
// 信封 / 落盘文件 fail-closed
// ---------------------------------------------------------------------------

test('CLI 说写了但文件不存在 → OUTPUT_FILE_MISSING（stage=read-output）', async () => {
  const runner: FeishuCliRunner = async () => ok(detailEnvelope('mt_1', transcriptPath('mt_1')))
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'read-output')
  assert.equal(result.error.code, 'OUTPUT_FILE_MISSING')
})

test('落盘文件为空 → TRANSCRIPT_EMPTY（stage=validate）', async () => {
  const { runner } = writingRunner([''])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'TRANSCRIPT_EMPTY')
})

test('transcript_file 越界（../）→ OUTPUT_FILE_INVALID，且不读工作目录之外', async () => {
  const runner: FeishuCliRunner = async (invocation) => {
    await writeOutput(invocation.cwd as string, 'minutes/a.txt', 'x')
    return ok(detailEnvelope('mt_1', '..\\outside.txt'))
  }
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'read-output')
  assert.equal(result.error.code, 'OUTPUT_FILE_INVALID')
  assert.match(result.error.message, /工作目录/)
})

test('信封缺 data.minutes / artifacts.transcript_file → TRANSCRIPT_UNRECOGNIZED（不回显 stdout）', async () => {
  for (const stdout of [
    JSON.stringify({ ok: true, identity: 'user', data: {} }),
    detailEnvelope('mt_1', null),
  ]) {
    const transport = createLarkCliTransport({ runner: async () => ok(stdout), retry_base_ms: 0 })
    const result = await transport.read({ minute_token: 'mt_1' })
    assert.equal(result.status, 'FAILED')
    if (result.status !== 'FAILED') return
    assert.equal(result.error.code, 'TRANSCRIPT_UNRECOGNIZED')
    assert.equal(result.error.message.includes('synthetic'), false)
  }
})

test('回显的 minute_token 不是请求的那个 → READBACK_INVALID（不认错会议）', async () => {
  const transport = createLarkCliTransport({
    runner: async () => ok(detailEnvelope('mt_someone_else', transcriptPath('mt_someone_else'))),
    retry_base_ms: 0,
  })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'validate')
  assert.equal(result.error.code, 'READBACK_INVALID')
})

test('minute_token 含 @ / 换行 → READBACK_INVALID，且一次 CLI 都不调', async () => {
  const { runner, calls } = scripted([ok('unused')])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  for (const token of ['mt@1', 'mt_1\nx']) {
    const result = await transport.read({ minute_token: token })
    assert.equal(result.status, 'FAILED')
    if (result.status === 'FAILED') assert.equal(result.error.code, 'READBACK_INVALID')
  }
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// 生成中 / 失败可诊断 / 重试
// ---------------------------------------------------------------------------

test('生成中：{ok:false, 2091003} → WAITING_EXTERNAL，不建 artifact、不重试', async () => {
  const { runner, calls } = scripted([ok(JSON.stringify({ ok: false, error: { code: 2091003, message: 'still generating' } }))])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'WAITING_EXTERNAL')
  if (result.status !== 'WAITING_EXTERNAL') return
  assert.equal(result.task_state, 'WAITING_EXTERNAL')
  assert.equal(result.provider_code, '2091003')
  assert.equal(result.creates_artifact, false)
  assert.equal(calls.length, 1, '生成中不重试')
})

test('生成中：非零退出但 stderr 带 2091003 → 同样 WAITING_EXTERNAL', async () => {
  const { runner } = scripted([exitWith(7, JSON.stringify({ ok: false, error: { code: 2091003 } }))])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'WAITING_EXTERNAL')
})

test('超时：按 max_attempts 重试后失败，stage=invoke / code=CLI_TIMEOUT', async () => {
  const timeout: FeishuCliRunResult = { status: 'TIMEOUT', exit_code: null, signal: 'SIGTERM', stdout: '', stderr: '' }
  const { runner, calls } = scripted([timeout, timeout, timeout])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, max_attempts: 3, timeout_ms: 250 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.ok(result.error instanceof FeishuTransportError)
  assert.equal(result.error.stage, 'invoke')
  assert.equal(result.error.code, 'CLI_TIMEOUT')
  assert.equal(result.error.retryable, true)
  assert.equal(calls.length, 3, '可重试错误应按 max_attempts 重试')
  assert.match(result.error.message, /timeout=250/)
  assert.match(result.error.message, /stage=invoke/)
})

test('CLI 缺失（真实子进程 ENOENT）：stage=locate-cli / code=CLI_NOT_FOUND，不重试', async () => {
  const runner = createProcessCliRunner({ command: join(PLUGIN_DIR, 'test', 'fixtures', 'feishu', 'definitely-not-here-xyz') })
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, max_attempts: 3 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'locate-cli')
  assert.equal(result.error.code, 'CLI_NOT_FOUND')
  assert.equal(result.error.attempts, 1, '找不到 CLI 重试没有意义')
  assert.match(result.error.message, /ENOENT/)
})

test('非零退出 + 未知错误码：stage=invoke / code=CLI_NON_ZERO_EXIT，带退出码', async () => {
  const { runner, calls } = scripted([exitWith(3, 'boom'), exitWith(3, 'boom'), exitWith(3, 'boom')])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, max_attempts: 3 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'invoke')
  assert.equal(result.error.code, 'CLI_NON_ZERO_EXIT')
  assert.equal(result.error.exit_code, 3)
  assert.equal(result.error.attempts, 3)
  assert.equal(calls.length, 3)
  assert.match(result.error.message, /exit=3/)
})

test('非零退出 + 2091005：AUTH_REQUIRED 语义，不重试（TR-F2）', async () => {
  const { runner, calls } = scripted([exitWith(2, JSON.stringify({ error: { code: 2091005 } }))])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, max_attempts: 3 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'PROVIDER_NO_PERMISSION')
  assert.equal(result.error.provider_code, '2091005')
  assert.equal(result.error.retryable, false)
  assert.equal(calls.length, 1, '无权限不得重试到死')
})

test('形状不认识：非 JSON → stage=parse / ENVELOPE_UNRECOGNIZED，且不回显输出内容', async () => {
  const { runner } = scripted([ok(`not json：${SECRET_BODY}`)])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'parse')
  assert.equal(result.error.code, 'ENVELOPE_UNRECOGNIZED')
  assert.equal(result.error.message.includes(SECRET_BODY), false, '非 JSON 输出不得回显')
})

// ---------------------------------------------------------------------------
// R7：诊断里不许出现正文 / argv
// ---------------------------------------------------------------------------

test('R7：stderr 里的正文被脱敏，诊断只留结构线索', async () => {
  const { runner } = scripted([exitWith(5, `cli crashed: ${SECRET_BODY}`), exitWith(5, `cli crashed: ${SECRET_BODY}`)])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, max_attempts: 2 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.message.includes(SECRET_BODY), false, '诊断里出现了正文')
  assert.equal(result.error.message.includes('候选人'), false, '诊断里出现了正文片段')
  assert.match(result.error.message, /redacted/)
  assert.match(result.error.message, /stage=invoke/)
  assert.match(result.error.message, /exit=5/)
  // argv 也不许回显（可能含会议标识）。
  assert.equal(result.error.message.includes('mt_1'), false, '诊断里出现了 minute_token')
})

test('sanitizeDiagnostic：JSON 的 content 字段被抹掉、按字节截断、正文变 placeholder', () => {
  const json = sanitizeDiagnostic(JSON.stringify({ error: { code: 1, msg: '张三的会议原文在这里', text: '更多正文' } }))
  assert.equal(json.stderr_head.includes('张三'), false)
  assert.equal(json.stderr_head.includes('更多正文'), false)
  assert.match(json.stderr_head, /<redacted>|<redacted:cjk>/)

  const bytes = sanitizeDiagnostic('a'.repeat(4096), 128)
  assert.ok(Buffer.byteLength(bytes.stderr_head, 'utf8') <= 128)
  assert.equal(bytes.truncated, true)
  assert.ok(bytes.stderr_bytes_seen >= 4096)

  assert.deepEqual(sanitizeDiagnostic(''), { stderr_head: '', stderr_bytes_seen: 0, truncated: false })
})

// ---------------------------------------------------------------------------
// 形态探测：argument_flags_verified / envelope_verified 由真实探测决定
// ---------------------------------------------------------------------------

test('verifyContract：默认 false；真实 --help 全 flag → argument=true，信封仍 false', async () => {
  const helpText = [
    'Usage:',
    '  lark-cli minutes +detail [flags]',
    'Flags:',
    '      --as string              identity type: user',
    '      --minute-tokens string   minute tokens, comma-separated for batch',
    '      --output-dir string      output directory for transcript files',
    '      --transcript             include transcript (saved to file)',
  ].join('\n')
  const { runner, calls } = scripted([ok(helpText)])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })

  const before = transport.describe()
  assert.equal(before.argument_flags_verified, false)
  assert.equal(before.envelope_verified, false)
  assert.equal(before.contract_checked_at, null)

  const evidence = await transport.verifyContract()
  assert.equal(evidence.help_checked, true)
  assert.equal(evidence.help_exit_code, 0)
  assert.equal(evidence.argument_flags_verified, true)
  assert.equal(evidence.envelope_verified, false, '--help 不能证明信封形状')
  assert.deepEqual([...evidence.missing_flags], [])
  assert.deepEqual(calls[0]!.args, ['minutes', '+detail', '--help'])

  const after = transport.describe()
  assert.equal(after.argument_flags_verified, true)
  assert.equal(after.envelope_verified, false)
  assert.equal(after.contract_checked_at !== null, true)
})

test('verifyContract：--help 缺 flag → argument 仍 false，并列出缺哪些', async () => {
  const { runner } = scripted([ok('Flags:\n  --as string\n  --transcript\n')])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const evidence = await transport.verifyContract()
  assert.equal(evidence.argument_flags_verified, false)
  assert.deepEqual([...evidence.missing_flags].sort(), ['--minute-tokens', '--output-dir'])
  assert.match(evidence.note, /未核实|还没有/)
})

test('verifyContract：runner 抛异常 / 非零退出 → argument 仍 false（不把异常当通过）', async () => {
  const throwing = createLarkCliTransport({
    runner: async () => { throw new Error('boom') },
    retry_base_ms: 0,
  })
  const first = await throwing.verifyContract()
  assert.equal(first.argument_flags_verified, false)
  assert.equal(first.missing_flags.length, 4)

  const { runner } = scripted([exitWith(2, 'help failed')])
  const failed = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const second = await failed.verifyContract()
  assert.equal(second.argument_flags_verified, false)
  assert.equal(second.help_exit_code, 2)
})

// ---------------------------------------------------------------------------
// describe()
// ---------------------------------------------------------------------------

test('describe()：默认测试通道 / 形态未探测 / live_gate 口径名', () => {
  const transport = createLarkCliTransport({ runner: async () => ok('{}') })
  const described = transport.describe()
  assert.equal(described.transport, 'lark-cli-transport')
  assert.equal(described.live_gate, 'EVIDENCE_DRIVEN')
  assert.equal(FEISHU_LIVE_GATE_POLICY, 'EVIDENCE_DRIVEN')
  assert.equal(described.platform_channel, false)
  assert.equal(described.readback_transport, FEISHU_TRANSPORT.fixture)
  assert.equal(described.argument_flags_verified, false)
  assert.equal(described.envelope_verified, false)
  assert.equal(described.contract_checked_at, null)
  assert.deepEqual([...described.missing_flags], ['--as', '--minute-tokens', '--transcript', '--output-dir'])
  assert.match(described.command_constant, /--minute-tokens <tokens>/)
})

test('describe()：平台通道 → 标称 readback_transport=API', () => {
  const transport = createLarkCliTransport({ runner: async () => ok('{}'), platform_channel: true })
  assert.equal(transport.describe().platform_channel, true)
  assert.equal(transport.describe().readback_transport, FEISHU_TRANSPORT.api)
})

// ---------------------------------------------------------------------------
// 真实子进程：进程管理 + 落盘文件 + 形态探测
// ---------------------------------------------------------------------------

test('真实子进程：fake CLI 按实测形态写盘 → 读完整文，回读仍只能是 FIXTURE', async () => {
  const transport = processTransport('single')
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  assert.equal(result.readback.raw_text.includes('面试官：请先介绍一下'), true)
  assert.equal(result.readback.raw_text.includes('候选人：我主要负责订单链路'), true)
  assert.equal(result.readback.content_sha256, sha256Hex(result.readback.raw_text))
  assert.equal(result.readback.file_bytes, Buffer.byteLength(result.readback.raw_text, 'utf8'))
  assert.match(result.readback.transcript_file, /artifact-synthetic-mt_1[\\/]transcript\.txt$/)
  assert.equal(result.readback.transport, FEISHU_TRANSPORT.fixture)
  assert.equal(isLiveEligible(result.readback), false)
  assert.throws(() => buildArtifactLabelsFromReadback(result.readback), isDishonestLive)
})

test('真实子进程：fake CLI 的 --help → verifyContract 判 argument_flags_verified=true', async () => {
  const transport = processTransport('help')
  const before = transport.describe()
  assert.equal(before.argument_flags_verified, false)
  const evidence = await transport.verifyContract()
  assert.equal(evidence.argument_flags_verified, true)
  assert.equal(evidence.envelope_verified, false)
  assert.equal(evidence.help_exit_code, 0)
})

test('真实子进程：信封说写了但文件不存在 → OUTPUT_FILE_MISSING', async () => {
  const transport = processTransport('missingfile')
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'OUTPUT_FILE_MISSING')
})

test('真实子进程：超时会杀掉 CLI 并报 CLI_TIMEOUT', async () => {
  const transport = processTransport('timeout', { timeout_ms: 600, max_attempts: 1 })
  const started = Date.now()
  const result = await transport.read({ minute_token: 'mt_1' })
  const elapsed = Date.now() - started
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'CLI_TIMEOUT')
  assert.equal(result.error.stage, 'invoke')
  assert.ok(elapsed < 30_000, `超时没有被及时处理（${elapsed} ms）`)
})

test('真实子进程：非零退出码被原样报出（exit=3）', async () => {
  const transport = processTransport('nonzero')
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'CLI_NON_ZERO_EXIT')
  assert.equal(result.error.exit_code, 3)
})

// ---------------------------------------------------------------------------
// 适配器：默认不接线 / 测试通道 FIXTURE / 平台通道 LIVE / 自相矛盾失败
// ---------------------------------------------------------------------------

test('适配器默认不装配传输层：不 spawn 进程，BLOCKED / TRANSPORT_NOT_CONFIGURED', async () => {
  const adapter = createFeishuMinutesAdapter({ env: USER_ENV })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'BLOCKED')
  if (result.kind !== 'BLOCKED') return
  assert.equal(result.blocked_reason, 'TRANSPORT_NOT_CONFIGURED')
  assert.equal(result.error_code, 'AUTH_REQUIRED')
  assert.equal(result.creates_artifact, false)
  assert.equal(result.labels.provenance, 'FIXTURE')
  assert.equal(JSON.stringify(result).includes('mt_1'), false, '不得回声 minute_token')

  // 没有应用凭据时连传输层都不看。
  const noCreds = await createFeishuMinutesAdapter({ env: {} }).fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(noCreds.kind, 'BLOCKED')
  if (noCreds.kind === 'BLOCKED') {
    assert.equal(noCreds.blocked_reason, 'NO_APP_CREDENTIALS')
    assert.equal(noCreds.error_code, 'NOT_CONNECTED')
  }
})

test('适配器 + 测试通道（fake CLI）：READ 但 live_eligible=false，回执已绑哈希、缺平台通道证据', async () => {
  const adapter = createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('single') })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'READ')
  if (result.kind !== 'READ') return
  assert.equal(result.live_gate, 'BLOCKED')
  assert.equal(result.live_eligible, false)
  assert.equal(result.provenance_basis, 'NO_LIVE_READ')
  assert.deepEqual(result.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' })
  assert.equal(result.readback.transport, FEISHU_TRANSPORT.fixture)
  assert.match(result.readback.read_receipt_ref, /^lark:minutes\+detail:mt_1@sha256:[0-9a-f]{64}$/)
  assert.ok(result.live_gate_violations.some((violation) => violation.includes('transport')))
  assert.throws(() => buildArtifactLabelsFromReadback(result.readback), isDishonestLive)
  const json = JSON.stringify(result)
  assert.equal(json.includes('"provenance":"LIVE"'), false)
  assert.equal(json.includes('"connection":"CONNECTED"'), false)
})

test('适配器 + 平台通道（合成 fake CLI）：两次回读一致 → READ 就是 LIVE/MANUAL/CONNECTED', async () => {
  const adapter = createFeishuMinutesAdapter({
    env: USER_ENV,
    transport: processTransport('single', { platform_channel: true }),
  })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'READ')
  if (result.kind !== 'READ') return
  assert.equal(result.live_gate, 'LIVE')
  assert.equal(result.live_eligible, true)
  assert.equal(result.provenance_basis, LIVE_READBACK_PROVENANCE_BASIS)
  assert.deepEqual(result.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(result.connection_state, 'CONNECTED')
  assert.equal(result.readback.transport, FEISHU_TRANSPORT.api)
  assert.match(result.readback.read_receipt_ref, /^lark:minutes\+detail:mt_1@sha256:[0-9a-f]{64}$/)
  assert.equal(result.readback.reread_sha256, result.readback.content_sha256)
  assert.deepEqual(result.live_gate_violations, [])
  assert.deepEqual(buildArtifactLabelsFromReadback(result.readback), result.labels)
  // 合成正文不得写进诊断/日志（R7）。
  assert.equal(JSON.stringify(result.note).includes('候选人'), false)
})

test('适配器：注入的假传输层声称平台通道但回读自相矛盾 → BLOCKED/READBACK_INVALID（失败，不是警告）', async () => {
  // 一个伪造的「解码后」回读：content_sha256 与 raw_text 对不上。
  const fakeTransport = {
    kind: 'lark-cli-transport' as const,
    read: async () => ({
      status: 'READ' as const,
      attempts: 1,
      pages: 1,
      readback: {
        transport: FEISHU_TRANSPORT.api,
        minute_token: 'mt_1',
        read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'a'.repeat(64)}`,
        fetched_at: '2026-11-13T10:00:00+08:00',
        content_sha256: 'a'.repeat(64),
        reread_sha256: 'a'.repeat(64),
        is_complete: true,
        raw_text: '面试官：合成内容。',
        trigger: 'MANUAL' as const,
        transcript_file: 'minutes/x/transcript.txt',
        file_bytes: 30,
        page_count: 1,
        transcript_chars: 10,
      },
    }),
    describe: () => ({
      transport: 'lark-cli-transport' as const,
      command_constant: FEISHU_LARK_CLI.minutesDetailTranscript,
      timeout_ms: 1_000,
      max_attempts: 1,
      retry_base_ms: 0,
      diagnostic_bytes: 0,
      live_gate: FEISHU_LIVE_GATE_POLICY as 'EVIDENCE_DRIVEN',
      platform_channel: true,
      readback_transport: FEISHU_TRANSPORT.api,
      argument_flags_verified: false,
      envelope_verified: false,
      contract_checked_at: null,
      missing_flags: [],
      note: 'fake',
    }),
    verifyContract: async () => ({
      argument_flags_verified: false,
      envelope_verified: false,
      checked_at: null,
      help_checked: false,
      help_exit_code: null,
      missing_flags: [],
      note: 'fake',
    }),
  }
  const adapter = createFeishuMinutesAdapter({ env: USER_ENV, transport: fakeTransport })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'BLOCKED')
  if (result.kind !== 'BLOCKED') return
  assert.equal(result.blocked_reason, 'READBACK_INVALID')
  assert.equal(result.error_code, 'READ_FAILED')
  assert.equal(result.creates_artifact, false)
  assert.match(result.message, /回读对象自相矛盾/)
  assert.match(result.message, /content_sha256/)
  assert.equal(JSON.stringify(result).includes('"provenance":"LIVE"'), false)
})

test('适配器：生成中 → WAITING_EXTERNAL（不是失败，不建 artifact）', async () => {
  const adapter = createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('generating') })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'WAITING_EXTERNAL')
  if (result.kind !== 'WAITING_EXTERNAL') return
  assert.equal(result.task_state, 'WAITING_EXTERNAL')
  assert.equal(result.error_code, 'WAITING_EXTERNAL')
  assert.equal(result.creates_artifact, false)
  assert.equal(result.labels.provenance, 'FIXTURE')
})

test('适配器：传输失败 → BLOCKED，带 stage/code/exit_code，且仍是 FIXTURE', async () => {
  const adapter = createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('nonzero') })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_1' })
  assert.equal(result.kind, 'BLOCKED')
  if (result.kind !== 'BLOCKED') return
  assert.equal(result.blocked_reason, 'CLI_FAILED')
  assert.equal(result.error_code, 'READ_FAILED')
  assert.equal(result.failure?.stage, 'invoke')
  assert.equal(result.failure?.code, 'CLI_NON_ZERO_EXIT')
  assert.equal(result.failure?.exit_code, 3)
  assert.equal(result.labels.provenance, 'FIXTURE')
  assert.equal('readback' in result, false)
})

test('适配器：没有真凭据时 fetchTranscript 的每一种出口都不含 LIVE / CONNECTED', async () => {
  const adapters = [
    createFeishuMinutesAdapter({ env: {} }),
    createFeishuMinutesAdapter({ env: USER_ENV }),
    createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('single') }),
    createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('generating') }),
    createFeishuMinutesAdapter({ env: USER_ENV, transport: processTransport('badenvelope') }),
  ]
  for (const adapter of adapters) {
    for (const request of [{ minute_token: 'mt_1' }, { external_meeting_id: 'm_1' }]) {
      const result = await adapter.fetchTranscript(request)
      const json = JSON.stringify(result)
      assert.equal(json.includes('"provenance":"LIVE"'), false)
      assert.equal(json.includes('"connection":"CONNECTED"'), false)
      const labels = (result as { readonly labels?: { readonly provenance?: string; readonly connection?: string } }).labels
      if (labels !== undefined) {
        assert.notEqual(labels.provenance, 'LIVE')
        assert.notEqual(labels.connection, 'CONNECTED')
      }
    }
  }
})

// ---------------------------------------------------------------------------
// 静态扫描：外部出口只许在 transport.ts 一处
// ---------------------------------------------------------------------------

/** 全连接器都禁用的形态（HTTP / 套接字 / require）。 */
const FORBIDDEN_EVERYWHERE: ReadonlyArray<readonly [string, RegExp]> = [
  ['fetch(', /\bfetch\s*\(/],
  ['node:http', /node:http/],
  ['node:https', /node:https/],
  ['node:net', /node:net/],
  ['undici', /undici/i],
]

/** 除 transport.ts 之外一律禁用的子进程形态。 */
const FORBIDDEN_SUBPROCESS: ReadonlyArray<readonly [string, RegExp]> = [
  ['child_process', /child_process/],
  ['spawn(', /\bspawn\s*\(/],
  ['execSync', /\bexecSync\b/],
]

const CONNECTOR_DIR = join(PLUGIN_DIR, 'src', 'connectors', 'feishu')
const EXTERNAL_EGRESS_FILE = join(CONNECTOR_DIR, 'transport.ts')

test('静态扫描：只有 transport.ts 能碰子进程，任何文件都不许自己拼 HTTP', async () => {
  const entries = await readdir(CONNECTOR_DIR, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
  assert.ok(files.includes(EXTERNAL_EGRESS_FILE))
  assert.ok(files.length >= 6, `应至少扫到 6 个 .ts 文件，实际 ${files.length}`)
  let subprocessFiles = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const [label, pattern] of FORBIDDEN_EVERYWHERE) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}`)
    }
    assert.equal(/\brequire\s*\(/.test(text), false, `${file} 不该用 require()`)
    if (file === EXTERNAL_EGRESS_FILE) {
      assert.match(text, /from 'node:child_process'/, 'transport.ts 是唯一允许的子进程出口')
      subprocessFiles += 1
      continue
    }
    for (const [label, pattern] of FORBIDDEN_SUBPROCESS) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}（外部出口只许在 transport.ts）`)
    }
  }
  assert.equal(subprocessFiles, 1, '只允许 transport.ts 一个文件碰子进程')
})
