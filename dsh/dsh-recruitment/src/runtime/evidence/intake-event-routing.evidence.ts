// 验收证据：**真实工具**发的事件被**确定性路由**成 Business Task（手动运行，不进 `node --test`）。
//
// 为什么要有这个脚本（而不是只留测试）：
//   出缺陷的那条链是"工具发射 → 事件队列 → 路由 → 任务"，测试用构造的事件行只能证明
//   中间两跳；这里从头到尾跑一次**真东西**：
//     1. 一次性空库（真实 PG，重放 0001→0014 迁移）；
//     2. 用**产品同一个** `createApplicationIntakeTool(...).execute()` 真跑一次 S6 接入
//        （真 Python converter 读真 PDF，真工具事务写库）；
//     3. 读回工具写下的 `resume.intake.received` 事件行（payload 只有 sha256，没有对象 UUID）；
//     4. 用**生产同一个** `EventRuntime.processPending()` 做一轮路由（就是 Router.tick 的第一段）；
//     5. 从库里读回 `event_inbox` 投影 + `business_task` + `task_wakeup`。
//   修复前第 4 步会落 `IGNORED / SEMANTIC_GATE_REJECTED`，整条"事件自动触发"是坏的。
//
// 标签（R4 三维）：provenance = REAL_POSTGRES + REAL_TOOL；trigger = EVENT
// （事件由工具发射、路由由运行时完成，不是脚本手工 submit 一条事件）；
// worker = SCRIPTED_TEST_DOUBLE（第 5 段的派发用替身，只证明"任务可被派发"，
// 不冒充真实 DSH 执行——真实 DSH 执行见 `dsh-worker.evidence.ts`）。
//
// 运行（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机库密码>'
//   node src/runtime/evidence/intake-event-routing.evidence.ts
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDatabaseConfig } from '../../db/pool.ts'
import { createApplicationIntakeTool } from '../../tools/application-intake.ts'
import { resolveConverterConfig } from '../../tools/converter.ts'
import { EventRuntime } from '../event-runtime.ts'
import { EVENT_TYPES } from '../event-types.ts'
import { RuntimeStore } from '../store.ts'
import { TaskRuntime } from '../task-runtime.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
} from '../../../test/runtime/db.ts'
import { scriptedOutcome, ScriptedWorkerLauncher } from '../../../test/runtime/scripted-worker.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
/** `dsh/dsh-recruitment` 包根。 */
const PKG_ROOT = join(HERE, '..', '..', '..')
/** 仓库根（`recruitment-agent`）。 */
const REPO_ROOT = join(PKG_ROOT, '..', '..')

/** 合成简历（不是真实候选人资料；与 `manual/golden-path` 同一份合成夹具）。 */
const FIXTURE_PDF = join(PKG_ROOT, 'manual', 'golden-path', 'fixtures', 'synthetic-resume-golden-path.pdf')
const CONVERTER_DIR = join(REPO_ROOT, 'converter')
const PYTHON_BIN = process.env.RECRUITMENT_PYTHON_BIN ?? 'D:\\Python3.12.9\\python.exe'
/** 0002_seed 的演示岗位（OPEN，已有 job_version）。 */
const DEMO_JOB = '11111111-1111-4111-8111-000000000401'

