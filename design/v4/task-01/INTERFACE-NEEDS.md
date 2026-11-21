# INTERFACE-NEEDS.md · 前端数据适配层待后端补齐清单

> 对应任务书：`frontend-task-01-mock-adapter.md` · 日期：2026-11-19
> 说明：本文档逐条列出当前定版前端（UI 冻结状态）在切换到 `mode: 'http'` 真实后端模式时，**尚未存在接口**或**需明确返回字段口径**的数据与动作清单，供后端按优先级排期补齐。所有前台展示层保持 100% 自然业务语言，以下字段名仅用于前后端接口联调对齐。

---

## 一、缺失的写操作接口（当前 `http` 模式抛出 `NOT_AVAILABLE`，页面提示「这项暂时还没接通」）

| 优先级 | 前端 `api.submit` 动作名 | 业务场景 | 现状与缺口 | 前端期望的入参与返回 |
| :--- | :--- | :--- | :--- | :--- |
| **P0** | `uploadResume(file, jobId)` | 拖入 / 点击 `＋` 导入 PDF/Word 简历并后台异步解析建档 | 后端尚无上传接口（对应 `docs/35` **G1**），本轮继续走 mock | `POST /recruitment/api/intake/upload`（`multipart/form-data`：`file`, `job_id`），返回 `{ task_id, status: 'running' }`，解析完成后通过任务状态或刷新返回新申请 ID |
| **P0** | `transfer` | 跨岗调剂 / 人才库跨岗捞人（保留原记录，新建目标岗位申请并继承历史面评） | §3 尚无跨岗调剂接口 | `POST /recruitment/api/action/application/transfer`：`{ application_id, target_job_id }`，返回新创建的 `application` |
| **P0** | `new_job` | 左侧栏「＋ 新建岗位」或对话指令创建岗位并锁定默认标准 V1 | §3 尚无创建岗位接口 | `POST /recruitment/api/action/job/create`：`{ title, headcount, dept?, rubric? }`，返回新建的 `job` |
| **P1** | `batch_reject` | 岗位漏斗勾选多位候选人后「批量不通过」 | §3 仅有单条 `/decision/record`，缺批量关闭接口 | `POST /recruitment/api/action/decision/batch-reject`：`{ application_ids: string[], reason: string }` |
| **P1** | `compound` | 自然语言 3 合 1 复合指令（通过初筛 + 置顶竞品加急 + 约一面飞书日程）一次确认 | 缺组合编排接口（或由后端聊天/动作路由原子依次执行） | `POST /recruitment/api/action/compound` 或拆解为 `decision/record` + `pin_constraint` + `interview/schedule` 原子事务 |
| **P1** | `nudge` | 今日待办「催办面试官交面评」（发飞书提醒并记入 Agent 已代办） | §3 尚无飞书催办接口 | `POST /recruitment/api/action/interviewer/nudge`：`{ interview_id, interviewer_id, message }` |
| **P1** | `pin_constraint` | 一句话捕捉微信/电话碎片约束（如竞品 Offer 截止、期望薪资）置顶至候选人档案头部 | §3 尚无置顶约束写入接口 | `POST /recruitment/api/action/application/pin`：`{ application_id, text, kind: 'red' \| 'neutral' }` |
| **P1** | `add_handoff_iq` | 一句话给下一轮面试官留专属追问（置顶写入面试官视角简报） | §3 尚无面试交接追问写入接口 | `POST /recruitment/api/action/interview/handoff-question`：`{ application_id, question }` |
| **P2** | `star` | 单人页右上角 `★` 主推标记切换 | §3 尚无主推星标持久化接口 | `PATCH /recruitment/api/recruiting/applications/:id/star`：`{ starred: boolean }` |
| **P2** | `save_notes` / `toggle_iq` | 面试官视角勾选追问清单 & 实时同步面后速记（除本地 `localStorage` 兜底外需落库） | §3 仅有最终 `scorecard/submit`，缺草稿自动保存接口 | `PATCH /recruitment/api/interviewer/interviews/:id/draft`：`{ notes, iqs }` |
| **P2** | `undo_auto_done` | 今日待办「Agent 已代办」列表单条撤回 | §3 尚无代办撤回接口 | `POST /recruitment/api/action/autodone/undo`：`{ id }` |
| **P2** | `restore_snapshot` | 确认操作后 5 秒 Toast「撤销」按钮回滚上一步状态 | §3 尚无统一短期撤销回滚接口 | `POST /recruitment/api/action/undo`：`{ action_id }` |

---

## 二、已有读取接口需明确的字段口径（避免前端猜测字段名）

