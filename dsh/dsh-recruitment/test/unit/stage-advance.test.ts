// 阶段推进（N8 / 方案 D）的单元测试：**不连库**，用假 client 逐条钉住判定语义。
//
// 为什么值得单独写一份"假库"测试（真库版本另有 test/integration/stage-advance.test.ts）：
//   1. 这里能构造真库很难构造的**交错**（UPDATE 返回 0 行、40001、stage_entered_at 没前进）；
//   2. 这里能**逐条断言"零 UPDATE"**（数 SQL 调用），真库只能从审计/版本号反推；
//   3. 这里能把"梯子三分法"（PASS / WAIT / BLOCKED）的每个分支都走一遍，而不必每次都造夹具。
//
// 断言的"事实"全部来自 `src/domain/stage-advance.ts` 的契约：
//   T1 S6→S7：material（resume_version_id 非空、parse_status ≠ FAILED）+ rubric_version_id 非空
//   T2 S7→S8：current（superseded_by_decision_id is null）SCREENING 决策 result=ADVANCE
//   HOLD/REJECT → BLOCKED（留在 S7）；没有决策 → WAIT/NO_OP；指针超前 → STAGE_AHEAD（零 UPDATE）
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  advanceApplicationStage,
  BLOCKER_CODES,
  NEXT_ACTION_CODES,
  OWNER_ROLES,
  readStageBlockedView,
  type AdvanceApplicationStageInput,
  type StageAdvanceResult,
  type StageBlockedView,
} from '../../src/domain/stage-advance.ts'
import {
  createStageAdvanceTool,
  unconfiguredStageAdvanceTool,
} from '../../src/tools/stage-advance.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const MATERIAL_ID = '11111111-1111-4111-8111-000000000901'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const DECISION_ID = '11111111-1111-4111-8111-000000000a01'
const TENANT = '11111111-1111-4111-8111-000000000001'
const CREATED_AT = new Date('2026-11-14T00:00:00.000Z')
/** created_at 的微秒表示（与库里的 `extract(epoch …)*1e6` 同口径；JS Date 只有毫秒）。 */
const CREATED_US = Date.parse(CREATED_AT.toISOString()) * 1000
/** 招聘负责人（部门 hiring_manager_actor_id，与 ra_s6s7 的 0002 seed 一致）。 */
const OWNER_ACTOR = '11111111-1111-4111-8111-000000000102'
const OWNER_NAME = '演示-招聘负责人'
/** 执行账号（`SET LOCAL recruitment.actor_id`；与 ra_s6s7 的 0002 seed HR 专员一致）。 */
const PIN_ACTOR = '11111111-1111-4111-8111-000000000103'

/** 行锁读到的申请（假库返回的行）。 */
interface FakeAppRow {
  id: string
  current_stage_code: string
  record_version: number
  lifecycle_status: string
  resume_version_id: string | null
  rubric_version_id: string | null
  /** 微秒（不是 Date）：两跳只差 1µs 时 Date 会判成相等。 */
  stage_entered_at_us: number
  created_at_us: number
}

/** 造一行申请（默认：S6 + 材料 + rubric 都齐 —— 即 T1 成立）。 */
function appRow(overrides: Partial<FakeAppRow> = {}): FakeAppRow {
  return {
    id: APP_ID,
    current_stage_code: 'S6',
    record_version: 1,
    lifecycle_status: 'ACTIVE',
    resume_version_id: MATERIAL_ID,
    rubric_version_id: RUBRIC_ID,
    stage_entered_at_us: CREATED_US,
    created_at_us: CREATED_US,
    ...overrides,
  }
}

/** 12 行阶段目录（顺序与 0002_seed 一致；本文件的判定只依赖 S6=6 / S7=7 / S8=8）。 */
const STAGE_ORDERS = [
  { code: 'S1', sort_order: 1, name: '招聘需求发现' }, { code: 'S2', sort_order: 2, name: 'Requisition 创建与审批' },
  { code: 'S3', sort_order: 3, name: 'Job / JD / Rubric 设计' }, { code: 'S4', sort_order: 4, name: 'Job Posting 发布' },
  { code: 'S5', sort_order: 5, name: '人才获取 / Sourcing' }, { code: 'S6', sort_order: 6, name: '简历接入与处理（Intake）' },
  { code: 'S7', sort_order: 7, name: '初筛 / Screening' }, { code: 'S8', sort_order: 8, name: '面试规划与排期' },
  { code: 'S9', sort_order: 9, name: '面试执行与材料获取' }, { code: 'S10', sort_order: 10, name: '综合评价与招聘决策' },
  { code: 'S11', sort_order: 11, name: 'Offer 与入职交接' }, { code: 'S12', sort_order: 12, name: '人才沉淀与复盘' },
]

interface QueryCall {
  readonly text: string
  readonly params: readonly unknown[]
}

/** UPDATE 的假返回行（与真库 RETURNING 同形）。 */
interface FakeUpdatedRow {
  current_stage_code: string
  record_version: number
  stage_entered_at_us: number
}

interface FakeInput {
  readonly application?: FakeAppRow | null
  readonly stageOrders?: readonly { code: string; sort_order: number; name: string }[]
  readonly material?: { parse_status: string } | null
  readonly decision?: {
    id: string
    result: string
    decided_by_actor_id: string
    decided_by_display_name?: string | null
  } | null
  /** 招聘负责人（`application → job → department.hiring_manager_actor_id`）；`null` = 推不出来。 */
  readonly owner?: { actor_id: string; display_name: string } | null
  /**
   * 岗位"当前已批准的 rubric 版本"（F1 补钉的唯一输入）。
   * 省略 = 岗位没有可钉的当前版本（→ 仍报 RUBRIC_NOT_PINNED，零写入）。
   */
  readonly pinnable?: { rubric_version_id: string; version_no: number } | null
  /** 执行账号 GUC（`SET LOCAL recruitment.actor_id`）；`null` = 没有 actor（补钉必须拒绝）。 */
  readonly actorId?: string | null
  /** 依次消费；不提供就按 params 自动生成"成功"的 RETURNING。 */
  readonly updateResults?: readonly (FakeUpdatedRow | null)[]
  /** 让某类查询抛错（模拟 40001 等），例如 `{ match: 'for update', error }`。 */
  readonly throwOn?: { readonly match: string; readonly error: unknown }
}

