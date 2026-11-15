# CONTRACT · `@recruitment/dsh-recruitment`

**日期**：2026-11-12
**任务卡**：`work/handoff/14-parallel-task-cards.md` §C（插件骨架 + 工具契约）
**上位文档**：`work/handoff/09-dsh-plugin-architecture.md` §2-A（只读/草稿类工具）
**状态（2026-11-14 回抄）**：可安装、可注册、可调用；当前注册 **27 个工具**（`src/index.ts:589-613`），
S3–S10 一条链路，既有只读也有**真写 PostgreSQL** 的工具。本文 §2–§9 是 **2026-11-12 的三工具 stub 快照**，
与现状冲突时以本节 §0.1 + `docs/17-decision-ledger.md` 为准。

---

## 0.1 现状回抄（2026-11-14，逐条带证据；取代下文同名旧口径）

| # | 本文旧口径 | 现状 | 证据 |
|---|---|---|---|
| 1 | 三个工具（§0） | **26 个**：`resume_read` / `document_read` / `resume_serialize` / `structure_validate` / `candidate_get` / `job_get` / `job_create` / `job_update` / `job_rubric_approve` / `application_intake` / `screening_evaluate` / `application_stage_advance` / `interview_schedule` / `interview_get` / `transcript_import` / `transcript_read` / `interview_record_verify` / `scorecard_submit` / `evaluation_summarize` / `decision_record` / `trace_get` / `config_role` / `config_team` / `config_pipeline` / `page_image` / `model_text_merge` | `src/index.ts:589-613`（21 具名 + `...structureTools` 2 + `...configTools` 3 = 26）；2026-11-14 回抄实测：假 ctx 调 `apply()` 捕获 **26** 个注册名（配置齐 / 缺两条路径都是 26，见 `test/unit/interview-record-verify.test.ts` 的 apply() 用例）。新增的 `interview_record_verify` 是 D-B 修复：`interview_record` 从 `NEEDS_REVIEW/UNVERIFIED` 到 `READY/VERIFIED` 的唯一产品入口（人类闸门 D-79），契约见 `contracts/interview/tool-contracts.md §8` |
| 2 | 全部只读、不连库（§0 / §2.3 / §6） | 读走 `withReadOnly`、写走 `withActor`，真连 PG 17；S3/S6/S8/S9/S10 都有写库路径 | `src/db/pool.ts`；`src/index.ts` 的 `create*Tool`；各 `src/tools/*.ts` |
| 3 | `provenance` 恒 `FIXTURE`（§0 / §2.4） | 按 R4 三维标签计算；**缺省**才是 `FIXTURE`，真实读取为 `LIVE` | `src/tools/screening-evaluate.ts:1692-1693`；`src/tools/decision-record.ts:1686-1693`；D-95 / D-103 |
| 4 | 依赖服务 `inject = ['tools']`（§1） | `inject = ['tools', 'approval']`（人类闸门，D-79） | `src/index.ts:123` |
| 5 | 无浏览器半部分（§1 / §8.6） | 有：`package.json` 声明 `dsh.client.platform=web` + `lib/client.js`；工作台面板在 `src/client/` | `package.json`；`src/http/overview.ts`；`evidence/experiments/2026-11-14-workbench-panel/` |
| 6 | 散文错误格式、只有 `INVALID_ARGS`/`NOT_FOUND`（§2.2） | **D-63 已裁定统一** `Error: <CODE>: <compact-json>`，不允许两套并存；错误码见 `RecruitmentErrorCode`。**实现尚未全部切换**：`resume-read` / `candidate-get` / `document-read` / `page-image` / `structure-tools` / `vision-fallback` 仍走 `parseArgs` 散文格式 | `docs/17` D-63（`:491-494`）；`src/tools/errors.ts:15-23`；`src/tools/args.ts:23-24` |
| 7 | `resume_read` 入参 `resume_id`（§3） | 入参是 `path`（`allowed_roots` 内的绝对路径） | `src/tools/resume-read.ts:25-30` |
| 8 | `candidate_get` 返回 stub 的 `provenance` 常量 / `stub: true`（§4） | 旧 stub 的 `provenance` 常量与 `stub` 字段已删；**真查 PG**（只读），输出 `identity_status` + `source:'DATABASE'`，联系方式默认脱敏；三维 `labels` 的补齐见 `docs/23` P2-03 | `src/tools/candidate-get.ts:1-17` |
| 9 | `job_get` 是 stub 契约（§5） | 被 `contracts/job-screening/tool-contracts.md §2` **取代**（同名工具面，破坏性差异见该文件 §4） | `contracts/job-screening/tool-contracts.md §4` |
| 10 | 自检入口 `test/harness.mjs`（§9） | 该文件**已不存在**；当前入口是 `node --test` + `manual/` 下脚本 | `test/`；`manual/` |
| 11 | 真实模型会话未跑通（§7.3 / §8.1） | 2026-11-13 已跑通：headless + 真模型（`beam-free`）25 步自主完成 S6→S7 | `evidence/experiments/2026-11-13-natural-language-autonomous-run/README.md` |

