// 运行时测试的数据库底座：**每个测试文件一个一次性空库**，按 0001→N 顺序
// 重放迁移，跑完 `DROP DATABASE ... WITH (FORCE)`。
//
// 为什么不用 `test/integration/db.ts` 的"事务里造夹具 + ROLLBACK"：
//   运行时的验收点恰恰是**跨事务、跨连接、进程重启后**仍然成立的事实：
//   `event_inbox` 的 provider 事件唯一、`task_wakeup` 同一事件只唤醒一次、
//   `task_attempt` 的租约回收。这些必须真提交才看得见；ROLLBACK 掉就只剩
//   "单事务内看起来对"。
//
// 为什么用空库而不是 `ra_s6s7`：
//   1. `event_inbox` / `business_task` 等表有 no-delete 触发器，测试数据无法清理；
//   2. 空库顺序重放本身就是一条验收（迁移 0001→N 可在空库跑通）；
//   3. 每个文件独立库，`node --test` 并行跑互不干扰。
//
// 实现只有一份：`test/integration/db.ts` 的 `createIsolatedTestDatabase()`
// （集成测试里需要真提交的引擎 / Outbox 用例也用同一份，避免两套隔离口径漂移）。
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  type IsolatedTestDatabase,
} from '../integration/db.ts'

/** 一次性测试库的句柄（与集成测试同一份实现）。 */
export type RuntimeTestDatabase = IsolatedTestDatabase

/**
 * 建一个一次性库并把 0001→N 全部应用。
 * @param label - 库名后缀（便于并发运行时定位）。
 * @returns 可用的连接池 + `drop()`。
 */
export async function createRuntimeTestDatabase(label: string): Promise<RuntimeTestDatabase> {
  const database = await createIsolatedTestDatabase(`rt_${label}`)
  // 守卫：运行时用例必须是私库，不许回落到共享的 ra_s6s7（并行跑会互相偷行）。
  assertPrivateDatabase(database.name)
  return database
}

/** 测试用的租户 / actor 与 0002_seed 的演示数据一致。 */
export const RUNTIME_TENANT = '11111111-1111-4111-8111-000000000001'
export const RUNTIME_ACTOR = '11111111-1111-4111-8111-000000000103'

/** 一个稳定的 APPLICATION id（UUID 形状；business_refs 是 JSONB，不做外键）。 */
export const DEMO_APPLICATION = '22222222-2222-4222-8222-000000000001'
