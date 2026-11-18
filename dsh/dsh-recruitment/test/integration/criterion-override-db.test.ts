// OV-1/OV-2/OV-4：criterion_override 的 DB 级追加式覆盖矩阵（真库，每用例回滚）。
//
// 覆盖：
//   OV-1 首次覆盖 → INSERT 一行；AI 原判定（此处以 interview_record/scorecard 为旁证）
//         一行不动；本表只有 1 行。
//   OV-2 同 criterion 再覆盖（不同三态）→ 旧行 superseded_by_override_id 指向新行，
//         "当前行"仍恰好 1 行；只有 superseded 指针被 UPDATE（其它列不变）。
//   OV-4 幂等重复（同三态 + 同 note + 同确认文本）→ 零写入，不产生第二条当前行。
//   负例：note > 2000 / human_state 非法 → CHECK 23514；DELETE → fn_block_delete 23514；
//         改 human_state → fn_guard_columns 23514（AI 原判定不可篡改）。
//
// 必需环境变量（与 test/integration/db.ts 一致）：RECRUITMENT_DB_PASSWORD，
// 以及可选 RECRUITMENT_TEST_DB_HOST/PORT/USER/RECRUITMENT_TEST_DB（默认 ra_s6s7）。
// 库里必须先按顺序跑完 db/migrations/0001..0017（含本轮新增 0017）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { readOverridesForApplications, recordOverride, toOverrideProjection } from '../../src/db/criterion-override.ts'
import { sha256Text } from '../../src/domain/criterion-override.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  HR_ACTOR,
  inRolledBackTx,
  seedScenario,
  TENANT,
  testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const DIMS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'edu_exists', label: '有教育经历', kind: 'MUST_HAVE', weight: 1, field: 'education', operator: 'EXISTS', value: true },
]

/** 造一份钉住 rubric 的申请夹具。 */
async function seed(client: DatabaseClient) {
  return seedScenario(client, { dimensions: DIMS })
}

function makeParams(applicationId: string, rubricVersionId: string, overrides: Record<string, unknown> = {}) {
  const base = {
    tenant_id: TENANT,
    application_id: applicationId,
    rubric_version_id: rubricVersionId,
    criterion_key: 'work_exists',
    human_state: 'PRESENT' as const,
    note: '简历第 2 页写了 2019-至今。',
    actor_id: HR_ACTOR,
    confirmation_text: '我确认：这条判定要改成有对应。',
    ...overrides,
  }
  // 哈希必须从**最终**确认原文算：overrides 里换了 confirmation_text 时，
  // 旧写法会留下过期哈希，被适配器的防御性核对正确地判为 CONFIRMATION_HASH_MISMATCH。
  return {
    ...base,
    confirmation_text_sha256: sha256Text(String(base.confirmation_text)),
  }
}

/** pg 错误把 SQLSTATE 放在 err.code（.message 里没有 23514）。 */
function assertSqlState(error: unknown, state: string, messagePart?: string): true {
  const code = (error as { code?: unknown })?.code
  assert.equal(code, state, `期望 SQLSTATE ${state}，实际 ${String(code)}（${String(error)}）`)
  if (messagePart !== undefined) assert.match(String(error), new RegExp(messagePart))
  return true
}

async function countRows(client: DatabaseClient, applicationId: string): Promise<number> {
  const row = (await client.query<{ n: string }>(
    'select count(*)::text as n from recruitment.criterion_override where tenant_id = $1 and application_id = $2',
    [TENANT, applicationId],
  )).rows[0]
  return Number(row?.n ?? '0')
}

// ---------------------------------------------------------------------------
//  OV-1：首次覆盖只 INSERT，不碰 AI 侧
// ---------------------------------------------------------------------------

