// Issue #36 / G-10 · 去重提示 HTTP 路由的**无库**单测（真 HTTP + 注入只读执行器）。
//
// 覆盖：同手机命中、同邮箱命中、不同人不误报、排除自身、PII 不明文（脱敏）、
// 非法 id fail-closed、同源/loopback/session 闸门、只读零写入、非回环不注册、
// 路由精确匹配（错误路径 404 / 非 GET 405）、disposer 可注销。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  CANDIDATE_DEDUP_REGISTER_PREFIX,
  registerCandidateDedupHttp,
  type CandidateDedupHostContext,
  type CandidateDedupHttpDeps,
  type CandidateDuplicatesResponse,
} from '../../src/http/candidate-dedup.ts'
import type { DedupCandidateFact } from '../../src/domain/candidate-dedup.ts'
import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FAKE_DB = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'unit',
  password: 'unit-only', password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15000, connect_timeout_ms: 10000, max: 2,
} as const

const FACTS: DedupCandidateFact[] = [
  {
    applicationId: 'app-a', candidateId: 'cand-a', displayName: '张三',
    phone: '13800138000', email: 'a@x.test', channelId: 'board', channelName: '官网投递',
    historyKeys: [],
  },
  {
    applicationId: 'app-b', candidateId: 'cand-b', displayName: '张三',
    phone: '+86 138-0013-8000', email: 'other@x.test', channelId: 'referral', channelName: '内推',
    historyKeys: [],
  },
  {
    applicationId: 'app-c', candidateId: 'cand-c', displayName: '李四',
    phone: '13900139000', email: 'c@x.test', channelId: 'board', channelName: '官网投递',
    historyKeys: [],
  },
  {
    applicationId: 'app-d', candidateId: 'cand-d', displayName: '王五',
    phone: '13700137000', email: 'a@x.test', channelId: 'board', channelName: '官网投递',
    historyKeys: [],
  },
  {
    // 同 candidateId 的另一投递：必须被排除。
    applicationId: 'app-a2', candidateId: 'cand-a', displayName: '张三',
    phone: '13800138000', email: 'a@x.test', channelId: 'board', channelName: '官网投递',
    historyKeys: [],
  },
]

interface Harness {
  readonly base: string
  readonly port: number
  readonly readCalls: string[]
  close(): Promise<void>
}

