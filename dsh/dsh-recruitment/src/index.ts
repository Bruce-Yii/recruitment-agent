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
//   recruitment_application_get        **只读**：申请全貌（阶段/材料/面试/转写/决策），Agent 一等读能力
//   recruitment_material_read          **只读**：受控读材料（哈希/结构摘要/可选正文），不再靠 shell 翻文件
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
//   recruitment_email_fetch            邮箱收件（30 → 31，EVENT 触发、LIVE）：IMAP → intake
//
// 配置来自 cordis.patch.yml 的 config 段，共四段：
//   converter: python_bin / converter_dir / allowed_roots   （resume_read + intake 要）
//   database:  host / port / user / database / tenant_id / actor_id / password_env
//              **密码只从环境变量读**（默认 RECRUITMENT_DB_PASSWORD），配置里不出现密码。
//   feishu:    cli（lark-cli 的**绝对路径**）/ timeout_ms / max_attempts / page_size / max_pages
//              **可选**：给了才装配飞书连接器传输层；缺省 = 不装配（连接器回读路径
//              BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉子进程）。**绝不放宽**成读 PATH / 环境变量。
//   mail:      host / user / password_env / port / tls / folder（IMAP 收件）+ smtp_*（发信 Host Action）
//              `${ENV}` 引用自行展开；未定义即 NOT_CONFIGURED（工具仍注册同名替身）。
//              发信走 /recruitment/api/action/email/send，不新增工具（工具数只 +1）。
//
// 缺任何一段时**工具仍然注册**，但调用返回 NOT_CONFIGURED 并列出缺什么——
// 不静默降级、不假装能读、不返回假数据（沿用 unconfiguredResumeReadTool 的既有做法）。
import type { Context } from '@deepseek-ai/cordis'
import type { ReadonlyToolDefinition } from './tools/definition.ts'
import { createCandidateGetTool, unconfiguredCandidateGetTool } from './tools/candidate-get.ts'
// task-75：Agent 一等业务读工具（申请/材料）。只读；DB 缺配置时注册 NOT_CONFIGURED 替身。
import {
  createBusinessReadTools,
  unconfiguredBusinessReadTools,
} from './tools/business-read.ts'
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
  JOB_DRAFT_TOOL,
  createJobDraftTool,
} from './tools/job-draft.ts'
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
// S9 记录线的人类核验入口（D-B）：NEEDS_REVIEW/UNVERIFIED → READY/VERIFIED，必须过 approval 闸门。
import {
  createInterviewRecordVerifyTool,
  unconfiguredInterviewRecordVerifyTool,
} from './tools/interview-record-verify.ts'
import { createScorecardSubmitTool } from './tools/scorecard-submit.ts'
import { createEvaluationSummarizeTool } from './tools/evaluation-summarize.ts'
import { createDecisionRecordTool } from './tools/decision-record.ts'
// 产品/业务 FAIL 修复 2（task-76）：高层「记录人类决策」Agent 动作。
// 服务端组装 basis_refs / AUTHORITY / SUMMARY / RUBRIC_VERSION / confirmation hash。
import { createRecordHumanDecisionTool } from './tools/record-human-decision.ts'
import {
  createStageAdvanceTool,
  unconfiguredStageAdvanceTool,
} from './tools/stage-advance.ts'
import { createTraceGetTool, unconfiguredTraceGetTool } from './tools/trace-get.ts'
// D-141 §4（最高优先项）：工具调用留痕接线。
// `src/domain/trace.ts` 的记录适配器实现完整，但产品执行路径从未调用它 →
// `recruitment.tool_call` 永远没有写入，`recruitment_trace_get` 的 TOOL_CALL 环永远是 gap。
// 修复方式：**不改 30 个工具本体**（它们不该认识追溯层），在注册处用包装器把每次真实调用
// 落成一行 `tool_call`。包装器见 `src/tools/traced.ts`。
import { withToolCallTrace } from './tools/traced.ts'
import { createConfigRoleTool, unconfiguredConfigRoleTool } from './tools/config-role.ts'
import { createConfigTeamTool, unconfiguredConfigTeamTool } from './tools/config-team.ts'
import { createConfigPipelineTool, unconfiguredConfigPipelineTool } from './tools/config-pipeline.ts'
// engine 层已退役（D-154），不再从 src/index.ts 引入；见 src/engine/VENDORED.md。
import { resolveDatabaseConfig, type DatabaseConfig } from './db/pool.ts'
import {
  closePool,
  createPool,
  withActor,
} from './db/pool.ts'
// email pump（durable_effect 派发器）：runtime.enabled 时与 G1 tick-loop 同源启停。
// 同源 = 同一个 pool / 同一个 withActor 语义 / 同一个 disposer（先 pump、再 tick-loop、再关池）。
import { createEmailPump, EMAIL_PUMP_INTERVAL_MS, type ReadbackFunction } from './runtime/email-pump.ts'
import { createSmtpTransport } from './connectors/mail/smtp.ts'
import {
  composeRuntime,
  registerRuntimeHttp,
  resolveRuntimeConfig,
  RuntimeStore,
  type RuntimeConfig,
  type RuntimeHostContext,
} from './runtime/index.ts'
// G1（事件自动驱动）：周期 tick-loop。**故意**从文件直连而不动 `./runtime/index.ts`
// 的公共出口（出口文件不在本 lane 写范围，且它只是 re-export，不影响装配）。
import { startTickLoop, type TickLoop } from './runtime/tick-loop.ts'
// G10（事件处置）：attach 调用与 sink 工厂同处一个装配段；**故意**直连文件不走 `./runtime/index.ts`
// （出口文件不在 lane 写范围，且它只是 re-export）。
import { createPgEventDispositionSink } from './runtime/event-runtime.ts'
import { resolveFeishuConnector, type FeishuConnectorConfig } from './connectors/feishu/index.ts'
// 邮箱收件（工具数 30 → 31）：工具注册面 + 配置 fail-closed 替身。
import {
  createWiredEmailFetchTool,
  unconfiguredEmailFetchTool,
  resolveMailConfig,
  emailFetchRuntime,
  type MailConnectorConfig,
  type ResolvedMailConfig,
} from './tools/email-fetch.ts'
// A 的收件编排与 IMAP 传输（子代理 mail-a-transport 实现；工具壳只消费其签名）。
import { fetchAndIngest } from './connectors/mail/orchestrator.ts'
import { createImapTransport } from './connectors/mail/transport.ts'
// C 的发信 Host Action（POST /recruitment/api/action/email/send，不新增工具）。
import { registerEmailSendHttp, type EmailSendHostContext } from './http/email-send.ts'
import { registerOverviewHttp, type OverviewHostContext } from './http/overview.ts'
import { registerRecruitingHttp, type RecruitingHostContext } from './http/recruiting.ts'
// owner-api-display（V5 看得见）：原文受控获取 + DSH 会话计量 + 任务状态（三个只读端点，
// loopback + sameOrigin + fail-closed）。注册器在 src/http/api-display.ts，返回 disposer。
import { registerApiDisplayHttp, type ApiDisplayHostContext } from './http/api-display.ts'
// D5 W1：Demo Actor（session→alias→HUMAN actor）+ Interviewer Host Remote Action
//（scorecard form/submit）。路由用 exact path，longest-prefix 优先于 /recruitment/api。
import { registerActorHttp, type ActorHostContext } from './http/actor.ts'
import { registerJobActionHttp, type JobActionHostContext } from './http/actions-job.ts'
import { registerActionsHttp, type ActionHostContext } from './http/actions.ts'
import { registerFeishuImportHttp, type FeishuImportHostContext } from './http/feishu-import.ts'
// D5 decision（task-56）：决策 facts 只读投影 + screening/evaluate（只读 domain）+
// decision/record facade（服务端组装 basis_refs）。独立前缀 /recruitment/api/decision。
import { registerDecisionHttp, type DecisionHostContext } from './http/decision-read.ts'
import {
  createDemoActorIdentity,
  type DemoActorIdentity,
  type DemoActorMapConfig,
} from './demo-actor/index.ts'
import { RecruitmentToolError } from './tools/errors.ts'
// D5-W3：面试官工作台只读投影（GET /recruitment/api/interviewer/overview）。
// 身份解析器由 W0 用 W1 的 Demo Actor 单例注入；未注入/未绑定 → 409 fail-closed。
import { registerInterviewerHttp, type InterviewerHostContext, type InterviewerSessionActorResolver } from './http/interviewer.ts'
import { resolveSessionActor } from './demo-actor/index.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment`，见 cordis.patch.yml）。 */
export const name = 'recruitment'

