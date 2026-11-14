# 23 · S6–S10 全链路独立验收与审查（2026-11-14）

> **窗口身份**：S6–S10 独立验收审查窗口（reviewer-s6-s10），只读代码/文档、只写本报告。
> **纪律**：不接受任何自述；结论只来自本窗口现场执行的命令 + 真实输出 + DB 读回。
> **PII**：本报告只出现 id / 哈希 / 计数 / 脱敏值；未转载任何候选人姓名、电话、邮箱或简历原文。
> **源码改动**：无。未 commit、未 push、未切分支。临时探针脚本只写在 `%TEMP%`，不在仓库内。

---

## 0. 一句话结论

**S6–S10 现在是「半通」：12 个范围内工具里 6 个可验收、6 个 BLOCKED；**
**管道不是断在代码能不能跑（测试全绿、工具都能从入口调到、DB 也真写进去了），而是断在四处不变量：**
**① S6 的身份来源闸门被绕过（OCR / agent_read 标识可驱动自动关联）；② S7 的人决策没有写入路径（`decision_record` 明确拒收 `SCREENING`）；③ S8 排期与 S10 面评的人机闸门未实现（已实测：无 approval 也能写库）；④ 全链路没有一条申请真正从 S6 走到 S10（走到 S10 的那条申请没有材料，走完 S6 的申请没有 S7 结论）。**

**最严重的 3 个问题**

| # | 问题 | 为什么最严重 |
|---|---|---|
| 1 | **S6 身份来源闸门失效**：`structured_json` 的 `agent_read` 电话/邮箱被当成强标识；D-98 的 OCR 文本被 converter 重新标成 `native_text` 并进入 `identity_merge_eligible` | 可能把一份材料自动挂到**错误候选人**名下（D-67 / IR-F4 明令禁止），且下游全部跟着错 |
| 2 | **S8/S10 人机闸门未实现**：`interview_schedule` / `scorecard_submit` 没有 `ctx.approval`，只校验配置 actor 是 `HUMAN` | Agent 可以「以 HR 103 的身份」写面评与排期；本窗口已在回滚事务里实测 **无 approval 写入成功** |
| 3 | **S7 的 `decision(scope='SCREENING')` 无写入路径**：`recruitment_decision_record` 的 scope 只有 `STAGE/FINAL`，传 `SCREENING` 直接 `DECISION_SCOPE_NOT_S10` | docs/18 Golden Path 第 4 步写的正是 `screening_evaluate → decision_record(SCREENING)`，S7→S8 的「人决定」事实无处落库，链路在 S7 断开 |

> **第二轮复验更新（2026-11-14 07:33 起，修复后；完整证据见 §8）。**
> 修复 lane 已提交 `a8d3eea`（S8/S10 闸门）、`77c881b`（DB 超时）、`5e4c7c8`（approval 120s 超时）、`6d253f4`（S7 决策 + 23P01 + D-95 v2 + material）。
> 本窗口独立复跑后：**S7 决策路径、S8/S10 人机闸门、23P01 映射、D-95 v2、material 恢复标记 均转 PASS**；
> **S6 身份闸门修复仍是「未提交 WIP」（行为已实测修复，但不可签收）**；
> **S8 四 intent、S3 批准入口、真实简历门槛、阶段推进、端到端 仍未闭合**。
> 逐项结论与未闭合清单见 **§8**（第一轮的 706 行内容作为历史记录保留，不覆盖）。

---

## 1. 审查对象与证据基线

### 1.1 被测对象（会变，已现场探测）

| 项 | 值 |
|---|---|
| 仓库 | `D:\12412\dsh工作区\projects\recruitment-agent` |
| 分支 | `feat/unified-document-intake` |
| **详细审查基线 commit** | **`c2762a2`**（本窗口开始时的干净工作树） |
| **审查期间分支被并发 lane 推进到** | **`9479f52`**（`ca5a24d` D-99、`9479f52` D-100） |
| 并发 lane 改了哪些文件 | 已提交：`src/document/**`、`test/document/**`、`test/regression/**`、`docs/11`、`docs/17`（追加 D-99/D-100）、`dsh/profile/recruitment/cordis.patch.yml`；**范围内文件（`src/index.ts` / `src/tools/S6–S10` / `src/db/**` / `contracts/**` / `db/migrations/**`）在 `c2762a2..9479f52` 之间零差异**（`git diff --stat` 已核对）。 |
| 报告落盘时的额外并发变更（未提交、范围外） | `converter/src/pdf_layout.py`、`converter/src/pdf_reader.py`（版面几何分栏，D-97 第二批，工作树 `M`）。经 diff 核对：**未改** `resume_fields.py`，也**未改** OCR 兜底/字段 provenance 相关代码；本报告引用的 `pdf_reader.py:392-408`（OCR 兜底）与 `resume_fields.py` 结论仍按 `9479f52` 成立。 |
| 范围外、本报告不判 | `src/document/**`、`converter/**`、`src/tools/document-read.ts`、`page-image`、`vision-fallback` |

> 因此：本报告的代码结论在 `9479f52` 上仍成立；测试与 DB 证据同时给出 `c2762a2`（724 条）与 `9479f52`（766 条）两组，便于复审对账。

### 1.2 测试四数（R3）

**`c2762a2`，干净工作树**（本窗口第一组证据）：

```powershell
cd "D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='123456'; node --test
```
```text
ℹ tests 724
ℹ pass 724
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
[status: completed, exit code: 0]
```

**`9479f52`（并发 lane 合入 document/regression 测试后）复跑**：

```text
ℹ tests 766
ℹ pass 766
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
[status: completed, exit code: 0]
```

**只跑集成层（15 个文件、真连 `ra_s6s7`）**：

```text
ℹ tests 182
ℹ pass 182
ℹ fail 0
ℹ skipped 0
```

**判定**：R3 的四个数在两组基线上都是 **tests=724/766, pass=724/766, fail=0, skipped=0**，不存在「静默 skip」。  
但注意：**测试全绿不等于链路可验收**——见 §3 的 BLOCKED，其中 3 条是测试根本覆盖不到的（测试反而把错误行为断言成正确：`test/unit/application-intake-structured.test.ts:248` 断言 `material.strong[0].provenance === 'agent_read'`）。

### 1.3 接线证据（R2）：19 个工具真的注册 + 一次真实调用

用插件自己的入口 `apply()` 捕获注册表（不是单测里的局部函数），再用捕获到的定义执行：

```text
REGISTERED=19
NAMES=recruitment_application_intake,recruitment_candidate_get,recruitment_decision_record,
recruitment_document_read,recruitment_evaluation_summarize,recruitment_interview_get,
recruitment_interview_schedule,recruitment_job_create,recruitment_job_get,recruitment_job_update,
recruitment_model_text_merge,recruitment_page_image,recruitment_resume_read,
recruitment_resume_serialize,recruitment_scorecard_submit,recruitment_screening_evaluate,
recruitment_structure_validate,recruitment_transcript_import,recruitment_transcript_read
```

真实调用（同一批注册定义，连 `ra_s6s7`）：

| 调用 | 真实结果 |
|---|---|
| `recruitment_job_get` | `OK labels={"provenance":"LIVE","trigger":"MANUAL","connection":"CONNECTED"} job=DEMO-BE-001/OPEN rubric=v2 current=true` |
| `recruitment_candidate_get` | `OK identity_status=ACTIVE contacts.visible=false email=z***@demo-recruitment.test apps=1`（PII 默认脱敏） |
| `recruitment_interview_get` | `OK count=1 transcript=READY eval_ready=false` |
| `recruitment_transcript_read` | `OK state=READY reason=CANONICAL_STATUS text_returned=false` |
| `recruitment_evaluation_summarize` | `OK advisory=true read_only=true coverage{required_total:2,submitted:2,missing:0} tally{advance:2} ready=false permitted=[]` |
| `recruitment_screening_evaluate` | 契约错误 `BLOCKED_BY_REVIEW(MATERIAL_NOT_BOUND)`，`human_queue_checked=7`（工具真跑了 7 条阻断检查） |
| `recruitment_scorecard_submit` | 契约错误 `INTERVIEWER_MISMATCH(ACTOR_NOT_INTERVIEWER)`（作者闸门生效，未写库） |
| `recruitment_decision_record` | 契约错误 `ALREADY_DECIDED`（IN_CHAT 路径、ctx 无 approval 服务，仍未写库） |

**未配置替身**（第二组 `apply({})`，缺 converter + database）：

```text
UNCONFIGURED_REGISTERED=19
UNCONFIGURED_NOT_CONFIGURED_COUNT=19/19
```
即 19 个工具在未配置时仍注册，调用报 `NOT_CONFIGURED`，没有静默降级/假数据。  
11 个写工具也都用空参数真实敲过一次 `execute()`，全部返回契约形 `INVALID_ARGS`（未写库）。

> 边界（必须写清）：本窗口证明的是「**host 调用的插件入口 `apply()` 注册了 19 个工具，且注册出来的定义可真实执行并连库**」。**没有**重新跑一次「模型在 Web/headless 会话里调用」的宿主级会话（`docs/18` 引用的 2026-11-13 浏览器证据是**自述 + 截图**，本窗口未复现）。因此严格意义的「运行中的入口」证据 = `src/index.ts:377-400` 注册 + 本组真实调用；宿主会话重放列入复审清单（§6）。

### 1.4 数据库实况（不是只看代码）

库 `ra_s6s7`，`psql` 直查：

```text
recruitment schema 表数 = 47
recruitment.schema_migration = 0001..0010 全登记（10 行）
stage_catalog = 12 行（S1–S12，in_v1_scope：S3/S6/S7/S8/S9/S10）
```

迁移自检：`verify-0006 / verify-0007 / verify-0008 / verify-0009 / verify-0010 / verify.sql` **全部 PASS**（命令与尾部输出见附录 A.3）。

现有业务行（演示/合成数据，标签 `internal`）：

| 表 | 行数 | 备注 |
|---|---|---|
| `candidate` | 8 | 全 ACTIVE |
| `application` | 9 | 7 条 `S6`、1 条 `S7`、1 条 `S9` |
| `resume_version` | 9 | PARSED 7 / PARTIAL 2 |
| `interview` | 6 | 其中 2 条 `stage_code='S9'`（见 §3 P2-06，数据卫生） |
| `scorecard` | 2 | 都已 SUBMITTED 且 current 唯一 |
| `decision` | **1** | `STAGE / S10 / ADVANCE / decided_by=…103`，current 唯一 |
| `transcript_artifact` | 4 | 全部 `FIXTURE`（provider=`LOCAL_DEMO`/`manual_import`） |

**关键断链 DB 事实**（§3 P1-08/09 的证据）：

