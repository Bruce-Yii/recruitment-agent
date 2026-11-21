# 38 · 能力 → 界面入口 → 核查材料 矩阵（写能力必须有人能点到的入口）

> 建立原因（D-160）：真点验收发现"接口都通、界面点不到"——旧详情页 5 个写入口只迁了 1 个，6 条写路由在客户端**零引用**。
> 从今天起：**任何写能力，没有可达界面入口 = 不算完成**（`docs/29` V3-0）。
> 维护方式：`scripts/entry-reachability.mjs` 自动扫"写路由 ↔ 客户端引用"，人工补"入口位置 / testid / 核查材料"三列。

## 1. 判据

| 列 | 含义 |
|---|---|
| 能力 | 用户能感知的一件事（不是接口名） |
| 后端 | 承载它的路由/工具 |
| 界面入口 | 从哪进入（页面 + 控件），**空 = 不可达** |
| testid | CDP 冒烟要检查的稳定钩子 |
| 核查材料 | 真点截图/读回路径 |

## 2. 写能力清单（当前状态）

| # | 能力 | 后端 | 界面入口 | testid | 核查材料 | 状态 |
|---|---|---|---|---|---|---|
| 1 | 初筛结论（通过/不通过/待定 + 原话） | `/action/screening/decide` | **旧详情页有、v4 画布没有** | `form-screening_decide`（旧） | — | 🔴 画布缺失 |
| 2 | 正式决策（终审 + 原话） | `/decision/record` | **旧详情页有、画布没有** | `form-decision_record`（旧） | — | 🔴 画布缺失 |
| 3 | 阶段推进 / 带原话跳轮 | `/action/stage/advance` | **旧详情页有、画布没有** | `form-stage_advance`（旧） | — | 🔴 画布缺失 |
| 4 | 转写导入 | `/action/transcript/import` | **旧详情页有、画布没有** | `form-transcript_import`（旧） | — | 🔴 画布缺失 |
| 5 | 约面 / 改期 / 换人 | `/action/interview/schedule` | 画布「约面 / 改期换人」 | `canvas-action-schedule` | `work/d5/e2e-real/evidence/S05*` | 🟡 有入口但缺选人/改期/版本 |
| 6 | 标记未出席（NO_SHOW） | 同名 intent | **无** | — | — | 🔴 全缺 |
| 7 | 上传简历 → 异步解析 | `/intake/upload` | 岗位页有（候选人页无） | — | — | 🟡 半个入口 |
| 8 | 候选人星标 | `/action/application/star` | **无** | — | — | 🔴 零引用 |
| 9 | 复合指令（一句话多步） | `/action/compound` | **无** | — | — | 🔴 零引用 |
| 10 | 发信（含 Offer） | `/action/email/send`、`/send-authorized`、`/authorize` | **无** | — | — | 🔴 零引用 |
| 11 | 工作空间设置写入 | `/action/settings/write` | **无**（设置页只有读） | — | — | 🔴 零引用 |
| 12 | 批量不通过 / 撤销 | `/action/decision/batch-reject`、`/action/undo` | 有（任务 05 已并） | `canvas-batch-reject` 等 | — | 🟢 有入口 |
| 13 | 置顶约束 / 下一轮交接 | `/action/candidate/constraint` | 画布按钮 | — | `work/d5/e2e-real/evidence/S07*` | 🟢 有入口 |
| 14 | 跨岗调剂 | `/action/application/transfer` | 画布按钮 | — | — | 🟢 有入口 |
| 15 | 面评提交 / 草稿 | `/action/scorecard/submit`、`/draft` | 面试官工作台表单 | `submit-scorecard` | — | 🟡 S11 真提交待证 |

## 3. 机检（`scripts/entry-reachability.mjs`）

1. 扫描 `src/http/**` 所有**写路由**（POST/PATCH/DELETE 常量），逐个检查 `src/client/**` 是否引用其路径 → 未引用即 **红**（白名单只允许"确实不面向界面"的，且必须写理由）；
2. 读取本文件的 testid 列（`docs/38` 表格），逐个要求在 `work/d5/e2e-real/smoke/` 的 CDP 冒烟清单中出现 → 缺失即红；
3. 结果并入机检（`docs/29` V3-0）。

> 白名单当前：`/action/email/authorize`（由前端授权按钮触发，若未接则也红）、无其它。

## 4. 当前基线（2026-11-19，机检实跑）

- `node scripts/entry-reachability.mjs`：写路由 32 条，**零引用 11 条**（已列入 `BASELINE_UNREFERENCED`，**只许降不许升**）：
  `application/star`、`compound`、`config`、`config/pipeline`、`config/role`、`config/team`、
  `email/authorize`、`email/send`、`email/send-authorized`、`settings/write`、`feishu/import`；
- 另有 5 条路由客户端用**动作键**引用（screening_decide / stage_advance / transcript_import / decision_record / rubric_approve），
  机检已用 `ACTION_KEY_FALLBACKS` 认作可达——它们是"旧详情页有、画布没有"（前端任务 08 第 1 节）；
