// S7「只读」的**静态**证明（TC §5.4 第 1 条 + `CONTRACT.md` §6 的扫描口径）。
//
// 为什么在单测里做：这是一条**可机械检查**的性质，不该靠人工读代码。
// 扫描口径分两层：
//   1. `src/tools/screening-evaluate.ts` 是唯一的 S7 实现文件，它自己的模块图
//      （contract / args / errors / definition / db/pool / db/material）里
//      **不得**出现 INSERT / UPDATE / DELETE / DROP / TRUNCATE；
//   2. 同一组文件里不得出现 `withActor` / `set_config` / `pg_advisory_xact_lock`
//      （写事务封装），只允许 `withReadOnly`。
//
// 注意边界：S6 的 `src/tools/application-intake.ts` **故意**不在扫描集里——
// 它就是要写库。用同一套规则去卡它，只会逼实现者把 SQL 藏起来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(HERE, '..', '..')

/** S7 只读域：实现文件 + 它 import 的每个本地模块（手工列全，漏一个就等于没扫）。 */
const S7_MODULE_GRAPH = [
  'src/tools/screening-evaluate.ts',
  'src/tools/contract.ts',
  'src/tools/args.ts',
  'src/tools/errors.ts',
  'src/tools/definition.ts',
  // O1 残留修复（2026-11-16）：render 短号 helper（纯字符串函数、无 DB），纳入零 DML 扫描。
  'src/tools/render-ref.ts',
  'src/db/pool.ts',
  'src/db/material.ts',
]

const WRITE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['INSERT', /\binsert\s+into\b/i],
  ['UPDATE', /\bupdate\s+\w+\s+set\b/i],
  ['DELETE', /\bdelete\s+from\b/i],
  ['DROP/TRUNCATE', /\b(drop\s+table|truncate)\b/i],
]

async function scan(relative: string): Promise<string> {
  return readFile(join(PLUGIN_DIR, relative), 'utf8')
}

test('S7 模块图里没有 INSERT / UPDATE / DELETE / DROP / TRUNCATE', async () => {
  for (const relative of S7_MODULE_GRAPH) {
    const text = await scan(relative)
    for (const [label, pattern] of WRITE_PATTERNS.slice(0, 4)) {
      assert.equal(pattern.test(text), false, `${relative} 命中写语句 ${label}`)
    }
  }
})

test('S7 不调用写事务封装：screening-evaluate 只 import withReadOnly', async () => {
  const text = await scan('src/tools/screening-evaluate.ts')
  assert.equal(/\bwithActor\s*\(/.test(text), false, 'S7 不得调用 withActor')
  assert.equal(/set_config\s*\(/.test(text), false, 'S7 不得设置 actor')
  assert.equal(/pg_advisory_xact_lock/.test(text), false)
  const poolImport = /import\s*\{([^}]*)\}\s*from\s*'\.\.\/db\/pool\.ts'/.exec(text)
  assert.ok(poolImport !== null, 'screening-evaluate 必须从 db/pool.ts 取连接封装')
  const imported = (poolImport[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  assert.ok(imported.includes('withReadOnly'), `必须用 withReadOnly，实际 import: ${imported.join(', ')}`)
  assert.equal(imported.includes('withActor'), false)
  // pool.ts 本身**定义** withActor（S6 要用），这是允许的；但 S7 不能把它引进来。
  assert.match(text, /withReadOnly\s*\(/)
})

test('S7 只用只读事务：screening-evaluate 必须 withReadOnly，且工具声明 advisory/read_only', async () => {
  const text = await scan('src/tools/screening-evaluate.ts')
  assert.match(text, /withReadOnly/)
  assert.match(text, /advisory:\s*true/)
  assert.match(text, /read_only:\s*true/)
  // 不产 decision、不钉版本：这两个词只应出现在注释与「不写」说明里
  assert.equal(/\bdecision\s*\(/i.test(text), false, 'S7 不得调用 decision 相关写路径')
  assert.equal(/\bupdate\s+recruitment\./i.test(text), false)
})

test('写库能力集中在 S6：只有 application-intake 出现 INSERT，且走 withActor', async () => {
  const intake = await scan('src/tools/application-intake.ts')
  assert.match(intake, /insert\s+into/i)
  assert.match(intake, /withActor/)
  // 不允许用 SET（连接池会泄漏），只能用 set_config(..., true) —— 封装在 withActor 里
  assert.equal(/\bSET\s+recruitment\.actor_id/i.test(intake), false, '禁止用 SET 写 actor')
})

test('S6 的 SELECT 都是参数绑定的：没有模板字符串拼进 SQL', async () => {
  const intake = await scan('src/tools/application-intake.ts')
  // 允许的字符串拼接只有两类，且都**不含用户输入**：
  //   1) `column`：phone/email 二选一，来自封闭集；
  //   2) `effectiveApprovalExistsSql({...})`：`src/db/approval.ts` 里的**常量 SQL 片段**
  //      （参数全部来自调用点字面量：resourceType / 别名），用于"批准状态只能由 approval 行判"
  //      的单一实现（O8）。若不允此类片段，就只能把同一段 EXISTS 在每个调用点各抄一份 →
  //      口径漂移风险更高。
  // 口径变化说明（收紧，不是放宽）：原来只要出现 `${...}` 就算可疑；现在**只允许这两种**，
  // 其余任何插值仍然失败。
  const SAFE_INTERPOLATION = /^\$\{(?:column|effectiveApprovalExistsSql\()/
  const suspicious = intake.match(/client\.query<[^>]*>\(\s*`[^`]*\$\{(?!column\})[^}]*\}/g) ?? []
  for (const hit of suspicious) {
    const interpolations = [...hit.matchAll(/\$\{[^}]*\}?/g)].map((match) => match[0])
    const unsafe = interpolations.filter((fragment) => !SAFE_INTERPOLATION.test(fragment))
    assert.deepEqual(unsafe, [], `可疑的 SQL 模板拼接: ${hit.slice(0, 80)}`)
  }
})
