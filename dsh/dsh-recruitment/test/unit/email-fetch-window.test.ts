// 真缺陷回归（2026-11-18，真链 total=0）：
//   旧 listNew 无水位时 search({all:true}) 后按 UID **升序**取前 N 条 = 最老的 N 封，
//   全被 since_days 时间窗丢掉 → 1073 封邮箱永远 total=0。
// 两层防线都要测：① 传输层用 IMAP SINCE + 降序取最新；② 编排层下推 since_days 并保留时间窗兜底。
// 不连真 IMAP、不连真 PG：只测纯函数 + 假 transport + 空窗（pool 惰性不查询）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  imapSinceDate,
  imapSearchCriteria,
  selectNewestUids,
} from '../../src/connectors/mail/transport.ts'
import { fetchAndIngest } from '../../src/connectors/mail/orchestrator.ts'
import type { ListNewInput, MailEnvelope, MailTransport, RawMailMessage } from '../../src/connectors/mail/contract.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { MailConfig } from '../../src/connectors/mail/contract.ts'

const NOW = new Date('2026-11-18T12:00:00.000Z')

// ---------------------------------------------------------------------------
//  ① 传输层纯函数
// ---------------------------------------------------------------------------

test('selectNewestUids：从升序 UID 列表里取【最新】的 N 个，不是最老的', () => {
  // 模拟 search({all:true}) 的返回（升序，1..1073）
  const all = Array.from({ length: 1073 }, (_, i) => i + 1)
  const picked = selectNewestUids(all, 0, 10)
  assert.deepEqual(picked, [1073, 1072, 1071, 1070, 1069, 1068, 1067, 1066, 1065, 1064])
  assert.equal(picked[0], 1073, '必须 newest-first；旧实现这里是 1')
})

test('selectNewestUids：水位以上才入选，且降序', () => {
  assert.deepEqual(selectNewestUids([5, 9, 7, 12, 11, 3], 8, 2), [12, 11])
  assert.deepEqual(selectNewestUids([1, 2, 3], 3, 10), [])
})

test('imapSearchCriteria：无水位用 SINCE 日期窗口（绝不用 all）', () => {
  const criteria = imapSearchCriteria(0, 7, NOW) as { since?: string; all?: boolean; uid?: string }
  assert.equal(criteria.all, undefined, '真缺陷根因：禁止 all')
  assert.equal(typeof criteria.since, 'string')
  assert.match(criteria.since!, /^\d{2}-[A-Z][a-z]{2}-\d{4}$/, 'IMAP SINCE 必须是 DD-Mon-YYYY')
  // 7 天前 = 2026-11-11
  assert.equal(imapSinceDate(7, NOW), '11-Nov-2026')
})

test('imapSearchCriteria：有水位用 uid:n+1:*（增量），不带 since', () => {
  const criteria = imapSearchCriteria(1070, 7, NOW) as { uid?: string; since?: string }
  assert.equal(criteria.uid, '1071:*')
  assert.equal(criteria.since, undefined)
})

// ---------------------------------------------------------------------------
//  ② 编排层：下推 since_days + 时间窗第二道防线
// ---------------------------------------------------------------------------

class RecordingTransport implements MailTransport {
  readonly listInputs: readonly ListNewInput[] = []
  readonly emails: readonly MailEnvelope[]
  constructor(emails: readonly MailEnvelope[]) { this.emails = emails }
  async connect(): Promise<void> {}
  async listNew(input: ListNewInput): Promise<readonly MailEnvelope[]> {
    ;(this.listInputs as ListNewInput[]).push(input)
    // 故意模拟服务端/假 transport 返回【升序】列表——编排层不能依赖顺序来筛新邮件。
    return [...this.emails].sort((a, b) => a.uid - b.uid).slice(0, input.limit ?? 20)
  }
  async fetchMessage(_uid: number): Promise<RawMailMessage> { throw new Error('not used') }
  async disconnect(): Promise<void> {}
}

function deps(transport: MailTransport) {
  const database: ResolvedDatabaseConfig = {
    host: '127.0.0.1', port: 1, user: 'postgres', database: 'never', password: 'x',
    password_env: 'RECRUITMENT_DB_PASSWORD', tenant_id: 't', actor_id: 'a',
    statement_timeout_ms: 100, connect_timeout_ms: 100, max: 1,
  }
  const converter: ResolvedConverterConfig = {
    python_bin: 'python', converter_dir: '/tmp', allowed_roots: ['/tmp'], timeout_ms: 100,
  }
  const mail: MailConfig = {
    host: 'imap.test', user: 'hr@test', password_env: 'RECRUITMENT_MAIL_PASSWORD', password: 'x',
    port: 993, tls: true, folder: 'INBOX', since_days: 7, since_uid: 0,
  }
  return { transport, cfg: { database, converter, mail }, clock: () => NOW }
}

test('编排层把 since_days 下推给 listNew（传输层据此用 SINCE，不再 all）', async () => {
  const transport = new RecordingTransport([])
  await fetchAndIngest({ job_id: 'job-1', limit: 20 }, deps(transport))
  assert.equal(transport.listInputs.length, 1)
  assert.equal(transport.listInputs[0]!.since_days, 7)
  assert.equal(transport.listInputs[0]!.since_uid, 0)
})

test('窗口内一封都没有 → total=0 但 connection=CONNECTED（不报错）', async () => {
  // 全部早于 7 天窗口
  const old: MailEnvelope[] = [
    { uid: 1, message_id: 'old-1', subject: 'old', from: 'a@test', date: '2020-01-01T00:00:00Z' },
    { uid: 2, message_id: 'old-2', subject: 'old', from: 'b@test', date: '2020-01-02T00:00:00Z' },
  ]
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 20 }, deps(new RecordingTransport(old)))
  assert.equal(result.total, 0)
  assert.equal(result.connection, 'CONNECTED', '窗口空不是连接失败')
  assert.equal(result.ingested, 0)
  assert.deepEqual(result.results, [])
})

test('假 transport 返回升序旧+新：编排层时间窗第二道防线只放窗口内的（新的）', async () => {
  const mixed: MailEnvelope[] = [
    { uid: 1071, message_id: 'fresh', subject: 'fresh', from: 'a@test', date: '2026-11-18T10:00:00Z' },
    { uid: 5, message_id: 'stale', subject: 'stale', from: 'b@test', date: '2020-01-01T00:00:00Z' },
  ]
  const result = await fetchAndIngest({ job_id: 'job-1', limit: 20 }, deps(new RecordingTransport(mixed)))
  // 时间窗过滤后只处理 fresh（stale 被丢），total 计的是实际处理数。
  assert.ok(result.total <= 1, `窗口外的旧邮件不得进入接入：total=${result.total}`)
  assert.equal(result.connection, 'CONNECTED')
})
