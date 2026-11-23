# 44 · 当前状态、架构与仓库交接（2026-11-24 刷新）

> **本文件回答三件事**：现在代码在哪、系统由什么组成、接手的人第一步做什么。
> **权威顺序不变**：产品与验收口径 = `docs/24`；裁决 = `docs/17`；本文件只是**当前事实快照**。快照会过期，引用前必须现场重跑命令。
> **基线**：`main@ac93d6c`（含 PR #93、#95；PR #94 OPEN）。当前工作树首次阅读时先执行 `git rev-parse --short HEAD` 与 `git status --porcelain`。

---

## 1. 一句话现状

- 产品主链、Wave 3/5 能力、G-18 配置、生产登录、CSV/Webhook、部署 kit 已合入 main。
- **Issue #91 的两条 P1**（SettingsView TS2300、角色软停用 400）已由 PR #93 修复并合入；**但 Issue #91 尚未重新验收/关闭**。
- **Issue #92 的 Eval V2 审计裁决为 REJECT**：真实接线度、空 payload 判分器、L3 缺失、G3 吞错是核心问题。PR #93 已修 G3 吞错与 RESCHEDULED 漏计；PR #95 已合入 3 个真实生产适配器（converter `DocumentContent`、agent-turn SSE、PG 行数影子）；**判分器/runner 的根修仍在 PR #94（OPEN，未合并）**。适配器合入不等于审计翻案，必须再独立复验。
- 因此当前不能宣称“Eval V2 已验收”，也不能把 #91 的旧截图当作通过证据。

---

## 2. 接手阅读顺序

| 顺序 | 文件 | 读什么 |
|---|---|---|
| 1 | `AGENTS.md` | 总控职责、九条铁律、派发/验收/端口/密钥纪律 |
| 2 | `docs/24-product-framework-v2.md` | 产品认知、六条门 V1–V6；**第一权威** |
| 3 | `docs/17-decision-ledger.md` | 裁决；最新 D-191 是本轮状态刷新 |
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
| Eval V2 | `test/eval/**` | 规格见 docs/42；当前审计不通过 |

### 3.4 Eval V2 的当前现实

- 规格：43 例 corpus，L1/L2/L3 分层，G0/G1/G2/G3 分档，线上 G3 遥测。
- 审计事实（Issue #92，基于 `ac4a695`）：
  - 59 个 L1/L2 判分器中 **57/59 在空 payload 上直接 PASS**；
  - 端到端真实生产接线 **0/59**；G0 只执行 11/43 例且大量使用静态 stub；
  - 7 个 L3 判分器只有声明、无实现；32/43 例无 runner；
  - 红队 27 检查 **17 项可绕过**。
- PR #93 已修 G3 的吞错与 RESCHEDULED 漏计；PR #95 已补 3 个真实生产适配器（converter/agent-turn/PG shadow）；**判分器/runner 的根修仍在 PR #94（OPEN）**，合入前不要宣称 Eval V2 完成。

---

## 4. 仓库与分支现状

### 4.1 Git

- 当前 main：`ac93d6c`（PR #93 + #95 已合入）。
- 远端：`https://github.com/Bruce-Yii/recruitment-agent.git`；`gh` 已认证。
- 最近合并：#93 修复 `SettingsView` 重复 `record_version`、`config-role.is_active`、G3 吞错、RESCHEDULED 计数、minute-rebind 5432 硬编码；#95 新增 `test/eval/v2-real-adapters.ts`（converter DocumentContent / agent-turn SSE / PG 影子行数）及正反例单测。
- **#91 和 #92 仍 OPEN**；#94 仍 OPEN，不能当作已交付。
- **工作树很多**：main 之外有大量历史 wave/lane worktree（约 20+），多数停在旧 SHA；不要复用旧 worktree 做新验收，也不要未经授权删除。
- 生成物：`dsh/dsh-recruitment/lib/app.js`、`lib/client.js` 可能落后于 source；**做 UI 前必须 `tsdown` 重建并确认 bundle 里有目标 testid**。
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
- 证据分支不合并 main；新的验收应新建日期分支。

---

## 5. 当前未决缺陷与优先级

### P0 · 必须先修并独立复验

1. **Eval V2 真实接线**：空 payload 判分器、0/59 真实接线、L3 缺失、32/43 无 runner —— PR #94 处理中；PR #95 已补 3 个生产适配器但尚未完成全量接线/复验。合入 #94 后必须重新跑独立审计。
2. **G3 遥测**：PR #93 已改为 `degraded/ERROR`，但需要真库 SQL 复算复核（正常/列漂移/非法租户三态）。
3. **体系不能自证**：不要再以“59 个判分器/测试全绿”作为完成口径。

### P1 · 修复后复验

1. Issue #91 的 P1 已在 #93 修复：`tsc` 重复字段、角色软停用参数；**尚未重跑 #91 验收**。
2. 认证与租户：production gate 覆盖范围、cookie `Secure`/轮换、演示账号替换、跨租户边界。
3. Webhook/CSV：SSRF 允许列表、secret 生命周期、HMAC 派生文档、PII/注入负例。
4. 测试基础设施：避免端口/库硬编码；全量结果必须记录环境，不得把环境失败当产品失败或反之。
5. UI/构建：stale `lib/app.js`、设置页与队列叠影、G-18 创建/软停用端到端回归。

### P2 · 迭代优化

- `docs/25` 状态段、`docs/40` 基线、`docs/41` 迁移数继续回抄；
- 清理历史 worktree/分支（需授权）；
- 统一 evidence 命名与 `work/INDEX.md`；
- 部署 kit 的 Nginx/cookie/备份演练；
- G3 guardrail 的 L3 抽样源接入（目前部分 `guardrailRate=null` 是诚实空源，不是完成）。

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
| `RECRUITMENT_FEISHU_CLI` | 飞书 CLI | 本机有，LIVE 凭据仍缺 |
| `RECRUITMENT_FEISHU_USER_MAP` | 日历/妙记身份映射 | **当前缺，真实日历 LIVE 未证** |
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

1. 读 `AGENTS.md`、`docs/24`、`docs/17`（D-191）、本文件；
2. 现场确认 `tsc` 是否绿（#93 后应为 0，但不要凭记忆）；
3. 新建干净库、跑 `db/verify.sql`、跑全量四数；
4. 跑一次 15 步 preview（独立端口）；
5. 对比 `docs/25`/`docs/40` 的旧快照，先更新文档再派新功能；
6. 对 #94 合入后的 Eval V2 另派**未参与实现**的审计，不要由实现者自证。

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

---

## 10. 文档地图

- 产品/验收：`docs/24`、`docs/26`
- 裁决：`docs/17`（最新 D-191）
- 交接：`docs/25`（历史叙事）+ 本文件（当前快照）
- 路线：`docs/40`、`docs/39`
- 架构/评测：`docs/41`（架构设计）、`docs/42`（评测规格）
- 登录/部署：`docs/43`
- 页面规范：`design/v4/*.md`、`TESTID-MANIFEST.md`
- 机检/真机：`scripts/*`、`work/d5/fullpage/*`、`work/d5/e2e-live/scripts/*`
- 证据：`evidence/<topic-date>/`
