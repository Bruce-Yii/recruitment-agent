# 42. 产品级全链路漏斗评测体系架构（End-to-End Funnel Eval System）

> **状态**：权威升级基线（2026-11-22，总控修订）  
> **定位说明**：PR #59 落地的 18 例对话侧评测仅覆盖横切对话层（约占总评测面的 15%）；本文档将评测体系升级为**与产品总链路 1:1 等大的全生命周期漏斗评测体系**——**项目有多大，评测就应该有多大**。

---

## 一、2026 年 10–11 月生产级 AI 产品评测行业共识

结合 2026 年 10 月下旬至 11 月中旬的最新一线工程实践，合格的 AI 产品评测体系必须同时满足五条铁律：

1. **不只测“最后一轮回复”，必须测完整执行链路与状态副作用**：据 [Gamut (2026-11-04)](https://www.gamut.so/blog/ai-agent-evaluation-guide) 引用 LangChain 2026 报告与 Stanford AI Index 2026，约 89% 的企业 AI Agent 未能进入稳定生产，仅 52% 团队做了离线评测、仅 37% 做了线上生产评测；核心原因是把评测简化成“单轮问答打分”，忽略了规划、工具调用、上下文传播与数据库副作用。
2. **组件/步骤级 × 序列交接级 × 端到端漏斗级，三层缺一不可**：
   - [Openlayer (2026-10-27)](https://www.openlayer.com/blog/agent-evaluation-complete-guide-testing-ai-agents) 明确指出生产中工具调用失误率在 3%–15% 之间，且大量故障属于 **Sequence-level monitoring gaps**（每一步单独看都合法、Schema 全过，但串起来把下游依赖状态写坏了）；
   - [DeepEval (2026-11-12)](https://deepeval.com/docs/evaluation-component-level-llm-evals) 与 [HatchWorks (2026-11-06)](https://hatchworks.com/blog/ai-agents/ai-agent-evaluation-frameworks/) 强调必须对 Trace 中的每个 Span/组件独立打分，同时追踪端到端完成率，出问题才能 1 秒归因到具体环节。
3. **能力集（Capability Suite）→ 回归集（Regression Suite）双轨演进 + 全改动触发**：据 [Unicrew (2026-11-05)](https://unicrew.com/blog/how-to-evaluate-ai-agents/)，难例攻克后即晋升为回归门禁；任何对 Prompt/工作说明书、工具定义、解析器、检索索引或业务 API 的改动都必须触发对应层级评测（2026 行业仅 15% 团队真正做成 CI 发布门禁）。
4. **数据集按“故障代价”而非“出现频率”加权**：[Openlayer (2026-10-27)](https://www.openlayer.com/blog/agent-evaluation-complete-guide-testing-ai-agents) 建议起步规模不少于 50+ 样本并持续扩充（约 50% 主路径 / 25% 边界异常 / 15%–35% 隐私与越权对抗 / 10% 下游故障降级），像隐私泄露、越权落库发拒信这类高代价故障必须重权重覆盖。
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