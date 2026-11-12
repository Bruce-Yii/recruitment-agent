# labels.md · section 标签枚举表

**版本**：`labels 1.0.0`（与 `prompt_version 1.0.0` / `schema_version 1.0.0` 同一基线）
**配套**：`schema.json`（`$defs/section.label` 的 `enum`）、`prompt.md`（§6 归类规则）、`examples.md`
**依据**：`docs/11-pdf-acceptance-criteria.md` §9（三态 / 归属 / 时间线 / 受保护属性）、`converter/src/resume_fields.py::_SECTION_KINDS`

> **本文件的唯一职责**：回答「这个 block 属于哪一类」。它**不**回答「这个人合不合适」，也**不**回答「字段抽得对不对」。
> 枚举值是**封闭集合**：只能取本表 13 个 key 之一，不得新造、不得翻译、不得加后缀（`work_experience_2` 非法）。

---

## 0. 三条不变量（先于任何单条判断标准）

| # | 不变量 | 含义 | 违反后果 |
|---|---|---|---|
| **S1** | **划分性** | 每个输入 block id 必须**恰好出现一次**：或在某个 `sections[].block_ids` 里，或在该 section 的 `ignored` 里。不重、不漏 | 机检直接判整份输出作废 |
| **S2** | **块级原子** | 一个 block 只能属于**一个** section。**禁止**把一个 block 拆到两个 section，也**禁止**把多个 block 合并成一个「虚拟块」再归类 | 同上 |
| **S3** | **标题块随章节** | 章节标题所在的 block 归属于**它所引导的那个 section**，不单独成节（否则每个标题都变成一个只有一行的小节） | 顺序与归属全部错位 |

**补充（顺序）**：`sections[]` 数组必须按**所含最小 block id 升序**排列；`block_ids` 内部也按升序。同一 `label` 允许出现多次，但若同一章节因分页/分栏被切成几段、且中间**没有**其他章节，则**必须合并成一条**。

---

## 1. 枚举表（13 项，与 `schema.json` 的 `enum` 逐字一致）

