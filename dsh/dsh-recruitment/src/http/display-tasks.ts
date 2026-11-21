// 宿主侧只读 HTTP 路由：PG 任务 / 卡住事件 / 事件处置的展示投影
// （`GET /recruitment/api/tasks/status`，CONTRACT §3）。
//
// 设计纪律：
//
//   1. **只读**：全部查询跑在 `withReadOnly`（`begin transaction read only`）里——写语句会被
//      PG 以 25006 拒绝。端点不写任何行（负例测试逐表比对行数，必须全等）。
//   2. **tenant 只来自部署配置**（`ResolvedDatabaseConfig.tenant_id`），不接受客户端传
//      actor/tenant：query `actor_id`/`tenant_id` 或头 `x-recruitment-actor`/`x-recruitment-tenant`
//      → 400 `ACTOR_OVERRIDE_REJECTED`（且不碰 DB）。
//   3. **口径复用而非重造**：表名/状态枚举与 `src/runtime/http.ts` health 的 counts 同一批
//      PG 表；事件 `dispatch_state` 枚举 = 0011 的 `ck_event_inbox_dispatch_state`
//      （RECEIVED / ROUTED / IGNORED / FAILED）。这里不 import 运行时 store（避免装配依赖）。
//   4. **不返回 `business_refs` 原文**（可含 PII）：只从数组里提取 `kind=APPLICATION`
//      （大小写不敏感）的 ref id，且必须是 UUID 形状；其它 ref 一个字符都不出。
//   5. 时间一律返回 ISO-8601；`age_seconds` 用同一个 `now()` 计算；`oldest_*` 无数据为
//      `null`（不是 0——0 是「库事实为零」，null 是「没有这条读数」，见 runtime/http.ts 的同一裁决）。
//
// 卡住判据（`STUCK_AFTER_SECONDS = 300`，CONTRACT §3）：
//   * task：`PENDING|READY|RETRY_WAIT` 且 `next_run_at < now()-300s`（NOT_DISPATCHED），
//           或 `RUNNING` 且当前 attempt `lease_expires_at < now()`（LEASE_EXPIRED）；
//   * event：`dispatch_state='RECEIVED'` 且 `received_at < now()-300s`。
//
// 安全边界与 `http/overview.ts` 同一口径：只在**回环** webServer 上注册（非回环不注册）；
// `sameOrigin`（Host 本机端口 + `x-recruitment-request: 1` + Origin 缺省/同源）；只有 GET；
// 响应 `no-store`；错误体固定 `{"error":{"code","reason_code","message"}}`，
// message 里不出现机器绝对路径、SQL、连接串或凭据。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { sameOrigin } from './overview.ts'

/** 端点路径（exact 路由；CONTRACT §3 冻结）。 */
export const TASKS_STATUS_PATH = '/recruitment/api/tasks/status'
/** 契约版本。 */
export const TASKS_STATUS_CONTRACT_VERSION = '1.0.0'
/** 卡住阈值（秒）：写进实现常量，CONTRACT 冻结值 300。 */
export const STUCK_AFTER_SECONDS = 300

/** 任务/尝试列表行数上限。 */
const ROW_LIMIT = 50
/** 卡住事件列表行数上限。 */
const STUCK_EVENT_LIMIT = 20
/** 业务 ref id 的形态 guard：脏数据不许让投影崩，也不许把任意字符串当 id 返回。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 同源标记头。 */
const REQUEST_HEADER = 'x-recruitment-request'
/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** 响应绝不缓存。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** 「等待中」的任务状态（`oldest_waiting_seconds` 的口径，见下方 SQL 注释）。 */
const WAITING_STATUSES = ['PENDING', 'READY', 'RETRY_WAIT', 'WAITING_HUMAN', 'WAITING_EXTERNAL'] as const

// =====================================================================
//  SQL（全部 SELECT；只读事务由 call site 保证）
// =====================================================================

