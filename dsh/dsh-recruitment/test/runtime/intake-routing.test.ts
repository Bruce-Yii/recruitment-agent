// 事件自动触发链路的**真实库验收**（一次性空库，重放 0001→0014 迁移）。
//
// 守的是修复后的三个真实行为：
//   ① 工具发射的 `resume.intake.received` 行（payload 只有 sha256，没有对象 UUID）
//      能被确定性路由成 `RESUME_PARSE` 任务，业务对象按事件行反查 `intake_record`；
//   ② 工具发射的 `scorecard.submit` 行按 payload 的 `interview_id` 路由成
//      `EVALUATION_SYNTHESIZE`，同一场面试的第二份面评唤醒同一个任务（不建第二个）；
//   ③ 显式登记为 IGNORED 的类型（`decision.record`）落 `REGISTERED_IGNORED`，
//      不建任务；库触发器的 `schema/0001` 审计事件**不进待路由队列**（不是"被 Gate 拒"）。
//
// 事件行用与工具**逐字相同**的 SQL 形状插入（provider/trust/idempotency_source/
// source_object_id/normalizer_version 全对齐），这样这条测试证明的是生产行形状可路由，
// 而不是"测试自己造了一种好处理的行"。真实工具端到端跑一次的证据见
// `src/runtime/evidence/intake-event-routing.evidence.ts`。
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { randomUUID } from 'node:crypto'

import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { createRuntimeTestDatabase, RUNTIME_ACTOR, RUNTIME_TENANT, type RuntimeTestDatabase } from './db.ts'

let db: RuntimeTestDatabase
let store: RuntimeStore
let events: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('intake_route')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  events = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/** 材料 sha256（64 位 hex；它同时也是 `source_object_id`）。 */
function materialSha(seed: string): string {
  return Buffer.from(seed.repeat(64), 'utf8').toString('hex').slice(0, 64)
}

/**
 * 插入一条**与 `application-intake.ts` 的 `upsertIntakeEvent` 逐字同形**的事件行。
 * @returns 事件 id。
 */
async function insertIntakeEvent(seed: string): Promise<string> {
  const sha = materialSha(seed)
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
        idempotency_key, idempotency_source, source_object_id, payload, trust_level,
        normalized_event_type, normalizer_version)
     values ($1, 'internal', $2, 1, now(), now(), now(),
             $3, 'FALLBACK_KEY', $4, $5::jsonb, 'INTERNAL', $2, 'intake/1.0.0')
     returning event_id`,
    [RUNTIME_TENANT, EVENT_TYPES.RESUME_INTAKE_RECEIVED, `resume.intake:${sha}`, sha,
      JSON.stringify({ sha256: sha, file_name: `resume-${seed}.pdf`, pages: 1, source_kind: 'LOCAL_FILE' })],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId !== undefined, 'intake event insert returned no row')
  return eventId
}

/** 插入一条**与 `scorecard-submit.ts` 的 `insertInternalEvent` 同形**的事件行。 */
async function insertScorecardEvent(scorecardId: string, interviewId: string): Promise<string> {
  const { rows } = await db.pool.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, idempotency_key, idempotency_source, source_object_id,
        payload, trust_level, occurred_at, normalized_event_type)
     values ($1, 'internal', $2, $3, 'FALLBACK_KEY', $4, $5::jsonb, 'INTERNAL', now(), $2)
     returning event_id`,
    [RUNTIME_TENANT, EVENT_TYPES.SCORECARD_SUBMIT, `scorecard:${scorecardId}`, scorecardId,
      JSON.stringify({ payload_hash: 'a'.repeat(64), scorecard_id: scorecardId, interview_id: interviewId })],
  )
  const eventId = rows[0]?.event_id
  assert.ok(eventId !== undefined, 'scorecard event insert returned no row')
  return eventId
}

/** 插入一条 `intake_record`（`event_id` 指回事件；这就是路由要反查的那一行）。 */
async function insertIntakeRecord(eventId: string): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `insert into recruitment.intake_record (tenant_id, event_id, subject, status)
     values ($1, $2, 'S6 材料到达（测试）', 'RESOLVED') returning id`,
    [RUNTIME_TENANT, eventId],
  )
  const id = rows[0]?.id
  assert.ok(id !== undefined, 'intake_record insert returned no row')
  return id
}

