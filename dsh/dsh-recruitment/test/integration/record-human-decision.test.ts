// `record_human_decision`（高层「记录人类决策」Agent 动作）的**真库集成测试**。
//
// 覆盖 task-76 验收（`work/d5/product-decision/` 产品/业务 FAIL 修复 2）：
//   a. 正例 SCREENING HOLD（S7）：tool.execute 成功；独立 SQL 读回 decision
//      （scope=SCREENING / result=HOLD / stage_code=S7 / actor=HR_ACTOR / record_version=1）；
//      basis_refs 含 RUBRIC_VERSION + AUTHORITY（+ RESUME_VERSION），不含 SUMMARY / SCORECARD；
//      event_inbox 里恰好 1 条 decision.record 事件（source_object_id = decision id）。
//   b. 正例 SCREENING ADVANCE：basis 带 SCREENING_EVALUATION（evaluation_digest 64hex、verdict 合法），
//      且它的 rubric/resume 绑定与独立 SQL 读到的「申请钉住版本」逐字一致。
//   c. 正例 S10 FINAL HOLD（手动把申请推进到 S10 + 一场已排期面试 + 1 条已提交面评）：
//      独立 SQL 读回 scope=FINAL / stage_code=S10；basis 含 SUMMARY + RUBRIC_VERSION + AUTHORITY
//      + 至少 1 条 SCORECARD，SUMMARY.digest 为 64hex 且与工具出参回显一致。
//   d. 负例族（**逐项断言 decision/event_inbox 行数 + application.record_version 前后不变**）：
//      d.1 S7+FINAL → STAGE_NOT_S10；d.2 S7+STAGE → STAGE_NOT_S10；
//      d.3 S10+SCREENING → STAGE_NOT_SCREENING_STAGE；
//      d.4 客户端传 basis_refs / summary_digest → SERVER_DERIVED_REJECTED；
//      d.5 human_confirmation 里传 confirmation_text_sha256 → SERVER_DERIVED_REJECTED；
//      d.6 confirmed_by_actor_id ≠ 执行 actor → CONFIRMATION_SUBJECT_MISMATCH；
//      d.7 IN_APP_CONFIRM 且不传 approval（headless 无应答者）→ APPROVAL_UNAVAILABLE；
//      d.8 S10+FINAL/ADVANCE 且没有任何已提交面评 → 非 OK（见用例内按实际结果断言）；
//      d.9 申请钉住的 rubric 维度不可评价 → MISSING_SUMMARY；
//      d.10 deps 传 identity 但 exec 的 session 未绑定 → DEMO_ACTOR_UNMAPPED。
//   e. 事件元数据：独立 SQL 读 event_inbox.payload，断言 human_confirmation_method='IN_CHAT'、
//      human_confirmation_text 原文、human_confirmation_text_sha256 64hex；并断言 W0 patch 之后
//      payload 里**确实有** confirmed_at / confirmed_by_actor_id / confirmation_method /
//      confirmation_text_sha256 四个字面键，工具不再误报 EVENT_CONFIRMATION_METADATA_MISSING。
//
// 纪律（与 `test/integration/db.ts` 同一口径）：
//   1. 独占一个一次性空库 `createIsolatedTestDatabase('rhdec')`（不写 ra_s6s7），跑完 drop；
//   2. 断言只用**独立 SQL**（`db.pool.query`），不 import 任何产品读投影；
//   3. 夹具必须在**真提交**的事务里造：工具自建连接池，看不到别的连接里未提交的行；
//   4. 正例走 legacy actor（`database.actor_id` = 1111…0103）；d.10 用真实 identity 注册表。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'
import { createRecordHumanDecisionTool } from '../../src/tools/record-human-decision.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  criterion,
  errorBody,
  hex64,
  one,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
  HR_ACTOR,
  TENANT,
  type IsolatedTestDatabase,
  type Scenario,
} from './db.ts'

/** 独立连接池的库配置（只把 database 换成一次性库）。 */
const BASE = testDatabaseConfig()
/** 执行面试官的 actor（S10 面评作者；种子 0002 里存在且是 HUMAN）。 */
const INTERVIEWER_ACTOR = '11111111-1111-4111-8111-000000000104'
/** 已绑定 recruiter 的 session（d.10 用它证明「identity 已装配但 session 未绑定」）。 */
const SESSION_RECRUITER = 'session-00000000-0000-4000-8000-0000000000a1'
/** 未绑定的合法 session（d.10 的负例输入）。 */
const SESSION_UNBOUND = 'session-00000000-0000-4000-8000-0000000000ff'

