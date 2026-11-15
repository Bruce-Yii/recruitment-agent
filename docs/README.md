# Recruitment OS · 本地交接文档集

**更新时间**：2026-11-12（2026-11-16 补 v1.0 验收基准唯一指针 D-122）
**依据**：Notion 主档 + 01–12 + PRD（全部逐字读过）、GitHub `docs/00`–`docs/15`、ADR-0001…0006、Issue #112、W3 独立审计。
**原则**：不压缩、不含糊、不编造。每条实质结论标来源；文档之间冲突时显式指出，不抹平。

---

## 阅读顺序

| # | 文档 | 回答什么 |
|---|---|---|
| **07** | [**PRD**](07-PRD.md) | **产品要什么**：带需求编号（FR-R/J/I/C/P/S/N/V/O/T/X）、优先级、验收要点、归属模块、追溯矩阵的正式需求文档 |
| **01** | [业务链路](01-business-lifecycle.md) | **招聘全链路怎么走**：12 阶段逐阶段（触发→对象→Agent 动作→人工决策→产出→事件→异常→归属→v1.0） |
| **02** | [架构与模块](02-architecture-and-modules.md) | **系统怎么分层、代码落在哪**：10 层、组件边界、七个包、窗口归属、三维映射 |
| **03** | [领域与运行时](03-domain-and-runtime.md) | **有哪些对象、怎么保证正确**：34 对象、状态机、五事实分离、Task/Attempt/Effect、并发与恢复 |
| **04** | [连接器与转写](04-connectors-and-transcript.md) | **外部系统怎么接、会议转写怎么拿全**：14 连接器、4 级降级、三平台字段、31 步链路 |
| **05** | [产品要求摘要](05-product-requirements.md) | **PRD 速查版**：8 类接入、批量与自动初筛、采纳闭环、版本路线 |
| **06** | [治理、验收与现状](06-governance-and-current-state.md) | **怎么算完成、现在到哪**：审查规则、E1–E4、决策台账、当前状态、引用白名单 |
| **08** | [Golden Path 运行手册（HISTORICAL）](08-DEMO-RUNBOOK.md) | ⚠️ **老仓 monorepo 底座**的运行手册（pg-boss / `integration/v1.0-flow` / 1106 测试）。那套底座已废弃、**已归档**，**不要照它跑**（D-122）。现行手册见 **18** |
| **16** | [**设计理由**](16-design-rationale.md) | **为什么这么设计**：为什么基于 DSH、转换层为什么是四件套、为什么先带 id 序列化、为什么放弃词表拟合、v1.0 为什么不做权限、踩过的两个坑、被否掉的方案 |
| **18** | [**v1.0 Golden Path（DSH 版）**](18-golden-path.md) | **现在怎么跑**：底座四层、6 个在范围内的阶段、8 步链路、每步写哪些表与要什么证据、当前真实状态（含 ❌/🚧/⛔）、最可能卡住的地方 |
| **21** | [**Agent 工作方式**](21-agent-operating-model.md) | **我们怎么干活**：总控定位与独占写范围、复用优先硬规则、两层模块委派（Owner 必须再派并发子代理）、**浏览器驱动验收协议**、动态结构必须表单化、实验记录规范、本地远端同步、真实数据门槛与 PII 边界 |
| **09** | [**DSH 插件化落位**](09-dsh-plugin-architecture.md) | **哪些能力做成工具、哪些必须留确定性服务**：DSH 三层插件机制实测、已装能力、插件市场候选、PDF/Word 解析方案、落地三步 |
| **10** | [**复用简历项目转换层**](10-conversion-layer-reuse.md) | **PDF/DOCX 到底怎么读**：最新转换层（`codex/conversion-integrated-20261022`）的读取契约、PDF 原生+Layout 只取几何、扫描件不 OCR 造事实、我们采用与不采用的部分 |
| **11** | [**PDF 转换器验收标准**](11-pdf-acceptance-criteria.md) | **转换器怎么算合格**：六维判据、分层门槛、6+4 条红线、招聘特有的归属/三态/可回溯要求、13 项可执行清单 |
| **12** | [**分层验收**](12-layer-acceptance.md) | **兜底机制怎么验**：可检验/可观测/模型兜底/人工兜底/系统治理五层的故障注入矩阵、每层判据、账平不变量 |
| 附 | [人话版场景](04-scenario-plain-language.md) | 给非技术读者的一次完整招聘故事（已按边界修正） |

> `work/control/PROJECT-ALIGNED-SPEC.md` 是速查版；**本目录是展开版，冲突时以本目录为准。**

