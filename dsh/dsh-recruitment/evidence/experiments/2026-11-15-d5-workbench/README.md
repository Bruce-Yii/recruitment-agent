# D5 · V5.6.1 Web 工作台接入证据（2026-11-15）

实现分支：`feat/unified-document-intake`；本证据对应 D5 提交 **`447844b`**（CI run 43651292212 success）。
设计基线：`design/recruitment-agent-v5.6.1` @ `985aa99`；V5.2 结构约束见 `work/v561/V5.2-README.md`。

## 实际环境（Gate 0）

| 项 | 实测 |
|---|---|
| DSH | `@deepseek-ai/dsh` **0.2.2-rc.3**（Node v24.16.0） |
| Host | 同一 DSH 产品 profile：`http://127.0.0.1:49303`（`--profile recruitment`，DSH_HOME=`D:\12412\dsh-home-recruitment`） |
| 鉴权 | 无 token 401；token → 303 + 签名 cookie → 200 |
| Plugin | `/recruitment/runtime/health` 200；真实会话 header 中 26 个 `recruitment_*` 工具 |
| Client Module | `@recruitment/dsh-recruitment/client.js` 真实加载；注册 `main` + `sidebar.panellist` |
| Slot | 编译期 116 key / live DOM 44；插件只占 main + sidebar.panellist |
| Conversation | UI 发 turn → WS `/api/remote.mux` 流；`tool/call`+`tool/result` 落 session log |
| Session ID | `localStorage['dsh.sessions.current']`、`POST /api/session/list`、日志首行三处一致 |
| Remote Action | Typert Remote：`/api/<ns>/<method>` + `/api/remote.mux` |

## Gate 1（同一 Host / 同一 Plugin / 同一 PG）：七项 PASS

1. Client Module 加载；2. 真实 PG 读；3. 原生 Conversation；4. Agent 调 Domain Tool；
5. Session ID；6. Demo Actor 映射（浏览器 alias → 服务端 actor → 写工具作者）；
7. 刷新恢复。

关键真机证据：同一 DSH session `session-de73b432-9c82-4497-ae81-127b96e1173b` 先
`PUT /recruitment/api/actor`（`interviewer_a` → `11111111-1111-4111-8111-000000000104`），
再由 Agent 真实调用 `recruitment_config_role create`，PostgreSQL 读回
`role.created_by_actor_id = …0104`（而不是配置中的 …0103）——Session→Alias→Actor→Domain Tool 全链成立。
截图：`shots/gate1-shell.png`、`shots/gate1-interviewer.png`、`shots/gate1-human-attention.png`。

## Gate 2（V5.6.1 两视图 + 唯一 Human Attention）

- Recruiting workspace：真实投影 21 岗位 / 57 申请；岗位/申请/材料/初筛/面试/Transcript/面评/决策；写按钮无 action seam 时 disabled（不假写）。
- Interviewer workspace：按 session→alias 过滤（A=6 场/B=2 场）；brief/Rubric/授权材料；Transcript 与 Scorecard 独立分支。
- Scorecard：Host Remote Action（一次性 nonce 43 字符，绑 session+interview）→ 单事务现有领域校验/写入 → 返回 DB 读回；Agent 工具路径仍走 D-79 approval，不能冒充人工提交。
- A/B 真实写入：同一 Interview `…0802` 两份 SUBMITTED Scorecard，作者 `…0104` 与 `…0105` 不同（`a-b-two-authors.txt`）。
- 负例：未分配 403、alias 不匹配 403、未绑定 session 409、nonce 重放 409、缺 nonce 403、客户端传 actor UUID 400；零写入（`w3-e2e-result.json`）。
- Human Attention：唯一抽屉聚合既有业务记录（我的面试/未分配待决策等），不新建事实表、不重复入口。
- 移动端：390 宽无横向溢出（`shots/w2-mobile-390.png`、`shots/w3-mobile-390.png`）。

## 测试与门禁

- fresh 库 `ra_ci_clean`（0001→0016 + seed，`--test-concurrency=1`）：
  **1692 tests / 1691 pass / 0 fail / 1 skipped**（唯一 skip = 仓库声明的真实语料缺失）。
- `runtime-budget PASS（3764 / 3764）`；`clean-load OK`；`tsc --noEmit` OK。
- CI run [`43651292212`](https://github.com/Bruce-Yii/recruitment-agent/actions/runs/43651292212) success（db/plugin/converter/python-lanes/golden-path）。

## 未完成 / 真实限制

- **模型路由**：产品 profile 默认 `longcat-2.5-free` 在本轮多次 429；Gate1/Gate2 真机会话临时使用 runtime 副本 `iceman-contributor-free`（仓库 profile 未改）。最终验收前需产品负责人裁决默认模型或恢复 longcat。
- **D5-1**：配置 actor 0103（HR）不是部门用人经理 0102，S10 决策写未纳入本轮 P0；决策/排期/转写导入/阶段推进的 HTTP action seam 未接（按钮 disabled + `ACTION_SEAM_NOT_WIRED`）。
- **D-8**：RESUME_PARSE 的 task-context 未注入 job/rubric 版本钉，该任务类型只能诚实 WAITING（G2 成功证据走 EVALUATION 场景）。
- **A/B 并发 session**：DSH 按 auth cookie 复用同一 session，A/B 证据为同一 session 顺序切 alias（真实已验），不是双会话并发。
- 演示库 `ra_s6s7` 被本轮证据写入：1 条合成 role（`D5_GATE1_PROBE_MWH03A6Y`，可停用）、1 条真实 B Scorecard（`cf8f370c-…`，W3 验收）、以及 105 actor/分配（bootstrap 幂等种子）。
- 未做真实飞书/日历/邮件连接器读取；本证据不含任何真实候选人 PII 或凭据。

## 文件

- `gate0-summary.json`、`gate1-evidence.sanitized.json`（token 已脱敏）
- `a-b-two-authors.txt`、`w3-e2e-result.json`、`w3-tests-fresh.log`
- `shots/`：10 张关键截图（Gate1 三张 + W2 桌面/移动 + W3 列表/表单/提交/作者对照/移动）
