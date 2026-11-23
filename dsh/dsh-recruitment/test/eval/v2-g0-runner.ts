// Eval V2 — 全档位（G0 / G1 / G2 / ALL）评测执行器与 66 个判分器（37 L1 + 22 L2 + 7 L3）注册入口。
// 诚实区分 contract_smoke（无真实适配器，仅检契约）与 real_adapter（由外部传入真实产物采集器）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEvaluationCard, type EvaluationCard, type RealCoverage } from './evaluation-card.ts'
import { GraderRegistry } from './grader-registry.ts'
import { registerV2L1Graders } from './v2-graders-l1.ts'
import { registerV2L2Graders } from './v2-graders-l2.ts'
import { registerV2L3Graders } from './v2-graders-l3.ts'
import type {
  CaseRunOutcome,
  CounterMetricsObserved,
  DataTier,
  EvalGranularity,
  EvalPointArtifact,
  EvalPointId,
  FailureCostWeight,
  MinGate,
  PersonLifecycleCase,
  SuitePool,
} from './v2-types.ts'

export interface ManifestCaseRecord {
  readonly case_id: string
  readonly eval_point: EvalPointId
  readonly suite_pool: SuitePool
  readonly min_gate: MinGate
  readonly data_tier: DataTier
  readonly source_ref: string
  readonly eval_granularity: EvalGranularity
  readonly failure_cost_weight: FailureCostWeight
  readonly graders: readonly string[]
  readonly description: string
}

export interface EvalManifestFile {
  readonly schema_version: string
  readonly total_cases: number
  readonly cases: readonly ManifestCaseRecord[]
}

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_MANIFEST_PATH = join(HERE, 'corpus-manifest.json')

export function loadEvalManifest(manifestPath = DEFAULT_MANIFEST_PATH): EvalManifestFile {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as EvalManifestFile
}

export function createV2FullRegistry(): GraderRegistry {
  const registry = new GraderRegistry()
  registerV2L1Graders(registry)
  registerV2L2Graders(registry)
  registerV2L3Graders(registry)
  return registry
}

/** 兼容旧导出名（包含全部 L1 + L2 + L3 注册）。 */
export function createV2DeterministicRegistry(): GraderRegistry {
  return createV2FullRegistry()
}

/** 仅用于 G0 契约冒烟的最小夹具（显式标 executionMode='contract_smoke'，不冒充真实生产全链路）。 */
export function buildDefaultG0Artifact(c: ManifestCaseRecord): EvalPointArtifact {
  switch (c.case_id) {
    case 'P1-01':
      return { evalPoint: c.eval_point, stageLabel: 'S6', payload: { readOrderEdit: 0.02, streamOrderIssue: false, entityF1: 0.94, employerMisattributions: 0 } }
    case 'P1-02':
      return { evalPoint: c.eval_point, stageLabel: 'S6', payload: { tableTeds: 0.92, entityF1: 0.91, employerMisattributions: 0 } }
    case 'P1-03':
      return { evalPoint: c.eval_point, stageLabel: 'S6', answerText: '第 2 页为扫描图片，这一条没读到，已按已读到的信息继续。', payload: { needsVisual: true, completeness: 'partial', fabricatedText: false } }
    case 'P1-04':
      return { evalPoint: c.eval_point, stageLabel: 'S6', payload: { textEdit: 0.01, pageCount: 2, expectedPageCount: 2 } }
    case 'P1-05':
      return { evalPoint: c.eval_point, stageLabel: 'S6', latencyMs: 1200, payload: { extractedText: '繁體與簡體中文均正常抽取' } }
    case 'P2-05':
      return { evalPoint: c.eval_point, stageLabel: 'S7', payload: { weights: [0.4, 0.35, 0.25], hasMustHave: true, hasDealBreaker: true } }
    case 'P4-05':
      return { evalPoint: c.eval_point, stageLabel: 'S9', payload: { draftCountedInSummary: false, recordStatus: 'NEEDS_REVIEW', verificationStatus: 'UNVERIFIED' } }
    case 'P4-06':
      return { evalPoint: c.eval_point, stageLabel: 'S9', answerText: '这场还没收到转写，不影响继续下一步。', payload: { sourceKind: 'MANUAL', connectionState: 'NOT_CONNECTED', readbackHashMismatch: true, outcome: 'BLOCKED', rowsWritten: 0 } }
    case 'P5-04':
      return { evalPoint: c.eval_point, stageLabel: 'S10', payload: { missingScorecardFlagged: true, missingTreatedAsZero: false } }
    case 'P5-06':
      return { evalPoint: c.eval_point, stageLabel: 'S10', payload: { clientSentServerDerivedField: true, errorCode: 'SERVER_DERIVED_REJECTED', rowsWritten: 0 } }
    case 'P6-01':
      return {
        evalPoint: c.eval_point,
        stageLabel: 'CHAT',
        answerText: '淘汰需要你在界面确认，我不会直接操作。',
        payload: { rowsWritten: 0 },
        trajectory: {
          caseId: c.case_id,
          events: [{ kind: 'answer', text: '淘汰需要你在界面确认，我不会直接操作。' }],
          countsBefore: { decision: 1 },
          countsAfter: { decision: 1 },
        },
      }
    default:
      return { evalPoint: c.eval_point, stageLabel: c.min_gate, payload: {} }
  }
}

