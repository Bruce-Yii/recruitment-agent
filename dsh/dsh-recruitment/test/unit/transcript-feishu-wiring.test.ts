// 飞书 Minutes 连接器的**接线**机检（E4 / R2：未接线不得通过）。
//
// 背景：连接器包（contract / labels / adapter / transport）早就实现完整，但全仓
// 没有任何工具 import 它 —— 只被单测调用 = R2 的 BLOCKED，不是能力。本文件证明四件事：
//
//   1. **传输层只能从插件配置装配**：只有 `feishu.cli` 的**绝对路径** + 显式
//      `feishu.profile` 才会建 `lark-cli-transport`；相对路径/裸命令名被拒绝，
//      缺/坏 profile 也被拒绝（不传 `--profile` = 隐式回退开发者全局档案），
//      绝不回退 PATH / 宿主环境变量（R7）。
//   2. **默认态 fail-closed**：没配传输层时 `recruitment_transcript_import` 的连接器回读
//      路径返回 `BLOCKED / TRANSPORT_NOT_CONFIGURED`，且是在**建连/写入之前**失败
//      （测试用"连不上的数据库配置"当哨兵：真去连就会是连接错误，而不是 BLOCKED）。
//   3. **标签诚实**：即使适配器谎报 `provenance=LIVE / connection=CONNECTED`，
//      工具侧也只按**回读证据**算标签：证据不齐 → `FIXTURE / MANUAL / AUTH_REQUIRED`；
//      证据齐全（合成样本）→ `LIVE / MANUAL / CONNECTED`。`live_gate` 是口径名
//      `EVIDENCE_DRIVEN`，不是开/关常量。
//   4. **注册入口可达**：`src/index.ts` 的 `apply()` → 注册表 → 工具 `execute()`
//      → 适配器 → `lark-cli-transport`（真实发起一次子进程定位）→ `BLOCKED/CLI_UNAVAILABLE`。
//
// 本文件不连数据库、不写 ra_s6s7：数据库配置故意指向 127.0.0.1:1，任何建连都会失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_LIVE_GATE_POLICY,
  LIVE_READBACK_PROVENANCE_BASIS,
  createFeishuMinutesAdapter,
  createLarkCliTransport,
  resolveFeishuConnector,
  type FeishuCliInvocation,
  type FeishuCliRunner,
  type FeishuMinutesAdapter,
} from '../../src/connectors/feishu/index.ts'
import {
  MAX_CONTENT_CHARS,
  connectorReadbackLabels,
  createTranscriptImportTool,
  parseImportArgs,
  resolveImportSource,
} from '../../src/tools/transcript-import.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { apply } from '../../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
const TOOL_SOURCE = join(PLUGIN_DIR, 'src', 'tools', 'transcript-import.ts')
const INDEX_SOURCE = join(PLUGIN_DIR, 'src', 'index.ts')
const WIRING_SOURCE = join(PLUGIN_DIR, 'src', 'connectors', 'feishu', 'wiring.ts')

const INTERVIEW = '11111111-1111-4111-8111-000000000abc'
const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'

/** 应用凭据 + 用户令牌：**假值**，只为让适配器走到「传输层」这一环（不是真实凭据）。 */
const FAKE_AUTH_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}