- CDP 冒烟（`work/d5/e2e-real/smoke/check.mjs`）：7 个目标 testid **仅 1 个存在**（`canvas-action-schedule`），
  缺 `form-screening_decide` / `form-decision_record` / `form-stage_advance` / `form-transcript_import` /
  `canvas-batch-reject` / `submit-scorecard`。**这是真浏览器 DOM 核查材料，是任务 08 的验收清单。**

---

## 5. 2026-11-19 前端任务 08 交付后更新（`83b0b75` 合并）

画布已接上（真 Host + 真浏览器 DOM 实测，入口按钮与 testid 均存在）：

| 能力 | 入口 testid | 状态 |
|---|---|---|
| 上传简历 | `canvas-action-candidate-upload` | 🟢 |
| 导入转写 | `canvas-action-transcript-import` | 🟢 |
| 初筛结论 | `canvas-action-screening` | 🟢 |
| 正式决策 / 缺面评拦截 | `canvas-action-decision`、`decision-missing-scorecards` | 🟢 |
| 推进阶段 / 带原话跳轮 | `canvas-action-stage-advance` | 🟢 |
| 约面 / 选面试官 / 改期 / 换人 | `canvas-action-schedule`、`schedule-interviewers-input`、`schedule-mode-reschedule`、`replace-interviewer-input` | 🟢 |
| 标记未出席 | `canvas-action-no-show` | 🟢 |
| 星标 | `canvas-action-star` | 🟢 |
| 发邮件 | `canvas-action-email` | 🟢 |
| 置顶约束 / 交接 / 跨岗 | `canvas-action-pin`、`canvas-action-handoff`、`canvas-action-transfer` | 🟢 |

机检基线已下调：**11 → 8**（仍缺：compound、config×4、email/authorize、email/send-authorized、feishu/import）。
真点基线（`runbook-result.json`）：PASS 7 / FAIL 0 / BLOCKED 8——但**那 8 个 BLOCKED 是驱动脚本没跟上新 testid**，
不是界面缺失；已让 `owner-runbook-tooling` 按上表更新选择器后重跑。

### 5.1 2026-11-20 补记：入口可达 ≠ 能写（P0 会话头）

真点复跑（`--fresh`）抓到的下一层问题：画布写请求 `canvas-actions.ts` **缺 `X-DSH-Session` 头**，
服务端一律 `400 SESSION_REQUIRED`（入口、弹窗、填值、提交都真点成功，库里零写入）。
- 状态修正：上表 testid 只证明 **DOM 可达（🟢）**，**写入未通 = 业务上仍是 🔴**，直到会话头接上；
- 任务书：`design/v4/frontend-task-08b-session-header.md`（P0，含 5 处修改与验收）。
- 教训：V3-0「入口可达」之后还要一条 **V3-1「真点后库里真的有」**——两者都过才算完成。

---

## 6. 机检第二层：手拼写动作（V3-2，2026-11-20）

真点复现（会话头修好后）：`/action/screening/decide` 返回 `400 UNKNOWN_PARAM`——画布自己拼了 body，
绕过了仓库已有的 `recruiting/actions.ts::buildScreeningDecisionBody`（从 decision-facts 组装 `basis_refs`）
与 `use-recruiting.ts::postActionSeam`（自带会话头）。

- **规则**：有既有 builder 的写动作，画布**不许手拼 body / 自己发 POST**，必须复用 builder + seam；
- **机检**：`scripts/entry-reachability.mjs` 增加 `findHandRolledWrites()`，输出 `[手拼写动作]` 清单；
- **当前基线（2026-11-20）**：6 条 — screening/decide、decision/record、stage/advance、transcript/import、
  interview/schedule、settings/write、job/create（job 系列在旧工作台有 builder）；
- **归零任务**：`design/v4/frontend-task-08c-reuse-builders.md`。

---

## 7. 收口（2026-11-20）：真点 15/15

- `run-runbook.mjs --fresh`（真 Host + 真库 + 真浏览器）**15 步全 PASS / 0 FAIL / 0 BLOCKED**（我本人在合并后独立复跑一次）；
- 手拼写动作 **7 → 0**；入口机检无新缺口；`client-contract-check` PASS；
- 08b（会话头）、08c（复用 builder/seam）、S14（面试行版本）、S12（决策走 facade）全部落地；
- 现在写能力只剩"确实没接"的 8 条基线：compound、config×4、email/authorize、email/send-authorized、feishu/import——它们不在本轮范围，矩阵里如实标"未接"。

## 8. 2026-11-21 v4 封版与旧侧栏退役同步

- 唯一用户产品入口为独立整页 `/recruitment/app`（PR #13 / D-181 已退役 DSH 侧栏旧壳入口；`app-chat-panel` + `app-canvas` + `app-quick-* / app-suggest-* / app-rail-new-job / app-jobs-new-job / canvas-action-copy-memo / canvas-pin-row`）。
- `compound` / `config`×4 / `email/authorize` / `email/send-authorized` / `feishu/import` 共 8 条低频无界面写能力已按 **D-182** 明确本期延后，不阻塞合 `main`。
