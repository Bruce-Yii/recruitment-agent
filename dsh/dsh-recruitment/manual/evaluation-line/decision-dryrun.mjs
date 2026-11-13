// S10 评价线 · 决策写路径的**回滚试跑**（不是产品运行时，也不冒充真人批准）。
//
// 用途：approval 在 headless 里恒 `unavailable`（无 answerer），所以"决策落库"这条腿
// 在真实会话里拿不到。这里用**测试替身** `() => 'allowed-once'` 走一遍 STEP 0–7，
// 读完 `decision` 行后**无条件 ROLLBACK**——库层不留任何痕迹。
//
// 它证明的是「写路径与 readback 成立」，**不证明**「有人批准过」。真实批准必须由真人
// 在 Web UI 的 approval 提示里点（BLOCKED，见 README §3）。
//
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/decision-dryrun.mjs --args evidence/10-decision-advance/decision-args.json --out 21-decision-dryrun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPool, closePool, resolveDatabaseConfig } from '../../src/db/pool.ts'
import { recordDecisionInTransaction } from '../../src/tools/decision-record.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const argsPath = opt('--args')
const out = opt('--out', 'decision-dryrun')
if (argsPath === undefined) {
  console.error('需要 --args <decision-args.json>')
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

const args = JSON.parse(readFileSync(resolve(argsPath), 'utf8'))
const pool = createPool(resolved)
const client = await pool.connect()
const lines = ['# decision 写路径回滚试跑', '', 'approval = 测试替身 `() => "allowed-once"`（**不是真人批准**）', '事务结束时 **ROLLBACK**：库层不留任何行', '']
let value
try {
  await client.query('begin')
  await client.query("select set_config('recruitment.actor_id', $1, true)", [resolved.actor_id])
  value = await recordDecisionInTransaction(client, resolved, args, Date.now(), async () => 'allowed-once')
  const { rows } = await client.query(
    `select d.id, d.application_id, d.interview_id, d.decision_scope, d.stage_code, d.result,
            d.decided_by_actor_id, a.kind as decider_kind, a.display_name as decider_name,
            d.decided_at, d.record_version, d.superseded_by_decision_id,
            jsonb_array_length(d.basis_refs) as basis_refs_count,
            (select count(*)::int from recruitment.event_inbox e where e.source_object_id = d.id::text) as internal_events
       from recruitment.decision d
       join recruitment.actor a on a.id = d.decided_by_actor_id and a.tenant_id = d.tenant_id
      where d.id = $1`, [value.decision.id])
  lines.push('=== 出参（节选） ===')
  lines.push(JSON.stringify({
    decision: value.decision,
    gate: value.gate,
    event: value.event,
    warnings: value.warnings,
  }, null, 2))
  lines.push('')
  lines.push('=== 库内读回（同一事务，随后回滚） ===')
  for (const row of rows) lines.push(JSON.stringify(row))
  lines.push('')
  lines.push('=== 结论 ===')
  lines.push('写路径成立：decision 行 + 内部事件 + basis_refs 都写进了库；')
  lines.push('但这**不是**真人批准：approval 是测试替身，且事务已回滚，库里没有这条决策。')
} catch (error) {
  lines.push(`失败：${error?.code ?? error?.name}: ${error?.message ?? String(error)}`)
  process.exitCode = 1
} finally {
  await client.query('rollback').catch(() => {})
  client.release()
  await closePool(pool)
}

const text = lines.join('\n')
const evidenceDir = join(HERE, 'evidence', out)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'decision-dryrun.txt'), `${text}\n`, 'utf8')
console.log(text)
