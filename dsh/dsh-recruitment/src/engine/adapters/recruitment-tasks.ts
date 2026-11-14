// 招聘领域适配层（本 lane 自写；**不是** vendor）。
//
// ⚠️ **已退休，不得接线**（2026-11-14 总控裁决）：
//   runtime lane 以 `event_inbox → business_task` 为权威：Task ID 由**业务对象幂等键**决定，
//   并记录真实 DSH `runtime_session_id`。本文件则以引擎 Ticket/Assignment 为权威、用确定性 UUID
//   把引擎对象投影进 business_task/task_attempt/agent_session —— 两者同时写同一批表就是
//   **两套 ID 生成器 = 两套权威**，与 `RecruitmentTaskExecutor` 同一个退休理由。
//   另外本文件的状态映射（failed/blocked 的落点）也不适用于 runtime 的语义。
//   保留作参考：它记录了「引擎侧任务 → 既有执行表」的字段对应关系与三条护栏的遵守方式。
//
// 以下为原始说明（仅参考，不要照此接线）：
// 把 vendor 进来的机制（Ticket / Assignment / 订阅的那套结构）映射到**招聘既有的执行语义表**：
//   Ticket      → recruitment.business_task
//   Assignment  → recruitment.task_attempt
//   worker 会话 → recruitment.agent_session
// 这样"哪些任务在跑、跑到第几次、卡在等人还是等外部、会话是哪一条"全部落在仓库既有 schema 里，
// 而不是再发明一套任务表。业务引用（Application / Interview / Intake …）走 business_task.business_refs。
//
// 三条硬约束（来自 0001_init.sql，适配层必须遵守，测试逐条覆盖）：
//   1. business_task.status='RUNNING' 必须有 current_attempt_id；FAILED 必须有 error_code；
//      completed_at 只能出现在终态；
//   2. task_attempt 同一 task 同一时刻只能有一条 CLAIMED/RUNNING（唯一的有效租约），
//      终态必须落 ended_at，FAILED_FINAL/TIMED_OUT 必须有 error_class；
//   3. 状态 UPDATE 会触发 fn_row_guard：必须能确定 actor（`set_config('recruitment.actor_id', …, true)`），
//      触发时会写一条 internal 事件到 event_inbox —— 适配层不绕过它。
//
// 事务边界：写回必须与产生它的引擎命令**同一个事务**，否则崩在中间就漂移。适配层默认自己开
// `Store.atomic`（`store.inTransaction` 为真时直接在调用方事务里执行）。
import { createHash } from 'node:crypto'
import type { Assignment, Ticket } from '../core/index.ts'
import type { EngineDb, Store } from '../app/store.ts'

/** 业务引用：这条任务是为了哪个招聘对象而存在。 */
export type DomainRefKind = 'application' | 'interview' | 'intake' | 'candidate' | 'job' | 'requisition'
export interface DomainTaskRef { readonly kind: DomainRefKind; readonly id: string }

export type BusinessTaskStatus = 'PENDING' | 'READY' | 'RUNNING' | 'WAITING_EXTERNAL' | 'WAITING_HUMAN'
  | 'RETRY_WAIT' | 'SUCCEEDED' | 'FAILED' | 'CANCEL_REQUESTED' | 'CANCELLED' | 'SUPERSEDED'
export type TaskAttemptStatus = 'CLAIMED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL'
  | 'TIMED_OUT' | 'CANCELLED' | 'ABANDONED'
export type AgentSessionStatus = 'ACTIVE' | 'ENDED' | 'LOST'
export type AttemptErrorClass = 'TRANSIENT' | 'WAIT_EXTERNAL' | 'AUTH_REQUIRED' | 'INVALID_INPUT'
  | 'BUSINESS_CONFLICT' | 'PERMANENT' | 'UNKNOWN_OUTCOME' | 'WORKER_LOST'

/** 适配层配置：租户、写审计用的 actor（必须是 recruitment.actor 里本租户的行）、会话运行时信息。 */
export interface TaskAdapterConfig {
  readonly tenantId: string
  readonly actorId: string
  readonly runtimeVersion: string
  readonly modelRoute: string
  /** 默认任务类型（调用方可在 project 时覆盖）。 */
  readonly taskType?: string
}

/** 一次会话的域侧输入。 */
export interface SessionProjection {
  readonly ticketId: string
  readonly assignmentId: string
  /** 稳定的会话标签（我们自己的 worker session id）。 */
  readonly sessionLabel: string
  /** DSH 真实会话 ID；0011 应用后写入 agent_session.runtime_session_id，未应用时忽略。 */
  readonly runtimeSessionId?: string
  readonly status: AgentSessionStatus
  readonly modelRoute?: string
}

const LEASE_MS = 5 * 60_000

