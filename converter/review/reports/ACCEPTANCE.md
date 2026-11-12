# review · 验收证据（真实输出摘录）

**时间**：2026-11-13 01:16 +08（本机）
**库**：`ra_review_check`（新建；未碰其它库）
**PostgreSQL**：17.11
**迁移**：`0001_init.sql` → `0002_seed.sql` → `0003_review_queue.sql`
（0003 SHA256 `85BB07A176A5C24883DE2BF4C865ADD081C77644FA478B745FA0B7F25CA43BD4`，含 D-36 主键改名）
**完整输出**：`acceptance-run.txt`（demo）、`pytest.txt`（单测）、`cli-evidence.txt`（CLI）

---

## 1. 建库与迁移

```
=== 1. rebuild database ===
DROP DATABASE
CREATE DATABASE
=== 2. migrations 0001 -> 0002 -> 0003 ===
0001_init.sql: exit=0 last=COMMIT
0002_seed.sql: exit=0 last=COMMIT
0003_review_queue.sql: exit=0 last=COMMIT
ra_review_check|17.11
tables|3
```

## 2. 单测

```
$ python -m pytest review/tests -q
...................................................                      [100%]
51 passed in 3.11s
```

**passed 51 / failed 0 / skipped 0。** 每个用例一个回滚事务（历史表禁止 DELETE）。

## 3. 完整链路（`python -m review.demo_acceptance`）

```
subject application=4be00c7f-4ece-4812-98f8-3ec4662e31ef
run=fd177c38-f4b5-4231-82ae-fe2bd9e87a03  sha256=…(QUARANTINED)

入队 item_id=f9e393d1-1df8-4655-bbad-ea90f0b19db0
status=QUEUED  deadline=2026-11-14T01:16:12.018284+08:00
audit: [(None, 'QUEUED', '合成-转换器（系统）')]

claim: status=IN_REVIEW  assignee=<复核员甲>
submit page 2: status=CORRECTED
machine_result sha(16) before=… after=…  equal=True
human_result summary: {"schema": "human_read/v1", "transcriptions": 1, "pages": [2],
                      "adopted_pages": [2], …}

merge: blocks: 2 (native 1, human 1)
       human block: {"kind":"paragraph","location":{"bbox":null,"page":2},
                     "provenance":"human_read", …}
       text (native only, unchanged): '合成测试第 1 页文本（非真实简历）。'
       text_with_human_read: '…第 1 页…\n\n…第 2 页（人工转录）…'
       issues: ['unread_visual_page']   ← 原始 issue 保留
       issue_resolutions: [{"code":"unread_visual_page","page":2,
                            "status":"resolved_by_human","basis":"human_transcribed_page", …}]

approve: status=APPROVED  closed_at=2026-11-13T01:16:12.018284+08:00
audit:
  #87 (入队) → QUEUED        by 合成-转换器（系统）
  #88 QUEUED → IN_REVIEW     by 合成-复核员甲
  #89 IN_REVIEW → CORRECTED  by 合成-复核员甲
  #90 CORRECTED → APPROVED   by 合成-复核员乙
```

**并存证明**：`machine_result` 的规范 JSON SHA256(16) 在 `submit` 前后完全相同
（`equal=True`），人工结果另存 `human_result`；合并产物的 `text` 仍是原生正文
（`text_native_only=true`），人工文本只出现在 `text_with_human_read` 与
`provenance=human_read` 的 block 里。

## 4. 阻断验证（关键）

同一对象、同一 `source_sha256`，四次真实输出：

```
[before enqueue] blocked = True
  - QUEUE_ITEM_MISSING: 最新 run … 是 QUARANTINED，但队列里没有对应条目（漏记；按阻断处理）
  v_source_gate: {'gate': 'UNACCOUNTED', 'blocking': True, …}

[QUEUED（未处理）] blocked = True
  - REVIEW_PENDING: run … 处于 QUARANTINED，人工队列项未结案（QUEUED）；下游只能显示「待核」
        (item=f9e393d1-…, deadline=2026-11-14T01:16:12+08:00, overdue=False)

[IN_REVIEW（未处理）] blocked = True
  - REVIEW_PENDING: … 未结案（IN_REVIEW）…

[CORRECTED（默认口径：等待复核）] blocked = True
  - CORRECTION_AWAITING_APPROVAL: … 人工补正已录入但尚未复核放行 …

[APPROVED（已处理）] blocked = False
  (none)
  v_source_gate: {'gate': 'CLEARED', 'blocking': False, 'open_items': 0, 'human_verdict': 'APPROVED'}
```

CLI 侧同口径（`cli-evidence.txt`）：

```
$ python -m review.cli check-blocking 4be00c7f-…   # APPROVED
blocked: False
reasons: (none — 放行)
exit=0

$ python -m review.cli check-blocking 633ef313-…   # IN_REVIEW
blocked: True
  - [REVIEW_PENDING] …（IN_REVIEW）… deadline=… overdue=False
exit=3
```

## 5. 负例（绕过本模块直接写库）

```
[REJECTED] QUEUED → APPROVED（跳过 IN_REVIEW）
  sqlstate=23514  message=QUEUE_ILLEGAL_TRANSITION: QUEUED → APPROVED 不在允许的 8 条边内
[REJECTED] IN_REVIEW → CORRECTED（缺 human_result）
  sqlstate=23514  message=QUEUE_CORRECTED_NEEDS_HUMAN_RESULT: CORRECTED 必须同时写入 human_result
```

单测里另有：`machine_result` UPDATE 被 `QUEUE_IMMUTABLE` 拒绝、无 actor 被
`ACTOR_REQUIRED` 拒绝、deadline 不能缩短、审计/队列不能删改。

## 6. 交付物行数

| 文件 | 行数 |
|---|---:|
| `review/queue.py` | 673 |
| `review/transcription.py` | 420 |
| `review/blocking.py` | 377 |
| `review/merge_human.py` | 333 |
| `review/cli.py` | 384 |
| `review/demo_acceptance.py` | 416 |
| `review/tests/conftest.py` | 319 |
| `review/tests/test_queue.py` | 223 |
| `review/tests/test_blocking.py` | 224 |
| `review/tests/test_transcription.py` | 173 |
| `review/tests/test_merge.py` | 137 |
| `review/tests/test_negatives.py` | 110 |
| `review/README.md` | 193 |

（`review/reports/` 内为上述证据文件；`merged-sample.json` 是合并产物样例，只含合成文本。）

## 7. 口径说明

任务书写「APPROVED/CORRECTED → 放行」，但 0003 里 `CORRECTED` **不是终态**
（`closed_at` 为空、`v_review_open` 仍算未结案）。默认与库一致：`CORRECTED` 仍阻断，
原因码 `CORRECTION_AWAITING_APPROVAL`。任务书字面口径可用参数显式打开：

```
python -m review.cli check-blocking <id> --treat-corrected-as-resolved   # 或
blocking.screening_blocked(<id>, open_states=("QUEUED", "IN_REVIEW"))
```

两种行为都有断言（`test_blocking.py::test_corrected_still_blocks_by_default_but_policy_can_release`）。
