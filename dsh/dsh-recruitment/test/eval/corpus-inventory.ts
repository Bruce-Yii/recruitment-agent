// Issue #63 Phase 1 — 私有真简历盘点脚手架（对齐 docs/42 §4 / §7.1）。
// 扫描 $RECRUITMENT_CORPUS_ROOT/raw/ 统计格式与版式信号，辅助 10 分钟分出 Tier A / B / C；
// 未配置或空目录时诚实返回 CORPUS_ROOT_MISSING / CORPUS_EMPTY，绝不伪造样本。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

export type CorpusInventoryStatus = 'READY' | 'CORPUS_ROOT_MISSING' | 'CORPUS_EMPTY'

export interface CorpusFileSignal {
  readonly relativePath: string
  readonly ext: string
  readonly sizeBytes: number
  readonly estimatedPages?: number
  readonly likelyScannedPdf?: boolean
  readonly suggestedTier: 'tier_a_layout_hell' | 'tier_b_borderline' | 'tier_c_bulk'
}

export interface CorpusInventoryResult {
  readonly status: CorpusInventoryStatus
  readonly scanDir?: string
  readonly message: string
  readonly totalFiles: number
  readonly byExtension: Readonly<Record<string, number>>
  readonly likelyScannedCount: number
  readonly suggestedCounts: {
    readonly tier_a_layout_hell: number
    readonly tier_b_borderline: number
    readonly tier_c_bulk: number
  }
  readonly files: readonly CorpusFileSignal[]
}

const SUPPORTED_EXTS = new Set(['.pdf', '.docx', '.doc', '.txt', '.md'])

function walkFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(full, out)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (SUPPORTED_EXTS.has(ext)) out.push(full)
    }
  }
}

function inspectPdfHeuristic(filePath: string): { readonly estimatedPages: number; readonly likelyScannedPdf: boolean } {
  const buf = readFileSync(filePath)
  const latin = buf.subarray(0, Math.min(buf.length, 512 * 1024)).toString('latin1')
  const pageMatches = latin.match(/\/Type\s*\/Page\b/g)
  const estimatedPages = pageMatches ? pageMatches.length : 1
  const hasFont = /\/Font\b/.test(latin)
  const hasImage = /\/Subtype\s*\/Image\b/.test(latin)
  return { estimatedPages, likelyScannedPdf: !hasFont && hasImage }
}

export function scanPrivateCorpusInventory(corpusRoot?: string): CorpusInventoryResult {
  const root = (corpusRoot ?? process.env.RECRUITMENT_CORPUS_ROOT ?? '').trim()
  const emptySuggested = { tier_a_layout_hell: 0, tier_b_borderline: 0, tier_c_bulk: 0 }

  if (root === '' || !existsSync(root)) {
    return {
      status: 'CORPUS_ROOT_MISSING',
      message: '未配置 RECRUITMENT_CORPUS_ROOT 或目录不存在，已跳过私有真简历盘点（绝不伪造样本）。',
      totalFiles: 0,
      byExtension: {},
      likelyScannedCount: 0,
      suggestedCounts: emptySuggested,
      files: [],
    }
  }

  const rawDir = join(root, 'raw')
  const scanDir = existsSync(rawDir) ? rawDir : root
  const discovered: string[] = []
  walkFiles(scanDir, discovered)
  discovered.sort()

  if (discovered.length === 0) {
    return {
      status: 'CORPUS_EMPTY',
      scanDir,
      message: `目录 ${scanDir} 中未发现支持的简历文件（.pdf/.docx/.doc/.txt/.md）。`,
      totalFiles: 0,
      byExtension: {},
      likelyScannedCount: 0,
      suggestedCounts: emptySuggested,
      files: [],
    }
  }

  const byExtension: Record<string, number> = {}
  let likelyScannedCount = 0
  let tierA = 0
  let tierB = 0
  let tierC = 0
  const files: CorpusFileSignal[] = []

  for (const fullPath of discovered) {
    const ext = extname(fullPath).toLowerCase()
    byExtension[ext] = (byExtension[ext] ?? 0) + 1
    const sizeBytes = statSync(fullPath).size

    let estimatedPages: number | undefined
    let likelyScannedPdf: boolean | undefined
    if (ext === '.pdf') {
      const info = inspectPdfHeuristic(fullPath)
      estimatedPages = info.estimatedPages
      likelyScannedPdf = info.likelyScannedPdf
      if (likelyScannedPdf) likelyScannedCount += 1
    }

    let suggestedTier: CorpusFileSignal['suggestedTier'] = 'tier_c_bulk'
    if (likelyScannedPdf || (estimatedPages !== undefined && estimatedPages >= 4) || ext === '.doc') {
      suggestedTier = 'tier_a_layout_hell'
      tierA += 1
    } else if (tierB < 30) {
      suggestedTier = 'tier_b_borderline'
      tierB += 1
    } else {
      tierC += 1
    }

    files.push({
      relativePath: relative(scanDir, fullPath).replaceAll('\\', '/'),
      ext,
      sizeBytes,
      ...(estimatedPages !== undefined ? { estimatedPages } : {}),
      ...(likelyScannedPdf !== undefined ? { likelyScannedPdf } : {}),
      suggestedTier,
    })
  }

  return {
    status: 'READY',
    scanDir,
    message: `盘点完成：共 ${files.length} 份文件，疑似扫描 PDF ${likelyScannedCount} 份。`,
    totalFiles: files.length,
    byExtension,
    likelyScannedCount,
    suggestedCounts: {
      tier_a_layout_hell: tierA,
      tier_b_borderline: tierB,
      tier_c_bulk: tierC,
    },
    files,
  }
}
