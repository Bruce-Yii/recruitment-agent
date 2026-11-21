# 前端任务书 07 · 飞书两块：空闲时段 + 换人重绑妙记

> 收件人：前端实现窗口（云端，读仓库）。发件人：总控。日期：2026-11-19。
> 前置：任务 05/06 已并库。后端两条新接口在并行开发中（契约已冻结，见下）。

---

## 0. 红线

视觉不改、不新增按钮；外部失败一律人话（"日历没连上，先重连再试"）；**绝不**把"读不到日历"显示成"没有空闲时间"。

---

## 1. T7-1 排期确认卡里显示空闲时段

- 打开"约面试 / 改期 / 加面"确认卡时，先请求：
  `GET /recruitment/api/action/interview/free-slots?application_id=<id>&interviewer_actor_ids=<id,id>&days=5&duration_minutes=45`
- 返回：
  ```json
  { "slots": [ { "start": "ISO", "end": "ISO", "busy_conflicts": 0, "source": "LIVE" } ],
    "unsatisfied": [ { "interviewer_actor_id": "…", "reason": "NO_CALENDAR_BINDING" } ],
    "labels": { "provenance": "LIVE|FIXTURE", "trigger": "MANUAL", "connection": "CONNECTED|AUTH_REQUIRED|NOT_CONNECTED" } }
  ```
- 展示规则：
  - 有槽 → 显示 2–3 个可选时段（时间用本地时区人话格式），点选后**填入**既有时间输入，不新增控件；
  - `unsatisfied` 非空 → 在该处显示人话原因（"这位面试官还没有绑定飞书日历"）；
  - `labels.connection !== 'CONNECTED'` → 顶部一条轻提示"日历暂时读不到，可以手动填时间"，**不阻塞**手动排期；
  - `slots` 为空且 `unsatisfied` 为空 → "未来 5 天没有共同空闲"，同时提供手动填写。

## 2. T7-2 换人后重绑妙记录音

- 现有"换面试官"确认卡提交成功后，若该场已有妙记（画布/详情里有 `minute_token`），显示一条**人点**确认：
  "这把录音的归属还挂在旧面试官名下，要改到新人吗？" → 用户点确认后调用：
  `POST /recruitment/api/action/interview/rebind-minute`
  ```json
  { "interview_id": "…", "from_actor_id": "…", "to_actor_id": "…",
    "minute_token": "obcn…", "confirmation_text": "人的原话", "dry_run": false }
  ```
- 返回成功 → 提示"已把录音归属改到新面试官"；失败 → 人话原因，且**明确说"面评不会因此丢，但录音归属仍是旧的"**（不要含糊）。
- 没有人点确认 → 不调用（这是外部写，必须有人的原话）。
- 若 `minute_token` 为空 → 不显示这段（没有录音就不谈归属）。

---

## 3. 交付

```
dsh/dsh-recruitment/src/client/**（改动文件，仓库路径）
T7-NOTES.md   # 改了什么、引用 file:line、哪些没自测
```

不许改 `src/http/**`、`src/tools/**`、`db/**`、`docs/**`。

---

## 4. 我这边的验收

1. 真 Host + 真飞书：打开排期卡能看到真实空闲时段（或如实"读不到"）；
2. 点一个时段能填进时间输入，确认后排期落库；
3. 换人卡片：确认后提示文案正确；`dry_run` 模式下不产生外部写；
4. 界面不出现 `open_id` / 内部 id / 错误码。
