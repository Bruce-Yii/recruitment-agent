# 独立整页 v4（`src/app/**`）`data-testid` 清单与交付说明

> 对应对接方案：`design/v4/fullpage-integration-plan.md`（D-167）。
> 原则：100% 视口独立整页 v4 暖纸白工作台，无 DSH 左侧栏，正式界面无 Recruiter/Interviewer 下拉与旧顶部页签；直接复用已通过 15/15 验收的 `src/client/canvas/**` 写链路与 `src/client/interviewer/InterviewerWorkspace.tsx`。

## 一、新增整页壳与队列 / 对话 `data-testid`

| `data-testid` | 对应元素 | 说明 |
|---|---|---|
| `app-loading` | 会话加载屏 | 启动请求 `GET /recruitment/app/session` 期间显示 |
| `app-session-error` | 会话异常屏 | `/recruitment/app/session` 请求失败时显示 |
| `app-unbound-screen` | 未绑定身份阻塞页 | 未绑定身份时渲染「尚未选择身份，请联系管理员绑定」，无任何身份下拉 |
| `app-actor-badge` | 右上角只读身份徽标 | 展示当前成员姓名与角色（只读） |
| `app-nav-queue` | 左侧导航「今日待办」 | 跳转 `#/queue` |
| `app-nav-jobs` | 左侧导航「在招岗位」 | 跳转 `#/jobs` |
| `app-nav-talent` | 左侧导航「人才库」 | 跳转 `#/talent` |
| `app-canvas` | 右侧主画布根节点 | 包含队列、岗位、人才库、候选人画布、岗位画布与面试官视图 |
| `app-queue-view` | 今日待办视图根 | `#/queue` 主内容区 |
| `app-queue-filter-all` | 队列筛选「全部」 | 不过滤阶段 |
| `app-queue-filter-screening` | 队列筛选「待初筛」 | 筛选 `filterKind === 'screening'` |
| `app-queue-filter-interviewing` | 队列筛选「面试中」 | 筛选 `filterKind === 'interviewing'` |
| `app-queue-filter-<stageCode>` | 按阶段代码筛选 | 动态对应 `counts.byStage[].code` |
| `app-queue-search` | 队列搜索输入框 | 按姓名/岗位/阶段即时过滤 |
| `app-queue-item-<application_id>` | 队列候选人行 | 悬停 120ms 预取详情，点击进入 `#/application/<application_id>` |
| `app-action-upload` | 队列右上角「导入简历」按钮 | 触发真实 `<input type="file">`，走 `uploadResumeRaw` |
| `app-jobs-view` | 在招岗位视图根 | `#/jobs` 主内容区 |
| `app-job-item-<job_id>` | 岗位行 | 点击进入 `#/job/<job_id>` |
| `app-talent-view` | 人才库视图根 | `#/talent` 主内容区 |
| `app-talent-search` | 人才库搜索框 | 跨岗位检索候选人 |
| `app-talent-item-<application_id>` | 人才库候选人行 | 点击进入 `#/application/<application_id>` |
| `app-interviewer-view` | 面试官视图容器 | `#/interviewer` 或面试官单角色自动进入 |
| `app-chat-panel` | 伴随式 Agent 对话栏根 | 支持拖拽调宽、折叠与简历拖拽上传 |
| `app-chat-log` | 对话消息流容器 | 展示 `delta` 增量文本与 `tool` 执行状态标签 |
| `app-chat-input` | 对话输入框 | 输入自然语言指令 |
| `app-chat-send` | 对话发送按钮 | 提交 `POST /recruitment/agent/turn`（SSE） |
| `app-chat-upload` | 对话栏隐藏文件输入 | 左侧 `+` 按钮触发真实 `<input type="file">` |
| `app-chat-unavailable` | Agent 不可用提示条 | 服务端返回 503 / `AGENT_UNAVAILABLE` 时显示，不阻塞右侧工作台 |

## 二、复用的画布与弹窗 `data-testid`（来自 `src/client/canvas/**`，保持与 15/15 写链路完全一致）

| `data-testid` | 对应元素 |
|---|---|
| `canvas-action-star` | 候选人星标按钮 |
| `canvas-action-candidate-upload` | 候选人画布内上传简历/附件按钮（触发真实 `<input type="file">`） |
| `canvas-action-transcript-import` | 导入面谈转写按钮 |
| `canvas-action-pin` | 置顶约束按钮 |
| `canvas-action-handoff` | 下一轮交接按钮 |
| `canvas-action-schedule` | 约面 / 改期换人按钮 |
| `canvas-action-transfer` | 跨岗调剂按钮 |
| `canvas-action-stage-advance` | 推进阶段 / 跳轮按钮 |
| `canvas-action-no-show` | 标记未出席按钮 |
| `canvas-action-email` | 发邮件按钮 |
| `canvas-action-screening` | 初筛结论按钮 |
| `canvas-action-decision` | 正式决策按钮（统一走 `postDecisionRecordFacade`） |
| `canvas-modal-submit` | 动作确认弹窗主提交按钮 |
| `schedule-mode-reschedule` | 排期弹窗「改期」模式切换 |
| `schedule-interviewers-input` | 排期弹窗面试官编号输入框 |
| `schedule-time-input` | 排期弹窗时间输入框 |
| `replace-interviewer-input` | 排期弹窗更换面试官输入框 |
| `decision-missing-scorecards` | 决策弹窗缺面评阻塞提示 |
| `canvas-candidate-pager` | 候选人上一位 / 下一位翻页控件（`[` / `]`） |
| `canvas-sync-pill` | 后台静默同步状态徽标 |

## 三、复用的面试官端 `data-testid`（来自 `src/client/interviewer/InterviewerWorkspace.tsx`）

- 沿用 `InterviewerWorkspace.tsx` 既有 `interviewer-row`、`scorecard-form`、`submit-scorecard` 等全部 selector，无任何破坏。

## 四、云端环境限制与需本地验证项

- 本次变更仅新增 `dsh/dsh-recruitment/src/app/**`（不改 `tsdown.config.ts`、`tsconfig.json`、`src/http/**` 与旧 `RecruitingWorkspace.tsx`，避免与本地侧双入口构建/服务端路由提交冲突）。
- 为避免 `package.json` 尚未安装 `@types/react-dom` 导致 `tsc` 报错，已附带 `src/app/react-dom-client.d.ts`（本地安装 `@types/react-dom` 后可保留或移除）。
- 云端沙箱无本地构建链与真库，以下项目需在本地合并后实测：
  1. 双入口 `tsdown` 产出 `lib/app.js` + `lib/app.css` 及 `npx tsc --noEmit`；
  2. `GET /recruitment/app` 真机访问、`/recruitment/app/session` + `rc_sid` cookie + `POST /recruitment/agent/turn` SSE 流与 503 降级；
  3. 更新后的 15 步自动化剧本与 1440px / 390px 截图验收。
