// Eval V2 Phase 3 — live 模型模式 MVP（严格限制在 test/eval/，不碰产品代码/CI）。
//
// 纪律（docs/45 §3 Phase 3 + 本文 run-eval-v2.mjs 的 real 模式先例）：
//  - 只跑显式声明的 LIVE_CASES；manifest 中未覆盖的 case 标 NO_LIVE_SOURCE，绝不伪造。
//  - 每个 case 真 POST ${baseUrl}/recruitment/agent/turn，解析 delta/tool/ui_action/error/done。
//  - 前后用注入的 readCounts（生产由 CLI 的真 PG17 只读事务提供）取行数，喂既有适配器与 P6 判分器。
//  - Host 不可达 / HTTP 非 2xx / SSE error / DB 读失败 → 该 case 显式 ERROR（passed=false），零静默。
//  - TTFT 取首条非空 delta 的客户端到达时间；token usage 仅从 done 帧提取；口令/会话不落盘。
import {
  buildEvaluationCard,
  formatEvaluationCardMarkdown,
  type EvaluationCard,
  type RealCoverage,
} from './evaluation-card.ts'
import {
  DEFAULT_MANIFEST_PATH,
  createV2FullRegistry,
  loadEvalManifest,
  type EvalManifestFile,
  type ManifestCaseRecord,
} from './v2-g0-runner.ts'
import {
  adaptAgentTurnSseToP6Artifact,
  computePassPowerK,
  type AgentTurnSseFrame,
} from './v2-real-adapters.ts'
import { LIVE_CASES, type LiveCase } from './v2-live-cases.ts'
import type { CaseRunOutcome, EvalPointArtifact, EvalPointId, GradeResult, PersonLifecycleCase } from './v2-types.ts'
import type { RowCounts } from './types.ts'

export class LiveEvalError extends Error {
  readonly code: string
  /** HTTP 失败时保留状态码，供 live-report 归因（不含响应文本以外的凭据）。 */
  readonly httpStatus?: number

  constructor(code: string, message: string, httpStatus?: number) {
    super(message)
    this.name = 'LiveEvalError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export interface LiveEvalConfig {
  /** 真 Host 根地址，例如 http://127.0.0.1:49349（CLI 必填，函数层也 fail-closed）。 */
  readonly baseUrl: string
  /** x-dsh-session 头值（不写入任何产物）。 */
  readonly session: string
  readonly gate?: 'G0' | 'G1' | 'G2' | 'ALL'
  readonly runId?: string
  /** 独立重复运行次数；>1 时产出真实 pass^k 的可重复计数。 */
  readonly runs?: number
  /** 默认 LIVE_CASES；测试可注入自定义用例。 */
  readonly cases?: readonly LiveCase[]
  readonly manifestPath?: string
  /** 单次 agent/turn 超时，默认 120000ms。 */
  readonly timeoutMs?: number
}

export interface LiveEvalDeps {
  /** 真 PG 只读行数读取；生产由 CLI 注入 pg.Pool 实现，测试注入假实现（不连真库）。 */
  readonly readCounts: () => Promise<RowCounts>
  /** 默认 globalThis.fetch；保留注入位以便极端环境适配，mock server 用真实 fetch 即可。 */
  readonly fetchImpl?: typeof fetch
}

export type LiveEvaluationCard = Omit<EvaluationCard, 'executionMode'> & {
  readonly executionMode: 'live_host'
}

export interface LiveAttemptReport {
  readonly run: number
  readonly status: 'PASS' | 'FAIL' | 'ERROR'
  readonly ttftMs: number | null
  readonly durationMs: number
  readonly tokenUsage: Readonly<Record<string, number>> | null
  readonly httpStatus: number | null
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly grades: readonly GradeResult[]
  readonly rowsWritten: number | null
  readonly countsBefore: RowCounts | null
  readonly countsAfter: RowCounts | null
}

export interface LiveCaseReport {
  readonly caseId: string
  readonly evalPoint: EvalPointId
  readonly source: 'LIVE_HOST_SSE' | 'NO_LIVE_SOURCE'
  readonly status: 'PASS' | 'FAIL' | 'ERROR'
  readonly text: string
  readonly attempts: readonly LiveAttemptReport[]
}

export interface LiveReport {
  readonly schemaVersion: '1.0'
  readonly mode: 'live_host'
  readonly generatedAt: string
  /** 只保留 origin，避免把带查询串的 URL / session 写进文件。 */
  readonly baseUrlOrigin: string
  readonly gate: string
  readonly runs: number
  readonly cases: readonly LiveCaseReport[]
  /** 本 gate 选中但根本没有 live 用例定义的 case（明确 NO_LIVE_SOURCE）。 */
  readonly noLiveSourceCaseIds: readonly string[]
  readonly summary: {
    readonly selectedCases: number
    readonly liveCoveredCases: number
    readonly executedAttempts: number
    readonly passedCases: number
    readonly failedCases: number
    readonly errorCases: number
    readonly noLiveSourceCases: number
    readonly passRate: number | null
    readonly passPowerK: ReturnType<typeof computePassPowerK> | null
    readonly ttftMsP95: number | null
    readonly tokenUsageSamples: readonly (Readonly<Record<string, number>> | null)[]
  }
}

export interface LiveEvalResult {
  readonly card: LiveEvaluationCard
  readonly cardMarkdown: string
  readonly outcomes: readonly CaseRunOutcome[]
  readonly coverage: RealCoverage
  readonly passMaps: readonly Readonly<Record<string, boolean>>[]
  readonly liveReport: LiveReport
}

const UI_ACTIONS = ['navigate', 'focus_section', 'suggest_action', 'propose_write'] as const
type UiActionName = (typeof UI_ACTIONS)[number]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
  return sorted[index]
}

