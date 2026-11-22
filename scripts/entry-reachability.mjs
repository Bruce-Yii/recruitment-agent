#!/usr/bin/env node
// 入口可达性机检（D-160 / docs/17 第 1818 行 / docs/29 V3-0 / docs/38）。
//
// 背景：真点验收发现「接口都通、界面点不到」——写路由在服务端注册了，客户端却零引用。
// 本脚本把「任何写能力，没有可达界面入口 = 不算完成」变成可复算的机检：
//   1. 扫 `src/http/**/*.ts`，抽取所有 `/recruitment/api/...` 路由常量（含 `${PREFIX}/xxx`
//      模板字面量，会展开本文件内的前缀常量），再按排除表剔除只读路由；
//   2. 每条写路由在 `src/client/**/*.{ts,tsx}` 里查引用（完整路径 or 去掉 `/recruitment/api`
//      前缀的相对后缀，兼容客户端用相对片段拼接的写法）→ 零引用 = FAIL；
//   3. 允许白名单，但**默认空**，每条必须带具体理由（不许用白名单洗绿）；
//   4. 读 docs/38 第 2 节表格 testid 列，逐个要求在 smoke/entries.json 中出现 → 缺失 = FAIL；
//      entries.json 不存在则打印 warning 并**只做路由检查**（明确输出「testid 清单缺失，跳过多一项」，
//      绝不因为缺文件而误判全绿，也绝不因为缺文件把整轮判红）。
//
// 退出码：全达 → 0；有缺口（零引用路由 / 缺 testid）→ 1。
// 用法：node scripts/entry-reachability.mjs
//
// 本脚本**只读**，不改产品代码。纯函数已导出，供 `entry-reachability.test.mjs` 用假样本单测。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'dsh', 'dsh-recruitment')
const HTTP_DIR = join(ROOT, 'src', 'http')
const CLIENT_DIR = join(ROOT, 'src', 'client')
const REPO_ROOT = join(HERE, '..')
const DOC38 = join(REPO_ROOT, 'docs', '38-capability-entry-matrix.md')
const ENTRIES = join(REPO_ROOT, 'work', 'd5', 'e2e-real', 'smoke', 'entries.json')

/** `/recruitment/api` 前缀——引用匹配与相对后缀都围绕它。 */
export const API_PREFIX = '/recruitment/api'

/**
 * 只读路由排除表（按**完整路径**匹配）。
 *
 * 每条必须带 `reason`，且理由是**该路由为什么不构成写能力**的具体事实，不是空泛的
 * 「只读投影」。扫描器只认这里列出的路径；新增读路由时要同步加进来并写真实理由，
 * 否则它会被当写路由要求客户端引用（宁可假红，不许靠放宽排除表洗绿）。
 */
export const READ_ONLY_ROUTES = [
  { path: '/recruitment/api/overview', reason: 'GET 只读聚合投影：岗位/申请/统计一览，不做任何写事务' },
  { path: '/recruitment/api/tasks/status', reason: 'GET 只读任务状态投影（display-tasks.ts），只返回任务队列快照' },
  { path: '/recruitment/api/usage', reason: 'GET 只读用量投影（display-usage.ts），只统计 token/次数，不写库' },
  { path: '/recruitment/api/interviewer/overview', reason: 'GET 只读面试官工作台投影，只列我的面试与面评状态' },
  { path: '/recruitment/api/recruiting', reason: 'GET 只读招聘投影前缀（recruiting.ts）：overview/applications/jobs 全是查询视图' },
  { path: '/recruitment/api/recruiting/applications/:applicationId/duplicates', reason: 'GET 只读候选人去重提示（candidate-dedup.ts）：只读 SELECT + 脱敏提示，不删不合并' },
  { path: '/recruitment/api/recruiting/applications/:applicationId/trace', reason: 'GET 只读决策追责时间线（application-trace.ts）：复用 loadTrace 的只读 SELECT + 人话脱敏投影，零写入' },
  { path: '/recruitment/api/material', reason: 'GET/HEAD 只读材料内容前缀（material-content.ts），按 id 取简历原文，不写库' },
  { path: '/recruitment/api/decision/facts', reason: 'GET 只读决策事实投影（decision-read.ts），basis 组装在内存里，不落库' },
  { path: '/recruitment/api/scorecard-form', reason: 'GET/POST 表单 spec 端点（overview.ts）：GET 取规格、POST 只返回预览不写业务表；真实写走 /action/scorecard/submit' },
  { path: '/recruitment/api/action/scorecard/form', reason: 'GET 只读表单 spec + 一次性 nonce（actor.ts），本身不写库；写由 /action/scorecard/submit 承担' },
  { path: '/recruitment/api/action/interview/free-slots', reason: 'GET 只读空闲时段查询（interview-slots.ts），只算可用槽位，不占槽不写库' },
  { path: '/recruitment/api/settings', reason: 'GET 只读设置投影（settings.ts 的 read 路由），写另走 /action/settings/write' },
]

