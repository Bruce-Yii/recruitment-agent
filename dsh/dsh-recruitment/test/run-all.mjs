#!/usr/bin/env node
// 全量测试入口：**显式文件清单**，不依赖 shell 展开、也不把目录当模块加载。
//
// 为什么需要这个文件：
//   1. `node --test test/acceptance/`（目录形式）在 Node 24 + Windows 上会把目录当模块
//      解析 → `Error: Cannot find module '...\test\acceptance'`，exit 1。这是"跑不起来"，
//      不是"没有测试"、更不是"跳过"（R3：skip ≠ pass）。
//   2. 用 shell glob（`node --test "test/**/*.test.ts"`）在 PowerShell / cmd / bash 下
//      行为不一致（谁展开、引号怎么传），CI 与本机容易跑成两套东西。
//
// 做法：用 `fs.globSync` 自己展开 `test/**/*.test.ts`，把**文件列表**交给 `node --test`。
// 跨平台、跨 shell 一致；没有匹配到文件时明确失败，绝不当成"全绿"。
//
// 跑法：
//   node test/run-all.mjs                       # 默认：node --test 的文件级并行
//   node test/run-all.mjs --test-concurrency=1  # 串行（只用于排查；不是默认口径）
//   node test/run-all.mjs test/integration/engine-mechanisms-pg.test.ts   # 传文件 = 只跑这些
//
// 注意：本文件在 `test/` 下，`node --test` 的默认发现规则会把它当测试文件执行一次。
// 所以下面第一行守卫：在测试子进程（NODE_TEST_CONTEXT 已设置）里直接退出，避免递归。
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.NODE_TEST_CONTEXT) {
  // 被 `node --test` 当测试文件发现了：本文件不是测试，什么都不做。
  process.exit(0)
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const only = argv.filter((arg) => !arg.startsWith('-'))
const nodeTestArgs = argv.filter((arg) => arg.startsWith('-'))

const discovered = globSync('test/**/*.test.ts', { cwd: packageRoot }).sort()
const files = only.length > 0 ? only : discovered

if (files.length === 0) {
  console.error('run-all: 没有匹配到任何测试文件（test/**/*.test.ts）——这不算通过。')
  process.exit(1)
}

// Issue #55：eval graders 的正反例单测必须纳入全量套件（不能只靠 eval runner 自证）。
// 显式守护：即便 glob 规则未来被改窄，漏掉这个文件也会红，而不是悄悄少跑。
if (only.length === 0 && !discovered.some((file) => file.replaceAll('\\', '/') === 'test/eval/graders.test.ts')) {
  console.error('run-all: 缺少 test/eval/graders.test.ts（Issue #55 评测判据单测）——不算通过。')
  process.exit(1)
}

// P1-6：自动打印环境指纹（绝不打印密码/密钥），防止环境缺项被误判为产品失败。
const envSummary = {
  node: process.version,
  pgHost: process.env.RECRUITMENT_TEST_DB_HOST ?? process.env.PGHOST ?? '127.0.0.1',
  pgPort: process.env.RECRUITMENT_TEST_DB_PORT ?? process.env.PGPORT ?? '5432',
  hasPython: Boolean(process.env.RECRUITMENT_PYTHON_BIN || process.env.RECRUITMENT_PYTHON),
  hasCorpusRoot: Boolean(process.env.RECRUITMENT_CORPUS_ROOT),
  authMode: process.env.RECRUITMENT_AUTH_MODE ?? 'preview',
}
console.log(`run-all-env: ${JSON.stringify(envSummary)}`)
console.log(`run-all: ${files.length} 个测试文件（node --test ${nodeTestArgs.join(' ')}）`)
const result = spawnSync(process.execPath, ['--test', ...nodeTestArgs, ...files], {
  cwd: packageRoot,
  stdio: 'inherit',
})

if (result.error !== undefined) {
  console.error(`run-all: 启动 node --test 失败：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
