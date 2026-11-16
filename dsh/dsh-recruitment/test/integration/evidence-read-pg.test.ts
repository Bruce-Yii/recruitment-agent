// D-141 ⑧ + ① 的**真库 + 真读取器**集成测试（一次性空库，D-137.2：不写 ra_s6s7）。
//
// 证明两件事（不是"函数能跑"，是"Agent 在真实数据上能引用第 N 页/第 N 行：'原句…'"）：
//   1. `recruitment_material_read` 的 `execute()`（真入口：parseArgs → 连接池 → 只读事务 → 受控文件读取）
//      在 TEXT 模式返回**可定位逐字引文**：PDF `pdf_page_bbox`（page+bbox）、DOCX `docx_part_paragraph`
//      （part+paragraph_id）、RTF `rtf_paragraph`（paragraph+page）；每条带 `source_sha256`（= 磁盘字节 sha256
//      = 库里钉住值）并标 `asset_sha256_verified=true`；quote 在读取器全文里**逐字命中**（offset 处复核）。
//      * 反证：整页扫描件（无文字层，blocks 为空）→ `MATERIAL_ORIGINAL_NOT_LOCATED`，不假成功。
//   2. `recruitment_application_get` 的 `execute()` 在 rubric 块给 `criteria_summary`
//      （key/label/kind/weight，≤8 条 + 真实 criteria_count），使"这条路能不能跑"不必再调 job_get。
//
// 一次性库：`createIsolatedTestDatabase()` 建 `ra_evidence_read_*`，重放 0001→0016，跑完 drop。
// fixture：`test/document/fixtures.ts` 的合成 PDF/DOCX（Python 生成，测试自己复核 sha），RTF 由本文件写出。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  createApplicationGetTool,
  createMaterialReadTool,
} from '../../src/tools/business-read.ts'
import {
  TENANT,
  createIsolatedTestDatabase,
  hex64,
  one,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
  uniqueSuffix,
  type IsolatedTestDatabase,
} from './db.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type pg from 'pg'
import {
  CONVERTER_DIR,
  ensureFixtures,
  fixturePath,
  resolvePython,
  sha256OfFile,
  type Fixtures,
} from '../document/fixtures.ts'
import { readDocumentDetailed } from '../../src/document/readers/index.ts'
import { resolveConverterConfig } from '../../src/tools/converter.ts'

const APP_ID = '11111111-1111-4111-8111-000000000701'

/** 一次集成测试运行所需的三样东西（一次性库 / 合成 fixture / converter 配置）。 */
interface Context {
  readonly isolated: IsolatedTestDatabase
  readonly db: ResolvedDatabaseConfig
  readonly fixtures: Fixtures
  readonly converter: NonNullable<ReturnType<typeof resolveConverterConfig>['resolved']>
}

let context: Context | null = null

/** 10 条 dimensions：用来证明 criteria_summary 截到 8 条但 criteria_count 仍是真实 10。 */
const TEN_DIMENSIONS = Array.from({ length: 10 }, (_, index) => ({
  key: `criterion_${index}`,
  label: `标准 ${index}`,
  kind: index < 4 ? 'MUST_HAVE' : 'NICE_TO_HAVE',
  weight: 0.1,
  field: 'work_experience',
  operator: 'EXISTS',
  value: true,
  question: `第 ${index} 条的问题全文（不应出现在 criteria_summary 里）`,
  notes: `第 ${index} 条的备注全文（不应出现在 criteria_summary 里）`,
}))

/** 合成 RTF（ASCII，striprtf 可读；段落用 `\par` 分隔）。 */
function buildSyntheticRtf(): string {
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}',
    '\\f0\\fs22 Zhang Sample\\par',
    'Work Experience\\par',
    '2021-2024 Backend Engineer, Demo Commerce Co.\\par',
    '2019-2021 Backend Engineer, Demo Data Co.\\par',
    'Education\\par',
    '2015-2019 B.Sc. Computer Science, Demo University\\par',
    '}',
    '',
  ].join('\n')
}

