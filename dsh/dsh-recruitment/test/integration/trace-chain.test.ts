// 执行追溯链的**真库**集成测试（连 ra_s6s7，每个用例结束一律 ROLLBACK）。
//
// 这份文件证明四件事（对应任务书验收）：
//   1. **真链路**：intake → screening → decision 三段都走产品的真实事务函数
//      （`intakeInTransaction` / `evaluateInTransaction` / `recordDecisionInTransaction`，
//      即三个工具 `execute()` 内部调用的同一批代码），然后**从 application id 追溯**
//      出这条链：每一环都有行、都挂在同一个 correlation_id 上（迁移 0013 的传播触发器 + 
//      本 lane 的 tool_call 记录适配器）。
//   2. **断链检出**：故意用裸 SQL 插一条"无关联 decision"（绕过工具、correlation 指向另
//      一条链），追溯必须报 `LINKED_ROW_OFF_CHAIN` 并指出断在哪一环；另插一条共享
//      correlation 但没有来源事件/工具调用的 decision，必须报
//      `DECISION_WITHOUT_CAUSE_EVENT` + `DECISION_WITHOUT_TOOL_CALL`。
//   3. **R7**：追溯输出里不得出现候选人姓名 / 简历文件名 / 决策理由原文 / event payload。
//   4. **八环可串**：business_task → task_attempt → agent_session → durable_effect →
//      receipt 这几环目前**没有产品写入方**，所以用事务内夹具证明"一旦有行，同一个
//      correlation 能把它们串起来、能查到、缺回执能报断"。夹具与真链路分开记账
//      （不把夹具当真实业务链）。
//
// 为什么不用 `tool.execute()`：它自建连接池并提交，看不到本事务里未提交的夹具
// （`test/integration/evaluation-decision-record.test.ts` 文件头已记录同一取舍）。
// 真实 `tool.execute()` 的**提交式**运行证据不在本仓（临时目录 evidence.json + 总控回报），
// 这里只保证"可回滚、可重复、进 CI"的那部分：三段都是工具 execute() 内部调用的同一批函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { observeIdentity, type StrongId } from '../../src/db/identity.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  intakeInTransaction,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import {
  confirmationTextSha256,
  recordDecisionInTransaction,
  type ApprovalOutcome,
} from '../../src/tools/decision-record.ts'
import {
  loadTrace,
  recordToolCall,
  resolveCorrelationForRefs,
  type BusinessRef,
} from '../../src/domain/trace.ts'
import {
  DEMO_JOB,
  HR_ACTOR,
  TENANT,
  createTestPool,
  hex64,
  inRolledBackTx,
  one,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg: ResolvedDatabaseConfig = testDatabaseConfig()
const pool = createTestPool(cfg)
test.after(async () => { await pool.end() })

const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.4, question: '做过什么？' },
  { key: 'edu_exists', label: '有教育背景', kind: 'MUST_HAVE', weight: 0.3, question: '学历？' },
  { key: 'team_lead', label: '带过团队', kind: 'NICE_TO_HAVE', weight: 0.3, question: '带过几个人？' },
]

/**
 * 真链路 `/ 断链检出` 用例用的 rubric：**必须能被 S7 机械判定**（判据全在字段上），
 * 这样同一条链上的 screening 结论与 decision 是真实产物，不是靠"人工问题"兜着。
 * 形状/权重与 `screening-evaluate.ts` 的 R-VAL-1..13 对齐（Σweight=1、有 deciding 准则）。
 */
const CHAIN_DIMENSIONS = [
  {
    key: 'work_exists',
    label: '有工作经历',
    kind: 'MUST_HAVE',
    weight: 1,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
  },
]

/**
 * 给演示岗位造一个**已批准**的 rubric 版本，并把 `job.current_rubric_version_id` 指过去。
 *
 * **为什么必须自己造（干净库上实测，2026-11-14）**：
 *   * `0002_seed.sql` 只种 rubric v1（`…0403`），`db/migrations/*.sql` 里**一条
 *     `insert into recruitment.approval` 都没有** —— 干净库上没有任何"已批准"版本；
 *   * 旧常量 `DEMO_RUBRIC=…0404` 是本机 `ra_s6s7` 的历史手工数据，干净库/CI 里它
 *     根本不存在 → 5 条用例全部死在迁移 0005 的 `fk_application_rubric_job`
 *     （"申请钉的 rubric 必须属于同一个 job"，见 `0005_version_binding.sql:227-251`）。
 * 语义与生产写路径一致：`job_rubric_approve` 的库级效果 = APPROVED 审批 + 指针前移；
 * 之后 intake 的 F1 写侧会把它钉到新申请上（`application-intake.ts:1351-1375`）。
 * @param client - 事务内客户端（结束回滚，不污染共享库）。
 * @returns 这个已批准版本的 id（= 申请应当钉住的版本）。
 */
