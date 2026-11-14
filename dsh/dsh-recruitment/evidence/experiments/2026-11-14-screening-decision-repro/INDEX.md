# 证据索引 · S6→S7 决策落库可复现（2026-11-14）

被质疑的对象：「DB 里唯一那条 SCREENING 决策来自仓库外的脚本 + 手工钉 rubric，仓库里无法复现」。

本目录的证据结论：**同一条链路现在可以在仓库内、经产品工具、不带任何手工 SQL 重跑出来**；
第二次跑会被唯一性挡住且零新增；同时顺手撞出一个**此前被"手钉 rubric"掩盖的产品缺陷**。

- 脚本：`dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs`（说明见同目录 `README.md`）
- 规范命令（无额外环境变量；密码按约定从环境变量注入，**不写进任何文件/日志**）：
```powershell
$env:RECRUITMENT_DB_PASSWORD='<本机演示库密码>'
node dsh/dsh-recruitment/manual/screening-decision/run-screening-decision.mjs
```
- 代码状态：证据跨了三个 HEAD（**写这批证据期间其它 lane 在提交**，全部记录在每次 run 的 `run-meta.json.git_head`）：
  `d6f4aa5`（F1 修复还在工作区未提交）→ `ce2983b` → **`b2d51cd`（当前 HEAD；F1 的 `resolvePinnableRubricVersion` 已随提交进入 `src/tools/application-intake.ts`）**。
  每个 run 的 `run-meta.json` 还记录了 5 个 `src/tools/*.ts` 的 sha256，证据可对齐到具体代码状态；
  `summary.json.harness.sha256` 对齐到当时的 harness。
  注意：**F1 修复已落在当前 HEAD 里**，所以这条链路不再依赖未提交改动。

## 1. 主证据：FIRST_RUN —— 决策真的写进 DB

**当前 HEAD（`b2d51cd`）上的完整一次**：`run-2026-11-14T12-19-04-365Z/`（`EXIT=0`，六步全 PASS）
命令：`$env:REPRO_JOB_CODE='REPRO-S6S7-DECISION-3'` + 规范 node 命令
（用新 code 是为了在本机已有 `REPRO-*` 残留的库上演示"从零建岗位"；干净库里直接用默认 code 即可）

同一脚本在 `d6f4aa5` 上也跑出过一次等价的 FIRST_RUN：`run-2026-11-14T12-12-31-537Z/`
（decision `3742cde3-2448-4930-a203-e368a285291e`，旁证见 `db-readback-independent-d6f4aa5.txt`）。

关键真实回执（摘自 `run.log` / `summary.json`）：

| STEP | 真实回执（摘要） | 行数差 |
|---|---|---|
| 1 `job_create` | `outcome=CREATED`，job `4b46d9f7-3956-4c55-8907-b5dde88edbdf`，rubric v1 `dac1002a-367f-43e1-b583-b8479d407e2e`，`approval=PENDING` | `+job +job_version +rubric_version +approval` |
| 2 `job_rubric_approve` | `outcome=APPROVED replayed=false gate={"requested":true,"result":"allowed-once"}`；`job.current_rubric_version_id` → `dac1002a…`；approval `APPROVED` 且 `hash_match=true` | `+event_inbox:2` |
| 3 `application_intake` | `status=OK application_action=CREATED`，application `a6eaa0af-bd46-431d-8c1c-b63ae86711ee`，**`application.rubric_version_id=dac1002a…`（F1 已钉住）**，resume_version `cec1c064…` | `+application` |
| 4 `screening_evaluate` | `verdict=PASS`，`evaluation_digest=2eed996a958833e9dd9c6f22877a533b729e3d79b7613bde44863337f51d58b1`，`rubric.resolution=APPLICATION_PINNED`、`what_if=false`、`rubric_pin_required=false`，`criteria_evaluated=true`，`labels=FIXTURE/MANUAL/CONNECTED` | `{}`（只读） |
| 5 `decision_record(SCREENING)` | `status=OK`，decision **`42324a14-e276-4b2d-827d-8f31b668a4f8`**，`decision_scope=SCREENING`、`stage_code=S7`、`result=ADVANCE`、`decided_by=11111111-1111-4111-8111-000000000103`、`decided_at=2026-11-14T12:19:07.337Z`、`basis_refs=4`；warnings `DECIDER_NOT_HIRING_MANAGER` + `FIXTURE_BASIS` | `+decision:1 +event_inbox:1` |
| 6 DB 读回 | 同一申请 current SCREENING 决策 **1 条**；内部事件 `decision.record` 1 条（`human_confirmation_preimage_version=2`） | `{}` |

