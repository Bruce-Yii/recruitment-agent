// D-141③（`docs/17`）：SCREENING 决策**同事务派生 S6→S7** 的真库集成测试。
//
// 被验的东西（裁决原文："人决定通过初筛"语义上已包含 S6→S7 迁移；改为
// `record_human_decision`（以及低层 `decision_record`）在 SCREENING ADVANCE/REJECT 时
// **同事务派生阶段迁移**（幂等），并保持既有闸门不放宽）：
//
//   A1 正例：S6 + record_human_decision(SCREENING, ADVANCE) → 申请 S7；独立 SQL 读回
//            decision 行 + `application.current_stage_code.changed` 事件（S6→S7，actor=真人）
//            + `decision.record` 事件；出参 `stage{ before:'S6', after:'S7', advanced:true }` 只来自
//            写后独立读回。
//   A2 幂等：同参数再调一次 → `ALREADY_DECIDED`（既有 STEP 3 闸门），decision/event 行数与
//            申请 record_version/阶段**完全不变**；域函数再派生一次 → `NO_OP`、零写入。
//   A3 REJECT：S6 + REJECT → decision(result=REJECT, stage_code=S7) 落库、申请到 S7；
//            **不出现 S7→S8 的迁移事件**（T2–T4 一条都不派生）、lifecycle_status 不变。
//   A4 已在 S7：ADVANCE → decision 落库、`stage.advanced=false`、阶段不动、零阶段事件（幂等 NO_OP）。
//   A5 负例（新派生闸门）：低层 `decision_record` 的决策闸门全过、但申请的 T1 事实缺口
//            （材料未绑定）→ `EVIDENCE_INSUFFICIENT(SCREENING_STAGE_NOT_ADVANCEABLE)`；
//            整个事务回滚：decision 行=0、事件=0、申请阶段/record_version 不变（无半状态）。
//   A6 负例（既有闸门不放宽）：rubric 未批准 → 和改前一样在组装/评估阶段失败
//            （`INVALID_ARGS(MISSING_SCREENING_EVALUATION)`），零写入。
//
// 纪律（与 test/integration/db.ts 同口径）：
//   * 独占一次性空库 `createIsolatedTestDatabase('decstage')`（不写 ra_s6s7），跑完 drop；
//   * 读回一律用**独立 SQL**（db.pool.query），不 import 任何产品读投影；
//   * 夹具必须真提交：工具自建连接池，看不到未提交行。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createRecordHumanDecisionTool } from '../../src/tools/record-human-decision.ts'
import { confirmationTextSha256, createDecisionRecordTool } from '../../src/tools/decision-record.ts'
import { deriveScreeningDecisionStage } from '../../src/domain/stage-advance.ts'
import { deriveApplicationNextStep, type ApplicationGateFacts } from '../../src/http/recruiting.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  criterion,
  errorBody,
  hex64,
  parsedFields,
  seedScenario,
  TENANT,
  HR_ACTOR,
  testDatabaseConfig,
  type IsolatedTestDatabase,
  type Scenario,
} from './db.ts'

/** 独立连接池的库配置（只把 database 换成一次性库）。 */
const BASE = testDatabaseConfig()

/** 判定数据：MUST_HAVE「有工作经历」+ DISQUALIFIER「不足 60 个月即排除」（Σweight=1）。 */
const WORK_EXISTS = criterion({
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.6,
  field: 'work_experience', operator: 'EXISTS', value: true,
})
const MONTHS_LTE60 = criterion({
  key: 'too_short', label: '不足 60 个月即排除', kind: 'DISQUALIFIER', weight: 0.4,
  field: 'timeline.covered_months_closed', operator: 'LTE', value: 60,
})
const DIMENSIONS = [WORK_EXISTS, MONTHS_LTE60]

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let high: ReturnType<typeof createRecordHumanDecisionTool>
let low: ReturnType<typeof createDecisionRecordTool>

/** 夹具（全部真提交）。 */
let s6Advance: Scenario
let s6Reject: Scenario
let s6NoMaterial: Scenario
let s6Unapproved: Scenario
let s7Already: Scenario

