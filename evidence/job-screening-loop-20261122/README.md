# PR #20 复验（2026-11-22 最终）

> PR：**#20** `feat/job-and-screening-loop-closure`，head **`925818d`**（作用域修复后），base main `42062cb`。
> 结论：**tsc/构建/静态/15 步全绿；1440 三场景中 ② 通过，① 被“新建岗位”既有校验阻断，③ 因无新岗位未到达。不合并 main。**

## 1. 静态/构建（全绿）

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS（0，作用域问题已修复） |
| `npx tsdown` | PASS（双入口，lib/app.js 1.40MB） |
| `node scripts/server-typecheck.mjs` | PASS（0/0） |
| `runtime-budget` | PASS（5051/5051） |
| `entry-reachability` | PASS（无新缺口；手拼 0） |
| `client-contract-check` | PASS（0 违规） |
| `term-lint` | PASS（0 违规） |

## 2. 既有回归

`run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0。

## 3. 1440 三场景

### ② 发起初筛评估：PASS

- 进入 S7 未评估申请页 → 点击 `canvas-action-screening-evaluate` → 按钮进入“评估中…” → 页面输出绿字「已更新初筛评估结果。」，标准对照区静默刷新。
- 截图：`03-unevaluated-application-1440.png`、`04-screening-evaluated-1440.png`。

### ① 新建岗位 → 批准标准：**被既有新建岗位校验阻断**

- 新建岗位弹窗提交后返回：
  ```
  INVALID_ARGS/RUBRIC_INVALID: criteria 没有通过 R-VAL-1..13，逐条见 detail.violations
  ```
- 精确位置（不是 PR20 新增行，但本闭环依赖它）：
  - `dsh/dsh-recruitment/src/app/App.tsx:340`：
    `criteria: [{ key: 'core_fit', label: '核心岗位匹配度', kind: 'MUST_HAVE', weight: 1 }]`
  - `dsh/dsh-recruitment/src/client/canvas/JobPage.tsx:417`：同样的 criteria 形状。
- 原因：服务端 `job_create` 要求 criteria 满足 R-VAL-1..13（机械型需要 `field/operator/value`，判断型需要 `question` 等可执行信息）；当前 UI 只给 key/label/kind/weight，服务端拒绝，岗位未创建，因此无法进入“岗位标准 Tab → 批准标准”。
- 截图：`01-new-job-rubric-invalid-1440.png`（弹窗内即上述错误）。
- 这是**既有新岗位 UI 的接口兼容问题**，不是 PR20 的三处改动；按约定未改 UI 样式，仅报告精确位置与返回体。

### ③ 关闭岗位：**未到达**

- 因①岗位未创建，无新岗位可关闭；PR20 的 `canvas-action-job-close` / `canvas-job-close-submit` 未执行。未在既有演示岗位上取巧关闭。

## 4. 文件

- `e2e-result.json`：三场景机器读数（含①失败、②通过、③未到达）
- `01-new-job-rubric-invalid-1440.png` / `02-rubric-approve-not-reached-1440.png`
- `03-unevaluated-application-1440.png` / `04-screening-evaluated-1440.png`
- `05-job-close-not-reached-1440.png`
- `regression-15step-result.json` / `regression-15step-audit.json`

## 5. 后续

前端修复新建岗位 criteria（至少让 R-VAL-1..13 通过，如机械型补 field/operator/value，或判断型补 question）后，重跑①→②→③；全绿后再由总控合入 PR #20。未自行合并 main。
