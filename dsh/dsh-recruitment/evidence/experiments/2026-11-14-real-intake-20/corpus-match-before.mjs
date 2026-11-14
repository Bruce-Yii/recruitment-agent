// 只读复算："开工前库里到底有几份真实语料？"（可复现，不依赖记忆）
//
// 输入：
//   db-before.txt        —— 开工前只读读回；其中 intake_asset 行给出 sha12 前缀
//   corpus-inventory.txt —— 语料 48 份去重文档的 label + sha12（本轮生成，不随 DB 变）
// 输出：两份 sha12 集合的交集 = 开工前已在库的真实语料文档。
//
// 用法：node evidence/experiments/2026-11-14-real-intake-20/corpus-match-before.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const before = readFileSync(join(HERE, 'db-before.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith('{"intake_asset_id"'))
  .map((line) => JSON.parse(line))
const corpus = readFileSync(join(HERE, 'corpus-inventory.txt'), 'utf8')
  .split('\n')
  .filter((line) => line.trim().startsWith('{'))
  .map((line) => JSON.parse(line))
const corpusBySha = new Map(corpus.map((row) => [row.sha12, row.label]))

const hits = before.filter((row) => corpusBySha.has(row.sha12))
console.log(`before_intake_asset_rows = ${before.length}`)
console.log(`corpus_docs = ${corpus.length}`)
console.log(`matched_real_corpus_docs_before = ${hits.length}`)
for (const row of hits) {
  console.log(`  ${corpusBySha.get(row.sha12)} sha=${row.sha12} byte_size=${row.byte_size} validation=${row.validation_status}`)
}
const unmatched = before.filter((row) => !corpusBySha.has(row.sha12))
console.log(`non_corpus_rows_before = ${unmatched.length}（合成/夹具，字节数分布：`
  + `${[...new Set(unmatched.map((r) => r.byte_size))].sort((a, b) => Number(a) - Number(b)).join(',')}）`)
