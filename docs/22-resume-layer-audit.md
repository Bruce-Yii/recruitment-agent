# 22 · 简历层设计清单与本次事故审计（2026-11-14）

> 触发：用 45 份**真实简历**跑读取，41 份被判"要人看"，4 份"读不出"（用户逐个打开确认**都是正常简历**）。
> 本文回答两个问题：**简历层到底设计了什么**、**哪些没做好**。

---

## 一、简历层（解析层）的全部设计

按层列，共 **28 项**。每一项都对应代码或文档里的实体，不是口号。

### A. 契约层（U0）

| # | 设计 | 落在哪 |
|---|---|---|
| 1 | `DocumentContent` 统一契约，**封闭键集**，同层只能有一个真相（D-85） | `src/document/contracts/types.ts` |
| 2 | 机械校验器：**不抛异常、收集 violations**（把"不合法"变成可判定事实） | `contracts/validate.ts` |
| 3 | converter 输出 → `DocumentContent` 的**无损映射** | `contracts/map-converter.ts` |
| 4 | `provenance` 枚举：`native_text` / `docling` / `ocr` / `agent_read` / `human_confirmed` / `reader_metadata` | `contracts/types.ts` |
| 5 | `EvidenceLocator`：pdf(page+bbox) / docx(part) / image(frame) —— **每条证据都能指回原文位置** | `contracts/types.ts` |

### B. 读取层（U1）

| # | 设计 | 落在哪 |
|---|---|---|
| 6 | **按内容嗅探**选 reader，扩展名永不参与决策 | `readers/sniff.ts` |
| 7 | 四种 reader：PDF（pymupdf + converter CLI）/ DOCX（python-docx）/ PNG / JPEG | `readers/{pdf,docx,image}.ts` |
| 8 | **fail-closed**：读不出就抛 `DocumentReadError`，绝不返回"看起来 complete" | `readers/errors.ts` |
| 9 | `source_meta` 旁路：读取器证据不塞进封闭契约 | `readers/outcome.ts` |
| 10 | 输出最后一道闸 `output-guard`：不合法就抛结构化错误 | `readers/output-guard.ts` |
| 11 | 路径越界校验（`allowed_roots`）+ 原件 SHA-256 | `readers/files.ts` |

### C. 质量层（U2）

| # | 设计 | 落在哪 |
|---|---|---|
| 12 | **六个派生检查**（不依赖上游"自报合格"，自己从内容算证据） | `quality/checks.ts` |
| 13 | 稳定 issue code 表 + **未登记 code 一律按 HARD**（fail-closed） | `quality/issue-codes.ts` |
| 14 | 严重级别 `HARD`/`SOFT` + 建议动作 `suggested_action`（retry / switch_reader / vision_read / human_review） | 同上 |
| 15 | `completeness` **只降不升**：min(上游, 本层推导) | `quality/assess.ts` |
| 16 | `blocking` 语义：下游据此拒绝进入可信结构化 / S7 | `quality/assess.ts` |
| 17 | 三条不变量的可执行断言（字符保真 / 覆盖 / 完整性必须有解释） | `quality/checks.ts` |

### D. 恢复层（U2）

| # | 设计 | 落在哪 |
|---|---|---|
| 18 | `plan()` 纯函数：生成恢复计划（retry / switch_reader / vision_read / human_review），**只计划不执行** | `recovery/plan.ts` |
| 19 | 责任角色分配（`role`）+ 阻塞步（blocking step）+ 降级链（`fallback_from`） | `recovery/types.ts` |
| 20 | `vision_pages`：哪几页需要视觉补读 + `model_image_support` | 同上 |

### E. 接线层（U3）

| # | 设计 | 落在哪 |
|---|---|---|
| 21 | 强制顺序 `readDocumentDetailed → readerFactsFromSourceMeta → assess → plan` | `src/document/README.md §6.2` |
| 22 | `recruitment_document_read` 工具（2026-11-14 才补上） | `src/tools/document-read.ts` |
| 23 | **两档阻断**（D-97）：`blocking`（可信筛选）/ `blocking_for_structure`（结构化） | 同上 |

### F. 多模态兜底（D-81）

