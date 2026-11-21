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

## 阶段三（待合并 PR #18 后补）

- 本地临时联调分支合并 `feat/chat-inline-confirm-server` + `feat/chat-inline-confirm-ui`；
- 静态/构建门禁 + 15 步 + 1440 四场景（置顶提醒 / 初筛确认/取消 / 终审缺面评阻断 / 诊断 0 写工具）；
- 本 README 与目录在阶段三完成后补全截图、psql 读回、运行结果。
