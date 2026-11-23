// Issue #63 Phase 1 — Eval V2 以「人」为主轴的统一类型契约（对齐 docs/42 V2 + §8.1–§8.6）。
// 不破坏既有 test/eval/types.ts（18 例对话层回归），供 GraderRegistry / EvaluationCard / Loaders 共用。
import type { EvalTrajectory, GradeResult, TraceEvent } from './types.ts'

export type { EvalTrajectory, GradeResult, TraceEvent }

export type EvalPointId =
  | 'P1_ParseUnderstand'
  | 'P2_ScreeningThreeState'
  | 'P3_LinearRoundHandoff'
  | 'P4_TranscriptScorecard'
  | 'P5_DecisionAndTrace'
  | 'P6_ChatAndPersonTrajectory'

export const ALL_EVAL_POINTS: readonly EvalPointId[] = [
  'P1_ParseUnderstand',
  'P2_ScreeningThreeState',
  'P3_LinearRoundHandoff',
  'P4_TranscriptScorecard',
  'P5_DecisionAndTrace',
  'P6_ChatAndPersonTrajectory',
]

export type SuitePool = 'regression' | 'capability'
export type MinGate = 'G0' | 'G1' | 'G2'
export type DataTier = 'tier1_private_corpus' | 'tier2_public_benchmark' | 'tier3_fault_injection'
export type EvalGranularity = 'step' | 'handoff' | 'funnel'
export type FailureCostWeight = 'critical' | 'high' | 'medium'

/** 单个判断点（P1–P6）的评测产物快照。 */
export interface EvalPointArtifact {
  readonly evalPoint: EvalPointId
  readonly stageLabel: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly answerText?: string
  readonly trajectory?: EvalTrajectory
  readonly latencyMs?: number
  readonly ttftMs?: number
}

/** 以「人（Candidate / Application）」为主轴的单人全周期评测用例。 */
export interface PersonLifecycleCase {
  readonly caseId: string
  readonly candidateKey: string
  readonly evalPoint: EvalPointId
  readonly suitePool: SuitePool
  readonly minGate: MinGate
  readonly dataTier: DataTier
  readonly sourceRef: string
  readonly granularity: EvalGranularity
  readonly failureCostWeight: FailureCostWeight
  readonly graderIds: readonly string[]
  readonly artifacts: readonly EvalPointArtifact[]
  readonly description: string
}

/** 单条判分器函数签名（确定性 L1 / 轨迹 L2 / 校准后 L3 统一契约）。 */
export type GraderFn = (artifact: EvalPointArtifact, lifecycleCase: PersonLifecycleCase) => GradeResult

/** 单例执行结果（含首个折损归因）。 */
export interface CaseRunOutcome {
  readonly caseId: string
  readonly evalPoint: EvalPointId
  readonly suitePool: SuitePool
  readonly minGate: MinGate
  readonly dataTier: DataTier
  readonly granularity: EvalGranularity
  readonly failureCostWeight: FailureCostWeight
  readonly passed: boolean
  readonly grades: readonly GradeResult[]
  readonly firstFailureCode?: string
  readonly firstFailureMessage?: string
  readonly durationMs?: number
}

/** docs/42 §3 反向压制与等待体感阈值。 */
export interface CounterMetricsThresholds {
  readonly s7MaxCharsPerItem: number
  readonly s8MaxChars: number
  readonly chatMaxChars: number
  readonly maxClearTextUnreadableRate: number
  readonly maxTtftMs: number
  readonly maxPdfScreenP95Ms: number
}

export const DEFAULT_COUNTER_METRICS_THRESHOLDS: CounterMetricsThresholds = {
  s7MaxCharsPerItem: 80,
  s8MaxChars: 300,
  chatMaxChars: 250,
  maxClearTextUnreadableRate: 0.05,
  maxTtftMs: 3000,
  maxPdfScreenP95Ms: 15000,
}

/** 单次运行观测到的反向压制指标快照。 */
export interface CounterMetricsObserved {
  readonly clearTextUnreadableRate?: number
  readonly ttftMsP95?: number
  readonly pdfScreenMsP95?: number
  readonly maxS7ItemChars?: number
  readonly maxS8BriefChars?: number
  readonly maxChatReplyChars?: number
  readonly emptyPointerCitations?: number
}
