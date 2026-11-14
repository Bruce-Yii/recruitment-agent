# S6 → S7 决策落库：仓库内可复现 harness

> 用途：回答独立验收窗口的那条质疑 ——
> 「DB 里那条 SCREENING 决策来自一次**跑在仓库外**的验收脚本，且必须先**手工钉 rubric**；
> 仓库里没有任何脚本能复现它。」
>
> 本目录里的脚本只用**产品自己的工具**（`tool.execute()`）走完 S6→S7，并在最后**从 DB 读回**
> 那条 `decision_scope='SCREENING'` 的决策行。**不手工 UPDATE 任何业务表、不手工钉 rubric。**

## 一键运行

```powershell
# 仓库根 = D:\12412\dsh工作区\projects\recruitment-agent
# （密码按约定从环境变量注入，**不写进任何文件/日志**）
$env:RECRUITMENT_DB_PASSWORD='<本机演示库密码>'
node dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs
```

前置条件（都属于"环境"，不属于"手工造数据"）：

| 项 | 要求 |
|---|---|
| 数据库 | `ra_s6s7`（可用 `RECRUITMENT_TEST_DB` 覆盖），**迁移 0001–0014 已应用**（含 `0002_seed` 的演示租户/部门/actor） |
| 密码 | 只从 `RECRUITMENT_DB_PASSWORD` 环境变量读，不落盘 |
| Python | converter 依赖 PyMuPDF；默认 `D:\Python3.12.9\python.exe`，可用 `RECRUITMENT_PYTHON_BIN` 覆盖 |
| 合成简历 | `fixtures/synthetic-resume-screening-repro.pdf`（仓库内；由同目录 `fixtures/build-synthetic-resume.py` 生成） |

**不需要**先跑 `manual/apply-demo-rubric.mjs`，**不需要**先 `UPDATE application.rubric_version_id`。
岗位、rubric、审批、申请、决策全部由脚本经工具链自己建出来。

## 它做什么（每一步都是真实的 `tool.execute()`）

| STEP | 工具 | 说明 |
|---|---|---|
| 0 | —（只读 SQL） | 预检：库 / 迁移 / 演示租户与 actor / 既有岗位 / 全表行数快照 |
| 1 | `recruitment_job_create` | 建固定 code 的岗位 + 2 条机械型 rubric 准则（`0.5`+`0.5`，两条 MUST_HAVE）；只写 `approval(PENDING)` |
| 2 | `recruitment_job_rubric_approve` | **人机闸门照常调用**（宿主替身 `allow-once`，只替"人"不替闸门）→ `APPROVED` + 把 `job.current_rubric_version_id` 指过去 |
| 3 | `recruitment_application_intake` | 合成简历 PDF → candidate + application；**F1 验收点**：新建申请必须已被钉上该 rubric 版本 |
| 4 | `recruitment_screening_evaluate` | 只读评估；要求 `rubric.resolution=APPLICATION_PINNED`、`what_if=false`、`rubric_pin_required=false` |
| 5 | `recruitment_decision_record` | `decision_scope=SCREENING`，D-95 IN_CHAT v2（逐字原话 + 服务端同一份 `confirmationTextSha256`）→ **真实写库** |
| 6 | —（只读 SQL） | DB 读回：决策行 + 内部事件 + 申请链条 + 行数差 |

`pg` 只用于 **SELECT 读回与行数统计**；写只经过工具。

## 结果怎么看

- 每个 run 目录（`evidence/experiments/2026-11-14-screening-decision-repro/run-<时间戳>/`）里有
  `run.log`（完整真实输出）、`step-NN-*.json`（每步请求/回执/行数差/读回）、
  `summary.json`、`db-readback.txt`、`command.txt`；
- `summary.json` 里三个键直接回答验收问题：
  `decision`（DB 读回的那一行）、`decision_written_this_run`、`application.rubric_version_id`（F1 是否钉住）；
- 想**不依赖 harness 代码**再验证一次：
  `node dsh/dsh-recruitment/manual/screening-decision/db-readback-independent.mjs <decision_id>`

## 幂等性（第二次跑会发生什么，为什么不会重复落一条）

脚本用**固定 job code**（默认 `REPRO-S6S7-DECISION`，可用 `REPRO_JOB_CODE` 覆盖）+ **固定合成身份**，
所以第二次跑是"同一件事重放"，不是"再记一次":

