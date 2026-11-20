# PR #12 验收：C 类 UI 缺口对齐定稿原型（2026-11-21，1440）

> 来源：`evidence/ui-review-20261121/` 对照包 → PR #12（`feat/ui-prototype-alignment`，`9f3919d`，9 文件 +552/−88）。
> 本地 merge：**`ab7e270`**（含 `lib/app.js` / `lib/client.js` 重建）；验收环境：预览 Host **49351**（`rec-human-20261120` / `ra_human_20261120`，2026-11-21 05:58 用新构建重启，pid 20000），headless Chrome 1440。
> 结论：**C 类实现缺口通过；A/B 归类接受**（B 为本期刻意不做，理由见 PR #12 正文）。

## 1. PR #12 复核（未采信自述）

- 9 文件全部在 `src/app/**` + `src/client/canvas/**`（含 TESTID-MANIFEST、CSS）；**未动**服务端 `src/http/**`、写链路（`canvas-actions`/`postActionSeam`/builder）、既有 testid、`lib/**`（lib 本地重建提交）；
- 新建岗位复用 `buildJobCreateBody + postJobCreate`，无新写路径；无 `@ts-ignore`；
- 本地门禁：`npx tsc --noEmit` 0；`npx tsdown` 双入口通过；`server-typecheck` 0/0、`runtime-budget` 5051/5051、`entry-reachability`、`client-contract-check`、`term-lint` 全 PASS。

## 2. A/B/C 核验（接受 PR 归类）

- **A 数据差异**：预览库 1 人 1 岗，条数/分期不同；翻页器需队列 >1 人，预览只有 1 人（代码已在，未视觉触发）。
- **B 本期不做（接受）**：角色切换下拉/页签（受 D-115/D-167/S1 身份隔离）、Agent 已代办页签（无后端投影）、岗位 HC 进度（无字段）、候选人推荐来源/年限故事头（无结构化字段）。
- **C 已对齐**：队列顶栏「等你拍板 N」与排版、行内真实紧迫度/原因、左栏与岗位页「＋新建岗位」、对话早报/动作快捷词、候选人置顶约束标签/复制决策纪要/顶栏降噪。

## 3. 真机验证（1440，全部 PASS）

| 项 | 观测 |
|---|---|
| 队列顶栏 | `app-queue-tabs` 文案 **「等你拍板 1」**（真实 `counts.applicationsActive`） |
| 行内紧迫度 | 预览候选人显示 **「初筛 · 24h 超时」**（按 `stageEnteredAt/appliedAt` + overview.evaluatedAt 实算，非写死） |
| 行内原因 | 「等待初筛决定：材料已就绪，还没有人工作出筛选结论 · 2 轮 · 第 1 轮已面完 / 第 2 轮已排期」 |
| 早报 | 动态生成：「早上好。当前有 1 位在办候选人（待初筛 1 人、面试中 1 人）…演示候选人-张样例（后端工程师（演示））…」 |
| 动作快捷词 | 「梳理今天最优先推进的候选人 / 查看待提交面评与催办进展 / 打开人才库检索候选人」；点击仍走 `POST /recruitment/agent/turn` |
| 新建岗位弹窗 | 左栏 `app-rail-new-job` 与岗位页 `app-jobs-new-job` 都能打开；字段：岗位名称、所属部门（研发部（演示））、核心要求（选填）；**只开不提交**（岗位表仍 1 条，零写入） |
| 候选人置顶标签 | 预览库原 0 条约束；通过候选人页「置顶约束」**真实写入 1 条演示约束**后，`canvas-pin-row` 显示「演示约束：期望两周内到岗，周五前需给结论」 |
| 复制决策纪要 | 点击 `canvas-action-copy-memo` → 提示「已复制 演示候选人-张样例 的决策纪要」；剪贴板读回包含候选人/岗位、核心提炼、置顶提醒、岗位标准、面试进展 |
| 复拍对比 | `compare-before-vs-after-*.png`（改进前后）、`compare-after-vs-prototype-*.png`（对齐后 vs 定稿原型） |

- 1440 截图：`after-01-product-queue-1440.png`、`after-02-product-candidate-top-1440.png`、`after-03-product-candidate-criteria-1440.png`、`after-04-product-jobs-1440.png`、`after-06-product-talent-1440.png`；功能截图 `after-feature-new-job-modal-1440.png`、`after-feature-pin-row-1440.png`、`after-feature-copy-memo-1440.png`。
- 机器读数：`probe-notes.json`、`pin-memo-notes.json`。

## 4. 回归

- **对话×画布 4 场景：4/4 PASS**（focus criteria / 查时段建议按钮 / 切人才库 / 切队列待初筛；`chat-canvas-4scenarios.json`）。
- **15 步 `run-v4.mjs --fresh`：15/15 PASS**（审计 hard 0；`regression-15step-result.json` / `audit.json`）。
- 机检：`gates.txt`。

## 5. 如实记录 / 残余

- 预览库原无约束；为验证置顶标签，用产品 UI（`canvas-action-pin`）真实写入 1 条演示约束，现留在预览库（`candidate_constraint` +1）；不是验收脚本伪造。
- 复制纪要在 headless Chrome 里默认被剪贴板权限拦住（UI 如实显示 fallback 文案）；加 `Emulation.setFocusEmulationEnabled` + 剪贴板权限后验证成功。普通浏览器不受此限。
- 队列翻页器（1/4）需 >1 人才能视觉触发，预览只有 1 人；代码已在 `CandidatePage`。
- 角色切换/Agent 已代办/HC/推荐来源（B 类）本期不做，产品负责人已核验归类；未合并 main；全量测试未跑。
