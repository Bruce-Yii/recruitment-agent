// D-110 证据定位器**真 RTF 端到端**（不连库）：真实 converter 的 striprtf 读取 → 证据上下文
// → 身份闸门。
//
// 为什么必须用真转换、而不是手写 converter 输出：修复前的缺陷正是「S6 能读 RTF，却因
// converter 只给 `location.paragraph`（无 bbox）被 `toEvidence` 拒成 evidence_missing」。
// 只有真跑一次 `runConverter()`，才能证明「RTF 无 bbox」不再阻断身份闸门，且三条件
// （sha 独立重算 / 定位唯一 / quote 逐字命中）在真实 JSON 形状上成立。
//
// 夹具：ASCII 正文的合成 RTF（`os.tmpdir()` 现造），避开中文 cp936 编码坑——
// 若把 UTF-8 字节塞进声明 `\ansicpg936` 的 RTF，striprtf 会解出乱码（现场证据见
// `work/verify-2026-11-15-doc2/rtf-converter-raw.json`），那不是本测试要验证的东西。
// 全部假数据（Li Example / 13900001111 / example.test），不碰真实候选人（R7）。
//
// 依赖本机 Python + converter/：缺任一项时声明式 skip（本机可跑，skipped=0）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evidenceContextFromConverter } from '../../src/document/evidence/converter-adapter.ts'
import { sha256Hex } from '../../src/document/evidence/locator.ts'
import { observeIdentity } from '../../src/db/identity.ts'
import type { ConverterOutput, ResolvedConverterConfig } from '../../src/tools/converter.ts'
import { resolveConverterConfig, runConverter } from '../../src/tools/converter.ts'
import { CONVERTER_DIR, PYTHON_BIN } from '../helpers/paths.ts'

/** 去掉只读修饰：测试里要改 converter 输出做负例（只在内存副本上改）。 */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

const CAN_RUN_PYTHON = PYTHON_BIN !== undefined && existsSync(join(CONVERTER_DIR, 'src', 'cli.py'))
const SKIP_PYTHON = CAN_RUN_PYTHON
  ? false
  : `本机没有 python（${PYTHON_BIN ?? 'not found'}）或 converter/，无法跑真实 RTF 转换`

/** 每个用例现造的候选材料目录（只放本测试生成的合成文件）。 */
const WORK_DIR = mkdtempSync(join(tmpdir(), 'recruitment-evidence-locator-'))

const cfg = resolveConverterConfig({
  python_bin: PYTHON_BIN ?? 'python3',
  converter_dir: CONVERTER_DIR,
  allowed_roots: [WORK_DIR],
}).resolved as ResolvedConverterConfig

/** ASCII 正文的合成 RTF：六个 `\par` 段落，无硬分页（单页）。 */
const RTF_TEXT = [
  '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0\\fnil Arial;}}',
  '\\f0',
  '\\pard SYNTHETIC SAMPLE - NOT A REAL RESUME\\par',
  '\\pard Name: Li Example\\par',
  '\\pard Phone: 13900001111\\par',
  '\\pard Email: li.example@example.test\\par',
  '\\pard Work experience\\par',
  '\\pard 2020.07 - 2023.06  Example Technology Ltd  Backend Engineer\\par}',
].join('\n')

const RTF_PATH = join(WORK_DIR, 'synthetic-resume.rtf')
writeFileSync(RTF_PATH, RTF_TEXT, 'utf8')

/** 惰性单次真实转换（多个用例共用，避免重复起 Python）。 */
let fixturePromise: Promise<{ readonly output: ConverterOutput; readonly sha: string }> | null = null

function fixture(): Promise<{ readonly output: ConverterOutput; readonly sha: string }> {
  fixturePromise ??= (async () => {
    const output = await runConverter(cfg, RTF_PATH)
    const sha = createHash('sha256').update(readFileSync(RTF_PATH)).digest('hex')
    return { output, sha }
  })()
  return fixturePromise
}

