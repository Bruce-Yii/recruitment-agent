// 恢复计划执行器：`executePlan(content, options) -> { content, executed, remaining, skipped_reason }`。
//
// 定位：`plan.ts` 只**生成**计划（retry / switch_reader / vision_read / human_review），
// 本文件是它唯一的执行者。边界仍然留在 DSH 里：本层不直接调模型、不渲染页面、
// 不读磁盘、不写库，所有真实动作都通过调用方注入的 `RecoveryCapabilities` 完成。
// 生产侧由 U3 把能力接到既有路径（retry/switch_reader → 重新读取；vision_read →
// recruitment_page_image + read_image，见 D-81：不新建模型客户端）。
//
// 执行铁律（保守、不许猜）：
//
//   ① 只自动执行 retry / switch_reader / vision_read 三类。
//      `human_review` **永不自动执行** —— 这是人机闸门（D-79）：写人类动作之前必须
//      由真人放行，闸门的价值就在于「确实有个真人看过」，Agent 不能替人点确认；
//      D-95 把人机闸门简化成「人只做一次决策」，但那一次的授权凭据仍然是**人的原话**
//      （IN_CHAT 的 confirmation_text），Agent 不能自己充当人、也不能替人回答。
//      因此本执行器连 `askHuman` 都不调用：人工步只原样留在 `remaining` 里等人，
//      由上层（DSH Agent / 工具层）在闸门处发起。执行器自己「问一下人」再拿回答当
//      成功，就等于绕过 D-79/D-95。
//
//   ② 每执行一步都**重新 assess**。
//      计划是基于执行前的判定生成的，那份判定只描述执行前的内容；能力返回的
//      content 只是「新一次读取的证据」，不是「成功」。如果拿旧判定继续往下走，
//      就会把「跑过一遍」误当成「问题解决了」，甚至掩盖新内容引入的新 HARD。
//      只有把新 content 重新过一遍质量 Gate，拿到新的 blocking 快照，才能判断
//      这一步到底有没有解决任何问题。`blocking` 是下游唯一的闸门（assess.isBlocked），
//      所以成功必须用同一把尺子重新量。
//
//   ③ 成功判据是**三条同时成立**（只满足一条就采纳太松，会放过「换一种病」）：
//      (a) 重新 assess 后 `blocking === false`，或 HARD 条目数严格减少；
//      (b) 新内容里**不出现**旧内容没有的 HARD code（禁止用一条无关 HARD 换掉两条）；
//      (c) 这一步的**目标问题确实消失**：`step.codes` 里的 code **全部**不在新 HARD 里。
//          （plan 已经给每步算好 codes，执行器信任它，不另立一套、不硬编码具体 code 名。）
//      任一条不满足 → `failed`、不采纳这次输出、停止后续自动步骤。
//      失败/超时/返回 null 同样立即停止 —— 自动恢复宁可停在半路，也不赌下一步。
//
//   ④ 初始判定不 blocking（只剩 SOFT）时，自动恢复**没有可证明的修复目标**：
//      直接返回 `executed=[]`、`remaining` 原样，并给 `skipped_reason='NOT_BLOCKING'`，
//      不把「SOFT 内容」误判成「failed」。
//
//   ⑤ 缺读取器事实的 PDF 重读**不跑空转**：`DocumentContent` 是封闭契约，不带页数
//      （README §6.2）。既没有 `factsFor`、静态 `facts` 里也没有页数时，重读结果必然
//      命中 `doc_page_count_unverified`。所以 retry / switch_reader 步直接判 `blocked`
//      （`READER_FACTS_REQUIRED`）并写进 `executed`，不浪费一次真实读取。

import { assess } from '../quality/assess.ts'
import type { Assessment, Completeness, ReaderFacts, SuggestedAction } from '../quality/types.ts'
import type { DocumentContent } from '../contracts/index.ts'
import { plan } from './plan.ts'
import type { PlanOptions, RecoveryPlan, RecoveryStep } from './types.ts'

/** 自动执行的动作（封闭集）。human_review 故意不在其中 —— 见文件头铁律 ①。 */
const AUTOMATIC_ACTIONS: ReadonlySet<SuggestedAction> = new Set<SuggestedAction>([
  'retry',
  'switch_reader',
  'vision_read',
])