/**
 * 任务行 + 当前 attempt 的公共列（tasks / stuck_tasks 共用，保证两张表字段逐字一致）。
 * `current_attempt_id` 没有外键（0001 如此设计），所以用 left join 且带 tenant 条件。
 */
const TASK_ROW_COLUMNS_SQL = `
  select
       bt.id::text          as task_id,
       bt.task_type         as task_type,
       bt.title             as title,
       bt.status            as status,
       bt.priority          as priority,
       bt.attempt_count     as attempt_count,
       bt.created_at        as created_at,
       bt.status_changed_at as status_changed_at,
       bt.next_run_at       as next_run_at,
       bt.due_at            as due_at,
       bt.business_refs     as business_refs,
       bt.error_code        as error_code,
       bt.error_summary     as error_summary,
       ta.attempt_no        as current_attempt_no,
       ta.status            as current_attempt_status,
       ta.lease_expires_at  as current_attempt_lease_expires_at,
       ta.claimed_at        as current_attempt_claimed_at
  from recruitment.business_task bt
  left join recruitment.task_attempt ta
    on ta.id = bt.current_attempt_id and ta.tenant_id = bt.tenant_id
 where bt.tenant_id = $1::uuid`

/** 最近 $2 条任务（created_at desc；同一时刻按 id 兜底稳定排序）。 */
const TASKS_SQL = `${TASK_ROW_COLUMNS_SQL}
 order by bt.created_at desc, bt.id desc
 limit $2::int`

/**
 * 卡住任务（≤ $3 条，最老在前）：判据与 `STUCK_AFTER_SECONDS` 同一常量。
 * 注意 `next_run_at is null` **不算卡住**：运行时把它当「立即可派发」，不是「逾期」。
 */
const STUCK_TASKS_SQL = `${TASK_ROW_COLUMNS_SQL}
   and (
         (bt.status in ('PENDING', 'READY', 'RETRY_WAIT')
          and bt.next_run_at is not null
          and bt.next_run_at < $2::timestamptz - interval '${STUCK_AFTER_SECONDS} seconds')
         or
         (bt.status = 'RUNNING'
          and ta.lease_expires_at is not null
          and ta.lease_expires_at < $2::timestamptz)
       )
 order by bt.created_at asc, bt.id asc
 limit $3::int`

/**
 * 任务标量计数（一条 SQL：同一 `$2` 时刻，避免多个读数跨快照）。
 *
 * `oldest_waiting_seconds` 口径：**等待中**状态（PENDING/READY/RETRY_WAIT/WAITING_HUMAN/
 * WAITING_EXTERNAL）里最老的「进入当前状态时长」= `now - min(status_changed_at)`；
 * 没有等待中的任务 → SQL NULL（不是 0）。
 */
const TASK_SCALAR_COUNTS_SQL = `
  select
    (select count(*)::int
       from recruitment.business_task bt
      where bt.tenant_id = $1::uuid and bt.status = 'RUNNING') as running,
    (select count(*)::int
       from recruitment.business_task bt
      where bt.tenant_id = $1::uuid and bt.status = 'WAITING_HUMAN') as waiting_human,
    (select count(*)::int
       from recruitment.business_task bt
       left join recruitment.task_attempt ta
         on ta.id = bt.current_attempt_id and ta.tenant_id = bt.tenant_id
      where bt.tenant_id = $1::uuid
        and (
              (bt.status in ('PENDING', 'READY', 'RETRY_WAIT')
               and bt.next_run_at is not null
               and bt.next_run_at < $2::timestamptz - interval '${STUCK_AFTER_SECONDS} seconds')
              or
              (bt.status = 'RUNNING'
               and ta.lease_expires_at is not null
               and ta.lease_expires_at < $2::timestamptz)
            )) as stuck,
    (select count(*)::int
       from recruitment.event_inbox e
      where e.tenant_id = $1::uuid and e.dispatch_state = 'RECEIVED') as events_received_unrouted,
    (select count(*)::int
       from recruitment.event_inbox e
      where e.tenant_id = $1::uuid
        and e.dispatch_state = 'RECEIVED'
        and e.received_at < $2::timestamptz - interval '${STUCK_AFTER_SECONDS} seconds') as events_stuck,
    (select floor(extract(epoch from ($2::timestamptz - min(bt.status_changed_at))))::int
       from recruitment.business_task bt
      where bt.tenant_id = $1::uuid
        and bt.status in (${WAITING_STATUSES.map((status) => `'${status}'`).join(', ')})) as oldest_waiting_seconds,
    (select floor(extract(epoch from ($2::timestamptz - min(e.received_at))))::int
       from recruitment.event_inbox e
      where e.tenant_id = $1::uuid and e.dispatch_state = 'RECEIVED') as oldest_unrouted_event_seconds`