（决策人是配置里的 HR 专员 `…0103`，演示部门的招聘负责人是 `…0102`，所以带 `DECIDER_NOT_HIRING_MANAGER`
警告——DC-14 规定 v1.0 只记录不拦截。）

## 2. 旁证：不经过 harness 代码，直接 SQL 读库

`db-readback-independent.txt`（由 `manual/screening-decision/db-readback-independent.mjs` 生成，只读；
`node dsh/dsh-recruitment/manual/screening-decision/db-readback-independent.mjs 42324a14-e276-4b2d-827d-8f31b668a4f8`）：

```json
{ "id": "42324a14-e276-4b2d-827d-8f31b668a4f8",
  "application_id": "a6eaa0af-bd46-431d-8c1c-b63ae86711ee",
  "decision_scope": "SCREENING", "stage_code": "S7", "result": "ADVANCE",
  "decided_by_actor_id": "11111111-1111-4111-8111-000000000103",
  "decided_at": "2026-11-14T12:19:07.337Z",
  "record_version": 1, "superseded_by_decision_id": null,
  "basis_refs": [ RUBRIC_VERSION, AUTHORITY, SCREENING_EVALUATION, RESUME_VERSION ] }
```

内部事件（`recruitment.event_inbox`）：`event_type=decision.record`、
`idempotency_key=decision:42324a14-…`、`trust_level=INTERNAL`、
`human_confirmation_method=IN_CHAT`、`preimage_version=2`；
唯一性：同申请 `current_screening_decisions = 1`。
（`d6f4aa5` 上那次 FIRST_RUN 的等价旁证：`db-readback-independent-d6f4aa5.txt`，decision `3742cde3-…`。）

## 3. 幂等：第二次跑的真实输出

目录：`run-2026-11-14T12-12-46-973Z/`（同 code 立刻再跑，`EXIT=0`）

| STEP | 真实回执（摘要） |
|---|---|
| 1 `job_create` | `INVALID_ARGS` / `reason_code=DUPLICATE_JOB_CODE`（`constraint=uq_job_code`, `sqlstate=23505`）→ 只读 SELECT 复用既有岗位 |
| 2 `job_rubric_approve` | `outcome=NO_OP replayed=true`（`gate.requested=false`） |
| 3 `application_intake` | `status=OK application_action=REUSED`（同一条申请 `4ddf49ce…`） |
| 4 `screening_evaluate` | `verdict=PASS`（`prior_screening` 已带上既有决策，digest 与首次不同属预期） |
| 5 `decision_record(SCREENING)` | `ALREADY_DECIDED` / `reason_code=SCOPE_ALREADY_DECIDED`，`detail.existing_decision_id=3742cde3…`，**行数差 `{}`** |
| 6 DB 读回 | current SCREENING 决策仍 **1 条**；本次行数变化 `{}` |

第三个 run（`run-2026-11-14T12-13-46-538Z`）用的就是 README 里的规范命令（默认 code），同为 RERUN、零新增行。
当前 HEAD 上的同款重跑：`run-2026-11-14T12-19-18-364Z/`（`REPRO-S6S7-DECISION-3` 连跑第二次，同样零新增行）。

## 4. 复现出的产品缺陷（只报告，不改 src）

目录：`bug-judgment-criterion/run-2026-11-14T12-14-34-230Z/`（`probe-judgment-criterion-bug.mjs`，`EXIT=0` = 复现成功）

- `job_create` 落库的判断型准则：`team_lead: field=null question="是否有 ≥1 年、≥3 人的直接带团队经历？"`
  （`rubric-dimensions.json`）；对照：手工 SQL 插的 demo rubric 该准则**没有 `field` 键**。
