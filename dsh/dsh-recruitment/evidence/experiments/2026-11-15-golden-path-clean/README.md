# 2026-11-15 Golden Path 干净库证据（S6 → S10 · 终值 S10 · FIRST_RUN + RERUN）

> **身份**：Owner lane `owner-g4`（实现复核指令 **G4**：Golden Path harness + CI job）。
> 实现由两个并发子代理完成：A = harness（`work/verify-2026-11-15-g4/a/`），B = CI job + 独立复跑（`work/verify-2026-11-15-g4/b/`）；
> Owner 只写本 README / commands / 验收报告，并做**独立 psql 读回**（`work/verify-2026-11-15-g4/owner/independent-readback.sql`）。
>
> **纪律**：不接受自述；结论只来自本次现场执行的命令 + 真实输出 + 独立 DB 读回。
> **R7**：简历/转写全部为合成 fixture；日志只出现 id / 哈希 / 计数 / 打码值。**共享库 `ra_s6s7` 未被写入**。
> **未 commit / 未 push**（git 写只有总控做）；证据绑定见 §2。

---

## 0. 一句话结论

**干净库（0001→0016 重放后）上一次 harness 命令即可跑通 S6→S10**：内置 bootstrap 补 demo 审批 →
HOP16 一次调用完成 `S8→S9→S10`（canonical READY 转写 + ≥1 SUBMITTED 面评）→
**终态 `application.current_stage_code = S10`**。
同一库上**再跑一次**是逐跳幂等：**16/16 PASS、全库零写入**（`counts_delta_vs_preflight={}`）。
两次都有 `summary.json` + 四数；一致性视图 `v_application_stage_consistency` **0 违规**。

| 运行 | run_mode | exit | 四数（hops/passed/failed/skipped） | 终态 | HOP16 | SUBMITTED 面评 | 视图违规（本申请/全租户） |
|---|---|---:|---|---|---|---:|---|
| `local-first-run/run-2026-11-14T20-20-03-842Z` | **FIRST_RUN** | 0 | **16 / 16 / 0 / 0** | **S10** | `ADVANCED` `[{S8→S9},{S9→S10}]` | 2 | 0 / 0 |
| `local-rerun/run-2026-11-14T20-20-25-061Z` | **RERUN** | 0 | **16 / 16 / 0 / 0** | **S10** | `NO_OP` `[]` | 2 | 0 / 0 |

`acceptance.ok = true`（两次运行的五条验收：`all_hops_pass / stage_s10 / submitted_scorecards_ge_1 /
consistency_view_zero_violations / negative_controls_blocked` 全 true）。

---

## 1. 现场（谁、在哪、用什么跑）

| 项 | 值 |
|---|---|
| 证据基线（快照） | **`2d987d4d923c90683790ab98b8e115f4983a9b78`**（`git archive` 导出的干净快照 + 本 lane harness overlay；快照没有 `.git`，用 `GOLDEN_PATH_HEAD` 绑定） |
| 写本 README 时仓库 HEAD | `c06b3466a6efa822ea0ab30ed8cbde2aae7ea37e`；`git diff 2d987d4..HEAD -- src db/migrations contracts dsh/dsh-recruitment/src dsh/dsh-recruitment/converter converter scripts .github` = **空**（基线之后只有 docs / profile / README 的提交，产品代码未变） |
| 快照方式 | `git archive --format=tar 2d987d4…` → `%TEMP%\g4-snapshot-2d987d4`（archive sha256 `8fd214b9f5748de96f18c380f6b10be5247f7dcd1df463cac4b3127cfb2d51de`，18,421,760 bytes）；`node_modules` 用 Junction 指回仓库；`manual/golden-path/**` 从工作树 overlay（见 §2 的 overlay sha） |
| 数据库 | **一次性干净库 `ra_g4_clean`**（`DROP`→`CREATE`→按名重放 `db/migrations/0001..0016`）。共享库 `ra_s6s7` 只读、**未触碰** |
| 运行 | Node v24.16.0 · PostgreSQL 17.11 · Python 3.12.9 + PyMuPDF；真实产品工具 `tool.execute()` + 真实 converter；写只经工具，`pg` 只做 SELECT 读回 |
| 时间 | 2026-11-15 04:20 (+08)，同一分钟内连续两次（BAR 见各 run dir 的 `run.log` / `bootstrap.log`） |
| 独立复跑（B） | 另一库 `ra_g4_ci_replay`、同一快照 + A 终版 overlay：显式 bootstrap → FIRST_RUN → RERUN 全 exit 0（`independent-recheck/`） |