1. `job_create` → `INVALID_ARGS / DUPLICATE_JOB_CODE`（`uq_job_code(tenant_id, code)`，SQLSTATE 23505）；
   脚本此时**只读** SELECT 找回既有岗位继续（不删行、不 UPDATE）；
2. `job_rubric_approve` → `outcome=NO_OP, replayed=true`（批准已生效，零额外写入、不再问人）；
3. `application_intake` → `application_action=REUSED`（同 `(candidate, job)` 复用同一条申请）；
4. `decision_record(SCREENING)` → `ALREADY_DECIDED / SCOPE_ALREADY_DECIDED`（写库前 STEP 3 即拒绝；
   `0008` 的 `uq_decision_current` 可延迟排斥约束是并发/重入时的最后防线）；
5. 末态：**全表行数差 `{}`**，同一申请 current SCREENING 决策仍为 1 条。

退出码：两种情形都算 PASS（`0`）——首次要求"决策真的写进去"，重跑要求"被唯一性拒绝且零新增"。
脚本用库内事实而不是 `run_mode` 决定期望，所以**半途中断后重新执行**也能收敛（不会重复写、也不会假装成功）。

## 已发现的产品缺陷（本 lane 只报告，不改 `src/**`）

**判断型 rubric 准则会让 `screening_evaluate` 崩溃**（`probe-judgment-criterion-bug.mjs` 可复现）：

- `recruitment_job_create` 把准则归一化成固定 9 键，判断型准则（只给 `question`）落库是 `"field": null`；
- `recruitment_screening_evaluate` 的 `evaluateCriterion()` 只用 `criterion.field === undefined` 判判断型，
  `null` 掉进 `resolveFieldFact(ctx, null)` → `TypeError: Cannot read properties of null (reading 'startsWith')`
  （`src/tools/screening-evaluate.ts:965`）；
- 后果：**凡是用产品入口建出来、含判断型准则的 rubric，S7 一律评估不了**。
  之前那次"能跑通"的验收 rubric 是**手工 SQL 插的**，那份 JSON 里判断型准则**没有 `field` 键**，
  恰好绕过了这个分支 —— 反过来印证了"手钉 rubric"掩盖了产品缺陷。

复现：`node dsh/dsh-recruitment/manual/screening-decision/probe-judgment-criterion-bug.mjs`
（走真实 `job_create → approve → intake → screening_evaluate`，退出码 0 = 缺陷复现）。
修复方向（需 `src/**` 的所有者决定）：`evaluateCriterion` 用 `field == null` 判判断型，或 `job_create` 落库时省略 null 键。

## 其它已知限制（不是缺陷，如实标注）

- 决策人是配置里的 **HR 专员 actor**（`…0103`，HUMAN），而演示部门登记招聘负责人是 `…0102`，
  所以决策回执带 `DECIDER_NOT_HIRING_MANAGER` 警告（DC-14：v1.0 不拦截，只记录）；
- 全程合成数据 → `labels.provenance=FIXTURE`、回执带 `FIXTURE_BASIS` 警告；
- `screening_evaluate` 的 `as_of` 必须用**现在**：紧接在 rubric 批准之后用 `now-5s` 会让
  `approved(v, as_of)` 判成"当时还没批"（`NO_RUBRIC/NO_APPROVED_RUBRIC`）。这是 `as_of` 语义的正确行为，
  第一次写这个 harness 时踩过（见 evidence 里 run-2026-11-14T12-07-49-638Z）。
- 首次跑会在库里留下 `REPRO-*` 岗位/申请/决策（固定 code 唯一，重跑复用）。要换一套"干净"的，
  用 `REPRO_JOB_CODE=...`，**不要删库**。

## 文件清单

| 文件 | 作用 |
|---|---|
| `run-screening-decision.mjs` | 主 harness（六步，含 DB 读回与幂等判定） |
| `probe-judgment-criterion-bug.mjs` | 判断型准则缺陷的独立复现 |
| `db-readback-independent.mjs` | 不依赖 harness 逻辑的只读 SQL 旁证 |
| `fixtures/build-synthetic-resume.py` | 生成合成简历 PDF（R7：无任何真实候选人资料） |
| `fixtures/synthetic-resume-screening-repro.pdf` | 上述脚本产物（`sha256=56f93d3b…`，10931 bytes，2 页，有原生文字层） |

R7：合成身份是「示例甲」/ `repro.candidate.a@example.test` / `+8613600004242`，均为保留示例值；
日志与读回里候选人联系方式打码。
