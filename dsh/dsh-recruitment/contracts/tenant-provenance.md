# tenant-provenance.md · R4 三维标签与「合成租户 / 读工具证据」机检口径

**版本**：`tenant-provenance 1.1.0`
**日期**：2026-11-14
**状态**：**本 lane 落地并已机检**；作为裁决写进唯一权威源（`docs/17` 决策台账）的编号**待总控补**（见 §7）。
**范围（1.0.0）**：`recruitment_job_create` / `recruitment_job_update` / `recruitment_interview_schedule` /
`recruitment_candidate_get` 四个工具**出口**的 `labels`。
**范围（1.1.0 新增）**：三个**读库**工具 `recruitment_job_get` / `recruitment_interview_get` /
`recruitment_transcript_read` 的 `labels`，以及**真的读外部字节**的 `recruitment_resume_read` 的
顶层 `provenance` / `provenance_basis`。
**规则来源**：`docs/06 §8`（三维诚实标签，2026-11-12 固化）+ `docs/23` P2-03（N10 复审：标签二义性）
+ `docs/04:400`（"这次真读了"只能由读取位点 + 处置记录 + `read_receipt_ref` 证明）。
**与其它契约冲突时**：`provenance` 的**判定式**以本文件为准；各工具契约里"`connection`/`trigger` 怎么取"仍以各自工具契约为准（本文件只做交叉引用，不改它们的取值）。

---

## 0. 要解决的真实缺陷

### 0.1 第一轮（`tenant-provenance 1.0.0`，`docs/23` P2-03）

| # | 缺陷 | 现象（已复现） |
|---|---|---|
| 1 | `interview_schedule` / `job_create` **硬编码** `provenance: 'LIVE'` | `ra_s6s7` 是 `0002_seed` 的「演示租户 + 合成数据」（`organization.name` = `演示租户 · DEMO ONLY（非真实数据）`），但排期/岗位写入返回 `LIVE` —— 同一批演示数据在不同工具里标签不一致，合成数据被当成真实能力 |
| 2 | `candidate_get` **没有三维标签** | 输出只有一维 `source: 'DATABASE'`；`docs/23` 表格里标 ⚠️ |

### 0.2 第二轮（`tenant-provenance 1.1.0`，本 lane）：P2-03 漏掉的**读**工具

P2-03 只点了两个**写**工具，读侧仍然撒谎。真实调用（`work/lane-read-tags/probe-before.txt`，2026-11-14）：

| # | 工具 | 改动前出口（演示租户，真实调用） | 数据实际来源 |
|---|---|---|---|
| 3 | `recruitment_job_get` | `LIVE/MANUAL/CONNECTED` | `recruitment.job` 等**既有行**（演示租户、`0002_seed` 合成数据） |
| 4 | `recruitment_interview_get` | `LIVE/MANUAL/CONNECTED` | `recruitment.interview` 等**既有行**（同上） |
| 5 | `recruitment_transcript_read` | `LIVE/MANUAL/CONNECTED`，**同时** `transcript.artifacts[]` 每条都是 `FIXTURE` | `recruitment.transcript_artifact` 既有行（同上）—— 同一个响应里顶层说"真"、逐条说"假" |
| 6 | `recruitment_resume_read` | `LIVE`（**常量 + 封闭枚举 `['LIVE']`**） | 真起 Python converter 读磁盘上的 PDF（**唯一**真的读外部字节的读工具）；但标签没有绑定"读取证据" |

**为什么 3–5 是诚实性问题而不是格式问题**：`LIVE` 一旦可以靠"读到了库里的行"拿到，演示租户的数据就会被
算进"真实能力"。三处读工具让同一条演示数据在写侧（`job_create`）是 `FIXTURE`、读侧是 `LIVE` —— 下游
（demo gate、验收、独立复核）无法把两半拼回一个人话结论。

**为什么 6 要改而**不是**简单改 `FIXTURE`**：它是真读外部字节（`docs/04:400` 意义上的"这次真读了"），
把真实读取标成"造的数据"同样撒谎（R4 的反面）。正确的修法是**把 LIVE 绑到读取证据上**，见 §2.2。

---

## 1. 三维标签（沿用 `docs/06 §8`，不改维度、不改取值）

| 维度 | 取值（封闭） | 回答 |
|---|---|---|
| `provenance` | `LIVE` / `FIXTURE` | 数据是真的还是造的 |
| `trigger` | `EVENT` / `MANUAL` | 怎么触发的 |
| `connection` | `CONNECTED` / `NOT_CONNECTED` / `AUTH_REQUIRED` | 产品有没有能力自己读写外部系统 |

