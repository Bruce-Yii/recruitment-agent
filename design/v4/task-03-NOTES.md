# NOTES.md · 前端任务书 03 交付与自测说明

> 对应任务书：`design/v4/frontend-task-03-real-backend.md` · 日期：2026-11-19

---

## 一、本轮改动文件清单（保持仓库相对路径）

1. **`design/v4/task-01/data/adapter.js`**
   - **T3-1 真连后端**：`http` 模式全面对齐 `contracts/api-samples/*.json` 真实结构（`/recruitment/api/overview`、`/recruitment/api/recruiting/overview`、`/recruitment/api/recruiting/jobs/:id`、`/recruitment/api/recruiting/applications/:id`、`/recruitment/api/settings`）；所有请求强制 `credentials: 'same-origin'` + `x-recruitment-request: 1`，前端绝不传 `actor`。
   - **T3-2 四个新增写入口**：
     - 跨岗调剂 → `POST /recruitment/api/action/application/transfer`（带 `confirmation_text`）
     - 置顶约束 / 下一轮交接 → `POST /recruitment/api/action/candidate/constraint`（`PIN` / `HANDOFF`，带 `confirmation_text`）
     - 新建岗位 → `POST /recruitment/api/action/job/create`（**严禁传 `headcount`**，仅传 `title` / `dept?` / `requisition_id?` / `confirmation_text`）
     - 上传简历 → `POST /recruitment/api/intake/upload?job_id=<uuid>`（原始字节 `body: file` + `x-file-name` header，立即返回 `task_id`）
   - **T3-3 上传轮询**：新增 `api.getTaskStatus(taskId)` 轮询 `GET /recruitment/api/tasks/status?task_id=<uuid>`；失败时只透出人话 `errorSummary`，绝不把 `error_code` 抛给界面。
   - **T3-4 未接通动作兜底**：`batch_reject`、`nudge`、`compound`、`star`、`save_notes`、`toggle_iq`、`undo_auto_done`、`restore_snapshot` 统一抛出 `NOT_AVAILABLE`，前台提示「这项还差最后一步，稍后开放」。

2. **`design/v4/task-01/recruitment_os.html`**
   - **0 行视觉/CSS/HTML 改动**（第 1–424 行与任务 01 字节级一致）。
   - 仅升级脚本层：所有确认卡提交自动附带 `confirmationText` 并在点击瞬间进入 `disabled + 处理中…` 锁态防连点；上传简历改为真实 `task_id` 轮询进度条，仅在后端返回 `COMPLETED` 后才刷新列表并显示已入库，返回 `FAILED` 时以红色提示条显示人话原因且绝不显示已入库；`NOT_AVAILABLE` 统一显示「这项还差最后一步，稍后开放」。

3. **`dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts`**（新增）
   - 为 DSH React 画布提供类型安全的 4 个已就绪写入口封装（`postApplicationTransfer`、`postCandidateConstraint`、`postJobCreate`、`uploadResumeRaw`）、`fetchTaskStatus` 轮询客户端与 `UNAVAILABLE_ACTION_MESSAGE`。

4. **`dsh/dsh-recruitment/src/client/canvas/CanvasRoute.tsx`**（更新）
   - **§4 无 hash 入口**：新增纯 React 状态容器 `CanvasPanelHost`，全程零 `location.hash` 读写，避免触发 DSH 外壳跳回会话页。
   - **T3-3 非阻塞上传进度条**：内置 `UploadProgressBanner`，挂载 `uploadTask` 后自动轮询 `GET /recruitment/api/tasks/status`，完成给「查看档案」、失败给人话原因。

5. **`INTERFACE-NEEDS-2.md`**（新增）
   - 逐条列出仍缺的写接口与读投影字段及对应影响页面。

---

## 二、云端已自测项（真实执行结果）

1. **CSS + HTML 零漂移校验**：`design/v4/task-01/recruitment_os.html` 第 1–424 行与 v4 原型字节级 0 行差异。
2. **脚本语法校验**：重构后的 `recruitment_os.html` 内联脚本通过 Node `new Function(...)` 语法校验。
3. **`data/adapter.js` Node 集成测试**：
   - 使用真实 `api-samples` 结构（`overview`、`recruiting-overview`、`job-detail`、`application-detail`、`settings`）验证 `http` 模式读取三屏正常；
   - 验证请求头必带 `x-recruitment-request: 1` 且不传 `actor`；
   - 验证 4 个新增写入口（`transfer`、`pin_constraint`/`add_handoff_iq`、`new_job` 确认不含 `headcount`、`uploadResume` 原始字节 + `x-file-name`）；
   - 验证上传轮询成功（`RUNNING → COMPLETED`）与失败（`RUNNING → FAILED` 返回人话 `errorSummary` 不含 `error_code`）；
   - 验证 6 类未接通动作均抛出 `NOT_AVAILABLE` 且提示「这项还差最后一步，稍后开放」。

---

## 三、未自测项（如实声明，需在本地仓库验收）

1. **`npx tsc --noEmit` 与 `npx tsdown` 构建**：**未自测**（云端无项目 `tsconfig.json`、React 类型包与 `tsdown` 工具链）。
2. **真 Host + 真库三屏实测与 1440 / 390 浏览器截图**：**未自测**。
3. **四类确认卡真实落库与 `psql` 独立读回**：**未自测**。
4. **真 Host 真实上传大文件 + 失败负例实测**：**未自测**。
5. **DSH 外壳内点行打开 `CanvasRoute` 与返回列表的真实无 hash 跳转实测**：**未自测**（未改动 `src/client/index.tsx`）。
