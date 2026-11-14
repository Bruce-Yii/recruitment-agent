# S6→S7 决策落库 · 仓库内可复现（2026-11-14）

> **历史实验，按当时口径记录。** 本 README 是 2026-11-14 21:40 补写的入口；
> 详细的逐步分析在同目录 `INDEX.md`（生成于 2026-11-14 20:21，**早于最后一次 run**，见 §5）。
>
> **口径日期**：2026-11-14 20:07–21:00 +08:00（各 run 的 `run-meta.json.started_at` 落在
> 12:07Z–13:00Z = 20:07–21:00 +08）。当时 HEAD 跨 `d6f4aa5` → `ce2983b` → `b2d51cd` → `4a5dfd3`
> （每个 run 的 `run-meta.json.git_head` 逐次记录，不靠记忆）。
>
> **R7**：全程合成数据——姓名「示例甲」、邮箱 `repro.candidate.a@example.test`、电话 `+8613600004242`（示例值）；
> fixture `sha256=56f93d3be582a988a4713c1cba22c411e17b20371de73c2147962adde4c24ce5`；读回里联系方式已打码。
> 没有触碰任何真实候选人资料。

---

## 1. 这份实验做了什么（回应什么质疑）

被质疑的对象：**"库里唯一那条 SCREENING 决策来自仓库外脚本 + 手工钉 rubric，仓库里无法复现。"**

本实验用产品自己入口（`manual/screening-decision/run-screening-decision.mjs`，内部调用真实工具
`create*Tool(...).execute()` + 真实 PostgreSQL `ra_s6s7`）跑一条完整链路：

`job_create → job_rubric_approve → application_intake → screening_evaluate → decision_record(SCREENING) → DB 读回`

全程**不写手工 SQL**（只有只读读回），验证：

1. 决策能经**产品工具**真实落库（FIRST_RUN）；
2. 第二次跑被**唯一性/幂等**挡住且零新增（RERUN）；
3. 顺带复现出一个此前被"手钉 rubric"掩盖的**产品缺陷**（判断型准则 → S7 `TypeError`，见 §3/`INDEX.md §4`）。

**规范命令**（密码按约定只走环境变量，不写进任何文件/日志）：

```powershell
$env:RECRUITMENT_DB_PASSWORD='<本机演示库密码>'
node dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs
```

需要从零建一个新岗位时加 `$env:REPRO_JOB_CODE='<新 code>'`（本机已有 `REPRO-*` 残留时用）。
每个 run 目录都有 **`command.txt`（该次命令原文）**，例如
`run-2026-11-14T12-19-04-365Z/command.txt`；`run-meta.json` 记录 argv/cwd/node/git_head/代码文件 sha256。

---

## 2. 主证据：决策真的写进 DB（当时口径）

| run | 结果 | 关键事实（逐字摘自该 run 的 `run.log`/`summary.json`） |
|---|---|---|
| `run-2026-11-14T12-19-04-365Z/` | **FIRST_RUN PASS（EXIT=0，六步全 PASS）** | job `4b46d9f7…`；rubric `dac1002a-367f-43e1-b583-b8479d407e2e`；`job_rubric_approve` gate=`allowed-once`；intake 后 **`application.rubric_version_id=dac1002a…`（F1 已钉住）**；decision **`42324a14-e276-4b2d-827d-8f31b668a4f8`**（SCREENING/S7/ADVANCE，basis_refs=4）；行数差 `+decision:1 +event_inbox:1` |
| `run-2026-11-14T12-12-31-537Z/` | FIRST_RUN PASS（EXIT=0，HEAD `d6f4aa5`） | decision `3742cde3-2448-4930-a203-e368a285291e`；独立读回 `db-readback-independent-d6f4aa5.txt` |
| `run-2026-11-14T12-12-46-973Z/`、`run-2026-11-14T12-13-46-538Z/`、`run-2026-11-14T12-19-18-364Z/` | **RERUN PASS（EXIT=0）** | 同链路重跑：`DUPLICATE_JOB_CODE` → 复用、`approve NO_OP`、`intake REUSED`、`decision ALREADY_DECIDED/SCOPE_ALREADY_DECIDED`；**行数差 `{}`，零新增行** |
| `run-2026-11-14T13-00-50-286Z/` | **RERUN PASS（EXIT=0；`INDEX.md` 之后新增的一次）** | `run_mode=RERUN`、`decision_written_this_run=false`、六步全 PASS；git_head `4a5dfd3…`；harness sha256 `edcd210e05ec0f0e19b336c95dae142554deda8c8a9d238c17387ca176131baa`（与仓库里脚本一致） |
| `bug-judgment-criterion/run-2026-11-14T12-14-34-230Z/` | 缺陷复现（EXIT=0 = 复现成功） | `job_create` 落库判断型准则 `field=null` → `screening_evaluate` 抛 `TypeError: Cannot read properties of null (reading 'startsWith')`（`src/tools/screening-evaluate.ts:965`，当时的行号） |

