# 44 · 当前状态、架构与仓库交接（2026-11-24 刷新）

> **本文件回答三件事**：现在代码在哪、系统由什么组成、接手的人第一步做什么。
> **权威顺序不变**：产品与验收口径 = `docs/24`；裁决 = `docs/17`；本文件只是**当前事实快照**。快照会过期，引用前必须现场重跑命令。
> **基线**：`main@acaccfbb`（#96–#107 与 D-197/D-198 均已合入；历史代码基线 `54b83ad`）。当前工作树首次阅读时先执行 `git rev-parse --short HEAD` 与 `git status --porcelain`。
> **2026-11-24 协作者批次收口（D-199/D-200）**：Eval V2 的 P2–P6 真源、CLI、L3 runner/funnel、CI G0 门与安全/测试加固等 PR #96/#97/#99–#101/#103–#107 已合入；**但评测体系覆盖未到位（P0=4，见 `docs/45`）**：CI 仅 contract G0、L3 无法真跑、无 live 模型回路、Tier1/2 未进 CI。不可宣称“评测体系完成”。
> **2026-11-24 收口（D-196）**：#92 三个 P1 修复 + 独立终验 PASS（P0=0 / P1=0 / P2=2 已声明不阻断）已合入 `main` 并 push；**#91/#92 已关闭**；G3 维持口径 B（3 对真护栏，本期不新增盲审抽检工作流）。
> **2026-11-24 飞书 LIVE（D-198）**：G-04 日历忙闲与 G-13 妙记回读均在本机真实账号下实测 `LIVE/CONNECTED`；证据 `evidence/feishu-live-20261124/`；边界：G-13 真实改绑未做、产品自有 OAuth/事件订阅仍是 P1。

---

## 1. 一句话现状

- 产品主链、Wave 3/5 能力、G-18 配置、生产登录、CSV/Webhook、部署 kit 已合入 main。
- **Issue #91 复验 PASS，已关闭**：PR #93 修复项已在 `54b83ad` 上独立重跑；`tsc=0`、全量 3097/3095/0/2、15 步 15/15 hard 0、角色软停用 `is_active=false` + version+1、G3/auth CLI 均通过。
- **Issue #92 三个 P1 已修复、独立终验 PASS、已合入 main 并关闭**（D-195/D-196）：红队语义不变量（14 + 原 17 全拦、空 payload 0/66、合法对照 0 过拦）、适配器接 43 例 CLI（`real_adapter` 3 真源 + 40 `NO_REAL_SOURCE`、capture 完整性与来源 fail-closed、真 PG）、G3 忠实度接真实确定性源并移除盲审假护栏（3 对）；独立终验 P0=0 / P1=0 / P2=2（已声明不阻断：委婉祈使/多义"继续"）。合并提交 `b0ebecf`，Issue #92 已关闭。
- 当前可声称：#91 无阻断通过复验并已关闭；#92 三 P1 修复经未参与实现者独立终验 PASS、已合并 main 并关闭；**G-04/G-13 回读已在本机真实账号下实测 LIVE/CONNECTED（D-198）**。不可声称：G3 第 4 对盲审护栏已接入（按口径 B 本期不做）；Eval V2 语义完备（仍有 2 条已声明 P2）；G-13 真实改绑已完成；**Eval V2 评测体系覆盖到位（D-200：P0=4，见 `docs/45`）**。

---

## 2. 接手阅读顺序

| 顺序 | 文件 | 读什么 |
|---|---|---|
| 1 | `AGENTS.md` | 总控职责、九条铁律、派发/验收/端口/密钥纪律 |
| 2 | `docs/24-product-framework-v2.md` | 产品认知、六条门 V1–V6；**第一权威** |
| 3 | `docs/17-decision-ledger.md` | 裁决；最新 D-200（Eval 缺口审计）、D-199（批次收口）、D-198（飞书 LIVE） |
| 4 | 本文件 `docs/44` | 当前基线、架构、仓库、未决缺陷 |
| 5 | `docs/25-lead-handoff.md` | 七步场景、判断框架、历史踩坑；其“当前状态”段已过期 |
| 6 | `docs/40-lifecycle-gap-roadmap.md` | Wave 3/4/5 路线与缺口 |
| 7 | `docs/42-product-funnel-eval-system.md` | Eval V2 **规格**；不是实现通过证明 |
| 8 | `docs/43-production-login.md` | production/preview、账号、会话、部署 |
| 9 | `design/v4/*.md`、`TESTID-MANIFEST.md` | 页面规范、入口与 testid |
| 10 | Issues #91/#92、PR #93/#94/#95 | 最近的真实验收与修复 |

