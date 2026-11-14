// G3 一致性（G3=B 语义）× 真实 PostgreSQL：**一次性空库**（重放迁移 0001→0016）+ 真提交。
//
// 为什么必须独占一次性库（`createIsolatedTestDatabase()`）：
//   * 本文件要把一条申请**真的**从 S6 一路驱动到 S10（跨事务、真提交），共享库 ra_s6s7 不允许；
//   * 0016 的 `recruitment.v_application_stage_consistency` 是"全库违规行"视图，
//     只有干净库里 `count(*) = 0` 才是一句可复现的话（共享库里还有别的 lane 的历史数据）。
//
// 断言三件事（对应 G3 交付）：
//   (a) 正例：干净库 S6 → S7 → S8 → S9 → S10（canonical READY 转写 + ≥1 份 SUBMITTED 面评）
//       读回 `current_stage_code='S10'` 且 SUBMITTED 面评数 ≥1；
//   (b) 0016 视图：正例之后 `select count(*) from recruitment.v_application_stage_consistency` = 0；
//       反例（直接 SQL 把申请指到 S10、没有 SUBMITTED 面评）必须被视图报出来 —— 证明它不是恒 0；
//   (c) 反例的域侧：材料可用的 S9 申请没有面评 → BLOCKED(SCORECARD_REQUIRED) **且逐表 delta=0**。
//
// 口径说明：
//   * 视图以**落地迁移 0016** 为准（`db/migrations/0016_v1_consistency.sql`）；
//     `work/verify-2026-11-15-g3/wiring/0016-consistency-view.sql` 是作废草稿，**本文件不执行它**
//     （列名/列序与落地版不同，`create or replace view` 会 42P16）。
//   * 违规码 = 落地版的两个：`S9_WITHOUT_READY_TRANSCRIPT` / `S10_WITHOUT_SUBMITTED_SCORECARD`。
import test from 'node:test'
import assert from 'node:assert/strict'
import type pg from 'pg'

import { advanceApplicationStage } from '../../src/domain/stage-advance.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  hex64,
  HR_ACTOR,
  one,
  seedScenario,
  TENANT,
  uniqueSuffix,
  type IsolatedTestDatabase,
} from './db.ts'

/** 一份合法的 rubric 维度（payload_hash 由 seedScenario 用 digestOf 算）。 */
const DIMS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/** 本文件独占的一次性库。 */
let db: IsolatedTestDatabase

