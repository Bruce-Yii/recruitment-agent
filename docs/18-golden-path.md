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
| 业务真相 | PostgreSQL 17，schema `recruitment`，40 张表 | `db/migrations/` |
| 文件→文本 | 本地转换器（PyMuPDF），四件套 | `converter/` |
| 读不出时 | 模型兜底（`fallback/`）+ 人工复核队列（`review/`） | 同上 |
| 契约 | 每个阶段的领域规则与工具形状 | `dsh/dsh-recruitment/contracts/` |

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
| 4 | 初筛（S7） | agent 给建议，**人决定** | `recruitment_screening_evaluate` → `recruitment_decision_record(scope='SCREENING')` | `screening_result` / `decision` | rubric 版本 + 每条准则的 block 证据 + `decided_by_actor_id` |
| 5 | 排期（S8） | 人 | `recruitment_interview_schedule` | `interview` / `meeting` / `meeting_binding` | 会议 ID + 面试官 + 轮次 |
| 6 | 面试与转写（S9） | 人（飞书 MANUAL 或手工粘贴） | `recruitment_transcript_read` | `transcript_artifact` / `interview_record` | 原文 revision + canonical 标记 |
| 7 | 面评（S10 上半） | **面试官本人** | `recruitment_scorecard_submit` | `scorecard` | `interviewer_id` + `rubric_version_id` + 四态 assessment |
| 8 | 汇总与决策（S10 下半） | 招聘负责人 | `recruitment_evaluation_summarize` → `recruitment_decision_record(scope='STAGE'/'FINAL')` | `decision` | `basis_refs` 九种 kind + 人工确认四要素 |

**不可绕过的人类闸门**：第 4、5、7、8 步的写入必须带人类 actor；
agent 不得代填面评、不得代做决策（`execution_mandate` 的 CHECK 已禁止 `submit_scorecard` / `decide`）。

---

## 4. 当前状态（2026-11-13，会变，用前重新探测）

| 环节 | 状态 | 证据 / 缺口 |
|---|---|---|
| DB 40 张表 + 0001–0006 迁移 | ✅ 成立 | 本机 + GitHub Actions `db` job 双绿（迁移链 + 5 个 verify + 幂等） |
| 转换器（S6 读） | ✅ 成立 | `converter/reports/acceptance.md`：13/13，553/553 页身份一致 |
| 独立校验器 | ✅ 成立 | `converter/verify/`，V1–V8，24 条测试 |
| 模型兜底 | ⛔ **BLOCKED** | 真实模型 0 次成功（额度）；且未接线 |
| 人工复核队列 | ✅ 成立 | `converter/review/`，51 条测试；CI `python-lanes` job 绿 |
| 插件 5 个工具从运行时可达 | ✅ 成立 | `dsh/dsh-recruitment/evidence/r2-tool-reachability-2026-11-13.md` |
| S6 接入工具 | 🚧 在建 | 见 `work/`（lane 交付后回填） |
| S7 初筛工具 | 🚧 在建 | 契约已定稿于 `contracts/job-screening/` |
| S8/S9/S10 工具 | ❌ 未开始 | 只有契约，零实现 |
| 产品 profile（DSH Web） | 🟡 可组合，未启动 | `dsh --profile recruitment --dump-config` 通过；**没有起服务**（会与现有 GUI 抢端口） |

**结论**：Golden Path **还没有跑通过一次**。上面任何一个 ❌/🚧 都足以让链路断开。

---

## 5. 怎么跑（每一步都要留证据）

### 5.1 建库
```powershell
$psql='D:\12412\PostgreSQL\bin\psql.exe'; $env:PGPASSWORD='123456'
& $psql -U postgres -h 127.0.0.1 -c "DROP DATABASE IF EXISTS ra_goldenpath"
& $psql -U postgres -h 127.0.0.1 -c "CREATE DATABASE ra_goldenpath"
cd D:\12412\dsh工作区\projects\recruitment-agent\db
foreach ($f in '0001_init','0002_seed','0003_review_queue','0004_stage_catalog','0005_version_binding','0006_integrity_gaps') {
  & $psql -U postgres -h 127.0.0.1 -d ra_goldenpath -v ON_ERROR_STOP=1 -q -f "migrations\$f.sql"
}
& $psql -U postgres -h 127.0.0.1 -d ra_goldenpath -v ON_ERROR_STOP=1 -q -f verify.sql
```

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

## 6. 现在最可能卡住的地方

1. **人类 actor 从哪来**：DSH 的 tool `execute(args, exec)` 里有没有"这是人类还是 agent"的信息，
   还没验证过。如果拿不到，第 4/7/8 步的"不可代填"就只能在工具层硬编码，
   而不是结构性保证 —— 那等于没有保证。
2. **`decision.stage_code` 没有外键**（实测 `fk_count=0`）：写错阶段码数据库不报错，待 0007。
3. **新租户必须自己种 `stage_catalog`**：0006 给 `interview.stage_code` 加了外键之后，
   新建租户若不种 12 行目录，插面试会直接 23503。
4. **模型额度**：`fallback` 车道仍然 0 次真实读取；Golden Path 第 2 步（结构化）也要真实模型。