/** 判定数据：MUST_HAVE「有工作经历」+ DISQUALIFIER「不足 60 个月即排除」。 */
const WORK_EXISTS = {
  key: 'work_exists',
  label: '有工作经历',
  kind: 'MUST_HAVE',
  weight: 0.6,
  field: 'work_experience',
  operator: 'EXISTS',
  value: true,
}
const MONTHS_LTE60 = {
  key: 'too_short',
  label: '不足 60 个月即排除',
  kind: 'DISQUALIFIER',
  weight: 0.4,
  field: 'timeline.covered_months_closed',
  operator: 'LTE',
  value: 60,
}
/**
 * d.9 的「不可评价」维度：rubric 维度键用了保留键 `transcript_basis`。
 *
 * 任务书建议「SQL 改 rubric_version.dimensions」—— 实测该造法被库挡住：
 * `rubric_version` 有 `trg_rubric_version_immutable`（0001 §9.3，整行不可改），
 * 且 `ck_rubric_version_dimensions` 要求 `jsonb_array_length > 0`（空数组也插不进去）。
 * 等价造法：夹具里直接**新建**一版 dimensions 含保留键的 rubric（payload_hash = digestOf(dimensions)，
 * 由 `seedScenario` 保证），再把申请钉到它上面 —— 这同样得到「钉住的 rubric 不可评价」的真实状态。
 */
const RESERVED_DIMENSION = criterion({
  key: 'transcript_basis',
  label: '保留键维度（不可评价）',
  kind: 'MUST_HAVE',
  weight: 1,
  field: 'work_experience',
  operator: 'EXISTS',
  value: true,
})

/** 执行上下文形状（legacy 路径只要求不抛；identity 路径按 `exec.agent.id` 解析 session）。 */
const EXEC_LEGACY = { agent: { id: SESSION_RECRUITER } }

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
let tool: ReadonlyToolDefinition
let toolWithIdentity: ReadonlyToolDefinition

/** 夹具：S7 初筛（HOLD 正例）。 */
let s7Hold: Scenario
/** 夹具：S7 初筛（ADVANCE 正例）。 */
let s7Advance: Scenario
/** 夹具：S7 初筛（负例专用，始终保持「没有初筛决策」）。 */
let s7Plain: Scenario
/** 夹具：S10（FINAL HOLD 正例 + e 事件元数据）。 */
let s10Main: Scenario
/** 夹具：S10（没有面试/面评；d.3 S10+SCREENING 与 d.8 缺面评共用）。 */
let s10NoScore: Scenario
/** 夹具：S10（钉住的 rubric 维度不可评价；d.9）。 */
let s10BadRubric: Scenario
/** S10 正例夹具的面试 / 面评 id（独立 SQL 读回断言用）。 */
let s10InterviewId = ''
let s10ScorecardId = ''
/** c/e 用例之间传递的事实（由 c 写入，e 独立 SQL 读回后再断言）。 */
let s10DecisionId = ''
let s10ConfirmedAt = ''
let s10ConfirmationText = ''
let s10Output: Record<string, unknown> = {}

test.before(async () => {
  db = await createIsolatedTestDatabase('rhdec')
  assertPrivateDatabase(db.name)
  assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
  cfg = { ...BASE, database: db.name }

  // ---- 夹具：真提交（工具自建连接池/另开连接，必须看到已提交事实）----
  await withCommittedFixture(async (client) => {
    const dimensions = [WORK_EXISTS, MONTHS_LTE60].map(criterion)
    const common = {
      dimensions,
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    } as const
    s7Hold = await seedScenario(client, common)
    s7Advance = await seedScenario(client, common)
    s7Plain = await seedScenario(client, common)
    s10Main = await seedScenario(client, common)
    s10NoScore = await seedScenario(client, common)
    s10BadRubric = await seedScenario(client, {
      dimensions: [RESERVED_DIMENSION],
      fields: parsedFields({ entryCount: 1 }),
      approve: true,
      pinRubric: true,
      bindMaterial: true,
    })

    // 阶段迁移有过期护栏：DB 触发器要求事务里能确定 actor（SET LOCAL recruitment.actor_id）。
    for (const scenario of [s10Main, s10NoScore, s10BadRubric]) {
      await client.query(
        "update recruitment.application set current_stage_code = 'S10' where id = $1::uuid and tenant_id = $2::uuid",
        [scenario.applicationId, TENANT],
      )
    }

    // S10 正例：一场已过期的面试 + 1 条已提交面评（与 decision-facade.test.ts 的 S10 夹具同形）。
    s10InterviewId = await one(client, `insert into recruitment.interview
        (tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
        values ($1, $2, 1, 'DEFAULT', 'S9', 'POST_INTERVIEW', now() - interval '2 hours', now() - interval '1 hour')
        returning id`, [TENANT, s10Main.applicationId])
    const interviewerId = await one(client, `insert into recruitment.interviewer
        (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
        values ($1, $2, $3, 'INTERVIEWER', true, now() - interval '1 hour')
        returning id`, [TENANT, s10InterviewId, INTERVIEWER_ACTOR])
    const scorecardItems = {
      transcript_basis: 'NO_TRANSCRIPT',
      work_exists: { assessment: 'MET', evidence: [] },
      too_short: { assessment: 'MET', evidence: [] },
    }
    s10ScorecardId = await one(client, `insert into recruitment.scorecard
        (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
         submitted_at, items, overall, rationale, payload_hash, status_changed_by_actor_id)
        values ($1, $2, $3, $4, 1, 'SUBMITTED', now(), $5::jsonb, 'HOLD', '集成测试：S10 已提交面评（HOLD）',
                $6, $7)
        returning id`, [
      TENANT, s10InterviewId, interviewerId, s10Main.rubricId,
      JSON.stringify(scorecardItems), hex64(`rhdec:${s10Main.applicationId}`),
      INTERVIEWER_ACTOR,
    ])
  })

  // ---- 身份：产品真实例（session → alias → HUMAN actor）----
  const created = createDemoActorIdentity()
  assert.deepEqual(created.issues, [], '身份装配不应有 issues')
  identity = created.identity
  identity.registry.bind(SESSION_RECRUITER, 'recruiter')

  tool = createRecordHumanDecisionTool({ database: cfg })
  toolWithIdentity = createRecordHumanDecisionTool({ database: cfg, identity })
})

