// batch_operation / undo_log 访问层的**真库读回**证据（迁移 0020）。
//
// 用 createIsolatedTestDatabase('undolog')：一次性空库，0001→0020 自动重放，
// 每个用例真提交、用完 db.drop()。需要 $env:RECRUITMENT_DB_PASSWORD。
//
// 覆盖：
//   1. insertBatchOperation / insertUndoLog 幂等（同一 action_id 插两次只有一行）；
//   2. findUndoLogOriginal / findUndoLogCompensation / findBatchOperation 的 tenant 隔离；
//   3. linkCompensation 的条件更新竞态（compensation_action_id 非空 → 0 行）；
//   4. markSuperseded 条件更新 + tenant 隔离；
//   5. findBatchOperation 写后读回（含 target_summary 摘要）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  insertBatchOperation,
  insertUndoLog,
  findUndoLogOriginal,
  findUndoLogCompensation,
  linkCompensation,
  markSuperseded,
  findBatchOperation,
} from '../../src/db/undo-log.ts'
import { createIsolatedTestDatabase, hex64 } from './db.ts'

const OTHER_TENANT = '22222222-2222-4222-8222-000000000002'

const db = await createIsolatedTestDatabase('undolog')
test.after(async () => { await db.drop() })

/** 每个用例一条真提交事务（一次性库，无需回滚）。 */
async function inTx<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function action(_prefix: string): string {
  // action_id 列是 uuid → 用标准 v4 UUID（长度/段长严格合法）
  return randomUUID()
}

function batchInput(actionId: string, tenantId: string) {
  return {
    tenant_id: tenantId,
    action_id: actionId,
    operation_type: 'BATCH_REJECT' as const,
    actor_id: '11111111-1111-4111-8111-000000000103',
    reason: `批量不通过 ${prefixOf(actionId)}`,
    confirmation_text_sha256: hex64(`confirm-${actionId}`),
    target_count: 3,
    succeeded_count: 2,
    failed_count: 1,
    target_summary: [
      { application_id: '33333333-3333-4333-8333-000000000001', ok: true },
      { application_id: '33333333-3333-4333-8333-000000000002', ok: true },
      { application_id: '33333333-3333-4333-8333-000000000003', ok: false, reason_code: 'LOCKED_BY_OTHER' },
    ],
  }
}

function prefixOf(value: string): string {
  return value.slice(0, 8)
}

function originalInput(actionId: string, tenantId: string) {
  return {
    tenant_id: tenantId,
    action_id: actionId,
    kind: 'ORIGINAL' as const,
    operation_type: 'SINGLE_DECISION' as const,
    actor_id: '11111111-1111-4111-8111-000000000103',
    reason: `单人决策 ${prefixOf(actionId)}`,
    confirmation_text_sha256: hex64(`orig-${actionId}`),
    // 目标引用是可空 FK（0020 的复合外键要求真行）；本测试只验访问层形状，
    // 用 null 避免依赖业务夹具行。真实调用方会传存在的 application/decision id。
    target_application_id: null,
    target_decision_id: null,
    target_interview_id: null,
    action_type: 'DECISION' as const,
    before_summary: { stage: 'S8', version: 1 },
    after_summary: { stage: 'S9', version: 2, reason_code: 'REJECTED' },
  }
}

function compensationInput(actionId: string, tenantId: string) {
  return {
    tenant_id: tenantId,
    action_id: actionId,
    kind: 'COMPENSATION' as const,
    operation_type: 'UNDO' as const,
    actor_id: '11111111-1111-4111-8111-000000000103',
    reason: `撤销 ${prefixOf(actionId)}`,
    confirmation_text_sha256: hex64(`comp-${actionId}`),
    // 注意：compensation_action_id 写在 ORIGINAL 行上（0020 的 ck_no_self_link
    // 禁止补偿行自指），这里保持 null；linkCompensation 用例另设该指针。
  }
}

