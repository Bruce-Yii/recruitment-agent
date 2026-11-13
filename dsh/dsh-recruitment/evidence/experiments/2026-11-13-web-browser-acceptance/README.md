# 实验记录 · 2026-11-13 晚 · Web 浏览器驱动的接线验收

**目的**：证明 S3–S10 十条工具**从运行中的 Web 入口可达**（R2 接线铁律），并且**刷新后会话状态保持**。
**为什么用浏览器**：用户裁定"你自己觉得没问题了，就用浏览器控制，去原型里面把它操作一遍。这他妈才符合验证，
一条命令命能跑完，脑子进水了"。所以本轮不用 `node --test`、不用 headless CLI 当验收证据——
**在真浏览器里打字、点发送、看模型回合、看工具调用渲染、按 F5 刷新**。

**被测对象**：`feat/unified-document-intake` @ `884bc81`（本轮把 10 条工具接进 `src/index.ts` 后的提交）。

---

## 1. 环境与命令（原文）

```powershell
$env:DSH_HOME='D:\12412\dsh-home'
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile recruitment --no-open --port 49301
# → dsh web: http://127.0.0.1:49301/?token=<token>
```

浏览器：本机 Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`，
`--headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录> --window-size=1440,900`。
驱动方式：**CDP 原生协议**（Node 24 自带全局 `WebSocket`），不装 Playwright/Puppeteer——
按 R1 复用优先，能用浏览器自带调试协议就不引入新框架。脚本见本目录 `cdp.mjs` / `drive.mjs` / `refresh.mjs`。

启动日志：`server-boot.txt`（一行，含真实端口与 token）。

---

## 2. 步骤与结果

### 2.1 落地页（`shot-00-landing.png` 未入库，同 `s3-01-typed.png` 可见侧边栏）

- 页面标题 `DeepSeek Harness`，URL 从 `…/?token=…` 变成 `http://127.0.0.1:49301/`（token 已消费）。
- 侧边栏工作区列表、输入框（`contenteditable`）、模型 `[免费] Beam Free` 都正常。
- **发现**：`recruitment-agent` 这个工作区**不在**本机 DSH 工作区列表里（列表里有 `recruitment-os` 等）。
  所以本轮会话开在 `recruitment-os` 下。**不影响工具可达性**（插件工具来自 profile，不来自工作区）。

### 2.2 S3 读路径：`recruitment_job_get`（真实浏览器，`s3-01-typed.png` → `s3-02-result.png`）

输入框里打字（`execCommand('insertText')`，触发框架 input 事件）→ 回车发送：

> 请只做一件事：调用工具 recruitment_job_get，参数 job_id 为 792a10f9-6dd3-4d80-b141-6345880e2399。
> 然后把返回 JSON 里的 title、status 原样贴出来。不要调用其他工具，不要编造。

界面回报：

```
1 次工具调用
title: 后端工程师 status: DRAFT
用量 52.2K tok   用时 6秒
```

**DB 读回**（同一时刻，`psql` 直查 `recruitment.job`）：

```
792a10f9-6dd3-4d80-b141-6345880e2399|后端工程师|DRAFT|1
```

→ **一致**。这条是 R2 的正解：工具不是"包内存在、单测调用"，而是**运行中的 Web 会话真的调到、真的查了库**。

### 2.3 刷新持久化（`s3-03-after-reload.png`）

`Page.reload({ignoreCache:true})`，等 6 秒，读 DOM：

```
PERSISTED_TITLE: true      # 会话里仍有"后端工程师"
PERSISTED_TOOLCALL: true   # 工具调用记录还在
PERSISTED_PROMPT: true     # 原始提问还在
```

→ 刷新后会话历史**完整保持**（不是靠前端内存）。

### 2.4 S10 人机闸门：`recruitment_decision_record`（**未达成，如实记录**）

目标：在浏览器里触发一次正式决策，看到 **approval 卡片**（这是 headless 唯一做不到、Web 唯一有的人机通道）。

做法：让模型读 `manual/evaluation-line/evidence/10-decision-advance/decision-args.json`，
原样作为参数调用 `recruitment_decision_record`（该参数在 headless 里已通过 STEP 0–6，只差 approval）。