```text
decision 按 scope 分组：STAGE=1，SCREENING=0，FINAL=0
走到 S10 决策的那条申请 111…701：resume_version_id IS NULL（没有材料）、无 SCREENING 决策
有材料的那 7 条申请：current_stage_code 全停在 S6，没有任何 screening/evaluation/decision 行
```

---

## 2. 逐工具判定（范围内 12 个工具）

> 判定口径：**PASS** = R2 可达 + 证据可复现 + 与本阶段契约一致；**BLOCKED** = 有一条硬约束不成立（不是「代码看着像」）；**风险** = 可运行但标签/边界/文档有歧义。

| # | 工具 | R2 可达 | 测试 | 标签诚实 | 契约一致 | 判定 |
|---|---|---|---|---|---|---|
| 1 | `recruitment_application_intake`（S6） | ✅ 注册 + 真实负向调用 | ✅ 集成/单测（真库，回滚） | ✅ `FIXTURE/MANUAL/CONNECTED`，`source_kind=LOCAL_FILE`、事件 `internal` | ❌ **身份来源闸门被绕过**（D-67/IR-F4/D3）：`agent_read` 与 OCR 文本可驱动自动关联 | **BLOCKED** |
| 2 | `recruitment_screening_evaluate`（S7） | ✅ 注册 + 真实调用（7 条阻断检查真跑） | ✅ 只读事务 + 静态断言 + 真库集成 | ✅ provenance 按材料链 `event_inbox.provider` 计算 | ❌ **S7 的人决策无落库路径**：`decision_record` 拒收 `SCREENING`；Golden Path 第 4 步无法完成 | **BLOCKED** |
| 3 | `recruitment_job_create`（S3） | ⚠️ 注册 + 负向调用；**人类批准入口不可达** | ✅ 单测/集成 | ⚠️ 写死 `LIVE`（演示租户/合成数据） | ⚠️ rubric 只落 `PENDING`；`decideRubricApproval()` 只有 CLI（`manual/job-line/approve-rubric.mjs`），未注册工具 | **BLOCKED**（批准路径） |
| 4 | `recruitment_job_get`（S3） | ✅ 注册 + 真实调用 | ✅ | ✅ `LIVE/MANUAL/CONNECTED`（契约 §1.4 语义） | ✅ criteria 逐字回显、`rubric_absence` 分支在 | **PASS** |
| 5 | `recruitment_interview_schedule`（S8） | ✅ 注册 + 回滚事务内真实成功写入 | ✅ 46 单测 + 29 集成 | ⚠️ 写死 `LIVE`（演示租户）；`connection=NOT_CONNECTED`、`external_call_made=false` 诚实 | ❌ **无 approval 闸门（D-79）**；❌ 契约/D-62 要求 4 个 intent，代码只有 `CREATE` | **BLOCKED** |
| 6 | `recruitment_interview_get`（S8） | ✅ 注册 + 真实调用 | ✅ | ✅ `LIVE/MANUAL/CONNECTED`；artifact 级三轴逐个回显 | ✅ 与 `schedule` 共用同一 `interviews[]` 实现 | **PASS** |
| 7 | `recruitment_transcript_import`（S9） | ✅ 注册 + 负向调用；真库已有 4 条产物 | ✅ | ✅ `trigger` 恒 `MANUAL`、`connection` 恒 `NOT_CONNECTED`；`provenance=FIXTURE` 当且仅当 `DEMO_SAMPLE` | ⚠️ `PLATFORM_EXPORT` 的 `provider_artifact_id` 是本地生成 `local:…`，`LIVE` 依赖人工自述回执（附警告）；**不满足 D-1 demo gate 的「真实 provider artifact」** | **PASS（人工导入）/ 风险** |
| 8 | `recruitment_transcript_read`（S9） | ✅ 注册 + 真实调用 | ✅ | ✅ 只读、无时钟、`as_of` 回显 | ✅ D-96 `ARTIFACT_EMPTY` 已回抄进 `transcript-rules.md`（2026-11-14 增补） | **PASS** |
| 9 | `recruitment_scorecard_submit`（S10） | ✅ 注册 + 负向调用 + **回滚事务内真实写入成功** | ✅ | ✅ provenance 按材料链+会议计算，FIXTURE/LIVE 分明 | ❌ **无 approval 闸门（D-79）**：只查 `actor.kind='HUMAN'`；配置 actor 恰好是两名 SCHEDULED 面试的面试官 | **BLOCKED** |
| 10 | `recruitment_evaluation_summarize`（S10） | ✅ 注册 + 真实调用 | ✅ | ✅ 只读、`advisory=true`、无墙钟 | ✅ 输出不含 `result/decided_by_actor_id/decided_at`（真实调用核过） | **PASS** |
| 11 | `recruitment_decision_record`（S10） | ✅ 注册 + 真实调用（IN_CHAT、无 approval 服务下返回 `ALREADY_DECIDED`） | ✅ | ⚠️ `basis_refs[SUMMARY].provenance` 未由工具写入（真实决策行里缺失） | ❌ **D-95 哈希 pre-image 未含 `confirmation_text`/actor/time**；❌ **并发重复决策的 23505→`ALREADY_DECIDED` 映射已失效**（0008 改成 DEFERRABLE EXCLUDE，提交时是 23P01）；❌ 契约未回抄 D-95 | **BLOCKED** |
| 12 | `recruitment_candidate_get` | ✅ 注册 + 真实调用 | ✅ | ⚠️ **没有三维标签**（其他工具都有）；输出用 `source:'DATABASE'` 代替 | ⚠️ 工具面已删 `provenance/stub`，但 `CONTRACT.md §4` 仍是 stub 契约，未回抄（R5） | **PASS** |

**计数**：**PASS 6**（job-get、interview-get、transcript-import、transcript-read、evaluation-summarize、candidate-get）／**BLOCKED 6**（application-intake、screening-evaluate、job-create 批准路径、interview-schedule、scorecard-submit、decision-record）。
**附加**：范围内还检查了 `src/connectors/feishu/**`——**非工具、未被任何注册工具 import，只被单测引用** → 按 R2 = **BLOCKED**（详见 P2-05）。

---

## 3. 发现的问题（严重度 / 文件:行 / 现象 / 为什么 / 建议）

### P0-01 · S6 身份来源闸门被绕过（agent_read + OCR 文本可驱动自动关联）

**文件:行**
- `src/tools/application-intake.ts:723-777`（`observeAgentIdentity`：把 `agent_read` 的电话/邮箱直接 `strong.push`）
- `src/tools/application-intake.ts:1162-1167`（用 `material.strong` 做 `matchByStrongIds` + `decideIdentity`）
- `converter/src/pdf_reader.py:392-408`（OCR 整页替换，块 `provenance='ocr'`）
- `converter/src/resume_fields.py:323-326`（`_field` 默认 `provenance="native_text"`）、`:776-780`（电话/邮箱字段从这里产出）、`:988-1007`（`identity_merge_eligible`）

**现象（两条独立路径，均已实测）**

1. **agent 结构化路径**：只要调用 `structured_json`，身份强标识改由模型结果产出并标 `agent_read`，随后**直接进入自动匹配/新建候选人的判定**。单测甚至断言了这个行为：
   ```text
   test/unit/application-intake-structured.test.ts:248
   assert.equal(material.strong[0]?.provenance, 'agent_read')
   ```
2. **OCR 路径**：D-98 让整页 OCR 的块带 `provenance='ocr'`，但 `resume_fields.analyze()` 基于这些块抽电话/邮箱时仍用默认值 `native_text`。本窗口用合成块直接调 `analyze()` 复现：
   ```text
   输入：块 provenance='ocr'，issues_before=[{pdf_text_recovered_by_ocr}]
   输出：phone.state=present  phone.provenance=native_text
        email.provenance=native_text
        identity_merge_eligible=['phone','email']
        identity_manual_review=[]
   ```
   而 `src/db/identity.ts:154` 的来源闸门只认字符串 `native_text`，于是 OCR 认出来的号码/邮箱被当成原生强标识，可自动建候选人/关联旧档。

**为什么是问题**
- D-67（晚于 D-52）明确：**`ocr_title` / `model_read` / `agent_read` 三者全部适用 D3 红线，只有 `native_text` 且格式校验通过才可自动**；IR-F4 同旨；IR §5.4 把「把材料挂到谁名下」也纳入来源闸门（D8 在 D9 前）。
- 现实后果不是「显示错」：一份 OCR 错认一位数字的简历会被自动挂到别人名下，后续初筛/面试/决策全部错人。这与 docs/22 里「4/45 读不出」是同一层系统的另一面。

**建议（最短路径）**
1. `observeAgentIdentity` 不再产出可自动身份：`agent_read` 一律进 `blocked`（`reason: provenance_agent_read`），交人工/或仅在 native_text 缺失时作为「待核提示」；
2. converter 侧把块 provenance 传播到字段 provenance（`_find_pattern_field`/`_find_name` 读 `block.provenance`），OCR 块的字段标 `ocr`；
3. 给 `applyStructuredJson` 与 `analyze()` 各加一条回归：**agent/ocr 身份不得进入 `strong`**；
4. 同步 `src/db/material.ts` 的 issue 表（见 P1-05）。

---

### P0-02 · S7 的人决策没有写入路径（`SCREENING` scope 被工具本身拒收）

**文件:行**
- `docs/18-golden-path.md:60`：第 4 步 = `recruitment_screening_evaluate → recruitment_decision_record(scope='SCREENING')`
- `src/tools/decision-record.ts:298-301`：`decision_scope` enum 只有 `STAGE | FINAL`
- `src/tools/decision-record.ts:698-703`：传 `SCREENING` → `INVALID_ARGS(DECISION_SCOPE_NOT_S10)`
- `docs/17-decision-ledger.md:84`（D-16）：`Screening Result → decision(scope='SCREENING')`

**现象**
- 全库 `decision` 表按 scope 只有 `STAGE=1`；**`SCREENING=0`**，从未有任何初筛决策落库。
- 本窗口对 `decision_record` 传 `SCREENING` 的真实调用被工具自己拒绝（理由码 `DECISION_SCOPE_NOT_S10`），不是权限/环境问题。
- 另一方面 `screening_evaluate` 按契约 `advisory=true`、只读、**不允许落决策**（D-72 也重申只读）。
- 结果：**S7 的「人决定」既不能由读工具写，也不能由决策工具写**。S7→S8 的交接事实没有载体。

**为什么是问题**
- Golden Path 第 4 步按 docs/18 写法根本无法完成；「人只在 S7 决定一次」在数据层不可审计。
- 与 D-16「Screening Result 落 decision(SCREENING)」直接冲突；这是「契约/裁决要求的能力，代码里没有入口」。

