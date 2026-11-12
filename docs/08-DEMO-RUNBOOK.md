# 08 · Golden Path 运行手册（可复现）

> ⚠️ **HISTORICAL（2026-11-13 标注）**：这份手册描述的是**已废弃的老仓 monorepo** 底座
> （`integration/v1.0-flow` 分支、pg-boss、`packages/db`、1106 条测试、5 条 lane 合并）。
> 那套底座已整体废弃，**不要照这份文档跑任何东西**。
> 当前底座的运行手册见 **`docs/18-golden-path.md`**。本文仅作历史记录保留。

**目标**：一条命令级别的步骤，把 v1.0 Golden Path 在本机跑起来并留下凭据。
**分支**：`integration/v1.0-flow`（已推送）
**已实测**：2026-11-12，Windows 11 + Node 24.16 + pnpm 12.3.4 + PostgreSQL 17.11

---

## 0. 一句话现状

| 环节 | 状态 |
|---|---|
| 集成基线 | ✅ 5 条 lane 零冲突合并 |
| 全量测试 | ✅ **167 files / 1106 tests，0 failed，0 skipped** |
| 类型检查 | ✅ exit 0 |
| 真实飞书 MANUAL 读取 | ✅ **67/67 checks PASS，exit 0** |
| 事件 → Task → pg-boss → Worker 投递 | ✅ 已接通（约 2–4 秒送达） |
| Worker 注入 Feishu port | ✅ 组合根已接；未配置时 fail-closed 并列出缺失项 |
| 自动（无人值守）真实飞书读取（F2） | ⛔ **BLOCKED**——见 §7 |

---

## 1. 前置

```powershell
# 仓库与分支
cd D:\12412\DshWorktrees\recruitment-os\integration

# 工具
node --version        # v24.x
pnpm --version        # 12.x
# PostgreSQL 17 服务在跑（本机：D:\12412\PostgreSQL）
D:\12412\PostgreSQL\bin\psql.exe --version

# 飞书 CLI（项目 pin）
# 二进制：D:\12412\npm-global\node_modules\@larksuite\cli\bin\lark-cli.exe
# 版本必须 1.0.81；SHA256 必须 7f41992f5fd4021f7cbe3ad4cfef405dc69853d2777f4adff65f1ad7f8541e51
```

**先验 pin**（不一致就不要往下跑）：

```powershell
$exe='D:\12412\npm-global\node_modules\@larksuite\cli\bin\lark-cli.exe'
(Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()   # 期望 7f41992f...
& $exe --version                                      # 期望 1.0.81
& $exe auth status --json                             # user 身份需 ready 或 needs_refresh
```

---

## 2. 建一个干净库

`MEETING_ALREADY_BOUND` 是设计保护：同一会议只能绑一个面试。**每跑一次 Golden Path 换一个新库。**

```powershell
# 在 packages/db 下建库脚本（该目录能解析 pg 依赖）
@'
import pg from 'pg';
const admin = process.env.ADMIN_URL, name = process.env.NEW_DB;
const c = new pg.Client({ connectionString: admin });
await c.connect();
await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${name}`);
await c.query(`ALTER DATABASE ${name} OWNER TO recruitment_os_app`);
await c.end();
const a = new pg.Client({ connectionString: process.env.APP_URL });
await a.connect(); await a.query('GRANT ALL ON SCHEMA public TO recruitment_os_app'); await a.end();
console.log('ready', name);
'@ | Out-File packages\db\tmp-mk.mjs -Encoding utf8

