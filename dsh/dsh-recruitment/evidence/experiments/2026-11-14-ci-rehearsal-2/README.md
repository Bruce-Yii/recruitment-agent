# CI 复演（第二轮）— 结论与差异点

日期：2026-11-14 · 分支：`feat/unified-document-intake` · `HEAD = 8a659f6b17cebd7acef26a36dd75ccddedfd08ab`（ahead 19，本地未提交变更 186 条，**未 push**）
复演对象：`.github/workflows/ci.yml`（未修改） · 详细逐 step 结果见 [`ci-steps.md`](ci-steps.md)

---

## 一、结论（本机能否代表 CI）

**能代表的部分**：以 **HEAD 提交树**（`git archive HEAD`，657 文件 = CI `checkout` 的内容）为输入，在独立临时库上逐字执行 CI 的 `run:` 脚本，四个常跑 job 的 **14 个可执行 step 全部复现为绿**：

| job | 结果 | 关键数字 / 产物 |
|---|---|---|
| `compile` | **PASS** | compileall exit 0；corpus 可移植性检查 exit 0 |
| `plugin` | **PASS** | `node --test`：tests **893** / pass **893** / fail **0** / skipped **0**（37s）；`pnpm install --frozen-lockfile` exit 0 |
| `db` | **PASS**（有保留） | 0001→0010 应用；9 个 verify 全过（`VERIFY PASS ... 32 条负向测试`）；lifecycle exit 0，但 ledger 守卫实际失效（D3） |
| `python-lanes` | **PASS** | fallback `69 passed, 1 skipped`；review `51 passed`（见下方 D5 的库名约束） |
| `corpus-acceptance` | **不运行** | 依赖不在仓库的 corpus 原件 + 仓库变量 `CORPUS_AVAILABLE=true`；当前变量为空 → **GitHub 上该 job 本来就会 skip** |

**不能代表的部分（必须知道）**：

1. **CI 只看得见已提交内容，本机工作区不是 CI 的输入。** 复演快照时工作区有 **186 条**未提交变更，包括 `db/migrations/0012_engine_state.sql`、`src/engine/**`（22 文件）、`test/integration/engine-mechanisms-pg.test.ts`、`tsconfig.engine.json`、以及 `dsh/dsh-recruitment/package.json` + `pnpm-lock.yaml` 的改动。本机任何"绿"都可能来自这些 CI 看不到的文件。**本轮把"HEAD 提交树"和"工作区增量态"分成两次复演**。
   > ⚠️ 工作区是**活**的：其它 lane 在复演期间继续改动。复演开始快照 186 条，结束时 182 条，且期间新增了 `db/migrations/0013_trace_chain.sql` 与新的 `src/` 文件。所以"工作区增量态"的结论只是 **0012 + engine 快照**的结论，不是对"提交任意工作区状态"的保证。
2. **本机无法复演 GitHub Actions 基础设施**：`actions/checkout@v4`、`actions/setup-python@v5`、`actions/setup-node@v4`、`pnpm/action-setup@v4`、postgres service 容器、Ubuntu 24.04 运行时、locale/时区。本机用等价物替代（HEAD 导出树 + Python 3.12.9 / Node 24.16.0 / pnpm 12.18.0 / PostgreSQL 17.11）。
3. **本机 pip 冷安装不可复演**：PyPI 在本机可达（HTTP 200），但 `pip install --upgrade pip` / 装 requirements 在 fresh venv 里挂起 >8 分钟无进展。因此"CI 在干净 runner 上能装依赖"这一点本机**没有验证到**；已装好依赖时 CI 原文命令 exit 0。
4. **时区 / locale** 没有被任何断言覆盖（复演中未出现依赖项）；Windows CRLF 会制造一个假的 ledger diff（D4），但被 CI 脚本自身的 `&&` 吞掉，不改变结论。

