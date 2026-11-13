// S10 评价线 · headless 演示用的**宿主插件入口**（不是产品入口）。
//
// 为什么需要它：产品入口 `src/index.ts` 由 W0 独占（本轮不许改），而验收要求
// "真实 headless 会话里 agent 真的调到这三个工具"。所以这里用 DSH 自带的
// `--patch <overlay.yml>` + `insert` 列表，把**仓库内的模块（file URL）**插进一个
// 真实的 headless profile：agent loop / 工具注册表 / JSON Schema 校验 / 会话日志
// 全是 DSH 自己的，只有"注册点"从 index.ts 换成了本文件。
//
// 与产品入口的差异（必须如实写进报告）：
//   1. 注册点是本文件，不是 `src/index.ts`（W0 集成时把下面 3 个 factory 原样搬过去即可）；
//   2. 本文件额外把 `ctx.approval` 作为窄接口传给 decision 工具（D-79）；
//      W0 在 index.ts 里同样要传，否则决策工具一律 `APPROVAL_UNAVAILABLE`（fail closed）。
//
// 配置（来自 overlay 的 insert 条目 config）：
//   database: { host, port, user, database, password_env, tenant_id, actor_id }
//   密码只从环境变量读（默认 RECRUITMENT_DB_PASSWORD），配置里不出现密码。
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createEvaluationSummarizeTool } from '../../src/tools/evaluation-summarize.ts'
import { createDecisionRecordTool } from '../../src/tools/decision-record.ts'

export const name = 'recruitment-evaluation'

export const inject = ['tools']

/** 一个"没配置"的替身：调用即报 NOT_CONFIGURED，绝不假装能读/能写。 */
function unconfigured(toolName, issues) {
  return {
    name: toolName,
    description: `${toolName} is not configured: ${issues.join('; ')}`,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render() {
        return [{ type: 'text', text: `not configured: ${issues.join('; ')}` }]
      },
    },
    async execute() {
      const error = new Error(`NOT_CONFIGURED: ${issues.join('; ')}`)
      error.code = 'NOT_CONFIGURED'
      throw error
    },
  }
}

/**
 * 懒取 `ctx.approval`：cordis 在插件**没有声明 inject** 时访问服务会直接抛
 * `cannot get property "approval" without inject`（真实 headless 实测），所以这里
 * 必须 try/catch：取不到就 fail-closed 成 `'unavailable'`，让工具报
 * `DECISION_REQUIRES_HUMAN(APPROVAL_UNAVAILABLE)`，而不是把宿主异常当工具结果漏给模型。
 *
 * W0 集成到 `src/index.ts` 时的正确做法：在插件里声明 `inject: ['tools','approval']`
 * 并把 `ctx.approval` 传给 `createDecisionRecordTool`（D-79）；不要依赖本文件的兜底。
 */
function approvalGateway(ctx) {
  const lookup = () => {
    try {
      const direct = ctx.approval
      if (direct !== undefined && direct !== null) return direct
    } catch {
      // 没 inject → 正常情况，继续尝试 ctx.get
    }
    try {
      return typeof ctx.get === 'function' ? ctx.get('approval') : undefined
    } catch {
      return undefined
    }
  }
  return {
    async request(req) {
      const service = lookup()
      if (service === undefined || service === null || typeof service.request !== 'function') {
        return 'unavailable'
      }
      return await service.request(req)
    },
  }
}

/**
 * 挂载 S10 三个工具。
 * @param ctx - cordis 上下文（`tools` 已就绪；`approval` 按需懒取）
 * @param config - overlay 的 insert 条目 config
 * @param env - 环境变量表（默认 process.env；测试可注入）
 */
export function apply(ctx, config, env = process.env) {
  const { resolved, issues } = resolveDatabaseConfig(config?.database ?? {}, env)
  const approval = approvalGateway(ctx)
  const tools = resolved === null
    ? [
        unconfigured('recruitment_scorecard_submit', issues),
        unconfigured('recruitment_evaluation_summarize', issues),
        unconfigured('recruitment_decision_record', issues),
      ]
    : [
        createScorecardSubmitTool({ database: resolved }),
        createEvaluationSummarizeTool({ database: resolved }),
        createDecisionRecordTool({ database: resolved, approval }),
      ]
  for (const tool of tools) ctx.tools.register(tool)
}
