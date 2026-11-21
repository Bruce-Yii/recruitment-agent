# 前端任务书 01 · 把原型里的 Mock 抽成数据适配层（**不改 UI**）

> 收件人：前端实现窗口。发件人：总控。日期：2026-11-19。
> 依据：`design/v4/integration-guide.md`（UI 冻结、只拔 Mock）、`docs/35`（后端能力对账）。
> **这一轮只做一件事，不碰聊天、不碰视觉。**

---

## 0. 最高红线（违反即退回）

1. **严禁改视觉与交互**：配色、字体、三栏比例（204px ↔ 56px）、图标栏收起、拖拽调宽、行悬停动效、居中确认弹窗、按钮数量、文案措辞、快捷键——一个都不许动。
2. **只换数据层**：页面看起来要和现在**一模一样**。
3. **遇到"必须改 UI 才能接"的情况 → 停下来列阻塞点**，不要自己加按钮、不要自己改布局。
4. **前台 100% 业务语言**：不显示工具名、表名、字段名、状态码、哈希、协议词。

---

## 1. 这一轮做什么

把 `recruitment_os.html` 里写死的假数据，抽成一个**数据适配层**（`api` 对象）；页面只通过 `api` 取数与提交。

- 现在 `api` 内部仍然返回假数据（等价于今天的原型），**页面行为不变**；
- 将来接真后端时，**只改 `api` 这一个文件**；
- **不改任何渲染代码的结构**。

**为什么先做这个**：不管最终用哪种接入形态（由 DSH 提供页面，还是插件给一层标准事件流），这一层都是必须的；先做它，前端一天都不浪费。

---

## 2. 具体做法

1. 新建 `data/adapter.js`（或 `.ts`），导出 `createApi({ mode })`，`mode: 'mock' | 'http'`。
2. 把页面里散落的假数据与动作，收敛成这几个方法：
   - `getBootstrap()` —— 当前身份、角色、连接器状态
   - `getToday()` —— 今日待办（待初筛 / 我的面试 / 逾期面评 / 待审批 / 卡住的任务）
   - `getJob(jobId)` —— 岗位、HC、岗位标准版本、候选人列表
   - `getApplication(id)` —— 申请详情：材料、逐条对照、原文定位、面试、面评、决策、置顶约束
   - `getInterview(id)` —— 面试详情：分配、上一轮摘要、本轮参考
   - `submit(actionName, payload)` —— 确认卡提交（初筛/排期/换人/跳轮/发信/设置…）
   - `sendCommand(text)` —— 自然语言指令（**这一轮先返回 mock**，见 §4）
   - `uploadResume(file, jobId)` —— 上传（**这一轮先 mock**，见 §4）
3. **mock 实现** = 把现有假数据原样搬进 `data/mock.js`，行为与现在一致（可截图对照）。
4. **http 实现** = 只写 §3 里"真实存在"的接口；没有的接口抛出 `NOT_AVAILABLE`，页面显示一句人话（"这项暂时还没接通"），**不许崩**。

---

## 3. 后端现在真的有的接口（`http` 模式可直接接）

> 更细的字段口径见 `docs/35-v4-integration-backend-checklist.md`。字段拿不准时**提"字段需求"，不要猜**。

| 用途 | 接口 |
|---|---|
| 工作台待办/计数 | `GET /recruitment/api/overview` |
| 岗位与候选人列表、申请详情 | `GET /recruitment/api/recruiting/**` |
| 面试官视图（分配/面评/上一轮/本轮参考） | `GET /recruitment/api/interviewer/**` |
| 任务与卡住状态 | `GET /recruitment/api/tasks/status` |
| 计量（token/缓存/上下文） | `GET /recruitment/api/usage` |
| 原件（PDF/Word/图片，支持 Range） | `GET /recruitment/api/material/:id/content` |
| 身份选择 | `PUT/GET /recruitment/api/actor` |
| 面评表单与提交 | `GET /recruitment/api/action/scorecard/form`、`POST .../submit` |
| 决策 | `GET /recruitment/api/decision/facts`、`POST /recruitment/api/decision/record` |
| 排期 / 改期 / 换人（含自定义轮次名） | `POST /recruitment/api/action/interview/schedule` |
| 发信（含 Offer 邮件） | `POST /recruitment/api/action/email/send`（人点确认后） |
| 设置读写 | `GET /recruitment/api/settings`、`POST /recruitment/api/action/settings/write` |

---

## 4. 这一轮**明确不做**

| 不做 | 为什么 |
|---|---|
| 接聊天 / 流式 / 事件增量 | 等后端可行性验证结果；**聊天区这一轮继续用 mock** |
| 自己做 SSE / 断线重连 / 审批弹窗 | 将来直接用底座现成的，不重复造 |
| 新增任何按钮 / 开关 / 侧栏项 | 低频动作一律走自然对话 |
| 改 CSS / 动效 / 文案 | UI 冻结 |
| 上传简历的真实链路 | 后端还没有上传接口（`docs/35` G1），先用 mock 并标记 |

---

## 5. 交付物

1. `data/adapter.js` + `data/mock.js`（现有假数据搬进去）；
2. 页面里**所有**取数/提交都走 `api`（用搜索确认页面内不再有散落假数据）；
3. `INTERFACE-NEEDS.md`：**你接不上的**数据与动作，逐条写"我要哪个字段 / 哪个动作 / 现在缺什么"——这就是后端下一步的清单；
4. 截图对照：改前 / 改后各 3 张（首页、候选人页、确认卡），证明 **UI 零漂移**。

---

## 6. 验收（我们怎么看）

1. **mock 模式**：与改前**逐屏一致**（截图对比）；
2. **http 模式**：能打开；列表与详情有真实数据；没接通的接口显示一句人话提示、不崩溃；
3. **代码**：页面内搜不到硬编码假数据；
4. **UI**：三栏比例、图标栏收起、确认卡、动效与原型一致；
5. 交 `INTERFACE-NEEDS.md`（这一条最重要——它决定后端下一步补什么）。

---

## 7. 下一轮会是什么（先知道，不用现在做）

等后端验证完，会在这层 `api` 上只换一个实现：要么接"底座提供页面 + 自带连接"，要么接"标准事件流"。**你们的页面和 `api` 契约都不变。**
