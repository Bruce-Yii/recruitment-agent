# converter · 招聘 Agent 的 PDF 读取器

输入一份 PDF，输出**带坐标证据的 blocks + 诚实的三态字段 + issues**。

不是"能抽字的脚本"：抽不出来时它必须说清楚。验收报告见 [`reports/acceptance.md`](reports/acceptance.md)（13 项逐条 + 红线 6+4）。

```
输入: PDF（只读）
输出: {
  text, blocks[{kind,text,location{page,bbox},links,provenance}],
  completeness, issues[], needs_visual, warnings[],
  meta{pages,source_sha256,backend,...},
  fields{name,phone,email,work_experience,education},   # present|absent|unreadable
  protected_attributes{...},                            # 隔离，不进筛选
  screening{...}, noise[], timeline{}
}
```

## 1. 依赖与运行

- Python 3.12（本机 `D:\Python3.12.9\python.exe`）
- `pymupdf` 1.28.0 —— **唯一** PDF 库；不联网、不下载模型
- `pytest`（测试）、`rapidocr-onnxruntime`（可选，仅 OCR 补标题时用）

```powershell
cd D:\12412\dsh工作区\projects\recruitment-os\converter

# 单份 -> JSON 到 stdout（默认在隔离子进程里跑，50s 超时）
python -m src.cli "D:\path\to\resume.pdf" --indent 1

# 只看摘要
python -m src.cli "D:\path\to\resume.pdf" --no-isolation --summary --indent 1

# 全量批跑（77 真实 + 7 合成），每份一行元数据
python -m src.batch_run --out reports/corpus-results.jsonl

# 验收测试（53 个）
python -m pytest tests -q
```

退出码：`0` = 成功产出 JSON（**即使该文件读不出来**——读不出来会体现在 `issues`/`completeness`/`fields` 里，而不是退出码）。

## 2. 模块

| 文件 | 作用 | 来源 |
|---|---|---|
| `src/content.py` | 读取契约：`block()` / `result()` / `link_md()` / `normalize()` | 抄 `resume-conversion-build/tools/conversion/content.py`，形状与语义不变 |
| `src/structure.py` | 结构层：只用字号/块高证据推标题层级 | 抄同目录 `structure.py`（子集），两处偏离见 §5 |
| `src/pdf_layout.py` | 可选版面后端：只取几何 | 抄同目录 `pdf_layout.py`；未配置时 `infer()->None` |
| `src/ocr_titles.py` | 独立进程 OCR：**只输出标题候选** | 抄同目录 `ocr_titles.py` |
| `src/issues.py` | HARD/SOFT 分级；未知 code 按 HARD | 抄同目录 `batch.py` L114-141 + 新增 code 表 |
| `src/resume_fields.py` | 招聘字段三态 / 时间线 / 平台噪声 / 受保护属性 | 本项目新写（doc 11 §9） |
| `src/pdf_reader.py` | `read_pdf()` 主实现 | 判定顺序抄同目录 `documents.py::read_pdf`（L194-444） |
| `src/reader_worker.py` | 单份读取的隔离子进程 | 本项目（超时控制用） |
| `src/cli.py` | CLI + 超时隔离 | 本项目 |
| `src/batch_run.py` | 按 manifest 批跑 | 本项目 |
| `tools/build_human_review.py` | 生成 `reports/human-review.jsonl` | 本项目 |

## 3. 判定顺序（照抄参考实现，不自行发明）

1. 加密且空密码打不开 → `encrypted_pdf`，直接返回（**绝不逐页读**：PyMuPDF 在空密码下取页会抛 `ValueError`）
2. 可选版面后端；页覆盖不符 → `pdf_layout_unread`
3. 逐页 `get_text("blocks", sort=False)` —— **保持内容流顺序**，不做 x/y 全局排序
4. 坏字形/控制字符 → `pdf_text_encoding_unread`（记 region），并从正文剔除（doc 11 A6）
5. 有后端则按几何重排，且 `Counter(非空白字符)` 必须完全相等才采用
6. 无后端时 `stream_order_issue()`：页字 <800 → HARD，≥800 → warning
7. 链接按"词中心点落在 link rect 内"归属；未定位的真实 URI 单独成块
8. 页字 <80 且有图形 → `unread_visual_page`；否则图片只记 `unverified_pdf_image`
9. 全文无 block → `pdf_no_text`；空页 → `pdf_page_empty`
10. 正文**不做任何 NFKC / 改写**（`documents.py:379-381` 的历史决定）