> **§3–§9 保留作 2026-11-12 历史快照**，不再作为当前工具面的验收依据。
> 现行契约：`contracts/job-screening/`（S3/S7）、`contracts/evaluation/`（S10）、`contracts/interview/`（S8）、
> `contracts/stage-advance/`（阶段推进）、`contracts/tenant-config/`（3 个 `config_*` 工具）、`contracts/runtime/`、
> `contracts/workbench/`，以及各 `src/tools/*.ts` 里模型可见的 `parameters`。

---

## 0. 一句话 + 一条必须先说的实测结论

> **以下这句是 2026-11-12 的历史口径，已被 §0.1 取代（现状 27 个工具、有写库）：**
> 三个工具（不多不少），全部只读，全部返回 stub 数据，`provenance` 恒为 `FIXTURE`。

**实测结论（会改变后续所有插件写法，必须上报）**：通过 `dsh plugin add link:` 装进 profile
的插件**无法 `import` `@deepseek-ai/dsh-tools`**。宿主按包名 import 本插件时，Node 从本包
真实路径解析裸模块名，而 `@deepseek-ai/dsh-tools` 只存在于 DSH 安装目录与
`$DSH_HOME/profiles/node_modules`，两者都不在本包的解析链上：

```text
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
failed to import loader entry recruitment (@recruitment/dsh-recruitment):
Cannot find package '@deepseek-ai/dsh-tools' imported from
D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment\src\index.ts
code: 'ERR_MODULE_NOT_FOUND'
```

这正是本机已装样例 `dsh/dsh-pdf-fix/lib/index.js` 注释里写「无需 `@deepseek-ai/dsh-tools`」的原因
——它也是用原始对象注册的，不是 `defineTool`。

**因此本包的选择**：走官方同样承认的第二条路——直接注册原始 `ToolDefinition`
（`docs/subsystems/tools.zh.md`：「直接注册的原始 JSON Schema 工具自行负责输入校验」）。
代价与差别只有一条，且对我们有利：

| | 官方 `defineTool` | 本包（原始 `ToolDefinition`） |
|---|---|---|
| 参数根对象 | **隐式开放**（`additionalProperties` 不写，未知字段放行） | **显式 `additionalProperties: false`**，未知字段拒绝 |
| 入参校验 | 框架代做 | 本包自己做（`src/tools/args.ts`） |
| 结构化 `error.info` | 有（抛 `HarnessError` 子类） | 无（无法继承 `HarnessError`；改为把稳定 code 写进 message 前缀） |
| `output.schema` 强制 | 框架强制 | **框架同样强制**（`register()` 会 `assertSupportedJsonSchema`，返回后逐值校验） |

