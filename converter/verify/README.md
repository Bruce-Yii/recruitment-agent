# verify · 转换器输出的独立校验器

> 验收的不是"能抽出多少字"，而是"抽出来的每个字都有出处，抽不出来的每一处都有说明"。
> —— `work/handoff/11-pdf-acceptance-criteria.md` §0

这个目录是 doc 11 的**可执行版本**：拿"转换器的输出 JSON"+"原件 PDF"，独立判它合不合格。

## 0. 为什么要有它（以及为什么不能省）

转换器说"我合格"不算数。项目铁律 R8 是"实现者不能验收自己的工作"，
doc 12 §2① 的第一层就是"工具知道自己错了吗"。这两条落到 PDF 上只有一种形态：
**另一个人/另一段代码，拿同一份原件，把字重新数一遍。**

所以本目录的代码有一条硬约束：

> **不 import `converter/src/` 里的任何模块。**

判据所需的一切只来自两处：
1. **被检对象**——转换器输出的 JSON（`python -m src.cli <pdf>`）；
2. **基准**——用 `fitz`（PyMuPDF）独立重读原件得到的页文本、链接 URI、图形存在性。

如果校验器复用转换器的 `Counter`/`issue_severity`/`strip_unreadable`，那么转换器
改一个常量就能把自己的缺陷判成合格——校验器等于自证（这正是 R8 要防的）。
连 `HARD/SOFT` 分级也是本目录自带的一张表（`verify_output.SOFT_ISSUE_CODES`），
且**表外 code 一律按 HARD**（doc 11 §1）。注意这里有意**不用**"`unverified_` 前缀算
SOFT"那种规则：前缀规则会让一个全新 code 仅凭起名就自动降级。

## 1. 用法

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\converter

# ① 让校验器自己跑转换器两遍（这样 V8 幂等才有数据）
python -m verify.cli "D:\path\to\resume.pdf"

# ② 校验已经存在的输出（可再给第二份输出判幂等）
python -m verify.cli "D:\path\to\resume.pdf" --json out1.json --second out2.json