test('OV-1 首次覆盖插入一行；现有 application / interview_record 内容不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const beforeApp = (await client.query<Record<string, unknown>>(
      'select to_jsonb(a) as row from recruitment.application a where tenant_id = $1 and id = $2',
      [TENANT, scenario.applicationId],
    )).rows[0]?.row
    assert.ok(beforeApp !== undefined)

    const result = await recordOverride(client, makeParams(scenario.applicationId, scenario.rubricId))
    assert.equal(result.inserted, true)
    assert.equal(result.superseded_id, null)
    assert.equal(await countRows(client, scenario.applicationId), 1)

    const row = (await client.query<Record<string, unknown>>(
      'select * from recruitment.criterion_override where id = $1', [result.override_id],
    )).rows[0]
    assert.equal(row?.human_state, 'PRESENT')
    assert.equal(row?.criterion_key, 'work_exists')
    assert.equal(row?.rubric_version_id, scenario.rubricId, 'rubric 必须取申请钉住的版本')
    assert.equal(row?.actor_id, HR_ACTOR)
    assert.equal(row?.confirmation_method, 'IN_CHAT')
    assert.equal(row?.superseded_by_override_id, null)
    assert.equal(row?.record_version, 1)

    const afterApp = (await client.query<Record<string, unknown>>(
      'select to_jsonb(a) as row from recruitment.application a where tenant_id = $1 and id = $2',
      [TENANT, scenario.applicationId],
    )).rows[0]?.row
    assert.deepEqual(afterApp, beforeApp, 'AI/业务侧 application 一行不动')

    const rows = await readOverridesForApplications(client, TENANT, [scenario.applicationId])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, result.override_id)
    assert.equal(toOverrideProjection(rows).get(scenario.applicationId)?.get('work_exists')?.human_state, 'PRESENT')
  })
})

// ---------------------------------------------------------------------------
//  OV-2：同 criterion 再覆盖 → supersede，仅一条当前行
// ---------------------------------------------------------------------------

test('OV-2 再覆盖同 criterion：旧行指向新行；只有 superseded 指针被改；当前行仍 1 条', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const first = await recordOverride(client, makeParams(scenario.applicationId, scenario.rubricId, {
      human_state: 'ABSENT', note: '第一次：没有对应。',
      confirmation_text: '第一次确认。',
    }))
    assert.equal(first.inserted, true)
    const firstRow = (await client.query<Record<string, unknown>>(
      'select * from recruitment.criterion_override where id = $1', [first.override_id],
    )).rows[0]

    const second = await recordOverride(client, makeParams(scenario.applicationId, scenario.rubricId, {
      human_state: 'PRESENT', note: '第二次：又找到了。',
      confirmation_text: '第二次确认。',
    }))
    assert.equal(second.inserted, true)
    assert.equal(second.superseded_id, first.override_id)

    const currentRows = (await client.query<{ id: string }>(
      `select id from recruitment.criterion_override
        where tenant_id = $1 and application_id = $2 and criterion_key = 'work_exists'
          and superseded_by_override_id is null`,
      [TENANT, scenario.applicationId],
    )).rows
    assert.equal(currentRows.length, 1, '同一 criterion 只能有一条当前行')
    assert.equal(currentRows[0]?.id, second.override_id)

    const afterFirst = (await client.query<Record<string, unknown>>(
      'select * from recruitment.criterion_override where id = $1', [first.override_id],
    )).rows[0]
    assert.equal(afterFirst?.superseded_by_override_id, second.override_id)
    // 旧行的原始语义一列都没变
    for (const col of ['human_state', 'note', 'actor_id', 'confirmation_text_sha256', 'criterion_key']) {
      assert.deepEqual(afterFirst?.[col], firstRow?.[col], `旧行 ${col} 不得被改写`)
    }
    assert.equal(await countRows(client, scenario.applicationId), 2, '两次覆盖 = 两行历史，不删旧行')

    const projection = toOverrideProjection(
      await readOverridesForApplications(client, TENANT, [scenario.applicationId]),
    ).get(scenario.applicationId)
    assert.equal(projection?.get('work_exists')?.human_state, 'PRESENT', '当前值 = 最新一行')
    assert.equal(projection?.get('work_exists')?.history.length, 2)
  })
})

// ---------------------------------------------------------------------------
//  OV-4：幂等重复 → 零写入
// ---------------------------------------------------------------------------

