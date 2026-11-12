# S6→S7 验收报告（2026-11-13）

**HEAD**：`55fb8a4`（`main`，已 push 到 `origin/main`）
**本轮交付 commit**：`c984aa0` `4f4a694` `10adbc8` `2def9aa` `6ba5e75` `ea8204f` `8b54a27` `55fb8a4`
**结论**：**NO-GO**（一条硬缺陷，见 §7）。其余 Gate 已成立，缺陷修掉即可转 GO。

---

## 1. 本轮让哪一段招聘工作可以自动完成了

**从一份 PDF 简历到一条带证据的初筛建议，Agent 自己走完了，人只在真正需要判断的地方出现。**

具体：PDF → 转换器读文本/页码/坐标 → 序列化成带 id 的行 → **DSH Agent 自己**按契约做语义结构化 →
独立证据校验（会拒绝、模型会改、改对才通过）→ 写 Candidate / Application → 读 Job/Rubric →
出 `NEEDS_REVIEW` + 具体待核实项。全程 6 次工具调用，**人没有逐步指挥**。

---

## 2. 真实执行 trace（一条命令，一次跑完）

```powershell
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile rec-agent-test "<读契约 → serialize → 结构化 → validate → intake → screening_evaluate>"
```

会话日志里逐条（`type=="tool/call"` / `type=="tool/result"`）：

| # | 工具 | 结果 |
|---|---|---|
| 1 | `read` ×2 | 读了 `contracts/prompt.md` 与 `contracts/schema.json`（契约由 Agent 自己取，不是我们塞进 prompt） |
| 2 | `recruitment_resume_serialize` | `serialized resume.pdf: 47 lines from 47 blocks` |
| 3 | `recruitment_structure_validate` | 第 1 次 `accepted=false rejections=2`：`BLOCK_IDS_NOT_CONSECUTIVE`（education 引用了 24,25,30 三个不连续块） |
| 4 | `recruitment_structure_validate` | 第 2 次 `accepted=false rejections=2`：`BLOCK_IDS_NOT_SUPERSET`（条目的 block_ids 没覆盖 fact 引用的 30） |
| 5 | `recruitment_structure_validate` | 第 3 次 **`accepted=true rejections=0 issues=0`** |
| 6 | `recruitment_application_intake` | `application_id=bc2f582b-6b38-48fa-900e-8ffa568f503c`，`candidate_id=c110817b-b09b-472f-b6a8-a09c1ceabe2f` |
| 7 | `recruitment_screening_evaluate` | `verdict=NEEDS_REVIEW`，`required_human_action=REVIEW_UNREADABLE` |

**第 3–5 步是 Gate B 的核心证据**：校验器真的拒绝了模型两次，模型按 rejections 改对才通过。
这不是"测试替身全过"，也不是"模型说什么就是什么"。

> **⚠️ 2026-11-13 02:47 更正（重要）**：上表这两次拒绝，**根因是校验器过度严格，不是模型的错**。
> 契约 `$comment` 第 (3) 条只要求「字段级 `block_ids` 是条目 `block_ids` 的超集」，
> 并没有要求字段级列表**必须相邻**；而旧校验器把"值匹配必须连续"这条规则错误地套到了字段级列表上。
> 模型给出的形状（`sections` 里含 `{label:"education", block_ids:["26"], ignored:{reason:"empty_or_symbol_only"}}`、
> `fields.education.block_ids=["24","25","30"]`）**是契约合法的**，却被判 `BLOCK_IDS_NOT_CONSECUTIVE`。
> 模型随后"通过"的方式是把 26 从 `ignored` 里拿出来——那是**违反 prompt §4.1（符号块必须 ignored）**换来的，
> 不能算对齐。
>
> 修好之后（`validate.ts` 字段级列表改为只要求"升序不重复" + 新增 `BLOCK_IDS_NOT_SUPERSET` 补回强度），
> **同一份契约合法形状第一次就 `accepted=true rejections=0`**，且 `ignored` 保住了。
> 也就是说：Gate B 真正成立的是**改后**那一次，不是改前那一次。


---

## 3. 转换输出 ↔ 结构化结果 的证据对应

- 转换器给 47 个 block，每个带 `page` / `bbox` / 原件 `sha256`（`c6ceb2ee…`）。
- 结构化结果的每个 fact 都带 `block_ids`；校验器逐条核对「值必须是所引块文本的逐字子串」。
- 第 3 次通过时的拒绝归零，说明 **9 个 section 覆盖了全部 47 块**、五个字段的每个值都能回到具体块。
- 拒绝的两轮本身就是证据：`BLOCK_IDS_NOT_CONSECUTIVE` / `BLOCK_IDS_NOT_SUPERSET` 都是**位置级**错误，
  说明校验器看的是"值能不能在原文里找到"，不是"字段填没填"。

