# 对话×画布统一交互 · 阶段一（服务端派发）证据（2026-11-21）

> 权威规范：`design/v4/chat-canvas-interaction-spec.md`（合并自 `docs/chat-canvas-interaction-spec@c63d5b7`）。
> 任务 11（前端硬编码 pill 切页/抢弹窗）**已作废**，本目录是替代方案**阶段一**的服务端证据。
> 代码 HEAD：`f0f54ee`（阶段一实现）；前端阶段二尚未接入。

## 实现内容

1. **新增只读工具 `recruitment_ui_dispatch`**（`src/tools/ui-dispatch.ts`）：
   - 严格枚举 `navigate` / `focus_section` / `suggest_action`；`route/filter/section/modal/target_id/label` 全量 fail-closed 校验；
   - 零写库、零外部读取，只返回校验后的 `ui_action`；
   - 动作严禁混用（navigate 不携带 section/modal；focus 不允许 route/target；suggest 必须 label + modal/route）。
2. **新增只读工具 `recruitment_interview_free_slots`**（`src/tools/interview-free-slots.ts`）：
   - 与 HTTP `GET /recruitment/api/action/interview/free-slots` **共用同一实现**（从 `src/http/interview-slots.ts` 抽出 `computeInterviewFreeSlots` / `parseQuery`，未复制日历/时区/槽位逻辑）；
   - 日历未配置/未绑定 → 空 slots + 如实原因 + `labels.connection=NOT_CONNECTED/AUTH_REQUIRED`，**绝不编时段**。
3. **SSE `event: ui_action`**（`src/http/agent-turn.ts`）：
   - 两个工具加入 `CHAT_READ_TOOLS`（17 个只读工具，0 写工具）；
   - 监听 `tool/result`：`tool=recruitment_ui_dispatch` 且成功时，从本轮 `tool/call` 参数重新校验后下发 `ui_action`；校验失败不下发（fail-closed）；
   - 现有 `delta/tool/done/error` 事件不变（向后兼容）。
4. `index.ts`：飞书日历 CLI 路径 / 面试官 open_id 解析抽成一份，HTTP 路由与工具共用；工具面 33→35。预览 Host 需重启才加载（阶段二验收时统一重启）。

## 服务端自验（真 Host + 一次性库 + 真 HY4 模型）

复跑：`node work/d5/fullpage/probe-ui-dispatch.mjs`（work/ 不入库）

| 项 | 结果 |
|---|---|
| ① 打开人才库 | SSE `event: ui_action` → `{"action":"navigate","route":"talent","label":"打开人才库"}`；tool/call+result 正常 |
| ② 带候选人上下文「对比岗位评分标准」 | SSE `event: ui_action` → `{"action":"focus_section","section":"criteria","label":"对比岗位评分标准"}`；页面不切走（服务端只下发动作） |
| ③ 带候选人上下文「帮我查下一轮可约时段」 | 真调用 `recruitment_interview_free_slots`；当前环境两位面试官**未绑定飞书日历** → 工具如实返回空 slots + `NO_CALENDAR_BINDING`（不编时段）；随后 `ui_action` → `{"action":"suggest_action","route":"application","target_id":"…","modal":"schedule","label":"去约面"}` |
| ④ 诊断头工具清单 | 17 个只读工具，含 `recruitment_ui_dispatch` / `recruitment_interview_free_slots`；**写工具 0 个** |
| 写库检查 | 业务域表（decision/interview/scorecard/scorecard_draft/application/candidate_constraint）行数前后不变 |
| 15 步回归 | `run-v4.mjs --fresh` **15/15 PASS**；审计 hard 0（`regression-15step-*`） |
| 静态门禁 | `tsc` 0 · `tsdown` · `server-typecheck` 0/0 · `runtime-budget` · `entry-reachability` · `client-contract-check` · `term-lint` 全 PASS |

> **环境限制（如实记录，不伪造）**：本机测试 profile 没有 `RECRUITMENT_FEISHU_USER_MAP`（actor→open_id 映射），因此查时段工具只能返回“未绑定/读不到”的空结果 + 原因；规范里“真实时段”一条需要真实日历绑定后才能证。阶段二前端接入与端到端验收（spec §5）在届时的环境里补证。

## 本目录文件

- `ui-dispatch-probe.json`：三轮回放结果（ui_action、tool 调用、诊断工具清单、写库前后）。
- `regression-15step-result.json` / `regression-15step-audit.json`：阶段一后的 15 步回归与证据审计。

## 下一步（阶段二，前端窗口）

按 `design/v4/chat-canvas-interaction-spec.md` §4 阶段二一次性接入：消费 `event: ui_action`、`navigate` 切路由 / `focus_section` 滚动高亮 `[data-section]` / `suggest_action` 气泡按钮；禁止硬编码 pill。通知与验收清单见 `design/v4/frontend-phase-two-notice.md`。
