# 飞书 Minutes Connector（线 2）· 契约 + 适配器 + Lark CLI 传输层

> **LIVE Gate = `EVIDENCE_DRIVEN`（口径名，不是开/关常量）。**
> 每次读取由 `evaluateLiveGate()` 按**本次回读证据**算出 `LIVE | BLOCKED`：
> 平台通道 + `read_receipt_ref` 绑定内容哈希 + `content_sha256` 与 `raw_text`
> 重算一致（+ 可选重读哈希一致）+ 带偏移 `fetched_at` + 完整分页 + 非空正文 +
> `MANUAL|EVENT`。全齐才 `LIVE`；缺任何一项就 `BLOCKED`，并逐条点名缺什么。
> 回读对象自相矛盾（哈希不一致）是**失败**，不是警告。
>
> `platform_channel=false`（默认：单测 / 回放通道）时回读 `transport` 恒 `FIXTURE`，
> 读成功也不可能 LIVE；只有接线层（插件配置 `feishu.cli` 绝对路径）装配的
> transport 才是平台通道，且要做两次完整回读的重读校验。

- 契约版本：`FEISHU_MINUTES_CONTRACT_VERSION = '1.0.0'`
- 权威合同：`contracts/interview/transcript-rules.md` §2 / §5 / §8（只读）、`tool-contracts.md §1.4`
- 依据：`docs/04-connectors-and-transcript.md` §13（飞书字段、事件、错误码）、**D-1**（2026-11-12 批准：`provenance=LIVE` + `trigger=MANUAL` + 真实 provider artifact ID / revision / hash / readback = demo gate 合格；产品自有 OAuth 属 P1，不阻塞 demo）
- 证据：`test/unit/transcript-feishu.test.ts`（诚实性机检）、
  `test/unit/transcript-feishu-transport.test.ts`（传输层，含真实子进程假 CLI 与重读校验）、
  `test/unit/transcript-feishu-wiring.test.ts`（接线）、`test/integration/transcript-import.test.ts`（落库标签）、
  `manual/transcript-line/feishu-probe.mjs`（手工探测）

## 1. 现在是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 端点 / 分页 / 权限点 / 事件 / 错误码的**字符串契约** | 一个自带 OAuth 的产品级 Connector（F2 属 **P1**） |
| 凭据**存在性**检查（只布尔，不打印值） | OAuth 流程、令牌刷新（`probe()` 不会仅凭令牌存在就 CONNECTED） |
| `2091003 → WAITING_EXTERNAL`、`2091005 → AUTH_REQUIRED` 的纯函数映射 | 重试调度器 / `business_task` 写入（那属业务层） |
| **Lark CLI 传输层**：子进程 + 超时 + 指数退避 + 分页 + 回执 + **重读校验** + 脱敏诊断 | HTTP 传输（`http-transport` 仍未实现） |
| 三维标签的**唯一口径**与证据闸门：`evaluateLiveGate()` 逐项核对 | 「全局 Gate 已开」这种一维开关 |

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
| 回执 | `read_receipt_ref = lark:minutes+detail:<minute_token>@sha256:<content_sha256>`：**绑到这次读到的字节**；缺 `revision` 仍直接失败，不补默认值（revision 另存 `readback.revision` 供回溯） |
| 重读校验 | `platform_channel=true` 时再**完整读一次**：两次 `content_sha256` / `revision` 必须一致；不一致 → `READBACK_INVALID` 失败（不产出正文）；一致才写 `reread_sha256` |
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
| `AUTH_REQUIRED` | `FIXTURE` | `MANUAL` | 有应用凭据缺用户令牌、令牌存在但未验证、传输层未装配、或证据不齐 |
| `CONNECTED` | `LIVE` | `EVENT` / `MANUAL` | **只有** `evaluateLiveGate()` 的 `LIVE` 路径可达（证据全齐） |

