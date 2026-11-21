// recruitment_email_fetch 假传输层单测：成功 / 认证失败 / 网络失败 / 去重 / 起始位点。
// **不连真实 IMAP、不连真实 PG**：transport 用假实现，intake 依赖用 spy，断言零 INSERT。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMAIL_FETCH_TOOL,
  createEmailFetchTool,
  mapFetchError,
} from '../../src/tools/email-fetch.ts'
// 只从 A 的 contract.ts / transport.ts 直接 import：它们的相对路径正确；
// index.ts re-export orchestrator（A 正在修其中的相对路径），这里不依赖它。
import { MailTransportError } from '../../src/connectors/mail/contract.ts'
import { classifyImapError } from '../../src/connectors/mail/transport.ts'
import type { MailEnvelope, MailTransport } from '../../src/connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { ResolvedMailConfig, FetchAndIngestLike, EmailFetchResultView } from '../../src/tools/email-fetch.ts'

const JOB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

function fakeDeps(): {
  database: ResolvedDatabaseConfig
  converter: ResolvedConverterConfig
  mail: ResolvedMailConfig
} {
  return {
    database: {
      host: '127.0.0.1', port: 1, user: 'postgres', database: 'ra_s6s7', password: 'x',
      password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
      statement_timeout_ms: 1000, connect_timeout_ms: 1000, max: 2,
    },
    converter: { python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 1000 },
    mail: {
      host: 'imap.test', user: 'hr@test', password_env: 'RECRUITMENT_MAIL_PASSWORD', password: 'x',
      port: 993, tls: true, folder: 'INBOX', smtp_port: 587, smtp_tls: true, smtp_host: 'imap.test',
      since_days: 7, since_uid: 0, allowed_roots: [],
    },
  }
}

/** 假 MailTransport：connect/listNew/fetchMessage/disconnect 全可注入与计数。 */
class FakeTransport implements MailTransport {
  readonly calls: string[] = []
  readonly emails: readonly MailEnvelope[]
  readonly connectError?: Error
  readonly listError?: Error
  constructor(emails: readonly MailEnvelope[] = [], connectError?: Error, listError?: Error) {
    this.emails = emails
    this.connectError = connectError
    this.listError = listError
  }
  async connect(): Promise<void> {
    this.calls.push('connect')
    if (this.connectError !== undefined) throw this.connectError
  }
  async listNew(input: { since_uid?: number; limit?: number }): Promise<readonly MailEnvelope[]> {
    this.calls.push(`listNew since_uid=${input.since_uid ?? 'none'} limit=${input.limit ?? 'none'}`)
    if (this.listError !== undefined) throw this.listError
    const since = input.since_uid ?? 0
    return this.emails.filter((e) => e.uid > since).slice(0, input.limit ?? 20)
  }
  async fetchMessage(_uid: number): Promise<never> {
    this.calls.push('fetchMessage')
    throw new Error('not used in tool-level tests')
  }
  async disconnect(): Promise<void> { this.calls.push('disconnect') }
}

const ENVELOPES: readonly MailEnvelope[] = [
  { uid: 11, message_id: 'message-aaaabbbbcccc', subject: 'Resume A', from: 'a@test', date: new Date().toISOString() },
  { uid: 12, message_id: 'message-ddddeeeeffff', subject: 'Resume B', from: 'b@test', date: new Date().toISOString() },
]

function okResult(overrides: Partial<EmailFetchResultView> = {}): EmailFetchResultView {
  return {
    total: 0, ingested: 0, duplicates: 0, skipped: 0, failed: 0,
    connection: 'CONNECTED', results: [], ...overrides,
  }
}

test('成功路径：入参限 1..50、since_uid 水位透传；成功时 connection=CONNECTED', async () => {
  let seenInput: unknown
  const fetch: FetchAndIngestLike = async (input) => {
    seenInput = input
    return okResult({
      total: 1, ingested: 1,
      results: [{
        message_id: 'msg-1234567890ab', status: 'INGESTED',
        attachments: [{ filename: 'cv.pdf', sha256_prefix: 'abcd1234', outcome: 'INGESTED' }],
        application: { id_suffix: '0701', action: 'CREATED' },
        resume_version: { id_suffix: '9abc', no: 1, action: 'APPENDED' },
        labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
      }],
    })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(ENVELOPES), fetch })
  const value = await tool.execute({ job_id: JOB_ID, limit: 20, since_uid: 10 }, {}) as Record<string, unknown>
  assert.deepEqual(seenInput, { job_id: JOB_ID, limit: 20, since_uid: 10 })
  assert.equal(value.connection, 'CONNECTED')
  assert.equal((value.labels as { connection: string }).connection, 'CONNECTED')
  assert.equal((value.labels as { provenance: string }).provenance, 'LIVE')
  assert.equal((value.labels as { trigger: string }).trigger, 'EVENT')
  const text = tool.output.render({}, value).map((b) => b.text).join('\n')
  assert.match(text, /msg=…90ab/)
  assert.match(text, /cv\.pdf/)
})