> **不伪造 LIVE**：本证据全部为合成 fixture，工具标签是 `FIXTURE / MANUAL / NOT_CONNECTED`。
> **不是 L1 宿主可达性**：harness 直接构造产品工具对象并 `execute()`（与 2026-11-14 旧报告同口径）；
> DSH 会话/HTTP 的 L1 证据由 reviewer 的 `verify-l1` lane 单独提供，本证据不冒充。

---

## 2. SHA 绑定（本证据对应哪份代码）

| 文件 | Git 内容 id（blob，LF 规范化） | 本地运行字节 sha256（CRLF 工作树/overlay） | 备注 |
|---|---|---|---|
| `dsh/dsh-recruitment/manual/golden-path/run-golden-path-rerun.mjs` | `0a0ae4b07203d348bdca04c8d1fd34c9356bad66` | `fb1061cd3683e05f6b026e9558de5bf0ced646e8a9b4c7036f5a4f03df0e257e` | 本次运行的 harness；`summary.harness.sha256` 记录的是**运行字节**（CRLF） |
| `dsh/dsh-recruitment/manual/golden-path/README.md` | `bd2239dd1bec89422e2250af15df5a5c5ea669df` | `69bd26961489ae6ed63dd7cdf5c20efa7bdeba00573b3b0920e591ace365df4f` | 用法/双模式/产物说明 |
| `.github/workflows/ci.yml` | `a52b2975c4c4bece48d593a0ac5b9742a54f7277` | `15bec83dd88025e68f2502d6ca0f9796da58aed4f2a4d36df2e4c4479fc3f2de` | 新增 `golden-path` job（+253 行 append-only） |
| `scripts/bootstrap-demo.mjs`（G5，内置调用） | `5171d773aaf8d854761f93c9bf7b63a4e6c91e83`（= `2d987d4:scripts/bootstrap-demo.mjs`） | 快照字节 `65e05b0bcc95d1e6dfd489c5ef5ebcea9546e228d6c237f26707f860f692b5cc` | `summary.bootstrap.sha256` 记录的是快照字节 |
| 合成 fixture `fixtures/gp-rerun-2/synthetic-resume-golden-path.pdf` | —（二进制） | `aa2f4645c7535bd83fbc3e8066ac628051adaefc0ed236e4ee7e9695905252df`（10,919 bytes） | 与旧 evidence 的 gp8 fixture 同一份 |

> 为什么有两种 hash：本机 `core.autocrlf=true`，工作树是 CRLF、`git archive`/commit 是 LF。
> 因此同一文件「仓库内容 id」与「本地运行字节 sha256」不同。**`MANIFEST.sha256` 记录的是本目录文件在生成时的
> 工作树字节**（Node 写出的 JSON/日志本身是 LF；PowerShell 重定向写出的少量 `.txt/.log` 是 CRLF）——
> 在同一份 checkout 上重算可复现；跨平台/重新 checkout 后换行策略可能不同，须以该 checkout 的字节为准。
> harness 的「运行字节」以各 run 的 `summary.json` 为准；在 CI（Linux checkout）上 harness 会按 checkout 字节
> 重算自己的 sha256 并写进那一轮的 summary。

**逐文件清单**：`MANIFEST.sha256`（本目录，相对路径排序，`<sha256>  <path>`）；条目数/自身 sha256 见 `independent-recheck/verify.txt`
与 `work/verify-2026-11-15-g4/REPORT.md`。

---

## 3. 目录结构