目前 `data/adapter.js` 在 `http` 模式下已对接 §3 的真实读取接口，并做了兼容兜底。请后端确认或补充以下具体字段：

### 1. `GET /recruitment/api/overview` & `GET /recruitment/api/tasks/status`
* **需要字段**：
  * `pendingCandidates[]`（或 `applications[]`）：至少包含 `id`, `name`, `roleId`, `stage`, `hours`（在当前阶段停留小时数，用于 24h 超时标红）, `offerStatus`；
  * `autoDone[]`：`{ id, t, text, undone }`（Agent 静默代办流水）；
  * `nudgePending` + `nudgeItem`：`{ interviewer, roleLabel, overdueLabel, draftText }`（超时未交面评的催办项）；
  * `stuckTasks[]`（来自 `/tasks/status`）：卡住或后台异步运行中的任务列表，用于顶部非阻塞轻提示条。

### 2. `GET /recruitment/api/recruiting/jobs` 与 `GET /recruitment/api/recruiting/jobs/:jobId`
* **需要字段**：
  * `id`, `name`, `dept`, `hcTotal`, `hcFilled`, `rubricVersion`（例如 `'V1'`）；
  * `rubric[]`：岗位考核维度文案列表；
  * `jd`：`{ meta, duties, reqs, bonus }`（完整原始 JD，收纳在「岗位标准 V1」下方）；
  * `applications[]`：该岗位下全部候选人摘要列表（含 `edu`, `exp`, `starred`, `stage`, `hours`, `criteria[]`, `summary`，用于「候选人漏斗」与「同池对比」）。

### 3. `GET /recruitment/api/recruiting/applications/:id`
* **需要字段**：
  * 基础档案：`id`, `name`, `roleId`, `stage`, `hours`, `starred`, `offerStatus`（`'SENT' | 'ACCEPTED' | 'DECLINED'`）, `edu`, `exp`, `source`, `summary`；
  * `pinned[]`：`{ t, kind: 'red' | 'neutral' }`（竞品 Offer / 薪资期望 / 改期提醒置顶标签）；
  * `criteria[]`：`{ k, t, s, lv: 'green' | 'amber' | 'red' }`（岗位标准逐条对照，其中 `k` 用于点击联动高亮简历原文）；
  * `resumeSections[]`：`{ title, items: [{ k, co?, time?, t }] }`（分段简历全文，每段带 `k` 与考核维度联动）；
  * `materialId`：用于拼接原件二进制流预览地址 `GET /recruitment/api/material/:id/content`（支持 Range）；
  * `transcript[]`：`{ k, ts?, t, ctx? }`（飞书妙记摘要 + 可点击展开的多轮原始对话上下文）；
  * `rounds[]`：`{ t, s, d }`（逐轮进展轨道数据，严禁聚合平均分）；
  * `timeline[]`：`{ t, d }`（全链路动态留痕）。

### 4. `GET /recruitment/api/interviewer/interviews/:id` & `GET /recruitment/api/action/scorecard/form`
* **需要字段**：
  * `iqs[]`：`{ t, done, fromHandoff? }`（建议追问与前序交接置顶追问）；
  * `notes`：已保存的面后速记草稿；
  * `prevSummary`：前序轮次简报摘要；
  * 排期/改期/加面空闲时段交集：`slots[]`（目前 §3 尚无独立的「飞书日历空闲交集查询」GET 接口，建议补充 `GET /recruitment/api/action/interview/free-slots?application_id=...&interviewer=...`，否则确认卡内只能使用默认占位时段）。

### 5. `GET /recruitment/api/settings` & `POST /recruitment/api/action/settings/write`
* **需要字段**：
  * `connectors[]`：`{ id: 'mail' | 'cal' | 'min', name, desc, connected: boolean }`；
  * `autoRules[]`：`{ id, name, desc, silent: boolean, locked?: boolean }`；
  * `slaConfig`：`{ screenH, scorecardH, offerH }`。

---

## 三、本轮明确暂缓接入项（按任务书 §4 留待下一轮）

1. **自然语言对话与流式 / `STATE_DELTA` 增量刷新**：`api.sendCommand()` 本轮继续走 mock，等待后端确定最终接入形态（DSH 内置页或标准事件流）后只替换 `adapter.js` 实现。
2. **上传简历真实链路（G1）**：`api.uploadResume()` 本轮继续走 mock，待后端提供上传与异步解析状态接口后切换。
3. **无 UI 改动阻塞项**：本轮抽离适配层未遇到任何需要修改 UI/CSS/文案的阻塞点，前端保持 100% UI 冻结。
