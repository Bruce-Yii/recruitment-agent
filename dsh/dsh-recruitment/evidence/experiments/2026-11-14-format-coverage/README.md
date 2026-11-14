# 格式覆盖端到端 · RTF reader + resume_read 内容嗅探（2026-11-14）

**任务**：补两个格式缺口——
① `recruitment_resume_read` 仍是 PDF-only（`assertReadablePdf()` 按扩展名硬判 `.pdf`），DOCX 进不去；
② `converter` 的 MuPDF 认 docx 不认 rtf，真实语料里那 1 份 RTF 永远是 `READER_FAILED(UNSUPPORTED_MEDIA)`。

**结论**：两个缺口都修了。RTF 现在有真读取器（`striprtf`，纯 Python 无外部二进制），
`document_read` / `resume_read` / `application_intake` 三条路都**认得** RTF；DOCX 走
`resume_read` 不再是 `PATH_INVALID`；PDF 零回归。RTF 在 S6 身份闸门处**正确
BLOCKED_BY_REVIEW**（RTF 没有 bbox，IR-G1 的"证据坐标齐全"不成立），不是格式拒收——
放宽这条闸门不在本 lane 权限内，也不该为了"能读"去放宽。

> R7：本目录**不含**候选人姓名/电话/邮箱/文件名。原件路径只在运行时通过环境变量传入；
> `results.json` / `run-log.txt` 只有 sha 前缀、状态码、工具 id。

---

## 1. 根因（file:line）

### 缺口一：resume_read 仍 PDF-only

| 位置 | 事实 |
|---|---|
| `dsh/dsh-recruitment/src/tools/converter.ts:100`（`assertReadablePdf`） | `if (!filePath.toLowerCase().endsWith('.pdf')) throw INVALID_ARGS('path must point to a .pdf file')` —— 按**扩展名**判定，DOCX/RTF 在进入 converter 之前就被拒。 |
| `dsh/dsh-recruitment/src/tools/resume-read.ts:408`（修前） | `realPath = assertReadablePdf(requested, cfg)` —— 读工具复用了 PDF-only 的路径校验。 |
| 对照：`application-intake.ts:2216-2244`（修前已改） | intake 已改成 `assertReadableFile` + `sniffFile`（按**字节**判格式），所以同一个插件里存在**两套格式判定标准**——这就是缺口一。 |

**修法**：`resume_read` 改成与 intake/document_read 同一入口
`assertReadableFile()`（只查路径安全）→ `sniffFile()`（按字节判 PDF/DOCX/RTF/PNG/JPEG）；
接受 `pdf|docx|rtf`，`source.media_type` 写**嗅探值**（不再写死 `application/pdf`）；
图片明确拒绝 `READER_FAILED(reason_code=IMAGE_REQUIRES_VISION)`（本工具没有 OCR 步骤）。

### 缺口二：RTF 进不了 S6

| 位置 | 事实 |
|---|---|
| `converter/src/cli.py:85-89`（修前 `read_any`） | 一律 `from .pdf_reader import read_pdf` —— converter 里根本没有第二种 reader，更谈不上按内容分派。 |
| `converter/src/pdf_reader.py:315`（`read_pdf` 的 `fitz.open`） | PyMuPDF 打开 PDF 与 OOXML DOCX，但**不认 RTF** → 落 `reader_failed`。 |
| `dsh/dsh-recruitment/src/document/readers/sniff.ts:76`（修前） | `'.rtf': 'other'`，内容嗅探对 RTF 一律 `UNSUPPORTED_MEDIA` → intake/`document_read` 在入口就拒。 |

**修法**：
- `converter/src/rtf_reader.py`（新）——`striprtf` 提取原生文本，复用 `resume_fields.analyze`
  的字段/screening/timeline 口径；块 `provenance=native_text`；**不重建版面**。
- `converter/src/reader.py`（新）——按文件头字节分派：`%PDF-`/ZIP → PyMuPDF，`{\rtf` →
  striprtf，其它 → 合法失败（不猜扩展名）。`cli.py` / `reader_worker.py` / `batch_run.py`
  共用这一个分派点。
