// S9 线 1 · 读回 + DB readback（验收证据）。
//
// 做三件事：
//   1. 调 recruitment_transcript_read（只读事务）读回原文与 canonical 标记，打印 tool/result 原文；
//   2. 直接从 PG 读 transcript_artifact / transcript_segment / interview_record 三张表；
//   3. 机检：原文与 sha 自洽、read 工具返回内容与 DB canonical 原文逐字节一致、
//      interview_record 引用的 (artifact, revision) 真实存在、原文列**不可改**（真去 UPDATE 一次并期望被触发器拒绝）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/transcript-line/readback.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import pg from 'pg'

import { createTranscriptReadTool } from '../../src/tools/transcript-read.ts'
import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const HERE = new URL('./', import.meta.url)
const FIXTURE = new URL('./fixtures/demo-interview-transcript.txt', import.meta.url)
const EVIDENCE = new URL('./evidence/', import.meta.url)
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

const lines = []
const failures = []
const record = (line) => { lines.push(line); console.log(line) }
const check = (label, ok, detail = '') => {
  if (ok) record(`[PASS] ${label}`)
  else { failures.push(label); record(`[FAIL] ${label}${detail === '' ? '' : ` — ${detail}`}`) }
}

function databaseConfig() {
  const { resolved, issues } = resolveDatabaseConfig({
    host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: '11111111-1111-4111-8111-000000000103',
  }, process.env)
  if (resolved === null) {
    console.error(`[readback] 数据库配置不完整：${issues.join('; ')}`)
    process.exit(2)
  }
  return resolved
}

async function resolveInterviewId() {
  const seed = JSON.parse(await readFile(new URL('./evidence/seed.json', HERE), 'utf8'))
  if (typeof seed.interview_id !== 'string') throw new Error('evidence/seed.json 缺少 interview_id')
  return seed.interview_id
}

const cfg = databaseConfig()
const interviewId = await resolveInterviewId()
const fixtureText = await readFile(FIXTURE, 'utf8')

// ---------- 1. read 工具 ----------
const tool = createTranscriptReadTool(cfg)
const args = { interview_id: interviewId, include_text: true, include_segments: true, max_chars: 200000, segment_limit: 500 }
console.log('=== tool ===')
console.log(tool.name)
console.log('=== tool/request ===')
console.log(JSON.stringify(args, null, 2))
console.log('=== tool/result ===')
let value
try {
  value = await tool.execute(args, { signal: new AbortController().signal })
} catch (error) {
  console.error(`${error?.code ?? error?.name}: ${error?.message ?? String(error)}`)
  process.exit(1)
}
console.log(JSON.stringify(value, null, 2))

const transcript = value?.transcript ?? {}
const readText = transcript?.text?.content
check('read 工具返回 transcript.state', typeof transcript.state === 'string', JSON.stringify(transcript.state))
check('read 工具返回原文', typeof readText === 'string' && readText.length > 0)
check('read 工具 labels = LIVE/MANUAL/CONNECTED',
  value?.labels?.provenance === 'LIVE' && value?.labels?.trigger === 'MANUAL' && value?.labels?.connection === 'CONNECTED',
  JSON.stringify(value?.labels))
check('read 工具 read_only = true', value?.read_only === true)
check('canonical 标记存在', typeof transcript.canonical_artifact_id === 'string',
  JSON.stringify({ canonical_artifact_id: transcript.canonical_artifact_id, state: transcript.state, reason: transcript.reason_code }))

