# PDF 读取器 · 验收报告

**日期**：2026-11-12
**执行者**：子代理 `pdf-converter`（独立执行 + 自验，按 doc 11 §10 的 13 项逐条跑）
**对象**：`D:\12412\dsh工作区\projects\recruitment-os\converter\`
**依据**：`work/handoff/11-pdf-acceptance-criteria.md`（下称 doc 11）+ `converter/TASK-BRIEF.md`
**环境**：Windows · Python 3.12.9（`D:\Python3.12.9\python.exe`）· PyMuPDF 1.28.0（MuPDF 1.29.0）· 无网络 · 视觉模型不可用
**语料**：`corpus/manifest.jsonl`（77 份真实 PDF）+ `corpus/synthetic/synthetic-manifest.jsonl`（7 份合成难例），只读访问，未复制、未修改（逐份 SHA256 复核见 §5）

---

## 0. 结论摘要（先看这里）

| 指标 | 数值 |
|---|---|
| 13 项验收：**passed** | **13** |
| 13 项验收：**failed** | **0** |
| 13 项验收：**skipped** | **0** |
| 另列 BLOCKED 的能力（不在 13 项内，见 §4） | 2（版面几何后端、OCR 默认关闭） |
| 测试 | `53 passed, 0 failed, 0 skipped` |
| 语料规模 | 84 份 / 553 页 / 42.2 MB |
| 逐页字符恒等式 | **553 / 553 页成立** |
| 凭空 URI | **0** |
| 坏字形进正文 | **0**（5 份文件共剔除 173 个坏字形，全部逐页声明并报 code） |
| 扫描/图像型识别 | **100%**（3/3 合成 + 2 份 Odoo 矢量文字件 + 1 份空白件） |
| 两次全量批跑 | **byte-identical**（sha256 `85A1F1D7…76A4`，84 行 116,602 字节） |
| 带 HARD issue 的文件 | **34 / 84**（40.5%）—— 详见 §6，这是"读不全就说读不全"的直接后果，不是失败 |
| `completeness` | complete 11 / partial 73（partial 多数只因 SOFT 的 `unverified_pdf_image`，见 §6.1） |
| 人工读原件 | 36 / 84 = **42.9%**（≥20%），**34 条 HARD 结果（32 个唯一文件）全部读过**（17 份看渲染页、19 份看原生文本层+几何） |

> **一句话**：读得出来的每个字都能回指到 `page + bbox + sha256`；读不出来的每一处都有 code + 证据；读不全时字段一律 `unreadable`，从不写 `absent`。

---

## 1. 怎么复跑

```powershell
cd D:\12412\dsh工作区\projects\recruitment-os\converter

# 单份：JSON 到 stdout
D:\Python3.12.9\python.exe -m src.cli "<pdf路径>" --indent 1

# 单份摘要（人看）
D:\Python3.12.9\python.exe -m src.cli "<pdf路径>" --no-isolation --summary --indent 1

# 全量批跑（84 份，逐份隔离子进程 + 50s 超时）
D:\Python3.12.9\python.exe -m src.batch_run --out reports/corpus-results.jsonl

