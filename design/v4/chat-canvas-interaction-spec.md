# v4 对话 × 画布统一交互架构与派发规范（作废任务 11）

> **状态**：权威规范（替代并作废 `design/v4/frontend-task-11-chat-quick-actions.md`）
> **基线**：`feat/unified-document-intake`（`0230d37`）+ 对话桥 v1（`a7a9089`）+ 独立整页 v4（D-167）
> **目标**：从架构层面一次打通「左侧伴随式 Agent 对话（含快捷指令 + 自然语言）」与「右侧工作台画布」的双向联动，杜绝前端针对单个按钮硬编码缝缝补补。

---

## 一、现状诊断与作废任务 11 的原因

1. **真实根因**：
   - `design/v4/recruitment_os.html` 是无后端的静态原型，只能靠前端 `handleCommand` 用关键词 `if/else` 模拟“回复 + 切画布”。
   - 当前生产版已接通真实 DSH Agent（`dsh/dsh-recruitment/src/http/agent-turn.ts`），SSE 只下发 `delta / tool / done / error` 四类事件，且 `CHAT_READ_TOOLS` 中没有任何 UI 联动工具。因此无论点快捷 pill 还是自然语言输入，Agent 只能输出文字，右侧画布无从响应。
2. **为什么必须作废任务 11**：
   - **上下文撕裂**：候选人页点「对比岗位评分标准」直接跳去 `#/job/<jobId>`，会把当前正在看的候选人切丢，左侧 Agent 却还在围绕该候选人作答。
   - **交互打架**：点「帮我查下一轮可约时段」立刻弹出居中排期模态框，会遮挡左侧 Agent 的流式回复，且用户意图是“查时段”而非“立刻填表提交”。
   - **双轨返工**：前端硬编码 2 枚 pill 后，手打同一句话（或说“打开人才库 / 切到某岗位”）依然不动；后续服务端上线导航通道时，前端硬编码必然删除重写。

---

## 二、核心交互铁律（产品与工程统一真相源）

1. **单轨同源**：快捷 pill 的本质是**预设提示词**。点击 pill 与手动输入同一句话必须走完全相同的 `POST /recruitment/agent/turn` 链路，前端**禁止**对特定 pill 硬编码路由跳转或抢弹模态框。
2. **只读联动、写操作人点确认（不破 fail-closed 安全红线）**：
   - Agent 仅拥有**只读业务工具 + 只读 UI 调度工具**，绝不直接执行写库动作。
   - 对话驱动画布分为 3 种精确层级，严禁混用：
     - **`navigate`（路由切换）**：用于明确的空间或对象切换（如“打开人才库”“去看在招岗位”“打开后端工程师岗位页”“切到张三的档案”）。
     - **`focus_section`（页内聚焦高亮）**：用于当前档案/岗位内的对照阅读（如在候选人页点「对比岗位评分标准」「看简历原文」「看前面几轮面试」），**保持当前页面不切走**，平滑滚动到目标区块并给短时高亮反馈。
     - **`suggest_action`（对话内建议动作按钮）**：用于可能触发写操作或表单弹窗的场景（如查完可约时段后去约面、总结完风险点后去做初筛/决策）。**绝不自动弹出模态框遮挡对话**，而是在当前 AI 回复气泡底部渲染克制的动作按钮，由用户主动点击后唤起右侧画布对应弹窗或跳转。
3. **典型场景标准行为对照表**：

| 当前所在页 | 用户触发（点 pill 或自然语言） | Agent 与服务端动作 | 右侧画布与对话区表现 |
|---|---|---|---|
| 候选人页 | 对比岗位评分标准 | 查候选人 + 岗位标准，调 `recruitment_ui_dispatch(action="focus_section", section="criteria")` + 可选 `suggest_action`（查看完整岗位页） | **留在当前候选人画布**，平滑滚动并高亮「岗位标准对照」区；对话区给出对照分析，底部附带「前往岗位详情」建议按钮 |
| 候选人页 | 帮我查下一轮可约时段 | 调只读查时段工具拿真实可用时段，调 `recruitment_ui_dispatch(action="suggest_action", modal="schedule", label="打开面试排期")` | **不自动弹窗挡屏**；对话区列出可约时段，气泡底部出现「打开面试排期」按钮，用户点击后再打开排期弹窗 |
| 候选人页 | 总结这位候选人的核心风险点 | 查只读数据并回答（可按需 `focus_section: "summary"` 或不联动） | 留在当前画布，对话区输出风险总结 |
| 任意页 | 打开人才库 / 看看在招岗位 / 回到今日待办 | 调 `recruitment_ui_dispatch(action="navigate", route="talent" \| "jobs" \| "queue")` | 右侧画布立即切换至对应空间，hash 同步更新 |
| 任意页 | 看看待初筛 / 面试中的候选人 | 调 `recruitment_ui_dispatch(action="navigate", route="queue", filter="screening" \| "interviewing")` | 右侧画布切至今日待办并自动选中对应筛选 pill |
| 任意页 | 打开 `<某候选人>` 档案 / 打开 `<某岗位>` 详情 | 先查只读列表/详情拿到真实 ID，再调 `recruitment_ui_dispatch(action="navigate", route="application" \| "job", target_id="<id>")` | 右侧画布切至 `#/application/<id>` 或 `#/job/<id>` |

