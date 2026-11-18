// AT-4 / AT-5 的**真库读回**证据（连 `ra_s6s7`，每个用例在必然回滚的事务里跑）。
// 需要 db/migrations/0018_atomic_capabilities.sql 已应用（db/verify.sql AT-STRUCT-B PASS）。
//
// 覆盖：
//   AT-4：round_label 落库 + round_no / uq_interview_slot 语义不变（同 slot 再 CREATE → ALREADY_SCHEDULED）；
//   AT-5：换人后旧行保留并带 replaced_* + required_scorecard=false，新行 required_scorecard=true，
//         event_inbox 复用 interviewer.withdrawn，读投影有 round_label / replacements；
//   负例：无批准 / 新人已在场 / 同演员 / CANCELLED 场次 → 零写入。
import test from 'node:test'
import assert from 'node:assert/strict'

import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool, errorBody, inRolledBackTx, one, seedScenario, testDatabaseConfig,
  uniqueSuffix, TENANT,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)
test.after(async () => { await pool.end() })

const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000102'
const NOW = Date.parse('2030-12-01T00:00:00Z')
// 远期 + 进程随机偏移：共享库里不会有别的提交占用同一时段/面试官。
const SLOT_BASE = Date.parse('2032-01-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
/** 同一事务里多场面试必须错开时段，否则共享面试官会命中 CONFLICT_SLOT（测的就不是 AT-5 了）。 */
const startAt = (offsetMinutes: number): string => new Date(SLOT_BASE + offsetMinutes * 60_000).toISOString()
const START = startAt(0)
const LABEL = '加面 · 交叉评估'
const REASON = '原面试官临时出差'

const DIMENSIONS = [{
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1,
  field: 'work_experience', operator: 'EXISTS', value: true,
}]

const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'

function schedule(client: DatabaseClient, args: Record<string, unknown>, approve = allowOnce) {
  return scheduleInTransaction(client, cfg, args, NOW, approve)
}

function createArgs(
  applicationId: string,
  overrides: Record<string, unknown> = {},
  start: string = START,
): Record<string, unknown> {
  return {
    intent: 'CREATE',
    idempotency_key: `atb-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: INTERVIEWER_A }],
    scheduled_start_at: start,
    duration_minutes: 60,
    ...overrides,
  }
}

async function counts(client: DatabaseClient): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of ['interview', 'interviewer', 'business_task', 'event_inbox']) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
    result[table] = rows[0]?.n ?? -1
  }
  return result
}

async function expectError(run: Promise<unknown>, reasonCode: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(errorBody(error).reason_code, reasonCode)
    return true
  })
}

// ---------------------------------------------------------------------------

test('AT-4 DB 读回：round_label 落库；round_no / uq_interview_slot 不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const value = await schedule(client, createArgs(scenario.applicationId, { round_label: `  ${LABEL}  ` }))
    const interview = value.interview as Record<string, unknown>
    const interviewId = String(interview.id)
    assert.equal(interview.round_label, LABEL, 'trim 后回显')
    assert.equal(interview.round_no, 1)

    const { rows } = await client.query<Record<string, unknown>>(
      `select round_no, slot_code, round_label from recruitment.interview
        where id = $1 and tenant_id = $2`,
      [interviewId, TENANT],
    )
    assert.equal(rows[0]?.round_label, LABEL)
    assert.equal(rows[0]?.round_no, 1, 'AT-4 绝不改写 round_no')
    assert.equal(rows[0]?.slot_code, 'DEFAULT')

    // 唯一键语义不变：同 (application, round_no, slot_code) 再次 CREATE → ALREADY_SCHEDULED。
    await expectError(schedule(client, createArgs(scenario.applicationId, { round_label: '另一标签' })), 'SLOT_OCCUPIED')
  })
})

test('AT-5 DB 读回：旧行 replaced_* + required_scorecard=false；新行 true；审计事件复用已登记类型', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await schedule(client, createArgs(scenario.applicationId, { round_label: LABEL }))
    const interview = created.interview as Record<string, unknown>
    const interviewId = String(interview.id)
    const version = Number(interview.record_version)

    const before = await counts(client)
    const value = await schedule(client, {
      intent: 'REPLACE_INTERVIEWER',
      idempotency_key: `atb-${uniqueSuffix()}`,
      interview_id: interviewId,
      expected_record_version: version,
      replace_interviewer: { from_actor_id: INTERVIEWER_A, to_actor_id: INTERVIEWER_B, reason: REASON },
    })
    assert.equal(value.replayed, false)

    // (a) 旧行不删、带齐三列替换标记；required_scorecard=false（旧人不再阻塞 Evaluation Ready）。
    const oldRow = (await client.query<Record<string, unknown>>(
      `select id, actor_id, required_scorecard, replaced_by_interviewer_id, replaced_at, replacement_reason
         from recruitment.interviewer
        where tenant_id = $1 and interview_id = $2 and actor_id = $3`,
      [TENANT, interviewId, INTERVIEWER_A],
    )).rows[0]
    assert.ok(oldRow !== undefined, '旧行必须保留（AT-5）')
    assert.equal(oldRow.required_scorecard, false)
    assert.ok(typeof oldRow.replaced_by_interviewer_id === 'string')
    assert.ok(oldRow.replaced_at instanceof Date)
    assert.equal(oldRow.replacement_reason, REASON)

    // (b) 新行存在、required_scorecard=true（新人拥有面评）、角色从旧行复制。
    const newRow = (await client.query<Record<string, unknown>>(
      `select id, actor_id, role_in_interview, required_scorecard, replaced_by_interviewer_id
         from recruitment.interviewer
        where tenant_id = $1 and interview_id = $2 and actor_id = $3`,
      [TENANT, interviewId, INTERVIEWER_B],
    )).rows[0]
    assert.ok(newRow !== undefined, '新人分配行必须落库')
    assert.equal(newRow.required_scorecard, true)
    assert.equal(newRow.role_in_interview, 'INTERVIEWER')
    // 旧行的 replaced_by_interviewer_id 指向新行；新行自己没有 replaced_* 标记。
    assert.equal(oldRow.replaced_by_interviewer_id, newRow.id)
    assert.equal(newRow.replaced_by_interviewer_id, null)
    assert.notEqual(newRow.id, oldRow.id)
    assert.equal((await counts(client)).interviewer, before.interviewer + 1, '只追加一行，旧行不删')

    // (c) 审计事件复用已登记类型，payload 带完整换人事实。
    const events = (await client.query<Record<string, unknown>>(
      `select event_type, normalizer_version, payload
         from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'interviewer.withdrawn'
          and payload->>'interview_id' = $2`,
      [TENANT, interviewId],
    )).rows
    const replacement = events.find((row) => (row.payload as Record<string, unknown>).replacement_interviewer_id === newRow.id)
    assert.ok(replacement !== undefined)
    assert.equal(replacement.normalizer_version, 'schema/interview-schedule')
    const payload = replacement.payload as Record<string, unknown>
    assert.equal(payload.from_actor_id, INTERVIEWER_A)
    assert.equal(payload.to_actor_id, INTERVIEWER_B)
    assert.equal(payload.reason, REASON)
    assert.equal(payload.interview_id, interviewId)
    assert.equal(payload.interviewer_id, undefined, '不能写 interviewer_id 冒充 WITHDRAW 的幂等判重键')

    // (d) 读回投影（grep 证据：round_label + replacements + 旧人 required_scorecard=false）。
    const read = value.interview as Record<string, unknown>
    assert.equal(read.round_label, LABEL)
    assert.deepEqual(read.replacements, [{
      from_actor_id: INTERVIEWER_A, to_actor_id: INTERVIEWER_B, reason: REASON,
      replaced_at: oldRow.replaced_at instanceof Date
        ? oldRow.replaced_at.toISOString()
        : new Date(String(oldRow.replaced_at)).toISOString(),
    }])
  })
})

test('AT-5 DB 负例：无批准 / 新人已在场 / CANCELLED 场次 → 零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
    const created = await schedule(client, createArgs(scenario.applicationId))
    const interview = created.interview as Record<string, unknown>
    const interviewId = String(interview.id)
    const version = Number(interview.record_version)
    const base = {
      intent: 'REPLACE_INTERVIEWER',
      idempotency_key: `atb-${uniqueSuffix()}`,
      interview_id: interviewId,
      expected_record_version: version,
    }

    // 1. 无批准（D-79）：FORBIDDEN，零写入。
    let before = await counts(client)
    await assert.rejects(
      schedule(client, { ...base, replace_interviewer: { from_actor_id: INTERVIEWER_A, to_actor_id: INTERVIEWER_B, reason: REASON } }, async () => 'rejected'),
      /FORBIDDEN/,
    )
    assert.deepEqual(await counts(client), before)

    // 2. 新人已在场（uq_interviewer 的前置检查）：INTERVIEWER_ALREADY_ASSIGNED，零写入。
    await one(client,
      `insert into recruitment.interviewer
         (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
       values ($1, $2, $3, 'INTERVIEWER', true) returning id`,
      [TENANT, interviewId, INTERVIEWER_B],
    )
    before = await counts(client)
    await expectError(schedule(client, {
      ...base, idempotency_key: `atb-${uniqueSuffix()}`,
      replace_interviewer: { from_actor_id: INTERVIEWER_A, to_actor_id: INTERVIEWER_B, reason: REASON },
    }), 'INTERVIEWER_ALREADY_ASSIGNED')
    assert.deepEqual(await counts(client), before)

    // 3. CANCELLED 场次：INVALID_STATE_TRANSITION，零写入。
    const cancelledScenario = await seedScenario(client, { dimensions: DIMENSIONS })
    // 独立时段：与本事务第一场错开 24h，避免共享面试官触发 CONFLICT_SLOT（与 AT-5 无关的干扰）。
    const cancelled = await schedule(client, createArgs(cancelledScenario.applicationId, {}, startAt(1440)))
    const cancelledValue = cancelled.interview as Record<string, unknown>
    await schedule(client, {
      intent: 'CANCEL', idempotency_key: `atb-${uniqueSuffix()}`,
      interview_id: String(cancelledValue.id),
      expected_record_version: Number(cancelledValue.record_version),
      reason: '测试取消',
    })
    const fresh = (await client.query<{ record_version: number }>(
      `select record_version from recruitment.interview where id = $1 and tenant_id = $2`,
      [cancelledValue.id, TENANT],
    )).rows[0]
    before = await counts(client)
    await expectError(schedule(client, {
      intent: 'REPLACE_INTERVIEWER', idempotency_key: `atb-${uniqueSuffix()}`,
      interview_id: String(cancelledValue.id),
      expected_record_version: fresh?.record_version ?? 1,
      replace_interviewer: { from_actor_id: INTERVIEWER_A, to_actor_id: INTERVIEWER_B, reason: REASON },
    }), 'INVALID_STATE_TRANSITION')
    assert.deepEqual(await counts(client), before)
  })
})
