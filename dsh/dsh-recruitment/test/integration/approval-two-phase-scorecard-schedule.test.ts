// D-101 两阶段审批的**真提交**集成测试：scorecard-submit 与 interview-schedule。
//
// 为什么必须独占一次性库（`createIsolatedTestDatabase`）而不是 `ra_s6s7` 的回滚事务：
//   本文件要证明的是**跨事务、跨连接**的事实 ——
//   ① 人等待批准期间，工具连接处于 `state='idle'` 而**不是** `idle in transaction`（要用
//      **独立 pg.Client** 查 `pg_stat_activity`，工具自己的池里看不到自己"不在事务里"这件事的全局视图）；
//   ② deny / cancelled 时逐表 delta=0（跨事务读回）；
//   ③ 幂等重放第二次调用**不问人**（approval 替身调用次数 = 0）且表行数不变。
//   回滚事务里 approve 一返回事务就结束了，"等待窗口"根本不存在，上述三件事都测不出来。
//
// 所以：`createIsolatedTestDatabase()` + 真提交；`assertPrivateDatabase()` 守住"绝不在共享库上真提交"。
//
// 覆盖（任务书四项 + 一项零写入闸门补强）：
//   1. 慢批准 2500ms（远小于生产 120s 上界）：等待期间 `pg_stat_activity` 里
//      `application_name='dsh-recruitment-s6s7'` 的行**没有** `idle in transaction`，
//      且至少采样到一次 `state='idle'`（证明连接存在、只是不在事务里）；allow 到达后工具成功、
//      DB 有行。scorecard 与 schedule(CREATE) 各一条。
//   2. deny（approval='rejected'）→ `FORBIDDEN(APPROVAL_NOT_GRANTED)`；独立连接逐表 count delta=0。
//   3. replay：同参同 idempotency_key 真提交调两次，第二次 `replayed=true`、第二次期间
//      approval 调用数 = 0、表行数不变。
//   4. cancelled → `FORBIDDEN(APPROVAL_NOT_GRANTED)` + 零写入。
//   5. 零写入的幂等成功（CANCEL 已 CANCELLED / WITHDRAW 已退出，换 key 重来）**不问人**：
//      只有真写库的分支才过闸门。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createInterviewScheduleTool } from '../../src/tools/interview-schedule.ts'
import {
  resolveDatabaseConfig,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  errorBody,
  HR_ACTOR,
  one,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
  type IsolatedTestDatabase,
} from './db.ts'

/** 工具池的 `application_name`（`src/db/pool.ts` 的 `createPool` 写死；这里是**独立**观测口径）。 */
const TOOL_APPLICATION_NAME = 'dsh-recruitment-s6s7'
/** 观测/读回用的独立连接（故意与工具池的 application_name 不同）。 */
const PROBE_APPLICATION_NAME = 'approval-two-phase-probe'
/** 人工批准等待时长：2.5s（远小于生产 120s 上界，但要足够采样）。 */
const SLOW_APPROVAL_MS = 2_500
/** 采样间隔（毫秒）。 */
const SAMPLE_INTERVAL_MS = 100

/** 种子库里的两个演示 HUMAN actor（`0002_seed.sql`）。 */
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'

/** 面评写库的两张表（"零写入"的证明口径）。 */
const SCORECARD_TABLES = ['scorecard', 'event_inbox'] as const
/** 排期写库的六张表（"零写入"的证明口径，`tool-contracts.md` §5.1 W1）。 */
const SCHEDULE_TABLES = [
  'interview', 'interviewer', 'meeting', 'meeting_binding', 'business_task', 'event_inbox',
] as const

/** 面评用的三个维度（与 scorecard 集成测试同形）。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/** `pg_stat_activity` 里本工具连接的一行。 */
interface ActivityRow {
  readonly pid: number
  readonly datname: string
  readonly application_name: string
  readonly state: string
}

/** 一次性库句柄 + 指向它的库配置（整个文件共用；top-level test 串行执行）。 */
let iso: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig

