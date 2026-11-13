# 实验记录 · 2026-11-14 · 补上迁移 0007 / 0008（真库 + 克隆预演）

**目的**：修掉"迁移链被 0009 截断"这个状态债（根因 C：状态靠人记）。
**结果**：`ra_s6s7` 现在 = `0001 → 0009` **完整线性链**，四个 verify 全绿。

---

## 1. 预演（克隆库，先不动真库）

```powershell
psql -d postgres -c "drop database if exists ra_v10;"
psql -d postgres -c "create database ra_v10 template ra_s6s7;"
```

### 1.1 第一次跑 0007 —— 被真实数据挡住

```
psql:0007_decision_integrity.sql:528: 错误:  SCORECARD_JOB_BACKFILL_BLOCKED:
  以下 scorecard 已是终态（SUBMITTED / WAIVED）但 job_id 为空，需要回填；
  而 trg_scorecard_submitted_guard（fn_scorecard_guard）禁止修改终态行。
  scorecard=3370da09-bb06-4ec5-a083-15bc339a5253 status=SUBMITTED
  scorecard=a8108983-8702-4330-b423-a2b7d278bb90 status=SUBMITTED
```

**这不是迁移写错**，是 0007 故意拒绝"替人决定已提交面评可以改"。
按 `db/DECISION-INTEGRITY.md §7` 的**唯一允许**路径处理：新增
`db/ops/backfill-scorecard-job-id.sql`（文档 SQL 逐字照做 + 增加提交前自检）。

自检两件事，任一不满足就 `raise exception` 整笔回滚：
- `scorecard.job_id` 不再有 NULL；
- 两条护栏 `trg_scorecard_guard_status` / `trg_scorecard_submitted_guard` **已恢复**（`tgenabled <> 'D'`）。

```
DO / BEGIN / ALTER TABLE / UPDATE 2 / ALTER TABLE / ALTER TABLE / DO / COMMIT   exit=0
```

### 1.2 第二次跑 0007 —— 成功

```
0007 DONE 五个完整性缺口已按上述范围修复（单事务提交；无默认值硬填；
唯一数据写入是 GAP-C 的派生回填）
```

### 1.3 跑 0008 —— 依赖检查正确拦住

先跑 0008（未跑 0007）时：
```
错误:  DECISION_UNIQUENESS_DEPENDENCY: 0008 依赖 0007（fk_scorecard_rubric_job 不在位）
```
→ 依赖闸门有效。按序跑 0007 后 0008 成功。

### 1.4 第三个真问题：`verify-0008.sql` 在 0009 之后跑不动

```
错误:  重复键违反唯一约束"uq_application_active_cycle"
键值 (tenant, candidate, job)=(…001, …601, …401) 已经存在
```

根因：verify-0008 的夹具复用了演示候选人 `…601`，而 0009 之后
`(tenant, candidate, job)` 只能有一条 ACTIVE 申请 —— 0009 的演示数据已经占了。

修法：夹具插一个**只属于本脚本**的候选人 `88888888-8888-4888-8888-0000000006a2`，
让 verify-0008 在 `0001→0009` 全链上可重放。**这是"迁移链必须线性可重放"的直接体现**：
每个 verify 脚本不能假设库里没有别人的数据。

## 2. 真库落地（`ra_s6s7`）

```powershell
psql -d ra_s6s7 -f db/ops/backfill-scorecard-job-id.sql   # UPDATE 2
psql -d ra_s6s7 -f db/migrations/0007_decision_integrity.sql
psql -d ra_s6s7 -f db/migrations/0008_decision_uniqueness.sql
```

四个 verify 全绿（**exit=0，逐条读的是 PASS 行**）：

| 脚本 | 结果 |
|---|---|
| `verify-0007.sql` | PASS：11 结构 + 11 正向 + 22 负向 + 7 数据面 |
| `verify-0008.sql` | PASS：7 结构 + 4 正向（含两步重评事务）+ 4 负向 + 5 数据面 |
| `verify-0009.sql` | PASS：3 结构 + 3 正向 + 3 负向 + 1 数据面 |
| `verify.sql` | PASS：结构 + 状态机 + 对象覆盖 + 32 条负向 |

## 3. 现在库里真的有什么

```
uq_decision_current          ✅ 存在（可延迟排斥约束版，0008 重做）
scorecard.idempotency_key    ✅ 存在
fk_scorecard_rubric_job      ✅ 存在
fk_interview_record_rubric_job ✅ 存在
scorecard.job_id             ✅ NOT NULL（2 行已回填）
```

## 4. 还没做的根因机制（下一步）

现在能证明"这次跑对了"，但**没有机制阻止下次再被截断**。要补：
1. `recruitment.schema_migration` 台账表（每条迁移自己登记）；
2. CI 强制 `0001→N` 全链重放 + 台账与文件名一致性检查。

这条不补，"迁移链被截断"还会再来一次。