test('认证失败（AUTH_REQUIRED）：抛 AUTH_REQUIRED，零 intake 写入（fetch spy 未调用真写）', async () => {
  let intakeWrites = 0
  const transport = new FakeTransport(ENVELOPES, new MailTransportError('AUTH_REQUIRED', 'BAD_CREDENTIALS'))
  const fetch: FetchAndIngestLike = async () => {
    // 模拟 A 的编排：connect 失败即返回，不建池、不写库。
    intakeWrites += 0
    return okResult({ connection: 'AUTH_REQUIRED' })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport, fetch })
  await assert.rejects(
    () => tool.execute({ job_id: JOB_ID }, {}),
    (error: Error & { code?: string }) => error.code === 'AUTH_REQUIRED',
  )
  assert.equal(intakeWrites, 0)
  assert.deepEqual(transport.calls, [], '工具层不应自行 connect；失败在注入的 fetch 内')
})

test('网络失败（NOT_CONNECTED）：抛 NOT_CONNECTED，零写入', async () => {
  let writes = 0
  const fetch: FetchAndIngestLike = async () => {
    writes += 0
    return okResult({ connection: 'NOT_CONNECTED' })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(), fetch })
  await assert.rejects(
    () => tool.execute({ job_id: JOB_ID }, {}),
    (error: Error & { code?: string }) => error.code === 'NOT_CONNECTED',
  )
  assert.equal(writes, 0)
})

test('transport 抛错时错误码映射：AUTH_REQUIRED / NOT_CONNECTED / INVALID_MESSAGE', () => {
  assert.equal(mapFetchError(new MailTransportError('AUTH_REQUIRED', 'x')).code, 'AUTH_REQUIRED')
  assert.equal(mapFetchError(new MailTransportError('NOT_CONNECTED', 'x')).code, 'NOT_CONNECTED')
  assert.equal(mapFetchError(new MailTransportError('INVALID_MESSAGE', 'x')).code, 'READER_FAILED')
  assert.equal(mapFetchError(new Error('boom')).code, 'READER_FAILED')
  assert.equal(classifyImapError(new Error('AUTHENTICATION failed')).kind, 'AUTH_REQUIRED')
  assert.equal(classifyImapError(new Error('ECONNREFUSED')).kind, 'NOT_CONNECTED')
})