> **v1.0 验收基准（唯一指针）**：`docs/17-decision-ledger.md` **D-122**（C1–C3 收口）——运行底座 = DSH Web 宿主 + PostgreSQL（无自建队列，D-109）；真实飞书是 P0，Fixture 不作验收证据；验收对象 = Notion 06 P0 15 项 + PRD §15 + 06 §08 + 07 §11 + 10 §10（均为 Notion 页节号）；旧 Golden Path 9 步/13 场景已归档。

---

## 三个必须先建立的前提

### 前提 1：这是企业内部系统

产品使用者 = **6 类**：企业管理员 / 招聘负责人·HR 主管 / HR·招聘专员 / 用人部门·Hiring Manager / 面试官 / 审批人。
**候选人不是使用者，是外部参与者 + 业务对象**——系统处理其资料、面试、评价，但**不提供候选人入口**，不建公开求职平台。

### 前提 2：系统承载"状态与落点"，不承载"沟通"

审批、岗位校准、标准讨论，都是**人线下自己沟通**。系统只做三件事：把信息**备好备全**、把待办**放在正确的人面前**、记住**批的是哪一版、谁批的、什么时候**。
> 把它做成协作工作流/催办链，就是把它当成了通信系统——那是错的。

### 前提 3：设计做全，交付做穿

完整设计（12 阶段、34 对象、六层配置、并行分支）**保留不删**；v1.0 只交付**穿过阶段 3→10 的一条垂直切片**。
> PRD 与既有文档的差异，绝大多数是**早期降级实现**，不是设计被否定。

---

## 术语统一（不统一就会全程混乱）

| 概念对 | 边界 |
|---|---|
| Candidate / Resume Version / Application | Candidate 是人；Resume Version 是某份材料不可覆盖的版本；Application 是人针对某岗位的一次独立招聘旅程 |
| Requisition / Job / Job Posting | 招聘需求（为什么招、几个、谁批）/ 岗位定义与标准 / 某渠道的发布实例 |
| Pipeline Template / Pipeline Instance | 模板更新**不静默改写**在途申请 |
| Interview / Meeting | 面试业务实例 / 外部平台的实际会议；1 Interview : N Meeting |
| Transcript / AI Summary / Interview Record / Scorecard | 原文 / 摘要 / 客观结构化事实 / 面试官主观评价；**原文不可被摘要覆盖**，四者独立状态 |
| Business Task / Task Attempt / Agent Session / Chat Thread | 工作义务 / 一次执行 / 运行时上下文 / 交互单元；**四者不一一绑定** |
| Business Approval / Execution Mandate | 人批业务动作 / Agent 被授权执行技术动作；**两套并行，不互相替代** |
| Channel / Source（技术接入） vs Candidate Acquisition Source（来源归因） | 前者是 Connector，后者是"这个人从哪个渠道来的"，不是同一字段 |
| 「方案 B」/「基础执行底座」 | 同一个东西两种叫法。**Notion 只用后者** |
| Product release / WP / Gate / Wave | 可用业务增量 / 工作包 / 依赖释放阀 / 工程集成顺序；**四者互不等价** |
| fallback 降级 / 简化 | 渠道 L1–L4 降级 ≠ v1.0 范围降级；不要混用同一个词 |

---

## 物理落位

- 本仓库（新）：`D:\12412\dsh工作区\projects\recruitment-agent`（GitHub `Bruce-Yii/recruitment-agent`，私有）
- 旧仓库（**冻结，只读参考**）：`D:\12412\dsh工作区\archive\recruitment-os`（2026-11-14 已移入 `archive/`），`main@6bcfc70`，**不要在里面开发**
- DSH_HOME：`D:\12412\dsh-home`；产品 profile = `profiles/recruitment`（DSH Web）
- 过程产物：仓库内 `work/`（已 gitignore，不入库）
- 总控行为约束：旧仓根 `AGENTS.md`（八条铁律 R1–R8），本项目继续沿用
- 决策台账：**`docs/17-decision-ledger.md`**（入库，唯一权威源）；旧仓 `work/control/` 仅作历史

---

## 来源标记

`逐字` = 原文引用；`【推断】` = 我的判断；`【待核】` = 未独立验证。
主要来源：Notion 主档（`4121e795-caee-81a7-8a87-d5580c2c2f44`）、01（`4377db3d…`）、02（`2ada1795…`）、03（`091b3a3e…`）、04（`747a0ed5…`）、05（`ad68a69e…`）、06（`fb3111b1…`）、07（`4121e795…815d…`）、08（`4121e795…81c3…`）、09（`4121e795…816d…`）、10（`4121e795…8197…`）、11（`4121e795…81b1…`）、12（`4151e795…8125…`）、PRD（`4151e795…81c9…`）、W3 审计（`4141e795…818b…`）。
