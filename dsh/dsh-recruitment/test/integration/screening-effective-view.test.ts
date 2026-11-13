// S7「同一有效证据版本」的集成矩阵（**连真库**，每个用例结束 ROLLBACK）。
//
// 对应 Issue #1 §5 的 H / I / J / K / L / M：
//   H  先 intake 无结构化，再提交合格 structured → 新版本落库；S7 只读被指向的那一版。
//   I  再提交同结构化（Lane A 侧 structure_saved=false）；S7 侧只验"读到的还是同一版、结果稳定"。
//   J  unreadable→present 升级后，S7 必须看到 present 并用对应 block_ids 的 page/bbox/证据；
//      旧 converter 的 screening/timeline **不得**反向污染结论（否则旧 timeline=0 会制造虚假 FAIL）。
//   K  无效/未被选中的结构化结果不得污染 S7：没被钉住的更新版本不参与评估；
//      即使一份缺证据的 present 混进被钉版本，也只能是"未确认"，不能变成 PASS。
//   L  真实简历（ra_s6s7 里那两版）的脱敏事实投影：只有 UNREADABLE 字段，**无法合法**走出
//      PASS/FAIL；本用例把"为什么不能"钉成可回归的断言，而不是编一个 PASS。
//      （另有一条 FIXTURE capability probe：合成 PDF 五字段 present 时能 PASS/FAIL，
//       只证明机制，不作为真实简历的 L 证据。）
//   M  verdict 必须绑定正确的 Job/Rubric 与有效 resume_version（snapshot + 每条 evidence）。
//
// 纪律：所有夹具都在事务里造、结束 ROLLBACK；不依赖真实 PDF，也不打印原文。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createScreeningEvaluateTool } from '../../src/tools/screening-evaluate.ts'
import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import {
  createTestPool, inRolledBackTx, parsedFields, seedScenario, testDatabaseConfig, TENANT,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const WORK_EXISTS = { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true }
const EDU_EXISTS = { key: 'edu_exists', label: '有教育经历', kind: 'MUST_HAVE', weight: 0.5, field: 'education', operator: 'EXISTS', value: true }
const MONTHS_GTE60 = { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 }
const MONTHS_LTE60 = { key: 'too_short', label: '不足 60 个月即排除', kind: 'DISQUALIFIER', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'LTE', value: 60 }

/** 跑一次评估。 */
async function evaluate(client: Parameters<typeof evaluateInTransaction>[0], applicationId: string) {
  return evaluateInTransaction(client, cfg, { application_id: applicationId }, Date.now())
}

/** 一条 agent 结构化证据（与 S6 `toFieldEvidence` 同形）。 */
function agentEvidence(sha: string, page: number, bbox: readonly number[], block: number, blockId: number, text: string) {
  return {
    page, bbox: [...bbox], block, block_id: blockId, text,
    source: 'agent_structured', source_asset_sha256: sha,
  }
}

/** 把 v1 的 converter 投影改成"agent 升级后"的五字段（timeline / screening 保持 v1 的旧值）。 */
function upgradedFields(sha: string): Record<string, unknown> {
  return {
    name: {
      state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read',
      block_ids: [1], evidence: [agentEvidence(sha, 1, [72, 80, 220, 100], 1, 1, '候选人姓名')],
    },
    phone: { state: 'absent', state_source: 'agent_structured', converter_state: 'absent', provenance: 'agent_read', reason: 'not_mentioned', block_ids: [], evidence: [] },
    email: { state: 'absent', state_source: 'agent_structured', converter_state: 'absent', provenance: 'agent_read', reason: 'not_mentioned', block_ids: [], evidence: [] },
    work_experience: {
      state: 'present', state_source: 'agent_structured', converter_state: 'unreadable', provenance: 'agent_read',
      block_ids: [11, 12], entry_count: 2,
      evidence: [
        agentEvidence(sha, 1, [72, 240, 523, 262], 11, 11, '2019.03 - 2022.06 某公司 后端工程师'),
        agentEvidence(sha, 1, [72, 270, 523, 292], 12, 12, '2022.07 - 至今 某公司 高级工程师'),
      ],
      agent_evidence: [
        { block_id: 11, block_no: 11, page: 1, bbox: [72, 240, 523, 262], quote: '2019.03 - 2022.06 某公司 后端工程师' },
        { block_id: 12, block_no: 12, page: 1, bbox: [72, 270, 523, 292], quote: '2022.07 - 至今 某公司 高级工程师' },
      ],
    },
    education: {
      state: 'present', state_source: 'agent_structured', converter_state: 'unreadable', provenance: 'agent_read',
      block_ids: [24, 25, 30], entry_count: 1,
      evidence: [agentEvidence(sha, 1, [72, 400, 523, 422], 24, 24, '某大学 计算机科学与技术 本科 2015.09 - 2019.06')],
      agent_evidence: [
        { block_id: 24, block_no: 24, page: 1, bbox: [72, 400, 523, 422], quote: '某大学 计算机科学与技术 本科 2015.09 - 2019.06' },
        { block_id: 30, block_no: 30, page: 1, bbox: null, quote: '2015.09 - 2019.06' },
      ],
    },
  }
}

/**
 * 在同一个 resume 下加一条新版本（version_no = max+1）。
 * @returns 新版本 id。
 */
async function addResumeVersion(
  client: Parameters<typeof evaluateInTransaction>[0],
  baseResumeVersionId: string,
  parsed: Record<string, unknown>,
  parseStatus = 'PARTIAL',
): Promise<{ id: string; sha: string }> {
  const base = (await client.query<{
    resume_id: string
    source_asset_sha256: string
    content_sha256: string
    version_no: number
  }>(`select resume_id, source_asset_sha256, content_sha256, version_no
        from recruitment.resume_version where id = $1 and tenant_id = $2`, [baseResumeVersionId, TENANT])).rows[0]
  assert.ok(base, 'base resume_version must exist')
  const next = base.version_no + 1
  const row = (await client.query<{ id: string }>(`insert into recruitment.resume_version
      (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
       parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
      values ($1, $2, $3, $4, $5, 'pymupdf', '1.0.0', $6, null, $7::jsonb, '[]'::jsonb)
      returning id`, [
    TENANT, base.resume_id, next, base.source_asset_sha256, base.content_sha256, parseStatus, JSON.stringify(parsed),
  ])).rows[0]
  assert.ok(row, 'inserted resume_version must return a row')
  return { id: row.id, sha: base.source_asset_sha256 }
}

/** 把申请显式指向某个有效版本（写侧动作；测试在 ROLLBACK 事务里做）。 */
async function pinResumeVersion(
  client: Parameters<typeof evaluateInTransaction>[0],
  applicationId: string,
  resumeVersionId: string,
): Promise<void> {
  await client.query(
    'update recruitment.application set resume_version_id = $2 where id = $1 and tenant_id = $3',
    [applicationId, resumeVersionId, TENANT],
  )
}

/** 一份 v1：converter 读不出工作与教育（与真实简历同形，但内容为合成）。 */
function unreadableConverterFields(options: { coveredMonths?: number; structured?: boolean } = {}) {
  const base = parsedFields({
    workState: 'unreadable',
    eduState: 'unreadable',
    coveredMonths: options.coveredMonths ?? 0,
    openEnded: 0,
  }) as Record<string, unknown>
  const fields = base.fields as Record<string, Record<string, unknown>>
  fields.work_experience = {
    state: 'unreadable',
    provenance: 'native_text',
    reason: 'reading_order_unverified: page(s) 1',
    evidence: [],
  }
  fields.education = {
    state: 'unreadable',
    provenance: 'native_text',
    reason: 'entries_not_segmentable',
    evidence: [],
  }
  base.screening = {
    eligible_fields: ['name', 'phone', 'email'],
    blocked_fields: [
      { field: 'work_experience', reason: 'reading_order_unverified: page(s) 1' },
      { field: 'education', reason: 'entries_not_segmentable' },
    ],
  }
  return base
}

test('M + H + I + J：S7 只读 application.resume_version_id 指向的那一版；升级后 present 进入判定并带版本号', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [
        { ...EDU_EXISTS, weight: 0.5 },
        { ...WORK_EXISTS, weight: 0.5 },
      ].map((c) => ({ ...c, label: String(c.key) })),
      fields: unreadableConverterFields({ coveredMonths: 0 }),
      parseStatus: 'PARTIAL',
    })

    // v1：字段读不出 → NEEDS_REVIEW（不是 FAIL）
    const before = await evaluate(client, scenario.applicationId)
    assert.equal(before.verdict, 'NEEDS_REVIEW')
    assert.equal(before.resume_version.id, scenario.resumeVersionId)
    assert.equal(before.snapshot.resume_version_id, scenario.resumeVersionId)

    // 造 v2：字段升级，timeline / screening 仍是 v1 的旧值（正是 Issue #1 说的污染源）
    const v1 = unreadableConverterFields({ coveredMonths: 0 })
    const v2Parsed = JSON.parse(JSON.stringify(v1)) as Record<string, unknown>
    const shaProbe = (await client.query<{ sha: string }>(
      'select source_asset_sha256 as sha from recruitment.resume_version where id = $1',
      [scenario.resumeVersionId],
    )).rows[0]?.sha
    assert.ok(shaProbe)
    v2Parsed.fields = upgradedFields(shaProbe)
    const v2 = await addResumeVersion(client, scenario.resumeVersionId, v2Parsed)

    // H：只读被钉住的那一版。未钉 v2 前，S7 不得自动挑"更新的版本"
    assert.notEqual(v2.id, scenario.resumeVersionId)
    const stillV1 = await evaluate(client, scenario.applicationId)
    assert.equal(stillV1.resume_version.id, scenario.resumeVersionId, '未钉住的新版本不得被自动选中')

    // 钉住 v2：S7 看到 present，PASS 由有效字段与证据得出
    await pinResumeVersion(client, scenario.applicationId, v2.id)
    const after = await evaluate(client, scenario.applicationId)
    assert.equal(after.verdict, 'PASS')
    assert.equal(after.criteria_evaluated, true)
    assert.equal(after.required_human_action, 'CONFIRM_DECISION')
    assert.equal(after.resume_version.id, v2.id)
    assert.equal(after.snapshot.resume_version_id, v2.id)
    assert.equal(after.snapshot.rubric_version_id, scenario.rubricId)
    assert.equal(after.rubric.version_id, scenario.rubricId)
    assert.equal(after.application.job_id, scenario.jobId)
    assert.equal(after.rubric.resolution, 'APPLICATION_PINNED')

    // 每条 verdict 的证据都必须来自这个有效版本
    for (const reason of after.reasons) {
      assert.equal(reason.outcome, 'SATISFIED')
      assert.equal(reason.tri_state, 'present')
      assert.ok(reason.evidence.length >= 1)
      for (const evidence of reason.evidence) {
        assert.equal(evidence.resume_version_id, v2.id)
        assert.equal(evidence.source_asset_sha256, shaProbe)
        assert.ok(evidence.page >= 1)
        assert.equal(evidence.bbox.length, 4)
      }
    }
    // 工作经历的两条证据必须对应字段自己的 block_ids（11、12）
    const work = after.reasons.find((r) => r.criterion_key === 'work_exists')
    assert.deepEqual(work?.evidence.map((e) => e.block).sort((a, b) => a - b), [11, 12])
    // 旧 converter 索引与升级后的字段不一致 → 有说明性 warning，但不影响 PASS
    const warning = after.warnings.find((w) => w.code === 'SCREENING_INDEX_INCONSISTENT')
    assert.ok(warning, '旧索引与升级后的字段不一致时必须留下说明')
    assert.match(warning.message, /忽略旧索引/)

    // M：headless 的 render 里必须能直接看到两个版本号
    const tool = createScreeningEvaluateTool(cfg)
    const text = tool.output.render({}, after)[0]?.text ?? ''
    assert.match(text, new RegExp(`resume_version_id=${v2.id}`))
    assert.match(text, new RegExp(`rubric_version_id=${scenario.rubricId}`))

    // 同一版重复评估：digest 稳定（I 的 S7 侧观察）
    const again = await evaluate(client, scenario.applicationId)
    assert.equal(again.evaluation_digest, after.evaluation_digest)

    // 指回 v1：S7 立刻回到 v1 的事实（不是缓存的 v2）
    await pinResumeVersion(client, scenario.applicationId, scenario.resumeVersionId)
    const back = await evaluate(client, scenario.applicationId)
    assert.equal(back.resume_version.id, scenario.resumeVersionId)
    assert.equal(back.verdict, 'NEEDS_REVIEW')
    assert.notEqual(back.evaluation_digest, after.evaluation_digest)
  })
})

