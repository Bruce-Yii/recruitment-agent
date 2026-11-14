// 运行时测试用的 **scripted Worker**（明确的测试替身，不是 DSH 执行）。
//
// 它只用于验证 Task/Attempt/Session 的状态机与库约束；"Worker 真的在独立 DSH
// Session 里执行"的证据由 `src/runtime/evidence/dsh-worker.evidence.ts` 用真实
// headless 进程给出。两者不能互相代替：本文件的 launcher 永远不会被标成 LIVE。
import { randomUUID } from 'node:crypto'
import type { WorkerLauncher, WorkerOutcome, WorkerTaskRequest } from '../../src/runtime/index.ts'

/** 一个可编程的 Worker 结果。 */
export function scriptedOutcome(
  state: WorkerOutcome['state'],
  options: Partial<Omit<WorkerOutcome, 'state'>> = {},
): WorkerOutcome {
  return {
    state,
    summary: options.summary ?? `scripted ${state}`,
    resultRef: options.resultRef ?? null,
    errorCode: options.errorCode ?? null,
    errorClass: options.errorClass ?? null,
    retryable: options.retryable ?? (state === 'failed'),
    retryAfter: options.retryAfter ?? null,
    runtimeSessionId: options.runtimeSessionId ?? `session-scripted-${randomUUID()}`,
    runtimeVersion: options.runtimeVersion ?? 'scripted-1.0.0',
    modelRoute: options.modelRoute ?? 'scripted/test-double',
    durationMs: options.durationMs ?? 2,
    rawOutputRef: options.rawOutputRef ?? null,
  }
}

/** 按脚本依次返回结果的 WorkerLauncher；记录每次请求便于断言"独立 Session/续跑"。 */
export class ScriptedWorkerLauncher implements WorkerLauncher {
  readonly runtimeKind = 'SCRIPTED'
  readonly runtimeVersion = 'scripted-1.0.0'
  readonly modelRoute = 'scripted/test-double'
  readonly calls: WorkerTaskRequest[] = []
  private readonly outcomes: WorkerOutcome[]

  /**
   * @param outcomes - 每次 execute 依次消费；用完后复用最后一个结果。
   */
  constructor(outcomes: readonly WorkerOutcome[]) {
    if (outcomes.length === 0) throw new Error('ScriptedWorkerLauncher requires at least one outcome')
    this.outcomes = [...outcomes]
  }

  /** 追加一个结果（用于"先失败后成功"的多轮场景）。 */
  push(outcome: WorkerOutcome): void {
    this.outcomes.push(outcome)
  }

  async execute(request: WorkerTaskRequest, signal: AbortSignal): Promise<WorkerOutcome> {
    this.calls.push(request)
    if (signal.aborted) {
      return scriptedOutcome('failed', { errorCode: 'WORKER_CANCELLED', errorClass: 'TRANSIENT', retryable: true })
    }
    const next = this.outcomes.length > 1 ? this.outcomes.shift()! : this.outcomes[0]!
    return next
  }
}
