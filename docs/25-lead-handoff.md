# 25 · 总控交接（2026-11-17 快照 · 给下一位 lead）

> **本文不是产品文档，是"接手总控这个位置"的操作手册。** 产品认知与验收口径的唯一权威是 **`docs/24-product-framework-v2.md`**（D-139）；
> 裁决的唯一权威是 **`docs/17-decision-ledger.md`**。本文只在"怎么接手、别踩什么坑"这件事上有权威性。
> **写本文的原因**：前一位总控（我）在这个位置上犯了十几次同类错误，有些是判断错，有些是操作事故。重蹈覆辙的成本我们付不起。

---

## 0. 三十秒版

- **项目**：跑在 DSH（DeepSeek Harness）上的**招聘 Agent**（不是招聘平台、不是人事系统）。以**人**为单位存上下文，Agent 只做辅助（结构化/标注/建议），**人的判断留给人**。
- **阶段**：**本地开发 + 验证**，**尚未进入产品交付**。所以模型用免费的 **HY4**（`hy4-flash-free`），别拿"交付质量"来反对。
- **当前基线**：分支 `feat/unified-document-intake`，HEAD = 远端 = **`8fe6fb8`**，工作树干净。
- **下一步最重要的事**：跑一次干净库全量四数 + 两道机检 → 冻结新 SHA → 更新独立验收交接说明 → 交独立窗口。
- **你的身份**：**唯一总控**。只做判定/验收/集成/单一权威源。**不写实现**（派 lane + 两层委派）；**git 写操作只有你做**。

---

## 1. 你必须认真读的东西（按顺序，读完再动手）

| # | 文件 | 为什么必须读 | 读法 |
|---|---|---|---|
| 1 | **`docs/24-product-framework-v2.md`** | **产品认知 + 验收口径 v2（六条门 V1–V6）**。跟任何旧文档冲突，以它为准 | 全读。尤其 §3 做什么 / §4 不主动提 / §6 AI 行为纪律 / §7 待设计（不许碰）/ §8 六条门 |
| 2 | **`docs/17-decision-ledger.md`** | 所有裁决。**没写进这里的 = 视为未决定** | 重点读 **D-110 / D-122 / D-128 / D-130 / D-133 / D-136 / D-137 / D-139–D-143**；再扫其余标题 |
| 3 | **`AGENTS.md`** | 你的行为约束（§0.1 第一性原理、R1–R9 铁律、两层委派、E1–E4、P1–P6） | 全读。**它约束的是你自己** |
| 4 | `docs/18-golden-path.md` | 现在怎么跑 golden path（S6→S10 一条链） | 跑之前读 |
| 5 | `docs/21-agent-operating-model.md` | 怎么干活（浏览器驱动验收、委派协议） | 派 lane 前读 |
| 6 | **`work/review/2026-11-16-notion-acceptance/14-PRODUCT-BUSINESS-VERDICT.md`** | 上一轮判 **FAIL** 的原始判定（产品/业务 FAIL 的 5 条根因） | 全读。这是这一整轮修复的起点 |
| 7 | `work/review/2026-11-16-notion-acceptance/{02-MATRIX.md,07,11,12,13}.md` | 73 项矩阵与历次复核（**矩阵已降为历史参考，不作判据**） | 浏览，了解历史争议 |
| 8 | **`work/d5/acceptance/BRIEF-FROZEN-*.md`** + `PRECHECK.md` | 交给独立验收窗口的交接说明（最新一版是 0272733，**需按新 SHA 更新**） | 冻结 SHA 后必须改 |
| 9 | `work/d5/*/REPORT.md`（10 份，见 §6 清单） | 近十条 lane 的交付与证据。**别全信，但要读** | 只读结论与"残余/BLOCKED"段 |
| 10 | `docs/23-acceptance-review-s6-s10.md`、`docs/06`、`docs/07` | 历史验收口径（已被 docs/24 取代，但冲突时要能解释） | 选读 |

> **读的时候要有判断**：文档之间会打架（历史债）。**打架时按 §1.4 时间优先 + `docs/24` > 其它**，并且**当场裁决 + 回抄**（R5）。

---

