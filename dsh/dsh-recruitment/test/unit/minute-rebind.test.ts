// 妙记录音归属改绑 · 无真库单元测试。
//
// 覆盖：CLI argv 构造（profile 固定 recruitment / --dry-run / 无 --yes / 无授权拒绝真写 /
// argv 脱敏）、假 runner 的成功/失败/超时/启动失败路径（失败绝不报成功）、
// HTTP 闸门 fail-closed（非回环 / 同源 / session / 覆盖键 / 未知键 / dry_run=false /
// 平台身份映射缺失 —— 全部在碰 DB / 外部写之前）。
// 真库（幂等/审计/禁删）见 test/integration/minute-rebind.test.ts。
import test, { before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  buildRebindArgs,
  redactedCommandSummary,
  rebindMinuteSpeaker,
  REBIND_CLI_PROFILE,
  type RebindCliRunner,
  type RebindRunResult,
} from '../../src/connectors/feishu/rebind.ts'
import {
  MINUTE_REBIND_CONTRACT,
  registerMinuteRebindHttp,
  type MinuteRebindHttpDeps,
  type RebindActorIdentity,
} from '../../src/http/minute-rebind.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INTERVIEW = 'aaaaaaaa-0000-4000-8000-000000000091'
const FROM = '11111111-1111-4111-8111-000000000104'
const TO = '11111111-1111-4111-8111-000000000105'
const MINUTE = 'obcnSyntheticToken0001'
const IDENTITIES: Record<string, RebindActorIdentity> = {
  [FROM]: { from_speaker_id: 'sp_synthetic_old_001', to_user_id: 'ou_synthetic_from_001' },
  [TO]: { from_speaker_id: 'sp_synthetic_new_001', to_user_id: 'ou_synthetic_new_001' },
}

function okResult(overrides: Partial<RebindRunResult> = {}): RebindRunResult {
  return { status: 'OK', exit_code: 0, signal: null, stdout: '{"ok":true}', stderr: '', ...overrides }
}

// ---------------------------------------------------------------------
//  CLI argv 构造（纯函数）
// ---------------------------------------------------------------------

