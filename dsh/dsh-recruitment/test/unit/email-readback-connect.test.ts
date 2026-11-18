// 回执 transport 生命周期回归（真链回执永远 UNREADABLE 的一行根因）：
// 旧 index.ts 闭包直接 listNew() 而从未 connect() → guardConnected 抛 NOT_CONNECTED。
// 现在 createImapReadback 每次自己 connect / finally disconnect，连接失败脱敏进 error 字段。
// 不连真网：假 transport 记录 connect/disconnect 调用。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createImapReadback, type ReadbackTransport } from '../../src/runtime/email-pump.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const MAIL = {
  host: 'imap.qq.com', user: 'hr@qq.com', password_env: 'PW', password: 'never-log-me',
  port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
} as MailConfig

const QUERY = {
  external_id: '<smtp-side-id@qq.com>',
  tenant_id: 't',
  subject: '初筛结果 · 测试候选人丁',
  to: '1241240525@qq.com',
  sent_at: '2026-11-18T23:52:47.054Z',
  time_window_ms: 10 * 60 * 1000,
}

function fakeTransport(opts: {
  connectError?: unknown
  envelopes?: readonly { uid: number; subject: string; from: string; message_id: string; date: string }[]
} = {}) {
  const calls: string[] = []
  let connected = false
  const transport: ReadbackTransport = {
    async connect(): Promise<void> {
      calls.push('connect')
      if (opts.connectError !== undefined) throw opts.connectError
      connected = true
    },
    async listNew(): Promise<readonly { uid: number; subject: string; from: string; message_id: string; date: string }[]> {
      calls.push('listNew')
      if (!connected) throw new Error('guardConnected: NOT_CONNECTED')
      return opts.envelopes ?? []
    },
    async fetchMessage(uid: number): Promise<{
      message_id: string; subject: string; headers: Readonly<Record<string, string>>; text: string
    }> {
      calls.push('fetchMessage')
      void uid
      return {
        message_id: '<tencent_B175@qq.com>',
        subject: QUERY.subject,
        headers: { to: QUERY.to },
        text: '',
      }
    },
    async disconnect(): Promise<void> { calls.push('disconnect') },
  }
  return { transport, calls }
}

test('回执 transport 未 connect 时必须自己 connect，结束时 disconnect（各 1 次）', async () => {
  const { transport, calls } = fakeTransport({
    envelopes: [{
      uid: 1127, subject: QUERY.subject, from: 'hr@qq.com',
      message_id: '<tencent_B175@qq.com>', date: QUERY.sent_at,
    }],
  })
  let factoryCalls = 0
  const readback = createImapReadback(() => { factoryCalls += 1; return transport }, MAIL)
  const result = await readback(QUERY)
  assert.equal(factoryCalls, 1)
  assert.equal(calls.filter((c) => c === 'connect').length, 1, '必须 connect 一次')
  assert.equal(calls.filter((c) => c === 'disconnect').length, 1, '必须 disconnect 一次')
  assert.equal(calls[0], 'connect', 'connect 必须在 listNew 之前')
  assert.equal(result.matched, true)
  assert.equal(result.matched_message_id, '<tencent_B175@qq.com>')
})

test('连接抛错（NOT_CONNECTED）→ matched:false 且保留脱敏 error code，仍 disconnect', async () => {
  const err = Object.assign(new Error('mail transport error: NOT_CONNECTED: NOT_CONNECTED'), {
    kind: 'NOT_CONNECTED',
  })
  const { transport, calls } = fakeTransport({ connectError: err })
  const readback = createImapReadback(() => transport, MAIL)
  const result = await readback(QUERY)
  assert.equal(result.matched, false)
  assert.match(result.error!, /^NOT_CONNECTED:/)
  assert.doesNotMatch(result.error!, /never-log-me/, '口令不得出现在 error 里')
  assert.equal(calls.filter((c) => c === 'disconnect').length, 1)
})

test('AUTH_REQUIRED 连接失败 → error 带 AUTH_REQUIRED（pump 仍按可重试 UNREADABLE 处理）', async () => {
  const err = Object.assign(new Error('mail transport error: AUTH_REQUIRED: AUTH_FAILED'), {
    kind: 'AUTH_REQUIRED',
  })
  const { transport } = fakeTransport({ connectError: err })
  const result = await createImapReadback(() => transport, MAIL)(QUERY)
  assert.equal(result.matched, false)
  assert.match(result.error!, /^AUTH_REQUIRED:/)
})