不引入任何依赖：`package.json` 没有 `dependencies` / `peerDependencies`，运行时只 import
本包自己的相对路径文件。

> **2026-11-13 修正（D-71）**：上句已不再成立。领域写路径定为 TypeScript + node-postgres，
> 本包现在有**唯一一个**运行时依赖 `pg@^8.23.1`（`pnpm add pg`，实测可连 PG 17.11）。
> 理由：DSH 插件是产品面，业务逻辑不该被拆到 Python sidecar；Python 只保留在它本来就是
> 正确工具的地方（PDF 解析 / OCR / 页面渲染）。`@deepseek-ai/dsh-tools` 仍然 import 不到
> （见上面那段实测），所以工具定义仍走原始 `ToolDefinition`。
> 注意：`pg` 只在本包自己的 `node_modules` 里，`link:` 安装时从本包真实路径解析，可用。

---

## 1. 插件形态

| 项 | 值 |
|---|---|
| 包名 | `@recruitment/dsh-recruitment` |
| 入口 | `src/index.ts`（`name` / `inject` / `apply`） |
| 宿主加载方式 | 包 `main` 直接指向 `.ts`；Node ≥22.19 的类型擦除负责去类型（**无构建步骤**） |
| 声明 | `dsh.bundle.patch: "./cordis.patch.yml"` |
| 配置行 | `id: recruitment`，`name: '@recruitment/dsh-recruitment'` |
| 浏览器半部分 | **有**：`dsh.client.platform = web`，客户端入口 `lib/client.js`（源码 `src/client/`），工作台面板 |
| 依赖服务 | `inject = ['tools', 'approval']`（`tools` 为硬依赖；`webServer` 是可选注入） |
| 运行时 import | 本包内相对路径 + **`pg`**（唯一运行时依赖，D-71）；`import type` 全部被擦除 |

安装 / 卸载：

```powershell
$env:DSH_HOME='D:\12412\dsh-home'
dsh plugin --profile <profile> add link:D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
dsh --profile <profile> --dump-config     # 应看到 `- id: recruitment`
dsh plugin --profile <profile> remove @recruitment/dsh-recruitment
```

---

## 2. 公共约定（**2026-11-12 的"三个 stub 工具"口径；27 个工具的现状见 §0.1**）

### 2.1 入参校验规则（`src/tools/args.ts`）

1. `arguments` 必须是 JSON 对象（数组/标量直接 `INVALID_ARGS`）。
2. **未声明的键一律拒绝**，错误消息里同时列出该工具允许的键。
3. 必填键缺失 → 拒绝；`string` 必须是**非空**字符串，且不超过声明的 `maxLength`。
4. `integer` 必须是整数（`10` 通过，`"10"` / `10.5` 拒绝），并检查闭区间上下界。
5. `boolean` 必须是布尔（`"true"` 拒绝）。
6. `string[]` 必须是字符串数组，逐元素检查 `enum`。
7. **收集全部违反项后一次性抛出**，不是遇到第一条就返回。

模型可见的 `parameters` schema 用官方强制子集的关键字生成
（`type` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `description`），
子集表达不了的约束（非空、长度、上下界）写在 `description` 里，由第 1 段的代码强制。

### 2.2 错误码

| code | 何时 | 模型看到的内容 |
|---|---|---|
| `INVALID_ARGS` | 未知参数 / 类型不符 / 缺必填 / 越界 | `Error: INVALID_ARGS: unknown parameter "bogus" (allowed: resume_id, max_blocks, block_types)` |
| `NOT_FOUND` | id 或 rubric 版本不在 stub 数据里 | `Error: NOT_FOUND: job "job_9999" not found; known stub ids: job_0001, job_0002` |

实现：`src/tools/errors.ts` 的 `RecruitmentToolError`，`code` 同时是 message 前缀。
**为什么不带 `error.info`**：DSH 只对 `HarnessError` 实例保留结构化 `error.info`，本包无法 import
它的基类（§0）。所以把 code 放进 message，保证模型与日志看到同一个 code，不靠解析自然语言。

