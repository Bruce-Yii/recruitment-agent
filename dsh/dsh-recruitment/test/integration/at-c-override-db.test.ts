// AT-6 / AT-7 的**真库读回**证据（连 RECRUITMENT_TEST_DB，每个用例在必然回滚的事务里跑）。
// 需要 db/migrations/0018_atomic_capabilities.sql 已应用（db/verify.sql AT-STRUCT PASS）。
//
// 覆盖：
//   AT-6 正例：停在 S9 且 SCORECARD_REQUIRED 的申请 + override{reason, confirmation_text}
//              → 真库读到 S10；event_inbox 里 'application.stage.override.recorded' 的 payload
//                含 AT-7 六个必填字段，sha256 与 node:crypto 对原话计算一致；
//   AT-6 反例：同一形态的申请不传 override → BLOCKED(SCORECARD_REQUIRED)，application /
//              event_inbox 逐表行数不变；空 confirmation_text / 空 reason → INVALID_ARGS、零写入。
//
// 夹具说明：S9 是通过**真实的 advanceApplicationStage** 推进到位的（T2 SCREENING ADVANCE +
// T3 canonical READY 转写成立、T4 缺面评被挡），没有直接改 current_stage_code —— 这样
// "停在 S9 且 SCORECARD_REQUIRED" 是库里真实派生出来的状态，不是手工塞进去的假象。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  advanceApplicationStage,
  advanceApplicationStageWithOverride,
} from '../../src/domain/stage-advance.ts'
import { createStageAdvanceTool } from '../../src/tools/stage-advance.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool, inRolledBackTx, one, seedScenario,
  testDatabaseConfig, uniqueSuffix, HR_ACTOR, TENANT,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)
test.after(async () => { await pool.end() })

const DIMENSIONS = [{
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1,
  field: 'work_experience', operator: 'EXISTS', value: true,
}]

const REASON = '面试官与招聘负责人当面确认：候选人已有等效材料，人工授权豁免面评直接进 S10'
const CONFIRM_TEXT = '我确认：该候选人的面评缺失是流程原因，我授权跳过这一步直接推进到综合决策。'
const EXPECTED_SHA = createHash('sha256').update(CONFIRM_TEXT, 'utf8').digest('hex')
const OVERRIDE_EVENT = 'application.stage.override.recorded'

/** 一次夹具的全部 id（供后续读回使用）。 */
interface ScenarioAtS9 {
  readonly applicationId: string
  readonly interviewId: string
}

/** 插一条 current SCREENING 决策（T2 的 PASS 事实）。 */
async function insertScreeningDecision(client: DatabaseClient, applicationId: string): Promise<string> {
  return await one(client, `insert into recruitment.decision
      (tenant_id, application_id, decision_scope, stage_code, result,
       decided_by_actor_id, reason, basis_refs)
    values ($1, $2, 'SCREENING', 'S7', 'ADVANCE', $3, $4, '[]'::jsonb) returning id`, [
    TENANT, applicationId, HR_ACTOR,
    '集成测试夹具：人做出的 SCREENING=ADVANCE（不含 PII）',
  ])
}

/** 面试 + 会议 + 有效绑定（转写产物经它可达本申请）。 */
async function insertInterviewChain(client: DatabaseClient, applicationId: string): Promise<{
  interviewId: string; meetingId: string
}> {
  const suffix = uniqueSuffix()
  const interviewId = await one(client, `insert into recruitment.interview
      (tenant_id, application_id, round_no, slot_code, status, scheduled_start_at, scheduled_end_at)
      values ($1, $2, 1, 'DEFAULT', 'POST_INTERVIEW', now() - interval '2 hours', now() - interval '1 hour') returning id`, [
    TENANT, applicationId,
  ])
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, external_meeting_id, meeting_role)
      values ($1, 'SYNTHETIC_DEMO', $2, 'PRIMARY') returning id`, [
    TENANT, `synthetic-meeting-atc-${suffix}`,
  ])
  await one(client, `insert into recruitment.meeting_binding
      (tenant_id, meeting_id, interview_id, binding_method)
      values ($1, $2, $3, 'SCHEDULED') returning id`, [TENANT, meetingId, interviewId])
  return { interviewId, meetingId }
}

/** canonical READY 转写（T3 PASS / T4 材料可用）。 */
async function insertReadyCanonicalTranscript(client: DatabaseClient, meetingId: string): Promise<string> {
  return await one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type,
       transcript_status, provenance, trigger_mode, connection_state,
       content_sha256, raw_text, is_complete, is_canonical, canonical_selected_by_actor_id)
      values ($1, $2, 'SYNTHETIC_DEMO', $3, 1, 'ORIGINAL',
              'READY', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED',
              $4, $5, true, true, $6) returning id`, [
    TENANT, meetingId, `artifact-atc-${uniqueSuffix()}`,
    'b'.repeat(64), '集成测试：合成转写原文（不含 PII）', HR_ACTOR,
  ])
}

