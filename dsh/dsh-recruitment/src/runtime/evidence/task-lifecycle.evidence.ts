// Task/Attempt/Session 生命周期证据（手动运行；Worker 是明确的 scripted 替身）。
//
// 与 `dsh-worker.evidence.ts` 的分工：
//   * 本脚本证明**状态机与恢复**：失败重试保持 Task ID、租约过期回收、
//     Session 结束后 Task 仍可读可续；
//   * dsh-worker.evidence.ts 证明**真实 DSH 执行**：真实进程、真实模型、真实工具调用。
// 两者标签不同，不能互相冒充：本脚本输出 `worker = SCRIPTED_TEST_DOUBLE`。
//
// 运行：
//   $env:RECRUITMENT_DB_PASSWORD='<local dev db password>'
//   node src/runtime/evidence/task-lifecycle.evidence.ts
import { randomUUID } from 'node:crypto'
import { EventRuntime } from '../event-runtime.ts'
import { EVENT_TYPES } from '../event-types.ts'
import { RuntimeStore } from '../store.ts'
import { TaskRuntime } from '../task-runtime.ts'
import type { InboundEvent } from '../types.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
} from '../../../test/runtime/db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from '../../../test/runtime/scripted-worker.ts'

const db = await createRuntimeTestDatabase('lifecycle')
try {
  const store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  const events = new EventRuntime({ store })
  const newTask = async (): Promise<string> => {
    const result = await events.receive({
      tenantId: RUNTIME_TENANT,
      provider: 'internal',
      providerEventId: `lifecycle-${randomUUID()}`,
      eventType: EVENT_TYPES.SCORECARD_SUBMIT,
      payload: { interview_id: randomUUID() },
      trustLevel: 'INTERNAL',
    } satisfies InboundEvent)
    if (result.taskId === null) throw new Error('event did not route to a task')
    return result.taskId
  }
  const snapshot = async (taskId: string): Promise<Record<string, unknown>> => {
    const view = await store.readTask(taskId)
    if (view === null) throw new Error('task disappeared from the database')
    return {
      task: {
        id: view.task.id,
        status: view.task.status,
        attempt_count: view.task.attemptCount,
        result_ref: view.task.resultRef,
        error_code: view.task.errorCode,
      },
      attempts: view.attempts.map((attempt) => ({
        attempt_no: attempt.attemptNo,
        status: attempt.status,
        error_code: attempt.errorCode,
        output_ref: attempt.outputRef,
      })),
      sessions: view.sessions.map((session) => ({
        id: session.id,
        status: session.status,
        runtime_session_id: session.runtimeSessionId,
      })),
      wakeups: view.wakeups.length,
    }
  }

  // 场景 A：失败 → 重试（Task ID 不变）
  const retryTask = await newTask()
  const retryRuntime = new TaskRuntime({
    store,
    launcher: new ScriptedWorkerLauncher([
      scriptedOutcome('failed', {
        summary: 'transient failure',
        errorCode: 'TRANSIENT_REMOTE_FAILURE',
        errorClass: 'TRANSIENT',
        retryable: true,
        retryAfter: new Date(Date.now() - 1000).toISOString(),
        runtimeSessionId: 'scripted-session-1',
      }),
      scriptedOutcome('succeeded', {
        summary: 'retry succeeded',
        resultRef: 'resume-version:parsed:1',
        runtimeSessionId: 'scripted-session-2',
      }),
    ]),
    workerType: 'SCRIPTED_WORKER',
    workerId: 'evidence-router',
    leaseMs: 60_000,
    maxAttempts: 3,
  })
  const first = await retryRuntime.dispatchTask(retryTask, new AbortController().signal)
  const afterFailure = await snapshot(retryTask)
  const second = await retryRuntime.dispatchTask(retryTask, new AbortController().signal)
  const afterRetry = await snapshot(retryTask)

  // 场景 B：进程重启（租约过期回收）→ 新 Attempt 续跑
  const restartTask = await newTask()
  const ghost = await store.claimTask(restartTask, { workerType: 'SCRIPTED_WORKER', workerId: 'killed-router', leaseMs: 120 })
  if (ghost === null) throw new Error('could not claim restart task')
  await store.startAttempt(ghost.attemptId, 120)
  await store.createAgentSession({
    taskId: restartTask,
    attemptId: ghost.attemptId,
    runtimeKind: 'SCRIPTED',
    runtimeVersion: 'scripted-1.0.0',
    modelRoute: 'scripted/test-double',
  })
  await new Promise((resolve) => setTimeout(resolve, 260))
  const restartRuntime = new TaskRuntime({
    store,
    launcher: new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'resumed after restart', runtimeSessionId: 'scripted-session-3' }),
    ]),
    workerType: 'SCRIPTED_WORKER',
    workerId: 'evidence-router',
    leaseMs: 60_000,
    maxAttempts: 3,
  })
  const recovered = await restartRuntime.recover()
  const afterRecover = await snapshot(restartTask)
  const afterRestartDispatch = await restartRuntime.dispatchTask(restartTask, new AbortController().signal)
  const afterRestartRetry = await snapshot(restartTask)

  // 场景 C：Session 已结束 → 新事件唤醒同一 Task 并继续
  const continueTask = await newTask()
  const continueRuntime = new TaskRuntime({
    store,
    launcher: new ScriptedWorkerLauncher([
      scriptedOutcome('succeeded', { summary: 'first', runtimeSessionId: 'scripted-session-4' }),
      scriptedOutcome('succeeded', { summary: 'after session ended', runtimeSessionId: 'scripted-session-5' }),
    ]),
    workerType: 'SCRIPTED_WORKER',
    workerId: 'evidence-router',
    leaseMs: 60_000,
    maxAttempts: 3,
  })
  const firstRun = await continueRuntime.dispatchTask(continueTask, new AbortController().signal)
  const endedView = await snapshot(continueTask)
  const interviewId = (await store.readTask(continueTask))!.task.businessRefs[0]!.id
  const wake = await events.receive({
    tenantId: RUNTIME_TENANT,
    provider: 'internal',
    providerEventId: `lifecycle-${randomUUID()}`,
    eventType: EVENT_TYPES.SCORECARD_SUBMIT,
    payload: { interview_id: interviewId },
    trustLevel: 'INTERNAL',
  })
  const secondRun = await continueRuntime.dispatchTask(continueTask, new AbortController().signal)
  const resumedView = await snapshot(continueTask)

  const evidence = {
    labels: {
      db: 'REAL_POSTGRES',
      worker: 'SCRIPTED_TEST_DOUBLE',
      dsh_session: 'NOT_APPLICABLE (scripted launcher)',
      note: 'this script proves the task/attempt/session state machine only; real DSH execution is proven by dsh-worker.evidence.ts',
    },
    database: db.name,
    migrations: db.migrations.length,
    scenario_failure_retry: {
      task_id: retryTask,
      first_dispatch: first,
      after_failure: afterFailure,
      second_dispatch: second,
      after_retry: afterRetry,
      task_id_unchanged: afterFailure.task !== null && afterRetry.task !== null
        && (afterFailure.task as Record<string, unknown>).id === (afterRetry.task as Record<string, unknown>).id,
    },
    scenario_restart_recovery: {
      task_id: restartTask,
      recovered,
      after_recover: afterRecover,
      after_redispatch: afterRestartDispatch,
      after_retry: afterRestartRetry,
    },
    scenario_session_ended_task_continues: {
      task_id: continueTask,
      first_dispatch: firstRun,
      after_session_ended: endedView,
      wake_event: wake,
      second_dispatch: secondRun,
      after_resume: resumedView,
    },
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} finally {
  await db.drop()
}

