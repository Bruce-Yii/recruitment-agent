// @recruitment/dsh-recruitment 宿主半部分：cordis 插件入口。
//
// 没有浏览器半部分（无 dsh.client 声明），不向 Web GUI 提供任何东西。
// 依赖只有 tools 服务：注册表就绪后 apply 才会被调用。
//
// 工具全集（S3–S10 一条 Golden Path，按阶段）：
//   recruitment_resume_read            读本地简历 PDF（真调 converter/）
//   recruitment_resume_serialize       结构化的有序文本投影
//   recruitment_structure_validate     校验模型给出的结构化结果
//   recruitment_candidate_get          查候选人（stub，等 PG 接线）
//   recruitment_job_get                查岗位 / Rubric（**真查 PG**，契约 tool-contracts.md §2）
//   recruitment_job_create             **S3 写库**：岗位 + rubric（rubric 落 PENDING，人类批准）
//   recruitment_job_update             **S3 写库**：改岗位 / 出新 rubric 版本
//   recruitment_application_intake     **S6 写库**：PDF → candidate → application
//   recruitment_screening_evaluate     **S7 只读**：对一条申请出带证据的建议
//   recruitment_interview_schedule     **S8 写库**：约面试（幂等 CREATE-only）
//   recruitment_interview_get          **S8 只读**：面试 + 会议绑定 + 转写 + 面评状态
//   recruitment_transcript_import      **S9 写库**：人工导入 / 飞书连接器回读转写（raw_text 不可变）
//   recruitment_transcript_read        **S9 只读**：转写状态投影
//   recruitment_scorecard_submit       **S10 写库**：一位 HUMAN 面试官交自己那份面评
//   recruitment_evaluation_summarize   **S10 只读**：汇总投影（不产建议结论）
//   recruitment_decision_record        **S10 写库**：记录人已做出的决定（必须过 ctx.approval）
//
// 配置来自 cordis.patch.yml 的 config 段，共三段：
//   converter: python_bin / converter_dir / allowed_roots   （resume_read + intake 要）
//   database:  host / port / user / database / tenant_id / actor_id / password_env
//              **密码只从环境变量读**（默认 RECRUITMENT_DB_PASSWORD），配置里不出现密码。
//   feishu:    cli（lark-cli 的**绝对路径**）/ timeout_ms / max_attempts / page_size / max_pages
//              **可选**：给了才装配飞书连接器传输层；缺省 = 不装配（连接器回读路径
//              BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉子进程）。**绝不放宽**成读 PATH / 环境变量。
//
// 缺任何一段时**工具仍然注册**，但调用返回 NOT_CONFIGURED 并列出缺什么——
// 不静默降级、不假装能读、不返回假数据（沿用 unconfiguredResumeReadTool 的既有做法）。
import type { Context } from '@deepseek-ai/cordis'
import type { ReadonlyToolDefinition } from './tools/definition.ts'
import { createCandidateGetTool, unconfiguredCandidateGetTool } from './tools/candidate-get.ts'
import { createJobGetTool, unconfiguredJobGetTool } from './tools/job-get.ts'
import { createResumeReadTool } from './tools/resume-read.ts'
import { createDocumentReadTool, unconfiguredDocumentReadTool } from './tools/document-read.ts'
import { createResumeSerializeTool, createStructureValidateTool } from './tools/structure-tools.ts'
import { resolveConverterConfig, type ConverterConfig } from './tools/converter.ts'
import {
  createApplicationIntakeTool,
  unconfiguredApplicationIntakeTool,
} from './tools/application-intake.ts'
import {
  createScreeningEvaluateTool,
  unconfiguredScreeningEvaluateTool,
} from './tools/screening-evaluate.ts'
import {
  createPageImageTool,
  unconfiguredPageImageTool,
} from './tools/page-image.ts'
import {
  createModelTextMergeTool,
  unconfiguredModelTextMergeTool,
} from './tools/vision-fallback.ts'
import {
  createJobCreateTool,
  createJobUpdateTool,
  unconfiguredJobCreateTool,
  unconfiguredJobUpdateTool,
} from './tools/job-create.ts'
import {
  createJobRubricApproveTool,
  unconfiguredJobRubricApproveTool,
} from './tools/job-rubric-approve.ts'
import {
  createInterviewScheduleTool,
  unconfiguredInterviewScheduleTool,
} from './tools/interview-schedule.ts'
import { createInterviewGetTool, unconfiguredInterviewGetTool } from './tools/interview-get.ts'
import {
  createTranscriptImportTool,
  unconfiguredTranscriptImportTool,
} from './tools/transcript-import.ts'
import {
  createTranscriptReadTool,
  unconfiguredTranscriptReadTool,
} from './tools/transcript-read.ts'
import { createScorecardSubmitTool } from './tools/scorecard-submit.ts'
import { createEvaluationSummarizeTool } from './tools/evaluation-summarize.ts'
import { createDecisionRecordTool } from './tools/decision-record.ts'
import { resolveDatabaseConfig, type DatabaseConfig } from './db/pool.ts'
import {
  closePool,
  createPool,
} from './db/pool.ts'
import {
  composeRuntime,
  registerRuntimeHttp,
  resolveRuntimeConfig,
  RuntimeStore,
  type RuntimeConfig,
  type RuntimeHostContext,
} from './runtime/index.ts'
import { resolveFeishuConnector, type FeishuConnectorConfig } from './connectors/feishu/index.ts'
import { registerOverviewHttp, type OverviewHostContext } from './http/overview.ts'
import { RecruitmentToolError } from './tools/errors.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment`，见 cordis.patch.yml）。 */
export const name = 'recruitment'

