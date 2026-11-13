// S10 评价线 · 类型层负例的**直接调用**取证（不是 agent loop，但调的是同一个 shipped 工具）。
//
// 为什么要单独跑：真实 headless 里，模型是**按 `parameters` 的封闭 schema 生成参数**的，
// 它根本不会把 `items` 发成数组，也不会把证据 kind 写成已作废的 `TRANSCRIPT_SEGMENT`。
// 所以这两个负例在真实会话里**构造不出来**（这本身是好性质：schema 在约束模型）。
// 但契约要求"传数组必须拒"，因此这里直接对 `execute()` 调一次，拿真实拒绝凭证。
//
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/negatives.mjs --out negatives
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createDecisionRecordTool } from '../../src/tools/decision-record.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const at = argv.indexOf('--out')
const out = at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : 'negatives'

const TENANT = '11111111-1111-4111-8111-000000000001'
const X = '11111111-1111-4111-8111-000000000105'
const INTERVIEW = '11111111-1111-4111-8111-000000000801'
const ARTIFACT = '11111111-1111-4111-8111-000000000a01'
const SEGMENT = 'a9aa1ed9-4e8e-4d7b-a113-a4e349afd87b'

function config(actorId) {
  const { resolved, issues } = resolveDatabaseConfig({
    host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
    tenant_id: TENANT, actor_id: actorId,
  }, process.env)
  if (resolved === null) {
    console.error('database config issues:', issues)
    process.exit(2)
  }
  return resolved
}

const validItems = {
  transcript_basis: 'TRANSCRIPT',
  backend_depth: { assessment: 'MET', score: 4, note: '示例' },
  async_pipeline: { assessment: 'MET', score: 3, note: '示例' },
  frontend_basics: { assessment: 'MET', score: 2, note: '示例' },
}

/** 跑一个用例，返回 {name, expect, got, message}。 */
async function run(name, expect, tool, args) {
  let error
  try {
    await tool.execute(args, { signal: new AbortController().signal })
  } catch (caught) {
    error = caught
  }
  const message = error === undefined ? null : String(error.message ?? error)
  const got = error === undefined ? 'NO_ERROR (unexpected success!)' : (error.code ?? error.name ?? 'UNKNOWN')
  return { name, expect, got, ok: got === expect, message }
}

const xConfig = config(X)
const scorecard = createScorecardSubmitTool({ database: xConfig })
const decisionNoApproval = createDecisionRecordTool({ database: xConfig })

const cases = []
cases.push(await run('items 传数组', 'INVALID_ARGS', scorecard, {
  interview_id: INTERVIEW,
  idempotency_key: 'direct:neg:items-array',
  items: [{ dimension_key: 'backend_depth', assessment: 'MET' }],
  overall: 'HOLD',
}))
cases.push(await run('证据 kind=TRANSCRIPT_SEGMENT（已作废）', 'INVALID_ARGS', scorecard, {
  interview_id: INTERVIEW,
  idempotency_key: 'direct:neg:evidence-kind',
  items: {
    ...validItems,
    backend_depth: {
      assessment: 'MET', score: 4, note: '示例',
      evidence: [{ kind: 'TRANSCRIPT_SEGMENT', transcript_artifact_id: ARTIFACT, transcript_revision: 1, segment_id: SEGMENT, quote: '订单表按用户 ID 分成 64 片' }],
    },
  },
  overall: 'HOLD',
}))
cases.push(await run('保留键 actor_id', 'INVALID_ARGS', scorecard, {
  interview_id: INTERVIEW,
  idempotency_key: 'direct:neg:actor',
  items: validItems,
  overall: 'HOLD',
  actor_id: '11111111-1111-4111-8111-000000000104',
}))
cases.push(await run('decision 传 idempotency_key（D-80 不接受）', 'INVALID_ARGS', decisionNoApproval, {
  application_id: '11111111-1111-4111-8111-000000000701',
  decision_scope: 'STAGE',
  interview_id: INTERVIEW,
  as_of: '2026-11-13T18:00:00+08:00',
  result: 'HOLD',
  reason: '示例',
  basis_refs: [{ kind: 'SUMMARY', summary_digest: 'x' }],
  summary_digest: 'a'.repeat(64),
  human_confirmation: { confirmed_by_actor_id: X, confirmed_at: '2026-11-13T18:00:00+08:00', confirmation_method: 'IN_APP_CONFIRM', confirmation_text_sha256: 'b'.repeat(64) },
  idempotency_key: 'nope',
}))
cases.push(await run('decision result=HIRED（v1.0 不做的）', 'INVALID_ARGS', decisionNoApproval, {
  application_id: '11111111-1111-4111-8111-000000000701',
  decision_scope: 'STAGE',
  interview_id: INTERVIEW,
  as_of: '2026-11-13T18:00:00+08:00',
  result: 'HIRED',
  reason: '示例',
  basis_refs: [{ kind: 'SUMMARY', summary_digest: 'x' }],
  summary_digest: 'a'.repeat(64),
  human_confirmation: { confirmed_by_actor_id: X, confirmed_at: '2026-11-13T18:00:00+08:00', confirmation_method: 'IN_APP_CONFIRM', confirmation_text_sha256: 'b'.repeat(64) },
}))

const lines = []
for (const item of cases) {
  lines.push(`--- ${item.name} ---`)
  lines.push(`expect=${item.expect}  got=${item.got}  ${item.ok ? 'PASS' : 'FAIL'}`)
  lines.push(`message=${item.message}`)
  lines.push('')
}
const failed = cases.filter((item) => !item.ok).length
lines.push(`=== ${cases.length - failed}/${cases.length} PASS，${failed} FAIL ===`)
const text = lines.join('\n')
const evidenceDir = join(HERE, 'evidence', out)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(join(evidenceDir, 'negatives.txt'), `${text}\n`, 'utf8')
console.log(text)
process.exitCode = failed === 0 ? 0 : 1
