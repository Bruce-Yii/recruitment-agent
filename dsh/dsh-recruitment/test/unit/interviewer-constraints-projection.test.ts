// 面试官前简报的「置顶约束 + 上一轮交接」读投影单测（不连库，node --test）。
//
// 覆盖：
//   1. PIN 与 HANDOFF（含 from_previous_round:true，来自上一轮）能读到并投影；
//   2. 投影无内部 id（candidate_id / 约束 uuid / tenant_id 都不外泄）；
//   3. 旧库探测为 false 时 `loadCandidateConstraints` 返回空 map（读接口不整体失败），
//      且不发约束 SELECT；探测失败（真 DB 错误）仍上抛，不吞成"表不存在"。
//   4. `toInterviewRow` 在缺约束输入时落成 `{pins:[], handoff:null}`（旧调用方行为不变）。
//
// 夹具 uuid 全是固定假值，不含任何真实数据。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  candidateConstraintTableExists,
  loadCandidateConstraints,
  toInterviewRow,
  type InterviewerFact,
} from '../../src/http/interviewer.ts'
import {
  toPinProjection,
  toHandoffProjection,
  type CandidateConstraintRow,
} from '../../src/domain/candidate-constraint.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const CANDIDATE = '11111111-1111-4111-8111-000000000603'
const INTERVIEW_1 = '11111111-1111-4111-8111-000000000901'
const INTERVIEW_2 = '11111111-1111-4111-8111-000000000902'
const APPLICATION = '11111111-1111-4111-8111-000000000902'
const JOB = '11111111-1111-4111-8111-000000000401'
const ACTOR = '11111111-1111-4111-8111-000000000104'
const CONSTRAINT_ID_A = '22222222-2222-4222-8222-000000000001'
const CONSTRAINT_ID_B = '22222222-2222-4222-8222-000000000002'

/** 一条候选约束行（pg 的 timestamptz 用 Date）。 */
function row(overrides: Partial<CandidateConstraintRow> = {}): CandidateConstraintRow {
  return {
    id: CONSTRAINT_ID_A,
    tenant_id: TENANT,
    candidate_id: CANDIDATE,
    kind: 'PIN',
    text: '不要追问薪资',
    source: 'CHAT',
    application_id: APPLICATION,
    interview_id: null,
    created_by_actor_id: ACTOR,
    created_at: new Date('2026-11-18T02:00:00.000Z'),
    superseded_by_constraint_id: null,
    record_version: 1,
    ...overrides,
  }
}

/** 最小事实：loadCandidateConstraints 只读 interviewId 与 extension.candidate_id。 */
function fact(interviewId: string, candidateId: string | null): InterviewerFact {
  return {
    interviewId,
    // 只取函数实际用到的字段，其余用 cast 补齐。
    extension: { candidate_id: candidateId } as unknown as InterviewerFact['extension'],
    value: {} as unknown as InterviewerFact['value'],
  }
}

interface QueryCall {
  readonly text: string
  readonly params: readonly unknown[]
}

/**
 * 按 SQL 文本分派的假只读 client：
 *   - to_regclass 探测 → `{exists}`；
 *   - PIN SELECT → pinRows；HANDOFF SELECT → handoffRows；
 *   - 其它查询 → 空结果（本测试不触发）。
 */
function fakeClient(options: {
  tableExists: boolean | 'error'
  pinRows?: readonly CandidateConstraintRow[]
  handoffRows?: readonly CandidateConstraintRow[]
}): DatabaseClient & { readonly calls: readonly QueryCall[] } {
  const calls: QueryCall[] = []
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []) {
      calls.push({ text, params })
      if (text.includes('to_regclass')) {
        if (options.tableExists === 'error') throw new Error('simulated db down on probe')
        return { rows: [{ exists: options.tableExists }], rowCount: 1 }
      }
      if (text.includes('kind = \'PIN\'')) return { rows: options.pinRows ?? [], rowCount: (options.pinRows ?? []).length }
      if (text.includes('kind = \'HANDOFF\'')) return { rows: options.handoffRows ?? [], rowCount: (options.handoffRows ?? []).length }
      return { rows: [], rowCount: 0 }
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: readonly QueryCall[] }
}

