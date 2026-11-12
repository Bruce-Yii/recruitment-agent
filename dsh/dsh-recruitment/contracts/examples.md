# examples.md · 三个完整示例（输入片段 → 期望输出）

**版本**：`prompt 1.0.0` / `schema 1.0.0` / `labels 1.0.0`
**用途**：① 给人看契约怎么落地；② 给检查器当回归样本（三个 JSON 都必须能通过 `schema.json` 校验）。
**说明**：全部数据均为**合成样例**（`example.test` 域名、虚构公司与人名），不含任何真实候选人资料。

> 每个示例的输入都是**完整可运行的块序列**（含 `#doc` 头）。输出是**完整**的，不是片段——因为「五个字段恒在」「每个块恰好归类一次」只有在完整输出上才能被检验。

---

## 示例 A · 标准中文简历

### 输入

```text
#doc | pages=1 | completeness=complete | issues=none | unread_pages=none | order_verified=true
#1 | 1 | 张示例
#2 | 1 | 电话：138 0000 1234    邮箱：[zhang.example@example.test](<mailto:zhang.example@example.test>)
#3 | 1 | 求职意向：后端工程师
#4 | 1 | 教育背景
#5 | 1 | 示例大学  软件工程  本科            2016.09-2020.06
#6 | 1 | 工作经历
#7 | 1 | 示例科技有限公司 后端工程师                  2020.07-2023.06
#8 | 1 | 负责订单服务重构，接口 P99 从 800ms 降到 120ms。
#9 | 1 | 示例网络有限公司 高级后端工程师               2023.07-至今
#10 | 1 | 专业技能
#11 | 1 | Java / Python / PostgreSQL / Redis
#12 | 1 | 自我评价
#13 | 1 | 认真负责，抗压能力强，能与业务方高效沟通。
#14 | 1 | BOSS直聘 www.zhipin.com
```

### 期望输出

```json
{
  "prompt_version": "1.0.0",
  "schema_version": "1.0.0",
  "block_count": 14,
  "sections": [
    { "label": "contact", "block_ids": ["1", "2", "3"] },
    { "label": "education", "block_ids": ["4", "5"] },
    { "label": "work_experience", "block_ids": ["6", "7", "8", "9"] },
    { "label": "skill", "block_ids": ["10", "11"] },
    { "label": "self_evaluation", "block_ids": ["12", "13"] },
    { "label": "other", "block_ids": ["14"], "ignored": { "reason": "platform_watermark" } }
  ],
  "fields": {
    "name": { "state": "present", "value": "张示例", "block_ids": ["1"] },
    "phone": { "state": "present", "value": "138 0000 1234", "block_ids": ["2"] },
    "email": { "state": "present", "value": "zhang.example@example.test", "block_ids": ["2"] },
    "work_experience": {
      "state": "present",
      "block_ids": ["7", "9"],
      "value": [
        {
          "company": { "value": "示例科技有限公司", "block_ids": ["7"] },
          "title": { "value": "后端工程师", "block_ids": ["7"] },
          "start": { "value": "2020.07", "block_ids": ["7"] },
          "end": { "value": "2023.06", "block_ids": ["7"] },
          "block_ids": ["7"],
          "attribution": "single_block"
        },
        {
          "company": { "value": "示例网络有限公司", "block_ids": ["9"] },
          "title": { "value": "高级后端工程师", "block_ids": ["9"] },
          "start": { "value": "2023.07", "block_ids": ["9"] },
          "end": { "value": "至今", "block_ids": ["9"] },
          "block_ids": ["9"],
          "attribution": "single_block"
        }
      ]
    },
    "education": {
      "state": "present",
      "block_ids": ["5"],
      "value": [
        {
          "school": { "value": "示例大学", "block_ids": ["5"] },
          "major": { "value": "软件工程", "block_ids": ["5"] },
          "degree": { "value": "本科", "block_ids": ["5"] },
          "start": { "value": "2016.09", "block_ids": ["5"] },
          "end": { "value": "2020.06", "block_ids": ["5"] },
          "block_ids": ["5"],
          "attribution": "single_block"
        }
      ]
    }
  }
}
```

### 判读要点

