// 2026-11-14 P0 回归：**含判断型准则的 rubric，用产品入口建出来后 S7 必须能评估**。
//
// 缺陷现场（真实 TypeError，不是推断）：
//   `recruitment_job_create` 把判断型准则归一化成 `"field": null`，
//   而 `recruitment_screening_evaluate.evaluateCriterion` 只认 `field === undefined`，
//   于是 `null` 掉进 `resolveFieldFact(ctx, null)` →
//   `TypeError: Cannot read properties of null (reading 'startsWith')`（screening-evaluate.ts:965）。
//   影响面：凡是用产品入口建的、含判断型准则的 rubric，S7 一律崩。
//   此前"能跑通"的验收 rubric 是手工 SQL 插的（判断型准则**没有** field 键），恰好绕开该分支。
//
// 本文件钉住四件事（缺一不可）：
//   1. **产品入口链路**：job_create 工具（真实 execute）→ 人批准（approval=allowed-once）→
//      S7 工具（真实 execute）能评估；且落库形状是诚实的（判断型没有 field/operator/value 键）。
//   2. **判定语义正确**：判断型 MUST_HAVE → `MUST_HAVE_NEEDS_JUDGMENT`（不是靠兜底蒙混成
//      MISSING/UNREADABLE），问句原样进输出，verdict=NEEDS_REVIEW、required_human_action=ANSWER_JUDGMENT；
//      判断型 NICE_TO_HAVE 只进 `bonus_signals`，不影响 verdict。
//   3. **向后兼容（手工 SQL 旧形状）**：判断型准则没有 field 键（旧验收 rubric 的形状）仍能评估。
//   4. **向后兼容（历史产品形状）**：`field: null` / `operator: null` / `value: null` /
//      `question: null` / `notes: null` 的极端形状不崩，且 null 不得漏进输出（输出 schema 不收 null）。
//
// 为什么 1 用一次性空库（`createIsolatedTestDatabase`）：产品入口工具各开自己的连接池、读**已提交**的行，
// 在共享库的回滚事务里看不到自己写的行。材料夹具（resume/application）直接写 SQL —— 它们不是本缺陷的对象，
// 而且 `seedScenario` 也是这么造夹具的（工具端点不提供造材料入口）。用例结束整库 DROP，不污染 `ra_s6s7`。
import test from 'node:test'
import assert from 'node:assert/strict'
import type { PoolClient } from 'pg'

