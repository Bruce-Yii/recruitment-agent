// recruitment_document_read —— 多格式文档读取（PDF / DOCX / PNG / JPEG）的**唯一入口**。
//
// 这是 U3 的"收口"：U0（契约）/ U1（Reader）/ U2（质量 + 恢复）都已经有实现和测试，
// 但**没有暴露成工具**，所以 agent 调不到 —— 典型 R2 假接线（能力在包里、入口没有它）。
//
// 接线硬要求（`src/document/README.md` §6.2）：
//   const { content, source_meta } = await readDocumentDetailed(path, cfg)
//   const facts = readerFactsFromSourceMeta(source_meta)   // 只消费 content 会丢 facts
//   const assessment = assess(content, facts)              // 症状：每份 PDF 都命中 doc_page_count_unverified（HARD）
//   const recovery = plan(content, { assessment, facts })
//   const execution = await executePlan(content, { facts, factsFor, capabilities })  // R2：计划必须真被执行
//
// 四个诚实点：
//   1. 读不出就抛错（`DocumentReadError`），**绝不**返回一个"看起来 complete"的结果；
//   2. `assessment.blocking=true` 时明确告诉模型"不得进入可信结构化/S7"，并把恢复计划一并给出；
//   3. 计划在 plan() 之后**真的被执行**（D-99）：
//      * `retry` / `switch_reader` → 用真实重新读取（同一个 reader、同一份原件）尝试修；
//      * `vision_read` → **不由本工具执行**（D-81：读图是 agent 用 recruitment_page_image +
//        read_image + recruitment_model_text_merge 做的；插件不建第二个模型客户端），
//        补读页号原样留在 `recovery.vision_pages` / `recovery.steps` 里；
//      * `human_review` → **永不自动执行**（D-79/D-95：闸门价值在于真人看过），只留在 remaining；
//   4. 输出里 `recovery.execution` 是执行器自己的记录（跑了几步、每步 succeeded/failed/blocked、
//      执行前后 blocking/HARD 快照）；`recovery` 本身是**执行后**剩下的计划。本工具不写库。
//
// 与 `recruitment_resume_read` 的分工：那个只读 PDF 的纯文本；这个走统一 Reader（按内容嗅探，
// 不按扩展名），并且带质量判定与恢复计划。新链路一律用这个。

import { readDocumentDetailed, isDocumentReadError } from '../document/readers/index.ts'
import type { DocumentReadOutcome } from '../document/readers/index.ts'
import { assess, readerFactsFromSourceMeta } from '../document/quality/index.ts'
import type { ReaderFacts } from '../document/quality/index.ts'
import { executePlan, plan } from '../document/recovery/index.ts'
import type { ExecutePlanResult, ExecutePlanOptions, RecoveryPlan } from '../document/recovery/index.ts'
import type { DocumentContent } from '../document/contracts/index.ts'
import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import type { ResolvedConverterConfig } from './converter.ts'

/**
 * 真正阻断**结构化**的 code（D-97 第一批）。
 *
 * 不在这里的 HARD code（跨块归属、阅读顺序、未核图片、归属未核、时间线未解析）
 * 只影响"可信筛选"，不影响"把文字抽成字段"——模型结构化不需要知道哪句话在左栏。
 */
const STRUCTURE_BLOCKING_CODES: readonly string[] = [
  'doc_empty',
  'doc_text_unreadable',
  'pdf_text_encoding_unread',
  'docx_textbox_unread',
  'doc_unreadable',
  'image_requires_vision',
]

/** 工具名。 */
const TOOL_NAME = 'recruitment_document_read'

/** 入参声明。 */
const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 4096,
    description:
      'Absolute path to one local PDF / DOCX / PNG / JPEG. Must be inside the configured allowed_roots.',
  },
}

/** 输出：一个区块（模型只能引用 block_id，不能引用数组下标）。 */
interface BlockValue {
  readonly block_id: string
  readonly kind: string
  readonly order: number
  readonly page: number
  readonly text: string
}

/** 输出：一条质量问题的投影（只留人/模型需要的字段）。 */
interface IssueValue {
  readonly code: string
  readonly severity: string
  readonly message: string
  readonly suggested_action: string
  readonly retryable: boolean
  readonly page: number
}

