# Issue #91 — Lane B 1440 真机联调验收证据

- 工作树：`D:\12412\DshWorktrees\recruitment-agent\e2e-91`（分支 `evidence/issue91-20261124`，`main ac4a695`）
- 执行时间：2026-11-23T17:25–17:45Z（Asia/Singapore 2026-11-24 01:25–01:45）
- 端口：Host `49354`，CDP `9233`（隔离 CDP，未触碰 49347/49351 或共享 chrome 9222）
- 一次性库：`ra_full_clean_jm8_5ngiid`（全量测试）、`ra_fresh_e2e_m8k_5o0y62`（15 步）、`ra_fresh_e2e_bp4_7067gp`（1440 UI + auth CLI）；全部已 drop，未碰 `ra_s6s7`
- 约束：未改产品源码/测试/文档/main，未 commit/push；最终 `git status` 仅 `?? evidence/issue91-20261124/`

## 四个数字

| 指标 | 结果 |
|---|---|
| 静态门禁 | 7 项中 **6 PASS / 1 FAIL**（`tsc --noEmit` FAIL：TS2300） |
| 全量测试 | **3091 tests / 3089 pass / 0 fail / 2 skipped**（exit 0，clean DB，串行） |
| 15 步回归 | **15/15 PASS**（FAIL 0 / BLOCKED 0）；独立审计 **hard 0**（soft 3） |
| 1440 真机 | G3 4 对护栏 PASS（0 NaN / 0 UUID / 0 禁用词）；角色创建 PASS、**角色软停用 FAIL（P1）**；流程创建+软停用 PASS；团队创建 PASS；auth CLI + 生产登录 PASS |

## 1. 静态门禁（`gates/`）

| 门禁 | 结果 | 证据 |
|---|---|---|
| `npx tsc --noEmit` | **FAIL exit 2** | `src/app/SettingsView.tsx(89,14)`、`src/app/SettingsView.tsx(91,14)`：`TS2300 Duplicate identifier 'record_version'`（`OrgConfigPayload.roles` 接口重复声明） |
| `npx tsdown`（双入口） | PASS exit 0 | `lib/client.js` CJS 0.59 kB + `lib/app.js` ESM 1.54 MB |
| `server-typecheck` | PASS（0/0） | |
| `runtime-budget` | PASS（5051/5051，余量 0） | |
| `client-contract-check` | PASS | |
| `term-lint` | PASS（HR 文案无「证据」） | |
| `entry-reachability`（`WHITELIST=[]`） | PASS（无新缺口；4 条 config 路由已接通；手拼写动作 0） | |

> tsdown 会重写被 git 跟踪的 `lib/*.js` 构建产物；捕获结果后已 `git checkout --` 恢复。真机 UI 阶段曾临时重建 `lib/app.js` 使新 testid 生效，结束后亦恢复至 HEAD。

## 2. 全量测试

`RECRUITMENT_DB_PASSWORD / RECRUITMENT_PYTHON / RECRUITMENT_PYTHON_BIN / RECRUITMENT_CONVERTER_DIR` 显式注入，经 `work/d5/fullpage/run-clean-suite.mjs`（一次性库 + 25 个迁移）执行 `node test/run-all.mjs --test-concurrency=1`：

```
ℹ tests 3091
ℹ suites 110
ℹ pass 3089
ℹ fail 0
ℹ cancelled 0
ℹ skipped 2
ℹ todo 0
ℹ duration_ms 320730.3965
[clean-suite] test exit=0
[clean-suite] db dropped
```

日志：`gates/full-tests.log`。

## 3. 15 步 preview 回归（`15step/`）

`node work/d5/fullpage/run-v4-issue91.mjs --fresh --port 49354 --out evidence/issue91-20261124/15step`
（该副本仅把 `work/d5/fullpage/run-v4.mjs` 的端口白名单改为 49354、CDP 改为 9233；原始 harness 与产品代码未改。）

- `runbook-result.json`：`{"PASS":15,"FAIL":0,"BLOCKED":0}`，S1–S15 全 PASS
- `audit-result.json`（独立审计 `audit-run.mjs`）：`hard_fail=0`、`leaks=0`、`soft_warn=3`（S8/S12/S15 keyText 前缀未进页面文本，与既有 PR#10 基线相同的软警告）
- 每步 UI 截图 / UI 文本 / psql 读回：`15step/evidence/Sxx-*`
- 退出后 Host/Chrome 停止、token 与一次性 profile 清理、端口释放均确认

## 4. 1440 真机 UI（`screenshots/`、`psql/`）

Host：`RECRUITMENT_AUTH_MODE=production`，port 49354；生产模式闸门 `GET /recruitment/test → 404`（`auth/production-gate.txt`）。以新账号 `hr_admin_e2e91` 登录后进入 `#/settings`。

### 4.1 G3 成对护栏

`settings-row-g3-telemetry` 渲染 4 对（`screenshots/settings-governance-g3.png` + `.txt`）：

1. HR 人工纠偏率 × 盲审抽检一致率：主 0.0% / 护栏 —，正常
2. 面评按时提交率 × 抽样原子事实忠实度：主 — / 护栏 —，暂无数据
3. 决策确认 × 撤回改判率：主 — / 护栏 —，暂无数据
4. 面试推进 × 取消/重约返工率：主 100.0% / 护栏 0.0%，正常

