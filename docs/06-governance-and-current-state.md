> **⚠️ 本文件的"当前状态"章节是历史快照（2026-11 中旬）**，数字与结论会过期。
> 现行口径指向：[`24`](24-product-framework-v2.md)（产品认知与验收六条门）、[`17`](17-decision-ledger.md)（裁决）、[`18`](18-golden-path.md)（怎么跑）、[`25`](25-lead-handoff.md)（交接）。
> **不要**照本文件的工具数/测试数/CI 结论做判断，一律现场探测。

# 06 · 治理、验收与当前状态

**来源**：Notion 11（逐字）、12 页（逐字）、PRD §15/§18、`docs/10`、`docs/11/13/14/15`、Issue #112、W3 独立审计。

---

# 第一部分 · 治理

## 1. 项目为什么存在（决定一切优先级）

项目来自 **Datawhale「AI 产品技术实习生—Agent 方向」**岗位，是一个**面试作品**，要证明五件事：理解招聘业务与复杂流程 / 能设计完整 Agent-native 产品而非单点功能 / 能把 Agent·Workflow·确定性代码·工具·外部系统组织成架构 / 能识别并复用成熟模块 / 能分阶段交付真实可运行可演示的系统。

> 逐字红线：**"不得擅自把项目改成创业可行性论证，也不得反复要求用户证明项目'有没有必要存在'。"**

**因此评审的第一判据不是"市场有没有需求"，而是"是否更好地实现作品目标"。**

## 2. 审查五分类（11 页 §7）

| 分类 | 含义 | 处理 |
|---|---|---|
| Already Designed | 文档已有明确设计 | 引用位置，**不重复提出** |
| Needs Refinement | 方向有，细节/契约/边界不清 | 指出具体缺口 + 修订方案 |
| Actual Gap | 确实缺必要能力 | 证据 + 影响 + 方案 + 复用选项 + 依赖 |
| Deferred | 已识别但非当前版本 | 记录后续版本与前置条件 |
| Out of Scope | 不属本产品或当前任务 | 明确排除 |

## 3. 十条审查规则里最硬的三条（逐字）

- **"不把假设包装成事实。没有文档、代码、官方资料或实际运行证据的内容，必须标为 Hypothesis / To Verify，而不是 Actual Gap。"**
- **"不只提出问题。每个真实缺口必须给出推荐方案、可复用资产、影响范围、依赖和建议版本。"**
- **"不重复已完成的研究和设计；先查清楚，再提出增量。"**

## 4. 总控（原 ChatGPT）职责

- **派发前**：读语义/设计/决策/状态；检查真实仓库与外部状态；明确 Goal / Scope / Non-scope / Inputs / Constraints / Dependencies / 文件所有权 / 验收 / 证据；预判越权与冲突。
- **执行中**：跟踪、纠偏、暂停；高风险与不可逆操作设 Gate。
- **完成后**：独立检查产物与副作用；**"不把 Agent 的'已完成''测试通过'自报当作验收证据"**。

## 5. 八条协调失误 + 根因（11 页 §10）

失误：①把作品项目按创业产品审 ②混淆完整设计与第一版范围 ③把企业内部多角色系统误读成单一 HR 产品/引入候选人门户 ④把 ATS 存在当成产品成立性问题 ⑤重复提出已存在的设计 ⑥把工程问题抛给用户 ⑦引入产品未定义的自动决策风险叙事 ⑧只列风险不给方案。

> 根因（逐字）：**"不是用户没有解释项目，而是 ChatGPT 没有先尊重项目已有目标和文档基线，使用了泛化的反向审查套路。"**

## 6. 用户不该做的事（逐字）

> **"用户不应被迫充当 ChatGPT 与 Agent 之间的人工路由器，也不应被要求自己阅读全部 Agent 日志、判断执行质量或反复补充本可提前设计清楚的 Prompt。"**

---

# 第二部分 · 验收标准

## 7. 四条硬规则 E1–E4（2026-11-12 已批准，写入 `docs/10 §9`）