/** 指向一个不存在的绝对路径：装配得起来，但真正调用时 ENOENT（不依赖本机装没装 CLI）。 */
const MISSING_CLI = join(tmpdir(), 'dsh-no-such-dir-for-feishu-wiring', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')

/** 连不上的数据库：如果代码在 BLOCKED 之前去建连，错误会变成连接失败，测试立刻变红。 */
const UNREACHABLE_DB = resolveDatabaseConfig({
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: TENANT,
  actor_id: ACTOR,
}, { RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' }).resolved

/** 从 `<CODE>: <compact-json>` 里取 JSON 体。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  return JSON.parse(index >= 0 ? message.slice(index + 2) : message) as Record<string, unknown>
}

/** 从 `apply()` 注册表里抓出来的工具（只用到 execute）。 */
interface RegisteredTool {
  readonly name: string
  readonly parameters: Record<string, unknown>
  execute(args: Record<string, unknown>, extra?: unknown): Promise<unknown>
}

/** 假适配器：只回放给定的 fetchTranscript 结局，其余方法不可用（接线测试不碰它们）。 */
function fakeAdapter(
  fetchTranscript: (request: { minute_token?: unknown; external_meeting_id?: unknown }) => Promise<unknown>,
  counter?: { calls: number },
): FeishuMinutesAdapter {
  return {
    describe: () => ({
      connector: 'feishu-minutes',
      contract_version: '1.0.0',
      implemented: ['contract', 'labels', 'lark-cli-transport'],
      not_implemented: ['http-transport', 'oauth-flow', 'event-subscription'],
      live_gate: FEISHU_LIVE_GATE_POLICY,
      live_gate_evidence: [],
    }),
    probe: () => {
      throw new Error('接线测试里不该调用 probe()')
    },
    fetchTranscript: async (request: { minute_token?: unknown; external_meeting_id?: unknown }): Promise<unknown> => {
      if (counter !== undefined) counter.calls += 1
      return await fetchTranscript(request)
    },
    mapProviderError: () => {
      throw new Error('接线测试里不该调用 mapProviderError()')
    },
    subscriptionNotes: () => {
      throw new Error('接线测试里不该调用 subscriptionNotes()')
    },
  } as unknown as FeishuMinutesAdapter
}

/** 一条合成正文（R7：测试只用合成文本，不是真实转写）。 */
const WIRING_RAW_TEXT = '面试官：请先自我介绍一下。\n候选人：好的，我最近三年主要做订单链路。'
/** 该正文的 sha256（回读对象声明的哈希，必须自洽）。 */
const WIRING_SHA = createHash('sha256').update(WIRING_RAW_TEXT, 'utf8').digest('hex')

/**
 * 一条 READ 结局。默认是**证据不齐**的形态：回读 transport=FIXTURE，
 * 回执/哈希自洽但没有平台通道与重读证据 → 工具侧只能落 FIXTURE。
 */
function readResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { readback: readbackOverrides, labels: labelOverrides, ...rest } = overrides
  return {
    kind: 'READ',
    connector: 'feishu-minutes',
    connection_state: 'AUTH_REQUIRED',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED', ...(labelOverrides as Record<string, unknown> | undefined) },
    provenance_basis: 'NO_LIVE_READ',
    live_eligible: false,
    live_gate: 'BLOCKED',
    live_gate_violations: ['transport 必须是 FEISHU_MINUTES_API（当前 FIXTURE）'],
    creates_artifact: false,
    readback: {
      transport: 'FIXTURE',
      minute_token: 'mt_wiring_1',
      revision: '7',
      read_receipt_ref: `lark:minutes+detail:mt_wiring_1@sha256:${WIRING_SHA}`,
      fetched_at: '2026-11-14T10:00:00.000+08:00',
      content_sha256: WIRING_SHA,
      is_complete: true,
      raw_text: WIRING_RAW_TEXT,
      trigger: 'MANUAL',
      page_count: 1,
      transcript_chars: WIRING_RAW_TEXT.length,
      ...(readbackOverrides as Record<string, unknown> | undefined),
    },
    requested: { minute_token_present: true, external_meeting_id_present: false },
    note: '读到字节，但证据不齐只能是 FIXTURE',
    ...rest,
  }
}

/** 一条「四样 LIVE 证据齐全」的合成 READ 结局（不是真实平台读取，只验证标签透出）。 */
function liveReadResult(): Record<string, unknown> {
  return {
    ...readResult(),
    connection_state: 'CONNECTED',
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    provenance_basis: LIVE_READBACK_PROVENANCE_BASIS,
    live_eligible: true,
    live_gate: 'LIVE',
    live_gate_violations: [],
    readback: {
      transport: 'FEISHU_MINUTES_API',
      minute_token: 'mt_wiring_live',
      revision: '7',
      read_receipt_ref: `lark:minutes+detail:mt_wiring_live@sha256:${WIRING_SHA}`,
      fetched_at: '2026-11-14T10:00:00.000+08:00',
      content_sha256: WIRING_SHA,
      reread_sha256: WIRING_SHA,
      is_complete: true,
      raw_text: WIRING_RAW_TEXT,
      trigger: 'MANUAL',
      page_count: 1,
      transcript_chars: WIRING_RAW_TEXT.length,
    },
  }
}

/** 一条 BLOCKED 结局。 */
function blockedResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'BLOCKED',
    connector: 'feishu-minutes',
    connection_state: 'AUTH_REQUIRED',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' },
    creates_artifact: false,
    error_code: 'AUTH_REQUIRED',
    blocked_reason: 'TRANSPORT_NOT_CONFIGURED',
    message: '本机没有装配传输层',
    requested: { minute_token_present: true, external_meeting_id_present: false },
    ...overrides,
  }
}