// ---------------------------------------------------------------------------
//  1. PIN + HANDOFF（上一轮）投影
// ---------------------------------------------------------------------------

test('loadCandidateConstraints：PIN 与上一轮 HANDOFF 都能读到并投影', async () => {
  const pin = row({
    id: CONSTRAINT_ID_A,
    kind: 'PIN',
    text: ' 不要追问薪资 ',
    source: 'CHAT',
    created_at: new Date('2026-11-18T02:00:00.000Z'),
  })
  const handoff = row({
    id: CONSTRAINT_ID_B,
    kind: 'HANDOFF',
    interview_id: INTERVIEW_1,
    text: '上一轮已确认技术方案，本轮不要重复提问',
    source: 'WEIXIN',
    created_at: new Date('2026-11-18T03:00:00.000Z'),
  })
  const client = fakeClient({ tableExists: true, pinRows: [pin], handoffRows: [handoff] })
  const map = await loadCandidateConstraints(client, TENANT, [fact(INTERVIEW_1, CANDIDATE)])

  const constraints = map.get(INTERVIEW_1)
  assert.ok(constraints, '本场面试必须有约束投影')
  assert.deepEqual(constraints.pins, [{
    text: ' 不要追问薪资 ',
    source: 'CHAT',
    created_by: ACTOR.slice(0, 8),
    created_at: '2026-11-18T02:00:00.000Z',
  }])
  assert.deepEqual(constraints.handoff, {
    text: '上一轮已确认技术方案，本轮不要重复提问',
    source: 'WEIXIN',
    created_by: ACTOR.slice(0, 8),
    created_at: '2026-11-18T03:00:00.000Z',
    from_previous_round: true,
  })
  assert.equal(constraints.handoff?.from_previous_round, true)

  // 探针只发一次，不是每行一次。
  const probes = client.calls.filter((call) => call.text.includes('to_regclass'))
  assert.equal(probes.length, 1, 'to_regclass 探测必须只发一次')
})

test('领域投影：墓碑 / superseded 行被过滤（PIN 与 HANDOFF 同口径）', () => {
  const livePin = row({ id: CONSTRAINT_ID_A, kind: 'PIN', text: '有效置顶' })
  const superseded = row({ id: CONSTRAINT_ID_B, kind: 'PIN', text: '旧置顶', superseded_by_constraint_id: CONSTRAINT_ID_A })
  const tombstone = row({ id: '22222222-2222-4222-8222-000000000003', kind: 'PIN', text: '（已取消置顶）' })
  assert.deepEqual(toPinProjection([livePin, superseded, tombstone]).map((p) => p.text), ['有效置顶'])
  assert.deepEqual(toHandoffProjection([livePin]).length, 0)
})

// ---------------------------------------------------------------------------
//  2. 投影无内部 id
// ---------------------------------------------------------------------------

test('投影字段清单固定：kind/text/source/from_previous_round + 短号，无内部 id', () => {
  const pin = row({ kind: 'PIN', text: '只谈能力' })
  const handoff = row({ kind: 'HANDOFF', interview_id: INTERVIEW_1, text: '下一轮继续' })
  const pinProjection = toPinProjection([pin])[0]
  const handoffProjection = toHandoffProjection([handoff])[0]
  assert.ok(pinProjection !== undefined)
  assert.ok(handoffProjection !== undefined)

  assert.deepEqual(Object.keys(pinProjection).sort(), ['created_at', 'created_by', 'source', 'text'])
  assert.deepEqual(Object.keys(handoffProjection).sort(), [
    'created_at', 'created_by', 'from_previous_round', 'source', 'text',
  ])
  const serialized = JSON.stringify({ pinProjection, handoffProjection })
  for (const forbidden of [CANDIDATE, TENANT, APPLICATION, CONSTRAINT_ID_A, INTERVIEW_1, 'tenant_id', 'candidate_id', 'interview_id']) {
    assert.equal(serialized.includes(forbidden), false, `投影不得含 ${forbidden}`)
  }
})

// ---------------------------------------------------------------------------
//  3. 旧库兼容（探测分支）
// ---------------------------------------------------------------------------