/**
 * 通过真实推进把申请带到 S9，并确认它正被 SCORECARD_REQUIRED 挡住（夹具断言）。
 * 不直接 SQL 改阶段码：让"S9 缺面评"成为派生出来的库事实。
 */
async function seedAtS9MissingScorecard(client: DatabaseClient): Promise<ScenarioAtS9> {
  const scenario = await seedScenario(client, { dimensions: DIMENSIONS })
  await insertScreeningDecision(client, scenario.applicationId)
  const { interviewId, meetingId } = await insertInterviewChain(client, scenario.applicationId)
  await insertReadyCanonicalTranscript(client, meetingId)

  const toS9 = await advanceApplicationStage(client, {
    tenantId: TENANT, applicationId: scenario.applicationId,
  })
  assert.equal(toS9.stage_code, 'S9', '夹具必须真实停在 S9')
  assert.ok(toS9.blockers.some((b) => b.code === 'SCORECARD_REQUIRED'), '夹具必须正被 SCORECARD_REQUIRED 挡住')
  return { applicationId: scenario.applicationId, interviewId }
}

/** 逐表行数（零写入证据；REPEATABLE READ 同一快照 + 必然回滚）。 */
async function counts(client: DatabaseClient, tables: readonly string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of tables) {
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
    result[table] = rows[0]?.n ?? -1
  }
  return result
}

const ZERO_WRITE_TABLES = ['application', 'event_inbox', 'scorecard', 'interview', 'business_task'] as const

/** 找到本次 override 审计事件（application_id 过滤，隔离并行测试的其它行）。 */
async function readOverrideEvent(client: DatabaseClient, applicationId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await client.query<Record<string, unknown>>(
    `select event_type, provider, trust_level, normalizer_version, idempotency_source, source_object_id, payload
       from recruitment.event_inbox
      where tenant_id = $1 and event_type = $2 and payload->>'application_id' = $3`,
    [TENANT, OVERRIDE_EVENT, applicationId],
  )
  return rows[0]
}

// ---------------------------------------------------------------------------