/** 输出：一条恢复步骤的投影。 */
interface StepValue {
  readonly step_id: string
  readonly action: string
  readonly role: string
  readonly blocking: boolean
  readonly status: string
  readonly codes: readonly string[]
  readonly problem: string
  readonly blocked_reason?: string
}

/** 输出：执行器真正执行过的一步（`human_review` 永远不会出现在这里）。 */
interface ExecutedStepValue {
  readonly step_id: string
  readonly action: string
  /** succeeded / failed / blocked（执行器的封闭状态集）。 */
  readonly status: string
  /** 该步的目标 code（来自计划）；执行中重新规划出来的步骤可能拿不到，给空数组而不猜。 */
  readonly codes: readonly string[]
  /** 为什么算成功/失败/被 blocked（执行器给的人读原因）。 */
  readonly reason: string
  /** 执行前就判不可执行的稳定原因；其余为空串。 */
  readonly blocked_reason: string
  readonly before_blocking: boolean
  readonly before_hard: number
  /** 是否留下重判快照（能力没返回内容 / 执行前判 blocked 时为 false）。 */
  readonly has_after: boolean
  readonly after_blocking: boolean
  readonly after_hard: number
}

/** 输出：恢复计划的实际执行结果（D-99）。全部字段有默认值，输出里不出现 null。 */
interface ExecutionValue {
  readonly executed: number
  readonly succeeded: number
  readonly failed: number
  readonly blocked: number
  /** 自动恢复被跳过的稳定原因；空串 = 没有被跳过。 */
  readonly skipped_reason: string
  /** true = 本工具返回的 content 是恢复重读后**被采纳**的新内容。 */
  readonly content_updated: boolean
  readonly steps: readonly ExecutedStepValue[]
}

/** 输出：规范值。 */
interface DocumentReadValue {
  readonly path: string
  readonly media_type: string
  readonly reader_id: string
  readonly reader_version: string
  readonly asset_sha256: string
  readonly completeness: string
  readonly needs_visual: boolean
  readonly page_count: number
  readonly source_chars: number
  readonly text: string
  readonly blocks: readonly BlockValue[]
  readonly assessment: {
    readonly completeness: string
    readonly blocking: boolean
    /** 结构化用：版式/顺序/图片类问题不阻断（D-97 第一批）。 */
    readonly blocking_for_structure: boolean
    /** 只有版式类 HARD（顺序/跨块/未核图片），文字本身可用。 */
    readonly layout_only_blocking: boolean
    readonly blocking_codes: readonly string[]
    readonly soft_codes: readonly string[]
    readonly actions: readonly { action: string; codes: readonly string[]; blocking: boolean }[]
    readonly issues: readonly IssueValue[]
  }
  readonly recovery: {
    readonly plan_id: string
    readonly blocking: boolean
    readonly next: string
    readonly requires_model: boolean
    readonly model_image_support: string
    readonly vision_pages: readonly number[]
    readonly steps: readonly StepValue[]
    readonly notes: readonly string[]
    /** 执行器记录：跑了几步、哪步成功/失败/被 blocked（D-99）。 */
    readonly execution: ExecutionValue
  }
}

/** 规范输出 schema（只用官方强制子集；不用 type 数组、不用 null）。 */
const ISSUE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    severity: { type: 'string' },
    message: { type: 'string' },
    suggested_action: { type: 'string' },
    retryable: { type: 'boolean' },
    page: { type: 'number' },
  },
  required: ['code', 'severity', 'message', 'suggested_action', 'retryable', 'page'],
  additionalProperties: false,
}

const STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    step_id: { type: 'string' },
    action: { type: 'string' },
    role: { type: 'string' },
    blocking: { type: 'boolean' },
    status: { type: 'string' },
    codes: { type: 'array', items: { type: 'string' } },
    problem: { type: 'string' },
    blocked_reason: { type: 'string' },
  },
  required: ['step_id', 'action', 'role', 'blocking', 'status', 'codes', 'problem'],
  additionalProperties: false,
}

