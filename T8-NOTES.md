# T8-NOTES.md · 前端任务书 08（根因版 v2）交付说明

> 对应任务书：`design/v4/frontend-task-08-write-entries.md`（commit `ba0e2b5` · D-160 根因版） · 日期：2026-11-19
> 分支：`feat/frontend-task-08`（基于 `feat/unified-document-intake` 创建，避免覆盖主分支 `term-lint` 与 `normalize.ts` 修复）
> 说明：先修 V1 两条红线（F1 面试官身份串写 + F2 面评真提交），再把旧详情页写入口完整对齐至 v4 画布并补齐新增能力入口、`NO_SHOW` 展示映射与 `expected_record_version` 乐观锁；旧详情页未删保持可达。

---

## 一、V1 红线修复（F1 & F2）

1. **F1 身份串写根治**（`interviewer/InterviewerWorkspace.tsx`、`interviewer/ScorecardForm.tsx`、`interviewer/http.ts`）：
   - **按分配范围限制编辑**：`QuickNotesAndChecklist` 仅在 `canSubmit && row.scorecard.state !== 'SUBMITTED'` 时可编辑，非本人场次或已提交场次设为只读禁用；
   - **自动保存严格绑定场次+身份**：`localStorage` 键按 `sessionId:alias:interviewId` 隔离；防抖闭包捕获当前 `boundSession` / `boundInterview`，切换身份或离开页面时 cleanup 立即 `cancelled = true; clearTimeout(timer)` 取消挂起请求；
   - **拒收 `INTERVIEWER_MISMATCH`**：服务端返回 `INTERVIEWER_MISMATCH` 或 403 时，显示「当前身份与本场面试不匹配，未能保存草稿」，绝不假称已保存。
2. **F2 面评真提交**（`interviewer/ScorecardForm.tsx`）：
   - 「提交我的独立面评」（`data-testid="submit-scorecard"`）调用 `submitScorecard` → `POST /recruitment/api/action/scorecard/submit`；成功后清理本人该场次服务端+本地草稿并调用 `props.onSubmitted()` 刷新为已提交只读态；失败留在页面不清草稿、显示人话原因；已补齐 `fetchScorecardFormSpec` 导入。

---

## 二、§1 能力对齐矩阵（全部入口 `testid` 与路由引用）

| # | 能力 | 写路由 | 入口位置与 `data-testid` | 状态 |
|---|---|---|---|---|
| 1 | 初筛结论（通过/待定/不通过+原话） | `/action/screening/decide` | `CandidatePage.tsx` `canvas-action-screening` | ✅ 已接 |
| 2 | 正式决策（缺面评拦截显示缺谁+防重） | `/decision/record` | `CandidatePage.tsx` `canvas-action-decision`（缺面评显示 `decision-missing-scorecards` 并禁用提交） | ✅ 已接 |
| 3 | 阶段推进 / 带原话跳轮 | `/action/stage/advance` | `CandidatePage.tsx` `canvas-action-stage-advance` | ✅ 已接 |
| 4 | 转写导入 | `/action/transcript/import` | `CandidatePage.tsx` `canvas-action-transcript-import` | ✅ 已接 |
| 5 | 约面 / 选面试官 / 独立改期 / 版本号 | `/action/interview/schedule` | `CandidatePage.tsx` `canvas-action-schedule`、`schedule-interviewers-input`、`schedule-mode-reschedule` | ✅ 已补齐 |
| 6 | 标记未出席（`NO_SHOW`）+ 状态映射 | `/action/interview/schedule` (`intent:'NO_SHOW'`) | `normalize-canvas.ts` `NO_SHOW→未出席`；`CandidatePage.tsx` `canvas-action-no-show` | ✅ 已接 |
| 7 | 候选人页上传简历 | `/intake/upload` | `CandidatePage.tsx` `canvas-action-candidate-upload`（顶栏轮询不抢画布） | ✅ 已补齐 |
| 8 | 候选人星标 | `/action/application/star` | `CandidatePage.tsx` `canvas-action-star` | ✅ 已接 |
| 9 | 复合指令 | `/action/compound` | 按任务书 §1 第 9 行：**本轮不做**（矩阵记“未接”） | ⏸ 本轮不做 |
| 10 | 发信（含 Offer） | `/action/email/send` | `CandidatePage.tsx` `canvas-action-email` | ✅ 已接 |
| 11 | 工作空间设置写入 | `/action/settings/write` | `canvas-actions.ts` `postSettingsWrite`（已接入 `CanvasRoute.tsx`） | ✅ 已接 |
| S15 | 乐观锁版本冲突 | `expected_record_version` | 写请求统一携带 `vm.recordVersion`；409 冲突提示「这条刚被别人改过，请刷新」 | ✅ 已接 |

---

## 三、未自测项（如实声明）

1. **`npx tsc --noEmit`、`npx tsdown` 与 `scripts/entry-reachability.mjs` 机检**：**未自测**（云端无项目依赖与构建链）。
2. **`docs/37-e2e-acceptance-runbook.md` 真 Host + 真浏览器 15 步重跑与独立 `psql` 读回**：**未自测**。
3. **F1 切面试官 A/B 实测与 F2 `scorecard` 表 +1 独立查库**：**未自测**。
