// S10 评价线 · headless 演示用的宿主插件入口（**只含面评 + 汇总**）。
//
// 为什么拆成两个文件：`decision-record.ts` 在并行开发中，缺席时会让整个插件 import 失败，
// 把"面评能不能在真实会话里跑"这件事一起拖死。面评/汇总与决策是两条独立的演示路径，
// 各自一个入口：本文件给 X/Y/负例用，`plugin-eval.mjs` 给决策用。
//
// 与产品入口 `src/index.ts` 的差异（如实登记）：注册点是本文件，不是 index.ts；
// W0 集成时把两个 factory 原样搬过去即可。
import { resolveDatabaseConfig } from '../../src/db/pool.ts'
import { createScorecardSubmitTool } from '../../src/tools/scorecard-submit.ts'
import { createEvaluationSummarizeTool } from '../../src/tools/evaluation-summarize.ts'

export const name = 'recruitment-evaluation-core'

export const inject = ['tools']

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

export function apply(ctx, config, env = process.env) {
  const { resolved, issues } = resolveDatabaseConfig(config?.database ?? {}, env)
  const tools = resolved === null
    ? [
        unconfigured('recruitment_scorecard_submit', issues),
        unconfigured('recruitment_evaluation_summarize', issues),
      ]
    : [
        createScorecardSubmitTool({ database: resolved }),
        createEvaluationSummarizeTool({ database: resolved }),
      ]
  for (const tool of tools) {
    // 一个工具的输出 schema 不合官方子集时，**不要让整个插件加载失败**——否则
    // 另一条本来能跑的演示路径也被一起拖死。这里把它降级成"注册即报 schema 不合"。
    try {
      ctx.tools.register(tool)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[recruitment-evaluation-core] ${tool.name} 注册失败：${message}`)
      ctx.tools.register({
        ...unconfigured(tool.name, [`output schema unsupported by DSH: ${message}`]),
        async execute() {
          const failure = new Error(`SCHEMA_UNSUPPORTED: ${message}`)
          failure.code = 'SCHEMA_UNSUPPORTED'
          throw failure
        },
      })
    }
  }
}
