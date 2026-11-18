# task-04-NOTES.md · 前端任务书 04 接线收尾说明

> 对应任务书：`design/v4/frontend-task-04-wire-canvas.md`（commit `e40c72c`） · 日期：2026-11-19
> 说明：彻底关闭总控复核发现的 R1（`canvas-actions.ts` 零引用）与 R2（`CanvasPanelHost` 零调用点），全程零 `location.hash` 改动、零新增侧栏项、未碰后端与 `src/client/index.tsx`。

---

## 一、本轮改动与真实引用点（`file:line`）

### 1. R2 修复：`CanvasPanelHost` 真正接入 `RecruitingWorkspace.tsx`（无 hash）
* **文件**：`dsh/dsh-recruitment/src/client/recruiting/RecruitingWorkspace.tsx`
  * 引入 `CanvasPanelHost`（`from '../canvas/CanvasRoute.tsx'`），包裹 `.rcw-content` 主画布区；
  * 将候选人漏斗列表 `<ApplicationRow onOpen={(applicationId) => openCandidate(applicationId)} />` 直接接到 `CanvasPanelHost` 的纯 React 状态切换上；
  * 点击任意候选人行立即在主画布区展开 v4 `CanvasRoute`（`CandidatePage`），点击「← 返回」恢复列表，点击面包屑岗位名可进入 v4 `JobPage`，**全程零 `location.hash` 读写**。

### 2. R1 修复：`canvas-actions.ts` 全部写入口真正接入画布确认动作
* **`dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx`**：
  * 引用 `postCandidateConstraint`（`PIN` 置顶约束、`HANDOFF` 下一轮交接追问）与 `postApplicationTransfer`（跨岗调剂）；
  * 在画布底部轻量入口弹出居中确认卡（强制填写 `confirmation_text`），提交瞬间进入 `disabled + 处理中…` 锁态防连点，成功自动刷新档案，失败展示人话原因（无错误码）。
* **`dsh/dsh-recruitment/src/client/canvas/JobPage.tsx`**：
  * 引用 `uploadResumeRaw`（原始字节上传 `POST /recruitment/api/intake/upload?job_id=...`）→ 拿到 `task_id` 后通过 `onUploadStarted` 挂载顶栏 `UploadProgressBanner` 轮询 `GET /recruitment/api/tasks/status`，完成后递增 `refreshNonce` 刷新岗位列表（不抢占当前画布）；
  * 引用 `postJobCreate`（居中确认卡新建岗位，**绝不传 `headcount`**，明确提示 HC 由需求单维护）。
* **`dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx`**：
  * 引用 `fetchTaskStatus` 驱动 `UploadProgressBanner` 轮询，并在 `CanvasPanelHost` 中串联 `uploadTask` 与 `refreshNonce`。
* **`dsh/dsh-recruitment/src/client/normalize-canvas.ts`** & **`canvas/canvas.css`**：
  * 在 `InterviewRoundVM` 补上 `interviewId` 供 `HANDOFF` 动作透传给后端；
  * 在 `canvas.css` 补齐 v4 居中确认卡（`.ros-modal-bg` / `.ros-modal` / `.ros-doc-foot`），变量 100% 沿用 `design-tokens.md`。

---

## 二、`grep` 自查结果（原样贴回）

### 1. `grep -rn "canvas-actions" dsh/dsh-recruitment/src/client/`
```text
dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx:5:import { fetchTaskStatus, type UploadTaskStatusResult } from './canvas-actions.ts';
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:18:} from './canvas-actions.ts';
dsh/dsh-recruitment/src/client/canvas/JobPage.tsx:21:} from './canvas-actions.ts';
```

### 2. `grep -rn "CanvasPanelHost" dsh/dsh-recruitment/src/client/`
```text
dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx:238:export interface CanvasPanelHostProps {
dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx:253:export function CanvasPanelHost({ children, onRefreshOverview, fetcher }: CanvasPanelHostProps) {
dsh/dsh-recruitment/src/client/recruiting/RecruitingWorkspace.tsx:20:import { CanvasPanelHost } from '../canvas/CanvasRoute.tsx'
dsh/dsh-recruitment/src/client/recruiting/RecruitingWorkspace.tsx:2132:        <CanvasPanelHost onRefreshOverview={overview.reload}>
dsh/dsh-recruitment/src/client/recruiting/RecruitingWorkspace.tsx:2382:        </CanvasPanelHost>
```

---

## 三、未自测项（如实声明）

1. **`npx tsc --noEmit` 与 `npx tsdown` 构建**：**未自测**（云端沙箱无项目 `node_modules`、`tsc` 与 `tsdown`；已对照 `dsh/dsh-recruitment/tsconfig.json` 的 `strict: true` + `allowImportingTsExtensions: true` + `react-jsx` 核对所有 `.ts`/`.tsx` 扩展名导入与类型）。
2. **真 Host + 真库 1440 / 390 浏览器点击候选人行进入 v4 画布实测**：**未自测**。
3. **画布内「置顶约束」200 + `psql` 读回 `candidate_constraint` 新行**：**未自测**。
4. **画布内上传简历 → 顶部进度 → 完成后候选人出现**：**未自测**。