> `docs/25` 的 2026-11-17 状态段、`docs/40` 的旧基线、`docs/41` 的 24 迁移描述均为历史快照；以本文件和现场命令为准。

---

## 3. 架构快照

### 3.1 底座与入口

```
DSH Web Host
  └─ @recruitment/dsh-recruitment plugin
      ├─ /recruitment/app           v4 独立工作台（对话 × 画布）
      ├─ /recruitment/login         production 独立登录页
      ├─ /recruitment/book/<token>  候选人免登录自助预约页
      ├─ /recruitment/api/**        只读查询 / 受控写动作 / 设置 / 认证
      └─ /recruitment/test          preview 演示身份入口（production 物理 404）

PostgreSQL 17 · recruitment schema · 0001→0025 migrations
```

- 底座禁止替换：不自研 Agent Runtime / 队列 / UI 框架 / 解析器。
- 默认 `RECRUITMENT_AUTH_MODE=preview`，保留 `/recruitment/test` 和 `RECRUITMENT_PREVIEW_ALIAS`；production 才关闭演示入口。
- 生产会话落 `recruitment.auth_session`，token 只存 sha256；`auth_user` 只存 scrypt 哈希；建号用 `scripts/auth-admin.mjs`。

### 3.2 六层代码职责

| 层 | 主要位置 | 职责 |
|---|---|---|
| 入口/展示 | `src/app/`、`src/client/canvas/`、`src/http/app-shell.ts` | 工作台、设置四 Tab、候选人/岗位画布、公开预约页 |
| 对话 × 画布 | `src/http/agent-turn.ts`、`src/tools/ui-dispatch.ts` | SSE、`ui_action`、行内 `propose_write` 确认；对话侧只读 |
| Skill 与工具 | `skill/recruitment-s6..s10/`、`src/tools/` | 分阶段工作说明书、受控工具、角色/租户边界 |
| 领域规则 | `src/domain/` | 阶段流转、预约白名单、去重、配置版本、追责时间线、G3 遥测等硬规则 |
| 数据真相 | `db/migrations/0001→0025`、`src/db/` | 五事实模型、append-only 配置、审计、乐观锁、防删触发器 |
| 外部连接 | `src/connectors/mail/`、`src/connectors/feishu/`、`converter/` | IMAP 拉取、飞书日历/妙记适配、PDF/DOCX 解析与逐页图片 |

### 3.3 关键能力与入口

| 能力 | 路由/入口 | 备注 |
|---|---|---|
| 工作台/队列 | `/recruitment/app#/queue` | v4 独立页 |
| 岗位与导出 | `/recruitment/app#/jobs`、`GET /recruitment/api/export/applications.csv` | CSV 带 BOM/脱敏/注入防护 |
| 设置 | `/recruitment/app#/settings` | 连接 / 自动化 / 组织 / 治理四 Tab |
| G3 遥测 | `GET /recruitment/api/settings` 的 `governance.g3_telemetry` | 4 对成对护栏；失败显式 `degraded=true` + `ERROR`，不再伪装 NO_DATA |
| G-18 组织配置 | `/action/config/role|pipeline|team` 等 | 已修 `is_active` 软停用路由 |
| 生产登录 | `/recruitment/login`、`/api/auth/login|logout` | production 模式 |
| 候选人自助预约 | `/recruitment/book/<token>` | 公开页零内部信息 |
| Webhook | `external_webhook_config`、`POST /action/webhook/test` | HMAC `sha256=<hmac>`；失败 fail-open 审计 |
| Eval V2 | `test/eval/**` | 规格见 `docs/42`；#100–#107 已合入 P2–P6 真源/CLI/CI 门，但覆盖缺口见 `docs/45`（D-200） |

### 3.4 Eval V2 的当前现实

