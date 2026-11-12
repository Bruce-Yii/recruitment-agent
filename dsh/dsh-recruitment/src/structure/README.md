# structure · 确定性序列化层 + 校验层

> 输入是**已经解析好的转换器输出**，输出是**行文本 + 索引 + 判定**。
> 这一层不调用模型、不联网、不读文件、不写文件、不取当前时间：全部是纯函数。

| 文件 | 作用 |
|---|---|
| `serialize.ts` | 转换器 `blocks[]` → 带 id 的行文本 + `block_index` |
| `validate.ts` | 模型结果 × `block_index` × 原始块文本 → `{accepted, rejected[], issues[]}` |
| `index.ts` | barrel（**未**接进 `src/index.ts`，见 §7） |

依赖：只有 Node 内置的 `node:crypto`（算 sha256）。无第三方包。

---

## 1. 行文本契约（格式固定，不许改）

```
#12 | p1 | 工作经历
#13 | p1 | 2020.07-2023.06  星河科技  后端工程师
```

- **id 从 1 开始连续编号**，一个 block 一行；
- 块内换行写成 `⏎`，保证「一行一块」；
- 超过 `MAX_BLOCK_CHARS = 500` 字的块，按句子 / 换行边界切成多行，**每片各占一个 id**；
- **不丢弃任何 block**：空块也占一个 id，`block_index` 里 `empty=true`，行文本形如 `#6 | p2 | `；
- 拿不到页号时写 `p?`（不编造页号），`block_index.page = null`。

切分规则（确定性）：

1. 从限长处往回找最近的可切点；可切点 = 换行 / `。！？；…` / 后跟空白的 `. ! ? ;`；
2. 片段最短 `MIN_PIECE_CHARS = 64` 字，避免切出碎句；
3. 窗口内没有可切点就**硬切在 500**；
4. 片段是**精确切片**：全部片段按序拼接 == 原文（不丢字、不补字、不改写）；
5. 按**码点**切，emoji 等代理对不会被切成半个。

## 2. `block_index`（id → page / bbox / sha256）

```jsonc
{
  "version": 1,
  "max_block_chars": 500,
  "source_sha256": "<PDF 原件 sha256，取自 converter meta>",
  "blocks": 103,
  "entries": [
    {
      "id": 12, "block_no": 12,
      "page": 1, "bbox": [28.92, 209.95, 566.39, 226.24],
      "sha256": "<该行文本的 sha256>", "source_sha256": "<同上>",
      "chars": 32, "kind": "paragraph", "provenance": "native_text",
      "empty": false,
      "parent_id": null, "piece_index": 0, "piece_count": 1,
      "piece_start": 0, "piece_end": 32
    }
  ]
}
```

- `sha256` 打在**文本**上：校验层据此证明「模型引用的这个 id 对应的原文」与序列化时交给模型的是同一份；
- `source_sha256` 是**PDF 原件**的 sha256（doc 11 §9.9 要的 page + bbox + 原件 SHA256）；
- 切分块的 `parent_id` = 该块**首段的 id**（同一块的所有片段 `parent_id` 相同）；
- `piece_start` / `piece_end` 是**码点偏移**，供校验层精确还原该 id 的文本。

## 3. 模型结果契约

> **权威是 `contracts/schema.json`**（+ 它的散文版 `contracts/prompt.md`）。本节只是索引：
> 校验器认的每个位置都能在里面找到 `$defs` 路径。

```jsonc
{
  "prompt_version": "1.0.0",
  "schema_version": "1.0.0",
  "block_count": 4,
  "sections": [                       // $defs.section：只有 label / block_ids / ignored
    { "label": "contact", "block_ids": ["1", "2"] },
    { "label": "work_experience", "block_ids": ["3", "4"] },
    { "label": "other", "block_ids": ["5"], "ignored": { "reason": "empty_or_symbol_only" } }
  ],
  "fields": {                         // $defs.fields：五个键恒在（顶层，不在 section 里）
    "name":  { "state": "present", "value": "张三", "block_ids": ["1"] },          // $defs.identity_field
    "phone": { "state": "present", "value": "13800001234", "block_ids": ["2"] },
    "email": { "state": "absent", "block_ids": [], "reason": "not_mentioned" },
    "work_experience": {              // $defs.structural_field：条目在 value[]，不是 entries[]
      "state": "present",
      "block_ids": ["4"],
      "value": [
        {                             // $defs.work_entry：事实键平铺，没有 fields 子对象
          "company": { "value": "星河科技", "block_ids": ["4"] },   // $defs.fact
          "title":   { "value": "后端工程师", "block_ids": ["4"] },
          "start":   { "value": "2020.07", "block_ids": ["4"] },
          "end":     { "value": "2023.06", "block_ids": ["4"] },
          "block_ids": ["4"],
          "attribution": "single_block"
        }
      ]
    },
    "education": { "state": "absent", "block_ids": [], "reason": "not_mentioned" }   // $defs.education_field
  }
}
```