/**
 * 一个"按 SQL 文本分派"的假 DatabaseClient：只实现本模块用到的那几条语句。
 * 它记录的 `calls` 就是"到底发了几条 UPDATE"的唯一证据。
 */
function fakeClient(input: FakeInput): DatabaseClient & { readonly calls: readonly QueryCall[] } {
  const calls: QueryCall[] = []
  const updateResults = [...(input.updateResults ?? [])]
  let updateCount = 0
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      calls.push({ text, params })
      if (input.throwOn !== undefined && text.includes(input.throwOn.match)) throw input.throwOn.error
      // 责任人推导（application → job → department.hiring_manager_actor_id）
      if (text.includes('hiring_manager_actor_id')) {
        const owner = input.owner
        return {
          rows: owner === undefined || owner === null
            ? [{ actor_id: null, display_name: null }]
            : [{ actor_id: owner.actor_id, display_name: owner.display_name }],
        }
      }
      // 申请行：写路径带 `for update`，只读视图是普通 select（两者都含 stage_entered_at）
      if (text.includes('from recruitment.application') && text.includes('stage_entered_at')) {
        return { rows: input.application === undefined || input.application === null ? [] : [input.application] }
      }
      if (text.includes('recruitment.stage_catalog')) {
        return { rows: [...(input.stageOrders ?? STAGE_ORDERS)] }
      }
      if (text.includes('recruitment.resume_version')) {
        if (input.material === undefined) return { rows: [] }
        return { rows: input.material === null ? [] : [input.material] }
      }
      // F1：补钉前读"岗位当前已批准 rubric"（只读；没有就返回空 → 仍 BLOCKED、零写入）。
      if (text.includes('recruitment.rubric_version') && text.includes('current_rubric_version_id')) {
        const target = input.pinnable
        return { rows: target === undefined || target === null ? [] : [target] }
      }
      // F1：补钉写审计事件（event_inbox）。
      if (text.includes('insert into recruitment.event_inbox')) {
        return { rows: [{ event_id: `evt-pin-${calls.length}` }] }
      }
      // F1：补钉前从 GUC 读执行账号（`SET LOCAL recruitment.actor_id`）。
      if (text.includes("current_setting('recruitment.actor_id'")) {
        const actor = input.actorId
        return { rows: [{ actor_id: actor === undefined ? PIN_ACTOR : actor }] }
      }
      if (text.includes('recruitment.decision')) {
        if (input.decision === undefined) return { rows: [] }
        return { rows: input.decision === null ? [] : [input.decision] }
      }
      // F1：补钉 UPDATE（只写 rubric_version_id，不是阶段迁移）。
      if (text.trimStart().startsWith('update recruitment.application') && text.includes('set rubric_version_id')) {
        updateCount += 1
        return { rows: [{ record_version: Number(input.application?.record_version ?? 1) + 1 }] }
      }
      if (text.trimStart().startsWith('update recruitment.application')) {
        const toStage = String(params[3])
        const expected = Number(params[4])
        updateCount += 1
        if (updateResults.length > 0) {
          const fixed = updateResults.shift() as FakeUpdatedRow | null
          return { rows: fixed === null ? [] : [fixed] }
        }
        return {
          rows: [{
            current_stage_code: toStage,
            record_version: expected + 1,
            // 真实钟：每一条 UPDATE 都比创建时间 / 上一跳晚（created_at 是事务开始时间）。
            stage_entered_at_us: CREATED_US + 60_000_000 * updateCount,
          }],
        }
      }
      throw new Error(`fakeClient: 未预期的 SQL：${text.slice(0, 80)}（from=${params[2] as string}）`)
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: readonly QueryCall[] }
}

/** 跑一次推进（假库）。 */
async function advanceWith(
  input: FakeInput,
): Promise<{ result: StageAdvanceResult; client: DatabaseClient & { readonly calls: readonly QueryCall[] } }> {
  const client = fakeClient(withDefaultOwner(input))
  const args: AdvanceApplicationStageInput = { tenantId: TENANT, applicationId: APP_ID }
  const result = await advanceApplicationStage(client, args)
  return { result, client }
}

/** 跑一次只读阻塞视图（假库）。 */
async function viewWith(
  input: FakeInput,
): Promise<{ view: StageBlockedView; client: DatabaseClient & { readonly calls: readonly QueryCall[] } }> {
  const client = fakeClient(withDefaultOwner(input))
  const view = await readStageBlockedView(client, { tenantId: TENANT, applicationId: APP_ID })
  return { view, client }
}

/** 默认给一个"能查到的招聘负责人"（除非用例显式设成 `null` = 推不出来）。 */
function withDefaultOwner(input: FakeInput): FakeInput {
  return input.owner === undefined
    ? { ...input, owner: { actor_id: OWNER_ACTOR, display_name: OWNER_NAME } }
    : input
}

/** 本调用发出的 UPDATE 条数。 */
function updateCalls(client: { readonly calls: readonly QueryCall[] }): number {
  return client.calls.filter((call) => call.text.trimStart().startsWith('update recruitment.application')).length
}

/** 断言一条阻塞/告警的"结构化责任"是机检得动的（不是自由文本）。 */
function assertStructuredResponsibility(item: {
  owner_role: string
  next_action_code: string
  owner_actor_id?: string
  owner_display_name?: string
}, label: string): void {
  assert.ok((OWNER_ROLES as readonly string[]).includes(item.owner_role), `${label}: owner_role=${item.owner_role} 不在封闭集`)
  assert.ok((NEXT_ACTION_CODES as readonly string[]).includes(item.next_action_code), `${label}: next_action_code=${item.next_action_code} 不在封闭集`)
  // 门槛要求"owner_actor_id 或 next_action_code 至少有一个非空"：next_action_code 恒非空（封闭集），
  // owner_actor_id 能推出来时必须是一个 UUID 文本（不是自由文本）。
  assert.ok(item.next_action_code.length > 0)
  if (item.owner_actor_id !== undefined) {
    assert.match(item.owner_actor_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `${label}: owner_actor_id 不是 UUID`)
  }
}

