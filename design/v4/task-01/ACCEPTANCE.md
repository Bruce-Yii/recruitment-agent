# 前端任务 01 验收记录（总控独立复核）

> 交付：`frontend-task-01-deliverables.zip`（4 个文件：`recruitment_os.html`、`data/adapter.js`、`data/mock.js`、`INTERFACE-NEEDS.md`）
> 复核时间：2026-11-19 04:4x · 复核人：总控（R8：实现者不得验收自己的工作）

## 结论：**通过（UI 零漂移有硬证据）+ 一处交付缺项**

| 判据（任务书 §6） | 结果 | 证据 |
|---|---|---|
| 页面内不再有散落假数据 | ✅ | `const roles/candidates/autoDone/connectors = [...]` 在 HTML 里 **0 处**；数据移到 `data/mock.js` |
| 页面通过 `api` 取数 | ✅ | HTML 只留 `<script src="./data/adapter.js">` + `window.createApi({mode, baseUrl})` |
| `mock` 模式与改前逐屏一致 | ✅ **像素级一致** | 同一 Chrome、同参数截图：1440×900 **SHA256 完全相同**（`ddb468a9…`）；390×844 **也完全相同**（`00f3ddba…`）。比"3 张手工截图"更硬 |
| `http` 模式对接真实接口 | ⚠️ 部分 | 适配层写了真实端点 + 未实现抛 `NOT_AVAILABLE`；但未真机联调（后端未起 Host 配合） |
| `INTERFACE-NEEDS.md` | ✅ 交且可用 | 12 条写接口缺口 + 5 组字段口径，逐条给了入参/返回期望 |
| 改前/改后截图 | ❌ **未交** | 交付包里没有截图；**已由总控补做**（见 `work/frontend-task-01/shots/`） |

## INTERFACE-NEEDS 与现实的三处偏差（我方修正）

前端不知道我们刚做完的东西，按"Agent 工具有、HTTP 动作没有"这一层重新归并：

| 前端列的缺口 | 现实 | 修正 |
|---|---|---|
| P0 `transfer` 跨岗调剂 | **Agent 工具已有**（`application_intake.carry_over_refs`，AT-1~3，已真库验证） | 缺的是**给前端用的 HTTP 动作**，不是业务能力 |
| P1 `pin_constraint` / `add_handoff_iq` | **Agent 工具已有**（`candidate_constraint`，PIN/HANDOFF） | 同上：缺 HTTP 动作 |
| P0 `new_job` | **Agent 工具已有**（`job_create`） | 同上 |
| P0 `uploadResume` | **确实没有**（`docs/35` G1） | 真缺口，需要新做（上传 + 异步 task_id） |
| P1 `compound` / `batch_reject` / `nudge` | 确实没有 | 真缺口；`compound` 属产品语义待定 |
| P2 `star` / `draft` / `undo` | 确实没有 | 真缺口 |

**一句话**：前端列的 12 条里，**3 条是"能力已有、只差 HTTP 入口"**，其余是真缺口。

## 保留物

- `design/v4/task-01/`：这次交付的**快照**（不改动，作对照与可复跑证据）。
- `work/frontend-task-01/shots/`：总控补做的 before/after 截图（1440、390 各两张，哈希一致）。