| # | 英文 key | 中文含义 | 判断标准（机械可判） | 容易混淆的反例 |
|---|---|---|---|---|
| 1 | `contact` | 联系方式 / 个人信息 | 内容是**身份与联络信息**：姓名、电话、邮箱、城市、个人主页、LinkedIn/GitHub、求职意向/求职目标。**首页顶部那一片没有标题的姓名+电话+邮箱，整片都归这里** | ❌ 把「求职意向：后端工程师」归 `summary`——它是身份块的一部分，归 `contact`；❌ 把「个人简介」那种成段自述归 `contact`——成段叙述归 `summary`/`self_evaluation` |
| 2 | `summary` | 职业概述 / 个人简介 | **成段**的第三人称/第一人称职业概述：`Summary`、`Profile`、`About`、`个人简介`、`个人总结`、`关于我`。特征是**一段话**而不是若干条目 | ❌ 把 `自我评价` 归这里（见 #12）；❌ 把「求职意向」归这里（见 #1）；❌ 把 `Skills: Java, Go` 一行归这里（见 #8） |
| 3 | `work_experience` | 工作经历 | **全职/正式雇佣**的任职记录：`工作经历`、`工作经验`、`职业经历`、`任职经历`、`工作履历`、`职业阶段`、`从业经历`、`Employment History`、`Work Experience`、`Professional Experience`。**以标题为准**：标题写「工作经历」就整节归这里，即使其中混了实习条目 | ❌ 把「实习经历」归这里（见 #4）；❌ 把「项目经历」里写在某公司下的项目归这里——章节标题是项目就归 `project` |
| 4 | `internship` | 实习 / 兼职 | 标题明确是**实习或兼职**：`实习经历`、`实习经验`、`Internship`、`Intern`、`兼职`、`Part-time`。**与 `work_experience` 的唯一分野是标题词**，不是「看起来像学生」 | ❌ 因为条目内容出现「实习生」三个字就把整个「工作经历」章节改成 `internship`；❌ 把 `校招实习` 归 `education`（在校经历才归 `education` 的「在校项目」？不——见 #7 注） |
| 5 | `project` | 项目经历 | 以**项目/作品**为单位：`项目经历`、`项目经验`、`核心项目`、`代表项目`、`开源项目`、`作品集`、`Projects`、`Portfolio`。条目形态是「项目名 + 职责/成果」，通常带或不带时间 | ❌ 把「科研经历」归这里（见 #6）；❌ 把「竞赛获奖」一行归这里——那是 `award`；❌ 把某公司任职下的项目细节归这里——它属于 #3 那一条经历 |
| 6 | `research` | 研究 / 科研经历 | 以**研究课题**为单位：`研究经历`、`科研经历`、`科研项目`、`Research Experience`、`Research`。条目形态是「课题名 + 角色/方法/成果」 | ❌ 把纯论文清单归这里（见 #11）；❌ 把「大创/竞赛」归这里——除非标题写的是研究/科研 |
| 7 | `education` | 教育背景 | **学校 + 专业 + 学历/学位 + 起止**：`教育背景`、`教育经历`、`学习经历`、`学历`、`Education`、`Academic Background`。也包含紧排在该章节内的 GPA / 排名 / 主修课程 / 奖学金（**奖学金若单独成节且标题是获奖/荣誉，则归 `award`**） | ❌ 把「校园经历/在校经历」里描述的**任职**（学生会主席）归 `education` 之外的任何类——它在教育章节内就归 `education`；❌ 把「XX 培训班 3 个月」当成 `certificate`——有学校/专业/学历形态就归 `education` |
| 8 | `skill` | 技能 | **能力项清单**（不含证书）：`专业技能`、`技能`、`技术栈`、`核心能力`、`能力关键词`、`语言能力`、`Skills`、`Technical Skills`。典型形态是并列词表（`Java / Go / PostgreSQL`）或熟练度列表 | ❌ 把 `证书：PMP` 归这里（见 #10）；❌ 把一段「我擅长跨团队协作」归这里——那是 `self_evaluation`；❌ 把 `英语 CET-6` 归 `certificate` 如果它写在技能章节内——**章节标题优先**，标题是技能就归 `skill` |
| 9 | `award` | 获奖 / 荣誉 | **评奖评优**：`获奖`、`荣誉`、`奖项`、`荣誉奖项`、`获奖经历`、`奖学金`、`Awards`、`Honors`。形态是「奖项名 + 等级/名次 + 年份」 | ❌ 把「国家级一等奖」从 `项目` 章节里拆出来归 `award`——章节标题是项目就归 `project`；❌ 把「优秀员工」写在 `工作经历` 条目里就把它拆出来——不拆，`S2` 禁止 |
| 10 | `certificate` | 证书 / 资质 / 认证 | **可凭证编号或发证机构**的资质：`证书`、`资质`、`认证`、`Certifications`、`Certificates`、`Licenses`。形态是「证书名 + 机构/年份/编号」 | ❌ 把「获奖」归这里（见 #9）；❌ 把「CET-6：已过」这种成绩描述从技能章节里挖出来归 `certificate`——标题优先，留在 `skill` |
| 11 | `publication` | 论文 / 专利 / 发表 | **可引用的学术产出**：`论文`、`专利`、`发表`、`Publications`、`Patents`、`Papers`。形态是「标题 + 期刊/会议 + 作者位次 + 年份/DOI」 | ❌ 把「投稿至某期刊（在投）」里描述的**研究过程**归这里——过程属 `research`，只有产出条目本身归 `publication`；❌ 把技术博客/公众号文章归这里（除非标题就是论文/发表）——通常归 `other` |
| 12 | `self_evaluation` | 自我评价 | **主观自评**：标题为 `自我评价`、`自我介绍`、`Self Evaluation`、`Self-Evaluation`。特征是评价性措辞（认真负责、抗压能力强、善于沟通） | ❌ 把 `个人总结`/`个人简介`/`Profile` 归这里（见 #2）；❌ 把含「本人性格开朗」的**工作经历条目**整段搬来——不搬，`S2` 禁止 |
| 13 | `other` | 其他 | **兜底**：真实简历内容但上面 12 类都不成立——`兴趣`、`爱好`、`Hobbies`、`Interests`、`附加信息`、`备注`、证书编号附录、无法归类的零散行。**必须不带 `ignored`**（带 `ignored` 表示「非简历内容」，见 §2） | ❌ 把平台水印/页码归 `other` 而**不带** `ignored`（见 §2）；❌ 把「一看就不重要」的段落归 `other` 图省事——`other` 不等于「可丢弃」，它照样进入正文证据 |

