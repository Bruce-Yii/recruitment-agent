/**
 * 测试用的仓库内路径与 Python 解释器解析。
 *
 * **为什么要有这个文件**：测试里曾硬编码 `D:\12412\...\converter\corpus\synthetic\zero_text.pdf`
 * 和 `D:\Python3.12.9\python.exe`。本机绿，Linux CI 必然 `ENOENT`——真实 CI 首次运行时
 * 就是这么红的（`stat 'D:\12412\...\zero_text.pdf'`）。路径必须从仓库位置派生。
 *
 * Python 解析顺序（跨平台）：
 *   1. `RECRUITMENT_PYTHON` 环境变量（显式覆盖，CI 与本机都可以设）
 *   2. `python3`
 *   3. `python`
 * 找不到不抛错——由调用方按各自语义决定 skip 还是 fail（**不许静默当成通过**）。
 */
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 仓库根（本文件在 `<repo>/dsh/dsh-recruitment/test/helpers/`）。 */
export const REPO_ROOT = resolve(here, '..', '..', '..', '..')

/** `converter/` 目录（PyMuPDF 读取器所在）。 */
export const CONVERTER_DIR = join(REPO_ROOT, 'converter')

/** 合成语料目录（多数读取/接入测试的 allowed_root）。 */
export const SYNTHETIC_DIR = join(CONVERTER_DIR, 'corpus', 'synthetic')

/** 插件包根（`dsh/dsh-recruitment`）。 */
export const PLUGIN_ROOT = resolve(here, '..', '..')

/** 一个合成语料文件的绝对路径（按仓库位置派生，不写死盘符）。 */
export const syntheticPath = (name: string): string => join(SYNTHETIC_DIR, name)

/** 候选 Python 解释器（按优先级）。 */
export const PYTHON_CANDIDATES: readonly string[] = [
  process.env.RECRUITMENT_PYTHON,
  'python3',
  'python',
].filter((candidate): candidate is string => typeof candidate === 'string' && candidate !== '')

/**
 * 在 PATH 里把一个命令名解析成**绝对路径**。
 *
 * `resolveConverterConfig` 要求 `python_bin` 是绝对路径（这是有意的 fail-closed），
 * 所以不能直接把 `python3` 这个命令名塞进去——否则配置解析失败、工具降级成
 * NOT_CONFIGURED，测试会以"读不到文件"的形式红（CI 首次运行就是这么红的）。
 */
function whichOnPath(command: string): string | undefined {
  if (command.includes('/') || command.includes('\\')) return existsSync(command) ? command : undefined
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** 解析出的绝对 Python 路径；找不到时为 `undefined`（调用方自行决定 skip 还是 fail）。 */
export const PYTHON_BIN: string | undefined = PYTHON_CANDIDATES
  .map((candidate) => whichOnPath(candidate))
  .find((candidate): candidate is string => candidate !== undefined)

/** 合成语料是否可用（目录存在）。 */
export const SYNTHETIC_AVAILABLE = existsSync(SYNTHETIC_DIR)
