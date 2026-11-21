# 前端任务书 06 · 面试官视角对照 v4（前简报 / 速记 / 追问）

> 收件人：前端实现窗口（云端，读仓库）。发件人：总控。日期：2026-11-19。
> 前置：任务 05（与本文一起发）。后端并行在补三个接口（见 §1 标注 🔄），**契约已冻结**，照下面写即可。

---

## 0. 红线

- 视觉按 `design/v4/contracts/design-tokens.md`；**不新增按钮/开关**；
- 界面不出现内部 id / 字段名 / 哈希 / 错误码；
- 空态与失败一律人话（"还没有转写""这项还没接通"），不许留白也不许假数据。

---

## 1. 面试官进入后应该看到什么（对照 v4）

### T6-1 面前简报（一屏看完，不用点开）
数据来自 `GET /recruitment/api/interviewer/overview`（已有）与 `GET /recruitment/api/interviewer/interviews/:id`（已有，正在补字段 🔄）：

| 区块 | 字段 | 说明 |
|---|---|---|
| 候选人 + 岗位 + 轮次 | 既有 | 轮次用 `round_focus.label`（若有） |
| **置顶约束** | `constraints[]`（🔄 本次补） | `{ kind: 'PIN'\|'HANDOFF', text, source, from_previous_round }`；PIN 常驻，HANDOFF 标"上一轮留的" |
| 本轮重点 | `round_focus`（已有） | objective / focus_dimensions / questions |
| 上一轮摘要 | 既有字段 | 没有就显示"还没有转写/上一轮记录" |
| 岗位标准维度 | `rubric[]`（既有） | 逐条展示，**不求平均分** |

### T6-2 面后速记（自动保存，不丢）
- 文本框：边写边**防抖 2 秒**自动存草稿：
  `POST /recruitment/api/action/scorecard/draft`（🔄 本次新增）
  ```json
  { "interview_id": "<uuid>", "payload": { "assessments": { "<criterion_key>": "MET|NOT_MET|NOT_OBSERVED|UNREADABLE" }, "note": "..." } }
  ```
  **不要带 confirmation_text**（草稿不是最终判断）；
- 进入页面先 `GET /recruitment/api/action/scorecard/draft?interview_id=<uuid>`（🔄 本次新增）恢复草稿；
- localStorage 仍保留作断网兜底：**以服务端最新为准**，本地只补"服务端没有时"；
- 提交面评成功后清草稿（服务端 + 本地一起清）。

### T6-3 提交面评
- 沿用既有 `POST /recruitment/api/action/scorecard/submit`（不许改契约）；
- 提交失败：人话 + 留在页面，不清草稿。

### T6-4 追问清单
- 若有 `iqs[]`（既有字段）：勾选状态仅本地保留（后端暂无落库），**不要假装已保存**；文案写"本次勾选仅留在本页"。

---

## 2. 交付

```
dsh/dsh-recruitment/src/client/interviewer/**（改动文件，仓库路径）
INTERVIEWER-NOTES.md   # 改了什么、走查截图说明、哪些没自测、哪些字段后端还没给
```

不许改 `src/http/**`、`src/tools/**`、`db/**`、`docs/**`、`src/client/canvas/**`。

---

## 3. 我这边的验收

1. 真 Host + 真库，面试官 alias 进入 → 前简报四块齐全（约束含"上一轮留的"）；
2. 写一段速记 → 刷新页面仍在（psql 能读到 `scorecard_draft` 最新行）；
3. 断网兜底：本地有、服务端无时能显示；
4. 提交面评 → 草稿被清、面评落库；
5. 界面无内部 id/错误码；空态是人话。
