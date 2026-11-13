// S10 评价线 · 演示用「决策入参准备器」（glue，不是产品运行时，也不替工具做判定）。
//
// 它只做两件人不方便手算的事：
//   1. 把 `recruitment_evaluation_summarize` 的输出 + 库里当前面评，拼成 `basis_refs`；
//   2. 按 DC-11 算 `human_confirmation.confirmation_text_sha256`
//      = sha256(canonicalJson({result, reason, override_rationale, basis_refs}))。
// **不落任何库**（只读事务）；所有门禁仍由 `recruitment_decision_record` 自己判。
//
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/prepare-decision.mjs --summary evidence/<run>/summary.json `
//        --actor 11111111-1111-4111-8111-000000000103 --result ADVANCE --scope STAGE `
//        --interview 11111111-1111-4111-8111-000000000801 --as-of 2026-11-13T18:00:00+08:00 `
//        --reason "……" [--dissent true --override "……"] [--proceed-with-missing true]
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { digestOf } from '../../src/tools/contract.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const flag = (name) => opt(name, 'false') === 'true'

const summaryPath = opt('--summary')
const actor = opt('--actor')
const result = opt('--result')
const scope = opt('--scope', 'STAGE')
const interviewId = opt('--interview')
const asOf = opt('--as-of')
const reason = opt('--reason')
const overrideRationale = opt('--override')
const proceedWithMissing = flag('--proceed-with-missing')
if ([summaryPath, actor, result, asOf, reason].some((v) => v === undefined)) {
  console.error('缺少必填参数（--summary --actor --result --as-of --reason）')
  process.exit(2)
}

