// 招聘任务执行器（本 lane 自写；**不是** vendor）。
//
// 文档判定（Notion `04｜Agent Runtime & Reuse Architecture` §08）：不搬 prototype 的 `executor/dsh.ts`
// —— 它强绑 Coding Worktree / Shell / GitHub PR / Coding Prompt。可复用的是 **DSH Session 集成边界**
// （见 `dsh/session-boundary.ts`）与 **Effects 队列**；真正的执行器按招聘领域重写，就是这份文件。
//
// 三件与原型不同的事：
//   1. 工具白名单是**招聘工具**，不是 coding 工具（没有 bash/write/edit，没有 git/worktree）；
//   2. 任务单元来自招聘领域（Application / Interview / Intake 待办），不是 GitHub Issue/PR；
//   3. 会话目录由招聘状态目录 + 任务 ID 生成，没有分支、没有 PR。
//
// 接线状态（R2 诚实标注）：本执行器**尚未挂到任何 HTTP 路由或 Worker 入口**，也没有接上我们的领域表。
// 它现在能被 `Effects` 驱动、被 `Tickets` 的 Executor 端口调用；距"可达"还差：领域适配（Ticket ↔ Application 任务）
// 与插件入口注册。未经接线不得当作能力交付。
import type { Assignment, Executor, Ticket } from '../core/index.ts'
import type { Effects } from '../app/effects.ts'
import type { HealthEntry } from '../infra/health.ts'
import { taskRequestId, type DshSessionBoundary, type SessionMessage } from '../dsh/session-boundary.ts'

/** 招聘 worker Session 允许使用的工具：只读领域工具 + 报告/备注，没有任何 coding/Shell 工具。 */
export const RECRUITMENT_TOOLS = [
  'recruitment_resume_read',
  'recruitment_candidate_get',
  'recruitment_job_get',
  'recruitment_interview_get',
  'recruitment_transcript_read',
  'recruitment_report',
  'recruitment_note',
] as const

/** 执行器向引擎回报的窄接口（对应 core `EngineForExecutor` 的四个方法，避免依赖已裁掉的 engine.ts）。 */
export interface RecruitmentTaskReports {
  assignmentStarted(ticketId: string, assignmentId: string): void
  inputsDelivered(ticketId: string, assignmentId: string, inputIds: string[]): void
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void
  report(ticketId: string, report: { state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'; summary: string; question?: string | null; askedBy?: string; answers?: string }): unknown
}

export interface RecruitmentTaskHost {
  readonly sessions: DshSessionBoundary
  readonly reports: RecruitmentTaskReports
  /** 持久化副作用队列：启动与投递都经它，进程崩了不会丢。 */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  readonly health: HealthEntry
  /** 招聘任务工作目录的根（例如 <stateDir>/tasks）。 */
  readonly workspaceRoot: string
  readonly lifetime: AbortSignal
  /** 按 ticket 重新读一次任务与最新 assignment（effect 派发时会话可能已经过期）。 */
  load(ticketId: string): { ticket: Ticket; assignment: Assignment } | undefined
  closing(): boolean
}

/**
 * 招聘任务执行器：每个任务单元一个 worker Session，任务文本与工具白名单按招聘语义生成。
 *
 * 与 `Effects` 的关系：`start()`/`deliver()` 只入队（与引擎命令同事务），真正的 Session 创建与消息投递由
 * `launch`/`delivery` effect 在提交后执行 —— 这正是文档要求复用的「长任务跨会话」机制。
 */
export class RecruitmentTaskExecutor implements Executor {
  private readonly host: RecruitmentTaskHost
  /** 已取消的任务：投递前检查，避免给已结束的任务继续发消息。 */
  private readonly cancelled = new Set<string>()

  constructor(host: RecruitmentTaskHost) {
    this.host = host
    // 队列里的 effect 必须有人接：launch 建会话并投第一条消息，delivery 把新输入交给运行中的 worker。
    host.effects.handle('launch', async ({ ticketId, assignmentId }) => {
      const found = host.load(ticketId)
      if (!found || found.assignment.id !== assignmentId) return
      await this.launch(found.ticket, found.assignment)
    })
    host.effects.handle('delivery', ({ ticketId }) => this.deliverInputs(ticketId))
  }

  /** 队列化启动：真正的 Session 创建在 effect 里做，进程重启后仍会补上。 */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }

  /** 队列化投递：任务有新输入时把待投消息交给运行中的 worker。 */
  deliver(ticket: Ticket, _assignment: Assignment): void {
    this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id })
  }

  /** 结束任务：记下取消标记并让 Session 停轮，之后的投递不再进入上下文。 */
  stop(ticket: Ticket, _assignment: Assignment, reason: string): void {
    this.cancelled.add(ticket.id)
    void this.host.sessions.cancel(workerSessionId(ticket.id), reason).catch(error => {
      this.host.health.set({ state: 'error', detail: `Cancelling a task session failed: ${String(error)}`, at: new Date().toISOString() })
    })
  }

  /** effect `launch` 的处理体：建 Session、投第一条任务消息、把 Assignment 推到 running。 */
  async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    if (this.host.closing() || this.cancelled.has(ticket.id)) return
    const sessionId = workerSessionId(ticket.id)
    await this.host.sessions.createSession({
      sessionId,
      role: 'worker',
      title: ticket.title,
      directory: `${this.host.workspaceRoot}/${ticket.id}`,
    })
    const sequence = ticket.assignments.length > 1 ? ticket.assignments.indexOf(assignment) : 'first'
    const message: SessionMessage = {
      sessionId,
      requestId: taskRequestId(ticket.id, sequence),
      text: JSON.stringify({
        ticket_id: ticket.id,
        title: ticket.title,
        assignment: ticket.execution?.assignment ?? '',
        allowed_tools: RECRUITMENT_TOOLS,
        // 明确告诉模型边界：不做代码改动、不碰仓库。
        boundary: 'This is a recruitment task. Use only the allowed recruitment tools; no shell, no workspace edits, no repository operations.',
      }),
      authorize: () => { if (this.cancelled.has(ticket.id) || this.host.closing()) throw new Error('The task is no longer authorized') },
    }
    if (!await this.host.sessions.postMessage(message)) return
    this.host.reports.assignmentStarted(ticket.id, assignment.id)
  }

  /** effect `delivery` 的处理体：把尚未投递的 Inputs 交给运行中的 worker，并把「已投递」回写引擎。 */
  async deliverInputs(ticketId: string): Promise<void> {
    const found = this.host.load(ticketId)
    if (!found || this.host.closing() || this.cancelled.has(ticketId)) return
    const { ticket, assignment } = found
    if (assignment.state !== 'running' || !ticket.undelivered.length) return
    const inputs = ticket.inputs.filter(input => ticket.undelivered.includes(input.id) && input.kind === 'trigger')
    if (!inputs.length) return
    const delivered = await this.host.sessions.postMessage({
      sessionId: workerSessionId(ticketId),
      requestId: `inputs:${ticketId}:${assignment.id}:${ticket.undelivered.join(',')}`,
      text: inputs.map(input => JSON.stringify({ delivered_input: input })).join('\n'),
      mode: 'queue',
      authorize: () => { if (this.cancelled.has(ticketId)) throw new Error('The task is no longer authorized') },
    })
    if (delivered) this.host.reports.inputsDelivered(ticketId, assignment.id, ticket.undelivered.slice())
  }
}

/** worker Session 的稳定 ID：一个 ticket 一个 Session，跨会话续做（文档要求的"长任务跨会话"）。 */
export const workerSessionId = (ticketId: string): string => `recruitment-worker-${ticketId}`