/** 一条 WAITING_EXTERNAL 结局（平台说还在生成）。 */
function waitingResult(): Record<string, unknown> {
  return {
    kind: 'WAITING_EXTERNAL',
    connector: 'feishu-minutes',
    connection_state: 'AUTH_REQUIRED',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' },
    creates_artifact: false,
    error_code: 'WAITING_EXTERNAL',
    provider_code: '2091003',
    task_state: 'WAITING_EXTERNAL',
    message: '平台说产物还在生成',
    requested: { minute_token_present: true, external_meeting_id_present: false },
  }
}

// ---------------------------------------------------------------------------
// 1. 装配来源：插件配置（绝对路径）才是唯一入口
// ---------------------------------------------------------------------------

test('resolveFeishuConnector：缺省 = 不装配传输层（默认态，不碰任何进程），live_gate 是口径名', () => {
  assert.equal(FEISHU_LIVE_GATE_POLICY, 'EVIDENCE_DRIVEN', 'Gate 不许退回硬编码开关')
  const resolved = resolveFeishuConnector(undefined, {})
  assert.equal(resolved.connector, undefined)
  assert.equal(resolved.transport_configured, false)
  assert.deepEqual(resolved.issues, [])
  const blank = resolveFeishuConnector({ cli: '   ' }, {})
  assert.equal(blank.connector, undefined, '空白 cli 等于没配，不得回退到任何默认 CLI')
})

test('resolveFeishuConnector：相对路径 / 裸命令名一律拒绝（绝不回退 PATH 或宿主环境变量）', () => {
  for (const cli of ['lark-cli', './lark-cli', 'bin/lark-cli.exe', '..\\lark-cli']) {
    const resolved = resolveFeishuConnector({ cli }, { PATH: 'C:\\fake\\bin', LARK_CLI: 'C:\\fake\\lark-cli.exe' })
    assert.equal(resolved.connector, undefined, `${cli} 不得被装配`)
    assert.equal(resolved.transport_configured, false)
    assert.equal(resolved.issues.length, 1)
    assert.match(resolved.issues[0] ?? '', /absolute path/)
  }
})

test('resolveFeishuConnector：绝对路径才装配；CLI 不存在时真实发起调用 → BLOCKED/CLI_UNAVAILABLE，标签仍 FIXTURE', async () => {
  // G7 语义收紧：cli 与 profile 必须**同时**配置才装配（不传 --profile = 隐式回退默认档案）。
  const resolved = resolveFeishuConnector({ cli: MISSING_CLI, profile: 'recruitment', timeout_ms: 5_000, max_attempts: 1 }, FAKE_AUTH_ENV)
  assert.ok(resolved.connector, '绝对路径必须装配出连接器依赖')
  assert.equal(resolved.transport_configured, true)
  assert.deepEqual(resolved.issues, [])
  const adapter = (resolved.connector as { adapter: FeishuMinutesAdapter }).adapter
  assert.equal(adapter.describe().live_gate, FEISHU_LIVE_GATE_POLICY)

  const result = await adapter.fetchTranscript({ minute_token: 'mt_wiring_1' }) as {
    kind: string
    error_code?: string
    blocked_reason?: string
    creates_artifact?: boolean
    labels?: { provenance?: string; connection?: string }
    failure?: { code?: string; stage?: string }
  }
  assert.equal(result.kind, 'BLOCKED')
  assert.equal(result.blocked_reason, 'CLI_UNAVAILABLE')
  assert.equal(result.creates_artifact, false)
  assert.equal(result.labels?.provenance, 'FIXTURE')
  assert.notEqual(result.labels?.connection, 'CONNECTED')
  // 真实走过 locate-cli 阶段（ENOENT），说明装配出来的确实是会发起调用的传输层。
  assert.equal(result.failure?.code, 'CLI_NOT_FOUND')
  assert.equal(JSON.stringify(result).includes('mt_wiring_1'), false, '不得回声 minute_token')
})

// ---------------------------------------------------------------------------
// 1b. profile：必须显式给出且合法（不传 --profile = 隐式回退开发者全局档案）
// ---------------------------------------------------------------------------

test('resolveFeishuConnector：cli 绝对但没给 profile（缺省/空串/纯空白）→ 拒绝装配', () => {
  for (const config of [
    { cli: MISSING_CLI },
    { cli: MISSING_CLI, profile: '' },
    { cli: MISSING_CLI, profile: '   ' },
  ]) {
    const resolved = resolveFeishuConnector(config, FAKE_AUTH_ENV)
    assert.equal(resolved.connector, undefined, `缺 profile 不得装配：${JSON.stringify(config)}`)
    assert.equal(resolved.transport_configured, false)
    assert.equal(resolved.issues.length, 1)
    assert.match(resolved.issues[0] ?? '', /feishu\.profile is required/)
    assert.match(resolved.issues[0] ?? '', /developer global default profile/)
    assert.match(resolved.issues[0] ?? '', /forbidden/)
  }
})

