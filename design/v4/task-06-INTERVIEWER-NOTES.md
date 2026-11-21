# INTERVIEWER-NOTES.md · 前端任务书 06 交付说明（面试官视角对照 v4）

> 对应任务书：`design/v4/frontend-task-06-interviewer.md` · 日期：2026-11-19
> 说明：仅修改 `dsh/dsh-recruitment/src/client/interviewer/**`，未改动 `src/http/**`、`src/tools/**`、`db/**`、`docs/**` 与 `src/client/canvas/**`；未新增多余按钮/开关；界面零内部 ID / 字段名 / 错误码。

---

## 一、本轮改动清单

1. **`dsh/dsh-recruitment/src/client/interviewer/normalize.ts`**
   - 新增 `InterviewConstraintView`（`kind: 'PIN' | 'HANDOFF'`、`text`、`source`、`from_previous_round`）与 `ScorecardDraftPayload`（`assessments`、`note`）。
   - 在 `InterviewRow` 上安全归一化 `constraints[]` 与 `iqs[]`；上一轮空态统一改为人话「还没有转写/上一轮记录」。
2. **`dsh/dsh-recruitment/src/client/interviewer/http.ts`**
   - 新增 `fetchScorecardDraft`（`GET /recruitment/api/action/scorecard/draft?interview_id=<uuid>`）与 `saveScorecardDraft`（`POST /recruitment/api/action/scorecard/draft`，**不带 `confirmation_text`**）；
   - 新增 `clearScorecardDraft` 与 `localStorage` 断网兜底读写函数（`ros-iw-draft-<interviewId>`）。
3. **`dsh/dsh-recruitment/src/client/interviewer/InterviewerWorkspace.tsx`**
   - **T6-1 面前简报一屏看完**：简报头部直接渲染 `constraints[]`（`PIN` 常驻置顶，`HANDOFF` 明确标注「**上一轮留的**」），隐藏原简报底部的 `template_version` / `reason` 工程字段。
   - **T6-2 面后速记**：在简报下方内嵌 `QuickNotesAndChecklist`，进入时先读服务端草稿（服务端优先，无服务端草稿时回退 `localStorage` 断网兜底），输入后 **2 秒防抖**自动存至服务端并同步本地。
   - **T6-4 追问清单**：当 `iqs[]` 非空时展示本地可勾选列表，并如实注明「**本次勾选仅留在本页**」。
4. **`dsh/dsh-recruitment/src/client/interviewer/ScorecardForm.tsx`**
   - 打开表单时恢复草稿（服务端优先、本地兜底），勾选维度评估后 2 秒防抖自动存草稿（不带 `confirmation_text`）；
   - **T6-3**：沿用既有 `POST /recruitment/api/action/scorecard/submit`，提交成功后同步清理服务端与本地草稿；提交失败留在页面、不清草稿、展示人话提示（不显示 `code`/`reason_code`）。
5. **`dsh/dsh-recruitment/src/client/interviewer/styles.ts`**
   - 将 `.iw-root` 色彩变量对齐 `design/v4/contracts/design-tokens.md`（暖纸白 `#F9F8F5` + 纯白 `#FFFFFF` + 暖炭黑 `#191918` + 鸢尾紫 `#5B5BD6` + 语义绿/琥珀/红）。

---

## 二、`grep` 关键实现自查

```text
dsh/dsh-recruitment/src/client/interviewer/normalize.ts:279:/** 面评草稿数据结构（Task 06 · T6-2：GET/POST /recruitment/api/action/scorecard/draft）。 */
dsh/dsh-recruitment/src/client/interviewer/http.ts:32:const SCORECARD_DRAFT_ENDPOINT = '/recruitment/api/action/scorecard/draft'
dsh/dsh-recruitment/src/client/interviewer/http.ts:249: * 读取服务端面评草稿（GET /recruitment/api/action/scorecard/draft?interview_id=...）。
dsh/dsh-recruitment/src/client/interviewer/http.ts:272: * 自动保存面评草稿（POST /recruitment/api/action/scorecard/draft）。
dsh/dsh-recruitment/src/client/interviewer/http.ts:275:export async function saveScorecardDraft(options: {
dsh/dsh-recruitment/src/client/interviewer/http.ts:297:export async function clearScorecardDraft(options: {
dsh/dsh-recruitment/src/client/interviewer/ScorecardForm.tsx:27:  clearScorecardDraft,
dsh/dsh-recruitment/src/client/interviewer/ScorecardForm.tsx:31:  saveScorecardDraft,
dsh/dsh-recruitment/src/client/interviewer/ScorecardForm.tsx:177:      void saveScorecardDraft({
dsh/dsh-recruitment/src/client/interviewer/ScorecardForm.tsx:232:        void clearScorecardDraft({ sessionId: props.sessionId, interviewId: props.interviewId })
dsh/dsh-recruitment/src/client/interviewer/InterviewerWorkspace.tsx:24:  saveScorecardDraft,
dsh/dsh-recruitment/src/client/interviewer/InterviewerWorkspace.tsx:642:      void saveScorecardDraft({ sessionId, interviewId, payload })
dsh/dsh-recruitment/src/client/interviewer/InterviewerWorkspace.tsx:655:            <span className="iw-tiny iw-muted">本次勾选仅留在本页</span>
dsh/dsh-recruitment/src/client/interviewer/InterviewerWorkspace.tsx:759:                        <span className="iw-handoff-badge">上一轮留的</span>
```

---

## 三、待后端并行补齐的字段与未自测项

### 1. 依赖后端并行补齐的接口/字段（契约已按任务书 §1 对齐）
* `GET /recruitment/api/interviewer/overview` / `interviews/:id` 中的 `constraints[]`（`PIN` / `HANDOFF`）与 `iqs[]`；
* `GET /recruitment/api/action/scorecard/draft?interview_id=<uuid>` 与 `POST /recruitment/api/action/scorecard/draft`（以及提交后自动清理或支持 `DELETE`）。

### 2. 未自测项（如实声明）
* `npx tsc --noEmit` 与 `npx tsdown` 构建：**未自测**（云端无项目依赖与构建链）。
* 真 Host + 真库面试官 alias 实拍走查截图（1440 / 390）：**未自测**。
* 速记刷新读回 `scorecard_draft` 表、断网兜底恢复、提交面评清草稿真库验收：**未自测**。
