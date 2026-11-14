# job-rubric-rules.md · 岗位与标准（S3）领域规则

**版本**：`job-rubric 1.0.0`（与 `screening 1.0.0` / `tool-contracts 1.0.0` 同一基线）
**日期**：2026-11-13
**范围**：`job` / `job_version` / `rubric_version` / `approval` / `application.rubric_version_id` 的**规则**，不含实现
**上位**：老仓 `work/handoff/15-architecture-hv.md`（新仓未收录；阶段码口径已由 D-22 与 `db/stage_catalog` 取代，见 `contracts/STAGE-CODES.md`）（S3 纵向、v1.0 要做）、`docs/11-pdf-acceptance-criteria.md` §9（三态 / 拒绝可解释 / 受保护属性）
**落库依据**：`db/SCHEMA.md`、`db/migrations/0001_init.sql`（行号即该文件行号）

> **本文件的唯一职责**：回答「这个岗位此刻用哪一版标准」「这版标准里什么算硬性、什么算加分」「标准改了以后旧的筛选结论怎么办」。
> 它**不**回答「这个人合不合适」——那是 `screening-rules.md`；也不回答「工具长什么样」——那是 `tool-contracts.md`。

---

## 0. 引用图例（全项目统一，两份配套文件复用）

| 标记 | 含义 | 出处 |
|---|---|---|
| `INV-1` … `INV-10` | 十条**最小数据不变量**（按 SCHEMA.md §8 表行号） | `db/SCHEMA.md` §8 |
| `XINV-1` … `XINV-10` | 十条**跨模块不变量**（按 SCHEMA.md §9 表行号） | `db/SCHEMA.md` §9 |
| `APP-01` … `APP-09` | 只能由应用层保证的规则 | `db/SCHEMA.md` §10 |
| `N01` … `N32` | 负向测试编号（期望 SQLSTATE） | `db/SCHEMA.md` §12 |
| `D11 §9.x` | PDF 验收标准第 9 章各条 | `docs/11-pdf-acceptance-criteria.md` |
| `ck_*` / `uq_*` / `trg_*` | 已存在的库约束或触发器名（逐字取自 `0001_init.sql`） | `db/migrations/0001_init.sql` |

---

## 1. 三条不可协商的结论（先读这三行）

1. **一个岗位可以有任意多个 Rubric 版本，但"当前版本"只有一个；版本一旦落库，一个字节都不能改。** 改标准 = 新建版本，不是编辑旧版本（`INV-10`、`N21`、`trg_rubric_version_immutable`）。
2. **申请绑定版本，不绑定"岗位"。** 新版本发布会**自动作用于**之后绑定版本的申请；对已绑定的申请**永不自动改绑、永不自动重算**（`INV-10`、`fk_application_rubric`）。历史结论留旧版本，只能被**新结论追加**并通过 `superseded_by_decision_id` 取代，**不得改写**（`INV-9`、`ck_decision_reason`）。
3. **岗位 `CLOSED` / `ARCHIVED` 之后，系统不再对这个岗位的任何申请产生自动建议**（只能产出 `NEEDS_REVIEW` 并指向人工）；`PAUSED` **不冻结**在途申请。见 §7。

---

## 2. 对象与字段契约（与 `0001_init.sql` 逐列对齐）

### 2.1 关系

```
requisition 1─n job 1─n job_version          （JD 正文版本，不可变）
                     │
                     ├──n rubric_version    （筛选标准版本，不可变）
                     │        └──0..1 approval(resource_type='RUBRIC_VERSION')  ← 绑定 payload_hash
                     │
                     └──n application ──0..1 rubric_version_id  ← 申请级"钉住"
                              └──0..n decision(decision_scope='SCREENING')
```

**关键（D-21 / D-48，2026-11-13 已裁决并落库）**：`job` 表**有** `current_rubric_version_id`
（`0004_stage_catalog.sql:243`，复合外键 `fk_job_current_rubric`）。**"当前 Rubric 版本"只由这个指针说话**，
不是 `max(version_no)`；指针为空 = 没有当前版本（不回退推导）。见 §4.2。

### 2.2 权威列清单（只列本规则用到的）

| 表 | 列 | 约束 / 取值 | 本规则怎么用 |
|---|---|---|---|
| `job` | `status` | `ck_job_status`：`DRAFT·PENDING_REVIEW·APPROVED·OPEN·PAUSED·CLOSED·ARCHIVED` | §7 门禁 |
| `job` | `current_job_version_id` | 可空，`fk_job_current_version` | 只用于展示，**不参与** Rubric 解析 |
| `job` | `current_rubric_version_id` | 可空；`fk_job_current_rubric (tenant_id, id, current_rubric_version_id) → rubric_version(tenant_id, job_id, id)`（同岗位约束） | **"当前"的唯一权威**（D-21）；由 `recruitment_job_rubric_approve` 维护 |
| `job_version` | `version_no` / `payload_hash` / `approved_by_approval_id` | `version_no>=1`；hash 为 64 hex | 与 Rubric 版本号**无关**，两套计数器不得混用 |
| `rubric_version` | `job_id` + `version_no` | `uq_rubric_version (job_id, version_no)` | 版本唯一 |
| `rubric_version` | `dimensions` | `jsonb`、必须为非空 array（`ck_rubric_version_dimensions`） | §6 契约的载体 |
| `rubric_version` | `payload_hash` | `ck_rubric_version_hash`：`^[0-9a-f]{64}$` | §6.6 校验；审批绑定它 |
| `rubric_version` | `approved_by_approval_id` | 可空，`fk_rubric_version_approval` | **不单独作为"已批准"判据**，见 §4.2 |
| `approval` | `resource_type` / `resource_id` / `canonical_payload_hash` / `status` / `expires_at` / `superseded_by_approval_id` | `ck_approval_resource_type` 含 `'RUBRIC_VERSION'` | 已批准的**唯一**判据 |
| `application` | `job_id` / `job_version_id` / `rubric_version_id` / `lifecycle_status` | `job_version_id NOT NULL`；`rubric_version_id` 可空 | 绑定与 §7 门禁 |
| `decision` | `decision_scope='SCREENING'` / `result` / `basis_refs` / `superseded_by_decision_id` | `ck_decision_scope`、`ck_decision_result`、`ck_decision_basis`(仅 array) | 历史结论载体 |