test.before(async () => {
  db = await createIsolatedTestDatabase('decstage')
  assertPrivateDatabase(db.name)
  assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
  cfg = { ...BASE, database: db.name }
  high = createRecordHumanDecisionTool({ database: cfg })
  low = createDecisionRecordTool({ database: cfg })

  await withCommittedFixture(async (client) => {
    const common = {
      dimensions: DIMENSIONS,
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    } as const
    s6Advance = await seedAtS6(client, common)
    s6Reject = await seedAtS6(client, common)
    s6NoMaterial = await seedAtS6(client, { ...common, bindMaterial: false })
    s7Already = await seedScenario(client, common)
    s6Unapproved = await seedAtS6(client, { ...common, approve: false })
  })
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

// ===========================================================================
//  A1 · 正例：SCREENING ADVANCE 在 S6 上同事务派生 S6→S7
// ===========================================================================

test('A1 SCREENING ADVANCE(S6) → 申请 S7 + decision + 阶段事件（独立 SQL 读回）', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s6Advance.applicationId)
  assert.equal(appBefore.current_stage_code, 'S6', '夹具必须停在 S6')

  const output = await high.execute({
    application_id: s6Advance.applicationId,
    decision_scope: 'SCREENING',
    result: 'ADVANCE',
    reason: 'work_exists 满足，推进到面试（集成测试 decision-stage）',
    human_confirmation: {
      confirmed_at: recentIso(),
      method: 'IN_CHAT',
      text: '我确认：这位候选人的初筛通过，可以进入面试。',
    },
  }, {}) as Record<string, unknown>

  assert.equal(output.tool, 'record_human_decision')
  assert.equal(output.status, 'OK')
  assert.equal(output.replayed, false)

  // ---- 独立 SQL 读回：申请阶段 / 版本 ----
  const appAfter = await appFacts(s6Advance.applicationId)
  assert.equal(appAfter.current_stage_code, 'S7', 'D-141③：SCREENING 决策必须同事务把 S6→S7')
  assert.equal(appAfter.record_version, appBefore.record_version + 1, '只派生 T1 一条边 ⇒ record_version 恰好 +1')

  // 出参 stage 必须与库一致（不是回显自述）；ADVANCE 不动生命周期。
  const stage = output.stage as Record<string, unknown>
  assert.deepEqual(stage, {
    before: 'S6',
    after: 'S7',
    advanced: true,
    record_version: appAfter.record_version,
    lifecycle_before: 'ACTIVE',
    lifecycle_after: 'ACTIVE',
  })
  assert.equal(appAfter.lifecycle_status, 'ACTIVE', 'ADVANCE 不改生命周期')

  // ---- 独立 SQL 读回：decision 行 ----
  const decisions = await decisionsFor(s6Advance.applicationId, 'SCREENING')
  assert.equal(decisions.length, 1, '必须恰好 1 条 SCREENING 决策')
  const decision = decisions[0]!
  assert.equal(decision.decision_scope, 'SCREENING')
  assert.equal(decision.result, 'ADVANCE')
  assert.equal(decision.stage_code, 'S7')
  assert.equal(decision.actor_id, HR_ACTOR, 'decided_by_actor_id 必须是真实人 actor')
  assert.equal(decision.record_version, 1)

  // ---- 独立 SQL 读回：decision.record 事件 ----
  const decisionEvents = await eventsOfType('decision.record', decision.decision_id)
  assert.equal(decisionEvents.length, 1, 'decision.record 事件恰好 1 条')
  assert.equal(decisionEvents[0]!.payload.result, 'ADVANCE')

  // ---- 独立 SQL 读回：阶段迁移事件（复用 stage_advance 的既有事件路径）----
  const stageEvents = await stageEventsOf(s6Advance.applicationId)
  const s6ToS7 = stageEvents.filter((event) => event.payload.from === 'S6' && event.payload.to === 'S7')
  assert.equal(s6ToS7.length, 1, 'S6→S7 阶段事件必须恰好 1 条（触发器写，不另写第二套）')
  assert.equal(s6ToS7[0]!.payload.actor_id, HR_ACTOR, '阶段事件的 actor 必须是真实人（不是执行账号以外的谁）')
  assert.equal(s6ToS7[0]!.provider, 'internal')
  assert.equal(s6ToS7[0]!.trust_level, 'INTERNAL')

  // 触发器回填的审计列
  const audit = await query<{ stage_changed_by_actor_id: string | null; stage_source_event_id: string | null }>(
    `select stage_changed_by_actor_id::text as stage_changed_by_actor_id,
            stage_source_event_id::text   as stage_source_event_id
       from recruitment.application
      where tenant_id = $1::uuid and id = $2::uuid`,
    [TENANT, s6Advance.applicationId],
  )
  assert.equal(audit[0]?.stage_changed_by_actor_id, HR_ACTOR)
  assert.equal(audit[0]?.stage_source_event_id, s6ToS7[0]!.event_id)

  // 行数账：+1 decision、+2 event（decision.record + 阶段迁移）
  const after = await counts()
  assert.equal(after.decisions, before.decisions + 1)
  assert.equal(after.events, before.events + 2)

  t.diagnostic(`A1 stage=S7 decision=${decision.decision_id} stage_event=${s6ToS7[0]!.event_id} actor=${HR_ACTOR}`)
})

