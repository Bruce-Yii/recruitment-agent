// S6 的**格式盲区**回归：真实简历里的 DOCX 必须能进 intake。
//
// 修前的现场（2026-11-14）：`recruitment_document_read` 用 python-docx 读 DOCX
// `completeness=complete`、`blocking=false`，但 `recruitment_application_intake`
// 在 `assertReadablePdf()` 里按**扩展名**硬判 `.pdf`，7 份真实 DOCX 全部
// `INVALID_ARGS(PATH_INVALID)`；RTF 更差（连读都没有 reader）。
//
// 修后的契约（本文件逐条钉住）：
//   1. **按内容嗅探**决定媒体类型，扩展名不参与 → DOCX 进得来，改名成 .pdf 也照样进；
//   2. DOCX 的 phone/email 来自 `native_text` 才可自动归并（与 PDF 同一套字段口径）；
//   3. PDF 不回归；
//   4. 图片 / 旧 OLE / 未知字节仍然被**明确拒绝**（放宽格式 ≠ 什么都收）；
//   5. 身份闸门**没有**因为放宽格式而放宽：OCR / agent_read 来源依然只能 weak。
//
// 2026-11-14 补（RTF lane）：RTF 也有了 reader —— 它进 S6 的读取路径，但**在身份闸门处
// 正确 BLOCKED**：RTF 没有 PDF 的 page+bbox 坐标，IR-G1 要求"证据坐标齐全"才可自动归并，
// 本 lane 不放宽这条闸门（见 `test('RTF 进入 S6 读取路径……')`）。这正是"能读 ≠ 能自动认人"。
//
// 全部用**合成假资料**（`example.invalid` / `138 0000 xxxx`），不碰真实候选人（R7）。
// 依赖本机 python + converter/：缺任一项时 skip 并说明原因（不伪装成通过）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  buildMaterial,
  createApplicationIntakeTool,
  intakeInTransaction,
  resolveIntakeSource,
} from '../../src/tools/application-intake.ts'
import type { ConverterOutput, ResolvedConverterConfig } from '../../src/tools/converter.ts'
import { resolveConverterConfig, runConverter } from '../../src/tools/converter.ts'
import { MEDIA_DOCX, MEDIA_PDF, MEDIA_RTF } from '../../src/document/readers/media.ts'
import {
  createTestPool,
  DEMO_JOB,
  hex64,
  inRolledBackTx,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'
import { PYTHON_BIN } from '../helpers/paths.ts'

const HERE = import.meta.dirname
const CONVERTER_DIR = resolve(HERE, '..', '..', '..', '..', 'converter')
const PYTHON = PYTHON_BIN ?? 'python3'
const CAN_RUN_PYTHON = existsSync(PYTHON) && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))
const SKIP_PYTHON = CAN_RUN_PYTHON ? false : `本机没有 python（${PYTHON}）或 converter/，无法造合成材料`

const dbCfg = testDatabaseConfig()
const pool = createTestPool(dbCfg)

test.after(async () => {
  await pool.end()
})

/** 候选材料目录：每次运行新建，只放本测试生成的假文件。 */
const WORK_DIR = mkdtempSync(join(tmpdir(), 'recruitment-intake-docx-'))
const cfg: ResolvedConverterConfig = resolveConverterConfig({
  python_bin: PYTHON,
  converter_dir: CONVERTER_DIR,
  allowed_roots: [WORK_DIR],
}).resolved as ResolvedConverterConfig

/**
 * 每次现造的联系方式：库里有 `(tenant_id, normalized_phone/email)` 的部分唯一索引，
 * 且身份规则是"命中已有档案就复用"——用固定字面量会命中别处留下的行，
 * `candidate_created` 立刻变成假阴性（真实事故见 `intake.test.ts` 的注释）。
 */
const SUFFIX = uniqueSuffix()
const PHONE_TAIL = String(1000 + (Number.parseInt(hex64(`intake-docx-${SUFFIX}`).slice(0, 6), 16) % 9000))
const PHONE_RAW = `138 0000 ${PHONE_TAIL}`
const EMAIL_RAW = `docx.example.${SUFFIX}@example.invalid`

