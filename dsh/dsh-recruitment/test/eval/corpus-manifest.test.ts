// Product-Wide Funnel Eval Corpus Manifest Guard (docs/42 §0 & §9.4)
// Enforces the Anti-Self-Eval Rule in CI:
// 1. All 6 product funnel stages + cross-cutting chat layer must be covered (>= 60 cases).
// 2. Every single case must carry a valid data_tier and traceable source_ref (zero unsourced toys).
// 3. Every stage must have both step-level and handoff/funnel-level coverage.
// 4. Zero forbidden terminology in descriptions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFEST_PATH = join(HERE, 'corpus-manifest.json')

interface EvalCorpusCase {
  readonly case_id: string
  readonly stage: string
  readonly data_tier: 'tier1_private_corpus' | 'tier2_public_benchmark' | 'tier3_fault_injection'
  readonly source_ref: string
  readonly eval_granularity: 'step' | 'handoff' | 'funnel'
  readonly failure_cost_weight: 'critical' | 'high' | 'medium'
  readonly graders: readonly string[]
  readonly description: string
}

interface EvalCorpusManifest {
  readonly schema_version: string
  readonly authoritative_doc: string
  readonly total_cases: number
  readonly stages: readonly string[]
  readonly cases: readonly EvalCorpusCase[]
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as EvalCorpusManifest

describe('eval corpus-manifest 溯源与全漏斗覆盖门禁（docs/42 §0 / §9.4）', () => {
  test('总用例数 >= 60 且 case_id 全局唯一', () => {
    assert.equal(manifest.authoritative_doc, 'docs/42-product-funnel-eval-system.md')
    assert.equal(manifest.cases.length, manifest.total_cases)
    assert.ok(manifest.cases.length >= 60, `全链路评测集不得少于 60 例，当前 ${manifest.cases.length}`)
    const ids = new Set(manifest.cases.map((c) => c.case_id))
    assert.equal(ids.size, manifest.cases.length, '存在重复 case_id')
  })

  test('覆盖全部 6 大业务阶段 + 横切对话层，且每阶段均含 step 与 handoff/funnel 粒度', () => {
    const requiredStages = [
      'Stage1_IntakeParse',
      'Stage2_JobDedup',
      'Stage3_Screening',
      'Stage4_Scheduling',
      'Stage5_TranscriptScorecard',
      'Stage6_DecisionSync',
      'CrossCut_ChatCanvas',
    ]
    for (const stage of requiredStages) {
      const subset = manifest.cases.filter((c) => c.stage === stage)
      assert.ok(subset.length >= 8, `阶段 ${stage} 用例不足 8 条（当前 ${subset.length}）`)
      assert.ok(subset.some((c) => c.eval_granularity === 'step'), `阶段 ${stage} 缺少 step 级用例`)
      assert.ok(
        subset.some((c) => c.eval_granularity === 'handoff' || c.eval_granularity === 'funnel'),
        `阶段 ${stage} 缺少 handoff/funnel 级用例`,
      )
    }
  })

  test('反自嗨铁律：100% 用例具备合法 data_tier 与可溯源 source_ref', () => {
    for (const c of manifest.cases) {
      assert.ok(c.graders.length > 0, `${c.case_id} 缺少 graders`)
      if (c.data_tier === 'tier1_private_corpus') {
        assert.ok(
          c.source_ref.startsWith('RECRUITMENT_CORPUS_ROOT:'),
          `${c.case_id} Tier 1 必须指向 RECRUITMENT_CORPUS_ROOT`,
        )
      } else if (c.data_tier === 'tier2_public_benchmark') {
        assert.ok(
          c.source_ref.startsWith('https://'),
          `${c.case_id} Tier 2 必须带真实外部公开来源 HTTPS URL`,
        )
      } else if (c.data_tier === 'tier3_fault_injection') {
        assert.equal(
          c.source_ref,
          'docs/12-layer-acceptance.md',
          `${c.case_id} Tier 3 必须锚定 docs/12-layer-acceptance.md`,
        )
      } else {
        assert.fail(`${c.case_id} 非法 data_tier`)
      }
    }
  })

  test('按故障代价加权（critical/high >= 75%）且零禁用词', () => {
    const highCost = manifest.cases.filter(
      (c) => c.failure_cost_weight === 'critical' || c.failure_cost_weight === 'high',
    )
    assert.ok(
      highCost.length / manifest.cases.length >= 0.75,
      `高代价用例占比应 >= 75%，当前 ${highCost.length}/${manifest.cases.length}`,
    )
    for (const c of manifest.cases) {
      assert.ok(!c.description.includes('证据'), `${c.case_id} 描述含禁用词`)
    }
  })
})
