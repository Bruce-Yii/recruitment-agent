// task-78 / DESIGN §3.4：按会话累计闸门事实（步数 / 工具 / 任务分类）。
//
// 事实来源分层（DESIGN §1）：
//   * steps = **本闸门自己放行过**的工具调用次数（闸门控制的就是这个量，不猜）；
//   * tokens = 每次调用时由 `readSessionUsage()` 读 DSH 的真实用量（本文件不造用量）；
//   * task_class = 配置显式指定，或 AUTO 时按首次命中的业务工具分类（`tool_class_map`）。
//
// 纯内存、无副作用：不连 DB、不写文件；`reset()` 用于会话结束或测试。
import type { BudgetSnapshot, BudgetTaskClass, ResolvedBudgetConfig } from './types.ts'
import { DEFAULT_TOOL_CLASS_MAP } from './config.ts'
import { evaluateBudget } from './verdict.ts'
import type { SessionUsageRead } from './usage.ts'

export interface BudgetTrackerOptions {
  readonly config: ResolvedBudgetConfig
}

interface BudgetSessionState {
  /** null = AUTO 尚未分类（用 default_class 兜底）。 */
  task_class: BudgetTaskClass | null
  task_class_source: 'auto' | 'configured'
  /** 本闸门放行过的工具调用数。 */
  steps: number
  last_tool: string | null
  readonly tools_used: Map<string, number>
}

export class BudgetTracker {
  readonly config: ResolvedBudgetConfig
  private readonly states = new Map<string, BudgetSessionState>()

  constructor(options: BudgetTrackerOptions) {
    this.config = options.config
  }

  private state(sessionId: string): BudgetSessionState {
    let existing = this.states.get(sessionId)
    if (existing !== undefined) return existing
    const configured = this.config.task_class === 'AUTO' ? null : this.config.task_class
    const created: BudgetSessionState = {
      task_class: configured,
      task_class_source: configured === null ? 'auto' : 'configured',
      steps: 0,
      last_tool: null,
      tools_used: new Map<string, number>(),
    }
    this.states.set(sessionId, created)
    return created
  }

  /** AUTO 尚未分类时，按工具映射决定分类（未命中则保持未分类 → default_class 兜底）。 */
  private classify(state: BudgetSessionState, toolName: string): void {
    if (state.task_class !== null) return
    const mapped = this.config.tool_class_map[toolName] ?? DEFAULT_TOOL_CLASS_MAP[toolName]
    if (mapped === undefined) return
    state.task_class = mapped
    state.task_class_source = 'auto'
  }

  /** 记录一次「即将放行」的工具调用，返回该会话快照（步数含本次）。 */
  noteAllowed(sessionId: string, toolName: string): void {
    const state = this.state(sessionId)
    state.steps += 1
    state.last_tool = toolName
    state.tools_used.set(toolName, (state.tools_used.get(toolName) ?? 0) + 1)
    this.classify(state, toolName)
  }

  /** 记录一次被拒绝的调用（不计入 steps；不改 last_tool / tools_used）。 */
  noteDenied(sessionId: string, _toolName: string): void {
    // 被拒绝的调用没有执行过，因此不能出现在 tools_used / last_tool 里；
    // 本方法只确保会话状态存在（让 status 工具能看到被拒绝过的会话）。
    this.state(sessionId)
  }

  /** 当前类（AUTO 时按首次命中的业务工具分类；未分类返回 config.default_class）。 */
  taskClassOf(sessionId: string): BudgetTaskClass {
    return this.state(sessionId).task_class ?? this.config.default_class
  }

  /** 用「当前累计事实 + 一次 usage 读取」判出一份快照。 */
  snapshot(sessionId: string, usage: SessionUsageRead): BudgetSnapshot {
    const state = this.state(sessionId)
    const taskClass = state.task_class ?? this.config.default_class
    const toolsUsed: Record<string, number> = {}
    for (const [name, count] of state.tools_used) toolsUsed[name] = count
    return evaluateBudget({
      session_id: sessionId,
      task_class: taskClass,
      task_class_source: state.task_class_source,
      tokens: usage.buckets,
      steps: state.steps,
      dsh_step: usage.dsh_step,
      limits: this.config.limits[taskClass],
      usage_source: usage.source,
      last_tool: state.last_tool,
      tools_used: toolsUsed,
    })
  }

  /** 清空一个会话（会话结束 / 测试用）。 */
  reset(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** 全部活跃会话 id（status 工具用；按创建顺序）。 */
  sessions(): string[] {
    return [...this.states.keys()]
  }
}
