// U3 接线测试（R2 接线铁律 / D-99）：工具入口 → plan() → executePlan() → 输出执行记录。
//
// 背景：`executePlan()` 实现完整、20 条单测全绿，但 `src/tools/**` 里**没有任何调用点**
// —— 只被单测调用 = R2 的 BLOCKED，不是交付。本文件证明它真的挂在
// `recruitment_document_read` 的执行路径上：
//   * 工具 execute() 真会调用执行器（re-read 发生、recovery.execution 有真实记录）；
//   * 成功判据三条同时成立才采纳：blocking 下降、无新增 HARD code、step.codes 消失；
//   * 不可执行时是 blocked（READER_FACTS_REQUIRED），能力一次都不调用（不跑空转）；
//   * human_review 永不自动执行，只留在 remaining；vision_read 不由本工具执行（D-81），
//     1-based 页号原样交给 agent，图像帧不伪造页码；
//   * 输出 schema 只用 DSH 官方子集（无 type 数组 / null），输出值无 null。
//
// 边界：只替换 **U1 的读取器**（U1 有自己的 readers 测试），被测的是 U3 接线本身；
// 执行器、assess、plan 都是真实代码，没有 mock。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { createDocumentReadTool } from '../../src/tools/document-read.ts'
import type { DocumentReadDeps } from '../../src/tools/document-read.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { DocumentBlock, DocumentContent, DocumentIssue } from '../../src/document/contracts/index.ts'
import type { DocumentReadOutcome } from '../../src/document/readers/index.ts'
import { CONVERTER_DIR, ensureFixtures, fixturePath } from './fixtures.ts'

const SHA = 'a'.repeat(64)
const FILE_PATH = join(tmpdir(), 'synthetic-recovery.pdf')

/** 一页干净的原生文字块：字符保真、页覆盖、来源都过（和 recovery-execute 的干净样本同形）。 */
function cleanBlocks(): DocumentBlock[] {
  return [
    {
      block_id: 'b1',
      kind: 'paragraph',
      text: '张三',
      order: 0,
      locator: { kind: 'pdf', page: 1, bbox: [50, 60, 120, 80] },
      provenance: 'native_text',
    },
    {
      block_id: 'b2',
      kind: 'paragraph',
      text: 'Example Technology Ltd 2021.07 - 2024.06 后端工程师',
      order: 1,
      locator: { kind: 'pdf', page: 1, bbox: [50, 160, 400, 180] },
      provenance: 'native_text',
    },
  ]
}

/** 造一份 canonical DocumentContent（默认一页合格 PDF）。 */
function doc(overrides: Partial<DocumentContent> = {}): DocumentContent {
  const blocks: readonly DocumentBlock[] = overrides.blocks ?? cleanBlocks()
  return {
    schema_version: '1.0.0',
    asset_sha256: SHA,
    media_type: 'application/pdf',
    reader_id: 'pdf:synthetic/1.0',
    reader_version: '1.0',
    text: blocks.map((block) => block.text).join('\n\n'),
    blocks,
    completeness: 'complete',
    needs_visual: false,
    issues: [],
    elapsed_ms: 8,
    ...overrides,
  }
}

/** 造一条上游 issue（severity 由稳定表重新映射，这里只给 code/message/定位）。 */
function issue(code: string, message: string, locator?: DocumentIssue['locator']): DocumentIssue {
  const base: DocumentIssue = {
    code,
    message,
    severity: 'HARD',
    retryable: false,
    suggested_action: 'none',
  }
  return locator === undefined ? base : { ...base, locator }
}

/** 首读：正文在，但读取器报了 retry 类 HARD（计划里会出现 retry 步）。 */
function timedOut(): DocumentContent {
  return doc({
    completeness: 'partial',
    issues: [issue('reader_timeout', '读取超时，没有产生可信正文')],
  })
}

/** 一次读取结果：content + 读取器旁路证据（页数/顺序声明）。 */
function outcome(
  content: DocumentContent,
  sourceMeta: Readonly<Record<string, unknown>>,
): DocumentReadOutcome {
  return { content, source_meta: sourceMeta }
}

/** converter 旁路证据的形状（和 readerFactsFromSourceMeta 接受的一致）。 */
function meta(pages: number | null, orderVerified: boolean): Readonly<Record<string, unknown>> {
  return {
    converter_meta: {
      ...(pages === null ? {} : { pages }),
      order_verified: orderVerified,
    },
  }
}

