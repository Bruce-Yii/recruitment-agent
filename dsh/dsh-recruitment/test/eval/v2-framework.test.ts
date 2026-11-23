// Issue #63 Phase 1 — Eval V2 框架底座单测（GraderRegistry / EvaluationCard / CorpusInventory / BenchmarkLoader）。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { loadCachedBenchmark } from './benchmark-loader.ts'
import { scanPrivateCorpusInventory } from './corpus-inventory.ts'
import { buildEvaluationCard, formatEvaluationCardMarkdown } from './evaluation-card.ts'
import { GraderRegistry, MissingGraderError } from './grader-registry.ts'
import type { CaseRunOutcome, PersonLifecycleCase } from './v2-types.ts'

describe('Eval V2 Phase 1 框架底座（Issue #63）', () => {
  test('GraderRegistry：注册执行 + 首个折损归因 + 缺判分器必抛 MissingGraderError', () => {
    const registry = new GraderRegistry()
    registry.register('L1_ok', () => ({ ok: true, code: 'OK', message: 'pass' }))
    registry.register('L1_fail_anchor', () => ({ ok: false, code: 'EMPTY_POINTER', message: '缺少原文子串' }))

    const sampleCase: PersonLifecycleCase = {
      caseId: 'P2-08',
      candidateKey: 'cand-001',
      evalPoint: 'P2_ScreeningThreeState',
      suitePool: 'regression',
      minGate: 'G1',
      dataTier: 'tier2_public_benchmark',
      sourceRef: 'https://aclanthology.org/2026.emnlp-main.549.pdf',
      granularity: 'step',
      failureCostWeight: 'critical',
      graderIds: ['L1_ok', 'L1_fail_anchor'],
      artifacts: [{ evalPoint: 'P2_ScreeningThreeState', stageLabel: 'S7', payload: {} }],
      description: '测试首个折损归因',
    }

    const out = registry.evaluateCase(sampleCase)
    assert.equal(out.passed, false)
    assert.equal(out.firstFailureCode, 'EMPTY_POINTER')

    const missingCase: PersonLifecycleCase = { ...sampleCase, graderIds: ['L1_unregistered'] }
    assert.throws(() => registry.evaluateCase(missingCase), MissingGraderError)

    const check = registry.validateManifestGraders(['L1_ok', 'L1_missing_x'])
    assert.equal(check.ok, false)
    assert.deepEqual(check.missing, ['L1_missing_x'])
  })

  test('EvaluationCard：按 Tier/P1–P6/Gate 分账 + 反向压制超限拦截 + 基线 Diff', () => {
    const prevOutcomes: readonly CaseRunOutcome[] = [
      {
        caseId: 'P1-01',
        evalPoint: 'P1_ParseUnderstand',
        suitePool: 'regression',
        minGate: 'G0',
        dataTier: 'tier1_private_corpus',
        granularity: 'step',
        failureCostWeight: 'high',
        passed: true,
        grades: [{ ok: true, code: 'OK', message: 'ok' }],
      },
      {
        caseId: 'P2-08',
        evalPoint: 'P2_ScreeningThreeState',
        suitePool: 'regression',
        minGate: 'G1',
        dataTier: 'tier2_public_benchmark',
        granularity: 'step',
        failureCostWeight: 'critical',
        passed: false,
        grades: [{ ok: false, code: 'INFLATION', message: '读不出来膨胀' }],
        firstFailureCode: 'INFLATION',
        firstFailureMessage: '读不出来膨胀',
      },
    ]

    const baseline = buildEvaluationCard({ runId: 'run-base', outcomes: prevOutcomes })

    const currOutcomes: readonly CaseRunOutcome[] = [
      {
        ...prevOutcomes[0],
        passed: false,
        firstFailureCode: 'READ_ORDER',
        firstFailureMessage: '双栏串行',
      },
      {
        ...prevOutcomes[1],
        passed: true,
        firstFailureCode: undefined,
        firstFailureMessage: undefined,
      },
    ]

    const card = buildEvaluationCard({
      runId: 'run-curr',
      outcomes: currOutcomes,
      baseline,
      counterMetrics: {
        clearTextUnreadableRate: 0.08,
        ttftMsP95: 3500,
        maxS7ItemChars: 95,
        emptyPointerCitations: 2,
      },
    })

    assert.equal(card.byEvalPoint.P1_ParseUnderstand.passed, 0)
    assert.equal(card.byEvalPoint.P2_ScreeningThreeState.passed, 1)
    assert.equal(card.byMinGate.G0.failed, 1)
    assert.equal(card.counterMetricsOk, false)
    assert.equal(card.counterMetricBreaches.length, 4)
    assert.deepEqual(card.baselineDiff?.newlyRegressedCaseIds, ['P1-01'])
    assert.deepEqual(card.baselineDiff?.newlyFixedCaseIds, ['P2-08'])

    const md = formatEvaluationCardMarkdown(card)
    assert.ok(md.includes('Evaluation Card (run-curr)'))
    assert.ok(md.includes('Counter-Metric Breaches'))
  })

  test('CorpusInventory：缺目录返回 CORPUS_ROOT_MISSING，真目录正确盘点扫描 PDF 与分级', () => {
    const missing = scanPrivateCorpusInventory(join(tmpdir(), 'non-existent-recruitment-corpus-xyz'))
    assert.equal(missing.status, 'CORPUS_ROOT_MISSING')

    const dir = mkdtempSync(join(tmpdir(), 'rc-corpus-inv-'))
    try {
      const empty = scanPrivateCorpusInventory(dir)
      assert.equal(empty.status, 'CORPUS_EMPTY')

      const rawDir = join(dir, 'raw')
      mkdirSync(rawDir, { recursive: true })
      writeFileSync(join(rawDir, 'scanned.pdf'), '%PDF-1.4\n/Type /Page\n/Subtype /Image\n%%EOF', 'latin1')
      writeFileSync(join(rawDir, 'clean.pdf'), '%PDF-1.4\n/Type /Page\n/Font /F1\n%%EOF', 'latin1')
      writeFileSync(join(rawDir, 'resume.docx'), 'PK-docx-stub', 'utf8')

      const res = scanPrivateCorpusInventory(dir)
      assert.equal(res.status, 'READY')
      assert.equal(res.totalFiles, 3)
      assert.equal(res.likelyScannedCount, 1)
      assert.equal(res.suggestedCounts.tier_a_layout_hell, 1)
      assert.equal(res.suggestedCounts.tier_b_borderline, 2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('BenchmarkLoader：缺缓存诚实报 CACHE_MISSING，存在时校验 SHA-256 并返回 READY', () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'rc-bench-cache-'))
    try {
      const missing = loadCachedBenchmark('jobresqa', { cacheRoot: cacheDir })
      assert.equal(missing.status, 'CACHE_MISSING')

      const target = join(cacheDir, 'jobresqa')
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, 'sample.jsonl'), '{"q":"test"}\n', 'utf8')

      const ready = loadCachedBenchmark('jobresqa', { cacheRoot: cacheDir })
      assert.equal(ready.status, 'READY')
      if (ready.status !== 'READY') throw new Error('unreachable')
      assert.equal(ready.fileCount, 1)

      const mismatch = loadCachedBenchmark('jobresqa', {
        cacheRoot: cacheDir,
        expectedSha256: '0'.repeat(64),
      })
      assert.equal(mismatch.status, 'CHECKSUM_MISMATCH')
    } finally {
      rmSync(cacheDir, { recursive: true, force: true })
    }
  })
})
