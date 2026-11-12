// 本插件注册的工具定义形状。
//
// 这是官方 ToolDefinition（docs/subsystems/tools.zh.md §ToolDefinition）的最小
// 结构子集：name / description / parameters / output{schema,render} / execute，
// 外加可选的 isConcurrencySafe。TS 类型只用于阅读与自检——运行时由 Node 的
// 类型擦除去掉，不产生任何 import（见 CONTRACT.md §0）。

/** 一条模型可见的文本内容块（官方 ContentBlock 的最小子集）。 */
export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

/** 可注册的工具定义（原始 JSON Schema 形态，校验由工具自己负责）。 */
export interface ReadonlyToolDefinition {
  /** 工具名，全局唯一。 */
  readonly name: string
  /** 模型可见说明。 */
  readonly description: string
  /** 模型可见的原始 JSON Schema（对象根）。 */
  readonly parameters: Record<string, unknown>
  /** 规范输出声明：schema 由注册表强制校验，render 生成模型可见内容。 */
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: unknown) => readonly TextBlock[]
  }
  /** 纯只读工具：允许与兄弟调用并行。 */
  readonly isConcurrencySafe?: (args: unknown) => boolean
  /**
   * 执行一次调用，只返回 output.schema 声明的规范值。
   * @param args - 模型给的 arguments（未校验）。
   * @param exec - 执行身份与取消信号（stub 工具不需要它）。
   * @returns 规范输出值。
   */
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>
}