/** 从 converter 输出里取身份字段 + 资格清单（真形状，不手搓）。 */
function identityInput(output: ConverterOutput) {
  return {
    fields: (output.fields ?? {}) as Readonly<Record<string, {
      state?: string
      value?: string | null
      provenance?: string
      reason?: string
      evidence?: readonly {
        page?: number
        bbox?: readonly number[]
        block?: number
        text?: string
        quote?: string
        paragraph?: number
      }[]
    }>>,
    eligible: output.screening?.identity_merge_eligible,
  }
}

test('RTF 正例：真实 converter → 证据上下文 → phone/email 进入 strong，证据带 rtf_paragraph + sha', { skip: SKIP_PYTHON }, async () => {
  const { output, sha } = await fixture()

  // 可复核锚点：converter 自报 sha 与本地独立重算必须一致（两次重算一致）。
  const sourceBytes = readFileSync(RTF_PATH)
  const localSha = sha256Hex(sourceBytes)
  console.log(`[A] RTF path = ${RTF_PATH}`)
  console.log(`[A] RTF bytes = ${sourceBytes.length}`)
  console.log(`[A] sha256(独立重算 #1) = ${localSha}`)
  console.log(`[A] sha256(独立重算 #2) = ${sha256Hex(readFileSync(RTF_PATH))}`)
  console.log(`[A] converter.meta.source_sha256 = ${String(output.meta?.source_sha256)}`)
  assert.equal(output.meta?.source_sha256, localSha, 'converter 自报 sha 必须等于本地重算（内容寻址）')
  assert.equal(localSha, sha)
  assert.equal(output.meta?.backend?.startsWith('striprtf/'), true, 'RTF 必须由 striprtf 真读')

  // 真实 converter 形状：块只有 page+paragraph，没有 bbox；phone/email 是 native_text。
  assert.ok(Array.isArray(output.blocks) && output.blocks.length >= 4)
  const blockSummary = (output.blocks ?? []).map((block, index) => {
    const location = (block.location ?? {}) as { page?: number; paragraph?: number; bbox?: unknown }
    return {
      index,
      kind: block.kind,
      page: location.page,
      paragraph: location.paragraph,
      has_bbox: Array.isArray(location.bbox),
      text: String(block.text ?? '').slice(0, 60),
    }
  })
  console.log(`[A] converter blocks 摘要 = ${JSON.stringify(blockSummary)}`)
  assert.equal(
    blockSummary.every((block) => block.has_bbox === false),
    true,
    'RTF block 不允许有 bbox（不伪造坐标）',
  )

  const contextResult = evidenceContextFromConverter(RTF_PATH, output, 'rtf')
  assert.equal(contextResult.ok, true, JSON.stringify(contextResult))
  if (contextResult.ok !== true) return
  const context = contextResult.context
  assert.equal(context.source_sha256, localSha)
  assert.equal(context.source_bytes.length, statSync(RTF_PATH).size)
  const contextLocators = context.blocks.map((block) => block.locator.kind)
  console.log(`[A] context block locator_kinds = ${JSON.stringify(contextLocators)}`)
  assert.deepEqual(
    [...new Set(contextLocators)],
    ['rtf_paragraph'],
    'RTF 的块定位器只能来自 paragraph（page 是附加字段）',
  )
  assert.deepEqual(context.blocks[2]?.locator, { kind: 'rtf_paragraph', paragraph: 2, page: 1 })

  const { fields, eligible } = identityInput(output)
  assert.equal(fields.phone?.state, 'present')
  assert.equal(fields.phone?.provenance, 'native_text')
  assert.equal(fields.email?.state, 'present')
  const observation = observeIdentity(fields, eligible, contextResult)
  console.log(`[A] observeIdentity.strong = ${JSON.stringify(observation.strong.map((item) => ({
    field: item.field,
    norm: item.norm,
    locator_kind: item.evidence[0]?.locator_kind,
    verification_method: item.evidence[0]?.verification_method,
    source_sha256: item.evidence[0]?.source_sha256,
    page: item.evidence[0]?.page,
    bbox: item.evidence[0]?.bbox,
  })))}`)
  console.log(`[A] observeIdentity.blocked = ${JSON.stringify(observation.blocked)}`)

  const phone = observation.strong.find((item) => item.field === 'phone')
  const email = observation.strong.find((item) => item.field === 'email')
  assert.ok(phone, `phone 必须进入 strong：${JSON.stringify(observation.blocked)}`)
  assert.ok(email, `email 必须进入 strong：${JSON.stringify(observation.blocked)}`)
  assert.equal(phone.norm, '+8613900001111')
  assert.equal(email.norm, 'li.example@example.test')

  const phoneEvidence = phone.evidence[0]
  assert.equal(phoneEvidence?.locator_kind, 'rtf_paragraph', 'RTF 证据必须标注 rtf_paragraph')
  assert.equal(
    phoneEvidence?.verification_method,
    'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE',
    'converter 给了块号 ⇒ 定位器唯一确定位置（不是 quote 反推）',
  )
  assert.equal(phoneEvidence?.source_sha256, localSha, '证据必须绑定源文件字节 sha256')
  assert.equal(phoneEvidence?.page, 1, 'RTF 单页时读取器真的给出 page=1')
  assert.deepEqual([...(phoneEvidence?.bbox ?? [])], [], 'RTF 无 bbox：空数组')
  assert.deepEqual(phoneEvidence?.locator, { kind: 'rtf_paragraph', paragraph: 2, page: 1 })

  // 核心断言：RTF 无 bbox **不是**拒绝原因（修复前是 evidence_missing）。
  assert.equal(
    observation.blocked.some((item) => item.reason === 'evidence_missing'),
    false,
    'RTF 不得因缺 bbox 被判 evidence_missing',
  )
  assert.equal(
    observation.blocked.some((item) => item.field === 'phone' || item.field === 'email'),
    false,
    'phone/email 都不得被 blocked',
  )
})