> **2026-11-14 现状**：D-63 已裁定统一 `Error: <CODE>: <compact-json>`，**不允许两套错误格式并存**
> （`docs/17` D-63，`:491-494`）。上表两种散文消息是历史口径；现行错误码见 `RecruitmentErrorCode`
> （`src/tools/errors.ts:15-23`）。**实现仍有两套**：`resume-read` / `candidate-get` / `document-read` /
> `page-image` / `structure-tools` / `vision-fallback` 仍用 `parseArgs` 的散文格式，其余用 `parseContractArgs`
> 的 JSON 格式（`src/tools/args.ts:23-24`）——这是待收口的实现缺口，不是"两种格式都合法"。

### 2.3 只读契约（**仅 2026-11-12 的 3 个 stub 工具；对 S3/S6/S8/S9/S10 写工具不成立**）

- 源码里**没有** `node:fs` / `node:net` / `node:http` / 任何 DB 驱动 / `fetch` / 子进程（§5 静态自检）。
- 不写任何模块级状态；`execute` 只做「按键取常量 → 过滤 → 切片 → 组装返回值」。
- 无时钟、无随机数：同一入参永远返回同一结果（stub 时间戳全是字符串常量）。
- 不落库、不改状态、不发副作用：本包不产生任何外部写。
- 声明 `isConcurrencySafe: () => true`（纯只读，可与其他只读工具并行）。

### 2.4 数据可信度标注（按 R4 三维正交）

| 维度 | 取值 | 说明 |
|---|---|---|
| `provenance` | `FIXTURE` | 三个工具的输出都带这个字段，值是常量 —— 数据是造的 |
| `connection` | `NOT_CONNECTED` | 不连接数据库，也不连接任何外部系统 |
| `trigger` | 不适用 | 由模型在会话里调用，不是事件触发；没有「已读取外部系统」这层含义 |

> **2026-11-14 现状**：上表只描述 2026-11-12 的 3 个 stub 工具。现行口径按 R4 **三维正交**
> （`provenance` / `trigger` / `connection`）逐工具计算，**缺省才是 `FIXTURE`**：
> DB 工具 `connection=CONNECTED`，转写类按来源给 `LIVE`/`FIXTURE`。
> 证据：`src/tools/screening-evaluate.ts:1692-1693`、`src/tools/decision-record.ts:1686-1693`；详见 §0.1 第 3 条。

---

## 3. `recruitment_resume_read`

> **历史快照（2026-11-12 stub 版）**。现行实现：入参 `path`（`allowed_roots` 内绝对路径）、
> 真调 `converter/` 读 PDF，不再有 `resume_id` / `stub` / 恒定 `provenance`（`src/tools/resume-read.ts:25-30`）。
> 结构化/校验拆成 `recruitment_resume_serialize` + `recruitment_structure_validate`（`src/tools/structure-tools.ts`）。
> 本节只保留作历史，不用于验收。

读一份简历的解析结果（有序内容块）。

### 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `resume_id` | string | ✅ | 非空，≤64 | 简历 id，例 `resume_0001` |
| `max_blocks` | integer | — | 1..50，默认 20 | 最多返回多少个块 |
| `block_types` | string[] | — | 元素 ∈ `contact`/`summary`/`experience`/`education`/`skill` | 只看这些类型 |

### 出参（规范值，`output.schema` 逐值强制）