**建议**
- 二选一并回抄权威：① 扩展 `decision_record` 支持 `SCREENING`（`basis_refs` 用 `SCREENING_DECISION` 同构的「本次评估」摘要；`interview_id` 禁止；`stage_code` 写 `S7`），或 ② 新增独立工具 `recruitment_screening_decision`（形状与 `decision_record` 同源，复用同一套人工确认/幂等/唯一性）。
- 落一条真实跑通：`application_id`（有材料+rubric）→ `screening_evaluate` → `decision(scope='SCREENING', stage_code='S7')` → DB 读回。没有这条，S7 不得标 PASS。

---

### P0-03 · S8 排期与 S10 面评的人机闸门未实现（D-79；已实测可无 approval 写入）

**文件:行**
- `src/index.ts:339-344`（schedule 只传 `database`）、`:354-361`（scorecard 只传 `database`）
- `src/tools/interview-schedule.ts:1576`（工厂签名只有 `ResolvedDatabaseConfig`；全文 `approval` 引用数 = 0）
- `src/tools/scorecard-submit.ts:1956`（工厂签名 `{ database }`；全文 `approval` 引用数 = 0）
- `src/tools/scorecard-submit.ts:1202`（只校验 `actor.kind='HUMAN'`）
- `docs/17-decision-ledger.md:656-672`（D-79 明列「S8 排期 / S10 面评与决策」必须 `inject:['tools','approval']` 且写库前 `ctx.approval.request`）
- `docs/18-golden-path.md:142-150`（同口径）

**现象（本窗口实测，均在**回滚事务**内完成，数据库最终零变化）**

1. **面评**：直接用真实库、真实面试 `304a58c1…`（`SCHEDULED`、`interviewer=配置 actor 111…103`、无当前面评）调用 `submitScorecardInTransaction`：
   ```text
   ACTOR_GUC= 11111111-1111-4111-8111-000000000103
   WROTE_WITHOUT_APPROVAL scorecard_id= 3d596725-… status= SUBMITTED author= …103
   ROWS before= 2 inside_tx= 3 labels= {"provenance":"FIXTURE",...}
   ROLLED_BACK rows_after= 2
   ```
   即：**没有任何 approval 调用，写入成功**。且 DB 里配置 actor 103 正好是 2 条 SCHEDULED 面试的必交面试官、当前无面评——Agent 在生产路径下可直接「代 HR 交面评」。
2. **排期**：同样在回滚事务内调用 `scheduleInTransaction`：
   ```text
   WROTE_WITHOUT_APPROVAL interview= 8a2baac9-… replayed=false external_call_made=false
   labels= {"provenance":"LIVE","trigger":"MANUAL","connection":"NOT_CONNECTED"}
   INTERVIEW_ROWS before= 6 inside_tx= 7   ROLLED_BACK rows_after= 6
   ```
   即：**没有任何 approval，排期成功**。

**为什么是问题**
- D-79 的落点是「结构性」而不是纪律性：`execute(args, exec)` 里没有「人还是 agent」的信息，所以必须靠 approval seam；现在这两个写工具连 seam 都不接，唯一防线是「配置的 actor 行 `kind='HUMAN'`」——这正是 D-79 要否定的做法。
- 与 docs/18 §6「第 4/5/7/8 步写入必须带人类 actor；agent 不得代填面评」直接冲突。

**建议**
- `index.ts` 把 `resolveApproval(ctx)` 同时传给 `createInterviewScheduleTool` / `createScorecardSubmitTool`；两个工具在**写库事务开始前**调 `approval.request`；`deny/unavailable/cancelled` → `BLOCKED_BY_APPROVAL`，一行不写；
- 用两条负例锁死：approval=unavailable 时 `interview`/`scorecard` 行数不变；approval=allow 时才写（本窗口的两段回滚探针可直接改造成回归测试）。

---

### P1-04 · 并发重复决策的 `ALREADY_DECIDED` 映射已失效（0008 的 DEFERRABLE EXCLUDE 在 COMMIT 抛 23P01）

**文件:行**
- `db/migrations/0008_decision_uniqueness.sql:410-419`：`uq_decision_current` 是 **EXCLUDE … DEFERRABLE INITIALLY DEFERRED**
- `src/tools/decision-record.ts:2169-2204`：只映射 `23505 / 23514 / 23503`
- `src/tools/decision-record.ts:2787-2789`：写事务由 `withActor` 的 `commit` 收尾（在写块 try/catch 之外）
- `contracts/evaluation/tool-contracts.md:101/506/600-601`：仍写「23505 → `ALREADY_DECIDED`」

**现象**
```text
-- 插入一条与现有 current 完全同键的决策，再强制立即检查：
insert … 'STAGE','S10' …
set constraints all immediate;
→ 错误: 互相冲突的键值违反排他约束 "uq_decision_current"   （SQLSTATE 23P01）
```
顺序调用会被工具 STEP 3 的「先查 current」挡住（本窗口真实调用返回 `ALREADY_DECIDED`，正确）；但**并发双插**时两条都能通过 STEP 3，后者在 COMMIT 才被 23P01 拒绝，而 `execute()` 的 `withActor` 不捕获/翻译这个提交错误 → 模型看到的是裸 DB 错误，不是契约的 `ALREADY_DECIDED`。

**为什么是问题**
- D-80 / 契约把「并发重复 → 23505 → ALREADY_DECIDED」当成库层防线；0008 把对象从 unique index 换成 deferred exclusion constraint 后，防线还在（DB 会在 COMMIT 拒绝），但**错误语义/可机检契约断掉了**。
- 这是「测试绿但契约指定的错误路径从未被测试覆盖」的典型：集成测试只测顺序重复。

**建议**
- 二选一并回抄：① 把 `withActor` 的 commit 包进 try/catch，捕获 23P01 且 constraint=`uq_decision_current` → `ALREADY_DECIDED`（推荐，改动小）；或 ② 0008 改回非延迟唯一索引（会失去「同一事务内先插后撤」的能力，需产品确认）。
- 加一条**并发**集成测试（两个连接、两个事务，断言后者得到 `ALREADY_DECIDED`）。
- 更新 `contracts/evaluation/*` 与 D-80 的「23505」表述（R5）。

---

### P1-05 · D-98 的 OCR 恢复码在 S6/S7 的第三份 issue 表里仍是 HARD

**文件:行**
- `src/db/material.ts:11-37`（HARD/SOFT 表；**没有** `pdf_text_recovered_by_ocr`）、`:51-57`（未知 code 一律 HARD）
- `converter/src/issues.py:51`（该 code 登记为 SOFT）
- `src/document/contracts/map-converter.ts:157-160`（document 层已登记 SOFT，并注释「两边必须同步」）

**现象**
```text
isHard(pdf_text_recovered_by_ocr)= true
hardCodes= ["pdf_text_recovered_by_ocr"]
mapParseStatus(complete, 1000, [recovered])= {"status":"PARTIAL"}
```
所以 D-98 修好的 3 份简历，在 document 层是「已恢复、可进结构化」，但到 S6 会被判 `PARTIAL`，到 S7 则 `hard_issue_count>0` → `absent` 降级为 `unreadable`（`screening-evaluate.ts:1127-1141`）。这是 D-98 自己记录过的「两份镜像清单只改一边」事故的**第三份**（`material.ts` 是 S6/S7 的私有副本）。

**为什么是问题**
- 同一份材料的严重度在三个层（converter / document / S6+S7）各有一套口径，D-85「同一层只能有一个真相」在 issue 严重度上没做到。
- 直接后果：D-98 的 3 份真实简历即使文字已可读，S7 仍然把它们当「读不全」，`verdict` 被推向 `NEEDS_REVIEW`——「读出来了」和「敢用来判断」之间静默掉档。

**建议**
- 把 `material.ts` 的 HARD/SOFT 表改为从**唯一来源**生成（或至少在 CI 加一条断言：`issues.py`/`map-converter.ts`/`material.ts` 三处一致）；
- 短期先补 `pdf_text_recovered_by_ocr` 进 SOFT，并加回归：`mapParseStatus('complete', N, [recovered]) === 'PARSED'`。

---

### P1-06 · D-95 的「原话进哈希」未实现；契约未回抄 `IN_CHAT`

**文件:行**
- `docs/17-decision-ledger.md:900-927`（D-95：`confirmation_text` 与 `confirmed_by_actor_id`/`confirmed_at` 一起进 `confirmation_text_sha256` pre-image）
- `src/tools/decision-record.ts:978-989`（`confirmationTextSha256` 仍只吃 `{result, reason, override_rationale, basis_refs}`）
- `src/tools/decision-record.ts:2583-2587`（`IN_CHAT` 完全跳过 approval）
- `contracts/evaluation/tool-contracts.md:424-445`、`contracts/evaluation/decision-rules.md:251-258`（仍写 `IN_APP_CONFIRM | SIGNED_RECORD`、四键 pre-image）

**现象**
- 真实决策行（DB）：`human_confirmation_method=IN_CHAT`，`confirmation_text` 存在 `event_inbox.payload`（本窗口已核对，不转载原文）；但决策表/哈希没有把「原话 + 确认人 + 确认时间」绑在一起。
- 因此 D-95 声称的「原话 + 哈希 + 会话日志三者对不上就能查出来」**只做到 2/3**：原话可查，哈希不覆盖它。
- 契约里根本没有 `IN_CHAT` 这个取值，也没有 `confirmation_text` 字段（R5：代码先改了、冻结合同没回抄）。

**为什么是问题**
- D-95 明确要求 `IN_CHAT` 的原话进 pre-image；现在若有人把 `confirmation_text` 换成另一句话（甚至换成一个不存在的「同意」），哈希与自动化校验都发现不了。
- 另一方面 D-95 承认的结构性残余风险（Agent 可以伪造原话）本报告不重复判为缺陷，但**「人只做一次决策」目前是流程约定，不是不可绕过的机制**——验收文档不得把它写成结构性闸门。

**建议**
- 按 D-95 改哈希：pre-image = `{result, reason, override_rationale, basis_refs, confirmation_text, confirmed_by_actor_id, confirmed_at}`（或按 D-95 原文再确认一次到底覆盖哪几个键，并回抄合同）；
- 把 `IN_CHAT` + `confirmation_text` 写进 `contracts/evaluation/tool-contracts.md` / `decision-rules.md`，同时更新 `docs/18`（见 P2-01）；
- 加两条测试：缺 `confirmation_text` → 拒；篡改 `confirmation_text` 而哈希不变 → 拒。

---

### P1-07 · S8 只实现 `CREATE`，与 D-62 四 intent 契约不一致

**文件:行**
- `docs/17-decision-ledger.md:485-489`（D-62：接受四合一 intent）
- `src/tools/interview-schedule.ts:92`（`intent` enum 只有 `CREATE`）
- `contracts/interview/tool-contracts.md:267-277`（四 intent 的入参与边）
- `docs/18-golden-path.md:85`（把 S8 标成「✅ 交付」）

