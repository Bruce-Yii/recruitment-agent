// 真实语料回归（docs/11 §11「真实语料回归」的唯一可执行入口）。
//
// 为什么单列：解析层此前的测试**全部**是合成 fixture，证明的是"规则按设计执行"，
// 不能证明"真实文件能读出来"。2026-11-14 第一次跑 52 份真实简历就暴露了合成 fixture
// 无一命中的问题（2 字节空占位 PDF 被旧消息报成"格式不支持"）。所以每次解析层改动，
// 都必须用真实语料抽样回归，见 docs/11 §11.2。
//
// 这个文件的五条纪律：
//   1. **不依赖语料存在**：语料目录不存在 / 里面没有可读文档 / 本机没有 Python 时
//      `test.skip`，并在 skip 原因里写清缺什么。跳过不是通过（E2 三数口径）。
//   2. **门槛判定只认全量**（总控 2026-11-14 裁决）：R-1/R-2/R-3 是否达标只有覆盖全部文档
//      的跑法才能下结论——1/52 的坏文件在默认 20 份里命中概率只有 ~38%，抽样跑的 R-3 是空断言。
//      门槛跑法：`RECRUITMENT_CORPUS_GATE=1` + `RECRUITMENT_CORPUS_SAMPLE=all`；
//      声明了 GATE 却没用全量 → 直接 fail（不允许被抽样绕过）。
//   3. **默认抽样保留但只做开发回路**：输出 `SAMPLED — 不构成门槛判定`，
//      断言里不得出现 R-3 达标结论（只对"本次观察到的失败"做可归因 smoke 检查）。
//   4. **不断言具体份数与成功率**：语料会变。统计表只打印给人看；R-1/R-2 是否达标由人看
//      全量跑法打印的 thresholds 行判定，测试不因 R-1/R-2 数字失败。
//   5. **超时口径跟产品走**：缺省 180s（与 `dsh/profile/recruitment/cordis.patch.yml`
//      一致），不是 60s——OCR 兜底后单份真实简历可达 53s+，用 60s 会把"慢"误报成"读不出"。
//      失败还会按 file_unreadable / reader_defect / reader_failed_or_slow / not_attempted
//      归类打印，避免把 reader bug 混成"语料坏了"（D-99 / docs/11 §11.3）。
//
// 走的是**真实工具入口** `recruitment_document_read`（createDocumentReadTool），
// 不是绕过工具直接调 reader：`blocking_for_structure` 的判定逻辑只存在于
// `src/tools/document-read.ts`（D-97 两档阻断），复用它才能保证"回归的就是线上那条路"。
//
// 语料边界（R7）：本文件只读语料、只打印路径与错误码；不打印、不落盘任何正文。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import { createDocumentReadTool } from '../../src/tools/document-read.ts'
import { resolveConverterConfig, type ResolvedConverterConfig } from '../../src/tools/converter.ts'
import type { DocumentReadErrorCode } from '../../src/document/readers/index.ts'
import { CONVERTER_DIR, resolvePython } from '../document/fixtures.ts'

/**
 * 语料根目录：**只从环境变量读**（`RECRUITMENT_CORPUS_ROOT`）。
 *
 * 这里原本写死了一个本机绝对路径（`D:\<本机>\...\resume-talent-pool\...`），
 * 三个问题叠在一起：
 *   ① **R7**：机器路径不该入库（CI 的"manifest 可移植"守卫只扫 `converter/corpus`，
 *      扫不到 `test/`，所以这个漏点一直没人发现）；
 *   ② 本机绿 CI 红的又一来源：Linux runner 上那个路径永远不存在；
 *   ③ 最糟的是它会**静默 skip** —— 看起来"这条测试过了"，其实一步没跑（R3：skip ≠ pass）。
 *
 * 现在：未设置 = 明确 skip，且 skip 理由里不再出现机器路径。
 * 这是**accepted skip**（真实语料按设计不入库），不是通过；CI 里由显式声明清单兜住。
 */
const CORPUS_ROOT = (process.env.RECRUITMENT_CORPUS_ROOT ?? '').trim()

/** 缺省抽样 20 份（docs/11 §11.2 的下限）；`all` = 全量。 */
const DEFAULT_SAMPLE_SIZE = 20

/**
 * 缺省单份读取超时：**与产品配置一致**（`dsh/profile/recruitment/cordis.patch.yml`
 * 的 `timeout_ms: 180000`）。合成 fixture 只要 0.3–2s，真实简历在 OCR 兜底后可达 53s+；
 * 若这里按 60s 卡，会把"慢"误报成"读不出"（D-99 实测踩过）。可用
 * `RECRUITMENT_CORPUS_TIMEOUT_MS` 覆盖。
 */
