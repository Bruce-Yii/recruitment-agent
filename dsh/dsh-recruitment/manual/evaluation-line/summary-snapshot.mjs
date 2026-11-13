// S10 评价线 · 汇总快照（只读，给"决策入参准备器"提供 summary_digest）。
//
// 为什么需要：`recruitment_decision_record` 的 `summary_digest` 必须等于**同一个**
// 汇总函数在同一个 `as_of` 下重算的值（DC-16）。所以演示里先跑一次汇总，
// 把投影落成 JSON，再据此准备决策入参。
// 这里调用的就是 `evaluation-summarize.ts` 导出的**同一个** `computeEvaluationSummaryIn`，
// 不是第二份实现。
//
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/summary-snapshot.mjs --scope STAGE `
//        --interview 11111111-1111-4111-8111-000000000801 --as-of 2026-11-13T18:00:00+08:00 `
//        --out partial [--require-complete]
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { closePool, createPool, resolveDatabaseConfig, withReadOnly } from '../../src/db/pool.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const flag = (name) => argv.includes(name)

const scope = opt('--scope', 'STAGE')
const interview = opt('--interview', '11111111-1111-4111-8111-000000000801')
const asOf = opt('--as-of')
const out = opt('--out', `summary-${scope.toLowerCase()}`)
const application = opt('--application', '11111111-1111-4111-8111-000000000701')
if (asOf === undefined) {
  console.error('需要 --as-of（IS0-8601 带偏移，且不得晚于当前时间）')
  process.exit(2)
}

const { resolved, issues } = resolveDatabaseConfig({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
}, process.env)
if (resolved === null) {
  console.error('database config issues:', issues)
  process.exit(2)
}

const args = {
  application_id: application,
  decision_scope: scope,
  ...(scope === 'STAGE' ? { interview_id: interview } : {}),
  as_of: asOf,
  ...(flag('--require-complete') ? { require_complete: true } : {}),
}

const pool = createPool(resolved)
let summary
try {
  summary = await withReadOnly(pool, async (client) => {
    // 与工具 `execute()` 同一做法：只读事务里设事务局部 actor，再算投影。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [resolved.actor_id])
    return await computeEvaluationSummaryIn(client, resolved, args, Date.now())
  })
} catch (error) {
  console.error(`summarize 失败：${error?.code ?? error?.name}: ${error?.message ?? String(error)}`)
  process.exitCode = 1
} finally {
  await closePool(pool)
}

if (summary !== undefined) {
  const evidenceDir = join(HERE, 'evidence', out)
  mkdirSync(evidenceDir, { recursive: true })
  writeFileSync(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(join(evidenceDir, 'summary-args.json'), `${JSON.stringify(args, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({
    summary_digest: summary.summary_digest,
    coverage: summary.coverage,
    tally: summary.tally,
    consensus: summary.consensus,
    ready_for_decision: summary.ready_for_decision,
    permitted_results: summary.permitted_results,
    blockers: (summary.blockers ?? []).map((b) => b.code),
    required_human_action: summary.required_human_action,
    missing: (summary.missing ?? []).map((m) => m.interviewer_id),
    out: join(evidenceDir, 'summary.json'),
  }, null, 2))
}