test.after(async () => {
  if (db !== undefined) await db.drop()
})

// ===========================================================================
//  a. 正例：SCREENING HOLD（S7）
// ===========================================================================

test('a) SCREENING HOLD：写入成功 + 独立 SQL 读回 decision/basis_refs/event（S7）', async (t) => {
  const confirmedAt = recentIso()
  const confirmationText = '我确认：这份简历先暂缓，等我把工作年限证据再核一遍。'
  const before = await counts()

  const output = await tool.execute({
    application_id: s7Hold.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: '初筛结论暂缓：工作年限证据需要人工再核一遍（集成测试）',
    human_confirmation: { confirmed_at: confirmedAt, method: 'IN_CHAT', text: confirmationText },
  }, EXEC_LEGACY) as Record<string, unknown>

  assert.equal(output.tool, 'record_human_decision')
  assert.equal(output.status, 'OK')
  assert.equal(output.replayed, false)
  assert.equal((output.readback as Record<string, unknown>).table, 'decision')
  assert.equal((output.readback as Record<string, unknown>).verified, true)
  assert.equal(hasWarning(output, 'EVENT_CONFIRMATION_METADATA_MISSING'), false, '事件确认元数据完整时不得误报缺失')
  assert.equal(await counts().then((after) => after.decisions), before.decisions + 1, '正例必须恰好新增 1 条 decision')

  // ---- 独立 SQL 读回（不是回显响应）----
  const rows = await decisionsFor(s7Hold.applicationId, 'SCREENING')
  assert.equal(rows.length, 1, '必须恰好有 1 条 SCREENING 决策')
  const row = rows[0]!
  assert.equal(row.decision_scope, 'SCREENING')
  assert.equal(row.result, 'HOLD')
  assert.equal(row.stage_code, 'S7')
  assert.equal(row.actor_id, HR_ACTOR)
  assert.equal(row.record_version, 1)
  assert.equal(row.application_id, s7Hold.applicationId)
  const outDecision = output.decision as Record<string, unknown>
  assert.equal(outDecision.id, row.decision_id, '出参 decision.id = 独立 SQL 读回的 id')
  assert.equal(outDecision.record_version, row.record_version)
  assert.equal(outDecision.stage_code, 'S7')

  // ---- basis_refs：S7 只带 RUBRIC_VERSION / AUTHORITY（+ RESUME_VERSION），不带 S10 依据 ----
  const refs = row.basis_refs
  const kinds = kindsOf(refs)
  assert.ok(kinds.includes('RUBRIC_VERSION'), `basis_refs 必须含 RUBRIC_VERSION，实际 ${kinds.join(',')}`)
  assert.ok(kinds.includes('AUTHORITY'), `basis_refs 必须含 AUTHORITY，实际 ${kinds.join(',')}`)
  assert.ok(kinds.includes('RESUME_VERSION'), '申请绑定了材料 → basis 必须带 RESUME_VERSION')
  assert.equal(kinds.includes('SUMMARY'), false, 'SCREENING 不得带 SUMMARY')
  assert.equal(kinds.includes('SCORECARD'), false, 'SCREENING 不得带 SCORECARD')
  assert.equal(kinds.includes('SCREENING_EVALUATION'), false, 'HOLD 不需要（也不带）初筛评估依据')

  const pinned = await pinnedFacts(s7Hold.applicationId)
  const rubricRef = refOfKind(refs, 'RUBRIC_VERSION')
  assert.equal(rubricRef.id, pinned.rubric_version_id)
  assert.equal(rubricRef.payload_hash, pinned.rubric_payload_hash, 'RUBRIC_VERSION.payload_hash 必须 = 库里的 rubric_version.payload_hash')
  const authorityRef = refOfKind(refs, 'AUTHORITY')
  assert.equal(authorityRef.actor_id, HR_ACTOR, 'AUTHORITY.actor_id 必须是执行上下文 actor')
  const resumeRef = refOfKind(refs, 'RESUME_VERSION')
  assert.equal(resumeRef.id, pinned.resume_version_id)
  assert.equal(resumeRef.content_sha256, pinned.resume_content_sha256)

  // ---- 事件：恰好 1 条 decision.record，source_object_id = decision id ----
  const events = await eventsFor(row.decision_id)
  assert.equal(events.length, 1, '每个决策恰好 1 条 decision.record 事件')
  assert.equal(events[0]!.event_type, 'decision.record')
  assert.equal(events[0]!.source_object_id, row.decision_id)
  assert.equal((events[0]!.payload as Record<string, unknown>).decision_id, row.decision_id)

  const outEvent = output.event as Record<string, unknown>
  assert.equal(outEvent.event_id, events[0]!.event_id, '出参 event.event_id = 独立 SQL 读回的事件 id')

  t.diagnostic(
    `a) SQL 读回 decision=${row.decision_id} scope=${row.decision_scope} result=${row.result} `
    + `stage=${String(row.stage_code)} actor=${row.actor_id} record_version=${row.record_version} `
    + `basis_kinds=[${kinds.join(',')}] event=${events[0]!.event_id}`,
  )
})