条目数组字段（`work_experience` / `education`）的条目在 **`value[]`**；`education` 的条目键是
`school` / `major` / `degree` / `start` / `end`，`work_experience` 的是 `company` / `title` / `start` / `end`。

引用只有一种写法：`block_ids`（连续且有序；契约里 id 是**字符串** `"12"`，整数也接受）。
不连续 / 逆序 → `BLOCK_IDS_NOT_CONSECUTIVE`。

封闭集合：

- `label ∈ {contact, summary, work_experience, internship, project, research, education, skill, award, certificate, publication, self_evaluation, other}`；
- `state ∈ {present, absent, unreadable}`；
- 必填（省略即**拒绝**，没有就写 `absent`）：
  - 顶层 `fields`：`name` / `phone` / `email` / `work_experience` / `education`（`$defs.fields.required`）；
  - `work_experience` 每个条目：`company` / `title` / `start` / `end`（`$defs.work_entry.required` 的事实键）；
  - `education` 每个条目：`school` / `major` / `degree` / `start` / `end`（`$defs.education_entry.required` 的事实键）。
- `present` → 必须带非空 `value` + 非空 `block_ids`；`absent` / `unreadable` → 不得带 `value`
  （`absent` 还必须 `block_ids: []`）；`unreadable` 还必须带 `reason`；
- 每个条目还必须带 `block_ids` 与 `attribution ∈ {single_block, same_row_multi_block}`。

**契约里不存在的位置**（`sections[].fields`、`sections[].entries`、`entries[].fields`、
顶层 `ignored[]`、`entry.block_id` 这类表外键）一律 `SCHEMA_INVALID`——**不静默忽略**，
否则一份「校验通过」的输出可能根本没被检查过。

## 4. 八条规则 → code

| # | 规则 | 失败即拒绝的 code |
|---|---|---|
| 1 | id 存在性 | `UNKNOWN_BLOCK_ID` |
| 2 | 值必须能在「引用块按序拼接后的文本」里逐字找到（D-30；三种固定归一化见 §4.1） | `VALUE_NOT_IN_BLOCK` / `BLOCK_IDS_NOT_CONSECUTIVE` |
| 3 | 每块**恰好**归入一个 section（D-31；或该 section 带合法 `ignored.reason`） | `UNCOVERED_BLOCK` / `BLOCK_DUPLICATED` / `IGNORED_MISSING_REASON` / `IGNORED_BLOCK_REFERENCED` |
| 4 | 标签枚举 | `UNKNOWN_SECTION_LABEL` |
| 5 | 状态枚举 | `STATE_MISSING` / `STATE_INVALID` / `STATE_VALUE_CONFLICT` |
| 6 | phone / email / date 专项 | `PHONE_INVALID` / `PHONE_DIGITS_MISMATCH` / `EMAIL_INVALID` / `EMAIL_NOT_IN_SOURCE` / `DATE_INVALID` / `DATE_NOT_IN_SOURCE` |
| 7 | 跨字段一致性（**软**：记 issue 不拒绝） | `WORK_PERIOD_INVERTED` / `WORK_PERIOD_OVERLAP` |
| 8 | 不允许省略字段 | `MISSING_FIELD` / `MISSING_ENTRY_FIELD` |

另外四条（都是「账要平」的机械检查，不是业务判断）：

- `BLOCK_INDEX_INTEGRITY`：索引的 sha256 / `block_no` / 片段偏移与传入的原始块文本对不上；
  **或** `block_index` 版本不是 1（`BLOCK_INDEX_VERSION_UNSUPPORTED`）；
- `UNREADABLE_MISSING_REASON`：`unreadable` 必须说明为什么读不出来（doc 11 §9.2 红线）；
- `BLOCK_IDS_NOT_SUPERSET`：条目 block_ids 必须覆盖它各事实引用的块，字段 block_ids 必须覆盖它各条目
  引用的块（`schema.json` `$comment` 不变量 (3)：字段级 block_ids 是 entries 的超集）；
