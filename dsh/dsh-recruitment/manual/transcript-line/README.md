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
2. `2081003/2091003` → `WAITING_EXTERNAL`；`2091005` → `AUTH_REQUIRED`；**都不得**建 artifact。
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

**基线（本文件写下时）**：`node --test` → `tests 389 / pass 389 / fail 0 / skipped 0`。本轮**不得**新增 fail，也不得新增 skip。
