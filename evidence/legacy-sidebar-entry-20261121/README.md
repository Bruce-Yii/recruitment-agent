# 侧栏入口缺陷取证：点「招聘工作台」打开旧 shell，v4 只能走直链（2026-11-21）

> 产品负责人 2026-11-21 反馈：进入 Host 后点左侧「招聘工作台」是“老的垃圾”，只有第二个入口（直链 `/recruitment/app`）才有用。
> 结论：**属实，是界面集成缺陷**——DSH 侧栏面板仍注册为旧 `RecruitmentShell`，v4 整页是另一个 HTTP 页面，没有接进侧栏。
> 本目录只取证；修复归前端窗口（`design/v4/frontend-task-13-sidebar-entry-v4.md`），本地总控不改界面（D-168）。

## 1. 事实（预览 Host 49351，1440）

| 入口 | 实际渲染 | 关键 testid |
|---|---|---|
| DSH 侧栏「招聘工作台」 | 旧壳 `RecruitmentShell`（顶栏：招聘工作台 / 面试官工作台 / Human Attention / 演示身份；内容为旧“招聘总览”面板） | `recruiting-workspace`、`overview-headline`、`job-hero`、`application-row-*` |
| 直接打开 `/recruitment/app` | v4 整页（左 Agent 对话 + 右画布；今日待办/在招岗位/人才库） | `app-nav-queue`、`app-chat-panel`、`app-chat-log`、`app-canvas`、`app-queue-view` |
| `/recruitment/test?as=recruiter&next=/recruitment/app` | 绑定演示身份后 302 到 v4 | 同上 |

- 截图：`01-sidebar-opens-legacy-shell-1440.png`（旧壳）、`02-direct-app-v4-1440.png`（v4）。
- 机器读数：`panel-info.json`（侧栏点击后 DOM/testid）、`direct-app.json`（直链 v4）。
- 侧栏注册点：`dsh/dsh-recruitment/src/client/index.tsx:86-97` 把 `main` 面板注册为 `RecruitmentShell`；v4 `src/app/App.tsx` 由 `src/http/app-shell.ts` 在 `/recruitment/app` 单独提供，**没有**注册成侧栏面板。
- 产品依据：`design/v4/frontend-task-09-v4-shell.md` 已明确“打开招聘工作台 → 直接就是 v4 暖纸白外框，不许老首页 + 点进去才变画布”。

## 2. token / 身份的真实行为（回答“为什么每次都进 token”）

- DSH Web 的 `?token=` 是**进程级一次性 launch token**：每次 Host 启动生成；首次访问后换取**持久签名 cookie**（`BrowserAuth`，`dsh-client-connection`）。
- 实测：重启 Host 后，**不带 token** 直接打开 `/recruitment/app` 仍能进（cookie 仍在）；只有换浏览器/清 cookie 才需要再拿一次 token。
- v4 的演示身份来自 `/recruitment/test` 设置的 `rc_sid` cookie；绑定一次后，直链 `/recruitment/app` 可继续用。
- 因此：**token 不是每次都要**；产品负责人可把 `http://127.0.0.1:49351/recruitment/app` 存书签（首次登录 + 绑定身份后）。当前之所以每次发 token 链接，是重启 Host 后换了一个新 token，属于预览流程，不是产品要求。

## 3. 复跑

```powershell
# 需要 49351 预览 Host 在跑
node work/d5/fullpage/inspect-sidebar.mjs   # 侧栏按钮清单
node work/d5/fullpage/inspect-panel.mjs     # 点“招聘工作台”后的旧壳 DOM/testid + 截图
node work/d5/fullpage/test-direct-app.mjs   # token+test 后直链 /recruitment/app
```

## 4. 期望（前端任务 13 验收）

点侧栏「招聘工作台」→ 直接是 v4（`app-chat-panel` + `app-canvas`），不出现 `recruiting-workspace` 旧壳；正常流程不需要 `/recruitment/test` 兜底；旧壳退役/隐藏；直链 `/recruitment/app` 与 15 步回归不受影响。