> `application.rubric_version_id` 可空意味着"尚未钉版本"。**钉有两个合法写入点**：
> ① `recruitment_application_intake` 新建申请时（岗位已有已批准的 current）；
> ② `recruitment_application_stage_advance` 的 T1 补钉（申请先建、岗位后批，同事务 + 审计事件）。
> 筛选工具只读（`tool-contracts.md` §2.4），**不钉版本**。

---

## 3. 不变量 J-1 … J-8

| # | 不变量 | 判定（可机检） | 依据 |
|---|---|---|---|
| **J-1** | **Rubric 版本不可变**：任何已落库的 `rubric_version` 行不可 UPDATE、不可 DELETE | 违反时库直接抛错（`fn_guard_columns` 无白名单 → `IMMUTABLE_COLUMN`，SQLSTATE `23514`；`fn_block_delete` → `DELETE_FORBIDDEN`，同为 `23514`） | `INV-10`、`N21`、`trg_rubric_version_immutable`、`trg_rubric_version_no_delete` |
| **J-2** | **改标准必须出新版本**：`dimensions` 变一个字符 → 新 `version_no` = 同岗位当前最大 `version_no` + 1 | `version_no` 唯一且递增；不存在"同版本两个 hash" | `uq_rubric_version`、`INV-10` |
| **J-3** | **当前版本唯一**：`current(job, as_of)` = `job.current_rubric_version_id` 指向的版本（D-21/D-48）；同一 `(job, as_of)` 只能有一个结果 | 返回单一 `version_id`，或 `NO_RUBRIC`（指针为空/指向的版本不在该岗位下） | D-21 显式指针（`0004`），§8 S-1 已落 (b) |
| **J-4** | **申请钉版本**：`application.rubric_version_id` 一旦非空，**只允许**在同一 `job_id` 下由人工显式改绑，且必须与"新 decision + 旧 decision supersede"同事务 | 库无约束 → 应用层保证（`APP-06` 同类） | `INV-10`、§5、§8 S-3 |
| **J-5** | **标准必须被人批准过**："已批准版本"= 存在 `approval(status='APPROVED' ∧ resource_type='RUBRIC_VERSION' ∧ resource_id=版本id ∧ canonical_payload_hash=版本payload_hash ∧ 未过期 ∧ 未 supersede)`；**不看** `rubric_version.approved_by_approval_id` 单列 | 见 §4.2 的判定式；缺审批 → `NO_RUBRIC/NO_APPROVED_RUBRIC` | `INV-9`、`ck_approval_decided_fields`、`ck_approval_hash` |
| **J-6** | **结论不可改**：`decision` 整行不可 UPDATE（仅 `superseded_by_decision_id` 白名单），修正 = 追加新行 | 违反 → `ck_*`/`trg_decision_immutable` 抛错 | `INV-9`、`N12`、`trg_decision_immutable` |
| **J-7** | **可执行性前置**：一个 Rubric 版本必须通过 §6.2 全部 `R‑VAL`，否则视为"不存在可用标准" → `NO_RUBRIC/RUBRIC_INVALID`；**不得**降级成"用模型自由判断" | 逐条 `R-VAL` 可机检 | 本契约裁决，§6.2、`tool-contracts.md` §3 |
| **J-8** | **禁止受保护属性进标准**：任何 `criterion.field` 落在 `protected.*` 或 §6.3 禁止名单 → `NO_RUBRIC/RUBRIC_INVALID(PROTECTED_ATTRIBUTE_IN_CRITERIA)` | 枚举扫描 | `D11 §9.6`、`D11 §9.11` 红线 9 |

---

## 4. 版本解析：`current` / `applicable` / `pinned`

### 4.1 三个概念必须先分开

| 概念 | 问题 | 答案 | 会不会变 |
|---|---|---|---|
| **current** | 这个岗位**现在**的标准是哪一版 | §4.2 的推导 | 会（新版本发布后变） |
| **applicable** | **这一次评估**该用哪一版 | §4.3 解析顺序 | 只在解析输入变化时变 |
| **pinned** | 这个申请**已经被钉**在哪一版 | `application.rubric_version_id` | 只有人工显式改绑才变 |

> **反模式（必须拒绝）**：把 `current` 当成 `applicable`。这让"新版本一发布，所有在途申请的旧结论看起来都过期"，进而诱发批量重算——这正是 `INV-10` 要禁止的。

### 4.2 `current(job_id, as_of)`

