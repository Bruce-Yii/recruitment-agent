# TASK BRIEF · 招聘 Agent 的 PDF 读取器

**发出方**：总控（lead）
**执行方**：子代理 `pdf-converter`
**根目录**：`D:\12412\dsh工作区\projects\recruitment-os\converter\`
**验收标准**：`D:\12412\dsh工作区\projects\recruitment-os\work\handoff\11-pdf-acceptance-criteria.md`（**必读**）

---

## 0. 一句话目标

实现一个 PDF 读取器：输入一份 PDF，输出**带坐标证据的 blocks + 诚实的三态字段 + issues**，
满足 doc 11 的验收标准，并在给定语料上产出**可复跑的验收报告**。

**不是**做一个"能抽字的脚本"。抽不出来时**必须说清楚**。

---

## 1. 复用铁律（违反即返工）

**先读、再抄、最后才写。** 以下代码是已验证的实现，必须作为设计基准：

| 参考 | 路径 | 抄什么 |
|---|---|---|
| **主实现** | `D:\12412\dsh工作区\projects\resume-conversion-build\tools\conversion\documents.py`（`read_pdf()` 在 L194） | 判定顺序、issue code 命名、链接中心点归属、`Counter` 保真校验、`stream_order_issue` |
| **读取契约** | 同目录 `content.py` | `block()` / `result()` / `pending()` 的形状与语义 |
| **OCR 只补标题** | 同目录 `ocr_titles.py` | 只输出标题候选（文字+视觉高度+PDF 坐标），**正文永远来自原生文本层** |
| **版面后端（可选）** | 同目录 `pdf_layout.py` + `pdf_layout_worker.py` | 只取几何；一行不丢、字符完全一致才采用 |
| **issue 分级** | 同目录 `batch.py`（`_HARD_ISSUE_CODES` L117） | HARD/SOFT 分类；**未知 code 按 HARD** |

**禁止**：
- 自己发明一套新的 issue code 命名
- 用 OCR 正文替换原生正文（历史决定：整页覆盖会丢正确正文）
- 做毯式 NFKC（`documents.py:379-381` 明确不做）
- 引入新的 PDF 解析库（用 PyMuPDF）

---

## 2. 输出契约（必须严格）

```json
{
  "text": "...",
  "blocks": [{"kind": "paragraph|link|heading",
              "text": "...",
              "location": {"page": 3, "bbox": [x0,y0,x1,y1]},
              "links": [{"text":"...","href":"https://...","location":{...}}],
              "provenance": "native_text|ocr_title"}],
  "completeness": "complete|partial|unverified",
  "issues": [{"code": "...", "message": "...", "location": {...}}],
  "needs_visual": false,
  "warnings": [],
  "meta": {"pages": 11, "source_sha256": "...", "backend": "pymupdf"}
}
```

- 任何 `issue` 或 `needs_visual=true` → `completeness` **必须**降为 `partial`
- 未知 issue code → 按 HARD 处理
- 不改原件、不写原件目录

---

## 3. 必须实现的招聘特有字段三态

对以下字段，输出 `present` / `absent` / `unreadable` 三态之一，**不得混淆**：

| 字段 | 判定 |
|---|---|
| `name` / `phone` / `email` | 原文有且读出 = present；原文确实没有 = absent；有但读不出（坏字形/图像页）= unreadable |
| `work_experience` | 同上（每条经历须带 `page+bbox`） |
| `education` | 同上 |

**红线**：`unreadable` 绝不能当 `absent`。

---

## 4. 语料（验收用，**不要复制、不要移动原件**）

| 文件 | 内容 |
|---|---|
| `corpus/manifest.jsonl` | **77 份真实 PDF**（30 真实简历 + 17 Odoo 公开 CV + 30 Codex 转换件），含 path/sha256/pages/native_chars/tags |
| `corpus/synthetic/synthetic-manifest.jsonl` | **7 份合成难例**：image_only ×3、encrypted、corrupted、platform_noise、zero_text |

分层统计：`text_rich 73 / text_sparse 2 / image_only 2 / multi_page 23 / has_images 4`，另有合成 7。

**注意**：`corpus/synthetic/image_only_*.pdf` 是 25MB 级文件，注意超时。

---

## 5. 交付物（缺一不可）

```
converter/
├─ src/
│  ├─ content.py          # 读取契约（照抄/适配）
│  ├─ pdf_reader.py       # read_pdf() 主实现
│  ├─ ocr_titles.py       # 只补标题（可选，配置后启用）
│  └─ cli.py              # python -m src.cli <pdf> -> JSON to stdout
├─ tests/                 # pytest，覆盖 doc 11 §10 的 13 项
├─ reports/
│  ├─ acceptance.md       # 13 项逐条结果 + 红线检查
│  └─ corpus-results.jsonl# 每份 PDF 一行结果
└─ README.md              # 怎么跑、依赖、已知边界
```

---

## 6. 验收要求（你自己做，且必须诚实）

按 doc 11 §10 的 **13 项**逐条跑，**每项给命令 + 真实输出**：

1. 页覆盖 + 字符 `Counter` 相等
2. 无凭空 URI
3. 坏字形进正文 = 0
4. 扫描件 100% 识别为扫描件
5. 加密/损坏报 code 不崩
6. 幂等（两次一致）
7. 字段三态齐全
8. 归属正确（跨区块不错配）
9. 时间线断档/重叠暴露
10. 平台噪声不进正文
11. 受保护属性不入筛选特征（识别并隔离即可）
12. 决策可回溯（每条事实带 page+bbox+sha256）
13. 人工读原件对照（**至少 20% 抽样，且所有 HARD issue 必读**）

**报告格式硬要求**：
- 必须报 `passed / failed / skipped` 三个数
- `skipped > 0` **不得**宣称全绿
- 任何引用文件必须真实存在（给出路径）
- 做不到的项标 `BLOCKED` 并写原因，**不许降级成 PASS**

---

## 7. 环境与边界

- Python：`D:\Python3.12.9\python.exe`（已装 pymupdf 1.28.0、rapidocr-onnxruntime）
- **无网络**：不要下载模型/依赖；版面后端若不可用，按"未配置"处理并记 issue
- **不改原件**：只读 `manifest.jsonl` 里的路径
- **不复制简历**进 `converter/` 或任何仓库
- **不碰其它项目**（`resume-conversion-build`、`resume-talent-pool` 只读参考）
- 视觉模型**不可用**：图像型 PDF 一律 `needs_visual` + `pdf_no_text`/`unread_visual_page`，**不得伪造正文**

---

## 8. 停止条件

出现以下任一情况，**停下来如实报告**，不要硬凑：

- 某项验收做不到（标 BLOCKED + 原因）
- 语料里某类文件读不了且无法分类
- 需要引入新依赖或联网

---

## 9. 完成后回传格式

```
1. 交付物清单（路径 + 是否可运行）
2. 13 项验收结果表（passed/failed/skipped + 证据）
3. 红线检查（6+4 条，逐条 PASS/FAIL）
4. 已知边界与未覆盖项
5. 你自己认为**最可能出错**的 2 个地方
```