| # | 决策 | 为什么 |
|---|---|---|
| 1 | `#3 求职意向：后端工程师` 归 `contact` | 求职意向属"身份/意图"块，不是成段自述，也不是 `summary` |
| 2 | `#8 负责订单服务重构…` 归 `work_experience`，但**不**成为新条目 | 章节归属 ≠ 条目。它没有公司/职位/起止，只是 `#7` 那一条的正文细节；`work_experience.block_ids` 里也不必包含它（`#7` 已能独立成条） |
| 3 | `phone` = `"138 0000 1234"`（保留空格） | 逐字规则：原文有空格就保留。`13800001234` 是**另一个字符串**，会让"子串"机检失败 |
| 4 | `end` = `"至今"` | 开放区间照抄用词，**不**折算成 `2026.11` 或 `null` |
| 5 | 两条经历都 `single_block` | 公司/职位/起止都在同一个块里，不存在跨块问题 |
| 6 | `#12` 的标题 `自我评价` 归 `self_evaluation`，**不是** `summary` | 见 `labels.md` §3.4：主观自评与职业概述分开 |
| 7 | `sections` 里没有 `award`/`certificate`/`publication` | 枚举是"可选值域"，不是"必须出现的清单"。这份简历没有这些章节，就不出现 |
| 8 | `#14` 平台水印 → `label: "other"` + `ignored.platform_watermark`，**且不挂到 `self_evaluation` 上** | §4.1：`ignored` 必须单独成条。若把 `ignored` 挂在 `["12","13"]` 那条上，等于把自我评价整段也标成"排除"，下游会整段丢弃 |
| 9 | 水印块**没有**进入任何字段的 `block_ids` | §5.3：`ignored` 块里的文字禁止用作字段值。否则 `BOSS直聘` 可能被当成公司名（doc 11 §9.5 的原坑） |
| 10 | `#2` 的邮箱被 Markdown 链接包裹 → 只取 `zhang.example@example.test` | §7：只取 label 内容，**不带** `[` `](<` `>)`。取出来仍是原 text 的连续子串，所以"子串机检"照样成立 |

---

## 示例 B · 英文简历（含块内 `|` 与破折号）

### 输入

```text
#doc | pages=2 | completeness=partial | issues=unverified_pdf_image | unread_pages=none | order_verified=true
#1 | 1 | Alex Q. Sample
#2 | 1 | alex.sample@example.test | +1 415-555-0100
#3 | 1 | SUMMARY
#4 | 1 | Backend engineer with 6 years building payment and ledger systems.
#5 | 1 | EXPERIENCE
#6 | 1 | Sample Payments Inc. — Senior Backend Engineer        Jul 2020 – Present
#7 | 1 | - Led the ledger rewrite; settlement errors down 40%.
#8 | 1 | Example Retail Co. — Backend Engineer                 Aug 2017 – Jun 2020
#9 | 2 | EDUCATION
#10 | 2 | Example State University — B.S. Computer Science     2013 – 2017
#11 | 2 | SKILLS
#12 | 2 | Go, Python, PostgreSQL, Kafka
```

### 期望输出

```json
{
  "prompt_version": "1.0.0",
  "schema_version": "1.0.0",
  "block_count": 12,
  "sections": [
    { "label": "contact", "block_ids": ["1", "2"] },
    { "label": "summary", "block_ids": ["3", "4"] },
    { "label": "work_experience", "block_ids": ["5", "6", "7", "8"] },
    { "label": "education", "block_ids": ["9", "10"] },
    { "label": "skill", "block_ids": ["11", "12"] }
  ],
  "fields": {
    "name": { "state": "present", "value": "Alex Q. Sample", "block_ids": ["1"] },
    "phone": { "state": "present", "value": "+1 415-555-0100", "block_ids": ["2"] },
    "email": { "state": "present", "value": "alex.sample@example.test", "block_ids": ["2"] },
    "work_experience": {
      "state": "present",
      "block_ids": ["6", "8"],
      "value": [
        {
          "company": { "value": "Sample Payments Inc.", "block_ids": ["6"] },
          "title": { "value": "Senior Backend Engineer", "block_ids": ["6"] },
          "start": { "value": "Jul 2020", "block_ids": ["6"] },
          "end": { "value": "Present", "block_ids": ["6"] },
          "block_ids": ["6"],
          "attribution": "single_block"
        },
        {
          "company": { "value": "Example Retail Co.", "block_ids": ["8"] },
          "title": { "value": "Backend Engineer", "block_ids": ["8"] },
          "start": { "value": "Aug 2017", "block_ids": ["8"] },
          "end": { "value": "Jun 2020", "block_ids": ["8"] },
          "block_ids": ["8"],
          "attribution": "single_block"
        }
      ]
    },
    "education": {
      "state": "present",
      "block_ids": ["10"],
      "value": [
        {
          "school": { "value": "Example State University", "block_ids": ["10"] },
          "major": { "value": "Computer Science", "block_ids": ["10"] },
          "degree": { "value": "B.S.", "block_ids": ["10"] },
          "start": { "value": "2013", "block_ids": ["10"] },
          "end": { "value": "2017", "block_ids": ["10"] },
          "block_ids": ["10"],
          "attribution": "single_block"
        }
      ]
    }
  }
}
```

### 判读要点

