# 飞书：不需要重新授权，现有身份就能读（2026-11-14）

**用户报错**："请求不合法"（设备码链接）。**结论：那条链接确实失效了，但这条路本来就不用走。**

---

## 1. 为什么不用重新登录

`lark-cli auth status` 实测：

```json
{
  "identity": "user",
  "user": {
    "status": "needs_refresh",
    "available": true,
    "userName": "余奕",
    "expiresAt": "2026-11-12T09:57:02+08:00",
    "refreshExpiresAt": "2026-11-19T07:57:02+08:00",
    "note": "will be refreshed automatically on the next user API call"
  }
}
```

关键三点：
1. `available: true` + **refresh token 有效到 2026-11-19** —— 访问令牌过期会自动刷新，不需要人重新授权；
2. **scopes 里早就有**我们需要的：`minutes:minutes:readonly`、`minutes:minutes.basic:read`,
   `minutes:minutes.transcript:export`、`minutes:minutes.artifacts:read`、`vc:meeting.meetingevent:read`、
   `vc:record:readonly`、`offline_access`；
3. 设备码（device flow）是**重新授权**才需要的一次性动作，10 分钟就过期 ——
   "请求不合法"就是链接过期/已消费，不是应用或权限有问题。

**教训**：先查 `auth status`，再决定要不要走 device flow。我上一轮直接开设备码流程，方向就错了。

## 2. 真实 LIVE 读取（实测成功，不是"应该能读"）

### 2.1 列会议（`minutes +search --owner-ids me`）

```json
{ "ok": true, "identity": "user",
  "data": { "has_more": true, "items": [
    { "token": "obcn3ju642ita9ak1787v354", "display_info": "yi的视频会议 … 时长: 6 分 23 秒" },
    { "token": "obcn3j6t382yf32e4z2usp46", "display_info": "yi的视频会议 … 时长: 14 分 6 秒" },
    { "token": "obcn1p87v1pulu18iej94h2c", "display_info": "新录音 … 时长: 8 秒" },
    { "token": "obcnza1v2lgxo8qv1r5pc5d9", "display_info": "yi的视频会议 … 时长: 28 秒" }
  ] } }
```

### 2.2 取转写（`minutes +detail --transcript`）

```
[minutes +detail] writing transcript: minutes\artifact-yi的视频会议-obcn3j6t382yf32e4z2usp46\transcript.txt
[minutes +detail] done: 1 total, 1 succeeded, 0 failed
```

四个 token 的转写都取到了（**只记度量，不记内容**，R7）：

| minute_token | 字符数 | 行数 | sha256（前 16） |
|---|---|---|---|
| `obcn3ju642ita9ak1787v354` | 71 | 8 | `9395b98fc433f93a…` |
| `obcn3j6t382yf32e4z2usp46` | 46 | 5 | — |
| `obcn1p87v1pulu18iej94h2c` | 40 | 5 | `6b8b9ff4d7298d5a…` |
| `obcnza1v2lgxo8qv1r5pc5d9` | 41 | 5 | `d9a1d469908766be…` |

**都是几十个字符**：这几段录音本身很短（8s / 28s）或没有语音，转写内容几乎为空。

### 2.3 ⚠️ 更正：**真的有语音的会议存在，是我第一次挑错了**

用户指出"我的会议绝对有，是你自己没弄到"——**他是对的**。

第一次我只挑了 4 个 `yi的视频会议` 的 token。把 `--owner-ids me` 的**全部 12 个**都拉下来看文件大小：

| minute_token | 标题 | 转写文件大小 |
|---|---|---|
| `obcnvf38p9qkb3n58tak57jg` | **audio** | **6397 B** ← 真转写 |
| `obcnuym8vvyv328i1y63u956` | **api_sample** | **4485 B** ← 真转写 |
| `obcnuyl73qf5e677y4f4xvgw` | **sample_audio** | **4485 B** ← 真转写 |
| `obcn3ju642ita9ak1787v354` 等 9 个 | yi的视频会议 / 新录音 | 40–87 B（只有表头） |

`obcnvf38p9qkb3n58tak57jg` 的结构度量（**只记度量，不记内容**）：

```
chars=2379  lines=29  sha256=e17ffd5d95326d8f…
第 1 行：日期表头    第 3 行：Keywords:
```

