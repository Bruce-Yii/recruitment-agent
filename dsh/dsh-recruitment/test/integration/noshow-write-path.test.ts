// owner-noshow-tz / A（NO_SHOW 写路径）：MARK_NO_SHOW 最小修法（审计 REPORT.md §③ P1）的
// 独立写路径测试。与 noshow-tz-integration.test.ts（C，真库事实面）互补：本文件聚焦
// ① 写路径自身行为（intent / 参数 / 状态机 / 审计 payload / 幂等 / 人机闸门）；
// ② **负例零写入**：每次失败都做 interview / event_inbox 行数 before/after 精确断言；
// ③ 读侧 no_show 对象（interview-get.readInterviewValue）从事件读回，原文绝不返回。
//
// 纪律（test/integration/db.ts）：每个用例在回滚事务里跑、结束一律 ROLLBACK，不污染库；
// 连不上库就失败（R3：skipped===0 才算绿）。口令只从环境变量读。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import { readInterviewValue } from '../../src/tools/interview-get.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createIsolatedTestDatabase,
  errorBody,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
  HR_ACTOR,
  TENANT,
  type IsolatedTestDatabase,
} from './db.ts'

let db: IsolatedTestDatabase
let pool: import('pg').Pool
// 一次性真库的配置：tenant/actor/口令与产品路径同一份，只把库名换成隔离库。
const baseCfg = testDatabaseConfig()
const cfg = { ...baseCfg }
test.before(async () => {
  db = await createIsolatedTestDatabase('noshow_write_path_a')
  pool = db.pool
  cfg.database = db.name
})
test.after(async () => {
  if (db !== undefined) await db.drop()
})

const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]
const NOW = Date.parse('2026-11-13T00:00:00Z')
const SLOT_BASE_MS = Date.parse('2031-02-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function createArgs(applicationId: string, startIso: string): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `a-create-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: INTERVIEWER_A }],
    scheduled_start_at: startIso,
    duration_minutes: 60,
  }
}

function markArgs(interviewId: string, version: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'MARK_NO_SHOW',
    idempotency_key: `a-mark-${uniqueSuffix()}`,
    interview_id: interviewId,
    expected_record_version: version,
    reason: '候选人电话确认放弃面试，未到场',
    confirmation_text: '确认：候选人未到场，按爽约记录处理。',
    subject: 'CANDIDATE',
    ...overrides,
  }
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, [...params])
  const n = rows[0]?.n
  assert.ok(typeof n === 'number', `count query returned no row: ${sql.slice(0, 60)}`)
  return n
}

/** 零写入快照：本任务要求的硬表（interview + event_inbox）+ 幂等 STORE 表。 */
async function writeSnapshot(client: DatabaseClient): Promise<Record<string, number>> {
  return {
    interview: await count(client, 'select count(*)::int as n from recruitment.interview'),
    event_inbox: await count(client, 'select count(*)::int as n from recruitment.event_inbox'),
    business_task: await count(client, 'select count(*)::int as n from recruitment.business_task'),
  }
}

async function createInterview(client: DatabaseClient): Promise<{
  interviewId: string; version: number; startIso: string; endIso: string
}> {
  const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
  const jitter = Math.floor(Math.random() * 20_000) * 60_000
  const startIso = new Date(SLOT_BASE_MS + jitter).toISOString()
  const value = await scheduleInTransaction(client, cfg, createArgs(scenario.applicationId, startIso), NOW, allowOnce)
  const interview = value.interview as Record<string, unknown>
  const { rows } = await client.query<{ scheduled_start_at: string | Date; scheduled_end_at: string | Date }>(
    'select scheduled_start_at, scheduled_end_at from recruitment.interview where id = $1', [interview.id],
  )
  const iso = (v: string | Date): string => v instanceof Date ? v.toISOString() : String(v)
  return {
    interviewId: String(interview.id),
    version: Number(interview.record_version),
    startIso: iso(rows[0]!.scheduled_start_at),
    endIso: iso(rows[0]!.scheduled_end_at),
  }
}

async function expectFailure(run: Promise<unknown>, code: string, reasonCode?: string): Promise<Record<string, unknown>> {
  try {
    await run
  } catch (error) {
    const body = errorBody(error)
    assert.equal((error as { code?: string }).code, code)
    assert.equal(body.code, code)
    if (reasonCode !== undefined) assert.equal(body.reason_code, reasonCode)
    return body
  }
  assert.fail(`期望抛 ${code}${reasonCode === undefined ? '' : `(${reasonCode})`}，但调用成功`)
}