before(async () => {
  iso = await createIsolatedTestDatabase('approval2phase')
  // 守卫：真提交的用例绝不跑在共享库上（并行跑会互相偷行）。
  assertPrivateDatabase(iso.name)
  const base = testDatabaseConfig()
  const { resolved, issues } = resolveDatabaseConfig({
    host: base.host,
    port: base.port,
    user: base.user,
    database: iso.name,
    tenant_id: TENANT,
    actor_id: HR_ACTOR,
  }, process.env)
  if (resolved === null) throw new Error(`一次性库配置解析失败：${issues.join('; ')}`)
  cfg = resolved
})

after(async () => {
  await iso.drop()
})

/**
 * 在一次性库里**真提交**一段夹具（先 `set_config` 再写，与产品写事务同一套 GUC 语义）。
 * @param fn - 夹具构造（可写库）。
 * @returns 构造结果。
 */
async function withCommitted<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await iso.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 保留第一个错误。
    }
    throw error
  } finally {
    client.release()
  }
}

/** 一条**独立**观测连接（不经工具的 pool；连同一个隔离库）。 */
async function openProbe(): Promise<pg.Client> {
  const probe = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: iso.name,
    application_name: PROBE_APPLICATION_NAME,
  })
  await probe.connect()
  return probe
}

/** 查 `pg_stat_activity`：只看**这个隔离库**上、本工具 `application_name` 的后端。 */
const ACTIVITY_SQL = `select pid, datname, application_name, state
   from pg_stat_activity
  where datname = $1 and application_name = $2
  order by pid`

async function sampleToolActivity(probe: pg.Client): Promise<ActivityRow[]> {
  const { rows } = await probe.query<ActivityRow>(ACTIVITY_SQL, [iso.name, TOOL_APPLICATION_NAME])
  return rows
}

/** 用**独立连接**数若干张表的行数（"零写入"的证明口径）。 */
async function tableCounts(tables: readonly string[]): Promise<Record<string, number>> {
  const probe = await openProbe()
  try {
    const counts: Record<string, number> = {}
    for (const table of tables) {
      const { rows } = await probe.query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
      counts[table] = rows[0]?.n ?? 0
    }
    return counts
  } finally {
    await probe.end()
  }
}

/** 从契约错误里断言 `FORBIDDEN` + `reason_code`（并核对 `detail`）。 */
async function expectForbidden(
  run: () => Promise<unknown>,
  reasonCode: 'APPROVAL_UNAVAILABLE' | 'APPROVAL_NOT_GRANTED',
  approval: 'unavailable' | 'rejected' | 'cancelled' | 'timeout',
  tool: string,
): Promise<Record<string, unknown>> {
  try {
    await run()
  } catch (error) {
    const body = errorBody(error)
    assert.equal(body.code, 'FORBIDDEN', `期望 FORBIDDEN，实际 ${String(body.code)}`)
    assert.equal(body.reason_code, reasonCode)
    assert.deepEqual(body.detail, { approval, tool })
    return body
  }
  assert.fail(`期望抛 FORBIDDEN/${reasonCode}，但成功了`)
}

// ---------------------------------------------------------------------------
//  夹具（全部真提交到一次性库）
// ---------------------------------------------------------------------------

/** 面评入参（NO_TRANSCRIPT：该场面试没有 READY 的 canonical transcript）。 */
function scorecardArgs(interviewId: string, key: string): Record<string, unknown> {
  return {
    interview_id: interviewId,
    items: {
      transcript_basis: 'NO_TRANSCRIPT',
      backend_depth: { assessment: 'MET', score: 4, note: '讲清了分片键的选择' },
      async_pipeline: { assessment: 'NOT_MET', score: 2, note: '队列重放答不上来' },
      frontend_basics: { assessment: 'NOT_OBSERVED' },
    },
    overall: 'HOLD',
    idempotency_key: key,
  }
}

/** 造一场可提交面评的面试（面试官 = 工具 actor `HR_ACTOR`，因为 `execute()` 用配置里的 actor）。 */
async function seedScorecardFixture(): Promise<{ interviewId: string; args: Record<string, unknown> }> {
  return await withCommitted(async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    const interviewId = await one(
      client,
      `insert into recruitment.interview
         (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at)
       values ($1, $2, 1, 'DEFAULT', 'POST_INTERVIEW', now() - interval '2 days') returning id`,
      [TENANT, scenario.applicationId],
    )
    await one(
      client,
      `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
       values ($1, $2, $3, true) returning id`,
      [TENANT, interviewId, HR_ACTOR],
    )
    return { interviewId, args: scorecardArgs(interviewId, `two-phase:${uniqueSuffix()}`) }
  })
}