- `SCHEMA_INVALID`：形状不对（不是对象 / 数组 / 契约里没有的键 / 事实缺 `value` / 条目缺
  `attribution` / `absent` 却引用了块等）。

### 4.1 值匹配的三种**固定**归一化（D-30 §3）

块粒度是**视觉行**：一句话会跨块（`#6` 结尾「…佣金结算及分账」+ `#7` 开头「中台等复杂业务。」），
PDF 的连字符断行也会把 `semantics` 断成 `seman-` / `tics`。所以 `value` 匹配的对象是
**`block_ids` 按序拼接后的文本**，并且只允许下面三种归一化（顺序固定，没有第四种）：

| # | 归一化 | 例子 |
|---|---|---|
| 1 | **连字符断行**：连字符后接换行（`\n` / `\r\n`）或 `⏎`、再接小写字母时，删掉连字符与换行 | `seman-` + `tics` → `semantics` |
| 2 | `⏎` 按它代替的那个换行处理（即按空白） | `13800001234⏎邮箱` → `13800001234 邮箱` |
| 3 | 折叠空白：连续空白折成一个空格，再去首尾空白 | `a\n\n  b` → `a b` |

三条硬约束：

- **只用于匹配，不改原文**：`block_index` 里的文本与 `sha256` 一个字符都不动（D-30 §4，
  所以 doc 11 A2 的字符恒等不受影响）；
- 块边界只有两种固定拼法：**直接相接**或**当作一个空白**（中文跨行没有空格，英文有词间空格），
  两种都试，任一命中即通过；
- **不是「语义相等」**（D-32）：`2020年7月` ≠ `2020.07`、`星河科技有限公司` ≠ `星河科技`、
  删掉空格 ≠ 折叠空格；这些都必须被 `VALUE_NOT_IN_BLOCK` 拒绝。
  规范化留给下游用 `parseDateText()` 做，序列化层不改写任何字。

### 4.2 覆盖 / 分区的口径（D-31）

- **每个 block 恰好出现在一个 section 的 `block_ids` 里**——重复出现（跨 section 或同一 section
  写两次）→ `BLOCK_DUPLICATED`。旧口径「被引用过就算覆盖」已作废：把剩下的 id 全塞进
  `block_ids` 只能证明「没漏块」，**不能**证明抽取正确（D-31 §4）。
- `ignored` 是 section 上的对象（`{ reason, detail? }`）：存在即表示该 section 的这些块不参与
  字段抽取。`reason` 必须非空，且这些块**不得被任何字段 / 条目 / 事实引用**
  （`IGNORED_BLOCK_REFERENCED`）。`ignored` 缺 `reason` 时这些块既不算归类也不算排除，
  覆盖率会再报一次 `UNCOVERED_BLOCK`。
- **字段与 section 之间没有归属绑定**：`prompt.md §6.1` 明写「取值不受 section 限制」，
  手机号落在页脚 / 别的章节是常态。所以本层**不再**要求「字段的块属于该字段所在 section」
  （旧的 `FIELD_BLOCK_NOT_IN_SECTION` 与契约冲突，已删除）。
- 空块也一样要归类，要么被放进某个 section，要么所在的 section 带合法的 `ignored.reason`
  （空块不丢是序列化层的承诺，校验层负责盯住它真的被处理了）。
- **「连续且有序」只约束用于拼接匹配的引用**（字段 / 条目 / 事实的 `block_ids`）；
  `section.block_ids` 是**分区清单**，只要求「每个 id 只出现一次」，允许不相邻
  （一个 section 的块被另一个 section 的标题隔开是正常的）。
- 条目 / 字段的 `block_ids` 是对分区块的**嵌套引用**，不计入分区次数（否则 work section
  里每个条目都会把自己的块「放第二遍」）；但它们之间要满足超集关系（见 §4）。

数字专项的具体判法：

- **phone**：`^\+?\d[\d\-\s]{6,}$`（任务书给定）；并且把值在原文里的**数字串**取出来，归一化（只留数字）后必须与值一致——
  `13800001234` 引用自 `138000012345` 会报 `PHONE_DIGITS_MISMATCH`；
