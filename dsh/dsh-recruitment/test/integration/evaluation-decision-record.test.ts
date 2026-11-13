// S10 决策工具的真库行为（`inRolledBackTx` + `recordDecisionInTransaction`，**不调 execute()**）。
//
// 为什么不在测试里调 `execute()`：它自建连接池，看不到本事务里未提交的夹具
// （DESIGN §6）。approval 结果以回调形式直接注入，覆盖 D-79 的三种落点。
//
// 覆盖（任务书 integration 清单）：
//   1) HOLD 在缺面评时成功（安全方向不受缺失/零面评影响，DC §4.2.1）
//   2) REJECT 缺面评 → SCORECARD_MISSING
//   3) ADVANCE(STAGE) 缺人不带 ack → MISSING_ACK_REQUIRED
//   4) ADVANCE(STAGE) 缺人带 ack → 成功（含 MISSING_ACK basis 与 warning）
//   5) ADVANCE(FINAL) 缺人 → SCORECARD_MISSING（ack 不放行）
//   6) 零提交 ADVANCE → EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)；零提交 WITHDRAW 成功
//   7) SUMMARY_STALE（digest 不是本次重算值）
//   8) 第二次同 scope 决策 → ALREADY_DECIDED
//   9) 撤回三步舞：current 恰好 1 行、旧行 record_version=2、内部事件存在、source_object_id=新 id
//  10) decided_by_actor_id = 事务 GUC actor、stage_code='S10'、basis_refs 落库逐字相同
//  11) REJECT 无反对票 → EVIDENCE_INSUFFICIENT(REJECT_WITHOUT_REJECTING_SCORECARD)
//  12) REJECT 依据落在 unreadable → BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE)
//  13) 正常的 REJECT（1 反 1 通过，SPLIT）成功且 basis_refs 逐字落库
//  14) 决策人非招聘负责人 → 成功 + DECIDER_NOT_HIRING_MANAGER warning（不拦）
//  15) approval 未批（unavailable / rejected）→ 一行都不写；门禁失败时**根本不问人**
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { canonicalJson, digestOf } from '../../src/tools/contract.ts'
import {
  confirmationTextSha256,
  recordDecisionInTransaction,
  type ApprovalOutcome,
} from '../../src/tools/decision-record.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  HR_ACTOR,
  TENANT,
  createTestPool,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg: ResolvedDatabaseConfig = testDatabaseConfig()
const pool = createTestPool(cfg)
test.after(async () => { await pool.end() })

const DIMENSION_KEYS = ['backend_depth', 'async_pipeline', 'frontend_basics'] as const
const RUBRIC_DIMENSIONS = [
  { key: 'backend_depth', label: '后端深度', kind: 'MUST_HAVE', weight: 0.5, question: '分库分表一致性怎么保证？' },
  { key: 'async_pipeline', label: '异步链路', kind: 'MUST_HAVE', weight: 0.3, question: '重试与幂等怎么保证？' },
  { key: 'frontend_basics', label: '前端基础', kind: 'MUST_HAVE', weight: 0.2, question: '写过哪些复杂交互？' },
]

/** 一条落库的面评（夹具用）。 */
interface SeededScorecard {
  readonly id: string
  readonly interviewerId: string
  readonly interviewerActorId: string
  readonly overall: string
  readonly revisionNo: number
  readonly payloadHash: string
  readonly items: Readonly<Record<string, unknown>>
}

interface Panel {
  readonly suffix: string
  readonly applicationId: string
  readonly interviewId: string
  readonly jobId: string
  readonly rubricId: string
  readonly rubricPayloadHash: string
  readonly managerActorId: string
  readonly deciderActorId: string
  readonly actors: { readonly x: string; readonly y: string; readonly z: string }
  readonly interviewerIds: { readonly x: string; readonly y: string; readonly z: string }
  readonly scorecards: readonly SeededScorecard[]
}

interface ScorecardSpec {
  readonly who: 'x' | 'y' | 'z'
  readonly overall: 'ADVANCE' | 'HOLD' | 'REJECT'
  readonly assessments?: Readonly<Record<string, 'MET' | 'NOT_MET' | 'NOT_OBSERVED' | 'UNREADABLE'>>
  readonly rejectDims?: readonly string[]
}

const NOW = Date.now()
const AS_OF = new Date(NOW - 60 * 60 * 1000).toISOString()

/**
 * 造一份完整夹具：部门（可无招聘负责人）→ 岗位/标准/申请（seedScenario）→ 面试 →
 * 3 名面试官（可只让前 N 名必交）→ 若干已提交面评。
 */
