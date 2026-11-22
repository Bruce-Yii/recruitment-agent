# Issue #23 + PR #20 联调验收（2026-11-22 · 全绿）

> 新 PR：**#27** `feat/job-detail-pending-rubric-read`（head `f6b8476`，指向 main）
> 联合 PR：#20 `feat/job-and-screening-loop-closure`（head `9e95cdb`）
> 联调分支：`tmp/job-screening-loop`（latest main + #27 + #20）
> 结论：**tsc/构建/静态/15 步全绿；1440 三场景 3/3 PASS。未合并 main。**

## 1. Issue #23 修复

- `src/http/recruiting.ts`：岗位详情在 `current_rubric_version_id` 为空时，回退查询该 job 最新一条 `rubric_version`（`version_no DESC`），返回 `rubric_version_id / version_no / criteria`；`job.rubric.approved` 严格保持 `false`。
- 无 rubric 的 DRAFT 岗位仍返回 `rubric=null`（不编造）。
- 只改只读投影 + 集成测试；写链路、前端未动。
- 新增集成用例：`test/integration/recruiting-overview.test.ts`「岗位详情 pending rubric…」；该文件 **11/11 PASS**。

## 2. 静态/构建/回归（全绿）

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

## 3. 1440 三场景（一次性干净库 + HY4）

| 场景 | 结果 |
|---|---|
| ① 新建岗位 → 批准标准 | **PASS**：新建成功 → 岗位标准 Tab → `canvas-action-rubric-approve` → `canvas-rubric-approve-submit` → 页面显示「已锁定 / 已批准岗位评分标准 V1」；psql 读回 `rubric_version` 有 APPROVED 审批（`rubricRow = <id>|1|1`）。截图 `01/02` |
| ② 未评估申请发起初筛评估 | **PASS**：`canvas-action-screening-evaluate` → “评估中…” → 绿字「已更新初筛评估结果。」→ 标准对照区静默刷新。截图 `03/04` |
| ③ 关闭新岗位 | **PASS**：`canvas-action-job-close` → `canvas-job-close-submit` → 页面「已关闭岗位」；psql 读回 `job.status=CLOSED`。截图 `05` |

## 4. 证据文件

- `01-new-job-created-1440.png`
- `02-rubric-approved-1440.png`
- `03-unevaluated-application-1440.png` / `04-screening-evaluated-1440.png`
- `05-job-closed-1440.png`
- `e2e-result.json`（三场景机器读数：三项全 true；含 rubricRow、jobStatus）
- `regression-15step-result.json` / `regression-15step-audit.json`

## 5. 合入顺序

总控按 **#27 → #20** 合入 main，并关闭 Issue #23。未自行合并 main。