- `src/document/**` 契约扩第五种媒体 `application/rtf` + `RtfLocator{paragraph, page?}`；
  `sniff.ts` 认 `{\rtf`；`readers/rtf.ts` 复用 converter CLI + `mapConverterToDocumentContent`。
- `application-intake.ts` 的 `resolveIntakeSource()` 增加 `rtf` 分支（S6 收 RTF 的**读取**，
  但不放宽身份闸门）。

> ⚠️ 提交归属：**本 lane 从未 commit / push / checkout / stash / restore**。但另外的整合动作
> 把我的工作树改动带进了两个提交：`4a5dfd3`（带入 `src/tools/{resume-read,application-intake}.ts`）
> 和 `30f501c`（带入 `converter/**` + `src/document/**` + `test/document/**` 的 RTF 工作）。
> 这两个提交的 author 不是本 lane；本 lane 的产出以这两个提交 + 未提交的 `README`/证据文件为准。

---

## 2. RTF 方案选型（R1 复用优先）

| 候选 | 评估 | 结论 |
|---|---|---|
| **striprtf**（选中） | 纯 Python、无外部二进制；`pip install striprtf` 一个包；已正确处理 `\ansicpg` / `\fcharset` / `\uN` / `\'hh`；0.6 MB 的 `ansicpg936` 真实 RTF 0.24 s 抽出 4872 字、CJK 不乱码 | ✅ 选它 |
| rtf2html + HTML 解析 | 两个依赖；HTML hop 对"取文本"没有增益；额外一份失败面 | ❌ 多依赖无收益 |
| LibreOffice `--convert-to docx` | 保真最好，但 ~500 MB 外部二进制、每份文件一个重型进程、部署/许可面 v1.0 不该背 | ❌ 部署代价与 R1 相悖 |

部署：`converter/requirements.txt` 增加 `striprtf>=0.0.26`；CI 本来就
`pip install -r converter/requirements.txt`，**无新增步骤**。缺依赖时 `rtf_reader.py`
返回 `reader_failed`（"striprtf is not installed"），不静默跳过。

**provenance 口径（不伪造）**：RTF 是**文本容器**，字符以控制字/转义字节存在文件里，
解码它等价于 PDF 的文本层解码（不是 OCR、不是模型）。所以 block 与字段
`provenance=native_text`；字段 provenance 逐块由 `resume_fields._provenance_of` 传播。
不伪装的是**版面**：`order_verified=false`、`layout_backend=null`、没有 bbox；
有硬分页符时不逐块挂 `page`；内嵌图片不读但声明 `unverified_rtf_embedded_image`
（converter 判 SOFT，质量层按未核图片升级为 HARD 版式类阻断）；解不出的字节剔除并声明
`rtf_text_encoding_unread`（HARD）。

---

## 3. 真实语料端到端（`run-format-e2e.mjs`，全部走产品 handler）

**证据**：`results.json`（机器可读）、`run-log.txt`（逐行）。**DB 读回**按 sha 精确归属
（本机有别的 lane 并发写库，全局 count 差值不可归因；per-sha 读回可归因）。