// ===========================================================================
//  A2 · 幂等：重复调用不产生第二次迁移 / 不多写事件
// ===========================================================================

test('A2 同参数再调一次 → ALREADY_DECIDED；行数/版本/阶段完全不变；域派生 NO_OP', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s6Advance.applicationId)
  assert.equal(appBefore.current_stage_code, 'S7')

  await assert.rejects(
    high.execute({
      application_id: s6Advance.applicationId,
      decision_scope: 'SCREENING',
      result: 'ADVANCE',
      reason: 'work_exists 满足，推进到面试（集成测试 decision-stage 重复调用）',
      human_confirmation: {
        confirmed_at: recentIso(),
        method: 'IN_CHAT',
        text: '我确认：这位候选人的初筛通过，可以进入面试。',
      },
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'ALREADY_DECIDED', `第二次调用必须被既有 STEP 3 闸门挡住：${JSON.stringify(body)}`)
      assert.equal(body.reason_code, 'SCOPE_ALREADY_DECIDED')
      return true
    },
  )

  assert.deepEqual(await counts(), before, '重复调用不得新增 decision / event 行')
  assert.deepEqual(await appFacts(s6Advance.applicationId), appBefore, '重复调用不得再次迁移阶段/涨版本')
  assert.equal((await stageEventsOf(s6Advance.applicationId)).filter(
    (event) => event.payload.from === 'S6' && event.payload.to === 'S7',
  ).length, 1, 'S6→S7 事件仍然只有 1 条')

  // 域函数层面也幂等：已在 S7 → NO_OP、零 UPDATE、零事件。
  const derived = await inTx(async (client) => deriveScreeningDecisionStage(client, {
    tenantId: TENANT,
    applicationId: s6Advance.applicationId,
  }))
  assert.equal(derived.status, 'NO_OP')
  assert.deepEqual(derived.transitions, [])
  assert.equal(derived.stage_code, 'S7')
  assert.deepEqual(await appFacts(s6Advance.applicationId), appBefore)

  t.diagnostic(`A2 幂等：decision/event 行数=${before.decisions}/${before.events}，stage=S7，record_version=${appBefore.record_version}`)
})

// ===========================================================================
//  A3 · REJECT：决策 + 阶段派生 S7 + lifecycle ACTIVE→CLOSED（同一事务；2026-11-16 lead 收窄裁定）
// ===========================================================================

