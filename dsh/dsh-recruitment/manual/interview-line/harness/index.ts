// S8 验收 harness：把**真实**的 S8 两个工具注册进一个最小 profile。
//
// 为什么需要它：产品注册点是 `src/index.ts`（归 W0 所有，本 lane 不许改）。
// 验收又必须证明「真实 headless 里模型能按一句自然语言调到工具」。所以这里只做
// 一件事——把 `src/tools/interview-{schedule,get}.ts` 的真实实现注册进去，不复制逻辑、
// 不 mock、不写假数据。产品集成由 W0 把同样两行 import 加进 `src/index.ts`（签名见
// `manual/interview-line/README.md` §5）。
import type { Context } from '@deepseek-ai/cordis'

import { resolveDatabaseConfig, type DatabaseConfig } from '../../../src/db/pool.ts'
import {
  createInterviewScheduleTool,
  unconfiguredInterviewScheduleTool,
} from '../../../src/tools/interview-schedule.ts'
import {
  createInterviewGetTool,
  unconfiguredInterviewGetTool,
} from '../../../src/tools/interview-get.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment-s8-demo`）。 */
export const name = 'recruitment-s8-demo'

/** 需要工具注册表。 */
export const inject = ['tools']

export interface Config {
  readonly database?: DatabaseConfig
}

/**
 * 注册 S8 两个工具。配置不完整时照常注册、调用报 NOT_CONFIGURED
 * （沿用 `src/index.ts` 的 `unconfiguredResumeReadTool` 做法）。
 * @param ctx - cordis 上下文（携带 tools 服务）。
 * @param config - 来自本 harness 的 `cordis.patch.yml`。
 * @param env - 环境变量表（默认 process.env；测试可注入）。
 */
export function apply(
  ctx: Context,
  config?: Config,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const database = resolveDatabaseConfig(config?.database ?? {}, env)
  const schedule = database.resolved === null
    ? unconfiguredInterviewScheduleTool(database.issues)
    : createInterviewScheduleTool(database.resolved)
  const get = database.resolved === null
    ? unconfiguredInterviewGetTool(database.issues)
    : createInterviewGetTool(database.resolved)
  ctx.tools.register(schedule)
  ctx.tools.register(get)
}
