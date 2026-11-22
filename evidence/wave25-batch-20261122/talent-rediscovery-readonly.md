# 只读接口结构：talent rediscovery（Issue #35）

## 请求
`GET /recruitment/api/recruiting/jobs/:jobId/rediscovery`
Headers：Host loopback、`x-recruitment-request: 1`、`X-DSH-Session: session-<uuid>`。

## 200 响应
```json
{
  "tool": "recruitment_talent_rediscovery",
  "contract_version": "talent-rediscovery 1.0.0",
  "status": "OK",
  "read_only": true,
  "evaluated_at": "...",
  "labels": { "provenance": "LIVE", "trigger": "MANUAL", "connection": "CONNECTED" },
  "job": { "job_id": "...", "code": "...", "title": "...", "status": "OPEN",
    "rubric_requirements": [{ "key": "core_fit", "label": "...", "kind": "MUST_HAVE" }] },
  "candidates": [
    {
      "candidate_id": "...",
      "candidate_name": "...",
      "matched_condition_count": 2,
      "last_active_at": "...",
      "basis": [
        { "code": "SCREENING_PASSED", "label": "曾通过初筛", "detail": "...", "source": "DECISION", "at": "..." },
        { "code": "RUBRIC_FIELD:core_fit", "label": "...", "detail": "...", "source": "MATERIAL", "at": "..." }
      ]
    }
  ],
  "total_matched": 1,
  "note": "只按历史事实召回，不评分、不排名；请由招聘人员判断。"
}
```
- 已投递当前岗位的候选人被排除。
- 无百分比/score/rank 字段；联系方式、简历正文、storage_ref 均不返回。
- 空结果：`candidates: []` + note。
