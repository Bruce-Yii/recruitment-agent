# CI 本机复演 · 原始日志集（2026-11-14）

> **历史实验，按当时口径记录。** 本 README 是 2026-11-14 21:40 事后补写的入口说明，
> 内容只依据本目录 `logs/` 的**原始输出**与 `.github/workflows/ci.yml` 的步骤定义；
> 没有把今天的结论/今天的测试数硬塞进"当时结论"里。
>
> **口径日期**：2026-11-14 16:55–17:04 +08:00（workspace 临时副本 `ci-rehearsal-2026-11-14` 创建于 16:55，
> `logs/` 文件 mtime 16:59–17:04）。**当时 HEAD**：以临时副本快照为准（本目录日志未记录 SHA；
> 同一天的深度分析见 `../2026-11-14-ci-rehearsal-2/`，那份记录了快照与差异点）。
>
> **R7 自检**：对 `logs/` 全量扫描 11 位手机号 **0 命中**、email 形态 **0 命中**（2026-11-14 21:37 实测）。

---

## 1. 这份实验做了什么

分支 `feat/unified-document-intake` **从未 push**，GitHub Actions 没有本分支运行记录（后续
`ci-rehearsal-2` 的 D11 也确认这点）。所以在拿到 CI 结论之前，先在本机把 `.github/workflows/ci.yml`
的各个 job 按 **等价环境** 逐步跑一遍，把每一步 stdout 原样落盘，回答一个问题：
**"这些 CI 步骤在本机等价的 Python/Node/PG 环境里，会不会第一步就红？"**

做法：

1. 把仓库导出到**临时副本**（`D:\12412\dsh工作区\temp\ci-rehearsal-2026-11-14\repo`，workspace temp，
   按设计不入库，现已不保证还在）；
2. 用 `.github/workflows/ci.yml` 的 step 命令（下表 file:line）逐条执行；
3. stdout/stderr 重定向到本目录 `logs/<job>__<step>__<slug>.log`。

**命令原文**不在本目录（当时没存调用脚本），但每个 log 对应的 CI 命令可从
`\.github/workflows/ci.yml` 的 step 原文逐字取用（下表给出 `ci.yml` 行号）。

---

## 2. 逐步结果（只按日志原文判读）

| log | 对应 CI 步骤（file:line） | 真实结果（日志原文/判据） |
|---|---|---|
| `logs/compile__03__install-converter-dependencies.log` | `ci.yml:28-33` Install converter dependencies | 只有 pip 的 `--no-warn-script-location` 警告（2 行），无错误行。**判据注意**：本目录没有 exit 码记录，PASS 判据是"日志无错误"，不是退出码 |
| `logs/compile__04__compile-converter-src.log` | `ci.yml:34-35` `python -m compileall -q converter/src` | **0 字节**（`-q` 静默成功；空日志不能单独证明成功，只能作为旁证） |
| `logs/compile__05__corpus-manifests-must-be-portable.log` | `ci.yml:37-47` | `corpus manifests contain no machine-absolute paths`（1 行）。⚠️ 后续 `ci-rehearsal-2` D2 证明该守卫**只扫 `*.jsonl`**，漏掉 `batch2-picked.json` 里的机器路径 |
| `logs/compile__06__report-acceptance-test-availability.log` | `ci.yml:48-58` | `::notice title=Corpus acceptance NOT RUN::…`——语料原件按设计不入库，acceptance job 未跑。**compile 绿 ≠ 验收证据** |
| `logs/db__02__apply-migrations-0001-0006.log` | `ci.yml:198-205`（本机实际应用到 `0010`） | 10 段 `== 0001_init … == 0010_migration_ledger` 全部走完；无 `ERROR:` 行（大量 `NOTICE` 属正常） |
| `logs/db__03__verify-every-migration.log` | `ci.yml:206-217` | `== verify-0003 … == verify-0010` 共 8 段；正文含大量 `NOTICE: … PASS`；末行 `VERIFY PASS：结构断言 + 状态机覆盖 + 对象覆盖 + 32 条负向测试全部通过`（只有 1 条汇总行，逐迁移的 PASS 是 NOTICE 形态） |
| `logs/db__04__migration-lifecycle-fresh-upgrade-re-run.log` | `ci.yml:218-272` | fresh/upgrade/re-run 三段执行完；末行 `ledger matches files` + `migration lifecycle OK`。**⚠️ 这条 PASS 后来被 `ci-rehearsal-2` D3 推翻**：`diff … && echo` 没有 `exit 1`，本机 CRLF 导致 diff 报 11 行差异仍打印 OK → **假绿，日志本身不能证明台账一致** |
| `logs/plugin__06__run-plugin-tests.log` | `ci.yml:151-169` `node test/run-all.mjs` | **`tests 865 / pass 865 / fail 0 / skipped 0`**（duration 49.6s，exit 无记录但 summary 干净） |
| `logs/plugin__06__run-plugin-tests.raw.log` | 同一 suite 的**原始首跑** | **`tests 865 / pass 660 / fail 205 / skipped 0`**；失败栈全部是 `28P01 用户 "postgres" Password 认证失败`，且日志含 **203 处** `temp\ci-rehearsal-2026-11-14\repo` 路径（在同一临时副本里跑的）。→ **失败原因是本机 DB 凭据未注入，不是产品缺陷**；上面的 clean 日志是修正环境后的复跑 |
| `logs/python-lanes__04__apply-0001-0003-for-the-review-lane.log` | `ci.yml:308-314` | `psql` 依次应用 0001→0003，只有 `NOTICE`（触发器不存在跳过属正常）。**没有独立 exit 码/成功行**，只能算"命令跑完未见错"，不能当 PASS 的充分证据 |

