// 阶段推进（D-A 修复）× 真实 PostgreSQL（ra_s6s7）：证明 S8→S9→S10 **真的能推进**，
// 并且 `application.current_stage_code` 读回是 S10。
//
// 背景（不是"跑通了所以加个测试"，而是一条已实测确认的范围缺口）：
//   Golden Path 跑完 S10（`decisions` 里已有 `STAGE/S10/ADVANCE`、`scorecards=2`、
//   `transcript_artifact=1`、`interview_record=1`）之后，`application.current_stage_code`
//   仍是 S8；梯子只有 S6→S7→S8 两条边（`src/domain/stage-advance.ts` 的 LADDER）。
//   本文件用真库证明补完 S8→S9（T3）与 S9→S10（T4）之后，同一个终态形状能读回 **S10**。
//
// 每条断言都**读库回验**，不信函数返回值自述：
//   A12 S8→S9 正向 + "材料未齐时停在 S9" + 补材料后 S9→S10；终态读回 current_stage_code='S10'。
//   A13 S8→S9→S10 一次调用两跳（Golden Path 终态形状：面试已执行 + canonical READY 转写 +
//       interview_record(NEEDS_REVIEW/UNVERIFIED) + decision(STAGE/S10/ADVANCE)）→ 读回 S10。
//   A14 负例：面试全部取消/未到场 → BLOCKED(INTERVIEW_NOT_COMPLETED)，零写入。
//   A15 负例：转写取不回来（AUTH_REQUIRED）→ BLOCKED(TRANSCRIPT_NOT_READY)，零写入。
//   A16 只读阻塞视图（真库）：S8 等排期 / S9 等材料 / S10 终态 的 next_action 正确，且只发读语句。
//
// 事务纪律（沿用 test/integration/db.ts）：
//   * 每个用例都在 `inRolledBackTx`（REPEATABLE READ）里跑，结束一律 ROLLBACK ——
//     `ra_s6s7` 是共享演示库，本文件**不提交任何行**；
//   * 夹具直接用 SQL 造（工具端点不提供造夹具入口）：interview / meeting / meeting_binding /
//     transcript_artifact / interview_record 都是"已经发生的事实"，与 Golden Path 的真实形状一致。
import test from 'node:test'
import assert from 'node:assert/strict'

import { advanceApplicationStage, readStageBlockedView } from '../../src/domain/stage-advance.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  HR_ACTOR,
  inRolledBackTx,
  one,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 一份合法的 rubric 维度（payload_hash 由 seedScenario 用 digestOf 算）。 */
const DIMS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/** 面试执行的事实源（`interview.status` 的 8 值封闭集）。 */
type InterviewStatus = 'SCHEDULED' | 'IN_PROGRESS' | 'POST_INTERVIEW' | 'EVALUATION_READY'
  | 'DECIDED' | 'RESCHEDULED' | 'CANCELLED' | 'NO_SHOW'

/** 转写产物的平台状态（`transcript_status` 的 8 值封闭集）。 */
type TranscriptStatus = 'DISCOVERED' | 'FETCHING' | 'PARTIAL' | 'READY'
  | 'WAITING_EXTERNAL' | 'RETRYABLE_FAILED' | 'AUTH_REQUIRED' | 'NEEDS_LINKING'

/** 造好的一条"面试 + 会议 + 绑定"链路。 */
interface InterviewChain {
  readonly interviewId: string
  readonly meetingId: string
  readonly bindingId: string
}

/** 读一条申请的完整快照（断言只看库里的值）。 */
interface AppSnapshot {
  current_stage_code: string
  record_version: number
  stage_entered_at: Date
  created_at: Date
  stage_source_event_id: string | null
}

/**
 * 读申请快照。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 快照（不存在则抛）。
 */