async function countRows(client: DatabaseClient, table: 'batch_operation' | 'undo_log', where: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n from recruitment.${table} where ${where}`,
    params,
  )
  return rows[0]?.n ?? -1
}

// ---------------------------------------------------------------------------

test('insertBatchOperation 幂等：同 (tenant, action_id) 两次只有一行，返回同一 id', async () => {
  const actionId = action('bo')
  await inTx(async (client) => {
    const id1 = await insertBatchOperation(client, batchInput(actionId, '11111111-1111-4111-8111-000000000001'))
    // 第二次用不同的业务值（reason/count）也不应产生第二行或改写第一行
    const id2 = await insertBatchOperation(client, {
      ...batchInput(actionId, '11111111-1111-4111-8111-000000000001'),
      reason: '重复提交应被吞掉',
      target_count: 9,
      succeeded_count: 8,
      failed_count: 1,
    })
    assert.equal(id2, id1, '幂等返回已有 id')
    assert.equal(
      await countRows(client, 'batch_operation', 'tenant_id = $1 and action_id = $2',
        ['11111111-1111-4111-8111-000000000001', actionId]),
      1, '只有一行',
    )
    const read = await findBatchOperation(client, '11111111-1111-4111-8111-000000000001', actionId)
    assert.equal(read?.target_count, 3, '第一次写入的值未被覆盖')
  })
})

test('insertUndoLog 幂等：同 (tenant, action_id, kind) 两次只有一行；ORIGINAL 与 COMPENSATION 可共存', async () => {
  const actionId = action('ul')
  await inTx(async (client) => {
    const tenant = '11111111-1111-4111-8111-000000000001'
    const o1 = await insertUndoLog(client, originalInput(actionId, tenant))
    const o2 = await insertUndoLog(client, { ...originalInput(actionId, tenant), reason: '重复 ORIGINAL' })
    assert.equal(o2, o1, 'ORIGINAL 幂等返回已有 id')
    assert.equal(
      await countRows(client, 'undo_log', 'tenant_id = $1 and action_id = $2 and kind = $3', [tenant, actionId, 'ORIGINAL']),
      1, 'ORIGINAL 只有一行',
    )

    const c1 = await insertUndoLog(client, compensationInput(actionId, tenant))
    const c2 = await insertUndoLog(client, { ...compensationInput(actionId, tenant), reason: '重复 COMPENSATION' })
    assert.equal(c2, c1, 'COMPENSATION 幂等返回已有 id')
    assert.equal(
      await countRows(client, 'undo_log', 'tenant_id = $1 and action_id = $2', [tenant, actionId]),
      2, 'ORIGINAL + COMPENSATION 两行共存',
    )
    assert.notEqual(o1, c1, '两种 kind 是不同行')
  })
})

test('find* 的 tenant 隔离：另一租户查不到同 action_id 的行', async () => {
  const actionId = action('iso')
  const tenant = '11111111-1111-4111-8111-000000000001'
  await inTx(async (client) => {
    await insertBatchOperation(client, batchInput(actionId, tenant))
    await insertUndoLog(client, originalInput(actionId, tenant))
    await insertUndoLog(client, compensationInput(actionId, tenant))

    assert.equal(await findBatchOperation(client, OTHER_TENANT, actionId), undefined)
    assert.equal(await findUndoLogOriginal(client, OTHER_TENANT, actionId), undefined)
    assert.equal(await findUndoLogCompensation(client, OTHER_TENANT, actionId), undefined)

    // 正确租户读得到
    assert.ok(await findBatchOperation(client, tenant, actionId))
    assert.ok(await findUndoLogOriginal(client, tenant, actionId))
    assert.ok(await findUndoLogCompensation(client, tenant, actionId))
  })
})

test('linkCompensation：条件更新成功一次，第二次（非空）返回 0；tenant 隔离', async () => {
  const actionId = action('link')
  const tenant = '11111111-1111-4111-8111-000000000001'
  const compensationActionId = action('cmp')
  await inTx(async (client) => {
    await insertUndoLog(client, originalInput(actionId, tenant))

    // 错租户更新 → 0
    assert.equal(await linkCompensation(client, OTHER_TENANT, actionId, compensationActionId), 0)

    // 首次更新 → 1
    assert.equal(await linkCompensation(client, tenant, actionId, compensationActionId), 1)
    const row = await findUndoLogOriginal(client, tenant, actionId)
    assert.equal(row?.compensation_action_id, compensationActionId)

    // 竞态：别人已抢先撤销（compensation_action_id 非空）→ 0，且值不被覆盖
    assert.equal(await linkCompensation(client, tenant, actionId, action('other')), 0)
    const again = await findUndoLogOriginal(client, tenant, actionId)
    assert.equal(again?.compensation_action_id, compensationActionId, '原指针不被覆盖')
  })
})

test('markSuperseded：条件更新 + tenant 隔离 + 不覆盖', async () => {
  const actionId = action('sup')
  const tenant = '11111111-1111-4111-8111-000000000001'
  const first = action('s1')
  await inTx(async (client) => {
    await insertUndoLog(client, originalInput(actionId, tenant))

    assert.equal(await markSuperseded(client, OTHER_TENANT, actionId, first), 0)
    assert.equal(await markSuperseded(client, tenant, actionId, first), 1)
    assert.equal((await findUndoLogOriginal(client, tenant, actionId))?.superseded_by_action_id, first)

    assert.equal(await markSuperseded(client, tenant, actionId, action('s2')), 0, '已有值不再覆盖')
  })
})

test('findBatchOperation：写后读回完整摘要', async () => {
  const actionId = action('read')
  const tenant = '11111111-1111-4111-8111-000000000001'
  await inTx(async (client) => {
    await insertBatchOperation(client, batchInput(actionId, tenant))
    const read = await findBatchOperation(client, tenant, actionId)
    assert.ok(read)
    assert.equal(read?.target_count, 3)
    assert.equal(read?.succeeded_count, 2)
    assert.equal(read?.failed_count, 1)
    const summary = read?.target_summary as { application_id: string; ok: boolean; reason_code?: string }[]
    assert.equal(summary.length, 3)
    assert.equal(summary[2]?.reason_code, 'LOCKED_BY_OTHER')
  })
})