async function seedPanel(
  client: DatabaseClient,
  options: {
    readonly requiredCount?: number
    readonly scorecards?: readonly ScorecardSpec[]
    readonly hiringManager?: 'other' | 'none'
    /** false = 申请不绑材料（S7 写侧"材料版本不存在"的负例要用）。 */
    readonly bindMaterial?: boolean
  } = {},
): Promise<Panel> {
  const suffix = uniqueSuffix()
  const mkActor = async (label: string): Promise<string> => one(client, `insert into recruitment.actor
      (tenant_id, kind, display_name) values ($1, 'HUMAN', $2) returning id`, [TENANT, `评价线测试-${label}-${suffix}`])
  const managerActorId = await mkActor('经理')
  const actors = { x: await mkActor('面试官X'), y: await mkActor('面试官Y'), z: await mkActor('面试官Z') }
  const hiringManagerActorId = options.hiringManager === 'none' ? null : managerActorId
  const departmentId = await one(client, `insert into recruitment.department
      (tenant_id, name, hiring_manager_actor_id) values ($1, $2, $3) returning id`,
  [TENANT, `评价线测试部门-${suffix}`, hiringManagerActorId])

  const scenario = await seedScenario(client, {
    dimensions: RUBRIC_DIMENSIONS.map((dimension) => ({ ...dimension })),
    departmentId,
    ...(options.bindMaterial === undefined ? {} : { bindMaterial: options.bindMaterial }),
  })
  const rubricRow = (await client.query<{ payload_hash: string }>(
    'select payload_hash from recruitment.rubric_version where id = $1',
    [scenario.rubricId],
  )).rows[0]
  assert.ok(rubricRow !== undefined, 'rubric 必须存在')

  const interviewId = await one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, stage_code, status, scheduled_start_at, scheduled_end_at)
      values ($1, $2, 1, 'DEFAULT', 'S8', 'POST_INTERVIEW',
              now() - interval '1 day', now() - interval '23 hours') returning id`,
  [TENANT, scenario.applicationId])

  const requiredCount = options.requiredCount ?? 3
  const interviewerIds: Record<'x' | 'y' | 'z', string> = { x: '', y: '', z: '' }
  const order: ('x' | 'y' | 'z')[] = ['x', 'y', 'z']
  for (const [index, who] of order.entries()) {
    interviewerIds[who] = await one(client, `insert into recruitment.interviewer
        (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
        values ($1, $2, $3, 'INTERVIEWER', $4, now() - interval '1 day') returning id`,
    [TENANT, interviewId, actors[who], index < requiredCount])
  }

  const scorecards: SeededScorecard[] = []
  for (const spec of options.scorecards ?? []) {
    const items: Record<string, unknown> = { transcript_basis: 'NO_TRANSCRIPT' }
    for (const key of DIMENSION_KEYS) {
      const assessment = spec.assessments?.[key] ?? 'MET'
      items[key] = {
        assessment,
        score: assessment === 'MET' ? 4 : assessment === 'NOT_MET' ? 2 : null,
        note: assessment === 'NOT_MET' ? `${key} 现场给了反证` : `${key} 现场表现（夹具）`,
        evidence: [],
      }
    }
    const rejectReasons = (spec.rejectDims ?? []).map((dimensionKey) => ({
      dimension_key: dimensionKey,
      observation: `${dimensionKey} 两次澄清仍答不出`,
      why_decisive: `${dimensionKey} 是该岗位的 MUST_HAVE`,
      evidence: [],
    }))
    // G-1：`scorecard` 没有 reject_reasons 列 → 固定编码进 rationale（DESIGN §3.5 ②）。
    const rationale = `REJECT_REASONS_JSON: ${canonicalJson(rejectReasons)}`
    const payloadHash = createHash('sha256').update(canonicalJson({
      interview_id: interviewId,
      rubric_version_id: scenario.rubricId,
      items,
      overall: spec.overall,
      reject_reasons: rejectReasons,
    }), 'utf8').digest('hex')
    const id = await one(client, `insert into recruitment.scorecard
        (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
         submitted_at, items, overall, rationale, payload_hash, status_changed_by_actor_id, status_changed_at)
        values ($1, $2, $3, $4, 1, 'SUBMITTED', now(), $5::jsonb, $6, $7, $8, $9, now()) returning id`,
    [TENANT, interviewId, interviewerIds[spec.who], scenario.rubricId, JSON.stringify(items),
      spec.overall, rationale, payloadHash, actors[spec.who]])
    scorecards.push({
      id,
      interviewerId: interviewerIds[spec.who],
      interviewerActorId: actors[spec.who],
      overall: spec.overall,
      revisionNo: 1,
      payloadHash,
      items,
    })
  }

  return {
    suffix,
    applicationId: scenario.applicationId,
    interviewId,
    jobId: scenario.jobId,
    rubricId: scenario.rubricId,
    rubricPayloadHash: rubricRow.payload_hash,
    managerActorId: options.hiringManager === 'none' ? '' : managerActorId,
    deciderActorId: HR_ACTOR,
    actors,
    interviewerIds,
    scorecards,
  }
}

/** 取一次汇总（**只用于拿 digest 与断言；工具内部会自己再算一次**）。 */
async function summaryOf(
  client: DatabaseClient,
  panel: Panel,
  scope: 'STAGE' | 'FINAL',
  asOf = AS_OF,
): Promise<Record<string, unknown>> {
  return await computeEvaluationSummaryIn(client, cfg, {
    application_id: panel.applicationId,
    decision_scope: scope,
    ...(scope === 'STAGE' ? { interview_id: panel.interviewId } : {}),
    as_of: asOf,
  }, Date.now()) as unknown as Record<string, unknown>
}

interface ArgsInput {
  readonly panel: Panel
  readonly summary: Record<string, unknown>
  readonly result: 'ADVANCE' | 'HOLD' | 'REJECT' | 'WITHDRAW'
  readonly scope?: 'STAGE' | 'FINAL'
  readonly reason?: string
  readonly decider?: string
  readonly isHiringManager?: boolean
  readonly overrideRationale?: string
  readonly acknowledgedDissent?: boolean
  readonly proceedWithMissing?: boolean
  readonly ackIds?: readonly string[]
  readonly includeScorecards?: boolean
  readonly includeOverrideBasis?: boolean
  readonly includeMissingAckBasis?: boolean
  readonly supersedes?: { decision_id: string; reason: string; expected_record_version: number }
  readonly summaryDigest?: string
  readonly asOf?: string
  readonly confirmedBy?: string
  readonly extraBasis?: readonly Record<string, unknown>[]
}

/** 按 TC §4.1 / §4.3 的形状造一次调用的入参（含人工确认 hash）。 */
function buildArgs(input: ArgsInput): Record<string, unknown> {
  const scope = input.scope ?? 'STAGE'
  const decider = input.decider ?? input.panel.deciderActorId
  const summary = input.summary
  const isHiringManager = input.isHiringManager ?? false
  const includeScorecards = input.includeScorecards ?? true
  const basis: Record<string, unknown>[] = [
    {
      kind: 'SUMMARY',
      summary_digest: String(summary.summary_digest),
      contract_version: '2.0.0',
      coverage: summary.coverage,
      tally: summary.tally,
      consensus: summary.consensus,
      provenance: (summary.labels as Record<string, unknown>).provenance,
    },
    { kind: 'RUBRIC_VERSION', id: input.panel.rubricId, version_no: 1, payload_hash: input.panel.rubricPayloadHash },
    { kind: 'AUTHORITY', actor_id: decider, is_hiring_manager: isHiringManager },
  ]
  if (includeScorecards) {
    for (const scorecard of input.panel.scorecards) {
      basis.push({
        kind: 'SCORECARD',
        id: scorecard.id,
        revision_no: scorecard.revisionNo,
        interviewer_id: scorecard.interviewerId,
        payload_hash: scorecard.payloadHash,
        overall: scorecard.overall,
        transcript_basis: 'NO_TRANSCRIPT',
        transcript_state: 'NO_TRANSCRIPT',
        // 逐字照库里 items 的 assessment（依据必须能在面评里落地，DC-21/DC-24）
        fields: DIMENSION_KEYS.map((key) => ({
          dimension_key: key,
          assessment: (scorecard.items[key] as { assessment?: string } | undefined)?.assessment ?? 'MET',
          evidence: [],
        })),
      })
    }
  }
  if (input.includeOverrideBasis === true) {
    basis.push({
      kind: 'OVERRIDE',
      acknowledged_dissent: true,
      override_rationale: input.overrideRationale ?? '面板多数通过，但硬性维度有明确反证',
    })
  }
  if (input.includeMissingAckBasis === true) {
    basis.push({ kind: 'MISSING_ACK', interviewer_ids: [...(input.ackIds ?? [])], rationale: '他们的维度已被交叉覆盖' })
  }
  if (input.supersedes !== undefined) {
    basis.push({
      kind: 'SUPERSEDES',
      decision_id: input.supersedes.decision_id,
      reason: input.supersedes.reason,
      opened_by_actor_id: decider,
    })
  }
  for (const extra of input.extraBasis ?? []) basis.push(extra)

  const args: Record<string, unknown> = {
    application_id: input.panel.applicationId,
    decision_scope: scope,
    ...(scope === 'STAGE' ? { interview_id: input.panel.interviewId } : {}),
    as_of: input.asOf ?? AS_OF,
    result: input.result,
    reason: input.reason ?? '暂不决定：等第三位面试官补评',
    basis_refs: basis,
    summary_digest: input.summaryDigest ?? String(summary.summary_digest),
    human_confirmation: {},
    ...(input.proceedWithMissing === true ? {
      missing_disposition: 'PROCEED_WITH_MISSING',
      acknowledged_missing: (input.ackIds ?? []).map((interviewerId) => ({
        interviewer_id: interviewerId,
        why_proceed: '他的维度已由 X/Y 交叉覆盖，下一轮会补',
      })),
    } : {}),
    ...(input.acknowledgedDissent === undefined ? {} : { acknowledged_dissent: input.acknowledgedDissent }),
    ...(input.overrideRationale === undefined ? {} : { override_rationale: input.overrideRationale }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  }
  args.human_confirmation = {
    confirmed_by_actor_id: input.confirmedBy ?? decider,
    confirmed_at: new Date(NOW - 60 * 1000).toISOString(),
    confirmation_method: 'IN_APP_CONFIRM',
    confirmation_text_sha256: confirmationTextSha256({
      result: String(args.result),
      reason: String(args.reason),
      override_rationale: input.overrideRationale === undefined ? null : String(input.overrideRationale),
      basis_refs: basis,
    }),
  }
  return args
}

/** 默认批准（正例）。 */
const ALLOWED = async (): Promise<ApprovalOutcome> => 'allowed-once'

/** 从 `Error: <CODE>: <json>` 取错误体。 */
function bodyOf(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  assert.ok(index > 0, `错误消息不是 <CODE>: <json> 形态：${message}`)
  return JSON.parse(message.slice(index + 2)) as Record<string, unknown>
}

/** 断言一次调用抛某个 code/reason_code，并返回错误体。 */
async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
  reasonCode?: string,
): Promise<Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    const body = bodyOf(error)
    assert.equal(body.code, code, `期望 code=${code}，实际 ${String(body.code)}：${String(body.message)}`)
    if (reasonCode !== undefined) {
      assert.equal(body.reason_code, reasonCode, `期望 reason_code=${reasonCode}，实际 ${String(body.reason_code)}：${String(body.message)}`)
    }
    return body
  }
  assert.fail(`期望抛 ${code}（${reasonCode ?? '-'}）但调用成功了`)
}

/** 读回某申请的决策行（按 decided_at 升序）。 */
async function decisionsOf(client: DatabaseClient, applicationId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select id, result, record_version, superseded_by_decision_id, decided_by_actor_id, stage_code,
            decision_scope, interview_id, basis_refs, reason, decided_at
       from recruitment.decision
      where tenant_id = $1 and application_id = $2
      order by decided_at asc, id asc`,
    [TENANT, applicationId],
  )
  return rows
}

