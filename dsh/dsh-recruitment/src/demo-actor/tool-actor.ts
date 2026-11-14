// 写工具的"用哪个 actor 写"适配层。
//
// 产品路径（`src/index.ts` 装配了 `identity`）：严格走
//   `resolveWriteActor.resolveExecutionActor(exec, identity)` 这条链，
//   拿不到 session / 未绑定 / alias 无映射 ⇒ 抛 `DEMO_ACTOR_UNMAPPED`（在开事务之前，零写入）。
//
// 兼容路径（`identity === undefined`）：直接用调用方给的 `legacyActorId`（= `config.actor_id`）。
//   ⚠️ 这条分支**只为既有 unit/integration 测试兼容**存在（它们直接构造
//   `create*Tool().execute(args)`，不经过 `src/index.ts` 的 identity 装配）。
//   **产品路径不会走到这里**：`src/index.ts` 给每个写工具装配 identity；
//   新代码/新测试不得依赖 legacy 分支，也不得把它当作"回退到 config.actor_id"的产品语义。

import type { DemoActorIdentity, ResolvedExecutionActor } from './resolve.ts'
import { resolveExecutionActor } from './resolve.ts'

/** 写工具依赖的第二组参数（`identity` 由插件装配；缺省 = 仅测试兼容的 legacy 路径）。 */
export interface ToolActorDeps {
  /** 已装配的 Demo Actor 身份（映射表 + session 注册表）。 */
  readonly identity?: DemoActorIdentity
}

/** 一次"写身份"解析的结论。 */
export interface WriteActorResolution {
  /** 本次写库要用的 actor UUID（写工具把它交给 `withActor` / `set_config`）。 */
  readonly actor_id: string
  /** 严格解析结果；legacy 分支为 `null`。 */
  readonly resolved: ResolvedExecutionActor | null
  /** 是否走了 legacy（仅测试兼容）分支。 */
  readonly legacy: boolean
}

/**
 * 解析一次写操作的作者身份。
 * @param exec - DSH 的 `ToolRunContext`（工具里类型是 `unknown`）。
 * @param identity - 已装配的身份；`undefined` = 未装配（仅测试兼容路径）。
 * @param legacyActorId - 未装配时使用的 actor（= `config.actor_id`；**产品路径不使用**）。
 * @returns `{actor_id, resolved, legacy}`。
 * @throws RecruitmentToolError - `DEMO_ACTOR_UNMAPPED`（identity 已装配但解析失败）。
 */
export function resolveWriteActor(
  exec: unknown,
  identity: DemoActorIdentity | undefined,
  legacyActorId: string,
): WriteActorResolution {
  if (identity === undefined) {
    // 仅测试兼容：既有测试的 deps 不传 identity，保持原有 config.actor_id 行为。
    // 产品路径由 src/index.ts 装配 identity，不会进入本分支。
    return { actor_id: legacyActorId, resolved: null, legacy: true }
  }
  const resolved = resolveExecutionActor(exec, identity)
  return { actor_id: resolved.actor_id, resolved, legacy: false }
}
