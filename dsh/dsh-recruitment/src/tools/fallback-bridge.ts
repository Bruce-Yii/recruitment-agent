// 模型兜底子进程桥：把一次调用转发给 python/fallback_bridge.py。
//
// 为什么仍然是子进程（D-81）：
//   D-81 取消的是「插件自己调模型」那一步（model_reader.py / pipeline.py），
//   不是渲染（page_image.py）、校验（verify_model_text.py）、合并（merge.py）。
//   这三步是确定性的、已经实现且有自己测试的；在 TS 里重写等于把同一套规则
//   实现两遍，任何一次改规则都会漏改一处。所以这里只做「起进程 → 送 JSON →
//   收 JSON」，一条规则都不复制。
//
// 边界：
//   * 请求走 stdin（不是 argv）：逐字转写里可能有个资，命令行对全机可见。
//   * 输出必须在超时内返回；exec.signal 中止时一并杀掉子进程。
//   * 子进程的 stdout 只允许出现一个 JSON 对象；别的都当基础设施失败。
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ResolvedConverterConfig } from './converter.ts'
import { RecruitmentToolError } from './errors.ts'
import type { RecruitmentErrorCode } from './errors.ts'

/** 桥脚本位置（随包发布，与 src/ 同级）。 */
const BRIDGE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'python',
  'fallback_bridge.py',
)

/** stderr 只用于诊断，最多带这么多字符进错误消息。 */
const MAX_STDERR = 400

/** Python 侧稳定码 -> 插件错误码。未列出的按 READER_FAILED 处理（fail-closed）。 */
const ERROR_CODE_MAP: Readonly<Record<string, RecruitmentErrorCode>> = {
  pdf_missing: 'NOT_FOUND',
  page_invalid: 'INVALID_ARGS',
  page_out_of_range: 'INVALID_ARGS',
  dpi_invalid: 'INVALID_ARGS',
  dpi_out_of_range: 'INVALID_ARGS',
  max_side_invalid: 'INVALID_ARGS',
  invalid_request: 'INVALID_ARGS',
  render_path_in_repo: 'FORBIDDEN',
}

/**
 * 跑一次桥请求。
 * @param cfg - 已解析的 converter 配置（python 路径、converter 目录、超时）。
 * @param request - 桥请求对象（`op` + 该 op 的字段）。
 * @param signal - 工具执行信号；中止时杀掉子进程。
 * @returns 桥返回的 JSON 对象（`ok` 字段由调用方判断）。
 */
export async function runFallbackBridge(
  cfg: ResolvedConverterConfig,
  request: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(request)
  return await new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
    if (signal?.aborted === true) {
      rejectPromise(new Error('bridge aborted before it started'))
      return
    }
    const child = spawn(cfg.python_bin, [BRIDGE_PATH, '--converter-dir', cfg.converter_dir], {
      cwd: cfg.converter_dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      action()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => rejectPromise(new Error('bridge aborted')))
    }

    timer = setTimeout(() => {
      child.kill()
      finish(() => rejectPromise(new Error(`bridge timed out after ${cfg.timeout_ms} ms`)))
    }, cfg.timeout_ms)
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)))
    child.on('error', (error: Error) => finish(() => rejectPromise(error)))
    child.on('close', (code: number | null) => {
      finish(() => {
        const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
        if (stdout === '') {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim().slice(0, MAX_STDERR)
          rejectPromise(new Error(
            `bridge produced no output (exit ${String(code)})${stderr === '' ? '' : `: ${stderr}`}`,
          ))
          return
        }
        try {
          const parsed: unknown = JSON.parse(stdout)
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            rejectPromise(new Error('bridge output is not a JSON object'))
            return
          }
          resolvePromise(parsed as Record<string, unknown>)
        } catch {
          rejectPromise(new Error('bridge output is not JSON'))
        }
      })
    })

    // EPIPE 只在子进程先死时发生；close/error 事件已经负责报错。
    child.stdin.on('error', () => {})
    child.stdin.end(payload, 'utf8')
  })
}

/**
 * 把桥的失败响应翻译成工具错误。
 * @param response - 桥返回的对象（`ok === false`）。
 * @param action - 面向模型的动作名（`page render` / `merge`）。
 * @returns 对应的 RecruitmentToolError（不在此抛出）。
 */
export function bridgeFailure(response: Readonly<Record<string, unknown>>, action: string): RecruitmentToolError {
  const rawCode = typeof response.code === 'string' ? response.code : 'bridge_failed'
  const code = ERROR_CODE_MAP[rawCode] ?? 'READER_FAILED'
  const detail = typeof response.message === 'string' ? response.message : 'no detail'
  return new RecruitmentToolError(code, `${action} failed [${rawCode}]: ${detail}`)
}
