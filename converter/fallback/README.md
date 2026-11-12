# fallback · 模型兜底（四件套第 3 件）

> **给读不出的一页换一招**：把它渲染成图、让（注入的）模型读、**机械校验**读回来的东西，
> 只有校验通过的才允许进入结果；校验不过 / 模型不可用，一律退回 `needs_visual`。
>
> **本文是这一层的契约。它不是"已完成"的证据**：真实模型在写这一层时不可用
> （`QUOTA: Insufficient Balance`），本层只实现接口 + 契约 + 校验 + 可 dry-run，
> 从未产生过一次真实模型读取。接线状态见 §9。

| 文件 | 步骤 | 作用 |
|---|---|---|
| `page_image.py` | **A** | 按 issue 决定渲染哪几页；PNG 写临时目录；记录 dpi / 像素 / 耗时 / 源 sha256 |
| `model_reader.py` | **B** | 注入式 `model_call(prompt, image_path) -> str`；不可用抛 `ModelUnavailable` |
| `prompt.md` | **B** | 固定提示词：逐字转录、`□` 占位、保留换行、表格不编列 |
| `verify_model_text.py` | **D** | 反幻觉校验：非空 / 长度 / 元话语 / provenance / 页号 / 重合率 / 坏字形 / 占位符 |
| `merge.py` | **E** | 校验通过的追加为新 block；不覆盖原生；记录 applied / rejected / skipped |
| `pipeline.py` | A→B→D→E | 一条链 + 失败策略（不可用即降级，不重试到死） |
| `dry_run.py` | — | 用**带标记的测试替身**跑全链路与四个负例；不联网、不伪造 |
| `tests/` | — | 70 条单测 |

依赖：`pymupdf`（已是本项目唯一 PDF 库）。**不引入任何新依赖，不导入任何模型 SDK，
没有任何网络调用**——本包在代码层面就无法联网，所以也不可能"顺手"捏造一次读取。

---

## 1. 为什么需要这一层（触发条件）

转换器（`converter/src/pdf_reader.py`）读不出一页时会发三种 page-scoped issue，
本层**只**对这三种页动手（`page_image.TRIGGER_CODES`）：

| issue code | 含义 | 渲染理由 |
|---|---|---|
| `unread_visual_page` | 页字符 <80 且有图形 | 图像页，原生文本层没有内容 |
| `pdf_text_encoding_unread` | 文本层含解不出的字形 | 原生文本残缺，需要看原页 |
| `pdf_reading_order_unverified` | 内容流顺序不可信 | 顺序要由看到版面的人（模型）重建 |

`pdf_no_text` 是**文档级** issue，不指明哪一页，**不**触发渲染（否则会把整本已经读好的
文档栅格化）。`pdf_page_empty`、`resume_field_unreadable` 同理不触发。

---

## 2. A · 渲染契约（`page_image.py`）

```python
render_page(pdf_path, page_no, *, dpi=None, out_dir=None, max_side=None) -> dict
render_pages(pdf_path, pages, *, dpi=None, out_dir=None, max_side=None) -> dict
plan_pages(result, *, pages=None) -> {"pages": [{"page": 1, "reasons": ["image_page"]}], ...}
```

返回记录（也是 `render-manifest.json` 的内容）：

```jsonc
{
  "page": 1, "page_count": 1,
  "dpi": 200, "dpi_requested": 200, "dpi_capped": false, "max_side": null,
  "pixel_size": [6889, 9742],              // 渲染后的像素尺寸（= 原图尺寸）
  "page_size_pt": [2480.0, 3507.0], "page_size_in": [34.44, 48.71],
  "source_image_px": [2480, 3507],         // 内嵌原图的像素尺寸
  "source_dpi_hint": 72.0, "oversampled": true,
  "png_path": "...\\%TEMP%\\dsh-fallback-render-xxx\\page-0001@200dpi.png",
  "png_bytes": 2193918, "png_sha256": "…",
  "render_ms": 144.14, "save_ms": 893.35, "total_ms": 1038.32,
  "source_path": "...", "source_sha256": "…", "warnings": [...]
}
```

硬规则：

1. **只渲染要的页**：没有"整本渲染"的入口；`plan_pages` 由 issue 决定页号。
2. **图片只写临时目录**：`_assert_outside_repo()` 在 `mkdir` **之前**跑，写进仓库
   （`converter/` 下）直接抛 `RenderError("render_path_in_repo")`；
   `cleanup()` 只删 `%TEMP%` 下、且名字带本模块前缀的目录，别的一律拒绝（返回 `False`）。