async function currentCount(client: DatabaseClient, applicationId: string, scope: 'STAGE' | 'FINAL'): Promise<number> {
  const { rows } = await client.query<{ current_count: number }>(
    `select count(*)::int as current_count
       from recruitment.decision
      where tenant_id = $1 and application_id = $2 and decision_scope = $3
        and stage_code = 'S10' and superseded_by_decision_id is null`,
    [TENANT, applicationId, scope],
  )
  return rows[0]?.current_count ?? -1
}

async function decisionEventCount(client: DatabaseClient, applicationId: string): Promise<number> {
  const { rows } = await client.query<{ c: number }>(
    `select count(*)::int as c from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'decision.record'
        and payload->>'application_id' = $2`,
    [TENANT, applicationId],
  )
  return rows[0]?.c ?? -1
}

function warningCodes(value: Record<string, unknown>): string[] {
  return (value.warnings as { code: string }[]).map((warning) => warning.code)
}

// =====================================================================
//  1. 安全方向：HOLD / WITHDRAW 不受缺失与零面评约束（§4.2.1）
// =====================================================================

test('HOLD 在缺 2 份必交面评时成功：不写任何状态、事件与行都在', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal(summary.coverage && (summary.coverage as Record<string, unknown>).submitted, 1)
    assert.equal((summary.missing as unknown[]).length, 2)

    const args = buildArgs({ panel, summary, result: 'HOLD' })
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    const decision = value.decision as Record<string, unknown>
    assert.equal(value.status, 'OK')
    assert.equal(value.contract_version, '2.0.0')
    assert.equal(value.replayed, false)
    assert.equal(decision.result, 'HOLD')
    assert.equal(decision.decision_scope, 'STAGE')
    assert.equal(decision.stage_code, 'S10')
    assert.equal(decision.record_version, 1)
    assert.equal(decision.superseded_by_decision_id, null)
    assert.equal(value.superseded, null)
    const gate = value.gate as Record<string, unknown>
    assert.equal(gate.ready_for_decision, summary.ready_for_decision)
    assert.equal(gate.summary_digest, summary.summary_digest)
    assert.equal(gate.as_of, AS_OF)
    assert.deepEqual(gate.acknowledged_missing, [])
    assert.deepEqual(gate.permitted_results_echo, summary.permitted_results)
    assert.equal((value.labels as Record<string, unknown>).provenance, 'FIXTURE')
    assert.ok(warningCodes(value).includes('FIXTURE_BASIS'))
    assert.equal(warningCodes(value).includes('DECIDER_NOT_HIRING_MANAGER'), true)
    assert.equal(warningCodes(value).includes('PROCEEDED_WITH_MISSING_SCORECARDS'), false)
    const event = value.event as Record<string, unknown>
    assert.equal(event.provider, 'internal')
    assert.equal(event.trust_level, 'INTERNAL')

    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, decision.id)
    assert.equal(await currentCount(client, panel.applicationId, 'STAGE'), 1)
    assert.equal(await decisionEventCount(client, panel.applicationId), 1)

    // DC-47 / N-5：不改任何状态
    const app = (await client.query<{ current_stage_code: string; lifecycle_status: string; record_version: number }>(
      'select current_stage_code, lifecycle_status, record_version from recruitment.application where id = $1',
      [panel.applicationId],
    )).rows[0]
    assert.equal(app?.current_stage_code, 'S7')
    assert.equal(app?.lifecycle_status, 'ACTIVE')
    const interview = (await client.query<{ status: string }>(
      'select status from recruitment.interview where id = $1',
      [panel.interviewId],
    )).rows[0]
    assert.equal(interview?.status, 'POST_INTERVIEW')
  })
})

test('零面评时 ADVANCE → NO_SUBMITTED_SCORECARD（先决），WITHDRAW 成功且 0 条 SCORECARD basis', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2 })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal((summary.coverage as Record<string, unknown>).submitted, 0)

    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary, result: 'ADVANCE' }), NOW, ALLOWED),
      'EVIDENCE_INSUFFICIENT',
      'NO_SUBMITTED_SCORECARD',
    )
    const rowsAfterAdvance = await decisionsOf(client, panel.applicationId)
    assert.equal(rowsAfterAdvance.length, 0, '被拦的 ADVANCE 不得留下任何决策行')

    const value = await recordDecisionInTransaction(
      client, cfg, buildArgs({ panel, summary, result: 'WITHDRAW', reason: '候选人已接受别的 offer，主动撤回' }), NOW, ALLOWED,
    )
    assert.equal((value.decision as Record<string, unknown>).result, 'WITHDRAW')
    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1)
    const basis = rows[0]?.basis_refs as Record<string, unknown>[]
    assert.equal(basis.filter((ref) => ref.kind === 'SCORECARD').length, 0, '零面评的 WITHDRAW 允许 0 条 SCORECARD 依据')
  })
})

// =====================================================================
//  2. 缺面评的放行/阻断（不对称）
// =====================================================================

test('REJECT 缺 1 份必交面评 → SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [{ who: 'x', overall: 'REJECT', assessments: { backend_depth: 'NOT_MET' }, rejectDims: ['backend_depth'] }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal((summary.missing as unknown[]).length, 2)
    const body = await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'REJECT', reason: 'backend_depth 两次澄清仍无容量估算',
      }), NOW, ALLOWED),
      'SCORECARD_MISSING',
      'REQUIRED_SCORECARDS_INCOMPLETE',
    )
    assert.ok(Array.isArray((body.detail as Record<string, unknown>).missing))
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('ADVANCE(STAGE) 缺人：不带 ack → MISSING_ACK_REQUIRED；ack 集合不等 → MISSING_ACK_MISMATCH；带全 → 成功', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    const missingIds = (summary.missing as { interviewer_id: string }[]).map((entry) => entry.interviewer_id)
    assert.equal(missingIds.length, 2)

    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary, result: 'ADVANCE' }), NOW, ALLOWED),
      'INVALID_ARGS',
      'MISSING_ACK_REQUIRED',
    )
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'ADVANCE', proceedWithMissing: true, ackIds: [missingIds[0] as string],
        includeMissingAckBasis: true,
      }), NOW, ALLOWED),
      'INVALID_ARGS',
      'MISSING_ACK_MISMATCH',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0, '被拦的两次都不得留行')

    const value = await recordDecisionInTransaction(client, cfg, buildArgs({
      panel,
      summary,
      result: 'ADVANCE',
      proceedWithMissing: true,
      ackIds: missingIds,
      includeMissingAckBasis: true,
    }), NOW, ALLOWED)
    const decision = value.decision as Record<string, unknown>
    assert.equal(decision.result, 'ADVANCE')
    assert.ok(warningCodes(value).includes('PROCEEDED_WITH_MISSING_SCORECARDS'))
    const gate = value.gate as Record<string, unknown>
    assert.equal(gate.missing_disposition, 'PROCEED_WITH_MISSING')
    assert.equal((gate.acknowledged_missing as unknown[]).length, 2)
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)
  })
})