/** 缺读取器事实时 retry / switch_reader 步的稳定 blocked 原因。 */
const READER_FACTS_REQUIRED = 'READER_FACTS_REQUIRED'

/** 初始判定不 blocking 时跳过自动恢复的稳定原因。 */
const NOT_BLOCKING = 'NOT_BLOCKING'

/** 单步默认墙钟上限：能力挂死不得拖住整个质量 Gate。超时按失败处理（不是成功）。 */
const DEFAULT_STEP_TIMEOUT_MS = 30_000

/**
 * 单次 executePlan 最多尝试多少步。
 *
 * 每成功一步都要求「目标消失 + 无新 HARD」，循环本身已收敛；这个上限只是病态输入的兜底。
 */
const DEFAULT_MAX_STEPS = 8

/**
 * 恢复能力接口（调用方注入，本层不依赖任何具体实现）。
 *
 * 约定：能力返回的 content 必须是**诚实的新读取结果**（同一个 asset_sha256）；
 * 读不出来就返回 null，不许返回一份伪造的「干净内容」。执行器不采信能力自述的
 * 「成功了」，只采信重新 assess 后的 blocking 与目标 code 变化。
 */
export interface RecoveryCapabilities {
  /** 重新读取原件（retry / switch_reader 共用）：读不出来返回 null。 */
  reRead?: (reason: 'retry' | 'switch_reader') => Promise<DocumentContent | null>
  /**
   * 视觉补读：pages 是计划里的真实 1-based 页号（已去重、升序）。
   *
   * 只接受页号：图像帧（frame）不在这个能力里表达，也不会把帧号谎报成页码。
   */
  visionRead?: (pages: readonly number[]) => Promise<DocumentContent | null>
  /**
   * 人工通道：**执行器自身绝不调用**（见文件头铁律 ①）。
   *
   * 保留在接口里是给上层在 `remaining` 上发起人工动作用的；一次人工回答要变成
   * 新的可审计证据（D-95 的 IN_CHAT 原话 + 哈希），属于工具层，不属于自动循环。
   * 按 D-79/D-95，人机闸门必须是真人；执行器只把人工步原样留在 `remaining`。
   */
  askHuman?: (payload: unknown) => Promise<{ accepted: boolean, text?: string } | null>
}

/**
 * 一步的执行结果状态。
 *
 * - `succeeded`：真的调用了能力，且三条成功判据同时成立、输出被采纳；
 * - `failed`：调用了能力，但失败/超时/null/读到别的材料/判据不成立，输出未采纳；
 * - `blocked`：**没有调用能力**，执行器在执行前就判它不该跑（目前只有
 *   `READER_FACTS_REQUIRED`）。能力缺失/计划已标 blocked 不产生记录（没有执行）。
 */
export type RecoveryExecutionStatus = 'succeeded' | 'failed' | 'blocked'

/** 判定快照：把「blocking 到底长什么样」留成可审计的数字，而不是一句自述的成功。 */
export interface RecoveryBlockingSnapshot {
  readonly blocking: boolean
  /** HARD 条目数（blocking 的「下降」用它比较，避免只看布尔值看不出部分修复）。 */
  readonly hard_count: number
  readonly blocking_codes: ReadonlyArray<string>
  readonly completeness: Completeness
  readonly issue_count: number
}

/** 一条执行记录（真正调用能力的步骤，以及执行器主动判 blocked 的步骤）。 */
export interface RecoveryStepResult {
  readonly step_id: string
  /** 实际处理的动作；human_review 永远不会出现在这里。 */
  readonly action: SuggestedAction
  readonly status: RecoveryExecutionStatus
  /** 人读的原因：为什么算成功/失败/blocked；失败时写明停止后续自动步骤。 */
  readonly reason: string
  /** 被判 blocked 的稳定原因（目前只有 `READER_FACTS_REQUIRED`）；其他状态为 null。 */
  readonly blocked_reason: string | null
  /** 执行前判定快照。 */
  readonly before: RecoveryBlockingSnapshot
  /**
   * 执行后重新判定的快照。
   * 「能力返回 null / 抛错 / 超时 / 读到别的材料 / 执行前判 blocked」时为 null。
   */
  readonly after: RecoveryBlockingSnapshot | null
}

