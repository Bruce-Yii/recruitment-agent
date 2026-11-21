// 浏览器插件入口（DSH 客户端模块装载点）：
//
// 按产品裁决 D-178 与前端任务 13（design/v4/frontend-task-13-sidebar-entry-v4.md）：
// - 最终用户产品入口统一为独立整页 v4：`/recruitment/app`（由 `src/app/main.tsx` 构建为 `lib/app.js`）；
// - DSH 仅作为 Agent 运行时与本地预览宿主，旧 `RecruitmentShell`（`recruiting-workspace`）不再作为产品入口；
// - 因此本入口不再向 DSH 注册 `sidebar.panellist`（“招聘工作台”）或 `main` 面板槽位，保持最小空操作以兼容宿主模块装载。
//
// 说明：`src/client/canvas/**`、`src/client/recruiting/**` 与 `src/client/interviewer/**`
// 仍保留于源码目录中，供独立整页 v4（`src/app/**`）与静态契约检查复用。

/** Cordis 客户端插件依赖声明（旧侧栏退役后无需注入 `slots` 服务）。 */
export const inject: readonly string[] = []

/**
 * DSH 浏览器插件空操作入口（不再注册旧 RecruitmentShell 侧栏与主面板）。
 */
export function apply(): void {
  // Intentionally empty: legacy RecruitmentShell sidebar/main entries retired per D-178.
}