- **email**：本地部分 + 带点域名；并且 `value.toLowerCase()` 必须能在原文里找到（大小写不作为凭据）；
- **date**：能解析成 `YYYY` / `YYYY-MM` / `YYYY-MM-DD`（也接受语料里的 `2020.07` / `2020年7月`，以及表示开放区间的 `至今` / `present`）；
  并且值在原文里必须是一个**完整日期记号**（前后不接数字，避免引用更长数字串的截断）。

> **注意一个刻意设计**：规则 2 要求 `value` 能在**原文（引用块拼接后）**里逐字找到，所以日期必须
> **逐字引用原文写法**（`2020.07` 而不是 `2020-07`），邮箱大小写也必须与原文一致
> （`EMAIL_NOT_IN_SOURCE` 只在小写后也找不到时补一刀）。D-30 只增加了三种固定归一化，
> **没有**增加任何「等价写法」：日期 / 数字的规范化留给下游用 `parseDateText()` 做，本层不改写任何字。

## 5. 怎么跑

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment

# 本层单测（74 条，Node 24 直接跑 .ts，无需构建）
node --test "test/structure/*.test.ts"

# 包根全量（必须绿：手动 harness 已挪出 test/，不再被 node --test 发现）
node --test

# 真实数据验收（3 份 batch2 PDF + 6 个负向样本）
# ⚠️ 仍是旧的 section 内嵌形状（sections[].fields / entries[].fields），需要单独更新；
#    它不在 src/structure 的写范围内，所以本层没有改它。
node manual/run-acceptance.mjs            # 读 %TEMP% 缓存
node manual/run-acceptance.mjs --live     # 强制重跑转换器

# 手动单元级 harness（需要 DSH_HOME 的 profiles 模块；不是自动测试，需显式执行）
node manual/harness.manual.mjs
```

> **为什么 harness 在 `manual/`**：`node --test` 的默认发现规则里有 `**/test/**/*.{mjs,js,cjs}`
> ——**test/ 目录下的所有脚本都会被当测试跑**，改文件名躲不掉（已实测：改名后仍被发现）。
> 而那个 harness 需要 `DSH_HOME` 里的 profiles 模块、且 `apply` 时没传 config（调用即 `NOT_CONFIGURED`），
> 所以它只能作为手动脚本存在于 `test/` 之外。
> 包根 `node --test` 还会跑 `test/live-read.mjs`、`test/negative.mjs`、`test/structure-wiring.mjs`
> 与 `test/structure/run-acceptance.mjs`（它们读本地真实 PDF / `%TEMP%` 缓存，不联网、不写仓库）。

`run-acceptance.mjs` 只写 `%TEMP%\structure-accept\`，**不写仓库**。

## 6. 判定语义

- `accepted === (rejected.length === 0)`；`rejected` 只装 `severity = 'hard'` 的 issue；
- `issues` 同时装 hard 和 soft，软校验只进这里；
- `stats` 给出 `index_entries / covered / ignored / fields / entries / hard / soft`，用于对账。

## 7. 接线状态

本层现在通过 `src/tools/structure-tools.ts` 注册成两个工具（`recruitment_resume_serialize` /
`recruitment_structure_validate`），由 `src/index.ts` 装配——这一段是 tools 层做的，不在本层写范围。
本层代码本身仍是纯函数：不读文件、不联网、不取当前时间，任何调用方都能直接复用。

## 8. 我认为最容易出问题的两点

1. **`value` 必须逐字可回查**这一条把「模型顺手把日期 / 公司名规范化」变成硬失败。这是刻意的（防幻觉）；
   D-30 之后仍然如此——放开的只有「跨连续块的拼接」和三种固定归一化，**没有**放开语义相等（D-32）。
   如果实测失败率仍然过高，正确的改法是在结果契约里加一个 `raw_value` 字段，而不是放宽规则 2。
2. **分区 + 拼接的联合约束**：`block_ids` 既要满足「每块恰好一个 section」，又要满足
   「条目 / 事实的引用被字段的 block_ids 覆盖（超集）」，还要连续有序。模型一旦把块放错 section，
   会触发 `BLOCK_DUPLICATED` / `UNCOVERED_BLOCK` / `BLOCK_IDS_NOT_SUPERSET` 一类拒绝；
   这类失败是**契约没读懂**，不是数据脏。切分块（`parent_id`）同理：本层不做「跨片段匹配」，
   引用首段却给出跨段 value 仍然必然失败——那会让「值必须逐字可回查」失效。
