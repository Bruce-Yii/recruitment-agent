// Eval V2 Phase 3 — Tier B L3 校准集与校准运行器离线单测（不访问网络/模型）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  L3_CALIBRATION_GRADER_IDS,
  L3_CALIBRATION_SAMPLES,
  L3_CALIBRATION_SOURCE_ANCHOR,
} from './v2-l3-calibration-data.ts'
import { runL3Calibration } from './v2-l3-calibrate-lib.ts'
import type { L3ModelInvoker } from './v2-l3-runner.ts'

/** 从 runL3AtomicJudge 拼出的 prompt 中解析样本编号（真实 invoker 不需要此约定）。 */
function sampleIdFromPrompt(prompt: string): string {
  return prompt.match(/材料编号：(CAL-\d+)/)?.[1] ?? ''
}

/** 按人标返回判决的假 invoker；引用短语逐字命中合成原文，满足原文锚定铁律。 */
function humanPassInvoker(): L3ModelInvoker {
  const expected = new Map(L3_CALIBRATION_SAMPLES.map((s) => [s.sampleId, s.humanPass]))
  return async (prompt) => {
    const id = sampleIdFromPrompt(prompt)
    const pass = expected.get(id) === true
    return {
      verdict: pass ? 'pass' : 'fail',
      citedSourceQuote: L3_CALIBRATION_SOURCE_ANCHOR,
      rationale: `fake judge for ${id}`,
    }
  }
}

describe('Eval V2 Phase 3：L3 Tier B 校准集数据纪律', () => {
  test('样本 ≥14、坏例占比 40%–60%、7 个 grader 全覆盖、无真实号码/邮箱', () => {
    const samples = L3_CALIBRATION_SAMPLES
    assert.ok(samples.length >= 14, `样本数 ${samples.length} < 14`)

    const negatives = samples.filter((s) => !s.humanPass)
    const ratio = negatives.length / samples.length
    assert.ok(ratio >= 0.4 && ratio <= 0.6, `坏例占比 ${ratio} 不在 40%–60%`)

    const ids = new Set(samples.map((s) => s.graderId))
    for (const graderId of L3_CALIBRATION_GRADER_IDS) {
      assert.ok(ids.has(graderId), `缺少 L3 grader 覆盖：${graderId}`)
    }
    assert.equal(ids.size, 7, '校准集应恰好覆盖 7 个 L3 维度')

    const sampleIds = samples.map((s) => s.sampleId)
    assert.equal(new Set(sampleIds).size, sampleIds.length, 'sampleId 必须唯一')

    const phoneRe = /(?<!\d)1[3-9]\d{9}(?!\d)/
    const emailRe = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/
    const longDigitRe = /\d{7,}/
    for (const s of samples) {
      const blob = `${s.sampleId}\n${s.graderId}\n${s.sourceMaterial}\n${s.candidateOutput}`
      assert.doesNotMatch(blob, phoneRe, `${s.sampleId} 含疑似真实手机号`)
      assert.doesNotMatch(blob, emailRe, `${s.sampleId} 含疑似邮箱`)
      assert.doesNotMatch(blob, longDigitRe, `${s.sampleId} 含长数字串`)
      assert.ok(s.sourceMaterial.includes(L3_CALIBRATION_SOURCE_ANCHOR), `${s.sampleId} 缺少原文锚定短语`)
      assert.ok(s.sourceMaterial.trim().length > 0 && s.candidateOutput.trim().length > 0)
      assert.ok(ids.has(s.graderId), `${s.sampleId} 的 graderId 不在 7 维集合内`)
    }
  })
})

