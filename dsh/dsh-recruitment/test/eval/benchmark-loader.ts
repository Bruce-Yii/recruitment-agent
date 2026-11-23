// Issue #63 Phase 1 — 外部公开基准加载器契约（对齐 docs/42 §4 / §7.1）。
// 统一从本地 work/eval-cache/<benchmarkId> 读取并校验哈希；缺缓存诚实返回 CACHE_MISSING，零外网硬依赖。
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

export type BenchmarkId =
  | 'jobresqa'
  | 'resumes-raw-pdf'
  | 'chinese-documents-pdf'
  | 'alimeeting'
  | 'aishell-4'
  | 'owasp-llm01'

export interface BenchmarkSpec {
  readonly id: BenchmarkId
  readonly sourceUrl: string
  readonly description: string
}

export const BENCHMARK_REGISTRY: Readonly<Record<BenchmarkId, BenchmarkSpec>> = {
  jobresqa: {
    id: 'jobresqa',
    sourceUrl: 'https://github.com/Avature/jobresqa-benchmark',
    description: 'HR 跨文档问答基准（含中文样本，用于 P2 三态与依据锚定）',
  },
  'resumes-raw-pdf': {
    id: 'resumes-raw-pdf',
    sourceUrl: 'https://huggingface.co/datasets/d4rk3r/resumes-raw-pdf',
    description: '真实原始多页 PDF 简历（用于 P1 解析与逐页渲染）',
  },
  'chinese-documents-pdf': {
    id: 'chinese-documents-pdf',
    sourceUrl: 'https://huggingface.co/datasets/HumynLabs/Chinese_Documents_Dataset_PDF',
    description: '中文复杂版式 PDF（用于 P1 繁简体无乱码抽取）',
  },
  alimeeting: {
    id: 'alimeeting',
    sourceUrl: 'https://www.openslr.org/119/',
    description: '中文多人会议口语转写（用于 P4 噪音与重叠抢话抗性）',
  },
  'aishell-4': {
    id: 'aishell-4',
    sourceUrl: 'https://huggingface.co/datasets/shenyunhang/AISHELL-4',
    description: '中文多说话人会议转写（用于 P4 说话人归属防串台）',
  },
  'owasp-llm01': {
    id: 'owasp-llm01',
    sourceUrl: 'https://genai.owasp.org/llmrisk/llm01-prompt-injection/',
    description: '间接 Prompt 注入对抗载荷（用于 P2/P6 防简历隐写注入）',
  },
}

export interface BenchmarkLoadOptions {
  readonly cacheRoot?: string
  readonly expectedSha256?: string
}

export type BenchmarkLoadResult =
  | {
      readonly status: 'CACHE_MISSING'
      readonly benchmarkId: BenchmarkId
      readonly expectedPath: string
      readonly sourceUrl: string
      readonly downloadHint: string
    }
  | {
      readonly status: 'CHECKSUM_MISMATCH'
      readonly benchmarkId: BenchmarkId
      readonly expectedPath: string
      readonly expectedSha256: string
      readonly actualSha256: string
    }
  | {
      readonly status: 'READY'
      readonly benchmarkId: BenchmarkId
      readonly expectedPath: string
      readonly sourceUrl: string
      readonly fileCount: number
      readonly files: readonly string[]
      readonly sha256: string
    }

function collectSortedFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSortedFiles(full, out)
    else if (entry.isFile()) out.push(full)
  }
}

export function loadCachedBenchmark(
  benchmarkId: BenchmarkId,
  options?: BenchmarkLoadOptions,
): BenchmarkLoadResult {
  const spec = BENCHMARK_REGISTRY[benchmarkId]
  const cacheRoot = resolve(options?.cacheRoot ?? join(process.cwd(), 'work', 'eval-cache'))
  const expectedPath = join(cacheRoot, benchmarkId)

  if (!existsSync(expectedPath)) {
    return {
      status: 'CACHE_MISSING',
      benchmarkId,
      expectedPath,
      sourceUrl: spec.sourceUrl,
      downloadHint: `请将外部基准 ${benchmarkId} 离线准备至 ${expectedPath}（来源：${spec.sourceUrl}）。`,
    }
  }

  const allFiles: string[] = []
  collectSortedFiles(expectedPath, allFiles)
  allFiles.sort()

  if (allFiles.length === 0) {
    return {
      status: 'CACHE_MISSING',
      benchmarkId,
      expectedPath,
      sourceUrl: spec.sourceUrl,
      downloadHint: `缓存目录 ${expectedPath} 为空，请先拉取数据（来源：${spec.sourceUrl}）。`,
    }
  }

  const hash = createHash('sha256')
  const relFiles: string[] = []
  for (const file of allFiles) {
    const rel = relative(expectedPath, file).replaceAll('\\', '/')
    relFiles.push(rel)
    hash.update(rel + '\n')
    hash.update(readFileSync(file))
  }
  const actualSha256 = hash.digest('hex')

  if (options?.expectedSha256 && options.expectedSha256 !== actualSha256) {
    return {
      status: 'CHECKSUM_MISMATCH',
      benchmarkId,
      expectedPath,
      expectedSha256: options.expectedSha256,
      actualSha256,
    }
  }

  return {
    status: 'READY',
    benchmarkId,
    expectedPath,
    sourceUrl: spec.sourceUrl,
    fileCount: relFiles.length,
    files: relFiles,
    sha256: actualSha256,
  }
}