## 4. 三态规则（红线：`unreadable` 绝不是 `absent`）

| 情况 | 结果 |
|---|---|
| 原文有且读出 | `present` + `value` + 证据（page/bbox/sha256） |
| 原文确实没有，且**整篇读全了** | `absent` |
| 原文有但读不出 | `unreadable` + `reason` |
| **有任何"内容没读出来"的 HARD** | 五个字段一律 `unreadable`（不允许说"没有"） |
| 只有"结构/顺序"类 HARD | `work_experience`/`education` 记 `unreadable`；name/phone/email 仍可从文本层断言 |
| 有标签无值（`姓名：`、`电话：180****`） | `unreadable`（不是 `absent`） |
| 读失败/超时/加密 | 五字段全 `unreadable`，`screening.blocked_fields` 全列出 |

下游筛选必须读 `screening`：`eligible_fields` 才可用；`blocked_fields` 里的字段**不得**当作否定证据。

## 5. 与参考实现的有意偏离（都在代码里注释了）

1. **不剥 Markdown `#`**：参考实现面向 Markdown 源，会把行首 `# ` 当标题剥掉；PDF 里 `#` 是正文（实测会丢字符）。本实现只加 `level`，不改 `text`。
2. **坏字形剔除而非保留**：doc 11 A6 要求"不得出现在正文"；剔除的字符逐页记进 `meta.page_info[].encoding_removed`，用于字符恒等式审计。NUL 按参考实现口径算"格式解码"（剔除、声明，但不判 unread）。
3. **`needs_visual` 更保守**：有整页图像未读（`unread_visual_page`）时也为 true。

## 6. issue code

- 沿用：`encrypted_pdf` / `pdf_no_text` / `pdf_text_encoding_unread` / `unread_visual_page` / `pdf_layout_unread` / `pdf_reading_order_unverified` / `unverified_pdf_image` / `structure_unidentified` / `reader_failed` / `reader_timeout` / `partial_read` / `visual_read_required`
- 新增（分级见 `src/issues.py::ADDED_CODES`）：`pdf_damaged_repaired`(H) / `pdf_page_empty`(S) / `resume_field_unreadable`(H) / `resume_experience_cross_block`(H) / `platform_noise_inline_unresolved`(H) / `platform_noise_excluded`(S) / `resume_attribution_unverified`(S) / `resume_timeline_{gap,overlap,inversion,unparsed}`(S) / `resume_protected_attribute_present`(S) / `resume_ocr_heading_inserted`(S)
- **未知 code 一律按 HARD**（保守，抄 `batch.py:130`）。
- 分级覆盖：`pdf_reading_order_unverified` 在 `batch.py` 属 SOFT 前缀族，但 doc 11 A4 要求"页字 <800 必须 HARD"，本实现按 doc 11 记 HARD（见 acceptance §6.4，待 lead 裁决）。

## 7. 已知边界

- **版面几何后端未接线**：顺序只能发现不能修正（`meta.order_verified=false`）。顺序类 HARD 需人工/Agent 复核。
- **章节词表是封闭集合**：表外标题不会被识别，其内容留在上一章节内。
- **条目粒度 = 视觉行**：多条经历被合并进一个 block 时只能切出一条。
- **公司/职位不做语义抽取**：只在同一块第一行机械切分，切不干净就留空（避免张冠李戴）。
- **OCR 补标题默认关闭**：`RESUME_CONVERSION_OCR_PYTHON` 未设置时写 `ocr_title_backend_unconfigured` warning；开启后 1 页 9–36s，且可能改变章节边界。
- **`absent` 很少**：这是设计目标；不要把 `absent` 当"候选人没有这项"的强证据。

## 8. 数据边界

- 只读 `corpus/manifest.jsonl` 与 `corpus/synthetic/synthetic-manifest.jsonl` 里的路径；**不复制、不修改**原件（逐份 SHA256 复核）。
- `reports/corpus-results.jsonl` 只有元数据（无姓名/电话/邮箱/正文）。
- `reports/human-review.jsonl` 只写"看到了什么、是否一致"，不抄原文。
- 渲染出来的复核图片写在系统临时目录（`%TEMP%\pdfreview`），不进仓库。
