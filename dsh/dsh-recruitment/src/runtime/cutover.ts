// 事件运行时的 **cutover 水位**（历史事件分界线）：读取、扫尾、只读预览。
//
// 为什么要独立成一个文件（而不是塞进 store.ts / event-runtime.ts）：
//   水位是"哪些事件算历史"的**唯一权威判定**，它有两个消费方（tick 的取数查询、
//   上线前的 dry-run 预览）和一套独立的 DB 契约（`db/migrations/0015_runtime_cutover.sql`
//   的 `runtime_watermark` / `runtime_watermark_change`）。把判定与 SQL 收在一处，
//   才可能做到"派发查询、扫尾、预览"用的是**同一份谓词**，不会三份实现慢慢漂移。
//
// 判定语义（权威表述见 `contracts/runtime/runtime-cutover.md`）：
//   * 判定列是 `event_inbox.received_at`（**服务端**在入库时生成的时间），
//     不是事件 payload 里的 `occurred_at` —— 后者来自外部，外部可伪造；
//   * `received_at < cutover_at` → 历史：tick 只把 dispatch 投影标成
//     `IGNORED`，原因 `BEFORE_RUNTIME_CUTOVER: ...`；不建 Task、不写 wakeup、
//     不入队副作用、**不 UPDATE 任何事件主体列**（0011 §1.9 的列级白名单只有
//     dispatch 投影列，越界会被 `IMMUTABLE_COLUMN` 拒绝）；
//   * `received_at >= cutover_at` → 正常派发；
//   * 没有水位行 → **fail closed**：`EventRuntime.processPending()` 抛
//     `CUTOVER_WATERMARK_MISSING`，绝不猜一个"现在"。
//
// 为什么 `listPendingEvents` 里用 **JOIN 水位**而不是把 cutover 当参数传进去：
//   参数化会让"忘了传"变成一个静默的漏洞（查询照常返回历史事件，只是少了过滤）。
//   JOIN 让"取数必须尊重水位"成为 SQL 的结构性质：没有水位行就一行都取不到，
//   调用方想绕过也绕不过去。
import type { DatabaseClient, DatabasePool } from '../db/pool.ts'
import { withActor, withReadOnly } from '../db/pool.ts'

/** 历史事件被扫尾时写进 `event_inbox.route_error` 的固定前缀（可机检/可统计）。 */
export const BEFORE_CUTOVER_REASON_PREFIX = 'BEFORE_RUNTIME_CUTOVER'

/**
 * 待派发事件的谓词片段（`store.listPendingEvents` 与 dry-run 预览**共用这一份**）。
 *
 * 为什么排除 `normalizer_version = 'schema/0001'`：那是 0001 `fn_row_guard`
 * 每次状态迁移写的**审计事实**，不是进站触发事件。把它当待路由事件，等于每次
 * tick 都去"路由"业务表自己的状态变化（语义准入事件 semantic.* / router.* 例外，
 * 它们确实是触发）。这条谓词在 0001/0011 的注释里写过，这里做成常量是为了
 * 水位预览与真实派发用同一份口径。
 *
 * 占位符约定：`$2` = maxRouteAttempts（`$1` 由调用方绑定租户）。
 */
export const EVENT_DISPATCHABLE_SQL = `e.dispatch_state in ('RECEIVED', 'FAILED')
      and e.route_attempts < $2
      and (e.normalizer_version is distinct from 'schema/0001'
           or e.event_type like 'semantic.%'
           or e.event_type like 'router.%')`

/** 当前生效的 cutover 水位（每租户一行；0015 §1）。 */
export interface RuntimeCutover {
  readonly tenantId: string
  /**
   * 分界线（ISO-8601，带时区）：`received_at` 早于它的事件算历史。
   *
   * ⚠️ 这是**展示/传递用**的值，只有毫秒精度（PG `timestamptz` 是微秒）。任何
   * "早于/等于"的判定都必须在数据库里做（`store.listPendingEvents` 与
   * `sweepBefore` 都是 SQL JOIN 水位），不要把这个字符串转成 JS `Date` 再比 ——
   * 会因丢掉的微秒把"恰好等于边界"的事件误判成历史。
   */
  readonly cutoverAt: string
  /** 为什么定在这个时刻（人可读，非空）。 */
  readonly reason: string
  /** 乐观并发版本（每次显式变更 +1，0015 的守卫维护）。 */
  readonly recordVersion: number
  readonly updatedAt: string
}