---

## 三、SSE 与工具协议契约（唯一接口规范）

### 3.1 新增只读工具：`recruitment_ui_dispatch`
注册到 DSH 工具集并加入 `dsh/dsh-recruitment/src/http/agent-turn.ts` 的 `CHAT_READ_TOOLS` 白名单。**零写库、纯 UI 意图校验与透传**。

```ts
export type UiActionType = 'navigate' | 'focus_section' | 'suggest_action';
export type UiRouteKind = 'queue' | 'jobs' | 'talent' | 'application' | 'job' | 'interviewer';
export type UiQueueFilter = 'all' | 'screening' | 'interviewing';
export type UiSectionKind =
  | 'summary'     // 当前状态与提炼
  | 'criteria'    // 岗位标准对照（候选人页）
  | 'resume'      // 简历原文摘录（候选人页）
  | 'interviews'  // 面试推进 / 逐轮记录（候选人页）
  | 'rubric'      // 评分标准（岗位页）
  | 'candidates'; // 候选人池（岗位页）
export type UiModalKind = 'schedule' | 'screening' | 'decision' | 'email' | 'transfer';

export interface UiActionPayload {
  readonly action: UiActionType;
  readonly route?: UiRouteKind;
  readonly target_id?: string;      // route 为 application | job 时必填
  readonly filter?: UiQueueFilter;  // route 为 queue 时可选
  readonly section?: UiSectionKind; // action 为 focus_section 时必填
  readonly modal?: UiModalKind;     // action 为 suggest_action 且唤起弹窗时使用
  readonly label?: string;          // 给用户看的简短中文说明/按钮文案（≤24字）
}
```

**服务端强校验（fail-closed）**：
- `action`、`route`、`filter`、`section`、`modal` 必须在上述白名单枚举内；
- `action === 'navigate'` 且 `route` 为 `application` 或 `job` 时，`target_id` 必须为非空字符串（禁止相对路径或 `..` / `#` 注入）；
- `action === 'focus_section'` 时，`section` 必填；
- `action === 'suggest_action'` 时，`modal` 或 `route` 至少填其一，且 `label` 必填；
- 校验失败返回工具错误，**绝不下发 SSE `ui_action`**。

### 3.2 新增 SSE 事件：`event: ui_action`
与现有 `delta / tool / done / error` 完全向后兼容。在 `dsh/dsh-recruitment/src/http/agent-turn.ts` 监听到 `recruitment_ui_dispatch` 的 `tool/result` 成功时，额外推送一条 SSE：

```text
event: ui_action
data: {"action":"focus_section","section":"criteria","label":"已定位到岗位标准对照"}
```

```text
event: ui_action
data: {"action":"suggest_action","modal":"schedule","label":"打开面试排期"}
```

```text
event: ui_action
data: {"action":"navigate","route":"talent","label":"已切换到人才库"}
```

### 3.3 请求上下文补齐（`POST /recruitment/agent/turn`）
前端请求体 `context` 保持向后兼容，新增约定：**在候选人页时，如果已知该申请所属 `job_id`，一并随 `context.job_id` 传入**；服务端在 `agent-turn.ts` 中已将 `context.route`、`context.application_id`、`context.job_id` 拼入上下文前缀，无需破坏性改动。

---

## 四、明确分工与派发清单

### 阶段一：服务端派发任务（由本地 Agent 立即执行）

**目标**：打通真实只读 UI 联动工具 + SSE `ui_action` 事件 + 只读查时段能力。

1. **新增只读工具 `recruitment_ui_dispatch`**：
   - 在 `dsh/dsh-recruitment/src/tools/` 下新增工具定义（如 `ui-dispatch.ts`）并在插件入口注册；
   - 实现第 3.1 节的严格枚举与参数校验，工具返回结构化 JSON（含 `ui_action: UiActionPayload`），并在工具 `description` 中写明第 2 节的触发原则（导航用 `navigate`、页内对照用 `focus_section`、需人确认的弹窗/跳转用 `suggest_action`）。
