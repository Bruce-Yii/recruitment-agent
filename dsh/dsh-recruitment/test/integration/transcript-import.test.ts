// S9 转写导入（**连真库** ra_s6s7，每个用例结束回滚）。
//
// 覆盖 `manual/transcript-line/README.md` §2 与 `transcript-rules.md` 的可机检项：
//   * 首次 INSERT 就带全内容 + 终态 READY（P-2 / TR-C7 / TR-C8）；
//   * 三维标签不撒谎（FIXTURE/MANUAL/NOT_CONNECTED；LIVE 只给 PLATFORM_EXPORT + 文件名）；
//   * 同内容重导 → 一行不写（TR-U8）；内容变了 → 新 revision + canonical 迁移（TR-U7/U9）；
//   * 旧 `interview_record` 永不改写、新记录引用新 revision（TR-U10）；无 rubric 不建记录（TR-E4）；
//   * 没有 active 绑定会议 → `NO_MEETING_BOUND` 且**零写入**。
//
// 纪律：夹具与工具调用在**同一个未提交事务**里（`inRolledBackTx`），结束一律 ROLLBACK
// —— `ra_s6s7` 的历史事实表禁删（`trg_*_no_delete`），"先 commit 再删"这条路根本不存在。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { importTranscriptInTransaction } from '../../src/tools/transcript-import.ts'
import {
  createFeishuMinutesAdapter,
  createLarkCliTransport,
  createProcessCliRunner,
  type FeishuConnectorDependency,
} from '../../src/connectors/feishu/index.ts'
import {
  createTestPool, errorBody, hex64, inRolledBackTx, seedScenario, testDatabaseConfig,
  TENANT, HR_ACTOR, uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')
/** 假 Lark CLI（真实子进程）：只回放固定 JSON，不是 lark-cli，也不发任何网络请求。 */
const FAKE_LARK_CLI = join(PLUGIN_DIR, 'test', 'fixtures', 'feishu', 'fake-lark-cli.mjs')
/** 假凭据（不是真实飞书凭据）：只为让适配器走到「传输层」这一环。 */
const FAKE_FEISHU_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}
/** 与 `fake-lark-cli.mjs` 的 `single` 场景逐字一致（用来核对落库字节）。 */
const FAKE_LINE_1 = '面试官：请先介绍一下你最近三年做过的项目，重点讲你负责的部分和遇到的困难。'
const FAKE_LINE_2 = '候选人：我主要负责订单链路的稳定性，把超时率从百分之三降到千分之二，做法是加熔断和分级降级。'

/**
 * 装配一个「配置层给出的」连接器依赖：真实 `lark-cli-transport` + 真实子进程 +
 * `test/fixtures/feishu/fake-lark-cli.mjs`。它读到的字节永远只能标 FIXTURE
 * （Live Gate=BLOCKED，`readback.transport=FIXTURE`）。
 */
function fixtureConnector(scenario = 'single'): FeishuConnectorDependency {
  const runner = createProcessCliRunner({
    command: process.execPath,
    extra_args: [FAKE_LARK_CLI],
    env: { ...process.env, FAKE_LARK_CLI_SCENARIO: scenario },
    timeout_ms: 30_000,
  })
  const transport = createLarkCliTransport({ runner, max_attempts: 1, retry_base_ms: 0, timeout_ms: 30_000 })
  const adapter = createFeishuMinutesAdapter({ env: FAKE_FEISHU_ENV, transport })
  return { adapter, transport_configured: true }
}

test.after(async () => {
  await pool.end()
})

/** 一条硬性维度（只为让 rubric 合法，导入路径不读它）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/** 一轮夹具：面试 + 若干会议 + 各自 active 绑定。 */
interface InterviewFixture {
  readonly interviewId: string
  readonly applicationId: string
  readonly meetingIds: readonly string[]
  /** 与 `meetingIds` 一一对应的平台会议 id（连接器回读按它消歧）。 */
  readonly externalMeetingIds: readonly string[]
}

/**
 * 造"面试 + 会议 + 绑定"（给 `seedScenario` 之后的同一个 client 用）。
 * @param client - 事务内客户端。
 * @param applicationId - 已造好的申请。
 * @param options - 会议角色列表 / 计划时间 / 平台名 / 是否绑成 MANUAL。
 */
