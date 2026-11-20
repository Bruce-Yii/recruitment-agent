# v4 整页前端修复清单（2026-11-20 · 15 步验收后）

> 来源：v4 15 步真点收口（`evidence/fullpage-v4-15step-20261120/`）后的类型门禁与审计。
> 边界（D-168）：本清单由总控开出，**界面文件由前端窗口修改**；总控只做服务端/构建/验收。
> 说明：15 步本身 **15/15 PASS**，下面第 1、2 组不是 15 步阻塞项；第 1 组是**合并门 `npx tsc --noEmit` 的阻塞项**。

## 1. 必须修（阻塞 `npx tsc --noEmit`；当前 5 错）

### F1 · `prefetchCanvasPath` 单参调用（3 处，TS2554）

- 位置：
  - `dsh/dsh-recruitment/src/app/JobsView.tsx:33`
  - `dsh/dsh-recruitment/src/app/QueueView.tsx:67`
  - `dsh/dsh-recruitment/src/app/TalentView.tsx:76`
- 现状：`prefetchCanvasPath(path)` 只传 1 参；定义在 `src/client/canvas/canvas-ux.ts:42`，签名是 `prefetchCanvasPath(path, fetcher)`（2 参）。TypeScript 报 `TS2554: Expected 2 arguments, but got 1`。
- 实际行为：悬停预取在 `setTimeout` 回调里执行 `fetcher(path)` 时抛 `TypeError: fetcher is not a function`（控制台报错、预取静默失效），页面功能不崩。
- 建议修法（前端二选一，倾向 A）：
  - A. 三处调用补第二个参数，复用画布现有写法（见 `src/client/canvas/CandidatePage.tsx:152`、`JobPage.tsx:166` 的 `fetcher`），例如：
    ```ts
    prefetchCanvasPath(url, (p) =>
      fetch(p, {
        headers: { 'x-recruitment-request': '1', 'X-DSH-Session': sid },
        credentials: 'same-origin',
        cache: 'no-store',
      }).then((r) => r.json()),
    )
    ```
  - B. 若产品确认"v4 整页不需要预取"，删掉三处 `prefetchCanvasPath` 调用（但 `canvas-ux` 的缓存键需与画布读路径一致，删除前确认无其他依赖）。
- 验收：`npx tsc --noEmit` 这 3 错消失；1440 悬停队列/岗位/人才库行无控制台 TypeError；点击进入详情仍走缓存/网络正常。

### F2 · `nextStep.conclusion` 类型不存在（2 处，TS2339）

- 位置：`dsh/dsh-recruitment/src/app/JobsView.tsx:64`、`dsh/dsh-recruitment/src/app/QueueView.tsx:214`
- 现状：代码读 `job.nextStep.conclusion` / `app.nextStep.conclusion`，但 `NextStepView`（`src/client/recruiting/view-model.ts:382`）没有该字段，`normalizeNextStep`（同文件 `:991`）也不会产出 → 运行时恒为 `undefined`，实际一直走后面的 fallback（`interviewSummary || screeningSummary || materialSummary`）。
- 建议修法（前端二选一，倾向 A）：
  - A. 删掉 `.conclusion` 读取，直接用现有 fallback 字段（不新增产品字段，行为不变）。
  - B. 若设计确实要展示"下一步结论"，则：`NextStepView` 加 `readonly conclusion?: string` + `normalizeNextStep` 从服务端 `next_step.conclusion` 取值，并在 `TESTID-MANIFEST`/验收脚本里补锚点。**B 需要产品先确认文案来源**，否则不要造字段。
- 验收：`npx tsc --noEmit` 这 2 错消失；队列/岗位行副标题文案与现在一致（或按产品确认后的新文案）。

## 2. 建议修（非阻塞；本轮未 FAIL）

### F3 · 画布上传 `input[type=file]` 缺稳定 testid

- 现状：候选人画布的上传 input 无 `data-testid`（`src/client/canvas/CandidatePage.tsx:428-443`）；页面上有 2 个 file input（`ChatPanel` 的 `app-chat-upload` 在前），15 步脚本只能用结构选择器 `[data-testid="v4-canvas-route"] input[type="file"]` 定位。
- 建议：给画布 input 加 `data-testid="canvas-candidate-file-input"`（队列级上传 input 建议 `app-upload-file-input`），并同步 `dsh/dsh-recruitment/src/app/TESTID-MANIFEST.md`。
- 影响：只影响自动化稳定性，当前不影响功能（S2 已 PASS，202 + task_id + business_task Δ≥1）。

### F4 · TESTID-MANIFEST 与实际 15 步用到的 testid 有缺口

- 15 步脚本实际依赖、但 MANIFEST §一/§二未登记的稳定 testid/属性：
  `v4-canvas-route`（画布根）、`schedule-mode-create`、`free-slots-grid` / `free-slots-empty`、`decision-facts-loading` / `decision-facts-blocked`、`open-scorecard`、`scorecard-form`、`quick-notes-textarea`、`interviewer-row[data-interview-id]`、`draft-save-hint`。
- 建议：前端在 MANIFEST 补齐（或确认这些属于"复用画布/面试官端"清单），总控据此同步 `docs/38` 的 testid 列。
- 注意：`PLAN §6` 的建议名 `app-action-*` / `app-confirm-submit` / `app-schedule-*` 与实现 `canvas-action-*` / `canvas-modal-submit` / `schedule-*-input` 不一致——以 MANIFEST 为实现口径（PLAN 已注明"以清单为准"），脚本已按实现改。

### F5 · 决策弹窗默认 scope/result（产品确认，非缺陷）

- 现状：`CandidateActionModal.tsx:160-161` 默认 `decisionScope='FINAL'`、`decisionResult='ADVANCE'`，用户不改也能提交；15 步 S12/S13 已记录实际 `.ros-slot-pill.active` 文本，避免"默认值冒充点击"。
- 请产品确认"默认即终审通过"是否刻意；如需强制选择，再开前端任务（不属于 15 步阻塞）。

## 3. 非前端（记录，不在本清单修）

- `/recruitment/agent/turn` 仍 **503 AGENT_UNAVAILABLE**（Agent SSE 桥未接线；页面已降级，业务按钮不受影响）——服务端桥接任务。
- 测试身份显示名与业务 actor 显示名不一致：`/recruitment/app/session` 对 `alias=recruiter` 返回 `display_name=招聘负责人`（alias 标签），而业务读模型 `actor.display_name=演示-HR 专员`（DB actor）。属**测试入口**的服务端显示口径问题，不影响写身份（写库 actor 一致），记录待定是否统一。
- 8 条写能力仍无正式界面入口（compound / config / email authorize·send-authorized / feishu import 等，D-164 残余）；`docs/38` 能力入口矩阵尚未按 v4 testid 同步（下一步）。
- 390 窄屏：按 D-168 不作产品要求。

## 4. 验收方式（前端改完回给总控）

1. `cd dsh/dsh-recruitment && npx tsc --noEmit` → 0 错；
2. `npx tsdown` → 双入口构建成功；
3. `node scripts/server-typecheck.mjs`、`client-contract-check.mjs`、`entry-reachability.mjs` 仍 PASS；
4. 总控独立跑 `node work/d5/fullpage/run-v4.mjs --fresh --port 49347` → 15/15，且证据落 `evidence/`。
