# 飞书 Minutes Connector（线 2）· 契约 + 适配器 + Lark CLI 传输层

> **LIVE Gate = `BLOCKED`。**
> 本机没有真实飞书应用 / 用户授权，本轮也**不允许**寻找或伪造凭据。
> 传输层**已实现**（`lark-cli-transport`），但「实现了传输层」≠「拿到了 LIVE」：
> 没有真实回读，就没有 `LIVE`，也没有 `CONNECTED`。任何出口的 `provenance`
> 只可能是 `FIXTURE`，`connection` 只可能是 `NOT_CONNECTED` 或 `AUTH_REQUIRED`。

- 契约版本：`FEISHU_MINUTES_CONTRACT_VERSION = '1.0.0'`
- 权威合同：`contracts/interview/transcript-rules.md` §2 / §5 / §8（只读）、`tool-contracts.md §1.4`
- 依据：`docs/04-connectors-and-transcript.md` §13（飞书字段、事件、错误码）
- 证据：`test/unit/transcript-feishu.test.ts`（诚实性机检 18 条）、
  `test/unit/transcript-feishu-transport.test.ts`（传输层 27 条，含真实子进程假 CLI）、
  `manual/transcript-line/feishu-probe.mjs`（手工探测）

## 1. 现在是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 端点 / 分页 / 权限点 / 事件 / 错误码的**字符串契约** | 一个能取数的**产品级** Connector（没有真实凭据） |
| 凭据**存在性**检查（只布尔，不打印值） | OAuth 流程、令牌刷新、`CONNECTED` 判定 |
| `2091003 → WAITING_EXTERNAL`、`2091005 → AUTH_REQUIRED` 的纯函数映射 | 重试调度器 / `business_task` 写入（那属业务层） |
| **Lark CLI 传输层**：子进程 + 超时 + 指数退避 + 分页 + 回执 + 脱敏诊断 | HTTP 传输（`http-transport` 仍未实现） |
| 三维标签的**唯一口径**与诚实性闸门 | 任何 `LIVE` 数据（本轮没有真实回读） |

## 2. 文件

| 文件 | 职责 |
|---|---|
| `contract.ts` | 纯常量 / 类型 / 纯函数：端点、CLI、分页、scope、事件、错误码、绑定键、`mapFeishuError()` |
| `labels.ts` | 三维标签：`buildConnectorLabels()`、`buildArtifactLabelsFromReadback()`、`triggerModeForEvent()` |
| `transport.ts` | **`lark-cli-transport`**：调 Lark CLI 读全文、分页、重试、超时、回执、诊断脱敏 |
| `adapter.ts` | `describe()` / `probe()` / `fetchTranscript()` / `mapProviderError()` / `subscriptionNotes()` |
| `index.ts` | 唯一出口（显式逐个导出） |

**外部出口只有一处**：只有 `transport.ts` 允许 `import 'node:child_process'`；
其余文件零 I/O（`adapter.ts` 不 import 子进程，传输层靠调用方注入）。静态扫描机检：
连接器任何文件都不许出现 `fetch(` / `node:http(s)` / `node:net` / `undici` / `require(`，
且只有 `transport.ts` 一个文件命中子进程形态。

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
| `minutes.minute.generated_v1` | `USER`（**不能默认 Bot 也能订阅**） | 可以；给 `minute_token` + `minutes.source_entity_id`(Meeting ID) + `event_id` |
| `vc.recording.recording_transcript_generated_v1` | `UNSPECIFIED`（文档未写，不假设） | **不可以**：转写片段事件，不带完整 Meeting 关联 |

**错误码**（`FEISHU_PROVIDER_ERRORS`；两者都**不建 artifact**，P-3 / TR-C7）

| 码 | 语义 | 系统动作 |
|---|---|---|
| `2091003` | 产物仍在生成 | `business_task(WAITING_EXTERNAL)`，等新事件或人工重试 |
| `2091005` | 无读取权限 | `business_task(WAITING_HUMAN)` + `error_code='AUTH_REQUIRED'`，保留原任务，重授权后从原 attempt 继续 |
| 其它 | 未核对 | `kind='UNKNOWN'` + `WAITING_HUMAN`：不猜语义、不自动重试、不建 artifact |

**没有别名表**：任何别的码（包括看起来同族的）都走 `UNKNOWN`，不推断——`docs/04 §13` 只给了上面两个。

## 4. 传输层（`lark-cli-transport`）

结构照抄 `dsh-superagent-prototype/src/sources/feishu-loops.ts` + `infra/commands.ts` 的
四段循环（读 → 判 → 重试 → 报错），**不抄**它的工单/线程领域逻辑。

