# INTERFACE-NEEDS-2.md · 前端任务书 03 剩余接口与字段缺口清单

> 对应任务书：`design/v4/frontend-task-03-real-backend.md` · 日期：2026-11-19
> 说明：按红线要求，不猜字段、不造接口。下表逐条列出本轮真连后端后**仍然缺失**的数据字段与写接口，标明影响的具体页面。

---

## 一、仍缺失的写操作接口（本轮统一走 `NOT_AVAILABLE` 人话提示「这项还差最后一步，稍后开放」）

| 我要什么 | 现在缺什么 | 影响哪一屏 |
| :--- | :--- | :--- |
| 批量不通过（勾选多位候选人一次关闭申请） | 仅有单条 `POST /recruitment/api/decision/record`，缺批量关闭接口 | 岗位页 · 候选人漏斗（底部悬浮批量操作条） |
| 飞书催办面试官交面评 | 缺 `POST /recruitment/api/action/interviewer/nudge` | 招聘总览 / 今日待办（超时面评催办确认卡） |
| 3 合 1 复合指令一次确认（通过初筛 + 置顶约束 + 约一面） | 缺复合事务编排接口（后续可由底座对话流依次编排） | 候选人页 · 复合确认卡 |
| 候选人星标主推持久化（`★`） | 缺星标读写接口及读投影 `starred` 字段 | 候选人页顶栏、岗位漏斗行、同池对比表头 |
| 面试官视角追问勾选与面后速记草稿落库 | 仅有最终 `scorecard/submit`，缺草稿自动保存接口（目前靠浏览器 `localStorage` 本地兜底） | 候选人页 · 面试官视角 |
| 5 秒撤销回滚 & Agent 已代办单条撤回 | 缺统一短期撤销接口与 `autoDone` 撤回接口 | 今日待办 · Agent 已代办 / 全局 Toast 撤销 |

---

## 二、已有读取接口仍缺的字段口径

| 我要什么 | 现在缺什么 | 影响哪一屏 |
| :--- | :--- | :--- |
| 岗位 HC 配额（已录用 / 总 HC） | `job-detail.json` 与 `recruiting-overview.json` 仅有 `application_counts.{total,active}`，缺关联需求单的 `headcount` / `filled_count`（且建岗接口明确拒绝 `headcount`） | 招聘总览（总 HC 进度）、岗位页（`X / Y HC`）、发 Offer 时的 HC 满额预警 |
| 候选人置顶约束读投影回显 | `POST /recruitment/api/action/candidate/constraint` 已就绪，但 `application-detail.json` 样例中尚未看到 `pinned[]` / `constraints[]` 返回字段名（目前前端兼容读 `application.pinned`） | 候选人页档案头置顶标签、人才库「竞品风险」筛选 |
| 逐条考核维度独立命中结论 | `application-detail.json` 中 `screening.evaluation.criteria_evaluated` 为 `null` | 候选人页「岗位标准对照」、岗位页「同池对比」 |
| `GET /recruitment/api/tasks/status` 响应字段样例 | `contracts/README.md` 注明该接口因需查询参数暂未采集 JSON 样例；本轮按任务书 T3-3 兼容读取 `status`、`application_id`、`candidate_name`、`error_summary`，请后端确认精确键名 | 顶部非阻塞简历解析进度条与失败人话原因展示 |
| 飞书日历空闲时段交集查询 | 缺 `GET /recruitment/api/action/interview/free-slots`，改期/加面确认卡目前暂用默认时段选项 | 改期/换面试官确认卡、专项加面确认卡 |
| 面试官视角总览数据 | `GET /recruitment/api/interviewer/overview` 在 `contracts/README.md` 标注待补样例 | 切换至「面试官」视角后的待面试清单 |

---

## 三、关于 §4 画布无 hash 入口的集成说明

* 已在 `dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx` 中新增纯 React 状态容器 **`CanvasPanelHost`**（零 `location.hash` 读写，点击行切 `route` 状态，点「← 返回」恢复列表）。
* 因本轮未改动 `src/client/index.tsx` 注册链路，也未直接覆盖主分支的 `RecruitingWorkspace.tsx`（避免在云端无 `tsc`/`tsdown` 环境下引入跨文件类型漂移），本地总控只需在 `RecruitingWorkspace.tsx` 列表行点击回调中切状态渲染 `<CanvasRoute route={{ kind: 'candidate', applicationId }} onBack={...} />`（或外层包裹 `<CanvasPanelHost>`），即可零 hash、零侧栏新增完成挂接。
