// Issue #63 Phase 1 — 严格式 GraderRegistry（缺实现即报错，严禁静默跳过）。
import type { CaseRunOutcome, EvalPointArtifact, GradeResult, GraderFn, PersonLifecycleCase } from './v2-types.ts'

export class MissingGraderError extends Error {
  readonly graderId: string

  constructor(graderId: string) {
    super(`Eval GraderRegistry: 未注册判分器 "${graderId}"（缺实现严禁静默跳过）`)
    this.name = 'MissingGraderError'
    this.graderId = graderId
  }
}

export class GraderRegistry {
  readonly #graders = new Map<string, GraderFn>()

  register(id: string, fn: GraderFn): void {
    const trimmed = id.trim()
    if (trimmed === '') {
      throw new Error('Eval GraderRegistry: grader id 不能为空')
    }
    if (this.#graders.has(trimmed)) {
      throw new Error(`Eval GraderRegistry: 重复注册判分器 "${trimmed}"`)
    }
    this.#graders.set(trimmed, fn)
  }

  has(id: string): boolean {
    return this.#graders.has(id)
  }

  listIds(): readonly string[] {
    return [...this.#graders.keys()].sort()
  }

  getOrThrow(id: string): GraderFn {
    const fn = this.#graders.get(id)
    if (!fn) {
      throw new MissingGraderError(id)
    }
    return fn
  }

  /** 校验一组 manifest 声明的 graderIds 是否全部已注册。 */
  validateManifestGraders(graderIds: readonly string[]): { readonly ok: boolean; readonly missing: readonly string[] } {
    const missingSet = new Set<string>()
    for (const id of graderIds) {
      if (!this.#graders.has(id)) missingSet.add(id)
    }
    const missing = [...missingSet].sort()
    return { ok: missing.length === 0, missing }
  }

  /** 对单个 PersonLifecycleCase 执行所有声明判分器，缺失判分器时直接抛 MissingGraderError。 */
  evaluateCase(lifecycleCase: PersonLifecycleCase): CaseRunOutcome {
    if (lifecycleCase.graderIds.length === 0) {
      throw new Error(`Eval GraderRegistry: 用例 ${lifecycleCase.caseId} 未声明任何 graderIds`)
    }
    const targetArtifact: EvalPointArtifact =
      lifecycleCase.artifacts.find((a) => a.evalPoint === lifecycleCase.evalPoint) ??
      lifecycleCase.artifacts[0] ?? {
        evalPoint: lifecycleCase.evalPoint,
        stageLabel: 'empty',
        payload: {},
      }

    const startMs = Date.now()
    const grades: GradeResult[] = []
    for (const graderId of lifecycleCase.graderIds) {
      const fn = this.getOrThrow(graderId)
      grades.push(fn(targetArtifact, lifecycleCase))
    }
    const firstFailure = grades.find((g) => !g.ok)
    const durationMs = Date.now() - startMs

    return {
      caseId: lifecycleCase.caseId,
      evalPoint: lifecycleCase.evalPoint,
      suitePool: lifecycleCase.suitePool,
      minGate: lifecycleCase.minGate,
      dataTier: lifecycleCase.dataTier,
      granularity: lifecycleCase.granularity,
      failureCostWeight: lifecycleCase.failureCostWeight,
      passed: firstFailure === undefined,
      grades,
      ...(firstFailure ? { firstFailureCode: firstFailure.code, firstFailureMessage: firstFailure.message } : {}),
      durationMs,
    }
  }
}
