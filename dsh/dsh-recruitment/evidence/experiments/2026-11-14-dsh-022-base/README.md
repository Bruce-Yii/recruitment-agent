# 实验记录 · 2026-11-14 凌晨 · 把产品底座换成项目自带的 DSH 0.2.2-rc.1

**目的**：不再用用户机器上 9 月装的全局 CLI（0.1.5-rc.3），改成**项目自带、版本固定**的 DSH 副本，
并在真浏览器里验证招聘插件（18 个工具）在 0.2.2 上仍然可用。

**被测对象**：`feat/unified-document-intake`；底座 `@deepseek-ai/dsh@0.2.2-rc.1`（npm 装进项目目录）。

---

## 1. 背景：为什么必须换

| 事实 | 值 |
|---|---|
| 用户桌面端 DSH | `0.2.2-rc.1`（Electron，`D:\12412\DeepSeek Harness\`） |
| 机器上全局 CLI | `0.1.5-rc.3`，**2026-09-24 06:21:52** 安装（项目早期装的） |
| npm 上最新 | `0.2.2-rc.1`（与桌面端同版） |

之前直接用了 PATH 上的全局 CLI，等于**把产品建在一个旧版、且不属于项目的运行时上**。
用户的原话："你当时不应该去仓库下一个吗，然后对下载的dsh进行改造"。这是对的。

## 2. 落地：项目自带副本（不碰全局、不碰桌面端）

```powershell
New-Item -ItemType Directory -Force D:\12412\recruitment-runtime | Out-Null
cd D:\12412\recruitment-runtime
'{"name":"recruitment-runtime","private":true}' | Set-Content package.json
npm install @deepseek-ai/dsh@0.2.2-rc.1 --registry https://registry.npmmirror.com
# → added 652 packages in 1m
```

```powershell
D:\12412\recruitment-runtime\node_modules\.bin\dsh.cmd --version
# → 0.2.2-rc.1
```

全局 CLI 复核：`package.json` 修改时间仍是 `2026-09-24 06:21:52`（没被动过）。

## 3. 迁移中真实踩到的三个坑（都记下来）

### 3.1 旧会话把模型选择钉死了

第一次在 0.2.2 上发消息，报：

```
本轮运行失败 no adapter registered for provider "opencode-go-openai-key2"  NO_ADAPTER
```

原因：**会话里存了当时的模型选择**，改 profile 的 `agent-default-model` 对已有会话无效。
解决：清空产品 home 的 sessions 目录与 `workspace.json` 的 `sessionIds`（只动产品自己的 DSH home，
**该 home 按设计不入库**，不碰桌面 home），让新会话重新取默认值。

### 3.2 0.2.2 的 composer 不吃 `execCommand('insertText')`

0.1.5 上 `document.execCommand('insertText', …)` 能输入；0.2.2 上返回成功但**文字没进去**。
改用 CDP 的 `Input.insertText`（真实输入事件）才生效。

### 3.3 模型通道全线告急（这是真正的阻塞，不是配置问题）

直接打 provider 端点（不经过 DSH）得到的原文：

| provider / model | 端点返回 |
|---|---|
| `beam-free` | `{"type":"rate_limit_error","message":"Rate limit exceeded. Please try again later."}` |
| `glm-5.3` / `glm-5.3-flash` | `{"type":"GoUsageLimitError","message":"OpenCode Go usage limit reached (monthly, resets …)"}` |
| DeepSeek API key | `{"error":{"message":"Insufficient Balance …"}}` |
| DeepSeek 账号路由 | UI 报 `当前请求的额度已用尽  QUOTA` |
| **`longcat-2.5-free`** | **HTTP 200** |
| **`iceman-contributor-free`** | **HTTP 200** |

→ 换成 `longcat-2.5-free`（它还是唯一支持图片输入的免费模型，后面读简历图片要用）。

## 4. 验证：真浏览器里调通（0.2.2 + 隔离 home）

一条命令跑完（起服务 → 浏览器操作 → 收工杀进程），脚本见本目录 `verify-022.ps1` / `verify-022.mjs`：

```
SERVER_PID=16304
URL=http://127.0.0.1:49303/?token=…
INTRO: NO_MODAL
COMPOSER: true
SENT
RESULT_AT 9s
已完成，用时 11秒
title: 后端工程师 status: DRAFT
[免费] LongCat 2.5 Free
VERIFY_EXIT=0
```

截图：`browser-tool-call-ok.png`。

**DB 读回**（同一时刻 `psql`）：

```
792a10f9-6dd3-4d80-b141-6345880e2399|后端工程师|DRAFT|1
```

→ **0.2.2 上工具注册成功、模型真的调到了、结果与 DB 一致。**
这条同时证明：我们的插件（raw `ToolDefinition` + `ctx.tools.register`）在 0.2.2 的
`dsh-tools` 上**不需要改代码**就能注册。

## 5. 结论

| 项 | 状态 |
|---|---|
| 底座 | ✅ 项目自带 `0.2.2-rc.1`，与桌面端同版，版本固定 |
| 隔离 | ✅ 独立 `DSH_HOME`，桌面 home 与全局 CLI 均未改动 |
| 插件 | ✅ 18 个工具在 0.2.2 上注册，`recruitment_job_get` 浏览器实测通 |
| 模型 | ⚠️ 只剩免费通道（longcat / iceman）；付费通道全部额度用尽 |
| UI | ❌ 仍是原版 DSH Web（产品 UI 还没写） |

## 6. 复现

```powershell
& 'D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment\evidence\experiments\2026-11-14-dsh-022-base\verify-022.ps1'
```

前置：Chrome 以 `--remote-debugging-port=9223` 运行；产品 home 已放好 profile
（见 `dsh/profile/recruitment/README.md`）。
