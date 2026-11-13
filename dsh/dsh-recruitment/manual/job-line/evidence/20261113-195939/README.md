# 证据 · 2026-11-13 19:59:39（批准后的第二次 headless 读回）

## 目标（`goal.txt`）

> 岗位 792a10f9-6dd3-4d80-b141-6345880e2399 的标准已经由我人工批准了。请把这个岗位的标准读回来，
> 确认里面的经验年限要求和学历要求，并告诉我它现在是不是已生效的当前版本。

命令与第一次相同（`command.txt`），`exit=0`（`exit-code.txt`）。

## 原文（`tool-trace.txt`）

```
# seq=16  tool/call  recruitment_job_get
  arguments: {"job_id":"792a10f9-6dd3-4d80-b141-6345880e2399"}

# seq=17  tool/result  isError=false
  | rubric v1 (is_current=true, is_approved=true, resolution=JOB_CURRENT, executable=true,
  |           version_id=c9296bf3-ce19-4c13-a7f2-fd55e6b9e5b0)
  |     three_years_experience  [MUST_HAVE]  w=0.5  timeline.covered_months_closed GTE 36 — 3 年及以上工作经验
  |     bachelor_or_above       [MUST_HAVE]  w=0.5  (judgment) "候选人是否具备本科及以上学历？" — 本科及以上学历
  | versions: v1(is_current=true, is_approved=true)
```

Agent 的回答（`dsh-stdout.txt` / trace 的 assistant/message）：

> `is_current = true`，`is_approved = true`，`resolution = JOB_CURRENT`，`executable = true`
> 结论：该 rubric 是**已批准且已生效的当前版本**……经验年限要求为 3 年及以上，学历要求为本科及以上。

## 说明

- 这是**同意岗位**在人类批准之后的读回，用来证明"PENDING → 人类批准 → `job_get` 读到 approved"
  这条链在真实 DSH runtime + 真实 PG 上成立；不是另建了一个岗位。
- 批准动作与四表打码行见 `../20261113-195702/`。
