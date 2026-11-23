// Eval V2 Phase 3 — L3 主观裁判（LLM-as-Judge）校准协议（对齐 docs/42 §5）。
// 铁律：
//   1. 弃用 1–5 连续打分，统一用原子维度 pass/fail（true=通过, false=坏例）；
//   2. 校准集必须人为配平（坏例占比 40%–60%），防小样本方差陷阱；
//   3. 成对对比须做 A/B 位置互换一致性检查（≥ 90%）；
//   4. 同时满足 Cohen's κ ≥ 0.70 与 TNR ≥ 0.85 才允许上岗（GATE_ELIGIBLE），否则 OBSERVATION_ONLY。

export interface L3CalibrationPair {
  readonly sampleId: string
  /** 真人标注：true = 合格好例，false = 典型坏例。 */
  readonly humanPass: boolean
  /** 裁判判定：true = 合格好例，false = 典型坏例。 */
  readonly judgePass: boolean
  /** 可选：成对 A/B 位置互换后裁判结论是否保持一致。 */
  readonly positionSwapConsistent?: boolean
}

export interface L3CalibrationThresholds {
  readonly minSamples: number
  readonly minNegativeRatio: number
  readonly maxNegativeRatio: number
  readonly minKappa: number
  readonly minTnr: number
  readonly minPositionConsistency: number
}

export const DEFAULT_L3_THRESHOLDS: L3CalibrationThresholds = {
  minSamples: 10,
  minNegativeRatio: 0.4,
  maxNegativeRatio: 0.6,
  minKappa: 0.7,
  minTnr: 0.85,
  minPositionConsistency: 0.9,
}

export interface L3CalibrationReport {
  readonly judgeVersion: string
  readonly status: 'GATE_ELIGIBLE' | 'OBSERVATION_ONLY'
  readonly totalSamples: number
  readonly positiveCount: number
  readonly negativeCount: number
  readonly negativeRatio: number
  readonly agreementRate: number
  readonly cohensKappa: number
  readonly tnr: number
  readonly tpr: number
  readonly positionSwapConsistency?: number
  readonly blockReasons: readonly string[]
}

export function evaluateL3JudgeCalibration(
  judgeVersion: string,
  pairs: readonly L3CalibrationPair[],
  thresholds: L3CalibrationThresholds = DEFAULT_L3_THRESHOLDS,
): L3CalibrationReport {
  const total = pairs.length
  let tp = 0
  let tn = 0
  let fp = 0
  let fn = 0
  let swapChecked = 0
  let swapOk = 0

  for (const p of pairs) {
    if (p.humanPass && p.judgePass) tp += 1
    else if (!p.humanPass && !p.judgePass) tn += 1
    else if (!p.humanPass && p.judgePass) fp += 1
    else fn += 1

    if (p.positionSwapConsistent !== undefined) {
      swapChecked += 1
      if (p.positionSwapConsistent) swapOk += 1
    }
  }

  const positiveCount = tp + fn
  const negativeCount = tn + fp
  const negativeRatio = total === 0 ? 0 : Number((negativeCount / total).toFixed(4))
  const po = total === 0 ? 0 : (tp + tn) / total
  const pHumanPos = total === 0 ? 0 : positiveCount / total
  const pJudgePos = total === 0 ? 0 : (tp + fp) / total
  const pe = pHumanPos * pJudgePos + (1 - pHumanPos) * (1 - pJudgePos)
  const rawKappa = total === 0 ? 0 : Math.abs(1 - pe) < 1e-9 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe)
  const cohensKappa = Number(rawKappa.toFixed(4))
  const tnr = negativeCount === 0 ? 0 : Number((tn / negativeCount).toFixed(4))
  const tpr = positiveCount === 0 ? 0 : Number((tp / positiveCount).toFixed(4))
  const positionSwapConsistency =
    swapChecked > 0 ? Number((swapOk / swapChecked).toFixed(4)) : undefined

  const blockReasons: string[] = []
  if (total < thresholds.minSamples) {
    blockReasons.push(`校准样本量不足（${total} < ${thresholds.minSamples}）`)
  }
  if (negativeRatio < thresholds.minNegativeRatio || negativeRatio > thresholds.maxNegativeRatio) {
    blockReasons.push(
      `校准集未配平（坏例占比 ${(negativeRatio * 100).toFixed(1)}%，要求 ${thresholds.minNegativeRatio * 100}%–${thresholds.maxNegativeRatio * 100}%）`,
    )
  }
  if (cohensKappa < thresholds.minKappa) {
    blockReasons.push(`Cohen's κ=${cohensKappa} 低于上岗门槛 ${thresholds.minKappa}`)
  }
  if (tnr < thresholds.minTnr) {
    blockReasons.push(`坏例拦截率 TNR=${tnr} 低于上岗门槛 ${thresholds.minTnr}`)
  }
  if (
    positionSwapConsistency !== undefined &&
    positionSwapConsistency < thresholds.minPositionConsistency
  ) {
    blockReasons.push(
      `A/B 位置互换一致率 ${(positionSwapConsistency * 100).toFixed(1)}% 低于 ${thresholds.minPositionConsistency * 100}%`,
    )
  }

  return {
    judgeVersion,
    status: blockReasons.length === 0 ? 'GATE_ELIGIBLE' : 'OBSERVATION_ONLY',
    totalSamples: total,
    positiveCount,
    negativeCount,
    negativeRatio,
    agreementRate: Number(po.toFixed(4)),
    cohensKappa,
    tnr,
    tpr,
    ...(positionSwapConsistency !== undefined ? { positionSwapConsistency } : {}),
    blockReasons,
  }
}
