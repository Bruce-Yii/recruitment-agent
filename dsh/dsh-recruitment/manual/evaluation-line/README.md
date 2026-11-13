# S10 评价线 · 独立面评 → 汇总 → 人工决策

**分支**：`feat/unified-document-intake`（本轮起点 `5581c26`；执行期间并发 lane 把 HEAD 推到 `21dab8c`，**本 lane 未 commit / 未 push**）。
**权威**：`contracts/evaluation/{scorecard-rules,decision-rules,tool-contracts}.md`（未改一个字）。

---

## 1. 交付物

| 文件 | 作用 |
|---|---|
| `src/tools/scorecard-submit.ts` | `recruitment_scorecard_submit`：一位 HUMAN 面试官交**自己**这一轮的面评（三绑定：轮次/Rubric 版本/提交时间；提交后冻结，改判走 supersede） |
| `src/tools/evaluation-summarize.ts` | `recruitment_evaluation_summarize`：**只读**投影（tally / consensus / missing / aggregation / blockers / permitted_results / summary_digest），**不产"建议结论"** |
| `src/tools/decision-record.ts` | `recruitment_decision_record`：把**人已经做出的决定**记进 `decision`；**必须过 DSH `ctx.approval`**（D-79），否则 fail closed |
| `test/unit/evaluation-*.test.ts`（3 个） | 参数层/纯函数/输出 schema（不连库） |
| `test/integration/evaluation-*.test.ts`（3 个） | 真库 `ra_s6s7` + `inRolledBackTx`（不污染库） |
| `manual/evaluation-line/**` | 演练与取证：seed、真实 headless 驱动、决策入参准备、DB readback、直接调用负例、证据目录 |

**未碰**：`contracts/evaluation/**`、`src/index.ts`、`src/db/**`、`db/**`、`converter/**`、`src/document/**`、`src/tools/{application-intake,screening-evaluate,job-get,contract,args,errors,definition}.ts`、`test/integration/db.ts`。

---

## 2. 个人开发者怎么跑（两个隔离演示身份，不需要两位真人）

```powershell
cd "D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment"
$env:RECRUITMENT_DB_PASSWORD='<本机 PG 密码>'          # 密码只在环境变量里，任何文件都没有

# 0) 演示夹具（S8/S9 侧：人工登记的面试 + 人工导入的转写；provenance=FIXTURE 显式写死）
node manual/evaluation-line/seed-demo.mjs

# 1) 两个隔离身份各交一份面评（真实 headless 会话；身份来自 profile 的 database.actor_id）
node manual/evaluation-line/run-headless.mjs --profile rec-eval-x --overlay manual/evaluation-line/patch/overlay-x.yml --label x --goal-file manual/evaluation-line/goals/x-submit.txt
node manual/evaluation-line/run-headless.mjs --profile rec-eval-y --overlay manual/evaluation-line/patch/overlay-y.yml --label y --goal-file manual/evaluation-line/goals/y-submit.txt

# 2) 汇总（只读；不产结论）
node manual/evaluation-line/summary-snapshot.mjs --scope STAGE --interview 11111111-1111-4111-8111-000000000801 --as-of 2026-11-13T19:00:00+08:00 --out sum

# 3) 准备决策入参（拼 basis_refs + 算 confirmation_text_sha256；只读）
node manual/evaluation-line/prepare-decision.mjs --summary manual/evaluation-line/evidence/sum/summary.json `
  --actor 11111111-1111-4111-8111-000000000103 --result ADVANCE --scope STAGE `
  --interview 11111111-1111-4111-8111-000000000801 --as-of 2026-11-13T19:00:00+08:00 `
  --reason "两名面试官独立提交，三个维度均 MET" --out decision

# 4) 决策（会先过 STEP 0–6，再问 approval）
node manual/evaluation-line/run-headless.mjs --profile rec-eval-decider --overlay manual/evaluation-line/patch/overlay-decider.yml --label decision --goal-file manual/evaluation-line/goals/13-decision-advance.txt