/**
 * 每份排期夹具独占一天（未来第 7 天起）：本文件是**真提交**的，前一用例写进库的面试
 * 会真实占位（面试官/候选人冲突），所以窗口必须确定且互不重叠——不能都写死同一个时刻。
 */
let scheduleSlotCounter = 0

/** 造一份可排期的申请（未来第 7 天起、每个夹具独占一天，保证 START_IN_PAST 与冲突判定都稳定）。 */
async function seedScheduleFixture(): Promise<{ applicationId: string; args: Record<string, unknown> }> {
  scheduleSlotCounter += 1
  const scheduledStart = new Date(
    Date.now() + (7 + scheduleSlotCounter) * 24 * 3600_000,
  ).toISOString()
  return await withCommitted(async (client) => {
    const scenario = await seedScenario(client, { dimensions: [...DIMENSIONS] })
    return {
      applicationId: scenario.applicationId,
      args: {
        intent: 'CREATE',
        idempotency_key: `two-phase:${uniqueSuffix()}`,
        application_id: scenario.applicationId,
        round_no: 1,
        interviewers: [{ actor_id: INTERVIEWER_A }],
        scheduled_start_at: scheduledStart,
        duration_minutes: 60,
      },
    }
  })
}

// ---------------------------------------------------------------------------
//  1. 慢批准：等待窗口内**没有** idle in transaction，但连接存在且 idle
// ---------------------------------------------------------------------------

/** 采样断言：没有 idle in transaction，且至少一次 idle（连接存在但不在事务里）。 */
function assertNoIdleInTransaction(samples: readonly ActivityRow[], label: string): void {
  assert.ok(samples.length > 0, `${label}：等待窗口内至少要采样到工具连接（pg_stat_activity 为空 = 工具压根没连库）`)
  assert.deepEqual(
    samples.map((row) => row.application_name).filter((name) => name !== TOOL_APPLICATION_NAME),
    [],
    `${label}：采样只应命中本工具 application_name 的后端`,
  )
  const inTransaction = samples.filter((row) => row.state === 'idle in transaction')
  assert.equal(
    inTransaction.length,
    0,
    `${label}：等待人工批准期间不得有 idle in transaction（实测 state 序列：${JSON.stringify(samples.map((row) => row.state))}）`,
  )
  assert.ok(
    samples.some((row) => row.state === 'idle'),
    `${label}：等待窗口内必须观察到连接存在且 state='idle'（实测 state 序列：${JSON.stringify(samples.map((row) => row.state))}）`,
  )
}

test('慢批准(2500ms)：scorecard execute 期间没有 idle in transaction，连接 idle；allow 后写库成功', async () => {
  const { interviewId, args } = await seedScorecardFixture()
  // 让"等待开始"可观测：approval.request 一旦被调用就 resolve waiting。
  let signalWaiting: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => {
    signalWaiting = resolve
  })
  const instrumented = createScorecardSubmitTool({
    database: cfg,
    approval: {
      async request(): Promise<string> {
        signalWaiting?.()
        await new Promise((resolve) => setTimeout(resolve, SLOW_APPROVAL_MS))
        return 'allowed-once'
      },
    },
  })
  const pending = instrumented.execute(args, {}) as Promise<Record<string, unknown>>
  await waiting

  const probe = await openProbe()
  const samples: ActivityRow[] = []
  try {
    const deadline = Date.now() + SLOW_APPROVAL_MS - 400
    while (Date.now() < deadline) {
      samples.push(...await sampleToolActivity(probe))
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
    }
  } finally {
    await probe.end()
  }
  const value = await pending
  assertNoIdleInTransaction(samples, 'scorecard 慢批准')

  assert.equal(value.status, 'OK')
  assert.equal(value.replayed, false)
  const scorecard = value.scorecard as Record<string, unknown>
  assert.equal(scorecard.status, 'SUBMITTED')
  assert.equal(scorecard.interview_id, interviewId)
  // 独立读回：DB 里真的有一行。
  const counts = await tableCounts(['scorecard'])
  assert.equal(counts.scorecard, 1, 'allow 到达后必须真的写进 1 行 scorecard')
})