test('ADVANCE(FINAL) 缺人：ack 不放行 → SCORECARD_MISSING（Q-5 取更严一侧）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'FINAL')
    const missingIds = (summary.missing as { interviewer_id: string }[]).map((entry) => entry.interviewer_id)
    assert.equal(missingIds.length, 2)
    const body = await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'ADVANCE', scope: 'FINAL', proceedWithMissing: true, ackIds: missingIds,
        includeMissingAckBasis: true, isHiringManager: false,
      }), NOW, ALLOWED),
      'SCORECARD_MISSING',
      'REQUIRED_SCORECARDS_INCOMPLETE',
    )
    assert.equal((body.detail as Record<string, unknown>).scope, 'FINAL')
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

// =====================================================================
//  3. 汇总绑定与重复
// =====================================================================

test('SUMMARY_STALE：digest 不是本次重算值（含 basis_refs[SUMMARY] 不一致）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const stale = 'b'.repeat(64)
    const staleArgs = buildArgs({ panel, summary, result: 'HOLD', summaryDigest: stale })
    // 入参 digest 与 SUMMARY basis 都换成旧值，确保先撞 digest 比对
    ;(staleArgs.basis_refs as Record<string, unknown>[])[0] = {
      ...(staleArgs.basis_refs as Record<string, unknown>[])[0] as Record<string, unknown>,
      summary_digest: stale,
    }
    // 重新算一次人工确认（pre-image 变了）
    const confirmation = staleArgs.human_confirmation as Record<string, unknown>
    confirmation.confirmation_text_sha256 = confirmationTextSha256({
      result: String(staleArgs.result),
      reason: String(staleArgs.reason),
      override_rationale: null,
      basis_refs: staleArgs.basis_refs as Record<string, unknown>[],
    })
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, staleArgs, NOW, ALLOWED),
      'INVALID_ARGS',
      'SUMMARY_STALE',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('同一 (申请, STAGE, S10) 第二次决策 → ALREADY_DECIDED（不插第二行）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'HOLD' })
    await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)

    // 第二次：数据没变，summary_digest 现在会带上 ALREADY_DECIDED blocker（digest 变），
    // 所以先重算再调用——STEP 3 在 STEP 4 之前，必先撞 ALREADY_DECIDED。
    const summaryAgain = await summaryOf(client, panel, 'STAGE')
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary: summaryAgain, result: 'HOLD' }), NOW, ALLOWED),
      'ALREADY_DECIDED',
      'SCOPE_ALREADY_DECIDED',
    )
    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1, '第二次调用不得新增行')
    assert.equal(rows[0]?.record_version, 1, 'record_version 不得变化')
  })
})

test('撤回三步舞：current 恰好 1 行、旧行 record_version=2、内部事件 source_object_id=新 id', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const first = await recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary, result: 'HOLD' }), NOW, ALLOWED)
    const firstId = String((first.decision as Record<string, unknown>).id)

    const summaryBeforeSupersede = await summaryOf(client, panel, 'STAGE')
    const secondArgs = buildArgs({
      panel,
      summary: summaryBeforeSupersede,
      result: 'HOLD',
      reason: '撤回上一次「暂不决定」：第三位面试官已补评，重新记录为待定（保持安全方向）',
      supersedes: { decision_id: firstId, reason: '第三位面试官已补评，重开一次决策', expected_record_version: 1 },
    })
    const second = await recordDecisionInTransaction(client, cfg, secondArgs, NOW, ALLOWED)
    const secondDecision = second.decision as Record<string, unknown>
    const secondId = String(secondDecision.id)
    assert.notEqual(secondId, firstId)
    assert.equal(secondDecision.record_version, 1)
    assert.deepEqual(second.superseded, { decision_id: firstId, record_version: 2 })
    assert.ok(warningCodes(second).includes('SUPERSEDES_APPLIED'))

    // current 恰好 1 行；旧行 +1 且单向指向新行
    assert.equal(await currentCount(client, panel.applicationId, 'STAGE'), 1)
    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 2, '两行都必须留着（DC-31：撤回=覆盖，不是删除）')
    const oldRow = rows.find((row) => row.id === firstId)
    const newRow = rows.find((row) => row.id === secondId)
    assert.equal(oldRow?.record_version, 2)
    assert.equal(oldRow?.superseded_by_decision_id, secondId)
    assert.equal(newRow?.superseded_by_decision_id, null)

    // 内部事件：两次都有一条，且新事件按 DC-38 绑定新 id
    assert.equal(await decisionEventCount(client, panel.applicationId), 2)
    const event = (await client.query<{
      event_id: string; provider: string; trust_level: string; idempotency_key: string
      idempotency_source: string; source_object_id: string; provider_event_id: string | null
    }>(
      `select event_id, provider, trust_level, idempotency_key, idempotency_source, source_object_id, provider_event_id
         from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'decision.record' and source_object_id = $2`,
      [TENANT, secondId],
    )).rows[0]
    assert.ok(event !== undefined, '新决策必须有内部事件')
    assert.equal(event?.provider, 'internal')
    assert.equal(event?.trust_level, 'INTERNAL')
    assert.equal(event?.idempotency_source, 'FALLBACK_KEY')
    assert.equal(event?.provider_event_id, null)
    assert.equal(event?.idempotency_key, `decision:${secondId}`)
  })
})

test('撤回：expected_record_version 不匹配 → VERSION_CONFLICT(DECISION_RECORD_VERSION_MISMATCH)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const first = await recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary, result: 'HOLD' }), NOW, ALLOWED)
    const firstId = String((first.decision as Record<string, unknown>).id)
    const summaryAgain = await summaryOf(client, panel, 'STAGE')
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel,
        summary: summaryAgain,
        result: 'HOLD',
        supersedes: { decision_id: firstId, reason: '重开', expected_record_version: 7 },
      }), NOW, ALLOWED),
      'VERSION_CONFLICT',
      'DECISION_RECORD_VERSION_MISMATCH',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)
  })
})

// =====================================================================
//  4. 身份 / 阶段码 / basis_refs 的落库口径
// =====================================================================

test('decided_by_actor_id = 事务 GUC actor（不是 cfg.actor_id）、stage_code=S10、basis_refs 逐字落库', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    // 把 GUC 换成另一个人（HUMAN），proves 决策人取自事务上下文而不是 cfg.actor_id
    const decider = panel.actors.y
    assert.notEqual(decider, cfg.actor_id)
    await client.query("select set_config('recruitment.actor_id', $1, true)", [decider])

    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'HOLD', decider })
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.equal((value.decision as Record<string, unknown>).decided_by_actor_id, decider)

    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.decided_by_actor_id, decider)
    assert.equal(rows[0]?.stage_code, 'S10')
    assert.equal(
      canonicalJson(rows[0]?.basis_refs),
      canonicalJson(args.basis_refs),
      'basis_refs 必须逐字落库（INV-9：不裁剪、不改写）',
    )
  })
})

test('决策人非招聘负责人 → 成功 + DECIDER_NOT_HIRING_MANAGER（v1.0 不拦截）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
      hiringManager: 'other',
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal((valueOf(summary, 'labels') as Record<string, unknown>).provenance, 'FIXTURE')
    const args = buildArgs({ panel, summary, result: 'HOLD', isHiringManager: false })
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.ok(warningCodes(value).includes('DECIDER_NOT_HIRING_MANAGER'))
    assert.equal(warningCodes(value).includes('HIRING_MANAGER_UNSET'), false)
    // AUTHORITY 计算值写进 basis_refs（不是采信入参）
    const authority = (args.basis_refs as Record<string, unknown>[]).find((ref) => ref.kind === 'AUTHORITY')
    assert.equal(authority?.is_hiring_manager, false)
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)
  })
})