/**
 * 所需服务：工具注册表 + 人机批准通道（D-79：正式决策只能由人放行）。
 *
 * **`webServer` 故意不在这里**：它是可选依赖，用 `ctx.inject(['webServer'], …)` 在 apply 内
 * 按需注入（工作台面板的只读路由）。放进这里会让 headless/tui 等无 webServer 的 profile
 * 整个插件不激活——面板不能成为工具存在的前提。
 */
export const inject = ['tools', 'approval']

/**
 * `ctx.approval` 的窄接口（只取 `request`）。
 *
 * 为什么不直接写 `ctx.approval`：cordis 的服务是**声明式**的，没在 `inject` 里声明
 * 就访问会抛 `cannot get property "approval" without inject`（真实 headless 实测）。
 * 这里声明了 inject，但仍做一层惰性取值 + 兜底：宿主异常时降级成
 * `'unavailable'`，让决策工具按 D-79 **fail closed**，而不是把宿主异常漏给模型。
 */
interface ApprovalGateway {
  request(req: {
    agent?: unknown
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<string>
}

/**
 * 取批准通道；取不到时返回一个恒 `'unavailable'` 的网关（= 决策工具拒绝写库）。
 * @param ctx - cordis 上下文。
 * @returns 满足 `ApprovalGateway` 的对象，永不抛。
 */
function resolveApproval(ctx: Context): ApprovalGateway {
  const lookup = (): unknown => {
    try {
      const direct = (ctx as unknown as { approval?: unknown }).approval
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // 没有该服务：继续尝试 ctx.get
    }
    try {
      const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
      return typeof getter === 'function' ? getter.call(ctx, 'approval') : undefined
    } catch {
      return undefined
    }
  }
  return {
    async request(req): Promise<string> {
      const service = lookup() as { request?: (r: unknown) => Promise<string> } | undefined
      if (service === undefined || service === null || typeof service.request !== 'function') {
        return 'unavailable'
      }
      return await service.request(req)
    },
  }
}

/** 插件配置。 */
export interface Config {
  readonly converter?: ConverterConfig
  /** 业务库（S6 写 / S7 读）。密码只在环境变量里。 */
  readonly database?: DatabaseConfig
  /**
   * 飞书连接器（**可选**）。只有给了 `cli`（lark-cli 的绝对路径）才装配传输层；
   * 缺省 = 不装配，`recruitment_transcript_import` 的连接器回读路径返回
   * BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉任何子进程。
   */
  readonly feishu?: FeishuConnectorConfig
  /**
   * 任务运行时（Event → Business Task → Attempt → DSH Worker Session）。
   * **默认关闭**：只有 `enabled: true` 才注册 `/recruitment/runtime/*` 路由；
   * 缺配置时逐条列 issues，不静默降级成假运行时。见 `src/runtime/config.ts`。
   */
  readonly runtime?: RuntimeConfig
}

/**
 * 结构化结果的形状（`contracts/prompt.md` §3 / `schema.json` 1.0.0 的模型可见摘要）。
 *
 * 为什么写进 tool description：一个自解释的系统不该让模型 grep `src/tools/*.ts`
 * 才知道参数长什么样——2026-11-13 的自然语言实验里，它花了第 5–13 步做这件事。
 * description 是模型每轮都能看见的稳定位置，所以形状必须在这里也有一份；完整规则
 * 仍在 `contracts/prompt.md`（本段只是它的可执行摘要，冲突时以契约为准）。
 */
const STRUCTURED_RESULT_CONTRACT = [
  'STRUCTURED RESULT CONTRACT (schema_version 1.0.0) — ONE plain JSON object, no code fences, no commentary:',
  '{"prompt_version":"1.0.0","schema_version":"1.0.0","block_count":<number of block lines>,',
  ' "sections":[{"label":"<label>","block_ids":["1","2"],'
    + '"ignored":{"reason":"<ignored reason>","detail":"<optional>"}}],',
  ' "fields":{',
  '  "name":{"state":"present","value":"<verbatim substring of a cited block>","block_ids":["1"]},',
  '  "phone":{...},"email":{...},',
  '  "work_experience":{"state":"present","value":[{"company":{"value":"…","block_ids":["4"]},'
    + '"title":{"value":"…","block_ids":["4"]},"start":{"value":"…","block_ids":["4"]},'
    + '"end":{"value":"…","block_ids":["4"]},"block_ids":["4"],"attribution":"single_block"}],"block_ids":["4"]},',
  '  "education":{... same entry shape but school/major/degree instead of company/title ...}}}',
  'RULES:',
  '1) every block id appears exactly once across sections[].block_ids, and block_count equals the number of input block lines;',
  '2) label is one of: contact, summary, work_experience, internship, project, research, education, skill, award, '
    + 'certificate, publication, self_evaluation, other;',
  '3) state is one of: present, absent, unreadable — all five fields are ALWAYS present, even when unreadable;',
  '4) present => value is a character-for-character substring of a cited block and block_ids is non-empty; '
    + 'absent => block_ids is [];',
  '5) present => NO reason key; absent/unreadable => reason is one of: not_mentioned, label_without_readable_value, '
    + 'value_masked_or_redacted, multiple_conflicting_values, glyphs_unreadable, image_only_no_text_layer, '
    + 'page_or_block_unread, no_section_heading, section_present_unsplittable, rows_outside_any_section, '
    + 'cross_block_assembly_refused, reading_order_unverified;',
  '6) never format, normalize, translate, complete or "fix" a value; never assemble an experience row across blocks; '
    + 'never put age/gender/marital status/native place into any value;',
  '7) ignored.reason is one of: platform_watermark, page_number_or_header_footer, qr_code_or_ad, empty_or_symbol_only, '
    + 'non_resume_document, duplicate_block, glyphs_unreadable — and an ignored block must never appear in any '
    + 'field block_ids.',
].join('\n')

/** 需要这份形状说明的工具（模型在这里提交 `result_json` / `structured_json`）。 */
const STRUCTURED_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'recruitment_structure_validate',
  'recruitment_application_intake',
])