```
approved(v, as_of) :=
      v.job_id = job_id
  AND v.created_at <= as_of
  AND EXISTS ( SELECT 1 FROM approval a
               WHERE a.tenant_id = v.tenant_id
                 AND a.resource_type = 'RUBRIC_VERSION'
                 AND a.resource_id   = v.id
                 AND a.status        = 'APPROVED'
                 AND a.canonical_payload_hash = v.payload_hash
                 AND (a.expires_at IS NULL OR a.expires_at > as_of)
                 AND a.superseded_by_approval_id IS NULL )

current(job_id, as_of) :=
    -- D-21 / D-48（2026-11-13 裁决，0004 已落库）：**显式指针，不是 argmax**
    v := (select rv.* from rubric_version rv
           join job j on j.id = rv.job_id and j.tenant_id = rv.tenant_id
          where j.tenant_id = :tenant and j.id = :job_id
            and rv.id = j.current_rubric_version_id)
    -- 指针为空 / 指向的版本不属于该岗位 → NO_RUBRIC(NO_APPROVED_RUBRIC)（**不回退**）
  ∨ NO_RUBRIC(NO_APPROVED_RUBRIC)

-- "已批准"是**另一条**事实，与"被指针指着"分开判：
approved(v, as_of) := v.job_id = job_id AND v.created_at <= as_of
  AND EXISTS (approval a WHERE a.resource_type='RUBRIC_VERSION' AND a.resource_id=v.id
                AND a.status='APPROVED' AND a.canonical_payload_hash=v.payload_hash
                AND (a.expires_at IS NULL OR a.expires_at > as_of)
                AND a.superseded_by_approval_id IS NULL)
```

四条**必须照做**的细节：

1. **`as_of` 是显式输入**（工具参数，缺省 = 服务端 `now()`，`tool-contracts.md` §2.2）。理由：审批过期是时间相关判定，不把时间当输入就无法复现 `D11 §9.9`（"当时看到的是哪一版"）。
2. `as_of` **不得晚于服务端 `now()`**（`INVALID_ARGS`）。禁止用未来时间"提前看见"尚未生效的审批。
3. **不用** `rubric_version.approved_by_approval_id` 单列判批准：它是**可空指针**，不保证指向的 `approval` 是 `APPROVED`，也不保证 hash 一致。用 §4.2 的 `EXISTS` 判定。
4. 没有"指针指向且已批准"的版本时**不回退**到"最新已批准版本"、也不回退到 `v1`。直接 `NO_RUBRIC`。
   —— 这是 D-48 的原话：**指针为空就是没有当前版本**（"批准 v2 不会把 v3 顶成当前；回滚靠改指针"）。
   只读侧（`job_get` / `screening_evaluate` 的 `JOB_CURRENT`）与写侧（`job_rubric_approve`）因此说同一个"当前"。

### 4.3 `applicable(application, args, as_of)` —— 解析顺序（前一步命中即停）

| 步 | 条件 | 结果 | `rubric.resolution` | 备注 |
|---|---|---|---|---|
| 1 | 入参给了 `rubric_version_id` | 用该版本 | `ARGUMENT` | 必须是**同 `job_id`** 的版本，否则 `NO_RUBRIC/RUBRIC_JOB_MISMATCH`；输出必须标 `what_if=true` |
| 2 | `application.rubric_version_id IS NOT NULL` | 用该版本 | `APPLICATION_PINNED` | 版本必须属于 `application.job_id`，否则同上 |
| 3 | 以上都无 | 用 `current(job_id, as_of)` | `JOB_CURRENT` | 输出必须带 `rubric_pin_required=true`，提示写侧在落 `decision` 前先钉版本 |

**为什么第 3 步只"提示"不"写入"**：本工具是只读的（`tool-contracts.md` §0）。钉版本是**状态变更**，必须由有权限的写路径做（带 `SET LOCAL recruitment.actor_id`，`INV-8`）。工具代为写入会绕开 `APP-07`（Agent 不得代替人做闸门动作）。

### 4.4 `what_if` 的硬边界

`what_if=true` 的评估结果**不得**用于写 `decision`。理由：否则入参一处手滑就能让"旧标准下的结论"披上"新标准"的外衣，`INV-10` 立刻失效。写侧必须在 `basis_refs` 里存 `what_if=false` 且 `rubric_version_id` 与 `application.rubric_version_id` 相同时才允许落结论。

---

## 5. 版本切换后，历史筛选结论怎么办

### 5.1 四条规则

| # | 规则 | 依据 |
|---|---|---|
| **S-1** | **不重算**：发布新版本**不触发**任何申请的重评。没有任何批处理会遍历旧申请。 | `INV-10`（"配置变更不静默改变历史评价或已结束申请"） |
| **S-2** | **不改写**：已有 `decision(scope='SCREENING')` 行**一个字段都不改**，包括 `basis_refs`。 | `INV-9`、`trg_decision_immutable` |
| **S-3** | **不追溯适用**：旧结论继续用旧版本走完当前流程；面试、评分卡继续引用旧 `rubric_version_id`（`scorecard.rubric_version_id` 也是固定引用，`INV-7`）。 | `INV-7`、`INV-10` |
| **S-4** | **要改只能追加**：人工决定"用新标准重评"时，必须 `插入新 decision` + `旧行.superseded_by_decision_id = 新行.id` + `application.rubric_version_id` 显式改绑 + 内部事件，**同一事务**。 | `INV-9`、`XINV-10`、`APP-06` |

### 5.2 重评事务的合法顺序（写侧必须照此实现）

