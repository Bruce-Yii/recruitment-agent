// @recruitment/dsh-recruitment 宿主半部分：cordis 插件入口。
//
// 没有浏览器半部分（无 dsh.client 声明），不向 Web GUI 提供任何东西。
// 依赖只有 tools 服务：注册表就绪后 apply 才会被调用。
//
// 五个只读工具 + 两个 S6/S7 工具：
//   recruitment_resume_read            读本地简历 PDF（真调 converter/）
//   recruitment_resume_serialize       结构化的有序文本投影
//   recruitment_structure_validate     校验模型给出的结构化结果
//   recruitment_candidate_get          查候选人（stub，等 PG 接线）
//   recruitment_job_get                查岗位 / Rubric（**真查 PG**，契约 tool-contracts.md §2）
//   recruitment_application_intake     **S6 写库**：PDF → candidate → application
//   recruitment_screening_evaluate     **S7 只读**：对一条申请出带证据的建议
//
// 配置来自 cordis.patch.yml 的 config 段，共两段：
//   converter: python_bin / converter_dir / allowed_roots   （resume_read + intake 要）
//   database:  host / port / user / database / tenant_id / actor_id / password_env
//              **密码只从环境变量读**（默认 RECRUITMENT_DB_PASSWORD），配置里不出现密码。
//
// 缺任何一段时**工具仍然注册**，但调用返回 NOT_CONFIGURED 并列出缺什么——
// 不静默降级、不假装能读、不返回假数据（沿用 unconfiguredResumeReadTool 的既有做法）。
import type { Context } from '@deepseek-ai/cordis'
import type { ReadonlyToolDefinition } from './tools/definition.ts'
import { candidateGetTool } from './tools/candidate-get.ts'
import { createJobGetTool, unconfiguredJobGetTool } from './tools/job-get.ts'
import { createResumeReadTool } from './tools/resume-read.ts'
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
import { resolveDatabaseConfig, type DatabaseConfig } from './db/pool.ts'
import { RecruitmentToolError } from './tools/errors.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment`，见 cordis.patch.yml）。 */
export const name = 'recruitment'

/** 所需服务：工具注册表。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  readonly converter?: ConverterConfig
  /** 业务库（S6 写 / S7 读）。密码只在环境变量里。 */
  readonly database?: DatabaseConfig
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

  const resumeRead = converter.resolved === null
    ? unconfiguredResumeReadTool(converter.issues)
    : createResumeReadTool(converter.resolved)
  // 结构化层两端：序列化（给模型看）与校验（防幻觉）。未配置时也注册，调用报 NOT_CONFIGURED。
  const structureTools = converter.resolved === null
    ? []
    : [createResumeSerializeTool(converter.resolved), createStructureValidateTool(converter.resolved)]

  // S6 两段配置都要：没有 converter 读不了 PDF，没有 database 落不了库。
  const intake = converter.resolved !== null && database.resolved !== null
    ? createApplicationIntakeTool({ converter: converter.resolved, database: database.resolved })
    : unconfiguredApplicationIntakeTool([...converter.issues, ...database.issues])
  // S7 只要 database。
  const evaluate = database.resolved === null
    ? unconfiguredScreeningEvaluateTool(database.issues)
    : createScreeningEvaluateTool(database.resolved)
  // 岗位 / Rubric 是**真查库**（tool-contracts.md §2）：没配置就报 NOT_CONFIGURED，
  // 绝不退回 fixture——那样会让岗位数据看起来是 LIVE 的假象。
  const jobGet = database.resolved === null
    ? unconfiguredJobGetTool(database.issues)
    : createJobGetTool(database.resolved)
  // 模型兜底两步（D-81）：A 渲染交图（agent 自己用 read_image 读）、
  // B 校验后合并。两步都只要 converter，不调模型、不写库。
  const pageImage = converter.resolved === null
    ? unconfiguredPageImageTool(converter.issues)
    : createPageImageTool(converter.resolved)
  const modelTextMerge = converter.resolved === null
    ? unconfiguredModelTextMergeTool(converter.issues)
    : createModelTextMergeTool(converter.resolved)

  const tools: readonly ReadonlyToolDefinition[] = [
    resumeRead,
    ...structureTools,
    candidateGetTool,
    jobGet,
    intake,
    evaluate,
    pageImage,
    modelTextMerge,
  ].map(withStructuredResultContract)
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
