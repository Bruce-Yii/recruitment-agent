// `structured_json` 的集成矩阵（真库 ra_s6s7，每个用例**必回滚**）。
//
// 覆盖任务书要求的五条：
//   1. 不传 structured_json 的行为不变（parsed_fields 仍是转换器口径）；
//   2. 非法 JSON → 拒绝，且一行不写；
//   3. 证据不成立 → 拒绝，且一行不写；
//   4. 合法结构化 → 写入，state 按 D-29 升级、converter_state 保留、证据列可读回；
//   5. 同一 (sha256, job_id) 带/不带 structured_json 都幂等。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStructuredJson,
  buildMaterial,
  effectiveFields,
  intakeInTransaction,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import type { ConverterOutput } from '../../src/tools/converter.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  DEMO_JOB,
  hex64,
  inRolledBackTx,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)
const PDF = 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter\\corpus\\synthetic\\zero_text.pdf'

test.after(async () => {
  await pool.end()
})

/** 六块合成简历（自编文本，无真实个人资料）。 */
const BLOCKS = [
  { kind: 'paragraph', text: '张示例', location: { page: 1, bbox: [72, 100, 300, 120] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '电话：138 0000 1234  邮箱：zhang.example@example.test', location: { page: 1, bbox: [72, 130, 520, 150] }, provenance: 'native_text' },
  { kind: 'heading', text: '工作经历', location: { page: 1, bbox: [72, 170, 300, 190] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例科技有限公司 后端工程师 2020.07-2023.06', location: { page: 1, bbox: [72, 200, 520, 220] }, provenance: 'native_text' },
  { kind: 'heading', text: '教育背景', location: { page: 1, bbox: [72, 240, 300, 260] }, provenance: 'native_text' },
  { kind: 'paragraph', text: '示例大学 计算机科学 本科 2016.09-2020.06', location: { page: 1, bbox: [72, 270, 520, 290] }, provenance: 'native_text' },
] as const

/** 转换器口径：默认 phone/email 读不出、work_experience 不可切分、education absent。
 *  `phoneReadable=true` 时给一个可自动的 phone（用于"不传 structured_json"这条对照）。 */
function makeOutput(sha: string, phoneReadable = false): ConverterOutput {
  const phone = phoneReadable
    ? {
        state: 'present',
        value: '138 0000 1234',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 130, 520, 150], block: 2, text: '电话：138 0000 1234' }],
      }
    : { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] }
  return {
    text: BLOCKS.map((block) => block.text).join('\n'),
    chars: 200,
    completeness: 'complete',
    issues: [],
    blocks: [...BLOCKS],
    fields: {
      name: {
        state: 'present',
        value: '张示例',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 100, 300, 120], block: 1, text: '张示例' }],
      },
      phone,
      email: { state: 'unreadable', reason: 'value_masked_or_redacted', provenance: 'native_text', evidence: [] },
      work_experience: {
        state: 'unreadable',
        reason: 'entries_not_segmentable',
        provenance: 'native_text',
        evidence: [],
      },
      education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
    },
    timeline: { intervals: 0, closed_intervals: 0, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 0 },
    screening: {
      eligible_fields: phoneReadable ? ['name', 'phone'] : ['name'],
      blocked_fields: [],
      identity_merge_eligible: phoneReadable ? ['name', 'phone'] : ['name'],
    },
    meta: {
      pages: 1,
      source_sha256: sha,
      source_name: 'zero_text.pdf',
      backend: 'pymupdf/1.28.0',
      reader_version: '1.0.0',
      order_verified: true,
    },
  } as ConverterOutput
}

function makeMaterial(sha: string, phoneReadable = false): IntakeMaterial {
  return buildMaterial(PDF, makeOutput(sha, phoneReadable))
}

