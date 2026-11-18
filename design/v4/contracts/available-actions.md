# 前端可用的写入口（HTTP Host Action）

> 这份是**事实**：前端能调用的写接口、确切路径与入参。全部需要：同源 + `x-recruitment-request: 1` + 宿主 cookie（身份由 session 决定，**前端不传 actor**）。
> 都要求 `confirmation_text`（人的原话），服务端算 sha256 留痕；未绑定身份 / 越权 → fail-closed 零写入。

## 1. 本轮新增（2026-11-19，已真库验证）

### 跨岗调剂
```
POST /recruitment/api/action/application/transfer
{
  "application_id": "uuid",
  "target_job_id": "uuid",
  "carry_over_refs": [ { "source_application_id": "uuid", "ref_kind": "SCORECARD|TRANSCRIPT|DECISION", "ref_id": "uuid" } ],   // 可选
  "confirmation_text": "人的确认原话"
}
→ 200 { "application_id": "<新申请>", "carry_over_count": <n>, ... }
```
规则：只认同一个候选人；源申请**一行不改**；重复携入幂等；目标岗必须有已批准的岗位标准版本（否则按既有闸门拒绝）。

### 候选人约束（置顶 / 下一轮交接）
```
POST /recruitment/api/action/candidate/constraint
{
  "action": "PIN | UNPIN | HANDOFF",
  "candidate_id": "uuid",            // 或 application_id（二选一）
  "text": "字节 Offer 周五截止 · 期望 45k",   // ≤500
  "source": "CHAT | WEIXIN | PHONE | OTHER",
  "interview_id": "uuid",            // HANDOFF 必填：指向下一轮
  "confirmation_text": "人的确认原话"
}
→ 200 { "constraint_id": "...", ... }
```
置顶约束会出现在候选人读投影与面试官前简报；HANDOFF 会标"上一轮留的"。

### 新建岗位
```
POST /recruitment/api/action/job/create
{
  "title": "资深后端工程师",
  "dept": "研发中心",                 // 可选：部门名；传 UUID 则按部门 id
  "requisition_id": "uuid",          // 可选：关联已有岗位需求单（HC 在这里）
  "confirmation_text": "人的确认原话"
}
→ 200 { "job_id": "...", "code": "...", "rubric_status": "PENDING", ... }
```
**`headcount` 会被明确拒绝（400 `UNSUPPORTED_FIELD`）**：HC 属于岗位需求单（`requisition.headcount`），建岗接口不收。
岗位标准版本新建后是 **PENDING**，必须走审批，接口**不**替你批。

## 2. 已有（本轮之前就在）

| 路径 | 用途 |
|---|---|
| `POST /recruitment/api/decision/record` | 决策（初筛/终审），人点 + 原话 |
| `POST /recruitment/api/action/interview/schedule` | 排期 / 改期 / 加面（含 `round_label`、`replace_interviewer`） |
| `POST /recruitment/api/action/scorecard/submit` | 提交面评 |
| `POST /recruitment/api/action/email/send` | 发信（含 Offer 邮件），人点 + 幂等 + 回执 |
| `POST /recruitment/api/action/settings/write` | 工作空间设置（静默代办 / SLA） |
| `POST /recruitment/api/action/job/update`、`job/close`、`config/*` 等 | 见 `src/http/actions.ts` 的 `ACTION_PATHS` |

## 3. 还缺（前端 `INTERFACE-NEEDS.md` 里尚未补齐的）

- 上传简历（`ASYNC-1`）：本日另一条 lane 在做，形态为 `POST /recruitment/api/intake/upload`（原始字节 + `x-file-name`，立即返回 `task_id`）。
- 批量不通过、催办、复合指令、星标、面评草稿、撤销：**未做**，前端先走 `NOT_AVAILABLE` 人话提示。
