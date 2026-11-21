// entry-reachability.mjs 的假样本单测（node:test + node:assert）。
// **不依赖真实仓库状态**：所有输入都是本文件在 mkdtempSync 临时目录里造的假样本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  API_PREFIX,
  expandTemplate,
  extractRoutes,
  isReferenced,
  loadWhitelist,
  routeVariants,
  extractTestIds,
} from './entry-reachability.mjs'

/** 造一个临时目录，返回路径；测试结束用 t.after 清理。 */
function fakeDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'entry-reach-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('expandTemplate：展开 ${PREFIX}/x 模板字面量', () => {
  const consts = { ACTION_PREFIX: '/recruitment/api/action', DECISION_ROUTE_PREFIX: '/recruitment/api/decision' }
  assert.equal(
    expandTemplate('`${ACTION_PREFIX}/screening/decide`', consts),
    '/recruitment/api/action/screening/decide',
  )
  assert.equal(
    expandTemplate('`${DECISION_ROUTE_PREFIX}/facts`', consts),
    '/recruitment/api/decision/facts',
  )
  // 纯字面量（单引号）原样返回。
  assert.equal(expandTemplate(`'/recruitment/api/action/star'`, consts), '/recruitment/api/action/star')
  // 未知前缀 / 非 API 前缀 → null（不猜）。
  assert.equal(expandTemplate('`${UNKNOWN}/x`', consts), null)
  assert.equal(expandTemplate(`'/other/api/x'`, consts), null)
  assert.equal(expandTemplate('`${ACTION_PREFIX}/a/${MISSING}`', consts), null)
})

test('extractRoutes：抽直接字面量 + 展开模板 + 对象条目；前缀常量本身不算路由', () => {
  const dir = fakeDir(test)
  const source = `
    const ACTION_PREFIX = '/recruitment/api/action'
    const STAR_PATH = '/recruitment/api/action/application/star'
    const BATCH_PATH = \`\${ACTION_PREFIX}/decision/batch-reject\`
    const ACTION_PATHS = {
      screeningDecide: \`\${ACTION_PREFIX}/screening/decide\`,
      stageAdvance: \`\${ACTION_PREFIX}/stage/advance\`,
    }
    const SETTINGS_PATHS = {
      read: '/recruitment/api/settings',
      write: '/recruitment/api/action/settings/write',
    }
  `
  const file = join(dir, 'sample.ts')
  writeFileSync(file, source, 'utf8')
  const routes = extractRoutes(requireRead(file))
  assert.deepEqual(routes, [
    '/recruitment/api/action/application/star',
    '/recruitment/api/action/decision/batch-reject',
    '/recruitment/api/action/screening/decide',
    '/recruitment/api/action/settings/write',
    '/recruitment/api/action/stage/advance',
    '/recruitment/api/settings',
  ])
  // 前缀常量（ACTION_PREFIX）与纯 API 前缀不许出现。
  assert.equal(routes.includes(API_PREFIX), false)
  assert.equal(routes.includes('/recruitment/api/action'), false)
})

/** 读假样本文件。 */
function requireRead(file) {
  return readFileSync(file, 'utf8')
}

test('GET 只读路由由排除表剔除（这里验证排除表的理由与路径形态）', async () => {
  const { READ_ONLY_ROUTES } = await import('./entry-reachability.mjs')
  const paths = READ_ONLY_ROUTES.map((r) => r.path)
  // 典型 GET 只读投影在排除表里。
  for (const p of ['/recruitment/api/tasks/status', '/recruitment/api/usage', '/recruitment/api/decision/facts']) {
    assert.equal(paths.includes(p), true, `${p} 应在只读排除表`)
  }
  // 每条都必须有具体理由，且理由不能是空泛的一句。
  for (const rule of READ_ONLY_ROUTES) {
    assert.equal(typeof rule.reason, 'string')
    assert.ok(rule.reason.trim().length >= 8, `${rule.path} 的 reason 太短/空泛`)
  }
  // 写路由绝不能被排除。
  assert.equal(paths.includes('/recruitment/api/action/screening/decide'), false)
})

test('isReferenced：完整路径 / 相对后缀都算引用，零引用判定', () => {
  const sources = [
    { path: 'client/a.ts', text: "fetch('/recruitment/api/action/application/transfer')" },
    { path: 'client/b.tsx', text: "post('/action/compound')" },
    { path: 'client/c.ts', text: "const x = 'action/star'" },
  ]
  assert.deepEqual(isReferenced('/recruitment/api/action/application/transfer', sources), ['client/a.ts'])
  assert.deepEqual(isReferenced('/recruitment/api/action/compound', sources), ['client/b.tsx'])
  assert.deepEqual(isReferenced('/recruitment/api/action/star', sources), ['client/c.ts'])
  // 零引用。
  assert.deepEqual(isReferenced('/recruitment/api/action/screening/decide', sources), [])
})

test('routeVariants：完整路径 + 去掉 /recruitment/api 的相对后缀', () => {
  assert.deepEqual(
    new Set(routeVariants('/recruitment/api/action/screening/decide')),
    new Set(['/recruitment/api/action/screening/decide', '/action/screening/decide', 'action/screening/decide']),
  )
})

test('loadWhitelist：默认空数组合法；缺 reason 的条目必须报错', () => {
  assert.deepEqual(loadWhitelist([]), [])
  assert.deepEqual(loadWhitelist([{ path: '/recruitment/api/action/email/authorize', reason: '仅供运维触发' }]), [
    { path: '/recruitment/api/action/email/authorize', reason: '仅供运维触发' },
  ])
  // 缺 reason / 空 reason / path 缺失 → 抛错。
  assert.throws(() => loadWhitelist([{ path: '/recruitment/api/x' }]), /缺 reason/)
  assert.throws(() => loadWhitelist([{ path: '/recruitment/api/x', reason: '   ' }]), /缺 reason/)
  assert.throws(() => loadWhitelist([{ reason: '有理由但没 path' }]), /缺 path/)
  assert.throws(() => loadWhitelist(['not-an-object']), /不是对象/)
})

test('extractTestIds：从 docs38 表格行抽反引号 testid，跳过空与 —', () => {
  const dir = fakeDir(test)
  const doc = [
    '# 38 矩阵',
    '## 1. 判据',
    '| testid | x |',
    '| `should-not-appear` | x |',
    '## 2. 写能力清单（当前状态）',
    '| # | 能力 | 后端 | 界面入口 | testid | 证据 | 状态 |',
    '|---|---|---|---|---|---|---|',
    '| 1 | 初筛 | /action/x | 有 | `form-screening_decide` | — | 🔴 |',
    '| 2 | 阶段 | /action/y | 无 | — | — | 🔴 |',
    '| 3 | 约面 | /action/z | 有 | `canvas-action-schedule` 等 | 证据 | 🟡 |',
    '| 4 | 空 | /action/w | 无 |  | — | 🔴 |',
    '## 3. 机检',
    '| 5 | 后续段 | x | x | `should-not-appear-2` | x | x |',
  ].join('\n')
  const file = join(dir, 'docs38.md')
  writeFileSync(file, doc, 'utf8')
  const ids = extractTestIds(requireRead(file))
  assert.deepEqual(ids, ['canvas-action-schedule', 'form-screening_decide'])
  // 第 1/3 节和 — / 空值不得混入。
  assert.equal(ids.includes('should-not-appear'), false)
  assert.equal(ids.includes('should-not-appear-2'), false)
  assert.equal(ids.includes('—'), false)
})
