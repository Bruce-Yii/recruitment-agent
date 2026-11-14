// 测试隔离的**守卫**（不是业务测试）。
//
// 这个文件回答一个问题：以后有人再加集成测试 / 改夹具底座时，下面这些"并发跑会互相干扰"的
// 反模式会不会**被当场发现**？
//
//   1. 用共享库 `ra_s6s7` 的测试，要么全程回滚（`inRolledBackTx`），要么独占一次性空库
//      （`createIsolatedTestDatabase` / `createRuntimeTestDatabase`）——二选一，不许裸写共享库；
//   2. 引擎 effect/outbox 是**全局按 kind 消费**的队列：相关测试必须独占空库，
//      不许靠 `pg_advisory_lock` 把文件串起来（那是掩盖症状，不是隔离）；
//   3. 命名空间助手（`FILE_NAMESPACE` / `uniqueSuffix()` / 一次性库名）必须真的跨进程唯一；
//      用写死的全局键应当被 `assertOwnNamespace` 当场拒绝；
//   4. 快照隔离（`REPEATABLE READ`）不许被悄悄改回 READ COMMITTED（零写入断言靠它）；
//   5. "跑法"必须是能跑起来的那一种：`package.json` 的 test 脚本要走 run-all，
//      README 不许再教 `node --test <目录>`（Node 24 + Windows 上会 `Cannot find module`）；
//   6. 排期时段不许写死（写死就会和别的 lane 提交的真实面试撞车，测的不再是闸门）。
//
// 所有检查都是**静态读文件 + 跨进程行为断言**，不连数据库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  FILE_NAMESPACE,
  assertOwnNamespace,
  namespacedKey,
  nextIsolatedDatabaseName,
} from './integration/db.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = dirname(HERE)
const DB_SOURCE = join(HERE, 'integration', 'db.ts')
const DB_SOURCE_TEXT = readFileSync(DB_SOURCE, 'utf8')

