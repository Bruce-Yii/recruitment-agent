# 09 · DSH 插件化落位（招聘能力 -> 工具 / 工作流 / 原生复用）

**建立日期**：2026-11-12
**依据**：本机 DSH 安装实测（`DSH_HOME=D:\12412\dsh-home`，profile `desktop`）+ GitHub 插件生态检索 + Notion 04/PRD。

---

## 0. 结论先说

你的判断是对的：**这套东西本质是一个 Agent，我们做的是"对 DSH 的改造 + 把招聘能力挂上去"**。
而 DSH 的扩展单位就是**插件**，插件的一个主要形态就是**工具**。所以正确的落法是：

> **能变成"Agent 可调用的能力"→ 注册成 tool plugin；
> 必须每次结果一致的 → 留在我们自己的确定性服务里，只把"入口"做成工具；
> DSH 已经有的（会话/子代理/工作流/搜索/定时/审批）→ 直接用，不重写。**

---

## 1. DSH 插件机制（本机实测，不是推测）

### 1.1 三层结构

| 层 | 位置 | 作用 |
|---|---|---|
| **profile 根** | `D:\12412\dsh-home\profiles\desktop\cordis.yml` | **空的入口列表** `[]`；注释写明「不要编辑本文件」 |
| **bundle 层** | 同目录 `package.json` 的 `dsh.profile.bundles`（有序） | 按顺序叠加的 npm 包，每个包提供若干**插件行（rows）** |
| **patch 层** | 同目录 `cordis.patch.yml` | **在 bundle 之后应用**：按 `id` 覆盖配置、禁用、插入新行；支持 `!!js` 表达式 |

本机 `package.json` 当前装的 bundles：

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app",
 "@deepseek-ai/dsh-experimental-agent-team-profile",
 "dshmarket", "@deepseek-ai/dsh-experimental-voice-input-bundle",
 "dsh-mcp-connector", "dsh-toolbox-ui"]
```

依赖：`dsh-mcp-connector@0.2.66`、`dsh-toolbox-ui@^1.10.1`、`dshmarket@1.66.5`。

### 1.2 一行插件长什么样

`cordis.patch.yml` 里的条目形如：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ...
    model: ...
```

也就是说：**一个工具 = 一个插件行（id + 模块名 + 配置）**。工具类插件在 base bundle 里就是 `@deepseek-ai/dsh-tool-fs`、`-tool-web`、`-tool-bash`、`-tool-subagent`、`-tool-workflow`、`-tool-schedule` 这一族。

**推论**：我们加招聘工具，不需要改 DSH 源码，**发一个 bundle 包 → 在 profile 里加一行**即可。

### 1.3 已经能用、不用重写的 DSH 能力

| 能力 | 插件 | 招聘里怎么用 |
|---|---|---|
| 会话 / 上下文压缩 / checkpoint | `dsh-session*`、`compaction-basic` | Agent 对话与长任务上下文 |
| 子代理（可递归 3 层） | `dsh-subagent*`、`agent-team` | 并行 lane、独立复核 |
| **工作流（PTC 运行时）** | `dsh-workflow-ptc`、`tool-workflow` | 固化编排（不是给模型自由发挥的那部分） |
| Web 搜索 / 抓取 | `dsh-web*`、`tool-web` | 找 JD 模板、公开人才线索 |
| 文件读写/搜索 | `tool-fs`、`tool-fs-search` | 简历、转写、证据文件 |
| 定时 | `dsh-schedule`、`tool-schedule` | 定时对账、催办扫描 |
| 审批 | `dsh-user-approval`、`permission-presets` | 工具级人工确认 |
| 文档/PDF 预览、Office→PDF | `ui-sidebar-documentpreview`、`dsh-office-to-pdf` | 简历预览 |
| **MCP 连接器** | `dsh-mcp-connector`（持续更新目录） | 直接接外部 PDF/OCR/邮箱等 MCP server |

### 1.4 插件市场（本机已装 + 社区 hub）