/** 契约形状（与 contracts/schema.json 一致；当前 validate() 能接受）。 */
function contractShape(): Record<string, unknown> {
  return {
    prompt_version: '1.0.0',
    schema_version: '1.0.0',
    block_count: 6,
    sections: [
      { label: 'contact', block_ids: ['1', '2'] },
      { label: 'work_experience', block_ids: ['3', '4'] },
      { label: 'education', block_ids: ['5', '6'] },
    ],
    fields: {
      name: { state: 'present', value: '张示例', block_ids: ['1'] },
      phone: { state: 'present', value: '138 0000 1234', block_ids: ['2'] },
      email: { state: 'present', value: 'zhang.example@example.test', block_ids: ['2'] },
      work_experience: {
        state: 'present',
        block_ids: ['3', '4'],
        value: [
          {
            company: { value: '示例科技有限公司', block_ids: ['4'] },
            title: { value: '后端工程师', block_ids: ['4'] },
            start: { value: '2020.07', block_ids: ['4'] },
            end: { value: '2023.06', block_ids: ['4'] },
            block_ids: ['4'],
            attribution: 'single_block',
          },
        ],
      },
      education: {
        state: 'present',
        block_ids: ['5', '6'],
        value: [
          {
            school: { value: '示例大学', block_ids: ['6'] },
            major: { value: '计算机科学', block_ids: ['6'] },
            degree: { value: '本科', block_ids: ['6'] },
            start: { value: '2016.09', block_ids: ['6'] },
            end: { value: '2020.06', block_ids: ['6'] },
            block_ids: ['6'],
            attribution: 'single_block',
          },
        ],
      },
    },
  }
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

async function countMaterialRows(client: DatabaseClient): Promise<number[]> {
  const tables = [
    'recruitment.candidate',
    'recruitment.application',
    'recruitment.resume',
    'recruitment.resume_version',
    'recruitment.intake_record',
    'recruitment.intake_asset',
  ]
  const counts: number[] = []
  for (const table of tables) {
    counts.push(await count(client, `select count(*) as n from ${table} where tenant_id = $1`, [TENANT]))
  }
  return counts
}

async function readResumeVersion(
  client: DatabaseClient,
  id: string,
): Promise<{ parsed_fields: Record<string, any>; evidence: Record<string, any>[] }> {
  const { rows } = await client.query<{ parsed_fields: Record<string, any>; evidence: Record<string, any>[] }>(
    'select parsed_fields, evidence from recruitment.resume_version where id = $1',
    [id],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('resume_version row missing')
  return row
}

test('不传 structured_json：行为不变（parsed_fields 仍是转换器投影，无 structured 标记）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial(hex64(`no-structured${uniqueSuffix()}`), true)
    assert.equal(material.structured, undefined)
    assert.deepEqual(effectiveFields(material), material.output.fields)

    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(value.created, true)
    const { parsed_fields: parsed } = await readResumeVersion(client, value.resume_version_id)
    assert.equal(parsed.fields.phone.state, 'present')
    assert.equal(parsed.fields.phone.value, '138 0000 1234')
    assert.equal(Object.hasOwn(parsed.fields.phone, 'state_source'), false)
    assert.equal(Object.hasOwn(parsed.fields.phone, 'converter_state'), false)
    assert.equal(Object.hasOwn(parsed, 'structured'), false, '不传时不得出现结构化标记')
    // 转换器事实原样保留
    assert.deepEqual(parsed.issues, [])
    assert.equal(parsed.meta.source_sha256, material.sha256)
  })
})

test('非法 JSON → INVALID_ARGS(STRUCTURED_JSON_INVALID)，且一行不写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial(hex64(`bad-json${uniqueSuffix()}`))
    const before = await countMaterialRows(client)
    assert.throws(
      () => applyStructuredJson(material, '{"sections":', DEMO_JOB),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_ARGS')
        assert.match((error as Error).message, /STRUCTURED_JSON_INVALID/)
        return true
      },
    )
    const after = await countMaterialRows(client)
    assert.deepEqual(after, before, '非法 JSON 不得写任何行')
  })
})

test('证据不成立 → STRUCTURED_REJECTED(rejections 前 10 条)，且一行不写', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = makeMaterial(hex64(`bad-evidence${uniqueSuffix()}`))
    const structured = contractShape() as Record<string, any>
    structured.fields.phone.value = '139 0000 9999'
    const before = await countMaterialRows(client)
    assert.throws(
      () => applyStructuredJson(material, JSON.stringify(structured), DEMO_JOB),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
        const message = (error as Error).message
        const body = JSON.parse(message.slice(message.indexOf(': ') + 2)) as {
          reason_code: string
          detail: { rejected_by: string; rejection_count: number; shown: number; rejections: { code: string }[] }
        }
        assert.equal(body.reason_code, 'STRUCTURED_REJECTED')
        assert.equal(body.detail.rejected_by, 'validate')
        assert.equal(body.detail.shown, Math.min(10, body.detail.rejection_count))
        assert.ok(body.detail.rejections.some((item) => item.code === 'VALUE_NOT_IN_BLOCK'))
        return true
      },
    )
    const after = await countMaterialRows(client)
    assert.deepEqual(after, before, '证据不成立时一行都不写（不降级接受）')
  })
})

