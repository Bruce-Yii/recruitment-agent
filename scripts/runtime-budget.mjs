#!/usr/bin/env node
// D-109 §3「预算上限」的**可执行度量口径**。
//
// 为什么需要这个文件（第四轮独立复核的原话）：
//   「D-109 的『≤1,500 行预算』在写下它的那个 SHA 上就已经超了，门第一天就是红的。
//     这不是说实现一定错，而是说：**预算没有度量口径、没有机检，就变成装饰**。」
//
// 这条判断成立，所以这里做三件事，缺一件都不算修好：
//   1. **把「调度相关代码」定义清楚**：哪些文件计入、哪些不计入、每条不计入的理由是什么，
//      全部硬编码在下面，任何人可以逐条质疑（而不是靠一句"调度相关"自由解释）。
//   2. **给出可复算的数字**：本脚本自己扫文件、自己数行，输出逐文件明细；
//      数字不是从文档里抄来的。
//   3. **机检**：超过 CEILING 就 exit 1。增长不是禁止，而是**必须先改 docs/17 的 D-109**
//      （写明新增多少行、为什么必须加），再同步本文件的 CEILING——把"预算"从形容词变成台账动作。
//
// 跑法：
//   node scripts/runtime-budget.mjs          # 机检（CI 用这个）
//   node scripts/runtime-budget.mjs --json   # 只输出明细，不判超（人工核对用）
//
// 口径的关键选择（**故意往大算，不挑瘦的算**）：
//   计入 —— `src/runtime/**` 下所有**有运行时行为的**模块，包括容易被说成"不算调度"的三类：
//     `event-types.ts`（27 条事件名注册表）、`cutover.ts`（启动水位）、`worker.ts`（DSH 启动器）。
//     把这三类排除出去能让数字立刻好看，但那正是"用定义把预算做小"——不做。
//   不计入 —— 只有两类，理由都是"没有运行时行为"，不是"不属于调度"：
//     `evidence/**`  只读证据脚本，不参与产品运行；
//     `types.ts`     纯类型声明（interface / type），零运行时行为；
//     `index.ts`     纯 re-export barrel，零运行时行为。
//
// 行数口径（D-109.5，2026-11-15）：**代码行** = 物理行去掉空行、整行/行尾注释、
// `import ... from` 与 `export ... from`（含多行）后的剩余行。物理行口径在 G12 拆分后
// 因 import/export/委托结构行虚增（+314），故切换为代码行；G12 拆分自身代码行 +164。
// 口径仍是"往大算"：只排除没有运行时行为的语法，不排除任何业务/调度逻辑。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（本文件在 `<repo>/scripts/`）。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const RUNTIME_DIR = join(REPO_ROOT, 'dsh', 'dsh-recruitment', 'src', 'runtime')

/**
 * D-109 §3 的预算上限（物理行数）。
 *
 * **这不是一个"大概齐"的目标，是一个棘轮**：任何增长都必须先在 `docs/17` 的 D-109 里
 * 追加一条修订（新增多少行 / 为什么必须加 / 排除了什么替代做法），再改这个常量。
 * 直接改常量而不改台账 = 把预算重新变成装饰。
 *
 * 2026-11-14 首次建立口径时的实测值 = 3,804 行（物理行数）。
 * 参照 reviewer 第四轮的独立计数：`f8f9ef7` 上 `src/runtime` 约 3,060 行，本地再加
 * `event-types.ts` 391 + `cutover.ts` 459 即到本值——两边口径一致。
 * 原条款写的 1,500 从未定义过度量口径，在写下它的那个 SHA 上就已超出——问题在条款不可执行，
 * 不在实现超标（reviewer 的判断成立）。
 *
 * **棘轮第一次真的咬到人（2026-11-14，+20 行）**：第 26 个工具
 * `recruitment_interview_record_verify` 的审计事件 `interview.record.verified` 必须进
 * `src/runtime/event-types.ts` 的权威注册表（不登记就会被语义 Gate 当未登记事件拒掉，
 * 那正是刚修过的"假接线"坑）→ `event-types.ts` 391 → 411，合计 3,804 → 3,824。
 * 已在 `docs/17` D-109.2 追加修订（新增多少行 / 为什么必须加 / 排除了什么替代做法 /
 * 是否触发换实现条件），再同步本常量。**这就是这条门该有的工作方式。**
 */
const CEILING = 5033

