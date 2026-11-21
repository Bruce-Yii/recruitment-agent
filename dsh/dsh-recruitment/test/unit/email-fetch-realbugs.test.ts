// 真链第五跑回归（3 个只有真库/真邮箱才暴露的硬 bug）：
//   ① ON CONFLICT 没带部分索引谓词 → EVENT_WRITE_FAILED（8 封）
//   ② 默认落地根 os.tmpdir() 不在 allowed_roots → OUTSIDE_ALLOWED_ROOTS（新 PDF 没入库）
//   ③ EVENT_WRITE_FAILED 标成 NOT_CONNECTED（DB 写失败被当网络问题）
// 不连真 PG / 真 IMAP：SQL 文本断言 + 假 pool + resolveTempRoot 纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve as resolvePath, join } from 'node:path'

import {
  resolveTempRoot,
  fetchAndIngest,
} from '../../src/connectors/mail/orchestrator.ts'
import type { MailEnvelope, MailTransport, RawMailMessage } from '../../src/connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const NOW = new Date('2026-11-18T18:00:00.000Z')

// ---------------------------------------------------------------------------
//  ① ON CONFLICT 部分索引谓词
// ---------------------------------------------------------------------------

test('insertMailFactEvent 的 ON CONFLICT 必须带 where provider_event_id is not null（部分唯一索引）', async () => {
  // 用假 client 捕获 SQL；走真 fetchAndIngest 触发 insertMailFactEvent。
  const sqls: string[] = []
  const env: MailEnvelope = {
    uid: 1125, message_id: 'fact-1@test', subject: 'Resume', from: 'a@test', date: NOW.toISOString(),
  }
  const transport: MailTransport = {
    async connect(): Promise<void> {},
    async listNew(): Promise<readonly MailEnvelope[]> { return [env] },
    async fetchMessage(uid: number): Promise<RawMailMessage> {
      return {
        uid, message_id: env.message_id, headers: {}, attachments: [], text: '',
        raw: Buffer.from([
          'Message-ID: <fact-1@test>', 'From: a@test', 'Subject: Resume',
          'Date: Thu, 18 Nov 2026 14:00:00 +0000', '', 'no attachment',
        ].join('\r\n')),
      }
    },
    async disconnect(): Promise<void> {},
  }
  const { deps } = harness(transport, sqls)
  await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  const insertSql = sqls.find((s) => s.includes('insert into recruitment.event_inbox'))
  assert.ok(insertSql, '必须写 event_inbox 外部事实')
  assert.match(insertSql!, /on conflict\s*\(tenant_id,\s*provider,\s*provider_event_id\)\s*where\s+provider_event_id\s+is\s+not\s+null\s+do\s+nothing/i,
    '部分唯一索引的 ON CONFLICT 必须重复 WHERE 谓词，否则 PG 报"没有匹配的约束"')
})

// ---------------------------------------------------------------------------
//  ② 落地根目录
// ---------------------------------------------------------------------------

test('resolveTempRoot 默认落在 allowed_roots[0]/.mail-intake/<message-id>', () => {
  const root = resolveTempRoot(undefined, ['D:\\resumes'], 'tencent_abc-123@qq.com')
  assert.equal(root, join(resolvePath('D:\\resumes'), '.mail-intake', 'tencent_abc-123_qq.com'))
})

test('resolveTempRoot 显式 temp_root 越界 → null（调用方报 TEMP_ROOT_OUTSIDE_ALLOWED_ROOTS）', () => {
  assert.equal(resolveTempRoot('C:\\Windows\\Temp', ['D:\\resumes'], 'm@test'), null)
  assert.equal(resolveTempRoot(join(resolvePath('D:\\resumes'), 'ok'), ['D:\\resumes'], 'm@test') !== null, true)
})

test('resolveTempRoot 没有 allowed_roots → null（NOT_CONFIGURED，不硬塞 os.tmpdir）', () => {
  assert.equal(resolveTempRoot(undefined, [], 'm@test'), null)
  assert.equal(resolveTempRoot('D:\\anything', [], 'm@test'), null)
})

