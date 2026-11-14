// S9 只读工具（`recruitment_transcript_read`）的**静态**只读证明。
//
// 与 S7 的 `screening-readonly.test.ts` 同一口径：只读性质不能靠“我读代码觉得没写”，
// 必须可机检。分两层：
//   1. 实现文件里**没有**任何 INSERT / UPDATE / DELETE / DROP / TRUNCATE；
//   2. 它不调用写事务封装（`withActor` / `set_config`），只 import `withReadOnly`；
//      且**不** import 写工具 `transcript-import.ts`（只读模块图里不能出现写 SQL）。
// 运行时另有一层：`createTranscriptReadTool().execute()` 走 `withReadOnly`，
// 即 `begin transaction read only`（任何写语句会被 PG 以 25006 拒绝）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const READ_TOOL = new URL('../../src/tools/transcript-read.ts', import.meta.url)

test('transcript-read.ts 里没有写语句', async () => {
  const text = await readFile(READ_TOOL, 'utf8')
  const patterns: readonly (readonly [string, RegExp])[] = [
    ['INSERT', /\binsert\s+into\b/i],
    ['UPDATE', /\bupdate\s+[A-Za-z_"][\w."]*\s+set\b/i],
    ['DELETE', /\bdelete\s+from\b/i],
    ['DROP/TRUNCATE', /\b(drop\s+table|truncate)\b/i],
  ]
  for (const [label, pattern] of patterns) {
    assert.equal(pattern.test(text), false, `transcript-read.ts 命中写语句 ${label}`)
  }
})

test('只 import withReadOnly（不调用 withActor / set_config）', async () => {
  const text = await readFile(READ_TOOL, 'utf8')
  const poolImport = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/db\/pool\.ts'/.exec(text)
  assert.ok(poolImport !== null, 'transcript-read.ts 必须从 db/pool.ts 取连接封装')
  const imported = (poolImport[1] ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
  assert.ok(imported.includes('withReadOnly'), '必须 import withReadOnly')
  assert.equal(imported.includes('withActor'), false, '只读工具不得 import withActor')
  assert.equal(/\bwithActor\s*\(/.test(text), false, '不得调用 withActor')
  assert.equal(/\bset_config\s*\(/.test(text), false, '不得设置 actor（只读工具不需要写身份）')
  assert.equal(/transcript-import/.test(text), false, '只读模块图不得 import 写工具')
})

// ---------------------------------------------------------------------------------------------
// 以下为补充的机检项（加强到"模块图 + 全文零 DML 字样 + 负向对照"这一层）。
// ---------------------------------------------------------------------------------------------

const PLUGIN_DIR = new URL('../../', import.meta.url)

/** 读工具的模块图（手工列全：漏一个就等于没扫）。 */
const READ_MODULE_GRAPH = [
  'src/tools/transcript-read.ts',
  // R4（2026-11-14）：顶层 labels.provenance 改由 `resolveTenantProvenance` 算 ⇒ 多一个依赖。
  // 把它一起纳入"零 DML"扫描（而不是只放宽 import 白名单）：新依赖必须同样只读。
  'src/tools/candidate-get.ts',
  'src/tools/args.ts',
  'src/tools/contract.ts',
  'src/tools/errors.ts',
  'src/tools/definition.ts',
  'src/db/pool.ts',
]

const WRITE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['INSERT', /\binsert\s+into\b/i],
  ['UPDATE', /\bupdate\s+\w+\s+set\b/i],
  ['DELETE', /\bdelete\s+from\b/i],
  ['DROP/TRUNCATE', /\b(drop\s+table|truncate)\b/i],
]

async function scan(relative: string): Promise<string> {
  return readFile(new URL(relative, PLUGIN_DIR), 'utf8')
}

test('读工具模块图里没有 INSERT / UPDATE / DELETE / DROP / TRUNCATE', async () => {
  for (const relative of READ_MODULE_GRAPH) {
    const text = await scan(relative)
    for (const [label, pattern] of WRITE_PATTERNS) {
      assert.equal(pattern.test(text), false, `${relative} 命中写语句 ${label}`)
    }
  }
})

test('transcript-read.ts 全文零 DML 字样（连注释与模板字符串里也不许出现）', async () => {
  const text = await scan('src/tools/transcript-read.ts')
  for (const keyword of ['insert', 'update', 'delete', 'truncate']) {
    assert.equal(new RegExp(keyword, 'i').test(text), false, `transcript-read.ts 出现了 "${keyword}"`)
  }
})

test('读工具只依赖允许的本地模块，并声明 read_only: true', async () => {
  const text = await scan('src/tools/transcript-read.ts')
  assert.match(text, /read_only:\s*true/)
  assert.match(text, /const TOOL_NAME = 'recruitment_transcript_read'/)
  assert.match(text, /isConcurrencySafe\(\):\s*boolean\s*\{\s*return true/)
  const localImports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '')
  // `./candidate-get.ts` 只提供 `resolveTenantProvenance`（一条 SELECT `business_config`/`organization`），
  // 且已纳入上面 `READ_MODULE_GRAPH` 的零 DML 扫描 —— 不是把只读约束放宽，而是让新依赖同样受检。
  const allowed = new Set(['./args.ts', './contract.ts', './definition.ts', '../db/pool.ts', './candidate-get.ts'])
  for (const specifier of localImports) {
    assert.ok(allowed.has(specifier), `读工具多了一个依赖：${specifier}`)
  }
})

test('负向对照：写工具确实有写语句 —— 证明上面的扫描不是"永远为真"', async () => {
  const writeTool = await scan('src/tools/transcript-import.ts')
  assert.match(writeTool, /insert\s+into/i)
  assert.match(writeTool, /withActor/)
  assert.equal(/\bwithReadOnly\b/.test(writeTool), false, '写路径不该用只读事务')
})
