#!/usr/bin/env node
// Issue #92 P1-B (B1) — Eval V2 统一 CLI：contract_smoke / real_adapter 双模式。
//
//   node test/eval/run-eval-v2.mjs --gate=ALL --mode=contract
//   node test/eval/run-eval-v2.mjs --gate=ALL --mode=real --capture=<dir> [--out=<dir>]
//   node test/eval/run-eval-v2.mjs --gate=ALL --mode=live --base-url=http://127.0.0.1:49349 --session=<token> --pg-db=<db> [--runs=K]
//
// 纪律（INTERFACE-CONTRACT.md + AGENTS.md R2/R3/R4）：
//  - contract 模式：不传 artifactProvider → runEvalGateSuite 标 executionMode='contract_smoke'。
//  - real 模式：必须显式 --capture 且 bundle 完整；缺失/不完整 → stderr 明确报错 + exit 2，绝不回退 contract。
//  - live 模式（Phase 3 MVP）：必须显式 --base-url/--session/--pg-db（口令仅从环境读）；
//    缺失 → stderr 明确 FATAL + exit 2，绝不回退 contract/real。CI 不跑 live。
//  - real 模式真实 import 并调用 v2-real-adapters.ts 的三个适配器；无真实源案例返回 null（NO_REAL_SOURCE，
//    不送判分、不计 PASS、不计入 passRate 分母）；零执行 → card.passRate=null。
//  - 输出 JSON + markdown evaluation card 到 <out>/evaluation-card.{json,md}；live 另写 live-report.json。
//  - 退出码：contract=0（runner 抛错除外）；real capture 缺失/不完整=2；真实源存在但全部执行失败=3；
//    live 配置缺失=2 / 任一 case ERROR、FAIL 或零执行=3；否则 0。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

import { runEvalGateSuite } from './v2-g0-runner.ts'
import { formatEvaluationCardMarkdown } from './evaluation-card.ts'
import {
  adaptConverterDocumentToP1Artifact,
  adaptScreeningToP2Artifact,
  adaptHandoffBriefToP3Artifact,
  adaptTranscriptDraftToP4Artifact,
  adaptDecisionSummaryToP5Artifact,
  adaptAgentTurnSseToP6Artifact,
  readPgTableRowCounts,
  computePassPowerK,
} from './v2-real-adapters.ts'
import { scanPrivateCorpusInventory } from './corpus-inventory.ts'
import { BENCHMARK_REGISTRY, loadCachedBenchmark } from './benchmark-loader.ts'
import { readL3RuntimeModelConfig, runL3AtomicJudge } from './v2-l3-runner.ts'
import { createL3Invoker, readL3InvokerConfig } from './v2-l3-invoker.ts'
import { L3_JUDGE_PROMPT_REGISTRY_VERSION, listL3JudgePrompts } from './v2-l3-prompts.ts'
import { adaptFunnelTrajectoryToP6Artifact } from './v2-funnel-driver.ts'
import { runLiveEval } from './v2-live-runner.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '..', '..', 'work', 'lane92-adapters', 'card')

// Phase 3 --l3 探针：每个已注册 L3 grader 一条，全部为简短合成样例（无真实个资）。
// criterionPrompt / judgeVersion / promptVersion 均来自 v2-l3-prompts.ts registry。
const L3_PROBE_FIXTURES = {
  L3_fluff_detection: {
    sourceMaterial: '面试官：举一个具体问题。候选人甲：我把报表导出从十分钟优化到两分钟。',
    candidateOutput: '候选人具备强烈的自驱力与结果导向，是团队核心驱动力。',
  },
  L3_claim_faithfulness: {
    sourceMaterial: '面试官：为什么离职？候选人乙：团队模块合并，我想找更聚焦的方向。',
    candidateOutput: '候选人因团队模块合并而离职，希望转向更聚焦的方向。',
  },
  L3_numeric_grounding: {
    sourceMaterial: '面试官：这个项目做了多久？候选人丙：两年，负责接口分层。',
    candidateOutput: '候选人有五年项目经验，主导接口分层。',
  },
  L3_speaker_attribution_exact: {
    sourceMaterial: '面试官：我们季度有两次集中出差。候选人丁：希望提前一周通知。',
    candidateOutput: '候选人丁主动提出季度两次集中出差。',
  },
  L3_hallucination_rate: {
    sourceMaterial: '面试官：最熟悉的技术？候选人戊：TypeScript 与 PostgreSQL，其他接触不多。',
    candidateOutput: '候选人主导实时推荐引擎，持有相关专利。',
  },
  L3_second_probe_collapse_caught: {
    sourceMaterial: '面试官：缓存失效怎么办？候选人己：没想过，是同事处理的。',
    candidateOutput: '候选人完整设计了缓存失效预案。',
  },
  L3_team_vs_individual_separated: {
    sourceMaterial: '面试官：系统谁主导？候选人庚：五人小组共同完成，我只负责对账模块。',
    candidateOutput: '候选人庚主导了系统整体设计与全部交付。',
  },
}
const L3_PROBE_FALLBACK = {
  sourceMaterial: '合成材料：候选人表示负责对账模块。',
  candidateOutput: '候选人负责对账模块。',
}

