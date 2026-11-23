// 工作空间设置 HTTP 层 · **无真库**单元测试（假 ctx / 真 node:http）。
//
// 不 import src/index.ts（接线由 lead 完成）；所有被断言的闸门都发生在碰 DB 之前，
// 或用 deps.hooks 的测试观测点替代数据源 —— 因此不需要 PG，也不会写库。
// 复用 `test/unit/action-p0.test.ts` 的真 HTTP + 假 webServer.register + 真 identity helper 模式。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerSettingsHttp, SETTINGS_PATHS, type SettingsHttpDeps } from '../../src/http/settings.ts'
import { SLA_HOURS_MAX, SLA_HOURS_MIN } from '../../src/domain/tenant-config.ts'

const SESSION_RECRUITER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_UNBOUND = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'

const EXPECTED_ROUTES = [
  `exact ${SETTINGS_PATHS.read}`,
  `exact ${SETTINGS_PATHS.write}`,
  `exact ${SETTINGS_PATHS.configOrg}`,
]
assert.deepEqual(EXPECTED_ROUTES, [
  'exact /recruitment/api/settings',
  'exact /recruitment/api/action/settings/write',
  'exact /recruitment/api/config/org',
])

interface Harness {
  readonly baseUrl: string
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  readonly routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>
  readonly dispose: () => void
  close(): Promise<void>
}