// ===========================================================================
//  b. 正例：SCREENING ADVANCE（S7）
// ===========================================================================

test('b) SCREENING ADVANCE：basis 带 SCREENING_EVALUATION，rubric/resume 绑定与 SQL 逐字一致', async (t) => {
  const output = await tool.execute({
    application_id: s7Advance.applicationId,
    decision_scope: 'SCREENING',
    result: 'ADVANCE',
    reason: '初筛评估通过：机械条件满足，可以进入下一阶段（集成测试）',
    human_confirmation: {
      confirmed_at: recentIso(),
      method: 'IN_CHAT',
      text: '我确认：按这次初筛评估推进到下一轮。',
    },
  }, EXEC_LEGACY) as Record<string, unknown>
  assert.equal(output.status, 'OK')

  const rows = await decisionsFor(s7Advance.applicationId, 'SCREENING')
  assert.equal(rows.length, 1)
  const row = rows[0]!
  assert.equal(row.result, 'ADVANCE')
  assert.equal(row.stage_code, 'S7')
  assert.equal(row.actor_id, HR_ACTOR)
  assert.equal(row.record_version, 1)

  const refs = row.basis_refs
  const kinds = kindsOf(refs)
  assert.ok(kinds.includes('SCREENING_EVALUATION'), `ADVANCE 的 basis_refs 必须含 SCREENING_EVALUATION，实际 ${kinds.join(',')}`)
  const evaluation = refOfKind(refs, 'SCREENING_EVALUATION')
  assert.match(String(evaluation.evaluation_digest), /^[0-9a-f]{64}$/, 'evaluation_digest 必须是 64 位小写 hex')
  assert.ok(
    ['PASS', 'FAIL', 'NEEDS_REVIEW'].includes(String(evaluation.verdict)),
    `verdict 必须合法，实际 ${String(evaluation.verdict)}`,
  )

  // ---- 「它的 rubric/resume 绑定」与独立 SQL 读到的申请钉住版本逐字一致 ----
  const pinned = await pinnedFacts(s7Advance.applicationId)
  assert.equal(evaluation.rubric_version_id, pinned.rubric_version_id)
  assert.equal(evaluation.rubric_payload_hash, pinned.rubric_payload_hash)
  assert.equal(evaluation.resume_version_id, pinned.resume_version_id)
  assert.equal(evaluation.resume_content_sha256, pinned.resume_content_sha256)
  // RUBRIC_VERSION 依据同样必须是申请钉住的那一版
  const rubricRef = refOfKind(refs, 'RUBRIC_VERSION')
  assert.equal(rubricRef.id, pinned.rubric_version_id)
  assert.equal(rubricRef.payload_hash, pinned.rubric_payload_hash)

  // 出参回显的 digest 与独立 SQL 读回的依据一致（不是编造的第二份）
  const outBasis = output.basis as Record<string, unknown>
  assert.equal(outBasis.screening_evaluation_digest, evaluation.evaluation_digest)

  t.diagnostic(
    `b) SQL 读回 decision=${row.decision_id} result=${row.result} basis_kinds=[${kinds.join(',')}] `
    + `evaluation_digest=${String(evaluation.evaluation_digest)} verdict=${String(evaluation.verdict)} `
    + `rubric=${String(evaluation.rubric_version_id)} resume=${String(evaluation.resume_version_id)}`,
  )
})

// ===========================================================================
//  c. 正例：S10 FINAL HOLD
// ===========================================================================

