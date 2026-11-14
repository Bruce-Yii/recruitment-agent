// 阶段推进（N8 / 方案 D）× 真实 PostgreSQL（ra_s6s7）的集成测试。
//
// 每条验收都**读库回验**，不信函数返回值自述：
//   A1 T1 正例：材料 + rubric 齐 → S7；`transitions=[{S6,S7}]`；`stage_entered_at` 前进；
//                恰好 1 条 `application.current_stage_code.changed` 事件（provider=internal）。
//   A2 T1 缺 rubric → BLOCKED['RUBRIC_NOT_PINNED']；阶段不变、**零 UPDATE**（record_version 不动 + 无事件）。
//   A3 T2 正例：current SCREENING=ADVANCE → S8。
//   A4 T2 负例：REJECT / HOLD → BLOCKED，阶段留在 S7、零 UPDATE。
//   A5 幂等：连调两次，第二次 NO_OP 且 record_version 不变、不产生第二条事件。
//   A6 并发：两连接同时调 → 恰好 1 条阶段事件，另一侧 VERSION_CONFLICT。
//   A7 落后补推进：T1/T2 同时成立 → 一次调用走两跳（S6→S8），一条边一条事件。
//   A8 不倒退：指针已超前（S9）→ NO_OP + STAGE_AHEAD，零 UPDATE。
//
// 事务纪律（沿用 test/integration/db.ts）：
//   * 绝大多数用例在 `inRolledBackTx` 里跑，结束一律 ROLLBACK —— 不污染 ra_s6s7；
//   * **并发用例必须提交**（第二个连接看不见未提交行），所以它用一份**自己造的、可精确列举的**
//     夹具，并在 after 钩子里删干净（见 §"已提交夹具"）。删除用 `SET LOCAL
//     session_replication_role = replica` 临时绕过 0001 的 `trg_*_no_delete`：
//     那组触发器保护的是**生产历史事实**，测试自己造的夹具不是历史；且 `SET LOCAL`
//     只在本事务内生效，随 COMMIT/ROLLBACK 自动恢复（不是全局 disable，崩溃也不会留下关闭状态）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { advanceApplicationStage, readStageBlockedView } from '../../src/domain/stage-advance.ts'
import { createStageAdvanceTool } from '../../src/tools/stage-advance.ts'
import { withReadOnly, type DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  HR_ACTOR,
  inRolledBackTx,
  seedScenario,
  TENANT,
  testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 演示租户研发部的招聘负责人（0002 seed：department.hiring_manager_actor_id，责任人推导的兜底）。 */
const DEMO_RECRUITMENT_OWNER = '11111111-1111-4111-8111-000000000102'
/** 演示租户研发部的招聘负责人显示名。 */
const DEMO_RECRUITMENT_OWNER_NAME = '演示-招聘负责人'

/** 一份合法的 rubric 维度（payload_hash 由 seedScenario 用 digestOf 算）。 */
const DIMS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/** 读一条申请的完整快照（断言只看库里的值）。 */
interface AppSnapshot {
  current_stage_code: string
  record_version: number
  stage_entered_at: Date
  created_at: Date
  stage_source_event_id: string | null
  stage_changed_at: Date
  resume_version_id: string | null
  rubric_version_id: string | null
  lifecycle_status: string
}

/**
 * 读申请快照。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 快照（不存在则抛）。
 */
async function readApp(client: DatabaseClient, applicationId: string): Promise<AppSnapshot> {
  const { rows } = await client.query<AppSnapshot>(
    `select current_stage_code, record_version, stage_entered_at, created_at,
            stage_source_event_id, stage_changed_at, resume_version_id, rubric_version_id,
            lifecycle_status
       from recruitment.application
      where tenant_id = $1 and id = $2`,
    [TENANT, applicationId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`application ${applicationId} 不存在`)
  return row
}

/** 一条阶段变更事件（库里真实的那条）。 */
interface StageEventRow {
  event_id: string
  provider: string
  trust_level: string
  payload: { from: string; to: string; actor_id: string; record_id: string }
}

/**
 * 读这条申请的全部阶段变更事件。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 事件（按 `from/to` 过滤由调用方做；同一事务里 received_at 相同，不依赖排序）。
 */
async function stageChangeEvents(client: DatabaseClient, applicationId: string): Promise<StageEventRow[]> {
  const { rows } = await client.query<StageEventRow>(
    `select event_id, provider, trust_level, payload
       from recruitment.event_inbox
      where tenant_id = $1
        and event_type = 'application.current_stage_code.changed'
        and source_object_id = $2`,
    [TENANT, applicationId],
  )
  return rows
}

/**
 * 把申请的阶段码改成指定值（造夹具用；会触发 fn_row_guard，要求事务里已 SET LOCAL actor）。
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
 * 造一份"申请停在 S6"的夹具（seedScenario 默认 S7，这里拖回 S6 —— intake 新建的申请就是 S6）。
 * @param client - 事务内连接。
 * @param input - 透传给 seedScenario 的开关。
 * @returns 夹具 id 集合。
 */
async function seedAtS6(
  client: DatabaseClient,
  input: { pinRubric?: boolean; bindMaterial?: boolean; parseStatus?: string; approve?: boolean },
): Promise<Awaited<ReturnType<typeof seedScenario>>> {
  const scenario = await seedScenario(client, { dimensions: DIMS, ...input })
  await setStage(client, scenario.applicationId, 'S6')
  return scenario
}

/**
 * 插一条 SCREENING 决策（当前，未被取代）。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @param result - `ADVANCE` / `HOLD` / `REJECT` / `WITHDRAW`。
 * @returns 决策 id。
 */
async function insertScreeningDecision(
  client: DatabaseClient,
  applicationId: string,
  result: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.decision
       (tenant_id, application_id, decision_scope, stage_code, result,
        decided_by_actor_id, reason, basis_refs)
     values ($1, $2, 'SCREENING', 'S7', $3, $4, $5, '[]'::jsonb)
     returning id`,
    [TENANT, applicationId, result, HR_ACTOR, `集成测试：人做出的 SCREENING 决策 result=${result}（夹具）`],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('decision insert 没有返回行')
  return row.id
}

// =====================================================================
//  A1 · T1 正例（S6 → S7）
// =====================================================================

test('A1 T1 正例：材料 + rubric 齐 → S7、transitions=[{S6,S7}]、stage_entered_at 前进、恰好 1 条阶段事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS6(client, {})
    const before = await readApp(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S7')
    assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])
    assert.deepEqual(result.blockers, [])
    assert.deepEqual(result.warnings, [])

    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S7')
    assert.equal(after.record_version, before.record_version + 1, '一条 UPDATE ⇒ record_version 恰好 +1')
    assert.equal(result.record_version, after.record_version, '出参版本 = 库里版本')
    assert.ok(
      after.stage_entered_at.getTime() > before.stage_entered_at.getTime(),
      `stage_entered_at 必须前进（before=${before.stage_entered_at.toISOString()} after=${after.stage_entered_at.toISOString()}）`,
    )
    assert.ok(
      after.stage_entered_at.getTime() > after.created_at.getTime(),
      'stage_entered_at > created_at（本仓既有缺陷：0001 只有 DEFAULT，fn_row_guard 不维护它）',
    )

    const events = await stageChangeEvents(client, scenario.applicationId)
    const applied = events.filter((e) => e.payload.from === 'S6' && e.payload.to === 'S7')
    assert.equal(applied.length, 1, '一次推进 = 恰好 1 条阶段事件')
    const event = applied[0] as StageEventRow
    assert.equal(event.provider, 'internal')
    assert.equal(event.trust_level, 'INTERNAL')
    assert.equal(event.payload.actor_id, HR_ACTOR, '事件里的 actor 是执行账号（SET LOCAL 的那个）')
    assert.equal(after.stage_source_event_id, event.event_id, 'stage_source_event_id 由触发器回填')
    assert.ok(
      after.stage_changed_at.getTime() >= after.stage_entered_at.getTime() - 1000,
      'stage_changed_at 也由触发器写入（不早于本次推进）',
    )
  })
})

// =====================================================================
//  A2 · T1 缺 rubric → BLOCKED、阶段不变、零 UPDATE
// =====================================================================

test('A2 T1 缺 rubric → BLOCKED[RUBRIC_NOT_PINNED]，阶段不变、零 UPDATE（版本与事件都不动）；责任人/下一步结构化', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 真正被挡住的是"岗位还没有已批准的当前 rubric"：D-21/D-48 下指针为空就是没有当前版本，
    // 补钉也没有可钉的目标（申请没钉 + 岗位无可钉 → 仍 BLOCKED、零写入）。
    const scenario = await seedAtS6(client, { pinRubric: false, approve: false })
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'BLOCKED')
    assert.deepEqual(result.blockers.map((b) => b.code), ['RUBRIC_NOT_PINNED'])
    const blocker = result.blockers[0] as NonNullable<(typeof result.blockers)[0]>
    assert.match(blocker.message, /rubric/)

    // §11.6-8：责任人 + 下一步必须是**结构化**字段（工作台可机检；不是自由文本）。
    assert.equal(Object.hasOwn(blocker, 'owner_actor_id'), true, '责任人字段必须存在（门槛原文）')
    assert.equal(blocker.owner_actor_id, DEMO_RECRUITMENT_OWNER, '责任人从库里推出来（job→department.hiring_manager_actor_id）')
    assert.equal(blocker.owner_display_name, DEMO_RECRUITMENT_OWNER_NAME)
    assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER')
    assert.equal(blocker.next_action_code, 'PIN_RUBRIC_VERSION')

    assert.deepEqual(result.transitions, [])
    assert.equal(result.stage_code, 'S6')
    assert.equal(result.record_version, before.record_version)

    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S6', '阶段不变')
    assert.equal(after.record_version, before.record_version, '零 UPDATE ⇒ record_version 不变')
    assert.equal(after.stage_source_event_id, before.stage_source_event_id, '审计列也不动')
    const eventsAfter = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(eventsAfter.length, eventsBefore.length, '不产生任何事件')
  })
})

test('A2b T1 材料 parse_status=FAILED → BLOCKED[MATERIAL_PARSE_FAILED]，零 UPDATE', async () => {
  await inRolledBackTx(pool, async (client) => {
    // seedScenario 的 FAILED 必须有 parse_error（ck_resume_version_error）
    const scenario = await seedAtS6(client, { parseStatus: 'FAILED' })
    const before = await readApp(client, scenario.applicationId)
    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(result.status, 'BLOCKED')
    assert.deepEqual(result.blockers.map((b) => b.code), ['MATERIAL_PARSE_FAILED'])
    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S6')
    assert.equal(after.record_version, before.record_version)
  })
})

// =====================================================================
//  A3 / A4 · T2 正例 / 负例
// =====================================================================

test('A3 T2 正例：current SCREENING=ADVANCE → S8，恰好 1 条 S7→S8 事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS }) // 默认就在 S7
    await insertScreeningDecision(client, scenario.applicationId, 'ADVANCE')
    const before = await readApp(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S8')
    assert.deepEqual(result.transitions, [{ from: 'S7', to: 'S8' }])

    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S8')
    assert.equal(after.record_version, before.record_version + 1)
    assert.ok(after.stage_entered_at.getTime() > after.created_at.getTime())
    const events = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(events.filter((e) => e.payload.from === 'S7' && e.payload.to === 'S8').length, 1)
  })
})

for (const result of ['HOLD', 'REJECT']) {
  test(`A4 T2 负例：current SCREENING=${result} → BLOCKED，阶段留在 S7、零 UPDATE；责任人=决策人（库里可查）`, async () => {
    await inRolledBackTx(pool, async (client) => {
      const scenario = await seedScenario(client, { dimensions: DIMS })
      await insertScreeningDecision(client, scenario.applicationId, result)
      const before = await readApp(client, scenario.applicationId)

      const outcome = await advanceApplicationStage(client, {
        tenantId: TENANT,
        applicationId: scenario.applicationId,
      })

      assert.equal(outcome.status, 'BLOCKED')
      assert.deepEqual(outcome.blockers.map((b) => b.code), ['SCREENING_DECISION_NOT_ADVANCE'])
      const blocker = outcome.blockers[0] as NonNullable<(typeof outcome.blockers)[0]>
      assert.match(blocker.message, new RegExp(result))
      // §11.6-8：HOLD/REJECT 的责任人 = 真的做过这个决定的人（decision.decided_by_actor_id），
      // 不是执行账号、也不是自由文本。
      assert.equal(blocker.owner_role, 'SCREENING_DECIDER')
      assert.equal(blocker.owner_actor_id, HR_ACTOR, '夹具里的 SCREENING 决策是 HR_ACTOR 做的')
      assert.equal(blocker.owner_display_name, '演示-HR 专员')
      assert.equal(blocker.next_action_code, 'SUPERSEDE_SCREENING_DECISION')
      assert.deepEqual(outcome.transitions, [])
      const after = await readApp(client, scenario.applicationId)
      assert.equal(after.current_stage_code, 'S7', '阶段留在 S7')
      assert.equal(after.record_version, before.record_version, '零 UPDATE')
      const events = await stageChangeEvents(client, scenario.applicationId)
      assert.equal(events.length, 0, '不产生任何阶段事件')
    })
  })
}

// =====================================================================
//  A5 · 幂等（连调两次）
// =====================================================================

test('A5 幂等：连调两次，第二次 NO_OP、record_version 不变、不产生第二条事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS6(client, {})
    const first = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(first.status, 'ADVANCED')
    const afterFirst = await readApp(client, scenario.applicationId)

    const second = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(second.status, 'NO_OP', 'T1 已消费、没有 SCREENING 决策 ⇒ NO_OP（不是 BLOCKED）')
    assert.deepEqual(second.transitions, [])
    assert.deepEqual(second.blockers, [])
    assert.equal(second.stage_code, 'S7')
    assert.equal(second.record_version, afterFirst.record_version, '第二次不许再发 UPDATE')

    const afterSecond = await readApp(client, scenario.applicationId)
    assert.equal(afterSecond.record_version, afterFirst.record_version)
    assert.equal(afterSecond.stage_entered_at.getTime(), afterFirst.stage_entered_at.getTime(), '时间戳也不许被"幂等重试"改写')
    const events = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(events.filter((e) => e.payload.from === 'S6' && e.payload.to === 'S7').length, 1, '只有第一条事件')
  })
})

// =====================================================================
//  A7 · 落后补推进（多跳）
// =====================================================================

test('A7 落后补推进：T1/T2 同时成立 → 一次调用走两跳 S6→S7→S8，一条边一条事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS6(client, {})
    await insertScreeningDecision(client, scenario.applicationId, 'ADVANCE')
    const before = await readApp(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S8')
    assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }, { from: 'S7', to: 'S8' }])
    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S8')
    assert.equal(after.record_version, before.record_version + 2, '两跳 ⇒ 版本 +2')
    assert.ok(after.stage_entered_at.getTime() > after.created_at.getTime())
    const events = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(events.filter((e) => e.payload.from === 'S6' && e.payload.to === 'S7').length, 1)
    assert.equal(events.filter((e) => e.payload.from === 'S7' && e.payload.to === 'S8').length, 1)
  })
})

// =====================================================================
//  A8 · 不倒退（STAGE_AHEAD）
// =====================================================================

test('A8 指针已超前（S9）→ NO_OP + STAGE_AHEAD，一条 UPDATE 都不发', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS })
    await setStage(client, scenario.applicationId, 'S9')
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'NO_OP')
    assert.deepEqual(result.warnings.map((w) => w.code), ['STAGE_AHEAD'])
    const warning = result.warnings[0] as NonNullable<(typeof result.warnings)[0]>
    // §11.6-8：STAGE_AHEAD 也要机检得动（责任人 + 下一步），不是只给一句话。
    assert.equal(warning.owner_role, 'RECRUITMENT_OWNER')
    assert.equal(warning.next_action_code, 'VERIFY_STAGE_PROGRESSION')
    assert.equal(warning.owner_actor_id, DEMO_RECRUITMENT_OWNER, '招聘负责人从库里推出来')
    assert.equal(warning.owner_display_name, DEMO_RECRUITMENT_OWNER_NAME)
    assert.equal(result.stage_code, 'S9', '不倒退')
    assert.equal(result.record_version, before.record_version)
    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S9')
    assert.equal(after.record_version, before.record_version, '零 UPDATE')
    assert.equal((await stageChangeEvents(client, scenario.applicationId)).length, eventsBefore.length)
  })
})

// =====================================================================
//  A9 · §11.6-8 工作台阻塞视图（只读；真库）
//
//  三条硬证据：
//    ① 同一事务里的夹具（能看到未提交行）→ 四要素断言；
//    ② 视图发出的**每一条 SQL 都是读**（记录语句文本；不许 write、不许 `for update`）；
//    ③ 在**库层强制的只读事务**（`begin transaction read only`，任何写会 25006）里对
//       已提交夹具跑一次视图 → 证明确实可安全接进工作台的只读路由。
// =====================================================================

/** 记录 SQL 文本的客户端代理（只用于断言"视图只读"）。 */
function recordingClient(client: DatabaseClient): { proxy: DatabaseClient; statements: string[] } {
  const statements: string[] = []
  const proxy = {
    async query(text: string, params?: readonly unknown[]): Promise<unknown> {
      statements.push(text)
      return await client.query(text, params as never)
    },
  } as unknown as DatabaseClient
  return { proxy, statements }
}

/** 断言一批 SQL 全是只读语句（无写动词、无行锁）。 */
function assertOnlyReadStatements(statements: readonly string[]): void {
  assert.ok(statements.length >= 3, `视图应该查了库（实际 ${statements.length} 条语句）`)
  for (const text of statements) {
    assert.ok(
      !/^\s*(update|insert|delete|truncate|alter|create|drop)\b/i.test(text),
      `只读视图发出了写语句：${text.slice(0, 80)}`,
    )
    assert.ok(!/\bfor update\b/i.test(text), '只读视图不许加行锁（只读事务会 25006）')
  }
}

test('A9 §11.6-8 只读阻塞视图（真库）：RUBRIC_NOT_PINNED → 四要素齐（状态/原因/责任人/下一步），且只发读语句', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 只读视图不补钉：这里用"岗位没有已批准的当前版本"造真实的阻塞（approve:false）。
    const scenario = await seedAtS6(client, { pinRubric: false, approve: false })
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)
    const recorder = recordingClient(client)

    const view = await readStageBlockedView(recorder.proxy, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(view.application_id, scenario.applicationId)
    assert.equal(view.stage, 'S6')
    assert.equal(view.stage_name.length > 0, true, '阶段名要有（HR 直接读）')
    assert.equal(view.status, 'BLOCKED')
    assert.equal(view.blocked, true)
    assert.equal(view.blockers.length, 1)
    const obstruction = view.blockers[0] as NonNullable<(typeof view.blockers)[0]>
    assert.equal(obstruction.kind, 'BLOCKER')
    assert.equal(obstruction.code, 'RUBRIC_NOT_PINNED')
    assert.equal(obstruction.owner_role, 'JOB_HIRING_MANAGER')
    assert.equal(obstruction.owner_actor_id, DEMO_RECRUITMENT_OWNER)
    assert.equal(obstruction.next_action_code, 'PIN_RUBRIC_VERSION')
    assert.equal(view.owner.role, 'JOB_HIRING_MANAGER')
    assert.equal(view.owner.actor_id, DEMO_RECRUITMENT_OWNER)
    assert.equal(view.next_action.code, 'PIN_RUBRIC_VERSION')
    assert.match(view.next_action.message, /rubric/i)

    // 视图零写：只发读语句 + 库里版本/审计/事件全不变。
    assertOnlyReadStatements(recorder.statements)
    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.record_version, before.record_version)
    assert.equal(after.stage_entered_at.getTime(), before.stage_entered_at.getTime())
    assert.equal((await stageChangeEvents(client, scenario.applicationId)).length, eventsBefore.length)
  })
})

test('A9 §11.6-8 只读阻塞视图（真库）：STAGE_AHEAD → kind=WARNING、blocked=false，但仍有 owner + next_action', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS })
    await setStage(client, scenario.applicationId, 'S10')
    const before = await readApp(client, scenario.applicationId)
    const recorder = recordingClient(client)

    const view = await readStageBlockedView(recorder.proxy, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(view.stage, 'S10')
    assert.equal(view.status, 'NO_OP')
    assert.equal(view.blocked, false, 'STAGE_AHEAD 是告警，不是阻塞')
    const obstruction = view.blockers[0] as NonNullable<(typeof view.blockers)[0]>
    assert.equal(obstruction.kind, 'WARNING')
    assert.equal(obstruction.code, 'STAGE_AHEAD')
    assert.equal(obstruction.owner_role, 'RECRUITMENT_OWNER')
    assert.equal(obstruction.owner_actor_id, DEMO_RECRUITMENT_OWNER)
    assert.equal(obstruction.next_action_code, 'VERIFY_STAGE_PROGRESSION')
    assert.equal(view.owner.actor_id, DEMO_RECRUITMENT_OWNER)
    assert.equal(view.next_action.code, 'VERIFY_STAGE_PROGRESSION')
    assertOnlyReadStatements(recorder.statements)
    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.record_version, before.record_version, '视图零写')
  })
})

test('A9 §11.6-8 阻塞视图可在**库层强制的只读事务**里跑（已提交夹具；写语句会被 PG 25006 拒绝）', async () => {
  const fixture = committed
  assert.ok(fixture !== undefined, '提交夹具没造出来')
  // 夹具推到 S7（还没人做 SCREENING 决策）→ 视图应给"下一步：去做初筛决策"，责任人可从库里推出。
  await setCommittedStage(fixture.applicationId, 'S7')
  try {
    const view = await withReadOnly(pool, async (readOnlyClient) =>
      readStageBlockedView(readOnlyClient as unknown as DatabaseClient, {
        tenantId: TENANT,
        applicationId: fixture.applicationId,
      }))
    assert.equal(view.stage, 'S7')
    assert.equal(view.status, 'NO_OP')
    assert.equal(view.blocked, false)
    assert.deepEqual(view.blockers, [])
    assert.equal(view.next_action.code, 'RECORD_SCREENING_DECISION')
    assert.equal(view.owner.role, 'RECRUITMENT_OWNER')
    assert.equal(view.owner.actor_id, DEMO_RECRUITMENT_OWNER)
  } finally {
    // 后面的工具层 / 并发用例要从 S6 开始（T1 成立）
    await setCommittedStage(fixture.applicationId, 'S6')
  }
})

// =====================================================================
//  NOT_FOUND
// =====================================================================

test('不存在的申请 → NOT_FOUND（不静默返回 NO_OP）', async () => {
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      () => advanceApplicationStage(client, {
        tenantId: TENANT,
        applicationId: '00000000-0000-4000-8000-00000000dead',
      }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'NOT_FOUND')
        return true
      },
    )
  })
})

// =====================================================================
//  已提交夹具：工具层 execute（R2 短证据）+ 两连接并发（A6）
//
//  为什么必须提交：第二个连接**看不见**未提交的行。所以这份夹具是"真提交"的，
//  after 钩子里用 `SET LOCAL session_replication_role = replica` 在自己的事务里删干净
//  （见文件头的说明）。
// =====================================================================

interface CommittedFixture {
  readonly applicationId: string
  readonly candidateId: string
  readonly jobId: string
  readonly jobVersionId: string
  readonly rubricId: string
  readonly resumeVersionId: string
  readonly resumeId: string
  readonly assetId: string
  readonly intakeRecordId: string
  readonly seedEventId: string
}

let committed: CommittedFixture | undefined

/** 造一份**已提交**的夹具：S6 + 材料（PARSED）+ rubric 已钉（T1 成立），没有 SCREENING 决策。 */
async function createCommittedFixture(): Promise<CommittedFixture> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false })
    await client.query(
      `update recruitment.application set current_stage_code = 'S6' where tenant_id = $1 and id = $2`,
      [TENANT, scenario.applicationId],
    )
    const { rows } = await client.query<{
      resume_id: string
      intake_asset_id: string
      intake_record_id: string
      event_id: string
    }>(
      `select rv.resume_id, r.intake_asset_id, ia.intake_record_id, ir.event_id
         from recruitment.application a
         join recruitment.resume_version rv on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
         join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = a.tenant_id
         join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = a.tenant_id
         join recruitment.intake_record ir on ir.id = ia.intake_record_id and ir.tenant_id = a.tenant_id
        where a.tenant_id = $1 and a.id = $2`,
      [TENANT, scenario.applicationId],
    )
    const chain = rows[0]
    if (chain === undefined) throw new Error('夹具链路读不出来')
    await client.query('commit')
    return {
      applicationId: scenario.applicationId,
      candidateId: scenario.candidateId,
      jobId: scenario.jobId,
      jobVersionId: scenario.jobVersionId,
      rubricId: scenario.rubricId,
      resumeVersionId: scenario.resumeVersionId,
      resumeId: chain.resume_id,
      assetId: chain.intake_asset_id,
      intakeRecordId: chain.intake_record_id,
      seedEventId: chain.event_id,
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 删掉提交夹具造的所有行（可精确列举），并断言真的删干净了。 */
async function cleanupCommittedFixture(fixture: CommittedFixture): Promise<void> {
  const client = await pool.connect()
  try {
    // 先提交删除、再独立验证：验证失败**不会**把删除回滚掉（曾经把两者放在同一事务里，
    // 断言一红 → 整笔 ROLLBACK → 夹具永久留在 ra_s6s7）。
    await client.query('begin')
    // 只在本事务内绕过"历史事实禁删"：删除的是测试自己造的行，不是历史；
    // SET LOCAL 随 COMMIT/ROLLBACK 自动恢复，不留下任何全局关闭状态。
    await client.query('set local session_replication_role = replica')
    await client.query('delete from recruitment.application where tenant_id = $1 and id = $2', [TENANT, fixture.applicationId])
    await client.query('delete from recruitment.resume_version where tenant_id = $1 and id = $2', [TENANT, fixture.resumeVersionId])
    await client.query('delete from recruitment.resume where tenant_id = $1 and id = $2', [TENANT, fixture.resumeId])
    await client.query('delete from recruitment.intake_asset where tenant_id = $1 and id = $2', [TENANT, fixture.assetId])
    await client.query('delete from recruitment.intake_record where tenant_id = $1 and id = $2', [TENANT, fixture.intakeRecordId])
    await client.query('delete from recruitment.candidate where tenant_id = $1 and id = $2', [TENANT, fixture.candidateId])
    await client.query('delete from recruitment.rubric_version where tenant_id = $1 and id = $2', [TENANT, fixture.rubricId])
    await client.query('delete from recruitment.job_version where tenant_id = $1 and id = $2', [TENANT, fixture.jobVersionId])
    await client.query('delete from recruitment.job where tenant_id = $1 and id = $2', [TENANT, fixture.jobId])
    // 事件：seed 的一条 + fn_row_guard 写的阶段事件（source_object_id = 申请 id）
    await client.query(
      'delete from recruitment.event_inbox where tenant_id = $1 and (event_id = $2 or source_object_id = $3)',
      [TENANT, fixture.seedEventId, fixture.applicationId],
    )
    await client.query('commit')

    const { rows } = await client.query<{ leftovers: string }>(
      `select (
          (select count(*) from recruitment.application where id = $1) +
          (select count(*) from recruitment.candidate where id = $2) +
          (select count(*) from recruitment.job where id = $3) +
          (select count(*) from recruitment.event_inbox where source_object_id = $1::text)
        )::text as leftovers`,
      [fixture.applicationId, fixture.candidateId, fixture.jobId],
    )
    assert.equal(Number(rows[0]?.leftovers ?? -1), 0, '提交夹具必须删干净（不能污染 ra_s6s7）')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 把提交夹具的阶段码改回指定值（独立提交，制造 A6 需要的起点）。 */
async function setCommittedStage(applicationId: string, stageCode: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    await client.query(
      'update recruitment.application set current_stage_code = $2, stage_entered_at = clock_timestamp() where tenant_id = $1 and id = $3',
      [TENANT, stageCode, applicationId],
    )
    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 读提交夹具的一行（独立事务，读已提交）。 */
async function readCommitted(applicationId: string): Promise<AppSnapshot> {
  const client = await pool.connect()
  try {
    return await readApp(client as unknown as DatabaseClient, applicationId)
  } finally {
    client.release()
  }
}

/** 在**自己的事务**里调一次推进（actor 已 SET LOCAL；与工具层 `withActor` 同口径）。 */
async function advanceInOwnTransaction(applicationId: string, tenantId: string): Promise<Awaited<ReturnType<typeof advanceApplicationStage>>> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const result = await advanceApplicationStage(client as unknown as DatabaseClient, { tenantId, applicationId })
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 数这条申请的阶段事件条数（独立事务）。 */
async function countCommittedStageEvents(applicationId: string): Promise<number> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n
         from recruitment.event_inbox
        where tenant_id = $1
          and event_type = 'application.current_stage_code.changed'
          and source_object_id = $2`,
      [TENANT, applicationId],
    )
    return Number(rows[0]?.n ?? -1)
  } finally {
    client.release()
  }
}

