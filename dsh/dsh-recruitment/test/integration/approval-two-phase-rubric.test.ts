// `recruitment_job_rubric_approve` 的**两阶段批准**（D-101）集成测试：一次性空库、**真提交**。
//
// 为什么必须独占库 + 真提交（而不是 `inRolledBackTx`）：被验证的事实是"等人期间没有
// 未结束的事务"——工具走 `execute()` 自建连接池，`prepare` 的只读事务**必须先提交**，
// 独立连接才能在 `pg_stat_activity` 里看到它的连接是 `idle` 而不是 `idle in transaction`。
// 回滚事务里根本不存在"提交"这一步，测不到目标事实。
//
// 覆盖（G11 / D-101 的验收点）：
//   1. **慢批准 2500ms**：独立 `pg` 连接轮询 `pg_stat_activity`（本隔离库），等待期间
//      **没有** `state='idle in transaction'`，且采样到工具连接 `state='idle'`；allow 后
//      outcome=APPROVED、指针指向该版本（真读回）。
//   2. **deny 零写入**：approval='rejected' → FORBIDDEN(APPROVAL_NOT_GRANTED)；approval /
//      job / event_inbox 行数与 job 指针/record_version、approval 行状态逐项不变。
//   3. **replay 不二次问人**：真提交批准后同参再调 → outcome=NO_OP、replayed=true、
//      approval 调用次数 = 0、逐表 delta = 0。
//   4. **cancelled 零写入**：approval='cancelled' → FORBIDDEN(APPROVAL_NOT_GRANTED)，逐表 delta = 0。
//
// 纪律：连不上库就失败（不静默 skip，R3 要求 skipped === 0）；不碰共享库 `ra_s6s7`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { createJobRubricApproveTool } from '../../src/tools/job-rubric-approve.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  HR_ACTOR,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  errorBody,
  one,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

/** 共享库配置（租户 / actor / 密码）；database 在 `before` 里换成一次性库。 */
const BASE_CFG = testDatabaseConfig()

/** 面评/批准夹具用的三维标准（权重和 = 1；`digestOf` 需要能规范化）。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

let db: IsolatedTestDatabase
let CFG: ResolvedDatabaseConfig

test.before(async () => {
  db = await createIsolatedTestDatabase('approval2p')
  assertPrivateDatabase(db.name)
  CFG = { ...BASE_CFG, database: db.name }
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

/** 一个已提交的 PENDING 批准夹具（job + rubric_version + approval）。 */
interface PendingFixture {
  readonly jobId: string
  readonly rubricId: string
  readonly approvalId: string
}

/**
 * 造夹具并**真提交**：`seedScenario(approve:false)` 只建 job/job_version/rubric_version
 * （current 指针留空 = 合法的"待批准"初始态），再补一行 PENDING approval。
 * @param tag - 用例标签（只用于 reason/可读性，不参与断言）。
 * @returns 三个 id。
 */
async function createPendingFixture(tag: string): Promise<PendingFixture> {
  const client = await db.pool.connect()
  try {
    // session 级 actor：夹具 INSERT 的状态迁移要能确定 actor（与 withActor 的 SET LOCAL 同义）。
    await client.query('select set_config($1, $2, false)', ['recruitment.actor_id', HR_ACTOR])
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS, approve: false })
    const hashRows = await client.query<{ payload_hash: string }>(
      'select payload_hash from recruitment.rubric_version where id = $1 and tenant_id = $2',
      [scenario.rubricId, TENANT],
    )
    const payloadHash = hashRows.rows[0]?.payload_hash
    assert.ok(typeof payloadHash === 'string', `${tag}：rubric_version.payload_hash 必须存在`)
    const approvalId = await one(client, `insert into recruitment.approval
        (tenant_id, resource_type, resource_id, resource_record_version,
         payload_schema_version, canonical_payload_hash, status, requested_by_actor_id)
        values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'PENDING', $4) returning id`, [
      TENANT, scenario.rubricId, payloadHash, HR_ACTOR,
    ])
    return { jobId: scenario.jobId, rubricId: scenario.rubricId, approvalId }
  } finally {
    client.release()
  }
}

