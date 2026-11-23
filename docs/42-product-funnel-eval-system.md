# 42. 产品级全链路漏斗评测体系架构（End-to-End Funnel Eval System）

> **状态**：权威升级基线（2026-11-22，总控修订）  
> **定位说明**：PR #59 落地的 18 例对话侧评测仅覆盖横切对话层（约占总评测面的 15%）；本文档将评测体系升级为**与产品总链路 1:1 等大的全生命周期漏斗评测体系**——**项目有多大，评测就应该有多大**。

---

## 0. 行为约束铁律：严禁自嗨造题考自己（Anti-Self-Eval Rule）

> **硬性行为约束（永久生效，覆盖后续所有评测设计与样本生成）**：
> 1. **严禁凭空臆造**：禁止拍脑袋编造脱离真实业务的干净假简历、书面语假转写、理想化假 JD 或不存在的 HR 话术来给自己打高分；
> 2. **先调研、后拼装、再受控扩增**：任何拟真业务环境构建，必须按「**细分类 → 网络实证调研公开真实基准/行业实录/真实故障案例 → 注明出处拼装或按真实分布受控扩增**」顺序推进；
> 3. **来源可溯**：进入正式回归集的每一类素材，都必须标注其**真实私有语料来源**或**外部公开出处 URL**；无源头的纯自编业务场景一律不得作为有效评测依据；
> 4. **阶段聚焦纪律**：隐私法规与合规审查统一放到**上线前收口阶段**处理，当前研发与评测阶段 100% 聚焦真实招聘业务效果、6 阶段漏斗准确度与流程可靠性，不在设计期扯隐私合规。
> 5. **结构化报告（Evaluation Card）**：借鉴 [arXiv:2606.09809 (Evaluation Cards, 2026-06)](https://arxiv.org/html/2606.09809v1)，评测报告不得只报一个扁平总分，必须明确披露数据来源切分、各阶段分项指标与复现条件。

---
## 一、2026 年 10–11 月生产级 AI 产品评测行业共识

结合 2026 年 10 月下旬至 11 月中旬的最新一线工程实践，合格的 AI 产品评测体系必须同时满足五条铁律：

1. **不只测“最后一轮回复”，必须测完整执行链路与状态副作用**：据 [Gamut (2026-11-04)](https://www.gamut.so/blog/ai-agent-evaluation-guide) 引用 LangChain 2026 报告与 Stanford AI Index 2026，约 89% 的企业 AI Agent 未能进入稳定生产，仅 52% 团队做了离线评测、仅 37% 做了线上生产评测；核心原因是把评测简化成“单轮问答打分”，忽略了规划、工具调用、上下文传播与数据库副作用。
2. **组件/步骤级 × 序列交接级 × 端到端漏斗级，三层缺一不可**：
   - [Openlayer (2026-10-27)](https://www.openlayer.com/blog/agent-evaluation-complete-guide-testing-ai-agents) 明确指出生产中工具调用失误率在 3%–15% 之间，且大量故障属于 **Sequence-level monitoring gaps**（每一步单独看都合法、Schema 全过，但串起来把下游依赖状态写坏了）；
   - [DeepEval (2026-11-12)](https://deepeval.com/docs/evaluation-component-level-llm-evals) 与 [HatchWorks (2026-11-06)](https://hatchworks.com/blog/ai-agents/ai-agent-evaluation-frameworks/) 强调必须对 Trace 中的每个 Span/组件独立打分，同时追踪端到端完成率，出问题才能 1 秒归因到具体环节。
3. **能力集（Capability Suite）→ 回归集（Regression Suite）双轨演进 + 全改动触发**：据 [Unicrew (2026-11-05)](https://unicrew.com/blog/how-to-evaluate-ai-agents/)，难例攻克后即晋升为回归门禁；任何对 Prompt/工作说明书、工具定义、解析器、检索索引或业务 API 的改动都必须触发对应层级评测（2026 行业仅 15% 团队真正做成 CI 发布门禁）。
4. **数据集按“故障代价”而非“出现频率”加权**：[Openlayer (2026-10-27)](https://www.openlayer.com/blog/agent-evaluation-complete-guide-testing-ai-agents) 建议起步规模不少于 50+ 样本并持续扩充（约 50% 主路径 / 25% 边界异常 / 15%–35% 越权与注入对抗 / 10% 下游故障降级），像隐私泄露、越权落库发拒信这类高代价故障必须重权重覆盖。
5. **线下门禁 + 线上生产遥测回流飞轮（Eval Flywheel）**：评测不是发版前跑一次的静态脚本，而是贯穿产品始终的闭环——线上每一次人工纠偏、草稿大幅改写、确认卡取消与撤销操作，都是最高信噪比的线上质量指标与新回归用例来源（[HatchWorks, 2026-11-06](https://hatchworks.com/blog/ai-agents/ai-agent-evaluation-frameworks/)）。

---

## 二、本产品的全链路漏斗评测总图（6 大阶段 + 1 条横切层）

招聘产品本质是一条**强状态、长链路、不可逆高风险的业务漏斗**。每一个步骤拆解点都必须对应三项资产：**步骤级离线指标（Step Eval）**、**跨步交接不变量（Handoff/Sequence Eval）**、**线上真实质量遥测（Online Telemetry）**。

| 漏斗阶段 | 覆盖真实模块 | 步骤/组件级评测（Step-Level） | 跨步交接/序列评测（Handoff / Sequence） | 线上真实质量信号（Online Flywheel） |
|---|---|---|---|---|
| **Stage 1：收件与文档解析（S6）** | `converter/`、`intake-upload`、`connectors/mail` | PDF/DOCX 文本提取保真度、关键字段抽取 Precision/Recall、逐页 PNG 渲染成功率与 P95 耗时、扫描件/损坏文件降级准确率 | 解析落盘 `material` 后，下游 S7 初筛能否 100% 回溯到原文页码与段落出处（零断链、零脏 sha256） | 解析失败率、原件预览失败率、HR 手动重传率 |
| **Stage 2：建岗与同人判重（S6）** | `job-draft`、`job-create`、`candidate-dedup` | AI 建岗草案 Rubric 维度完整度与权重合法性；同人判重 Precision/Recall（真重复不漏报、非重复不误报） | 建岗默认 `OPEN` 且 Rubric 批准后，新投递是否必触发异步初筛任务且 `business_task` 状态可追踪 | AI 建岗草案采纳率/修改率、重复投递提示核验率 |
| **Stage 3：自动初筛与跨岗召回（S7）** | `screening-evaluate`、`criterion-override`、`talent-rediscovery` | 逐条 Rubric 判定与专家标注一致率（F1）、原文引用忠实度（零编造履历）；跨岗召回相关性 + **100% 零打分/零排名硬闸门** | 人工纠偏写入 `criterion_override` 后，是否立即刷新有效结论、进入追责时间线，且下游 S10 汇总以纠偏后为准 | **北极星指标 1：HR 人工纠偏率（`override / screened`）**；每条真实纠偏脱敏沉淀为 S7 回归样本 |
| **Stage 4：排期与自助预约（S8）** | `interview-slots`、`booking-invite`、`connectors/feishu` | 空闲时段计算零冲突率、本地墙钟/时区准确率、面试官去重 100%、公开页 390px/1440px 触控与 CSP 隔离 100% | 候选人选定 `slot_index` 后 `booking_invite` 单次消费 + `interview` 准确落库；非法/重提 400/409 零写入 | 预约链接发出→确认转化率、链接过期率、排期重约率 |
| **Stage 5：转写与面评草稿（S9）** | `transcript-import`、`scorecard-draft-gen`、`interviewer` | 转写→面评草稿事实忠实度（每条结论锚定转写原话、零脑补）、面试官权限隔离 100% | `minute/rebind` 重绑后草稿不串人；未提交草稿绝不计入正式面评计数与 S10 决断依据 | **北极星指标 2：面评草稿采纳率 & 编辑距离（Draft→Final Edit Distance）**、SLA 按时提交率 |
| **Stage 6：汇总拍板、追责与外发（S10）** | `evaluation-summarize`、`decision-record`、`trace`、`export/webhook` | 多人对比事实零失真、置顶约束 100% 透传、追责时间线零 UUID/sha256/禁用词、CSV 防注入 & Webhook HMAC 签名 100% | 终审落库 → 阶段推进 → 窗口内批量撤销完全可逆 → Webhook 外发失败绝不回滚主业务事务 | **北极星指标 3：批量撤销率（`undo` rate）**、终审周期、外发同步成功率 |
| **横切层：对话助手 × 画布协同** | `agent-turn`、5 套 `skill/`、19 只读工具、`propose_write` | 19 只读/0 写红线、工具选择准确率、入参 Schema 合法性、Prompt 注入/越权防御、多轮上下文防漂移 | 对话发出 `navigate / focus_section / propose_write` 后，画布准确落点且经真人确认后完整落库 | **北极星指标 4：`propose_write` 确认卡接受率 vs 取消率**、单轮延迟与工具失败率 |

---

## 三、漏斗折损归因与评测运行机制

### 3.1 端到端漏斗得分公式（定位“到底哪一步掉链子”）
一次完整的全链路评测不仅输出总通过率，还输出**逐阶段漏斗健康度看板**：
- **Step Pass Rate（单步通过率）**：Stage 1～6 各自独立在确定性真值集上的通过率；
- **Handoff Integrity Rate（交接完整率）**：上游产物交给下游消费时零断链、零状态污染的比例；
- **Funnel End-to-End Completion（全链路贯通率）**：从一份真实复杂简历入库到最终 S10 拍板 + 追责 + 导出，全程零人工兜底、零硬闸门违规的端到端通过率；
- **定位规则**：当 Funnel Completion 下降时，自动比对 6 个 Stage 的 Step Pass Rate 与 Handoff Integrity，直接标红退化源头（例如“Stage 1 表格简历解析丢字段 → 导致 Stage 3 初筛误拒”）。

### 3.2 四类判分器按风险分层配置
1. **确定性代码硬闸门（每次 Commit / PR 必跑）**：0 写红线、Schema、DB 行数/版本链、脱敏/零 UUID/零禁用词、CSV 注入、HMAC 签名、公开页白名单与 403 权限隔离；
2. **序列与状态不变量检查（每次集成/发版必跑）**：验证跨步骤数据一致性（如纠偏后 S10 读到新结论、重绑转写后草稿不串人、撤销后状态完全回滚）；
3. **结构化 Rubric 语义裁判（发版前 / 改 `skill/` 时必跑）**：评测原文引用忠实度、面评草稿与转写原文的一致性、多人对比理由的可复核性；
4. **高风险人工抽检与线上飞轮（每周常规节奏）**：抽检线上真实发生的 `criterion_override`、大幅改写的面评草稿与取消的 `propose_write`，经脱敏后直接入库成为新的离线黄金样本。

### 3.3 数据集规模与演进目标
- **当前基线（PR #59）**：横切对话层 18 例（`E-01`～`E-18`）；
- **下一里程碑（全链路 V2，见 Issue #62）**：扩展至 **60+ 分阶段真值用例**（每个 Stage 8–10 例，覆盖正常主路径 50% / 边界乱码与空态 25% / 越权注入与隐私对抗 15% / 下游超时故障 10%），并落地**线上质量遥测聚合视图**（直接从 PG 真库统计纠偏率、草稿修改率、撤销率、SLA 超时率，呈现到 `#/settings` 治理与评测 Tab）。

---

## 四、三层评测数据源策略（杜绝“自己出题考自己”）

只用自己编造的干净样例做评测，本质上是“出题人与考生为同一人”，永远测不出真实世界里的脏排版、口语噪音与业务潜规则（参见 [Synthetic Data Review (2026-11-01)](https://www.researchgate.net/publication/417178730_Synthetic_Data_for_Artificial_Intelligence_A_Comprehensive_Review)、[AIObs (2026-11-02)](https://www.aiobs.cloud/how-to-evaluate-ai-agents/)、[PNAS (2026-09-23)](https://www.pnas.org/doi/10.1073/pnas.2611363123)）。本项目评测数据严格按三层来源构建：

| 数据层级 | 覆盖评测对象 | 具体来源与落地方式 | 不可替代性说明 |
|---|---|---|---|
| **第 1 层：私有真实业务语料（最高权威，不入公库）** | ① 国内渠道脏简历（BOSS/猎聘导出 PDF、WPS 嵌套表格、截图扫描件）<br>② 真实中文面试转写（妙记说话人串行、中英混杂、打断追问）<br>③ 真实初筛拍板与纠偏标尺 | 1. 放入仓库既有私有门禁目录 `RECRUITMENT_CORPUS_ROOT`（遵循 R7 脱敏不入公库）；<br>2. 由 2–3 位真实招聘官/用人经理对 20–30 份脱敏案例盲评定标尺；<br>3. 试点后自动采集线上真实 `criterion_override`、面评草稿大幅改写与 `propose_write` 取消记录回流扩充。 | 公开数据与合成数据无法复现国内渠道的真实脏版式与团队特定用人尺度。 |
| **第 2 层：外部公开真实基准（立即可用，打破自嗨）** | ① Stage 1 真实复杂 PDF 解析与渲染<br>② Stage 3 跨文档简历×JD 中文推理与公平性<br>③ Stage 2/3 真实技能匹配<br>④ 安全对抗（简历隐藏 Prompt 注入） | 1. 真实原始 PDF：[d4rk3r/resumes-raw-pdf](https://huggingface.co/datasets/d4rk3r/resumes-raw-pdf)（1,940 份真实原始 PDF）+ [Chinese_Documents_Dataset_PDF](https://huggingface.co/datasets/HumynLabs/Chinese_Documents_Dataset_PDF)；<br>2. 多语言（含中文 `zh`）HR 跨文档推理基准：[Avature/jobresqa-benchmark](https://github.com/Avature/jobresqa-benchmark)（[arXiv:2601.23183](https://arxiv.org/html/2601.23183v1)，581 组 QA × 105 对脱敏简历-JD）；<br>3. 真实+混合筛选集：[datasetmaster/resumes](https://huggingface.co/datasets/datasetmaster/resumes)、[Resume-Screening-Dataset](https://huggingface.co/datasets/AzharAli05/Resume-Screening-Dataset)；<br>4. 行业安全对抗范式：[OWASP LLM01:2025 Scenario #6](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)（简历分段载荷注入）。 | 独立第三方分布与行业公开标准，在客户真实语料大规模积累前提供具备外部说服力的基线。 |
| **第 3 层：可控程序化故障注入（确定性状态机专用）** | 并发乐观锁冲突、跨时区排期、非法 `slot_index`/409 重提/403 越权、损坏字节文件、Webhook 503 超时、CSV 注入 | 按 `docs/12-layer-acceptance.md` 原则，通过程序确定性注入已知故障，验证 fail-closed 与零脏写入。 | 高代价极端边界在线上稀缺，必须靠可控故障注入 100% 锁死。 |

---

## 五、仓库既有验收与评测资产全景索引（统一收编，不另起炉灶）

本仓库历史上已沉淀多份分层验收文档与测试脚本，统一收编进本总纲管理，后续所有评测讨论与迭代**只更新本文档**，不再分散新建零散文档：

| 现有资产 | 路径 | 在本评测体系中的定位 |
|---|---|---|
| **PDF 转换器验收标准** | `docs/11-pdf-acceptance-criteria.md` | Stage 1 文档解析与渲染的组件级判据 |
| **分层故障注入验收** | `docs/12-layer-acceptance.md` | 第 3 层故障注入方法论（“每层注入已知失败，验证发现与接住机制”） |
| **S6–S10 链路验收评审** | `docs/23-acceptance-review-s6-s10.md` | 全链路早期阶段边界与历史基线参考 |
| **操作层六门验收标准（V1–V6）** | `docs/29-acceptance-standard.md` | 独立复跑、可复算、不靠当事人自述的验收纪律总则 |
| **15 步端到端真机剧本** | `docs/37-e2e-acceptance-runbook.md` | 浏览器 + PG17 真机回归剧本（15/15 PASS，audit hard 0） |
| **私有真实语料门禁** | `RECRUITMENT_CORPUS_ROOT` + `converter/` acceptance | 第 1 层私有真实业务语料的隔离执行入口（R7 不入公库） |
| **横切对话层评测套件（V1）** | `dsh/dsh-recruitment/test/eval/`（PR #59） | 横切对话层 18 例（`E-01`～`E-18`）+ L1/L2 判分器骨架 |
| **6 阶段漏斗与线上飞轮（V2 规划）** | GitHub Issue #63 | 6 阶段 ≥60 例全链路漏斗套件 + 第 2 层公开基准接入 + PG 线上质量遥测聚合 |

---

## 六、双态评测架构：开发期评测 vs 上线后用户进化体系

整套评测体系在时间轴上严格分成**上半场（开发期 / 发版前）**与**下半场（上线后 / 生产进化）**。两者面对的环境和目标不同，但**共用同一套底层引擎**，确保上线前测的指标和上线后真实跑的指标完全同口径。

### 6.1 共用的统一底层底座（Shared Backbone）
- **同一套 6 阶段漏斗模型**：Stage 1（解析入库）→ Stage 2（建岗判重）→ Stage 3（初筛召回）→ Stage 4（排期预约）→ Stage 5（转写草稿）→ Stage 6（拍板追责外发）+ 横切对话层；
- **同一套四层判分协议**：确定性代码硬闸门（L1）× 跨步交接序列不变量（L2）× 结构化 Rubric 语义裁判（L3）× 稳定性与成本延迟面板（L4）；
- **同一套结构化事件事实源**：全部锚定 PG17 真相库事件（`audit_event`、`criterion_override`、`scorecard_draft`、`scorecard`、`undo_log`、`booking_invite`），不另造第二套割裂的日志 schema。

### 6.2 上半场 vs 下半场的核心区别与衔接

| 维度 | 上半场：开发期评测体系（Dev-Time / CI Gate） | 下半场：上线后进化体系（Production Evolution） |
|---|---|---|
| **核心目标** | **排雷 + 锁底线**：改代码、改 `skill/` 工作说明书、改解析器前，确保不退化、不越权、不丢字段 | **发现未知盲区 + 持续进化**：捕捉离线没想到的真实业务漂移、组织口径差异与漏斗折损 |
| **数据输入** | ① **手头数百份真实中文 PDF/Word 简历**（私有 `RECRUITMENT_CORPUS_ROOT`）；<br>② **外部公开真实基准**（`jobresqa-benchmark`、`resumes-raw-pdf`、OWASP 注入）；<br>③ **高拟真招聘业务环境模拟器**（见 §七） | 客户日常真实操作自然产生的**零打扰隐式反馈信号**（无需让 HR 额外打星评价） |
| **触发频率** | 每次 PR（快速确定性硬闸门）+ 发版前/改 `skill/` 时（全 6 阶段真链路回归 + 私有真简历库跑全量） | 持续实时采集 + 按周聚合漏斗健康度看板（展示在 `#/settings`「行为规范与评测」Tab） |
| **核心度量** | Step Pass Rate、Handoff Integrity、端到端 Funnel Completion、L1 硬闸门 100%、P95 延迟 | **四大生产北极星**：① HR 人工纠偏率；② 面评草稿编辑距离与采纳率；③ `propose_write` 确认卡接受/取消率；④ 批量撤销率 & 预约转化率 |
| **进化动作** | 失败项进能力集（Capability Suite），修复稳定后晋升进回归集（Regression Suite）锁死 | 高频纠偏/草稿大改/取消确认的 Trace 经**脱敏去标识化**后，按周筛选沉淀回开发期回归集，反向驱动 `skill/` 与领域规则迭代（租户间严格隔离，绝不跨客户混用原始数据） |

---

## 七、手头几百份真简历 + 高拟真招聘业务环境构建方案

手头已掌握**数百份真实 PDF/Word 简历**，这是整个招聘链路里最难造假、最值钱的真实输入源；缺失的“下游企业业务环境（岗位、日程、面试转写、多轮决策流）”完全不需要干等真实企业客户，可以通过**真实素材拼装 + 确定性世界模拟器**做到与真实业务几乎无异：

### 7.1 把数百份真实 PDF/Word 简历按“难度与脏度”分层入库（`RECRUITMENT_CORPUS_ROOT`）
不把几百份简历混成一锅乱跑，而是先做一次自动化分级抽样（脱敏编号、不入公库）：
1. **Tier A（版式地狱集，30–50 份）**：双栏/多栏排版、WPS 嵌套表格、侧边栏时间轴、图片/扫描件 PDF、超长 5+ 页履历、加密或乱码字体——专打 **Stage 1 解析与逐页 PNG 渲染**；
2. **Tier B（业务判定难例集，50–80 份）**：按 5 类典型岗位分组（后端/算法、产品、运营、销售、职能），刻意挑选“边缘擦线候选人”（年限略差但项目极硬、大厂头衔但简历空洞、转行非连续履历、同人不同时间投递两版简历）——专打 **Stage 2 判重 + Stage 3 初筛准确度与跨岗召回**；
3. **Tier C（压测与回归全量集，其余数百份）**：用于批量入库吞吐、无崩溃率、耗时分布（P50/P95）与全量零异常稳定性压测。

### 7.2 缺失业务环境的 4 块高拟真构建（达到“跟真的一样”的效果）
1. **真实岗位与 Rubric 库（S6/S7）**：从公开真实招聘市场抽取 5 类典型岗位的真实 JD（保留真实 JD 里常见的模糊词如“高并发经验”“强推进能力”以及硬门槛/加分项/一票否决项），搭配你手头的真简历形成真实投递池；
2. **高拟真面试转写语料库（S9）**：基于公开真实中文技术/业务面试面经与实录结构，构造 15–20 段带真实现场噪音的对话转写——**刻意保留口语停顿、中英混杂、面试官连续追问、候选人回避核心指标、以及飞书妙记常见的 1–2 处说话人识别串行与同音错字**，彻底淘汰“像新闻稿一样工整的假转写”；
3. **企业组织与日程冲突模拟器（S8/S10）**：在一次性测试库里构建一个 1:1 仿真的 30 人研发/产品团队沙盒——含 5 位日程满档/跨时区的面试官、2 位总是超时不交面评的面试官、1 位同时被两个岗位看中的同人历史 MERGED 候选人、以及高并发抢同一预约时段/临时改期场景；
4. **真实 HR 模糊意图与纠偏剧本（横切对话层）**：不写规范的接口式提问，全部用真实 HR 的口语、省略主语、跨轮指代、情绪催促（如“别废话了直接把没过的全拒掉”“刚才那个人我觉得行你帮我改一下”）来压测对话助手的只读红线与 `propose_write` 准确度。

### 7.3 为什么这套“真简历 + 拟真环境”在上线前就极有说服力？
- **输入端 100% 真实**：解析、判重、初筛面对的是你手头几百份真实世界的脏 PDF/Word，没有任何滤镜；
- **过程端 90% 逼真**：转写带 ASR 噪音、日程带冲突、HR 提问带模糊指代、外部基准用第三方公开 `jobresqa-benchmark` 交叉校准，彻底打破“自己写干净题考自己”；
- **上线后 100% 闭环**：一旦首个真实团队开始用，上述模拟信号直接被真实团队的纠偏率、草稿编辑距离与撤销率平滑接管，不需要推倒重来。

---

## 八、6 大真实评测素材细分类与分步网络调研进度（实证目录）

按“分类清晰 → 逐类网络调研取证 → 有出处拼装”的顺序，把缺失的招聘业务环境拆成 6 个独立素材类逐一攻克：

| 细分类 | 对应漏斗环节 | 当前状态 | 已调研落位的真实来源 / 公开基准 | 下一步实证动作 |
|---|---|---|---|---|
| **分类 1：真实简历原件与版式脏数据** | Stage 1 解析/渲染 | **已落位** | ① 用户手头**数百份真实 PDF/Word 简历**（私有 `RECRUITMENT_CORPUS_ROOT`，分 Tier A/B/C）；<br>② [d4rk3r/resumes-raw-pdf](https://huggingface.co/datasets/d4rk3r/resumes-raw-pdf)（1,940 份真实原始 PDF）；<br>③ [Chinese_Documents_Dataset_PDF](https://huggingface.co/datasets/HumynLabs/Chinese_Documents_Dataset_PDF) | 制定私有简历自动化脱敏与 Tier A/B/C 分级抽样脚本 |
| **分类 2：真实市场岗位 JD 与隐性门槛** | Stage 2/3 建岗与初筛 | **Batch 2 已实证** | ① [ouxxyy/ouba-classmate](https://github.com/ouxxyy/ouba-classmate)（2026-11-14 发布，含 CC BY 4.0 中文求职与 JD-简历基准）；<br>② [datasetmaster/resumes](https://huggingface.co/datasets/datasetmaster/resumes)；<br>③ [Resume-Screening-Dataset](https://huggingface.co/datasets/AzharAli05/Resume-Screening-Dataset) | 专项调研 5 类中文高频岗（后端/算法/产品/运营/销售）真实公开 JD 的硬门槛与模糊词分布，拼装真实 Rubric 样本 |
| **分类 3：跨文档简历×JD 推理与公平性基准** | Stage 3 客观标尺 | **已落位** | ① [Avature/jobresqa-benchmark](https://github.com/Avature/jobresqa-benchmark)（[arXiv:2601.23183](https://arxiv.org/html/2601.23183v1)，581 QA × 105 对脱敏简历-JD，含中文 `zh` 与公平性受控属性）；<br>② [arXiv:2609.14046 (2026-09)](https://arxiv.org/html/2609.14046v1)（945 条经审计的真实岗位对齐面试题基准） | 抽取 `jobresqa-benchmark` 中文子集作为独立外部交叉校验集 |
| **分类 4：真实中文会议/面试转写与 ASR 噪音** | Stage 5 转写与面评草稿 | **Batch 1 已落位噪音源** | ① [AliMeeting (OpenSLR 119)](https://www.openslr.org/119/) / [dia-alimeeting-test](https://huggingface.co/datasets/ggfox00000/dia-alimeeting-test)（真实中文多人会议，含重叠抢话与说话人分离）；<br>② [AISHELL-4](https://huggingface.co/datasets/shenyunhang/AISHELL-4)（211 场 120 小时真实中文会议，含短停顿/噪声/快速切换） | 结合公开真实中文技术/业务面经结构 + AliMeeting/AISHELL-4 真实口语断句与串行噪音分布，拼装 15–20 段高拟真带噪转写 |
| **分类 5：真实面试官面评写法与校准争议** | Stage 5/6 面评与终审 | **Batch 2 已实证** | 初步参考 [CoMAI (arXiv:2603.16215)](https://arxiv.org/html/2603.16215v1) 结构化 Rubric 降偏见框架 | 专项调研一线互联网/科技公司公开面评模板、真实“敷衍面评”与“Hire vs No Hire 撕裂校准案例” |
| **分类 6：真实流程异常、合规隐私与安全对抗** | Stage 4/6 & 横切安全 | **Batch 2 已实证** | ① [OWASP LLM01:2025 Scenario #6](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)（简历分段载荷 Prompt 注入）；<br>② 2026 真实 AI 面试平台隐私泄露诉讼案例（见 [2026-10 行业分析](https://medium.com/@gwrx2005/the-securitization-of-remote-work-c10566e2c35d)）；<br>③ 仓库既有 `docs/12-layer-acceptance.md` 故障注入方法论 | Batch 2 补齐国内《个人信息保护法》招聘信息脱敏要求 + 真实 ATS 排期冲突/候选人爽约/重复投递边界样本 |

### 推进顺序（严格按批实证，不跳步）
1. **Batch 1（本轮已完成）**：确立 6 大细分类 + 写入 §0 反自嗨铁律 + 落位分类 1/3/4 外部真实公开基准；
2. **Batch 2（下一轮专项网络调研）**：深挖分类 2（5 类中文真实市场 JD）、分类 5（真实面评写法与校准争议）、分类 6（国内招聘隐私合规与真实排期/爽约异常）；
3. **Batch 3（资产化落地）**：把调研取证的真实素材整理为可复现的 `eval-corpus-manifest.json`（每条带外部来源 URL 或私有语料哈希指针），直接喂给 Issue #63 的 6 阶段漏斗评测引擎。

---

## 九、Batch 2 专项实证落盘（分类 2 / 5 / 6）与 `corpus-manifest` 资产化蓝图

### 9.1 分类 2 补充实证：中文真实岗位 JD 与国内招聘生态来源
- 新增公开中文岗位原型与数据出处：[shuheng-mo/career-ops-china (2026-04)](https://github.com/shuheng-mo/career-ops-china/blob/main/README.md)（国内招聘流程与 8 类技术/数据岗位原型）、[rovesoul/BigData-and-Analysis 智联招聘.csv](https://github.com/rovesoul/BigData-and-Analysis/blob/master/%E6%99%BA%E8%81%94%E6%8B%9B%E8%81%98.csv)（真实公开中文职位 CSV）、[ouxxyy/ouba-classmate (2026-11-14)](https://github.com/ouxxyy/ouba-classmate)（CC BY 4.0 中文求职与 JD-简历基准）。
- **5 类高频中文岗 Rubric 拼装规范**（禁止写干净玩具标准，每岗必须包含硬门槛 + 真实模糊词 + 一票否决项）：
  1. 后端研发（高并发/分布式/线上排障 + 模糊词“架构演进能力”）；
  2. 算法/AI 工程（模型落地/评测迭代 + 模糊词“业务抽象能力”）；
  3. 产品经理（B 端复杂流程/跨团队推进 + 模糊词“强自驱与拿结果”）；
  4. 增长/运营（漏斗转化/复盘归因 + 模糊词“数据敏感度”）；
  5. B2B 销售/职能（大客户成单周期/合规底线 + 模糊词“抗压与客户洞察”）。

### 9.2 分类 5 实证：真实面试官面评规范与 4 类校准争议场景
基于一线工程招聘实务规范（参见 [Tech Talent Drop: The Tech Interview Playbook](https://techtalentdrop.com/interview-playbook) 与 [CoMAI (arXiv:2603.16215)](https://arxiv.org/html/2603.16215v1)），Stage 5/6 评测集必须覆盖 4 类真实高痛点面评场景：
1. **敷衍空洞面评（Zero-Evidence Feedback）**：面试官仅填“感觉基础一般，不建议录用”而无具体问答实例 → 评测 S10 汇总是否明确标出“缺少可复核依据”，而非把主观情绪放大成客观结论；
2. **撕裂分歧面评（Split Decision：Strong Hire vs Lean No Hire）**：两轮面试结论完全相反 → 评测 S10 汇总与对话助手是否**如实并排呈现冲突点与待补验证项**，绝不和稀泥、绝不替真人拍板（遵循行业“分歧时优先补数据而非强行二选一”原则）；
3. **防锚定盲评隔离（Anti-Anchoring Isolation）**：面试官 A 提交面评前绝对看不到面试官 B 的面评与用人经理倾向（服务端 + 前端双隔离 100%）；
4. **超时滞后面评（24–48h SLA Breach）**：行业规范要求 24–48 小时内交面评防记忆衰减，超时后触发 `#/settings` 催交策略与待办队列优先标红。

### 9.3 分类 6 聚焦：真实招聘流程异常与稳定性边界
当前阶段不展开法律隐私合规（留待上线前收口），分类 6 100% 聚焦真实业务现场的高频异常：多面试官排期冲突、候选人爽约/临时改期、同人跨岗重复投递、批量操作误判撤销、以及简历隐藏 Prompt 注入与下游接口超时降级（对齐 `docs/12-layer-acceptance.md`）。

### 9.4 Batch 3 资产化契约：`dsh/dsh-recruitment/test/eval/corpus-manifest.json`
下一步实施 [Issue #63](https://github.com/Bruce-Yii/recruitment-agent/issues/63) 时，所有 60+ 全链路漏斗用例必须先在 `corpus-manifest.json` 登记来源元数据，**无来源字段的用例 CI 直接拒收**：
```json
{
  "case_id": "S7-01",
  "stage": "Stage3_Screening",
  "data_tier": "tier2_public_benchmark",
  "source_ref": "https://github.com/Avature/jobresqa-benchmark",
  "private_corpus_hash": null,
  "failure_cost_weight": "high",
  "graders": ["L1_no_write", "L1_no_forbidden_term", "L2_citation_grounded"]
}
```

---

## 十、招聘业务深水区评测判据（Wave 1 业务实证：初筛水分/误杀 + 面试二轮深挖）

本节把一线招聘实务中最容易让 AI 产品“看起来很聪明、实际不好用”的深水区业务陷阱，直接转化为 Stage 3 与 Stage 5 的可执行评测判据：

### 10.1 Stage 3 初筛深水区：破除“AI 筛 AI”水分与防误杀（False Negatives）
据 2026 年招聘实务调研（[Superdriven (2026-09-02)](https://superdriven.in/blog/screen-200-resumes-without-burning-out-hr-team)、[Skill IQ (2026)](https://www.skilliq.co/blog/ai-resume-screening-vs-ai-interviews)、[Hivemind HR](https://hivemind.hr/blog/automated-candidate-screening)）：大量候选人已使用 AI 润色简历，**简历本质是“自述主张（Claims）”而非既定事实**；如果初筛只奖励工整文风与关键词密度，就会陷入“AI 偏爱 AI 写的空洞简历，反而误杀表述朴实但真干过活的工程师”的致命陷阱。

因此 Stage 3 初筛评测必须检验以下 **4 类真实业务判别能力**：
1. **水分拆解（Ownership & Measurable Outcomes）**：面对“华丽大厂头衔 + 堆砌高并发/中台词汇、但零个人负责边界与零量化指标”的简历，初筛必须标出“缺少可核对的个人贡献与量化结果”，不得给高匹配背书；
2. **朴实真干活防误杀（Anti-Keyword Tunnel Vision）**：面对用词不同但技术实质等价的简历（如未写标准 JD 关键词但有真实线上故障排障与核心代码归属），系统须基于语义与真实经历召回，不因字面缺词误杀；
3. **生成“面试必追问疑点（Gaps for Human Follow-up）”**：对边缘擦线候选人，初筛输出不仅给逐条对照，还必须指出 1–2 个供一面面试官现场核实的具体疑点；
4. **误杀抽检指标（False Negative Backtest）**：在私有真简历库（Tier B）中刻意混入已知“历史录用/高绩效”但简历写得朴素的样本，要求召回率达标且进入人工复核视线。

### 10.2 Stage 5 面试转写与面评草稿深水区：识别“二轮追问崩塌”与“团队功劳混充”
据 2026 年末结构化面试与问题解决能力评估实务（[SocialTalent (2026-11-03)](https://www.socialtalent.com/best-interview-questions/competency-problem-solving)、[Meta 行为面评估指南 (2026)](https://preper.app/guides/meta-behavioral-interview-prep)、[Testlify (2026-09-14)](https://testlify.com/how-to-conduct-an-effective-job-interview/)、[字节跳动高频算法/工程面试实录](https://github.com/WeThinkIn/AIGC-Interview-Book/blob/main/%E5%A4%A7%E5%8E%82%E9%AB%98%E9%A2%91%E9%9D%A2%E8%AF%95%E9%A2%98%EF%BC%88%E5%AE%9E%E6%97%B6%E6%9B%B4%E6%96%B0%EF%BC%89/%E5%AD%97%E8%8A%82%E8%B7%B3%E5%8A%A8%E9%AB%98%E9%A2%91%E9%9D%A2%E8%AF%95%E9%A2%98.md)），高拟真中文转写评测样本必须内置以下 **4 类现场信号**，检验 `scorecard-draft-gen` 能否真正抓出：
1. **二轮追问崩塌（Collapse Under Second Probe）**：候选人开场背诵流畅，但被面试官追问细节（如“之前修过几次？为什么会复发？通信瓶颈具体卡在哪？”）时开始绕弯或自相矛盾 → 面评草稿必须明确记录“首轮叙述完整，但二轮深挖未能给出具体根因”，绝不能只摘要前半段漂亮话；
2. **背景 90 秒 / 动作 30 秒 & 全程“我们”**：候选人大篇幅讲项目背景和团队架构，个人实际动作模糊 → 面评草稿必须区分“团队成果”与“候选人本人贡献”，严禁把团队业绩算成候选人个人能力；
3. **高分信号三要素识别**：真正优秀的回答同时具备“踩过的弯路（wrong turn）+ 量化结果 + 事后方法改进” → 评测草稿是否准确提炼这三项，而非泛泛而谈“沟通良好、逻辑清晰”；
4. **面试官组内校准（Panel Calibration）**：同一段转写若模拟两位面试官给出相差超过 1 档的评分，评测 S10 汇总是否触发“标准口径分歧提示”，辅助 24 小时内高效 Debrief。

---

## 十一、招聘业务深水区评测判据（Wave 2 业务实证：排期改期/爽约 + 银牌召回与终审权衡）

### 11.1 Stage 4 排期深水区：改期常态、周一冲突潮与爽约（No-Show）现场流转
据 2026 年真实排期运营基准（[candidate.fyi 257,946 场排期实证 (2026)](https://candidate.fyi/post/how-to-audit-interview-scheduling-workflows)、[YouCanBookMe (2026-11-09)](https://youcanbook.me/blog/interview-scheduling-best-practices)、[US Tech Automations (2026-04-11)](https://ustechautomations.com/resources/blog/interview-scheduling-automation-how-to-2026)）：
- 真实招聘中 **14% 的面试必然发生改期**，周一面试官拒约数比周五高 **40%**；自助预约平均 **27 分钟**确认（人工协调需 243 分钟），而改期响应超 48 小时会导致 **24% 候选人直接失联（Ghosting）**。
- 因此 Stage 4 的高拟真沙盒与评测必须覆盖 4 类真实排期异常，而非只测“一次约成功”：
  1. **面试官负载失衡（Interviewer Bottleneck）**：3 位合格面试官中 2 位日程满档、1 位有空 → 查空推荐应优先识别真实可用面试官，避免制造“虚假无空闲”；
  2. **临时改期与原时段释放**：候选人或面试官发起改期后，旧面试实例状态更新且新预约不产生重复有效面试；
  3. **未回复邀约与超期失效**：自助预约链接超期（如 72 小时）未选时，系统明确标出“链接已过期需重发”，禁止静默卡死在排期中；
  4. **候选人爽约（No-Show）留痕**：记录爽约事实并提供“重新发预约链接”或“关闭申请”的清晰分支，不混淆“未面试”与“面评未交”。

### 11.2 Stage 6 与跨岗召回深水区：银牌候选人（Silver Medalist）与终审定级权衡
据 2026 年人才库再发现与终审校准实务（[TheHireHub.ai (2026-04-20)](https://www.thehirehub.ai/blog/talent-rediscovery-ai-silver-medalists-ats-2026)、[Pin (2026-02-23)](https://www.pin.com/blog/talent-sourcing-strategy/)、[TechScreen Uber 2026 终审拆解](https://techscreen.app/articles/uber-technical-interview-process-2026)、[MentorCruise (2026-10-14)](https://mentorcruise.com/blog/reaching-final-rounds-without-an-offer-what-to-check-first/)）：
- 曾进入终面但差一点落选的**银牌候选人**转化率是冷投递的 **3 倍**，但多数团队再触达率低于 5%；而在终审环节，高频真实决策不仅是“录用 / 淘汰”，还包括**降档定级（Down-level）**，且被拒候选人往往存在**面评缺失不对称**（导致事后复盘无据可查）。
- 因此 Stage 3 跨岗召回与 Stage 6 终审评测新增 3 类真实业务考题：
  1. **银牌候选人优先召回（事实驱动、零打分）**：新开同类岗位时，优先把历史进过二面/终面但因名额或方向微差未录用的候选人浮现出来，清晰展示历史岗位、到达轮次与当时落选原因（依然 100% 零百分比/零排名）；
  2. **技术强 × 架构弱的降档/加面权衡**：当两轮编码面强通过但系统设计/Bar Raiser 偏弱时，S10 汇总与对话助手须客观呈现“降档录用 / 补加一轮架构面 / 淘汰”三种权衡依据，而非简单二元催录用；
  3. **残缺面评强拦阻（防无据淘汰）**：当仍有已完结面试未交面评时，终审汇总必须醒目标出缺失轮次与责任面试官，避免在信息残缺下草率拍板。

---

## 十二、评测引擎框架与前置准备蓝图（先搭地基，再填资产包）

> **执行纪律**：在制作具体样本 JSON 资产包之前，必须先把以下 **5 块框架与前置准备地基** 定死并落地，避免样本格式与评测引擎紧耦合返工。

### 12.1 底座 1：统一 6 阶段漏斗执行与判分抽象（扩展 `test/eval/types.ts`）
现有 V1 `EvalTrajectory` 仅能描述对话层 SSE 轨迹；V2 升级为统一漏斗抽象，保留 V1 零破坏并作为横切层适配器：
- **`StageRunArtifact`（统一单步产物）**：`{ caseId, stage, dataTier, sourceRef, suitePool, inputs, outputs, dbSnapshotBefore?, dbSnapshotAfter?, upstreamRef?, latencyMs }`；
- **`StageAdapter`（阶段执行器接口）**：Stage 1–6 + CrossCut 共 7 个适配器各自实现 `run(caseSpec, env) => Promise<StageRunArtifact>`；
- **`GraderRegistry`（可插拔判分注册表）**：把 `corpus-manifest.json` 中的 `graders[]` ID 映射到具体 L1/L2/L3 判分函数，缺实现即报错（防空挂名判分器）。

### 12.2 底座 2：Evaluation Card 结构化报告与漏斗归因契约
每次运行输出标准 `FunnelEvaluationCard`（JSON + Markdown），强制包含 4 块视图，**禁止把不同数据源揉成一个虚高总分**：
1. **分阶段漏斗健康度**：7 个阶段各自的 `step_pass_rate`、`handoff_integrity_rate`、以及端到端 `funnel_completion_rate`；
2. **按数据层级切分（Tier Split）**：`tier1_private_corpus`（真简历）/ `tier2_public_benchmark`（公开基准）/ `tier3_fault_injection`（故障注入）**分开报分**；
3. **自动折损归因（Drop-off Attribution）**：当端到端失败时，沿 `upstreamRef` 链路标出首个失败 Stage 与具体 Grader Code；
4. **基线 Diff 对比**：与上次报告比对，明确列出 `regressions[]`（回退项，CI 阻断）与 `newly_passed[]`（可晋升项）。

### 12.3 底座 3：私有真实简历库（`RECRUITMENT_CORPUS_ROOT`）前置准备规范
为您手头的数百份真实 PDF/Word 简历建立轻量、不入公库（gitignore）的本地目录规范，避免标注重到做不下去：
```text
$RECRUITMENT_CORPUS_ROOT/
├── raw/                  # 原始真实 PDF/DOCX（只读不改）
├── tier_a_layout_hell/   # 30–50 份：多栏/表格/扫描件/长页（Stage 1 专用）
├── tier_b_borderline/    # 50–80 份：5 类岗擦线/水分/朴实真干活样本（Stage 2/3 专用）
├── tier_c_bulk/          # 其余数百份：吞吐与零崩溃压测
└── labels.local.json     # 极简人工标尺（仅 Tier B 需填 3 字段）
```
- `labels.local.json` 每份简历只需填 3 个极简字段：`{ file, target_role, expected_band: 'pass' | 'borderline' | 'reject', must_catch_points: string[] }`，配套前置盘点脚本自动统计文件类型、页数、加密/扫描占比，帮人 10 分钟挑出 Tier A 样本。

### 12.4 底座 4：外部公开基准本地缓存与转换协议（不污染 Git 仓库）
- 第三方大体积数据集（`jobresqa-benchmark`、`resumes-raw-pdf`、`AliMeeting` 等）统一落本地缓存目录 `work/eval-cache/`（已 gitignore），**绝不把几十 MB 外部原始文件提交进 Git**；
- 仓库内只存轻量转换适配器（`test/eval/loaders/`）与校验哈希，把异构外部格式统一转换为内部 `EvalInputRecord`；缺缓存时诚实报 `CACHE_MISSING`（不伪造通过）。

### 12.5 底座 5：能力集 vs 回归集双池闸门 + 线上遥测同构契约
- 扩展用例元数据支持 `suite_pool: 'regression' | 'capability'`：**回归池**任何 1 条失败直接红灯阻断合入；**能力池**用于攻坚新难例，连续稳定通过后人工晋升进回归池；
- 线上生产遥测（`governance.funnel_telemetry`）与离线报告共用同一套阶段命名与指标口径（纠偏率、草稿编辑距离、确认卡接受率、批量撤销率、SLA 按时率），实现开发期→上线后零重构衔接。

---

## 十三、L3 裁判校准防偏见协议与核心阶段精确数学指标（研究收口 A）

在进入框架代码实现前，锁死两项最容易导致“假绿”的方法论底线：L3 主观裁判怎么防偏见并经人类校准才能上岗，以及 Stage 1 / Stage 5 精确怎么算分。

### 13.1 L3 主观裁判（LLM-as-Judge）校准与防偏见铁律
结合 2026 年下半年至 11 月的裁判校准实证（[LLM-as-a-Judge Bias Calibration (2026-11-17)](https://talentme.airsota.com/resources/registry/llm-as-a-judge-bias-calibration)、[AI Atlas (2026-11-08)](https://ai.ozdemir.be/guides/llm-evals-observability)、[Hamel Husain (2026-09-18)](https://hamel.dev/blog/posts/evals-faq/)、[Scaler (2026-08-30)](https://www.scaler.com/topics/llm-as-a-judge/)、[LLM-as-a-Judge Field Guide (2026-07-25)](https://kraghavan.ca/llm-infrastructure/evaluation/2026/07/25/llm-as-a-judge-field-guide.html)、[Future AGI (2026)](https://futureagi.com/blog/llm-summarization-evaluation-deep-dive-2026/)）：
1. **弃用模糊 1–5 / 1–10 连续打分，统一改用「维度拆解 + 二元/四档分类判决」**：
   - 整数 Likert 量表容易发生分数聚集（80% 堆在 3–4 分，失去区分度）；
   - 所有主观评估全部拆解为独立原子检查项，输出 **`pass / fail`** 或四档分类 **`supported / contradicted / missing / partial`**，再按维度聚合。
2. **先引原文、后下判决（Evidence First, Verdict Second）+ 严禁外部常识**：
   - 裁判 Prompt 强制先逐字摘录原文支撑片段再给判决；并明令“即使事实在现实世界成立，只要简历或转写原文未出现，一律判 `missing`”。
3. **防偏见三项措施**：
   - 成对对比评测强制做 **A/B 位置互换（Position Swapping）**，两轮不一致即判平局/待人工复核（消除位置偏见，参见 [HuggingFace Position Bias Study (2026-10-28)](https://huggingface.co/papers?q=LLM%20Judge)）；
   - 严禁“堆叠同家族模型当陪审团”制造虚假独立性；
   - **裁判 Prompt 与版本强制入库编号**，改裁判本身必须重跑校准集。
4. **裁判上岗硬门槛（禁止未校准裁判进门禁）**：
   - **绝不只看原始一致率（Raw Agreement）**（不均衡数据上全猜 Pass 也能得高分却漏掉致命 Fail）；
   - 上岗前必须在 30–50 份人类真值校准集上同时通过：**Cohen's $\kappa \ge 0.70$**（消除随机一致）且 **TNR（抓坏例真阴性率）$\ge 0.85$**；未达标时该维度只输出趋势观测，**严禁作为 CI 阻断门禁**。

### 13.2 Stage 1（PDF/Word 简历解析）精确数学指标口径
对齐 2026 文档解析主流基准（[OmniDocBench](https://github.com/opendatalab/OmniDocBench)、[OCR Benchmarks 2026 (2026-10-21)](https://invoicedataextraction.com/blog/ocr-benchmarks)、[MPDocBench-Parse (arXiv:2605.22100)](https://arxiv.org/html/2605.22100v2)），拒绝用“提取出多少字符”糊弄：
- **`TextEdit↓`（字符级文本编辑距离）**：衡量原文抽取保真度与乱码率；
- **`ReadOrderEdit↓`（阅读顺序编辑距离）**：专打双栏/侧边栏简历，衡量块序是否左右串行；
- **`TableTEDS↑`（表格树编辑距离相似度）**：专打 WPS 嵌套表格简历，衡量行列结构是否错位；
- **`Entity F1↑`（关键履历实体规范化 F1）**：公司名、起止年月、岗位头衔、核心技能四类实体的精确率与召回率（含跨页截断恢复率）。

### 13.3 Stage 5（转写→面评草稿）精确数学指标口径
拒绝用纯字符编辑距离误伤“口语改书面语”，采用 2026 声明级原子事实审计框架（[Audit-First Claim-Level Framework (2026-10-22)](https://www.mdpi.com/2076-3417/16/21/10461/pdf)、[LoomSum (arXiv:2609.00241)](https://arxiv.org/html/2609.00241)、[Future AGI (2026)](https://futureagi.com/blog/llm-summarization-evaluation-deep-dive-2026/)）：
先把面评草稿拆解为独立**原子事实声明（Atomic Claims）**，再逐条对照转写原文打 `supported / contradicted / missing / partial`：
- **`Claim Faithfulness↑`** $= \#\text{supported} / \#\text{total\_claims}$：草稿事实忠实率；
- **`Unsupported / Hallucination Rate↓`** $= (\#\text{contradicted} + \#\text{missing}) / \#\text{total\_claims}$：专抓脑补指标与“把团队功劳算成个人”；
- **`Numeric Grounding↑`**（LoomSum）：草稿中出现的每一个定量数字（QPS、延迟、团队人数、转化率）必须在转写原文有 100% 对应出处；
- **`Critical Signal Recall↑`**：对预埋了“二轮追问崩塌 / 满嘴‘我们’ / 说话人串行”的转写样本，草稿是否准确命中且归属到正确说话人（防 Entity/Speaker Swap）。

---

## 十四、极简标注与多解标尺协议 + 分层改动触发矩阵（研究收口 B）

本节解决最后两块落地前盲区：如何以最小人工成本撬动手头数百份真实简历，以及如何通过分层触发让整套评测跑得动、没人绕过。

### 14.1 数百份真简历的「2–3 小时极简标注法」与多解标尺（Multi-Acceptable Bands）
绝不要求人工给几百份简历逐字段手写参考 JSON，按 Tier 严格控制标注投入：
1. **Tier C（其余数百份全量压测集）—— 0 人工标注**：全自动无参考（Reference-Free）硬检查：零崩溃、非空解析、页数合法、逐页 PNG 渲染成功、乱码字符占比不超限、P95 耗时达标、重复上传 sha256 幂等；
2. **Tier A（30–50 份版式地狱集）—— 30 分钟半自动抽检**：由前置盘点脚本按“多页 / 含表格 / 文本密度极低（疑似扫描件）/ 多栏坐标特征”自动筛出候选清单，人工仅快速复核 3 项（阅读顺序是否串行、表格是否错行、核心公司/时间段是否丢失）；
3. **Tier B（30 份核心难例集，5 类岗 × 6 份）—— 1.5–2 小时极简 3 字段标注（支持多解区间）**：
   ```json
   {
     "file": "tier_b_borderline/backend_03.pdf",
     "target_role": "backend_senior",
     "acceptable_bands": ["borderline", "pass"],
     "sample_type": "plain_strong_anti_fn",
     "must_catch_points": ["真实主导高并发订单链路重构", "简历表述朴实但有线上排障归属，不可字面误杀"]
   }
   ```
   - **多解标尺原则**：明显过线标 `["pass"]`、明显不符标 `["reject"]`、真实招聘本就有争议的擦线简历允许标区间 `["borderline", "pass"]` 或 `["borderline", "reject"]`，避免强行单选导致标尺本身失真；
   - **一鱼两吃**：这 30 份 Tier B 必须包含至少 **6 份“朴实真干活防误杀样本”** 与 **6 份“华丽空洞水分样本”**，同时直接兼任 §13.1 的 **L3 裁判人类校准集**（用于计算 Cohen's $\kappa$ 与 TNR），零重复标注。

### 14.2 改动影响分层触发矩阵（Change-Impact Routing）与耗时预算
杜绝“太慢没人跑”或“全靠手动漏跑”，整套评测按 4 档运行：

| 档位 | 触发时机 | 执行范围 | 耗时与成本预算 | 门禁策略 |
|---|---|---|---|---|
| **G0：PR 必跑快门** | 每次 Commit / PR | L1 确定性代码硬闸门 + `corpus-manifest.test.ts` + 全量单测 + `eval --mode=deterministic`（零 LLM） | **≤ 2 分钟 / 0 Token** | **硬阻断**（任一失败即红） |
| **G1：模块改动定向门** | PR 触碰特定目录 | • `converter/` 或 `material-content.ts` → **Stage 1**（公开 PDF + Tier A）<br>• `skill/s6..s10` 或 `agent-turn.ts` → **对应 Stage + 横切对话层**<br>• `domain/booking-invite` / `scorecard-draft` / `criterion-override` → **对应 Stage 交接用例** | **3–8 分钟 / 低 Token** | **回归池硬阻断；能力池仅报差异** |
| **G2：发版前全链门** | 发版前 / 重大重构 / 换接模型 | 全部 6 阶段 + 横切层（74+ 例）+ 私有真简历库 Tier A/B/C + L3 已校准裁判 + 核心用例 `pass^3` | **15–30 分钟 / 固定发版预算** | **L1 100% + 回归池 100% + L3 达标放行** |
| **G3：上线后周度飞轮** | 生产环境每周定时 | PG 真库 SQL 聚合四大生产北极星（纠偏率、草稿修改率、确认卡接受率、撤销率）+ 抽样高频失败 Trace 回流能力池 | **纯 SQL < 5 秒** | 刷新 `#/settings` 评测健康度并驱动迭代 |

---

### 前置研究收口确认（Ready for Phase 1 Code Implementation）
至此，评测体系的 **行为约束铁律（§0）**、**6 阶段漏斗全景（§二）**、**双态进化架构（§六）**、**6 大真实素材实证目录（§八–§十一）**、**5 块框架底座契约（§十二）**、**L3 裁判校准与 Stage 1/5 数学指标（§十三）**、**极简标注/多解标尺与分层触发矩阵（§十四）** 已全部闭环锁定，可零返工进入 **Issue #63 Phase 1（框架代码与私有简历盘点脚手架）** 实施。
