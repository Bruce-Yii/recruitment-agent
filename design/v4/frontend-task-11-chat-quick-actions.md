> **⛔ 已作废（2026-11-21，产品负责人裁决）**：本任务不采用——“前端对单个 pill 硬编码切页/抢弹窗”会造成上下文撕裂、弹窗遮挡对话、双轨返工。
> **权威替代**：`design/v4/chat-canvas-interaction-spec.md`（统一交互架构：服务端 `recruitment_ui_dispatch` + SSE `ui_action`，前端统一消费，禁止对单个按钮硬编码）。本文件仅作历史留档。

# 前端任务 11 · 对话快捷图标恢复“点了会切右侧画布”（对齐定稿原型）

> **谁提出**：产品负责人 2026-11-21。原话：**“之前前端窗口给我的 HTML 里面左边对话框的快捷图标，我点了的话，右边画布是可以切换的。”**
> **结论（已取证）**：这是**真实的行为差异**，不是产品负责人的错觉。定稿原型里快捷 pill 是**本地命令**（`handleCommand` → 直接改 `space/jobTab` 等状态，右栏画布立刻切换）；当前 v4 把这排 pill 做成了**问 Agent**（`onClick={() => sendText(prompt)}`），点击只往对话里发一条消息，右栏画布不动。
> 本任务只改前端；不改后端、不改 Agent 契约。

## 1. 取证（可复跑）

- 现状代码：`dsh/dsh-recruitment/src/app/ChatPanel.tsx:26`（`quickPromptsForRoute`）、`:272`（`onClick={() => void sendText(prompt)}`）。
- 真机取证（预览 Host 49351，1440）：打开候选人页 `#/application/…0701`，点“对比岗位评分标准”→ `hash` **不变**、仍在候选人画布；对话里出现该问题 + “正在思考并读取最新数据…”。证据：
  - `evidence/frontend-quick-actions-20261121/probe-result.json`
  - `evidence/frontend-quick-actions-20261121/before-click-1440.png`
  - 复跑脚本：`work/d5/fullpage/probe-quick-actions-49351.mjs`（work/ 不入库）
- 定稿原型行为：`design/v4/recruitment_os.html:854-855`（pill 绑定 `handleCommand`）；`executeParsedCommand`（`:1759` 起）里例如“对比”分支 `space='jobs'; … jobTab='compare'`（`:1788-1790`）——点击后右栏**直接切到岗位对比画布**，不经过模型。

## 2. 要恢复的行为（最小、明确）

原则：**快捷图标 = 动作入口**（先立即切画布/开弹窗），**保留 Agent 问答**（同一句仍发给 Agent，在对话里给解释/依据）。不是二选一。

| 当前页 | 快捷 pill | 点击后立即发生（本地，≤300ms） | 之后 |
|---|---|---|---|
| 候选人页 | **对比岗位评分标准** | 右栏切到该岗位画布：`history.pushState` → `#/job/<当前 jobId>`，并落在**评分标准/rubric**区域（该区可见“评分标准/岗位标准”文案） | 仍把这句话发给 Agent（对话里给对比说明） |
| 候选人页 | **帮我查下一轮可约时段** | 右栏保持候选人画布，**打开“面试排期与改期换人”弹窗**（等同于点 `canvas-action-schedule`；日历查询，不自作主张提交） | 仍把这句话发给 Agent |
| 候选人页 | 总结这位候选人的核心风险点 | 不切画布 | 发给 Agent（现状不变） |
| 队列页 | 今天最优先处理的 3 位候选人是谁？ | 不切画布（当前就是队列） | 发给 Agent（现状不变） |
| 队列页 | 查看当前待提交面评的进展 | 不切画布；如产品要，只允许切到「面试中」筛选（可选，不在本任务强制） | 发给 Agent（现状不变） |
| 岗位页 | 汇总当前岗位各阶段推进瓶颈 / 哪些候选人最值得优先推进？ | 不切画布 | 发给 Agent（现状不变） |

补充要求：

1. **同一句仍发给 Agent**：本地动作完成后调用现有 `sendText(prompt)`；不要吞掉对话。
2. **数据来源**：候选人页需要当前 `jobId`（`CandidatePage` 的 VM 已有）；由 `App`/`CanvasRoute` 把“当前简历对应的 jobId / 打开排期弹窗”的回调传给 `ChatPanel`，或用一个最小的应用内事件通道。**不要**从 URL 猜、不要写死 jobId。
3. **testid（验收契约）**：给 pill 加稳定 testid（前端可调整命名，但交付时给清单）：
   - `app-chat-quick-compare-rubric`（对比岗位评分标准）
   - `app-chat-quick-free-slots`（帮我查下一轮可约时段）
   - 其余 pill 建议 `app-chat-quick-<slug>`，便于后续自动化。
4. **不改**：后端/桥（`src/http/**`）、`src/client/canvas/**` 的写链路、`lib/**`、`tsconfig*`、`package.json`；不新增依赖；不动视觉样式（只加行为与 testid）。
5. 若产品确认“查询可约时段”不需要开弹窗、只用 Agent 回答，可去掉该条动作——**默认按上表实现**。

## 3. 验收（前端自测 + 总控本地复验）

前端（有构建环境时）：
- `cd dsh/dsh-recruitment && npx tsc --noEmit` → 0；`npx tsdown` → 通过；
- 1440 目检：候选人页点“对比岗位评分标准”→ hash 变 `#/job/<jobId>`，右栏出现评分标准；点“帮我查下一轮可约时段”→ 排期弹窗可见（`schedule-time-input` 或“日历暂时读不到”人话）；
- 点其余 pill：hash 不变、对话仍出现该问题与回答；无 console 报错。

总控（收到 PR 后）：
- 读 diff（只允许 `src/app/**` + 必要的 TESTID-MANIFEST 更新）；
- 本地 `tsc` 0 / `tsdown` / 静态机检；
- 真机复跑：点击两枚动作 pill 的 hash/画布/弹窗断言 + 截图；
- `run-v4.mjs --fresh` 15/15 回归（行为改动涉及界面入口，按 D-161 合并门）。

## 4. 不在本任务

- **聊天里说“切换画布/打开人才库”也能切**：需要服务端加“界面导航”通道（SSE `navigate` + 只读 UI 动作工具），前端消费——单独任务，不与本任务混。
- 原型里“周报/设置/对比”等**当前 v4 没有的画布**（report/settings/compare 视图）不在本任务凭空补。
