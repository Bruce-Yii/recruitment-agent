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

---

## 四、实装记录：纯几何版面（2026-11-14）

对应上面"下一批要补"第 2 条。**只改 `converter/src/pdf_layout.py` +
`converter/src/pdf_reader.py`**，不依赖任何外部版面模型；几何只读每个 block 的
bbox 与非空白字符数（后者只用于选主列），**不改写文本**。

### 4.1 判据（"何时才敢写 order_verified=True"）

1. **单列页（`layout_backend='geometric-order'`）**：按 x 区间重叠度聚类，取
   "非空白字符最多"的簇为主列；**通栏块**（x 跨度 >= 主列宽 90% 且与主列相交，
   或居中且宽 >= 页宽 60%）不参与列判定，按 y 夹在主列块之间；其余块必须落在
   主列内（x 与主列重叠 >= 90%）。真实简历的"居中姓名 + 左对齐正文"不再被误判。
2. **多列页（`layout_backend='geometric-columns'`）**：列间存在 >= max(8pt, 2% 页宽)
   的无块跨越竖向白缝；两侧列宽比 >= 0.28；两列不能是逐行对齐的表（逐行配对率
   < 0.45，否则必须按行读，按列读会把"公司/时间"拆开）。
3. **行内唯一**：同一视觉行（y 重叠 >= 50%）内块 x 区间不得互相重叠。
4. **行间唯一**：相邻跨行块的 y 区间不得**实质交错**。判据是
   **交叠 > 较矮块字高的 25%**，不是固定 pt。
5. **字符守恒**：重排前后 `Counter(非空白字符)` 必须完全相等，否则放弃重排并记
   `pdf_layout_unread`（兜底判定 `stream_order_issue` 保留）。
6. 只有"所有有文字的页都完成几何排序"才写 `order_verified=True` +
   `layout_backend`（质量层把"backend 非空但 order_verified=false"判 HARD，两者
   必须同进同退）；逐页后端记在 `meta.page_info[].layout_backend`。

### 4.2 为什么固定 0.5pt 是错的口径（已废弃）

相邻行 bbox 的 ascender/descender 交叠是**排版本性**：同一页里 12–14pt 字号的行
盒普遍交叠 0.6–2.5pt（约字高 5–20%），这与"上下关系不可判"无关。固定 0.5pt 是
给某一种字号调出来的常数，换字号或 OCR 重建（Tesseract/RapidOCR 的 bbox 含 padding）
就会误判。实测：严格 0.5pt 口径下，孙光宇（0.60pt）、诸葛童琳（2.47pt）两个真实
单列简历被挡在 `order_verified=False`；改成"交叠 <= 较矮块字高 25% 视为行盒噪声"
后两者通过，且"30% / 33% 字高的实质交错"仍被拒绝（负例测试覆盖，含 25% 边界）。

### 4.3 实测（本地只读快照，2026-11-14；语料 = `converter/corpus/batch2-picked.json` 45 份）

| 指标 | 改前 | 0.5pt 口径（已废弃） | 25% 字高口径（当前） |
|---|---|---|---|
| `order_verified=true` | 0/45 | 28/45 | **29/45** |
| `pdf_reading_order_unverified`（HARD） | 6 份 | 3 份 | 3 份 |
| 3 份验收样本 | 全部 False | 1 True / 2 False | **3 True** |

3 份验收样本前后：
- `个人简历-…-孙光宇.pdf`：`False/None` → `True/geometric-order`（内容流乱序被 y 重排修正：教育背景 → 科研经历 → 荣誉奖项 → 项目经历）
- `任悦平-27届产品-研究生.pdf`：`False/None` → `True/geometric-order`（整页 OCR 重建，**provenance=ocr 提示保留在 issues**）
- `诸葛童琳2027届_AIGC运营简历.pdf`：`False/None` → `True/geometric-order`（3 页全部核验）

字符守恒：45/45 文件、3/3 样本**逐页无字符丢失**（按 `Counter(非空白字符)` 复核）。

### 4.4 记录边界

- 本表是**本机快照实测**，不是 CI 结果。`codex_converted` 语料（30 份）本机缺失，
  完整 `python -m pytest tests -q` 本地 exit 2；`--no-corpus` 快照为
  **82 passed / 27 skipped / 0 failed**（skipped 全是缺语料用例，**不是全绿**）。
- 真实语料里 29 份全部走 `geometric-order`；`geometric-columns` 目前由合成 PDF
  用例覆盖（2 列 / 3 列 / 整行页眉）。多列判定对"块 bbox 相互嵌套/逐行对齐"的真实
  简历仍保守拒绝（如 Penkun 两份双列简历），宁可 False 也不误排序。