$e = Get-Content .env
$admin = ($e | Where-Object {$_ -match '^TEST_DATABASE_ADMIN_URL='}) -replace '^TEST_DATABASE_ADMIN_URL=',''
$app   = ($e | Where-Object {$_ -match '^DATABASE_URL='}) -replace '^DATABASE_URL=',''
$newUrl = $app -replace '/recruitment_os$','/ri_demo'
$env:ADMIN_URL=$admin; $env:APP_URL=$newUrl; $env:NEW_DB='ri_demo'
node packages\db\tmp-mk.mjs
Remove-Item packages\db\tmp-mk.mjs
```

## 3. 迁移 + 种子

```powershell
$env:DATABASE_URL = $newUrl
pnpm db:migrate     # 期望 applied=8
pnpm db:seed        # 期望 credential_inserted=true，并打印 golden-path 各 id
```

## 4. 起 API（3010）

```powershell
$env:DATABASE_URL = $newUrl
$env:RESUME_ROOT_DIRECTORY = (Join-Path (Get-Location) 'fixtures\w7\phase9')   # 注意到 phase9
$env:AGENT_RUNTIME_ENABLED = 'true'
$env:API_PORT='3010'; $env:API_HOST='127.0.0.1'
node --import tsx apps/api/src/main.ts
```

> `RESUME_ROOT_DIRECTORY` 必须指到 **包含 `resume.txt` 的那一层**；API 用 `storageRef='resume.txt'` 拼路径。

## 5. 跑真实飞书 Golden Path（MANUAL 真实读取）

另开一个终端：

```powershell
cd D:\12412\DshWorktrees\recruitment-os\integration
$e = Get-Content .env
foreach($l in $e){ if($l -match '^(DEMO_EMAIL|DEMO_PASSWORD)='){ $k=($l -split '=')[0]; $v=($l -split '=',2)[1]; Set-Item "env:$k" $v } }
$env:DATABASE_URL = $newUrl
$env:API_BASE='http://127.0.0.1:3010'
$env:LARK_CLI_BIN='D:\12412\npm-global\node_modules\@larksuite\cli\bin\lark-cli.exe'
$env:LARK_CLI_SHA256='7f41992f5fd4021f7cbe3ad4cfef405dc69853d2777f4adff65f1ad7f8541e51'
$env:LARK_CLI_USE_GLOBAL_PROFILE='1'
$env:PSQL_BIN='D:\12412\PostgreSQL\bin\psql.exe'
$env:OUTPUT_JSON = (Join-Path (Get-Location) 'work\phase9-live-evidence.json')
node packages/testing/scripts/phase9-live-e2e.mjs
```

**期望**：`EXIT=0`，`work/phase9-live-evidence.json` 里 67 个 check 全 `ok:true`。

## 6. 验证落库（不看日志，看库）

```powershell
$env:APP_URL = $newUrl
@'
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.APP_URL });
await c.connect();
console.table((await c.query(`select provider, provider_artifact_id, data_mode, trigger_mode, status, page_count from transcript_artifacts order by created_at desc limit 2`)).rows);
console.log('segments', (await c.query('select count(*)::int n from transcript_segments')).rows[0].n);
await c.end();
'@ | Out-File packages\db\tmp-v.mjs -Encoding utf8
node packages\db\tmp-v.mjs; Remove-Item packages\db\tmp-v.mjs
```

**期望**：`FEISHU | obcn3ju642ita9ak1787v354 | LIVE | MANUAL | READY | 1`，`segments 4`。

## 7. 起 Worker（验证队列投递与 port 注入）

```powershell
$env:DATABASE_URL = $newUrl
$env:WORKER_HEALTH_PORT='3020'
$env:FEISHU_MODE='NOT_CONNECTED'        # 默认 fail-closed；生产读取需 §8 的条件
node --import tsx apps/worker/src/main.ts
```

**期望日志**：
- `feishu transcript source composed`（state=`NOT_CONNECTED`）
- `recruitment-os-worker consumers ready`
- `w3 task run jobs dispatched`（有到期任务时）

**若只给部分 FEISHU_* 配置**，期望：
```
WARN: feishu transcript source not configured; TRANSCRIPT_FETCH stays fail-closed
  issues: ["FEISHU_CLI_BIN is required", "FEISHU_CLI_SHA256 is required", ...]
```
——**这是正确行为，不是故障。**

---

## 8. 自动（无人值守）真实飞书读取：当前边界

`packages/connectors/src/feishu/pin.ts` 的 `assertPinnedCli` **明确拒绝 `~/.lark-cli`**（返回 `POLICY_BLOCKED`），理由是连接器必须自带授权与版本，不能挂在开发者全局 profile 上。

**推论**：

| 路径 | 能否真实读飞书 | 说明 |
|---|---|---|
| MANUAL 探针（`phase9-live-e2e.mjs` + 全局 profile） | ✅ 可以 | 已批准口径：`provenance=LIVE` + `trigger=MANUAL` + `connection=NOT_CONNECTED` |
| Worker 自动路径（`TRANSCRIPT_FETCH` 经队列） | ⛔ 暂不可 | 需要**项目自有的 isolated CLI 配置目录**并单独登录（F2，P1） |

**要打开 F2**，需要：

```powershell
$env:FEISHU_MODE='MANUAL'
$env:FEISHU_TENANT_KEY='<tenant uuid>'
$env:FEISHU_CLI_BIN='<pinned lark-cli.exe 绝对路径>'
$env:FEISHU_CLI_SHA256='<该二进制的 sha256>'
$env:FEISHU_CLI_CONFIG_DIR='<项目自有目录，不能是 ~/.lark-cli>'
$env:FEISHU_GRANTED_BY='<批准这次读取的人或工单>'
```

并在 `FEISHU_CLI_CONFIG_DIR` 里完成一次独立授权。**在此之前，自动路径保持 fail-closed 是正确状态，不得降级成 Fixture 冒充 LIVE。**

---

## 9. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `409 MEETING_ALREADY_BOUND` | 同一会议已绑定过 → **换新库**（§2） |
| `P0-03 resume version` 非 201 | `RESUME_ROOT_DIRECTORY` 没指到 `fixtures\w7\phase9` |
| `live artifact LIVE + FEISHU` 检查失败 | 没设 `PSQL_BIN`，脚本无法做 DB 校验 |
| `LIVE transcript content requires a connector read receipt` | 探针未带 `receipt`；本分支已修（`phase8-minutes-probe.mjs`） |
| `lark-cli digest mismatch` | 二进制不是 pin 的那个，或版本变了 |
| Worker 日志 `TRANSCRIPT_FETCH stays fail-closed` | 正常；见 §8 |
| 任务一直 `READY` | 检查 worker 是否在跑、`w3 task run jobs dispatched` 是否出现 |

---

## 10. 一键自检（建议每次改完跑）

```powershell
pnpm typecheck ; if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
pnpm test      ; if ($LASTEXITCODE -ne 0) { throw 'tests failed' }
```
**必须看三个数**：`Test Files` / `Tests` / `failed`。`skipped > 0` 不算全绿。
