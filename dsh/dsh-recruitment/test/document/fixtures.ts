// 合成 fixture 的 TS 侧入口（**不是**测试文件：文件名不含 .test，本身不做断言）。
//
// 责任只有三件：
//   1. 找到一台「装了 PyMuPDF + python-docx + Pillow」的 Python（跨平台，不写死盘符）；
//   2. 跑 `test/document/fixtures/generate.py`，把 manifest 读回来；
//   3. 用**纯 JS** 复核文件本身（页数 / 像素 / magic / sha256），不复用生成器自己的结论。
//
// 全部惰性：本模块被导入时不读文件、不起子进程。`node --test` 的全量发现会把
// `test/**` 下的非测试文件也加载一遍，顶层副作用会变成莫名其妙的失败。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本目录（test/document）。 */
export const TEST_DOCUMENT_DIR = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录（dsh/dsh-recruitment）。 */
export const PACKAGE_ROOT = resolve(TEST_DOCUMENT_DIR, '..', '..')

/** 仓库根目录（recruitment-agent）。 */
export const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')

/** converter/ 目录（PyMuPDF 读取器所在）。 */
export const CONVERTER_DIR = join(REPO_ROOT, 'converter')

/** 生成器脚本。 */
export const GENERATOR_SCRIPT = join(TEST_DOCUMENT_DIR, 'fixtures', 'generate.py')

/** Python 探测结果。 */
export interface PythonResolution {
  /** 可执行文件名或绝对路径。 */
  readonly bin: string
  /** 三个库都能 import。 */
  readonly ok: boolean
  /** 不行时的原因（给测试报错用，不静默 skip）。 */
  readonly reason: string
}

const REQUIRED_MODULES_CHECK = 'import fitz, docx, PIL; print("ok")'

/**
 * 找一台能跑生成器的 Python。
 *
 * 顺序：`$RECRUITMENT_PYTHON` → `$DOCUMENT_FIXTURES_PYTHON` → `python3` → `python`。
 * **不写死 `D:\Python3.12.9\python.exe`**（仓库里几个旧测试是那么写的，本 lane 不复制这个缺陷）。
 * 每个候选都真跑一次 `import fitz, docx, PIL`，只有三个库都装上的才算数。
 */
export function resolvePython(): PythonResolution {
  const candidates: string[] = []
  for (const key of ['RECRUITMENT_PYTHON', 'DOCUMENT_FIXTURES_PYTHON'] as const) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value.trim())
  }
  candidates.push('python3', 'python')
  const failures: string[] = []
  for (const bin of candidates) {
    try {
      const out = execFileSync(bin, ['-c', REQUIRED_MODULES_CHECK], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      if (out.trim() === 'ok') {
        // PATH 上的 `python3` / `python` 是相对命令名；converter 配置要求绝对路径，
        // 所以返回解释器自己解析出的 sys.executable，而不是把候选命令名原样交出去。
        const executable = execFileSync(bin, ['-c', 'import sys; print(sys.executable)'], {
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).trim()
        if (!isAbsolute(executable)) {
          failures.push(`${bin}: sys.executable is not absolute: ${JSON.stringify(executable)}`)
          continue
        }
        return { bin: executable, ok: true, reason: '' }
      }
      failures.push(`${bin}: unexpected probe output ${JSON.stringify(out.trim())}`)
    } catch (error) {
      failures.push(`${bin}: ${error instanceof Error ? firstLine(error.message) : String(error)}`)
    }
  }
  return {
    bin: candidates[0] ?? 'python',
    ok: false,
    reason: `no Python with PyMuPDF + python-docx + Pillow found (tried ${candidates.join(', ')}). ${failures.join(' | ')}`,
  }
}

/** 压成一行，避免把整段 PowerShell/CMD 噪音塞进断言消息。 */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '')
  return line ?? text
}

/** manifest 里的一条文件记录。 */
export interface FixtureEntry {
  readonly name: string
  readonly kind: string
  readonly media_type: string
  readonly bytes: number
  readonly sha256: string
  readonly expected: Readonly<Record<string, unknown>>
  readonly observed: Readonly<Record<string, unknown>>
}

/** generate.py 产出的 manifest。 */
export interface FixtureManifest {
  readonly version: number
  readonly generator: string
  readonly dir: string
  readonly ordering: readonly string[]
  readonly files: readonly FixtureEntry[]
  readonly self_check: Readonly<Record<string, unknown>>
}

/** 已生成的 fixture 集合。 */
export interface Fixtures {
  readonly dir: string
  readonly manifest: FixtureManifest
  readonly python: PythonResolution
}

let cached: Fixtures | null = null

/**
 * 生成一次 fixture 并在同一进程内复用（同一个测试文件里的多个用例共享）。
 * @param dest - 目标目录；缺省在 `os.tmpdir()` 下新建一个临时目录。
 */
export function ensureFixtures(dest?: string): Fixtures {
  if (cached !== null && dest === undefined) return cached
  const python = resolvePython()
  if (!python.ok) throw new Error(python.reason)
  const target = dest ?? mkdtempSync(join(tmpdir(), 'recruitment-document-fixtures-'))
  execFileSync(python.bin, [GENERATOR_SCRIPT, target], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  })
  const manifestPath = join(target, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`generator did not write ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureManifest
  cached = { dir: target, manifest, python }
  return cached
}

/** 某个 fixture 的绝对路径。 */
export function fixturePath(fixtures: Fixtures, name: string): string {
  return join(fixtures.dir, name)
}

/** manifest 里按名字取一条。 */
export function fixtureEntry(fixtures: Fixtures, name: string): FixtureEntry {
  const entry = fixtures.manifest.files.find((item) => item.name === name)
  if (entry === undefined) throw new Error(`fixture ${name} is missing from the manifest`)
  return entry
}

/** 文件的 sha256（Node 自己算，不采信生成器）。 */
export function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 纯 JS 数 PDF 页：数 `/Type /Page` 对象（排除 `/Pages`）。
 * 故意不调用 PDF 解析器 —— 这是对生成器的**独立**复核。
 */
export function pdfPageCount(bytes: Buffer): number {
  const text = bytes.toString('latin1')
  const matches = text.match(/\/Type\s*\/Page[^s]/g)
  return matches === null ? 0 : matches.length
}

/** 纯 JS 读 PNG 尺寸（IHDR：签名 8 字节 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4）。 */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = bytes.subarray(0, 8)
  if (signature.toString('latin1') !== '\x89PNG\r\n\x1a\n') return null
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** 纯 JS 读 JPEG 尺寸（扫 SOF0/1/2/… 段）。 */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1] as number
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = bytes.readUInt16BE(offset + 2)
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrameHeader) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
    }
    offset += 2 + length
  }
  return null
}
