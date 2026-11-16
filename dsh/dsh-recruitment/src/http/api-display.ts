// owner-api-display（V5「看得见」的后端只读口子）· 统一注册器。
//
// 三个端点（都只读、都 loopback + sameOrigin、失败一律 fail-closed）：
//   GET|HEAD /recruitment/api/material/<material_id>/content   原件受控获取（按需点开原文）
//   GET      /recruitment/api/usage?session_id=…               DSH 会话计量（原样透出，不自建）
//   GET      /recruitment/api/tasks/status                     业务任务 / 卡住事件只读投影
//
// 为什么需要这个汇总文件：`src/index.ts` 是本项目总控独占写范围（D-86），本 lane 不直接改；
// 接线由总控按 `work/d5/api-display/wiring/index.patch` 落。这里只提供一个**返回 disposer**
// 的注册函数（与 `registerOverviewHttp` / `registerRecruitingHttp` 同形），供那一处
// `child.effect(() => registerApiDisplayHttp(...), 'recruitment: api display routes')` 使用。
//
// 契约：`work/d5/api-display/CONTRACT.md`。本文件不新写业务逻辑，只做组合：
//   * material-content.ts —— DB 元数据 + `resolveMaterialPath`（allowed_roots 内按 sha256 定位）；
//   * display-usage.ts   —— 插件进程内 DSH 服务（`ctx.get('sessions'/'sessionProjections')`）；
//   * display-tasks.ts   —— PG 只读投影（business_task / task_attempt / event_disposition / event_inbox）。
//
// 纪律：不新增依赖、不碰前端、不写库；非回环由各子注册器各自 fail-closed（不注册 + warn）。
import type { ResolvedDatabaseConfig } from '../db/pool.ts'
import {
  registerMaterialContentHttp,
  type MaterialContentDeps,
  type MaterialContentHostContext,
} from './material-content.ts'
import {
  registerDisplayUsageHttp,
  type DisplayUsageDeps,
  type DshUsageHostContext,
} from './display-usage.ts'
import {
  registerDisplayTasksHttp,
  type DisplayTasksDeps,
  type DisplayTasksHostContext,
} from './display-tasks.ts'

/** 三个子注册器共同需要的宿主面（cordis 子上下文；`get` 用于解析 DSH 服务）。 */
export interface ApiDisplayHostContext extends MaterialContentHostContext, DshUsageHostContext, DisplayTasksHostContext {}

/** `registerApiDisplayHttp` 的依赖。 */
export interface ApiDisplayDeps {
  /** 已解析的业务库配置；`null` = 未配置（端点仍注册，需要库的返回 503 NOT_CONFIGURED）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** 未配置时缺失的配置项（只放键名，绝不放密码/路径）。 */
  readonly databaseIssues: readonly string[]
  /**
   * 材料定位的允许根（缺省 = 各子注册器默认读 `RECRUITMENT_ALLOWED_ROOT_*`，与 converter 同一组 env）。
   * 只在测试/受控验证时注入；生产不传。
   */
  readonly roots?: () => readonly string[]
  /** DSH 用量访问器（缺省 = 从 ctx.get 解析；`null` = 强制不可用，只用于测试/降级）。 */
  readonly dsh?: DisplayUsageDeps['dsh']
}

/**
 * 注册 owner-api-display 的三个只读端点；返回**一个** disposer，供 `child.effect(...)` 使用。
 *
 * disposer 必须真的注销三条路由：这里按注册的逆序调用子 disposer；即使某个子注册器
 * 因非回环 host 没注册（返回 noop），也不会影响其它两个（各子注册器自己判断）。
 *
 * @param ctx - 宿主 cordis 子上下文（含 webServer；可选 logger/get）。
 * @param deps - 库配置 + issues（+ 测试可注入的 roots / dsh）。
 * @returns 注销函数（插件卸载即注销三条路由）。
 */
export function registerApiDisplayHttp(ctx: ApiDisplayHostContext, deps: ApiDisplayDeps): () => void {
  const materialDeps: MaterialContentDeps = {
    database: deps.database,
    databaseIssues: deps.databaseIssues,
    ...(deps.roots === undefined ? {} : { roots: deps.roots }),
  }
  const usageDeps: DisplayUsageDeps = { ...(deps.dsh === undefined ? {} : { dsh: deps.dsh }) }
  const tasksDeps: DisplayTasksDeps = {
    database: deps.database,
    issues: deps.databaseIssues,
  }

  const disposeMaterial = registerMaterialContentHttp(ctx, materialDeps)
  const disposeUsage = registerDisplayUsageHttp(ctx, usageDeps)
  const disposeTasks = registerDisplayTasksHttp(ctx, tasksDeps)

  let disposed = false
  return (): void => {
    if (disposed) return
    disposed = true
    // 逆序：后注册的先注销；单个 disposer 抛错不阻断其余（都只是撤路由）。
    for (const dispose of [disposeTasks, disposeUsage, disposeMaterial]) {
      try {
        dispose()
      } catch {
        // 注销失败没有业务后果（宿主卸载会统一清理），不把异常抛给插件卸载链。
      }
    }
  }
}