// =====================================================================
//  T1：S6 → S7
// =====================================================================

test('T1 正例：材料 + rubric 齐 → ADVANCED S7，且只发一条带版本条件的 UPDATE', async () => {
  const { result, client } = await advanceWith({ application: appRow(), material: { parse_status: 'PARSED' } })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S7')
  assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])
  assert.deepEqual(result.blockers, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.record_version, 2, 'RETURNING 的真实版本（触发器 +1），不是自己算的')
  assert.equal(updateCalls(client), 1)
  const update = client.calls.find((call) => call.text.trimStart().startsWith('update recruitment.application'))
  assert.ok(update !== undefined)
  assert.deepEqual(update.params, [APP_ID, TENANT, 'S6', 'S7', 1], 'UPDATE 必须带 from + record_version')
  assert.ok(update.text.includes('stage_entered_at'), '必须显式写 stage_entered_at（本仓既有缺陷）')
  assert.ok(update.text.includes('clock_timestamp()'), '用真实钟而不是事务开始时间（now()）')
  assert.ok(update.text.includes('greatest('), '用 greatest(...) 把严格单调变成构造出来的事实')
  assert.ok(update.text.includes("interval '1 microsecond'"), '时钟粒度不足时用 1µs 下限保证严格单调')
  // 只检查 SET 子句：`where … record_version = $5` 是**条件**（必须有），不是自增写入。
  const setClause = update.text.slice(update.text.indexOf(' set '), update.text.indexOf(' where '))
  assert.ok(!/record_version/.test(setClause), '不许手写 record_version（由 fn_row_guard 维护）')
  assert.ok(!/stage_changed_at|stage_source_event_id/.test(setClause), '审计列由触发器维护，不许手写')
})

test('T1 正例：PARTIAL（非 FAILED）也算材料可用', async () => {
  const { result } = await advanceWith({ application: appRow(), material: { parse_status: 'PARTIAL' } })
  assert.equal(result.status, 'ADVANCED')
})

test('T1 缺 rubric → BLOCKED RUBRIC_NOT_PINNED，阶段不变、零 UPDATE；带结构化责任 + 下一步', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['RUBRIC_NOT_PINNED'])
  assert.match(result.blockers[0]?.message ?? '', /rubric/)
  const blocker = result.blockers[0] as NonNullable<typeof result.blockers[0]>
  // §11.6-8：责任人 + 下一步必须是**结构化**的（工作台能机检），不是自由文本。
  assertStructuredResponsibility(blocker, 'RUBRIC_NOT_PINNED')
  assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER', '缺 rubric 该找岗位/部门的招聘负责人')
  assert.equal(blocker.next_action_code, 'PIN_RUBRIC_VERSION')
  assert.equal(blocker.owner_actor_id, OWNER_ACTOR, '责任人从库里推出来（部门 hiring_manager_actor_id）')
  assert.equal(blocker.owner_display_name, OWNER_NAME)
  assert.deepEqual(result.transitions, [])
  assert.equal(result.stage_code, 'S6', '阶段不变')
  assert.equal(result.record_version, 1, 'record_version 不变（零 UPDATE 的唯一硬证据）')
  assert.equal(updateCalls(client), 0)
})

test('T1 材料缺失 + rubric 缺失 → 两条 blocker 一次给全（不做"只报第一条"）', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ resume_version_id: null, rubric_version_id: null }),
    // 即使岗位有可钉的当前版本，也**不补钉**：还有材料问题，BLOCKED 必须零写入。
    pinnable: { rubric_version_id: RUBRIC_ID, version_no: 1 },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['MATERIAL_NOT_LINKED', 'RUBRIC_NOT_PINNED'])
  assert.equal(updateCalls(client), 0)
  assert.equal(
    client.calls.filter((call) => call.text.includes('recruitment.rubric_version')).length,
    0,
    '不补钉时连"读可钉版本"都不发（零写入的第一层证据）',
  )
})

// =====================================================================
//  F1 · T1 补钉（申请没钉，但岗位当前已有已批准版本）
// =====================================================================

test('F1 补钉：申请没钉 + 岗位当前已批准 → 同一事务补钉（带审计）后推进 S7，两条 UPDATE', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ rubric_version_id: null, record_version: 1 }),
    material: { parse_status: 'PARSED' },
    pinnable: { rubric_version_id: RUBRIC_ID, version_no: 2 },
    actorId: PIN_ACTOR,
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S7')
  assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])
  // record_version：补钉 +1（真库由 fn_row_guard 维护）→ 阶段 +1 ⇒ 3。
  assert.equal(result.record_version, 3, '补钉与阶段迁移各让 record_version 自增一次')

  const updates = client.calls.filter((call) => call.text.trimStart().startsWith('update recruitment.application'))
  assert.equal(updates.length, 2, '先补钉、再迁移：恰好两条 UPDATE')
  const pin = updates[0]
  assert.ok(pin?.text.includes('set rubric_version_id'), '第一条是补钉')
  assert.ok(pin?.text.includes('rubric_version_id is null'), '补钉必须是条件写（并发下不覆盖已有值）')
  assert.deepEqual(pin?.params, [APP_ID, TENANT, RUBRIC_ID], '补钉只写 (application, tenant) 定位的 rubric_version_id')
  const stage = updates[1]
  assert.ok(stage?.text.includes('stage_entered_at'), '第二条是阶段迁移')
  assert.deepEqual(
    stage?.params,
    [APP_ID, TENANT, 'S6', 'S7', 2],
    '阶段 UPDATE 的乐观并发条件必须是**补钉之后**的 record_version（2），不是读到的 1',
  )

  // 审计：一条内部事件，绑 application + actor + 新旧值（F1 要求"同一事务内、带审计"）。
  const events = client.calls.filter((call) => call.text.includes('insert into recruitment.event_inbox'))
  assert.equal(events.length, 1, '补钉必须留一条审计事件')
  const event = events[0]
  assert.ok(event?.text.includes("'application.rubric_version.pinned'"), '事件类型固定')
  assert.ok(event?.text.includes("'FALLBACK_KEY'"), '内部事实用 FALLBACK_KEY（并绑 source_object_id）')
  assert.equal(event?.params[2], APP_ID, 'source_object_id = 申请 id')
  const payload = JSON.parse(String(event?.params[3])) as Record<string, unknown>
  assert.equal(payload.rubric_version_id, RUBRIC_ID)
  assert.equal(payload.to, RUBRIC_ID)
  assert.equal(payload.from, null, '补钉前是"没有值"（该事件不是状态列迁移，允许 from=null）')
  assert.equal(payload.actor_id, PIN_ACTOR, '审计要记"谁钉的"，不是匿名写入')
  assert.equal(payload.application_id, APP_ID)
})