test('慢批准(2500ms)：schedule(CREATE) execute 期间没有 idle in transaction，连接 idle；allow 后写库成功', async () => {
  const { args } = await seedScheduleFixture()
  let signalWaiting: (() => void) | undefined
  const waiting = new Promise<void>((resolve) => {
    signalWaiting = resolve
  })
  const tool = createInterviewScheduleTool(cfg, {
    approval: {
      async request(): Promise<string> {
        signalWaiting?.()
        await new Promise((resolve) => setTimeout(resolve, SLOW_APPROVAL_MS))
        return 'allowed-once'
      },
    },
  })
  const pending = tool.execute(args, {}) as Promise<Record<string, unknown>>
  await waiting

  const probe = await openProbe()
  const samples: ActivityRow[] = []
  try {
    const deadline = Date.now() + SLOW_APPROVAL_MS - 400
    while (Date.now() < deadline) {
      samples.push(...await sampleToolActivity(probe))
      await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
    }
  } finally {
    await probe.end()
  }
  const value = await pending
  assertNoIdleInTransaction(samples, 'schedule(CREATE) 慢批准')

  assert.equal(value.status, 'OK')
  assert.equal(value.replayed, false)
  assert.equal(value.intent, 'CREATE')
  const interview = value.interview as Record<string, unknown>
  assert.ok(typeof interview.id === 'string' && interview.id !== '')
  // 独立读回：interview 行真的存在（且 status=SCHEDULED）。
  const probe2 = await openProbe()
  try {
    const { rows } = await probe2.query<{ status: string }>(
      'select status from recruitment.interview where id = $1 and tenant_id = $2',
      [interview.id, TENANT],
    )
    assert.equal(rows[0]?.status, 'SCHEDULED')
  } finally {
    await probe2.end()
  }
})

// ---------------------------------------------------------------------------
//  2. deny：FORBIDDEN + 逐表 delta = 0
// ---------------------------------------------------------------------------

test('deny(rejected)：scorecard → FORBIDDEN(APPROVAL_NOT_GRANTED)，scorecard / event_inbox delta=0', async () => {
  const { args } = await seedScorecardFixture()
  const tool = createScorecardSubmitTool({
    database: cfg,
    approval: { request: async () => 'rejected' },
  })
  const before = await tableCounts(SCORECARD_TABLES)
  await expectForbidden(
    () => tool.execute(args, {}),
    'APPROVAL_NOT_GRANTED',
    'rejected',
    'recruitment_scorecard_submit',
  )
  const after = await tableCounts(SCORECARD_TABLES)
  assert.deepEqual(after, before, 'deny 必须零写入（scorecard / event_inbox 行数不变）')
})

test('deny(rejected)：schedule(CREATE) → FORBIDDEN(APPROVAL_NOT_GRANTED)，六张表 delta=0', async () => {
  const { args } = await seedScheduleFixture()
  const tool = createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'rejected' },
  })
  const tables = SCHEDULE_TABLES
  const before = await tableCounts(tables)
  await expectForbidden(
    () => tool.execute(args, {}),
    'APPROVAL_NOT_GRANTED',
    'rejected',
    'recruitment_interview_schedule',
  )
  const after = await tableCounts(tables)
  assert.deepEqual(after, before, 'deny 必须零写入（六张表行数不变）')
})

// ---------------------------------------------------------------------------
//  3. cancelled：同样 FORBIDDEN + 零写入
// ---------------------------------------------------------------------------

