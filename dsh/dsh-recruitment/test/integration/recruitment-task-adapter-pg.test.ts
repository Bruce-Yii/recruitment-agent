// 招聘领域适配层 × 真实 PostgreSQL 集成测试（本 lane 自写）。
//
// 证明的是「引擎的任务模型 ↔ 招聘既有执行表」真的接通了，而不是两套模型各自为政：
//   Ticket      → recruitment.business_task   （任务身份、业务引用、状态机、错误码）
//   Assignment  → recruitment.task_attempt    （第几次尝试、租约、结尾、错误分类）
//   worker 会话 → recruitment.agent_session   （DSH 会话与任务/尝试的关联）
//
// 断言全部走另一条 pg 连接读表；并且断言既有护栏**没有被绕过**：
//   状态 UPDATE 必须写 internal 审计事件（fn_row_guard），FAILED 没 error_code 必须被数据库拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { testDatabaseConfig } from './db.ts'
import { Store } from '../../src/engine/app/store.ts'
import { HealthBoard } from '../../src/engine/infra/health.ts'
import type { Assignment, Ticket } from '../../src/engine/core/index.ts'
import {
  RecruitmentTaskAdapter, attemptIdOf, businessTaskStatusOf, sessionIdOf, taskIdOf, taskAttemptStatusOf,
} from '../../src/engine/adapters/recruitment-tasks.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
/** 租户里已存在的 HUMAN actor（0002 种子）；状态迁移审计用它。 */
const ACTOR = '11111111-1111-4111-8111-000000000103'
const APPLICATION_ID = '11111111-1111-4111-8111-0000000009f1'

const TICKET_ID = 'domain-adapt-ticket-1'
const ASSIGNMENT_ID = 'domain-adapt-assignment-1'
const SESSION_LABEL = 'recruitment-worker-domain-adapt-ticket-1'

/** 构造一张最小可用的 Ticket（pending assignment）。 */
function pendingTicket(): Ticket {
  const now = new Date().toISOString()
  const assignment: Assignment = { id: ASSIGNMENT_ID, state: 'pending', createdAt: now }
  return {
    id: TICKET_ID, title: '面试安排：张三 / 后端工程师', decisionId: 'd-adapt-1',
    mandate: { strength: 'explicit', policyVersion: 'adapt-1', basis: { via: 'addressed', addressed: 'mention' },
      actor: { source: 'probe', id: ACTOR }, scope: 'scheduling' },
    channels: [], assignments: [assignment], inputs: [], undelivered: [], createdAt: now, updatedAt: now,
    origin: { triggerId: 'tg-adapt-1', triggerIds: ['tg-adapt-1'] },
  }
}

const withAssignment = (ticket: Ticket, patch: Partial<Assignment>): Ticket => ({
  ...ticket,
  assignments: [{ ...ticket.assignments[0]!, ...patch }],
})

