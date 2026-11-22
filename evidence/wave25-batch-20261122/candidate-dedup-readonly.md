# 只读接口结构：candidate duplicates（Issue #36）

## 请求
`GET /recruitment/api/recruiting/applications/:applicationId/duplicates`
Headers：Host loopback、`x-recruitment-request: 1`、`X-DSH-Session: session-<uuid>`；无 query 参数。

## 200 响应
```json
{
  "contract_version": "candidate-dedup 1.0.0",
  "evaluated_at": "...",
  "application_id": "...",
  "duplicates": [
    {
      "applicationId": "...",
      "candidateId": "...",
      "displayName": "张三",
      "channelName": "内推",
      "reasons": ["SAME_PHONE", "SAME_EMAIL"],
      "matchedKeyKinds": ["PHONE", "EMAIL"],
      "matchedValueHints": ["+86 138****8000", "a***@x.test"]
    }
  ],
  "subject_hints": { "phone": "+86 138****8000", "email": "a***@x.test" }
}
```
- 排除自身申请/同 candidateId 的同一人历史；只提示，不删除、不合并。
- 手机/邮箱只回掩码，不返回原值。
- 错误：400 INVALID_ARGS / 403 FORBIDDEN / 404 NOT_FOUND / 409 DEMO_ACTOR_UNMAPPED / 503 NOT_CONFIGURED。
