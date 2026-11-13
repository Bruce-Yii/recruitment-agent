// 真实简历门槛 · 第一步：对一批真实简历跑 document_read（U3 统一入口），
// 记录每份的读取结果与质量判定。**不调模型**，所以这一步只证明"读得对不对"。
import { readFileSync, writeFileSync } from 'node:fs'
import { createDocumentReadTool } from '../src/tools/document-read.ts'

const batchName = process.argv[2] ?? 'B1'
const batches = JSON.parse(
  readFileSync('./evidence/experiments/2026-11-14-real-resume-gate/batches.json', 'utf8'),
)
const files = batches[batchName] ?? []

const tool = createDocumentReadTool({
  python_bin: 'D:\\Python3.12.9\\python.exe',
  converter_dir: 'D:\\12412\\dsh工作区\\projects\\recruitment-agent\\converter',
  allowed_roots: ['D:\\12412\\dsh工作区\\projects\\resume-talent-pool'],
  timeout_ms: 90_000,
})

const rows = []
for (const [index, file] of files.entries()) {
  const startedAt = Date.now()
  try {
    const value = await tool.execute({ path: file.path })
    rows.push({
      index: index + 1,
      file: file.path.split('\\').pop(),
      sha: file.sha,
      kb: file.kb,
      ok: true,
      media_type: value.media_type,
      reader: `${value.reader_id}@${value.reader_version}`,
      completeness: value.completeness,
      blocking: value.assessment.blocking,
      blocking_codes: value.assessment.blocking_codes,
      soft_codes: value.assessment.soft_codes,
      pages: value.page_count,
      chars: value.source_chars,
      blocks: value.blocks.length,
      next: value.recovery.next,
      ms: Date.now() - startedAt,
    })
    console.log(`[${index + 1}/${files.length}] OK   ${file.path.split('\\').pop()} -> ${value.completeness} blocking=${value.assessment.blocking} pages=${value.page_count} chars=${value.source_chars}`)
  } catch (error) {
    rows.push({
      index: index + 1,
      file: file.path.split('\\').pop(),
      sha: file.sha,
      kb: file.kb,
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      ms: Date.now() - startedAt,
    })
    console.log(`[${index + 1}/${files.length}] FAIL ${file.path.split('\\').pop()} -> ${error instanceof Error ? error.message.slice(0, 120) : error}`)
  }
}

const out = `./evidence/experiments/2026-11-14-real-resume-gate/${batchName}-read.json`
writeFileSync(out, JSON.stringify(rows, null, 1))
const ok = rows.filter((row) => row.ok).length
console.log(`\n${batchName}: ${ok}/${rows.length} 读成功`)
console.log('completeness 分布:', JSON.stringify(rows.filter(r => r.ok).reduce((acc, r) => { acc[r.completeness] = (acc[r.completeness] ?? 0) + 1; return acc }, {})))
console.log('blocking 数:', rows.filter(r => r.ok && r.blocking).length, '/', ok)