test('J：字段升级后旧 converter timeline 不得制造虚假 FAIL', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [
        { ...MONTHS_GTE60, weight: 0.5 },
        { ...MONTHS_LTE60, weight: 0.5 },
      ],
      fields: unreadableConverterFields({ coveredMonths: 0 }),
      parseStatus: 'PARTIAL',
    })
    const v1 = unreadableConverterFields({ coveredMonths: 0 })
    const v2Parsed = JSON.parse(JSON.stringify(v1)) as Record<string, unknown>
    const sha = (await client.query<{ sha: string }>(
      'select source_asset_sha256 as sha from recruitment.resume_version where id = $1',
      [scenario.resumeVersionId],
    )).rows[0]?.sha
    assert.ok(sha)
    v2Parsed.fields = upgradedFields(sha)
    const v2 = await addResumeVersion(client, scenario.resumeVersionId, v2Parsed)
    await pinResumeVersion(client, scenario.applicationId, v2.id)

    const value = await evaluate(client, scenario.applicationId)
    // 旧 timeline 是 0 个月且 EXACT：修复前会 GTE→UNSATISFIED / LTE→TRIGGERED ⇒ FAIL
    assert.equal(value.verdict, 'NEEDS_REVIEW', '旧 timeline 不得把升级后的字段判成 FAIL')
    assert.equal(value.reasons.some((r) => r.failure_class === 'HARD_FAIL'), false)
    for (const reason of value.reasons) {
      assert.equal(reason.outcome, 'UNREADABLE')
      assert.equal(reason.bounds, 'UNAVAILABLE')
      assert.equal(reason.tri_state, 'present')
      assert.ok(reason.issue_codes.includes('timeline_unconfirmed:work_experience_upgraded_by_agent'))
      assert.ok(reason.issue_codes.includes('converter_timeline_ignored:covered_months_closed=0'))
      assert.match(reason.message, /未确认/)
      assert.deepEqual(reason.evidence, [])
    }
    assert.equal(value.required_human_action, 'REVIEW_UNREADABLE')
  })
})