**现象**
- `RESCHEDULE` / `CANCEL` / `WITHDRAW_INTERVIEWER` 全部走 `INVALID_ARGS(OUT_OF_RANGE)`；`VERSION_CONFLICT` 这条契约错误码在实现里没有可触发路径。
- Golden Path v1.0 的第 5 步只需要 `CREATE`，所以**演示路径可走**；但契约/D-62 的完整 S8 没有交付，docs/18 却写「交付」。

**为什么是问题**
- 这是典型的「文档说全了、实现只做了一个切片」：如果验收按 docs/18 签收 S8，等于把 3/4 的能力记成已完成（R8 同类问题）。
- 库层 `uq_interview_slot` + `ALREADY_SCHEDULED` 只保证「不能插入第二场」，救不了「面试官请假无法退出」「改期无路径」——这些在真实业务里一定会发生。

**建议**
- 二选一并回抄：① 把 `intent` 的其余三个实现掉（可复用同一事务/幂等/冲突校验）；或 ② 在 `docs/17` 明确记「v1.0 S8 只交付 CREATE，其余 3 个 intent 属 v1.0 之外」，同时把 `contracts/interview/tool-contracts.md` 的 contract_version/描述标为「v1.0 子集」，并把 docs/18 的「交付」改为「交付 CREATE」。
- 当前状态下 S8 不能按契约给 PASS。

---

### P1-08 · 「≥20 份真实简历 S6→S7」门槛未达成，且没有一条申请端到端

**文件:行**
- `docs/21-agent-operating-model.md:213`（简历门槛：≥20 份真实简历跑 S6→S7，≥5 份结论可解释）
- `dsh/dsh-recruitment/evidence/experiments/2026-11-14-real-resume-gate/README.md:66-70`（自述「还没做：结构化 + 入库 + 初筛」）
- `docs/18-golden-path.md:90-93`（自述「Golden Path 仍未端到端跑通过一次」，两道硬门槛）

**现象（DB 实况 + 证据文件对照）**
- `intake_asset=8`（不是 ≥20）；`application=9`，其中 `S6=7`、`S7=1`、`S9=1`；**`decision(SCREENING)=0`**。
- 唯一一条 `decision(STAGE/S10)` 的申请 `111…701`：`resume_version_id IS NULL`、无 SCREENING 决策、无 screening 建议留痕；它走的是「种子数据 → 排期/转写/面评 → 决策」的旁路。
- 走完 S6 的 7 条申请：**全部停在 S6**，没有一条进入 S7 结论/排期/面评/决策。
- 真实简历语料的 50/52 读取成功（D-99）只证明**读**，不证明 S6 接入（结构化 + 入库 + 初筛需要模型，证据 README 自己说没做）。

**为什么是问题**
- 两条线各自有局部证据，但没有一条**同一条申请**的连续证据链；「全链路」在验收语义上不成立（docs/18 也承认）。
- docs/22 的 28 项设计里「验收设计没有真实语料回归」已被 D-99 补到**读取层**，但没有补到 S6→S10。

**建议**
- 选定 1 条真实的（或明确标注的演示）申请，按 `application_id` 逐阶段写：intake（S6）→ screening 建议（S7）→ SCREENING 决策 → 排期 → transcript import → scorecard → summarize → decision；每一步留 DB 读回。
- 在真实简历门槛上，按 docs/21 口径跑 ≥20 份并记录每份的四数 + 结论可解释抽样；做不到就明确把该门槛标 BLOCKED，不得用「读取成功率」替代。

---

### P1-09 · 阶段状态机没有驱动入口（`application.current_stage_code` 没有工具能推进）

**文件:行**
- `src/tools/**`：只有 `application-intake.ts:1387-1389` 在**新建**申请时写 `'S6'`；没有任何工具更新 `current_stage_code`（全仓 grep 只在这些行出现）
- `contracts/evaluation/decision-rules.md:238-245`（DC-47/G-5：状态推进是独立命令，决策不写状态）
- `docs/18-golden-path.md:35-45`（列出 v1.0 的 6 个阶段，但没写「谁推进」）

**现象**
- DB 里 7 条 S6 申请全部停在 S6；1 条 S7、1 条 S9 的变更事件 `application.current_stage_code.changed` 是**手工/脚本 UPDATE** 触发 `fn_row_guard` 产生的，不是产品工具。
- 也就是说：S6→S7→S8→S9→S10 的**阶段码流转**在 v1.0 没有执行者；工具能跨阶段操作（排期不校验阶段），但「申请当前在哪个阶段」这个事实不会随业务前进。

**为什么是问题**
- 验收项「状态机（stage_catalog 的 S3/S6/S7/S8/S9/S10）」不能只看「阶段码是外键」；没有推进入口 = 状态机是静态字典，不是业务流程。
- 工作台/指标/复盘若按阶段统计，会永远看到一堆 S6。

**建议**
- 补一个受控的推进命令（人或受授权 actor，带 `SET LOCAL actor`、`record_version` 条件、`stage_catalog` 校验、事件留痕）；或在 `docs/17` 明确「v1.0 不做阶段推进，阶段码仅作标签」，并把 docs/18 的阶段表改成非流程承诺。
- 至少把手工 UPDATE 的临时脚本从「产品路径」证据里剔除，避免把手工当能力。

---

### P2-01 · `docs/18` 已与事实不符（18 个工具 / 决策 BLOCKED / S8 交付 / 40 张表）

**文件:行**：`docs/18-golden-path.md:23`（40 张表；实况 47）、`:60`（S7 步骤含 SCREENING 决策）、`:81`（18 个工具；实况 19）、`:85`（S8 ✅ 交付；实况仅 CREATE）、`:87`（S10 决策落库 BLOCKED；实况已有 IN_CHAT 决策落库）、`:93`（Web 真人点 approval 是唯一解；D-95 已取代）。

**为什么是问题**：docs/18 是「当前状态」手册，验收/交接会照它读；现在它同时低估（19 个工具、决策可落库）和高估（S8 全交付、approval 必点）两层，属于 R5 口径漂移。

**建议**：在本轮集成时一次性回抄（工具数、S8 子集、D-95 后的决策路径、表数、Golden Path 未跑通），并标明「哪些是 BLOCKED」。

---

### P2-02 · S3 的「人类批准标准」没有产品入口（只有 CLI 脚本）

**文件:行**：`src/tools/job-create.ts:1696`（`decideRubricApproval` 导出）、`manual/job-line/approve-rubric.mjs:63`（唯一调用方之一）、`src/index.ts`（19 个工具里没有 rubric approve）；`docs/18:82`（写「rubric 落 PENDING，人类批准」但没给路径）。

**为什么是问题**：R2 要求从运行入口可达；`decideRubricApproval` 只被「仓库内 CLI/测试」调用，产品运行时（Web/Agent 会话）没有入口。用户在工作台看不到「待批准标准」的操作路径，`job_create` 只能造出永远 PENDING 的 rubric。

**建议**：要么给 Web 半部分/独立工具（人类通道，复用 approval seam 或人工 CLI 作为 v1.0 明示的运维口），要么在 docs/17 明确「S3 批准先走 CLI，v1.0 不提供产品界面」，不能继续写「人类批准」而无落点。

---

### P2-03 · 标签二义性：写工具在演示租户上写死 `LIVE`；`candidate_get` 没有三维标签

**文件:行**：`src/tools/interview-schedule.ts:1535`、`src/tools/job-create.ts:1036`（写死 `LIVE/MANUAL/CONNECTED`）；`src/tools/candidate-get.ts:16-17`（明确删掉 `provenance`/`stub`，输出 `source:'DATABASE'`）；`contracts/interview/tool-contracts.md:74`（`FIXTURE = 在 fixture 租户上写（测试专用）`）。

**现象**：`ra_s6s7`/0002_seed 是「演示租户 + 合成数据」，但排期/岗位写入返回 `provenance=LIVE`；而转写工具对同类数据正确返回 `FIXTURE`。同一批演示数据在不同工具里标签不一致。

**为什么是问题**：R4 的定义是「数据是真的还是造的」；合成数据被标 LIVE 会把「演示通过」污染成「真实能力」。契约对 `FIXTURE` 的租户口径又没定义，属于「两套解释都合法」的隐患。

**建议**：在契约里钉死「fixture 租户」的机检口径（如 `tenant_id` 白名单或 `business_config` 标记），三处写工具统一读同一判定；`candidate_get` 补三维标签（或明确它不属「外部能力」并回抄理由）。

---

### P2-04 · Feishu connector 未接线（R2 BLOCKED），且 `PLATFORM_EXPORT` 的 `LIVE` 依赖本地自述回执

**文件:行**：`src/connectors/feishu/index.ts:1-6`（自述「不注册任何工具」）；`src/tools/transcript-import.ts:48`、`:782-788`（`provider_artifact_id = local:platform-export:<meeting_id>`）、`:816-821`（`EXPORT_RECEIPT_IS_SELF_DECLARED` 警告）。

**现象**：全仓没有任何注册工具 import `src/connectors/feishu/**`；它只被 `test/unit/transcript-feishu.test.ts` 引用。S9 的「平台导出」路径没有真实 provider 读取，`provider_artifact_id` 是本地拼的；`provenance=LIVE` 只依赖人上传时给的导出文件名。

**为什么是问题**：R2 对 connector 同样适用；D-1 demo gate 要求「真实 provider artifact id/revision/hash/readback」，当前实现达不到（工具自己也用 warning 承认了）。这不是隐藏缺陷（docs/18 已写 Feishu LIVE BLOCKED），但验收时不能把 `transcript_import` 的 `LIVE` 算作真实 provider 证据。

**建议**：保持 `connection=NOT_CONNECTED` + 自述回执的诚实标注；demo gate 若需要 LIVE，走真实 Feishu 回读（另立 gate），不要把人工上传标成已接通。

---

### P2-05 · 文档/合同层的多处未回抄（R5 清单）

| # | 位置 | 偏差 |
|---|---|---|
| 1 | `CONTRACT.md:116-118`、`§2.2:93-102` | 旧 stub 契约（3 工具、散文错误格式）仍在；D-63 已裁定统一 JSON，`README.md:156-160` 仍写「两代并存、本 lane 无权裁决」 |
| 2 | `CONTRACT.md §4` vs `src/tools/candidate-get.ts` | `candidate_get` 已删 `provenance/stub`、改成真查库，CONTRACT 未回抄 |
| 3 | `contracts/evaluation/*` vs 代码 | ① `IN_CHAT`/`confirmation_text` 未进契约（D-95）；② 23505 未改成 0008 的 DEFERRABLE EXCLUDE（P1-04） |
| 4 | `contracts/interview/tool-contracts.md` vs 代码 | 四 intent vs 仅 CREATE（P1-07） |
| 5 | `docs/18` | 见 P2-01 |
| 6 | `README.md:3` | 仍写「七个工具」（实况 19） |
| 7 | `docs/17:900-927` vs `docs/18:91-93` | D-95 已改决策闸门，docs/18 仍写「Web 真人点 approval 唯一解」 |