test('c) S10 FINAL HOLD：写入成功 + 独立 SQL 读回 SUMMARY/SCORECARD 依据', async (t) => {
  s10ConfirmedAt = recentIso()
  s10ConfirmationText = '我确认：这次终局先暂缓，等下一轮面评补齐后再定。'
  const output = await tool.execute({
    application_id: s10Main.applicationId,
    decision_scope: 'FINAL',
    result: 'HOLD',
    reason: '终局决策暂缓：现有面评不足以推进，本人决定先 hold（集成测试）',
    human_confirmation: {
      confirmed_at: s10ConfirmedAt,
      method: 'IN_CHAT',
      text: s10ConfirmationText,
    },
  }, EXEC_LEGACY) as Record<string, unknown>
  s10Output = output
  assert.equal(output.status, 'OK')
  assert.equal(hasWarning(output, 'EVENT_CONFIRMATION_METADATA_MISSING'), false, 'W0 patch 之后事件确认元数据必须完整')

  const rows = await decisionsFor(s10Main.applicationId, 'FINAL')
  assert.equal(rows.length, 1, '必须恰好有 1 条 FINAL 决策')
  const row = rows[0]!
  s10DecisionId = row.decision_id
  assert.equal(row.decision_scope, 'FINAL')
  assert.equal(row.result, 'HOLD')
  assert.equal(row.stage_code, 'S10', 'FINAL 的 stage_code 必须是 S10')
  assert.equal(row.actor_id, HR_ACTOR)
  assert.equal(row.record_version, 1)
  assert.equal(row.interview_id, null, 'FINAL 不得绑单场面试（DC-06）')

  // ---- basis_refs：SUMMARY / RUBRIC_VERSION / AUTHORITY / ≥1 SCORECARD ----
  const refs = row.basis_refs
  const kinds = kindsOf(refs)
  for (const kind of ['SUMMARY', 'RUBRIC_VERSION', 'AUTHORITY', 'SCORECARD']) {
    assert.ok(kinds.includes(kind), `FINAL 的 basis_refs 必须含 ${kind}，实际 ${kinds.join(',')}`)
  }
  const summary = refOfKind(refs, 'SUMMARY')
  assert.match(String(summary.summary_digest), /^[0-9a-f]{64}$/, 'SUMMARY.summary_digest 必须是 64 位小写 hex')
  const scorecards = refs.filter((ref) => ref.kind === 'SCORECARD')
  assert.ok(scorecards.length >= 1, 'FINAL 至少要引 1 条 SCORECARD 依据')
  assert.equal(scorecards.length, 1, `本次夹具只有 1 条可用面评，实际引用 ${scorecards.length} 条`)
  assert.equal(scorecards[0]!.id, s10ScorecardId, 'SCORECARD 依据必须指向独立 SQL 读到的已提交面评')
  assert.equal(scorecards[0]!.overall, 'HOLD')
  assert.equal(scorecards[0]!.transcript_basis, 'NO_TRANSCRIPT')

  const pinned = await pinnedFacts(s10Main.applicationId)
  assert.equal(refOfKind(refs, 'RUBRIC_VERSION').payload_hash, pinned.rubric_payload_hash)
  assert.equal(refOfKind(refs, 'AUTHORITY').actor_id, HR_ACTOR)

  // 出参回显：summary_digest / scorecard_ids 与独立 SQL 依据一致
  const outBasis = output.basis as Record<string, unknown>
  assert.equal(outBasis.summary_digest, summary.summary_digest)
  assert.deepEqual(outBasis.scorecard_ids, [s10ScorecardId])
  assert.deepEqual(await scorecardIdsOf(s10Main.applicationId), [s10ScorecardId], 'SQL 里确实只有这 1 条已提交面评')

  t.diagnostic(
    `c) SQL 读回 decision=${row.decision_id} scope=${row.decision_scope} result=${row.result} stage=${String(row.stage_code)} `
    + `basis_kinds=[${kinds.join(',')}] summary_digest=${String(summary.summary_digest)} `
    + `scorecard=${s10ScorecardId} rubric=${pinned.rubric_version_id} interview=${s10InterviewId}`,
  )
})

// ===========================================================================
//  d. 负例族：fail-closed 且零写入
// ===========================================================================

test('d.1 S7 申请 + FINAL → INVALID_ARGS/STAGE_NOT_S10，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'FINAL',
    result: 'HOLD',
    reason: 'S7 不能落终局决策（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, EXEC_LEGACY)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.equal(error.reason_code, 'STAGE_NOT_S10')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.1')
})

test('d.2 S7 申请 + STAGE → INVALID_ARGS/STAGE_NOT_S10（或 STAGE 推导先抛），零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'STAGE',
    result: 'HOLD',
    reason: 'S7 不能落面试决策（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, EXEC_LEGACY)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.ok(
    ['STAGE_NOT_S10', 'STAGE_REQUIRES_INTERVIEW', 'STAGE_INTERVIEW_AMBIGUOUS'].includes(error.reason_code),
    `d.2 期望阶段闸门先抛，实际 reason_code=${error.reason_code}`,
  )
  assert.equal(error.reason_code, 'STAGE_NOT_S10', '实测路径：方向性守卫先于「推导唯一一场面试」')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.2')
})

test('d.3 S10 申请 + SCREENING → INVALID_ARGS/STAGE_NOT_SCREENING_STAGE，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s10NoScore.applicationId)
  const error = await expectError({
    application_id: s10NoScore.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: 'S10 再补记初筛属于脏数据（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, EXEC_LEGACY)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.equal(error.reason_code, 'STAGE_NOT_SCREENING_STAGE')
  await assertUnchanged(s10NoScore.applicationId, before, appBefore, 'd.3')
})

test('d.4 客户端传 basis_refs / summary_digest → SERVER_DERIVED_REJECTED，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  const pinned = await pinnedFacts(s7Plain.applicationId)

  const withBasis = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: '客户端不得传 basis_refs（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
    basis_refs: [{ kind: 'RUBRIC_VERSION', id: pinned.rubric_version_id, payload_hash: pinned.rubric_payload_hash }],
  }, EXEC_LEGACY)
  assert.equal(withBasis.code, 'INVALID_ARGS')
  assert.equal(withBasis.reason_code, 'SERVER_DERIVED_REJECTED')

  const withDigest = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: '客户端不得传 summary_digest（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
    summary_digest: 'a'.repeat(64),
  }, EXEC_LEGACY)
  assert.equal(withDigest.code, 'INVALID_ARGS')
  assert.equal(withDigest.reason_code, 'SERVER_DERIVED_REJECTED')

  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.4')
})

