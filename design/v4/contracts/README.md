# design/v4/contracts —— 给前端窗口的"仓库内事实"

> **为什么有这个目录**：前端窗口在云端，**只能读仓库、不能在本机跑命令**。
> 所以"接口长什么样、视觉变量是多少、面板怎么挂"必须先入库，否则它只能猜。
> **规则：本目录是唯一口径；与任何口头描述冲突时，以这里为准。**

## 1. 真实接口样例（`api-samples/`）

全部来自**真实 Host + 真实库**（`ra_live_e2e_20261118`）的只读响应，**原样保存、未手工改写**。

| 文件 | 对应接口 | 用途 |
|---|---|---|
| `overview.json` | `GET /recruitment/api/overview` | 待人工决定工作台（侧栏计数、待办列表） |
| `recruiting-overview.json` | `GET /recruitment/api/recruiting/overview` | 岗位 + 候选人漏斗总览 |
| `application-detail.json` | `GET /recruitment/api/recruiting/applications/:id` | **右画布的核心数据**：档案、简历、初筛依据、时间线、可用动作 |
| `job-detail.json` | `GET /recruitment/api/recruiting/jobs/:id` | 岗位页：JD、标准版本、维度、候选人列表 |
| `settings.json` | `GET /recruitment/api/settings` | 设置页：连接状态 + 可写设置项 |

### 画布最关键的字段（`application-detail.json`）

```
application: { application_id, candidate, job, lifecycle_status, current_stage_code,
               rubric_version_id, rubric, stage_entered_at, applied_at,
               stage_blocked_reason, record_version, material, screening,
               interviews, decisions, progress }
resume:      { material, fields, work_entries, education_entries, evidence_samples }
screening_evidence: { decision, rubric, basis }
transcript_runs: [ … ]        // 没有转写时是空数组，不报错
timeline:    [ … ]
actions:     { screening_decide, interview_schedule, transcript_import, stage_advance,
               decision_record, rubric_approve, recruiting_settings_write }
labels:      { provenance, trigger, connection }   // 外部事实三维标签，必须原样展示
```

**注意**：
- 所有 id 都是 UUID；界面**不许直接显示完整 UUID**，要短号（前 8 位）或业务编号。
- `actions` 里每个动作对象都带"当前能否执行"的判定结果；**不能执行时必须显示原因，不许把按钮画成灰的却不说为什么**。
- `labels` 是外部事实标签：`LIVE/FIXTURE`、`EVENT/MANUAL`、`CONNECTED/NOT_CONNECTED/AUTH_REQUIRED`——**照实展示，不许美化**。

### 还没采集到的两个接口

- `GET /recruitment/api/interviewer/overview`：需要面试官身份绑定，400。
- `GET /recruitment/api/tasks/status`：需要查询参数，400。
两处**待补样例**（总控补），前端先不接。

## 2. 设计变量（`design-tokens.md`）

从 `design/v4/task-01/recruitment_os.html` 的 `:root` 与布局规则**逐字提取**。
移植时必须用同一套变量名与色值，**不许自造近似色**。

## 3. 客户端挂载契约（`client-plugin-contract.md`）

说明"一个面板怎么挂进 DSH"（`ctx.slots`）、构建产物（`lib/client.js`）、数据规则（客户端**不许直连数据库**，只能用 HTTP 只读路由）。
参考实现就是仓库里的 `dsh/dsh-recruitment/src/client/index.tsx`。

## 4. 怎么用

- 做**画布**：读 `api-samples/application-detail.json` + `job-detail.json` + `design-tokens.md`；
- 做**挂载**：读 `client-plugin-contract.md` + `src/client/index.tsx`；
- 拿不准的字段：**不要猜**，在交付报告里列"我需要什么字段"，总控补样例后再做。
