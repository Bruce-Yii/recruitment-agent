# 10 · 复用简历项目的转换层（最新版）

**来源**：`resume-talent-pool` 仓库，分支 **`codex/conversion-integrated-20261022`**（最后提交 2026-10-23）
**工作树**：`D:\12412\DshWorktrees\resume-talent-pool\conversion-integrated-20261022`
**代码**：`tools/conversion/`（`convert.py` 83KB / `display.py` 93KB / `extract.py` 48KB / `versions.py` 40KB / `pdf_layout.py` + `vision.py`）
**计划**：`docs/CONVERSION-LAYER-PLAN.md`（30KB，唯一技术计划）

> 旧链路已于 2026-10-19 由用户撤回；`stage3-refs` 上的 `convert.py` 只是停用桩。
> **要看就看上面这条分支。**

---

## 1. 它的主流程

```
本地权威快照 → 载体/结构路由 → 对应读取器 → 统一 MD → 下游判读
```

- 原件、manifest、公开捕获**只读**；不执行来源代码、不重抓、不预判资格或价值。
- **独立简历优先**：一旦定位到独立简历（PDF/Word/MD），忠实读完就结束主体发现，不再继续挖作品集。
- 二进制格式本身**不证明**文件是简历；沿"材料角色"定位，不设字数/字段数门槛。

---

## 2. 共用读取契约（`content.py`）——**直接照抄**

```python
block(kind, text, location=None, links=None) -> {"kind","text","location","links"}

result(text="", *, blocks=None, title="", completeness="complete|partial|unverified",
       issues=None, needs_visual=False, warnings=None, meta=None, links=None)
  -> {"text","blocks","title","chars","completeness","issues",
      "needs_visual","warnings","meta","links"}
```

规则（原文即约束）：

- **可读 ≠ 完整**（"Readability is not completeness"）。
- `blocks` 保留**来源定位**与**链接**直到 MD 渲染；链接跟着所属块走。
- `issues` 描述**读不到的材料**，不是对人的资格判断。
- `needs_visual=True` 或任何 `issue` → `completeness` 强制降为 `partial`。
- `pending_reads` 同时进入结果和 MD 的来源区。
- `generation_status()` 只有三种产出：`GENERATED_AUTO` / `GENERATED_PARTIAL_AUTO` / `FAILED_READ` / `NO_CONTENT`。

---

## 3. PDF 处理办法（这是你要的那部分）

### 3.1 原生通道（默认）

- **PyMuPDF 读原生文字 + URI 注释**：`page.get_text('rawdict')` 取字符/行/坐标，链接与所属块一起传递。
- 保留**页码与坐标**。
- 取消 120k/150k 字符截断。
- 跨文件只按文本+链接+相对解析上下文**精确去重**；不删数值空格，不把同标签不同链接当重复。

### 3.2 可选"阅读顺序"后端（`pdf_layout.py`）

配置 `RESUME_CONVERSION_PDF_LAYOUT` 指向隔离依赖目录（含 **PyMuPDF 1.28.0 + PyMuPDF4LLM 1.28.0 + PyMuPDF Layout 1.28.0 模型**）。

关键设计——**只借几何，不借文本**：

- 在**独立 Python 进程**里跑：`parse_document(..., use_ocr=False, force_text=True, embed_images=False, write_images=False)`
- **不接受工具改写的 Markdown**；只取 region/line 的 bbox 与 `boxclass`
- **逐行一对一归属**：每条原生文字必须唯一匹配到模型几何；以下任一情况**整页拒绝**该顺序、保留原文并报 partial：
  - 页面尺寸不符（>1pt）
  - 原生行找不到完整几何匹配
  - 旋转文字（`dir != (1,0)`）
  - 跨栏行
- `stream_order_issue()` 只**识别**原生顺序明显非单调，不猜修法。
- 50 秒超时；原件 hash 前后校验；依赖版本/模型/实现进入**指纹**，模型换掉不许复用缓存。

### 3.3 扫描件 / 图片 / 乱码

- **明确 `use_ocr=False`** —— 转换层**不用 OCR 造文本**。
- 图像、乱码、扫描件**单列**为 `needs_visual` + `pending_reads`，等人工或视觉转写，**不冒充已读**。
- Agent 转写必须**事先存在**同名 `.json` 且 `original_sha256` 与原件一致；原件变化/绑定损坏则拒绝复用。

---

## 4. 其它载体的既有结论（可直接用）

| 载体 | 已接入 | 仍待核 |
|---|---|---|
| DOCX | 段落、表格、空/合并单元格、文本框、有效页眉页脚、超链接字段、基本编号（含样式继承与独立起点） | 复杂编号、浮动布局、图像、多节、嵌入对象 |
| 文字/MD | 原生 Markdown 结构；CommonMark 识别实际/引用链接与代码示例 | 章节范围规则 |
| 旧 DOC/ODT/RTF | 可选 LibreOffice 原生后端（隔离 profile、禁宏、只读） | 图形/文本框/域转换忠实度 |
| HTML/源码 | 公开根、真实导入、同文件组件、props/children、列表、明确条件；不执行来源代码 | 未知内容关系进 pending；Svelte/Astro 仅受限语法 |

---

## 5. 它自己的诚实状态（必须引用，不能只引功能）

- 冻结批：`outputs/conversion-2026-10-23-final2` = **1020 MD（375 AUTO / 644 PARTIAL / 1 AGENT）**，另 7 失败 / 5 不可得。
- **"正常机械 80% 未证实"**；**"生成率不是质量合格率"**。
- 整层**未通过**；被审查算法为 `2f8aad22f`。
- 质量验收方式：**实际阅读成品与原件对照**，不能用字数/命中率/相似度替代。

---

## 6. 我们对 Recruitment OS 的采用决定

| 决定 | 内容 |
|---|---|
| **采用** | `content.py` 读取契约（blocks + location + links + completeness + issues + pending_reads） |
| **采用** | PDF 原生 PyMuPDF 文字 + 坐标；可选 Layout 后端只取顺序 |
| **采用** | 扫描件标 `needs_visual`，**不 OCR 造事实**（与此前"OCR + review_required"相比，这条更严也更对） |
| **采用** | 状态词与"生成率≠合格率"的口径 |
| **不采用** | 它的批次/缓存/指纹体系整包搬进招聘系统（那是转换批处理的基础设施，不是招聘域需要的） |
| **不采用** | `--work/manual` 那套 Agent 转写目录约定（我们走 DSH 工具/会话，不落文件） |

### 对 DSH 工具的影响

现有 `dsh/dsh-pdf-fix`（两行改成 pdfjs）只是"能抽出字"，**输出结构不符合上面的契约**。下一步应把它对齐：

- 输出 `{ text, blocks:[{kind,text,location:{page,bbox},links}], completeness, issues, needs_visual }`
- 扫描件返回 `needs_visual: true` + `issues:[{code:'visual_read_required'}]`，**不返回 OCR 猜测**
- 这样上层筛选/去重才不会把"抽不到"误当"没有这段经历"

---

## 7. 下一步

1. 把 `content.py` 的契约移植成 TypeScript 类型 + 校验（约 60 行），作为招聘侧读取器的统一出口。
2. 让 `dsh-pdf-fix` 输出上述结构；用同一批 10 份真实简历回归。
3. 扫描件路径先落 `needs_visual`，等视觉模型可用再补转写（用户已确认视觉模型暂不可用）。
