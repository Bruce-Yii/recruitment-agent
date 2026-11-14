# 飞书 LIVE 回读证据（2026-11-14 · D-1 口径）

> **R7 边界先写在最前面：本文件与同目录 `commands.txt` 只记录 provider artifact 的
> id / 哈希 / 大小 / 时间 / 命令，不记录任何转写正文（连第一行都不记）。
> 现场读取产生的 `transcript.txt` 落在 `%TEMP%`，度量完成后已删除（见 §4）。**
>
> 记录者：lane `evidence-audit` 子代理。事实来源分两类，分别标注：
> ① 任务下达方提供的原始回读（2 次，本人执行）；② 本 lane 现场复核（2 次，2026-11-14 20:16–20:18 +08:00）。
> 两类口径一致，共 4 次独立完整回读。

---

## 0. 一句话结论

两条真实飞书妙记（标题 `audio` / `api_sample`）经
`lark-cli minutes +detail --as user --minute-tokens <token> --transcript` 真实读取，
转写落盘后按**字节级 sha256** 复核：**两次独立完整回读，哈希逐字节一致**（本 lane 现场又复跑两次，仍一致）。
按已批准的 **D-1**（2026-11-12）口径，这次读取满足 `provenance=LIVE` + `trigger=MANUAL` +
真实 provider artifact ID/hash/readback，**可作为 demo gate 的 LIVE 外部事实**；
产品自有 OAuth + 事件自动摄取（F2）属 **P1**，不阻塞 demo。

**这不是产品闭环**：本证据只证明"用本机开发者身份的 `lark-cli` 真读到了真实产物"，
不证明产品连接器自己会读（R4：一次真实读取 ≠ 产品闭环成立）。

---

## 1. 命令原文、时间、身份

### 1.1 命令（可复制）

```powershell
lark-cli auth status
lark-cli minutes +detail --as user --minute-tokens <minute_token> --transcript --output-dir ./minutes
```

- `--as user`：**用户身份**，不是 bot。
- 转写落在 `./minutes/artifact-<title>-<minute_token>/transcript.txt`（CLI 自己命名）。
- 命令形态与 D-1 验收路径一致；`--json` 不是必需（本次未加）。

### 1.2 `lark-cli auth status` 身份（**不贴 token**）

| 字段 | 值 |
|---|---|
| `identity` | `user` |
| `appId` / `brand` | `cli_aae49f8438f8dce4` / `feishu` |
| `identities.user.status` | `ready` |
| `identities.user.available` | `true` |
| `identities.user.userName` | `余奕` |
| `identities.user.tokenStatus` | `valid` |
| `identities.user.expiresAt` | `2026-11-14T20:52:17+08:00` |
| `identities.user.refreshExpiresAt` | `2026-11-21T18:52:17+08:00` |
| `identities.user.grantedAt` | `2026-11-09T19:13:29+08:00` |
| 关键 scopes 存在性（203 个 scope 内） | `minutes:minutes:readonly` / `minutes:minutes.basic:read` / `minutes:minutes.transcript:export` / `minutes:minutes.artifacts:read` / `offline_access` 均为 `true` |
| **未记录** | access token / refresh token / openId（R7；身份只需证明"user 身份可用"） |

### 1.3 时间

| 动作 | 本地时间（+08:00） |
|---|---|
| 现场复核 pass 1（逐条读取） | 2026-11-14 20:16:49 前后 |
| 现场复核 pass 2（逐条读取） | 2026-11-14 20:17:42 – 20:17:43 |
| `auth status` 身份取样 | 2026-11-14 20:18:18 前后 |
| 临时目录删除并复核不存在 | 2026-11-14 20:19:01 |

---

## 2. 两个 provider artifact（只存 id / 哈希 / 大小）

| # | `minute_token`（provider artifact ID） | 标题 | `note_id`（provider 侧 id） | 字节数 | 行数 | 字符数 | `sha256` |
|---|---|---|---|---|---|---|---|
| 1 | `obcnvf38p9qkb3n58tak57jg` | `audio` | `7682474820169567511` | **6397** | 29 | 2379 | `e17ffd5d95326d8f461ee87a5bdff023e9b5c0cf826df528ce68b55baf2a63a0` |
| 2 | `obcnuym8vvyv328i1y63u956` | `api_sample` | `7682229789491432416` | **4485** | 17 | 1595 | `f3f45d49cca4e478b65a7ce8bf8d0401c2ee7037919d9647cfb25dd9a38c8744` |

- **artifact ID**：`minute_token`（CLI 的 `data.items[].token`）+ `note_id`。
- **revision**：`lark-cli minutes +detail` 未返回版本号字段，本证据**不编造 revision**；
  以内容 `sha256` 作为"这一版转写"的修订标识（两次回读同哈希 = 同一版）。
- 落盘路径形态：`minutes\artifact-<title>-<minute_token>\transcript.txt`（见 `commands.txt` 原文）。