- `labels.provenance === 'LIVE'` 在 `buildConnectorLabels()` 里**直接抛** `LABEL_DISHONEST_LIVE`
  （连接状态本身不是 LIVE 依据）；`trigger` 在无连接时被强制 `MANUAL`（TR-S6）。
- **LIVE 的唯一判定**：`evaluateLiveGate(readback)`（`labels.ts`）。证据项见 `LIVE_EVIDENCE_ITEMS`：
  1. `transport='FEISHU_MINUTES_API'`（平台通道，不是 FIXTURE / webhook payload）；
  2. `read_receipt_ref` 形如 `lark:minutes+detail:<minute_token>@sha256:<64位hex 或前12位>`；
  3. `content_sha256` 64 位小写 hex；
  4. **回读哈希一致**：用 `raw_text` 重新算出的 sha256 必须等于 `content_sha256`；回执摘要必须
     等于 `content_sha256`（64 位全等 / 12 位前缀相等）；若带回 `reread_sha256`（第二次独立完整回读）
     也必须逐字相等。**任何一处不等 = 失败**（适配器 / 工具直接 `BLOCKED / READBACK_INVALID`），
     不是「警告后照样标 LIVE」；
  5. `fetched_at` 是**带时区偏移**的合法 ISO-8601（`2026-02-30` 这种日历越界也不收）；
  6. `is_complete === true`（分页全部取完，TR-C2/TR-C4）；
  7. `raw_text` 非空（P-2）；
  8. `trigger ∈ {EVENT, MANUAL}`。
  缺任何一项 → `gate='BLOCKED'`，`violations` 逐条写清缺什么；不压平成「全局 Gate 没开」。
- **传输层不产假 LIVE**：默认 `platform_channel=false`（单测 / 回放）时 `readback.transport`
  恒 `FIXTURE`；只有接线层声明平台通道、且两次完整回读一致，回读才可能过上面全部证据项。
- `EVENT` 只认：`kind='WEBHOOK_EVENT'` + `verified === true` + 事件 ID 非空。
  **webhook payload 不是逐字稿**（TR-S7，`REQUEST_BODY_IS_TRANSCRIPT = false`）。

## 6. `probe()` / `fetchTranscript()` 的出口（标签按证据算）

`probe()` 四条分支都不允许 `CONNECTED`（没有回读就没有证据）：