/** 一次调用前后的可比快照（零写入断言口径：行数 + 关键列的精确值）。 */
interface ApprovalSnapshot {
  readonly rows: {
    readonly approval: number
    readonly job: number
    readonly event_inbox: number
  }
  readonly job: {
    readonly current_rubric_version_id: string | null
    readonly record_version: number
  }
  readonly approval: {
    readonly status: string
    readonly decision_by_actor_id: string | null
    readonly decided_at: string | null
    readonly record_version: number
  }
}

/**
 * 读已提交状态快照（**不经产品代码**，只读 SQL）。
 * @param tag - 断言消息里用的标签。
 * @returns 快照。
 */
async function snapshot(tag: string): Promise<ApprovalSnapshot> {
  const fixture = currentFixture
  assert.ok(fixture !== undefined, `${tag}：还没有夹具`)
  const counts = await db.pool.query<{
    approval: number
    job: number
    event_inbox: number
  }>(`select
        (select count(*)::int from recruitment.approval) as approval,
        (select count(*)::int from recruitment.job) as job,
        (select count(*)::int from recruitment.event_inbox) as event_inbox`)
  const jobRows = await db.pool.query<{ current_rubric_version_id: string | null; record_version: number }>(
    'select current_rubric_version_id, record_version from recruitment.job where id = $1',
    [fixture.jobId],
  )
  const approvalRows = await db.pool.query<{
    status: string
    decision_by_actor_id: string | null
    decided_at: Date | null
    record_version: number
  }>('select status, decision_by_actor_id, decided_at, record_version from recruitment.approval where id = $1', [
    fixture.approvalId,
  ])
  const job = jobRows.rows[0]
  const approval = approvalRows.rows[0]
  const rowCounts = counts.rows[0]
  assert.ok(job !== undefined, `${tag}：job 行必须存在`)
  assert.ok(approval !== undefined, `${tag}：approval 行必须存在`)
  assert.ok(rowCounts !== undefined, `${tag}：count 查询必须返回一行`)
  return {
    rows: rowCounts,
    job: {
      current_rubric_version_id: job.current_rubric_version_id,
      record_version: job.record_version,
    },
    approval: {
      status: approval.status,
      decision_by_actor_id: approval.decision_by_actor_id,
      decided_at: approval.decided_at === null ? null : new Date(approval.decided_at).toISOString(),
      record_version: approval.record_version,
    },
  }
}

/** 当前用例的夹具（`snapshot()` 直接读它；每个用例只造一份）。 */
let currentFixture: PendingFixture | undefined

/** 调工具并返回错误体（成功则 fail）。 */
async function expectToolError(
  tool: ReturnType<typeof createJobRubricApproveTool>,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let thrown: unknown
  try {
    await tool.execute(args, {})
  } catch (error) {
    thrown = error
  }
  assert.notEqual(thrown, undefined, '期望抛错，但成功了')
  return errorBody(thrown)
}

// ---------------------------------------------------------------------------
//  1. 慢批准 2500ms：独立连接轮询 pg_stat_activity，无 idle in transaction
// ---------------------------------------------------------------------------