const DEFAULT_READ_TIMEOUT_MS = 180_000

/**
 * 只有这四种格式是"可读文档"。**故意不含图片**（png/jpg）：一张扫描件被判定为
 * `blocking_for_structure=true`（需要 vision 补读）是**正确行为**，不是回归失败；
 * 把它混进 R-2 的分母会把正确判定算成退化。
 */
const DOCUMENT_EXTENSIONS = ['.pdf', '.docx'] as const

/** 图片扩展名：只用于统计"被排除的数量"，不参与读取。 */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const

/** `DocumentReadErrorCode` 的运行时副本（用于断言 reason_code 落在闭集内）。 */
const DOCUMENT_READ_ERROR_CODES: readonly DocumentReadErrorCode[] = [
  'INVALID_ARGS',
  'NOT_FOUND',
  'FORBIDDEN',
  'CONFIG_INVALID',
  'EMPTY_FILE',
  'UNSUPPORTED_MEDIA',
  'READ_TOO_LARGE',
  'READER_FAILED',
  'TIMEOUT',
  'DOCX_UNREADABLE',
  'IMAGE_UNREADABLE',
  'SOURCE_CHANGED_DURING_READ',
  'READER_OUTPUT_INVALID',
  'ADAPTER_FAILED',
]

/**
 * 失败的**归类**（docs/11 §11.3 口径补充：reader 缺陷不得混成"文件不可读"）。
 *
 * - `file_unreadable`：文件本身不可用（空占位/损坏/格式不支持/超限/读取期间被改）；
 * - `reader_defect`：reader 自身违反契约（输出非法/适配器协议失败）——是代码 bug；
 * - `reader_failed_or_slow`：reader 进程失败或超时——可能环境/负载，也可能文件过于复杂；
 * - `not_attempted`：路径/配置就没通过校验，根本没读文件。
 */
type FailureClass = 'file_unreadable' | 'reader_defect' | 'reader_failed_or_slow' | 'not_attempted'

/** 14 个 code → 归类（覆盖必须完整，测试内有断言）。 */
const FAILURE_CLASS_BY_CODE: Readonly<Record<DocumentReadErrorCode, FailureClass>> = {
  EMPTY_FILE: 'file_unreadable',
  UNSUPPORTED_MEDIA: 'file_unreadable',
  READ_TOO_LARGE: 'file_unreadable',
  DOCX_UNREADABLE: 'file_unreadable',
  IMAGE_UNREADABLE: 'file_unreadable',
  SOURCE_CHANGED_DURING_READ: 'file_unreadable',
  READER_OUTPUT_INVALID: 'reader_defect',
  ADAPTER_FAILED: 'reader_defect',
  READER_FAILED: 'reader_failed_or_slow',
  TIMEOUT: 'reader_failed_or_slow',
  INVALID_ARGS: 'not_attempted',
  NOT_FOUND: 'not_attempted',
  FORBIDDEN: 'not_attempted',
  CONFIG_INVALID: 'not_attempted',
}

/** 工具输出的最小投影（只取本测试用到的字段，避免对 tool 内部类型做假设）。 */
interface DocumentReadValue {
  readonly media_type: string
  readonly completeness: string
  readonly needs_visual: boolean
  readonly source_chars: number
  readonly assessment: {
    readonly blocking: boolean
    readonly blocking_for_structure: boolean
    readonly blocking_codes: readonly string[]
  }
}

/** 一次抽样读取的结果。 */
interface SampleOutcome {
  readonly path: string
  readonly relative_path: string
  readonly ok: boolean
  readonly media_type: string | null
  readonly completeness: string | null
  readonly blocking: boolean | null
  readonly blocking_for_structure: boolean | null
  readonly blocking_codes: readonly string[]
  readonly chars: number
  readonly needs_visual: boolean
  readonly reason_code: string | null
  readonly message: string
  readonly elapsed_ms: number
}

/** 递归收集语料目录下的文件（只排序，不读内容）。 */
function walkFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(full))
    else if (entry.isFile()) files.push(full)
  }
  return files
}

/** 小写扩展名（含点）。 */
function extensionOf(filePath: string): string {
  const index = filePath.lastIndexOf('.')
  return index < 0 ? '' : filePath.slice(index).toLowerCase()
}