文件级 sha256 / 字节数：见同目录 `FILES.sha256`（10 个文件，逐条 `sha256  字节数  相对路径`）。

---

## 3. 当时结论（2026-11-14 17:04，只作历史口径）

1. **能跑通的部分**：compile 4 步、db apply/verify/lifecycle 3 步、plugin 测试在**注入正确 DB 凭据后**为
   `865/865/0/0`、python-lanes 的 0001–0003 应用未见错 → 这批 CI 步骤在本机等价环境**不会因为环境缺失而红**
   （除原始首跑证明"缺凭据会红"）。
2. **按设计不跑的部分**：corpus acceptance（原件不入库）、CI service 容器/actions（无法本机复演）。
3. **不能当 CI 证据**：分支从未 push，GH Actions 无本分支 run —— 这是**本机复演**，不是 CI 结果。
4. **已知假绿**：`migration lifecycle OK`（见上表，后被 D3 推翻）。

---

## 4. 现在（2026-11-14 21:40）是否仍成立

| 当时结论 | 现在 | 依据 |
|---|---|---|
| plugin 测试 `865/865/0/0` | **只作历史**：当前树测试数已不同（本审计 21:07 全量 `1211/1211/0/0`） | `work/review/e1-e4-audit/test-run-full-2107.log` |
| compile/db 步骤"本机等价环境能跑" | **未重跑，不继承**：日志来自临时副本，当前 HEAD 已前进（21:36 见 `da2c549`） | 本目录日志 mtime + 当前 `git rev-parse HEAD` |
| `migration lifecycle OK` | **已被推翻（假绿）** | `../2026-11-14-ci-rehearsal-2/README.md` D3 |
| corpus acceptance `NOT RUN` | **仍成立且是设计**：原件不入库 | `ci.yml` 的 `vars.CORPUS_AVAILABLE` 分支 |

**引用纪律**：本目录任何数字都必须带"2026-11-14 17:04 快照、临时副本、非 CI"三件套；
不得用本目录证明"今天 CI 会绿"。

---

## 5. 与 `ci-rehearsal-2` 的关系（别混）

- 本目录（`ci-rehearsal`）= **原始日志集**：CI 步骤在本机跑出的 stdout，没有分析、没有差异点清单。
- `dsh/dsh-recruitment/evidence/experiments/2026-11-14-ci-rehearsal-2/` = 同一天稍后的**分析版**：钉了快照、列出 D1–D11"本机绿但 CI 会红"的差异点，
  并明确记录了 D2/D3/D6/D7 这些假绿机制。**结论以那份为准；本目录只提供原始输出。**