失败也保留（`INDEX.md §5` 有全表）：两个 `BLOCKED` run 的原因分别是"harness 把 as_of 设成 now-5s"与
"判断型准则 TypeError"；一个 `EXIT=1` run 是 harness 自己读回 SQL 的参数类型错（`text = uuid[]`）。
**这些都是真实输出，没有隐去。**

---

## 3. 当时结论（2026-11-14 21:00）

1. **可复现成立**：仓库内的脚本 + 产品工具 + 真库，可以不带手工 SQL 地写出 SCREENING 决策；
   二次执行幂等、零新增。
2. **缺陷成立**：用产品入口建出的**判断型准则** rubric，S7 会让 `screening_evaluate` 崩；
   此前"能跑通"的验收 rubric 是手工 SQL 插的（`field` 键缺失），恰好绕开该分支。
3. **边界**：approval 是 allow-once 替身；决策人=配置的 HR 专员（触发 `DECIDER_NOT_HIRING_MANAGER` 警告，只记录不拦截）；
   数据是合成 fixture（`FIXTURE`），不是真实招聘。

---

## 4. 现在（2026-11-14 21:40）是否仍成立

| 当时结论 | 现在 | 依据（读码，未复跑） |
|---|---|---|
| F1：intake 时钉 rubric 的修复已在代码里 | **仍成立** | 当前树 `src/tools/application-intake.ts:1351` 有 `resolvePinnableRubricVersion`、`:1429` 调用（本实验要求的"不再依赖未提交改动"成立） |
| 判断型准则会让 S7 崩 | **已修，不再复现（读码）** | `src/tools/screening-evaluate.ts:1263-1276`：`isJudgment = field === undefined \|\| field === null`，注释明确写了旧 `TypeError`；本实验**未重跑**，以代码为准 |
| 仓库内可复现 + 幂等 | **仍成立（脚本未变）** | `manual/screening-decision/run-screening-decision.mjs` `sha256=edcd210e…` 与最后一次 run 的 `summary.harness.sha256` 一致 |
| `INDEX.md` 的"当前 HEAD `b2d51cd`" | **已过时** | 最新一次 run 的 git_head 是 `4a5dfd3`；本 README 补记，`INDEX.md` 不改（保留它当时的快照口径） |

---

## 5. 证据文件清单（机器可核验）

- **全量文件 sha256 + 字节数**：同目录 `FILES.sha256`（**136 个文件**，格式 `sha256  字节数  相对路径`，
  含所有 run 的 `command.txt`/`run.log`/`step-*.json`/`summary.json`/`db-readback.txt` 与 `INDEX.md`）。
- 关键文件（从前述清单中取，均已在 `FILES.sha256` 里）：
  - harness `run-screening-decision.mjs`：`sha256=edcd210e05ec0f0e19b336c95dae142554deda8c8a9d238c17387ca176131baa`
  - fixture PDF：`sha256=56f93d3be582a988a4713c1cba22c411e17b20371de73c2147962adde4c24ce5`（10931 B，见各 `summary.json.fixture`）
  - 主证据 decision：`42324a14-e276-4b2d-827d-8f31b668a4f8`（`run-2026-11-14T12-19-04-365Z/step-05-decision-record-screening.json`）
  - 独立 SQL 读回：`db-readback-independent.txt`、`db-readback-independent-d6f4aa5.txt`
- **重跑入口**：`node dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs`（需 `RECRUITMENT_DB_PASSWORD`），
  复跑会写演示库 `ra_s6s7`（合成数据；不是只读实验）。
