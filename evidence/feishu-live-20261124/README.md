# Feishu LIVE 实测证据 · G-04 日历忙闲 + G-13 妙记回读（2026-11-24）

- 基线：`main@8a8ae9b`（本证据由 `docs/17` D-198 引用）
- 结论：**G-04 = LIVE / CONNECTED**（产品 free-slots 3 个候选时段）；**G-13 回读 = LIVE / CONNECTED**（真实妙记逐字回读 + 产品落库 READY，面评仍待人工核验）。
- 本文只保留**状态、脱敏哈希前缀与结构化回执**；**不含**任何系统 token、会话/访问/刷新凭据、会议标题或转写原文，也不含完整 open_id（仅前 8 位）。

## 1. 环境（脱敏）

- `lark-cli` 绝对路径：`D:\12412\npm-global\node_modules\@larksuite\cli\bin\lark-cli.exe`
- 产品独立 profile：**`recruitment`**（appId `cli_aa72230051b8dcb7`，已登录用户 open_id 前缀 `ou_bc916…`；token 调用时自动刷新）
- 默认开发者 profile `cli_aae49f8438f8dce4` **未使用**（wiring 禁止隐式回退）
- 已授权 scopes 覆盖：calendar free_busy/read/event read、minutes readonly/artifacts/search、vc note read
- 隔离 Host 49348（临时 profile + 一次性库，25 迁移 + `db/verify.sql` VERIFY PASS），环境：
  `RECRUITMENT_FEISHU_CLI=<绝对路径>`、`RECRUITMENT_FEISHU_USER_MAP={"…0104":"<真实 open_id>"}`（interviewer_a）

## 2. G-04 结果

| 检查 | 结果 |
|---|---|
| 产品 HTTP `GET /recruitment/api/action/interview/free-slots`（days=3, 45min, Asia/Shanghai） | **200**，`labels={LIVE,MANUAL,CONNECTED}`，`slots=3`，`unsatisfied=[]` |
| 产品 calendar reader 月度直读 2026-11 | `READ / LIVE / busy_count=1 / 30 分钟` |
| 产品 calendar reader 月度直读 2026-12 | `READ / LIVE / busy_count=0` |
| lark-cli `calendar +freebusy`（本人，11/24–11/30） | `ok=true, data=null`（空忙闲/应用级授权差异，非“没权限”；产品 free-slots 走 `+agenda`） |

证据：`g04-adapter.log`、`g04-http-free-slots.log`、`g04-http-free-slots.json`。

## 3. G-13 结果

| 检查 | 结果 |
|---|---|
| 产品 adapter（wiring 真实 transport，profile=recruitment） | `kind=READ`、`CONNECTED`、`LIVE`、`live_eligible=true`、`violations=[]`、回执绑定内容哈希、正文 71 字符、`is_complete=true` |
| 产品 HTTP `POST /recruitment/api/feishu/import` | **200**，`labels={LIVE,MANUAL,CONNECTED}` |
| 独立 psql 读回 `transcript_artifact` | `FEISHU / READY / LIVE / MANUAL / CONNECTED / sha256 9395b98fc433… / complete / canonical / 71 字符` |
| 独立 psql 读回 `interview_record` | `revision=1 / NEEDS_REVIEW / UNVERIFIED / is_current=t`（人类核验闸门未被绕过） |
| `transcript_segment` | 4 条 |

证据：`g13-adapter.json`、`g13-import.json`、`psql-readback.txt`。

## 4. 边界与复跑

- G-13 本次闭环的是**回读**；“真实改绑（`minutes +speaker-replace`）”仍需真实 `speaker/open_id` 映射 + HR 在场，未做。
- 产品自有 OAuth / 事件订阅（F2）仍是后续 P1，不因本次 profile 级 LIVE 验证而关闭。
- 复跑需要本机 `recruitment` profile 处于已授权状态；若 refresh 过期（本机当前至 2026-11-26 09:11 +08），执行
  `lark-cli auth login --profile recruitment`（设备授权，需本人浏览器确认）。
- 原始探针脚本与未裁剪日志放在机器本地 `work\feishu-live-20261124\`（不入库，避免把一次性 launch token 等运行态内容带进仓库）；本目录只保留上表的脱敏状态/哈希前缀/结构化回执。