**对"HEAD 推上去 CI 会不会红"的判断**：按本轮复演，**不会**——四个 job 在 HEAD 提交树上都绿，且历史上导致 CI 红的两个缺陷已被 `c59d960`（2026-11-14）修掉（`git merge-base --is-ancestor c59d960 HEAD` = 是）。
**但"当前工作区若原样提交"存在 1 个未验证项**：新增的 engine 依赖 + `engine-mechanisms-pg.test.ts` 会让 `plugin` job 的 `node --test` 收集到新测试（本轮未复演，属另一 lane 进行中工作，见"未决问题"）。另外 D2 的机器绝对路径是**已提交**的遗留风险。

### 0. 复演期间分支 HEAD 移动了（必须知道）

复演期间其它 lane 又提交了两次：`8a659f6`（复演起点）→ `f2f6bea`（S6 内容嗅探）→ **`2bae294`（vendor engine：0012 + package.json/lockfile + src/engine + engine 测试，27 文件）**。所以：

| 输入 | 结论 |
|---|---|
| `8a659f6`（本轮主复演，跨 26 step） | 见上表：14 PASS / 12 不可复演 / 0 终态 FAIL |
| **`2bae294`（分支 tip，补充复演）** | **compile PASS**（compileall / 可移植性 grep 均 exit 0）；**plugin PASS**：0012 应用成功、`pnpm install --frozen-lockfile` exit 0（1s，store 命中）、`node --test` **904 tests / 904 pass / 0 fail / 0 skipped**（44s，比 HEAD 多 11 条 = engine 测试）；**db verify PASS**（含 9 张 `engine_*` 表）。未在 tip 上重跑：`python-lanes`（tip 改动不碰 converter）、db lifecycle（已知 D6：upgrade/re-run 硬编码列表不会覆盖 0012） |

即：**"工作区增量态若提交"这个未决问题，在 tip 上已经被实际提交（2bae294），本机补充复演没有发现会让 CI 红的东西**。若分支继续追加提交，需对新提交再跑一次。

---

## 二、"本机绿但 CI 会红"差异点清单

