# 2026-11-15 Golden Path 干净库证据 · `local-first-run`（FIRST_RUN）

本目录是本 lane（G4-A harness）在**一次性干净库 + 干净 SHA 快照**上跑 Golden Path harness 的
**第一次运行（FIRST_RUN）**证据。harness = `dsh/dsh-recruitment/manual/golden-path/run-golden-path-rerun.mjs`。

## 现场

| 项 | 值 |
|---|---|
| 仓库基线与快照 HEAD | `2d987d4d923c90683790ab98b8e115f4983a9b78`（`git archive` 导出快照 + 工作树 harness overlay；详见 `work/verify-2026-11-15-g4/a/SNAPSHOT.txt`） |
| 数据库 | 一次性库 `ra_g4_clean`（`DROP`→`CREATE`→按名重放 `db/migrations/0001..0016`，16 条迁移）；共享库 `ra_s6s7` **未触碰** |
| 运行模式 | `FIRST_RUN`（由 HOP1 `application_action=CREATED` 判定；`GOLDEN_PATH_EXPECT_RUN_MODE=FIRST_RUN` 守卫 MATCH） |
| 证据根 | 本目录（`GOLDEN_PATH_EVIDENCE_DIR`）；运行目录 `run-2026-11-14T20-20-03-842Z/` |
| 退出码 | **0** |
| bootstrap（内置） | `outcome=BOOTSTRAPPED`、`exit_code=0`、`writes={written:true, steps:[recruitment_job_update, recruitment_job_rubric_approve]}` |

## 结果（机读见 `run-*/summary.json`，人读见 `run-*/summary.md`）

- 四数：**hops=16 / passed=16 / failed=0 / skipped=0**
- `acceptance.ok = true`（all_hops_pass / stage_s10 / submitted_scorecards_ge_1 / consistency_view_zero_violations / negative_controls_blocked 全 true）
- 终态 `application.current_stage_code = **S10**`（v1.0 终态）
- HOP16 一次调用两条边：`transitions = [{"from":"S8","to":"S9"},{"from":"S9","to":"S10"}]`、`status=ADVANCED`
- SUBMITTED 面评（现行）= **2** 份（两位 required_scorecard 面试官各 1 份）
- `recruitment.v_application_stage_consistency` 违规：本申请 **0** 行 / 全租户 **0** 行（0 行 = 合规）
- stage 变更事件：S6→S7 / S7→S8 / S8→S9 / S9→S10 各 1 条
- 负例：HOP6 `FORBIDDEN/APPROVAL_NOT_GRANTED`（interview +0）、HOP11 `FORBIDDEN/APPROVAL_NOT_GRANTED`（scorecard +0）

## 独立读回

`db-readback.txt` 是**不 import 产品代码**的 psql 只读读回（SQL 见 `work/verify-2026-11-15-g4/a/db-readback.sql`）。
它在两次运行之后执行，但 RERUN 全程零写入（其 summary 的 `counts_delta_vs_preflight={}`、16 跳 row delta 全为 `{}`），
所以这些阶段/决策/面试/转写/面评事实就是本次 FIRST_RUN 写出的终态。

## 文件

- `console.log` — 本次运行的完整 stdout/stderr（原始控制台输出）
- `exit-code.txt` — 退出码 / run_dir / run_mode
- `commands.txt` — 命令原文（口令脱敏）
- `db-readback.txt` — psql 独立只读读回
- `run-2026-11-14T20-20-03-842Z/` — 运行目录（`run.log`、`bootstrap.log/json`、`fixture.json`、`hop-00..hop-17`、`summary.json`、`summary.md`、`run-mode-guard.json`）
- `SHA256SUMS.txt` — 本目录全部文件 sha256

## 备注（第一次尝试的失败现场，未混入本证据）

首次运行时 HOP3 报 `NO_RUBRIC/NO_APPROVED_RUBRIC`：内置 bootstrap 本次**刚**写入 rubric 审批
（`decided_at≈运行时刻`），而旧版 harness 的 `as_of = now-5s` 落在审批之前 → `approved(v, as_of)` 判为未批准。
这是 `as_of` 语义的**正确行为**，不是产品缺陷；已把 `screening_evaluate` / `summarize` / `SCREENING decision`
的 `as_of` 改为"现在"（`toOffsetIso()`，截到秒、不晚于 server now），并在干净库上重跑。
失败现场（含 hop JSON 与 console.log）保存在 `work/verify-2026-11-15-g4/a/debug/first-attempt-1-failed/`。
