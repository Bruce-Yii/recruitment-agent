// DSH Session 集成边界（本 lane 自写；**不是** vendor）。
//
// 为什么要有这一层：Notion `04｜Agent Runtime & Reuse Architecture` §08 判定 executor/dsh.ts **不直接搬**
// —— 它把 Coding Worktree / Shell / GitHub PR / Coding Prompt 焊死在一起。可复用的是它与 DSH 的**接触面**：
// 怎么创建一个 worker Session、怎么把一条任务消息投进去、怎么等它给出结果、怎么感知它启动的后台作业。
// 这份文件就是把那四件事收成一个窄接口（四方法 + 一个事件源），执行器可以换，边界不变。
//
// 来源说明：方法语义与参数取自 prototype 的 executor/dsh.ts（launch / deliverQueued / 后台作业观察）与
// app/sessions.ts（ensure / prompt），但**没有**任何 worktree/PR/Shell 概念进入本文件。

/** 一个后台作业的句柄：作业 ID 与它属于哪个 ticket。 */
export interface BackgroundJobRef { readonly ticketId: string; readonly jobId: string; readonly state: 'running' | 'ended' }

/** 创建 Session 时给它的角色：主会话（受理与派发）或 worker（执行一个任务单元）。 */
export type SessionRole = 'main' | 'worker'

/** 创建一个 Session 需要的信息；`directory` 是该任务单元的工作目录，`title` 供人识别。 */
export interface CreateSessionInput {
  readonly sessionId: string
  readonly role: SessionRole
  readonly title: string
  readonly directory: string
}

/** 投递一条消息时 DSH 的投递语义：排队到下一轮，或立即插话打断当前轮。 */
export type DeliveryMode = 'queue' | 'steer'

/** 一条要投进 Session 的消息。`requestId` 用于幂等：同一 ID 重复投递不会重复进入上下文。 */
export interface SessionMessage {
  readonly sessionId: string
  readonly requestId: string
  readonly text: string
  readonly mode?: DeliveryMode
  /** 投递前最后一次授权检查：抛错则**放弃**投递（Session 仍在，但这条消息不进上下文）。 */
  readonly authorize?: () => void
}

/** 一次会话结果：worker 主动报告的状态与摘要，或 DSH 侧的轮次结束。 */
export interface SessionOutcome {
  readonly sessionId: string
  readonly state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
  readonly summary: string
  /** 需要人回答的问题；`null` 表示清空之前的问题。 */
  readonly question?: string | null
}

/**
 * 执行器唯一依赖的 DSH 能力面。
 *
 * 刻意保持窄：四个方法 + 一个订阅。这样 `RecruitmentTaskExecutor` 不接触 Cordis Context、不接触 coding 工具表，
 * 换成别的 Session 宿主（或测试替身）时只需实现这五个成员。
 */
export interface DshSessionBoundary {
  /** 创建（或取回）一个 Session；已存在同 ID 时返回现有实例，不重复创建。 */
  createSession(input: CreateSessionInput): Promise<{ sessionId: string }>
  /** 把一条消息投进 Session；返回它是否真的进入上下文（授权检查失败等情况下为 false）。 */
  postMessage(message: SessionMessage): Promise<boolean>
  /** 等待该 Session 的下一个结果（报告或轮次结束）；超时返回 undefined，由调用方决定重试还是放弃。 */
  awaitResult(sessionId: string, signal: AbortSignal): Promise<SessionOutcome | undefined>
  /** 取消该 Session 当前的轮次（停止一个已结束任务的执行）。 */
  cancel(sessionId: string, reason: string): Promise<void>
  /** 订阅该 Session 启动的后台作业；返回取消订阅函数。 */
  observeBackgroundJobs(sessionId: string, listener: (job: BackgroundJobRef) => void): () => void
}

/** 消息 ID 的稳定构造：同一 (ticket, 序) 永远同一 ID，重复投递不会重复进上下文。 */
export const taskRequestId = (ticketId: string, sequence: number | 'first'): string => `task:${ticketId}:${sequence}`
