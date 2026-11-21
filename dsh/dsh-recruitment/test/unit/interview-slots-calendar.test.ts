// 日历只读连接器 + 空闲时段路由单测（注入假 runner，不连网、不连库）。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  buildCalendarArgs,
  CALENDAR_CLI_PROFILE,
  CalendarReadError,
  createFeishuCalendarReader,
  parseFreebusyEnvelope,
  type CalendarCliRunResult,
} from '../../src/connectors/feishu/calendar.ts'
import {
  INTERVIEW_FREE_SLOTS_PATH,
  registerInterviewSlotsHttp,
  type InterviewSlotsHostContext,
  type InterviewSlotsHttpDeps,
} from '../../src/http/interview-slots.ts'
import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'

const APP = '22222222-2222-4222-8222-000000000001'
const IV_A = '44444444-4444-4444-8444-000000000001'
const IV_B = '44444444-4444-4444-8444-000000000002'
const SESSION = 'session-33333333-3333-4333-8333-000000000001'
const PORT = 49347

function okResult(stdout: unknown): CalendarCliRunResult {
  return { status: 'OK', exit_code: 0, stdout: JSON.stringify(stdout), stderr: '' }
}

// ---------------------------------------------------------------------------
//  连接器
// ---------------------------------------------------------------------------

test('argv：--profile recruitment 恒在最前，user-id 只收 ou_ 前缀', () => {
  const args = buildCalendarArgs('+freebusy', {
    user_id: 'ou_abc123', start: '2026-11-20', end: '2026-11-25',
  })
  assert.deepEqual(args.slice(0, 6), ['--profile', 'recruitment', 'calendar', '+freebusy', '--as', 'user'])
  assert.deepEqual(args.slice(6), ['--user-id', 'ou_abc123', '--start', '2026-11-20', '--end', '2026-11-25', '--format', 'json'])
  assert.equal(CALENDAR_CLI_PROFILE, 'recruitment')
  assert.throws(
    () => buildCalendarArgs('+freebusy', { user_id: 'hr@example.com', start: '2026-11-20', end: '2026-11-25' }),
    /ou_ 前缀/,
  )
})

test('解析成功信封：只取忙区间，空 busy 也是「真的没有忙碌」', () => {
  const busy = parseFreebusyEnvelope(JSON.stringify({
    ok: true,
    data: { freebusys: [{ busy: [
      { start: '2026-11-20T10:00:00+08:00', end: '2026-11-20T11:00:00+08:00' },
    ] }] },
  }))
  assert.equal(busy.length, 1)
  assert.ok(busy[0]!.end_ms > busy[0]!.start_ms)
  assert.deepEqual(parseFreebusyEnvelope(JSON.stringify({ ok: true, data: { busy: [] } })), [])
})

test('解析失败信封：缺 data.busy → 失败，绝不返回空数组冒充空闲', () => {
  assert.throws(
    () => parseFreebusyEnvelope(JSON.stringify({ ok: true, data: { unexpected: [] } })),
    (e: unknown) => e instanceof CalendarReadError && e.code === 'ENVELOPE_UNRECOGNIZED',
  )
})

test('认证失败：missing_scope → AUTH_REQUIRED（不冒充空闲）', async () => {
  const reader = createFeishuCalendarReader({
    runner: async () => ({
      status: 'NON_ZERO_EXIT', exit_code: 3,
      stdout: JSON.stringify({ ok: false, identity: 'user', error: { type: 'authorization', subtype: 'missing_scope' } }),
      stderr: '',
    }),
    platform_channel: true,
  })
  const result = await reader.readFreebusy({ user_id: 'ou_a', start: '2026-11-20', end: '2026-11-21' })
  assert.equal(result.status, 'FAILED')
  if (result.status === 'FAILED') {
    assert.equal(result.error.code, 'AUTH_REQUIRED')
    assert.equal(result.error.auth?.subtype, 'missing_scope')
  }
})

test('非平台通道成功读取 → transport=FIXTURE（R4：不冒充 LIVE）', async () => {
  const reader = createFeishuCalendarReader({
    runner: async () => okResult({ ok: true, data: { busy: [] } }),
    platform_channel: false,
  })
  const result = await reader.readFreebusy({ user_id: 'ou_a', start: '2026-11-20', end: '2026-11-21' })
  assert.equal(result.status, 'READ')
  if (result.status === 'READ') assert.equal(result.readback.transport, 'FIXTURE')
})

// ---------------------------------------------------------------------------
//  路由（负例优先）
// ---------------------------------------------------------------------------

interface CapturedRoute {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

function makeCtx(): { ctx: InterviewSlotsHostContext; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = []
  const ctx: InterviewSlotsHostContext = {
    webServer: {
      host: '127.0.0.1', port: PORT,
      register(route) {
        routes.push(route as CapturedRoute)
        return () => {}
      },
    },
  }
  return { ctx, routes }
}

function makeDeps(overrides: Partial<InterviewSlotsHttpDeps> = {}): InterviewSlotsHttpDeps {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION, 'recruiter')
  return { feishuCliPath: 'D:\\fake\\lark-cli.exe', platformChannel: true, identity, ...overrides }
}

interface MockRes {
  status: number
  body: string
  writeHead(s: number): ServerResponse
  end(b?: string): ServerResponse
  headersSent: boolean
}

function mockRes(): MockRes & ServerResponse {
  const res: MockRes = {
    status: 0, body: '', headersSent: false,
    writeHead(s: number) { this.status = s; return this as unknown as ServerResponse },
    end(b?: string) { if (b !== undefined) this.body = b; return this as unknown as ServerResponse },
  }
  return res as MockRes & ServerResponse
}

