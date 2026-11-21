# 前端任务书 08c · 画布写动作必须复用既有链路（最后一层契约，P0）

> 来源：我手工真点复现（真实页面）：会话头修好后，`POST /action/screening/decide` 变成
> `400 INVALID_ARGS/UNKNOWN_PARAM`，服务端 allowed 是**决策记录**的参数（`decision_scope / interview_id / basis_refs / as_of / summary_digest…`），
> 而画布发的是 `{application_id, result, reason, confirmation_text, expected_record_version}`。
> **结论：画布自己拼了 body，绕过了仓库里已有的 builder 与 decision-facts 读取。**

## 1. 事实（都在仓库里，直接复用）

| 能力 | 既有 builder | 说明 |
|---|---|---|
| 初筛结论 | `recruiting/actions.ts::buildScreeningDecisionBody`（`:881`） | 从 decision-facts 组装 `basis_refs`（RUBRIC_VERSION / AUTHORITY / SCREENING_EVALUATION） |
| 正式决策 | `buildDecisionRecordBody`（`:998`） | 同上，scope=STAGE/FINAL |
| 阶段推进 | `buildStageAdvanceBody`（`:760`） | |
| 转写导入 | `buildTranscriptImportBody`（`:1219`） | |
| 排期 | `buildInterviewScheduleBody`（`:1128`） | |
| 设置写入 | `buildSettingsWriteBody`（`:1307`） | |
| 岗位 create/draft/close / rubric 批准 | `buildJobCreateBody` / `buildJobDraftBody` / `buildJobCloseBody` / `buildRubricApproveBody` | |

**发请求也已有正确实现**：`recruiting/use-recruiting.ts::postActionSeam(action, request, sessionId)`（`:427`）——
自带 `x-recruitment-request` + **`x-dsh-session`**（只从形参来）、统一错误话术、`ActionOutcome` 处理。
**decision-facts 读取**：`use-recruiting.ts::fetchDecisionFacts`（`:684`，含 `DecisionFactsResource`）。

所以画布**不需要也不允许**自己拼这些 body、自己发这些 POST——那等于把已验收的合同重写一遍，必错。

## 2. 要做的（按这个顺序）

1. `canvas/CandidateActionModal.tsx` 里以下动作改为：
   - 先取 `fetchDecisionFacts(applicationId, sessionId)`（已有，注意 probe=READY 才允许提交，MISSING 时人话提示"还没有初筛评估，先让 Agent 跑一次初筛"）；
   - 用上表 builder 生成 body；
   - 用 `postActionSeam(action, body, sessionId)` 发送；
2. 覆盖：初筛结论、正式决策、阶段推进/跳轮、转写导入、排期（CREATE/RESCHEDULE/REPLACE）、设置写入、岗位 create/draft/close、rubric 批准；
3. `canvas-actions.ts` 里**删掉**这些手拼 body 的函数（`postScreeningDecide` / `postDecisionRecord` / `postStageAdvance` / `postTranscriptImport` / `postInterviewSchedule` / `postSettingsWrite` 等），改为从 `recruiting/*` 导入复用；
4. 保留画布独有的：上传（`uploadResumeRaw`）、任务轮询、空闲时段读取、星标、发信、批量拒绝/撤销、置顶约束/交接/跨岗、NO_SHOW（这些没有既有 builder 的，保持现状但**必须带会话头**——已完成）。

## 3. 验收（我按这个重跑，缺一不算过）

1. `tsc` 0、`tsdown` 通过；`node scripts/entry-reachability.mjs` 的"手拼写动作"检查归零（我加了机检，见 `docs/38 §6`）；
2. `runbook --fresh`：
   - S4 初筛：真点提交 → `decision(scope=SCREENING)` +1；
   - S12/S13：终审 → `decision(scope=FINAL)` current 唯一；重复提交提示"已处理过"；
   - S5/S6/S15：排期/改期/版本冲突文案；
   - S14：`NO_SHOW` + 事件；
   - S9/S11：`scorecard` +1；
3. 自测里给一条"decision-facts 缺失时界面被拦住、零写入"的证据。

## 4. 交付

- 分支 + PR；`T8C-NOTES.md` 写清"每个动作 → 复用哪个 builder / 哪一行 / 删了哪些自拼函数"；
- 不许改后端、不许放宽断言。
