// Task/Attempt/Session 三层身份的验收：真实 PG（空库 0001→0011）+ scripted Worker。
//
// 覆盖：
//   * Worker 失败 → Task 仍在、Attempt 记 FAILED_RETRYABLE、可新建 Attempt 重试且 Task ID 不变；
//   * 进程重启模拟（Attempt 租约过期）→ recover() 回收为 ABANDONED/WORKER_LOST，新 Attempt 续跑；
//   * Session 结束 ≠ Task 结束：Session 已 ENDED 后 Task 仍可读、可被新事件唤醒并继续；
//   * 三层身份一致性守卫（Session 不能认领别的 Task 的 Attempt）；
//   * 重试上限 → FAILED_FINAL / Task FAILED。
//
// 这里的 Worker 是 `ScriptedWorkerLauncher`（明确测试替身）；真实 DSH Session
// 的证据在 `src/runtime/evidence/dsh-worker.evidence.ts`，不互相冒充。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { EventRuntime } from '../../src/runtime/event-runtime.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import { TaskRuntime } from '../../src/runtime/task-runtime.ts'
import type { InboundEvent, WorkerLauncher } from '../../src/runtime/types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from './scripted-worker.ts'

let db: RuntimeTestDatabase
let store: RuntimeStore
let events: EventRuntime

