// S7 判定矩阵（**连真库** ra_s6s7，每个用例结束回滚）。
//
// 覆盖 TC §5.2 的六个探针 + SR §13 的自检清单里的可机检项：
//   P1/P2 有界量 · P3 absent≠FAIL · P5 NICE_TO_HAVE 不影响 verdict ·
//   P6 岗位 CLOSED 走 GATE 而不是抛错 · P4 人工队列 → BLOCKED_BY_REVIEW ·
//   以及 NO_RUBRIC 的四种 reason_code、只读不变量、read-only 事务。
import test from 'node:test'
import assert from 'node:assert/strict'

import { withActor, withReadOnly } from '../../src/db/pool.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import {
  createTestPool, errorBody, hex64, inRolledBackTx, parsedFields, seedScenario, testDatabaseConfig,
  TENANT, HR_ACTOR,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const WORK_EXISTS = { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true }
const EDU_EXISTS = { key: 'edu_exists', label: '有教育经历', kind: 'MUST_HAVE', weight: 0.5, field: 'education', operator: 'EXISTS', value: true }
const MONTHS_GTE60 = { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 1, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 }
const MONTHS_LTE60 = { key: 'too_short', label: '不足 60 个月即排除', kind: 'DISQUALIFIER', weight: 1, field: 'timeline.covered_months_closed', operator: 'LTE', value: 60 }
const ENTRY_GTE3 = { key: 'entries', label: '≥3 段经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience.entry_count', operator: 'GTE', value: 3 }
const BONUS_LEAD = { key: 'team_lead', label: '带团队', kind: 'NICE_TO_HAVE', weight: 1, question: '是否有 ≥1 年、≥3 人的直接带团队经历？' }

/** 跑一次评估（事务由调用方提供）。 */
async function evaluate(client: Parameters<typeof evaluateInTransaction>[0], applicationId: string, extra: Record<string, unknown> = {}) {
  return evaluateInTransaction(client, cfg, { application_id: applicationId, ...extra }, Date.now())
}

test('PASS：所有 MUST_HAVE 满足 + DISQUALIFIER 明确 CLEAR（NICE_TO_HAVE 不影响）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 两条硬性 + 一条排除 + 一条加分，weight 各自独立（判定与 weight 无关）
    const scenario = await seedScenario(client, {
      dimensions: [
        { ...WORK_EXISTS, weight: 0.4 },
        { ...ENTRY_GTE3, key: 'entries_ok', weight: 0.0, value: 1 },
        { ...MONTHS_LTE60, weight: 0.3 },
        { ...BONUS_LEAD, weight: 0.3 },
      ].map((c) => ({ ...c, label: String(c.key) })),
      // entry_count 必须给：R-VAL 允许 GTE，但分量缺失会变 INDETERMINATE（不是不满足）
      fields: parsedFields({ entryCount: 1 }),
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'PASS')
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.required_human_action, 'CONFIRM_DECISION')
    // reasons 只装 MUST_HAVE + DISQUALIFIER
    assert.equal(value.reasons.length, 3)
    assert.equal(value.bonus_signals.length, 1)
    assert.equal(value.bonus_signals[0]?.code, 'BONUS_NEEDS_JUDGMENT')
    // A4：PASS 时每条 MUST_HAVE 都有 MUST_HAVE_SATISFIED 且 evidence ≥ 1
    for (const reason of value.reasons.filter((r) => r.kind === 'MUST_HAVE')) {
      assert.equal(reason.code, 'MUST_HAVE_SATISFIED')
      assert.ok(reason.evidence.length >= 1)
      assert.equal(reason.evidence[0]?.source_asset_sha256, value.resume_version.source_asset_sha256)
    }
    // DISQUALIFIER 的 LTE 在 74 > 60 时是 CLEAR
    const disq = value.reasons.find((r) => r.kind === 'DISQUALIFIER')
    assert.equal(disq?.outcome, 'CLEAR')
    assert.equal(disq?.tri_state, 'present')
  })
})

test('FAIL：MUST_HAVE 有原文反证（A1），且删除 unreadable 条目后仍是 FAIL（A2）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [
        { ...ENTRY_GTE3, weight: 0.5 },
        { ...EDU_EXISTS, weight: 0.5 },
      ].map((c) => ({ ...c, label: String(c.key) })),
      fields: parsedFields({ entryCount: 1 }),
    })
    // entry_count=1 → 1>=3 不成立 → UNSATISFIED；education absent → MISSING
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'FAIL')
    const hardFail = value.reasons.filter((r) => r.failure_class === 'HARD_FAIL')
    assert.equal(hardFail.length, 1)
    assert.equal(hardFail[0]?.code, 'MUST_HAVE_UNSATISFIED')
    assert.equal(hardFail[0]?.tri_state, 'present')
    assert.ok((hardFail[0]?.evidence.length ?? 0) >= 1)
    // A2：把 unreadable/missing 全删掉，结论仍然是 FAIL
    assert.ok(value.reasons.some((r) => r.outcome === 'MISSING'))
    assert.equal(value.required_human_action, 'CONFIRM_DECISION')
  })
})