test('d.5 human_confirmation 里传 confirmation_text_sha256 → SERVER_DERIVED_REJECTED，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: 'hash 由服务端算（集成测试）',
    human_confirmation: {
      ...humanConfirmation('这条不该被接受。'),
      confirmation_text_sha256: 'b'.repeat(64),
    },
  }, EXEC_LEGACY)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.equal(error.reason_code, 'SERVER_DERIVED_REJECTED')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.5')
})

test('d.6 confirmed_by_actor_id 不是执行 actor → CONFIRMATION_SUBJECT_MISMATCH，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: '不能替别人确认（集成测试）',
    human_confirmation: {
      ...humanConfirmation('这条不该被接受。'),
      confirmed_by_actor_id: INTERVIEWER_ACTOR,
    },
  }, EXEC_LEGACY)
  assert.equal(error.code, 'DECISION_REQUIRES_HUMAN')
  assert.equal(error.reason_code, 'CONFIRMATION_SUBJECT_MISMATCH')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.6')
})

test('d.7 IN_APP_CONFIRM 且不传 approval（headless 无应答者）→ APPROVAL_UNAVAILABLE，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  // deps 未装配 approval ⇒ headless 没有 answerer ⇒ 领域 STEP 6.5 fail closed（D-79）。
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: 'IN_APP_CONFIRM 需要批准通道（集成测试）',
    human_confirmation: {
      confirmed_at: recentIso(),
      method: 'IN_APP_CONFIRM',
      text: '我在应用里点过确认（集成测试）。',
    },
  }, EXEC_LEGACY)
  assert.equal(error.code, 'DECISION_REQUIRES_HUMAN')
  assert.equal(error.reason_code, 'APPROVAL_UNAVAILABLE')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.7')
})