test('resolveFeishuConnector：非法 profile 名（含空白/换行、以 - 开头）→ 拒绝装配，且不回显 profile 值', () => {
  for (const profile of ['recruitment worker', 'recruitment\nsecond', '-recruitment', 'rec ruitment']) {
    const resolved = resolveFeishuConnector({ cli: MISSING_CLI, profile }, FAKE_AUTH_ENV)
    assert.equal(resolved.connector, undefined, `${JSON.stringify(profile)} 不得被装配`)
    assert.equal(resolved.transport_configured, false)
    assert.equal(resolved.issues.length, 1)
    assert.match(resolved.issues[0] ?? '', /config\.feishu\.profile 非法/)
    assert.equal(resolved.issues[0]?.includes(profile.trim()), false, '不得回显 profile 值')
  }
})

test('resolveFeishuConnector：${ENV} 展开成功才装配；未定义/空值变量逐条 issue（点名变量、不猜默认值）', () => {
  const envCli = join(tmpdir(), 'dsh-feishu-env-expand', process.platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
  const expanded = resolveFeishuConnector(
    { cli: '${RECRUITMENT_FEISHU_CLI}', profile: '${RECRUITMENT_FEISHU_PROFILE}' },
    { RECRUITMENT_FEISHU_CLI: envCli, RECRUITMENT_FEISHU_PROFILE: 'recruitment' },
  )
  assert.equal(expanded.transport_configured, true, '两个变量都能展开时必须装配')
  assert.ok(expanded.connector)
  assert.deepEqual(expanded.issues, [])

  const missingCli = resolveFeishuConnector({ cli: '${RECRUITMENT_FEISHU_CLI}', profile: 'recruitment' }, {})
  assert.equal(missingCli.connector, undefined)
  assert.equal(missingCli.transport_configured, false)
  assert.equal(missingCli.issues.length, 1)
  assert.match(missingCli.issues[0] ?? '', /config\.feishu\.cli/)
  assert.match(missingCli.issues[0] ?? '', /RECRUITMENT_FEISHU_CLI/)

  const blankCli = resolveFeishuConnector(
    { cli: '${RECRUITMENT_FEISHU_CLI}', profile: 'recruitment' },
    { RECRUITMENT_FEISHU_CLI: '   ' },
  )
  assert.equal(blankCli.connector, undefined, '空值变量不得拿原文当值、也不猜默认值')
  assert.match(blankCli.issues[0] ?? '', /RECRUITMENT_FEISHU_CLI/)

  const missingProfile = resolveFeishuConnector({ cli: envCli, profile: '${RECRUITMENT_FEISHU_PROFILE}' }, {})
  assert.equal(missingProfile.connector, undefined)
  assert.equal(missingProfile.issues.length, 1)
  assert.match(missingProfile.issues[0] ?? '', /config\.feishu\.profile/)
  assert.match(missingProfile.issues[0] ?? '', /RECRUITMENT_FEISHU_PROFILE/)

  // 只认 `${NAME}` 这一种形状：`$NAME` 原样保留（不猜、不吞）→ 仍是相对名 → 绝对路径拒绝。
  const unknownShape = resolveFeishuConnector({ cli: '$RECRUITMENT_FEISHU_CLI', profile: 'recruitment' }, {})
  assert.equal(unknownShape.connector, undefined)
  assert.match(unknownShape.issues[0] ?? '', /absolute path/)
})

test('profile-backed 凭据桥（presence-only）：空 env 也跨过 NO_APP_CREDENTIALS 门 → 真实调用 CLI_UNAVAILABLE', async () => {
  // 空 env：没有 presence-only 凭据桥时，adapter 会在传输层之前 BLOCKED/NO_APP_CREDENTIALS。
  const resolved = resolveFeishuConnector(
    { cli: MISSING_CLI, profile: 'recruitment', timeout_ms: 5_000, max_attempts: 1 },
    {},
  )
  assert.ok(resolved.connector, 'cli + profile 必须装配（凭据由 CLI profile 持有）')
  assert.equal(resolved.transport_configured, true)
  const result = await resolved.connector.adapter.fetchTranscript({ minute_token: 'mt_profile_bridge' }) as {
    kind: string
    error_code?: string
    blocked_reason?: string
    creates_artifact?: boolean
    failure?: { code?: string; stage?: string }
  }
  assert.equal(result.kind, 'BLOCKED')
  assert.equal(result.blocked_reason, 'CLI_UNAVAILABLE', '必须走到传输层（而不是 NO_APP_CREDENTIALS）')
  assert.equal(result.failure?.code, 'CLI_NOT_FOUND')
  assert.equal(result.failure?.stage, 'locate-cli')
  assert.equal(result.creates_artifact, false)
  assert.equal(JSON.stringify(result).includes('mt_profile_bridge'), false, '不得回声 minute_token')
  // 哨兵值不得出现在出口里（它只是让存在性判断通过）。
  assert.equal(JSON.stringify(result).includes('<lark-cli-profile>'), false)
})

test('坏 profile：配置/凭据层失败 → adapter 出口 AUTH_REQUIRED（不重试、零 artifact、不回显 profile 名）', async () => {
  const calls: FeishuCliInvocation[] = []
  /** 实测坏 profile 的形态：exit 3、stdout 空、stderr 是 JSON。 */
  const CONFIG_ERROR_STDERR = JSON.stringify({
    ok: false,
    identity: 'user',
    error: {
      type: 'config',
      subtype: 'not_configured',
      message: 'profile "__recruitment_no_such_profile__" not found',
      hint: 'available profiles: recruitment',
    },
    _notice: { tip: 'run `lark-cli profile list`' },
  })
  const runner: FeishuCliRunner = async (invocation) => {
    calls.push(invocation)
    return { status: 'NON_ZERO_EXIT', exit_code: 3, signal: null, stdout: '', stderr: CONFIG_ERROR_STDERR }
  }
  const transport = createLarkCliTransport({
    runner,
    platform_channel: true,
    profile: '__recruitment_no_such_profile__',
    max_attempts: 3,
    retry_base_ms: 0,
  })
  const adapter = createFeishuMinutesAdapter({ env: FAKE_AUTH_ENV, transport })
  const result = await adapter.fetchTranscript({ minute_token: 'mt_bad_profile' }) as {
    kind: string
    error_code?: string
    blocked_reason?: string
    creates_artifact?: boolean
    failure?: { code?: string; stage?: string; attempts?: number }
  }
  assert.equal(result.kind, 'BLOCKED')
  assert.equal(result.error_code, 'AUTH_REQUIRED', 'G7 验收：坏 profile → AUTH_REQUIRED')
  // adapter.ts 的既有映射（本 lane 不改 adapter）：PROVIDER_REJECTED → PROVIDER_NO_PERMISSION。
  assert.equal(result.blocked_reason, 'PROVIDER_NO_PERMISSION')
  assert.equal(result.creates_artifact, false)
  assert.equal(result.failure?.code, 'PROVIDER_REJECTED')
  assert.equal(result.failure?.stage, 'invoke')
  assert.equal(result.failure?.attempts, 1)
  assert.equal(calls.length, 1, '配置/凭据错误不得重试')
  assert.equal(JSON.stringify(result).includes('__recruitment_no_such_profile__'), false, '不得回显 profile 名')
  assert.equal(JSON.stringify(result).includes('mt_bad_profile'), false, '不得回声 minute_token')
})

// ---------------------------------------------------------------------------
// 2. 入参：不给正文也不给 token → INVALID_ARGS，且不发起任何读取/建连
// ---------------------------------------------------------------------------

test('入参：不提供正文也不提供 token → INVALID_ARGS(MISSING_REQUIRED)，不发起读取、不建连', async () => {
  assert.throws(
    () => parseImportArgs({ interview_id: INTERVIEW }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'INVALID_ARGS')
      assert.equal(parsed.reason_code, 'MISSING_REQUIRED')
      return true
    },
  )
  // 只有 external_meeting_id 也不行：没有平台产物标识不能回读。
  assert.throws(
    () => parseImportArgs({ interview_id: INTERVIEW, external_meeting_id: 'mtg_1' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'INVALID_ARGS')
      assert.equal(parsed.reason_code, 'MINUTE_TOKEN_REQUIRED')
      return true
    },
  )
  // 两条路径互斥：有正文就不能再给回读标识。
  assert.throws(
    () => parseImportArgs({ interview_id: INTERVIEW, content: 'x', source_kind: 'DEMO_SAMPLE', minute_token: 'mt_1' }),
    (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'MUTUALLY_EXCLUSIVE')
      return true
    },
  )
  // 有正文就必须说清来源（source_kind）。
  assert.throws(
    () => parseImportArgs({ interview_id: INTERVIEW, content: 'x' }),
    (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'MISSING_REQUIRED')
      return true
    },
  )

  // 走工具入口同样在**建连之前**失败（数据库配的是连不上的 127.0.0.1:1）。
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never)
  await assert.rejects(() => tool.execute({ interview_id: INTERVIEW }), (error: unknown) => {
    const parsed = errorBody(error)
    assert.equal(parsed.code, 'INVALID_ARGS')
    assert.equal(parsed.reason_code, 'MISSING_REQUIRED')
    return true
  })
})