```
BEGIN;
  SELECT ... FROM application WHERE id=$app AND record_version=$rv;   -- 0 行 → VERSION_CONFLICT
  SET LOCAL recruitment.actor_id = $human_actor;                      -- 必须是 HUMAN
  UPDATE application SET rubric_version_id = $new_rubric, record_version = record_version + 1
    WHERE id=$app AND record_version=$rv;
  INSERT INTO decision(... decision_scope='SCREENING', result=..., decided_by_actor_id=$human,
         reason=..., basis_refs=$eval_basis, superseded_by_decision_id=NULL) RETURNING id;
  UPDATE decision SET superseded_by_decision_id=$new_decision WHERE id=$old_decision;
COMMIT;
```

- `$human_actor` 必须是 `actor.kind='HUMAN'`；`execution_mandate.allowed_actions` 永远不含 `decide`（`ck_execution_mandate_no_business_approval`、`N27`、`APP-07`）。
- 旧结论 **不删、不置空 `result`**，只加一个指针。

### 5.3 "旧版本 PASS、新版本会 FAIL"怎么办

**不做任何事。** 旧申请继续在旧版本下走。理由：筛选结论是**时点事实**，不是"当前最优判断"。若业务要按新标准重来，那是 §5.2 的显式重评，必须有人签字。

---

## 6. `dimensions` 的 JSON 契约

`rubric_version.dimensions` 是一个 **criterion 对象数组**。库目前只校验"是非空 array"（`ck_rubric_version_dimensions`），结构由本节的 `R-VAL` 保证。

### 6.1 criterion 对象（键封闭，多一个键即非法）

**机械型**（有 `field`，所以**没有 `question` 键**）：

```json
{
  "key": "backend_years",
  "label": "后端方向 5 年以上",
  "kind": "MUST_HAVE",
  "weight": 0.4,
  "field": "timeline.covered_months_closed",
  "operator": "GTE",
  "value": 60,
  "notes": "按时间线可复算，不接受「约 5 年」这类估算"
}
```

**判断型**（**没有 `field` / `operator` / `value` 三个键**）：

```json
{
  "key": "bachelor_or_above",
  "label": "本科及以上学历",
  "kind": "MUST_HAVE",
  "weight": 0.4,
  "question": "候选人是否具备本科及以上学历？",
  "notes": "学历不在机械字段白名单内，只能人判"
}
```

| 键 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `key` | string | ✅ | `^[a-z][a-z0-9_]{1,40}$`，同版本内唯一 |
| `label` | string | ✅ | 去空白后 1–200 字符 |
| `kind` | string | ✅ | `MUST_HAVE` \| `NICE_TO_HAVE` \| `DISQUALIFIER`（**与现有 `CONTRACT.md` §5 完全一致，不得新增**） |
| `weight` | number | ✅ | 0 ≤ w ≤ 1；同版本 `Σw` 与 1 的差 ≤ `1e-6`；**只用于展示/排序，不参与任何判定**（§6.5） |
| `field` | string | 条件 | 与 `operator`、`value` **同进同退**；取值必须在 §6.3 白名单内 |
| `operator` | string | 条件 | `EXISTS` \| `GTE` \| `LTE`（封闭集，§6.4） |
| `value` | boolean / integer | 条件 | 见 §6.4 的类型表 |
| `question` | string | 条件 | **判断型**（无 `field`）必填，1–500 字符，必须是**可回答的单一问题**（"是否具备 X"，不得是"你怎么看"） |
| `notes` | string | — | ≤1000，纯说明，不参与判定 |

**"条件"键在不适用的模式里必须缺席，不许写 `null` 占位。**

> 这是本契约的**单一裁决**（2026-11-14 P0 之后写死）：
> **「键不存在」与「键的值是 `null`」在本契约里同义（都表示"没给 / 不适用"）；落库形状用缺席表达，不用 `null`。**
>
> 之所以要写死：`recruitment_job_create` 曾把判断型准则归一化成固定的 9 键、缺省写 `null`，
> 而 `recruitment_screening_evaluate` 只用 `criterion.field === undefined` 判"判断型"——
> 同一份 JSON 的两个读者对 `null` 的口径不一致，导致**任何用产品入口建的、含判断型准则的 rubric
> 在 S7 一律崩**（`TypeError: Cannot read properties of null (reading 'startsWith')`）。旧验收 rubric
> 是手工 SQL 插的（判断型准则没有 `field` 键），恰好绕开该分支，所以缺陷长期没暴露。
>
> 因此两侧都必须遵守同一裁决，缺一不可：
> * **写侧（序列化层）**：`normalizeCriteria` 省略 `null`/缺失的可选键——落库形状必须说真话，且同一份
>   标准不能因为"写没写 null"产生两个 `payload_hash`（= 两个 rubric 版本）；
> * **读侧（校验/求值层）**：把 `field == null`（同时覆盖 `undefined` 与 `null`）判为判断型，
>   把 `operator == null` 判为"没给"，`question`/`notes == null` 不写进输出。读侧容忍 `null` 是
>   **向后兼容历史行**，不是允许新写入继续写 `null`。
>
> **两种模式由"有没有 `field`"决定，不新增 `mode` 字段**：

- 有 `field`+`operator`+`value` → **机械型**：能做到 `SATISFIED/UNSATISFIED`（§6.4）；
- 无（键缺席或值为 `null`）→ **判断型**：永远只能产 `NEEDS_JUDGMENT`（`screening-rules.md` §4.3），因此**永不导致 PASS 或 FAIL**。

### 6.2 校验规则 `R-VAL-1 … R-VAL-14`（任一失败 → `NO_RUBRIC/RUBRIC_INVALID`）

