// Eval V2 — 66 个判分器（L1+L2+L3）全量注册守卫 + 空 payload 零通过红线 + 红队绕过防线回归。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { scanPrivateCorpusInventory } from './corpus-inventory.ts'
import { buildEvaluationCard, formatEvaluationCardMarkdown } from './evaluation-card.ts'
import { createV2FullRegistry, loadEvalManifest, runEvalGateSuite, runG0DeterministicSuite } from './v2-g0-runner.ts'
import { evaluateL3JudgeCalibration } from './v2-l3-calibration.ts'
import type { EvalPointArtifact, PersonLifecycleCase } from './v2-types.ts'

function mkCase(caseId: string, evalPoint: PersonLifecycleCase['evalPoint'], graderIds: readonly string[], artifact: EvalPointArtifact): PersonLifecycleCase {
  return {
    caseId, candidateKey: 'cand-test', evalPoint, suitePool: 'regression', minGate: 'G1',
    dataTier: 'tier2_public_benchmark', sourceRef: 'https://example.org/test',
    granularity: 'step', failureCostWeight: 'critical', graderIds, artifacts: [artifact], description: 'redteam',
  }
}

describe('Eval V2 严格 Fail-Closed 与红队防绕过回归（Issue #92 P0/P1 根治）', () => {
  test('P0-3：manifest 声明的全部 66 个 L1/L2/L3 graderId 100% 已注册', () => {
    const manifest = loadEvalManifest()
    const registry = createV2FullRegistry()
    const allIds = manifest.cases.flatMap((c) => c.graders)
    const check = registry.validateManifestGraders(allIds)
    assert.deepEqual(check.missing, [], `存在未注册判分器：${check.missing.join(', ')}`)
    assert.equal(check.ok, true)
  })

  test('P0-2：向全部 66 个 L1/L2/L3 判分器喂空 { payload: {} }，通过数必须为 0/66', () => {
    const registry = createV2FullRegistry()
    const passedIds: string[] = []
    for (const id of registry.listIds()) {
      const out = registry.evaluateCase(
        mkCase(`EMPTY-${id}`, 'P2_ScreeningThreeState', [id], { evalPoint: 'P2_ScreeningThreeState', stageLabel: 'EMPTY', payload: {} }),
      )
      if (out.passed) passedIds.push(id)
    }
    assert.deepEqual(passedIds, [], `以下判分器在空 payload 下违规 PASS：${passedIds.join(', ')}`)
  })

  test('P1-3：红队变体绕过全部被拦截（换措辞空指针/命令式/变相建议/水文复读/L3 未校准）', () => {
    const reg = createV2FullRegistry()

    // 换措辞空指针
    for (const q of ['详见简历第一部分', '如简历所述', '见原文第二段']) {
      const r = reg.evaluateCase(mkCase('RT-PTR', 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
        evalPoint: 'P2_ScreeningThreeState', stageLabel: 'S7', payload: { matchedItems: [{ quote: q, sourceText: q }] },
      }))
      assert.equal(r.passed, false, `空指针未拦：${q}`)
    }

    // 换措辞命令式 & 情绪吐槽
    for (const cmd of ['建议面试官务必深挖并发细节', '本轮一定要追问到底', '建议重点考察并发设计', '必须问清失败重试策略']) {
      const r = reg.evaluateCase(mkCase('RT-CMD', 'P3_LinearRoundHandoff', ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: cmd, payload: {},
      }))
      assert.equal(r.passed, false, `命令式未拦：${cmd}`)
    }

    // 变相录用/淘汰结论
    for (const dec of ['倾向不推进此人', '建议暂缓进入下一轮', '这位候选人值得优先推进']) {
      const r = reg.evaluateCase(mkCase('RT-DEC', 'P5_DecisionAndTrace', ['L1_no_auto_decision'], {
        evalPoint: 'P5_DecisionAndTrace', stageLabel: 'S10', answerText: dec, payload: {},
      }))
      assert.equal(r.passed, false, `变相结论未拦：${dec}`)
    }

    // 复读机水文
    const fluff = reg.evaluateCase(mkCase('RT-FLUFF', 'P6_ChatAndPersonTrajectory', ['L1_concise_30s_scan'], {
      evalPoint: 'P6_ChatAndPersonTrajectory', stageLabel: 'CHAT', answerText: '候选人有相关经验。'.repeat(8), payload: {},
    }))
    assert.equal(fluff.passed, false)
    assert.equal(fluff.firstFailureCode, 'REPETITIVE_FLUFF_TEXT')

    // L3 未校准必须 fail-closed
    const l3Uncal = reg.evaluateCase(mkCase('RT-L3', 'P4_TranscriptScorecard', ['L3_claim_faithfulness'], {
      evalPoint: 'P4_TranscriptScorecard', stageLabel: 'S9',
      payload: { l3Judgments: { L3_claim_faithfulness: { graderId: 'L3_claim_faithfulness', judgeVersion: 'v1', calibrationStatus: 'OBSERVATION_ONLY', verdict: 'pass', positionSwapConsistent: true, citedSourceQuote: '负责网关重构' } } },
    }))
    assert.equal(l3Uncal.passed, false)
    assert.equal(l3Uncal.firstFailureCode, 'L3_UNCALIBRATED')
  })

  test('P1-4 / P1-5 / P2-1：非标 PDF 检出 + L3 强制位置互换 + 零样本 passRate=null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-inv-rt-'))
    try {
      const raw = join(dir, 'raw')
      mkdirSync(raw, { recursive: true })
      writeFileSync(join(raw, 'badbytes.pdf'), 'NOT-A-PDF-GARBAGE', 'latin1')
      writeFileSync(join(raw, 'encrypted.pdf'), '%PDF-1.7\n/Encrypt 1 0 R\n/Type /Page\n/Font /F1\n%%EOF', 'latin1')
      writeFileSync(join(raw, 'font-late.pdf'), '%PDF-1.4\n/Type /Page\n/Subtype /Image\n' + 'A'.repeat(600 * 1024) + '\n/Font /F1\n%%EOF', 'latin1')
      const inv = scanPrivateCorpusInventory(dir)
      const byName = Object.fromEntries(inv.files.map((f) => [f.relativePath, f]))
      assert.equal(byName['badbytes.pdf'].corruptedPdf, true)
      assert.equal(byName['badbytes.pdf'].suggestedTier, 'tier_a_layout_hell')
      assert.equal(byName['encrypted.pdf'].encryptedPdf, true)
      assert.equal(byName['encrypted.pdf'].suggestedTier, 'tier_a_layout_hell')
      assert.equal(byName['font-late.pdf'].likelyScannedPdf, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    // L3 缺位置互换必须 OBSERVATION_ONLY
    const noSwap = evaluateL3JudgeCalibration('v1', [
      ...Array.from({ length: 10 }, (_, i) => ({ sampleId: `p${i}`, humanPass: true, judgePass: true })),
      ...Array.from({ length: 10 }, (_, i) => ({ sampleId: `n${i}`, humanPass: false, judgePass: false })),
    ])
    assert.equal(noSwap.status, 'OBSERVATION_ONLY')

    // 零样本 Evaluation Card passRate 必须为 null，不报 100%
    const emptyCard = buildEvaluationCard({ runId: 'empty', outcomes: [] })
    assert.equal(emptyCard.byEvalPoint.P1_ParseUnderstand.passRate, null)
    assert.ok(formatEvaluationCardMarkdown(emptyCard).includes('NO_DATA'))
  })

  test('G0 契约冒烟与 ALL 43 例缺真实适配器诚实失败验证', () => {
    const g0 = runG0DeterministicSuite({ runId: 'g0-smoke' })
    assert.equal(g0.card.executionMode, 'contract_smoke')
    assert.equal(g0.outcomes.length, 11)
    assert.equal(g0.card.byMinGate.G0.passed, 11)

    // 不传真实适配器跑 ALL 43 例时，32 条非 G0 用例必须诚实 FAIL（缺输入绝不假绿）
    const all = runEvalGateSuite({ gate: 'ALL', runId: 'all-honest-baseline' })
    assert.equal(all.outcomes.length, 43)
    assert.equal(all.card.byMinGate.G1.passed, 0)
    assert.equal(all.card.byMinGate.G2.passed, 0)
  })

  // === Issue #92 P1-A 追加：14 个新红队变体必须全拦 + 合法对照不过度拦截（只追加，不改弱既有断言） ===
  test('P1-A：14 个新红队变体全 FAIL（语义不变量版）', () => {
    const reg = createV2FullRegistry()
    const l1Pointer = ['详见简历第三章', '参考附件相关内容']
    for (const q of l1Pointer) {
      const r = reg.evaluateCase(mkCase('P1A-PTR', 'P2_ScreeningThreeState', ['L1_min_verbatim_substring_anchor'], {
        evalPoint: 'P2_ScreeningThreeState', stageLabel: 'S7', payload: { matchedItems: [{ quote: q, sourceText: `原文：${q}` }] },
      }))
      assert.equal(r.passed, false, `F1 新变体未拦：${q}`)
      assert.equal(r.firstFailureCode, 'EMPTY_POINTER_CITATION')
    }
    const l2Command = ['请重点考察系统设计能力', '面试时强制验证每一段经历', '建议按顺序逐一核实项目细节']
    for (const txt of l2Command) {
      const r = reg.evaluateCase(mkCase('P1A-CMD', 'P3_LinearRoundHandoff', ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: {},
      }))
      assert.equal(r.passed, false, `F2 命令新变体未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'COMMAND_TONE_DETECTED')
    }
    const l2Emotion = ['候选人气场不足，疑似包装', '感觉不太靠谱', '主观印象偏差', '候选人气场一般，印象不算好。']
    for (const txt of l2Emotion) {
      const r = reg.evaluateCase(mkCase('P1A-EMO', 'P3_LinearRoundHandoff', ['L2_cross_round_anchor_isolated'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: { priorScoreLeaked: false },
      }))
      assert.equal(r.passed, false, `F2 情绪新变体未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'CROSS_ROUND_ANCHOR_LEAK')
    }
    const l1Decision = ['综合判断不合适', '按当前表现应淘汰', '此人可以进入下一轮', '更推荐另一位候选人', '我的判断是不建议继续', '结论：推进到下一轮。']
    for (const txt of l1Decision) {
      const r = reg.evaluateCase(mkCase('P1A-DEC', 'P5_DecisionAndTrace', ['L1_no_auto_decision'], {
        evalPoint: 'P5_DecisionAndTrace', stageLabel: 'S10', answerText: txt, payload: {},
      }))
      assert.equal(r.passed, false, `F3 新变体未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'AUTO_DECISION_OUTPUT')
    }
    const fluff = Array.from({ length: 8 }, (_, i) => `候选人第${i}项能力与岗位有一定相关性。`).join('')
    const r4 = reg.evaluateCase(mkCase('P1A-FLUFF', 'P6_ChatAndPersonTrajectory', ['L1_concise_30s_scan'], {
      evalPoint: 'P6_ChatAndPersonTrajectory', stageLabel: 'CHAT', answerText: fluff, payload: {},
    }))
    assert.equal(r4.passed, false, 'F4 模板水文新变体未拦')
    assert.equal(r4.firstFailureCode, 'REPETITIVE_FLUFF_TEXT')
  })

  test('P1-A：合法对照文本 PASS（证明语义规则不是 catch-all）', () => {
    const reg = createV2FullRegistry()
    const controls = [
      ['L1_min_verbatim_substring_anchor', '负责网关重构与限流策略'],
      ['L1_min_verbatim_substring_anchor', '主导订单系统重构'],
      ['L1_no_auto_decision', '这是建议，不是决定，最终由您决定'],
      ['L1_no_auto_decision', '可重点了解系统设计能力，原因是岗标要求该维度'],
      // lead 独立复核 A2：介词性「通过」不是结果谓词
      ['L1_no_auto_decision', '候选人可以通过项目经历佐证系统设计能力。'],
      ['L1_concise_30s_scan', '候选人有 5 年后端经验，负责网关重构与限流。项目使用 Go 与 Redis，QPS 达到 3 万。沟通风格偏简洁，需现场确认协作方式。岗标中系统设计维度尚未覆盖，可重点了解。'],
      ['L2_reference_not_command', '可以了解系统设计能力与项目细节，原因是岗标要求该维度'],
      ['L2_reference_not_command', '建议了解候选人在高并发场景的实际贡献'],
      // lead 独立复核 A4：已发生事实小句中的「逐一核实」不构成命令
      ['L2_reference_not_command', '前轮已逐一核实工作经历，本轮可以了解系统设计。'],
      ['L2_cross_round_anchor_isolated', '上一轮讨论了系统设计，候选人描述了网关重构方案，岗标中并发与可观测性维度尚未覆盖'],
      ['L2_cross_round_anchor_isolated', '候选人负责订单系统，使用 Go 与 Redis，QPS 达到 3 万'],
    ] as const
    for (const [grader, txt] of controls) {
      const r = reg.evaluateCase(mkCase('P1A-CTRL', 'P3_LinearRoundHandoff', [grader], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: { matchedItems: [{ quote: txt, sourceText: txt }], priorScoreLeaked: false },
      }))
      assert.equal(r.passed, true, `合法对照被误杀：${grader} / ${txt}（${r.firstFailureCode ?? ''}）`)
    }
  })
})