test('d.8 S10 FINAL/ADVANCE 且没有任何已提交面评 → 4xx，零写入', async (t) => {
  const before = await counts()
  const appBefore = await appFacts(s10NoScore.applicationId)
  const error = await expectError({
    application_id: s10NoScore.applicationId,
    decision_scope: 'FINAL',
    result: 'ADVANCE',
    reason: '没有任何面评不得推进（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, EXEC_LEGACY)
  assert.notEqual(error.code, 'OK', '缺面评必须 fail closed')
  // 实测路径：S10 汇总没有提交票 → 领域结果门禁 EVIDENCE_INSUFFICIENT/NO_SUBMITTED_SCORECARD
  // （契约层期望的 SCORECARD_MISSING / BASIS_REF_EMPTY 是同族 4xx；见 verify/A/NOTES.md）。
  assert.ok(
    ['NO_SUBMITTED_SCORECARD', 'SCORECARD_MISSING', 'REQUIRED_SCORECARDS_INCOMPLETE', 'BASIS_REF_EMPTY'].includes(error.reason_code),
    `d.8 期望「缺面评」族 4xx，实际 code=${error.code} reason_code=${error.reason_code}`,
  )
  assert.equal(error.code, 'EVIDENCE_INSUFFICIENT', '实测：结果门禁在 SCORECARD/basis 校验之前先抛')
  assert.equal(error.reason_code, 'NO_SUBMITTED_SCORECARD')
  await assertUnchanged(s10NoScore.applicationId, before, appBefore, 'd.8')
  t.diagnostic(`d.8 实测 code=${error.code} reason_code=${error.reason_code}（契约层同族 4xx：SCORECARD_MISSING/BASIS_REF_EMPTY）`)
})

test('d.9 申请钉住的 rubric 维度不可评价 → MISSING_SUMMARY，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s10BadRubric.applicationId)
  const error = await expectError({
    application_id: s10BadRubric.applicationId,
    decision_scope: 'FINAL',
    result: 'HOLD',
    reason: 'rubric 不可评价时服务端算不出汇总（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, EXEC_LEGACY)
  assert.equal(error.code, 'INVALID_ARGS')
  assert.equal(error.reason_code, 'MISSING_SUMMARY')
  // 复算失败时不得留任何行（更不得拿客户端 digest 顶替）
  await assertUnchanged(s10BadRubric.applicationId, before, appBefore, 'd.9')
})

test('d.10 identity 已装配但 exec 的 session 未绑定 → DEMO_ACTOR_UNMAPPED，零写入', async () => {
  const before = await counts()
  const appBefore = await appFacts(s7Plain.applicationId)
  assert.equal(identity.registry.get(SESSION_UNBOUND), undefined, '负例 session 必须未绑定')
  const error = await expectError({
    application_id: s7Plain.applicationId,
    decision_scope: 'SCREENING',
    result: 'HOLD',
    reason: '未绑定 session 不得写入（集成测试）',
    human_confirmation: humanConfirmation('这条不该被接受。'),
  }, { agent: { id: SESSION_UNBOUND } }, toolWithIdentity)
  assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.equal(error.reason_code, 'SESSION_NOT_BOUND')
  await assertUnchanged(s7Plain.applicationId, before, appBefore, 'd.10')
})

// ===========================================================================
//  e. 事件元数据：payload 里的确认事实（独立 SQL 读回）
// ===========================================================================

test('e) decision.record 事件 payload：确认方式/原话/hash + W0 patch 的确认人/时间字面键', async (t) => {
  assert.notEqual(s10DecisionId, '', '本用例依赖 c) 先写入 S10 FINAL 决策')
  assert.notEqual(s10ConfirmedAt, '')
  assert.notEqual(s10ConfirmationText, '')

  const events = await eventsFor(s10DecisionId)
  assert.equal(events.length, 1, 'S10 FINAL 决策必须恰好 1 条 decision.record 事件')
  const payload = events[0]!.payload as Record<string, unknown>

  // D-95 / DC-08..11：人怎么授权的，事件里必须能独立复算
  assert.equal(payload.human_confirmation_method, 'IN_CHAT')
  assert.equal(payload.human_confirmation_text, s10ConfirmationText, '事件里必须是人的原话逐字')
  assert.match(String(payload.human_confirmation_text_sha256), /^[0-9a-f]{64}$/)
  assert.equal(payload.human_confirmation_preimage_version, 2, '带原话的确认走 v2 pre-image')

  // W0 patch（decision-record.ts 的 wiring）：四个字面键必须真实存在（不再依赖读回补值）
  assert.equal(payload.confirmation_method, 'IN_CHAT')
  assert.equal(payload.confirmed_by_actor_id, HR_ACTOR)
  assert.equal(payload.confirmed_at, s10ConfirmedAt)
  assert.match(String(payload.confirmation_text_sha256), /^[0-9a-f]{64}$/)
  assert.equal(payload.confirmation_text_sha256, payload.human_confirmation_text_sha256, '两处 hash 必须同源')

  // 工具如实报告：元数据完整 → 出参不得再有 EVENT_CONFIRMATION_METADATA_MISSING
  assert.equal(hasWarning(s10Output, 'EVENT_CONFIRMATION_METADATA_MISSING'), false)

  // 出参与事件读回一致（工具写后**另开连接**读回，再回显出参）
  const outConfirmation = s10Output.human_confirmation as Record<string, unknown>
  assert.equal(outConfirmation.confirmed_by_actor_id, HR_ACTOR)
  assert.equal(outConfirmation.confirmed_at, s10ConfirmedAt)
  assert.equal(outConfirmation.method, 'IN_CHAT')
  assert.equal(outConfirmation.text_sha256, payload.human_confirmation_text_sha256)
  const outEvent = s10Output.event as Record<string, unknown>
  assert.equal(outEvent.event_id, events[0]!.event_id)
  assert.equal((outEvent.confirmation as Record<string, unknown>).confirmed_by_actor_id, HR_ACTOR)

  t.diagnostic(
    `e) SQL 读回事件=${events[0]!.event_id} method=${String(payload.human_confirmation_method)} `
    + `preimage_version=${String(payload.human_confirmation_preimage_version)} `
    + `sha256=${String(payload.human_confirmation_text_sha256)} confirmed_by=${String(payload.confirmed_by_actor_id)} `
    + `confirmed_at=${String(payload.confirmed_at)}`,
  )
})

// ===========================================================================
//  helper（全部独立 SQL，不 import 任何产品读投影）
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

/** 独立 SQL 读回（不经过任何产品读模块）。 */
async function query<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一条 decision 行（独立 SQL 读回形状）。 */
interface DecisionRow {
  readonly decision_id: string
  readonly application_id: string
  readonly interview_id: string | null
  readonly decision_scope: string
  readonly result: string
  readonly stage_code: string | null
  readonly actor_id: string
  readonly record_version: number
  readonly basis_refs: Array<Record<string, unknown>>
}

/** 某申请某 scope 的当前决策（独立 SQL）。 */
async function decisionsFor(applicationId: string, decisionScope: string): Promise<DecisionRow[]> {
  return await query<DecisionRow>(
    `select d.id::text                    as decision_id,
            d.application_id::text        as application_id,
            d.interview_id::text          as interview_id,
            d.decision_scope              as decision_scope,
            d.result                      as result,
            d.stage_code                  as stage_code,
            d.decided_by_actor_id::text   as actor_id,
            d.record_version              as record_version,
            d.basis_refs                  as basis_refs
       from recruitment.decision d
      where d.tenant_id = $1::uuid
        and d.application_id = $2::uuid
        and d.decision_scope = $3
      order by d.created_at asc, d.id asc`,
    [TENANT, applicationId, decisionScope],
  )
}

/** 申请钉住版本的独立 SQL 事实（rubric/resume/阶段/版本）。 */
interface PinnedFacts {
  readonly rubric_version_id: string
  readonly rubric_payload_hash: string
  readonly resume_version_id: string
  readonly resume_content_sha256: string
  readonly current_stage_code: string
  readonly record_version: number
}

async function pinnedFacts(applicationId: string): Promise<PinnedFacts> {
  const rows = await query<PinnedFacts>(
    `select a.rubric_version_id::text        as rubric_version_id,
            rv.payload_hash                  as rubric_payload_hash,
            a.resume_version_id::text        as resume_version_id,
            rvv.content_sha256               as resume_content_sha256,
            a.current_stage_code             as current_stage_code,
            a.record_version                 as record_version
       from recruitment.application a
       join recruitment.rubric_version rv
         on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
       join recruitment.resume_version rvv
         on rvv.id = a.resume_version_id and rvv.tenant_id = a.tenant_id
      where a.id = $1::uuid and a.tenant_id = $2::uuid`,
    [applicationId, TENANT],
  )
  const row = rows[0]
  assert.ok(row !== undefined, `申请 ${applicationId} 的钉住事实必须存在`)
  return row
}

/** 已提交面评 id（独立 SQL；按 interviewer_id, id 排序）。 */
async function scorecardIdsOf(applicationId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `select s.id::text as id
       from recruitment.scorecard s
       join recruitment.interview i
         on i.id = s.interview_id and i.tenant_id = s.tenant_id
      where s.tenant_id = $1::uuid
        and i.application_id = $2::uuid
        and s.superseded_by_scorecard_id is null
        and s.status in ('SUBMITTED', 'WAIVED')
      order by s.interviewer_id asc, s.id asc`,
    [TENANT, applicationId],
  )
  return rows.map((row) => row.id)
}

/** `decision.record` 事件（独立 SQL 读回）。 */
interface EventRow {
  readonly event_id: string
  readonly event_type: string
  readonly source_object_id: string
  readonly payload: Record<string, unknown>
}

async function eventsFor(decisionId: string): Promise<EventRow[]> {
  return await query<EventRow>(
    `select e.event_id::text        as event_id,
            e.event_type              as event_type,
            e.source_object_id        as source_object_id,
            e.payload                 as payload
       from recruitment.event_inbox e
      where e.tenant_id = $1::uuid
        and e.event_type = 'decision.record'
        and e.source_object_id = $2::text
      order by e.recorded_at asc, e.event_id asc`,
    [TENANT, decisionId],
  )
}

/** 目标表行数（独立 SQL；负例零写入断言用）。 */
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

/** 申请状态事实（独立 SQL；负例断言「被拦的决策不动申请」）。 */
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

/** 负例统一断言：目标表行数不变 + 申请 record_version/阶段不变（= 零写入）。 */
async function assertUnchanged(
  applicationId: string,
  before: Counts,
  appBefore: AppFacts,
  label: string,
): Promise<void> {
  assert.deepEqual(await counts(), before, `${label}：decision/event_inbox 行数必须不变（零写入）`)
  assert.deepEqual(await appFacts(applicationId), appBefore, `${label}：application.record_version/阶段必须不变`)
}

/** 从 basis_refs 里取所有 kind。 */
function kindsOf(refs: ReadonlyArray<Record<string, unknown>>): string[] {
  return refs
    .map((ref) => (typeof ref.kind === 'string' ? ref.kind : ''))
    .filter((kind) => kind !== '')
}

/** 取指定 kind 的第一条依据（缺失即断言失败）。 */
function refOfKind(
  refs: ReadonlyArray<Record<string, unknown>>,
  kind: string,
): Record<string, unknown> {
  const ref = refs.find((candidate) => candidate.kind === kind)
  assert.ok(ref !== undefined, `basis_refs 缺 ${kind}（实际 kinds=${kindsOf(refs).join(',')}）`)
  return ref
}

/** 工具出参里有没有指定 code 的 warning。 */
function hasWarning(output: Record<string, unknown>, code: string): boolean {
  const warnings = Array.isArray(output.warnings) ? output.warnings : []
  return warnings.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    return (entry as Record<string, unknown>).code === code
  })
}

