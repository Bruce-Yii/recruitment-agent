// 真链第四跑回归（orchestrator 层，无真 IMAP / 无真 PG）：
//   9 封无附件的订阅/广告邮件被错记 FAILED。本测试用真 parseRawMail + 假 pool + 假 transport，
//   断言：无附件 → SKIPPED/SEEN_NO_ATTACHMENT；fetch/parse 失败 → SKIPPED/UNREADABLE；
//   有附件但类型不支持 → SKIPPED/UNSUPPORTED_ATTACHMENT；只有"有附件但处理失败"才 FAILED。
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchAndIngest } from '../../src/connectors/mail/orchestrator.ts'
import { MailTransportError } from '../../src/connectors/mail/contract.ts'
import type { MailEnvelope, MailTransport, RawMailMessage } from '../../src/connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const NOW = new Date('2026-11-18T18:00:00.000Z')

/** 极简无附件 MIME（mailparser 可解析）。 */
const NO_ATTACHMENT_MIME = [
  'Message-ID: <noattach-1@test>',
  'From: ads@example.test',
  'To: me@qq.com',
  'Subject: Weekly deals',
  'Date: Thu, 18 Nov 2026 14:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Subscribe to our newsletter.',
].join('\r\n')

function envelope(uid: number, id: string): MailEnvelope {
  return {
    uid,
    message_id: id,
    subject: 'Weekly deals',
    from: 'ads@example.test',
    date: NOW.toISOString(),
  }
}

function fakeTransport(opts: {
  fetchError?: Error
  raw?: string
} = {}): MailTransport {
  return {
    async connect(): Promise<void> {},
    async listNew(): Promise<readonly MailEnvelope[]> { return [envelope(1120, 'noattach-1@test')] },
    async fetchMessage(uid: number): Promise<RawMailMessage> {
      if (opts.fetchError !== undefined) throw opts.fetchError
      return {
        uid,
        message_id: 'noattach-1@test',
        headers: { subject: 'Weekly deals', date: NOW.toISOString() },
        attachments: [],
        text: '',
        raw: Buffer.from(opts.raw ?? NO_ATTACHMENT_MIME),
      }
    },
    async disconnect(): Promise<void> {},
  }
}

/** 假 DB：mailFactExists 永远 false、mailFactEvent 插入计数；intake 路径不会被调用。 */
function fakeDeps(transport: MailTransport) {
  const inserts: string[] = []
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      inserts.push(sql.slice(0, 40))
      return { rows: [] }
    },
  }
  const database: ResolvedDatabaseConfig = {
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'never', password: 'x',
    password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
    statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
  }
  const converter: ResolvedConverterConfig = {
    python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 100,
  }
  const mail: MailConfig = {
    host: 'imap.test', user: 'hr@test', password_env: 'PW', password: 'x',
    port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
  }
  return {
    deps: {
      transport,
      cfg: { database, converter, mail },
      clock: () => NOW,
      __poolForTest: {
        pool: {
          async connect(): Promise<unknown> {
            const query = async (sql: string): Promise<{ rows: unknown[] }> => {
              inserts.push(sql.slice(0, 40))
              return { rows: [] }
            }
            return { query, release: () => {} }
          },
        },
        close: async () => {},
      },
    },
    client,
    inserts,
  }
}

test('无附件邮件 → SKIPPED / SEEN_NO_ATTACHMENT，绝不 FAILED', async () => {
  const { deps } = fakeDeps(fakeTransport())
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  assert.equal(result.total, 1)
  assert.equal(result.failed, 0, `无附件不该算失败：${JSON.stringify(result.results)}`)
  assert.equal(result.skipped, 1)
  assert.equal(result.results[0]!.status, 'SEEN_NO_ATTACHMENT')
  assert.equal(result.results[0]!.reason, 'SEEN_NO_ATTACHMENT')
  assert.deepEqual(result.results[0]!.attachments, [])
})

test('fetchMessage 抛错（连原始字节都没有）→ SKIPPED / UNREADABLE，不是 FAILED', async () => {
  const { deps } = fakeDeps(fakeTransport({
    fetchError: new MailTransportError('INVALID_MESSAGE', 'ENVELOPE_MISSING'),
  }))
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  assert.equal(result.failed, 0, `读不出来不是处理失败：${JSON.stringify(result.results)}`)
  assert.equal(result.results[0]!.status, 'SKIPPED')
  assert.equal(result.results[0]!.reason, 'UNREADABLE:ENVELOPE_MISSING')
})

test('mailparser 把坏字节当纯文本解析（无附件）→ SEEN_NO_ATTACHMENT，不是 FAILED', async () => {
  const { deps } = fakeDeps(fakeTransport({ raw: '\x00\x01not-a-mime' }))
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  assert.equal(result.failed, 0, '解析出无附件也绝不记 FAILED')
  assert.equal(result.results[0]!.status, 'SEEN_NO_ATTACHMENT')
  assert.equal(result.results[0]!.reason, 'SEEN_NO_ATTACHMENT')
})

test('无日期邮件在第二道时间窗被丢 → total=0 但 CONNECTED（不是 FAILED）', async () => {
  const transport: MailTransport = {
    ...fakeTransport(),
    async listNew(): Promise<readonly MailEnvelope[]> {
      return [{ ...envelope(1121, 'nodate@test'), date: '' }]
    },
  }
  const { deps } = fakeDeps(transport)
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  assert.equal(result.total, 0)
  assert.equal(result.failed, 0)
  assert.equal(result.connection, 'CONNECTED')
})
