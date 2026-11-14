// 任务运行时的 PostgreSQL 读写层——**装配面**。
//
// 2026-11-15 等价拆分（G12）：原来 1248 行的 `store.ts` 按职责拆到
// `store/{readback,events,claim,lease,recovery,counts}.ts`，本文件只保留
// `RuntimeStore` 的**配置与委托**：方法名、参数顺序、返回值、错误传播、事务边界
// 与拆分前完全一致，SQL 与逻辑逐字搬在责任模块里。对外导入路径仍是
// `src/runtime/store.ts`（薄 barrel），其他文件不需要改。
//
// 设计原则（拆分前 store.ts 文件头，仍然成立）：
//   * **所有写操作在一个事务里**：事件入库 + 定位业务对象 + 创建/唤醒 Task 必须
//     原子提交，否则会出现"事件进了 Inbox 但没有 Task"或反过来；
//   * actor 通过 `withActor` 的 `SET LOCAL recruitment.actor_id` 传入，不用全局 SET
//     （0001 的 fn_row_guard 要求状态迁移可以确定 actor）；
//   * 幂等与"同一时刻只有一个有效租约"靠**库约束**（0011/index/unique），不靠
//     进程内内存集合；进程重启后语义不变；
//   * 时间一律由数据库 `now()` 生成（除测试注入的 retry_after 外），不信任应用时钟。
//
// 这里只做 SQL 和行映射的地方在 readback/events 等模块，不做业务判断：事件走哪条
// 路径在 routing.ts，Attempt 怎么收尾在 task-runtime.ts。
import type { DatabasePool } from '../../db/pool.ts'
import { RuntimeCutoverStore } from '../cutover.ts'
import type {
  BusinessObjectRef,
  BusinessTaskRecord,
  InboundEvent,
  NotificationTarget,
  RouteDecision,
  RuntimeNotification,
  TaskRuntimeView,
  TaskStatus,
} from '../types.ts'
import * as claim from './claim.ts'
import * as counts from './counts.ts'
import * as events from './events.ts'
import * as lease from './lease.ts'
import * as readback from './readback.ts'
import * as recovery from './recovery.ts'

export type { EventRow } from './readback.ts'
export type { InsertEventResult } from './events.ts'
export type { TaskClaim } from './claim.ts'
export type { FinishAttemptInput, FinishAttemptResult } from './lease.ts'
export type { RecoveredAttempt } from './recovery.ts'

/** 运行时写库需要的配置（tenant/actor 来自插件配置，不接受模型入参）。 */
export interface RuntimeStoreOptions {
  readonly pool: DatabasePool
  readonly tenantId: string
  readonly actorId: string
  /**
   * 出站通知目标（可选）。配置后才在 Task 进入 WAITING_* / FAILED 时登记消息；
   * 默认不配 = 不发消息。
   */
  readonly notification?: NotificationTarget
}

/** 任务运行时库层。所有方法都是异步的，且各自拥有完整事务。 */
export class RuntimeStore {
  private readonly pool: DatabasePool
  private readonly tenantId: string
  private readonly actorId: string
  private readonly notification: NotificationTarget | undefined
  /** cutover 水位（与 store 共享同一个 pool / tenant / actor）。 */
  private readonly cutoverStore: RuntimeCutoverStore

  /**
   * @param options - 连接池 + 租户 + actor（全部来自插件配置）。
   */
  constructor(options: RuntimeStoreOptions) {
    this.pool = options.pool
    this.tenantId = options.tenantId
    this.actorId = options.actorId
    this.notification = options.notification
    this.cutoverStore = new RuntimeCutoverStore({
      pool: options.pool,
      tenantId: options.tenantId,
      actorId: options.actorId,
    })
  }

  /** 当前租户 id（测试/HTTP 回执用）。 */
  get tenant(): string {
    return this.tenantId
  }

  /**
   * cutover 水位读写入口（`event-runtime.processPending` 与 dry-run 预览共用）。
   *
   * 为什么放在 store 上而不是让 EventRuntime 自己 new：运行时只有一份
   * pool/tenant/actor 配置，入口分散出去就会出现"某个路径用了别的租户"的
   * 静默越权。这里保持单一来源。
   */
  get cutover(): RuntimeCutoverStore {
    return this.cutoverStore
  }

  /** 幂等写入 Event Inbox。 */
  insertEvent(
    event: InboundEvent,
    idempotency: { key: string; source: 'PROVIDER_EVENT_ID' | 'FALLBACK_KEY' },
  ): Promise<events.InsertEventResult> {
    return events.insertEvent(this.pool, this.tenantId, this.actorId, event, idempotency)
  }

  /** 读回一条事件（重放待路由事件 / 重复事件回执用）。 */
  getEvent(eventId: string): Promise<readback.EventRow | null> {
    return readback.getEvent(this.pool, this.tenantId, eventId)
  }

  /** 按事件行自身的事实解析业务对象（材料到达事件 → intake_record.event_id）。 */
  intakeRecordIdForEvent(eventId: string): Promise<string | null> {
    return readback.intakeRecordIdForEvent(this.pool, this.tenantId, eventId)
  }

  /** 待路由事件（RECEIVED 或 FAILED 且未到重试上限，且已跨过 cutover 水位）。 */
  listPendingEvents(limit: number, maxAttempts: number): Promise<readonly string[]> {
    return readback.listPendingEvents(this.pool, this.tenantId, limit, maxAttempts)
  }

