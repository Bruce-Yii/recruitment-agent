// C-4 一致性回归（**连真库 ra_s6s7**，每个用例结束 ROLLBACK）。
//
// 事故（G3 报告 C-4）：`recruitment_interview_get` 曾自写一套 TR-D 派生，缺
// `transcript-read.ts` 的 D-96/TR-F4 分支（canonical 状态 READY 但 `raw_text` 为空 →
// 必须报 `PARTIAL/ARTIFACT_EMPTY`）。结果是**同一条 DB 事实**在两个工具里给出不同的
// `transcript.state`/`reason_code`，下游没法判断该信谁。
//
// 本文件的判据只有一条：**同一事务、同一 as_of、同一 DB 事实**，两个工具的输出必须一致：
//   a) `readTranscriptInTransaction(client, cfg, { interview_id, as_of, include_text:false })`
//      （`src/tools/transcript-read.ts`，权威实现）
//   b) `getInTransaction(client, cfg, { interview_id, as_of })`
//      （`src/tools/interview-get.ts`，本次改为复用同一个 `deriveTranscriptState()`）
//   断言 `b.transcript.state/reason_code/no_transcript` 与 a 的 `state/reason_code` 完全一致
//   （`no_transcript === (state !== 'READY')`）。
//
// 矩阵覆盖 TR-D 序 1–7 里能落到 DB 事实的分支：
//   ① canonical READY + raw_text=''  → 两边都 PARTIAL/ARTIFACT_EMPTY（**C-4 回归核心**）
//   ② canonical READY + 有正文       → READY/CANONICAL_STATUS
//   ③ 无 canonical、READY+complete 非空正文 → READY/READY_NO_CANONICAL（+ interview_get 的 CANONICAL_MISSING）
//   ④ 仅 PARTIAL                     → PARTIAL/ONLY_PARTIAL
//   ⑤ 仅 AUTH_REQUIRED               → AUTH_REQUIRED/ONLY_AUTH_REQUIRED
//   ⑥ 等满 WAIT 仍无 artifact        → MISSING/NO_ARTIFACT_AFTER_WAIT
//   ⑦ 等待窗内无 artifact            → PENDING/WAITING
//   ⑧ REPLACED 会议不进 M(i)         → 两边都 MISSING/NO_MEETING_BOUND（TR-D4）
//   ⑨ 1 面试 : N 会议、多个 canonical → 两边选中同一个 canonical（产物顺序对齐）
// 另测 `require_transcript=true` 对 ① 的透传（NO_TRANSCRIPT.reason_code 与 a 逐字一致）。
//
// 零写入：每个用例在**同一客户端**上取五张表的行数，调用前后必须完全相同；另有一条
// 静态断言（`interview-get.ts` 的 SQL 模板不含写语句），运行时由 `withReadOnly` / DB 25006 兜底。
//
// 纪律同其它集成测试：夹具一律在 `inRolledBackTx`（REPEATABLE READ）里直接 INSERT，
// 结束 ROLLBACK，不污染 `ra_s6s7`；不打印任何正文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getInTransaction } from '../../src/tools/interview-get.ts'
import { readTranscriptInTransaction } from '../../src/tools/transcript-read.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  HR_ACTOR,
  TENANT,
  createTestPool,
  errorBody,
  hex64,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 服务端"现在"（固定值：两个工具的唯一时钟都是 `as_of`，测试不读真实时钟）。 */
const NOW_MS = Date.parse('2026-11-13T12:00:00+08:00')
/** 派生状态的基准时刻（早于 NOW_MS，满足 `as_of <= now`）。 */
const AS_OF = '2026-11-13T00:00:00+08:00'

/** 一份能被 `seedScenario` 接受的 Rubric（本文件不跑筛选，只为满足外键与 payload_hash）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 },
]

/** 造一份完整夹具（job / rubric / candidate / event 链 / resume_version / application）。 */
async function newApplication(client: DatabaseClient): Promise<{ applicationId: string }> {
  return seedScenario(client, { dimensions: DIMENSIONS })
}

