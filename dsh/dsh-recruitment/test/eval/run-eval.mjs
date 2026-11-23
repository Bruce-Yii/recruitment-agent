#!/usr/bin/env node
// Issue #55 — 模型无关 Eval Runner（自包含、离线可复现）。
//
//   node test/eval/run-eval.mjs --mode=deterministic          # 必须 18/18
//   node test/eval/run-eval.mjs --mode=live --runs=1          # 可选，真 POST /recruitment/agent/turn
//
// 模型无关纪律：runner 不写死任何模型名。live 模式只从“当前兼容运行时配置”读取
// （环境变量 RECRUITMENT_EVAL_MODEL_PROVIDER / RECRUITMENT_EVAL_MODEL，或
// evidence/eval/live-config.json）。没有配置就**如实报告 live 未运行**，绝不伪造通过。
// 输出：evidence/eval/latest-summary.json + latest-summary.md。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEvalFixture } from './seed-eval-db.ts'
import { buildCases } from './cases.ts'
import { gradeL1 } from './graders-l1.ts'
import { gradeL2 } from './graders-l2.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = join(HERE, '..', '..', 'evidence', 'eval')
const SUMMARY_JSON = join(EVIDENCE_DIR, 'latest-summary.json')
const SUMMARY_MD = join(EVIDENCE_DIR, 'latest-summary.md')
const LIVE_CONFIG = join(EVIDENCE_DIR, 'live-config.json')

function parseArgs(argv) {
  const out = { mode: 'deterministic', runs: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length)
    else if (arg === '--mode') out.mode = argv[++i]
    else if (arg.startsWith('--runs=')) out.runs = Number(arg.slice('--runs='.length))
    else if (arg === '--runs') out.runs = Number(argv[++i])
  }
  if (out.mode !== 'deterministic' && out.mode !== 'live') {
    throw new Error(`unknown mode ${JSON.stringify(out.mode)} (expected deterministic|live)`)
  }
  if (!Number.isInteger(out.runs) || out.runs < 1) throw new Error('--runs must be a positive integer')
  return out
}

function gradeTrajectory(c, trajectory) {
  const l1 = gradeL1(trajectory)
  const l2 = gradeL2(trajectory)
  const mandatory = new Set([...c.mandatoryL1, ...c.mandatoryL2])
  const byCode = new Map([...l1, ...l2].map((result) => [result.code, result]))
  const missing = [...mandatory].filter((code) => !byCode.has(code))
  const failed = [...l1, ...l2].filter((result) => !result.ok).map((result) => result.code)
  const failedMandatory = [...mandatory].filter((code) => byCode.get(code)?.ok === false)
  return {
    caseId: c.id,
    passed: missing.length === 0 && failedMandatory.length === 0 && failed.length === 0,
    l1_passed: l1.filter((r) => r.ok).length,
    l1_total: l1.length,
    l2_passed: l2.filter((r) => r.ok).length,
    l2_total: l2.length,
    failed,
    missing,
    failedMandatory,
  }
}

function percentile(values, q) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[index]
}

/** 从当前兼容运行时配置读取模型（**绝不写死模型名**）。 */
function readRuntimeModel() {
  let fromFile = {}
  if (existsSync(LIVE_CONFIG)) {
    try {
      fromFile = JSON.parse(readFileSync(LIVE_CONFIG, 'utf8'))
    } catch (error) {
      return { config: null, reason: `live-config.json 无法解析：${String(error)}` }
    }
  }
  const provider = process.env.RECRUITMENT_EVAL_MODEL_PROVIDER ?? fromFile.provider
  const model = process.env.RECRUITMENT_EVAL_MODEL ?? fromFile.model
  const reasoningEffort = process.env.RECRUITMENT_EVAL_MODEL_REASONING ?? fromFile.reasoning_effort ?? fromFile.reasoningEffort
  if (typeof provider !== 'string' || provider.trim() === '' || typeof model !== 'string' || model.trim() === '') {
    return {
      config: null,
      reason: '当前没有兼容运行时模型配置（需 RECRUITMENT_EVAL_MODEL_PROVIDER + RECRUITMENT_EVAL_MODEL 或 evidence/eval/live-config.json）；live 未运行，不伪造结果',
    }
  }
  return {
    config: {
      provider: provider.trim(),
      model: model.trim(),
      ...(typeof reasoningEffort === 'string' && reasoningEffort.trim() !== ''
        ? { reasoning_effort: reasoningEffort.trim() } : {}),
    },
    reason: null,
  }
}

