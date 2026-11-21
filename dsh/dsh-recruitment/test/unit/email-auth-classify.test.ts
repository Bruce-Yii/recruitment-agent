// EM-5 负例标签回归（真链第六跑）：错授权码时 QQ 只给 `Error('Command failed')`
// （无 code/name），旧实现按消息匹配永远判 NOT_CONNECTED。新判据（有依据）：
//   1. error.authenticationFailed === true → AUTH_REQUIRED（不探测 TCP）；
//   2. 模糊错误 → 纯 TCP 探测：可达 = 服务器在但凭据被拒 → AUTH_REQUIRED；
//      不可达 = 网络不通 → NOT_CONNECTED。
// 不连真 IMAP / 真网 / 真库：注入假构造器 + 假 TCP 探测器，断言零写入。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createImapTransport,
  classifyConnectError,
  isAmbiguousImapError,
  MAIL_TCP_PROBE_TIMEOUT_MS,
  __setImapFlowCtorForTest,
  __setTcpProbeForTest,
} from '../../src/connectors/mail/transport.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const CONFIG: MailConfig = {
  host: 'imap.qq.com', user: 'hr@qq.com', password_env: 'PW', password: 'wrong-auth-code',
  port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
}

test.after(() => {
  __setImapFlowCtorForTest(null)
  __setTcpProbeForTest(null)
})

/** 假 imapflow：connect() 抛指定错误；其余方法不存在（不会被调用）。 */
function fakeImapflow(connectError: unknown) {
  return class FakeImapFlow {
    async connect(): Promise<void> { throw connectError }
    async logout(): Promise<void> {}
    async mailboxOpen(): Promise<void> {}
    async search(): Promise<number[]> { return [] }
    async fetchOne(): Promise<unknown> { return null }
  }
}

test('QQ 真形状 Error("Command failed") + TCP 可达 → AUTH_REQUIRED（不是 NOT_CONNECTED）', async () => {
  const err = new Error('Command failed')
  assert.equal(isAmbiguousImapError(err), true)
  __setImapFlowCtorForTest(fakeImapflow(err) as never)
  __setTcpProbeForTest(async () => true)
  const transport = createImapTransport(CONFIG)
  await assert.rejects(
    () => transport.connect(),
    (e: Error & { kind?: string; reason?: string }) => {
      assert.equal(e.kind, 'AUTH_REQUIRED')
      assert.equal(e.reason, 'AUTH_REJECTED_TCP_REACHABLE')
      return true
    },
  )
  await transport.disconnect()
})

test('QQ 真形状 Error("Command failed") + TCP 不可达 → NOT_CONNECTED', async () => {
  const err = new Error('Command failed')
  __setImapFlowCtorForTest(fakeImapflow(err) as never)
  __setTcpProbeForTest(async () => false)
  const transport = createImapTransport(CONFIG)
  await assert.rejects(
    () => transport.connect(),
    (e: Error & { kind?: string; reason?: string }) => {
      assert.equal(e.kind, 'NOT_CONNECTED')
      return true
    },
  )
  await transport.disconnect()
})

test('authenticationFailed === true → 直接 AUTH_REQUIRED，完全不查 TCP', async () => {
  const err = Object.assign(new Error('Command failed'), { authenticationFailed: true })
  let probeCalls = 0
  __setTcpProbeForTest(async () => { probeCalls += 1; return false })
  const classified = await classifyConnectError(err, CONFIG.host, CONFIG.port)
  assert.equal(classified.kind, 'AUTH_REQUIRED')
  assert.equal(probeCalls, 0, 'authenticationFailed 是明确信号，不需要 TCP 探测')
})

test('TCP 探测带 3s 超时参数（真探测器口径）', () => {
  assert.equal(MAIL_TCP_PROBE_TIMEOUT_MS, 3_000)
})

test('明确网络错误（ECONNREFUSED）不探测 TCP，直接 NOT_CONNECTED', async () => {
  const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  assert.equal(isAmbiguousImapError(err), false)
  let probeCalls = 0
  __setTcpProbeForTest(async () => { probeCalls += 1; return true })
  const classified = await classifyConnectError(err, CONFIG.host, CONFIG.port)
  assert.equal(classified.kind, 'NOT_CONNECTED')
  assert.equal(probeCalls, 0)
})

test('零写入：失败路径不产生任何 DB 调用（本测试不注入 pool/DB，且 connect 失败时 client 保持 null）', async () => {
  // transport 模块本身不 import 任何 DB 模块；connect 失败只抛错、client=null。
  // 这里再次跑一遍失败路径，确认不带任何副作用对象即可完成。
  __setImapFlowCtorForTest(fakeImapflow(new Error('Command failed')) as never)
  __setTcpProbeForTest(async () => true)
  const transport = createImapTransport(CONFIG)
  let raised = false
  try { await transport.connect() } catch { raised = true }
  assert.equal(raised, true)
  // 失败后 listNew/fetchMessage 都必须 guard 成 NOT_CONNECTED（不会有半连接写入）。
  await assert.rejects(
    () => transport.listNew({ limit: 10 }),
    (e: Error & { kind?: string }) => e.kind === 'NOT_CONNECTED',
  )
  await transport.disconnect()
})
