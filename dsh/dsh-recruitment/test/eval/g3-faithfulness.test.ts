// Issue #92 P1-C G3 忠实度护栏单测（纯函数 / 阈值，零 DB、零 LLM）。
//
// 口径 B（已拍板，不得更改）：
//   scorecard.items 每个维度对象 evidence[]（kind=SEGMENT，字段
//   transcript_artifact_id / transcript_revision / segment_id / quote），SQL 校验 quote
//   逐字出现在同 tenant 同 artifact 的 transcript_segment.content_text。
//   guardrailRate = 命中引用数 / 抽样引用总数；非 0 分母为数值；0 引用时 null + note 含
//   「暂无可抽样引用」；label/note 必须写「确定性引用锚定（非 L3 LLM 裁判）」；
//   命中率 < 0.8 → WATCH。
//
// 纪律：只 import 公开导出，绝不依赖 C1 未导出的私有函数（如 safeRate）。
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  buildDegradedG3Telemetry,
  buildG3PairedGuardrails,
  EMPTY_G3_COUNTS,
  type G3RawTelemetryCounts,
} from '../../src/domain/eval-telemetry.ts'

type Guardrail = {
  readonly id: string
  readonly label: string
  readonly primaryRate: number | null
  readonly guardrailRate: number | null
  readonly status: string
  readonly note: string
}

const FAITHFULNESS_ID = 'scorecard_completion_vs_faithfulness'

function faithfulness(counts: G3RawTelemetryCounts): Guardrail {
  const found = buildG3PairedGuardrails(counts).paired_guardrails.find((g) => g.id === FAITHFULNESS_ID)
  assert.ok(found !== undefined, `必须存在 ${FAITHFULNESS_ID} 护栏`)
  return found
}

/** 面评按时提交率 100%（8/8），使 submit 侧状态为 OK，单独观察引用锚定护栏。 */
function countsWithSample(sampled: number, matched: number): G3RawTelemetryCounts {
  return {
    ...EMPTY_G3_COUNTS,
    submittedScorecards: 8,
    pendingScorecards: 0,
    faithfulnessQuoteSampleCount: sampled,
    faithfulnessQuoteMatchedCount: matched,
  }
}

describe('G3 忠实度护栏（确定性引用锚定，非 L3 LLM 裁判）', () => {
  test('5/5 命中 → guardrailRate===1 且 status OK（提交率 OK）', () => {
    const g = faithfulness(countsWithSample(5, 5))
    assert.equal(g.primaryRate, 1)
    assert.equal(g.guardrailRate, 1)
    assert.equal(g.status, 'OK')
    assert.match(g.label, /确定性引用锚定/)
    assert.match(g.note, /确定性引用锚定|非 L3/)
  })

  test('4/5 命中 → guardrailRate===0.8 且 status OK（边界含等号）', () => {
    const g = faithfulness(countsWithSample(5, 4))
    assert.equal(g.guardrailRate, 0.8)
    assert.equal(g.status, 'OK', '0.8 是阈值边界，含等号 → OK')
  })

  test('3/5 命中（0.6）→ status WATCH，note 含「确定性引用锚定」与「非 L3」或「人工复核」', () => {
    const g = faithfulness(countsWithSample(5, 3))
    assert.equal(g.guardrailRate, 0.6)
    assert.equal(g.status, 'WATCH')
    assert.match(g.note, /确定性引用锚定/)
    assert.match(g.note, /非 L3|人工复核/)
  })

  test('0/0 引用 → guardrailRate===null 且 note 含「暂无可抽样引用」（不得为 0 或 1）', () => {
    const g = faithfulness(countsWithSample(0, 0))
    assert.equal(g.guardrailRate, null)
    assert.notEqual(g.guardrailRate, 0)
    assert.notEqual(g.guardrailRate, 1)
    assert.match(g.note, /暂无可抽样引用/)
    assert.match(g.note, /确定性引用锚定/)
  })

  test('0 引用但面评有提交 → primaryRate 非 null、guardrailRate null', () => {
    const g = faithfulness({
      ...EMPTY_G3_COUNTS,
      submittedScorecards: 8,
      pendingScorecards: 2, // 8/10 → 0.8
    })
    assert.equal(g.primaryRate, 0.8)
    assert.notEqual(g.primaryRate, null)
    assert.equal(g.guardrailRate, null)
  })

  test('提交率 0.2 + 0 引用 → WATCH，note 同时写明两个原因（V5 看得见）', () => {
    const g = faithfulness({
      ...EMPTY_G3_COUNTS,
      submittedScorecards: 2,
      pendingScorecards: 8, // 2/10 → primaryRate 0.2 < 0.8
      // 引用 0/0 → guardrailRate=null
    })
    assert.equal(g.primaryRate, 0.2)
    assert.equal(g.guardrailRate, null)
    assert.equal(g.status, 'WATCH')
    assert.match(g.note, /待交面评/)
    assert.match(g.note, /暂无可抽样引用/)
  })

  test('非 0 分母的命中率是数值（不是字符串/null），且按 4 位小数四舍五入', () => {
    const g = faithfulness(countsWithSample(3, 2))
    assert.equal(typeof g.guardrailRate, 'number')
    assert.equal(g.guardrailRate, Number((2 / 3).toFixed(4)))
  })

  test('degraded → 恰好 3/3 ERROR，无盲审假护栏 id', () => {
    const snap = buildDegradedG3Telemetry()
    assert.equal(snap.degraded, true)
    assert.equal(snap.error_code, 'TELEMETRY_QUERY_FAILED')
    assert.equal(snap.paired_guardrails.length, 3)
    assert.ok(snap.paired_guardrails.every((g) => g.status === 'ERROR'))
    assert.deepEqual(
      snap.paired_guardrails.map((g) => g.id).sort(),
      [FAITHFULNESS_ID, 'decision_vs_undo', 'funnel_speed_vs_rework'].sort(),
    )
    assert.ok(snap.paired_guardrails.every((g) => g.id !== 'override_vs_blind_audit'))
  })
})
