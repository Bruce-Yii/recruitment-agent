// 转换器调用层：把本地 PDF 交给 Python 读取器，拿回结构化 JSON。
//
// 复用边界：这里不解析 PDF，只做「校验路径 → 起子进程 → 解析 JSON」。
// 真正的解析在 converter/（PyMuPDF 实现），本文件是胶水。
//
// 安全边界（fail-closed）：
//   * 必须是绝对路径、必须存在、必须是 .pdf
//   * 必须落在 allowed_roots 之内；未配置 allowed_roots 时一律拒绝（不默认放开）
//   * 子进程有超时，且随 exec.signal 中止
//
// 配置可移植（D-112，2026-11-15）：仓库 profile 不再写机器绝对路径，而是写
// `${RECRUITMENT_PYTHON_BIN}` / `${RECRUITMENT_CONVERTER_DIR}` /
// `${RECRUITMENT_ALLOWED_ROOT_*}` 这类**环境变量引用**，由本文件的
// {@link resolveConverterConfig} 在启动时展开成真实路径。
//
// 展开规则（白名单 = 只对「路径字段」展开）：
//   * 白名单：`python_bin`（字符串）、`converter_dir`（字符串）、`allowed_roots`（逐项）。
//   * 语法：`${NAME}`，NAME 必须匹配 `[A-Za-z_][A-Za-z0-9_]*`；一个字符串里可含多个引用，
//     单遍展开（**不做递归展开**：环境变量的值里再出现 `${X}` 也按字面保留，避免间接注入/死循环）。
//   * 不做引用的 `$` 是字面量（例如路径里的 `$HOME` 不会被当成引用）。
//   * `timeout_ms` 与其它非白名单字段**不展开**：它们是数值/非路径配置，展开只会制造
//     “把字符串塞进数字字段”的歧义；数值走既有默认/类型逻辑。
//
// 为什么 fail-closed（不猜默认值、不静默降级）：
//   * `python_bin` 猜错 = 起错解释器；`converter_dir` 猜错 = 在错误目录起子进程；
//     `allowed_roots` 猜错/放宽 = 越界读取。这三者任何一个“猜一个默认值”都比启动失败更危险。
//   * 因此：未定义（含空白）变量 → **逐条 issue 并点名字段与变量名**，该字段视为缺失，
//     最终 `resolved: null`（工具层转成 `NOT_CONFIGURED`，不返回假数据）；
//     非法 `${...}` 形态（`${}`、`${1ABC}`、`${NAME` 未闭合）→ 同样 issue + fail-closed。
//   * issue 里**只出现变量名，不出现环境变量的值**——否则 secret/机器路径会经错误信息外泄（R7）。
//   * 展开发生在既有校验（必填 / 绝对路径 / allowed_roots 非空）**之前**：展开后的值仍要过
//     同样的校验，绝不因为“来自环境变量”就放宽。
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
  /** 单份超时（毫秒），默认 {@link DEFAULT_TIMEOUT_MS}（必须与产品 profile 一致，见下）。 */
  readonly timeout_ms?: number
}

/** 解析后的配置（已填默认值）。 */
export interface ResolvedConverterConfig {
  readonly python_bin: string
  readonly converter_dir: string
  readonly allowed_roots: readonly string[]
  readonly timeout_ms: number
}

/**
 * 单份文档读取的默认超时。
 *
 * **这个值必须与产品 profile 的 `recruitment.converter.timeout_ms` 相同**
 * （`dsh/profile/recruitment/cordis.patch.yml`），由
 * `test/unit/converter-default-timeout.test.ts` 机检；两者一旦分叉，未读 profile 的调用方
 * 会用更短的预算把慢文档误判成 `TIMEOUT`——D-99 的假失败就是这么来的（60s 口径下
 * 真实语料里有单份要 127s）。
 *
 * 为什么是 180s 而不是更短：D-98 的整页 OCR 兜底让单份最慢可达 127s（高并发），
 * 180s 留了约 50s 余量。
 */
export const DEFAULT_TIMEOUT_MS = 180_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * 环境变量表（与 `process.env` 同形）。
 *
 * `undefined` 与「trim 后为空串」都算**未定义**：空值不是路径，不能当默认值用。
 */
export type EnvMap = Readonly<Record<string, string | undefined>>

/** 一个字符串的 `${ENV}` 展开结果（纯函数，不抛异常）。 */
export interface EnvExpansion {
  /** 已展开的字符串；未定义/非法的引用不写入值（由调用方 fail-closed）。 */
  readonly expanded: string
  /** 未定义或空白的环境变量名：去重、按首次出现顺序。 */
  readonly missing: readonly string[]
  /** 是否出现非法 `${...}` 形态（空名 / 非法字符 / 未闭合）。 */
  readonly invalid: boolean
}

