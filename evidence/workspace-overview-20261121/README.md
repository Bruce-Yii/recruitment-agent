# 只读工作台总览工具（Issue #14）验收证据（2026-11-21）

> 任务：Issue #14 任务一——补齐只读总览工具 `recruitment_workspace_overview`，让首页两条快捷词与跨岗位追问直接读全局待办/超时面评/岗位瓶颈。
> 实现：`dsh/dsh-recruitment/src/tools/workspace-overview.ts`；注册到 `src/index.ts`（工具面 35→36）与 `src/http/agent-turn.ts` 的 `CHAT_READ_TOOLS`（17→18，0 写工具）。
> 同源复用：直接调用 `src/http/recruiting.ts` 的 `readRecruitingOverview()`，外层 `withReadOnly`；不复制投影查询、不新增事实表。
> 真机基线：一次性干净库 + 真 HY4 模型；证据见本目录。

## 1. 工具契约

- 入参（全部可选、`additionalProperties:false`）：`job_id`（UUID）、`stage_filter`（`all|screening|interviewing|awaiting_decision`，默认 all）、`only_overdue_scorecards`（boolean，默认 false）、`limit`（1..50，默认 20）。
- 出参：`counts`（jobs_open / applications_active / awaiting_screening / interviewing / awaiting_decision / scorecards_required / scorecards_submitted / overdue_scorecards_total）、`jobs[]`（job_id/code/title/status/active_count/rubric_approved/by_stage）、`applications[]`（application_id/candidate_name/job_id/job_title/stage_code/stage_label/overdue_scorecards/stage_blocked_reason/next_step{code,label,kind}）。
- 校验 fail-closed：非法 UUID/枚举/limit/未知键直接 `INVALID_ARGS`，不碰库；数据库未配置时同名替身 `NOT_CONFIGURED`，不返回空总览冒充成功。
- 只读/脱敏：`withReadOnly` 只读事务；只取姓名/岗位/阶段等既有 overview 字段，不返回联系方式、简历正文、storage_ref。

## 2. 真模型 2 轮 SSE（首页两条快捷词）

环境：一次性干净库（迁移 23 条 + bootstrap demo；3 个演示申请、7 份应提交面评），预览 profile 副本，真 HY4；探针 `work/d5/fullpage/probe-workspace-overview.mjs`。

| 轮次 | 用户原话 | 模型动作 | 回答要点（真库一致） |
|---|---|---|---|
| 1 | 梳理今天最优先推进的候选人 | 命中 `recruitment_workspace_overview`（参数 all/limit=50），再按返回的 application_id 调 `application_get`/`interview_get`/`job_get` | 排序：候选人 S12-决策隔离 → 候选人 T → 演示候选人-张样例；全局面评 0/7、4 份超时；与工具返回的 3 个申请、7 份应提交/4 超时一致 |
| 2 | 查看待提交面评与催办进展 | 再次命中 `recruitment_workspace_overview`（all/limit=50），再用 `interview_get` 补齐轮次 | “面评整体 0/7 已提交，7 份待提交，其中 4 份已超时”，逐候选人列出待提交轮次与超时情况 |

- 诊断头 `x-recruitment-agent-diag:1`：**18 个只读工具 / 0 写工具**，包含 `recruitment_workspace_overview`。
- 业务表零写入：decision/interview/scorecard/scorecard_draft/application/candidate_constraint 行数前后完全一致（探针 JSON 内 `countsBefore/countsAfter`）。
- 完整回放：`probe-result.json`。

## 3. 测试

| 测试 | 结果 |
|---|---|
| 单测 `test/unit/workspace-overview-tool.test.ts` | **6/6 PASS**：默认值/非法输入 fail-closed/过滤/limit/空结果/NOT_CONFIGURED |
| 集成 `test/integration/workspace-overview-tool-db.test.ts` | **3/3 PASS**：独立一次性库真读、过滤参数、非法 UUID/阶段/limit fail-closed、业务表零写入 |
| 干净库全量 `node test/run-all.mjs --test-concurrency=1` | **2868 tests / 2864 pass / 0 fail / 4 skipped（均为测试文件内已声明的 accepted skip，非失败）** |
| 15 步全链路 `run-v4.mjs --fresh` | **15/15 PASS**，审计 hard 0 |

> 4 个 skip 的诚实口径：1 个需真实语料（`RECRUITMENT_CORPUS_ROOT` 按 R7 不入库）；3 个是 upload 成功/落盘字节篡改/重复 sha 幂等，测试文件明确“需测试库 seam，当前不伪造绿色”。**skipped>0 不当作全绿**，但 0 fail 且原因接受。

## 4. 门禁

`npx tsc --noEmit` 0；`npx tsdown` 双入口；server-typecheck 0/0；runtime-budget 5051/5051；entry-reachability、client-contract-check、term-lint 全 PASS。详见 `gates.txt`。

## 5. 说明 / 阻塞项

- **docs/17 D-182、docs/38 与 docs/25 的推送未在远端出现**：产品负责人告知已推送 `feat/unified-document-intake@2d885858`，但 `git ls-remote` / fetch 后 feat 仍是 `4cef03b`，`2d885858` 不是有效对象，仓库内也没有 D-182。本目录没有覆盖/伪造这些文档；**最终合入 main 前请产品窗口重新推送该提交，否则 release PR 缺 D-182/docs38 清账**。
- 不在本轮：真实飞书日历绑定（待 `RECRUITMENT_FEISHU_USER_MAP`）、生产登录/独立域名/多租户（D-178）、真实人工手点抽检（产品负责人已明确跳过）。
- 工具只读；未改前端 `src/app/**` / `src/client/**`。