async function seedInterview(
  client: DatabaseClient,
  applicationId: string,
  options: {
    readonly roles?: readonly string[]
    readonly scheduledStart?: Date
    readonly scheduledEnd?: Date
    readonly actualStart?: Date
    readonly actualEnd?: Date
    /** 会议平台名，默认 FEISHU（连接器回读要求 FEISHU，其它值会被拒）。 */
    readonly provider?: string
  } = {},
): Promise<InterviewFixture> {
  const roles = options.roles ?? ['PRIMARY']
  const scheduledStart = options.scheduledStart ?? new Date(Date.now() - 120 * 60_000)
  const scheduledEnd = options.scheduledEnd ?? new Date(Date.now() - 60 * 60_000)
  const provider = options.provider ?? 'FEISHU'
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at)
     values ($1, $2, 1, 'DEFAULT', 'S9', 'POST_INTERVIEW', $3, $4)
     returning id`,
    [TENANT, applicationId, scheduledStart, scheduledEnd],
  )
  const interviewId = (rows[0] as { id: string }).id
  const meetingIds: string[] = []
  const externalMeetingIds: string[] = []
  for (const role of roles) {
    const externalMeetingId = `mtg-${uniqueSuffix()}`
    const meeting = await client.query<{ id: string }>(
      `insert into recruitment.meeting
         (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [
        TENANT,
        provider,
        externalMeetingId,
        role,
        options.actualStart ?? (role === 'PRIMARY' ? scheduledStart : null),
        options.actualEnd ?? (role === 'PRIMARY' ? scheduledEnd : null),
      ],
    )
    const meetingId = (meeting.rows[0] as { id: string }).id
    meetingIds.push(meetingId)
    externalMeetingIds.push(externalMeetingId)
    await client.query(
      `insert into recruitment.meeting_binding
         (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
       values ($1, $2, $3, 'MANUAL', $4)`,
      [TENANT, meetingId, interviewId, HR_ACTOR],
    )
  }
  return { interviewId, applicationId, meetingIds, externalMeetingIds }
}

/** 该会议/面试下三类行的现有数量（"零写入"的证明用）。 */
async function countsFor(
  client: DatabaseClient,
  meetingIds: readonly string[],
  interviewId: string,
): Promise<{ artifacts: number; segments: number; records: number }> {
  const artifacts = await client.query<{ n: string }>(
    'select count(*) as n from recruitment.transcript_artifact where tenant_id = $1 and meeting_id = any($2::uuid[])',
    [TENANT, [...meetingIds]],
  )
  const segments = await client.query<{ n: string }>(
    `select count(*) as n from recruitment.transcript_segment s
       join recruitment.transcript_artifact a on a.id = s.artifact_id and a.tenant_id = s.tenant_id
      where s.tenant_id = $1 and a.meeting_id = any($2::uuid[])`,
    [TENANT, [...meetingIds]],
  )
  const records = await client.query<{ n: string }>(
    'select count(*) as n from recruitment.interview_record where tenant_id = $1 and interview_id = $2',
    [TENANT, interviewId],
  )
  return {
    artifacts: Number(artifacts.rows[0]?.n ?? 0),
    segments: Number(segments.rows[0]?.n ?? 0),
    records: Number(records.rows[0]?.n ?? 0),
  }
}