/**
 * 写路由白名单——**默认必须为空**。
 *
 * 每条 `{ path, reason }`，reason 要具体到「为什么这条写路由确实不由界面触发」
 * （例如「该路由仅供 Agent/运维，不由界面触发」）。docs/38 第 43 行提到历史上
 * `/action/email/authorize` 曾被列白，但那是**带条件的说明**，不是预置条目；
 * 用户明确要求默认空，所以这里不预填任何项——要不要白名单，由接入口的人显式加并写理由。
 */
export const WHITELIST = []

/**
 * 客户端不直接持路由字符串、而是持"动作键"（服务端 actionSeams 注入 URL）的写路由。
 * 只做**已知形态的映射**，不猜测；新增映射必须同时说明客户端键出自哪。
 */
export const ACTION_KEY_FALLBACKS = [
  { path: '/recruitment/api/action/screening/decide', keys: ['screening_decide'] },
  { path: '/recruitment/api/action/stage/advance', keys: ['stage_advance'] },
  { path: '/recruitment/api/action/transcript/import', keys: ['transcript_import'] },
  { path: '/recruitment/api/action/decision/record', keys: ['decision_record'] },
  { path: '/recruitment/api/action/job/rubric-approve', keys: ['rubric_approve'] },
  { path: '/recruitment/api/action/interview/schedule', keys: ['interview_schedule'] },
  { path: '/recruitment/api/action/settings/write', keys: ['settings_write'] },
]

/**
 * 已知缺口基线（D-160 真点/机检确认，等前端任务 08 逐条补）。
 * 规则：**只许降不许升**——出现基线之外的新缺口即 FAIL；基线内的补上了也照样报（提示下调）。
 */
export const HAND_ROLLED_WRITE_ACTIONS = [
  '/recruitment/api/action/screening/decide',
  '/recruitment/api/action/decision/record',
  '/recruitment/api/decision/record',
  '/recruitment/api/action/stage/advance',
  '/recruitment/api/action/transcript/import',
  '/recruitment/api/action/interview/schedule',
  '/recruitment/api/action/settings/write',
  '/recruitment/api/action/job/create',
  '/recruitment/api/action/job/draft',
  '/recruitment/api/action/job/close',
  '/recruitment/api/action/job/rubric-approve',
]

/**
 * 扫画布里"自己拼 body"的写路由字面量（D-160 / V3-2）。
 * 这些动作仓库里已有 `recruiting/actions.ts` 的 builder + `postActionSeam`，画布不该重写合同。
 * @param canvasActionsText - `canvas-actions.ts` 全文。
 * @returns 仍被画布手拼的写路由清单。
 */
export function findHandRolledWrites(canvasActionsText) {
  return HAND_ROLLED_WRITE_ACTIONS.filter((path) => canvasActionsText.includes(path))
}

export const BASELINE_UNREFERENCED = [
  '/recruitment/api/action/compound',
  '/recruitment/api/action/config',
  '/recruitment/api/action/config/pipeline',
  '/recruitment/api/action/config/role',
  '/recruitment/api/action/config/team',
  '/recruitment/api/action/email/authorize',
  '/recruitment/api/action/email/send-authorized',
  '/recruitment/api/feishu/import',
]

/**
 * 白名单校验：每条必须有非空 path 与非空 reason，否则报错（不许无理由洗绿）。
 * @param rules - 待校验的白名单数组。
 * @returns 规范化后的 `{path, reason}[]`。
 */
