// `recruitment_interview_record_verify`（S9 记录线人类核验入口，D-B 修复）的**真库**集成矩阵。
//
// 连 `ra_s6s7`（`test/integration/db.ts` 的 `inRolledBackTx`：REPEATABLE READ + 结束一律
// ROLLBACK，不污染共享库）。覆盖任务书要求的机检面：
//   * transcript_import → 核验工具（approval 允许一次）→ 读回 interview_record.state=VERIFIED；
//   * 闸门被拒（rejected / unavailable）→ `FORBIDDEN` 且**零写入**（两条状态轴、record_version、
//     审计事件条数全部不变）；
//   * 前置不满足（转写未 READY / 无片段 / evidence_ok=false / rubric 过期 / 非当前行 /
//     状态不可核验 / 记录不存在）→ 结构化拒绝 + 零写入，且**根本不问人**（approve 不被调用）；
//   * 幂等：重复核验 → outcome=NO_OP、不问人、不写第二条审计、record_version 不变；
//   * `evaluation_summarize` 前后对比：`RECORD_NOT_READY` 消失、record.state=READY、
//     ready_for_decision 仍正确、summary_digest 因记录状态进入 DC-20 子集而变化；
//   * `decision_record` 引用 `INTERVIEW_RECORD` 依据：核验前被 DC-23 挡住
//     （`RECORD_NOT_VERIFIED`），核验后能落库且 basis_refs 逐字读回。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ApprovalOutcome } from '../../src/tools/job-rubric-approve.ts'
import { canonicalJson } from '../../src/tools/contract.ts'
import { confirmationTextSha256, recordDecisionInTransaction } from '../../src/tools/decision-record.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'
import { importTranscriptInTransaction } from '../../src/tools/transcript-import.ts'
import {
  INTERVIEW_RECORD_VERIFY_TOOL,
  VERIFIABLE_FROM,
  VERIFIED_TO,
  verifyInterviewRecordInTransaction,
  type InterviewRecordVerifyValue,
} from '../../src/tools/interview-record-verify.ts'
import {
  createTestPool,
  errorBody,
  hex64,
  HR_ACTOR,
  inRolledBackTx,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg: ResolvedDatabaseConfig = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 面试官编号（0002_seed 里的 HUMAN actor）。 */
const INTERVIEWER_ACTOR = '11111111-1111-4111-8111-000000000104'
/** 一条硬性维度（只为让 rubric / 面评合法）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]
const DIMENSION_KEYS = DIMENSIONS.map((dimension) => dimension.key)
/** `as_of` 必须是"过去的、带偏移的"时刻（两个工具共用同一个值才能对齐 digest）。 */
const AS_OF = new Date(Date.now() - 60 * 60 * 1000).toISOString()

/** 一轮夹具：申请 + 面试 + 会议绑定 + 必交面试官 + 已交面评。 */
interface Panel {
  readonly applicationId: string
  readonly interviewId: string
  readonly meetingId: string
  readonly rubricId: string
  readonly interviewerId: string
  readonly scorecardId: string
}

/**
 * 造"申请（seedScenario）+ 面试 + 会议 + 绑定 + 面试官 + 面评"。
 * 面试用 `POST_INTERVIEW`（转写导入要求绑定 active 会议），与 Golden Path 的 S9 同形。
 * @param client - 事务内客户端。
 * @param options - `pinRubric=false` 用来测"申请没钉 rubric"。
 */
async function seedPanel(
  client: DatabaseClient,
  options: { readonly pinRubric?: boolean } = {},
): Promise<Panel> {
  const scenario = await seedScenario(client, {
    dimensions: DIMENSIONS,
    ...(options.pinRubric === false ? { pinRubric: false } : {}),
  })
  // DC-07 阶段闸门（task-71，2026-11-15）：本文件的决策用例全部是 S10 STAGE 决策，
  // 申请必须先处于 S10（seedScenario 默认 S7）。
  await client.query(
    "update recruitment.application set current_stage_code = 'S10' where id = $1::uuid and tenant_id = $2::uuid",
    [scenario.applicationId, TENANT],
  )
  const interviewResult = await client.query<{ id: string }>(
    `insert into recruitment.interview
       (tenant_id, application_id, round_no, slot_code, stage_code, status,
        scheduled_start_at, scheduled_end_at)
     values ($1, $2, 1, 'DEFAULT', 'S9', 'POST_INTERVIEW', now() - interval '2 hours', now() - interval '1 hour')
     returning id`,
    [TENANT, scenario.applicationId],
  )
  const interviewId = (interviewResult.rows[0] as { id: string }).id
  const meetingResult = await client.query<{ id: string }>(
    `insert into recruitment.meeting
       (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
     values ($1, 'FEISHU', $2, 'PRIMARY', now() - interval '2 hours', now() - interval '1 hour')
     returning id`,
    [TENANT, `mtg-${uniqueSuffix()}`],
  )
  const meetingId = (meetingResult.rows[0] as { id: string }).id
  await client.query(
    `insert into recruitment.meeting_binding
       (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
     values ($1, $2, $3, 'MANUAL', $4)`,
    [TENANT, meetingId, interviewId, HR_ACTOR],
  )
  const interviewerResult = await client.query<{ id: string }>(
    `insert into recruitment.interviewer
       (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
     values ($1, $2, $3, 'INTERVIEWER', true, now() - interval '1 hour')
     returning id`,
    [TENANT, interviewId, INTERVIEWER_ACTOR],
  )
  const interviewerId = (interviewerResult.rows[0] as { id: string }).id
  const items: Record<string, unknown> = { transcript_basis: 'TRANSCRIPT' }
  for (const key of DIMENSION_KEYS) {
    items[key] = { assessment: 'MET', score: 4, note: `${key} 现场表现（夹具）`, evidence: [] }
  }
  const scorecardResult = await client.query<{ id: string }>(
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, items, overall, rationale, payload_hash, status_changed_by_actor_id)
     values ($1, $2, $3, $4, 1, 'SUBMITTED', now(), $5::jsonb, 'ADVANCE', $6, $7, $8)
     returning id`,
    [
      TENANT,
      interviewId,
      interviewerId,
      scenario.rubricId,
      JSON.stringify(items),
      'REJECT_REASONS_JSON: []',
      hex64(`scorecard:${uniqueSuffix()}`),
      INTERVIEWER_ACTOR,
    ],
  )
  return {
    applicationId: scenario.applicationId,
    interviewId,
    meetingId,
    rubricId: scenario.rubricId,
    interviewerId,
    scorecardId: (scorecardResult.rows[0] as { id: string }).id,
  }
}

/** 一条合成转写正文（R7：只用合成文本，不是真实会议记录）。 */
const CONTENT = '00:00 面试官：请介绍最近的项目。\n00:12 候选人：做了招聘系统。'

/**
 * 跑一次转写导入（同一事务），返回 record id（`importTranscriptInTransaction` 的出参）。
 * @param client - 事务内客户端。
 * @param interviewId - 面试 id。
 * @param content - 合成正文。
 */
async function importTranscript(
  client: DatabaseClient,
  interviewId: string,
  content = CONTENT,
): Promise<string> {
  const value = await importTranscriptInTransaction(client, cfg, {
    interview_id: interviewId,
    content,
    source_kind: 'DEMO_SAMPLE',
  }, Date.now())
  assert.ok(value.record !== undefined, '夹具要求申请已钉 rubric，必须建出 interview_record')
  return String(value.record.id)
}

/** 调一次汇总（同一事务）。 */
async function summarize(
  client: DatabaseClient,
  panel: Panel,
): Promise<Record<string, unknown>> {
  return await computeEvaluationSummaryIn(client, cfg, {
    application_id: panel.applicationId,
    decision_scope: 'STAGE',
    interview_id: panel.interviewId,
    as_of: AS_OF,
  }, Date.now()) as unknown as Record<string, unknown>
}

/** 该记录的工具审计事件条数（`interview.record.verified`）。 */
async function verifyEventCount(client: DatabaseClient, recordId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'interview.record.verified'
        and payload->>'interview_record_id' = $2`,
    [TENANT, recordId],
  )
  return Number(rows[0]?.n ?? 0)
}