---

## 2. `ignored`：七个 reason 与判定

`ignored` 只用于**不承载任何候选人信息**的 block。带 `ignored` 的 block **禁止**出现在任何字段的 `block_ids` 里（否则平台名会被当成公司名 —— doc 11 §9.5 的原话就是这个坑）。

| reason key | 判定标准（全部满足才算） | 反例（不许 ignored） |
|---|---|---|
| `platform_watermark` | 整块**只剩**招聘平台标识：`BOSS直聘 www.zhipin.com`、`BOSS··  www.zhipin.com`、`猎聘`、`智联招聘`、`前程无忧 51job`、`拉勾`、`脉脉`、`实习僧`、`牛客`、`LinkedIn`（作为站点水印而非个人主页链接）。去掉平台名 / URL / 页码 / **标点与符号**后**不剩任何文字** | ❌ `BOSS直聘 产品经理`（真实职位名）→ 必须归 `work_experience` 或 `other`；❌ `linkedin.com/in/xxx`（个人主页，是联系方式）→ 归 `contact` |
| `page_number_or_header_footer` | 整块只有页码/页眉页脚：`第 3 页 / 共 11 页`、`Page 3 of 11`、`3/11`、重复出现的公司名页眉 | ❌ 单页简历的「1/1」如果和真实内容同块 → 不忽略整块，该块归内容所属 section |
| `qr_code_or_ad` | 二维码占位、扫码投递、平台推广语、`更多职位请关注…` | ❌ 简历里自带的个人网站二维码旁的文字链接（有信息量）→ 归 `contact` |
| `empty_or_symbol_only` | 去掉空白与 `•·-—_|/` 后为空 | ❌ 只有 `•` 但它是某个条目的项目符号（同块有正文）→ 不为空 |
| `non_resume_document` | 该块属于**非简历材料**（附在后面的调研报告、PRD、课程讲义），或明确是投递说明/邮件正文模板 | ❌ 简历里的「项目背景」长段落——它是简历内容，归 `project` |
| `duplicate_block` | 与另一 block **逐字相同**（同一段文字在页眉/正文重复出现），且已有一份被归入正常 section | ❌ 内容相近但字面不同（不同版本的同一段经历）→ 两份都要归类，冲突由 `unreadable`/人工处理，不许静默去重（doc 11 §9.8） |
| `glyphs_unreadable` | 整块是坏字形：`\ufffd`、`(cid:12)`、控制字符，**去掉坏字形后不剩可读文字** | ❌ 一块里 90% 可读、只有 1 个坏字形 → **不忽略**；该块照常归类，字段值若落在坏字形处则记 `unreadable` |

**一句话**：`ignored` 是「这块不是简历」，`other` 是「这块是简历但我不知道归哪类」。二者不可互换。

---

## 3. 最容易搞错的四对边界（裁决表）

### 3.1 `work_experience` vs `internship`

> **只看章节标题，不看条目内容。**

| 情况 | 判 |
|---|---|
| 标题 `工作经历`，其中第 2 条是「XX 公司 实习生」 | 整节 `work_experience`（标题优先） |
| 标题 `实习经历` | 整节 `internship` |
| 标题 `工作经历`，正文里另起一行小标题 `实习经历` | 两个 section：前段 `work_experience`，小标题起 `internship`（小标题本身归 `internship`） |
| 无任何标题，只有「2023.07-2023.09 XX 公司 实习生」一行 | `internship`（无标题时才看内容） |

### 3.2 `project` vs `research` vs `publication`

> **按条目的产出形态分，不按条目里出现的关键词分。**

