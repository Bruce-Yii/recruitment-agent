# 独立整页入口 · 对接方案（v4 整页为唯一基准）

> 依据：产品负责人 2026-11-20 裁决——**定稿的 `recruitment_os_v4.html` 是唯一基准**：完整一体化整页产品界面，
> **不嵌套在 DSH 左侧会话栏**；正式界面**不得出现**开发测试用的身份 `<select>`、三段绑定文案、旧顶部页签。
> 任务 09 的"塞进旧壳"方案作废。本文件是给前端窗口的**一次性对接契约**。

---

## 1. 总体边界

| 项 | 决定 |
|---|---|
| 呈现 | **独立整页**：`http://127.0.0.1:<Host端口>/recruitment/app`，100% 视口，无 DSH 外壳/会话栏 |
| 基准 | `design/v4/recruitment_os_v4.html`（定稿），整页版式与视觉照它，不再迁就旧 DOM |
| 宿主 | 仍是同一个 DSH Host 进程（同端口、同源），**只借它的 HTTP 端口与数据库/工具能力**，不借它的 UI |
| 构建 | 新增独立入口 `src/app/**`（React），tsdown 产出 `lib/app.js` + `lib/app.css`；**与 DSH client module 互不影响** |
| 复用 | 直接复用现有 `src/client/canvas/**` 组件（纯 React，无 DSH 依赖）与业务 HTTP 客户端；**不重写写链路** |
| 旧壳 | `RecruitingWorkspace.tsx` 等旧界面**保留但不再作为产品入口**（过渡期只读可达），不再要求它长得像 v4 |

## 2. 独立整页入口（我做服务端，前端做页面）

### 2.1 路由与静态资源
| 路由 | 用途 |
|---|---|
| `GET /recruitment/app` | 返回整页 HTML（`<div id="root">` + `app.css` + `app.js`），`Cache-Control: no-store` |
| `GET /recruitment/app/assets/app.js`、`app.css` | 从 `dsh/dsh-recruitment/lib/` 读文件返回，正确 `content-type` |
| `GET /recruitment/test` | **仅测试入口**：按 query 设置身份 cookie 后 302 到 `/recruitment/app`（见 §3.3），正式导航不出现 |

### 2.2 前端入口契约
- `src/app/main.tsx`：挂载 `<App/>`，`document.getElementById('root')`，**不 import 任何 DSH client 模块**；
- 启动时：`GET /recruitment/app/session`（返回当前 sid/actor/roles）→ 设置画布会话（`setCanvasSessionId(sid)`）→ 拉 `GET /recruitment/api/recruiting/overview`；
- 页面路由用 `history.pushState`（`/recruitment/app#/queue`、`#/application/<id>`、`#/job/<id>`、`#/interviewer`），刷新可恢复。

## 3. 会话、鉴权与身份（测试与正式解耦）

### 3.1 会话
- `GET /recruitment/app` 若请求**无** `rc_sid` cookie：服务端生成 `session-<uuid>`，`Set-Cookie: rc_sid=...; Path=/; SameSite=Lax`（非 HttpOnly——前端要把它放进 `X-DSH-Session`）；
- 所有业务 API 继续用既有 `X-DSH-Session` 头（**契约不变**），前端从 cookie 读值发送；
- 服务端仍按 `x-dsh-session` 解析身份（既有 `PUT /recruitment/api/actor` 逻辑不变）。

### 3.2 正式界面（不允许出现切换器）
- 页面顶部只显示**当前身份徽标**（姓名/角色，只读）；
- 未绑定身份时显示一个**阻塞页**（"尚未选择身份，请联系管理员绑定"），不显示 Recruiter/Interviewer 下拉；
- 身份来源：`rc_actor` cookie（服务端写入），由部署/管理员或测试入口设置。

### 3.3 测试/调试身份（不进正式 UI）
- `POST /recruitment/app/session/actor`，body `{ "alias": "recruiter" | "interviewer_a" | "interviewer_b" }`
  - 仅接受**loopback 同源**请求；写 `rc_actor` cookie；返回 `{sid, alias, actor_id, display_name, roles}`；
  - 自动化脚本直接调它（或 CDP 设 cookie），**不需要点任何界面控件**；
- `GET /recruitment/test?as=interviewer_a&next=/recruitment/app`：设 cookie 后 302，仅供人工调试/浏览器书签；
- 面试官视图：`#/interviewer`（或按角色自动进入），**没有**"面试官工作台"页签。

## 4. 对话 / Agent 接口（前端只需要这一个契约）

### 4.1 发送一轮对话
`POST /recruitment/agent/turn`
```jsonc
// request
{ "text": "把张样例约到明天下午，面试官找 A", "context": { "application_id": "…", "route": "#/application/…" } }
// response: text/event-stream，每行一个 SSE 事件
event: delta      data: {"text":"好的，我先确认三点…"}
event: tool       data: {"name":"recruitment_interview_schedule","status":"start","input":{...}}
event: tool       data: {"name":"recruitment_interview_schedule","status":"ok","result":{...}}
event: done       data: {"turn_id":"…","usage":{...}}
event: error      data: {"code":"AGENT_UNAVAILABLE","message":"…"}
```
- 服务端实现：插件 `ctx.inject(['agents','sessions'])`，按 sid 取/建 Agent，投递 user/message，订阅 `session/event`，把 `assistant/message` 增量与 `tool/call|result` 转 SSE；
- **Agent 不可用时**：返回 503 + `AGENT_UNAVAILABLE`，页面显示"对话暂时不可用"，**业务按钮不受影响**（两条路独立）；
- 写操作的闸门不变：Agent 仍经既有 `confirmation_text` + 服务端哈希，页面对话里出现确认卡时走业务 API（见 §5）。

