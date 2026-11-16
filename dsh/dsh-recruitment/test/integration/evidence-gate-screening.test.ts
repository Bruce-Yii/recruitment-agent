// D-110 证据闸门（S7）集成测试：无坐标格式（RTF / 纯文本 / DOCX 段落）的证据必须可按
// 「源 sha256 一致 + 定位唯一 + quote 逐字命中」自动通过；有坐标格式（PDF page+bbox）保持现状。
//
// 为什么需要这组用例（真实缺陷，2026-11-16 现场事实）：
//   合成 RTF 材料 `demo-candidate-0701.rtf` 被 converter 读成 PARSED、五个字段都有原文，
//   但 `parsed_fields.fields.*.evidence[].bbox = null`（RTF 没有 bbox，只有 block/paragraph），
//   旧的 `evidenceFor()` 只认 `page>=1 && bbox 四元数` → 把证据整条丢掉 → present 字段降成
//   unreadable → `MUST_HAVE_UNREADABLE` + `REVIEW_UNREADABLE`。这违反 D-110（2026-11-15 裁决）：
//   证据闸门管"可复核"，不管"有没有坐标"。
//
// 纪律：所有夹具都在事务里造、结束 ROLLBACK；用 `seedScenario` 造基础行，再插一条
// parser_name=striprtf / python-docx 的 resume_version 并把申请指过去（不碰真实语料）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import {
  createTestPool, errorBody, hex64, inRolledBackTx, parsedFields, seedScenario, testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const WORK_EXISTS = {
  key: 'work_exists', label: '简历中存在可分割的工作经历条目', kind: 'MUST_HAVE', weight: 0.5,
  field: 'work_experience', operator: 'EXISTS', value: true,
}
const EDU_EXISTS = {
  key: 'edu_exists', label: '简历中存在可分割的教育经历条目', kind: 'MUST_HAVE', weight: 0.25,
  field: 'education', operator: 'EXISTS', value: true,
}
const TEAM_LEAD = {
  key: 'team_lead', label: '有带团队经验', kind: 'NICE_TO_HAVE', weight: 0.25,
  question: '是否有 ≥1 年、≥3 人的直接带团队经历？',
}
const DIMENSIONS = [WORK_EXISTS, EDU_EXISTS, TEAM_LEAD]

const WORK_1 = '2021-2024 Backend Engineer, Demo Commerce Co. Payment callback idempotency and reconciliation.'
const WORK_2 = '2019-2021 Backend Engineer, Demo Data Co. Incremental sync pipeline and dead-letter replay.'
const EDU = '2015-2019 B.Sc. Computer Science, Demo University'
const OTHER_SHA = 'a'.repeat(64)

interface RtfOptions {
  /** 覆盖 work_experience 的 evidence（默认两条 converter 形状的 RTF 证据）。 */
  readonly workEvidence?: readonly unknown[]
  /** 覆盖 education 的 evidence。 */
  readonly eduEvidence?: readonly unknown[]
  /** 覆盖文档级证据索引（resume_version.evidence）。 */
  readonly index?: readonly unknown[]
  /** 是否在 parsed_fields.meta 里带上 converter 自报 sha。 */
  readonly withMetaSha?: boolean
  readonly parserName?: string
}

/** RTF converter 形状的字段证据（`converter/src/resume_fields.py::_evidence`：无 bbox，有 block/paragraph）。 */
function rtfEvidence(sha: string, block: number, text: string) {
  return { page: 1, bbox: null, block, text, source_sha256: sha }
}

/** 文档级证据索引（`resume_version.evidence` 的形状：source_asset_sha256 + quote + block）。 */
function rtfIndexRow(sha: string, field: string, block: number, quote: string) {
  return { field, page: 1, bbox: [], block, quote, source_asset_sha256: sha, page_count: 1 }
}