| # | 规则 | 失败码 | 依据 |
|---|---|---|---|
| `R-VAL-1` | `dimensions` 是 array，长度 1–50 | `DIMENSIONS_SHAPE` | `ck_rubric_version_dimensions` + 本契约（上限 50 防止输出爆炸） |
| `R-VAL-2` | 每个元素是 object，且**键集 ⊆ §6.1 的 9 个键**（多余键 = 非法） | `CRITERION_UNKNOWN_KEY` | 封闭 schema（`CONTRACT.md` §2.1 风格） |
| `R-VAL-3` | `key` 符合正则且同版本唯一 | `CRITERION_KEY` | — |
| `R-VAL-4` | `label` 去空白后 1–200 | `CRITERION_LABEL` | — |
| `R-VAL-5` | `kind ∈ {MUST_HAVE, NICE_TO_HAVE, DISQUALIFIER}` | `CRITERION_KIND` | `CONTRACT.md` §5 |
| `R-VAL-6` | `weight` 为 number ∈ [0,1]，`Σweight` 与 1 差 ≤ `1e-6` | `WEIGHT_SUM` / `WEIGHT_RANGE` | `CONTRACT.md` §5（"同版本内求和为 1"） |
| `R-VAL-7` | `field` / `operator` / `value` **三者同时存在或同时缺席**（值为 `null` 视为缺席，§6.1；下游不得把半个机械型当判断型） | `CRITERION_PARTIAL` | 防止"有 field 没 operator"被当成判断型 |
| `R-VAL-8` | `field` ∈ §6.3 白名单；**禁止** `name` / `phone` / `email` / `protected.*` / 任何未列路径 | `CRITERION_FIELD` / `PROTECTED_ATTRIBUTE_IN_CRITERIA` | `D11 §9.6`、`D11 §9.11` 红线 9 |
| `R-VAL-9` | `operator` ∈ `{EXISTS, GTE, LTE}` | `CRITERION_OPERATOR` | §6.4 |
| `R-VAL-10` | `operator` 与 `field` 类型匹配（`EXISTS` ↔ boolean 型字段；`GTE`/`LTE` ↔ integer 型字段） | `CRITERION_TYPE` | §6.3 类型列 |
| `R-VAL-11` | `value` 类型正确：`EXISTS` → 必须为 `true`；`GTE`/`LTE` → 整数，单位见 §6.3 | `CRITERION_VALUE` | §6.4 |
| `R-VAL-12` | 判断型（`field` 缺席或为 `null`）必须有 `question`，1–500 字符 | `CRITERION_QUESTION` | §6.1 |
| `R-VAL-13` | 至少 1 条 `MUST_HAVE` 或 `DISQUALIFIER`（只有加分项的 Rubric 无法产生结论） | `NO_DECIDING_CRITERIA` | 本契约裁决 |
| `R-VAL-14` | `payload_hash` = `sha256(canonical_json(dimensions))`；且对应 `approval.payload_schema_version = 1` | `RUBRIC_HASH_MISMATCH` / `UNSUPPORTED_PAYLOAD_SCHEMA_VERSION` | §6.6、`ck_approval_hash` |

> `R-VAL-1..13` 只依赖 `dimensions` 本身，可在**入库前**校验；`R-VAL-14` 依赖审批行，只能在读取时校验。**两段都要做**——入库前挡住脏数据，读取时挡住被改过的历史行。

### 6.3 可机械判定的字段白名单（v1，封闭：3 个数值字段 + 2 个布尔字段）

> **这张表不是"能力上限"，是"当前 `parsed_fields` 里可复算的字段目录"的上限。**
> 表外的一律只能写成**判断型** criterion（`question`），否则 `NO_RUBRIC`。
> 这条规则的目的：**禁止把模型的语言判断伪装成机械判定**。

**A. 数值型（可配 `GTE` / `LTE`）**

| `field` | 类型 | 单位 | 值从哪来 | 判定注意 |
|---|---|---|---|---|
| `timeline.covered_months_closed` | integer | 月 | `parsed_fields.timeline.covered_months_closed` | **有界量**：不能直接和 `value` 比大小，求值必须走 `screening-rules.md` §4.2.3 的三行表 |
| `work_experience.entry_count` | integer | 条 | `parsed_fields.fields.work_experience.entry_count` | 仅在 `fields.work_experience.state='present'` 时存在 |
| `education.entry_count` | integer | 条 | `parsed_fields.fields.education.entry_count` | 同上 |

**B. 布尔型（可配 `EXISTS`，`value` 必须为 `true`）**

| `field` | 语义 | 依据 |
|---|---|---|
| `work_experience` | 简历中存在可分割的工作经历条目 | `parsed_fields.fields.work_experience.state` |
| `education` | 简历中存在可分割的教育经历条目 | `parsed_fields.fields.education.state` |

> `EXISTS` 判的是 `state='present'`（**读到了**），不是"这个人有工作经历"。`state='absent'` → 结果 `MISSING`；`state='unreadable'` → 结果 `UNREADABLE`。三者语义完全不同，见 `screening-rules.md` §3.4。

**C. 故意**不**进白名单的字段**（写在这里，防止有人"顺手补上"）

| 字段 | 为什么不要 |
|---|---|
| `timeline.covered_years_closed` | 它是 `round(months/12, 2)` 的**派生浮点**；用作 `GTE 5` 时 `4.996` 与 `5` 的浮点比较无法在两个实现间稳定复现。要用年限就写 `covered_months_closed GTE 60` |
| `fields.*.evidence` / `fields.*.value`（`work_experience`/`education` 的 `value` 恒为 `null`） | 它们的"值"是 `entries[]` 这样的复合对象，不是可比较标量；强行比较等于自造语义 |

