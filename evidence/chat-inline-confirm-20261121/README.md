# 对话内写确认卡（Issue #17 / PR #18）· 阶段一与阶段三核查材料（2026-11-21）

> 权威规范：`design/v4/chat-inline-confirm-spec.md`（main `e7d5092`）。
> 阶段一：本地 Agent（服务端只读调度）——`recruitment_ui_dispatch` 支持 `propose_write` + `UiWriteProposal`，严格 fail-closed，`CHAT_READ_TOOLS` 保持 0 写。
> 阶段二：前端窗口 PR #18（`feat/chat-inline-confirm-ui`）——暖纸确认卡、既有写合同接线。
> 阶段三：本地临时联调分支合并两线后做静态/构建/15 步/1440 四场景真机验收。

## 阶段一（服务端）

- 代码：`src/tools/ui-dispatch.ts`
  - `UiActionType` 新增 `propose_write`；新增 `UiWriteIntent`（5 枚举）、`UiWriteSummaryItem`、`UiWriteProposal`（含 `payload` 业务字段）并扩展到 `UiActionPayload.proposal`。
  - fail-closed：`proposal` 必填、`application_id` UUID、`title` ≤24 字、`summary` 2..4 条（label ≤12 / value ≤48，禁止 UUID/机器码）、按 intent 必填业务字段（decision / target_stage / constraint_kind+text / interviewer_id+起止时间 / final_outcome）；非法输入 `INVALID_ARGS`，不下发 SSE。
  - 工具 description 明确：参数齐全 `propose_write`，缺字段降级 `suggest_action`，严禁伪造 ID/时段。
- `agent-turn.ts` 无需改动：`tool/result` 成功时复用 `normalizeUiAction`，已完整透传 `propose_write` + `proposal` 到 `event: ui_action`；`CHAT_READ_TOOLS` 仍 18 个只读、0 写。
- 单测：`test/unit/ui-dispatch-propose-write.test.ts`（4 组、11 用例：5 类 intent 合法、非法 UUID/未知 intent/未知字段、title/summary/机器码越界、各 intent 缺字段/枚举/时间/时区）。
- 真模型 SSE（一次性干净库 + HY4；`stage1-propose-write-probe.json`）：
  1. 候选人上下文「给这位候选人添加一条置顶提醒：二面重点追问带团队细节」→ tool `recruitment_ui_dispatch` action=`propose_write`，SSE `ui_action.proposal.intent=candidate_constraint`；
  2. 「直接通过这位候选人的初筛」→ `propose_write` / `screening_decide`；
  - 两轮均未落库（decision/interview/scorecard/scorecard_draft/application/candidate_constraint 前后计数一致）；诊断 18 只读 / 0 写。
- 门禁（main `e7d5092` + 本分支）：tsc 0、tsdown 双入口、server-typecheck 0/0、runtime-budget 5051/5051、entry-reachability、client-contract-check、term-lint 全 PASS。

## 阶段三（2026-11-21/22 本地临时联调）

联调分支：`tmp/chat-inline-confirm-integration`（main `e7d5092` + 阶段一 `cec1cef` + PR #18 `ad1ef4c`）。**PR #18 原样不能编译**，本地临时分支打了一行类型修复后才跑通（该修复未推送到 PR #18）：

- `npx tsc --noEmit` 原报错：`src/app/InlineConfirmCard.tsx(214,26): error TS2554: Expected 2 arguments, but got 1.`
- `screeningDecisionBlockers(factsRes.facts)` 缺 `needsEvaluation`；screening 的 PASS/REJECT 分支应传 `true`（与 `CandidateActionModal.tsx:258-259` 同口径）。

### 静态/构建（临时联调分支）

- `npx tsc --noEmit` = **0**（含临时一行修复）
- `npx tsdown` 双入口通过
- `server-typecheck` 0/0、`runtime-budget` 5051/5051、`entry-reachability`、`client-contract-check`、`term-lint` 全 PASS
- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0

### 1440 真机四场景（一次性干净库 + HY4，3 个 S7/S8/S10 候选）

| 场景 | 结果 |
|---|---|
| ① 置顶提醒 | **PASS**：自然语言 → `app-chat-confirm-card`（提交前零写入）→ `app-chat-confirm-submit` → 绿字回执 + 右侧 `canvas-pin-row` 出现“二面重点追问带团队细节” + psql 读回 candidate_constraint +1 |
| ② 初筛决策 | **PASS**：自然语言 → 卡片 → `app-chat-confirm-cancel` → 卡片收起且 decision 计数不变 → 再次触发 → 确认落库 decision +1，提交按钮消失（不可重提） |
| ③ 终审缺面评阻断 | **FAIL（PR #18 前端）**：卡片正确出现且摘要显示“两位面试官评分均未提交，系统提示暂不可确认录用”，但 `app-chat-confirm-submit` **仍可点击**；点前零写入。需要在 `InlineConfirmCard.tsx` decision pre-check 中读取缺面评事实并禁用主按钮（当前只调 `decisionRecordBlockers`，未覆盖缺面评）。证据截图 `phase3-06-decision-button-not-disabled-1440.png` |
| ④ 诊断头 0 写工具 | **PASS**：18 个只读工具，写工具 0 |

### 结论

阶段一服务端 PR **#19** 可独立审阅；阶段三 **3/4**，阻塞在 PR #18 的两处前端问题：
1. `InlineConfirmCard.tsx:214` 类型错误（需传 `true`）；
2. 终审缺面评时主按钮未禁用（卡片已显示阻断文案但按钮可点）。

已按约定只报告精确位置，未向 PR #18 推送 UI 改动、未改样式。PR #18 修复后需重跑阶段三四场景 + 15 步。
