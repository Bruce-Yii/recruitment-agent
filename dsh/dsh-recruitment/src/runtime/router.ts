// Router：主 Agent 的确定性部分——把"事件 → Task → Attempt → Worker Session"
// 串成一次可重放的 tick。
//
// 为什么 Router 要独立成一层：
//   * 事件路由（EventRuntime）不知道 Worker；
//   * 任务生命周期（TaskRuntime）不知道事件；
//   * Router 只做编排：先处理待路由事件，再回收失联 Attempt，最后认领并派发
//     一个 Task。它**不直接写业务表、不执行招聘动作**——那是 Worker 的活。
//
// 幂等来自库（Notion §10 + 0011）：
//   * 同一 provider 事件重复到达 → event_inbox 唯一约束 + 不重新路由；
//   * 同一事件重复唤醒 → task_wakeup (task_id, event_id) 唯一；
//   * 同一 Task 重复派发 → business_task.status=RUNNING + uq_task_attempt_active_lease
//     + `FOR UPDATE SKIP LOCKED`；
//   * 因此 `tick()` 可以被重复调用，不需要进程内去重集合。
import { EventRuntime } from './event-runtime.ts'
import type { RuntimeStore } from './store.ts'
import type { TaskRuntime } from './task-runtime.ts'
import type { EventReceiveResult, InboundEvent, TickReceipt } from './types.ts'
import type { DshWorkerConfig } from './worker.ts'
import { DshHeadlessWorkerLauncher } from './worker.ts'
import { TaskRuntime as ConcreteTaskRuntime } from './task-runtime.ts'

/** Router 的配置。 */
export interface RouterOptions {
  readonly store: RuntimeStore
  readonly events: EventRuntime
  readonly tasks: TaskRuntime
}

/** Router 一次 tick 的可观察行为。 */
export class Router {
  private readonly store: RuntimeStore
  private readonly events: EventRuntime
  private readonly tasks: TaskRuntime

  /**
   * @param options - 三个已装配的运行时部件。
   */
  constructor(options: RouterOptions) {
    this.store = options.store
    this.events = options.events
    this.tasks = options.tasks
  }

  /**
   * 提交一个事件（HTTP / 测试入口）。重复事件返回 duplicate，不重复建 Task。
   * @param event - 已验证/未验证的事件；未验证会被 `EventRuntime.validate` 拒绝。
   */
  async submit(event: InboundEvent): Promise<EventReceiveResult> {
    return this.events.receive(event)
  }

  /**
   * 执行一轮：重放待路由事件 → 回收失联 Attempt → 派发一个 Task。
   *
   * 单轮只派发一个 Task 是刻意的：tick 是**幂等恢复入口**，不是并发调度器；
   * 并发由多个调用方各自 tick + 库里的 `SKIP LOCKED` 保证。
   * @param signal - 取消信号。
   * @returns 每一步都有库里的 id（可直接作为验收证据）。
   */
  async tick(signal: AbortSignal): Promise<TickReceipt> {
    const routedEvents = await this.events.processPending()
    const recoveredAttempts = await this.tasks.recover()
    const dispatched = await this.tasks.dispatchNext(signal)
    let idleReason: string | null = null
    if (dispatched === null) {
      const claimable = await this.tasks.claimableCount()
      idleReason = claimable === 0
        ? 'NO_CLAIMABLE_TASK: no business_task in PENDING/READY/RETRY_WAIT with next_run_at <= now() (ROUTER_TRIAGE tasks are not auto-dispatched)'
        : `NO_DISPATCH_THIS_ROUND: ${claimable} claimable task(s) remain but none could be claimed (concurrent router?)`
    }
    return {
      routedEvents,
      recoveredAttempts: recoveredAttempts.map((item) => ({
        taskId: item.taskId,
        attemptId: item.attemptId,
        attemptNo: item.attemptNo,
        errorCode: item.errorCode,
      })),
      dispatched,
      idleReason,
    }
  }

  /** 运行时计数（健康检查/证据）。 */
  async counts(): Promise<Record<string, number>> {
    return this.store.runtimeCounts()
  }
}

/** 装配 Router 的完整输入（HTTP 与测试共用，避免两套装配逻辑）。 */
export interface ComposeRuntimeOptions {
  readonly store: RuntimeStore
  readonly worker: DshWorkerConfig
  readonly pendingBatchSize?: number
  readonly maxRouteAttempts?: number
  readonly workerType?: string
  readonly workerId?: string
  readonly leaseMs?: number
  readonly maxAttempts?: number
  readonly resumeSessions?: boolean
  readonly workspaceRoot?: string
}

/** 装配好的运行时三件套 + Router。 */
export interface ComposedRuntime {
  readonly router: Router
  readonly events: EventRuntime
  readonly tasks: TaskRuntime
  readonly launcher: DshHeadlessWorkerLauncher
  readonly store: RuntimeStore
}

/**
 * 组装 Router / EventRuntime / TaskRuntime / DSH launcher。
 * @param options - store + Worker profile 配置。
 * @returns 可直接 `tick()` 的运行时。
 */
export function composeRuntime(options: ComposeRuntimeOptions): ComposedRuntime {
  const launcher = new DshHeadlessWorkerLauncher(options.worker)
  const events = new EventRuntime({
    store: options.store,
    pendingBatchSize: options.pendingBatchSize,
    maxRouteAttempts: options.maxRouteAttempts,
  })
  const tasks = new ConcreteTaskRuntime({
    store: options.store,
    launcher,
    workerType: options.workerType,
    workerId: options.workerId,
    leaseMs: options.leaseMs,
    maxAttempts: options.maxAttempts,
    resumeSessions: options.resumeSessions,
    workspaceRoot: options.workspaceRoot,
  })
  const router = new Router({ store: options.store, events, tasks })
  return { router, events, tasks, launcher, store: options.store }
}
