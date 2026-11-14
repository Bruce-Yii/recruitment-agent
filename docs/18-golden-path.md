# 18 · v1.0 Golden Path（DSH 版运行手册）

**取代**：`docs/08-DEMO-RUNBOOK.md`。那份是**老仓 monorepo** 的运行手册（`integration/v1.0-flow` 分支、
pg-boss、`packages/db`、1106 条测试），那套底座已废弃，不要照它跑。
**本文档管的是当前底座**：DSH Web profile + 招聘插件 + PostgreSQL + 本地转换器。

---

## 0. 一句话

一条纵向切片，从**一份真实简历 PDF** 走到**一条人做的招聘决策**，
每一步都写进 PostgreSQL，每一步都有可复读的外部事实。
v1.0 只证明三件事同时成立：**业务真相归领域**、**长任务跨会话**、**外部事实诚实**。

---

## 1. 底座（谁在哪一层）

| 层 | 是什么 | 在哪 |
|---|---|---|
| 产品壳 | DSH Web（profile `recruitment`） | `D:\12412\dsh-home\profiles\recruitment` |
| 业务入口 | 插件 `@recruitment/dsh-recruitment` 的 `recruitment_*` 工具 | `dsh/dsh-recruitment/` |
| 业务真相 | PostgreSQL 17，schema `recruitment`，**44 张基表 + 3 个视图**（迁移到 `0010`） | `db/migrations/`（0001–0010） |
| 文件→文本 | 本地转换器（PyMuPDF），四件套 | `converter/` |
| 读不出时 | agent 视觉补读（`page_image` → `read_image` → `model_text_merge`，D-81/D-107）+ 人工复核队列（`review/`） | 插件 `src/tools/` + `converter/review/` |
| 契约 | 每个阶段的领域规则与工具形状 | `dsh/dsh-recruitment/contracts/` |

> **表数口径**：`db/verify.sql:30-32` 用 `pg_class.relkind='r'` 数基表 —— 0001 建 39 张、0003 建 3 张、
> 0004 建 1 张、0010 建 1 张（迁移台账 `schema_migration`），合计 **44**。另有 3 个视图
> （`0003_review_queue.sql:538/567/617`）；`information_schema.tables` 会把视图也算进去 → 47，**两个数不要混用**。

**没有的东西**（不要去找）：没有自研 API 服务、没有自研 Worker、没有自研队列。
历史教训：那套 5.2 万行里 40% 该复用却自研，已废弃。

---

## 2. 阶段口径（唯一权威 = `recruitment.stage_catalog`）

v1.0 只做 6 个阶段：

| code | 阶段 | v1.0 |
|---|---|---|
| S3 | Job / JD / Rubric 设计 | ✅ 做 |
| S6 | 简历接入与处理（Intake） | ✅ 做 |
| S7 | 初筛 / Screening | ✅ 做 |
| S8 | 面试规划与排期 | ✅ 做 |
| S9 | 面试执行与材料获取 | ✅ 做 |
| S10 | 综合评价与招聘决策 | ✅ 做 |
| S1/S2/S4/S5/S11/S12 | 需求发现 / Requisition / Posting / Sourcing / Offer / 复盘 | ❌ 不做 |

**两套编号的坑**：老仓 `work/handoff/15-architecture-hv.md` 用的是另一套
（S7 身份解析 / S8 筛选 / S11 评价与决策），**那不是阶段码**。
权威口径见 `contracts/STAGE-CODES.md` 与 `db/STAGE-CATALOG.md`。

---

## 3. Golden Path 的 8 步