/** 该记录的库触发器状态迁移审计事件条数（`interview_record.status.changed`）。 */
async function statusEventCount(client: DatabaseClient, recordId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `select count(*) as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'interview_record.status.changed'
        and payload->>'record_id' = $2`,
    [TENANT, recordId],
  )
  return Number(rows[0]?.n ?? 0)
}

/** 读回记录的两条状态轴 + 版本 + 审计列。 */
async function readRecord(client: DatabaseClient, recordId: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select id, interview_id, status, verification_status, evidence_ok, record_version, transcript_revision,
            status_source_event_id, status_changed_by_actor_id, is_current
       from recruitment.interview_record where tenant_id = $1 and id = $2`,
    [TENANT, recordId],
  )
  const row = rows[0]
  assert.ok(row !== undefined, '记录必须存在')
  return row
}

/** 断言一次调用抛某个 code / reason_code，返回错误体。 */
async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  reasonCode?: string,
): Promise<Record<string, unknown>> {
  let thrown: unknown
  try {
    await promise
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, `期望抛 ${code}（${reasonCode ?? '-'}）但调用成功了`)
  const body = errorBody(thrown)
  assert.equal(body.code, code, `期望 code=${code}，实际 ${String(body.code)}：${String(body.message)}`)
  if (reasonCode !== undefined) {
    assert.equal(body.reason_code, reasonCode, `期望 reason_code=${reasonCode}，实际 ${String(body.reason_code)}`)
  }
  return body
}

/** 审批桩：记录被问了几次、返回固定结论。 */
function approvalStub(outcome: ApprovalOutcome): { approve: () => Promise<ApprovalOutcome>; calls: () => number } {
  let calls = 0
  return {
    approve: async () => {
      calls += 1
      return outcome
    },
    calls: () => calls,
  }
}

// =====================================================================
//  T1 人机闸门：被拒 → 零写入
// =====================================================================

test('T1a 闸门 rejected：FORBIDDEN(APPROVAL_NOT_GRANTED)，两条状态轴 / record_version / 审计事件全不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    const before = await readRecord(client, recordId)
    const gate = approvalStub('rejected')

    const body = await rejectsWith(
      verifyInterviewRecordInTransaction(client, cfg, { interview_record_id: recordId }, gate.approve),
      'FORBIDDEN',
      'APPROVAL_NOT_GRANTED',
    )
    assert.equal(gate.calls(), 1, '业务校验都通过后必须问人（且只问一次）')
    assert.equal((body.detail as Record<string, unknown>).tool, INTERVIEW_RECORD_VERIFY_TOOL)

    const after = await readRecord(client, recordId)
    assert.deepEqual(after, before, '闸门被拒后记录行必须逐列不变（零写入）')
    assert.equal(after.status, VERIFIABLE_FROM.status)
    assert.equal(after.verification_status, VERIFIABLE_FROM.verification_status)
    assert.equal(await verifyEventCount(client, recordId), 0, '闸门被拒不得写审计事件')
    assert.equal(await statusEventCount(client, recordId), 0, '闸门被拒不得触发状态迁移审计')
  })
})

test('T1b 闸门 unavailable（headless 无通道）：FORBIDDEN(APPROVAL_UNAVAILABLE)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    const before = await readRecord(client, recordId)

    // 第四个参数缺省 = 没有 approval 依赖（与插件缺 answerer 时同一路径）。
    const body = await rejectsWith(
      verifyInterviewRecordInTransaction(client, cfg, { interview_record_id: recordId }),
      'FORBIDDEN',
      'APPROVAL_UNAVAILABLE',
    )
    assert.deepEqual(body.detail, { approval: 'unavailable', tool: INTERVIEW_RECORD_VERIFY_TOOL })
    assert.deepEqual(await readRecord(client, recordId), before)
    assert.equal(await verifyEventCount(client, recordId), 0)
  })
})

test('T1c 闸门允许一次：READY/VERIFIED 落库 + 一条工具审计事件 + 触发器状态审计', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    const before = await readRecord(client, recordId)

    const value = await verifyInterviewRecordInTransaction(
      client,
      cfg,
      { interview_record_id: recordId, reason: '证据与转写逐条对齐' },
      approvalStub('allowed-once').approve,
    ) as InterviewRecordVerifyValue

    // ---- 出参 ----
    assert.equal(value.outcome, 'VERIFIED')
    assert.equal(value.replayed, false)
    assert.deepEqual(value.gate, { requested: true, result: 'allowed-once' })
    assert.equal(value.record.id, recordId)
    assert.equal(value.record.status, VERIFIED_TO.status)
    assert.equal(value.record.verification_status, VERIFIED_TO.verification_status)
    assert.equal(value.record.previous_status, VERIFIABLE_FROM.status)
    assert.equal(value.record.previous_verification_status, VERIFIABLE_FROM.verification_status)
    assert.equal(value.record.transcript_revision, 1)
    assert.equal(value.record.evidence_ok, true)
    assert.equal(value.record.verified_by_actor_id, HR_ACTOR)
    assert.equal(value.record.verified_by_actor_kind, 'HUMAN')
    assert.equal(value.artifact?.segment_count, 2)
    assert.equal(value.artifact?.transcript_status, 'READY')
    assert.equal(value.artifact?.is_complete, true)
    assert.equal(value.artifact?.has_more, false)
    assert.equal(typeof value.artifact?.content_sha256, 'string')
    assert.deepEqual(value.changes.tables, ['interview_record', 'event_inbox'])
    assert.equal(value.changes.written, true)
    assert.equal(value.changes.event_ids.length, 1)

    // ---- DB 读回：两条状态轴 + 版本 + 审计列 ----
    const after = await readRecord(client, recordId)
    assert.equal(after.status, 'READY')
    assert.equal(after.verification_status, 'VERIFIED')
    assert.equal(after.evidence_ok, true)
    assert.equal(Number(after.record_version), Number(before.record_version) + 1, '状态迁移必须 +1 版本')
    assert.equal(after.status_changed_by_actor_id, HR_ACTOR, '审计 actor 来自事务 GUC')
    assert.ok(typeof after.status_source_event_id === 'string' && after.status_source_event_id.length === 36)

    // ---- 审计：一条工具事件 + 一条触发器状态迁移事件，并且工具事件的 payload 能对账 ----
    assert.equal(await verifyEventCount(client, recordId), 1)
    assert.equal(await statusEventCount(client, recordId), 1)
    const event = (await client.query<{ event_id: string; payload: Record<string, unknown>; source_object_id: string; normalizer_version: string }>(
      `select event_id, payload, source_object_id, normalizer_version from recruitment.event_inbox
        where tenant_id = $1 and event_type = $2 and payload->>'interview_record_id' = $3`,
      [TENANT, 'interview.record.verified', recordId],
    )).rows[0]
    assert.ok(event !== undefined)
    assert.equal(event.source_object_id, recordId)
    assert.equal(event.normalizer_version, 'schema/0001')
    assert.equal(event.event_id, value.changes.event_ids[0])
    assert.equal(event.payload.status_from, 'NEEDS_REVIEW')
    assert.equal(event.payload.status_to, 'READY')
    assert.equal(event.payload.verification_from, 'UNVERIFIED')
    assert.equal(event.payload.verification_to, 'VERIFIED')
    assert.equal(event.payload.interview_id, panel.interviewId)
    assert.equal(event.payload.application_id, panel.applicationId)
    assert.equal(event.payload.segment_count, 2)
    assert.equal(event.payload.reason, '证据与转写逐条对齐')
    assert.deepEqual(event.payload.gate, { requested: true, result: 'allowed-once' })
    // 触发器写的状态迁移事件就是行上 status_source_event_id 指向的那条。
    assert.equal(event.payload.status_source_event_id, after.status_source_event_id)
  })
})

test('T1d 幂等：重复核验 → NO_OP，不问人、零写入、不产生第二条审计、不重复 +版本', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    await verifyInterviewRecordInTransaction(client, cfg, { interview_record_id: recordId }, approvalStub('allowed-once').approve)

    const verified = await readRecord(client, recordId)
    const gate = approvalStub('rejected') // 若第二次还问人，就会 FORBIDDEN —— 正好当探针

    const second = await verifyInterviewRecordInTransaction(
      client,
      cfg,
      { interview_record_id: recordId },
      gate.approve,
    ) as InterviewRecordVerifyValue

    assert.equal(second.outcome, 'NO_OP')
    assert.equal(second.replayed, true)
    assert.deepEqual(second.gate, { requested: false, result: 'not-required' })
    assert.equal(gate.calls(), 0, '幂等重放不许再打扰人')
    assert.deepEqual(second.changes, { written: false, tables: [], event_ids: [] })
    assert.equal(second.record.record_version, Number(verified.record_version))
    assert.equal(second.record.previous_status, 'READY')
    assert.equal(second.record.previous_verification_status, 'VERIFIED')
    assert.equal(second.record.verified_by_actor_id, HR_ACTOR, '回显历史核验人（不是本次调用者）')

    assert.deepEqual(await readRecord(client, recordId), verified, '幂等重放后行必须逐列不变')
    assert.equal(await verifyEventCount(client, recordId), 1, '重复核验不得产生第二条审计事件')
    assert.equal(await statusEventCount(client, recordId), 1)
  })
})

// =====================================================================
//  T2 前置不满足 → 结构化拒绝 + 零写入 + 不问人
// =====================================================================

/** 前置负例的公共骨架：先造好合法记录，再按 `mutate` 破坏某个前置，然后断言拒绝且零写入。 */
async function expectPreconditionRefusal(input: {
  readonly client: DatabaseClient
  readonly recordId: string
  readonly code: string
  readonly reasonCode: string
  readonly mutate?: (client: DatabaseClient) => Promise<void>
}): Promise<Record<string, unknown>> {
  if (input.mutate !== undefined) await input.mutate(input.client)
  const before = await readRecord(input.client, input.recordId)
  const eventsBefore = await verifyEventCount(input.client, input.recordId)
  const statusEventsBefore = await statusEventCount(input.client, input.recordId)
  const gate = approvalStub('allowed-once')
  const body = await rejectsWith(
    verifyInterviewRecordInTransaction(
      input.client,
      cfg,
      { interview_record_id: input.recordId },
      gate.approve,
    ),
    input.code,
    input.reasonCode,
  )
  assert.equal(gate.calls(), 0, '前置不满足时**不得先弹窗打扰人**（先拒绝，后问人）')
  assert.deepEqual(await readRecord(input.client, input.recordId), before, '前置拒绝必须零写入')
  assert.equal(await verifyEventCount(input.client, input.recordId), eventsBefore, '前置拒绝不得写审计事件')
  assert.equal(await statusEventCount(input.client, input.recordId), statusEventsBefore)
  return body
}

test('T2a 转写不是 READY → BLOCKED_BY_REVIEW(TRANSCRIPT_NOT_READY)，零写入且不问人', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    const body = await expectPreconditionRefusal({
      client,
      recordId,
      code: 'BLOCKED_BY_REVIEW',
      reasonCode: 'TRANSCRIPT_NOT_READY',
      mutate: async (tx) => {
        // `ck_transcript_artifact_not_complete`：is_complete=true 只允许配 READY，
        // 所以模拟"分页断过、只取到部分"必须同时把完整性降下来。
        await tx.query(
          `update recruitment.transcript_artifact set transcript_status = 'PARTIAL', is_complete = false
            where tenant_id = $1 and id = (select transcript_artifact_id from recruitment.interview_record
                                             where tenant_id = $1 and id = $2)`,
          [TENANT, recordId],
        )
      },
    })
    assert.equal((body.detail as Record<string, unknown>).transcript_status, 'PARTIAL')
  })
})

test('T2b 转写没有任何片段 → BLOCKED_BY_REVIEW(TRANSCRIPT_NO_SEGMENTS)，零写入且不问人', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    await expectPreconditionRefusal({
      client,
      recordId,
      code: 'BLOCKED_BY_REVIEW',
      reasonCode: 'TRANSCRIPT_NO_SEGMENTS',
      mutate: async (tx) => {
        // 片段不是历史事实表（无禁删触发器），删掉即可模拟"产物没切出任何片段"。
        await tx.query(
          `delete from recruitment.transcript_segment
            where tenant_id = $1 and artifact_id = (select transcript_artifact_id from recruitment.interview_record
                                                      where tenant_id = $1 and id = $2)`,
          [TENANT, recordId],
        )
      },
    })
  })
})

test('T2c evidence_ok=false → BLOCKED_BY_REVIEW(EVIDENCE_OK_FALSE)，零写入且不问人', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    await expectPreconditionRefusal({
      client,
      recordId,
      code: 'BLOCKED_BY_REVIEW',
      reasonCode: 'EVIDENCE_OK_FALSE',
      mutate: async (tx) => {
        await tx.query(
          'update recruitment.interview_record set evidence_ok = false where tenant_id = $1 and id = $2',
          [TENANT, recordId],
        )
      },
    })
  })
})

test('T2d 申请钉的 rubric 变了 → BLOCKED_BY_REVIEW(RECORD_RUBRIC_STALE)，零写入且不问人', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    const body = await expectPreconditionRefusal({
      client,
      recordId,
      code: 'BLOCKED_BY_REVIEW',
      reasonCode: 'RECORD_RUBRIC_STALE',
      mutate: async (tx) => {
        // 模拟"记录建好之后申请被改钉到另一版标准"（F1 之前真实出现过的错配场景）。
        await tx.query(
          'update recruitment.application set rubric_version_id = null where tenant_id = $1 and id = $2',
          [TENANT, panel.applicationId],
        )
      },
    })
    assert.equal((body.detail as Record<string, unknown>).application_rubric_pinned, false)
  })
})

test('T2e 非当前记录（已有新 revision 的新记录）→ INVALID_ARGS(RECORD_NOT_CURRENT)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const oldRecordId = await importTranscript(client, panel.interviewId)
    // 同一会议换内容再导入 → 旧 artifact 不再 canonical、旧 record is_current=false。
    await importTranscript(client, panel.interviewId, `${CONTENT}\n00:20 面试官：还有问题吗？`)
    const oldRow = await readRecord(client, oldRecordId)
    assert.equal(oldRow.is_current, false, '夹具要求旧记录不再 current')
    await expectPreconditionRefusal({
      client,
      recordId: oldRecordId,
      code: 'INVALID_ARGS',
      reasonCode: 'RECORD_NOT_CURRENT',
    })
  })
})

test('T2f 库允许但业务上不可核验的状态（PARTIAL/UNVERIFIED）→ INVALID_ARGS(STATUS_NOT_VERIFIABLE)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)
    await expectPreconditionRefusal({
      client,
      recordId,
      code: 'INVALID_ARGS',
      reasonCode: 'STATUS_NOT_VERIFIABLE',
      mutate: async (tx) => {
        // 直接改状态会走 fn_row_guard（actor 由 `inRolledBackTx` 的 GUC 提供）。
        await tx.query(
          "update recruitment.interview_record set status = 'PARTIAL' where tenant_id = $1 and id = $2",
          [TENANT, recordId],
        )
      },
    })
  })
})

test('T2g 记录不存在 → NOT_FOUND(INTERVIEW_RECORD_NOT_FOUND)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const gate = approvalStub('allowed-once')
    const body = await rejectsWith(
      verifyInterviewRecordInTransaction(
        client,
        cfg,
        { interview_record_id: '11111111-1111-4111-8111-00000000dead' },
        gate.approve,
      ),
      'NOT_FOUND',
      'INTERVIEW_RECORD_NOT_FOUND',
    )
    assert.equal(gate.calls(), 0)
    assert.equal((body.detail as Record<string, unknown>).interview_record_id, '11111111-1111-4111-8111-00000000dead')
  })
})

// =====================================================================
//  T3 端到端：import → summarize 前 → decision 前（被 DC-23 挡）→ verify → summarize 后 → decision 后
// =====================================================================

/** 构造一次 S10 STAGE 决策（HOLD；basis 含 SUMMARY / RUBRIC_VERSION / SCORECARD / INTERVIEW_RECORD）。 */
function decisionArgs(input: {
  readonly panel: Panel
  readonly summary: Record<string, unknown>
  readonly recordId: string
}): Record<string, unknown> {
  const basis: Record<string, unknown>[] = [
    {
      kind: 'SUMMARY',
      summary_digest: String(input.summary.summary_digest),
      contract_version: '2.0.0',
      coverage: input.summary.coverage,
      tally: input.summary.tally,
      consensus: input.summary.consensus,
      provenance: (input.summary.labels as Record<string, unknown>).provenance,
    },
    {
      kind: 'RUBRIC_VERSION',
      id: input.panel.rubricId,
      version_no: 1,
      payload_hash: (input.summary.rubric as Record<string, unknown>).payload_hash,
    },
    { kind: 'AUTHORITY', actor_id: HR_ACTOR, is_hiring_manager: false },
    {
      kind: 'SCORECARD',
      id: input.panel.scorecardId,
      revision_no: 1,
      interviewer_id: input.panel.interviewerId,
      overall: 'ADVANCE',
      transcript_basis: 'TRANSCRIPT',
      transcript_state: 'TRANSCRIPT',
      // 逐字照库里 items 的 assessment（依据必须能在面评里落地，DC-21/DC-24）。
      fields: DIMENSION_KEYS.map((key) => ({ dimension_key: key, assessment: 'MET', evidence: [] })),
    },
    {
      kind: 'INTERVIEW_RECORD',
      id: input.recordId,
    },
  ]
  const reason = '记录已核验，先挂起看下一轮反馈'
  const args: Record<string, unknown> = {
    application_id: input.panel.applicationId,
    decision_scope: 'STAGE',
    interview_id: input.panel.interviewId,
    as_of: AS_OF,
    result: 'HOLD',
    reason,
    basis_refs: basis,
    summary_digest: String(input.summary.summary_digest),
    human_confirmation: {
      confirmed_by_actor_id: HR_ACTOR,
      confirmed_at: new Date(Date.now() - 60 * 1000).toISOString(),
      confirmation_method: 'IN_APP_CONFIRM',
      // v1 pre-image：{result, reason, override_rationale, basis_refs}（DC §17.2）。
      confirmation_text_sha256: confirmationTextSha256({
        result: 'HOLD',
        reason,
        override_rationale: null,
        basis_refs: basis,
      }),
    },
  }
  return args
}

test('T3 端到端：核验前 summarize=NOT_READY 且决策被 DC-23 挡；核验后 summarize=READY 且决策能引 INTERVIEW_RECORD', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client)
    const recordId = await importTranscript(client, panel.interviewId)

    // ---- 1) 核验前：汇总给 NOT_READY + RECORD_NOT_READY ----
    const before = await summarize(client, panel)
    assert.equal((before.record as Record<string, unknown>).state, 'NOT_READY')
    assert.equal((before.record as Record<string, unknown>).verification_status, 'UNVERIFIED')
    assert.ok(
      (before.warnings as { code: string }[]).some((warning) => warning.code === 'RECORD_NOT_READY'),
      '核验前必须有 RECORD_NOT_READY 警告（这就是 D-B 的现象）',
    )
    assert.equal(before.ready_for_decision, true, '面板完整时 ready_for_decision 不受记录状态影响')
    assert.ok(
      (before.blockers as { code: string }[]).every((blocker) => blocker.code !== 'RECORD_NOT_VERIFIED'),
      '汇总侧不产生 RECORD_NOT_VERIFIED（只在决策引用 record 时出现）',
    )

    // ---- 2) 核验前：决策引用 INTERVIEW_RECORD 被 DC-23 挡 ----
    const blocked = await rejectsWith(
      recordDecisionInTransaction(
        client,
        cfg,
        decisionArgs({ panel, summary: before, recordId }),
        Date.now(),
        async () => 'allowed-once' as ApprovalOutcome,
      ),
      'BLOCKED_BY_REVIEW',
      'RECORD_NOT_VERIFIED',
    )
    const blocking = (blocked.detail as Record<string, unknown>).blocking_items as Record<string, unknown>[]
    assert.equal(blocking[0]?.interview_record_id, recordId)
    assert.equal(blocking[0]?.status, 'NEEDS_REVIEW')
    assert.equal(blocking[0]?.verification_status, 'UNVERIFIED')
    const decisionCountBefore = (await client.query<{ n: string }>(
      'select count(*) as n from recruitment.decision where tenant_id = $1 and application_id = $2',
      [TENANT, panel.applicationId],
    )).rows[0]?.n
    assert.equal(Number(decisionCountBefore), 0, '被挡的决策不得落库')

    // ---- 3) 核验（approval 允许一次）----
    const verified = await verifyInterviewRecordInTransaction(
      client,
      cfg,
      { interview_record_id: recordId },
      approvalStub('allowed-once').approve,
    )
    assert.equal(verified.outcome, 'VERIFIED')
    const row = await readRecord(client, recordId)
    assert.equal(row.status, 'READY')
    assert.equal(row.verification_status, 'VERIFIED')

    // ---- 4) 核验后：RECORD_NOT_READY 消失、record.state=READY ----
    const after = await summarize(client, panel)
    assert.equal((after.record as Record<string, unknown>).state, 'READY')
    assert.equal((after.record as Record<string, unknown>).verification_status, 'VERIFIED')
    assert.equal(
      (after.warnings as { code: string }[]).some((warning) => warning.code === 'RECORD_NOT_READY'),
      false,
      '核验后 RECORD_NOT_READY 必须消失',
    )
    assert.equal(after.ready_for_decision, true)
    assert.deepEqual(after.coverage, before.coverage)
    assert.deepEqual(after.blockers, before.blockers)
    assert.notEqual(after.summary_digest, before.summary_digest, 'record.verification_status 进 DC-20 子集，digest 必须变')

    // ---- 5) 核验后：同一个决策能落库，basis_refs 逐字读回 ----
    const recorded = await recordDecisionInTransaction(
      client,
      cfg,
      decisionArgs({ panel, summary: after, recordId }),
      Date.now(),
      async () => 'allowed-once' as ApprovalOutcome,
    ) as Record<string, unknown>
    const decision = recorded.decision as Record<string, unknown>
    assert.equal(decision.result, 'HOLD')
    const decisionRow = (await client.query<{ id: string; basis_refs: Record<string, unknown>[]; decision_scope: string; stage_code: string; decision_result: string }>(
      `select id, basis_refs, decision_scope, stage_code, result as decision_result
         from recruitment.decision where tenant_id = $1 and application_id = $2`,
      [TENANT, panel.applicationId],
    )).rows[0]
    assert.ok(decisionRow !== undefined, '决策必须落库')
    assert.equal(decisionRow.decision_scope, 'STAGE')
    assert.equal(decisionRow.stage_code, 'S10')
    assert.equal(decisionRow.decision_result, 'HOLD')
    const recordRefs = decisionRow.basis_refs.filter((ref) => ref.kind === 'INTERVIEW_RECORD')
    assert.equal(recordRefs.length, 1, 'basis_refs 里必须真的引用 INTERVIEW_RECORD')
    assert.equal(recordRefs[0]?.id, recordId)
    // 依据读取的 record 就是核验过的那条（DC-23 的读侧判定已通过）。
    const readBack = await readRecord(client, recordId)
    assert.equal(readBack.status, 'READY')
    assert.equal(readBack.verification_status, 'VERIFIED')
    assert.notEqual(decisionRow.id, '')
    assert.equal(createHash('sha256').update(canonicalJson(decisionRow.basis_refs)).digest('hex').length, 64)
  })
})
