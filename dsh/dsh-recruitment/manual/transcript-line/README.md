# S9 转写线（transcript line）· 设计与证据

**分支**：`feat/unified-document-intake`（本地 = 远端 `5581c26`）· **不 commit / 不 push**
**所有者**：S9 模块 owner（转写线）
**权威契约**：`dsh/dsh-recruitment/contracts/interview/transcript-rules.md`（**只读**）、`contracts/interview/tool-contracts.md`（只读）、`db/SCHEMA.md`
**本目录**：`manual/transcript-line/**`（手工联调与证据，不属于插件运行时）

---

## 0. 两条验收线，绝不混

| 线 | 内容 | 本目录的证明 |
|---|---|---|
| **线 1（真功能）** | `recruitment_transcript_import`（人工粘贴/上传转写文本）→ `transcript_artifact`（原文不可变 + revision）+ `transcript_segment` + `interview_record`；`recruitment_transcript_read` 只读读回（canonical 标记） | `seed-demo.mjs` / `run-import.mjs` / `readback.mjs` + PG 读回 SQL |
| **线 2（外部资源，如实标注）** | 飞书 Minutes Connector 的**契约 + 适配器骨架**；无真实授权时 `NOT_CONNECTED` / `AUTH_REQUIRED` | `feishu-probe.mjs` + `test/unit/transcript-feishu.test.ts`（断言**永不输出 LIVE**） |

**铁律**：Fixture 不冒充 LIVE；人工导入不冒充飞书已接通；`transcript READY` 不冒充 `interview_record READY`（`transcript-rules.md` TR-D2 / TR-C6 / TR-E4）。

---

## 1. 文件所有权（本轮只允许写这些）

```
src/tools/transcript-import.ts            新建（线 1 写路径）
src/tools/transcript-read.ts              新建（线 1 读路径，只读事务）
src/connectors/feishu/**                  新建（线 2 契约 + 骨架，零网络 I/O）
test/unit/transcript-*.test.ts            新建
test/integration/transcript-*.test.ts     新建
manual/transcript-line/**                 新建（本目录）
```

**不碰**：`contracts/interview/**`、`application-intake.ts`、`screening-evaluate.ts`、`src/db/**`、`src/index.ts`、`db/**`、`converter/**`、`src/document/**`。
> `src/index.ts` 归 W0：本轮两个工具**尚未**注册进 cordis 插件（R2 接线仍待 W0）。因此本目录的 headless 证明是「直接 import 工具定义 + 真实 execute + 真库」，**不谎称已挂上 DSH 会话**。

---

## 2. 线 1 · 数据落点（与契约逐条对齐）

| 契约 | 本轮实现 |
|---|---|
| P-2 / TR-C7 / TR-C8 | **不插占位行**：首次 INSERT 就带 `raw_text`、`content_sha256`、`read_receipt_ref`（仅 LIVE）、`fetched_at`、真实 `transcript_status` |
| TR-S3 / TR-S4 / TR-S6 | 人工上传/粘贴：`trigger_mode='MANUAL'`、`connection_state='NOT_CONNECTED'`；`provenance='LIVE'` **仅当**调用方声明 `source_kind='PLATFORM_EXPORT'` 且给出导出文件名（生成 `upload:<actor>:sha256:<hex>;file=<name>` 回执），并附 `EXPORT_RECEIPT_IS_SELF_DECLARED` 警告 |
| TR-S5 | 手打纪要不得当原文：`source_kind` 只收 `PLATFORM_EXPORT` / `DEMO_SAMPLE`；`DEMO_SAMPLE` 一律 `provenance='FIXTURE'` + `FIXTURE_CONTENT_NOT_LIVE` 警告 |
| TR-U7 / TR-U8 / TR-U9 | 同一 `(meeting_id, provider_artifact_id)` 内容 sha 变了 → `source_revision = max+1` 新行（旧行保留、`is_canonical=false`）；sha 没变 → 不新建（`replayed=true`）；canonical 迁移同事务 |
| TR-U10 | 旧 revision 被 `interview_record` 引用后永不改写；新 revision 建新 record，旧 record `is_current=false` 保留 |
| TR-E4 / TR-C6 | 无 artifact → 不建 `interview_record`；`transcript READY` 与 `interview_record.status` 分开回显 |
| §8.3 不可变白名单 | 只更新 `transcript_status/fetched_at/is_complete/is_canonical/canonical_selected_by_actor_id` 等白名单列 |

