// PR #29 补尾巴：宿主启动轮询生命周期单测（无真实 IMAP / PG / 时钟）。
//
// 覆盖：
//   1. helper 层：未配置 env → 返回 null（不建 timer、不跑 tick）；
//   2. helper 层：配置正整数 env → start 排一个 timer；触发 tick 调注入的 executeOnce；
//      stop 清 timer、等在途 tick、幂等；
//   3. apply() 层：默认关闭 → 不注册 IMAP 轮询 effect、不建 timer；
//   4. apply() 层：显式配置 → 注册 effect 并 start；执行 cleanup → stop（timer 被清）。
//
// 全程注入假 timer / 假 executeOnce（经 __testHooks.createHostMailPoller），不碰网络/DB。
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, __testHooks } from '../../src/index.ts'
import {
  createHostMailPoller,
  type HostMailPollerHandle,
} from '../../src/connectors/mail/host-poller.ts'
import { MAIL_POLL_INTERVAL_ENV, type PollTimer } from '../../src/connectors/mail/poll.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { ResolvedMailConfig } from '../../src/tools/email-fetch.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'

const DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1', port: 1, user: 'postgres', database: 'never', password: 'x',
  password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: TENANT, actor_id: HR_ACTOR,
  statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
}
const CONVERTER: ResolvedConverterConfig = {
  python_bin: 'C:/python/python.exe', converter_dir: 'C:/tmp/converter',
  allowed_roots: ['C:/tmp/allowed'], timeout_ms: 100,
}
const MAIL: ResolvedMailConfig = {
  host: 'imap.test', user: 'hr@test', password_env: 'RECRUITMENT_MAIL_PASSWORD',
  password: 'x', port: 993, tls: true, folder: 'INBOX',
  smtp_host: 'smtp.test', smtp_port: 587, smtp_tls: false,
  since_days: 7, since_uid: 0, allowed_roots: ['C:/tmp/allowed'],
}

/** 假 timer：记录待触发回调，fire() 触发并消费；clearTimeout 让对应回调失效。 */
function fakeTimer(): PollTimer & {
  pendingCount(): number
  fire(): void
  cleared: number
} {
  const scheduled: { id: number; fn: () => void; live: boolean }[] = []
  let nextId = 1
  let cleared = 0
  return {
    get cleared() { return cleared },
    pendingCount() { return scheduled.filter((s) => s.live).length },
    fire(): void {
      const entry = scheduled.find((s) => s.live)
      assert.ok(entry !== undefined, '期望有一个待触发 timer')
      entry.live = false // 真实 setTimeout 触发后自动消费
      entry.fn()
    },
    setTimeout(fn: () => void): unknown {
      const id = nextId++
      scheduled.push({ id, fn, live: true })
      return id
    },
    clearTimeout(handle?: unknown): void {
      cleared += 1
      const entry = scheduled.find((s) => s.id === handle)
      if (entry !== undefined) entry.live = false
    },
  }
}

// ---------------------------------------------------------------------------
// helper 层
// ---------------------------------------------------------------------------

test('helper：未配置 RECRUITMENT_IMAP_POLL_INTERVAL_MS → null，不建 timer / 不跑 tick', () => {
  let ticks = 0
  let timerCreated = false
  const handle = createHostMailPoller({
    env: {},
    database: DB,
    mail: MAIL,
    converter: CONVERTER,
    timer: {
      setTimeout() { timerCreated = true; return 1 },
      clearTimeout() {},
    },
    executeOnce: async () => { ticks += 1; return { next_since_uid: 1, progressed: true } },
  })
  assert.equal(handle, null, '默认关闭必须返回 null')
  assert.equal(timerCreated, false, '默认关闭不得排任何 timer')
  assert.equal(ticks, 0)
})

test('helper：配置正整数间隔 → start 排 timer；tick 用注入 executeOnce；stop 清 timer 且幂等', async () => {
  const timer = fakeTimer()
  const seenSince: number[] = []
  const handle = createHostMailPoller({
    env: { [MAIL_POLL_INTERVAL_ENV]: '1000' },
    database: DB,
    mail: MAIL,
    converter: CONVERTER,
    timer,
    executeOnce: async (since) => {
      seenSince.push(since)
      return { next_since_uid: since + 1, progressed: true }
    },
  })!
  assert.ok(handle !== null)
  assert.equal(handle.intervalMs, 1000)
  assert.equal(timer.pendingCount(), 0, '创建时不得排 timer')

  handle.start()
  assert.equal(handle.isRunning(), true)
  assert.equal(timer.pendingCount(), 1, 'start 只排一个 timer')

  // 触发两轮（每轮结束会排下一轮）。
  timer.fire()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seenSince, [0], '第一轮从 mail.since_uid（0）开始')
  timer.fire()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(seenSince, [0, 1], '第二轮用上一轮推进后的水位')

  await handle.stop()
  assert.equal(handle.isRunning(), false)
  assert.equal(timer.cleared, 1, 'stop 清掉在途 timer')
  assert.equal(timer.pendingCount(), 0, 'stop 后不得再排下一轮')
  await handle.stop() // 幂等
  assert.equal(timer.cleared, 1)
})

