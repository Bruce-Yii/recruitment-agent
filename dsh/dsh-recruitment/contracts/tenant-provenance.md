# tenant-provenance.md · 写/读工具的 R4 三维标签与「合成租户」机检口径

**版本**：`tenant-provenance 1.0.0`
**日期**：2026-11-14
**状态**：**本 lane 落地并已机检**；作为裁决写进唯一权威源（`docs/17` 决策台账）的编号**待总控补**（见 §7）。
**范围**：`recruitment_job_create` / `recruitment_job_update` / `recruitment_interview_schedule` /
`recruitment_candidate_get` 四个工具**出口**的 `labels`。不规定入参、不规定 SQL 成品。
**规则来源**：`docs/06 §8`（三维诚实标签，2026-11-12 固化）+ `docs/23` P2-03（N10 复审：标签二义性）。
**与其它契约冲突时**：`provenance` 的**判定式**以本文件为准；各工具契约里"`connection`/`trigger` 怎么取"仍以各自工具契约为准（本文件只做交叉引用，不改它们的取值）。

---

## 0. 要解决的两个真实缺陷（`docs/23` P2-03）

| # | 缺陷 | 现象（已复现） |
|---|---|---|
| 1 | `interview_schedule` / `job_create` **硬编码** `provenance: 'LIVE'` | `ra_s6s7` 是 `0002_seed` 的「演示租户 + 合成数据」（`organization.name` = `演示租户 · DEMO ONLY（非真实数据）`），但排期/岗位写入返回 `LIVE` —— 同一批演示数据在不同工具里标签不一致，合成数据被当成真实能力 |
| 2 | `candidate_get` **没有三维标签** | 输出只有一维 `source: 'DATABASE'`；`docs/23` 表格里标 ⚠️ |

**为什么这是诚实性问题而不是格式问题**：`LIVE` 一旦可以靠"写进了库"拿到，演示数据就会被算进
"真实能力"；下游（demo gate、验收、独立复核）没有任何办法把它拆回来。R4 的原话是
「绝不：Fixture 冒充 LIVE」。

---

## 1. 三维标签（沿用 `docs/06 §8`，不改维度、不改取值）

| 维度 | 取值（封闭） | 回答 |
|---|---|---|
| `provenance` | `LIVE` / `FIXTURE` | 数据是真的还是造的 |
| `trigger` | `EVENT` / `MANUAL` | 怎么触发的 |
| `connection` | `CONNECTED` / `NOT_CONNECTED` / `AUTH_REQUIRED` | 产品有没有能力自己读写外部系统 |

**三维正交，禁止压成一维**：数据真假 ≠ 自动/手动 ≠ 能否读外部系统。
本文件的四个工具**都不接任何外部系统**，所以 `connection` 恒 `NOT_CONNECTED`；
这**不等于**它们的数据就是 `FIXTURE`，也**不等于**数据是 `LIVE`——两件事分开回答。

---

## 2. `provenance` 判定式（**可机检**，四个工具共用同一份实现）

```text
provenance = 'LIVE'
  ⟺ ① 租户行存在（recruitment.organization.id = tenant_id）
    ∧ ② 该租户被**显式声明为非合成**：
         business_config 中 config_key='tenant_provenance' 的**最新一版**
         payload->>'synthetic' = 'false'
    ∧ ③ 没有任何合成标记：
         business_config 中 config_key='stage_catalog' 的**最新一版**
         payload->>'demo' ≠ 'true'
  否则 'FIXTURE'          -- 缺租户行 / 缺声明 / 有合成标记：一律 fail-closed
```

**实现（唯一一份）**：`src/tools/candidate-get.ts` 的 `resolveTenantProvenance()` /
`buildThreeAxisLabels()`。`job-create.ts` 与 `interview-schedule.ts` **import 同一份**，
不各写一份（防"三处慢慢漂移"）。机检：`test/unit/label-honesty.test.ts` 的「单一判定实现」一条。