固定列取值（**不编造平台标识**）：

| 列 | `DEMO_SAMPLE` | `PLATFORM_EXPORT` |
|---|---|---|
| `provider` | `LOCAL_DEMO` | `meeting.provider`（如 `FEISHU`） |
| `provider_artifact_id` | `local:demo-sample:<meeting_id>` | `local:platform-export:<meeting_id>` |
| `provenance` | `FIXTURE` | `LIVE` |
| `trigger_mode` | `MANUAL` | `MANUAL` |
| `connection_state` | `NOT_CONNECTED` | `NOT_CONNECTED` |
| `read_receipt_ref` | 无 | `upload:<actor_id>:sha256:<sha>;file=<name>` |
| `variant_type` / `language` | `ORIGINAL` / 入参（默认 `zh`） | 同左 |

`interview_record`（人工导入是**确定性中性记录**，不是模型抽取）：

- `status='NEEDS_REVIEW'`、`verification_status='UNVERIFIED'`、`evidence_ok=true`（逐条 segment 存在性已核）
- `model_id='none:manual-import'`、`prompt_version='manual-import/1.0.0'`、`schema_version=1`
- `sections`：`{schema, source:{kind,provider,file,sha,segment_count,char_count,language}, basis:{artifact_id,revision}, turns:[{sequence,text}] (最多 200 条), citations:[{kind:'SEGMENT',sequence}]}`
- `rubric_version_id` 来自 `interview → application.rubric_version_id`；为空 → **不建 record**，artifact 照常落库，warning `RECORD_NOT_CREATED_NO_RUBRIC`（`interview_record.rubric_version_id` 是 NOT NULL，且本机库的 FK 是 `(rubric_version_id, tenant_id) → rubric_version`）

> **本机 `ra_s6s7` 的实际迁移状态（2026-11-13 实测，不是猜测）**：0001–0007 + 0009 已应用，**0008 未应用** → `interview_record` **没有 `job_id` 列**、没有 `fk_interview_record_rubric_job`、没有 `trg_interview_record_job_guard`。因此本轮 INSERT **省略 `job_id`**：这对 0008 是前向兼容的（0008 的触发器会在 `job_id is null` 时从 `interview → application` 自动推导）；但**现在写它会 42703**。岗位一致性由工具在事务内用 `application.job_id` 校验。


---

## 3. 线 1 工具契约（冻结；两条线共用同一套错误格式）

错误格式沿用 `tool-contracts.md §1.2`：`Error: <CODE>: <compact-json>`（单行、字典序、可 `JSON.parse`）。

### 3.1 `recruitment_transcript_import`

**入参**（封闭对象，`additionalProperties:false`；`tenant_id`/`actor_id` 出现即 `INVALID_ARGS(TENANT_OR_ACTOR_NOT_ALLOWED)`）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `interview_id` | string(uuid) | ✅ | 哪场面试 |
| `content` | string | ✅ | 1..400000 字符；**逐字节保存**，不做清洗/摘要 |
| `source_kind` | enum | ✅ | `PLATFORM_EXPORT` \| `DEMO_SAMPLE` |
| `exported_file_name` | string | PLATFORM_EXPORT 必填 | 1..255，平台导出文件名 |
| `language` | string | — | 默认 `zh`，1..16 |
| `meeting_id` | string(uuid) | — | 多会议绑定时用于消歧 |
| `note` | string | — | 1..500 |