**D. 禁止作为 criterion 字段**（硬拒绝，不得"友好放行"）：
`name` / `phone` / `email`（身份与联络，不是资格；用它们筛人 = 身份筛选）、
`protected.*`（年龄/性别/婚育/籍贯/民族/照片，`D11 §9.6`）、
任何不在 A/B 两张表里的名字（哪怕它看起来很像）。

### 6.4 operator 封闭集与求值域

只有三个算子。**没有 `REGEX`、没有"关键词包含"、没有模糊匹配**——理由不是偷懒，是 `D11 §9.3`（拒绝可解释）与 `§9.4`（不得由模型估算）：文本级模糊命中无法给出"哪一行反证了这条要求"，因此不能作为 `FAIL` 的依据。

| `operator` | 适用字段类型 | `value` 类型 | 求值（`present` 时） |
|---|---|---|---|
| `EXISTS` | boolean 型字段（§6.3 B） | `true` | 命中 ⇔ `state='present'` |
| `GTE` | integer 型字段（§6.3 A） | 整数 | 命中 ⇔ `v ≥ value`；若有界量则按 `screening-rules.md` §4.2.3 |
| `LTE` | integer 型字段（§6.3 A） | 整数 | 命中 ⇔ `v ≤ value`；同上 |

**`value` 的类型细则**：`GTE`/`LTE` 一律写成**整数**，单位由字段决定（`timeline.covered_months_closed` 用**月**：5 年 = `60`）。禁止浮点（`5.0` 拒绝）：浮点在两侧序列化与比较中都会漂，而 `payload_hash` 是对文本求 sha256（§6.6）——`5.0` 与 `5` 会算出两个 hash，同一份"意思相同"的标准变成两个版本。此条写进 `R-VAL-11`。

### 6.5 硬性 / 加分 / 排除的语义（最容易理解错的一张表）

| `kind` | 它描述的是 | 命中（机械型） | 不命中 | 它对 `verdict` 的作用 |
|---|---|---|---|---|
| `MUST_HAVE` | **必须具备**的条件 | `SATISFIED` | `UNSATISFIED` | `SATISFIED` 是 PASS 的必要条件；`UNSATISFIED` 是 **FAIL 的充分条件** |
| `NICE_TO_HAVE` | **加分项**（有更好，无不影响） | `SATISFIED` | `UNSATISFIED` | **对 `verdict` 完全无影响**；只进 `bonus_signals[]` 与排序分 |
| `DISQUALIFIER` | **排除条件**（命中即出局） | `TRIGGERED`（= 命中排除条件） | `CLEAR` | `TRIGGERED` 是 **FAIL 的充分条件**；`CLEAR` 不产生任何正向证据 |

**三条硬裁决**：

1. **`weight` 不参与判定。** 权重高不能让一条 `NICE_TO_HAVE` 变成淘汰依据；权重 0 也不能让一条 `MUST_HAVE` 失去否决权。`Σweight=1` 只是**展示不变量**。
2. **`DISQUALIFIER` 的"命中"是坏事。** 它的 `SATISFIED` 语义被刻意改名为 `TRIGGERED`，就是为了防止实现者把它和 `MUST_HAVE` 共用一套真假逻辑。**同名不同义在本契约里是禁止的**。
3. **没有 `MUST_HAVE` / `DISQUALIFIER` 的 Rubric 是非法的**（`R-VAL-13`）。只有加分项 = 只能产"看起来不错"，不构成标准。

### 6.6 `payload_hash` 的规范 JSON（`R-VAL-14` 用它）

```
payload_hash = lowercase_hex( sha256( UTF-8( canonical_json(dimensions) ) ) )
```

`canonical_json` 的定义（实现方必须共用一个函数，见 §8 S-6）：

1. 对象键按 Unicode 码点升序；对象/数组内**不插入任何空白**；分隔符固定 `,` 与 `:`。
2. 字符串按 RFC 8259 转义，不做 NFKC（`D11 §A3`：不做毯式归一化）。
3. 数字：整数不带小数点；小数用**最简十进制**（无指数、无前导零、去掉尾随 0、小数位 ≤ 6）。`0.5` 只能序列化成 `0.5`，不得是 `0.50` 或 `5e-1`。
4. **可缺省的键在缺失时省略，不写 `null`**（§6.1 的单一裁决）：`null` 只在**入参**里表示"没给"，
   落库与 `payload_hash` 之前一律省略。因此机械型准则**没有** `question` 键、判断型准则**没有**
   `field`/`operator`/`value` 键。历史行可能带 `null`（2026-11-14 之前 `job_create` 就会写）：
   读侧必须按"`null` = 没给"处理（`field == null` → 判断型），这是兼容，**不是**允许新写入继续写 `null`。

不匹配 → `NO_RUBRIC/RUBRIC_HASH_MISMATCH`。理由：审批绑定的是 `canonical_payload_hash`（`ck_approval_hash`），若两者不一致，"被批准的到底是哪份标准"就无从证明（`D11 §9.9` 决策可回溯）。

---

## 7. 岗位状态 × 申请状态 → 在途申请怎么处理

### 7.1 处理矩阵（`screening-rules.md` §5 的门禁直接引用此表）

