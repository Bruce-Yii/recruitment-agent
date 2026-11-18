// AT-1/2/3 跨岗携带历史的**真库读回**证据（每个用例在必然回滚的事务里跑，不污染测试库）。
// 需要 db/migrations/0018_atomic_capabilities.sql 已应用（application_carry_over 存在）。
//
// 覆盖：
//   AT-1/AT-3：同一候选人的两个申请，validate → insert → 读回 1 行；再次 insert 仍 1 行（on conflict 真库生效）；
//              源申请的 record_version / updated_at 前后不变（从不 UPDATE 旧申请）。
//   AT-2：另一 candidate 的源申请 → reject，application / application_carry_over 逐表行数前后不变；
//         不存在的源申请（跨租户同义）→ reject，行数不变。
//   负例：源=目标、ref 不属于源 → reject，行数不变。
//   读投影：readApplicationValue 的 carry_over 段读回 source/ref/carried_by。
import test from 'node:test'
import assert from 'node:assert/strict'

import { insertCarryOverRefs, validateCarryOverRefs, type CarryOverRef } from '../../src/db/carry-over.ts'
import { readApplicationValue } from '../../src/tools/business-read.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool, errorBody, inRolledBackTx, one, seedScenario, testDatabaseConfig, TENANT,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)
test.after(async () => { await pool.end() })

const DIMENSIONS = [{
  key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1,
  field: 'work_experience', operator: 'EXISTS', value: true,
}]

/** 造一条真实 decision（DECISION ref 的归属由 application_id 判定）。 */
async function seedDecision(client: DatabaseClient, applicationId: string): Promise<string> {
  return one(client,
    `insert into recruitment.decision
       (tenant_id, application_id, decision_scope, stage_code, result, decided_by_actor_id, reason, basis_refs)
     values ($1, $2, 'SCREENING', 'S7', 'HOLD', $3, 'AT-A 真库携带测试', '[]'::jsonb)
     returning id`,
    [TENANT, applicationId, cfg.actor_id])
}

function decisionRef(sourceApplicationId: string, decisionId: string): CarryOverRef {
  return { source_application_id: sourceApplicationId, ref_kind: 'DECISION', ref_id: decisionId }
}

/** 逐表行数（AT-2/负例的零写入断言）。 */
async function counts(client: DatabaseClient): Promise<{ application: number; carry_over: number }> {
  // 顺序 await：pg 的同一个 client 上并行 query 会触发弃用告警（见 pg@9 计划）。
  const apps = await client.query<{ n: number }>('select count(*)::int as n from recruitment.application')
  const carry = await client.query<{ n: number }>('select count(*)::int as n from recruitment.application_carry_over')
  return { application: apps.rows[0]?.n ?? -1, carry_over: carry.rows[0]?.n ?? -1 }
}

async function expectReason(run: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.equal(errorBody(error).reason_code, reason)
    return true
  })
}

/** 同一候选人的两个申请（seedScenario 各自建岗位；只复用 candidate_id）。 */
async function sameCandidatePair(client: DatabaseClient): Promise<{ source: string; target: string }> {
  const source = await seedScenario(client, { dimensions: DIMENSIONS })
  const target = await seedScenario(client, { dimensions: DIMENSIONS, candidateId: source.candidateId })
  return { source: source.applicationId, target: target.applicationId }
}

// ---------------------------------------------------------------------------