**错误码（封闭集）**：`INVALID_ARGS`（`UNKNOWN_PARAM` / `TYPE_MISMATCH` / `MISSING_REQUIRED` / `OUT_OF_RANGE` / `ID_NOT_UUID` / `TENANT_OR_ACTOR_NOT_ALLOWED` / `MUTUALLY_EXCLUSIVE` / `EXPORT_FILE_NAME_REQUIRED`）、`NOT_FOUND(INTERVIEW_NOT_FOUND | MEETING_NOT_FOUND)`、`NO_MEETING_BOUND`、`AMBIGUOUS_MEETING`、`NOT_CONFIGURED`。

**出参**（无 `null`，缺省靠**省略键**；schema 只用 DSH 子集）：

```json
{
  "tool": "recruitment_transcript_import",
  "contract_version": "1.0.0",
  "status": "OK",
  "write": true,
  "replayed": false,
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "provenance_basis": "DEMO_SAMPLE_NO_PLATFORM_RECEIPT",
  "interview": { "id": "…", "application_id": "…", "job_id": "…", "round_no": 1, "stage_code": "S9", "status": "POST_INTERVIEW" },
  "meeting": { "id": "…", "provider": "FEISHU", "external_meeting_id": "…", "meeting_role": "PRIMARY", "binding_id": "…", "binding_method": "MANUAL" },
  "artifact": {
    "id": "…", "meeting_id": "…", "provider": "LOCAL_DEMO", "provider_artifact_id": "local:demo-sample:…",
    "source_revision": 1, "variant_type": "ORIGINAL", "language": "zh",
    "transcript_status": "READY", "provenance": "FIXTURE", "trigger_mode": "MANUAL", "connection_state": "NOT_CONNECTED",
    "is_canonical": true, "is_complete": true, "has_more": false,
    "content_sha256": "…", "char_count": 812, "segment_count": 24, "fetched_at": "2026-11-13T…"
  },
  "record": { "id": "…", "status": "NEEDS_REVIEW", "verification_status": "UNVERIFIED", "transcript_revision": 1, "evidence_ok": true, "is_current": true },
  "changes": { "created": [{ "table": "transcript_artifact", "id": "…" }, { "table": "transcript_segment", "id": "…" }, { "table": "interview_record", "id": "…" }], "updated": [] },
  "warnings": [{ "code": "FIXTURE_CONTENT_NOT_LIVE", "message": "…" }],
  "next_actions": []
}
```

`labels` 的闭合规则（**测试必须断言**）：`trigger` 恒 `MANUAL`；`connection` 恒 `NOT_CONNECTED`；`provenance ∈ {FIXTURE, LIVE}`，`LIVE` 当且仅当 `source_kind='PLATFORM_EXPORT'` 且有导出文件名。

### 3.2 `recruitment_transcript_read`

**入参**：`interview_id`(uuid, ✅)、`artifact_id`(uuid, 可选过滤，必须属于该面试)、`include_text`(boolean, 默认 true)、`text_offset`(int ≥0, 默认 0)、`max_chars`(int 1..200000, 默认 20000)、`include_segments`(boolean, 默认 false)、`segment_offset`(int ≥0, 默认 0)、`segment_limit`(int 1..1000, 默认 200)、`as_of`(ISO-8601 带偏移, 不晚于 now)。

**语义**：`BEGIN TRANSACTION READ ONLY`（`withReadOnly`），源码内**零** `INSERT/UPDATE/DELETE`。`transcript.state` 严格按 `transcript-rules.md §4 TR-D` 七条推导（含 `WAIT=120min`，可被 `business_config(config_key='transcript_policy').payload.wait_minutes` 覆盖）；`reason_code` 用 §5 的封闭集。

