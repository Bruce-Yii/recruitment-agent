# review · 转换层的人工兜底与回填

**对应验收**：`work/handoff/12-layer-acceptance.md` §2④（HUM-01…05，重点是 §5③「必须验阻断，不只是验入队」）
**对应历史**：`0003_review_queue.sql` 的三张表（只读，本目录**不改** `db/`）
**并存口径**：`work/control/DECISIONS-2026-11-12.md` D-29（机器状态保留、人工结果另存）

四个模块 + 一个 CLI：

| 文件 | 作用 | 验收项 |
|---|---|---|
| `queue.py` | 入队 / 待处理 / 认领 / 补正 / 放行 / 驳回；审计由 0003 触发器写 | A |
| `transcription.py` | 人工逐页转录的存取：只追加、可标「当前采用哪一份」、按 sha256+页查 | B |
| `merge_human.py` | 把人工转录并进转换器输出：新 block、`provenance=human_read`、不覆盖原生 block、记 `human_read_applied` | C |
| `blocking.py` | `screening_blocked()`：队列未处理时挡下游，处理完放行 | D |
| `cli.py` | `enqueue / list / claim / submit / approve / reject / check-blocking`（另加 `merge/show/transcriptions/audit`） | E |

---

## 1. 数据放在哪里（以及为什么不新建表）

`db/` 是只读的，0003 已经给了人工结论的落点 `review_queue.human_result`（jsonb）。
因此人工转录存在 `human_result.human_read` 子对象里，**没有新建表、没有改迁移**：

```json
{
  "human_read": {
    "schema": "human_read/v1",
    "transcriptions": [
      {"transcription_id": "…", "sha256": "…64 位…", "page_no": 2,
       "text": "…", "actor": "…", "created_at": "2026-11-13T…+00:00",
       "source": "human_read"}
    ],
    "adopted": {"2": "<transcription_id>"}
  }
}
```

* 机器结果在 `conversion_run.result_json`（全文）+ `review_queue.machine_result`（摘要）。
* **D-36（0003 原地改名）**：三张表的主键已统一为 `id`（`conversion_run.id` /
  `review_queue.id` / `review_audit.id`），视图仍以 `item_id` / `run_id` 作为
  对外列名。本模块 SQL 写 `id`，对 Python/CLI 仍保留任务书的 `item_id` / `run_id`
  命名。本机验收时的 0003 SHA256 见 §6。
* 0003 的 `fn_review_queue_before_update` **禁止 UPDATE `machine_result`**，人工补正只能写
  `human_result`——「两份都保留」由数据库保证，不靠调用方自觉。
* `human_read` 之外的键（其它工具写的 `corrected_fields` / `note`）原样保留。
* 转录只追加；`adopted` 是「当前采用」的指针，切换不删除历史。

## 2. 两个实现选择（任务书要求说明理由）

### 2.1 PostgreSQL 驱动：psycopg 3，不用 psql 子进程

* 本机已装 `psycopg 3.3.5`，不引入新依赖、不联网（R1/R6）。
* 真参数绑定：转录正文里的引号、换行、Unicode 不会变成 SQL；psql `-c` 需要自己做字符串转义，
  人工录入恰恰是最不可控的输入。
* 连接内 `select set_config('recruitment.actor_id', %s, true)` 精确实现 0003 要求的
  `SET LOCAL`（D-18：禁止 `SET`，会被连接池泄漏）；psql 每次调用要重新拉连接 + 拼
  `BEGIN; SET LOCAL; ...; COMMIT;`。
* 错误按 SQLSTATE / `diag.constraint_name` 翻译成 `ReviewError.code`，比解析 psql 文本输出可靠。
* 代价：需要 Python 驱动。它已经在了，所以 psql 只在人工排障时使用。

### 2.2 审计：用 0003 的触发器，不在应用层显式插入

* `trg_review_queue_audit` 对每次 INSERT/UPDATE 自动写 `review_audit`，**应用层无法漏记**，
  绕过本模块的 SQL 也会留痕。
* 若再手工插一条，会和触发器重复写入并撞 `uq_review_audit_transition`（同一 `to_status` 只能一条）。
* actor 来自 `SET LOCAL recruitment.actor_id`，审计里的「谁」不依赖调用方传参。
* 每次状态变更的「为什么」由 `reason` 提供；非状态变更（补转录 / 换采用）也各留一行
  （`from_status = to_status`），符合 0003 注释「审计宁可多一行，不能少一行」。