test('部门没有招聘负责人 → 成功 + HIRING_MANAGER_UNSET；AUTHORITY 说 true → BASIS_AUTHORITY_MISMATCH', async () => {
  await inRolledBackTx(pool, async (client) => {
    const unsetPanel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
      hiringManager: 'none',
    })
    const unsetSummary = await summaryOf(client, unsetPanel, 'STAGE')
    const value = await recordDecisionInTransaction(
      client, cfg, buildArgs({ panel: unsetPanel, summary: unsetSummary, result: 'HOLD', isHiringManager: false }), NOW, ALLOWED,
    )
    assert.ok(warningCodes(value).includes('HIRING_MANAGER_UNSET'))
    assert.ok(warningCodes(value).includes('DECIDER_NOT_HIRING_MANAGER'), 'hiring_manager 为空 → 全员 false（DC-15）')

    // 另一份夹具：入参自称是招聘负责人 → 服务端计算结果不一致，必须报错而不是静默采信（DC-14）
    const panel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
      hiringManager: 'none',
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    await rejectsWith(
      recordDecisionInTransaction(
        client, cfg, buildArgs({ panel, summary, result: 'HOLD', isHiringManager: true }), NOW, ALLOWED,
      ),
      'INVALID_ARGS',
      'BASIS_AUTHORITY_MISMATCH',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

// =====================================================================
//  5. 四道防线（REJECT）
// =====================================================================

test('REJECT 与 MAJORITY_ADVANCE 相反：不签字 → OVERRIDE_NOT_ACKNOWLEDGED；签字+OVERRIDE basis → 成功', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [
        { who: 'x', overall: 'REJECT', assessments: { backend_depth: 'NOT_MET' }, rejectDims: ['backend_depth'] },
        { who: 'y', overall: 'ADVANCE' },
        { who: 'z', overall: 'ADVANCE' },
      ],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal(summary.consensus, 'MAJORITY_ADVANCE')
    assert.equal((summary.coverage as Record<string, unknown>).missing, 0)

    // 不签字：DC-28
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'REJECT', reason: 'backend_depth 两次澄清仍无容量估算',
      }), NOW, ALLOWED),
      'INVALID_ARGS',
      'OVERRIDE_NOT_ACKNOWLEDGED',
    )
    // 签了字但没把理由落进 basis_refs[OVERRIDE]：DC-29
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel,
        summary,
        result: 'REJECT',
        reason: 'backend_depth 两次澄清仍无容量估算',
        acknowledgedDissent: true,
        overrideRationale: '两位面试官通过，但硬性维度有明确反证，我按标准拒',
        includeOverrideBasis: false,
      }), NOW, ALLOWED),
      'INVALID_ARGS',
      'OVERRIDE_NOT_ACKNOWLEDGED',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)

    const value = await recordDecisionInTransaction(client, cfg, buildArgs({
      panel,
      summary,
      result: 'REJECT',
      reason: 'backend_depth 两次澄清仍无容量估算',
      acknowledgedDissent: true,
      overrideRationale: '两位面试官通过，但硬性维度有明确反证，我按标准拒',
      includeOverrideBasis: true,
    }), NOW, ALLOWED)
    assert.equal((value.decision as Record<string, unknown>).result, 'REJECT')
    assert.ok(warningCodes(value).includes('OVERRIDE_APPLIED'))
    assert.ok(warningCodes(value).includes('MINORITY_DISSENT'))
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)
  })
})

test('REJECT 没有任何反对票 → REJECT_WITHOUT_REJECTING_SCORECARD（DC-27）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }, { who: 'y', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal((summary.coverage as Record<string, unknown>).missing, 0)
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'REJECT', reason: 'backend_depth 不行',
        acknowledgedDissent: true, overrideRationale: '我按更严的标准判断',
        includeOverrideBasis: true, isHiringManager: false,
      }), NOW, ALLOWED),
      'EVIDENCE_INSUFFICIENT',
      'REJECT_WITHOUT_REJECTING_SCORECARD',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('REJECT 依据落在 UNREADABLE → BLOCKED_BY_REVIEW(REJECT_BASIS_UNREADABLE) 且 blocking_items 非空', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [
        {
          who: 'x',
          overall: 'REJECT',
          assessments: { backend_depth: 'NOT_MET', async_pipeline: 'UNREADABLE' },
          rejectDims: ['backend_depth'],
        },
        { who: 'y', overall: 'ADVANCE' },
      ],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    const body = await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'REJECT', reason: 'backend_depth 两次澄清仍无容量估算',
      }), NOW, ALLOWED),
      'BLOCKED_BY_REVIEW',
      'REJECT_BASIS_UNREADABLE',
    )
    assert.equal(body.family, 'EVIDENCE')
    const items = (body.detail as Record<string, unknown>).blocking_items as unknown[]
    assert.ok(Array.isArray(items) && items.length >= 1, 'blocking_items[] 不得为空（TC §5.4）')
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('正常的 REJECT（1 反 1 通过 = SPLIT）成功，basis_refs 逐字落库', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 2,
      scorecards: [
        { who: 'x', overall: 'REJECT', assessments: { backend_depth: 'NOT_MET' }, rejectDims: ['backend_depth'] },
        { who: 'y', overall: 'ADVANCE' },
      ],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    assert.equal(summary.consensus, 'SPLIT')
    const args = buildArgs({
      panel,
      summary,
      result: 'REJECT',
      reason: 'backend_depth 两次澄清仍给不出容量估算，而它是 MUST_HAVE',
    })
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.equal((value.decision as Record<string, unknown>).result, 'REJECT')
    assert.equal(warningCodes(value).includes('OVERRIDE_APPLIED'), false, 'SPLIT 不是"相反方向"，不要求签字（DC-28）')
    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.result, 'REJECT')
    assert.equal(canonicalJson(rows[0]?.basis_refs), canonicalJson(args.basis_refs))
  })
})

// =====================================================================
//  6. D-79 approval：没批就一行都不写；门禁先于问人
// =====================================================================

test('approval=unavailable / rejected → DECISION_REQUIRES_HUMAN，decision 与 event 行数前后不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'HOLD' })

    const before = {
      decisions: (await decisionsOf(client, panel.applicationId)).length,
      events: await decisionEventCount(client, panel.applicationId),
    }
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, async () => 'unavailable'),
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_UNAVAILABLE',
    )
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, async () => 'rejected'),
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_NOT_GRANTED',
    )
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, async () => 'cancelled'),
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_NOT_GRANTED',
    )
    const after = {
      decisions: (await decisionsOf(client, panel.applicationId)).length,
      events: await decisionEventCount(client, panel.applicationId),
    }
    assert.deepEqual(after, before, '没批就一行都不写（同一事务抛错即回滚，库层零痕迹）')
    assert.deepEqual(after, { decisions: 0, events: 0 })

    // 批了才写
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.equal(value.status, 'OK')
    assert.deepEqual({
      decisions: (await decisionsOf(client, panel.applicationId)).length,
      events: await decisionEventCount(client, panel.applicationId),
    }, { decisions: 1, events: 1 })
  })
})