- 规格：43 例 corpus，L1/L2/L3 分层，G0/G1/G2/G3 分档，线上 G3 遥测。
- 2026-11-24 #100–#107 合入后现状（`main@acaccfbb`；完整审计见 `docs/45` / D-200）：
  - 66 个判分器（37 L1 + 22 L2 + 7 L3）全部注册，`{payload:{}}` 空 payload **0/66 pass**；L3 未校准/缺裁判/位置互换 fail-closed；
  - 43 例 manifest（G0=11/G1=24/G2=8；Tier1=17/Tier2=16/Tier3=10）；CLI 有 contract/real、`--runs`、`--check-data`、`--l3`；
  - **真实适配器已接 CLI**：converter→P1、agent-turn SSE→P6、PG 行数→P6 counts、PG 阶段快照→P2–P5/P6-08/09；real 模式最大真实覆盖 9/43，fresh capture 通常仅约 3 例；
  - **覆盖缺口（P0）**：CI 的 G0 门是 contract 静态夹具 11 例 + `counterMetricsOk` 恒真 + `pass^k` 确定性 + 强制 `L3_MODEL_NOT_CONFIGURED`；L3 无可注入 invoker；V2 CLI 无 live 模型模式；Tier1/2 真实语料未进 CI；真实 S7–S10 漏斗未由采集器驱动（测试用手写 SQL fixture）；
  - 红队：14 个复验变体 + 原 17 变体全拦，合法对照 0 过拦；确定性判分器保留 2 条 P2（委婉祈使/多义"继续"，已声明不阻断）；
  - G3：3 对护栏；忠实度接真实确定性引用锚定；盲审假护栏移除（待授权新增工作流）。
- 旧审计事实（`ac4a695`，仅作历史）：57/59 空 payload PASS、端到端接线 0/59、G0 仅 11/43、7 L3 无实现、红队 17/27 绕过；均由 #93/#94/#95 + D-195 修复。

---

## 4. 仓库与分支现状

### 4.1 Git

- 当前 main：`acaccfbb`（#96–#107 与 D-197/D-198 均已合入；历史代码基线 `54b83ad`）。
- **2026-11-24 修复批次（已合并）**：`fix/issue92-p1a-redteam` / `fix/issue92-p1b-adapters` / `fix/issue92-p1c-g3`；集成分支 `fix/issue92-integration@f052502` 以 `--no-ff` 合入 `main`（合并提交 `b0ebecf`）并 push。lane 分支保留作历史；临时 worktree 已清理。
- 远端：`https://github.com/Bruce-Yii/recruitment-agent.git`；`gh` 已认证。
- 最近合并：#93 修复 `SettingsView` 重复 `record_version`、`config-role.is_active`、G3 吞错、RESCHEDULED 计数、minute-rebind 5432 硬编码；#95 新增 `test/eval/v2-real-adapters.ts`；#94 重写 `v2-graders-l1/l2`、新增 `v2-graders-l3.ts`、`v2-g0-runner`、`corpus-inventory`/`evaluation-card`/`v2-l3-calibration`。
- **#91/#92 已关闭**（#92 经未参与实现者独立终验 PASS）；PR #93–#101 已合入；#94 已在后续批次独立复验。
- **工作树很多**：main 之外有大量历史 wave/lane worktree（约 20+），多数停在旧 SHA；不要复用旧 worktree 做新验收，也不要未经授权删除。
- 生成物：`dsh/dsh-recruitment/lib/app.js`、`lib/client.js` 可能落后于 source；**做 UI 前必须 `tsdown` 重建并确认 bundle 里有目标 testid**。2026-11-24 UI 构建批次已从 `317e094` 重建（`lib/app.js` 1.54 MB / `lib/client.js` 0.59 kB；**无 app.css**——CSS 按文件注入），1440 真机验证见 `evidence/ui-settings-overlay-20261124/`（D-197）。
- CI：GitHub Actions 现在会跑 PR；`converter acceptance` 在无 corpus 时条件跳过。**CI 绿不是产品验收**，且不能替代本机干净库/真机验证。

### 4.2 数据库与端口

