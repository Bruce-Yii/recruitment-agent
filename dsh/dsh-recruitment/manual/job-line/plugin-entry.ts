// 岗位线（S3）的**临时** cordis 插件入口：只挂两个写工具，不改 `src/index.ts`。
//
// 为什么需要它：本 lane 只允许新建 `src/tools/job-create.ts`，而 `src/index.ts`
// 被冻结（W0 集成前不得改动）。所以真实 headless 证据只能靠 `--patch` 叠加一个
// 独立入口：patch.yml 的 insert 条目把 `name: './plugin-entry.ts'` 锚定成 file URL
// （dsh-app-boot 的 `anchorInsertedPluginNames`），DSH 用同一条模块管线加载它。
//
// 与 `src/index.ts` 的差别只有两点：
//   1. 插件名是 `recruitment-job-line`（不是 `recruitment`），配置行 id 与之一致；
//   2. 只注册 `recruitment_job_create` / `recruitment_job_update`。
// 配置解析、未配置替身、`ctx.tools.register()` 全部沿用 `src/index.ts` 的既有做法：
// 缺配置时工具照常注册，调用报 NOT_CONFIGURED 并列出缺什么（不静默降级）。
import type { Context } from '@deepseek-ai/cordis'

import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'
import { resolveDatabaseConfig, type DatabaseConfig } from '../../src/db/pool.ts'
import {
  createJobCreateTool,
  createJobUpdateTool,
  unconfiguredJobCreateTool,
  unconfiguredJobUpdateTool,
} from '../../src/tools/job-create.ts'

/** 稳定 cordis 插件名（配置行 id 是 `recruitment-job-line`，见 patch.yml）。 */
export const name = 'recruitment-job-line'

/** 所需服务：工具注册表。 */
export const inject = ['tools']

/** 插件配置（只有一段 database；密码永远只从环境变量读）。 */
export interface Config {
  readonly database?: DatabaseConfig
}

/**
 * 挂载岗位写工具。
 *
 * `env` 不开放成第三个参数：cordis 只传 `(ctx, config)`，真实入口必须从
 * `process.env` 读密码；`resolveDatabaseConfig` 的第二个参数就是环境变量表，
 * 所以这里显式传 `process.env`，与 `src/index.ts` 的默认值等价。
 * @param ctx - cordis 上下文，携带 tools 服务。
 * @param config - 插件配置（来自 patch.yml 的 config 段）。
 */
export function apply(ctx: Context, config?: Config): void {
  const database = resolveDatabaseConfig(config?.database ?? {}, process.env)
  const tools: readonly ReadonlyToolDefinition[] = database.resolved === null
    ? [unconfiguredJobCreateTool(database.issues), unconfiguredJobUpdateTool(database.issues)]
    : [createJobCreateTool(database.resolved), createJobUpdateTool(database.resolved)]
  for (const tool of tools) {
    // register() 返回的 disposer 由所在 fiber 接管：插件卸载即注销。
    ctx.tools.register(tool)
  }
}