/**
 * 把结构化形状追加到来参工具的 description 末尾（不碰工具实现，纯展示层）。
 * @param tool - 已构造的工具定义。
 * @returns 同一个工具，或在需要时一份带追加说明的浅拷贝。
 */
function withStructuredResultContract(tool: ReadonlyToolDefinition): ReadonlyToolDefinition {
  if (!STRUCTURED_RESULT_TOOLS.has(tool.name)) return tool
  return { ...tool, description: `${tool.description}\n\n${STRUCTURED_RESULT_CONTRACT}` }
}

/**
 * 配置不完整时用的替身：注册同一个工具名，但调用即报 NOT_CONFIGURED。
 * 这样模型能看见"为什么读不了"，而不是看到一个不存在的工具。
 */
function unconfiguredResumeReadTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: 'recruitment_resume_read',
    description:
      'Read one local resume PDF. Currently NOT CONFIGURED: the plugin config is missing '
      + 'python_bin / converter_dir / allowed_roots. Calls return NOT_CONFIGURED.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly { type: 'text'; text: string }[] {
        return [{ type: 'text', text: `recruitment_resume_read is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError(
        'NOT_CONFIGURED',
        `resume reader is not configured: ${issues.join('; ')}`,
      )
    },
  }
}

/**
 * 配置不完整时用的通用替身（S10 三个工具没有自己的 `unconfigured*`）。
 *
 * 语义与各模块自带的替身一致：**注册同一个工具名**，调用即报 NOT_CONFIGURED 并列出缺什么。
 * 这样模型看见的是"为什么不能用"，而不是一个不存在的工具——也不会误以为库里没有数据。
 * @param toolName - 要占位的工具名。
 * @param summary - 一句话说明这个工具做什么。
 * @param issues - 缺失的配置项。
 * @returns 一个调用即抛 `NOT_CONFIGURED` 的工具定义。
 */
function notConfiguredTool(
  toolName: string,
  summary: string,
  issues: readonly string[],
): ReadonlyToolDefinition {
  return {
    name: toolName,
    description: `${summary} Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: true,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly { type: 'text'; text: string }[] {
        return [{ type: 'text', text: `${toolName} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', `${toolName} is not configured: ${issues.join('; ')}`)
    },
  }
}

/**
 * 挂载只读招聘工具 + S6/S7 工具。
 * @param ctx - cordis 上下文，携带 tools 服务。
 * @param config - 插件配置（来自 cordis.patch.yml）。
 * @param env - 环境变量表（默认 process.env；测试可注入）。
 */
export function apply(
  ctx: Context,
  config?: Config,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const converter = resolveConverterConfig(config?.converter ?? {})
  const database = resolveDatabaseConfig(config?.database ?? {}, env)
  // 飞书连接器（E4 接线）：**只从插件配置**装配传输层；没配 feishu.cli 时 connector=undefined，
  // 转写导入的连接器回读路径 fail-closed（BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉子进程）。
  // env 只用于适配器判断凭据**存在性**（布尔），绝不用于取 CLI 路径（R7 / AGENTS.md §7.6）。
  const feishu = resolveFeishuConnector(config?.feishu ?? {}, env)
  // 工作台面板（浏览器侧唯一数据入口）：只读、loopback、同源校验；见 src/http/overview.ts。
  //
  // **必须用可选注入，不能把 webServer 放进顶层 inject。** 顶层 inject 是硬依赖：
  // headless / tui 等没有 webServer 的 profile 下，整个插件会因此**不激活**，
  // 19 个工具一起消失——面板是加分项，不是插件存在的前提。
  // 有 webServer 才注册路由；没有就静默跳过（面板不可用，工具照常）。
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () => registerOverviewHttp(child as unknown as OverviewHostContext, database.resolved, database.issues),
      'recruitment: workbench overview route',
    )
  })

  // 任务运行时（Event → Business Task → Attempt → DSH Worker Session）。
  //
  // **默认关闭**：`config.runtime.enabled !== true` 时这一段什么都不做，产品 profile
  // 启动后不会多出任何 HTTP 口子。只有显式打开且数据库/Worker profile 配置齐全时，
  // 才注册回环 + 同源的 `/recruitment/runtime/*` 路由（见 src/runtime/http.ts）。
  //
  // 为什么仍用可选注入：与 overview 同理，headless/tui 等没有 webServer 的 profile
  // 不能因为运行时路由而让整个插件不激活（19 个工具必须照常存在）。
  if (config?.runtime?.enabled === true) {
    const runtime = resolveRuntimeConfig(config.runtime, env)
    if (runtime.resolved === null || database.resolved === null) {
      const issues = [...(runtime.resolved === null ? runtime.issues : []), ...database.issues]
      const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
      logger?.warn(`recruitment: 任务运行时未注册（fail closed）：${issues.join('; ')}`)
    } else {
      const runtimeDb = database.resolved
      const runtimeConfig = runtime.resolved
      ctx.inject(['webServer'], (child) => {
        child.effect(() => {
          const pool = createPool({ ...runtimeDb, max: 4 })
          try {
            const store = new RuntimeStore({
              pool,
              tenantId: runtimeDb.tenant_id,
              actorId: runtimeDb.actor_id,
            })
            const composed = composeRuntime({
              store,
              worker: runtimeConfig.worker,
              pendingBatchSize: runtimeConfig.pendingBatchSize,
              maxRouteAttempts: runtimeConfig.maxRouteAttempts,
              leaseMs: runtimeConfig.leaseMs,
              maxAttempts: runtimeConfig.maxAttempts,
              resumeSessions: runtimeConfig.resumeSessions,
              workspaceRoot: runtimeConfig.workspaceRoot,
              workerType: 'DSH_WORKER',
              workerId: `router:${process.pid}`,
            })
            const disposeHttp = registerRuntimeHttp(
              child as unknown as RuntimeHostContext,
              {
                store: composed.store,
                router: composed.router,
                events: composed.events,
                tasks: composed.tasks,
              },
            )
            return () => {
              disposeHttp()
              void closePool(pool)
            }
          } catch (error) {
            void closePool(pool)
            throw error
          }
        }, 'recruitment: task runtime routes')
      })
    }
  }

  const resumeRead = converter.resolved === null
    ? unconfiguredResumeReadTool(converter.issues)
    : createResumeReadTool(converter.resolved)
  // 结构化层两端：序列化（给模型看）与校验（防幻觉）。
  // 未配置时也注册占位（注释与行为必须一致：模型看到的是"为什么不能用"，不是一个消失的工具）。
  const structureTools = converter.resolved === null
    ? [
      notConfiguredTool(
        'recruitment_resume_serialize',
        'Project a resume PDF into ordered, block-id-labelled text for structuring.',
        converter.issues,
      ),
      notConfiguredTool(
        'recruitment_structure_validate',
        'Validate a model-produced structured result against the resume blocks.',
        converter.issues,
      ),
    ]
    : [createResumeSerializeTool(converter.resolved), createStructureValidateTool(converter.resolved)]

  // S6 两段配置都要：没有 converter 读不了 PDF，没有 database 落不了库。
  const intake = converter.resolved !== null && database.resolved !== null
    ? createApplicationIntakeTool({ converter: converter.resolved, database: database.resolved })
    : unconfiguredApplicationIntakeTool([...converter.issues, ...database.issues])
  // S7 只要 database。
  const evaluate = database.resolved === null
    ? unconfiguredScreeningEvaluateTool(database.issues)
    : createScreeningEvaluateTool(database.resolved)
  // 候选人档案也是**真查库**（2026-11-14 起；之前是 fixture stub）：没配置就报 NOT_CONFIGURED，
  // 绝不退回样例数据 —— 否则"查候选人"会返回一个编造的人。
  const candidateGet = database.resolved === null
    ? unconfiguredCandidateGetTool(database.issues)
    : createCandidateGetTool(database.resolved)
  // 岗位 / Rubric 是**真查库**（tool-contracts.md §2）：没配置就报 NOT_CONFIGURED，
  // 绝不退回 fixture——那样会让岗位数据看起来是 LIVE 的假象。
  const jobGet = database.resolved === null
    ? unconfiguredJobGetTool(database.issues)
    : createJobGetTool(database.resolved)
  // U3 收口：多格式统一入口（PDF/DOCX/PNG/JPEG）→ 质量判定 → 恢复计划。
  // 之前解析层能力齐全但没暴露成工具，agent 调不到（R2 假接线）。
  const documentRead = converter.resolved === null
    ? unconfiguredDocumentReadTool(converter.issues)
    : createDocumentReadTool(converter.resolved)
  // 模型兜底两步（D-81）：A 渲染交图（agent 自己用 read_image 读）、
  // B 校验后合并。两步都只要 converter，不调模型、不写库。
  const pageImage = converter.resolved === null
    ? unconfiguredPageImageTool(converter.issues)
    : createPageImageTool(converter.resolved)
  const modelTextMerge = converter.resolved === null
    ? unconfiguredModelTextMergeTool(converter.issues)
    : createModelTextMergeTool(converter.resolved)

  // ── S3 岗位线：只要 database。写路径与读路径同一个库，没配置就报 NOT_CONFIGURED，
  // 绝不退回 fixture（那会让岗位数据看起来是 LIVE 的假象）。
  const jobCreate = database.resolved === null
    ? unconfiguredJobCreateTool(database.issues)
    : createJobCreateTool(database.resolved)
  const jobUpdate = database.resolved === null
    ? unconfiguredJobUpdateTool(database.issues)
    : createJobUpdateTool(database.resolved)
  // rubric 批准入口（docs/23 N7）：写工具，必须带 approval 闸门（D-79，缺省 = 拒绝）。
  const jobRubricApprove = database.resolved === null
    ? unconfiguredJobRubricApproveTool(database.issues)
    : createJobRubricApproveTool(database.resolved, { approval: resolveApproval(ctx) })

  // ── S8 面试线：只要 database。
  const interviewSchedule = database.resolved === null
    ? unconfiguredInterviewScheduleTool(database.issues)
    : createInterviewScheduleTool(database.resolved, { approval: resolveApproval(ctx) })
  const interviewGet = database.resolved === null
    ? unconfiguredInterviewGetTool(database.issues)
    : createInterviewGetTool(database.resolved)

  // ── S9 转写线：只要 database。raw_text 不可变、来源必须显式标 provenance。
  // 连接器回读依赖由插件配置 `feishu` 装配：没配 = 默认态（BLOCKED，不拉子进程）。
  const transcriptImport = database.resolved === null
    ? unconfiguredTranscriptImportTool(database.issues)
    : createTranscriptImportTool(database.resolved, {
      connector: feishu.connector,
      connector_issues: feishu.issues,
    })
  const transcriptRead = database.resolved === null
    ? unconfiguredTranscriptReadTool(database.issues)
    : createTranscriptReadTool(database.resolved)

  // ── S10 评价线：三个都要 database；decision 还要 approval（D-79，缺省 = 拒绝）。
  const scorecardSubmit = database.resolved === null
    ? notConfiguredTool(
      'recruitment_scorecard_submit',
      'S10: one HUMAN interviewer submits their own scorecard for one interview round.',
      database.issues,
    )
    : createScorecardSubmitTool({ database: database.resolved, approval: resolveApproval(ctx) })
  const evaluationSummarize = database.resolved === null
    ? notConfiguredTool(
      'recruitment_evaluation_summarize',
      'S10: read-only evaluation summary projection (never writes a decision).',
      database.issues,
    )
    : createEvaluationSummarizeTool({ database: database.resolved })
  const decisionRecord = database.resolved === null
    ? notConfiguredTool(
      'recruitment_decision_record',
      'Record a decision a HUMAN already made: S10 (STAGE/FINAL) or S7 (SCREENING). IN_CHAT confirmation per D-95: no second click.',
      database.issues,
    )
    : createDecisionRecordTool({ database: database.resolved, approval: resolveApproval(ctx) })

  const tools: readonly ReadonlyToolDefinition[] = [
    resumeRead,
    documentRead,
    ...structureTools,
    candidateGet,
    jobGet,
    jobCreate,
    jobUpdate,
    jobRubricApprove,
    intake,
    evaluate,
    interviewSchedule,
    interviewGet,
    transcriptImport,
    transcriptRead,
    scorecardSubmit,
    evaluationSummarize,
    decisionRecord,
    pageImage,
    modelTextMerge,
  ].map(withStructuredResultContract)
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
