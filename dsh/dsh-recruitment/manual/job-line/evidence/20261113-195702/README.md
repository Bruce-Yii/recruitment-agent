# 证据 · 2026-11-13 19:57:02（S3 建岗位 + 人工批准 + 读回 + 负例）

## 0. 这次跑的是什么

一句话自然语言目标（`goal.txt`），没有给工具名、没有给参数：

> 建一个后端工程师岗位，标准是 3 年经验 + 本科；建好后把岗位读回来给我看。

命令（`command.txt`）：

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile rec-agent-test --patch "…\manual\job-line\patch.yml" "<goal>"
# exit=0，elapsed=26s（exit-code.txt）
```

`--patch` 只在本命令生效：它把真实实现 `src/tools/job-create.ts` 以独立插件
`recruitment-job-line` 挂进 `rec-agent-test`；**profile 与 `src/index.ts` 都没改**。

## 1. 文件索引

| 文件 | 说明 |
|---|---|
| `goal.txt` / `command.txt` / `exit-code.txt` | 目标、命令、退出码与耗时 |
| `dsh-stdout.txt` / `dsh-stderr.txt` | Agent 最终回答与推理过程原文 |
| `tool-trace.txt` | 会话日志里的 `tool/call` + `tool/result` 原文（`extract-tool-trace.py`） |
| `approval-human.txt` | 人工批准（CLI）的返回值 |
| `db-readback.txt` | `recruitment_job_get` 的 render+value，以及四张表的打码行 |
| `rval14-check.txt` | `digestOf(读回 dimensions)` 与 `rubric.payload_hash`、`approval.canonical_payload_hash` 的三方比对 |
| `negatives.txt` / `negatives-stderr.txt` | 7 条负例的真实 `Error: …` 原文 |

## 2. 关键原文（`tool-trace.txt`）

```
# seq=16  tool/call  recruitment_job_create
  arguments: {"criteria":[{"key":"three_years_experience","label":"3 年及以上工作经验","kind":"MUST_HAVE",
  "weight":0.5,"field":"timeline.covered_months_closed","operator":"GTE","value":36},
  {"key":"bachelor_or_above","label":"本科及以上学历","kind":"MUST_HAVE","weight":0.5,
  "question":"候选人是否具备本科及以上学历？","notes":"学历不在机械判定白名单内，由人复核"}],"title":"后端工程师"}

# seq=17  tool/result  isError=false
  | created job JOB-20261113-D0EA8E 后端工程师 [DRAFT]  (labels: LIVE/MANUAL/CONNECTED)
  |   job_id=792a10f9-6dd3-4d80-b141-6345880e2399  record_version=2  department=研发部（演示） (11111111-1111-4111-8111-000000000010)
  |   job_version v1  hash=95eb126b…  jd_source=TITLE_PLACEHOLDER  description_md=5 chars  requirements_md=null
  |   rubric v1  version_id=c9296bf3-…  (2 criteria: 2 must / 0 nice / 0 disqualifier, is_approved=false)
  |   approval 87fd466d-… PENDING → 需人类批准（PENDING；批准不是模型的动作）
  | next: recruitment_job_get(job_id=792a10f9-…)

# seq=21  tool/call  recruitment_job_get
  arguments: {"job_id":"792a10f9-6dd3-4d80-b141-6345880e2399"}

# seq=22  tool/result  isError=false
  | rubric: none (NO_APPROVED_RUBRIC) — 岗位 … 有 1 个 Rubric 版本，但 2026-11-13T11:57:23.053Z 时刻没有一版处于已批准状态
  | versions: v1(is_current=false, is_approved=false)
```

Agent 的最终回答明确写了「Rubric 当前为 PENDING（未批准），这是预期状态——批准是人类动作，
我不会代为批准」——**没有冒充批准**。

## 3. 人类批准（`approval-human.txt`）

```
approval 87fd466d-1b24-441b-8fbf-2e6064456bdc -> APPROVED by 11111111-1111-4111-8111-000000000103
  at 2026-11-13T11:58:54.213Z
rubric version 1 of job 792a10f9-6dd3-4d80-b141-6345880e2399; hash a3dd2e2a…
```

批准由 `node manual/job-line/approve-rubric.mjs <approval_id>` 完成（人类动作）；
`decideRubricApproval` 校验决定者 `kind='HUMAN'` 且属于该租户。

## 4. 读回（`db-readback.txt`）

批准后同一 `job_get`：

```
rubric v1 (is_current=true, is_approved=true, resolution=JOB_CURRENT, executable=true,
           version_id=c9296bf3-ce19-4c13-a7f2-fd55e6b9e5b0)
    three_years_experience  [MUST_HAVE]  w=0.5  timeline.covered_months_closed GTE 36 — 3 年及以上工作经验
    bachelor_or_above       [MUST_HAVE]  w=0.5  (judgment) "候选人是否具备本科及以上学历？" — 本科及以上学历
versions: v1(is_current=true, is_approved=true)
```

四张表的打码行（uuid 列只留前 8 位 + `…`；`payload_hash`/`dimensions` 为取证保留全量）：

```
job          id=792a10f9…  code=JOB-20261113-D0EA8E  status=DRAFT  record_version=2
job_version  id=e42c184a…  version_no=1  payload_hash=95eb126b…  description_md=后端工程师
rubric_version id=c9296bf3… version_no=1 payload_hash=a3dd2e2a… dimensions=[3y GTE 36, 本科判断型]
approval     id=87fd466d… status=APPROVED  canonical_payload_hash=a3dd2e2a…
             decided_by_actor_id=11111111…  decided_at=2026-11-13T11:58:54.213Z
```

`rval14-check.txt`：

```
R-VAL-14 digest(readback dimensions) == rubric.payload_hash: true
approval.canonical_payload_hash == rubric.payload_hash: true
```

→ 写入的 hash、读回的 dimensions、审批绑定的 hash 三方一致（R-VAL-14 / J-5）。

## 5. 负例（`negatives.txt`）

7/7 与契约一致，退出码 0；本脚本真实写入的 5 条 job（历史事实禁删，仅取证）：

```
S3N-MWEXDA2TGAO7-1  702364db-…  无标准         → NO_RUBRIC_AT_ALL
S3N-MWEXDA2TGAO7-2  2ffe6269-…  PENDING        → NO_APPROVED_RUBRIC
S3N-MWEXDA2TGAO7-3  ed94b72d-…  重复 code      → 23505 / uq_job_code
S3N-MWEXDA2TGAO7-5  2c01392c-…  批两次         → APPROVAL_NOT_PENDING
S3N-MWEXDA2TGAO7-6  c49e6c45-…  拒绝缺 reason  → REASON_REQUIRED
```

## 6. 结论

| 项 | 结果 |
|---|---|
| 自然语言建岗位（真实 DSH Agent） | PASS（`tool/call` 与 `arguments` 见上） |
| 落库四行 | PASS（打码行见上） |
| `job_get` 读回一致 | PASS（criteria 逐字一致、`is_approved=true`、R-VAL-14 三方一致） |
| 人类批准闸门 | PASS（Agent 未批准；CLI 以 HUMAN actor 批准） |
| 负例 | PASS（7/7，含真实 SQLSTATE 23505） |
| 限制 | 岗位状态保持 `DRAFT`（未在验收中改 OPEN）；本目录不证明 S8/S9/S10 |
