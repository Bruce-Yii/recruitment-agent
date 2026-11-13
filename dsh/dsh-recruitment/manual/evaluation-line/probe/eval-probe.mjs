// 最小探针：只为证明 `dsh --profile recruitment --patch <overlay.yml>` 能把一个
// **仓库内文件 URL 的 cordis 插件**插进真实 profile（不改 src/index.ts、不建新 profile）。
//
// 它不连库、不写任何东西；注册一个空参数工具，调用返回 {ok:true, probe:'evaluation-line'}。
// 验证完即可删除，但保留成本为零，且以后排查 patch 层问题时可直接复跑。

export const name = 'evaluation-probe'

export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.register({
    name: 'recruitment_eval_probe',
    description: 'S10 评价线的 patch 层探针：只证明 --patch 能插入仓库内插件模块。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: `probe: ${JSON.stringify(value)}` }]
      },
    },
    async execute() {
      return { ok: true, probe: 'evaluation-line', at: 'plugin-eval-probe' }
    },
  })
}
