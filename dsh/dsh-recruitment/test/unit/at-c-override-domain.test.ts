// AT-6/7 · override 领域路径的纯单测（**不连库**，用按 SQL 文本分派的假 DatabaseClient）。
//
// 与 test/unit/stage-advance.test.ts 同一套假库手法，但这里是独立文件（at-c-* 前缀），
// 只钉 override 新增的语义：
//   ① 无 override + 缺面评 → 原样 BLOCKED(SCORECARD_REQUIRED)、零 UPDATE、零事件（没放宽）；
//   ② 有 override → 沿梯子逐边走到 S10，跳过门记进 transitions/skipped_stages，
//      审计事件含 AT-7 六字段 + 正确 sha256 + waived_scorecard；
//   ③ actor 缺失 → INVALID_ARGS(ACTOR_REQUIRED)、零写入；
//   ④ 硬约束（非 ACTIVE / S11 / 已到 S10）在 override 下仍然零写入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  advanceApplicationStage,
  advanceApplicationStageWithOverride,
  type StageOverrideResult,
} from '../../src/domain/stage-advance.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'
const MATERIAL_ID = '11111111-1111-4111-8111-000000000901'
const RUBRIC_ID = '11111111-1111-4111-8111-000000000403'
const INTERVIEW_ID = '11111111-1111-4111-8111-000000000e01'
const TRANSCRIPT_ID = '11111111-1111-4111-8111-000000000f01'
const TENANT = '11111111-1111-4111-8111-000000000001'
const OWNER_ACTOR = '11111111-1111-4111-8111-000000000102'
const GUC_ACTOR = '11111111-1111-4111-8111-000000000103'
const CREATED_US = Date.parse('2026-11-14T00:00:00.000Z') * 1000

const REASON = '面试官临时授权跳过初筛与材料闸门，候选人已当面确认'
const CONFIRM_TEXT = '我确认：候选人情况特殊，同意跳过初筛和面评直接推进到综合决策。'
const EXPECTED_SHA = createHash('sha256').update(CONFIRM_TEXT, 'utf8').digest('hex')

interface FakeAppRow {
  id: string
  current_stage_code: string
  record_version: number
  lifecycle_status: string
  resume_version_id: string | null
  rubric_version_id: string | null
  stage_entered_at_us: number
  created_at_us: number
}

function appRow(overrides: Partial<FakeAppRow> = {}): FakeAppRow {
  return {
    id: APP_ID,
    current_stage_code: 'S9',
    record_version: 7,
    lifecycle_status: 'ACTIVE',
    resume_version_id: MATERIAL_ID,
    rubric_version_id: RUBRIC_ID,
    stage_entered_at_us: CREATED_US,
    created_at_us: CREATED_US,
    ...overrides,
  }
}

const STAGE_ORDERS = [
  { code: 'S1', sort_order: 1, name: 'Discovery' }, { code: 'S2', sort_order: 2, name: 'Requisition' },
  { code: 'S3', sort_order: 3, name: 'Design' }, { code: 'S4', sort_order: 4, name: 'Posting' },
  { code: 'S5', sort_order: 5, name: 'Sourcing' },
  { code: 'S6', sort_order: 6, name: 'Intake' }, { code: 'S7', sort_order: 7, name: 'Screening' },
  { code: 'S8', sort_order: 8, name: 'Planning' }, { code: 'S9', sort_order: 9, name: 'Interview' },
  { code: 'S10', sort_order: 10, name: 'Decision' }, { code: 'S11', sort_order: 11, name: 'Offer' },
  { code: 'S12', sort_order: 12, name: 'Archive' },
]

interface Call { readonly text: string; readonly params: readonly unknown[] }

interface FakeInput {
  readonly application?: FakeAppRow
  readonly actorId?: string | null
  readonly transcripts?: readonly { id: string; transcript_status: string; is_canonical: boolean }[]
  readonly interviews?: readonly { id: string; status: string }[]
  readonly submittedScorecards?: number
  readonly decision?: { id: string; result: string; decided_by_actor_id: string; decided_by_display_name?: string | null } | null
}

