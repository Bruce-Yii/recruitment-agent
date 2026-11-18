# CANVAS-NOTES.md · 前端任务书 02 交付说明

> 对应任务书：`design/v4/frontend-task-02-canvas-react.md` · 依据：`design/v4/contracts/`（`design-tokens.md`、`client-plugin-contract.md`、`api-samples/*.json`）
> 说明：本轮严格遵守 UI 冻结红线，未修改 `src/client/index.tsx` 注册链路，未新增任何按钮/开关，未在界面暴露完整 UUID、字段名、哈希或协议词。

---

## 一、v4 右画布元素 → 组件与真实接口字段映射表

| v4 右画布元素 | 实现组件 / 文件 | 对应真实接口与字段来源 | 说明 |
| :--- | :--- | :--- | :--- |
| 右画布路由入口（候选人 / 岗位 / 空态） | `canvas/CanvasRoute.tsx` | 宿主面板传入 `route` (`candidate` / `job` / `empty`) | 统一封装同源 `fetchCanvasJson`（带 `x-recruitment-request: 1`，前端不传 actor） |
| 顶部返回按钮 & 面包屑 | `CandidatePage.tsx` / `JobPage.tsx` | `application.job.title`、`application.current_stage_code`、`application.candidate.display_name` | 保留顶部返回回调 `onBack`，点击岗位名可通过 `onOpenJob` 切换至岗位画布 |
| 外部事实三维标签 | `bits/FactBadges.tsx` (`FactLabelsBar`) | `labels.provenance`、`labels.trigger`、`labels.connection` | 原样展示 `LIVE/FIXTURE`、`EVENT/MANUAL`、`CONNECTED/NOT_CONNECTED/AUTH_REQUIRED`，不做美化 |
| 候选人档案头 | `CandidatePage.tsx` | `application.candidate.display_name`、`application.job.{title,code}`、`application.application_id`（取前 8 位短号）、`application.rubric.version_no`、`application.lifecycle_status` | 严禁显示 36 位完整 UUID，仅展示 `job.code` 与 8 位短号 |
| 阻塞提示 / 下一步提炼 | `CandidatePage.tsx` | `application.stage_blocked_reason`、`application.screening.reason`、`application.progress.next_step.label` | 有阻塞原因时以琥珀色左边框提示条呈现 |
| 岗位标准逐条对照（绿/黄/红） | `CandidatePage.tsx` + `normalize-canvas.ts` | `screening_evidence.rubric.dimensions[]` + `application.material.field_states` + `application.screening.evaluation.verdict` | 点击维度可高亮联动下方对应简历段落 |
| 简历分段与原位高亮 | `CandidatePage.tsx` | `resume.work_entries[]`、`resume.education_entries[]`、`resume.evidence_samples[]`、`resume.fields[]` | 无简历材料时展示人话空态「还没有简历原件」 |
| 飞书妙记 / 转录视图 | `CandidatePage.tsx` | `transcript_runs[]` | 空数组时展示人话空态「还没有转录」，绝不报错 |
| 原件二进制预览入口 | `CandidatePage.tsx` | `resume.material.asset_id`（或 `resume_version_id`）→ `GET /recruitment/api/material/:id/content` | 无原件时展示「还没有简历原件」 |
| 逐轮面试进展（不求平均分） | `CandidatePage.tsx` + `bits/StageTrack.tsx` (`SequentialRoundRail`) | `application.interviews[]`（`round_no`、`status`、`scheduled_start_at`、`interviewers[]`、`scorecards`、`round_focus.reason`、`transcript.state`） | 按轮次独立展示面评提交进度与超时数，严禁聚合平均分 |
| 初筛依据 | `CandidatePage.tsx` | `screening_evidence.basis[]`（`RUBRIC_VERSION` / `AUTHORITY` / `SCREENING_EVALUATION`） | 转为自然业务语言，隐藏 `payload_hash` / `evaluation_digest` 等内部哈希 |
| 不可执行动作透明原因 | `CandidatePage.tsx` | `actions.*` 中 `available === false` 的项 | 不新增按钮，仅按契约说明不可执行原因 |
| 全链路动态留痕 | `CandidatePage.tsx` | `timeline[]`（`at`、`label`） | 默认折叠，点击展开，隐藏 `ref_id` UUID |
| 岗位 6 阶段横向呼吸进度条 | `JobPage.tsx` + `bits/StageTrack.tsx` (`StageTrack`) | `job.application_counts.by_stage`（`S5`–`S12`）+ `job.rubric.approved` | 保留 v4 原版 `@keyframes rosOrbit` 呼吸动效 |
| 岗位候选人漏斗（滑入列表） | `JobPage.tsx` | `applications[]`（`application_id`、`candidate.display_name`、`current_stage_code`、`material.entry_counts`、`progress.next_step.label`） | 完整保留 v4 招牌 `.ros-clean-row` 轻滑入动效，点击触发 `onSelectApplication` |
| 岗位标准与完整 JD | `JobPage.tsx` | `rubric.{version_no,dimensions}`、`job.{description_md,requirements_md,rubric.approved}` | 区分硬性/加分维度与权重 |
| 空态 / 加载态 / 错误态 | `bits/CanvasStates.tsx` | 异步加载与异常捕获 | 接口失败只展示人话提示 +「重新读取」按钮，不向用户抛 HTTP 状态码 |

