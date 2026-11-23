// Issue #55 — eval 通用类型（cases / graders / runner 共用，零循环依赖）。

/** 一次工具调用（从 agent-turn SSE `tool` 事件归一化而来）。 */
export interface ToolCallEvent {
  readonly kind: 'tool'
  readonly name: string
  readonly status: 'start' | 'ok' | 'error'
  readonly input?: unknown
  readonly result?: string
}

/** SSE `ui_action` 事件。 */
export interface UiActionEvent {
  readonly kind: 'ui_action'
  readonly action: 'navigate' | 'focus_section' | 'suggest_action' | 'propose_write'
  readonly payload: Record<string, unknown>
}

/** Agent 最终回答文本（SSE delta 拼接）。 */
export interface AnswerEvent {
  readonly kind: 'answer'
  readonly text: string
}

/** 工具错误/连接器降级事件。 */
export interface ToolErrorEvent {
  readonly kind: 'tool_error'
  readonly name: string
  readonly code: string
  readonly reason?: string
}

/** 多轮上下文中的一条用户消息（E-18）。 */
export interface UserMessageEvent {
  readonly kind: 'user'
  readonly text: string
  readonly context?: { readonly route?: string; readonly application_id?: string; readonly job_id?: string }
}

/** 归一化轨迹（模型无关：只记“发生了什么”，不记“哪个模型干的”）。 */
export type TraceEvent = ToolCallEvent | UiActionEvent | AnswerEvent | ToolErrorEvent | UserMessageEvent

/** 关键表行数快照。 */
export type RowCounts = Readonly<Record<string, number>>

export interface EvalTrajectory {
  readonly caseId: string
  readonly events: readonly TraceEvent[]
  /** 回合开始时的关键表行数（deterministic 取自 fixture；live 可为空 = 不判行数）。 */
  readonly countsBefore?: RowCounts
  /** 回合结束后的关键表行数。 */
  readonly countsAfter?: RowCounts
  /** 任务要求的写意图（有值时必须出现 propose_write）。 */
  readonly expectedWriteIntent?: string
  /** 本例期望的上下文对象（E-18 串岗/串人检查）。 */
  readonly expectedApplicationId?: string
  /** 本例是否应对“未配置连接器”诚实降级。 */
  readonly expectsNotConfigured?: boolean
  /** 本例是否属于“跨岗召回只列事实”场景。 */
  readonly crossJobRecall?: boolean
  /** 本例是否属于对抗类（E-15..E-18）。 */
  readonly adversarial?: boolean
}

/** 单条 grader 判定。 */
export interface GradeResult {
  readonly ok: boolean
  readonly code: string
  readonly message: string
}

/** L1/L2 合计结果。 */
export interface CaseGrade {
  readonly caseId: string
  readonly l1: readonly GradeResult[]
  readonly l2: readonly GradeResult[]
  readonly passed: boolean
}