test('慢批准 2500ms：等待期间无 idle in transaction、工具连接是 idle；allow 后 APPROVED', async () => {
  const fixture = await createPendingFixture('slow-approval')
  currentFixture = fixture
  const before = await snapshot('slow-approval')

  let requestCalls = 0
  /** 真正问人的时刻（= 只读阶段已提交、连接已退回池里）。 */
  let requestedAt = 0
  const approval = {
    request(): Promise<string> {
      requestCalls += 1
      requestedAt = Date.now()
      // 2500ms 后才放行：足够用独立连接采到"工具连接 idle、库里没有 idle in transaction"。
      return new Promise<string>((resolve) => {
        setTimeout(() => resolve('allowed-once'), 2500)
      })
    },
  }
  const tool = createJobRubricApproveTool(CFG, { approval })
  const resultPromise = tool.execute(
    { job_id: fixture.jobId, rubric_version_id: fixture.rubricId, reason: '两阶段慢批准' },
    {},
  )

  // 等 approval.request 真的被调用（而不是靠 sleep 猜）：旧实现此时事务还开着。
  const waitRequestedDeadline = Date.now() + 10_000
  while (requestCalls === 0 && Date.now() < waitRequestedDeadline) await delay(10)
  assert.equal(requestCalls, 1, '写库前必须恰好问人一次')
  assert.ok(requestedAt > 0, 'approval.request 必须被调用')

  // 独立连接轮询（不是工具自己的连接）：等 approval 的 ~2500ms 里持续采样。
  const samples: readonly (readonly SampleRow[])[] = []
  const sampleDeadline = Date.now() + 2300
  while (Date.now() < sampleDeadline) {
    const { rows } = await db.pool.query<SampleRow>(
      `select application_name, state, wait_event_type, wait_event, left(query, 60) as query
         from pg_stat_activity
        where datname = $1
        order by backend_start`,
      [db.name],
    )
    samples.push(rows)
    await delay(100)
  }
  taskAssertSamples(samples)

  const value = await resultPromise as {
    outcome: string
    replayed: boolean
    gate: { requested: boolean; result: string }
    job: { current_rubric_version_id: string }
    changes: { written: boolean; tables: readonly string[] }
  }
  assert.equal(value.outcome, 'APPROVED')
  assert.equal(value.replayed, false)
  assert.deepEqual(value.gate, { requested: true, result: 'allowed-once' })
  assert.equal(value.job.current_rubric_version_id, fixture.rubricId)
  assert.equal(value.changes.written, true)
  assert.equal(requestCalls, 1, '整个调用只问人一次')

  // 真读回：批准已提交、指针指向该版本。
  const after = await snapshot('slow-approval-after')
  assert.equal(after.approval.status, 'APPROVED')
  assert.equal(after.approval.decision_by_actor_id, HR_ACTOR)
  assert.ok((after.approval.record_version as number) > (before.approval.record_version as number))
  assert.equal(after.job.current_rubric_version_id, fixture.rubricId)
  assert.ok(after.job.record_version > before.job.record_version, '指针变更由 fn_row_guard 自增 record_version')
  assert.equal(after.rows.approval, before.rows.approval)
  // 写入路径固定两条事件：`approval.status.changed`（fn_row_guard 触发器）
  // + `job.rubric_version.approved`（本工具）。NO_OP / deny 路径一条都不写（见 §3/§2）。
  assert.equal(after.rows.event_inbox, before.rows.event_inbox + 2, '写入路径必须恰好两条审计事件')
})

/**
 * 断言慢批准采样：等待期间**没有** `idle in transaction`，且工具连接处于 `idle`。
 * 这两个断言合起来才是 D-101 的"问人不在事务里"：连接还在（池里），但事务已提交。
 * @param samples - 每轮 `pg_stat_activity` 的整表快照（本隔离库）。
 */
function taskAssertSamples(samples: readonly (readonly SampleRow[])[]): void {
  assert.ok(samples.length >= 10, `采样轮数不足：${samples.length}（期望 ≥10）`)
  const toolName = 'dsh-recruitment-s6s7'
  let sawToolIdle = false
  for (const [index, rows] of samples.entries()) {
    for (const row of rows) {
      assert.notEqual(
        row.state,
        'idle in transaction',
        `第 ${index} 轮采样出现 idle in transaction（应用名=${row.application_name}，`
          + `wait=${row.wait_event_type ?? 'null'}/${row.wait_event ?? 'null'}，query=${row.query}）`,
      )
      if (row.application_name === toolName && row.state === 'idle') sawToolIdle = true
    }
  }
  assert.equal(sawToolIdle, true, `等待期间必须采样到工具连接（${toolName}）state=idle —— 证明它不在事务里`)
}

/** 采样行的形状（放在函数外，供 `taskAssertSamples` 与轮询共用）。 */
interface SampleRow {
  readonly application_name: string
  readonly state: string
  readonly wait_event_type: string | null
  readonly wait_event: string | null
  readonly query: string
}

// ---------------------------------------------------------------------------
//  2. deny 零写入
// ---------------------------------------------------------------------------