test('A3 SCREENING REJECT(S6) → decision(REJECT,S7) + 申请 S7 + lifecycle CLOSED；无 S7→S8；再调一次不变', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s6Reject.applicationId)
  assert.equal(appBefore.current_stage_code, 'S6')
  assert.equal(appBefore.lifecycle_status, 'ACTIVE')
  const stageEventsBefore = await stageEventsOf(s6Reject.applicationId)
  const lifecycleEventsBefore = await lifecycleEventsOf(s6Reject.applicationId)

  const output = await high.execute({
    application_id: s6Reject.applicationId,
    decision_scope: 'SCREENING',
    result: 'REJECT',
    reason: 'too_short 不满足：工作年限证据不足（集成测试 decision-stage REJECT）',
    human_confirmation: {
      confirmed_at: recentIso(),
      method: 'IN_CHAT',
      text: '我确认：这位候选人初筛不通过，流程到此为止。',
    },
  }, {}) as Record<string, unknown>

  assert.equal(output.status, 'OK')

  // ---- 决策行（REJECT / stage_code=S7 / 真实人）----
  const decisions = await decisionsFor(s6Reject.applicationId, 'SCREENING')
  assert.equal(decisions.length, 1, 'REJECT 也必须落 decision 行')
  const decision = decisions[0]!
  assert.equal(decision.result, 'REJECT')
  assert.equal(decision.stage_code, 'S7', 'decision 行的 stage_code 由 scope 写死 S7（既有语义）')
  assert.equal(decision.actor_id, HR_ACTOR)

  // ---- 硬断言（2026-11-16 lead 收窄裁定）：阶段 S7 + lifecycle CLOSED ----
  const appAfter = await appFacts(s6Reject.applicationId)
  assert.equal(appAfter.current_stage_code, 'S7', 'D-141③：REJECT 同事务派生 S6→S7')
  assert.equal(appAfter.lifecycle_status, 'CLOSED', 'REJECT = 这条申请结束：lifecycle ACTIVE→CLOSED（既有 CLOSED）')
  assert.equal(appAfter.record_version, appBefore.record_version + 2, '阶段 +1、生命周期 +1 ⇒ record_version 恰好 +2')

  const stage = output.stage as Record<string, unknown>
  assert.deepEqual(stage, {
    before: 'S6',
    after: 'S7',
    advanced: true,
    record_version: appAfter.record_version,
    lifecycle_before: 'ACTIVE',
    lifecycle_after: 'CLOSED',
  })

  // ---- 阶段事件：恰好一条 S6→S7，且没有被顺带推到 S8/S9/S10 ----
  // （夹具把申请从 seed 的 S7 拖回 S6，本身产生一条 S7→S6 的夹具事件，必须按 from/to 精确过滤。）
  const stageEvents = await stageEventsOf(s6Reject.applicationId)
  const s6ToS7 = stageEvents.filter((event) => event.payload.from === 'S6' && event.payload.to === 'S7')
  assert.equal(s6ToS7.length, 1, 'REJECT 决策派生恰好一条 S6→S7')
  const s7ToS8 = stageEvents.filter((event) => event.payload.from === 'S7' && event.payload.to === 'S8')
  const beyondS7 = stageEvents.filter((event) => ['S8', 'S9', 'S10'].includes(String(event.payload.to)))
  assert.deepEqual(s7ToS8, [], 'REJECT 不得把申请从 S7 再推到 S8（T2 的既有闸门：result≠ADVANCE → BLOCKED）')
  assert.deepEqual(beyondS7, [], 'REJECT 不得产生任何 S8/S9/S10 的迁移')

  // ---- 生命周期事件：恰好一条 ACTIVE→CLOSED，actor=真实人（既有事件类型，不新发类型）----
  const lifecycleEvents = await lifecycleEventsOf(s6Reject.applicationId)
  const newLifecycleEvents = lifecycleEvents.slice(lifecycleEventsBefore.length)
  assert.equal(newLifecycleEvents.length, 1, '生命周期收口恰好写 1 条 application.lifecycle_status.changed')
  assert.equal(newLifecycleEvents[0]!.payload.from, 'ACTIVE')
  assert.equal(newLifecycleEvents[0]!.payload.to, 'CLOSED')
  assert.equal(newLifecycleEvents[0]!.payload.actor_id, HR_ACTOR)
  const lifecycleAudit = await query<{
    status_changed_by_actor_id: string | null
    status_source_event_id: string | null
  }>(
    `select status_changed_by_actor_id::text as status_changed_by_actor_id,
            status_source_event_id::text   as status_source_event_id
       from recruitment.application
      where tenant_id = $1::uuid and id = $2::uuid`,
    [TENANT, s6Reject.applicationId],
  )
  assert.equal(lifecycleAudit[0]?.status_changed_by_actor_id, HR_ACTOR)
  assert.equal(lifecycleAudit[0]?.status_source_event_id, newLifecycleEvents[0]!.event_id)

  // ---- 行数账：+1 decision、+3 event（decision.record + 阶段 + 生命周期）----
  const after = await counts()
  assert.equal(after.decisions, before.decisions + 1)
  assert.equal(after.events, before.events + 3)
  assert.equal(stageEvents.length, stageEventsBefore.length + 1)

  // ---- 幂等：再调一次 → ALREADY_DECIDED；lifecycle/阶段/行数完全不变 ----
  const appAfterFirst = await appFacts(s6Reject.applicationId)
  const countsAfterFirst = await counts()
  await assert.rejects(
    high.execute({
      application_id: s6Reject.applicationId,
      decision_scope: 'SCREENING',
      result: 'REJECT',
      reason: 'too_short 不满足：工作年限证据不足（集成测试 decision-stage REJECT · 重复调用）',
      human_confirmation: {
        confirmed_at: recentIso(),
        method: 'IN_CHAT',
        text: '我确认：这位候选人初筛不通过，流程到此为止。',
      },
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'ALREADY_DECIDED')
      assert.equal(body.reason_code, 'SCOPE_ALREADY_DECIDED')
      return true
    },
  )
  assert.deepEqual(await appFacts(s6Reject.applicationId), appAfterFirst, '重复调用不得再改 stage/lifecycle/版本')
  assert.deepEqual(await counts(), countsAfterFirst, '重复调用不得新增 decision/event 行')
  assert.equal((await lifecycleEventsOf(s6Reject.applicationId)).length, lifecycleEventsBefore.length + 1,
    '生命周期事件仍然只有本次 1 条')

  t.diagnostic(
    `A3 REJECT decision=${decision.decision_id} stage=${appAfter.current_stage_code} `
    + `lifecycle=${appAfter.lifecycle_status} record_version=${appAfter.record_version}`,
  )
})

