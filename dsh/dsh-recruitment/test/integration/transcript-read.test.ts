// S9 转写读取（**连真库** ra_s6s7，每个用例结束回滚）。
//
// 覆盖 `transcript-rules.md` §4/§5 的派生规则与 `manual/transcript-line/README.md` §3.2 的出参：
//   * 七条派生规则的端到端表现（READY / MISSING(NO_MEETING_BOUND) / PENDING(WAITING) /
//     MISSING(NO_ARTIFACT_AFTER_WAIT) / READY(READY_NO_CANONICAL)）；
//   * `wait_minutes` 的 business_config 覆盖；
//   * 正文逐字节相等 + 分页拼回原文（PG 字符口径）；
//   * 片段分页、artifact 过滤（非 canonical 的警告）、record 状态另一条轴；
//   * INVALID_ARGS 的 reason_code 封闭集（as_of 未来 / 无偏移 / 未知参数 / tenant_id / 非 UUID）。
//
// 纪律同 import：夹具与读取在同一个未提交事务里，结束一律 ROLLBACK。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { createTranscriptReadTool, readTranscriptInTransaction } from '../../src/tools/transcript-read.ts'
import {
  createTestPool, errorBody, hex64, inRolledBackTx, seedScenario, testDatabaseConfig,
  TENANT, HR_ACTOR, uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/** 一轮夹具：面试 + 会议 + 绑定。 */
interface Fixture {
  readonly interviewId: string
  readonly meetingId: string
}

/**
 * 造"面试 + 一个 PRIMARY 会议 + MANUAL 绑定"。
 * @param client - 事务内客户端。
 * @param applicationId - 已造好的申请。
 * @param options - 计划/实际时间、角色、是否真的建会议。
 */
async function seedInterview(
  client: DatabaseClient,
  applicationId: string,
  options: {
    readonly scheduledStart?: Date
    readonly scheduledEnd?: Date
    readonly actualStart?: Date
    readonly actualEnd?: Date
    readonly role?: string
    readonly schedule?: boolean
    /** 同一申请下再造一场（`uq_interview_slot` = application × round × slot）。 */
    readonly roundNo?: number
  } = {},
): Promise<Fixture> {
  const scheduledStart = options.scheduledStart ?? new Date(Date.now() - 120 * 60_000)
  const scheduledEnd = options.scheduledEnd ?? new Date(Date.now() - 60 * 60_000)
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at)
     values ($1, $2, $3, 'DEFAULT', 'S9', 'POST_INTERVIEW', $4, $5)
     returning id`,
    [TENANT, applicationId, options.roundNo ?? 1, scheduledStart, scheduledEnd],
  )
  const interviewId = (rows[0] as { id: string }).id
  if (options.schedule === false) return { interviewId, meetingId: '' }
  const meeting = await client.query<{ id: string }>(
    `insert into recruitment.meeting
       (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
     values ($1, 'FEISHU', $2, $3, $4, $5)
     returning id`,
    [
      TENANT,
      `mtg-${uniqueSuffix()}`,
      options.role ?? 'PRIMARY',
      options.actualStart ?? scheduledStart,
      options.actualEnd ?? scheduledEnd,
    ],
  )
  const meetingId = (meeting.rows[0] as { id: string }).id
  await client.query(
    `insert into recruitment.meeting_binding
       (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
     values ($1, $2, $3, 'MANUAL', $4)`,
    [TENANT, meetingId, interviewId, HR_ACTOR],
  )
  return { interviewId, meetingId }
}

/** 导入一段转写（读用例的前置；走真实写路径，不手搓行）。 */
async function importContent(
  client: DatabaseClient,
  interviewId: string,
  content: string,
  kind: 'DEMO_SAMPLE' | 'PLATFORM_EXPORT' = 'DEMO_SAMPLE',
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { importTranscriptInTransaction } = await import('../../src/tools/transcript-import.ts')
  return await importTranscriptInTransaction(client, cfg, {
    interview_id: interviewId,
    content,
    source_kind: kind,
    ...(kind === 'PLATFORM_EXPORT' ? { exported_file_name: '导出.txt' } : {}),
    ...extra,
  }, Date.now()) as unknown as Record<string, unknown>
}

test('READY / CANONICAL_STATUS：正文逐字节相等、分页能拼回原文、片段与 record 各自回显', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '00:00 面试官：请自我介绍\n00:08 候选人：好的，我做过招聘系统\n00:20 面试官：说说难点'
    const imported = await importContent(client, fixture.interviewId, content)

    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    // R4（`contracts/tenant-provenance.md` §2）：夹具在演示租户里 ⇒ 顶层 provenance=FIXTURE。
    // 旧断言写 LIVE，和下面"每条产物都是 FIXTURE"自相矛盾（同一个响应两套真假）。
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' })
    const transcript = value.transcript as Record<string, unknown> & {
      state: string
      reason_code: string
      canonical_artifact_id: string
      canonical_revision: number
      artifact_count: number
      artifacts: Record<string, unknown>[]
      text: { content: string; total_chars: number; offset: number; length: number; has_more: boolean; artifact_id: string }
      record: { status: string; transcript_revision: number; is_current: boolean }
      wait_minutes: number
    }
    assert.equal(transcript.state, 'READY')
    assert.equal(transcript.reason_code, 'CANONICAL_STATUS')
    assert.equal(transcript.wait_minutes, 120)
    assert.equal(transcript.artifact_count, 1)
    assert.equal(transcript.canonical_artifact_id, imported.artifact?.id ?? (imported.artifact as { id: string }).id)
    assert.equal(transcript.canonical_revision, 1)
    assert.equal(transcript.text.artifact_id, transcript.canonical_artifact_id)
    assert.equal(transcript.text.content, content, '正文逐字节相等（不清洗、不摘要）')
    assert.ok(Buffer.from(transcript.text.content, 'utf8').equals(Buffer.from(content, 'utf8')))
    assert.equal(transcript.text.total_chars, content.length)
    assert.equal(transcript.text.has_more, false)
    assert.equal(transcript.text.offset, 0)

    // 每条产物回显**自己的**三维标签（顶层 labels 是租户口径的 FIXTURE/MANUAL/CONNECTED，两者不许混）
    const artifact = transcript.artifacts[0] as Record<string, unknown>
    assert.equal(artifact.provenance, 'FIXTURE')
    assert.equal(artifact.trigger_mode, 'MANUAL')
    assert.equal(artifact.connection_state, 'NOT_CONNECTED')
    assert.equal(artifact.is_canonical, true)
    assert.equal(artifact.char_count, content.length)
    assert.equal(artifact.segment_count, 3)

    // record 是另一条状态轴：NEEDS_REVIEW + RECORD_NOT_READY
    assert.equal(transcript.record.status, 'NEEDS_REVIEW')
    assert.equal(transcript.record.transcript_revision, 1)
    assert.equal(transcript.record.is_current, true)
    assert.deepEqual(value.warnings.map((warning) => warning.code), ['RECORD_NOT_READY'])

    // 分页：max_chars 小值 + text_offset 续读，拼回原文
    const chunks: string[] = []
    let offset = 0
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await readTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId, max_chars: 5, text_offset: offset,
      }, Date.now()) as { transcript: { text?: { content: string; has_more: boolean; next_offset?: number; length: number } } }
      const text = page.transcript.text as { content: string; has_more: boolean; next_offset?: number; length: number }
      assert.ok(text.length <= 5)
      assert.equal(text.content.length, text.length)
      chunks.push(text.content)
      if (text.has_more !== true) {
        assert.equal(Object.hasOwn(text, 'next_offset'), false, 'has_more=false 时不给 next_offset')
        break
      }
      assert.equal(text.next_offset, offset + text.length)
      offset = text.next_offset as number
    }
    assert.equal(chunks.join(''), content)

    // 片段分页
    const segmentPage = await readTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, include_segments: true, segment_limit: 2,
    }, Date.now()) as { transcript: { segments: { sequence: number; content_text: string }[]; segment_page: { total: number; has_more: boolean } } }
    assert.deepEqual(segmentPage.transcript.segments.map((segment) => segment.sequence), [0, 1])
    assert.equal(segmentPage.transcript.segment_page.total, 3)
    assert.equal(segmentPage.transcript.segment_page.has_more, true)
    const rest = await readTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, include_segments: true, segment_offset: 2, segment_limit: 2,
    }, Date.now()) as { transcript: { segments: { sequence: number; content_text: string }[]; segment_page: { has_more: boolean } } }
    assert.deepEqual(rest.transcript.segments.map((segment) => segment.sequence), [2])
    assert.equal(rest.transcript.segment_page.has_more, false)
    assert.equal(rest.transcript.segments[0]?.content_text, '00:20 面试官：说说难点')
  })
})

test('MISSING / NO_MEETING_BOUND：一场会议都没绑且已过计划开始（TR-D 序 1）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { schedule: false })
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as { state: string; reason_code: string; artifacts: unknown[] }
    assert.equal(transcript.state, 'MISSING')
    assert.equal(transcript.reason_code, 'NO_MEETING_BOUND')
    assert.deepEqual(transcript.artifacts, [])
    assert.ok(value.warnings.some((warning) => warning.code === 'TRANSCRIPT_NOT_READY'))
    assert.ok(value.warnings.some((warning) => warning.code === 'RECORD_MISSING'))
    // 没有正文可选 → text 键省略（不是 null）
    assert.equal(Object.hasOwn(value.transcript, 'text'), false)
  })
})

test('PENDING / WAITING：会议还没结束（TR-D 序 7）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, {
      scheduledStart: new Date(Date.now() + 60 * 60_000),
      scheduledEnd: new Date(Date.now() + 120 * 60_000),
      actualStart: undefined,
      actualEnd: undefined,
    })
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as { state: string; reason_code: string }
    assert.equal(transcript.state, 'PENDING')
    assert.equal(transcript.reason_code, 'WAITING')
  })
})

test('MISSING / NO_ARTIFACT_AFTER_WAIT：会议结束超过等待窗仍无产物（TR-D 序 6）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const end = new Date(Date.now() - 180 * 60_000)
    const fixture = await seedInterview(client, scenario.applicationId, {
      scheduledStart: new Date(end.getTime() - 60 * 60_000),
      scheduledEnd: end,
      actualStart: new Date(end.getTime() - 60 * 60_000),
      actualEnd: end,
    })
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as { state: string; reason_code: string; wait_minutes: number }
    assert.equal(transcript.state, 'MISSING')
    assert.equal(transcript.reason_code, 'NO_ARTIFACT_AFTER_WAIT')
    assert.equal(transcript.wait_minutes, 120)
  })
})

test('wait_minutes 可被 business_config(transcript_policy) 覆盖（TR-D §4 的 WAIT）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const end = new Date(Date.now() - 30 * 60_000)
    const fixture = await seedInterview(client, scenario.applicationId, {
      scheduledStart: new Date(end.getTime() - 60 * 60_000),
      scheduledEnd: end,
      actualStart: new Date(end.getTime() - 60 * 60_000),
      actualEnd: end,
    })
    await client.query(
      `insert into recruitment.business_config
         (tenant_id, scope, scope_id, config_key, version_no, payload, payload_hash)
       values ($1, 'ORGANIZATION', null, 'transcript_policy', 999, $2::jsonb, $3)`,
      [TENANT, JSON.stringify({ wait_minutes: 5 }), hex64(`policy${uniqueSuffix()}`)],
    )
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as { state: string; reason_code: string; wait_minutes: number }
    assert.equal(transcript.wait_minutes, 5)
    // 30 分钟前结束 + 5 分钟等待窗 → 已过窗，且一份产物都没有
    assert.equal(transcript.state, 'MISSING')
    assert.equal(transcript.reason_code, 'NO_ARTIFACT_AFTER_WAIT')
  })
})

test('READY / READY_NO_CANONICAL：有完整产物但没人选 canonical（TR-D 序 3）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const imported = await importContent(client, fixture.interviewId, '00:00 面试官：无 canonical 也要能读')
    // 只改白名单列（`0001 L1777` 允许 is_canonical），模拟"canonical 还没选"
    await client.query('update recruitment.transcript_artifact set is_canonical = false where id = $1', [
      (imported.artifact as { id: string }).id,
    ])
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as { state: string; reason_code: string; canonical_artifact_id?: string }
    assert.equal(transcript.state, 'READY')
    assert.equal(transcript.reason_code, 'READY_NO_CANONICAL')
    assert.equal(Object.hasOwn(transcript, 'canonical_artifact_id'), false, '没有 canonical 就省略键')
    assert.ok(value.warnings.some((warning) => warning.code === 'NO_CANONICAL'))
    // 仍然能读到正文（选"最新完整的那一版"）
    assert.equal((value.transcript as { text?: { content: string } }).text?.content, '00:00 面试官：无 canonical 也要能读')
  })
})

test('artifact_id 过滤：非 canonical → 警告但仍返回它自己的正文；不属于本面试 → NOT_FOUND', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId)
    const content = '00:00 面试官：第一版'
    const first = await importContent(client, fixture.interviewId, content)
    const second = await importContent(client, fixture.interviewId, `${content} + 修订`)
    const rev1 = (first.artifact as { id: string }).id

    const value = await readTranscriptInTransaction(client, cfg, {
      interview_id: fixture.interviewId, artifact_id: rev1,
    }, Date.now())
    const transcript = value.transcript as {
      selected_artifact_id: string
      selected_source_revision: number
      text: { content: string }
      canonical_artifact_id: string
    }
    assert.equal(transcript.selected_artifact_id, rev1)
    assert.equal(transcript.selected_source_revision, 1)
    assert.equal(transcript.text.content, content)
    assert.equal(transcript.canonical_artifact_id, (second.artifact as { id: string }).id)
    assert.ok(value.warnings.some((warning) => warning.code === 'ARTIFACT_FILTER_NOT_CANONICAL'))

    // 属于另一场面试的 artifact → ARTIFACT_NOT_FOUND
    const other = await seedInterview(client, scenario.applicationId, { roundNo: 2 })
    const otherImport = await importContent(client, other.interviewId, '00:00 面试官：另一场')
    await assert.rejects(
      async () => readTranscriptInTransaction(client, cfg, {
        interview_id: fixture.interviewId,
        artifact_id: (otherImport.artifact as { id: string }).id,
      }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'ARTIFACT_NOT_FOUND')
        return true
      },
    )
  })
})

test('INVALID_ARGS / NOT_FOUND 的 reason_code 封闭集（as_of 未来、无偏移、未知参数、tenant_id、非 UUID）', async () => {
  const tool = createTranscriptReadTool(cfg)
  const interviewId = '11111111-1111-4111-8111-000000000abc'
  const expectInvalid = async (args: Record<string, unknown>, reason: string): Promise<void> => {
    await assert.rejects(
      async () => tool.execute(args, {}),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, reason)
        return true
      },
    )
  }
  // 未来 → AS_OF_IN_FUTURE；无偏移 → AS_OF_FORMAT；未知参数 / 身份键 / 非 UUID 各一条
  await expectInvalid({ interview_id: interviewId, as_of: '2999-01-01T00:00:00+08:00' }, 'AS_OF_IN_FUTURE')
  await expectInvalid({ interview_id: interviewId, as_of: '2026-11-13T00:00:00' }, 'AS_OF_FORMAT')
  await expectInvalid({ interview_id: interviewId, foo: 1 }, 'UNKNOWN_PARAM')
  await expectInvalid({ interview_id: interviewId, tenant_id: TENANT }, 'TENANT_OR_ACTOR_NOT_ALLOWED')
  await expectInvalid({ interview_id: 'not-a-uuid' }, 'ID_NOT_UUID')
  await expectInvalid({ interview_id: interviewId, max_chars: 0 }, 'OUT_OF_RANGE')
  await expectInvalid({ interview_id: interviewId, include_text: 'true' }, 'TYPE_MISMATCH')

  // 不存在的面试 → NOT_FOUND(INTERVIEW_NOT_FOUND)：走真库
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      async () => readTranscriptInTransaction(client, cfg, { interview_id: interviewId }, Date.now()),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'INTERVIEW_NOT_FOUND')
        return true
      },
    )
  })
})

test('REPLACED 会议不进 M(i)：它的产物不参与状态派生（TR-D4）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const fixture = await seedInterview(client, scenario.applicationId, { role: 'REPLACED' })
    // 改期前的旧会议确实留下过产物（历史事实，禁删也不许改写）——这里直接造一行等价的 READY artifact。
    // 导入工具**不会**往 REPLACED 会议写（chooseMeeting 只认 PRIMARY/CONTINUATION），所以只能 SQL 造。
    const sha = hex64(`replaced${uniqueSuffix()}`)
    const raw = '00:00 面试官：这场被改期了'
    await client.query(
      `insert into recruitment.transcript_artifact
         (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type, language,
          transcript_status, provenance, trigger_mode, connection_state, fetched_at,
          content_sha256, raw_text, is_complete, has_more, is_canonical)
       values ($1, $2, 'FEISHU', $3, 1, 'ORIGINAL', 'zh', 'READY', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
               now(), $4, $5, true, false, true)`,
      [TENANT, fixture.meetingId, `local:old-meeting:${fixture.meetingId}`, sha, raw],
    )
    const value = await readTranscriptInTransaction(client, cfg, { interview_id: fixture.interviewId }, Date.now())
    const transcript = value.transcript as {
      state: string
      reason_code: string
      artifact_count: number
      artifacts: unknown[]
      meetings: { id: string; meeting_role: string; in_transcript_set: boolean }[]
    }
    // 会议仍回显（可追溯），但 in_transcript_set=false；ART(i)=∅ 且已过计划开始 → 序 1 的 MISSING
    assert.equal(transcript.meetings.length, 1)
    assert.equal(transcript.meetings[0]?.meeting_role, 'REPLACED')
    assert.equal(transcript.meetings[0]?.in_transcript_set, false)
    assert.equal(transcript.artifact_count, 0)
    assert.deepEqual(transcript.artifacts, [])
    assert.equal(transcript.state, 'MISSING')
    assert.equal(transcript.reason_code, 'NO_MEETING_BOUND')
    // 产物确实在库里（旧会议的产物保留，不入本轮记录）
    const stored = await client.query<{ n: string }>(
      'select count(*) as n from recruitment.transcript_artifact where meeting_id = $1',
      [fixture.meetingId],
    )
    assert.equal(Number(stored.rows[0]?.n), 1)
  })
})