test('负例①：篡改 source_sha256 → phone 字段 blocked evidence_sha256_mismatch（fail-closed，不写不猜）', { skip: SKIP_PYTHON }, async () => {
  const { output } = await fixture()
  const tampered = structuredClone(output) as Mutable<ConverterOutput>
  tampered.meta = { ...(tampered.meta ?? {}), source_sha256: '0'.repeat(64) }

  const contextResult = evidenceContextFromConverter(RTF_PATH, tampered, 'rtf')
  assert.equal(contextResult.ok, true, 'shape 合法（64 hex）→ 上下文可构造；sha 真假由核验裁决')
  const { fields, eligible } = identityInput(tampered)
  const observation = observeIdentity(fields, eligible, contextResult)
  assert.deepEqual(observation.strong, [])
  const blocked = observation.blocked.find((item) => item.field === 'phone')
  assert.equal(blocked?.reason, 'evidence_sha256_mismatch')
  assert.equal(blocked?.detail?.reason_code, 'SHA256_MISMATCH')
  assert.equal(blocked?.detail?.requires_human, true)
  console.log(`[A] 负例① blocked = ${JSON.stringify(observation.blocked)}`)
})

test('负例②：源文件不存在 / 空文件 → 结构化拒绝，字段 blocked evidence_source_unavailable', { skip: SKIP_PYTHON }, async () => {
  const { output } = await fixture()
  const { fields, eligible } = identityInput(output)

  const missingPath = join(WORK_DIR, 'does-not-exist.rtf')
  const missingContext = evidenceContextFromConverter(missingPath, output, 'rtf')
  assert.equal(missingContext.ok, false)
  if (missingContext.ok === false) {
    assert.equal(missingContext.reason_code, 'SOURCE_UNREADABLE')
    assert.match(missingContext.message, /cannot read source bytes/)
  }
  const missingObservation = observeIdentity(fields, eligible, missingContext)
  assert.deepEqual(missingObservation.strong, [])
  const missingBlocked = missingObservation.blocked.find((item) => item.field === 'phone')
  assert.equal(missingBlocked?.reason, 'evidence_source_unavailable')
  assert.equal(missingBlocked?.detail?.reason_code, 'SOURCE_UNREADABLE')

  const emptyPath = join(WORK_DIR, 'empty.rtf')
  writeFileSync(emptyPath, '')
  const emptyContext = evidenceContextFromConverter(emptyPath, output, 'rtf')
  assert.equal(emptyContext.ok, false)
  if (emptyContext.ok === false) assert.equal(emptyContext.reason_code, 'SOURCE_EMPTY')
  const emptyObservation = observeIdentity(fields, eligible, emptyContext)
  assert.deepEqual(emptyObservation.strong, [])
  assert.equal(
    emptyObservation.blocked.find((item) => item.field === 'phone')?.reason,
    'evidence_source_unavailable',
  )
  console.log(`[A] 负例② missing=${JSON.stringify(missingContext)}`)
  console.log(`[A] 负例② empty=${JSON.stringify(emptyContext)}`)
  console.log(`[A] 负例② blocked = ${JSON.stringify(emptyObservation.blocked)}`)
})

