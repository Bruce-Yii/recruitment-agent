#!/usr/bin/env node
// Eval V2 Phase 3 — Tier B L3 校准 CLI 薄封装。
//
//   node test/eval/v2-l3-calibrate.mjs [--out=<dir>] [--concurrency=<n>]
//
// 纪律：
//   - 未配置真实 L3 invoker 时 stderr FATAL + exit 2，绝不伪造判决或回退假 invoker；
//   - 报告落盘只包含 report / pairs / promptRegistryVersion / errors / generatedAt，
//     apiKey 与 session 绝不打印、绝不落盘；
//   - 退出码：GATE_ELIGIBLE=0；OBSERVATION_ONLY=4（有报告但未过门槛）；未配置=2；运行异常=1。
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runL3Calibration } from './v2-l3-calibrate-lib.ts'
import { createL3Invoker, readL3InvokerConfig } from './v2-l3-invoker.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(HERE, '..', '..', 'work', 'l3-calibration')

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, concurrency: 3 }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length)
    else if (arg === '--out') out.out = argv[++i]
    else if (arg.startsWith('--concurrency=')) out.concurrency = Number(arg.slice('--concurrency='.length))
    else if (arg === '--concurrency') out.concurrency = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node test/eval/v2-l3-calibrate.mjs [--out=<dir>] [--concurrency=<n>]')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (typeof out.out !== 'string' || out.out.trim() === '') throw new Error('--out must be a non-empty directory')
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) throw new Error('--concurrency must be a positive integer')
  out.concurrency = Math.floor(out.concurrency)
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  const cfg = readL3InvokerConfig()
  if (!cfg.configured || !cfg.config) {
    // 只打印 reason，不打印 config（其中可能含 apiKey/session）。
    console.error(`FATAL: L3_INVOKER_NOT_CONFIGURED: ${cfg.reason ?? 'no usable L3 invoker configuration found'}`)
    process.exit(2)
  }

  const invoker = createL3Invoker(cfg.config)
  const { report, pairs, promptRegistryVersion, errors } = await runL3Calibration({
    invoker,
    concurrency: args.concurrency,
  })

  const artifact = {
    report,
    pairs,
    promptRegistryVersion,
    errors,
    generatedAt: new Date().toISOString(),
  }
  const outDir = resolve(args.out)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(
    join(outDir, 'l3-calibration-report.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  )

  console.log(
    `[v2-l3-calibrate] status=${report.status} totalSamples=${report.totalSamples} `
      + `negativeRatio=${report.negativeRatio} kappa=${report.cohensKappa} tnr=${report.tnr} `
      + `positionSwapConsistency=${report.positionSwapConsistency ?? 'null'} `
      + `errors=${errors.length} promptRegistryVersion=${promptRegistryVersion}`,
  )
  for (const reason of report.blockReasons) console.log(`[v2-l3-calibrate] blockReason: ${reason}`)
  console.log(`[v2-l3-calibrate] report: ${join(outDir, 'l3-calibration-report.json')}`)

  process.exitCode = report.status === 'GATE_ELIGIBLE' ? 0 : 4
}

main().catch((error) => {
  console.error(`FATAL: L3_CALIBRATION_RUN_FAILED: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