test('K：无效/未被选中的结构化结果不得污染 S7', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, {
      dimensions: [{ ...WORK_EXISTS, weight: 1 }],
      fields: unreadableConverterFields({ coveredMonths: 0 }),
      parseStatus: 'PARTIAL',
    })
    // 一条"看起来更新、但证据不可定位"的版本：如果被误用，会凭空得到 present
    const bogus = unreadableConverterFields({ coveredMonths: 0 })
    const fields = bogus.fields as Record<string, Record<string, unknown>>
    fields.work_experience = {
      state: 'present',
      state_source: 'agent_structured',
      converter_state: 'unreadable',
      provenance: 'agent_read',
      block_ids: [24, 25, 30],
      entry_count: 1,
      evidence: [],
      evidence_unlocatable: true,
      agent_evidence: [
        { block_id: 24, block_no: 24, page: 1, bbox: null, quote: '某公司' },
        { block_id: 30, block_no: 30, page: 1, bbox: null, quote: '2020.01 - 2022.01' },
      ],
    }
    const bogusVersion = await addResumeVersion(client, scenario.resumeVersionId, bogus)

    // 没被钉住：S7 只读 v1，不看"更新的"坏版本
    const notPinned = await evaluate(client, scenario.applicationId)
    assert.equal(notPinned.resume_version.id, scenario.resumeVersionId)
    assert.equal(notPinned.verdict, 'NEEDS_REVIEW')

    // 即使它被钉住，缺 page/bbox 的证据也**不能**变成 PASS；必须说明缺了什么
    await pinResumeVersion(client, scenario.applicationId, bogusVersion.id)
    const pinned = await evaluate(client, scenario.applicationId)
    assert.equal(pinned.verdict, 'NEEDS_REVIEW')
    assert.equal(pinned.reasons[0]?.outcome, 'UNREADABLE')
    assert.equal(pinned.reasons[0]?.tri_state, 'unreadable')
    assert.ok(pinned.reasons[0]?.issue_codes.includes('evidence_unlocatable'))
    assert.ok(pinned.reasons[0]?.issue_codes.includes('evidence_missing'))
    assert.ok(pinned.reasons[0]?.issue_codes.includes('field_block_ids:24,25,30'))
    assert.match(pinned.reasons[0]?.message ?? '', /没有可定位的证据/)
    assert.equal(pinned.reasons[0]?.evidence.length, 0)
  })
})

