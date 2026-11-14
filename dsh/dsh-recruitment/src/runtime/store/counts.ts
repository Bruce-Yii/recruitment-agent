// 任务运行时的**计数查询**（G12 拆分自 runtime/store.ts；只读，withReadOnly）。
//
// 运行时计数不参与业务判断：健康检查/证据用，并带 cutover 历史积压读数
// （cutoverStore.legacyBacklog() 由调用方传入，与本 store 同一份 pool/tenant）。
import type { DatabasePool } from '../../db/pool.ts'
import { withReadOnly } from '../../db/pool.ts'
import type { RuntimeCutoverStore } from '../cutover.ts'
import { num } from './readback.ts'

/** 当前可派发任务数（用于生成"可解释的空闲"原因）。 */
export async function claimableTaskCount(
  pool: DatabasePool, tenantId: string, excludedTaskTypes: readonly string[],
): Promise<number> {
  return withReadOnly(pool, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      `select count(*)::text as n
           from recruitment.business_task
          where tenant_id = $1::uuid
            and status in ('PENDING', 'READY', 'RETRY_WAIT')
            and (next_run_at is null or next_run_at <= now())
            and not (task_type = any($2::text[]))`,
      [tenantId, [...excludedTaskTypes]],
    )
    return num(rows[0]?.n)
  })
}

/**
 * 运行时计数（健康检查/证据用；不参与业务判断）。
 *
 * 除了基础计数，还带 **cutover 历史积压** 读数（`events_legacy_undispatched` /
 * `events_before_cutover_pending` / `events_legacy_oldest_wait_seconds`）：
 * 把历史事件标成 IGNORED 只是"不再派发"，不等于"没有积压"。运维必须能一眼看到
 * "有多少历史事件从未被派发、最老等了多久"，否则"扫完了"会被误读成"没积压"。
 * 两次只读查询顺序执行（不嵌套事务，避免连接池上限被自己占满）。
 */
export async function runtimeCounts(
  pool: DatabasePool, tenantId: string, cutoverStore: RuntimeCutoverStore,
): Promise<Record<string, number>> {
  const base = await withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid) as events,
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid and dispatch_state = 'ROUTED') as events_routed,
           (select count(*) from recruitment.event_inbox where tenant_id = $1::uuid and dispatch_state = 'FAILED') as events_failed,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid) as tasks,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid and status = 'SUCCEEDED') as tasks_succeeded,
           (select count(*) from recruitment.business_task where tenant_id = $1::uuid and status = 'FAILED') as tasks_failed,
           (select count(*) from recruitment.task_attempt where tenant_id = $1::uuid) as attempts,
           (select count(*) from recruitment.agent_session where tenant_id = $1::uuid) as sessions`,
      [tenantId],
    )
    const row = rows[0] ?? {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(row)) out[key] = num(value)
    return out
  })
  const legacy = await cutoverStore.legacyBacklog()
  base.events_legacy_undispatched = legacy.undispatchedEvents
  // 分开说清两类历史（reviewer 要求）：还在队列里的 vs 早已被判定但从未派发的
  base.events_legacy_undispatched_ignored = legacy.undispatchedIgnored
  base.events_legacy_internal_audit = legacy.internalAuditEvents
  base.events_before_cutover_pending = legacy.pendingBeforeCutover
  base.events_ignored_before_cutover = legacy.alreadyIgnoredByCutover
  base.events_legacy_oldest_wait_seconds = legacy.oldestWaitSeconds ?? 0
  return base
}