test('F1 补钉：岗位 current 指针为空/无已批准版本 → 不补钉，仍 BLOCKED RUBRIC_NOT_PINNED、零 UPDATE', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
    pinnable: null,
  })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['RUBRIC_NOT_PINNED'])
  assert.equal(updateCalls(client), 0, '没有可钉的已批准版本 ⇒ 一行都不写')
  assert.equal(
    client.calls.filter((call) => call.text.includes('insert into recruitment.event_inbox')).length,
    0,
    '没写补钉就不许有审计事件（否则是假审计）',
  )
})

test('F1 补钉：执行上下文没有 actor → INVALID_ARGS(ACTOR_REQUIRED)，零 UPDATE（不写匿名审计）', async () => {
  const client = fakeClient(withDefaultOwner({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
    pinnable: { rubric_version_id: RUBRIC_ID, version_no: 2 },
    actorId: null,
  }))
  await assert.rejects(
    advanceApplicationStage(client, { tenantId: TENANT, applicationId: APP_ID }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /INVALID_ARGS/)
      assert.match(message, /ACTOR_REQUIRED/)
      return true
    },
  )
  assert.equal(updateCalls(client), 0, '没有 actor 就不许写（补钉与阶段 UPDATE 都不发）')
  assert.equal(
    client.calls.filter((call) => call.text.includes('insert into recruitment.event_inbox')).length,
    0,
    '没有 actor 就不许有审计事件（匿名写入是被禁止的）',
  )
})

test('F1 只读视图不补钉：岗位当前已批准 → 视图仍按**当前事实**报 RUBRIC_NOT_PINNED，且一条写语句都不发', async () => {
  const { view, client } = await viewWith({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
    pinnable: { rubric_version_id: RUBRIC_ID, version_no: 2 },
  })
  assert.equal(view.blocked, true)
  assert.equal(view.status, 'BLOCKED')
  assert.equal(view.blockers[0]?.code, 'RUBRIC_NOT_PINNED', '视图回答"库里现在缺什么"，不替写路径补钉')
  assert.equal(updateCalls(client), 0, '只读视图一条 UPDATE 都不发')
  assert.equal(
    client.calls.filter((call) => /\binsert into\b/i.test(call.text)).length,
    0,
    '只读视图一条 INSERT 都不发（含审计事件）',
  )
  assert.equal(
    client.calls.filter((call) => call.text.includes('recruitment.rubric_version')).length,
    0,
    '只读视图连"读可钉版本"都不做（补钉是写路径的事）',
  )
})

test('T1 材料 parse_status=FAILED → BLOCKED MATERIAL_PARSE_FAILED，零 UPDATE', async () => {
  const { result, client } = await advanceWith({ application: appRow(), material: { parse_status: 'FAILED' } })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['MATERIAL_PARSE_FAILED'])
  assert.equal(updateCalls(client), 0)
})

test('T1 材料行查不到（脏绑定）→ BLOCKED MATERIAL_NOT_LINKED', async () => {
  const { result } = await advanceWith({ application: appRow(), material: null })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['MATERIAL_NOT_LINKED'])
})

// =====================================================================
//  T2：S7 → S8
// =====================================================================

test('T2 正例：current SCREENING=ADVANCE → ADVANCED S8', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ current_stage_code: 'S7', record_version: 4 }),
    decision: { id: DECISION_ID, result: 'ADVANCE', decided_by_actor_id: '11111111-1111-4111-8111-000000000102' },
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S8')
  assert.deepEqual(result.transitions, [{ from: 'S7', to: 'S8' }])
  assert.equal(updateCalls(client), 1)
  const update = client.calls.find((call) => call.text.trimStart().startsWith('update recruitment.application'))
  assert.deepEqual(update?.params, [APP_ID, TENANT, 'S7', 'S8', 4])
})

for (const result of ['HOLD', 'REJECT', 'WITHDRAW']) {
  test(`T2 负例：current SCREENING=${result} → BLOCKED，阶段留在 S7、零 UPDATE；责任人是决策人`, async () => {
    const { result: outcome, client } = await advanceWith({
      application: appRow({ current_stage_code: 'S7', record_version: 3 }),
      decision: {
        id: DECISION_ID,
        result,
        decided_by_actor_id: '11111111-1111-4111-8111-000000000104',
        decided_by_display_name: '演示-面试官',
      },
    })
    assert.equal(outcome.status, 'BLOCKED')
    assert.deepEqual(outcome.blockers.map((b) => b.code), ['SCREENING_DECISION_NOT_ADVANCE'])
    assert.match(outcome.blockers[0]?.message ?? '', new RegExp(result))
    const blocker = outcome.blockers[0] as NonNullable<typeof outcome.blockers[0]>
    assertStructuredResponsibility(blocker, 'SCREENING_DECISION_NOT_ADVANCE')
    assert.equal(blocker.owner_role, 'SCREENING_DECIDER', 'HOLD/REJECT 该找做这个决定的人')
    assert.equal(blocker.next_action_code, 'SUPERSEDE_SCREENING_DECISION')
    assert.equal(blocker.owner_actor_id, '11111111-1111-4111-8111-000000000104', '责任人=decision.decided_by_actor_id（不是执行账号）')
    assert.equal(blocker.owner_display_name, '演示-面试官')
    assert.equal(outcome.stage_code, 'S7')
    assert.equal(outcome.record_version, 3)
    assert.equal(updateCalls(client), 0)
  })
}