```
2026-11-15-golden-path-clean/
├── README.md                     # 本文件（owner）
├── commands.txt                  # 复现命令原文（owner 汇总，口令脱敏）
├── MANIFEST.sha256               # 证据目录逐文件 sha256（B 生成）
├── local-first-run/              # A：干净库 FIRST_RUN（exit 0）
│   ├── README.md · commands.txt · console.log · exit-code.txt · db-readback.txt · SHA256SUMS.txt
│   └── run-2026-11-14T20-20-03-842Z/   # run.log / bootstrap.log+json / fixture / hop-00..17 / summary.json|md / run-mode-guard.json
├── local-rerun/                  # A：同库 RERUN（exit 0，逐跳幂等）
│   ├── README.md · commands.txt · console.log · exit-code.txt · db-readback.txt · SHA256SUMS.txt
│   └── run-2026-11-14T20-20-25-061Z/
└── independent-recheck/          # B：另一干净库的 CI 等价复跑 + 独立 psql 读回 + 与 A 对账
```

每个 `run-*/` 的机器可读总账是 `summary.json`（含 `counts` 四数、`run_mode`、`repository.head`、
`acceptance`、`final_state`）；人读版是 `summary.md`。

---

## 4. 验收对照（G4 任务书）

| # | 验收要求 | 证据 | 结论 |
|---|---|---|---|
| 1 | 干净库一条命令跑 S6→S10 | `local-first-run/`：迁移后只执行 `node …run-golden-path-rerun.mjs`（bootstrap 已内置），exit 0 | ✅ |
| 2 | 阶段读回 S10 | `summary.final_state.application_stage=S10`；独立 psql 读回 `current_stage_code=S10`；4 条 `application.current_stage_code.changed` 事件（S6→S7→S8→S9→S10） | ✅ |
| 3 | ≥1 SUBMITTED 面评 | `summary.final_state.submitted_scorecard_count=2`；psql 读回 2 行 `SUBMITTED` | ✅ |
| 4 | 一致性视图 0 违规 | `summary.final_state.consistency_view_violations_all=0`；psql `select count(*) from recruitment.v_application_stage_consistency` = 0 | ✅ |
| 5 | "16 跳 PASS 且阶段 S10"可复现 | 两次运行均 `16/16/0/0` + S10；B 在另一个干净库上复跑同结果 | ✅ |
| 6 | 产物含 summary + 四数 | 每轮 `summary.json`（`counts{hops,passed,failed,skipped}`）+ `summary.md` | ✅ |
| 7 | 证据绑 SHA | §2 表 + 每轮 `summary.repository.head=2d987d4…`（`head_source=env:GOLDEN_PATH_HEAD`、`worktree_state=snapshot`） | ✅ |
| 8 | run_mode=FIRST_RUN/RERUN | 由 HOP1 `application_action` 判定（CREATED/REUSED），另加 `GOLDEN_PATH_EXPECT_RUN_MODE` 守卫与负例（守卫不符 exit 1） | ✅ |
| 9 | CI job（干净库 green） | `.github/workflows/ci.yml` 新增 `golden-path` job；**本地 CI 等价复跑 green**（B） | ⚠️ 远端 CI run 未执行（lane 禁 push，见 §7） |
| 10 | 不放宽闸门/断言 | 负例 HOP6/HOP11 仍 `FORBIDDEN/APPROVAL_NOT_GRANTED`（FIRST_RUN）零写入；RERUN 的 HOP11 是 `ALREADY_SUBMITTED` 业务拒绝零写入并如实记录路径；未改 `src/**` | ✅ |

---

## 5. 六层证据（适用层）