- **本机已装 `dshmarket@1.66.5`**：DSH 内可视化插件市场（浏览/搜索/一键安装）。缓存目录 `profiles\desktop\.dsh-market\`。
- 社区 hub（GitHub，按星数）：
  - `imsai-sh/awesome-deepseek-harness-plugins`（389★，声称 11,000+ 插件，带**免费搜索 API**）
  - `losebird/dsh-plugin-market`（28★）
  - `win4r/deepseek-harness-plugin-creator`（42★，**可复用来"写并校验" DSH/Cordis 插件的 skill**）
  - `sugarforever/dsh-lark`（26★，**Lark/飞书集成插件**——接飞书前先看它）
  - 另有 `walkinglabs/`、`vvlife/`、`SihanTeng/`、`diegosouzapw/` 等目录

> ⚠️ 以上社区仓库我**只看了描述和星数，没有逐个读源码验证**。真正采用前必须按 `docs/07` 的复用清单核对：精确 commit、许可证、依赖、权限面、可维护性。

---

## 2. 招聘能力的三分类落位（核心）

> 依据 Notion 04：「不把所有工作都做成 Agent，也不把复杂业务僵化成硬编码流程。按任务性质选择合适执行方式。」

### A. 做成 **Agent 工具**（tool plugin 或 MCP tool）

| 招聘能力 | 工具名（建议） | 性质 |
|---|---|---|
| 查岗位标准 / Rubric 版本 | `job_get_requirements` | 只读 |
| 查候选人档案（授权范围内摘要） | `candidate_get_profile` | 只读 |
| 读简历原文与解析版本 | `resume_get_version` + `resume_parse` | 只读 + 解析 |
| 查面试/会议绑定/转写状态 | `interview_get_context` | 只读 |
| 取转写证据片段（含时间戳回链） | `transcript_search_evidence` | 只读 |
| 生成筛选建议（带证据引用） | `screening_suggest` | 建议，不落库 |
| 生成面试问题 / 面评草稿 | `interview_plan_draft`、`scorecard_draft` | 草稿，`persisted:false` |
| 查在办任务与阻塞原因 | `task_get_status` | 只读 |
| 起草邮件/邀约文案 | `message_draft` | 草稿 |

**共同要求**：严格 input schema（拒绝未知字段）、服务端授权（Actor × Scope × Mandate）、只读或纯草稿、**不直接改状态**。

> 现有代码里 `packages/agent-fixture-tools` 的六个工具就是这套形制的雏形，可以直接演进。

### B. **不做成工具**，必须是确定性服务

| 能力 | 为什么不能做成工具 |
|---|---|
| 状态迁移（Application/Interview/Decision） | 模型不可复现，状态必须由领域服务校验 |
| 审批绑定（payload hash + 版本） | 审批必须与内容版本强绑定，不能被"工具参数"绕过 |
| 幂等 / 去重 / 乐观并发 | 需要事务与唯一约束 |
| Effect 派发 + 回执 + 对账 | 外部副作用不可撤销 |
| 队列投递 | 投递是机制，不是业务动作 |
| 权限判定 | 服务端强制，不信 Prompt |

**落法**：这些能力**仍然可以被 Agent 触发**，但方式是「工具调用一个**命令端点**」——工具只是入口，真正的校验在服务端。这正是 `docs/05` 写的「Agent 不拥有不变量」。

### C. **直接复用 DSH 原生**，不自己写

对话/会话恢复、子代理、workflow 编排、web 搜索、文件读写、定时、审批、文档预览。

---

## 3. 简历文件解析（PDF / Word，含扫描件）

**明确不自研解析/OCR。** 复用顺序：

| 优先级 | 方案 | 说明 |
|---|---|---|
| 1 | **DSH MCP 连接器接一个 PDF MCP server** | 零开发；`dsh-mcp-connector` 已装 |
| 2 | DSH 原生文件/文档能力 | 预览、Office→PDF |
| 3 | 自写轻量 tool plugin 封装解析 | 只在 1/2 都不满足时 |

**社区候选（未验证，仅按描述与星数初筛）**：

| 仓库 | ★ | 可能用途 |
|---|---|---|
| `I-CAN-hack/pdf-mcp` | 82 | PDF 读取 + **图像渲染**（扫描件可转图再交给视觉模型） |
| `Sohaib-2/pdf-mcp-server` | 16 | 合并/拆分/加密等操作 |
| `nfsarch33/pdf-mcp-server` | 15 | **OCR / 表格抽取 / 表单 / 脱敏** |
| `pdffigures-mcp-server` | 9 | 抽图表（简历不太需要） |
| `nutrient-pdf-mcp-server` | 5 | 商业 SDK 的 MCP 壳 |

**两类 PDF 必须分开处理**：
- **文字型 PDF**：直接抽文本 + 版面 → 结构化字段。
- **图片型（扫描件）**：必须先**渲染成图 + OCR 或视觉模型**，不能直接抽文本。

> 现有仓库里 `PlainTextResumeParser` 只吃 text/plain，PDF/DOCX 会 501 —— 这就是为什么必须接解析能力，而不是继续加正则。

**Word**：`.docx` 是 zip+XML，解析成本低；`.doc`（老格式）需要转换，建议走 Office→PDF 或直接不接。

---

## 4. 落地三步（可执行，按风险从低到高）

### 第 1 步 · 零开发验证解析能力
用 `dsh-mcp-connector` 接一个 PDF MCP（优先 `I-CAN-hack/pdf-mcp`，因为它能渲染图像），拿**一份文字型 + 一份扫描件**简历验证：
- 能否出全文与页数
- 扫描件能否出可读文本或可交给视觉模型的图

**通过标准**：两类 PDF 都能得到可用的候选人字段来源（姓名/联系方式/经历），且保留页码/来源定位。

### 第 2 步 · 招聘工具 bundle
新建 `@recruitment/dsh-recruitment-tools`（cordis 插件包），导出 §2-A 的只读/草稿类工具，通过 profile 的 `cordis.patch.yml` 注册。
**约束**：工具内部只调我们已有的 API（带 Mandate），不直连 DB；不落库；不改状态。

### 第 3 步 · 有副作用的动作走命令端点
「取转写」「生成 Interview Record」「提交面评」这类**有副作用**的动作，工具只负责**发起**，执行仍由现有 Worker + Business Task 承担（已跑通：队列投递 2–4 秒）。

---

## 5. 边界与不做

1. **不自研 PDF/OCR/ASR**（`docs/00 §6`、PRD §14）。
2. **不把确定性流程做成 LLM 工具**（否则模型可以绕过状态机）。
3. **工具必须服务端授权**，Prompt/工具描述都不是权限。
4. **不把 DSH 的 local jobs 当业务任务**（ADR-0002/0005：Business Task 归产品）。
5. **社区插件先验证再采用**：pin commit、看 license、看权限面、看依赖，写入复用登记（`docs/07` 清单）。

---

## 6. 与现有实现的衔接

| 现状 | 与本文的关系 |
|---|---|
| `packages/agent-execution`（Phase 1 边界，provisional） | 就是"工具注册 + 授权 + 校验"的抽象；可继续用，也可换成 DSH 原生 tool 机制 |
| `packages/agent-fixture-tools`（6 个合成工具） | §2-A 的雏形，可升级为真实只读工具 |
| `packages/agent-acceptance`（独立验收） | 保留：工具是否真的被调用、有没有越权，需要独立证据 |
| `apps/worker` 的 TRANSCRIPT_FETCH / INTERVIEW_RECORD 任务 | §2-B/第 3 步的执行侧，已跑通 |
| `UnconfiguredEffectDispatcher` | 对外发送仍不可用，属于要补的确定性服务，**不是工具** |

---

## 7. 实测：PDF 解析（2026-11-12）

### 7.1 选型（按星数 + 本机可行性）

| 候选 | ★ | 判断 |
|---|---|---|
| `datalab-to/marker` | 40,869 | PDF→Markdown 最强，但要 torch + 模型，重；**留作 OCR 质量不够时的升级路径** |
| `PaddleOCR` | 92,593 | 识别最强之一，依赖重（Paddle 运行时） |
| `tesseract` | 77,472 | 需要单独装二进制，本机没有 |
| **`PyMuPDF`** | **11,118** | **已采用**：文本层抽取 + 页面栅格化，pip 装、无外部二进制 |
| **`RapidOCR`（ONNX）** | **8,509** | **已采用**：OCR 回退，纯 ONNX 推理，**不需要 torch**，CPU 可跑 |

本机：Python 3.12.9 + pip，无 tesseract / poppler / ImageMagick。磁盘 209 GB 可用。

### 7.2 工具

`scripts/pdf/extract_resume.py` —— 输入文件路径，输出**一个 JSON**：

```
{ file, pages, source: text_layer|ocr|plaintext, text,
  fields: { phone: {value, provenance, review_required}, email: {...} },
  warnings: [...], seconds }
