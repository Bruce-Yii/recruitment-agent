# Golden Path harness（S6 → S10 · 终值 S10 · FIRST_RUN/RERUN）

`run-golden-path-rerun.mjs` 是本仓**唯一**的 Golden Path 端到端 harness 入口：

- 走完 v1.0 的纵向切片 **S6 → S7 → S8 → S9 → S10**（stage-advance contract **v1.3.0** 的四条边）；
- 调用的全是**真实产品工具**（`tool.execute()`）+ **真实 PostgreSQL** + **真实 converter**；
- 16 个写/读/负例跳（hop 1..16；hop 0 = 预检、hop 17 = 终态读回，不计入 16）；
- 同一条命令在同一个库上跑两次：第一次 `FIRST_RUN`（真写），第二次 `RERUN`（逐跳幂等，零写入）；
- 证据写盘并**绑定 SHA**；任何一跳 FAIL 或验收不成立 → 非 0 退出。

> `run-golden-path.mjs` 是 2026-11-14 旧报告 run A/B/C 的原始入口（历史证据的复现入口），**保持不动**。
> 两者关系：同一业务链、同样的闸门；本文件把期望升级到终值 S10，并加了双模式、内置 bootstrap、可配证据根。

## 1. 前置

| 项 | 要求 |
|---|---|
| Node | v24+（原生 TypeScript 类型擦除，直接 import `src/**/*.ts`） |
| PostgreSQL | 17.x，`psql` 在 PATH 或显式给绝对路径 |
| Python | 3.12 + PyMuPDF（converter 用；`RECRUITMENT_PYTHON_BIN` 指定，默认 `D:\Python3.12.9\python.exe`） |
| 依赖 | 仓库 `dsh/dsh-recruitment/node_modules` 已安装（含 `pg`） |
| 数据库 | 一次性库（**不要**用共享演示库 `ra_s6s7`），已按名重放 `db/migrations/0001..0016` |
| bootstrap | harness **内置**跑 `scripts/bootstrap-demo.mjs`（不需要手工补审批） |

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `RECRUITMENT_TEST_DB` | ✅ | harness 自己的**主配置**库名（如 `ra_g4_clean`）。不要用 `RECRUITMENT_DB_NAME` 代替 |
| `RECRUITMENT_TEST_DB_HOST` | 默认 `127.0.0.1` | |
| `RECRUITMENT_TEST_DB_PORT` | 默认 `5432` | |
| `RECRUITMENT_TEST_DB_USER` | 默认 `postgres` | |
| `RECRUITMENT_DB_PASSWORD` | ✅ | 库口令。**只从环境变量读，不落盘、不进日志/证据**（会被产品 `resolveDatabaseConfig` 与 bootstrap 的 scrub 处理） |
| `GOLDEN_PATH_HEAD` | 快照必填 | 绑定的 commit（干净快照没有 `.git` 时必须显式给；不给则回退 `git -C <repo> rev-parse HEAD`；两者都没有 → exit 2） |
| `GOLDEN_PATH_EVIDENCE_DIR` | 推荐 | 证据根（相对路径按 **cwd** 解析）。缺省 `<pkg>/evidence/experiments/2026-11-15-golden-path-clean/`；其下仍建 `run-<UTC stamp>/` |
| `GOLDEN_PATH_EXPECT_RUN_MODE` | 可选守卫 | `FIRST_RUN` / `RERUN`；HOP1 判定出的实际模式不符 → 直接 FAIL（exit 1） |
| `RECRUITMENT_PYTHON_BIN` | 可选 | converter 的 Python 解释器 |
| `GOLDEN_PATH_FIXTURE` | 可选 | 换一份合成 PDF（默认 `fixtures/gp-rerun-2/…pdf`） |
| `GOLDEN_PATH_EMAIL` / `GOLDEN_PATH_PHONE_NORM` | 可选 | 换合成身份时必须与 fixture 内容同步（三处一致） |
| `DEMO_APPROVAL_MODE` | 可选 | 传给内置 bootstrap 的审批替身（默认 `allow-once`；负例可设 `deny`） |

