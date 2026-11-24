// Eval V2 — 模型无关 L3 主观裁判执行器单测（含与 V2_L3_GRADERS 闭环验证）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { createV2FullRegistry } from './v2-g0-runner.ts'
import { runL3AtomicJudge } from './v2-l3-runner.ts'
import type { PersonLifecycleCase } from './v2-types.ts'

describe('Eval V2：模型无关 L3 裁判执行器与 A/B 位置互换闭环', () => {
  test('未配置运行时模型时诚实返回 L3_MODEL_NOT_CONFIGURED（绝不伪造判决）', async () => {
    const res = await runL3AtomicJudge(
      {
        graderId: 'L3_claim_faithfulness',
        judgeVersion: 'l3-v1',
        calibrationStatus: 'GATE_ELIGIBLE',
        criterionPrompt: '检查面评草稿是否忠实于转写原文',
        sourceMaterial: '候选人表示自己主导了支付网关改造，耗时两个月。',
        candidateOutput: '候选人主导支付网关改造（耗时两个月）。',
      },
      { env: {} },
    )
    assert.equal(res.status, 'L3_MODEL_NOT_CONFIGURED')
  })

  test('A/B 位置互换一致 + 原文逐字锚定 → 通过 V2_L3_GRADERS；位置翻脸 → 拦截 L3_POSITION_BIAS', async () => {
    const reg = createV2FullRegistry()
    const baseInput = {
      graderId: 'L3_claim_faithfulness',
      judgeVersion: 'l3-v1',
      calibrationStatus: 'GATE_ELIGIBLE' as const,
      criterionPrompt: '检查面评草稿是否忠实于转写原文',
      sourceMaterial: '候选人表示自己主导了支付网关改造，耗时两个月。',
      candidateOutput: '候选人主导支付网关改造（耗时两个月）。',
    }

    const okRun = await runL3AtomicJudge(baseInput, {
      invoker: async () => ({ verdict: 'pass', citedSourceQuote: '主导了支付网关改造', rationale: '事实一致' }),
    })
    assert.equal(okRun.status, 'OK')
    if (okRun.status !== 'OK') throw new Error('unreachable')

    const c: PersonLifecycleCase = {
      caseId: 'P4-01', candidateKey: 'c1', evalPoint: 'P4_TranscriptScorecard',
      suitePool: 'regression', minGate: 'G1', dataTier: 'tier2_public_benchmark',
      sourceRef: 'https://www.openslr.org/119/', granularity: 'step', failureCostWeight: 'critical',
      graderIds: ['L3_claim_faithfulness'],
      artifacts: [{ evalPoint: 'P4_TranscriptScorecard', stageLabel: 'S9', payload: { l3Judgments: { L3_claim_faithfulness: okRun.judgment } } }],
      description: 'l3 ok',
    }
    assert.equal(reg.evaluateCase(c).passed, true)

    // 反例：位置互换后结论翻转
    let call = 0
    const flipRun = await runL3AtomicJudge(baseInput, {
      invoker: async () => {
        call += 1
        return { verdict: call === 1 ? 'pass' : 'fail', citedSourceQuote: '主导了支付网关改造', rationale: '位置漂移' }
      },
    })
    assert.equal(flipRun.status, 'OK')
    if (flipRun.status !== 'OK') throw new Error('unreachable')
    assert.equal(flipRun.judgment.positionSwapConsistent, false)
    const badRes = reg.evaluateCase({ ...c, artifacts: [{ evalPoint: 'P4_TranscriptScorecard', stageLabel: 'S9', payload: { l3Judgments: { L3_claim_faithfulness: flipRun.judgment } } }] })
    assert.equal(badRes.passed, false)
    assert.equal(badRes.firstFailureCode, 'L3_POSITION_BIAS')
  })
})