/** `test/` 下全部测试文件（相对包根的 posix 路径）。 */
function testFiles(): string[] {
  return readdirSync(HERE, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.test.ts'))
    .map((entry) => entry.split('\\').join('/'))
    .sort()
}

/** 用共享库的测试文件（导入了夹具底座或直接 import 这些符号）。 */
function sharedDbFiles(): string[] {
  return testFiles().filter((file) => {
    if (file === 'isolation.test.ts') return false
    const text = readFileSync(join(HERE, file), 'utf8')
    return /\b(testDatabaseConfig|createTestPool|inRolledBackTx)\b/.test(text)
  })
}

/** 读一个测试文件的源码。 */
function source(file: string): string {
  return readFileSync(join(HERE, file), 'utf8')
}

/** 一条断言失败时带上文件名，便于定位。 */
function assertEach(files: readonly string[], label: string, predicate: (text: string) => boolean): void {
  for (const file of files) {
    assert.ok(predicate(source(file)), `${label}：${file}`)
  }
}

// ---------------------------------------------------------------------------
//  1. 共享库：必须回滚，或独占一次性库
// ---------------------------------------------------------------------------

test('用共享库的测试必须「全程回滚」或「独占一次性空库」，不许裸写 ra_s6s7', () => {
  const files = sharedDbFiles()
  assert.ok(files.length >= 10, `共享库测试文件数量异常（${files.length}），守卫本身可能失效了`)
  assertEach(files, '共享库测试既没有 inRolledBackTx 也没有 createIsolatedTestDatabase', (text) =>
    /\binRolledBackTx\b/.test(text)
    || /\bcreateIsolatedTestDatabase\b/.test(text)
    || /\bcreateRuntimeTestDatabase\b/.test(text))
})

test('真正提交（跨事务可见）的测试必须独占一次性库；留在共享库的提交必须有 cleanup', () => {
  for (const file of sharedDbFiles()) {
    const text = source(file)
    if (!/\.query\(['"]commit['"]\)/.test(text)) continue
    const isolated = /\bcreateIsolatedTestDatabase\b|\bcreateRuntimeTestDatabase\b/.test(text)
    const hasCleanup = /cleanup/i.test(text)
    assert.ok(
      isolated || hasCleanup,
      `${file} 往共享库提交了行，但既没有独占库、也没有 cleanup 函数 —— 崩溃一次就永久污染 ra_s6s7`,
    )
  }
})

// ---------------------------------------------------------------------------
//  2. 全局引擎队列：独占库，不许用 advisory lock 串行糊过去
// ---------------------------------------------------------------------------

test('引擎 effect/outbox 的测试必须独占一次性空库（全局按 kind 消费，不能共用 ra_s6s7）', () => {
  const engineContracts = ['integration/engine-mechanisms-pg.test.ts',
    'integration/engine-effects-junction-pg.test.ts',
    'acceptance/engine-gates.test.ts']
  for (const file of engineContracts) {
    const text = source(file)
    assert.ok(/createIsolatedTestDatabase\(/.test(text), `${file} 必须用 createIsolatedTestDatabase()`)
    assert.ok(/assertPrivateDatabase\(/.test(text), `${file} 必须断言自己跑在私库上（assertPrivateDatabase）`)
    assert.ok(!/pg_advisory_lock\(/.test(text), `${file} 不许用 advisory lock 串行：要隐私库，不要互相等`)
  }
})

test('没有任何测试文件在共享库上「整租户清引擎表」（会把并行跑的另一文件的行抹掉）', () => {
  for (const file of sharedDbFiles()) {
    const text = source(file)
    const wipes = [...text.matchAll(/delete\s+from\s+recruitment\.(engine_[a-z_]+)[\s\S]{0,80}?where\s+tenant_id\s*=/gi)]
    if (wipes.length === 0) continue
    assert.ok(
      /createIsolatedTestDatabase\(/.test(text),
      `${file} 整租户删除 engine_* 表（${wipes.map((m) => m[1]).join(', ')}），这会把并行跑的另一文件的行抹掉；`
      + '要么独占一次性空库，要么按自己的键删',
    )
  }
})

// ---------------------------------------------------------------------------
//  3. 命名空间必须真的唯一（跨进程行为断言）
// ---------------------------------------------------------------------------

/** 在一个**新进程**里打印 n 个 uniqueSuffix()（模拟另一个并行跑的测试文件）。 */
function suffixSample(count: number): string[] {
  const script = `import { uniqueSuffix } from ${JSON.stringify(pathToFileURL(DB_SOURCE).href)}\n`
    + `for (let i = 0; i < ${count}; i += 1) console.log(uniqueSuffix())\n`
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  })
  return output.split(/\r?\n/).filter((line) => line.length > 0)
}

/** 在一个**新进程**里打印这个文件的命名空间。 */
function namespaceSample(): string {
  const script = `import { FILE_NAMESPACE } from ${JSON.stringify(pathToFileURL(DB_SOURCE).href)}\n`
    + 'console.log(FILE_NAMESPACE)\n'
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  }).trim()
}

test('uniqueSuffix() 在两个进程（= 两个并行测试文件）之间不重叠', () => {
  const a = suffixSample(150)
  const b = suffixSample(150)
  assert.equal(a.length, 150)
  assert.equal(b.length, 150)
  const overlap = a.filter((value) => b.includes(value))
  assert.deepEqual(overlap, [], `两个测试进程产生了相同的唯一键：${overlap.slice(0, 5).join(', ')}`)
  for (const value of [...a, ...b]) {
    assert.match(value, /^[a-z0-9]+$/, `唯一键只应含 [a-z0-9]：${value}`)
    assert.ok(value.length <= 12, `唯一键太长会顶到列宽上限：${value}`)
  }
})

test('FILE_NAMESPACE / namespacedKey / assertOwnNamespace：用全局键会被当场拒绝', () => {
  assert.match(FILE_NAMESPACE, /^[a-z0-9]+-[a-z0-9]{4}$/)
  assert.notEqual(namespaceSample(), namespaceSample(), '两个并行进程的 FILE_NAMESPACE 不许相同')
  assert.equal(namespacedKey('notice-1'), `${FILE_NAMESPACE}:notice-1`)
  assert.throws(() => assertOwnNamespace('notice-1'), /命名空间/)
  assert.throws(() => assertOwnNamespace('other-process:notice-1'), /命名空间/)
})

test('一次性库名跨进程唯一、且不可能等于共享库名', () => {
  const name = nextIsolatedDatabaseName('engine mechanisms')
  assert.match(name, /^ra_[a-z0-9_]+$/)
  assert.ok(name.length <= 60, `库名太长：${name}`)
  assert.notEqual(name, 'ra_s6s7')
  assert.notEqual(nextIsolatedDatabaseName('same'), nextIsolatedDatabaseName('same'), '两次生成的库名不许相同')
})

// ---------------------------------------------------------------------------
//  4. 快照隔离不许被悄悄改回
// ---------------------------------------------------------------------------

test('夹具事务底座必须用 REPEATABLE READ（零写入断言的快照保证）', () => {
  assert.match(
    DB_SOURCE_TEXT,
    /begin isolation level repeatable read/,
    'inRolledBackTx 必须用 REPEATABLE READ：READ COMMITTED 下并行跑的别的文件提交一行，'
    + '就会让「写前 count / 写后 count」的零写入断言假红（实测 138 → 139）',
  )
})

// ---------------------------------------------------------------------------
//  5. 「跑不起来」不许被当成「跳过」：跑法必须是能跑的那一种
// ---------------------------------------------------------------------------

test('package.json 的 test 脚本走显式文件清单（run-all），不把目录当模块加载', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  const scripts = pkg.scripts ?? {}
  assert.equal(scripts.test, 'node test/run-all.mjs', 'test 脚本必须走 run-all（目录形式在 Node 24 + Windows 上跑不起来）')
  assert.match(String(scripts['test:serial'] ?? ''), /--test-concurrency=1/, '串行跑法必须是显式脚本，而不是让人猜')
  assert.ok((scripts['test:db'] ?? '').includes('test/integration/*.test.ts'), 'test:db 脚本必须给出集成测试的 glob')
})

test('README 只教能跑起来的两种跑法，不教 `node --test <目录>`', () => {
  const readme = readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('node test/run-all.mjs'), 'README 必须写清正确跑法（node test/run-all.mjs）')
  assert.ok(!/node --test\s+test\/[a-z-]+\/\s*(?:\r?\n|$)/m.test(readme),
    'README 不许再教目录形式（Node 24 + Windows：Cannot find module）——要么用 run-all，要么用 `test/xxx/*.test.ts` glob')
})

// ---------------------------------------------------------------------------
//  6. 排期时段不许再写死（写死 = 和别的 lane 的真实面试撞车）
// ---------------------------------------------------------------------------

test('集成/验收测试不许把**未来**的排期时段写成字面量（固定未来时段会与真实面试撞车）', () => {
  // 过去的字面量是合法的：START_IN_PAST 这类闸门负例必须给一个过去时刻，它不可能与真实面试撞车。
  // 危险的是**未来**的固定时段：别处只要在同一时段、同一面试官建了真实面试，测的就不再是闸门，
  // 而是"库里那一刻有没有空位"。
  for (const file of sharedDbFiles()) {
    const text = source(file)
    for (const match of text.matchAll(/scheduled_start_at:\s*['"](\d{4}-\d{2}-\d{2}T[^'"]+)['"]/g)) {
      const value = match[1]
      const at = Date.parse(value)
      assert.ok(!Number.isNaN(at), `${file} 的 scheduled_start_at 字面量不是合法时间：${value}`)
      assert.ok(
        at < Date.now(),
        `${file} 把**未来**的排期时段写死成字面量（${value}）：`
        + '共享库里的并发 lane 一旦在同一时段/同一面试官建了真实面试，测的就不再是闸门而是"库里有没有空位"；'
        + '请用远期基准 + 每次进程随机偏移派生（见 interview-schedule.test.ts 的 SLOT_BASE_MS / at()）',
      )
    }
  }
})

// ---------------------------------------------------------------------------
//  守卫自身的自检：列出来的文件必须真的存在（防止"改了路径 → 守卫永远为真"）
// ---------------------------------------------------------------------------

test('守卫扫描到的文件都真实存在（防止路径漂移让守卫变成永远为真）', () => {
  const files = testFiles()
  assert.ok(files.length >= 70, `扫到的测试文件太少（${files.length}），路径规则可能漂移了`)
  for (const file of ['integration/db.ts', 'integration/interview-schedule.test.ts', 'acceptance/engine-gates.test.ts']) {
    assert.ok(files.includes(file) || readFileSync(join(HERE, file), 'utf8').length > 0, `守卫里引用的 ${file} 不存在`)
  }
  assert.equal(relative(PACKAGE_ROOT, DB_SOURCE).split('\\').join('/'), 'test/integration/db.ts')
})