| 项 | 规则 |
|---|---|
| PostgreSQL 17 | `D:\12412\PostgreSQL\bin\psql.exe` |
| 验证库 | **每次新建**，重放 `0001→0025`，跑 `db/verify.sql` 末行 `VERIFY PASS`；用完 drop |
| 禁止 | `ra_s6s7` 是脏演示库，不作证据；共享库/旧 worktree 库不作验收 |
| Host 端口 | 49347–49352；**49351 = 人工预览 Host，禁止杀/占**；49303 = 旧静态工作台，非验收对象 |
| 并行 | 每条 lane 独立端口 + 独立库；15 步显式传 `--port` |
| 三件套 | `RECRUITMENT_PYTHON`、`RECRUITMENT_PYTHON_BIN`、`RECRUITMENT_CONVERTER_DIR` 缺一会假红 |

### 4.3 证据分支

- Issue #91：`origin/evidence/issue91-20261124`（`3d3f442`），含 1440 截图、15 步、全量结果与 psql 读回；其中 #91 旧 P1 失败是**修复前**证据。
- 历史 Wave 5：#72/#73 的产物已在 main；旧 `evidence/wave5-20261122` 只作历史。
- #92 修复批次（D-195/D-196）：实现与终验证据已归档到 `D:\12412\dsh工作区\archive\recruitment-agent\2026-11-24-issue92-fix\`（含终验 `REPORT.md`；机器本地、不入库）；仓库内裁决/状态见 `docs/17` D-195/D-196 与 `docs/44` §5.5。
- 证据分支不合并 main；新的验收应新建日期分支。

---

## 5. 当前未决缺陷与优先级

### P0 · 本轮复验确认已无 P0

首轮 P0 已由 #93/#94/#95 修复并在 `54b83ad` 独立复验；2026-11-24 三 P1 修复后独立终验 P0=0：
- 66 判分器空 payload `{payload:{}}` **0/66 pass**；66/66 manifest 注册；7 个 L3 未校准/缺裁判/位置互换 fail-closed；
- 43 例 ALL runner 已跑；G3 SQL 42703/42P01/非法 UUID → `degraded:true` + 4/4 `ERROR`，真库 CANCELLED+RESCHEDULED 8/8 一致；
- F5 非标 PDF 6/6、F6 L3 9/9；`minute-rebind` 隔离端口已修。

### P1 · 复验保留（1–3 已于 2026-11-24 修复，见 §5.5）

1. ~~红队词表新变体~~ → **已修（D-195）**：语义不变量 + 多轮类级硬化；14/14 + 原 17/17 全拦、合法对照 0 过拦；残留 2 条 P2（委婉祈使/多义"继续"，已声明不阻断）。
2. ~~适配器未接 CLI runner~~ → **已修（D-195）**：`run-eval-v2.mjs` 43 例 CLI + capture 完整性/来源校验 + 真 PG；`real_adapter` 3 真源 + 40 `NO_REAL_SOURCE` 不计 PASS。
3. ~~G3 假护栏~~ → **已修（D-195 口径 B）**：忠实度接真实确定性引用锚定；盲审假护栏移除（3 对）；新增抽检工作流待用户授权。
4. 认证与租户：production gate 覆盖范围、cookie `Secure`/轮换、演示账号替换、跨租户边界。
5. Webhook/CSV：SSRF 允许列表、secret 生命周期、HMAC 派生文档、PII/注入负例。
6. 测试基础设施：全量结果必须记录环境，不得把环境失败当产品失败或反之。
7. UI/构建：stale `lib/app.js`（**已重建**，2026-11-24 D-197）、设置页与队列叠影（PR #97 修复 + D-197 1440 真机验证消除；证据 `evidence/ui-settings-overlay-20261124/`）、G-18 创建/软停用端到端回归（仍待）。
8. **Eval V2 覆盖缺口（D-200，P0=4）**：CI 仅 contract G0、L3 无法真跑、无 live 模型回路、Tier1/2 未进 CI；详见 §5.7 与 `docs/45`。不可用“CI 绿/66 判分器/43 例 manifest”当评测体系完成。

### P2 · 迭代优化

- `docs/25` 状态段、`docs/40` 基线、`docs/41` 迁移数继续回抄；
- 清理历史 worktree/分支（需授权）；
- 统一 evidence 命名与 `work/INDEX.md`；
- 部署 kit 的 Nginx/cookie/备份演练；
- G3 guardrail 的 L3 抽样源接入（目前部分 `guardrailRate=null` 是诚实空源，不是完成）。