| `job.status` | `application.lifecycle_status` | 筛选能不能给 PASS/FAIL | 输出 | 依据 |
|---|---|---|---|---|
| `OPEN` | `ACTIVE` | ✅ 能 | 正常评估 | — |
| `OPEN` | `ON_HOLD` | ✅ 能 | 正常评估 + `warnings: APPLICATION_ON_HOLD`（不改 `verdict`） | 暂缓是流程动作，不是标准失效 |
| `OPEN` | `WITHDRAWN` / `CLOSED` | ❌ | `NEEDS_REVIEW` + `GATE_APPLICATION_NOT_ACTIVE` | `ck_application_lifecycle_status` |
| `PAUSED` | `ACTIVE` / `ON_HOLD` | ✅ 能 | 正常评估 + `warnings: JOB_PAUSED` | **裁决：暂停不冻结在途**（§7.2） |
| `PAUSED` | `WITHDRAWN` / `CLOSED` | ❌ | 同上行 | — |
| `CLOSED` | 任意 | ❌ | `NEEDS_REVIEW` + `GATE_JOB_CLOSED`，**不评估 criterion** | 裁决（§7.2） |
| `ARCHIVED` | 任意 | ❌ | `NEEDS_REVIEW` + `GATE_JOB_ARCHIVED` | 同上 |
| `DRAFT` / `PENDING_REVIEW` / `APPROVED` | 任意 | ❌ | `NEEDS_REVIEW` + `GATE_JOB_NOT_OPEN` | 岗位未开放，不该有申请 |

> "❌"不等于"报错"。**只有 `screening-rules.md` §6.2 的 7 条阻断检查（+ §3.1 的"材料归属未知"）命中时才抛 `BLOCKED_BY_REVIEW`**。岗位关闭是**业务状态**，不是"有人正在处理"，因此走 `NEEDS_REVIEW` 而不是错误码——否则实现者会把所有异常都塞进 `BLOCKED_BY_REVIEW`，那个码就废了。

### 7.2 为什么 `PAUSED` 不冻结、`CLOSED` 就停

| 状态 | 业务含义 | 若冻结会怎样 | 裁决 |
|---|---|---|---|
| `PAUSED` | 暂停**新增**投递/发布（编制冻结、预算复核…） | 已经面试完的人无法推进决策 → 流程死锁；已投入的成本无法结算 | **不冻结**，只在输出标 warning |
| `CLOSED` | 岗位已经结束（招满/取消） | 继续出 PASS 等于"给一个不存在的岗位推荐人"，且极易被用来批量清库存 | **停止产生自动建议**，交人工 |
| `ARCHIVED` | 归档，仅查询 | 同 `CLOSED` | 同 `CLOSED` |

### 7.3 岗位关闭后，已在进行中的申请**必须有人做的事**

关岗**不自动关闭任何申请**（不批量 `REJECT`、不批量 `CLOSED`）。人工必须显式选择其一，三条都由写侧完成，**筛选工具一条都不做**：

1. **转岗**：为同一 candidate 在另一 `job` 下新建 `application`（新 `job_version_id` + 新 `rubric_version_id`）。旧申请保留，`lifecycle_status='CLOSED'`。
2. **归档进人才库**：v1.0 缓做（`Talent Pool` 未建表，`SCHEMA.md` §5），只能靠 `candidate` + 历史 `application` 检索。
3. **关闭申请**：`decision(scope='FINAL', result='REJECT'|'WITHDRAW')` + 非空 `reason`（`ck_decision_reason`）。

> 这三件事都需要 `actor.kind='HUMAN'`。`execution_mandate` 里永远没有 `decide`/`reject`（`N27`）。

---

## 8. 与现有 schema 对不上的地方（**需要上级裁决**）

按"会不会真的出事"排序。字段名全部逐字取自 `0001_init.sql`，未加引号的都是我引用不到的**缺失项**。