| 字段 | 类型 | 含义 |
|---|---|---|
| `resume_id` | string | 回显 |
| `provenance` | `FIXTURE` / `LIVE` | 本 stub 恒为 `FIXTURE` |
| `stub` | boolean | 恒 `true` |
| `source.file_name` / `media_type` / `pages` / `extraction` | string / string / integer / `TEXT_LAYER`\|`OCR` | 解析来源 |
| `blocks[].index` | integer | 原始块序号（**过滤后不重排**） |
| `blocks[].type` | 同上 5 类 | 块类型 |
| `blocks[].page` | integer | 来源页码（1 起） |
| `blocks[].text` | string | 块正文 |
| `blocks[].review_required` | boolean | 是否需要人工复核（`OCR` 来源恒 `true`，对齐 `docs/09 §7.4`） |
| `block_count` | integer | **过滤后、截断前**的块总数 |
| `truncated` | boolean | 是否因 `max_blocks` 被截断 |

### 错误

`INVALID_ARGS`（见 §2.2）、`NOT_FOUND`（`resume_id` 不在 stub 里）。

### 真实调用样例

```text
$ node test/harness.mjs   →  B 段
recruitment_resume_read {"resume_id":"resume_0001","max_blocks":3}
  | resume resume_0001 (provenance=FIXTURE, stub=true)
  | source: synthetic-text.pdf (application/pdf), 2 page(s), extraction=TEXT_LAYER
  | blocks: 3 returned of 6 (truncated=true)
  |
  | [0] contact (page 1, review_required=false)
  | 张示例 / zhang.example@example.test / 138-0000-1234 / 上海
```

---

## 4. `recruitment_candidate_get`

> **历史快照（2026-11-12 stub 版）**。现行实现：**真查 PG（只读）**，旧 stub 的 `provenance` 常量与
> `stub` 字段已删；输出 `identity_status` + `source:'DATABASE'`，联系方式默认脱敏；查不到即 `NOT_FOUND`，
> 不回退样例数据；三维 `labels` 的补齐见 `docs/23` P2-03（`src/tools/candidate-get.ts:1-17`）。本节只保留作历史。

按 id 取一个候选人档案 + 其申请关系。

### 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `candidate_id` | string | ✅ | 非空，≤64 | 候选人 id，例 `candidate_0001` |
| `include_contacts` | boolean | — | 默认 `false` | `false` 时邮箱/电话脱敏 |

### 出参

| 字段 | 类型 | 含义 |
|---|---|---|
| `candidate_id` / `display_name` | string | 档案基本信息 |
| `status` | `ACTIVE` / `ARCHIVED` | 档案状态 |
| `provenance` / `stub` | `FIXTURE` / boolean | 见 §2.4 |
| `contacts.visible` | boolean | 是否明文（= 入参 `include_contacts`） |
| `contacts.email` / `contacts.phone` | string | 脱敏规则：邮箱保留首字母与域名（`z***@example.test`），电话保留前 3 后 4（`138****1234`） |
| `applications[]` | array | `application_id` / `job_id` / `stage`（`APPLIED`/`SCREENING`/`INTERVIEW`/`OFFER`/`REJECTED`） |

### 错误

`INVALID_ARGS`、`NOT_FOUND`。

### 真实调用样例

```text
recruitment_candidate_get {"candidate_id":"candidate_0001"}
  | candidate candidate_0001 / 张示例 (status=ACTIVE, provenance=FIXTURE, stub=true)
  | contacts: z***@example.test / 138****1234 (visible=false)
  | applications: 2
  |   application_0001 -> job_0001 @ SCREENING
```

---

## 5. `recruitment_job_get`

> **历史快照（2026-11-12 stub 版）——已被取代**。现行契约是
> `contracts/job-screening/tool-contracts.md §2`（同名工具面，破坏性差异见该文件 §4）：
> `rubric_version` 字符串入参 → `rubric_version_no` / `rubric_version_id`，`stub` 字段删除，
> `provenance` 改为计算值，错误消息改 JSON。本节只保留作历史。

取一个岗位 + 其中一个 Rubric 版本。

### 入参

| 参数 | 类型 | 必填 | 约束 | 含义 |
|---|---|---|---|---|
| `job_id` | string | ✅ | 非空，≤64 | 岗位 id，例 `job_0001` |
| `rubric_version` | string | — | ≤16 | 指定版本（`v1`/`v2`…）；缺省取岗位当前版本 |