test('合法结构化 → 写入；state 按 D-29 升级、converter_state 保留、证据列可读回 block id + 原文', async () => {
  await inRolledBackTx(pool, async (client) => {
    const material = applyStructuredJson(
      makeMaterial(hex64(`structured-ok${uniqueSuffix()}`)),
      JSON.stringify(contractShape()),
      DEMO_JOB,
    )
    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.equal(value.created, true)
    assert.equal(value.candidate_created, true)
    assert.equal(value.source.parse_status, 'PARSED', 'parse_status 仍由转换器事实决定')
    assert.equal(value.source.completeness, 'complete')
    assert.deepEqual(value.identity.strong_ids, ['email', 'phone'])

    const { parsed_fields: parsed, evidence } = await readResumeVersion(client, value.resume_version_id)

    // D-29 的升级方向：converter unreadable → final present，且保留 converter_state。
    assert.equal(parsed.fields.phone.state, 'present')
    assert.equal(parsed.fields.phone.state_source, 'agent_structured')
    assert.equal(parsed.fields.phone.provenance, 'agent_read')
    assert.equal(parsed.fields.phone.converter_state, 'unreadable')
    assert.equal(parsed.fields.phone.value, '138 0000 1234')
    assert.deepEqual(parsed.fields.phone.block_ids, [2])
    assert.equal(parsed.fields.phone.agent_evidence[0].block_id, 2)
    assert.match(parsed.fields.phone.agent_evidence[0].quote, /138 0000 1234/)
    assert.equal(parsed.fields.phone.evidence[0].page, 1)
    assert.deepEqual(parsed.fields.phone.evidence[0].bbox, [72, 130, 520, 150])
    assert.equal(parsed.fields.phone.evidence[0].source, 'agent_structured')
    assert.equal(parsed.fields.phone.evidence[0].source_asset_sha256, material.sha256)

    // 材料可用性：work_experience / education 也按模型层升级，converter 结论保留。
    assert.equal(parsed.fields.work_experience.state, 'present')
    assert.equal(parsed.fields.work_experience.converter_state, 'unreadable')
    assert.equal(parsed.fields.work_experience.entry_count, 1)
    assert.deepEqual(parsed.fields.work_experience.block_ids, [3, 4])
    assert.equal(parsed.fields.education.state, 'present')
    assert.equal(parsed.fields.education.converter_state, 'absent')

    // parsed_fields.structured：来源标记 + 每个字段引用了哪些 block。
    assert.equal(parsed.structured.source, 'agent_structured')
    assert.equal(parsed.structured.validated, true)
    assert.equal(parsed.structured.block_index_entries, 6)
    assert.deepEqual(parsed.structured.fields.phone.block_ids, [2])
    assert.equal(parsed.structured.fields.work_experience.state, 'present')

    // 证据列：converter 的证据仍在，Agent 证据带 block_id + 原文。
    assert.ok(evidence.some((item) => item.field === 'name' && item.source === undefined), '转换器证据不得被删')
    const agentEvidence = evidence.filter((item) => item.source === 'agent_structured')
    assert.ok(agentEvidence.length >= 5)
    const phoneEvidence = agentEvidence.find((item) => item.field === 'phone' && item.block_id === 2)
    assert.ok(phoneEvidence !== undefined)
    assert.match(String(phoneEvidence.quote), /138 0000 1234/)
    assert.equal(phoneEvidence.block_no, 2)
    assert.equal(phoneEvidence.page, 1)
    assert.equal(phoneEvidence.source_asset_sha256, material.sha256)

    // 身份规范化来自模型层原文（IR-N5：写规范形，不回写原文）。
    const { rows } = await client.query<{ display_name: string; normalized_phone: string }>(
      'select display_name, normalized_phone from recruitment.candidate where id = $1',
      [value.candidate_id],
    )
    assert.equal(rows[0]?.display_name, '张示例')
    assert.equal(rows[0]?.normalized_phone, '+8613800001234')
  })
})