test('AT-1/AT-3 真库：同候选人携带 → 读回 1 行；重复提交仍 1 行；源申请一行不改', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { source, target } = await sameCandidatePair(client)
    const decisionId = await seedDecision(client, source)
    const ref = decisionRef(source, decisionId)

    const sourceBefore = (await client.query<{ record_version: number; updated_at: Date }>(
      'select record_version, updated_at from recruitment.application where id = $1 and tenant_id = $2',
      [source, TENANT],
    )).rows[0]
    assert.ok(sourceBefore !== undefined)

    await validateCarryOverRefs(client, TENANT, target, [ref])
    const inserted = await insertCarryOverRefs(client, TENANT, target, [ref], cfg.actor_id)
    assert.equal(inserted, 1)

    const readBack = (await client.query<Record<string, unknown>>(
      `select source_application_id, ref_kind, ref_id, carried_by_actor_id, created_at
         from recruitment.application_carry_over
        where tenant_id = $1 and application_id = $2 and source_application_id = $3`,
      [TENANT, target, source],
    )).rows
    assert.equal(readBack.length, 1, '真库读回恰好 1 行')
    assert.deepEqual({
      source_application_id: readBack[0]?.source_application_id,
      ref_kind: readBack[0]?.ref_kind,
      ref_id: readBack[0]?.ref_id,
      carried_by_actor_id: readBack[0]?.carried_by_actor_id,
    }, {
      source_application_id: source,
      ref_kind: 'DECISION',
      ref_id: decisionId,
      carried_by_actor_id: cfg.actor_id,
    })
    assert.ok(readBack[0]?.created_at instanceof Date)

    // AT-1：源申请（旧行）一行不改。
    const sourceAfter = (await client.query<{ record_version: number; updated_at: Date }>(
      'select record_version, updated_at from recruitment.application where id = $1 and tenant_id = $2',
      [source, TENANT],
    )).rows[0]
    assert.deepEqual(sourceAfter, sourceBefore, '源申请 record_version / updated_at 不变')

    // AT-3：同一唯一键重复提交 → 不报错、不产生第二行、返回 0。
    const again = await insertCarryOverRefs(client, TENANT, target, [ref], cfg.actor_id)
    assert.equal(again, 0, 'on conflict do nothing 吞掉重复提交')
    const afterRepeat = await counts(client)
    assert.equal(afterRepeat.carry_over, 1, '真库 on conflict 生效：仍恰好 1 行')

    // 读投影：application_get 的 carry_over 段读回"从哪来、带了什么、谁带的"。
    const value = await readApplicationValue(client, cfg, { application_id: target })
    const application = value.applications[0]
    assert.ok(application !== undefined)
    assert.equal(application.carry_over.count, 1)
    assert.deepEqual(application.carry_over.items.map((item) => ({
      source_application_id: item.source_application_id,
      ref_kind: item.ref_kind,
      ref_id: item.ref_id,
      carried_by_actor_id: item.carried_by_actor_id,
    })), [{
      source_application_id: source,
      ref_kind: 'DECISION',
      ref_id: decisionId,
      carried_by_actor_id: cfg.actor_id,
    }])
  })
})

test('AT-2 真库负例：跨候选人 / 源不存在 → reject，逐表行数不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const source = await seedScenario(client, { dimensions: DIMENSIONS }) // candidate A
    const target = await seedScenario(client, { dimensions: DIMENSIONS }) // candidate B（默认新 candidate）
    const decisionId = await seedDecision(client, source.applicationId)
    const ref = decisionRef(source.applicationId, decisionId)

    let before = await counts(client)
    await expectReason(
      validateCarryOverRefs(client, TENANT, target.applicationId, [ref]),
      'CARRY_OVER_CANDIDATE_MISMATCH',
    )
    assert.deepEqual(await counts(client), before, 'AT-2 跨候选人：application / carry_over 行数不变')

    // 源申请不在本租户（用一个根本不存在的 UUID）：租户过滤查不到 → fail-closed。
    const missingSource = '00000000-0000-4000-8000-000000000099'
    before = await counts(client)
    await expectReason(
      validateCarryOverRefs(client, TENANT, target.applicationId, [decisionRef(missingSource, decisionId)]),
      'CARRY_OVER_REF_NOT_FOUND',
    )
    assert.deepEqual(await counts(client), before, '跨租户/不存在源：零写入')
  })
})

test('AT-A 真库负例：源=目标 / ref 不属于源 → reject，逐表行数不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const first = await seedScenario(client, { dimensions: DIMENSIONS })
    const second = await seedScenario(client, { dimensions: DIMENSIONS, candidateId: first.candidateId })
    const decisionId = await seedDecision(client, first.applicationId)

    // 源=目标
    let before = await counts(client)
    await expectReason(
      validateCarryOverRefs(client, TENANT, second.applicationId, [decisionRef(second.applicationId, decisionId)]),
      'CARRY_OVER_SOURCE_IS_TARGET',
    )
    assert.deepEqual(await counts(client), before)

    // ref 真实存在，但属于另一条申请（same candidate 也不能借）：
    // 再造第三条同候选人申请及其 decision，用它的 id 冒充 first 的 ref。
    const third = await seedScenario(client, { dimensions: DIMENSIONS, candidateId: first.candidateId })
    const foreignDecisionId = await seedDecision(client, third.applicationId)
    before = await counts(client)
    await expectReason(
      validateCarryOverRefs(client, TENANT, second.applicationId, [decisionRef(first.applicationId, foreignDecisionId)]),
      'CARRY_OVER_REF_NOT_FOUND',
    )
    assert.deepEqual(await counts(client), before, 'ref 不属于源：零写入')
  })
})
