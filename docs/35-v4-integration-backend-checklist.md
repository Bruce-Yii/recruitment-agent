# 35 · v4 前端接入指导书的后端对账（给前端 agent 的接口实况）

> 来源：`D:\12412\Documents\v4_local_agent_integration_guide.md`（前端接入指导书，**UI 冻结、只拔 Mock**）。
> 这份文件只做一件事：把指导书里假设的每一块后端能力**逐条对账**，标"已有 / 在建 / 缺口"。
> **前端实现不归总控**；这里只给事实与契约，避免前端照着做卡死。

---

## 1. 已有（前端可以直接接）

| 指导书里的 Mock | 真实入口 | 形态 |
|---|---|---|
| `roles` / 候选人列表 / 申请详情 | `GET /recruitment/api/recruiting/**`、`GET /recruitment/api/overview` | 直查 PG 的只读投影 |
| 面试官视图（分配、面评、轮次、上一轮摘要） | `GET /recruitment/api/interviewer/**` | 只读投影 |
| 任务与卡住状态 | `GET /recruitment/api/tasks/status` | 只读 |
| 计量（token/缓存/上下文） | `GET /recruitment/api/usage` | 只读（DSH 自带） |
| 原件预览（PDF/Word/图片字节） | `GET /recruitment/api/material/:id/content`（支持 Range） | 受控字节流；阅读器用 PDF.js 属前端 |
| 身份选择 | `PUT/GET /recruitment/api/actor` | 会话→身份 |
| 面评表单与提交 | `GET /recruitment/api/action/scorecard/form`、`POST .../submit` | 人点，服务端校验 |
| 决策（初筛/阶段/终审） | `GET /recruitment/api/decision/facts`、`POST /recruitment/api/decision/record` | 人点 + 原话 |
| 排期 / 改期 / 换人 | `POST /recruitment/api/action/interview/schedule`（含 `round_label`、`replace_interviewer`） | 人点 |
| 跳轮 / 豁免 | 同一排期/决策工具族的 `override {reason, confirmation_text}` | 必须带人工原话 |
| 发信（含 Offer 邮件） | `POST /recruitment/api/action/email/send`（模板 `OFFER`）+ 授权 | 人点 + 幂等 + 回执 |
| 邮箱/飞书连接状态 | 设置在补齐中（见 §2）；`overview` 的 connector 事故列表已有 | — |

## 2. 在建（本日两条 lane 正在做）

| 能力 | 状态 |
|---|---|
| 候选人级置顶约束 + 下一轮交接提醒 | 在建（`candidate_constraint` + 新工具 32→33） |
| 妙记时间戳片段读（`transcript_read` 加 `at_seconds/window_seconds`） | 在建 |
| 工作空间设置读写（连接状态 / 静默代办 / SLA 阈值） | 在建 |

## 3. 缺口（**照着指导书做会卡在这里**）

| # | 指导书要求 | 现状 | 影响 |
|---|---|---|---|
| G1 | `ingestDemoResume` 上传后立即返回 `task_id`（异步解析） | **没有 HTTP 上传端点**（简历接入目前是 Agent 工具） | 拖拽上传无法接 |
| G2 | `handleCommand` 走 **DSH Agent 对话（SSE/AG-UI 流式）** | 插件**不提供对话/流式端点**；对话在 DSH 宿主侧 | 需要决定前端如何与 DSH 会话对接 |
| G3 | `STATE_DELTA` 增量刷新画布 | **没有事件增量协议**；现有是 HTTP 只读 + 重新拉取 | 前端只能轮询，做不出"实时变" |
| G4 | 同名消歧 `disambig[]` 结构化投给前端胶囊 | Agent 回答里有列表，**没有结构化消歧端点** | 前端拿不到可渲染的胶囊数据 |
| G5 | 确认弹窗强制带 `version`（乐观锁） | **没有 If-Match**（见 `docs/34 §1.2`） | 并发覆盖无法被拒 |
| G6 | 5 秒撤销（补偿事件，不物理删） | **没有补偿/撤销接口** | Undo 无法落地 |
| G7 | 复合指令（一次确认多动作）、批量关闭、催面评 | **没有** | 弹窗里的这几类动作无法提交 |

## 4. 与仓库既有口径的两处冲突（必须点出来）

1. **指导书 §三 引用 "E1–E4 铁律"**：E1–E4 是旧口径的取证方式；现行验收是 `docs/24 §8` 的**六条门 V1–V6** + `docs/29` 的逐条判据。前端验收请按 `docs/29`，不要按 E1–E4 自定标准。
2. **"UI 零漂移" 与 `docs/17` D-135 的关系**：D-135 说 UI 设计未定、本轮不因布局判 FAIL；指导书说 v4 已定版、冻结。**两者不冲突**——v4 是设计稿，冻结它是对**前端实现**的要求；对**验收**仍按 D-135 不判视觉。但若 v4 定为最终 UI，需要在台账写一条"UI 定版"，D-135 的"待设计"状态才能关掉。

## 5. 结论

- 前端可以马上接的是 §1 那批（读投影 + 人点动作）。
- **G2/G3 已定（D-158）**：独立页面零改动不可行（实测），前端最终形态 = DSH 客户端视图；对话/流式/审批用底座现成的，不自研协议。
- G1（上传→task_id）、G4（消歧结构化）、G5（乐观锁）、G6（撤销）、G7（复合/批量）都是可补的后端活，按 `docs/33` 排。
