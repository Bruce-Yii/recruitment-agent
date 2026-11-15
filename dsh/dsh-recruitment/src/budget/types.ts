// task-78 / DESIGN §3.1：预算模块的冻结类型集合。
//
// 纯类型文件：**零运行时导入、零副作用**，可被任何层（宿主工具、客户端、测试）安全引用。
// 字段名与 DESIGN §3.1 逐字一致；改字段 = 改冻结契约，必须先由 Owner 裁决。

/** 可计预算的两类 HR 任务。 */
export type BudgetTaskClass = 'SCREENING' | 'DECISION'

/** 一类任务的额度（tokens 以 provider 上报的 usage 为准，steps 以闸门放行次数为准）。 */
export interface BudgetLimits {
  readonly max_tokens: number
  readonly max_steps: number
}

/** 逐键配置来源（单一来源可核对：profile 显式值 / env 注入 / 默认值）。 */
export type BudgetSource = 'profile' | 'env' | 'default'

/** 一次 usage 读取的来源，必须如实标注（禁止把 unavailable 说成真实 usage）。 */
export type BudgetUsageSource = 'session_projection.tokenUsage' | 'tokenMeter.measure' | 'unavailable'

/** 一条 fail-closed 配置问题（不抛异常，由调用方决定降级策略）。 */
export interface BudgetConfigIssues {
  readonly key: string
  readonly message: string
}

/** `resolveBudgetConfig()` 的结果。`issues` 永不为 null。 */
export interface ResolvedBudgetConfig {
  readonly limits: Readonly<Record<BudgetTaskClass, BudgetLimits>>
  readonly task_class: BudgetTaskClass | 'AUTO'
  readonly default_class: BudgetTaskClass
  readonly tool_class_map: Readonly<Record<string, BudgetTaskClass>>
  readonly status_tool: boolean
  /**
   * 预算闸门总开关（lead 2026-11-16 裁决，additive）。
   *
   * 默认 `true`；显式 `false` = 关闭预算闸门（不注册 guard / status 工具，**不是错误**，
   * 不产生 issue）。非布尔值视为非法 → issue + 回退 `true`（fail-closed 到「开」并显式报错）。
   */
  readonly enabled: boolean
  readonly handoff_owner: string | null
  /** 逐键来源，例：'DECISION_MAX_TOKENS' -> 'profile' */
  readonly sources: Readonly<Record<string, BudgetSource>>
  /** fail-closed 逐条问题（不抛异常；调用方决定是否降级） */
  readonly issues: readonly BudgetConfigIssues[]
}

/** 一次会话的 token 四桶 + 合计（total = 四桶之和）。 */
export interface BudgetTokenBuckets {
  readonly uncached_input: number
  readonly output: number
  readonly cache_read: number
  readonly cache_write: number
  readonly total: number // = 四桶之和
}

/** 交给模型/下游的判定快照（只读事实，不含任何可执行动作）。 */
export interface BudgetSnapshot {
  readonly session_id: string
  readonly task_class: BudgetTaskClass
  readonly task_class_source: 'auto' | 'configured'
  readonly tokens: BudgetTokenBuckets
  readonly steps: number // 本闸门放行过的工具调用数
  readonly dsh_step: number | null // tokenUsage.last.step（交叉核对；无则 null）
  readonly limits: BudgetLimits
  readonly usage_source: BudgetUsageSource
  readonly last_tool: string | null
  readonly tools_used: Readonly<Record<string, number>>
  readonly over: readonly {
    readonly dimension: 'tokens' | 'steps'
    readonly used: number
    readonly limit: number
  }[]
  readonly within: boolean
}
