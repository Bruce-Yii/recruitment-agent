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
})
