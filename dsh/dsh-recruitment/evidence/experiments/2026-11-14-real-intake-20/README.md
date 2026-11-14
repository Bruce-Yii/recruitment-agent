# 真实语料批量入库 · 20 份门槛（2026-11-14）

**任务**：把 `resume-talent-pool` 的真实语料批量走一遍 S6 `recruitment_application_intake`，
让入库的真实申请从（传闻的）8 份达到 **≥20 份**。
**结论**：达标。本次**新建 24 份真实语料申请**；库里真实语料申请 **26 份**（其中 `ACTIVE` **25 份**）。
全程走两个产品工具的真实 handler（`recruitment_document_read` → `recruitment_application_intake`），
**没有任何一条 SQL 写业务表**；身份闸门**没有放宽**（4 份被 `BLOCKED_BY_REVIEW` 拒收，一行未写）。

> R7：本文件与 `run-log.txt` 不含候选人姓名、电话、邮箱、文件名原文。只出现 `F01..F52` 脱敏标签、
> `sha256` 前缀、`application_id`、`candidate_id`、状态与字段名/来源（provenance）。

---

## 0. 一句话验收

| 验收项 | 结果 | 证据 |
|---|---|---|
| 入库前 `application` / `intake_asset` 行数 | **15 / 14** | `db-before.txt` |
| 入库后 `application` / `intake_asset` 行数 | **39 / 46** | `db-after-verify.txt` |
| `application.lifecycle_status='ACTIVE'` | 前 **14** → 后 **38** | 同上 |
| 真实语料申请（`resume_version.source_asset_sha256` 命中语料 sha256） | 前 **1** → 后 **26**（`ACTIVE` 25） | `db-after-verify.txt` |
| 本次新建申请（工具报 `CREATED`） | **24**（23 批量 + 1 单份探针） | `db-attribution.txt` |
| 归属核对 | `MINE=23` + `MINE_PROBE=1` + `OTHER=0` ⇒ 差集全是我建的，没把别的 lane 的写算进来 | `db-attribution.txt` |
| **≥20 份真实简历已入库** | **是**：26 份命中语料 sha256，25 份 `ACTIVE` | `db-after-verify.txt` |

---

## 1. 先纠一个事实：开工前库里不是「8 份真实简历」

任务背景说“只有 8 份过了 intake”。**DB 读回不支持这个数**，必须先说清楚，否则后面的门槛会被算错：

| 事实（只读 SQL） | 数 |
|---|---|
| 开工前 `intake_asset` 行数 | 14 |
| 其中 sha256 命中语料目录 48 份去重文档的 | **1**（`F48`，`sha=ead23e7999e7…`，其申请 `bc2f582b…` 已是 `CLOSED`） |
| 其余 13 份 | 不在语料里的 PDF（12 份 2–11 KB + 1 份 256228 B）；`parse_status=PARSED`，非本次统计口径 |

证据：`corpus-match-before.mjs` / `corpus-match-before.txt`（把 `db-before.txt` 的 14 条
`intake_asset.sha12` 与 `corpus-inventory.txt` 的 48 份去重文档 sha12 求交集 ⇒ **命中 1 份**；
其余 13 条（12 条 2291–10921 B + 1 条 256228 B）在语料 sha12 集合里查不到，属非语料行）。
**所以真实的起点是 1 份，不是 8 份**；本次把真实语料从 1 份带到 26 份。

---

## 2. 前后 DB 计数（读回，不是自述）

| 表 / 口径 | 开工前 | 收工后 | Δ |
|---|---|---|---|
| `application` | 15 | **39** | +24 |
| `application`（`ACTIVE`） | 14 | **38** | +24 |
| `candidate`（`ACTIVE`） | 14 | **38** | +24 |
| `resume` | 14 | **46** | +32 |
| `resume_version` | 15 | **47** | +32 |
| `intake_record` | 14 | **46** | +32 |
| `intake_asset` | 14 | **46** | +32 |

说明：`intake_asset`/`resume` 比 `application` 多 +8，是**同一候选人的第 2 份材料**（`application_action=REUSED`，
按 `(tenant, candidate, job, ACTIVE)` 复用申请、只追加 `resume_version`），这是产品契约，不是漏建申请。

