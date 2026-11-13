# 飞书 Minutes Connector（线 2）· 契约 + 适配器骨架

> **LIVE Gate = `BLOCKED`。**
> 本机没有真实飞书应用 / 用户授权，本轮也**不允许**寻找或伪造凭据。
> 这里交付的是**可判定的契约**与**不会说谎的骨架**：没有真实回读，就没有 `LIVE`，
> 也没有 `CONNECTED`。任何出口都只可能是 `NOT_CONNECTED` 或 `AUTH_REQUIRED`。

- 契约版本：`FEISHU_MINUTES_CONTRACT_VERSION = '1.0.0'`
- 权威合同：`contracts/interview/transcript-rules.md` §2 / §5 / §8（只读）、`tool-contracts.md §1.4`
- 依据：`docs/04-connectors-and-transcript.md` §13（飞书字段、事件、错误码）
- 证据：`test/unit/transcript-feishu.test.ts`（诚实性机检）、`manual/transcript-line/feishu-probe.mjs`

## 1. 现在是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 端点 / 分页 / 权限点 / 事件 / 错误码的**字符串契约** | 一个能取数的 Connector |
| 凭据**存在性**检查（只布尔，不打印值） | OAuth 流程、令牌校验、HTTP 传输、Lark CLI 调用 |
| `2091003 → WAITING_EXTERNAL`、`2091005 → AUTH_REQUIRED` 的纯函数映射 | 重试调度器 / `business_task` 写入（那属业务层） |
| 三维标签的**唯一口径**与诚实性闸门 | 任何 `LIVE` 数据（本轮没有真实回读） |

## 2. 文件

| 文件 | 职责 |
|---|---|
| `contract.ts` | 纯常量 / 类型 / 纯函数：端点、CLI、分页、scope、事件、错误码、绑定键、`mapFeishuError()` |
| `labels.ts` | 三维标签：`buildConnectorLabels()`、`buildArtifactLabelsFromReadback()`、`triggerModeForEvent()` |
| `adapter.ts` | 骨架：`describe()` / `probe()` / `fetchTranscript()` / `mapProviderError()` / `subscriptionNotes()` |
| `index.ts` | 唯一出口（显式逐个导出） |

零 I/O：不 import HTTP / 套接字 / 子进程模块，不调用取数函数。测试对这组文件做静态扫描。

## 3. 契约表

**CLI（已核对，`docs/04 §13` 逐字「直接复用 Lark CLI（MIT）」）**

| 常量 | 值 | 用途 |
|---|---|---|
| `FEISHU_LARK_CLI.minutesDetailTranscript` | `minutes +detail --transcript` | 取全文；能处理「生成中」 |
| `FEISHU_LARK_CLI.vcRecording` | `vc +recording` | 有 Meeting ID 无 `minute_token` 时反查 |

**HTTP 端点（未核实 / 骨架占位，编码前必须在官方 API Explorer 复核）**

| 键 | 路径 |
|---|---|
| `minutes.detail` | `/open-apis/minutes/v1/minutes/{minute_token}` |
| `minutes.transcript` | `/open-apis/minutes/v1/minutes/{minute_token}/transcript` |
| `vc.recording.list` | `/open-apis/vc/v1/recordings` |

`docs/04 §13` 对飞书只给了 CLI 形态，没有给 HTTP 路径；`FEISHU_MINUTES_ENDPOINT_NOTES` 逐个标了「未核实」。

**分页**：`has_more` / `page_token` / `page_size`（`FEISHU_MINUTES_PAGINATION`，同样未核实）；
`isPageComplete(page)` 只认 `has_more === false` 且没有下一页游标（TR-C2）。

**权限点**（`FEISHU_MINUTES_SCOPES`，未核实）：`minutes:minutes:readonly`、
`minutes:minutes.transcript:readonly`、`offline_access`（用户 OAuth 刷新所需）。

**事件**

| 事件 | 身份 | 能作批量归档的唯一依据？ |
|---|---|---|
| `minutes.minute.generated_v1` | `USER`（**不能默认 Bot 也能订阅**） | 可以；给 `minute_token` + `minute_source.source_entity_id`(Meeting ID) + `event_id` |
| `vc.recording.recording_transcript_generated_v1` | `UNSPECIFIED`（文档未写，不假设） | **不可以**：转写片段事件，不带完整 Meeting 关联 |

**错误码**（`FEISHU_PROVIDER_ERRORS`；两者都**不建 artifact**，P-3 / TR-C7）

| 码 | 语义 | 系统动作 |
|---|---|---|
| `2091003` | 产物仍在生成 | `business_task(WAITING_EXTERNAL)`，等新事件或人工重试 |
| `2091005` | 无读取权限 | `business_task(WAITING_HUMAN)` + `error_code='AUTH_REQUIRED'`，保留原任务，重授权后从原 attempt 继续 |
| 其它 | 未核对 | `kind='UNKNOWN'` + `WAITING_HUMAN`：不猜语义、不自动重试、不建 artifact |

**没有别名表**：任何别的码（包括看起来同族的）都走 `UNKNOWN`，不推断——`docs/04 §13` 只给了上面两个。

## 4. 三维标签规则（R4，唯一口径）