---

## 3. 回读一致性（4 次独立完整回读，逐字节一致）

| 回读 | 执行者 | 时间（+08:00） | token 1 字节/sha256 | token 2 字节/sha256 | 结论 |
|---|---|---|---|---|---|
| **R1** | 任务下达方 | 2026-11-14（本人执行，原始记录） | 6397 / `e17ffd5d…63a0` | 4485 / `f3f45d49…8744` | 一致 |
| **R2** | 任务下达方 | 同上（第二次独立完整回读） | 6397 / `e17ffd5d…63a0` | 4485 / `f3f45d49…8744` | 一致 |
| **R3** | 本 lane 现场复核 | 20:16:49 起 | 6397 / `e17ffd5d…63a0` | 4485 / `f3f45d49…8744` | 一致 |
| **R4** | 本 lane 现场复核 | 20:17:42–20:17:43 | 6397 / `e17ffd5d…63a0` | 4485 / `f3f45d49…8744` | 一致 |

命令原文与逐条度量见 `commands.txt`；正文不落盘本目录。

---

## 4. R7 边界（正文不入库）——本目录实测不含正文

1. **只存度量**：本目录两个文件只含 token / note_id / 字节数 / 行数 / 字符数 / sha256 / 时间 / 命令，
   不含任何转写正文片段、说话人、会议内容。
2. **临时目录即用即删**（现场命令与结果原文）：

```text
TMP=C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-b41cb94c
TMP2=C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-1cc3d0ed
BASE=C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-pass2-81d9594b
REMOVED C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-b41cb94c
REMOVED C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-1cc3d0ed
REMOVED C:\Users\12412\AppData\Local\Temp\ra-feishu-readback-pass2-81d9594b
EXISTS_AFTER ... = False   （三个目录逐个 Test-Path 均为 False）
```

3. **同一纪律**：任何人复跑本证据时必须把 `--output-dir` 指到临时目录，度量完删除；
   **不得**把 `transcript.txt` 复制进仓库、日志、Issue 或聊天记录。

---

## 5. D-1 口径：这次读取是否算 demo gate 合格

D-1（2026-11-12 已批准）= `provenance=LIVE` + `trigger=MANUAL` + **真实 provider artifact ID/revision/hash/readback** ⇒ demo gate 合格；
F2（产品自有 OAuth + 事件自动摄取）立为独立 **P1 gate**，不阻塞 demo。

| 维度 | 本次取值 | 依据（本目录内可复核） |
|---|---|---|
| `provenance` | **LIVE** | 真实飞书 API 返回真实 `minute_token`/`note_id`，转写来自 provider（非 fixture）；两 token 的正文度量见 §2 |
| `trigger` | **MANUAL** | 人工在本机执行 `lark-cli minutes +detail`（§1.1），不是事件自动摄取 |
| `connection` | **NOT_CONNECTED**（产品维度） | 产品没有自有飞书 OAuth / 应用凭据；本次用的是本机开发者 `lark-cli` 的 user 身份。按 `AGENTS.md §7.6`，**开发者全局 CLI profile 不得作为产品连接器凭据** |
| provider artifact ID | **有** | `obcnvf38p9qkb3n58tak57jg` / `obcnuym8vvyv328i1y63u956`（+ note_id） |
| revision | **见 §2 说明** | CLI 未返回 revision；以 sha256 作为同一版的内容标识（不编造版本号） |
| hash | **有** | 两个 64 位 sha256（§2），两次回读一致 |
| readback | **有** | 4 次独立完整回读，逐字节一致（§3） |

**判定**：按 D-1，**这四样齐备 ⇒ demo gate 的 LIVE 读取条件成立**。
但必须同时标注边界：**产品自有 OAuth + 事件自动摄取（F2）= `AUTH_REQUIRED`，属 P1，未完成**；
`connection=NOT_CONNECTED` 是诚实标签，不得因为"CLI 能读"就写成 CONNECTED（R4）。

---

## 6. 复现

```powershell
lark-cli auth status
$tmp = Join-Path $env:TEMP ("ra-feishu-readback-" + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory $tmp | Out-Null
Push-Location $tmp
lark-cli minutes +detail --as user --minute-tokens obcnvf38p9qkb3n58tak57jg --transcript --output-dir ./minutes
lark-cli minutes +detail --as user --minute-tokens obcnuym8vvyv328i1y63u956 --transcript --output-dir ./minutes
# 度量（只打度量，不给正文）
Get-ChildItem $tmp -Recurse -Filter transcript.txt | ForEach-Object {
  "{0} bytes={1} sha256={2}" -f $_.FullName, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower()
}
Pop-Location
Remove-Item -Recurse -Force $tmp   # R7：用完即删
```

期望：两个文件的 `bytes` 与 `sha256` 与 §2 表格完全一致（6397 / `e17ffd5d…`；4485 / `f3f45d49…`）。