前后差异归属见 `db-attribution.txt`：`after` 中不在 `before` 的 24 行**全部归到本次**（23 MINE +
1 MINE_PROBE），`OTHER=0`，且“工具报 CREATED 但库里查不到”的数量为 **0**。

**与“37 条停在 S6”这个口径对账**（`db-stage-breakdown.txt`，只读）：

| 口径 | 数 | 说明 |
|---|---|---|
| `application` 总数 | 39 | 含 1 条 11-12 的种子申请（`…000701`，无 `resume_version`）与 1 条转写线申请 |
| `resume_version_id` 非空的 application | **37** | 走 S6 intake 建出来的申请 |
| `current_stage_code='S6'` | **37** | 36 `ACTIVE` + 1 `CLOSED`（`bc2f582b…`，11-12 遗留） |
| 本次（`created_at > 08:54Z`）新建 | **24** | 与 `db-attribution.txt` 的 `MINE + MINE_PROBE` 一致 |

---

## 3. 逐份真实结果（43 条尝试，按批）

`document_read` 列是读取层判定（`⚠blocking` = 质量层认为不得直接进可信结构化/S7）；
`intake 结果` 是 S6 身份闸门的真实结论。**表中的 `application_id` / `candidate_id` 都可以在
`db-after-verify.txt` 里按 id 反查。**