function mockReq(query: string): IncomingMessage {
  return {
    url: `${INTERVIEW_FREE_SLOTS_PATH}?${query}`,
    method: 'GET',
    headers: {
      host: `127.0.0.1:${PORT}`,
      'x-recruitment-request': '1',
      [ 'x-dsh-session' ]: SESSION,
    },
  } as unknown as IncomingMessage
}

function queryFor(ids: string): string {
  return `application_id=${APP}&interviewer_actor_ids=${ids}&days=5&duration_minutes=45`
}

test('负例：无日历绑定 → 全员 NO_CALENDAR_BINDING、slots=[]、绝不 LIVE', async () => {
  const { ctx, routes } = makeCtx()
  const dispose = registerInterviewSlotsHttp(ctx, makeDeps())
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.path, INTERVIEW_FREE_SLOTS_PATH)
  const res = mockRes()
  await routes[0]!.handler(mockReq(queryFor(`${IV_A},${IV_B}`)), res)
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.deepEqual(body.slots, [])
  assert.equal(body.proposed, 0)
  assert.deepEqual(body.unsatisfied, [
    { interviewer_actor_id: IV_A, reason: 'NO_CALENDAR_BINDING' },
    { interviewer_actor_id: IV_B, reason: 'NO_CALENDAR_BINDING' },
  ])
  assert.notEqual(body.labels.provenance, 'LIVE')
  assert.notEqual(body.labels.connection, 'CONNECTED')
  assert.equal(body.labels.trigger, 'MANUAL')
  dispose()
})

test('负例：认证失败 → AUTH_REQUIRED + unsatisfied，不冒充空闲', async () => {
  const { ctx, routes } = makeCtx()
  const reader = createFeishuCalendarReader({
    runner: async () => ({
      status: 'NON_ZERO_EXIT', exit_code: 3,
      stdout: JSON.stringify({ ok: false, error: { type: 'authorization', subtype: 'missing_scope' } }),
      stderr: '',
    }),
    platform_channel: true,
  })
  registerInterviewSlotsHttp(ctx, makeDeps({
    io: {
      reader,
      resolveInterviewerOpenId: async (id) => (id === IV_A ? 'ou_a' : 'ou_b'),
    },
  }))
  const res = mockRes()
  await routes[0]!.handler(mockReq(queryFor(`${IV_A},${IV_B}`)), res)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.slots, [])
  assert.deepEqual(body.unsatisfied.map((u: { reason: string }) => u.reason), ['AUTH_REQUIRED', 'AUTH_REQUIRED'])
  assert.equal(body.labels.connection, 'AUTH_REQUIRED')
  assert.equal(body.labels.provenance, 'FIXTURE')
})

test('正例：两名面试官有绑定且真读到忙闲 → 给交集槽、LIVE/CONNECTED', async () => {
  const { ctx, routes } = makeCtx()
  const busyByUser: Record<string, unknown[]> = {
    ou_a: [{ start: '2026-11-20T10:00:00+08:00', end: '2026-11-20T11:00:00+08:00' }],
    ou_b: [{ start: '2026-11-20T11:00:00+08:00', end: '2026-11-20T12:00:00+08:00' }],
  }
  const reader = createFeishuCalendarReader({
    runner: async (args) => {
      const idx = args.indexOf('--user-id')
      const uid = idx >= 0 ? args[idx + 1]! : ''
      return okResult({ ok: true, data: { busy: busyByUser[uid] ?? [] } })
    },
    platform_channel: true,
  })
  registerInterviewSlotsHttp(ctx, makeDeps({
    io: {
      reader,
      resolveInterviewerOpenId: async (id) => (id === IV_A ? 'ou_a' : 'ou_b'),
      now: () => new Date('2026-11-19T09:00:00+08:00'),
      timezone_offset_minutes: 8 * 60,
    },
  }))
  const res = mockRes()
  await routes[0]!.handler(mockReq(queryFor(`${IV_A},${IV_B}`)), res)
  const body = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.deepEqual(body.unsatisfied, [])
  assert.ok(body.slots.length >= 1 && body.slots.length <= 3)
  assert.equal(body.labels.provenance, 'LIVE')
  assert.equal(body.labels.connection, 'CONNECTED')
  for (const s of body.slots) {
    assert.equal(s.busy_conflicts, 0)
    assert.equal(s.source, 'LIVE')
  }
})

test('负例：CLI 未配置（feishuCliPath=null）→ NOT_CONNECTED、空 slots', async () => {
  const { ctx, routes } = makeCtx()
  registerInterviewSlotsHttp(ctx, makeDeps({ feishuCliPath: null }))
  const res = mockRes()
  await routes[0]!.handler(mockReq(queryFor(IV_A)), res)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.slots, [])
  assert.equal(body.labels.connection, 'NOT_CONNECTED')
  assert.equal(body.unsatisfied[0].reason, 'NO_CALENDAR_BINDING')
})

test('负例：非回环 host 不注册路由', () => {
  const { ctx, routes } = makeCtx()
  ctx.webServer.host = '0.0.0.0'
  const dispose = registerInterviewSlotsHttp(ctx, makeDeps())
  assert.equal(routes.length, 0)
  dispose()
})

test('负例：身份覆盖参数 → 400，不碰日历', async () => {
  const { ctx, routes } = makeCtx()
  let called = false
  const reader = createFeishuCalendarReader({
    runner: async () => { called = true; return okResult({ ok: true, data: { busy: [] } }) },
  })
  registerInterviewSlotsHttp(ctx, makeDeps({ io: { reader, resolveInterviewerOpenId: async () => 'ou_a' } }))
  const res = mockRes()
  await routes[0]!.handler(mockReq(`${queryFor(IV_A)}&actor_id=${IV_B}`), res)
  assert.equal(res.status, 400)
  assert.equal(called, false)
})