const summaryText = readFileSync(summaryPath === undefined ? '' : summaryPath, 'utf8')
// 允许直接喂 summarize 的 tool/result 邮件体：抓第一个可解析的 JSON 对象。
const summary = JSON.parse(summaryText.slice(summaryText.indexOf('{'), summaryText.lastIndexOf('}') + 1))
const applicationId = opt('--application', summary.application_id)
const asOfUsed = summary.as_of ?? asOf

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('需要环境变量 RECRUITMENT_DB_PASSWORD')
  process.exit(2)
}
const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password, max: 2, application_name: 'evaluation-line-prepare',
})
const client = await pool.connect()
let args
try {
  await client.query('begin transaction read only')
  const { rows: appRows } = await client.query(
    `select a.id, a.tenant_id, a.job_id, a.rubric_version_id, d.hiring_manager_actor_id
       from recruitment.application a
       join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
       join recruitment.department d on d.id = j.department_id and d.tenant_id = j.tenant_id
      where a.id = $1`, [applicationId])
  const app = appRows[0]
  if (app === undefined) throw new Error(`application ${applicationId} 不存在`)
  const tenantId = app.tenant_id
  const isHiringManager = app.hiring_manager_actor_id === actor

  const scorecardWhere = scope === 'STAGE' ? 'and s.interview_id = $3' : ''
  const params = scope === 'STAGE' ? [tenantId, applicationId, interviewId] : [tenantId, applicationId]
  const { rows: scorecards } = await client.query(
    `select s.id, s.revision_no, s.interviewer_id, i.actor_id, s.payload_hash, s.overall, s.items,
            s.rationale, s.status
       from recruitment.scorecard s
       join recruitment.interviewer i on i.id = s.interviewer_id and i.tenant_id = s.tenant_id
       join recruitment.interview iv on iv.id = s.interview_id and iv.tenant_id = s.tenant_id
      where s.tenant_id = $1 and iv.application_id = $2 and s.superseded_by_scorecard_id is null
        and s.status in ('SUBMITTED','WAIVED') ${scorecardWhere}
      order by s.interviewer_id`, params)

  const transcriptRows = scope === 'STAGE'
    ? (await client.query(
      `select ta.transcript_status
         from recruitment.meeting_binding mb
         join recruitment.transcript_artifact ta
           on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id and ta.is_canonical
        where mb.tenant_id = $1 and mb.interview_id = $2 and mb.unbound_at is null
        order by ta.source_revision desc limit 1`, [tenantId, interviewId])).rows
    : []
  const transcriptState = transcriptRows[0]?.transcript_status ?? 'NO_TRANSCRIPT'

  const basisRefs = [
    {
      kind: 'SUMMARY',
      summary_digest: summary.summary_digest,
      contract_version: '2.0.0',
      coverage: summary.coverage,
      tally: summary.tally,
      consensus: summary.consensus,
    },
    {
      kind: 'RUBRIC_VERSION',
      id: summary.rubric.version_id,
      version_no: summary.rubric.version_no,
      payload_hash: summary.rubric.payload_hash,
    },
    { kind: 'AUTHORITY', actor_id: actor, is_hiring_manager: isHiringManager },
    ...scorecards.map((row) => ({
      kind: 'SCORECARD',
      id: row.id,
      revision_no: row.revision_no,
      interviewer_id: row.interviewer_id,
      payload_hash: row.payload_hash,
      overall: row.overall,
      transcript_basis: row.items?.transcript_basis ?? 'NO_TRANSCRIPT',
      transcript_state: transcriptState,
      fields: Object.entries(row.items ?? {})
        .filter(([key]) => key !== 'transcript_basis')
        .map(([dimensionKey, item]) => ({
          dimension_key: dimensionKey,
          assessment: item?.assessment ?? null,
          evidence: Array.isArray(item?.evidence) ? item.evidence : [],
        })),
    })),
  ]

  const opposite = (result === 'REJECT' && ['UNANIMOUS_ADVANCE', 'MAJORITY_ADVANCE'].includes(summary.consensus))
    || (result === 'ADVANCE' && ['UNANIMOUS_REJECT', 'MAJORITY_REJECT'].includes(summary.consensus))
  if (flag('--dissent') || opposite) {
    basisRefs.push({
      kind: 'OVERRIDE',
      acknowledged_dissent: true,
      override_rationale: overrideRationale ?? '',
    })
  }
  if (proceedWithMissing) {
    basisRefs.push({
      kind: 'MISSING_ACK',
      interviewer_ids: (summary.missing ?? []).map((m) => m.interviewer_id),
      rationale: opt('--missing-rationale', '演示：已知缺人并逐条确认'),
    })
  }

  const preimage = {
    result,
    reason,
    override_rationale: overrideRationale ?? null,
    basis_refs: basisRefs,
  }
  const acknowledgedMissing = (summary.missing ?? []).map((m) => ({
    interviewer_id: m.interviewer_id,
    why_proceed: opt('--missing-why', '演示：该面试官负责的维度已由其他面试官交叉覆盖'),
  }))

  args = {
    application_id: applicationId,
    decision_scope: scope,
    ...(scope === 'STAGE' ? { interview_id: interviewId } : {}),
    as_of: asOfUsed,
    result,
    reason,
    basis_refs: basisRefs,
    ...(proceedWithMissing
      ? { missing_disposition: 'PROCEED_WITH_MISSING', acknowledged_missing: acknowledgedMissing }
      : {}),
    ...(flag('--dissent') || opposite
      ? { acknowledged_dissent: true, override_rationale: overrideRationale ?? '' }
      : {}),
    summary_digest: summary.summary_digest,
    human_confirmation: {
      confirmed_by_actor_id: actor,
      confirmed_at: asOf,
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: digestOf(preimage),
    },
  }
  await client.query('commit')
} finally {
  client.release()
  await pool.end()
}

const out = join(HERE, 'evidence', opt('--out', 'prepared'), 'decision-args.json')
import('node:fs').then(({ mkdirSync, writeFileSync }) => {
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(args, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(args, null, 2))
  console.log(`\n[prepare] 已写入 ${out}`)
})
