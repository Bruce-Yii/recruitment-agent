# src/document/ · 解析层（Issue #3 / docs/19）

## 0. 一句话裁决（2026-11-13，W0 定，不再讨论）

**解析层的唯一权威契约是 `DocumentContent`（`docs/19` §2.1）。**
`converter/` 的现有输出**不是**与它并列的第二套契约，而是它的**实现细节**：
PyMuPDF 读出来的东西必须被**无损映射**成 `DocumentContent`，映射不出来的字段要么补进契约，要么明确丢弃并写进 issues。

> 用户原话："到底哪个好，就以哪个为准呗。并不是冲突的关系，本质上都是在做这一层。"
> 所以：**同一层只能有一个真相**。旧的更好就把它吸收进新契约（例如 page/bbox、字符保真、独立校验器），
> 不保留"两套并行、下游自己挑"的形态。

## 1. 层的边界

| 概念 | 属于 | 说明 |
|---|---|---|
| `DocumentContent` / `DocumentBlock` / `EvidenceLocator` | **解析层**（本目录） | 一份材料"读出来是什么" |
| `resume` / `resume_version` / `parsed_fields` / `evidence` | **业务层**（`db/`） | 一条材料在某个候选人下的**不可变版本** |
| `Candidate` / `Application` | **业务层** | 人 / 一次招聘旅程 |

**解析版本 ≠ ResumeVersion。** 文档能读，不等于有了业务事实；两者之间隔着 Agent 结构化 + 证据校验。

## 2. 与旧 `converter` 的映射规则（U1/U3 必须照此实现）

| `converter` 输出 | `DocumentContent` | 规则 |
|---|---|---|
| `meta.source_sha256` | `asset_sha256` | 逐字 |
| `meta.pages` | `blocks[].locator.page` 的上界 | 不单独设字段 |
| `blocks[].kind` | `DocumentBlock.kind` | 需枚举映射；未知 kind → `other` + issue |
| `blocks[].text` | `DocumentBlock.text` | **逐字**，不许改写 |
| `blocks[].location{page,bbox}` | `{kind:"pdf", page, bbox, block_id}` | 逐字 |
| `blocks[].links` | `DocumentBlock.links` | href/text 保留 |
| `completeness` | `completeness` | **只有一套**，U2 不得另造 |
| `needs_visual` | `needs_visual` | 逐字 |
| `issues[].code` | `issues[].code` | **原样保留，U2 不得重命名** |
| `issues[].location` | `issues[].locator` | 同上映射 |
| — | `provenance` | 新增：PDF 原生文字 = `native_text`；DOCX = `docling`（或 reader id）；图片 = `ocr`/`agent_read` |
| — | `reader_id` / `reader_version` / `elapsed_ms` | 新增，由 reader 填 |

**硬断言（U0 验收）**：同一份 PDF，`converter` 直出的 block 数、每块文本、每块 page/bbox
与映射后的 `DocumentContent` **逐项一致**。这条不成立 = 出现第二套真相 = 本层作废重做。

## 3. 各目录职责

| 目录 | 包 | 职责 |
|---|---|---|
| `contracts/` | U0 | `DocumentContent` 类型 + 运行时校验器 + 合成样本生成器 |
| `readers/` | U1 | 格式嗅探 + PDF 桥接 + DOCX + PNG/JPG → 同一 `DocumentContent` |
| `quality/` | U2 | 消费 converter 的 issue code，产出 `blocking` / `actions`（**不产出第二个 completeness**） |
| `recovery/` | U2 | 按 issue 生成可执行恢复计划（`vision_read` 只出计划，执行走 DSH `read_image`） |

## 4. 禁止

- 在 `src/document/` 之外**新增**解析能力（旧的 `converter/` 保持为 PDF 实现，不再扩展格式）。
- 让 `DocumentContent` 与 `converter` 输出**长期并存**给下游自己挑。
- 用 Markdown / 非空字数冒充"忠实读取"。
- 把 `ocr` / `agent_read` 出来的姓名/电话/邮箱直接触发自动并人。

## 5. 收口规则（2026-11-13 追加，W0 裁决）

U0 落地后发现树上有**两个同名 `validateDocumentContent()`、两套文档类型**：
`src/document/contracts/**`（U0，权威）与 `src/document/readers/{types,validate}.ts`（U1 在 U0 落地前自己写的）。
按 D-85，**这必须立刻收口，不允许两套并存**。

**硬规则**：

1. `src/document/contracts/**` 是**唯一**类型与校验器来源。
2. `readers/**`、`quality/**`、`recovery/**` **不得**再声明自己的 `DocumentContent` / `DocumentBlock` / `EvidenceLocator`，
   必须 `import ... from '../contracts/index.ts'`。
3. `readers/validate.ts` 若保留，只能 re-export contracts 的实现；**不得**有第二份 `validateDocumentContent`。
4. 校验器语义以 contracts 版为准：**不抛异常、收集 violations**。
   reader 需要在"输出不合法"时抛错，就在 reader 层自己包一层 `throw new ReaderOutputInvalid(violations)`，不要改契约校验器的语义。
5. 合并时**删除**重复文件，不是留两份再"以哪份为准"——留两份就是 D-85 说的第三次两套权威。

**执行**：U1/U2 收尾时自己改；若它们已结束，由 W0 在 U3 前统一改，并补一条测试断言
「`src/document/{readers,quality,recovery}` 里不存在 `export function validateDocumentContent`」（防复发）。

## 6. 两条 U1 提出的裁决（2026-11-13，W0 定）

### 6.1 `provenance` 增加 `reader_metadata`（图片块无文字时用）

图片经 Pillow 读出尺寸/EXIF 后，block 的 `text` 是空的。现有枚举 `native_text|docling|ocr|agent_read|human_confirmed`
没有一个诚实值：
- `native_text` 暗示"抽到了原生文字"——图片没有；
- `ocr` / `agent_read` 暗示"模型生成过文字"——没有，写上去就是**假声明**。

**裁决**：枚举增加 **`reader_metadata`**，语义 = "该块由确定性读取器产出，只含结构/元数据，不含文字"。
图片块必须用它；`text` 必须为空字符串；`needs_visual=true` + HARD `image_requires_vision` 不变。
**禁止**为了凑枚举把图片块写成 `ocr`/`agent_read`（那是把"没读"说成"读过"）。

### 6.2 `source_meta` 走旁路，不进 `DocumentContent`

`DocumentContent` 保持**封闭键集**（D-85）。converter 的 `pages` / `page_info` / `order_verified` / `fields` /
`screening` / `timeline` 由 `readDocumentDetailed()` 的 `source_meta` 旁路返回。

**U3 接线硬要求**：必须 `const {content, source_meta} = await readDocumentDetailed(...)`，
再把 `readerFactsFromSourceMeta(source_meta)` 喂给 `assess()`。
**只消费 `readDocument()` 会丢掉 facts**，症状是每份 PDF 都命中 `doc_page_count_unverified`（HARD）。
这条要写成 U3 的集成测试断言。