# 5) 读回
node manual/evaluation-line/readback.mjs --label readback
```

### 演示身份（`seed-demo.mjs` 造，全部 `kind='HUMAN'`，除标注外）

| 身份 | actor_id | 角色 |
|---|---|---|
| 面试官 X | `11111111-1111-4111-8111-000000000105` | 801 必交面试官；802 必交面试官 |
| 面试官 Y | `11111111-1111-4111-8111-000000000106` | 801 必交面试官（与 X **互不覆盖**） |
| 决策人（HR 专员） | `11111111-1111-4111-8111-000000000103` | 落 `decision` 的人 |
| 评价 Agent | `11111111-1111-4111-8111-0000000001a0` | `kind='AGENT_WORKER'`，负例用（不得写面评） |

### 三个 demo profile 怎么来的（在 `DSH_HOME` 下，不在仓库里）

`include` 了一个**只含 base + headless** 的 profile（模型/provider 段抄自 `recruitment` profile），
再用 `--patch <overlay>.yml` 把 `manual/evaluation-line/plugin-eval*.mjs` 以 **file URL** 插进层栈。
生成方式见本节命令；profile 名：`rec-eval-x` / `rec-eval-y` / `rec-eval-decider` / `rec-eval-agent`。

> **为什么不是改 `src/index.ts`**：`src/index.ts` 由 W0 独占（本轮禁写）。所以演示的**注册点**是
> `manual/evaluation-line/plugin-eval*.mjs`；agent loop、工具注册表、JSON Schema 校验、会话日志、
> `ctx.approval` 全是 DSH 自己的。W0 集成时把三个 factory 原样搬进 `index.ts` 并把 `ctx.approval`
> 传进去即可（`inject: ['tools','approval']`）。

---

## 3. 验收状态（2026-11-13 晚）

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | `node --test`（真库）四个数 | ✅ 见 §4 | 全量套件 |
| 2 | 两个隔离身份各交一份面评（真实 headless） | ✅ | `evidence/04-x-submit/`、`evidence/05-y-submit/` 的 `tool-trace.txt` |
| 3 | DB readback：`scorecard` 两行（interviewer_id 不同 / rubric 绑定正确） | ✅ | `evidence/19-readback/db-readback.txt` |
| 3b | DB readback：`decision` 一行 | ⛔ **BLOCKED**（无 approval answerer，见下）；写路径已用**回滚试跑**证明（`evidence/21-decision-dryrun/`）：`decided_by_actor_id=…103`（HUMAN，演示-HR 专员）、`stage_code=S10`、`basis_refs_count=5`、内部事件 1 条、`record_version=1` —— 随后 **ROLLBACK**，库里没有这条决策 | `decision` rows=0 |
| 4 | 负例 | ✅（详见 §5） | `evidence/01-*`、`14-*`、`15b-*`、`18b-*`、`20-negatives` |
| 5 | 决策必须经 DSH approval | ⛔ **BLOCKED（fail closed，已取证）** | `evidence/13d-decision-advance/tool-trace.txt` |

### 为什么 `decision` 落不了库（BLOCKED，不是绕过）

- DSH 的 approval 服务在 `dsh-base` 里挂载，**headless 没有任何 answerer**（`dsh-user-approval` README：
  "No built-in answerer — headless … resolve `unavailable` and fail closed"）。
- 所以真实 headless 里 `ctx.approval.request()` 恒返回 `unavailable`，工具按 D-79 返回
  `DECISION_REQUIRES_HUMAN(APPROVAL_UNAVAILABLE)`，**一行都不写**（`decision` rows=0 已读回）。
- 唯一的人机通道是 **Web UI 的 `dsh-client-ui-approval`**（人在浏览器里点"允许"）。本轮未启动
  Web 会话（会另起一个进程/端口，需用户在场点击），因此如实标 **BLOCKED**，不改写库路径。
- 需要的下一步（W0/用户）：`dsh --profile recruitment --patch <overlay-decider.yml>` 起一个 Web 会话，
  让真人点一次 approval；`decision` 行即会落库，`evidence/10-decision-advance/decision-args.json`
  就是可以直接喂进去的那份参数。

---

## 4. 测试（真库）

```powershell
$env:RECRUITMENT_DB_PASSWORD='<密码>'; node --test
```

- 改动前基线（`5581c26`）：**tests 389 / pass 389 / fail 0 / skipped 0**
- 本轮全量（`21dab8c` 的并发 lane + 本 lane）：**tests 708 / pass 708 / fail 0 / skipped 0**
- 本 lane 三个套件：`evaluation-scorecard-submit` 66、`evaluation-summarize` 26、`evaluation-decision-record` 57 —— 全部 pass、0 skip（合计 149）

---

## 5. 负例逐条

| 负例 | 期望 | 实测 | 在哪 |
|---|---|---|---|
| `items` 传**数组** | `INVALID_ARGS(TYPE_MISMATCH)` | ✅ 同 | `evidence/20-negatives/negatives.txt`（直接调用；**真实会话里模型按 schema 生成，不会自己发数组**） |
| 证据 `kind=TRANSCRIPT_SEGMENT` | `INVALID_ARGS(ENUM_INVALID)` | ✅ 同 | 同上 |
| agent 代填面评 | `INTERVIEWER_MISMATCH(ACTOR_NOT_HUMAN)` | ✅ 同（actor=`…1a0`，kind=AGENT_WORKER） | `evidence/18b-agent-impersonate/tool-trace.txt`（真实 headless） |
| 缺面评时 `REJECT` | 被拒 | ⚠️ 该场景里 `submitted=0`，先命中 `EVIDENCE_INSUFFICIENT(NO_SUBMITTED_SCORECARD)` | `evidence/14-decision-reject-802/tool-trace.txt` |
| 缺面评时 `FINAL` 推进 | `SCORECARD_MISSING(REQUIRED_SCORECARDS_INCOMPLETE)` | ✅ 同 | `evidence/15b-decision-final/tool-trace.txt`（真实 headless） |
| `record` 传 `idempotency_key` | `INVALID_ARGS(UNKNOWN_PARAM)` | ✅ 同 | `evidence/20-negatives/negatives.txt` |
| `result=HIRED` | `INVALID_ARGS(RESULT_NOT_IN_V1_SCOPE)` | ✅ 同 | 同上 |
| 缺面评时 `REJECT`/`FINAL`（真库、事务回滚） | `SCORECARD_MISSING` | ✅ 集成测试断言 | `test/integration/evaluation-decision-record.test.ts` |
| 已交后重新提交 | `ALREADY_SUBMITTED` | ✅ 集成测试 | `test/integration/evaluation-scorecard-submit.test.ts` |
| 幂等重放 | `replayed=true` 且不新增行 | ✅ 真实 headless 也复现过一次（`evidence/16-*`，重放旧 key） | — |

---

## 6. 与契约的偏差（必须回抄）

1. **新增 reason_code**：`ACTOR_REQUIRED`（上下文无 actor）；`APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`（D-79 晚于 TC §4.2 的封闭集）；`RATIONALE_NOT_PARSABLE`、`SCORECARD_NOT_FOUND`（G-1 的解析失败、重放行缺失）。
2. **`as_of` 格式错 → `TYPE_MISMATCH`**（TC §5.1 没有 `AS_OF_FORMAT`；`AS_OF_IN_FUTURE` 照用）。
3. **`items` 的动态维度键无法写进 JSON Schema**：DSH 只允许 `additionalProperties` 是布尔
   （实测 `must be a boolean`）。因此 schema 里只声明 `transcript_basis`，维度键靠 description 与
   工具校验兜。**这是产品可用性问题**：弱模型曾连续 34 次只交保留键 → 已把"必须逐个补维度键"写进
   `items.description`，但仍建议 W0 在 Web UI 里直接渲染 rubric 维度表单，别让模型自由生成。
4. **库缺口（0007 未应用）**：`reject_reasons`/`revision_reason` 挤进 `rationale`（`REJECT_REASONS_JSON:` 行）；
   幂等键落 `event_inbox`；`decision` 无 current 唯一索引 → 先查 + 条件更新 + 写后复核；**无 `FOR UPDATE`**。
5. **`superseded` / `scheduled_start_at` 为 null 时省略键**（DSH 校验器无 `type:null`，出参在 `execute()` 里 `stripNulls`）。
6. **`stage_code` 声明但拒收** → `TENANT_OR_ACTOR_NOT_ALLOWED`（TC §1.6 优先于 §7.1 #5）。
7. **FINAL 缺面评的 `permitted_results`**：取 `['HOLD','WITHDRAW']`（TC §3.5 末注 + DC §4.2.1），
   DC §11 C1 的 `permitted_results=[]` 与之冲突，按更晚/更明确的 §4.2.1。
8. **`aggregate.average` 的极端分支**：面板齐备但全部 `NOT_OBSERVED/UNREADABLE`（无任何数值 score）时返回 `0`，
   以让 M-1 的 ⇔ 字面成立；若产品要求"无分即 null"，需先改契约。

---

## 7. W0 集成 checklist（本 lane 不能做）

1. `src/index.ts`：`inject: ['tools','approval']`；给 `database` 配置之外再注册三个工具：
   `createScorecardSubmitTool({database})`、`createEvaluationSummarizeTool({database})`、
   `createDecisionRecordTool({database, approval: ctx.approval})`。
2. 未配置时注册 `NOT_CONFIGURED` 替身（与既有工具同一手法）。
3. 迁移 `0007`/`0008`（`uq_decision_current` + `uq_decision_current_final` + `ck_scorecard_terminal_actor` + `fk_scorecard_rubric_job`）**已于 2026-11-14 落地**；~~`scorecard.idempotency_key`~~ 这一列**从未存在过**（面评幂等走 `event_inbox.uq_event_inbox_idempotency`，见 db 证据 §3 的事实更正）。接下来要做的是：
   把 `uq_decision_current` 的 23505 映射成 `ALREADY_DECIDED`（`decision-record.ts` 已留分支）。
4. Web UI：一层 approval 提示（`dsh-client-ui-approval` 已存在）+ 决策表单（`permitted_results` / `blockers` / `minority_reports` 够用）。