## 3. 关键口径：CORRECTED 到底放不放行？

任务书写「APPROVED/CORRECTED → 空列表（放行）」，但 0003 的口径是：

* `review_queue.status` 的终态只有 `APPROVED / REJECTED / REPROCESS`（`closed_at` 非空）；
* `CORRECTED` 的 `closed_at` 为空，`v_review_open` / `v_source_gate.open_items` 都把它算作**未结案**。

人工补正 ≠ 复核放行。若 CORRECTED 就放行，下游可能拿**没有合并人工转录的机器结果**去筛选，
正好落在 doc 12 HUM-03「若放行就会错误淘汰」的场景里。

因此 `blocking.screening_blocked()` **默认与 0003 一致，CORRECTED 仍阻断**（原因码
`CORRECTION_AWAITING_APPROVAL`），任务书字面口径可用参数显式打开：

```python
blocking.screening_blocked(app_id, open_states=("QUEUED", "IN_REVIEW"))  # CORRECTED 放行
# 或 CLI: check-blocking <id> --treat-corrected-as-resolved
```

两种行为都有测试断言（`test_blocking.py::test_corrected_still_blocks_by_default_but_policy_can_release`），
不是隐藏开关。**这是本交付唯一与任务书字面不同之处**，请验收方裁决。

阻断判据（`evaluate()` 的完整输出）：

| 情形 | verdict | 是否阻断 |
|---|---|---|
| 任一 run 上有 `QUEUED/IN_REVIEW` | `PENDING_REVIEW` | 是（`REVIEW_PENDING`） |
| 任一 run 上有 `CORRECTED`（默认口径） | `PENDING_REVIEW` | 是（`CORRECTION_AWAITING_APPROVAL`） |
| 最新 run `ACCEPTED` | `CLEARED` | 否 |
| 已有 `APPROVED` | `CLEARED` | 否 |
| 已有 `REJECTED` | `REJECTED` | 否（人工已判原件不可用，下游只能显示「不符合」） |
| 最新 run 非 ACCEPTED 且**没有**队列条目 | `UNACCOUNTED` | 是（`QUEUE_ITEM_MISSING`，漏记 fail closed） |
| 有已结案条目但无放行结论（如 `REPROCESS`） | `NO_RELEASING_VERDICT` | 是 |
| 源文件从未转换（有 sha 无 run） | `NOT_CONVERTED` | 是（`NO_CONVERSION_RUN`，本模块更保守） |

前 7 行与 `v_source_gate` 的 `gate/blocking` 一致（另外把「任一 run 的未结案条目」也算进来，
比视图只看最新 run 更严）；第 8 行是 fail-closed 补充，只影响「有原件但没转换过」的对象。

## 4. 合并语义（`merge_human.py`）

与 `fallback/merge.py`（③ 模型层，已落地）同一套合并语义：

1. 每条「当前采用」的转录追加一个 `paragraph` block：
   `provenance="human_read"`、`location={"page": N, "bbox": null}`、`links=[]`。
2. 原生 block 逐字段保持原样；合并前后做快照比对，被改动直接报 `NATIVE_BLOCKS_CHANGED`。
3. **`text` 一字不改**（与 `fallback/merge.py` 相同，doc 11 A2 保真校验仍成立）；
   人工文本另给 `text_with_human_read` + `text_native_only=true`。
4. 机器判定（`completeness` / `needs_visual` / `fields`）不升级、不改写。
5. 原始 `issues` 一条不删；被人工读过页上的 issue 另记 `issue_resolutions`
   （`status="resolved_by_human"`, `basis="human_transcribed_page"`）。
6. `human_read_applied[]` 记录 `transcription_id / page / actor / created_at / sha256 /
   chars / text_sha256 / block_index`；重复合并记 `human_read_skipped`。
7. 幂等：已应用过的转录按 id 跳过（`skipped_already_applied`），重跑不堆重复 block。
8. 不修改入参：深拷贝返回新对象；机器原文仍在库里，合并结果是派生文档。
9. 同一页传多份转录会被拒绝（`DUPLICATE_PAGE_TRANSCRIPTION`）——先按 `adopted` 选一份。

> 模型层与人工层是两条**并列**的追加通道，不共用 `provenance`：
> `model_read`（fallback）与 `human_read`（本模块）。两者都不改原生 `text`，
> 下游按 provenance 取用，不会把模型读的当成人工读的。

