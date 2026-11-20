# 前端任务 13 · DSH 侧栏旧入口退役；产品入口 = 独立 v4 页面

> **提出**：产品负责人 2026-11-21。原话：**“为什么非要在 dsh 里面？……不应该点击链接就是我们的产品吗？”**
> **产品裁决（D-178）**：最终用户入口 = **独立产品 UI `/recruitment/app`**；DSH 只是 Agent 运行时/本地预览宿主，其 token、侧栏、旧 `RecruitmentShell` 不得进入用户路径。本任务不再追求“侧栏打开 v4”，而是**把旧侧栏入口退役/隐藏**，让产品入口回到独立页面。
> **分工**：本地总控只取证、不改界面（D-168/D-175）；本任务由产品/前端窗口实现。

## 1. 取证（已入库）

- `evidence/legacy-sidebar-entry-20261121/`：
  - 点 DSH 侧栏「招聘工作台」→ 旧壳：`recruiting-workspace` / `overview-headline` / `job-hero`，顶栏“招聘工作台 / 面试官工作台 / Human Attention / 演示身份”；
  - 直链 `/recruitment/app` → v4：`app-nav-queue` / `app-chat-panel` / `app-chat-log` / `app-canvas`；
  - 1440 截图两张 + DOM/testid JSON。
- 注册点：`dsh/dsh-recruitment/src/client/index.tsx:86-97`（`main` 面板 = `RecruitmentShell`；`sidebar.panellist` 项 = “招聘工作台”）。
- 产品依据：`design/v4/frontend-task-09-v4-shell.md` 已要求“打开招聘工作台第一屏就是 v4”；v4 是独立整页（D-167），与 DSH 面板是两套。

## 2. 要做的（D-178 后）

1. **退役/隐藏 DSH 侧栏旧入口**：不再注册指向 `RecruitmentShell` 的 `sidebar.panellist` 项；`RecruitmentShell` 旧壳不再作为产品入口。
   - 如果还需要保留“面试官工作台”入口，单独评估（v4 已含 `#/interviewer` 路由），不得把旧壳整体留在默认侧栏。
2. **产品入口 = 直链 `/recruitment/app`**：保证独立页面可直接打开；演示环境的身份 bootstrap 可继续用现有 `/recruitment/test`（仅本地预览，正式交付由 D-178 的产品登录替代）。
3. **可选 dev 快捷方式**：如开发期仍想从 DSH 一点进入，可放一个**明确标注 dev-only**的快捷方式（如打开 `/recruitment/app` 的前端链接），但不得再渲染旧壳、不得称为产品入口。
4. **不改服务端写链路/工具**；若身份 bootstrap 需要服务端接口（DSH session → rc_sid/alias），先写契约，由本地总控实现。

## 3. 验收（前端自测 + 总控复验）

- DSH 默认侧栏不再出现打开旧壳的「招聘工作台」入口；点开任何保留入口都不得出现 `recruiting-workspace` 旧壳；
- 直链 `/recruitment/app` 在 1440 正常显示 v4（`app-chat-panel` + `app-canvas`），身份徽标正确/未绑定按既有 fail-closed 提示；
- `run-v4.mjs --fresh` 15/15 不回归；既有 v4 testid 不破坏；
- 交付：`git diff --stat` + 逐文件 diff + 1440 截图（侧栏状态 + 直链产品页）+ 点击路径说明。

## 4. 不在本任务

- 产品登录/独立域名/部署（D-178 交付期开放项，不与本地验证混谈）；
- token 改造：DSH 进程级 token 属宿主行为；本地登录一次后 cookie 持久（已实测重启 Host 后免 token 直链可进），正式产品用产品登录替代。
- 旧 `RecruitmentShell` 代码是否物理删除由产品/前端窗口决定；本任务最低要求是**不再作为用户入口可见/可达**。
