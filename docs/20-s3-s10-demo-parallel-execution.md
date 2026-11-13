# 20｜Recruitment Agent S3–S10 最小真实闭环：并行实施令

日期：2026-11-13。最新用户裁定优先：**简历层继续深做；其他模块并行、做得不必同等精细，但整个 Demo 必须真正跑通。飞书真实转写是 P0，不能用 Fixture 代替验收。** 精简的是功能数量、复杂配置与长尾覆盖，不是数据真实性、端到端接线或人类确认。

唯一开发仓库 Bruce-Yii/recruitment-agent；旧 Recruitment-OS 只读。宿主只能是 DSH Web/profile，工具扩展采用现有 @recruitment/dsh-recruitment，业务事实落 PostgreSQL recruitment schema。禁止造第二套 Agent Loop、独立 HR Web Shell、微服务平台、通用队列。

## 1. 一个可演示的核心用户流程

HR 在 DSH Web 的一个工作视图中可见同一 Application 的流程、完成状态、证据和下一步操作；允许细节在侧栏/抽屉中展示，不要求所有细节硬塞到一个屏幕。

S3 Job/JD/Rubric（真实且有版本）
→ S6 可信简历接入/Candidate/Application（复用 Issue #1/#3）
→ S7 Rubric+证据化初筛，HR 真正确认
→ S8 安排一轮面试/至少两名面试官/真实飞书会议绑定
→ S9 **真实飞书会议妙记全文读取、保存原文、Interview Record 引用**
→ S10 两份真正独立的面评、评价差异/缺口汇总、HR 正式决策入库。

目标样本：一个真实存在的 Job、一个合成候选人、一场真实飞书会议产生的真实妙记、两位授权面试官、一个真实的人类决策。**合成候选人是演示数据，真实飞书连接和原文读取是外部系统真实性测试**；来源标签分别记录，绝不混为 LIVE 候选人。

Agent 从自然语言理解目标并调用真正招聘工具；既有 DSH Web 工作台可见阶段和需要人接手的动作。刷新后必须能从 PG 查回同一条业务事实。不能靠预制 HTML 卡片或者固定脚本模拟已完成工作。

## 2. 直接复用已存在的代码与合同

- docs/01-business-lifecycle.md：12 阶段，初版 S3、S6、S7、S8、S9、S10。
- docs/07-PRD.md FR-J/FR-S/FR-N/FR-V：Job、筛选、面试、转写、面评、人工决策。
- docs/18-golden-path.md：八个真实动作、PG readback、人类闸门。
- dsh/dsh-recruitment/contracts/interview/scheduling-rules.md、tool-contracts.md、transcript-rules.md：现成 S8/S9 规则，不能重写一轮。
- dsh/dsh-recruitment/contracts/evaluation/scorecard-rules.md、decision-rules.md、tool-contracts.md：现成 S10 规则。
- db/migrations/ 和 db/SCHEMA.md：已有领域表，不另建影子数据库。
- Issue #1 / Draft PR #2：正在统一修复 S6/S7 身份与版本 + job_get + CI；本工作包不能抢改同文件。
- Issue #3：简历层深度实施，U0/U1/U2 已派发；仍按原计划推进。不要重复做简历解析。

仓库 docs/18 目前明确 S8/S9/S10 工具尚未实现，PRD v1.0 明确飞书真实转写为 P0。**本次要交可运行工具而不是又写设计文档**。

## 3. 五条并行 Lane，W0 单独掌管集成

### D1 / S3 Job 与 Rubric
Owner：一个子代理。独占新增 src/domain/job-rubric/ 与必要新工具文件。复用 Job/Rubric/JobVersion 现有表和 #1 的 job_get 改造，不得同时改 job-get.ts。实现最小岗位查看、创建/选用与 Rubric 修改/人工确认版本；Agent 能引用真实生效标准。不要做需求审批、Posting、模板库大后台。验收：一个岗位与两版标准的真实 DB 行；应用绑定旧版不被静默改写；PG readback 和真实工具入口。

### D2 / S8 Interview 排期
Owner：一个子代理。独占新增 src/domain/interview-scheduling/、src/tools/interview-*.ts，不改插件入口和 DB migration。沿用原有 tool-contracts / scheduling-rules；实现 interview_get 与 interview_schedule 的最小 CREATE/RESCHEDULE/CANCEL，至少两位面试官、时区/冲突校验、Meeting ID 真实绑定。业务状态落真实 PG；不能仅返回假日程；外部日历事件创建不是本次强制，不能声称已发邀请。需要人审批的动作复用 DSH approval seam，fail-closed。

### D3 / S9 **真实飞书转写，最高优先级立即开工**
Owner：一个子代理。独占新增 src/connectors/feishu-minutes/、src/domain/transcript/、src/tools/transcript-*.ts，不动公用插件入口或迁移。先验证本机 Lark CLI/授权账户/官方 API 能用，优先复用现有 CLI/MCP；按照 docs/04-connectors-and-transcript.md §13–§21 与 transcript-rules.md 实现真实 Feishu Minutes 文本获取、完整性校验、录制/妙记与 Meeting ID 绑定、原文及 segments 的不可变持久化、Interview Record 的证据引用。严禁自研 ASR。

**真实 LIVE 最短路径**：真实存在的飞书会议 + 其真正的 minute_token（首次可手工提供 token 作触发）→ 通过官方授权 API/CLI 实际拉回全文（而非人工粘贴/Fixture）→ 保存原文/版本/来源 → 面试记录。再争取用官方 minutes.minute.generated_v1 事件自动触发；事件不可用则明确标 MANUAL trigger，不冒充 EVENT。手工给真实 token 与手工造 transcript 是两回事，后者绝不通过。

