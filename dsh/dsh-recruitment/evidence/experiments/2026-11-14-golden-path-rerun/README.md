# Golden Path S6 → S10 修复后复跑（干净快照 · 2026-11-14）

> **身份**：lane `golden-path-rerun`（子代理）。任务：在**干净快照**上复跑 S6→S10，
> 给出「F1 修好之后，Golden Path 现在到底能走到哪一步」的真实结论。
>
> **纪律**：不接受旧报告、不接受自述；结论只来自本次现场执行的命令 + 真实输出 + DB 读回。
> **PII / R7**：简历与转写全是合成内容；日志只出现 id / 哈希 / 计数 / 打码值。
> **写范围**：只新增 `manual/golden-path/**` 与 `evidence/experiments/2026-11-14-golden-path-rerun/**`；
> 未改 `src/**`、`docs/**`、`converter/**`、`db/**`；未 commit / 未 push / 未切分支（见 `git-state.txt`）。

---

## 0. 一句话结论

**S6 → S10 的业务链，在 F1 修复后的干净快照上已经整条走通。**
16 跳全部 PASS（含 2 个闸门负例）、`summary.failures = 0`、退出码 0；**每一跳都有 DB 读回，
每个写跳都是真实写库**（写只经 `tool.execute()`）：

- S7 人决定**真的落库**：`decision(SCREENING, S7, ADVANCE)` = `1fc6e88d-3883-40b7-8246-7cb20c9f4b35`；
- S10 汇总**真的出 digest**：`695faa7387d7e81ad6578e071f81e123ad5b9a475e1b0e78feee21923cf8e4c4`；
- S10 人决定**真的落库**：`decision(STAGE, S10, ADVANCE)` = `447e3479-5dac-4524-948a-94059d8a053d`；
- 终态申请 `5b16c710-d75c-4a26-ab19-0b9c0591be1e`：`rubric_version_id=…0404`（F1 钉住）、
  1 场面试、1 版 canonical 转写 + 11 段、1 条 `interview_record`、2 份面评、**2 条决策**。

**但「阶段码推进」还差最后一段**：`application.current_stage_code` 终值 = **S8**，不是 S10。
原因不是复跑失败，而是产品现状：唯一写入口 `recruitment_application_stage_advance` 的梯子
**只覆盖 S6→S7→S8 两条边**（`src/domain/stage-advance.ts:309-312`），没有 S8→S9 / S9→S10。
→ 结论：**业务真相（决策/面评/转写）到 S10 了；阶段事实只到 S8**（新缺口 D-A，见 §6）。

---

## 1. 这次复跑的口径

### 1.1 干净快照

工作树当时有 **50 项其它 lane 的未提交改动**（含 `src/**`），不是干净快照。本次用
`git archive HEAD` 取**只含 committed 代码**的快照，依赖目录用 junction 指回工作树：

| 项 | 值 |
|---|---|
| 快照 commit | **`30f501c9d98afc38404288e0a8857ea0f6165a5b`**（`feat(document): RTF 进格式覆盖…（修 4a5dfd3 的 media.ts 缺导出）`） |
| 快照方式 | `git -C <repo> archive --format=tar HEAD` → 解包到 `D:\12412\dsh工作区\temp\2026-11-14-golden-path-rerun-snapshot-30f501c`（**无 .git、无未提交改动**） |
| 依赖 | `node_modules` 目录 junction 指回工作树同名目录（同一份已安装依赖，不含产品代码） |
| harness | `manual/golden-path/**` 是未追踪目录 → 按文件复制进快照（sha256 见 §5） |
| 报告写作时分支 HEAD | `b0136a4`（并发 lane 仍在提交）；`git diff 30f501c..HEAD -- src/tools src/domain src/db converter src/document` = **空** → 复跑结论对当前 tip 仍成立（`git-state.txt`） |

