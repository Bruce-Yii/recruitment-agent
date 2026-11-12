// @recruitment/dsh-recruitment 宿主半部分：cordis 插件入口。
//
// 没有浏览器半部分（无 dsh.client 声明），不向 Web GUI 提供任何东西。
// 依赖只有 tools 服务：注册表就绪后 apply 才会被调用。
//
// 三个工具（不多不少）：
//   recruitment_resume_read     读本地简历 PDF（真调 converter/）
//   recruitment_candidate_get   查候选人（stub，等 PG 接线）
//   recruitment_job_get         查岗位 / Rubric（stub，等 PG 接线）
//
// 配置来自 cordis.patch.yml 的 config 段。resume_read 需要的三项（python_bin /
// converter_dir / allowed_roots）缺任何一项时，该工具仍然注册，但调用会返回
// NOT_CONFIGURED 并列出缺什么——不静默降级，也不假装能读。
import type { Context } from '@deepseek-ai/cordis'
import type { ReadonlyToolDefinition } from './tools/definition.ts'
import { candidateGetTool } from './tools/candidate-get.ts'
import { jobGetTool } from './tools/job-get.ts'
import { createResumeReadTool } from './tools/resume-read.ts'
import { createResumeSerializeTool, createStructureValidateTool } from './tools/structure-tools.ts'
import { resolveConverterConfig, type ConverterConfig } from './tools/converter.ts'
import { RecruitmentToolError } from './tools/errors.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment`，见 cordis.patch.yml）。 */
export const name = 'recruitment'

/** 所需服务：工具注册表。 */
export const inject = ['tools']

/** 插件配置。 */
export interface Config {
  readonly converter?: ConverterConfig
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
 * 挂载三个只读招聘工具。
 * @param ctx - cordis 上下文，携带 tools 服务。
 * @param config - 插件配置（来自 cordis.patch.yml）。
 */
export function apply(ctx: Context, config?: Config): void {
  const { resolved, issues } = resolveConverterConfig(config?.converter ?? {})
  const resumeRead = resolved === null
    ? unconfiguredResumeReadTool(issues)
    : createResumeReadTool(resolved)
  // 结构化层两端：序列化（给模型看）与校验（防幻觉）。未配置时也注册，调用报 NOT_CONFIGURED。
  const structureTools = resolved === null
    ? []
    : [createResumeSerializeTool(resolved), createStructureValidateTool(resolved)]
  const tools: readonly ReadonlyToolDefinition[] = [resumeRead, ...structureTools, candidateGetTool, jobGetTool]
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}