import { createJobCreateTool } from '../../src/tools/job-create.ts'
import { createJobRubricApproveTool } from '../../src/tools/job-rubric-approve.ts'
import { createScreeningEvaluateTool, evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import { digestOf } from '../../src/tools/contract.ts'
import {
  HR_ACTOR,
  TENANT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  createTestPool,
  hex64,
  inRolledBackTx,
  one,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 机械型：`work_experience` state=present ⇒ SATISFIED。 */
const MECHANICAL = {
  key: 'work_exists',
  label: '简历中存在可分割的工作经历条目',
  kind: 'MUST_HAVE',
  weight: 0.4,
  field: 'work_experience',
  operator: 'EXISTS',
  value: true,
}

/** 判断型 MUST_HAVE：学历不在机械白名单里，只能人判。 */
const JUDGMENT_DECIDING = {
  key: 'bachelor_or_above',
  label: '本科及以上学历',
  kind: 'MUST_HAVE',
  weight: 0.35,
  question: '候选人是否具备本科及以上学历？',
}

/** 判断型 NICE_TO_HAVE：只进 bonus_signals，对 verdict 无影响。 */
const JUDGMENT_BONUS = {
  key: 'team_lead',
  label: '有带团队经验',
  kind: 'NICE_TO_HAVE',
  weight: 0.25,
  question: '是否有 ≥1 年、≥3 人的直接带团队经历？',
  notes: '判断型：机器不判，只进 bonus_signals',
}

/** 本用例 rubric 的权重和必须 = 1（R-VAL-6）。 */
const CRITERIA = [MECHANICAL, JUDGMENT_DECIDING, JUDGMENT_BONUS]

/** `select ... returning id` 的薄封装（返回值是 uuid 文本）。 */
async function insertId(client: PoolClient, sql: string, params: readonly unknown[]): Promise<string> {
  return one(client, sql, params)
}

/**
 * 往**一次性库**里提交一份材料夹具（candidate → event → intake → asset → resume → resume_version → application）。
 *
 * 为什么直连 SQL：`application_intake` 要跑 PDF converter，这里要验的是 rubric 形状与 S7 读侧，
 * 材料只需要"PARSED + 五字段三态 + 可定位 evidence"。夹具形状与 `db.ts` 的 `seedScenario` 一致。
 * @param client - 一次性库的连接（已设 session 级 actor）。
 * @param input - product 入口建出的 job / job_version / rubric 版本 id。
 * @returns 新 application id。
 */
async function seedCommittedApplication(
  client: PoolClient,
  input: {
    readonly jobId: string
    readonly jobVersionId: string
    readonly rubricVersionId: string
  },
): Promise<string> {
  const suffix = uniqueSuffix()
  const candidateId = await insertId(client,
    `insert into recruitment.candidate (tenant_id, display_name, identity_status)
     values ($1, $2, 'ACTIVE') returning id`,
    [TENANT, `判断型回归候选人-${suffix}`])
  const eventId = await insertId(client,
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
     values ($1, 'internal', 'test.seed', $2, '{}'::jsonb, 'INTERNAL') returning event_id`,
    [TENANT, `judgment:${suffix}`])
  const intakeRecordId = await insertId(client,
    `insert into recruitment.intake_record (tenant_id, event_id, subject, status)
     values ($1, $2, '判断型回归收件', 'RESOLVED') returning id`,
    [TENANT, eventId])
  const sha = hex64(`judgment${suffix}`)
  const assetId = await insertId(client,
    `insert into recruitment.intake_asset
       (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref,
        validation_status, validation_error)
     values ($1, $2, 'test.pdf', 'application/pdf', 1024, $3, 'test', 'VALID', null) returning id`,
    [TENANT, intakeRecordId, sha])
  const resumeId = await insertId(client,
    `insert into recruitment.resume (tenant_id, candidate_id, intake_asset_id)
     values ($1, $2, $3) returning id`,
    [TENANT, candidateId, assetId])
  const resumeVersionId = await insertId(client,
    `insert into recruitment.resume_version
       (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
        parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
     values ($1, $2, 1, $3, $4, 'pymupdf', '1.0.0', 'PARSED', null, $5::jsonb, '[]'::jsonb) returning id`,
    [TENANT, resumeId, sha, hex64(`content${suffix}`), JSON.stringify(parsedFields({ entryCount: 2 }))])
  return insertId(client,
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
        lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'S7') returning id`,
    [TENANT, candidateId, input.jobId, input.jobVersionId, input.rubricVersionId, resumeVersionId])
}

/** 断言一个 **rubric 落库元素** 是判断型：键集 ⊆ {key,label,kind,weight,question,notes}，没有 field/operator/value。 */
function assertJudgmentShape(criterion: Record<string, unknown>, label: string): void {
  const keys = Object.keys(criterion)
  for (const required of ['key', 'label', 'kind', 'weight', 'question']) {
    assert.ok(keys.includes(required), `${label}：判断型准则必须有 ${required} 键（实际 ${keys.sort().join(',')}）`)
  }
  const allowed = new Set(['key', 'label', 'kind', 'weight', 'question', 'notes'])
  for (const key of keys) {
    assert.ok(allowed.has(key), `${label}：判断型准则不得有 ${key} 键（null 占位也不行）`)
  }
}

test('产品入口 job_create 建出含判断型准则的 rubric → screening_evaluate 能评估（不再 TypeError）', async () => {
  const db = await createIsolatedTestDatabase('judgment')
  assertPrivateDatabase(db.name)
  const isolatedCfg = { ...cfg, database: db.name }
  const client = await db.pool.connect()
  let released = false
  try {
    // session 级 actor：夹具 INSERT 的状态迁移要能确定 actor（与 withActor 的 SET LOCAL 同义）。
    await client.query('select set_config($1, $2, false)', ['recruitment.actor_id', HR_ACTOR])

    // ---- 1. 产品入口：job_create（真实 execute → normalizeCriteria → 落库） ----
    const jobCreate = createJobCreateTool(isolatedCfg)
    const created = await jobCreate.execute({
      title: '判断型准则回归岗（产品入口）',
      code: `JUDG-${uniqueSuffix()}`.slice(0, 40),
      status: 'OPEN',
      description_md: 'P0 回归：rubric 里同时有机械型与判断型准则。',
      requirements_md: '后端开发经验。',
      criteria: CRITERIA,
    }) as {
      outcome: string
      job: { id: string }
      job_version: { id: string }
      rubric: { version_id: string; criteria: readonly Record<string, unknown>[] }
    }
    assert.equal(created.outcome, 'CREATED')
    const jobId = created.job.id
    const jobVersionId = created.job_version.id
    const rubricVersionId = created.rubric.version_id

    // 输出回显的就是落库形状：机械型给 field/operator/value，判断型**没有**这三个键。
    const echoed = new Map(created.rubric.criteria.map((c) => [String(c.key), c]))
    assertJudgmentShape(echoed.get('bachelor_or_above') as Record<string, unknown>, 'job_create 回显')
    assertJudgmentShape(echoed.get('team_lead') as Record<string, unknown>, 'job_create 回显')
    assert.deepEqual(
      Object.keys(echoed.get('work_exists') as Record<string, unknown>).sort(),
      ['field', 'key', 'kind', 'label', 'operator', 'value', 'weight'],
    )

    // ---- 2. 落库形状（DB 读回；这是缺陷"数据形状不诚实"的直接反证） ----
    const rubricRow = (await client.query<{ dimensions: Record<string, unknown>[]; payload_hash: string }>(
      'select dimensions, payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
      [TENANT, rubricVersionId],
    )).rows[0]
    assert.ok(rubricRow !== undefined, 'rubric_version 必须存在')
    const byKey = new Map(rubricRow.dimensions.map((d) => [String(d.key), d]))
    assertJudgmentShape(byKey.get('bachelor_or_above') as Record<string, unknown>, 'rubric_version.dimensions')
    assertJudgmentShape(byKey.get('team_lead') as Record<string, unknown>, 'rubric_version.dimensions')
    // R-VAL-14：读侧会复算并比对；这里先明示"hash 与诚实形状一致"
    assert.equal(rubricRow.payload_hash, digestOf(rubricRow.dimensions))

    // ---- 3. 人批准（D-79 闸门：测试用 allowed-once 模拟人点 Allow） ----
    const approveTool = createJobRubricApproveTool(isolatedCfg, {
      approval: { request: async () => 'allowed-once' },
    })
    const approved = await approveTool.execute({
      job_id: jobId,
      rubric_version_id: rubricVersionId,
      reason: 'P0 回归：模拟人批准该版 rubric',
    }, {}) as { outcome: string; rubric: { is_approved: boolean; is_current: boolean } }
    assert.equal(approved.outcome, 'APPROVED')
    assert.equal(approved.rubric.is_approved, true)
    assert.equal(approved.rubric.is_current, true)

    // ---- 4. 材料夹具（直连 SQL；不是本缺陷的对象） ----
    const applicationId = await seedCommittedApplication(client, { jobId, jobVersionId, rubricVersionId })
    client.release()
    released = true

    // ---- 5. 产品入口：screening_evaluate（真实 execute，读已提交的行） ----
    const screening = createScreeningEvaluateTool(isolatedCfg)
    const value = await screening.execute({ application_id: applicationId }) as {
      status: string
      criteria_evaluated: boolean
      verdict: string
      required_human_action: string
      reasons: readonly Record<string, unknown>[]
      bonus_signals: readonly Record<string, unknown>[]
      rubric: { version_id: string }
    }
    assert.equal(value.status, 'OK')
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.rubric.version_id, rubricVersionId)

    // 判定语义：一条机械型 SATISFIED + 一条判断型 NEEDS_JUDGMENT ⇒ NEEDS_REVIEW + 要人回答问题
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.required_human_action, 'ANSWER_JUDGMENT')

    const reasonByKey = new Map(value.reasons.map((r) => [String(r.criterion_key), r]))
    const mechanical = reasonByKey.get('work_exists') as Record<string, unknown>
    assert.equal(mechanical.code, 'MUST_HAVE_SATISFIED')
    assert.equal(mechanical.failure_class, 'HARD_PASS')
    assert.equal(mechanical.outcome, 'SATISFIED')
    assert.equal(mechanical.field, 'work_experience')
    assert.equal(mechanical.tri_state, 'present')
    assert.ok(Array.isArray(mechanical.evidence) && (mechanical.evidence as unknown[]).length >= 1)

    const judgment = reasonByKey.get('bachelor_or_above') as Record<string, unknown>
    // 语义必须是"机器判不了、要人答原问句"，**不是** MISSING/UNREADABLE/兜底
    assert.equal(judgment.code, 'MUST_HAVE_NEEDS_JUDGMENT')
    assert.equal(judgment.failure_class, 'JUDGMENT')
    assert.equal(judgment.outcome, 'NEEDS_JUDGMENT')
    assert.equal(judgment.question, JUDGMENT_DECIDING.question)
    assert.deepEqual(judgment.evidence, [])
    assert.deepEqual(judgment.issue_codes, [])
    // 判断型没有机械三态/字段/期望：null 不得漏进输出（输出 schema 不收 null）
    for (const absent of ['field', 'tri_state', 'bounds', 'expected', 'notes']) {
      assert.equal(Object.hasOwn(judgment, absent), false, `判断型 reason 不得有 ${absent} 键`)
    }

    // 判断型 NICE_TO_HAVE 只进 bonus_signals（不阻塞 PASS/不制造 FAIL）
    assert.equal(value.bonus_signals.length, 1)
    const bonus = value.bonus_signals[0] as Record<string, unknown>
    assert.equal(bonus.criterion_key, 'team_lead')
    assert.equal(bonus.code, 'BONUS_NEEDS_JUDGMENT')
    assert.equal(bonus.outcome, 'NEEDS_JUDGMENT')
    assert.equal(bonus.question, JUDGMENT_BONUS.question)
    for (const absent of ['field', 'tri_state', 'expected']) {
      assert.equal(Object.hasOwn(bonus, absent), false, `判断型 bonus 不得有 ${absent} 键`)
    }
  } finally {
    if (!released) client.release()
    await db.drop()
  }
})

test('向后兼容：手工 SQL 旧形状（判断型准则没有 field 键）仍能评估', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 旧验收 rubric 就是这种形状：判断型准则**没有** field/operator/value 键（不是 null）。
    const { crunchJudgment } = judgmentWithoutFieldKeys()
    const scenario = await seedScenario(client, {
      dimensions: [MECHANICAL, crunchJudgment, { ...JUDGMENT_BONUS, notes: undefined }],
      fields: parsedFields({ entryCount: 2 }),
    })
    const value = await evaluateInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now())
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.required_human_action, 'ANSWER_JUDGMENT')
    const reason = value.reasons.find((r) => r.criterion_key === 'bachelor_or_above')
    assert.ok(reason !== undefined)
    assert.equal(reason.code, 'MUST_HAVE_NEEDS_JUDGMENT')
    assert.equal(reason.outcome, 'NEEDS_JUDGMENT')
    assert.equal(reason.question, JUDGMENT_DECIDING.question)
    assert.equal(Object.hasOwn(reason, 'field'), false)
    assert.equal(Object.hasOwn(reason, 'tri_state'), false)
  })
})

