# 阶段二 · 转换后校验与失败兜底（含可观测性）

**状态**：待实施。**前置条件**：阶段一（PDF 读取器）已完成且 13 项验收通过。
**发出方**：总控（lead）

---

## 0. 为什么要有这一层

读取器再准，也会遇到：加密、损坏、纯图像、字体编码坏、超时、原件被改。
**问题不在于"会不会失败"，而在于"失败了有没有人知道、有没有人接手"。**

一句话原则：

> **失败不是日志里的一行字，而是一条有状态、有归属、有截止时间的记录。**

三条硬约束：

1. **不许静默**：任何读不全的情况必须变成一条可查询的记录。
2. **不许无限重试**：重试有上限，到顶就进人工，不能挂着。
3. **不许自动放过红线**：命中红线的一律进人工，机器无权通过。

---

## 1. 成熟项目怎么做的（可借鉴的四类）

| 模式 | 出处（成熟做法） | 我们借什么 |
|---|---|---|
| **重试 + 死信队列（DLQ）** | Kafka / RabbitMQ / SQS 的 DLQ 与 retry topic；消息重试 N 次后进死信，带原始负载与失败原因 | 重试有上限、失败有独立存放处、可重放 |
| **可重试 vs 不可重试错误分类** | Temporal / Cadence 的 `RetryPolicy` + `nonRetryableErrorTypes`；AWS Step Functions 的 `Retry`/`Catch`/`Fallback` 状态 | 只有瞬时错误才重试；加密/损坏直接判永久失败 |
| **人在环（HITL）+ 置信度阈值** | AWS Augmented AI（A2I）、Azure Document Intelligence / Textract 的 confidence + review 流程 | 低置信/无法判定的结果进人工队列，人工结论回写 |
| **可观测性三件套 + SLO** | Google SRE：日志/指标/追踪 + 症状型告警 + 错误预算 | 失败要能计数、能聚合、能按原因看趋势、能告警 |

**不要照搬的**：不要引入 Kafka/Temporal 这类重型基础设施（v1.0 明确不建生产级基础设施）。
**借的是模式，不是组件。** 我们已经有 PostgreSQL + 业务任务表，够用。

---

## 2. 三层兜底阶梯

```
读取器返回结果
   │
   ├─ ① 校验层（每次必跑）
   │     契约校验 + 保真校验 + 红线检查
   │     通过 ──► ACCEPTED
   │     不通过 ─┐
   │             ▼
   ├─ ② 自动重试（仅 RETRYABLE）
   │     瞬时错误：超时 / IO / 临时占用
   │     指数退避，上限 3 次
   │     到顶 ─┐
   │           ▼
   └─ ③ 换路径 → 人工队列
         配置了版面后端就换后端再跑一次
         仍失败 / 永久错误 / 命中红线 ──► QUARANTINED（人工队列）
```

### 错误分类（决定走哪条路）

| 类别 | 典型 code | 处理 |
|---|---|---|
| **RETRYABLE** | `reader_timeout`、`io_error`、`reader_crashed` | 自动重试（≤3，退避 1s/4s/16s） |
| **PERMANENT** | `encrypted_pdf`、`corrupted_pdf`、`pdf_no_text` | 不重试，直接进人工 |
| **NEEDS_HUMAN** | `unread_visual_page`、`pdf_text_encoding_unread`、`pdf_layout_unread`、`structure_unidentified` | 进人工队列（可附"建议做法"） |
| **RED_LINE** | 保真 Counter 不等、凭空 URI、扫描件标 complete、字段三态混淆 | **直接进人工，且记录为严重事件** |

---

## 3. 失败必须可观测——五个"必须"

这是本方案的核心。少一条就不算可观测。

| # | 必须 | 落法 |
|---|---|---|
| 1 | **必须持久化** | 写入 `conversion_runs` + `conversion_failures` 表，不是只打日志。含：`source_sha256`、`converter_version`、`issue codes`、`attempts`、`first_seen`、`last_seen` |
| 2 | **必须分类** | 稳定 code（复用读取器的 issue code，不自造）+ 严重度（HARD/SOFT/RED_LINE）+ 归因（读取/校验/超时） |
| 3 | **必须可计数** | 指标：按 code 的失败数、自动通过率、人工队列积压数、积压最老时长、重试成功率 |
| 4 | **必须可检索** | 一个查询入口：按 code / 按来源 / 按时间 / 按状态筛选；能下钻到具体文件与 issue |
| 5 | **必须可告警** | 阈值告警：①积压最老 > 24h ②同一 code 1 小时内 > N 次 ③RED_LINE 命中（立即）④自动通过率跌破基线 |

### 还要有：可重放

每条失败记录必须能**一键重跑**（`REPROCESS`），重跑用同一 `source_sha256` + 新 `converter_version`，
结果写回同一条记录（保留历史 attempts），不能新建一条把旧问题洗掉。

---

## 4. 人工队列（兜底落点）

### 4.1 状态机

```
QUEUED ──► IN_REVIEW ──┬──► CORRECTED   （人工补正，产出可用的 blocks/字段）
                       ├──► APPROVED    （确认机器结果可用，附理由）
                       ├──► REJECTED    （原件不可用，终止并记录）
                       └──► REPROCESS   （换版本/换后端重跑）
```