## 2. 这个项目到底在做什么（一句话到三层）

**一句话**：把散落在简历、岗位标准、面试、面评、决策里的上下文，按"人"串起来；用 Agent 把它变成人能快速看懂、快速判断的东西；判断权永远在人手里；外部世界只"接进来"，不接管。

**三层判断顺序（任何问题都按这个顺序答）**：
1. **业务**：这个动作在真实招聘里由谁做？**是他的职权吗**？（HR 不制定面试问题；面试官不替 HR 决策；我们不替企业做 Offer）
2. **产品**：HR/面试官**会感觉到什么变化**？（答不出"感觉到什么"的工程改动，优先级应当最低）
3. **工程**：怎么实现、怎么证明（六条门 V1–V6）。

**不做（= 不主动提，不是永远不做）**：主动捞人/sourcing、Offer 与入职、企业人事系统具体对接、系统内沟通协调、独立"人才沉淀"模块、角色×视图矩阵、把 CI 当验收标准、把 12 阶段当模块清单、多租户/云端存储/权限体系/合规留存、自研队列/Runtime/解析/UI 框架。
→ 客户或产品负责人**明确要求**才做，且先写清代价并在 `docs/17` 立裁决。

---

## 3. 现在的真实状态（2026-11-17 快照）

### 3.1 代码/仓库
- 分支 `feat/unified-document-intake`；**HEAD = 远端 = `8fe6fb8`**；工作树干净；无 PR（PR #2 是历史 DRAFT，别动）；**`main` 未动，不许动**。
- **模型口径（本阶段）**：产品 profile 与 worker profile 默认模型 = `opencode-go-openai / hy4-flash-free`（HY4，免费，1M 上下文 / 65k 输出 / text+image）。见 D-143。
- **会话级限制**：`subagent` 的可选模型是**会话创建时固化的白名单**（事件 `subagent/model-selection-policy`）。桌面 profile 的 `subagent-model-selection-settings.allowedModels` 现在含 `hy4-flash-free` 两条，所以**新会话**的子代理可以用 HY4；**旧会话（含前一位 lead 那个）永远换不了**。→ 接手后用新会话即可。
- **CI 不可用**（GitHub 账户计费锁定，所有 job `steps=0`）→ **不作验收 gate**（D-134.2）。机检 = 本机干净库全量 + `runtime-budget` + `clean-load`。

### 3.2 已完成（有证据，别再重做）
| 能力 | 证据/提交 |
|---|---|
| Agent 工程工具面收口（Web 会话 61 → 36 工具，工程工具 0；preset 选择器只剩「招聘助手」） | `346a517`、D-136；`work/d5/verify-preset/REPORT.md` |
| 一等业务读工具 `recruitment_application_get` / `recruitment_material_read`（含按姓名查、criteria 摘要、逐字原文引文 page/line/offset） | `7cd0c8e`、`6d68ce3`、`6f366f9` |
| 高层 `record_human_decision`（服务端组装 basis/hash；事件带四个确认审计键） | `7cd0c8e`、`85e028d` 之前；D-130 |
| 姓名解析修复（只认标签/h1，不再猜字号）+ rubric 质量门槛（QUALITY_WARNING，advisory） | `7cd0c8e`、D-130 |
| SCREENING 决策**同事务派生阶段**（仅 T1）+ REJECT 收口 `ACTIVE→CLOSED` + next_step 修复 | `d324587`、`635e65a`、D-142；独立验证 98/98 |
| `job_get` 按 code/title 查 | `d324587` |
| 工具调用留痕接线（`tool_call` 表终于有写入，`trace_get` 的 TOOL_CALL 环补齐） | `6eaf16a`、D-141④ |
| 三个只读展示端点（原件受控获取 / DSH 会话计量 / 任务状态） | `b884c28`；**注意：200 证据来自等价真依赖采集，不是产品 Host 端口** |
| 24 个工具 render 去内部编号 + **机检**（193 处泄露→0，新增工具漏检即红） | `226cff6`、`6f366f9` |
| 面试官「前面发生了什么 + 本轮参考」（`prior_rounds` + `reference_points`，按轮、线性、403 未授权） | `a84e4c3` |
| RTF/纯文本材料按 D-110 产出可复核证据（不再因缺 bbox 判"读不出来"）+ 合同回抄 | `85e028d`、`bd54641`、`c6c95a1` |
| 演示夹具评分标准可执行性修复（幂等重绑，R-VAL-12 未放宽） | `10801a3` |
| 五个环节「工作说明书」骨架（skill，S6–S10；旧 s6-s7 已退场） | `7ebf5be`、`9e069d1` |
| 预算能力**已撤回**（产品不自造预算闸门；成本只做展示） | `e3c272d`、D-140 |
| 工程工具面 disabled 清单 / 关掉 `tool-subagent-control` / 招聘助手人设 | `5adab02`、`9bb47ef` |

