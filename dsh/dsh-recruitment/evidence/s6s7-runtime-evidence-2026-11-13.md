# S6 / S7 运行时证据（2026-11-13）

**这份文件只记真实运行发生过的事**，不含设计说明（那些在 `contracts/` 与 `README.md`）。
每条都附命令原文与真实输出；候选人姓名/手机号/邮箱一律打码（R7）。

| 项 | 值 |
|---|---|
| 入口 | `dsh --profile rec-agent-test "<prompt>"`（headless，真实模型 `beam-free`） |
| profile 配置 | `D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml`（本次新增 `database:` 段） |
| 会话日志 | `$DSH_HOME/sessions/--D-12412-dsh~5DE5~4F5C~533A-projects-recruitment-os--/session-c2b910fb-b18f-4250-b02c-a59c3233df56/session.v3.jsonl.zstd` |
| 库 | `ra_s6s7`（migrations 0001→0006 各 exit=0） |
| 输入 PDF | `converter/corpus/synthetic/platform_noise.pdf`（**真实个人资料**，见下） |

---

## 1. 配置树里真的有 `database` 段

```powershell
$ dsh --profile rec-agent-test --dump-config | Select-String -Pattern 'recruitment|database|tenant_id|actor_id'
> # == @recruitment/dsh-recruitment, patched by D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml
> - id: recruitment
>   name: '@recruitment/dsh-recruitment'
>     database:
>       host: 127.0.0.1
>       database: ra_s6s7
>       password_env: RECRUITMENT_DB_PASSWORD
>       tenant_id: 11111111-1111-4111-8111-000000000001
>       actor_id: 11111111-1111-4111-8111-000000000103
```

## 2. 一次 headless 跑出 3 次 tool/call + 3 次 tool/result（全部 `isError: false`）

会话日志解压后（`manual/extract-session-tools.py`，按 callId 配对、自动打码）：

```text
--- tool/call #1 ---
{"name": "recruitment_application_intake", "callId": "call-67e46471-…",
 "arguments": "{\"job_id\":\"11111111-1111-4111-8111-000000000401\",\"path\":\"D:\\\\…\\\\platform_noise.pdf\"}"}
--- tool/result #1 (call=call-67e46471-…, tool=recruitment_application_intake) ---
intake: replayed application 00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc
candidate c110817b-b09b-472f-b6a8-a09c1ceabe2f (existing, matched_by=existing)
job DEMO-BE-001 [OPEN] stage=S6 lifecycle=ACTIVE
source: platform_noise.pdf pages=1 bytes=256228
sha256=c6ceb2eef64dfc3fac4061a06a54f6576dc85659731387f036f2506b7d640893
parse_status=PARTIAL completeness=partial hard_issues=0
identity strong_ids=[email, phone] evidence=2 blocked=[]
labels: provenance=FIXTURE trigger=MANUAL connection=CONNECTED

--- tool/call #2 ---（参数与 #1 完全相同）
--- tool/result #2 ---（与 #1 逐字相同：同一 application_id / candidate_id，created=false）

--- tool/call #3 ---
{"name": "recruitment_screening_evaluate", "callId": "call-9ca4e4bb-…",
 "arguments": "{\"application_id\":\"00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc\"}"}
--- tool/result #3 ---
recruitment_screening_evaluate 1.0.0 status=OK advisory=true read_only=true
labels: provenance=FIXTURE trigger=MANUAL connection=CONNECTED
application 00d0f6c0-… stage=S6 lifecycle=ACTIVE rv=1
job 后端工程师（演示） [OPEN]
resume_version v1 parse_status=PARTIAL hard_issues=0 pages=1
rubric v2 resolution=JOB_CURRENT what_if=false criteria=3
preconditions: human_queue_checked=7 material_ready=true
verdict: NEEDS_REVIEW (criteria_evaluated=true, required_human_action=REVIEW_UNREADABLE)
summary: 2 条硬性条件：0 满足 / 0 反证 / 2 不确定；0 条排除条件命中 → 需人工复核（work_exists:UNREADABLE, edu_exists:UNREADABLE）
  [MUST_HAVE_UNREADABLE] work_exists field=work_experience tri_state=unreadable evidence=0 — …不得据此判定不满足
  [MUST_HAVE_UNREADABLE] edu_exists field=education tri_state=unreadable evidence=0 — …不得据此判定不满足
  bonus [BONUS_NEEDS_JUDGMENT] team_lead — 这条要求机器判不了（第 3 条），需要人回答 rubric 里的原问句
  warning RUBRIC_PIN_REQUIRED: 本次按 JOB_CURRENT 解析；写侧落 decision 前必须先钉 rubric_version_id
snapshot: app_rv=1 rubric=11111111-1111-4111-8111-000000000404
evaluation_digest=0c4564c91b7cc25bf1d3be7cc463a0e3864fac040311beffac357b3b7e289f87
```

