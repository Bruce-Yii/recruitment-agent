// Eval V2 Phase 3 — L3 裁判 Prompt 版本注册表单测（离线，不联网）。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  L3_JUDGE_PROMPT_REGISTRY_VERSION,
  buildL3JudgePrompt,
  getL3JudgePrompt,
  listL3JudgePrompts,
} from './v2-l3-prompts.ts'
import { V2_L3_GRADERS } from './v2-graders-l3.ts'

const EXPECTED_IDS = [
  'L3_fluff_detection',
  'L3_claim_faithfulness',
  'L3_numeric_grounding',
  'L3_speaker_attribution_exact',
  'L3_hallucination_rate',
  'L3_second_probe_collapse_caught',
  'L3_team_vs_individual_separated',
] as const

describe('Eval V2 Phase 3：L3 裁判 Prompt 版本注册表', () => {
  test('7 个 graderId 全覆盖且与 V2_L3_GRADERS 精确一致', () => {
    assert.match(L3_JUDGE_PROMPT_REGISTRY_VERSION, /^l3-prompts-v\d+$/)
    const ids = listL3JudgePrompts().map((p) => p.graderId)
    assert.deepEqual([...ids].sort(), [...EXPECTED_IDS].sort())
    assert.deepEqual([...ids].sort(), [...Object.keys(V2_L3_GRADERS)].sort())
    for (const id of EXPECTED_IDS) {
      const prompt = getL3JudgePrompt(id)
      assert.ok(prompt, `${id} 必须有注册 prompt`)
      assert.equal(prompt.graderId, id)
      assert.ok(prompt.judgeVersion.trim().length > 0)
      assert.ok(prompt.promptVersion.trim().length > 0)
      // docs/42 §5 铁律：先引原文、再 pass/fail、严禁外部常识脑补、不得替换原文。
      assert.match(prompt.criterionPrompt, /原文/)
      assert.match(prompt.criterionPrompt, /逐字/)
      assert.match(prompt.criterionPrompt, /pass|fail/)
      assert.match(prompt.criterionPrompt, /常识/)
      assert.match(prompt.criterionPrompt, /不得改写、替换/)
      assert.match(prompt.outputContract, /JSON/)
    }
  })

  test('promptSha256 是 64 位 hex 且与 criterionPrompt + "\\n" + outputContract 对应', () => {
    for (const prompt of listL3JudgePrompts()) {
      assert.match(prompt.promptSha256, /^[0-9a-f]{64}$/)
      const expected = createHash('sha256')
        .update(prompt.criterionPrompt + '\n' + prompt.outputContract, 'utf8')
        .digest('hex')
      assert.equal(prompt.promptSha256, expected)
    }
  })

  test('未知 graderId → null（fail-closed，不抛错）', () => {
    assert.equal(getL3JudgePrompt('L3_does_not_exist'), null)
    assert.equal(getL3JudgePrompt(''), null)
    assert.equal(getL3JudgePrompt('L3_fluff_detection_extra'), null)
  })

  test('buildL3JudgePrompt 包含准则、契约、原文与待评产物', () => {
    const source = '候选人表示自己主导了支付网关改造，耗时两个月。'
    const candidate = '候选人主导支付网关改造（耗时两个月）。'
    const prompt = buildL3JudgePrompt({
      graderId: 'L3_claim_faithfulness',
      sourceMaterial: source,
      candidateOutput: candidate,
    })
    const spec = getL3JudgePrompt('L3_claim_faithfulness')!
    assert.ok(prompt.includes(spec.criterionPrompt))
    assert.ok(prompt.includes(spec.outputContract))
    assert.ok(prompt.includes(source))
    assert.ok(prompt.includes(candidate))
    assert.ok(prompt.includes(spec.graderId))
    assert.ok(prompt.includes(spec.judgeVersion))
  })

  test('buildL3JudgePrompt 未知 graderId 直接抛错（绝不构造无准则 prompt）', () => {
    assert.throws(
      () => buildL3JudgePrompt({ graderId: 'unknown', sourceMaterial: '原文', candidateOutput: '产物' }),
      /未知的 L3 graderId/,
    )
  })
})