test.before(async () => {
  committed = await createCommittedFixture()
})

test.after(async () => {
  try {
    if (committed !== undefined) await cleanupCommittedFixture(committed)
  } finally {
    await pool.end()
  }
})

test('工具层 execute（真库）：ADVANCED + R4 标签，库里阶段真的变了（R2 的包内可达证据）', async () => {
  const fixture = committed
  assert.ok(fixture !== undefined, '提交夹具没造出来')
  const tool = createStageAdvanceTool(cfg)
  const value = await tool.execute({ application_id: fixture.applicationId }, undefined) as Record<string, unknown>

  assert.equal(value.tool, 'recruitment_application_stage_advance')
  assert.equal(value.contract_version, '1.1.0')
  assert.equal(value.status, 'ADVANCED')
  assert.equal(value.stage_code, 'S7')
  assert.deepEqual(value.transitions, [{ from: 'S6', to: 'S7' }])
  assert.deepEqual(value.blockers, [])
  assert.deepEqual(value.warnings, [])
  assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })

  const row = await readCommitted(fixture.applicationId)
  assert.equal(row.current_stage_code, 'S7', '库里的阶段必须真的变成 S7')
  assert.equal(value.record_version, row.record_version)
  assert.ok(row.stage_entered_at.getTime() > row.created_at.getTime())

  // 模型可见文本里必须有 actor 诚实口径（不许让审计看起来像人做的）
  const text = tool.output.render({}, value)[0]?.text ?? ''
  assert.match(text, /不代表决策人/)
})

