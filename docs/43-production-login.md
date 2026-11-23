# 43 · 生产登录与 10 分钟独立部署（Issue #61 / Wave 5，D-178 交付项）

## 1. 入口与模式

- `RECRUITMENT_AUTH_MODE=production|preview`，**缺省 `preview`**。
- `preview`（默认）：旧行为 100% 保留 —— `/recruitment/test?as=...`、`RECRUITMENT_PREVIEW_ALIAS`、进程内 session 绑定、15 步回归入口全部不变；生产登录路由与总闸门完全不安装。
- `production`：
  - `GET /recruitment/login`：独立暖纸色登录页，**没有 DSH 侧栏/顶栏/token 提示等任何宿主痕迹**；
  - `POST /recruitment/api/auth/login`：验证账号口令，落持久会话；
  - `POST /recruitment/api/auth/logout`：撤销会话 + 清 cookie，旧 cookie 立即 401；
  - `GET /recruitment/test`：**物理 404**（不再分配演示身份）；
  - `RECRUITMENT_PREVIEW_ALIAS` **被完全忽略**；
  - 未登录访问 `/recruitment/app` → 302 `/recruitment/login?next=…`，其余 `/recruitment/api/*` → 401；
  - 登录身份由 `auth_user.alias` 决定，复用 `recruiter` / `interviewer_a` / `interviewer_b` 三个受控 alias，与写工具/写 HTTP 共享同一个 `DemoActorIdentity.registry`，不另造权限系统。

## 2. 演示账号（仅用于真机/本地验收）

> 口令只在此处作为测试夹具明文出现一次；库里只有 scrypt 随机盐哈希（迁移 `db/migrations/0025_auth_login.sql`），源码与配置里没有明文。

| 用户名 | 密码 | 角色 alias | 说明 |
| --- | --- | --- | --- |
| `recruiter` | `Recruiter@2026` | `recruiter` | 招聘负责人：进 `#/queue` 工作台，可写动作 |
| `interviewer` | `Interviewer@2026` | `interviewer_a` | 面试官：进 `#/interviewer` 我的面试 |

登录请求可带可选 `role`（须与账号实际 alias 一致，否则 403）；不带时按账号角色路由。

## 3. 会话与持久化

- Cookie：`rc_auth=<64 hex token>`，**HttpOnly + SameSite=Lax + Path=/ + Max-Age=86400**；同时写可读的 `rc_sid=<session-uuid>` 供前端现有 `X-DSH-Session` 契约使用。
- DB：`recruitment.auth_session` 只存 `token_sha256`（token 明文只在 Set-Cookie 和登录响应那一刻出现）；`revoked_at` 非空即失效；`expires_at` 24h。
- Host 重启：进程内 `SessionActorRegistry` 清空后，每个受限请求都由总闸门按 DB 会话重新绑定 `session_id → alias`，因此**刷新页面仍保持登录**。
- 安全：口令用 scrypt（N=16384,r=8,p=1，16 字节随机盐）+ `timingSafeEqual` 比对；不存在/口令错误统一 401，避免用户名枚举；logout 幂等。

## 4. 数据库与验证

- 迁移：`db/migrations/0025_auth_login.sql`（自登记 `schema_migration.version='0025_auth_login'`）。
- 自检：`db/verify.sql` 的 `AUTH-STRUCT` 块校验列/CHECK/唯一键/部分索引/哈希形状/台账。
- 干净库全量 `run-all` 与 15 步 preview 回归不受影响：preview 模式下这些表/路由存在但不参与身份决策。

## 5. 运维注意

- 生产部署必须先把历史预览库跑完 0001…0025 迁移（含 0002 种子），否则 `auth_user` 的种子账号不存在。
- 生产环境应替换演示账号密码：用 `hashPassword()`（`src/auth/credentials.ts`）生成新哈希，更新 `auth_user.password_hash`，再删除/禁用这两个演示账号；不要直接在源码里改明文。
- 独立域名/多租户网关不是本 Issue 范围（D-178 开放项）：当前租户由插件配置的 `database.tenant_id` 固定。

## 6. 独立部署基建与正式账号替换（`deploy/` + `scripts/auth-admin.mjs`）

1. **拉起 PG17 并自动跑完 0001–0025 迁移 + 校验**：
   ```bash
   cp deploy/.env.production.example deploy/.env.production
   # 编辑 .env.production 填入强 PGPASSWORD 与 RECRUITMENT_AUTH_MODE=production
   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production up -d
   ```
2. **生成正式管理员建号/改密 SQL 并执行**（严禁把明文口令写进源码或迁移）：
   ```bash
   node scripts/auth-admin.mjs sql-upsert \
     --tenant 00000000-0000-4000-8000-000000000001 \
     --username hr_admin --name "招聘管理员" --alias recruiter \
     --password "<你的强口令>" | psql -v ON_ERROR_STOP=1
   ```
3. **接入 HTTPS 反代**：参考 `deploy/nginx.recruitment.conf.example`（注意 `/recruitment/agent/turn` 必须设置 `proxy_buffering off;` 保障 SSE 首字延迟）。