test('P3：MUST_HAVE 只有 absent → NEEDS_REVIEW（不是 FAIL），带 absence', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...EDU_EXISTS, weight: 1 }],
      fields: undefined,
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    const reason = value.reasons[0]
    assert.equal(reason?.code, 'MUST_HAVE_MISSING')
    assert.equal(reason?.tri_state, 'absent')
    assert.ok(reason?.absence)
    assert.equal(reason?.absence?.hard_issue_count, 0)
    assert.equal(value.required_human_action, 'REVIEW_MISSING_FIELDS')
  })
})

test('P1/P2：有界量——下界够就 SATISFIED；下界不够是 INDETERMINATE（不得 UNSATISFIED）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const enough = await seedScenario(client, {
      dimensions: [{ ...MONTHS_GTE60, weight: 1 }],
      // P1 的原样场景：简历有"至今"区间（open_ended=1），闭区间 74 个月
      fields: parsedFields({ coveredMonths: 74, openEnded: 1 }),
    })
    const pass = await evaluate(client, enough.applicationId)
    assert.equal(pass.verdict, 'PASS')
    assert.equal(pass.reasons[0]?.bounds, 'LOWER_BOUND')
    assert.equal(pass.reasons[0]?.outcome, 'SATISFIED')

    const short = await seedScenario(client, {
      dimensions: [{ ...MONTHS_GTE60, weight: 1 }],
      fields: parsedFields({ coveredMonths: 41, openEnded: 1 }),
    })
    const review = await evaluate(client, short.applicationId)
    assert.equal(review.verdict, 'NEEDS_REVIEW')
    assert.equal(review.reasons[0]?.outcome, 'INDETERMINATE')
    assert.equal(review.reasons[0]?.bounds, 'LOWER_BOUND')
    assert.equal(review.reasons[0]?.observed?.lower_bound, 41)
    assert.equal(review.required_human_action, 'REVIEW_INDETERMINATE')
  })
})

test('SR §3.3：PARTIAL + HARD issue → absent 降级为 unreadable + ABSENT_DOWNGRADED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { parsedFields } = await import('./db.ts')
    const scenario = await seedScenario(client, {
      dimensions: [{ ...EDU_EXISTS, weight: 1 }],
      fields: parsedFields({ issues: [{ code: 'pdf_no_text' }] }),
      parseStatus: 'PARTIAL',
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.reasons[0]?.outcome, 'UNREADABLE')
    assert.ok(value.warnings.some((w) => w.code === 'ABSENT_DOWNGRADED'))
    assert.equal(value.required_human_action, 'REVIEW_UNREADABLE')
  })
})

test('P6：岗位 CLOSED → NEEDS_REVIEW + GATE_JOB_CLOSED + criteria_evaluated=false（不是抛错）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      jobStatus: 'CLOSED',
      fields: undefined,
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.criteria_evaluated, false)
    assert.deepEqual(value.reasons.map((r) => r.code), ['GATE_JOB_CLOSED'])
    assert.equal(value.reasons[0]?.failure_class, 'GATE')
    assert.equal(value.required_human_action, 'RESOLVE_BLOCKER')
    assert.deepEqual(value.bonus_signals, [])
  })
})

test('P6b：申请 WITHDRAWN → GATE_APPLICATION_NOT_ACTIVE', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      lifecycleStatus: 'WITHDRAWN',
      fields: undefined,
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.deepEqual(value.reasons.map((r) => r.code), ['GATE_APPLICATION_NOT_ACTIVE'])
    assert.equal(value.criteria_evaluated, false)
  })
})

test('P4：business_task 在 WAITING_HUMAN 且指向该 candidate → BLOCKED_BY_REVIEW(HUMAN_TASK_WAITING)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      fields: undefined,
    })
    await client.query(`insert into recruitment.business_task
        (tenant_id, task_type, business_refs, title, idempotency_key, status)
        values ($1, 'RESOLVE_IDENTITY_CONFLICT', $2::jsonb, '待人工：身份冲突', $3, 'WAITING_HUMAN')`, [
      TENANT,
      JSON.stringify([{ kind: 'CANDIDATE', id: scenario.candidateId }]),
      `task:${scenario.applicationId}`,
    ])
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
      const body = errorBody(error)
      assert.equal(body.reason_code, 'HUMAN_TASK_WAITING')
      const detail = body.detail as { human_queue_checked: number; blocking_items: { code: string; family: string }[] }
      assert.equal(detail.human_queue_checked, 7, '必须回报做了 7 条检查')
      assert.equal(detail.blocking_items.length, 1)
      assert.equal(detail.blocking_items[0]?.code, 'HUMAN_TASK_WAITING')
      assert.equal(detail.blocking_items[0]?.family, 'HUMAN_QUEUE')
      return true
    })
  })
})

