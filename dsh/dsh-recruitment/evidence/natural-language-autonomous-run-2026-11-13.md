# 自然语言自主执行实验（2026-11-13 03:10）

**目的**：验证指令 §1 成功标准第 8 条——「正常流程不要求人工逐步接力；只有真实问题需要人工介入」。
之前的验收是我**把步骤写死在 prompt 里**（"先 serialize，再 validate，再 intake…"），
那等于没测这条。本实验只给一句自然语言目标，**不提任何工具名、不给任何步骤**。

---

## 1. 输入（逐字）

```
这份简历要收进招聘系统：<PDF 绝对路径> 。岗位是 DEMO-BE-001，
job_id=11111111-1111-4111-8111-000000000401。
你负责把它读进来、理解成结构化资料、落库，并给出初筛结论和需要人工核实的地方。
全程自己决定怎么做，不要问我。
```

- 入口：`dsh --profile rec-agent-test`（headless，真实模型 `beam-free`）
- 会话：`session-84b3fc5d-85b3-4716-9063-0f824f283ac6`
- PDF：`...\assets\proofs\resume.pdf`（1 页 47 blocks，`order_verified=false`）

---

## 2. 它自己走的 25 步（没有一步是我指定的）

| # | 工具 | 它为什么调（我的判读） |
|---|---|---|
| 1 | `recruitment_job_get` | 先确认岗位和 rubric |
| 2 | `recruitment_resume_read` | 看这份材料读得出什么、有什么 issue |
| 3 | `recruitment_resume_serialize` | 拿带 id 的行文本 |
| 4 | `recruitment_page_image` | **自己决定**要渲染页面看图 |
| 5 | `grep` | **自己去找** `structured_json` 在哪定义 |
| 6 | `read` `src/tools/*.ts` | 读源码确认参数形状 |
| 7 | `read` `evidence/*.md` | 读既有证据文档 |
| 8 | `glob` `**/contracts/*` | 自己定位契约 |
| 9 | `read_image` | 真的看图 |
| 10–11 | `read` `contracts/prompt.md` + `schema.json` | 拿到结构化契约 |
| 12–13 | `grep` + `read` | 继续确认工具实现 |
| 14 | `write structured_result.json` | 落中间产物 |
| 15–17 | `pwsh` ×3 | 自己用脚本检查 JSON |
| 18–22 | `recruitment_structure_validate` ×3 | 被拒 → 自己改 → 再验，直到 `accepted=true` |
| 23 | `recruitment_application_intake` | 落库 |
| 24 | `recruitment_screening_evaluate` | 出初筛结论 |
| 25 | `recruitment_candidate_get` | 回查候选人再写报告 |

---

## 3. 它自己给出的结果（HR 可读）

结论 + 6 条「需要人工核实」：

1. **教育信息的坐标/版面**：学校、专业、起止日期分散在不同 block，需人工确认是否同一教育条目；`degree` 原文未写明。
2. **工作经历**：简历只有项目/科研/竞赛，无全职任职；确认是否应视为应届/实习，或存在未展示的工作经历。
3. **阅读顺序不可信**：单页复杂版式，转换器判定 `order_verified=false`；建议人工对照原 PDF 核对分区。
4. **奖励/科研细节**：竞赛、论文（S-PDR，第三作者/学生二作）、大创项目仅文本层提取，需核实作者顺序与成果真实性。
5. **联系方式与个人网站**：需确认可访问与归属（内容已打码）。
6. **后续动作**：如要覆盖已有版本，因幂等 replay 不会改写已存在 `resume_version`，需按产品策略选择更新旧版本或新建版本；落 decision 前先钉 rubric 版本。

---

## 4. 结论

**第 8 条成立**：一句自然语言目标，Agent 自己完成了
「读 → 看图 → 找契约 → 结构化 → 被拒后自纠 → 落库 → 初筛 → 回查」，没有人工逐步接力。

**但这次 trace 暴露了一个真设计缺口**（第 5–13 步）：

> Agent 为了搞清楚 `structured_json` 这个参数，**去 grep 源码、读 `src/tools/*.ts`、读 evidence 文档**。

也就是说：**工作流知识与工具参数说明散在源码和证据文件里，而不是一个 agent 能找到的地方。**
一个自解释的系统不该让模型读我们的实现代码才知道怎么用工具。

**修法（复用，不自研）**：用 DSH 已有的 skill / agent instruction 机制，
给 profile 注册一份「简历接入 → 结构化 → 落库 → 初筛」的工作流说明；
同时把关键参数（`structured_json` 的形状）写进工具描述，别让模型去 grep 源码。
这两件做完，第 8 条才算**稳定成立**，而不是"这次恰好蒙对了"。

**仍未成立的第 7 条**：这次输出只是 headless 的文本，**没有 HR 面向的入口**。