3. **dpi 可配**：参数 > 环境变量 `RESUME_FALLBACK_DPI` > 默认 200；范围 50–600。
   `max_side=N` 会把长边压到 N 像素以内，此时 `dpi` 是实际值、`dpi_requested` 保留原值、
   `dpi_capped=true`——**降采样显式记录，绝不静默**。
4. **记录可复现**：dpi、像素、页面几何、源 sha256、耗时全在记录里。

> **实测发现（会直接影响真实模型）**：`corpus/synthetic/image_only_1.pdf` 的页面是
> 2480×3507 **pt**（34.4×48.7 英寸），内嵌图 2480×3507 px，等效 72 dpi。
> 默认 dpi=200 会把它放大 2.78 倍渲染成 **6889×9742 = 67 MP** 的 PNG（2.19 MB，约 1.04 s）。
> 记录里因此有 `oversampled=true` 与 `long_side_px 9742 > 4000` 警告：像素更多不等于细节更多，
> 而多数视觉模型端点会把长边压到 ~4000 以下——**压回去正好丢掉这一层要读的小字**。

---

## 3. B · 模型读取契约（`model_reader.py`）

```python
read_page(png_path, page_no, *, model_call, prompt=None, model_id=None) -> dict
```

`model_call` 是注入的可调用对象，签名 `(prompt: str, image_path: str) -> str`。
本模块不 import 任何 provider、不读凭据、不开 socket。

候选返回（**是候选，不是结论**）：

```jsonc
{
  "page": 1, "text": "…", "source": "MODEL",
  "model": "…", "confidence": null,
  "confidence_note": "not provided by model_call; a number here would be invented, so none is written",
  "answer": "TEXT",                       // TEXT | EMPTY（"模型答了"，不是"通过了"）
  "chars": 101, "raw_chars": 101, "stripped_chars": 0,
  "png_sha256": "…", "png_bytes": 2193918, "prompt_sha256": "…",
  "elapsed_ms": 0.01, "text_sha256": "…", "test_double": false
}
```

失败契约：

| 情况 | 结果 |
|---|---|
| `model_call` 抛任意异常 | `ModelUnavailable`（按内容分类 `model_quota` / `model_auth` / `model_timeout` / `model_call_failed`，带 `retryable`） |
| 返回 `None` / 非 `str` | `ModelUnavailable`（`model_returned_none` / `model_bad_return_type`） |
| 返回 `""` | **不抛**：`answer="EMPTY"`，交给 D 判 `EMPTY_TEXT` 拒绝 |
| png 不存在 / 空文件 / `model_call` 不可调用 | `InputError`（`png_missing` / `png_empty` / `model_call_not_callable`） |

`confidence` **恒为 `null`**：接口只收字符串，任何数字都是编的。模型 id 记在每一页记录里
（`model_call.model_id` → 参数 → 函数名），没有 id 的读取会被 D 拒绝（`MODEL_ID_MISSING`）。

---

## 4. 固定提示词（`prompt.md`）

只做逐字转录；不翻译 / 不总结 / 不补全 / 不推断 / 不纠错；看不清写 `□`、**不得猜**；
保留原始换行与顺序；表格用简单行文本、**不编造列**；不输出前言/后记/代码块/JSON；
不描述图片；不提自己（"我无法"/"抱歉"/"作为 AI"）。页号用 `{{PAGE_NO}}` 注入。

---

## 5. D · 校验（`verify_model_text.py`）— 防幻觉的核心

```python
verify(read, *, native_text=None, page=None, is_image_page=False, min_overlap=0.2)
    -> {"ok": bool, "reasons": [{"code", "message", "severity"}], "codes": [...], "stats": {...}}
```

| # | code | 判据 |
|---|---|---|
| 1 | `EMPTY_TEXT` / `TEXT_TOO_SHORT` / `TEXT_TOO_LONG` / `TEXT_NOT_STRING` | 非空、>10 字符、≤20000 字符 |
| 2 | `META_DISCOURSE` | `抱歉`/`对不起`/`很遗憾`、`我无法读取`、`作为AI`、`as an AI`、`I'm sorry`、`unable to read`… |
| 3 | `SOURCE_NOT_MODEL` / `NATIVE_MIXED` | 必须 `source="MODEL"`；不得携带 `native_text` / `provenance=native_text\|ocr_title` |
| 4 | `NATIVE_OVERLAP_LOW` | 与同页原生文本的字符重合率 < **0.2** 判可疑 |
| 5 | `PAGE_MISSING` / `PAGE_MISMATCH` / `MODEL_ID_MISSING` | 必须标明页号、且与期望页一致、必须能追到模型 id |
| + | `BAD_GLYPH` | 模型文本不得含 `U+FFFD` / `(cid:N)` / 控制字符（doc 11 A6） |
| + | `PLACEHOLDER_HEAVY` | `□` 占可见字符 >50% = 没读出来，只是体面地放弃 |
| + | `OUTPUT_WRAPPED` | 代码块 / JSON / "以下是转录内容：" 前言 = 没按固定提示词来 |