| # | 步 | 谁做 | 工具 | 写哪些表 | 证据 |
|---|---|---|---|---|---|
| 1 | 读简历 | agent | `recruitment_resume_read` | 不写 | 转换结果 JSON + `sha256` + `completeness` + `order_verified` |
| 2 | 结构化（防幻觉） | agent | `recruitment_resume_serialize` → 模型 → `recruitment_structure_validate` | 不写 | 每个值都能在引用块里逐字找到 |
| 3 | 接入（S6） | agent | `recruitment_application_intake` | `candidate` / `application` | 新库行 id + 身份匹配依据（phone/email 精确匹配，姓名不参与） |
| 4 | 初筛（S7） | agent 给建议，**人决定** | `recruitment_screening_evaluate` → `recruitment_decision_record(decision_scope='SCREENING')` | `decision`（`decision_scope='SCREENING'`、`stage_code='S7'`；**没有** `screening_result` 表） | rubric 版本 + 每条准则的 block 证据 + `SCREENING_EVALUATION.evaluation_digest` + `decided_by_actor_id`；`basis_refs` 按 `contracts/job-screening/tool-contracts.md §3.7` 组装（**必带 `AUTHORITY` + `RUBRIC_VERSION`**，否则 `BASIS_REF_EMPTY`） |
| 5 | 排期（S8） | 人 | `recruitment_interview_schedule` | `interview` / `meeting` / `meeting_binding` | 会议 ID + 面试官 + 轮次 |
| 6 | 面试与转写（S9） | 人（飞书 MANUAL 或手工粘贴） | `recruitment_transcript_import` → `recruitment_transcript_read` | `transcript_artifact` / `interview_record` | 原文 revision + canonical 标记 |
| 7 | 面评（S10 上半） | **面试官本人** | `recruitment_scorecard_submit` | `scorecard` | `interviewer_id` + `rubric_version_id` + 四态 assessment |
| 8 | 汇总与决策（S10 下半） | 招聘负责人 | `recruitment_evaluation_summarize` → `recruitment_decision_record(decision_scope='STAGE'/'FINAL')` | `decision` | `basis_refs` 九种 kind + 人工确认四要素 |

**不可绕过的人类闸门**：第 4、5、7、8 步的写入必须带人类 actor；
agent 不得代填面评、不得代做决策（`execution_mandate` 的 CHECK 已禁止 `submit_scorecard` / `decide`）。
闸门形态见 §6：第 5、7 步走 `ctx.approval` + 120s 超时（D-79/D-101）；第 4、8 步按 D-95 走
`IN_CHAT` + 人的原话（只问一次，不再二次点击）。

---

## 4. 当前状态（2026-11-14 更新；会变，用前重新探测）

| 环节 | 状态 | 证据 / 缺口 |
|---|---|---|
| DB 44 张基表（+3 视图）+ 0001–0010 迁移 | ✅ 成立（静态核对；本轮未复跑 CI） | 迁移链 `db/migrations/0001–0010`；`db/verify.sql` §1 计数口径；CI `db` job 覆盖全链 + `verify-0003…verify-0010` + 迁移台账比对（`.github/workflows/ci.yml:163-211`） |
| 转换器（S6 读） | ✅ 成立 | `converter/reports/acceptance.md`：13/13，553/553 页身份一致 |
| 独立校验器 | ✅ 成立 | `converter/verify/`，V1–V8，24 条测试 |
| 模型兜底 | ⛔ **converter 内车道不接线（设计改道）** | D-81 + D-107：模型调用不进插件；视觉补读由 agent 侧承担 —— `recruitment_page_image` → `read_image` → `recruitment_model_text_merge`（两个工具已注册，`src/index.ts:355-360`）；`converter/fallback/model_reader.py` 仍不接 provider |
| 人工复核队列 | ✅ 成立 | `converter/review/`，51 条测试；CI `python-lanes` job 绿 |
| 插件 19 个工具从 `apply()` 注册 | ✅ 成立 | `src/index.ts:414-433`（17 个具名 + `...structureTools` 2 个 = 19）；`evidence/experiments/2026-11-14-document-read-u3/README.md`：「配置齐 / 未配置两条路径都是 19」 |
| **插件 19 个工具注册 + Web 入口可达** | ✅ **成立** | 浏览器实测 `recruitment_job_get` 返回值与 DB 一致、硬刷新后会话保持 —— `evidence/experiments/2026-11-13-web-browser-acceptance/`；2026-11-14 工作台面板三层同时刻对齐 —— `evidence/experiments/2026-11-14-workbench-panel/` |
| S3 岗位 / Rubric 工具 | ✅ 交付；**rubric 批准无产品入口** | `src/tools/job-create.ts`（rubric 落 PENDING，人类批准）；批准目前只经 `manual/job-line/approve-rubric.mjs`，19 个工具里没有 approve（docs/23 N7） |
| S6 接入工具 | ✅ 交付 | `src/tools/application-intake.ts` |
| S7 初筛工具 | ✅ 交付；**决策写侧已补齐** | `src/tools/screening-evaluate.ts`（只读）；人决定落 `decision(decision_scope='SCREENING', stage_code='S7')` —— D-103 / `decision-rules.md §17.1` |
| S8 面试工具 | ⛔ **部分交付：仅 `intent=CREATE`** | `src/tools/interview-{schedule,get}.ts`；`intent` enum 只有 `CREATE`（D-62 四 intent 未实现）。闸门已加：`ctx.approval`（D-79）+ 120s 超时（D-101，`APPROVAL_TIMEOUT_MS=120_000`） |
| S9 转写工具 | ✅ 交付；飞书 **LIVE Gate ⛔ BLOCKED**（连接已可达） | `src/tools/transcript-{import,read}.ts`；连接器已接进 `transcript_import`（`fe70a16`，调用点 `src/tools/transcript-import.ts:717`），E4 由 BLOCKED 转可达；但无真实凭据/回读 → `provenance` 只可能 `FIXTURE`、`connection` 只可能 `NOT_CONNECTED`/`AUTH_REQUIRED`，`FEISHU_MINUTES_LIVE_GATE` 仍是 `'BLOCKED'`（`src/connectors/feishu/README.md:3-8`、commit `fe70a16`） |
| S10 评价/决策工具 | ✅ 交付；**决策可落库** | `src/tools/{scorecard-submit,evaluation-summarize,decision-record}.ts`；`decision_record` 接受 `decision_scope ∈ {SCREENING, STAGE, FINAL}`（D-103），STAGE/FINAL 走 S10；D-95 后决策不再点第二次 approval（`IN_CHAT` + 原话），面评/排期仍走 `ctx.approval`（D-79）+ 120s 超时（D-101） |
| 产品 profile（DSH Web） | ✅ 能起服务 + 能在里面调招聘工具 | `dsh --profile recruitment --no-open --port 49301`；浏览器实测见上 |