test('Ticket/Assignment/会话 映射到 business_task/task_attempt/agent_session', async () => {
  const cfg = testDatabaseConfig()
  const board = new HealthBoard()
  const sidecar = new pg.Client({ host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password })
  await sidecar.connect()
  const store = new Store({
    host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database, password: cfg.password,
    tenant_id: TENANT, statementTimeoutMs: 5_000, applicationName: 'recruitment-task-adapter-test',
  }, undefined, board.claim('store'))
  const adapter = new RecruitmentTaskAdapter(store, {
    tenantId: TENANT, actorId: ACTOR, runtimeVersion: 'dsh@0.2.2-rc.3', modelRoute: 'deepseek-chat', taskType: 'INTERVIEW_SCHEDULING',
  })
  const taskId = taskIdOf(TICKET_ID)
  const attemptId = attemptIdOf(ASSIGNMENT_ID)

  const cleanup = async () => {
    await sidecar.query('set session_replication_role = replica')
    try {
      // 顺序：会话 → 尝试 → 任务（外键方向）；event_inbox 只删本测试的 internal 事件。
      await sidecar.query('delete from recruitment.agent_session where task_id = $1', [taskId])
      await sidecar.query('delete from recruitment.task_attempt where task_id = $1', [taskId])
      await sidecar.query('delete from recruitment.business_task where id = $1', [taskId])
      await sidecar.query("delete from recruitment.event_inbox where provider = 'internal' and payload ->> 'record_id' in ($1, $2)", [taskId, attemptId])
    } finally {
      await sidecar.query('set session_replication_role = default')
    }
  }

  try {
    await cleanup()

    // ── 1. 初次投影：Ticket → business_task(READY) + task_attempt(CLAIMED) ──
    const ticket = pendingTicket()
    assert.equal(businessTaskStatusOf(ticket), 'READY')
    adapter.project(ticket, [{ kind: 'application', id: APPLICATION_ID }])

    const task = await adapter.readTask(TICKET_ID) as Record<string, unknown>
    assert.equal(task.id, taskId, '任务主键必须是由 ticketId 派生的确定性 UUID')
    assert.equal(task.status, 'READY')
    assert.equal(task.attempt_count, 1)
    assert.deepEqual(task.business_refs, [{ type: 'application', id: APPLICATION_ID }], '业务引用必须落 business_refs')
    const raw = await sidecar.query('select idempotency_key, task_type, title from recruitment.business_task where id = $1', [taskId])
    assert.equal(raw.rows[0].idempotency_key, `engine:ticket:${TICKET_ID}`, '同一 ticket 只能有一条任务（幂等键）')
    assert.equal(raw.rows[0].task_type, 'INTERVIEW_SCHEDULING')

    const attempt = await adapter.readAttempt(ASSIGNMENT_ID) as Record<string, unknown>
    assert.equal(attempt.task_id, taskId)
    assert.equal(attempt.attempt_no, 1)
    assert.equal(attempt.status, 'CLAIMED')
    assert.equal(attempt.worker_type, 'DSH')

    // 幂等：再投影一次不新增行。
    adapter.project(ticket, [{ kind: 'application', id: APPLICATION_ID }])
    const counts = await sidecar.query(`select
        (select count(*)::int from recruitment.business_task where id = $1) tasks,
        (select count(*)::int from recruitment.task_attempt where task_id = $1) attempts`, [taskId])
    assert.equal(counts.rows[0].tasks, 1, '重复投影不得产生第二条任务')
    assert.equal(counts.rows[0].attempts, 1, '重复投影不得产生第二次尝试')

    // ── 2. 推进到 running：任务 RUNNING + current_attempt_id + 审计事件 ──
    const running = withAssignment(ticket, { state: 'running', startedAt: new Date().toISOString() })
    assert.equal(taskAttemptStatusOf(running.assignments[0]!), 'RUNNING')
    adapter.project(running, [{ kind: 'application', id: APPLICATION_ID }])
    const runningTask = await adapter.readTask(TICKET_ID) as Record<string, unknown>
    assert.equal(runningTask.status, 'RUNNING')
    assert.equal(runningTask.current_attempt_id, attemptId, 'RUNNING 必须指向当前 attempt（DB 约束 ck_business_task_running）')
    assert.ok(Number(runningTask.record_version) >= 2, '状态迁移必须让 record_version 自增')
    assert.ok((runningTask.status_source_event_id ?? '') !== '', '状态迁移必须带 status_source_event_id（fn_row_guard 写入）')
    assert.ok(adapter.statusEventCount(TICKET_ID) >= 1, '状态迁移必须写一条 internal 审计事件')
    const runningAttempt = await adapter.readAttempt(ASSIGNMENT_ID) as Record<string, unknown>
    assert.equal(runningAttempt.status, 'RUNNING')
    assert.ok(runningAttempt.started_at, 'RUNNING 的 attempt 必须有 started_at')
    assert.equal((adapter.readTask(TICKET_ID) as { error_code?: unknown }).error_code, null)

    // ── 3. 会话：ACTIVE → ENDED，挂到 task/attempt 上 ────────────────────
    adapter.projectSession({ ticketId: TICKET_ID, assignmentId: ASSIGNMENT_ID, sessionLabel: SESSION_LABEL, status: 'ACTIVE' })
    const session = await adapter.readSession(SESSION_LABEL) as Record<string, unknown>
    assert.equal(session.id, sessionIdOf(SESSION_LABEL))
    assert.equal(session.task_id, taskId)
    assert.equal(session.attempt_id, attemptId)
    assert.equal(session.status, 'ACTIVE')
    assert.equal(session.runtime_version, 'dsh@0.2.2-rc.3')
    adapter.projectSession({ ticketId: TICKET_ID, assignmentId: ASSIGNMENT_ID, sessionLabel: SESSION_LABEL, status: 'ENDED' })
    assert.equal((await adapter.readSession(SESSION_LABEL) as Record<string, unknown>).status, 'ENDED')
    assert.ok((await adapter.readSession(SESSION_LABEL) as Record<string, unknown>).ended_at, 'ENDED 的会话必须有 ended_at')

    // ── 4. 完成：Ticket ended(completed) → 任务 SUCCEEDED + 尝试 SUCCEEDED ─
    const done: Ticket = {
      ...withAssignment(ticket, { state: 'ended', startedAt: running.assignments[0]!.startedAt, endedAt: new Date().toISOString(),
        report: { state: 'ready', summary: '已安排 2026-11-20 14:00 面试', at: new Date().toISOString() } }),
      ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed' },
    }
    adapter.project(done, [{ kind: 'application', id: APPLICATION_ID }, { kind: 'interview', id: 'interview-1' }], { taskType: 'INTERVIEW_SCHEDULING' })
    const finishedTask = await adapter.readTask(TICKET_ID) as Record<string, unknown>
    assert.equal(finishedTask.status, 'SUCCEEDED')
    assert.ok(finishedTask.completed_at, '终态必须落 completed_at')
    const finishedAttempt = await adapter.readAttempt(ASSIGNMENT_ID) as Record<string, unknown>
    assert.equal(finishedAttempt.status, 'SUCCEEDED')
    assert.ok(finishedAttempt.ended_at, '终态 attempt 必须落 ended_at')
    assert.equal((finishedTask.business_refs as unknown[]).length, 2, '业务引用必须随状态下发（application + interview）')

    // 完成后不再占唯一有效租约：可以在同一 task 上再开一次尝试。
    await sidecar.query("update recruitment.task_attempt set lease_expires_at = claimed_at + interval '1 millisecond' where id = $1", [attemptId])
    const retryAttempt = await sidecar.query(`select 1 from recruitment.task_attempt
      where task_id = $1 and status in ('CLAIMED','RUNNING')`, [taskId])
    assert.equal(retryAttempt.rows.length, 0, '终态任务不得留下有效租约')

    // ── 5. 护栏没被绕过：两条既有护栏逐条验证 ─────────────────────────
    // 5a. 状态迁移没有 actor → fn_row_guard 直接拒绝（ACTOR_REQUIRED）。
    await assert.rejects(
      async () => { await sidecar.query("update recruitment.business_task set status = 'FAILED' where id = $1", [taskId]) },
      /ACTOR_REQUIRED/,
      '状态迁移没有 actor 时，数据库必须拒绝',
    )
    // 5b. 给了 actor 但 FAILED 没有 error_code → ck_business_task_failed 拒绝。
    await sidecar.query('begin')
    try {
      await sidecar.query("select set_config('recruitment.actor_id', $1, true)", [ACTOR])
      await assert.rejects(
        async () => { await sidecar.query("update recruitment.business_task set status = 'FAILED' where id = $1", [taskId]) },
        /ck_business_task_failed|violates check constraint/i,
        'FAILED 状态没有 error_code 时，数据库必须拒绝',
      )
    } finally {
      await sidecar.query('rollback')
    }
  } finally {
    await cleanup()
    await sidecar.end()
    store.close()
  }
})