/**
 * **仅测试用**：记录最近一次 `apply()` 创建的 Demo Actor 身份，便于接线测试先绑定
 * session→alias 再调用注册表中的工具（产品代码从不读这个对象）。
 * 不改变 apply 的返回语义（cordis 插件返回值会被当 disposer 处理）。
 */
export const __testHooks: { demoActorIdentity: DemoActorIdentity | null } = { demoActorIdentity: null }

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
  /**
   * Demo Actor 的受控 alias → HUMAN actor UUID 映射（D5 W1；`work/d5/ACTOR-CONTRACT.md` §1）。
   * 浏览器永远只提交 alias，不提交 UUID。缺省 = 演示种子映射
   * （recruiter=…0103 / interviewer_a=…0104 / interviewer_b=…0105）；显式值非法时该 alias
   * fail-closed（写工具报 DEMO_ACTOR_UNMAPPED），不静默回退默认值。
   */
  readonly demo_actor_map?: DemoActorMapConfig
  /**
   * 邮箱收件连接器（`recruitment_email_fetch`，工具数 30 → 31）+ 发信 Host Action。
   * 同一账号：host/user/password_env/port/tls/folder（IMAP）+ smtp_*（SMTP 发信，不新增工具）。
   * password_env 只写变量名，口令只从环境变量读；`${ENV}` 引用由 resolveMailConfig 展开，
   * 未定义/未展开一律 fail-closed（工具仍注册替身，调用报 NOT_CONFIGURED）。
   */
  readonly mail?: MailConnectorConfig
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
  const converter = resolveConverterConfig(config?.converter ?? {}, env)
  const database = resolveDatabaseConfig(config?.database ?? {}, env)
  // 邮箱连接器：缺任何必填项（含 `${ENV}` 未展开）→ resolved=null，注册 NOT_CONFIGURED 替身；
  // 只有配置齐全才装配 A 的 IMAP transport + 收件编排（并发写，通过 runtime seam 注入）。
  const mail: { resolved: ResolvedMailConfig | null; issues: readonly string[] } = resolveMailConfig(config?.mail ?? {}, env)
  if (mail.resolved !== null) {
    emailFetchRuntime.fetch = fetchAndIngest as typeof emailFetchRuntime.fetch
    emailFetchRuntime.createTransport = (resolved) => createImapTransport(resolved as never)
  }
  // 飞书连接器（E4 接线）：**只从插件配置**装配传输层；没配 feishu.cli 时 connector=undefined，
  // 转写导入的连接器回读路径 fail-closed（BLOCKED/TRANSPORT_NOT_CONFIGURED，不拉子进程）。
  // env 只用于适配器判断凭据**存在性**（布尔），绝不用于取 CLI 路径（R7 / AGENTS.md §7.6）。
  const feishu = resolveFeishuConnector(config?.feishu ?? {}, env)
  // D5 W1：Demo Actor 身份 = alias→UUID 映射 + **进程内** session→alias 注册表。
  // 必须是单例：写工具（工具路径）与 Host Remote Action（浏览器路径）共享同一个 registry，
  // 否则“浏览器 PUT 绑定的 session”与“Agent 工具解析的 session”对不上。
  // 未绑定的 session 在任何写事务之前 fail-closed（DEMO_ACTOR_UNMAPPED），不回退 config.actor_id。
  const demoActors = createDemoActorIdentity(config?.demo_actor_map)
  const actorIdentity: DemoActorIdentity = demoActors.identity
  __testHooks.demoActorIdentity = actorIdentity
  if (demoActors.issues.length > 0) {
    const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
    logger?.warn(
      `recruitment: demo_actor_map 有非法配置（对应 alias 将 fail-closed）：${demoActors.issues.join('; ')}`,
    )
  }
  // 注：**不存在"预算"能力**（D-140）。DSH 本身不计费/不限流，产品不自造预算闸门；
  // 成本相关只做"展示 DSH 已有计量"（`/recruitment/api/usage`，见 src/http/），不拦截。
  // `src/budget/**` 保留为未启用模块（历史实现，从未安装），不要在此处重新接线。

  // 工作台面板（浏览器侧唯一数据入口）：只读、loopback、同源校验；见 src/http/overview.ts。
  //
  // **必须用可选注入，不能把 webServer 放进顶层 inject。** 顶层 inject 是硬依赖：
  // headless / tui 等没有 webServer 的 profile 下，整个插件会因此**不激活**，
  // 19 个工具一起消失——面板是加分项，不是插件存在的前提。
  // （2026-11-14：现注册 27 个工具；这里的历史数字只说明"整插件会被一起拖下水"。）
  // 有 webServer 才注册路由；没有就静默跳过（面板不可用，工具照常）。
  ctx.inject(['webServer'], (child) => {
    child.effect(
      () => registerOverviewHttp(child as unknown as OverviewHostContext, database.resolved, database.issues),
      'recruitment: workbench overview route',
    )
    // D5-W1：Demo Actor 绑定 + Interviewer Host Remote Action（scorecard form/submit）。
    // 只注册 exact path；回环 host 才注册（非回环 fail-closed 返回空 disposer）。
    child.effect(
      () => registerActorHttp(
        child as unknown as ActorHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
        },
      ),
      'recruitment: demo actor routes',
    )
    // D5 joblife：岗位关闭 Host Remote Action（独立前缀 /recruitment/api/job-action；
    // 不与 W1 `/recruitment/api/action` 前缀冲突）。loopback + 同源 + X-DSH-Session 绑定 HUMAN actor，
    // 单事务终止本岗位在途申请/未开始面试/未完成任务；`confirm:true` 是人的裁决，缺确认 400 零写入。
    child.effect(
      () => registerJobActionHttp(
        child as unknown as JobActionHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
        },
      ),
      'recruitment: job action route',
    )
    // D-119：全部写操作 Host Remote Action（P0 初筛/阶段/决策、P1 排期/转写、P2 设置）。
    // 与上面 actor 路由共享**同一个** `actorIdentity`（同一 session→alias registry），
    // 且 write 工具已经在用同一个 identity：浏览器 PUT 的绑定对 HTTP 写动作与 Agent 工具同时可见。
    child.effect(
      () => registerActionsHttp(
        child as unknown as ActionHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
          connector: feishu.connector,
          connectorIssues: feishu.issues,
        },
      ),
      'recruitment: write action routes',
    )
    // P0-7：真实飞书转写导入（真实 minute 只读回读 → 创建/复用 Meeting 绑定 → 复用
    // recruitment_transcript_import 域路径写 artifact/segment/record）。独立前缀
    // /recruitment/api/feishu；非回环 host 不注册（fail-closed）。feishuConfig 原样交给
    // resolveFeishuConnector（只从插件配置装配 cli+profile，绝不读 PATH/环境变量猜路径）。
    child.effect(
      () => registerFeishuImportHttp(
        child as unknown as FeishuImportHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
          feishuConfig: config?.feishu ?? {},
          env,
        },
      ),
      'recruitment: feishu import route',
    )
    // 邮箱发信 Host Action（C）：POST /recruitment/api/action/email/send，发信**不新增工具**。
    // 与写动作共享同一个 actorIdentity；loopback + 同源校验由路由自己保证（非回环零注册）。
    child.effect(
      () => registerEmailSendHttp(
        child as unknown as EmailSendHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
          mail: mail.resolved,
          mailIssues: mail.issues,
        },
      ),
      'recruitment: email send action route',
    )
    // D5 decision（task-56）：W2b 的决策事实与写入口。
    //   * GET  /recruitment/api/decision/facts                 申请钉住的 job/rubric（含 payload_hash）+
    //                                                         screening evaluation / S10 summary / AUTHORITY 事实；
    //   * POST /recruitment/api/decision/screening/evaluate    只读 domain 评估（人类动作入口）；
    //   * POST /recruitment/api/decision/record                facade：服务端组装 basis_refs（前端不传 hash）。
    // 与上面动作路由共享**同一个** `actorIdentity`（同一 session→alias registry）。
    child.effect(
      () => registerDecisionHttp(
        child as unknown as DecisionHostContext,
        {
          database: database.resolved,
          databaseIssues: database.issues,
          identity: actorIdentity,
        },
      ),
      'recruitment: decision facts/evaluate/record routes',
    )
    // D5-W2：Recruiting Workspace 只读投影（独立前缀 /recruitment/api/recruiting；
    // W0 独占接线，W2 不碰本文件）。action seam 由 W1 后续提供，未提供时写按钮 disabled。
    child.effect(
      () => registerRecruitingHttp(
        child as unknown as RecruitingHostContext,
        database.resolved,
        database.issues,
        {
          // D-119：写按钮的 seam 指向本 lane 的动作端点（UI 只 GET overview 拿可用性，
          // 点击 POST 到 seam；每个 seam 的 body 契约见 work/d5/actions/CONTRACT.md）。
          actionSeams: {
            screening_decide: '/recruitment/api/action/screening/decide',
            stage_advance: '/recruitment/api/action/stage/advance',
            decision_record: '/recruitment/api/action/decision/record',
            interview_schedule: '/recruitment/api/action/interview/schedule',
            transcript_import: '/recruitment/api/action/transcript/import',
            rubric_approve: '/recruitment/api/action/job/rubric-approve',
            // 设置页只有一个 seam：统一入口按 body.entity 分派 role/team/pipeline。
            recruiting_settings_write: '/recruitment/api/action/config',
          },
        },
      ),
      'recruitment: recruiting workspace route',
    )
    // D5-W3：面试官工作台（我的面试 / 简报 / Rubric / 授权材料 / 本人面评；只读投影）。
    // 身份 resolver 用 W1 的**同一个** `actorIdentity` 单例：再 new 一个 registry 会让浏览器
    // PUT 的 session→alias 绑定分裂（读路径永远 409），所以这里只适配、不另建身份来源。
    // 未绑定/非法 session → resolve 返回 undefined → 路由 409 DEMO_ACTOR_UNMAPPED（零行、零写入）。
    const interviewerSessionResolver: InterviewerSessionActorResolver = {
      resolve: (sessionId: string) => {
        try {
          return resolveSessionActor(actorIdentity, sessionId)
        } catch {
          return undefined
        }
      },
    }
    child.effect(
      () => registerInterviewerHttp(
        child as unknown as InterviewerHostContext,
        database.resolved,
        interviewerSessionResolver,
        database.issues,
      ),
      'recruitment: interviewer workspace route',
    )
    // owner-api-display（V5 看得见）：三个只读端点 ——
    //   GET|HEAD /recruitment/api/material/<material_id>/content（原件受控获取）
    //   GET      /recruitment/api/usage?session_id=…（DSH 会话计量，原样透出）
    //   GET      /recruitment/api/tasks/status（业务任务 / 卡住事件）
    // 必须返回 disposer：`child.effect` 把返回值当注销函数（返回 undefined 会在卸载时报错）。
    child.effect(
      () => registerApiDisplayHttp(child as unknown as ApiDisplayHostContext, {
        database: database.resolved,
        databaseIssues: database.issues,
      }),
      'recruitment: api display routes',
    )
  })

  // 任务运行时（Event → Business Task → Attempt → DSH Worker Session）。
  //
  // **默认关闭**：`config.runtime.enabled !== true` 时这一段什么都不做，产品 profile
  // 启动后不会多出任何 HTTP 口子。只有显式打开且数据库/Worker profile 配置齐全时，
  // 才注册回环 + 同源的 `/recruitment/runtime/*` 路由（见 src/runtime/http.ts）。
  //
  // 为什么仍用可选注入：与 overview 同理，headless/tui 等没有 webServer 的 profile
  // 不能因为运行时路由而让整个插件不激活（27 个工具必须照常存在）。
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
          // G1：tick-loop 的启动 promise。**声明在 try 之外**：这样下面的 catch 也能收尸，
          // 否则 store/effect 装配失败时那条持咨询锁的专用连接会一直挂到进程退出。
          let tickLoopReady: Promise<TickLoop | null> = Promise.resolve(null)
          // email pump disposer 同样**声明在 try 之外**：装配中途出错也要收掉定时器。
          let disposeEmailPump: (() => void) | null = null
          try {
            const store = new RuntimeStore({
              pool,
              tenantId: runtimeDb.tenant_id,
              actorId: runtimeDb.actor_id,
              notification: runtimeConfig.notification,
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
            // G10：事件处置记录（append-only）。必须在注册 HTTP 与启动 tick-loop **之前**挂上，
            // 否则第一轮 tick 路由掉的事件会"已终态但没有处置"，health 只能如实报缺口。
            // 不改 store.ts：处置是审计事实，写入口统一走 `createPgEventDispositionSink`（同一个 pool）。
            composed.events.attachDispositionSink(
              createPgEventDispositionSink(pool, runtimeDb.tenant_id),
            )
            const disposeHttp = registerRuntimeHttp(
              child as unknown as RuntimeHostContext,
              {
                store: composed.store,
                router: composed.router,
                events: composed.events,
                tasks: composed.tasks,
              },
            )
            // G1（事件自动驱动）：进程内**唯一的周期 tick**。
            //
            // 此前（engine 层未退役时）`router.tick()` 只被 `POST /recruitment/runtime/tick` 与 engine_effect 触发；
            // 没人手工发 HTTP 时，`event_inbox` 里的 RECEIVED 永远不动 —— 事件驱动是假的。
            // 这里用**专用连接**持有 `recruitment:tick` 咨询锁再开 setInterval：
            //   * 多实例同时起：只有抢到锁的实例派发，其余实例记一次 warn 后明确放弃（不抢活）；
            //   * 连接断了锁自动释放，下一个实例能接手（互斥来自 PG，不是进程内标志位）；
            //   * **不建 cron / 不引队列**（v1.0 不建生产级调度，D-109 复用 PG）；
            //     用户级定时仍走 DSH 既有 `schedule_*`，G1 不接线、不改它。
            tickLoopReady = runtimeConfig.autoTick
              ? startTickLoop({
                pool,
                router: composed.router,
                intervalMs: runtimeConfig.tickIntervalMs,
                logger: {
                  warn(message: string): void {
                    const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
                    logger?.warn(message)
                  },
                },
              })
              : Promise.resolve(null)
            // engine 层（vendor 自 dsh-superagent）已于 2026-11-18 退役：无人写入、且绕过 tick 的 advisory lock；见 docs/17 D-154。真要做外发时按 src/engine/VENDORED.md 再接。

            // ── email pump（与 runtime 同源启停）────────────────────────────
            // 条件：mail 与 database 都配置齐全（mail.resolved !== null，且 runtimeDb 已存在）。
            // 未配置时整段不启动（不注册任何定时器）；runtime.enabled=false 时更外层 if 直接跳过。
            let emailPumpTimer: ReturnType<typeof setInterval> | null = null
            if (mail.resolved !== null) {
              try {
                const smtp = createSmtpTransport(mail.resolved)
                // 回执：用组合键（收件人 + 主题完全一致 + 发送时间 ± 窗口）查收件箱。
                // 真机事实：服务端会改写 Message-ID，按 external_id 匹配必然落空。
                // 若 IMAP transport 不可用则由 pump 记 UNREADABLE / NOT_FOUND，绝不假报 CONFIRMED。
                const readback: ReadbackFunction = async (query) => {
                  const factory = emailFetchRuntime.createTransport
                  if (factory === null) return null
                  const transport = factory(mail.resolved as never) as {
                    listNew(input: { since_uid?: number; limit?: number }): Promise<readonly { uid: number; subject: string; from: string; message_id: string; date: string }[]>
                    fetchMessage(uid: number): Promise<{ message_id: string; subject: string; headers: Readonly<Record<string, string>>; text: string }>
                    disconnect(): Promise<void>
                  }
                  try {
                    const envelopes = await transport.listNew({ limit: 100 })
                    const center = Date.parse(query.sent_at)
                    for (const env of envelopes) {
                      if (env.subject !== query.subject) continue
                      const at = Date.parse(env.date)
                      if (!Number.isFinite(at) || !Number.isFinite(center)) continue
                      if (Math.abs(at - center) > query.time_window_ms) continue
                      const message = await transport.fetchMessage(env.uid)
                      const headersTo = message.headers.to ?? ''
                      if (headersTo !== '' && !headersTo.includes(query.to)) continue
                      return {
                        matched: true,
                        matched_message_id: message.message_id || env.message_id,
                        method: 'subject+recipient+time_window',
                      }
                    }
                    return null
                  } finally {
                    await transport.disconnect().catch(() => undefined)
                  }
                }
                const pump = createEmailPump({
                  database: runtimeDb,
                  mail: mail.resolved,
                  transport: async (m) => {
                    const sent = await smtp.send({
                      to: m.to,
                      subject: m.subject,
                      body_summary: m.text,
                      ...(m.headers === undefined ? {} : { headers: m.headers }),
                    })
                    return { messageId: sent.messageId }
                  },
                  readback,
                  io: {
                    // 与 G1 完全同源：同一个 pool + 同一个 actor 语义（set_config is_local）。
                    withWrite: (fn) => withActor(pool, runtimeDb.actor_id, fn),
                    markReadback: async (client, effectId, mark) => {
                      // 只写回执列；带 tenant 隔离 + status='SENT' 守卫，不碰 status/record_version。
                      await (client as { query(text: string, values: readonly unknown[]): Promise<unknown> }).query(
                        `update recruitment.durable_effect
                            set receipt_payload = $2::jsonb,
                                readback_state = $3,
                                last_readback_at = now()
                          where id = $1 and tenant_id = $4 and status = 'SENT'`,
                        [effectId, JSON.stringify(mark.receipt_payload), mark.readback_state, runtimeDb.tenant_id],
                      )
                    },
                  },
                })
                const warn = (message: string): void => {
                  const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
                  logger?.warn(`recruitment: email pump tick 失败：${message}`)
                }
                emailPumpTimer = setInterval(() => {
                  void pump.tick().catch((error: unknown) => {
                    warn(error instanceof Error ? error.message : String(error))
                  })
                }, EMAIL_PUMP_INTERVAL_MS)
                disposeEmailPump = () => {
                  if (emailPumpTimer !== null) { clearInterval(emailPumpTimer); emailPumpTimer = null }
                  void smtp.close().catch(() => undefined)
                  pump.dispose()
                }
              } catch (error) {
                // fail-soft：装配失败只 warn，不拖垮整个 runtime effect。
                const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
                logger?.warn(`recruitment: email pump 装配失败（未启动）：${error instanceof Error ? error.message : String(error)}`)
              }
            }
            return () => {
              disposeHttp()
              // 关闭顺序：先停 email pump（定时器 + dispose），再停周期 tick 并释放咨询锁，最后关池。
              disposeEmailPump?.()
              void tickLoopReady
                .then((loop) => loop?.dispose())
                .catch(() => undefined)
                .finally(() => { void closePool(pool) })
            }
          } catch (error) {
            // 装配失败也要先把 tick-loop 收掉（可能已经抢到锁），再关池。
            disposeEmailPump?.()
            void tickLoopReady
              .then((loop) => loop?.dispose())
              .catch(() => undefined)
              .finally(() => { void closePool(pool) })
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
    ? createApplicationIntakeTool(
      { converter: converter.resolved, database: database.resolved },
      { identity: actorIdentity },
    )
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
  // task-75（产品/业务 FAIL 修复 1）：申请/材料两个一等只读工具。
  // 为什么 material_read 还要 converter：TEXT 模式要读受控原件（allowed_roots + sha256），
  // 缺 converter 时工具仍注册，TEXT 模式如实返回 CONVERTER_NOT_CONFIGURED（结构摘要/哈希照常可用）。
  const businessReadTools = database.resolved === null
    ? unconfiguredBusinessReadTools(database.issues, converter.issues)
    : createBusinessReadTools({
      database: database.resolved,
      ...(converter.resolved === null
        ? { converterIssues: converter.issues }
        : { converter: converter.resolved }),
    })
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
    : createJobCreateTool(database.resolved, { identity: actorIdentity })
  const jobUpdate = database.resolved === null
    ? unconfiguredJobUpdateTool(database.issues)
    : createJobUpdateTool(database.resolved, { identity: actorIdentity })
  // rubric 批准入口（docs/23 N7）：写工具，必须带 approval 闸门（D-79，缺省 = 拒绝）。
  const jobRubricApprove = database.resolved === null
    ? unconfiguredJobRubricApproveTool(database.issues)
    : createJobRubricApproveTool(database.resolved, {
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })
  // 岗位/Rubric 草案生成（D5 joblife）：**纯函数、不连库、不写库**。
  // 无外部输入也可用；输出只是草案 + 理由 + 缺失项，人改+确认后走 jobCreate/jobRubricApprove 版本化。
  const jobDraft = createJobDraftTool()

  // ── S8 面试线：只要 database。
  const interviewSchedule = database.resolved === null
    ? unconfiguredInterviewScheduleTool(database.issues)
    : createInterviewScheduleTool(database.resolved, {
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })
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
      identity: actorIdentity,
    })
  const transcriptRead = database.resolved === null
    ? unconfiguredTranscriptReadTool(database.issues)
    : createTranscriptReadTool(database.resolved)
  // 记录核验（D-B）：写工具，必须带 approval 闸门（D-79，缺省 = 拒绝）。
  // 它是 interview_record 从 NEEDS_REVIEW/UNVERIFIED 到 READY/VERIFIED 的**唯一产品入口**
  // （DC-23 要求 READY+VERIFIED 才能被决策引用）。
  const interviewRecordVerify = database.resolved === null
    ? unconfiguredInterviewRecordVerifyTool(database.issues)
    : createInterviewRecordVerifyTool(database.resolved, {
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })

  // ── S10 评价线：三个都要 database；decision 还要 approval（D-79，缺省 = 拒绝）。
  const scorecardSubmit = database.resolved === null
    ? notConfiguredTool(
      'recruitment_scorecard_submit',
      'S10: one HUMAN interviewer submits their own scorecard for one interview round.',
      database.issues,
    )
    : createScorecardSubmitTool({
      database: database.resolved,
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })
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
    : createDecisionRecordTool({
      database: database.resolved,
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })

  // 产品/业务 FAIL 修复 2（task-76）：与 UI facade 同级的高层动作。
  // Agent 只传业务语义 + 人的原话；basis/hash/阶段码/审批全部由服务端组装。
  const recordHumanDecision = database.resolved === null
    ? notConfiguredTool(
      'record_human_decision',
      'High-level human-decision recording (the human already decided): the server assembles every derived field.',
      database.issues,
    )
    : createRecordHumanDecisionTool({
      database: database.resolved,
      approval: resolveApproval(ctx),
      identity: actorIdentity,
    })

  // 阶段推进（N8，方案 D）：只承认已发生的事实，不新增任何授权。
  const stageAdvance = database.resolved === null
    ? unconfiguredStageAdvanceTool(database.issues)
    : createStageAdvanceTool(database.resolved, { identity: actorIdentity })
  // 执行追溯（Notion 08 §11.3 第 9 步）：只读。
  const traceGet = database.resolved === null
    ? unconfiguredTraceGetTool(database.issues)
    : createTraceGetTool(database.resolved)
  // 企业自建配置（角色权限范围 / 招聘团队 / 流水线模板）：配置是数据，企业自己建。
  const configTools = database.resolved === null
    ? [
        unconfiguredConfigRoleTool(database.issues),
        unconfiguredConfigTeamTool(database.issues),
        unconfiguredConfigPipelineTool(database.issues),
      ]
    : [
        createConfigRoleTool(database.resolved, { identity: actorIdentity }),
        createConfigTeamTool(database.resolved, { identity: actorIdentity }),
        createConfigPipelineTool(database.resolved, { identity: actorIdentity }),
      ]

  const tools: readonly ReadonlyToolDefinition[] = [
    resumeRead,
    documentRead,
    ...structureTools,
    candidateGet,
    ...businessReadTools,
    jobGet,
    jobCreate,
    jobUpdate,
    jobRubricApprove,
    jobDraft,
    intake,
    evaluate,
    stageAdvance,
    interviewSchedule,
    interviewGet,
    transcriptImport,
    transcriptRead,
    interviewRecordVerify,
    scorecardSubmit,
    evaluationSummarize,
    decisionRecord,
    recordHumanDecision,
    traceGet,
    ...configTools,
    pageImage,
    modelTextMerge,
    // 邮箱收件（30 → 31）：配置齐全时走 A 的真实传输+编排；缺项时同名替身报 NOT_CONFIGURED。
    mail.resolved === null || database.resolved === null || converter.resolved === null
      ? unconfiguredEmailFetchTool([
        ...mail.issues,
        ...(database.resolved === null ? database.issues : []),
        ...(converter.resolved === null ? converter.issues : []),
      ])
      : createWiredEmailFetchTool({
        database: database.resolved,
        converter: converter.resolved,
        mail: mail.resolved,
        identity: actorIdentity,
      }),
  ].map(withStructuredResultContract)
    // D-141 §4：**最后**再套一层工具调用留痕（trace 必须是离注册表最近的执行边界）。
    //
    // 顺序为什么是"契约层在内、追溯层在外"：
    //   * `withStructuredResultContract` 是**纯展示层**（只给 3 个工具的 description 追加形状说明，
    //     浅拷贝、不改 execute / args / 返回值），所以两种顺序今天对"记录什么"没有语义差别；
    //   * 但追溯层记录的必须是**注册表真正收到并执行的那一次调用**（最终参数、最终返回值）。
    //     把 trace 放在最后 = 它包住最终注册形态；以后若有人加一个会改结果的包装，按
    //     `map(contract).map(<结果变换>).map(trace)` 的顺序它落在 trace**内侧**、照样被留痕；
    //     反之把 trace 写在里面，将来任何加在它后面的包装都会**逃过留痕**且没人会注意到。
    //   * `database.resolved === null`（数据库未配置）时包装器是恒等函数：没有 trace 存储就
    //     不记，绝不让"本来不依赖 DB 的只读工具"因为留痕而失败。
    //   * `identity` 与写工具用的是**同一个** Demo Actor 单例：留痕的 actor 与真正写库的 actor
    //     同源；解析不到时包装器回退 `database.actor_id`（不伪造会话身份）。
    .map(withToolCallTrace({ database: database.resolved, identity: actorIdentity }))
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
