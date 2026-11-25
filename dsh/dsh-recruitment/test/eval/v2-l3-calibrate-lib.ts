// Eval V2 Phase 3 — Tier B L3 校准运行器（可注入、纯逻辑，无 CLI/网络副作用）。
// 纪律：未知 grader 一律 fail-closed 记 error 并跳过；单个样本 invoker 抛错不中断整体；
//       报告始终由 evaluateL3JudgeCalibration 统一产出，errors 非空时仍返回报告供观察。
import {
  evaluateL3JudgeCalibration,
  type L3CalibrationPair,
  type L3CalibrationReport,
} from './v2-l3-calibration.ts'
import { L3_CALIBRATION_SAMPLES, type L3CalibrationSample } from './v2-l3-calibration-data.ts'
import {
  L3_JUDGE_PROMPT_REGISTRY_VERSION,
  getL3JudgePrompt,
  listL3JudgePrompts,
} from './v2-l3-prompts.ts'
import { runL3AtomicJudge, type L3ModelInvoker } from './v2-l3-runner.ts'

export interface RunCalibrationDeps {
  readonly invoker: L3ModelInvoker
  readonly samples?: readonly L3CalibrationSample[]
  readonly judgeVersion?: string
  /** 默认 3。 */
  readonly concurrency?: number
  readonly onProgress?: (done: number, total: number) => void
}

export interface CalibrationRunError {
  readonly sampleId: string
  readonly code: string
  readonly message: string
}

export interface CalibrationRunResult {
  readonly report: L3CalibrationReport
  readonly pairs: readonly L3CalibrationPair[]
  readonly promptRegistryVersion: string
  readonly errors: readonly CalibrationRunError[]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runL3Calibration(deps: RunCalibrationDeps): Promise<CalibrationRunResult> {
  const samples = deps.samples ?? L3_CALIBRATION_SAMPLES
  const judgeVersion = deps.judgeVersion ?? listL3JudgePrompts()[0]?.judgeVersion ?? 'unknown'
  const requestedConcurrency = Math.floor(deps.concurrency ?? 3)
  const concurrency = Number.isFinite(requestedConcurrency) && requestedConcurrency > 0 ? requestedConcurrency : 3
  const total = samples.length
  const errors: CalibrationRunError[] = []
  const collected: { readonly index: number; readonly pair: L3CalibrationPair }[] = []
  let done = 0

  async function runOne(index: number): Promise<void> {
    const sample = samples[index]
    try {
      const prompt = getL3JudgePrompt(sample.graderId)
      if (!prompt) {
        errors.push({
          sampleId: sample.sampleId,
          code: 'L3_PROMPT_NOT_FOUND',
          message: `未知 L3 graderId=${sample.graderId}：prompt registry 无对应条目，已 fail-closed 跳过该样本`,
        })
        return
      }
      const run = await runL3AtomicJudge(
        {
          graderId: sample.graderId,
          judgeVersion,
          calibrationStatus: 'GATE_ELIGIBLE',
          criterionPrompt: prompt.criterionPrompt,
          sourceMaterial: sample.sourceMaterial,
          candidateOutput: sample.candidateOutput,
        },
        { invoker: deps.invoker },
      )
      if (run.status !== 'OK') {
        errors.push({ sampleId: sample.sampleId, code: run.status, message: run.reason })
        return
      }
      collected.push({
        index,
        pair: {
          sampleId: sample.sampleId,
          humanPass: sample.humanPass,
          judgePass: run.judgment.verdict === 'pass',
          positionSwapConsistent: run.judgment.positionSwapConsistent,
        },
      })
    } catch (error) {
      // 单个样本失败不拖垮整批；报告仍按已收集 pairs 计算，errors 显式暴露失败。
      errors.push({ sampleId: sample.sampleId, code: 'L3_INVOKER_THREW', message: errorMessage(error) })
    } finally {
      done += 1
      deps.onProgress?.(done, total)
    }
  }

  let cursor = 0
  const workerCount = Math.min(concurrency, Math.max(total, 1))
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < total) {
        const index = cursor
        cursor += 1
        await runOne(index)
      }
    }),
  )

  const pairs = collected
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.pair)
  const report = evaluateL3JudgeCalibration(judgeVersion, pairs)

  return {
    report,
    pairs,
    promptRegistryVersion: L3_JUDGE_PROMPT_REGISTRY_VERSION,
    errors,
  }
}
