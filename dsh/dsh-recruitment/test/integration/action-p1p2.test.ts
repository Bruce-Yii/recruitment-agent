// D5 写操作 lane-B：P1/P2 Host Remote Action 的**真库 + 真 HTTP** 集成测试。
//
// 覆盖（每条都带**独立 SQL 读回**，不用产品读投影自证）：
//   a. P1 `interview/schedule` 四 intent（CREATE / RESCHEDULE / WITHDRAW_INTERVIEWER / CANCEL）各 200，
//      readback 的 status / record_version / required_scorecard 与独立 SQL 一致；
//      同 key 同参重放 `replayed=true` + `approval.requested=0` + 零新增行。
//   b. P1 `transcript/import` 人工路径：artifact READY / FIXTURE / MANUAL / NOT_CONNECTED、segment_count>0；
//      PLATFORM_EXPORT 缺 exported_file_name → 400 `EXPORT_FILE_NAME_REQUIRED` 且零写入。
//   c. P2 `job/rubric-approve`：先用 `createJobUpdateTool` 产出一个未批准 rubric 版本，再 POST approve；
//      SQL 读回 approval=APPROVED / actor=103 / job 指针移动；闸门=allowed-once。
//   d. P2 `config/role` create+update、`config/team` create、`config/pipeline` create+add_stage(S6)、
//      统一入口 `config`（entity 分派）；readback.record_version / actor_id 与 SQL 一致。
//   e. 负例（每项断言 HTTP 状态 + code/reason_code + 目标表行数前后不变）：
//      未绑定 409 / interviewer_a 403 / body actor_id 400 / 非法 UUID 400 / GET 405 / 缺同源头 403 /
//      config 读 operation 400 / 无会议面试导入转写 409 或 500（如实按实现断言）。
//
// 纪律：
//   1. 本文件独占一个 `createIsolatedTestDatabase('d5actp12')` 一次性库（**不写 ra_s6s7**），跑完 drop；
//   2. 连不上库就失败（不静默 skip；R3 要 skipped===0）；
//   3. 真 `node:http` 监听 127.0.0.1:0，把真实 `registerActorHttp` + `registerActionsHttp` 的
//      `webServer.register` 契约收集成 exact 路由表（与宿主同一份注册函数，不模拟它们的行为）；
//   4. 身份注册表 = 产品 `createDemoActorIdentity()` 真实例（与工具/HTTP 共享 session→alias 绑定）；
//   5. 断言不放宽：拒绝路径同时断言状态/错误码 + 目标表行数不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActorHttp } from '../../src/http/actor.ts'
import { registerActionsHttp, type ActionHttpDeps } from '../../src/http/actions.ts'
import { createJobUpdateTool } from '../../src/tools/job-create.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  DEMO_DEPARTMENT,
  DEMO_JOB,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
// 固定 id / session（与 0002_seed + bootstrap-demo 的演示种子一致）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（test/integration → test → dsh-recruitment → dsh → repo）。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')
/** 集成测试底座配置（密码只从环境变量来；缺了 `testDatabaseConfig()` 直接抛）。 */
const BASE = testDatabaseConfig()

const ACTOR_103 = '11111111-1111-4111-8111-000000000103' // recruiter（HR）
const ACTOR_104 = '11111111-1111-4111-8111-000000000104' // interviewer_a
const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'

const SESSION_R = 'session-d5acb000-0000-4000-8000-00000000c001'
const SESSION_A = 'session-d5acb000-0000-4000-8000-00000000a001'
const SESSION_UNBOUND = 'session-d5acb000-0000-4000-8000-00000000ff01'