/** 默认的 RTF parsed_fields（与演示材料同形：work 两条 + education 一条）。 */
function rtfFields(sha: string, options: RtfOptions = {}): Record<string, unknown> {
  const workEvidence = options.workEvidence ?? [rtfEvidence(sha, 4, WORK_1), rtfEvidence(sha, 5, WORK_2)]
  const eduEvidence = options.eduEvidence ?? [rtfEvidence(sha, 7, EDU)]
  return {
    fields: {
      name: { state: 'present', value: 'Candidate', provenance: 'native_text', evidence: [rtfEvidence(sha, 0, 'Candidate')] },
      phone: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
      email: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
      work_experience: { state: 'present', entry_count: 2, provenance: 'native_text', evidence: workEvidence },
      education: { state: 'present', entry_count: 1, provenance: 'native_text', evidence: eduEvidence },
    },
    issues: [],
    screening: { eligible_fields: ['work_experience', 'education', 'name'] },
    meta: {
      pages: 1,
      backend: options.parserName === 'python-docx' ? 'python-docx/1.1.0' : 'striprtf/0.0.35',
      ...(options.withMetaSha === false ? {} : { source_sha256: sha }),
    },
  }
}

/**
 * 给已有场景追加一条新材料版本，并把申请指过去。
 *
 * 为什么不用 `seedScenario` 的默认 resume_version：默认夹具是 PARSED 的 PDF 形状（page+bbox），
 * 而本组用例要验证的正是"无 bbox"的 RTF/DOCX/纯文本定位器。这里只改材料行，不碰 rubric/申请身份。
 * @returns 新材料版本的 id 与源 sha。
 */
async function addMaterialVersion(
  client: Parameters<typeof evaluateInTransaction>[0],
  applicationId: string,
  baseResumeVersionId: string,
  fields: Record<string, unknown>,
  index: readonly unknown[],
  parserName = 'striprtf',
): Promise<{ id: string; sha: string }> {
  const base = (await client.query<{
    resume_id: string
    source_asset_sha256: string
    content_sha256: string
    version_no: number
  }>(`select resume_id, source_asset_sha256, content_sha256, version_no
        from recruitment.resume_version where id = $1`, [baseResumeVersionId])).rows[0]
  assert.ok(base, 'base resume_version must exist')
  const row = (await client.query<{ id: string }>(`insert into recruitment.resume_version
      (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
       parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
      values ((select tenant_id from recruitment.resume_version where id = $1), $2, $3, $4, $5, $6, '1.0.0',
              'PARSED', null, $7::jsonb, $8::jsonb)
      returning id`, [
    baseResumeVersionId, base.resume_id, base.version_no + 1, base.source_asset_sha256,
    base.content_sha256, parserName, JSON.stringify(fields), JSON.stringify(index),
  ])).rows[0]
  assert.ok(row, 'inserted resume_version must return a row')
  await client.query('update recruitment.application set resume_version_id = $2 where id = $1', [applicationId, row.id])
  return { id: row.id, sha: base.source_asset_sha256 }
}

/** 在事务里跑一次评估。 */
async function evaluate(client: Parameters<typeof evaluateInTransaction>[0], applicationId: string) {
  return evaluateInTransaction(client, cfg, { application_id: applicationId }, Date.now())
}

/** 取某个 criterion 的 reason。 */
function reasonOf(value: Awaited<ReturnType<typeof evaluate>>, key: string) {
  return value.reasons.find((reason) => reason.criterion_key === key)
}

