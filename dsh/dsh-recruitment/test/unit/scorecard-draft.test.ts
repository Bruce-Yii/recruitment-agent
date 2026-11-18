// A4 面评草稿 · 无真库单元测试。
//
// 覆盖：payload 形状/32KB 上限、版本递增、路由契约常量、注册器 fail-closed
// （非回环零注册 / 同源失败 403 / 未绑定 409 / 身份覆盖 400 / 超限 413 / 未知键 400）。
// 所有被断言的闸门都在碰 DB 之前，因此不需要 PG；真库证据见集成测试与真库一次性库脚本。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  MAX_DRAFT_PAYLOAD_BYTES,
  nextDraftVersion,
  validateDraftPayload,
} from '../../src/db/scorecard-draft.ts'
import {
  SCORECARD_DRAFT_CONTRACT,
  registerScorecardDraftHttp,
  type ScorecardDraftHttpDeps,
} from '../../src/http/scorecard-draft.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'

// ---------------------------------------------------------------------
//  纯函数：payload 校验 / 版本递增
// ---------------------------------------------------------------------

describe('A4 draft payload 校验（纯函数）', () => {
  test('合法 payload：assessments + note 都被规范化保留', () => {
    const out = validateDraftPayload({ assessments: { BACKEND: 4 }, note: '思路清晰' })
    assert.deepEqual(out, { assessments: { BACKEND: 4 }, note: '思路清晰' })
  })

  test('合法 payload：只有 assessments 或只有 note 也可以（草稿是半成品）', () => {
    assert.deepEqual(validateDraftPayload({ assessments: {} }), { assessments: {} })
    assert.deepEqual(validateDraftPayload({ note: '' }), { note: '' })
    assert.deepEqual(validateDraftPayload({}), {})
  })

  test('payload 非对象 / assessments 非对象 / note 非字符串 → reason_code 对应且零写入语义', () => {
    for (const [input, reason] of [
      [[], 'DRAFT_PAYLOAD_TYPE'],
      [null, 'DRAFT_PAYLOAD_TYPE'],
      [{ assessments: [] }, 'DRAFT_ASSESSMENTS_TYPE'],
      [{ note: 42 }, 'DRAFT_NOTE_TYPE'],
    ] as const) {
      assert.throws(() => validateDraftPayload(input), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes(reason)
      }, `输入 ${JSON.stringify(input)} 应报 ${reason}`)
    }
  })

  test('未知顶层键（含 confirmation_text）一律拒：草稿不是决定', () => {
    assert.throws(() => validateDraftPayload({ note: 'x', confirmation_text: '我确认' }), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('DRAFT_PAYLOAD_UNKNOWN_KEY') && message.includes('confirmation_text')
    })
  })

  test('payload 超 32KB → DRAFT_PAYLOAD_TOO_LARGE（按 UTF-8 字节数）', () => {
    const huge = { note: '字'.repeat(11_000) } // 11000 × 3 字节 > 32768
    assert.throws(() => validateDraftPayload(huge), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('DRAFT_PAYLOAD_TOO_LARGE')
    })
    // 边界内（刚好不超过）应通过。
    const ok = { note: 'x'.repeat(MAX_DRAFT_PAYLOAD_BYTES - 20) }
    assert.ok(Buffer.byteLength(JSON.stringify(validateDraftPayload(ok)), 'utf8') <= MAX_DRAFT_PAYLOAD_BYTES)
  })
})

describe('版本递增（纯函数）', () => {
  test('无草稿 → 1；连续保存 → 2, 3, 4', () => {
    assert.equal(nextDraftVersion(null), 1)
    assert.equal(nextDraftVersion(undefined), 1)
    assert.equal(nextDraftVersion(0), 1)
    assert.equal(nextDraftVersion(1), 2)
    assert.equal(nextDraftVersion(2), 3)
    assert.equal(nextDraftVersion(3), 4)
  })

  test('脏值（负数/小数/NaN）按无草稿处理 → 1', () => {
    for (const bad of [-1, 1.5, Number.NaN]) assert.equal(nextDraftVersion(bad), 1)
  })
})

// ---------------------------------------------------------------------
//  路由契约常量（单一事实，测试与实现同源）
// ---------------------------------------------------------------------

describe('路由契约常量', () => {
  test('path / methods / query / body / 32KB 冻结', () => {
    assert.equal(SCORECARD_DRAFT_CONTRACT.path, '/recruitment/api/action/scorecard/draft')
    assert.deepEqual([...SCORECARD_DRAFT_CONTRACT.methods], ['GET', 'POST'])
    assert.deepEqual([...SCORECARD_DRAFT_CONTRACT.queryKeys], ['interview_id'])
    assert.deepEqual([...SCORECARD_DRAFT_CONTRACT.bodyKeys], ['interview_id', 'payload'])
    assert.equal(SCORECARD_DRAFT_CONTRACT.maxPayloadBytes, 32 * 1024)
    assert.equal(SCORECARD_DRAFT_CONTRACT.statusByCode.SCORECARD_ALREADY_SUBMITTED, 409)
    assert.equal(SCORECARD_DRAFT_CONTRACT.statusByCode.DRAFT_PAYLOAD_TOO_LARGE, 413)
    assert.equal(SCORECARD_DRAFT_CONTRACT.statusByCode.DEMO_ACTOR_UNMAPPED, 409)
    assert.equal(SCORECARD_DRAFT_CONTRACT.statusByCode.INTERVIEWER_MISMATCH, 403)
  })
})