test('cancelled：scorecard 与 schedule 都 FORBIDDEN(APPROVAL_NOT_GRANTED) 且零写入', async () => {
  const scorecardFixture = await seedScorecardFixture()
  const scorecardTool = createScorecardSubmitTool({
    database: cfg,
    approval: { request: async () => 'cancelled' },
  })
  const scorecardTables = SCORECARD_TABLES
  const scorecardBefore = await tableCounts(scorecardTables)
  await expectForbidden(
    () => scorecardTool.execute(scorecardFixture.args, {}),
    'APPROVAL_NOT_GRANTED',
    'cancelled',
    'recruitment_scorecard_submit',
  )
  assert.deepEqual(await tableCounts(scorecardTables), scorecardBefore, 'scorecard cancelled 必须零写入')

  const scheduleFixture = await seedScheduleFixture()
  const scheduleTool = createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'cancelled' },
  })
  const scheduleTables = SCHEDULE_TABLES
  const scheduleBefore = await tableCounts(scheduleTables)
  await expectForbidden(
    () => scheduleTool.execute(scheduleFixture.args, {}),
    'APPROVAL_NOT_GRANTED',
    'cancelled',
    'recruitment_interview_schedule',
  )
  assert.deepEqual(await tableCounts(scheduleTables), scheduleBefore, 'schedule cancelled 必须零写入')
})

// ---------------------------------------------------------------------------
//  5. 零写入的幂等成功：**不问人**（只有真写库的分支才过闸门）
// ---------------------------------------------------------------------------

test('零写入幂等成功不问人：CANCEL 已 CANCELLED（换 key）→ 成功、零写入、approval 调用数 = 0', async () => {
  const { args: createArgs } = await seedScheduleFixture()
  const created = await createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'allowed-once' },
  }).execute(createArgs, {}) as Record<string, unknown>
  const createdInterview = created.interview as Record<string, unknown>
  const interviewId = String(createdInterview.id)
  const cancellableVersion = Number(createdInterview.record_version)

  const first = await createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'allowed-once' },
  }).execute({
    intent: 'CANCEL',
    idempotency_key: `two-phase:cancel:${uniqueSuffix()}`,
    interview_id: interviewId,
    expected_record_version: cancellableVersion,
    reason: '候选人放弃',
  }, {}) as Record<string, unknown>
  assert.equal(first.status, 'OK')
  assert.equal((first.interview as Record<string, unknown>).status, 'CANCELLED')
  const cancelledVersion = Number((first.interview as Record<string, unknown>).record_version)

  const before = await tableCounts(SCHEDULE_TABLES)
  let approvalCalls = 0
  const second = await createInterviewScheduleTool(cfg, {
    approval: {
      async request(): Promise<string> {
        approvalCalls += 1
        throw new Error('零写入幂等成功分支不得问人')
      },
    },
  }).execute({
    intent: 'CANCEL',
    idempotency_key: `two-phase:cancel-again:${uniqueSuffix()}`,
    interview_id: interviewId,
    expected_record_version: cancelledVersion,
    reason: '重复取消',
  }, {}) as Record<string, unknown>

  assert.equal(second.status, 'OK')
  assert.equal(second.replayed, false, '不同 key 的重复取消不是 STORE 重放，而是"已 CANCELLED"的幂等成功')
  assert.deepEqual((second.changes as Record<string, unknown>).created, [])
  assert.deepEqual((second.changes as Record<string, unknown>).updated, [])
  assert.equal(approvalCalls, 0, '零写入的幂等成功不问人（approval 调用数 = 0）')
  assert.deepEqual(await tableCounts(SCHEDULE_TABLES), before, '重复取消不得写任何行')
})