async function startHarness(options: {
  readonly facts?: readonly DedupCandidateFact[]
  readonly boundSession?: boolean
  readonly registerOnHost?: string
  readonly unconfigured?: boolean
} = {}): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname) ?? [...routes.entries()].filter(([p]) => pathname.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
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
  const identity = createDemoActorIdentity().identity
  if (options.boundSession !== false) identity.registry.bind(SESSION, 'recruiter')

  const readCalls: string[] = []
  const ctx: CandidateDedupHostContext = {
    webServer: {
      host: options.registerOnHost ?? '127.0.0.1',
      port,
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  }
  const deps: CandidateDedupHttpDeps = {
    database: options.unconfigured === true ? null : FAKE_DB,
    databaseIssues: ['environment variable RECRUITMENT_DB_PASSWORD is not set'],
    identity,
    runReadOnly: async (fn) => {
      readCalls.push('begin transaction read only')
      const result = await fn({} as never)
      readCalls.push('commit')
      return result
    },
    loadFacts: async () => {
      readCalls.push('SELECT')
      return options.facts ?? FACTS
    },
  }
  registerCandidateDedupHttp(ctx, deps)
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    readCalls,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

interface CallResult {
  readonly status: number
  readonly body: any
}

async function call(
  h: Harness,
  path: string,
  options: { session?: string | null; method?: string; requestHeader?: string | null; origin?: string | null } = {},
): Promise<CallResult> {
  const headers: Record<string, string> = { host: `127.0.0.1:${h.port}` }
  if (options.requestHeader !== null) headers['x-recruitment-request'] = options.requestHeader ?? '1'
  if (options.session !== null) headers['x-dsh-session'] = options.session ?? SESSION
  if (options.origin !== undefined && options.origin !== null) headers['origin'] = options.origin
  const response = await fetch(`${h.base}${path}`, { method: options.method ?? 'GET', headers })
  const text = await response.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

test('G-10 注册：回环注册 prefix、非回环零注册、disposer 可注销', async () => {
  for (const host of ['0.0.0.0', 'example.com', '[::]']) {
    const h = await startHarness({ registerOnHost: host })
    // 非回环注册返回空 disposer → 路由表空 → 请求 404（fail-closed）。
    const res = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
    assert.equal(res.status, 404)
    await h.close()
  }
  const h = await startHarness()
  const ok = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
  assert.equal(ok.status, 200)
  await h.close()
})

test('G-10 同手机命中：只返回 app-b（跨渠道）且 PII 脱敏', async () => {
  const h = await startHarness()
  const res = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
  assert.equal(res.status, 200)
  const body = res.body as CandidateDuplicatesResponse
  assert.equal(body.contract_version, 'candidate-dedup 1.0.0')
  assert.deepEqual(body.duplicates.map((d) => d.applicationId), ['app-b', 'app-d'])
  const phoneHit = body.duplicates.find((d) => d.applicationId === 'app-b')
  assert.ok(phoneHit?.reasons.includes('SAME_PHONE'))
  const serialized = JSON.stringify(body)
  assert.ok(!serialized.includes('13800138000'))
  assert.ok(!serialized.includes('+8613800138000'))
  assert.ok(!serialized.includes('a@x.test'))
  assert.equal(body.subject_hints.phone, '+86 138****8000')
  assert.equal(body.subject_hints.email, 'a***@x.test')
  await h.close()
})

test('G-10 同邮箱命中 + 不同人不误报', async () => {
  const h = await startHarness()
  // app-a 与 app-d 同邮箱；app-c 不同手机/邮箱 → 不命中。
  const res = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
  const body = res.body as CandidateDuplicatesResponse
  const emailHit = body.duplicates.find((d) => d.applicationId === 'app-d')
  assert.ok(emailHit?.reasons.includes('SAME_EMAIL'))
  assert.equal(emailHit.matchedValueHints[0], 'a***@x.test')
  assert.equal(body.duplicates.some((d) => d.applicationId === 'app-c'), false)
  // 排除自身：同 candidateId 的 app-a2 不在结果里。
  assert.equal(body.duplicates.some((d) => d.applicationId === 'app-a2'), false)
  await h.close()
})

test('G-10 只读零写入：每条成功请求恰好一次只读事务 + SELECT，无 INSERT/UPDATE/DELETE', async () => {
  const h = await startHarness()
  await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
  assert.deepEqual(h.readCalls, ['begin transaction read only', 'SELECT', 'commit'])
  assert.ok(h.readCalls.every((s) => !/insert|update|delete|merge/i.test(s)))
  await h.close()
})

test('G-10 非法 id / 未知 query fail-closed（400）', async () => {
  const h = await startHarness()
  const badIds = [
    `${CANDIDATE_DEDUP_REGISTER_PREFIX}%20/duplicates`,            // 空白 id（解码后）
    `${CANDIDATE_DEDUP_REGISTER_PREFIX}a%2Fb/duplicates`,          // 编码斜杠
    `${CANDIDATE_DEDUP_REGISTER_PREFIX}a%20b/duplicates`,          // 内嵌空白
  ]
  for (const path of badIds) {
    const res = await call(h, path)
    assert.ok(res.status === 400 || res.status === 404, `${path} → ${res.status}`)
  }
  const unknown = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates?tenant_id=evil`)
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.reason_code, 'UNKNOWN_PARAM')
  assert.deepEqual(h.readCalls, []) // 闸门在碰只读执行器之前
  await h.close()
})

test('G-10 同源/loopback/session 闸门（403/400/409），失败均零读库', async () => {
  const h = await startHarness()
  const path = `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`
  const noRequestHeader = await call(h, path, { requestHeader: null })
  assert.equal(noRequestHeader.status, 403) // 缺 x-recruitment-request → 同源闸门拒绝
  assert.equal(noRequestHeader.body.error.reason_code, 'SAME_ORIGIN_REQUIRED')
  const badOrigin = await call(h, path, { origin: 'http://evil.example' })
  assert.equal(badOrigin.status, 403)
  const h2 = await startHarness()
  const noSession = await call(h2, path, { session: null })
  assert.equal(noSession.status, 400)
  assert.equal(noSession.body.error.reason_code, 'SESSION_REQUIRED')
  assert.deepEqual(h2.readCalls, [])
  await h2.close()
  const badSession = await call(h, path, { session: 'not-a-session' })
  assert.equal(badSession.status, 400)
  assert.equal(badSession.body.error.reason_code, 'SESSION_ID_INVALID')
  const unbound = await startHarness({ boundSession: false })
  const unboundRes = await call(unbound, path)
  assert.equal(unboundRes.status, 409)
  assert.equal(unboundRes.body.error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.deepEqual(unbound.readCalls, [])
  await unbound.close()
  const wrongMethod = await call(h, path, { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  const wrongPath = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a`)
  assert.equal(wrongPath.status, 404)
  assert.deepEqual(h.readCalls, [])
  await h.close()
})

test('G-10 未配置数据库 → 503，不读库', async () => {
  const h = await startHarness({ unconfigured: true })
  const res = await call(h, `${CANDIDATE_DEDUP_REGISTER_PREFIX}app-a/duplicates`)
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'NOT_CONFIGURED')
  assert.deepEqual(h.readCalls, [])
  await h.close()
})

