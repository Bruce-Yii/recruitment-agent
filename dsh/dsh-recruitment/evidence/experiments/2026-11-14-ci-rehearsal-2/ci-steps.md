# CI 逐 job / 逐 step 复演表

- 复演对象：`.github/workflows/ci.yml` @ `HEAD = 8a659f6b17cebd7acef26a36dd75ccddedfd08ab`（分支 `feat/unified-document-intake`，ahead 19，**未 push、该分支无任何 CI run**）
- 输入快照：`git archive HEAD` → `D:\12412\dsh工作区\temp\ra_ci_rehearsal2\head`（657 个文件，等价于 `actions/checkout@v4` 的干净检出：只含提交内容、LF、无 node_modules）
- 执行方式：每个 `run:` 块**原文**保存为 `scripts/<job>/<step>.sh`，用 Git Bash（`D:\Git\bin\bash.exe -s`）执行，工作目录按 workflow 的 `working-directory` 设置；psql 用本机 PostgreSQL 17.11（等价 `postgres:17` service）；环境变量按 workflow 的 `env:` 注入，只替换库名与密码（见 `logs/env-and-scope.txt`）。
- 图例：
  - **PASS**：本机执行 exit 0 且行为与 CI 预期一致
  - **FAIL**：exit != 0
  - **不可复演**：依赖 GitHub Actions 基础设施 / 不在仓库的语料 / 本机网络不可达，附原因与等价替代

统计（26 个 step）：**PASS 14 · 不可复演 12 · 终态 FAIL 0**（python-lanes 的 review 测试首跑 FAIL 属复演库名偏离，按 CI 库名复跑 PASS，见 job 5）。

---

## Job 1 `compile` — converter (compile + manifest portability)

| # | Step | CI 命令原文 | 复演结果 | 证据 |
|---|---|---|---|---|
| 1 | actions/checkout@v4 | — | **不可复演**（GitHub Action）。等价物：`git archive HEAD` 导出 657 文件 | `logs/env-and-scope.txt` |
| 2 | actions/setup-python@v5 | `python-version: "3.12"` | **不可复演**（GitHub Action）。等价物：Python 3.12.9 | `logs/env-and-scope.txt` |
| 3 | Install converter dependencies | `set -euo pipefail`<br>`python -m pip install --quiet --upgrade pip`<br>`python -m pip install --quiet -r converter/requirements.txt` | **PASS（等价环境）**：依赖已按 requirements 就位（PyMuPDF 1.28.0 / pytest 9.1.1）时，**原文命令 exit 0（9s）**。⚠️ fresh venv 里从 PyPI 下载在本机挂起 >8 分钟（`pip install --upgrade pip` 无进展），该"冷安装"路径**不可复演**，属本机网络，不是 CI 缺陷 | `logs/compile__03b__install-exact-global.log`；venv 尝试：`logs/compile__02__upgrade-pip.log`（0 字节） |
| 4 | Compile converter/src | `python -m compileall -q converter/src` | **PASS** exit 0 | `logs/compile__04__compile-converter-src.*.log` |
| 5 | Corpus manifests must be portable | `set -euo pipefail`<br>`if grep -rn --include='*.jsonl' -e 'D:\\' -e 'C:\\' converter/corpus; then ... exit 1; fi`<br>`echo "corpus manifests contain no machine-absolute paths"` | **PASS** exit 0，输出 `corpus manifests contain no machine-absolute paths`。⚠️ 但该检查只扫 `*.jsonl`，当时 HEAD 树里的 `converter/corpus/batch2-picked.json`（**按设计不入库**：机器本地语料清单，含真实简历绝对路径，已从 HEAD 移除并进 `.gitignore`）含 `D:\12412\...` 未被发现（见 README 差异点 D2）。重建方法：从本机工作区 `recruitment-os\temp\batch2-picked.json` 取回（14883 B；核对 sha256 后放回 `converter/corpus/`，**禁止提交**——`.gitignore:41-42` 已忽略），或由当时的语料挑选流程重新生成 | `logs/compile__05__corpus-manifests.stdout.log` |
| 6 | Report acceptance-test availability | `if [ "${{ vars.CORPUS_AVAILABLE }}" = "true" ]; then ... else echo "::notice ...::"; fi` | **PASS（等价）**：`vars.CORPUS_AVAILABLE` 未设置（本机渲染为 `$CORPUS_AVAILABLE` 空）→ 走 else，打印 `::notice title=Corpus acceptance NOT RUN::...`，与 CI 未设变量时一致 | `logs/compile__06__report-availability.stdout.log` |

---

## Job 2 `corpus-acceptance` — converter (acceptance tests, needs corpus)

`if: ${{ vars.CORPUS_AVAILABLE == 'true' }}`