| # | 规则 | 必要证据 | 防的是什么 |
|---|---|---|---|
| **E1** | **端到端可达**：每个 PASS 必须给出从**运行入口**（HTTP 路由或 Worker）到事实的一条可执行路径 | 命令 + 真实输出 + DB 读回 + 路由注册 `file:line` + 一次真实调用 | "代码在、单测过，但没人调用" |
| **E2** | **skip 计入**：必须报 `passed / failed / skipped` | 三个数；`skipped > 0` **禁止**无条件宣称全绿 | 测试静默跳过而 runner 仍 exit 0 |
| **E3** | **被引用的证据必须存在**：任何 fixture / manifest / 报告必须在所指修订处真实存在 | CI 存在性检查 | 每条 PASS 都引一个从未创建的文件 |
| **E4** | **未接线不得通过**：从运行入口不可达的 handler/adapter/service 是 `BLOCKED`，不是 PASS | E1 的可达性证明，或显式 `BLOCKED` 并指出缺哪根线 | fail-closed 桩把套件跑绿而产品从不工作 |

**后果**：模块可以 `IMPLEMENTED` 而能力 `BLOCKED`，两者都要报；**"测试绿"不是完成声明**；默认 fail-closed 的缝必须报 `BLOCKED` 并指出注入点；F2 与所有 P1 gate 继承此标准；**证据绑定修订，换基线不继承旧结论**。

## 8. 三维诚实标签（2026-11-12 固化）

| 维度 | 取值 | 回答 |
|---|---|---|
| `provenance` | `LIVE` / `FIXTURE` | 数据是真的还是造的 |
| `trigger` | `EVENT` / `MANUAL` | 怎么触发的 |
| `connection` | `CONNECTED` / `NOT_CONNECTED` / `AUTH_REQUIRED` | 产品能不能自己读 |

**绝不**：Fixture 冒充 LIVE；MANUAL 冒充自动摄取；READY 冒充已读取。
> 一维四值枚举（LIVE/FIXTURE/MANUAL/NOT_CONNECTED）**无法表达被批准的 `LIVE`+`MANUAL`+`NOT_CONNECTED` 组合**——这正是历史上三份文档判出三种结果的根因。

## 9. 指标与数据伦理

**三项核心**：Avoidable Manual Touches / Active Human Handling Time / Blocked-Waiting Time。
逐字：**"不预设虚假基线或目标降幅"**；**"不为指标而记录每一次普通点击"**；**"Active Human Handling Time 只有在存在可靠人工处理起止记录时才计算，不从页面打开到提交的时间推断人工工作时长"**；**"不把可由已有数据自然推导的…指标包装成新的独立业务模块"**；**"没有可靠底层事实时不输出伪精确指标；样本不足时显示样本量和不确定性。"**

---

# 第三部分 · 当前状态

## 10. 仓库与分支

- **`main` 冻结在 `6bcfc7033b8b7af235b4b180a3366d3519e243cd`**（PR #121，2026-11-10 08:56 +0800），**此后零合并**。
- 2026-11-11 的 **9 条分支已 push、未合并、无 PR**：5 条 `agent/parallel-*`（W2/W4/W5/W6/W7 业务线）+ 4 条 `agent/phase1-*`（Agent Execution）。
- 远端约 **102 refs**；**约 27–29 条分支从未合入 main**；本地 **103 个 worktree**（**状态债，不是能力**）。
- `origin/main` 实际内容：577 文件 / 约 5.2 万行 TS，`apps/{api,web,worker}` + 8 个 `packages/*`。

## 11. 重置与审计状态

- **R0–R3 已 ACCEPTED**（R0 带更正 / R1 带范围限定 / R2 仅作研究 / R3 带条件）；**R4 未授权**；**零模块采纳**。
- 外部审计（W3，2026-11-10）判本项目 **HOLD / B-**，逐字理由：**"仓库已有大量实现活动，仍需要 W0 对集成状态、架构、真实运行和产品验收做独立 Review。PR 合并数量不能替代产品验收。"**

## 12. 已实现的接线真相（三个 Worker 任务类型）

