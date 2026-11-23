// Eval V2 — 私有真简历盘点脚手架（修复 Issue #92 P1-4：魔数校验、加密检测、压缩流检测、全文件头尾扫描防字体误报）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

export type CorpusInventoryStatus = 'READY' | 'CORPUS_ROOT_MISSING' | 'CORPUS_EMPTY'

export interface CorpusFileSignal {
  readonly relativePath: string
  readonly ext: string
  readonly sizeBytes: number
  readonly estimatedPages?: number
  readonly likelyScannedPdf?: boolean
  readonly encryptedPdf?: boolean
  readonly corruptedPdf?: boolean
  readonly hasObjectStreams?: boolean
  readonly suggestedTier: 'tier_a_layout_hell' | 'tier_b_borderline' | 'tier_c_bulk'
}

export interface CorpusInventoryResult {
  readonly status: CorpusInventoryStatus
  readonly scanDir?: string
  readonly message: string
  readonly totalFiles: number
  readonly byExtension: Readonly<Record<string, number>>
  readonly likelyScannedCount: number
  readonly anomalousPdfCount: number
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
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) out.push(full)
  }
}

function inspectPdfHeuristic(filePath: string): {
  readonly estimatedPages: number
  readonly likelyScannedPdf: boolean
  readonly encryptedPdf: boolean
  readonly corruptedPdf: boolean
  readonly hasObjectStreams: boolean
} {
  const buf = readFileSync(filePath)
  const head = buf.subarray(0, Math.min(buf.length, 16)).toString('latin1')
  if (!head.startsWith('%PDF-')) {
    return { estimatedPages: 0, likelyScannedPdf: false, encryptedPdf: false, corruptedPdf: true, hasObjectStreams: false }
  }
  // 同时扫描全量（≤ 4MB）或头+尾各 1MB，避免字体定义在文件后部导致假扫描误报
  const latin =
    buf.length <= 4 * 1024 * 1024
      ? buf.toString('latin1')
      : buf.subarray(0, 1024 * 1024).toString('latin1') + '\n' + buf.subarray(buf.length - 1024 * 1024).toString('latin1')

  const encryptedPdf = /\/Encrypt\b/.test(latin)
  const hasObjectStreams = /\/ObjStm\b/.test(latin)
  const pageMatches = latin.match(/\/Type\s*\/Page\b/g)
  const estimatedPages = pageMatches ? pageMatches.length : hasObjectStreams ? 0 : 1
  const hasFont = /\/Font\b/.test(latin)
  const hasImage = /\/Subtype\s*\/Image\b/.test(latin)
  const likelyScannedPdf = !encryptedPdf && !hasObjectStreams && !hasFont && hasImage

  return { estimatedPages, likelyScannedPdf, encryptedPdf, corruptedPdf: false, hasObjectStreams }
}

export function scanPrivateCorpusInventory(corpusRoot?: string): CorpusInventoryResult {
  const root = (corpusRoot ?? process.env.RECRUITMENT_CORPUS_ROOT ?? '').trim()
  const emptySuggested = { tier_a_layout_hell: 0, tier_b_borderline: 0, tier_c_bulk: 0 }

  if (root === '' || !existsSync(root)) {
    return {
      status: 'CORPUS_ROOT_MISSING',
      message: '未配置 RECRUITMENT_CORPUS_ROOT 或目录不存在，已跳过私有真简历盘点（绝不伪造样本）。',
      totalFiles: 0, byExtension: {}, likelyScannedCount: 0, anomalousPdfCount: 0, suggestedCounts: emptySuggested, files: [],
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
      totalFiles: 0, byExtension: {}, likelyScannedCount: 0, anomalousPdfCount: 0, suggestedCounts: emptySuggested, files: [],
    }
  }

  const byExtension: Record<string, number> = {}
  let likelyScannedCount = 0
  let anomalousPdfCount = 0
  let tierA = 0, tierB = 0, tierC = 0
  const files: CorpusFileSignal[] = []

  for (const fullPath of discovered) {
    const ext = extname(fullPath).toLowerCase()
    byExtension[ext] = (byExtension[ext] ?? 0) + 1
    const sizeBytes = statSync(fullPath).size

    let estimatedPages: number | undefined
    let likelyScannedPdf: boolean | undefined
    let encryptedPdf: boolean | undefined
    let corruptedPdf: boolean | undefined
    let hasObjectStreams: boolean | undefined
    if (ext === '.pdf') {
      const info = inspectPdfHeuristic(fullPath)
      estimatedPages = info.estimatedPages
      likelyScannedPdf = info.likelyScannedPdf
      encryptedPdf = info.encryptedPdf
      corruptedPdf = info.corruptedPdf
      hasObjectStreams = info.hasObjectStreams
      if (likelyScannedPdf) likelyScannedCount += 1
      if (encryptedPdf || corruptedPdf || hasObjectStreams) anomalousPdfCount += 1
    }

    let suggestedTier: CorpusFileSignal['suggestedTier'] = 'tier_c_bulk'
    if (likelyScannedPdf || encryptedPdf || corruptedPdf || hasObjectStreams || (estimatedPages !== undefined && estimatedPages >= 4) || ext === '.doc') {
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
      ...(encryptedPdf ? { encryptedPdf } : {}),
      ...(corruptedPdf ? { corruptedPdf } : {}),
      ...(hasObjectStreams ? { hasObjectStreams } : {}),
      suggestedTier,
    })
  }

  return {
    status: 'READY',
    scanDir,
    message: `盘点完成：共 ${files.length} 份文件，疑似扫描 PDF ${likelyScannedCount} 份，异常/加密/压缩流 PDF ${anomalousPdfCount} 份。`,
    totalFiles: files.length,
    byExtension,
    likelyScannedCount,
    anomalousPdfCount,
    suggestedCounts: { tier_a_layout_hell: tierA, tier_b_borderline: tierB, tier_c_bulk: tierC },
    files,
  }
}