test('D-110 正例：RTF 证据（无 bbox，只有 block/paragraph）→ work/edu 判 present，证据带 rtf_paragraph 定位', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const base = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]
    assert.ok(base)
    const sha = base.source_asset_sha256
    const index = [
      rtfIndexRow(sha, 'work_experience', 4, WORK_1),
      rtfIndexRow(sha, 'work_experience', 5, WORK_2),
      rtfIndexRow(sha, 'education', 7, EDU),
    ]
    const material = await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, rtfFields(sha), index)

    const value = await evaluate(client, seeded.applicationId)
    assert.equal(value.verdict, 'PASS')
    assert.equal(value.required_human_action, 'CONFIRM_DECISION')

    const work = reasonOf(value, 'work_exists')
    assert.ok(work, 'work_exists reason must exist')
    assert.equal(work.outcome, 'SATISFIED')
    assert.equal(work.tri_state, 'present')
    assert.equal(work.evidence.length, 2)

    const first = work.evidence[0]
    assert.ok(first)
    assert.equal(first.source_asset_sha256, sha)
    assert.equal(first.quote, WORK_1)
    assert.equal(first.block, 4)
    assert.equal(first.locator_kind, 'rtf_paragraph')
    assert.equal(first.verification_method, 'PERSISTED_SHA_CHAIN+LOCATOR_UNIQUE+LITERAL_QUOTE')
    assert.deepEqual(first.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
    // RTF 没有 bbox：输出诚实给空数组，不伪造坐标；页码来自 converter（1）。
    assert.deepEqual(first.bbox, [])
    assert.equal(first.page, 1)
    assert.ok(work.issue_codes.every((code) => !code.startsWith('evidence_rejected:')))

    const edu = reasonOf(value, 'edu_exists')
    assert.ok(edu)
    assert.equal(edu.outcome, 'SATISFIED')
    assert.equal(edu.evidence[0]?.locator?.kind, 'rtf_paragraph')
    assert.equal(edu.evidence[0]?.locator?.paragraph, 7)

    // 材料版本绑定正确（snapshot 指向新版本）。
    assert.equal(value.snapshot.resume_version_id, material.id)
  })
})

test('D-110 反证①：quote 在原文多处命中且无定位器 → QUOTE_AMBIGUOUS，拒绝且不取第一条', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const sha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(sha)
    const AMBIGUOUS = '同一句原文在简历里出现了两次'
    // 字段证据没有 block/paragraph（没有定位器），同一句在索引的 block 4 与 block 5 两处各出现一次。
    const index = [
      { field: 'work_experience', page: 1, bbox: [], block: 4, quote: AMBIGUOUS, source_asset_sha256: sha, page_count: 1 },
      { field: 'work_experience', page: 1, bbox: [], block: 5, quote: AMBIGUOUS, source_asset_sha256: sha, page_count: 1 },
      rtfIndexRow(sha, 'education', 7, EDU),
    ]
    const fields = rtfFields(sha, {
      workEvidence: [{ page: 1, bbox: null, text: AMBIGUOUS, source_sha256: sha }],
    })
    await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, fields, index)

    const value = await evaluate(client, seeded.applicationId)
    assert.equal(value.verdict, 'NEEDS_REVIEW')
    assert.equal(value.required_human_action, 'REVIEW_UNREADABLE')
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.code, 'MUST_HAVE_UNREADABLE')
    assert.equal(work.tri_state, 'unreadable')
    assert.deepEqual(work.evidence, [], '歧义时不得把任何一条当证据（禁止取第一条）')
    assert.ok(work.issue_codes.includes('evidence_rejected:QUOTE_AMBIGUOUS'), `issue_codes=${work.issue_codes.join(',')}`)
  })
})

test('D-110 反证①b：索引里同一位置出现两份不同原文 → LOCATOR_AMBIGUOUS，拒绝', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const sha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(sha)
    const index = [
      rtfIndexRow(sha, 'work_experience', 4, WORK_1),
      // 同一 block 4 的第二份原文（与第一条不同）→ 定位不唯一。
      { field: 'work_experience', page: 1, bbox: [], block: 4, quote: WORK_2, source_asset_sha256: sha, page_count: 1 },
      rtfIndexRow(sha, 'education', 7, EDU),
    ]
    const fields = rtfFields(sha, { workEvidence: [rtfEvidence(sha, 4, WORK_1)] })
    await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, fields, index)

    const value = await evaluate(client, seeded.applicationId)
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.tri_state, 'unreadable')
    assert.deepEqual(work.evidence, [])
    assert.ok(work.issue_codes.includes('evidence_rejected:LOCATOR_AMBIGUOUS'), `issue_codes=${work.issue_codes.join(',')}`)
  })
})