**为什么不是"真的写进了业务库就算 `LIVE`"**：演示租户的合成数据同样真的在库里。
按那条口径，`ra_s6s7` 里的排期/岗位写入就是 `LIVE`——这正是 P2-03 的入口。

**为什么不是"没有外部系统就 `FIXTURE`"**：那会把 `provenance` 和 `connection` 压成一维，
正是 R4 记录的原始事故（同一次读取被三份文档判出三种结果）。能不能读外部系统由 `connection` 回答。

**为什么要求"显式声明"**：R4 的原则是「没有证据不许自称 `LIVE`」（同 `decision-record.ts` 的
provenance 缺省口径）。"这个租户看起来不像演示租户"不是证据；`tenant_provenance` 配置行是
部署方留在库里的**正面声明**，可查、可审、可撤。

**当前 `ra_s6s7` 的实测**：`organization.name` 含 `DEMO`、`business_config.stage_catalog.payload.demo=true`、
且没有 `tenant_provenance` 行 ⇒ 三个工具全部 `FIXTURE`（见 §5 探针输出）。

---

## 3. 逐工具的标签矩阵（本文件的规范面）

| 工具 | `provenance` | `trigger` | `connection` | 依据 |
|---|---|---|---|---|
| `recruitment_job_create` | §2 判定式（`ra_s6s7` ⇒ `FIXTURE`） | `MANUAL` | `NOT_CONNECTED` | 不读外部 ATS / 不读日历；只写本产品业务库 |
| `recruitment_job_update` | 同左（同一实现，`jobWriteValue` 一处出口） | `MANUAL` | `NOT_CONNECTED` | 同左 |
| `recruitment_interview_schedule` | 同左 | `MANUAL` | `NOT_CONNECTED` | `scheduling-rules.md` **H-2**：只登记本地事实，不建日历、不发邀请 |
| `recruitment_candidate_get` | 同左（读侧：答案属于"被读的那一行所属租户"） | `MANUAL` | `NOT_CONNECTED` | 只读本产品业务库，不读飞书/日历 |

**`connection` 的封闭性**：上面四个工具的 `output.schema.labels.connection.enum` **只允许
`["NOT_CONNECTED"]`**——枚举里不放 `CONNECTED`，从 schema 层就堵住"以后顺手放宽"。
（`interview_schedule` 本来就只放 `NOT_CONNECTED`；`job_create`/`job_update` 原先有 `CONNECTED` 分支，
已删除；`candidate_get` 新增后也只放 `NOT_CONNECTED`。）

> **与 `job_get` / `interview_get` 的差异不是笔误**：那两个读工具的契约把 `connection` 解释为
> "直连业务库"（`contracts/job-screening/tool-contracts.md §1.4`、`contracts/interview/tool-contracts.md §1.4`）。
> 本文件不替它们改口径（不在本 lane 写范围）；这一处"同一维度两种解释"记入 §7 待裁决。

---

## 4. `candidate_get` 为什么**不**豁免

P2-03 给了两条路：「补三维标签」或「明确它不属外部能力并回抄理由」。**选了补**，理由：

1. 它读的是**同一个库里的同一批数据**。同一批演示候选人在别的工具里是 `FIXTURE`/`LIVE` 有判定，
   到它这里只剩 `source:'DATABASE'`，调用方无法判断"这个人是演示数据还是真人"。
2. `source: 'DATABASE'` 回答的是"从哪读的"，`provenance` 回答的是"数据真假"——两件事，不能互相替代。
   `source` 字段**保留**（向后兼容），但**不再**是标签的替代品。

> `CONTRACT.md §4` 仍是 stub 时代的 candidate_get 契约（`provenance=FIXTURE`/`stub=true`），
> 已被实现取代但**未回抄**；`CONTRACT.md` 不在本 lane 写范围，见 §7。

---

## 5. 机检面（可复跑的原文证据）

