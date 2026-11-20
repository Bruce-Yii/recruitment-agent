# 前端任务 13 · DSH 侧栏「招聘工作台」必须直接打开 v4（旧壳退役）

> **提出**：产品负责人 2026-11-21。原话：**“左侧边的招聘工作台点开是老的垃圾，只有点第二个才有用”**。
> **性质**：界面集成缺陷，不是新需求。`design/v4/frontend-task-09-v4-shell.md` 已裁决“打开招聘工作台第一屏就是 v4，不许老首页 + 点进去才变画布”，但 DSH 侧栏至今仍注册旧 `RecruitmentShell`。
> **分工**：本地总控只取证、不改界面（D-168/D-175）；本任务由产品/前端窗口实现。

## 1. 取证（已入库）

- `evidence/legacy-sidebar-entry-20261121/`：
  - 点 DSH 侧栏「招聘工作台」→ 旧壳：`recruiting-workspace` / `overview-headline` / `job-hero`，顶栏“招聘工作台 / 面试官工作台 / Human Attention / 演示身份”；
  - 直链 `/recruitment/app` → v4：`app-nav-queue` / `app-chat-panel` / `app-chat-log` / `app-canvas`；
  - 1440 截图两张 + DOM/testid JSON。
- 注册点：`dsh/dsh-recruitment/src/client/index.tsx:86-97`（`main` 面板 = `RecruitmentShell`）；v4 `src/app/App.tsx` 由 `src/http/app-shell.ts` 在 `/recruitment/app` 单独提供，未接进侧栏。

## 2. 要做的（二选一，产品窗口定）

**方案 A（推荐，改动最小）**：把 DSH `main` 面板组件从 `RecruitmentShell` 换成 v4 `App`（嵌入 DSH 主区）。
- 需要给 `App` 提供当前 DSH 会话身份：不要要求用户先走 `/recruitment/test`；用 DSH session（`localStorage['dsh.sessions.current']`）向服务端换取/绑定 `rc_sid` + alias，或由 App 接收宿主传入的 sid。
- 旧 `RecruitmentShell` 不再作为默认入口（可删除/移入显式的“旧版”入口，或直接退役）。

**方案 B**：侧栏项改为“打开 v4 整页”的入口（如 `window.open('/recruitment/app')` 或宿主内新标签），同时用一次性参数完成 sid/alias 引导；旧壳隐藏。
- 必须保证不是“只有直链能用”；用户从侧栏点一次就应到达 v4。

## 3. 验收（前端自测 + 总控复验）

- DSH 主界面点侧栏「招聘工作台」→ 1440 下出现 `app-chat-panel` + `app-canvas`，**不出现** `recruiting-workspace` 旧壳；
- 正常流程**不需要** `/recruitment/test` 兜底（若沿用方案 B 的引导参数，需在交付说明里写清）；
- 身份徽标显示当前会话身份（Recruiter / Interviewer），未绑定时按既有 fail-closed 提示，不静默降级；
- 直链 `/recruitment/app` 仍可用；`run-v4.mjs --fresh` 15/15 不回归；不破坏既有 v4 testid；
- 交付：`git diff --stat` + 逐文件 diff + 1440 截图（侧栏点击后）+ 点击路径说明。

## 4. 不在本任务

- token 改造：DSH 进程级 token 属宿主行为；用户登录一次后 cookie 持久（本地已实测重启 Host 后免 token 直链可用），不需要前端处理。
- 服务端路由/工具/写链路不改；若方案 A 需要服务端增加“DSH session → rc_sid/alias”绑定接口，先在本任务书写明契约，由本地总控实现（不要前端直连身份系统）。