async function readApp(client: DatabaseClient, applicationId: string): Promise<AppSnapshot> {
  const { rows } = await client.query<AppSnapshot>(
    `select current_stage_code, record_version, stage_entered_at, created_at, stage_source_event_id
       from recruitment.application
      where tenant_id = $1 and id = $2`,
    [TENANT, applicationId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`application ${applicationId} 不存在`)
  return row
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

/** 一条阶段变更事件（库里真实的那条）。 */
interface StageEventRow {
  event_id: string
  payload: { from: string; to: string; actor_id: string; record_id: string }
}

/**
 * 读这条申请的全部阶段变更事件（`fn_row_guard` 写的，不是测试写的）。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 事件（按 from/to 过滤由调用方做）。
 */
async function stageChangeEvents(client: DatabaseClient, applicationId: string): Promise<StageEventRow[]> {
  const { rows } = await client.query<StageEventRow>(
    `select event_id, payload
       from recruitment.event_inbox
      where tenant_id = $1
        and event_type = 'application.current_stage_code.changed'
        and source_object_id = $2`,
    [TENANT, applicationId],
  )
  return rows
}

/**
 * 造一条面试 + 一场会议 + 一条有效绑定（S8/S9 的真实形状：先有会议才有转写）。
 *
 * `interview.status` 在 `IN_PROGRESS` 之后的状态要求 `scheduled_start_at` 非空
 * （`ck_interview_scheduled`），所以这里总是给一个已过去的时间。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @param status - 面试状态（默认 IN_PROGRESS = 会议已经开始）。
 * @param options - `roundNo` / `slotCode` 让同一申请可以有多场面试。
 * @returns 链路的三个 id。
 */
async function insertInterviewChain(
  client: DatabaseClient,
  applicationId: string,
  status: InterviewStatus = 'IN_PROGRESS',
  options: { roundNo?: number; slotCode?: string } = {},
): Promise<InterviewChain> {
  const suffix = uniqueSuffix()
  const roundNo = options.roundNo ?? 1
  const slotCode = options.slotCode ?? 'DEFAULT'
  const interviewId = await one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at)
      values ($1, $2, $3, $4, $5, now() - interval '2 hours', now() - interval '1 hour') returning id`, [
    TENANT, applicationId, roundNo, slotCode, status,
  ])
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, external_meeting_id, meeting_role)
      values ($1, 'SYNTHETIC_DEMO', $2, 'PRIMARY') returning id`, [
    TENANT, `synthetic-meeting-${suffix}`,
  ])
  const bindingId = await one(client, `insert into recruitment.meeting_binding
      (tenant_id, meeting_id, interview_id, binding_method)
      values ($1, $2, $3, 'SCHEDULED') returning id`, [
    TENANT, meetingId, interviewId,
  ])
  return { interviewId, meetingId, bindingId }
}

/**
 * 往一场会议里插一条转写产物（材料获取的真实形状）。
 *
 * `READY` 必须 `is_complete=true` 且 `content_sha256` 非空（`ck_transcript_artifact_ready`）；
 * 非 READY 的失败态也必须带原文（`ck_transcript_artifact_content` 只给 5 个"待取"状态开洞）。
 * @param client - 事务内连接。
 * @param meetingId - 会议 id。
 * @param status - `transcript_status`。
 * @param isCanonical - 是否本轮唯一的 canonical 版本。
 * @returns 产物 id。
 */