| # | Step | CI 命令原文 | 复演结果 |
|---|---|---|---|
| 1 | actions/checkout@v4 | — | **不可复演**（GitHub Action） |
| 2 | actions/setup-python@v5 | `python-version: "3.12"` | **不可复演**（GitHub Action） |
| 3 | Install converter dependencies | `python -m pip install ... -r converter/requirements.txt` | **不可复演**：同 job 1 step 3 的 PyPI 冷安装问题 |
| 4 | Run acceptance tests | `python -m pytest converter/tests -q`<br>env: `CORPUS_ROOT_TALENT_POOL` / `CORPUS_ROOT_ODOO_SAMPLES` / `CORPUS_ROOT_CODEX_CONVERTED` / `CORPUS_ROOT_SYNTHETIC` | **不可复演**：① 需要 `corpus` 原件（**按设计不在仓库**）；② 需要仓库变量 `CORPUS_AVAILABLE=true`，`gh variable list` 为空 → 在 GitHub 上该 job 会被 **skip**（历史 CI run 也显示该 job `skipped`）。本机无这些原件 |

> 该 job 不在默认绿路径；本次不把它算作"CI 必跑"。`converter/tests`（8 个测试文件）因此**在 CI 中从未被执行**。

---

## Job 3 `plugin` — dsh plugin (node --test + postgres)

service：`postgres:17`，`POSTGRES_DB=ra_s6s7`（本次用独立库 `ra_ci_rehearsal2_plugin` 替代，避免碰 `ra_s6s7`）

| # | Step | CI 命令原文 | 复演结果 | 证据 |
|---|---|---|---|---|
| 1 | actions/checkout@v4 | — | **不可复演**（GitHub Action）；等价：HEAD 导出树 | — |
| 2 | actions/setup-node@v4 | `node-version: "24"` | **不可复演**（GitHub Action）；等价：Node **v24.16.0** | `logs/env-and-scope.txt` |
| 3 | pnpm/action-setup@v4 | `version: 12` | **不可复演**（GitHub Action）；等价：pnpm **12.18.0** | `logs/env-and-scope.txt` |
| 4 | Apply migrations for the plugin integration tests | `set -euo pipefail`<br>`for f in $(ls db/migrations/*.sql \| sort); do f=$(basename "$f" .sql); psql -v ON_ERROR_STOP=1 -q -f "db/migrations/$f.sql"; done` | **PASS**：全新库 `ra_ci_rehearsal2_plugin` 上 10 个迁移全部应用 | `logs/plugin__02__apply-migrations.stdout.log` |
| 5 | Install plugin dependencies | `pnpm install --frozen-lockfile`（workdir `dsh/dsh-recruitment`） | **PASS** exit 0（HEAD 提交的 package.json 与 pnpm-lock.yaml 一致） | `logs/plugin__05__install-plugin-dependencies.log` |
| 6 | Run plugin tests | `node --test`（workdir `dsh/dsh-recruitment`） | **PASS**：`tests 893 / pass 893 / fail 0 / skipped 0`，37s | `logs/plugin__06__run-plugin-tests.log`（94 KB，尾部有汇总）；`logs/plugin__06__run-plugin-tests.exit.log` |

---

## Job 4 `db` — db (migrations + verify + idempotency)

service：`postgres:17`，`POSTGRES_DB=ra_ci`（本次用独立库 `ra_ci_rehearsal2` 替代）

| # | Step | CI 命令原文 | 复演结果 | 证据 |
|---|---|---|---|---|
| 1 | actions/checkout@v4 | — | **不可复演**（GitHub Action） | — |
| 2 | Apply migrations 0001..0006（名字过时，实际 glob 全部） | `set -euo pipefail`<br>`for f in $(ls db/migrations/*.sql \| sort); do f=$(basename "$f" .sql); echo "== $f"; psql -v ON_ERROR_STOP=1 -q -f "db/migrations/$f.sql"; done` | **PASS**：0001→0010 依次应用（stdout 打印 10 个 `== 00xx`） | `logs/db__02__apply-migrations.stdout.log` / `.stderr.log`（35 KB NOTICE） |
| 3 | Verify every migration | `set -euo pipefail`<br>`for f in verify-0003 ... verify-0010 verify; do echo "== $f"; psql -v ON_ERROR_STOP=1 -q -f "db/$f.sql"; done` | **PASS** exit 0（9 个 verify 全过，含 `VERIFY PASS：结构断言 + 状态机覆盖 + 对象覆盖 + 32 条负向测试全部通过`） | `logs/db__03__verify-every-migration.stdout.log` / `.stderr.log` |
| 4 | Migration lifecycle (fresh / upgrade / re-run) | fresh：`create database ra_fresh` 后用 `MIGS=$(ls ...)` 全量跑；upgrade：**硬编码** `0001..0007` → `0008` → `0009 0010`；re-run：**硬编码** `0010`；ledger：`diff -u /tmp/files.txt /tmp/ledger.txt && echo "ledger matches files"` | **PASS（有保留）** exit 0。本机 `diff` 因 **CRLF vs LF** 报 10 行差异（内容逐字相同），`diff ... && echo` 失败被 `&&` 吞掉，脚本继续打印 `migration lifecycle OK`、step 仍 exit 0 → **该 ledger 守卫无法让 CI 变红**（见 README 差异点 D3） | `logs/db__04__migration-lifecycle.stdout.log` / `.stderr.log` |

