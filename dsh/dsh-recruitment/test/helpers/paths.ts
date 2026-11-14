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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
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

/**
 * 一个合成语料文件的绝对路径（按仓库位置派生，不写死盘符）。
 *
 * **为什么这个函数要负责"保证文件存在"**：`converter/corpus/synthetic/*.pdf` 被
 * `.gitignore` 挡着（合成难例体积大、且 `platform_noise.pdf` 里其实是真实个人资料，
 * R7 禁止入库），所以**干净检出里一个合成 PDF 都没有**。真实 CI 首次运行就是这么红的：
 * 本机恰好有 `zero_text.pdf` 所以绿，Linux runner 上 `ENOENT: stat '.../zero_text.pdf'`，
 * 一次连坐 20 多条测试。把"夹具到底在不在"这件事留在每个测试里各判一次，等于让每个
 * 测试都有机会"因为本机有文件而绿"。
 *
 * 现在的规则只有两条，写在唯一一处：
 *   1. 文件在 → 直接用。
 *   2. 文件不在、但这个夹具**能在没有真实语料的前提下确定性重建**（见 `REGENERABLE`）
 *      → 当场重建再返回。重建不了（例如 `platform_noise.pdf` 需要真实简历、`image_only_*`
 *      需要真实语料）→ **原样返回不存在的路径**，让调用方照旧 fail。
 *      绝不返回一个"看起来能用"的假文件，也绝不 skip（R3：skip ≠ pass）。
 */
export const syntheticPath = (name: string): string => {
  const path = join(SYNTHETIC_DIR, name)
  if (existsSync(path)) return path

  const script = REGENERABLE[name]
  if (script === undefined) return path

  if (PYTHON_BIN === undefined) {
    throw new Error(
      `syntheticPath: ${name} 不在仓库里，需要 Python + PyMuPDF 才能重建，但 PATH 上找不到 python3/python`
      + `（可用 RECRUITMENT_PYTHON 指定绝对路径）。这不是 skip 的理由。`,
    )
  }
  mkdirSync(SYNTHETIC_DIR, { recursive: true })
  // 路径走 argv 而不是拼进脚本字符串：Windows 盘符里的 `\` 在 Python 字面量里是转义。
  execFileSync(PYTHON_BIN, ['-c', script, path], { stdio: 'pipe' })
  if (!existsSync(path)) {
    throw new Error(`syntheticPath: 重建 ${name} 失败（脚本跑完文件仍不存在）`)
  }
  return path
}

/**
 * 能在**没有真实语料**的前提下确定性重建的合成夹具 → 重建脚本。
 *
 * 只登记这一类：`converter/corpus/build_synthetic.py` 里**不依赖真实简历**的那几段。
 * `zero_text.pdf` 原文就是 `fitz.open(); new_page(); save()`——一页空白，无文字无图片，
 * 与真实语料无关，所以可以随时重建（本机 518 字节）。
 * 其余合成难例（image_only / encrypted / corrupted / platform_noise）都要真实简历做原料，
 * **故意不登记**：它们缺了就该红，不该被伪造出来。
 */
const REGENERABLE: Readonly<Record<string, string>> = {
  'zero_text.pdf': [
    'import sys, fitz',
    'doc = fitz.open()',
    'doc.new_page()',
    'doc.save(sys.argv[1])',
    'doc.close()',
  ].join('\n'),
}


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
