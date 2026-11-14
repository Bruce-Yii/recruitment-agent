// Task / Attempt 生命周期：认领、执行前登记、Worker 派发、收尾、租约回收、读回。
//
// 三层身份在这里落地：
//   * Business Task：`business_task` 一行，ID 在重试间**不变**；
//   * Task Attempt：每次执行插入一条，`attempt_no` 递增，独立状态/错误/结果；
//   * Agent Session：每次执行登记一条 `agent_session`（可替换的上下文），
//     Session 结束只把这一行标 ENDED/LOST，**不改 Task 的身份与状态语义**
//     （Task 的终态只由 Attempt 的执行结果决定）。
//
// 一条硬规则：Worker 抛错 / 超时 / 进程被杀，Task 都不会消失；attempt 落失败，
// Task 落 RETRY_WAIT（或 FAILED），下一次 tick 用**同一个 task id** 建新 Attempt。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RuntimeError } from './errors.ts'
import { ROUTER_ONLY_TASK_TYPES } from './routing.ts'
import type { RuntimeStore, RecoveredAttempt, TaskClaim } from './store.ts'
import type {
  AttemptStatus,
  TaskStatus,
  RuntimeNotification,
  TaskRuntimeView,
  WorkerLauncher,
  WorkerOutcome,
  WorkerTaskRequest,
} from './types.ts'

/** Task 运行时的配置。 */
export interface TaskRuntimeOptions {
  readonly store: RuntimeStore
  readonly launcher: WorkerLauncher
  /** 写进 `task_attempt.worker_type`（默认 `DSH_WORKER`）。 */
  readonly workerType?: string
  /** 写进 `task_attempt.worker_id`（进程身份；默认 `router:<pid>`）。 */
  readonly workerId?: string
  /** Attempt 租约（毫秒）。必须大于单次 Worker 超时，否则会被自己回收。默认 15 分钟。 */
  readonly leaseMs?: number
  /** 自动重试上限（按 Attempt 序号判断）。默认 3。 */
  readonly maxAttempts?: number
  /** 新 Attempt 是否续跑上次的 DSH Session。默认 false = 新会话（Session 可替换）。 */
  readonly resumeSessions?: boolean
  /** Worker 工作目录根；每个 task 一个子目录。默认 `<cwd>/work/runtime`。 */
  readonly workspaceRoot?: string
}

/** 一次成功派发的回执。 */
export interface DispatchResult {
  readonly taskId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly agentSessionId: string
  readonly runtimeSessionId: string | null
  readonly outcome: WorkerOutcome['state']
  readonly taskStatus: TaskStatus
  readonly attemptStatus: AttemptStatus
  readonly errorCode: string | null
  readonly resumedSession: boolean
  readonly notification: RuntimeNotification | null
}

/** Task 运行时：只做"某一次执行"的生命周期，不做事件路由。 */
export class TaskRuntime {
  private readonly store: RuntimeStore
  private readonly launcher: WorkerLauncher
  private readonly workerType: string
  private readonly workerId: string
  private readonly leaseMs: number
  private readonly maxAttempts: number
  private readonly resumeSessions: boolean
  private readonly workspaceRoot: string

  /**
   * @param options - store + WorkerLauncher + 租约/重试/工作目录。
   */
  constructor(options: TaskRuntimeOptions) {
    this.store = options.store
    this.launcher = options.launcher
    this.workerType = options.workerType ?? 'DSH_WORKER'
    this.workerId = options.workerId ?? `router:${process.pid}`
    this.leaseMs = options.leaseMs ?? 15 * 60_000
    this.maxAttempts = options.maxAttempts ?? 3
    this.resumeSessions = options.resumeSessions ?? false
    this.workspaceRoot = options.workspaceRoot ?? join(process.cwd(), 'work', 'runtime')
  }

  /**
   * 回收租约过期的 Attempt（进程重启后第一件事）。
   * @returns 回收列表；Task ID 不变，下一次派发会新建 Attempt。
   */
  async recover(): Promise<readonly RecoveredAttempt[]> {
    return this.store.recoverExpiredAttempts()
  }

  /**
   * 认领并执行**下一个**可派发 Task。
   * @param signal - 取消信号（HTTP 请求断开 / 进程关闭）。
   * @returns 派发回执；没有可派发任务时返回 null（不是错误）。
   */
  async dispatchNext(signal: AbortSignal): Promise<DispatchResult | null> {
    const claim = await this.store.claimNextTask({
      workerType: this.workerType,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      excludedTaskTypes: ROUTER_ONLY_TASK_TYPES,
    })
    if (claim === null) return null
    return this.executeClaim(claim, signal)
  }