test('T2 还没有决策 → WAIT → NO_OP（不是错误、零 UPDATE；幂等的来源）', async () => {
  const first = await advanceWith({ application: appRow({ current_stage_code: 'S7', record_version: 2 }) })
  assert.equal(first.result.status, 'NO_OP')
  assert.deepEqual(first.result.transitions, [])
  assert.deepEqual(first.result.blockers, [])
  assert.equal(first.result.stage_code, 'S7')
  assert.equal(first.result.record_version, 2)
  assert.equal(updateCalls(first.client), 0)
  // 连调第二次：状态不变、零 UPDATE（幂等）
  const second = await advanceWith({ application: appRow({ current_stage_code: 'S7', record_version: 2 }) })
  assert.equal(second.result.status, 'NO_OP')
  assert.equal(second.result.record_version, 2)
  assert.equal(updateCalls(second.client), 0)
})

// =====================================================================
//  不倒退 / 不跳阶
// =====================================================================

test('指针超前（S9/S10，超过本命令能推导的 S8）→ NO_OP + STAGE_AHEAD，一条 UPDATE 都不发；告警带责任人 + 下一步', async () => {
  for (const stage of ['S9', 'S10', 'S12']) {
    const { result, client } = await advanceWith({
      application: appRow({ current_stage_code: stage, record_version: 5 }),
      decision: { id: DECISION_ID, result: 'ADVANCE', decided_by_actor_id: '11111111-1111-4111-8111-000000000102' },
    })
    assert.equal(result.status, 'NO_OP', `${stage} 应 NO_OP`)
    assert.deepEqual(result.warnings.map((w) => w.code), ['STAGE_AHEAD'], `${stage} 应给 STAGE_AHEAD`)
    const warning = result.warnings[0] as NonNullable<typeof result.warnings[0]>
    // §11.6-8：STAGE_AHEAD 也要能被工作台机检（责任人 + 下一步），不是只给一句话。
    assertStructuredResponsibility(warning, 'STAGE_AHEAD')
    assert.equal(warning.owner_role, 'RECRUITMENT_OWNER')
    assert.equal(warning.next_action_code, 'VERIFY_STAGE_PROGRESSION')
    assert.equal(warning.owner_actor_id, OWNER_ACTOR, '能推出招聘负责人就填')
    assert.equal(result.stage_code, stage, '指针一个字节都不动')
    assert.equal(result.record_version, 5)
    assert.equal(updateCalls(client), 0)
  }
})

test('指针在梯子起点之前（S3）→ BLOCKED STAGE_NOT_ON_LADDER，不插队', async () => {
  const { result, client } = await advanceWith({ application: appRow({ current_stage_code: 'S3' }) })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['STAGE_NOT_ON_LADDER'])
  assert.equal(updateCalls(client), 0)
})

test('指针正好在 S8（梯子终点）→ NO_OP，且**不是** STAGE_AHEAD', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ current_stage_code: 'S8', record_version: 6 }),
    decision: { id: DECISION_ID, result: 'ADVANCE', decided_by_actor_id: '11111111-1111-4111-8111-000000000102' },
  })
  assert.equal(result.status, 'NO_OP')
  assert.deepEqual(result.warnings, [])
  assert.equal(updateCalls(client), 0)
})

// =====================================================================
//  落后补推进（多跳）与"先如实地推、再停在反向事实前"
// =====================================================================

test('T1 + T2 同时成立：一次调用走两跳 S6→S7→S8（两条 UPDATE、两个 transition）', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ record_version: 1 }),
    material: { parse_status: 'PARSED' },
    decision: { id: DECISION_ID, result: 'ADVANCE', decided_by_actor_id: '11111111-1111-4111-8111-000000000102' },
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S8')
  assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }, { from: 'S7', to: 'S8' }])
  assert.equal(result.record_version, 3, '两条 UPDATE 各 +1')
  assert.equal(updateCalls(client), 2)
})

test('S6 但 SCREENING=HOLD：如实推到 S7，再停在 S7（ADVANCED + blocker，不装成 BLOCKED）', async () => {
  const { result } = await advanceWith({
    application: appRow(),
    material: { parse_status: 'PARSED' },
    decision: { id: DECISION_ID, result: 'HOLD', decided_by_actor_id: '11111111-1111-4111-8111-000000000102' },
  })
  assert.equal(result.status, 'ADVANCED', '确实发生了一跳，不能报 BLOCKED')
  assert.equal(result.stage_code, 'S7')
  assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])
  assert.deepEqual(result.blockers.map((b) => b.code), ['SCREENING_DECISION_NOT_ADVANCE'])
})

// =====================================================================
//  乐观并发 / 完整性断言（真错必须抛，不许静默）
// =====================================================================

test('UPDATE 0 行 → VERSION_CONFLICT(APPLICATION_RECORD_VERSION_MISMATCH)', async () => {
  const failing = fakeClient({
    application: appRow(),
    material: { parse_status: 'PARSED' },
    updateResults: [null],
  })
  await assert.rejects(
    () => advanceApplicationStage(failing, { tenantId: TENANT, applicationId: APP_ID }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      const body = JSON.parse(error.message.slice(error.message.indexOf(': ') + 2)) as Record<string, unknown>
      assert.equal(body.reason_code, 'APPLICATION_RECORD_VERSION_MISMATCH')
      return true
    },
  )
  // 0 行不等于"重试到成功"：只发了一条 UPDATE 就停（不 last-write-wins）
  assert.equal(updateCalls(failing), 1)
})