| task_type | handler | runtime | 状态 |
|---|---|---|---|
| `INTAKE_MATERIALIZE` | `IntakeMaterializeTaskHandler` | `W2MaterializationRuntime(pool)` | ✅ **已实接** |
| `INTERVIEW_RECORD` | `InterviewRecordTaskHandler` | `W5TranscriptRuntime(pool)` | ✅ **已实接** |
| `TRANSCRIPT_FETCH` | `TranscriptFetchTaskHandler` | `port` 默认 `UnconfiguredTranscriptSourcePort()` | ❌ **唯一 fail-closed 断点**（`apps/worker/src/main.ts:27` 未注入） |

---

# 第四部分 · 决策台账

## 13. 已批准 / 已定方向

| # | 决策 | 状态 |
|---|---|---|
| **D-1** | **飞书 P0 口径**：`provenance=LIVE` + `trigger=MANUAL` + 真实 provider artifact ID/revision/hash/readback = demo gate 合格；F2（产品自有 OAuth + 事件）立为 **P1 gate**，不阻塞 demo | ✅ 已批准并落地 `review/feishu-p0-acceptance-path@d34569e`（**未合入 main**） |
| **D-2** | **验收四条硬规则 E1–E4** 写入 `docs/10 §9` | ✅ 已落地 `8f757bc` |
| **D-5** | **pg-boss 底座**：成熟可用，v1.0 继续以 PostgreSQL + pg-boss 为底座；ADR-0006 "not preselected" 只约束**未来替换** | ✅ 已批准（**历史口径**：v1.0 实际未引入 pg-boss，现行见 **D-109/D-122**） |
| **D-6** | **短期直接基于 DSH Web 版开发**（界面好改、扩展能力完整） | ✅ 已定方向，**已落实为现行底座**（`dsh/profile/recruitment/` + 插件；D-109/D-122）；与 ADR-0005/0006 的取代关系已显式标注 |
| **D-7** | **Candidate 自动归并**：高置信多维匹配且无冲突可自动归并，真歧义才人工 | ✅ 已定方向；`docs/03`/`docs/10` 待同步 |
| **D-8** | **主动需求发现后置**：用户发起与已发生事件优先 | ✅ 已定方向 |

## 14. 缺外部资产（不解锁就永远 BLOCKED）

| # | 资产 | 解锁什么 |
|---|---|---|
| **D-3** | 真实 model provider（非生产 endpoint/凭据） | Phase 1 的 LIVE 8 项、Gate B、`demo --real` |
| **D-4** | 飞书 F2 授权：自建应用 + 租户管理员批 scopes + 用户 OAuth(`offline_access`) + 已授权真实会议 | 产品化飞书读取（P1） |

---

# 第五部分 · 矛盾与引用纪律

## 15. 已关闭

- **~~角色 6 vs 7 / 候选人是否算使用者~~** → **已关闭**。候选人不是产品角色，是外部参与者 + 业务对象。以 6 类为准。
- **~~用户当人工路由器~~** → **已关闭**。总控即本地 Agent，全局统管。

## 16. 仍未解决