async function insertTranscriptArtifact(
  client: DatabaseClient,
  meetingId: string,
  status: TranscriptStatus,
  isCanonical: boolean,
): Promise<string> {
  const suffix = uniqueSuffix()
  const ready = status === 'READY'
  return await one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type,
       transcript_status, provenance, trigger_mode, connection_state,
       content_sha256, raw_text, is_complete, is_canonical, canonical_selected_by_actor_id)
      values ($1, $2, 'SYNTHETIC_DEMO', $3, 1, 'ORIGINAL',
              $4, 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
              $5, $6, $7, $8, $9) returning id`, [
    TENANT,
    meetingId,
    `artifact-${suffix}`,
    status,
    ready ? 'a'.repeat(64) : null,
    '集成测试：合成转写原文（不含 PII）',
    ready,
    isCanonical,
    isCanonical ? HR_ACTOR : null,
  ])
}

/**
 * 插一条 `interview_record`（Golden Path 的真实形状：`NEEDS_REVIEW` / `UNVERIFIED`）。
 *
 * 故意用**未就绪**的记录：D-B 说 v1.0 没有把 record 转 `VERIFIED` 的产品入口，
 * 所以它**不能**是 S9→S10 的闸门（否则阶段永远到不了 S10）。
 * @param client - 事务内连接。
 * @param interviewId - 面试 id。
 * @param artifactId - 转写产物 id。
 * @param rubricVersionId - rubric 版本 id（`fk_interview_record_rubric`）。
 * @returns 记录 id。
 */
async function insertInterviewRecord(
  client: DatabaseClient,
  interviewId: string,
  artifactId: string,
  rubricVersionId: string,
): Promise<string> {
  return await one(client, `insert into recruitment.interview_record
      (tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
       schema_version, prompt_version, model_id, status, verification_status, sections,
       evidence_ok, chunk_coverage, is_current, status_changed_by_actor_id)
      values ($1, $2, $3, 1, $4, 1, 'integration-test', 'synthetic', 'NEEDS_REVIEW', 'UNVERIFIED',
              '{}'::jsonb, false, 1.0, true, $5) returning id`, [
    TENANT, interviewId, artifactId, rubricVersionId, HR_ACTOR,
  ])
}

/**
 * 插一条 current 的 S10 正式决策（Golden Path HOP 15 的真实形状）。
 *
 * 它证明本命令**不**用决策行来推导阶段（T4 的闸门是材料），也不会因为决策已落库而 NO_OP。
 * @param client - 事务内连接。
 * @param applicationId - 申请 id。
 * @returns 决策 id。
 */
async function insertStageDecision(client: DatabaseClient, applicationId: string): Promise<string> {
  return await one(client, `insert into recruitment.decision
      (tenant_id, application_id, decision_scope, stage_code, result,
       decided_by_actor_id, reason, basis_refs)
      values ($1, $2, 'STAGE', 'S10', 'ADVANCE', $3, $4, '[]'::jsonb) returning id`, [
    TENANT, applicationId, HR_ACTOR,
    '集成测试：人做出的 S10 决策 result=ADVANCE（Golden Path 终态形状）',
  ])
}

/**
 * 造"申请停在 S8"的夹具：默认 rubric 已钉、材料已绑（S6/S7 的事实已成立，只剩面试这一段）。
 * @param client - 事务内连接。
 * @returns `seedScenario` 的 id 集合（applicationId / rubricId 等）。
 */
async function seedAtS8(
  client: DatabaseClient,
): Promise<Awaited<ReturnType<typeof seedScenario>>> {
  const scenario = await seedScenario(client, { dimensions: DIMS })
  await setStage(client, scenario.applicationId, 'S8')
  return scenario
}

// =====================================================================
//  A12 · S8 → S9（面试已发生）+ 材料未齐时停在 S9 + 材料齐后 S9 → S10
// =====================================================================

test('A12 S8→S9：面试已开始（IN_PROGRESS）→ 真库推进到 S9；材料未齐 NO_OP；补 canonical READY 后 S9→S10，读回 S10', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS8(client)
    const chain = await insertInterviewChain(client, scenario.applicationId, 'IN_PROGRESS')
    const before = await readApp(client, scenario.applicationId)
    // 夹具把申请拖到 S8 时 `fn_row_guard` 已经写过一条 S7→S8 事件；下面只比较**本次推进新增**的事件。
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    // ---- 第一跳：S8 → S9（T3 的事实 = 会议已经开始）----
    const first = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(first.status, 'ADVANCED')
    assert.equal(first.stage_code, 'S9')
    assert.deepEqual(first.transitions, [{ from: 'S8', to: 'S9' }])
    assert.deepEqual(first.blockers, [], 'T3 通过、T4 只是 WAIT（还没有材料）→ 不是 blocker')

    const afterFirst = await readApp(client, scenario.applicationId)
    assert.equal(afterFirst.current_stage_code, 'S9', '库里的阶段必须真的变成 S9')
    assert.equal(afterFirst.record_version, before.record_version + 1, '一条 UPDATE ⇒ 版本恰好 +1')
    assert.equal(first.record_version, afterFirst.record_version)
    assert.ok(
      afterFirst.stage_entered_at.getTime() > afterFirst.created_at.getTime(),
      'stage_entered_at > created_at（本仓既有缺陷的兜底）',
    )
    const eventsAfterFirst = await stageChangeEvents(client, scenario.applicationId)
    const appliedEvent = eventsAfterFirst.find((e) => e.payload.from === 'S8' && e.payload.to === 'S9')
    assert.ok(appliedEvent !== undefined, '必须真的写了一条 S8→S9 阶段事件')
    assert.equal(afterFirst.stage_source_event_id, appliedEvent.event_id, 'stage_source_event_id 由触发器回填')

    // ---- 停在 S9：还没有材料（T4 WAIT）→ NO_OP、零 UPDATE ----
    const second = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(second.status, 'NO_OP', '材料还没到手 ≠ 被挡住')
    assert.deepEqual(second.transitions, [])
    assert.deepEqual(second.blockers, [])
    assert.equal(second.stage_code, 'S9')
    const afterSecond = await readApp(client, scenario.applicationId)
    assert.equal(afterSecond.record_version, afterFirst.record_version, 'NO_OP 不许发 UPDATE')
    assert.equal(
      (await stageChangeEvents(client, scenario.applicationId)).length,
      eventsAfterFirst.length,
      'NO_OP 不许产生事件',
    )

    // ---- 材料到手（canonical READY）：S9 → S10 ----
    const artifactId = await insertTranscriptArtifact(client, chain.meetingId, 'READY', true)
    await insertInterviewRecord(client, chain.interviewId, artifactId, scenario.rubricId)

    const third = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(third.status, 'ADVANCED')
    assert.equal(third.stage_code, 'S10')
    assert.deepEqual(third.transitions, [{ from: 'S9', to: 'S10' }])

    // **本用例的核心断言**：读回的阶段码必须是 S10（D-A 的缺陷就是这里读回 S8）。
    const final = await readApp(client, scenario.applicationId)
    assert.equal(final.current_stage_code, 'S10', '终态读回：application.current_stage_code = S10')
    assert.equal(final.record_version, before.record_version + 2, '两跳 ⇒ 版本 +2')
    assert.ok(
      final.stage_entered_at.getTime() > afterFirst.stage_entered_at.getTime(),
      '第二跳的 stage_entered_at 必须严格前进（多跳单调）',
    )
    const eventsFinal = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(eventsFinal.filter((e) => e.payload.from === 'S8' && e.payload.to === 'S9').length, 1)
    assert.equal(eventsFinal.filter((e) => e.payload.from === 'S9' && e.payload.to === 'S10').length, 1)
    assert.equal(eventsFinal.length, eventsBefore.length + 2, '两条边 = 恰好新增两条阶段事件')

    // ---- S10 是终态：再调 NO_OP、零 UPDATE、零事件 ----
    const fourth = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(fourth.status, 'NO_OP')
    assert.deepEqual(fourth.warnings, [], 'S10 不是 STAGE_AHEAD（它是 v1.0 终态）')
    assert.equal(fourth.stage_code, 'S10')
    assert.equal((await readApp(client, scenario.applicationId)).record_version, final.record_version)
    assert.equal((await stageChangeEvents(client, scenario.applicationId)).length, eventsFinal.length)
  })
})

// =====================================================================
//  A13 · 一次调用两跳：S8 → S9 → S10（Golden Path 终态形状）
// =====================================================================

test('A13 Golden Path 终态形状（面试已执行 + canonical READY 转写 + interview_record 未就绪 + STAGE/S10 决策）→ 一次调用 S8→S9→S10，读回 S10', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS8(client)
    const chain = await insertInterviewChain(client, scenario.applicationId, 'POST_INTERVIEW')
    const artifactId = await insertTranscriptArtifact(client, chain.meetingId, 'READY', true)
    // Golden Path HOP 9 的真实结果：转写 READY，但 record 是 NEEDS_REVIEW/UNVERIFIED（D-B）。
    await insertInterviewRecord(client, chain.interviewId, artifactId, scenario.rubricId)
    // Golden Path HOP 15 的真实结果：`decision(STAGE, S10, ADVANCE)` 已经落库。
    const decisionId = await insertStageDecision(client, scenario.applicationId)
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S10')
    assert.deepEqual(result.transitions, [{ from: 'S8', to: 'S9' }, { from: 'S9', to: 'S10' }])
    assert.deepEqual(result.blockers, [])
    assert.deepEqual(result.warnings, [])

    const after = await readApp(client, scenario.applicationId)
    assert.equal(
      after.current_stage_code,
      'S10',
      `复现缺口 D-A 的形状：decision=${decisionId} 已落库，阶段码必须读回 S10（旧实现读回 S8）`,
    )
    assert.equal(after.record_version, before.record_version + 2, '两跳 ⇒ 版本 +2')
    assert.equal(result.record_version, after.record_version)
    assert.ok(after.stage_entered_at.getTime() > before.stage_entered_at.getTime())

    const events = await stageChangeEvents(client, scenario.applicationId)
    assert.equal(events.filter((e) => e.payload.from === 'S8' && e.payload.to === 'S9').length, 1)
    assert.equal(events.filter((e) => e.payload.from === 'S9' && e.payload.to === 'S10').length, 1)
    assert.equal(events.length, eventsBefore.length + 2, '一条边一条事件（不能合并、不能少写）')

    // 决策行仍然在：本命令**不写也不改**决策（"是谁决定的"只能由 decision 行证明）。
    const { rows } = await client.query<{ n: string; result: string }>(
      `select count(*)::text as n, min(result) as result
         from recruitment.decision
        where tenant_id = $1 and application_id = $2 and decision_scope = 'STAGE' and stage_code = 'S10'`,
      [TENANT, scenario.applicationId],
    )
    assert.equal(Number(rows[0]?.n ?? 0), 1)
    assert.equal(rows[0]?.result, 'ADVANCE')
  })
})

// =====================================================================
//  A14 · 负例：面试全部取消 / 未到场 → BLOCKED，零写入
// =====================================================================

test('A14 负例：面试全部 CANCELLED / NO_SHOW → BLOCKED(INTERVIEW_NOT_COMPLETED)，阶段留 S8、零写入（版本与事件都不动）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS8(client)
    await insertInterviewChain(client, scenario.applicationId, 'CANCELLED')
    await insertInterviewChain(client, scenario.applicationId, 'NO_SHOW', { roundNo: 2, slotCode: 'ROUND2' })
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'BLOCKED')
    assert.deepEqual(result.blockers.map((b) => b.code), ['INTERVIEW_NOT_COMPLETED'])
    const blocker = result.blockers[0] as NonNullable<(typeof result.blockers)[0]>
    assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER')
    assert.equal(blocker.next_action_code, 'RESCHEDULE_INTERVIEW')
    assert.match(blocker.message, /CANCELLED/)
    assert.equal(blocker.owner_actor_id, '11111111-1111-4111-8111-000000000102', '责任人从库里推出来（部门招聘负责人）')
    assert.deepEqual(result.transitions, [])

    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S8', '阶段留在 S8')
    assert.equal(after.record_version, before.record_version, '零 UPDATE ⇒ 版本不变')
    assert.equal(after.stage_source_event_id, before.stage_source_event_id)
    assert.equal((await stageChangeEvents(client, scenario.applicationId)).length, eventsBefore.length, '不产生事件')
  })
})

// =====================================================================
//  A15 · 负例：转写取不回来 → BLOCKED，零写入
// =====================================================================

test('A15 负例：转写 AUTH_REQUIRED（取不回来）→ BLOCKED(TRANSCRIPT_NOT_READY)，阶段留 S9、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS8(client)
    const chain = await insertInterviewChain(client, scenario.applicationId, 'POST_INTERVIEW')
    // 先把阶段推到 S9（面试已发生、材料还没可用）——这是真实序列里的中间状态。
    await setStage(client, scenario.applicationId, 'S9')
    // 平台侧取不回来：`AUTH_REQUIRED` 不满足"完整原文已获取"，按 transcript-rules S-2 也不该被选成 canonical。
    await insertTranscriptArtifact(client, chain.meetingId, 'AUTH_REQUIRED', false)
    const before = await readApp(client, scenario.applicationId)
    const eventsBefore = await stageChangeEvents(client, scenario.applicationId)

    const result = await advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })

    assert.equal(result.status, 'BLOCKED')
    assert.deepEqual(result.blockers.map((b) => b.code), ['TRANSCRIPT_NOT_READY'])
    const blocker = result.blockers[0] as NonNullable<(typeof result.blockers)[0]>
    assert.equal(blocker.owner_role, 'RECRUITMENT_OWNER')
    assert.equal(blocker.next_action_code, 'REIMPORT_TRANSCRIPT')
    assert.match(blocker.message, /AUTH_REQUIRED/)

    const after = await readApp(client, scenario.applicationId)
    assert.equal(after.current_stage_code, 'S9', '阶段留在 S9')
    assert.equal(after.record_version, before.record_version, '零 UPDATE ⇒ 版本不变')
    assert.equal((await stageChangeEvents(client, scenario.applicationId)).length, eventsBefore.length)
  })
})

// =====================================================================
//  A16 · 只读阻塞视图（真库）：S8 / S9 / S10 的下一步 + 只发读语句
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

test('A16 只读阻塞视图（真库）：S8 等排期 → SCHEDULE_INTERVIEW；S9 等材料 → IMPORT_TRANSCRIPT；S10 终态 → CONTINUE_DOWNSTREAM；只发读语句', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedAtS8(client)

    // ---- S8：还没有面试 → 下一步"去排期" ----
    const s8Record = recordingClient(client)
    const s8 = await readStageBlockedView(s8Record.proxy, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(s8.stage, 'S8')
    assert.equal(s8.status, 'NO_OP')
    assert.deepEqual(s8.blockers, [])
    assert.equal(s8.next_action.code, 'SCHEDULE_INTERVIEW')
    assert.ok(s8.next_action.message.length > 0, '下一步要有给人读的说明')
    assertOnlyReadStatements(s8Record.statements)

    // ---- S9：面试已执行、材料还没到 → 下一步"去导转写" ----
    const chain = await insertInterviewChain(client, scenario.applicationId, 'POST_INTERVIEW')
    await setStage(client, scenario.applicationId, 'S9')
    const s9Record = recordingClient(client)
    const s9 = await readStageBlockedView(s9Record.proxy, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(s9.stage, 'S9')
    assert.equal(s9.status, 'NO_OP')
    assert.equal(s9.next_action.code, 'IMPORT_TRANSCRIPT')
    assertOnlyReadStatements(s9Record.statements)

    // ---- S10：v1.0 终态 → 本命令没有剩余动作 ----
    await insertTranscriptArtifact(client, chain.meetingId, 'READY', true)
    await setStage(client, scenario.applicationId, 'S10')
    const s10Record = recordingClient(client)
    const s10 = await readStageBlockedView(s10Record.proxy, {
      tenantId: TENANT,
      applicationId: scenario.applicationId,
    })
    assert.equal(s10.stage, 'S10')
    assert.equal(s10.stage_name, '综合评价与招聘决策')
    assert.equal(s10.status, 'NO_OP')
    assert.equal(s10.blocked, false)
    assert.deepEqual(s10.blockers, [])
    assert.equal(s10.next_action.code, 'CONTINUE_DOWNSTREAM')
    assertOnlyReadStatements(s10Record.statements)
  })
})

test.after(async () => {
  await pool.end()
})