test('approval_id 不存在 / 不绑本次决策 → INVALID_ARGS(APPROVAL_BINDING_INVALID)（DC-19，v1.0 不要求但给了就要真）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 2, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'HOLD' })
    args.approval_id = '11111111-1111-4111-8111-0000000000f1'
    // pre-image 只有四个键 → approval_id 不影响人工确认 hash
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED),
      'INVALID_ARGS',
      'APPROVAL_BINDING_INVALID',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('门禁失败时根本不问人（approve 不被调用）：SCORECARD_MISSING 不被 APPROVAL_UNAVAILABLE 遮住', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 3,
      scorecards: [{ who: 'x', overall: 'REJECT', assessments: { backend_depth: 'NOT_MET' }, rejectDims: ['backend_depth'] }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    let called = 0
    const spy = async (): Promise<ApprovalOutcome> => {
      called += 1
      return 'allowed-once'
    }
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({
        panel, summary, result: 'REJECT', reason: 'backend_depth 不行',
      }), NOW, spy),
      'SCORECARD_MISSING',
      'REQUIRED_SCORECARDS_INCOMPLETE',
    )
    assert.equal(called, 0, 'STEP 6 失败时不得去打扰人（D-79 的顺序：先判定，再问人）')
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

/** 便捷取一个键（避免在断言里写一长串类型断言）。 */
function valueOf(value: Record<string, unknown>, key: string): unknown {
  return value[key]
}

// =====================================================================
//  D-95：人只做一次决策 —— IN_CHAT 直接落库，不再弹二次确认
// =====================================================================

/** approval 恒不可用：用来证明 IN_CHAT 路径**根本不走** approval。 */
const UNAVAILABLE = async (): Promise<ApprovalOutcome> => 'unavailable'

test('D-95：IN_CHAT + 人的原话 → 不走 approval，decision 直接落库（v2 hash + 事件留原话）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 1,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'ADVANCE' })
    const humanText = '就按面试官的意见推进到下一轮'
    const confirmedAt = new Date(NOW - 60 * 1000).toISOString()
    args.human_confirmation = {
      confirmed_by_actor_id: panel.deciderActorId,
      confirmed_at: confirmedAt,
      confirmation_method: 'IN_CHAT',
      confirmation_text: humanText,
      // P1-2：IN_CHAT 的 hash 必须走 v2（原话进 pre-image）
      confirmation_text_sha256: confirmationTextSha256({
        result: 'ADVANCE',
        reason: String(args.reason),
        override_rationale: null,
        basis_refs: args.basis_refs as readonly unknown[],
        confirmation_text: humanText,
        confirmed_by_actor_id: panel.deciderActorId,
        confirmed_at: confirmedAt,
      }),
    }

    // 关键：approval 恒 unavailable（模拟 headless 无 answerer）。
    // 若代码还在走 STEP 6.5 的 approval 闸门，这里会 DECISION_REQUIRES_HUMAN 失败。
    const value = await recordDecisionInTransaction(client, cfg, args, NOW, UNAVAILABLE)
    assert.ok(String(valueOf(value as Record<string, unknown>, 'decision_id')).length > 0)

    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1, 'IN_CHAT 下 decision 必须真的落库')
    assert.equal(rows[0]?.result, 'ADVANCE')

    // D-95：原话 + 哈希 + pre-image 版本号写进同事务的内部事件（decision 表没有 confirmation 列）
    const event = (await client.query<{ payload: Record<string, unknown> }>(
      `select payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'decision.record'
          and payload->>'application_id' = $2`,
      [TENANT, panel.applicationId],
    )).rows[0]
    assert.ok(event !== undefined, 'IN_CHAT 决策必须有内部事件')
    assert.equal(event?.payload.human_confirmation_method, 'IN_CHAT')
    assert.equal(event?.payload.human_confirmation_text, humanText)
    assert.equal(event?.payload.human_confirmation_text_sha256, (args.human_confirmation as Record<string, unknown>).confirmation_text_sha256)
    assert.equal(event?.payload.human_confirmation_preimage_version, 2)
  })
})

test('D-95/P1-2：IN_CHAT 沿用旧四键 hash（或原话被改）→ CONFIRMATION_TEXT_MISMATCH，一行都不写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 1,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'ADVANCE' })
    const humanText = '就按面试官的意见推进到下一轮'
    const legacyHash = confirmationTextSha256({
      result: 'ADVANCE',
      reason: String(args.reason),
      override_rationale: null,
      basis_refs: args.basis_refs as readonly unknown[],
    })
    args.human_confirmation = {
      confirmed_by_actor_id: panel.deciderActorId,
      confirmed_at: new Date(NOW - 60 * 1000).toISOString(),
      confirmation_method: 'IN_CHAT',
      confirmation_text: humanText,
      confirmation_text_sha256: legacyHash,
    }
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, UNAVAILABLE),
      'DECISION_REQUIRES_HUMAN',
      'CONFIRMATION_TEXT_MISMATCH',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

test('D-95：IN_CHAT 不带人的原话 → MISSING_REQUIRED（授权凭据不能缺）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, {
      requiredCount: 1,
      scorecards: [{ who: 'x', overall: 'ADVANCE' }],
    })
    const summary = await summaryOf(client, panel, 'STAGE')
    const args = buildArgs({ panel, summary, result: 'ADVANCE' })
    const confirmation = args.human_confirmation as Record<string, unknown>
    confirmation.confirmation_method = 'IN_CHAT'
    delete confirmation.confirmation_text

    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, UNAVAILABLE),
      'INVALID_ARGS',
      'MISSING_REQUIRED',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)
  })
})

// =====================================================================
//  7. P0-3 · S7 写侧：`decision_scope='SCREENING'`（契约 §17.1）
// =====================================================================

/** 该申请绑定的材料版本（S7 写侧要核对 `content_sha256`）。 */
async function resumeOf(
  client: DatabaseClient,
  applicationId: string,
): Promise<{ id: string; content_sha256: string }> {
  const row = (await client.query<{ id: string; content_sha256: string }>(
    `select rv.id, rv.content_sha256
       from recruitment.application a
       join recruitment.resume_version rv
         on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
      where a.id = $1`,
    [applicationId],
  )).rows[0]
  assert.ok(row !== undefined, '夹具必须有绑定的材料版本')
  return row as { id: string; content_sha256: string }
}

/** 一条 S7 的 `SCREENING_EVALUATION` 依据（`job-screening/tool-contracts.md` §3.7 形状）。 */
function screeningEvaluation(
  panel: Panel,
  resume: { id: string; content_sha256: string },
  verdict: 'PASS' | 'FAIL' | 'NEEDS_REVIEW' = 'PASS',
): Record<string, unknown> {
  const digest = digestOf({
    args: { application_id: panel.applicationId },
    resolved_ids: { rubric_version_id: panel.rubricId, resume_version_id: resume.id },
    rubric_payload_hash: panel.rubricPayloadHash,
    resume_content_sha256: resume.content_sha256,
    verdict,
    reasons: [],
  })
  return {
    kind: 'SCREENING_EVALUATION',
    contract_version: '1.0.0',
    evaluation_digest: digest,
    verdict,
    rubric_version_id: panel.rubricId,
    rubric_payload_hash: panel.rubricPayloadHash,
    resume_version_id: resume.id,
    resume_content_sha256: resume.content_sha256,
    reasons_digest: digestOf([]),
    criteria_evaluated: true,
    counts: { must_have: 1, must_have_satisfied: 1, must_have_unsatisfied: 0, unreadable: 0, missing: 0, indeterminate: 0, needs_judgment: 0 },
    provenance: 'FIXTURE',
  }
}

/** S7 每次必带的两种依据（§17.1）。 */
function screeningBaseBasis(panel: Panel): Record<string, unknown>[] {
  return [
    { kind: 'RUBRIC_VERSION', id: panel.rubricId, version_no: 1, payload_hash: panel.rubricPayloadHash },
    { kind: 'AUTHORITY', actor_id: panel.deciderActorId, is_hiring_manager: false },
  ]
}

interface ScreeningArgsInput {
  readonly panel: Panel
  readonly basis: readonly Record<string, unknown>[]
  readonly result: 'ADVANCE' | 'HOLD' | 'REJECT' | 'WITHDRAW'
  readonly reason?: string
  readonly supersedes?: { decision_id: string; reason: string; expected_record_version: number }
  readonly confirmation?: Record<string, unknown>
}

