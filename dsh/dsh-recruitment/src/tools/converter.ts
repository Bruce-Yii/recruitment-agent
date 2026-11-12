// 转换器调用层：把本地 PDF 交给 Python 读取器，拿回结构化 JSON。
//
// 复用边界：这里不解析 PDF，只做「校验路径 → 起子进程 → 解析 JSON」。
// 真正的解析在 converter/（PyMuPDF 实现），本文件是胶水。
//
// 安全边界（fail-closed）：
//   * 必须是绝对路径、必须存在、必须是 .pdf
//   * 必须落在 allowed_roots 之内；未配置 allowed_roots 时一律拒绝（不默认放开）
//   * 子进程有超时，且随 exec.signal 中止
import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 插件配置（来自 cordis.patch.yml 的 config 段）。 */
export interface ConverterConfig {
  /** Python 解释器绝对路径。 */
  readonly python_bin?: string
  /** converter/ 目录绝对路径（含 src/）。 */
  readonly converter_dir?: string
  /** 允许读取的根目录；空数组 = 拒绝一切（fail-closed）。 */
  readonly allowed_roots?: readonly string[]
  /** 单份超时（毫秒），默认 60000。 */
  readonly timeout_ms?: number
}

/** 解析后的配置（已填默认值）。 */
export interface ResolvedConverterConfig {
  readonly python_bin: string
  readonly converter_dir: string
  readonly allowed_roots: readonly string[]
  readonly timeout_ms: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** 校验并补默认值；配置不完整时返回 issues，由调用方决定 fail-closed。 */
export function resolveConverterConfig(config: ConverterConfig): {
  resolved: ResolvedConverterConfig | null
  issues: readonly string[]
} {
  const issues: string[] = []
  const python = (config.python_bin ?? '').trim()
  const dir = (config.converter_dir ?? '').trim()
  const roots = (config.allowed_roots ?? []).map((r) => r.trim()).filter((r) => r !== '')
  if (python === '') issues.push('config.python_bin is required')
  if (dir === '') issues.push('config.converter_dir is required')
  if (roots.length === 0) issues.push('config.allowed_roots must list at least one readable root')
  if (python !== '' && !isAbsolute(python)) issues.push('config.python_bin must be absolute')
  if (dir !== '' && !isAbsolute(dir)) issues.push('config.converter_dir must be absolute')
  if (issues.length > 0) return { resolved: null, issues }
  const timeout = config.timeout_ms
  return {
    resolved: {
      python_bin: python,
      converter_dir: dir,
      allowed_roots: roots,
      timeout_ms:
        typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
          ? timeout
          : DEFAULT_TIMEOUT_MS,
    },
    issues: [],
  }
}

/** 路径校验失败时抛出的原因（由工具层转成 INVALID_ARGS / FORBIDDEN）。 */
export class ConverterPathError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConverterPathError'
    this.code = code
  }
}

/** 校验一个待读取路径；不通过就抛，绝不"尽量读一下"。 */
export function assertReadablePdf(filePath: string, cfg: ResolvedConverterConfig): string {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new ConverterPathError('INVALID_ARGS', 'path must be a non-empty string')
  }
  if (!isAbsolute(filePath)) {
    throw new ConverterPathError('INVALID_ARGS', `path must be absolute, got "${filePath}"`)
  }
  if (!filePath.toLowerCase().endsWith('.pdf')) {
    throw new ConverterPathError('INVALID_ARGS', 'path must point to a .pdf file')
  }
  if (!existsSync(filePath)) {
    throw new ConverterPathError('NOT_FOUND', `file does not exist: ${filePath}`)
  }
  const real = realpathSync(filePath)
  const allowed = cfg.allowed_roots.some((root) => {
    const rel = relative(resolve(root), real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })
  if (!allowed) {
    throw new ConverterPathError(
      'FORBIDDEN',
      `path is outside the configured allowed_roots: ${real}`,
    )
  }
  return real
}

/** 转换器返回的原始结构（只声明本工具用到的字段）。 */
export interface ConverterOutput {
  readonly text?: string
  readonly title?: string
  readonly chars?: number
  readonly completeness?: string
  readonly needs_visual?: boolean
  readonly issues?: ReadonlyArray<{ code?: string; message?: string; location?: unknown }>
  readonly warnings?: readonly string[]
  readonly blocks?: ReadonlyArray<{
    kind?: string
    text?: string
    location?: { page?: number; bbox?: readonly number[] }
    provenance?: string
    links?: ReadonlyArray<{ href?: string; text?: string }>
  }>
  readonly fields?: Record<string, {
    state?: string
    value?: string | null
    reason?: string
    provenance?: string
    evidence?: ReadonlyArray<{ page?: number; bbox?: readonly number[]; block?: number; text?: string }>
  }>
  readonly screening?: {
    eligible_fields?: readonly string[]
    blocked_fields?: ReadonlyArray<{ field?: string; reason?: string }>
    identity_merge_eligible?: readonly string[]
    protected_excluded?: readonly string[]
    note?: string
  }
  readonly meta?: {
    pages?: number
    source_sha256?: string
    source_name?: string
    backend?: string
    reader_version?: string
    layout_backend?: string | null
    order_verified?: boolean
    ocr?: string
  }
}

/** 起子进程跑转换器并解析 JSON。基础设施失败直接抛，由工具层转成错误码。 */
export async function runConverter(
  cfg: ResolvedConverterConfig,
  filePath: string,
  signal?: AbortSignal,
): Promise<ConverterOutput> {
  const { stdout } = await execFileAsync(
    cfg.python_bin,
    ['-m', 'src.cli', filePath, '--no-isolation'],
    {
      cwd: cfg.converter_dir,
      timeout: cfg.timeout_ms,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    },
  )
  const trimmed = stdout.trim()
  if (trimmed === '') throw new Error('converter produced no output')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('converter output is not JSON')
  return JSON.parse(trimmed.slice(start, end + 1)) as ConverterOutput
}
