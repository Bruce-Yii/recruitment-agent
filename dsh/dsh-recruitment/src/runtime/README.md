# `src/runtime` — 任务运行时（Business Task / Task Attempt / Agent Session + Event Runtime）

> **证据标签（三处一致：本文件、`src/runtime/evidence/dsh-worker.evidence.ts` 输出、交付报告）**
>
> 2026-11-14 的真实执行证据：
> - `DSH_SESSION = REAL`：`dsh --profile rec-worker-probe --json` 子进程返回
>   `session-669fe067-...`，`agent_session.runtime_session_id` 与之一致；
> - `TOOL_EXECUTION = REAL`：Worker 在 agent loop 里调用 `write` 工具写出
>   `TOOL_EXECUTED_<nonce>` 文件；DSH 会话日志
>   `$DSH_HOME/sessions/.../session.v4.jsonl.zstd` 里有对应 `tool/call`
>   （name=write，file_path/content 与 nonce 完全匹配）；
> - `MODEL = REAL_EXTERNAL_PROVIDER`：`opencode-go-openai-key2 / longcat-2.5-free`
>   （产品 profile 已有的免费档），不是 mock；
> - `provenance = LIVE`（本次执行事实来自真实进程与真实工具副作用）。
>
> **没有任何地方把 TEST_DOUBLE 写成 LIVE**：测试套件里的 `ScriptedWorkerLauncher`
> 只用于状态机断言，文件名/README/证据输出都标成 scripted，且不产生 `provenance`
> 标签。若将来用 mock 跑证据，必须把 `--model-label` 写成 `TEST_DOUBLE:...`。

## 它解决什么缺口

`db/migrations/0001_init.sql` 已经有 `business_task` / `task_attempt` /
`event_inbox` / `agent_session` 四张表，但没有写入者，结构上缺四块（详见
`db/migrations/0011_task_runtime.sql` 抬头）：

1. `event_inbox` 没有 `(tenant_id, provider, provider_event_id)` 唯一约束，
   `processed_at` 是死列（无状态机）；
2. 没有 `event → task` 的唤醒事实表（同事件重复到达无法证明只唤醒一次）；
3. `agent_session` 没有记录 DSH 真实 session id 的列；
4. `task_attempt` 没有租约回收索引，`agent_session` 可以认领别的 Task 的 Attempt。

0011 只做这些**增量**：dispatch 状态机 + provider 事件唯一索引、`task_wakeup`
唤醒事实表、`runtime_session_id`/`runtime_worker_role` + 三层一致性守卫、
租约回收索引。不改任何已有列的语义。

## 分层

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `config.ts` | 解析插件 `runtime` 段；默认关闭、缺配置列 issues | 不静默降级成假运行时 |
| `routing.ts` | 事件类型 → Task 类型/业务对象；语义准入 Gate | 不做模型判断 |
| `store.ts` | PG 事务读写：事件幂等 / 唤醒 / 三层身份 / 租约回收 | 不做业务规则 |
| `event-runtime.ts` | 事件到达 → 验源 → 去重 → 定位对象 → 建/唤醒 Task | 不在回调里做重活 |
| `worker.ts` | `dsh --profile <worker> --json` 启动独立 Worker Session | 不伪造工具执行 |
| `task-runtime.ts` | Attempt 认领 / Session 登记 / 结果回写 / 恢复 | 不用 Worker 自报成功代替业务校验 |
| `router.ts` | `tick()`：事件 → Attempt → Worker → Task | 不直接写招聘业务表 |
| `http.ts` | 回环 + 同源的 HTTP 入口（默认不挂） | 不对公网开放 |

## 两条事件路径（Notion `04` §10）

* **确定性事件**：`resume_received` / `transcript_ready` / `scorecard_submitted` /
  `application_stage_entered` 等已知类型，按事件类型 + 业务状态直接建/唤醒
  Task，不让模型先判断"要不要接单"；
* **语义准入**：未知类型先过 `DefaultSemanticGate`（INTERNAL + 显式
  `semantic.*`/`router.*` 或 payload.intent），通过后只创建 `ROUTER_TRIAGE`
  任务（`WAITING_HUMAN`），**不自动派发 Worker**，等 Router 决定授权。

同一事件重复到达：`event_inbox` 的幂等键/ provider 事件唯一 + 不重新路由；
同一业务对象的新事件：稳定 Task 幂等键唤醒同一个 Task，`task_wakeup`
`(task_id, event_id)` 唯一保证同一事件只唤醒一次。

## 三层身份的硬边界

* **Business Task**：`business_task.id` 在重试/换 Session 后不变；
* **Task Attempt**：每次执行一条，`attempt_no` 递增，独立状态/错误/结果；
* **Agent Session**：`agent_session` 每次执行一行，记录 DSH
  `runtime_session_id`；Session 结束只把该行标 `ENDED`/`LOST`，不改 Task 身份。

`trg_agent_session_identity_guard` 在库层拒绝：
Attempt 属于 A 而 Session 挂 B、ROUTER 角色挂 attempt、挂 attempt 但没有 task_id。

## 开启方式（默认关闭）

`cordis.patch.yml`（**本 lane 不修改 profile 文件**，需在后续 lane 加）：

```yaml
- id: recruitment
  config:
    runtime:
      enabled: true
      worker_profile: rec-worker          # 必须含可用模型路由的 headless profile
      dsh_bin: D:\path\to\@deepseek-ai\dsh\lib\bin.js
      runtime_version: 0.2.2-rc.3
      model_route: opencode-go-openai-key2/longcat-2.5-free
      permission_mode: workspace-write
      timeout_ms: 240000
      lease_ms: 300000
      max_attempts: 3
```

未开启时：不注册任何路由，现有 19 个工具与 overview 路由完全不变。

## 手工证据（不进 `node --test`）

```powershell
$env:RECRUITMENT_DB_PASSWORD='<local dev db password>'
$env:DSH_HOME='D:\12412\dsh-home'
node src/runtime/evidence/dsh-worker.evidence.ts `
  --profile rec-worker-probe `
  --dsh-bin 'D:\12412\recruitment-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js' `
  --dsh-home 'D:\12412\dsh-home' `
  --model-label 'REAL_EXTERNAL_PROVIDER:opencode-go-openai-key2/longcat-2.5-free' `
  --runtime-version '0.2.2-rc.3'
```

脚本会：建一次性空库 → 重放 0001→0011 → 真实事件入 Inbox → Router tick →
真实 DSH Worker Session → 用 `write` 工具写 nonce 文件 → 回读
Task/Attempt/Session 三层 + DSH 会话日志里的 `tool/call`。任何一步不成立都会
非零退出并把真实原因写进 JSON。

`rec-worker-probe` 是本机 `$DSH_HOME/profiles/` 下临时创建的 headless profile
（模型段从产品 `dsh/profile/recruitment/cordis.patch.yml` 复制、重新启用
credentials）。**它不在本仓库里**：本 lane 的写范围不允许改 `dsh/profile/**`，
产品化时应把同样的模型段固化成仓库内的 worker profile。

