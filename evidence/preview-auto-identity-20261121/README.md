# 预览环境默认身份自动绑定（2026-11-21）：不再每次 `/recruitment/test`

> 产品负责人反馈：“为什么每次要绑定，真无语。” 本目录记录根因、修复与真机验证。
> 范围：**仅本地预览**。生产身份仍由真实登录替代（D-178），本改动不改变生产语义。

## 1. 根因

- v4 独立页的身份来自 `rc_sid` cookie + 进程内 `SessionActorRegistry`（`src/demo-actor/session-registry.ts`）。
- 该注册表**只在内存**；Host 重启即清空。
- `/recruitment/test?as=...` 每次 **新建 sid** 并显式绑定 alias（`app-shell.ts` 的 `testHandler`），所以以前每次重启后要再走一次这个测试入口，否则 `/recruitment/app` 显示“尚未选择身份”。
- 这不是产品登录，是演示身份脚手架。

## 2. 修复（仅预览启用）

- `AppShellDeps` 新增 `previewAlias?`；当 **显式 env `RECRUITMENT_PREVIEW_ALIAS`** 有值且为合法 alias、且请求在 loopback 预览路由上、且 session 尚未绑定时，自动绑定该 alias（`ensureSid` 内）。
- 显式绑定（`/recruitment/app/session/actor`、`/recruitment/test`）仍然优先，不会被自动绑定覆盖。
- 启动脚本 `start-host.ps1` 新增 `-PreviewAlias recruiter`；**不传 = 不启用**（自动化/生产行为不变）。
- 预览 Host 49351 现在用 `-PreviewAlias recruiter` 启动；直接开 `/recruitment/app` 就是招聘负责人身份。

## 3. 真机验证

| 场景 | 结果 |
|---|---|
| 全新 Chrome profile：token 登录一次 → 直接开 `/recruitment/app`（**不走 test**） | `app-unbound-screen` 不出现；徽标“招聘负责人 HR”；`/recruitment/app/session` 返回 `bound:true, alias:recruiter`（见 `auto-bind.json`） |
| **重启 Host 后**：同一个浏览器直接开 `/recruitment/app`（**不带 token / 不走 test**） | 仍直接进入 v4，身份 `recruiter`，session 同一 sid（见 `auto-bind-after-restart.json`） |
| 自动化（不带 `-PreviewAlias`） | 15 步 `--fresh` **15/15 PASS**（审计 hard 0）；行为与之前一致 |

- 截图：`direct-app-auto-bound-1440.png`、`after-restart-direct-app-1440.png`。
- 机检：`tsc` 0；server-typecheck 0/0、runtime-budget、entry-reachability、client-contract-check、term-lint 全 PASS。

## 4. 说明 / 边界

- 仅本地预览：生产用户入口与登录是另一件事（D-178：独立产品 UI + 产品登录/域名）。
- 需要切面试官身份时：仍可用 `/recruitment/test?as=interviewer_a` 或显式切换；自动绑定只在“未绑定”时生效。
- token 仍只在浏览器首次登录/清 cookie 时需要；登录后 cookie 持久，Host 重启不必重新进 token 链接（本次已验证带 cookie 直接进）。
- 预览库仍保留此前为验证置顶标签写入的 1 条演示约束（与本次无关）。