| 文件 | sha256 前缀 | 格式 | document_read | intake 结果 | application_id | candidate_id | 身份闸门证据（字段名 + provenance） |
|---|---|---|---|---|---|---|---|
| F20 | `6f6dd3f49d79` | pdf | pymupdf/1.28.0 complete | OK REUSED | `00fe6fbd-c4c2-45c7-944f-9222579a5e53` | `3035960e-c5c2-4a4f-846e-aad966b7f3bc` | strong=[email,phone]（首跑 CREATED，见阶段 B；复跑幂等 REUSED） |
| F42 | `c8ecbf6a809f` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `c55b968a-2b80-4c79-92c8-b5f60e695c3c` | `ccf51de5-e34f-49bd-a085-df9d80d07226` | strong=[email,phone] |
| F04 | `1df94adcec53` | pdf | pymupdf/1.28.0 partial ⚠blocking | **BLOCKED_BY_REVIEW**(MATERIAL_ATTRIBUTION_UNKNOWN) | — | — | strong=[] ⇒ 一行未写 |
| F41 | `c46dbda8fa46` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `20f25e25-0d06-4e82-87f4-3deebec96476` | `57a5379d-f8d0-4c15-9ad5-d89d32006bc7` | strong=[email,phone] |
| F49 | `edef0f38bd2d` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `20f25e25-0d06-4e82-87f4-3deebec96476` | `57a5379d-f8d0-4c15-9ad5-d89d32006bc7` | strong=[email,phone] |
| F17 | `55209ede4bc7` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `3a6c0ed2-6f2d-4e9c-ba18-c66fca9a03d9` | `d9d8cfb5-306a-4468-aa86-8213b4b13139` | strong=[email,phone] |
| F23 | `7bd8089985ea` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `5770b175-7e1e-4b61-92af-2ab61947a78a` | `c46e916a-ff11-4a60-a064-243029428f03` | strong=[email,phone] |
| F45 | `d3870021bc00` | pdf | pymupdf/1.28.0 partial | OK CREATED | `5fea1268-ef52-415e-998b-0432468eaef4` | `675684aa-0ffd-47e2-8b55-7f7520edee71` | strong=[email,phone] |
| F15 | `51f116f33532` | pdf | pymupdf/1.28.0 partial ⚠blocking | **BLOCKED_BY_REVIEW**(MATERIAL_ATTRIBUTION_UNKNOWN) | — | — | strong=[] ⇒ 一行未写 |
| F48 | `ead23e7999e7` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc` | `c110817b-b09b-472f-b6a8-a09c1ceabe2f` | strong=[email,phone] |
| F12 | `49afd21e0669` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc` | `c110817b-b09b-472f-b6a8-a09c1ceabe2f` | strong=[email,phone] |
| F01 | `06bd93cd77be` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `99f81201-9e0f-4f15-91c5-5f6c7fafe459` | `58cce386-f8b7-4dbb-88e6-59e9f032cbfa` | strong=[email,phone] |
| F51 | `f606e4deb111` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `a24b9103-0e0d-4a78-82b1-b2d97ea9aacc` | `33d27f0f-bf38-4ae7-93d1-c7b0db0b7c6c` | strong=[email,phone] |
| F26 | `84b0756c3c68` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `6a314e56-aa48-452c-b147-482ad35d0eb3` | `8e048509-7eb3-4d59-9f95-f45347b9f7ca` | strong=[email,phone] |
| F35 | `b34436488bfd` | pdf | pymupdf/1.28.0 complete | OK CREATED | `5d6dd8ba-ab6f-4389-abfb-039ada8d731f` | `9b7f6d85-1ea9-47d7-8e90-1a954783020d` | strong=[email,phone] |
| F16 | `52200d6ade75` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `5d6dd8ba-ab6f-4389-abfb-039ada8d731f` | `9b7f6d85-1ea9-47d7-8e90-1a954783020d` | strong=[email,phone] |
| F25 | `81c59495d672` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `31928175-ddd1-40af-b944-101403fd3311` | `8fbdefe5-5709-4463-a2ef-44e27af35c86` | strong=[email,phone] |
| F11 | `47f52dedddad` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `9afaebef-329d-404b-955e-19eecd5c670f` | `eefde76b-db40-4160-92f0-110a2ebc0ff2` | strong=[email,phone] |
| F28 | `8a762ae8b022` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `00fe6fbd-c4c2-45c7-944f-9222579a5e53` | `3035960e-c5c2-4a4f-846e-aad966b7f3bc` | strong=[email,phone] |
| F03 | `15d5350f76f8` | pdf | pymupdf/1.28.0 partial ⚠blocking | **BLOCKED_BY_REVIEW**(MATERIAL_ATTRIBUTION_UNKNOWN) | — | — | strong=[] ⇒ 一行未写 |
| F19 | `6bc260295320` | pdf | pymupdf/1.28.0 partial | OK CREATED | `866b5c60-4bf9-4de1-9474-908de299b38d` | `4841b189-1d1f-4aff-be77-e42b3a790bf2` | strong=[phone] blocked=[email:field_state_absent] |
| F32 | `96aefe29da77` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `a71bb5ed-ccbb-4e5e-8153-8f0651e5ae77` | `97ba9f5c-e134-4a4d-b5fa-314cba13332b` | strong=[email] blocked=[phone:field_state_absent] |
| F18 | `65a434f2c103` | pdf | pymupdf/1.28.0 complete | OK CREATED | `dc269f91-986a-4150-8d77-108160b9246e` | `022bd1f7-2bfa-4c3a-a3a1-fe7fce63632e` | strong=[email,phone] |
| F08 | `40c59d65f925` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `9cbea483-22f7-4ae3-929b-3f1df29047c1` | `0a5ffd62-35b6-4ad9-9031-f32e70ca3ea5` | strong=[email,phone] |
| F38 | `bc857cd718af` | pdf | pymupdf/1.28.0 complete | OK CREATED | `8d788e1c-7d68-4449-b41b-2617d4184c26` | `0cb2141a-7e49-47ea-a93c-8a6e8aa80eb2` | strong=[email] blocked=[phone:field_state_unreadable] |
| F07 | `409e6d0f8651` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `1f9ec61f-7c80-454e-bf1e-cf7a6ba90aef` | `9954711f-282b-45ed-b205-9368d9deec3f` | strong=[email,phone] |
| F50 | `f1171f617020` | pdf | pymupdf/1.28.0 partial | OK CREATED | `6b2311a4-40e2-4db5-bd5c-c30b727c37e4` | `ed93ec83-fe56-40c8-ad78-70921c8b724e` | strong=[email,phone] |
| F43 | `cc1e7f16bc24` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `dc269f91-986a-4150-8d77-108160b9246e` | `022bd1f7-2bfa-4c3a-a3a1-fe7fce63632e` | strong=[email,phone] |
| F22 | `74445c2d7e15` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `0e0f5b27-e6c1-4a23-bed3-e1f6173af779` | `766bbb6d-a3f4-43ff-bae8-7241ba3c6c6e` | strong=[email,phone] |
| F33 | `98244bb1eab9` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `d292c60e-5bac-44ec-86cc-6f7257e6d384` | `394e93e3-b435-4ca9-81df-887cc3c14b46` | strong=[email,phone] |
| F13 | `4b253845e5e7` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `01a5def6-67ad-47ec-8833-09c874a4a763` | `7b11794d-5183-4671-aef1-4324c010253f` | strong=[email,phone] |
| F40 | `c432f2de7a31` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `9afaebef-329d-404b-955e-19eecd5c670f` | `eefde76b-db40-4160-92f0-110a2ebc0ff2` | strong=[email,phone] |
| F30 | `92fa1454bc8a` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `169c4257-ebec-4d20-9f3a-33d6c9bb63dd` | `f4983b91-9a56-414a-99d5-d9abaf4e7c16` | strong=[email,phone] |
| F52 | `f8fb0a0455b9` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `d292c60e-5bac-44ec-86cc-6f7257e6d384` | `394e93e3-b435-4ca9-81df-887cc3c14b46` | strong=[email,phone] |
| F37 | `b9155e19e88c` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK REUSED | `1f9ec61f-7c80-454e-bf1e-cf7a6ba90aef` | `9954711f-282b-45ed-b205-9368d9deec3f` | strong=[email,phone] |
| F06 | `2aea0b66b28e` | pdf | pymupdf/1.28.0 partial ⚠blocking | OK CREATED | `8ddd217e-8f6b-4552-b7dc-969c838721ed` | `581e103b-ab21-481f-87c0-e6ac538e713d` | strong=[email,phone] |
| F47 | `e6a42b0d920e` | pdf | pymupdf/1.28.0 partial ⚠blocking | **BLOCKED_BY_REVIEW**(MATERIAL_ATTRIBUTION_UNKNOWN) | — | — | strong=[] ⇒ 一行未写 |
| F44 | `d141e6de1a45` | docx | python-docx complete | INVALID_ARGS(PATH_INVALID) | — | — | 一行未写 |
| F05 | `20de5d4cac0b` | docx | python-docx complete | INVALID_ARGS(PATH_INVALID) | — | — | 一行未写 |
| F29 | `918894c484b7` | rtf | FAIL READER_FAILED(UNSUPPORTED_MEDIA) | INVALID_ARGS(PATH_INVALID) | — | — | 一行未写 |
| F46 | `e0a2ab9b1afd` | docx | python-docx complete | （只读，未试 intake） | — | — |  |
| F36 | `b7fefa208ef3` | docx | python-docx complete | （只读，未试 intake） | — | — |  |
| F27 | `84b32e91f41a` | docx | python-docx complete ⚠blocking | （只读，未试 intake） | — | — |  |