test('向后兼容：field/operator/value/question/notes 全是 null 的历史产品形状也不崩、不漏 null', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 2026-11-14 之前 job_create 产出的形状：判断型 field/operator/value=null，机械型 question/notes=null。
    const scenario = await seedScenario(client, {
      dimensions: [
        { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.4, field: 'work_experience', operator: 'EXISTS', value: true, question: null, notes: null },
        { key: 'bachelor_or_above', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.35, field: null, operator: null, value: null, question: JUDGMENT_DECIDING.question, notes: null },
        { key: 'team_lead', label: '有带团队经验', kind: 'NICE_TO_HAVE', weight: 0.25, field: null, operator: null, value: null, question: JUDGMENT_BONUS.question, notes: null },
      ],
      fields: parsedFields({ entryCount: 2 }),
    })
    const value = await evaluateInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now())
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.required_human_action, 'ANSWER_JUDGMENT')
    const reason = value.reasons.find((r) => r.criterion_key === 'bachelor_or_above')
    assert.ok(reason !== undefined)
    assert.equal(reason.code, 'MUST_HAVE_NEEDS_JUDGMENT')
    for (const absent of ['field', 'tri_state', 'bounds', 'expected', 'notes']) {
      assert.equal(Object.hasOwn(reason, absent), false, `历史 null 形状不得把 ${absent} 漏进输出`)
    }
    // 机械型的历史 question:null/notes:null 也不得漏进输出
    const mechanical = value.reasons.find((r) => r.criterion_key === 'work_exists')
    assert.ok(mechanical !== undefined)
    assert.equal(mechanical.outcome, 'SATISFIED')
    assert.equal(Object.hasOwn(mechanical, 'question'), false)
    assert.equal(Object.hasOwn(mechanical, 'notes'), false)
    // bonus 同样不得漏 field/tri_state/expected
    const bonus = value.bonus_signals[0]
    assert.ok(bonus !== undefined)
    for (const absent of ['field', 'tri_state', 'expected', 'notes']) {
      assert.equal(Object.hasOwn(bonus, absent), false, `历史 null 形状的 bonus 不得漏 ${absent}`)
    }
  })
})

/**
 * 旧形状的"判断型没有 field 键"版本（去掉 null 占位，等价于手工 SQL 插的验收 rubric）。
 * @returns 只有 question 的判断型 criterion。
 */
function judgmentWithoutFieldKeys(): { crunchJudgment: Record<string, unknown> } {
  return {
    crunchJudgment: {
      key: JUDGMENT_DECIDING.key,
      label: JUDGMENT_DECIDING.label,
      kind: JUDGMENT_DECIDING.kind,
      weight: JUDGMENT_DECIDING.weight,
      question: JUDGMENT_DECIDING.question,
    },
  }
}