// ---------------------------------------------------------------------------
// apply() 层（index 接线）
// ---------------------------------------------------------------------------

interface FakeCtxResult {
  readonly ctx: unknown
  readonly effectLabels: readonly string[]
  readonly cleanups: readonly (() => unknown)[]
}

function fakeCtx(): FakeCtxResult {
  const effectLabels: string[] = []
  const cleanups: (() => unknown)[] = []
  const ctx = {
    tools: { register: () => {} },
    // 真实 cordis 语义：effect 立即执行 fn 并登记其返回值作为 cleanup。
    effect: (fn: () => () => unknown, label?: string) => {
      effectLabels.push(label ?? '')
      const cleanup = fn()
      cleanups.push(cleanup)
      return cleanup
    },
    // 不注入 webServer：HTTP 路由不注册，避免真实服务监听。
    inject: (_names: readonly string[], _cb: (child: unknown) => void) => {},
  }
  return { ctx, effectLabels, cleanups }
}

const FULL_CONFIG = {
  database: {
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra',
    tenant_id: TENANT, actor_id: HR_ACTOR,
  },
  converter: {
    // 配置只要求绝对路径；按平台给一个存在语义的绝对路径，避免 Linux CI 把 Windows
    // 盘符路径判成相对路径，导致 apply 里的 converter/mail 门控不成立。
    python_bin: process.platform === 'win32' ? 'C:/python/python.exe' : '/usr/bin/python3',
    converter_dir: process.platform === 'win32' ? 'C:/tmp/converter' : '/tmp/converter',
    allowed_roots: [process.platform === 'win32' ? 'C:/tmp/allowed' : '/tmp/allowed'],
  },
  mail: {
    host: 'imap.example.test', user: 'hr@example.test', password_env: 'RECRUITMENT_MAIL_PASSWORD',
    port: 993, tls: true, folder: 'INBOX', smtp_port: 587, smtp_tls: true,
  },
} as const

const FULL_ENV = {
  RECRUITMENT_DB_PASSWORD: 'unused',
  RECRUITMENT_MAIL_PASSWORD: 'unused',
}

test('apply() 默认关闭：不注册 IMAP 轮询 effect（即便 mail/database/converter 齐全）', () => {
  const { ctx, effectLabels } = fakeCtx()
  let factoryCalled = false
  __testHooks.createHostMailPoller = (input) => {
    factoryCalled = true
    return createHostMailPoller(input)
  }
  try {
    apply(ctx as never, FULL_CONFIG, FULL_ENV)
  } finally {
    __testHooks.createHostMailPoller = null
  }
  assert.equal(factoryCalled, true, '工厂应被调用以完成 env 判定')
  assert.equal(
    effectLabels.some((label) => label.includes('IMAP auto-poll lifecycle')),
    false,
    '默认关闭不得注册轮询 effect（零 timer / 零 pool）',
  )
})

test('apply() 显式配置 env：注册 effect 并 start；cleanup（插件卸载）调用 stop 并清 timer', async () => {
  const timer = fakeTimer()
  const { ctx, effectLabels, cleanups } = fakeCtx()
  let stopped = 0
  let started = 0
  let seenMail: ResolvedMailConfig | null = null

  __testHooks.createHostMailPoller = (input) => {
    seenMail = input.mail
    // 用真实 helper 保持 env 门控语义，只把 timer/executeOnce 换成假的。
    const real = createHostMailPoller({
      ...input,
      timer,
      executeOnce: async () => ({ next_since_uid: 1, progressed: true }),
    })!
    return {
      intervalMs: real.intervalMs,
      start() { started += 1; real.start() },
      stop() { stopped += 1; return real.stop() },
      isRunning: () => real.isRunning(),
    } satisfies HostMailPollerHandle
  }
  let thrown: unknown
  try {
    apply(ctx as never, FULL_CONFIG, { ...FULL_ENV, [MAIL_POLL_INTERVAL_ENV]: '60000' })
  } catch (error) {
    thrown = error
  } finally {
    __testHooks.createHostMailPoller = null
  }
  assert.equal(thrown, undefined, `apply 不得抛错：${String(thrown)}`)
  assert.ok(seenMail !== null, '应传入已解析的 mail 配置')
  assert.equal(started, 1, 'apply 内 effect 立即 start 一次')
  assert.equal(timer.pendingCount(), 1, 'start 排了一个 timer')
  const labelIndex = effectLabels.findIndex((label) => label.includes('IMAP auto-poll lifecycle'))
  assert.ok(labelIndex >= 0, '应注册 IMAP 轮询生命周期 effect')

  // 插件卸载：cordis 执行 effect 登记的 cleanup → stop。
  await cleanups[labelIndex]!()
  assert.equal(stopped, 1, 'cleanup 必须调用 stop')
  assert.equal(timer.cleared, 1, 'cleanup 后 timer 被清')
  assert.equal(timer.pendingCount(), 0, 'cleanup 后不再排下一轮')
})
