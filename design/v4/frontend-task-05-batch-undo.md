# 前端任务书 05 · 批量不通过 + 5 秒撤销（接真实接口）

> 收件人：前端实现窗口（云端，读仓库）。发件人：总控。日期：2026-11-19。
> 前置：任务 04 已并库（`60ff071`）；后端两条新接口已就绪（`96d4305`）。

---

## 0. 红线（不变）

视觉/交互不许改；不新增按钮（批量不通过与撤销的入口**原本就在**，只是现在接了真实接口）；失败一律人话，不显示错误码。

---

## 1. 本轮做两件事

### T5-1 批量不通过（把 `batch_reject` 从 `NOT_AVAILABLE` 名单里摘掉）
- 位置：岗位漏斗里勾选多位候选人 → 现有的"批量不通过"确认卡；
- 提交：`POST /recruitment/api/action/decision/batch-reject`
  ```json
  { "application_ids": ["<uuid>", "..."],
    "reason": "<必须包含该岗位 rubic 的 dimension_key，见契约>",
    "confirmation_text": "<人的原话>" }
  ```
- 返回 **200**（部分失败也是 200），逐条结果在 `results[]`：成功/失败分别展示；
  **失败的逐条显示人话原因**（用 `message`，不显示 `reason_code`）；
- 为什么失败要逐条：可能"这个人已不在可决策状态"，不能整批假装成功。
- 幂等：重复点同一批不会再产生第二条决策（后端保证），前端按钮仍要防连点。

### T5-2 5 秒撤销
- 任何写操作成功后的 Toast 里，**「撤销」按钮接真实接口**（不要再显示 `NOT_AVAILABLE`）：
  `POST /recruitment/api/action/undo`，body `{ "action_id": "<写操作返回的 action_id>", "confirmation_text": "<人的原话>" }`
- 结果：
  - `status:'undone'` → 提示"已撤销"并刷新；
  - `409 ALREADY_UNDONE` → "这条已经撤销过了"；
  - `409 UNDO_WINDOW_EXPIRED` → "超过 5 分钟，不能再撤销"；
  - `409 UNDO_SUPERSEDED` → "这条已经被后续操作覆盖，不能撤销"；
  - 全部人话，不显示码。
- **不物理删除**：前端不要做本地移除，一切以刷新后的服务端状态为准。

---

## 2. 交付

```
dsh/dsh-recruitment/src/client/**（改动文件，保持仓库路径）
design/v4/task-05-NOTES.md   # 改了什么、引用点 file:line、哪些没自测
```

不许改 `src/http/**`、`src/tools/**`、`db/**`、`docs/**`；不许新增按钮。

---

## 3. 我这边的验收

1. 真 Host + 真库：勾 2 人批量不通过 → 200 + psql 读回两条 decision（或逐条如实失败）；
2. 写操作后点撤销 → 旧决策行保留且 `superseded_by` 非空、新补偿决策存在（**不删历史**）；
3. 重复撤销 → 人话"已经撤销过了"，零写入；
4. `grep` 证明 `batch_reject` / `restore_snapshot` 不再是 `NOT_AVAILABLE`（若确实接上了）。