test('candidateConstraintTableExists 纯判定：true / false / null', () => {
  assert.equal(candidateConstraintTableExists({ exists: true }), true)
  assert.equal(candidateConstraintTableExists({ exists: false }), false)
  assert.equal(candidateConstraintTableExists({ exists: 't' }), true)
  assert.equal(candidateConstraintTableExists({ exists: '1' }), true)
  assert.equal(candidateConstraintTableExists(null), false)
  assert.equal(candidateConstraintTableExists(undefined), false)
})

test('旧库探测为 false：返回空 map，不发约束 SELECT（读接口不整体失败）', async () => {
  const client = fakeClient({ tableExists: false })
  const map = await loadCandidateConstraints(client, TENANT, [fact(INTERVIEW_1, CANDIDATE)])
  assert.equal(map.size, 0, '表不存在 → 空 map（每行落成空约束）')
  const constraintSelects = client.calls.filter((call) => call.text.includes('from recruitment.candidate_constraint'))
  assert.equal(constraintSelects.length, 0, '表不存在时不得发约束 SELECT')
  const probes = client.calls.filter((call) => call.text.includes('to_regclass'))
  assert.equal(probes.length, 1, '探测一次')
  assert.deepEqual(probes[0]?.params, [], 'to_regclass 探测无参数、tenant 无关')
})

test('探测为真 DB 错误：上抛，不吞成"表不存在"', async () => {
  const client = fakeClient({ tableExists: 'error' })
  await assert.rejects(
    () => loadCandidateConstraints(client, TENANT, [fact(INTERVIEW_1, CANDIDATE)]),
    /simulated db down on probe/,
  )
})

// ---------------------------------------------------------------------------
//  4. toInterviewRow 空约束回退
// ---------------------------------------------------------------------------

test('toInterviewRow 缺 candidateConstraints → 空约束（不破坏既有契约键名）', () => {
  const value = {
    id: INTERVIEW_1,
    application_id: APPLICATION,
    candidate_id: CANDIDATE,
    job_id: JOB,
    round_no: 2,
    slot_code: 'DEFAULT',
    stage_code: 'INTERVIEW',
    status: 'SCHEDULED',
    record_version: 3,
    scheduled_start_at: '2026-11-20T14:00:00.000Z',
    scheduled_end_at: '2026-11-20T15:00:00.000Z',
    duration_minutes: 60,
    timezone: 'Asia/Shanghai',
    status_changed_at: '2026-11-01T00:00:00.000Z',
    is_overdue_start: false,
    interviewers: [{
      interviewer_id: 'ivr-a',
      actor_id: ACTOR,
      display_name: '演示-面试官 A',
      role_in_interview: 'INTERVIEWER',
      required_scorecard: true,
    }],
    meeting_binding: { state: 'UNBOUND', count: 0, bindings: [] },
    transcript: { state: 'NO_TRANSCRIPT', reason_code: 'NO_TRANSCRIPT', no_transcript: true },
    evaluation: {
      required_scorecards: 1, submitted: 0, waived: 0, pending: 1,
      evaluation_ready: false, blockers: [],
    },
    warnings: [],
  } as unknown as Parameters<typeof toInterviewRow>[0]['value']
  const extension = {
    interview_id: INTERVIEW_1,
    application_job_id: JOB,
    candidate_id: CANDIDATE,
    candidate_display_name: '演示候选人',
    job_code: 'DEMO-BE-001',
    job_title: '后端工程师（演示）',
    template_version_id: null,
    template_objective: null,
    template_briefing_summary: null,
    template_focus: [],
    template_questions: [],
    template_payload_hash: null,
    pinned_rubric_version_id: null,
    rubric_version_id: null,
    rubric_payload_hash: null,
    rubric_dimensions: [],
    resume_version_id: null,
    resume_parse_status: 'NOT_PARSED',
    resume_parser_name: null,
    resume_parser_version: null,
    resume_content_sha256: null,
    resume_parsed_fields: null,
    scorecard_id: null,
    scorecard_record_version: null,
    scorecard_overall: null,
    role_in_interview: 'INTERVIEWER',
    required_scorecard: true,
    scorecard_due_at: null,
  } as unknown as Parameters<typeof toInterviewRow>[0]['extension']
  const result = toInterviewRow({ value, extension, actorId: ACTOR, priorRoundRows: [] })
  assert.deepEqual(result.row.candidate_constraints, { pins: [], handoff: null })
})