**结论（2026-11-14 更新）**：**接线层已通**（19 个工具注册、Web 会话真调到、刷新保持），
决策写侧也已补齐：S10 的 `STAGE/FINAL` 走 `decision_record`，S7 的 `SCREENING` 同工具写侧由 D-103 落地；
人只决策一次（D-95 `IN_CHAT` + 原话），不再需要"Web 里再点一次 approval"。
但 Golden Path **仍未端到端跑通过一次**（最近一次独立验收结论：D-102「半通，四个关键不变量是假的」；
S6→S10 端到端仍 BLOCKED，见 `docs/23` N4）。剩下三道硬门槛：
① S6→S7 用 **≥20 份真实简历**跑通并给出 ≥5 份可解释结论（`docs/23` N5）；
② 一条申请真正从 S6 走到 S10，且阶段码有受控推进入口（当前没有工具写 `application.current_stage_code`，`docs/23` N8）；
③ S8 四 intent（D-62）与 S3 rubric 批准入口（`docs/23` N7）。


---

## 5. 怎么跑（每一步都要留证据）

### 5.1 建库
```powershell
$psql='D:\12412\PostgreSQL\bin\psql.exe'; $env:PGPASSWORD='123456'
& $psql -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS ra_goldenpath"
& $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE ra_goldenpath"
cd D:\12412\dsh工作区\projects\recruitment-agent\db
foreach ($f in '0001_init','0002_seed','0003_review_queue','0004_stage_catalog','0005_version_binding','0006_integrity_gaps','0007_decision_integrity','0008_decision_uniqueness','0009_application_identity','0010_migration_ledger') {
  & $psql -U postgres -h 127.0.0.1 -d ra_goldenpath -v ON_ERROR_STOP=1 -q -f "migrations\$f.sql"
}
# 每个迁移自带自检 + 总自检（与 CI 的 db job 同一份清单，见 .github/workflows/ci.yml:171-177）
foreach ($v in 'verify-0003','verify-0004','verify-0005','verify-0006','verify-0007','verify-0008','verify-0009','verify-0010','verify') {
  & $psql -U postgres -h 127.0.0.1 -d ra_goldenpath -v ON_ERROR_STOP=1 -q -f "$v.sql"
}
```

> `0010` 起迁移自带台账（`recruitment.schema_migration`）：新建库必须按 `0001→0010` 全链重放，
> 否则 `verify-0010` 会报 `LEDGER_INCOMPLETE`；不要只跑前 6 条。

### 5.2 起产品 profile
```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'   # 密码只走环境变量，不写进任何文件（R7）
dsh --profile recruitment
```
⚠️ **不要与现有 Web GUI 抢同一个端口**。现有 GUI 在 `http://127.0.0.1:61475`（profile `desktop`）。

### 5.3 每步取证的最小要求（E1–E4）
- **E1** 命令原文 + 真实输出（不是"已实现"）
- **E2** DB 读回（`select` 出刚写的行，敏感字段打码）
- **E3** `passed / failed / skipped` 三个数；`skipped > 0` 不算绿
- **E4** 只存在于包内、只被单测调用 = **BLOCKED**，不是"完成"