test('deny：approval=rejected → FORBIDDEN(APPROVAL_NOT_GRANTED)，逐表 delta=0', async () => {
  const fixture = await createPendingFixture('deny')
  currentFixture = fixture
  const before = await snapshot('deny-before')

  let calls = 0
  const tool = createJobRubricApproveTool(CFG, {
    approval: {
      async request(): Promise<string> {
        calls += 1
        return 'rejected'
      },
    },
  })
  const body = await expectToolError(tool, { job_id: fixture.jobId, rubric_version_id: fixture.rubricId })
  assert.equal(body.code, 'FORBIDDEN')
  assert.equal(body.reason_code, 'APPROVAL_NOT_GRANTED')
  assert.deepEqual(body.detail, { approval: 'rejected', tool: 'recruitment_job_rubric_approve' })
  assert.equal(calls, 1, '闸门必须真的问过人（不是没问就拒）')

  const after = await snapshot('deny-after')
  assert.deepEqual(after, before, 'deny：approval/job/event_inbox 行数与关键列必须逐项不变')
  assert.equal(after.rows.event_inbox, before.rows.event_inbox, 'deny 不得写审计事件')
  assert.equal(after.approval.status, 'PENDING')
  assert.equal(after.job.current_rubric_version_id, null)
})

// ---------------------------------------------------------------------------
//  3. replay 不二次问人、零额外写入
// ---------------------------------------------------------------------------

test('replay：真提交批准后同参再调 → NO_OP、replayed=true、approval 调用=0、逐表 delta=0', async () => {
  const fixture = await createPendingFixture('replay')
  currentFixture = fixture
  const tool = createJobRubricApproveTool(CFG, {
    approval: { request: async () => 'allowed-once' },
  })
  const first = await tool.execute(
    { job_id: fixture.jobId, rubric_version_id: fixture.rubricId },
    {},
  ) as { outcome: string; changes: { written: boolean } }
  assert.equal(first.outcome, 'APPROVED')
  assert.equal(first.changes.written, true)
  const before = await snapshot('replay-before')

  let replayCalls = 0
  const replayTool = createJobRubricApproveTool(CFG, {
    approval: {
      async request(): Promise<string> {
        replayCalls += 1
        return 'allowed-once'
      },
    },
  })
  const second = await replayTool.execute(
    { job_id: fixture.jobId, rubric_version_id: fixture.rubricId },
    {},
  ) as {
    outcome: string
    replayed: boolean
    gate: { requested: boolean; result: string }
    changes: { written: boolean; tables: readonly string[]; event_ids: readonly string[] }
  }
  assert.equal(replayCalls, 0, '纯重放不得打扰人（D-95）')
  assert.equal(second.outcome, 'NO_OP')
  assert.equal(second.replayed, true)
  assert.deepEqual(second.gate, { requested: false, result: 'not-required' })
  assert.equal(second.changes.written, false)
  assert.deepEqual(second.changes.tables, [])
  assert.deepEqual(second.changes.event_ids, [])

  const after = await snapshot('replay-after')
  assert.deepEqual(after, before, 'replay：不得有任何新写入')
  assert.equal(after.approval.status, 'APPROVED')
  assert.equal(after.job.current_rubric_version_id, fixture.rubricId)
})

// ---------------------------------------------------------------------------
//  4. cancelled 零写入
// ---------------------------------------------------------------------------

test('cancelled：approval=cancelled → FORBIDDEN(APPROVAL_NOT_GRANTED)，逐表 delta=0', async () => {
  const fixture = await createPendingFixture('cancelled')
  currentFixture = fixture
  const before = await snapshot('cancelled-before')
  const tool = createJobRubricApproveTool(CFG, {
    approval: { request: async () => 'cancelled' },
  })
  const body = await expectToolError(tool, { job_id: fixture.jobId, rubric_version_id: fixture.rubricId })
  assert.equal(body.code, 'FORBIDDEN')
  assert.equal(body.reason_code, 'APPROVAL_NOT_GRANTED')
  assert.deepEqual(body.detail, { approval: 'cancelled', tool: 'recruitment_job_rubric_approve' })

  const after = await snapshot('cancelled-after')
  assert.deepEqual(after, before, 'cancelled：不得有任何写入')
  assert.equal(after.approval.status, 'PENDING')
  assert.equal(after.job.current_rubric_version_id, null)
  assert.equal(after.rows.event_inbox, before.rows.event_inbox)
})