| 项 | 取值 / 行为 |
|---|---|
| 命令 | `FEISHU_LARK_CLI.minutesDetailTranscript` 拆成 argv（`buildTranscriptArgs()`，不另写一份） |
| 可执行文件 | **由调用方显式配置**（`createProcessCliRunner({ command })`），不读全局 profile（`AGENTS.md §7.6`） |
| 超时 | 默认 `180_000 ms`（`FEISHU_CLI_DEFAULT_TIMEOUT_MS`），可配置；超时 SIGTERM，5 s 后 SIGKILL |
| 重试 | 默认最多 3 次（含首次），指数退避 1 s → 2 s（上限 30 s）。**只重试传输抖动** |
| 不重试 | CLI 找不到 / 不可执行、输出形状不认识、分页缺陷、回执自检失败、`2091005` 无权限 |
| 分页 | `has_more` / `page_token` / `page_size`；用 `isPageComplete()` 判完；游标不前进 → `PAGINATION_STALLED`；页数上限 200 |
| 回执 | `read_receipt_ref = lark:minutes+detail:<minute_token>@<revision>`；缺 `revision` **直接失败**，不补默认值 |
| 完整性 | 只有分页全部走完（`has_more=false` 且无残留游标）才 `is_complete=true` |
| 「生成中」 | `2091003`（`ok:false` 或非零退出的 stderr）→ `WAITING_EXTERNAL`，**不算失败**、不重试 |
| 诊断 | 失败 message 点名 `stage` ∈ {`locate-cli`,`invoke`,`parse`,`paginate`,`validate`} + `code` + 原始退出码 + stderr 前 512 字节 |
| 脱敏（R7） | stderr 只外传**脱敏切片**：JSON 的 content-bearing 键抹成 `<redacted>`、≥8 字连续中文抹成 `[redacted:cjk]`、≥64 字符 blob 抹成 `[redacted:blob]`；**正文、argv、平台 `msg` 永不出现** |

**未核实的部分（机器可读）**：`transport.describe()` 里 `argument_flags_verified: false`、
`envelope_verified: false`。参数名 `--minute-token` / `--page-size` / `--page-token` 与
`{ok, data, error:{code,message}}` 信封都是按 lark-cli 既有习惯推断的，
接真实 CLI 前必须用 `lark-cli minutes +detail --help` 逐字核对。

## 5. 三维标签规则（R4，唯一口径）

| `connection` | `provenance` | `trigger` | 说明 |
|---|---|---|---|
| `NOT_CONNECTED` | `FIXTURE` | `MANUAL` | 无应用凭据：没有真实字节 |
| `AUTH_REQUIRED` | `FIXTURE` | `MANUAL` | 有应用凭据缺用户令牌、令牌存在但未验证、或传输层未装配 |
| `CONNECTED` | `LIVE` | `EVENT` / `MANUAL` | **只有** `buildArtifactLabelsFromReadback()` 成功路径可达（Gate 解锁后才可能） |

- `labels.provenance === 'LIVE'` 在 `buildConnectorLabels()` 里**直接抛** `LABEL_DISHONEST_LIVE`
  （连接状态本身不是 LIVE 依据）；`trigger` 在无连接时被强制 `MANUAL`（TR-S6）。
- LIVE 的六项证据：`transport='FEISHU_MINUTES_API'`、`read_receipt_ref` 匹配
  `/^lark:minutes\+detail:/`、`fetched_at` 是带偏移的合法 ISO-8601、`content_sha256` 64 位小写 hex、
  `is_complete === true`、`raw_text` 非空；外加 `trigger ∈ {EVENT, MANUAL}`。
  缺一项 → `LABEL_DISHONEST_LIVE`。
- **传输层不产 LIVE**：Gate=BLOCKED 时 `readbackTransport()` 恒返回 `FIXTURE`，
  所以哪怕 CLI 读成功，回读对象也过不了上面那六项（`transport` 一项就不对）。
  本机没有真实凭据，无法证明 CLI 输出的字节来自飞书平台（可能是假 CLI / 回放）。
- `EVENT` 只认：`kind='WEBHOOK_EVENT'` + `verified === true` + 事件 ID 非空。
  **webhook payload 不是逐字稿**（TR-S7，`REQUEST_BODY_IS_TRANSCRIPT = false`）。

## 6. 为什么 `LIVE` / `CONNECTED` 现在不可达

`probe()` 的四条分支都不允许 `CONNECTED`：