/** 读取器被注入，python_bin / converter_dir 只满足形状要求，不会被真的执行。 */
function fakeCfg(): ResolvedConverterConfig {
  return {
    python_bin: process.execPath,
    converter_dir: tmpdir(),
    allowed_roots: [tmpdir()],
    timeout_ms: 5_000,
  }
}

interface Harness {
  readonly tool: ReturnType<typeof createDocumentReadTool>
  /** 真实 Reader 被调用了几次（首读 + 每次执行器重读）。 */
  readonly calls: () => number
}

/**
 * 造一台「按顺序返回预置读取结果」的工具：第一次是首读，之后每次是执行器的重读。
 * 读取用完后重复最后一个，避免测试因次数断言失败时抛 `undefined`。
 */
function makeTool(outcomes: readonly DocumentReadOutcome[]): Harness {
  let calls = 0
  const read = async (): Promise<DocumentReadOutcome> => {
    const index = Math.min(calls, outcomes.length - 1)
    calls += 1
    return outcomes[index] as DocumentReadOutcome
  }
  const deps: DocumentReadDeps = { read }
  return { tool: createDocumentReadTool(fakeCfg(), deps), calls: () => calls }
}

/** 输出里与本文件相关的形状（其余键不参与断言）。 */
interface Value {
  readonly text: string
  readonly reader_id: string
  readonly page_count: number
  readonly assessment: {
    readonly blocking: boolean
    readonly blocking_codes: readonly string[]
  }
  readonly recovery: {
    readonly blocking: boolean
    readonly next: string
    readonly vision_pages: readonly number[]
    readonly steps: ReadonlyArray<{
      readonly step_id: string
      readonly action: string
      readonly role: string
      readonly status: string
      readonly codes: readonly string[]
      readonly problem: string
    }>
    readonly execution: {
      readonly executed: number
      readonly succeeded: number
      readonly failed: number
      readonly blocked: number
      readonly skipped_reason: string
      readonly content_updated: boolean
      readonly steps: ReadonlyArray<{
        readonly step_id: string
        readonly action: string
        readonly status: string
        readonly codes: readonly string[]
        readonly reason: string
        readonly blocked_reason: string
        readonly before_blocking: boolean
        readonly before_hard: number
        readonly has_after: boolean
        readonly after_blocking: boolean
        readonly after_hard: number
      }>
    }
  }
}

/** 从工具入口调用一次并取回规范输出值。 */
async function call(tool: Harness['tool']): Promise<Value> {
  return await tool.execute({ path: FILE_PATH }) as Value
}

// ---------------------------------------------------------------------------
// 1. 从工具入口真的调用执行器，且成功判据三条同时成立
// ---------------------------------------------------------------------------

test('工具入口调用 executePlan：retry 成功 → 阻断下降、无新增 HARD、step.codes 消失，内容被采纳', async () => {
  const reread = doc()
  const harness = makeTool([outcome(timedOut(), meta(1, true)), outcome(reread, meta(1, true))])
  const value = await call(harness.tool)

  // 首读 1 次 + 执行器 reRead 1 次：这是「工具入口真的会调用执行器」的直接证据。
  assert.equal(harness.calls(), 2, 'retry 步必须真的触发一次重读（读取器被调用两次）')

  const execution = value.recovery.execution
  assert.equal(execution.executed, 1)
  assert.equal(execution.succeeded, 1)
  assert.equal(execution.failed, 0)
  assert.equal(execution.blocked, 0)
  assert.equal(execution.skipped_reason, '')
  assert.equal(execution.content_updated, true)

  const step = execution.steps[0]
  assert.ok(step !== undefined)
  assert.equal(step.action, 'retry')
  assert.equal(step.status, 'succeeded')
  assert.deepEqual(step.codes, ['reader_timeout'], '执行记录要能看出这一步的目标 code')
  // 成功判据 (a)：blocking 由 true 变 false，HARD 条目数真的下降。
  assert.equal(step.before_blocking, true)
  assert.equal(step.before_hard, 1)
  assert.equal(step.has_after, true)
  assert.equal(step.after_blocking, false)
  assert.equal(step.after_hard, 0)
  assert.match(step.reason, /三条判据同时成立/u)

  // (b) 无新增 HARD code + (c) 目标 code 消失：执行后的判定里不该再有 reader_timeout。
  assert.equal(value.assessment.blocking, false)
  assert.equal(value.assessment.blocking_codes.includes('reader_timeout'), false)
  // 执行后 remaining 是空计划，下一步可以进入结构化。
  assert.equal(value.recovery.blocking, false)
  assert.equal(value.recovery.next, 'structure')
  assert.deepEqual(value.recovery.steps, [])
  // 采纳的是重读内容：工具返回的正文/读取器以新内容为准。
  assert.equal(value.text, reread.text)
  assert.equal(value.reader_id, reread.reader_id)
})