| # | 差异点 | 事实 / 证据 | 会不会让 CI 红 | 说明 |
|---|---|---|---|---|
| **D1** | **未提交文件不在 CI 视野** | `git status --porcelain --untracked-files=all`：快照时 186 条、结束时 182 条（其它 lane 同时在改）；HEAD 提交树迁移只到 0010，`src/engine` / engine 测试 / 0012 / lockfile 增量全部未提交，期间还新出现 `0013_trace_chain.sql` | **会**（如果依赖它们却忘了提交） | 本机工作区 + 未提交文件的测试组合 ≠ CI。CI 的 checkout 只拿提交内容；且工作区在变，任何"本机绿"都必须钉到具体提交才算数 |
| **D2** | **机器绝对路径已提交，但守卫只扫 `*.jsonl`** | HEAD 树里 `converter/corpus/batch2-picked.json`（**按设计不入库**：机器本地语料清单，含真实简历绝对路径；重建方法见 `ci-steps.md` Job1 Step5 的说明）含 `D:\12412\dsh工作区\projects\resume-talent-pool\...` 多条；compile job 的 grep 参数是 `--include='*.jsonl'`，所以 PASS | **会**（任何读到该 json 的测试在 Linux 上 stat 都会 ENOENT） | 历史 CI 红正是这类：plugin job `ENOENT ... 'D:\12412\...\zero_text.pdf'`（ubuntu runner 上报 Windows 路径）。守卫的**意图**是"manifest 不含机器绝对路径"，**实现**只覆盖 jsonl |
| **D3** | **迁移 ledger 守卫不会失败** | lifecycle 步骤：`diff -u /tmp/files.txt /tmp/ledger.txt && echo "ledger matches files"`，**没有 `exit 1`**；`set -e` 不会因 `A && B` 里的 A 失败而退出。本机实测：diff 报 11 行差异，脚本仍打印 `migration lifecycle OK`，step **exit 0** | **不会红**（这才是问题） | 注释声称"漏跑 / 幽灵迁移都红"，实际是**永远绿**。真正的 ledger 漂移（新迁移没登记）CI 检测不出来 |
| **D4** | **CRLF / 行尾差异** | 本机 Windows：`psql -t -A` 输出 CRLF，`ls \| sed` 输出 LF → `diff` 每行都"不同"（内容逐字一致）。CI ubuntu 全 LF，不会出现 | 不会（被 D3 的 `&&` 吞掉） | 这是本机复演时唯一一次"假红"；定性为环境差异，不是 CI 缺陷 |
| **D5** | **库名硬编码** | `converter/review/tests/conftest.py`：`EXPECTED_DB = "ra_review_check"`，连错库直接 `pytest.fail`。本机用改名临时库首跑得到 **47 errors**，按 CI 库名复跑 `51 passed` | 不会（CI 的 service 名就是 `ra_review_check`） | 复演时**不能**任意改这个 job 的库名；改名库 = 假红。plugin job 的集成测试则支持 `RECRUITMENT_TEST_DB` 覆盖（无硬守卫） |
| **D6** | **迁移"目录驱动"与"硬编码列表"混用** | 应用迁移 = `ls db/migrations/*.sql \| sort`（目录驱动）；verify = **硬编码** `verify-0003..0010 verify`；upgrade = **硬编码** `0001..0007 + 0008 + 0009,0010`；re-run = **硬编码** `0010` | 不会红，但**覆盖漏**：提交 0012 后，实测 `ra_upgrade` 台账止于 `0010`、re-run 不测 0012、没有 `verify-0012` | CI 绿 ≠ 新迁移被测过。新增迁移越多，这条缝越大（0011 目前不存在，0012 是工作区新增） |
| **D7** | **skip 计入绿** | `python -m pytest fallback/tests -q` → `69 passed, 1 skipped`，job 仍 PASS；skip 原因 `synthetic corpus PDF not present`（本地 corpus PDF 未提交，CI 更不会有） | 不会红 | 与项目 R3 冲突（"skipped > 0 不得宣称全绿"）。CI 若依赖这个 job 判"绿"，有 1 条用例从未跑过 |
| **D8** | **本机语料比 CI 多** | 本机存在 `converter/corpus/synthetic/zero_text.pdf`（未被 git 跟踪）；HEAD 树没有该文件 | **可能会红**（取决于测试是 skip 还是硬 stat） | 本机测试可能因为"本地恰好有文件"而绿，CI 没有就红/静默 skip。与 D2 同源 |
| **D9** | **版本漂移（major 内浮动）** | CI：`python-version: "3.12"`、`node-version: "24"`、`pnpm version: 12` → 每次取最新 patch/minor；本机 Python 3.12.9 / Node 24.16.0 / pnpm 12.18.0 / PG 17.11 | 长期有风险，本轮无证据 | `node --test` 的 TS 支持与默认测试发现规则、pnpm frozen 语义都在 major 内演进；`node --test` 的 893 条结果依赖 Node 24 的 TS type-stripping 行为 |
| **D10** | **密码/连接参数不同** | CI：`PGPASSWORD=postgres`、`RECRUITMENT_DB_PASSWORD=postgres`；本机：本地 PG 密码（只走环境变量，未写入任何文件） | 不会 | 纯环境差异；本轮所有库均为临时库，未碰 `ra_s6s7` |
| **D11** | **分支从未 push，CI 无本分支运行记录** | `gh run list --branch feat/unified-document-intake` 为空；最近真实 CI 全在 `fix/s6-s7-unified`（5 次 failure） | — | 本结论的"HEAD 会绿"是复演推断，不是实测 CI |

---

## 三、真实 CI 红的历史证据（证明"本机绿 CI 红"真实存在）

`gh run list` 显示 `fix/s6-s7-unified` 上 5 次 failure（2026-11-13，45–52s）。job 级失败：

- `db` → `Verify every migration` 失败：`NEGATIVE NV-01 失败但 SQLSTATE 不符（期望 23503 实际 23505）... duplicate key value violates unique constraint "uq_application_active_cycle"`
- `plugin` → `Run plugin tests` 失败：`ℹ fail 9`；`ENOENT: ... stat 'D:\12412\dsh工作区\...\converter\corpus\synthetic\zero_text.pdf'`；`ERROR: cannot execute INSERT in a read-only transaction`
- `compile` / `python-lanes` 成功，`corpus-acceptance` 被 skip（与工作流 `if` 一致）