**三维正交，禁止压成一维**：数据真假 ≠ 自动/手动 ≠ 能否读外部系统。
§2 的六个**读库/写库**工具都不接任何外部系统 —— 但 `connection` 这一轴**按各自工具契约取**：
`job_create` / `job_update` / `interview_schedule` / `candidate_get` 恒 `NOT_CONNECTED`；
`job_get` / `interview_get` / `transcript_read` 的契约把它解释为"直连业务库" ⇒ `CONNECTED`
（这处"同一维度两种解释"是**已知未决**，见 §7.4，本 lane 不代决）。

---

## 2. `provenance` 判定式（**可机检**，六个工具共用同一份实现）

### 2.1 读/写**本产品业务库**的工具（六个：4 写 + 3 读，其中 `candidate_get` 读也写）

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
`buildThreeAxisLabels()`。`job-create.ts` / `interview-schedule.ts` / `job-rubric-approve.ts` /
`stage-advance.ts` / `config-*.ts` **import 同一份**；`job-get.ts` / `interview-get.ts` /
`transcript-read.ts` 也 **import 同一份**（读侧：答案属于"被读的那一行所属租户"）。
不各写一份（防"多处慢慢漂移"）。机检：`test/unit/label-honesty.test.ts` 的「单一判定实现」「白名单」两条。

**为什么不是"真的写进/读到了业务库就算 `LIVE`"**：演示租户的合成数据同样真的在库里。
按那条口径，`ra_s6s7` 里的岗位/面试/转写读取就是 `LIVE` —— 这正是 P2-03 的入口，也是本轮 §0.2 的 3–5 处。

**为什么不是"没有外部系统就 `FIXTURE`"**：那会把 `provenance` 和 `connection` 压成一维，
正是 R4 记录的原始事故（同一次读取被三份文档判出三种结果）。能不能读外部系统由 `connection` 回答。

**为什么要求"显式声明"**：R4 的原则是「没有证据不许自称 `LIVE`」（同 `decision-record.ts` 的
provenance 缺省口径）。"这个租户看起来不像演示租户"不是证据；`tenant_provenance` 配置行是
部署方留在库里的**正面声明**，可查、可审、可撤。

**当前 `ra_s6s7` 的实测**：`organization.name` 含 `DEMO`、`business_config.stage_catalog.payload.demo=true`、
且没有 `tenant_provenance` 行 ⇒ 六个工具全部 `FIXTURE`（见 §5 探针输出）。

**`transcript_read` 的额外纪律**：顶层 `labels` 只答"这批数据属于哪个租户的库行"，**不汇总**
`transcript.artifacts[]` 的逐条三维（`contracts/interview/tool-contracts.md §1.4` 已写死"禁止汇总"）。
旧实现让顶层恒 `LIVE` 而逐条 `FIXTURE`，是"汇总口径"与"逐条口径"互相矛盾；现在顶层按租户事实算，
演示租户下两者同向（都是 `FIXTURE`）。

### 2.2 `resume_read`：唯一**真的读外部字节**的读工具

```text
provenance = 'LIVE'
  ⟺ converter 给出可复核的读取证据：
       meta.source_sha256 是 64 位 hex（converter 对**实际文件字节**算的 SHA-256）
     ∧ meta.pages ≥ 1
     ∧ meta.backend 非空（确实有解析后端跑过）
  否则 'FIXTURE'   -- 且 provenance_basis='NO_READ_EVIDENCE' + 一条 provenance_evidence_missing issue
```

| `provenance_basis` | 含义 |
|---|---|
| `FILE_BYTES_SHA256_VERIFIED` | **唯一**允许 `LIVE` 的依据：文件字节 digest 可复核 |
| `NO_READ_EVIDENCE` | 拿不到 digest / 页数 / 后端 ⇒ fail-closed 成 `FIXTURE`（附 issue 说明） |

**边界（必须写死，不许读者放大）**：`LIVE` 只断言"这些 block 来自那份真实文件的实际字节，且 digest 可复核"，
**不**断言"这是一份真人简历、不是演示件"。后者需要租户/事件链证据（S6 `event_inbox.provider`、
S7 材料链），本工具不接触库，无从判断。**因此 `resume_read.provenance=LIVE` 不能单独当作 demo gate 的
"真实外部事实"**（D-1 要的是 `provenance=LIVE` + 真实 provider artifact ID/revision/hash/readback）。

**为什么保留 `LIVE` 而不是一律 `FIXTURE`**：`docs/04:400` 的口径是 `connection=CONNECTED` 只答
"有读的能力"、`provenance=LIVE` 只答"这批数据是真的"，而"这次真读了"由读取位点 + 处置记录 +
`read_receipt_ref` 证明。本工具的 `read receipt` 就是 `source.sha256`（converter 对真实字节算的 digest），
`provenance_basis` 点名它是 LIVE 的唯一依据。把它降成 `FIXTURE` 会把"真读了真实文件"说成"造的数据"——
那是 R4 的另一半谎言。

---