// ===========================================================================
//  A4 · 已在 S7：决策落库、阶段不动（幂等 NO_OP）
// ===========================================================================

test('A4 SCREENING ADVANCE 已在 S7 → decision 落库、stage.advanced=false、零阶段事件', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s7Already.applicationId)
  assert.equal(appBefore.current_stage_code, 'S7')

  const output = await high.execute({
    application_id: s7Already.applicationId,
    decision_scope: 'SCREENING',
    result: 'ADVANCE',
    reason: 'work_exists 满足，推进下一轮（集成测试 decision-stage 已在 S7）',
    human_confirmation: {
      confirmed_at: recentIso(),
      method: 'IN_CHAT',
      text: '我确认：这位候选人的初筛通过。',
    },
  }, {}) as Record<string, unknown>

  assert.equal(output.status, 'OK')
  assert.deepEqual(output.stage, {
    before: 'S7',
    after: 'S7',
    advanced: false,
    record_version: appBefore.record_version,
    lifecycle_before: 'ACTIVE',
    lifecycle_after: 'ACTIVE',
  })
  assert.deepEqual(await appFacts(s7Already.applicationId), appBefore, '已在 S7 时派生是 NO_OP：阶段/版本不动')
  assert.equal((await stageEventsOf(s7Already.applicationId)).length, 0, '已有 S7 的申请这次调用不产生阶段事件')
  const after = await counts()
  assert.equal(after.decisions, before.decisions + 1, '决策本身仍然要落库')
  assert.equal(after.events, before.events + 1, '只多 decision.record 事件（没有阶段迁移事件）')

  t.diagnostic(`A4 已在 S7：decision 落库、advanced=false、record_version=${appBefore.record_version}`)
})

// ===========================================================================
//  A5 · 负例：决策闸门全过、但 T1 事实缺口 → 整体回滚（新派生闸门，零写入）
// ===========================================================================