### 出参

| 字段 | 类型 | 含义 |
|---|---|---|
| `job_id` / `title` / `location` | string | 岗位基本信息 |
| `status` | `OPEN` / `PAUSED` / `CLOSED` | 岗位状态 |
| `provenance` / `stub` | `FIXTURE` / boolean | 见 §2.4 |
| `rubric.version` | string | 实际返回的版本 |
| `rubric.is_current` | boolean | 是否等于岗位当前版本 |
| `rubric.criteria[]` | array | `key` / `label` / `kind`（`MUST_HAVE`/`NICE_TO_HAVE`/`DISQUALIFIER`）/ `weight`（同版本内求和为 1） |
| `rubric_versions` | string[] | 该岗位全部可用版本 |

### 错误

`INVALID_ARGS`；`NOT_FOUND`（岗位不存在 **或** 版本不存在，两种原因分别给不同消息）。

### 真实调用样例

```text
recruitment_job_get {"job_id":"job_0001"}
  | job job_0001 / 后端工程师（示例） (status=OPEN, location=上海, provenance=FIXTURE, stub=true)
  | rubric v1 (is_current=true), versions: v1, v2
  |   backend_depth [MUST_HAVE] weight=0.5 — 后端工程深度
  |   async_pipeline [MUST_HAVE] weight=0.3 — 异步/队列流水线经验
  |   frontend_basics [NICE_TO_HAVE] weight=0.2 — 基本前端能力
```

---

## 6. 只读是怎么证明的（不是自我声称）

> **历史快照：本节的静态扫描只覆盖 2026-11-12 的 3 个 stub 工具。**
> 27 个工具的现状**不是全部只读**：S3/S6/S8/S9/S10 有写库路径（§0.1 第 2 条）；2026-11-14 起另有 `job_rubric_approve` / `application_stage_advance` / `trace_get` / 3 个 `config_*` 写读工具。
> 当前只读证明按工具分别做：S7 `screening_evaluate` 用 `withReadOnly` + `test/unit/screening-readonly.test.ts`；
> 其余只读工具同样在 `begin transaction read only` 里跑（`src/db/pool.ts`）。
> `test/harness.mjs` 已不存在，本节命令不可复跑。

**A. 静态**：`test/harness.mjs` E 段扫描 `src/` 全部 8 个 `.ts` 文件，对 8 类写路径逐一断言为 0 命中：

```text
扫描 8 个源文件：src\index.ts, src\tools\args.ts, src\tools\candidate-get.ts,
src\tools\definition.ts, src\tools\errors.ts, src\tools\job-get.ts,
src\tools\resume-read.ts, src\tools\stubs.ts
  PASS  src/ 无 node:fs
  PASS  src/ 无 fs
  PASS  src/ 无 node:net / http / https
  PASS  src/ 无 pg / 数据库驱动
  PASS  src/ 无 fetch( / XMLHttpRequest
  PASS  src/ 无 写入调用
  PASS  src/ 无 SQL 写语句
  PASS  src/ 无 子进程
```

**B. 结构**：`execute` 的唯一入参处理是 `parseArgs()`，唯一出参是新建对象字面量；
没有共享可变状态、没有句柄、没有 `await` 外部 IO。三个工具的 `apply` 只做 `ctx.tools.register()`。

**C. 数据**：`src/tools/stubs.ts` 只有 `export const` 常量，内容全部是合成样例
（`张示例` / `李样例` / `synthetic-*.pdf` / `*.example.test`），**不含任何真实候选人资料**（R7）。

---

## 7. 验收记录（命令 + 真实输出）

### 7.1 安装（临时 profile `rec-plugin-test`，未触碰 `desktop` / `recruitment`）