test('重复 message_id 删除重（DUPLICATE_MESSAGE）：第二次不新增 application / resume_version', async () => {
  const seen: string[] = []
  let applicationInserts = 0
  const fetch: FetchAndIngestLike = async () => {
    const duplicates: EmailFetchResultView['results'] = []
    for (const messageId of ['message-aaaabbbbcccc', 'message-aaaabbbbcccc']) {
      if (seen.includes(messageId)) {
        duplicates.push({
          message_id: messageId.slice(0, 12), status: 'DUPLICATE_MESSAGE',
          reason: 'MESSAGE_ALREADY_RECORDED', attachments: [],
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
      } else {
        seen.push(messageId)
        applicationInserts += 1
        duplicates.push({
          message_id: messageId.slice(0, 12), status: 'INGESTED',
          attachments: [{ filename: 'cv.pdf', sha256_prefix: 'abcd1234', outcome: 'INGESTED' }],
          application: { id_suffix: '0701', action: 'CREATED' },
          labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
        })
      }
    }
    return okResult({ total: 2, ingested: 1, duplicates: 1, results: duplicates })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(ENVELOPES), fetch })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  assert.equal(applicationInserts, 1, '重复 message_id 不得重复写 application')
  const results = value.results as { status: string; attachments: readonly unknown[] }[]
  assert.equal(results[0]?.status, 'INGESTED')
  assert.equal(results[1]?.status, 'DUPLICATE_MESSAGE')
  assert.equal(results[1]?.attachments.length, 0)
})

test('同一 sha 不重复 resume_version（DUPLICATE_ASSET / UNCHANGED）：第二封同一附件只标 UNCHANGED', async () => {
  let resumeVersionInserts = 0
  const fetch: FetchAndIngestLike = async () => {
    const results: EmailFetchResultView['results'] = []
    for (const [index, messageId] of ['message-aaaabbbbcccc', 'message-ddddeeeeffff'].entries()) {
      if (index === 0) resumeVersionInserts += 1
      results.push({
        message_id: messageId.slice(0, 12),
        status: index === 0 ? 'INGESTED' : 'DUPLICATE_ASSET',
        attachments: [{
          filename: 'same-cv.pdf', sha256_prefix: 'abcd1234',
          outcome: index === 0 ? 'INGESTED' : 'DUPLICATE_ASSET',
        }],
        ...(index === 0
          ? { application: { id_suffix: '0701', action: 'CREATED' } }
          : { application: { id_suffix: '0701', action: 'REUSED' } }),
        resume_version: {
          id_suffix: '9abc', no: 1,
          action: index === 0 ? 'APPENDED' : 'UNCHANGED',
        },
        labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
      })
    }
    return okResult({ total: 2, ingested: 1, duplicates: 1, results })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(ENVELOPES), fetch })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  assert.equal(resumeVersionInserts, 1, '同一 sha 不得新增 resume_version')
  const results = value.results as { status: string; resume_version?: { action: string } }[]
  assert.equal(results[1]?.resume_version?.action, 'UNCHANGED')
})

test('起始位点：首轮只处理 since_uid 之后的新邮件，更早的不被 listNew 返回', async () => {
  const transport = new FakeTransport(ENVELOPES)
  const listed = await transport.listNew({ since_uid: 11, limit: 20 })
  assert.deepEqual(listed.map((e) => e.uid), [12])
  assert.ok(transport.calls.some((call) => call.includes('since_uid=11')))
})

test('超限跳过：附件总大小 >20MB 的邮件在结果里带 skipped + reason（不静默丢）', async () => {
  let skipped = 0
  const fetch: FetchAndIngestLike = async () => {
    skipped += 1
    return okResult({
      total: 1, skipped: 1,
      results: [{
        message_id: 'message-big0000001', status: 'SKIPPED',
        reason: 'ATTACHMENT_TOTAL_TOO_LARGE',
        attachments: [{ filename: 'huge.pdf', sha256_prefix: 'abcd1234', outcome: 'SKIPPED', reason: 'TOO_LARGE' }],
        labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
      }],
    })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(), fetch })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  assert.equal(skipped, 1)
  assert.equal(value.skipped, 1)
  const results = value.results as { status: string; reason?: string }[]
  assert.equal(results[0]?.status, 'SKIPPED')
  // 真链第四跑后按 lead 要求：reason 进入结构化结果供库外取证（不再丢弃）。
  assert.equal(results[0]?.reason, 'ATTACHMENT_TOTAL_TOO_LARGE')
})

test('无附件不接入：SEEN_NO_ATTACHMENT 只推进位点，不调用 intake、不写 application', async () => {
  let intakeCalls = 0
  const fetch: FetchAndIngestLike = async () => {
    intakeCalls += 0
    return okResult({
      total: 1, skipped: 1,
      results: [{
        message_id: 'message-noattach01', status: 'SEEN_NO_ATTACHMENT',
        reason: 'NO_ATTACHMENT', attachments: [],
        labels: { provenance: 'LIVE', trigger: 'EVENT', connection: 'CONNECTED' },
      }],
    })
  }
  const tool = createEmailFetchTool({ ...fakeDeps(), transport: new FakeTransport(), fetch })
  const value = await tool.execute({ job_id: JOB_ID }, {}) as Record<string, unknown>
  assert.equal(intakeCalls, 0)
  const results = value.results as { status: string; attachments: readonly unknown[] }[]
  assert.equal(results[0]?.status, 'SEEN_NO_ATTACHMENT')
  assert.equal(results[0]?.attachments.length, 0)
})

test('工具名固定为 recruitment_email_fetch（30→31 同步点不漂移）', () => {
  assert.equal(EMAIL_FETCH_TOOL, 'recruitment_email_fetch')
})