/** 造一次 S7 调用的入参（无 interview_id / summary_digest；人工确认按 basis 算 hash）。 */
function screeningArgs(input: ScreeningArgsInput): Record<string, unknown> {
  const decider = input.panel.deciderActorId
  const basis = [...input.basis]
  if (input.supersedes !== undefined) {
    basis.push({
      kind: 'SUPERSEDES',
      decision_id: input.supersedes.decision_id,
      reason: input.supersedes.reason,
      opened_by_actor_id: decider,
    })
  }
  const args: Record<string, unknown> = {
    application_id: input.panel.applicationId,
    decision_scope: 'SCREENING',
    as_of: AS_OF,
    result: input.result,
    reason: input.reason ?? '按面试结论推进到下一轮',
    basis_refs: basis,
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  }
  args.human_confirmation = input.confirmation ?? {
    confirmed_by_actor_id: decider,
    confirmed_at: new Date(NOW - 60 * 1000).toISOString(),
    confirmation_method: 'IN_APP_CONFIRM',
    confirmation_text_sha256: confirmationTextSha256({
      result: String(args.result),
      reason: String(args.reason),
      override_rationale: null,
      basis_refs: basis,
    }),
  }
  return args
}

/** current 数（按 scope + stage_code；S7 是 'S7'，S10 是 'S10'）。 */
async function currentCountOf(
  client: DatabaseClient,
  applicationId: string,
  scope: 'SCREENING' | 'STAGE' | 'FINAL',
  stageCode: string,
): Promise<number> {
  const { rows } = await client.query<{ current_count: number }>(
    `select count(*)::int as current_count
       from recruitment.decision
      where tenant_id = $1 and application_id = $2 and decision_scope = $3
        and stage_code is not distinct from $4 and superseded_by_decision_id is null`,
    [TENANT, applicationId, scope, stageCode],
  )
  return rows[0]?.current_count ?? -1
}

test('SCREENING：S7 人决定落库（scope=SCREENING / stage=S7 / 无 interview / 无 gate / 事件含 evaluation_digest）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 注意：**不需要任何面试与面评**（S7 还没有面试）
    const panel = await seedPanel(client, { requiredCount: 1 })
    const resume = await resumeOf(client, panel.applicationId)
    const evaluation = screeningEvaluation(panel, resume, 'PASS')
    const args = screeningArgs({
      panel,
      basis: [evaluation, ...screeningBaseBasis(panel)],
      result: 'ADVANCE',
      reason: '三条 MUST_HAVE 全部满足，推进面试',
    })

    const value = await recordDecisionInTransaction(client, cfg, args, NOW, ALLOWED)
    assert.equal(value.status, 'OK')
    assert.equal(value.contract_version, '2.0.0')
    const decision = value.decision as Record<string, unknown>
    assert.equal(decision.decision_scope, 'SCREENING')
    assert.equal(decision.stage_code, 'S7', 'S7 写侧必须写 stage_code=S7（不是 S10）')
    assert.equal(Object.hasOwn(decision, 'interview_id'), false, 'S7 没有面试')
    assert.equal(Object.hasOwn(value, 'gate'), false, 'S7 没有 S10 汇总 → 出参没有 gate')
    assert.equal((value.labels as Record<string, unknown>).provenance, 'FIXTURE')
    assert.ok(warningCodes(value).includes('FIXTURE_BASIS'))
    assert.ok(!warningCodes(value).includes('PROCEEDED_WITH_MISSING_SCORECARDS'))

    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.decision_scope, 'SCREENING')
    assert.equal(rows[0]?.stage_code, 'S7')
    assert.equal(rows[0]?.interview_id, null)
    assert.equal(rows[0]?.decided_by_actor_id, panel.deciderActorId)
    assert.equal(canonicalJson(rows[0]?.basis_refs), canonicalJson(args.basis_refs), 'basis_refs 必须逐字落库')
    assert.equal(await currentCountOf(client, panel.applicationId, 'SCREENING', 'S7'), 1)
    assert.equal(await currentCountOf(client, panel.applicationId, 'STAGE', 'S10'), 0, 'SCREENING 不得污染 S10 的 current')

    // 内部事件：stage_code=S7 + 那次评估的 digest（S7 没有 summary_digest）
    const event = (await client.query<{ payload: Record<string, unknown> }>(
      `select payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'decision.record'
          and payload->>'application_id' = $2`,
      [TENANT, panel.applicationId],
    )).rows[0]
    assert.ok(event !== undefined, 'S7 决策必须有内部事件')
    assert.equal(event?.payload.decision_scope, 'SCREENING')
    assert.equal(event?.payload.stage_code, 'S7')
    assert.equal(event?.payload.summary_digest, null)
    assert.equal(event?.payload.screening_evaluation_digest, evaluation.evaluation_digest)

    // DC-47 / N-5：不改任何状态
    const app = (await client.query<{ current_stage_code: string; lifecycle_status: string }>(
      'select current_stage_code, lifecycle_status from recruitment.application where id = $1',
      [panel.applicationId],
    )).rows[0]
    assert.equal(app?.current_stage_code, 'S7')
    assert.equal(app?.lifecycle_status, 'ACTIVE')
  })
})

test('SCREENING：ADVANCE/REJECT 缺 SCREENING_EVALUATION → BASIS_REF_EMPTY；HOLD/WITHDRAW 可 0 条（安全方向）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 1 })
    const base = screeningBaseBasis(panel)

    for (const [result, reason] of [
      ['ADVANCE', '按面试结论推进'],
      ['REJECT', 'backend_depth 不满足'],
    ] as const) {
      const body = await rejectsWith(
        recordDecisionInTransaction(client, cfg, screeningArgs({ panel, basis: base, result, reason }), NOW, ALLOWED),
        'INVALID_ARGS',
        'BASIS_REF_EMPTY',
      )
      const missingKinds = (body.detail as Record<string, unknown>).missing_kinds as string[]
      assert.ok(missingKinds.includes('SCREENING_EVALUATION'), `missing_kinds=${missingKinds.join(',')}`)
    }
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0, '被拦的 S7 决策不得留行')

    for (const result of ['HOLD', 'WITHDRAW'] as const) {
      // 每个 result 用一份独立申请：同一 (scope, stage) 只能有一条 current
      const safePanel = await seedPanel(client, { requiredCount: 1 })
      const value = await recordDecisionInTransaction(
        client,
        cfg,
        screeningArgs({ panel: safePanel, basis: screeningBaseBasis(safePanel), result, reason: '暂不决定 / 候选人退出' }),
        NOW,
        ALLOWED,
      )
      assert.equal((value.decision as Record<string, unknown>).result, result)
      assert.equal((await decisionsOf(client, safePanel.applicationId)).length, 1, `${result} 是安全方向，必须可落`)
    }
  })
})