const EXCLUDED = [
  {
    // 目录级排除：整个 evidence/ 都是只读证据脚本
    match: (rel) => rel.split(sep)[0] === 'evidence',
    label: 'evidence/**',
    reason: '只读证据脚本（dry-run / 路由复现），不参与产品运行路径',
  },
  {
    match: (rel) => rel === 'types.ts',
    label: 'types.ts',
    reason: '纯类型声明（interface / type / 常量联合），零运行时行为',
  },
  {
    match: (rel) => rel === 'index.ts',
    label: 'index.ts',
    reason: '纯 re-export barrel，零运行时行为',
  },
]

/** 物理行数：以 `\n` 切分，忽略末尾换行造成的空尾行（等价 `wc -l`）。 */
function countLines(text) {
  if (text === '') return 0
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.length
}

/**
 * 代码行口径（D-109.4）：物理行里去掉空行、整行/行尾注释、`import ... from` 与
 * `export ... from`（含多行），剩余行数。度量可复核，不改变"往大算"的原则：
 * 只排除**没有运行时行为**的语法，不排除任何业务/调度逻辑。
 */
function countCodeLines(text) {
  let body = text.replace(/\/\*[\s\S]*?\*\//g, '')
  body = body.replace(/^[ \t]*import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
  body = body.replace(/^[ \t]*export\s+(?:type\s+)?\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?[ \t]*$/gm, '')
  let count = 0
  for (const raw of body.split('\n')) {
    let line = raw.trim()
    if (line === '') continue
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*') || line.startsWith('*/')) continue
    line = line.replace(/\s\/\/.*$/, '').trim()
    if (line === '') continue
    count += 1
  }
  return count
}

/** 递归列出目录下所有 .ts 文件（相对 RUNTIME_DIR，用平台分隔符）。 */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk(RUNTIME_DIR)
  .map((full) => ({ full, rel: relative(RUNTIME_DIR, full) }))
  .sort((a, b) => a.rel.localeCompare(b.rel))

const counted = []
const excluded = []
for (const file of files) {
  const hit = EXCLUDED.find((rule) => rule.match(file.rel))
  if (hit !== undefined) {
    excluded.push({ ...file, label: hit.label, reason: hit.reason })
    continue
  }
  counted.push({ ...file, lines: countCodeLines(readFileSync(file.full, 'utf8')) })
}

// 每个排除规则都必须真的排到了东西：规则失效（例如文件被改名）时不能静默通过，
// 否则"排除项"会变成一句永远为真的空话。
const ruleHit = new Set(excluded.map((file) => file.label))
const deadRules = EXCLUDED.filter((rule) => !ruleHit.has(rule.label))
if (deadRules.length > 0) {
  console.error(`runtime-budget: 排除规则没有命中任何文件：${deadRules.map((r) => r.label).join(', ')}`)
  console.error('规则失效时不许静默通过——要么改规则，要么把文件加回计入范围。')
  process.exit(2)
}

const total = counted.reduce((sum, file) => sum + file.lines, 0)
const excludedTotal = excluded.reduce(
  (sum, file) => sum + countLines(readFileSync(file.full, 'utf8')),
  0,
)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ total, ceiling: CEILING, counted, excluded, excludedTotal }, null, 2))
  process.exit(0)
}

console.log('D-109 §3 调度预算（代码行：非注释、非 import/export-from；口径见本文件头部）')
console.log('')
console.log('计入：')
for (const file of counted) {
  console.log(`  ${String(file.lines).padStart(6)}  src/runtime/${file.rel}`)
}
console.log(`  ${String(total).padStart(6)}  = 合计（上限 ${CEILING}，余量 ${CEILING - total}）`)
console.log('')
console.log('不计入（理由必须是"没有运行时行为"，不是"不属于调度"）：')
for (const rule of EXCLUDED) {
  const hits = excluded.filter((file) => file.label === rule.label)
  console.log(`  ${rule.label.padEnd(14)} ${rule.reason}`)
  console.log(`  ${' '.repeat(14)} 命中 ${hits.length} 个文件：${hits.map((f) => f.rel).join(', ')}`)
}
console.log(`  （不计入部分实测合计 ${excludedTotal} 行，仅供对账；它们不进预算，但也不许拿它们当理由说"运行时很小"）`)
console.log('')

if (total > CEILING) {
  console.error(`runtime-budget: 超预算 ${total - CEILING} 行（${total} > ${CEILING}）`)
  console.error('增长不是禁止，但必须先在 docs/17 的 D-109 里追加一条修订：')
  console.error('  ① 新增多少行 ② 为什么必须加 ③ 排除了哪些替代做法 ④ 是否触发 D-109 的换实现条件')
  console.error('改完台账再同步本文件的 CEILING。直接改 CEILING 而不改台账 = 把预算重新变成装饰。')
  process.exit(1)
}

console.log(`runtime-budget: PASS（${total} / ${CEILING}）`)
