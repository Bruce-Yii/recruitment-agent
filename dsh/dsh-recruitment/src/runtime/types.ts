// 任务运行时的公共类型与端口。
//
// 三层身份必须分开（Notion `04｜Agent Runtime & Reuse Architecture` §12）：
//   Business Task  = 长期工作身份（重试不换 ID）
//   Task Attempt   = 每一次具体执行（独立编号、状态、结果、错误）
//   Agent Session  = 可替换的计算上下文（不承担任务身份）
//
// 本文件只放**类型**和**端口**：SQL 在 store.ts，事件路径在 event-runtime.ts，
// 任务生命周期在 task-runtime.ts，DSH Worker 在 worker.ts。这样 Router / Worker
// 可以各自替换而不改对方的语义。

/** `event_inbox.dispatch_state` 的取值（0011 §1.1 的 CHECK 逐字对应）。 */
export type EventDispatchState = 'RECEIVED' | 'ROUTED' | 'IGNORED' | 'FAILED'

/** 事件定位到的招聘业务对象类型（0011 §1.6 的 CHECK 逐字对应）。 */
export type BusinessObjectType =
  | 'APPLICATION'
  | 'INTERVIEW'
  | 'TRANSCRIPT_ARTIFACT'
  | 'INTAKE_RECORD'
  | 'JOB'
  | 'CANDIDATE'

/** 业务对象引用：只放"是哪个招聘事实"，不放任务身份。 */
export interface BusinessObjectRef {
  readonly type: BusinessObjectType
  readonly id: string
}

/** 事件来源信任级别。外部文本永远不可信（0001 的 `ck_event_inbox_trust`）。 */
export type TrustLevel = 'UNTRUSTED_EXTERNAL' | 'INTERNAL'

/**
 * 出站通知目标（runtime → 引擎 Outbox）。
 *
 * 只有配置了它，Task 进入 `WAITING_*` / `FAILED` 时才会登记一条出站消息；
 * 默认不配 = 不发消息（正常自动化保持安静，Notion `04` §10 的意图）。
 */
export interface NotificationTarget {
  /** 引擎 Channel 的 source 名（Outbox 用它找 Source 实例）。 */
  readonly source: string
  /** 外部会话/线程标识（Outbox 按它排序）。 */
  readonly thread: string
  /** 通道地址（交给 Source 的具体寻址字段）。 */
  readonly address: Readonly<Record<string, string>>
  /** 出站消息类型；默认 `notice`。 */
  readonly kind: 'notice' | 'reply' | 'acknowledgement'
}

/** 一次出站登记的结果（同事务读回，状态应是 `pending`）。 */
export interface RuntimeNotification {
  readonly messageId: string
  /** 本次是否**新**登记（false = 同一 message id 已存在，幂等忽略）。 */
  readonly inserted: boolean
  /** 登记后立即从 `engine_outbox` 读回的状态。 */
  readonly status: string
}

/**
 * 进站事件的规范化输入。
 *
 * 字段与 0001 `event_inbox` 的 Event Envelope 对齐；`idempotencyKey` 缺省时由
 * `provider + providerEventId` 稳定构造（见 `normalize.ts`），**不接受调用方
 * 传入一个会随时间变化的键**（那会让去重形同虚设）。
 */
export interface InboundEvent {
  readonly tenantId: string
  readonly provider: string
  readonly providerEventId?: string | null
  readonly eventType: string
  readonly schemaVersion?: number
  readonly occurredAt?: string | null
  readonly payload: Record<string, unknown>
  readonly sourceObjectId?: string | null
  readonly payloadRef?: string | null
  readonly trustLevel: TrustLevel
  readonly idempotencyKey?: string
  readonly correlationId?: string | null
  readonly causationId?: string | null
}

/** 事件路由的三种结果。 */
export type RouteDecision =
  | {
      readonly kind: 'deterministic'
      readonly taskType: string
      readonly taskTitle: string
      readonly priority: number
      readonly businessObject: BusinessObjectRef
    }
  | {
      readonly kind: 'semantic'
      readonly taskType: 'ROUTER_TRIAGE'
      readonly taskTitle: string
      readonly priority: number
      readonly reason: string
    }
  | { readonly kind: 'ignored'; readonly reason: string }