### 5.4 当前复验批次（2026-11-24，已完成）

> 任务书 `docs/17` D-193；结果 `docs/17` D-194。两条 lane 均未改 main、未合并。
> - **Lane A #92**：`CONDITIONAL_PASS`。隔离 PG17（49353）38/38 eval tests、全量 3097/3095/0/2；66/66 manifest、空 payload 0/66、L3 fail-closed、G3 ERROR + SQL 8/8；剩余 3 P1（红队新变体、适配器未接 CLI、G3 两护栏 null）。报告：https://github.com/Bruce-Yii/recruitment-agent/issues/92#issuecomment-7110894849
> - **Lane B #91**：`PASS`。干净 DB（49354）全量 3097/3095/0/2、15 步 15/15 hard 0、角色软停用 `is_active=false` + version 2、G3/auth CLI 全过。报告：https://github.com/Bruce-Yii/recruitment-agent/issues/91#issuecomment-7111092251
> - 两条 Issue 仍 OPEN；下一步先修 #92 三个 P1，再由未参与实现者做最终复核；不自行关闭/合并。

### 5.5 当前修复批次（2026-11-24，已完成、已合并、Issue 已关闭）

> 裁决 `docs/17` D-195；三条 lane 与独立终验均未改 main、未合并、未 push。
> - **P1-A**（`fix/issue92-p1a-redteam`）：语义不变量 + H2–H6 类级硬化；集成分支 eval 75 tests / 71 pass / 0 fail / 4 env-gated skip；空 payload 0/66；合法对照 0 过拦；P2 残留 2 条（`麻烦把系统设计这块再过一遍`、`看样子难以继续`）。
> - **P1-B**（`fix/issue92-p1b-adapters`）：`run-eval-v2.mjs` contract 43 例 EXIT 0；real `real_adapter` 3 真源 + 40 `NO_REAL_SOURCE`、`passRate=0.3333` 仅覆盖真实执行；篡改/缺 capture/缺 PG/来源不符 exit 2；真 PG 独立 psql 对照一致；口令/库名 P2 已关闭。
> - **P1-C**（`fix/issue92-p1c-g3`）：G3 3 对护栏；忠实度真实确定性源（真实库 0.6667 / 篡改 0.5，与独立 SQL 一致）；零引用 null + 诚实 note；degraded 3/3 ERROR；盲审待授权。
> - **独立终验**：`verify-92-final`（未参与实现）三轮 + 单点确认，最终 **PASS（P0=0 / P1=0 / P2=2 已声明不阻断）**；报告 `verify92-final/work/review92-final/REPORT.md`（机器本地）。
> - **状态**：已合入 `main`（合并提交 `b0ebecf`）并 push；#91/#92 已关闭；G3 维持口径 B。证据归档 `D:\12412\dsh工作区\archive\recruitment-agent\2026-11-24-issue92-fix\`；临时 worktree 已清理。

### 5.6 飞书 LIVE 实测（2026-11-24，D-198）

- **G-04 日历忙闲**：本机真实账号（独立 profile `recruitment` + `RECRUITMENT_FEISHU_USER_MAP`）→ 产品 free-slots HTTP 200、labels `LIVE/MANUAL/CONNECTED`、3 个 45min 候选时段；calendar reader 直读 11 月 `busy_count=1`（30min）、12 月 0；`+freebusy` `ok=true/data=null`（空忙闲/应用级授权差异，产品按 `+agenda` 取忙区间）。
- **G-13 妙记回读**：真实妙记回读 `READ/CONNECTED/LIVE`（`live_eligible=true`、回执绑定内容 sha256）；产品 `POST /recruitment/api/feishu/import` 落库 READY，`interview_record=NEEDS_REVIEW/UNVERIFIED`（人类闸门未被绕过）；**真实改绑（speaker-replace）未做**。
- 证据：`evidence/feishu-live-20261124/`（无 token、无会议原文，仅状态/脱敏哈希前缀/结构化回执）；边界：本机实测 ≠ 客户生产验收，产品自有 OAuth/事件订阅仍是 P1。

### 5.7 Eval V2 评测体系缺口独立审计（2026-11-24，D-200）