| `connection` | `provenance` | `trigger` | 说明 |
|---|---|---|---|
| `NOT_CONNECTED` | `FIXTURE` | `MANUAL` | 无应用凭据：没有真实字节 |
| `AUTH_REQUIRED` | `FIXTURE` | `MANUAL` | 有应用凭据缺用户令牌，或令牌存在但未验证 |
| `CONNECTED` | `LIVE` | `EVENT` / `MANUAL` | **只有** `buildArtifactLabelsFromReadback()` 成功路径可达 |

- `labels.provenance === 'LIVE'` 在 `buildConnectorLabels()` 里**直接抛** `LABEL_DISHONEST_LIVE`
  （连接状态本身不是 LIVE 依据）；`trigger` 在无连接时被强制 `MANUAL`（TR-S6）。
- LIVE 的六项证据：`transport='FEISHU_MINUTES_API'`、`read_receipt_ref` 匹配
  `/^lark:minutes\+detail:/`、`fetched_at` 是带偏移的合法 ISO-8601、`content_sha256` 64 位小写 hex、
  `is_complete === true`、`raw_text` 非空；外加 `trigger ∈ {EVENT, MANUAL}`。
  缺一项 → `LABEL_DISHONEST_LIVE`（Fixture / webhook payload / 缺回执 / 未取完分页都过不去）。
- `EVENT` 只认：`kind='WEBHOOK_EVENT'` + `verified === true` + 事件 ID 非空。
  **webhook payload 不是逐字稿**（TR-S7，`REQUEST_BODY_IS_TRANSCRIPT = false`）。

## 5. 为什么 `LIVE` / `CONNECTED` 现在不可达

`probe()` 的三条分支都不允许 `CONNECTED`：

1. 无 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` → `NOT_CONNECTED` / `NO_APP_CREDENTIALS`；
2. 有应用凭据、无用户令牌 → `AUTH_REQUIRED` / `USER_IDENTITY_REQUIRED`
   （妙记事件是 user identity，Bot / 租户身份不能代替）；
3. 有用户令牌（甚至租户令牌）→ **仍** `AUTH_REQUIRED` / `TOKEN_PRESENT_UNVERIFIED`：
   骨架没有传输层，**无法验证令牌**，所以不得据此宣称 `CONNECTED`。

`fetchTranscript()` 永远返回 `{kind:'BLOCKED', creates_artifact:false}`（缺 `minute_token` 时返回
`INVALID_ARGS / MINUTE_TOKEN_REQUIRED`）：不返回正文、不返回伪造 artifact、不回声令牌。

## 6. LIVE Gate 解锁条件（三件同时成立）

1. **真实 app 凭据**：飞书自建应用的 App ID / App Secret（只放进程环境变量，不进文件与日志）；
2. **用户 OAuth（含 `offline_access`）**：`minutes.minute.generated_v1` 是 user identity 订阅；
3. **一次真实 `minute_token` 完整回读**：拿到 `read_receipt_ref`（`lark:minutes+detail:*`）、
   `content_sha256`、`is_complete=true` 与非空 `raw_text`，且分页取完（`has_more=false`）。
   传输层首选 `FEISHU_LARK_CLI` 的两个命令（Lark CLI，MIT）。

三件缺一，`describe().live_gate` 保持 `BLOCKED`、`live_eligible` 保持 `false`。

## 7. 用法

```js
import { createFeishuMinutesAdapter } from './index.ts'

const adapter = createFeishuMinutesAdapter({}) // env 缺省 process.env
adapter.describe()            // { connector, contract_version, implemented, not_implemented, live_gate:'BLOCKED' }
adapter.probe()               // { connection_state, labels, provenance_basis, live_eligible, blocked_reason, missing, next_steps, credentials }
adapter.fetchTranscript({ minute_token, external_meeting_id }) // 恒 BLOCKED / INVALID_ARGS，无正文
adapter.mapProviderError('2091005') // { kind:'NO_PERMISSION', task_state:'WAITING_HUMAN', error_code:'AUTH_REQUIRED', creates_artifact:false }
adapter.subscriptionNotes()   // 事件订阅注记：user identity / 片段事件不可单独作依据 / webhook 不是逐字稿
```

真实输出（本机无凭据，`node manual/transcript-line/feishu-probe.mjs`，省略 `next_steps`）：

```json
{ "connection_state": "NOT_CONNECTED",
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "provenance_basis": "NO_LIVE_READ", "live_eligible": false,
  "blocked_reason": "NO_APP_CREDENTIALS", "missing": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] }
```

## 8. 不做的事

- 不下载 / 不转存音视频，只认 `provider_artifact_id` 与访问引用（TR-S8）；
- 不把 webhook payload 当逐字稿，不猜会议、不按标题 / 时间 / 参会人绑定（TR-S7、TR-L3）；
- 不在错误里回显平台 `msg`（可能带租户内容，R7）；
- 不调用 Lark CLI、不发起任何请求（本轮只做契约 + 骨架）。

## 9. 验证

```powershell
cd dsh\dsh-recruitment
node --test "test/unit/transcript-feishu.test.ts"   # 18/18
node manual/transcript-line/feishu-probe.mjs        # 末尾 LIVE_GATE=BLOCKED，退出码 0
```
