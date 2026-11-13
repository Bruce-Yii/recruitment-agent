// python/document_readers.py 的子进程桥（DOCX / 图片）。
//
// 与 src/tools/fallback-bridge.ts 同一做法：
//   * 请求走 stdin（不是 argv），避免路径出现在命令行；
//   * stdout 只允许一个 JSON 对象；
//   * 超时 / abort 都杀掉子进程；
//   * Python 侧稳定码映射成 DocumentReadErrorCode，未列出的按 READER_FAILED。
// 这里不解析 DOCX / 图片，也不复制任何读取规则。

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedConverterConfig } from '../../tools/converter.ts'
import { DocumentReadError, type DocumentReadErrorCode } from './errors.ts'

/** 适配器位置：随包发布，与 src/ 同级（src/document/readers -> ../../..）。 */
const ADAPTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'python',
  'document_readers.py',
)

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_STDERR = 400

const ERROR_CODE_MAP: Readonly<Record<string, DocumentReadErrorCode>> = {
  not_found: 'NOT_FOUND',
  invalid_request: 'INVALID_ARGS',
  too_large: 'READ_TOO_LARGE',
  docx_unreadable: 'DOCX_UNREADABLE',
  docx_missing_document_part: 'DOCX_UNREADABLE',
  docx_unavailable: 'READER_FAILED',
  image_unreadable: 'IMAGE_UNREADABLE',
  image_open_failed: 'IMAGE_UNREADABLE',
  image_format_mismatch: 'READER_OUTPUT_INVALID',
  adapter_failed: 'ADAPTER_FAILED',
}

export interface AdapterResponse {
  readonly ok: boolean
  readonly content?: unknown
  readonly code?: string
  readonly message?: string
}

/**
 * 跑一次 Python 读取适配器。
 *
 * @param cfg - 已解析的 converter 配置（复用 python_bin / timeout_ms）。
 * @param request - `{op, path}`。
 * @param action - 出错时用于 message 的动作名（不给模型看原文）。
 * @param signal - 工具执行信号；中止时杀掉子进程。
 */
export async function runDocumentAdapter(
  cfg: ResolvedConverterConfig,
  request: Readonly<Record<string, unknown>>,
  action: string,
  signal?: AbortSignal,
): Promise<AdapterResponse> {
  const payload = JSON.stringify(request)
  return await new Promise<AdapterResponse>((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new DocumentReadError('READER_FAILED', `${action} aborted before it started`))
      return
    }
    const child = spawn(cfg.python_bin, [ADAPTER_PATH], {
      cwd: dirname(ADAPTER_PATH),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (actionFn: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      actionFn()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => rejectPromise(new DocumentReadError(
        'READER_FAILED',
        `${action} aborted while the reader subprocess was running`,
      )))
    }

    timer = setTimeout(() => {
      child.kill()
      finish(() => rejectPromise(new DocumentReadError(
        'TIMEOUT',
        `${action} exceeded the ${cfg.timeout_ms} ms reader timeout; the subprocess was killed, `
          + 'no partial result is kept',
        { issues: [] },
      )))
    }, cfg.timeout_ms)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        finish(() => rejectPromise(new DocumentReadError(
          'ADAPTER_FAILED',
          `${action} produced more than ${MAX_OUTPUT_BYTES} bytes of JSON`,
        )))
        return
      }
      stdoutChunks.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', (error: Error) => {
      finish(() => rejectPromise(new DocumentReadError(
        'READER_FAILED',
        `${action} could not start the Python interpreter: ${error.message}`,
        { cause: error },
      )))
    })
    child.on('close', (code: number | null) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
        if (stdout === '') {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, MAX_STDERR)
          rejectPromise(new DocumentReadError(
            'ADAPTER_FAILED',
            `${action} produced no output (exit ${String(code)})`,
            { details: { stderr, exit_code: code } },
          ))
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          rejectPromise(new DocumentReadError('ADAPTER_FAILED', `${action} output is not JSON`))
          return
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectPromise(new DocumentReadError(
            'ADAPTER_FAILED',
            `${action} output is not a JSON object`,
          ))
          return
        }
        const response = parsed as AdapterResponse
        if (response.ok !== true) {
          const rawCode = typeof response.code === 'string' ? response.code : 'adapter_failed'
          const mapped = ERROR_CODE_MAP[rawCode] ?? 'READER_FAILED'
          const detail = typeof response.message === 'string' ? response.message : 'no detail'
          rejectPromise(new DocumentReadError(
            mapped,
            `${action} failed [${rawCode}]: ${detail}`,
            { details: { adapter_code: rawCode } },
          ))
          return
        }
        resolvePromise(response)
      })
    })

    // EPIPE 只在子进程先死时发生；close/error 事件已经负责报错。
    child.stdin.on('error', () => {})
    child.stdin.end(payload, 'utf8')
  })
}