/**
 * 执行选项。
 *
 * 故意 `Omit<PlanOptions, 'assessment'>`：执行器会**自己**重新判定，不接受外部传进来的
 * 陈旧判定（否则「每步重新 assess」这条铁律会被外部参数架空）。
 */
export interface ExecutePlanOptions extends Omit<PlanOptions, 'assessment'> {
  readonly capabilities?: RecoveryCapabilities
  /**
   * 按「当前 content」取读取器事实的钩子（可选，优先于 `facts`）。
   *
   * 为什么需要：`DocumentContent` 是封闭契约，**不带**页数 / 原生 URI 清单
   * （见 `src/document/README.md` §6.2）。重读成功后，页数等事实可能来自新的
   * `source_meta`；如果只拿初始 `facts` 去重判，会把「页数现在知道了」误判成
   * 「blocking 没下降」，从而拒绝一次真正成功的重读。
   *
   * 对 PDF 的 retry / switch_reader 步，页数证据（本钩子，或静态 `facts.page_count`）
   * 同时是**执行前置条件**：两者都没有就判 `blocked`（`READER_FACTS_REQUIRED`），
   * 不让重读结果必然撞上 `doc_page_count_unverified` 白跑一次（铁律 ⑤）。
   *
   * 只允许返回读取器/原件**真实声明**的证据，不许在这里猜（猜了就是伪造）。
   */
  readonly factsFor?: (content: DocumentContent) => ReaderFacts
  /** 单步墙钟上限（毫秒）；<=0 或非有限值 → 用默认 30s。 */
  readonly step_timeout_ms?: number
  /** 最多尝试步数；默认 8。 */
  readonly max_steps?: number
}

/** `executePlan` 的返回值。 */
export interface ExecutePlanResult {
  /** 最后一次被采纳的内容（一步都没成功时就是入参本身）。 */
  readonly content: DocumentContent
  /** 真正调用能力 / 主动判 blocked 的步骤记录（按发生顺序；空数组 = 一步都没执行）。 */
  readonly executed: ReadonlyArray<RecoveryStepResult>
  /** 停止后基于当前内容重新生成的计划；未解决/不可执行/需要人工的步骤都在这里。 */
  readonly remaining: RecoveryPlan
  /**
   * 自动恢复被跳过的稳定原因；正常执行（含中途停止）为 null。
   * 目前只有 `NOT_BLOCKING`（初始判定就不 blocking，只剩 SOFT，没有可证明的修复目标）。
   */
  readonly skipped_reason: 'NOT_BLOCKING' | null
}

/** 能力绑定结果：ready = 可以调用；unavailable = 缺能力或该步没有可表达的目标。 */
type StepBinding =
  | { readonly kind: 'ready'; readonly run: () => Promise<DocumentContent | null> }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** 一步的判定结论（三条成功判据全部成立才 ok）。 */
interface StepJudgement {
  readonly ok: boolean
  readonly failures: ReadonlyArray<string>
}

class StepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`单步执行超过 ${timeoutMs}ms 上限`)
    this.name = 'StepTimeoutError'
  }
}

/** 取这份 content 对应的读取器事实：优先 `factsFor`，否则用静态 `facts`。 */
function evidenceFor(content: DocumentContent, options: ExecutePlanOptions): ReaderFacts {
  return options.factsFor === undefined ? (options.facts ?? {}) : options.factsFor(content)
}

function evaluate(content: DocumentContent, options: ExecutePlanOptions): Assessment {
  return assess(content, evidenceFor(content, options))
}

function planFor(content: DocumentContent, options: ExecutePlanOptions, assessment: Assessment): RecoveryPlan {
  // assessment 已经给出，plan() 不会再调 assess，所以这里不重复调 factsFor。
  return plan(content, {
    assessment,
    model_supports_image: options.model_supports_image,
    max_vision_pages: options.max_vision_pages,
    max_retries: options.max_retries,
  })
}