这些失败在 HEAD 上已被 `c59d960`（2026-11-14）修复（是 HEAD 的祖先），本轮 HEAD 复演未复现。完整失败日志：`logs/gh__failed-run-43400997565.log`（340 KB，取自 `gh run view --log-failed`；注意这是**另一分支/提交**的证据，不是本分支）。

---

## 四、复演方式与证据索引

- 输入：`git archive HEAD` → `D:\12412\dsh工作区\temp\ra_ci_rehearsal2\head`（657 文件，LF，保留供复核）；工作区增量态另存 `...\wt`、tip `2bae294` 另存 `...\head2`（两个临时副本复演后已删除）。
- 命令原文：`scripts/<job>/*.sh`（从 `ci.yml` 逐字复制，仅注释标明 `${{ vars.CORPUS_AVAILABLE }}` 的本地渲染）。
- 执行器：Git Bash（`D:\Git\bin\bash.exe -s`）+ 本机 psql.exe；`working-directory` 与 workflow 一致。
- 临时库（**已在本轮结束时删除**）：`ra_ci_rehearsal2`（替代 `ra_ci`）、`ra_ci_rehearsal2_plugin`（替代 `ra_s6s7`）、`ra_ci_rehearsal2_review`（apply 验证用）、`ra_fresh` / `ra_upgrade`（lifecycle 脚本自建）、`ra_review_check`（**本机既有**、同名库，仅 review pytest 因 D5 必须用它；用例全部回滚）。
- **未触碰 `ra_s6s7` 及任何其它既有库**（全程无该库连接）。

关键文件：

| 文件 | 内容 |
|---|---|
| [`ci-steps.md`](ci-steps.md) | 26 个 step 的逐条 PASS / FAIL / 不可复演 + 命令原文 + 证据路径 |
| `logs/env-and-scope.txt` | HEAD、工作区脏度、工具链版本、库清单与边界 |
| `logs/compile__03b__install-exact-global.log` | CI 安装命令 exit 0（9s，依赖已就位） |
| `logs/plugin__06__run-plugin-tests.log` | 893 测试全过（94 KB，尾部汇总） |
| `logs/db__02/03/04__*.log` | 迁移应用 / 9 个 verify / lifecycle（含 ledger diff 原文） |
| `logs/python-lanes__05__model-fallback.stdout.log` | `69 passed, 1 skipped` |
| `logs/python-lanes__06b__human-review-ra_review_check.stdout.log` | `51 passed`（按 CI 库名） |
| `logs/wt__*` | 工作区增量态（含 0012）的 db job / 0012 幂等 / lockfile 一致性 |
| `logs/gh__failed-run-43400997565.log` | 历史真实 CI 失败全日志 |

---

## 五、未决问题

1. ~~**工作区增量态若提交，`plugin` job 能否绿？未验证。**~~ **已在 tip `2bae294` 上补验**：该提交把 engine 增量提交入库，`pnpm install --frozen-lockfile` exit 0、`node --test` **904 pass / 0 fail / 0 skipped**、db verify PASS → 在 tip 上未见会红项。若分支继续追加提交，需对新提交重跑。
2. **本机无法验证"干净 runner 上 pip 冷安装"**（本机 pip 到 PyPI 挂起）。若 CI runner 网络正常则无风险，但本机无法给出证据。
3. **`corpus-acceptance` 永远在本机不可复演**；`converter/tests`（8 文件）在 CI 也从未执行。验收结论不能引用它。
4. **D3 的 ledger 守卫失效是 CI 配置缺陷**（不改配置，只报告）。若要真正生效需要 `diff ... || { echo error; exit 1; }` 之类；同时 D6 的硬编码列表需要改成目录驱动。
5. **D2 的 `batch2-picked.json` 机器绝对路径**：是否应清理/移出仓库需要总控裁决（它可能被当作语料选择清单保留；但当前守卫不覆盖 json）。