> 完整审计见 `docs/45-eval-system-gap-analysis-2026-11-24.md`；结论：**工程底座推进明显，但评测体系尚未覆盖到位**。

- **P0（4 项）**：① CI 的 Eval V2 G0 门是 contract 静态夹具 11 例、`counterMetricsOk` 恒真、`pass^k` 确定性、强制 `L3_MODEL_NOT_CONFIGURED`（等于把"L3 未跑"当通过）；② L3 全仓无可注入 `L3ModelInvoker`，CLI `--l3` 仅一条硬编码探针且恒 `L3_MODEL_NOT_CONFIGURED`；③ V2 CLI 只有 contract/real（real=读 capture），无 live 模型回路，real SSE capture 仅"请只回复收到"两帧；④ Tier1/2 真实语料未进 CI（`--check-data` 只写文件不 gate），real 最大 9/43、fresh capture 约 3 例。
- **P1（10 项）**：real 覆盖低、`pass^k` 语义错位、反向压制指标未采集、无基线 Diff、G1/G2 未进 CI、L3 prompt 未入库锁版、无真实校准集、红队只有确定性规则、P2–P5 "真实适配"仍是 DB 投影、采集器不驱动 S6–S10 真产品动作。
- **P2（7 项）**：L3 原文锚定过弱（简单 substring）、阈值硬编码、readiness 不 gate/无趋势、contract 下 tier 标签易误读、旧 V1 live runner 未迁移、G3 无周度快照、本批合入未做独立产品验收。
- **建议优先级（待拍）**：拆 contract smoke 与 quality gate 并修正 L3 断言 → 通 L3 invoker/prompt 版本/校准 → V2 加 live 模式与 pass^k/TTFT/token → Tier1/2 数据门 → 端到端采集（真动作→PG 快照）→ 基线/G1/G2/G3 飞轮。
- 本次为文档审计，未改代码、未跑 live/Tier1；不可据此关闭任何评测条目。

---

## 6. 工作方式与派发

### 总控

只做判定 / 派发 / 独立验收 / 集成 / 单一权威源；不实现、不自行合并 main、不擅自改范围。所有裁决写回 `docs/17`。

### 派发模板（每个 lane 七件事）

1. 目标与已确认事实；
2. 边界（禁止事项）；
3. 文件级写范围；
4. 验收标准；
5. 停止条件；
6. 回报格式；
7. 证据路径。

附加硬约束：

- 从最新 `origin/main` 开独立 worktree；
- 独立临时库 + 独立端口；
- lane 禁止 commit/push/checkout/stash/restore；
- 实现者与验收者分离；验收者必须用独立上下文、独立证据；
- 子代理显式 `provider: opencode-go-openai` + `model: hy4-flash-free`；
- 报告必须有 `file:line`、命令原文、真实输出、psql 读回、截图；只交测试四数退回。

### 验收命令

```powershell
# 静态
npx tsc --noEmit
npx tsdown
node scripts/server-typecheck.mjs
node scripts/runtime-budget.mjs
node scripts/client-contract-check.mjs
node scripts/term-lint.mjs
node scripts/entry-reachability.mjs   # WHITELIST=[]

# 全量（干净库）
node test/run-all.mjs --test-concurrency=1

# Eval V2 43 例 CLI（D-195）
cd dsh\dsh-recruitment
node test/eval/run-eval-v2.mjs --mode=contract --gate=ALL
# real 模式必须给 capture + 真 PG（口令 env 注入；capture sha256/来源不符 → exit 2）
# node test/eval/run-eval-v2.mjs --mode=real --gate=ALL --capture=<dir> --pg-db=<db>

# 15 步 preview（独立端口/临时环境；不要打 49351）
node work/d5/fullpage/run-v4.mjs --fresh --port <49347-49352>

# 真机
# 先用 tsdown 重建 lib；再用 start-host.ps1 + start-chrome.ps1 + probe 脚本
```

---

## 7. 环境、变量与密钥

