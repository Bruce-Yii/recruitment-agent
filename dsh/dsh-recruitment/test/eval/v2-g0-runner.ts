// Eval V2 Phase 2 — G0 档（0-LLM 确定性快门）执行器与全量 L1/L2 注册入口。
// 对齐 docs/42 §6（G0 ≤ 2 分钟、0 LLM）与 corpus-manifest.json（schema_version 2.2.0）。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEvaluationCard, type EvaluationCard } from './evaluation-card.ts'
import { GraderRegistry } from './grader-registry.ts'
import { registerV2L1Graders } from './v2-graders-l1.ts'
import { registerV2L2Graders } from './v2-graders-l2.ts'
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

export function createV2DeterministicRegistry(): GraderRegistry {
  const registry = new GraderRegistry()
  registerV2L1Graders(registry)
  registerV2L2Graders(registry)
  return registry
}

/** 构造 G0 契约冒烟产物（用于验证 11 条 G0 确定性判分器链路与 Evaluation Card 生成）。 */
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
      return { evalPoint: c.eval_point, stageLabel: 'G0', payload: {} }
  }
}

export interface G0RunResult {
  readonly card: EvaluationCard
  readonly outcomes: readonly CaseRunOutcome[]
}

export function runG0DeterministicSuite(options?: {
  readonly runId?: string
  readonly manifestPath?: string
  readonly artifactProvider?: (c: ManifestCaseRecord) => EvalPointArtifact
  readonly counterMetrics?: CounterMetricsObserved
}): G0RunResult {
  const manifest = loadEvalManifest(options?.manifestPath)
  const registry = createV2DeterministicRegistry()
  const g0Cases = manifest.cases.filter((c) => c.min_gate === 'G0')
  const provide = options?.artifactProvider ?? buildDefaultG0Artifact

  const outcomes: CaseRunOutcome[] = g0Cases.map((c) => {
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
      artifacts: [provide(c)],
      description: c.description,
    }
    return registry.evaluateCase(lifecycleCase)
  })

  const card = buildEvaluationCard({
    runId: options?.runId ?? 'g0-deterministic',
    outcomes,
    counterMetrics: options?.counterMetrics ?? {
      clearTextUnreadableRate: 0,
      ttftMsP95: 900,
      pdfScreenMsP95: 1200,
      emptyPointerCitations: 0,
    },
  })

  return { card, outcomes }
}
