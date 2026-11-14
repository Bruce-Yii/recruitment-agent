// 语料清点（取证脚本，不是产品运行时）：给每份文档算 sha256、去重、并标出是否已在库里。
//
// 只读 DB（select sha256 from intake_asset）。输出**不含**文件名（文件名带真实姓名，R7）：
// 只给脱敏标签 `F01..`、sha256 前缀、扩展名、字节数、是否已在库、是否是重复副本。
//
// 用法：node evidence/experiments/2026-11-14-real-intake-20/corpus-inventory.mjs
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const HERE = dirname(fileURLToPath(import.meta.url))
const CORPUS = resolve('D:\\12412\\dsh工作区\\projects\\resume-talent-pool\\.snap-cache\\research\\content')
const TENANT = '11111111-1111-4111-8111-000000000001'
const EXTS = new Set(['.pdf', '.docx', '.rtf'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXTS.has(extname(full).toLowerCase())) out.push(full)
  }
  return out
}

const files = walk(CORPUS).map((path) => {
  const buf = readFileSync(path)
  return {
    path,
    sha256: createHash('sha256').update(buf).digest('hex'),
    sha12: createHash('sha256').update(buf).digest('hex').slice(0, 12),
    bytes: statSync(path).size,
    ext: extname(path).toLowerCase(),
  }
}).sort((a, b) => a.sha256.localeCompare(b.sha256))

// DB 里已有的 sha256（只读）
const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: process.env.RECRUITMENT_DB_PASSWORD, max: 1,
})
const client = await pool.connect()
const known = await client.query(
  'select sha256 from recruitment.intake_asset where tenant_id = $1', [TENANT])
const knownShas = new Set(known.rows.map((row) => String(row.sha256).toLowerCase()))
client.release()
await pool.end()

const seen = new Map()
const rows = files.map((file, index) => {
  const label = `F${String(index + 1).padStart(2, '0')}`
  const duplicateOf = seen.get(file.sha256) ?? null
  if (duplicateOf === null) seen.set(file.sha256, label)
  return {
    label,
    sha12: file.sha12,
    sha256: file.sha256,
    bytes: file.bytes,
    ext: file.ext,
    duplicate_of: duplicateOf,
    in_db: knownShas.has(file.sha256.toLowerCase()),
    path: file.path,
  }
})

const report = rows.map((row) => JSON.stringify({
  label: row.label, sha12: row.sha12, bytes: row.bytes, ext: row.ext,
  duplicate_of: row.duplicate_of, in_db: row.in_db,
})).join('\n')
writeFileSync(join(HERE, 'corpus-inventory.txt'), `${report}\n`, 'utf8')
// 路径单独落一份到**仓库外**（临时目录）：文件名带真实姓名，按 R7 不能进仓库。
const MAP_DIR = join(tmpdir(), 'recruitment-real-intake-20')
mkdirSync(MAP_DIR, { recursive: true })
writeFileSync(join(MAP_DIR, 'corpus-paths.json'),
  `${JSON.stringify(rows.filter((row) => row.duplicate_of === null), null, 1)}\n`, 'utf8')

const unique = rows.filter((row) => row.duplicate_of === null)
console.log(`files=${rows.length} unique_by_sha256=${unique.length} in_db=${rows.filter((r) => r.in_db).length}`)
console.log('ext 分布(unique):', JSON.stringify(unique.reduce((acc, row) => {
  acc[row.ext] = (acc[row.ext] ?? 0) + 1
  return acc
}, {})))
for (const row of unique) {
  console.log(`${row.label} sha=${row.sha12} ${row.ext} ${row.bytes}B in_db=${row.in_db}`)
}