/** 一次 `receive()` 的结果（全部可在库里读回）。 */
export interface EventReceiveResult {
  /** `stored` = 本次真的新入库；`duplicate` = 同 provider 事件 ID 已存在。 */
  readonly outcome: 'stored' | 'duplicate'
  /** 事件 id（duplicate 时是已存在的那一行）。 */
  readonly eventId: string
  /** 路由结论；duplicate 时不重新路由，取库里已有状态。 */
  readonly dispatchState: EventDispatchState
  /** 创建或唤醒到的 Business Task；`null` 表示 ignored / 尚未路由。 */
  readonly taskId: string | null
  /** 本次是否**新建**了 Task。 */
  readonly taskCreated: boolean
  /** 本次是否**新增**了一条唤醒事实（duplicate 恒为 false）。 */
  readonly wakeInserted: boolean
  /** 路由到的业务对象；语义准入 / ignored 为 null。 */
  readonly businessObject: BusinessObjectRef | null
  /** ignored / failed 的原因。 */
  readonly reason: string | null
}

/** `task_attempt.error_class` 的取值（0001 的 CHECK 逐字对应）。 */
export type TaskErrorClass =
  | 'TRANSIENT'
  | 'WAIT_EXTERNAL'
  | 'AUTH_REQUIRED'
  | 'INVALID_INPUT'
  | 'BUSINESS_CONFLICT'
  | 'PERMANENT'
  | 'UNKNOWN_OUTCOME'
  | 'WORKER_LOST'

/** `task_attempt.status` 的取值（0001 的 CHECK 逐字对应）。 */
export type AttemptStatus =
  | 'CLAIMED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FINAL'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'ABANDONED'

/** `business_task.status` 的取值（0001 的 CHECK 逐字对应）。 */
export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'WAITING_EXTERNAL'
  | 'WAITING_HUMAN'
  | 'RETRY_WAIT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'SUPERSEDED'

/** 一次 Task 派发请求：Router 给 Worker 的完整、自足输入。 */
export interface WorkerTaskRequest {
  readonly taskId: string
  readonly attemptId: string
  readonly attemptNo: number
  readonly taskType: string
  readonly title: string
  readonly description: string | null
  readonly businessRefs: readonly BusinessObjectRef[]
  readonly prompt: string
  /**
   * 上一次执行用过的 DSH Session id（`agent_session.runtime_session_id`）。
   * 有值表示"续跑同一会话"；`null` 表示新建会话。Session 只是计算上下文，
   * 换掉它不影响 Task 身份。
   */
  readonly resumeSessionId: string | null
  /** Worker 工作目录（由运行时按 task id 生成，不让模型改）。 */
  readonly workspaceDir: string
}

/** Worker 执行的归一化结果；Runtime 只信它 + 库里读回，不信模型自述。 */
export interface WorkerOutcome {
  readonly state: 'succeeded' | 'failed' | 'waiting' | 'blocked'
  readonly summary: string
  readonly resultRef: string | null
  readonly errorCode: string | null
  readonly errorClass: TaskErrorClass | null
  readonly retryable: boolean
  readonly retryAfter: string | null
  /** DSH 真实 session id（`agent_session.runtime_session_id` 的来源）。 */
  readonly runtimeSessionId: string | null
  /** 执行上下文的 runtime 版本 / 模型路由（写进 `agent_session`，可审计）。 */
  readonly runtimeVersion: string
  readonly modelRoute: string
  readonly durationMs: number
  /** Worker 原始输出的落点（文件路径或内容摘要引用）。 */
  readonly rawOutputRef: string | null
}

/**
 * Worker 启动端口。
 *
 * 这是 Router 与执行上下文之间**唯一的接触面**：Router 不知道 DSH、PTy、
 * 子进程或模型；替换实现（进程内 `ctx.agents` / headless 子进程 / 远端 worker）
 * 不需要改任务生命周期。
 */