  /** 标记事件已路由：dispatch 状态 + 业务对象定位 + event→task 链接。 */
  markEventRouted(
    eventId: string,
    taskId: string,
    businessObject: BusinessObjectRef | null,
  ): Promise<boolean> {
    return events.markEventRouted(this.pool, this.tenantId, this.actorId, eventId, taskId, businessObject)
  }

  /** 标记事件被确定性 Gate 忽略（不是失败；带可读原因）。 */
  markEventIgnored(eventId: string, reason: string): Promise<boolean> {
    return events.markEventIgnored(this.pool, this.tenantId, this.actorId, eventId, reason)
  }

  /** 标记事件路由失败；`processed_at` 保持 null，允许后续重试。 */
  markEventFailed(eventId: string, errorCode: string, message: string): Promise<boolean> {
    return events.markEventFailed(this.pool, this.tenantId, this.actorId, eventId, errorCode, message)
  }

  /** 已有事件对应的 Task（重复事件回执；没路由过返回 null）。 */
  taskForEvent(eventId: string): Promise<string | null> {
    return readback.taskForEvent(this.pool, this.tenantId, eventId)
  }

  /** 创建或唤醒一个 Business Task。 */
  createOrWakeTask(input: {
    readonly decision: Extract<RouteDecision, { kind: 'deterministic' | 'semantic' }>
    readonly eventId: string
    readonly eventType: string
    readonly createdByActorId: string | null
  }): Promise<{ taskId: string; created: boolean; wakeInserted: boolean; wakeSeq: number | null }> {
    return events.createOrWakeTask(this.pool, this.tenantId, this.actorId, input)
  }

  /** 认领下一个可执行 Task（Router 调用）。 */
  claimNextTask(input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
    readonly excludedTaskTypes: readonly string[]
  }): Promise<claim.TaskClaim | null> {
    return claim.claimNextTask(this.pool, this.tenantId, this.actorId, input)
  }

  /** 认领**指定** Task（验收/运维定向执行用；同样受状态与唯一租约约束）。 */
  claimTask(taskId: string, input: {
    readonly workerType: string
    readonly workerId: string
    readonly leaseMs: number
  }): Promise<claim.TaskClaim | null> {
    return claim.claimTask(this.pool, this.tenantId, this.actorId, taskId, input)
  }

  /** 把 Attempt 从 CLAIMED 推到 RUNNING（执行前调用，开始计时）。 */
  startAttempt(attemptId: string, leaseMs: number): Promise<void> {
    return lease.startAttempt(this.pool, this.tenantId, this.actorId, attemptId, leaseMs)
  }

  /**
   * 登记一次 Agent Session（执行上下文）。执行前登记，`runtime_session_id` 可后补。
   * `resumedRuntimeSessionId` 非空时**接管**既有 session 行（一个 DSH Session 只允许一行，
   * 契约 §1；避免续跑收尾撞 `uq_agent_session_runtime`）。
   */
  createAgentSession(input: {
    readonly taskId: string
    readonly attemptId: string
    readonly runtimeKind: string
    readonly runtimeVersion: string
    readonly modelRoute: string
    readonly runtimeWorkerRole?: 'ROUTER' | 'WORKER'
    readonly resumedRuntimeSessionId?: string | null
  }): Promise<string> {
    return lease.createAgentSession(this.pool, this.tenantId, this.actorId, input)
  }

  /** 收尾一次 Attempt：Attempt 状态 + Task 状态 + Agent Session 状态在同一事务里写。 */
  finishAttempt(input: lease.FinishAttemptInput): Promise<lease.FinishAttemptResult> {
    return lease.finishAttempt(this.pool, this.tenantId, this.actorId, this.notification, input)
  }

  /**
   * 运行时主动登记一条任务通知（运维/旁路入口；与 `finishAttempt` 同一实现）。
   * 重复调用同一 (task, attempt, status) 幂等：第二次 `inserted=false`。
   */
  publishNotification(input: {
    readonly taskId: string
    readonly attemptNo: number
    readonly taskStatus: TaskStatus
    readonly summary: string
  }): Promise<RuntimeNotification | null> {
    return lease.publishNotification(this.pool, this.tenantId, this.actorId, this.notification, input)
  }

  /** 读一条出站消息的当前回执（调用点 3 的读路径；插件侧派发后用同一函数确认）。 */
  readMessageReceipt(messageId: string): Promise<Record<string, unknown> | null> {
    return lease.readMessageReceipt(this.pool, messageId)
  }

  /** 回收租约过期的 Attempt（重启恢复）。 */
  recoverExpiredAttempts(): Promise<readonly recovery.RecoveredAttempt[]> {
    return recovery.recoverExpiredAttempts(this.pool, this.tenantId, this.actorId)
  }

  /** 当前可派发任务数（用于生成"可解释的空闲"原因）。 */
  claimableTaskCount(excludedTaskTypes: readonly string[]): Promise<number> {
    return counts.claimableTaskCount(this.pool, this.tenantId, excludedTaskTypes)
  }

  /** 读回三层身份投影。 */
  readTask(taskId: string): Promise<TaskRuntimeView | null> {
    return readback.readTask(this.pool, this.tenantId, taskId)
  }

  /** 列出最近变更的 Task（工作台/HTTP 读回用）。 */
  listTasks(limit: number): Promise<readonly BusinessTaskRecord[]> {
    return readback.listTasks(this.pool, this.tenantId, limit)
  }

  /** 运行时计数（健康检查/证据用；不参与业务判断）。 */
  runtimeCounts(): Promise<Record<string, number>> {
    return counts.runtimeCounts(this.pool, this.tenantId, this.cutoverStore)
  }
}