test('零写入幂等成功不问人：WITHDRAW 已退出（换 key）→ 成功、零写入、approval 调用数 = 0', async () => {
  const { args: createArgs } = await seedScheduleFixture()
  const created = await createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'allowed-once' },
  }).execute(createArgs, {}) as Record<string, unknown>
  const createdInterview = created.interview as Record<string, unknown>
  const interviewId = String(createdInterview.id)
  const interviewers = createdInterview.interviewers as Record<string, unknown>[]
  const interviewerId = String(interviewers[0]?.interviewer_id)
  const createdVersion = Number(createdInterview.record_version)

  const first = await createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'allowed-once' },
  }).execute({
    intent: 'WITHDRAW_INTERVIEWER',
    idempotency_key: `two-phase:withdraw:${uniqueSuffix()}`,
    interviewer_id: interviewerId,
    expected_record_version: createdVersion,
    reason: '面试官请假',
  }, {}) as Record<string, unknown>
  assert.equal(first.status, 'OK')
  const withdrawnVersion = Number((first.interview as Record<string, unknown>).record_version)

  const before = await tableCounts(SCHEDULE_TABLES)
  let approvalCalls = 0
  const second = await createInterviewScheduleTool(cfg, {
    approval: {
      async request(): Promise<string> {
        approvalCalls += 1
        throw new Error('零写入幂等成功分支不得问人')
      },
    },
  }).execute({
    intent: 'WITHDRAW_INTERVIEWER',
    idempotency_key: `two-phase:withdraw-again:${uniqueSuffix()}`,
    interviewer_id: interviewerId,
    expected_record_version: withdrawnVersion,
    reason: '重复退出',
  }, {}) as Record<string, unknown>

  assert.equal(second.status, 'OK')
  assert.equal(second.replayed, false)
  assert.deepEqual((second.changes as Record<string, unknown>).created, [])
  assert.deepEqual((second.changes as Record<string, unknown>).updated, [])
  assert.equal(approvalCalls, 0, '零写入的幂等成功不问人（approval 调用数 = 0）')
  assert.deepEqual(await tableCounts(SCHEDULE_TABLES), before, '重复退出不得写任何行')
})

// ---------------------------------------------------------------------------
//  4. replay：第二次不二次问人、行数不变
// ---------------------------------------------------------------------------

test('replay：scorecard 同参同 key 第二次 replayed=true 且 approval 调用数 = 0、表行数不变', async () => {
  const { interviewId, args } = await seedScorecardFixture()
  const first = await createScorecardSubmitTool({
    database: cfg,
    approval: { request: async () => 'allowed-once' },
  }).execute(args, {}) as Record<string, unknown>
  assert.equal(first.status, 'OK')
  assert.equal(first.replayed, false)
  const firstScorecard = first.scorecard as Record<string, unknown>
  const afterFirst = await tableCounts(SCORECARD_TABLES)

  let approvalCalls = 0
  const second = await createScorecardSubmitTool({
    database: cfg,
    approval: {
      async request(): Promise<string> {
        approvalCalls += 1
        return 'allowed-once'
      },
    },
  }).execute(args, {}) as Record<string, unknown>

  assert.equal(second.replayed, true, '第二次必须走幂等重放')
  assert.equal((second.scorecard as Record<string, unknown>).id, firstScorecard.id, '重放必须返回同一行')
  assert.equal(approvalCalls, 0, '幂等重放不写库，不得二次问人（approval 调用数 = 0）')
  assert.deepEqual(await tableCounts(SCORECARD_TABLES), afterFirst, '重放不得新增任何行')
  const scorecard = second.scorecard as Record<string, unknown>
  assert.equal(scorecard.interview_id, interviewId)
})

test('replay：schedule(CREATE) 同参同 key 第二次 replayed=true 且 approval 调用数 = 0、表行数不变', async () => {
  const { args } = await seedScheduleFixture()
  const tables = SCHEDULE_TABLES
  const first = await createInterviewScheduleTool(cfg, {
    approval: { request: async () => 'allowed-once' },
  }).execute(args, {}) as Record<string, unknown>
  assert.equal(first.status, 'OK')
  assert.equal(first.replayed, false)
  const afterFirst = await tableCounts(tables)

  let approvalCalls = 0
  const second = await createInterviewScheduleTool(cfg, {
    approval: {
      async request(): Promise<string> {
        approvalCalls += 1
        return 'allowed-once'
      },
    },
  }).execute(args, {}) as Record<string, unknown>

  assert.equal(second.replayed, true, '第二次必须走幂等重放')
  assert.equal(second.intent, 'CREATE')
  assert.equal(approvalCalls, 0, '幂等重放不写库，不得二次问人（approval 调用数 = 0）')
  assert.deepEqual(await tableCounts(tables), afterFirst, '重放不得新增任何行')
  assert.deepEqual((second.changes as Record<string, unknown>).created, [], '重放 changes.created 必须为空')
})
