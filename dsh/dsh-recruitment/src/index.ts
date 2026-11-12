// @recruitment/dsh-recruitment 宿主半部分：cordis 插件入口，注册三个只读工具。
//
// 没有浏览器半部分（无 dsh.client 声明），不向 Web GUI 提供任何东西。
// 依赖只有 tools 服务：注册表就绪后 apply 才会被调用。
//
// 三个工具（不多不少）：
//   recruitment_resume_read     读简历（stub blocks）
//   recruitment_candidate_get   查候选人（stub）
//   recruitment_job_get         查岗位 / Rubric（stub）
// 全部只读：本包源码里没有 fs / net / DB 路径，见 CONTRACT.md §6 的静态自检。
import type { Context } from '@deepseek-ai/cordis'
import type { ReadonlyToolDefinition } from './tools/definition.ts'
import { candidateGetTool } from './tools/candidate-get.ts'
import { jobGetTool } from './tools/job-get.ts'
import { resumeReadTool } from './tools/resume-read.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment`，见 cordis.patch.yml）。 */
export const name = 'recruitment'

/** 所需服务：工具注册表。 */
export const inject = ['tools']

/** 本插件公开的全部工具，顺序即注册顺序。 */
const TOOLS: readonly ReadonlyToolDefinition[] = [resumeReadTool, candidateGetTool, jobGetTool]

/**
 * 挂载三个只读招聘工具。
 * @param ctx - cordis 上下文，携带 tools 服务。
 */
export function apply(ctx: Context): void {
  for (const tool of TOOLS) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