test('DEMO_SAMPLE 首次导入：一次 INSERT 带全内容，READY + FIXTURE/MANUAL/NOT_CONNECTED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '00:00 面试官：请介绍一下最近的项目\n00:12 候选人：做了招聘系统\n\n00:30 面试官：为什么离开'
    const expectedSha = createHash('sha256').update(content, 'utf8').digest('hex')

    // 用同一个事务里的 client（actor 已由 `inRolledBackTx` 的 set_config 设好）。
    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      content,
      source_kind: 'DEMO_SAMPLE',
    }, Date.now())

    // ---- 出参：三维标签精确相等（断言闭合规则，不是"包含"）----
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.equal(value.replayed, false)
    assert.equal(value.write, true)
    assert.equal(value.provenance_basis, 'DEMO_SAMPLE_NO_PLATFORM_RECEIPT')
    assert.ok(value.warnings.some((warning) => warning.code === 'FIXTURE_CONTENT_NOT_LIVE'))
    assert.equal(value.artifact.transcript_status, 'READY')
    assert.equal(value.artifact.source_revision, 1)
    assert.equal(value.artifact.is_canonical, true)
    assert.equal(value.artifact.content_sha256, expectedSha)
    assert.equal(value.artifact.char_count, content.length)
    assert.equal(value.record?.status, 'NEEDS_REVIEW')
    assert.equal(value.record?.verification_status, 'UNVERIFIED')
    assert.equal(value.record?.transcript_revision, 1)
    assert.equal(value.record?.is_current, true)

    // ---- DB 读回：artifact 的不可变列逐条核对 ----
    const artifact = (await client.query<Record<string, unknown>>(
      `select id, meeting_id, tenant_id, provider, provider_artifact_id, source_revision, variant_type,
              language, transcript_status, provenance, trigger_mode, connection_state, content_sha256,
              raw_text, is_complete, has_more, is_canonical, page_count, source_generated_at,
              canonical_selected_by_actor_id, fetched_at
         from recruitment.transcript_artifact where id = $1`,
      [value.artifact.id],
    )).rows[0] as Record<string, unknown>
    assert.equal(artifact.meeting_id, fixture.meetingIds[0])
    assert.equal(artifact.transcript_status, 'READY')
    assert.equal(artifact.is_complete, true)
    assert.equal(artifact.has_more, false)
    assert.equal(artifact.content_sha256, expectedSha)
    assert.equal(artifact.raw_text, content)
    // 逐字节（UTF-8）相等，不只是"字符串看起来一样"
    assert.ok(Buffer.from(artifact.raw_text as string, 'utf8').equals(Buffer.from(content, 'utf8')))
    assert.equal(artifact.provenance, 'FIXTURE')
    assert.equal(artifact.trigger_mode, 'MANUAL')
    assert.equal(artifact.connection_state, 'NOT_CONNECTED')
    assert.equal(artifact.provider, 'LOCAL_DEMO')
    assert.equal(artifact.provider_artifact_id, `local:demo-sample:${fixture.meetingIds[0]}`)
    assert.equal(artifact.source_revision, 1)
    assert.equal(artifact.variant_type, 'ORIGINAL')
    assert.equal(artifact.language, 'zh')
    assert.equal(artifact.is_canonical, true)
    assert.equal(artifact.canonical_selected_by_actor_id, HR_ACTOR)
    // 平台没给的字段保持缺失（TR-S8 / docs/04 §21）
    assert.equal(artifact.page_count, null)
    assert.equal(artifact.source_generated_at, null)
    assert.ok(artifact.fetched_at instanceof Date)

    // ---- 片段：行数 = 非空行数，content_text 逐行一致，序号不重排 ----
    const allLines = content.split(/\r?\n/)
    const expectedLines = allLines.filter((line) => line !== '')
    const segments = (await client.query<{ sequence: number; content_text: string; speaker_ref: string | null; speaker_label: string | null; start_ms: string | null; end_ms: string | null; provider_segment_id: string | null; raw_source_ref: string }>(
      `select sequence, content_text, speaker_ref, speaker_label, start_ms, end_ms, provider_segment_id, raw_source_ref
         from recruitment.transcript_segment where artifact_id = $1 order by sequence`,
      [value.artifact.id],
    )).rows
    assert.equal(segments.length, expectedLines.length)
    expectedLines.forEach((line, index) => {
      const row = segments[index]
      assert.ok(row !== undefined)
      assert.equal(row.content_text, line)
      // 平台没给说话人/时间戳 → 全部缺失，不编造
      assert.equal(row.speaker_ref, null)
      assert.equal(row.speaker_label, null)
      assert.equal(row.start_ms, null)
      assert.equal(row.end_ms, null)
      assert.equal(row.provider_segment_id, null)
      assert.equal(row.raw_source_ref, 'manual-import')
    })
    // 序号 = 原行下标（空行跳过但不重排）：第 3 行是空行，所以第三条片段 sequence=3
    assert.deepEqual(segments.map((row) => row.sequence), [0, 1, 3])

    // ---- interview_record：引用具体版本，两条状态轴分开 ----
    const record = (await client.query<Record<string, unknown>>(
      `select r.id, r.interview_id, r.transcript_artifact_id, r.transcript_revision, r.rubric_version_id,
              r.schema_version, r.prompt_version, r.model_id, r.status, r.verification_status,
              r.evidence_ok, r.chunk_coverage, r.is_current, a.job_id as application_job_id
         from recruitment.interview_record r
         join recruitment.interview i on i.id = r.interview_id and i.tenant_id = r.tenant_id
         join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
        where r.id = $1`,
      [value.record?.id],
    )).rows[0] as Record<string, unknown>
    assert.equal(record.transcript_artifact_id, value.artifact.id)
    assert.equal(record.transcript_revision, 1)
    assert.equal(record.rubric_version_id, scenario.rubricId)
    assert.equal(record.schema_version, 1)
    assert.equal(record.prompt_version, 'manual-import/1.0.0')
    assert.equal(record.model_id, 'none:manual-import')
    assert.equal(record.status, 'NEEDS_REVIEW')
    assert.equal(record.verification_status, 'UNVERIFIED')
    assert.equal(record.evidence_ok, true)
    assert.equal(record.is_current, true)
    assert.equal(Number(record.chunk_coverage), 1)
    // 岗位来自 application（本机 interview_record 没有 job_id 列）
    assert.equal(record.application_job_id, scenario.jobId)

    // ---- sections：来源 + 依据 + turns + citations ----
    const sections = (await client.query<{ sections: Record<string, unknown> }>(
      'select sections from recruitment.interview_record where id = $1',
      [value.record?.id],
    )).rows[0]?.sections as {
      schema: string
      source: Record<string, unknown>
      basis: Record<string, unknown>
      turns: { sequence: number; text: string }[]
      citations: { kind: string; sequence: number }[]
    }
    assert.deepEqual(sections.basis, { artifact_id: value.artifact.id, revision: 1 })
    assert.equal(sections.source.kind, 'DEMO_SAMPLE')
    assert.equal(sections.source.sha, expectedSha)
    assert.equal(sections.source.segment_count, expectedLines.length)
    assert.equal(Object.hasOwn(sections.source, 'file'), false, 'DEMO_SAMPLE 不得有导出文件名')
    assert.equal(sections.turns.length, expectedLines.length)
    assert.deepEqual(sections.citations.map((citation) => citation.sequence), sections.turns.map((turn) => turn.sequence))

    // ---- changes：真正插入的行逐条列出 ----
    assert.equal(value.changes.updated.length, 0)
    assert.deepEqual(
      value.changes.created.map((change) => change.table),
      ['transcript_artifact', ...expectedLines.map(() => 'transcript_segment'), 'interview_record'],
    )
    const createdIds = new Set(value.changes.created.map((change) => change.id))
    assert.equal(createdIds.size, value.changes.created.length)
    for (const id of createdIds) assert.match(id, /^[0-9a-f-]{36}$/)
    assert.notEqual(expectedSha, hex64('unrelated'))
  })
})