| # | 决策 | 为什么 |
|---|---|---|
| 1 | `#2` 的 text 是 `alex.sample@example.test \| +1 415-555-0100`（`\|` 属 text 内容） | 行切分**只切前两个 `\|`**，第三个及以后原样留在 text 里。邮箱与电话都从这一个块取 |
| 2 | `phone` = `"+1 415-555-0100"` | 原文自带 `+1` 与连字符，**照抄**（既不删也不再加第二个区号） |
| 3 | `#6` 用 `—`（em dash）分隔公司与职位，`–`（en dash）分隔起止 | 两种破折号不同字符，一律原样；`value` 里**不含**破折号（它只是分隔符，不属于公司名/职位名/日期） |
| 4 | `end` = `"Present"`（大写 P，英文原文用词） | 不翻译成 `至今`，不折算成日期 |
| 5 | `degree` = `"B.S."`、`major` = `"Computer Science"` | 学历与专业分开取；两者都是 `#10` 的连续子串 |
| 6 | `start`=`"2013"` / `end`=`"2017"`（只有年） | 原文就是年粒度，照抄；**不补** `-01`/`-12`，也不因为"精度不够"就置 `null`（区间是清楚的，只是粗） |
| 7 | `issues=unverified_pdf_image`（软 issue）没有让任何字段变 `unreadable` | 它不是内容类 code（§1.2），不影响三态；五个字段照实判定 |
| 8 | `#7` 的 `- Led the ledger rewrite…` 归 `work_experience` 但不成条目 | 同 A-2：它是 `#6` 的正文细节 |

---

## 示例 C · **反例**：模型试图"补全"电话号码

> 这是本契约里**最严重**的一类错误。下面先给错误输出并逐条说明为什么错，再给正确输出。

### 输入

```text
#doc | pages=1 | completeness=complete | issues=none | unread_pages=none | order_verified=true
#1 | 1 | 李样例
#2 | 1 | 联系电话：138****1234
#3 | 1 | 工作经历
#4 | 1 | 样例咨询有限公司  数据分析师        2021.03-2024.08
#5 | 1 | 驻场支持某零售客户的年度盘点与经营分析。
```

### ❌ 违规输出（模型常见写法，**不要照抄**）

```json
{
  "prompt_version": "1.0.0",
  "schema_version": "1.0.0",
  "block_count": 5,
  "sections": [
    { "label": "contact", "block_ids": ["1", "2"] },
    { "label": "work_experience", "block_ids": ["3", "4", "5"] }
  ],
  "fields": {
    "name": { "state": "present", "value": "李样例", "block_ids": ["1"] },
    "phone": { "state": "present", "value": "13812341234", "block_ids": ["2"] },
    "email": { "state": "absent", "block_ids": [], "reason": "not_mentioned" },
    "work_experience": {
      "state": "present",
      "block_ids": ["4"],
      "value": [
        {
          "company": { "value": "样例咨询有限公司", "block_ids": ["4"] },
          "title": { "value": "数据分析师", "block_ids": ["4"] },
          "start": { "value": "2021.03", "block_ids": ["4"] },
          "end": { "value": "2024.08", "block_ids": ["4"] },
          "block_ids": ["4"],
          "attribution": "single_block"
        }
      ]
    },
    "education": { "state": "absent", "block_ids": [], "reason": "not_mentioned" }
  }
}
```

### 为什么这是错的（四条，按严重度排序）

| # | 违规 | 说明 |
|---|---|---|
| **1** | **凭空生成了原文没有的字符** | 原文是 `138****1234`，其中 `****` 是**字面量星号**，不是"被遮住的四位数字"。把 `****` 变成 `1234` 等于**编造了 4 个字符**。机检第一条就挂：`"13812341234"` 不是 `#2` 的 text（`联系电话：138****1234`）的连续子串 |
| **2** | **把"读不出"说成"读出来了"** | `state: "present"` 的语义是"原文有且已读出"。这里读到的是一个**不可用的号码**。三态红线：`unreadable` 绝不能当 `absent`，同理 `unreadable` 也绝不能当 `present`（后者的危害更大——它看起来像是可用的） |
| **3** | **下游会拿它做对人的决定** | 电话是身份字段。按 doc 11 §9.7，`native_text` 且格式合法的电话**允许触发候选人自动合并**。一个编造的号码会：① 联系不上真人；② 若撞上他人号码，把**两份不同的候选人档案合并**（§9.11-10 红线） |
| **4** | **错误不可追溯** | 一旦值不来自原文，`page + bbox + sha256` 的证据链就断了：HR 复核时看到 `13812341234`，回原件却找不到这串数字，整条链路失去可信度 |

**同族的另外两种违规写法**（一样错，只是没那么显眼）：