test('40001（REPEATABLE READ 下等锁后发现行被改）→ 映射成 VERSION_CONFLICT(APPLICATION_CONCURRENT_UPDATE)', async () => {
  const serializationFailure = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' })
  const failing = fakeClient({
    application: appRow(),
    material: { parse_status: 'PARSED' },
    throwOn: { match: 'for update', error: serializationFailure },
  })
  await assert.rejects(
    () => advanceApplicationStage(failing, { tenantId: TENANT, applicationId: APP_ID }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'VERSION_CONFLICT')
      const body = JSON.parse(error.message.slice(error.message.indexOf(': ') + 2)) as Record<string, unknown>
      assert.equal(body.reason_code, 'APPLICATION_CONCURRENT_UPDATE')
      return true
    },
  )
})

test('stage_entered_at 没前进 → INVARIANT_VIOLATION（本仓既有缺陷回归的兜底）', async () => {
  const failing = fakeClient({
    application: appRow(),
    material: { parse_status: 'PARSED' },
    // 返回一个"没前进"的时间：等于 created_at
    updateResults: [{ current_stage_code: 'S7', record_version: 2, stage_entered_at_us: CREATED_US }],
  })
  await assert.rejects(
    () => advanceApplicationStage(failing, { tenantId: TENANT, applicationId: APP_ID }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVARIANT_VIOLATION')
      const body = JSON.parse(error.message.slice(error.message.indexOf(': ') + 2)) as Record<string, unknown>
      assert.equal(body.reason_code, 'STAGE_ENTERED_AT_NOT_ADVANCED')
      return true
    },
  )
})

test('申请不存在 → NOT_FOUND(APPLICATION_NOT_FOUND)', async () => {
  const failing = fakeClient({ application: null })
  await assert.rejects(
    () => advanceApplicationStage(failing, { tenantId: TENANT, applicationId: APP_ID }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'NOT_FOUND')
      return true
    },
  )
})

test('非 ACTIVE 的申请不推进 → BLOCKED APPLICATION_NOT_ACTIVE，零 UPDATE', async () => {
  const { result, client } = await advanceWith({
    application: appRow({ lifecycle_status: 'CLOSED' }),
    material: { parse_status: 'PARSED' },
  })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['APPLICATION_NOT_ACTIVE'])
  assert.equal(updateCalls(client), 0)
})

test('blocker 码只来自封闭集（防止随手加码）', async () => {
  const { result } = await advanceWith({ application: appRow({ rubric_version_id: null }) })
  for (const blocker of result.blockers) {
    assert.ok((BLOCKER_CODES as readonly string[]).includes(blocker.code), `${blocker.code} 不在封闭集里`)
    assertStructuredResponsibility(blocker, blocker.code)
  }
})

// =====================================================================
//  §11.6-8：结构化责任（owner / next_action）——每一类阻塞都必须机检得动
// =====================================================================

test('§11.6-8 所有阻塞/告警都带结构化 owner_role + next_action_code（封闭集，不是自由文本）', async () => {
  const cases: FakeInput[] = [
    { application: appRow({ rubric_version_id: null }), material: { parse_status: 'PARSED' } },      // RUBRIC_NOT_PINNED
    { application: appRow({ resume_version_id: null }) },                                            // MATERIAL_NOT_LINKED
    { application: appRow(), material: { parse_status: 'FAILED' } },                                  // MATERIAL_PARSE_FAILED
    { application: appRow({ lifecycle_status: 'CLOSED' }) },                                          // APPLICATION_NOT_ACTIVE
    { application: appRow({ current_stage_code: 'S3' }) },                                            // STAGE_NOT_ON_LADDER
    { application: appRow({ current_stage_code: 'S7' }),
      decision: { id: DECISION_ID, result: 'HOLD', decided_by_actor_id: '11111111-1111-4111-8111-000000000104' } }, // SCREENING_DECISION_NOT_ADVANCE
    { application: appRow({ current_stage_code: 'S9' }) },                                            // STAGE_AHEAD（warning）
  ]
  for (const input of cases) {
    const { result } = await advanceWith(input)
    const items = [...result.blockers, ...result.warnings]
    assert.ok(items.length > 0, '每个用例都必须产出一条阻塞/告警')
    for (const item of items) assertStructuredResponsibility(item, item.code)
    // 至少一条能被工作台直接渲染出"找谁"：owner_actor_id 或 owner_role 非空
    assert.ok(items.every((item) => (item.owner_actor_id ?? item.owner_role).length > 0))
  }
})

test('§11.6-8 owner 推不出来时不编造：省略 actor 字段，但 owner_role + next_action_code 仍然给出"该找谁"', async () => {
  const { result } = await advanceWith({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
    owner: null, // 部门没有 hiring_manager_actor_id
  })
  const blocker = result.blockers[0] as NonNullable<typeof result.blockers[0]>
  assert.equal(blocker.code, 'RUBRIC_NOT_PINNED')
  assert.equal(Object.hasOwn(blocker, 'owner_actor_id'), false, '推不出来就不许编一个 actor')
  assert.equal(Object.hasOwn(blocker, 'owner_display_name'), false)
  assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER')
  assert.equal(blocker.next_action_code, 'PIN_RUBRIC_VERSION')
})