function parseArgs(argv) {
  const out = {
    gate: 'ALL',
    mode: 'contract',
    runs: 1,
    checkData: false,
    l3: false,
    capture: undefined,
    // live 模式必需参数：只认显式 CLI 入参，绝不从环境偷偷补一个 Host/session 冒充已配置。
    baseUrl: undefined,
    session: undefined,
    out: DEFAULT_OUT,
    pgDb: process.env.RECRUITMENT_TEST_DB,
    pgHost: process.env.RECRUITMENT_PG_HOST ?? '127.0.0.1',
    pgPort: process.env.RECRUITMENT_PG_PORT ?? '49353',
    pgUser: process.env.RECRUITMENT_PG_USER ?? 'postgres',
    // 与 db/migrations/0002_seed.sql 的 demo tenant 一致（capture 的 psql 对照是全表 count）。
    pgTenant: process.env.RECRUITMENT_TEST_TENANT_ID ?? '11111111-1111-4111-8111-000000000001',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--gate=')) out.gate = arg.slice('--gate='.length)
    else if (arg === '--gate') out.gate = argv[++i]
    else if (arg.startsWith('--mode=')) out.mode = arg.slice('--mode='.length)
    else if (arg === '--mode') out.mode = argv[++i]
    else if (arg.startsWith('--capture=')) out.capture = arg.slice('--capture='.length)
    else if (arg === '--capture') out.capture = argv[++i]
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length)
    else if (arg === '--base-url') out.baseUrl = argv[++i]
    else if (arg.startsWith('--session=')) out.session = arg.slice('--session='.length)
    else if (arg === '--session') out.session = argv[++i]
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length)
    else if (arg === '--out') out.out = argv[++i]
    else if (arg.startsWith('--pg-db=')) out.pgDb = arg.slice('--pg-db='.length)
    else if (arg === '--pg-db') out.pgDb = argv[++i]
    else if (arg.startsWith('--runs=')) out.runs = Math.max(1, Number(arg.slice('--runs='.length)) || 1)
    else if (arg === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1)
    else if (arg === '--check-data') out.checkData = true
    else if (arg === '--l3') out.l3 = true
    else if (arg.startsWith('--pg-tenant=')) out.pgTenant = arg.slice('--pg-tenant='.length)
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['G0', 'G1', 'G2', 'ALL'].includes(out.gate)) {
    throw new Error(`invalid --gate ${JSON.stringify(out.gate)} (expected G0|G1|G2|ALL)`)
  }
  if (!['contract', 'real', 'live'].includes(out.mode)) {
    throw new Error(`invalid --mode ${JSON.stringify(out.mode)} (expected contract|real|live)`)
  }
  if (out.mode === 'real' && (typeof out.capture !== 'string' || out.capture.trim() === '')) {
    console.error('[run-eval-v2] FATAL: --mode=real requires --capture=<dir>; refusing to fall back to contract (fail-closed).')
    process.exit(2)
  }
  // Issue #92 P1-B（总控裁决）：readPgTableRowCounts 必须真连 PG17 执行 SQL；禁止回放 capture 数字。
  if (out.mode === 'real' && (typeof out.pgDb !== 'string' || out.pgDb.trim() === '')) {
    console.error('[run-eval-v2] FATAL: --mode=real requires --pg-db=<database> or env RECRUITMENT_TEST_DB; real PG connection is mandatory (fail-closed).')
    process.exit(2)
  }
  // Phase 3 live：Host / session / DB 三者缺一即 FATAL，绝不静默回退 contract/real。
  if (out.mode === 'live') {
    if (typeof out.baseUrl !== 'string' || out.baseUrl.trim() === '') {
      console.error('[run-eval-v2] FATAL: --mode=live requires --base-url=<http(s)://host:port>; refusing to fall back to contract (fail-closed).')
      process.exit(2)
    }
    try {
      const parsed = new URL(out.baseUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`unsupported protocol ${parsed.protocol}`)
    } catch (error) {
      console.error(`[run-eval-v2] FATAL: --base-url must be an http(s) URL: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
    if (typeof out.session !== 'string' || out.session.trim() === '') {
      console.error('[run-eval-v2] FATAL: --mode=live requires --session=<x-dsh-session value>; refusing to send unauthenticated turns (fail-closed).')
      process.exit(2)
    }
    if (typeof out.pgDb !== 'string' || out.pgDb.trim() === '') {
      console.error('[run-eval-v2] FATAL: --mode=live requires --pg-db=<database> or env RECRUITMENT_TEST_DB; live PG counts readback is mandatory (fail-closed).')
      process.exit(2)
    }
    // 口令只从环境读取，绝不作为 CLI 参数/产物落盘；缺失即 FATAL（不打印值）。
    if (typeof (process.env.PGPASSWORD ?? process.env.RECRUITMENT_DB_PASSWORD) !== 'string'
      || (process.env.PGPASSWORD ?? process.env.RECRUITMENT_DB_PASSWORD).trim() === '') {
      console.error('[run-eval-v2] FATAL: --mode=live requires PGPASSWORD or RECRUITMENT_DB_PASSWORD env var for real PG readback; refusing to connect without credential (fail-closed).')
      process.exit(2)
    }
  }
  return out
}

/**
 * Issue #92 P1-B：用真实 pg.Pool 连接隔离 PG17，在只读事务中真跑 readPgTableRowCounts。
 * 口令只从环境读取（PGPASSWORD / RECRUITMENT_DB_PASSWORD），不进文件、不打印。
 */
async function readLivePgCounts(args) {
  const password = process.env.PGPASSWORD ?? process.env.RECRUITMENT_DB_PASSWORD
  if (!password) {
    throw new Error('PGPASSWORD / RECRUITMENT_DB_PASSWORD not set; refusing to connect without real credential')
  }
  const pool = new pg.Pool({
    host: args.pgHost,
    port: Number(args.pgPort),
    user: args.pgUser,
    database: args.pgDb,
    password,
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: 'eval-v2-real-adapter',
  })
  const client = await pool.connect()
  try {
    await client.query('begin transaction read only')
    const counts = await readPgTableRowCounts(client, args.pgTenant)
    await client.query('commit')
    return counts
  } catch (error) {
    try { await client.query('rollback') } catch { /* 回收连接时不覆盖原错误 */ }
    throw error
  } finally {
    client.release()
    await pool.end()
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** Capture bundle 校验：manifest + 三类真实源路径必须存在且字段齐全，否则 fail-closed。 */
function validateCapture(captureDir) {
  const errors = []
  const dir = resolve(captureDir)
  const paths = {
    manifest: join(dir, 'manifest.json'),
    converterDoc: join(dir, 'converter', 'document-content.json'),
    converterSha: join(dir, 'converter', 'source.pdf.sha256'),
    countsBefore: join(dir, 'pg', 'counts-before.json'),
    countsAfter: join(dir, 'pg', 'counts-after.json'),
    sseFrames: join(dir, 'sse', 'agent-turn-frames.jsonl'),
    sseBlocked: join(dir, 'sse', 'BLOCKED.json'),
  }
  for (const [key, p] of Object.entries(paths)) {
    if (key === 'sseFrames' || key === 'sseBlocked') continue
    if (!existsSync(p)) errors.push(`missing capture file: ${p}`)
  }

  let manifest
  if (!errors.length) {
    try {
      manifest = readJson(paths.manifest)
      if (manifest.schemaVersion !== '1.0') errors.push(`manifest.schemaVersion expected '1.0', got ${JSON.stringify(manifest.schemaVersion)}`)
      if (!manifest.sources || typeof manifest.sources !== 'object') errors.push('manifest.sources missing')
      if (!manifest.sha256 || typeof manifest.sha256 !== 'object') errors.push('manifest.sha256 missing')
      if (!Array.isArray(manifest.commands)) errors.push('manifest.commands missing')

      // 总控 P1 裁决：capture 必须有完整性校验。任何手填/篡改文件（manifest 未同步更新 sha256）→ fail-closed。
      if (manifest.sha256 && typeof manifest.sha256 === 'object') {
        const required = ['converter/document-content.json', 'pg/counts-before.json', 'pg/counts-after.json']
        if (existsSync(paths.sseFrames)) required.push('sse/agent-turn-frames.jsonl')
        for (const rel of required) {
          if (typeof manifest.sha256[rel] !== 'string' || manifest.sha256[rel].length !== 64) {
            errors.push(`capture integrity mismatch: ${rel} missing sha256 entry in manifest`)
          }
        }
        for (const [rel, expected] of Object.entries(manifest.sha256)) {
          const target = resolve(dir, rel)
          if (!existsSync(target)) {
            errors.push(`capture integrity mismatch: ${rel} file missing`)
            continue
          }
          const actual = createHash('sha256').update(readFileSync(target)).digest('hex')
          if (actual !== expected) {
            errors.push(`capture integrity mismatch: ${rel} (expected ${expected}, got ${actual})`)
          }
        }
      }

      // 来源类型门槛：防止手写 manifest 声称真实来源（R4 标签铁律）。
      const kinds = {
        converter: manifest.sources?.converter?.kind,
        pg: manifest.sources?.pg?.kind,
        sse: manifest.sources?.sse?.kind,
      }
      if (kinds.converter !== 'LIVE_PYTHON_CONVERTER') errors.push(`invalid capture source kind: converter=${JSON.stringify(kinds.converter)} (expected LIVE_PYTHON_CONVERTER)`)
      if (kinds.pg !== 'LIVE_PG17') errors.push(`invalid capture source kind: pg=${JSON.stringify(kinds.pg)} (expected LIVE_PG17)`)
      if (kinds.sse !== 'LIVE_HOST_SSE' && !(existsSync(paths.sseBlocked))) {
        errors.push(`invalid capture source kind: sse=${JSON.stringify(kinds.sse)} (expected LIVE_HOST_SSE or BLOCKED.json)`)
      }
    } catch (error) {
      errors.push(`manifest.json unreadable: ${String(error)}`)
    }
  }

  let doc
  if (!errors.length) {
    try {
      doc = readJson(paths.converterDoc)
      if (typeof doc.completeness !== 'string') errors.push('converter/document-content.json missing completeness')
      if (typeof doc.needs_visual !== 'boolean') errors.push('converter/document-content.json missing needs_visual')
      if (!Array.isArray(doc.blocks)) errors.push('converter/document-content.json missing blocks')
      if (!Array.isArray(doc.issues)) errors.push('converter/document-content.json missing issues')
    } catch (error) {
      errors.push(`converter/document-content.json unreadable: ${String(error)}`)
    }
  }

  let countsBefore
  let countsAfter
  if (!errors.length) {
    try {
      countsBefore = readJson(paths.countsBefore)
      countsAfter = readJson(paths.countsAfter)
      for (const [label, counts] of [['counts-before', countsBefore], ['counts-after', countsAfter]]) {
        for (const table of ['application', 'interview', 'scorecard', 'decision', 'criterion_override']) {
          if (typeof counts[table] !== 'number' || !Number.isFinite(counts[table])) {
            errors.push(`pg/${label}.json missing numeric ${table}`)
          }
        }
      }
    } catch (error) {
      errors.push(`pg counts unreadable: ${String(error)}`)
    }
  }

  // SSE：raw frames 或 BLOCKED.json 二选一；二者都不存在 = 不完整。
  const hasSse = existsSync(paths.sseFrames)
  const hasBlocked = existsSync(paths.sseBlocked)
  if (!hasSse && !hasBlocked) errors.push('sse: neither agent-turn-frames.jsonl nor BLOCKED.json present')
  let frames = []
  if (hasSse) {
    try {
      frames = readFileSync(paths.sseFrames, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() !== '')
        .map((line, index) => {
          const frame = JSON.parse(line)
          if (!frame || typeof frame.event !== 'string') throw new Error(`line ${index + 1}: missing event`)
          return frame
        })
    } catch (error) {
      errors.push(`sse frames unreadable: ${String(error)}`)
    }
  }

  // 可选阶段真源（stages/p2-screening.json .. p5-decision.json）：存在时参与 sha256 校验并喂给对应真实适配器。
  const stageFiles = {
    p2: join(dir, 'stages', 'p2-screening.json'),
    p3: join(dir, 'stages', 'p3-handoff.json'),
    p4: join(dir, 'stages', 'p4-transcript.json'),
    p5: join(dir, 'stages', 'p5-decision.json'),
    p6Funnel: join(dir, 'stages', 'p6-funnel.json'),
    l3Inputs: join(dir, 'stages', 'l3-inputs.json'),
  }
  const stageData = {}
  if (!errors.length) {
    for (const [k, filePath] of Object.entries(stageFiles)) {
      if (!existsSync(filePath)) continue
      const relMap = { p2: 'p2-screening', p3: 'p3-handoff', p4: 'p4-transcript', p5: 'p5-decision', p6Funnel: 'p6-funnel', l3Inputs: 'l3-inputs' }
      const rel = `stages/${relMap[k]}.json`
      if (typeof manifest?.sha256?.[rel] !== 'string' || manifest.sha256[rel].length !== 64) {
        errors.push(`capture integrity mismatch: ${rel} missing sha256 entry in manifest`)
        continue
      }
      try {
        stageData[k] = readJson(filePath)
      } catch (err) {
        errors.push(`${rel} unreadable: ${String(err)}`)
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    dir,
    paths,
    manifest,
    doc,
    countsBefore,
    countsAfter,
    frames,
    hasSse,
    hasBlocked,
    blocked: hasBlocked ? readJson(paths.sseBlocked) : undefined,
    stageData,
  }
}

/** capture 中独立 psql 读回的 counts 只作对照，绝不作为适配器输入（不得回放）。 */
function countsEqual(a, b) {
  return ['application', 'interview', 'scorecard', 'decision', 'criterion_override']
    .every((table) => a?.[table] === b?.[table])
}

function buildRealArtifactProvider(capture, liveCounts, countCheck) {
  const callSites = []
  const adapterSources = {
    adaptConverterDocumentToP1Artifact: fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url)),
    adaptAgentTurnSseToP6Artifact: fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url)),
    readPgTableRowCounts: fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url)),
  }

  const p1CaseIds = ['P1-01']
  const p2CaseIds = capture.stageData?.p2 ? ['P2-01'] : []
  const p3CaseIds = capture.stageData?.p3 ? ['P3-01'] : []
  const p4CaseIds = capture.stageData?.p4 ? ['P4-06'] : []
  const p5CaseIds = capture.stageData?.p5 ? ['P5-01'] : []
  // P6 真源必须同时满足：真 Host SSE 帧 + readPgTableRowCounts 真库读回 + 与 capture 独立 psql 对照一致。
  const p6CaseIds = capture.hasSse && countCheck.matchesAfter ? ['P6-01', 'P6-05'] : []
  const p6FunnelCaseIds = []
  if (capture.stageData?.p6Funnel?.p608) p6FunnelCaseIds.push('P6-08')
  if (capture.stageData?.p6Funnel?.p609) p6FunnelCaseIds.push('P6-09')
  const realSourceCaseIds = [...p1CaseIds, ...p2CaseIds, ...p3CaseIds, ...p4CaseIds, ...p5CaseIds, ...p6CaseIds, ...p6FunnelCaseIds]
  const providerCache = new Map()

  function buildForCase(c) {
    if (p1CaseIds.includes(c.case_id)) {
      const art = adaptConverterDocumentToP1Artifact(capture.doc, {
        expectedPageCount: capture.doc.page_count,
      })
      callSites.push(`adaptConverterDocumentToP1Artifact(case=${c.case_id}): files=${adapterSources.adaptConverterDocumentToP1Artifact}`)
      return art
    }
    if (p2CaseIds.includes(c.case_id) && capture.stageData?.p2) {
      callSites.push(`adaptScreeningToP2Artifact(case=${c.case_id})`)
      return adaptScreeningToP2Artifact(capture.stageData.p2)
    }
    if (p3CaseIds.includes(c.case_id) && capture.stageData?.p3) {
      callSites.push(`adaptHandoffBriefToP3Artifact(case=${c.case_id})`)
      return adaptHandoffBriefToP3Artifact(capture.stageData.p3)
    }
    if (p4CaseIds.includes(c.case_id) && capture.stageData?.p4) {
      callSites.push(`adaptTranscriptDraftToP4Artifact(case=${c.case_id})`)
      return adaptTranscriptDraftToP4Artifact(capture.stageData.p4)
    }
    if (p5CaseIds.includes(c.case_id) && capture.stageData?.p5) {
      callSites.push(`adaptDecisionSummaryToP5Artifact(case=${c.case_id})`)
      return adaptDecisionSummaryToP5Artifact(capture.stageData.p5)
    }
    if (c.case_id === 'P6-08' && capture.stageData?.p6Funnel?.p608) {
      callSites.push(`adaptFunnelTrajectoryToP6Artifact(case=${c.case_id})`)
      return adaptFunnelTrajectoryToP6Artifact('P6-08', capture.stageData.p6Funnel.p608)
    }
    if (c.case_id === 'P6-09' && capture.stageData?.p6Funnel?.p609) {
      callSites.push(`adaptFunnelTrajectoryToP6Artifact(case=${c.case_id})`)
      return adaptFunnelTrajectoryToP6Artifact('P6-09', capture.stageData.p6Funnel.p609)
    }
    if (p6CaseIds.includes(c.case_id)) {
      // liveCounts 由 readPgTableRowCounts() 在真 PG17 只读事务中执行 SQL 得到，绝不回放 capture 数字。
      const art = adaptAgentTurnSseToP6Artifact({
        caseId: c.case_id,
        frames: capture.frames,
        countsBefore: liveCounts.before,
        countsAfter: liveCounts.after,
      })
      callSites.push(`adaptAgentTurnSseToP6Artifact(case=${c.case_id}): files=${adapterSources.adaptAgentTurnSseToP6Artifact}`)
      return art
    }
    return null // NO_REAL_SOURCE：禁止用静态/手填产物冒充
  }

  return {
    realSourceCaseIds,
    prepare: (selectedCases) => {
      for (const c of selectedCases) {
        if (realSourceCaseIds.includes(c.case_id)) providerCache.set(c.case_id, buildForCase(c))
      }
    },
    provide: (c) => providerCache.get(c.case_id) ?? null,
    callSites,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const runId = `eval-v2-${args.mode}-${args.gate.toLowerCase()}-${Date.now()}`
  let card
  let outcomes
  let coverage
  let realSources = []
  let callSites = []
  let liveResult

  if (args.mode === 'contract') {
    const result = runEvalGateSuite({ gate: args.gate, runId })
    card = result.card
    outcomes = result.outcomes
  } else if (args.mode === 'live') {
    // 真 Host + 真 PG17 只读行数；readCounts 由本 CLI 注入，runner 本身保持可离线测试。
    const hostOrigin = new URL(args.baseUrl).origin
    console.log(`[run-eval-v2] LIVE HOST ${hostOrigin} session=<redacted> pg=${args.pgHost}:${args.pgPort}/${args.pgDb} tenant=${args.pgTenant}`)
    liveResult = await runLiveEval(
      {
        gate: args.gate,
        runId,
        baseUrl: args.baseUrl,
        session: args.session,
        runs: args.runs,
      },
      { readCounts: () => readLivePgCounts(args) },
    )
    card = liveResult.card
    outcomes = liveResult.outcomes
    coverage = liveResult.coverage
    realSources = coverage.realSourceCaseIds
    callSites = [
      `runLiveEval: files=${fileURLToPath(new URL('./v2-live-runner.ts', import.meta.url))}`,
      `adaptAgentTurnSseToP6Artifact: files=${fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url))}:56-130`,
      `readPgTableRowCounts: files=${fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url))}:133-160 (real pg.Pool, read-only tx)`,
    ]
  } else {
    const capture = validateCapture(args.capture)
    if (!capture.ok) {
      console.error('[run-eval-v2] FATAL: capture bundle incomplete, refusing to fabricate real artifacts (fail-closed):')
      for (const error of capture.errors) console.error(`  - ${error}`)
      process.exit(2)
    }

    // 读取 manifest 以知道本 gate 选中哪些 case（与 runner 的选择逻辑一致）。
    const { loadEvalManifest, DEFAULT_MANIFEST_PATH } = await import('./v2-g0-runner.ts')
    const manifest = loadEvalManifest(DEFAULT_MANIFEST_PATH)
    const selected = args.gate === 'ALL'
      ? manifest.cases
      : manifest.cases.filter((c) => c.min_gate === args.gate)

    // 真连 PG17 执行 readPgTableRowCounts SQL（总控裁决：禁止回放 capture 数字冒充真接线）。
    let liveCounts
    let countCheck
    try {
      const before = await readLivePgCounts(args)
      const after = await readLivePgCounts(args)
      liveCounts = { before, after }
      countCheck = {
        matchesAfter: countsEqual(after, capture.countsAfter),
        liveAfter: after,
        captureAfter: {
          application: capture.countsAfter.application,
          interview: capture.countsAfter.interview,
          scorecard: capture.countsAfter.scorecard,
          decision: capture.countsAfter.decision,
          criterion_override: capture.countsAfter.criterion_override,
        },
      }
      console.log(`[run-eval-v2] readPgTableRowCounts LIVE PG ${args.pgHost}:${args.pgPort}/${args.pgDb} tenant=${args.pgTenant}`)
      console.log(`[run-eval-v2] liveCounts.before=${JSON.stringify(before)} capture.countsAfter=${JSON.stringify(countCheck.captureAfter)} liveCounts.after=${JSON.stringify(after)} matchAfter=${countCheck.matchesAfter}`)
    } catch (error) {
      console.error(`[run-eval-v2] FATAL: real PG read failed (no replay allowed): ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }

    const provider = buildRealArtifactProvider(capture, liveCounts, countCheck)
    provider.prepare(selected)
    callSites = provider.callSites
    // 真调用点证明：readPgTableRowCounts 在 main 的 real PG 路径被调用两次。
    callSites.push(`readPgTableRowCounts(case=LIVE-PG): files=${fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url))}:133-160 (real pg.Pool, read-only tx)`)
    realSources = provider.realSourceCaseIds.filter((id) => selected.some((c) => c.case_id === id))
    const noRealSources = selected.map((c) => c.case_id).filter((id) => !realSources.includes(id))

    coverage = {
      executionMode: 'real_adapter',
      realSourceCaseIds: realSources,
      noRealSourceCaseIds: noRealSources,
      note: capture.hasBlocked && !capture.hasSse
        ? `SSE 未采集（BLOCKED: ${String(capture.blocked?.reason ?? 'unknown')}）；P6 无真实 SSE 源，标 NO_REAL_SOURCE，不伪造 SSE 帧`
        : !countCheck.matchesAfter
          ? `PG 真跑 counts 与 capture 独立 psql 读回不一致（live=${JSON.stringify(countCheck.liveAfter)} / capture=${JSON.stringify(countCheck.captureAfter)}）；P6 标 NO_REAL_SOURCE，不计 PASS`
          : '真实源来自 capture bundle（converter DocumentContent / Host SSE frames）+ readPgTableRowCounts 真库 PG17 SQL（capture psql 仅作独立对照）',
    }

    const result = runEvalGateSuite({
      gate: args.gate,
      runId,
      artifactProvider: provider.provide,
      coverage,
    })
    card = result.card
    outcomes = result.outcomes
  }

  mkdirSync(resolve(args.out), { recursive: true })
  const jsonPath = join(resolve(args.out), 'evaluation-card.json')
  const mdPath = join(resolve(args.out), 'evaluation-card.md')
  writeFileSync(jsonPath, `${JSON.stringify(card, null, 2)}\n`, 'utf8')
  writeFileSync(mdPath, `${liveResult?.cardMarkdown ?? formatEvaluationCardMarkdown(card)}\n`, 'utf8')
  if (args.mode === 'live' && liveResult) {
    writeFileSync(
      join(resolve(args.out), 'live-report.json'),
      `${JSON.stringify(liveResult.liveReport, null, 2)}\n`,
      'utf8',
    )
  }

  if (args.runs > 1) {
    // live 的每次运行都是真 POST，pass^k 必须来自真实重复计数，禁止复用同一张 card 冒充。
    let maps
    if (liveResult) {
      maps = liveResult.passMaps
    } else {
      maps = [card.casePassMap]
      for (let r = 1; r < args.runs; r += 1) {
        const extra = args.mode === 'contract'
          ? runEvalGateSuite({ gate: args.gate, runId: `${runId}-r${r + 1}` })
          : { card }
        maps.push(extra.card.casePassMap)
      }
    }
    const passK = computePassPowerK(maps)
    writeFileSync(join(resolve(args.out), 'pass-power-k.json'), `${JSON.stringify(passK, null, 2)}\n`, 'utf8')
    console.log(`[run-eval-v2] pass^${passK.k}=${passK.passPowerKRate} stable=${passK.stablePassed}/${passK.totalCases} flaky=${passK.flakyCaseIds.length}`)
  }

  if (args.checkData) {
    const corpus = scanPrivateCorpusInventory()
    const benchmarks = Object.fromEntries(
      Object.keys(BENCHMARK_REGISTRY).map((id) => [id, loadCachedBenchmark(id)]),
    )
    writeFileSync(
      join(resolve(args.out), 'data-readiness.json'),
      `${JSON.stringify({ corpus, benchmarks }, null, 2)}\n`,
      'utf8',
    )
    console.log(`[run-eval-v2] data-readiness: corpus=${corpus.status} benchmarks=${Object.keys(benchmarks).length}`)
  }

  if (args.l3) {
    // 探针由 prompt registry 驱动：每个已注册 L3 grader 一条，不再硬编码单一 graderId。
    const prompts = listL3JudgePrompts()
    const invokerConfig = readL3InvokerConfig()
    const invoker = invokerConfig.configured && invokerConfig.config
      ? createL3Invoker(invokerConfig.config)
      : null
    const results = []
    for (const prompt of prompts) {
      const fixture = L3_PROBE_FIXTURES[prompt.graderId] ?? L3_PROBE_FALLBACK
      const item = {
        graderId: prompt.graderId,
        judgeVersion: prompt.judgeVersion,
        calibrationStatus: 'OBSERVATION_ONLY',
        criterionPrompt: prompt.criterionPrompt,
        sourceMaterial: fixture.sourceMaterial,
        candidateOutput: fixture.candidateOutput,
      }
      let result
      try {
        // 未配置 invoker 时保持既有 fail-closed 行为：runL3AtomicJudge 返回 L3_MODEL_NOT_CONFIGURED。
        result = invoker ? await runL3AtomicJudge(item, { invoker }) : await runL3AtomicJudge(item)
      } catch (error) {
        result = { status: 'L3_INVOKER_ERROR', reason: error instanceof Error ? error.message : String(error) }
      }
      results.push({ graderId: prompt.graderId, promptVersion: prompt.promptVersion, result })
    }
    const executed = results.filter((r) => r.result.status === 'OK').length
    const l3Report = {
      // 未配置时断言契约：status=L3_MODEL_NOT_CONFIGURED 且 executed=0（CI 依赖）。
      status: invoker ? 'EXECUTED' : 'L3_MODEL_NOT_CONFIGURED',
      modelConfig: readL3RuntimeModelConfig(),
      invokerConfigured: invoker !== null,
      promptRegistryVersion: L3_JUDGE_PROMPT_REGISTRY_VERSION,
      probes: results.length,
      executed,
      results,
    }
    writeFileSync(join(resolve(args.out), 'l3-report.json'), `${JSON.stringify(l3Report, null, 2)}\n`, 'utf8')
    console.log(
      `[run-eval-v2] l3: status=${l3Report.status} executed=${executed}/${results.length} `
        + `promptRegistryVersion=${L3_JUDGE_PROMPT_REGISTRY_VERSION}`,
    )
  }

  const passRate = card.passRate
  const selectedTotal = card.coverage?.totalCases ?? card.totalCases
  console.log(`[run-eval-v2] mode=${args.mode} gate=${args.gate} total=${selectedTotal} executed=${card.totalCases} realSources=${realSources.length} passRate=${passRate === undefined || passRate === null ? 'null' : String(passRate)}`)
  if (args.mode === 'real') {
    // 适配器调用点（可复跑 file:line 证据）。
    const src = fileURLToPath(new URL('./v2-real-adapters.ts', import.meta.url))
    console.log(`adaptConverterDocumentToP1Artifact: files=${src}:18-45`)
    console.log(`adaptAgentTurnSseToP6Artifact: files=${src}:56-130`)
    console.log(`readPgTableRowCounts: files=${src}:133-160`)
    for (const line of callSites) console.log(`[run-eval-v2] adapterCall ${line}`)
    console.log(`[run-eval-v2] coverage: real=${realSources.length} noRealSource=${coverage?.noRealSourceCaseIds?.length ?? 0}`)
  }
  if (args.mode === 'live' && liveResult) {
    const s = liveResult.liveReport.summary
    console.log(`[run-eval-v2] live: covered=${s.liveCoveredCases}/${s.selectedCases} attempts=${s.executedAttempts} pass=${s.passedCases} fail=${s.failedCases} error=${s.errorCases} noLiveSource=${s.noLiveSourceCases} ttftP95=${s.ttftMsP95 ?? 'n/a'}ms`)
    for (const line of callSites) console.log(`[run-eval-v2] adapterCall ${line}`)
  }
  console.log(`[run-eval-v2] cards: ${jsonPath} / ${mdPath}${args.mode === 'live' ? ` / ${join(resolve(args.out), 'live-report.json')}` : ''}`)

  if (args.mode === 'real') {
    const executed = outcomes.filter((o) => realSources.includes(o.caseId))
    if (executed.length > 0 && executed.every((o) => !o.passed)) {
      process.exitCode = 3
    }
  }
  if (args.mode === 'live') {
    // 零静默：ERROR/FAIL 或零执行一律非 0，避免把没跑通当绿门。
    if (outcomes.length === 0 || outcomes.some((o) => !o.passed)) process.exitCode = 3
  }
}

main().catch((error) => {
  console.error(`[run-eval-v2] runner failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