> **快照本身的一次失败（已修，留证）**：第一次取 `HEAD=4a5dfd3` 的快照，干净 checkout **连 import 都失败**：
> `src/tools/application-intake.ts:67` 已引用 `MEDIA_RTF`，但 `media.ts` 的导出当时还没提交
> （`SyntaxError: … does not provide an export named 'MEDIA_RTF'`）。该提交随后由 `30f501c` 修复
> （commit message 自己写了"修 4a5dfd3 的 media.ts 缺导出"）。本 lane 没有在坏快照上绕过，
> 改为在 `30f501c` 上重取快照。原始报错见 `commands.txt` §[1]。

### 1.2 哪些是真的、哪些是替身（与旧报告同口径，只更新结论）

| 项 | 口径 |
|---|---|
| 工具调用 | 真实工具对象：`create*Tool(...)` → `tool.execute(args, exec)`；不经 API、不经模型 |
| 数据库 | 真实 PostgreSQL 17 / `ra_s6s7`；写只经 `tool.execute()`；`pg` 只做 SELECT 读回与行数统计 |
| converter | 快照内**已提交版本**的 `converter/`（PyMuPDF）；合成 PDF 有原生文字层，`completeness=complete`、`hard_issues=0` |
| 人机闸门 | 真实闸门代码 + **allow-once / deny 替身**（只替"人"，不替闸门）：S8 排期、两份面评都过 `ctx.approval`；deny 负例实测一行不写 |
| 决策闸门 | D-95 `IN_CHAT` + 逐字 `confirmation_text` + 服务端同一份 `confirmationTextSha256`；实测 `approval.request` 调用 **0 次**（不再二次弹窗） |
| 合成身份 | 官方 run 用**新**合成身份 `lin.chengyu.gp8@example.test / +8613600000888`（fixture sha256=`aa2f4645…`，10919 bytes） |
| 数据真实性 | 全链 `provenance=FIXTURE`；本报告**不认任何 LIVE**（见 §7） |
| 手工数据 | **零**：没有手工 UPDATE、没有手工钉 rubric、没有手动插决策/面评/转写 |

### 1.3 fixture 与 harness 的 sha256

- fixture：`manual/golden-path/fixtures/gp-rerun-2/synthetic-resume-golden-path.pdf`
  `sha256=aa2f4645c7535bd83fbc3e8066ac628051adaefc0ed236e4ee7e9695905252df`
- 复跑 harness：`manual/golden-path/run-golden-path-rerun.mjs`
  `sha256=093f091e02968e7e88819252151615fa54e7cf1c03e32a7bed82ddd97c306538`
- 原版 harness（未改动）：`manual/golden-path/run-golden-path.mjs`
  `sha256=23fcaec3380ce1433978d2a1d67395a2c58f6db2a15666b31496a56818f2ade7`（与旧报告 run C 一致）

---

## 2. 逐跳结果表（官方 run `run-2026-11-14T13-03-45-994Z`，EXIT=0）

申请 `application_id=5b16c710-d75c-4a26-ab19-0b9c0591be1e`；每跳的请求/回执/行数差/读回都在
`run-…/hop-*.json`，完整 stdout 在 `run.log` 与 `console-run-official.log`。