飞书错误：2091003 生成中→WAITING_EXTERNAL+有限重试；2091005 权限不足→AUTH_REQUIRED；Meeting/Minute 歧义→NEEDS_LINKING；分页/Artifact 未取全→PARTIAL，不是 READY。原始转写与 AI Notes 不可混合；同源同 revision 重放幂等，新 revision 单独存版本。必须出真实响应的脱敏证据、访问控制、source revision/hash、完整性状态。

**飞书 P0 Gate 不得豁免**：从真实 Feishu 获取并正确绑定的转写被 DSH Agent 处理、保存、在 Web 展示和用于面试记录。Fixture 只可跑局部测试；即使所有代码测试通过，只要无 LIVE 飞书取数，整个 Demo 标 NO-GO。权限缺失要列出精确平台授权请求/所需人类操作并继续做其他 Lane，不得装作已连通。

### D4 / S10 独立面评、汇总、正式决策
Owner：一个子代理。独占新增 src/domain/evaluation/、src/tools/scorecard-*.ts、evaluation-*.ts、decision-*.ts，复用既有严格契约。两位面试官独立提交各自 Scorecard，作者只来自真实执行/审批身份，Agent 不得代填；面评可与转写处理并行。Evaluation 只归纳证据、分歧、缺口，绝不输出冒充人做出的最终决定。正式决策必须由人通过 DSH approval seam 确认并落 PG，审计版本+人+时间+理由；缺必需面评不允许借人工确认旁路完成终局拒绝。

### D5 / DSH Web「一屏贯穿」与最终集成
Owner：**W0 唯一负责**。仅 W0 可修改共享 src/index.ts、cordis.patch.yml、profile/Skill、共享 DB migrations、Web 扩展、Golden Path Runbook。复用 DSH Web 原有扩展点打造一个简洁流程视图：岗位/候选人/初筛/面试/转写/面评/决策当前状态、证据定位、待人工动作、下一步。Web 按数据库事实呈现；从工作台能真正触发 Agent 与人类动作并刷新恢复，不要求豪华界面。

## 4. 并行和依赖控制

D1/D2/D3/D4 **同时开发，各自独立 worktree/branch**，先冻结代码所有权与基线，不能同改数据库、插件入口、同一现存工具。D3 真实飞书授权 smoke 放第一优先，越早发现权限问题越好；但其他线不因等待飞书授权而停工。D5 W0 可以同步做 Web 视图原型与只读读数，正式接线必须按 #1 的身份/版本合同、#3 的可信 Reader G1 结果完成。D1 如与 #1 的 job_get 文件冲突，隔离新领域模块后由 W0 唯一整合。禁止另开多个重复修复 Issue。

W0 先回帖记录各子代理 Owner、worktree、起始 SHA、目录互斥清单、已有代码复用、飞书账号/CLI/权限实际可达性及首个可运行命令，然后直接编码。不能用“还需要再研究 3 天”阻止执行；契约已存在。

## 5. Demo 交付 Gate

G0：复核 Issue #1/#3 当前分支与有效契约 + 权限，登记所有独占文件；各子代理开始编码。

G1：D1 Job/Rubric、D2 排期、D4 面评/决策的单模块工具**从 DSH 真实可调用**，PG 读回；D3 必须实际从授权飞书 API/CLI 取到一份真实转写，未取到则标 AUTH_REQUIRED/NO-GO。

G2：W0 将工具合并到同一 recruitment profile，真正用 PG 数据跑 S3→S10；真实飞书原文关联 Meeting/Interview 与 Interview Record；两位面试官分别提交；有权限的人正式审批决策；每个阶段对同一 Application 有证据。#1/#3 未完成的部分不能以“已通过”标注，允许先并行开发再集成。

G3：在**DSH Web 浏览器会话**一个主工作视图逐步展示流程和待办，可操作、刷新后读回，不是仅 headless；真实 Agent tool traces + SQL readback + 飞书 LIVE 脱敏原始响应，全部同一个真实场景。分别标注 provenance=LIVE/FIXTURE、trigger=EVENT/MANUAL、connection=CONNECTED/AUTH_REQUIRED；外部能力不造假。

硬性负例：Rubric 新版不篡改旧申请；时区/冲突/重复排期不误入库；飞书错误权限/生成中/重放/转写缺页不变 READY；错会绑定不猜；面评作者不伪造；未审核不落正式决策；模型不得以 unreadable 做拒绝依据；浏览器不操作业务只显示假状态不得过 Gate。

每个 Lane 回传 commit、文件列表、可复跑命令、passed/failed/skipped、SQL 实际行（敏感字段脱敏）。D3 附真实飞书授权读取响应及 minute_token/meeting binding 脱敏指纹；D5 附浏览器执行和刷新后的证据。只有真实 LIVE 飞书全链路和其他 P0 全过，才称“Recruitment Agent v1 Demo 已跑通”。

## 6. 刻意不做（只删复杂度，不删真实性）

S1/S2 需求审批、S4 自动发布、S5 外部寻访、S11 Offer、S12 人才运营暂缓；不做多平台会议、生产级企业权限控制台、全量多租户 SaaS、复杂跨时区排期优化、几十人并行面评、复杂邮件/日历自动发出、BI 仪表板。之后版本可补，不影响单场真实招聘流程。

最终回传必须是单条 W0 consolidated return：准确 commit/PR、每个阶段真实运行状态、飞书 LIVE 取数及原文证据、DSH Web 可走通的最短路径、人工闸门、失败分支、实际尚未完成事项。**不允许把部分实现包装为全链路完成。**