// ---------------------------------------------------------------------------
// 2. 成功判据不成立就不采纳（禁止「换一种病」）
// ---------------------------------------------------------------------------

test('工具入口调用 executePlan：重读后出现旧内容没有的 HARD code → failed，不采纳、remaining 保留 retry', async () => {
  const initial = doc({
    completeness: 'partial',
    issues: [
      issue('reader_timeout', '读取超时，没有产生可信正文'),
      issue('encrypted_pdf', 'PDF 需要密码才能打开'),
    ],
  })
  // 2 条 HARD → 1 条 HARD（数量降了、reader_timeout 这个目标也消失了），
  // 但换成了一条旧内容没有的 HARD code —— 判据 (b) 不成立。
  const swapped = doc({
    completeness: 'partial',
    issues: [issue('doc_block_missing', '有一页的块在输出里消失了')],
  })
  const harness = makeTool([outcome(initial, meta(1, true)), outcome(swapped, meta(1, true))])
  const value = await call(harness.tool)

  assert.equal(harness.calls(), 2)
  const step = value.recovery.execution.steps[0]
  assert.ok(step !== undefined)
  assert.equal(step.status, 'failed')
  assert.match(step.reason, /旧内容没有的 HARD code/u)
  assert.match(step.reason, /doc_block_missing/u)
  assert.equal(step.has_after, true, '必须有重判快照才能审计「为什么不采纳」')
  assert.equal(step.after_hard, 1)

  // 失败的输出不得被采纳；原内容与剩余计划原样返回。
  assert.equal(value.recovery.execution.content_updated, false)
  assert.equal(value.text, initial.text)
  assert.equal(value.recovery.blocking, true)
  assert.ok(value.recovery.steps.some((candidate) => candidate.action === 'retry'), 'retry 步必须留在 remaining')
})

// ---------------------------------------------------------------------------
// 3. 不可执行时的 blocked 分支（READER_FACTS_REQUIRED）
// ---------------------------------------------------------------------------

test('工具入口：PDF 首读没有页数证据 → 执行前判 blocked（READER_FACTS_REQUIRED），一次真实重读都不发起', async () => {
  // source_meta 里没有 converter 的 pages —— 重读结果无法核对页覆盖，执行器铁律 ⑤。
  const harness = makeTool([outcome(timedOut(), {})])
  const value = await call(harness.tool)

  assert.equal(harness.calls(), 1, '缺页数证据时不得白跑一次真实重读')
  const execution = value.recovery.execution
  assert.equal(execution.executed, 1)
  assert.equal(execution.blocked, 1)
  assert.equal(execution.succeeded, 0)
  assert.equal(execution.content_updated, false)

  const step = execution.steps[0]
  assert.ok(step !== undefined)
  assert.equal(step.action, 'retry')
  assert.equal(step.status, 'blocked')
  assert.equal(step.blocked_reason, 'READER_FACTS_REQUIRED')
  assert.equal(step.has_after, false)
  assert.equal(step.before_blocking, true)
  assert.ok(value.recovery.steps.some((candidate) => candidate.action === 'retry'))
  assert.equal(value.recovery.blocking, true)
})

// ---------------------------------------------------------------------------
// 3b. switch_reader 没有候选实现：如实 failed，不假装换过读取器、也不偷偷重读
// ---------------------------------------------------------------------------

test('工具入口：switch_reader 没有可切换的读取器 → 如实 failed，不回退成一次重读', async () => {
  const noReader = doc({
    completeness: 'partial',
    issues: [issue('no_reader', '没有可用的读取器处理该媒体类型')],
  })
  const harness = makeTool([outcome(noReader, meta(1, true))])
  const value = await call(harness.tool)

  assert.equal(harness.calls(), 1, 'switch_reader 不得被偷偷实现成「再读一遍同一路径」')
  const execution = value.recovery.execution
  assert.equal(execution.executed, 1)
  assert.equal(execution.failed, 1)
  assert.equal(execution.content_updated, false)
  const step = execution.steps[0]
  assert.ok(step !== undefined)
  assert.equal(step.action, 'switch_reader')
  assert.equal(step.status, 'failed')
  assert.match(step.reason, /没有可切换的读取器/u)
  assert.ok(
    value.recovery.steps.some((candidate) => candidate.action === 'switch_reader'),
    'switch_reader 步必须留在 remaining（换 reader 是读取器注册表的事）',
  )
})