async function seedApprovedRubric(client: DatabaseClient): Promise<string> {
  const payloadHash = digestOf(CHAIN_DIMENSIONS)
  // `created_at` 必须显式写成过去：`approvedAt()` 的第一条判据是
  // `rubric_version.created_at <= as_of`（`screening-evaluate.ts:1879` 附近的 approvedAt），
  // 而本用例的 as_of = now - 5min。默认 `now()` 会让一个"刚造出来"的版本在 as_of 时刻
  // 还不存在 → 正确地报 NO_APPROVED_RUBRIC。真实库里版本总是先存在、后有 as_of。
  // 注意 `rubric_version` 的 `trg_rubric_version_immutable` 只挂 BEFORE UPDATE，
  // 所以 INSERT 时给 created_at 合法；事后 UPDATE 会被 IMMUTABLE_COLUMN 拒绝。
  const rubricId = await one(
    client,
    `insert into recruitment.rubric_version
       (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id, created_at)
     values ($1, $2, 2, $3::jsonb, $4, $5, now() - interval '1 hour') returning id`,
    [TENANT, DEMO_JOB, JSON.stringify(CHAIN_DIMENSIONS), payloadHash, HR_ACTOR],
  )
  await client.query(
    `insert into recruitment.approval
       (tenant_id, resource_type, resource_id, resource_record_version, payload_schema_version,
        canonical_payload_hash, status, requested_by_actor_id, decision_by_actor_id, decided_at, reason)
     values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'APPROVED', $4, $4, now() - interval '30 minutes',
             '追溯链集成测试批准')`,
    [TENANT, rubricId, payloadHash, HR_ACTOR],
  )
  await client.query(
    'update recruitment.job set current_rubric_version_id = $2 where tenant_id = $1 and id = $3',
    [TENANT, rubricId, DEMO_JOB],
  )
  return rubricId
}

