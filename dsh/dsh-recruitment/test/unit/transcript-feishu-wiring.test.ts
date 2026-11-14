// 飞书 Minutes 连接器的**接线**机检（E4 / R2：未接线不得通过）。
//
// 背景：连接器包（contract / labels / adapter / transport）早就实现完整，但全仓
// 没有任何工具 import 它 —— 只被单测调用 = R2 的 BLOCKED，不是能力。本文件证明四件事：
//
//   1. **传输层只能从插件配置装配**：只有 `feishu.cli` 的**绝对路径**才会建
//      `lark-cli-transport`；相对路径/裸命令名被拒绝，绝不回退 PATH / 宿主环境变量（R7）。
//   2. **默认态 fail-closed**：没配传输层时 `recruitment_transcript_import` 的连接器回读
//      路径返回 `BLOCKED / TRANSPORT_NOT_CONFIGURED`，且是在**建连/写入之前**失败
//      （测试用"连不上的数据库配置"当哨兵：真去连就会是连接错误，而不是 BLOCKED）。
//   3. **标签诚实**：即使适配器谎报 `provenance=LIVE / connection=CONNECTED`，
//      工具侧也只按 `FIXTURE / MANUAL / AUTH_REQUIRED` 落库；`FEISHU_MINUTES_LIVE_GATE`
//      保持 `BLOCKED`（labels.ts 的证据闸门一条没放松）。
//   4. **注册入口可达**：`src/index.ts` 的 `apply()` → 注册表 → 工具 `execute()`
//      → 适配器 → `lark-cli-transport`（真实发起一次子进程定位）→ `BLOCKED/CLI_UNAVAILABLE`。
//
// 本文件不连数据库、不写 ra_s6s7：数据库配置故意指向 127.0.0.1:1，任何建连都会失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  FEISHU_MINUTES_LIVE_GATE,
  createFeishuMinutesAdapter,
  resolveFeishuConnector,
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
      live_gate: 'BLOCKED',
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

/** 一条合法的 READ 结局（回读对象的 transport=FIXTURE：Gate=BLOCKED 的真实形状）。 */
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
    creates_artifact: false,
    readback: {
      transport: 'FIXTURE',
      minute_token: 'mt_wiring_1',
      revision: '7',
      read_receipt_ref: 'lark:minutes+detail:mt_wiring_1@7',
      fetched_at: '2026-11-14T10:00:00.000+08:00',
      content_sha256: 'a'.repeat(64),
      is_complete: true,
      raw_text: '面试官：请先自我介绍一下。\n候选人：好的，我最近三年主要做订单链路。',
      page_count: 1,
      transcript_chars: 30,
      ...(readbackOverrides as Record<string, unknown> | undefined),
    },
    requested: { minute_token_present: true, external_meeting_id_present: false },
    note: '读到了字节，但 Live Gate=BLOCKED',
    ...rest,
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

test('resolveFeishuConnector：缺省 = 不装配传输层（默认态，不碰任何进程），live_gate 仍是 BLOCKED', () => {
  assert.equal(FEISHU_MINUTES_LIVE_GATE, 'BLOCKED', 'LIVE Gate 不许在接线时被改开')
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
  const resolved = resolveFeishuConnector({ cli: MISSING_CLI, timeout_ms: 5_000, max_attempts: 1 }, FAKE_AUTH_ENV)
  assert.ok(resolved.connector, '绝对路径必须装配出连接器依赖')
  assert.equal(resolved.transport_configured, true)
  assert.deepEqual(resolved.issues, [])
  const adapter = (resolved.connector as { adapter: FeishuMinutesAdapter }).adapter
  assert.equal(adapter.describe().live_gate, 'BLOCKED')

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
// 5. 标签诚实：适配器谎报 LIVE/CONNECTED 也越不过工具侧
// ---------------------------------------------------------------------------

test('connectorReadbackLabels：只有 FIXTURE/MANUAL/{NOT_CONNECTED,AUTH_REQUIRED}，CONNECTED 被降级', () => {
  assert.deepEqual(connectorReadbackLabels('NOT_CONNECTED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED',
  })
  assert.deepEqual(connectorReadbackLabels('AUTH_REQUIRED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED',
  })
  // 适配器（或任何上游）谎报 CONNECTED：工具侧只能降级，不可能写 CONNECTED。
  assert.deepEqual(connectorReadbackLabels('CONNECTED'), {
    provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED',
  })
})

test('resolveImportSource：适配器谎报 LIVE/EVENT/CONNECTED 的 READ → 来源标签仍被收敛为 FIXTURE/MANUAL/AUTH_REQUIRED', async () => {
  const reading = readResult({
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
    connection_state: 'CONNECTED',
    readback: { transport: 'FEISHU_MINUTES_API' },
  })
  const source = await resolveImportSource(
    { interview_id: INTERVIEW, minute_token: 'mt_wiring_lying' },
    { adapter: fakeAdapter(async () => reading), transport_configured: true },
  )
  assert.equal(source.mode, 'CONNECTOR_READBACK')
  if (source.mode !== 'CONNECTOR_READBACK') return
  assert.deepEqual(source.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' })
  assert.equal(source.minuteToken, 'mt_wiring_lying')
  assert.equal(source.content.includes('面试官'), true)
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
    feishu: { cli: MISSING_CLI, timeout_ms: 5_000, max_attempts: 1 },
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