// ---------------------------------------------------------------------------
// 4. human_review 永不自动执行（D-79/D-95）
// ---------------------------------------------------------------------------

test('工具入口：人工步永远不自动执行，只留在 remaining；自动步成功也不替人回答', async () => {
  const initial = doc({
    completeness: 'partial',
    issues: [
      issue('reader_timeout', '读取超时，没有产生可信正文'),
      issue('encrypted_pdf', 'PDF 需要密码才能打开'),
    ],
  })
  // 2 条 HARD → 1 条：目标 reader_timeout 消失、encrypted_pdf 是旧 code，三条判据都成立。
  const stillHuman = doc({
    completeness: 'partial',
    issues: [issue('encrypted_pdf', 'PDF 需要密码才能打开')],
  })
  const harness = makeTool([outcome(initial, meta(1, true)), outcome(stillHuman, meta(1, true))])
  const value = await call(harness.tool)

  const execution = value.recovery.execution
  assert.equal(execution.executed, 1)
  assert.equal(execution.steps[0]?.action, 'retry')
  assert.equal(execution.steps[0]?.status, 'succeeded')
  assert.equal(execution.content_updated, true)

  // 人工步一步都没被执行，但原样留在执行后的计划里，等上层闸门发起。
  assert.equal(execution.steps.some((step) => step.action === 'human_review'), false)
  assert.equal(value.recovery.next, 'human')
  assert.equal(value.recovery.blocking, true)
  const humanSteps = value.recovery.steps.filter((step) => step.action === 'human_review')
  assert.equal(humanSteps.length, 1)
  assert.equal(humanSteps[0]?.role, 'recruiter')
})

// ---------------------------------------------------------------------------
// 5. vision_read 不由本工具执行（D-81）：1-based 页号留给 agent，帧号不伪造页码
// ---------------------------------------------------------------------------

test('工具入口：vision_read 不可执行 → 不调用能力、不伪造成功，1-based 页号留在 remaining', async () => {
  const scanned = doc({
    completeness: 'partial',
    issues: [issue('unread_visual_page', '低文本页含图形，视觉内容未读取', { kind: 'pdf', page: 1 })],
  })
  const harness = makeTool([outcome(scanned, meta(1, true))])
  const value = await call(harness.tool)

  assert.equal(harness.calls(), 1, 'vision 步没有可注入的能力，不得因此多读一次')
  assert.equal(value.recovery.execution.executed, 0)
  assert.equal(value.recovery.execution.succeeded, 0)
  assert.deepEqual(value.recovery.vision_pages, [1], '补读页号必须是真实的 1-based 页码')
  assert.ok(
    value.recovery.steps.some((step) => step.action === 'vision_read'),
    'vision_read 步必须原样留在 remaining，等 agent 用 page_image + read_image 接手',
  )
  assert.equal(value.recovery.blocking, true)
})

test('工具入口：图像帧补读不伪造页码 —— 没有页号就不交给 visionRead', async () => {
  const image = doc({
    media_type: 'image/png',
    reader_id: 'image:synthetic/1.0',
    text: 'RESUME IMAGE',
    needs_visual: true,
    blocks: [
      {
        block_id: 'i1',
        kind: 'paragraph',
        text: 'RESUME IMAGE',
        order: 0,
        locator: { kind: 'image', frame: 0 },
        provenance: 'ocr',
      },
    ],
    completeness: 'partial',
    issues: [issue('unread_visual_page', '图像里的字没有被读过', { kind: 'image', frame: 0 })],
  })
  const harness = makeTool([outcome(image, {})])
  const value = await call(harness.tool)

  assert.equal(harness.calls(), 1)
  assert.equal(value.recovery.execution.executed, 0, '帧号不是页码，不得谎报成一次视觉补读')
  assert.deepEqual(value.recovery.vision_pages, [], '帧补读没有可表达的 1-based 页码')
  assert.ok(value.recovery.steps.some((step) => step.action === 'vision_read'))
})

// ---------------------------------------------------------------------------
// 6. 页数来自读取器声明（converter_meta.pages），补读页集合按它枚举
// ---------------------------------------------------------------------------