| 格式 | 文件（脱敏） | 字节 | document_read | resume_read | intake（S6 真实写库） | 覆盖 |
|---|---|---|---|---|---|---|
| **RTF** | F29 `sha12=918894c484b7` | 639,853 | ✅ `application/rtf`，`striprtf/0.0.35`，70 blocks，1 页，partial；blocking=`unverified_rtf_embedded_image`（仅版式，`blocking_for_structure=false`） | ✅ `application/rtf`，70 blocks，`provenance=LIVE`（basis=FILE_BYTES_SHA256_VERIFIED），phone/email=`present/native_text` | **BLOCKED_BY_REVIEW(MATERIAL_ATTRIBUTION_UNKNOWN)** —— 读得出但 RTF 无 bbox，IR-G1 不放行自动归并；**一行未写**（per-sha 读回 asset=null） | **PARTIAL**（读取 PASS / 自动入库被闸门正确拒收） |
| **DOCX** | F05 `sha12=20de5d4cac0b` | 74,875 | ✅ DOCX，python-docx 1.2.0，28 blocks，complete，blocking=false | ✅ `application/vnd...wordprocessingml.document`，pymupdf/1.28.0，6 页，72 blocks，LIVE，phone/email present/native_text | ✅ **REUSED**（`matched_by=email+phone`，与库里同人材料合并，未新建候选） | **PASS** |
| **DOCX（无身份信息对照）** | F21 `sha12=7107fe465cda` | 39,350 | ✅ DOCX，178 blocks，complete，blocking=false | ✅ DOCX，15 页，186 blocks，LIVE；phone=`unreadable`、email=`absent` | ✅ **BLOCKED_BY_REVIEW(MATERIAL_ATTRIBUTION_UNKNOWN)**，一行未写 | **PARTIAL**（闸门正确拒收） |
| **PDF** | F48 `sha12=ead23e7999e7` | 251,476 | ✅ PDF，pymupdf/1.28.0，47 blocks，1 页，partial；blocking=`doc_cross_block_attribution`,`unverified_pdf_image`（仅版式） | ✅ PDF，47 blocks，LIVE，name/phone/email present | ✅ **REUSED**（`matched_by=email+phone`） | **PASS**（PDF 零回归） |
| **图片** | 合成 1×1…（**FIXTURE**，真实语料无图片文件） | 181 | ✅ `image/png`，Pillow 12.3.0，1 block，needs_visual=true，HARD `image_requires_vision`（**不把像素变成文字**） | ❌ `READER_FAILED(IMAGE_REQUIRES_VISION)`（无 OCR 步骤，明确拒绝） | ❌ `READER_FAILED(IMAGE_REQUIRES_VISION)`，一行未写 | **FAILED**（诚实的能力缺口：无 OCR/视觉归属） |

### 三维标签（R4，取工具**实际输出**）

| 格式 | provenance | trigger | connection | 说明 |
|---|---|---|---|---|
| RTF（读取层） | `LIVE`（resume_read basis=`FILE_BYTES_SHA256_VERIFIED`） | `MANUAL` | `CONNECTED` | 数据真实、字节 sha 可复核；本地读取器产品自己能读 |
| RTF（intake 未执行成功） | —（BLOCKED，无 labels 输出） | `MANUAL` | `CONNECTED` | 闸门在写库前拒绝 |
| DOCX / PDF（intake） | `FIXTURE` | `MANUAL` | `CONNECTED` | **注意**：intake 对 `source_kind=LOCAL_FILE` 一律标 `FIXTURE`（`application-intake.ts:2142`：LIVE 的定义是"能追到真实外部 provider"，本地文件不算）。这是既有 R4 口径，本 lane 没有改。 |
| 图片 | 文件级 `FIXTURE`（合成件） | `MANUAL` | `CONNECTED` | 真实语料无图片文件，不冒充 LIVE |

> 读取层的 `provenance=LIVE` 与 intake 的 `labels.provenance=FIXTURE` **不矛盾**：
> 前者断言"这些字节来自这份真实文件且 digest 可复核"，后者断言"来源通道不是真实外部
> provider"。两者都按各自定义如实标注，谁也没有冒充谁。

---

## 4. 测试

见 `run-log.txt` 与两套命令输出；三数口径（passed / failed / skipped）：

| 套件 | 命令 | passed | failed | skipped |
|---|---|---|---|---|
| converter（全量 + 真实语料） | `python -m pytest tests -q`（语料根由 `CORPUS_ROOT_*` 指定） | **121** | **0** | **0** |
| converter（CI 口径） | `python -m pytest tests -q --no-corpus` | **94** | **0** | **27** |
| 插件 document 层（lead 指定） | `node --test "test/document/*.test.ts"`（cwd=`dsh/dsh-recruitment`） | **187** | **0** | **0** |
| 插件相关集成/回归 | document-read + intake-docx/rtf + resume-read + label-honesty + error-diagnosability + output-schema | **55** | **0** | **0** |