| 检查 | 位置 |
|---|---|
| 判定表逐行（含"有合成标记时 `synthetic=false` 也无效"、缺租户行、缺声明） | `test/unit/label-honesty.test.ts` |
| 四个工具 `output.schema.labels` 三轴 required + 枚举不放宽 | 同上 |
| 源码扫描：`provenance: 'LIVE'` / `connection: 'CONNECTED'` 硬编码 0 命中 | 同上 |
| 三处共用同一实现（import 检查） | 同上 |
| 真库：演示租户三个工具出口 = `FIXTURE/MANUAL/NOT_CONNECTED`，不出现 `LIVE` | `test/integration/label-honesty-db.test.ts` |
| 真库：显式声明非合成的租户 ⇒ `LIVE`；再加 `demo=true` ⇒ 退回 `FIXTURE` | 同上 |
| 探针原文（三工具 labels + 租户事实） | `work/lane-tags/probe-labels.ts`（`probe-before.txt` / `probe-after.txt`） |

---

## 6. 对已落库历史行的影响：**无**

`job` / `interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `candidate` /
`application` **没有** `provenance` / `connection_state` / `trigger_mode` 列（实测
`information_schema.columns` 只在 `transcript_artifact` 上有这三列，属 S9 转写线，不属本文件）。
本文件的 `labels` 是**每次调用时算出并回显**的，不落库 ⇒ **不需要回填、不需要批量改数据**。
（历史行里仍存在的内容真假问题，由该行自己的 `event_inbox.provider` 链路决定，不在这里批量重贴标签。）

---

## 7. 未决 / 需总控处理（本 lane 不代决）

| # | 事项 | 为什么不在本 lane 落 |
|---|---|---|
| 1 | **写进 `docs/17` 决策台账**（新立 D-xxx，编号由总控给）：本文件 §2 的判定式是裁决，不只是实现说明 | `docs/**` 是总控写范围（R5 单一权威；本 lane 无权改台账） |
| 2 | `manual/job-line/SPEC.md:158` 的示例仍写 `labels: LIVE/MANUAL/CONNECTED` | `manual/**` 不在本 lane 写范围，需 owner 回抄 |
| 3 | `CONTRACT.md §4`（candidate_get stub 契约）与实现不符 | 根 `CONTRACT.md` 不在本 lane 写范围，且正被其它 lane 修改（R5 回抄清单 P2-05 第 2 条） |
| 4 | `job_get` / `interview_get` / `my_workbench` 的 `connection = CONNECTED`（"直连业务库"解释）与本文件"接外部系统"的解释并存 | 不在本 lane 工具面；**要么**统一为"外部能力"口径，**要么**在 `docs/17` 显式裁定"`connection` 对本地库读工具取 `CONNECTED`"——两种都必须有唯一书面裁决 |
| 5 | 生产租户如何拿到 `tenant_provenance` 声明：现有迁移里**没有**这个键（只有 `0002_seed` 的演示租户） | 需要一条迁移或部署脚本（本 lane 不改 `db/**`）。在此之前**所有租户都是 `FIXTURE`**——这是 fail-closed 的预期行为，不是缺陷 |
| 6 | 是否把"合成租户"扩到 `organization.name` 的 `DEMO/SYNTH` 标记（当前判定式只用 `business_config`） | 名称是展示字段，做机检容易误伤真实企业名；暂不采用，若总控要求可加为"或"条件 |

---

## 8. 变更规则

1. 改判定式的任何一条 ⇒ bump 本文件版本 + 同步四处的实现（只有 `candidate-get.ts` 一份）与
   `test/unit/label-honesty.test.ts` 的判定表；**不许**只改实现不改判定表。
2. 任何工具**新增** `labels` ⇒ 必须三轴齐全、`connection` 枚举只放本工具真正可能出现的值。
3. 发现某工具真的接了外部系统 ⇒ 改的是**那个工具**的 `connection`（并提供真实回执），
   **不是**把它 `provenance` 放宽成 `LIVE` 的理由。