| 条目形态 | 判 |
|---|---|
| 「项目名 + 我做了什么 + 结果数字」 | `project`（在项目章节内）/ `research`（在研究章节内） |
| 「课题名 + 方法 + 投稿/录用」 | `research` |
| 「论文标题 + 期刊 + 作者位次 + 年份」 | `publication` |
| 「专利名 + 专利号 + 状态」 | `publication` |
| 竞赛作品（`全国大学生XX竞赛 一等奖`） | `award`（若在项目章节内则 `project`，标题优先） |

### 3.3 `award` vs `certificate`

| 标题 | 判 |
|---|---|
| 含「奖」或「荣誉」 | `award`（**即使标题也含「证书」**，如 `荣誉证书`） |
| 含「证书/认证/资质」且**不含**「奖/荣誉」 | `certificate` |
| 标题是 `技能`，里面夹了 `CET-6` | `skill`（标题优先） |

### 3.4 `summary` vs `self_evaluation`

| 标题 | 判 |
|---|---|
| `自我评价` / `自我介绍` / `Self Evaluation` | `self_evaluation` |
| `个人简介` / `个人总结` / `个人评价` / `总结` / `关于我` / `Profile` / `Summary` / `About` | `summary` |
| 无标题、首页姓名下面的一段话 | `summary`（自述）/ `contact`（只有联络信息，无成段叙述） |

---

## 4. 判定顺序（按此顺序，前一步成立就不进下一步）

```
① block 是噪声/非简历/坏字形/重复/空 ？        → 归某个 section 并置 ignored
② block 是章节标题 ？                          → 归它所引导的 section（标题块随章节，S3）
③ 当前是否在某个章节内（上一行标题已开节） ？   → 归该章节
④ block 自身含「标题词 + 正文」                → 标题词所在小节决定归类
⑤ 以上都不成立（首页顶部无标题区）             → 含联络信息归 contact；成段自述归 summary；否则 other
```

**禁止的第 ⑥ 步**：因为「归不进去」就新造 section、把两个 section 合并、或把 block 丢掉。归不进去 = `other`（或按 §2 置 `ignored`）。

---

## 5. 与 converter 现有词表的对应（防止两套口径）

`converter/src/resume_fields.py::_SECTION_KINDS` 只有 `work`/`education`/`project`/`research`/`skills`/`awards`/`summary`/`personal`/`interests` 九类，本契约拆成 13 类。对应关系：

| converter kind | 本契约 label | 说明 |
|---|---|---|
| `work` | `work_experience` + `internship` | converter 把 `实习经历` 并入 work 词表（它只切 work/education 条目，不需要区分实习）；本契约**拆开**，因为 `internship` 是验收要求的枚举值。二者不冲突：一个是条目切分，一个是语义标签 |
| `education` | `education` | 一致 |
| `project` | `project` | 一致 |
| `research` | `research` + `publication` | 按产出形态拆：过程 → `research`，可引用产出 → `publication` |
| `skills` | `skill` + `certificate` | converter 把 `证书/资质/认证` 并入 skills 词表；本契约拆出 `certificate` |
| `awards` | `award` | 一致 |
| `summary` | `summary` + `self_evaluation` | 按标题词拆 |
| `personal` | `contact` | 一致（`求职意向` 也在此） |
| `interests` | `other` | 兴趣/爱好无独立枚举 |

> **只允许这一类口径差异**：`internship` / `certificate` / `publication` / `self_evaluation` 四个 label 在本契约里独立，在 converter 里被并入父类。这不是矛盾，是**粒度不同**；两边都不得反向修改对方的词表来「对齐」。

---

## 6. 变更规则

1. 本表增删任何 key → 必须同时改 `schema.json` 的 `$defs.section.label.enum` 与 `prompt.md` §5.1 的清单，并 bump `labels` / `schema_version` / `prompt_version` 三个版本号。
2. 措辞可以改，**key 不得改**（key 是契约面，改 key 等于破坏下游）。
3. 发现两个 label 在某份真实简历上确实无解 → 归 `other` 并上报，**不要**临时新造 label。
