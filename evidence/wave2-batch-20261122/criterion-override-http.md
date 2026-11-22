# criterion-override HTTP 响应结构（供前端 G-08 按钮）

## 请求
`POST /recruitment/api/action/criterion/override`
Headers：`Content-Type: application/json`、`x-recruitment-request: 1`、`X-DSH-Session: session-<uuid>`；同源 loopback。
Body（封闭五键）：
```json
{
  "application_id": "<uuid>",
  "criterion_key": "core_fit",
  "human_state": "PRESENT",
  "note": "可选",
  "confirmation_text": "人的原话（必填，服务端算 sha256）"
}
```
不接受 `actor_id` / `tenant_id` / `confirmation_text_sha256` 等任何服务端派生键。

## 成功 200
```json
{
  "contract_version": "criterion-override-http 1.0.0",
  "action": "criterion/override",
  "tool": "recruitment_criterion_override",
  "actor": { "session_id": "...", "alias": "recruiter", "actor_id": "..." },
  "override": {
    "application_id": "...",
    "criterion_key": "...",
    "human_state": "PRESENT",
    "effective_state": "PRESENT",
    "override_id": "...",
    "superseded_id": null,
    "inserted": true,
    "confirmation_method": "IN_CHAT",
    "confirmation_text_sha256": "...",
    "actor_id": "...",
    "labels": {}
  },
  "readback": {
    "table": "criterion_override",
    "application_id": "...",
    "criterion_key": "...",
    "current": {
      "override_id": "...",
      "human_state": "PRESENT",
      "effective_state": "PRESENT",
      "note": "...",
      "actor_id": "...",
      "confirmation_method": "IN_CHAT",
      "confirmation_text_sha256": "...",
      "record_version": 1,
      "overridden_at": "..."
    },
    "history_length": 1
  },
  "audit": {
    "event_type": "criterion.override.recorded",
    "event_recorded": true,
    "normalizer_version": "schema/0001"
  }
}
```

## 错误
`{ error: { code, reason_code, message, detail? } }`；INVALID_ARGS 400 / FORBIDDEN 403 / NOT_FOUND 404 / DEMO_ACTOR_UNMAPPED 409 / NOT_CONFIGURED 503 / DB_CONSTRAINT_VIOLATION|READER_FAILED 500；BODY_TOO_LARGE 413、UNSUPPORTED_MEDIA_TYPE 415、405、404。
