#!/usr/bin/env node
// =============================================================================
// client-contract-check —— 前端写链路的"静态合同"检查（D-162）
//
// 背景：这个仓库的界面写动作有唯一正确链路：`recruiting/actions.ts` 的 build* + `postActionSeam`
// （含 X-DSH-Session、身份键检查、错误话术）。但前端曾重写一遍链路，于是"界面做了、请求 400"
// 反复出现。运行时验证（runbook）只有能起真库真浏览器的机器才做得了，而前端环境做不到——
// 所以必须有一条**纯 node、零依赖、前端也能跑**的结构性检查，把错误挡在交付之前。
//
// 规则（任一不满足 → 退出码 1）：
//   1. `canvas-actions.ts` 不许出现"有既有 builder 的写路由"字面量（必须复用 build* + seam）；
//   2. `canvas/*.tsx` 不许直接 `fetch(` 写请求（POST/PUT/PATCH/DELETE）；
//   3. 每个写能力必须在画布代码里出现它的 builder 名（防止"接线了但没复用"）。
//
// 用法：node scripts/client-contract-check.mjs
// 退出码：0 = 通过；1 = 有违规（逐条打印）。
// =============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'dsh', 'dsh-recruitment', 'src', 'client')

/** 有既有 builder 的写路由 → 应复用的 builder 名。 */
export const BUILDER_BY_ROUTE = [
  { route: '/recruitment/api/action/screening/decide', builder: 'buildScreeningDecisionBody' },
  { route: '/recruitment/api/decision/record', builder: 'buildDecisionRecordBody' },
  { route: '/recruitment/api/action/decision/record', builder: 'buildDecisionRecordBody' },
  { route: '/recruitment/api/action/stage/advance', builder: 'buildStageAdvanceBody' },
  { route: '/recruitment/api/action/transcript/import', builder: 'buildTranscriptImportBody' },
  { route: '/recruitment/api/action/interview/schedule', builder: 'buildInterviewScheduleBody' },
  { route: '/recruitment/api/action/settings/write', builder: 'buildSettingsWriteBody' },
]

/**
 * 读一个目录下的客户端源码文本。
 * @param dir - 目录绝对路径。
 * @param acc - 累加器 `[{path, text}]`。
 * @returns 累加器。
 */
function collect(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, acc)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push({ path: full, text: readFileSync(full, 'utf8') })
    }
  }
  return acc
}

/**
 * 执行检查。
 * @returns `{ violations: string[] }`。
 */
export function check() {
  const sources = collect(CLIENT)
  const violations = []

  const canvasActions = sources.find((file) => file.path.endsWith(join('canvas', 'canvas-actions.ts')))
  if (canvasActions !== undefined) {
    for (const { route, builder } of BUILDER_BY_ROUTE) {
      if (canvasActions.text.includes(route)) {
        violations.push(`canvas-actions.ts 手拼写路由 ${route}（应复用 ${builder} + postActionSeam）`)
      }
    }
  }

  for (const file of sources) {
    if (!file.path.includes(join('canvas', '')) || !file.path.endsWith('.tsx')) continue
    if (/\bfetch\s*\([^)]*method:\s*'(POST|PUT|PATCH|DELETE)'/s.test(file.text)) {
      violations.push(`${file.path.replace(CLIENT, 'src/client')} 直接发起写请求（应走 postActionSeam）`)
    }
  }

  const all = sources.map((file) => file.text).join('\n')
  for (const { builder } of BUILDER_BY_ROUTE) {
    if (!all.includes(builder)) {
      violations.push(`画布代码里没有复用 ${builder}（该写能力可能还没接或接错链路）`)
    }
  }

  return { violations }
}

const { violations } = check()
if (violations.length > 0) {
  console.error('client-contract-check: FAIL')
  for (const line of violations) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('client-contract-check: PASS（画布写动作全部走既有 builder + postActionSeam）')
}