/** 用 python-docx 造一份合成简历 DOCX（全假数据）。 */
const MAKE_DOCX = String.raw`
import sys
from docx import Document
doc = Document()
for line in [
    "SYNTHETIC SAMPLE - NOT A REAL RESUME",
    "Candidate Example Docx",
    "Phone: ${PHONE_RAW}   Email: ${EMAIL_RAW}",
    "Work experience",
    "2021.07 - 2024.06  Example Technology Ltd  Backend Engineer",
    "Education",
    "2015.09 - 2019.06  Example University  Computer Science  BSc",
]:
    doc.add_paragraph(line)
doc.save(sys.argv[1])
print("ok")
`

/** 用 PyMuPDF 造一份带文本层的合成简历 PDF（全假数据）。 */
const MAKE_PDF = String.raw`
import sys
import fitz
doc = fitz.open()
page = doc.new_page(width=595, height=842)
lines = [
    ("SYNTHETIC SAMPLE - NOT A REAL RESUME", 11.0),
    ("Candidate Example Pdf", 15.0),
    ("Phone: ${PHONE_RAW}   Email: ${EMAIL_RAW}", 11.5),
    ("Work experience", 13.0),
    ("2021.07 - 2024.06  Example Technology Ltd  Backend Engineer", 11.5),
    ("Education", 13.0),
    ("2015.09 - 2019.06  Example University  Computer Science  BSc", 11.5),
]
y = 70.0
for text, size in lines:
    page.insert_text((50, y), text, fontsize=size, fontname="helv")
    y += size * 1.8 + 2.0
doc.save(sys.argv[1], deflate=True, garbage=4)
doc.close()
print("ok")
`

/** 惰性生成合成材料（只造一次，多个用例共用）。 */
let docxPath: string | null = null
let pdfPath: string | null = null

function synthetic(kind: 'docx' | 'pdf'): string {
  if (kind === 'docx') {
    if (docxPath === null) {
      docxPath = join(WORK_DIR, 'synthetic-resume.docx')
      execFileSync(PYTHON, ['-c', MAKE_DOCX, docxPath], { encoding: 'utf8', timeout: 120_000 })
    }
    return docxPath
  }
  if (pdfPath === null) {
    pdfPath = join(WORK_DIR, 'synthetic-resume.pdf')
    execFileSync(PYTHON, ['-c', MAKE_PDF, pdfPath], { encoding: 'utf8', timeout: 120_000 })
  }
  return pdfPath
}

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): { code?: string; reason_code?: string; message?: string } {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as { code?: string; reason_code?: string; message?: string }
}