/** 直接 INSERT 一场面试（显式 S8；不靠迁移默认值）。 */
async function insertInterview(client: DatabaseClient, input: {
  readonly applicationId: string
  readonly startAt: string
  readonly endAt: string
}): Promise<string> {
  return one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, stage_code, status,
       scheduled_start_at, scheduled_end_at, timezone, status_changed_by_actor_id)
      values ($1, $2, 1, 'DEFAULT', 'S8', 'POST_INTERVIEW', $3::timestamptz, $4::timestamptz,
              'Asia/Shanghai', $5)
      returning id`, [TENANT, input.applicationId, input.startAt, input.endAt, HR_ACTOR])
}

/** 造一个 meeting + 一条 MANUAL binding。 */
async function bindMeeting(client: DatabaseClient, input: {
  readonly interviewId: string
  readonly role?: string
  readonly actualStartAt?: string | null
  readonly actualEndAt?: string | null
}): Promise<string> {
  const suffix = uniqueSuffix()
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, account_scope, external_meeting_id, calendar_event_id, meeting_role,
       actual_start_at, actual_end_at)
      values ($1, 'FEISHU', 'default', $2, $3, $4, $5::timestamptz, $6::timestamptz)
      returning id`, [
    TENANT, `meeting_${suffix}`, `evt_${suffix}`, input.role ?? 'PRIMARY',
    input.actualStartAt ?? null, input.actualEndAt ?? null,
  ])
  await client.query(`insert into recruitment.meeting_binding
      (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
      values ($1, $2, $3, 'MANUAL', $4)`, [TENANT, meetingId, input.interviewId, HR_ACTOR])
  return meetingId
}

/**
 * 造一条 `transcript_artifact`。
 * @param rawText - `raw_text` 正文；`undefined` → SQL NULL；`''` → 空串。
 *   两者在 PG 里 `length()` 都是 0（或 NULL→coalesce 0），所以都落 ARTIFACT_EMPTY 分支。
 */
