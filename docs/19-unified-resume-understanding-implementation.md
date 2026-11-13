# 19 · Unified Resume Intake & Understanding｜实施规格与本地 W0 派发包

**日期**：2026-11-13
**状态**：用户已要求进入实施；本文件是新简历层工作包的工程规格，不是“已经实现/已验收”的声明。
**仓库**：Bruce-Yii/recruitment-agent（唯一写入仓）；旧 Recruitment-OS 只读。
**依赖**：[Issue #1](https://github.com/Bruce-Yii/recruitment-agent/issues/1) / [Draft PR #2](https://github.com/Bruce-Yii/recruitment-agent/pull/2) 处理 S6→S7 的 Candidate / Application / ResumeVersion / S7 业务真相。
**产品依据**：docs/07-PRD.md FR-I1～I10、FR-C1～C8、FR-S1～S5；docs/10-conversion-layer-reuse.md、11-pdf-acceptance-criteria.md、12-layer-acceptance.md、17-decision-ledger.md D-19/D-20/D-71/D-72/D-81、18-golden-path.md；Notion《13｜DSH Web Host & Recruitment Extension Architecture》。

## 0. 目标与版本切片

目标不是“多一个 PDF 转换器”，而是：来自多个入口的一份简历材料，经过**接入归因 → 原件与类型识别 → 可信文档内容读取 → 质量 Gate / 定位补读 → Agent 语义结构化 → 独立证据验证 → 版本化业务写入 → S7 可引用初筛 → HR 可处理异常**，在 DSH Web 内形成闭环。正常文件尽量一次自动完成；失败不得冒充“简历没写”或“解析成功”。

- **本轮 R1（必须交付可运行代码）**：一个统一只读文档读取入口，真实支持文字 PDF、DOCX、PNG/JPEG；返回统一内容与证据、解析状态与明确的失败动作。现有 PDF 快速路径继续使用；DOCX / 图片先用成熟组件 PoC 后接入。必须从 DSH 注册工具入口实际调用，不止独立 CLI。
- **R2（接续 R1，不另造工程）**：质量 Gate、视觉/模型补读、模型结构化/验证、不可变版本接线、读取失败的人类处理动作；使用 Issue #1 验收后的身份与持久化契约。
- **R3（在 R2 跑通后扩充）**：DSH Web 文件导入/拖拽（优先复用原生上传能力）、批量导入与可回放任务、邮件附件一个 LIVE Connector；表单/飞书/招聘平台走同一 Intake Adapter 契约，受外部授权制约者明示 BLOCKED 而不是假装接入。
- **完整产品不缩减**：PRD 的八类入口仍在目标设计里；不要求 R1 一次接通所有第三方，R1 结束必须可独立运行和证明业务价值。

## 1. 当前事实，不重复造轮子

- 已有 Python/PyMuPDF：`converter/src/`；TS 胶水：`dsh/dsh-recruitment/src/tools/converter.ts`；`recruitment_resume_read`、`recruitment_resume_serialize`、`recruitment_structure_validate`；PDF 页面渲染和 `recruitment_model_text_merge`。
- 当前 `assertReadablePdf()` 和 S6 `recruitment_application_intake` 输入只接收本地 `.pdf`；`runConverter()` 固定调用 PDF CLI；暂不能把文档已经讨论 DOCX 当作已接线。
- 现有 `docs/11` 的 PDF 原文保真、坐标、URI、三态和误判拦截保留；现有 `docs/12` 的失败注入与账平要求保留。已有 PDF 保真缺陷（如 talent_pool-28、唐乐、tangle）不得被切换引擎掩盖。
- **不要**在这一工作包里解决 Issue #1 的 Application 身份、并发唯一约束或 S7 读写一致性；不改 `db/migrations/0009_application_identity.sql`，不重写 `application-intake.ts` / `screening-evaluate.ts`。这些由 #1 W0 的现有 Lane 完成。
- `docs/09` 中较早“PDF MCP / RapidOCR”方案是历史候选，不是必须实施的产品架构。用可测证据裁决，而非把所有候选同时装进运行时。

## 2. 目标架构及契约

```text
Sources (DSH Web local import | file drop | email | form | enterprise connector)
 -> SourceAdapter (event id, provenance, received_at, N assets)
 -> Intake/Asset (do not infer Candidate from content hash)
 -> DocumentReader (media sniff + fast parser + format adapter; read-only)
 -> QualityGate (text/ordering/URI/coverage/evidence/issue; typed decisions)
      |-- PASS ------------------------------> DocumentContent
      |-- NEEDS_REPAIR --> targeted parser / OCR or vision via existing DSH Agent
      |-- UNRESOLVED ------------------------> human attention with precise locator
 -> DSH Agent semantic structuring (different job from visual transcription)
 -> mechanical structure/evidence validator
 -> valid structured version + explicit selection [Issue #1 owner]
 -> same-version S7 / HR view [Issue #1 owner]
```

### 2.1 统一内容的最小类型（设计输入，R1 在 TS/Python 选一个 canonical schema 并实测）

```ts
type Media = "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "image/png" | "image/jpeg";
type EvidenceLocator =
  | {kind:"pdf"; page:number; bbox?: [number,number,number,number]; block_id?:string}
  | {kind:"docx"; part:string; paragraph_id?:string; table_id?:string; row?:number; cell?:number}
  | {kind:"image"; frame?:number; bbox?: [number,number,number,number]};
type DocumentBlock = {
  block_id:string; kind:"heading"|"paragraph"|"list"|"table"|"link"|"other";
  text:string; order:number; locator:EvidenceLocator;
  links?:Array<{text:string; href:string; locator?:EvidenceLocator}>;
  provenance:"native_text"|"docling"|"ocr"|"agent_read"|"human_confirmed";
};
type DocumentContent = {
  schema_version:string; asset_sha256:string; media_type:Media;
  reader_id:string; reader_version:string; reader_profile?:string;
  text:string; blocks:DocumentBlock[];
  completeness:"complete"|"partial"|"unverified";
  needs_visual:boolean; issues:Array<{
    code:string; message:string; locator?:EvidenceLocator;
    severity:"HARD"|"SOFT"; retryable:boolean;
    suggested_action:"retry"|"switch_reader"|"vision_read"|"human_review"|"none";
  }>;
  elapsed_ms:number;
};
```

**约束**：上述 schema 是对现有 `blocks/location/links/completeness/issues` 的增量统一，不要求 PDF/DOCX/图片全部伪造 `page+bbox`；结构化引用必须能指回真实 block 和原件 SHA，路径不能当业务身份。禁止只保留 Markdown 丢掉原件与定位信息。文档/解析版本不等于 Candidate、Application、ResumeVersion。

### 2.2 质量与升级行为

1. **PDF 原生文字优先**：继续 PyMuPDF 读取及原文字符、页覆盖、URI、不合法字形检查；有质量问题只标记/补读问题区域，不把 OCR 生成文本覆盖可靠原生正文。
2. **DOCX**：候选 Docling（官方多格式 DoclingDocument）；先实测段落、表格、顺序、超链接、表头与文本框。未通过证据 Gate 时返回 PARTIAL + locator，绝不假装 complete。需真正跑过与本地环境兼容再决定生产依赖。既有 resume-talent-pool DOCX 读取器可作为对照与可移植资产，不迁入旧平台。
3. **PNG/JPEG/扫描页**：工具/模型生成的文字是**待核证据**，标 `ocr` 或 `agent_read` 来源，不冒充 PDF 原生文字；特别是邮箱/电话/姓名不能直接触发自动并人。图像读取可用 Docling/OCR 候选做对照；需要视觉 Agent 时，只经 DSH 已有 Agent 和图片工具；先验证实际 model supports image。不支持就 PARTIAL/NEEDS_REVIEW，禁止换成假 LIVE。
4. **两种模型职责**：视觉读取恢复“原文写了什么”；语义结构化推导标准字段、时间区间与经历关联。二者各自携带来源、证据与校验，不根据 OCR 文本直接做最终筛选。
5. **HARD**：原文遗漏、阅读顺序不可靠、URI 丢失或凭空生成、跨区块公司/职位/时间错配、模型证据与 block 不符、`unreadable` 错判 `absent`、产出版本来源不一致。**阻断必须按受影响字段、区块、经历关系和岗位评估维度传播，而不是默认阻断整份简历**：无法可靠核实的字段保持 `unreadable / pending_review`，不得转为 `absent`、不得据此生成“不符合/拒绝”；不依赖该证据的其他已验证字段仍可结构化、持久化并在非终局建议中使用。若无法界定受影响范围或关键结论依赖未核实证据，则该筛选结论为待核，不能输出可信 PASS/FAIL。部分可信内容与未核部分的区分须可版本化和复核。
6. **可恢复的人工动作**：将“具体问题 + 原文定位/可预览入口 + 原始/候选文字 + 责任人 + 确认/修订/仍无法识别”交 HR。人工确认产生新可审计结果，不覆盖旧输出，问题解除后从对应环节继续，不重新创建 Candidate/Application。

### 2.3 采集和批量边界

所有 SourceAdapter 只产 Source Event + Intake Record/Asset metadata；不得越级直写 Candidate/Decision。邮件多附件独立为 N 条 record；同一文件多次到达事件可追溯，是否为同一 ACTIVE Application 由 #1 的强身份与 Job 规则确定，不能靠 file/content hash。批处理必须一份失败不拖垮整批，最多有限次数重试，并且 `总输入 = accepted + review_pending + rejected`，不可凭空丢件或重复建申请。

## 3. 实际可执行的工程包（W0 负责调度；不是研究提纲）

| 工作包 | 独占范围（以 W0 实际建 worktree 时登记为准） | 实现结果 | 验收 |
|---|---|---|---|
| U0 契约/测试基线 | 新增 `src/document/contracts/**`、`test/document/**`、本文件 | 定义 TS 内容类型、校验与 synthetic fixture 生成器；记录现有 PDF baseline，不修改旧逻辑 | 正常/扫描/双栏/损坏 PDF + DOCX + PNG/JPG + 重复/不一致证据测试可执行，路径跨平台 |
| U1 Reader Adapters | 新增 `src/document/readers/**`、必要时 `converter/src/document_* `，不得改旧 PDF CLI 默认行为 | MIME 内容嗅探 + PDF 既有读取器桥接 + 经 PoC 验证的 DOCX 与图片读取器；读入统一内容结果 | PDF 回归不退化；DOCX 和图像实调用产 blocks、provenance、locator；坏文件 fail-closed |
| U2 Quality/Fallback | 新增 `src/document/quality/**`、`src/document/recovery/**` 与独立测试 | 稳定 issue code、可行动作、按区段补读计划；借现有 page-image / model-text-merge 及 DSH vision，不新增模型客户端 | 6 类故障注入均真实阻断；不支持图像的模型明确 BLOCKED；输出可供 HR 直接复核 |
| U3 DSH/业务接线 | **W0 集成时唯一 Owner**：`src/index.ts`、`structure-tools.ts`、`application-intake.ts`、`screening-evaluate.ts`、profile/skill | 注册 `recruitment_document_read`（或不破坏兼容的统一工具）；自然语言使用该工具；复用 #1 的版本选择和 S7 一致性 | DSH Web 真实 tool trace；PDF/DOCX/JPG/PNG 跑通；失败字段不作为已验证事实入库；可信部分可留存且有明确待核标识；同一有效版本进入 S7 |
| U4 入口/后台 | 等 U3 Gate：DSH Web 原生导入/上传优先，必要时最小 Web Slot；邮件 SourceAdapter/批量执行 | 手动导入能使用；邮件需真实授权才能称 LIVE；批量独立状态与重放 | Web 上传后刷新可查；多附件/失败/重复/重启对账；未授权外部入口如实 NOT_CONNECTED |

**并行规定**：U0、U1 的 PoC、U2 的故障用例可以用三个独立 worktree 并行；它们只写各自新目录。U3 必须等 #1 对身份/版本/应用工具的写入契约稳定，再由 W0 单人集成，不允许两个 Agent 同时修改 `application-intake.ts` / `src/index.ts` / DB schema。U4 的 Adapter 设计可提前做，LIVE 接线不抢 U3。

**依赖优先**：U0 → U1 + U2 → U3 → U4。不为了并行把尚未明确的接口抢着实现。只需一条新工程 Issue（简历层）；不要把 U0–U4 各建一个 Issue。

## 4. 解析候选决策（先对照，后集成）

- **保留**现有 PyMuPDF PDF 快速路径和 PDF 证据校验资产。
- **第一个多格式 PoC**：Docling（原生 DOCX/图片支持及统一 DoclingDocument）；优先验证实际本机 CPU/依赖、版本与 License、输出映射成本。官方：https://github.com/docling-project/docling；支持格式：https://github.com/docling-project/docling/blob/main/docs/usage/supported_formats.md
- **轻量对照**：MarkItDown 仅作文本与表格可读性 baseline；不默认把它的 Markdown 作为证据来源。官方：https://github.com/microsoft/markitdown
- **复杂布局/扫描专门对照**：MinerU 与 PaddleOCR PP-StructureV3；只有 Docling / 当前工具在真实失败样本上确实不满足且收益大于额外部署成本时，才引入一个专用 fallback。官方：https://github.com/opendatalab/MinerU 和 https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-StructureV3/PP-StructureV3.html
- 每个候选必须记录 pinned 版本 / License / CPU+内存+耗时 / 中文英文表现 / 证据定位 / 样本级错误 / 依赖代价。**不安装四个候选当生产依赖**。同样样本、同样验收口径，最终由 W0 选主适配器和至多一个必要 fallback。

## 5. Gate、测试样本及“不算完成”的情况

### G0（启动前，W0 直接完成）
- 核对 `main`、Issue #1、PR #2 的 SHA/Owner/实际 CI；冻结本工作包起始基线与文件独占范围。
- 基于仓内可生成的**合成**样本建立至少：1 纯文字 PDF、1 双栏 PDF、1 图像型 PDF、1 正常 DOCX、1 带表格/链接 DOCX、1 PNG、1 JPEG、1 损坏文件、1 同内容不同 bytes、1 OCR 易混字符；每个有 **人工核的预期**，不得以解析器自身输出当答案。不要提交真实候选人资料。
- 若已有真实材料评测仅在授权本地环境跑；当前验收展示 synthetic Gate，不能冒充 docs/11 的完整 ≥60 真实件外部质量 Gate。

### G1（R1 最小交付）
- 从 DSH **真实工具注册入口**传入 PDF/DOCX/PNG/JPEG，返回符合 2.1 的内容、可追溯 block 与元数据，记录原件 SHA、media sniff、解析器版本。
- 正常 PDF 质量不得低于旧 baseline；同一文件两次结果一致（排除 elapsed 等运行字段）；格式伪装/损坏/越界路径/超时必须有真实 code。
- Docs + tests + CI 有 passed/failed/skipped 明细和原始日志；不能因 DOCX tool 只存在于包内便称完成。

### G2（R2 可信全链路）
- 原生缺页/错序/丢 URI/OCR 身份错/假 block ID/模型虚构经历/结构化字段错误状态/串文件证据等负例 fail-closed；旧有效版本不覆盖。
- 真实 DSH Agent 一次自然语言请求处理正常样本，能自主选择 Reader→Structure→Validate→按 #1 契约保存→初筛；失败样本能从 issues 选择有效补救或进入人工待办。
- 切换不支持 image 的模型验证 `BLOCKED`，不能假说“视觉读取成功”。
- 验收 `unreadable` 不被当成 `absent` 或淘汰理由；**注入“只有第 2 页工作经历时间不明”的局部失败**，证明姓名/学历/其他可核实经历仍可正常入库与展示，只有受影响的经历和对应 Rubric 维度待核；问题解决后从该环节继续而非整份重新上传。

### G3（R3 业务入口）
- DSH Web 选择/拖入文件→ Agent 处理→ HR 查看真实状态与可执行异常操作→刷新仍在；上传实际文件句柄需证据，不得只拿本地绝对路径的 headless 输出冒充 Web。
- 多文件来源记录完整；单份失败不拖整批；重放/重启不丢任务、不重复申请；邮件等外部接口只有真实连通才可声称 LIVE。
- 指标至少按格式展示：原文人工对照质量、证据引用正确率、未处理 HARD 数、人工介入率、P50/P95 时延及失败原因。样本量与不可比项明示，不编造成功率或成本。

### NO-GO
任一来源失败且静默变为 `complete`、复用错误 Candidate、错误关闭 Application、OCR 身份未经确认自动合并、跳过证据验证直接进入 S7、未授权外部调用、改写原件、为模型兜底新建独立 LLM SDK/Agent Loop、在 DSH 外再造 Web Shell，均阻断合并。

## 6. W0 交付和职责

1. 先在本 Issue 回帖：核对的 main / #1 PR SHA、Worktree 路径、U0–U4 owners/file ownership、真实能力与 BLOCKED 清单，以及第一批可独立执行的子任务；**随即开始编码，不要只交更多设计文档**。
2. 实现分支从可核的 `main`（或经明确 Gate 的已集成版本）切出；PR 保持 Draft；不要在 `main` 上直接提交补丁，不改旧 Recruitment-OS。GitHub 文件写入与 Issue 状态真实更新。
3. 先做到 **G1 runnable**，再集成 G2。可以放行 G1 作为可演示的有限功能版本，但不得声称全部简历理解闭环已完成。
4. 回传单一 consolidated return：准确 commit/PR/CI URL、文件列表、命令与原始结果、DB readback、真实 DSH Agent tool trace、Web 截图/可达性、合成样本精确 passed/failed/skipped、未完成项的 HR 影响，及每个 Gate 的 GO/NO-GO。W0 复跑而非自报。
5. 重大架构冲突和不可逆数据操作升级给 ChatGPT/用户；普通依赖、第三方安装、方案试验和失败修复由 W0 自己负责。不许以“需要用户决定使用哪个解析框架”为由暂停。
6. 最后仅定点同步 README / docs/07 / docs/11 / docs/12 / docs/17 / docs/18 与实际实现差异；避免多份相互冲突的最新状态。决策台账不要把未经过验证的候选结果写成既定结论。

**最重要的区分**：本工作包负责“不同来源与格式的材料是否被正确读懂并提供可信证据”；Issue #1 负责“这些证据如何正确关联人、招聘申请、已验收版本和 S7”。二者通过唯一版本契约集成，不允许互相覆盖职责。