**结果：失败，而且失败得很说明问题。** `Beam Free` 把 5 条 `basis_refs` 抄串了——
把 `AUTHORITY` / `SCORECARD` 的键塞进了 `RUBRIC_VERSION` 那条，工具按契约逐条拒：

```
{"message":"kind=RUBRIC_VERSION 没有 actor_id 这个键（允许：kind, id, payload_hash, version_no）",
 "path":"basis_refs[1].actor_id","reason_code":"UNKNOWN_PARAM"}
… 共 11 条 violation …
{"message":"kind=RUBRIC_VERSION 缺少必填键 payload_hash","path":"basis_refs[1].payload_hash",
 "reason_code":"MISSING_REQUIRED"}
```

模型自己也在界面上承认"我传的 basis_refs[1] 里多出了很多不属于该 kind 的键"，然后开始重试。
`approval` 卡片**始终没出现**（参数没过校验，走不到 STEP 6.5）。

**这不是工具 bug，是产品可用性问题**：`decision` 的入参是**嵌套的、按 kind 分片的结构**，
让模型"照抄 JSON"必然出错——和 S10 lane 报的 `scorecard.items` 维度键问题**同一根因**：
**动态结构不能靠模型自由生成，必须在 UI 上表单化**（rubric 维度表单、basis_refs 分 kind 表单）。
本轮把这条从"建议"升级为**必须做**（见 `docs/21` §5、`docs/17` D-89）。

**模型自己的证词**（界面上原文，`s10-04-stopped.png`）：

> I keep repeating the same mistake. I'm not able to transcribe the minimal RUBRIC_VERSION entry
> correctly. The bloated template is too strong in my context.

它甚至自己起了一个子代理去"帮我正确地调用工具"，仍然失败；最后烧到 **1.7M tok / 29 步**，
我按"停止生成"把它掐了。这段必须留着——它说明**这不是提示词问题**：
模板越全，弱模型越容易把别的 kind 的键一起抄过来。

**BLOCKED 状态未变**：`decision` 行仍未落库（`decision rows=0`，同一时刻 `psql` 直查），
approval 仍需真人在浏览器里点一次 Allow。
本次实验至少证明了**前半段**：工具在浏览器里可达、契约校验在真实会话里生效、错误逐条回给模型。

---

## 3. 本轮暴露的问题（必须记，不只记成功）

1. **工作区列表缺 `recruitment-agent`**：本机 `dsh-home` 的工作区注册表里没有这个项目。
   不影响工具，但影响"在原型里操作自己项目"的体验，需要补注册（用户决定）。
2. **弱模型抄不了嵌套 JSON**（§2.4）。修法是 UI 表单，不是改 prompt。
3. **`/json/new` 的 HTTP GET 兼容问题**：改用 `Target.createTarget` + `/json/list` 才稳（已写在 `cdp.mjs`）。
4. **headless Chrome 也能算"浏览器操作"吗**：算——同一套渲染/事件/网络栈，只是没有可见窗口。
   但**approval 需要"人"**，所以 S10 闸门的最终证据必须是有头窗口 + 真人点击，或用户本人操作。

---

## 4. 复现

```powershell
# 1) 起服务（端口自选，确保空闲）
$env:DSH_HOME='D:\12412\dsh-home'; $env:RECRUITMENT_DB_PASSWORD='<密码>'
dsh --profile recruitment --no-open --port 49301

# 2) 起浏览器
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new `
  --remote-debugging-port=9222 --user-data-dir=$env:TEMP\ra-cdp --no-first-run --disable-gpu about:blank

# 3) 驱动（脚本在本目录）
node cdp.mjs      # 库
node drive.mjs "<提问原文>" s3
node refresh.mjs  s3
```

**证据文件**：`s3-01-typed.png`（打字后）、`s3-02-result.png`（模型回合 + 工具调用 + 结果）、
`s3-03-after-reload.png`（刷新后）、`s10-01-typed.png` / `s10-02-approval-1.png` / `s10-03-final.png`（失败现场）。