test('同一内容再导入 → replayed=true、changes 全空、行数不变（TR-U8）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '00:00 面试官：你好\n00:05 候选人：你好'
    const args = { interview_id: fixture.interviewId, content, source_kind: 'DEMO_SAMPLE' }

    const first = await importTranscriptInTransaction(client, cfg, args, Date.now())
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    const second = await importTranscriptInTransaction(client, cfg, args, Date.now())
    const after = await countsFor(client, fixture.meetingIds, fixture.interviewId)

    assert.equal(second.replayed, true)
    assert.deepEqual(second.changes.created, [])
    assert.deepEqual(second.changes.updated, [])
    assert.ok(second.warnings.some((warning) => warning.code === 'REPLAYED_SAME_CONTENT'))
    assert.equal(second.artifact.id, first.artifact.id)
    assert.equal(second.artifact.source_revision, 1)
    assert.equal(second.record?.id, first.record?.id)
    assert.deepEqual(after, before)
  })
})

test('改一个字再导入 → revision=2、旧行保留且非 canonical、旧记录仍指 rev1 且 is_current=false（TR-U7/U9/U10）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '00:00 面试官：你好\n00:05 候选人：你好'

    const first = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, content, source_kind: 'DEMO_SAMPLE',
    }, Date.now())
    const second = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, content: `${content}。`, source_kind: 'DEMO_SAMPLE',
    }, Date.now())

    assert.equal(second.replayed, false)
    assert.equal(second.artifact.source_revision, 2)
    assert.equal(second.artifact.is_canonical, true)
    assert.equal(second.record?.transcript_revision, 2)
    assert.equal(second.record?.is_current, true)

    // 旧行还在，但不再 canonical；旧记录仍指向 rev1，只是不再 current
    const rows = (await client.query<{ id: string; source_revision: number; is_canonical: boolean; raw_text: string }>(
      'select id, source_revision, is_canonical, raw_text from recruitment.transcript_artifact where meeting_id = $1 order by source_revision',
      [fixture.meetingIds[0]],
    )).rows
    assert.equal(rows.length, 2)
    assert.equal(rows[0]?.id, first.artifact.id)
    assert.equal(rows[0]?.is_canonical, false)
    assert.equal(rows[0]?.raw_text, content, '旧 revision 的原文永不改写')
    assert.equal(rows[1]?.id, second.artifact.id)
    assert.equal(rows[1]?.is_canonical, true)
    // 每个 meeting 至多一个 canonical（部分唯一索引的语义）
    assert.equal(rows.filter((row) => row.is_canonical).length, 1)

    const oldRecord = (await client.query<{ transcript_revision: number; transcript_artifact_id: string; is_current: boolean; status: string }>(
      'select transcript_revision, transcript_artifact_id, is_current, status from recruitment.interview_record where id = $1',
      [first.record?.id],
    )).rows[0]
    assert.equal(oldRecord?.transcript_revision, 1)
    assert.equal(oldRecord?.transcript_artifact_id, first.artifact.id)
    assert.equal(oldRecord?.is_current, false)
    assert.equal(oldRecord?.status, 'NEEDS_REVIEW', '旧记录的内容不改写（TR-U10）')

    // changes.updated 只列真正被改的两行
    assert.deepEqual(second.changes.updated, [
      { table: 'transcript_artifact', id: first.artifact.id },
      { table: 'interview_record', id: first.record?.id },
    ])
    // 新记录引用 rev2
    const newRecord = (await client.query<{ transcript_artifact_id: string; transcript_revision: number }>(
      'select transcript_artifact_id, transcript_revision from recruitment.interview_record where id = $1',
      [second.record?.id],
    )).rows[0]
    assert.equal(newRecord?.transcript_artifact_id, second.artifact.id)
    assert.equal(newRecord?.transcript_revision, 2)
  })
})