/** 解析 agent-turn SSE，归一化成与 deterministic 同形的轨迹。 */
function normalizeSse(raw) {
  const events = []
  let answer = ''
  const blocks = raw.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const lines = block.split(/\r?\n/)
    let eventName = 'message'
    const dataLines = []
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (dataLines.length === 0) continue
    let data
    try { data = JSON.parse(dataLines.join('\n')) } catch { continue }
    if (eventName === 'delta' && typeof data.text === 'string') {
      answer += data.text
    } else if (eventName === 'tool') {
      events.push({
        kind: 'tool',
        name: typeof data.name === 'string' ? data.name : 'tool',
        status: data.status === 'ok' || data.status === 'error' ? data.status : 'start',
        ...(data.input === undefined ? {} : { input: data.input }),
        ...(typeof data.result === 'string' ? { result: data.result } : {}),
      })
      if (data.status === 'error' && typeof data.message === 'string' && /NOT_CONFIGURED/.test(data.message)) {
        events.push({ kind: 'tool_error', name: String(data.name ?? 'tool'), code: 'NOT_CONFIGURED', reason: data.message })
      }
    } else if (eventName === 'ui_action') {
      events.push({ kind: 'ui_action', action: String(data.action ?? ''), payload: data })
    } else if (eventName === 'error') {
      events.push({ kind: 'tool_error', name: 'agent_turn', code: String(data.code ?? 'AGENT_ERROR'), reason: String(data.message ?? '') })
    }
  }
  if (answer !== '') events.push({ kind: 'answer', text: answer })
  return events
}

async function callAgentTurn(c, runtime) {
  const base = runtime.baseUrl.replace(/\/$/, '')
  const url = `${base}/recruitment/agent/turn`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-dsh-session': runtime.session,
      'x-recruitment-request': '1',
      ...(runtime.diag ? { 'x-recruitment-agent-diag': '1' } : {}),
    },
    body: JSON.stringify({
      text: c.input,
      context: {
        route: c.context.route,
        ...(c.context.application_id === undefined ? {} : { application_id: c.context.application_id }),
        ...(c.context.job_id === undefined ? {} : { job_id: c.context.job_id }),
      },
    }),
    signal: AbortSignal.timeout(Number(process.env.RECRUITMENT_EVAL_TIMEOUT_MS ?? 120000)),
  })
  const raw = await response.text()
  if (!response.ok) throw new Error(`agent/turn HTTP ${response.status}: ${raw.slice(0, 400)}`)
  return normalizeSse(raw)
}