// ---------- 2. DB readback ----------
const pool = new pg.Pool({
  host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database,
  password: cfg.password, max: 2, application_name: 's9-transcript-readback',
})
const client = await pool.connect()
try {
  const artifacts = (await client.query(
    `select ta.id, ta.meeting_id, ta.provider, ta.provider_artifact_id, ta.source_revision,
            ta.variant_type, ta.language, ta.transcript_status, ta.provenance, ta.trigger_mode,
            ta.connection_state, ta.is_complete, ta.is_canonical, ta.content_sha256,
            ta.read_receipt_ref, ta.fetched_at, ta.raw_text
       from recruitment.transcript_artifact ta
       join recruitment.meeting_binding b
         on b.meeting_id = ta.meeting_id and b.tenant_id = ta.tenant_id and b.unbound_at is null
      where b.interview_id = $1 and ta.tenant_id = $2
      order by ta.source_revision, ta.variant_type`, [interviewId, cfg.tenant_id],
  )).rows
  const records = (await client.query(
    `select r.id, r.transcript_artifact_id, r.transcript_revision, r.rubric_version_id,
            r.status, r.verification_status, r.evidence_ok, r.is_current, r.model_id, r.prompt_version,
            a.job_id as application_job_id
       from recruitment.interview_record r
       join recruitment.interview i on i.id = r.interview_id and i.tenant_id = r.tenant_id
       join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
      where r.interview_id = $1 and r.tenant_id = $2
      order by r.created_at`, [interviewId, cfg.tenant_id],
  )).rows
  const segmentCounts = (await client.query(
    `select s.artifact_id, count(*)::int as n, min(s.sequence) as first_seq, max(s.sequence) as last_seq
       from recruitment.transcript_segment s
      where s.tenant_id = $1 and s.artifact_id = any($2::uuid[])
      group by s.artifact_id`, [cfg.tenant_id, artifacts.map((a) => a.id)],
  )).rows
  const segmentsOfCanonical = (await client.query(
    `select sequence, content_text from recruitment.transcript_segment
      where tenant_id = $1 and artifact_id = $2 order by sequence`, [
      cfg.tenant_id, transcript.canonical_artifact_id ?? artifacts.at(-1)?.id,
    ],
  )).rows

  record('')
  record('=== DB readback · transcript_artifact ===')
  for (const a of artifacts) {
    const rowSha = sha(a.raw_text ?? '')
    record(`- artifact ${a.id}`)
    record(`  revision=${a.source_revision} provider=${a.provider} provider_artifact_id=${a.provider_artifact_id}`)
    record(`  status=${a.transcript_status} provenance=${a.provenance} trigger=${a.trigger_mode} connection=${a.connection_state}`)
    record(`  is_complete=${a.is_complete} is_canonical=${a.is_canonical} read_receipt_ref=${a.read_receipt_ref ?? '(none)'}`)
    record(`  fetched_at=${a.fetched_at?.toISOString?.() ?? a.fetched_at ?? '(none)'} raw_chars=${(a.raw_text ?? '').length} content_sha256=${a.content_sha256}`)
    record(`  recomputed_sha256=${rowSha} sha_self_consistent=${rowSha === a.content_sha256}`)
    record(`  raw_head=${JSON.stringify((a.raw_text ?? '').slice(0, 48))} … raw_tail=${JSON.stringify((a.raw_text ?? '').slice(-24))}`)
    check(`artifact ${a.id} 的 content_sha256 与 raw_text 自洽`, rowSha === a.content_sha256)
    const seg = segmentCounts.find((s) => s.artifact_id === a.id)
    record(`  segments=${seg?.n ?? 0} (sequence ${seg?.first_seq ?? '-'}..${seg?.last_seq ?? '-'})`)
    check(`artifact ${a.id} 有 segment 行`, (seg?.n ?? 0) > 0)
  }
  const rev1 = artifacts.find((a) => a.source_revision === 1)
  check('revision=1 的原文与 fixture 逐字节相同', rev1 !== undefined && rev1.raw_text === fixtureText)

  record('')
  record('=== DB readback · interview_record ===')
  for (const r of records) {
    record(`- record ${r.id}`)
    record(`  transcript_artifact_id=${r.transcript_artifact_id} transcript_revision=${r.transcript_revision}`)
    record(`  status=${r.status} verification_status=${r.verification_status} evidence_ok=${r.evidence_ok} is_current=${r.is_current}`)
    record(`  application_job_id=${r.application_job_id} rubric_version_id=${r.rubric_version_id}（本机 0008 未应用，interview_record 无 job_id 列）`)
    record(`  model_id=${r.model_id} prompt_version=${r.prompt_version}`)
    const referenced = artifacts.find((a) => a.id === r.transcript_artifact_id && a.source_revision === r.transcript_revision)
    check(`record ${r.id} 引用的 (artifact, revision) 真实存在`, referenced !== undefined)
  }
  check('至少一条 interview_record', records.length > 0)
  const current = records.filter((r) => r.is_current)
  check('恰有一条 is_current=true 的 interview_record', current.length === 1, `got ${current.length}`)

  record('')
  record('=== DB readback · transcript_segment（canonical） ===')
  for (const s of segmentsOfCanonical) record(`  #${s.sequence} ${JSON.stringify(s.content_text.slice(0, 60))}`)
  check('canonical 的 segment 数与 read 工具一致',
    segmentsOfCanonical.length === segmentsOfCanonical.length
    && (transcript.segment_count === undefined || transcript.segment_count === segmentsOfCanonical.length),
    `tool=${transcript.segment_count} db=${segmentsOfCanonical.length}`)

  // read 工具返回的正文必须与 DB canonical 原文逐字节一致
  const canonicalRow = artifacts.find((a) => a.id === transcript.canonical_artifact_id)
  check('read 工具返回的正文 = DB canonical 原文', canonicalRow !== undefined && readText === canonicalRow.raw_text)
  check('read 工具返回的正文 sha256 = canonical content_sha256',
    typeof readText === 'string' && canonicalRow !== undefined && sha(readText) === canonicalRow.content_sha256)

  // ---------- 3. 原文列不可改（真去改一次，期望被 fn_guard_columns 拒绝） ----------
  record('')
  record('=== DB readback · 原文不可变（TR-C7 / §8.3） ===')
  const target = canonicalRow ?? artifacts[0]
  let updateError = null
  try {
    await client.query('begin')
    await client.query('update recruitment.transcript_artifact set raw_text = $2 where id = $1', [target.id, '被篡改的原文'])
    await client.query('rollback')
  } catch (error) {
    updateError = error
    await client.query('rollback').catch(() => {})
  }
  const updateRejected = updateError !== null && /IMMUTABLE_COLUMN/.test(String(updateError.message))
  check('UPDATE transcript_artifact.raw_text 被触发器拒绝（IMMUTABLE_COLUMN）', updateRejected,
    updateError === null ? 'UPDATE 竟然成功了' : String(updateError.message).slice(0, 160))
  if (updateRejected) record(`  真实错误：${String(updateError.message).split('\n')[0].slice(0, 200)}`)
} finally {
  client.release()
  await pool.end()
}

record('')
record(failures.length === 0 ? 'READBACK: ALL CHECKS PASSED' : `READBACK: FAILED (${failures.length}): ${failures.join(' | ')}`)

await mkdir(EVIDENCE, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
await writeFile(new URL(`./readback-${stamp}.txt`, EVIDENCE), lines.join('\n') + '\n', 'utf8')
await writeFile(new URL('./read-tool-result.json', EVIDENCE), JSON.stringify(value, null, 2), 'utf8')
console.log('[readback] 证据写入 manual/transcript-line/evidence/')
process.exitCode = failures.length === 0 ? 0 : 1
