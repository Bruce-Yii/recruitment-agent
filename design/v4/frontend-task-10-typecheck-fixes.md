# 前端任务 10 · v4 整页类型收口（5 个 tsc 错误）

> **状态**：**已完成**。PR #10（分支 `fix/task-10-app-typecheck`，提交 `2279e08`）已复核并合入 `feat/unified-document-intake`（merge `af0fef5`）；本地 `npx tsc --noEmit`=0，`npx tsdown` 通过，合并后 15 步复跑 15/15，三屏悬停 3/3。证据见 `evidence/fullpage-v4-15step-pr10-20261120/`。

> **给谁**：云端前端窗口（你看不到本地 `work/`、证据和未推送提交；本指令自包含，按仓库 `feat/unified-document-intake` 当前 `src/app/**` 即可动手）。
> **背景**：总控把 `src/app/**` 真正纳入 `npx tsc --noEmit` 后（此前 v4 前端不在任何 tsconfig 里，属于"假绿"），暴露 **5 个既有类型错误**。15 步真点本身 **15/15 PASS**，与本任务无关；本任务只把类型门禁修绿，不改产品行为。
> **为什么现在**：合并门要求 `npx tsc --noEmit` = 0；这 5 个错不修，后续 15 步证据再全也不能合并。

## 1. 边界（硬约束）

- **只改** `dsh/dsh-recruitment/src/app/JobsView.tsx`、`QueueView.tsx`、`TalentView.tsx`（必要时可在同目录新增一个极小的本地 helper）。本次不动其他文件。
- **不要改**：`src/http/**`、`src/client/**`、`tsconfig*.json`、`scripts/**`、`lib/**`（`lib/app.js` 由本地总控重建，云端无构建链不要动）、`package.json`、`TESTID-MANIFEST.md`。
- **不要**用"把 `src/app` 从类型检查里排除"的方式变绿；不要 `// @ts-ignore` / `any` 兜底。
- **不要**改可见文案/布局/DOM 结构（本任务唯一允许的视觉等价变化是删掉从未生效的 `nextStep.conclusion` 读取）。
- 不装新依赖、不重排无关代码；diff 越小越好。

## 2. 要修的 5 个错误（当前 `feat` 分支 `src/app` 原样）

```
src/app/JobsView.tsx(33,17): error TS2554: Expected 2 arguments, but got 1.
src/app/JobsView.tsx(64,57): error TS2339: Property 'conclusion' does not exist on type 'NextStepView'.
src/app/QueueView.tsx(67,7): error TS2554: Expected 2 arguments, but got 1.
src/app/QueueView.tsx(214,37): error TS2339: Property 'conclusion' does not exist on type 'NextStepView'.
src/app/TalentView.tsx(76,17): error TS2554: Expected 2 arguments, but got 1.
```

### F1 · `prefetchCanvasPath` 少传第二个参数（3 处）

- 定义：`src/client/canvas/canvas-ux.ts:42`
  ```ts
  export function prefetchCanvasPath(path: string, fetcher: (p: string) => Promise<unknown>): void
  ```
  第二参是"怎么取这份 JSON"；少传时悬停预取会在 `setTimeout` 里抛 `TypeError: fetcher is not a function`（控制台报错、预取静默失效，页面不崩）。
- 现状（3 处都是单参）：
  - `src/app/JobsView.tsx:32-34`（岗位行 `onMouseEnter`）
  - `src/app/QueueView.tsx:64-69`（队列行悬停 → `setTimeout` 里调）
  - `src/app/TalentView.tsx:75-77`（人才库行 `onMouseEnter`）