const EXECUTED_STEP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    step_id: { type: 'string' },
    action: { type: 'string' },
    status: { type: 'string', enum: ['succeeded', 'failed', 'blocked'] },
    codes: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    blocked_reason: { type: 'string' },
    before_blocking: { type: 'boolean' },
    before_hard: { type: 'number' },
    has_after: { type: 'boolean' },
    after_blocking: { type: 'boolean' },
    after_hard: { type: 'number' },
  },
  required: [
    'step_id', 'action', 'status', 'codes', 'reason', 'blocked_reason',
    'before_blocking', 'before_hard', 'has_after', 'after_blocking', 'after_hard',
  ],
  additionalProperties: false,
}

const EXECUTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    executed: { type: 'number' },
    succeeded: { type: 'number' },
    failed: { type: 'number' },
    blocked: { type: 'number' },
    skipped_reason: { type: 'string' },
    content_updated: { type: 'boolean' },
    steps: { type: 'array', items: EXECUTED_STEP_SCHEMA },
  },
  required: ['executed', 'succeeded', 'failed', 'blocked', 'skipped_reason', 'content_updated', 'steps'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    media_type: { type: 'string' },
    reader_id: { type: 'string' },
    reader_version: { type: 'string' },
    asset_sha256: { type: 'string' },
    completeness: { type: 'string', enum: ['complete', 'partial', 'failed'] },
    needs_visual: { type: 'boolean' },
    page_count: { type: 'number' },
    source_chars: { type: 'number' },
    text: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          block_id: { type: 'string' },
          kind: { type: 'string' },
          order: { type: 'number' },
          page: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['block_id', 'kind', 'order', 'page', 'text'],
        additionalProperties: false,
      },
    },
    assessment: {
      type: 'object',
      properties: {
        completeness: { type: 'string' },
        blocking: { type: 'boolean' },
        blocking_for_structure: { type: 'boolean' },
        layout_only_blocking: { type: 'boolean' },
        blocking_codes: { type: 'array', items: { type: 'string' } },
        soft_codes: { type: 'array', items: { type: 'string' } },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              codes: { type: 'array', items: { type: 'string' } },
              blocking: { type: 'boolean' },
            },
            required: ['action', 'codes', 'blocking'],
            additionalProperties: false,
          },
        },
        issues: { type: 'array', items: ISSUE_SCHEMA },
      },
      required: ['completeness', 'blocking', 'blocking_for_structure', 'layout_only_blocking', 'blocking_codes', 'soft_codes', 'actions', 'issues'],
      additionalProperties: false,
    },
    recovery: {
      type: 'object',
      properties: {
        plan_id: { type: 'string' },
        blocking: { type: 'boolean' },
        next: { type: 'string' },
        requires_model: { type: 'boolean' },
        model_image_support: { type: 'string' },
        vision_pages: { type: 'array', items: { type: 'number' } },
        steps: { type: 'array', items: STEP_SCHEMA },
        notes: { type: 'array', items: { type: 'string' } },
        execution: EXECUTION_SCHEMA,
      },
      required: [
        'plan_id', 'blocking', 'next', 'requires_model',
        'model_image_support', 'vision_pages', 'steps', 'notes', 'execution',
      ],
      additionalProperties: false,
    },
  },
  required: [
    'path', 'media_type', 'reader_id', 'reader_version', 'asset_sha256', 'completeness',
    'needs_visual', 'page_count', 'source_chars', 'text', 'blocks', 'assessment', 'recovery',
  ],
  additionalProperties: false,
}

/**
 * 从定位器里取页码；没有页码（DOCX / 图片）返回 0。
 * @param locator - 契约里的定位器（PdfLocator | DocxLocator | ImageLocator）。
 * @returns 页码，取不到给 0。
 */
function pageOf(locator: unknown): number {
  if (typeof locator !== 'object' || locator === null) return 0
  const page = (locator as { page?: unknown }).page
  return typeof page === 'number' && Number.isFinite(page) ? page : 0
}

/**
 * 从 source_meta 里取页数；取不到时退回区块页码的最大值。
 *
 * PDF 的页数在旁路证据的 `converter_meta.pages` 里（`buildSourceMeta()` 不把它摊平），
 * 所以必须先走 `readerFactsFromSourceMeta()`；否则扫描件（没有带页号的块）会被显示成 0 页。
 *
 * @param content - 规范内容。
 * @param sourceMeta - 读取器附加证据。
 * @returns 页数（至少 0）。
 */
