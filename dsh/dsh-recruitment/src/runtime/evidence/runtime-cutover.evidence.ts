// 历史事件 cutover 的 **dry-run 证据**（只读；不写任何一行）。
//
// 用途：开启 `runtime.enabled=true` 之前，先在**真实库**上回答：
//   * 这个租户的水位定在哪、为什么（reason / record_version / 审计行数）；
//   * 按 event_type / dispatch_state / received_at 分组，库里到底是什么分布；
//   * 一次 tick 会把多少条历史事件标成 IGNORED（`BEFORE_RUNTIME_CUTOVER`，
//     **不派发、不建 Task**）、多少条会正常派发。
//
// 为什么必须只读：dry-run 的结论要能作为"上线前会处理多少条"的证据。任何写入
// 都会让证据反过来改变被测对象（R3：证据不得与被测状态混淆）。本脚本的全部查询
// 都走 `begin transaction read only`，写语句会被 PG 直接拒绝（25006），
// 不依赖"代码里没写 UPDATE"这种自觉。
//
// 运行（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='<local dev db password>'
//   node src/runtime/evidence/runtime-cutover.evidence.ts
//
// 环境变量（与 test/integration/db.ts 一致，默认连 ra_s6s7）：
//   RECRUITMENT_TEST_DB_HOST / _PORT / _USER / RECRUITMENT_TEST_DB
import { withReadOnly } from '../../db/pool.ts'
import { createTestPool, testDatabaseConfig } from '../../../test/integration/db.ts'
import {
  BEFORE_CUTOVER_REASON_PREFIX,
  EVENT_DISPATCHABLE_SQL,
  RuntimeCutoverStore,
} from '../cutover.ts'

/** 与 `RuntimeConfig.pending_batch_size` 默认值一致（证明"分几轮处理完"）。 */
const BATCH_LIMIT = 20
/** 与 `RuntimeConfig.max_route_attempts` 默认值一致。 */
const MAX_ROUTE_ATTEMPTS = 5

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 组内时间范围（`::text` 保留数据库时区，便于人读）。 */
interface TimeRange {
  readonly first_received_at: string | null
  readonly last_received_at: string | null
}