| # | 跳 | 工具 | 结果 | DB 读回（真实值，摘） |
|---|---|---|---|---|
| 0 | 预检 | SQL（只读） | PASS | `job=DEMO-BE-001 OPEN`，`current_rubric=…0404`（v2 已批准、hash 对齐）；`both_bound=14`；<br>rubric v1 `…403` 无审批（不会被选），v2 `…404` approved+hash_match |
| 1 | **S6 接入** | `recruitment_application_intake` | **PASS** | `application=CREATED 5b16c710…`；`rubric_version_id=…0404`（**F1 钉住**）；<br>`resume_version=5fba8b67…` `parse_status=PARSED`；`+1 candidate/application/resume/resume_version/intake_asset/intake_record/event` |
| 2 | **阶段 T1（S6→S7）** | `recruitment_application_stage_advance` | **PASS** | `ADVANCED`，`transitions=[S6→S7]`，`stage_code=S7`，`record_version=2`；<br>`+1 stage-changed 事件`（`stage_changed_by_actor_id=…0103`） |
| 3 | S7 建议（只读） | `recruitment_screening_evaluate` | **PASS** | `verdict=PASS`、`criteria_evaluated=true`、<br>`rubric.resolution=APPLICATION_PINNED`、`rubric_pin_required=false`、`warnings=[]`、<br>`evaluation_digest=77229733…`；`decision` 行 0 条（本跳不写） |
| 4 | **S7 决策（写）** | `recruitment_decision_record(SCREENING)` | **PASS（WROTE）** | `decision=1fc6e88d-3883-40b7-8246-7cb20c9f4b35`，`scope=SCREENING stage=S7 result=ADVANCE`；<br>`basis_kinds=[AUTHORITY,RESUME_VERSION,RUBRIC_VERSION,SCREENING_EVALUATION]`；`+1 decision +1 event`；<br>`approval.request=0`（IN_CHAT 不二次确认） |
| 5 | **阶段 T2（S7→S8）** | `recruitment_application_stage_advance` | **PASS** | `ADVANCED`，`transitions=[S7→S8]`，`stage_code=S8`，`record_version=3`；`+1 stage-changed 事件` |
| 6 | S8 闸门负例 | `interview_schedule` + **deny** | **PASS（负例）** | `FORBIDDEN/APPROVAL_NOT_GRANTED`，`approval_requests=1`，`interview` 行数 **0 增量** |
| 7 | **S8 排期（写）** | `interview_schedule` + allow-once | **PASS** | `interview=cc3403e6…`（round 1，`SCHEDULED`，`stage=S8`，2026-12-09 10:00+08）；<br>`+2 interviewer`（0103/0104，required_scorecard）、`+1 meeting`、`+1 meeting_binding`、`+1 business_task(SUCCEEDED)`；<br>labels=`FIXTURE/MANUAL/NOT_CONNECTED` |
| 8 | S8 面试读 | `interview_get` | **PASS** | 面试 + 2 面试官 + `BOUND_ACTIVE` 会议绑定；`transcript=PENDING`、`evaluation_ready=false`；<br>labels=`FIXTURE/MANUAL/CONNECTED` |
| 9 | **S9 转写导入（写）** | `transcript_import` | **PASS** | `+1 transcript_artifact c9b03128…`（canonical、`READY`、`FIXTURE/MANUAL/NOT_CONNECTED`）、`+11 transcript_segment`、<br>**`+1 interview_record 204a735a…`（`NEEDS_REVIEW/UNVERIFIED`）** —— 旧报告的 `RECORD_NOT_CREATED_NO_RUBRIC` 已消失 |
| 10 | S9 转写读 | `transcript_read` | **PASS** | `transcript.state=READY`、`reason_code=CANONICAL_STATUS`、canonical rev1、11 段；<br>warning 仅 `RECORD_NOT_READY`（旧报告的 `RECORD_MISSING` 已消失）；labels=`FIXTURE/MANUAL/CONNECTED` |
| 11 | S10 闸门负例 | `scorecard_submit` + **deny** | **PASS（负例）** | `FORBIDDEN/APPROVAL_NOT_GRANTED`，`scorecard` 行数 **0 增量** |
| 12 | **S10 面评 103** | `scorecard_submit` + allow-once | **PASS** | `scorecard=b246062a…`（`SUBMITTED/ADVANCE`，作者=0103 的 interviewer 行 `06ae4ab4…`，rubric=…0404）；<br>warning 仅 `FIXTURE_BASIS`（旧报告的 `RUBRIC_EXPLICIT_NOT_PINNED` 已消失） |
| 13 | **S10 面评 104** | `scorecard_submit` + allow-once | **PASS** | `scorecard=ed634dc3…`（`SUBMITTED/ADVANCE`，作者=0104 的 interviewer 行 `23bccf46…`）→ 必交面板 **2/2** 齐 |
| 14 | S10 汇总（只读） | `evaluation_summarize` | **PASS** | `ready_for_decision=true`；`coverage required=2 submitted=2 missing=0`；`tally advance=2`；<br>`consensus=UNANIMOUS_ADVANCE`；`record.state=NOT_READY`；`permitted=[ADVANCE,HOLD,WITHDRAW]`；<br>`summary_digest=695faa73…` |
| 15 | **S10 决策（写）** | `decision_record(STAGE)` | **PASS（WROTE）** | `decision=447e3479-5dac-4524-948a-94059d8a053d`，`scope=STAGE stage=S10 result=ADVANCE`；<br>`basis_kinds=[AUTHORITY,RUBRIC_VERSION,SCORECARD,SUMMARY]`（5 条，含 2 条真实面评）；<br>`gate` 回显 `summary_digest=695faa73…`、`ready_for_decision=true`；`+1 decision +1 event` |
| 16 | **阶段推进（S10 后）** | `stage_advance` | **PASS（NO_OP）** | `stage_code=S8`、`transitions=[]` —— 工具梯子只到 S8（缺口 D-A），不是本轮失败 |
| 17 | 终态读回 | SQL（只读） | — | 见 §3 |

