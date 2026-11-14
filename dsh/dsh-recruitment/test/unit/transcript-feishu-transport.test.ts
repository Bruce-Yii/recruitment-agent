// `lark-cli-transport` 的机检：分页 / 生成中 / 超时 / 缺 CLI / 非零退出 / 回执 / 脱敏 / 重读校验。
//
// 两个层次的假 CLI：
//   1. **注入的 runner**（纯内存）：验证重试计数、退避、分页游标、解析分支；
//   2. **真实子进程跑 `test/fixtures/feishu/fake-lark-cli.mjs`**：验证进程管理
//      （ENOENT、非零退出、超时杀进程、stdout/stderr 采集）。
//
// 贯穿全文件的一条硬断言：**测试通道（默认 `platform_channel=false`）读到的假数据
// 永远不可能被标成 LIVE**：`readback.transport=FIXTURE`，
// `buildArtifactLabelsFromReadback()` 抛 `LABEL_DISHONEST_LIVE`。
// 只有接线层声明 `platform_channel=true` 且两次完整回读哈希一致时，回读才可能
// 证据齐全（本文件有正例；正文都是合成语料，R7）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_LARK_CLI,
  FEISHU_LIVE_GATE_POLICY,
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
  FEISHU_CLI_TRANSCRIPT_FLAGS,
  FeishuTransportError,
  buildReadReceipt,
  buildTranscriptArgs,
  createLarkCliTransport,
  createProcessCliRunner,
  isoWithOffset,
  sanitizeDiagnostic,
  sha256Hex,
  type FeishuCliInvocation,
  type FeishuCliRunResult,
  type FeishuCliRunner,
} from '../../src/connectors/feishu/transport.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const CONNECTOR_DIR = join(PLUGIN_DIR, 'src', 'connectors', 'feishu')
const FAKE_CLI = join(PLUGIN_DIR, 'test', 'fixtures', 'feishu', 'fake-lark-cli.mjs')

/** 应用凭据 + 用户令牌：本机最接近「看起来能连上」的形态（**假值**，不是真实凭据）。 */
const USER_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}

/** 假正文里的一段（合成语料；用来证明诊断里不会出现它）。 */
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

/** 记录调用并按顺序回放的假 runner。 */
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

/** 造一个 `{ok:true,data:{…}}` 信封。 */
function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, data })
}