### 3.3 未做 / 需要你接着做（按优先级）
1. **跑干净库全量 + 两道机检**（`6eaf16a` 之后有 11 个提交没跑过全量）。
   ⚠️ **必须同时设** `RECRUITMENT_PYTHON`（fixtures 用）与 `RECRUITMENT_PYTHON_BIN`（bootstrap/converter 用），并设 `RECRUITMENT_CONVERTER_DIR`；少一个会假红（见 §4 坑 7）。
2. **冻结新 SHA + 更新独立验收交接说明**（照 `BRIEF-FROZEN-0272733.md` 的结构改 SHA/证据；`PRECHECK.md` 同步）。
3. **交独立窗口**按 `docs/24 §8` 六条门（V1–V6）复验；**PASS 只能由独立窗口给**。
4. **待产品负责人拍**：初筛的默认行为（A 只给证据 / B 给结论并标"建议"）——**别自己定**（`docs/24 §7 #1`）。
5. **前端任务**（不是你的活，但要能说清接口）：工作台首页"今天要干什么/卡在哪"（后端 `overview.ts` 已有六个"我的"列表）、原文阅读器（后端端点已给）。
6. 可选收尾：`manual/evaluation-line` 已去硬编码；`identity-resolution-rules.md` 仍写"page+bbox"（与 D-110 有张力，属历史债，遇冲突按 `docs/24`/D-110）。

---

## 4. 踩过的坑（**逐条，别重犯；这是本文最重要的部分**）

### A. 判断类（会让你做错东西）

1. **用"能实现"代替"真实业务谁负责"。** 我设计过"HR 给面试官定面试重点""几个面试官看法不一致要人仲裁""材料缺件让 HR 补"——全是凭想象造场景。
   → **每次设计流程前先问四句**：谁做？是他的职权吗？谁受益？会不会要求人越出角色？答不上来就**不许写进产品流程**。
2. **把线性流程说成并行会审。** 招聘是线性的（一面依赖初筛、二面依赖一面）。**不做多面试官联合会审**，也不把"分歧"当常规场景。
3. **在开发环境用"交付质量"当理由。** 我拿"HR 体验"反对在开发/验证环境用免费模型，被骂。（D-143）
   → **先分清阶段**：现在是本地开发验证，用 HY4；交付口径另立裁决。
4. **把工程正确性当产品进度。** 花大量时间在"追溯环/机检/测试数"这种 HR 看不见的地方。
   → 汇报格式固定：**先说"HR/面试官会感觉到什么变化"**，工程细节放括号；看不到变化的改动，优先级最低。
5. **替产品负责人做决定。** 改产品语义前先找台账；确有必要的（如 REJECT 收口）要**明确写成裁决**并告诉他。
6. **"不做清单"写太死。** 是"**不主动提**"：不主动扩范围、不塞进验收；客户/负责人明确要求时可做，但要先说代价 + 立裁决。

### B. 诚信类（**红线，一次都不许犯**）

7. **声称"已派/已完成"而实际没做。** 我在回复里写"已派 3 条 lane"，实际一条没派，只改了文档。（D-140.4）
   → **先调工具，再写"已派"**；报告进度必须能给出**产物路径或 agent/job 名**。