行数对比（预检 → 终态，真实打印自 harness，只列变化）：

```text
{"application":1,"business_task":1,"candidate":1,"decision":2,"event_inbox":7,"intake_asset":1,
 "intake_record":1,"interview":1,"interview_record":1,"interviewer":2,"meeting":1,"meeting_binding":1,
 "resume":1,"resume_version":1,"scorecard":2,"transcript_artifact":1,"transcript_segment":11}
```

`summary.json`（官方 run）：`failures=0`、`product_blockers=[]`、`final_state.application_stage=S8`、
`decision_count=2`、`scorecard_count=2`、`interview_record_count=1`。

---

## 3. 终态 DB 读回（独立脚本，不 import 产品代码）

命令：`node manual/golden-path/db-readback.mjs 5b16c710-d75c-4a26-ab19-0b9c0591be1e`（EXIT=0）
全文：`db-readback-independent.txt`。摘要：

```text
-- 申请：材料 + rubric pin 都在，阶段 S8（不是 S10，见缺口 D-A）
application 5b16c710…  stage=S8  lifecycle=ACTIVE  record_version=3
  rubric_version_id=…0404  resume_version_id=5fba8b67…  stage_changed_by_actor_id=…0103
  stage_entered_at=2026-11-14 21:03:55.462+08

-- 材料链（合成 PDF）
resume_version v1 parse_status=PARSED sha256=de19b5ca… source_asset_sha256=aa2f4645…(VALID)
intake_asset 1abe0ac1… file=synthetic-resume-golden-path.pdf bytes=10919
event resume.intake.received（internal/INTERNAL，source_object_id=aa2f4645…）

-- 决策（两条都来自真实 approve 后的写路径；事件里带 D-95 v2 哈希）
SCREENING/S7/ADVANCE   1fc6e88d…  basis=4 [AUTHORITY,RESUME_VERSION,RUBRIC_VERSION,SCREENING_EVALUATION]
                        confirmation_method=IN_CHAT preimage_version=2
STAGE/S10/ADVANCE      447e3479…  basis=5 [AUTHORITY,RUBRIC_VERSION,SCORECARD,SUMMARY]
                        summary_digest=695faa73… confirmation_method=IN_CHAT preimage_version=2

-- 面试 / 会议
interview cc3403e6… round1 DEFAULT S8 SCHEDULED 2026-12-09 10:00+08  record_version=1
interviewers: 0103 / 0104（都 required_scorecard=true）
meeting_binding: SYNTHETIC_DEMO synthetic-meeting-5b16c710d75c（绑定 ACTIVE）
business_task 85b52269… INTERVIEW_SCHEDULE SUCCEEDED

-- 转写 / 记录 / 面评
transcript_artifact c9b03128… rev1 canonical READY FIXTURE/MANUAL/NOT_CONNECTED segments=11
interview_record 204a735a… status=NEEDS_REVIEW verification=UNVERIFIED evidence_ok=true is_current=true
scorecard b246062a… SUBMITTED/ADVANCE author=06ae4ab4…(0103) transcript_basis=TRANSCRIPT
scorecard ed634dc3… SUBMITTED/ADVANCE author=23bccf46…(0104) transcript_basis=TRANSCRIPT

-- 阶段审计（fn_row_guard 写的事件，不是 harness 造的）
application.current_stage_code.changed  S6→S7  (actor 0103)
application.current_stage_code.changed  S7→S8  (actor 0103)

-- 全库计数
applications=57  with_material=56  with_rubric=17  both_bound=16    ← 复跑前 both_bound=14
decision: SCREENING/S7=9（复跑前 7）  STAGE/S10=2（复跑前 1）
```