| 写法 | 错在哪 |
|---|---|
| `"phone": { "state": "present", "value": "138****1234", "block_ids": ["2"] }` | 字面照抄了，但把**打码值**标成 `present`。它虽然满足"子串"规则，却违反三态语义：这不是一个可用的号码，下游会把它当"已读出"的联络方式 |
| `"phone": { "state": "present", "value": "+86 138 1234 1234", "block_ids": ["2"] }` | 两处违规：补了原文没有的 `+86`；把 `****` 换成 `1234` 并重排空格。**不得补区号、不得格式化** |

### ✅ 正确输出

```json
{
  "prompt_version": "1.0.0",
  "schema_version": "1.0.0",
  "block_count": 5,
  "sections": [
    { "label": "contact", "block_ids": ["1", "2"] },
    { "label": "work_experience", "block_ids": ["3", "4", "5"] }
  ],
  "fields": {
    "name": { "state": "present", "value": "李样例", "block_ids": ["1"] },
    "phone": {
      "state": "unreadable",
      "block_ids": ["2"],
      "reason": "value_masked_or_redacted",
      "reason_note": "原值为字面量打码，未补全"
    },
    "email": { "state": "absent", "block_ids": [], "reason": "not_mentioned" },
    "work_experience": {
      "state": "present",
      "block_ids": ["4"],
      "value": [
        {
          "company": { "value": "样例咨询有限公司", "block_ids": ["4"] },
          "title": { "value": "数据分析师", "block_ids": ["4"] },
          "start": { "value": "2021.03", "block_ids": ["4"] },
          "end": { "value": "2024.08", "block_ids": ["4"] },
          "block_ids": ["4"],
          "attribution": "single_block"
        }
      ]
    },
    "education": { "state": "absent", "block_ids": [], "reason": "not_mentioned" }
  }
}
```

### 正确在哪

| # | 决策 | 为什么 |
|---|---|---|
| 1 | `phone.state = "unreadable"`，`value` **不出现** | `unreadable` 与 `absent` 的区别是"原文有"。这里有 `联系电话：` 标签 + 打码值，所以是"有但读不出" |
| 2 | `reason = "value_masked_or_redacted"` | 码表里唯一匹配"打码"的 code。不得自造 `missing_digits` 之类 |
| 3 | `block_ids = ["2"]` 仍保留 | `unreadable` 允许 0 到多个 block：这里保留证据块，HR 点进去就能看到原样 |
| 4 | `reason_note` 只说事实（"未补全"），不复述推断 | `reason_note` 不是让你解释"我猜可能是 1381234****" |
| 5 | `email` / `education` 是 `absent` | 原文确实没有邮箱、没有教育背景，且 `issues=none`、`order_verified=true`（三条闸门都不触发，absent 合法）。**`absent` 与 `unreadable` 在同一份输出里共存是正常的**——它们回答的是两个不同问题 |
| 6 | `work_experience` 不受 phone 的影响 | 一个字段读不出，不代表整份简历作废。**禁止**因为某个字段 `unreadable` 就把其它字段也降级 |
| 7 | `#5` 归 `work_experience` 但不是新条目 | 同 A-2：它是 `#4` 的职责描述 |

### 这一例要记住的一句话

> **打码不是谜题。你没有责任把它猜出来，你有责任说"我读不出"。**

---

## 附 · 三个示例覆盖到的规则（自查用）

| 规则 | A | B | C |
|---|---|---|---|
| 每个块恰好归类一次 | ✅ 14/14 | ✅ 12/12 | ✅ 5/5 |
| `block_count` 与输入一致 | ✅ 14 | ✅ 12 | ✅ 5 |
| 逐字子串（含空格/破折号/`\n`） | ✅ 保留 `138 0000 1234` 的空格 | ✅ 保留 `+1`、`—`/`–`、`B.S.` | ✅ 无论错对都演示了 |
| Markdown 链接取值（不带方括号） | ✅ `#2` 的邮箱 | — | — |
| 开放区间照抄（不折算） | ✅ `至今` | ✅ `Present` | — |
| `single_block` 归属 | ✅ | ✅ | ✅ |
| `absent` 的合法使用 | — | — | ✅ email / education |
| `unreadable` 的合法使用 | — | — | ✅ phone（打码） |
| 三类违规示范 | — | — | ✅ 补全 / 打码标 present / 补区号 |
| `ignored` 单独成条、不参与字段 | ✅ `#14` 平台水印 | — | — |
| `reason_note` 只写事实 | — | — | ✅ |

> 未覆盖：`same_row_multi_block` 归属（三例的条目事实都在同一块内）与 `reason` 的结构类 code（`no_section_heading` 等）。它们的形状由 `schema.json` 约束，判定标准见 `prompt.md` §6.4/§8。**这两个分支不在示例里，是因为真实语料里它们需要"跨栏/缺标题"的版式样本**（doc 11 §9.1 要求单独构造）——不要因为示例里没有就认为可以不实现。