---

### P2-06 · 数据卫生：DB 里有 2 条 `interview.stage_code='S9'`（非工具产生）

**文件:行**：`db/migrations/0006_integrity_gaps.sql`（D-65：interview stage 默认/期望 `S8`）；实况 `interview` 6 行中 2 行 `stage_code='S9'`（属于手工 seed 脚本写入的申请 `e61380dc…`）。

**为什么是问题**：`interview.stage_code` 的外键只保证「是 S1–S12 之一」，不保证「是 S8」；手工脚本写入 S9 不会报错。这类行会污染按阶段统计，也会让「面试属于排期阶段」的口径失真。

**建议**：手工 seed 脚本修掉；若业务上确需 S9，必须在契约里定义 `interview.stage_code` 的合法集合（不能只是外键）。

---

### P2-07 · 未配置替身的 schema 开放（低）

`src/index.ts:238-261` 的通用 `notConfiguredTool` 用 `additionalProperties: true`，而所有已配置工具都是封闭对象根。未配置时模型可传任意参数（随后 `NOT_CONFIGURED`），不造成写库，但会削弱「参数面封闭」的一致性。建议改成 `additionalProperties: false` + 空 `properties`。

---

## 4. 不能验收的项（BLOCKED）与最短解 BLOCKED 路径

| # | BLOCKED 项 | 卡住的证据 | 最短路径 | 预期耗时 |
|---|---|---|---|---|
| B1 | **S6 身份来源闸门** | `agent_read` 进 `strong`（`application-intake.ts:765/775`）；OCR 字段被标 `native_text`（converter 探针） | ① `observeAgentIdentity` 拒绝非 `native_text`；② converter 传播块 provenance；③ 补回归 + 同步 `material.ts` | 0.5–1 天（跨 converter/S6 两个写范围，需 Owner 协调） |
| B2 | **S7 决策写入路径** | `SCREENING` 被 `decision_record` 拒收；DB `SCREENING=0` | 扩展 `decision_record` 或新增 `recruitment_screening_decision`，并回抄 contracts/17/18 | 1 天 |
| B3 | **S8/S10 人机闸门** | 两个工厂签名无 approval；回滚事务实测无 approval 写入成功 | `index.ts` 传 `resolveApproval(ctx)`；两工具写库前 `approval.request`；加 deny/unavailable 负例 | 1 天 |
| B4 | **并发决策 ALREADY_DECIDED** | 0008 deferred EXCLUDE → COMMIT 23P01；工具只映射 23505 | 在 `withActor` 层捕获 23P01 并映射，或改回非延迟唯一索引；加并发集成测试；回抄契约 | 0.5 天 |
| B5 | **D-95 哈希/契约** | pre-image 只有 4 键；契约无 `IN_CHAT` | 按 D-95 原文改 pre-image；回抄 contracts/evaluation + docs/18 | 0.5 天 |
| B6 | **S8 四 intent** | `intent enum=['CREATE']`；D-62 要求四 intent | 实现其余三个，或在 docs/17 明确 v1.0 子集并改契约/18 | 2–3 天（或 0.5 天做口径收口） |
| B7 | **真实简历 S6→S7 门槛** | 8 份资产、7 条 S6、0 条 SCREENING；证据 README 自述未做 | 按 docs/21 §8 跑 ≥20 份（读取→结构化→intake→screening），留四数 + 抽样解释 | 1–2 天（受模型额度限制） |
| B8 | **一条申请端到端** | 决策申请无材料；S6 申请无下游 | 选定 1 条申请，逐阶段写 DB 读回，形成一条 `application_id` 链 | 1 天 |
| B9 | **阶段推进入口** | 无工具更新 `application.current_stage_code` | 补受控推进命令，或明确 v1.0 不做推进并改验收口径 | 1 天 / 0.5 天（口径） |
| B10 | **S3 人类批准入口** | `decideRubricApproval` 只被 CLI/测试调用 | 提供产品入口或明确 CLI 运维口 | 0.5–1 天 |
| B11 | **Feishu connector 接线** | 只被单测引用，无工具 import | 真实 Feishu 回读（独立 LIVE gate）；否则保持 BLOCKED 标签 | 另立 gate（缺凭据） |

**解 BLOCKED 的顺序建议**：B3（人机闸门）→ B1（身份闸门）→ B2（S7 决策）→ B4/B5（决策正确性）→ B6/B9/B10（口径/入口）→ B7/B8（真实语料与端到端）。B1/B2 不修，后面所有「全链路跑通」都只是在跑通一条旁路。

---

## 5. 与 `docs/22` 的对照：简历层修完之后，下游哪些地方会受影响

docs/22 的结论是「判据体系不错、执行体系是空的」。本轮并发 lane 的 D-99/D-100 补了执行器与归因（`src/document/recovery/execute.ts`、`quality/checks.ts::attributeExperienceRows`、`document_read.layout_only_blocking`），但**这些修复只在 document_read 这条管道上生效；S6/S7 走的是另一条管道（`intake → converter CLI → src/db/material.ts`）**。逐条对照：

| docs/22 的修复/设计 | 对 S6–S10 的真实影响 | 本窗口判定 |
|---|---|---|
| **D-97 两档阻断**（`blocking` / `blocking_for_structure`） | S6 不读 `document_read` 的输出，而是直接 `runConverter`；S6 只从 converter 的 `issues` 重算 HARD。因此 `blocking_for_structure` 对 S6 **没有接线**；D-97「第一批 39 份可进结构化」在 S6 侧没有对应的开关 | ⚠️ 未消费 |
| **D-98 OCR 页恢复（`provenance='ocr'`）** | ① 身份字段：converter 抽字段时重新标 `native_text` → S6 的身份闸门失效（P0-01）；② 严重度：`pdf_text_recovered_by_ocr` 在 `src/db/material.ts` 里被当未知→HARD → S6 `PARTIAL`、S7 降级（P1-05） | ❌ **两个下游缺陷** |
| **D-99 恢复执行器**（`retry/switch_reader/vision_read`） | 只在 `document_read` 工具里可被触发；S6 的 `runConverter` 不会执行恢复计划，S6 也没有「恢复后再接」的分支 | ⚠️ 未接线 |
| **D-99 真实语料回归**（read 50/52） | 只证明「读得出」；S6 的结构化/入库/初筛仍需模型，且 DB 里只有 8 份 intake 资产（P1-08）。读取成功率**不能**替代 S6→S7 门槛 | ⚠️ 口径不可替代 |
| **D-100 跨块归因产出结果** | `attributeExperienceRows` 的结果只进 `document_read` 的 assessment；S6 落库的 `parsed_fields` 仍来自 converter 的 `fields/entries`，S7 的 `work_experience/education` 也仍按旧口径 | ⚠️ 未消费 |
| **D-100 `layout_only_blocking`** | 同上，S6/S7 不读这个位；S7 仍按 `hard_issue_count` 一刀切降级 absent | ⚠️ 未消费 |
| **DOCX 文本框修复（`babd734`）** | converter 层修复会进入 S6（同一条 converter），但 S6 的 `material.ts` 仍按旧 issue 表判断严重度；文本框文字是否被算「可读」没有 S6 级断言 | ⚠️ 未验证 |
| **空文件 <8 字节报 `EMPTY_FILE`** | converter 层；S6 的 `mapParseStatus(chars<=0)` → `FAILED`，行为兼容 | ✅ 兼容 |
| **D-96「空必须四分类」** | S9 已按 D-96 落 `ARTIFACT_EMPTY`（合同已回抄）；S6 的 `state != present` 目前只区分 `field_state_*`，没有四分类（`NOT_GENERATED/EMPTY_BY_NATURE/READER_MISSED/NO_PERMISSION`）；S7 通过 `issue_codes` 间接看到一部分 | ⚠️ S6 侧未分类 |

**一句话**：docs/22 的动作让「读得出」变好了，但 **S6/S7 消费的是另一套输出（converter CLI + `src/db/material.ts`）**，两套之间没有共享的「唯一严重度/来源闸门」。这正撞上 D-85 的警告——解析层不允许两套权威并存。复审时应把「document 层修好」与「S6/S7 消费到」分开验收，不能因为前者绿就给后者签收。

---

## 6. 复审清单（下次复审必须重跑）

### 6.1 代码/证据层

1. `git rev-parse HEAD` + `git status --short`：记录被测 commit；确认工作树干净（本窗口期间分支被并发 lane 推进过，必须记录）。
2. 全量 `node --test`：报 `tests / pass / fail / skipped` 四个数；**skipped>0 不得宣称全绿**；同时记录是否有并发 lane 新增的测试。
3. `node --test` 跑 `test/integration/*.test.ts`：单独报四个数，确认真连 `ra_s6s7`。
4. 用 `apply()` 捕获注册表：断言 **19 个工具名**、无重复；再 `apply({})` 断言 **19/19 NOT_CONFIGURED**。
5. 对每个读工具做一次真实调用（job_get / candidate_get / interview_get / transcript_read / evaluation_summarize / screening_evaluate）。
6. 对每个写工具做一次**回滚事务内**真实写入（本报告 §3 P0-03 的两段探针可复用），确认：
   - 有 approval 时写入成功、无 approval 时**一行都不写**；
   - `changes`/行数与 DB 读回一致。
7. **并发决策**：两个连接、两个事务同时插同键 current 决策，断言后者得到 `ALREADY_DECIDED`（不是裸 23P01/500）。
8. **S6 来源闸门**：分别用 `provenance='ocr'`、`provenance='agent_read'`、`structured_json` 的电话/邮箱跑 intake，断言 **不得自动匹配/新建候选人的 strong 标识**（必须 BLOCKED_BY_REVIEW 或人工确认）。

### 6.2 DB 层（psql 直查）

```sql
-- 台账与阶段
select count(*) from recruitment.schema_migration;              -- 10
select code,name from recruitment.stage_catalog order by sort_order;
-- 决策/面评/转写不变量
select decision_scope,count(*) from recruitment.decision group by 1;
select count(*) from recruitment.scorecard where superseded_by_scorecard_id is null;
select count(*) from recruitment.transcript_artifact where is_canonical;  -- 每 meeting 至多 1
-- 申请身份唯一
select count(*) from (select tenant_id,candidate_id,job_id from recruitment.application where lifecycle_status='ACTIVE' group by 1,2,3 having count(*)>1) t;  -- 0
-- 材料/链路
select count(*) from recruitment.intake_asset;
select count(*) from recruitment.application where resume_version_id is not null;
select count(*) from recruitment.decision where decision_scope='SCREENING';   -- 重审时应 >0 才算 S7 闭环
```

