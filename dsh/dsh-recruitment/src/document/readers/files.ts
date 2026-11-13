// 文件层公共工具：路径校验 + 原件 SHA-256。
//
// 路径规则与现有 converter 胶水保持一致（fail-closed）：
//   * 必须是绝对路径、必须存在、必须是普通文件；
//   * 必须落在 allowed_roots 之内；allowed_roots 为空时拒绝一切（不默认放开）；
//   * **不看扩展名**。扩展名只用于「是否与内容不符」的告警，永远不参与选 reader
//     （docs/19 §2.1 的内容嗅探要求）。
//
// 错误消息的可诊断要求（docs/11 §11）：每条 message 说清"**为什么**拒"，
// 例如相对路径为什么会读错、不存在的路径意味着什么、越界拒绝不是"读失败"。
// 这些消息只描述路径与配置，不含任何文档正文（R7）。

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import { DocumentReadError } from './errors.ts'

export interface ReadableFile {
  /** realpath 之后的绝对路径（子进程只拿这个）。 */
  readonly real_path: string
  readonly bytes: number
}

/** 校验一个待读取路径；不通过就抛 DocumentReadError，绝不「尽量读一下」。 */
export function assertReadableFile(filePath: string, cfg: ResolvedConverterConfig): ReadableFile {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new DocumentReadError(
      'INVALID_ARGS',
      'path must be a non-empty string: an empty path cannot identify a document, so nothing was opened',
    )
  }
  if (!isAbsolute(filePath)) {
    // 为什么拒绝相对路径：reader 子进程有自己的 cwd，同一个相对路径会指向另一个文件。
    throw new DocumentReadError(
      'INVALID_ARGS',
      `path must be absolute, got "${filePath}"; a relative path would be resolved against the `
        + 'reader subprocess working directory and could name a different file',
    )
  }
  if (!existsSync(filePath)) {
    throw new DocumentReadError(
      'NOT_FOUND',
      `file does not exist: ${filePath}; nothing was read (the path may be misspelled, or the file `
        + 'was deleted, moved, or is on an unmounted/offline location)',
    )
  }
  const real = realpathSync(filePath)
  const stats = statSync(real)
  if (!stats.isFile()) {
    throw new DocumentReadError(
      'INVALID_ARGS',
      `path is not a regular file: ${real}; it is a directory or another non-file entry, and only `
        + 'regular files carry document bytes, so nothing was read',
    )
  }
  const allowed = cfg.allowed_roots.some((root) => {
    const rel = relative(resolve(root), real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
  if (!allowed) {
    throw new DocumentReadError(
      'FORBIDDEN',
      `path is outside the configured allowed_roots: ${real}; reading is limited to the configured `
        + 'roots (the file exists, but this reader is not allowed to open it, so nothing was read)',
      { details: { allowed_roots: cfg.allowed_roots.length } },
    )
  }
  if (stats.size === 0) {
    // 0 字节不是"损坏的 PDF"，是**空占位文件**：没有任何字节可解析。
    throw new DocumentReadError(
      'EMPTY_FILE',
      'file is empty (0 bytes); a 0-byte file has no PDF/DOCX/PNG/JPEG magic bytes to parse, '
        + 'so this is an empty placeholder rather than a corrupt document',
      { details: { bytes: 0 } },
    )
  }
  return { real_path: real, bytes: stats.size }
}

/** 计算原件 SHA-256（小写 hex）。流式读取，不把整份 PDF 再读进内存。 */
export async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', rejectPromise)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}