## 3. 逐工具的标签矩阵（本文件的规范面）

| 工具 | `provenance` | `trigger` | `connection` | 依据 |
|---|---|---|---|---|
| `recruitment_job_create` | §2.1 判定式（`ra_s6s7` ⇒ `FIXTURE`） | `MANUAL` | `NOT_CONNECTED` | 不读外部 ATS / 不读日历；只写本产品业务库 |
| `recruitment_job_update` | 同左（同一实现） | `MANUAL` | `NOT_CONNECTED` | 同左 |
| `recruitment_interview_schedule` | 同左 | `MANUAL` | `NOT_CONNECTED` | `scheduling-rules.md` **H-2**：只登记本地事实，不建日历、不发邀请 |
| `recruitment_candidate_get` | 同左（读侧：答案属于"被读的那一行所属租户"） | `MANUAL` | `NOT_CONNECTED` | 只读本产品业务库，不读飞书/日历 |
| `recruitment_job_get` | **§2.1 判定式**（本轮由写死 `LIVE` 改为计算值） | `MANUAL` | `CONNECTED`（其契约 §1.4："直连业务库"） | 只读 `job` / `job_version` / `rubric_version` / `approval`，不接外部 ATS |
| `recruitment_interview_get` | **§2.1 判定式**（同上） | `MANUAL` | `CONNECTED`（同上） | 只读 `interview` / `interviewer` / `scorecard` / `meeting_binding`，不接外部日历 |
| `recruitment_transcript_read` | **§2.1 判定式**（同上；**不汇总** artifacts） | `MANUAL` | `CONNECTED`（同上） | 只读业务库；逐条产物三维在 `transcript.artifacts[]` |
| `recruitment_resume_read` | **§2.2 证据闸门**（`LIVE` ⇔ `FILE_BYTES_SHA256_VERIFIED`） | （无 labels；本工具无 trigger 轴） | （无 labels；本工具无 connection 轴） | 真起 converter 读本地 PDF：输出是"文件字节"的忠实映射 |

**`connection` 的封闭性（1.0.0 的四个工具）**：`output.schema.labels.connection.enum` **只允许
`["NOT_CONNECTED"]`**——枚举里不放 `CONNECTED`，从 schema 层就堵住"以后顺手放宽"。
（`interview_schedule` 本来就只放 `NOT_CONNECTED`；`job_create`/`job_update` 原先有 `CONNECTED` 分支，
已删除；`candidate_get` 新增后也只放 `NOT_CONNECTED`。）

**`connection` 的封闭性（1.1.0 的三个读库工具）**：按各自契约的已定取值封死 ——
`job_get` / `interview_get` 为 `["CONNECTED","NOT_CONNECTED"]`，`transcript_read` 为 `["CONNECTED"]`。
本 lane **不改**它们的语义（见 §7.4）。

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
| 七个工具的 `output.schema.labels` 三轴 required + 枚举不放宽 | 同上 |
| **源码扫描（全 `src/tools/*.ts`，不是逐个点名）**：`provenance: 'LIVE'` 字面量只允许出现在**证据闸门之后**（唯一例外：`transcript-import` 的 `evaluateLiveGate`） | 同上 |
| **LIVE 能力白名单**：任何在 schema 里声明"可能输出 LIVE"的工具都必须连到证据来源；新增一个不接证据就红 | 同上 |
| 无"永远 LIVE"的封闭枚举（`enum: ['LIVE']`） | 同上（`resume_read` 旧写法已被本 lane 拆掉） |
| 六个工具共用同一份判定（import 检查） | 同上 |
| `resume_read` 证据闸门：有 digest ⇒ `LIVE` + `FILE_BYTES_SHA256_VERIFIED`；无 digest / 非 64 hex / 无页数 / 无后端 ⇒ `FIXTURE` + `NO_READ_EVIDENCE` + issue | 同上（3 条） |
| 真库：演示租户 3 个读库工具出口 = `FIXTURE/MANUAL/CONNECTED`，且 `transcript.artifacts[]` 无一 `LIVE` | `test/integration/label-honesty-db.test.ts` |
| 真库：显式声明非合成的租户 ⇒ 3 个读库工具都回 `LIVE`；再加 `demo=true` ⇒ 三个都退回 `FIXTURE` | 同上 |
| 探针原文（4 个读工具 labels + 租户事实） | `work/lane-read-tags/probe-read-labels.ts`（`probe-before.txt` / `probe-after.txt`） |

---

## 6. 对已落库历史行的影响：**无**

`job` / `interview` / `interviewer` / `meeting` / `meeting_binding` / `business_task` / `candidate` /
`application` **没有** `provenance` / `connection_state` / `trigger_mode` 列（实测
`information_schema.columns` 只在 `transcript_artifact` 上有这三列，属 S9 转写线，不属本文件）。
本文件的 `labels` 是**每次调用时算出并回显**的，不落库 ⇒ **不需要回填、不需要批量改数据**。
（历史行里仍存在的内容真假问题，由该行自己的 `event_inbox.provider` 链路决定，不在这里批量重贴标签。）

