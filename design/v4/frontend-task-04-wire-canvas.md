# 前端任务书 04 · 把画布和写入口真正接上（收尾）

> 收件人：前端实现窗口（云端，读仓库）。发件人：总控。日期：2026-11-19。
> 前置：任务 03 已并库（`be96d7b`）。
> **总控复核结论：交付的代码能编译，但有两处"定义了没人用"，等于没接上。**

---

## 0. 总控复核发现（必须先修）

| # | 现象 | 后果 |
|---|---|---|
| **R1** | `src/client/canvas/canvas-actions.ts` **没有任何文件引用它** | 被 tree-shake，四个写入口在前端**实际不可达** |
| **R2** | `CanvasPanelHost` **没有调用点** | v4 画布**仍然进不去**（点候选人还是老详情页） |

---

## 1. 本轮做三件事

### T4-1 画布入口：点候选人行 → 打开 v4 画布
- 在「招聘总览 → 候选人漏斗」里点一行，主画布区渲染 `CanvasPanelHost`/`CanvasRoute`（`applicationId` = 该行申请 id）；
- **不要用 hash**（DSH 外壳自己占用 hash，实测会被切走）；
- 返回按钮回到列表；
- **不新增侧栏项、不改三栏骨架**；
- 若决定替换现有详情页：把 `ApplicationDetail` 的渲染位换成 `CanvasRoute`；若并存：加一个"按 v4 画布查看"的入口（放在现有详情页头部，**不新增顶栏按钮**）。

### T4-2 四个写入口接到画布里的确认动作上
`canvas-actions.ts` 已被引用后，把四个函数真的用起来（谁用、在哪用写进 NOTES）：
- 置顶约束：画布内"置顶约束"提交 → `postCandidateConstraint`；
- 下一轮交接追问：→ 同上 `HANDOFF`；
- 新建岗位：→ `postJobCreate`（**不许传 headcount**）；
- 上传简历：→ `uploadResumeRaw`，拿到 `task_id` 后挂 `UploadProgressBanner` 轮询。
每个提交：点击瞬间 `disabled + 处理中…`；成功刷新对应区域；失败显示人话（不显示错误码）。

### T4-3 自测
- 客户端 `npx tsc --noEmit` 必须 0；`npx tsdown` 必须构建通过；
- 交付前用 `grep` 自查：`canvas-actions` 与 `CanvasPanelHost` **各自至少有一个真实引用点**（把 grep 结果贴进 NOTES）。

---

## 2. 交付

```
dsh/dsh-recruitment/src/client/**（改动的文件，保持仓库路径）
design/v4/task-04-NOTES.md   # 改了什么、引用点在哪（file:line）、哪些没自测
```

**不要**改后端 `src/http/**`、`src/tools/**`、`db/**`、`docs/**`；不要新增按钮/侧栏项。

---

## 3. 我这边的验收

1. 真 Host + 真库，浏览器点候选人行 → 画布出现（截图 1440/390）；
2. 画布里点"置顶约束" → 200 + psql 读回 `candidate_constraint` 新行；
3. 上传一次 → 顶部进度 → 完成后候选人出现（不抢当前画布）；
4. `grep` 证明两个符号都有引用点；`tsc`/`tsdown` 绿。
