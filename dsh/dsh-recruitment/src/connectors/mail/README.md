# 邮件连接器（rec/31 §4.1/§4.2）

收件（IMAP → intake）与发信（SMTP → durable_effect）两条链，**只在本目录内实现**；
接线由工具 B/C 完成（`src/tools/email-fetch.ts`、`src/http/email-send.ts`）。

## 传输层可替换

- 收件：`MailTransport`（`contract.ts`），生产用 `createImapTransport`（imapflow），
  测试直接实现 `listNew/fetchMessage/connect/disconnect` 即可，**不连真网络**。
- 发信：`SmtpTransport`（`smtp.ts`），生产用 `createSmtpTransport`（nodemailer），
  测试注入假 `send()`。
- 编排：`fetchAndIngest(input, deps)`（`orchestrator.ts`），deps 全部可注入
  （transport / cfg / identity / exec / clock）。

## 错误码

| kind | 含义 | 来源 |
|---|---|---|
| `AUTH_REQUIRED` | 认证/授权码失效（可修凭据），零写入 | IMAP 认证失败、SMTP 535 |
| `NOT_CONNECTED` | 网络/超时/连接断开 | IMAP/SMTP 连接失败 |
| `INVALID_MESSAGE` | 消息形态非法 | parse / dedup / 状态转移冲突 |
| `TRANSIENT` / `PERMANENT` | SMTP 4xx/超时 / 5xx 拒收（发信专用） | `classifySmtpError` |

认证/网络失败在顶层 `connection` 字段返回，**不建连接池、不写任何库行**。

## 去重口径

1. 同一 `message-id` → `event_inbox (tenant_id, provider='email-imap', provider_event_id)`
   唯一索引（`uq_event_inbox_provider_event`）天然幂等 → `DUPLICATE_MESSAGE`。
2. 同一附件 `sha256` 已在 `intake_asset` → 不重复走 intake → `DUPLICATE_ASSET`。
   `decideVersionAction`（application-intake）保证不重复写 `resume_version`。
3. 外部邮件事实事件 `provider='email-imap'`、`trust_level='UNTRUSTED_EXTERNAL'`、
   `idempotency_source='PROVIDER_EVENT_ID'`；intake 内部事件是
   `provider='internal'`、`FIXTURE/MANUAL`，两者不互相冒充。
4. 结果对象只有业务摘要（message-id 短号、sha 前 8 位、id 短号），不含正文/PII。

## 接入规则（总控第四轮补强）

- 首次拉取只取最近 7 天（`MAIL_DEFAULT_SINCE_DAYS`）+ UID 水位，禁止全量扫描。
- 单封附件总大小上限 20MB，超限跳过并记录 `ATTACHMENT_TOO_LARGE`，不静默截断。
- 没附件的邮件只记 `SEEN_NO_ATTACHMENT`（推进去重位点），不进简历流程；
  附件类型不在 PDF/DOCX/RTF 支持列表 → `UNSUPPORTED_ATTACHMENT`（现有 `sniffFile`
  不支持 TXT，故 TXT 也记 UNSUPPORTED）。
- QQ IMAP 要求登录前发 `ID` 命令：imapflow 由 connect options 的 `clientInfo` 发出。

## 发信副作用（durable_effect，0 迁移）

- 幂等键 `${application_id}:${template_key}:${template_version}`；
  同键行不重复创建，靠 `uq_durable_effect_idempotency` 兜底。
- `status` 迁移由 `withActor` 事务内的 UPDATE 完成；审计列/内部事件由
  `fn_row_guard` 触发器自动写，本层不手写。
- 模式 B 授权：`resolveEmailAuthorization` 纯判定，配置放 `business_config`
  （`config_key='email.send.authorization'`），撤销 = 追加新版本不改历史。
  `OFFER` 永不自动；payload 带 `authorization_ref` / `authorized_by_actor_id`
  供每封邮件独立判定"是谁/哪条授权让它发的"（人工点击 = `HUMAN_CLICK`）。