/** 一页正文（sentences 形态）。 */
function page(texts: readonly string[], extra: Record<string, unknown> = {}): string {
  return envelope({ minute_token: 'mt_1', revision: '7', has_more: false, transcript: { sentences: texts.map((text) => ({ text })) }, ...extra })
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
// argv 与回执：契约常量是唯一来源
// ---------------------------------------------------------------------------

test('buildTranscriptArgs：argv 由 FEISHU_LARK_CLI 常量拆出，不另写一份命令', () => {
  assert.deepEqual(buildTranscriptArgs(), ['minutes', '+detail', '--transcript'])
  assert.deepEqual(buildTranscriptArgs(['--format', 'json']), ['minutes', '+detail', '--transcript', '--format', 'json'])
  assert.equal(FEISHU_LARK_CLI.minutesDetailTranscript, 'minutes +detail --transcript')
  // 参数名标注「未核实」，不许在代码里假装已核对。
  assert.equal(FEISHU_CLI_TRANSCRIPT_FLAGS.minute_token, '--minute-token')
})

test('回执 / sha / 时间：都是纯函数，格式与 labels.ts 的闸门一致', () => {
  const text = '面试官：开始吧。\n候选人：好的。'
  const digest = sha256Hex(text)
  // 回执必须把 minute_token 绑到**内容哈希**上（D-1：真实 revision 之外还要 hash）。
  assert.equal(buildReadReceipt('mt_1', digest), `lark:minutes+detail:mt_1@sha256:${digest}`)
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const iso = isoWithOffset(new Date('2026-11-13T10:00:00Z'))
  // labels.ts 的 fetched_at 闸门只收带偏移的 ISO-8601。
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
  assert.equal(Number.isFinite(Date.parse(iso)), true)
})

// ---------------------------------------------------------------------------
// 成功路径（注入 runner）
// ---------------------------------------------------------------------------

test('测试通道单页成功：回执绑定哈希 / sha 自洽，但 transport 只能是 FIXTURE', async () => {
  const text = '面试官：开始吧。\n候选人：好的。'
  const { runner, calls } = scripted([ok(page(['面试官：开始吧。', '候选人：好的。']))])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, now: () => new Date('2026-11-13T10:00:00Z') })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  const readback = result.readback
  assert.equal(readback.read_receipt_ref, `lark:minutes+detail:mt_1@sha256:${sha256Hex(text)}`)
  assert.equal(readback.is_complete, true)
  assert.equal(readback.page_count, 1)
  assert.equal(readback.raw_text, text)
  assert.equal(readback.content_sha256, sha256Hex(readback.raw_text))
  assert.match(readback.content_sha256, /^[0-9a-f]{64}$/)
  assert.equal(readback.trigger, 'MANUAL')
  // 测试通道没有重读校验，也没有平台通道身份。
  assert.equal(readback.reread_sha256, undefined)

  // 关键：默认 platform_channel=false，读成功也不冒充平台来源 → 永远不可能 LIVE。
  assert.equal(readback.transport, FEISHU_TRANSPORT.fixture)
  assert.equal(isLiveEligible(readback), false)
  assert.ok(liveEligibilityViolations(readback).some((violation) => violation.includes('transport')))
  assert.throws(() => buildArtifactLabelsFromReadback(readback), isDishonestLive)

  // CLI 契约：命令来自常量，minute_token 与 page_size 都按约定传。
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args.slice(0, 3), ['minutes', '+detail', '--transcript'])
  assert.equal(calls[0]!.args.includes(FEISHU_CLI_TRANSCRIPT_FLAGS.minute_token), true)
  assert.equal(calls[0]!.args.includes('mt_1'), true)
  assert.equal(calls[0]!.args[0], 'minutes', 'argv[0] 是契约常量里的子命令，可执行文件由 runner 配')
})

// ---------------------------------------------------------------------------
// 平台通道：重读校验 + 证据驱动 LIVE（合成正文，R7）
// ---------------------------------------------------------------------------

test('平台通道（platform_channel=true）：两次完整回读哈希一致 → 回读证据齐全 → LIVE/MANUAL', async () => {
  const text = '面试官：开始吧。\n候选人：好的。'
  const calls: FeishuCliInvocation[] = []
  const runner: FeishuCliRunner = async (invocation) => {
    calls.push(invocation)
    return ok(page(['面试官：开始吧。', '候选人：好的。']))
  }
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

  // 平台通道身份 + 重读哈希 + 完整回执。
  assert.equal(readback.transport, FEISHU_TRANSPORT.api)
  assert.equal(readback.reread_sha256, sha256Hex(text))
  assert.equal(readback.content_sha256, sha256Hex(text))
  assert.equal(readback.read_receipt_ref, `lark:minutes+detail:mt_1@sha256:${sha256Hex(text)}`)
  assert.equal(calls.length, 2, '平台通道必须完整读两次做重读校验')

  const decision = evaluateLiveGate(readback)
  assert.equal(decision.gate, 'LIVE')
  assert.deepEqual(decision.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(decision.provenance_basis, LIVE_READBACK_PROVENANCE_BASIS)
  assert.deepEqual(decision.violations, [])
  assert.deepEqual(buildArtifactLabelsFromReadback(readback), decision.labels)
})

test('平台通道：两次回读哈希不一致 → FAILED/READBACK_INVALID（不一致是失败，不是警告）', async () => {
  let call = 0
  const runner: FeishuCliRunner = async () => {
    call += 1
    // 第一遍是「甲」，第二遍是「乙」：同一 minute_token 两次读到的字节不同。
    return ok(call === 1 ? page(['甲：合成内容第一遍。']) : page(['乙：合成内容第二遍。']))
  }
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, platform_channel: true })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'validate')
  assert.equal(result.error.code, 'READBACK_INVALID')
  assert.match(result.error.message, /重读校验失败/)
  assert.equal(result.error.message.includes('合成内容'), false, '诊断不得回显正文')
  assert.equal(call, 2)
})