function pageCountOf(content: DocumentContent, sourceMeta: Readonly<Record<string, unknown>>): number {
  const declared = readerFactsFromSourceMeta(sourceMeta).page_count
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) return declared
  const fromMeta = sourceMeta.page_count
  if (typeof fromMeta === 'number' && Number.isFinite(fromMeta)) return fromMeta
  let max = 0
  for (const block of content.blocks) {
    const page = pageOf(block.locator)
    if (page > max) max = page
  }
  return max
}

/**
 * 把读取器的错误映射成插件稳定错误码。
 * @param error - 任意错误。
 * @returns 不会返回（总是抛）。
 */
function rethrowAsToolError(error: unknown): never {
  if (isDocumentReadError(error)) {
    const mapped = error.code === 'INVALID_ARGS' || error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN'
      ? error.code
      : 'READER_FAILED'
    throw new RecruitmentToolError(
      mapped,
      JSON.stringify({ reason_code: error.code, message: error.message }),
    )
  }
  throw error
}

/** 媒体是不是 PDF（只有分页媒体才要求页数证据，见执行器铁律 ⑤）。 */
function isPdfContent(content: DocumentContent): boolean {
  return typeof content.media_type === 'string' && content.media_type.toLowerCase().includes('pdf')
}

/**
 * 首读是否真的**声明**了页数。
 *
 * 不拿区块最大页号倒推：`DocumentContent` 是封闭契约、不带页数（README §6.2），
 * 倒推出来的是派生值，不是读取器声明的事实。没有声明 = 没有页数证据。
 */
function declaredPageCountOf(facts: ReaderFacts): number {
  const count = facts.page_count
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0
}

/** 执行器记录 → 输出投影（所有字段都有默认值，输出里不允许 null）。 */
function toExecutionValue(
  result: ExecutePlanResult,
  initialPlan: RecoveryPlan,
  initialContent: DocumentContent,
): ExecutionValue {
  // step.codes 优先从初始计划取；执行中重新规划出来的步骤从最终 remaining 取；
  // 两处都没有就给空数组（不猜目标 code）。
  const codesByStep = new Map<string, readonly string[]>()
  for (const step of initialPlan.steps) codesByStep.set(step.step_id, step.codes)
  for (const step of result.remaining.steps) {
    if (!codesByStep.has(step.step_id)) codesByStep.set(step.step_id, step.codes)
  }
  const steps: ExecutedStepValue[] = result.executed.map((step) => ({
    step_id: step.step_id,
    action: step.action,
    status: step.status,
    codes: [...(codesByStep.get(step.step_id) ?? [])],
    reason: step.reason,
    blocked_reason: step.blocked_reason ?? '',
    before_blocking: step.before.blocking,
    before_hard: step.before.hard_count,
    has_after: step.after !== null,
    after_blocking: step.after?.blocking ?? false,
    after_hard: step.after?.hard_count ?? 0,
  }))
  const countStatus = (status: string): number => steps.filter((step) => step.status === status).length
  return {
    executed: steps.length,
    succeeded: countStatus('succeeded'),
    failed: countStatus('failed'),
    blocked: countStatus('blocked'),
    skipped_reason: result.skipped_reason ?? '',
    content_updated: result.content !== initialContent,
    steps,
  }
}

/** 一次「读取 + 恢复执行」的结果。 */
interface RecoveryRun {
  /** 执行器的完整返回值（含被采纳的 content 与剩余计划）。 */
  readonly result: ExecutePlanResult
  /** 与被采纳 content 对应的读取器证据（页数等）；一步都没采纳时就是首读。 */
  readonly finalOutcome: DocumentReadOutcome
}