function snapshotOf(assessment: Assessment): RecoveryBlockingSnapshot {
  return {
    blocking: assessment.blocking,
    hard_count: assessment.issues.filter((issue) => issue.severity === 'HARD').length,
    blocking_codes: [...assessment.blocking_codes],
    completeness: assessment.completeness,
    issue_count: assessment.issues.length,
  }
}

function describeSnapshot(snapshot: RecoveryBlockingSnapshot): string {
  const codes = snapshot.blocking_codes.length === 0 ? '无' : snapshot.blocking_codes.join(',')
  return `blocking=${snapshot.blocking}、HARD ${snapshot.hard_count} 条（${codes}）、`
    + `completeness=${snapshot.completeness}、issue ${snapshot.issue_count} 条`
}

interface HardStats {
  readonly count: number
  readonly codes: ReadonlySet<string>
}

function hardStatsOf(assessment: Assessment): HardStats {
  let count = 0
  const codes = new Set<string>()
  for (const issue of assessment.issues) {
    if (issue.severity !== 'HARD') continue
    count += 1
    codes.add(issue.code)
  }
  return { count, codes }
}

/**
 * 三条成功判据（铁律 ③）。每条不满足都写成人话，便于审计「为什么不采纳」。
 *
 * 只在初始 blocking=true 的路径上被调用（NOT_BLOCKING 已在入口返回）。
 */
function judgeStep(
  step: RecoveryStep,
  beforeAssessment: Assessment,
  afterAssessment: Assessment,
): StepJudgement {
  const before = hardStatsOf(beforeAssessment)
  const after = hardStatsOf(afterAssessment)
  const failures: string[] = []

  // (a) blocking 真的下降：由阻塞变为不阻塞，或 HARD 条目数严格减少。
  const improved = afterAssessment.blocking === false || after.count < before.count
  if (!improved) {
    failures.push(
      `blocking 没有下降（执行前 ${describeSnapshot(snapshotOf(beforeAssessment))}`
      + ` → 执行后 ${describeSnapshot(snapshotOf(afterAssessment))}）`,
    )
  }

  // (b) 禁止「换一种病」：新内容不得出现旧内容没有的 HARD code。
  const newHardCodes = [...after.codes].filter((code) => !before.codes.has(code)).sort()
  if (newHardCodes.length > 0) {
    failures.push(`新内容出现了旧内容没有的 HARD code（${newHardCodes.join(',')}），禁止「换一种病」`)
  }

  // (c) 目标问题确实消失：只认 plan 给的 step.codes（不硬编码任何 code 名）。
  const stillHard = step.codes.filter((code) => after.codes.has(code)).sort()
  if (stillHard.length > 0) {
    failures.push(`目标 code 仍是 HARD（${stillHard.join(',')}），这一步的目标问题没有消失`)
  }

  return { ok: failures.length === 0, failures }
}

/** 找到计划里第一个可自动执行的步骤；人工步被跳过但不执行（它留在 remaining 里）。 */
function nextAutomaticStep(recoveryPlan: RecoveryPlan): RecoveryStep | undefined {
  return recoveryPlan.steps.find((step) => AUTOMATIC_ACTIONS.has(step.action))
}

/** content 是不是 PDF（铁律 ⑤ 只对这种媒体要求 factsFor）。 */
function isPdfContent(content: DocumentContent): boolean {
  return typeof content.media_type === 'string' && content.media_type.toLowerCase().includes('pdf')
}

/** 是否存在可用的页数证据：`factsFor` 存在，或静态 `facts.page_count` 是正数。 */
function hasReaderPageEvidence(options: ExecutePlanOptions): boolean {
  if (options.factsFor !== undefined) return true
  const pageCount = options.facts?.page_count
  return typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount > 0
}

/**
 * 执行前置条件（铁律 ⑤）：PDF 的 retry / switch_reader 步必须能拿到页数证据。
 *
 * `factsFor` 存在，或静态 `facts.page_count` 为正数，都算满足（静态页数也是事实，
 * 不要求必须走 factsFor）。两者都没有才判 `READER_FACTS_REQUIRED`：canonical content
 * 不带页数，重读结果必然命中 `doc_page_count_unverified`，让它「跑一遍再失败」是浪费
 * 一次真实读取。返回 null = 允许执行。
 */