test('orchestrator：allowed_roots 为空 → attachment reason=NOT_CONFIGURED（不是 OUTSIDE_ALLOWED_ROOTS）', async () => {
  const withAttachment: MailTransport = {
    async connect(): Promise<void> {},
    async listNew(): Promise<readonly MailEnvelope[]> {
      return [{ uid: 1126, message_id: 'att-1@test', subject: 'Resume', from: 'a@test', date: NOW.toISOString() }]
    },
    async fetchMessage(uid: number): Promise<RawMailMessage> {
      return {
        uid, message_id: 'att-1@test', headers: {}, attachments: [], text: '',
        raw: Buffer.from([
          'Message-ID: <att-1@test>', 'From: a@test', 'Subject: Resume',
          'Date: Thu, 18 Nov 2026 14:00:00 +0000',
          'Content-Type: multipart/mixed; boundary="B"', '', '--B',
          'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="cv.pdf"',
          'Content-Transfer-Encoding: base64', '', 'JVBERi0xLjQK', '--B--',
        ].join('\r\n')),
      }
    },
    async disconnect(): Promise<void> {},
  }
  const { deps } = harness(withAttachment, [], [])
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  const reason = result.results[0]!.attachments[0]!.reason
  assert.equal(reason, 'NOT_CONFIGURED')
  assert.equal(result.results[0]!.status, 'SKIPPED')
})

// ---------------------------------------------------------------------------
//  ③ EVENT_WRITE_FAILED 的 kind = DB_ERROR
// ---------------------------------------------------------------------------

test('event_inbox 写失败 → kind=DB_ERROR（不再是 NOT_CONNECTED）', async () => {
  const env: MailEnvelope = {
    uid: 1127, message_id: 'dbfail-1@test', subject: 'Resume', from: 'a@test', date: NOW.toISOString(),
  }
  const transport: MailTransport = {
    async connect(): Promise<void> {},
    async listNew(): Promise<readonly MailEnvelope[]> { return [env] },
    async fetchMessage(uid: number): Promise<RawMailMessage> {
      return {
        uid, message_id: env.message_id, headers: {}, attachments: [], text: '',
        raw: Buffer.from(['Message-ID: <dbfail-1@test>', 'Date: Thu, 18 Nov 2026 14:00:00 +0000', '', 'body'].join('\r\n')),
      }
    },
    async disconnect(): Promise<void> {},
  }
  const sqls: string[] = []
  const { deps } = harness(transport, sqls, ['D:\\resumes'], true)
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 10 }, deps as never)
  const item = result.results[0]!
  assert.equal(item.status, 'FAILED')
  assert.equal(item.reason, 'EVENT_WRITE_FAILED')
  assert.equal(item.kind, 'DB_ERROR', 'DB 写失败不能标 NOT_CONNECTED')
})

// ---------------------------------------------------------------------------
//  harness
// ---------------------------------------------------------------------------

function harness(
  transport: MailTransport,
  sqls: string[] = [],
  allowedRoots: readonly string[] = ['D:\\resumes'],
  failEventInsert = false,
) {
  const client = {
    query: async (sql: string): Promise<{ rows: unknown[] }> => {
      sqls.push(sql)
      if (failEventInsert && sql.includes('insert into recruitment.event_inbox')) {
        throw new Error('ON CONFLICT mismatch')
      }
      return { rows: [] }
    },
    release: () => {},
  }
  const database: ResolvedDatabaseConfig = {
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'never', password: 'x',
    password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
    statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
  }
  const converter: ResolvedConverterConfig = {
    python_bin: 'python', converter_dir: '/tmp', allowed_roots: allowedRoots, timeout_ms: 100,
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
        pool: { connect: async () => client } as never,
        close: async () => {},
      },
    },
    client,
  }
}