> 两次 intake 都是 `replayed`：这条 application 是同一进程外的 `manual/s6s7-live.mjs` 先建的
> （同 `sha256 + job_id`）。所以这次 headless 顺带证明了**跨进程幂等**；`created=true`
> 的那一次在 §3 的 DB 读回里有对应行。

## 3. DB 读回（打码）

```sql
select left(c.display_name,2)||'***', left(c.normalized_phone,4)||'****'||right(c.normalized_phone,2),
       left(split_part(c.normalized_email,'@',1),1)||'***@'||split_part(c.normalized_email,'@',2)
  from recruitment.candidate c where c.tenant_id='1111…0001' order by c.created_at;
```

```text
             candidate_id             | display_name_masked | phone_masked |        email_masked        | identity_status
--------------------------------------+---------------------+--------------+----------------------------+-----------------
 11111111-1111-4111-8111-000000000601 | 演示***             | +861****00   | z***@demo-recruitment.test | ACTIVE
 c110817b-b09b-472f-b6a8-a09c1ceabe2f | 孙光***             | +861****49   | s***@163.com               | ACTIVE
```

```text
            application_id            |  job_code   | stage | lifecycle_status | record_version | parse_status |   assetsha    | validation_status | intake_status | event_provider | same_material_apps
--------------------------------------+-------------+-------+------------------+----------------+--------------+---------------+-------------------+---------------+----------------+--------------------
 11111111-1111-4111-8111-000000000701 | DEMO-BE-001 | S7    | ACTIVE           |              2 |              |               |                   |               |                |                  0
 00d0f6c0-c7b0-4e62-be62-ae7f0c6ea0bc | DEMO-BE-001 | S6    | ACTIVE           |              1 | PARTIAL      | c6ceb2eef64d… | VALID             | RESOLVED      | internal       |                  1
```

`same_material_apps=1` = 同一 `(sha256, job_id)` 只有一条申请（幂等的库层证据）。

```text
decision_rows=0      ← S7 没有写任何决策（advisory）
candidate_merge_rows=0 ← S6 只关联、不合并
```

## 4. 仍然没做到 / 已知缺陷

1. **`platform_noise.pdf` 是真实个人资料**（放在 `corpus/synthetic/` 里）。本次只做本地联调，
   证据里全部打码，PDF 未入库（`*.pdf` 已被 `.gitignore` 忽略）。**它应当被替换成真正合成的页面。**
2. **`created=true` 的那次不是 headless 跑的**（是 `manual/s6s7-live.mjs`）。
   headless 只跑到 `created=false` 的幂等路径 —— 为了不重复消耗模型额度，没有再造一条新材料。
3. **verdict 只有 `NEEDS_REVIEW`**：`platform_noise.pdf` 的 `work_experience` / `education` 都是
   `unreadable`（`reading_order_unverified` / `entries_not_segmentable`），所以真实链路上
   出不了 PASS/FAIL。PASS/FAIL/INDETERMINATE/GATE/BLOCKED 由
   `test/integration/screening.test.ts` 在真库上（事务内）逐个覆盖。
4. **没有跑 Web GUI 会话**：只验了 headless。Web 侧的工具卡片会显示 `render` 的摘要文本。