1. 无 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` → `NOT_CONNECTED` / `NO_APP_CREDENTIALS`；
2. 有应用凭据、无用户令牌 → `AUTH_REQUIRED` / `USER_IDENTITY_REQUIRED`
   （妙记事件是 user identity，Bot / 租户身份不能代替）；
3. 有用户令牌但**没装配传输层** → `AUTH_REQUIRED` / `TOKEN_PRESENT_UNVERIFIED`
   （默认状态：`transport_configured=false`）；
4. 有用户令牌 + 传输层已装配 → 仍是 `TOKEN_PRESENT_UNVERIFIED`：
   **一次证据齐全的真实回读**才在 `fetchTranscript().kind='READ'` 出口给 `CONNECTED`。

`fetchTranscript()` 有四种出口：

| `kind` | 何时 | 关键字段 |
|---|---|---|
| `ERROR` | 缺 `minute_token` | `error_code='INVALID_ARGS'`、`reason_code='MINUTE_TOKEN_REQUIRED'` |
| `BLOCKED` | 凭据 / 传输层 / 读取任何一环不成立；或回读对象自相矛盾 | `blocked_reason`（见下）、`creates_artifact=false`、无正文 |
| `WAITING_EXTERNAL` | 平台 `2091003` | `task_state='WAITING_EXTERNAL'`、`creates_artifact=false` |
| `READ` | 真的读到了正文 | `live_gate='LIVE'|'BLOCKED'`、`live_eligible`、`live_gate_violations`；LIVE 时 `labels=LIVE/MANUAL/CONNECTED` |


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
| `READBACK_INVALID` | 回执、`revision`、正文自检不过；**重读校验不一致**；或回读对象自相矛盾（`content_sha256` / `read_receipt_ref` / `reread_sha256` 与 `raw_text` 对不上） |

传输层失败时还会带 `failure: { stage, code, attempts, exit_code }`，方便运维定位。
回读对象自相矛盾时走 `BLOCKED / READBACK_INVALID`（**不**降级成 FIXTURE 继续写库）。

## 7. LIVE 证据（`EVIDENCE_DRIVEN`；不是「解锁开关」）

不再有「把 `BLOCKED` 改成别的值」这一步。每一次读取都按下面的证据算：

| # | 证据 | 判定 |
|---|---|---|
| 1 | 平台通道 | `transport === 'FEISHU_MINUTES_API'`；FIXTURE / WEBHOOK_PAYLOAD 一律不行 |
| 2 | 读取回执 | `lark:minutes+detail:<minute_token>@sha256:<64位hex|前12位>`，且摘要绑定 `content_sha256` |
| 3 | 内容哈希 | `content_sha256` 64 位小写 hex，且 = `sha256(raw_text)`（重新读取一致） |
| 4 | 重读校验 | 有 `reread_sha256` 时必须 = `content_sha256`；平台通道在 `read()` 里真实重读，不一致直接 `READBACK_INVALID` |
| 5 | 回读时刻 | `fetched_at` 带时区偏移、日历合法 |
| 6 | 完整性 | `is_complete === true`（分页取完，`has_more=false`） |
| 7 | 正文 | `raw_text` 非空 |
| 8 | 触发 | `trigger ∈ {EVENT, MANUAL}`（CLI 回读恒 `MANUAL`） |

全齐 → `{provenance:'LIVE', trigger:'MANUAL', connection:'CONNECTED'}`，
`provenance_basis='LIVE_READBACK_VERIFIED'`；缺一项 → `BLOCKED` + 逐条缺项。
**`describe().live_gate` 恒为口径名 `EVIDENCE_DRIVEN`**，不随某一次读取变化。

落地到 `transcript_import`（D-1）：证据齐全时 `provider_artifact_id=feishu:minutes:<minute_token>`、
`read_receipt_ref` 原样落库、`trigger_mode=MANUAL`、`connection_state=CONNECTED`；
并附 `FEISHU_LIVE_MANUAL_OPERATOR_READ` 警告（MANUAL 读取；产品自有 OAuth / F2 属 P1）。

**信任边界（诚实说明）**：`platform_channel` 是**接线层**（`wiring.ts`，插件配置
`feishu.cli` 绝对路径）声明的部署事实，不是数据证据。把假 CLI 配进生产配置 = 运维撒谎，
本地代码无法识别；D-1 接受的是**操作者真实跑过一次**的读取证据（真实 minute_token /
revision / hash / readback），不是本地可密码学验证的平台签名。

## 8. 用法

```js
import {
  createFeishuMinutesAdapter,
  createLarkCliTransport,
  createProcessCliRunner,
} from './index.ts'

// 1) 默认形态：不装配传输层 → fetchTranscript 只会说「传输层没装配」，不碰任何进程。
const adapter = createFeishuMinutesAdapter({})
// describe(): { …, live_gate:'EVIDENCE_DRIVEN', live_gate_evidence:[…8 项] }
adapter.probe()               // { connection_state, labels, blocked_reason, transport_configured:false, … }