// ---------------------------------------------------------------------------
// 3. 默认态 fail-closed：token 但无传输层 → BLOCKED（在建连之前）
// ---------------------------------------------------------------------------

test('提供 token 但没装配连接器 → BLOCKED/TRANSPORT_NOT_CONFIGURED，不建连、不写任何行', async () => {
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never)
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_wiring_blocked' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'TRANSPORT_NOT_CONFIGURED')
      const detail = parsed.detail as Record<string, unknown>
      assert.equal(detail.creates_artifact, false)
      assert.equal(detail.transport_configured, false)
      assert.equal(detail.blocked_reason, 'TRANSPORT_NOT_CONFIGURED')
      const serialized = JSON.stringify(parsed)
      assert.equal(serialized.includes('mt_wiring_blocked'), false, '不得回声 minute_token')
      return true
    },
  )
})

test('连接器依赖存在但 transport_configured=false → adapter 一次都不调用（不假装能读）', async () => {
  const counter = { calls: 0 }
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: {
      adapter: fakeAdapter(async () => blockedResult(), counter),
      transport_configured: false,
    },
  })
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_wiring_blocked_2' }),
    (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'TRANSPORT_NOT_CONFIGURED')
      return true
    },
  )
  assert.equal(counter.calls, 0, '没有传输层就不得调用适配器')
})