---

## 二、`api-samples` 中缺失字段与前端处理方式

| v4 原型中的元素 | `api-samples` 现状 | 本轮处理方式 | 建议后端后续补充（待补） |
| :--- | :--- | :--- | :--- |
| 候选人置顶约束标签（如竞品 Offer / 期望薪资） | `application-detail.json` 暂无 `pinned` 字段 | **隐藏**（不伪造假标签） | 待补 `application.pinned[]`（`{ text, kind }`） |
| 候选人星标主推（`★`）与来源渠道（如“内部推荐”） | `application-detail.json` 暂无 `starred` / `source` 字段 | **隐藏**（不猜字段） | 待补 `application.starred`、`application.source` |
| 候选人停留时长（`hours` 超时标红） | 有 `stage_entered_at`，无直接 `stage_hours` 或超时布尔值 | 本轮暂不猜阈值标红，直接展示真实 `stageLabel` 与 `next_step` | 待补 `stage_sla_overdue` 或前端与 `settings.sla_thresholds` 联动 |
| 逐条维度独立命中结论（`criteria_evaluated`） | 样例中 `screening.evaluation.criteria_evaluated` 为 `null` | 基于 `material.field_states` + `evaluation.verdict` 做保守推断（`work_experience`/`education` 对应 `present/absent`，其余 `NICE_TO_HAVE` 标「需面试核实」），不编造具体分数 | 待后端填充 `criteria_evaluated[]` 后直接在 `normalize-canvas.ts` 优先读取 |
| 岗位 HC 配额（`已录用 / 总 HC`） | `job-detail.json` 有 `application_counts.{total,active}`，暂无 `headcount` / `filled_count` | 展示真实的「在途 X / 总计 Y 人」，不造假 HC 数字 | 待补 `job.headcount`、`job.filled_count` |
| 同池对比视图（Compare Tab） | 本轮任务书 §1 聚焦候选人页 + 岗位漏斗/标准；`job-detail.json` 的 `applications[]` 暂不含每人的 `criteria` 命中明细 | 本轮岗位页仅展示「候选人漏斗」与「岗位标准」，不放空壳对比表 | 待 `job-detail` 补齐候选人维度摘要后接入 |
| 面试官视角简报 / 任务卡住状态 | `contracts/README.md` 注明 `interviewer/overview` 与 `tasks/status` 暂未采集样例 | 按契约**本轮不接** | 待总控补样例后接入 |

---

## 三、未自测项说明（如实记录，无编造）

以下项目因云端环境限制（无仓库依赖、`tsc`、`tsdown`、真 Host 与 PostgreSQL 实时服务）**未在本窗口自测**，需在本地仓库中执行验收：

1. **`npx tsc --noEmit` 类型检查**：未自测（云端无项目 `tsconfig.json` 与 `react` 类型声明包）。
2. **`npx tsdown` 构建产物 `lib/client.js`**：未自测（云端无仓库构建工具链，未提交 `lib/client.js`）。
3. **真 Host + 真库 1440px / 390px 浏览器实拍截图与像素对照**：未自测。
4. **宿主面板挂载集成联调**（从工作台列表点击条目打开 `CanvasRoute`）：未自测（未改动 `src/client/index.tsx`，按 §0.4 留待总控或下一轮集成挂载）。
5. **接口 500 / 网络断开真实负例联调**：代码已实现 `CanvasErrorState` 人话兜底，真 Host 实测未执行。

---

## 四、`normalize-canvas.ts` 输入 → 输出示例

### 输入样例（摘自真实 `contracts/api-samples/application-detail.json` 结构）

