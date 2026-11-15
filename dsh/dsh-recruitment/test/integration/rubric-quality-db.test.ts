// Rubric 质量门槛的**真库**验证（ra_s6s7，每个用例结束一律 ROLLBACK）。
//
// 事故（2026-11-15，task-77，已验收 FAIL）：`application bc036066-…` 的 job_version
// `requirements_md = '后端开发经验；能读懂并落实接口契约。'`，rubric 只有两条机械条件
// （`work_exists` / `edu_exists`，EXISTS），`recruitment_screening_evaluate` 返回 `verdict=PASS`，
// Agent 只能说"机械 PASS、业务 HOLD"。
//
// 这里锁的是**接线**（不是纯函数逻辑，那在 test/unit/rubric-quality.test.ts）：
//   a. 机械-only rubric + 真 JD → verdict 仍是 PASS（既有语义不变），但 warnings 里必须
//      出现 `QUALITY_WARNING`、`rubric_quality.status=QUALITY_WARNING`、uncovered ≥ 1；
//   b. 好 rubric（两条 judgment 维度覆盖 JD）→ 无 `QUALITY_WARNING`、status=OK，
//      且 verdict 维持 NEEDS_REVIEW（judgment 维度不影响 PASS/FAIL 的既有语义）；
//   c. 反证"不猜"：JD 切不出任何条款 → `jd_requirements_checked=false`，只由"纯机械"告警，
//      不编造 JD 未覆盖（这也验证 requirements/description 都空/无意义时的降级路径）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import { createTestPool, inRolledBackTx, parsedFields, seedScenario, testDatabaseConfig } from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 修事故现场的两条机械条件（`weight` 各 0.5，与真实 rubric `dac1002a-…` 同形）。 */
const WORK_EXISTS = {
  key: 'work_exists', label: '简历中存在可分割的工作经历条目', kind: 'MUST_HAVE', weight: 0.5,
  field: 'work_experience', operator: 'EXISTS', value: true,
  notes: 'EXISTS 判的是 state=present（读到了），不是"这个人有工作经历"',
}
const EDU_EXISTS = {
  key: 'edu_exists', label: '简历中存在可分割的教育经历条目', kind: 'MUST_HAVE', weight: 0.5,
  field: 'education', operator: 'EXISTS', value: true,
  notes: 'state=absent → MISSING；state=unreadable → UNREADABLE',
}

/** 真实库里的 JD 原文（`job_version 90c181b9-…` 的 requirements_md）。 */
const INCIDENT_REQUIREMENTS = '后端开发经验；能读懂并落实接口契约。'

/** 好 rubric：两条判断型维度，label/question 覆盖 JD 的两条要求（`field` 缺失 = 判断型）。 */
const GOOD_DIMENSIONS = [
  {
    key: 'backend_experience', label: '后端开发经验', kind: 'MUST_HAVE', weight: 0.5,
    question: '候选人是否有可核实的后端开发工作经验？请给出材料依据。',
  },
  {
    key: 'api_contract', label: '能读懂并落实接口契约', kind: 'MUST_HAVE', weight: 0.5,
    question: '候选人是否能读懂并落实接口契约？请给出材料依据。',
  },
]

/** 跑一次评估（事务由调用方提供；`as_of` 不传 ⇒ 输出里没有墙钟字段）。 */
async function evaluate(client: Parameters<typeof evaluateInTransaction>[0], applicationId: string) {
  return evaluateInTransaction(client, cfg, { application_id: applicationId }, Date.now())
}