/**
 * 确定性 UUID（版本 3 风格：md5 前 16 字节 + RFC 4122 版本/变体位）。
 * 同一业务键永远同一主键 —— 重复投影是幂等 upsert，不会产生第二行任务。
 */
export function stableUuid(namespace: string, value: string): string {
  const hex = createHash('md5').update(`${namespace}:${value}`).digest('hex')
  const bytes = hex.slice(0, 32).split('')
  bytes[12] = '3'
  bytes[16] = ((parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16)
  const s = bytes.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/** Ticket → business_task 主键。 */
export const taskIdOf = (ticketId: string): string => stableUuid('task', ticketId)
/** Assignment → task_attempt 主键。 */
export const attemptIdOf = (assignmentId: string): string => stableUuid('attempt', assignmentId)
/** DSH worker Session 标签 → agent_session 主键。 */
export const sessionIdOf = (sessionLabel: string): string => stableUuid('session', sessionLabel)
/** business_task 的幂等键：同一 ticket 只能有一条任务。 */
export const taskIdempotencyKey = (ticketId: string): string => `engine:ticket:${ticketId}`

/** Assignment 的报告状态，取该 Assignment 自己的 report（不是整张 ticket 的最新报告）。 */
const reportOf = (assignment: Assignment): Assignment['report'] => assignment.report

/**
 * Ticket → business_task.status。
 *
 * 映射规则（与既有 schema 的语义一一对应）：
 *   ended → SUCCEEDED（completed/merged）/ CANCELLED（dropped/stopped）/ FAILED（由报告失败导致）；
 *   attention 有问题 → WAITING_HUMAN；
 *   最新报告 failed → FAILED；blocked → WAITING_HUMAN；waiting → WAITING_EXTERNAL；
 *   报告处有投递失败 → RETRY_WAIT；有 running 的 Assignment → RUNNING；
 *   有 pending 的 Assignment → READY；否则 PENDING。
 */
export function businessTaskStatusOf(ticket: Ticket): BusinessTaskStatus {
  if (ticket.ended) {
    if (ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'merged') return 'SUCCEEDED'
    if (ticket.ended.outcome === 'dropped' || ticket.ended.outcome === 'stopped') return 'CANCELLED'
    return 'CANCELLED'
  }
  if (ticket.attention) return 'WAITING_HUMAN'
  const latest = ticket.assignments.at(-1)
  const report = latest ? reportOf(latest) : undefined
  if (report?.state === 'failed') return 'FAILED'
  if (report?.state === 'blocked') return 'WAITING_HUMAN'
  if (report?.state === 'waiting') return 'WAITING_EXTERNAL'
  if (ticket.delivery) return 'RETRY_WAIT'
  if (ticket.assignments.some(assignment => assignment.state === 'running')) return 'RUNNING'
  if (ticket.assignments.some(assignment => assignment.state === 'pending')) return 'READY'
  return 'PENDING'
}

/** Assignment → task_attempt.status。 */
export function taskAttemptStatusOf(assignment: Assignment): TaskAttemptStatus {
  if (assignment.state === 'pending') return 'CLAIMED'
  if (assignment.state === 'running') return 'RUNNING'
  switch (assignment.report?.state) {
    case 'ready': return 'SUCCEEDED'
    case 'failed': return 'FAILED_FINAL'
    case 'blocked': return 'FAILED_FINAL'
    case 'dropped': return 'CANCELLED'
    default: return 'ABANDONED'
  }
}

/** 失败类状态必须给 error_class（DB 约束 ck_task_attempt_final）。 */
export function taskAttemptErrorClassOf(assignment: Assignment): AttemptErrorClass | undefined {
  const status = taskAttemptStatusOf(assignment)
  if (status !== 'FAILED_FINAL' && status !== 'TIMED_OUT' && status !== 'FAILED_RETRYABLE') return undefined
  return assignment.report?.state === 'blocked' ? 'BUSINESS_CONFLICT' : 'PERMANENT'
}

/** business_task 的 error_code（status=FAILED 时必填，DB 约束 ck_business_task_failed）。 */
export function businessTaskErrorCodeOf(ticket: Ticket): string | undefined {
  if (businessTaskStatusOf(ticket) !== 'FAILED') return undefined
  return ticket.delivery ? 'INPUT_DELIVERY_FAILED' : 'AGENT_REPORTED_FAILURE'
}

const terminal = (status: BusinessTaskStatus): boolean =>
  status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED' || status === 'SUPERSEDED'

/**
 * 把引擎的 Ticket / Assignment / 会话写回招聘既有执行表。
 *
 * 所有写回都是幂等 upsert；状态 UPDATE 走 `fn_row_guard`（自动写审计与 internal 事件），适配层不绕过它。
 */
export class RecruitmentTaskAdapter {
  private readonly store: Store
  private readonly db: EngineDb
  private readonly config: TaskAdapterConfig
  /**
   * 运行时 session 定位列是否存在。
   *
   * `0011_task_runtime.sql`（另一条 lane 的库层缺口迁移）给 agent_session 加了 `runtime_session_id`，
   * 语义正是"DSH 真实会话 ID"。该迁移可能还没应用，所以适配层按库的**实际列**决定写不写，
   * 而不是假设某一边：未应用时留空（符合 0001），应用后自动填上（符合 0011 的唯一索引）。
   */
  private readonly hasRuntimeSessionId: boolean

  constructor(store: Store, config: TaskAdapterConfig) {
    this.store = store
    this.db = store.db
    this.config = config
    this.hasRuntimeSessionId = this.db.prepare(`select 1 from information_schema.columns
      where table_schema = 'recruitment' and table_name = 'agent_session' and column_name = 'runtime_session_id'`).get() !== undefined
  }

  /** 在事务里写回一张 Ticket 及其全部 Assignment；调用方已开事务时并入该事务。 */
  project(ticket: Ticket, refs: readonly DomainTaskRef[] = [], options: { readonly taskType?: string } = {}): void {
    const write = () => {
      this.setActor()
      const status = businessTaskStatusOf(ticket)
      const taskId = taskIdOf(ticket.id)
      const refsJson = JSON.stringify(refs.map(ref => ({ type: ref.kind, id: ref.id })))
      // 先落任务行，但 current_attempt_id 留空、状态停在 PENDING：business_task 对 current_attempt_id 有外键，
      // 且 ck_business_task_running 要求 RUNNING 必须有 attempt —— 两个约束决定了"先 attempt 再改状态"的顺序。
      this.db.prepare(`insert into recruitment.business_task
        (id, tenant_id, task_type, business_refs, title, description, priority, idempotency_key,
         status, current_attempt_id, attempt_count, error_code, completed_at)
        values (?, ?, ?, ?::jsonb, ?, ?, ?, ?, 'PENDING', null, ?, null, null)
        on conflict (id) do update set
          business_refs = excluded.business_refs,
          title = excluded.title,
          attempt_count = excluded.attempt_count`)
        .run(taskId, this.config.tenantId, options.taskType ?? this.config.taskType ?? 'RECRUITMENT_AGENT_TASK',
          refsJson, ticket.title.slice(0, 300), ticket.execution?.assignment ?? null, 3,
          taskIdempotencyKey(ticket.id), ticket.assignments.length)

      const now = new Date()
      let runningAttemptId: string | null = null
      for (const [index, assignment] of ticket.assignments.entries()) {
        const attemptStatus = taskAttemptStatusOf(assignment)
        const active = attemptStatus === 'CLAIMED' || attemptStatus === 'RUNNING'
        const ended = active ? null : (assignment.endedAt ?? new Date().toISOString())
        const errorClass = taskAttemptErrorClassOf(assignment)
        if (attemptStatus === 'RUNNING') runningAttemptId = attemptIdOf(assignment.id)
        // 时间戳统一用数据库时钟兜底：引擎侧时钟可能早于 claimed_at（同一毫秒），
        // 而 ck_task_attempt_started / ck_task_attempt_ended 要求 started_at / ended_at >= claimed_at。
        this.db.prepare(`insert into recruitment.task_attempt
          (id, tenant_id, task_id, attempt_no, worker_type, worker_id, status, claimed_at, started_at, ended_at,
           lease_expires_at, error_class, error_code, error_detail)
          values (?, ?, ?, ?, 'DSH', ?, ?, now(),
            case when ?::timestamptz is null then null else greatest(?::timestamptz, now()) end,
            case when ?::timestamptz is null then null else greatest(?::timestamptz, now()) end,
            ?, ?, ?, ?)
          on conflict (id) do update set
            status = excluded.status,
            started_at = coalesce(recruitment.task_attempt.started_at, excluded.started_at),
            ended_at = excluded.ended_at,
            error_class = excluded.error_class,
            error_detail = excluded.error_detail`)
          .run(attemptIdOf(assignment.id), this.config.tenantId, taskId, index + 1, workerIdOf(ticket.id),
            attemptStatus, assignment.startedAt ?? null, assignment.startedAt ?? null,
            ended, ended, new Date(now.getTime() + LEASE_MS).toISOString(),
            errorClass ?? null, assignment.report?.state === 'failed' ? 'AGENT_REPORTED_FAILURE' : null,
            assignment.report?.summary?.slice(0, 1000) ?? null)
        // 只有活跃 attempt 占用唯一有效租约（uq_task_attempt_active_lease）；结束的把租约置成已过期。
        if (!active) {
          this.db.prepare("update recruitment.task_attempt set lease_expires_at = claimed_at + interval '1 millisecond' where id = ?")
            .run(attemptIdOf(assignment.id))
        }
      }

      // 再写任务状态与当前 attempt：此时 attempt 已存在，RUNNING 的约束与外键都满足。
      const latest = ticket.assignments.at(-1)
      this.db.prepare(`update recruitment.business_task set
          status = ?, current_attempt_id = ?, error_code = ?, completed_at = ?
        where id = ? and tenant_id = ?`)
        .run(status, runningAttemptId ?? (latest ? attemptIdOf(latest.id) : null), businessTaskErrorCodeOf(ticket) ?? null,
          terminal(status) && ticket.ended ? ticket.ended.at : null, taskId, this.config.tenantId)
    }
    if (this.store.inTransaction) write()
    else this.store.atomic(write)
  }

  /** 记录一个 DSH worker 会话（ACTIVE）或它的结束（ENDED / LOST）。 */
  projectSession(session: SessionProjection): void {
    const write = () => {
      this.setActor()
      const taskId = taskIdOf(session.ticketId)
      const attemptId = attemptIdOf(session.assignmentId)
      const id = sessionIdOf(session.sessionLabel)
      const ended = session.status === 'ACTIVE' ? null : new Date().toISOString()
      // 0011 应用后 `runtime_session_id` 存 DSH 真实会话 ID；未应用时只写 0001 的列。
      const runtimeSessionId = session.runtimeSessionId ?? session.sessionLabel
      const sql = this.hasRuntimeSessionId
        ? `insert into recruitment.agent_session
            (id, tenant_id, task_id, attempt_id, runtime_kind, runtime_version, model_route, permission_version,
             status, started_at, ended_at, runtime_session_id)
           values (?, ?, ?, ?, 'DSH', ?, ?, ?, ?, now(),
             case when ?::timestamptz is null then null else greatest(?::timestamptz, now()) end, ?)
           on conflict (id) do update set
             status = excluded.status,
             runtime_session_id = excluded.runtime_session_id,
             ended_at = case when excluded.ended_at is null then null
                             else greatest(excluded.ended_at, recruitment.agent_session.started_at) end`
        : `insert into recruitment.agent_session
            (id, tenant_id, task_id, attempt_id, runtime_kind, runtime_version, model_route, permission_version,
             status, started_at, ended_at)
           values (?, ?, ?, ?, 'DSH', ?, ?, ?, ?, now(),
             case when ?::timestamptz is null then null else greatest(?::timestamptz, now()) end)
           on conflict (id) do update set
             status = excluded.status,
             ended_at = case when excluded.ended_at is null then null
                             else greatest(excluded.ended_at, recruitment.agent_session.started_at) end`
      const params = [id, this.config.tenantId, taskId, attemptId, this.config.runtimeVersion,
        session.modelRoute ?? this.config.modelRoute, this.config.runtimeVersion, session.status, ended, ended]
      this.db.prepare(sql).run(...params, ...this.hasRuntimeSessionId ? [runtimeSessionId] : [])
    }
    if (this.store.inTransaction) write()
    else this.store.atomic(write)
  }

  /** 读回一张任务在招聘域侧的当前状态（供面板/测试核对；不参与引擎决策）。 */
  readTask(ticketId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`select id, status, current_attempt_id, attempt_count, error_code, completed_at,
        business_refs, record_version, status_source_event_id
      from recruitment.business_task where id = ?`).get(taskIdOf(ticketId))
  }

  /** 读回某个 Assignment 对应的 attempt。 */
  readAttempt(assignmentId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`select id, task_id, attempt_no, worker_type, worker_id, status, started_at, ended_at,
        lease_expires_at, error_class, record_version, status_source_event_id
      from recruitment.task_attempt where id = ?`).get(attemptIdOf(assignmentId))
  }

  /** 读回会话行。 */
  readSession(sessionLabel: string): Record<string, unknown> | undefined {
    return this.db.prepare('select id, task_id, attempt_id, status, started_at, ended_at, runtime_version from recruitment.agent_session where id = ?')
      .get(sessionIdOf(sessionLabel))
  }

  /** 状态迁移审计：fn_row_guard 为每次状态迁移写一条 internal 事件，这里数得出来。 */
  statusEventCount(ticketId: string): number {
    const row = this.db.prepare(`select count(*)::int as n from recruitment.event_inbox
      where provider = 'internal' and source_object_id = ?`).get(taskIdOf(ticketId)) as { n: number } | undefined
    return Number(row?.n ?? 0)
  }

  /** 把 actor 写进当前事务（`is_local = true`，事务结束自动失效）；txid 顺序不可换。 */
  private setActor(): void {
    this.db.prepare("select set_config('recruitment.actor_id', ?, true)").get(this.config.actorId)
  }
}

/** worker Session 的稳定标签（与 `exec/recruitment-task-executor.ts` 的 workerSessionId 同构）。 */
export const workerIdOf = (ticketId: string): string => `recruitment-worker-${ticketId}`