| # | 缺口 | 现在的库能表达吗 | 影响 | 建议 |
|---|---|---|---|---|
| **S-1** | ~~`job` **没有** `current_rubric_version_id`~~ | ✅ **已解决** | `0004_stage_catalog.sql:243-289` 已加 `job.current_rubric_version_id uuid` + 复合外键 `fk_job_current_rubric (tenant_id, id, current_rubric_version_id) → rubric_version (tenant_id, job_id, id)`（方案 b）。**D-21/D-48 裁决**：当前只由该指针说话，§4.2 已改为"取该列，空则 `NO_RUBRIC`，不回退" | 已落地；`recruitment_job_rubric_approve` 是维护它的写入口 |
| **S-2** | `rubric_version` 无 `schema_version` 列；`dimensions` 只有"非空 array"约束（L609） | ⚠️ 部分 | §6 的结构契约**库里拦不住**；脏 Rubric 只能在读取时发现 | `0002`：加 `rubric_version.schema_version integer not null default 1` + 至少一条 `CHECK`（`kind`/`operator` 枚举、键集） |
| **S-3** | `application.rubric_version_id` 只做 `(id, tenant_id)` 外键（L866-867）→ **能指向别的 job 的 Rubric**；`application.job_version_id` 同样只校 tenant（L864-865） | ❌ | `RUBRIC_JOB_MISMATCH` 类脏数据可入库，且"钉住"形同虚设 | `0002`：`rubric_version` 加 `unique (id, job_id)`、`job_version` 加 `unique (id, job_id)`；`application` 改成复合外键 `(rubric_version_id, job_id)`、`(job_version_id, job_id)`。**这是本表里最该修的一条** |
| **S-4** | 没有"人工待办"实体；只有 `business_task.status='WAITING_HUMAN'` + `business_refs jsonb`（L1401、L1441-1443），`business_refs` 只校验"是 array"（L1445） | ⚠️ | `screening-rules.md` §6.2 的阻断查询依赖 `business_refs` 的元素形状，现在**库不保证** | 约定 `business_refs` 元素 = `{"kind":..., "id":"<uuid>"}`，`kind` 封闭集见 `screening-rules.md` §6.2；并在 `0002` 加 `CHECK`（或至少写进 `db/README.md`） |
| **S-5** | `resume_version.parsed_fields` 只有 `jsonb_typeof='object'`（L829）；三态、`evidence`、`timeline` 全部无约束 | ⚠️ | 本契约的**输入**没有库级保证；上游写错时筛选只能降级 | 由 S6 契约（含身份解析）保证形状；`screening-rules.md` §3.2 规定"取不到三态就 `UNREADABLE` + warning"，**不猜** |
| **S-6** | `canonical_json` / `payload_hash` 的**覆盖范围**与序列化规则，库里没有、仓库里也没有共享实现 | ❌ | 写侧与读侧各自实现 → `R-VAL-14` 大量误报，或审批绑定形同虚设 | 落一份共享实现（建议 `packages/domain` 或 `db/`），本契约 §6.6 是它的规范；未落地前 `R-VAL-14` 只能作为**告警**而非硬失败（需裁决） |
| **S-7** | `decision.basis_refs` 只校验"是 array"（L1358）→ `reasons[]` 的证据坐标无结构保证 | ⚠️ | `D11 §9.9`（决策可回溯）只能靠写侧自觉 | 写侧必须存 `tool-contracts.md` §3.7 的 `basis_refs` 结构；`0002` 可加 `CHECK` 或独立证据表（本轮不做） |
| **S-8** | `rubric_version` 与 `job_version` 之间**没有任何关联列** | ⚠️ 无影响 | 无法回答"这版标准依据哪一版 JD" | v1.0 **不要求**；若审计要，`0002` 加 `rubric_version.basis_job_version_id` |

> **S-1 已解决**（`0004` 显式指针 + D-21/D-48）；`S-4`/`S-5`/`S-7` 的应用层约定仍足以让 S7 跑通 Golden Path。
> **S-3 建议优先修**（一条脏数据能让整条结论归错标准；0005 已补 `fk_application_rubric_job` 的**同岗位**复合外键，
> 即申请钉的 rubric 必须属于同一 job + 租户——这一条已从"❌ 可入库"降为"库层拦得住"）。

---

## 9. 变更规则

1. `dimensions` 的键集（§6.1）或 `operator` 集（§6.4）增删 → bump `job-rubric 1.x.0`，并同步 `screening-rules.md` §4.1 的求值表 + `tool-contracts.md` 的 `rubric` 输出。
2. 白名单（§6.3）增删字段 → 必须同时说明"`parsed_fields` 从哪一版开始产出该字段"，否则旧简历会被静默判成 `MISSING`（这是最危险的回归）。
3. §4.2 的 `current` 定义改动 = **破坏性变更**：所有历史结论的"当时标准"会漂移 → 必须 bump 到 `2.0.0` 并写迁移说明。
4. 本文件与 `screening-rules.md` 冲突时 → **以本文件为准**（版本解析、标准结构归 S3）；两文件与 `tool-contracts.md` 冲突时 → 以规则文件为准，工具契约只是形状。

---

## 10. 自检清单（全部可机检，一项不过即不算交付）

| # | 检查 | 期望 |
|---|---|---|
| 1 | 同一 `(job_id, as_of)` 调 `current` 两次 | 返回同一 `version_id` |
| 2 | 尝试 `UPDATE rubric_version SET dimensions=...` | SQLSTATE `23514`（`N21` 同类） |
| 3 | 对同一岗位连发两版 Rubric | 两个 `version_no`，旧版 `dimensions` 不变 |
| 4 | 给一条 `field='name'` 的 criterion | `NO_RUBRIC/RUBRIC_INVALID(CRITERION_FIELD)`（或因 `PROTECTED` 规则拒绝） |
| 5 | 给一条只有 `field` 没有 `operator` 的 criterion | `NO_RUBRIC/RUBRIC_INVALID(CRITERION_PARTIAL)` |
| 6 | 给一条 `Σweight = 0.9` 的 Rubric | `NO_RUBRIC/RUBRIC_INVALID(WEIGHT_SUM)` |
| 7 | 给一条 `kind='NICE_TO_HAVE'` 且 `UNSATISFIED` 的 Rubric | `verdict` 不因它变成 `FAIL` |
| 8 | 只有 `NICE_TO_HAVE` 的 Rubric | `NO_RUBRIC/RUBRIC_INVALID(NO_DECIDING_CRITERIA)` |
| 9 | 已存在 `application.rubric_version_id=v1`，发布 v2 后重调 | 仍用 v1，`resolution='APPLICATION_PINNED'`，`is_current=false` |
| 10 | 用 `as_of` 回到审批过期之前的时刻 | `approved` 判定按 `as_of`，不是按 `now()` |
| 11 | 岗位 `CLOSED` 后调评估 | `NEEDS_REVIEW` + `GATE_JOB_CLOSED`，且 `criteria_evaluated=false` |
| 12 | 岗位 `PAUSED` 后调评估 | 正常出结论 + `warnings` 含 `JOB_PAUSED` |