- `screening_evaluate` → `TypeError: Cannot read properties of null (reading 'startsWith')`
  ```
  at resolveFieldFact  (src/tools/screening-evaluate.ts:965)
  at evaluateCriterion (src/tools/screening-evaluate.ts:1278)
  at evaluateInTransaction (src/tools/screening-evaluate.ts:1750)
  ```
- 结论：**用产品入口建出来、含判断型准则的 rubric，S7 一律评估不了**；此前"能跑通"的验收 rubric 是手工 SQL 插的，
  恰好绕开该分支 —— 这既解释了"为什么要手钉 rubric"，也说明手钉掩盖了缺陷。
- 影响面：该 job 上没有任何决策落库（`db-readback-independent.txt` ① 中 `REPRO-JUDGMENT-CRIT` 的 decision 列为 null）。

## 5. 本目录全部 run 一览（含途中的真实失败，不隐去）

| run | job code | 结果 | 说明 |
|---|---|---|---|
| `run-2026-11-14T12-07-49-638Z` | `REPRO-S6S7-SCREENING` | BLOCKED（EXIT=3） | harness 第一版把 `screening_evaluate.as_of` 设成 `now-5s`，而 rubric 是 1 秒前才批准的 → `NO_RUBRIC/NO_APPROVED_RUBRIC`。**harness 的错，不是产品缺陷**（as_of 语义正确） |
| `run-2026-11-14T12-09-53-660Z` | `REPRO-S6S7-DECISION-A` | BLOCKED（EXIT=3） | as_of 修好后，rubric 含判断型准则 → 撞上图那个 `TypeError`（产品缺陷） |
| `run-2026-11-14T12-11-47-564Z` | `REPRO-S6S7-DECISION` | 中止（EXIT=1） | 决策已真实写入（`3dff62db-…`）；但 harness 自己的读回 SQL 把 `event_inbox.source_object_id`（text）按 `uuid[]` 传参 → `42883 操作符不存在: text = uuid`，在写 summary 前中止。**harness 的错** |
| `run-2026-11-14T12-12-31-537Z` | `REPRO-S6S7-DECISION-2` | **PASS FIRST_RUN**（EXIT=0） | 六步全 PASS，决策 `3742cde3-…` 落库 |
| `run-2026-11-14T12-12-46-973Z` | `REPRO-S6S7-DECISION-2` | **PASS RERUN**（EXIT=0） | 零新增行，`ALREADY_DECIDED` |
| `run-2026-11-14T12-13-46-538Z` | `REPRO-S6S7-DECISION` | **PASS RERUN**（EXIT=0） | 规范命令路径，零新增行 |
| `run-2026-11-14T12-18-08-527Z` | `REPRO-S6S7-DECISION` | **PASS RERUN**（EXIT=0） | 规范命令跑（HEAD `ce2983b`）；`summary.json.harness.sha256` 与仓库里最终脚本的 sha256 一致（`edcd210e…`） |
| `run-2026-11-14T12-19-04-365Z` | `REPRO-S6S7-DECISION-3` | **PASS FIRST_RUN**（EXIT=0） | **当前 HEAD `b2d51cd` 上从零建岗位的完整一次**，决策 `42324a14-…` 落库 |
| `run-2026-11-14T12-19-18-364Z` | `REPRO-S6S7-DECISION-3` | **PASS RERUN**（EXIT=0） | 当前 HEAD 上的重跑：零新增行、`ALREADY_DECIDED` |
| `bug-judgment-criterion/run-2026-11-14T12-14-34-230Z` | `REPRO-JUDGMENT-CRIT` | 缺陷复现（EXIT=0） | 判断型准则 `field=null` → screening `TypeError` |

每次 run 目录都含：`command.txt`（命令原文）、`run.log`（完整真实输出）、`step-NN-*.json`（逐步请求/回执/行数差/读回）、
`summary.json`、`db-readback.txt`；失败的两个 run 含 `blocked.json`。

## 6. R7 声明

全程合成数据：姓名「示例甲」、邮箱 `repro.candidate.a@example.test`、电话 `+8613600004242`（保留示例值），
fixture `sha256=56f93d3be582a988a4713c1cba22c411e17b20371de73c2147962adde4c24ce5`；
所有读回里的候选人联系方式均已打码。**没有触碰任何真实候选人资料。**