/** 带 +08:00 偏移的 ISO（工具只接受带偏移的时间）。 */
function toOffsetIso(date: Date, offsetMinutes = 480): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())}`
    + `T${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}:${p(shifted.getUTCSeconds())}+08:00`
}

/** 合成材料（不读 PDF；身份结论只看 fields 的三态与来源）。 */
function makeMaterial(options: { phone: string; email: string; fileSha: string }): IntakeMaterial {
  const evidence = [{ page: 1, bbox: [72, 100, 500, 120], block: 1, text: '联系方式' }]
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '追溯链合成候选人', provenance: 'native_text', evidence },
    phone: { state: 'present', value: options.phone, provenance: 'native_text', evidence },
    email: { state: 'present', value: options.email, provenance: 'native_text', evidence },
    work_experience: { state: 'present', provenance: 'native_text', evidence },
    education: { state: 'present', provenance: 'native_text', evidence },
  }
  const eligible = ['phone', 'email']
  const observation = observeIdentity(fields as never, eligible)
  const output = {
    text: '合成材料正文（R7：不得进入追溯输出）',
    chars: 20,
    completeness: 'complete',
    issues: [],
    fields,
    timeline: { covered_months_closed: 74, open_ended_intervals: 0, year_only_intervals: 0 },
    screening: { eligible_fields: eligible, identity_merge_eligible: eligible },
    meta: { pages: 1, source_sha256: options.fileSha, backend: 'pymupdf/synthetic', reader_version: '1.0.0' },
  }
  return {
    real_path: 'C:/synthetic/trace-chain.pdf',
    file_name: 'trace-chain-candidate.pdf',
    byte_size: 2048,
    output: output as IntakeMaterial['output'],
    strong: observation.strong as StrongId[],
    blocked: observation.blocked,
    sha256: options.fileSha,
  }
}

/** 读某条申请的 correlation（迁移 0013 的触发器在 intake 事务里已写好）。 */
async function correlationOfApplication(client: DatabaseClient, applicationId: string): Promise<string> {
  const { rows } = await client.query<{ correlation_id: string | null }>(
    'select correlation_id from recruitment.application where id = $1 and tenant_id = $2',
    [applicationId, TENANT],
  )
  const value = rows[0]?.correlation_id
  assert.ok(typeof value === 'string' && value.length === 36, '申请必须有 correlation_id（0013 触发器）')
  return value
}

/** 用"产品里那次真实调用"的返回值记录一行 tool_call（记录适配器的事务内版本）。 */
async function recordRealCall(
  client: DatabaseClient,
  toolName: string,
  callRef: string,
  refs: readonly BusinessRef[],
): Promise<string> {
  const correlation = await resolveCorrelationForRefs(client, TENANT, refs)
  assert.ok(correlation !== null, `${toolName}: 业务引用必须能反查到 correlation`)
  return recordToolCall(client, {
    tenantId: TENANT,
    callRef,
    toolName,
    correlationId: correlation,
    businessRefs: refs,
    outcome: 'SUCCEEDED',
    actorId: HR_ACTOR,
    startedAt: new Date(Date.now() - 1_000),
    endedAt: new Date(),
    durationMs: 1_000,
    argsDigest: hex64(callRef),
  })
}

/** 在事务里跑完整的三步真链路：intake → screening → decision。 */
async function runRealChain(client: DatabaseClient, input: {
  readonly phone: string
  readonly email: string
  readonly suffix: string
}): Promise<{
  readonly applicationId: string
  readonly resumeVersionId: string
  readonly decisionId: string
  readonly intakeEventId: string | undefined
  readonly correlation: string
  /** 本次决策的理由原文（R7 断言用：追溯输出里必须没有它）。 */
  readonly reasonText: string
}> {
  // 目标岗位 = 0002_seed 的演示岗位（OPEN）；本用例自己给它造一个**已批准**的
  // current rubric（干净库上没有审批行，见 `seedApprovedRubric` 的注释）。
  // 申请 / 候选人 / 材料由下面的**真实 intake** 产生；rubric 版本由 intake 按 F1 自动钉住。

  // ---- 第 0 步：造"同 job 的已批准 rubric"这个前置事实 ----
  const rubricVersionId = await seedApprovedRubric(client)

  // ---- 第 1 步：真实 intake ----
  const material = makeMaterial({
    phone: input.phone,
    email: input.email,
    fileSha: hex64(`trace-chain:${input.suffix}`),
  })
  const intake = await intakeInTransaction(client, cfg, material, DEMO_JOB) as Record<string, unknown>
  const applicationId = String(intake.application_id)
  const resumeVersionId = String(intake.resume_version_id)
  // F1 写侧（D-108）：指针非空且此刻已批准 ⇒ 新建申请必须钉住它。这里读回来断言，
  // 而不是"手工 update 成我们想要的版本"——否则测试自己制造了要验的事实。
  const pinned = (await client.query<{ rubric_version_id: string | null }>(
    'select rubric_version_id from recruitment.application where id = $1 and tenant_id = $2',
    [applicationId, TENANT],
  )).rows[0]?.rubric_version_id
  assert.equal(pinned, rubricVersionId, 'intake 必须钉住 job.current_rubric_version_id（F1 写侧 / D-108）')
  await recordRealCall(client, 'recruitment_application_intake', `trace-test:intake:${input.suffix}`, [
    { kind: 'APPLICATION', id: applicationId },
  ])

  // ---- 第 2 步：真实 screening（只读，但作为一次工具调用留痕）----
  const nowMs = Date.now()
  const asOf = toOffsetIso(new Date(nowMs - 5 * 60_000))
  const screening = await evaluateInTransaction(
    client, cfg, { application_id: applicationId, as_of: asOf }, nowMs,
  ) as Record<string, unknown>
  await recordRealCall(client, 'recruitment_screening_evaluate', `trace-test:screening:${input.suffix}`, [
    { kind: 'APPLICATION', id: applicationId },
  ])

  // ---- 第 3 步：真实 decision（人已做决定，工具只校验并记录）----
  const snapshot = screening.snapshot as Record<string, unknown>
  const rubric = screening.rubric as Record<string, unknown>
  const result = screening.verdict === 'PASS' ? 'ADVANCE' : 'HOLD'
  const reason = '追溯链验收：按初筛建议记录人工决策（合成材料）。'
  const basisRefs = [
    {
      kind: 'RUBRIC_VERSION',
      id: String(snapshot.rubric_version_id),
      payload_hash: String(snapshot.rubric_payload_hash),
      version_no: Number(rubric.version_no),
    },
    { kind: 'AUTHORITY', actor_id: HR_ACTOR, is_hiring_manager: false },
    {
      kind: 'SCREENING_EVALUATION',
      evaluation_digest: String(screening.evaluation_digest),
      verdict: String(screening.verdict),
      rubric_version_id: String(snapshot.rubric_version_id),
      rubric_payload_hash: String(snapshot.rubric_payload_hash),
      resume_version_id: String(snapshot.resume_version_id),
      resume_content_sha256: String(snapshot.resume_content_sha256),
      criteria_evaluated: screening.criteria_evaluated === true,
    },
    {
      kind: 'RESUME_VERSION',
      id: String(snapshot.resume_version_id),
      content_sha256: String(snapshot.resume_content_sha256),
    },
  ]
  const confirmedAt = toOffsetIso(new Date(nowMs - 60_000))
  const confirmationText = '我确认：这条申请的初筛结论按评价建议记录。'
  const decisionArgs = {
    application_id: applicationId,
    decision_scope: 'SCREENING',
    as_of: asOf,
    result,
    reason,
    basis_refs: basisRefs,
    human_confirmation: {
      confirmed_by_actor_id: HR_ACTOR,
      confirmed_at: confirmedAt,
      confirmation_method: 'IN_CHAT',
      confirmation_text: confirmationText,
      confirmation_text_sha256: confirmationTextSha256({
        result,
        reason,
        override_rationale: null,
        basis_refs: basisRefs,
        confirmation_text: confirmationText,
        confirmed_by_actor_id: HR_ACTOR,
        confirmed_at: confirmedAt,
      }),
    },
  }
  const allowed: ApprovalOutcome = 'allowed-once'
  const decision = await recordDecisionInTransaction(
    client, cfg, decisionArgs, nowMs, async (): Promise<ApprovalOutcome> => allowed,
  ) as Record<string, unknown>
  const decisionRow = decision.decision as Record<string, unknown>
  await recordRealCall(client, 'recruitment_decision_record', `trace-test:decision:${input.suffix}`, [
    { kind: 'APPLICATION', id: applicationId },
    { kind: 'DECISION', id: String(decisionRow.id) },
  ])

  // 三行 tool_call 与业务链同一个 correlation（不是"看起来通"，是读回来的）。
  const correlation = await correlationOfApplication(client, applicationId)
  const toolCorrelations = await client.query<{ correlation_id: string }>(
    `select correlation_id from recruitment.tool_call
      where tenant_id = $1 and call_ref like $2 order by started_at`,
    [TENANT, `trace-test:%:${input.suffix}`],
  )
  assert.equal(toolCorrelations.rows.length, 3)
  for (const row of toolCorrelations.rows) assert.equal(row.correlation_id, correlation)

  return {
    applicationId,
    resumeVersionId,
    decisionId: String(decisionRow.id),
    intakeEventId: typeof intake.event_id === 'string' ? intake.event_id : undefined,
    correlation,
    reasonText: reason,
  }
}

// =====================================================================
//  1. 真链路：从 application id 追溯出 intake/screening/decision
// =====================================================================
test('真链路 intake→screening→decision：从 application id 追溯出同一 correlation 的完整链', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const chain = await runRealChain(client, {
      phone: `139${suffix.padEnd(8, '0').slice(0, 8)}`,
      email: `trace-${suffix}@example.test`,
      suffix,
    })
    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: chain.applicationId })

    // ① 一个 ID 串起来
    assert.equal(trace.correlation_id, chain.correlation)
    assert.equal(trace.legacy_without_correlation, false)

    // ② 每一环都有行、都在链上、都带业务关联字段
    const intakeEvent = trace.rings.find((ring) => ring.ring === 'EVENT' && ring.id === chain.intakeEventId)
    assert.ok(intakeEvent !== undefined, 'intake 事件必须在链上')
    assert.equal(intakeEvent.on_chain, true)
    assert.equal(intakeEvent.state, 'resume.intake.received')
    const decisionEvent = trace.rings.find((ring) => ring.ring === 'EVENT' && ring.state === 'decision.record')
    assert.ok(decisionEvent !== undefined, 'decision.record 事件必须在链上')
    const calls = trace.rings.filter((ring) => ring.ring === 'TOOL_CALL')
    assert.deepEqual(
      calls.map((ring) => ring.refs?.tool_name).sort(),
      ['recruitment_application_intake', 'recruitment_decision_record', 'recruitment_screening_evaluate'],
    )
    const decisionRing = trace.rings.find((ring) => ring.ring === 'DECISION')
    assert.ok(decisionRing !== undefined, '人工决策必须在链上')
    assert.equal(decisionRing.id, chain.decisionId)
    assert.equal(decisionRing.on_chain, true)
    assert.equal(decisionRing.actor_id, HR_ACTOR)
    assert.equal(trace.counts.DECISION, 1)
    assert.equal(trace.counts.TOOL_CALL, 3)
    assert.equal(trace.counts.EVENT, 2, '链上应有 intake 与 decision 两个内部事件')

    // ③ 决策的 causation 指向它自己的事件（EVENT→DECISION 有边）
    const causation = decisionRing.refs?.causation_event_id
    assert.equal(typeof causation, 'string')
    assert.ok(trace.rings.some((ring) => ring.ring === 'EVENT' && ring.id === causation))

    // ④ 完整性：真链没有断链；只有"该路径没有产生"的环是 gap
    assert.deepEqual(trace.integrity.breakpoints, [], '真链路不应有断链')
    assert.equal(trace.integrity.ok, true)
    const gapRings = trace.integrity.gaps.map((gap) => gap.ring).sort()
    assert.deepEqual(gapRings, ['AGENT_SESSION', 'BUSINESS_TASK', 'DURABLE_EFFECT', 'RECEIPT', 'TASK_ATTEMPT'])

    // ⑤ 时间线有序（按 at 升序）
    const times = trace.rings.map((ring) => ring.at ?? '').filter((at) => at !== '')
    const sorted = [...times].sort()
    assert.deepEqual(times, sorted)

    // ⑥ R7：追溯结果里没有候选人正文 / 简历文件名 / 决策理由原文 / payload
    const serialized = JSON.stringify(trace)
    for (const forbidden of [
      '追溯链合成候选人',
      'trace-chain-candidate.pdf',
      chain.reasonText,
      '合成材料正文',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `追溯输出不得含正文：${forbidden}`)
    }
    assert.equal(serialized.includes('"payload"'), false, '追溯输出不得含 event payload')
    assert.equal(serialized.includes('"reason"'), false, '追溯输出不得含 decision.reason')
    assert.equal(trace.redaction.candidate_text_included, false)
    assert.equal(trace.redaction.payload_included, false)
  })
})

// =====================================================================
//  2. 断链检出 A：裸 SQL 插一条"无关联 decision"（correlation 指向别的链）
// =====================================================================
test('断链检出：绕过工具的 decision（不同 correlation）必须报 LINKED_ROW_OFF_CHAIN', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const chain = await runRealChain(client, {
      phone: `138${suffix.padEnd(8, '0').slice(0, 8)}`,
      email: `trace-${suffix}@example.test`,
      suffix,
    })
    const orphanId = randomUUID()
    const otherCorrelation = randomUUID()
    // 故意绕过工具：直接写 decision 表，correlation 指向另一条链（没有任何事件/工具调用）。
    await client.query(
      `insert into recruitment.decision
         (id, tenant_id, application_id, decision_scope, stage_code, result,
          decided_by_actor_id, reason, basis_refs, correlation_id)
       values ($1, $2, $3, 'STAGE', 'S8', 'HOLD', $4, '裸 SQL 插入的孤立决策（断链夹具）', '[]'::jsonb, $5)`,
      [orphanId, TENANT, chain.applicationId, HR_ACTOR, otherCorrelation],
    )

    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: chain.applicationId })
    assert.equal(trace.integrity.ok, false)
    const offChain = trace.integrity.breakpoints.find((point) => point.code === 'LINKED_ROW_OFF_CHAIN')
    assert.ok(offChain !== undefined, `应检出挂在本申请上却不在链上的行，实际：${JSON.stringify(trace.integrity.breakpoints)}`)
    assert.equal(offChain.at, 'DECISION→CHAIN', '断点必须报在哪一环')
    assert.equal(offChain.ring_id, orphanId)
    assert.equal(offChain.expected, chain.correlation)
    assert.equal(offChain.actual, otherCorrelation)
    // 孤立的 decision 也会出现在时间线上，但标成 OFF-CHAIN（不是被悄悄丢掉）
    const offChainRing = trace.rings.find((ring) => ring.id === orphanId)
    assert.ok(offChainRing !== undefined)
    assert.equal(offChainRing.on_chain, false)
  })
})

// =====================================================================
//  3. 断链检出 B：decision 在同一条链上，但没有来源事件 / 没有工具调用
// =====================================================================
test('断链检出：同链 decision 缺来源事件与工具调用 → DECISION_WITHOUT_CAUSE_EVENT / _TOOL_CALL', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const chain = await runRealChain(client, {
      phone: `137${suffix.padEnd(8, '0').slice(0, 8)}`,
      email: `trace-${suffix}@example.test`,
      suffix,
    })
    const orphanId = randomUUID()
    // 用同一 correlation 直接插一条 FINAL 决策：链成立，但上游事件/工具调用都不存在。
    await client.query(
      `insert into recruitment.decision
         (id, tenant_id, application_id, decision_scope, stage_code, result,
          decided_by_actor_id, reason, basis_refs, correlation_id)
       values ($1, $2, $3, 'FINAL', 'S10', 'HIRED', $4, '裸 SQL 插入的同链决策（缺上游夹具）', '[]'::jsonb, $5)`,
      [orphanId, TENANT, chain.applicationId, HR_ACTOR, chain.correlation],
    )
    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: chain.applicationId })
    assert.equal(trace.integrity.ok, false)
    const codes = trace.integrity.breakpoints.map((point) => point.code).sort()
    assert.ok(codes.includes('DECISION_WITHOUT_CAUSE_EVENT'), `实际断点：${JSON.stringify(codes)}`)
    assert.ok(codes.includes('DECISION_WITHOUT_TOOL_CALL'), `实际断点：${JSON.stringify(codes)}`)
    const cause = trace.integrity.breakpoints.find((point) => point.code === 'DECISION_WITHOUT_CAUSE_EVENT')
    assert.equal(cause?.at, 'EVENT→DECISION')
    assert.equal(cause?.ring_id, orphanId)
  })
})

// =====================================================================
//  4. 八环可串（**夹具**，不是真实业务链）：task→attempt→session→effect→receipt
// =====================================================================
test('八环可串（夹具）：同一 correlation 下 task/attempt/session/effect/receipt 全部可追溯', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const chain = await runRealChain(client, {
      phone: `136${suffix.padEnd(8, '0').slice(0, 8)}`,
      email: `trace-${suffix}@example.test`,
      suffix,
    })
    // 夹具：这几环目前没有产品写入方（回报里的未决问题），这里用事务内 INSERT 证明
    // "一旦有行，迁移 0013 的传播触发器会把同一个 correlation 继承下去"。
    const taskId = (await client.query<{ id: string }>(
      `insert into recruitment.business_task
         (tenant_id, task_type, business_refs, title, idempotency_key, trigger_event_id)
       values ($1, 'TRACE_CHAIN_TEST', $2::jsonb, '追溯链夹具任务', $3, $4)
       returning id`,
      [TENANT, JSON.stringify([{ kind: 'APPLICATION', id: chain.applicationId }]), `trace-test:${suffix}`, chain.intakeEventId ?? null],
    )).rows[0]?.id
    assert.ok(typeof taskId === 'string')
    const attemptId = (await client.query<{ id: string }>(
      `insert into recruitment.task_attempt
         (tenant_id, task_id, attempt_no, worker_type, worker_id, status, lease_expires_at)
       values ($1, $2, 1, 'trace-test', 'worker-1', 'CLAIMED', now() + interval '5 minutes')
       returning id`,
      [TENANT, taskId],
    )).rows[0]?.id
    assert.ok(typeof attemptId === 'string')
    const sessionId = (await client.query<{ id: string }>(
      `insert into recruitment.agent_session
         (tenant_id, task_id, attempt_id, runtime_version, model_route)
       values ($1, $2, $3, 'trace-test/1.0.0', 'synthetic/route')
       returning id`,
      [TENANT, taskId, attemptId],
    )).rows[0]?.id
    assert.ok(typeof sessionId === 'string')
    const effectId = (await client.query<{ id: string }>(
      `insert into recruitment.durable_effect
         (tenant_id, effect_type, business_refs, idempotency_key, status,
          sent_at, confirmed_at, receipt_ref, external_id, readback_state, causation_event_id)
       values ($1, 'NOTIFY_INTERNAL', $2::jsonb, $3, 'CONFIRMED',
               now(), now(), 'receipt-synthetic-1', 'ext-synthetic-1', 'MATCH', $4)
       returning id`,
      [TENANT, JSON.stringify([{ kind: 'APPLICATION', id: chain.applicationId }]), `trace-test:effect:${suffix}`, chain.intakeEventId ?? null],
    )).rows[0]?.id
    assert.ok(typeof effectId === 'string')

    // 触发器的继承结果必须真的是同一个 correlation（读回来断言，不靠推断）。
    for (const [table, id] of [
      ['business_task', taskId], ['task_attempt', attemptId], ['agent_session', sessionId], ['durable_effect', effectId],
    ] as const) {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        `select correlation_id from recruitment.${table} where id = $1 and tenant_id = $2`,
        [id, TENANT],
      )
      assert.equal(rows[0]?.correlation_id, chain.correlation, `${table} 必须继承同一条 correlation`)
    }

    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: chain.applicationId })
    for (const ring of ['APPLICATION', 'EVENT', 'BUSINESS_TASK', 'TASK_ATTEMPT', 'AGENT_SESSION',
      'TOOL_CALL', 'DURABLE_EFFECT', 'RECEIPT', 'DECISION'] as const) {
      assert.ok(trace.counts[ring] >= 1, `${ring} 必须至少有一行（八环可串的证明）`)
    }
    const receipt = trace.rings.find((ring) => ring.ring === 'RECEIPT')
    assert.equal(receipt?.id, 'receipt-synthetic-1')
    assert.equal(receipt?.refs?.effect_id, effectId)
    // 这段夹具下的链路是完整的：没有断链
    assert.deepEqual(trace.integrity.breakpoints, [])
    assert.equal(trace.integrity.ok, true)
    // 夹具不冒充真实路径：provenance 一样要能在输出里看见——本测试用 SQL 直接造行，
    // 真实链路的认证在 evidence/trace-chain-acceptance-2026-11-14.md 里单列。
  })
})

test('八环可串（夹具）：CONFIRMED effect 缺 receipt 必须报 EFFECT_WITHOUT_RECEIPT', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const chain = await runRealChain(client, {
      phone: `135${suffix.padEnd(8, '0').slice(0, 8)}`,
      email: `trace-${suffix}@example.test`,
      suffix,
    })
    const effectId = (await client.query<{ id: string }>(
      `insert into recruitment.durable_effect
         (tenant_id, effect_type, business_refs, idempotency_key, status, sent_at, confirmed_at, causation_event_id)
       values ($1, 'NOTIFY_INTERNAL', $2::jsonb, $3, 'CONFIRMED', now(), now(), $4)
       returning id`,
      [TENANT, JSON.stringify([{ kind: 'APPLICATION', id: chain.applicationId }]), `trace-test:effect-noreceipt:${suffix}`, chain.intakeEventId ?? null],
    )).rows[0]?.id
    assert.ok(typeof effectId === 'string')
    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: chain.applicationId })
    assert.equal(trace.integrity.ok, false)
    const point = trace.integrity.breakpoints.find((item) => item.code === 'EFFECT_WITHOUT_RECEIPT')
    assert.ok(point !== undefined, `实际断点：${JSON.stringify(trace.integrity.breakpoints.map((item) => item.code))}`)
    assert.equal(point.at, 'EFFECT→RECEIPT')
    assert.equal(point.ring_id, effectId)
  })
})

// =====================================================================
//  5. 旧数据不伪造：correlation 为 NULL 的历史申请如实报 CHAIN_CORRELATION_MISSING
// =====================================================================
test('历史行（correlation NULL）不伪造链：报 CHAIN_CORRELATION_MISSING 并标 legacy', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMENSIONS.map((dimension) => ({ ...dimension })) })
    // 模拟"迁移前写入的申请"：显式把 correlation 清空（真实历史行的状态）。
    await client.query(
      'update recruitment.application set correlation_id = null where id = $1 and tenant_id = $2',
      [scenario.applicationId, TENANT],
    )
    const trace = await loadTrace(client, { tenantId: TENANT, objectType: 'APPLICATION', objectId: scenario.applicationId })
    assert.equal(trace.legacy_without_correlation, true)
    assert.equal(trace.correlation_id, undefined)
    assert.equal(trace.integrity.ok, false)
    assert.ok(trace.integrity.breakpoints.some((point) => point.code === 'CHAIN_CORRELATION_MISSING'))
  })
})