/** 只从 done 帧取数字型 token 计数；不记录文本、会话或凭据。 */
function extractTokenUsage(data: Record<string, unknown>): Record<string, number> | null {
  for (const candidate of [data.usage, data.token_usage, data.tokens]) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const usage: Record<string, number> = {}
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value
    }
    if (Object.keys(usage).length > 0) return usage
  }
  return null
}

interface ParsedFrame {
  readonly event: string
  readonly data: Record<string, unknown>
}

/** 解析单个 SSE 块（支持 event:/data: 与 data 内嵌 event 字段、心跳注释行）。 */
function parseSseFrame(block: string): ParsedFrame | null {
  let eventName = 'message'
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith(':')) continue
    if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim())
  }
  if (dataLines.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const data = parsed as Record<string, unknown>
  const embedded = typeof data.event === 'string' ? data.event : undefined
  return { event: eventName === 'message' && embedded ? embedded : eventName, data }
}

interface StreamedTurn {
  readonly frames: AgentTurnSseFrame[]
  readonly startTsMs: number
  readonly ttftMs: number | null
  readonly durationMs: number
  readonly tokenUsage: Record<string, number> | null
  readonly httpStatus: number
}

/** 真 POST agent/turn 并流式解析 SSE；首条非空 delta 打客户端时间戳（喂既有适配器算 TTFT）。 */
async function callAgentTurn(input: {
  readonly baseUrl: string
  readonly session: string
  readonly text: string
  readonly context: Readonly<Record<string, unknown>>
  readonly timeoutMs: number
  readonly fetchImpl: typeof fetch
}): Promise<StreamedTurn> {
  const started = performance.now()
  const startTsMs = Date.now()
  const url = `${input.baseUrl.replace(/\/+$/, '')}/recruitment/agent/turn`

  let response: Response
  try {
    response = await input.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-session': input.session,
        'x-recruitment-request': '1',
      },
      body: JSON.stringify({ text: input.text, context: input.context }),
      signal: AbortSignal.timeout(input.timeoutMs),
    })
  } catch (error) {
    throw new LiveEvalError('LIVE_HOST_UNREACHABLE', `agent/turn 请求失败：${asMessage(error)}`)
  }
  if (!response.ok) {
    let snippet = ''
    try { snippet = (await response.text()).slice(0, 300) } catch { /* 响应体不可读时只报状态码 */ }
    throw new LiveEvalError('LIVE_HOST_HTTP_ERROR', `agent/turn HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`, response.status)
  }
  if (!response.body) {
    throw new LiveEvalError('LIVE_SSE_EMPTY', 'agent/turn 响应无 SSE body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames: AgentTurnSseFrame[] = []
  let buffer = ''
  let firstDeltaTsMs: number | undefined
  let ttftMs: number | null = null
  let tokenUsage: Record<string, number> | null = null
  let sseErrorCode: string | undefined
  let sseErrorMessage: string | undefined
  let sawDone = false

  const consume = (block: string): void => {
    const parsed = parseSseFrame(block)
    if (!parsed) return
    const { event, data } = parsed
    if (event === 'delta') {
      const piece = typeof data.text === 'string' ? data.text : ''
      const annotate = piece !== '' && firstDeltaTsMs === undefined
      if (annotate) {
        firstDeltaTsMs = Date.now()
        ttftMs = Math.max(0, Number((performance.now() - started).toFixed(1)))
      }
      frames.push({
        event: 'delta',
        data: { text: piece },
        ...(annotate && firstDeltaTsMs !== undefined ? { tsMs: firstDeltaTsMs } : {}),
      })
    } else if (event === 'tool') {
      const status = data.status === 'ok' || data.status === 'error' ? data.status : 'start'
      frames.push({
        event: 'tool',
        data: {
          name: typeof data.name === 'string' ? data.name : 'unknown_tool',
          status,
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(typeof data.result === 'string' ? { result: data.result } : {}),
        },
      })
    } else if (event === 'ui_action') {
      const action = data.action
      if (typeof action !== 'string' || !UI_ACTIONS.includes(action as UiActionName)) return
      frames.push({ event: 'ui_action', data: { ...data, action: action as UiActionName } })
    } else if (event === 'error') {
      sseErrorCode = typeof data.code === 'string' ? data.code : 'AGENT_ERROR'
      sseErrorMessage = typeof data.message === 'string' ? data.message : 'agent/turn SSE error'
      frames.push({
        event: 'error',
        data: { ...(sseErrorCode ? { code: sseErrorCode } : {}), ...(sseErrorMessage ? { message: sseErrorMessage } : {}) },
      })
    } else if (event === 'done') {
      sawDone = true
      tokenUsage = extractTokenUsage(data)
      frames.push({ event: 'done', data, tsMs: Date.now() })
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) consume(block)
    }
    buffer += decoder.decode()
    if (buffer.trim() !== '') consume(buffer)
  } finally {
    reader.releaseLock()
  }

  if (sseErrorCode) {
    throw new LiveEvalError('LIVE_SSE_ERROR', `agent/turn SSE error(${sseErrorCode}): ${sseErrorMessage ?? ''}`)
  }
  if (frames.length === 0 || !sawDone) {
    throw new LiveEvalError('LIVE_SSE_NO_DONE', 'agent/turn SSE 未收到 done 帧，拒绝把半截流当成功')
  }
  if (!frames.some((f) => f.event === 'delta' && typeof f.data.text === 'string' && f.data.text.trim() !== '')) {
    throw new LiveEvalError('LIVE_SSE_NO_CONTENT', 'agent/turn 未给出任何非空 delta，拒绝把空回答当成功')
  }

  return {
    frames,
    startTsMs,
    ttftMs,
    durationMs: Math.max(0, Number((performance.now() - started).toFixed(1))),
    tokenUsage,
    httpStatus: response.status,
  }
}