try {
  const tenant = cfg.tenant_id
  const cutoverStore = new RuntimeCutoverStore({ pool, tenantId: tenant })

  // ── 1) 库级分布（不只看待派发：IGNORED 里已有多少是水位造成的，也要能区分）──
  const byState = await withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select dispatch_state,
              count(*)::text                         as n,
              min(received_at)::text                 as first_received_at,
              max(received_at)::text                 as last_received_at
         from recruitment.event_inbox
        where tenant_id = $1::uuid
        group by dispatch_state
        order by count(*) desc`,
      [tenant],
    )
    return rows.map((row) => ({
      dispatch_state: String(row.dispatch_state),
      n: Number(row.n),
      first_received_at: row.first_received_at === null ? null : String(row.first_received_at),
      last_received_at: row.last_received_at === null ? null : String(row.last_received_at),
    }))
  })

  const byType = await withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select event_type,
              dispatch_state,
              normalizer_version,
              count(*)::text         as n,
              min(received_at)::text as first_received_at,
              max(received_at)::text as last_received_at
         from recruitment.event_inbox
        where tenant_id = $1::uuid
        group by event_type, dispatch_state, normalizer_version
        order by count(*) desc, event_type, dispatch_state`,
      [tenant],
    )
    return rows.map((row) => ({
      event_type: String(row.event_type),
      dispatch_state: String(row.dispatch_state),
      normalizer_version: row.normalizer_version === null ? null : String(row.normalizer_version),
      n: Number(row.n),
      first_received_at: row.first_received_at === null ? null : String(row.first_received_at),
      last_received_at: row.last_received_at === null ? null : String(row.last_received_at),
    }))
  })

  // ── 2) 权威判定：直接调运行时自己的只读预览（与 tick 共用同一份谓词）──
  const preview = await cutoverStore.preview(BATCH_LIMIT, MAX_ROUTE_ATTEMPTS)

  // ── 3) 历史积压的**运维读数**：多少历史事件从未被派发、最老等了多久 ──
  //    与 preview 的"下一轮会扫多少"不同：这里不会因为 tick 扫尾而变小。
  const legacy = await cutoverStore.legacyBacklog()

  // ── 4) 待派发集合里"会被水位扫尾"的明细（只读；用于核对上面数字）──
  const wouldIgnore = await withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select e.event_type,
              count(*)::text         as n,
              min(e.received_at)::text as first_received_at,
              max(e.received_at)::text as last_received_at
         from recruitment.event_inbox e
         join recruitment.runtime_watermark w
           on w.tenant_id = e.tenant_id
          and e.received_at < w.cutover_at
        where e.tenant_id = $1::uuid
          and ${EVENT_DISPATCHABLE_SQL}
        group by e.event_type
        order by count(*) desc, e.event_type`,
      [tenant, MAX_ROUTE_ATTEMPTS],
    )
    return rows.map((row) => ({
      event_type: String(row.event_type),
      n: Number(row.n),
      first_received_at: row.first_received_at === null ? null : String(row.first_received_at),
      last_received_at: row.last_received_at === null ? null : String(row.last_received_at),
    }))
  })

  const auditRows = await withReadOnly(pool, async (client) => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select change_kind, old_cutover_at::text, new_cutover_at::text,
              reason, changed_by_actor_id::text as actor, changed_at::text
         from recruitment.runtime_watermark_change
        where tenant_id = $1::uuid
        order by changed_at`,
      [tenant],
    )
    return rows
  })

  const roundsToClear = preview.pendingBeforeCutover === 0
    ? 0
    : Math.ceil(preview.pendingBeforeCutover / Math.max(1, preview.batchLimit))

  const report = {
    mode: 'DRY_RUN_READ_ONLY',
    generated_at: new Date().toISOString(),
    database: cfg.database,
    tenant,
    batch_limit: preview.batchLimit,
    max_route_attempts: MAX_ROUTE_ATTEMPTS,
    cutover: preview.cutover,
    cutover_audit: auditRows,
    event_inbox_by_dispatch_state: byState,
    event_inbox_by_event_type: byType,
    pending_split: {
      total: preview.pendingTotal,
      before_cutover_will_be_ignored: preview.pendingBeforeCutover,
      after_cutover_will_be_dispatched: preview.pendingAfterCutover,
      already_ignored_by_cutover: preview.alreadyIgnoredByCutover,
      oldest_pending_received_at: preview.oldestPendingReceivedAt,
      newest_pending_received_at: preview.newestPendingReceivedAt,
      rounds_to_clear_history_at_batch_limit: roundsToClear,
      reason_prefix: BEFORE_CUTOVER_REASON_PREFIX,
    },
    pending_by_event_type: preview.byEventType,
    would_be_ignored_by_event_type: wouldIgnore,
    // 健康检查里会出现的字段（GET /recruitment/runtime/health 的 counts）：
    // "有多少历史事件从未被派发 / 最老的等了多久"必须能一眼看到。
    legacy_backlog: legacy,
    health_counts_preview: {
      events_legacy_undispatched: legacy.undispatchedEvents,
      events_legacy_undispatched_ignored: legacy.undispatchedIgnored,
      events_legacy_internal_audit: legacy.internalAuditEvents,
      events_before_cutover_pending: legacy.pendingBeforeCutover,
      events_ignored_before_cutover: legacy.alreadyIgnoredByCutover,
      events_legacy_oldest_wait_seconds: legacy.oldestWaitSeconds ?? 0,
    },
  }

  console.log(JSON.stringify(report, null, 2))
  console.log('')
  console.log(`DRY-RUN READ-ONLY: tick 会把 ${preview.pendingBeforeCutover} 条历史事件标成`
    + ` ${BEFORE_CUTOVER_REASON_PREFIX}（不建 Task、不派发），`
    + `${preview.pendingAfterCutover} 条正常派发；batch=${preview.batchLimit} → 历史积压需 ${roundsToClear} 轮清空。`)
  console.log(`历史未派发（cutover 之前的派发候选，routed_task_id is null）: ${legacy.undispatchedEvents} 条`
    + `（${legacy.undispatchedReceived} RECEIVED / ${legacy.undispatchedFailed} FAILED / ${legacy.undispatchedIgnored} IGNORED），`
    + `最老等了 ${legacy.oldestWaitSeconds ?? 0}s（${legacy.oldestUndispatchedReceivedAt ?? 'n/a'}）；`
    + `另有 ${legacy.internalAuditEvents} 条库触发器审计事件（schema/0001，本来就不进派发队列）。`)
} finally {
  await pool.end().catch(() => {})
}