test('D-110 反证②：证据声明的 source_sha256 与材料不一致 → 拒绝，字段 unreadable + EVIDENCE_SHA_MISMATCH', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const sha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(sha)
    const index = [rtfIndexRow(sha, 'work_experience', 4, WORK_1), rtfIndexRow(sha, 'education', 7, EDU)]
    // 字段证据声称来自另一份字节（sha 不符）——原文都变了，任何引用都不能信。
    const fields = rtfFields(sha, { workEvidence: [rtfEvidence(OTHER_SHA, 4, WORK_1)] })
    await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, fields, index)

    const value = await evaluate(client, seeded.applicationId)
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.code, 'MUST_HAVE_UNREADABLE')
    assert.equal(work.tri_state, 'unreadable')
    assert.deepEqual(work.evidence, [])
    assert.ok(work.issue_codes.includes('evidence_rejected:SHA256_MISMATCH'), `issue_codes=${work.issue_codes.join(',')}`)
    assert.ok(value.warnings.some((warning) => warning.code === 'EVIDENCE_SHA_MISMATCH'))
  })
})

test('D-110 反证③：材料真的没有正文（整页扫描件 parse_status=FAILED）→ 直接 BLOCKED_BY_REVIEW，零证据', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, {
      dimensions: DIMENSIONS,
      parseStatus: 'FAILED',
      parseError: 'pdf_no_text',
      fields: parsedFields(),
    })
    let caught: unknown
    try {
      await evaluate(client, seeded.applicationId)
    } catch (error) {
      caught = error
    }
    assert.ok(caught, '整页扫描件必须拿不到任何结论')
    const body = errorBody(caught)
    assert.equal(body.code, 'BLOCKED_BY_REVIEW')
    assert.equal(body.reason_code, 'MATERIAL_PARSE_FAILED')
    // 反证：不能因为放宽证据闸门而对"没读出正文"的材料编出证据。
    assert.deepEqual(body.reasons ?? [], [])
  })
})

test('D-110 反证③b：present 但没有任何可定位证据 → 仍 MUST_HAVE_UNREADABLE（不是"有个字符串就算证据"）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const sha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(sha)
    // 无定位器、无 quote、无索引：只有"present"这个状态，不能自动通过。
    const fields = rtfFields(sha, { workEvidence: [{ page: 1, bbox: null, source_sha256: sha }] })
    await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, fields, [])

    const value = await evaluate(client, seeded.applicationId)
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.tri_state, 'unreadable')
    assert.deepEqual(work.evidence, [])
    assert.ok(work.issue_codes.includes('evidence_rejected:QUOTE_EMPTY'), `issue_codes=${work.issue_codes.join(',')}`)
  })
})

test('D-110 正例（quote 唯一命中反推位置）：无定位器但 quote 在索引里唯一 → 通过，method=QUOTE_UNIQUE', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const sha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [seeded.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(sha)
    const index = [rtfIndexRow(sha, 'work_experience', 4, WORK_1), rtfIndexRow(sha, 'education', 7, EDU)]
    const fields = rtfFields(sha, {
      workEvidence: [{ page: 1, bbox: null, text: WORK_1, source_sha256: sha }],
      eduEvidence: [{ page: 1, bbox: null, text: EDU, source_sha256: sha }],
    })
    await addMaterialVersion(client, seeded.applicationId, seeded.resumeVersionId, fields, index)

    const value = await evaluate(client, seeded.applicationId)
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.outcome, 'SATISFIED')
    assert.equal(work.evidence[0]?.verification_method, 'PERSISTED_SHA_CHAIN+QUOTE_UNIQUE+LITERAL_QUOTE')
    assert.deepEqual(work.evidence[0]?.locator, { kind: 'rtf_paragraph', paragraph: 4, page: 1 })
  })
})