```json
{
  "labels": {
    "provenance": "LIVE",
    "trigger": "MANUAL",
    "connection": "CONNECTED"
  },
  "application": {
    "application_id": "9f3c2a1b-4d5e-6f70-8a9b-0c1d2e3f4a5b",
    "candidate": { "candidate_id": "c1", "display_name": "演示候选人-张样例" },
    "job": { "job_id": "j1", "code": "DEMO-BE-001", "title": "后端工程师（演示）" },
    "lifecycle_status": "ACTIVE",
    "current_stage_code": "S7",
    "rubric": { "version_no": 2, "approved": true },
    "stage_blocked_reason": null,
    "material": {
      "asset_id": "a7b8c9d0-1111-2222-3333-444455556666",
      "file_name": "demo-candidate-0701.rtf",
      "field_states": { "work_experience": "present", "education": "present" }
    },
    "screening": {
      "result": "ADVANCE",
      "reason": "核心后端经历完整",
      "decided_by_display_name": "演示-HR 专员",
      "evaluation": { "verdict": "PASS" }
    },
    "interviews": [
      {
        "interview_id": "11223344-aaaa-bbbb-cccc-ddddeeeeffff",
        "round_no": 1,
        "status": "POST_INTERVIEW",
        "scheduled_start_at": "2026-11-18T06:00:00Z",
        "interviewers": [{ "display_name": "张工", "role_in_interview": "LEAD", "scorecard": null }],
        "scorecards": { "required_total": 1, "submitted": 0, "overdue": 0 },
        "transcript": { "state": "MISSING" }
      }
    ],
    "progress": {
      "next_step": { "code": "PREPARE_INTERVIEW", "label": "准备面试：面试已排期或即将排期，需要准备" }
    }
  },
  "resume": {
    "work_entries": [{ "company": "示例科技", "title": "后端工程师", "start": "2022-03", "end": "至今" }],
    "education_entries": [{ "text": "某大学 · 计算机科学", "start": "2018-09", "end": "2022-06" }],
    "evidence_samples": [{ "field": "work_experience", "page": 1, "quote": "负责核心微服务接口设计与稳定性治理" }]
  },
  "screening_evidence": {
    "rubric": {
      "version_no": 2,
      "dimensions": [
        { "key": "work_exists", "kind": "MUST_HAVE", "label": "具备后端研发经历", "weight": 0.5 },
        { "key": "team_lead", "kind": "NICE_TO_HAVE", "label": "有团队带教经验", "weight": 0.2 }
      ]
    },
    "basis": [{ "kind": "RUBRIC_VERSION", "detail": { "version_no": 2 } }]
  },
  "transcript_runs": [],
  "timeline": [{ "at": "2026-11-18T02:00:00Z", "label": "完成简历初筛评估" }],
  "actions": {
    "screening_decide": { "available": true }
  }
}
```

### 输出视图模型（`normalizeApplicationDetail(raw)`）

```json
{
  "applicationId": "9f3c2a1b-4d5e-6f70-8a9b-0c1d2e3f4a5b",
  "shortRef": "9f3c2a1b",
  "candidateName": "演示候选人-张样例",
  "jobId": "j1",
  "jobCode": "DEMO-BE-001",
  "jobTitle": "后端工程师（演示）",
  "lifecycleLabel": "推进中",
  "stageCode": "S7",
  "stageLabel": "初筛评估",
  "isScreeningStage": true,
  "isArchived": false,
  "stageBlockedReason": null,
  "nextStepLabel": "准备面试：面试已排期或即将排期，需要准备",
  "rubricVersionLabel": "V2",
  "factLabels": [
    { "dimension": "来源", "raw": "LIVE", "tone": "green" },
    { "dimension": "触发", "raw": "MANUAL", "tone": "neutral" },
    { "dimension": "连接", "raw": "CONNECTED", "tone": "green" }
  ],
  "summaryText": "初筛结论：核心后端经历完整 · 准备面试：面试已排期或即将排期，需要准备",
  "criteria": [
    { "key": "work_exists", "label": "具备后端研发经历", "kindLabel": "硬性", "weightText": "权重 50%", "statusText": "已匹配", "level": "green" },
    { "key": "team_lead", "label": "有团队带教经验", "kindLabel": "加分", "weightText": "权重 20%", "statusText": "需面试核实", "level": "amber" }
  ],
  "hasResumeMaterial": true,
  "materialFileName": "demo-candidate-0701.rtf",
  "materialContentUrl": "/recruitment/api/material/a7b8c9d0-1111-2222-3333-444455556666/content",
  "resumeSections": [
    { "title": "工作经历", "items": [{ "id": "work-0", "matchKey": "work_exists", "heading": "示例科技 · 后端工程师", "period": "2022-03 – 至今", "body": "担任 后端工程师" }] },
    { "title": "教育背景", "items": [{ "id": "edu-0", "matchKey": "work_exists", "period": "2018-09 – 2022-06", "body": "某大学 · 计算机科学" }] },
    { "title": "简历原文摘录（可点击标准联动定位）", "items": [{ "id": "ev-0", "matchKey": "work_exists", "heading": "工作经历", "pageLabel": "第 1 页", "body": "负责核心微服务接口设计与稳定性治理" }] }
  ],
  "hasTranscript": false,
  "transcriptItems": [],
  "rounds": [
    {
      "id": "11223344",
      "roundLabel": "第 1 轮面试",
      "statusText": "待收面评",
      "statusTone": "caution",
      "scheduleText": "11-18 06:00",
      "detailText": "面试官：张工",
      "scorecardsSummary": "面评 0/1",
      "overdueCount": 0,
      "interviewers": [{ "displayName": "张工", "roleLabel": "主面试官", "scorecardStatus": "待交面评", "submitted": false }],
      "transcriptStateLabel": "还没有转录"
    }
  ],
  "screeningBasis": [
    { "label": "岗位考核标准", "detail": "依据已锁定的岗位标准 V2 执行对照" }
  ],
  "timeline": [
    { "id": "tl-0", "timeText": "11-18 02:00", "label": "完成简历初筛评估" }
  ],
  "unavailableActions": []
}
```