async function runLive(cases, modelConfig, cliRuns) {
  const baseUrl = process.env.RECRUITMENT_EVAL_BASE_URL ?? 'http://127.0.0.1:61851'
  const session = process.env.RECRUITMENT_EVAL_SESSION ?? `session-eval-${process.pid}`
  const runs = cliRuns ?? Number(process.env.RECRUITMENT_EVAL_RUNS ?? 1)
  const runtime = { baseUrl, session, diag: false }
  const results = []
  const latencies = []
  let tokens = null
  for (const c of cases) {
    const attempts = []
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now()
      const events = await callAgentTurn(c, runtime)
      const latencyMs = performance.now() - started
      latencies.push(latencyMs)
      const trajectory = {
        caseId: c.id,
        events,
        // live 模式没有 DB 阴影：不伪造“零行数变化”，相关判据在 graders 里标为跳过。
        countsBefore: undefined,
        countsAfter: undefined,
        expectedWriteIntent: c.golden.expectedWriteIntent,
        expectedApplicationId: c.golden.expectedApplicationId,
        expectsNotConfigured: c.golden.expectsNotConfigured,
        crossJobRecall: c.golden.crossJobRecall,
        adversarial: c.golden.adversarial,
      }
      attempts.push(gradeTrajectory(c, trajectory))
    }
    const passed = attempts.every((a) => a.passed)
    results.push({ caseId: c.id, passed, attempts })
  }
  const passed = results.filter((r) => r.passed).length
  const core = ['E-03', 'E-04', 'E-05', 'E-09', 'E-10', 'E-12', 'E-15', 'E-16']
  const coreResults = results.filter((r) => core.includes(r.caseId))
  return {
    mode: 'live',
    model: modelConfig,
    cases_total: cases.length,
    passed,
    failed: cases.length - passed,
    pass_rate: passed / cases.length,
    adversarial_all_pass: results.filter((r) => ['E-15', 'E-16', 'E-17', 'E-18'].includes(r.caseId)).every((r) => r.passed),
    core_pass_hat_k: coreResults.length === core.length && coreResults.every((r) => r.passed) ? 1 : null,
    latency_ms: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    token_usage: { per_turn: tokens },
    per_case: results,
  }
}

function runDeterministic(cases) {
  const results = cases.map((c) => gradeTrajectory(c, c.golden))
  const passed = results.filter((r) => r.passed).length
  const adversarialIds = ['E-15', 'E-16', 'E-17', 'E-18']
  return {
    mode: 'deterministic',
    model: null,
    cases_total: cases.length,
    passed,
    failed: cases.length - passed,
    pass_rate: passed / cases.length,
    adversarial_all_pass: results.filter((r) => adversarialIds.includes(r.caseId)).every((r) => r.passed),
    core_pass_hat_k: null,
    latency_ms: { p50: null, p95: null },
    token_usage: { per_turn: null },
    per_case: results,
  }
}

function buildSummary(args, run, liveStatus) {
  const notRun = run.passed === null
  const l1Passed = notRun ? null : run.per_case.reduce((n, r) => n + r.l1_passed, 0)
  const l1Total = notRun ? null : run.per_case.reduce((n, r) => n + r.l1_total, 0)
  const l2Passed = notRun ? null : run.per_case.reduce((n, r) => n + r.l2_passed, 0)
  const l2Total = notRun ? null : run.per_case.reduce((n, r) => n + r.l2_total, 0)
  return {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    mode: args.mode,
    model: run.model ?? null,
    cases_total: run.cases_total,
    l1_passed: l1Passed,
    l1_total: l1Total,
    l2_passed: l2Passed,
    l2_total: l2Total,
    passed: run.passed,
    failed: run.failed,
    pass_rate: run.pass_rate,
    adversarial_all_pass: run.adversarial_all_pass,
    gate_status: notRun
      ? { l1: 'NOT_RUN', l2: 'NOT_RUN', l3: 'NOT_RUN', l4: 'NOT_RUN' }
      : {
        l1: run.failed === 0 && run.per_case.every((r) => r.failed.every((code) => !code.startsWith('L1.'))) ? 'PASS' : 'FAIL',
        l2: run.per_case.every((r) => r.failed.every((code) => !code.startsWith('L2.'))) ? 'PASS' : 'FAIL',
        l3: 'NOT_RUN',
        l4: 'NOT_RUN',
      },
    latency_ms: run.latency_ms,
    token_usage: run.token_usage,
    pass_hat_k: run.core_pass_hat_k,
    per_case: run.per_case,
    live: liveStatus,
    notes: notRun
      ? 'live 未运行：当前没有兼容运行时模型配置；本摘要不含任何 live 结果，deterministic 基线请另跑 --mode=deterministic。'
      : args.mode === 'deterministic'
        ? '离线 golden 轨迹跑 18 例；模型为 null（模型无关）；live 未运行。'
        : 'live 结果来自真实 POST /recruitment/agent/turn；无模型配置时不运行。',
  }
}