test('SCREENING：评估绑定必须与申请钉住的 rubric / 材料一致（不对就是 EVIDENCE_INSUFFICIENT）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 1 })
    const resume = await resumeOf(client, panel.applicationId)
    const base = screeningBaseBasis(panel)
    const good = screeningEvaluation(panel, resume, 'PASS')

    // rubric 不是申请钉住的那版
    const wrongRubric = await rejectsWith(
      recordDecisionInTransaction(client, cfg, screeningArgs({
        panel,
        basis: [{ ...good, rubric_version_id: '11111111-1111-4111-8111-0000000009ff' }, ...base],
        result: 'ADVANCE',
      }), NOW, ALLOWED),
      'EVIDENCE_INSUFFICIENT',
      'BASIS_SCREENING_RUBRIC_MISMATCH',
    )
    assert.equal((wrongRubric.detail as Record<string, unknown>).basis_refs_index, 0)

    // rubric hash 与库值不一致
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, screeningArgs({
        panel,
        basis: [{ ...good, rubric_payload_hash: 'a'.repeat(64) }, ...base],
        result: 'ADVANCE',
      }), NOW, ALLOWED),
      'EVIDENCE_INSUFFICIENT',
      'BASIS_SCREENING_RUBRIC_MISMATCH',
    )

    // 材料 hash 与库值不一致
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, screeningArgs({
        panel,
        basis: [{ ...good, resume_content_sha256: 'b'.repeat(64) }, ...base],
        result: 'ADVANCE',
      }), NOW, ALLOWED),
      'EVIDENCE_INSUFFICIENT',
      'BASIS_SCREENING_RESUME_MISMATCH',
    )

    // 材料版本不存在：申请没钉材料时才会走到"库里查不到这份材料"（钉了材料会先报不匹配）
    const unboundPanel = await seedPanel(client, { requiredCount: 1, bindMaterial: false })
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, screeningArgs({
        panel: unboundPanel,
        basis: [{ ...screeningEvaluation(unboundPanel, resume, 'PASS'), resume_version_id: '11111111-1111-4111-8111-0000000009fe' },
          ...screeningBaseBasis(unboundPanel)],
        result: 'ADVANCE',
      }), NOW, ALLOWED),
      'NOT_FOUND',
      'RESUME_VERSION_NOT_FOUND',
    )

    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0, '绑定不对的 S7 决策一行都不写')
    assert.equal((await decisionsOf(client, unboundPanel.applicationId)).length, 0)
  })
})

test('SCREENING：第二次不同结论必须走 supersedes（三步舞）；不走 → ALREADY_DECIDED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 1 })
    const resume = await resumeOf(client, panel.applicationId)
    const evaluation = screeningEvaluation(panel, resume, 'NEEDS_REVIEW')
    const first = await recordDecisionInTransaction(client, cfg, screeningArgs({
      panel,
      basis: [evaluation, ...screeningBaseBasis(panel)],
      result: 'HOLD',
      reason: '有一位 MUST_HAVE 需要人工判断，暂不决定',
    }), NOW, ALLOWED)
    const firstId = String((first.decision as Record<string, unknown>).id)
    assert.equal(await currentCountOf(client, panel.applicationId, 'SCREENING', 'S7'), 1)

    // 不带 supersedes 的第二次 → STEP 3 先拦
    await rejectsWith(
      recordDecisionInTransaction(client, cfg, screeningArgs({
        panel,
        basis: [evaluation, ...screeningBaseBasis(panel)],
        result: 'HOLD',
        reason: '再来一次',
      }), NOW, ALLOWED),
      'ALREADY_DECIDED',
      'SCOPE_ALREADY_DECIDED',
    )

    // 走撤回三步舞（SUPERSEDES basis 由 screeningArgs 自动补）
    const second = await recordDecisionInTransaction(client, cfg, screeningArgs({
      panel,
      basis: [evaluation, ...screeningBaseBasis(panel)],
      result: 'ADVANCE',
      reason: '人工判断后确认三条 MUST_HAVE 都满足，推进面试',
      supersedes: { decision_id: firstId, reason: '人工复核后改变结论', expected_record_version: 1 },
    }), NOW, ALLOWED)
    const secondId = String((second.decision as Record<string, unknown>).id)
    assert.notEqual(secondId, firstId)
    assert.deepEqual(second.superseded, { decision_id: firstId, record_version: 2 })
    assert.ok(warningCodes(second).includes('SUPERSEDES_APPLIED'))
    assert.equal(await currentCountOf(client, panel.applicationId, 'SCREENING', 'S7'), 1)

    const rows = await decisionsOf(client, panel.applicationId)
    assert.equal(rows.length, 2, '两行都留着（DC-31）')
    const oldRow = rows.find((row) => row.id === firstId)
    assert.equal(oldRow?.record_version, 2)
    assert.equal(oldRow?.superseded_by_decision_id, secondId)
    assert.equal(oldRow?.stage_code, 'S7')
  })
})

test('SCREENING：approval 未批（非 IN_CHAT）→ 一行不写；IN_CHAT + v2 hash → 不弹 approval 直接落库', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 1 })
    const resume = await resumeOf(client, panel.applicationId)
    const evaluation = screeningEvaluation(panel, resume, 'PASS')
    const basis = [evaluation, ...screeningBaseBasis(panel)]
    const args = screeningArgs({ panel, basis, result: 'ADVANCE' })

    await rejectsWith(
      recordDecisionInTransaction(client, cfg, args, NOW, UNAVAILABLE),
      'DECISION_REQUIRES_HUMAN',
      'APPROVAL_UNAVAILABLE',
    )
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 0)

    // IN_CHAT：原话进 v2 hash，闸门就是那一次对话 —— 不再弹二次确认
    const humanText = '按面试结论推进到下一轮'
    const confirmedAt = new Date(NOW - 60 * 1000).toISOString()
    const inChat = screeningArgs({
      panel,
      basis,
      result: 'ADVANCE',
      confirmation: {
        confirmed_by_actor_id: panel.deciderActorId,
        confirmed_at: confirmedAt,
        confirmation_method: 'IN_CHAT',
        confirmation_text: humanText,
        confirmation_text_sha256: confirmationTextSha256({
          result: 'ADVANCE',
          reason: '按面试结论推进到下一轮',
          override_rationale: null,
          basis_refs: basis,
          confirmation_text: humanText,
          confirmed_by_actor_id: panel.deciderActorId,
          confirmed_at: confirmedAt,
        }),
      },
    })
    const value = await recordDecisionInTransaction(client, cfg, inChat, NOW, UNAVAILABLE)
    assert.equal((value.decision as Record<string, unknown>).decision_scope, 'SCREENING')
    assert.equal((await decisionsOf(client, panel.applicationId)).length, 1)
  })
})

// =====================================================================
//  8. P1-1 · `23P01` 真触发：0008 的可延迟排斥约束在 INSERT 处冲突
// =====================================================================

test('P1-1：0008 的 uq_decision_current_final 真抛 23P01 → 工具翻成 ALREADY_DECIDED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const panel = await seedPanel(client, { requiredCount: 1, scorecards: [{ who: 'x', overall: 'ADVANCE' }] })

    // 先造一条 current FINAL，但 stage_code=NULL：STEP 3 查 (FINAL, stage='S10') 看不到它，
    // 而 uq_decision_current_final 的键是 (tenant, application) —— 第二条 current FINAL 必撞。
    await client.query(
      `insert into recruitment.decision
         (tenant_id, application_id, interview_id, decision_scope, stage_code, result,
          decided_by_actor_id, reason, basis_refs, record_version)
       values ($1, $2, null, 'FINAL', null, 'HOLD', $3, '夹具：另一条 current FINAL（stage_code=NULL）', '[]'::jsonb, 1)`,
      [TENANT, panel.applicationId, panel.deciderActorId],
    )
    // 可延迟约束在测试事务里永远不会 COMMIT → 切成 IMMEDIATE，让冲突在 INSERT 处就抛出来。
    // 注意要 schema 限定：SET CONSTRAINTS 按 search_path 解析约束名，本连接不在 recruitment 的 path 上。
    await client.query('set constraints recruitment.uq_decision_current_final immediate')

    const summary = await summaryOf(client, panel, 'FINAL')
    const body = await rejectsWith(
      recordDecisionInTransaction(client, cfg, buildArgs({ panel, summary, result: 'HOLD', scope: 'FINAL' }), NOW, ALLOWED),
      'ALREADY_DECIDED',
      'SCOPE_ALREADY_DECIDED',
    )
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.sqlstate, '23P01', '0008 之后冲突 SQLSTATE 是 23P01（不再是 23505）')
    assert.equal(detail.constraint, 'uq_decision_current_final')
  })
})