> 注：`decision` 表本身没有 `summary_digest` / `human_confirmation` 列 —— 这两项写在
> 决策的 `event_inbox` payload 里（本读回的 `decision_summary_digest` / `confirmation_text_sha256`
> 就取自那里），不是"没落库"。

---

## 4. 旧报告 vs 复跑：F1 及其下游逐条销账

旧报告 = `evidence/experiments/2026-11-14-golden-path-e2e/README.md`（断在 S7）。

| 旧报告项 | 旧结论 | 本次复跑 | 判定 |
|---|---|---|---|
| **F1** `application.rubric_version_id` 无产品写入路径（S7 断链根因） | HOP3 `NOT_FOUND/RUBRIC_VERSION_NOT_FOUND` | S6 intake **新建即钉** `…0404`；S7 决策 **WROTE** | ✅ **已修**（`1b23fff` / D-108；写入点 `application-intake.ts` F1 段 + INSERT 的 `rubric_version_id`） |
| **F2** S10 `evaluation_summarize` 被同一 pin 挡住 | `RUBRIC_VERSION_NOT_FOUND` | `OK`，`ready_for_decision=true`，`summary_digest=695faa73…` | ✅ **已修**（随 F1；读侧 `APPLICATION_PINNED`） |
| **F3** S10 `decision_record(STAGE)` 被同一 pin 挡住 | `RUBRIC_VERSION_NOT_FOUND` | `WROTE`，`STAGE/S10/ADVANCE` | ✅ **已修**（随 F1） |
| **F4** 阶段推进无执行者（`current_stage_code` 全程 S6） | 停在 S6 | S6→S7→S8 真实迁移（2 条审计事件）；**S10 决策后仍是 S8** | ⚠️ **部分修**：入口有了，梯子只到 S8（**新缺口 D-A**） |
| **F5** S8/S9 读工具与排期把 FIXTURE 报成 `LIVE`（R4 冲突） | 工具报 `LIVE` | 本 run 全部 `provenance=FIXTURE`（schedule / interview_get / transcript_read / scorecard / summarize 一致） | ✅ **已修**（`b2d51cd` 等标签修复；本 run 零 LIVE 误报） |
| **F6** pin 缺失的下游连锁：`RECORD_NOT_CREATED_NO_RUBRIC`、`RUBRIC_EXPLICIT_NOT_PINNED` | 两个 warning | 都**消失**：interview_record 已建（NEEDS_REVIEW/UNVERIFIED）；面评按 `APPLICATION_PINNED` 提交 | ✅ **随 F1 消除** |
| **旧 §5 harness 复跑约束**：`SCHEDULED_START_AT` 过期要改 | 2026-12-02 | 该时间**未过期但已被旧 run A 占用** → 复跑撞 `CONFLICT_SLOT`；改到 2026-12-09 后 PASS | ⚠️ harness 常量问题（D-C），非产品缺陷 |
| **旧报告「12 跳里 9 跳符合预期」** | 3 跳被 F1 挡 | **16 跳全部 PASS**、0 意外失败 | ✅ 结论已过期，以本报告为准 |

**新增一跳**：旧 harness 没有调用 `recruitment_application_stage_advance`（docs/18 §3 说它是阶段码唯一写入口），
本次补上 T1 / T2 / S10 后共 3 次调用 —— 这也让 F4 的真实状态第一次被端到端观察到。

---

## 5. harness 变更（**不是放宽闸门**）