再跑：`verify.sql`、`verify-0006` … `verify-0010`（全部 exit=0 + PASS），以及迁移台账 `0010` 自检。

### 6.3 端到端（Golden Path）

1. 选 1 条申请（带真实/演示简历 + rubric），记录 `application_id`。
2. 依次：`application_intake` → `screening_evaluate` → **S7 决策**（B2 修复后）→ `interview_schedule` → `transcript_import` → `scorecard_submit` → `evaluation_summarize` → `decision_record`。
3. 每一步做 DB 读回：行 id、`record_version`、`decided_by_actor_id`、`provenance/trigger/connection` 三轴。
4. 同样的链路在 Web 里由**真人**操作一遍（D-88）：人点 approval 的截图 + 刷新后仍持久化；Agent 不得代点。
5. 报「S6→S7 ≥20 份真实简历」门槛：每份记录读取/结构化/入库/初筛结果，≥5 份结论可追到块证据。

### 6.4 文档一致性

1. 重读 `docs/18`：工具数、S8 子集、S10 决策路径、表数、Golden Path 状态必须与实测一致（P2-01）。
2. 重读 `contracts/evaluation/**`：`IN_CHAT`、`confirmation_text`、pre-image、0008 的 23P01 是否已回抄（P1-04/P1-06）。
3. 重读 `contracts/interview/tool-contracts.md`：S8 四 intent 是否与代码一致（P1-07）。
4. 重读 `CONTRACT.md`：candidate_get 工具面、错误格式、工具数是否已回抄（P2-05）。
5. 检查 `docs/23` 本报告的每个 BLOCKED 是否已改判（用同一组命令复跑，不接受「已修复」自述）。

---

## 附录 A · 本窗口用过的命令与关键输出（节选）

### A.1 测试

```powershell
cd "D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='123456'; node --test
# c2762a2: tests 724 / pass 724 / fail 0 / skipped 0
# 9479f52: tests 766 / pass 766 / fail 0 / skipped 0

# 集成层单跑（15 个文件，真连 ra_s6s7）
$files = Get-ChildItem test\integration -Filter *.test.ts | ForEach-Object { $_.FullName }
node --test @files
# tests 182 / pass 182 / fail 0 / skipped 0
```

### A.2 注册与真实调用（摘要）

```text
REGISTERED=19
UNCONFIGURED_REGISTERED=19
UNCONFIGURED_NOT_CONFIGURED_COUNT=19/19
```

真实调用（节选，PII 脱敏）：

```text
call job_get              -> OK job=DEMO-BE-001/OPEN rubric=v2 current=true
call candidate_get        -> OK identity_status=ACTIVE contacts.visible=false email=z***@demo-recruitment.test
call interview_get        -> OK count=1 transcript=READY
call transcript_read      -> OK state=READY reason=CANONICAL_STATUS
call evaluation_summarize -> OK advisory=true read_only=true coverage{required_total:2,submitted:2,missing:0}
                           -> 禁止键扫描（任意层级）：result/decided_by_actor_id/decided_at/
                              recommended_result/overall_score/score 均 present=false
call screening_evaluate   -> BLOCKED_BY_REVIEW(MATERIAL_NOT_BOUND) human_queue_checked=7
call scorecard_submit     -> INTERVIEWER_MISMATCH(ACTOR_NOT_INTERVIEWER)
call decision_record      -> ALREADY_DECIDED（IN_CHAT；ctx 无 approval 服务，未写库）
```

### A.3 DB 验证

```powershell
$env:PGPASSWORD='123456'; $psql='D:\12412\PostgreSQL\bin\psql.exe'
& $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f db\verify-0008.sql
& $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f db\verify-0009.sql
& $psql -h 127.0.0.1 -U postgres -d ra_s6s7 -v ON_ERROR_STOP=1 -q -f db\verify-0010.sql
```

```text
VERIFY-0008 PASS：7 条结构断言 + 4 条正向 + 4 条负向 + 5 条数据面全部通过
VERIFY-0009 PASS：3 条结构断言 + 3 条正向 + 3 条负向 + 1 条数据面全部通过
VERIFY-0010 PASS：台账存在 + 0001–0010 全登记 + 版本号格式合法
```
另：`verify-0006 PASS`、`verify-0007 PASS`、`verify.sql PASS`。

不变量负例（每条都在 `begin … rollback` 内，最终零变化）：

```text
update decision.reason        → IMMUTABLE_COLUMN（decision 只允许改 superseded_by_decision_id）
update scorecard.items        → SCORECARD_IMMUTABLE
update transcript.raw_text    → IMMUTABLE_COLUMN（transcript_artifact）
update application stage='S99'→ 23503 fk_application_stage_catalog
insert interview stage='S99'  → 23503 fk_interview_stage_catalog
insert decision stage='S99'   → 23503 fk_decision_stage_catalog
insert 第二条 ACTIVE 申请     → 23505 uq_application_active_cycle
insert 同键 current decision + set constraints all immediate → 23P01 uq_decision_current
```

### A.4 人机闸门绕过探针（回滚事务，零写入）

```text
# scorecard_submit（真实面试 304a58c1…，配置 actor 103 是必交面试官）
WROTE_WITHOUT_APPROVAL scorecard_id=3d596725-… status=SUBMITTED author=…103
rows before=2 inside_tx=3  → ROLLED_BACK rows_after=2

# interview_schedule（application 111…701，round 5）
WROTE_WITHOUT_APPROVAL interview=8a2baac9-… external_call_made=false
rows before=6 inside_tx=7  → ROLLED_BACK rows_after=6
```

### A.5 跨层探针

```text
# converter OCR 块的字段 provenance（合成块，未触碰真实简历）
phone.state=present phone.provenance=native_text
email.provenance=native_text
identity_merge_eligible=['phone','email']
identity_manual_review=[]

# S6/S7 的 issue 严重度表
isHard(pdf_text_recovered_by_ocr)=true
mapParseStatus(complete, 1000, [pdf_text_recovered_by_ocr])= {"status":"PARTIAL"}
```

### A.6 并发 lane 说明

本窗口开始时 `git status --short` 为空（`c2762a2`）。审查期间分支被推进两次：

```text
9479f52 feat(quality): 跨块归因产出结果 + 版式类阻断与文字不可用分开（D-100，审计 ③⑥）
ca5a24d feat(document): 恢复执行器 + 真实语料回归门槛 + 错误可诊断（D-99，事故审计 ③⑤⑦）
```

`git diff --stat c2762a2..9479f52` 显示只改 `src/document/**`、`test/document/**`、`test/regression/**`、`docs/11`、`docs/17`、`dsh/profile/recruitment/cordis.patch.yml`；**本报告判断的范围内文件全部零差异**。因此：
- 本报告的代码结论对 `9479f52` 仍成立；
- §1.2 的 724 与 766 两组测试分别对应「范围基线」与「含并发 lane 的当前 HEAD」；
- 报告落盘时工作树又出现**未提交**的 `converter/src/pdf_layout.py` / `pdf_reader.py` 改动（版面几何分栏，属于范围外 D-97 第二批）。本报告**不判**这两处；已核对它们不改变 §5 的 OCR/字段 provenance 结论（`resume_fields.py` 未改，OCR 兜底段未改）。
- 若复审时又有新 commit 或未提交改动，必须重新跑 §6 的全部命令，不得引用本报告的数字。

---

## 附录 B · 一句话给集成/复核者

**这轮不是「功能没写完」，而是「每个工具单看都像真的，连起来有四处不变量是假的」：**
**身份来源没守住、S7 决策没地方落、S8/S10 的闸门没接、以及全链路没有一条真实申请从 S6 走到 S10。**
**修的顺序：先闸门（B3/B1），再 S7 决策（B2），再决策正确性（B4/B5），最后才是真实语料与端到端（B7/B8）。**

---

## 8. 第二轮复验（修复后，2026-11-14 07:33 起）

> 触发：本窗口第一轮报告（本文件 §0–§7）提交后，修复 lane 于 2026-11-14 06:xx 提交了 4 个修复 commit。
> 本轮**不接受修复方自述**，全部用本窗口自己的命令复跑 + 读 diff 得出；未 commit、未 push、未切分支。
> **第一轮内容作为历史记录保留**；本节是当前状态。

### 8.1 本轮基线（会变，已现场探测）

| 项 | 值 |
|---|---|
| 分支 | `feat/unified-document-intake` |
| **HEAD** | **`6d253f4`**（相对第一轮 `9479f52` 新增 5 个 commit） |
| 新增修复 commit | `a8d3eea` fix(gates)：S8/S10 人机闸门 / `77c881b` fix(db)：statement_timeout + idle_in_transaction / `5e4c7c8` fix(gates)：approval 120s 超时 / `7f79bf4` docs：第一轮验收报告 + D-102 / `6d253f4` feat(decision)：S7 决策 + 23P01 + D-95 v2 + material |
| **工作树（未提交，另一 lane 在写，非本窗口）** | `M converter/src/pdf_layout.py`、`M converter/src/pdf_reader.py`、`M converter/src/resume_fields.py`、`M converter/tests/*`、`M docs/11-pdf-acceptance-criteria.md`、**`M dsh/dsh-recruitment/src/tools/application-intake.ts`（S6 身份闸门修复）**、`M test/unit|integration/application-intake-structured.test.ts`、`M test/regression/real-corpus.test.ts`、`?? test/integration/intake-identity-gate.test.ts`（7 条新回归） |
| 本轮未改 | 本窗口只读；**没有 commit/push/切分支**；未 stash、未建 worktree（避免碰另一 lane 在写的文件） |

**因此本轮有一个关键证据边界**：`HEAD=6d253f4` 是干净可引用的提交，但 **S6 身份闸门修复只存在于未提交的工作树**；并且全量测试跑的是「HEAD + 另一 lane 的未提交改动」的混合树，不是单一 commit 快照。凡依赖工作树的结论，下面都标「WIP」。

### 8.2 复跑证据（命令原文 + 真实输出）

#### A. 测试四数（R3）

```powershell
cd "D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='123456'; node --test
```
```text
ℹ tests 820 / ℹ pass 820 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0 / ℹ todo 0
[status: completed, exit code: 0]
```
> 第一轮同命令在 `c2762a2` 是 724/724、在 `9479f52` 是 766/766；本轮 820（含闸门/决策/材料/身份回归）。
> **注意**：该 820 是「HEAD 6d253f4 + 未提交 WIP」的工作树结果，**不是**单一 commit 快照；复审必须在干净快照复跑。

闸门/决策相关的定点测试：

```powershell
node --test test/unit/evaluation-scorecard-submit.test.ts test/unit/interview-schedule.test.ts test/unit/evaluation-decision-record.test.ts
# tests 98 / pass 98 / fail 0 / skipped 0

node --test test/integration/intake-identity-gate.test.ts   # WIP 新增文件
# tests 7 / pass 7 / fail 0 / skipped 0
```