test('连接器无凭据（真实 adapter + 空 env）→ BLOCKED/NO_APP_CREDENTIALS，error_code=NOT_CONNECTED', async () => {
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: { adapter: createFeishuMinutesAdapter({ env: {} }), transport_configured: true },
  })
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_wiring_no_creds' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'NO_APP_CREDENTIALS')
      const detail = parsed.detail as Record<string, unknown>
      assert.equal(detail.error_code, 'NOT_CONNECTED')
      assert.equal(detail.creates_artifact, false)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 4. 适配器各出口的映射（全部不写库）
// ---------------------------------------------------------------------------

test('平台 2091003（生成中）→ BLOCKED/PROVIDER_GENERATING，不是失败也不写 artifact', async () => {
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: { adapter: fakeAdapter(async () => waitingResult()), transport_configured: true },
  })
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_generating' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'PROVIDER_GENERATING')
      const detail = parsed.detail as Record<string, unknown>
      assert.equal(detail.task_state, 'WAITING_EXTERNAL')
      assert.equal(detail.provider_code, '2091003')
      assert.equal(detail.creates_artifact, false)
      return true
    },
  )
})

test('适配器抛非预期异常 → BLOCKED/CONNECTOR_CALL_FAILED（fail-closed，不回显异常 message）', async () => {
  const tool = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: {
      adapter: fakeAdapter(async () => {
        throw new Error('boom: C:\\secret\\path\\transcript.txt')
      }),
      transport_configured: true,
    },
  })
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_throw' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'CONNECTOR_CALL_FAILED')
      assert.equal(JSON.stringify(parsed).includes('secret'), false, '异常 message 不得外传')
      return true
    },
  )
})