**为什么第一次是空**：`yi的视频会议` 是**视频会议录制**，没有生成"妙记"AI 转写，
`+detail --transcript` 只写出表头；而 `audio` / `api_sample` / `sample_audio` 这三条是**妙记**，
转写完整。挑 token 时不能只看"时长"，要看**是不是妙记**。

**教训**：判断"有没有数据"之前，先把候选**全部**拉一遍比大小，不要用前 4 条下结论。

## 3. 现在的标签（三维正交，不许混）

| 维度 | 值 | 依据 |
|---|---|---|
| `provenance` | **LIVE** | 真实飞书 API 返回真实 minute_token 与转写文件（非 fixture） |
| `trigger` | **MANUAL** | 我手工跑 CLI 触发，不是事件自动摄取 |
| `connection` | **CONNECTED（仅限 CLI 路径）** | 用户身份 + scopes 实测可用 |

**仍未闭环**：
1. 产品 connector（`src/connectors/feishu/adapter.ts`）是**零 I/O 骨架**，`fetchTranscript()` 不会真的调 CLI —— 这段代码还没写；
2. 需要一段**有真实语音**的会议，才能满足 demo gate 的"真实 provider artifact"要求；
3. 产品自有飞书应用凭据仍未提供（现在用的是本机 `lark-cli` 的开发者 profile，按禁止清单第 6 条不能作为产品连接器凭据）。

## 4. 复现

```powershell
lark-cli auth status
lark-cli minutes +search --owner-ids me --page-size 5 --json
lark-cli minutes +detail --minute-tokens <token> --transcript --json --output-dir ./minutes
```

## 5. 产品路径复证（2026-11-14 晚，lane `feishu-live-gate`）

上面 §2 是**手工跑 CLI** 的证据；本节补的是**产品代码路径**能拿到 LIVE 的证据：
`src/connectors/feishu/transport.ts`（`lark-cli-transport`）已按实测形态校正 argv
（复数 `--minute-tokens` / `--as user` / `--transcript` / 相对 `--output-dir`），
并改为**读落盘文件**（stdout 只给 `artifacts.transcript_file`）。

- 复跑脚本：`run-live-read.mjs`（本目录）；输出：`live-read.json`（本目录）。
- 脚本用产品传输层跑真实 CLI：`--help` 探测 → 两次完整读取（重读校验）→
  `evaluateLiveGate()`；再走 `resolveFeishuConnector` → `adapter.fetchTranscript()` 产品出口。
- R7：**本目录不含正文**。脚本里正文只在内存中出现，算完 sha256 后临时工作目录已删除
  （`live-read.json` 里 `r7.temp_workdirs_leftover` 为空数组）。

复证结果（与 §2.3 的 6397 B / 4485 B 表逐字一致）：

| minute_token | 文件字节 | content_sha256 | 重读哈希 | gate | labels |
|---|---|---|---|---|---|
| `obcnvf38p9qkb3n58tak57jg` | 6397 | `e17ffd5d95326d8f461ee87a5bdff023e9b5c0cf826df528ce68b55baf2a63a0` | 一致 | `LIVE` | `LIVE / MANUAL / CONNECTED` |
| `obcnuym8vvyv328i1y63u956` | 4485 | `f3f45d49cca4e478b65a7ce8bf8d0401c2ee7037919d9647cfb25dd9a38c8744` | 一致 | `LIVE` | `LIVE / MANUAL / CONNECTED` |

- 产品完整出口（`resolveFeishuConnector` → `adapter.fetchTranscript`）对
  `obcnvf38p9qkb3n58tak57jg` 返回 `kind=READ`、`live_gate=LIVE`、`live_eligible=true`、
  `provenance_basis=LIVE_READBACK_VERIFIED`。
- `argument_flags_verified` / `envelope_verified`：`transport.verifyContract()` 真实跑
  `minutes +detail --help`（exit 0、四个必需 flag 全在）→ `argument=true`；一次成功真实
  读取 → `envelope=true`。**没有硬编码 true**。
- CLI：`lark-cli 1.0.81`，本机绝对路径
  `D:\12412\npm-global\node_modules\@larksuite\cli\bin\lark-cli.exe`（npm shim 背后的原生二进制）。

§3 的「仍未闭环」里，第 1 条（产品 connector 不真的调 CLI）已由本轮修复；
第 2 条（有真实语音的会议）就是本节的 `audio` / `api_sample` 两条；
第 3 条（产品自有凭据 / OAuth）仍是 **P1**，按 D-1 不阻塞 demo。