1. 无 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` → `NOT_CONNECTED` / `NO_APP_CREDENTIALS`；
2. 有应用凭据、无用户令牌 → `AUTH_REQUIRED` / `USER_IDENTITY_REQUIRED`
   （妙记事件是 user identity，Bot / 租户身份不能代替）；
3. 有用户令牌但**没装配传输层** → `AUTH_REQUIRED` / `TOKEN_PRESENT_UNVERIFIED`
   （默认状态：`transport_configured=false`）；
4. 有用户令牌 + 传输层已装配 → 仍要**一次真实成功的回读**才能谈 CONNECTED；
   在那之前 `live_eligible` 恒 `false`。

`fetchTranscript()` 有四种出口，**每一种都不产 LIVE**：

| `kind` | 何时 | 关键字段 |
|---|---|---|
| `ERROR` | 缺 `minute_token` | `error_code='INVALID_ARGS'`、`reason_code='MINUTE_TOKEN_REQUIRED'` |
| `BLOCKED` | 凭据 / 传输层 / 读取任何一环不成立 | `blocked_reason`（见下）、`creates_artifact=false`、无正文 |
| `WAITING_EXTERNAL` | 平台 `2091003` | `task_state='WAITING_EXTERNAL'`、`creates_artifact=false` |
| `READ` | 真的读到了正文 | `live_eligible=false`、`provenance_basis='NO_LIVE_READ'`、`readback.transport='FIXTURE'` |

`blocked_reason` 闭集（新增必须写进本表）：

| 值 | 含义 |
|---|---|
| `NO_APP_CREDENTIALS` | 连应用凭据都没有 |
| `USER_IDENTITY_REQUIRED` | 缺用户令牌（妙记是 user identity） |
| `TOKEN_PRESENT_UNVERIFIED` | 令牌在，但还没有一次真实成功的回读 |
| `TRANSPORT_NOT_CONFIGURED` | 传输层没装配（本机默认）；**不会拉起任何进程** |
| `CLI_UNAVAILABLE` | 找不到 / 不可执行 / 起不来 CLI（`locate-cli` 失败） |
| `CLI_TIMEOUT` | CLI 调用超时，重试也超时 |
| `CLI_FAILED` | 非零退出且诊断里没有已核对错误码 |
| `PROVIDER_NO_PERMISSION` | 平台 `2091005`，需要人重新授权（`error_code='AUTH_REQUIRED'`） |
| `READ_PARSE_FAILED` | 输出信封 / 正文形状不认识（fail-closed，绝不猜） |
| `PAGINATION_INCOMPLETE` | 分页没走完 / 游标不前进 / 超页数 |
| `READBACK_INVALID` | 回执、`revision`、正文自检不过（含平台回显了别的 `minute_token`） |

传输层失败时还会带 `failure: { stage, code, attempts, exit_code }`，方便运维定位。

## 7. LIVE Gate 解锁条件（三件同时成立）

1. **真实 app 凭据**：飞书自建应用的 App ID / App Secret（只放进程环境变量，不进文件与日志）；
2. **用户 OAuth（含 `offline_access`）**：`minutes.minute.generated_v1` 是 user identity 订阅；
3. **一次真实 `minute_token` 完整回读**：拿到 `read_receipt_ref`（`lark:minutes+detail:*`）、
   `content_sha256`、`is_complete=true` 与非空 `raw_text`，且分页取完（`has_more=false`）。

三件缺一，`describe().live_gate` 保持 `BLOCKED`、`live_eligible` 保持 `false`。

解锁动作（**必须由人做，且要改代码 + 改本节**）：

1. 用 `lark-cli minutes +detail --help` 核对 `FEISHU_CLI_TRANSCRIPT_FLAGS` 与信封形状，
   把 `transport.describe()` 的 `argument_flags_verified` / `envelope_verified` 改成真实结论；
2. 改 `contract.ts` 的 `FEISHU_MINUTES_LIVE_GATE`（连同本节与测试）；
3. 只有这时 `readbackTransport()` 才会返回 `FEISHU_MINUTES_API`，`buildArtifactLabelsFromReadback()` 才可能给 LIVE。

## 8. 用法

```js
import {
  createFeishuMinutesAdapter,
  createLarkCliTransport,
  createProcessCliRunner,
} from './index.ts'

// 1) 默认形态：不装配传输层 → fetchTranscript 只会说「传输层没装配」，不碰任何进程。
const adapter = createFeishuMinutesAdapter({})
adapter.describe()            // { implemented:[…,'lark-cli-transport'], not_implemented:['http-transport','oauth-flow','event-subscription'], live_gate:'BLOCKED' }
adapter.probe()               // { connection_state, labels, blocked_reason, transport_configured:false, … }