async function safeReadCounts(readCounts: () => Promise<RowCounts>, phase: string): Promise<RowCounts> {
  let counts: RowCounts
  try {
    counts = await readCounts()
  } catch (error) {
    throw new LiveEvalError(`LIVE_PG_READ_ERROR_${phase}`, `PG 行数读回失败（${phase}）：${asMessage(error)}`)
  }
  if (!counts || typeof counts !== 'object') {
    throw new LiveEvalError(`LIVE_PG_READ_ERROR_${phase}`, `PG 行数读回返回非法值（${phase}）`)
  }
  return counts
}

function errorOutcome(
  mc: ManifestCaseRecord,
  code: string,
  message: string,
  durationMs: number,
): CaseRunOutcome {
  return {
    caseId: mc.case_id,
    evalPoint: mc.eval_point,
    suitePool: mc.suite_pool,
    minGate: mc.min_gate,
    dataTier: mc.data_tier,
    granularity: mc.eval_granularity,
    failureCostWeight: mc.failure_cost_weight,
    passed: false,
    grades: [{ ok: false, code, message }],
    firstFailureCode: code,
    firstFailureMessage: message,
    durationMs,
  }
}

interface AttemptResult {
  readonly outcome: CaseRunOutcome
  readonly report: LiveAttemptReport
}