---

## 6. 人类闸门怎么落地（2026-11-13 查实；2026-11-14 经 D-95 / D-101 修订）

**问题**：工具是 agent 调的，`execute(args, exec)` 里的 `exec` 只有
`callId` / `agent?` / `signal` / 传输 token（`dsh-tools/lib/types/index.d.ts` 的 `ToolExecutionInput`），
**没有任何"这次是人还是 agent 在按"的信息**。所以"不可代填面评"如果靠工具自己判断，
只能在工具层硬编码 —— 那等于没有保证。

**答案：复用 DSH 自带的审批 seam，不要自研。**

| 事实 | 证据 |
|---|---|
| `@deepseek-ai/dsh-user-approval` 提供 `ctx.approval`（一次性审批，fail-closed） | 包 README.zh.md §请求决定 |
| 两个 profile 都组合了它 | `dsh --profile recruitment --dump-config` → `- id: approval / name: '@deepseek-ai/dsh-user-approval'`；Web profile 另有 `- id: ui-approval`（人类 UI） |
| headless profile 只有 seam、没有 UI → 请求解析为 `unavailable` → **拒绝** | 同上（`approval: ask` + 无应答者） |

**因此（分两类，别混）**：

1. **人类动作 = 面评 / 排期（第 5、7 步）**：`interview_schedule` / `scorecard_submit` 必须
   `inject: ['tools', 'approval']`，在写库**之前**调 `ctx.approval.request({ agent, tool, callId, reason, signal })`：
   - `allow` → 才写库，`decided_by_actor_id` 取配置里的本地 actor，**绝不取模型入参**
   - `deny` / `unavailable` / `cancelled` / **超时** → 立即 `FORBIDDEN(APPROVAL_UNAVAILABLE | APPROVAL_NOT_GRANTED)`，不写任何行
   - **120s 超时**（D-101）：等待超过 `APPROVAL_TIMEOUT_MS=120_000` 按 `cancelled` 判，一行不写；
     晚到的 `allow` 不采纳（`interview-schedule.ts` / `scorecard-submit.ts`）

2. **决策（第 4、8 步）= 人只做一次**（D-95）：`decision_record` **不再**用 `approval` 做二次确认。
   `confirmation_method='IN_CHAT'` + `confirmation_text`（人的原话，逐字）+ `confirmed_by_actor_id`/`confirmed_at`
   一起进 `confirmation_text_sha256` 的 v2 pre-image；只有旧方式 `IN_APP_CONFIRM` / `SIGNED_RECORD`
   才仍走 approval 通道（`decision-record.ts:3027-3043`）。落库后可用"原话 + 哈希 + 会话日志"对账。

这样"人类闸门不可绕过"是**结构性**的：无人值守的 headless 跑批不可能自己"决定"；面评/排期还叠加 fail-closed 的审批。

**仍然没做到**：
- approval 路径的"审批人 → `actor_id`"映射还没实现（v1.0 单用户，取配置里的本地 actor）；多用户/多租户时要接真实身份源。
- `IN_CHAT` 无法证明"人真的说过这句话"——缓解是**可审计**（原话 + 哈希 + 会话日志），不是可阻止（D-95 已写明残余风险）。

---

## 7. 现在最可能卡住的地方

1. ~~**`decision.stage_code` 没有外键**~~ —— **已由 `0007` 修复**：`fk_decision_stage_catalog`
   `(tenant_id, stage_code) → stage_catalog(tenant_id, code)`（`0007_decision_integrity.sql:269-273`）。
   现在真正的缺口是**阶段推进没有工具入口**：`application.current_stage_code` 只在 intake 新建申请时写
   （`src/tools/application-intake.ts:1567/1597` 的 INSERT），S6→S7→S8→S9→S10 没有受控推进命令（`docs/23` N8）。
2. **新租户必须自己种 `stage_catalog`**：0006 给 `interview.stage_code` 加了外键之后，
   新建租户若不种 12 行目录，插面试会直接 23503。
3. **模型额度 / 结构化第 2 步**：Golden Path 第 2 步（结构化）仍要真实模型；`converter/fallback` 的
   `model_reader` 不接 provider（D-81：模型调用不进插件），视觉补读走 agent 侧（D-107）。
4. **审批在事务内等待（记债）**：面评/排期的 approval 在业务校验后、写库前，最长 120s 持有事务；
   `db/pool.ts` 用 `idle_in_transaction_session_timeout=300s` 兜底；两阶段重构按 D-101 的触发条件再做。