// 2) 要用真实读取：显式给 CLI 的**绝对路径**（不得用 PATH 上的全局 lark-cli 当产品凭据）。
const transport = createLarkCliTransport({
  runner: createProcessCliRunner({ command: '/opt/lark-cli/lark-cli' }),
  timeout_ms: 180_000,
  max_attempts: 3,
})
const wired = createFeishuMinutesAdapter({ transport })
await wired.fetchTranscript({ minute_token, external_meeting_id })
// → { kind:'BLOCKED' | 'WAITING_EXTERNAL' | 'READ', … }；READ 也不会是 LIVE。
```

真实输出（本机无凭据，`node manual/transcript-line/feishu-probe.mjs`，省略 `next_steps`）：

```json
{ "connection_state": "NOT_CONNECTED",
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "provenance_basis": "NO_LIVE_READ", "live_eligible": false,
  "transport_configured": false,
  "blocked_reason": "NO_APP_CREDENTIALS", "missing": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] }
```

```
LIVE_GATE=BLOCKED
```

### 8.1 工具接线（E4，2026-11-14）

连接器不再是「库里的死代码」：`src/tools/transcript-import.ts` 已 import 本包唯一出口，
`recruitment_transcript_import` 多了一条**连接器回读**路径。

| 项 | 取值 / 行为 |
|---|---|
| 触发条件 | 调用方**不给** `content`，给 `minute_token`（可加 `external_meeting_id` 按平台会议 id 消歧） |
| 正文来源 | `createFeishuMinutesAdapter(...).fetchTranscript()`；`READ` 之外全部抛 `BLOCKED`（零 artifact） |
| 传输层装配 | **只**来自插件配置 `config.feishu.cli`（lark-cli 的**绝对路径**）；`wiring.ts` 不读 PATH / 环境变量取 CLI |
| 默认态 | 没给 `feishu.cli` → 不装配传输层 → `BLOCKED / TRANSPORT_NOT_CONFIGURED`（不拉子进程、不建库连接、不写任何行） |
| 落库标签 | `provenance=FIXTURE`、`trigger=MANUAL`、`connection∈{NOT_CONNECTED, AUTH_REQUIRED}`；`provenance_basis=FEISHU_READBACK_NO_LIVE_GATE`；附 `FEISHU_READBACK_NOT_LIVE`；**永不 LIVE / CONNECTED** |
| 会议约束 | 只接受 `provider=FEISHU` 的会议（否则 `INVALID_ARGS/SOURCE_CONNECTOR_MISMATCH`）；`external_meeting_id` 必须精确匹配 active 绑定 |
| 装配配置 | `feishu: { cli: '<绝对路径>', timeout_ms?, max_attempts?, retry_base_ms?, page_size?, max_pages? }`（见 `wiring.ts`） |

即使装配了传输层，Gate 仍是 `BLOCKED`：回读对象 `transport=FIXTURE`，工具侧把任何
`LIVE/CONNECTED` 自报**降级**成 `FIXTURE/AUTH_REQUIRED`（`connectorReadbackLabels()`）。
要允许 LIVE，必须先按 §7 解锁 Gate 并显式改工具侧代码——不能靠调用方传参。

## 9. 不做的事

- 不下载 / 不转存音视频，只认 `provider_artifact_id` 与访问引用（TR-S8）；
- 不把 webhook payload 当逐字稿，不猜会议、不按标题 / 时间 / 参会人绑定（TR-S7、TR-L3）；
- 不在错误里回显平台 `msg`、argv 或正文（R7）；
- **不发 HTTP 请求**（`http-transport` 仍是 `not_implemented`）；
- **默认不调用 Lark CLI**：只有调用方显式注入 runner 才会跑子进程。

## 10. 验证

```powershell
cd dsh\dsh-recruitment
node --test "test/unit/transcript-feishu.test.ts"            # 18/18（诚实性机检）
node --test "test/unit/transcript-feishu-transport.test.ts"  # 27/27（传输层，含真实子进程假 CLI）
node --test "test/unit/transcript-feishu-wiring.test.ts"     # 14/14（接线：配置→适配器→传输层 / 默认 BLOCKED / 注册入口可达）
node --test "test/integration/transcript-import.test.ts"     # 连接器回读：blocked 零写入 + fake CLI 成功但只标 FIXTURE
node manual/transcript-line/feishu-probe.mjs                 # 末尾 LIVE_GATE=BLOCKED，退出码 0
```