function renderMarkdown(summary) {
  const lines = [
    '# Issue #55 — Model-agnostic Eval Summary',
    '',
    `- schema_version: ${summary.schema_version}`,
    `- generated_at: ${summary.generated_at}`,
    `- mode: ${summary.mode}`,
    `- model: ${summary.model === null ? 'null（模型无关 / 未配置）' : `${summary.model.provider}/${summary.model.model}`}`,
    `- cases: ${summary.passed === null ? 'NOT RUN' : `${summary.passed}/${summary.cases_total} passed (${(summary.pass_rate * 100).toFixed(1)}%)`}`,
    `- L1: ${summary.l1_passed === null ? 'NOT RUN' : `${summary.l1_passed}/${summary.l1_total}`} · L2: ${summary.l2_passed === null ? 'NOT RUN' : `${summary.l2_passed}/${summary.l2_total}`}`,
    `- adversarial E-15..E-18: ${summary.adversarial_all_pass ? 'ALL PASS' : 'FAIL'}`,
    `- gates: L1=${summary.gate_status.l1} L2=${summary.gate_status.l2} L3=${summary.gate_status.l3} L4=${summary.gate_status.l4}`,
    `- pass^k (core 8): ${summary.pass_hat_k === null ? 'not measured' : summary.pass_hat_k}`,
    `- latency p50/p95 (ms): ${summary.latency_ms.p50 ?? 'n/a'} / ${summary.latency_ms.p95 ?? 'n/a'}`,
    `- token/turn: ${summary.token_usage.per_turn === null ? 'n/a' : JSON.stringify(summary.token_usage.per_turn)}`,
    `- live: ${summary.live.ran ? 'ran' : 'NOT RUN'} — ${summary.live.reason}`,
    '',
    '## Per-case',
    '',
    '| case | result | failed invariants |',
    '|---|---|---|',
    ...summary.per_case.map((r) => `| ${r.caseId} | ${r.passed ? 'PASS' : 'FAIL'} | ${r.failed.join(', ') || '—'} |`),
    '',
    summary.notes,
  ]
  return `${lines.join('\n')}\n`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const fixture = buildEvalFixture()
  const cases = buildCases(fixture)
  mkdirSync(EVIDENCE_DIR, { recursive: true })

  let run
  let liveStatus
  if (args.mode === 'deterministic') {
    run = runDeterministic(cases)
    liveStatus = { ran: false, reason: 'deterministic mode (offline golden trajectory); no live POST issued' }
  } else {
    const { config, reason } = readRuntimeModel()
    if (config === null) {
      // 没有模型配置：如实报告 live 未运行。**不得**把 deterministic 的 18/18 冒充 live 结果。
      run = {
        mode: 'live',
        model: null,
        cases_total: cases.length,
        passed: null,
        failed: null,
        pass_rate: null,
        adversarial_all_pass: null,
        l1_passed: null,
        l1_total: null,
        l2_passed: null,
        l2_total: null,
        core_pass_hat_k: null,
        latency_ms: { p50: null, p95: null },
        token_usage: { per_turn: null },
        per_case: [],
      }
      liveStatus = { ran: false, reason }
    } else {
      run = await runLive(cases, config, args.runs)
      liveStatus = { ran: true, reason: null }
    }
  }

  const summary = buildSummary(args, run, liveStatus)
  writeFileSync(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  writeFileSync(SUMMARY_MD, renderMarkdown(summary), 'utf8')

  console.log(summary.passed === null
    ? `eval ${summary.mode}: NOT RUN (${summary.live.reason})`
    : `eval ${summary.mode}: ${summary.passed}/${summary.cases_total} passed, L1 ${summary.l1_passed}/${summary.l1_total}, L2 ${summary.l2_passed}/${summary.l2_total}`)
  console.log(`live: ${summary.live.ran ? 'RAN' : 'NOT RUN'} — ${summary.live.reason}`)
  console.log(`evidence: ${SUMMARY_JSON} / ${SUMMARY_MD}`)
  if (summary.failed > 0) process.exitCode = 1
  if (args.mode === 'deterministic' && summary.passed !== 18) process.exitCode = 1
}

main().catch((error) => {
  console.error(`eval runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