async function markEvents(client: DatabaseClient, interviewId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select payload, event_type, idempotency_key from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'interview.no_show' and payload->>'interview_id' = $2
      order by recorded_at, event_id`,
    [TENANT, interviewId],
  )
  return rows
}

/** 回滚事务包装（与 db.ts 的 inRolledBackTx 同口径，用本文件的隔离池）。 */
async function inTx<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin isolation level repeatable read')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    return await fn(client)
  } finally {
    try {
      await client.query('rollback')
    } finally {
      client.release()
    }
  }
}

// ===========================================================================
//  1. 写路径正向：只改状态 + 版本；审计 payload 形状；读侧 no_show
// ===========================================================================

test('MARK_NO_SHOW 从 SCHEDULED 写成功：只改 status/版本，时段/面试官/会议不动；事件 payload 完备；原文不落库', async () => {
  await inTx(async (client) => {
    const { interviewId, version, startIso, endIso } = await createInterview(client)
    const interviewerBefore = await count(client,
      'select count(*)::int as n from recruitment.interviewer where interview_id = $1', [interviewId])
    const bindingBefore = await count(client,
      'select count(*)::int as n from recruitment.meeting_binding where interview_id = $1 and unbound_at is null',
      [interviewId])

    const args = markArgs(interviewId, version)
    const result = await scheduleInTransaction(client, cfg, args, NOW, allowOnce)
    assert.equal(result.status, 'OK')
    assert.equal(result.write, true)
    assert.equal(result.replayed, false)
    assert.equal(result.intent, 'MARK_NO_SHOW')
    assert.equal(result.already_marked, false)

    const { rows } = await client.query<Record<string, unknown>>(
      `select status, record_version, scheduled_start_at, scheduled_end_at, status_changed_by_actor_id
         from recruitment.interview where id = $1`, [interviewId],
    )
    const row = rows[0]!
    assert.equal(row.status, 'NO_SHOW')
    assert.equal(row.record_version, version + 1)
    assert.equal(row.status_changed_by_actor_id, HR_ACTOR)
    const iso = (v: unknown): string => v instanceof Date ? (v as Date).toISOString() : String(v)
    assert.equal(iso(row.scheduled_start_at), startIso, '不改 scheduled_start_at')
    assert.equal(iso(row.scheduled_end_at), endIso, '不改 scheduled_end_at')
    assert.equal(await count(client,
      'select count(*)::int as n from recruitment.interviewer where interview_id = $1', [interviewId]),
    interviewerBefore, '不改面试官')
    assert.equal(await count(client,
      'select count(*)::int as n from recruitment.meeting_binding where interview_id = $1 and unbound_at is null',
      [interviewId]), bindingBefore, '不改会议绑定')

    const events = await markEvents(client, interviewId)
    assert.equal(events.length, 1, '恰好一条 interview.no_show 事件')
    const payload = events[0]!.payload as Record<string, unknown>
    assert.equal(payload.outcome, 'NO_SHOW')
    assert.equal(payload.subject, 'CANDIDATE')
    assert.equal(payload.reason, args.reason)
    assert.equal(payload.confirmation_text_sha256, sha256(String(args.confirmation_text)))
    assert.match(String(payload.confirmation_text_sha256), /^[0-9a-f]{64}$/)
    assert.equal(payload.from_status, 'SCHEDULED')
    assert.equal(payload.to_status, 'NO_SHOW')
    assert.equal(payload.interview_id, interviewId)
    assert.equal(JSON.stringify(payload).includes(String(args.confirmation_text)), false, '原文不进 payload')
    assert.equal(JSON.stringify(result).includes(String(args.confirmation_text)), false, '原文不进输出')

    // 读侧：readInterviewValue 从事件读回 no_show（原文不返回）
    const read = await readInterviewValue(client, TENANT, interviewId, new Date(NOW).toISOString())
    assert.equal(read.status, 'NO_SHOW')
    assert.ok(read.no_show !== undefined, 'NO_SHOW 必须有 no_show 对象')
    assert.equal(read.no_show.subject, 'CANDIDATE')
    assert.equal(read.no_show.reason, args.reason)
    assert.equal(read.no_show.confirmation_text_sha256, sha256(String(args.confirmation_text)))
    assert.match(read.no_show.recorded_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(JSON.stringify(read).includes(String(args.confirmation_text)), false, '读侧原文不返回')
  })
})

test('subject=INTERVIEWER 走同一条事件（不新增第二种事件类型），payload.subject=INTERVIEWER', async () => {
  await inTx(async (client) => {
    const { interviewId, version } = await createInterview(client)
    await scheduleInTransaction(client, cfg,
      markArgs(interviewId, version, { subject: 'INTERVIEWER' }), NOW, allowOnce)
    const events = await markEvents(client, interviewId)
    assert.equal(events.length, 1)
    assert.equal((events[0]!.payload as Record<string, unknown>).subject, 'INTERVIEWER')
  })
})

// ===========================================================================
//  2. 幂等：同 key 重放 / 不同 key 但已 NO_SHOW → already_marked
// ===========================================================================

test('幂等：同 key 重放 replayed=true 零新增；不同 key 但已 NO_SHOW → already_marked=true 零新增', async () => {
  await inTx(async (client) => {
    const { interviewId, version } = await createInterview(client)
    const args = markArgs(interviewId, version)
    await scheduleInTransaction(client, cfg, args, NOW, allowOnce)

    const before = await writeSnapshot(client)
    const replay = await scheduleInTransaction(client, cfg, args, NOW, allowOnce)
    assert.equal(replay.replayed, true)
    assert.deepEqual(await writeSnapshot(client), before, '同 key 重放零新增')
    assert.equal((await markEvents(client, interviewId)).length, 1, '重放无第二条事件')

    const freshVersion = Number((await client.query<{ record_version: number }>(
      'select record_version from recruitment.interview where id = $1', [interviewId],
    )).rows[0]!.record_version)
    const already = await scheduleInTransaction(client, cfg, markArgs(interviewId, freshVersion), NOW, allowOnce)
    assert.equal(already.already_marked, true)
    assert.equal(already.replayed, false)
    assert.deepEqual(await writeSnapshot(client), before, '不同 key 重复标记零新增')
    assert.equal((await markEvents(client, interviewId)).length, 1, '重复标记无第二条事件')
  })
})

// ===========================================================================
//  3. 负例零写入：每个失败都做 interview / event_inbox before/after 断言
// ===========================================================================

test('负例零写入：缺 reason / 缺 confirmation_text / 版本冲突 / approval 拒绝', async () => {
  await inTx(async (client) => {
    const { interviewId, version } = await createInterview(client)

    const cases: readonly {
      readonly label: string
      readonly args: () => Record<string, unknown>
      readonly code: string
      readonly reasonCode?: string
      readonly approve?: () => Promise<'allowed-once'>
    }[] = [
      {
        label: '缺 reason',
        args: () => {
          const a = markArgs(interviewId, version)
          delete a.reason
          return a
        },
        code: 'INVALID_ARGS',
        reasonCode: 'REASON_REQUIRED',
      },
      {
        label: '缺 confirmation_text',
        args: () => {
          const a = markArgs(interviewId, version)
          delete a.confirmation_text
          return a
        },
        code: 'INVALID_ARGS',
        reasonCode: 'CONFIRMATION_TEXT_REQUIRED',
      },
      {
        label: '版本冲突',
        args: () => markArgs(interviewId, version + 99),
        code: 'VERSION_CONFLICT',
        reasonCode: 'STALE_RECORD_VERSION',
      },
      {
        label: 'approval 拒绝',
        args: () => markArgs(interviewId, version),
        code: 'FORBIDDEN',
        reasonCode: 'APPROVAL_NOT_GRANTED',
        approve: async () => 'rejected' as const,
      },
    ]

    for (const tc of cases) {
      const before = await writeSnapshot(client)
      await expectFailure(
        scheduleInTransaction(client, cfg, tc.args(), NOW, tc.approve ?? allowOnce),
        tc.code,
        tc.reasonCode,
      )
      assert.deepEqual(await writeSnapshot(client), before, `${tc.label}：interview/event_inbox 零新增`)
      assert.equal((await markEvents(client, interviewId)).length, 0, `${tc.label}：无 no_show 事件`)
      assert.equal((await client.query<{ status: string }>(
        'select status from recruitment.interview where id = $1', [interviewId],
      )).rows[0]!.status, 'SCHEDULED', `${tc.label}：状态未变`)
    }

    // 状态不允许：CANCELLED 上 MARK → INVALID_STATE_TRANSITION（不是幂等成功）
    await client.query("update recruitment.interview set status = 'CANCELLED' where id = $1", [interviewId])
    const freshVersion = Number((await client.query<{ record_version: number }>(
      'select record_version from recruitment.interview where id = $1', [interviewId],
    )).rows[0]!.record_version)
    const beforeBad = await writeSnapshot(client)
    await expectFailure(
      scheduleInTransaction(client, cfg, markArgs(interviewId, freshVersion), NOW, allowOnce),
      'INVALID_ARGS',
      'INVALID_STATE_TRANSITION',
    )
    assert.deepEqual(await writeSnapshot(client), beforeBad, 'CANCELLED 上标记零新增')
    assert.equal((await client.query<{ status: string }>(
      'select status from recruitment.interview where id = $1', [interviewId],
    )).rows[0]!.status, 'CANCELLED')
  })
})

test('非法 intent 名 NO_SHOW 仍被闭集拒绝（保持 enum 闭集语义）', async () => {
  await inTx(async (client) => {
    await expectFailure(
      scheduleInTransaction(client, cfg, {
        intent: 'NO_SHOW',
        idempotency_key: `a-bad-${uniqueSuffix()}`,
        interview_id: '11111111-1111-4111-8111-000000000999',
        expected_record_version: 1,
        reason: 'x',
        confirmation_text: 'y',
      }, NOW, allowOnce),
      'INVALID_ARGS',
      'OUT_OF_RANGE',
    )
    assert.equal(await count(client, 'select count(*)::int as n from recruitment.interview'), 0)
  })
})