test.before(async () => {
  db = await createIsolatedTestDatabase('g3_consistency')
  // 守卫：这个库必须**不是**共享的 ra_s6s7（真提交 + 全库计数）。
  assertPrivateDatabase(db.name)
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  夹具（与 test/integration/stage-advance-s8-s10.test.ts 同形；本文件独立自足）
// ---------------------------------------------------------------------------

/**
 * 在**会真提交**的事务里跑 `fn`（一次性库专用；共享库严禁用）。
 *
 * 与 `inRolledBackTx` 的唯一区别是结尾 `commit`：本文件要证明"跨事务可读回"。
 * 事务里先 `SET LOCAL recruitment.actor_id`，否则 `fn_row_guard` 会 ACTOR_REQUIRED 拒绝。
 * @param pool - 指向一次性库的连接池。
 * @param fn - 事务体。
 * @returns `fn` 的返回值（提交之后）。
 */
async function inCommittedTx<T>(pool: pg.Pool, fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const value = await fn(client)
    await client.query('commit')
    return value
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * 把申请的阶段码改成指定值（造夹具用；会触发 `fn_row_guard`，事务里已 `SET LOCAL actor`）。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @param stageCode - 目标阶段码。
 */
async function setStage(client: DatabaseClient, applicationId: string, stageCode: string): Promise<void> {
  await client.query(
    'update recruitment.application set current_stage_code = $2 where tenant_id = $1 and id = $3',
    [TENANT, stageCode, applicationId],
  )
}

/**
 * 插一条 current（未被取代）的 SCREENING 决策 = ADVANCE（T2 的唯一事实源）。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 决策 id。
 */
async function insertScreeningDecision(client: DatabaseClient, applicationId: string): Promise<string> {
  return await one(client, `insert into recruitment.decision
      (tenant_id, application_id, decision_scope, stage_code, result,
       decided_by_actor_id, reason, basis_refs)
    values ($1, $2, 'SCREENING', 'S7', 'ADVANCE', $3, $4, '[]'::jsonb) returning id`, [
    TENANT, applicationId, HR_ACTOR,
    '集成测试：人做出的 SCREENING 决策 result=ADVANCE（夹具，不含 PII）',
  ])
}

/** 造好的一条"面试 + 会议 + 绑定"链路。 */
interface InterviewChain {
  readonly interviewId: string
  readonly meetingId: string
}

/**
 * 造一条面试 + 一场会议 + 一条有效绑定（转写产物必须经它才可达这条申请）。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @param status - `interview.status`（**只作排期状态**，不参与 T3 判定）。
 * @returns 链路 id。
 */
async function insertInterviewChain(
  client: DatabaseClient,
  applicationId: string,
  status: string,
): Promise<InterviewChain> {
  const suffix = uniqueSuffix()
  const interviewId = await one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at)
      values ($1, $2, 1, 'DEFAULT', $3, now() - interval '2 hours', now() - interval '1 hour') returning id`, [
    TENANT, applicationId, status,
  ])
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, external_meeting_id, meeting_role)
      values ($1, 'SYNTHETIC_DEMO', $2, 'PRIMARY') returning id`, [
    TENANT, `synthetic-meeting-${suffix}`,
  ])
  await one(client, `insert into recruitment.meeting_binding
      (tenant_id, meeting_id, interview_id, binding_method)
      values ($1, $2, $3, 'SCHEDULED') returning id`, [TENANT, meetingId, interviewId])
  return { interviewId, meetingId }
}

/**
 * 往一场会议里插一条 **canonical READY** 转写（T3 的唯一 PASS 事实）。
 * @param client - 事务内连接。
 * @param meetingId - 会议 id。
 * @returns 产物 id。
 */
async function insertReadyCanonicalTranscript(client: DatabaseClient, meetingId: string): Promise<string> {
  return await one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type,
       transcript_status, provenance, trigger_mode, connection_state,
       content_sha256, raw_text, is_complete, is_canonical, canonical_selected_by_actor_id)
      values ($1, $2, 'SYNTHETIC_DEMO', $3, 1, 'ORIGINAL',
              'READY', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
              $4, $5, true, true, $6) returning id`, [
    TENANT, meetingId, `artifact-${uniqueSuffix()}`,
    'a'.repeat(64), '集成测试：合成转写原文（不含 PII）', HR_ACTOR,
  ])
}

/**
 * 插一条 `SUBMITTED` 面评（T4 的后半闸门；与迁移约束同源，不绕过 `job_id`/actor 校验）。
 * @param client - 事务内连接。
 * @param scenario - `seedScenario` 的 id 集合。
 * @param interviewId - 面评归属的面试。
 * @returns 面评 id。
 */
async function insertSubmittedScorecard(
  client: DatabaseClient,
  scenario: { readonly jobId: string; readonly rubricId: string },
  interviewId: string,
): Promise<string> {
  const interviewerId = await one(client, `insert into recruitment.interviewer
      (tenant_id, interview_id, actor_id, role_in_interview)
      values ($1, $2, $3, 'INTERVIEWER') returning id`, [TENANT, interviewId, HR_ACTOR])
  return await one(client, `insert into recruitment.scorecard
      (tenant_id, job_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
       submitted_at, items, overall, rationale, payload_hash,
       status_changed_at, status_changed_by_actor_id)
      values ($1, $2, $3, $4, $5, 1, 'SUBMITTED',
              now(), '{"transcript_basis":"TRANSCRIPT"}'::jsonb, 'ADVANCE',
              '集成测试：合成面评（不含 PII）', $6, now(), $7) returning id`, [
    TENANT, scenario.jobId, interviewId, interviewerId, scenario.rubricId,
    hex64(`scorecard-${uniqueSuffix()}`), HR_ACTOR,
  ])
}

/** 域函数的一次真提交调用（一次性库专用）。 */
async function advanceCommitted(pool: pg.Pool, applicationId: string): Promise<Awaited<ReturnType<typeof advanceApplicationStage>>> {
  return await inCommittedTx(pool, (client) => advanceApplicationStage(client, { tenantId: TENANT, applicationId }))
}

/** "零写入"的逐表证据：这些表的行数在 BLOCKED 调用前后必须一个都不变。 */
const ZERO_WRITE_TABLES = [
  'application', 'event_inbox', 'scorecard', 'interview', 'transcript_artifact', 'decision', 'business_task',
] as const

/**
 * 读一组表的行数（一次性库里没有别的写者，跨事务比较是可靠的）。
 * @param pool - 指向一次性库的连接池。
 * @returns 表名 → 行数。
 */
async function tableRowCounts(pool: pg.Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of ZERO_WRITE_TABLES) {
    const { rows } = await pool.query<{ n: string }>(`select count(*)::text as n from recruitment.${table}`)
    counts[table] = Number(rows[0]?.n ?? 0)
  }
  return counts
}

/** 读一致性视图里某条申请的违规码（`0016` 的落地视图）。 */
async function violationCodesFor(pool: pg.Pool, applicationId: string): Promise<string[]> {
  const { rows } = await pool.query<{ violation_code: string }>(
    `select violation_code
       from recruitment.v_application_stage_consistency
      where application_id = $1
      order by violation_code`,
    [applicationId],
  )
  return rows.map((row) => row.violation_code)
}

// ---------------------------------------------------------------------------
//  前置：迁移链里确实有 0016，视图存在且列形状 = 落地契约
// ---------------------------------------------------------------------------

test('前置：一次性库重放迁移含 0016，`v_application_stage_consistency` 存在且列形状 = 落地契约', async () => {
  // 不断言"0016 是最后一个迁移"（后续再加 0017 时不该让本用例红）：只要求它在链上。
  assert.ok(db.migrations.includes('0016_v1_consistency.sql'), `迁移链必须包含 0016，实际：${db.migrations.join(', ')}`)
  assert.ok(db.migrations.length >= 16, `迁移数 = ${db.migrations.length}`)
  const { rows } = await db.pool.query<{ name: string | null }>(
    "select to_regclass('recruitment.v_application_stage_consistency')::text as name",
  )
  assert.equal(rows[0]?.name, 'recruitment.v_application_stage_consistency', '0016 必须建出视图')
  // 列名/列序 = 落地版契约（草稿版不同，已作废；这里钉住落地形状）。
  const columns = await db.pool.query<{ column_name: string }>(
    `select column_name
       from information_schema.columns
      where table_schema = 'recruitment' and table_name = 'v_application_stage_consistency'
      order by ordinal_position`,
  )
  assert.deepEqual(
    columns.rows.map((row) => row.column_name),
    ['application_id', 'tenant_id', 'current_stage_code', 'violation_code', 'detail'],
  )
  // 干净库（只有 0002 seed 的 S7 演示申请）上视图必须 0 违规。
  const clean = await db.pool.query<{ n: number }>('select count(*)::int as n from recruitment.v_application_stage_consistency')
  assert.equal(clean.rows[0]?.n, 0, '干净库基线：0 违规')
})

// ---------------------------------------------------------------------------
//  (a)+(b) 正例：S6 驱动到 S10 → 读回 S10 + SUBMITTED ≥1 → 视图 0 违规
// ---------------------------------------------------------------------------

test('G3 正例：干净库从 S6 驱动到 S10（canonical READY + SUBMITTED）→ 读回 S10、SUBMITTED≥1、0016 视图 0 违规', async () => {
  const pool = db.pool
  // 1) 夹具（真提交）：申请从 S6 起步；T1/T2 事实齐全；面试 + canonical READY + SUBMITTED 面评齐全。
  const scenario = await inCommittedTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMS })
    await setStage(client, seeded.applicationId, 'S6')
    await insertScreeningDecision(client, seeded.applicationId)
    const chain = await insertInterviewChain(client, seeded.applicationId, 'POST_INTERVIEW')
    await insertReadyCanonicalTranscript(client, chain.meetingId)
    await insertSubmittedScorecard(client, seeded, chain.interviewId)
    return seeded
  })

  // 2) 同一次调用走四条边（S6→S7→S8→S9→S10），真提交。
  const result = await advanceCommitted(pool, scenario.applicationId)
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S10')
  assert.deepEqual(result.transitions, [
    { from: 'S6', to: 'S7' },
    { from: 'S7', to: 'S8' },
    { from: 'S8', to: 'S9' },
    { from: 'S9', to: 'S10' },
  ])
  assert.deepEqual(result.blockers, [])

  // 3) (a) 独立读回（不 import 域函数的结果对象，直接查库）。
  const readback = await pool.query<{ current_stage_code: string; submitted: number }>(
    `select a.current_stage_code,
            (select count(*)::int
               from recruitment.scorecard s
               join recruitment.interview i
                 on i.id = s.interview_id and i.tenant_id = s.tenant_id
              where s.tenant_id = a.tenant_id and i.application_id = a.id
                and s.status = 'SUBMITTED') as submitted
       from recruitment.application a
      where a.tenant_id = $1 and a.id = $2`,
    [TENANT, scenario.applicationId],
  )
  assert.equal(readback.rows[0]?.current_stage_code, 'S10', '读回：current_stage_code = S10')
  assert.ok(Number(readback.rows[0]?.submitted ?? 0) >= 1, '读回：至少 1 份 SUBMITTED 面评')

  // 4) (b) 0016 视图：正例之后全库 0 违规。
  const violations = await pool.query<{ n: number }>('select count(*)::int as n from recruitment.v_application_stage_consistency')
  assert.equal(violations.rows[0]?.n, 0, '正例全链读回 S10 后，一致性视图必须 0 违规')
})

// ---------------------------------------------------------------------------
//  (c) 反例：S9 材料可用但没有面评 → 域函数拒绝且零写入；直接指到 S10 → 视图必须报违规
// ---------------------------------------------------------------------------

test('G3 反例：材料可用但无 SUBMITTED 面评 → BLOCKED(SCORECARD_REQUIRED) 且逐表 delta=0；直接指到 S10 则视图报 S10_WITHOUT_SUBMITTED_SCORECARD（非恒 0）', async () => {
  const pool = db.pool
  // 第二个申请：材料可用（canonical READY），没有面评，停在 S9。
  const scenario = await inCommittedTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMS })
    const chain = await insertInterviewChain(client, seeded.applicationId, 'POST_INTERVIEW')
    await insertReadyCanonicalTranscript(client, chain.meetingId)
    await setStage(client, seeded.applicationId, 'S9')
    return seeded
  })

  // ---- (c1) 域侧反证：S9→S10 被 SCORECARD_REQUIRED 挡住，逐表 delta=0 ----
  const countsBefore = await tableRowCounts(pool)
  const result = await advanceCommitted(pool, scenario.applicationId)
  const countsAfter = await tableRowCounts(pool)
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((blocker) => blocker.code), ['SCORECARD_REQUIRED'])
  const blocker = result.blockers[0] as NonNullable<(typeof result.blockers)[0]>
  assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER')
  assert.equal(blocker.next_action_code, 'SUBMIT_SCORECARD')
  assert.match(blocker.message, /recruitment_scorecard_submit/)
  assert.deepEqual(
    countsAfter,
    countsBefore,
    `BLOCKED 必须零写入，实际 delta=${JSON.stringify(Object.fromEntries(
      ZERO_WRITE_TABLES.map((table) => [table, (countsAfter[table] ?? 0) - (countsBefore[table] ?? 0)]),
    ))}`,
  )
  const stillS9 = await pool.query<{ current_stage_code: string; record_version: number }>(
    'select current_stage_code, record_version from recruitment.application where tenant_id = $1 and id = $2',
    [TENANT, scenario.applicationId],
  )
  assert.equal(stillS9.rows[0]?.current_stage_code, 'S9', 'BLOCKED 后阶段留在 S9')
  // 此刻视图仍是 0 违规（S9 有 canonical READY；还没有 S10 指针）。
  const beforeCounter = await pool.query<{ n: number }>('select count(*)::int as n from recruitment.v_application_stage_consistency')
  assert.equal(beforeCounter.rows[0]?.n, 0)

  // ---- (c2) 视图反证：直接 SQL 把申请指到 S10（模拟历史/越界指针；绕过域函数）----
  const versionBefore = await pool.query<{ record_version: number }>(
    'select record_version from recruitment.application where tenant_id = $1 and id = $2',
    [TENANT, scenario.applicationId],
  )
  await inCommittedTx(pool, (client) => setStage(client, scenario.applicationId, 'S10'))
  const versionAfter = await pool.query<{ record_version: number }>(
    'select record_version from recruitment.application where tenant_id = $1 and id = $2',
    [TENANT, scenario.applicationId],
  )
  assert.equal(
    versionAfter.rows[0]?.record_version,
    Number(versionBefore.rows[0]?.record_version) + 1,
    '直接改阶段会经 fn_row_guard 自增版本（夹具动作，不是域函数写入）',
  )
  const codes = await violationCodesFor(pool, scenario.applicationId)
  assert.deepEqual(codes, ['S10_WITHOUT_SUBMITTED_SCORECARD'], `视图必须报出该申请的违规，实际=${JSON.stringify(codes)}`)
  const globalCount = await pool.query<{ n: number }>('select count(*)::int as n from recruitment.v_application_stage_consistency')
  assert.equal(globalCount.rows[0]?.n, 1, '全库恰好 1 条违规（只有反例申请）—— 视图不是恒 0')
})