/** 按状态分组（全部任务），顺带算 24h 子集的同分组计数（一条 SQL 两个读数）。 */
const TASK_BY_STATUS_SQL = `
  select bt.status as status,
         count(*)::int as n,
         count(*) filter (
           where bt.created_at >= $2::timestamptz - interval '24 hours'
         )::int as n_24h
    from recruitment.business_task bt
   where bt.tenant_id = $1::uuid
   group by bt.status
   order by bt.status asc`

/** 最近 $2 条 attempt（claimed_at desc），join 出 task_type。 */
const ATTEMPTS_SQL = `
  select ta.id::text           as attempt_id,
         ta.task_id::text      as task_id,
         bt.task_type          as task_type,
         ta.attempt_no         as attempt_no,
         ta.status             as status,
         ta.worker_type        as worker_type,
         ta.claimed_at         as claimed_at,
         ta.started_at         as started_at,
         ta.lease_expires_at   as lease_expires_at,
         ta.ended_at           as ended_at,
         ta.error_class        as error_class,
         ta.error_code         as error_code,
         (ta.lease_expires_at < $2::timestamptz) as lease_expired
    from recruitment.task_attempt ta
    join recruitment.business_task bt
      on bt.id = ta.task_id and bt.tenant_id = ta.tenant_id
   where ta.tenant_id = $1::uuid
   order by ta.claimed_at desc, ta.id desc
   limit $3::int`

/** 事件按 dispatch_state 分组（全部事件；枚举 = 0011 的封闭集）。 */
const EVENTS_BY_DISPATCH_STATE_SQL = `
  select e.dispatch_state as dispatch_state, count(*)::int as n
    from recruitment.event_inbox e
   where e.tenant_id = $1::uuid
   group by e.dispatch_state
   order by e.dispatch_state asc`

/** 卡住事件（RECEIVED 且超过 300s；最老在前，≤ 20 条）。 */
const STUCK_EVENTS_SQL = `
  select e.event_id::text      as event_id,
         e.event_type          as event_type,
         e.dispatch_state      as dispatch_state,
         e.received_at         as received_at,
         e.route_attempts      as route_attempts
    from recruitment.event_inbox e
   where e.tenant_id = $1::uuid
     and e.dispatch_state = 'RECEIVED'
     and e.received_at < $2::timestamptz - interval '${STUCK_AFTER_SECONDS} seconds'
   order by e.received_at asc, e.event_id asc
   limit ${STUCK_EVENT_LIMIT}`

/** 事件处置（G10 / 0016 的 append-only 审计表）：按 disposition / reason / 总数。 */
const DISPOSITIONS_BY_DISPOSITION_SQL = `
  select d.disposition as disposition, count(*)::int as n
    from recruitment.event_disposition d
   where d.tenant_id = $1::uuid
   group by d.disposition
   order by d.disposition asc`

const DISPOSITIONS_BY_REASON_SQL = `
  select d.reason_code as reason_code, count(*)::int as n
    from recruitment.event_disposition d
   where d.tenant_id = $1::uuid
   group by d.reason_code
   order by d.reason_code asc`

const DISPOSITIONS_TOTAL_SQL = `
  select count(*)::int as n
    from recruitment.event_disposition d
   where d.tenant_id = $1::uuid`