机检：`hasNaN=false`、`hasUUID=false`、`hasBanned(证据)=false`。
独立 psql 聚合 `psql/g3-counts.txt`：`3|0|0|0|0|0|6|0`，与 `/recruitment/api/settings` 的 `g3_telemetry.counts` 逐字段一致（`psql/settings-api.json`）。

### 4.2 组织配置（真 UI 点击 + psql 独立读回）

| 动作 | UI 反馈 | psql 读回 | 结论 |
|---|---|---|---|
| `settings-btn-new-role` 创建 `E2E_ROLE_91` | 已新增角色模板 | `E2E_ROLE_91\|E2E 验收角色\|t\|1` | PASS |
| `settings-deactivate-role-E2E_ROLE_91` | **参数不合法，逐条见 detail.violations** | 仍 `is_active=t, record_version=1` | **FAIL（P1）** |
| `settings-btn-new-pipeline` 创建 `E2E_PIPE_91` | 已新增招聘流程模板 | `E2E_PIPE_91\|E2E 验收流程\|t\|1` | PASS |
| `settings-deactivate-pipeline-E2E_PIPE_91` | 已软停用流程模板 | `is_active=f, record_version=2` | PASS |
| `settings-btn-new-team` 创建 `E2E_TEAM_91`（部门 `11111111-...-000000000010` 研发部（演示），来自真库） | 已新增招聘团队 | `E2E_TEAM_91\|E2E 验收招聘组\|dept\|研发部（演示）\|t\|1` | PASS |

证据：`psql/org-*.txt`、`screenshots/org-*.png`、`psql/org-api.json`。

**角色软停用 P1 根因（已复现，非猜测）**：`src/client/org-config.ts::buildDeactivateRoleBody()` 发送 `is_active:false`，但 `src/tools/config-role.ts` 的 `PARAMS`（封闭参数集）及 update 执行分支都没有 `is_active` 字段；服务端返回 400 `INVALID_ARGS/UNKNOWN_PARAM`，`allowed=[operation,code,name,description,clear_description,permission_scopes,role_id,expected_record_version,include_inactive]`。同一 body 去掉 `is_active` 后返回 200 `UNCHANGED`（`psql/org-role-deactivate-diagnostic.json`），证明领域层 `updateRole(... input.isActive ...)` 支持软关闭、断在工具 schema 接线。对照 `config-pipeline.ts` 已正确暴露 `is_active`，所以流程软停用可用。

## 5. auth-admin CLI + 生产登录（`auth/`）

- `node scripts/auth-admin.mjs sql-upsert --tenant 11111111-1111-4111-8111-000000000001 --username hr_admin_e2e91 --name 'E2E 验收管理员' --alias recruiter --password <强口令>` → SQL 落一次性库成功
- psql 读回：`hr_admin_e2e91|recruiter|scrypt$16384$8$1$<salt>$<hash>|t`；`hash_shape_ok=true`；明文口令命中 0（`auth/psql-readback.txt`）
- 生产模式 Host 上用新账号走真登录页登录成功，跳到 `/recruitment/app`；会话读回 `1|t`（`auth/session-readback.txt`）；截图 `screenshots/auth-login-page.png` / `auth-login-filled.png` / `auth-after-login.png`
- `auth/sql-upsert.sql` 只含 scrypt 哈希，证据目录全文扫描无明文口令

## 6. 其它真实问题

1. **P1 TS2300**：`SettingsView.tsx:89/91` 接口里 `record_version` 声明两次 → `tsc --noEmit` 红，静态门禁不过。
2. **P1 角色软停用断线**：见 4.2；Issue #91 的该项验收不通过。
3. **P2 构建产物陈旧**：HEAD 的 `dsh/dsh-recruitment/lib/app.js`（1,392,206 B）不含 `app-nav-settings`、`settings-row-g3-telemetry`、`settings-btn-new-role` 等新 testid；直接部署 HEAD 会让设置页新功能完全不可见。本次 UI 验收是在临时 `npx tsdown` 重建（1,539,997 B）后完成，结束已恢复 HEAD。
4. **P2 视觉层叠**：1440 截图中设置页内容半透明叠在队列列表之上（`settings-governance-g3.png` 等），DOM/文本正确但视觉呈现有层叠瑕疵。

## 7. 复跑命令

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
$env:RECRUITMENT_PYTHON='D:\Python3.12.9\python.exe'
$env:RECRUITMENT_PYTHON_BIN='D:\Python3.12.9\python.exe'
$env:RECRUITMENT_CONVERTER_DIR='D:\12412\DshWorktrees\recruitment-agent\e2e-91\converter'
node work/d5/fullpage/run-clean-suite.mjs
node work/d5/fullpage/run-v4-issue91.mjs --fresh --port 49354 --out evidence/issue91-20261124/15step
node work/d5/fullpage/audit-run.mjs --result evidence/issue91-20261124/15step/runbook-result.json --out evidence/issue91-20261124/15step/audit-result.json
# 1440 UI 阶段需先重建 lib/app.js（结束后 git checkout -- dsh/dsh-recruitment/lib/app.js）
node work/d5/fullpage/issue91-ui.mjs
```