### 4.2 可选：事件回放
`GET /recruitment/agent/events?since=<cursor>`（SSE）——断线重连用；第一版可只做 §4.1。

## 5. 前端要对接的业务 API（全部既有，同源，勿改契约）

**统一头**：`x-recruitment-request: 1`、`X-DSH-Session: <sid>`、`Content-Type: application/json`、`credentials:'same-origin'`。
**错误信封**：`{error:{code, reason_code, message, detail?}}`；界面显示 `message`（人话），不显示 code。

### 5.1 只读
| 用途 | 端点 |
|---|---|
| 工作台总览 / 队列 | `GET /recruitment/api/recruiting/overview` |
| 申请全貌（材料/面试/决策/时间线） | `GET /recruitment/api/recruiting/applications/<application_id>` |
| 岗位详情 | `GET /recruitment/api/recruiting/jobs/<job_id>` |
| 面试官工作台 | `GET /recruitment/api/interviewer/overview?alias=<alias>` |
| 决策事实（basis/summary/coverage） | `GET /recruitment/api/decision/facts?application_id=<id>` |
| 设置 / 用量 / 任务状态 | `GET /recruitment/api/settings`、`GET /recruitment/api/usage`、`GET /recruitment/api/tasks/status?task_id=<id>` |
| 空闲时段 | `GET /recruitment/api/action/interview/free-slots?application_id=…&interviewer_actor_ids=…&days=5&duration_minutes=45` |

### 5.2 写入（全部经"人点确认"，body 一律由既有 builder 产出）
`POST /recruitment/api/action/screening/decide`、`/decision/record`（action 版）、`/stage/advance`、
`/interview/schedule`（CREATE / RESCHEDULE / REPLACE_INTERVIEWER / MARK_NO_SHOW）、`/transcript/import`、
`/job/rubric-approve`、`/config/role`、`/config/team`、`/config/pipeline`、`/application/transfer`、
`/candidate/constraint`、`/job/create`、`/application/star`、`/batch-reject`、`/undo`。
facade：`POST /recruitment/api/decision/record`（终审决策**必须**走这条，服务端组装 basis/summary_digest）、
`POST /recruitment/api/decision/screening/evaluate`。
上传：`POST /recruitment/api/intake/upload`（`input[type=file]` 真上传，返回 `task_id` 后轮询）。
邮件：`POST /recruitment/api/action/email/send`、`.../send-authorized`、`.../authorize`。
面评（面试官）：`POST /recruitment/api/actor`（绑定）、`/recruitment/api/action/scorecard/draft`、`/recruitment/api/action/scorecard/submit`、`/recruitment/api/action/scorecard/form-spec`。
妙记改绑：`POST /recruitment/api/action/interview/rebind-minute`（默认 dry-run）。

## 6. data-testid 契约（前端提供，我同步脚本）

**原则**：旧壳 selector 一律不再要求；前端在 v4 正式元素上给出**稳定 testid**，交付时附"testid → 元素"清单，我据此改自动化脚本与 `docs/38`。
建议命名（可调整，但交付时以清单为准）：

| 元素 | 建议 testid |
|---|---|
| 左栏队列条目 | `app-queue-item-<application_id>` |
| 队列筛选 | `app-queue-filter-<stage>` |
| 右栏画布根 | `app-canvas` |
| 画布动作按钮 | `app-action-screening`、`app-action-decision`、`app-action-schedule`、`app-action-no-show`、`app-action-stage-advance`、`app-action-transcript-import`、`app-action-upload`、`app-action-email`、`app-action-star` |
| 确认卡提交 | `app-confirm-submit` |
| 排期弹窗字段 | `app-schedule-mode-create`、`app-schedule-mode-reschedule`、`app-schedule-interviewers`、`app-schedule-time`、`app-schedule-replace` |
| 身份徽标（只读） | `app-actor-badge` |
| 对话输入 | `app-chat-input`、`app-chat-send`、`app-chat-log` |

## 7. 交付与验收

- **前端**：一个分支（PR #7）交付整页 v4 + 按 §4/§5 对接 + §6 testid 清单；不再要求接入 DSH 槽位；
- **我做**：§2.1 的整页路由与静态资源服务、§3 的 session/actor 端点、§4 的 Agent SSE 桥（含 spike）、双入口构建、以及自动化脚本/验收清单同步；
- 验收：`GET /recruitment/app` 打开即 v4、100% 视口、无身份下拉；`agent/turn` 能回一段话；15 步新脚本全 PASS；`tsc`/`tsdown`/机检绿；1440 与 390 截图。
- 风险：DSH `agents/sessions` 服务 API 需 1 小时 spike 验证；若不通，第一版对话降级为"打开 DSH 会话"链接，并如实标注（不假装能用）。
