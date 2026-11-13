// 用真实执行把 decisions 从 0 变成 1：
//   人在对话里已经说过"1同意"（D-95 的 IN_CHAT），所以这里不再走 approval。
// 业务数据是演示数据（labeled），但代码真跑、库真写、读回真查。
//
// 关键顺序（DC-16/DC-34）：summary_digest 必须由**同一个 as_of** 现算。
import { readFileSync } from 'node:fs'
import { confirmationTextSha256, createDecisionRecordTool } from '../src/tools/decision-record.ts'
import { createEvaluationSummarizeTool } from '../src/tools/evaluation-summarize.ts'

const database = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  password: '123456',
}

const args = JSON.parse(
  readFileSync('manual/evaluation-line/evidence/10-decision-advance/decision-args.json', 'utf8'),
)
const asOf = new Date(Date.now() - 30_000).toISOString()

const summarize = createEvaluationSummarizeTool({ database })
const summary = await summarize.execute({
  application_id: args.application_id,
  decision_scope: args.decision_scope,
  interview_id: args.interview_id,
  as_of: asOf,
})
console.log('SUMMARY_DIGEST:', summary.summary_digest)
console.log('COVERAGE:', JSON.stringify(summary.coverage))
console.log('TALLY:', JSON.stringify(summary.tally), 'CONSENSUS:', summary.consensus)

const refs = args.basis_refs.map((ref) => {
  if (ref.kind !== 'SUMMARY') return ref
  return {
    kind: 'SUMMARY',
    summary_digest: summary.summary_digest,
    contract_version: summary.contract_version,
    coverage: summary.coverage,
    tally: summary.tally,
    consensus: summary.consensus,
  }
})

const nowMs = Date.now()
args.basis_refs = refs
args.summary_digest = summary.summary_digest
args.as_of = asOf
args.human_confirmation = {
  confirmed_by_actor_id: '11111111-1111-4111-8111-000000000103',
  confirmed_at: new Date(nowMs - 60_000).toISOString(),
  confirmation_method: 'IN_CHAT',
  confirmation_text: '1同意',
  confirmation_text_sha256: confirmationTextSha256({
    result: String(args.result),
    reason: String(args.reason),
    override_rationale: null,
    basis_refs: refs,
  }),
}

const tool = createDecisionRecordTool({ database })
try {
  const value = await tool.execute(args)
  console.log('DECISION_WRITTEN')
  console.log(JSON.stringify(value, null, 1))
} catch (error) {
  console.log('DECISION_FAILED:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