规则：
- 每次状态变更写**审计**（谁、何时、为什么、改了什么）
- `CORRECTED` 必须保留"机器原文"与"人工结论"两份，不得覆盖
- 队列项必须有 `deadline`（默认 24h），超时升级

### 4.2 与业务的关系（重要）

- 队列里未处理的项，其候选人**不得进入自动筛选结论**
- 若某字段是 `unreadable`，下游只能显示"待核"，不能显示"不符合"
- 这与 doc 11 §9.2/§9.3 的三态红线一致

---

## 5. 数据模型（最小集，PostgreSQL）

```sql
conversion_runs(
  run_id uuid pk, source_path text, source_sha256 text, converter_version text,
  status text,            -- ACCEPTED | QUARANTINED | RETRYING | REJECTED
  completeness text, issue_codes text[], attempts int,
  first_seen timestamptz, last_seen timestamptz, result_json jsonb
);

conversion_failures(
  failure_id uuid pk, run_id uuid fk, code text, severity text,   -- HARD|SOFT|RED_LINE
  message text, location jsonb, created_at timestamptz
);

review_queue(
  item_id uuid pk, run_id uuid fk, status text,   -- QUEUED|IN_REVIEW|CORRECTED|APPROVED|REJECTED|REPROCESS
  assignee text, deadline timestamptz, opened_at timestamptz, closed_at timestamptz,
  machine_result jsonb, human_result jsonb, reason text
);

review_audit(
  audit_id uuid pk, item_id uuid fk, from_status text, to_status text,
  actor text, reason text, at timestamptz
);
```

---

## 6. 校验层（转换之后、发布之前）

每次转换完必跑，**校验失败不得返回 ACCEPTED**：

| 校验 | 判据 |
|---|---|
| V1 契约 | 字段齐全、类型正确、`completeness` 与 issues 一致 |
| V2 保真 | 逐页非空白字符 `Counter` 相等 |
| V3 页覆盖 | 输出页集合 == 原生页集合 |
| V4 链接 | 无凭空 URI；真实 URI 全出现 |
| V5 坏字形 | 正文无 `\ufffd` / `(cid:N)` / 控制字符 |
| V6 三态 | 字段三态齐全，无 `unreadable`→`absent` 混用 |
| V7 红线 | doc 11 §5 六条 + §9.11 四条，命中即 RED_LINE |

**V 层与读取器解耦**：读取器可以自称 `complete`，校验层有权判它不合格。

---

## 7. 反模式（出现即返工）

1. **只打日志不落库** —— 失败无法检索、无法计数、无法追溯
2. **无限重试** —— 毒消息把队列堵死
3. **静默降级** —— 读不全却返回 `complete`
4. **人工兜底没有 SLA** —— 队列积压无人管
5. **重跑覆盖旧记录** —— 把历史问题洗掉
6. **机器自动放过红线** —— "人工兜底"变成"没人看"
7. **引入 Kafka/Temporal 等重型组件** —— v1.0 明确不建

---

## 8. 阶段二验收标准（可执行）

| # | 检查 | 判据 |
|---|---|---|
| 1 | 校验层独立可跑 | 给定读取器结果，能独立判 PASS/FAIL，不依赖读取器自述 |
| 2 | 红线必拦 | 构造 6+4 条红线样本，全部被拦截并进队列，**0 漏** |
| 3 | 错误分类正确 | RETRYABLE 重试 ≤3 次后进队列；PERMANENT 不重试直接进队列 |
| 4 | 重试有上限 | 构造持续失败的样本，验证不会无限重试 |
| 5 | 失败可查 | 按 code/来源/时间/状态 四维查询均能返回正确结果 |
| 6 | 指标可算 | 失败数、自动通过率、积压数、最老积压时长四个指标能算出来 |
| 7 | 告警可触发 | 积压 >24h、同 code 1h 内 >N、RED_LINE 命中，三种告警均能触发 |
| 8 | 可重放 | 任一条失败记录能重跑，结果写回同一条，历史 attempts 保留 |
| 9 | 人工队列状态机 | 六态流转正确，每次变更留审计 |
| 10 | 未处理项阻断 | 队列中的项，其字段不得进入自动筛选结论 |
| 11 | 无静默失败 | 遍历语料后，`ACCEPTED` 的数量 + 队列数量 + 拒绝数量 == 输入总数（**账要平**） |

> 第 11 条最关键：**账要平**。任何一份文件都不能"消失了"。

---

## 9. 交付物（阶段二）

```
converter/
├─ src/verify.py          # 校验层（V1–V7）
├─ src/fallback.py        # 分类 + 重试 + 阶梯
├─ src/store.py           # 四张表的读写
├─ src/review_queue.py    # 人工队列状态机 + 审计
├─ src/metrics.py         # 四个指标 + 三种告警判定
├─ tests/                 # 覆盖 §8 的 11 项
└─ reports/fallback-acceptance.md
```

---

## 10. 与阶段一的衔接

- 阶段一交付 `read_pdf()` + 契约；阶段二**不改读取器逻辑**，只加"校验 + 兜底 + 可观测"
- 阶段二必须能消费阶段一的 `reports/corpus-results.jsonl` 做回放测试
- 两个阶段共用同一套 issue code，不得重命名