| 层 | 本证据提供什么 | 局限 |
|---|---|---|
| **L1 可达性** | 产品工具对象 `execute()` 全链（真实 PG + 真实 converter）；CI job 从干净 checkout 跑同一入口 | **不是** DSH 宿主会话/HTTP 路由；L1 由 reviewer 的 `verify-l1` lane 提供 |
| **L2 业务真相** | psql 独立读回（不 import 产品代码）：申请/决策/面试/面评/转写/事件/视图，见 `independent-recheck/` 与 `work/verify-2026-11-15-g4/owner/` | — |
| **L3 外部事实** | fixture sha256 固定；转写 `provenance=FIXTURE / MANUAL / NOT_CONNECTED`（未冒充 LIVE）；两次读回 sha 一致 | 未接真实外部会议（按 R4 诚实标注） |
| **L4 人的判断** | approval seam `allow-once`/`deny` 替身**只替人、不替闸门**；D-95 IN_CHAT 逐字原话 + 服务端 hash | 不是真人点击（L4 的"人真的点过"在真宿主场景由 reviewer 验） |
| **L5 反证** | HOP6/HOP11 deny → `FORBIDDEN` 且行数 +0；RERUN 逐跳零写入（delta={}）；RUN_MODE 守卫不符 → exit 1 且零业务写入 | — |
| **L6 机检** | CI job 的 summary 机检（四数/终态/视图）+ psql `DO $$` 断言块；本地同脚本对 A/B 两套证据跑过 | 远端 Actions 未跑（见 §7） |

---

## 6. 复现

见 `commands.txt`（owner 汇总）与 `local-first-run/commands.txt`、`local-rerun/commands.txt`（A 的原始命令）。
最短路径（Linux/macOS CI 环境；Windows 把 `psql` 换成绝对路径即可）：

```bash
# 1) 干净库 + 迁移（一次性库；绝不要用共享库）
createdb ra_golden_path
for f in $(ls db/migrations/*.sql | sort); do psql -v ON_ERROR_STOP=1 -q -f "$f"; done
# 2) 一条命令（内置 bootstrap）→ FIRST_RUN
GOLDEN_PATH_EVIDENCE_DIR="$PWD/golden-path-evidence/first-run" \
GOLDEN_PATH_EXPECT_RUN_MODE=FIRST_RUN GOLDEN_PATH_HEAD="$(git rev-parse HEAD)" \
RECRUITMENT_TEST_DB=ra_golden_path RECRUITMENT_DB_PASSWORD=*** \
node dsh/dsh-recruitment/manual/golden-path/run-golden-path-rerun.mjs
# 3) 同一库再跑一次 → RERUN（期望逐跳幂等、零写入）
GOLDEN_PATH_EVIDENCE_DIR="$PWD/golden-path-evidence/rerun" \
GOLDEN_PATH_EXPECT_RUN_MODE=RERUN GOLDEN_PATH_HEAD="$(git rev-parse HEAD)" \
RECRUITMENT_TEST_DB=ra_golden_path RECRUITMENT_DB_PASSWORD=*** \
node dsh/dsh-recruitment/manual/golden-path/run-golden-path-rerun.mjs
```

两次都 `exit 0`；检查 `summary.json` 的 `counts={16,16,0,0}`、`acceptance.ok=true`、
`final_state.application_stage='S10'`、`final_state.consistency_view_violations_all=0`。

---

## 7. 未做 / 限制（如实）

1. **远端 GitHub Actions 未跑**：lane 禁止 git push，而 workflow 只能跑已推送的提交 → 无法在本 lane 触发真实 CI run。
   CI job 已通过（a）YAML 结构校验 + 既有 job 等价校验 + 全部 `run:` 块 `bash -n`；（b）在本地一次性库上
   **逐 step 等价复跑** green（`independent-recheck/`）。**真正的 CI run 需由总控提交+推送后 `gh workflow run CI` 验证**。
2. **证据基线是 `2d987d4`**（产品代码与当前 HEAD 等价，见 §1）；之后其它 lane 的**未提交**改动不在本证据内
   （这是干净快照的目的）。总控合并后的最终 commit 上，CI 会重新产出绑定该 commit 的 summary。
3. `evidence/experiments/INDEX.json` 的登记与 `docs/18` 口径回抄不在本 lane 写范围（需集成者登记）。
4. 运行日志中包含**运行机本地绝对路径**（快照目录等）；它们不是凭据/个人信息，是复现所需的现场事实
   （与仓库既有 evidence 的记录口径一致），未写入任何产品配置或 profile。
5. RERUN 的 HOP11 只证明"面评已存在时业务拒绝且零写入"，**不再重复证明** D-79 闸门本身；闸门证明由 FIRST_RUN 的
   HOP11（`FORBIDDEN/APPROVAL_NOT_GRANTED`）提供。
