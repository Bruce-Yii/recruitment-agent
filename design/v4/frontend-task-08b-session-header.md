# 前端任务书 08b · 画布写请求缺少会话头（P0，所有写入口 400）

> 来源：真点验收 `--fresh` 复跑（`work/d5/e2e-real/TOOLING-REPORT.md`）。
> 结论：**任务 08 的入口、弹窗、填值、提交按钮全部真点成功，但库零写入**——服务端一律返回
> `400 SESSION_REQUIRED：缺 X-DSH-Session 请求头（身份只来自当前 DSH Session）`。

## 1. 根因（已定位到文件）

`dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts` 的写请求只带：
```ts
headers: { 'x-recruitment-request': '1', Accept: 'application/json', 'Content-Type': 'application/json' }
```
**没有 `X-DSH-Session`**。对照：
- 旧客户端 `src/client/interviewer/http.ts` 明确有 `const SESSION_HEADER = 'X-DSH-Session'` 并随请求发送；
- 旧写动作 `src/client/recruiting/actions.ts` 的 `postActionSeam(action, request, props.sessionId)` 也带 session；
- 而 `RecruitingWorkspace`（props 里有 `sessionId`）渲染 `CanvasPanelHost` 时**没有把 sessionId 传下去**，画布内部也从未引用 sessionId。

所以：**入口接好了，但身份没带**，服务端按 fail-closed 拒绝。这不是后端问题，也不是"权限没配"。

## 2. 修法（一条链，5 处）

1. `recruiting/RecruitingWorkspace.tsx`：渲染 `<CanvasPanelHost sessionId={props.sessionId} ...>`（props 里已有）；
2. `canvas/CanvasRoute.tsx`：`CanvasPanelHost` / `CanvasRoute` props 增加 `sessionId: string`，向下传给 `CandidatePage` / `JobPage`；
3. `canvas/CandidatePage.tsx` / `canvas/JobPage.tsx` / `canvas/CandidateActionModal.tsx`：所有调用 canvas-actions 的写函数都传 `sessionId`；
4. `canvas/canvas-actions.ts`：所有**写请求**（含上传、初筛、决策、阶段、转写导入、排期、NO_SHOW、星标、发信、设置写入、撤销、批量）统一加头：
   ```ts
   headers: { ..., 'X-DSH-Session': sessionId }
   ```
   `sessionId` 为空时**不发请求**，直接按既有话术提示"请先在工作台顶部选择身份"（fail-closed，不许用匿名请求撞服务端）。
5. 只读 GET（overview / 详情 / 空闲时段 / 任务状态）若服务端不需要可不动；**写请求必须全带**。

**纪律**：`sessionId` 只从 props 来，不读 localStorage、不从 URL 取（沿用旧客户端注释里的约束）。

## 3. 验收（我会按这个重跑，缺一不算过）

1. `npx tsc --noEmit` 0、`npx tsdown` 通过；
2. `runbook --fresh` 重跑，目标：
   - S4 初筛结论：界面确认 → `decision`（screening scope）行 +1；
   - S5 约面：界面提交 → `interview` + `interviewer` 行 +1；
   - S6 改期：同一 interview id，`record_version` +1，不新建行；
   - S9/S11 面评：`scorecard` 行 +1（角色为对应面试官），提交后草稿清空；
   - S12 终审：`decision` current 唯一；S13 重复提交提示"已处理过"且不新增；
   - S14 未出席：`interview.status='NO_SHOW'` + `interview.no_show` 事件；
   - S15 冲突：先改一次再提交 → 界面出现"这条刚被别人改过，请刷新"，库零写入；
3. S8：草稿只出现在面试官 A 名下（psql 读 `interviewer_actor_id`）。
4. 自测里给一条**"无 sessionId 时不发写请求"**的证据（代码或测试断言），防止以后又漏。

## 4. 交付

- 分支 + PR（照你新流程，直接推仓库，不用压缩包）；
- `T8B-NOTES.md`：每条写动作的 `file:line`、`X-DSH-Session` 加在哪、哪些没自测；
- **不许**改后端、不许放宽任何断言。
