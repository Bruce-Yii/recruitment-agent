# v4 对话内写确认卡交互与契约规范（Chat Inline Confirm Card）

> **状态**：权威规范（扩展 `design/v4/chat-canvas-interaction-spec.md`，不破坏既有 `navigate / focus_section / suggest_action`）
> **基线**：`main`（`313a6d8`，含 D-174/D-176/D-179/D-181/D-182/D-183 与 `design-system-guidelines.md`）
> **目标**：让 HR 在左侧伴随式对话中看完核查材料或可约时段后，能够**就地人点确认**高频单步业务动作，无需反复切去右侧画布找按钮开弹窗；同时严守 **Agent 零写库**、**不改服务端写链路** 与 **暖纸编辑感审美红线**。

---

## 一、产品边界与三项铁律

1. **Agent 依然 0 写库（Fail-Closed 红线不动）**
   - `CHAT_READ_TOOLS` 保持严格只读白名单；Agent 只能通过 `recruitment_ui_dispatch(action="propose_write", ...)` **提出一份待确认的动作草稿**，绝不直接落库。
   - 真正落库必须由**真人点击卡片主按钮**触发，走既有前端写合同（`src/client/canvas/canvas-actions.ts` → `recruiting/actions.ts` 的 `build*` + `postActionSeam` / `postDecisionRecordFacade` / `postCandidateConstraint`）。
2. **只收高频单步动作，不把后台表单塞进 324px 对话栏**
   - 对话栏默认宽度仅 `324px`，严禁在气泡内塞入多栏表单、下拉选择器或长文本编辑器。
   - **首批纳入对话内确认卡的 5 类高频动作**（且前提是对象与关键参数已在对话上下文中明确）：
     | `intent` | 业务场景 | 复用既有写合同（零新建写端点） | 参数不足时的降级 |
     |---|---|---|---|
     | `screening_decide` | 初筛通过 / 不通过 | `buildScreeningDecisionBody` + `postActionSeam` | 缺结论或申请 ID → `suggest_action(modal="screening")` |
     | `stage_advance` | 推进到下一阶段 | `buildStageAdvanceBody` + `postActionSeam` | 缺目标阶段或申请 ID → `suggest_action(route="application")` |
     | `candidate_constraint` | 添加置顶约束 / 下一轮交接提醒 | `postCandidateConstraint` | 缺提醒正文 → `suggest_action(route="application")` |
     | `interview_schedule` | 按已查出的具体时段约面 | `buildInterviewScheduleBody` + `postActionSeam` | 缺面试官/具体起止时间 → `suggest_action(modal="schedule")` |
     | `decision_record` | 最终录用 / 淘汰决策 | `fetchDecisionFacts` 前置校验 + `buildDecisionRecordBody` + `postDecisionRecordFacade` | 存在缺面评等阻断项 → 卡片内诚实展示阻断原因并禁用确认按钮，提供「前往决策弹窗」 |
   - **明确不上对话内确认卡的能力**：新建岗位、发邮件、跨岗转投、人工导入转写、批量不通过（继续使用 `suggest_action` 唤起右侧居中弹窗）。
3. **不改服务端写链路，`client-contract-check` 与 `term-lint` 保持 0 违规**
   - 禁止在 `src/app/**` 或 `src/client/canvas/**` 手拼 `fetch(POST)` 写请求；
   - 卡片内禁止暴露 UUID、机器码、接口路径、英文枚举原值或「材料不全/缺件」类工程话术。

---

## 二、视觉与暖纸审美红线（对照 `design-system-guidelines.md`）

对话栏底色为中间暖纸层 `--paper (#F9F8F5)`，确认卡作为嵌入 AI 回复气泡底部的**克制白纸凭据块**：