**出参要点**：`labels={provenance:'LIVE', trigger:'MANUAL', connection:'CONNECTED'}`（= 直连业务库，与平台无关，`tool-contracts §1.4`）；`transcript.artifacts[]` 逐条回显该行自己的 `provenance/trigger_mode/connection_state`；`transcript.text.{artifact_id, source_revision, content, offset, length, total_chars, has_more, next_offset}`；`transcript.record` 回显 `interview_record` 状态（缺失即省略键 + warning `RECORD_MISSING`）；`transcript.canonical_artifact_id`/`canonical_revision` 只在存在 canonical 时出现；`warnings` 封闭：`TRANSCRIPT_NOT_READY` / `NO_CANONICAL` / `RECORD_MISSING` / `RECORD_NOT_READY` / `ARTIFACT_FILTER_NOT_CANONICAL`。

**错误码**：`INVALID_ARGS`（同上 reason 集 + `AS_OF_FORMAT`/`AS_OF_IN_FUTURE`）、`NOT_FOUND(INTERVIEW_NOT_FOUND | ARTIFACT_NOT_FOUND)`、`NOT_CONFIGURED`。

---

## 4. 线 2 · 飞书 Connector（只做契约 + 骨架，零网络）

`src/connectors/feishu/`：

| 文件 | 内容 |
|---|---|
| `contract.ts` | `FEISHU_MINUTES_CONTRACT_VERSION='1.0.0'`；Minutes API 端点/参数/分页/事件类型的**契约常量**（字符串，不调用）；`2091003 → WAITING_EXTERNAL`、`2091005 → AUTH_REQUIRED`；`FEISHU_MINUTES_SCOPES`；`minutes.minute.generated_v1` 是 user-identity 订阅的注记 |
| `labels.ts` | 三维标签类型 + `buildConnectorLabels()` + `buildArtifactLabelsFromReadback()`（**LIVE 必须满足**：`transport='FEISHU_MINUTES_API'`、`read_receipt_ref` 形如 `lark:minutes+detail:*`、`fetched_at` 合法、`content_sha256` 64 hex、`isComplete=true`，否则抛 `LABEL_DISHONEST_LIVE`） |
| `adapter.ts` | `createFeishuMinutesAdapter({ env })`：`describe()` / `probe()` / `fetchTranscript()` / `mapProviderError()`。**永不**发起网络请求、**永不**生成伪造 `minute_token`；无凭据 → `NOT_CONNECTED`，有应用凭据缺用户令牌 → `AUTH_REQUIRED`；任何情况下 `live_eligible=false`、`labels.provenance='FIXTURE'`、`connection ∈ {NOT_CONNECTED,AUTH_REQUIRED}` |
| `index.ts` | 汇总导出 |

**诚实性判据（测试机检）**：

1. 骨架所有出口的 `labels.provenance !== 'LIVE'`、`connection !== 'CONNECTED'`、`trigger === 'MANUAL'`（无已验证事件）。
2. `2091003` → `WAITING_EXTERNAL`；`2091005` → `AUTH_REQUIRED`；**都不得**建 artifact。未在 `docs/04` 出现的码一律 `UNKNOWN`（不编造、不猜）。
3. `buildArtifactLabelsFromReadback` 对 Fixture / webhook payload / 缺回执 → 抛错；只有"完整回读对象"才返回 `LIVE/MANUAL|EVENT/CONNECTED`。
4. `src/connectors/feishu/**` 静态扫描：无 `fetch(`、`node:http(s)`、`undici`、子进程。
5. `trigger` 只有 `readback.trigger='EVENT'` 且 `event.provider_event_id` 与 `event.verified===true` 时才允许 `EVENT`。

**结论**：飞书 LIVE Gate = `BLOCKED`（无真实授权）。本线只证明"没有授权时系统说清楚为什么、还差什么"。

---

## 5. 验收命令（must reproduce）

```powershell
cd dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'
node --test                          # 四个数：tests / pass / fail / skipped
node manual/transcript-line/seed-demo.mjs
node manual/transcript-line/run-import.mjs
node manual/transcript-line/readback.mjs
node manual/transcript-line/feishu-probe.mjs
```

DB 基线：`ra_s6s7`（PG17 @127.0.0.1:5432，实测迁移 0001–0007 + 0009；0008 未应用，见 §2 末注）。租户 `11111111-1111-4111-8111-000000000001`，HR actor `11111111-1111-4111-8111-000000000103`。

