// 真链第四跑回归：无附件邮件被错记 FAILED，且工具层把 reason/subject 丢了。
// 修法：① 编排层 fetch/parse 失败 → SKIPPED/UNREADABLE（FAILED 只留给"有附件但处理失败"）；
//       ② 工具层 result 透传 reason/kind/subject/attachment.reason（结构化 value 可取证）。
// 不连真 IMAP / 真 PG：用假 fetch 注入工具，断言结果形状与 render。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createEmailFetchTool, type EmailFetchResultView } from '../../src/tools/email-fetch.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { ResolvedMailConfig } from '../../src/tools/email-fetch.ts'

const JOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function fakeDeps() {
  return {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra', password: 'x',
      password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
      statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
    } as ResolvedDatabaseConfig,
    converter: { python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 100 } as ResolvedConverterConfig,
    mail: {
      host: 'imap.test', user: 'hr@test', password_env: 'PW', password: 'x',
      port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
      smtp_port: 587, smtp_tls: false, smtp_host: 'smtp.test', allowed_roots: [],
    } as ResolvedMailConfig,
    transport: {},
  }
}

function toolReturning(results: EmailFetchResultView['results'], counters: Partial<EmailFetchResultView> = {}) {
  const view: EmailFetchResultView = {
    total: results.length,
    ingested: counters.ingested ?? 0,
    duplicates: counters.duplicates ?? 0,
    skipped: counters.skipped ?? results.length,
    failed: counters.failed ?? 0,
    connection: 'CONNECTED',
    results,
  }
  return createEmailFetchTool({ ...fakeDeps(), fetch: async () => view })
}

test('无附件邮件：SKIPPED + reason=SEEN_NO_ATTACHMENT（不是 FAILED），reason 透传到结构化结果', async () => {
  const tool = toolReturning([{
    message_id: 'msg-seen-0001',
    subject: '订阅广告（无附件）',
    status: 'SEEN_NO_ATTACHMENT',
    reason: 'SEEN_NO_ATTACHMENT',
    attachments: [],
    labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
  }])
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  const results = value.results as Record<string, unknown>[]
  assert.equal(results[0]!.status, 'SEEN_NO_ATTACHMENT')
  assert.equal(results[0]!.reason, 'SEEN_NO_ATTACHMENT')
  assert.equal(results[0]!.subject, '订阅广告（无附件）')
  assert.equal(value.failed, 0)
  // 人读文本也带 reason（取证友好）
  const text = tool.output.render({}, value).map((b) => b.text).join('\n')
  assert.match(text, /reason=SEEN_NO_ATTACHMENT/)
})

test('附件类型不支持：SKIPPED + reason=UNSUPPORTED_TYPE（不是 FAILED）', async () => {
  const tool = toolReturning([{
    message_id: 'msg-unsup-0002',
    subject: ' Unsupported file',
    status: 'SKIPPED',
    reason: 'UNSUPPORTED_TYPE:UNSUPPORTED_MEDIA',
    attachments: [{ filename: 'image.png', sha256_prefix: '—', outcome: 'SKIPPED', reason: 'UNSUPPORTED_TYPE' }],
  }])
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  const results = value.results as Record<string, unknown>[]
  assert.equal(results[0]!.status, 'SKIPPED')
  assert.equal(results[0]!.reason, 'UNSUPPORTED_TYPE:UNSUPPORTED_MEDIA')
  const attachments = results[0]!.attachments as Record<string, unknown>[]
  assert.equal(attachments[0]!.reason, 'UNSUPPORTED_TYPE')
  assert.equal(value.failed, 0)
})

test('有附件但处理失败：仍 FAILED，reason 与 kind 都透传', async () => {
  const tool = toolReturning([{
    message_id: 'msg-fail-0003',
    subject: 'Broken resume',
    status: 'FAILED',
    reason: 'INTAKE_FAILED',
    kind: 'INVALID_MESSAGE',
    attachments: [{ filename: 'cv.pdf', sha256_prefix: 'ab12cd34', outcome: 'SKIPPED', reason: 'INTAKE_FAILED' }],
  }], { failed: 1, skipped: 0 })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  const results = value.results as Record<string, unknown>[]
  assert.equal(results[0]!.status, 'FAILED')
  assert.equal(results[0]!.reason, 'INTAKE_FAILED')
  assert.equal(results[0]!.kind, 'INVALID_MESSAGE')
  assert.equal(value.failed, 1)
})

test('重复附件：DUPLICATE_ASSET + reason=SHA_ALREADY_INGESTED 可取证', async () => {
  const tool = toolReturning([{
    message_id: 'msg-dup-0004',
    subject: 'Resume duplicate',
    status: 'DUPLICATE_ASSET',
    reason: 'SHA_ALREADY_INGESTED',
    attachments: [{ filename: 'cv.pdf', sha256_prefix: '3c12527f', outcome: 'DUPLICATE_ASSET', reason: 'SHA_ALREADY_INGESTED' }],
  }], { duplicates: 1, skipped: 0 })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  const results = value.results as Record<string, unknown>[]
  assert.equal(results[0]!.status, 'DUPLICATE_ASSET')
  assert.equal(results[0]!.reason, 'SHA_ALREADY_INGESTED')
})