| # | 矛盾 | 说明 |
|---|---|---|
| **C2** | 术语断裂 | Notion 只用「基础执行底座」；任务侧称「方案 B」，Notion 0 命中 |
| **C3** | 章程不在 main | `main` 写 "Scheme B confirmed"；ADR-0006/docs/17 只在 PR #109（Draft） |
| ~~C4~~ | ~~P0 三层口径~~ | **已关闭（2026-11-16，D-122）**：v1.0 验收对象 = Notion 06 P0 15 项 + PRD §15 + 06 §08 + 07 §11 + 10 §10（均为 Notion 页节号）；Golden Path 9 步与 06 的 13 场景**归档**，不作验收全集 |
| **C5** | Notion 进度落后 | Notion 记"W1–W7 暂停"，与 GitHub phase 1–12 完成态差约 119 个 PR |
| **C6** | 本地克隆 | 停在 11-08 纯文档基线；`main` 已有 577 文件 |
| **C7** | `可用于作品集 = NO` | 属性值 vs W1/W3 把它当能力证据 |
| **C8** | 错误账本 0 条 | 治理机制空转 |
| **C10** | 正文无失效标记 | Notion 08 页尾推翻页内早期建议但正文未回标；01 页停在 11-08 |
| **C11** | pg-boss 权威 | 已由 D-5 裁决（历史）；现行见 D-109/D-122：v1.0 不引入 pg-boss |
| **C12** | 窗口模型退役未回抄 | `docs/11`/`13`/`14` 仍自称 Frozen/Approved，退役公告只在 Issue #112 |
| **C13** | `docs/15 §8` 仍给废稿背书 | "docs/13 and docs/14 define dispatch and local W0 orchestration" |
| **C14** | 持续合并节奏停摆 | `docs/11 §5` 要求 implement→PR→merge，现实 main 两天零合并 |
| **C15** | 状态数字必须现场重探 | 实测 104 refs / 27 未合并；"九条 11-11 分支"是按 push 时间口径 |
| **C16** | W1 分支名两代并存 | `agent/w1-platform-foundation` 与 `agent/w1-wp01-platform-foundation` 都在 origin、都未合并 |
| ~~C17~~ | ~~D-6 与 ADR-0005/0006 对撞~~ | **已关闭（2026-11-16，D-122）**：D-6 已落实为现行底座（Notion 13），取代关系已在 D-6 行与 `docs/02 §13` 显式标注 |

## 17. 引用纪律

**四份执行文档都是 11-09 快照，已被同日推翻**：
- `docs/11/13/14/15` **末次编辑全部停在 2026-11-09 07:35**，HISTORICAL 宣告在 11-10。
- 快照里的 `main@f1a6c9b` 实际是 `6bcfc703`，中间 **299 提交 / 105 次首父合并**。
- 快照说 "No Gate has been independently accepted"，但 **Gate A 已作为 PR #12 合入、Gate B 已独立验证 PASS**，两 SHA 都是 `origin/main` 祖先。

**可引用**：`docs/11 §4–§6/§9/§10`、`docs/13 §2` 不变量与 §4 回传模板、`docs/14 §4/§5/§6/§7/§11`、`docs/15 §1/§2/§4/§5/§7`。
**禁止引用**：两份 11-09 快照、`docs/14 §12` W0 bootstrap prompt、`docs/15 §3` 的 1.0 `Status:` 行、**一切 SHA / PR 号 / 计数**。
**须先裁决**：~~D-6 与 ADR-0005/0006 的关系~~（已由 D-6/D-122 关闭）；`docs/15 §8` 的背书；任何以 W0 为主语的责任句。

**两条不是快照、仍然有效**：① GitHub 分支不等于进程活着；② 不可归属的 commit 记 `UNVERIFIED`。

**退场模型里值得保留的十件事**【推断】：单写者所有权；实现者不得自审；契约请求制；**Gate 作为"依赖释放阀"**；**stop-safe 累积发布**（每次合并都让 main 可构建、可跑通已验收 Golden Path）；迁移平行安全模型；状态机绑定"谁可设置"；证据绑定 + 反指标；**checkpoint 契约（15 字段 + 单一 next action + 可无对话重放接续）——它把"投递"降解为"读取"**；升级阶梯与"两次不同修复即停"。

---

## 18. 本工作区落位

- 旧仓克隆：`D:\12412\dsh工作区\archive\recruitment-os`（2026-11-14 已从 `projects/` 移入 `archive/`；工作树停在旧文档基线，**不要在里面开发**）
- 各 lane worktree：`D:\12412\DshWorktrees\recruitment-os\*`
- 本地控制面（历史）：`D:\12412\dsh工作区\orchestration\recruitment-os`
- 过程产物：仓库内 `work/`（未追踪；本地实际为 `work/decisions/`、`work/review/`、`work/scratch/`，**按设计不入库**）；决策备忘/研究底稿属本地工作区产物，不入库
- 总控行为约束：仓库根 `AGENTS.md`（八条铁律 R1–R8）
- 文档集索引：[README.md](README.md)

