# 任务 13 验收：DSH 旧侧栏入口退役（2026-11-21，1440）

> 来源：PR #13（`feat/task-13-retire-legacy-sidebar`，`4b00388`，2 文件 +18/−93）→ feat；本地 merge **`fe1930c`**（`lib/client.js` 重建随 merge；`lib/app.js` 无变化）。
> 验收环境：预览 Host **49351**（`rec-human-20261120` / `ra_human_20261120`，2026-11-21 22:08 用新构建 + `-PreviewAlias recruiter` 重启，pid 1864），全新 Chrome profile 1440。
> 结论：**通过**——侧栏不再出现「招聘工作台」、无 `recruiting-workspace` 旧壳；直链 `/recruitment/app` 正常渲染 v4；15 步 15/15。

## 1. PR #13 复核

- 仅 2 文件：`src/client/index.tsx`（移除 `sidebar.panellist` + `main` 槽位注册、去掉 `RecruitmentShell` 引用，保留空 `apply()` 兼容宿主装载）+ `src/app/TESTID-MANIFEST.md`（补 D-178/任务 13 说明）。
- **未动**：服务端/`src/http/**`、写链路、既有 testid、`tsdown.config.ts`、`package.json`、`src/client/canvas/**`；无新增依赖。
- 本地门禁：`tsc --noEmit` 0；`tsdown` 双入口通过（`lib/client.js` 重建）；server-typecheck 0/0、runtime-budget 5051/5051、entry-reachability、client-contract-check、term-lint 全 PASS。

## 2. 1440 真机（全新 Chrome profile）

| 项 | 观测 |
|---|---|
| DSH 侧栏 | 不再出现「招聘工作台」；侧栏只有「插件 / 自动化任务 / 更多」与工作区会话列表（`pr13-verify.json` 的 `hasLegacyEntry:false`、`legacyText:[]`） |
| DSH 主区 | 无 `recruiting-workspace` 旧壳（`hasLegacyShell:false`）；DSH 回到运行时/聊天宿主（D-178） |
| 直链 `/recruitment/app` | `app-chat-panel` + `app-canvas` 正常；队列/早报/身份「招聘负责人 HR」；无 `app-unbound-screen`（预览默认身份 D-180 生效） |
| 截图 | `sidebar-no-legacy-1440.png`、`direct-app-v4-1440.png` |

- 说明：用全新 profile 验证注册移除；旧浏览器若残留旧布局/固定项，属本地缓存，重开或清站点数据即可（注册已不存在）。

## 3. 回归

- **15 步 `run-v4.mjs --fresh`：15/15 PASS**（审计 hard 0；`regression-15step-result.json` / `audit.json`）。
- 机检：`gates.txt`。

## 4. 后续

- 产品唯一入口 = `/recruitment/app`（D-178）；生产登录/独立域名仍在交付期开放项。
- 旧 `RecruitmentShell` 源码仍在（未删除），但已无注册入口；如需物理清理另立任务（避免误删 `src/client/**` 复用组件）。