test('OV-4 重复同一覆盖（三态 + note + 确认文本全同）→ inserted=false、零新增行', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const params = makeParams(scenario.applicationId, scenario.rubricId, { confirmation_text: '同一句确认。' })
    const first = await recordOverride(client, params)
    assert.equal(first.inserted, true)

    const second = await recordOverride(client, params)
    assert.equal(second.inserted, false)
    assert.equal(second.override_id, first.override_id)
    assert.equal(second.superseded_id, null)
    assert.equal(await countRows(client, scenario.applicationId), 1, '幂等重复不得插入第二条')

    // note 不同 → 视为新覆盖（note 是理由，改理由要留痕）
    const third = await recordOverride(client, { ...params, note: '改了理由。' })
    assert.equal(third.inserted, true)
    assert.equal(third.superseded_id, first.override_id)
  })
})

// ---------------------------------------------------------------------------
//  校验失败 / DB CHECK / 禁删 / 不可篡改
// ---------------------------------------------------------------------------

test('校验：criterion 不在钉住 rubric / 申请没钉 rubric / 申请不存在 → INVALID_ARGS + reason_code', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const base = makeParams(scenario.applicationId, scenario.rubricId)

    await assert.rejects(
      recordOverride(client, { ...base, criterion_key: 'not_in_rubric' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /^INVALID_ARGS:/)
        assert.match(message, /CRITERION_NOT_IN_RUBRIC/)
        return true
      },
    )

    await client.query('update recruitment.application set rubric_version_id = null where tenant_id = $1 and id = $2', [
      TENANT, scenario.applicationId,
    ])
    await assert.rejects(
      recordOverride(client, base),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /NO_PINNED_RUBRIC/)
        return true
      },
    )

    await assert.rejects(
      recordOverride(client, { ...base, application_id: '00000000-0000-4000-8000-000000000000' }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /APPLICATION_NOT_FOUND/)
        return true
      },
    )
  })
})

test('DB CHECK：note > 2000 / 非法 human_state / 非法哈希 → 23514；DELETE → 23514；改 human_state → 23514', async () => {
  // PG 在一条语句违反 CHECK 后会 abort 整个事务（后续查询全是 25P02），
  // 所以每个负例都必须跑在**独立**的回滚事务里，不能共用一个 client。
  const expectInsertRejected = async (overrides: Record<string, unknown>): Promise<void> => {
    await inRolledBackTx(pool, async (client) => {
      const scenario = await seed(client)
      const hash = sha256Text('确认。')
      await assert.rejects(
        client.query(
          `insert into recruitment.criterion_override
             (tenant_id, application_id, rubric_version_id, criterion_key, human_state, note,
              actor_id, confirmation_text_sha256)
           values ($1, $2, $3, 'work_exists', $4, $5, $6, $7)`,
          [TENANT, scenario.applicationId, scenario.rubricId,
            overrides.human_state ?? 'PRESENT', overrides.note ?? null, HR_ACTOR,
            overrides.confirmation_text_sha256 ?? hash],
        ),
        (e: unknown) => assertSqlState(e, '23514'),
      )
    })
  }
  await expectInsertRejected({ note: 'a'.repeat(2001) })
  await expectInsertRejected({ human_state: 'MAYBE' })
  await expectInsertRejected({ confirmation_text_sha256: 'xyz' })

  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const result = await recordOverride(client, makeParams(scenario.applicationId, scenario.rubricId))
    await assert.rejects(
      client.query('delete from recruitment.criterion_override where id = $1', [result.override_id]),
      (e: unknown) => assertSqlState(e, '23514', 'DELETE_FORBIDDEN'),
    )
  })
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const result = await recordOverride(client, makeParams(scenario.applicationId, scenario.rubricId))
    await assert.rejects(
      client.query("update recruitment.criterion_override set human_state = 'ABSENT' where id = $1", [result.override_id]),
      (e: unknown) => assertSqlState(e, '23514', 'IMMUTABLE_COLUMN'),
    )
  })
})
