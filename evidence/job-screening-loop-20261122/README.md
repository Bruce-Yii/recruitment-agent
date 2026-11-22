# PR #20 复验（2026-11-22 · head 9e95cdb）

> PR：**#20** `feat/job-and-screening-loop-closure`，head **`9e95cdb`**（builder 已支持 boolean/numeric value），base `42062cb`。
> 结论：**tsc/构建/静态/15 步全绿；1440 场景②③ PASS，场景①卡在“新岗位缺 rubric_version_id”这一接口/读模型问题。不合并 main。**

## 1. 静态/构建/回归（全绿）

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS（0） |
| `npx tsdown` | PASS（双入口，lib/app.js 1.40MB） |
| `server-typecheck` | PASS（0/0） |
| `runtime-budget` | PASS（5051/5051） |
| `entry-reachability` | PASS（无新缺口；手拼 0） |
| `client-contract-check` | PASS（0 违规） |
| `term-lint` | PASS（0 违规） |
| `run-v4.mjs --fresh --port 49347` | **15/15 PASS**，审计 hard 0 |

## 2. 1440 三场景

### ① 新建岗位：创建成功，但“批准标准”被接口/读模型阻断

- 新建岗位成功落库（`jobId` 已取得，岗位出现在左栏；本轮显式进入 `#/job/<id>`）。
- 岗位标准 Tab → `canvas-action-rubric-approve` 按钮与确认弹窗均出现。
- 点击 `canvas-rubric-approve-submit` 后返回（页面反馈原文）：
  ```text
  评分标准版本编号缺失或格式不正确
  岗位为草稿：待完善 JD / Rubric 并提交审批
  ```
- 根因：新岗位的 rubric version 行已创建，但 `job.current_rubric_version_id` 未指向它（job-create 只写 `current_job_version_id`）；`readJobDetail` 用 `jobRow?.rubric_version_id` 装载 rubric（`src/http/recruiting.ts:2915`），导致详情 `rubric=null`，`normalize-canvas` 得到空 `rubricVersionId`（`JobPage.tsx:326` 传给 `buildRubricApproveBody`）。服务端没有可批准的版本号。
- 精确位置：
  - `src/tools/job-create.ts:1262-1267`：只更新 `current_job_version_id`，未设置 current rubric 指针；
  - `src/http/recruiting.ts:2915`：`loadRubric(ctx, jobRow?.rubric_version_id ?? null)`；
  - `src/client/canvas/JobPage.tsx:326`：`rubricVersionId: vm.rubricVersionId`。
- 截图：`01-new-job-created-1440.png`、`02-rubric-approve-blocked-1440.png`。

### ② 发起初筛评估：PASS

S7 未评估申请 → `canvas-action-screening-evaluate` → “评估中…” → 绿字「已更新初筛评估结果。」→ 标准对照区静默刷新。截图 `03/04`。

### ③ 关闭岗位：PASS

新岗位岗位标准 Tab 底部 → `canvas-action-job-close` → `canvas-job-close-submit` → 页面显示「已关闭岗位」→ psql 读回 `status=CLOSED`。截图 `05-job-closed-1440.png`。

## 3. 结论 / 后续

PR20 的三处 UI 改动（作用域、R-VAL criteria、boolean value 序列化）都已生效；剩余阻塞不在 PR20 前端代码，而在**新岗位的 rubric 版本读取/指向**：需要在服务端读模型或 job-create 侧把 pending rubric version 暴露给批准动作（或让 approve 端点按 job 解析 pending 版本），否则 UI 无法构造合法批准请求。按约定未改 UI 样式；未合并 main。

证据：`e2e-result.json`、`01-05` 截图、`regression-15step-*`。