# ③ 当库用
python -c "import json;from verify import verify;print(verify(json.load(open('out.json',encoding='utf-8')), r'D:\path\x.pdf'))"
```

退出码：`0` = 全部通过（含无法判而跳过的项）；`1` = 有检查失败；`2` = 输入/调用错误
（不是判定结果）。`--save-dir DIR` 会把本次用到的输出 JSON 落盘，便于留证。

### 输出形状

```json
{
  "passed": false,
  "pdf": "...",
  "verifier_version": "1.0.0",
  "checks": [{"name": "V1_page_coverage", "title": "页覆盖", "ok": false,
              "detail": "第 2 页既无 block，也没有内容级 issue 声明（静默丢页）"}],
  "failed": ["V1_page_coverage"],
  "skipped": ["V8_idempotent"],
  "summary": {"total": 8, "passed": 5, "failed": 2, "skipped": 1}
}
```

三数齐报：**passed / failed / skipped**。`skipped` 只出现在"基准不可得"的情况
（原件打不开 → 字符恒等无法独立重算；没给第二次输出 → 幂等无法判），
**绝不把 skipped 冒充 passed**（doc 11 §6 E2）。

## 2. 八项检查

编号与 doc 11 的对应关系：`V1→A1`、`V2→A2+A6`、`V3→A5`、`V4→A6`、`V5→B1`、
`V6→B2`、`V7→§1 硬性`、`V8→C1`。

| 编号 | 判据（机检怎么算） | 失败长什么样 |
|---|---|---|
| **V1 页覆盖** | `meta.pages` == 原件页数；每页**要么有 block，要么有内容级 issue 声明**。有 block 缺 `location.page` 也算失败。整份未读（`encrypted_pdf`/`reader_failed`/`reader_timeout`/`pdf_no_text` 或 `meta.failed`）时页级要求豁免。 | `第 2 页既无 block，也没有内容级 issue 声明（该页 issue 只有 ['unverified_pdf_image']，不算'读不到'的声明）（静默丢页）` |
| **V2 逐页字符恒等** | 每页 `Counter(非空白)`：`block 文本（去掉链接 markdown 的 href）+ 声明剔除的坏字形 + 声明剔除的噪声` == 原件该页文本。 | `第1页字符不恒等：原件 1259 个非空白字符，输出 1259 个（缺 '巩'×1；多 '畸'×1）` |
| **V3 无凭空 URI** | 输出里所有 href（`links[]`、`block.links[]`、**以及正文 markdown 里的 `](<...>)`**）都必须是原件 `get_links()` 的真实 URI。 | `输出 2 条 href，其中 1 条不在原件 get_links() 里：'https://evil.example/fabricated'（来自 links[]）` |
| **V4 坏字形不进正文** | `blocks[].text` 与顶层 `text` 不得含 `\ufffd` / `(cid:N)`。 | `正文出现 1 处坏字形标记（doc 11 A6 要求不得出现在正文）：第1页 '\\ufffd' 附近 ...` |
| **V5 无文本页必须标 visual** | 原件里"页字符 <80 且有图形（位图或矢量）"的页，输出必须有该页的 `unread_visual_page`（或 `pdf_no_text`/`pdf_text_encoding_unread`/`pdf_layout_unread`/`visual_read_required`）声明。 | `第 [1] 页字符 <80 且有图形，但输出没有该页的 unread_visual_page/needs_visual 记录（needs_visual=False，已声明页=[]）` |
| **V6 加密/损坏必须报 code** | 用 fitz 独立判原件：打不开 → 输出必须报 `reader_failed`/`reader_timeout`；`is_encrypted` 且空密码解不开 → 必须报 `encrypted_pdf`；`is_repaired` → 必须报 `pdf_damaged_repaired`。且这些情形下 `completeness` 不得为 `complete`。 | `原件已加密且空密码解不开，输出未报 encrypted_pdf（实际 code=无）` |
| **V7 声明一致性** | `completeness=complete` 时：不得有 HARD issue、不得有任何 issue、`needs_visual` 必须为 false（doc 11 §1"任何 issue 或 needs_visual → 必须降为 partial"）。有 issue 却不是 `partial` 也失败。 | `标 complete 却有 HARD issue ['pdf_text_encoding_unread']` |
| **V8 幂等** | 同一原件两次输出，去掉时间戳/绝对路径后逐字节相同。没给第二次输出 → skipped（不冒充通过）。 | `两次输出不同：首处差异在第 812 字节附近 ...` |

### 为什么这样判（几处容易被质疑的取舍）

**V1 为什么要求"内容级 issue"而不是"任何 issue"。**
doc 11 A1 字面写"每页要么有 block，要么有 issue"。实测（见 §4 负例 1）：把某页
全部 block 删掉后，那页仍挂着一条 `unverified_pdf_image`（图片角色未核实），
按字面判 V1 会**放过整页正文丢失**。A1 的意图是"要么读到、要么说明读不到"，
一条"图片未核实"的软记录不是"这一页读不到"的声明。所以只认内容级 code
（`pdf_page_empty`/`pdf_no_text`/`unread_visual_page`/`pdf_text_encoding_unread`/
`pdf_layout_unread`/`visual_read_required`/`reader_failed`/`reader_timeout`/`encrypted_pdf`）。

**V2 为什么只允许"坏字形/控制字符"进 `encoding_removed`。**
否则删正文 + 把删掉的字谎报成"我剔除了不可解码字形"就能把恒等式配平。
普通字母不属于可声明剔除的集合，V2 会点名报错（见单测
`test_v2_cannot_launder_deleted_text_as_encoding_removal`）。

**V2 为什么允许"噪声剔除"进入恒等式。**
doc 11 §9.5 要求平台噪声排除出正文**且排除要有记录**。这里是"声明即计入"：
只要 `noise[]` 有该页的记录（页/坐标/文本）且与 `page_info.noise_removed` 对得上，
就承认它离开了正文。**声明不等于正确**——语义上"这块到底是不是平台噪声"不在
机检范围（doc 11 §4 要求人读对照），见 §5 边界 2。

**V4 为什么不检查"控制字符"。**
控制字符在转换器里已被 `strip_unreadable` 剔除并记入 `encoding_removed`，
正文里出现即已是 V2 的失败；V4 只按 doc 11 A6 的字面（`\ufffd` / `(cid:N)`）判，
避免同一个缺陷报两次不同性质的问题。

**V5 的"不适用"算通过。**
原件里没有"低文字 + 有图形"的页时，没有可声明项，V5 记为通过并在 detail 明写
"不适用"。这不是"没检查"，是空真。

## 3. V2 的链接口径（关键）

块文本里的链接写成 Markdown：`[label](<href>)`。判字符恒等时：

* **`label` 算文字**——它是页面上真实可见的词；
* **`href` 不算文字**——它是注解里的跳转目标，页面上并没有印出来。

这是转换器的设计（`content.link_md()` 把注解 URI 写成 `[可见词](<URI>)`）。
于是 `[GitHub](<https://github.com/x>)` 还原成 `GitHub`，原件该页的 `Counter`
正好对上。**如果连 href 也算文字，每加一条链接就会凭空多出一串字符，保真校验
从第一天就是红的**——这正是本校验器最容易写错、也最容易被"看起来是通过"骗过的一处。

**唯一例外：无可见文字的链接。**
注解矩形盖在图片/图标/空白上，页面上没有任何词，转换器只能拿 URI 当 label，
写作 `[https://x](<https://x>)`。此时"URL 算文字"是把这条链接表达出来的唯一
方式，但它在原件**文本层里并不存在**，所以**不能**进入字符恒等式——否则等价于
要求原件印出过这个 URL。豁免条件被刻意收窄为四条**同时**成立：

1. `label == href`（不含别的词）；
2. `href` 是原件 `get_links()` 里的真实 URI；
3. 该字面量（忽略空白）**不在**原件该页文本里；
4. detail 里**报出豁免条数**（不静默，可审计）。

四条之外一律按"label 算文字"处理。专门测试：
`test_v2_link_label_is_text_href_is_not`、`test_v2_url_as_label_link_without_visible_text`、
`test_strip_link_markdown_unit`。

## 4. 实测（doc 12 §2① 的 INJ 注入）

样本只取 `corpus/batch2-picked.json` 里的真实简历（只读，不复制、不入库）。
运行物写在系统临时目录，不进仓库。

**正例（5 份真实简历，`python -m verify.cli <pdf>`，各自跑两遍转换器）**

| 样本 | 页 | passed / failed / skipped |
|---|---|---|
| `resume.pdf`（qi-commits） | 3 | **8 / 0 / 0** |
| `AI产品经理简历.pdf`（samlaying） | 2 | **8 / 0 / 0** |
| `Chenghao_s_CV__2610__Chinese.pdf` | 1 | **8 / 0 / 0** |
| `zhaozeyu-resume.pdf` | 1 | **8 / 0 / 0** |
| `Jeevan_Siddharth_BC_Resume.pdf` | 1 | **8 / 0 / 0** |

**负例（对真实输出注入，每项只破坏一件事）**

| 注入 | 期望 | 实际 |
|---|---|---|
| 删掉第 2 页全部 38 个 blocks | V1 失败 | ✅ `V1_page_coverage`（连带 V2） |
| 把一个字符 `'巩'` 改成 `'畸'` | V2 失败 | ✅ `V2_char_identity`（无连带） |
| `links[]` + `block.links[]` 塞假 URI | V3 失败 | ✅ `V3_no_fabricated_uri`（无连带） |
| 把带 HARD issue 的输出标成 `complete` | V7 失败 | ✅ `V7_completeness_consistency`（无连带） |
| 对照：同一份输出不注入 | 通过、不误报 | ✅ passed=true |

**全量扫测（`batch2-picked.json` 全部 45 份真实简历，每份跑两遍转换器）**

```
TOTAL 45  passed=43  failed=2
```

2 份失败都是 **V2**，且是同一类**转换器真实缺陷**（不是校验器误报）：

| 样本 | 页字 | 差异 | 根因 |
|---|---|---|---|
| `唐乐-简历.pdf` | 2799 → 2825 | 多 26 字（`https://zhitu.kralai.tech/`） | 该 URL 印在一行中文里（一个"词"），词中心点落在链接注解矩形外 → `link_block()` 绑不上 → 走 fallback 又生成一个 `[URL](<URL>)` 块 → **同一个 URL 在正文里出现两次** |
| `tangle-resume.pdf` | 1836 → 1887 | 多 51 字（`https://tl66666.github.io/ztai/static/showcase.html`） | 同上 |

这两份正是 doc 11 §7① 说的"差 724 字符必须逐条解释"的形态：转换器输出比原件多字，
且多出来的能精确归因到一次链接归属失败。**校验器独立发现、可复现、不用人读就能定位。**
（本任务不改转换器，故只报不改。）

V3 全量核对：45 份里 **凭空 URI 0 条、原件真实 URI 未出现 0 条**。

**单测**：`python -m pytest tests/test_verify.py -q --noconftest` → `24 passed`。
（`--noconftest` 是必须的：仓库现有的 `tests/conftest.py` 有一个 session 级
autouse fixture，会因语料原件路径未配置而 `pytest.exit`，与本目录无关。
见 §5 边界 6。）

## 5. 已知边界（这份校验器**不**保证什么）

1. **不判语义对错。** V2 只保证"没声明的一字不差"；声明剔除的到底是坏字形还是
   被误删的正文，机检判不了（doc 11 §4 要求人读对照）。声明的剔除也不是"正确"。
   反过来的风险：把真实正文谎报成 `encoding_removed`/`noise_removed` 仍能配平
   V2——但那已经是**显式声明**（JSON 里看得见），不再是"静默丢字"，且 V1/V7
   会同时被牵动。要彻底防住只能人读。
2. **噪声剔除只验"有记录"，不验"是噪声"。** 见 §2 的取舍。
3. **URL-as-label 豁免可被用来夹带"真实 URI 文本"。** 豁免只允许 label == href
   且该 URI 在原件里真实存在，所以最多能多出一串**原件确实有**的 URL 字符；
   detail 会报豁免条数。要发现"多印了一条 URL"仍需人读。
4. **A5 的 recall 方向只告知不判失败。** V3 判"凭空 URI"（doc 11 A5 的红线那半），
   "原件真实 URI 是否全部出现"记在 detail 里（实测 45 份：凭空 0 条、漏 0 条），
   但不进 `failed`——因为"链接没被绑定"和"凭空造链接"不是同一种错，前者还可能是
   注解覆盖空白区域的正常结果。
5. **OCR 补标题会破坏 V2。** `RESUME_CONVERSION_OCR_PYTHON` 打开后转换器会往
   正文插入 `### 标题`，那是真"新增文字"，V2 必然报（这是一条正确的报错，
   不是误报）。默认关闭 OCR 时不受影响。
6. **`--noconftest` 的原因。** `tests/conftest.py` 的 `_require_corpus` 是
   session 级 autouse，语料根路径（`CORPUS_ROOT_TALENT_POOL` 等）未配置时直接
   `pytest.exit`，会让任何 `tests/` 下的测试跑不起来。本目录的测试自建 PDF、
   不依赖语料，因此用 `--noconftest` 独立跑；**没有修改那个 conftest**（不在写范围）。
7. **不判 C2/C3/D 维。** 原件读取前后 SHA256 相同、单份 ≤50s、字段三态、
   page+bbox 回链等不在八项之内（本任务只要求 A/B 维度与 §5 红线）。
   原件 SHA256 可另行用 `meta.source_sha256` 校对。
8. **`meta.pages` 只能核对"页数"，核对不了"页序"。** 页被整体替换成另一页时，
   V1/V2 会响（字符不等），但"两页互换位置"只在两页字数不同时才被 V2 抓到
   （逐页比对会错位）。doc 11 A4 的顺序问题不在本校验器范围。

## 6. 文件

| 文件 | 作用 |
|---|---|
| `verify_output.py` | 校验器主体：`read_native()`（fitz 独立读原件）+ 八项检查 + `verify()` 纯函数入口 |
| `cli.py` | `python -m verify.cli <pdf>`：跑转换器（两次）→ 校验 → 打 JSON |
| `__init__.py` | 对外入口（`verify` / `verify_files` / `read_native` / `VerifyInputError`） |
| `../tests/test_verify.py` | 24 条单测：正例 1 + V1×3 + V2×6 + V3×2 + V4×1 + V5×1 + V6×1 + V7×3 + V8×3 + 噪声声明 2 + 输入校验 1 |