/**
 * 确定性抽样：按路径排序后**等间距**取，重复跑结果一致（不用随机数）。
 * 语料总量 ≤ 抽样数时返回全部（"不足 20 份跑全部"）。
 */
function pickEvenly(files: readonly string[], count: number): string[] {
  if (count >= files.length) return [...files]
  if (count <= 1) return [files[0] as string]
  const indexes = new Set<number>()
  for (let i = 0; i < count; i += 1) {
    indexes.add(Math.round((i * (files.length - 1)) / (count - 1)))
  }
  return [...indexes].sort((a, b) => a - b).map((index) => files[index] as string)
}

/** 抽样数：环境变量 `RECRUITMENT_CORPUS_SAMPLE` = 正整数 或 `all`；非法值退回缺省。 */
function resolveSampleSize(total: number): number {
  const raw = (process.env.RECRUITMENT_CORPUS_SAMPLE ?? '').trim().toLowerCase()
  if (raw === 'all') return total
  if (raw === '') return Math.min(DEFAULT_SAMPLE_SIZE, total)
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, total) : Math.min(DEFAULT_SAMPLE_SIZE, total)
}

/** 单份读取超时：`RECRUITMENT_CORPUS_TIMEOUT_MS` 覆盖，否则用与产品一致的 180s。 */
function resolveReadTimeoutMs(): number {
  const raw = (process.env.RECRUITMENT_CORPUS_TIMEOUT_MS ?? '').trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READ_TIMEOUT_MS
}

/**
 * 门槛意图：显式声明"这次跑法要下门槛结论"。
 * 与 `RECRUITMENT_CORPUS_SAMPLE=all` 配合；只声明 intent 却没跑全量 → 直接 fail，
 * 防止"用默认抽样跑绿就当门槛达标"（总控 2026-11-14 裁决）。
 */
const GATE_INTENT = (process.env.RECRUITMENT_CORPUS_GATE ?? '').trim() === '1'

/** reason_code → 归类；未知 code 归 `not_attempted`（并为 undefined 时给 `unknown`）。 */
function failureClassOf(code: string | null): FailureClass | 'unknown' {
  if (code === null) return 'unknown'
  return FAILURE_CLASS_BY_CODE[code as DocumentReadErrorCode] ?? 'unknown'
}

/** 工具配置要求 python_bin 是绝对路径；`python` 可能只是 PATH 上的名字。 */
function absolutePython(bin: string): string {
  if (isAbsolute(bin)) return bin
  const resolved = execFileSync(bin, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  }).trim()
  return resolved === '' ? bin : resolved
}

/**
 * 从 **工具入口** 抛出的错误里取出可诊断的 `reason_code`。
 *
 * `recruitment_document_read` 把 `DocumentReadError` 包成稳定工具错误：
 * `<MAPPED_CODE>: {"reason_code": "...", "message": "..."}`（src/tools/document-read.ts
 * `rethrowAsToolError`）。这里必须能解析出 reason_code——解析不出来本身就是 R-3 失败。
 */
function diagnosableReason(error: unknown): { code: string | null; message: string } {
  const raw = error instanceof Error ? error.message : String(error)
  const marker = raw.indexOf(': ')
  if (marker > 0) {
    try {
      const body = JSON.parse(raw.slice(marker + 2)) as { reason_code?: unknown; message?: unknown }
      return {
        code: typeof body.reason_code === 'string' && body.reason_code.trim() !== ''
          ? body.reason_code.trim()
          : null,
        message: typeof body.message === 'string' ? body.message : raw,
      }
    } catch {
      // 不是 JSON 错误体：退回错误对象自带的 code（工具层 INVALID_ARGS / NOT_FOUND / FORBIDDEN）
    }
  }
  const code = (error as { code?: unknown }).code
  return {
    code: typeof code === 'string' && code.trim() !== '' ? code.trim() : null,
    message: raw,
  }
}

/** 统计一个只读映射（用于完整性 / blocking 分布）。 */
function countBy(values: readonly string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 百分比（保留 1 位），分母为 0 时返回 'n/a'。 */
function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return 'n/a'
  return `${((numerator / denominator) * 100).toFixed(1)}%`
}

// ---- 语料目录探测：不存在时整个文件按 skip 处理，并在原因里写清缺什么 ----

const CORPUS_EXISTS = existsSync(CORPUS_ROOT)
const ALL_FILES = CORPUS_EXISTS ? walkFiles(CORPUS_ROOT) : []
const DOCUMENT_FILES = ALL_FILES
  .filter((file) => (DOCUMENT_EXTENSIONS as readonly string[]).includes(extensionOf(file)))
  .sort()