| # | 设计 | 落在哪 |
|---|---|---|
| 24 | `page_image` 渲染页面 → agent 用 `read_image` 读 → `model_text_merge` 合并校验 | `src/tools/{page-image,vision-fallback}.ts` |
| 25 | 视觉读**由 agent 做**，不自建第二个模型客户端 | D-81 |

### G. 验收设计

| # | 设计 | 落在哪 |
|---|---|---|
| 26 | `docs/11`：六维判据 + 分层门槛 + 6+4 条红线 + 13 项可执行清单 | `docs/11` |
| 27 | `docs/12`：五层故障注入矩阵（可检验/可观测/模型兜底/人工兜底/系统治理） | `docs/12` |
| 28 | 73 条解析层测试 + 合成 fixture（不碰真实个资） | `test/document/**` |

---

## 二、这次事故暴露的"没做好"

按严重程度排。**共同点：设计在，链路没接上。**

### ❌ 1. 兜底链路是断的（最严重）

设计上有四段兜底：**原生文本 → 版面 → OCR → 视觉 → 人工**。实际情况：

| 兜底段 | 设计 | 实际 |
|---|---|---|
| 版面 | `layout_backend` / `order_verified` 字段 | **写死 `None` / `False`**，从没实现 |
| OCR | `ocr_titles.py` 存在 | **只读标题，正文永远不读** |
| 视觉 | `page_image` + `read_image` + `model_text_merge` | 有工具，但 `plan()` 只**生成计划**，没有执行器 → 从没被自动触发 |
| 人工 | `human_review` 动作 | 只是打标，没有队列、没有入口 |

→ **原生文本一坏，整份就"读不出"，没有任何一级真的接手。** 4 份"读不出"就是这么来的。

### ❌ 2. 归因做成了"能拦住"，没做成"能归因"

`doc_cross_block_attribution` 能发现"公司/时间在不同块"，但**不产出归属结果**（谁属于谁），只报 HARD 拦住。
结果是 27 份被判"不可归属"——系统知道有问题，但给不出答案。

**归因能力的缺口 = 41/45 被拦的直接原因。**

### ❌ 3. 发现能力 ≫ 解决能力

- 发现侧：6 个检查 + 40 多个 issue code + 恢复计划生成器 —— 很完整
- 解决侧：**只有一个 `plan()`，没有 executor**

所以系统能告诉你"这 41 份有问题、建议这么修"，但**不能自己修**。用户看到的是一张问题清单，不是一个被修好的结果。

### ❌ 4. DOCX 文本框：读到了却扔掉

适配器已经遍历 `w:txbxContent`、把文字收进 `textbox_texts`，然后只报一句 HARD 就把文字丢了。
**比"没读"更糟——我们有数据却主动丢弃。**（已修，`babd734`）

### ❌ 5. 真实语料从没跑过

73 条测试全部用合成 fixture；真实 52 份第一次跑就暴露 4 类问题（DOCX 文本框、PDF 自定义字体编码、版面未核、语料里混入非简历）。
**验收设计（docs/11 六维）里没有"真实语料回归"这一项**——这是设计缺口，不是执行疏忽。

### ❌ 6. 判据正确，但与真实数据分布失配

docs/11 的红线是给"转换器质量"定的（印刷体、干净排版），没定义"真实简历里版式/图片的合理占比"。
结果：判据一条没错，但 41/45 触发——**标准与现实的分布没对过账**。

### ❌ 7. "读不出"的错误信息不可诊断

`排版经历.pdf` 是 2 字节空文件，报的是"content does not match magic bytes"——
用户看不出"这文件是空的"。**错误信息没回答"为什么"，只回答了"哪一步失败"。**（已修）

---

## 三、结论

简历层的**判据体系**做得不错（能准确发现问题、能分级、能定位、能给建议），
但**执行体系**是空的（发现了不会修、兜底接不上、归因给不出结果）。

一句话：**这是一套"体检报告系统"，不是一个"治病系统"。**

下一批要补的正是执行体系：
1. PDF 编码坏 → 转图 OCR（有 bbox、可审计，`provenance='ocr'`）
2. 版面 → 几何分栏，写回 `order_verified`
3. 归因 → 产出"这段经历属于哪个块"的结果，而不是只拦
4. 恢复计划 → 加 executor（至少把 OCR / 视觉 / 换 reader 三条自动跑完）