// 2) 真实读取：显式给 CLI 的**绝对路径** + 声明这是平台通道（接线层做的事）。
const transport = createLarkCliTransport({
  runner: createProcessCliRunner({ command: '/opt/lark-cli/lark-cli' }),
  platform_channel: true,
  timeout_ms: 180_000,
  max_attempts: 3,
})
const wired = createFeishuMinutesAdapter({ transport })
const result = await wired.fetchTranscript({ minute_token })
// → READ: live_gate 由证据算（LIVE 或 BLOCKED + live_gate_violations）
//   BLOCKED / WAITING_EXTERNAL 照旧带原因。
```

`platform_channel` 省略 = 测试 / 回放通道：回读 `transport` 恒 `FIXTURE`，读成功也不可能 LIVE。

真实输出（本机无凭据，`node manual/transcript-line/feishu-probe.mjs`，省略 `next_steps`）：

```json
{ "connection_state": "NOT_CONNECTED",
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "provenance_basis": "NO_LIVE_READ", "live_eligible": false,
  "transport_configured": false,
  "blocked_reason": "NO_APP_CREDENTIALS", "missing": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"] }
```

```
LIVE_GATE=EVIDENCE_DRIVEN
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
| 落库标签 | 由**本次回读证据**算（`evaluateLiveGate`）：证据齐全 → `LIVE / MANUAL / CONNECTED`、`provenance_basis=LIVE_READBACK_VERIFIED`、`provider_artifact_id=feishu:minutes:<token>`、附 `FEISHU_LIVE_MANUAL_OPERATOR_READ`；证据不齐 → `FIXTURE / MANUAL / {NOT_CONNECTED, AUTH_REQUIRED}`、`provenance_basis=FEISHU_READBACK_NO_LIVE_GATE`、附 `FEISHU_READBACK_NOT_LIVE`（消息里逐条列缺项） |
| 回读不一致 | `content_sha256` / `read_receipt_ref` / `reread_sha256` 与 `raw_text` 对不上 → `BLOCKED / READBACK_INVALID`，**一行不写**（不一致是失败，不是警告） |
| 会议约束 | 只接受 `provider=FEISHU` 的会议（否则 `INVALID_ARGS/SOURCE_CONNECTOR_MISMATCH`）；`external_meeting_id` 必须精确匹配 active 绑定 |
| 装配配置 | `feishu: { cli: '<绝对路径>', timeout_ms?, max_attempts?, retry_base_ms?, page_size?, max_pages? }`（见 `wiring.ts`） |

工具侧**永不**把调用方自报的 `LIVE/CONNECTED` 当依据：`connectorReadbackLabels(readback, …)`
只认 `evaluateLiveGate()` 的结论；证据不齐时把 `CONNECTED` 自报降级成 `AUTH_REQUIRED`，
证据齐全时也不用适配器给的标签（用回读证据算出的那一份）。

## 9. 不做的事

- 不下载 / 不转存音视频，只认 `provider_artifact_id` 与访问引用（TR-S8）；
- 不把 webhook payload 当逐字稿，不猜会议、不按标题 / 时间 / 参会人绑定（TR-S7、TR-L3）；
- 不在错误里回显平台 `msg`、argv 或正文（R7）；
- **不发 HTTP 请求**（`http-transport` 仍是 `not_implemented`）；
- **默认不调用 Lark CLI**：只有调用方显式注入 runner 才会跑子进程；
- 不做产品自有 OAuth / 事件订阅（F2）——D-1 已把 F2 列为 **P1**，不阻塞 demo。

## 10. 验证

```powershell
cd dsh\dsh-recruitment
node --test "test/unit/transcript-feishu.test.ts"            # 21/21（证据驱动 LIVE 的诚实性机检 + 负例）
node --test "test/unit/transcript-feishu-transport.test.ts"  # 33/33（传输层：分页/超时/脱敏 + 重读校验 + 平台通道 LIVE）
node --test "test/unit/transcript-feishu-wiring.test.ts"     # 16/16（接线：配置→适配器→传输层 / 标签按证据算 / 注册入口可达）
node --test "test/integration/transcript-import.test.ts"     # 15/15（fake CLI 仍 FIXTURE；合成 LIVE 证据落库为 LIVE/CONNECTED）
node manual/transcript-line/feishu-probe.mjs                 # 末尾 LIVE_GATE=EVIDENCE_DRIVEN，退出码 0
```