2. **接入 `dsh/dsh-recruitment/src/http/agent-turn.ts`**：
   - 将 `recruitment_ui_dispatch` 加入 `CHAT_READ_TOOLS` 白名单；
   - 检查现有只读查时段能力：若已有只读查时段工具则加入 `CHAT_READ_TOOLS`，若目前仅有 HTTP `/action/interview/free-slots` 则同步暴露对应的只读工具（如 `recruitment_interview_free_slots`）并加入 `CHAT_READ_TOOLS`，确保“查下一轮可约时段”能返回真实可用时段；
   - 在 `onSessionEvent` 处理 `tool/result` 时，若 `name === 'recruitment_ui_dispatch'` 且 `!failed`，从结果中提取校验后的 `UiActionPayload` 并调用 `send('ui_action', payload)`。
   - **安全门禁保持不变**：`CHAT_READ_TOOLS` 依然 0 写工具，业务域表零写入。
3. **作废任务 11**：
   - 在 `design/v4/frontend-task-11-chat-quick-actions.md` 顶部标注已作废并指向本文档（或在合入本规范 PR 时同步更新）。
4. **服务端自验**：
   - `tsc --noEmit` 0 错、`server-typecheck` / `client-contract-check` / `entry-reachability` 全 PASS；
   - HTTP SSE 实测（真模型）：
     1. 发“打开人才库” → SSE 收到 `event: ui_action`（`action: "navigate", route: "talent"`）；
     2. 带候选人上下文发“对比岗位评分标准” → SSE 收到 `event: ui_action`（`action: "focus_section", section: "criteria"`）；
     3. 带候选人上下文发“帮我查下一轮可约时段” → SSE 收到真实时段回答 + `event: ui_action`（`action: "suggest_action", modal: "schedule"`）；
     4. 诊断头 `x-recruitment-agent-diag: 1` 确认可见工具清单仍为 **0 写工具**。

### 阶段二：前端派发任务（由云端前端窗口紧接执行）

**目标**：消费 `event: ui_action`，补齐画布区块锚点与气泡内建议动作按钮，不写死任何快捷 pill 跳转。

1. **`src/app/api.ts`**：新增 `AgentUiAction` 类型，`streamAgentTurn` 增加 `onUiAction` 回调，解析 SSE `event: ui_action`。
2. **`src/app/App.tsx`**：集中执行 `onUiAction`：
   - `navigate` → 调 `navigateToRoute`（含 `queue` 初始筛选态传递）；
   - `focus_section` → 向下传递一次性聚焦指令，定位并高亮对应 `[data-section="<section>"]` 区块；
   - `suggest_action` → 在 `ChatPanel` 当前 AI 气泡底部渲染动作按钮（`data-testid="app-chat-suggest-<modal|route>"`），用户点击后由 `App` 切路由或打开 `CanvasRoute` 对应弹窗；
   - 同步把当前候选人页的 `jobId` 传给 `ChatPanel` 作为 `context.job_id`。
3. **`src/app/ChatPanel.tsx`**：
   - 快捷 pill 统一走 `sendText(prompt)`，补齐稳定 `data-testid`（`app-chat-quick-*`）；
   - 气泡内支持渲染 `suggestedActions` 胶囊按钮与轻提示标签（如「已定位到岗位标准对照」）。
4. **`src/client/canvas/CandidatePage.tsx` & `JobPage.tsx`**：
   - 仅给对应区块补充只读 `data-section` 属性（`summary / criteria / resume / interviews / rubric / candidates`）和滚动高亮响应，以及按需打开弹窗的受控回调；**零改动既有写链路与 15/15 自动化 testid**。

---

## 五、端到端验收门禁（合并最终标准）

1. `npx tsc --noEmit` 0 错，`npx tsdown` 双入口构建成功，所有既有静态门禁全 PASS；
2. `run-v4.mjs --fresh` 15/15 全绿（无回归）；
3. **1440 浏览器端到端真测**（证据存 `evidence/chat-canvas-linkage-<date>/`）：
   - 点快捷 pill「对比岗位评分标准」→ 留在候选人页、页面滚动高亮到「岗位标准对照」、对话给出对照分析；
   - 点快捷 pill「帮我查下一轮可约时段」→ 不自动糊脸弹窗、对话列出时段并出现「打开面试排期」按钮、点击按钮后排期弹窗正常打开；
   - 手动输入“打开人才库” → hash 变为 `#/talent`、右侧切换为人才库画布；
   - 手动输入“回到今日待办，只看待初筛” → hash 变为 `#/queue`、自动选中「待初筛」筛选。