test('平台通道：第二次读取失败 → 整个读取 FAILED（不拿第一次的半证据当结果）', async () => {
  let call = 0
  const runner: FeishuCliRunner = async () => {
    call += 1
    return call === 1 ? ok(page(['甲：合成内容。'])) : exitWith(3, 'boom')
  }
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0, platform_channel: true })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.code, 'CLI_NON_ZERO_EXIT')
})

test('分页：has_more=true → 带 page_token 取下一页，直到 has_more=false 才算完整', async () => {
  const { runner, calls } = scripted([
    ok(page(['第一页甲。'], { has_more: true, page_token: 'p2' })),
    ok(page(['第二页乙。'], { page_token: undefined })),
  ])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  assert.equal(result.readback.page_count, 2)
  assert.equal(result.readback.raw_text, '第一页甲。\n第二页乙。')
  assert.equal(result.readback.is_complete, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.args.includes('--page-token'), true)
  assert.equal(calls[1]!.args.includes('p2'), true)
})

// ---------------------------------------------------------------------------
// 「生成中」不是失败
// ---------------------------------------------------------------------------

test('生成中：{ok:false, 2091003} → WAITING_EXTERNAL，不建 artifact、不重试', async () => {
  const { runner, calls } = scripted([
    ok(JSON.stringify({ ok: false, error: { code: 2091003, message: 'still generating' } })),
  ])
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

// ---------------------------------------------------------------------------
// 失败可诊断 + 重试
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 分页缺陷：不许拿半截当全文
// ---------------------------------------------------------------------------

test('分页停滞：游标不前进 → stage=paginate / code=PAGINATION_STALLED', async () => {
  const { runner } = scripted([
    ok(page(['甲。'], { has_more: true, page_token: 'p2' })),
    ok(page(['乙。'], { has_more: true, page_token: 'p2' })),
  ])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'paginate')
  assert.equal(result.error.code, 'PAGINATION_STALLED')
})

test('分页未读完：has_more 缺失 → PAGINATION_INCOMPLETE；页数超上限 → PAGE_LIMIT_EXCEEDED', async () => {
  const missing = scripted([ok(envelope({ minute_token: 'mt_1', revision: '7', transcript: { sentences: [{ text: '甲。' }] } }))])
  const first = await createLarkCliTransport({ runner: missing.runner, retry_base_ms: 0 }).read({ minute_token: 'mt_1' })
  assert.equal(first.status, 'FAILED')
  if (first.status === 'FAILED') assert.equal(first.error.code, 'PAGINATION_INCOMPLETE')

  const looping: FeishuCliRunResult[] = []
  for (let index = 0; index < 5; index += 1) looping.push(ok(page(['甲。'], { has_more: true, page_token: `p${index + 2}` })))
  const second = await createLarkCliTransport({ runner: scripted(looping).runner, retry_base_ms: 0, max_pages: 3 }).read({ minute_token: 'mt_1' })
  assert.equal(second.status, 'FAILED')
  if (second.status === 'FAILED') {
    assert.equal(second.error.code, 'PAGE_LIMIT_EXCEEDED')
    assert.equal(second.error.stage, 'paginate')
  }
})

// ---------------------------------------------------------------------------
// 回执 / 形状自检（fail-closed）
// ---------------------------------------------------------------------------

test('回执拼不出来：缺 revision → REVISION_REQUIRED；正文为空 → TRANSCRIPT_EMPTY', async () => {
  const noRevision = scripted([ok(envelope({ minute_token: 'mt_1', has_more: false, transcript: { sentences: [{ text: '甲。' }] } }))])
  const first = await createLarkCliTransport({ runner: noRevision.runner, retry_base_ms: 0 }).read({ minute_token: 'mt_1' })
  assert.equal(first.status, 'FAILED')
  if (first.status === 'FAILED') {
    assert.equal(first.error.stage, 'validate')
    assert.equal(first.error.code, 'REVISION_REQUIRED')
    assert.match(first.error.message, /revision/)
  }

  const empty = scripted([ok(envelope({ minute_token: 'mt_1', revision: '7', has_more: false, transcript: { sentences: [] } }))])
  const second = await createLarkCliTransport({ runner: empty.runner, retry_base_ms: 0 }).read({ minute_token: 'mt_1' })
  assert.equal(second.status, 'FAILED')
  if (second.status === 'FAILED') assert.equal(second.error.code, 'TRANSCRIPT_EMPTY')
})

test('回执格式不对：平台回显别的 minute_token → READBACK_INVALID（不认错会议）', async () => {
  const { runner } = scripted([ok(envelope({ minute_token: 'mt_someone_else', revision: '7', has_more: false, transcript: { sentences: [{ text: '甲。' }] } }))])
  const transport = createLarkCliTransport({ runner, retry_base_ms: 0 })
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'FAILED')
  if (result.status !== 'FAILED') return
  assert.equal(result.error.stage, 'validate')
  assert.equal(result.error.code, 'READBACK_INVALID')
})

