// Eval V2 — 7 个 L3 原子维度主观裁判判分器（对齐 docs/42 §5 & Issue #92 P0-3）。
// 严格 Fail-Closed：缺 L3 裁判结果、未过校准闸门（calibrationStatus !== 'GATE_ELIGIBLE'）、或 A/B 位置互换不一致时一律 FAIL。
import type { GraderRegistry } from './grader-registry.ts'
import type { EvalPointArtifact, GradeResult, GraderFn } from './v2-types.ts'

export interface L3AtomicJudgment {
  readonly graderId: string
  readonly judgeVersion: string
  readonly calibrationStatus: 'GATE_ELIGIBLE' | 'OBSERVATION_ONLY'
  readonly verdict: 'pass' | 'fail'
  readonly positionSwapConsistent: boolean
  readonly citedSourceQuote: string
  readonly rationale?: string
}

function makeL3AtomicGrader(graderId: string, dimensionLabel: string): GraderFn {
  return (artifact: EvalPointArtifact): GradeResult => {
    const judgments = artifact.payload.l3Judgments as Readonly<Record<string, L3AtomicJudgment>> | undefined
    const j = judgments?.[graderId]
    if (!j || typeof j !== 'object') {
      return { ok: false, code: 'INCONCLUSIVE_MISSING_L3_JUDGMENT', message: `缺少 ${graderId}（${dimensionLabel}）的 L3 裁判输出` }
    }
    if (!j.judgeVersion || j.judgeVersion.trim() === '') {
      return { ok: false, code: 'L3_MISSING_VERSION', message: `${graderId} 缺少锁定的 judgeVersion` }
    }
    if (j.calibrationStatus !== 'GATE_ELIGIBLE') {
      return { ok: false, code: 'L3_UNCALIBRATED', message: `${graderId} 尚未通过校准上岗门槛（当前 ${j.calibrationStatus}）` }
    }
    if (j.positionSwapConsistent !== true) {
      return { ok: false, code: 'L3_POSITION_BIAS', message: `${graderId} 未通过 A/B 位置互换一致性检验` }
    }
    if (typeof j.citedSourceQuote !== 'string' || j.citedSourceQuote.trim().length < 4) {
      return { ok: false, code: 'L3_MISSING_SOURCE_QUOTE', message: `${graderId} 违反“先引原文、后下判决”原则` }
    }
    if (j.verdict !== 'pass') {
      return { ok: false, code: `L3_FAIL_${graderId.toUpperCase()}`, message: j.rationale || `${dimensionLabel}未通过 L3 原子维度判定` }
    }
    return { ok: true, code: graderId, message: `${dimensionLabel} L3 原子维度通过（${j.judgeVersion}）` }
  }
}

export const V2_L3_GRADERS: Readonly<Record<string, GraderFn>> = {
  L3_fluff_detection: makeL3AtomicGrader('L3_fluff_detection', '简历空洞水分拆解'),
  L3_claim_faithfulness: makeL3AtomicGrader('L3_claim_faithfulness', '面评草稿原子事实忠实度'),
  L3_numeric_grounding: makeL3AtomicGrader('L3_numeric_grounding', '面评数字 100% 原文出处'),
  L3_speaker_attribution_exact: makeL3AtomicGrader('L3_speaker_attribution_exact', '多说话人归属防串台'),
  L3_hallucination_rate: makeL3AtomicGrader('L3_hallucination_rate', '面评零编造幻觉率'),
  L3_second_probe_collapse_caught: makeL3AtomicGrader('L3_second_probe_collapse_caught', '二轮追问崩塌短板捕获'),
  L3_team_vs_individual_separated: makeL3AtomicGrader('L3_team_vs_individual_separated', '团队功劳与个人动作剥离'),
}

export function registerV2L3Graders(registry: GraderRegistry): void {
  for (const [id, fn] of Object.entries(V2_L3_GRADERS)) {
    registry.register(id, fn)
  }
}
