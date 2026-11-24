// Eval V2 CLI 整机接线单测：验证 --runs=3 (pass^3)、--check-data (Tier 1/2 语料巡检) 与 --l3 (L3 裁判 fail-closed 接通)。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'run-eval-v2.mjs')

describe('Eval V2 CLI 整机接线（--runs=3 pass^k + --check-data + --l3）', () => {
  test('contract 模式跑 --runs=3 --check-data --l3 正确产出四份产物且未配模型时 L3 fail-closed', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'ra-eval-v2-cli-'))
    try {
      const res = spawnSync(
        process.execPath,
        [CLI, '--mode=contract', '--gate=G0', '--runs=3', '--check-data', '--l3', `--out=${outDir}`],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            RECRUITMENT_EVAL_MODEL_PROVIDER: '',
            RECRUITMENT_EVAL_MODEL: '',
          },
        },
      )
      assert.equal(res.status, 0, `CLI failed: ${res.stderr}`)
      assert.ok(existsSync(join(outDir, 'evaluation-card.json')))
      assert.ok(existsSync(join(outDir, 'pass-power-k.json')))
      assert.ok(existsSync(join(outDir, 'data-readiness.json')))
      assert.ok(existsSync(join(outDir, 'l3-report.json')))

      const passK = JSON.parse(readFileSync(join(outDir, 'pass-power-k.json'), 'utf8'))
      assert.equal(passK.k, 3)
      assert.equal(passK.totalCases, 11)
      assert.equal(passK.flakyCaseIds.length, 0)

      const readiness = JSON.parse(readFileSync(join(outDir, 'data-readiness.json'), 'utf8'))
      assert.ok(['READY', 'CORPUS_ROOT_MISSING', 'CORPUS_EMPTY'].includes(readiness.corpus.status))
      assert.ok(readiness.benchmarks.jobresqa)

      const l3 = JSON.parse(readFileSync(join(outDir, 'l3-report.json'), 'utf8'))
      assert.equal(l3.status, 'L3_MODEL_NOT_CONFIGURED')
      assert.equal(l3.executed, 0)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