批说明：
- **阶段 B**：`F20` 单份探针（先建立通路）→ 同一文件复跑一次 ⇒ `REUSED`、id 全同、**一行未写**（幂等）。
- **阶段 C**：33 份 PDF 按字节升序，命中 22 个 `CREATED` 即停（控制时长）。
- **阶段 D**：最大的 4 份 PDF（1.1–1.6 MB，含 `needs_visual=true` 与 67 s 的 OCR 兜底失败路径）。
- **阶段 E**：DOCX / RTF —— 读得出来但**进不了 intake**，见 §6。

---

## 4. 身份闸门实测（没有放宽）

闸门规则（`src/tools/application-intake.ts` 的 `AUTO_MERGE_PROVENANCE='native_text'`）：
只有 `provenance='native_text'` 的 phone/email 能自动归并；`ocr`/`agent_read`/`unknown` 只进 `weak`，
且 `strong` 为空时抛 `BLOCKED_BY_REVIEW`，**一条行都不写**。

| 判定 | 份数 | 实测 |
|---|---|---|
| `CREATED`（`native_text` 强标识新建候选人+申请） | **23** | `strong=[email,phone]`（20 份）、`strong=[phone]`（1 份：`F19`）、`strong=[email]`（2 份：`F32`/`F38`）；全部 `weak=[]` |
| `REUSED`（同一人第 2 份材料 10 次 + `F20` 幂等复跑 1 次） | **11** | `matched_by=email+phone`，`application_id` 与首份相同，未新建申请 |
| **`BLOCKED_BY_REVIEW`（闸门拒收，一行未写）** | **4** | 全部 `reason=MATERIAL_ATTRIBUTION_UNKNOWN`，`strong=[]` |