function readerFactsProblem(
  step: RecoveryStep,
  content: DocumentContent,
  options: ExecutePlanOptions,
): string | null {
  if (step.action !== 'retry' && step.action !== 'switch_reader') return null
  if (hasReaderPageEvidence(options)) return null
  return isPdfContent(content) ? READER_FACTS_REQUIRED : null
}

/**
 * 把计划步骤绑定到调用方提供的能力。
 *
 * 能力缺失 → `unavailable`：这步**不可执行**，不跳过、不假装成功（调用方原地停止，
 * 剩余步骤原样留在 remaining 里）。视觉步只有帧号没有页号时同样不可执行 ——
 * 不把帧号谎报成页码（那是伪造证据）。
 */
function bindStep(step: RecoveryStep, capabilities: RecoveryCapabilities): StepBinding {
  if (step.action === 'retry' || step.action === 'switch_reader') {
    const reRead = capabilities.reRead
    if (reRead === undefined) {
      return { kind: 'unavailable', reason: `没有 reRead 能力，${step.action} 步不可执行` }
    }
    return { kind: 'ready', run: () => reRead(step.action) }
  }
  if (step.action === 'vision_read') {
    const pages = step.vision
      .map((request) => request.page)
      .filter((page): page is number => page !== null)
    if (pages.length === 0) {
      return {
        kind: 'unavailable',
        reason: '该视觉补读步没有页号（只有帧号/无定位），visionRead(pages) 没有可表达的目标；'
          + '不把帧号谎报成页码',
      }
    }
    const visionRead = capabilities.visionRead
    if (visionRead === undefined) {
      return { kind: 'unavailable', reason: '没有 visionRead 能力，vision_read 步不可执行' }
    }
    const targets = Array.from(new Set(pages)).sort((a, b) => a - b)
    return { kind: 'ready', run: () => visionRead(targets) }
  }
  // human_review 永远不会走到这里（nextAutomaticStep 不返回人工步）。
  return { kind: 'unavailable', reason: `动作 ${step.action} 不在自动执行范围内` }
}

/** 给能力调用加上墙钟上限。超时按失败处理，并且清掉计时器，不留下悬挂句柄。 */
async function callWithTimeout(
  run: () => Promise<DocumentContent | null>,
  timeoutMs: number,
): Promise<DocumentContent | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(timeoutMs)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 身份核对：重新读到的必须是同一份原件。空 sha（未声明）同样按不可核对处理，fail-closed。 */
function sameAsset(current: DocumentContent, candidate: DocumentContent): boolean {
  return current.asset_sha256 !== '' && current.asset_sha256 === candidate.asset_sha256
}

function normalizedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_STEP_TIMEOUT_MS
  return value
}

/**
 * 执行恢复计划。
 *
 * @param content 统一内容（必须已通过 U0 契约校验；执行器只消费、不改写）。
 * @param options 能力接口 + 计划参数（facts / factsFor / 模型图像能力 / 重试预算 / 补读页上限）。
 *                执行器会自己重新判定，**不接受**外部传进来的 assessment。
 */
