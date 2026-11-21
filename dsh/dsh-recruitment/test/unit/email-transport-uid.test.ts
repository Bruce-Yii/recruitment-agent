// 真缺陷回归（2026-11-18 第三轮，真链第二次 total=0）：
//   imapflow 的 fetchOne(seq, query, options) 第三参数 {uid:true} 决定首参按 UID 解释。
//   漏传 → 按序列号取 → uid=1125 在 1073 封邮箱里不存在 → envelope=null → 空壳元数据
//   → 编排层拿不到 date → 保守跳过 → total=0。
//   另：envelope.from/to 是 [{address,name}] 对象数组、message-id 字段是 camelCase messageId；
//   旧实现只认 'message-id' 字符串，且用 `uid-N@imap-local` 合成 id 掩盖读不到的事实。
// 不连真 IMAP/真 PG：用假 imapflow 构造器记录 fetchOne 的第三参数。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createImapTransport,
  envelopeHeaders,
  __setImapFlowCtorForTest,
} from '../../src/connectors/mail/transport.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const CONFIG: MailConfig = {
  host: 'imap.test', user: 'hr@test', password_env: 'PW', password: 'x',
  port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
}

/**
 * 真 imapflow envelope 形状（lead 直连取证）：
 * `date` 运行时是 **JS Date 对象**（JSON 序列化后才显示成 ISO 字符串），
 * from/to 是 [{address,name}] 对象数组，messageId 是 camelCase。
 */
const REAL_ENVELOPE = {
  date: new Date('2026-11-18T14:05:23.000Z'),
  subject: '[recruitment-agent] 收件链路自测',
  from: [{ address: 'hr@test', name: 'HR' }],
  to: [{ address: 'me@qq.com', name: '' }],
  messageId: '<tencent_8E55BC4C@qq.com>',
}

interface FetchCall {
  seq: number
  query: Record<string, unknown>
  options?: Record<string, unknown>
}

/** 假 imapflow：记录 fetchOne 的全部三个参数；返回真实形状 envelope。 */
function fakeImapflow(envelope: unknown, calls: FetchCall[]) {
  return class FakeImapFlow {
    async connect(): Promise<void> {}
    async logout(): Promise<void> {}
    async mailboxOpen(): Promise<void> {}
    async search(): Promise<number[]> { return [1124, 1125] }
    async fetchOne(
      seq: number,
      query: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<unknown> {
      calls.push({ seq, query, options })
      return { uid: seq, envelope, source: Buffer.from('raw-mime-bytes') }
    }
  }
}

test.after(() => { __setImapFlowCtorForTest(null) })

test('listNew 的 fetchOne 第三参数必须含 uid:true（否则按序列号取 → 空壳）', async () => {
  const calls: FetchCall[] = []
  __setImapFlowCtorForTest(fakeImapflow(REAL_ENVELOPE, calls) as never)
  const transport = createImapTransport(CONFIG)
  await transport.connect()
  const envelopes = await transport.listNew({ limit: 10, since_days: 7 })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.deepEqual(call.options, { uid: true }, 'fetchOne 必须传 {uid:true} 作为第三参数')
  }
  // 真实元数据不再为空
  assert.equal(envelopes.length, 2)
  assert.equal(envelopes[0]!.subject, '[recruitment-agent] 收件链路自测')
  assert.equal(envelopes[0]!.date, '2026-11-18T14:05:23.000Z')
  assert.equal(envelopes[0]!.message_id, 'tencent_8E55BC4C@qq.com')
  assert.equal(envelopes[0]!.from, 'hr@test')
  await transport.disconnect()
})

test('fetchMessage 的 fetchOne 第三参数同样必须含 uid:true', async () => {
  const calls: FetchCall[] = []
  __setImapFlowCtorForTest(fakeImapflow(REAL_ENVELOPE, calls) as never)
  const transport = createImapTransport(CONFIG)
  await transport.connect()
  const message = await transport.fetchMessage(1125)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.options, { uid: true })
  assert.equal(message.message_id, 'tencent_8E55BC4C@qq.com')
  assert.equal(message.headers['subject'], '[recruitment-agent] 收件链路自测')
  await transport.disconnect()
})

test('fetchOne 返回空 envelope → 如实跳过，绝不合成 uid-N@imap-local 冒充真实 Message-ID', async () => {
  const calls: FetchCall[] = []
  __setImapFlowCtorForTest(fakeImapflow(null, calls) as never)
  const transport = createImapTransport(CONFIG)
  await transport.connect()
  const envelopes = await transport.listNew({ limit: 10, since_days: 7 })
  assert.deepEqual(envelopes, [], '空 envelope 必须跳过，不得产出合成 id')
  await assert.rejects(
    () => transport.fetchMessage(1125),
    (error: Error & { kind?: string }) => error.kind === 'INVALID_MESSAGE',
    'fetchMessage 遇到空 envelope 必须报错，不能编一个 message-id',
  )
  await transport.disconnect()
})

test('envelopeHeaders 认得 imapflow 的 camelCase messageId 与对象数组地址', () => {
  const headers = envelopeHeaders(REAL_ENVELOPE)
  assert.equal(headers['message-id'], '<tencent_8E55BC4C@qq.com>')
  assert.equal(headers.from, 'hr@test')
  assert.equal(headers.to, 'me@qq.com')
  assert.equal(headers.date, '2026-11-18T14:05:23.000Z')
  assert.equal(headers.subject, '[recruitment-agent] 收件链路自测')
})

test('date 是 JS Date 对象 → toISOString 完整保真（第三次真链 date 空的根因）', () => {
  const headers = envelopeHeaders({ date: new Date('2026-11-18T14:05:23Z') })
  assert.equal(headers.date, '2026-11-18T14:05:23.000Z')
  assert.equal('date' in headers, true)
})

test('date 是字符串 → trim 后照旧产出，不走截断', () => {
  const headers = envelopeHeaders({ date: '  Thu, 18 Nov 2026 14:05:23 +0000  ' })
  assert.equal(headers.date, 'Thu, 18 Nov 2026 14:05:23 +0000')
})

test('date undefined / 非法 Date → 不产出 date 键（不许填假值）', () => {
  assert.equal('date' in envelopeHeaders({}), false)
  assert.equal('date' in envelopeHeaders({ date: undefined }), false)
  assert.equal('date' in envelopeHeaders({ date: new Date('not-a-date') }), false)
  assert.equal('date' in envelopeHeaders({ date: '   ' }), false)
})

test('地址元素 name 非 string / 缺 address → 不产出假地址，也不崩', () => {
  const headers = envelopeHeaders({
    from: [{ name: 123 }],
    to: [{ address: 456, name: 'x' }, 'plain@test'],
  })
  assert.equal('from' in headers, false, '缺 string address 就不产出 from')
  assert.equal(headers.to, 'plain@test', '首个元素无效不影响后续字符串元素')
})
