// Eval V2 Phase 3 — L3 裁判校准协议 & G3 线上成对护栏只读遥测单测。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildG3PairedGuardrails, EMPTY_G3_COUNTS } from '../../src/domain/eval-telemetry.ts'
import { evaluateL3JudgeCalibration, type L3CalibrationPair } from './v2-l3-calibration.ts'

describe('Eval V2 Phase 3：L3 裁判校准与 G3 成对护栏遥测', () => {
  test('L3 校准：配平样本 + κ≥0.70 + TNR≥0.85 + 位置一致 → GATE_ELIGIBLE', () => {
    const pairs: L3CalibrationPair[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        sampleId: `pos-${i}`,
        humanPass: true,
        judgePass: i !== 9, // 9/10 TP
        positionSwapConsistent: true,
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        sampleId: `neg-${i}`,
        humanPass: false,
        judgePass: i === 9, // 9/10 TN (TNR=0.90)
        positionSwapConsistent: true,
      })),
    ]
    const rep = evaluateL3JudgeCalibration('l3-judge-v1', pairs)
    assert.equal(rep.status, 'GATE_ELIGIBLE')
    assert.ok(rep.cohensKappa >= 0.7)
    assert.ok(rep.tnr >= 0.85)
    assert.equal(rep.blockReasons.length, 0)
  })

  test('L3 校准：未配平 / 低 TNR / 位置偏置 → 强制降级 OBSERVATION_ONLY', () => {
    const skewed: L3CalibrationPair[] = [
      ...Array.from({ length: 9 }, (_, i) => ({ sampleId: `p-${i}`, humanPass: true, judgePass: true })),
      { sampleId: 'n-0', humanPass: false, judgePass: true, positionSwapConsistent: false },
    ]
    const rep = evaluateL3JudgeCalibration('l3-judge-skewed', skewed)
    assert.equal(rep.status, 'OBSERVATION_ONLY')
    assert.ok(rep.blockReasons.length >= 3)
  })

  test('G3 成对护栏：零样本诚实 NO_DATA；橡皮图章风险与高撤回率准确标 WATCH', () => {
    const empty = buildG3PairedGuardrails(EMPTY_G3_COUNTS)
    assert.equal(empty.paired_guardrails.length, 4)
    assert.ok(empty.paired_guardrails.every((g) => g.status === 'NO_DATA'))

    const watch = buildG3PairedGuardrails({
      totalApplications: 50,
      criterionOverrides: 1, // 2% < 5% 且无盲审 → WATCH
      submittedScorecards: 8,
      pendingScorecards: 2, // 80% → OK
      totalDecisions: 10,
      supersededDecisions: 3, // 30% > 15% → WATCH
      totalInterviews: 10,
      cancelledOrRescheduledInterviews: 3, // 30% > 20% → WATCH
    })
    const byId = Object.fromEntries(watch.paired_guardrails.map((g) => [g.id, g]))
    assert.equal(byId.override_vs_blind_audit.status, 'WATCH')
    assert.equal(byId.scorecard_completion_vs_faithfulness.status, 'OK')
    assert.equal(byId.decision_vs_undo.status, 'WATCH')
    assert.equal(byId.funnel_speed_vs_rework.status, 'WATCH')
  })
})