  /**
   * 定向派发一个 Task（验收 / 运维入口；同样走认领与唯一租约约束）。
   * @param taskId - 目标 Business Task。
   * @param signal - 取消信号。
   * @returns 派发回执；状态不可派发时返回 null。
   */
  async dispatchTask(taskId: string, signal: AbortSignal): Promise<DispatchResult | null> {
    const claim = await this.store.claimTask(taskId, {
      workerType: this.workerType,
      workerId: this.workerId,
      leaseMs: this.leaseMs,
    })
    if (claim === null) return null
    return this.executeClaim(claim, signal)
  }

  /** 读回三层身份投影（Session 结束后仍可查）。 */
  async read(taskId: string): Promise<TaskRuntimeView | null> {
    return this.store.readTask(taskId)
  }

  /** 当前可派发任务数（Router 生成"可解释的空闲"原因用）。 */
  async claimableCount(): Promise<number> {
    return this.store.claimableTaskCount(ROUTER_ONLY_TASK_TYPES)
  }

  /**
   * 执行一次已认领的 Attempt：登记 Session → 调 Worker → 收尾。
   *
   * `launcher.execute` 抛错（配置缺失 / spawn 失败）也在这里归一化成失败结果，
   * **不让异常穿透**导致 Attempt 停在 RUNNING 占着租约。
   */
  private async executeClaim(claim: TaskClaim, signal: AbortSignal): Promise<DispatchResult> {
    await this.store.startAttempt(claim.attemptId, this.leaseMs)
    // 续跑时传上次的 DSH Session id：store 会**接管既有 agent_session 行**而不是插新行
    // （一个 DSH Session 只允许一行 agent_session，契约 §1；否则收尾会撞
    // uq_agent_session_runtime 把 Attempt 卡在 RUNNING）。
    const resumedSessionId = this.resumeSessions ? claim.lastRuntimeSessionId : null
    const agentSessionId = await this.store.createAgentSession({
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      runtimeKind: this.launcher.runtimeKind,
      runtimeVersion: this.launcher.runtimeVersion,
      modelRoute: this.launcher.modelRoute,
      runtimeWorkerRole: 'WORKER',
      resumedRuntimeSessionId: resumedSessionId,
    })
    const workspaceDir = join(this.workspaceRoot, claim.taskId)
    try {
      mkdirSync(workspaceDir, { recursive: true })
    } catch {
      // 工作目录创建失败不阻断：Worker 会在自己的 cwd 里工作；这里只影响提示中的路径。
    }
    const request: WorkerTaskRequest = {
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      taskType: claim.taskType,
      title: claim.title,
      description: claim.description,
      businessRefs: claim.businessRefs,
      prompt: '',
      // 与 createAgentSession 的接管口径**同源**：续跑的就是这一条 DSH Session id。
      resumeSessionId: resumedSessionId,
      workspaceDir,
    }

    let outcome: WorkerOutcome
    try {
      outcome = await this.launcher.execute(request, signal)
    } catch (error) {
      const code = error instanceof RuntimeError ? error.code : 'WORKER_SPAWN_FAILED'
      const retryable = code !== 'WORKER_RUNTIME_NOT_CONFIGURED'
      outcome = {
        state: 'failed',
        summary: error instanceof Error ? error.message.slice(0, 2000) : String(error),
        resultRef: null,
        errorCode: code,
        errorClass: retryable ? 'TRANSIENT' : 'PERMANENT',
        retryable,
        retryAfter: null,
        runtimeSessionId: null,
        runtimeVersion: this.launcher.runtimeVersion,
        modelRoute: this.launcher.modelRoute,
        durationMs: 0,
        rawOutputRef: null,
      }
    }

    const autoRetryAllowed = claim.attemptNo < this.maxAttempts
    const finished = await this.store.finishAttempt({
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      agentSessionId,
      outcomeState: outcome.state,
      summary: outcome.summary,
      resultRef: outcome.resultRef,
      errorCode: outcome.errorCode,
      errorClass: outcome.errorClass,
      retryable: outcome.retryable,
      retryAfter: outcome.retryAfter,
      autoRetryAllowed,
      runtimeSessionId: outcome.runtimeSessionId,
      rawOutputRef: outcome.rawOutputRef,
      durationMs: outcome.durationMs,
    })
    return {
      taskId: claim.taskId,
      attemptId: claim.attemptId,
      attemptNo: claim.attemptNo,
      agentSessionId,
      runtimeSessionId: outcome.runtimeSessionId,
      outcome: outcome.state,
      taskStatus: finished.taskStatus,
      attemptStatus: finished.attemptStatus,
      errorCode: finished.errorCode,
      resumedSession: request.resumeSessionId !== null,
      notification: finished.notification,
    }
  }
}