#### B. 注册表与未配置替身（R2）

```text
REGISTERED=19
UNCONFIGURED=19  NOT_CONFIGURED=19/19
```
19 个工具名与第一轮一致（没有新增/删除工具）；`index.ts` 本轮 diff 只有 4 行（把 approval 传给 schedule/scorecard、改 decision 描述）。

#### C. S8/S10 人机闸门（回滚事务内，DB 最终零变化）

```text
SCORECARD_APPROVAL undefined     {"ok":false,"code":"FORBIDDEN/APPROVAL_UNAVAILABLE","before":2,"after":2}
SCORECARD_APPROVAL rejected      {"ok":false,"code":"FORBIDDEN/APPROVAL_NOT_GRANTED","before":2,"after":2}
SCORECARD_APPROVAL timeout       {"ok":false,"code":"FORBIDDEN/APPROVAL_NOT_GRANTED","before":2,"after":2}
SCORECARD_APPROVAL allowed-once  {"ok":true,"code":"OK","before":2,"after":3}   ← 事务随后 ROLLBACK
SCHEDULE_APPROVAL  undefined     {"ok":false,"code":"FORBIDDEN/APPROVAL_UNAVAILABLE","before":6,"after":6}
SCHEDULE_APPROVAL  rejected      {"ok":false,"code":"FORBIDDEN/APPROVAL_NOT_GRANTED","before":6,"after":6}
SCHEDULE_APPROVAL  allowed-once  {"ok":true,"code":"OK","before":6,"after":7}   ← 事务随后 ROLLBACK
MAKE_APPROVAL_TIMEOUT timeout timeout
REQUIRE_APPROVAL_TIMEOUT FORBIDDEN/APPROVAL_NOT_GRANTED
```

「闸门位置」是否符合 D-79（先校验、后问人、失败不打扰人）：

```text
GATE_PLACEMENT {"callsAfterFirst":1,
  "conflictRes":"CONFLICT_SLOT/INTERVIEWER_BUSY","callsAfterConflict":1,
  "scRes":"INVALID_ARGS/DIMENSION_COVERAGE_INCOMPLETE","scorecardApprovalCalls":0}
SCHEDULE_REPLAY {"firstReplayed":false,"secondReplayed":true,"callsAfterFirst":1,"approvalCallsTotal":1,
  "invalid":"INVALID_ARGS/MISSING_REQUIRED","invalidApprovalCalls":0}
SCORECARD_REPLAY {"firstReplayed":false,"secondReplayed":true,"callsAfterFirst":1,"approvalCallsTotal":1}
```
→ 冲突/参数非法/幂等重放**都不会弹人**；只有真正要写库且全部业务校验通过才问。与 D-95「人只决策一次」一致。

**走 `index.ts` 真实注册路径**（`apply()` 的 ctx 无 approval 服务 = headless）：

```text
recruitment_scorecard_submit    -> FORBIDDEN: {"reason_code":"APPROVAL_UNAVAILABLE","detail":{"approval":"unavailable","tool":"recruitment_scorecard_submit"}}
recruitment_interview_schedule  -> FORBIDDEN: {"reason_code":"APPROVAL_UNAVAILABLE","detail":{"approval":"unavailable","tool":"recruitment_interview_schedule"}}
DB_COUNTS before={"scorecard":2,"interview":6} after={"scorecard":2,"interview":6}
```
→ 第一轮的 P0-03（无 approval 也能写）**已闭环**。

#### D. S7 决策落库（`decision_scope='SCREENING'`，回滚事务）

```text
SCREENING ok: stage=S7 scope=SCREENING decided_by=…103 hasGate=false
             labels={provenance:FIXTURE, trigger:MANUAL, connection:CONNECTED}   ← R4：无 LIVE 证据不冒充
v1 hash + confirmation_text   -> DECISION_REQUIRES_HUMAN/CONFIRMATION_TEXT_MISMATCH   ← v2 强制生效
interview_id 给了              -> INVALID_ARGS/SCREENING_SCOPE_NO_INTERVIEW
summary_digest 给了            -> INVALID_ARGS/SCREENING_SCOPE_NO_SUMMARY
ADVANCE 缺 SCREENING_EVALUATION-> INVALID_ARGS/BASIS_REF_EMPTY
同 scope 第二次（无 supersedes）-> ALREADY_DECIDED/SCOPE_ALREADY_DECIDED

SCREENING_REJECT_NO_KEY    -> INVALID_ARGS/DECISION_REASON_NO_DIMENSION   ← DC-18/§17.1 S7-07
SCREENING_REJECT_WITH_KEY  -> ok S7/SCREENING
SCREENING_HOLD_NO_EVAL     -> ok S7/SCREENING                            ← 安全方向可 0 条 SCREENING_EVALUATION
```
→ 第一轮的 P0-02（S7 人决定无落库路径）**已闭环**。

#### E. 23P01 / 23505 / D-95 兼容

```text
23P01_MAP ALREADY_DECIDED/SCOPE_ALREADY_DECIDED
23505_MAP ALREADY_DECIDED/SCOPE_ALREADY_DECIDED
S10_V1（无原话、四键 v1 hash）-> ALREADY_DECIDED（STEP1 通过，STEP3 拦住；v1 旧口径仍可用）
```

#### F. D-95 v2 / material / S6 身份闸门

```text
isHard(pdf_text_recovered_by_ocr)=false
hardCodes=[]
mapParseStatus(complete,1000,[recovered])= {"status":"PARSED"}
isHard(pdf_text_encoding_unread)=true          ← 未恢复的仍 HARD，未被降级

# converter（工作树 WIP）字段 provenance 跟随块：
ocr blocks      -> phone.provenance=ocr   merge_eligible=[]
native blocks   -> phone.provenance=native_text merge_eligible=['phone','email']
missing prov.   -> phone.provenance=unknown merge_eligible=[]

# S6 身份闸门（工作树 WIP）：
converter native_text -> strong=["phone","email"]  decision=CREATE_CANDIDATE
converter ocr        -> strong=[] weak=["phone:ocr","email:ocr"]  decision=REVIEW MATERIAL_ATTRIBUTION_UNKNOWN
converter agent_read -> strong=[] weak=["phone:agent_read","email:agent_read"] decision=REVIEW
converter unknown    -> strong=[] weak=["phone:unknown","email:unknown"] decision=REVIEW
structured overlay（agent 读出 phone/email）-> strong=[] weak=["phone:agent_read","email:agent_read"] decision=REVIEW
```
→ 第一轮的 P0-01 在 WIP 工作树上**行为已修复**；但 `application-intake.ts` / `resume_fields.py` / 新测试均**未提交**，不能签收。

#### G. DB 实况（本轮复跑）

```text
decision:  STAGE/S10 = 1；SCREENING = 0；FINAL = 0
scorecard=2；interview=6（stage S8=4、S9=2）；application=9
application 同时有材料+rubric = 0 条（with_material=7，with_rubric=2）
candidate=8；intake_asset=8；schema_migration=10（0001..0010）
```
→ **没有真实提交的 SCREENING 决策**、**没有一条申请同时具备材料与 rubric**：S7 决策目前只在回滚事务与测试里被证明，端到端仍未发生。

### 8.3 逐项复验（12 个范围内工具 + connector + 链路）

| # | 项 | 第一轮 | **第二轮判定** | 证据 |
|---|---|---|---|---|
| 1 | `recruitment_application_intake`（S6） | BLOCKED | **BLOCKED（WIP 已修，未提交）** | 行为探针全过（8.2-F）；但 `git status` 显示 `M src/tools/application-intake.ts`、`M converter/src/resume_fields.py`、`?? test/integration/intake-identity-gate.test.ts` |
| 2 | `recruitment_screening_evaluate`（S7） | BLOCKED | **PASS**（工具只读不变；S7 决策路径由 `decision_record` 补齐） | 第一轮真实调用仍有效；本轮 §8.2-D 证明 `decision_record(SCREENING)` 可写；残余见 N1 |
| 3 | `recruitment_job_create`（S3） | BLOCKED | **BLOCKED**（未变） | `index.ts` 无 rubric approve 工具；`decideRubricApproval` 仍只被 `manual/job-line/approve-rubric.mjs` 调用 |
| 4 | `recruitment_job_get`（S3） | PASS | **PASS** | 注册表/全量测试；契约字段未变 |
| 5 | `recruitment_interview_schedule`（S8） | BLOCKED | **FAIL**（CREATE+闸门 PASS；D-62 四 intent 仍只有 `CREATE`） | 闸门证据 8.2-C；`intent` enum 仍 `['CREATE']`（`interview-schedule.ts:97/305`） |
| 6 | `recruitment_interview_get`（S8） | PASS | **PASS** | 未改动 |
| 7 | `recruitment_transcript_import`（S9） | PASS/风险 | **PASS（MANUAL/DEMO）**；Feishu LIVE 仍 BLOCKED | 未改动；`src/` 无任何工具 import `connectors/feishu/**` |
| 8 | `recruitment_transcript_read`（S9） | PASS | **PASS** | 未改动 |
| 9 | `recruitment_scorecard_submit`（S10） | BLOCKED | **PASS** | 8.2-C：unavailable/rejected/timeout 零写入；allowed-once 才写；重放/非法不弹人；execute 路径 fail closed |
| 10 | `recruitment_evaluation_summarize`（S10） | PASS | **PASS** | 未改动 |
| 11 | `recruitment_decision_record`（S10） | BLOCKED | **PASS**（S10 回归 v1 兼容；S7 新增路径；23P01/v2 已验证） | 8.2-D/E；残余 N1/N2 |
| 12 | `recruitment_candidate_get` | PASS | **PASS**（标签缺口仍在 N5） | 未改动 |
| — | Feishu connector | BLOCKED | **BLOCKED**（未接线；只被单测引用） | `src/` grep 只命中 `contract.ts:94` 的常量，无工具 import |
| — | S6→S7 链路 | BLOCKED | **PASS（回滚事务级）** | 8.2-D：同一条申请（seedScenario）在 S6 材料 + rubric + SCREENING 决策内闭环 |
| — | S6→S10 全链路 | BLOCKED | **BLOCKED** | DB：没有一条申请同时具备材料+rubric；`SCREENING` 决策 0 条；阶段推进无工具（N4/N8） |

**计数（12 个工具）**：**PASS 9 / FAIL 1（schedule 契约四 intent）/ BLOCKED 2（intake 未提交 WIP、job-create 批准入口）**；另 Feishu connector = BLOCKED，S6→S10 端到端 = BLOCKED。

### 8.4 第一轮问题：修复判定