/**
 * 历史积压的**运维可观测性**（不是判定逻辑，但必须能一眼看到）。
 *
 * 为什么需要它：把历史事件标成 `IGNORED` 只是"不再派发"，不等于"问题消失"。
 * 运维必须能回答两个问题：
 *   1. 有多少历史事件**从未被派发**（`routed_task_id is null` 且早于水位）？
 *      ——这是"上线漏处理了多少"的口径，不随 tick 扫尾而变小（扫尾只改投影，
 *      不改变"从未派发"这个事实）；
 *   2. 最老的那条等了多久（`oldest_wait_seconds`）？——积压的时间成本。
 *
 * 口径说明（与 `preview()` 的区别）：
 *   * `preview()` 的 `pendingBeforeCutover` = **下一次 tick 会标 IGNORED 的条数**
 *     （扫完就变 0）；
 *   * `undispatchedEvents` = **所有早于水位且从未派发的事件**（含已 IGNORED 的
 *     历史审计/Gate 事件），是"历史总量"，不会因为 tick 跑过而消失。
 *   两个数字都写进 health，避免"扫完了 = 没积压"的误读。
 */
export interface CutoverLegacyBacklog {
  /** 当前水位；`null` = 该租户没有声明过边界（此时分不出"历史"，计数为 0）。 */
  readonly cutover: RuntimeCutover | null
  /** 早于水位且 `routed_task_id is null`（从未被派发）的事件总数。 */
  readonly undispatchedEvents: number
  readonly undispatchedReceived: number
  readonly undispatchedFailed: number
  readonly undispatchedIgnored: number
  /** 其中仍在待派发队列里的（下一次 tick 会被水位扫尾标 IGNORED）。 */
  readonly pendingBeforeCutover: number
  /** 已经因为水位被标 IGNORED 的（`route_error` 前缀）。 */
  readonly alreadyIgnoredByCutover: number
  /** 从未派发的历史事件里最早的一条入库时间。 */
  readonly oldestUndispatchedReceivedAt: string | null
  /** 到目前为止最老那条等了多久（秒，整数）。 */
  readonly oldestWaitSeconds: number | null
}

/** `RuntimeCutoverStore.sweepBefore` 的返回（历史事件被标 IGNORED 的一条）。 */
export interface CutoverSweepHit {
  readonly eventId: string
  readonly eventType: string
  /** 事件入库时间（DB 生成，判定依据）。 */
  readonly receivedAt: string
  /** 实际写进 `route_error` 的完整原因（含水位时刻）。 */
  readonly reason: string
}

/** dry-run 预览里按事件类型拆的一行。 */
export interface CutoverPreviewBreakdown {
  readonly eventType: string
  readonly normalizerVersion: string | null
  /** 本类型里 `received_at < cutover_at`（会被标 IGNORED）的条数。 */
  readonly beforeCutover: number
  /** 本类型里 `received_at >= cutover_at`（会正常派发）的条数。 */
  readonly afterCutover: number
}

/**
 * 只读 dry-run 预览：**不写任何一行**（在 `begin transaction read only` 里跑，
 * 写语句会被数据库直接拒绝，不靠"代码里没写 UPDATE"这种自觉）。
 */
export interface CutoverPreview {
  /** 当前水位；`null` = 该租户没有声明过边界（运行时此时会 fail closed）。 */
  readonly cutover: RuntimeCutover | null
  /** 当前派发谓词命中的事件总数（不论水位）。 */
  readonly pendingTotal: number
  /** 其中会被判为历史、标成 `IGNORED` 的条数（= 本次 dry-run 的"会处理多少条"）。 */
  readonly pendingBeforeCutover: number
  /** 其中会正常派发的条数。 */
  readonly pendingAfterCutover: number
  /** 已经因为水位被标过 IGNORED 的条数（证明扫尾是幂等的、不会重复计数）。 */
  readonly alreadyIgnoredByCutover: number
  readonly oldestPendingReceivedAt: string | null
  readonly newestPendingReceivedAt: string | null
  /** 一次 tick 最多扫 / 派发多少条（决定"分几轮处理完"，不改变最终数量）。 */
  readonly batchLimit: number
  readonly byEventType: readonly CutoverPreviewBreakdown[]
}

