// Product-Aligned Eval Corpus Manifest V2 Guard (docs/42 V2 + docs/24)
// Enforces:
// 1. High-signal focused suite (30..50 cases) covering all 6 core AI/Product judgment points (P1-P6).
// 2. Person-centric full-lifecycle funnel cases present (granularity === 'funnel').
// 3. Anti-Self-Eval Rule: 100% traceable data_tier + source_ref; zero premature privacy/law-firm bloat.
// 4. Both regression and capability pools represented; zero forbidden word.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(HERE, 'corpus-manifest.json')

interface EvalCaseV2 {
  readonly case_id: string
  readonly eval_point: string
  readonly suite_pool: 'regression' | 'capability'
  readonly min_gate: 'G0' | 'G1' | 'G2'
  readonly data_tier: 'tier1_private_corpus' | 'tier2_public_benchmark' | 'tier3_fault_injection'
  readonly source_ref: string
  readonly eval_granularity: 'step' | 'handoff' | 'funnel'
  readonly failure_cost_weight: 'critical' | 'high' | 'medium'
  readonly graders: readonly string[]
  readonly description: string
}

interface EvalManifestV2 {
  readonly schema_version: string
  readonly authoritative_doc: string
  readonly product_spec_ref: string
  readonly total_cases: number
  readonly eval_points: readonly string[]
  readonly cases: readonly EvalCaseV2[]
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as EvalManifestV2

describe('eval corpus-manifest V2 产品对齐与反自嗨守卫（docs/42 V2 × docs/24）', () => {
  test('精简高信噪比规模（30..50 例）且 case_id 全局唯一', () => {
    assert.equal(manifest.authoritative_doc, 'docs/42-product-funnel-eval-system.md')
    assert.equal(manifest.product_spec_ref, 'docs/24-product-framework-v2.md')
    assert.equal(manifest.cases.length, manifest.total_cases)
    assert.ok(
      manifest.cases.length >= 30 && manifest.cases.length <= 50,
      `V2 精简集应在 30..50 例之间防稀释，当前 ${manifest.cases.length}`,
    )
    const ids = new Set(manifest.cases.map((c) => c.case_id))
    assert.equal(ids.size, manifest.cases.length, '存在重复 case_id')
  })

  test('覆盖全部 6 大核心 AI/产品判断点（P1–P6），含线性轮次接力（P3）与单人全周期贯通（funnel）', () => {
    const required = [
      'P1_ParseUnderstand',
      'P2_ScreeningThreeState',
      'P3_LinearRoundHandoff',
      'P4_TranscriptScorecard',
      'P5_DecisionAndTrace',
      'P6_ChatAndPersonTrajectory',
    ]
    for (const point of required) {
      const subset = manifest.cases.filter((c) => c.eval_point === point)
      assert.ok(subset.length >= 5, `判断点 ${point} 用例不足 5 条（当前 ${subset.length}）`)
    }
    const funnelCases = manifest.cases.filter((c) => c.eval_granularity === 'funnel')
    assert.ok(funnelCases.length >= 2, '至少应包含 2 条单人全周期贯通档案用例（funnel）')
    assert.ok(manifest.cases.some((c) => c.suite_pool === 'regression'), '缺少 regression 池用例')
    assert.ok(manifest.cases.some((c) => c.suite_pool === 'capability'), '缺少 capability 池用例')
    for (const gate of ['G0', 'G1', 'G2'] as const) {
      assert.ok(manifest.cases.some((c) => c.min_gate === gate), `缺少 ${gate} 门禁档位用例`)
    }
  })

  test('反自嗨铁律：100% 可溯源 source_ref 且零禁用词', () => {
    for (const c of manifest.cases) {
      assert.ok(c.graders.length > 0, `${c.case_id} 缺少 graders`)
      assert.ok(['G0', 'G1', 'G2'].includes(c.min_gate), `${c.case_id} 非法 min_gate: ${c.min_gate}`)
      assert.ok(!c.description.includes('证据'), `${c.case_id} 含禁用词`)
      if (c.data_tier === 'tier1_private_corpus') {
        assert.ok(c.source_ref.startsWith('RECRUITMENT_CORPUS_ROOT:'), `${c.case_id} Tier 1 须指向私有语料`)
      } else if (c.data_tier === 'tier2_public_benchmark') {
        assert.ok(c.source_ref.startsWith('https://'), `${c.case_id} Tier 2 须带真实 HTTPS 出处`)
      } else if (c.data_tier === 'tier3_fault_injection') {
        assert.equal(c.source_ref, 'docs/12-layer-acceptance.md', `${c.case_id} Tier 3 须锚定 docs/12`)
      } else {
        assert.fail(`${c.case_id} 非法 data_tier`)
      }
    }
  })
})