// =====================================================================
//  出参类型（形状是契约）
// =====================================================================

/** 任务当前 attempt 的只读快照（could be null）。 */
export interface CurrentAttemptView {
  readonly attempt_no: number
  readonly status: string
  readonly lease_expires_at: string | null
  readonly claimed_at: string | null
}

/** 卡住原因闭集（CONTRACT §3）。 */
export type StuckReason = 'LEASE_EXPIRED' | 'NOT_DISPATCHED'

/** 一条任务行（`tasks` 与 `stuck_tasks` 同形状）。 */
export interface TaskStatusRow {
  readonly task_id: string
  readonly task_type: string
  readonly title: string
  readonly status: string
  readonly priority: number
  readonly attempt_count: number
  readonly created_at: string | null
  readonly status_changed_at: string | null
  readonly next_run_at: string | null
  readonly due_at: string | null
  readonly age_seconds: number | null
  /** 失败终态的机器码（只在 status=FAILED 时有值；只加字段不改契约）。 */
  readonly error_code: string | null
  /** 失败终态的人话原因（只在 status=FAILED 时有值；只加字段不改契约）。 */
  readonly error_summary: string | null
  readonly current_attempt: CurrentAttemptView | null
  readonly stuck: boolean
  readonly stuck_reason: StuckReason | null
  readonly application_id: string | null
  /**
   * 异步解析进度（只加字段不改行为）：`{done,total}` 仅在任务行**已有**两者都已知时给出，
   * 否则 null（不编数字、不新造表/列）。当前库没有专属进度列，退化来源见 `progressOf`。
   */
  readonly progress: { readonly done: number; readonly total: number } | null
}

/** 一条 attempt（最近 50，join 出 task_type）。 */
export interface AttemptStatusRow {
  readonly attempt_id: string
  readonly task_id: string
  readonly task_type: string
  readonly attempt_no: number
  readonly status: string
  readonly worker_type: string
  readonly claimed_at: string | null
  readonly started_at: string | null
  readonly lease_expires_at: string | null
  readonly ended_at: string | null
  readonly error_class: string | null
  readonly error_code: string | null
  readonly lease_expired: boolean
}

/** 一条卡住事件（`events.stuck`，≤20）。 */
export interface StuckEventRow {
  readonly event_id: string
  readonly event_type: string
  readonly dispatch_state: string
  readonly received_at: string | null
  readonly age_seconds: number | null
  readonly route_attempts: number
}

/** `GET /recruitment/api/tasks/status` 的 200 响应（CONTRACT §3）。 */
export interface TasksStatusResponse {
  readonly tool: 'recruitment_tasks_status'
  readonly contract_version: string
  readonly captured_at: string
  /** 卡住阈值（秒）：UI 用它解释为什么某行算「卡住」，避免前端另写一份 300。 */
  readonly stuck_after_seconds: number
  readonly counts: {
    readonly by_status: Readonly<Record<string, number>>
    readonly running: number
    readonly waiting_human: number
    readonly stuck: number
    readonly events_received_unrouted: number
    readonly events_stuck: number
    readonly oldest_waiting_seconds: number | null
    readonly oldest_unrouted_event_seconds: number | null
    readonly last_24h: {
      readonly tasks: number
      readonly by_status: Readonly<Record<string, number>>
    }
  }
  readonly tasks: readonly TaskStatusRow[]
  readonly stuck_tasks: readonly TaskStatusRow[]
  readonly attempts: readonly AttemptStatusRow[]
  readonly events: {
    readonly by_dispatch_state: Readonly<Record<string, number>>
    readonly oldest_unrouted_seconds: number | null
    readonly stuck: readonly StuckEventRow[]
  }
  readonly dispositions: {
    readonly by_disposition: Readonly<Record<string, number>>
    readonly by_reason: Readonly<Record<string, number>>
    readonly total: number
  }
}

// =====================================================================
//  pg 行 → JSON 的小工具
// =====================================================================