test('a. 机械-only rubric + 真实 JD：verdict 仍是 PASS，但必须显式出现 QUALITY_WARNING', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [WORK_EXISTS, EDU_EXISTS],
      // 两条 EXISTS 都要 SATISFIED 才可能 PASS：work_experience / education 都得 present。
      fields: parsedFields({ eduState: 'present' }),
      requirementsMd: INCIDENT_REQUIREMENTS,
    })
    // 评估前后都比一次 rubric 行：质量门槛**只提示**，不得自动改标准（维度数/payload_hash 不变）。
    const rubricBefore = await client.query<{ dimensions: unknown[]; payload_hash: string }>(
      'select dimensions, payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
      [cfg.tenant_id, scenario.rubricId],
    )
    const value = await evaluate(client, scenario.applicationId)

    // 既有判定语义**一个字都没动**：机械条件全满足 ⇒ PASS、只需确认。
    assert.equal(value.verdict, 'PASS')
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.required_human_action, 'CONFIRM_DECISION')

    // Agent/HTTP 必须显式看到的那条 warning。
    const warning = value.warnings.find((entry) => entry.code === 'QUALITY_WARNING')
    assert.ok(warning !== undefined, `warnings 必须含 QUALITY_WARNING，实际: ${value.warnings.map((w) => w.code).join(',')}`)
    assert.deepEqual(warning.ref, { field: 'rubric.dimensions', source: 'rubric_quality' })
    assert.match(String(warning.message), /质量门槛/)

    const quality = value.rubric_quality
    assert.ok(quality !== undefined, '输出必须带 rubric_quality（可选键，但本次一定给）')
    assert.equal(quality.status, 'QUALITY_WARNING')
    assert.deepEqual(quality.reasons.map((reason) => reason.code), [
      'ALL_CRITERIA_MECHANICAL',
      'EXISTENCE_ONLY',
      'JD_REQUIREMENTS_UNCOVERED',
    ])
    assert.equal(quality.mechanical_dimension_count, 2)
    assert.equal(quality.judgment_dimension_count, 0)
    assert.equal(quality.deciding_criteria_count, 2)
    assert.equal(quality.existence_only, true)
    assert.equal(quality.jd_requirements_checked, true)
    assert.equal(quality.jd_requirement_count, 2)
    assert.ok(quality.uncovered_requirements.length >= 1, '至少一条 JD 要求没被覆盖')
    assert.deepEqual(quality.uncovered_requirements.map((item) => item.requirement), [
      '后端开发经验',
      '能读懂并落实接口契约',
    ])
    for (const item of quality.uncovered_requirements) assert.equal(item.source, 'REQUIREMENTS_MD')
    assert.deepEqual(quality.uncovered_requirements.map((item) => item.suggested_dimension.key), ['jd_core_1', 'jd_core_2'])
    assert.equal(quality.human_judgment_required, true)
    assert.equal(quality.advisory, true)

    // summary：不许把裸 PASS 当业务通过。
    assert.match(value.verdict_summary, /^\[机械条件通过·非业务通过\]/)
    assert.match(value.verdict_summary, /需人判断/)
    // warning 的 message 里带建议维度 label（模型只看 status 不够）。
    assert.match(String(warning.message), /后端开发经验/)
    assert.match(String(warning.message), /需人批准/)

    // 只建议、不写库：rubric 的维度数与 payload_hash 原封不动（没有自动改标准）。
    const rubricAfter = await client.query<{ dimensions: unknown[]; payload_hash: string }>(
      'select dimensions, payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
      [cfg.tenant_id, scenario.rubricId],
    )
    assert.equal((rubricAfter.rows[0]?.dimensions as unknown[]).length, 2)
    assert.equal(rubricAfter.rows[0]?.payload_hash, rubricBefore.rows[0]?.payload_hash)
  })
})

test('b. 好 rubric（judgment 维度覆盖 JD）：无 QUALITY_WARNING、status=OK、verdict 维持 NEEDS_REVIEW', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: GOOD_DIMENSIONS,
      requirementsMd: INCIDENT_REQUIREMENTS,
    })
    const value = await evaluate(client, scenario.applicationId)

    // judgment 维度不影响 PASS/FAIL 的既有语义：两条都 NEEDS_JUDGMENT ⇒ NEEDS_REVIEW。
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.required_human_action, 'ANSWER_JUDGMENT')
    assert.deepEqual(value.reasons.map((reason) => reason.outcome), ['NEEDS_JUDGMENT', 'NEEDS_JUDGMENT'])

    // 防误报：好 rubric 不该被质量门槛告警。
    assert.equal(value.warnings.some((entry) => entry.code === 'QUALITY_WARNING'), false)
    const quality = value.rubric_quality
    assert.ok(quality !== undefined)
    assert.equal(quality.status, 'OK')
    assert.deepEqual(quality.reasons, [])
    assert.equal(quality.mechanical_dimension_count, 0)
    assert.equal(quality.judgment_dimension_count, 2)
    assert.equal(quality.existence_only, false)
    assert.equal(quality.jd_requirements_checked, true)
    assert.equal(quality.jd_requirement_count, 2)
    assert.deepEqual(quality.uncovered_requirements, [])
    assert.equal(quality.human_judgment_required, false)
    // summary 不得出现"非业务通过"前缀（它不是机械 PASS）。
    assert.equal(value.verdict_summary.startsWith('[机械条件通过·非业务通过]'), false)
  })
})

test('c. 反证"不猜"：JD 切不出条款 → jd_requirements_checked=false，只有"纯机械"告警', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 真实库不允许两段 JD 都空（`job_version_jd_not_empty` 约束），所以这里用"只有分号"
    // 的 JD：非空 ⇒ 能落库，但切不出任何条款 ⇒ 质量门槛**不猜** JD 覆盖。
    const scenario = await seedScenario(client, {
      dimensions: [WORK_EXISTS, EDU_EXISTS],
      fields: parsedFields({ eduState: 'present' }),
      descriptionMd: '；',
      requirementsMd: '；',
    })
    const value = await evaluate(client, scenario.applicationId)
    assert.equal(value.verdict, 'PASS')
    const quality = value.rubric_quality
    assert.ok(quality !== undefined)
    assert.equal(quality.jd_requirements_checked, false)
    assert.equal(quality.jd_requirement_count, 0)
    assert.deepEqual(quality.uncovered_requirements, [])
    // 纯机械仍然必须告警，但理由里不能出现 JD 未覆盖（没有 JD 就没这个结论）。
    assert.deepEqual(quality.reasons.map((reason) => reason.code), ['ALL_CRITERIA_MECHANICAL', 'EXISTENCE_ONLY'])
    assert.ok(value.warnings.some((entry) => entry.code === 'QUALITY_WARNING'))
  })
})