async function runOneAttempt(input: {
  readonly config: LiveEvalConfig
  readonly deps: LiveEvalDeps
  readonly liveCase: LiveCase
  readonly manifestCase: ManifestCaseRecord
  readonly registry: ReturnType<typeof createV2FullRegistry>
  readonly run: number
}): Promise<AttemptResult> {
  const { config, deps, liveCase, manifestCase, registry, run } = input
  const started = performance.now()
  let artifact: EvalPointArtifact | null = null
  let countsBefore: RowCounts | null = null
  let countsAfter: RowCounts | null = null
  let ttftMs: number | null = null
  let tokenUsage: Record<string, number> | null = null
  let httpStatus: number | null = null
  let rowsWritten: number | null = null
  let errorCode: string | undefined
  let errorMessage: string | undefined

  try {
    countsBefore = await safeReadCounts(deps.readCounts, 'BEFORE')
    const turn = await callAgentTurn({
      baseUrl: config.baseUrl,
      session: config.session,
      text: liveCase.text,
      context: liveCase.context,
      timeoutMs: config.timeoutMs ?? 120_000,
      fetchImpl: deps.fetchImpl ?? globalThis.fetch,
    })
    httpStatus = turn.httpStatus
    ttftMs = turn.ttftMs
    tokenUsage = turn.tokenUsage
    countsAfter = await safeReadCounts(deps.readCounts, 'AFTER')

    artifact = adaptAgentTurnSseToP6Artifact({
      caseId: liveCase.case_id,
      startTsMs: turn.startTsMs,
      frames: turn.frames,
      countsBefore,
      countsAfter,
      ...(liveCase.expected_write_intent ? { expectedWriteIntent: liveCase.expected_write_intent } : {}),
    })
    // 适配器按帧 tsMs 计算 TTFT；若 Host 帧自带时间戳导致差值缺失，用客户端实测值兜底。
    if (artifact.ttftMs === undefined && ttftMs !== null) {
      artifact = { ...artifact, ttftMs, payload: { ...artifact.payload, ttftMs } }
    }
    rowsWritten = typeof artifact.payload.rowsWritten === 'number' ? artifact.payload.rowsWritten : null
  } catch (error) {
    errorCode = error instanceof LiveEvalError ? error.code : 'LIVE_UNEXPECTED_ERROR'
    errorMessage = asMessage(error)
    if (error instanceof LiveEvalError && error.httpStatus !== undefined) httpStatus = error.httpStatus
  }

  const durationMs = Math.max(0, Number((performance.now() - started).toFixed(1)))
  if (artifact === null) {
    const code = errorCode ?? 'LIVE_UNEXPECTED_ERROR'
    const message = errorMessage ?? '未知 live 执行错误'
    return {
      outcome: errorOutcome(manifestCase, code, message, durationMs),
      report: {
        run,
        status: 'ERROR',
        ttftMs,
        durationMs,
        tokenUsage,
        httpStatus,
        errorCode: code,
        errorMessage: message,
        grades: [{ ok: false, code, message }],
        rowsWritten: null,
        countsBefore,
        countsAfter,
      },
    }
  }

  const lifecycleCase: PersonLifecycleCase = {
    caseId: manifestCase.case_id,
    candidateKey: `live-${manifestCase.case_id.toLowerCase()}`,
    evalPoint: manifestCase.eval_point,
    suitePool: manifestCase.suite_pool,
    minGate: manifestCase.min_gate,
    dataTier: manifestCase.data_tier,
    sourceRef: manifestCase.source_ref,
    granularity: manifestCase.eval_granularity,
    failureCostWeight: manifestCase.failure_cost_weight,
    graderIds: manifestCase.graders,
    artifacts: [artifact],
    description: manifestCase.description,
  }
  const outcome = registry.evaluateCase(lifecycleCase)
  return {
    outcome,
    report: {
      run,
      status: outcome.passed ? 'PASS' : 'FAIL',
      ttftMs: artifact.ttftMs ?? ttftMs,
      durationMs,
      tokenUsage,
      httpStatus,
      grades: outcome.grades,
      rowsWritten,
      countsBefore,
      countsAfter,
    },
  }
}