before(async () => {
  db = await createRuntimeTestDatabase('task')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  events = new EventRuntime({ store })
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/** 用一条 ResumeReceived 事件建一个业务对象唯一的 Task，返回 taskId。 */
async function newTask(): Promise<string> {
  const applicationId = randomUUID()
  const result = await events.receive({
    tenantId: RUNTIME_TENANT,
    provider: 'feishu',
    providerEventId: `evt-${randomUUID()}`,
    eventType: 'resume_received',
    payload: { application_id: applicationId },
    trustLevel: 'UNTRUSTED_EXTERNAL',
  } satisfies InboundEvent)
  assert.equal(result.dispatchState, 'ROUTED')
  assert.ok(result.taskId !== null)
  return result.taskId
}

function taskRuntime(launcher: WorkerLauncher, options: Partial<{ leaseMs: number; maxAttempts: number }> = {}): TaskRuntime {
  return new TaskRuntime({
    store,
    launcher,
    workerType: 'SCRIPTED_WORKER',
    workerId: 'test-router',
    leaseMs: options.leaseMs ?? 60_000,
    maxAttempts: options.maxAttempts ?? 3,
    workspaceRoot: `${process.cwd()}/.runtime-test-work`,
  })
}

describe('task runtime: attempt lifecycle and recovery', () => {
  test('worker failure keeps the task; retry creates a new attempt with the same task id', async () => {
    const taskId = await newTask()
    const launcher = new ScriptedWorkerLauncher([
      scriptedOutcome('failed', {
        summary: 'transient worker failure',
        errorCode: 'TRANSIENT_REMOTE_FAILURE',
        errorClass: 'TRANSIENT',
        retryable: true,
        // 让下一次派发立即可执行（生产里是退避时间）
        retryAfter: new Date(Date.now() - 1000).toISOString(),
        runtimeSessionId: 'session-first-attempt',
      }),
      scriptedOutcome('succeeded', {
        summary: 'resume parsed',
        resultRef: 'resume-version:parsed:1',
        runtimeSessionId: 'session-second-attempt',
      }),
    ])
    const runtime = taskRuntime(launcher)

    const first = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(first !== null)
    assert.equal(first.attemptNo, 1)
    assert.equal(first.attemptStatus, 'FAILED_RETRYABLE')
    assert.equal(first.taskStatus, 'RETRY_WAIT')
    assert.equal(first.runtimeSessionId, 'session-first-attempt')

    const afterFirst = await runtime.read(taskId)
    assert.ok(afterFirst !== null)
    assert.equal(afterFirst.task.id, taskId, 'task id must not change after a failed attempt')
    assert.equal(afterFirst.task.status, 'RETRY_WAIT')
    assert.equal(afterFirst.attempts.length, 1)
    assert.equal(afterFirst.sessions[0]!.status, 'ENDED', 'the first session ended; the task did not')
    assert.equal(afterFirst.sessions[0]!.runtimeSessionId, 'session-first-attempt')

    const second = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(second !== null)
    assert.equal(second.taskId, taskId, 'retry keeps the Business Task id')
    assert.equal(second.attemptNo, 2)
    assert.equal(second.attemptStatus, 'SUCCEEDED')
    assert.equal(second.taskStatus, 'SUCCEEDED')

    const finalView = await runtime.read(taskId)
    assert.ok(finalView !== null)
    assert.equal(finalView.attempts.length, 2)
    assert.deepEqual(finalView.attempts.map((a) => a.status), ['FAILED_RETRYABLE', 'SUCCEEDED'])
    assert.equal(finalView.attempts[0]!.errorCode, 'TRANSIENT_REMOTE_FAILURE')
    assert.equal(finalView.attempts[1]!.errorCode, null)
    assert.equal(finalView.task.resultRef, 'resume-version:parsed:1')
    assert.equal(finalView.sessions.length, 2)
    assert.deepEqual(finalView.sessions.map((s) => s.status), ['ENDED', 'ENDED'])
    assert.notEqual(finalView.sessions[0]!.runtimeSessionId, finalView.sessions[1]!.runtimeSessionId, 'each attempt gets its own session')
    assert.equal(finalView.wakeups.length, 1)
  })

  test('restart simulation: an expired attempt is reclaimed and retried on the same task', async () => {
    const taskId = await newTask()
    // 模拟"Router 进程在 Worker 执行中被 kill"：Attempt 已 CLAIMED/RUNNING、Session 已登记，
    // 但没有 finishAttempt。租约很短（150ms），稍后由 recover() 扫出来。
    const claim = await store.claimTask(taskId, { workerType: 'SCRIPTED_WORKER', workerId: 'killed-router', leaseMs: 150 })
    assert.ok(claim !== null)
    await store.startAttempt(claim.attemptId, 150)
    const ghostSession = await store.createAgentSession({
      taskId,
      attemptId: claim.attemptId,
      runtimeKind: 'SCRIPTED',
      runtimeVersion: 'scripted-1.0.0',
      modelRoute: 'scripted/test-double',
    })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const runtime = taskRuntime(new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'resumed after recovery', runtimeSessionId: 'session-after-restart' }),
    ]))
    const recovered = await runtime.recover()
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0]!.taskId, taskId)
    assert.equal(recovered[0]!.attemptId, claim.attemptId)
    assert.equal(recovered[0]!.errorCode, 'WORKER_LOST')

    const afterRecover = await runtime.read(taskId)
    assert.ok(afterRecover !== null)
    assert.equal(afterRecover.task.status, 'RETRY_WAIT')
    assert.equal(afterRecover.attempts[0]!.status, 'ABANDONED')
    assert.equal(afterRecover.attempts[0]!.errorClass, 'WORKER_LOST')
    assert.equal(afterRecover.sessions[0]!.id, ghostSession)
    assert.equal(afterRecover.sessions[0]!.status, 'LOST', 'the lost session is marked LOST; the task is not')

    const retried = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(retried !== null)
    assert.equal(retried.taskId, taskId)
    assert.equal(retried.attemptNo, 2)
    assert.equal(retried.taskStatus, 'SUCCEEDED')
  })

  test('a session that has ended does not end the task: a later event wakes and continues the same task', async () => {
    const taskId = await newTask()
    const applicationId = (await store.readTask(taskId))!.task.businessRefs[0]!.id
    const runtime = taskRuntime(new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'first execution', runtimeSessionId: 'session-1' }),
      scriptedOutcome('succeeded', { summary: 'second execution after session ended', runtimeSessionId: 'session-2' }),
    ]))
    const first = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(first !== null)
    const ended = await runtime.read(taskId)
    assert.equal(ended!.task.status, 'SUCCEEDED')
    assert.equal(ended!.sessions[0]!.status, 'ENDED')

    // Session 已经结束；新事件仍然唤醒同一个 Business Task（身份不随会话消失）。
    const wake = await events.receive({
      tenantId: RUNTIME_TENANT,
      provider: 'feishu',
      providerEventId: `evt-${randomUUID()}`,
      eventType: 'resume_received',
      payload: { application_id: applicationId },
      trustLevel: 'UNTRUSTED_EXTERNAL',
    })
    assert.equal(wake.taskId, taskId)
    assert.equal(wake.taskCreated, false)
    assert.equal(wake.wakeInserted, true)

    const second = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(second !== null)
    assert.equal(second.taskId, taskId)
    assert.equal(second.attemptNo, 2)
    const view = await runtime.read(taskId)
    assert.equal(view!.sessions.length, 2)
    assert.equal(view!.task.taskType, 'RESUME_PARSE')
    assert.equal(view!.wakeups.length, 2)
  })

  test('session identity guard rejects a session that claims another task attempt', async () => {
    const taskA = await newTask()
    const taskB = await newTask()
    const claimA = await store.claimTask(taskA, { workerType: 'SCRIPTED_WORKER', workerId: 'guard-test', leaseMs: 60_000 })
    assert.ok(claimA !== null)
    await assert.rejects(
      () => store.createAgentSession({
        taskId: taskB,
        attemptId: claimA.attemptId,
        runtimeKind: 'SCRIPTED',
        runtimeVersion: 'scripted-1.0.0',
        modelRoute: 'scripted/test-double',
      }),
      (error: unknown) => /AGENT_SESSION_TASK_ATTEMPT_MISMATCH/.test(String(error)),
    )
    await assert.rejects(
      () => store.createAgentSession({
        taskId: taskB,
        attemptId: claimA.attemptId,
        runtimeKind: 'SCRIPTED',
        runtimeVersion: 'scripted-1.0.0',
        modelRoute: 'scripted/test-double',
        runtimeWorkerRole: 'ROUTER',
      }),
      (error: unknown) => /AGENT_SESSION_ROLE_MISMATCH/.test(String(error)),
    )
  })

  test('max attempts reached: failed attempt is final and the task is FAILED with a stable error code', async () => {
    const taskId = await newTask()
    const runtime = taskRuntime(
      new ScriptedWorkerLauncher([
        scriptedOutcome('failed', { summary: 'permanent failure', errorCode: 'PERMANENT_INVALID_INPUT', errorClass: 'INVALID_INPUT', retryable: true }),
      ]),
      { maxAttempts: 1 },
    )
    const result = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.ok(result !== null)
    assert.equal(result.attemptStatus, 'FAILED_FINAL')
    assert.equal(result.taskStatus, 'FAILED')
    const view = await runtime.read(taskId)
    assert.equal(view!.task.status, 'FAILED')
    assert.equal(view!.task.errorCode, 'PERMANENT_INVALID_INPUT')
    assert.notEqual(view!.task.completedAt, null)
    const again = await runtime.dispatchTask(taskId, new AbortController().signal)
    assert.equal(again, null, 'a FAILED task is not dispatched again without a new event')
  })
})