原版 `run-golden-path.mjs` **未改动**（sha256 与旧报告 run C 一致）。本次新增派生版
`run-golden-path-rerun.mjs`，逐条 diff 在 `harness-diff.txt`（604 行）。变更只有 5 类：

1. **证据目录**改到 `evidence/experiments/2026-11-14-golden-path-rerun/`（否则会污染旧证据目录）。
2. **期望值从"预期阻断"改成"必须成功"**：旧版把 S7 决策 / S10 汇总 / S10 决策标为
   `expected-blocker`（接受 `RUBRIC_VERSION_NOT_FOUND` 为 PASS）——F1 修好后继续这样标，
   等于**把缺陷当成功**。派生版要求这三跳 `ok=true`，失败即 FAIL。
3. **S10 决策改用真实值**：旧版因拿不到汇总，传的是**假 summary_digest** + **随机 INTERVIEW_RECORD**；
   派生版先真实调用 `evaluation_summarize`，用真实 `summary_digest`、真实面评 id/overall/payload_hash、
   真实 rubric 组装 `basis_refs`（**闸门与校验一条没改**，只是把假值换成真值）。
4. **补齐必交面板**：2 位面试官都是 `required_scorecard=true`；旧版只交 1 份（汇总 `missing=1`），
   派生版由第 2 位面试官本人再交 1 份（同样过 allow-once 闸门），使 `ready_for_decision=true`。
   这不是"放宽"，是把流程走完整；不走旁路时也可用 `PROCEED_WITH_MISSING`，但那是"缺人推进"。
5. **补阶段推进跳**（T1/T2/S10 后各一次）+ 换新合成 fixture（gp8）与把面试时间常量改到空闲时段。

**没有做的事**：没有放宽任何 `approval` 闸门、没有跳过任何字段校验、没有手工 UPDATE 业务行、
没有手工钉 rubric、没有改 `src/**`。

---

## 6. 仍然存在的缺陷 / 缺口（本轮新发现）

### D-A（P1，范围缺口）· 阶段推进梯子只有 S6→S7→S8，Golden Path 的阶段码到不了 S10

- **现象**：S10 决策都写进库了，`application.current_stage_code` 终值仍是 **S8**；
  HOP 16 再调 `stage_advance` 返回 `NO_OP @ S8`（`transitions=[]`）。
- **根因（代码级）**：`src/domain/stage-advance.ts:309-312` 的 `LADDER` 只定义两条边
  `S6→S7 (T1)`、`S7→S8 (T2)`；工具 DESCRIPTION 也写 "Ladder (only these two edges)"；
  `docs/18 §3` 却把这个工具描述为 `current_stage_code` 的**唯一写入口**。
  → 没有任何产品路径能把阶段码推到 S9 / S10。
- **影响**：Golden Path 的"业务链"到 S10 了，但"阶段事实"只到 S8：
  Web 工作台按阶段统计会把已完成 S10 的申请算成 S8；`docs/23` N8 只能算**部分闭合**。
- **复现**：本 run HOP 16 / 终态读回；或直接
  `node manual/golden-path/db-readback.mjs <app>` 看 `current_stage_code=S8` 而
  `decisions` 已有 `STAGE/S10/ADVANCE`。
- **归属**：需要产品裁决（扩梯子 S8→S9→S10，或明确"阶段码只到 S8、S9/S10 由别的事实表达"）。
  **本 lane 不改 `src/**`，只报告。**

### D-B（P2，证据链缺口）· `interview_record` 建出来就是 `NEEDS_REVIEW/UNVERIFIED`，没有产品工具把它转 `VERIFIED`

- **现象**：`transcript_import` 现在能建 `interview_record`（F1 修好的直接结果），但状态是
  `status=NEEDS_REVIEW`、`verification_status=UNVERIFIED`（`204a735a…`）；
  `evaluation_summarize` 因此给 `record.state=NOT_READY` + warning `RECORD_NOT_READY`；
  S10 决策**不能**引用 `INTERVIEW_RECORD` 依据（DC-23 要求 READY+VERIFIED），
  本次 basis 只有 `SUMMARY/RUBRIC_VERSION/AUTHORITY/SCORECARD`。