- **材质与边界**：底色 `--surface (#FFFFFF)`，边框 `1px solid var(--line)`，圆角 `12px`，内边距 `12px 14px`；**禁止使用 `--shadow-card` 或重投影**（投影仅保留给悬浮对话输入框与居中确认弹窗），**禁止卡片内再套圆角子卡片**。
- **层级与排版**：
  - 顶行：意图标题（`13px / 600 / var(--ink)`，如「确认初筛通过」「确认安排面试」）+ 右侧极轻无底状态字（`11.5px / var(--muted)`，如「待确认」「已执行」「无法提交」，**禁用厚重灰底/彩底胶囊**）。
  - 事实摘要区：2–4 行键值对，行间用 `1px solid var(--line-soft)` 分隔，左键 `12px / var(--muted)`，右值 `12.5px / var(--text)`；时间/轮次/计数统一加 `.num`（`tabular-nums`）。
  - 理由/备注预览：单行或最多两行轻摘录（`12.5px / var(--text)`），默认只读；用户如需修改理由或字段，点击「在弹窗微调」直接打开右侧对应弹窗并预填当前字段，不在 324px 栏内展开大表单。
  - 底部动作区：`1px solid var(--line-soft)` 顶分隔线 + 最多 3 个控件：
    1. **主确认按钮**：常规推进用 `background: var(--ink); color: var(--surface)`（高度 `30px`、`border-radius: 8px`、`font-size: 12px / 500`）；淘汰/不通过等不可逆负向动作使用 `color: var(--red); border: 1px solid rgba(205, 43, 49, .32); background: var(--surface)`，hover 轻透 `var(--red-soft)`。
    2. **取消/收起**：纯文字轻按钮（`var(--muted)`），点击后卡片折叠为单行「已取消本次建议」。
    3. **在弹窗微调**（可选）：纯文字轻链接（`var(--muted)`，hover `var(--ink)`），触发既有 `suggest_action` 弹窗路径。
- **执行后状态（不可重复提交）**：
  - 提交中：主按钮禁用并显示「提交中…」，防止双击并发；
  - 成功后：按钮区替换为单行绿字回执（`var(--green)` 极细勾 + 人话回执 + `.num` 时间戳），同时触发右侧画布静默刷新（复现 `.ros-paper-flash` 暖纸微光，不整页闪白）；
  - 失败后：保留卡片，以 `var(--red)` 展示 `describeActionError` 转换后的人话原因（如「已做过初筛决定」「缺少必交面评」），绝不伪造成功。

---

## 三、SSE 与工具协议契约（向后兼容扩展）

### 3.1 扩展 `recruitment_ui_dispatch`（`src/tools/ui-dispatch.ts`）

在既有 `UiActionType` 中新增第 4 类枚举 `'propose_write'`（零写库、纯参数校验与透传）：

```ts
export type UiActionType =
  | 'navigate'
  | 'focus_section'
  | 'suggest_action'
  | 'propose_write';

export type UiWriteIntent =
  | 'screening_decide'
  | 'stage_advance'
  | 'candidate_constraint'
  | 'interview_schedule'
  | 'decision_record';

export interface UiWriteSummaryItem {
  readonly label: string; // ≤12字中文键名，如「候选人」「结论」「面试时间」
  readonly value: string; // ≤48字人话值，严禁 UUID 或机器码
}

export interface UiWriteProposal {
  readonly intent: UiWriteIntent;
  readonly application_id: string;        // 必填 UUID
  readonly title: string;                 // ≤24字中文标题，如「确认初筛通过」
  readonly tone?: 'default' | 'danger';   // 淘汰/不通过用 danger
  readonly summary: readonly UiWriteSummaryItem[]; // 2..4 条
  readonly fallback_modal?: UiModalKind;  // 「在弹窗微调」对应弹窗
  readonly payload: {
    // screening_decide
    readonly decision?: 'PASS' | 'REJECT';
    readonly rationale?: string;
    // stage_advance
    readonly target_stage?: string;
    // candidate_constraint
    readonly constraint_kind?: 'PIN' | 'HANDOFF';
    readonly constraint_text?: string;
    // interview_schedule
    readonly round_number?: number;
    readonly interviewer_id?: string;
    readonly scheduled_start?: string; // 带偏移 ISO-8601
    readonly scheduled_end?: string;   // 带偏移 ISO-8601
    readonly timezone?: string;        // IANA 时区
    // decision_record
    readonly final_outcome?: 'HIRE' | 'REJECT' | 'HOLD';
  };
}
```

`UiActionPayload` 新增可选字段 `readonly proposal?: UiWriteProposal`。