// ---------------------------------------------------------------------
//  真 HTTP + 假 webServer（闸门在 DB 之前，不需要 PG）
// ---------------------------------------------------------------------

interface Harness {
  readonly baseUrl: string
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  readonly dispose: () => void
  close(): Promise<void>
}

async function startServer(
  deps: ScorecardDraftHttpDeps,
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
  const dispose = registerScorecardDraftHttp(
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
    dispose,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

const INTERVIEW_ID = 'aaaaaaaa-0000-4000-8000-000000000091'

async function call(
  h: Harness,
  opts: {
    readonly method?: string
    readonly session?: string
    readonly body?: unknown
    readonly query?: string
    readonly sameOriginHeader?: boolean
    readonly extraHeaders?: Record<string, string>
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
  const query = opts.query ?? `?interview_id=${INTERVIEW_ID}`
  const response = await fetch(`${h.baseUrl}${SCORECARD_DRAFT_CONTRACT.path}${query}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers,
    body: payload,
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

describe('registerScorecardDraftHttp（真 HTTP / 假 webServer）', () => {
  let identity: DemoActorIdentity
  let deps: ScorecardDraftHttpDeps

  before(() => {
    identity = createDemoActorIdentity().identity
    deps = { database: null, databaseIssues: ['RECRUITMENT_DB_PASSWORD is not set'], identity }
  })

  test('非回环 host 不注册路由（fail-closed）且给出 warn', async () => {
    const h = await startServer(deps, '0.0.0.0')
    assert.deepEqual(h.registered, [])
    assert.equal(h.warnings.length, 1)
    assert.match(h.warnings[0], /不是回环地址/)
    const result = await call(h)
    assert.equal(result.status, 404)
    h.dispose()
    await h.close()
  })

  test('回环 host 注册一条 exact 路由', async () => {
    const h = await startServer(deps, '127.0.0.1')
    assert.deepEqual(h.registered, [{ kind: 'exact', path: SCORECARD_DRAFT_CONTRACT.path }])
    h.dispose()
    await h.close()
  })

  test('缺同源头 → 403 SAME_ORIGIN_REQUIRED（不碰 DB）', async () => {
    const h = await startServer(deps)
    const result = await call(h, { sameOriginHeader: false, session: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    assertError(result, 403, 'SAME_ORIGIN_REQUIRED')
    h.dispose()
    await h.close()
  })

  test('未绑定 session → 409 DEMO_ACTOR_UNMAPPED（零写入）', async () => {
    const h = await startServer(deps)
    const result = await call(h, { session: 'session-ffffffff-ffff-4fff-8fff-ffffffffffff' })
    assertError(result, 409, 'SESSION_NOT_BOUND')
    h.dispose()
    await h.close()
  })

  test('缺 session → 400 SESSION_REQUIRED（零写入）', async () => {
    const h = await startServer(deps)
    const result = await call(h)
    assertError(result, 400, 'SESSION_REQUIRED')
    h.dispose()
    await h.close()
  })

  test('query 覆盖 actor_id → 400 ACTOR_OVERRIDE_REJECTED（碰 DB 之前）', async () => {
    const h = await startServer(deps)
    const result = await call(h, {
      session: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      query: `?interview_id=${INTERVIEW_ID}&actor_id=whatever`,
    })
    assertError(result, 400, 'ACTOR_OVERRIDE_REJECTED')
    h.dispose()
    await h.close()
  })

  test('POST 未知键 confirmation_text → 400 UNKNOWN_PARAM（草稿不是决定）', async () => {
    const h = await startServer(deps)
    const result = await call(h, {
      session: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      body: { interview_id: INTERVIEW_ID, payload: { note: 'x' }, confirmation_text: '确认' },
    })
    assertError(result, 400, 'UNKNOWN_PARAM')
    h.dispose()
    await h.close()
  })

  test('POST payload 超 32KB → 413 DRAFT_PAYLOAD_TOO_LARGE（零写入）', async () => {
    const h = await startServer(deps)
    const result = await call(h, {
      session: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      body: { interview_id: INTERVIEW_ID, payload: { note: '字'.repeat(11_000) } },
    })
    assert.equal(result.status, 413, result.text)
    h.dispose()
    await h.close()
  })

  test('非法方法 → 405 + allow: GET, POST', async () => {
    const h = await startServer(deps)
    const result = await call(h, { method: 'DELETE', session: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    assert.equal(result.status, 405)
    h.dispose()
    await h.close()
  })

  test('未知路径 → 404', async () => {
    const h = await startServer(deps)
    const response = await fetch(`${h.baseUrl}/recruitment/api/action/scorecard/draft/other`, {
      headers: { 'x-recruitment-request': '1' },
    })
    assert.equal(response.status, 404)
    h.dispose()
    await h.close()
  })

  after(async () => {
    // 无资源要清理（每个用例自己 dispose/close）。
  })
})