---

## 4. PostgreSQL 真实读回（PII 打码）

```
candidate c110817b  姓名 孙***  手机 +861****  邮箱 @163.com  identity_status=ACTIVE
application bc2f582b  job DEMO-BE-001  stage=S6  lifecycle=ACTIVE
decision_rows = 0     ← 没有任何决策被 Agent 代替
```

---

## 5. 测试

| 范围 | 结果 |
|---|---|
| 插件全量 `node --test`（带真库） | **tests 222 / pass 222 / fail 0 / skipped 0** |
| `test/structure`（结构化层） | 74 / 74 / 0 / 0（基线 67，新增 7 条契约形状负向） |
| 转换器 `pytest`（有语料） | 80 passed / 0 failed / 0 skipped |
| 转换器 `pytest --no-corpus` | 54 passed / 0 failed / **26 skipped**（缺语料时 fail-fast 仍是 exit 2，两个方向都实测） |
| 独立校验器全量 | 45 份 `TOTAL 45 passed=45 failed=0`；84 份 `83 passed / 1 failed`（`talent_pool-28` 是**修前既有**缺陷，触发条件不同） |
| DB 迁移 0001→0008 | 全 exit=0；7 个 verify 全 PASS；0008 第二遍 exit=0 |
| GitHub Actions | `compile` / `db` / `plugin` / `python-lanes` 四 job（`plugin` 现在自带 postgres service） |

---

## 6. 已成立的部分（逐条对应指令 Gate）

- **Gate A 转换器可复用** ✅ 普通简历正常读取、页码/坐标/来源完整、独立校验通过；
  D-55（同一 URL 印两遍）已修：`唐乐` 2799→2825、`tangle` 1836→1887 两处修后均 `passed=true`，
  45 份全量 45/45。**未解决**：`talent_pool-28`（fallback label 已印、URI 未印，多 11 字）——修前既有，需扩裁定。
- **Gate B 真实 Agent 理解简历** ✅ 真实模型（非替身）、模型自己取契约、产出结构化结果、
  被独立证据校验拒过两次后改对、关键字段可追到原文块、对错误有真实拒绝行为。
- **Gate C S6→S7 业务闭环** ⚠️ **基本成立但有一条硬缺陷**（见 §7）。

---

## 7. 未完成项与真实影响（NO-GO 的原因）

### 7.1 硬缺陷：重复执行会重复创建 resume_version + application（P0）
同一候选人在同一岗位下出现了**两条 application**：

```
application 00d0f6c0  created 01:52:42  resume_version 276908da
application bc2f582b  created 02:41:41  resume_version 31ced60b
```

两次都是同一份 PDF（同一 `sha256`）。也就是说 intake 的幂等没有覆盖"同一材料 + 同一岗位"的重复接入，
而是各自造了一条 `resume_version` → 各自一条 `application`。
**这直接违反 Gate C 的「重复执行不会无故重复创建候选人或申请」**，也是本项目历史上最典型的"看起来跑通了"。

影响：真实使用中，同一份简历被重复投递/重复扫描会产生多条申请，初筛、面试、决策都会分裂到不同 application 上。

### 7.2 其它未完成（不阻塞 Gate C，但要如实记）
- `screening` 的真实 verdict 只有 `NEEDS_REVIEW`：这份 PDF 的 `work_experience`/`education` 在转换器侧是
  `unreadable`（顺序不可信 / 条目不可切分）。PASS/FAIL/INDETERMINATE 由集成用例在真库事务内覆盖，
  **没有**一份真实简历跑出过 PASS。
- `read_image` 需要模型声明 image 输入：`beam-free` **不行**（实测被 route gate 拒），
  视觉兜底链路要用 `longcat-2.5-free`。这不是插件能兜的，接点在 profile 的 `agent-default-model`。
- 视觉兜底的合并产物不落盘、临时 PNG 不清理。
- `confirmed_at` 仍来自调用方（服务端只能校验窗口，不能证明"这一秒是人点的"）。
- Web GUI 会话未验证（只验了 headless）。

---

## 8. 下一轮最值得推进的招聘业务能力

1. **修 §7.1 的幂等**（唯一 P0）：intake 的幂等键必须覆盖"同一材料 + 同一岗位"，
   重复接入要复用已有 `resume_version` 与 `application`，并给出 `created=false`。
2. **一份能跑出 PASS 的真实简历**：现在只有 `NEEDS_REVIEW`。这需要一份版式干净、
   顺序可信的简历走完同一条链——否则"初筛能出通过结论"这件事从未被证明。
3. 之后才是 S8（排期）/ S10（面评与决策）的工具实现。
