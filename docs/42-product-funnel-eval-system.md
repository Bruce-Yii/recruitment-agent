# 42. 产品级全链路评测体系总纲 V2（唯一权威源）

> **状态**：V2 终稿（2026-11-22，经产品核心 × 产品链路 × 真实架构 × 红队反噬 × 2026 权威标准三轮串行深审重整定稿）  
> **上位产品权威**：[`docs/24-product-framework-v2.md`](./24-product-framework-v2.md)（一切评测对象与边界以 `docs/24` 为准，冲突时以 `docs/24` 裁决）  
> **唯一更新规则**：后续所有评测体系演进、指标调整与数据源增补**只更新本文档**，不再分散另起文档。

---

## 0. 四条永久行为约束与边界铁律

1. **反自嗨铁律（严禁自己编题考自己）**：禁止凭空臆造脱离真实业务的干净假简历、书面语假转写或理想化假 JD；所有评测素材必须走「**细分类 → 网络实证调研/私有真语料 → 注明出处拼装或按真实分布受控扩增**」，无真实来源指针的样本 CI 直接拒收。
2. **阶段聚焦纪律**：隐私法规与合规审查统一放到**上线前收口阶段**处理；当前研发与评测阶段 100% 聚焦真实招聘业务效果、Agent 可靠性与用户使用体感。
3. **确定性代码与概率 Agent 严格分账**：预约白名单 400/409、乐观锁、CSV 转义、权限 403、批量撤销等 **100% 确定性代码**由仓库既有 3060 条单测/集成测试与 15 步真机剧本锁死，**不混入本评测体系计分**——防止确定性 100% 绿稀释真实 AI/Agent 质量信号。
4. **以「人」为主单位，坚持线性逐轮推进**：对齐 `docs/24` §2–§3，数据唯一主单位是**「人（Candidate / Application）」**（阶段只是业务标签）；流程是线性的（一面依赖初筛、二面依赖一面），**不做国外大厂多面试官联合会审 / Bar Raiser 降档**。

---

## 一、2026 年末「产品 + Agent」双重权威标准底座

本产品既是**面向 HR/面试官的招聘工作台产品**，又是**跑在 DSH 上的招聘 Agent**，因此评测体系同时锚定两条 2026 年权威标准：