```

**退出码**：0 成功；2 用法错误；3 文件不可读；4 没取到任何文本。

### 7.3 实测结果（合成样例，1 页）

| 用例 | 路径 | 电话 | 邮箱 | 耗时 | review_required |
|---|---|---|---|---|---|
| 文字型 PDF | `text_layer` | ✅ `138-0000-1234` | ✅ `wu.ming@example.test` | **0.1s** | false |
| 扫描型 PDF（图片页） | `ocr` | ✅ | ✅（**修复后才对**） | **7.9s** | **true** |

### 7.4 关键发现（这是"经得起检验"的部分）

1. **扫描件的文本层是 0 字符**，必须走 OCR 回退——这是**唯一的判定依据**（不是猜文件类型）。
2. **OCR 把 `x` 识别成希腊字母 `α`**（`wu.ming@eαample.test`），而且 **200 / 300 / 400 DPI 都一样** → **这是模型辨识能力问题，不是参数问题**。
3. 修复方式：NFKC 规范化（全角→半角）+ **窄范围易混字符映射**（α/ο/ӏ/Ⅰ）。修复后邮箱能正确还原。
4. **但即便还原了，也不能当事实用**：OCR 同一页还把 `技能：Java, Go, Python...` 识别成 `技能:」a a,` 之类的乱码。所以：
   - `text_layer` 的字段 → 可直接用于业务
   - **`ocr` 的字段 → 一律 `review_required: true`，绝不能驱动自动候选人合并/去重**（否则会错误合并两个人，这是项目最怕的一类错）

### 7.5 还没验证的（诚实边界）

- **只用合成样例**跑过；**真实简历（尤其多页、双栏、含照片）没跑**
- `.docx` 只是 best-effort，未做真实样本验证
- 中文长简历的分页/断行合并策略尚未调优
- 与 DSH 的接线（tool plugin / MCP）尚未做，目前是独立 CLI

