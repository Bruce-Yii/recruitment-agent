# PR #20 构建/静态/回归核查（2026-11-22）

> PR：**#20** `feat/job-and-screening-loop-closure`，head `23515dc`，base main `42062cb`。
> 结论：**tsc 阻断，不能进入 1440 新闭环验收，不能合入 main**。未改任何 UI 样式。

## 1. `npx tsc --noEmit`（红，2 条）

```text
src/client/canvas/JobPage.tsx(1019,37): error TS2304: Cannot find name 'handleApproveRubric'.
src/client/canvas/JobPage.tsx(1065,37): error TS2304: Cannot find name 'handleCloseJob'.
```

根因（精确位置）：

- `JobPage.tsx:148` 的 `useEffect(() => { ... })` 内定义了 `handleApproveRubric`（`:151`）与 `handleCloseJob`（`:201`），作用域在 `:239` 的 cleanup/effect 内结束；
- 但两个提交按钮在组件 JSX 的 `:1019` / `:1065` 引用这两个名字，作用域外不可见；
- 因此 `tsdown` 仍能打包，但点击「确认批准 / 确认关闭岗位」时提交处理器不存在（运行时会 ReferenceError），新闭环无法成立。

修复方向（由前端窗口执行，不改样式）：把这两个 async handler 移到组件作用域（在 `useEffect` 外、`return` JSX 前），effect 只保留加载与 cleanup；testid/文案/样式保持不变。

## 2. 构建与静态门禁

| 门 | 结果 |
|---|---|
| `npx tsdown` | PASS（双入口；lib/app.js 1.39MB） |
| `server-typecheck` | PASS（0/0） |
| `runtime-budget` | PASS（5051/5051） |
| `entry-reachability` | PASS（无新缺口；手拼 0） |
| `client-contract-check` | PASS（0 违规） |
| `term-lint` | PASS（0 违规） |

## 3. 既有回归

- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0（结果/审计见本目录）。
- 该回归不覆盖 PR20 新增的批准/关闭/评估按钮，不能替代新闭环验收。

## 4. 1440 新闭环

**未执行（tsc 阻断）**。按任务要求“若有 tsc 问题只报精确行号”，未修改 UI 代码；待前端修复作用域后重跑：

1. 新建岗位 → 岗位标准 Tab → `canvas-action-rubric-approve` → `canvas-rubric-approve-submit` → 已锁定 + psql 批准；
2. 新上传/未评估申请 → `canvas-action-screening-evaluate` → 评估完成 + 静默刷新；
3. `canvas-action-job-close` → `canvas-job-close-submit` → 岗位 CLOSED + psql 读回。

## 5. 文件

- `tsc-error.txt`
- `build-static-gates.txt`
- `regression-15step-result.json` / `regression-15step-audit.json`