`transcript_artifact` 上的三列是**逐行**既有数据，本 lane **不回填**：`transcript_read` 只回显，不改写。

---

## 7. 未决 / 需总控处理（本 lane 不代决）

| # | 事项 | 为什么不在本 lane 落 |
|---|---|---|
| 1 | **写进 `docs/17` 决策台账**（新立 D-xxx，编号由总控给）：本文件 §2.1 / §2.2 的判定式是裁决，不只是实现说明 | `docs/**` 是总控写范围（R5 单一权威；本 lane 无权改台账） |
| 2 | `manual/job-line/SPEC.md:158` 的示例仍写 `labels: LIVE/MANUAL/CONNECTED` | `manual/**` 不在本 lane 写范围，需 owner 回抄 |
| 3 | `CONTRACT.md §4`（candidate_get stub 契约）与实现不符 | 根 `CONTRACT.md` 不在本 lane 写范围，且正被其它 lane 修改（R5 回抄清单 P2-05 第 2 条） |
| 4 | `job_get` / `interview_get` / `my_workbench` 的 `connection = CONNECTED`（"直连业务库"解释）与本文件"接外部系统"的解释并存 | 不在本 lane 工具面；**要么**统一为"外部能力"口径，**要么**在 `docs/17` 显式裁定"`connection` 对本地库读工具取 `CONNECTED`"——两种都必须有唯一书面裁决 |
| 5 | 生产租户如何拿到 `tenant_provenance` 声明：现有迁移里**没有**这个键（只有 `0002_seed` 的演示租户） | 需要一条迁移或部署脚本（本 lane 不改 `db/**`）。在此之前**所有租户都是 `FIXTURE`**——这是 fail-closed 的预期行为，不是缺陷 |
| 6 | 是否把"合成租户"扩到 `organization.name` 的 `DEMO/SYNTH` 标记（当前判定式只用 `business_config`） | 名称是展示字段，做机检容易误伤真实企业名；暂不采用，若总控要求可加为"或"条件 |
| 7 | `contracts/workbench/tool-contracts.md:108` 仍写 `provenance` **恒 `LIVE`**（"每一行都来自业务库的真实行…演示租户的行也是 LIVE"）—— 与 §2.1 直接冲突 | 那是 `my_workbench` 的契约，且该工具**未在 19 个注册工具里**；改它的口径要连实现一起改。**本文件的判定式优先**，该条需总控裁定后回抄 |
| 8 | `application-intake` 的 `output.schema.provenance` 声明 `enum:['LIVE','FIXTURE']`，但实现**恒** `FIXTURE`（反方向的"永不 LIVE"） | 不是本轮"撒谎 LIVE"缺陷；且该文件正被其它 lane 修改。记入待收口 |
| 9 | `transcript_read` 没有独立的工具契约文件（`contracts/interview/tool-contracts.md:633` 明写"不在本任务范围"），它的 labels 语义目前只在本文件 + 工具 description 里 | 需要 owner 补一份 `transcript-read` 工具契约，否则又是一处"两套权威"隐患 |
| 10 | **"非合成租户 + FIXTURE 转写产物"** 时，`transcript_read` 顶层会是 `LIVE` 而 `transcript.artifacts[]` 逐条是 `FIXTURE`（因为 §2.1 按租户算、且契约 §1.4 禁止把 artifact 三维汇总进 `labels`） | 这是"顶层租户口径 / 逐条行口径"两个正交答案，不是矛盾；但读者可能仍会误读。**要么**在 `docs/17` 明确"顶层只答租户口径"，**要么**改契约允许"响应里出现 FIXTURE 产物 ⇒ 顶层降 FIXTURE"。本 lane 不代决（改口径属合同变更） |

---

## 8. 变更规则

1. 改判定式的任何一条 ⇒ bump 本文件版本 + 同步实现（只有 `candidate-get.ts` 一份）与
   `test/unit/label-honesty.test.ts` 的判定表/白名单；**不许**只改实现不改判定表。
2. 任何工具**新增** `labels` ⇒ 必须三轴齐全、`connection` 枚举只放本工具真正可能出现的值。
3. 发现某工具真的接了外部系统 ⇒ 改的是**那个工具**的 `connection`（并提供真实回执），
   **不是**把它 `provenance` 放宽成 `LIVE` 的理由。
4. 新增一个"可能输出 LIVE"的工具 ⇒ 必须在 `test/unit/label-honesty.test.ts` 的 `LIVE_EVIDENCE`
   白名单里写明证据来源；否则机检直接红（fail-closed）。
