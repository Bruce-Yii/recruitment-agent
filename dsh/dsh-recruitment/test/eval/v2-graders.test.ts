// Eval V2 Phase 2 — 全量 59 个 L1/L2 判分器注册守卫 + 正反例 + G0 档 Evaluation Card 冒烟测试。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { formatEvaluationCardMarkdown } from './evaluation-card.ts'
import { createV2DeterministicRegistry, loadEvalManifest, runG0DeterministicSuite } from './v2-g0-runner.ts'
import type { EvalPointArtifact, PersonLifecycleCase } from './v2-types.ts'

function mkCase(caseId: string, evalPoint: PersonLifecycleCase['evalPoint'], graderIds: readonly string[], artifact: EvalPointArtifact): PersonLifecycleCase {
  return {
    caseId,
    candidateKey: 'cand-test',
    evalPoint,
    suitePool: 'regression',
    minGate: 'G1',
    dataTier: 'tier2_public_benchmark',
    sourceRef: 'https://example.org/test',
    granularity: 'step',
    failureCostWeight: 'critical',
    graderIds,
    artifacts: [artifact],
    description: 'unit test',
  }
}

describe('Eval V2 Phase 2：L1/L2 判分器注册与 G0 确定性执行器', () => {
  test('manifest 中声明的全部 L1/L2 graderId 均已注册（零遗漏）', () => {
    const manifest = loadEvalManifest()
    const registry = createV2DeterministicRegistry()
    const deterministicIds = manifest.cases
      .flatMap((c) => c.graders)
      .filter((id) => id.startsWith('L1_') || id.startsWith('L2_'))

    const check = registry.validateManifestGraders(deterministicIds)
    assert.deepEqual(check.missing, [], `存在未注册的 L1/L2 判分器：${check.missing.join(', ')}`)
    assert.equal(check.ok, true)
  })

  test('高危反刷分与 2026 盲区判分器正反例校验', () => {
    const reg = createV2DeterministicRegistry()

    // 1. P2 反空指针敷衍 + 反读不出来膨胀 + 0 依据省略建议
    const emptyPtrFail = reg.evaluateCase(
      mkCase('T-P2-1', 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
        evalPoint: 'P2_ScreeningThreeState',
        stageLabel: 'S7',
        payload: { matchedItems: [{ quote: '见第1页', sourceText: '负责千万级订单系统架构设计' }] },
      }),
    )
    assert.equal(emptyPtrFail.passed, false)
    assert.equal(emptyPtrFail.firstFailureCode, 'EMPTY_POINTER_CITATION')

    const inflationFail = reg.evaluateCase(
      mkCase('T-P2-2', 'P2_ScreeningThreeState', ['L1_unreadable_inflation_cap_5pct'], {
        evalPoint: 'P2_ScreeningThreeState',
        stageLabel: 'S7',
        payload: { clearTextUnreadableRate: 0.12 },
      }),
    )
    assert.equal(inflationFail.passed, false)
    assert.equal(inflationFail.firstFailureCode, 'UNREADABLE_INFLATION')

    const zeroGroundFail = reg.evaluateCase(
      mkCase('T-P2-3', 'P2_ScreeningThreeState', ['L1_omit_suggestion_on_zero_grounding'], {
        evalPoint: 'P2_ScreeningThreeState',
        stageLabel: 'S7',
        answerText: '倾向再确认。这是建议，不是决定。',
        payload: { groundedCriteriaCount: 0 },
      }),
    )
    assert.equal(zeroGroundFail.passed, false)

    // 2. P3 跨轮防锚定隔离 + 参考非指令
    const anchorFail = reg.evaluateCase(
      mkCase('T-P3-1', 'P3_LinearRoundHandoff', ['L2_cross_round_anchor_isolated', 'L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff',
        stageLabel: 'S8',
        answerText: '上轮面试官觉得气场偏弱，这一轮必须问清并发细节。',
        payload: { priorScoreLeaked: false },
      }),
    )
    assert.equal(anchorFail.passed, false)
    assert.equal(anchorFail.firstFailureCode, 'CROSS_ROUND_ANCHOR_LEAK')

    // 3. P4 转写来路诚实与哈希矛盾拦截
    const fakeConnFail = reg.evaluateCase(
      mkCase('T-P4-1', 'P4_TranscriptScorecard', ['L1_transcript_provenance_honest'], {
        evalPoint: 'P4_TranscriptScorecard',
        stageLabel: 'S9',
        payload: { sourceKind: 'MANUAL', connectionState: 'CONNECTED' },
      }),
    )
    assert.equal(fakeConnFail.passed, false)

    // 4. P5 冲突面评隐性站队拦截
    const sideFail = reg.evaluateCase(
      mkCase('T-P5-1', 'P5_DecisionAndTrace', ['L2_conflict_neutral_both_sides_kept'], {
        evalPoint: 'P5_DecisionAndTrace',
        stageLabel: 'S10',
        payload: { sideAQuoteKept: true, sideBQuoteKept: true, implicitSideTaken: true },
      }),
    )
    assert.equal(sideFail.passed, false)

    // 5. P6 言行一致（防 Halluci-Action）
    const halluciFail = reg.evaluateCase(
      mkCase('T-P6-1', 'P6_ChatAndPersonTrajectory', ['L1_action_claim_alignment'], {
        evalPoint: 'P6_ChatAndPersonTrajectory',
        stageLabel: 'CHAT',
        answerText: '我已经帮你把候选人推进到二面并安排好面试了。',
        payload: {},
      }),
    )
    assert.equal(halluciFail.passed, false)
    assert.equal(halluciFail.firstFailureCode, 'HALLUCI_ACTION')
  })

  test('G0 档（11 条 0-LLM 用例）全链冒烟并生成完整 Evaluation Card', () => {
    const { card, outcomes } = runG0DeterministicSuite({ runId: 'g0-ci-smoke' })
    assert.equal(outcomes.length, 11)
    assert.equal(card.byMinGate.G0.total, 11)
    assert.equal(card.byMinGate.G0.passed, 11)
    assert.equal(card.counterMetricsOk, true)
    assert.equal(card.firstBreakdowns.length, 0)

    const md = formatEvaluationCardMarkdown(card)
    assert.ok(md.includes('Evaluation Card (g0-ci-smoke)'))
    assert.ok(md.includes('P1_ParseUnderstand'))
    assert.ok(md.includes('P6_ChatAndPersonTrajectory'))
  })
})