test('状态映射是纯函数，逐条对上既有 schema 的状态机', () => {
  const ticket = pendingTicket()
  const cases: [string, Ticket, string][] = [
    ['无 report 有 pending attempt', ticket, 'READY'],
    ['有 running attempt', withAssignment(ticket, { state: 'running' }), 'RUNNING'],
    ['等待外部', withAssignment(ticket, { state: 'running', report: { state: 'waiting', summary: '等面试官确认', at: new Date().toISOString() } }), 'WAITING_EXTERNAL'],
    ['需要人回答', { ...withAssignment(ticket, { state: 'running' }), attention: { id: 'a-1', question: '这个候选人面哪个岗位？' } }, 'WAITING_HUMAN'],
    ['投递失败', { ...withAssignment(ticket, { state: 'running' }), delivery: { error: 'session gone', at: new Date().toISOString() } }, 'RETRY_WAIT'],
    ['完成', { ...ticket, ended: { at: new Date().toISOString(), by: 'executor', outcome: 'completed' } }, 'SUCCEEDED'],
    ['被人叫停', { ...ticket, ended: { at: new Date().toISOString(), by: 'human', outcome: 'stopped' } }, 'CANCELLED'],
  ]
  for (const [name, fixture, expected] of cases) {
    assert.equal(businessTaskStatusOf(fixture), expected, name)
  }
})