| 编号 | 第一轮问题 | 第二轮判定 | 证据 |
|---|---|---|---|
| P0-01 | S6 身份来源闸门被绕过 | **BLOCKED（修复未提交）** | 行为已实测修复（8.2-F）；`git status` 未提交 |
| P0-02 | S7 的 SCREENING 决策无写入路径 | **PASS** | 8.2-D；`contracts/evaluation/decision-rules.md §17.1` 已回抄；`tool-contracts.md` 的 `decision_scope` 已改 |
| P0-03 | S8/S10 人机闸门未实现 | **PASS** | 8.2-C；`index.ts:341/361` 已传 approval；两工具 120s 超时、fail closed |
| P1-04 | 0008 的 23P01 未映射 | **PASS** | `translateWriteError` 23P01→`ALREADY_DECIDED`（8.2-E）；`execute()` 的 catch 再翻一次（`decision-record.ts:3281-3285`） |
| P1-05 | `pdf_text_recovered_by_ocr` 在 S6/S7 当 HARD | **PASS** | 8.2-F；`material.ts` 加 `RECOVERY_SOFT_CODES` + 单测 |
| P1-06 | D-95 原话未进哈希 / 契约无 `IN_CHAT` | **PASS** | v2 强制：v1+原话被拒（8.2-D）；`decision-rules.md §17.2` 已回抄；v1 旧口径仍可用（8.2-E） |
| P1-07 | S8 四 intent 未实现 | **FAIL（未修）** | enum 仍只有 `CREATE` |
| P1-08 | 真实简历 S6→S7 门槛未达成 | **BLOCKED（未修）** | DB：8 assets、7 S6、0 SCREENING；evidence README 仍写「结构化+入库+初筛 还没做」 |
| P1-09 | 阶段推进无入口 | **BLOCKED（未修）** | `src/tools/**` 无更新 `application.current_stage_code` 的写路径（grep 0 命中） |
| P2-01 | docs/18 与事实不符 | **FAIL（仅修了第 60 行）** | `docs/18:23` 40 张表、`:75` DB 40 表、`:81` 18 个工具、`:85` S8 交付、`:87` 决策落库 BLOCKED、`:90` 仍写 18 个工具 |
| P2-02 | S3 人类批准无产品入口 | **BLOCKED（未修）** | 同上 row 3 |
| P2-03 | 写工具硬编码 `LIVE` / candidate_get 无三轴标签 | **FAIL（未修）** | `interview-schedule.ts:1071/1671`、`job-create.ts:1036`；`candidate-get.ts` 无 labels |
| P2-04 | Feishu connector 未接线 / LIVE 依赖自述回执 | **BLOCKED（未修）** | 同上 connector 行；`transcript-import.ts:48/782-788` |
| P2-05 | CONTRACT.md/README 未回抄 | **FAIL（未修）** | `CONTRACT.md:6/12/77/98` 仍是「三个工具/stub」；`README.md:3` 仍是「七个工具」 |
| P2-06 | DB 里 2 条 `interview.stage_code='S9'` | **FAIL（未修）** | `select stage_code,count(*) from interview` → S8=4、S9=2 |
| P2-07 | 未配置替身 schema 开放 | **FAIL（未修，低）** | `index.ts:214/249/252` 仍 `additionalProperties: true` |

### 8.5 仍未闭合的问题清单（按优先级）

| # | 项 | 严重度 | 现场证据 | 最短路径 |
|---|---|---|---|---|
| N1 | **S6 身份闸门修复未提交** | **P0 / BLOCKED** | `git status`：`M application-intake.ts`、`M resume_fields.py`、`?? intake-identity-gate.test.ts`；行为探针已过 | 该 lane 提交后，本窗口复跑：`node --test test/integration/intake-identity-gate.test.ts`（7/7）+ 全量 + 8.2-F 探针，再转 PASS |
| N2 | **S7 决策的 `evaluation_digest` 不可复算** | **P1 / 已知残余** | `decision-record.ts:225-227` 只校验格式与 binding；`§17.1 S7-03` 自述「本工具无法复算」；`screening_evaluate` 不输出 `basis_refs`，`reasons_digest` 需调用方自算 | 让 `screening_evaluate` 直接输出 `basis_refs`（含 `evaluation_digest`/`reasons_digest`）并让 `decision_record` 复算比对；否则 R3/INV-9 的「可回溯」在此层只是自述 |
| N3 | **`SCREENING_DECISION.basis_refs` 嵌套键被 parser 拒** | P1 / 已知残余 | `BASIS_KEYS.SCREENING_DECISION`（`decision-record.ts:219`）只允许 `id/result/decided_at`；`§17.1` 自述 `hasScreeningRejectionBasis` 成死代码 | 补嵌套 `basis_refs` 的 schema + DC-27 反证路径测试 |
| N4 | **S6→S10 端到端未发生** | **P0 / BLOCKED** | DB：`both_bound=0`、`SCREENING=0`、7 条 S6 申请全部停在 S6 | 选定 1 条申请，按 `application_id` 跑完 8 步并留 DB 读回；阶段推进用受控命令或明确标注手工 |
| N5 | **真实简历门槛未达** | **P0 / BLOCKED** | DB 8 assets；`evidence/.../real-resume-gate/README.md:66-69` 自述 intake/screening 未做 | 按 docs/21 §8 跑 ≥20 份，报四数 + ≥5 份可解释抽样 |
| N6 | **S8 四 intent 未实现** | P1 / FAIL | `intent enum=['CREATE']` | 实现 `RESCHEDULE/CANCEL/WITHDRAW_INTERVIEWER` 或把 v1.0 子集写进契约/台账并改 docs/18 |
| N7 | **S3 rubric 批准无产品入口** | P1 / BLOCKED | 无注册工具；仅 `manual/job-line/approve-rubric.mjs` | 注册人类通道工具或明确 CLI 运维口并回抄 |
| N8 | **阶段推进无入口** | P1 / BLOCKED | `src/tools/**` 无 `current_stage_code` 更新 | 补受控推进命令（或明确 v1.0 不做） |
| N9 | **Feishu connector 未接线** | P1 / BLOCKED | `src/` 无工具 import connector | 真实 provider 回读（独立 LIVE gate）或保持诚实 BLOCKED |
| N10 | **标签二义性/缺三轴** | P2 / FAIL | schedule/job-create 硬编码 LIVE；candidate_get 无 labels | 契约钉死 fixture 租户口径；candidate_get 补三轴或书面豁免 |
| N11 | **docs/18 / CONTRACT.md / README 口径漂移** | P1 / FAIL | 8.4 P2-01/P2-05 | 集成时一次性回抄（工具数 19、表 47、S8 子集、决策路径、D-95） |
| N12 | **approval 在事务内等待**（D-101 记债） | P2 / 债务 | 两个工具的 approval 在业务校验后、写库前，最长 120s 持事务；`pool.ts` 加 `idle_in_transaction_session_timeout=300s` 兜底 | 按 D-101 触发条件做两阶段重构（触发条件已写死） |
| N13 | **DB 数据卫生**：2 条 `interview.stage_code='S9'` | P2 / FAIL | 8.2-G | 修 seed 脚本；契约明确 `interview.stage_code` 合法集合 |
| N14 | **未配置替身开放 schema** | P3 / FAIL | `index.ts:214/249/252` | 改 `additionalProperties:false` |
| N15 | **宿主会话/浏览器验收未复跑** | 证据边界 | 本轮只做到 `apply()` 注册 + 定义执行；没有 Web/headless 会话级工具调用；approval 的真人点击无法在本窗口完成 | 复审按 D-88 起 Web + 浏览器，真人点 Allow，DB 读回 + F5 |

**本轮最严重的 3 个未闭合项**：
1. **N1 S6 身份闸门修复未提交**（唯一剩余 P0，且它守的是「会不会挂错人」）；
2. **N4/N5 端到端与真实简历门槛仍未发生**（S7 决策现在能写，但只写在回滚事务/测试里）；
3. **N2 S7 决策的 evaluation_digest 不可复算**（S7 的「证据」目前是调用方自述 + 绑定核对，不是可复算的投影）。

### 8.6 本轮证据边界（诚实说明）

1. 全量 820 测试跑在「HEAD `6d253f4` + 另一 lane 未提交改动」的工作树上，**不是单一 commit 快照**；数字只能用于本轮判断，复审需在干净快照重跑。
2. S6 身份闸门的修复、converter 的 provenance 传播、`intake-identity-gate.test.ts` 都在工作树，**未提交**；本轮只证明「行为已修」，不证明「已交付」。
3. 没有真实提交的 `SCREENING` 决策、没有一条端到端申请；所有 S7/闸门写入均在**回滚事务**内完成（DB 前后行数一致：scorecard 2、interview 6、decision 1）。
4. 未跑 Web/headless 宿主会话（approval 真人点击本窗口做不到）；R2 严格意义上的「运行中的入口」仍只有 `apply()` 注册 + 定义执行这一层。
5. 另一 lane 正在改 `converter/**`、`docs/11`、`test/regression`，范围外，本报告不判；若这些改动动了字段 provenance / OCR 兜底，§8.2-F 的结论要重跑。

### 8.7 下一次复审必须重跑

```powershell
# 0) 记录基线
git rev-parse HEAD; git status --short

# 1) 全量四数（必须在干净或明确记录的工作树上）
cd dsh\dsh-recruitment; $env:RECRUITMENT_DB_PASSWORD='123456'; node --test

# 2) 闸门（回滚事务；期望 unavailable/rejected/timeout 零写入、allowed-once 才写）
#    → 复用本窗口探针逻辑；或跑 test/unit|integration/{evaluation-scorecard-submit,interview-schedule}

# 3) S7 决策（回滚事务）：
#    SCREENING 成功（S7）+ v1-with-text 拒 + interview/summary 拒 + 缺 SCREENING_EVALUATION 拒 + 重复 ALREADY_DECIDED
#    → test/integration/evaluation-decision-record.test.ts 已覆盖，仍须本窗口独立探针复核

# 4) 23P01：translateWriteError({code:'23P01',constraint:'uq_decision_current'}) -> ALREADY_DECIDED
#    + DB 双事务并发插入（后者 COMMIT 应得到 ALREADY_DECIDED，不是裸 23P01）

# 5) D-95 v2：有原话只接受 v2；无原话只接受 v1；改原话/确认人/时间必须 CONFIRMATION_TEXT_MISMATCH

# 6) S6 身份：OCR/agent_read/unknown 只能进 weak，不得进 strong/identity_merge_eligible
#    （WIP 提交后：node --test test/integration/intake-identity-gate.test.ts）

# 7) material：isHard(pdf_text_recovered_by_ocr)=false；mapParseStatus(complete,N,[recovered])=PARSED

# 8) DB：decision 按 scope（S7 决策提交后应出现 SCREENING/S7 行）；both_bound>0；verify.sql + verify-0006..0010 全 PASS
```

