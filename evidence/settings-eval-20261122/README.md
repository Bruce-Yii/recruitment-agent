# Settings + Eval 统一联调（Issue #54 / #55 + PR #56）

基线：`origin/main d0e4a20` + PR #58 + PR #59 + PR #56。未合并 main。

## PR

| PR | Head | 内容 |
|---|---|---|
| **#58** https://github.com/Bruce-Yii/recruitment-agent/pull/58 | `4d1605a` | 6 设置键 + governance + config/org |
| **#59** https://github.com/Bruce-Yii/recruitment-agent/pull/59 | `453f739` | 模型无关 Eval 框架（18 例 + L1/L2） |
| **#56** https://github.com/Bruce-Yii/recruitment-agent/pull/56 | `04c1081` | #/settings 4-Tab 渐进式 UI（含联调修复） |

三条 PR 的 GitHub Actions 均 **全部执行 job 通过**（acceptance corpus job 条件跳过，非失败）。

## 门禁

- `tsc` 0；`tsdown` 双入口（lib/app.js 1.50MB）
- `server-typecheck` 0/0；`runtime-budget` 5051/5051
- `client-contract-check` PASS；`term-lint` PASS
- `entry-reachability` PASS（WHITELIST=[]；config/org 已归 READ_ONLY_ROUTES）
- 干净 DB 全量 `run-all.mjs --test-concurrency=1`：**3060 tests / 3058 pass / 0 fail / 2 skipped**
- 15 步：**15/15 PASS**，audit **hard 0**
- Eval deterministic：**18/18 PASS**，L1 144/144，L2 180/180；live **NOT RUN**（本机无兼容模型配置，如实记录 `live.ran=false`）

## 1440 真机验收

1. `#/settings` 四个 Tab 均可切换：连接接入 / 自动化与提醒 / 组织与招聘规范 / 行为规范与评测。
2. 自动化 Tab：SLA 行 L1 → 点「配置」展开 L2 → 点「高级参数 ▸」展开 L3。
3. 修改 `sla_thresholds` 为 12h/36h、`scorecard_reminder_policy` 为 48h/最多 3 次/飞书/20:00–09:00，保存后显示「已保存更改」。
4. 刷新页面：L1 摘要显示 `12h / 36h`、`48 小时后提醒，最多 3 次`。
5. 独立 psql（`recruitment.business_config`，ORGANIZATION scope）读回：
   - `sla_thresholds | v1 | {"scorecard_hours":36,"screening_hours":12}`
   - `scorecard_reminder_policy | v1 | {"channel":"feishu","enabled":true,"quiet_hours":{"start":"20:00","end":"09:00"},"max_reminders":3,"overdue_hours":48}`
6. interviewer 身份打开 `#/settings`：页面显示「当前身份为只读视图」，保存按钮 disabled；直接 POST `/action/settings/write` 返回 **403 FORBIDDEN / ACTOR_NOT_AUTHORIZED**。

截图：`01-tab-connections.png`、`01-tab-automation.png`、`01-tab-org.png`、`01-tab-governance.png`、`02-sla-l1-l2-l3.png`、`03-automation-saved.png`、`04-automation-refreshed.png`、`05-interviewer-readonly.png`。

## 联调中发现并修复

1. **PR56 五个文件被网关下载注解污染**：首行 `successfully downloaded text file (SHA: ...)` 导致 tsc 在第 1 行失败；已删除该非源码行（`d045d57` + 远端 `0a51a67`）。
2. **PR56 interviewer 路由遮蔽 settings**：`isInterviewerRoute` 对 interviewerOnly 恒 true，`#/settings` 被渲染成「我的面试」；已改为 settings 路由豁免、只读渲染（`04c1081`）。
3. **PR58 的 GET /config/org 未被 entry-reachability 归为只读**：补 `READ_ONLY_ROUTES`（`4d1605a`），WHITELIST 仍为 []。
4. **PR58 必要 DB 修复**：`readAllSettings` 改成 `distinct on (config_key) ... version_no desc`，保证 append-only 版本链下 GET 不会返回旧值。

## 已知边界

- Eval `live` 未跑（本机未配置兼容模型/provider）；deterministic 证明的是 18 例矩阵与判分器接线，不代表真实模型通过率。
- `seedEvalDatabase()` 的真实 PG 种子函数已实现，但 deterministic runner 使用离线 shadow fixtures；真实 DB seed 未在本轮执行。
- `scorecard_reminder_policy` 的 L3 参数（最多次数/免打扰时段）在 L2 折叠时不会显示，但保存时仍按当前 state 提交（默认值）；E2E 已展开 L3 后修改并读回。
