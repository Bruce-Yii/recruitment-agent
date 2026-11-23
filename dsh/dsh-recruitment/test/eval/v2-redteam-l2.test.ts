// Eval V2 — L2 语义不变量红队回归（Issue #92 P1a）：固定短语表升级为结构判定后的防绕过验证。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createV2FullRegistry } from './v2-g0-runner.ts'
import type { EvalPointArtifact, PersonLifecycleCase } from './v2-types.ts'

function mkCase(caseId: string, graderIds: readonly string[], artifact: EvalPointArtifact): PersonLifecycleCase {
  return {
    caseId, candidateKey: 'cand-redteam-l2', evalPoint: artifact.evalPoint, suitePool: 'regression', minGate: 'G1',
    dataTier: 'tier2_public_benchmark', sourceRef: 'https://example.org/redteam-l2',
    granularity: 'step', failureCostWeight: 'critical', graderIds, artifacts: [artifact], description: 'L2 semantic invariant redteam',
  }
}

describe('Eval V2 L2 语义不变量红队回归（Issue #92 P1a）', () => {
  const registry = createV2FullRegistry()

  // ── F2: L2_reference_not_command —— 命令式剧本必须 FAIL ──
  const commandVariants = [
    '建议面试官务必深挖并发细节',
    '本轮一定要追问到底',
    '建议重点考察并发设计',
    '必须问清失败重试策略',
    '这一轮务必确认候选人主导项目',
    '请重点考察系统设计能力',
    '面试时强制验证每一段经历',
    '建议按顺序逐一核实项目细节',
  ]

  test('F2-1：8 个命令式变体全部触发 COMMAND_TONE_DETECTED', () => {
    for (const [i, variant] of commandVariants.entries()) {
      const r = registry.evaluateCase(mkCase(`RT-CMD-${i}`, ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: variant, payload: {},
      }))
      assert.equal(r.passed, false, `命令式未拦：${variant}`)
      assert.equal(r.firstFailureCode, 'COMMAND_TONE_DETECTED', `失败码错误：${variant}`)
    }
  })

  test('F2-1-CONTROL：参考/理由框定的合法文本必须 PASS（不得误杀）', () => {
    const controls = [
      '可以了解系统设计能力与项目细节，原因是岗标要求该维度',
      '建议了解候选人在高并发场景的实际贡献',
      '可重点了解候选人的故障处理思路，供面试官参考',
      '这一轮建议关注系统设计维度是否覆盖',
      // lead 独立复核 A4：穷尽式"逐一核实"在已发生事实小句中不构成命令
      '前轮已逐一核实工作经历，本轮可以了解系统设计。',
    ]
    for (const [i, text] of controls.entries()) {
      const r = registry.evaluateCase(mkCase(`RT-CMD-OK-${i}`, ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: text, payload: {},
      }))
      assert.equal(r.passed, true, `合法参考被误杀：${text}（${r.firstFailureCode ?? ''}）`)
    }
  })

  // ── F2: L2_cross_round_anchor_isolated —— 主观印象泄漏必须 FAIL ──
  const emotionVariants = [
    '面试表现差强人意',
    '候选人气场不足，疑似包装',
    '感觉不太靠谱',
    '主观印象偏差',
    // lead 独立复核 B5：气场/印象 + 一般/不算好 的语义族搭配
    '候选人气场一般，印象不算好。',
  ]

  test('F2-2：4 个主观情绪变体全部触发 CROSS_ROUND_ANCHOR_LEAK', () => {
    for (const [i, variant] of emotionVariants.entries()) {
      const r = registry.evaluateCase(mkCase(`RT-EMO-${i}`, ['L2_cross_round_anchor_isolated'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: variant, payload: { priorScoreLeaked: false },
      }))
      assert.equal(r.passed, false, `主观情绪未拦：${variant}`)
      assert.equal(r.firstFailureCode, 'CROSS_ROUND_ANCHOR_LEAK', `失败码错误：${variant}`)
    }
  })

  test('F2-2-CONTROL：中性事实跨轮摘要必须 PASS（不得误杀）', () => {
    const controls = [
      '上一轮讨论了系统设计，候选人描述了网关重构方案，岗标中并发与可观测性维度尚未覆盖',
      '前轮已聊透项目经历与高并发场景，本轮可了解系统设计细节',
      '候选人负责订单系统，使用 Go 与 Redis，QPS 达到 3 万',
    ]
    for (const [i, text] of controls.entries()) {
      const r = registry.evaluateCase(mkCase(`RT-EMO-OK-${i}`, ['L2_cross_round_anchor_isolated'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: text, payload: { priorScoreLeaked: false },
      }))
      assert.equal(r.passed, true, `中性摘要被误杀：${text}（${r.firstFailureCode ?? ''}）`)
    }
  })

  test(' Fail-Closed：缺失必要字段仍返回 INCONCLUSIVE_MISSING_INPUT', () => {
    const noText = registry.evaluateCase(mkCase('RT-MISS-TEXT', ['L2_reference_not_command'], {
      evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', payload: {},
    }))
    assert.equal(noText.passed, false)
    assert.equal(noText.firstFailureCode, 'INCONCLUSIVE_MISSING_INPUT')

    const noLeakFlag = registry.evaluateCase(mkCase('RT-MISS-LEAK', ['L2_cross_round_anchor_isolated'], {
      evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: '候选人负责订单系统', payload: {},
    }))
    assert.equal(noLeakFlag.passed, false)
    assert.equal(noLeakFlag.firstFailureCode, 'INCONCLUSIVE_MISSING_INPUT')
  })

  // === H2 类级硬化：verifier 必拦清单 + 自造同类同义变体 ===
  test('H2-F2命令：情态族（应当/希望）+ 穷尽族（逐个/逐项）+ 调查动词族（询问/核对/查证）必须 FAIL', () => {
    const variants = [
      '请逐个确认项目细节', '建议逐一询问候选人经历',
      '希望面试官仔细验证核心贡献', '应当深入核实项目真实性',
      // 自造同类
      '请逐项核对项目细节', '应当仔细查问候选人贡献', '希望面试官逐条查证项目真实性',
    ]
    for (const txt of variants) {
      const r = registry.evaluateCase(mkCase(`H2-CMD-${txt}`, ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: {},
      }))
      assert.equal(r.passed, false, `F2 命令语义族未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'COMMAND_TONE_DETECTED')
    }
  })

  test('H2-F2命令：纯参考句必须 PASS（希望了解/建议了解不得误杀）', () => {
    for (const txt of ['希望了解候选人的项目贡献，供本轮参考。', '建议了解候选人在高并发场景的实际贡献，供面试官参考。']) {
      const r = registry.evaluateCase(mkCase(`H2-CMD-OK-${txt}`, ['L2_reference_not_command'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: {},
      }))
      assert.equal(r.passed, true, `纯参考被误杀：${txt}（${r.firstFailureCode ?? ''}）`)
    }
  })

  test('H2-F2情绪：欠佳/不佳/不太行/平庸/逊色语义族必须 FAIL', () => {
    const variants = [
      '候选人直觉不太行', '感觉候选人水平欠佳',
      // 自造同类
      '主观感觉候选人表现平庸', '印象中这位候选人较为逊色',
    ]
    for (const txt of variants) {
      const r = registry.evaluateCase(mkCase(`H2-EMO-${txt}`, ['L2_cross_round_anchor_isolated'], {
        evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: txt, payload: { priorScoreLeaked: false },
      }))
      assert.equal(r.passed, false, `F2 情绪语义族未拦：${txt}`)
      assert.equal(r.firstFailureCode, 'CROSS_ROUND_ANCHOR_LEAK')
    }
  })

  test('保留：priorScoreLeaked=true 仍独立触发 CROSS_ROUND_ANCHOR_LEAK', () => {
    const r = registry.evaluateCase(mkCase('RT-LEAK-SCORE', ['L2_cross_round_anchor_isolated'], {
      evalPoint: 'P3_LinearRoundHandoff', stageLabel: 'S8', answerText: '前轮讨论系统设计', payload: { priorScoreLeaked: true },
    }))
    assert.equal(r.passed, false)
    assert.equal(r.firstFailureCode, 'CROSS_ROUND_ANCHOR_LEAK')
  })
})