export async function executePlan(
  content: DocumentContent,
  options: ExecutePlanOptions = {},
): Promise<ExecutePlanResult> {
  const capabilities = options.capabilities ?? {}
  const timeoutMs = normalizedTimeout(options.step_timeout_ms)
  const maxSteps = options.max_steps === undefined || !Number.isFinite(options.max_steps)
    ? DEFAULT_MAX_STEPS
    : Math.max(0, Math.trunc(options.max_steps))

  // 当前内容与它**当前**的判定：两者必须始终对应，任何一步采纳新内容后一起更新。
  const initialAssessment = evaluate(content, options)
  const initialPlan = planFor(content, options, initialAssessment)

  // 铁律 ④：初始就不 blocking（只剩 SOFT）时，自动恢复没有可证明的修复目标。
  // 直接返回，把语义写成 NOT_BLOCKING，而不是「无法证明下降 → failed」。
  if (!initialAssessment.blocking) {
    return { content, executed: [], remaining: initialPlan, skipped_reason: NOT_BLOCKING }
  }

  let current = content
  let currentAssessment = initialAssessment
  let remaining = initialPlan
  const executed: RecoveryStepResult[] = []
  // 同一个 step_id 只尝试一次：重 plan 后如果同一问题原样回来，不能无限重试。
  const attempted = new Set<string>()

  for (let index = 0; index < maxSteps; index += 1) {
    const step = nextAutomaticStep(remaining)
    if (step === undefined) break // 只剩人工步或没有步骤：自动执行到此为止
    if (attempted.has(step.step_id)) break
    attempted.add(step.step_id)

    const before = snapshotOf(currentAssessment)

    // 计划自己已经判「这步执行不了」（例如模型不支持图像）。执行器没有资格把它改成
    // 成功，也不调用能力：没有执行，就不产生 executed 记录，remaining 里仍是 blocked。
    if (step.status === 'blocked') break

    // 铁律 ⑤：PDF 的 retry / switch_reader 步缺 factsFor → 执行前直接 blocked。
    const factsProblem = readerFactsProblem(step, current, options)
    if (factsProblem !== null) {
      executed.push({
        step_id: step.step_id,
        action: step.action,
        status: 'blocked',
        blocked_reason: factsProblem,
        reason: '缺少读取器事实（既没有 factsFor，静态 facts 里也没有页数）且内容是 PDF：'
          + '重读后无法核对页数，必然命中 doc_page_count_unverified；直接判 blocked，'
          + '不浪费一次真实读取；停止后续自动步骤，该步留在 remaining 里',
        before,
        after: null,
      })
      break
    }

    // 能力缺失 = 这一步不可执行。不跳过（不拿后面的步骤来凑成功）、不伪造记录；
    // 直接停止自动执行，剩余步骤原样留在 remaining 里。
    const binding = bindStep(step, capabilities)
    if (binding.kind === 'unavailable') break

    // 能力返回值按 unknown 接：类型声明是 DocumentContent，但运行时不能信任调用方。
    let candidate: unknown = null
    let failure: string | null = null
    try {
      candidate = await callWithTimeout(binding.run, timeoutMs)
    } catch (error) {
      failure = `执行失败：${describeError(error)}`
    }
    if (failure === null && candidate === null) {
      failure = '能力返回 null（没有拿到新的读取结果），不能把「没读到」当成「修好了」'
    }
    if (failure === null && (typeof candidate !== 'object' || candidate === undefined)) {
      failure = '能力返回的不是 DocumentContent（不是对象），拒绝采纳'
    }
    if (failure === null && !sameAsset(current, candidate as DocumentContent)) {
      failure = '能力返回的 content 指向另一份材料（asset_sha256 与原内容不一致），拒绝采纳'
    }

    if (failure !== null) {
      executed.push({
        step_id: step.step_id,
        action: step.action,
        status: 'failed',
        blocked_reason: null,
        reason: `${failure}；停止后续自动步骤，未解决的步骤留在 remaining 里`,
        before,
        after: null,
      })
      break
    }

    const nextContent = candidate as DocumentContent
    // 铁律 ②：不采信「跑完了」，重新过一遍质量 Gate。
    const nextAssessment = evaluate(nextContent, options)
    const after = snapshotOf(nextAssessment)
    // 铁律 ③：三条判据同时成立才算这一步成功。
    const judgement = judgeStep(step, currentAssessment, nextAssessment)

    if (!judgement.ok) {
      executed.push({
        step_id: step.step_id,
        action: step.action,
        status: 'failed',
        blocked_reason: null,
        reason: `重新判定后这一步不算成功：${judgement.failures.join('；')}；`
          + '不采纳这次输出；停止后续自动步骤，未解决的步骤留在 remaining 里',
        before,
        after,
      })
      break
    }

    // 只有三条判据全部成立才采纳新内容，并用新的判定重新生成剩余计划。
    current = nextContent
    currentAssessment = nextAssessment
    remaining = planFor(current, options, currentAssessment)
    executed.push({
      step_id: step.step_id,
      action: step.action,
      status: 'succeeded',
      blocked_reason: null,
      reason: `三条判据同时成立（blocking 下降、无新增 HARD code、目标问题消失），采纳这次输出`
        + `（${describeSnapshot(before)} → ${describeSnapshot(after)}）`,
      before,
      after,
    })
  }

  return { content: current, executed, remaining, skipped_reason: null }
}