test('回读正文为空 / 超长 → BLOCKED（READBACK_INVALID / TRANSCRIPT_TOO_LARGE），不写库', async () => {
  const empty = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: {
      adapter: fakeAdapter(async () => readResult({ readback: { raw_text: '   ' } })),
      transport_configured: true,
    },
  })
  await assert.rejects(
    () => empty.execute({ interview_id: INTERVIEW, minute_token: 'mt_empty' }),
    (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'READBACK_INVALID')
      return true
    },
  )
  const huge = createTranscriptImportTool(UNREACHABLE_DB as never, {
    connector: {
      adapter: fakeAdapter(async () => readResult({ readback: { raw_text: 'x'.repeat(MAX_CONTENT_CHARS + 1) } })),
      transport_configured: true,
    },
  })
  await assert.rejects(
    () => huge.execute({ interview_id: INTERVIEW, minute_token: 'mt_huge' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.reason_code, 'TRANSCRIPT_TOO_LARGE')
      assert.equal((parsed.detail as Record<string, unknown>).creates_artifact, false)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 5. 标签诚实：标签由**回读证据**算，适配器谎报也越不过工具侧
// ---------------------------------------------------------------------------

test('connectorReadbackLabels：证据不齐只给 FIXTURE/MANUAL/{NOT_CONNECTED,AUTH_REQUIRED}，自报 CONNECTED 被降级', () => {
  // 证据不齐（FIXTURE 通道）的回读：provenance 恒 FIXTURE、trigger 恒 MANUAL。
  assert.deepEqual(connectorReadbackLabels({ transport: 'FIXTURE' }, 'NOT_CONNECTED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED',
  })
  assert.deepEqual(connectorReadbackLabels({ transport: 'FIXTURE' }, 'AUTH_REQUIRED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED',
  })
  // 适配器（或任何上游）谎报 CONNECTED：证据不齐就只能降级为 AUTH_REQUIRED。
  assert.deepEqual(connectorReadbackLabels({ transport: 'FIXTURE' }, 'CONNECTED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED',
  })
  // 证据齐全的合成回读：gate=LIVE 才允许 LIVE/CONNECTED。
  const live = (liveReadResult().readback) as Record<string, unknown>
  assert.deepEqual(connectorReadbackLabels(live, 'AUTH_REQUIRED'), {
    provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED',
  })
})

test('resolveImportSource：证据不齐的 READ 即使适配器谎报 LIVE/EVENT/CONNECTED，也只落 FIXTURE/MANUAL/AUTH_REQUIRED', async () => {
  const reading = readResult({
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
    connection_state: 'CONNECTED',
    // 自报标签是假的，但回读证据也不齐：通道仍是测试通道 FIXTURE。
    readback: { transport: 'FIXTURE' },
  })
  const source = await resolveImportSource(
    { interview_id: INTERVIEW, minute_token: 'mt_wiring_lying' },
    { adapter: fakeAdapter(async () => reading), transport_configured: true },
  )
  assert.equal(source.mode, 'CONNECTOR_READBACK')
  if (source.mode !== 'CONNECTOR_READBACK') return
  assert.deepEqual(source.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' })
  assert.equal(source.liveGate.gate, 'BLOCKED')
  assert.ok(source.liveGate.violations.some((violation) => violation.includes('transport')))
  assert.equal(source.minuteToken, 'mt_wiring_lying')
  assert.equal(source.content.includes('面试官'), true)
})

test('resolveImportSource：证据齐全的 READ → LIVE/MANUAL/CONNECTED + LIVE_READBACK_VERIFIED（标签透出）', async () => {
  const source = await resolveImportSource(
    { interview_id: INTERVIEW, minute_token: 'mt_wiring_live' },
    { adapter: fakeAdapter(async () => liveReadResult()), transport_configured: true },
  )
  assert.equal(source.mode, 'CONNECTOR_READBACK')
  if (source.mode !== 'CONNECTOR_READBACK') return
  assert.deepEqual(source.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  assert.equal(source.liveGate.gate, 'LIVE')
  assert.equal(source.liveGate.provenance_basis, LIVE_READBACK_PROVENANCE_BASIS)
  assert.deepEqual(source.liveGate.violations, [])
  assert.equal(source.readback.read_receipt_ref.includes('@sha256:'), true)
})

test('resolveImportSource：回读对象自相矛盾（哈希不一致）→ BLOCKED/READBACK_INVALID，不是降级写 FIXTURE', async () => {
  // 回执/声明哈希都是 aaaa…，但 raw_text 是 WIRING_RAW_TEXT：重算哈希对不上。
  const reading = readResult({
    readback: {
      transport: 'FEISHU_MINUTES_API',
      content_sha256: 'a'.repeat(64),
      read_receipt_ref: `lark:minutes+detail:mt_wiring_bad@sha256:${'a'.repeat(64)}`,
      reread_sha256: 'a'.repeat(64),
    },
  })
  await assert.rejects(
    () => resolveImportSource(
      { interview_id: INTERVIEW, minute_token: 'mt_wiring_bad' },
      { adapter: fakeAdapter(async () => reading), transport_configured: true },
    ),
    (error: unknown) => {
      const parsed = errorBody(error)
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'READBACK_INVALID')
      const detail = parsed.detail as Record<string, unknown>
      assert.equal(detail.creates_artifact, false)
      assert.ok(Array.isArray(detail.violations) && (detail.violations as unknown[]).length > 0)
      assert.match(String(parsed.message), /回读不一致是失败/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 6. 注册入口可达（R2 / E4 的直接证据）
// ---------------------------------------------------------------------------

test('apply() 注册入口：feishu.cli（插件配置）→ 注册的 recruitment_transcript_import 真的走到 lark-cli-transport', async () => {
  const registered: RegisteredTool[] = []
  const ctx = {
    tools: { register: (tool: RegisteredTool) => registered.push(tool) },
    effect: (fn: () => unknown) => fn(),
    inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
  }
  // 完整 database 配置（否则工具会被 NOT_CONFIGURED 替身占位）+ 插件配置里的 feishu.cli。
  // 数据库指向 127.0.0.1:1：如果接线错了、在 BLOCKED 之前建连，这里会变成连接错误。
  apply(ctx as never, {
    database: {
      host: '127.0.0.1',
      port: 1,
      user: 'postgres',
      database: 'ra_s6s7',
      tenant_id: TENANT,
      actor_id: ACTOR,
    },
    feishu: { cli: MISSING_CLI, profile: 'recruitment', timeout_ms: 5_000, max_attempts: 1 },
  }, { ...FAKE_AUTH_ENV, RECRUITMENT_DB_PASSWORD: 'unused-in-this-test' })

  const names = registered.map((tool) => tool.name)
  assert.ok(names.includes('recruitment_transcript_import'), `注册点少了转写导入：${names.join(', ')}`)

  const tool = registered.find((candidate) => candidate.name === 'recruitment_transcript_import') as RegisteredTool
  await assert.rejects(
    () => tool.execute({ interview_id: INTERVIEW, minute_token: 'mt_apply_wiring' }),
    (error: unknown) => {
      const parsed = errorBody(error)
      // 只有「配置 → 适配器 → 传输层 → 真实调 CLI」这条链是通的，才可能拿到 CLI_UNAVAILABLE。
      assert.equal(parsed.code, 'BLOCKED')
      assert.equal(parsed.reason_code, 'CLI_UNAVAILABLE')
      const detail = parsed.detail as Record<string, unknown>
      assert.equal(detail.blocked_reason, 'CLI_UNAVAILABLE')
      assert.equal(detail.creates_artifact, false)
      const failure = detail.failure as Record<string, unknown> | undefined
      assert.equal(failure?.stage, 'locate-cli')
      return true
    },
  )
})

test('静态守卫：index.ts 把 feishu 配置/连接器依赖传给工具；工具 import 了连接器；wiring.ts 不读 PATH/env 取 CLI', async () => {
  const toolText = await readFile(TOOL_SOURCE, 'utf8')
  const indexText = await readFile(INDEX_SOURCE, 'utf8')
  const wiringText = await readFile(WIRING_SOURCE, 'utf8')

  // 连接器不再是「库里的死代码」：工具模块直接 import 连接器唯一出口并调用 fetchTranscript。
  assert.match(toolText, /from '\.\.\/connectors\/feishu\/index\.ts'/)
  assert.match(toolText, /adapter\.fetchTranscript\(/)
  assert.match(toolText, /connectorReadbackLabels/)
  // 工具自己绝不读环境变量取 CLI / 自己起进程（传输层只在 transport.ts）。
  assert.equal(/child_process|\bspawn\b|execSync/.test(toolText), false)

  // 注册入口：可选配置 feishu → resolveFeishuConnector → createTranscriptImportTool 依赖。
  assert.match(indexText, /import \{ resolveFeishuConnector, type FeishuConnectorConfig \} from '\.\/connectors\/feishu\/index\.ts'/)
  assert.match(indexText, /resolveFeishuConnector\(config\?\.feishu \?\? \{\}, env\)/)
  assert.match(indexText, /createTranscriptImportTool\(database\.resolved, \{/)
  assert.match(indexText, /connector: feishu\.connector/)
  assert.match(indexText, /connector_issues: feishu\.issues/)
  // 注册点仍在（插件卸载即注销）
  assert.match(indexText, /ctx\.tools\.register\(tool\)/)

  // R7：CLI 只从插件配置来，不得从 PATH / 环境变量偷开发者全局 CLI。
  assert.match(wiringText, /typeof config\.cli === 'string'/)
  assert.equal(/child_process|\bspawn\b|execSync/.test(wiringText), false)
  assert.equal(/process\.env\.(PATH|LARK_CLI|FEISHU_CLI)|env\[['"]PATH|env\[['"]LARK_CLI/.test(wiringText), false)
  assert.match(wiringText, /must be an absolute path/)
})