```text
$ dsh plugin --profile rec-plugin-test add link:D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
dsh: initialized profile rec-plugin-test at D:\12412\dsh-home\profiles\rec-plugin-test
dependencies:
+ @recruitment/dsh-recruitment <- ../../../dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment
Done in 127ms using pnpm v12.18.0
EXIT=0
```

profile 清单被自动改写（`reconcilePlugins` 按安装后的真实状态写回）：

```json
{ "dependencies": { "@recruitment/dsh-recruitment": "link:D:/12412/dsh工作区/..." },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@recruitment/dsh-recruitment"] } } }
```

### 7.2 `--dump-config`

```text
$ dsh --profile rec-plugin-test --dump-config | Select-String 'recruitment'
> # == @recruitment/dsh-recruitment
> - id: recruitment
>   name: '@recruitment/dsh-recruitment'
EXIT=0
```

### 7.3 工具可被调用 —— **单元级已证；真实会话 2026-11-12 BLOCKED（已被 2026-11-13 证据取代，见 §0.1 第 11 条）**

**真实宿主能加载本插件**（同一命令在 import 失败时会大声报错，见 §0）：

```text
$ node D:\12412\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js --profile rec-plugin-test
[host 进程在 12s 后仍存活，已主动结束]
--- STDOUT --- (空)
--- STDERR --- (空)
```

**注册与调用的正向证据**来自 `test/harness.mjs`：它用本机 DSH 安装里的**真实**
`@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` 起 `ToolsService`，再用本插件真实的
`apply()` 注册，然后取注册表里的定义执行：

```text
=== A 真实注册表投影 ===
ctx.tools.schemas() -> 3 tool(s): recruitment_resume_read, recruitment_candidate_get, recruitment_job_get
  PASS  恰好注册 3 个工具
  PASS  工具名与契约一致
  PASS  recruitment_resume_read 的 parameters 被官方 schema 校验器接受
  PASS  recruitment_resume_read 的 parameters 显式封闭（拒绝未知字段）
  ...（三个工具同）

=== B 正例调用（真实 execute + 官方 output.schema 校验 + render） ===
  PASS  recruitment_resume_read {"resume_id":"resume_0001","max_blocks":3} -> output.schema 零违反
  PASS  recruitment_candidate_get {"candidate_id":"candidate_0001","include_contacts":true} -> output.schema 零违反
  PASS  recruitment_job_get {"job_id":"job_0001","rubric_version":"v2"} -> output.schema 零违反
  ...（共 6 组，全部零违反）
=== 汇总 ===
ALL CHECKS PASSED
EXIT=0
```

**真实模型会话未跑通 —— BLOCKED，原因是账号余额不足**（不是插件问题；**这是 2026-11-12 的记录，已被 2026-11-13 的会话证据取代，见 §0.1 第 11 条**）：

```text
$ dsh --profile rec-plugin-session "Call the tool recruitment_job_get with job_id=job_0001 ..."
dsh: QUOTA: Insufficient Balance (request_id: cd52ecb1-a330-479b-a9bb-f52b2674a35d)
exit=1
```

（`rec-plugin-session` 是另建的临时 profile：`--from-default-profile headless` = base + headless，
再装同一个 `link:`；未触碰任何既有 profile。）

### 7.4 负向测试：传未知参数必须被拒

```text
=== C 负向测试：传未知参数 / 类型不符 / 缺必填 / 未知 id ===
  ! recruitment_resume_read {"resume_id":"resume_0001","bogus":1}
  !   RecruitmentToolError: INVALID_ARGS: unknown parameter "bogus" (allowed: resume_id, max_blocks, block_types)
  ! recruitment_job_get {"job_id":"job_0001","unknown_flag":true}
  !   RecruitmentToolError: INVALID_ARGS: unknown parameter "unknown_flag" (allowed: job_id, rubric_version)
  ! recruitment_resume_read {"resume_id":"resume_0001","max_blocks":"ten"}
  !   RecruitmentToolError: INVALID_ARGS: "max_blocks" must be an integer
  ! recruitment_candidate_get {}
  !   RecruitmentToolError: INVALID_ARGS: missing required parameter "candidate_id"
  ! recruitment_job_get {"job_id":"job_9999"}
  !   RecruitmentToolError: NOT_FOUND: job "job_9999" not found; known stub ids: job_0001, job_0002
  ! recruitment_job_get {"job_id":"job_0001","rubric_version":"v9"}
  !   RecruitmentToolError: NOT_FOUND: rubric version "v9" not found for job "job_0001"; known versions: v1, v2
```