/** 合法的环境变量引用：`${NAME}`，NAME = `[A-Za-z_][A-Za-z0-9_]*`。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 展开字符串里的 `${NAME}` 引用（单遍，不递归）。
 *
 * 语法边界（有意保守）：
 *   * 只有 `$` 后面紧跟 `{` 才视为一次「引用尝试」；其它 `$` 是字面量（`$HOME` 保持原样）。
 *   * `${` 开始后必须在本字符串内遇到 `}` 且中间是合法 NAME，否则记 `invalid`（不吞掉、不猜测）。
 *   * 不做 shell 语法：不支持 `$NAME`（无花括号）、`${NAME:-default}`、`${NAME}x` 之外的拼接特例。
 *
 * @param value - 待展开字符串（不做 trim）。
 * @param env - 环境变量表；默认 `process.env`（既有调用方行为不变）。
 * @returns 展开结果；缺失/非法只报告，不抛异常。
 */
export function expandEnvReferences(value: string, env: EnvMap = process.env): EnvExpansion {
  const missing: string[] = []
  const seen = new Set<string>()
  let invalid = false
  let expanded = ''
  let index = 0
  while (index < value.length) {
    const char = value[index]
    if (char !== '$' || value[index + 1] !== '{') {
      expanded += char
      index += 1
      continue
    }
    const close = value.indexOf('}', index + 2)
    if (close < 0) {
      // 未闭合：`${NAME`——fail-closed，不把后面的内容猜成变量名。
      invalid = true
      expanded += value.slice(index)
      break
    }
    const name = value.slice(index + 2, close)
    if (!ENV_NAME.test(name)) {
      // `${}` / `${1ABC}` / `${A-B}`：形态非法，同样 fail-closed。
      invalid = true
      expanded += value.slice(index, close + 1)
      index = close + 1
      continue
    }
    const raw = env[name]
    const resolved = typeof raw === 'string' ? raw.trim() : ''
    if (resolved === '') {
      // 未定义 / 空白：不回填 `${NAME}`，也不猜默认值。
      if (!seen.has(name)) {
        seen.add(name)
        missing.push(name)
      }
    } else {
      expanded += resolved
    }
    index = close + 1
  }
  return { expanded, missing, invalid }
}

/** 展开单个字段；缺失/非法时逐条记 issue（issue 只点名变量，不含其值）。 */
function expandConfigField(
  field: string,
  raw: string | undefined,
  env: EnvMap,
  issues: string[],
): { value: string; failed: boolean } {
  if (typeof raw !== 'string') return { value: '', failed: false }
  const expansion = expandEnvReferences(raw, env)
  let failed = false
  if (expansion.invalid) {
    failed = true
    issues.push(
      `${field} has a malformed \${...} reference (only \${NAME} with ` +
        `[A-Za-z_][A-Za-z0-9_]* is allowed): refusing to guess a default`,
    )
  }
  for (const name of expansion.missing) {
    failed = true
    issues.push(
      `${field} references undefined environment variable \${${name}}: refusing to guess a default`,
    )
  }
  return { value: expansion.expanded.trim(), failed }
}

/**
 * 校验并补默认值；配置不完整时返回 issues，由调用方决定 fail-closed。
 *
 * 白名单字段（`python_bin` / `converter_dir` / `allowed_roots`）先做 `${ENV}` 展开，
 * 再走与改动前完全相同的校验；`timeout_ms` 与非白名单字段**不展开**。
 *
 * @param config - 插件配置（来自 cordis.patch.yml 的 config 段）。
 * @param env - 环境变量表；默认 `process.env`（保持既有调用方行为不变，测试可注入）。
 * @returns 解析结果或逐条 issue（resolved:null）。
 */
export function resolveConverterConfig(
  config: ConverterConfig,
  env: EnvMap = process.env,
): {
  resolved: ResolvedConverterConfig | null
  issues: readonly string[]
} {
  const issues: string[] = []
  const pythonField = expandConfigField('config.python_bin', config.python_bin, env, issues)
  const dirField = expandConfigField('config.converter_dir', config.converter_dir, env, issues)
  const rootFields = (config.allowed_roots ?? []).map((root, index) =>
    expandConfigField(`config.allowed_roots[${index}]`, root, env, issues),
  )
  const roots = rootFields.map((field) => field.value).filter((root) => root !== '')
  const rootFailed = rootFields.some((field) => field.failed)

  if (pythonField.value === '' && !pythonField.failed) issues.push('config.python_bin is required')
  if (dirField.value === '' && !dirField.failed) issues.push('config.converter_dir is required')
  if (roots.length === 0 && !rootFailed) {
    issues.push('config.allowed_roots must list at least one readable root')
  }
  if (pythonField.value !== '' && !pythonField.failed && !isAbsolute(pythonField.value)) {
    issues.push('config.python_bin must be absolute')
  }
  if (dirField.value !== '' && !dirField.failed && !isAbsolute(dirField.value)) {
    issues.push('config.converter_dir must be absolute')
  }
  if (issues.length > 0) return { resolved: null, issues }
  const timeout = config.timeout_ms
  return {
    resolved: {
      python_bin: pythonField.value,
      converter_dir: dirField.value,
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