- **推荐修法**（复用 `src/app/api.ts` 已有导出，不新增依赖）：
  - 目标路径都是只读业务 JSON，正好对应 `api.ts` 的 `fetchAppJson(path, sid)`；sid 用 `readCookie('rc_sid')`（同文件已导出）。
  - 每个文件补 import：
    ```ts
    import { fetchAppJson, readCookie } from './api.ts';
    ```
  - 三处调用改为：
    ```ts
    // JobsView.tsx:32-34
    onMouseEnter={() =>
      prefetchCanvasPath(`/recruitment/api/recruiting/jobs/${encodeURIComponent(job.id)}`,
        (path) => fetchAppJson(path, readCookie('rc_sid')))
    }

    // QueueView.tsx:64-69
    hoverTimerRef.current = setTimeout(() => {
      prefetchCanvasPath(`/recruitment/api/recruiting/applications/${encodeURIComponent(app.id)}`,
        (path) => fetchAppJson(path, readCookie('rc_sid')));
    }, 120);

    // TalentView.tsx:75-77
    onMouseEnter={() =>
      prefetchCanvasPath(`/recruitment/api/recruiting/applications/${encodeURIComponent(app.id)}`,
        (path) => fetchAppJson(path, readCookie('rc_sid')))
    }
    ```
  - 说明：`prefetchCanvasPath` 的缓存 key 就是 path，`fetchAppJson` 返回的就是画布读模型需要的同一份 JSON；这样悬停预取从"必抛错"变成真生效，且与画布 `CandidatePage.tsx:152` 的 `prefetchCanvasPath(url, fetcher)` 用法一致。
- 验收：这 3 个 TS2554 消失；浏览器悬停队列/岗位/人才库行，控制台无 `fetcher is not a function`；点进详情仍正常（缓存命中或重新请求均可）。

### F2 · `nextStep.conclusion` 类型里不存在（2 处）

- 类型：`src/client/recruiting/view-model.ts:382` 的 `NextStepView` 只有 `code / label / kind / kindLabel / tone / hasStep`，**没有** `conclusion`；`normalizeNextStep` 也不产出它。
- 现状：这两处读的 `.conclusion` **运行时恒为 `undefined`**，实际一直走后面的 fallback；所以这是"死代码 + 类型错"，不是功能缺失。
- **本次裁决（总控已定，前端照做）**：**删掉 `.conclusion` 读取，保持现有显示行为**，不要新增 VM 字段、不要换用 `label`（换文案属于 UI 变更，另议）。
  ```ts
  // JobsView.tsx:64
  <div className="sec-meta">{'点击进入岗位详情与候选人池'}</div>

  // QueueView.tsx:214
  {app.interviewSummary || app.screeningSummary || app.materialSummary}
  ```
  （QueueView 原表达式 `app.nextStep.conclusion || app.interviewSummary || …` 因 conclusion 恒 undefined，删掉后显示与现在完全一致。）
- 验收：这 2 个 TS2339 消失；队列行副标题、岗位行副标题显示与现在一致。

## 3. 交付方式（云端）

1. 在 `feat/unified-document-intake`（或基于它的修复分支）上只提交上述 3 个文件；
2. 交付时贴：`git diff --stat`、逐文件 diff、以及**如果能跑**的 `cd dsh/dsh-recruitment && npx tsc --noEmit` 输出；跑不了就如实写"云端无依赖，未跑"，不要写"应该能过"；
3. 不要重建/提交 `lib/app.js`（本地总控负责）；
4. 不需要动测试/DB/浏览器（本地总控会跑 15 步复验）。

## 4. 本地总控验收（收到你的 PR 后）

1. `cd dsh/dsh-recruitment && npx tsc --noEmit` → **0 错**；
2. `npx tsdown` → 双入口构建成功（本地重建 `lib/app.js`）；
3. `node scripts/server-typecheck.mjs`、`client-contract-check.mjs`、`entry-reachability.mjs` 仍 PASS；
4. `node work/d5/fullpage/run-v4.mjs --fresh --port 49347` → **15/15**（必要时重跑）；
5. 1440 目检队列/岗位/人才库三屏，悬停无控制台 TypeError。

## 5. 完成后仍待办（不在本任务）

- 画布 file input 加稳定 testid、`TESTID-MANIFEST` 同步、决策弹窗默认值产品确认（见 `design/v4/frontend-fixes-20261120.md`，非阻塞）；
- 对话桥 503、8 条无界面写能力、`docs/38` 同步（另行排期）。