test('模型说 unreadable → 最终 unreadable（converter present 不得把它变成 present/absent）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const sha = hex64(`downgrade${uniqueSuffix()}`)
    const output = makeOutput(sha)
    output.fields = {
      ...output.fields,
      phone: {
        state: 'present',
        value: '138 0000 1234',
        provenance: 'native_text',
        evidence: [{ page: 1, bbox: [72, 130, 520, 150], block: 2, text: '电话：138 0000 1234' }],
      },
    }
    const structured = contractShape() as Record<string, any>
    structured.fields.phone = {
      state: 'unreadable',
      reason: 'value_masked_or_redacted',
      block_ids: ['2'],
    }
    const material = applyStructuredJson(buildMaterial(PDF, output), JSON.stringify(structured), DEMO_JOB)
    const value = await intakeInTransaction(client, cfg, material, DEMO_JOB)
    assert.deepEqual(value.identity.strong_ids, ['email'], '模型说 phone 读不出 → 不得当强标识')

    const { parsed_fields: parsed } = await readResumeVersion(client, value.resume_version_id)
    assert.equal(parsed.fields.phone.state, 'unreadable')
    assert.equal(parsed.fields.phone.converter_state, 'present')
    assert.equal(parsed.fields.phone.converter_value, '138 0000 1234')
    assert.equal(Object.hasOwn(parsed.fields.phone, 'value'), false, 'unreadable 不得携带 value')
    assert.equal(parsed.fields.phone.reason, 'value_masked_or_redacted')
    assert.notEqual(parsed.fields.phone.state, 'absent', 'unreadable 绝不能当 absent')
  })
})

test('幂等：同一 (sha256, job_id) 带/不带 structured_json 都只有一条 application', async () => {
  await inRolledBackTx(pool, async (client) => {
    const sha = hex64(`idem${uniqueSuffix()}`)
    const withStructured = applyStructuredJson(makeMaterial(sha), JSON.stringify(contractShape()), DEMO_JOB)
    const first = await intakeInTransaction(client, cfg, withStructured, DEMO_JOB)
    assert.equal(first.created, true)

    // 不带 structured_json 的同一材料 → replay，不新增行、不改写已有版本。
    const withoutStructured = makeMaterial(sha)
    const second = await intakeInTransaction(client, cfg, withoutStructured, DEMO_JOB)
    assert.equal(second.created, false)
    assert.equal(second.idempotent_replay, true)
    assert.equal(second.application_id, first.application_id)
    assert.equal(second.resume_version_id, first.resume_version_id)

    // 再带 structured_json 调一次 → 仍是 replay。
    const third = await intakeInTransaction(client, cfg, withStructured, DEMO_JOB)
    assert.equal(third.created, false)
    assert.equal(third.application_id, first.application_id)

    const apps = await count(
      client,
      'select count(*) as n from recruitment.application where tenant_id = $1 and job_id = $2 and resume_version_id = $3',
      [TENANT, DEMO_JOB, first.resume_version_id],
    )
    assert.equal(apps, 1)

    // 首次写入（带结构化）的 parsed_fields 不被 replay 改写。
    const { parsed_fields: parsed } = await readResumeVersion(client, first.resume_version_id)
    assert.equal(parsed.structured.source, 'agent_structured')
  })
})

test('反向幂等：先不带 structured_json 建，再带着结构化重放 → 仍只有一条 application', async () => {
  await inRolledBackTx(pool, async (client) => {
    const sha = hex64(`idem-reverse${uniqueSuffix()}`)
    const first = await intakeInTransaction(client, cfg, makeMaterial(sha, true), DEMO_JOB)
    assert.equal(first.created, true)

    const withStructured = applyStructuredJson(makeMaterial(sha, true), JSON.stringify(contractShape()), DEMO_JOB)
    const second = await intakeInTransaction(client, cfg, withStructured, DEMO_JOB)
    assert.equal(second.created, false)
    assert.equal(second.application_id, first.application_id)
    assert.equal(second.resume_version_id, first.resume_version_id)

    const apps = await count(
      client,
      'select count(*) as n from recruitment.application where tenant_id = $1 and job_id = $2 and resume_version_id = $3',
      [TENANT, DEMO_JOB, first.resume_version_id],
    )
    assert.equal(apps, 1)
  })
})
