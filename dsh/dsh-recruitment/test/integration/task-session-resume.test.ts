// G2 续跑会话复用回归（P0 缺陷，2026-11-15）：
//   一个 DSH Session 只能对应一行 agent_session（`contracts/runtime/task-runtime.md §1`）。
//   续跑（`resume_sessions=true` + 上次 `runtime_session_id`）时，`store.createAgentSession`
//   必须**接管既有行**（attempt_id=新 Attempt、status=ACTIVE），而不是插新行；否则
//   `finishAttempt` 再把同一个 `runtime_session_id` 写回新行会撞
//   `uq_agent_session_runtime (tenant_id, runtime_kind, runtime_session_id)`，整个收尾事务回滚，
//   Attempt 永久停在 RUNNING（现场证据：work/verify-2026-11-15-g2/B/logs/kill-worker-driver-b.log）。
//
// 这里用 ScriptedWorkerLauncher（明确测试替身）验证**库语义**；真实 DSH 续跑证据见
// work/verify-2026-11-15-g2/B/session/kill-worker-session.*（同一 session 日志出现 turn 1+2）。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { WorkerLauncher } from '../../src/runtime/types.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from '../runtime/scripted-worker.ts'
import { createIsolatedTestDatabase, HR_ACTOR, TENANT, type IsolatedTestDatabase } from './db.ts'

let db: IsolatedTestDatabase
let store: RuntimeStore
let events: EventRuntime