/** 读一行事件的分发投影。 */
async function readEvent(eventId: string): Promise<Record<string, unknown>> {
  const { rows } = await db.pool.query<Record<string, unknown>>(
    `select dispatch_state, route_attempts, route_error, business_object_type, business_object_id::text,
            routed_task_id::text, routed_at
       from recruitment.event_inbox where tenant_id = $1 and event_id = $2`,
    [RUNTIME_TENANT, eventId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('event row disappeared')
  return row
}

describe('事件自动触发：工具真实事件名 → 确定性路由 → Business Task', () => {
  test('resume.intake.received（裸 sha payload）→ RESUME_PARSE / INTAKE_RECORD 任务 + 唤醒事实', async () => {
    const eventId = await insertIntakeEvent('a1b2c3')
    const intakeRecordId = await insertIntakeRecord(eventId)

    // 路由前：事件已落库、等待处理（工具提交事务后就是这个状态）。
    const before = await readEvent(eventId)
    assert.equal(before.dispatch_state, 'RECEIVED')
    assert.equal(before.routed_task_id, null)

    const routed = await events.processPending()
    const result = routed.find((item) => item.eventId === eventId)
    assert.ok(result !== undefined, 'processPending 没有处理这条事件')
    assert.equal(result.outcome, 'stored')
    // 修复前这里是 IGNORED + SEMANTIC_GATE_REJECTED（整条链断掉的地方）。
    assert.equal(result.dispatchState, 'ROUTED', `expected ROUTED, got ${String(result.reason)}`)
    assert.deepEqual(result.businessObject, { type: 'INTAKE_RECORD', id: intakeRecordId })
    assert.equal(result.taskCreated, true)
    assert.equal(result.wakeInserted, true)

    // ---- 库里读回（不看返回值自述）----
    const after = await readEvent(eventId)
    assert.equal(after.dispatch_state, 'ROUTED')
    assert.equal(after.route_attempts, 1)
    assert.equal(after.route_error, null)
    assert.equal(after.business_object_type, 'INTAKE_RECORD')
    assert.equal(after.business_object_id, intakeRecordId)
    assert.equal(after.routed_task_id, result.taskId)
    assert.ok(after.routed_at !== null)

    const task = await store.readTask(result.taskId!)
    assert.ok(task !== null, 'business_task 行不存在')
    assert.equal(task.task.taskType, 'RESUME_PARSE')
    assert.equal(task.task.status, 'PENDING')
    assert.equal(task.task.idempotencyKey, `task:RESUME_PARSE:INTAKE_RECORD:${intakeRecordId}`)
    assert.deepEqual(task.task.businessRefs, [{ type: 'INTAKE_RECORD', id: intakeRecordId }])
    assert.equal(task.task.triggerEventId, eventId)
    assert.equal(task.task.wakeCount, 1)
    assert.equal(task.task.lastWakeEventId, eventId)
    assert.equal(task.wakeups.length, 1)
    assert.equal(task.wakeups[0]!.eventId, eventId)
    assert.equal(task.wakeups[0]!.wakeSeq, 1)
    assert.equal(task.wakeups[0]!.wakeReason, 'EVENT')

    // ---- 幂等：再跑一轮不会再建任务/再记唤醒 ----
    const secondPass = await events.processPending()
    assert.deepEqual(secondPass, [])
    const again = await store.readTask(result.taskId!)
    assert.equal(again!.task.wakeCount, 1)
    assert.equal(again!.wakeups.length, 1)
  })

  test('resume.intake.received 找不到 intake_record → 明确 IGNORED，不猜 ID、不建任务', async () => {
    const eventId = await insertIntakeEvent('d4e5f6')
    const beforeTasks = await countTasks()

    const routed = await events.processPending()
    const result = routed.find((item) => item.eventId === eventId)
    assert.ok(result !== undefined)
    assert.equal(result.dispatchState, 'IGNORED')
    assert.equal(result.taskId, null)
    assert.match(result.reason ?? '', /^BUSINESS_OBJECT_NOT_FOUND: /)
    assert.match(result.reason ?? '', /INTAKE_RECORD/)
    assert.equal(await countTasks(), beforeTasks)

    const row = await readEvent(eventId)
    assert.equal(row.dispatch_state, 'IGNORED')
    assert.match(String(row.route_error), /^BUSINESS_OBJECT_NOT_FOUND: /)
  })

  test('scorecard.submit → EVALUATION_SYNTHESIZE / INTERVIEW；同场第二份面评唤醒同一任务', async () => {
    const interviewId = randomUUID()
    const firstEvent = await insertScorecardEvent(randomUUID(), interviewId)

    const routed = await events.processPending()
    const first = routed.find((item) => item.eventId === firstEvent)
    assert.ok(first !== undefined)
    assert.equal(first.dispatchState, 'ROUTED')
    assert.deepEqual(first.businessObject, { type: 'INTERVIEW', id: interviewId })
    assert.equal(first.taskCreated, true)

    const firstTask = await store.readTask(first.taskId!)
    assert.equal(firstTask!.task.taskType, 'EVALUATION_SYNTHESIZE')
    assert.equal(firstTask!.task.idempotencyKey, `task:EVALUATION_SYNTHESIZE:INTERVIEW:${interviewId}`)

    // 同一场面试的第二份面评（另一个 scorecard id / 事件）→ 同一 Task，wake_count +1。
    const secondEvent = await insertScorecardEvent(randomUUID(), interviewId)
    const secondPass = await events.processPending()
    const second = secondPass.find((item) => item.eventId === secondEvent)
    assert.ok(second !== undefined)
    assert.equal(second.dispatchState, 'ROUTED')
    assert.equal(second.taskId, first.taskId)
    assert.equal(second.taskCreated, false)
    assert.equal(second.wakeInserted, true)

    const view = await store.readTask(first.taskId!)
    assert.equal(view!.task.wakeCount, 2)
    assert.deepEqual(view!.wakeups.map((wake) => wake.eventId), [firstEvent, secondEvent])
    // still exactly one task for this interview
    const { rows } = await db.pool.query<{ n: string }>(
      `select count(*)::text as n from recruitment.business_task
        where tenant_id = $1 and idempotency_key = $2`,
      [RUNTIME_TENANT, `task:EVALUATION_SYNTHESIZE:INTERVIEW:${interviewId}`],
    )
    assert.equal(Number(rows[0]?.n), 1)
  })

  test('decision.record 被显式登记为 IGNORED：路由后落 REGISTERED_IGNORED，不建任务', async () => {
    const { rows } = await db.pool.query<{ event_id: string }>(
      `insert into recruitment.event_inbox
         (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
          idempotency_key, idempotency_source, source_object_id, payload, trust_level,
          normalized_event_type, normalizer_version)
       values ($1, 'internal', $2, 1, now(), now(), now(),
               $3, 'FALLBACK_KEY', $4, $5::jsonb, 'INTERNAL', $2, 'schema/evaluation-2.0.0')
       returning event_id`,
      [RUNTIME_TENANT, EVENT_TYPES.DECISION_RECORD, `decision:${randomUUID()}`, randomUUID(),
        JSON.stringify({ application_id: randomUUID(), result: 'ADVANCE' })],
    )
    const eventId = rows[0]!.event_id
    const beforeTasks = await countTasks()

    const routed = await events.processPending()
    const result = routed.find((item) => item.eventId === eventId)
    assert.ok(result !== undefined)
    assert.equal(result.dispatchState, 'IGNORED')
    assert.equal(result.taskId, null)
    assert.match(result.reason ?? '', /^REGISTERED_IGNORED: /)
    assert.doesNotMatch(result.reason ?? '', /SEMANTIC_GATE_REJECTED/)
    assert.equal(await countTasks(), beforeTasks)
  })

  test('库触发器的 schema/0001 审计事件不进待路由队列（不是"被 Gate 拒"）', async () => {
    const { rows } = await db.pool.query<{ event_id: string }>(
      `insert into recruitment.event_inbox
         (tenant_id, provider, provider_event_id, event_type, schema_version,
          occurred_at, received_at, recorded_at, idempotency_key, idempotency_source,
          source_object_id, payload, trust_level, normalized_event_type, normalizer_version)
       values ($1, 'internal', null, 'approval.status.changed', 1,
               now(), now(), now(), $2, 'FALLBACK_KEY', $3, '{}'::jsonb, 'INTERNAL',
               'approval.status.changed', 'schema/0001')
       returning event_id`,
      [RUNTIME_TENANT, `approval:${randomUUID()}`, randomUUID()],
    )
    const eventId = rows[0]!.event_id
    const pending = await store.listPendingEvents(50, 5)
    assert.equal(pending.includes(eventId), false, 'schema/0001 的审计事件不该出现在待路由队列里')
    const routed = await events.processPending()
    assert.equal(routed.some((item) => item.eventId === eventId), false)
    // 它保持 RECEIVED（审计事实，不参与自动触发），从未被计一次路由尝试。
    const row = await readEvent(eventId)
    assert.equal(row.dispatch_state, 'RECEIVED')
    assert.equal(row.route_attempts, 0)
  })
})

/** 当前租户的 Business Task 总数。 */
async function countTasks(): Promise<number> {
  const { rows } = await db.pool.query<{ n: string }>(
    'select count(*)::text as n from recruitment.business_task where tenant_id = $1',
    [RUNTIME_TENANT],
  )
  return Number(rows[0]?.n ?? '0')
}