---

## Job 5 `python-lanes` — converter lanes (model fallback + human review)

service：`postgres:17`，`POSTGRES_DB=ra_review_check`（apply step 用独立新库 `ra_ci_rehearsal2_review` 证明迁移可跑；pytest step 因守卫要求**必须**是 `ra_review_check`，见下）

| # | Step | CI 命令原文 | 复演结果 | 证据 |
|---|---|---|---|---|
| 1 | actions/checkout@v4 | — | **不可复演**（GitHub Action） | — |
| 2 | actions/setup-python@v5 | `python-version: "3.12"` | **不可复演**（GitHub Action）；等价：Python 3.12.9 | — |
| 3 | Install dependencies | `set -euo pipefail`<br>`python -m pip install --quiet --upgrade pip`<br>`python -m pip install --quiet -r converter/requirements.txt "psycopg[binary]>=3.2"` | **PASS（等价环境）**：psycopg 3.3.5 / pytest 9.1.1 / PyMuPDF 1.28.0 已就位；冷安装同 job 1 step 3，本机 PyPI 不可复演 | `logs/env-and-scope.txt` |
| 4 | Apply 0001..0003 for the review lane | `for f in 0001_init 0002_seed 0003_review_queue; do psql ... -f "db/migrations/$f.sql"; done` | **PASS**：在全新库 `ra_ci_rehearsal2_review` 上成功 | `logs/python-lanes__04__apply-0001-0003.stderr.log` |
| 5 | model fallback tests (no database) | `python -m pytest fallback/tests -q`（workdir `converter`） | **PASS**：`69 passed, 1 skipped`（skip 原因：`synthetic corpus PDF not present`，CI 同样会 skip） | `logs/python-lanes__05__model-fallback.stdout.log`；`logs/python-lanes__05b__fallback-skip-reasons.log` |
| 6 | human review tests (needs the database) | `python -m pytest review/tests -q`（workdir `converter`） | **PASS（按 CI 库名复跑）**：<br>① 首次用改名库 `ra_ci_rehearsal2_review` → **FAIL**（`4 passed, 47 errors`），根因 `conftest.py` 硬性断言 `current_database() = 'ra_review_check'`，错误原文 `测试只允许跑在 ra_review_check，当前连的是 'ra_ci_rehearsal2_review'`；<br>② 按 CI 库名 `ra_review_check`（本机已存在、0001–0003 表齐全、0 连接、用例全部回滚）复跑 → **PASS** `51 passed`，8.2s | ① `logs/python-lanes__06__human-review.stdout.log`（64 KB）<br>② `logs/python-lanes__06b__human-review-ra_review_check.stdout.log` |

---

## 补充：未提交工作区增量态（如果把这些文件也提交，CI 会怎样）

输入：HEAD 导出树 + 工作区当前未提交增量（`db/migrations/0012_engine_state.sql`、`dsh/dsh-recruitment/package.json`、`pnpm-lock.yaml`、`src/engine/**` 22 文件、`test/integration/engine-mechanisms-pg.test.ts`、`tsconfig.engine.json`）。

> ⚠️ 工作区是活的（其它 lane 在复演期间继续改动）：快照时 186 条未提交变更，复演结束时 182 条，并新出现 `db/migrations/0013_trace_chain.sql`。下表只代表 **0012 + engine 快照**。