test('§11.6-8 只读阻塞视图（假库）：RUBRIC_NOT_PINNED → stage + blocker + owner + next_action 四要素齐', async () => {
  const { view, client } = await viewWith({
    application: appRow({ rubric_version_id: null }),
    material: { parse_status: 'PARSED' },
  })
  assert.equal(view.application_id, APP_ID)
  assert.equal(view.stage, 'S6')
  assert.equal(view.stage_name, '简历接入与处理（Intake）')
  assert.equal(view.status, 'BLOCKED')
  assert.equal(view.blocked, true)
  assert.equal(view.blockers.length, 1)
  const obstruction = view.blockers[0] as NonNullable<typeof view.blockers[0]>
  assert.equal(obstruction.kind, 'BLOCKER')
  assert.equal(obstruction.code, 'RUBRIC_NOT_PINNED')
  assert.equal(obstruction.owner_actor_id, OWNER_ACTOR)
  assert.equal(obstruction.owner_role, 'JOB_HIRING_MANAGER')
  assert.equal(obstruction.next_action_code, 'PIN_RUBRIC_VERSION')
  // 整条申请级别：owner / next_action 也必须结构化非空
  assert.equal(view.owner.role, 'JOB_HIRING_MANAGER')
  assert.equal(view.owner.actor_id, OWNER_ACTOR)
  assert.equal(view.owner.display_name, OWNER_NAME)
  assert.equal(view.next_action.code, 'PIN_RUBRIC_VERSION')
  assert.ok(view.next_action.message.length > 0, '下一步要有给人读的说明')
  // 只读视图：一条 UPDATE 都不发
  assert.equal(updateCalls(client), 0)
})

test('§11.6-8 只读阻塞视图（假库）：STAGE_AHEAD → kind=WARNING，不是 blocked，但仍有 owner/next_action', async () => {
  const { view } = await viewWith({ application: appRow({ current_stage_code: 'S9', record_version: 4 }) })
  assert.equal(view.stage, 'S9')
  assert.equal(view.stage_name, '面试执行与材料获取')
  assert.equal(view.status, 'NO_OP')
  assert.equal(view.blocked, false, 'STAGE_AHEAD 是告警不是阻塞')
  const obstruction = view.blockers[0] as NonNullable<typeof view.blockers[0]>
  assert.equal(obstruction.kind, 'WARNING')
  assert.equal(obstruction.code, 'STAGE_AHEAD')
  assert.equal(obstruction.owner_role, 'RECRUITMENT_OWNER')
  assert.equal(obstruction.next_action_code, 'VERIFY_STAGE_PROGRESSION')
  assert.equal(obstruction.owner_actor_id, OWNER_ACTOR)
  assert.equal(view.owner.role, 'RECRUITMENT_OWNER')
  assert.equal(view.next_action.code, 'VERIFY_STAGE_PROGRESSION')
})

test('§11.6-8 只读阻塞视图：没有阻塞时给"下一步"（等人 → RECORD_SCREENING_DECISION；S8 → CONTINUE_DOWNSTREAM）', async () => {
  const waiting = await viewWith({ application: appRow({ current_stage_code: 'S7', record_version: 2 }) })
  assert.equal(waiting.view.status, 'NO_OP')
  assert.deepEqual(waiting.view.blockers, [])
  assert.equal(waiting.view.next_action.code, 'RECORD_SCREENING_DECISION')
  assert.equal(waiting.view.owner.role, 'RECRUITMENT_OWNER')
  assert.equal(waiting.view.owner.actor_id, OWNER_ACTOR)

  const ready = await viewWith({ application: appRow(), material: { parse_status: 'PARSED' } })
  assert.equal(ready.view.status, 'ADVANCED', '事实已齐：视图告诉工作台"可以推进"')
  assert.deepEqual(ready.view.blockers, [])
  assert.equal(ready.view.next_action.code, 'ADVANCE_STAGE')

  const downstream = await viewWith({ application: appRow({ current_stage_code: 'S8', record_version: 6 }) })
  assert.equal(downstream.view.status, 'NO_OP')
  assert.equal(downstream.view.next_action.code, 'CONTINUE_DOWNSTREAM')
})

test('§11.6-8 只读阻塞视图：视图不发出任何写语句（UPDATE 计数 = 0）', async () => {
  for (const input of [
    { application: appRow({ rubric_version_id: null }) },
    { application: appRow({ current_stage_code: 'S9' }) },
    { application: appRow(), material: { parse_status: 'PARSED' } },
  ] as FakeInput[]) {
    const { client } = await viewWith(input)
    assert.equal(updateCalls(client), 0)
    assert.equal(client.calls.length > 0, true, '视图确实查了库（不是空转）')
  }
})

// =====================================================================
//  工具层：入参只有 application_id / 输出 schema 合规 / 描述里的 actor 诚实
// =====================================================================

const CFG = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 10_000,
  max: 2,
} as ResolvedDatabaseConfig

const TOOL = createStageAdvanceTool(CFG)

test('工具名固定为 recruitment_application_stage_advance', () => {
  assert.equal(TOOL.name, 'recruitment_application_stage_advance')
})

test('入参只有 application_id（不接受目标阶段 / actor / tenant）', () => {
  const parameters = TOOL.parameters as Record<string, unknown>
  const properties = parameters.properties as Record<string, unknown>
  assert.deepEqual(Object.keys(properties), ['application_id'])
  assert.deepEqual(parameters.required, ['application_id'])
  assert.equal(parameters.additionalProperties, false)
  for (const forbidden of ['to_stage', 'stage_code', 'actor_id', 'tenant_id', 'target_stage']) {
    assert.equal(Object.hasOwn(properties, forbidden), false, `不许声明 ${forbidden}`)
  }
})

test('传目标阶段 / actor 一律 INVALID_ARGS（在连库之前就被拒）', async () => {
  await assert.rejects(
    () => TOOL.execute({ application_id: APP_ID, to_stage: 'S10' }, undefined),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVALID_ARGS')
      assert.match(error.message, /to_stage/)
      return true
    },
  )
  await assert.rejects(
    () => TOOL.execute({ application_id: APP_ID, actor_id: '11111111-1111-4111-8111-000000000102' }, undefined),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVALID_ARGS')
      assert.match(error.message, /TENANT_OR_ACTOR_NOT_ALLOWED|actor_id/)
      return true
    },
  )
  await assert.rejects(() => TOOL.execute({}, undefined), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })
  await assert.rejects(() => TOOL.execute({ application_id: 'not-a-uuid' }, undefined), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'INVALID_ARGS')
    return true
  })
})

test('写工具不与兄弟调用并行（isConcurrencySafe=false，与 intake 同口径）', () => {
  assert.equal(TOOL.isConcurrencySafe?.({}), false)
})

