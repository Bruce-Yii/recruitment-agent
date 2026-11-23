// Eval V2 — P2–P5 真实业务输出适配器与 pass^k 稳定性指标单测。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createV2FullRegistry } from './v2-g0-runner.ts'
import {
  adaptDecisionSummaryToP5Artifact,
  adaptHandoffBriefToP3Artifact,
  adaptScreeningToP2Artifact,
  adaptTranscriptDraftToP4Artifact,
  computePassPowerK,
} from './v2-real-adapters.ts'
import type { PersonLifecycleCase } from './v2-types.ts'

function mk(caseId: string, evalPoint: PersonLifecycleCase['evalPoint'], graderIds: readonly string[], art: ReturnType<typeof adaptScreeningToP2Artifact>): PersonLifecycleCase {
  return {
    caseId, candidateKey: 'cand-1', evalPoint, suitePool: 'regression', minGate: 'G1',
    dataTier: 'tier2_public_benchmark', sourceRef: 'https://example.org/real',
    granularity: 'step', failureCostWeight: 'critical', graderIds, artifacts: [art], description: 'p2-p5 adapter',
  }
}

describe('Eval V2：P2–P5 真实业务输出适配器与 pass^k', () => {
  test('P2 初筛适配器：真实原文子串 PASS，未锚定/读不出来编造为没有对应 FAIL', () => {
    const reg = createV2FullRegistry()
    const okArt = adaptScreeningToP2Artifact({
      answerText: '倾向往下走。这是建议，不是决定，决定由你来做。',
      criteria: [
        { state: '有对应', quote: '负责千万级订单系统架构', sourceText: '2023年负责千万级订单系统架构设计', isClearTextSource: true },
        { state: '读不出来', isUnreadableSource: true },
      ],
    })
    assert.equal(
      reg.evaluateCase(mk('AD-P2-OK', 'P2_ScreeningThreeState', [
        'L1_three_state_enum', 'L1_suggestion_not_decision', 'L1_min_verbatim_substring_anchor',
        'L1_unreadable_not_absent', 'L1_unreadable_inflation_cap_5pct', 'L1_zero_decision_row',
      ], okArt)).passed,
      true,
    )

    const badArt = adaptScreeningToP2Artifact({
      answerText: '倾向往下走。这是建议，不是决定，决定由你来做。',
      criteria: [{ state: '没有对应', isUnreadableSource: true }],
    })
    assert.equal(
      reg.evaluateCase(mk('AD-P2-BAD', 'P2_ScreeningThreeState', ['L1_unreadable_not_absent'], badArt)).passed,
      false,
    )
  })

  test('P3 / P4 / P5 适配器对接 66 严格判分器正反例', () => {
    const reg = createV2FullRegistry()

    const p3Ok = adaptHandoffBriefToP3Artifact({
      answerText: '本轮可以了解分布式事务与团队协作细节。',
      expectedUncoveredDims: ['分布式事务'],
      outputUncoveredDims: ['分布式事务'],
      alreadyCoveredDims: ['基础算法'],
      recommendedDims: ['分布式事务'],
      outOfRubricExtraItems: 0,
      priorScoreLeaked: false,
    })
    assert.equal(
      reg.evaluateCase(mk('AD-P3', 'P3_LinearRoundHandoff', [
        'L2_reference_not_command', 'L2_only_uncovered_rubric_dims',
        'L2_no_redundant_repeat_questions', 'L2_cross_round_anchor_isolated',
      ], p3Ok)).passed,
      true,
    )

    const p4Ok = adaptTranscriptDraftToP4Artifact({
      answerText: '这场还没收到转写，不影响继续下一步。',
      sourceKind: 'MANUAL',
      connectionState: 'NOT_CONNECTED',
      readbackHashMismatch: true,
      outcome: 'BLOCKED',
      rowsWritten: 0,
      recordStatus: 'NEEDS_REVIEW',
      verificationStatus: 'UNVERIFIED',
      draftCountedInSummary: false,
    })
    assert.equal(
      reg.evaluateCase(mk('AD-P4', 'P4_TranscriptScorecard', [
        'L1_transcript_provenance_honest', 'L1_readback_mismatch_blocked',
        'L1_draft_not_counted_as_scorecard', 'L1_no_missing_doc_demand',
      ], p4Ok)).passed,
      true,
    )

    const p5Ok = adaptDecisionSummaryToP5Artifact({
      answerText: '一面面试官认可系统设计，二面面试官对并发细节存疑；最终决定请由你拍板。',
      missingScorecardFlagged: true,
      missingTreatedAsZero: false,
      sideAQuoteKept: true,
      sideBQuoteKept: true,
      implicitSideTaken: false,
      pinConstraintVisible: true,
    })
    assert.equal(
      reg.evaluateCase(mk('AD-P5', 'P5_DecisionAndTrace', [
        'L1_no_auto_decision', 'L2_incomplete_scorecard_flagged',
        'L2_conflict_neutral_both_sides_kept', 'L2_pin_constraint_propagated',
      ], p5Ok)).passed,
      true,
    )
  })

  test('computePassPowerK：精确计算 pass^3 并标出抖动用例', () => {
    const res = computePassPowerK([
      { 'P1-01': true, 'P2-01': true, 'P6-01': false },
      { 'P1-01': true, 'P2-01': false, 'P6-01': false },
      { 'P1-01': true, 'P2-01': true, 'P6-01': false },
    ])
    assert.equal(res.k, 3)
    assert.equal(res.stablePassed, 1)
    assert.equal(res.passPowerKRate, 0.3333)
    assert.deepEqual(res.flakyCaseIds, ['P2-01'])
  })
})
