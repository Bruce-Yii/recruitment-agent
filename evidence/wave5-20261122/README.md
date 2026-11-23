# Wave 5 双线联调（Issue #60 + #61）

基线：`origin/main 0565cbb`（两 lane 基于 88f8f40，联调合并最新 main 文档提交）。未合并 main。

## PR

| PR | Head | 内容 |
|---|---|---|
| **#72** https://github.com/Bruce-Yii/recruitment-agent/pull/72 | `a483229` | CSV 导出 + HMAC Webhook 同步 |
| **#73** https://github.com/Bruce-Yii/recruitment-agent/pull/73 | `adf93ca` | 生产登录 + 持久会话（含 React Hook 修复） |

两条 PR：GitHub Actions **全部执行 job 通过**（converter acceptance 因无 corpus 条件跳过，非失败）。

## 门禁（联调分支）

- `tsc` 0；`tsdown` 双入口（lib/app.js 1.52MB）
- `server-typecheck` 0/0；`runtime-budget` 5051/5051
- `client-contract-check` PASS；`term-lint` PASS
- `entry-reachability` PASS（WHITELIST=[]）
- 干净 DB 全量 `run-all.mjs --test-concurrency=1`：**3076 tests / 3074 pass / 0 fail / 2 skipped**（真实语料 + declared FS seam）
- 迁移：**25 个迁移** + `db/verify.sql` exit 0；`AUTH-STRUCT PASS` / `VERIFY PASS`
- 15 步 preview 回归：**15/15 PASS**，audit **hard 0**（soft 3 既有 keyText）

## 1440 真机

### A. CSV + Webhook（Issue #60）
- Settings Tab1 外部同步 L1 → L2 → L3：CSV 下载按钮、Webhook 开关/URL/事件/secret、签名说明。
- 保存后 GET 只回 `secret_set`，无明文/哈希。
- 真 CSV：HTTP 200 `text/csv; charset=utf-8`，首字节 `EF BB BF`（UTF-8 BOM），手机/邮箱掩码，零内部 UUID/「证据」，注入前缀防护。
- 本地 loopback receiver（`127.0.0.1:45871`）：
  - 测试推送 → `decision.recorded`，`X-Recruitment-Signature: sha256=...` 独立重算匹配，UI 显示「测试推送成功（HTTP 200，签名已发送）」；
  - 公开自助预约确认 → `booking.confirmed`，独立重算 HMAC 匹配。
- 截图：`01-external-sync-l1-l2-l3.png`、`02-webhook-test-push.png`、`03-booking-webhook-received.png`。

### B. 生产登录（Issue #61）
- `RECRUITMENT_AUTH_MODE=production`，真实 Host：
  - 未登录 `/recruitment/app` → 302 `/recruitment/login?next=%2Frecruitment%2Fapp`；
  - `/recruitment/test` → **404**；
  - 错误口令 → 401，登录页显示错误；
  - 正确登录 `recruiter / Recruiter@2026` → 进入工作台；
  - **停 Host 再起新进程**：刷新后仍在线（`app/queue` 可见，`/app/session` 200）；
  - 退出登录 → 回登录页；旧 `rc_auth` cookie 再访问 app/session → **401**。
- 截图：`01-login-page.png`、`02-logged-in-app.png`、`03-after-host-restart.png`、`04-after-logout.png`。
- 演示账号仅测试夹具：`recruiter / Recruiter@2026`、`interviewer / Interviewer@2026`（库内只存 scrypt 哈希，见 `docs/41-production-login.md`）。

## 联调修复

1. **PR73 React Hook 顺序错误**：`useCallback(handleLogout)` 在会话 loading/未绑定 early return 之后，首次渲染 Hook 数少于已登录渲染，React 整页白屏（15 步 S1 失败）。已改为普通函数（`adf93ca`），preview 15 步恢复 15/15。
2. **PR60 入口可达性**：新增 `/recruitment/api/config` 类只读路由与客户端引用均已接线；entry-reachability PASS。
3. **PR60 导出 CSV BOM**：真正响应字节以 `EF BB BF` 开头；`Response.text()` 会吞 BOM，验收按字节检查，避免假阴性。

## 已知边界

- `run-all` 的 2 个 skip 为真实语料（`RECRUITMENT_CORPUS_ROOT` 独立门禁）+ 无 FS seam 的 standing skip；不是静默跳过。
- 生产登录演示账号仅用于本机验收，真部署前必须替换（docs/41 §5）。
- Webhook 签名密钥使用服务端保存的 secret sha256 hex 派生 HMAC（不存明文）；接入方需按文档用同样派生/密钥协商方式验签。
- `--mode` deterministic eval 之外的 live 模型评测不在本批范围。

## 证据文件

- `auth-result.json`、`export-webhook-result.json`
- `regression-15step-result.json` / `regression-15step-audit.json`
- `run-all-summary.txt` / `run-all-tail.txt`
- `migration-verify.txt`
- `build-static-gates.txt`
- 7 张 1440 截图
