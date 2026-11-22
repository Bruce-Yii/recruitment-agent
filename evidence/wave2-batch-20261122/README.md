# Wave 2 批次联调（2026-11-23 · #33 + #34 + PR #32）

## PR

| PR | Head | 内容 |
|---|---|---|
| **#33** https://github.com/Bruce-Yii/recruitment-agent/pull/33 | `0041f40` | 转写入库后自动待核对面评草稿 |
| **#34** https://github.com/Bruce-Yii/recruitment-agent/pull/34 | `5c64c49` | criterion override HTTP 路由（含临时 entry-reachability 白名单） |
| **#32** https://github.com/Bruce-Yii/recruitment-agent/pull/32 | `0acb43e` | 建岗 AI 标准草案/自定义维度/默认 OPEN；本批修复 department_context 对象序列化 |

联调分支：latest main `8c0e714` + #33 + #34 + #32。

## 门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.42MB）
- `server-typecheck`：0/0
- `runtime-budget`：5051/5051
- `entry-reachability`：PASS（criterion override 路由暂列白名单，待前端 G-08 按钮挂载后删除）
- `client-contract-check`、`term-lint`：PASS
- 全量 unit：**2090 tests / 2086 pass / 0 fail / 4 既有 skip**
- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0

## 1440 真机

### ① 新建岗位 → 草案 → 自定义维度 → OPEN → 批准 → 上传自动初筛

- AI 标准草案：PASS（`new-job-draft-note` 出现；2 → 自定义后 3 条维度）
- 默认 OPEN：PASS（psql `job.status=OPEN`）
- 批准 Rubric：PASS（「已锁定」；psql APPROVED=1）
- 上传新简历（不点评估）：PASS，自动初筛出现真实 criteria 对照（`notGate=true`）：
  `3 条硬性条件：1 满足 / 0 反证 / 2 不确定 → 需人工复核`；decision **0→0**。
- 证据：`01-job-draft-custom-1440.png`、`02-job-approved-1440.png`、`03-auto-screening-real-1440.png`

### ② 转写导入 → 面试官自动草稿

- UI「导入转写」成功；`scorecard_draft` 生成（note 首行“以下为基于面试转写生成的参考草稿，请面试官核对并自行决定评价”）
- 面试官端 `#/interviewer` 打开对应场次，`quick-notes-textarea` 自动读到该草稿；正式 `scorecard` **0 写入**。
- 说明：演示数据最新轮次原本没有 meeting_binding，E2E 在一次性测试库补了一条 PRIMARY 绑定（`binding_method='SCHEDULED'`）以走真实 UI 导入；不是产品代码改动。
- 自动草稿逐维度统一 `NOT_OBSERVED`（不编造），面试官需核对后自行改判提交。
- 证据：`04-interviewer-auto-draft-1440.png`、`05-transcript-import-state-1440.png`

## PR #32 修复

原报错：
```text
INVALID_ARGS/CONTEXT_NOT_OBJECT: department_context 必须是 JSON 对象
```
根因：`buildJobDraftBody` 把部门名直接序列化成 `department_context: "研发部（演示）"`；服务端 `job_draft` 要求 object。
修复（已推回 PR #32，commit `0acb43e`）：builder 将 string 包成 `{department_name}`，也接受服务端形状对象；新增单测覆盖。

## 证据文件

- `01-job-draft-custom-1440.png`
- `02-job-approved-1440.png`
- `03-auto-screening-real-1440.png`
- `04-interviewer-auto-draft-1440.png`
- `05-transcript-import-state-1440.png`
- `e2e-result.json`（两组三场景校验均 true）
- `regression-15step-result.json` / `regression-15step-audit.json`
- `build-static-gates.txt` / `unit-tests.txt` / `criterion-override-http.md`

未合并 main；等待总控按 **#33 → #34 → #32** 合入并关闭 #30/#31。