test('D-110 正例：DOCX part+paragraph 与纯文本 line+offset 定位器同样可通过', async () => {
  await inRolledBackTx(pool, async (client) => {
    // DOCX：converter 若给出 part+paragraph（D-110 的 DOCX 定位器），不需要 bbox。
    const docx = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const docxSha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [docx.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(docxSha)
    const docxFields = rtfFields(docxSha, {
      parserName: 'python-docx',
      workEvidence: [{ part: 'word/document.xml', paragraph: 3, text: WORK_1, source_asset_sha256: docxSha }],
      eduEvidence: [{ part: 'word/document.xml', paragraph: 9, text: EDU, source_asset_sha256: docxSha }],
    })
    const docxIndex = [
      { field: 'work_experience', part: 'word/document.xml', paragraph: 3, quote: WORK_1, source_asset_sha256: docxSha, page_count: 1 },
      { field: 'education', part: 'word/document.xml', paragraph: 9, quote: EDU, source_asset_sha256: docxSha, page_count: 1 },
    ]
    await addMaterialVersion(client, docx.applicationId, docx.resumeVersionId, docxFields, docxIndex, 'python-docx')
    const docxValue = await evaluate(client, docx.applicationId)
    const docxWork = reasonOf(docxValue, 'work_exists')
    assert.ok(docxWork)
    assert.equal(docxWork.outcome, 'SATISFIED')
    assert.equal(docxWork.evidence[0]?.locator_kind, 'docx_part_paragraph')
    assert.deepEqual(docxWork.evidence[0]?.locator, { kind: 'docx_part_paragraph', part: 'word/document.xml', paragraph: 3 })

    // 纯文本：line（1-based）+ offset（0-based）。
    const text = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const textSha = (await client.query<{ source_asset_sha256: string }>(
      'select source_asset_sha256 from recruitment.resume_version where id = $1', [text.resumeVersionId])).rows[0]?.source_asset_sha256
    assert.ok(textSha)
    const textFields = rtfFields(textSha, {
      parserName: 'text',
      workEvidence: [{ line: 9, offset: 100, text: WORK_1, source_asset_sha256: textSha }],
      eduEvidence: [{ line: 15, offset: 0, text: EDU, source_asset_sha256: textSha }],
    })
    const textIndex = [
      { field: 'work_experience', line: 9, offset: 100, quote: WORK_1, source_asset_sha256: textSha, page_count: 1 },
      { field: 'education', line: 15, offset: 0, quote: EDU, source_asset_sha256: textSha, page_count: 1 },
    ]
    await addMaterialVersion(client, text.applicationId, text.resumeVersionId, textFields, textIndex, 'text')
    const textValue = await evaluate(client, text.applicationId)
    const textWork = reasonOf(textValue, 'work_exists')
    assert.ok(textWork)
    assert.equal(textWork.outcome, 'SATISFIED')
    assert.equal(textWork.evidence[0]?.locator_kind, 'text_line_offset')
    assert.deepEqual(textWork.evidence[0]?.locator, { kind: 'text_line_offset', line: 9, offset: 100 })
  })
})

test('PDF 现状保留：page+bbox 证据仍按旧口径通过（不回归）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const seeded = await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
    const value = await evaluate(client, seeded.applicationId)
    const work = reasonOf(value, 'work_exists')
    assert.ok(work)
    assert.equal(work.outcome, 'SATISFIED')
    const evidence = work.evidence[0]
    assert.ok(evidence)
    assert.equal(evidence.page, 1)
    assert.equal(evidence.bbox.length, 4)
    // 旧口径：PDF bbox 路径不冒充 D-110 三条件（现状保留，另立任务升级）。
    assert.equal(evidence.locator_kind, undefined)
  })
})
