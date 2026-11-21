# T7-NOTES.md · 前端任务书 07 交付说明（飞书空闲时段 + 换人重绑妙记）

> 对应任务书：`design/v4/frontend-task-07-feishu.md` · 日期：2026-11-19
> 说明：仅修改 `dsh/dsh-recruitment/src/client/**`，未改后端、数据库与文档；未新增顶栏/侧栏按钮；界面严禁出现 `open_id`、内部 ID 或错误码。

---

## 一、本轮改动清单

1. **`dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts`**
   - **T7-1 `fetchInterviewFreeSlots`**：调用 `GET /recruitment/api/action/interview/free-slots?application_id=<id>&interviewer_actor_ids=<id,id>&days=5&duration_minutes=45`（同源 + `x-recruitment-request: 1`）。
     - 将 `slots[]` 转为本地时区人话标签（最多展示 3 个）；
     - 将 `unsatisfied[]` 映射为人话（`NO_CALENDAR_BINDING` →「这位面试官还没有绑定飞书日历」），绝不暴露 `interviewer_actor_id` 或 `open_id`；
     - 严格区分**日历读不到**（`labels.connection !== 'CONNECTED'` 或请求异常 →「日历暂时读不到，可以手动填时间」，**不阻塞手动排期，绝不说成没有空闲**）与**已连接但确实没空**（`slots` 与 `unsatisfied` 均为空 →「未来 5 天没有共同空闲」）。
   - **T7-2 `postRebindMinute`**：调用 `POST /recruitment/api/action/interview/rebind-minute`（带 `confirmation_text` 与 `dry_run`）。
     - 成功返回「已把录音归属改到新面试官」；
     - 失败抛出人话原因，且明确注明「**面评不会因此丢，但录音归属仍是旧的**」。
   - 新增 `postInterviewSchedule` 对接既有 `POST /recruitment/api/action/interview/schedule`。
2. **`dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx`**
   - 排期/改期换人确认卡打开时自动拉取 `fetchInterviewFreeSlots`，点击空闲时段胶囊直接填入既有时间输入框（不新增控件）；
   - 换面试官提交成功后，**仅在 `minuteToken` 非空时**弹出人工确认条「这把录音的归属还挂在旧面试官名下，要改到新人吗？」，必须经人点「确认改到新人」并带 `confirmation_text` 才调用 `postRebindMinute`；无 `minuteToken` 时完全隐藏该段。
3. **`dsh/dsh-recruitment/src/client/normalize-canvas.ts`** & **`canvas/canvas.css`**
   - 在 `InterviewRoundVM` 透传内部字段 `minuteToken` 与 `leadActorId`（仅供接口入参，不在界面渲染）；
   - 在 `canvas.css` 补充 v4 原版 `.ros-slot-grid` / `.ros-slot-pill` 样式（变量 100% 沿用 `design-tokens.md`）。

---

## 二、`grep` 真实引用点自查（`file:line`）

```text
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:383: * GET /recruitment/api/action/interview/free-slots?application_id=<id>&interviewer_actor_ids=<id,id>&days=5&duration_minutes=45
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:386:export async function fetchInterviewFreeSlots(params: {
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:401:    const res = await fetch(`/recruitment/api/action/interview/free-slots?${qs.toString()}`, {
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:415:        unavailableBanner: '日历暂时读不到，可以手动填时间',
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:451:      unavailableBanner: calendarUnavailable ? '日历暂时读不到，可以手动填时间' : null,
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:487: * POST /recruitment/api/action/interview/rebind-minute
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:491:export async function postRebindMinute(payload: {
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:499:  const res = await fetch('/recruitment/api/action/interview/rebind-minute', {
dsh/dsh-recruitment/src/client/canvas/canvas-actions.ts:522:    throw makeError('ACTION_FAILED', `${rawReason}。面评不会因此丢，但录音归属仍是旧的。`);
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:16:  fetchInterviewFreeSlots,
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:20:  postRebindMinute,
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:121:      void fetchInterviewFreeSlots({
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:263:      const res = await postRebindMinute({
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:276:        '录音归属修改未能完成。面评不会因此丢，但录音归属仍是旧的。';
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:382:            <div className="ros-risk-note" data-testid="rebind-minute-prompt" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:407:                  data-testid="rebind-minute-confirm"
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:769:                        <div className="ros-slot-grid" data-testid="free-slots-grid">
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:786:                      <div className="ros-sec-meta" data-testid="free-slots-empty">
dsh/dsh-recruitment/src/client/canvas/CandidatePage.tsx:787:                        未来 5 天没有共同空闲，请直接在下方手动填写时间。
```

---

## 三、未自测项（如实声明）

1. **`npx tsc --noEmit` 与 `npx tsdown` 构建**：**未自测**（云端沙箱无项目依赖与构建工具链）。
2. **真 Host + 真飞书空闲时段查询与排期落库**：**未自测**。
3. **真 Host 换面试官后确认重绑妙记（含 `dry_run` 零外部写验证）**：**未自测**。