test('AT-6/7 DB 正例：override 放行 S9→S10；AT-7 审计 payload 六字段 + sha256 一致', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { applicationId } = await seedAtS9MissingScorecard(client)

    // 调用前：本申请还没有 override 审计事件。
    assert.equal(await readOverrideEvent(client, applicationId), undefined)

    const result = await advanceApplicationStageWithOverride(client, {
      tenantId: TENANT,
      applicationId,
      override: { reason: REASON, confirmation_text: CONFIRM_TEXT },
    })
    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.waived_scorecard, true)
    assert.deepEqual(result.skipped_stages, ['S10'])

    // 真库读回阶段（独立于产品代码的一次 SQL）。
    const stage = (await client.query<{ current_stage_code: string; record_version: number }>(
      `select current_stage_code, record_version from recruitment.application
        where id = $1 and tenant_id = $2`,
      [applicationId, TENANT],
    )).rows[0]
    assert.equal(stage?.current_stage_code, 'S10', 'override 后阶段必须真到了 S10')
    assert.equal(Number(stage?.record_version), result.record_version)

    // 真库读回审计事件。
    const event = await readOverrideEvent(client, applicationId)
    assert.ok(event !== undefined, '必须有一条 AT-7 审计事件')
    assert.equal(event.provider, 'internal')
    assert.equal(event.trust_level, 'INTERNAL')
    assert.equal(event.normalizer_version, 'schema/0001')
    assert.equal(event.idempotency_source, 'FALLBACK_KEY')
    assert.equal(String(event.source_object_id), applicationId)

    const payload = event.payload as Record<string, unknown>
    for (const key of [
      'reason', 'confirmed_by_actor_id', 'confirmed_at',
      'confirmation_text_sha256', 'from_stage', 'to_stage',
    ]) {
      assert.ok(Object.hasOwn(payload, key), `AT-7 payload 缺必填字段 ${key}`)
    }
    assert.equal(payload.reason, REASON)
    assert.equal(payload.confirmed_by_actor_id, HR_ACTOR, '确认人取自 SET LOCAL 的 GUC')
    assert.ok(!Number.isNaN(Date.parse(String(payload.confirmed_at))))
    assert.equal(
      payload.confirmation_text_sha256,
      EXPECTED_SHA,
      'sha256 必须等于 node:crypto 对人工原话的计算值',
    )
    assert.match(String(payload.confirmation_text_sha256), /^[0-9a-f]{64}$/)
    assert.equal(payload.from_stage, 'S9')
    assert.equal(payload.to_stage, 'S10')
    assert.equal(payload.waived_scorecard, true)
    assert.deepEqual(payload.skipped_stages, ['S10'])
    assert.equal(Object.hasOwn(payload, 'confirmation_text'), false, '原话明文不落 payload，只留哈希')

    // 打印一小段真实 payload（真库读回证据，供 owner 直接核对）。
    console.log('[AT-C DB readback]', JSON.stringify({
      event_type: event.event_type,
      stage: stage?.current_stage_code,
      payload: {
        reason: payload.reason,
        confirmed_by_actor_id: payload.confirmed_by_actor_id,
        confirmed_at: payload.confirmed_at,
        confirmation_text_sha256: payload.confirmation_text_sha256,
        from_stage: payload.from_stage,
        to_stage: payload.to_stage,
        waived_scorecard: payload.waived_scorecard,
        skipped_stages: payload.skipped_stages,
      },
    }))
  })
})

test('AT-6/7 DB 反例：无 override → BLOCKED 且逐表零写入；空原话 / 空理由 → INVALID_ARGS 零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { applicationId } = await seedAtS9MissingScorecard(client)

    // (1) 不传 override：正常路径仍被 SCORECARD_REQUIRED 挡住，行数一张都不许变。
    let before = await counts(client, ZERO_WRITE_TABLES)
    const blocked = await advanceApplicationStage(client, { tenantId: TENANT, applicationId })
    assert.equal(blocked.status, 'BLOCKED')
    assert.deepEqual(blocked.transitions, [])
    assert.ok(blocked.blockers.some((b) => b.code === 'SCORECARD_REQUIRED'))
    assert.deepEqual(await counts(client, ZERO_WRITE_TABLES), before, '无 override 必须零写入')
    assert.equal(await readOverrideEvent(client, applicationId), undefined)

    // (2) 空 confirmation_text / 空 reason：工具层在开库前就 INVALID_ARGS（零写入）。
    const tool = createStageAdvanceTool(cfg)
    before = await counts(client, ZERO_WRITE_TABLES)
    await assert.rejects(
      () => tool.execute(
        { application_id: applicationId, override: { reason: REASON, confirmation_text: '   ' } },
        undefined,
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
        return true
      },
    )
    await assert.rejects(
      () => tool.execute(
        { application_id: applicationId, override: { reason: '', confirmation_text: CONFIRM_TEXT } },
        undefined,
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
        return true
      },
    )
    assert.deepEqual(await counts(client, ZERO_WRITE_TABLES), before, '空原话/空理由必须零写入')
    assert.equal(await readOverrideEvent(client, applicationId), undefined)
  })
})