## 5. CLI

```powershell
$env:PGHOST='127.0.0.1'; $env:PGUSER='postgres'; $env:PGPASSWORD='******'
$env:PGDATABASE='ra_review_check'; $env:REVIEW_SYSTEM_ACTOR_ID='<机器侧 actor uuid>'
cd D:\12412\dsh工作区\projects\recruitment-agent\converter

python -m review.cli enqueue --run-id <uuid> --reason "pdf_no_text：纯图像页"
python -m review.cli list [--overdue] [--status QUEUED]
python -m review.cli claim <item> --assignee <actor-uuid> --actor <actor-uuid>
python -m review.cli submit <item> --page 2 --text-file page2.txt --actor <actor-uuid>
python -m review.cli approve <item> --reason "逐页核对无误，放行" --actor <actor-uuid>
python -m review.cli reject  <item> --reason "原件损坏，无法读取" --actor <actor-uuid>
python -m review.cli check-blocking <application-or-candidate> [--json]
python -m review.cli merge <item> [--out merged.json]
python -m review.cli audit <item>
python -m review.cli transcriptions --sha256 <sha> --page 2
```

`check-blocking` 退出码：`0` 放行、`3` 阻断、`4` 业务冲突/找不到、`2` 输入错误。
正文优先用 `--text-file`（UTF-8），避免 Windows 控制台代码页改写。

`enqueue` 的 actor 是**机器侧**：由 `REVIEW_SYSTEM_ACTOR_ID` 提供（或显式 `--actor`），
不从人工默认值里取，避免「系统动作记到人头上」。

## 6. 测试与验收（本机已跑）

```powershell
# 只连自建库 ra_review_check；每个用例一个回滚事务（历史表禁止 DELETE）
$env:PGHOST='127.0.0.1'; $env:PGPORT='5432'; $env:PGUSER='postgres'
$env:PGPASSWORD='******'; $env:PGDATABASE='ra_review_check'
python -m pytest review/tests -q          # 51 passed / 0 failed / 0 skipped

# 端到端：入队 → 认领 → 转录 → 合并 → 放行 + 阻断前后对比 + 两条负例
python -m review.demo_acceptance
```

本机验收基线（2026-11-13 01:16 +08）：

* PostgreSQL 17.11，`ra_review_check` 由 0001 → 0002 → 0003 新建；
* `db/migrations/0003_review_queue.sql` SHA256
  `85BB07A176A5C24883DE2BF4C865ADD081C77644FA478B745FA0B7F25CA43BD4`（含 D-36 改名）；
* 证据：`review/reports/pytest.txt`、`review/reports/acceptance-run.txt`、
  `review/reports/cli-evidence.txt`。

测试守护的边界（节选）：

* 未处理时 `screening_blocked` 非空；`APPROVED` 后为空（同一对象、同一 sha）。
* 直接 `QUEUED → APPROVED`（跳过 IN_REVIEW）被 0003 拒绝，SQLSTATE `23514`。
* `CORRECTED` 缺 `human_result` 被拒绝（`QUEUE_CORRECTED_NEEDS_HUMAN_RESULT`）。
* 人工补正后 `machine_result` 逐字节不变；`machine_result` 的 UPDATE 被
  `QUEUE_IMMUTABLE` 拒绝。
* 没有 actor 的写入被 `ACTOR_REQUIRED` 拒绝；deadline 不能缩短；审计/队列不能删改。

## 7. 边界与已知限制

* **不建表、不改 `db/`、不改 `converter/src|tests`、不碰 `fallback/` 与 `dsh/`**；
  本目录之外只写过自建库 `ra_review_check` 和本目录的 `reports/` 证据文件。
* 全部测试数据是合成的（`synthetic-*.pdf` / 「合成测试…」），不含真实简历内容（R7）。
* 转录存在 jsonb 行内，单页上限 1 MiB（超过应走对象存储）；`human_result` 适合
  「少量页 + 少量复核轮次」，不适合整本大文件。
* 「谁在用」记录在合并产物的 `human_read_merge.merged_by/merged_at` 与
  `human_read_applied[]` 里；若下游把合并结果落成独立 artifact，应一起保存这份元数据。
* 本仓库有两个 converter 副本（`recruitment-agent/converter` 与
  `recruitment-os/converter`）。任务书指定的是前者，本目录只存在于前者。