export function loadWhitelist(rules) {
  if (!Array.isArray(rules)) throw new TypeError('白名单必须是数组')
  return rules.map((rule, index) => {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new TypeError(`白名单第 ${index + 1} 条不是对象`)
    }
    const path = typeof rule.path === 'string' ? rule.path.trim() : ''
    const reason = typeof rule.reason === 'string' ? rule.reason.trim() : ''
    if (path === '') throw new TypeError(`白名单第 ${index + 1} 条缺 path`)
    if (reason === '') throw new TypeError(`白名单第 ${index + 1} 条（${path}）缺 reason：每条必须写明为什么不由界面触发`)
    return { path, reason }
  })
}

/**
 * 展开一个路由字面量：把模板里的 `${PREFIX}` 用同文件收集到的常量表替换。
 * 只处理最常见的 `` `${SOME_CONST}/suffix` `` 形态（本项目全部路由常量都是这种）。
 * 例：constants={ACTION_PREFIX:'/recruitment/api/action'}，
 *     expr='`${ACTION_PREFIX}/screening/decide`' → '/recruitment/api/action/screening/decide'。
 * @param expr - 源码里的字面量表达式（含引号或反引号）。
 * @param constants - 同文件里 `const NAME = '...'` 收集来的常量表。
 * @returns 展开后的完整路径；无法展开返回 null。
 */
export function expandTemplate(expr, constants) {
  if (typeof expr !== 'string') return null
  const raw = expr.trim()
  let body = null
  if (raw.startsWith('`') && raw.endsWith('`')) body = raw.slice(1, -1)
  else if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    body = raw.slice(1, -1)
  }
  if (body === null) return null
  // 纯字面量（无模板插值）。
  if (!body.includes('${')) return body.startsWith(API_PREFIX) ? body : null
  // 模板字面量：仅允许 ${NAME} 占位且 NAME 必须在常量表里。
  const names = [...body.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map((m) => m[1])
  if (names.length === 0) return null
  let expanded = body
  for (const name of names) {
    const value = constants[name]
    if (typeof value !== 'string' || value === '') return null
    expanded = expanded.replaceAll(`\${${name}}`, value)
  }
  // 还有没展开的插值 → 放弃（不猜）。
  if (expanded.includes('${')) return null
  return expanded.startsWith(API_PREFIX) ? expanded : null
}

/**
 * 从**单个** http 源文件的文本里抽取所有路由常量（纯函数，不读磁盘）。
 *
 * 覆盖两类写法（本项目实际存在的全部形态）：
 *   a. `const STAR_PATH = '/recruitment/api/action/application/star'`
 *   b. `const BATCH_REJECT_PATH = \`${ACTION_PREFIX}/decision/batch-reject\``
 *      以及对象里的 `screeningDecide: \`${ACTION_PREFIX}/screening/decide\`,`
 * 先收 `const NAME = <literal>` 建常量表，再扫所有 `<key>:\s*<literal>` 与 `const ...`。
 *
 * @param text - 文件源码文本。
 * @returns 去重后的完整路径数组（未排除只读、未查引用）。
 */
export function extractRoutes(text) {
  if (typeof text !== 'string') return []
  const constants = {}
  // 第一轮：收集 `const NAME = '...' | \`...\``（前缀常量和直接路径常量）。
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) {
    const value = expandTemplate(m[2], constants)
    if (value !== null) constants[m[1]] = value
  }
  const found = new Set()
  // 第二轮 a：`const SOME_PATH = <literal>`（前缀常量以 PREFIX 命名，是拼路由的积木，不是路由本身，跳过）。
  for (const m of text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) {
    if (/PREFIX/i.test(m[1])) continue
    if (/PATH|ROUTE|ENDPOINT/i.test(m[1]) && constants[m[1]] !== undefined) found.add(constants[m[1]])
  }
  // 第二轮 b：对象条目 `key: <literal>`（ACTION_PATHS / DECISION_PATHS / SETTINGS_PATHS 等）。
  // 只认名字含 PATH/ROUTE/ENDPOINT 的容器键（如 SETTINGS_PATHS 的 read/write），
  // 避免把 STATUS_BY_CODE 之类无关字符串对象扫进来。
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g)) {
    if (/PREFIX/i.test(m[1])) continue
    const value = expandTemplate(m[2], constants)
    if (value !== null) found.add(value)
  }
  // 只保留「前缀之后还有具体路径段」的路由；`'/recruitment/api'` 本身是前缀不是路由。
  return [...found].filter((p) => p !== API_PREFIX && p.startsWith(`${API_PREFIX}/`)).sort()
}