/** 假库：记录每条 SQL；UPDATE / event_inbox INSERT 的调用是断言"零写入/已写入"的唯一证据。 */
function fakeClient(input: FakeInput): DatabaseClient & { readonly calls: readonly Call[] } {
  const calls: Call[] = []
  let updateCount = 0
  const client = {
    calls,
    async query(text: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
      calls.push({ text, params })
      if (text.includes("current_setting('recruitment.actor_id'")) {
        return { rows: [{ actor_id: input.actorId === undefined ? GUC_ACTOR : input.actorId }] }
      }
      if (text.includes('hiring_manager_actor_id')) {
        return { rows: [{ actor_id: OWNER_ACTOR, display_name: '招聘负责人' }] }
      }
      if (text.includes('from recruitment.application') && text.includes('stage_entered_at')) {
        const app = input.application ?? appRow()
        return { rows: [app] }
      }
      if (text.includes('recruitment.stage_catalog')) return { rows: [...STAGE_ORDERS] }
      if (text.includes('count(*)::int as n') && text.includes("s.status = 'SUBMITTED'")) {
        return { rows: [{ n: input.submittedScorecards ?? 0 }] }
      }
      if (text.includes('from recruitment.transcript_artifact')) return { rows: [...(input.transcripts ?? [])] }
      if (text.includes('from recruitment.interview i')) return { rows: [...(input.interviews ?? [])] }
      if (text.includes('recruitment.resume_version')) return { rows: [{ parse_status: 'COMPLETED' }] }
      if (text.includes('recruitment.decision')) {
        const d = input.decision
        return { rows: d === undefined || d === null ? [] : [d] }
      }
      // 补钉相关查询：本测试的应用都已钉 rubric，走到也只是返回"没有可钉目标/没有冲突"。
      if (text.includes('recruitment.rubric_version')) return { rows: [] }
      if (text.includes('recruitment.scorecard')) return { rows: [] }
      if (text.includes('insert into recruitment.event_inbox')) {
        return { rows: [{ event_id: `evt-${calls.length}` }] }
      }
      if (text.trimStart().startsWith('update recruitment.application')) {
        const toStage = String(params[3])
        const expected = Number(params[4])
        updateCount += 1
        return {
          rows: [{
            current_stage_code: toStage,
            record_version: expected + 1,
            stage_entered_at_us: CREATED_US + 60_000_000 * updateCount,
          }],
        }
      }
      throw new Error(`fakeClient: 未预期的 SQL：${text.slice(0, 90)}`)
    },
  }
  return client as unknown as DatabaseClient & { readonly calls: readonly Call[] }
}

const READY_MATERIAL = [{ id: TRANSCRIPT_ID, transcript_status: 'READY', is_canonical: true }]

function updates(client: { calls: readonly Call[] }): readonly Call[] {
  return client.calls.filter((c) => c.text.trimStart().startsWith('update recruitment.application'))
}
function eventInserts(client: { calls: readonly Call[] }): readonly Call[] {
  return client.calls.filter((c) => c.text.includes('insert into recruitment.event_inbox'))
}
function eventPayload(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.params[3])) as Record<string, unknown>
}

async function runOverride(input: FakeInput = {}): Promise<{
  result: StageOverrideResult
  client: DatabaseClient & { readonly calls: readonly Call[] }
}> {
  const client = fakeClient(input)
  const result = await advanceApplicationStageWithOverride(client, {
    tenantId: TENANT,
    applicationId: APP_ID,
    override: { reason: REASON, confirmation_text: CONFIRM_TEXT },
  })
  return { result, client }
}

// ---------------------------------------------------------------------------
//  ① 无 override：旧行为一字不改
// ---------------------------------------------------------------------------

test('无 override + S9 缺面评 → BLOCKED(SCORECARD_REQUIRED)，零 UPDATE、零 override 事件', async () => {
  const client = fakeClient({ application: appRow(), transcripts: READY_MATERIAL, submittedScorecards: 0 })
  const result = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: APP_ID })
  assert.equal(result.status, 'BLOCKED')
  assert.deepEqual(result.blockers.map((b) => b.code), ['SCORECARD_REQUIRED'])
  assert.deepEqual(result.transitions, [])
  assert.equal(updates(client).length, 0, '正常路径缺面评必须零 UPDATE')
  assert.equal(eventInserts(client).length, 0, '正常路径缺面评不发 override 审计事件')
  assert.equal((result as StageOverrideResult).override_applied, undefined, '正常路径不产出 override 字段')
})