## 3. 干净库一条命令（建库 → 重放 0001→0016 → 跑 harness）

```powershell
# 0) 只读确认不是共享库；这里只创建/清理本 lane 的一次性库名
$env:PGPASSWORD='<本机演示库口令>'          # 不写进任何文件
$psql='D:\12412\PostgreSQL\bin\psql.exe'
& $psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ra_g4_clean"
& $psql -U postgres -h 127.0.0.1 -p 5432 -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ra_g4_clean"
Get-ChildItem db\migrations\*.sql | Sort-Object Name | ForEach-Object {
  & $psql -U postgres -h 127.0.0.1 -p 5432 -d ra_g4_clean -v ON_ERROR_STOP=1 -q -f $_.FullName
  if ($LASTEXITCODE -ne 0) { throw "migration failed: $($_.Name)" }
}

# 1) FIRST_RUN（干净库上的第一次；内置 bootstrap 会补 demo 审批）
$env:GOLDEN_PATH_HEAD='<snapshot commit>'
$env:GOLDEN_PATH_EVIDENCE_DIR='<repo>\dsh\dsh-recruitment\evidence\experiments\2026-11-15-golden-path-clean\local-first-run'
$env:GOLDEN_PATH_EXPECT_RUN_MODE='FIRST_RUN'
$env:RECRUITMENT_TEST_DB='ra_g4_clean'
$env:RECRUITMENT_PYTHON_BIN='D:\Python3.12.9\python.exe'
node dsh\dsh-recruitment\manual\golden-path\run-golden-path-rerun.mjs

# 2) RERUN（同一个库、同一份快照；期望逐跳幂等、零写入）
$env:GOLDEN_PATH_EVIDENCE_DIR='<repo>\dsh\dsh-recruitment\evidence\experiments\2026-11-15-golden-path-clean\local-rerun'
$env:GOLDEN_PATH_EXPECT_RUN_MODE='RERUN'
node dsh\dsh-recruitment\manual\golden-path\run-golden-path-rerun.mjs
```

两次都必须 **exit 0**，且 `summary.json` 里
`counts={hops:16,passed:16,failed:0,skipped:0}`、`acceptance.ok=true`。

## 4. FIRST_RUN / RERUN 语义（每跳期望）

`RUN_MODE` 由 **HOP1 的库内事实**决定，不由入口脚本猜：
`application_action=CREATED → FIRST_RUN`；`REUSED → RERUN`；其它 → FAIL。

| hop | 工具 | FIRST_RUN 期望 | RERUN 期望（幂等） |
|---:|---|---|---|
| 1 | application_intake | `CREATED` + application 行 +1 + application_id/resume_version_id | `REUSED` + application 行 +0（同 candidate+job 复用） |
| 2 | stage_advance (T1) | `ADVANCED` 逐字 `[{S6→S7}]`，stage=S7 | `NO_OP`@S10，transitions=[] |
| 3 | screening_evaluate | `OK` + verdict 字符串 | 同左（只读） |
| 4 | decision_record(SCREENING) | `ok=true` + decision 行 +1 | `ALREADY_DECIDED` + decision 行 +0 |
| 5 | stage_advance (T2) | `ADVANCED` 逐字 `[{S7→S8}]`，stage=S8 | `NO_OP`@S10 |
| 6 | interview_schedule（deny 负例） | `FORBIDDEN/APPROVAL_NOT_GRANTED` + interview 行 +0 | 同左 |
| 7 | interview_schedule（allow-once） | `ok=true`、`replayed=false`、有 interview id、interview 行 +1 | `ok=true`、`replayed=true`、能读到既有 interview、行 +0 |
| 8 | interview_get | `ok=true` | 同左 |
| 9 | transcript_import | `ok=true`、`replayed=false`、artifact 行 +1 | `ok=true`、`replayed=true`、artifact 行 +0 |
| 10 | transcript_read | `ok=true`、`transcript.state=READY` | 同左 |
| 11 | scorecard_submit（deny 负例） | `FORBIDDEN/APPROVAL_NOT_GRANTED` + scorecard 行 +0 | 面评已存在 → 业务校验先拒（`ALREADY_SUBMITTED`），仍**零写入**；实际拒绝路径记入 `summary.negative_controls[].reject_path` |
| 12 | scorecard_submit（103） | `ok=true`、`replayed=false`、scorecard id、行 +1 | `ok=true`、`replayed=true`、行 +0 |
| 13 | scorecard_submit（104） | 同上 | 同上 |
| 14 | evaluation_summarize | `ok=true` + `summary_digest` | 同左（读同一批已提交面评） |
| 15 | decision_record(STAGE) | `ok=true` + decision 行 +1 | `ALREADY_DECIDED` + decision 行 +0 |
| 16 | stage_advance（终跳） | `ADVANCED` 逐字 `[{S8→S9},{S9→S10}]`、stage=**S10** | `NO_OP`@S10、transitions=[] |