export interface WorkerLauncher {
  /** 写进 `agent_session.runtime_kind`（如 `DSH`）。 */
  readonly runtimeKind: string
  /** 写进 `agent_session.runtime_version`。 */
  readonly runtimeVersion: string
  /** 写进 `agent_session.model_route`。 */
  readonly modelRoute: string
  /**
   * 在一个**独立 Session** 里执行任务并等它给出结果。
   * @param request - 任务输入（含是否续跑上次 Session）。
   * @param signal - 取消信号（超时/进程退出时由调用方 abort）。
   * @returns 归一化结果；实现不得用"假装成功"掩盖启动失败。
   */
  execute(request: WorkerTaskRequest, signal: AbortSignal): Promise<WorkerOutcome>
}

/** 库里的一行 Business Task（读回用；不含 Attempt/Session）。 */
export interface BusinessTaskRecord {
  readonly id: string
  readonly tenantId: string
  readonly taskType: string
  readonly title: string
  readonly description: string | null
  readonly businessRefs: readonly BusinessObjectRef[]
  readonly status: TaskStatus
  readonly priority: number
  readonly idempotencyKey: string
  readonly triggerEventId: string | null
  readonly lastWakeEventId: string | null
  readonly wakeCount: number
  readonly attemptCount: number
  readonly currentAttemptId: string | null
  readonly resultRef: string | null
  readonly errorCode: string | null
  readonly errorSummary: string | null
  readonly nextRunAt: string | null
  readonly completedAt: string | null
  readonly recordVersion: number
  readonly createdAt: string
  readonly updatedAt: string
}

/** 库里的一行 Task Attempt。 */
export interface TaskAttemptRecord {
  readonly id: string
  readonly taskId: string
  readonly attemptNo: number
  readonly workerType: string
  readonly workerId: string
  readonly status: AttemptStatus
  readonly fencingToken: number
  readonly claimedAt: string
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly leaseExpiresAt: string
  readonly outputRef: string | null
  readonly errorClass: TaskErrorClass | null
  readonly errorCode: string | null
  readonly errorDetail: string | null
  readonly retryable: boolean
  readonly retryAfter: string | null
  readonly executionDurationMs: number | null
  readonly createdAt: string
}

/** 库里的一行 Agent Session（计算上下文，不承担任务身份）。 */
export interface AgentSessionRecord {
  readonly id: string
  readonly taskId: string | null
  readonly attemptId: string | null
  readonly runtimeKind: string
  readonly runtimeVersion: string
  readonly modelRoute: string
  readonly runtimeSessionId: string | null
  readonly runtimeWorkerRole: 'ROUTER' | 'WORKER'
  readonly status: 'ACTIVE' | 'ENDED' | 'LOST'
  readonly startedAt: string
  readonly endedAt: string | null
}

/** 一条唤醒事实。 */
export interface TaskWakeupRecord {
  readonly id: string
  readonly taskId: string
  readonly eventId: string
  readonly wakeSeq: number
  readonly wakeReason: string
  readonly createdAt: string
}

/** `readTask()` 的完整三层投影：用于验收"Session 结束 ≠ Task 结束"。 */
export interface TaskRuntimeView {
  readonly task: BusinessTaskRecord
  readonly attempts: readonly TaskAttemptRecord[]
  readonly sessions: readonly AgentSessionRecord[]
  readonly wakeups: readonly TaskWakeupRecord[]
}

/** Router 一次 tick 的回执（每一步都有库里的 id）。 */
export interface TickReceipt {
  /** 本轮被路由的事件（按顺序）。 */
  readonly routedEvents: readonly EventReceiveResult[]
  /** 本轮回收的失联 Attempt。 */
  readonly recoveredAttempts: readonly {
    readonly taskId: string
    readonly attemptId: string
    readonly attemptNo: number
    readonly errorCode: string
  }[]
  /** 本轮派发的 Task（`null` = 没有可派发任务，不是错误）。 */
  readonly dispatched: {
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
    /** 本次执行产生的出站通知登记（未配置通知或未到通知状态时为 null）。 */
    readonly notification: RuntimeNotification | null
  } | null
  /** 没有派发时的原因（可解释的空闲，不是把故障说成空）。 */
  readonly idleReason: string | null
}

/** 时钟与 id 生成的最小注入面（测试可替换，生产用默认实现）。 */
export interface RuntimeClock {
  now(): Date
}