/** 一次工具错误的稳定码（message 形态 `<CODE>: <compact-json>`）。 */
interface ToolErrorBody {
  readonly code: string
  readonly reason_code: string
  readonly raw: string
}

/** 调工具并**要求它失败**；成功即测试失败。 */
async function expectError(
  args: unknown,
  exec: unknown,
  target: ReadonlyToolDefinition = tool,
): Promise<ToolErrorBody> {
  try {
    await target.execute(args, exec)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    const body = errorBody(error)
    // 两代错误信封并存：工具层 `<CODE>: {"code":...}`；Demo Actor 层只把 code 写在 message 前缀
    // （`DEMO_ACTOR_UNMAPPED: {"reason_code":"SESSION_NOT_BOUND",...}`），body 里没有 code 键。
    const prefix = raw.indexOf(': ') >= 0 ? raw.slice(0, raw.indexOf(': ')) : raw
    return {
      code: typeof body.code === 'string' ? body.code : prefix,
      reason_code: String(body.reason_code),
      raw,
    }
  }
  assert.fail('期望工具 fail-closed（抛 RecruitmentToolError），但 execute 成功返回了')
}

/** 一句人工确认原话（IN_CHAT；服务端算 hash 的那个 pre-image 输入）。 */
function humanConfirmation(text: string): Record<string, unknown> {
  return { confirmed_at: recentIso(), method: 'IN_CHAT', text }
}

/** 1 分钟前的 ISO 时间（在领域 24h 确认窗口内、且不含未来值）。 */
function recentIso(): string {
  return new Date(Date.now() - 60_000).toISOString()
}



