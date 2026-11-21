# 前端通知 · 阶段二一次性接入（对话×画布统一交互）

> **给云端前端窗口**：阶段一（服务端派发）已完成并推送 `feat/unified-document-intake`（HEAD `f0f54ee`）。请按 `design/v4/chat-canvas-interaction-spec.md` §4「阶段二」**一次性接入**，不要做任务 11（已作废：禁止对单个 pill 硬编码切页/抢弹窗）。
> **一句话**：前端只消费服务端下发的 `event: ui_action`，把快捷 pill 当普通提示词（`sendText`），不要自己判断“点了切哪”。

## 1. 服务端已就绪的契约

### 1.1 SSE 新增事件（向后兼容 `delta/tool/done/error`）

```text
event: ui_action
data: {"action":"navigate","route":"talent","label":"打开人才库"}

event: ui_action
data: {"action":"focus_section","section":"criteria","label":"对比岗位评分标准"}

event: ui_action
data: {"action":"suggest_action","route":"application","target_id":"<application_id>","modal":"schedule","label":"去约面"}
```

字段封闭集：

- `action`: `navigate` | `focus_section` | `suggest_action`
- `route`: `queue` | `jobs` | `talent` | `application` | `job` | `interviewer`
- `filter`: `all` | `screening` | `interviewing`（仅 `navigate + queue`）
- `section`: `summary` | `criteria` | `resume` | `interviews` | `rubric` | `candidates`
- `modal`: `schedule` | `screening` | `decision` | `email` | `transfer`
- `target_id`: 仅 `route=application|job`；`label`: ≤24 字
- 非法动作服务端不会下发（工具 fail-closed）。

### 1.2 服务端工具（前端不需要调用）

`recruitment_ui_dispatch`（只读 UI 派发）与 `recruitment_interview_free_slots`（只读查时段）已在对话 Agent 的只读工具面（17 个，0 写工具）。点快捷 pill 与手打同一句话走同一条 `/recruitment/agent/turn` 链路。

## 2. 前端要做的（spec §4 阶段二）

| 文件 | 改动 |
|---|---|
| `dsh/dsh-recruitment/src/app/api.ts` | 新增 `AgentUiAction` 类型；`streamAgentTurn` 增加 `onUiAction` 回调，解析 `event: ui_action` |
| `dsh/dsh-recruitment/src/app/App.tsx` | 集中执行：`navigate` → `navigateToRoute`（queue 带初始筛选态）；`focus_section` → 向下传一次性聚焦指令；`suggest_action` → 在 ChatPanel 当前 AI 气泡底部渲染按钮（`data-testid="app-chat-suggest-<modal|route>"`），用户点后由 App 切路由/打开 CanvasRoute 对应弹窗；同时把候选人页 `jobId` 作为 `context.job_id` 传给 ChatPanel |
| `dsh/dsh-recruitment/src/app/ChatPanel.tsx` | 快捷 pill 统一 `sendText(prompt)`（**不得本地跳转/抢弹窗**）；补齐稳定 `data-testid="app-chat-quick-*"`；气泡支持 `suggestedActions` 胶囊按钮与轻提示（如“已定位到岗位标准对照”） |
| `src/client/canvas/CandidatePage.tsx` / `JobPage.tsx` | 仅补只读 `data-section="summary|criteria|resume|interviews|rubric|candidates"` 区块锚点、滚动+短时高亮响应、按需打开弹窗的受控回调；**零改动既有写链路与 15/15 testid** |

红线：

- 不改 `src/http/**`、服务端工具、`agent-turn.ts`；不新增依赖；
- 快捷 pill **不再**前端判断语义；点 pill 与手打完全同一条链路；
- `suggest_action` **绝不自动弹窗**，只在气泡里给按钮；
- `focus_section` 保持当前页面不切走；
- 不动 15/15 自动化依赖的既有 testid（`application-row`/`canvas-action-*`/`canvas-modal-submit` 等）。

## 3. 验收（前端自测 → 总控本地复验）

前端（有构建环境时）：
1. `cd dsh/dsh-recruitment && npx tsc --noEmit` → 0；`npx tsdown` 双入口通过；
2. 1440 手测（spec §5）：
   - 候选人页点「对比岗位评分标准」→ **留在候选人页**、滚动高亮「岗位标准对照」、对话给出分析（无 `#/job` 跳转）；
   - 点「帮我查下一轮可约时段」→ **不自动弹窗**；对话列出时段或如实说明日历不可用；气泡出现「打开面试排期」按钮，点后才开排期弹窗；
   - 手打“打开人才库”→ `#/talent`、右栏切人才库；
   - 手打“回到今日待办，只看待初筛”→ `#/queue` 且「待初筛」筛选选中；
3. 贴 `git diff --stat` + 逐文件 diff；跑不了 tsc 就如实写“云端无依赖，未跑”。

总控（收到 PR 后）：diff 复核（只允许 `src/app/**` + 必要 TESTID-MANIFEST/区块锚点）、本地 tsc/tsdown/静态门禁、重启预览 Host 后真机 4 场景 + 1440 证据归档 `evidence/chat-canvas-linkage-20261121/`、`run-v4.mjs --fresh` 15/15 回归。

## 4. 参考

- 规范全文：`design/v4/chat-canvas-interaction-spec.md`（§2 铁律、§3 契约、§4 分工、§5 验收）
- 阶段一服务端证据：`evidence/chat-canvas-phase1-20261121/`（README / `ui-dispatch-probe.json` / gates / 15 步回归）
- 作废说明：`design/v4/frontend-task-11-chat-quick-actions.md` 顶部