4 份被拒的读取层证据（`results-*.json`）：

| 文件 | `document_read.blocking_codes` | 为什么闸门拒 |
|---|---|---|
| `F04` | `doc_identity_from_unverified_source`, `doc_provenance_unverified` | phone/email 来自未核来源，不是 `native_text` ⇒ 只能 `weak` |
| `F15` | 同上 | 同上 |
| `F03` | `unverified_pdf_image` | 标识落在未核图片区 |
| `F47` | `doc_provenance_unverified`, `structure_unidentified`, `unverified_pdf_image` | 同上；该份还走了 67 s 的 OCR 兜底且未成功 |

**没有做的事**（也是本轮的边界）：没有给这 4 份手工塞 `structured_json` 或任何 strong 字段来放行；
没有改 `AUTO_MERGE_PROVENANCE`；没有直接 SQL 写 `candidate`/`application`。
`CREATED` 的 23 份里，有 3 份只有单边强标识（1 份只有 phone：`F19`；2 份只有 email：`F32`/`F38`），
另一字段是 `field_state_absent` / `field_state_unreadable` —— 闸门放行的是**证据齐全的那一个字段**，
不是“读到了就算”。

---

## 5. 一个真实的口径冲突（发现，未修）

PDF 读取 38 条（37 份文件 + `F20` 复跑）里，`document_read` 判 **blocking=true 的有 30 条（79%）**
（`unverified_pdf_image`、`doc_cross_block_attribution`、`pdf_reading_order_unverified`…），
但其中大部分 intake **照样 `CREATED`**。
原因：S6 的闸门只判“身份来源是否 `native_text`”，不判读取质量层的那套 HARD 项；落库的
`resume_version.parse_status` 因此多为 `PARTIAL`。

**这不算 bug**，但它意味着：**“入到 20 份申请” ≠ “这 20 份可以直接进 S7 可信初筛”**。
要过 S7/可解释结论，还得补 §5 那些 HARD 项（跨块归属、未核图片、阅读顺序）的恢复或人工复核。
本轮只做 S6 入库，不对外宣称 S7 能力。

---

## 6. 格式缺口（发现，未修）

| 格式 | `document_read` | `recruitment_application_intake` | 影响 |
|---|---|---|---|
| PDF | OK（`pymupdf` / OCR 兜底） | OK | 主路径 |
| **DOCX** | **OK**（`python-docx@1.2.0`，`completeness=complete`，`blocking=false`） | **`INVALID_ARGS(PATH_INVALID)`** | 语料里 7 份 DOCX 真实简历**进不了 S6** |
| **RTF** | **`READER_FAILED(UNSUPPORTED_MEDIA)`** | `INVALID_ARGS(PATH_INVALID)` | 1 份 RTF 真实简历两条路都不通 |

`intake` 只收 `.pdf`（`assertReadablePdf`），而读取层已支持 PDF/DOCX/PNG/JPEG。
也就是说**读得进去 ≠ 入得了库**——这是本轮最值得单开任务的口径缺口（`F05`/`F44` 已给出真实报错）。

---

## 7. 对既有申请的影响（如实记录）

`application` 表本次唯一被改动的**既有行**是 `00d0f6c0-…`（11-12 建的）：

| 列 | 前 | 后 |
|---|---|---|
| `resume_version_id` | `276908da-…` | `56de0d0c-…`（`F12` 的 v1，本工具追加） |
| `record_version` | 1 | 2 |

这是 `intake` 契约里写明的“追加版本并把 `application.resume_version_id` 显式指过去”，
**不是我手工 UPDATE**。除此之外：没有删除、没有改 `lifecycle_status`、没有合并候选人；
`bc2f582b-…`（`CLOSED`）连 `updated_at` 都停在 11-13。