test('工具入口：PDF 没文字层时按 converter_meta.pages 枚举补读页（不靠块页号倒推）', async () => {
  // 扫描件：没有任何带页号的块；页数只能来自读取器旁路证据（converter_meta.pages）。
  const scanned = doc({
    text: '',
    blocks: [],
    completeness: 'partial',
    issues: [issue('pdf_no_text', 'PDF 没有可机读文本层（扫描件/图像型）')],
  })
  const harness = makeTool([outcome(scanned, meta(2, false))])
  const value = await call(harness.tool)

  assert.equal(value.page_count, 2, '页数必须读 converter_meta.pages（否则扫描件会显示 0 页）')
  assert.deepEqual(value.recovery.vision_pages, [1, 2], '补读页集合按声明的页数枚举，1-based')
  assert.equal(value.recovery.execution.executed, 0, 'vision_read 不由本工具执行')
})

// ---------------------------------------------------------------------------
// 7. 真实读取路径：不只是注入读，真实 converter 读出来的结果也走执行器
// ---------------------------------------------------------------------------

/** `python` 可能只是 PATH 上的名字；converter 配置要求绝对路径。 */
function absolutePython(bin: string): string {
  if (isAbsolute(bin)) return bin
  const probe = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const lines = execFileSync(probe, [bin], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
    if (lines[0] !== undefined) return lines[0]
  } catch {
    // 探不到就原样返回；下面真跑读取时会以 READER_FAILED 暴露出来。
  }
  return bin
}

test('工具入口（真实读取路径）：干净 PDF → executePlan 真的执行过（记录 NOT_BLOCKING）', async (t) => {
  let fixtures
  try {
    fixtures = ensureFixtures()
  } catch (error) {
    t.skip(`合成 fixture 生成器不可用：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const cfg: ResolvedConverterConfig = {
    python_bin: absolutePython(fixtures.python.bin),
    converter_dir: CONVERTER_DIR,
    allowed_roots: [fixtures.dir],
    timeout_ms: 180_000,
  }
  const tool = createDocumentReadTool(cfg)
  const value = await tool.execute({ path: fixturePath(fixtures, 'text_simple.pdf') }) as Value

  // text_simple.pdf 是自带文本层的干净合成件：初始判定不 blocking，
  // executePlan 会走「没有可证明的修复目标」分支 → skipped_reason=NOT_BLOCKING。
  // 这个字段只可能由执行器产生，所以它是「真实读取路径上也调用了执行器」的证据。
  assert.equal(value.assessment.blocking, false)
  assert.equal(value.recovery.execution.skipped_reason, 'NOT_BLOCKING')
  assert.equal(value.recovery.execution.executed, 0)
  assert.equal(value.recovery.execution.content_updated, false)
  assert.equal(value.page_count, 2, '页数来自 converter_meta.pages')
})

// ---------------------------------------------------------------------------
// 8. 输出契约：schema 只用官方子集，输出值无 null
// ---------------------------------------------------------------------------

/** 递归找 null。 */
function findNull(value: unknown, path = '$'): string | null {
  if (value === null) return path
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = findNull(value[index], `${path}[${index}]`)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = findNull(child, `${path}.${key}`)
      if (hit !== null) return hit
    }
  }
  return null
}

/** 递归检查 schema：不允许 type 数组、type:null；对象层必须有 required 且关闭 additionalProperties。 */
function schemaProblems(schema: unknown, path = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return []
  const record = schema as Record<string, unknown>
  const problems: string[] = []
  if (Array.isArray(record.type)) problems.push(`${path}.type 是数组（DSH 不支持）`)
  if (record.type === 'null') problems.push(`${path}.type 是 null（DSH 不支持）`)
  if (Array.isArray(record.enum) && record.enum.includes(null)) problems.push(`${path}.enum 含 null`)
  if (typeof record.properties === 'object' && record.properties !== null) {
    if (!Array.isArray(record.required)) problems.push(`${path} 缺 required`)
    if (record.additionalProperties !== false) problems.push(`${path}.additionalProperties 必须是 false`)
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
      problems.push(...schemaProblems(child, `${path}.${key}`))
    }
  }
  if (record.items !== undefined) problems.push(...schemaProblems(record.items, `${path}[]`))
  return problems
}

test('输出 schema 用 DSH 官方子集（无 type 数组 / null），且输出值里没有 null', async () => {
  const harness = makeTool([outcome(timedOut(), meta(1, true)), outcome(doc(), meta(1, true))])
  assert.deepEqual(schemaProblems(harness.tool.output.schema), [])

  const value = await call(harness.tool)
  assert.equal(findNull(value), null, `输出里出现了 null：${findNull(value)}`)
})