test('负例③：同一 phone 出现在两个块且无块号 → QUOTE_AMBIGUOUS 转人工（禁止取第一条）', { skip: SKIP_PYTHON }, async () => {
  const { output } = await fixture()
  const fields = structuredClone(output.fields ?? {}) as Record<string, {
    state?: string
    value?: string | null
    provenance?: string
    evidence?: readonly Record<string, unknown>[]
  }>
  const phoneEntry = fields.phone
  assert.ok(phoneEntry !== undefined)
  // 去掉 block/page/bbox → 强制走 quote 全文唯一搜索路径。
  phoneEntry.evidence = [{ quote: '13900001111', text: '13900001111' }]

  // 造歧义：复制 phone 块到另一个段落序号（同一 quote 在两块出现两次）。
  const ambiguous = structuredClone(output) as Mutable<ConverterOutput>
  const blocks = [...(ambiguous.blocks ?? [])]
  const phoneBlock = blocks[2]
  assert.ok(phoneBlock !== undefined, '合成 RTF 的 phone 块必须存在')
  const duplicate = structuredClone(phoneBlock)
  duplicate.location = { page: 1, paragraph: 6 }
  blocks.push(duplicate)
  const ambiguousOutput: ConverterOutput = { ...ambiguous, blocks }
  assert.equal(ambiguousOutput.blocks?.length, (output.blocks?.length ?? 0) + 1)

  const contextResult = evidenceContextFromConverter(RTF_PATH, ambiguousOutput, 'rtf')
  assert.equal(contextResult.ok, true)
  const observation = observeIdentity(fields, output.screening?.identity_merge_eligible, contextResult)
  assert.equal(
    observation.strong.some((item) => item.field === 'phone'),
    false,
    '歧义不得自动通过（更不得取第一条）',
  )
  assert.deepEqual(
    observation.strong.map((item) => item.field),
    ['email'],
    'fail-closed 是**按字段**的：email 证据唯一，仍可自动（证明没有整单误伤）',
  )
  const blocked = observation.blocked.find((item) => item.field === 'phone')
  assert.equal(blocked?.reason, 'evidence_quote_ambiguous')
  const candidates = blocked?.detail?.candidates as readonly { index: number; locator_kind: string }[] | undefined
  assert.equal(candidates?.length, 2, 'detail 必须列出两个候选，供人工补第二定位')
  assert.deepEqual(candidates?.map((candidate) => candidate.index), [2, 6])
  assert.deepEqual(candidates?.map((candidate) => candidate.locator_kind), ['rtf_paragraph', 'rtf_paragraph'])
  console.log(`[A] 负例③ candidates = ${JSON.stringify(candidates)}`)
  console.log(`[A] 负例③ blocked = ${JSON.stringify(observation.blocked)}`)
})
