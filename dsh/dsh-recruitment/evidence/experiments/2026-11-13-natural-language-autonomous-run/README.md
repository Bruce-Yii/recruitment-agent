# 实验 2026-11-13 · 自然语言自主执行（S6→S7）

**目的**：验证指令 §1 成功标准第 8 条 ——「正常流程不要求人工逐步接力」。
之前的验收是我把步骤写死在 prompt 里，那等于没测这条。本实验只给一句自然语言目标。

| 项 | 值 |
|---|---|
| 时间 | 2026-11-13 03:10 (+08) |
| 入口 | `dsh --profile rec-agent-test`（headless） |
| 模型 | `opencode-go-openai-key2` / `beam-free` |
| 会话 | `session-84b3fc5d-85b3-4716-9063-0f824f283ac6` |
| PDF | `...\resume-talent-pool\.snap-cache\...\assets\proofs\resume.pdf`（1 页 47 blocks） |
| 岗位 | `DEMO-BE-001` / `11111111-1111-4111-8111-000000000401` |
| 结果 | 自主完成；结构化 `accepted=true`；`application bc2f582b`；初筛 `NEEDS_REVIEW` |

## 完整材料

- `transcript.txt` —— **完整会话**（2,318 行 / 189,451 字节）：USER / REASONING / TOOL-CALL（完整参数）/ TOOL-RESULT（完整返回）
- `dialogue-only.txt` —— 只有 USER + 完整 REASONING + 完整 ASSISTANT（62,357 字节），便于人读
- `commands.txt` —— 复现命令原文
- `db-readback.txt` —— 数据库读回

## 输入（逐字）

```
这份简历要收进招聘系统：<PDF 绝对路径> 。岗位是 DEMO-BE-001，
job_id=11111111-1111-4111-8111-000000000401。
你负责把它读进来、理解成结构化资料、落库，并给出初筛结论和需要人工核实的地方。
全程自己决定怎么做，不要问我。
```

**没有提任何工具名、没有任何步骤。**

## 它自己走的 25 步

| # | 工具 |
|---|---|
| 1 | `recruitment_job_get` |
| 2 | `recruitment_resume_read` |
| 3 | `recruitment_resume_serialize` |
| 4 | `recruitment_page_image` |
| 5 | `grep`（自己找 `structured_json` 在哪定义） |
| 6 | `read` `src/tools/*.ts`（读源码） |
| 7 | `read` `evidence/*.md` |
| 8 | `glob` `**/contracts/*` |
| 9 | `read_image` |
| 10–11 | `read` `contracts/prompt.md` + `schema.json` |
| 12–13 | `grep` + `read` |
| 14 | `write structured_result.json` |
| 15–17 | `pwsh` ×3（自己检查 JSON） |
| 18–22 | `recruitment_structure_validate` ×3（被拒 → 自纠 → `accepted=true`） |
| 23 | `recruitment_application_intake` |
| 24 | `recruitment_screening_evaluate` |
| 25 | `recruitment_candidate_get` |

## 结论

**第 8 条成立**：一句自然语言目标，Agent 自己完成
「读 → 看图 → 找契约 → 结构化 → 被拒后自纠 → 落库 → 初筛 → 回查」，没有人工逐步接力。

## 这个实验暴露的问题（必须写，只写成功等于没记录）

1. **`recruitment_job_get` 还是 stub**：给真实 UUID，它回 `job "…" not found; known stub ids: job_0001, job_0002`。
   Agent 只好在推理里写 "job_get 可能仅 fixture，not worry" 跳过。**链路上有一个坏工具。**
   之前的验收没发现，因为我从没让 agent 自己调它。

2. **`beam-free` 不能看图**：Agent 自己发现并放弃 `read_image`
   （"beam-free cannot read images; need longcat-2.5-free… We cannot use read_image"）。
   视觉兜底在这条默认路由上是 BLOCKED，不是"没测"。

3. **校验器的过度严格逼模型违反契约**：Agent 明确写出
   "cannot include ignored block. Need another way. **Could make block 26 not ignored?**"。
   它最终是通过**违反 prompt §4.1（符号块必须 ignored）**通过的。
   这条校验器 bug 后来才修（字段级 block_ids 不应要求相邻）。

4. **工作流知识散在源码里**：第 5–13 步它在 grep 源码、读 `src/tools/*.ts` 才知道 `structured_json` 怎么用。
   一个自解释的系统不该让模型读实现代码才知道怎么用工具。
   修法：用 DSH 的 skill / agent instruction 机制注册工作流说明（复用，不自研）。

5. **结构化结果没落到这次运行**：intake 返回 `replayed`（同 sha 已被前一次建过），
   replay 路径不补写 `structured_json`，所以这次 `accepted=true` 的结构化结果**没有进库**。
   （库里的 `parsed_fields.structured` 来自 18:41 那次运行。）

## 仍未成立的第 7 条

这次输出只是 headless 文本，**没有 HR 面向的入口**。