重合率口径：

```
char_overlap = |非空白字符(model) ∩ 非空白字符(native)| / |非空白字符(model)|   （ASCII 不分大小写）
```

分母是**模型说的字**，回答的是"模型说的有多少真在这页上"。图像页没有原生文本可比，
`stats.overlap=null`、`overlap_note="skipped: …"`——**记为 skipped，绝不记为 passed**。
另加一条更严的（规范之外）：对空格分词文本，模型词重叠率 <0.1 也拒绝
（`NATIVE_TOKEN_OVERLAP_LOW`）。理由：英文页面里，一段完全无关的英文仍能拿到很高的**字符**
重合率（都是 a–z），只靠字符率拦不住编造的英文段落。

**不对称是刻意的**：误拒的代价是一条人工队列；误收的代价是候选人档案里出现编造的文字。
所有规则 fail-closed。

---

## 6. E · 合并（`merge.py`）

```python
merge_model_reads(result, reads, *, run_id=None, planned_pages=None, now=None,
                  prompt_sha256=None) -> dict     # 返回深拷贝，不改入参
```

* 通过的读 → **追加**一个 block：

  ```jsonc
  { "kind": "paragraph", "text": "…",
    "location": {"page": 1, "bbox": null},
    "links": [], "provenance": "model_read", "source_class": "agent_read",
    "model_read": {"applied": true, "model": "…", "dpi": 200, "png_sha256": "…", "…": "…"},
    "evidence": {"source": "MODEL", "bbox_available": false, "text_sha256": "…",
                 "note": "no bbox: cannot satisfy doc 11 D1; identity fields → human review (D3)"} }
  ```

* **不覆盖**：原生 block 原样保留、顺序不变；**`text` 字段一字不改**
  （所以 doc 11 A2 的 `Counter` 保真校验在合并产物上仍然成立）。
  另给 `text_native_only: true` 与 `text_with_model_read`（可选消费）。
* **不洗白**：`issues` / `completeness` / `needs_visual` 一律不变。模型读到了 ≠ 这一页可以
  标 `complete`；清除 `needs_visual` 是 ④ 人工层的决定，不是本层的权限。
* 三份账：`model_read_applied` / `model_read_rejected` / `model_read_skipped`，
  每条含 page、chars、`text_sha256`、model、dpi、verify 统计；**被拒的文本不落盘**（只留哈希与原因）。
* 机械去重与防串档：同一页第二次合并 → `ALREADY_APPLIED`；一次给两页同页 → `DUPLICATE_PAGE`；
  读来自别的文件（sha 不符）→ `SOURCE_SHA_MISMATCH`；页不在计划内 → `PAGE_NOT_PLANNED`；
  调用方自己塞的 `{"ok": true}` **不予采信**，merge 自己重跑校验。
* `warnings` 追加 `model_read_applied: page N (...)`，② 可观测层无需新 schema 就能查到。

### `provenance` 的契约张力（需要 lead 裁决）

doc 11 §1 / D2 的 provenance 封闭集合是 `native_text | ocr_title | agent_read`，
而本任务要求 `provenance="model_read"`。本层同时写两个字段：

* `provenance="model_read"` —— 精确说明"模型看渲染图读出来的"；
* `source_class="agent_read"` —— 保留 doc 11 三元组口径，使 D3（`agent_read` 的身份字段
  只能进人工复核）不会因为出现新枚举值而漏判。

**建议**：接线前把 doc 11 的枚举扩为四值并在 D3 里点名 `model_read`；否则任何
`switch (provenance)` 的消费方都可能把 `model_read` 当成"未知 = 可自动合并"。
在那之前，本层**不**改 `fields` / `screening`：模型文本不产生任何"已验证字段"。

---

## 7. 失败矩阵（A→B→D→E）

| 输入 | 结果 | 落点 |
|---|---|---|
| 图像页 + 模型正常读 | 追加 1 block，`status=APPLIED` | `model_read_applied` |
| 模型答 `""` | 拒绝，`status=REJECTED` | `EMPTY_TEXT` |
| 模型答"抱歉，我无法读取这张图片" | 拒绝 | `META_DISCOURSE` |
| 模型答与原生文本无关 | 拒绝 | `NATIVE_OVERLAP_LOW`（+ `NATIVE_TOKEN_OVERLAP_LOW`） |
| 模型答被代码块/前言包裹 | 拒绝 | `OUTPUT_WRAPPED` |
| 模型不可用（异常/配额） | **降级**，不改结果，`status=UNAVAILABLE` | `model_unavailable` + `model_quota` |
| 渲染失败 / 加密 / 缺页 | 记录 code，继续别的页 | `render_errors[]` |
| 转换器结果与磁盘原件 sha 不符 | 拒绝发送模型 | `SOURCE_SHA_MISMATCH` |
| 没有任何触发 issue | 不渲染、不调模型 | `status=NO_TRIGGER` |