- **影响**：S10 决策仍然合法（DC-23 只挡"引用了未就绪记录"），但 Golden Path 的证据链少一环：
  "转写 → 结构化面试记录 → 决策依据"里的中间环节没有可用的**产品内**校验动作。
- **复现**：HOP 9 回执 `record=204a735a… status=NEEDS_REVIEW verification=UNVERIFIED`；
  HOP 14 `record.state=NOT_READY`；grep `src/**` 没有任何工具写 `interview_record.verification_status='VERIFIED'`
  （只有 transcript_import 写 `UNVERIFIED`）。
- **归属**：需要产品决定（补"人工复核/校验"入口，或明确 v1.0 不把 record 作为决策依据）。
  本 lane 只报告。

### D-C（P3，harness/运维常量）· 旧 harness 固定面试时间与共享库历史数据冲突

- 旧 `SCHEDULED_START_AT=2026-12-02T10:00+08` **没有过期**，但已被旧报告 run A 的面试
  （同一批面试官 103/104）占用 → 复跑必得 `CONFLICT_SLOT/INTERVIEWER_BUSY`（工具 fail closed，正确）。
- 处理：派生版常量改到 `2026-12-09T10:00+08`（复跑前查库确认 103/104 空闲）；未放宽冲突校验。
- 证据：`console-attempt-0-slot-collision.log`（app `6b9fc6c3…`，该次复跑停在 HOP 7）。

### D-D（过程，已修复）· `4a5dfd3` 的干净快照无法 import intake

- `application-intake.ts` 引用了尚未提交的 `MEDIA_RTF` → 干净 checkout 直接 `SyntaxError`；
  由 `30f501c` 修复。留证于 `commands.txt` §[1]。
- 教训（供上层参考）：并发 lane「先提交调用方、后提交导出」会短时间破坏 HEAD 的可运行性；
  干净快照复跑是发现这类问题的有效手段。

---

## 7. 边界与诚实声明

1. **R2 未闭合**：本 run 仍是"工厂产出的工具对象 → `execute()`"，**不是** DSH Web/headless 宿主会话路由。
   docs/23 §6.3 的 Web 复跑证据仍需单独做。
2. **没有真实模型**：intake 未传 `structured_json`，身份来自 converter 的 `native_text`；
   D-67 的 `agent_read` 分支未覆盖。
3. **approval / IN_CHAT 是替身**：allow-once 表示"人允许一次"，不是真人在 UI 点；
   D-95 的 IN_CHAT 原话是 harness 按任务书给的**合成人话**（仅合成候选人内容）。这证明工具路径与闸门逻辑，
   **不能**把"人机闸门不可绕过"写成已由真人验证。
4. **R4**：本 run 全部 `provenance=FIXTURE`；没有一条 LIVE 外部事实。合成会议/转写不得用于 demo gate（D-1）。
5. **共享库副作用**：`ra_s6s7` 是共享演示库。本轮新增 **2 条合成申请**：
   `6b9fc6c3…`（尝试 0，停在 S8、有 SCREENING 决策）与 `5b16c710…`（官方 run，全链）；
   以及相应的部门/面试/转写/面评/决策行（见 §2/§3 行数差）。没有删任何行、没有改他人数据。
6. **迁移口径**：本机 DB 有其它 lane 的 `0015_runtime_cutover`，而快照 `30f501c` 的 `db/migrations` **不含**
   0015（该迁移在后续 commit `2329d2e` 才入库）。本 run 不依赖 0015，未做任何迁移/建库/删库。
7. **复跑可重复性**：同一 fixture 再跑会 `REUSED`（F1 只在新建立即钉；且 SCREENING 决策唯一性会
   `ALREADY_DECIDED`）。要再跑一遍必须换**新的合成身份**（fixture + `GOLDEN_PATH_FIXTURE` /
   `GOLDEN_PATH_EMAIL` / `GOLDEN_PATH_PHONE_NORM`），或用新库 —— 这不是缺陷，是"同一条申请只筛一次"的
   唯一性约束；旧报告 §5 也写了同类约束。
