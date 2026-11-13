# 20｜个人开发者 Recruitment Agent 全链路功能 Demo｜并行实现计划（2026-11-13 修订）

## 0. 本次纠偏与效力

**本版替代该文件此前“必须拉真实会议、两名真实面试官、企业授权条件全部满足才允许做 Demo”的派发。**

源自第二大脑：
- [项目主档](https://app.notion.com/p/4121e795caee81a78a87d5580c2c2f44) §06：短期可运行 Demo；个人开发与权限受限时使用清楚标记的模拟／人工导入降级路径；不得把产品缩成简历筛选器。
- [Master PRD](https://app.notion.com/p/4151e795caee81c9acd3ded98853efb9) §04/§07/§13：完整设计与分阶段开发分开；Job、Intake、Screening、Scheduling、Transcript、Scorecard、Evaluation、Decision 属同一招聘链路。
- [DSH Web Host 架构](https://app.notion.com/p/4161e795caee81778f71d14e34b6f1b9) §1/§4/§7：DSH Web + 一个 Recruitment Bundle/Plugin；复用 Client Slots / Tools / Agent / Workflow，不起第二套宿主。

**用户的实际目标：简历层（Issue #3）保持深度；其他阶段先实现最少必要功能，业务上真正连起来。独立面评就是一个功能，不是单独的大系统。** 每个功能必须真实可用、能写入/读取数据库；不要求个人开发者找真实企业、HR、用人经理、两位真人面试官或生产组织权限来完成首轮本地 Demo。

原有仓库 v1.0 正式产品验收（包括 Feishu LIVE）不自动废除，但**“个人开发者本地纵向 Demo”与“完整 v1.0 外部连接器验收”分成两个清晰 Gate**，不得互相冒充通过。

## 1. 开发约束与复用对象

唯一开发仓：Bruce-Yii/recruitment-agent。旧 Recruitment-OS 只读；不可因本轮修改重建旧 runtime。基础：DSH Web/profile、@recruitment/dsh-recruitment 插件、PostgreSQL recruitment schema；现有的 Job、Application、Interview、Meeting、Transcript、Scorecard、Decision 表和契约优先复用。

- Issue #1 / PR #2 负责 S6→S7 身份、结构化版本、初筛、Job Get、共享 DB/CI；不抢改。
- Issue #3 负责简历 Reader、多格式、质量、结构化恢复；继续深度推进。
- 本 Issue #4 负责**其他薄而真实的业务功能与统一 Demo 编排**。优先完成代码与真实用户操作，禁止再研究一轮大 PRD、增加不必要的平台/微服务/复杂权限。

**“轻”指少字段、少流程分支、少界面、一个岗位/一名候选人/一场面试的 Golden Path；不指虚构操作成功。**

## 2. 一条纵向可点击的业务路径

用户用自己的**本地开发/演示身份**，在 DSH Web 中完成：

1. **S3 Job / Rubric**：创建或选择真实岗位及一份最低可用 Rubric，看到生效版本；Agent 可读其具体标准。
2. **S6–S7 简历→候选人与申请→Agent 初筛**：连接现有 #1/#3 可信结果。展示引用、缺口和需要人确认的初筛建议；用户确认正式筛选动作。
3. **S8 安排面试**：对这条 Application 创建一场 Interview、输入约定时间与会议关联（可先手工录入真实或演示 meeting 标识；界面准确显示来源），保存后可查。
4. **S9 面试材料**：支持两条同一 Domain 路径：① **飞书 Connector** 经官方 API/CLI 实际读取授权妙记（可用时）；② **人工导入** TXT/现有转写文本，标记 MANUAL/IMPORTED，用于个人开发者完成整条本地业务 Demo。两者统一转为 TranscriptArtifact/Segment、生成中性 Interview Record 与证据引用。**② 不能宣称①已接通。**
5. **S10 独立面评**：实现 Scorecard 新建/提交/读取功能；用两个不同的**演示 Actor 身份或独立模拟角色账户**分别通过 UI 输入独立评价（可以同一名开发者操作两次），记录作者与 Rubric 版本，互不覆盖、不让 Agent 代填。
6. **S10 汇总与决策**：Agent 汇总两份评价的差异/证据/未核信息；用户通过实际的人类确认动作填写并保存正式 Decision；下一步/当前进度可从 DB 读回。

**最简 UI**：在 DSH Web 中用一个主流程工作视图显示六段完成状态、业务对象、关键证据、待处理动作、下一步入口；详细表单在侧栏/详情页。Agent 可用自然语言完成允许的动作，用户可以直接从 UI 操作。无需一次做完整 ATS 工作台。

## 3. Feishu 真功能与个人可用资源：两条验收线，不能混淆

**必须开发** Feishu Minutes Connector 真正的 API/CLI 适配，支持参数化认证、授权检查、依据真实 minute_token / meeting_id 获取转写、分页/完整性与状态处理；不要用 Fixture 实现假 Connector。先读本地现有 CLI、官方接口与 docs/04-connectors-and-transcript.md、transcript-rules.md，复用成熟实现。

- **本地功能 Gate**：真实 Connector 代码可调用且有官方格式契约/异常测试；无企业凭证时准确标 NOT_CONNECTED 或 AUTH_REQUIRED；人工导入路径与它共享同一业务实体和下游处理。因此即使个人没权限也能把整个招聘流程真实跑通（但 Feishu LIVE Gate 仍未通过）。
- **Feishu LIVE Gate（完整 v1.0 单独必测）**：有真实授权时确实从飞书取得完整妙记，并绑定真实会议、持久化、在 Web 回读、进入 Interview Record。**不能拿人工导入/fixture 算 LIVE**。个人没有凭证时此 Gate 保持 BLOCKED，不因此停止其他功能开发；W0 必须精确给出普通个人可执行的认证/试通步骤，而非要求“提供企业管理员、真人面试官、正式企业招聘账号”。
- 支持生成中/无权限/来源关联歧义/未取全等有业务意义的错误，分别 WAITING_EXTERNAL、AUTH_REQUIRED、NEEDS_LINKING、PARTIAL；不随意编造外部标识。
- 默认**不做**真实事件订阅、多平台同时接入、自动创建日历事件、发送外部通知、生产级 OAuth 管理后台。真实飞书连接的接口/适配必须存在，自动化程度随后提升。
- “人工导入”是产品允许的**真实功能降级路径**，不是静态演示页面。用户导入的文字是原始输入，处理和 PG 记录都要真的运行。

## 4. 任务分工：功能薄切片，不把每个小功能造一个项目

| 并行 Lane | 已有依赖 | 本次交付 | 不做 |
|---|---|---|---|
| D1：Job 与 Rubric | #1 job_get / DB | 最小岗位编辑/标准确认、实际读取、版本引用 | 需求审批、模板平台、复杂企业组织 |
| D2：Interview | 现有 S8 契约/表 | create/get/时间与会议绑定、一条合理流程状态 | 自动多人日历协调、复杂改期策略 |
| D3：Transcript | 现有 S9 契约/表 | Feishu API adapter + 手工导入原文 + Interview Record，**同一落库和证据链** | 自研 ASR、三会议平台、强迫外部权限前置 |
| D4：Scorecard / Decision | 现有 S10 契约/表 | 独立 Scorecard 提交、汇总、人工确认后落 Decision | 真实招募多名面试官、复杂 HR 组织管理 |
| D5：DSH Web / Agent 集成 | D1-D4、#1/#3 | 一屏进度/待办/证据/动作、跨阶段真实 tool trace，刷新读回 | 新建独立 Web 壳、漂亮但无业务的卡片 |

D1–D4 可并行，W0 唯一管理共享 src/index.ts / cordis.patch.yml / profile / Skill / DB migrations / Web 插件入口。优先新增文件和复用现存结构，不能由多个子代理同时改共享文件；#1/#3 的实现不因本任务打断或重写。子代理不必各自设独立 Issues，均向本 Issue #4 汇总。

最重要的工程原则：**一个功能作为一个招聘业务能力实现即可，数据库已有对象和 DSH 能力直接复用；不要为“独立面评”设计新平台、新服务或额外运行时。** 同一个人使用两个明确隔离的演示账号/Actor 测功能，不代表生产身份认证已完成。

## 5. 分层交付与验收（防止 Demo 永远做不出来）

**A｜本地个人开发者 Golden Path（当前优先）**：
- 用合成简历、一个真实写库的 Job、一个本地 Interview、人工导入的一份转写原文、两个独立 Actor 的 Scorecard、一次用户确认 Decision 走完 S3→S10；
- 必须从 DSH Tool/Web 真实可调用，每阶段读写正确、同一 Application 贯通、页面刷新保留结果；
- Agent 的关键理解/结构化在真实模型中运行，不能靠确定性脚本冒充 Agent；
- 人类动作确实由用户在 UI 做，不靠模型假填。
- 若 S6 的 #1/#3 Gate 尚未完成，允许并行开发其他阶段，但**不能宣称整个 Golden Path 已通过**。

**B｜飞书 LIVE 集成 Gate（原正式 v1.0 P0，未更改）**：
- 有真实 Feishu 资源/授权时，从官方 API/CLI 获取真实妙记并完成同一后半链路；
- 无资源时报告可复现的 API 路径和准确 NOT_CONNECTED/AUTH_REQUIRED，**保留 B 为 BLOCKED**，而不是阻塞 A 的功能开发，也不是将 B 降成可选的“虚构成功”。

**独立 Review**：W0 报具体分支/commit、真实入口、原始 passed/failed/skipped、PG 查询读回、Web 的实际操作与刷新、A/B 两个 Gate 独立状态、未实现细节。不能因为完成了多个模块或测试绿，就自报端到端通过。

## 6. W0 收到后立即行动

1. 在本 Issue 先公开更正此前“外部资源必须齐备才开工”的错误；核对 #1/#3 当前修改与现有 S3/S8/S9/S10 业务对象，冻结 D1–D5 文件所有权，保持各自独立工作区。
2. D1–D4 **立即并行实现功能**，D3 同时核实 Feishu 官方接口+用户实际可用连接方式；即使没有凭证也不得停止功能开发，不能因“没有两个真人面试官”停下 D4。
3. W0 整合 DSH Web，做一条本地端到端流程并独立读回；下一阶段再以真实授权证明 Feishu LIVE。
4. 不得擅自要求用户购买企业服务、建立多用户公司、申请大量权限，除非实验证明某项官方 API 确实需要且已提供成本与其他兼容路径。
5. 全部开发状态以代码与外部证据判断，后续问题在本 Issue 收口；**不再因本次纠偏另建 Issue**。

以上修订覆盖本 Issue 此前将“个人 Demo 完成”与“Feishu LIVE 资源齐备”捆绑的指令；不更改 Master PRD 中长期方向，也不伪称完整 v1.0 已验收。