describe('CLI argv 构造', () => {
  const input = {
    minute_token: MINUTE,
    from_speaker_id: 'sp_synthetic_old_001',
    to_user_id: 'ou_synthetic_new_001',
    dry_run: true,
  } as const

  test('profile 固定 recruitment，写在子命令前；带 --dry-run；无 --yes', () => {
    const args = buildRebindArgs(input)
    assert.deepEqual(args.slice(0, 2), ['--profile', REBIND_CLI_PROFILE])
    assert.equal(REBIND_CLI_PROFILE, 'recruitment')
    assert.ok(args.includes('minutes'))
    assert.ok(args.includes('+speaker-replace'))
    assert.ok(args.includes('--dry-run'))
    assert.ok(!args.includes('--yes'), '本机 1.0.81 的 +speaker-replace 是 Risk: write，--yes 会被拒')
    assert.ok(args.includes('--as'))
    assert.ok(args.includes('--minute-token'))
    assert.ok(args.includes('--from-speaker-id'))
    assert.ok(args.includes('--to-user-id'))
  })

  test('dry_run=false 且没有 allow_real_write → 拒绝构造可写命令', () => {
    assert.throws(
      () => buildRebindArgs({ ...input, dry_run: false }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'REAL_WRITE_NOT_ALLOWED',
    )
    // 显式给 allow_real_write=true 才会构造无 --dry-run 的命令（HTTP 层永不传）。
    const writable = buildRebindArgs({ ...input, dry_run: false, allow_real_write: true })
    assert.ok(!writable.includes('--dry-run'))
  })

  test('拒绝默认档案与非法 open_id / 控制字符 / @', () => {
    assert.throws(() => buildRebindArgs(input, 'cli_aae49f8438f8dce4'), /默认档案/)
    assert.throws(() => buildRebindArgs({ ...input, to_user_id: 'not_ou_' }), /ou_/)
    assert.throws(() => buildRebindArgs({ ...input, minute_token: 'obcn@x' }), /控制字符或 @/)
  })

  test('脱敏摘要不回显任何平台标识', () => {
    const summary = redactedCommandSummary(buildRebindArgs(input))
    assert.ok(!summary.includes(MINUTE))
    assert.ok(!summary.includes('sp_synthetic_old_001'))
    assert.ok(!summary.includes('ou_synthetic_new_001'))
    assert.ok(!summary.includes(REBIND_CLI_PROFILE))
    assert.ok(summary.includes('--minute-token <redacted>'))
    assert.ok(summary.includes('--dry-run'))
  })
})

// ---------------------------------------------------------------------
//  假 runner：成功 / 失败（绝不报成功）
// ---------------------------------------------------------------------

describe('CLI 调用结局（假 spawn 注入）', () => {
  const cfg = { runner: (async () => okResult()) as RebindCliRunner }
  const input = {
    minute_token: MINUTE,
    from_speaker_id: 'sp_synthetic_old_001',
    to_user_id: 'ou_synthetic_new_001',
    dry_run: true,
  } as const

  test('dry-run OK → DRY_RUN，external_write=false', async () => {
    const out = await rebindMinuteSpeaker(cfg, input)
    assert.equal(out.status, 'DRY_RUN')
    if (out.status === 'DRY_RUN') {
      assert.equal(out.summary.external_write, false)
      assert.equal(out.summary.dry_run, true)
      assert.equal(out.summary.exit_code, 0)
      assert.equal(out.summary.stderr_head, '')
    }
  })

  test('非零退出 → FAILED/REBIND_FAILED + 脱敏 stderr，绝不报成功', async () => {
    const runner: RebindCliRunner = async () => okResult({
      status: 'NON_ZERO_EXIT', exit_code: 3,
      stderr: '{"msg":"张三的面试转写内容不能外泄"} error while replacing speaker',
    })
    const out = await rebindMinuteSpeaker({ runner }, input)
    assert.equal(out.status, 'FAILED')
    if (out.status === 'FAILED') {
      assert.equal(out.error.code, 'REBIND_FAILED')
      assert.match(out.error.message, /exit=3/)
      assert.ok(!out.error.message.includes('张三'), '中文正文必须被脱敏')
      assert.equal(out.summary.external_write, false)
      assert.equal(out.summary.exit_code, 3)
      assert.ok(out.summary.stderr_bytes_seen > 0)
    }
  })

  test('超时 / 启动失败 / 被信号终止都如实 FAILED，绝不报成功', async () => {
    for (const result of [
      okResult({ status: 'TIMEOUT', exit_code: null, stderr: '' }),
      okResult({ status: 'SPAWN_FAILED', exit_code: null, spawn_error_code: 'ENOENT' }),
      okResult({ status: 'SIGNALED', exit_code: null, signal: 'SIGKILL' }),
    ]) {
      const out = await rebindMinuteSpeaker({ runner: (async () => result) as RebindCliRunner }, input)
      assert.equal(out.status, 'FAILED')
      if (out.status === 'FAILED') assert.equal(out.error.code, 'REBIND_FAILED')
    }
  })

  test('真实写 OK 也带 external_write=true，但 HTTP 层永不传 allow_real_write', async () => {
    const out = await rebindMinuteSpeaker({ runner: (async () => okResult()) as RebindCliRunner }, {
      ...input, dry_run: false, allow_real_write: true,
    })
    assert.equal(out.status, 'OK')
    if (out.status === 'OK') assert.equal(out.summary.external_write, true)
  })
})

// ---------------------------------------------------------------------
//  HTTP 闸门（真 HTTP + 假 webServer；碰 DB 之前即拒）
// ---------------------------------------------------------------------

interface Harness {
  readonly baseUrl: string
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  readonly dispose: () => void
  close(): Promise<void>
}

async function startServer(
  deps: MinuteRebindHttpDeps,
  host: '127.0.0.1' | '0.0.0.0' = '127.0.0.1',
): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const dispose = registerMinuteRebindHttp(
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
    registered, warnings, dispose,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

const VALID_BODY = {
  interview_id: INTERVIEW,
  from_actor_id: FROM,
  to_actor_id: TO,
  minute_token: MINUTE,
  confirmation_text: '我确认把这个面试官的录音归属改给新面试官',
}

async function call(
  h: Harness,
  opts: {
    readonly session?: string
    readonly body?: unknown
    readonly sameOriginHeader?: boolean
    readonly extraHeaders?: Record<string, string>
    readonly query?: string
  } = {},
) {
  const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) }
  if (opts.sameOriginHeader !== false) headers['x-recruitment-request'] = '1'
  if (opts.session !== undefined) headers['x-dsh-session'] = opts.session
  let payload: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(opts.body)
  }
  const response = await fetch(`${h.baseUrl}${MINUTE_REBIND_CONTRACT.path}${opts.query ?? ''}`, {
    method: 'POST', headers, body: payload,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

function assertError(result: { status: number; body: Record<string, unknown>; text: string }, status: number, reason: string) {
  assert.equal(result.status, status, `状态应为 ${status}: ${result.text}`)
  const error = result.body.error as Record<string, unknown> | undefined
  assert.ok(error !== undefined, `应为错误信封: ${result.text}`)
  assert.equal(error.reason_code, reason, `reason_code 应为 ${reason}: ${result.text}`)
}

describe('registerMinuteRebindHttp（真 HTTP / 假 webServer；闸门在 DB 之前）', () => {
  let identity: DemoActorIdentity
  let deps: MinuteRebindHttpDeps

  before(() => {
    identity = createDemoActorIdentity().identity
    deps = {
      database: null,
      databaseIssues: ['RECRUITMENT_DB_PASSWORD is not set'],
      identity,
      connector: { runner: (async () => okResult()) as RebindCliRunner },
      identities: IDENTITIES,
    }
  })

  test('非回环 host 不注册路由（fail-closed）且给出 warn', async () => {
    const h = await startServer(deps, '0.0.0.0')
    assert.deepEqual(h.registered, [])
    assert.match(h.warnings[0] ?? '', /不是回环地址/)
    assert.equal((await call(h)).status, 404)
    h.dispose(); await h.close()
  })

  test('回环 host 注册一条 exact 路由', async () => {
    const h = await startServer(deps)
    assert.deepEqual(h.registered, [{ kind: 'exact', path: MINUTE_REBIND_CONTRACT.path }])
    h.dispose(); await h.close()
  })

  test('缺同源头 → 403 SAME_ORIGIN_REQUIRED', async () => {
    const h = await startServer(deps)
    assertError(await call(h, { sameOriginHeader: false, session: SESSION, body: VALID_BODY }), 403, 'SAME_ORIGIN_REQUIRED')
    h.dispose(); await h.close()
  })

  test('缺 session → 400 SESSION_REQUIRED；未绑定 → 409 DEMO_ACTOR_UNMAPPED', async () => {
    const h = await startServer(deps)
    assertError(await call(h, { body: VALID_BODY }), 400, 'SESSION_REQUIRED')
    assertError(await call(h, { session: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff', body: VALID_BODY }), 409, 'SESSION_NOT_BOUND')
    h.dispose(); await h.close()
  })

  test('body 覆盖键（confirmation_text_sha256 / allow_real_write / to_user_id）→ 400', async () => {
    const h = await startServer(deps)
    for (const key of ['confirmation_text_sha256', 'allow_real_write', 'to_user_id', 'actor_id']) {
      assertError(await call(h, { session: SESSION, body: { ...VALID_BODY, [key]: 'x' } }), 400, 'ACTOR_OVERRIDE_REJECTED')
    }
    h.dispose(); await h.close()
  })

  test('未知键 → 400 UNKNOWN_PARAM', async () => {
    const h = await startServer(deps)
    assertError(await call(h, { session: SESSION, body: { ...VALID_BODY, surprise: 1 } }), 400, 'UNKNOWN_PARAM')
    h.dispose(); await h.close()
  })

  test('dry_run=false → 400 REAL_WRITE_NOT_ALLOWED（真实改绑留人点验收）', async () => {
    const h = await startServer(deps)
    assertError(await call(h, { session: SESSION, body: { ...VALID_BODY, dry_run: false } }), 400, 'REAL_WRITE_NOT_ALLOWED')
    h.dispose(); await h.close()
  })

  test('平台身份映射缺失 → 422 REBIND_IDENTITY_UNMAPPED（零外部写）', async () => {
    const h = await startServer({ ...deps, identities: {} })
    assertError(await call(h, { session: SESSION, body: VALID_BODY }), 422, 'PLATFORM_IDENTITY_MISSING')
    h.dispose(); await h.close()
  })

  test('from=to → 400 SAME_ACTOR；minute_token 含 @ → 400 INVALID_TOKEN', async () => {
    const h = await startServer(deps)
    assertError(await call(h, { session: SESSION, body: { ...VALID_BODY, to_actor_id: FROM } }), 400, 'SAME_ACTOR')
    assertError(await call(h, { session: SESSION, body: { ...VALID_BODY, minute_token: 'obcn@bad' } }), 400, 'INVALID_TOKEN')
    h.dispose(); await h.close()
  })

  test('非法方法 → 405 + allow: POST', async () => {
    const h = await startServer(deps)
    const response = await fetch(`${h.baseUrl}${MINUTE_REBIND_CONTRACT.path}`, {
      method: 'DELETE', headers: { 'x-recruitment-request': '1', 'x-dsh-session': SESSION },
    })
    assert.equal(response.status, 405)
    assert.equal(response.headers.get('allow'), 'POST')
    h.dispose(); await h.close()
  })
})
