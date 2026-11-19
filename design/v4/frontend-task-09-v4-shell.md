> ⛔ **已作废（2026-11-20 产品负责人裁决）**：不接受把定稿 v4 拆碎塞进 DSH 左栏与旧顶部控件的方案。
> 本文件仅作历史记录；**现行方案见 `design/v4/fullpage-integration-plan.md`（独立整页入口）**。
# 前端任务书 09 · v4 工作台外框与首页正式接管 `RecruitingWorkspace.tsx`

> 决策依据：产品负责人 2026-11-20 明确要求——**打开就是 v4 工作台，不许"老首页 + 点进去才变画布"的割裂**。
> 目标形态 = `design/v4/recruitment_os.html` 的**暖纸白工作台**：左栏队列（今日待办 / 在招岗位 / 人才库）+ 右栏常驻画布。
> 宿主 DSH 的左侧会话栏**保留**（去不掉，也不许伪造整页）；只替换插件内容区的 `RecruitingWorkspace.tsx` 外框与首页。
> 配套：本轮 PR #7，与 PR #6 一起收口。

---

## 1. 现状差距（已核实，不是加载问题）

- 当前打开落点是**旧「招聘总览」**（`RecruitingWorkspace.tsx`），v4 画布要**点进候选人行**才出现 → 体验割裂；
- 原型首页那屏「今日待办 / 需要你拍板 / 人才库」**在产品代码里从未实现**（`src/client` 全量搜「今日待办/等你拍板」0 命中）；
- 原型是脱离宿主的整页效果；实际是 DSH 插件内容区，左侧 DSH 会话栏必须保留。

## 2. 要做的（一次做完，不要再来一轮）

### 2.1 外框（替换 `RecruitingWorkspace.tsx` 的首页部分）
- 打开招聘工作台 → **直接就是 v4 暖纸白外框**：左栏 = 队列，右栏 = 常驻画布（未选人时显示空态/今日待办）；
- 左栏三段（数据全部来自现有读模型，**不许编**）：
  1. **今日待办**：待初筛 / 我的面试 / 逾期面评 / 待审批 / 连接器异常（用 `overview` 已返回的聚合与申请列表拼）；
  2. **在招岗位**：岗位列表 + 每岗进度（申请数 / 推进中）；
  3. **人才库入口**：现有申请列表（按状态过滤）。
- 点左栏任意一条 → 右栏画布切换（不跳页、不整页刷新）；当前选中态可见。

### 2.2 右栏画布
- 直接复用现有 `canvas/` 组件（`CanvasRoute` / `CandidatePage` / `JobPage` / `CandidateActionModal`），**不许重写写链路**；
- 未选择时给一个 v4 风格的"今日待办/等你拍板"空态，而不是旧总览卡片。

### 2.3 视觉
- 暖纸白底、细边框、无重投影；字体层级与 `design/v4/recruitment_os.html` 一致；
- 不新增侧栏项、不改宿主布局。

## 3. 必须保留的 selector 契约（自动化 15 步真点依赖，删了直接打回）

> 来源：`work/d5/e2e-real/scripts/run-runbook.mjs`（我刚跑出的 15/15 基线）+ `work/d5/e2e-real/smoke/`。

### 3.1 硬依赖（**不可删、不可改名**）

| 类型 | 契约 | 当前提供处 |
|---|---|---|
| 申请行 | `data-testid^="application-row-"`，必须含 `application-row-<application_id>` 且可点击进入画布 | `RecruitingWorkspace.tsx:783`（迁移到左栏队列后同样规则） |
| 顶部页签 | 按钮**文本** `招聘工作台` / `面试官工作台` | 顶栏 |
| 身份选择 | `<select>` 的 option 文本：`Recruiter` / `Interviewer A` / `Interviewer B`；绑定后页面文本必须含：`当前身份 · 招聘方 Recruiter`、`当前身份：演示-面试官（interviewer_a）`、`当前身份：演示-面试官 B（interviewer_b）` | 顶栏 |
| 画布动作 | `canvas-action-candidate-upload`、`canvas-action-transcript-import`、`canvas-action-pin`、`canvas-action-handoff`、`canvas-action-transfer`、`canvas-action-schedule`、`canvas-action-stage-advance`、`canvas-action-no-show`、`canvas-action-email`、`canvas-action-screening`、`canvas-action-decision`、`canvas-action-star` | `CandidatePage.tsx` / `JobPage.tsx` |
| 弹窗 | `canvas-modal-submit`、`schedule-mode-create`、`schedule-mode-reschedule`、`schedule-interviewers-input`、`schedule-time-input`、`replace-interviewer-input`、`decision-missing-scorecards` | `CandidateActionModal.tsx` |
| 上传 | `canvas-action-candidate-upload` 必须触发**真实 `<input type="file">`**（自动化用 CDP 塞文件） | `CandidatePage.tsx` |
| 面试官端 | `interviewer-row`、`scorecard-form`、`submit-scorecard`（**本任务不动面试官端**） | `InterviewerWorkspace.tsx` / `ScorecardForm.tsx` |
| 详情文本锚点 | `岗位标准对照`、`简历原文摘录`、`本轮面试简报`、`前面几轮发生了什么`、`我的独立面评`、`提交我的独立面评`、`待提交面评`、`还缺`、`当前状态与提炼` | 画布/面试官端 |

### 3.2 建议保留（有旧测试/文档引用，非 15 步强依赖）
`recruiting-workspace`、`application-filters`、`alias-notice`、`job-select`、`overview-headline`、`overview-issues`、`refresh-overview`、`active-job-list`、`job-stage-counts`、`open-settings`、`close-job`、`rubric-approve` 及 `settings-*` 系列。

### 3.3 已知失效、别照抄
- `smoke/entries.json` 里的 `form-screening_decide` / `form-decision_record` / `form-stage_advance` / `form-transcript_import` 与 `canvas-batch-reject` **当前代码里不存在**（旧详情页/旧清单遗留）；本任务**不要**为了对清单去造假 selector，正确做法是首页与画布用上面 3.1 的真实 testid，smoke 清单由总控同步更新。

## 4. 不许做的事

- 不许改宿主 DSH 布局、不许隐藏/伪造左侧会话栏；
- 不许重写画布写链路（builder + `postActionSeam` + 会话头 + 提交前版本重取全部保留）；
- 不许删 3.1 任一 selector 或改文案锚点；
- 不许把"首页数据"写成前端手算/编造，读不到就如实说"还没读到"。

## 5. 验收（我会按这个跑，缺一不算过）

1. `npx tsc --noEmit` 0、`npx tsdown` 通过；
2. `node scripts/entry-reachability.mjs` PASS、`node scripts/client-contract-check.mjs` PASS（手拼写动作 0）；
3. `run-runbook.mjs --fresh` **15/15 PASS**（合并后我独立复跑）；
4. **打开招聘工作台第一屏就是 v4 外框**（不许先点行才出现）；
5. 1440 / 390 各 3 张截图：首页、候选人画布、确认卡；
6. 身份切换后绑定文案与 3.1 一致；点左栏任意候选人 → 右栏切换且 URL/滚动不异常。

## 6. 交付

- 分支 + PR（**PR #7**，与 PR #6 一起收口），附 `T9-NOTES.md`：改了哪些文件、3.1 契约逐条对照、没自测的项如实写；
- 跑不了的（云端无构建链/真库）如实声明，我会本地复跑。