test('PLATFORM_EXPORT + 文件名 → LIVE/MANUAL/NOT_CONNECTED，回执可核对（TR-S3/S4）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '飞书妙记导出：00:00 面试官：请自我介绍\n00:08 候选人：好的'
    const sha = createHash('sha256').update(content, 'utf8').digest('hex')

    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      content,
      source_kind: 'PLATFORM_EXPORT',
      exported_file_name: '妙记导出-2026-11-13.txt',
    }, Date.now())

    assert.deepEqual(value.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.equal(value.provenance_basis, 'PLATFORM_EXPORT_SELF_DECLARED_RECEIPT')
    assert.ok(value.warnings.some((warning) => warning.code === 'EXPORT_RECEIPT_IS_SELF_DECLARED'))
    const artifact = (await client.query<{ provenance: string; provider: string; read_receipt_ref: string; fetched_at: Date; content_sha256: string }>(
      'select provenance, provider, read_receipt_ref, fetched_at, content_sha256 from recruitment.transcript_artifact where id = $1',
      [value.artifact.id],
    )).rows[0]
    assert.equal(artifact?.provenance, 'LIVE')
    assert.equal(artifact?.provider, 'FEISHU')
    assert.match(artifact?.read_receipt_ref ?? '', new RegExp(`^upload:${HR_ACTOR}:sha256:[0-9a-f]{64};file=`))
    assert.ok((artifact?.read_receipt_ref ?? '').endsWith(';file=妙记导出-2026-11-13.txt'))
    assert.equal(artifact?.content_sha256, sha)
    assert.ok(artifact?.fetched_at instanceof Date, 'LIVE 必须有 fetched_at（ck_transcript_artifact_live_receipt）')
  })
})

test('PLATFORM_EXPORT 不带文件名 → INVALID_ARGS(EXPORT_FILE_NAME_REQUIRED) 且零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        content: '随便一段',
        source_kind: 'PLATFORM_EXPORT',
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'EXPORT_FILE_NAME_REQUIRED')
        return true
      },
    )
    assert.deepEqual(await countsFor(client, fixture.meetingIds, fixture.interviewId), before)
  })
})