并用**官方校验器**交叉验证「我们的 `parameters` schema 本身就是封闭的」：

```text
=== D 交叉验证：官方校验器用同一份 parameters schema 也拒绝同一入参 ===
  ~ recruitment_resume_read {"resume_id":"resume_0001","bogus":1}
      -> "bogus" is not a declared property (additionalProperties: false)
  ~ recruitment_job_get {"job_id":"job_0001","unknown_flag":true}
      -> "unknown_flag" is not a declared property (additionalProperties: false)
  ~ recruitment_resume_read {"resume_id":"resume_0001","max_blocks":"ten"}
      -> "max_blocks" must be an integer
  ~ recruitment_candidate_get {} -> missing required property "candidate_id"
```

> 注意边界：DSH 的注册表**不会**替原始工具校验 `parameters`（那是 `defineTool` 的职责），
> 所以 D 段是「schema 设计正确」的证明，**运行时拦截由 C 段的 `parseArgs()` 完成**。

### 7.5 三个工具全部只读

> 仅对 2026-11-12 的 3 个 stub 工具成立；27 个工具的现状见 §0.1 第 2 条。

见 §6（静态扫描 8/8 项 0 命中 + 结构说明）。

---

## 8. 已知边界 / 没做到的（2026-11-12 记录；现状差异见下列标注）

1. ~~**真实模型会话未跑通**~~：**已于 2026-11-13 跑通**（headless + 真模型 `beam-free`，25 步自主完成 S6→S7）——
   `evidence/experiments/2026-11-13-natural-language-autonomous-run/README.md`。本条只保留当时的 QUOTA 记录。
2. ~~**未接任何真实数据源**~~：**已接 PostgreSQL 17**（`pg@8.23.1`，D-71）；各工具未配置时注册
   `NOT_CONFIGURED` 占位，不退回样例数据（`src/index.ts` 的 `unconfigured*` 分支）。
3. **未做服务端授权**（Actor × Scope × Mandate）：`docs/09 §5.3` 要求「工具必须服务端授权」。
   现状是写工具用 `withActor`（`SET LOCAL recruitment.actor_id`）+ 人类闸门（D-79/D-95），
   没有通用 RBAC 层（v1.0 无权限矩阵，D-33）。
4. **没有结构化 `error.info`**：见 §0 / §2.2，受限于无法 import `HarnessError`。
5. **`max_blocks` / `block_types` 的过滤只作用于返回集**，不会改变 `blocks[].index`（刻意保持
   原始序号，便于回链到原文）。这条仍适用于现行 `resume_read`。
6. ~~**未做 client 半部分**~~：**现有浏览器半部分**（`dsh.client.platform=web` + `lib/client.js`，
   工作台面板 `src/client/`）；§0.1 第 5 条。

---

## 9. 自检怎么跑

> **2026-11-14 更正**：`test/harness.mjs` **已不存在**，本条原命令不可复跑。当前自检入口：

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
node --test        # 全量；报 tests / pass / fail / skipped 四个数，skipped>0 不算绿
```

运行时验收（R2/R3）见 `evidence/`：`r2-tool-reachability-2026-11-13.md`、
`experiments/2026-11-13-web-browser-acceptance/`、`experiments/2026-11-14-workbench-panel/`。

`test/` 不进 `package.json` 的 `files`，不会被当成插件运行时的一部分。