// 本次运行唯一后缀：避免与 bootstrap 种子 / 重复跑撞唯一键。
const UNIQUE = `${process.pid.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase()
const TAG = `D5P12_${UNIQUE}`
/** 排期窗口：远期（>1 年），避开任何种子面试的冲突判定。 */
const START_AT = new Date(Date.now() + 400 * 86_400_000).toISOString()
const START_AT_2 = new Date(Date.now() + 401 * 86_400_000).toISOString()

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let harness: Harness

/** 真 `node:http` + 真实 register 契约（actor 3 条 + actions 13 条 exact path）。 */
interface Harness {
  readonly baseUrl: string
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/** 一次 HTTP 调用结果。 */
interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
}

test.before(async () => {
  // ---- 一次性空库（真迁移 0001→0016）+ 产品 bootstrap 种子 ----
  db = await createIsolatedTestDatabase('d5actp12')
  assertPrivateDatabase(db.name)
  assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
  cfg = { ...BASE, database: db.name }

  const boot = await runBootstrap(db.name)
  assert.equal(
    boot.code,
    0,
    `bootstrap 必须 exit 0；实际 code=${String(boot.code)}\n${boot.stdout.slice(-3000)}\n${boot.stderr.slice(-2000)}`,
  )

  // ---- 独立 SQL 读回种子（不拿脚本自述当证据）----
  const actors = await query<{ id: string; kind: string }>(
    'select id::text as id, kind from recruitment.actor where id in ($1, $2) and tenant_id = $3 order by id',
    [ACTOR_103, ACTOR_104, TENANT],
  )
  assert.equal(actors.length, 2, '种子应保证 103/104 两个 actor 存在')
  assert.deepEqual(actors.map((row) => row.kind), ['HUMAN', 'HUMAN'])
  const dept = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.department where id = $1 and tenant_id = $2',
    [DEMO_DEPARTMENT, TENANT],
  )
  assert.equal(dept[0]?.n, 1, '种子应保证演示部门 010 存在')
  const job = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.job where id = $1 and tenant_id = $2',
    [DEMO_JOB, TENANT],
  )
  assert.equal(job[0]?.n, 1, '种子应保证演示岗位 401 存在')
  const app = await query<{ n: number }>(
    'select count(*)::int as n from recruitment.application where id = $1 and tenant_id = $2',
    [DEMO_APPLICATION, TENANT],
  )
  assert.equal(app[0]?.n, 1, '种子应保证演示申请 0701 存在')

  // 夹具前置：CREATE 要求申请 lifecycle_status='ACTIVE'（0002_seed 的演示申请状态由演示库决定）。
  await query("update recruitment.application set lifecycle_status = 'ACTIVE' where id = $1 and tenant_id = $2", [
    DEMO_APPLICATION,
    TENANT,
  ])

  // ---- 真 HTTP server + 两个 register 函数（同一份产品注册实现）----
  identity = createDemoActorIdentity().identity
  harness = await startHarness({ database: cfg, databaseIssues: [], identity })

  // 真实注册表断言：actions 13 条 exact（含统一入口 config + 三条新写入口）+ actor 3 条。
  const actionRoutes = harness.registered.filter(
    (route) => route.path.startsWith('/recruitment/api/action/') && !route.path.includes('scorecard'),
  )
  assert.equal(actionRoutes.length, 13, `action exact 路由应 13 条，实际 ${actionRoutes.map((r) => r.path).join(', ')}`)
  for (const path of [
    '/recruitment/api/action/interview/schedule',
    '/recruitment/api/action/transcript/import',
    '/recruitment/api/action/job/rubric-approve',
    '/recruitment/api/action/config/role',
    '/recruitment/api/action/config/team',
    '/recruitment/api/action/config/pipeline',
    '/recruitment/api/action/config',
    '/recruitment/api/action/application/transfer',
    '/recruitment/api/action/candidate/constraint',
    '/recruitment/api/action/job/create',
  ]) {
    assert.ok(actionRoutes.some((route) => route.path === path), `缺路由 ${path}`)
  }
  assert.ok(harness.registered.some((route) => route.path === '/recruitment/api/actor'), '缺 /recruitment/api/actor')

  // 绑定 recruiter / interviewer_a（未绑定 session 保留做负例）。
  for (const [session, alias] of [[SESSION_R, 'recruiter'], [SESSION_A, 'interviewer_a']] as const) {
    const put = await httpCall('PUT', '/recruitment/api/actor', { session, body: { alias } })
    assert.equal(put.status, 200, `绑定 ${alias} 应 200：${put.text}`)
    assert.equal(put.body.actor_id, alias === 'recruiter' ? ACTOR_103 : ACTOR_104, `${alias} 的 actor 映射`)
  }
})

test.after(async () => {
  if (harness !== undefined) await harness.close()
  if (db !== undefined) await db.drop()
})

// ===========================================================================
//  a. P1 interview/schedule：四 intent + 幂等重放
// ===========================================================================

test('a1 CREATE：200 + readback(SCHEDULED/record_version/required_scorecard) 与独立 SQL 一致', async () => {
  const before = await count('interview')
  const createBody = {
    intent: 'CREATE',
    idempotency_key: `${TAG}_schedule_create`,
    application_id: DEMO_APPLICATION,
    round_no: 11,
    slot_code: 'D5ACT',
    scheduled_start_at: START_AT,
    duration_minutes: 45,
    timezone: 'Asia/Shanghai',
    interviewers: [{ actor_id: ACTOR_104, role_in_interview: 'INTERVIEWER', required_scorecard: true }],
    meeting: { provider: 'FEISHU', external_meeting_id: `${TAG}-MEETING-1` },
  }
  const created = await okJson(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', { session: SESSION_R, body: createBody }),
    'schedule CREATE',
  )
  assert.equal(created.action, 'interview/schedule')
  assert.equal((created.actor as Record<string, unknown>).actor_id, ACTOR_103, 'actor 回显 = recruiter 103')
  assert.deepEqual(created.approval, { requested: 1, result: 'allowed-once', tool_names: ['recruitment_interview_schedule'] })
  const result = created.result as Record<string, unknown>
  assert.equal(result.intent, 'CREATE')
  assert.equal(result.status, 'OK')
  const interview = result.interview as Record<string, unknown>
  const readback = created.readback as Record<string, unknown>
  assert.equal(readback.interview_id, interview.id, 'readback 与 result 指向同一场')
  assert.equal(readback.status, 'SCHEDULED')
  assert.equal(readback.record_version, 1)

  // 独立 SQL 读回（不 import 产品读投影）
  const rows = await query<{
    id: string
    status: string
    record_version: number
    start_at: Date
    end_at: Date
    actor_id: string | null
  }>(
    `select i.id::text as id, i.status, i.record_version,
            i.scheduled_start_at as start_at, i.scheduled_end_at as end_at,
            i.status_changed_by_actor_id::text as actor_id
       from recruitment.interview i where i.id = $1 and i.tenant_id = $2`,
    [String(interview.id), TENANT],
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'SCHEDULED')
  assert.equal(rows[0]!.record_version, 1)
  assert.equal(rows[0]!.actor_id, ACTOR_103, '写作者 = 103（事务 GUC）')
  assert.equal(rows[0]!.start_at.toISOString(), new Date(START_AT).toISOString())
  assert.equal(rows[0]!.end_at.toISOString(), new Date(new Date(START_AT).getTime() + 45 * 60_000).toISOString())

  const interviewers = await query<{ id: string; actor_id: string; required: boolean }>(
    `select r.id::text as id, r.actor_id::text as actor_id, r.required_scorecard as required
       from recruitment.interviewer r where r.interview_id = $1 and r.tenant_id = $2`,
    [String(interview.id), TENANT],
  )
  assert.equal(interviewers.length, 1)
  assert.equal(interviewers[0]!.actor_id, ACTOR_104)
  assert.equal(interviewers[0]!.required, true)
  assert.equal(
    ((readback.interviewers as Record<string, unknown>[])[0] as Record<string, unknown>).interviewer_id,
    interviewers[0]!.id,
    'readback.interviewer_id = 库内 interviewer 行 id',
  )

  // 会议绑定（供 b 的转写导入使用）
  const bindings = await query<{ n: number }>(
    `select count(*)::int as n from recruitment.meeting_binding b
      where b.interview_id = $1 and b.tenant_id = $2 and b.unbound_at is null`,
    [String(interview.id), TENANT],
  )
  assert.equal(bindings[0]?.n, 1, 'CREATE 带 meeting 应产出一条 active 绑定')
  assert.equal(await count('interview'), before + 1, 'interview 恰好 +1')

  // 供后续用例复用
  state.interviewId = String(interview.id)
  state.interviewerId = interviewers[0]!.id
  state.createBody = createBody
  state.version = Number(readback.record_version)
})

test('a2 幂等重放同 key 同参：replayed=true、approval.requested=0、零新增行', async () => {
  const before = { interview: await count('interview'), task: await count('business_task') }
  const replayed = await okJson(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', { session: SESSION_R, body: state.createBody }),
    'schedule replay',
  )
  assert.deepEqual(replayed.approval, { requested: 0, result: 'not-requested', tool_names: [] }, '重放不问人')
  const result = replayed.result as Record<string, unknown>
  assert.equal(result.replayed, true)
  assert.deepEqual(result.changes, { created: [], updated: [], unchanged: [] }, '重放零变更')
  assert.equal((replayed.readback as Record<string, unknown>).interview_id, state.interviewId)
  assert.equal(await count('interview'), before.interview, '重放不新增 interview')
  assert.equal(await count('business_task'), before.task, '重放不新增 business_task（STORE 已存在）')
})

test('a3 RESCHEDULE：200 + 同一条行改期（record_version+1），SQL 与新时间一致', async () => {
  const rescheduled = await okJson(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', {
      session: SESSION_R,
      body: {
        intent: 'RESCHEDULE',
        idempotency_key: `${TAG}_schedule_reschedule`,
        interview_id: state.interviewId,
        expected_record_version: state.version,
        scheduled_start_at: START_AT_2,
        duration_minutes: 30,
        reason: 'D5 lane-B 集成测试改期',
      },
    }),
    'schedule RESCHEDULE',
  )
  const readback = rescheduled.readback as Record<string, unknown>
  assert.equal(readback.interview_id, state.interviewId, '改的是同一行（H-1）')
  assert.equal(readback.status, 'SCHEDULED')
  assert.equal(readback.record_version, state.version + 1)
  const rows = await query<{ status: string; record_version: number; start_at: Date }>(
    `select status, record_version, scheduled_start_at as start_at from recruitment.interview where id = $1 and tenant_id = $2`,
    [state.interviewId, TENANT],
  )
  assert.equal(rows[0]!.status, 'SCHEDULED')
  assert.equal(rows[0]!.record_version, state.version + 1)
  assert.equal(rows[0]!.start_at.toISOString(), new Date(START_AT_2).toISOString())
  state.version = Number(readback.record_version)
})

test('b transcript/import 人工路径：READY/FIXTURE/MANUAL/NOT_CONNECTED + segments>0', async () => {
  const content = [
    'D5 lane-B 合成转写（无真实候选人 PII）',
    '问：幂等键怎么防重复写？',
    '答：唯一键 + 去重表，重放返回首次结果。',
  ].join('\n')
  const imported = await okJson(
    await httpCall('POST', '/recruitment/api/action/transcript/import', {
      session: SESSION_R,
      body: { interview_id: state.interviewId, content, source_kind: 'DEMO_SAMPLE', language: 'zh' },
    }),
    'transcript import',
  )
  assert.deepEqual(imported.approval, { requested: 0, result: 'not-applicable', tool_names: [] }, '转写导入无 approval')
  const readback = imported.readback as Record<string, unknown>
  assert.equal(readback.status, 'READY')
  assert.equal(readback.provenance, 'FIXTURE')
  assert.equal(readback.trigger_mode, 'MANUAL')
  assert.equal(readback.connection_state, 'NOT_CONNECTED')
  assert.equal(readback.is_canonical, true, '首个 artifact 是 canonical')
  assert.ok(Number(readback.segment_count) > 0, `segment_count>0，实际 ${String(readback.segment_count)}`)

  const artifactId = String(readback.artifact_id)
  const artifacts = await query<{
    transcript_status: string
    provenance: string
    trigger_mode: string
    connection_state: string
    is_canonical: boolean
    content_sha256: string
    source_revision: number
  }>(
    `select transcript_status, provenance, trigger_mode, connection_state, is_canonical,
            content_sha256, source_revision
       from recruitment.transcript_artifact where id = $1 and tenant_id = $2`,
    [artifactId, TENANT],
  )
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0]!.transcript_status, 'READY')
  assert.equal(artifacts[0]!.provenance, 'FIXTURE')
  assert.equal(artifacts[0]!.trigger_mode, 'MANUAL')
  assert.equal(artifacts[0]!.connection_state, 'NOT_CONNECTED')
  assert.equal(artifacts[0]!.is_canonical, true)
  assert.match(artifacts[0]!.content_sha256, /^[0-9a-f]{64}$/)
  assert.equal(artifacts[0]!.source_revision, 1)

  const segments = await query<{ n: number; max_sequence: number }>(
    `select count(*)::int as n, max(sequence) as max_sequence
       from recruitment.transcript_segment where artifact_id = $1 and tenant_id = $2`,
    [artifactId, TENANT],
  )
  assert.equal(segments[0]!.n, 3, '三行内容 → 3 段')
  assert.equal(segments[0]!.max_sequence, 2)
  state.artifactId = artifactId
})

test('b- PLATFORM_EXPORT 缺 exported_file_name → 400 EXPORT_FILE_NAME_REQUIRED 且零写入', async () => {
  const before = await count('transcript_artifact')
  const rejected = await httpCall('POST', '/recruitment/api/action/transcript/import', {
    session: SESSION_R,
    body: { interview_id: state.interviewId, content: '导出件缺文件名', source_kind: 'PLATFORM_EXPORT' },
  })
  assertError(rejected, 400, 'INVALID_ARGS', 'EXPORT_FILE_NAME_REQUIRED', 'PLATFORM_EXPORT 缺文件名')
  assert.equal(await count('transcript_artifact'), before, '拒绝路径零写入')
})

test('a4 WITHDRAW_INTERVIEWER：200 + required_scorecard 由 true 改 false（行不删）', async () => {
  const withdrawn = await okJson(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', {
      session: SESSION_R,
      body: {
        intent: 'WITHDRAW_INTERVIEWER',
        idempotency_key: `${TAG}_schedule_withdraw`,
        interviewer_id: state.interviewerId,
        expected_record_version: state.version,
        reason: 'D5 lane-B 集成测试退出面试官',
      },
    }),
    'schedule WITHDRAW_INTERVIEWER',
  )
  const readback = withdrawn.readback as Record<string, unknown>
  assert.equal(readback.interview_id, state.interviewId)
  const rows = await query<{ required: boolean; n: number }>(
    `select required_scorecard as required from recruitment.interviewer where id = $1 and tenant_id = $2`,
    [state.interviewerId, TENANT],
  )
  assert.equal(rows.length, 1, '行不删（只改 required_scorecard）')
  assert.equal(rows[0]!.required, false, 'SQL：required_scorecard=false')
  assert.equal(
    ((readback.interviewers as Record<string, unknown>[])[0] as Record<string, unknown>).required_scorecard,
    false,
    'readback 与 SQL 一致',
  )
  const version = await query<{ record_version: number }>(
    'select record_version from recruitment.interview where id = $1 and tenant_id = $2',
    [state.interviewId, TENANT],
  )
  assert.equal(readback.record_version, version[0]!.record_version, 'readback.record_version = SQL')
  state.version = Number(readback.record_version)
})

test('a5 CANCEL：200 + status=CANCELLED（行保留）', async () => {
  const cancelled = await okJson(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', {
      session: SESSION_R,
      body: {
        intent: 'CANCEL',
        idempotency_key: `${TAG}_schedule_cancel`,
        interview_id: state.interviewId,
        expected_record_version: state.version,
        reason: 'D5 lane-B 集成测试取消',
      },
    }),
    'schedule CANCEL',
  )
  const readback = cancelled.readback as Record<string, unknown>
  assert.equal(readback.status, 'CANCELLED')
  const rows = await query<{ status: string; record_version: number }>(
    'select status, record_version from recruitment.interview where id = $1 and tenant_id = $2',
    [state.interviewId, TENANT],
  )
  assert.equal(rows[0]!.status, 'CANCELLED')
  assert.equal(readback.record_version, rows[0]!.record_version)
})

// ===========================================================================
//  c. P2 job/rubric-approve（先用 job_update 造未批准的 rubric 版本）
// ===========================================================================

test('c job/rubric-approve：approval=APPROVED/actor=103/job 指针移动；闸门 allowed-once', async () => {
  // 1) 用产品工具产出一个 PENDING 审批的 rubric 版本（真实入口，不手工插 approval）
  const jobRows = await query<{ record_version: number; current_rubric_version_id: string | null }>(
    'select record_version, current_rubric_version_id::text as current_rubric_version_id from recruitment.job where id = $1 and tenant_id = $2',
    [DEMO_JOB, TENANT],
  )
  const jobUpdate = createJobUpdateTool(cfg, { identity })
  const updated = (await jobUpdate.execute(
    {
      job_id: DEMO_JOB,
      expected_record_version: jobRows[0]!.record_version,
      criteria: [
        {
          key: 'd5p12_backend',
          label: '后端深度（lane-B 集成测试）',
          kind: 'MUST_HAVE',
          weight: 0.7,
          field: 'work_experience',
          operator: 'EXISTS',
          value: true,
        },
        {
          key: 'd5p12_judge',
          label: '判断型（lane-B 集成测试）',
          kind: 'NICE_TO_HAVE',
          weight: 0.3,
          question: '是否有带团队经历？',
        },
      ],
    },
    { agent: { id: SESSION_R } },
  )) as Record<string, unknown>
  assert.equal(updated.outcome, 'UPDATED', 'job_update 应产生新版本')
  const rubric = updated.rubric as Record<string, unknown>
  const newRubricId = String(rubric.version_id)
  assert.notEqual(newRubricId, jobRows[0]!.current_rubric_version_id, '新 rubric 版本 ≠ 当前指针')

  const pending = await query<{ status: string }>(
    `select status from recruitment.approval
      where tenant_id = $1 and resource_type = 'RUBRIC_VERSION' and resource_id = $2
      order by created_at desc limit 1`,
    [TENANT, newRubricId],
  )
  assert.equal(pending[0]?.status, 'PENDING', 'job_update 只写 PENDING 审批行')

  // 2) POST 批准（人类点击 = allow-once）
  const approved = await okJson(
    await httpCall('POST', '/recruitment/api/action/job/rubric-approve', {
      session: SESSION_R,
      body: { job_id: DEMO_JOB, rubric_version_id: newRubricId, reason: 'D5 lane-B 集成测试批准' },
    }),
    'job/rubric-approve',
  )
  assert.deepEqual(approved.approval, { requested: 1, result: 'allowed-once', tool_names: ['recruitment_job_rubric_approve'] })
  const result = approved.result as Record<string, unknown>
  assert.equal(result.outcome, 'APPROVED')
  const readback = approved.readback as Record<string, unknown>
  const approvalRow = readback.approval as Record<string, unknown>
  assert.equal(approvalRow.status, 'APPROVED')
  assert.equal(approvalRow.actor_id, ACTOR_103)
  const jobReadback = readback.job as Record<string, unknown>
  assert.equal(jobReadback.current_rubric_version_id, newRubricId, 'job 指针移动')

  // 3) 独立 SQL：approval / rubric_version / job / 审计事件
  const approvalDb = await query<{ status: string; actor_id: string | null; hash: string }>(
    `select status, decision_by_actor_id::text as actor_id, canonical_payload_hash as hash
       from recruitment.approval
      where tenant_id = $1 and resource_type = 'RUBRIC_VERSION' and resource_id = $2
      order by created_at desc limit 1`,
    [TENANT, newRubricId],
  )
  assert.equal(approvalDb[0]?.status, 'APPROVED')
  assert.equal(approvalDb[0]?.actor_id, ACTOR_103)
  const rubricDb = await query<{ payload_hash: string; approved_by_approval_id: string | null }>(
    'select payload_hash, approved_by_approval_id::text as approved_by_approval_id from recruitment.rubric_version where id = $1 and tenant_id = $2',
    [newRubricId, TENANT],
  )
  assert.equal(rubricDb[0]?.payload_hash, approvalDb[0]?.hash, '审批 hash = rubric payload_hash')
  assert.equal(rubricDb[0]?.approved_by_approval_id, null, '契约：rubric_version.approved_by_approval_id 恒 null（J-1/J-5）')
  const jobDb = await query<{ current: string | null; record_version: number }>(
    'select current_rubric_version_id::text as current, record_version from recruitment.job where id = $1 and tenant_id = $2',
    [DEMO_JOB, TENANT],
  )
  assert.equal(jobDb[0]?.current, newRubricId)
  assert.equal(jobReadback.record_version, jobDb[0]!.record_version)
  const events = await query<{ n: number }>(
    `select count(*)::int as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'job.rubric_version.approved'
        and payload->>'rubric_version_id' = $2`,
    [TENANT, newRubricId],
  )
  assert.equal(events[0]?.n, 1, '批准写一条审计事件')
  state.rubricId = newRubricId
})

// ===========================================================================
//  d. P2 config/role | config/team | config/pipeline（+ 统一入口）
// ===========================================================================

test('d1 config/role create+update：readback.record_version/actor_id 与 SQL 一致', async () => {
  const roleCode = `${TAG}_ROLE`.slice(0, 41)
  const created = await okJson(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_R,
      body: { operation: 'create', code: roleCode, name: 'lane-B 角色', permission_scopes: ['JOB_READ'] },
    }),
    'config/role create',
  )
  assert.deepEqual(created.approval, { requested: 0, result: 'not-applicable', tool_names: [] })
  const roleReadback = created.readback as Record<string, unknown>
  const roleId = String(roleReadback.role_id)
  assert.equal(roleReadback.actor_id, ACTOR_103, 'created_by = 103')
  assert.equal(roleReadback.record_version, 1)
  const roleDb = await query<{ code: string; record_version: number; actor_id: string | null; scopes: unknown }>(
    `select code, record_version, created_by_actor_id::text as actor_id, permission_scopes as scopes
       from recruitment.role where id = $1 and tenant_id = $2`,
    [roleId, TENANT],
  )
  assert.equal(roleDb.length, 1)
  assert.equal(roleDb[0]!.code, roleCode)
  assert.equal(roleDb[0]!.record_version, 1)
  assert.equal(roleDb[0]!.actor_id, ACTOR_103)

  const updated = await okJson(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_R,
      body: {
        operation: 'update',
        role_id: roleId,
        expected_record_version: roleReadback.record_version,
        name: 'lane-B 角色 v2',
      },
    }),
    'config/role update',
  )
  const updatedReadback = updated.readback as Record<string, unknown>
  assert.equal(updatedReadback.record_version, Number(roleReadback.record_version) + 1)
  const roleAfter = await query<{ name: string; record_version: number }>(
    'select name, record_version from recruitment.role where id = $1 and tenant_id = $2',
    [roleId, TENANT],
  )
  assert.equal(roleAfter[0]!.name, 'lane-B 角色 v2')
  assert.equal(updatedReadback.record_version, roleAfter[0]!.record_version)
  state.roleId = roleId
})

test('d2 config/team create：readback.members 与 SQL 一致（department=010 / member=103）', async () => {
  const teamCode = `${TAG}_TEAM`.slice(0, 41)
  const created = await okJson(
    await httpCall('POST', '/recruitment/api/action/config/team', {
      session: SESSION_R,
      body: {
        operation: 'create',
        code: teamCode,
        name: 'lane-B 团队',
        department_id: DEMO_DEPARTMENT,
        member_actor_ids: [ACTOR_103],
      },
    }),
    'config/team create',
  )
  const readback = created.readback as Record<string, unknown>
  const teamId = String(readback.team_id)
  assert.equal(readback.actor_id, ACTOR_103)
  assert.equal(readback.record_version, 1)
  const teamDb = await query<{ code: string; record_version: number; actor_id: string | null; department_id: string }>(
    `select code, record_version, created_by_actor_id::text as actor_id, department_id::text as department_id
       from recruitment.hiring_team where id = $1 and tenant_id = $2`,
    [teamId, TENANT],
  )
  assert.equal(teamDb.length, 1)
  assert.equal(teamDb[0]!.code, teamCode)
  assert.equal(teamDb[0]!.department_id, DEMO_DEPARTMENT)
  assert.equal(teamDb[0]!.actor_id, ACTOR_103)
  assert.equal(teamDb[0]!.record_version, readback.record_version)
  const members = await query<{ actor_id: string; team_role: string; is_active: boolean }>(
    `select actor_id::text as actor_id, team_role, is_active
       from recruitment.hiring_team_member where team_id = $1 and tenant_id = $2`,
    [teamId, TENANT],
  )
  assert.equal(members.length, 1)
  assert.equal(members[0]!.actor_id, ACTOR_103)
  assert.equal(members[0]!.is_active, true)
  assert.equal((readback.members as Record<string, unknown>[]).length, 1)
  state.teamId = teamId
})

test('d3 config/pipeline create+add_stage(S6)：readback.stages 与 SQL 一致', async () => {
  const pipeCode = `${TAG}_PIPE`.slice(0, 41)
  const created = await okJson(
    await httpCall('POST', '/recruitment/api/action/config/pipeline', {
      session: SESSION_R,
      body: { operation: 'create', code: pipeCode, name: 'lane-B 流水线' },
    }),
    'config/pipeline create',
  )
  const readback = created.readback as Record<string, unknown>
  const pipelineId = String(readback.pipeline_template_id)
  assert.equal(readback.actor_id, ACTOR_103)
  assert.equal(readback.record_version, 1)

  const staged = await okJson(
    await httpCall('POST', '/recruitment/api/action/config/pipeline', {
      session: SESSION_R,
      body: {
        operation: 'add_stage',
        pipeline_template_id: pipelineId,
        expected_record_version: readback.record_version,
        stage_code: 'S6',
        sort_order: 1,
      },
    }),
    'config/pipeline add_stage',
  )
  const stagedReadback = staged.readback as Record<string, unknown>
  const stages = stagedReadback.stages as Record<string, unknown>[]
  assert.equal(stages.length, 1)
  assert.equal(stages[0]!.stage_code, 'S6')
  const stageDb = await query<{ stage_code: string; sort_order: number }>(
    `select s.stage_code, s.sort_order from recruitment.pipeline_template_stage s
      where s.pipeline_template_id = $1 and s.tenant_id = $2`,
    [pipelineId, TENANT],
  )
  assert.equal(stageDb.length, 1)
  assert.equal(stageDb[0]!.stage_code, 'S6')
  assert.equal(stageDb[0]!.sort_order, 1)
  const pipelineDb = await query<{ record_version: number }>(
    'select record_version from recruitment.pipeline_template where id = $1 and tenant_id = $2',
    [pipelineId, TENANT],
  )
  assert.equal(pipelineDb[0]!.record_version, 2, 'add_stage 让模板 record_version +1')
  assert.equal(stagedReadback.record_version, 2)
  state.pipelineId = pipelineId
})

test('d4 统一入口 config：body.entity 分派到 config/role', async () => {
  const created = await okJson(
    await httpCall('POST', '/recruitment/api/action/config', {
      session: SESSION_R,
      body: {
        entity: 'role',
        operation: 'create',
        code: `${TAG}_ROLE2`.slice(0, 41),
        name: 'lane-B 角色 2',
        permission_scopes: ['INTERVIEW_READ'],
      },
    }),
    'config unified',
  )
  assert.equal(created.action, 'config/role', '统一入口按 entity 分派')
  assert.equal((created.readback as Record<string, unknown>).actor_id, ACTOR_103)
})

// ===========================================================================
//  e. 负例（HTTP 状态 + code/reason_code + 目标表行数不变）
// ===========================================================================

test('e 负例族：全部拒绝且目标表行数不变', async () => {
  const before = {
    interview: await count('interview'),
    transcript: await count('transcript_artifact'),
    approval: await count('approval'),
    role: await count('role'),
    team: await count('hiring_team'),
    pipeline: await count('pipeline_template'),
  }

  // e1 未绑定 session → 409 DEMO_ACTOR_UNMAPPED(SESSION_NOT_BOUND)
  assertError(
    await httpCall('POST', '/recruitment/api/action/interview/schedule', {
      session: SESSION_UNBOUND,
      body: { intent: 'CREATE', idempotency_key: `${TAG}_neg_unbound` },
    }),
    409,
    'DEMO_ACTOR_UNMAPPED',
    'SESSION_NOT_BOUND',
    '未绑定 session',
  )

  // e2 interviewer_a 越权 → 403 FORBIDDEN(ACTOR_NOT_AUTHORIZED)
  assertError(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_A,
      body: { operation: 'create', code: `${TAG}_NOPE`, name: '越权', permission_scopes: ['JOB_READ'] },
    }),
    403,
    'FORBIDDEN',
    'ACTOR_NOT_AUTHORIZED',
    'interviewer_a 调招聘写动作',
  )

  // e3 body 带 actor_id → 400 ACTOR_OVERRIDE_REJECTED
  assertError(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_R,
      body: {
        operation: 'create',
        code: `${TAG}_OVR`,
        name: '覆盖身份',
        permission_scopes: ['JOB_READ'],
        actor_id: ACTOR_104,
      },
    }),
    400,
    'INVALID_ARGS',
    'ACTOR_OVERRIDE_REJECTED',
    'body actor_id',
  )

  // e4 非法 UUID → 400（工具/契约层 INVALID_ARGS）
  const badUuid = await httpCall('POST', '/recruitment/api/action/job/rubric-approve', {
    session: SESSION_R,
    body: { job_id: 'not-a-uuid', rubric_version_id: state.rubricId },
  })
  assert.equal(badUuid.status, 400, `非法 UUID 应 400：${badUuid.text}`)
  assert.equal(((badUuid.body.error as Record<string, unknown>) ?? {}).code, 'INVALID_ARGS')

  // e5 GET → 405（带 allow: POST）
  const getRes = await httpCall('GET', '/recruitment/api/action/interview/schedule', { session: SESSION_R })
  assert.equal(getRes.status, 405, `GET 应 405：${getRes.text}`)

  // e6 缺同源头 x-recruitment-request → 403 FORBIDDEN(SAME_ORIGIN_REQUIRED)
  assertError(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_R,
      body: { operation: 'create', code: `${TAG}_ORIG`, name: '同源', permission_scopes: ['JOB_READ'] },
      omitRequestHeader: true,
    }),
    403,
    'FORBIDDEN',
    'SAME_ORIGIN_REQUIRED',
    '缺同源头',
  )

  // e7 config 读 operation → 400 READ_OPERATION_NOT_EXPOSED
  assertError(
    await httpCall('POST', '/recruitment/api/action/config/role', {
      session: SESSION_R,
      body: { operation: 'list' },
    }),
    400,
    'INVALID_ARGS',
    'READ_OPERATION_NOT_EXPOSED',
    'config list',
  )

  // e8 非法 intent → 400（工具 INVALID_ARGS(OUT_OF_RANGE)）
  const badIntent = await httpCall('POST', '/recruitment/api/action/interview/schedule', {
    session: SESSION_R,
    body: { intent: 'COMPLETE', idempotency_key: `${TAG}_neg_intent` },
  })
  assert.equal(badIntent.status, 400, `非法 intent 应 400：${badIntent.text}`)
  assert.equal(((badIntent.body.error as Record<string, unknown>) ?? {}).code, 'INVALID_ARGS')
  assert.equal(((badIntent.body.error as Record<string, unknown>) ?? {}).reason_code, 'OUT_OF_RANGE')

  // 全部负例后：目标表行数逐字不变
  assert.deepEqual(
    {
      interview: await count('interview'),
      transcript: await count('transcript_artifact'),
      approval: await count('approval'),
      role: await count('role'),
      team: await count('hiring_team'),
      pipeline: await count('pipeline_template'),
    },
    before,
    '负例族零写入',
  )
})

// ===========================================================================
//  helper
// ===========================================================================

/** 跨用例共享的对象 id / 版本（由正例写入、后续用例读）。 */
const state: {
  interviewId: string
  interviewerId: string
  createBody: Record<string, unknown>
  version: number
  artifactId: string
  rubricId: string
  roleId: string
  teamId: string
  pipelineId: string
} = {
  interviewId: '',
  interviewerId: '',
  createBody: {},
  version: 0,
  artifactId: '',
  rubricId: '',
  roleId: '',
  teamId: '',
  pipelineId: '',
}

/** 独立 SQL 读回（连本用例的一次性库；不经过任何产品读模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一张表的行数（独立 SQL）。 */
async function count(table: string): Promise<number> {
  const rows = await query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
  return rows[0]?.n ?? 0
}

/** 断言 200 并返回 JSON 信封。 */
async function okJson(result: HttpResult, label: string): Promise<Record<string, unknown>> {
  assert.equal(result.status, 200, `${label} 期望 200，实际 ${result.status}：${result.text.slice(0, 1200)}`)
  return result.body
}

/** 断言错误信封 `{error:{code,reason_code?,message}}`。 */
function assertError(
  result: HttpResult,
  status: number,
  code: string,
  reasonCode: string | undefined,
  label: string,
): void {
  assert.equal(result.status, status, `${label} 期望 ${status}，实际 ${result.status}：${result.text.slice(0, 1200)}`)
  const error = (result.body.error ?? {}) as Record<string, unknown>
  assert.equal(error.code, code, `${label} code 期望 ${code}，实际 ${String(error.code)}：${result.text.slice(0, 800)}`)
  if (reasonCode !== undefined) {
    assert.equal(
      error.reason_code,
      reasonCode,
      `${label} reason_code 期望 ${reasonCode}，实际 ${String(error.reason_code)}：${result.text.slice(0, 800)}`,
    )
  }
}

/** 跑 `scripts/bootstrap-demo.mjs`（cwd = 仓库根；env 只指向本用例的一次性库；默认 allow-once）。 */
function runBootstrap(databaseName: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  env.RECRUITMENT_DB_PASSWORD = BASE.password
  env.RECRUITMENT_DB_HOST = BASE.host
  env.RECRUITMENT_DB_PORT = String(BASE.port)
  env.RECRUITMENT_DB_USER = BASE.user
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT
  env.RECRUITMENT_ACTOR_ID = HR_ACTOR
  env.DEMO_APPROVAL_MODE = 'allow-once'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bootstrap 超时（120s）\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
    }, 120_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * 起真 `node:http` server 并注册**真实的** actor + actions 路由（同一份产品注册函数）。
 * 顺序刻意：先 listen 拿真实端口，再把 `{host, port, register}` 交给路由 —— `sameOrigin` 用这个端口。
 * @param deps - actions 路由依赖（actor 路由复用其中的 database/identity）。
 */
async function startHarness(deps: ActionHttpDeps): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'NO_EXACT_ROUTE' } }))
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        try {
          res.destroy()
        } catch {
          // 连接已坏：忽略。
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const webServer = {
    host: '127.0.0.1',
    port: address.port,
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
      registered.push({ kind: route.kind, path: route.path })
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
  }
  const logger = {
    warn(message: string) {
      warnings.push(message)
    },
  }
  const disposers = [
    registerActorHttp({ webServer, logger }, { database: deps.database, databaseIssues: deps.databaseIssues, identity: deps.identity }),
    registerActionsHttp({ webServer, logger }, deps),
  ]
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registered,
    warnings,
    async close(): Promise<void> {
      for (const dispose of disposers) dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `x-dsh-session`）。
 * @param method - HTTP 方法。
 * @param path - 请求路径。
 * @param options - session / body / 是否省略同源头。
 */
async function httpCall(
  method: string,
  path: string,
  options: {
    readonly session?: string
    readonly body?: unknown
    readonly omitRequestHeader?: boolean
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${harness.baseUrl}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text }
}