test('A5 低层 decision_record：材料未绑定 → EVIDENCE_INSUFFICIENT(SCREENING_STAGE_NOT_ADVANCEABLE)，零写入', async (t) => {
  const scenario = s6NoMaterial
  const before = await counts()
  const appBefore = await appFacts(scenario.applicationId)
  assert.equal(appBefore.current_stage_code, 'S6')
  // 夹具把申请从 seed 的 S7 拖回 S6（产生一条 S7→S6 夹具事件）；这里只要求**没有 S6→S7**。
  const stageEventsBefore = await stageEventsOf(scenario.applicationId)
  assert.equal(
    stageEventsBefore.filter((event) => event.payload.from === 'S6' && event.payload.to === 'S7').length,
    0,
  )

  const facts = await pinnedFacts(scenario.applicationId)
  const resume = await query<{ id: string; content_sha256: string }>(
    `select id::text as id, content_sha256 from recruitment.resume_version
      where tenant_id = $1::uuid and id = $2::uuid`,
    [TENANT, scenario.resumeVersionId],
  )
  const resumeRow = resume[0]
  assert.ok(resumeRow !== undefined, '夹具必须有材料版本行（只是没绑到申请上）')

  const reason = 'work_exists 满足（集成测试：低层负例，材料未绑定）'
  const confirmedAt = new Date(Date.now() - 60_000).toISOString()
  const confirmationText = '我确认：这位候选人初筛通过（材料未绑定的负例）。'
  const basis = [
    {
      kind: 'SCREENING_EVALUATION',
      evaluation_digest: hex64(`eval:${scenario.applicationId}`),
      verdict: 'PASS',
      rubric_version_id: scenario.rubricId,
      rubric_payload_hash: facts.rubric_payload_hash,
      resume_version_id: resumeRow.id,
      resume_content_sha256: resumeRow.content_sha256,
    },
    { kind: 'RUBRIC_VERSION', id: scenario.rubricId, version_no: 1, payload_hash: facts.rubric_payload_hash },
    { kind: 'AUTHORITY', actor_id: HR_ACTOR, is_hiring_manager: false },
  ]
  const args = {
    application_id: scenario.applicationId,
    decision_scope: 'SCREENING',
    as_of: new Date().toISOString(),
    result: 'ADVANCE',
    reason,
    basis_refs: basis,
    human_confirmation: {
      confirmed_by_actor_id: HR_ACTOR,
      confirmed_at: confirmedAt,
      confirmation_method: 'IN_CHAT',
      confirmation_text: confirmationText,
      confirmation_text_sha256: confirmationTextSha256({
        result: 'ADVANCE',
        reason,
        override_rationale: null,
        basis_refs: basis,
        confirmation_text: confirmationText,
        confirmed_by_actor_id: HR_ACTOR,
        confirmed_at: confirmedAt,
      }),
    },
  }

  await assert.rejects(low.execute(args, {}), (error: unknown) => {
    const body = errorBody(error)
    assert.equal(body.code, 'EVIDENCE_INSUFFICIENT', `必须是派生阶段的 fail-closed：${JSON.stringify(body)}`)
    assert.equal(body.reason_code, 'SCREENING_STAGE_NOT_ADVANCEABLE')
    const detail = body.detail as Record<string, unknown>
    const blockers = detail.blockers as Array<Record<string, unknown>>
    assert.ok(Array.isArray(blockers) && blockers.some((blocker) => blocker.code === 'MATERIAL_NOT_LINKED'))
    return true
  })

  // 零写入：decision=0、事件=0、申请阶段/版本不变（没有"决策落了、阶段没动"的半状态）
  assert.deepEqual(await counts(), before, '派生失败必须整体回滚：decision / event 行数不变')
  assert.deepEqual(await appFacts(scenario.applicationId), appBefore, '申请阶段 / record_version 不变')
  assert.equal((await decisionsFor(scenario.applicationId, 'SCREENING')).length, 0, '不得留下 decision 行')
  const stageEventsAfter = await stageEventsOf(scenario.applicationId)
  assert.equal(
    stageEventsAfter.filter((event) => event.payload.from === 'S6' && event.payload.to === 'S7').length,
    0,
    '不得留下 S6→S7 阶段事件',
  )
  assert.equal(stageEventsAfter.length, stageEventsBefore.length, '不得新增任何阶段事件')

  t.diagnostic('A5 零写入：decision=0 event=0 stage=S6 record_version 不变')
})

// ===========================================================================
//  A6 · 负例：既有闸门不放宽（rubric 未批准 → 仍按改前失败、零写入）
// ===========================================================================

test('A6 rubric 未批准 → 既有闸门仍先失败（MISSING_SCREENING_EVALUATION），零写入', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s6Unapproved.applicationId)
  const stageEventsBefore = await stageEventsOf(s6Unapproved.applicationId)

  await assert.rejects(
    high.execute({
      application_id: s6Unapproved.applicationId,
      decision_scope: 'SCREENING',
      result: 'ADVANCE',
      reason: 'work_exists 满足（集成测试：rubric 未批准负例）',
      human_confirmation: {
        confirmed_at: recentIso(),
        method: 'IN_CHAT',
        text: '我确认：这位候选人的初筛通过。',
      },
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS', `既有闸门必须先失败：${JSON.stringify(body)}`)
      assert.equal(body.reason_code, 'MISSING_SCREENING_EVALUATION')
      return true
    },
  )

  assert.deepEqual(await counts(), before, 'rubric 未批准必须零写入')
  assert.deepEqual(await appFacts(s6Unapproved.applicationId), appBefore)
  assert.equal((await decisionsFor(s6Unapproved.applicationId, 'SCREENING')).length, 0)
  const stageEventsAfter = await stageEventsOf(s6Unapproved.applicationId)
  assert.equal(
    stageEventsAfter.filter((event) => event.payload.from === 'S6' && event.payload.to === 'S7').length,
    0,
    '既有闸门失败时不得派生 S6→S7',
  )
  assert.equal(stageEventsAfter.length, stageEventsBefore.length, '不得新增任何阶段事件')

  t.diagnostic('A6 既有闸门未放宽：rubric 未批准 → MISSING_SCREENING_EVALUATION、零写入')
})