test('A6 并发（两连接）：恰好 1 条阶段事件；另一侧 VERSION_CONFLICT（RR 下等锁后 40001）', async () => {
  const fixture = committed
  assert.ok(fixture !== undefined, '提交夹具没造出来')
  // 上一用例把夹具推到了 S7；这里拖回 S6（独立提交），制造"两个调用者都看到 S6"的起点。
  await setCommittedStage(fixture.applicationId, 'S6')
  const eventsBefore = await countCommittedStageEvents(fixture.applicationId)

  const a = await pool.connect()
  const b = await pool.connect()
  try {
    // 给两条连接起**本次用例专属**的 application_name：下面按名字等"B 真的在等锁"，
    // 不会被并行跑的其他测试文件里碰巧等锁的连接干扰（node --test 默认并行跑文件）。
    await a.query("set application_name = 'stage-advance-concurrency-a'")
    await b.query("set application_name = 'stage-advance-concurrency-b'")
    await a.query('begin')
    await a.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    // A 先拿到行锁并完成推进，但**先不提交**：B 会在 select … for update 上等这把锁。
    const resultA = await advanceApplicationStage(a as unknown as DatabaseClient, {
      tenantId: TENANT,
      applicationId: fixture.applicationId,
    })
    assert.equal(resultA.status, 'ADVANCED')
    assert.equal(resultA.stage_code, 'S7')

    // B 用 REPEATABLE READ：它是在 A 提交**之前**开始等锁的，A 提交后 PostgreSQL 抛 40001
    // （READ COMMITTED 下不会报错，只会看到新状态 → NO_OP；两种都证明"只有一个人写成功"）。
    await b.query('begin isolation level repeatable read')
    await b.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const pendingB = advanceApplicationStage(b as unknown as DatabaseClient, {
      tenantId: TENANT,
      applicationId: fixture.applicationId,
    })

    // 等 B 真的进入等锁状态，再让 A 提交（不靠固定 sleep 猜时序）。
    const deadline = Date.now() + 5_000
    let blocked = false
    while (Date.now() < deadline) {
      const { rows } = await a.query<{ n: number }>(
        `select count(*)::int as n
           from pg_stat_activity
          where wait_event_type = 'Lock' and state = 'active'
            and application_name = 'stage-advance-concurrency-b'`,
      )
      if (Number(rows[0]?.n ?? 0) >= 1) { blocked = true; break }
      await delay(20)
    }
    assert.ok(blocked, '第二个连接没有进入锁等待（并发用例不成立）')
    await a.query('commit')

    const outcome = await pendingB.then(() => null, (error: unknown) => error as Error & { code?: string })
    assert.ok(outcome !== null, 'B 必须失败，不能悄悄成功')
    assert.equal(outcome.code, 'VERSION_CONFLICT', `B 的音：${outcome.message}`)
    await b.query('rollback').catch(() => {})
  } finally {
    await a.query("set application_name = 'dsh-recruitment-integration-test'").catch(() => {})
    await b.query("set application_name = 'dsh-recruitment-integration-test'").catch(() => {})
    a.release()
    b.release()
  }

  // 库里的硬证据：只推进了一格、只有一条阶段事件、版本只 +1；第三次调用是 NO_OP。
  const row = await readCommitted(fixture.applicationId)
  assert.equal(row.current_stage_code, 'S7', 'B 没有写进任何东西')
  const eventsAfter = await countCommittedStageEvents(fixture.applicationId)
  assert.equal(
    eventsAfter - eventsBefore,
    1,
    `两次并发调用只能产生 1 条阶段事件（实际新增 ${eventsAfter - eventsBefore} 条）`,
  )
  const third = await advanceInOwnTransaction(fixture.applicationId, cfg.tenant_id)
  const rowAfterThird = await readCommitted(fixture.applicationId)
  assert.equal(third.status, 'NO_OP', '第三次（单连接、READ COMMITTED）：幂等 NO_OP')
  assert.equal(third.record_version, rowAfterThird.record_version, 'NO_OP 不写库')
  assert.equal(await countCommittedStageEvents(fixture.applicationId), eventsAfter, 'NO_OP 不产生事件')
})