async function insertArtifact(client: DatabaseClient, input: {
  readonly meetingId: string
  readonly status: string
  readonly isCanonical: boolean
  readonly isComplete?: boolean
  readonly rawText?: string | null
}): Promise<string> {
  const suffix = uniqueSuffix()
  const ready = input.status === 'READY'
  return one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type, language,
       transcript_status, provenance, trigger_mode, connection_state, fetched_at,
       content_sha256, is_complete, is_canonical, raw_payload, raw_text)
      values ($1, $2, 'FEISHU', $3, 1, 'ORIGINAL', 'zh', $4, 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
              now(), $5, $6, $7, '{}'::jsonb, $8)
      returning id`, [
    TENANT, input.meetingId, `artifact_${suffix}`, input.status,
    ready ? hex64(`sha${suffix}`) : null, input.isComplete ?? ready, input.isCanonical,
    input.rawText ?? null,
  ])
}

/** 五张关键表的行数（零写入断言用）；按租户计数。 */
interface TableCounts {
  readonly interview: number
  readonly transcript_artifact: number
  readonly transcript_segment: number
  readonly interview_record: number
  readonly scorecard: number
}

async function tableCounts(client: DatabaseClient): Promise<TableCounts> {
  const { rows } = await client.query<Record<string, string>>(
    `select (select count(*) from recruitment.interview where tenant_id = $1) as interview,
            (select count(*) from recruitment.transcript_artifact where tenant_id = $1) as transcript_artifact,
            (select count(*) from recruitment.transcript_segment where tenant_id = $1) as transcript_segment,
            (select count(*) from recruitment.interview_record where tenant_id = $1) as interview_record,
            (select count(*) from recruitment.scorecard where tenant_id = $1) as scorecard`,
    [TENANT],
  )
  const row = rows[0] as Record<string, string>
  return {
    interview: Number(row.interview),
    transcript_artifact: Number(row.transcript_artifact),
    transcript_segment: Number(row.transcript_segment),
    interview_record: Number(row.interview_record),
    scorecard: Number(row.scorecard),
  }
}

/** 两个工具的 transcript 块（本文件只断言这三/两个键）。 */
interface TranscriptLite {
  readonly state: string
  readonly reason_code: string
  readonly no_transcript?: boolean
}

/** 一次"同事实两读"的结果。 */
interface BothReads {
  readonly read: TranscriptLite
  readonly got: TranscriptLite
  readonly readWarnings: readonly { code: string }[]
  readonly gotWarnings: readonly { code: string }[]
  readonly before: TableCounts
  readonly after: TableCounts
}

/**
 * 同一事务、同一 as_of 同时调用两个工具，并断言**零写入**。
 * @param client - 已回滚事务内的客户端。
 * @param interviewId - 同一场面试。
 * @param asOf - 两边共用的派生基准时刻。
 */
async function readBoth(
  client: DatabaseClient,
  interviewId: string,
  asOf: string = AS_OF,
): Promise<BothReads> {
  const before = await tableCounts(client)
  const readValue = await readTranscriptInTransaction(client, cfg, {
    interview_id: interviewId, as_of: asOf, include_text: false,
  }, NOW_MS)
  const getValue = await getInTransaction(client, cfg, {
    interview_id: interviewId, as_of: asOf,
  }, NOW_MS) as {
    interviews: readonly { id: string; transcript: TranscriptLite; warnings: readonly { code: string }[] }[]
    warnings?: readonly { code: string }[]
  }
  const after = await tableCounts(client)
  assert.deepEqual(after, before, '两个工具都必须零写入（调用前后五张表行数必须完全一致）')
  assert.equal(getValue.interviews.length, 1, '按 interview_id 查询必须恰好回一场')
  const interview = getValue.interviews[0]
  assert.ok(interview !== undefined)
  assert.equal(interview.id, interviewId)
  return {
    read: readValue.transcript as unknown as TranscriptLite,
    got: interview.transcript,
    readWarnings: readValue.warnings,
    gotWarnings: interview.warnings,
    before,
    after,
  }
}

/**
 * C-4 的核心断言：interview_get 的 `state/reason_code/no_transcript` 与
 * transcript_read 的 `state/reason_code` 完全一致。
 * @param both - `readBoth()` 的返回值。
 * @param expected - 本用例期望的 `[state, reason_code]`。
 */
function assertSameTranscript(both: BothReads, expected: readonly [string, string]): void {
  assert.equal(both.read.state, expected[0], `transcript_read.state 期望 ${expected[0]}`)
  assert.equal(both.read.reason_code, expected[1], `transcript_read.reason_code 期望 ${expected[1]}`)
  assert.equal(both.got.state, both.read.state, 'interview_get.state 必须与 transcript_read.state 一致（C-4）')
  assert.equal(
    both.got.reason_code,
    both.read.reason_code,
    'interview_get.reason_code 必须与 transcript_read.reason_code 一致（C-4）',
  )
  assert.equal(
    both.got.no_transcript,
    both.read.state !== 'READY',
    'no_transcript 必须恒等于 (state !== READY)，与权威实现同一判据',
  )
}

// ---------------------------------------------------------------------------
// ① C-4 回归核心：canonical READY + raw_text 空
// ---------------------------------------------------------------------------

test('① canonical READY + raw_text 为空 → 两个工具都 PARTIAL/ARTIFACT_EMPTY（C-4 回归核心）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, {
      interviewId,
      actualStartAt: '2026-11-10T10:02:00+08:00',
      actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    // 状态 READY、完整、canonical，但正文是空串（D-96 的飞书真实形态）。
    await insertArtifact(client, { meetingId, status: 'READY', isCanonical: true, rawText: '' })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['PARTIAL', 'ARTIFACT_EMPTY'])
    assert.ok(
      both.readWarnings.some((warning) => warning.code === 'TRANSCRIPT_NOT_READY'),
      'transcript_read 对非 READY 必须给 TRANSCRIPT_NOT_READY',
    )

    // 修复前 interview_get 在这里会报 READY/CANONICAL_STATUS —— 这正是 C-4 的漂移。
    assert.notEqual(both.got.state, 'READY', '空正文不得报 READY（D-96/TR-F4）')
  })
})

// ---------------------------------------------------------------------------
// ② canonical READY + 有正文
// ---------------------------------------------------------------------------

test('② canonical READY + 有正文 → 两个工具都 READY/CANONICAL_STATUS', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, {
      interviewId,
      actualStartAt: '2026-11-10T10:02:00+08:00',
      actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    await insertArtifact(client, {
      meetingId, status: 'READY', isCanonical: true, rawText: '00:00 面试官：请自我介绍',
    })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['READY', 'CANONICAL_STATUS'])
    assert.equal(both.got.no_transcript, false)
  })
})

// ---------------------------------------------------------------------------
// ③ 无 canonical、有 READY+complete 非空正文（面试侧 CANONICAL_MISSING 警告仍只认这一条）
// ---------------------------------------------------------------------------

test('③ 无 canonical、有 READY+complete → 两边 READY/READY_NO_CANONICAL；interview_get 有 CANONICAL_MISSING', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, {
      interviewId,
      actualStartAt: '2026-11-10T10:02:00+08:00',
      actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    await insertArtifact(client, {
      meetingId, status: 'READY', isCanonical: false, rawText: '00:00 面试官：没选 canonical 也有正文',
    })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['READY', 'READY_NO_CANONICAL'])
    assert.ok(
      both.readWarnings.some((warning) => warning.code === 'NO_CANONICAL'),
      'transcript_read 必须给 NO_CANONICAL',
    )
    assert.ok(
      both.gotWarnings.some((warning) => warning.code === 'CANONICAL_MISSING'),
      'interview_get 必须给 CANONICAL_MISSING（触发条件仍是 READY_NO_CANONICAL）',
    )
  })
})

// ---------------------------------------------------------------------------
// ④ 仅 PARTIAL
// ---------------------------------------------------------------------------

test('④ 仅 PARTIAL → 两个工具都 PARTIAL/ONLY_PARTIAL', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, { interviewId })
    await insertArtifact(client, { meetingId, status: 'PARTIAL', isCanonical: false })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['PARTIAL', 'ONLY_PARTIAL'])
    // ONLY_PARTIAL 不是"有完整 READY 无 canonical"，不得误报 CANONICAL_MISSING。
    assert.equal(
      both.gotWarnings.some((warning) => warning.code === 'CANONICAL_MISSING'),
      false,
      'ONLY_PARTIAL 不得触发 CANONICAL_MISSING（旧触发条件保持不变）',
    )
  })
})

// ---------------------------------------------------------------------------
// ⑤ 仅 AUTH_REQUIRED
// ---------------------------------------------------------------------------

test('⑤ 仅 AUTH_REQUIRED → 两个工具都 AUTH_REQUIRED/ONLY_AUTH_REQUIRED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, { interviewId })
    await insertArtifact(client, { meetingId, status: 'AUTH_REQUIRED', isCanonical: false })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['AUTH_REQUIRED', 'ONLY_AUTH_REQUIRED'])
  })
})

// ---------------------------------------------------------------------------
// ⑥ 等满 WAIT 仍无 artifact
// ---------------------------------------------------------------------------

test('⑥ 会议结束超过 WAIT 仍无 artifact → 两个工具都 MISSING/NO_ARTIFACT_AFTER_WAIT', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    await bindMeeting(client, {
      interviewId,
      actualStartAt: '2026-11-10T10:00:00+08:00',
      actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    // as_of（11-13）距会议结束已 2 天多 > WAIT(120min)
    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['MISSING', 'NO_ARTIFACT_AFTER_WAIT'])
  })
})

// ---------------------------------------------------------------------------
// ⑦ 等待窗内无 artifact
// ---------------------------------------------------------------------------

test('⑦ 会议还没结束 / 等待窗内无 artifact → 两个工具都 PENDING/WAITING', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-20T10:00:00+08:00',
      endAt: '2026-11-20T11:00:00+08:00',
    })
    await bindMeeting(client, { interviewId })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['PENDING', 'WAITING'])
  })
})

// ---------------------------------------------------------------------------
// ⑧ REPLACED 会议不进 M(i)（TR-D4）：两边都该按"没有可产材料的会议"派生
// ---------------------------------------------------------------------------

test('⑧ REPLACED 会议不进 M(i)：它的 canonical 产物不参与派生，两边都 MISSING/NO_MEETING_BOUND', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    // 改期前的旧会议：历史产物仍在库里，但它**不属于** M(i)（TR-D4）。
    const replacedMeetingId = await bindMeeting(client, { interviewId, role: 'REPLACED' })
    await insertArtifact(client, {
      meetingId: replacedMeetingId, status: 'READY', isCanonical: true, rawText: '00:00 旧会议：已改期',
    })

    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, ['MISSING', 'NO_MEETING_BOUND'])
    assert.equal(both.got.state, 'MISSING', 'REPLACED 会议不得被当成 M(i)')
  })
})

// ---------------------------------------------------------------------------
// ⑨ 多会议多 canonical：产物顺序必须对齐（否则 find(is_canonical) 选中不同那份）
// ---------------------------------------------------------------------------

test('⑨ 1 面试 : N 会议、每场各一个 canonical → 两个工具选中同一个 canonical', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingA = await bindMeeting(client, {
      interviewId, actualEndAt: '2026-11-10T10:30:00+08:00',
    })
    const meetingB = await bindMeeting(client, {
      interviewId, actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    // DB 只保证"每场会议至多一个 canonical"，不保证一个面试只有一个 → 这里有两个。
    await insertArtifact(client, { meetingId: meetingA, status: 'PARTIAL', isCanonical: true })
    await insertArtifact(client, {
      meetingId: meetingB, status: 'READY', isCanonical: true, rawText: '00:00 第二场会议：有正文',
    })

    // 权威实现按产物查询顺序（meeting_id 升序）`find(is_canonical)` 取第一条；
    // 期望值因此由两个 meeting_id 的字典序决定（与 PostgreSQL uuid 排序一致）。
    const firstMeetingId = meetingA < meetingB ? meetingA : meetingB
    const expectedState = firstMeetingId === meetingA ? 'PARTIAL' : 'READY'
    const both = await readBoth(client, interviewId)
    assertSameTranscript(both, [expectedState, 'CANONICAL_STATUS'])
  })
})

// ---------------------------------------------------------------------------
// require_transcript=true：NO_TRANSCRIPT.reason_code 与 transcript_read 逐字一致
// ---------------------------------------------------------------------------

test('require_transcript=true：① 的事实 → NO_TRANSCRIPT(ARTIFACT_EMPTY)，与 transcript_read 逐字一致', async () => {
  await inRolledBackTx(pool, async (client) => {
    const app = await newApplication(client)
    const interviewId = await insertInterview(client, {
      applicationId: app.applicationId,
      startAt: '2026-11-10T10:00:00+08:00',
      endAt: '2026-11-10T11:00:00+08:00',
    })
    const meetingId = await bindMeeting(client, {
      interviewId,
      actualStartAt: '2026-11-10T10:02:00+08:00',
      actualEndAt: '2026-11-10T10:58:00+08:00',
    })
    await insertArtifact(client, { meetingId, status: 'READY', isCanonical: true, rawText: '' })

    // 先拿权威读侧的 reason_code（同一事务、同一 as_of）；count 覆盖本次用例的两个调用。
    const before = await tableCounts(client)
    const readValue = await readTranscriptInTransaction(client, cfg, {
      interview_id: interviewId, as_of: AS_OF, include_text: false,
    }, NOW_MS)
    const readTranscript = readValue.transcript as TranscriptLite
    assert.equal(readTranscript.state, 'PARTIAL')
    assert.equal(readTranscript.reason_code, 'ARTIFACT_EMPTY')

    // 再证 require_transcript=true 的硬前置失败：reason_code 逐字透传，零写入。
    let caught: unknown
    try {
      await getInTransaction(client, cfg, {
        interview_id: interviewId, as_of: AS_OF, require_transcript: true,
      }, NOW_MS)
    } catch (error) {
      caught = error
    }
    const after = await tableCounts(client)
    assert.deepEqual(after, before, 'NO_TRANSCRIPT 失败路径也必须零写入')

    assert.notEqual(caught, undefined, 'require_transcript=true 且 state=PARTIAL 必须抛 NO_TRANSCRIPT')
    const body = errorBody(caught)
    assert.equal(body.code, 'NO_TRANSCRIPT')
    assert.equal(
      body.reason_code,
      readTranscript.reason_code,
      'NO_TRANSCRIPT.reason_code 必须与 transcript_read.reason_code 逐字相同',
    )
    assert.equal(body.reason_code, 'ARTIFACT_EMPTY')
    const detail = body.detail as { interview_id: string; transcript_state: string; meetings_total: number }
    assert.equal(detail.interview_id, interviewId)
    assert.equal(detail.transcript_state, 'PARTIAL')
    assert.equal(detail.meetings_total, 1)
    assert.deepEqual(Object.keys(body).sort(), ['code', 'detail', 'message', 'reason_code'])
  })
})

// ---------------------------------------------------------------------------
// 静态只读：interview-get.ts 的 SQL 模板不含写语句
// ---------------------------------------------------------------------------

test('静态只读：interview-get.ts 的 SQL 模板不含 insert/update/delete/for update', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'tools', 'interview-get.ts'),
    'utf8',
  )
  const sql = [...source.matchAll(/`([^`]*)`/gs)].map((match) => match[1] as string).join('\n')
  assert.doesNotMatch(
    sql,
    /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|for\s+update|truncate\s+)\b/i,
    'interview_get 是只读工具：SQL 模板里不得出现写语句（运行时另有 withReadOnly / DB 25006 兜底）',
  )
  assert.match(sql, /select/i)
})