/**
 * 执行 live 评测。deps.readCounts 必填（生产为 CLI 的真 PG17 只读事务，测试为假实现）。
 * 不连接真库、不写凭据；缺 host/session/counts reader 直接抛错（fail-closed）。
 */
export async function runLiveEval(
  config: LiveEvalConfig,
  deps: LiveEvalDeps,
): Promise<LiveEvalResult> {
  if (!isNonEmptyString(config.baseUrl)) {
    throw new LiveEvalError('LIVE_CONFIG_MISSING_BASE_URL', '--base-url 缺失或为空；live 模式绝不回退 contract')
  }
  if (!isNonEmptyString(config.session)) {
    throw new LiveEvalError('LIVE_CONFIG_MISSING_SESSION', '--session 缺失或为空；live 模式绝不回退 contract')
  }
  if (!deps || typeof deps.readCounts !== 'function') {
    throw new LiveEvalError('LIVE_CONFIG_MISSING_COUNTS_READER', 'readCounts 未注入；live 模式必须有真 PG 行数读回（fail-closed）')
  }
  const runs = Number.isInteger(config.runs) && (config.runs ?? 0) >= 1 ? config.runs! : 1
  const gate = config.gate ?? 'ALL'
  const liveCases = config.cases ?? LIVE_CASES
  const manifest: EvalManifestFile = loadEvalManifest(config.manifestPath ?? DEFAULT_MANIFEST_PATH)
  const selected = gate === 'ALL' ? manifest.cases : manifest.cases.filter((c) => c.min_gate === gate)
  const selectedIds = new Set(selected.map((c) => c.case_id))
  const activeCases = liveCases.filter((c) => selectedIds.has(c.case_id))
  const noLiveSourceCaseIds = [...selectedIds]
    .filter((id) => !activeCases.some((c) => c.case_id === id))
    .sort()

  const registry = createV2FullRegistry()
  for (const liveCase of activeCases) {
    const mc = selected.find((c) => c.case_id === liveCase.case_id)!
    const validation = registry.validateManifestGraders(mc.graders)
    if (!validation.ok) {
      throw new LiveEvalError('LIVE_GRADER_MISSING', `case ${liveCase.case_id} 缺判分器：${validation.missing.join(', ')}`)
    }
  }

  const passMaps: Record<string, boolean>[] = []
  const attemptsByCase = new Map<string, LiveAttemptReport[]>()
  let firstOutcomes: CaseRunOutcome[] = []

  for (let run = 1; run <= runs; run += 1) {
    const outcomes: CaseRunOutcome[] = []
    for (const liveCase of activeCases) {
      const mc = selected.find((c) => c.case_id === liveCase.case_id)!
      const { outcome, report } = await runOneAttempt({
        config,
        deps,
        liveCase,
        manifestCase: mc,
        registry,
        run,
      })
      outcomes.push(outcome)
      const prior = attemptsByCase.get(liveCase.case_id) ?? []
      prior.push(report)
      attemptsByCase.set(liveCase.case_id, prior)
    }
    passMaps.push(Object.fromEntries(outcomes.map((o) => [o.caseId, o.passed])))
    if (run === 1) firstOutcomes = outcomes
  }

  const successfulCaseIds = new Set<string>()
  const cases: LiveCaseReport[] = activeCases.map((liveCase) => {
    const attempts = attemptsByCase.get(liveCase.case_id) ?? []
    const statuses = attempts.map((a) => a.status)
    if (statuses.some((s) => s === 'PASS')) successfulCaseIds.add(liveCase.case_id)
    const status = statuses.includes('ERROR')
      ? 'ERROR'
      : statuses.length > 0 && statuses.every((s) => s === 'PASS')
        ? 'PASS'
        : 'FAIL'
    return {
      caseId: liveCase.case_id,
      evalPoint: liveCase.eval_point,
      source: 'LIVE_HOST_SSE',
      status,
      text: liveCase.text,
      attempts,
    }
  })

  const noSourceAfterAttempt = activeCases
    .map((c) => c.case_id)
    .filter((id) => !successfulCaseIds.has(id))
  const coverage: RealCoverage = {
    totalCases: selected.length,
    executedCases: firstOutcomes.length,
    realSourceCaseIds: activeCases.map((c) => c.case_id).filter((id) => successfulCaseIds.has(id)).sort(),
    noRealSourceCaseIds: [...new Set([...noLiveSourceCaseIds, ...noSourceAfterAttempt])].sort(),
    note: `live_host 模式：仅 ${activeCases.length}/${selected.length} 个 case 真 POST agent/turn；未定义 live 用例的 case 标 NO_LIVE_SOURCE，Host/SSE/DB 失败显式 ERROR，均不伪造产物`,
  }

  const allAttempts = cases.flatMap((c) => c.attempts)
  const ttftValues = allAttempts
    .map((a) => a.ttftMs)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const ttftMsP95 = percentile(ttftValues, 0.95)

  const baseCard = buildEvaluationCard({
    runId: config.runId ?? `eval-v2-live-${Date.now()}`,
    executionMode: 'real_adapter',
    outcomes: firstOutcomes,
    coverage,
    // live 模式的反向压制指标必须真进卡片：TTFT 超 3s 时 counterMetricsOk=false，
    // 不允许出现“P6-05 TTFT_EXCEEDED 但 Card Counter-Metrics: PASS”的自相矛盾。
    ...(ttftMsP95 === null ? {} : { counterMetrics: { ttftMsP95 } }),
  })
  const card: LiveEvaluationCard = { ...baseCard, executionMode: 'live_host' }
  const cardMarkdown = formatEvaluationCardMarkdown(baseCard).replace('Mode: real_adapter', 'Mode: live_host')

  let baseUrlOrigin = 'invalid'
  try {
    baseUrlOrigin = new URL(config.baseUrl).origin
  } catch { /* fail-closed 已在上方校验；这里只防产物写入非法值 */ }

  const liveReport: LiveReport = {
    schemaVersion: '1.0',
    mode: 'live_host',
    generatedAt: new Date().toISOString(),
    baseUrlOrigin,
    gate,
    runs,
    cases,
    noLiveSourceCaseIds,
    summary: {
      selectedCases: selected.length,
      liveCoveredCases: activeCases.length,
      executedAttempts: allAttempts.length,
      passedCases: cases.filter((c) => c.status === 'PASS').length,
      failedCases: cases.filter((c) => c.status === 'FAIL').length,
      errorCases: cases.filter((c) => c.status === 'ERROR').length,
      noLiveSourceCases: noLiveSourceCaseIds.length,
      passRate: baseCard.passRate ?? null,
      passPowerK: runs > 1 ? computePassPowerK(passMaps) : null,
      ttftMsP95: percentile(ttftValues, 0.95),
      tokenUsageSamples: allAttempts.map((a) => a.tokenUsage),
    },
  }

  return { card, cardMarkdown, outcomes: firstOutcomes, coverage, passMaps, liveReport }
}
