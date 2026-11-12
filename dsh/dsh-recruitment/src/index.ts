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
//   recruitment_job_get                查岗位 / Rubric（stub，等 PG 接线）
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
import { jobGetTool } from './tools/job-get.ts'
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
    jobGetTool,
    intake,
    evaluate,
    pageImage,
    modelTextMerge,
  ]
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