原始输出：`pytest-converter-full-corpus.log` / `pytest-converter-no-corpus.log` /
`node-test-document.log` / `node-test-related.log`；机器可读汇总见 `test-counts.json`。

### 4.1 converter 全量（真实语料）

`121 passed in 959.14s (0:15:59)` —— 全量跑的是**真实语料**（77 份 PDF + 7 合成难例 + 12 条新
RTF 用例）；`--no-corpus` 的 `skipped=27` 全部是"依赖语料原件"的用例（传 `--no-corpus` 时
逐条 skip 并说明，绝不静默算通过）。新增 12 条 RTF 用例在两种口径下都跑（`test_rtf_reader.py`
不依赖语料）。

---

## 5. 复现

```powershell
cd 'D:\12412\dsh工作区\projects\recruitment-agent'
$env:RECRUITMENT_DB_PASSWORD='123456'

# 1) converter（CI 口径；不需要真实语料）
D:\Python3.12.9\python.exe -m pytest converter/tests -q --no-corpus

# 2) converter（全量；语料根按本机填）
$env:CORPUS_ROOT_TALENT_POOL='...\resume-talent-pool\.snap-cache\research\content'
$env:CORPUS_ROOT_ODOO_SAMPLES='...\proof\A\src\odoo-20.0\addons\hr_recruitment\static\applicant_cvs'
$env:CORPUS_ROOT_CODEX_CONVERTED='...\resume-md-results\work\urgent-zh-20261028\docx-src'
$env:CORPUS_ROOT_SYNTHETIC='...\converter\corpus\synthetic'
D:\Python3.12.9\python.exe -m pytest converter/tests -q

# 3) 插件 document 层
cd dsh/dsh-recruitment
node --test "test/document/*.test.ts"

# 4) 真实语料端到端（路径从 %TEMP%\recruitment-real-intake-20\corpus-paths.json 取，见旧证据）
$env:RA_E2E_RTF_PATH='...'; $env:RA_E2E_DOCX_PATH='...'; $env:RA_E2E_DOCX_NO_IDENTITY_PATH='...'; $env:RA_E2E_PDF_PATH='...'
node evidence/experiments/2026-11-14-format-coverage/run-format-e2e.mjs
```

---

## 6. 边界与未决

- **未 commit / push / checkout / stash / restore**（本 lane 没有执行任何 git 写操作）；
  工作树改动被整合提交 `4a5dfd3` / `30f501c` 带入，见 §1 末尾说明。
- **⚠️ 需要整合注意**：`test/integration/application-intake-docx.test.ts` 的 RTF 用例更新
  **仍在工作树未提交**（HEAD 里还是旧的"RTF 被拒绝"断言）。旧断言对着新代码会红
  （新行为是 `BLOCKED_BY_REVIEW`，不是 `READER_FAILED(UNSUPPORTED_MEDIA)`）——合入时必须带上这份更新。
- **RTF 仍进不了 S6 业务表**：不是格式缺口，而是身份闸门 `src/db/identity.ts::toEvidence`
  要求 `page + 4 个数的 bbox`（IR-G1"证据坐标齐全"）。RTF 没有 bbox 坐标，所以
  `buildMaterial().blocked = evidence_missing` → `BLOCKED_BY_REVIEW`。
  要让 RTF 真入库，需要**闸门语义变更**（对无坐标格式接受 `page + paragraph + quote` 作为证据），
  这不在本 lane 写范围、也不该顺手放宽；建议单开一条决策（ADR/合同口径）后再改。
- **图片格式**没有 reader/OCR：`document_read` 诚实返回 `needs_visual + HARD image_requires_vision`，
  `resume_read` / `intake` 明确拒绝。真实语料里没有图片文件（只有 PDF/DOCX/RTF），
  图片行用合成件并标 `FIXTURE`。
- **docs/19 §2.1 仍写四种媒体**：代码契约已扩第五种（RTF），差异记在
  `src/document/README.md §6.3`；`docs/**` 不在本 lane 写范围（R5 回抄欠账）。