test('形状不认识：非 JSON / 找不到正文容器 → stage=parse，且不回显输出内容', async () => {
  const bad = scripted([ok(`not json：${SECRET_BODY}`)])
  const first = await createLarkCliTransport({ runner: bad.runner, retry_base_ms: 0 }).read({ minute_token: 'mt_1' })
  assert.equal(first.status, 'FAILED')
  if (first.status === 'FAILED') {
    assert.equal(first.error.stage, 'parse')
    assert.equal(first.error.code, 'ENVELOPE_UNRECOGNIZED')
    assert.equal(first.error.message.includes(SECRET_BODY), false, '非 JSON 输出不得回显')
  }

  const unrecognized = scripted([ok(envelope({ minute_token: 'mt_1', revision: '7', has_more: false }))])
  const second = await createLarkCliTransport({ runner: unrecognized.runner, retry_base_ms: 0 }).read({ minute_token: 'mt_1' })
  assert.equal(second.status, 'FAILED')
  if (second.status === 'FAILED') assert.equal(second.error.code, 'TRANSCRIPT_UNRECOGNIZED')
})

// ---------------------------------------------------------------------------
// R7：诊断里不许出现正文
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
// 真实子进程：进程管理 + 超时杀进程
// ---------------------------------------------------------------------------

test('真实子进程：两页成功读完整文（假 CLI 脚本），回读仍只能是 FIXTURE', async () => {
  const transport = processTransport('ok')
  const result = await transport.read({ minute_token: 'mt_1' })
  assert.equal(result.status, 'READ')
  if (result.status !== 'READ') return
  assert.equal(result.readback.page_count, 2)
  assert.equal(result.readback.is_complete, true)
  assert.match(result.readback.raw_text, /候选人/)
  assert.equal(result.readback.transport, FEISHU_TRANSPORT.fixture)
  assert.equal(isLiveEligible(result.readback), false)
  assert.throws(() => buildArtifactLabelsFromReadback(result.readback), isDishonestLive)
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
  assert.ok(elapsed < 20_000, `超时没有被及时处理（${elapsed} ms）`)
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
// 适配器：默认不接线、不产 LIVE、说清卡在哪一环
// ---------------------------------------------------------------------------

test('describe()：lark-cli-transport 已从 not_implemented 移除；live_gate 是口径名，状态按读取算', () => {
  const described = createFeishuMinutesAdapter({ env: USER_ENV }).describe()
  assert.equal(described.live_gate, 'EVIDENCE_DRIVEN')
  assert.equal(FEISHU_LIVE_GATE_POLICY, 'EVIDENCE_DRIVEN')
  assert.ok(described.live_gate_evidence.length > 0)
  assert.ok(described.implemented.includes('lark-cli-transport'))
  assert.deepEqual([...described.not_implemented], ['http-transport', 'oauth-flow', 'event-subscription'])
  assert.equal(described.not_implemented.includes('lark-cli-transport'), false)
})

test('transport.describe()：默认测试通道 = platform_channel:false / readback_transport:FIXTURE', () => {
  const transport = createLarkCliTransport({ runner: async () => ok(page(['甲。'])) })
  const described = transport.describe()
  assert.equal(described.live_gate, 'EVIDENCE_DRIVEN')
  assert.equal(described.platform_channel, false)
  assert.equal(described.readback_transport, FEISHU_TRANSPORT.fixture)
})

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

test('适配器接上假 CLI（测试通道）：READ 但 live_eligible=false，回执已绑哈希、缺平台通道证据', async () => {
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

test('适配器 + 平台通道（合成假 CLI）：两次回读一致 → READ 就是 LIVE/MANUAL/CONNECTED', async () => {
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
  // 合成正文不得写进诊断/日志（R7）：只检查 note 里没有正文片段。
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
        transport: 'FEISHU_MINUTES_API' as const,
        minute_token: 'mt_1',
        revision: '7',
        read_receipt_ref: `lark:minutes+detail:mt_1@sha256:${'a'.repeat(64)}`,
        fetched_at: '2026-11-13T10:00:00+08:00',
        content_sha256: 'a'.repeat(64),
        reread_sha256: 'a'.repeat(64),
        is_complete: true,
        raw_text: '面试官：合成内容。',
        trigger: 'MANUAL' as const,
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
      page_size: 50,
      max_pages: 1,
      diagnostic_bytes: 0,
      live_gate: FEISHU_LIVE_GATE_POLICY as 'EVIDENCE_DRIVEN',
      platform_channel: true,
      readback_transport: 'FEISHU_MINUTES_API' as const,
      argument_flags_verified: false as const,
      envelope_verified: false as const,
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
  ['fetch(', /fetch\s*\(/],
  ['node:http', /node:http/],
  ['node:https', /node:https/],
  ['node:net', /node:net/],
  ['undici', /undici/i],
  ['require', /\brequire\s*\(/],
]

/** 除 transport.ts 之外一律禁用的子进程形态。 */
const FORBIDDEN_OUTSIDE_TRANSPORT: ReadonlyArray<readonly [string, RegExp]> = [
  ['child_process', /child_process/],
  ['spawn', /\bspawn\b/i],
  ['execSync', /\bexecSync\b/],
]

test('静态扫描：只有 transport.ts 能碰子进程，任何文件都不许自己拼 HTTP', async () => {
  const entries = await readdir(CONNECTOR_DIR, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
  assert.ok(files.length >= 5, `应至少扫到 5 个 .ts 文件（含 transport.ts），实际 ${files.length}`)

  let childProcessFiles = 0
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const [label, pattern] of FORBIDDEN_EVERYWHERE) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}`)
    }
    if (file.endsWith('transport.ts')) {
      assert.match(text, /from 'node:child_process'/, 'transport.ts 才是唯一允许的子进程出口')
      childProcessFiles += 1
      continue
    }
    for (const [label, pattern] of FORBIDDEN_OUTSIDE_TRANSPORT) {
      assert.equal(pattern.test(text), false, `${file} 命中禁用形态 ${label}（外部出口只许在 transport.ts）`)
    }
  }
  assert.equal(childProcessFiles, 1, '只允许 transport.ts 一个文件碰子进程')
})