test('P4b：parse_status=NEEDS_REVIEW → BLOCKED_BY_REVIEW(PARSE_NEEDS_REVIEW)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      parseStatus: 'NEEDS_REVIEW',
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'PARSE_NEEDS_REVIEW')
      return true
    })
  })
})

test('HQ-7：intake_asset INVALID → BLOCKED_BY_REVIEW(INTAKE_ASSET_INVALID)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      assetValidation: 'INVALID',
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'INTAKE_ASSET_INVALID')
      return true
    })
  })
})

test('HQ-6：申请没绑材料且入参没给 → BLOCKED_BY_REVIEW(MATERIAL_NOT_BOUND)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      bindMaterial: false,
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.reason_code, 'MATERIAL_NOT_BOUND')
      const detail = body.detail as { blocking_items: unknown[] }
      assert.equal(detail.blocking_items.length, 1, 'blocking_items 不得为空')
      return true
    })
  })
})

test('NO_RUBRIC(NO_APPROVED_RUBRIC)：有版本但没有已批准审批', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      approve: false,
      pinRubric: false,
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      const body = errorBody(error)
      assert.equal((error as { code?: string }).code, 'NO_RUBRIC')
      assert.equal(body.reason_code, 'NO_APPROVED_RUBRIC')
      const detail = body.detail as { versions: { version_no: number; status: string }[] }
      assert.equal(detail.versions[0]?.status, 'NO_APPROVAL')
      return true
    })
  })
})

test('NO_RUBRIC(RUBRIC_INVALID)：protected 字段进 criterion（J-8）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // rubric_version 整行不可 UPDATE（J-1），所以直接造一条带 protected.field 的版本
    const scenario = await seedScenario(client, {
      dimensions: [
        { key: 'age_ge', label: '年龄', kind: 'MUST_HAVE', weight: 1, field: 'protected.age_or_birth', operator: 'EXISTS', value: true },
      ],
      pinRubric: false,
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      const body = errorBody(error)
      assert.equal((error as { code?: string }).code, 'NO_RUBRIC')
      assert.equal(body.reason_code, 'RUBRIC_INVALID')
      const detail = body.detail as { violations: { rule: string; reason_code: string }[] }
      assert.ok(detail.violations.some((v) => v.reason_code === 'PROTECTED_ATTRIBUTE_IN_CRITERIA'))
      return true
    })
  })
})

test('NO_RUBRIC(RUBRIC_INVALID/RUBRIC_HASH_MISMATCH)：payload_hash 与 dimensions 不匹配（R-VAL-14）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      rubricHashOverride: hex64('wrong-hash'),
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.reason_code, 'RUBRIC_INVALID')
      const detail = body.detail as { violations: { rule: string; reason_code: string }[] }
      assert.equal(detail.violations[0]?.rule, 'R-VAL-14')
      assert.equal(detail.violations[0]?.reason_code, 'RUBRIC_HASH_MISMATCH')
      return true
    })
  })
})

test('NO_RUBRIC(UNSUPPORTED_PAYLOAD_SCHEMA_VERSION)：审批 payload_schema_version ≠ 1', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      approvalSchemaVersion: 2,
      fields: undefined,
    })
    await assert.rejects(evaluate(client, scenario.applicationId), (error: unknown) => {
      assert.equal(errorBody(error).reason_code, 'UNSUPPORTED_PAYLOAD_SCHEMA_VERSION')
      return true
    })
  })
})

test('TC §3.1 第 1 条：显式传别的候选人的材料 → INVALID_ARGS(RESUME_NOT_BELONG_TO_CANDIDATE)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const mine = await seedScenario(client, { dimensions: [{ ...WORK_EXISTS, weight: 1 }], fields: undefined })
    const other = await seedScenario(client, { dimensions: [{ ...WORK_EXISTS, weight: 1 }], fields: undefined })
    await assert.rejects(evaluate(client, mine.applicationId, { resume_version_id: other.resumeVersionId }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
      assert.equal(errorBody(error).reason_code, 'RESUME_NOT_BELONG_TO_CANDIDATE')
      return true
    })
  })
})

