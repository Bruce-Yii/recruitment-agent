// PDF reader：桥接现有 converter 的 CLI（`python -m src.cli <pdf> --no-isolation`），
// 产出 canonical `DocumentContent`。
//
// 复用边界（R1 + U0 README §5）：
//   * 不重新解析 PDF，不 import PyMuPDF；
//   * 子进程调用复用 src/tools/converter.ts 的 `runConverter`（与现有
//     recruitment_resume_read 走同一条 CLI、同一个超时和输出上限）；
//   * blocks/location/links/completeness/issues 的映射复用
//     `contracts/map-converter.ts` 的 `mapConverterToDocumentContent`
//     —— 那是 U0 已用真实 CLI 输出审计过的唯一映射，本文件不再维护第二份
//     issue 严重度表 / 第二套 block 映射。
//
// 本文件只保留 reader 层职责：
//   * 算原件 SHA-256；
//   * converter 明确说 `reader_failed` / `reader_timeout`（没有保留任何正文）→ 抛错；
//   * converter 记录的 source_sha256 与本地实测不一致 → 抛 SOURCE_CHANGED_DURING_READ；
//   * 把 converter 的 meta / fields 等「不属于 content 契约」的证据放进
//     `source_meta`（见 outcome.ts），保证「映射不丢 meta」。
//
// 其它 HARD（无文字层、损坏修复、加密……）→ content 是 partial + HARD issue，
// 由 U2/质量 Gate 决定补读/人工，绝不当 complete。

import {
  mapConverterToDocumentContent,
  type ConverterLikeOutput,
  type DocumentContent,
} from '../contracts/index.ts'
import type { ConverterOutput, ResolvedConverterConfig } from '../../tools/converter.ts'
import { runConverter } from '../../tools/converter.ts'
import { DocumentReadError } from './errors.ts'
import { sha256File } from './files.ts'
import { hardIssue } from './issues.ts'
import { MEDIA_PDF } from './media.ts'
import type { DocumentReadOutcome } from './outcome.ts'
import { assertValidDocumentContent } from './output-guard.ts'

/** converter 顶层里不属于 content、但必须留在证据里的字段。 */
interface RawPdfOutput extends ConverterLikeOutput {
  readonly meta?: unknown
  readonly title?: unknown
  readonly chars?: unknown
  readonly warnings?: unknown
  readonly links?: unknown
  readonly fields?: unknown
  readonly screening?: unknown
  readonly protected_attributes?: unknown
  readonly timeline?: unknown
  readonly noise?: unknown
}

const FATAL_ISSUE_CODES = new Set(['reader_failed', 'reader_timeout'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把 converter 的其它顶层结果原样收进 source_meta（不丢证据，也不进封闭契约）。 */
function buildSourceMeta(raw: RawPdfOutput): Record<string, unknown> {
  return {
    converter_meta: isRecord(raw.meta) ? raw.meta : null,
    converter_extras: {
      title: raw.title ?? '',
      chars: raw.chars ?? null,
      warnings: raw.warnings ?? [],
      links: raw.links ?? [],
      fields: raw.fields ?? null,
      screening: raw.screening ?? null,
      protected_attributes: raw.protected_attributes ?? null,
      timeline: raw.timeline ?? null,
      noise: raw.noise ?? [],
    },
  }
}

/**
 * converter 原始输出 → canonical DocumentContent（纯映射 + reader 层红线）。
 *
 * @param raw - `runConverter` 的返回对象。
 * @param assetSha256 - 本地对原件算出的 SHA-256（必须与 converter 记录一致）。
 * @param elapsedMs - 读取耗时。
 */
export function mapPdfOutput(
  raw: RawPdfOutput,
  assetSha256: string,
  elapsedMs: number,
): DocumentContent {
  const meta = isRecord(raw.meta) ? raw.meta : {}
  const recordedSha = typeof meta.source_sha256 === 'string' ? meta.source_sha256 : null
  if (recordedSha !== null && recordedSha !== '' && recordedSha !== assetSha256) {
    throw new DocumentReadError(
      'SOURCE_CHANGED_DURING_READ',
      'the SHA-256 converter recorded differs from the SHA-256 of the file on disk; '
        + 'the document changed while it was being read',
      {
        details: { converter_sha256: recordedSha, measured_sha256: assetSha256 },
        issues: [
          hardIssue(
            'source_changed_during_read',
            'the original changed between hashing and parsing; the blocks cannot be tied to the bytes',
            'retry',
          ),
        ],
      },
    )
  }

  // U0 的唯一映射：媒体类型、SHA、耗时由 reader 提供，其余逐字搬运。
  const content = mapConverterToDocumentContent(raw, {
    media_type: MEDIA_PDF,
    asset_sha256: assetSha256,
    elapsed_ms: elapsedMs,
  })

  const fatal = content.issues.find((issue) => FATAL_ISSUE_CODES.has(issue.code))
  if (fatal !== undefined) {
    throw new DocumentReadError(
      fatal.code === 'reader_timeout' ? 'TIMEOUT' : 'READER_FAILED',
      `converter could not read the PDF (${fatal.code}): ${fatal.message}`,
      { issues: content.issues },
    )
  }

  return assertValidDocumentContent(content, MEDIA_PDF, 'pdf reader')
}

/** 跑 converter CLI 并返回 content + source_meta。 */
export async function readPdfDocumentDetailed(
  filePath: string,
  cfg: ResolvedConverterConfig,
  signal?: AbortSignal,
): Promise<DocumentReadOutcome> {
  const startedAt = performance.now()
  const assetSha256 = await sha256File(filePath)
  let raw: ConverterOutput
  try {
    raw = await runConverter(cfg, filePath, signal)
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    const killed = (error as { killed?: unknown }).killed === true
      || (error as { signal?: unknown }).signal !== undefined
      || /timed? ?out|ETIMEDOUT|aborted/i.test(cause.message)
    throw new DocumentReadError(
      killed ? 'TIMEOUT' : 'READER_FAILED',
      killed
        ? `PDF reader exceeded the ${cfg.timeout_ms} ms timeout; the process was killed, no partial body kept`
        : `PDF reader failed: ${cause.message}`,
      {
        cause,
        issues: [
          hardIssue(
            killed ? 'reader_timeout' : 'reader_failed',
            killed
              ? 'the converter was killed by the timeout; nothing was read'
              : 'the converter process failed; nothing was read',
            'retry',
          ),
        ],
      },
    )
  }
  const elapsedMs = Math.max(0, Math.round(performance.now() - startedAt))
  const mapped = raw as unknown as RawPdfOutput
  const content = mapPdfOutput(mapped, assetSha256, elapsedMs)
  return { content, source_meta: buildSourceMeta(mapped) }
}

/** 读取一份 PDF（只返回 canonical content）。 */
export async function readPdfDocument(
  filePath: string,
  cfg: ResolvedConverterConfig,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  return (await readPdfDocumentDetailed(filePath, cfg, signal)).content
}
