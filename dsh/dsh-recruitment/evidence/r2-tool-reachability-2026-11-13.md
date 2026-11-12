# R2 证据 · 插件工具从运行中的入口真的可达（2026-11-13）

**为什么单独记一份**：本项目的历史失败模式是「类型对、路由在、单测绿，但运行入口根本不调用」。
插件此前 68 条单测全绿，却**从来没有被 DSH 运行时调用过一次**。
这份文件记录第一次真实调用，以及它当场暴露的缺陷。

---

## 1. 环境与入口

| 项 | 值 |
|---|---|
| DSH | `dsh --profile rec-agent-test`（headless，`@deepseek-ai/dsh-headless`） |
| profile 配置 | `D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml` |
| 插件 | `@recruitment/dsh-recruitment`（`link:D:/12412/dsh工作区/projects/recruitment-agent/dsh/dsh-recruitment`） |
| 模型 | `opencode-go-openai-key2` / `beam-free` |
| 输入 PDF | `converter/corpus/synthetic/platform_noise.pdf` |

**入口可达的第一层证据**（配置树里真的有这一行，且被 profile 的 patch 覆盖）：

```powershell
dsh --profile rec-agent-test --dump-config
# == @recruitment/dsh-recruitment, patched by D:\12412\dsh-home\profiles\rec-agent-test\cordis.patch.yml
# - id: recruitment
#   name: '@recruitment/dsh-recruitment'
#     converter_dir: D:\12412\dsh工作区\projects\recruitment-agent\converter
#     allowed_roots:
#       - D:\12412\dsh工作区\projects\recruitment-agent\converter\corpus\synthetic
```

---

## 2. 第一次真实调用 —— 失败（这是本文件存在的理由）

```powershell
dsh --profile rec-agent-test "调用 recruitment_resume_read 工具，path 参数为 ...platform_noise.pdf ..."
```

会话日志（`$DSH_HOME/sessions/--D-12412-dsh~5DE5~4F5C~533A-projects-recruitment-agent--/<id>/session.v3.jsonl.zstd`）里：

```json
{"type":"tool/call","data":{"name":"recruitment_resume_read",
  "arguments":"{\"path\":\"...platform_noise.pdf\"}"}}
{"type":"tool/result","data":{
  "error":{"name":"ToolOutputError","code":"INVALID_TOOL_OUTPUT"},
  "message":{"content":[{"type":"tool-result","content":[{"type":"text",
    "text":"Error: tool \"recruitment_resume_read\" returned invalid output: \"value.fields.work_experience.value\" must be a string; \"value.fields.education.value\" must be a string"}],
    "isError":true}]}}}
```

**根因**：`toFieldValue()` 在 `absent` / `unreadable` 时返回 `value: null`，而输出 schema 声明
`value: { type: 'string' }`。DSH 的 JSON Schema 子集**不支持 type 数组**：

```text
dsh-tools/lib/types/json-schema.js:245
  Array.isArray(type)
    ? `${path}.type must be a single type string (type arrays are not supported)`
```

所以 `string | null` 无法表达，`null` 只能靠**省略这个键**来表达。

**这个缺陷单测抓不到**：68 条测试全部在 `test/structure/`，只测序列化与校验两个纯函数，
从来没有调用过任何工具的 `execute()`，更没有把返回值丢给 schema 校验。

---

## 3. 修好之后 —— 五个工具逐个真实调用

同一条命令，一次跑完五个工具（`dsh --profile rec-agent-test`，真实模型，真实子进程，真实 PDF）：

| # | 工具 | 真实结果（会话日志原文节选） |
|---|---|---|
| 1 | `recruitment_resume_read` | `ok`：`pages=1 backend=pymupdf/1.28.0 completeness=partial order_verified=false`；`fields: name present / phone present / email present / work_experience unreadable (reading_order_unverified) / education unreadable (entries_not_segmentable)`；`issues: unverified_pdf_image, platform_noise_excluded, resume_attribution_unverified, resume_timeline_unparsed` |
| 2 | `recruitment_resume_serialize` | `ok`：`47 lines from 47 blocks (truncated)`，`#doc | pages=1 | completeness=partial | order_verified=false ...`，随后是 `#1 | p1 | ...` 编号行 |
| 3 | `recruitment_structure_validate` | `ok`：`accepted=false rejections=48 issues=48`，首条 `REJECT SCHEMA_INVALID: result.sections is required (an empty array is allowed)`，其余 `REJECT UNCOVERED_BLOCK: block N (page 1) is neither placed in a section nor ignored with a reason` |
| 4 | `recruitment_candidate_get` | `ok`：`Error: NOT_FOUND: candidate "0000…" not found; known stub ids: candidate_0001, candidate_0002` |
| 5 | `recruitment_job_get` | `ok`：`Error: NOT_FOUND: job "0000…" not found; known stub ids: job_0001, job_0002` |

（`candidate_get` / `job_get` 仍是 stub —— 它们返回 `NOT_FOUND` 是**当前设计**，不是缺陷；
真实 PG 接线是 S6/S7 lane 的工作。这里证明的是「运行时能调到、输出能过 schema 校验」。）

---

## 4. 结论与仍然没做到的事

**成立**：5 个工具全部从真实运行入口（DSH headless 的 agent loop → tool registry → `execute()`）
被调用过，返回值为 `ok`，输出通过注册表的 schema 强制校验。

**不成立 / 仍 BLOCKED**：

1. `candidate_get` / `job_get` 仍是 stub（FIXTURE 数据），没有连 PG。
2. `resume_read` 的 `render` 只输出摘要，不输出 block 正文——模型想看正文要调 `resume_serialize`。
3. 这次 smoke 用的是 `platform_noise.pdf`，它虽放在 `corpus/synthetic/`，内容却是**一份真实简历**
   （带真实姓名/手机号/邮箱）。合成语料目录里混入真实资料是**缺陷**，应替换成真正合成的页面。
   该 PDF 未入库（`.gitignore: converter/corpus/synthetic/*.pdf`），不构成仓库泄漏。
4. 没有做失败路径的负例矩阵（只有 `structure_validate` 的 `{}` 一个负例）。