| 名称 | 用途 | 纪律 |
|---|---|---|
| `RECRUITMENT_DB_PASSWORD` | 本地 PG 口令 | 命令注入；不写文件/仓库 |
| `RECRUITMENT_PYTHON` / `RECRUITMENT_PYTHON_BIN` | Python/converter | 三件套缺一假红 |
| `RECRUITMENT_CONVERTER_DIR` | converter 根目录 | 同上 |
| `RECRUITMENT_FEISHU_CLI` | 飞书 CLI | 本机绝对路径已确认；产品 profile `recruitment` 已登录并实测 LIVE（D-198） |
| `RECRUITMENT_FEISHU_USER_MAP` | 日历/妙记身份映射 | 临时 env 注入已实测（interviewer_a→真实 open_id，`LIVE/CONNECTED`，D-198）；生产部署仍须按环境配置 |
| `RECRUITMENT_AUTH_MODE` | `preview`（默认）/`production` | production 才关 `/recruitment/test` |
| `RECRUITMENT_PREVIEW_ALIAS` | 预览默认身份 | production 忽略 |
| `RECRUITMENT_CORPUS_ROOT` | 真实语料 | **缺 → acceptance corpus 条件跳过** |
| DSH 凭据 | 模型/第三方 key | 在 `D:\12412\dsh-home-recruitment\.credentials.yaml`，不打印、不复制、不入库 |
| Host token | 本机 Host 一次性访问 | `%TEMP%\ra-pr-host-<port>.token`，过期即弃 |
| 生产演示账号 | `docs/43` 测试夹具 | 真部署必须用 `auth-admin.mjs` 替换/轮换 |

> 证据文件中的 token 若已过期可按 R7 保留；**当前有效 secret 永远不得进入仓库/证据/聊天**。

---

## 8. 接手第一小时

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent
git fetch origin
git rev-parse --short HEAD
git status --porcelain
git log --oneline -8
gh issue view 91
gh issue view 92
gh pr view 93
gh pr view 94
```

然后：

1. 读 `AGENTS.md`、`docs/24`、`docs/17`（D-192）、本文件；
2. 现场确认 `tsc` 是否绿（#93 后应为 0，但不要凭记忆）；
3. 新建干净库、跑 `db/verify.sql`、跑全量四数；
4. 跑一次 15 步 preview（独立端口）；
5. 对比 `docs/25`/`docs/40` 的旧快照，先更新文档再派新功能；
6. 对 #94 合入后的 Eval V2 另派**未参与实现**的审计（重跑 #92），不要由实现者自证；#91 也需重跑 1440。

---

## 9. 不要再踩的坑

1. 不要直接改 main / 合并 / force-push / 删 worktree，除非用户明确授权。
2. 不要用 `ra_s6s7`、旧 worktree 库、旧 evidence 当验收证据。
3. 不要杀 49351 人工预览 Host；不要占 49303。
4. 不要把“CI 绿 / 59 个判分器 / 测试四数”当产品通过。
5. 不要跳过 `tsdown` 直接做 UI E2E；stale bundle 会让你看到旧页面。
6. 不要以空 payload PASS 判断分器已接线；检查 payload 来源与真实入口。
7. 不要用实现 lane 的截图替代独立验收；不要自审。
8. 不要把 `docs/25` 的 2026-11-17 状态、`docs/40` 的旧基线照抄进新裁决。
9. 不要把 `work/` 里的 lane 证据当长期证据（机器本地、不入库）；长期留档另建 evidence 分支。
10. 不要把确定性 L1 判分器当语义完备：2 条 P2（委婉祈使/多义"继续"）是明确口径，不得用"全部通过"表述，也不得用无限扩短语表冒充收口。
11. 不要在 main 工作区跑 `tsdown`/Host 后把生成的 `lib/app.js` 留在工作树（本次已还原）；UI E2E 前重建、做完还原。

---

## 10. 文档地图

- 产品/验收：`docs/24`、`docs/26`
- 裁决：`docs/17`（最新 D-200）
- 交接：`docs/25`（历史叙事）+ 本文件（当前快照）
- 路线：`docs/40`、`docs/39`
- 架构/评测：`docs/41`（架构设计）、`docs/42`（评测规格）
- 登录/部署：`docs/43`
- 页面规范：`design/v4/*.md`、`TESTID-MANIFEST.md`
- 机检/真机：`scripts/*`、`work/d5/fullpage/*`、`work/d5/e2e-live/scripts/*`
- 证据：`evidence/<topic-date>/`