/** 把 timestamptz（Date / ISO 文本 / null）读成毫秒；非法/缺失 → null。 */
function msOf(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** 同上，输出 ISO 文本（缺失 → null）。 */
function isoOrNull(value: unknown): string | null {
  const ms = msOf(value)
  return ms === null ? null : new Date(ms).toISOString()
}

/** `age_seconds`：`now - value` 的整秒（非负；缺失 → null）。 */
function ageSecondsOf(nowMs: number, value: unknown): number | null {
  const ms = msOf(value)
  return ms === null ? null : Math.max(0, Math.floor((nowMs - ms) / 1000))
}

/** 整数（pg 的 `count(*)::int` 是 number；bigint 以文本回来时也接）。 */
function intOf(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

/** 非负整数（attempt_no / route_attempts）。 */
function nonNegativeIntOf(value: unknown): number {
  return Math.max(0, intOf(value))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 `business_refs` 里提取 `kind=APPLICATION`（大小写不敏感）的 ref id。
 *
 * **只返回 id**（不返回 kind 以外的任何键，更不返回数组原文）；id 不是 UUID 形状就丢弃
 * （脏 ref 不许被当业务 id 返回，也不许让 `::uuid` 之类的强转炸掉投影）。
 * @param refs - `business_task.business_refs`（jsonb → JS 数组）。
 * @returns 第一个 APPLICATION ref 的 UUID 文本，或 null。
 */
export function applicationIdOf(refs: unknown): string | null {
  if (!Array.isArray(refs)) return null
  for (const ref of refs) {
    if (!isPlainObject(ref)) continue
    const kind = ref.kind
    if (typeof kind !== 'string' || kind.toUpperCase() !== 'APPLICATION') continue
    const id = ref.id
    if (typeof id === 'string' && UUID_RE.test(id)) return id
  }
  return null
}

/**
 * 从任务行已有字段推导异步解析进度；**没有可靠来源就返回 null，绝不编数字**。
 *
 * 当前库 `business_task` / `task_attempt` 没有专属进度列（0001/0011 均无 done/total 或
 * processed_bytes），所以唯一诚实的来源是 `business_refs` 里结构化的 `PROGRESS` 引用：
 * `{kind:'PROGRESS', done:<整数>, total:<整数>}`。仅当 total 是 >0 的安全整数、done 是
 * 0≤done≤total 的安全整数时给出 `{done,total}`；缺一项、脏形状、0 分母一律 null。
 * 不新造表/列，也不把 attempt_count（重试次数）之类误当进度。
 * @param refs - `business_task.business_refs`（jsonb → JS 数组）。
 */
export function progressOf(refs: unknown): { readonly done: number; readonly total: number } | null {
  if (!Array.isArray(refs)) return null
  for (const ref of refs) {
    if (!isPlainObject(ref)) continue
    if (typeof ref.kind !== 'string' || ref.kind.toUpperCase() !== 'PROGRESS') continue
    const total = ref.total
    const done = ref.done
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0) continue
    if (typeof done !== 'number' || !Number.isSafeInteger(done) || done < 0 || done > total) continue
    return { done, total }
  }
  return null
}

// =====================================================================
//  投影（只读事务内调用；纯读）
// =====================================================================

/** 任务行（SQL 原始形状）。 */
interface TaskRow {
  task_id: string
  task_type: string
  title: string
  status: string
  priority: number
  attempt_count: number
  created_at: unknown
  status_changed_at: unknown
  next_run_at: unknown
  due_at: unknown
  business_refs: unknown
  error_code: string | null
  error_summary: string | null
  current_attempt_no: number | null
  current_attempt_status: string | null
  current_attempt_lease_expires_at: unknown
  current_attempt_claimed_at: unknown
}

/**
 * 判一条任务是否卡住、以及卡住原因（与 SQL 判据逐条对应；`now` 用同一毫秒）。
 * @param row - 任务行。
 * @param nowMs - 本次读数的 now（来自 DB `now()`）。
 * @returns 原因闭集，或 null（不卡）。
 */
function stuckReasonOf(row: TaskRow, nowMs: number): StuckReason | null {
  if (row.status === 'RUNNING') {
    const leaseMs = msOf(row.current_attempt_lease_expires_at)
    return leaseMs !== null && leaseMs < nowMs ? 'LEASE_EXPIRED' : null
  }
  if (row.status === 'PENDING' || row.status === 'READY' || row.status === 'RETRY_WAIT') {
    const nextRunMs = msOf(row.next_run_at)
    return nextRunMs !== null && nextRunMs < nowMs - STUCK_AFTER_SECONDS * 1000 ? 'NOT_DISPATCHED' : null
  }
  return null
}

/** 一行 SQL 任务行 → 契约任务行。 */
function mapTaskRow(row: TaskRow, nowMs: number): TaskStatusRow {
  const attemptNo = row.current_attempt_no === null || row.current_attempt_no === undefined
    ? null
    : intOf(row.current_attempt_no)
  const currentAttempt: CurrentAttemptView | null = attemptNo === null
    ? null
    : {
        attempt_no: attemptNo,
        status: String(row.current_attempt_status ?? ''),
        lease_expires_at: isoOrNull(row.current_attempt_lease_expires_at),
        claimed_at: isoOrNull(row.current_attempt_claimed_at),
      }
  const stuckReason = stuckReasonOf(row, nowMs)
  return {
    task_id: String(row.task_id),
    task_type: String(row.task_type),
    title: String(row.title),
    status: String(row.status),
    priority: intOf(row.priority),
    attempt_count: intOf(row.attempt_count),
    created_at: isoOrNull(row.created_at),
    status_changed_at: isoOrNull(row.status_changed_at),
    next_run_at: isoOrNull(row.next_run_at),
    due_at: isoOrNull(row.due_at),
    age_seconds: ageSecondsOf(nowMs, row.created_at),
    error_code: typeof row.error_code === 'string' && row.error_code !== '' ? row.error_code : null,
    error_summary: typeof row.error_summary === 'string' && row.error_summary !== '' ? row.error_summary : null,
    current_attempt: currentAttempt,
    stuck: stuckReason !== null,
    stuck_reason: stuckReason,
    application_id: applicationIdOf(row.business_refs),
    progress: progressOf(row.business_refs),
  }
}

/** `{key: n}` 形态（跳过 null key）。 */
function countMapOf(rows: readonly Record<string, unknown>[], keyField: string, countField: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const key = row[keyField]
    if (typeof key !== 'string' || key === '') continue
    out[key] = intOf(row[countField])
  }
  return out
}

/** 可空秒数（SQL NULL → null，**不是 0**）。 */
function nullableSeconds(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}

/**
 * 读一次任务状态投影（**只读**；接收事务内 client，不自己建池/开事务）。
 *
 * @param client - 只读事务内的连接。
 * @param tenantId - 租户（只来自部署配置）。
 * @returns CONTRACT §3 的响应体。
 */
export async function readTasksStatusProjection(
  client: DatabaseClient,
  tenantId: string,
): Promise<TasksStatusResponse> {
  const nowRow = await client.query<{ now_ts: unknown }>('select now() as now_ts')
  const nowMs = msOf(nowRow.rows[0]?.now_ts) ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const taskResult = await client.query<TaskRow>(TASKS_SQL, [tenantId, ROW_LIMIT])
  const stuckTaskResult = await client.query<TaskRow>(STUCK_TASKS_SQL, [tenantId, nowIso, ROW_LIMIT])
  const scalarResult = await client.query<Record<string, unknown>>(TASK_SCALAR_COUNTS_SQL, [tenantId, nowIso])
  const byStatusResult = await client.query<Record<string, unknown>>(TASK_BY_STATUS_SQL, [tenantId, nowIso])
  const attemptResult = await client.query<Record<string, unknown>>(ATTEMPTS_SQL, [tenantId, nowIso, ROW_LIMIT])
  const eventsByStateResult = await client.query<Record<string, unknown>>(EVENTS_BY_DISPATCH_STATE_SQL, [tenantId])
  const stuckEventsResult = await client.query<Record<string, unknown>>(STUCK_EVENTS_SQL, [tenantId, nowIso])
  const dispByDispositionResult = await client.query<Record<string, unknown>>(DISPOSITIONS_BY_DISPOSITION_SQL, [tenantId])
  const dispByReasonResult = await client.query<Record<string, unknown>>(DISPOSITIONS_BY_REASON_SQL, [tenantId])
  const dispTotalResult = await client.query<Record<string, unknown>>(DISPOSITIONS_TOTAL_SQL, [tenantId])

  const scalar = scalarResult.rows[0] ?? {}
  const byStatus = countMapOf(byStatusResult.rows, 'status', 'n')
  const last24ByStatus: Record<string, number> = {}
  let last24Tasks = 0
  for (const row of byStatusResult.rows) {
    const status = row.status
    const n24 = intOf(row.n_24h)
    if (typeof status === 'string' && status !== '' && n24 > 0) {
      last24ByStatus[status] = n24
      last24Tasks += n24
    }
  }

  const attempts: AttemptStatusRow[] = attemptResult.rows.map((row) => ({
    attempt_id: String(row.attempt_id),
    task_id: String(row.task_id),
    task_type: String(row.task_type),
    attempt_no: nonNegativeIntOf(row.attempt_no),
    status: String(row.status),
    worker_type: String(row.worker_type),
    claimed_at: isoOrNull(row.claimed_at),
    started_at: isoOrNull(row.started_at),
    lease_expires_at: isoOrNull(row.lease_expires_at),
    ended_at: isoOrNull(row.ended_at),
    error_class: typeof row.error_class === 'string' ? row.error_class : null,
    error_code: typeof row.error_code === 'string' ? row.error_code : null,
    lease_expired: row.lease_expired === true,
  }))

  const stuckEvents: StuckEventRow[] = stuckEventsResult.rows.map((row) => ({
    event_id: String(row.event_id),
    event_type: String(row.event_type),
    dispatch_state: String(row.dispatch_state),
    received_at: isoOrNull(row.received_at),
    age_seconds: ageSecondsOf(nowMs, row.received_at),
    route_attempts: nonNegativeIntOf(row.route_attempts),
  }))

  return {
    tool: 'recruitment_tasks_status',
    contract_version: TASKS_STATUS_CONTRACT_VERSION,
    captured_at: nowIso,
    stuck_after_seconds: STUCK_AFTER_SECONDS,
    counts: {
      by_status: byStatus,
      running: intOf(scalar.running),
      waiting_human: intOf(scalar.waiting_human),
      stuck: intOf(scalar.stuck),
      events_received_unrouted: intOf(scalar.events_received_unrouted),
      events_stuck: intOf(scalar.events_stuck),
      oldest_waiting_seconds: nullableSeconds(scalar.oldest_waiting_seconds),
      oldest_unrouted_event_seconds: nullableSeconds(scalar.oldest_unrouted_event_seconds),
      last_24h: { tasks: last24Tasks, by_status: last24ByStatus },
    },
    tasks: taskResult.rows.map((row) => mapTaskRow(row, nowMs)),
    stuck_tasks: stuckTaskResult.rows.map((row) => mapTaskRow(row, nowMs)),
    attempts,
    events: {
      by_dispatch_state: countMapOf(eventsByStateResult.rows, 'dispatch_state', 'n'),
      oldest_unrouted_seconds: nullableSeconds(scalar.oldest_unrouted_event_seconds),
      stuck: stuckEvents,
    },
    dispositions: {
      by_disposition: countMapOf(dispByDispositionResult.rows, 'disposition', 'n'),
      by_reason: countMapOf(dispByReasonResult.rows, 'reason_code', 'n'),
      total: intOf(dispTotalResult.rows[0]?.n),
    },
  }
}

/**
 * 读任务状态（自建短连接池 + `withReadOnly`；每次调用在 `finally` 里关池）。
 * @param database - 已解析的数据库配置（tenant 只从这里来）。
 * @returns CONTRACT §3 的响应体。
 */
export async function readTasksStatus(database: ResolvedDatabaseConfig): Promise<TasksStatusResponse> {
  const pool = createPool(database)
  try {
    return await withReadOnly(pool, async (client) => readTasksStatusProjection(client, database.tenant_id))
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  HTTP 层
// =====================================================================

/** 宿主 `webServer` 的最小面（与 `http/overview.ts` 一致）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 本端点需要的宿主上下文。 */
export interface DisplayTasksHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 注册入口依赖：数据库未配置时路由仍存在但返回 503（不假装空列表 = 一切正常）。 */
export interface DisplayTasksDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly issues?: readonly string[]
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 固定错误体：`{"error":{"code","reason_code","message"}}`（code 只用 CONTRACT §0 闭集）。 */
function jsonError(res: ServerResponse, status: number, code: string, reasonCode: string, message: string): void {
  json(res, status, { error: { code, reason_code: reasonCode, message } })
}

/** 回环判据：只接受 127.0.0.1 / ::1。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/** 客户端身份覆盖企图（query 参数或头）。 */
function findActorOverride(req: Pick<IncomingMessage, 'headers'>, url: URL): string[] {
  const found: string[] = []
  for (const key of ['actor_id', 'tenant_id'] as const) {
    if (url.searchParams.has(key)) found.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) found.push(`header.${key}`)
  }
  return found
}

/**
 * 注册任务状态路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警（fail-closed，CONTRACT §0）。
 * @param ctx - 宿主上下文（含 webServer）。
 * @param deps - 数据库配置（null = 未配置，503）与配置 issues。
 * @returns 注销函数。
 */
export function registerDisplayTasksHttp(ctx: DisplayTasksHostContext, deps: DisplayTasksDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 任务状态路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0
  const database = deps.database

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      // 同源校验（与 overview.ts 同一口径）。
      if (!sameOrigin(req, port)) {
        jsonError(res, 403, 'FORBIDDEN', 'SAME_ORIGIN_REQUIRED', '只允许本机回环 + 同源请求（Host/Origin/x-recruitment-request 校验未通过）')
        return
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', ...NO_STORE })
        res.end()
        return
      }
      // tenant/actor 只来自部署配置：任何客户端覆盖都在碰 DB 之前拒掉。
      const overrides = findActorOverride(req, url)
      if (overrides.length > 0) {
        jsonError(
          res, 400, 'INVALID_ARGS', 'ACTOR_OVERRIDE_REJECTED',
          'actor/tenant 只来自部署配置，不接受客户端传入（D-33 / IR-M4d）',
        )
        return
      }
      // 本端点不接受任何查询参数（未知参数 400，不静默忽略）。
      const unknown = [...url.searchParams.keys()]
      if (unknown.length > 0) {
        jsonError(res, 400, 'INVALID_ARGS', 'UNKNOWN_PARAM', `未声明的查询参数 "${unknown[0]}"（本端点不接受查询参数）`)
        return
      }
      if (database === null) {
        jsonError(
          res, 503, 'NOT_CONFIGURED', 'DATABASE_NOT_CONFIGURED',
          '数据库未配置，读不到任务状态（不返回假空列表）',
        )
        return
      }
      const body = await readTasksStatus(database)
      json(res, 200, body)
    } catch {
      // 读失败必须可解释：日志只写固定文案（不带 SQL/连接串/绝对路径/异常原文），
      // 响应固定 500 错误体。
      ctx.logger?.warn('recruitment: 任务状态读取失败（数据库只读查询未完成，已按 INTERNAL 拒绝）')
      jsonError(res, 500, 'INTERNAL', 'DB_READ_FAILED', '读取任务状态失败（数据库只读查询未完成）')
    }
  }

  return webServer.register({ kind: 'exact', path: TASKS_STATUS_PATH, handler })
}