/** 文件字节的 sha256（测试自己算，不采信 converter 自报）。 */
function material_sha_of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** intake 会写的六张表的当前行数（用于"拒绝时一行不写"）。 */
async function rowCounts(): Promise<number[]> {
  const tables = [
    'recruitment.candidate',
    'recruitment.application',
    'recruitment.resume',
    'recruitment.resume_version',
    'recruitment.intake_record',
    'recruitment.intake_asset',
  ]
  const out: number[] = []
  for (const table of tables) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*) as n from ${table} where tenant_id = $1`,
      [dbCfg.tenant_id],
    )
    out.push(Number(rows[0]?.n ?? '0'))
  }
  return out
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

test('DOCX：媒体类型按内容嗅探（不是扩展名），converter 抽到 native_text 的 phone/email', { skip: SKIP_PYTHON }, async () => {
  const docx = synthetic('docx')

  const source = await resolveIntakeSource(docx, cfg)
  assert.equal(source.media_type, MEDIA_DOCX, 'DOCX 文件必须被嗅探成 DOCX，而不是被扩展名规则拒掉')

  // 扩展名不参与判定：同一份 DOCX 改成 .pdf 的后缀，仍然按**内容**读成 DOCX。
  const renamed = join(WORK_DIR, 'docx-renamed-to-pdf.pdf')
  copyFileSync(docx, renamed)
  const renamedSource = await resolveIntakeSource(renamed, cfg)
  assert.equal(renamedSource.media_type, MEDIA_DOCX, '扩展名与内容不符时必须按内容判，不按扩展名')

  // converter 对 DOCX 走的是同一条 CLI（MuPDF 的 OOXML 通道），字段口径与 PDF 一致。
  const output = await runConverter(cfg, source.real_path)
  const material = buildMaterial(source.real_path, output, source.media_type)

  assert.equal(material.mime_type, MEDIA_DOCX, 'intake_asset.mime_type 必须记嗅探到的真实媒体类型')
  assert.ok(material.strong.some((id) => id.field === 'phone'), 'DOCX 的 phone 必须是可自动的强标识')
  assert.ok(material.strong.some((id) => id.field === 'email'), 'DOCX 的 email 必须是可自动的强标识')
  for (const id of material.strong) {
    assert.equal(id.provenance, 'native_text', '只有 native_text 才允许进入 strong')
  }
  assert.equal(material.output.meta?.source_sha256, material.sha256, '材料 sha 必须是原件的 sha（内容寻址）')
})

test('DOCX：走真实写入路径 → CREATED + application_id（回滚，不污染 ra_s6s7）', { skip: SKIP_PYTHON }, async () => {
  const docx = synthetic('docx')
  const source = await resolveIntakeSource(docx, cfg)
  const output = await runConverter(cfg, source.real_path)
  const material = buildMaterial(source.real_path, output, source.media_type)

  await inRolledBackTx(pool, async (client) => {
    const value = await intakeInTransaction(client, dbCfg, material, DEMO_JOB)
    assert.equal(value.status, 'OK')
    assert.equal(value.application_action, 'CREATED')
    assert.equal(value.resume_version_action, 'APPENDED')
    assert.match(value.application_id, UUID_RE, 'application_id 必须是真实 uuid')
    assert.match(value.candidate_id, UUID_RE)
    assert.equal(value.application.stage_code, 'S6')
    assert.equal(value.identity.strong_ids.includes('phone'), true)
    assert.equal(value.identity.identity_merge_eligible.includes('phone'), true)
    // 身份闸门没放宽：DOCX 的强标识必须仍是 native_text 来源。
    assert.equal(value.identity.weak_fields.length, 0, 'native_text 的 phone/email 不该同时出现在 weak 里')

    // 落库证据：媒体类型与解析器名字都得是真话。
    const { rows } = await client.query<{ mime_type: string; parser_name: string }>(
      `select a.mime_type, rv.parser_name
         from recruitment.intake_asset a
         join recruitment.resume r on r.intake_asset_id = a.id
         join recruitment.resume_version rv on rv.resume_id = r.id
        where a.tenant_id = $1 and a.sha256 = $2`,
      [dbCfg.tenant_id, material.sha256],
    )
    assert.equal(rows.length, 1, 'DOCX 材料必须落一条 intake_asset + resume_version')
    assert.equal(rows[0]?.mime_type, MEDIA_DOCX, 'DOCX 材料的 mime_type 不能写成 application/pdf')
    assert.equal(rows[0]?.parser_name, 'pymupdf', 'parser_name 记录的是真实读取后端')
  })
})

test('PDF 不回归：合成 PDF 仍然 CREATED，mime_type 仍是 application/pdf', { skip: SKIP_PYTHON }, async () => {
  const pdf = synthetic('pdf')
  const source = await resolveIntakeSource(pdf, cfg)
  assert.equal(source.media_type, MEDIA_PDF)

  const output = await runConverter(cfg, source.real_path)
  const material = buildMaterial(source.real_path, output, source.media_type)
  assert.equal(material.mime_type, MEDIA_PDF)
  assert.ok(material.strong.some((id) => id.field === 'phone'))

  await inRolledBackTx(pool, async (client) => {
    const value = await intakeInTransaction(client, dbCfg, material, DEMO_JOB)
    assert.equal(value.application_action, 'CREATED')
    assert.match(value.application_id, UUID_RE)
    const { rows } = await client.query<{ mime_type: string }>(
      'select mime_type from recruitment.intake_asset where tenant_id = $1 and sha256 = $2',
      [dbCfg.tenant_id, material.sha256],
    )
    assert.equal(rows[0]?.mime_type, MEDIA_PDF)
  })
})

test('真实入口不再按扩展名拒绝：DOCX + 不存在的岗位 → NOT_FOUND(JOB_NOT_FOUND)，不是 PATH_INVALID', { skip: SKIP_PYTHON }, async () => {
  const docx = synthetic('docx')
  const tool = createApplicationIntakeTool({ converter: cfg, database: dbCfg })
  // 岗位不存在 → 在事务里第一步就 NOT_FOUND 回滚，因此**一行不写**。
  const before = await rowCounts()
  const missingJob = '11111111-1111-4111-8111-0000000004ff'
  await assert.rejects(
    () => tool.execute({ path: docx, job_id: missingJob }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'NOT_FOUND', `应当已经过了路径/格式闸门：${JSON.stringify(body)}`)
      assert.equal(body.reason_code, 'JOB_NOT_FOUND')
      return true
    },
  )
  assert.deepEqual(await rowCounts(), before, '岗位不存在时不得写入任何一行')
})

test('图片被明确拒绝：READER_FAILED(IMAGE_REQUIRES_VISION)，且一行不写', async () => {
  const png = join(WORK_DIR, 'resume-photo.png')
  // 1x1 透明 PNG（合法 PNG，内容嗅探会认成 image/png）。
  writeFileSync(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  ))
  const tool = createApplicationIntakeTool({ converter: cfg, database: dbCfg })
  const before = await rowCounts()
  await assert.rejects(
    () => tool.execute({ path: png, job_id: DEMO_JOB }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'READER_FAILED')
      assert.equal(body.reason_code, 'IMAGE_REQUIRES_VISION', JSON.stringify(body))
      assert.notEqual(body.reason_code, 'PATH_INVALID', '图片不是"路径错了"，是"媒体类型 S6 接不了"')
      return true
    },
  )
  assert.deepEqual(await rowCounts(), before, '被拒绝的图片不得写入任何一行')
})

test('RTF 进入 S6 读取路径（不再是 UNSUPPORTED_MEDIA），身份闸门按"缺坐标证据"正确 BLOCKED', { skip: SKIP_PYTHON }, async () => {
  // 合成 RTF：正文含假 phone/email（R7）。converter 的 striprtf reader 会把它读成
  // native_text 字段，但 RTF 没有 bbox → IR-G1 的"证据坐标齐全"不成立 → 只能人工。
  const rtf = join(WORK_DIR, 'synthetic-resume.rtf')
  writeFileSync(rtf, [
    '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fnil Arial;}}\\f0',
    `\\pard SYNTHETIC SAMPLE - NOT A REAL RESUME\\par`,
    `\\pard Phone: ${PHONE_RAW}   Email: ${EMAIL_RAW}\\par`,
    `\\pard Work experience\\par`,
    '\\pard 2021.07 - 2024.06  Example Technology Ltd  Backend Engineer\\par}',
  ].join(''), 'utf8')

  // 1) 入口判定：按内容嗅探成 RTF，不再被"不是 .pdf"拒掉。
  const source = await resolveIntakeSource(rtf, cfg)
  assert.equal(source.media_type, MEDIA_RTF, 'RTF 必须被嗅探成 application/rtf，而不是被格式闸门拒掉')

  // 2) converter 真的读了：backend 是 striprtf，字段是 native_text（不是 OCR/模型）。
  const output = await runConverter(cfg, source.real_path)
  assert.match(String(output.meta?.backend), /^striprtf\//, 'RTF 的读取后端必须如实写 striprtf')
  assert.equal(output.meta?.source_sha256, material_sha_of(rtf), 'sha 必须是原件的 sha（内容寻址）')
  assert.equal(output.fields?.phone?.state, 'present')
  assert.equal(output.fields?.phone?.provenance, 'native_text')
  assert.equal(output.fields?.email?.provenance, 'native_text')

  // 3) 身份闸门：读出来了，但 RTF 没有 bbox 坐标 → evidence_missing → 不得自动并人。
  //    **这条是有意保留的 fail-closed**，不是格式缺口复发；放宽它需要改 IR-G1（不在本 lane 权限内）。
  const material = buildMaterial(source.real_path, output, source.media_type)
  assert.equal(material.mime_type, MEDIA_RTF)
  assert.deepEqual(material.strong, [], '缺坐标证据时 strong 必须为空：不许拿"读出来了"当"可自动认人"')
  assert.ok(
    material.blocked.some((item) => item.field === 'phone' && item.reason === 'evidence_missing'),
    `phone 的拒绝原因必须可机检：${JSON.stringify(material.blocked)}`,
  )

  // 4) 真实入口：BLOCKED_BY_REVIEW（不是 READER_FAILED / UNSUPPORTED_MEDIA / PATH_INVALID），一行不写。
  const tool = createApplicationIntakeTool({ converter: cfg, database: dbCfg })
  const before = await rowCounts()
  await assert.rejects(
    () => tool.execute({ path: rtf, job_id: DEMO_JOB }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'BLOCKED_BY_REVIEW', JSON.stringify(body))
      assert.equal(body.reason_code, 'MATERIAL_ATTRIBUTION_UNKNOWN', JSON.stringify(body))
      assert.notEqual(body.reason_code, 'UNSUPPORTED_MEDIA')
      assert.notEqual(body.reason_code, 'PATH_INVALID')
      return true
    },
  )
  assert.deepEqual(await rowCounts(), before, '身份闸门拒收的 RTF 不得写入任何一行')
})

test('旧 OLE（.doc）仍然被明确拒绝：READER_FAILED(UNSUPPORTED_MEDIA)——没有 reader 就不假装有', async () => {
  const doc = join(WORK_DIR, 'legacy.doc')
  // OLE 容器魔数 + 垃圾体：内容嗅探必须认成旧二进制 Office 并拒绝。
  writeFileSync(doc, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x01]))
  const tool = createApplicationIntakeTool({ converter: cfg, database: dbCfg })
  const before = await rowCounts()
  await assert.rejects(
    () => tool.execute({ path: doc, job_id: DEMO_JOB }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'READER_FAILED', JSON.stringify(body))
      assert.equal(body.reason_code, 'UNSUPPORTED_MEDIA', JSON.stringify(body))
      assert.notEqual(body.reason_code, 'PATH_INVALID')
      return true
    },
  )
  assert.deepEqual(await rowCounts(), before, '被拒绝的旧 OLE 不得写入任何一行')
})

test('未知字节仍然被拒绝（放宽格式 ≠ 什么都收）', async () => {
  const junk = join(WORK_DIR, 'not-a-document.bin')
  writeFileSync(junk, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09]))
  const tool = createApplicationIntakeTool({ converter: cfg, database: dbCfg })
  const before = await rowCounts()
  await assert.rejects(
    () => tool.execute({ path: junk, job_id: DEMO_JOB }),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'READER_FAILED')
      assert.equal(body.reason_code, 'UNSUPPORTED_MEDIA')
      return true
    },
  )
  assert.deepEqual(await rowCounts(), before)
})

test('身份闸门没因放宽格式而放宽：DOCX 材料里 ocr / agent_read 的 phone 只能进 weak', () => {
  // 手工构造一份"DOCX 材料"：格式允许，但来源不是原生文本 —— 这条路径必须仍然被挡。
  const evidence = [{ page: 1, bbox: [72, 100, 500, 120], block: 1, text: '联系方式' }]
  const output = {
    text: '示例正文',
    chars: 20,
    completeness: 'complete',
    issues: [],
    fields: {
      phone: { state: 'present', value: '138 0000 1234', provenance: 'ocr', evidence },
      email: { state: 'present', value: 'ocr.example@example.invalid', provenance: 'agent_read', evidence },
    },
    screening: { eligible_fields: ['phone', 'email'], identity_merge_eligible: ['phone', 'email'] },
    meta: { pages: 1, source_sha256: hex64('docx-ocr-gate'), backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  } as unknown as ConverterOutput

  const fakeDocx = join(WORK_DIR, 'fake-docx.docx')
  writeFileSync(fakeDocx, 'PK\u0003\u0004 synthetic placeholder (never parsed; only stat()ed)')
  const material = buildMaterial(fakeDocx, output, MEDIA_DOCX)
  assert.equal(material.mime_type, MEDIA_DOCX)
  assert.deepEqual(material.strong, [], 'OCR / agent_read 来源不得进入 strong（与 PDF 同一口径）')
  assert.ok(material.weak?.some((id) => id.field === 'phone' && id.provenance === 'ocr'), '只能进 weak 提示')
  assert.ok(material.weak?.some((id) => id.field === 'email' && id.provenance === 'agent_read'))
})