---

## 8. 复现命令

```powershell
cd 'D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment'
$env:RECRUITMENT_DB_PASSWORD='123456'

# 0) 语料清点（sha256 去重 + 是否已在库；路径映射写到 %TEMP%，不进仓库）
node evidence/experiments/2026-11-14-real-intake-20/corpus-inventory.mjs
# 1) 开工前计数（只读事务）
node evidence/experiments/2026-11-14-real-intake-20/probe-db.mjs before
# 2) 批量：document_read → application_intake（最大 22 个 CREATED）
node evidence/experiments/2026-11-14-real-intake-20/run-intake-batch.mjs `
  --mode intake --ext pdf --exclude F14,F34,F39 --max-created 22 --out pdfs
# 3) 最大 4 份（扫描/OCR 兜底）
node evidence/experiments/2026-11-14-real-intake-20/run-intake-batch.mjs `
  --mode intake --labels F52,F37,F06,F47 --out largest
# 4) DOCX/RTF 缺口
node evidence/experiments/2026-11-14-real-intake-20/run-intake-batch.mjs `
  --mode intake --labels F05,F44,F29 --out docx
# 5) 收工读回 + 归属
node evidence/experiments/2026-11-14-real-intake-20/verify-after.mjs | Tee-Object db-after-verify.txt
node evidence/experiments/2026-11-14-real-intake-20/attribute-diff.mjs | Set-Content db-attribution.txt
```

排除的 3 份（`F14`/`F34`/`F39`）经内容判断**不是简历**（技术文档 / 报告 / 预览页），
不拿来凑数；语料里 48 份去重文档中 40 份 PDF、7 份 DOCX、1 份 RTF。

---

## 9. 证据文件清单

| 文件 | 内容 |
|---|---|
| `run-log.txt` | **逐份真实输出**（A 摸底 → B 探针 → C 批量 → D 最大 4 份 → E DOCX/RTF → F 读回 → G 归属） |
| `README.md` | 本文件（汇总表 + 前后计数 + 结论） |
| `db-before.txt` / `db-after-verify.txt` | 前后只读读回（含“真实语料命中”反查） |
| `db-attribution.txt` | 前后差集按 `MINE / MINE_PROBE / OTHER` 归属 |
| `db-stage-breakdown.txt` | 分 `current_stage_code` / `lifecycle_status` 的行数（对账“37 条停在 S6”） |
| `corpus-inventory.txt` | 52 个文件（按 sha256 去重后 48 份）：`F` 标签 + sha256 前缀 + 字节数 + 扩展名 + 是否在库 |
| `corpus-match-before.mjs` / `corpus-match-before.txt` | 开工前「库里有几份真实语料」的只读复算（交集 = 1，仅有 `F48`） |
| `results-*.json` | 每批的机器可读结果（无 PII：只有 label/sha/id/状态/字段名） |
| `table.md` | §3 表格源文件 |
| `*.mjs` | 取证脚本（`document_read`/`application_intake` 按产品工具的 handler 调用；其余全为只读 SQL 或 shell 编排） |

---

## 10. 边界与自证

- **未** commit / push / 切分支；**未**改 `src/**`、`docs/**`、`converter/**`。
- **未**用 SQL 写业务表；`db-*.txt` 全部在 `begin transaction read only` 里跑。
- **未**把简历内容、姓名、电话、邮箱写进仓库或日志：`run-log.txt` 做过机器扫描
  （11 位手机号 0 命中、email 形态 0 命中、绝对路径 0 命中、“简历”字样 0 命中）。
  语料**绝对路径映射**（含文件名里的姓名）写在本地临时文件（`%TEMP%` 产物，**已删除、按设计不入库**），
  **不在仓库内**。
- 时间：约 40 分钟完成 45 次 `document_read` / 42 次 `intake`（含 `F20` 幂等复跑与 4 次闸门拒收），单份 0.3–4.4 s，
  唯一慢的是 `F47` 的 OCR 兜底 67 s。
- **自我限制（R8）**：本 lane 只看自证与 DB 读回，不做独立复核；上述每个数字都能由
  §8 的命令在同一个库上重跑复现。