| 检查 | 命令 | 结果 | 证据 |
|---|---|---|---|
| 0012 迁移可应用（glob） | db job step 2 原文 | **PASS**：0001→0010→0012 全过 | `logs/wt__db__02__apply-migrations.stdout.log` |
| verify 列表（硬编码 0003..0010+verify）是否覆盖新表 | db job step 3 原文 | **PASS**：`verify.sql` 的 STRUCT/INV 断言在含 9 张 `engine_*` 表时仍通过 | `logs/wt__db__03__verify.stdout.log` |
| lifecycle（硬编码列表） | db job step 4 原文 | **PASS** exit 0，但 `ra_upgrade` 台账止于 `0010_migration_ledger`，**0012 未进入 upgrade 路径**；re-run 仍只重跑 0010 → 0012 的幂等性/升级路径 CI 不覆盖 | `logs/wt__db__04__lifecycle.stdout.log`；台账读回见下表 |
| 0012 幂等（补测） | `psql -f db/migrations/0012_engine_state.sql` ×3（含 ra_upgrade 升级后） | **PASS**：连续重跑 2 次 + 在 0001→0010 的 ra_upgrade 上再跑均 exit 0；`engine_%` 表 9 张 | `logs/wt__0012__rerun1.log`、`wt__0012__rerun2.log`、`wt__0012__apply-to-ra_upgrade.log` |
| 工作区 lockfile 与 package.json 一致性 | `pnpm install --frozen-lockfile --lockfile-only` | **PASS**：`Lockfile passes supply-chain policies (114 entries)`，3s | `logs/wt__plugin__05a__frozen-lockfile-check.log` |
| 工作区 `node --test`（含 engine 测试） | `node --test` | **未复演**：需要先装新增的 `@deepseek-ai/*` 依赖，且 engine 文件属另一 lane 进行中工作（未提交、随时变动）；不纳入本次 CI 结论 | — |

`ra_upgrade` 台账读回（WT lifecycle 之后）：

```
0001_init,0002_seed,0003_review_queue,0004_stage_catalog,0005_version_binding,
0006_integrity_gaps,0007_decision_integrity,0008_decision_uniqueness,
0009_application_identity,0010_migration_ledger          ← 没有 0012
```

---

## 与真实 CI 的对照（历史 run，非本分支）

本分支 `feat/unified-document-intake` 从未 push（`gh run list --branch ...` 为空）。仓库最近的真实 CI 运行都在 `fix/s6-s7-unified`，均为 **failure**（5 次，45–52s，2026-11-13）：

| job | 失败 step | CI 错误原文（节选） | 根因 |
|---|---|---|---|
| db | Verify every migration | `psql:db/verify-0004.sql:301: ERROR: NEGATIVE NV-01 失败但 SQLSTATE 不符（期望 23503 实际 23505）：写一个不存在的 stage code（S99）→ 外键拒绝 \| duplicate key value violates unique constraint "uq_application_active_cycle"` | 负向用例假定"先撞外键"，实际先撞 0009 引入的唯一约束；期望 SQLSTATE 过窄 |
| plugin | Run plugin tests | `ℹ fail 9`；`Error: ENOENT: no such file or directory, stat 'D:\12412\dsh工作区\...\converter\corpus\synthetic\zero_text.pdf'`；`ERROR: cannot execute INSERT in a read-only transaction` | 测试里/夹具里出现**机器绝对路径**（Windows 路径在 ubuntu runner 上 stat）；另有只读事务内 INSERT |

HEAD 已包含修复提交 `c59d960`（2026-11-14 08:25，`git merge-base --is-ancestor c59d960 HEAD` = 是）；本机复演 HEAD 提交树未复现这两个红。说明"本机绿、CI 红"在历史上确实发生，且根因正是**路径/状态残留/环境假设**，而不是业务代码。

## 补充：分支 tip 2bae294 复演（复演期间其它 lane 的新提交）

HEAD 在复演期间从 8a659f6 前进到 2bae294（中途还有 2f6bea）。2bae294 = 把工作区里未提交的 engine 增量提交（0012 + package.json/lockfile + src/engine 22 文件 + engine 测试，27 files, +3311）。对 tip 重跑：

| job | 结果 | 证据 |
|---|---|---|
| compile：compileall | **PASS** exit 0 | `logs/tip__compile__04.stdout.log` |
| compile：corpus portability | **PASS** exit 0 | `logs/tip__compile__05.stdout.log` |
| plugin：apply migrations（glob，含 0012） | **PASS** exit 0 | `logs/tip__plugin__02__apply.stdout.log` |
| plugin：pnpm install --frozen-lockfile | **PASS** exit 0（1s，store 命中，无下载） | `logs/tip__plugin__05__install.log` |
| plugin：
ode --test | **PASS**：tests **904** / pass **904** / fail **0** / skipped **0**，44s（比 8a659f6 多 11 条 = engine 测试） | `logs/tip__plugin__06__node-test.log` |
| db：9 个 verify（硬编码列表） | **PASS**：`VERIFY PASS ... 32 条负向测试全部通过`（含 9 张 engine_* 表） | `logs/tip__db__03__verify.stdout.log` |

未在 tip 上重跑：python-lanes（tip 改动未触及 converter）、db lifecycle（D6 已知：upgrade/re-run 硬编码列表不覆盖 0012）。