/**
 * 在一次性库里真提交一份夹具并把它指向一个**真实文件**（文件名/字节数/sha256 都来自磁盘）。
 *
 * 为什么不复用 `seedScenario` 的材料链：`resume_version.source_asset_sha256` 是**不可修改列**
 * （`fn_guard_columns` 会拒绝 update），所以"先插假 sha 再改成真 sha"这条路走不通；
 * 这里直接按产品真实写入形状插整条链（job/rubric 仍复用 `seedScenario`，材料链自己插）。
 * @param options.sourceShaOverride - 故意写成与磁盘不符的 sha（验证"找不到原件"的闭集 reason）。
 */
async function seedMaterialScenario(
  pool: pg.Pool,
  fileName: string,
  filePath: string,
  options: { readonly sourceShaOverride?: string; readonly parseStatus?: string } = {},
): Promise<{ applicationId: string; resumeVersionId: string; sha256: string; bytes: number }> {
  const actualSha = sha256OfFile(filePath)
  const bytes = readFileSync(filePath).length
  const recordedSha = options.sourceShaOverride ?? actualSha
  const mime = fileName.endsWith('.pdf')
    ? 'application/pdf'
    : fileName.endsWith('.docx')
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      : 'application/rtf'
  const client = await pool.connect()
  try {
    await client.query('begin')
    // job / job_version / rubric(+approval) / 一个基础 candidate+application（不复用其材料链）。
    const base = await seedScenario(client, { dimensions: TEN_DIMENSIONS, fields: parsedFields() })
    const suffix = uniqueSuffix()
    const candidateId = await one(client, `insert into recruitment.candidate
        (tenant_id, display_name, identity_status) values ($1, $2, 'ACTIVE') returning id`, [
      TENANT, `证据合成候选人-${suffix}`,
    ])
    const eventId = await one(client, `insert into recruitment.event_inbox
        (tenant_id, provider, event_type, idempotency_key, payload, trust_level)
        values ($1, 'internal', 'test.seed', $2, '{}'::jsonb, 'INTERNAL') returning event_id`, [
      TENANT, `evidence-read:${suffix}`,
    ])
    const intakeRecordId = await one(client, `insert into recruitment.intake_record
        (tenant_id, event_id, subject, status) values ($1, $2, '证据读取测试收件', 'RESOLVED') returning id`, [
      TENANT, eventId,
    ])
    const assetId = await one(client, `insert into recruitment.intake_asset
        (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref,
         validation_status, validation_error)
        values ($1, $2, $3, $4, $5, $6, $7, 'VALID', null) returning id`, [
      TENANT, intakeRecordId, fileName, mime, bytes, recordedSha,
      `content-addressed:sha256:${recordedSha}`,
    ])
    const resumeId = await one(client, `insert into recruitment.resume
        (tenant_id, candidate_id, intake_asset_id) values ($1, $2, $3) returning id`, [
      TENANT, candidateId, assetId,
    ])
    const resumeVersionId = await one(client, `insert into recruitment.resume_version
        (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
         parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
        values ($1, $2, 1, $3, $4, 'converter', '1.0.0', $5, null, $6::jsonb, '[]'::jsonb) returning id`, [
      TENANT, resumeId, recordedSha, hex64(`content${suffix}`),
      options.parseStatus ?? 'PARSED', JSON.stringify(parsedFields()),
    ])
    const applicationId = await one(client, `insert into recruitment.application
        (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
         lifecycle_status, current_stage_code)
        values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'S7') returning id`, [
      TENANT, candidateId, base.jobId, base.jobVersionId, base.rubricId, resumeVersionId,
    ])
    await client.query('commit')
    return { applicationId, resumeVersionId, sha256: actualSha, bytes }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 读取器全文（用来独立复核 quote 的"逐字命中"）。 */
async function readerTextOf(
  ctx: Context,
  fileName: string,
): Promise<{ text: string; assetSha256: string }> {
  const outcome = await readDocumentDetailed(fixturePath(ctx.fixtures, fileName), ctx.converter)
  return { text: outcome.content.text, assetSha256: outcome.content.asset_sha256 }
}

/** 取 TEXT 模式的 text 块（execute 的返回值是 unknown；这里按产品输出形状收窄）。 */
interface MaterialTextShape {
  readonly available: boolean
  readonly reason_code: string
  readonly source_chars: number
  readonly excerpt_chars: number
  readonly excerpt?: string
  readonly asset_sha256_verified?: boolean
  readonly citation_count?: number
  readonly citations?: readonly {
    readonly seq: number
    readonly locator_kind: string
    readonly verification_method: string
    readonly source_sha256: string
    readonly quote: string
    readonly quote_chars: number
    readonly page?: number
    readonly part?: string
    readonly paragraph?: number
    readonly paragraph_id?: string
    readonly line?: number
    readonly offset?: number
  }[]
}

test.before(async () => {
  const isolated = await createIsolatedTestDatabase('evidence_read')
  // D-137.2 守卫：真提交的用例必须独占一次性库，绝不写共享库。
  assert.notEqual(isolated.name, process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7')
  assert.match(isolated.name, /^ra_evidence_read_[a-z0-9_]+$/)
  const baseCfg = testDatabaseConfig()
  const db: ResolvedDatabaseConfig = { ...baseCfg, database: isolated.name }
  const fixtures = ensureFixtures()
  const python = resolvePython()
  const resolved = resolveConverterConfig({
    python_bin: python.bin,
    converter_dir: CONVERTER_DIR,
    allowed_roots: [fixtures.dir],
    timeout_ms: 180_000,
  }, process.env)
  if (resolved.resolved === null) throw new Error(`converter config: ${resolved.issues.join('; ')}`)
  context = { isolated, db, fixtures, converter: resolved.resolved }
})

test.after(async () => {
  await context?.isolated.drop()
})

/** 取上下文（before 失败时给出清晰错误，不静默 skip）。 */
function ctx(): Context {
  if (context === null) throw new Error('integration context was not initialised')
  return context
}

test('material_read TEXT（PDF）：逐字引文带 page+bbox+line+offset，quote 在读取器全文逐字命中，sha 对齐', async () => {
  const current = ctx()
  const fileName = 'text_simple.pdf'
  const filePath = fixturePath(current.fixtures, fileName)
  const scenario = await seedMaterialScenario(current.isolated.pool, fileName, filePath)
  const { text, assetSha256 } = await readerTextOf(current, fileName)
  assert.equal(assetSha256, scenario.sha256)

  const tool = createMaterialReadTool({ database: current.db, converter: current.converter })
  const value = await tool.execute({ application_id: scenario.applicationId, mode: 'TEXT', max_chars: 2000 })
  const materialText = (value as { text: MaterialTextShape }).text

  assert.equal(materialText.available, true)
  assert.equal(materialText.reason_code, 'OK')
  assert.equal(materialText.asset_sha256_verified, true)
  assert.ok(materialText.citation_count !== undefined && materialText.citation_count >= 3)
  assert.ok(materialText.excerpt !== undefined)
  assert.ok(materialText.excerpt.length <= 2000)
  assert.ok(materialText.excerpt.length < text.length || text.length <= 2000)

  const citations = materialText.citations ?? []
  const pages = new Set<number>()
  for (const citation of citations) {
    assert.equal(citation.locator_kind, 'pdf_page_bbox')
    assert.equal(citation.verification_method, 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE')
    // 原件 sha256：本次读到的磁盘字节 = 库里钉住值（独立 Get-FileHash/reader 交叉验证）。
    assert.equal(citation.source_sha256, scenario.sha256)
    // quote 在读取器全文里逐字命中；有 offset 时按 offset 复核（D-110 条件 ③）。
    assert.ok(text.includes(citation.quote), `quote 不是全文逐字子串: ${citation.quote}`)
    if (citation.offset !== undefined) {
      assert.equal(text.slice(citation.offset, citation.offset + citation.quote.length), citation.quote)
      assert.ok(citation.line !== undefined && citation.line >= 1)
    }
    assert.ok(citation.page !== undefined && citation.page >= 1)
    pages.add(citation.page)
  }
  assert.deepEqual([...pages].sort(), [1, 2])
  // 联系方式块（EMAIL: alpha@example.invalid）被整块跳过，引文里不出现邮箱原文。
  assert.ok(!citations.some((citation) => citation.quote.includes('@')))
})

test('material_read TEXT（DOCX）：docx_part_paragraph 定位（part+paragraph_id）+ 逐字命中', async () => {
  const current = ctx()
  const fileName = 'docx_normal.docx'
  const filePath = fixturePath(current.fixtures, fileName)
  const scenario = await seedMaterialScenario(current.isolated.pool, fileName, filePath)
  const { text } = await readerTextOf(current, fileName)

  const tool = createMaterialReadTool({ database: current.db, converter: current.converter })
  const value = await tool.execute({ application_id: scenario.applicationId, mode: 'TEXT' })
  const materialText = (value as { text: MaterialTextShape }).text

  assert.equal(materialText.available, true)
  assert.equal(materialText.asset_sha256_verified, true)
  assert.ok((materialText.citation_count ?? 0) >= 2)
  for (const citation of materialText.citations ?? []) {
    assert.equal(citation.locator_kind, 'docx_part_paragraph')
    assert.equal(citation.part, 'word/document.xml')
    assert.match(citation.paragraph_id ?? '', /^p\d+$/)
    assert.equal(
      citation.paragraph,
      Number((citation.paragraph_id ?? '').slice(1)),
      'paragraph 数值必须与 paragraph_id 一致（0-based，不猜）',
    )
    assert.ok(text.includes(citation.quote))
  }
})

test('material_read TEXT（RTF）：rtf_paragraph 定位（0-based 段落 + page）+ 逐字命中', async () => {
  const current = ctx()
  const rtfName = 'evidence-read-demo-0701.rtf'
  writeFileSync(join(current.fixtures.dir, rtfName), buildSyntheticRtf(), 'utf8')
  const scenario = await seedMaterialScenario(current.isolated.pool, rtfName, join(current.fixtures.dir, rtfName))
  const { text } = await readerTextOf(current, rtfName)

  const tool = createMaterialReadTool({ database: current.db, converter: current.converter })
  const value = await tool.execute({ application_id: scenario.applicationId, mode: 'TEXT', max_chars: 2000 })
  const materialText = (value as { text: MaterialTextShape }).text

  assert.equal(materialText.available, true)
  assert.equal(materialText.asset_sha256_verified, true)
  const citations = materialText.citations ?? []
  assert.ok(citations.length >= 3)
  const paragraphs = citations.map((citation) => citation.paragraph)
  assert.deepEqual(paragraphs, [...paragraphs].sort((left, right) => (left ?? 0) - (right ?? 0)))
  for (const citation of citations) {
    assert.equal(citation.locator_kind, 'rtf_paragraph')
    assert.ok(citation.paragraph !== undefined && citation.paragraph >= 0)
    assert.equal(citation.source_sha256, scenario.sha256)
    assert.ok(text.includes(citation.quote), `quote 不是全文逐字子串: ${citation.quote}`)
    if (citation.offset !== undefined) {
      assert.equal(text.slice(citation.offset, citation.offset + citation.quote.length), citation.quote)
    }
  }
  // 至少有一条落在工作经历段落上（合成 RTF 里第二段其后是工作经历）。
  assert.ok(citations.some((citation) => citation.quote.includes('Backend Engineer')))
})

test('material_read TEXT（整页扫描件）：无文字层/blocks → MATERIAL_ORIGINAL_NOT_LOCATED（不假成功）', async () => {
  const current = ctx()
  const fileName = 'scan_image_only.pdf'
  const filePath = fixturePath(current.fixtures, fileName)
  const scenario = await seedMaterialScenario(current.isolated.pool, fileName, filePath)

  const tool = createMaterialReadTool({ database: current.db, converter: current.converter })
  const value = await tool.execute({ application_id: scenario.applicationId, mode: 'TEXT' })
  const materialText = (value as { text: MaterialTextShape }).text

  assert.equal(materialText.available, false)
  assert.equal(materialText.reason_code, 'MATERIAL_ORIGINAL_NOT_LOCATED')
  assert.equal(materialText.excerpt, undefined)
  assert.equal(materialText.citations, undefined)
  assert.equal(materialText.asset_sha256_verified, undefined)
})

test('material_read TEXT（库里钉住的 sha 与磁盘不符）：find 不到原件 → 闭集 reason，不返回正文', async () => {
  const current = ctx()
  const fileName = 'text_simple.pdf'
  const scenario = await seedMaterialScenario(
    current.isolated.pool,
    fileName,
    fixturePath(current.fixtures, fileName),
    { sourceShaOverride: 'e'.repeat(64) },
  )

  const tool = createMaterialReadTool({ database: current.db, converter: current.converter })
  const value = await tool.execute({ application_id: scenario.applicationId, mode: 'TEXT' })
  const materialText = (value as { text: MaterialTextShape }).text
  assert.equal(materialText.available, false)
  assert.equal(materialText.reason_code, 'NOT_FOUND_IN_ALLOWED_ROOTS')
  assert.equal(materialText.excerpt, undefined)
})

test('application_get execute：rubric 块给 criteria_summary（≤8 条 + 真实 criteria_count，不带 question/notes）', async () => {
  const current = ctx()
  const fileName = 'text_simple.pdf'
  const scenario = await seedMaterialScenario(current.isolated.pool, fileName, fixturePath(current.fixtures, fileName))

  const tool = createApplicationGetTool({ database: current.db })
  const value = await tool.execute({ application_id: scenario.applicationId }) as {
    applications: readonly {
      rubric?: {
        criteria_count: number
        criteria_summary?: readonly { key: string; label?: string; kind?: string; weight?: number }[]
      }
    }[]
  }
  const rubric = value.applications[0]?.rubric
  assert.ok(rubric !== undefined)
  assert.equal(rubric.criteria_count, 10)
  assert.equal(rubric.criteria_summary?.length, 8)
  assert.deepEqual(rubric.criteria_summary?.[0], {
    key: 'criterion_0',
    label: '标准 0',
    kind: 'MUST_HAVE',
    weight: 0.1,
  })
  // 截断之后的第 8/9/10 条不在摘要里，但 criteria_count 仍是 10（不隐瞒总数）。
  const keys = (rubric.criteria_summary ?? []).map((item) => item.key)
  assert.ok(keys.includes('criterion_7'))
  assert.ok(!keys.includes('criterion_8'))
  const serialized = JSON.stringify(rubric)
  assert.ok(!serialized.includes('问题全文'))
  assert.ok(!serialized.includes('备注全文'))
  assert.ok(!serialized.includes('question'))
  assert.ok(!serialized.includes('notes'))
  // 同一条申请：Agent 判断"这条路能不能跑"所需的 key/label/kind/weight 已在 application_get 的返回里。
  assert.ok(rubric.criteria_summary?.every((item) => typeof item.key === 'string'))
})

test('一次性库自检：0001→0016 全部重放（16 条迁移台账 + 演示租户存在），不是共享库', async () => {
  const current = ctx()
  assert.ok(current.isolated.migrations.length >= 16, `migrations=${current.isolated.migrations.length}`)
  assert.ok(current.isolated.migrations.includes('0016_v1_consistency.sql'))
  const ledger = await current.isolated.pool.query<{ n: string; latest: string | null }>(
    'select count(*)::text as n, max(version) as latest from recruitment.schema_migration',
  )
  assert.equal(ledger.rows[0]?.n, '16')
  assert.equal(ledger.rows[0]?.latest, '0016_v1_consistency')
  // 迁移 0002 的演示申请存在；本测试文件自己 seed 的申请是另外的随机 id（没有污染种子）。
  const demo = await current.isolated.pool.query<{ tenant_id: string }>(
    'select tenant_id from recruitment.application where id = $1',
    [APP_ID],
  )
  assert.equal(demo.rows[0]?.tenant_id, TENANT)
})