**基线（本 lane 开工时，commit `5581c26`）**：`node --test` → `tests 389 / pass 389 / fail 0 / skipped 0`。

---

## 6. 本轮实测证据（2026-11-13 20:05 +08）

> 工作树在本 lane 执行期间被其它 lane 并行改动（HEAD 从 `5581c26` → `9be0d0e` → W0 的 WIP 提交 `6741e61`），
> 所以“全量”数字包含别的 lane 的测试且**会随他们增删而变**；**S9 自己的子集单独报**。

### 6.1 测试四个数

```text
node --test
→ tests 708 / pass 708 / fail 0 / skipped 0   （全量，20:08 +08，真实 ra_s6s7）
node --test "test/unit/transcript-*.test.ts"
→ tests 53 / pass 53 / fail 0 / skipped 0     （13 import + 16 read + 6 readonly + 18 feishu honesty）
node --test "test/integration/transcript-*.test.ts"
→ tests 18 / pass 18 / fail 0 / skipped 0     （9 import + 9 read）
```

S9 合计 **71 例**，全部通过；全量里其余测试属于并行其它 lane，数字随他们增删变动。

S9 测试文件：

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test/unit/transcript-import.test.ts` | 13 | 标签诚实性（DEMO=FIXTURE、EXPORT=LIVE 但恒 MANUAL/NOT_CONNECTED）、参数 reason_code、schema 封闭、错误格式、render 不回显正文 |
| `test/unit/transcript-read.test.ts` | 16 | TR-D 七条顺序、WAIT 覆盖、`as_of` 闭集、输出无 null、render |
| `test/unit/transcript-readonly.test.ts` | 6 | 全文零 DML、只 import `withReadOnly`、不引用写模块、`read_only:true`、负向对照 |
| `test/unit/transcript-feishu.test.ts` | 18 | **所有出口永不 `LIVE`/`CONNECTED`**；错误码映射；无网络 I/O |
| `test/integration/transcript-import.test.ts` | 9 | 首次导入 / replay / revision / PLATFORM_EXPORT 回执 / NO_MEETING_BOUND / 多会议 / 无 rubric |
| `test/integration/transcript-read.test.ts` | 9 | READY / MISSING×2 / PENDING / READY_NO_CANONICAL / wait 覆盖 / artifact 过滤 / REPLACED |

### 6.2 Headless 导入 + DB readback（真实库）

口径：headless = **直接 import 工具定义 + 真实 `execute()` + 真库**。`src/index.ts` 归 W0，
本轮**未注册进 cordis 插件**（R2 接线待 W0），所以不谎称“DSH 会话里可调用”。

| 场景 | interview | artifact | revision | provenance | canonical | record |
|---|---|---|---|---|---|---|
| 第 1 轮首次导入 | `ffe144a2-…-4d8bfb6af841` | `c8b8c9fd-…-c604609c5ee5` | 1 | `FIXTURE` | ❌（迁到 rev2） | `aa5b9934-…`（is_current=false） |
| 第 1 轮修订导入（加一行补录） | 同上 | `99f42a7a-…-3024619c7321` | **2** | `FIXTURE` | ✅ | `4ab98f05-…`（is_current=true） |
| 第 2 轮干净首次导入 | `81a3ade3-…-83cec6b6acbb` | `a26c15b0-…-43947644714d` | 1 | `FIXTURE` | ✅ | `5409bd40-…`（is_current=true） |

- 三条 artifact 的 **`trigger_mode=MANUAL`、`connection_state=NOT_CONNECTED`**（人工导入不冒充自动摄取/已接通）。
- 三条 artifact 的 `content_sha256` 与 `raw_text` **逐个自洽**；`revision=1` 原文与 fixture **逐字节相同**。
- 三条 `transcript_segment` 分组：22 / 22 / 23 行；**没有一行为编造说话人**（`speaker_ref/label` 全空，平台没给就不补）。
- 同一 meeting 下 canonical **≤1**（SQL 机检 0 违规）。
- `UPDATE transcript_artifact SET raw_text=…` 被触发器拒绝：`IMMUTABLE_COLUMN`（原文不可改）。
- 证据文件：`evidence/import-result-*.json`、`evidence/readback-*.txt`、`evidence/read-tool-result.json`、`evidence/seed.json`。

### 6.3 飞书三维标签（LIVE Gate = BLOCKED）

`node manual/transcript-line/feishu-probe.mjs`（真实输出）：

```json
{
  "connector": "feishu-minutes",
  "contract_version": "1.0.0",
  "live_eligible": false,
  "credentials": { "app_id_present": false, "app_secret_present": false,
                    "user_token_present": false, "tenant_token_present": false },
  "connection_state": "NOT_CONNECTED",
  "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "NOT_CONNECTED" },
  "provenance_basis": "NO_LIVE_READ",
  "blocked_reason": "NO_APP_CREDENTIALS",
  "missing": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]
}
LIVE_GATE=BLOCKED
```

`test/unit/transcript-feishu.test.ts` 的 18 条断言里有一条专门遍历所有出口，断言
`provenance !== 'LIVE'`、`connection !== 'CONNECTED'`、`trigger === 'MANUAL'`；
唯一能产出 `LIVE` 的纯函数 `buildArtifactLabelsFromReadback()` 要求六项回读证据齐全，
否则抛 `LABEL_DISHONEST_LIVE`。骨架**没有传输层**（静态扫描断言无 `fetch`/`http`/子进程）。

### 6.4 边界自检

- 本轮新增/修改文件全部落在 §1 的白名单内；`contracts/interview/**`、`db/**`、`src/db/**`、
  `src/index.ts`、`converter/**`、`src/document/**`、`application-intake.ts`、`screening-evaluate.ts`
  在 `git status` 中**零改动**。
- 未 commit、未 push（HEAD 的 WIP 提交由 W0 在他自己的汇总步骤产生，不是本 lane 做的）。
- 截至本文件最后更新，S9 仍有 **3 个未跟踪文件**（需 W0 汇总时一起纳入）：
  `test/unit/transcript-import.test.ts`、`test/unit/transcript-read.test.ts`、
  `test/unit/transcript-readonly.test.ts`；另有 3 处相对 HEAD 的已跟踪改动
  （`src/tools/transcript-import.ts`、`src/tools/transcript-read.ts`、
  `test/integration/transcript-read.test.ts`）。

### 6.5 已知缺口（复核时优先看这三处）

| # | 缺口 | 影响 | 现状 |
|---|---|---|---|
| 1 | **未接线**：两个工具没有注册进 `src/index.ts`（W0 独占） | R2 意义上“会话内不可达”；本目录的 headless 是直接 `execute()` | 交付工厂函数 + `unconfigured*`，W0 加两行注册即可；**不得**据此宣称产品已接通 |
| 2 | **并发**：`23505 → savepoint → replay` 只做了单线程路径；同一面试两个并发导入**不同内容**时 `uq_interview_record_current` 可能抛原始 23505 | 极端并发下错误码不契约化 | 已在 code 里用 savepoint 处理 artifact 竞争；record 竞争未覆盖，未写并发测试 |
| 3 | **字符数口径**：import 的 `char_count` 是 JS `content.length`（UTF-16 单元），read 的 `total_chars` 是 PG `length()`（code point） | 含 emoji 时两数不等（本 demo 文本无 emoji，测试也未覆盖） | 文档显式记差异；若要求一致需统一口径（属契约级决定） |

另：本机 `ra_s6s7` **0008 未应用**（`interview_record` 无 `job_id`、无 `fk_interview_record_rubric_job`、无 job guard 触发器）。
写侧省略 `job_id` 对 0008 前向兼容（其触发器会在 `job_id is null` 时推导），但**与 0008 形态的文档描述不同**，已在 §2 末注写明。