describe('Eval V2 Phase 3：runL3Calibration 可注入校准运行器', () => {
  test('假 invoker 按人标判决 → GATE_ELIGIBLE / κ=1 / TNR=1 / 位置一致率=1', async () => {
    const progress: [number, number][] = []
    const result = await runL3Calibration({
      invoker: humanPassInvoker(),
      concurrency: 3,
      onProgress: (done, total) => progress.push([done, total]),
    })

    assert.equal(result.errors.length, 0)
    assert.equal(result.pairs.length, L3_CALIBRATION_SAMPLES.length)
    assert.equal(result.report.status, 'GATE_ELIGIBLE')
    assert.equal(result.report.cohensKappa, 1)
    assert.equal(result.report.tnr, 1)
    assert.equal(result.report.negativeRatio, 0.5)
    assert.equal(result.report.positionSwapConsistency, 1)
    assert.deepEqual(result.report.blockReasons, [])
    assert.ok(typeof result.promptRegistryVersion === 'string' && result.promptRegistryVersion.length > 0)
    assert.ok(result.pairs.every((p) => p.positionSwapConsistent === true))
    assert.deepEqual(progress.at(-1), [L3_CALIBRATION_SAMPLES.length, L3_CALIBRATION_SAMPLES.length])
  })

  test('假 invoker 全部判 pass → TNR=0 → OBSERVATION_ONLY，blockReasons 命中 TNR', async () => {
    const result = await runL3Calibration({
      invoker: async () => ({
        verdict: 'pass',
        citedSourceQuote: L3_CALIBRATION_SOURCE_ANCHOR,
        rationale: 'stub always-pass',
      }),
    })

    assert.equal(result.errors.length, 0)
    assert.equal(result.report.status, 'OBSERVATION_ONLY')
    assert.equal(result.report.tnr, 0)
    assert.equal(result.report.cohensKappa, 0)
    assert.ok(result.report.blockReasons.some((r) => r.includes('TNR')))
  })

  test('假 invoker 位置互换不一致 → OBSERVATION_ONLY，blockReasons 命中位置互换', async () => {
    let call = 0
    const result = await runL3Calibration({
      invoker: async () => {
        call += 1
        return {
          verdict: call % 2 === 1 ? 'pass' : 'fail',
          citedSourceQuote: L3_CALIBRATION_SOURCE_ANCHOR,
          rationale: 'stub position drift',
        }
      },
      concurrency: 1,
    })

    assert.equal(result.errors.length, 0)
    assert.equal(result.report.status, 'OBSERVATION_ONLY')
    assert.equal(result.report.positionSwapConsistency, 0)
    assert.ok(result.report.blockReasons.some((r) => r.includes('位置互换')))
    assert.ok(result.pairs.every((p) => p.judgePass === false))
  })

  test('invoker 抛错 → errors 非空且不崩溃，仍返回报告', async () => {
    const result = await runL3Calibration({
      invoker: async () => {
        throw new Error('stub network down')
      },
    })

    assert.equal(result.errors.length, L3_CALIBRATION_SAMPLES.length)
    assert.ok(result.errors.every((e) => e.code === 'L3_INVOKER_THREW'))
    assert.ok(result.errors.every((e) => e.message.includes('stub network down')))
    assert.equal(result.pairs.length, 0)
    assert.equal(result.report.status, 'OBSERVATION_ONLY')
    assert.ok(result.report.blockReasons.some((r) => r.includes('样本量不足')))
  })

  test('未知 graderId → fail-closed 记 L3_PROMPT_NOT_FOUND 并跳过该样本', async () => {
    const result = await runL3Calibration({
      invoker: humanPassInvoker(),
      samples: [
        ...L3_CALIBRATION_SAMPLES.slice(0, 2),
        { sampleId: 'CAL-BAD', graderId: 'L3_not_registered', sourceMaterial: '虚构合成材料，仅用于评测', candidateOutput: '任意', humanPass: true },
      ],
    })

    const err = result.errors.find((e) => e.sampleId === 'CAL-BAD')
    assert.ok(err !== undefined)
    assert.equal(err.code, 'L3_PROMPT_NOT_FOUND')
    assert.equal(result.pairs.length, 2)
  })
})
