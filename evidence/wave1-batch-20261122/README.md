# Wave 1 尾巴复验（2026-11-23 · #28 + #29）

## PR

| PR | Head | 结果 |
|---|---|---|
| **#28** `feat/wave1-auto-screening-eval` | `f4fbe70` | 自动初筛摘要已落 task description/result_ref，并在候选人页读回 |
| **#29** `feat/wave1-imap-auto-poll` | `be6912b` | 插件启动挂载轮询；默认关闭；dispose stop |

联调分支：latest main `6f0a9a4` + #28 + #29（无冲突）。

## 门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.41MB）
- `server-typecheck`：0/0
- `runtime-budget`：5051/5051
- `entry-reachability`、`client-contract-check`、`term-lint`：PASS
- 新增/相关单测：**41/41 PASS**（#28 自动初筛 9+读回映射；#29 生命周期 4 + 分岗/轮询 15）
- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0

## 1440 真机

- 新建岗位 → 批准标准：PASS（「已锁定」；psql APPROVED=1）
- 上传新简历（不点「发起初筛评估」）：PASS
  - 申请创建；服务端自动初筛已执行并把摘要持久化到既有 `business_task.description`/`result_ref`；
  - 候选人页直接显示 `canvas-auto-screening` 区块：三态原因、建议标签、“这是只读评估给出的建议，不是录用决定”；
  - decision 前后 **0 → 0**。
- 关闭新岗位：PASS（psql `status=CLOSED`）
- 首页队列正常态：PASS（`app-queue-ops-notice` 不存在）

### 自动初筛本次的真实结论（诚实说明）

新岗位批准标准后仍是 `DRAFT`，自动初筛工具按既有 `GATE_JOB_NOT_OPEN` 规则返回 **NEEDS_REVIEW**：
“岗位尚未开放（DRAFT/PENDING_REVIEW/APPROVED），不该有在途申请”。这不是失败——自动评估确实触发、摘要确实落库/展示，但**没有伪造 criterion 对照**；要让新岗位产出真正的 criteria 评估，产品流程还需要“开放岗位”动作（本批未新增该写入口）。

另：上传任务同时可能被 runtime worker 认领（本次任务状态 `RETRY_WAIT`，worker 竞争），所以摘要额外写入 `description` 兜底；这证明任务竞争不会吞掉 HR 可见的自动初筛结果。

## PR #29 生命周期

- `src/index.ts` 启动路径按 `RECRUITMENT_IMAP_POLL_INTERVAL_MS` 正整数启用；未配置不建 timer/effect/pool；
- dispose 调 `poller.stop()`，清 timer、等在途 tick、关闭懒建 pool；
- 单测：默认关闭不启动 + 配置后 start/cleanup stop（4/4）。

## 证据文件

- `01-job-approved-1440.png`
- `02-resume-uploaded-1440.png`
- `03-auto-screening-candidate-1440.png`（自动初筛区块）
- `04-job-closed-1440.png`
- `05-queue-normal-1440.png`
- `e2e-result.json`（四组校验全 true；含 autoScreeningText/decisionZero）
- `regression-15step-result.json` / `regression-15step-audit.json`
- `build-static-gates.txt` / `unit-tests.txt`

未合并 main；等待总控按 #28 → #29 合入并关闭 Issue #24/#25。