async function startServer(
  deps: SettingsHttpDeps,
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const dispose = registerSettingsHttp(
    {
      webServer: {
        host,
        port,
        register(route) {
          registered.push({ kind: route.kind, path: route.path })
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
      logger: { warn(message: string) { warnings.push(message) } },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    registered,
    warnings,
    routes,
    dispose,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

interface CallOptions {
  readonly session?: string
  readonly body?: unknown
  readonly method?: string
}

async function call(h: Harness, path: string, options: CallOptions = {}) {
  const headers: Record<string, string> = { 'x-recruitment-request': '1' }
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${h.baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: payload,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text, headers: response.headers }
}

function assertError(result: { status: number; body: Record<string, unknown>; text: string }, status: number, code: string, reason?: string) {
  assert.equal(result.status, status, `状态应为 ${status}: ${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `应为错误信封: ${result.text}`)
  assert.equal(error.code, code, `code 应为 ${code}: ${result.text}`)
  if (reason !== undefined) assert.equal(error.reason_code, reason, `reason_code 应为 ${reason}: ${result.text}`)
}

let identity: DemoActorIdentity
let writeCalls: Record<string, unknown>[]
let baseDeps: SettingsHttpDeps
let server: Harness

before(async () => {
  const created = createDemoActorIdentity()
  identity = created.identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')
  writeCalls = []
  // database = null：任何走到 DB 的分支都会得到 503 NOT_CONFIGURED（与断言的 4xx 不同，
  // 因此断言 4xx 即证明"零写入"）。GET 用 hooks.readAll 提供空投影。
  baseDeps = {
    database: null,
    databaseIssues: ['config.database.host is required'],
    identity,
    mailConfig: {},
    mailEnv: {},
    feishuConfig: {},
    feishuEnv: {},
    hooks: {
      beforeWrite(input) { writeCalls.push(input as unknown as Record<string, unknown>) },
      async readAll() { return [] },
    },
  }
  server = await startServer(baseDeps)
})

after(async () => {
  server.dispose()
  await server.close()
})

// ---------------------------------------------------------------------------
//  T1 注册 / 注销 / 非回环
// ---------------------------------------------------------------------------

describe('T1 路由注册', () => {
  test('回环 host 恰好注册 3 条 exact 路由，路径逐字一致', () => {
    assert.deepEqual(server.registered.map((r) => `${r.kind} ${r.path}`), EXPECTED_ROUTES)
    assert.deepEqual([...new Set(server.registered.map((r) => r.kind))], ['exact'])
  })

  test('非回环 host（0.0.0.0）注册 0 条 + 一条 warn，disposer 为空操作', async () => {
    const h = await startServer(baseDeps, '0.0.0.0')
    try {
      assert.deepEqual(h.registered, [])
      assert.equal(h.warnings.length, 1)
      assert.match(h.warnings[0] as string, /未注册[\s\S]*不是回环地址/)
      h.dispose()
      assert.equal(h.routes.size, 0)
    } finally {
      await h.close()
    }
  })

  test('disposer 调用后三条路由全部注销', async () => {
    const h = await startServer(baseDeps)
    assert.equal(h.routes.size, 3)
    h.dispose()
    assert.equal(h.routes.size, 0, 'disposer 应注销全部路由')
    await h.close()
  })
})

// ---------------------------------------------------------------------------
//  T2 未绑定 → 409，零写入（body 都不读）
// ---------------------------------------------------------------------------

describe('T2 未绑定闸门', () => {
  test('合法 session 但未绑定 alias → 409 DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND，body 不读、写函数未调用', async () => {
    writeCalls.length = 0
    // 故意不给 body / content-type：若先读 body 会变成 415/400，而不是 409。
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_UNBOUND,
      method: 'POST',
    })
    assertError(result, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
    assert.deepEqual(writeCalls, [], '未绑定必须零写入（写钩子未调用）')
  })
})

// ---------------------------------------------------------------------------
//  T3 越界数值 → 400 且零写入
// ---------------------------------------------------------------------------

describe('T3 越界数值', () => {
  const validBody = (value: unknown) => ({
    key: 'sla_thresholds',
    value,
    confirmation_text: '确认修改',
  })

  test(`screening_hours=-1 → 400 ${SLA_HOURS_MIN}..${SLA_HOURS_MAX} 越界且零写入`, async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: validBody({ screening_hours: -1, scorecard_hours: 24 }),
    })
    assertError(result, 400, 'INVALID_ARGS', 'SCREENING_HOURS_OUT_OF_RANGE')
    assert.deepEqual(writeCalls, [])
  })

  test('scorecard_hours=999999 → 400 OUT_OF_RANGE 且零写入', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: validBody({ screening_hours: 4, scorecard_hours: 999999 }),
    })
    assertError(result, 400, 'INVALID_ARGS', 'SCORECARD_HOURS_OUT_OF_RANGE')
    assert.deepEqual(writeCalls, [])
  })

  test("agent_silent_delegation='true' → 400 NOT_BOOLEAN 且零写入", async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: { key: 'agent_silent_delegation', value: 'true', confirmation_text: '确认修改' },
    })
    assertError(result, 400, 'INVALID_ARGS', 'SILENT_DELEGATION_NOT_BOOLEAN')
    assert.deepEqual(writeCalls, [])
  })
})

// ---------------------------------------------------------------------------
//  T4 身份覆盖键 → 400 ACTOR_OVERRIDE_REJECTED 零写入
// ---------------------------------------------------------------------------

describe('T4 身份覆盖键', () => {
  test('body 带 actor_id / updated_by_actor_id / confirmation_text_sha256 → 400，零写入', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: {
        key: 'agent_silent_delegation',
        value: false,
        confirmation_text: '确认修改',
        actor_id: '11111111-1111-4111-8111-000000000103',
        updated_by_actor_id: 'x',
        confirmation_text_sha256: 'deadbeef',
      },
    })
    assertError(result, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
    assert.deepEqual(writeCalls, [])
  })
})

// ---------------------------------------------------------------------------
//  T5 confirmation_text 校验
// ---------------------------------------------------------------------------

describe('T5 确认原话', () => {
  const body = (confirmation_text: unknown) => ({ key: 'agent_silent_delegation', value: true, confirmation_text })

  test('缺失 → 400 CONFIRMATION_TEXT_NOT_STRING', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, { session: SESSION_RECRUITER, body: body(undefined) })
    assertError(result, 400, 'INVALID_ARGS', 'CONFIRMATION_TEXT_NOT_STRING')
    assert.deepEqual(writeCalls, [])
  })

  test('空串 → 400 CONFIRMATION_TEXT_LENGTH', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, { session: SESSION_RECRUITER, body: body('') })
    assertError(result, 400, 'INVALID_ARGS', 'CONFIRMATION_TEXT_LENGTH')
    assert.deepEqual(writeCalls, [])
  })

  test('超长（2001） → 400 CONFIRMATION_TEXT_LENGTH', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, { session: SESSION_RECRUITER, body: body('x'.repeat(2001)) })
    assertError(result, 400, 'INVALID_ARGS', 'CONFIRMATION_TEXT_LENGTH')
    assert.deepEqual(writeCalls, [])
  })
})

// ---------------------------------------------------------------------------
//  T6 sha256 服务端自算
// ---------------------------------------------------------------------------

describe('T6 确认哈希服务端自算', () => {
  test('合法写入在无库配置下到达 503（证明已过全部校验），beforeWrite 收到的 hash = sha256(原话)', async () => {
    writeCalls.length = 0
    const text = '  确认开启静默委派  '
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: { key: 'agent_silent_delegation', value: true, confirmation_text: text },
    })
    assertError(result, 503, 'NOT_CONFIGURED')
    assert.equal(writeCalls.length, 1, '所有闸门通过后应恰好到达一次写前观测点')
    const expected = createHash('sha256').update(text.trim(), 'utf8').digest('hex')
    assert.equal(writeCalls[0]?.confirmationTextSha256, expected, '哈希必须由服务端对确认原话计算')
    assert.equal(writeCalls[0]?.key, 'agent_silent_delegation')
    assert.equal(writeCalls[0]?.value, true)
  })

  test('body 里带 confirmation_text_sha256 一律拒收（不接受客户端哈希）', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: {
        key: 'agent_silent_delegation',
        value: false,
        confirmation_text: '确认修改',
        confirmation_text_sha256: 'a'.repeat(64),
      },
    })
    assertError(result, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED')
    assert.deepEqual(writeCalls, [])
  })
})

// ---------------------------------------------------------------------------
//  T7 GET 连接状态诚实 + 诚实缺省
// ---------------------------------------------------------------------------

describe('T7 GET 只读投影', () => {
  test('缺配置注入 → 三项 connection state 都不是 CONNECTED，defaults_applied 非空且为服务端默认', async () => {
    const result = await call(server, SETTINGS_PATHS.read, { session: SESSION_RECRUITER, method: 'GET' })
    assert.equal(result.status, 200, result.text)
    const connections = result.body.connections as Record<string, Record<string, unknown>>
    assert.ok(connections !== undefined)
    for (const name of ['email', 'feishu_calendar', 'feishu_minutes']) {
      const state = connections[name]?.state
      assert.ok(state === 'NOT_CONFIGURED' || state === 'AUTH_REQUIRED', `${name} 不得报 CONNECTED：${state}`)
    }
    const settings = result.body.settings as Record<string, unknown>
    assert.equal(settings.agent_silent_delegation, false)
    assert.deepEqual(settings.sla_thresholds, { screening_hours: 24, scorecard_hours: 48 })
    assert.equal(settings.auto_screening_enabled, true)
    assert.equal(settings.auto_scorecard_draft_enabled, true)
    assert.deepEqual(settings.scorecard_reminder_policy, {
      enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'workbench',
    })
    assert.deepEqual(settings.booking_invite_defaults, { expires_hours: 72, default_duration_min: 60 })
    assert.deepEqual(settings.external_webhook_config, {
      enabled: false, url: '', events: [], secret_set: false,
    })
    assert.deepEqual(result.body.defaults_applied, [
      'agent_silent_delegation', 'sla_thresholds', 'auto_screening_enabled',
      'auto_scorecard_draft_enabled', 'scorecard_reminder_policy', 'booking_invite_defaults',
      'external_webhook_config',
    ])
    const governance = result.body.governance as Record<string, unknown>
    assert.ok(Array.isArray(governance.skills))
    assert.deepEqual((governance.skills as { id: string }[]).map((s) => s.id).sort(), [
      'recruitment-s10-decision', 'recruitment-s6-intake', 'recruitment-s7-screening',
      'recruitment-s8-interview', 'recruitment-s9-transcript',
    ])
    assert.ok(!Object.hasOwn(governance, 'fabricated_summary'))
    // eval_summary 要么是本地真实文件对象，要么 null；绝不是编造的通过率。
    assert.ok(governance.eval_summary === null || typeof governance.eval_summary === 'object')
  })

  test('GET 未绑定 session → 409（零读取）', async () => {
    const result = await call(server, SETTINGS_PATHS.read, { session: SESSION_UNBOUND, method: 'GET' })
    assertError(result, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  })

  test('GET-only：POST 到只读路径 → 405 allow:GET', async () => {
    const result = await call(server, SETTINGS_PATHS.read, {
      session: SESSION_RECRUITER,
      body: {},
      method: 'POST',
    })
    assert.equal(result.status, 405)
    assert.equal(result.headers.get('allow'), 'GET')
  })
})

// ---------------------------------------------------------------------------
//  T8 白名单投影
// ---------------------------------------------------------------------------

describe('T8 不吐内部字段', () => {
  test('GET 响应 JSON 不含 payload_hash / created_by_actor_id / 内部 id 字段', async () => {
    const result = await call(server, SETTINGS_PATHS.read, { session: SESSION_RECRUITER, method: 'GET' })
    assert.equal(result.status, 200)
    assert.equal(result.text.includes('payload_hash'), false)
    assert.equal(result.text.includes('created_by_actor_id'), false)
    // governance.skills[].id 是契约里的 skill 标识（如 recruitment-s6-intake），不是内部行 id。
    const scoped = JSON.stringify({
      connections: result.body.connections,
      settings: result.body.settings,
    })
    assert.equal(/(payload_hash|created_by_actor_id|role_id|team_id|pipeline_template_id)/.test(scoped), false)
    for (const skill of (result.body.governance as { skills: Record<string, unknown>[] }).skills) {
      assert.match(String(skill.id), /^recruitment-s\d+-/)
    }
  })
})

// ---------------------------------------------------------------------------
//  T9 新增四键：合法值到达写前钩子 / 非法值 400 零写入
// ---------------------------------------------------------------------------

describe('T9 新增四键 HTTP 契约', () => {
  const cases: readonly { key: string; value: unknown }[] = [
    { key: 'auto_screening_enabled', value: false },
    { key: 'auto_scorecard_draft_enabled', value: true },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 48, max_reminders: 3, channel: 'feishu', quiet_hours: { start: '20:00', end: '09:00' } } },
    { key: 'booking_invite_defaults', value: { expires_hours: 24, default_duration_min: 45 } },
  ]
  const invalidCases: readonly { key: string; value: unknown; reason: string }[] = [
    { key: 'auto_screening_enabled', value: 'false', reason: 'AUTO_SCREENING_ENABLED_NOT_BOOLEAN' },
    { key: 'auto_scorecard_draft_enabled', value: 1, reason: 'AUTO_SCORECARD_DRAFT_ENABLED_NOT_BOOLEAN' },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 36, max_reminders: 2, channel: 'workbench' }, reason: 'REMINDER_OVERDUE_HOURS_INVALID' },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 24, max_reminders: 9, channel: 'workbench' }, reason: 'REMINDER_MAX_REMINDERS_OUT_OF_RANGE' },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'sms' }, reason: 'REMINDER_CHANNEL_INVALID' },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'email', quiet_hours: { start: '25:00', end: '09:00' } }, reason: 'QUIET_HOURS_START_INVALID' },
    { key: 'booking_invite_defaults', value: { expires_hours: 12, default_duration_min: 60 }, reason: 'BOOKING_EXPIRES_HOURS_OUT_OF_RANGE' },
    { key: 'booking_invite_defaults', value: { expires_hours: 72, default_duration_min: 50 }, reason: 'BOOKING_DURATION_INVALID' },
    { key: 'scorecard_reminder_policy', value: { enabled: true, overdue_hours: 24, max_reminders: 2, channel: 'email', extra: 1 }, reason: 'SCORECARD_REMINDER_POLICY_UNKNOWN_FIELD' },
  ]

  for (const { key, value } of cases) {
    test(`${key} 合法值过闸门（到达写前钩子，随后 503 只是无库）`, async () => {
      writeCalls.length = 0
      const result = await call(server, SETTINGS_PATHS.write, {
        session: SESSION_RECRUITER,
        body: { key, value, confirmation_text: '确认修改' },
      })
      assertError(result, 503, 'NOT_CONFIGURED')
      assert.equal(writeCalls.length, 1)
      assert.equal(writeCalls[0]?.key, key)
      assert.deepEqual(writeCalls[0]?.value, value)
    })
  }

  for (const { key, value, reason } of invalidCases) {
    test(`${key} 非法值 → 400 ${reason} 且零写入`, async () => {
      writeCalls.length = 0
      const result = await call(server, SETTINGS_PATHS.write, {
        session: SESSION_RECRUITER,
        body: { key, value, confirmation_text: '确认修改' },
      })
      assertError(result, 400, 'INVALID_ARGS', reason)
      assert.deepEqual(writeCalls, [])
    })
  }

  test('未知键 → 400 SETTING_KEY_UNKNOWN 且零写入', async () => {
    writeCalls.length = 0
    const result = await call(server, SETTINGS_PATHS.write, {
      session: SESSION_RECRUITER,
      body: { key: 'not_a_setting', value: true, confirmation_text: '确认修改' },
    })
    assertError(result, 400, 'INVALID_ARGS', 'SETTING_KEY_UNKNOWN')
    assert.deepEqual(writeCalls, [])
  })
})

// ---------------------------------------------------------------------------
//  T10 GET /recruitment/api/config/org —— 同闸门、未绑定零读
// ---------------------------------------------------------------------------

describe('T10 组织配置只读路由', () => {
  test('未绑定 session → 409（requireDatabase/readAll 未触发，零 DB 读）', async () => {
    const result = await call(server, SETTINGS_PATHS.configOrg, { session: SESSION_UNBOUND, method: 'GET' })
    assertError(result, 409, 'DEMO_ACTOR_UNMAPPED', 'SESSION_NOT_BOUND')
  })

  test('缺 session → 400 SESSION_REQUIRED', async () => {
    const result = await call(server, SETTINGS_PATHS.configOrg, { method: 'GET' })
    assertError(result, 400, 'INVALID_ARGS', 'SESSION_REQUIRED')
  })

  test('无库配置 → 503 NOT_CONFIGURED（绑定通过才碰库）', async () => {
    const result = await call(server, SETTINGS_PATHS.configOrg, { session: SESSION_RECRUITER, method: 'GET' })
    assertError(result, 503, 'NOT_CONFIGURED')
  })

  test('POST 到 org 只读路径 → 405 allow:GET', async () => {
    const result = await call(server, SETTINGS_PATHS.configOrg, {
      session: SESSION_RECRUITER, body: {}, method: 'POST',
    })
    assert.equal(result.status, 405)
    assert.equal(result.headers.get('allow'), 'GET')
  })

  test('非同源请求 → 403 FORBIDDEN', async () => {
    const response = await fetch(`${server.baseUrl}${SETTINGS_PATHS.configOrg}`, {
      method: 'GET', headers: { 'x-dsh-session': SESSION_RECRUITER },
    })
    assert.equal(response.status, 403)
  })
})
