# 38 · 能力 → 界面入口 → 证据 矩阵（写能力必须有人能点到的入口）

> 建立原因（D-160）：真点验收发现"接口都通、界面点不到"——旧详情页 5 个写入口只迁了 1 个，6 条写路由在客户端**零引用**。
> 从今天起：**任何写能力，没有可达界面入口 = 不算完成**（`docs/29` V3-0）。
> 维护方式：`scripts/entry-reachability.mjs` 自动扫"写路由 ↔ 客户端引用"，人工补"入口位置 / testid / 证据"三列。

## 1. 判据

| 列 | 含义 |
|---|---|
| 能力 | 用户能感知的一件事（不是接口名） |
| 后端 | 承载它的路由/工具 |
| 界面入口 | 从哪进入（页面 + 控件），**空 = 不可达** |
| testid | CDP 冒烟要检查的稳定钩子 |
| 证据 | 真点截图/读回路径 |

## 2. 写能力清单（当前状态）

| # | 能力 | 后端 | 界面入口 | testid | 证据 | 状态 |
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