/** `RuntimeCutoverStore` 的构造输入。 */
export interface RuntimeCutoverStoreOptions {
  readonly pool: DatabasePool
  readonly tenantId: string
  /**
   * 写 dispatch 投影时使用的 actor（必须属于该租户；来自插件配置）。
   * 只有 `sweepBefore()` 需要；纯只读用法（dry-run）可以不给。
   */
  readonly actorId?: string
}

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

const num = (value: unknown): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') return Number(value)
  return 0
}

function mapCutover(row: Record<string, unknown> | undefined): RuntimeCutover | null {
  if (row === undefined) return null
  return {
    tenantId: String(row.tenant_id),
    cutoverAt: iso(row.cutover_at) ?? '',
    reason: String(row.reason),
    recordVersion: num(row.record_version),
    updatedAt: iso(row.updated_at) ?? '',
  }
}

/**
 * 水位读写入口（每个运行时租户一个实例；由 `RuntimeStore.cutover` 暴露）。
 *
 * 三个方法的分工：
 *   * `read()`：读当前水位（tick 开头一次，用于 fail closed 判定与错误可读性）；
 *   * `sweepBefore()`：把一个批次的**历史**事件标成 IGNORED（写 dispatch 投影）；
 *   * `preview()`：只读 dry-run，回答"这条库上会处理多少条"。
 */
export class RuntimeCutoverStore {
  private readonly pool: DatabasePool
  private readonly tenantId: string
  private readonly actorId: string | null

  /**
   * @param options - 连接池 + 运行时租户 + 可选 actor（来自插件配置，不接受模型入参）。
   */
  constructor(options: RuntimeCutoverStoreOptions) {
    this.pool = options.pool
    this.tenantId = options.tenantId
    this.actorId = options.actorId ?? null
  }

  /** 当前运行时租户。 */
  get tenant(): string {
    return this.tenantId
  }

