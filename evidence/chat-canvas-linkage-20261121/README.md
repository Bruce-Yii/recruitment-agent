# 对话×画布统一交互 · 阶段二验收证据（2026-11-21）

> 规范：`design/v4/chat-canvas-interaction-spec.md`（§5 四场景 + 15 步回归）。
> 前端：PR #11（分支 `feat/chat-canvas-phase2-v1`，2 提交 `a707f1e` + `d013826`，HEAD `d013826`）。
> 本地合并：`43140f0`（含 `lib/app.js` / `lib/client.js` 重建）；验收 HEAD `43140f0` 工作树。
> 验收环境：预览 Host **49351**（`rec-human-20261120` / DB `ra_human_20261120`，2026-11-21 04:25 用新构建重启，pid 22452），Chrome CDP 9222，1440×900。

## PR #11 复核（未采信自述）

- 改动面：10 文件，全部在 `dsh/dsh-recruitment/src/app/**` + `src/client/canvas/**`（只读锚点/受控弹窗/CSS）+ `src/app/TESTID-MANIFEST.md`；
- **未动**：`canvas-actions` / `postActionSeam` / builder / `use-recruiting` / 服务端 `src/http/**` / 工具；无既有 `data-testid` 删除；无 `@ts-ignore`；
- 服务端 `recruitment_ui_dispatch` / SSE `ui_action` 契约未被前端改写，只消费；
- 本地门禁：`npx tsc --noEmit` 0；`npx tsdown` 双入口通过（lib 重建随 merge 提交）；`server-typecheck` 0/0、`runtime-budget` 5051/5051、`entry-reachability`、`client-contract-check`、`term-lint` 全 PASS。

## §5 四场景（真浏览器 1440，全部 PASS）

| 场景 | 观测（真实 DOM/hash） | 截图 |
|---|---|---|
| ① 候选人页点「对比岗位评分标准」 | hash **保持** `#/application/…0701`（未跳岗位页）；`[data-section="criteria"]` 出现 `ros-section-focus` 高亮并滚动到视口（top 76/bottom 222）；对话 notice「↗ 对照岗位评分标准」；工具链 `job_get → application_get → ui_dispatch` | `01-focus-criteria-1440.png` |
| ② 点「帮我查下一轮可约时段」 | 4 秒观测窗口内**无自动弹窗**；气泡出现 `app-chat-suggest-schedule` 按钮（文案「去安排面试 →」）；点击后**排期弹窗打开**（`schedule-time-input` 可见）；工具链 `interview_get → interview_free_slots → ui_dispatch` | `02-free-slots-suggest-1440.png` |
| ③ 手打「打开人才库」 | hash = `#/talent`，`app-talent-view` 可见 | `03-navigate-talent-1440.png` |
| ④ 手打「回到今日待办，只看待初筛」 | hash = `#/queue`，`app-queue-filter-screening` 带 `active` 类（筛选选中） | `04-navigate-queue-screening-1440.png` |

- 探针结果（机器可读）：`probe-chat-canvas-linkage.json`；复跑脚本 `work/d5/fullpage/probe-chat-canvas-linkage.mjs`（work/ 不入库）。
- 15 步回归：`run-v4.mjs --fresh`（HEAD `43140f0`）**15/15 PASS**，证据审计 hard 0 → `regression-15step-result.json` / `regression-15step-audit.json`。
- 机检：`gates.txt`。

## 如实记录的限制

- **真实可约时段未证**：预览 profile 无 `RECRUITMENT_FEISHU_USER_MAP`（面试官未绑定飞书日历），`recruitment_interview_free_slots` 只返回空 slots + `NO_CALENDAR_BINDING`；场景 ② 验证的是“不自动弹窗 + 建议按钮 + 点击开弹窗”的交互，不是“真实日历时段”。真实时段要真实日历绑定后补证。
- 全量测试未跑（非 main 合并轮）。
- PR #11 内容已并入 feat（本地 merge `43140f0`）；GitHub PR 可标已合并/关闭。
- 预览 Host 已用新构建重启（token 只存 `%TEMP%\ra-pr-host-49351.token`，不入库）；49369（DSH GUI）未触碰。