### 1.1 Agent 侧工程标准（测“智能体靠不靠谱”）
- **NIST CAISI AI Agent Standards & NIST AI 100-1（2026-02 / 2026-10）**：贯通 Design → Development → Deployment → Operation & Monitoring，强制检验身份授权边界、Prompt 注入防御与动作可追责性（[NIST CAISI](https://www.nist.gov/news-events/news/2026/01/caisi-issues-request-information-about-securing-ai-agent-systems)、[CSA 解析](https://labs.cloudsecurityalliance.org/research/csa-research-note-nist-ai-agent-standards-initiative-2026040/)、[Openlayer NIST AI 100-1](https://www.openlayer.com/blog/nist-ai-100-1-framework)）。
- **OpenTelemetry GenAI Semantic Conventions（2026）**：采用厂商无关的标准 Trace 与 `gen_ai.evaluation.*` 语义字段，不绑定任何可能下线的商业托管评测平台（[OpenTelemetry 2026](https://opentelemetry.io/blog/2026/genai-observability/)、[AI Atlas 2026-11-08](https://ai.ozdemir.be/guides/llm-evals-observability)；OpenAI 旧版 Evals 已于 2026-11-30 关停，见 [ibl.ai 2026-11-14](https://ibl.ai/courses/higher-education/evaluating-campus-agents-before-launch)）。
- **Evaluation Cards + 高性价比精简基准（2026）**：拒绝扁平单总分，按数据层级、阶段切分与复现条件出具结构化报告（[arXiv:2606.09809](https://arxiv.org/html/2606.09809v1)）；用高信噪比精简套件替代臃肿大表，避免高昂评测税（[arXiv:2603.23749](https://arxiv.org/html/2603.23749v1)）。

### 1.2 产品侧系统标准（测“产品真不真帮到人”）
- **EN ISO/IEC 42001:2026**：把 AI 作为完整产品系统评估，要求对真实使用者的影响评估与持续业务绩效对齐（[EN ISO/IEC 42001:2026](https://standards.iteh.ai/catalog/standards/cen/adc675e8-4669-4965-b4c1-c8f724832217/en-iso-iec-42001-2026)、[ISO 42001 Guide](https://www.enz.ai/iso-42001-practical-implementation-guide)）。
- **产品成效 × Agent 执行双轨对齐（2026）**：若 Agent 分数上涨但 HR 30 秒看懂率、端到端推进耗时与返工率未改善，即判定评测指标脱离产品价值，必须回真实 Trace 重做 Error Analysis（[Automated Eval Systems 2026-07](https://chierhu.medium.com/automated-evaluation-systems-for-llm-and-generative-ai-products-a-technical-deep-dive-on-metric-7eefa0e119e3)、[Openlayer 2026-10-27](https://www.openlayer.com/blog/agent-evaluation-complete-guide-testing-ai-agents)）。

---

## 二、6 大核心 AI/产品判断点（1:1 对齐 `docs/24` §3 纵向切片）

本评测体系只聚焦真正存在概率波动与产品判断价值的 **6 大核心判断点 + 单人全周期贯通档案（Person-Centric Trajectory）**：

| 判断点 | 对应 `docs/24` 纵向切片 | 核心评测内容与精确指标 | 不可逾越的产品红线 |
|---|---|---|---|
| **P1：读得懂**（S6 解析与视觉兜底） | 简历进来 → 读得懂 | 对齐 [OmniDocBench](https://github.com/opendatalab/OmniDocBench) & [MPDocBench-Parse](https://arxiv.org/html/2605.22100v2)：`TextEdit↓`、`ReadOrderEdit↓`（双栏防串行）、`TableTEDS↑`（WPS 表格防错行）、`Entity F1↑`（公司/年月/岗位/技能） | 收到什么就是什么：**不索要材料、不判定缺件**；读不出诚实标“读不出来” |
| **P2：看得明白**（S7 三态对照与建议） | 人看得明白（结构化 + 旁边点开原文） | **「有对应 / 没有对应 / 读不出来」三态准确率**；防“AI 筛 AI”水分拆解（缺个人贡献与量化指标须标出）；防朴实真干活简历误杀（False Negative Backtest）；原文页码一键锚定完整率 | 显式标明“**这是建议，不是决定**”；绝不把“读不出来”编成“没有对应”；零禁用词 |
| **P3：面得下去**（线性轮次上下文接力） | **本轮面试官参考** + **前置轮次摘要** | ① **本轮参考**：结合岗标 + 简历 + 前轮事实给出“可重点了解的点与原因”；<br>② **前置摘要**：列出前轮聊了什么、答得如何、**岗标内哪些维度尚未覆盖** | ① 本轮参考必须是**参考而非指令**（非 HR 定重点）；<br>② 前置摘要**只列岗位标准内维度**，严禁罗列鸡毛蒜皮变成焦虑清单 |
| **P4：评得出来**（S9 转写→面评草稿） | 线上/线下转写 → 独立面评草稿 | 声明级原子事实审计（[Audit-First 2026-10](https://www.mdpi.com/2076-3417/16/21/10461/pdf)、[LoomSum](https://arxiv.org/html/2609.00241)）：`Claim Faithfulness↑`、`Hallucination Rate↓`、`Numeric Grounding↑`（数字 100% 有出处）、`Critical Signal Recall↑`（二轮追问崩塌、剥离“满嘴我们”团队功劳、防说话人串行） | 草稿仅作辅助，未经真人提交不计入正式面评；不脑补原文未出现的指标 |
| **P5：人做决定 & 事后查得到**（S10 汇总、银牌召回与复盘） | 汇总不产结论 → 真人拍板 → 半年后查得到 | 汇总事实与未决风险完整度；新岗跨岗召回优先浮现历史“银牌候选人”；半年后追问“当时为什么没过”能完整串联简历→初筛→面评→拍板人/时间 | 汇总**不替真人下录用/淘汰结论**；跨岗召回**100% 零打分、零百分比、零排名**；时间线零 UUID/sha256/禁用词 |
| **P6：对话 × 画布协同**（横切 Agent 层） | DSH 单轨 `/recruitment/agent/turn` | 工具选择准确率、19 只读/0 写物理红线、写意图必走 `propose_write`、简历 Prompt 注入防御（[OWASP LLM01](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)）、多轮上下文防串人、冷启动与半路改 JD/转岗韧性 | 0 写工具调用、PG 业务表零私自写入；未配置连接器诚实降级不编造 |

---

## 三、反向压制指标（Counter-Metrics）与产品成效护栏

为防止 Goodhart 定律（刷高评测分却把产品改蠢、改啰嗦），每轮评测强制叠加 3 条反向压制与产品成效红线：
1. **信息密度与 30 秒可扫读上限（反官僚废话）**：初筛对照、本轮参考、前置摘要与对话回复若堆砌空洞免责套话、重复原文或超出合理篇幅上限，直接扣分。
2. **等待体感上限（Perceived Latency）**：记录对话首字延迟（TTFT）、单份真实 PDF 解析+初筛端到端 P95 耗时；超阈值即使准确度 100% 仍标黄/阻断。
3. **冷启动与中途变更韧性**：专门覆盖“新工作空间前 5 份简历冷启动”与“半路改岗位 Rubric / 候选人跨岗转投”的非标准现实场景。

---

## 四、三层真实数据源与 2–3 小时极简标注协议

| 层级 | 来源与落位 | 用途与标注成本 |
|---|---|---|
| **Tier 1：私有真实业务简历库**（不入公库，`$RECRUITMENT_CORPUS_ROOT`） | 用户手头**数百份真实 PDF/Word 简历**：<br>• `tier_a_layout_hell/`（30–50 份多栏/表格/扫描件）<br>• `tier_b_borderline/`（30 份，5 类岗 × 6 份）<br>• `tier_c_bulk/`（其余数百份） | • Tier C：**0 标注**（无参考零崩溃/耗时/乱码压测）；<br>• Tier A：**30 分钟**脚本筛出 + 人工核查阅读序/表格；<br>• Tier B：**1.5–2 小时**极简标注（`target_role` + 逐条三态标尺 + `acceptable_bands` 多解区间 + `must_catch_points`，须含 ≥6 份朴实防误杀 + ≥6 份水分简历），**同时兼任 L3 裁判校准集**。 |
| **Tier 2：外部公开真实基准**（本地 `work/eval-cache/`，gitignore） | • 原始 PDF：[d4rk3r/resumes-raw-pdf](https://huggingface.co/datasets/d4rk3r/resumes-raw-pdf)、[Chinese_Documents_Dataset_PDF](https://huggingface.co/datasets/HumynLabs/Chinese_Documents_Dataset_PDF)<br>• 中文 JD 与匹配：[ouxxyy/ouba-classmate (2026-11)](https://github.com/ouxxyy/ouba-classmate)、[career-ops-china](https://github.com/shuheng-mo/career-ops-china/blob/main/README.md)、[智联招聘 CSV](https://github.com/rovesoul/BigData-and-Analysis/blob/master/%E6%99%BA%E8%81%94%E6%8B%9B%E8%81%98.csv)<br>• 跨文档 HR 推理（含中文）：[Avature/jobresqa-benchmark](https://github.com/Avature/jobresqa-benchmark)、[arXiv:2609.14046](https://arxiv.org/html/2609.14046v1)<br>• 真实中文会议 ASR 噪音：[AliMeeting](https://www.openslr.org/119/)、[AISHELL-4](https://huggingface.co/datasets/shenyunhang/AISHELL-4)<br>• 安全对抗：[OWASP LLM01 Scenario #6](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) | 打破“自己出题考自己”；仓库仅存轻量 `test/eval/loaders/` 适配器与校验哈希，缺缓存诚实报 `CACHE_MISSING`。 |
| **Tier 3：高代价 Agent 故障注入** | 对齐 `docs/12-layer-acceptance.md` | 仅覆盖影响 AI/Agent 判断的极端场景（损坏 PDF 触发视觉兜底、未配连接器、多轮串人、越权直写指令）；纯确定性 CRUD 留在 3060 条单测。 |

---

## 五、分层判分器与 L3 裁判校准协议

1. **L1 确定性硬闸门（任一失败即 FAIL）**：0 写工具、零库变更、Schema 合法、零禁用词「证据」、零 UUID/完整 sha256 泄露、三态枚举合法、跨岗零打分零排名、信息密度硬上限。
2. **L2 轨迹与上下文接力不变量**：先读真库再作答、写意图必发 `propose_write`、前置轮次摘要不漏未覆盖岗标且不越界加杂项、纠偏后 S10 读到新值。
3. **L3 主观裁判（LLM-as-Judge）铁律**（[Bias Calibration 2026-11](https://talentme.airsota.com/resources/registry/llm-as-a-judge-bias-calibration)、[Hamel Husain 2026-09](https://hamel.dev/blog/posts/evals-faq/)、[Scaler 2026-08](https://www.scaler.com/topics/llm-as-a-judge/)、[Future AGI 2026](https://futureagi.com/blog/llm-summarization-evaluation-deep-dive-2026/)）：
   - **弃用 1–5 连续打分**，统一拆解为原子维度的 **`pass / fail`** 或四档 **`supported / contradicted / missing / partial`**；
   - **先引原文、后下判决 + 严禁外部常识**；成对对比强制 **A/B 位置互换**；裁判 Prompt 版本入库锁定；
   - **配平校准上岗门槛**：校准集须**人为配平 50% 典型坏例 + 50% 正常好例**（防小样本方差陷阱），同时通过 **Cohen's $\kappa \ge 0.70$** 与 **TNR $\ge 0.85$** 才允许进入发版门禁，否则仅作趋势观测。
4. **Evaluation Card 切分报告**：强制按 `data_tier`（Tier 1 / Tier 2 / Tier 3）与 `P1–P6` 分开报分，附首个折损归因与基线 Diff。

---

## 六、开发期 G0–G2 触发矩阵 × 上线后 G3 成对护栏飞轮

| 档位 | 触发时机 | 执行范围 | 耗时预算 | 门禁策略 |
|---|---|---|---|---|
| **G0：PR 快门** | 每次 Commit / PR | L1 确定性硬闸门 + `corpus-manifest.test.ts` + 全量单测 + `--mode=deterministic`（0 LLM） | **≤ 2 分钟** | 硬阻断 |
| **G1：模块定向门** | 触碰 `converter/`、`skill/`、`agent-turn`、`scorecard-draft` 等 | 只跑受影响的 P1–P6 子集与对应单人轨迹 | **3–8 分钟** | 回归池硬阻断；能力池仅报差异 |
| **G2：发版全链门** | 发版前 / 重大重构 / 换接运行时模型 | 全部 36 例高信噪比精简集 + 私有真简历库 Tier A/B/C + 已校准 L3 + 核心 `pass^3` | **15–30 分钟** | L1 100% + 回归池 100% + 延迟达标放行 |
| **G3：上线后周度飞轮** | 生产环境每周 SQL 聚合 | 刷新 `#/settings` 评测看板 + 脱敏回流高频失败 Trace 至能力池 | **< 5 秒** | **成对护栏监控（见下表）** |

### G3 线上生产指标强制配对护栏（防单向刷指标失真）
| 线上主指标 | 单看误判风险 | 强制配对护栏指标 |
|---|---|---|
| **HR 人工纠偏率**（`criterion_override`） | 过低可能是 HR 盲点通过（橡皮图章） | 配对 **随机抽检盲审一致率**（确认“没改”是真的准） |
| **面评草稿采纳/修改率** | 零修改可能是面试官偷懒照单全收幻觉 | 配对 **抽样草稿原子事实忠实度（L3）** |
| **`propose_write` 确认卡接受率** | 取消率高可能是用户试探后主动放弃 | 配对 **误操作回滚/撤销率（`undo`）** |
| **端到端推进耗时** | 变快可能以草率放水为代价 | 配对 **一面通过率 / 返工重约率** |

---

## 七、框架底座设计（Phase 1 实施蓝图）与全仓既有验收资产索引

### 7.1 Phase 1 框架底座（聚焦插件边界，不重造 DSH 宿主能力）
Token、缓存、会话与任务面板由 DSH 宿主负责（`docs/24` §2）；本插件评测框架保持轻量高内聚：
1. **以「人」为主轴的统一抽象（`test/eval/types.ts`）**：`PersonLifecycleCase`（单人全周期档案）+ `EvalPointArtifact`（对应 P1–P6）+ `GraderRegistry`（缺实现即报错）；
2. **Evaluation Card 切分报告器**：按 Tier 1/2/3 与 P1–P6 分账输出 + 基线 Diff + 反向压制指标；
3. **私有真简历盘点脚手架**：扫描 `$RECRUITMENT_CORPUS_ROOT/raw/` 自动统计页数、表格、扫描件占比，10 分钟辅助分出 Tier A/B/C；
4. **外部基准加载器契约**：统一从 `work/eval-cache/` 读取并转换，缺缓存诚实报 `CACHE_MISSING`。

### 7.2 全仓既有验收与评测资产全景索引
| 既有资产 | 路径 | 定位与分工 |
|---|---|---|
| **产品认知与验收口径 v2** | `docs/24-product-framework-v2.md` | 上位唯一权威产品定义（P1–P6 评测目标来源） |
| **PDF 转换器验收标准** | `docs/11-pdf-acceptance-criteria.md` | P1 解析与渲染的底层工程判据 |
| **分层故障注入验收** | `docs/12-layer-acceptance.md` | Tier 3 故障注入方法论 |
| **操作层六门验收标准** | `docs/29-acceptance-standard.md` | 独立复跑、可复算、不靠自述的总则 |
| **15 步端到端真机剧本** | `docs/37-e2e-acceptance-runbook.md` | 确定性 UI × 后端 × PG17 真机回归（不混入 Agent 计分） |
| **私有真实语料门禁** | `RECRUITMENT_CORPUS_ROOT` | Tier 1 数百份真简历隔离执行入口 |
| **精简高信噪比评测清单** | `dsh/dsh-recruitment/test/eval/corpus-manifest.json` | 36 例聚焦 P1–P6 + 单人全周期贯通（已剥离纯确定性单测） |