// ===========================================================================
//  A7 · 负例：REJECT 被闸门拒绝时生命周期不得被改（整体回滚）
// ===========================================================================

test('A7 REJECT 被既有闸门拒绝（rubric 未批准）→ lifecycle 不得从 ACTIVE 被改，零写入', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s6Unapproved.applicationId)
  assert.equal(appBefore.lifecycle_status, 'ACTIVE')
  const lifecycleEventsBefore = await lifecycleEventsOf(s6Unapproved.applicationId)

  await assert.rejects(
    high.execute({
      application_id: s6Unapproved.applicationId,
      decision_scope: 'SCREENING',
      result: 'REJECT',
      reason: 'work_exists 不满足（集成测试：REJECT 被闸门拒绝的负例）',
      human_confirmation: {
        confirmed_at: recentIso(),
        method: 'IN_CHAT',
        text: '我确认：这位候选人初筛不通过。',
      },
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS', `既有闸门必须先失败：${JSON.stringify(body)}`)
      assert.equal(body.reason_code, 'MISSING_SCREENING_EVALUATION')
      return true
    },
  )

  assert.deepEqual(await counts(), before, '闸门拒绝必须零写入（decision/event 行数不变）')
  assert.deepEqual(await appFacts(s6Unapproved.applicationId), appBefore, 'lifecycle 不得被改（仍 ACTIVE）、阶段/版本不变')
  assert.equal((await decisionsFor(s6Unapproved.applicationId, 'SCREENING')).length, 0)
  assert.equal(
    (await lifecycleEventsOf(s6Unapproved.applicationId)).length,
    lifecycleEventsBefore.length,
    '不得写生命周期迁移事件',
  )

  t.diagnostic('A7 REJECT 被闸门拒绝：lifecycle 仍 ACTIVE、decision=0、事件=0')
})

// ===========================================================================
//  A8 · 工作台 next_step：REJECT 的申请不得再显示"安排面试"（2026-11-16 修）
// ===========================================================================

test('A8 deriveApplicationNextStep：current SCREENING=REJECT → CLOSED（不再 SCHEDULE_INTERVIEW）；ADVANCE 行为不变', () => {
  const base: ApplicationGateFacts = {
    lifecycle_status: 'ACTIVE',
    current_stage_code: 'S7',
    has_material: true,
    parse_status: 'PARSED',
    has_current_screening_decision: true,
    has_scheduled_interview: false,
    has_post_interview_scorecard_gap: false,
    has_current_stage_decision: false,
  }
  const rejected = deriveApplicationNextStep({ ...base, screening_decision_result: 'REJECT' })
  assert.equal(rejected.code, 'CLOSED', 'REJECT 的申请已结束：下一步不得是 SCHEDULE_INTERVIEW')
  assert.equal(rejected.kind, 'INFO')
  const advanced = deriveApplicationNextStep({ ...base, screening_decision_result: 'ADVANCE' })
  assert.equal(advanced.code, 'SCHEDULE_INTERVIEW', 'ADVANCE 的既有行为不变')
  // 历史数据兜底：decision 已 REJECT 但 lifecycle 仍 ACTIVE 的旧行同样归为 CLOSED。
  const legacy = deriveApplicationNextStep({
    ...base,
    lifecycle_status: 'ACTIVE',
    screening_decision_result: 'REJECT',
  })
  assert.equal(legacy.code, 'CLOSED')
})

// ===========================================================================
//  helper（全部独立 SQL）
// ===========================================================================

/** 在**真提交**事务里造夹具（ROLLBACK on error）。 */
async function withCommittedFixture<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 在必然回滚的事务里跑 `fn`（域函数需要事务 + actor，且不污染库）。 */
async function inTx<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    return await fn(client)
  } finally {
    await client.query('rollback').catch(() => {})
    client.release()
  }
}

