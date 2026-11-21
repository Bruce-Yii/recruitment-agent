# v4 整页对话桥 v1 · 证据（2026-11-20）

> 结论：**对话不再 503**。v4 整页右侧对话栏已接到 DSH 既有 Agent 运行时（复用 `ctx.agents`，**不新建 Runtime**）。
> 代码：`dsh/dsh-recruitment/src/http/agent-turn.ts` + `src/index.ts` 注入（HEAD `a7a9089`）。
> 产品负责人 2026-11-20 明确：**这个项目本来就是 Agent，对话不是可选项** —— 本文件是接线后的真机证据。

## 怎么接的（一句话）

`POST /recruitment/agent/turn` 用页面同一个 `rc_sid` 当作 DSH Session id 去找/建 Agent → `agent.followup(用户消息)` 投递 → 订阅 `agent/assistant-stream`（token 增量）与 `session/event`（tool/call、tool/result、turn/end）→ 按前端契约发 SSE（`delta/tool/done/error`）。桥不可用仍返回 503 让页面降级；模型与凭据走 Host profile，**不经过浏览器请求头**。

安全：对话 Agent 创建时用 `tools.restrict({ allow: 只读工具清单 })` 收敛工具面——**写工具对对话不可见**；写操作仍必须走右侧工作台的人点确认（对话内确认卡是下一步）。

## 证据（全部真机：真 Host + 一次性库 + 真实 HY4 模型）

| 证据 | 内容 |
|---|---|
| `agent-turn-probe.json` | HTTP 两轮：第 1 轮问「DEMO-BE-001 是否在招」→ 真调用 `recruitment_job_get`（tool/call + tool/result），回答「在招…状态 OPEN」；第 2 轮要求「把岗位下架」→ 模型明确当前工具只读、**无写工具调用**；`decision/interview/scorecard/scorecard_draft/application/candidate_constraint` 行数前后不变 |
| 诊断工具清单 | 本轮模型可见：15 个 `recruitment_*` **只读**工具（application_get/candidate_get/job_get/resume_read/material_read/transcript_read/trace_get/interview_get/…）；**0 个写工具** |
| `chat-ui-probe.json` + `chat-ui-1440.png` | 真浏览器打开 `/recruitment/app` → ChatPanel 输入问题 → 点发送 → 页面出现回答「是，岗位 DEMO-BE-001…OPEN」+「已完成 · recruitment_job_get」，**无 `app-chat-unavailable` 降级条**；1440×900 截图 |
| `regression-15step-result.json` / `regression-15step-audit.json` | 接线后 15 步 `--fresh` 回归 **15/15 PASS**，证据审计 hard 0（本目录只存结果；逐步证据见 `evidence/fullpage-v4-15step-pr10-20261120/` 同代码族，或本地 `work/d5/fullpage/lead-verify-chat-bridge/`） |
| `gates.txt` | tsc 0 / tsdown / server-typecheck 0/0 / runtime-budget / entry-reachability / client-contract-check / term-lint 全 PASS |

- 复跑脚本在 `work/d5/fullpage/probe-agent-turn.mjs`、`probe-chat-ui.mjs`（`work/` 不入库；命令见 README 顶部与 `docs/17` D-173）。
- 一次性库已 drop、profile 副本/Chrome profile/token 已删、49347/9222 释放；`49351` 人工预览 Host 全程未触碰。

## v1 边界（如实写，不包装）

1. **只读**：对话里不能写（写工具被 allow-list 隐藏）；写操作走右侧工作台人点确认。对话内确认卡未做。
2. **缺“列表/总览”工具**：问「今天先看谁 / 有哪些待办」时 Agent 没有可用的列表读工具（现有工具都按 id/code 查），会答“看不到队列”。下一步应补一个复用 overview 读模型的只读工具。
3. **预览 Host 49351 需重启**才会加载新代码（现在仍跑旧进程，所以恢复后页面仍可能 503，直到重启）。
4. 未合并 main；全量测试未跑（非 main 合并轮）。