/**
 * 把恢复计划真正执行掉（D-99 / R2 接线）。
 *
 * 能力边界（与 `plan()` / `executePlan()` 的分工一致，也是本工具的诚实点）：
 *   * **注入 `reRead`**：重新走 `readDocumentDetailed()` 真实读取同一份原件。
 *     执行器会核对 `asset_sha256` —— 读到别的材料一律不采纳。
 *     `switch_reader` 在本工具内**没有候选实现**（U1 按内容嗅探为每种媒体只注册一个 reader），
 *     能力如实抛错：执行器记 failed 并把该步留在 remaining，不假装"换过读取器"。
 *   * **不注入 `visionRead`**：D-81 规定视觉补读由 agent 完成（recruitment_page_image →
 *     read_image → recruitment_model_text_merge），插件不建第二个模型客户端。
 *     所以 `vision_read` 步不可执行，原样留在 `recovery` / `recovery.vision_pages` 里由 agent 接手。
 *   * **不注入 `askHuman`**：D-79/D-95 的人机闸门必须由真人放行，执行器自己连问都不问。
 *   * PDF 首读没有声明页数时**不注入 `factsFor`**：重读结果无法核对页覆盖（执行器铁律 ⑤），
 *     执行器会判 `READER_FACTS_REQUIRED`，而不是白跑一次真实读取。
 *
 * @param filePath - 绝对路径（重读同一份原件）。
 * @param initial - 首读结果。
 * @param initialFacts - 首读的 reader facts（source_meta 旁路）。
 * @param read - 真实读取入口（生产是 readDocumentDetailed；测试可注入）。
 * @param cfg - converter 配置（allowed_roots 生效）。
 * @param signal - 工具执行信号；重读也随它中止。
 */
async function runRecovery(
  filePath: string,
  initial: DocumentReadOutcome,
  initialFacts: ReaderFacts,
  read: typeof readDocumentDetailed,
  cfg: ResolvedConverterConfig,
  signal: AbortSignal | undefined,
): Promise<RecoveryRun> {
  // 每次读取的 source_meta 与它产出的 content 绑定：重判时按**当前 content**取 facts，
  // 不拿首读的页数去判重读出来的新内容（否则"页数现在知道了"会被误判成 blocking 没下降）。
  const outcomes = new WeakMap<DocumentContent, DocumentReadOutcome>()
  outcomes.set(initial.content, initial)
  const outcomeOf = (content: DocumentContent): DocumentReadOutcome => outcomes.get(content) ?? initial

  const options: ExecutePlanOptions = {
    facts: initialFacts,
    // 首读连页数都没声明时，重读结果同样无法核对页覆盖 → 交给执行器的 READER_FACTS_REQUIRED。
    ...(isPdfContent(initial.content) && declaredPageCountOf(initialFacts) === 0
      ? {}
      : { factsFor: (content: DocumentContent) => readerFactsFromSourceMeta(outcomeOf(content).source_meta) }),
    capabilities: {
      reRead: async (reason) => {
        if (reason === 'switch_reader') {
          throw new Error(
            '没有可切换的读取器：U1 按内容嗅探为每种媒体只注册一个 reader，'
            + 'switch_reader 在 recruitment_document_read 内不可执行',
          )
        }
        const next = await read(filePath, cfg, signal === undefined ? {} : { signal })
        outcomes.set(next.content, next)
        return next.content
      },
    },
    // 重读要等 converter 子进程（上限就是 cfg.timeout_ms）；执行器默认 30s 会误杀一次合法重读。
    step_timeout_ms: cfg.timeout_ms + 10_000,
  }
  const result = await executePlan(initial.content, options)
  return { result, finalOutcome: outcomeOf(result.content) }
}

/**
 * 读一份文档并产出「内容 + 判定 + 执行后的恢复计划 + 执行记录」。
 * @param filePath - 绝对路径。
 * @param cfg - converter 配置（allowed_roots 在这里生效）。
 * @param read - 真实读取入口（默认 readDocumentDetailed）。
 * @param signal - 工具执行信号。
 * @returns 规范输出值。
 */