const db = await createRuntimeTestDatabase('intake_route_ev')
try {
  const store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  const events = new EventRuntime({ store })

  // ---- 1. 真实工具（真 converter + 真库事务）----
  const converter = resolveConverterConfig({
    python_bin: PYTHON_BIN,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [join(PKG_ROOT, 'manual', 'golden-path', 'fixtures')],
    timeout_ms: 180_000,
  })
  if (converter.resolved === null) throw new Error(`converter 配置不完整：${converter.issues.join('; ')}`)
  const database = resolveDatabaseConfig({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    database: db.name,
    password_env: 'RECRUITMENT_DB_PASSWORD',
    tenant_id: RUNTIME_TENANT,
    actor_id: RUNTIME_ACTOR,
  }, process.env)
  if (database.resolved === null) {
    throw new Error(`数据库配置不完整（先设 $env:RECRUITMENT_DB_PASSWORD）：${database.issues.join('; ')}`)
  }
  const intake = createApplicationIntakeTool({ converter: converter.resolved, database: database.resolved })
  const toolResult = await intake.execute(
    { path: FIXTURE_PDF, job_id: DEMO_JOB },
    { signal: new AbortController().signal },
  ) as Record<string, unknown>

  // ---- 2. 读回工具写的事件行（路由前）----
  const sha = (toolResult.source as Record<string, unknown>).sha256 as string
  const eventQuery = await db.pool.query<Record<string, unknown>>(
    `select event_id::text, provider, event_type, normalized_event_type, trust_level,
            idempotency_source, source_object_id, normalizer_version,
            dispatch_state, route_attempts, route_error, business_object_type,
            business_object_id::text, routed_task_id::text, routed_at
       from recruitment.event_inbox
      where tenant_id = $1 and idempotency_key = $2`,
    [RUNTIME_TENANT, `resume.intake:${sha}`],
  )
  const eventBefore = eventQuery.rows[0]
  if (eventBefore === undefined) throw new Error('工具没有写下 resume.intake.received 事件（证据链断了）')
  const eventId = String(eventBefore.event_id)
  const intakeRecord = await db.pool.query<{ id: string }>(
    'select id::text from recruitment.intake_record where tenant_id = $1 and event_id = $2',
    [RUNTIME_TENANT, eventId],
  )

  // ---- 3. 生产同一个入口做一轮路由（Router.tick 的第一段）----
  const routed = await events.processPending()
  const routedResult = routed.find((item) => item.eventId === eventId) ?? null

  // ---- 4. 库里读回 ----
  const afterQuery = await db.pool.query<Record<string, unknown>>(
    `select dispatch_state, route_attempts, route_error, business_object_type,
            business_object_id::text, routed_task_id::text, routed_at
       from recruitment.event_inbox where tenant_id = $1 and event_id = $2`,
    [RUNTIME_TENANT, eventId],
  )
  const eventAfter = afterQuery.rows[0] ?? {}
  const taskId = routedResult?.taskId ?? null
  const taskView = taskId === null ? null : await store.readTask(taskId)
  const wakeRows = taskId === null
    ? { rows: [] as Record<string, unknown>[] }
    : await db.pool.query<Record<string, unknown>>(
      `select w.id::text, w.task_id::text, w.event_id::text, w.wake_seq, w.wake_reason,
              t.task_type, t.title, t.status, t.idempotency_key, t.business_refs,
              t.trigger_event_id::text, t.last_wake_event_id::text, t.wake_count
         from recruitment.task_wakeup w
         join recruitment.business_task t on t.id = w.task_id and t.tenant_id = w.tenant_id
        where w.tenant_id = $1 and w.task_id = $2`,
      [RUNTIME_TENANT, taskId],
    )

  // ---- 5. 派发一次（Worker 是 scripted 替身；只证明任务可被认领）----
  let dispatch: Record<string, unknown> | null = null
  if (taskId !== null) {
    const tasks = new TaskRuntime({
      store,
      launcher: new ScriptedWorkerLauncher([
        scriptedOutcome('succeeded', {
          summary: 'resume parsed (scripted double)',
          resultRef: 'resume-version:parsed:evidence',
          runtimeSessionId: 'scripted-intake-routing-session-1',
        }),
      ]),
      workerType: 'SCRIPTED_WORKER',
      workerId: 'intake-routing-evidence',
      leaseMs: 60_000,
      maxAttempts: 2,
      workspaceRoot: join(process.env.TEMP ?? process.env.TMP ?? '.', 'ra-runtime-intake-routing'),
    })
    dispatch = await tasks.dispatchNext(new AbortController().signal) as Record<string, unknown> | null
  }

  const evidence = {
    labels: {
      provenance: 'REAL_POSTGRES + REAL_TOOL（真 Python converter 读合成 PDF；非真实候选人资料）',
      trigger: 'EVENT（工具写事件 → 运行时 processPending 路由，不是脚本手工 submit）',
      connection: 'CONNECTED（本机 PG）',
      worker: 'SCRIPTED_TEST_DOUBLE（第 5 段；不冒充真实 DSH 执行）',
      fixed_defect: '工具发 resume.intake.received，旧路由表只认 resume_received → 40 条真实事件被语义 Gate 拒',
    },
    database: db.name,
    migrations: db.migrations.length,
    registry_event_type: EVENT_TYPES.RESUME_INTAKE_RECEIVED,
    tool: {
      name: 'recruitment_application_intake',
      result: {
        application_id: toolResult.application_id,
        candidate_id: toolResult.candidate_id,
        resume_version_id: toolResult.resume_version_id,
        application_action: toolResult.application_action,
        resume_version_action: toolResult.resume_version_action,
        provenance: toolResult.provenance,
        labels: toolResult.labels,
      },
      fixture: FIXTURE_PDF,
      sha256: sha,
    },
    event_before_routing: eventBefore,
    intake_record: intakeRecord.rows[0] ?? null,
    routing: routedResult,
    event_after_routing: eventAfter,
    business_task: taskView === null ? null : {
      id: taskView.task.id,
      task_type: taskView.task.taskType,
      title: taskView.task.title,
      status: taskView.task.status,
      priority: taskView.task.priority,
      idempotency_key: taskView.task.idempotencyKey,
      business_refs: taskView.task.businessRefs,
      trigger_event_id: taskView.task.triggerEventId,
      last_wake_event_id: taskView.task.lastWakeEventId,
      wake_count: taskView.task.wakeCount,
      attempts: taskView.attempts.map((attempt) => ({ attempt_no: attempt.attemptNo, status: attempt.status })),
      sessions: taskView.sessions.map((session) => ({ status: session.status, runtime_session_id: session.runtimeSessionId })),
    },
    task_wakeup: wakeRows.rows[0] ?? null,
    dispatch_with_scripted_worker: dispatch,
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
} finally {
  await db.drop()
}