/** 造一条停在 S6 的完整夹具（seedScenario 默认 S7；intake 新建的申请本来就是 S6）。 */
async function seedAtS6(
  client: DatabaseClient,
  input: Parameters<typeof seedScenario>[1],
): Promise<Scenario> {
  const scenario = await seedScenario(client, input)
  await client.query(
    "update recruitment.application set current_stage_code = 'S6' where tenant_id = $1 and id = $2",
    [TENANT, scenario.applicationId],
  )
  return scenario
}

/** 独立 SQL 读回。 */
async function query<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await db.pool.query<T>(sql, [...params])).rows
}

/** 目标表行数（幂等/零写入断言用）。 */
interface Counts {
  readonly decisions: number
  readonly events: number
}

async function counts(): Promise<Counts> {
  const rows = await query<Counts>(
    `select (select count(*)::int from recruitment.decision)    as decisions,
            (select count(*)::int from recruitment.event_inbox) as events`,
  )
  const row = rows[0]
  assert.ok(row !== undefined)
  return row
}

/** 申请状态事实（阶段 / 生命周期 / 版本）。 */
interface AppFacts {
  readonly current_stage_code: string
  readonly lifecycle_status: string
  readonly record_version: number
}

async function appFacts(applicationId: string): Promise<AppFacts> {
  const rows = await query<AppFacts>(
    `select current_stage_code, lifecycle_status, record_version
       from recruitment.application
      where id = $1::uuid and tenant_id = $2::uuid`,
    [applicationId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `申请 ${applicationId} 必须存在`)
  return row
}

/** 申请钉住的 rubric/材料事实（低层负例的 basis 构造用）。 */
interface PinnedFacts {
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly resume_version_id: string | null
}

async function pinnedFacts(applicationId: string): Promise<PinnedFacts> {
  const rows = await query<PinnedFacts>(
    `select a.rubric_version_id::text as rubric_version_id,
            rv.payload_hash           as rubric_payload_hash,
            a.resume_version_id::text as resume_version_id
       from recruitment.application a
       join recruitment.rubric_version rv
         on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
      where a.id = $1::uuid and a.tenant_id = $2::uuid`,
    [applicationId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, '申请钉住事实必须存在')
  return row
}

/** 一条 decision 行（独立 SQL 读回）。 */
interface DecisionRow {
  readonly decision_id: string
  readonly decision_scope: string
  readonly result: string
  readonly stage_code: string | null
  readonly actor_id: string
  readonly record_version: number
}

async function decisionsFor(applicationId: string, decisionScope: string): Promise<DecisionRow[]> {
  return await query<DecisionRow>(
    `select d.id::text                  as decision_id,
            d.decision_scope            as decision_scope,
            d.result                    as result,
            d.stage_code                as stage_code,
            d.decided_by_actor_id::text as actor_id,
            d.record_version            as record_version
       from recruitment.decision d
      where d.tenant_id = $1::uuid
        and d.application_id = $2::uuid
        and d.decision_scope = $3
      order by d.created_at asc, d.id asc`,
    [TENANT, applicationId, decisionScope],
  )
}

/** 事件行（独立 SQL 读回）。 */
interface EventRow {
  readonly event_id: string
  readonly provider: string
  readonly trust_level: string
  readonly payload: Record<string, unknown>
}

async function eventsOfType(eventType: string, sourceObjectId: string): Promise<EventRow[]> {
  return await query<EventRow>(
    `select event_id::text as event_id, provider, trust_level, payload
       from recruitment.event_inbox
      where tenant_id = $1::uuid and event_type = $2 and source_object_id = $3
      order by recorded_at asc, event_id asc`,
    [TENANT, eventType, sourceObjectId],
  )
}

/** 该申请的全部阶段迁移事件（`application.current_stage_code.changed`）。 */
async function stageEventsOf(applicationId: string): Promise<EventRow[]> {
  return await eventsOfType('application.current_stage_code.changed', applicationId)
}

/** 该申请的全部生命周期迁移事件（`application.lifecycle_status.changed`；既有事件类型）。 */
async function lifecycleEventsOf(applicationId: string): Promise<EventRow[]> {
  return await eventsOfType('application.lifecycle_status.changed', applicationId)
}

/** 最近且不晚于服务端 now 的确认时间（IN_CHAT 的 confirmed_at 不能在未来）。 */
function recentIso(): string {
  return new Date(Date.now() - 30_000).toISOString()
}
