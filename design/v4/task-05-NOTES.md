# task-05-NOTES.md · 前端任务书 05 交付说明（批量不通过 + 5 秒撤销 + 画布动作点通）

> 对应任务书：`design/v4/frontend-task-05-batch-undo.md` · 日期：2026-11-19
> 说明：未新增任何额外按钮（复用 v4 原有勾选批处理浮条与 5 秒撤销 Toast），未改后端与视觉变量，所有失败原因与 409 冲突均转为自然业务语言。

---

## 一、本轮改动清单与引用点

1. **`dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts`**
   - 新增 `postBatchReject` → `POST /recruitment/api/action/decision/batch-reject`，兼容 200 部分失败，逐条提取 `message`（绝不展示 `reason_code`）。
   - 新增 `postActionUndo` → `POST /recruitment/api/action/undo`，将 409 严格映射为人话：「这条已经撤销过了」/「超过 5 分钟，不能再撤销」/「这条已经被后续操作覆盖，不能撤销」。
   - `postApplicationTransfer` / `postCandidateConstraint` / `postJobCreate` 同步透传服务端返回的 `action_id`。
2. **`dsh/dsh-recruitment/src/client/canvas/JobPage.tsx`**
   - 岗位漏斗勾选多位候选人 → 复用 v4 `.ros-batch-float` 浮条 → 居中确认卡（强制关联岗位 rubric `dimension_key` + `confirmation_text`，点击立即 `disabled + 处理中…` 防连点）→ 调用 `postBatchReject` → 展示逐条成功/失败原因、触发 5 秒撤销 Toast，并重新拉取服务端状态（**绝不本地物理删除**）。
3. **`dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx`**
   - 在 `CanvasPanelHost` 内置 5 秒撤销 Toast（`.ros-toast`），点击「撤销」调用 `postActionUndo`，成功后递增 `refreshNonce` 并调用 `onRefreshOverview` 从服务端重读最新状态。
4. **`dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx`**
   - 画布内「置顶约束 / 下一轮交接 / 跨岗调剂」三个写动作均调用 `postCandidateConstraint` / `postApplicationTransfer`（带 `confirmation_text`），成功后刷新当前画布并透传 `action_id` 至 5 秒撤销 Toast。
5. **`design/v4/task-01/data/adapter.js`**
   - 将 `batch_reject` 与 `restore_snapshot` 正式从 `NOT_AVAILABLE` 摘出，分别接入 `/recruitment/api/action/decision/batch-reject` 与 `/recruitment/api/action/undo`。

---

## 二、`grep` 自查结果（原样贴回）

### 1. 画布内四个核心写动作的真实调用点
```text
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:65:export async function postApplicationTransfer(payload: TransferPayload): Promise<{
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:91:export async function postCandidateConstraint(payload: ConstraintPayload): Promise<{
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:153:export async function postBatchReject(payload: {
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:209:export async function postActionUndo(payload: {
dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx:7:  postActionUndo,
dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx:316:      const res = await postActionUndo({
dsh/dsh-recruitment/src/client/canvas/JobPage.tsx:18:  postBatchReject,
dsh/dsh-recruitment/src/client/canvas/JobPage.tsx:131:      const res = await postBatchReject({
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:16:  postApplicationTransfer,
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:17:  postCandidateConstraint,
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:136:        const pinRes = await postCandidateConstraint({
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:150:        const hoRes = await postCandidateConstraint({
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:164:        const trRes = await postApplicationTransfer({
```

### 2. `adapter.js` 中 `batch_reject` 与 `restore_snapshot` 已接入真实接口（不再走 `NOT_AVAILABLE`）
```text
1033:          case 'batch_reject': {
1034:            const raw = await httpRequest('/recruitment/api/action/decision/batch-reject', {
1054:          case 'restore_snapshot':
1057:            const res = await fetch(`${baseUrl}/recruitment/api/action/undo`, {
```

---

## 三、云端已自测与未自测项

* **已自测（Node.js）**：`adapter.js` 批量不通过 200 部分失败逐条解析、撤销成功及三种 409 冲突人话映射全部通过。
* **未自测（需本地仓库验收）**：`npx tsc --noEmit`、`npx tsdown`、真 Host + 真库勾选 2 人批量不通过 + `psql` 读回、撤销后 `superseded_by` 与补偿决策核验、画布点置顶/跨岗真库落库。