before(async () => {
  db = await createIsolatedTestDatabase('g2_resume')
  store = new RuntimeStore({ pool: db.pool, tenantId: TENANT, actorId: HR_ACTOR })
  events = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/** 用一条真实的确定性事件建 Task（与 test/runtime/task-runtime.test.ts 同一口径）。 */
async function newTask(): Promise<string> {
  const result = await events.receive({
    tenantId: TENANT,
    provider: 'internal',
    providerEventId: `evt-${randomUUID()}`,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    payload: { interview_id: randomUUID() },
    trustLevel: 'INTERNAL',
  })
  assert.equal(result.dispatchState, 'ROUTED')
  assert.ok(result.taskId !== null)
  return result.taskId
}

/**
 * 造"上一次已经跑过"的现场：attempt#1（SUCCEEDED）+ 一行 agent_session（已 ENDED，
 * 带真实 DSH Session id）。续跑路径必须命中这一行并接管它。
 */
async function seedPriorAttemptAndSession(
  taskId: string,
  runtimeSessionId: string,
): Promise<{ attemptId: string; sessionId: string }> {
  const attempt = await db.pool.query<{ id: string }>(
    `insert into recruitment.task_attempt (
       tenant_id, task_id, attempt_no, worker_type, worker_id, status,
       claimed_at, lease_expires_at, started_at, ended_at
     ) values (
       $1::uuid, $2::uuid, 1, 'SCRIPTED_WORKER', 'test-router', 'SUCCEEDED',
       now() - interval '12 seconds', now() + interval '60 seconds',
       now() - interval '10 seconds', now()
     ) returning id::text`,
    [TENANT, taskId],
  )
  const attemptId = attempt.rows[0]?.id
  assert.ok(attemptId !== undefined)
  const session = await db.pool.query<{ id: string }>(
    `insert into recruitment.agent_session (
       tenant_id, task_id, attempt_id, runtime_kind, runtime_version, model_route,
       runtime_session_id, runtime_worker_role, status, started_at, ended_at, last_heartbeat_at
     ) values (
       $1::uuid, $2::uuid, $3::uuid, 'SCRIPTED', 'scripted-1.0.0', 'scripted/test-double',
       $4, 'WORKER', 'ENDED', now() - interval '10 seconds', now(), now()
     ) returning id::text`,
    [TENANT, taskId, attemptId, runtimeSessionId],
  )
  const sessionId = session.rows[0]?.id
  assert.ok(sessionId !== undefined)
  return { attemptId, sessionId }
}

function taskRuntime(launcher: WorkerLauncher, resumeSessions: boolean): TaskRuntime {
  return new TaskRuntime({
    store,
    launcher,
    workerType: 'SCRIPTED_WORKER',
    workerId: 'test-router',
    leaseMs: 60_000,
    maxAttempts: 3,
    resumeSessions,
    workspaceRoot: `${process.cwd()}/.g2-resume-work`,
  })
}

describe('G2 resume: one DSH session maps to exactly one agent_session row', () => {
  test('续跑接管既有 session 行：不撞 uq_agent_session_runtime，attempt 1→2，task 不变', async () => {
    const taskId = await newTask()
    const RESUME_ID = `session-dsh-resume-${randomUUID()}`
    const prior = await seedPriorAttemptAndSession(taskId, RESUME_ID)
    const launcher = new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { resultRef: 'row:g2-resume', runtimeSessionId: RESUME_ID }),
    ])

    const result = await taskRuntime(launcher, true).dispatchTask(taskId, new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(result.attemptNo, 2, '续跑是新 Attempt（attempt_no 递增），Task 身份不变')
    assert.equal(result.taskId, taskId)
    assert.equal(result.resumedSession, true)
    assert.equal(
      launcher.calls[0]?.resumeSessionId,
      RESUME_ID,
      'Router 必须把上次的 DSH Session id 传给 Worker（--session-id 来源）',
    )

    const sessions = await db.pool.query<Record<string, unknown>>(
      `select id::text as id, attempt_id::text as attempt_id, status, runtime_session_id, task_id::text as task_id
         from recruitment.agent_session
        where tenant_id = $1::uuid and task_id = $2::uuid
        order by started_at`,
      [TENANT, taskId],
    )
    assert.equal(sessions.rows.length, 1, '一个 DSH Session 只能对应一行 agent_session（契约 §1）')
    const session = sessions.rows[0]!
    assert.equal(session.id, prior.sessionId, '必须接管既有行，不是插新行')
    assert.equal(session.attempt_id, result.attemptId, 'agent_session.attempt_id 指向最新 Attempt')
    assert.equal(session.runtime_session_id, RESUME_ID)
    assert.equal(session.status, 'ENDED', '收尾后 Session ENDED（Attempt 终态）')
    assert.equal(session.task_id, taskId)

    const attempts = await db.pool.query<{ attempt_no: number; status: string }>(
      `select attempt_no, status from recruitment.task_attempt
        where tenant_id = $1::uuid and task_id = $2::uuid order by attempt_no`,
      [TENANT, taskId],
    )
    assert.deepEqual(
      attempts.rows.map((row) => [row.attempt_no, row.status]),
      [[1, 'SUCCEEDED'], [2, 'SUCCEEDED']],
    )
    const task = await db.pool.query<{ status: string; attempt_count: number }>(
      'select status, attempt_count from recruitment.business_task where tenant_id = $1::uuid and id = $2::uuid',
      [TENANT, taskId],
    )
    assert.equal(task.rows[0]?.status, 'SUCCEEDED')
    assert.equal(task.rows[0]?.attempt_count, 2)
  })

  test('非续跑（resume_sessions=false）仍然插新的 session 行（旧逻辑不变）', async () => {
    const taskId = await newTask()
    const prior = await seedPriorAttemptAndSession(taskId, `session-old-${randomUUID()}`)
    const newSessionId = `session-new-${randomUUID()}`
    const launcher = new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { runtimeSessionId: newSessionId }),
    ])

    const result = await taskRuntime(launcher, false).dispatchTask(taskId, new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(result.resumedSession, false)
    assert.equal(launcher.calls[0]?.resumeSessionId, null, '不续跑时不传 --session-id')

    const sessions = await db.pool.query<Record<string, unknown>>(
      `select id::text as id, attempt_id::text as attempt_id, status, runtime_session_id
         from recruitment.agent_session
        where tenant_id = $1::uuid and task_id = $2::uuid`,
      [TENANT, taskId],
    )
    assert.equal(sessions.rows.length, 2, '非续跑 = 新会话，多一行 session 是正确语义')
    const fresh = sessions.rows.find((row) => row.id === result.agentSessionId)
    assert.ok(fresh !== undefined)
    assert.equal(fresh.attempt_id, result.attemptId)
    assert.equal(fresh.runtime_session_id, newSessionId)
    assert.equal(fresh.status, 'ENDED')
    const priorRow = sessions.rows.find((row) => row.id === prior.sessionId)
    assert.ok(priorRow !== undefined)
    assert.equal(priorRow.runtime_session_id?.startsWith('session-old-'), true, '旧 Session 行不被改写/删除')
  })
})