`pipeline.run_fallback()` 在第一次 `ModelUnavailable` 后停止继续调用
（配额/鉴权类错误重试没有意义），把剩余页记进 `pages_skipped`——**不无限重试**。

---

## 8. 怎么跑

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\converter

# 单测（70 条）
python -m pytest fallback/tests -q

# 只渲染（步骤 A）：真实 image_only 页，给出尺寸与耗时
python -m fallback.dry_run --pdf corpus\synthetic\image_only_1.pdf --page 1 --render-only

# 全链路 + 测试替身（明示 TEST DOUBLE，不是模型输出）
python -m fallback.dry_run --pdf corpus\synthetic\image_only_1.pdf --page 1 --fake ok

# 四个负例
python -m fallback.dry_run --pdf corpus\synthetic\image_only_1.pdf --page 1 --fake empty
python -m fallback.dry_run --pdf corpus\synthetic\image_only_1.pdf --page 1 --fake refusal
python -m fallback.dry_run --pdf corpus\synthetic\image_only_1.pdf --page 1 --fake unavailable
python -m fallback.dry_run --synthetic --page 1 --fake unrelated --dpi 96
```

`dry_run` 走**真实转换器**（`python -m src.cli --no-isolation`，只读）拿 issue，
再用替身跑 B/D/E。渲染图写 `%TEMP%\dsh-fallback-render-*`，跑完删除（`--keep-images` 保留）。
`--json <path>` 写出 `{converter_result, merged, report}`，**默认不写文件**。

---

## 9. 诚实边界（未接线 = BLOCKED）

1. **没有接过真实模型**。写这一层时 `QUOTA: Insufficient Balance`，`model_reader` 只有接口。
   所有"成功"样例的文本都来自 `test-double/fixed-text`，记录里 `test_double=true`；
   真实模型接上后必须重跑 §8 全部命令，并重新评估 `prompt.md` 与降采样策略。
2. **没接进转换器 / DSH 工具入口**。写范围只有 `converter/fallback/`；按 E4/R2，
   "包内可跑、入口不可达" = **BLOCKED**。接线点是：`src/pdf_reader.py` 返回后由调用方决定
   `run_fallback()`，或 `src/cli.py` 加 `--fallback-model`；`src/` 与 `dsh/` 不在本层写范围。
3. **没有真实语料的模型读取样本**。图像页的 `overlap` 恒为 `null`（没有原生文本可比），
   这一页读得对不对，本层只能证明"格式没坏、没拒绝、没编造元话语"，**不能证明内容正确**。
   内容正确性只能靠人工抽样（doc 11 §4 的双轨报告）。
4. **顺序不可信页的合并会产生重复文本**：这类页原生文本是完整的，追加模型文本后
   `blocks` 里同一页有两份内容（`text` 未变、`text_with_model_read` 会重复）。本层只负责
   标 `provenance`，是否采用是下游策略；不要把它当作"去重后的正文"。

---

## 10. 我认为最容易出问题的两点

1. **渲染分辨率与"看清"的矛盾**（真实模型接上后第一个炸的点）：语料里的图像页是
   `2480×3507 pt` 的巨型页面，默认 dpi=200 产出 67 MP、长边 9742 px 的 PNG；
   视觉端点会把它压到 ~1568–4000 px，而这里的小字正是"必须放大才看得见"的那部分。
   压回去 → 读到的是模糊的 `□`；不压 → 请求超限。正确的做法是按 `source_dpi_hint`
   渲染（本例 72 dpi 就够），并对"是否需要分块（上/下半页各一张）"做显式决策，
   而不是把 dpi 当性能参数调。
2. **overlap 校验对"同语言不同内容"偏弱**：字符重合率只对"完全无关"（不同语种、乱码、
   拒答）敏感；一段编造的同语种文字可以轻易超过 0.2。本层加了词重叠率补丁，但它只对
   空格分词语言有效，中文简历没有等价物。真实模型接上后，如果发现中文页的幻觉漏检，
   正确的改法是加**版面锚点**（页眉/日期/公司名/坐标顺序）做交叉验证，而不是把阈值从
   0.2 调到 0.5 —— 后者只会让正常读取也大量被拒。
