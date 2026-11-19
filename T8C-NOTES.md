# T8C-NOTES.md · 前端任务书 08c 交付说明（画布写动作全量复用既有 Builder 与 Seam）

> 对应任务书：`design/v4/frontend-task-08c-reuse-builders.md`（commit `0f6f36d` · V3-2 / D-162）
> 基线分支：`feat/unified-document-intake`（基于最新 HEAD `2f6069c`，完整保留 `f1f03cc` 的 `X-DSH-Session` 注入）

## 一、动作 → 既有 Builder → 调用位置对照表

| 动作 | 复用的 Builder（`src/client/recruiting/actions.ts`） | 发送函数（`src/client/recruiting/use-recruiting.ts`） | 画布调用处（`file:line`） |
|---|---|---|---|
| 决策事实预取 | — | `fetchDecisionFacts(applicationId, sessionId)`（`:684`） | `CandidateActionModal.tsx:182`（`probe !== 'READY'` 禁提交并显示 `decision-facts-blocked`） |
| 初筛结论（通过=`ADVANCE` / 待定=`HOLD` / 不通过=`REJECT` / 撤回=`WITHDRAW`） | `buildScreeningDecisionBody`（`:881`） | `postActionSeam(vm.actions.screening_decide, built.body, sessionId)`（`:427`） | `CandidateActionModal.tsx:277`、`CandidateActionModal.tsx:284`（不发 `confirmation_text`） |
| 正式决策（`scope: 'FINAL' \| 'STAGE'`，`ADVANCE / HOLD / REJECT`） | `buildDecisionRecordBody`（`:998`） | `postActionSeam(vm.actions.decision_record, built.body, sessionId)`（缺失时回退 `postDecisionRecordFacade`） | `CandidateActionModal.tsx:293`、`CandidateActionModal.tsx:309`、`CandidateActionModal.tsx:310`（不发 `confirmation_text`） |
| 阶段推进 | `buildStageAdvanceBody`（`:760`） | `postActionSeam(vm.actions.stage_advance, built.body, sessionId)` | `CandidateActionModal.tsx:316`、`CandidateActionModal.tsx:318` |
| 转写导入 | `buildTranscriptImportBody`（`:1219`） | `postActionSeam(vm.actions.transcript_import, built.body, sessionId)` | `CandidateActionModal.tsx:325`、`CandidateActionModal.tsx:332` |
| 面试排期（CREATE / RESCHEDULE / REPLACE） | `buildInterviewScheduleBody`（`:1128`） | `postActionSeam(vm.actions.interview_schedule, body, sessionId)` | `CandidateActionModal.tsx:370`、`CandidateActionModal.tsx:398` |
| 标记未出席（`NO_SHOW`） | 画布独有 payload（无既有 builder） | `postActionSeam(vm.actions.interview_schedule, body, sessionId)`（无硬编码路由） | `CandidateActionModal.tsx:347` |
| 新建岗位 | `buildJobCreateBody`（`:1532`） | `postJobCreate(built.body, sessionId)` | `JobPage.tsx:190`、`JobPage.tsx:206` |
| 设置写入 / 岗位草案 / 关闭岗位 / Rubric 批准 | `buildSettingsWriteBody`（`:1307`） / `buildJobDraftBody` / `buildJobCloseBody` / `buildRubricApproveBody` | `postActionSeam` / `postJobDraft` / `postJobClose` | `canvas-actions.ts:20-24` 统一转导复用 |

## 二、已删除的手拼写动作函数与硬编码路由（`canvas-actions.ts`）

已从 `dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts` 中彻底删除以下 7 个自拼函数及其硬编码路由字面量：
1. `postScreeningDecide`
2. `postDecisionRecord`
3. `postStageAdvance`
4. `postTranscriptImport`
5. `postInterviewSchedule`
6. `postSettingsWrite`（同步清除 `CanvasRoute.tsx` 中的未用导入）
7. `postJobCreate`（改为从 `../recruiting/use-recruiting.ts` 导出并复用 `buildJobCreateBody`）

保留画布独有动作（均已带 `x-recruitment-request` + `X-DSH-Session`）：
- `uploadResumeRaw` / `fetchTaskStatus`
- `fetchInterviewFreeSlots` / `postRebindMinute`
- `postApplicationStar` / `postEmailSend`
- `postBatchReject` / `postActionUndo`
- `postCandidateConstraint` / `postApplicationTransfer`

## 三、decision-facts 缺失拦截（Fail-Closed）

- 打开「初筛结论」或「正式决策」弹窗时，立即请求 `fetchDecisionFacts(vm.applicationId, activeSessionId)`。
- 当 `probe !== 'READY'`、无 `facts`、或 `screeningDecisionBlockers` / `decisionRecordBlockers` 非空时：
  - 渲染 `data-testid="decision-facts-blocked"` 人话提示（初筛缺评估时固定显示「还没有初筛评估，先让 Agent 跑一次初筛」）；
  - 禁用 `data-testid="canvas-modal-submit"` 按钮，且 `handleSubmit` 入口再次短路返回，确保**零写入请求**发出。

## 四、自检结果

### 1. 静态合同检查（云端 Node v18 实跑 PASS）
执行 `scripts/client-contract-check.mjs`（与仓库 commit `aace264` 完全一致）及 `findHandRolledWrites()`：
```
entry-reachability [手拼写动作]: 0 条
client-contract-check: PASS（画布写动作全部走既有 builder + postActionSeam）
EXIT CODE: 0
```

### 2. 云端无环境未跑项（如实声明）
- `npx tsc --noEmit`、`npx tsdown`（重建 `lib/client.js`）：**云端无环境未跑**
- 完整仓库 `node scripts/entry-reachability.mjs`：**云端无环境未跑**（已用同口径 `HAND_ROLLED_WRITE_ACTIONS` 清单自检归零）
- `runbook --fresh` 15 步真浏览器点测 + 独立 `psql` 读回：**云端无环境未跑**
