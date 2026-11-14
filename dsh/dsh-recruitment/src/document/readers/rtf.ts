// RTF reader：桥接 converter 的 CLI（`python -m src.cli <file> --no-isolation`），
// 产出 canonical `DocumentContent`。
//
// 为什么复用 converter CLI 而不是在 TS 里再解析一遍（R1 + U0 README §5）：
//   * RTF 的文本提取、issue 口径、招聘字段层（phone/email/screening）都在
//     `converter/src/rtf_reader.py` 里，与 PDF/DOCX 走**同一个 CLI、同一套
//     issue 语义、同一个超时**；TS 只做映射。
//   * 映射复用 `contracts/map-converter.ts` 的 `mapConverterToDocumentContent`
//     （`locator_kind:'rtf'`），不维护第二份映射表。
//
// 证据口径（与 pdf.ts 同形，差异只有媒体与定位）：
//   * `locator_kind:'rtf'`：块定位是**段落序号**（读取器块流顺序），没有 bbox；
//     `page` 只在读取器真的声明时出现（RTF 无硬分页符时第 1 页是格式等价事实）。
//   * converter 明确说 `reader_failed` / `reader_timeout`（没有保留任何正文）→ 抛错；
//   * converter 记录的 source_sha256 与本地实测不一致 → 抛 SOURCE_CHANGED_DURING_READ；
//   * converter 的 meta / fields 等非契约证据走 `source_meta` 旁路，不丢。

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
import { MEDIA_RTF } from './media.ts'
import type { DocumentReadOutcome } from './outcome.ts'
import { assertValidDocumentContent } from './output-guard.ts'
import { buildSourceMeta } from './pdf.ts'

/** converter 顶层里不属于 content、但必须留在证据里的字段。 */
interface RawRtfOutput extends ConverterLikeOutput {
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

/**
 * converter 原始输出 → canonical DocumentContent（纯映射 + reader 层红线）。
 *
 * @param raw - `runConverter` 的返回对象。
 * @param assetSha256 - 本地对原件算出的 SHA-256（必须与 converter 记录一致）。
 * @param elapsedMs - 读取耗时。
 */
export function mapRtfOutput(
  raw: RawRtfOutput,
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

  const content = mapConverterToDocumentContent(raw, {
    media_type: MEDIA_RTF,
    locator_kind: 'rtf',
    asset_sha256: assetSha256,
    elapsed_ms: elapsedMs,
  })

  const fatal = content.issues.find((issue) => FATAL_ISSUE_CODES.has(issue.code))
  if (fatal !== undefined) {
    throw new DocumentReadError(
      fatal.code === 'reader_timeout' ? 'TIMEOUT' : 'READER_FAILED',
      `converter could not read the RTF (${fatal.code}): ${fatal.message}`,
      { issues: content.issues },
    )
  }

  return assertValidDocumentContent(content, MEDIA_RTF, 'rtf reader')
}

/** 跑 converter CLI 并返回 content + source_meta。 */
export async function readRtfDocumentDetailed(
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
        ? `RTF reader exceeded the ${cfg.timeout_ms} ms timeout; the process was killed, no partial body kept`
        : `RTF reader failed: ${cause.message}`,
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
  const mapped = raw as unknown as RawRtfOutput
  const content = mapRtfOutput(mapped, assetSha256, elapsedMs)
  return { content, source_meta: buildSourceMeta(mapped) }
}

/** 读取一份 RTF（只返回 canonical content）。 */
export async function readRtfDocument(
  filePath: string,
  cfg: ResolvedConverterConfig,
  signal?: AbortSignal,
): Promise<DocumentContent> {
  return (await readRtfDocumentDetailed(filePath, cfg, signal)).content
}
