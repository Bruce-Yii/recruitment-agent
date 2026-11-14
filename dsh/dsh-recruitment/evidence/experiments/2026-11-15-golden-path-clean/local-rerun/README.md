# 2026-11-15 Golden Path 干净库证据 · `local-rerun`（RERUN）

本目录是 G4-A harness 在**同一个一次性库 `ra_g4_clean`、同一份 SHA 快照**上的**第二次运行（RERUN）**证据。
目的：证明 FIRST_RUN 跑完 S10 之后，同一条命令重跑得到的是**逐跳幂等结果 + 零写入**，而不是把同一份期望值放宽成"两次都算过"。

## 现场

| 项 | 值 |
|---|---|
| 快照 HEAD | `2d987d4d923c90683790ab98b8e115f4983a9b78`（同 FIRST_RUN 快照；`GOLDEN_PATH_HEAD` 显式绑定） |
| 数据库 | 同一个一次性库 `ra_g4_clean`（FIRST_RUN 之后未重建、未清理） |
| 运行模式 | `RERUN`（由 HOP1 `application_action=REUSED` 判定；`GOLDEN_PATH_EXPECT_RUN_MODE=RERUN` 守卫 MATCH） |
| 运行目录 | `run-2026-11-14T20-20-25-061Z/` |
| 退出码 | **0** |
| bootstrap（内置） | `outcome=NO_OP`、`exit_code=0`、`writes={written:false, steps:[]}` |

## 结果（机读见 `run-*/summary.json`，人读见 `run-*/summary.md`）

- 四数：**hops=16 / passed=16 / failed=0 / skipped=0**
- `acceptance.ok = true`
- 终态仍为 `S10`（HOP16 `NO_OP`@S10、`transitions=[]`）
- **全库零写入**：`counts_delta_vs_preflight = {}`，16 跳 row delta 全为 `{}`（含 intake / stage advance / decision / schedule / transcript / scorecard / summarize）
- 逐跳幂等事实：
  - HOP1 `REUSED`（同 candidate+job 复用同一条 ACTIVE 申请，application 行 +0）
  - HOP2/HOP5 `NO_OP`@S10（零迁移）；HOP16 `NO_OP`@S10
  - HOP4/HOP15 `ALREADY_DECIDED/SCOPE_ALREADY_DECIDED`（decision 行 +0）
  - HOP7 `replayed=true`（interview 行 +0）；HOP9 `replayed=true`（transcript_artifact 行 +0）
  - HOP12/HOP13 `replayed=true`（scorecard 行 +0）
- 负例：HOP6 `FORBIDDEN/APPROVAL_NOT_GRANTED`（interview +0）；
  HOP11 面评已存在 → 实际拒绝路径 `ALREADY_SUBMITTED/SCORECARD_ALREADY_SUBMITTED`（业务校验先行），**scorecard 行 +0**。
  实际路径已如实写入 `summary.json` 的 `negative_controls[].reject_path`，没有宽松成"任何失败都行"。
- 一致性视图违规：本申请 **0** 行 / 全租户 **0** 行

## 独立读回

`db-readback.txt` 是在本 RERUN 之后执行的 psql 只读读回（不 import 产品代码；SQL 见 `work/verify-2026-11-15-g4/a/db-readback.sql`）。

## 文件

- `console.log` — 本次运行的完整 stdout/stderr
- `exit-code.txt` / `commands.txt` / `db-readback.txt`
- `run-2026-11-14T20-20-25-061Z/` — 运行目录（`run.log`、`bootstrap.log/json`、`hop-00..hop-17`、`summary.json`、`summary.md`、`run-mode-guard.json`）
- `SHA256SUMS.txt` — 本目录全部文件 sha256