  /**
   * 读当前水位。
   * @returns 水位行；没有 → `null`（调用方必须 fail closed，不许补默认值）。
   */
  async read(): Promise<RuntimeCutover | null> {
    return withReadOnly(this.pool, async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `select tenant_id, cutover_at, reason, record_version, updated_at
           from recruitment.runtime_watermark
          where tenant_id = $1::uuid`,
        [this.tenantId],
      )
      return mapCutover(rows[0])
    })
  }

  /**
   * 把本批次内 `received_at < cutover_at` 的待派发事件标成 `IGNORED`。
   *
   * 三条硬边界：
   *   1. 只改 0011 §1.9 白名单里的 dispatch 投影列（`dispatch_state` /
   *      `routed_at` / `processed_at` / `route_attempts` / `route_error` /
   *      `business_object_*` / `routed_task_id`），事件主体一行不动；
   *   2. **不建 Task、不写 task_wakeup、不入队副作用**（与路由路径完全分离）；
   *   3. 水位判定在 UPDATE 的 WHERE 里（不只依赖 CTE 的选择），即使扫描与更新
   *      之间水位被推进，也不会误标"其实已经进入新窗口"的事件。
   * @param limit - 本批最多扫多少条（每轮 tick 的工作量上限）。
   * @param maxRouteAttempts - 与派发谓词一致的路由重试上限（超过的不再扫）。
   * @returns 本次实际标成 IGNORED 的事件（空数组 = 没有历史积压）。
   */
  async sweepBefore(limit: number, maxRouteAttempts: number): Promise<readonly CutoverSweepHit[]> {
    return withActor(this.pool, this.tenantActor(), async (client) => {
      const { rows } = await client.query<Record<string, unknown>>(
        `with cut as (
           select cutover_at
             from recruitment.runtime_watermark
            where tenant_id = $1::uuid
         ), picked as (
           select e.event_id
             from recruitment.event_inbox e
             cross join cut
            where e.tenant_id = $1::uuid
              and e.received_at < cut.cutover_at
              and ${EVENT_DISPATCHABLE_SQL}
            order by e.received_at
            limit $3
            for update of e skip locked
         )
         update recruitment.event_inbox e
            set dispatch_state = 'IGNORED',
                routed_at = now(),
                processed_at = now(),
                route_attempts = e.route_attempts + 1,
                route_error = format(
                  '${BEFORE_CUTOVER_REASON_PREFIX}: received_at %s < runtime cutover %s; not dispatched (no task, no side effect; runtime cutover policy)',
                  e.received_at, cut.cutover_at),
                business_object_type = null,
                business_object_id = null,
                routed_task_id = null
           from picked, cut
          where e.tenant_id = $1::uuid
            and e.event_id = picked.event_id
            and e.received_at < cut.cutover_at
            and e.dispatch_state in ('RECEIVED', 'FAILED')
         returning e.event_id::text as event_id,
                   e.event_type,
                   e.received_at,
                   e.route_error`,
        [this.tenantId, maxRouteAttempts, limit],
      )
      return rows.map((row) => ({
        eventId: String(row.event_id),
        eventType: String(row.event_type),
        receivedAt: iso(row.received_at) ?? '',
        reason: String(row.route_error),
      }))
    })
  }

  /**
   * 只读 dry-run：当前水位下，一次 tick 会把哪些事件标成历史、哪些会正常派发。
   *
   * 为什么要它：上线前必须能回答"开 tick 会处理多少条、分别是哪类事件"，而不是
   * 靠"大概 40 条"这种转述。整个查询跑在只读事务里，**不可能**改库（R3：证据要
   * 可复跑、且不改变被测对象）。
   * @param batchLimit - 单轮 tick 的批量上限（用于说明分几轮处理完）。
   * @param maxRouteAttempts - 与派发谓词一致的路由重试上限。
   * @returns 计数 + 按事件类型拆分 + 当前水位。
   */
  async preview(batchLimit: number, maxRouteAttempts: number): Promise<CutoverPreview> {
    return withReadOnly(this.pool, async (client) => {
      const cutover = await this.readIn(client)
      const { rows } = await client.query<Record<string, unknown>>(
        `with w as (
           select cutover_at
             from recruitment.runtime_watermark
            where tenant_id = $1::uuid
         ), pending as (
           select e.event_type,
                  e.normalizer_version,
                  e.received_at,
                  (w.cutover_at is not null and e.received_at >= w.cutover_at) as after_cutover
             from recruitment.event_inbox e
             left join w on true
            where e.tenant_id = $1::uuid
              and ${EVENT_DISPATCHABLE_SQL}
         )
         select count(*)::text                                        as pending_total,
                count(*) filter (where not after_cutover)::text       as pending_before,
                count(*) filter (where after_cutover)::text           as pending_after,
                min(received_at)                                       as oldest_pending,
                max(received_at)                                       as newest_pending
           from pending`,
        [this.tenantId, maxRouteAttempts],
      )
      const byType = await client.query<Record<string, unknown>>(
        `with w as (
           select cutover_at
             from recruitment.runtime_watermark
            where tenant_id = $1::uuid
         ), pending as (
           select e.event_type,
                  e.normalizer_version,
                  (w.cutover_at is not null and e.received_at >= w.cutover_at) as after_cutover
             from recruitment.event_inbox e
             left join w on true
            where e.tenant_id = $1::uuid
              and ${EVENT_DISPATCHABLE_SQL}
         )
         select event_type,
                normalizer_version,
                count(*) filter (where not after_cutover)::text as before_cutover,
                count(*) filter (where after_cutover)::text     as after_cutover
           from pending
          group by event_type, normalizer_version
          order by count(*) desc, event_type`,
        [this.tenantId, maxRouteAttempts],
      )
      const ignored = await client.query<{ n: string }>(
        `select count(*)::text as n
           from recruitment.event_inbox
          where tenant_id = $1::uuid
            and route_error like '${BEFORE_CUTOVER_REASON_PREFIX}%'`,
        [this.tenantId],
      )
      const summary = rows[0] ?? {}
      return {
        cutover,
        pendingTotal: num(summary.pending_total),
        pendingBeforeCutover: num(summary.pending_before),
        pendingAfterCutover: num(summary.pending_after),
        alreadyIgnoredByCutover: num(ignored.rows[0]?.n),
        oldestPendingReceivedAt: iso(summary.oldest_pending),
        newestPendingReceivedAt: iso(summary.newest_pending),
        batchLimit,
        byEventType: byType.rows.map((row) => ({
          eventType: String(row.event_type),
          normalizerVersion: row.normalizer_version === null || row.normalizer_version === undefined
            ? null
            : String(row.normalizer_version),
          beforeCutover: num(row.before_cutover),
          afterCutover: num(row.after_cutover),
        })),
      }
    })
  }

  /**
   * 历史积压的运维读数（只读）：多少历史事件**从未被派发**、最老等了多久。
   *
   * 与 `preview()` 的分工见 `CutoverLegacyBacklog` 的 JSDoc：本方法是"历史总量"，
   * 不会因为 tick 扫尾而变小；`preview().pendingBeforeCutover` 是"下一轮会扫多少"。
   * 健康检查/上线报告应该同时显示两者，否则"扫完了"会被误读成"没积压"。
   * @returns 当前水位 + 历史未派发计数 + 最老等待时长。
   */
  async legacyBacklog(): Promise<CutoverLegacyBacklog> {
    return withReadOnly(this.pool, async (client) => {
      const cutover = await this.readIn(client)
      const { rows } = await client.query<Record<string, unknown>>(
        `with w as (
           select cutover_at
             from recruitment.runtime_watermark
            where tenant_id = $1::uuid
         )
         select count(*) filter (where e.routed_task_id is null)::text                                        as undispatched,
                count(*) filter (where e.routed_task_id is null and e.dispatch_state = 'RECEIVED')::text      as undispatched_received,
                count(*) filter (where e.routed_task_id is null and e.dispatch_state = 'FAILED')::text        as undispatched_failed,
                count(*) filter (where e.routed_task_id is null and e.dispatch_state = 'IGNORED')::text       as undispatched_ignored,
                count(*) filter (where e.routed_task_id is null
                                   and e.dispatch_state in ('RECEIVED', 'FAILED'))::text                       as pending,
                count(*) filter (where e.route_error like '${BEFORE_CUTOVER_REASON_PREFIX}%')::text          as already_ignored,
                min(e.received_at) filter (where e.routed_task_id is null)                                    as oldest_undispatched,
                extract(epoch from (now() - min(e.received_at) filter (where e.routed_task_id is null)))      as oldest_wait_seconds
           from recruitment.event_inbox e
           cross join w
          where e.tenant_id = $1::uuid
            and e.received_at < w.cutover_at`,
        [this.tenantId],
      )
      const row = rows[0] ?? {}
      const wait = row.oldest_wait_seconds
      return {
        cutover,
        undispatchedEvents: num(row.undispatched),
        undispatchedReceived: num(row.undispatched_received),
        undispatchedFailed: num(row.undispatched_failed),
        undispatchedIgnored: num(row.undispatched_ignored),
        pendingBeforeCutover: num(row.pending),
        alreadyIgnoredByCutover: num(row.already_ignored),
        oldestUndispatchedReceivedAt: iso(row.oldest_undispatched),
        oldestWaitSeconds: wait === null || wait === undefined ? null : Math.round(num(wait)),
      }
    })
  }

  /** 在调用方事务里读水位（`preview` 与计数同快照）。 */  private async readIn(client: DatabaseClient): Promise<RuntimeCutover | null> {
    const { rows } = await client.query<Record<string, unknown>>(
      `select tenant_id, cutover_at, reason, record_version, updated_at
         from recruitment.runtime_watermark
        where tenant_id = $1::uuid`,
      [this.tenantId],
    )
    return mapCutover(rows[0])
  }

  /** 扫尾写入用的 actor（构造时给定；只读用法不调用这里）。 */
  private tenantActor(): string {
    if (this.actorId === null) {
      throw new Error('CUTOVER_ACTOR_REQUIRED: RuntimeCutoverStore 需要 actor 才能写 dispatch 投影')
    }
    return this.actorId
  }
}