test('没有 active 绑定会议 → NO_MEETING_BOUND 且零写入（TR-D 序 1 的写侧前提）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { roles: [] })
    // 再绑一个 REPLACED 的会议：它在 M(i) 之外（TR-D4），不得被当成可导入的会议。
    const replaced = (await client.query<{ id: string }>(
      `insert into recruitment.meeting
         (tenant_id, provider, external_meeting_id, meeting_role)
       values ($1, 'FEISHU', $2, 'REPLACED') returning id`,
      [TENANT, `mtg-${uniqueSuffix()}`],
    )).rows[0] as { id: string }
    await client.query(
      `insert into recruitment.meeting_binding
         (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
       values ($1, $2, $3, 'MANUAL', $4)`,
      [TENANT, replaced.id, fixture.interviewId, HR_ACTOR],
    )
    const meetingIds = [replaced.id]
    const before = await countsFor(client, meetingIds, fixture.interviewId)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        content: '不该落库的一段',
        source_kind: 'DEMO_SAMPLE',
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NO_MEETING_BOUND')
        assert.equal(body.reason_code, 'NO_MEETING_BOUND')
        const detail = body.detail as Record<string, unknown>
        assert.equal(detail.interview_id, fixture.interviewId)
        assert.equal(detail.meeting_count, 0)
        assert.equal(typeof detail.hint, 'string')
        return true
      },
    )
    assert.deepEqual(await countsFor(client, meetingIds, fixture.interviewId), before)
  })
})

test('多会议绑同一场面试：不给 meeting_id → AMBIGUOUS_MEETING；给了 → 精确落到该会议', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { roles: ['PRIMARY', 'CONTINUATION'] })
    const content = '00:00 面试官：继续刚才的话题'

    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId, content, source_kind: 'DEMO_SAMPLE',
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'AMBIGUOUS_MEETING')
        const detail = body.detail as { meeting_count: number; candidates: { meeting_id: string }[] }
        assert.equal(detail.meeting_count, 2)
        assert.equal(detail.candidates.length, 2)
        return true
      },
    )
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    assert.deepEqual(before, { artifacts: 0, segments: 0, records: 0 })

    const continuation = fixture.meetingIds[1] as string
    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, content, source_kind: 'DEMO_SAMPLE', meeting_id: continuation,
    }, Date.now())
    assert.equal(value.meeting.id, continuation)
    assert.equal(value.meeting.meeting_role, 'CONTINUATION')
    assert.equal((await countsFor(client, fixture.meetingIds, fixture.interviewId)).artifacts, 1)

    // 不属于 active 绑定的 meeting_id → NOT_FOUND(MEETING_NOT_FOUND)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        content: '另一段',
        source_kind: 'DEMO_SAMPLE',
        meeting_id: '11111111-1111-4111-8111-00000000dead',
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'MEETING_NOT_FOUND')
        return true
      },
    )
  })
})

test('申请没钉评分标准 → 不建 interview_record、artifact 照常落库 + RECORD_NOT_CREATED_NO_RUBRIC（TR-E4）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS, pinRubric: false })
    const fixture = await seedInterview(client, scenario.applicationId)
    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      content: '00:00 面试官：简单聊聊',
      source_kind: 'DEMO_SAMPLE',
    }, Date.now())

    assert.equal(Object.hasOwn(value, 'record'), false, '没有 record 时省略键，不写 null')
    assert.ok(value.warnings.some((warning) => warning.code === 'RECORD_NOT_CREATED_NO_RUBRIC'))
    assert.equal(value.artifact.transcript_status, 'READY')
    const counts = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    assert.deepEqual(counts, { artifacts: 1, segments: 1, records: 0 })
    assert.equal(value.changes.created.filter((change) => change.table === 'interview_record').length, 0)
  })
})

test('未知面试 → NOT_FOUND(INTERVIEW_NOT_FOUND)；入参校验失败不建连（execute 路径）', async () => {
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: '11111111-1111-4111-8111-00000000beef',
        content: 'x',
        source_kind: 'DEMO_SAMPLE',
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'INTERVIEW_NOT_FOUND')
        return true
      },
    )
  })
})

// ---------------------------------------------------------------------------
// 飞书连接器回读路径（E4 接线）：blocked 零写入 / fake transport 成功但只标 FIXTURE
// ---------------------------------------------------------------------------

