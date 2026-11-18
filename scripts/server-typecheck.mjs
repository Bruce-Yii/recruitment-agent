// 服务端类型检查棘轮（D-156）。
//
// 背景：仓库的 `tsconfig.json` 只 include `src/client/**`（客户端构建用），所以历史上
// `npx tsc --noEmit` **从不检查服务端**，导致 `src/**` 长期带伤（2026-11-19 首测 42 个错误）。
//
// 本脚本用 `tsconfig.server.json` 检查 `src/**`（排除 client），把错误数与本文件下方的
// BASELINE 比较：**只许降，不许升**。要涨必须先改 docs/17 台账（同 runtime-budget 口径）。
//
// 用法：node scripts/server-typecheck.mjs [--update]
//   --update 只用于"降低基线"或"已获台账授权的一次性上调"，会改写自身 BASELINE 常量。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dsh', 'dsh-recruitment')
const SELF = fileURLToPath(import.meta.url)

/** 当前允许的错误数上限（只许降）。 */
const BASELINE = 32

let output = ''
try {
  output = execFileSync('npx', ['tsc', '-p', 'tsconfig.server.json'], { cwd: ROOT, encoding: 'utf8', shell: true })
} catch (error) {
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`
}

const errors = output.split(/\r?\n/).filter((line) => /error TS\d+/.test(line))
const count = errors.length
const files = new Set(errors.map((line) => line.split('(')[0]))

if (process.argv.includes('--update')) {
  const source = readFileSync(SELF, 'utf8').replace(/const BASELINE = \d+/, `const BASELINE = ${count}`)
  writeFileSync(SELF, source, 'utf8')
  console.log(`server-typecheck: 基线已更新为 ${count}`)
  process.exit(0)
}

if (count > BASELINE) {
  console.error(`server-typecheck: 超基线 ${count} > ${BASELINE}（涉及 ${files.size} 个文件）`)
  for (const line of errors.slice(0, 15)) console.error(`  ${line}`)
  console.error('先修到 ≤ 基线；确有正当理由要上调，必须先在 docs/17 追加台账修订。')
  process.exit(1)
}

console.log(`server-typecheck: PASS（${count} / 上限 ${BASELINE}）`)
