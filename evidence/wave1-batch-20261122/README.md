# Wave 1 并行批次联调（2026-11-22）

## 三条服务端 PR

| Lane | Issue | PR | Head | 状态 |
|---|---|---|---|---|
| 1 | #23 | **#27** | `f6b8476` | OPEN / MERGEABLE；独立复核 11/11 测试通过 |
| 2 | #24 / G-01 | **#28** | `16623b9` | OPEN / MERGEABLE；新增 9/9 单测通过 |
| 3 | #25 / G-02 | **#29** | `e84eb00` | OPEN / MERGEABLE；新增 15/15 单测通过 |

联调分支：`tmp/wave1-batch` = latest main（`9581dde`）+ #27 + #28 + #29 + PR #20（`9e95cdb`）+ PR #26（`b0e35400`），五路合并无冲突。

## 门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.40MB）
- `server-typecheck`：0/0
- `runtime-budget`：5051/5051
- `entry-reachability`、`client-contract-check`、`term-lint`：PASS
- 新增单测：Lane1 11/11、Lane2 9/9、Lane3 15/15；全量 unit **2058 tests / 2054 pass / 0 fail / 4 原有 skip**
- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0

## 1440 真机（一次性干净库 + HY4）

| 场景 | 结果 |
|---|---|
| ① 新建岗位 → 批准标准 | PASS：新建岗位成功 → 岗位标准 Tab → 批准 → 「已锁定」；psql rubric APPROVED 计数 1 |
| ① 上传新简历 → 自动初筛 | PASS（流程）：在「候选人漏斗」Tab 通过 CDP 真上传合成 PDF；未点击任何「发起初筛评估」；申请创建、`RESUME_PARSE` 任务 `SUCCEEDED`；decision 前后均为 0。自动评估的触发/跳过/失败隔离由 Lane2 的 9 个单测与接线顺序断言覆盖；由于 `screening_evaluate` 本身只读不落库，UI 无新增持久化评估结果（Issue #24 既有口径）。 |
| ① 关闭新岗位 | PASS：`canvas-action-job-close` → `canvas-job-close-submit` → 「已关闭岗位」；psql `status=CLOSED` |
| ② 首页队列正常态 | PASS：`app-queue-ops-notice` 不存在（无噪音）；15 步回归 15/15 |

## 证据文件

- `01-job-approved-1440.png`
- `02-resume-uploaded-1440.png`
- `03-auto-screening-candidate-1440.png`
- `04-job-closed-1440.png`
- `05-queue-normal-1440.png`
- `e2e-result.json`（四组机器读数全 true）
- `regression-15step-result.json` / `regression-15step-audit.json`
- `build-static-gates.txt` / `unit-tests.txt`

## 已知边界（合入前请总控确认）

1. **G-01 的自动评估目前是后端只读执行**：不落 decision、无新增业务表，因此 HR 打开候选页只看到既有“岗位标准对照”，看不到“自动评估已完成”的持久化标记；若要 UI 明示，需要另开读模型/写链路任务（本批严格未越界）。
2. **G-02 的轮询器已提供 `createImapPoller` / `listOpenJobs` / `makeJobResolver` API 与默认关闭的 env 控制**，但插件启动挂载（env 开启、水位持久化、每轮查 OPEN 岗位并 start/stop）仍需接线层调用；本 PR 只改 `connectors/mail/**`，未改 `src/index.ts`，因此“后台自动跑”尚未在宿主启动时真正开始，属于接线缺口而非本连接器 API 缺陷。
3. 未自行合并 main；建议总控按 #27 → #28 → #29 → #20 → #26 顺序合入，并决定是否先补 G-02 接线任务。
