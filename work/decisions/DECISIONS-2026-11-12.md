# 决策台账 · 2026-11-12（总控裁定）

> 按 R5：裁定必须落文档，否则视为未决定。
> 以下 8 条由总控直接裁定，**不再上抛**；只有涉及产品范围变更的才需要产品负责人。

---

## A 线（PDF 读取器）2 条

### D-19 · `pdf_reading_order_unverified` 维持 HARD

**冲突**：参考实现 `batch.py` 把 `pdf_reading_order_` 整族当 SOFT；`doc 11` A4 要求"页字 <800 必须 HARD"。

**裁定：维持 HARD。** 理由：
- 顺序错 → 公司/职位/时间可能错配 → 直接影响筛选结论，这是招聘侧最危险的错误
- 40%（34/84）HARD 不是失败，是**语料真实质量**的反映（77 份里混了 PRD、行业报告、课程讲义）
- 但要求两条配套：
  1. 该 issue **必须带证据块**（哪些 block 顺序异常），让人一眼能判断
  2. 人工队列要支持"**仅顺序问题**"快速放行，不能让人逐个读 40 份

**不改回 SOFT 的理由**：SOFT 意味着系统自己认定"不影响"，而顺序问题恰恰是最难自动判断影响的。

### D-20 · 章节词表未命中 → 一律 `unreadable`，不写 `absent`

**裁定：维持现设计。** 理由：
- `absent` 的语义是"原文确实没提"，词表没命中推不出这个结论
- `unreadable` 的代价是进人工队列，`absent` 的代价是**误淘汰**——后者不可接受
- 补一条回归测试：**未知标题写法 → work/education 必须是 unreadable**，不得 absent

**不做**：不扩词表到无限（会变成猜）。词表是封闭集合这件事要写进 CONTRACT，让下游知道。

---

## B 线（PG Schema）6 条

### D-13 · 领域对象数 = **36**，回抄 docs/03

docs/03 §1 标题写"三十四个业务对象"，表体实为 36 行。**以表体为准 = 36**，回抄标题。

### D-14 · 7 个缓做对象维持缓做，但**必须补 seed**

缓做：Prospect / Pipeline Template / Stage / Stage Activity Template / Offer / Talent Pool / Source Thread —— 全部落在 Deferred 阶段，同意。

**但**：`business_config.stage_catalog` 现在**没有任何配置行**，P1 第一次查阶段目录会是空表。
→ **必须补 `0002_seed.sql`**：最小 stage_catalog + 一个 demo job + 一个 rubric version。否则联调必返工。

### D-15 · `intake_record` / `intake_asset` / `candidate_merge` 保留，定位为**支撑实体**

它们不在 §1 的 36 行里，但来自 docs/03 正文，且不变量 2（合并保留历史）与 §5 Intake 模型依赖它们。
**裁定**：保留表；在 SCHEMA.md 明确区分「业务对象（36）」vs「支撑实体（3）」；不把它们算成第 37–39 个业务对象。

### D-16 · v1.0 不新增阶段产物表

- Screening Result → `decision(scope='SCREENING')` ✅
- Evaluation Summary / Next Round Brief → **派生不落表**（v1.0）；要求：同一输入可复算出同一结果
- Calendar Event → `meeting.calendar_event_id` ✅
- Source Event → `event_inbox` 标准化列 ✅

若 P3 要求 Brief 版本化持久化，先改 docs/03 再开 `0002`，**不得先建表后补文档**。

### D-17 · canonical 粒度 = **每会议一个**（v1.0）

`transcript_artifact.is_canonical` 用部分唯一索引（每 meeting 一个 canonical）。`transcript_set` 实体留到 0002。

### D-18 · actor 写入必须 `SET LOCAL` + 统一封装

**裁定**：
- 所有状态迁移必须 `SET LOCAL recruitment.actor_id = '<uuid>'`（**不能**用 `SET`，连接池会泄漏给下一个请求 → 责任人记错，静默错误）
- 插件统一封装 `withActor(tx, actorId)`，UPDATE 后 `RETURNING record_version`，不缓存旧版本号
- 这条写进 C 线的调用约定，且必须有测试

---

## 需要产品负责人（不是总控）的 1 条

### P-1 · 顺序类 HARD 的规模是否可接受

按 D-19，84 份语料里 34 份（40%）会进人工队列。这是**产品侧的运营成本**：
- 接受 → 维持 D-19
- 不接受 → 只能降级为 SOFT，代价是可能带着错配的经历进筛选

**默认按 D-19 执行**；若产品负责人另有口径再改。