// ---------------------------------------------------------------------------
//  ② 有 override：跳门 + AT-7 审计
// ---------------------------------------------------------------------------

test('AT-6/7：override + 缺面评 → S9→S10 放行，审计事件含六字段 + 正确 sha256 + waived_scorecard', async () => {
  const { result, client } = await runOverride({
    application: appRow({ current_stage_code: 'S9' }),
    transcripts: READY_MATERIAL,
    submittedScorecards: 0,
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S10')
  assert.deepEqual(result.transitions, [{ from: 'S9', to: 'S10' }])
  assert.equal(result.override_applied, true)
  assert.equal(result.waived_scorecard, true)
  assert.deepEqual(result.skipped_stages, ['S10'])
  assert.equal(updates(client).length, 1)

  const events = eventInserts(client)
  assert.equal(events.length, 1, 'override 必须且只写一条审计事件')
  const sql = events[0]!.text
  assert.match(sql, /'application\.stage\.override\.recorded'/, 'SQL 里必须是裸字面量事件名')
  assert.match(sql, /'internal'/) // provider
  assert.match(sql, /'FALLBACK_KEY'/) // idempotency_source
  assert.match(sql, /'INTERNAL'/) // trust_level
  assert.match(sql, /'schema\/0001'/) // normalizer_version
  assert.equal(String(events[0]!.params[2]), APP_ID, 'source_object_id 必须绑申请 id')

  const payload = eventPayload(events[0]!)
  // AT-7 六个必含字段
  for (const key of [
    'reason', 'confirmed_by_actor_id', 'confirmed_at',
    'confirmation_text_sha256', 'from_stage', 'to_stage',
  ]) {
    assert.ok(Object.hasOwn(payload, key), `审计 payload 缺 ${key}`)
  }
  assert.equal(payload.reason, REASON)
  assert.equal(payload.confirmed_by_actor_id, GUC_ACTOR, '确认人取自 GUC（SET LOCAL），不是模型参数')
  assert.ok(!Number.isNaN(Date.parse(String(payload.confirmed_at))), 'confirmed_at 必须是时间')
  assert.equal(payload.confirmation_text_sha256, EXPECTED_SHA, '哈希必须是原话的 SHA-256 小写 hex')
  assert.match(String(payload.confirmation_text_sha256), /^[0-9a-f]{64}$/)
  assert.equal(payload.from_stage, 'S9')
  assert.equal(payload.to_stage, 'S10')
  // 可读性附件
  assert.equal(payload.waived_scorecard, true)
  assert.deepEqual(payload.skipped_stages, ['S10'])
  assert.equal(payload.application_id, APP_ID)
  // 绝不把原话明文写进审计（只留哈希），也绝不收模型给的哈希字段。
  assert.equal(Object.hasOwn(payload, 'confirmation_text'), false)
})

test('AT-6/7：override + 多个缺口 → 逐边走到 S10，所有跳过边记进 transitions 与 skipped_stages', async () => {
  const { result, client } = await runOverride({
    application: appRow({
      current_stage_code: 'S6',
      resume_version_id: null,
      rubric_version_id: null,
      record_version: 1,
    }),
    transcripts: [],
    interviews: [],
    submittedScorecards: 0,
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S10')
  assert.deepEqual(result.transitions, [
    { from: 'S6', to: 'S7' }, { from: 'S7', to: 'S8' },
    { from: 'S8', to: 'S9' }, { from: 'S9', to: 'S10' },
  ])
  assert.deepEqual(result.skipped_stages, ['S7', 'S8', 'S9', 'S10'])
  assert.equal(result.waived_scorecard, true)
  assert.equal(updates(client).length, 4, '四跳一条 UPDATE 一跳，复用 applyTransitions')
  const payload = eventPayload(eventInserts(client)[0]!)
  assert.equal(payload.from_stage, 'S6')
  assert.equal(payload.to_stage, 'S10')
  assert.deepEqual(payload.skipped_stages, ['S7', 'S8', 'S9', 'S10'])
})

test('AT-6/7：反向事实（SCREENING=REJECT / 面试全取消）在 override 下也被人工豁免，但仍只到 S10', async () => {
  const { result, client } = await runOverride({
    application: appRow({ current_stage_code: 'S7' }),
    decision: {
      id: '11111111-1111-4111-8111-000000000a01',
      result: 'REJECT',
      decided_by_actor_id: OWNER_ACTOR,
    },
    interviews: [{ id: INTERVIEW_ID, status: 'CANCELLED' }],
    submittedScorecards: 0,
  })
  assert.equal(result.status, 'ADVANCED')
  assert.equal(result.stage_code, 'S10')
  assert.deepEqual(result.transitions, [
    { from: 'S7', to: 'S8' }, { from: 'S8', to: 'S9' }, { from: 'S9', to: 'S10' },
  ])
  assert.equal(updates(client).length, 3)
})

// ---------------------------------------------------------------------------
//  ③ fail-closed / 硬约束
// ---------------------------------------------------------------------------

test('AT-6 负例：actor 缺失 → INVALID_ARGS(ACTOR_REQUIRED)，零 UPDATE、零事件', async () => {
  const client = fakeClient({
    application: appRow(), transcripts: READY_MATERIAL, submittedScorecards: 0, actorId: null,
  })
  await assert.rejects(
    () => advanceApplicationStageWithOverride(client, {
      tenantId: TENANT, applicationId: APP_ID,
      override: { reason: REASON, confirmation_text: CONFIRM_TEXT },
    }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, 'INVALID_ARGS')
      assert.match(error.message, /ACTOR_REQUIRED/)
      return true
    },
  )
  assert.equal(updates(client).length, 0, 'actor 缺失必须零 UPDATE')
  assert.equal(eventInserts(client).length, 0, 'actor 缺失必须零事件')
})

test('AT-6：override 也不许推进非 ACTIVE 的申请（零写入）', async () => {
  const { result, client } = await runOverride({
    application: appRow({ lifecycle_status: 'CLOSED' }), transcripts: READY_MATERIAL,
  })
  assert.equal(result.status, 'BLOCKED')
  assert.ok(result.blockers.some((b) => b.code === 'APPLICATION_NOT_ACTIVE'))
  assert.deepEqual(result.transitions, [])
  assert.equal(updates(client).length, 0)
  assert.equal(eventInserts(client).length, 0)
})

test('AT-6：override 也已越过 S10 → STAGE_AHEAD，零写入；已在 S10 → NO_OP，零写入', async () => {
  const ahead = await runOverride({ application: appRow({ current_stage_code: 'S11' }) })
  assert.equal(ahead.result.status, 'NO_OP')
  assert.ok(ahead.result.warnings.some((w) => w.code === 'STAGE_AHEAD'))
  assert.equal(updates(ahead.client).length, 0)
  assert.equal(eventInserts(ahead.client).length, 0)

  const terminal = await runOverride({ application: appRow({ current_stage_code: 'S10' }) })
  assert.equal(terminal.result.status, 'NO_OP')
  assert.equal(terminal.result.stage_code, 'S10')
  assert.equal(updates(terminal.client).length, 0)
  assert.equal(eventInserts(terminal.client).length, 0)
})

test('AT-6：override 也不许从梯子之外插队（S5 → BLOCKED STAGE_NOT_ON_LADDER，零写入）', async () => {
  const { result, client } = await runOverride({ application: appRow({ current_stage_code: 'S5' }) })
  assert.equal(result.status, 'BLOCKED')
  assert.ok(result.blockers.some((b) => b.code === 'STAGE_NOT_ON_LADDER'))
  assert.equal(updates(client).length, 0)
  assert.equal(eventInserts(client).length, 0)
})

test('AT-7：确认哈希是服务端算的 —— 同样的原话必得同样哈希，与原话一一对应', () => {
  const again = createHash('sha256').update(CONFIRM_TEXT, 'utf8').digest('hex')
  assert.equal(again, EXPECTED_SHA)
  assert.match(again, /^[0-9a-f]{64}$/)
  assert.notEqual(again, createHash('sha256').update(CONFIRM_TEXT + ' ', 'utf8').digest('hex'))
})
