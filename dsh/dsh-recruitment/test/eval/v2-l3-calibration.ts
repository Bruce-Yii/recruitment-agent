// Eval V2 — L3 主观裁判（LLM-as-Judge）校准协议（对齐 docs/42 §5 & Issue #92 P1-5）。
// 强制：配平 40%–60%、A/B 位置互换一致性必填且 ≥ 90%、原始未四舍五入 Cohen's κ ≥ 0.70、原始 TNR ≥ 0.85。
export interface L3CalibrationPair {
  readonly sampleId: string
  readonly humanPass: boolean
  readonly judgePass: boolean
  /** 强制项：成对 A/B 位置互换后裁判结论是否保持一致。 */
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
  readonly positionSwapConsistency: number | null
  readonly blockReasons: readonly string[]
}

export function evaluateL3JudgeCalibration(
  judgeVersion: string,
  pairs: readonly L3CalibrationPair[],
  thresholds: L3CalibrationThresholds = DEFAULT_L3_THRESHOLDS,
): L3CalibrationReport {
  const total = pairs.length
  let tp = 0, tn = 0, fp = 0, fn = 0, swapChecked = 0, swapOk = 0

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
  const rawNegRatio = total === 0 ? 0 : negativeCount / total
  const po = total === 0 ? 0 : (tp + tn) / total
  const pHumanPos = total === 0 ? 0 : positiveCount / total
  const pJudgePos = total === 0 ? 0 : (tp + fp) / total
  const pe = pHumanPos * pJudgePos + (1 - pHumanPos) * (1 - pJudgePos)
  const rawKappa = total === 0 ? 0 : Math.abs(1 - pe) < 1e-9 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe)
  const rawTnr = negativeCount === 0 ? 0 : tn / negativeCount
  const rawTpr = positiveCount === 0 ? 0 : tp / positiveCount
  const rawSwap = swapChecked > 0 ? swapOk / swapChecked : null

  const blockReasons: string[] = []
  if (total < thresholds.minSamples) blockReasons.push(`校准样本量不足（${total} < ${thresholds.minSamples}）`)
  if (rawNegRatio < thresholds.minNegativeRatio || rawNegRatio > thresholds.maxNegativeRatio) {
    blockReasons.push(`校准集未配平（坏例占比 ${(rawNegRatio * 100).toFixed(1)}%，要求 ${thresholds.minNegativeRatio * 100}%–${thresholds.maxNegativeRatio * 100}%）`)
  }
  if (rawKappa < thresholds.minKappa) blockReasons.push(`Cohen's κ=${rawKappa.toFixed(4)} 低于上岗门槛 ${thresholds.minKappa}`)
  if (rawTnr < thresholds.minTnr) blockReasons.push(`坏例拦截率 TNR=${rawTnr.toFixed(4)} 低于上岗门槛 ${thresholds.minTnr}`)
  if (rawSwap === null || swapChecked < total) {
    blockReasons.push('缺少完整的 A/B 位置互换一致性检验（docs/42 §5 强制项）')
  } else if (rawSwap < thresholds.minPositionConsistency) {
    blockReasons.push(`A/B 位置互换一致率 ${(rawSwap * 100).toFixed(1)}% 低于 ${thresholds.minPositionConsistency * 100}%`)
  }

  return {
    judgeVersion,
    status: blockReasons.length === 0 ? 'GATE_ELIGIBLE' : 'OBSERVATION_ONLY',
    totalSamples: total,
    positiveCount,
    negativeCount,
    negativeRatio: Number(rawNegRatio.toFixed(4)),
    agreementRate: Number(po.toFixed(4)),
    cohensKappa: Number(rawKappa.toFixed(4)),
    tnr: Number(rawTnr.toFixed(4)),
    tpr: Number(rawTpr.toFixed(4)),
    positionSwapConsistency: rawSwap === null ? null : Number(rawSwap.toFixed(4)),
    blockReasons,
  }
}