async function readOne(
  filePath: string,
  cfg: ResolvedConverterConfig,
  read: typeof readDocumentDetailed,
  signal: AbortSignal | undefined,
): Promise<DocumentReadValue> {
  let initial: DocumentReadOutcome
  try {
    initial = await read(filePath, cfg, signal === undefined ? {} : { signal })
  } catch (error) {
    rethrowAsToolError(error)
  }
  // 必须走 source_meta 旁路拿 facts，否则 PDF 会全部误判 doc_page_count_unverified（HARD）。
  const initialFacts = readerFactsFromSourceMeta(initial.source_meta)
  const initialAssessment = assess(initial.content, initialFacts)
  const initialPlan = plan(initial.content, { assessment: initialAssessment, facts: initialFacts })

  // R2 接线（D-99）：plan() 只出计划，这里把能自动执行的动作真正跑掉。
  const { result: execution, finalOutcome } = await runRecovery(
    filePath, initial, initialFacts, read, cfg, signal,
  )
  // 输出的内容 / 判定 / 计划一律取**执行后**的：被采纳的重读结果才是这份材料现在的真相。
  const content = execution.content
  const sourceMeta = finalOutcome.source_meta
  const assessment = execution.remaining.assessment
  const recovery = execution.remaining

  return {
    path: filePath,
    media_type: content.media_type,
    reader_id: content.reader_id,
    reader_version: content.reader_version,
    asset_sha256: content.asset_sha256,
    completeness: content.completeness,
    needs_visual: content.needs_visual,
    page_count: pageCountOf(content, sourceMeta),
    source_chars: content.text.length,
    text: content.text,
    blocks: content.blocks.map((block) => ({
      block_id: block.block_id,
      kind: block.kind,
      order: block.order,
      page: pageOf(block.locator),
      text: block.text,
    })),
    assessment: {
      completeness: assessment.completeness,
      blocking: assessment.blocking,
      // D-97 第一批：**版式与顺序不阻断结构化**。
      // 模型的结构化能力只依赖文字本身；左右分栏的阅读顺序、图片有没有核过，
      // 不影响"把文字抽成字段"。这些留给第二批（版面分析 + 图片分类修好）再严格。
      // 真正阻断结构化的只有"文字本身不可用"：空文件、乱码、编码读不出。
      blocking_for_structure: STRUCTURE_BLOCKING_CODES.some((code) => assessment.blocking_codes.includes(code)),
      layout_only_blocking: assessment.layout_only_blocking === true,
      blocking_codes: [...assessment.blocking_codes],
      soft_codes: [...assessment.soft_codes],
      actions: assessment.actions.map((action) => ({
        action: action.action,
        codes: [...action.codes],
        blocking: action.blocking,
      })),
      issues: assessment.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
        message: issue.message,
        suggested_action: issue.suggested_action,
        retryable: issue.retryable,
        page: pageOf(issue.locator),
      })),
    },
    recovery: {
      plan_id: recovery.plan_id,
      blocking: recovery.blocking,
      next: recovery.next,
      requires_model: recovery.requires_model,
      model_image_support: recovery.model_image_support,
      // 只输出 1-based 页码（number[]）。**不能**展开 `recovery.vision`：那是
      // VisionPageRequest 对象数组，schema 声明的是 number[]，混出去会 INVALID_TOOL_OUTPUT。
      // 帧补读没有页号 → 不出现在这里（不把帧号谎报成页码，见执行器 bindStep）。
      vision_pages: [...recovery.summary.vision_pages],
      execution: toExecutionValue(execution, initialPlan, initial.content),
      steps: recovery.steps.map((step) => {
        const base = {
          step_id: step.step_id,
          action: step.action,
          role: step.role,
          blocking: step.blocking,
          status: step.status,
          codes: [...step.codes],
          problem: step.problem,
        }
        return step.blocked_reason === null ? base : { ...base, blocked_reason: step.blocked_reason }
      }),
      notes: [...recovery.notes],
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredDocumentReadTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Read one local PDF/DOCX/PNG/JPEG into canonical content with a quality assessment and a '
      + `recovery plan. Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; '))
    },
  }
}

/**
 * 读取器注入点：**只为测试可替换**（生产入口不传，默认走 readDocumentDetailed）。
 * 被替换的只是 U1 的真实读取；U3 的接线（plan → executePlan → reRead → 输出记录）仍然是真实代码。
 */
export interface DocumentReadDeps {
  readonly read?: typeof readDocumentDetailed
}

/**
 * 造真实的多格式文档读取工具。
 * @param cfg - 已解析的 converter 配置。
 * @param deps - 读取器注入点（测试用；生产不传）。
 * @returns 工具定义。
 */
export function createDocumentReadTool(
  cfg: ResolvedConverterConfig,
  deps: DocumentReadDeps = {},
): ReadonlyToolDefinition {
  const read = deps.read ?? readDocumentDetailed
  return {
    name: TOOL_NAME,
    description:
      'Read ONE local document (PDF, DOCX, PNG or JPEG) and return everything the next step needs: '
      + 'canonical content (text + blocks with stable block_id), a quality assessment, the remaining recovery '
      + 'plan, and a record of the recovery steps this tool already executed. '
      + 'The reader is chosen by content sniffing, not by extension; a mismatch is reported as an issue. '
      + 'assessment.blocking=true means DO NOT proceed to trusted structuring / screening until the listed '
      + 'recovery steps are done. This tool executes retry/switch_reader steps itself by re-reading the same '
      + 'file (recovery.execution says what ran and whether the returned content was replaced); it never '
      + 'executes human_review steps (a real person must decide at the human gate) and never calls a model. '
      + 'recovery.next says what comes next (structure | repair | human). vision_read steps stay in '
      + 'recovery.steps and their 1-based pages in recovery.vision_pages: render them with '
      + 'recruitment_page_image, read the image with your own image tool, then call '
      + 'recruitment_model_text_merge. Unreadable input throws instead of returning a fake complete document. '
      + 'Read-only: it never writes the database.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as DocumentReadValue
        const lines: string[] = [
          `document ${v.media_type} via ${v.reader_id}@${v.reader_version} `
            + `(completeness=${v.completeness}, needs_visual=${String(v.needs_visual)}, `
            + `pages=${v.page_count}, chars=${v.source_chars}, blocks=${v.blocks.length})`,
          `  sha256=${v.asset_sha256.slice(0, 16)}…`,
          `assessment: blocking=${String(v.assessment.blocking)} completeness=${v.assessment.completeness}`,
        ]
        if (v.assessment.blocking_codes.length > 0) {
          lines.push(`  blocking codes: ${v.assessment.blocking_codes.join(', ')}`)
        }
        if (v.assessment.soft_codes.length > 0) {
          lines.push(`  soft codes: ${v.assessment.soft_codes.join(', ')}`)
        }
        for (const issue of v.assessment.issues) {
          const page = issue.page > 0 ? ` p${issue.page}` : ''
          lines.push(`  ISSUE ${issue.severity} ${issue.code}${page} -> ${issue.suggested_action}: ${issue.message}`)
        }
        lines.push(
          `recovery: next=${v.recovery.next} blocking=${String(v.recovery.blocking)} `
            + `steps=${v.recovery.steps.length} vision_pages=[${v.recovery.vision_pages.join(',')}]`,
        )
        const e = v.recovery.execution
        lines.push(
          `recovery execution: ran ${e.executed} step(s) `
            + `(succeeded ${e.succeeded}, failed ${e.failed}, blocked ${e.blocked})`,
        )
        if (e.skipped_reason !== '') {
          lines.push(`  skipped: ${e.skipped_reason} (nothing to auto-repair: not blocking, or only SOFT issues)`)
        }
        if (e.content_updated) {
          lines.push('  content was REPLACED by an adopted recovery re-read — the content above is the new one')
        }
        for (const step of e.steps) {
          const blocked = step.blocked_reason === '' ? '' : ` [${step.blocked_reason}]`
          lines.push(`  RAN ${step.step_id} ${step.action} -> ${step.status}${blocked}: ${step.reason}`)
        }
        for (const step of v.recovery.steps) {
          lines.push(`  STEP ${step.step_id} ${step.action}/${step.role} (${step.status}) ${step.problem}`)
        }
        if (v.recovery.steps.some((step) => step.action === 'human_review')) {
          lines.push(
            'human_review steps are NOT executed by this tool: a real person must decide at the human '
            + 'gate before anything is trusted (D-79/D-95).',
          )
        }
        if (v.recovery.vision_pages.length > 0) {
          lines.push(
            'vision pages are for YOU to read: recruitment_page_image -> read_image -> '
            + 'recruitment_model_text_merge (D-81: the plugin never calls a model).',
          )
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseArgs(PARAMS, rawArgs)
      const signal = (exec as { signal?: AbortSignal } | undefined)?.signal
      return await readOne(args.path as string, cfg, read, signal)
    },
  }
}