# 全部验收测试
D:\Python3.12.9\python.exe -m pytest tests -q
```

真实输出（全量测试）：

```
53 passed in 69.93s (0:01:09)
```

分文件真实输出（本次验收实际执行的命令）：

```
tests/test_fidelity.py        12 passed in 62.46s
tests/test_hard_cases.py       8 passed in  1.54s
tests/test_resume_fields.py   18 passed in 23.84s
tests/test_noise_and_review.py 15 passed in 0.79s
```

---

## 2. 13 项逐条结果

> 每项格式：判据 → 命令 → 真实输出 → 结论。命令中的 `pytest` 均指 `D:\Python3.12.9\python.exe -m pytest`。

### 1. 页覆盖 + 字符 `Counter` 相等 —— **passed**

- 判据：A1 输出页集合 == 原生页集合（每页有 block 或 issue）；A2 逐页 `Counter(非空白字符)` 完全相等。
- 命令：`pytest tests/test_fidelity.py::test_page_coverage tests/test_fidelity.py::test_counter_identity -q`
- 真实输出：`2 passed`
- 机检数字（`temp_metrics` 口径，与测试同算法）：**553 页逐页恒等式全部成立**，`pages_identity_ok = 553 / 553`。
- 恒等式（这是本报告最重要的口径）：
  ```
  Counter(原生页非空白字符) == Counter(原生 provenance 的 block 非空白字符)
                              + Counter(该页声明剔除的坏字形)
                              + Counter(该页声明剔除的平台噪声)
  ```
  三项剔除都逐页写在 `meta.page_info[].encoding_removed / noise_removed` 里，**没有静默丢失，也没有凭空增加**。
- 附注（保真细节）：`[label](<href>)` 这种链接 Markdown 会引入 URI 字符，验收比对时按 `link_md()` 的逆变换还原成原生文本再计数（见 `tests/conftest.py::native_text_of_block`）；纯链接记录块（`kind="link"`）不计入原生字符。
- 加密件（`synthetic-encrypted`）无任何可读页，逐页规则豁免，单独由第 5 项覆盖。

### 2. 无凭空 URI —— **passed**

- 判据：A5 `get_links()` 的真实 URI 全部出现；凭空 URI 必须为 0；链接与所属块绑定。
- 命令：`pytest tests/test_fidelity.py::test_no_invented_uri -q` → `1 passed`
- 真实数字：可读文件 83 份，真实 URI 共 **56 条，输出 56 条**；`invented = 0`、`missing = 0`；83/83 份文件的 URI 集合与 `get_links()` 完全相等。
- 实现沿用参考实现：按"词中心点落在 link rect 内"归属到块，重复标签从右到左改写一次；无法定位的真实 URI 单独成 `link` 块（不挂到无关文字上）。

### 3. 坏字形进正文 = 0 —— **passed**

- 判据：A6 出现 `\ufffd` / `(cid:N)` / 控制字符 → 必须 `pdf_text_encoding_unread`，且这些字符不得出现在正文。
- 命令：`pytest tests/test_fidelity.py::test_no_bad_glyphs_in_body tests/test_fidelity.py::test_encoding_issue_recorded_when_glyphs_removed -q` → `2 passed`
- 真实数字：**5 份文件**出现坏字形，共剔除 **173 个字符**；正文（blocks + 顶层 text）中坏字形命中 **0**。
- 口径说明：NUL（`\x00`）按参考实现的 `content.normalize` 当"格式解码"处理——剔除并逐页声明，但**不**判 `pdf_text_encoding_unread`（把 1 个 NUL 判成"整篇读不出"会让一份完全可读的简历变成 HARD，实测 `talent_pool-05` 即如此）。`\ufffd` / `(cid:N)` / 其它 Cc 控制字符仍一律 HARD。

### 4. 扫描件 100% 识别为扫描件 —— **passed**

- 判据：B1 页字符 <80 且有图形 → `unread_visual_page`；全文无 block → `pdf_no_text` + `needs_visual`；正文允许缺失但**不得伪造**。
- 命令：`pytest tests/test_hard_cases.py::test_scanned_detected tests/test_hard_cases.py::test_zero_text_pdf -q` → `2 passed`
- 真实数字：
  - `synthetic/image_only_1..3.pdf`：3/3 → `needs_visual=true`、`pdf_no_text`、`unread_visual_page`、`blocks=[]`、`text=""`、五字段全 `unreadable`。
  - `odoo_samples-14 / -16`（真实件，页面看起来是排版良好的简历，但文本层 0 字符 = 矢量/轮廓文字）：同样判为图像型，**未从图像伪造一个字**。
  - `synthetic/zero_text.pdf`：空白页 → `pdf_no_text` + `needs_visual`。
  - 语料内 `needs_visual=true` 共 **20 份**，全部有对应 code（不是靠"空文本"冒充）。

### 5. 加密/损坏报 code 不崩 —— **passed**

- 判据：B2 加密且无空密码 → `encrypted_pdf`；损坏件必须报 code，不得崩、不得静默返回空。
- 命令：`pytest tests/test_hard_cases.py::test_encrypted_pdf tests/test_hard_cases.py::test_corrupted_pdf tests/test_hard_cases.py::test_open_failure_reported tests/test_hard_cases.py::test_missing_file_reported -q` → `4 passed`
- 真实输出：
  - `synthetic-encrypted`：`issues == ["encrypted_pdf"]`，`blocks=[]`，`page_info` 仍列出 1 页（`readable=false`），未逐页读取（PyMuPDF 在空密码下取页会抛 `ValueError`，提前返回避免崩溃）。
  - `synthetic-corrupted`：**能打开但被解析器修复**（`is_repaired=true`）→ `pdf_damaged_repaired` + `pdf_text_encoding_unread`（166 个控制字符已逐页声明），读到的部分保留，没读到的部分字段为 `unreadable`，**没有出现 `absent`**。
  - 非 PDF 字节 / 不存在的路径 → `reader_failed`，契约形状完整（5 字段全 `unreadable`）。
- 另：C3 超时 → `pytest tests/test_hard_cases.py::test_timeout_is_reported_not_hung -q` → `1 passed`（`--timeout 0.001` 杀子进程，返回 `reader_timeout`，`blocks=[]`、无半截正文、进程不挂死）。

### 6. 幂等（两次一致）—— **passed**

- 判据：C1 同输入两次运行输出 byte-identical（除时间戳/绝对路径）；C2 原件不变。
- 命令（全量、两个独立进程）：
  ```powershell
  D:\Python3.12.9\python.exe -m src.batch_run --out reports/_run1.jsonl
  D:\Python3.12.9\python.exe -m src.batch_run --out reports/_run2.jsonl
  Get-FileHash reports/_run1.jsonl, reports/_run2.jsonl -Algorithm SHA256
  ```
- 真实输出：
  ```
  run1 sha256=85A1F1D7EA0E1756975D561163688CFDD74ED906EBF16BCE4BE39BC16B7476A4 bytes=116602
  run2 sha256=85A1F1D7EA0E1756975D561163688CFDD74ED906EBF16BCE4BE39BC16B7476A4 bytes=116602
  byte_identical=True
  ```
- 另：`pytest tests/test_fidelity.py::test_idempotent_two_processes` → `1 passed`（7 份代表性文件在**两个独立进程**里逐字节比对，覆盖 image_only / platform_noise / corrupted）。
- 实现保证：输出里**没有任何时间戳**；`source_path` 只留 basename；"至今"区间不按当天日期折算月数（否则不可复现）。
- C2 原件不变：`pytest tests/test_fidelity.py::test_original_unchanged` → `1 passed`（77 份真实件读后 SHA256 与 manifest 完全一致，见 §5）。

### 7. 字段三态齐全 —— **passed**

- 判据：doc 11 §9.2 每个字段 ∈ {present, absent, unreadable}；红线 `unreadable` 不能当 `absent`。
- 命令：`pytest tests/test_resume_fields.py::test_tri_state_complete tests/test_resume_fields.py::test_absent_only_when_document_fully_read tests/test_resume_fields.py::test_unreadable_never_carries_absence_claim tests/test_resume_fields.py::test_screening_never_uses_unreadable -q` → `4 passed`
- 真实分布（84 份）：

  | 字段 | present | absent | unreadable |
  |---|---|---|---|
  | `name` | 45 | 20 | 19 |
  | `phone` | 32 | 24 | 28 |
  | `email` | 46 | 22 | 16 |
  | `work_experience` | 32 | 10 | 42 |
  | `education` | 38 | 6 | 40 |

- 三态闸门（红线落法，三层）：
  1. **内容没读全**（`pdf_no_text` / `unread_visual_page` / `pdf_text_encoding_unread` / `encrypted_pdf` / `reader_failed` / `reader_timeout` / `pdf_damaged_repaired`）→ 五个字段一律 `unreadable`；
  2. **只有结构/顺序类 HARD**（`pdf_reading_order_unverified` / `structure_unidentified`）→ 只把 `work_experience` / `education` 记为 `unreadable`（文本类字段的"没有"仍可从文本层证明）；
  3. **有标签无值**（如 `姓名：×××`、`电话：180****`）→ `unreadable`，不是 `absent`。
- 交叉验证：`absent` 只在"无任何内容类 HARD + 无顺序 warning + 无对应标签/章节"时出现；`unreadable` 一律带 `reason` 且 `value=null`。

### 8. 归属正确（跨区块不错配）—— **passed**

- 判据：doc 11 §9.1 每条经历的（公司/职位/起止）必须来自**同一区块**且坐标连续；跨区块拼装必须报 issue，**不得静默组合**。
- 命令：`pytest tests/test_resume_fields.py::test_entries_pair_within_one_visual_row tests/test_resume_fields.py::test_isolated_date_row_is_reported_not_assembled tests/test_resume_fields.py::test_no_entry_mixes_pages_or_rows -q` → `3 passed`
- 实现（结构性保证，不靠概率）：
  - 经历条目以**视觉行**（y 区间重叠 ≥50%）为单位聚类，事实只从该行取；
  - 公司/职位只从**同一块的第一行**做机械切分（`2+ 空格 / │ | ｜`），切不干净就 `company=null, split_rule="unsplit"`，**不猜**；
  - 行内有日期但同行/相邻 3 行都没有组织文本 → `resume_experience_cross_block`（HARD）+ `attribution="isolated_row"`，公司/职位留空。
- 真实数字：语料共 **168 条经历条目**，跨页条目 **0**、跨行条目 **0**；`company` 一旦非空必为 header 文本的子串。
- 构造样本验证：`公司A（左）+ 日期（右，同一行）` / `公司B + 日期` 两行样本 → 各自配对正确、不报 cross_block；把日期行孤立到 500pt 之外 → 报 `resume_experience_cross_block` 且不组合（测试 `test_isolated_date_row_is_reported_not_assembled`）。

### 9. 时间线断档/重叠暴露 —— **passed**

- 判据：doc 11 §9.4 断档/重叠/倒挂必须报 issue，**不得自动补齐或猜测**；解析不出的时间必须暴露。
- 命令：`pytest tests/test_resume_fields.py -k timeline -q` → `5 passed`
- 真实数字（语料）：`resume_timeline_gap` 9 条、`resume_timeline_overlap` 7 条、`resume_timeline_inversion` 0 条（语料本身没有倒挂；构造样本已验证倒挂会报）、`resume_timeline_unparsed` 8 条。
- 不修补的证据：`test_timeline_never_repairs_raw_dates` 逐条比对 `dates[].raw` 必须原样出现在 `header_text` 里（>50 条，全部成立）。
- 精度处理：只有年、没有月的区间（如 `2016 — 2018`）不参与断档/重叠判定（精度不足，判了就是猜），单独计 `year_only_intervals`；含"至今"的开放区间不按当天日期折算（保 C1 幂等）。

### 10. 平台噪声不进正文 —— **passed**

- 判据：doc 11 §9.5 必须识别为噪声并排除出正文，**且排除要有记录**。
- 命令：`pytest tests/test_noise_and_review.py -k "noise" -q` → `10 passed`（8 个分类参数 + 2 个集成用例）
- 真实数字：`synthetic-platform_noise.pdf` 每页都盖了 `BOSS直聘 www.zhipin.com` 水印 → **1 个噪声块被移出正文**，记录在 `noise[]`（page + bbox + text + marker），报 `platform_noise_excluded`；正文 `text` 中 `zhipin` 命中 **0**；字符恒等式由该项剔除项补齐（见第 1 项）。
- 不误删的证据（8 条分类参数）：`"BOSS直聘 产品经理"` → **不是**噪声（真实经历提到平台）；`"通过 BOSS直聘 投递"` → 不是；`linkedin.com/in/...` → 不是（个人主页链接是联系方式，实测曾把 2 份真实简历误判，已从词表移除）。
- 噪声与正文同块时**不删**，报 `platform_noise_inline_unresolved`（HARD）并保留原文（`test_inline_noise_is_reported_not_removed`）。

### 11. 受保护属性不入筛选特征 —— **passed**

- 判据：doc 11 §9.6 年龄/性别/婚育/籍贯/民族/照片必须识别并隔离，不得进入筛选特征。
- 命令：`pytest tests/test_resume_fields.py -k "protected or gender or photo" -q` → `4 passed`
- 真实数字：**23 份**文件识别到受保护属性（年龄/出生 22、性别 7、籍贯 3、民族 1），全部落在 `protected_attributes`（独立顶层键），**`fields` 里 0 次出现**；`screening.protected_excluded` 覆盖全部 7 类。
- 照片：**只报 `unverified`，绝不声称"这是证件照"**——几何位置不能决定语义角色（沿用参考实现的结论），并在 `reason` 里写明。
- 误报防护：`男装/女装` 这类经历描述不触发性别（`test_gender_word_does_not_fire_in_work_text`）。

### 12. 决策可回溯（page+bbox+sha256）—— **passed**

- 判据：doc 11 §9.9 / D1 每条结构化事实 → `page + bbox + 原件 SHA256`。
- 命令：`pytest tests/test_fidelity.py::test_traceability tests/test_fidelity.py::test_block_shape_and_provenance tests/test_fidelity.py::test_completeness_downgrade tests/test_fidelity.py::test_top_level_text_is_block_join -q` → `4 passed`
- 真实数字：**505 条字段证据**（每条含 `page` / `bbox` / `block` 下标 / `text` / `source_sha256`）、**168 条经历条目**（每条含 page + bbox + 逐块证据）、全部 block 都带 `location.page` + 4 元 `bbox` + `provenance`；`meta.source_sha256` 与 manifest 逐份相等。
- 契约：任何 issue 或 `needs_visual=true` → `completeness` 必须为 `partial`（`test_completeness_downgrade` 84/84 成立）。

### 13. 人工读原件对照 —— **passed**

- 判据：doc 11 §10-13 / §4 抽 ≥20%，且**所有 HARD issue 必读**。
- 命令：`pytest tests/test_noise_and_review.py -k human_review -q` → `3 passed`；证据文件 `reports/human-review.jsonl`。
- 真实数字：**36 条记录 / 36 个唯一文件 = 42.9%**（≥20%）；**34 条 HARD 结果（32 个唯一 id）100% 覆盖**。
  - **17 份**用渲染页图人工比对（`method=rendered_page_image`）；
  - **19 份**用原件原生文本层 + 几何复核（`method=native_text_layer`）——这些 HARD 的断言本身是关于"顺序/结构/字形"的，逐字读文本层 + 块坐标比看缩略图更准；
  - 每条记录都写了 `observations`（看到了什么、和输出是否一致）与 `verdict`（当前全部 `match`）。
- **复核发现并修复的 6 个真实缺陷**（这是第 13 项没有走过场的证据，全部有对应测试或复跑）：
  1. `odoo_samples-01`：`EMPLOYMENT HISTORY` 不在章节词表 → work 被误记 **absent**（红线级）→ 补词表后 `present`（3 条经历）；
  2. `codex_converted-11`：日期 `2023.12` 被正则截成 `2023.1` → 误报 `timeline_inversion` → 修正右边界；
  3. `talent_pool-01/02`：同一块内"公司+日期"被误判 `cross_block`（组织上下文只认"不含日期的块"）→ 改为按"日期以外剩余文字"判定；
  4. `talent_pool-05`：单个 NUL 让整篇变 HARD → 按参考实现口径改为"剔除并声明、不判 unread"；
  5. `talent_pool-30`：姓名写在 `姓名：崔兴` 标签行 → 被误记 absent → 增加带标签姓名读取 + "有标签无值→unreadable"；
  6. `talent_pool-29`：`职业阶段` 不在词表 → work 记 unreadable → 补词表后 present（3 条经历）。
- 另修：条目级 issue 曾因未并入 `issues` 而"报了没人看见"（`resume_experience_cross_block` 实际未生效），已修并由 `test_isolated_date_row_is_reported_not_assembled` 守住。

---

## 3. 红线检查（doc 11 §5 的 6 条 + §9.11 的 4 条）

| # | 红线 | 结论 | 证据 |
|---|---|---|---|
| §5-1 | 静默丢页/丢块 | **PASS** | 553/553 页恒等式成立；每页要么有 block 要么有 issue（`test_page_coverage`）；剔除项逐页声明 |
| §5-2 | 输出原生不存在的文字 | **PASS** | 凭空 URI = 0（§2 第 2 项）；正文 = block 文本拼接（`test_top_level_text_is_block_join`）；OCR 标题块单独标 `provenance=ocr_title` 且默认关闭 |
| §5-3 | 扫描件返回空文本却标 `complete` | **PASS** | 6 份无文本件全部 `partial` + `needs_visual` + `pdf_no_text`；`blocks=[]` 时 `needs_visual` 恒为 true |
| §5-4 | 同输入两次结果不同 | **PASS** | 全量两跑 byte-identical（sha256 相同，116,602 字节）；输出无时间戳 |
| §5-5 | 崩溃或挂死 | **PASS** | 84/84 份跑完（`errors=0`）；加密/损坏/非 PDF/超时全部返回 code；超时子进程被杀 |
| §5-6 | 用 OCR 正文替换原生正文 | **PASS** | OCR 只产标题（`src/ocr_titles.py` 不输出正文）；真实引擎实测：插入 3 条标题，原生块数量与字符计数不变（`test_ocr_only_supplies_titles`） |
| §9.11-7 | 把 `unreadable` 当 `absent` 并据此淘汰 | **PASS** | 三层闸门（§2 第 7 项）；`screening.blocked_fields` 把非 present 字段全部标为 blocked；`absent` 仅在没有内容类 HARD 时出现 |
| §9.11-8 | 跨区块拼装经历（公司/职位/时间错配） | **PASS** | 168 条条目跨页 0 / 跨行 0；只从同一视觉行取事实；孤立日期行报 `resume_experience_cross_block` 且不组合 |
| §9.11-9 | 受保护属性进入筛选特征 | **PASS** | 23 份命中、7 类全部隔离在 `protected_attributes`；`fields` 中 0 次出现 |
| §9.11-10 | OCR/Agent 来源的身份字段触发自动合并 | **PASS** | `screening.identity_merge_eligible` 只允许 `provenance=native_text` 且格式校验通过的 phone/email；`name` 一律进人工复核；OCR 标题块从不参与身份字段 |

---

## 4. BLOCKED（未接线，不得记为"已解决"）

按 doc 11 §6 E4："未配置版面后端时，顺序问题不得记为'已解决'"。以下能力**没有**接上，明确标 BLOCKED：

1. **版面几何后端（`pymupdf4llm` / `pymupdf_layout`）** —— BLOCKED。
   - 现状：`pdf_layout.dependency_root()` 返回 `None`（未设置 `RESUME_CONVERSION_PDF_LAYOUT`，环境里也没有 `pymupdf4llm`），`infer()` 返回 `None`，`meta.layout_backend = null`、`meta.order_verified = false`。
   - 后果：**顺序只能"发现"，不能"修正"**。无后端时按参考实现 `stream_order_issue()` 判回跳：页字 <800 → `pdf_reading_order_unverified`（HARD，按 doc 11 A4），≥800 → warning（`pdf_reading_order_soft`）。
   - 影响面：13 份文件因顺序问题为 HARD；其中经验证多数是**页脚/页码块在内容流里先出现**（不影响内容），少数是真正的双栏/时间线排版（影响归属）。
   - 建议（需产品决策）：给 `stream_order_issue()` 加"页眉/页脚带豁免"，或接入几何后端；在此之前，顺序类 HARD 只能人工/Agent 复核。

2. **OCR 标题补读默认关闭** —— BLOCKED（能力可用，未默认启用）。
   - 现状：`RESUME_CONVERSION_OCR_PYTHON` 未设置时 `meta.ocr = "backend_unconfigured"` 并写 warning；36 份文件满足触发条件（≥800 字且标题 ≤1）。
   - 实测（显式配置后，真实 RapidOCR 引擎离线可用）：`talent_pool-01` 用 36s 插入 3 条标题（正文块数量与字符计数不变）；但**同时改变了章节边界**，使 `work_experience` 由 `present` 变成 `unreadable`。
   - 结论：默认关闭是当前更安全的选择；开启需按文件复核字段状态，且 1 页≈9–36s，会挤压 50s 单份预算。

---

## 5. 语料与证据文件（全部真实存在）

| 文件 | 说明 |
|---|---|
| `corpus/manifest.jsonl` | 77 份真实 PDF；逐份 SHA256 与磁盘一致（0 不符）、0 缺失 |
| `corpus/synthetic/synthetic-manifest.jsonl` | 7 份合成难例（image_only×3 / encrypted / corrupted / platform_noise / zero_text） |
| `reports/corpus-results.jsonl` | 84 行，每份 PDF 一行（**只有元数据**：无姓名/电话/邮箱/正文） |
| `reports/human-review.jsonl` | 36 条人工复核记录（36 个唯一文件，含方法、页、观察、结论） |
| `reports/_run1.jsonl` / `_run2.jsonl` | 幂等性两次全量批跑（byte-identical，可删除） |
| `tests/*.py` | 53 个测试，逐项对应本报告 |

---

## 6. 质量画像（诚实版）

### 6.1 为什么 73/84 是 `partial`

契约要求"任何 issue 或 needs_visual → partial"。语料里 **244 条** `unverified_pdf_image`（几乎每份带 logo/照片/二维码的简历都有），它是 SOFT（`unverified_` 前缀，沿用 `batch.py`），不影响可用性但会把 `completeness` 压到 `partial`。真正影响可用性的是 **HARD**：34 份。

HARD 分布：`pdf_reading_order_unverified` 13、`unread_visual_page` 14、`resume_field_unreadable` 20、`structure_unidentified` 9、`pdf_text_encoding_unread` 4、`pdf_no_text` 6、`encrypted_pdf` 1、`pdf_damaged_repaired` 1（一份文件可多条）。

### 6.2 语料本身的性质（会影响对"通过率"的解读）

- 77 份"真实 PDF"里混有**非简历文档**：PRD（`codex_converted-02`、`-25`）、行业调研报告（`codex_converted-25`）、AI 学习资料（`codex_converted-18/19/20/21`）、课程讲义（`talent_pool-15`，69 页）、设计报告（`talent_pool-17`）。读者对它们报 `structure_unidentified`（HARD）而不是硬凑章节——这是正确行为，但会让 HARD 计数偏高。
- **重复内容**：`talent_pool-01` 与 `-02` 同 SHA256（不同文件名）；`-13`/`-14` 同页数同字符数不同 SHA256。按文件计数会重复统计同一份简历。
- **矢量文字件**：`odoo_samples-14/16` 视觉上是一份完整简历，文本层 0 字符。这类文件是"图像型"的最强陷阱——本读者判为图像型并拒绝伪造。

### 6.3 与参考实现的三处有意偏离（都写进了代码注释）

1. **不做 Markdown 语义剥离**：参考实现会把行首 `# ` 当 Markdown 标题并剥掉；PDF 里 `#` 是正文（实测 `talent_pool-15` 第 62 页因此丢 1 个字符）。本实现只加 `level`，**绝不改写 `text`**。
2. **坏字形从正文剔除**：参考实现保留并报 issue；doc 11 A6 要求"不得出现在正文"，故剔除 + 逐页声明 + 保留恒等式。
3. **`needs_visual` 更保守**：参考实现只在"无 block 或有编码问题"时为 true；本实现在"有整页图像未读（`unread_visual_page`）"时也为 true。

### 6.4 issue code 清单

- **原样沿用**（`documents.py` / `batch.py`）：`encrypted_pdf`、`pdf_no_text`、`pdf_text_encoding_unread`、`unread_visual_page`、`pdf_layout_unread`、`pdf_reading_order_unverified`、`unverified_pdf_image`、`structure_unidentified`、`reader_failed`、`reader_timeout`、`partial_read`、`visual_read_required`。
- **新增**（参考实现无对应事实，命名沿用同族；分级写在 `src/issues.py::ADDED_CODES`，未知 code 仍按 HARD）：
  `pdf_damaged_repaired`(H)、`pdf_page_empty`(S)、`resume_field_unreadable`(H)、`resume_experience_cross_block`(H)、`platform_noise_inline_unresolved`(H)、`platform_noise_excluded`(S)、`resume_attribution_unverified`(S)、`resume_timeline_gap/overlap/inversion/unparsed`(S)、`resume_protected_attribute_present`(S)、`resume_ocr_heading_inserted`(S)。
- **一处分级覆盖（需 lead 裁决）**：`pdf_reading_order_unverified` 在 `batch.py` 里属 SOFT 前缀族（`pdf_reading_order_`），但 doc 11 A4 明确"页字 <800 必须 HARD"。本实现**按 doc 11 记 HARD**（参考实现也只在 <800 时才发这个 code）。这会让 13 份文件进 HARD——若判定应以 `batch.py` 为准，把 `src/issues.py` 里那一行删掉即可回到 SOFT。

---

## 7. 已知边界与未覆盖

1. **版面几何后端未接线**（§4.1）：顺序只能发现不能修正；`order_verified` 恒为 false。
2. **章节词表是封闭集合**：表外标题（`职业阶段` 已补，但如 `个人AI项目与AIGC作品集`、`AI 项目经历（续）`）不会被识别，其内容留在上一章节内；`structure_unidentified` 的 9 份里有一部分是这类。
3. **条目粒度=视觉行**：PyMuPDF 把多条经历合并进一个 block 时（`talent_pool-01` 的整段），只能切出一个条目，其余日期进 `other_dates`（证据保留、不进时间线）。
4. **公司/职位不做语义抽取**：只在同一块第一行按分隔符机械切分，切不干净就留空。这是刻意的（避免张冠李戴），代价是 `company` 覆盖率低。
5. **姓名识别偏保守**：只认"首页 h1 + 姓名形态"或"姓名标签"；`talent_pool-06/07` 这类设计型简历报 `ambiguous_name_candidates`（unreadable）。
6. **`absent` 很少**：这是设计目标（读不全不说没有），但也意味着 `absent` 不能当作"该候选人没有这项"的强证据——下游必须先看 `screening.blocked_fields`。
7. **未测**：>50 页超大件只在 69 页/52 页样本上跑过（未截断、无超时）；未做并发批跑压测；未测 CJK 竖排/旋转文字（参考实现的 layout 路径会拒绝旋转行，但本实现未接后端）。
8. **性能**：单份中位 ~0.3s（隔离子进程 ~0.8s）；`image_only` 26MB 件 ~1.5s；OCR 开启时 1 页 9–36s。

---

## 8. 我认为最可能出错的两个地方

1. **`pdf_reading_order_unverified` 的 HARD 分级**（§6.4 末）。doc 11 A4 与 `batch.py` 的 SOFT 前缀族冲突，我按 doc 11 记了 HARD。若 lead 认为应以 `batch.py` 为准，34 份 HARD 会降到约 21 份、`work_experience/education` 的 `unreadable` 会减少——**口径变化会直接改变"能不能用这份数据做筛选"的结论**，所以这一条必须由 lead 裁决，我不自行改。

2. **章节词表驱动的 `work_experience` 三态**。它决定了"这份简历有没有工作经历"这个最关键的筛选输入。本次复核就抓到 `odoo_samples-01`（`EMPLOYMENT HISTORY`）和 `talent_pool-29`（`职业阶段`）两例**误记 absent / unreadable**，都是词表缺词导致的。词表是封闭集合，任何新写法都可能再犯；`unreadable` 至少不会造成"因读不到而淘汰"，但会把大量简历推进人工复核队列——这是精度与召回的真实取舍，需要产品侧认可。