/** 该 token 在全库任何 artifact 里出现的次数（"零写入"的更强证明，不只看本会议）。 */
async function artifactsMentioning(client: DatabaseClient, needle: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from recruitment.transcript_artifact
      where provider_artifact_id = $1 or read_receipt_ref like $2`,
    [`local:feishu-minutes:${needle}`, `lark:minutes+detail:${needle}@%`],
  )
  return Number(rows[0]?.n ?? 0)
}

test('连接器回读无传输层 → BLOCKED/TRANSPORT_NOT_CONFIGURED，零 artifact 落库（表行数前后一致）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    assert.deepEqual(before, { artifacts: 0, segments: 0, records: 0 })

    await assert.rejects(
      // 不给第 5 个参数 = 没装配连接器（默认态，与 src/index.ts 不给 feishu.cli 时一致）。
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        minute_token: 'mt_fixture_blocked',
      }, undefined),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'BLOCKED')
        assert.equal(body.reason_code, 'TRANSPORT_NOT_CONFIGURED')
        const detail = body.detail as Record<string, unknown>
        assert.equal(detail.transport_configured, false)
        assert.equal(detail.creates_artifact, false)
        assert.equal(detail.blocked_reason, 'TRANSPORT_NOT_CONFIGURED')
        assert.equal(JSON.stringify(body).includes('mt_fixture_blocked'), false, '不得回声 minute_token')
        return true
      },
    )

    const after = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    assert.deepEqual(after, before, 'BLOCKED 之后表行数必须完全不变（零 artifact / 零 segment / 零 record）')
    assert.equal(await artifactsMentioning(client, 'mt_fixture_blocked'), 0)
  })
})

test('连接器回读（fake lark-cli 真实子进程）读成功：落库行带诚实标签 FIXTURE/MANUAL/AUTH_REQUIRED，绝不是 LIVE', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const expectedText = `${FAKE_LINE_1}\n${FAKE_LINE_2}`
    const expectedSha = createHash('sha256').update(expectedText, 'utf8').digest('hex')
    const connector = fixtureConnector('single')

    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      minute_token: 'mt_fixture_read',
    }, undefined, { connector })

    // ---- 出参：三维标签诚实（不是 LIVE / 不是 CONNECTED）----
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'AUTH_REQUIRED' })
    assert.equal(value.provenance_basis, 'FEISHU_READBACK_NO_LIVE_GATE')
    assert.equal(value.replayed, false)
    assert.ok(value.warnings.some((warning) => warning.code === 'FEISHU_READBACK_NOT_LIVE'))
    assert.ok(value.warnings.some((warning) => warning.code === 'FEISHU_CONNECTION_AUTH_REQUIRED'))
    assert.equal(value.artifact.provider, 'FEISHU')
    assert.equal(value.artifact.provider_artifact_id, 'local:feishu-minutes:mt_fixture_read')
    assert.equal(value.artifact.provenance, 'FIXTURE')
    assert.equal(value.artifact.trigger_mode, 'MANUAL')
    assert.equal(value.artifact.connection_state, 'AUTH_REQUIRED')
    assert.equal(value.artifact.content_sha256, expectedSha)
    assert.equal(value.artifact.char_count, expectedText.length)
    assert.equal(value.artifact.segment_count, 2)
    assert.equal(value.artifact.transcript_status, 'READY')
    assert.equal(value.record?.status, 'NEEDS_REVIEW')

    // ---- DB 读回：原文逐字节相等；连接标注不是 CONNECTED ----
    const artifact = (await client.query<Record<string, unknown>>(
      `select id, meeting_id, provider, provider_artifact_id, source_revision, transcript_status,
              provenance, trigger_mode, connection_state, read_receipt_ref, content_sha256,
              raw_text, is_complete, has_more, is_canonical
         from recruitment.transcript_artifact where id = $1`,
      [value.artifact.id],
    )).rows[0] as Record<string, unknown>
    assert.equal(artifact.meeting_id, fixture.meetingIds[0])
    assert.equal(artifact.provider, 'FEISHU')
    assert.equal(artifact.raw_text, expectedText)
    assert.ok(Buffer.from(artifact.raw_text as string, 'utf8').equals(Buffer.from(expectedText, 'utf8')))
    assert.equal(artifact.content_sha256, expectedSha)
    assert.equal(artifact.provenance, 'FIXTURE', 'fake CLI 读到的字节永远不是 LIVE')
    assert.equal(artifact.trigger_mode, 'MANUAL')
    assert.equal(artifact.connection_state, 'AUTH_REQUIRED')
    assert.equal(artifact.is_complete, true)
    // 回执来自传输层（lark:...），但 provenance=FIXTURE 表明没被当成平台已核实来源。
    assert.match(String(artifact.read_receipt_ref), /^lark:minutes\+detail:mt_fixture_read@\d+$/)
    assert.equal(artifact.id, value.artifact.id)

    const segments = (await client.query<{ sequence: number; content_text: string; raw_source_ref: string | null }>(
      'select sequence, content_text, raw_source_ref from recruitment.transcript_segment where artifact_id = $1 order by sequence',
      [value.artifact.id],
    )).rows
    assert.equal(segments.length, 2)
    assert.equal(segments[0]?.content_text, FAKE_LINE_1)
    assert.equal(segments[1]?.content_text, FAKE_LINE_2)
    assert.equal(segments[0]?.raw_source_ref, 'feishu-connector-readback')

    const record = (await client.query<Record<string, unknown>>(
      'select model_id, prompt_version, status, sections from recruitment.interview_record where id = $1',
      [value.record?.id],
    )).rows[0] as Record<string, unknown>
    assert.equal(record.model_id, 'none:connector-readback')
    assert.equal(record.prompt_version, 'connector-readback/1.0.0')
    assert.equal(record.status, 'NEEDS_REVIEW')
    const sections = record.sections as { schema: string; source: Record<string, unknown> }
    assert.equal(sections.schema, 'feishu-connector-readback.sections/1')
    assert.equal(sections.source.kind, 'FEISHU_CONNECTOR_READBACK')
    assert.equal(sections.source.transport, 'FIXTURE', '回读对象的 transport 必须是 FIXTURE（Gate=BLOCKED）')
    assert.equal(sections.source.read_receipt_ref, artifact.read_receipt_ref)

    // ---- 同一内容重导 → replayed=true，一行都不写（TR-U8）----
    const beforeReplay = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    const replay = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      minute_token: 'mt_fixture_read',
    }, undefined, { connector })
    assert.equal(replay.replayed, true)
    assert.deepEqual(replay.labels, value.labels, 'replay 回显既有行标签，不因本次入参升级')
    assert.equal(replay.provenance_basis, 'FEISHU_READBACK_NO_LIVE_GATE')
    assert.ok(replay.warnings.some((warning) => warning.code === 'FEISHU_READBACK_NOT_LIVE'))
    assert.deepEqual(await countsFor(client, fixture.meetingIds, fixture.interviewId), beforeReplay)
  })
})

test('连接器回读按 external_meeting_id 消歧：落到 CONTINUATION 会议；不匹配 → NOT_FOUND 且零新增', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { roles: ['PRIMARY', 'CONTINUATION'] })
    const connector = fixtureConnector('single')
    const continuation = fixture.meetingIds[1] as string

    const value = await importTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId,
      minute_token: 'mt_fixture_ext',
      external_meeting_id: fixture.externalMeetingIds[1],
    }, undefined, { connector })
    assert.equal(value.meeting.id, continuation, '必须按平台会议 id 精确落到 CONTINUATION 会议')
    assert.equal(value.meeting.meeting_role, 'CONTINUATION')
    assert.equal(value.labels.provenance, 'FIXTURE')

    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    assert.equal(before.artifacts, 1)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        minute_token: 'mt_fixture_ext_mismatch',
        external_meeting_id: 'no-such-external-meeting-id',
      }, undefined, { connector }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'MEETING_NOT_FOUND')
        return true
      },
    )
    assert.deepEqual(await countsFor(client, fixture.meetingIds, fixture.interviewId), before, '不匹配时零新增')
    assert.equal(await artifactsMentioning(client, 'mt_fixture_ext_mismatch'), 0)
  })
})

test('连接器回读取到的会议不是飞书 → INVALID_ARGS(SOURCE_CONNECTOR_MISMATCH)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { provider: 'ZOOM' })
    const connector = fixtureConnector('single')
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        minute_token: 'mt_fixture_zoom',
      }, undefined, { connector }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'SOURCE_CONNECTOR_MISMATCH')
        return true
      },
    )
    assert.deepEqual(await countsFor(client, fixture.meetingIds, fixture.interviewId), before)
    assert.equal(await artifactsMentioning(client, 'mt_fixture_zoom'), 0)
  })
})

test('平台 2091003（生成中）→ BLOCKED/PROVIDER_GENERATING，零 artifact（不是失败，但本次无正文）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const connector = fixtureConnector('generating')
    const before = await countsFor(client, fixture.meetingIds, fixture.interviewId)
    await assert.rejects(
      async () => importTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        minute_token: 'mt_fixture_generating',
      }, undefined, { connector }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'BLOCKED')
        assert.equal(body.reason_code, 'PROVIDER_GENERATING')
        const detail = body.detail as Record<string, unknown>
        assert.equal(detail.task_state, 'WAITING_EXTERNAL')
        assert.equal(detail.provider_code, '2091003')
        assert.equal(detail.creates_artifact, false)
        return true
      },
    )
    assert.deepEqual(await countsFor(client, fixture.meetingIds, fixture.interviewId), before)
    assert.equal(await artifactsMentioning(client, 'mt_fixture_generating'), 0)
  })
})