test('what_if：显式 rubric_version_id 与钉住版本不同 → what_if=true + WHAT_IF_EVALUATION', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      fields: undefined,
    })
    // 同岗位第二版（版本号 2），同样批准
    const dims = [{ ...EDU_EXISTS, weight: 1 }]
    const payloadHash = digestOf(dims)
    const secondId = (await client.query<{ id: string }>(`insert into recruitment.rubric_version
        (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
        values ($1, $2, 2, $3::jsonb, $4, $5) returning id`, [
      TENANT, scenario.jobId, JSON.stringify(dims), payloadHash, HR_ACTOR,
    ])).rows[0]?.id
    assert.ok(secondId)
    await client.query(`insert into recruitment.approval
        (tenant_id, resource_type, resource_id, resource_record_version, payload_schema_version,
         canonical_payload_hash, status, requested_by_actor_id, decision_by_actor_id, decided_at, reason)
        values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'APPROVED', $4, $4, now(), 'x')`, [
      TENANT, secondId, payloadHash, HR_ACTOR,
    ])
    const value = await evaluate(client, scenario.applicationId, { rubric_version_id: secondId })
    assert.equal(value.rubric.resolution, 'ARGUMENT')
    assert.equal(value.rubric.what_if, true)
    // D-21/D-48：当前版本只由 job.current_rubric_version_id 说话。v2 虽然已批准，但指针仍指 v1
    // （v2 是测试直接插的，没走 job_rubric_approve）⇒ v2 不是 current，v1 才是。
    assert.equal(value.rubric.is_current, false, 'v2 已批准但不是 current：current 只看 job.current_rubric_version_id')
    const pinned = (await client.query<{ current_rubric_version_id: string | null }>(
      'select current_rubric_version_id from recruitment.job where tenant_id = $1 and id = $2',
      [TENANT, scenario.jobId],
    )).rows[0]?.current_rubric_version_id
    assert.equal(pinned, scenario.rubricId, '夹具的 current 指针仍指 v1')
    assert.ok(value.warnings.some((w) => w.code === 'WHAT_IF_EVALUATION'))
    // v1 仍被钉住 ⇒ v2 的 edu 判定生效，但输出明确标 what_if
    assert.equal(value.verdict, 'NEEDS_REVIEW')
  })
})

test('只读不变量：调用前后 application.record_version / decision 行数 / parse_status 全不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: [{ ...WORK_EXISTS, weight: 1 }], fields: undefined })
    const before = await snapshot(client, scenario.applicationId)
    await evaluate(client, scenario.applicationId)
    await assert.rejects(evaluate(client, '00000000-0000-4000-8000-000000000000'))
    const after = await snapshot(client, scenario.applicationId)
    assert.deepEqual(after, before)
  })
})

async function snapshot(client: Parameters<typeof evaluateInTransaction>[0], applicationId: string): Promise<Record<string, unknown>> {
  const application = await client.query(
    'select record_version, resume_version_id, rubric_version_id, current_stage_code, lifecycle_status from recruitment.application where id = $1',
    [applicationId],
  )
  const rv = await client.query(
    `select rv.parse_status, rv.version_no from recruitment.resume_version rv
       join recruitment.application a on a.resume_version_id = rv.id where a.id = $1`,
    [applicationId],
  )
  const decisions = await client.query(
    'select count(*)::int as n from recruitment.decision where application_id = $1',
    [applicationId],
  )
  const tasks = await client.query(
    'select count(*)::int as n from recruitment.business_task where tenant_id = $1',
    [TENANT],
  )
  return {
    application: application.rows[0],
    resume_version: rv.rows[0],
    decisions: decisions.rows[0],
    tasks: tasks.rows[0],
  }
}

test('结构只读：withReadOnly 事务里写库直接被数据库拒绝（25006）', async () => {
  await assert.rejects(withReadOnly(pool, async (client) => {
    await client.query(`insert into recruitment.event_inbox
      (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
      values ($1, 'internal', 'test.write', $2, '{}'::jsonb, 'INTERNAL')`, [TENANT, `ro:${unique()}`])
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, '25006')
    return true
  })
})

test('D-18：withActor 用 SET LOCAL，事务结束后 actor 不再可见（不会泄漏到下一个请求）', async () => {
  await withActor(pool, HR_ACTOR, async (client) => {
    const { rows } = await client.query<{ v: string }>("select current_setting('recruitment.actor_id', true) as v")
    assert.equal(rows[0]?.v, HR_ACTOR)
  })
  const client = await pool.connect()
  try {
    const { rows } = await client.query<{ v: string | null }>("select current_setting('recruitment.actor_id', true) as v")
    // 新事务里为空（SET LOCAL 已随上一事务结束失效）
    assert.ok(rows[0]?.v === null || rows[0]?.v === '')
  } finally {
    client.release()
  }
})

function unique(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}
