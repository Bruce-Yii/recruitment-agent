# 产品 profile：`recruitment`

**这份定义入库**（D-92）。`$DSH_HOME/profiles/recruitment/` 是它的运行时副本，由本目录同步过去。
这样"产品是什么"只由仓库决定，不靠某台机器上手工配出来的状态。

## 组成

| 文件 | 作用 |
|---|---|
| `package.json` | profile 的 bundle 列表：`dsh-base` + `dsh-web-app` + `@recruitment/dsh-recruitment`；依赖用 `link:` 指向本仓库的插件包 |
| `cordis.patch.yml` | 增量层：默认模型、招聘插件配置（converter / database）、插件包级 skill 目录 |

## 底座（D-92）

产品跑**项目自带的 DSH 副本**，不用全局 CLI、不碰桌面端：

```
D:\12412\recruitment-runtime\          ← npm i @deepseek-ai/dsh@0.2.2-rc.1
  node_modules\.bin\dsh.cmd            ← 用这个跑，不是 PATH 上的 dsh
```

安装（一次性）：

```powershell
New-Item -ItemType Directory -Force D:\12412\recruitment-runtime | Out-Null
cd D:\12412\recruitment-runtime
'{"name":"recruitment-runtime","private":true}' | Set-Content package.json
npm install @deepseek-ai/dsh@0.2.2-rc.1 --registry https://registry.npmmirror.com
```

## 起服务（隔离 home，不碰桌面端）

```powershell
# 1) 一次性：把 profile 同步进产品自己的 home
$home = 'D:\12412\dsh-home-recruitment'
New-Item -ItemType Directory -Force "$home\profiles\recruitment" | Out-Null
Copy-Item -Force .\package.json,.\cordis.patch.yml "$home\profiles\recruitment\"
cd "$home\profiles\recruitment"; pnpm install --frozen-lockfile   # 或 pnpm install

# 2) 每次启动
$env:DSH_HOME = $home                       # 进程级，不改用户级环境变量
$env:RECRUITMENT_DB_PASSWORD = '<本机 PG 密码>'
D:\12412\recruitment-runtime\node_modules\.bin\dsh.cmd --profile recruitment --no-open --port 49303
```

`DSH_HOME` 必须是**产品自己的**目录（D-91）：桌面端和全局 `dsh` 共用用户级 `DSH_HOME`，
复用它会连会话库、工作区、凭据一起共用，打开看到的就是桌面端。

## 模型通道（D-93，2026-11-14 实测）

`agent-default-model` 当前用 `opencode-go-openai-key2` / `longcat-2.5-free`。实测结果：

| provider / model | 结果 |
|---|---|
| `longcat-2.5-free` | ✅ 可用（且是唯一支持图片输入的免费模型） |
| `iceman-contributor-free` | ✅ 可用（不支持 vision） |
| `beam-free` | ⛔ `rate_limit_error` |
| `glm-5.3` / `glm-5.3-flash` | ⛔ `GoUsageLimitError`（月度额度用尽） |
| DeepSeek 官方账号路由 | ⛔ `QUOTA` |
| DeepSeek API key 路由 | ⛔ `Insufficient Balance` |

换模型只改 `cordis.patch.yml` 的 `agent-default-model.model`，**新会话**才生效
（已有会话会把模型选择钉住，报 `no adapter registered for provider …` 或沿用旧模型）。

## 不要做的事

- 不要 `npm install -g`（会动用户的全局 CLI）。
- 不要把 `DSH_HOME` 指向 `D:\12412\dsh-home`（那是桌面端的）。
- 不要把密码/密钥写进 `cordis.patch.yml`（只写 `password_env` / `apiKeyEnv`）。