8. **不采信 lane 自述，但也不许因此怀疑一切。** 正确姿势：lane 说 X，你**用一条独立命令复现 X**（psql / 独立脚本 / 真 HTTP）。我复跑时多次发现"红了"其实是**我的环境少了一个变量**（见坑 11）。
9. **不伪造数据、不放宽断言、不把 prompt 当闸门。** 拿不到就写 BLOCKED + 最短恢复路径。

### C. 操作类（会让你浪费半天）

10. **`--dump-config` 通过 ≠ 运行时生效。** Web 会话的工具面由**agent preset 的子树**决定，profile 顶层的 `disabled: true` 对它**无效**（这就是 O19：headless 38 工具、Web 61 工具）。
    → 验"工具面"必须**起真 Host + 看会话 `request/header` 的工具清单**。
11. **两套 Python 环境变量**：`test/document/fixtures.ts` 读 **`RECRUITMENT_PYTHON`**；`scripts/bootstrap-demo.mjs` / converter 读 **`RECRUITMENT_PYTHON_BIN`**；还要 `RECRUITMENT_CONVERTER_DIR`。**少一个就假红**（我因此误判过 7 条测试）。
12. **库必须分开**：测试库 / 产品验证库 / 负例库三分离（D-137.2）。同一个库既跑测试又做产品验证 → 产品写入污染种子 → 依赖种子的用例假红（我踩过，6 条）。
    - 干净库定义：`0001→0016` 按名重放 + `db/verify.sql` 末行 `VERIFY PASS` + **本轮没被产品写过**。
    - 绝不写 `ra_s6s7`（演示漂移库，已脏）。
13. **`ctx.effect(execute)` 语义**：**立刻调用** execute，把返回值当清理函数。所以**不能** `ctx.effect(dispose)`（装完即卸，tsc 查不出来），要 `ctx.effect(() => dispose)`。
14. **profile patch 不能新增 row**（`patch: entry not found`）。要新增行用 loader 的 **`insert`** 语法（`- insert:` 且该条无 `id`）。
15. **改 profile 后必须同步到运行时**：`D:\12412\dsh-home-recruitment\profiles\<name>\cordis.patch.yml`。只改仓库文件，`--dump-config` 看不到变化（我犯过）。
16. **多 writer 同文件会互相覆盖**。派发前先 `list_agents` 看有没有旧 lane 的子代理还在跑同一批文件；写域必须互不重叠；发现撞车先**停一个、写交接单**，再让另一个接管整条链。
17. **长会话 lane 反复中断**（本项目发生 5+ 次）。纪律：**先落盘再继续**（每完成一步写一行报告），**唤醒不重派**（给准确断点 + 让它先看 diff）。
18. **提交用 `git commit -F <消息文件>`**。提交信息里有中文引号/破折号时，`-m "..."` 会被 PowerShell 拆成 pathspec 而失败（我踩过）。
19. **绝不按目录 `git add`**。按**完整交付单元**列文件提交；多 lane 混合工作树时尤其危险。
20. **psql 输出别用 `Select-Object -First` 截断**（会误读结果）；用 `-P pager=off -f file` 或 `-At` 写文件。
21. **Host 启动日志含一次性 token**：`work/` 里**不许留**；用完删（我清理过 44 个文件）。凭据文件永远不打印（我干过一次，导致三个 key 暴露在对话里，必须轮换）。
22. **git push 会间歇 TLS 失败**：重试 2–3 次（间隔 10–20s）即可，不要以为提交丢了。

### D. 数据/夹具类

23. **演示夹具自身会"不合格"**：`0002_seed` 的 rubric v1 criteria 缺 `question` → R-VAL-12 判不可执行 → 初筛必然 `NO_RUBRIC`（真 bug 的样子，其实是数据）。修法 = **允许夹具纠正**（幂等重绑到"已批准且可执行"版本），**不许放宽规则**（D-142.2）。
24. **"原件由产品自存"不是 v1.0**：现在 `intake_asset.storage_ref` 只是 `content-addressed:sha256:<hex>`，原件在 allowed_roots。属企业版部署范畴。
25. **演示脚本曾 `rmSync` 删材料文件**（已修），导致 `material_read TEXT` 永远 `NOT_FOUND_IN_ALLOWED_ROOTS`——遇到"读不出原文"先查文件是否还存在。
26. **证据闸门曾只认 PDF bbox**（已按 D-110 修）：RTF 走 `paragraph+quote`、纯文本 `line/offset`；三条件一条不松（源 sha 一致 / 定位唯一 / quote 逐字命中）；歧义**不得取第一条**。