test('描述里明文写死 actor 诚实：stage_changed_by_actor_id = 执行账号，不是决策人', () => {
  assert.match(TOOL.description, /EXECUTING ACCOUNT/)
  assert.match(TOOL.description, /NOT the decision maker/)
  assert.match(TOOL.description, /T1 is an automatic advance/)
})

/** DSH 支持的约束关键字（与 test/unit/output-schema.test.ts 同一份子集）。 */
const SUPPORTED = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** 深扫 schema：子集外关键字 / type 数组 / type:'null' / required 不在 properties。 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  const out: string[] = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} 不是对象`]
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持）`)
  else if (typeof type === 'string') {
    if (!TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型`)
    if (type === 'null') out.push(`${path}.type 是 null（DSH 不支持）`)
  } else if (node.oneOf === undefined) {
    out.push(`${path}.type 缺失`)
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  if (required !== undefined) {
    for (const key of required) {
      if (properties === undefined || !Object.hasOwn(properties, key)) {
        out.push(`${path}.required 里有未声明的键 ${key}`)
      }
    }
  }
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/** 深扫值里的 null 路径。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

test('output.schema 只用 DSH 子集；没有 type 数组 / type:null', () => {
  assert.deepEqual(schemaViolations(TOOL.output.schema), [])
  assert.deepEqual(schemaViolations(TOOL.parameters), [])
})

test('一个 ADVANCED 样例值满足 output.schema，且深扫无 null', () => {
  const sample = {
    tool: 'recruitment_application_stage_advance',
    contract_version: '1.1.0',
    application_id: APP_ID,
    stage_code: 'S7',
    record_version: 2,
    status: 'ADVANCED',
    transitions: [{ from: 'S6', to: 'S7' }],
    blockers: [],
    warnings: [],
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
  }
  assert.deepEqual(nullPaths(sample), [])
  // required 齐全 + 无未声明键（等价 additionalProperties:false 的本地检查）
  const schema = TOOL.output.schema as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  for (const key of schema.required as string[]) assert.ok(Object.hasOwn(sample, key), `缺 required 键 ${key}`)
  for (const key of Object.keys(sample)) assert.ok(Object.hasOwn(properties, key), `多余键 ${key}`)
})

test('BLOCKED 样例值（结构化 blocker/warning）满足 output.schema 且无 null', () => {
  const sample = {
    tool: 'recruitment_application_stage_advance',
    contract_version: '1.1.0',
    application_id: APP_ID,
    stage_code: 'S6',
    record_version: 1,
    status: 'BLOCKED',
    transitions: [],
    blockers: [{
      code: 'RUBRIC_NOT_PINNED',
      message: '先批 rubric',
      owner_role: 'JOB_HIRING_MANAGER',
      next_action_code: 'PIN_RUBRIC_VERSION',
      owner_actor_id: OWNER_ACTOR,
      owner_display_name: OWNER_NAME,
    }],
    warnings: [{
      code: 'STAGE_AHEAD',
      message: '不倒退',
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'VERIFY_STAGE_PROGRESSION',
    }],
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
  }
  assert.deepEqual(nullPaths(sample), [])
  const schema = TOOL.output.schema as Record<string, unknown>
  const properties = schema.properties as Record<string, unknown>
  for (const key of schema.required as string[]) assert.ok(Object.hasOwn(sample, key), `缺 required 键 ${key}`)
  for (const key of Object.keys(sample)) assert.ok(Object.hasOwn(properties, key), `多余键 ${key}`)
  // blocker/warning 的 required 里必须有结构化字段（防止"只加个 message"）
  const blockerSchema = (properties.blockers as Record<string, unknown>).items as Record<string, unknown>
  assert.deepEqual(blockerSchema.required, ['code', 'message', 'owner_role', 'next_action_code'])
  const warningSchema = (properties.warnings as Record<string, unknown>).items as Record<string, unknown>
  assert.deepEqual(warningSchema.required, ['code', 'message', 'owner_role', 'next_action_code'])
})

test('渲染：blocker/warning 的责任人 + 下一步都出现在模型可见文本里', () => {
  const text = (TOOL.output.render({}, {
    tool: 'recruitment_application_stage_advance',
    contract_version: '1.1.0',
    application_id: APP_ID,
    stage_code: 'S6',
    record_version: 1,
    status: 'BLOCKED',
    transitions: [],
    blockers: [{
      code: 'RUBRIC_NOT_PINNED',
      message: '先批 rubric',
      owner_role: 'JOB_HIRING_MANAGER',
      next_action_code: 'PIN_RUBRIC_VERSION',
      owner_actor_id: OWNER_ACTOR,
    }],
    warnings: [{
      code: 'STAGE_AHEAD',
      message: '不倒退',
      owner_role: 'RECRUITMENT_OWNER',
      next_action_code: 'VERIFY_STAGE_PROGRESSION',
    }],
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
  })[0]?.text ?? '')
  assert.match(text, /BLOCKED/)
  assert.match(text, /RUBRIC_NOT_PINNED \[owner=JOB_HIRING_MANAGER/)
  assert.match(text, /next=PIN_RUBRIC_VERSION: 先批 rubric/)
  assert.match(text, /STAGE_AHEAD \[owner=RECRUITMENT_OWNER/)
  assert.match(text, /next=VERIFY_STAGE_PROGRESSION/)
  assert.match(text, /不代表决策人/)
  assert.match(text, /provenance=FIXTURE trigger=MANUAL connection=NOT_CONNECTED/)
})

test('未配置替身：同一个工具名、调用即 NOT_CONFIGURED', async () => {
  const tool = unconfiguredStageAdvanceTool(['config.database.host is required'])
  assert.equal(tool.name, 'recruitment_application_stage_advance')
  assert.match(tool.description, /NOT CONFIGURED/)
  await assert.rejects(() => tool.execute({ application_id: APP_ID }, undefined), (error: Error & { code?: string }) => {
    assert.equal(error.code, 'NOT_CONFIGURED')
    return true
  })
  assert.match((tool.output.render({}, {})[0]?.text ?? ''), /not configured/)
})