> **终值 S10**：HOP16 一次调用走完 S8→S9（canonical READY 转写）与 S9→S10（材料可用 + ≥1 份 SUBMITTED 面评）。
> `S10` 是 `stage_catalog.in_v1_scope` 的最后一格：不发明 S11、不倒退、不跳阶。
> 旧版"梯子终值=S8"的断言/文案已全部删除。

## 5. 产物清单（每个 `run-<UTC stamp>/`）

| 文件 | 内容 |
|---|---|
| `run.log` | 全过程人读日志（含每跳 request/result/readback/row delta） |
| `bootstrap.log` / `bootstrap.json` | 内置 bootstrap 的 stdout/stderr、末行 `BOOTSTRAP_RESULT` JSON、脚本 sha256 |
| `fixture.json` / `fixture-synthetic-resume-golden-path.pdf` | 合成简历的 path/sha256/bytes 与副本 |
| `hop-00-preflight.json` | 库/迁移/岗位/rubric/actor/行数预检 |
| `hop-01..hop-16-*.json` | 每跳的 request、result/error、row_counts_before/after、delta、readback、run_mode、expect_note、outcome |
| `hop-17-final-state.json` | 终态读回（申请/决策/面试/转写/面评/一致性视图/行数） |
| `summary.json` | 机器可读总账：repository(head/head_source/worktree_state)、harness sha256、fixture、bootstrap、database、run_mode、hops、**四数** counts{hops,passed,failed,skipped}、negative_controls、failures、final_state、acceptance |
| `summary.md` | 同内容人读版（逐跳表 + 四数 + 终态 + acceptance） |
| `run-mode-guard.json` | 仅当设置了 `GOLDEN_PATH_EXPECT_RUN_MODE` 时出现 |

## 6. 退出码

| 码 | 含义 |
|---:|---|
| `0` | 16 跳全 PASS 且 `acceptance.ok=true` |
| `1` | 有 hop FAIL / acceptance 不成立（含终态不是 S10、视图有违规、无 SUBMITTED 面评、负例没被拒） |
| `2` | 配置缺失 / 证据绑不到 SHA / 内置 bootstrap 非 0 或解析不到 `BOOTSTRAP_RESULT`（fail closed） |

## 7. 边界（不许越）

- **合成数据**：fixture 是合成的「林承宇」简历；不碰任何真实候选人 / 简历 / 会议原文（R7）。
- **标签诚实**：全部数据 `provenance=FIXTURE`；工具若把 fixture 标成 `LIVE`，按 R4 记为工具缺陷。
- **不放宽闸门**：allow-once / deny 只替代"人"，闸门本身照常调用；D-95 v2（IN_CHAT + 逐字 confirmation_text + 服务端 hash）不绕。
- **写只经工具**：`pg` 只做 SELECT 读回与行数统计；不手工 UPDATE、不手工补钉 rubric、不跳校验。
- **git 只读**：harness 最多 `git rev-parse` / `git status --porcelain`，绝不写 git。
- **证据绑 SHA**：没有 `GOLDEN_PATH_HEAD` 也没有 git HEAD → exit 2，不允许产出无 SHA 证据。
- **不改默认库**：路径/库名/证据根都从环境变量来；共享库（`ra_s6s7` 等）只读，绝不写。
