// Eval V2 Phase 3 — L3 裁判校准协议 & G3 线上成对护栏只读遥测单测。
//
// Issue #92 P1-C G3 护栏修复（口径 B）：
//   - paired_guardrails 只 3 对（去掉假护栏 override_vs_blind_audit）；
//   - scorecard_completion_vs_faithfulness 的 guardrailRate 改为「确定性引用锚定」（非 L3 LLM 裁判）：
//     SQL 校验 scorecard.items[*].evidence[] 的 quote 逐字命中同 tenant 同 artifact 的
//     transcript_segment.content_text；命中率 < 0.8 → WATCH；0 引用 → null + note「暂无可抽样引用」；
//   - degraded 仍 3/3 ERROR，只是集合从 4 个缩到 3 个。
// L3 校准两测试（第 9-39 行）保持原判据不变。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { buildG3PairedGuardrails, EMPTY_G3_COUNTS, readG3FunnelTelemetry } from '../../src/domain/eval-telemetry.ts'
import { evaluateL3JudgeCalibration, type L3CalibrationPair } from './v2-l3-calibration.ts'

/** 口径 B 的三对护栏 id（精确集合；order 不重要，集合重要）。 */
const G3_GUARDRAIL_IDS = [
  'scorecard_completion_vs_faithfulness',
  'decision_vs_undo',
  'funnel_speed_vs_rework',
] as const

describe('Eval V2 Phase 3：L3 裁判校准与 G3 成对护栏遥测', () => {
  // -------------------------------------------------------------------------
  //  L3 校准：以下两个用例保持原判据（Issue #92 不涉及这里）。
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  //  G3 成对护栏：4 对 → 3 对；假护栏「橡皮图章」判据 → 确定性引用锚定命中率。
  // -------------------------------------------------------------------------
  test('G3 成对护栏：恰好 3 对 / 空样本 3/3 NO_DATA；低引用命中 → WATCH，零引用 → null + note', () => {
    const empty = buildG3PairedGuardrails(EMPTY_G3_COUNTS)

    // 改前：length===4 且 empty 全 NO_DATA；改后：只 3 对、3/3 NO_DATA。
    assert.equal(empty.paired_guardrails.length, 3)
    assert.ok(empty.paired_guardrails.every((g) => g.status === 'NO_DATA'))
    assert.deepEqual(
      empty.paired_guardrails.map((g) => g.id).sort(),
      [...G3_GUARDRAIL_IDS].sort(),
      '必须是精确的三对护栏集合',
    )
    assert.ok(
      empty.paired_guardrails.every((g) => g.id !== 'override_vs_blind_audit'),
      '第 4 对假护栏（override_vs_blind_audit / 橡皮图章）必须移除',
    )

    // 改前：用 criterionOverrides=1 的「橡皮图章」判据让 override_vs_blind_audit WATCH；
    // 改后：传 faithfulnessQuoteSampleCount/MatchedCount，用确定性引用锚定命中率判 WATCH。
    const watch = buildG3PairedGuardrails({
      totalApplications: 50,
      submittedScorecards: 8,
      pendingScorecards: 2, // 80% → primaryRate OK
      totalDecisions: 10,
      supersededDecisions: 3, // 30% > 15% → WATCH
      totalInterviews: 10,
      cancelledOrRescheduledInterviews: 3, // 30% > 20% → WATCH
      faithfulnessQuoteSampleCount: 5,
      faithfulnessQuoteMatchedCount: 2, // 40% < 80% → WATCH
    })
    const byId = Object.fromEntries(watch.paired_guardrails.map((g) => [g.id, g]))
    assert.equal(byId.scorecard_completion_vs_faithfulness?.status, 'WATCH')
    assert.equal(byId.scorecard_completion_vs_faithfulness?.guardrailRate, 0.4)
    assert.match(byId.scorecard_completion_vs_faithfulness?.note ?? '', /确定性引用锚定/)
    assert.equal(byId.decision_vs_undo?.status, 'WATCH')
    assert.equal(byId.funnel_speed_vs_rework?.status, 'WATCH')
    assert.equal(byId.override_vs_blind_audit, undefined, '响应不得再含盲审假护栏')

    // 零引用：guardrailRate 必须是 null（不得是 0 或 1），note 需同时含两个规定短语。
    const noQuotes = buildG3PairedGuardrails({
      ...EMPTY_G3_COUNTS,
      submittedScorecards: 8,
      pendingScorecards: 2,
    })
    const noQuotesGuardrail = noQuotes.paired_guardrails.find(
      (g) => g.id === 'scorecard_completion_vs_faithfulness',
    )
    assert.ok(noQuotesGuardrail !== undefined)
    assert.equal(noQuotesGuardrail.guardrailRate, null, '0 引用时 guardrailRate 必须为 null')
    assert.match(noQuotesGuardrail.note, /暂无可抽样引用/)
    assert.match(noQuotesGuardrail.note, /确定性引用锚定/)
    // 面评有提交 → primaryRate 必须非 null（仍按提交率算）。
    assert.equal(noQuotesGuardrail.primaryRate, 0.8)
  })

  test('G3 查询报错不得静默吞错为 NO_DATA（P0-1 回归守卫）', async () => {
    const failingClient = {
      query: async () => {
        const e = new Error('column does not exist') as Error & { code?: string }
        e.code = '42703'
        throw e
      },
    }
    const snap = await readG3FunnelTelemetry(failingClient as never, '00000000-0000-4000-8000-000000000001')
    assert.equal(snap.degraded, true)
    assert.equal(snap.error_code, 'TELEMETRY_QUERY_FAILED')

    // 改前：只断言 every ERROR（4 个）；改后：3/3 ERROR + error_code + 精确 id 集合 + 无盲审 id。
    assert.equal(snap.paired_guardrails.length, 3)
    assert.ok(snap.paired_guardrails.every((g) => g.status === 'ERROR'))
    assert.deepEqual(
      snap.paired_guardrails.map((g) => g.id).sort(),
      [...G3_GUARDRAIL_IDS].sort(),
    )
    assert.ok(snap.paired_guardrails.every((g) => g.id !== 'override_vs_blind_audit'))
  })
})