test('能力探针（FIXTURE，不算 L）：五字段 present 的合成简历 → PASS / 实质 FAIL', async () => {
  // ⚠️ 这不是"真实简历通过 L"。本投影来自 ra_s6s7 的 **synthetic-resume-text.pdf**
  // （2026-11-13 17:10 由合成语料接入，file byte_size=2291），只用来证明"同一有效版本
  // 在字段 present 时能走出 PASS/FAIL"这条机制成立；真实简历的 L 结论见下一条。
  // **只保留非个人信息**：没有姓名/手机/邮箱值、没有证据原文。
  const synthetic = (): Record<string, unknown> => {
    const ev = (block: number) => ({ page: 1, bbox: [72, 180 + block, 420, 196 + block], block, block_id: block })
    return {
      fields: {
        name: { state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read', block_ids: [1], evidence: [ev(1)] },
        phone: { state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read', block_ids: [2], evidence: [ev(2)] },
        email: { state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read', block_ids: [3], evidence: [ev(3)] },
        work_experience: { state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read', block_ids: [4, 5], entry_count: 1, evidence: [ev(4), ev(5)] },
        education: { state: 'present', state_source: 'agent_structured', converter_state: 'present', provenance: 'agent_read', block_ids: [6, 7], entry_count: 1, evidence: [ev(6), ev(7)] },
      },
      timeline: { intervals: 1, closed_intervals: 1, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 36 },
      issues: [],
      screening: { eligible_fields: ['name', 'phone', 'email', 'work_experience', 'education'], blocked_fields: [] },
      meta: { pages: 1 },
    }
  }

  await inRolledBackTx(pool, async (client) => {
    // 与 demo 岗位已批准 rubric v2 同构：work_exists + edu_exists → PASS
    const passScenario = await seedScenario(client, {
      dimensions: [
        { ...WORK_EXISTS, weight: 0.5 },
        { ...EDU_EXISTS, weight: 0.5 },
      ],
      fields: synthetic(),
      parseStatus: 'PARSED',
    })
    const pass = await evaluate(client, passScenario.applicationId)
    assert.equal(pass.verdict, 'PASS')
    assert.equal(pass.required_human_action, 'CONFIRM_DECISION')
    assert.equal(pass.snapshot.resume_version_id, passScenario.resumeVersionId)
    assert.equal(pass.snapshot.rubric_version_id, passScenario.rubricId)
    for (const reason of pass.reasons) {
      assert.equal(reason.code, 'MUST_HAVE_SATISFIED')
      assert.equal(reason.tri_state, 'present')
      assert.equal(reason.evidence.length, 2)
      for (const evidence of reason.evidence) {
        assert.equal(evidence.resume_version_id, passScenario.resumeVersionId)
        assert.ok(evidence.page >= 1)
        assert.equal(evidence.bbox.length, 4)
      }
    }

    // 同一版本换一条可复算的标准：entry_count=1 对 GTE 2 → 实质 FAIL（不是"读不出"）
    const failScenario = await seedScenario(client, {
      dimensions: [
        { ...WORK_EXISTS, weight: 0.5 },
        { key: 'entries_gte2', label: '至少 2 段工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience.entry_count', operator: 'GTE', value: 2 },
      ],
      fields: synthetic(),
      parseStatus: 'PARSED',
    })
    const failed = await evaluate(client, failScenario.applicationId)
    assert.equal(failed.verdict, 'FAIL')
    const hardFail = failed.reasons.find((r) => r.failure_class === 'HARD_FAIL')
    assert.ok(hardFail, 'FAIL 必须有一条基于可靠事实的 HARD_FAIL')
    assert.equal(hardFail.code, 'MUST_HAVE_UNSATISFIED')
    assert.equal(hardFail.tri_state, 'present')
    assert.equal(hardFail.observed?.value, 1)
    assert.equal(hardFail.evidence.length, 2)
    assert.match(hardFail.message, /entry_count=1/)
  })
})

test('L：真实简历（两版均 work/education unreadable）→ 精确理由说明为什么不能产生 PASS/FAIL', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 以下 state / issue code / timeline / screening 逐项来自 ra_s6s7 的真实两版
    // （276908da… / 31ced60b…，均为真实 PDF：platform_noise.pdf / resume.pdf）。
    // **只保留非个人信息**：没有姓名/手机/邮箱值，没有 quote，没有 issue message。
    const realProjection: Record<string, unknown> = {
      fields: {
        name: { state: 'present', provenance: 'native_text', evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 1, text: '（已脱敏）' }] },
        phone: { state: 'present', provenance: 'native_text', evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 2, text: '（已脱敏）' }] },
        email: { state: 'present', provenance: 'native_text', evidence: [{ page: 1, bbox: [1, 2, 3, 4], block: 3, text: '（已脱敏）' }] },
        work_experience: { state: 'unreadable', provenance: 'native_text', reason: 'reading_order_unverified: page(s) 1', evidence: [] },
        education: { state: 'unreadable', provenance: 'native_text', reason: 'entries_not_segmentable', evidence: [] },
      },
      timeline: {
        intervals: 0, closed_intervals: 0, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0,
      },
      issues: [
        { code: 'unverified_pdf_image' },
        { code: 'platform_noise_excluded' },
        { code: 'resume_attribution_unverified' },
        { code: 'resume_timeline_unparsed' },
      ],
      screening: {
        eligible_fields: ['name', 'phone', 'email'],
        blocked_fields: [
          { field: 'work_experience', reason: 'reading_order_unverified: page(s) 1' },
          { field: 'education', reason: 'entries_not_segmentable' },
        ],
      },
      meta: { pages: 1 },
    }

    const scenario = await seedScenario(client, {
      dimensions: [
        { ...WORK_EXISTS, weight: 0.5 },
        { ...EDU_EXISTS, weight: 0.25 },
        { ...MONTHS_GTE60, weight: 0.25 },
      ],
      fields: realProjection,
      parseStatus: 'PARTIAL',
    })
    const value = await evaluate(client, scenario.applicationId)

    // 这两版里**所有可机械判定的字段**都是 unreadable：只能 NEEDS_REVIEW。
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.criteria_evaluated, true)
    assert.equal(value.reasons.length, 3)
    assert.equal(value.reasons.some((r) => r.failure_class === 'HARD_FAIL'), false)
    assert.equal(value.reasons.some((r) => r.failure_class === 'HARD_PASS'), false)
    for (const reason of value.reasons) {
      assert.ok(['UNREADABLE', 'MISSING', 'INDETERMINATE'].includes(reason.outcome ?? ''))
      assert.notEqual(reason.outcome, 'SATISFIED')
      assert.notEqual(reason.outcome, 'UNSATISFIED')
      assert.equal(reason.evidence.length, 0)
    }
    // 精确理由：工作/教育字段 unreadable，timeline 又不独立于 work_experience 成立。
    const work = value.reasons.find((r) => r.criterion_key === 'work_exists')
    assert.equal(work?.tri_state, 'unreadable')
    assert.ok(work?.issue_codes.includes('reading_order_unverified: page(s) 1'))
    const edu = value.reasons.find((r) => r.criterion_key === 'edu_exists')
    assert.equal(edu?.tri_state, 'unreadable')
    assert.ok(edu?.issue_codes.includes('entries_not_segmentable'))
    const months = value.reasons.find((r) => r.criterion_key === 'months')
    assert.equal(months?.outcome, 'UNREADABLE')
    assert.equal(months?.bounds, 'UNAVAILABLE')
    assert.ok(months?.issue_codes.includes('timeline_unavailable:work_experience_unreadable'))
    // 身份字段 present 也没用：rubric 白名单（R-VAL-8）禁止把 name/phone/email 当判定字段。
    assert.equal(value.required_human_action, 'REVIEW_UNREADABLE')
  })
})