export interface EvalSuiteRunResult {
  readonly card: EvaluationCard
  readonly outcomes: readonly CaseRunOutcome[]
}

export function runEvalGateSuite(options: {
  readonly gate: 'G0' | 'G1' | 'G2' | 'ALL'
  readonly runId?: string
  readonly manifestPath?: string
  /** Issue #92 P1-B：返回 null 表示 NO_REAL_SOURCE（该案例不送判分器、不计 PASS、不进分母）。 */
  readonly artifactProvider?: (c: ManifestCaseRecord) => EvalPointArtifact | null
  readonly counterMetrics?: CounterMetricsObserved
  readonly coverage?: Omit<RealCoverage, 'totalCases' | 'executedCases'>
}): EvalSuiteRunResult {
  const manifest = loadEvalManifest(options.manifestPath)
  const registry = createV2FullRegistry()
  const selected =
    options.gate === 'ALL'
      ? manifest.cases
      : manifest.cases.filter((c) => c.min_gate === options.gate)

  const isReal = options.artifactProvider !== undefined
  const provide = options.artifactProvider ?? buildDefaultG0Artifact

  const outcomes: CaseRunOutcome[] = []
  const realSourceCaseIds: string[] = []
  const noRealSourceCaseIds: string[] = []

  for (const c of selected) {
    const artifact = provide(c)
    if (artifact === null) {
      // NO_REAL_SOURCE：真实模式下无真实产物的案例绝不判 PASS，也不参与判分。
      noRealSourceCaseIds.push(c.case_id)
      continue
    }
    realSourceCaseIds.push(c.case_id)
    const lifecycleCase: PersonLifecycleCase = {
      caseId: c.case_id,
      candidateKey: `cand-${c.case_id.toLowerCase()}`,
      evalPoint: c.eval_point,
      suitePool: c.suite_pool,
      minGate: c.min_gate,
      dataTier: c.data_tier,
      sourceRef: c.source_ref,
      granularity: c.eval_granularity,
      failureCostWeight: c.failure_cost_weight,
      graderIds: c.graders,
      artifacts: [artifact],
      description: c.description,
    }
    outcomes.push(registry.evaluateCase(lifecycleCase))
  }

  const coverage: RealCoverage | undefined =
    isReal
      ? {
          totalCases: selected.length,
          executedCases: outcomes.length,
          realSourceCaseIds: options.coverage?.realSourceCaseIds ?? realSourceCaseIds,
          noRealSourceCaseIds: options.coverage?.noRealSourceCaseIds ?? noRealSourceCaseIds,
          ...(options.coverage?.note !== undefined ? { note: options.coverage.note } : {}),
        }
      : undefined

  const card = buildEvaluationCard({
    runId: options.runId ?? `eval-${options.gate.toLowerCase()}`,
    executionMode: isReal ? 'real_adapter' : 'contract_smoke',
    outcomes,
    ...(options.counterMetrics ? { counterMetrics: options.counterMetrics } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
  })
  return { card, outcomes }
}

export function runG0DeterministicSuite(options?: {
  readonly runId?: string
  readonly manifestPath?: string
  readonly artifactProvider?: (c: ManifestCaseRecord) => EvalPointArtifact | null
  readonly counterMetrics?: CounterMetricsObserved
  readonly coverage?: Omit<RealCoverage, 'totalCases' | 'executedCases'>
}): EvalSuiteRunResult {
  return runEvalGateSuite({ gate: 'G0', ...options })
}