/**
 * 一条路由的匹配变体：完整路径 + 去掉 `/recruitment/api` 前缀后的相对后缀。
 * 客户端可能写全路径，也可能写 `/action/screening/decide` 或 `action/screening/decide`。
 * @param route - 完整路径。
 * @returns 变体数组（都带前导 `/` 的规范形式 + 无前导 `/` 形式）。
 */
export function routeVariants(route) {
  const variants = new Set([route])
  if (route.startsWith(API_PREFIX)) {
    const suffix = route.slice(API_PREFIX.length) // e.g. /action/screening/decide
    variants.add(suffix)
    variants.add(suffix.replace(/^\//, ''))
  }
  return [...variants]
}

/**
 * 判断某条路由是否在客户端源码集合里被引用（纯函数）。
 * @param route - 完整写路由。
 * @param clientSources - `{path, text}[]` 客户端源码集合。
 * @returns 命中的文件名数组（空 = 零引用 = FAIL）。
 */
export function isReferenced(route, clientSources) {
  const variants = routeVariants(route)
  const hits = []
  for (const source of clientSources) {
    if (variants.some((v) => source.text.includes(v))) hits.push(source.path)
  }
  return hits
}

/**
 * 从 docs/38 第 2 节表格抽取非空的 testid（反引号包裹；跳过空与 `—`）。
 * 只处理 Markdown 表格行（`|` 分隔），testid 列是第 5 列（索引 4）。
 * @param docText - docs/38 全文。
 * @returns 去重后的 testid 数组。
 */
export function extractTestIds(docText) {
  if (typeof docText !== 'string') return []
  const out = new Set()
  let inSection2 = false
  for (const line of docText.split(/\r?\n/)) {
    if (/^##\s+2\./.test(line)) { inSection2 = true; continue }
    if (/^##\s+3\./.test(line)) { inSection2 = false; continue }
    if (!inSection2) continue
    if (!line.trim().startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] 是行首空串；#=1 能力=2 后端=3 界面入口=4 testid=5 证据=6 状态=7。
    const testidCell = cells[5] ?? ''
    for (const m of testidCell.matchAll(/`([^`]+)`/g)) {
      const value = m[1].trim()
      if (value === '' || value === '—' || value === '-') continue
      out.add(value)
    }
  }
  return [...out].sort()
}

// =====================================================================
//  以下为 CLI 扫盘逻辑；被 import 时（单测）不执行。
// =====================================================================

/** 递归列出目录下匹配后缀的文件（相对路径 + 绝对路径）。 */
function walk(dir, suffixes) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full, suffixes))
    else if (suffixes.some((s) => entry.endsWith(s))) out.push(full)
  }
  return out
}

/** 执行机检，返回结构化结果（便于测试与复算）。 */
export function run() {
  const whitelist = loadWhitelist(WHITELIST)
  const readOnly = new Set(READ_ONLY_ROUTES.map((r) => r.path))

  // 1. 扫写路由。
  const httpFiles = walk(HTTP_DIR, ['.ts'])
  const allRoutes = new Map() // path -> 来源文件
  for (const file of httpFiles) {
    for (const route of extractRoutes(readFileSync(file, 'utf8'))) {
      if (!allRoutes.has(route)) allRoutes.set(route, file.slice(ROOT.length + 1))
    }
  }
  const writeRoutes = [...allRoutes.entries()]
    .filter(([path]) => !readOnly.has(path))
    .sort((a, b) => a[0].localeCompare(b[0]))

  // 2. 客户端引用。
  const clientSources = walk(CLIENT_DIR, ['.ts', '.tsx']).map((full) => ({
    path: full.slice(ROOT.length + 1),
    text: readFileSync(full, 'utf8'),
  }))
  const routes = writeRoutes.map(([path, source]) => {
    const hits = isReferenced(path, clientSources)
    const fallback = ACTION_KEY_FALLBACKS.find((m) => m.path === path)
    if (hits.length === 0 && fallback !== undefined) {
      for (const key of fallback.keys) {
        if (clientSources.some((s) => s.text.includes(key))) hits.push(`action-key:${key}`)
      }
    }
    const waived = whitelist.find((w) => routeVariants(path).includes(w.path) || path === w.path)
    return { path, source, hits, waived: waived ?? null }
  })

  // 3. testid 清单（文件不存在只警告，不误判全绿也不误判红）。
  let testidStatus = 'checked'
  let docTestIds = []
  let missingTestIds = []
  if (!existsSync(ENTRIES)) {
    testidStatus = 'missing'
  } else {
    docTestIds = extractTestIds(readFileSync(DOC38, 'utf8'))
    const entriesText = readFileSync(ENTRIES, 'utf8')
    missingTestIds = docTestIds.filter((id) => !entriesText.includes(id))
  }

  const unreferenced = routes.filter((r) => r.hits.length === 0 && r.waived === null)
  return { routes, unreferenced, testidStatus, docTestIds, missingTestIds, whitelist, readOnly: READ_ONLY_ROUTES }
}

/** 把结果打印成简洁清单，并给退出码。 */
function main() {
  const result = run()
  const { routes, unreferenced, testidStatus, docTestIds, missingTestIds, whitelist } = result

  console.log('entry-reachability: 写路由 ↔ 客户端入口可达性（D-160 / docs/29 V3-0）')
  console.log('')
  console.log(`写路由 ${routes.length} 条（只读排除 ${result.readOnly.length} 条，白名单 ${whitelist.length} 条）：`)
  for (const r of routes) {
    if (r.hits.length > 0) {
      console.log(`  [引用]   ${r.path}  ← ${r.hits.join(', ')}`)
    } else if (r.waived !== null) {
      console.log(`  [白名单] ${r.path}  —— ${r.waived.reason}`)
    } else if (BASELINE_UNREFERENCED.includes(r.path)) {
      console.log(`  [基线缺口] ${r.path}  —— 已知、待补（服务端：${r.source}）`)
    } else {
      console.log(`  [缺口]   ${r.path}  —— 客户端零引用（服务端：${r.source}）`)
    }
  }

  if (testidStatus === 'missing') {
    console.log('')
    console.log('  ⚠ testid 清单缺失，跳过多一项：work/d5/e2e-real/smoke/entries.json 不存在，本轮只做路由检查。')
  } else {
    console.log('')
    console.log(`testid 清单：docs/38 有 ${docTestIds.length} 个非空 testid。`)
    if (missingTestIds.length > 0) {
      for (const id of missingTestIds) console.log(`  [缺口]   testid ${id} 未出现在 smoke/entries.json`)
    } else {
      console.log('  [引用]   全部 testid 均出现在 smoke/entries.json')
    }
  }

  const newGaps = unreferenced.filter((r) => !BASELINE_UNREFERENCED.includes(r.path))
  const resolvedBaseline = BASELINE_UNREFERENCED.filter((path) => !unreferenced.some((r) => r.path === path))
  if (resolvedBaseline.length > 0) {
    console.log('')
    console.log(`  [可下调] 基线里已接通 ${resolvedBaseline.length} 条：${resolvedBaseline.join(', ')}`)
  }
  if (newGaps.length > 0) {
    console.log('')
    for (const r of newGaps) console.log(`  [新缺口] ${r.path} —— 不在基线内（客户端零引用）`)
  }
  const canvasActionsFile = join(ROOT, 'src', 'client', 'canvas', 'canvas-actions.ts')
  const handRolled = existsSync(canvasActionsFile)
    ? findHandRolledWrites(readFileSync(canvasActionsFile, 'utf8'))
    : []
  if (handRolled.length > 0) {
    console.log('')
    for (const path of handRolled) {
      console.log(`  [手拼写动作] ${path} —— 应复用 recruiting/actions.ts 的 builder + postActionSeam（任务 08c）`)
    }
  }
  const fail = newGaps.length > 0 || missingTestIds.length > 0
  console.log('')
  if (fail) {
    console.error(`entry-reachability: FAIL（新缺口 ${newGaps.length} 条，缺失 testid ${missingTestIds.length} 个；基线内待补 ${unreferenced.length - newGaps.length} 条；手拼写动作 ${handRolled.length} 条）`)
    process.exitCode = 1
  } else {
    console.log(`entry-reachability: PASS（无新缺口；基线内仍待补 ${unreferenced.length} 条；手拼写动作 ${handRolled.length} 条待 08c 归零）`)
    process.exitCode = 0
  }
}

// 仅在作为 CLI 直接运行时执行扫盘；被 import（单测）时保持静默。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
