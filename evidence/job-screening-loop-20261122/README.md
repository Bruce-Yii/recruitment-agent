# PR #20 复验（2026-11-22 · head 2e415e0）

> PR：**#20** `feat/job-and-screening-loop-closure`，head **`2e415e0`**，base main `42062cb`。
> 结论：**tsc/构建/静态/15 步全绿；1440 三场景中 ② 通过，① 仍被“新建岗位 criteria 序列化”阻断，③ 未到达。不合并 main。**

## 1. 静态/构建/回归（全绿）

| 门 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS（0） |
| `npx tsdown` | PASS（双入口，lib/app.js 1.40MB） |
| `server-typecheck` | PASS（0/0） |
| `runtime-budget` | PASS（5051/5051） |
| `entry-reachability` | PASS（无新缺口；手拼 0） |
| `client-contract-check` | PASS（0 违规） |
| `term-lint` | PASS（0 违规） |
| `run-v4.mjs --fresh --port 49347` | **15/15 PASS**，审计 hard 0 |

## 2. 1440 三场景

### ② 发起初筛评估：PASS

S7 未评估申请 → `canvas-action-screening-evaluate` → “评估中…” → 绿字「已更新初筛评估结果。」→ 标准对照区静默刷新。截图 `03/04`。

### ① 新建岗位 → 批准标准：**仍 BLOCKED**

新建岗位提交返回（弹窗原文）：

```text
INVALID_ARGS/RUBRIC_INVALID: criteria 没有通过 R-VAL-1..13，逐条见 detail.violations
```

本次 PR 已把默认 criteria 改为：

- `App.tsx:342-348` / `JobPage.tsx:419-425`：`work_history_present`，`field:'work_experience'`, `operator:'EXISTS'`, `value:true` + 判断型 `question`；
- 但 `src/client/recruiting/actions.ts:1585-1588` 的 `buildJobCreateBody` 只复制**字符串**可选键：
  ```ts
  for (const optionalKey of ['field', 'operator', 'value', 'question', 'notes']) {
    const value = entry[optionalKey]
    if (typeof value === 'string' && value.trim() !== '') shaped[optionalKey] = value
  }
  ```
  `value: true`（boolean）被丢弃，实际发给服务端的 criterion 只有 field/operator、没有 value；服务端 R-VAL 要求机械型 `EXISTS` 必须带 `value=true`，因此拒绝。

**修复方向（前端/共享 builder，不改样式）**：让 `buildJobCreateBody` 接受 `boolean` / `integer` 的 `value`（推荐通用修复），或换用不依赖 boolean value 的合规 criteria 组合。当前 UI 代码本身已改对，问题卡在 builder 的序列化。

### ③ 关闭岗位：未到达

因①岗位未创建，无新岗位可关闭；未在既有演示岗位上取巧关闭。PR20 的关闭按钮尚未取得真机结果。

## 3. 文件

- `e2e-result.json`（①失败、②通过、③未到达）
- `01-new-job-rubric-invalid-1440.png`、`02-rubric-approve-not-reached-1440.png`
- `03-unevaluated-application-1440.png`、`04-screening-evaluated-1440.png`
- `05-job-close-not-reached-1440.png`
- `regression-15step-result.json` / `regression-15step-audit.json`

## 4. 后续

共享 builder 支持 boolean/integer `value` 后重跑①→②→③；全绿再由总控合入 PR #20。未改 UI 样式、未合并 main。
