# STAGE-CODES.md · 阶段码唯一口径（S1–S12）

**版本**：`stage-codes 1.0.0`
**日期**：2026-11-13
**地位**：`dsh/dsh-recruitment/contracts/**` 里出现的每一个阶段码（`S1`–`S12`）都**必须**落在本文件的表内。本文件与任何契约正文冲突时，以 `db/migrations` 的 `stage_catalog` 为准，并把契约改过来（`R5` 单一权威）。
**权威源**：`recruitment.stage_catalog` —— `db/migrations/0002_seed.sql` §6 种入 12 行，`0004_stage_catalog.sql` 建真表并从该配置派生，`application.current_stage_code` 已受其外键约束（`fk_application_stage_catalog`）。

---

## 1. 权威 12 阶段表（逐字取自 `0002_seed.sql:233-244`）

| code | name |
|---|---|
| S1 | 招聘需求发现 |
| S2 | Requisition 创建与审批 |
| S3 | Job / JD / Rubric 设计 |
| S4 | Job Posting 发布 |
| S5 | 人才获取 / Sourcing |
| S6 | 简历接入与处理（Intake） |
| S7 | 初筛 / Screening |
| S8 | 面试规划与排期 |
| S9 | 面试执行与材料获取 |
| S10 | 综合评价与招聘决策 |
| S11 | Offer 与入职交接 |
| S12 | 人才沉淀与复盘 |

> 12 行之外**没有**第 13 个阶段码，也**没有**"阶段 6.5"这类自造编号。`interview.stage_code` / `decision.stage_code` 的取值同样只能来自本表。
>
> 同一张表在 `db/STAGE-CATALOG.md` §3（多 `sort_order` / `in_v1_scope` 两列）与 `0004_stage_catalog.sql` 的**派生插入**里也有。三处（本文件 / `0002_seed.sql` / `db/STAGE-CATALOG.md`）任何一处对不上就是漂移，`test/contracts/stage-codes.test.ts` 的 T5 专门盯这一条。

---

## 2. 为什么会有两套编号

本项目**曾经**存在两套互不声明的 12 阶段编号：

| 编号来源 | 性质 | 例：面试安排是哪个码 |
|---|---|---|
| **生命周期编号**（老仓 `work/handoff/01-business-lifecycle.md:138/152/186`：阶段 6 = 简历接入、阶段 7 = 初筛、阶段 10 = 综合评价与决策） | **业务生命周期**的编号；`docs/01` 与 `0002_seed.sql` 的 `stage_catalog` 用的是这一套 | **S8** |
| **架构编号**（老仓 `work/handoff/15-architecture-hv.md`：S7 身份解析 / S8 筛选 / S9 面试安排 / S10 面试与转写 / S11 评价与决策 / S12 Offer） | 一份**架构分工表**的章节编号，把"身份解析"当成独立阶段，于是从 S7 起整体**错位一格** | **S9** |

两套编号**同时被引用**，于是契约文件被照架构编号写成 S7/S8/S9/S10/S11/S12，而库里种的是生命周期编号。同一句话"面试安排在 S9"在契约里成立、在库里指向"面试执行与材料获取"——这是最坏的一类错：**两边都"看起来自洽"**。

**已裁定**（**D-22**「阶段 code 唯一口径 = S1–S12」，原文在**老仓** `work/control/DECISIONS-2026-11-12.md:95-100`；本仓 `work/decisions/DECISIONS-2026-11-12.md` **未收录** D-22，只到 D-20）：粗粒度值无法表达 **S6（简历接入）与 S7（初筛）的区别**，因此**阶段码唯一口径 = 生命周期编号 S1–S12**（即 `stage_catalog`）。架构编号**作废**，只保留在历史文档里，不再具备对阶段码的命名权。

> 注：老仓 `work/handoff/15-architecture-hv.md` **在本仓（`recruitment-agent`）未收录**。任何契约里对它的引用都**不得**被当作本仓可查的依据；阶段码口径以本文件 + `db/stage_catalog` 为准。

---

## 3. 映射表（旧契约写法 → 正确 code）

| 契约里曾经写的 | 语义 | 正确的 code |
|---|---|---|
| `S7` | 身份解析 / 合并 | **并入 S6**（身份解析不是独立阶段，是简历接入的一部分） |
| `S8` | 筛选 / Screening / `SCREENING_DECISION` 写侧 | **S7** |
| `S9` | 面试安排 / 排期 | **S8** |
| `S10` | 面试与转写 / 面试执行 | **S9** |
| `S11` | 评价与决策 / 面评 / 汇总 / 决策 | **S10** |
| `S12` | Offer / 入职 | **S11** |