const IMAGE_FILE_COUNT = ALL_FILES
  .filter((file) => (IMAGE_EXTENSIONS as readonly string[]).includes(extensionOf(file)))
  .length

const SKIP_REASON: string | false = CORPUS_ROOT === ''
  ? 'RECRUITMENT_CORPUS_ROOT is not set: real corpus originals are not in the repo by design (R7). '
    + 'This is an ACCEPTED skip, not a pass — CI declares it explicitly.'
  : !CORPUS_EXISTS
    ? `RECRUITMENT_CORPUS_ROOT points to a directory that does not exist: ${CORPUS_ROOT} `
      + '(skipped, NOT passed)'
    : DOCUMENT_FILES.length === 0
      ? `corpus root contains no PDF/DOCX documents: ${CORPUS_ROOT} (${ALL_FILES.length} files scanned; skipped, NOT passed)`
      : false

test('真实语料回归：全量=门槛判定 / 抽样=开发回路（SAMPLED 不构成门槛）+ 失败逐条可归因（docs/11 §11）', { skip: SKIP_REASON }, async (t) => {
  // Python 探测放在 test 体内：语料不存在时不该在模块加载期起子进程。
  const python = resolvePython()
  if (!python.ok) {
    t.skip(`python with PyMuPDF + python-docx + Pillow is unavailable: ${python.reason} (skipped, NOT passed)`)
    return
  }
  const resolution = resolveConverterConfig({
    python_bin: absolutePython(python.bin),
    converter_dir: CONVERTER_DIR,
    allowed_roots: [CORPUS_ROOT],
    timeout_ms: resolveReadTimeoutMs(),
  })
  if (resolution.resolved === null) {
    t.skip(`reader config is invalid: ${resolution.issues.join('; ')} (skipped, NOT passed)`)
    return
  }
  const cfg: ResolvedConverterConfig = resolution.resolved
  const tool = createDocumentReadTool(cfg)
  const sampleSize = resolveSampleSize(DOCUMENT_FILES.length)
  const sampled = pickEvenly(DOCUMENT_FILES, sampleSize)

  // 门槛判定只认"显式要求 + 覆盖全部文档"的跑法（总控 2026-11-14 裁决）：
  // 1/52 的坏文件在默认抽样 20 份里命中概率只有 ~38%，抽样跑出来的 R-3 是空断言。
  // 显式要求 = `RECRUITMENT_CORPUS_SAMPLE=all`（或明确声明 GATE 意图且确实覆盖全部）。
  const fullCoverage = sampled.length === DOCUMENT_FILES.length
  const explicitAll = (process.env.RECRUITMENT_CORPUS_SAMPLE ?? '').trim().toLowerCase() === 'all'
  const gateMode = fullCoverage && (explicitAll || GATE_INTENT)
  if (GATE_INTENT && !gateMode) {
    assert.fail(
      'RECRUITMENT_CORPUS_GATE=1 要求全量语料（RECRUITMENT_CORPUS_SAMPLE=all），'
        + `当前 ${sampled.length}/${DOCUMENT_FILES.length} 份：门槛判定不允许被抽样绕过`,
    )
  }

  const outcomes: SampleOutcome[] = []
  for (const file of sampled) {
    const startedAt = performance.now()
    const relativePath = relative(CORPUS_ROOT, file)
    try {
      const value = await tool.execute({ path: file }) as unknown as DocumentReadValue
      outcomes.push({
        path: file,
        relative_path: relativePath,
        ok: true,
        media_type: value.media_type,
        completeness: value.completeness,
        blocking: value.assessment.blocking,
        blocking_for_structure: value.assessment.blocking_for_structure,
        blocking_codes: [...value.assessment.blocking_codes],
        chars: value.source_chars,
        needs_visual: value.needs_visual,
        reason_code: null,
        message: '',
        elapsed_ms: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      const reason = diagnosableReason(error)
      outcomes.push({
        path: file,
        relative_path: relativePath,
        ok: false,
        media_type: null,
        completeness: null,
        blocking: null,
        blocking_for_structure: null,
        blocking_codes: [],
        chars: 0,
        needs_visual: false,
        reason_code: reason.code,
        message: reason.message,
        elapsed_ms: Math.round(performance.now() - startedAt),
      })
    }
  }

  const ok = outcomes.filter((outcome) => outcome.ok)
  const failed = outcomes.filter((outcome) => !outcome.ok)
  const completeCount = ok.filter((outcome) => outcome.completeness === 'complete').length
  const partialCount = ok.filter((outcome) => outcome.completeness === 'partial').length
  const b4sFalse = ok.filter((outcome) => outcome.blocking_for_structure === false).length
  const b4sTrue = ok.filter((outcome) => outcome.blocking_for_structure === true).length
  const blockingTrue = ok.filter((outcome) => outcome.blocking === true).length
  const blockingFalse = ok.filter((outcome) => outcome.blocking === false).length
  const failureClasses = countBy(failed.map((outcome) => failureClassOf(outcome.reason_code)))
  const classCounts = (['file_unreadable', 'reader_defect', 'reader_failed_or_slow', 'not_attempted', 'unknown'] as const)
    .map((name) => `${name}:${failureClasses.find(([key]) => key === name)?.[1] ?? 0}`)
    .join(', ')
  const fileUnreadable = failed.filter((outcome) => failureClassOf(outcome.reason_code) === 'file_unreadable').length
  const readerDefect = failed.filter((outcome) => failureClassOf(outcome.reason_code) === 'reader_defect').length

  // 门槛判定：只有全量跑法才允许下结论；抽样跑法一律 NOT EVALUATED。
  const r1Rate = outcomes.length === 0 ? 0 : ok.length / outcomes.length
  const r2Rate = ok.length === 0 ? 0 : b4sFalse / ok.length
  const r3Rate = failed.length === 0
    ? 1
    : failed.filter((outcome) => failureClassOf(outcome.reason_code) !== 'unknown').length / failed.length
  const r1Pass = r1Rate >= 0.95
  const r2Pass = r2Rate >= 0.9
  const r3Pass = r3Rate === 1
  const thresholdLines = gateMode
    ? [
      `thresholds = R-1 ${rate(ok.length, outcomes.length)} (>=95% ${r1Pass ? 'PASS' : 'FAIL'}), `
        + `R-2 ${rate(b4sFalse, ok.length)} (>=90% ${r2Pass ? 'PASS' : 'FAIL'}), `
        + `R-3 ${failed.length === 0 ? '100% (0 failures, vacuous)' : rate(failed.length - failed.filter((o) => failureClassOf(o.reason_code) === 'unknown').length, failed.length)} `
        + `(100% ${r3Pass ? 'PASS' : 'FAIL'})`,
    ]
    : ['thresholds = NOT EVALUATED — SAMPLED — 不构成门槛判定（门槛跑法：RECRUITMENT_CORPUS_GATE=1 RECRUITMENT_CORPUS_SAMPLE=all）']

  // ---- 统计表（给人看的）----
  const lines: string[] = [
    '真实语料回归（docs/11 §11）',
    gateMode
      ? `mode = FULL (${sampled.length}/${DOCUMENT_FILES.length} documents) — 可用于 R-1/R-2/R-3 门槛判定`
      : `mode = SAMPLED (${sampled.length}/${DOCUMENT_FILES.length}) — 不构成门槛判定`,
    ...(gateMode ? [] : ['>> SAMPLED — 不构成门槛判定（开发回路；门槛判定必须全量）']),
    `corpus_root = ${CORPUS_ROOT}`,
    `documents_found = ${DOCUMENT_FILES.length} (pdf/docx)`,
    `images_excluded = ${IMAGE_FILE_COUNT} (a scan image blocking structure is correct behavior, not a regression)`,
    `sample_size = ${sampled.length} / ${DOCUMENT_FILES.length} `
      + `(default ${DEFAULT_SAMPLE_SIZE}; all = RECRUITMENT_CORPUS_SAMPLE=all)`,
    `read_timeout_ms = ${cfg.timeout_ms} (product profile uses 180000; OCR fallback can take 53s+)`,
    `read_ok = ${ok.length}`,
    `read_failed = ${failed.length}`,
    `read_success_rate = ${rate(ok.length, outcomes.length)} `
      + `(${gateMode ? 'R-1 threshold >= 95%, docs/11 §11.3' : 'SAMPLED — 不构成门槛判定'})`,
    `failure_classes = ${classCounts} `
      + `(file_unreadable=${fileUnreadable}, reader_defect=${readerDefect}; `
      + 'reader_defect is a code bug, must not be reported as "corpus is broken")',
    ...thresholdLines,
    `completeness = ${completeCount === 0 && partialCount === 0
      ? 'n/a'
      : `complete=${completeCount}, partial=${partialCount}, failed=${failed.length}`}`,
    `blocking_for_structure = false:${b4sFalse}, true:${b4sTrue} `
      + `(rate among read_ok = ${rate(b4sFalse, ok.length)}; `
      + `${gateMode ? 'R-2 threshold >= 90%' : 'SAMPLED — 不构成门槛判定'})`,
    `blocking (trusted screening) = true:${blockingTrue}, false:${blockingFalse} `
      + '(blocking=true does NOT fail R-2; it only blocks trusted screening, docs/11 §11.4)',
    `needs_visual = true: ${ok.filter((outcome) => outcome.needs_visual).length} / ${ok.length}`,
    `slowest_ms = ${outcomes.reduce((max, outcome) => Math.max(max, outcome.elapsed_ms), 0)}`,
  ]
  if (ok.length > 0) {
    lines.push(`media_types = ${countBy(ok.map((outcome) => outcome.media_type ?? 'unknown')).map(([key, count]) => `${key}:${count}`).join(', ')}`)
  }
  lines.push(`blocking_codes_top = ${countBy(ok.flatMap((outcome) => outcome.blocking_codes)).slice(0, 8).map(([key, count]) => `${key}:${count}`).join(', ') || '(none)'}`)
  lines.push(`failures (${failed.length}):`)
  if (failed.length === 0) {
    lines.push('  (none)')
  } else {
    for (const [index, outcome] of failed.entries()) {
      lines.push(
        `  ${index + 1}. ${outcome.relative_path}`,
        `     class=${failureClassOf(outcome.reason_code)} reason_code=${outcome.reason_code ?? '(missing)'} `
          + `elapsed_ms=${outcome.elapsed_ms}`,
        `     message=${outcome.message}`,
      )
    }
  }
  t.diagnostic(lines.join('\n'))

  // ---- R-3：失败必须可归因（docs/11 §11.3）----
  // 全量跑法：这是门槛的 R-3 证据（覆盖全部文档）。
  // 抽样跑法：只是对"本次观察到的失败"做 smoke 检查，**不构成 R-3 门槛结论**
  //           （抽样可能漏掉失败项，所以这里不打印/不断言"R-3 达标"）。
  const scope = gateMode ? 'R-3 门槛（全量）' : '样本内 smoke（非门槛结论）'
  for (const code of DOCUMENT_READ_ERROR_CODES) {
    assert.notEqual(
      FAILURE_CLASS_BY_CODE[code],
      undefined,
      `失败归类表漏了 code=${code}：14 个 code 都必须能归类（file_unreadable / reader_defect / ...）`,
    )
  }
  for (const outcome of failed) {
    assert.notEqual(
      outcome.reason_code,
      null,
      `${scope}：失败项必须带可诊断的 reason_code，但 ${outcome.relative_path} 的报错里解析不到：${outcome.message}`,
    )
    assert.ok(
      (DOCUMENT_READ_ERROR_CODES as readonly string[]).includes(outcome.reason_code as string),
      `${scope}：${outcome.relative_path} 的 reason_code=${outcome.reason_code} 不在 DocumentReadErrorCode 闭集内 `
        + `(允许: ${DOCUMENT_READ_ERROR_CODES.join(', ')})`,
    )
    assert.notEqual(
      failureClassOf(outcome.reason_code),
      'unknown',
      `${scope}：${outcome.relative_path} 的 reason_code=${outcome.reason_code} 没有归类`,
    )
    assert.notEqual(
      outcome.message.trim(),
      '',
      `${scope}：${outcome.relative_path} 的 message 为空：有 code 没原因，等于"失败了"三个字`,
    )
  }

  // 全量跑法必须真的覆盖了全部文档；这条是"不被抽样绕过"的兜底断言。
  if (gateMode) {
    assert.equal(
      sampled.length,
      DOCUMENT_FILES.length,
      `门槛跑法必须全量：本次 ${sampled.length}/${DOCUMENT_FILES.length} 份（不允许被默认抽样绕过）`,
    )
  }

  // 断言"确实真的读过"：读取成功的份数不能是 0（否则统计表毫无意义）。
  // 注意这里**不**断言份数下限或成功率——语料会变；门槛判定由统计表的 thresholds 行给出，
  // 只在全量跑法（FULL）下才有意义。
  assert.ok(
    ok.length > 0,
    `${gateMode ? '全量' : '抽样'} ${sampled.length} 份全部读取失败，回归没有产生任何有效样本：`
      + failed.map((outcome) => `${outcome.relative_path}:${outcome.reason_code}`).join('; '),
  )
})