8. **`DECIDER_NOT_HIRING_MANAGER` warning**：决策人 actor 103 不是部门招聘负责人（102 是），
   按 DC-14 v1.0 只记录不拦截 —— 属既有产品口径，不是本轮缺陷。
9. **快照之后分支 HEAD 继续前进**（并发 lane）：`30f501c..b0136a4` 三个提交都不改
   `src/tools` / `src/domain` / `src/db` / `converter` / `src/document`（`git diff` 为空），
   所以本结论对当前 tip 仍成立；但"tip 上再跑一次"仍建议由独立 lane 复核。

---

## 8. 复跑步骤（从零到本报告）

```powershell
# 0) 取干净快照（30f501c 是本次快照 commit；HEAD 之后会继续前进）
$repo='D:\12412\dsh工作区\projects\recruitment-agent'
$snap='D:\12412\dsh工作区\temp\2026-11-14-golden-path-rerun-snapshot-30f501c'
New-Item -ItemType Directory -Force $snap
git -C $repo archive --format=tar 30f501c9d98afc38404288e0a8857ea0f6165a5b -o "$snap\head.tar"
tar -xf "$snap\head.tar" -C $snap
Remove-Item "$snap\head.tar"
New-Item -ItemType Junction -Path "$snap\dsh\dsh-recruitment\node_modules" -Target "$repo\dsh\dsh-recruitment\node_modules"
Copy-Item "$repo\dsh\dsh-recruitment\manual\golden-path" "$snap\dsh\dsh-recruitment\manual\golden-path" -Recurse

# 1) 跑复跑 harness（提交式：真的写 ra_s6s7）
cd "$snap\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='<本机演示库密码>'
$env:GOLDEN_PATH_HEAD='30f501c9d98afc38404288e0a8857ea0f6165a5b'
node manual/golden-path/run-golden-path-rerun.mjs       # EXIT=0 = 16 跳全 PASS

# 2) 独立读回（只 SELECT）
node manual/golden-path/db-readback.mjs <application_id>

# 再跑一遍：换新合成身份（fixture + 三个 GOLDEN_PATH_* 环境变量），否则会 REUSED / ALREADY_DECIDED
# 生成新 fixture：
# python manual/golden-path/fixtures/build_synthetic_resume.py <out-dir> "136 0000 0999" "lin.chengyu.gp9@example.test"
```

---

## 9. 文件清单

```text
manual/golden-path/
  run-golden-path.mjs                 # 原版 harness（未改动，sha256=23fcaec3…；旧报告的复现入口）
  run-golden-path-rerun.mjs           # 本次派生版（sha256=093f091e…；改动只在证据目录/期望值/真实 basis/第2份面评/阶段推进）
  db-readback.mjs                     # 独立只读读回脚本（不 import 产品代码）
  fixtures/build_synthetic_resume.py  # 合成简历生成器（原版，支持 phone/email 参数）
  fixtures/gp-rerun/…                 # 尝试 0 的合成 PDF（gp7，sha256=e693b187…）
  fixtures/gp-rerun-2/…               # 官方 run 的合成 PDF（gp8，sha256=aa2f4645…）

evidence/experiments/2026-11-14-golden-path-rerun/
  README.md                          # 本文件
  commands.txt                       # 命令原文 + 真实输出（含坏快照 4a5dfd3 的报错、尝试 0 的 CONFLICT_SLOT）
  exit-codes.txt                     # 四条相关命令的真实退出码与依据
  db-readback-independent.txt        # 独立只读读回的真实输出
  console-run-official.log           # 官方 run 完整 stdout（EXIT=0）
  console-attempt-0-slot-collision.log  # 尝试 0（固定面试时间撞旧数据；非产品缺陷）
  harness-diff.txt                   # 原版 vs 派生版 diff（604 行）
  git-state.txt                      # 快照 commit / 当前 HEAD / 本 lane 只新增了哪些路径
  run-2026-11-14T13-03-45-994Z/      # 官方 run：run.log、hop-00..17 JSON、summary.json、fixture 副本、fixture.json
```