由此产生的三条**改名**（错误码是封闭枚举，只能整体改，不能两种写法并存）：

| 旧名 | 新名 |
|---|---|
| `DECISION_SCOPE_NOT_S11` | `DECISION_SCOPE_NOT_S10` |
| `STAGE_CODE_NOT_S11` | `STAGE_CODE_NOT_S10` |
| 工具"写死 `stage_code='S11'`" | 工具"写死 `stage_code='S10'`" |

---

## 4. 为什么这件事严重（不是排版问题）

`decision.stage_code` 在 `0001_init.sql` 里**只有正则、没有外键**：

```sql
-- 0001_init.sql:1331
stage_code              text,
-- 0001_init.sql:1355
constraint ck_decision_stage_code check (stage_code is null or stage_code ~ '^[A-Z][A-Z0-9_]{1,40}$'),
```

已实测：`decision.stage_code` 上 `fk_count = 0`（`0001_init.sql` 里 `fk_decision_*` 共 5 条：`application` / `interview` / `actor` / `approval` / `superseded_by`，**无一指向 `stage_catalog`**；全仓 `references recruitment.stage_catalog` 只出现在 `0004:216` 与 `0006:199`）。也就是说，把"综合评价与招聘决策"写成 `'S11'`（Offer 与入职交接）**数据库一声不吭**：它只检查"是 2–41 位大写字母/数字/下划线"，`'S11'` 完全合法。后果是决策记录被挂到 Offer 阶段，而**没有任何一层会报错**——指标、阶段流转、复盘全部静默偏移一格。

对照：

| 列 | 外键到 `stage_catalog` | 现状 |
|---|---|---|
| `application.current_stage_code` | ✅ | `0004_stage_catalog.sql` 已加 `fk_application_stage_catalog` |
| `interview.stage_code` | ✅ | `0006_integrity_gaps.sql` GAP-1 已加 `fk_interview_stage_catalog` |
| `decision.stage_code` | ❌ | **待 `0007`**（本轮不存在） |

→ 在 `0007` 落地前，**契约是唯一的拦截点**。契约写错 `'S11'`，就没有第二道防线。所以本文件的表、以及 `test/contracts/stage-codes.test.ts` 的机检，都是**功能性的**，不是文档洁癖。

---

## 5. 以后新增/引用阶段码的规矩

1. **先查 `stage_catalog`**：任何新阶段、新阶段码、新枚举，先看 `0002_seed.sql` §6 与 `0004` 派生出的表；表里没有的，**不许自己编号**。
2. **不许按文档章节号造码**：`§9`、`S9`、`15-arch §9` 是文档坐标，不是 stage code；落库字段只能填 `S1`–`S12`。
3. **别名一律不认**：`SCREENING`、`INTERVIEW`、`OFFER` 这类语义化大写值**不是**阶段码（`0001` 里 `interview.stage_code` 的默认值 `'INTERVIEW'` 是历史脏默认，`G-4` 已列明要改，不得模仿）。
4. **改编号 = 改契约 + 改测试**：任何阶段码变更必须同时更新本文件与 `test/contracts/stage-codes.test.ts`，并说明映射；只改一处视为未完成。
5. **新增码要走库变更**：阶段目录是**数据**（`business_config.stage_catalog` → `stage_catalog` 表），加阶段 = 加迁移 + 回填，不是改契约文本。
6. **两套编号不许并存**：发现旧编号（架构编号）残留，按 §3 映射表改；若语义无法映射，**停下来问**，不要就近猜一个码。

---

## 6. 本仓内的同名碰撞（**不是**阶段码，别误改）

以下 `S1` / `S2` / `S3` 是**规则编号**或**字段编号**，与阶段码无关，改动会破坏契约：

| 位置 | `S` 的含义 |
|---|---|
| `labels.md` §1（`S1` 划分性 / `S2` 块级原子 / `S3` 标题块随章节）、`prompt.md` 同编号 | 简历结构化输出的**输出规则编号** |
| `job-rubric-rules.md` §13（`S-1`…`S-8`）、`scheduling-rules.md` §13（`S-1`…`S-3`） | **库缺口编号**（带连字符，不是阶段码） |
| `transcript-rules.md`（`TR-S1`…`TR-S8`） | **转写规则编号** |
| `scorecard-rules.md` §0 编号说明 | 显式声明规则**不用** `S` 前缀，避免与阶段码混读 |