**服务端强校验（fail-closed）**：
- `action === 'propose_write'` 时，`proposal` 必填且 `intent` 必须在上述 5 枚举内；
- `application_id` 必须匹配标准 UUID 格式；`summary` 长度 `2..4`；`title` 非空且 `≤24` 字；
- 按 `intent` 校验必填业务字段：
  - `screening_decide`：`decision` 必填（`PASS | REJECT`）；
  - `stage_advance`：`target_stage` 非空；
  - `candidate_constraint`：`constraint_kind`（`PIN | HANDOFF`）与 `constraint_text` 非空；
  - `interview_schedule`：`interviewer_id`（UUID）、`scheduled_start`、`scheduled_end` 均必填；
  - `decision_record`：`final_outcome` 必填（`HIRE | REJECT | HOLD`）；
- 校验失败直接返回工具错误，**绝不下发 SSE `ui_action`**。

### 3.2 SSE 载荷示例

```text
event: ui_action
data: {"action":"propose_write","label":"待确认：初筛通过","proposal":{"intent":"screening_decide","application_id":"<uuid>","title":"确认初筛通过","tone":"default","summary":[{"label":"候选人","value":"张三"},{"label":"岗位","value":"后端工程师"},{"label":"结论","value":"初筛通过并进入面试"}],"fallback_modal":"screening","payload":{"decision":"PASS","rationale":"工作与教育经历均符合岗位核心标准"}}}
```

---

## 四、跨窗口分阶段派发清单

### 阶段一：服务端（本地 Agent 执行）
1. 扩展 `dsh/dsh-recruitment/src/tools/ui-dispatch.ts`：新增 `propose_write` 与 `UiWriteProposal` 严格 fail-closed 校验；更新工具 description，明确“参数齐备出 `propose_write`，缺字段降级 `suggest_action`，严禁伪造 ID/时间”。
2. 核对 `dsh/dsh-recruitment/src/http/agent-turn.ts`：确认 `normalizeUiAction` 透传 `propose_write` 到 `event: ui_action`，且 `CHAT_READ_TOOLS` 仍为 **0 写工具**。
3. 补齐单测（覆盖 5 类 intent 合法用例 + 缺参/非法 UUID/越界 summary 的 fail-closed 用例）并跑通真模型 SSE 验证。

### 阶段二：前端（前端窗口执行）
1. `src/app/api.ts`：同步扩展 `AgentUiAction` 与 `UiWriteProposal` 类型。
2. `src/app/ChatPanel.tsx` & `src/app/InlineConfirmCard.tsx`（新组件）：
   - 在 AI 气泡底部渲染暖纸确认卡（稳定 testid：`app-chat-confirm-card`、`app-chat-confirm-submit`、`app-chat-confirm-cancel`、`app-chat-confirm-fallback`）；
   - 点击确认时统一调用 `src/client/canvas/canvas-actions.ts` 导出的权威 builder + `postActionSeam` / `postDecisionRecordFacade` / `postCandidateConstraint`（`decision_record` 渲染前先拉 `fetchDecisionFacts` 校验阻断项）；
   - 提交成功后回调 `App.tsx` 触发右侧画布静默刷新。
3. `src/app/app.css` & `src/app/TESTID-MANIFEST.md`：按第 二 节样式红线补齐样式与 testid 清单。

### 阶段三：端到端验收门禁（本地 Agent 执行）
1. 静态与构建门禁全绿：`npx tsc --noEmit`（0）、`npx tsdown`（双入口）、`server-typecheck`（0/0）、`runtime-budget`、`entry-reachability`、`client-contract-check`（0 违规）、`term-lint`（0 违规）；
2. `run-v4.mjs --fresh` 15/15 无回归；
3. **1440 浏览器端到端真测**（证据存 `evidence/chat-inline-confirm-<date>/`）：
   - 候选人页发「帮我给这位候选人添加一条置顶提醒：二面重点追问带团队细节」→ 对话渲染确认卡（无自动写库）→ 点击「确认执行」→ 卡片转绿字回执 + 右侧画布静默刷新出现置顶标签 + 独立 psql 读回验证；
   - 候选人页发「直接通过张三的初筛」→ 渲染确认卡 → 点击「取消」→ 零写入、卡片收起；再次确认 → 真实落库且画布阶段推进，重放点击不可重复提交；
   - 缺面评候选人发「直接给这位候选人下录用决定」→ 卡片诚实展示缺面评阻断原因并禁用主按钮（fail-closed，零写入）；
   - 诊断头 `x-recruitment-agent-diag: 1` 确认对话 Agent 仍为 **0 写工具**。