### E. 环境/端口

27. `49303` = V5.6.1 **静态工作台**（UI 冻结，**非验收对象**，别当产品）；`49344` = 产品 Host；lane 的 Host 只用 **49347..49352**。
28. DSH 用 `D:\12412\recruitment-runtime\node_modules\.bin\dsh.cmd`（0.2.2-rc.3），**不用全局 `dsh`**（旧版）；`DSH_HOME` 必须是 `D:\12412\dsh-home-recruitment`（产品自己的），不要桌面端 home。
29. psql = `D:\12412\PostgreSQL\bin\psql.exe`（postgres/本机口令，口令只从 env 读，不写文件）；Python = `D:\Python3.12.9\python.exe`。

---

## 5. 你的工作方式（照做）

1. **探测**：任何"当前状态"现场取证（`git rev-parse` / 真 HTTP / psql / `runtime-budget`）。
2. **判定**：按 §2 三层顺序；答不出"谁负责/HR 感觉到什么"就别做。
3. **派发**：`我 → Owner lane → Owner 必须再派 ≥2 并发子代理`。任务书写七件事（目标/边界/写范围/验收/停止条件/回报格式/证据位置）。**lane 禁止 git 写**。
4. **验收**：读 diff / 检查断言有没有被放宽 / 要 L1–L5 证据 / 自己独立构造一次证据 / **只交四数的一律退回**。
5. **写回**：裁决必须进 `docs/17`（否则视为未决定）。
6. **汇报给产品负责人**（他在意这些）：
   - **先说人话："HR/面试官会感觉到什么变化"**，再放工程细节；
   - 不要用"已派任务/测试绿/CI 绿"代替判断；
   - 失败就直说 BLOCKED + 最短路径；**不要编场景、不要越权设计、不要美化**；
   - 他说话很直、会骂人——**不要辩解，认错、改、给结果**；
   - 他不喜欢长篇工程黑话；**能用产品语言就用产品语言**。

---

## 6. 证据索引（要引用证据时来这里找）

- 产品视角复核（上一轮 FAIL 的修复依据）：`work/d5/product-review/REPORT.md` + `ui/dialog/consistency/REPORT.md`
- 修复证据：`work/d5/{product-read,product-decision,product-quality,product-budget,fix-copy,fix-server,fix-interviewer,fix-remaining,fix-render,render-lint,api-display,evidence-read,trace-wiring,decision-stage,rubric-fixture,interviewer-brief,evidence-gate}/REPORT.md`
- 独立验证：`work/d5/decision-stage/A-verify/REPORT.md`（98 条判据）、`work/d5/verify-preset/REPORT.md`（工具面 61→36）
- 机检基线：`work/d5/integration/L6-EVIDENCE.md`、`full-suite-*.log`
- 验收交接：`work/d5/acceptance/{BRIEF-FROZEN-*,PRECHECK}.md`

---

## 7. 接手后前 60 分钟该做什么（照做即可）

1. 读 §1 的 1、2、3 三份文档（`docs/24`、`docs/17` 指定条目、`AGENTS.md`）。
2. `git rev-parse HEAD` / `git status` / `git log --oneline -12`；确认 = `8fe6fb8` 或更新，工作树干净。
3. 读 §3.3 未做清单 + `work/d5/acceptance/BRIEF-FROZEN-0272733.md`（了解独立窗口要什么）。
4. **跑干净库全量**（新库 `ra_full_<日期>`：0001→0016 + `db/verify.sql`），同时设 §4 坑 11 的三个环境变量；再跑 `scripts/runtime-budget.mjs`、`scripts/clean-load.mjs`。
5. 四数不对 → 先分清"真回归 / 环境缺变量 / 库污染"，**不要**先改代码。
6. 四数正确 → 冻结 SHA → 更新 BRIEF/PRECHECK → 交独立窗口 → 向产品负责人报"接下来要他拍什么"。
