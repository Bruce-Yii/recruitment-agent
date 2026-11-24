// Eval V2 CLI 整机接线单测：验证 --runs=3 (pass^3) 与 --check-data (Tier 1/2 语料巡检)。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'run-eval-v2.mjs')

describe('Eval V2 CLI 整机接线（--runs=3 pass^k + --check-data 语料巡检）', () => {
  test('contract 模式跑 --runs=3 --check-data 正确产出 evaluation-card / pass-power-k / data-readiness', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ra-eval-v2-cli-'))
    try {
      const res = spawnSync(
        process.execPath,
        [CLI, '--mode=contract', '--gate=G0', '--runs=3', '--check-data', `--out=${outDir}`],
        { encoding: 'utf8' },
      )
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`)
      assert.ok(existsSync(join(outDir, 'evaluation-card.json')))
      assert.ok(existsSync(join(outDir, 'pass-power-k.json')))
      assert.ok(existsSync(join(outDir, 'data-readiness.json')))

      const passK = JSON.parse(readFileSync(join(outDir, 'pass-power-k.json'), 'utf8'))
      assert.equal(passK.k, 3)
      assert.equal(passK.totalCases, 11)
      assert.equal(passK.flakyCaseIds.length, 0)

      const readiness = JSON.parse(readFileSync(join(outDir, 'data-readiness.json'), 'utf8'))
      assert.ok(['READY', 'CORPUS_ROOT_MISSING', 'CORPUS_EMPTY'].includes(readiness.corpus.status))
      assert.ok(readiness.benchmarks.jobresqa)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
