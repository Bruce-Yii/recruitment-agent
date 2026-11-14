# Golden Path run 2026-11-14T20-33-26-200Z — FIRST_RUN

- 生成时间：2026-11-14T20:33:29.754Z
- 仓库 HEAD：`2d987d4d923c90683790ab98b8e115f4983a9b78`（来源 env:GOLDEN_PATH_HEAD；工作树 snapshot；branch=(n/a)）
- harness：`C:\Users\12412\AppData\Local\Temp\g4-snapshot-b-2d987d4\dsh\dsh-recruitment\manual\golden-path\run-golden-path-rerun.mjs` sha256=`fb1061cd3683e05f6b026e9558de5bf0ced646e8a9b4c7036f5a4f03df0e257e`
- fixture：`C:\Users\12412\AppData\Local\Temp\g4-snapshot-b-2d987d4\dsh\dsh-recruitment\manual\golden-path\fixtures\gp-rerun-2\synthetic-resume-golden-path.pdf` sha256=`aa2f4645c7535bd83fbc3e8066ac628051adaefc0ed236e4ee7e9695905252df`（10919 bytes）
- bootstrap：`C:\Users\12412\AppData\Local\Temp\g4-snapshot-b-2d987d4\scripts\bootstrap-demo.mjs` sha256=`65e05b0bcc95d1e6dfd489c5ef5ebcea9546e228d6c237f26707f860f692b5cc` outcome=NO_OP exit_code=0 writes={"written":false,"steps":[]}
- 数据库：postgres@127.0.0.1:5432/ra_g4_ci_replay（tenant=11111111-1111-4111-8111-000000000001）
- run_mode：**FIRST_RUN**（守卫：FIRST_RUN → MATCH）

## 四数（16 跳）

- hops=16
- passed=16
- failed=0
- skipped=0

## 逐跳

| hop | id | kind | run_mode | outcome | error/reason | row delta |
|---:|---|---|---|---|---|---|
| 1 | s6-intake | write | FIRST_RUN | PASS |  | {"application":1,"candidate":1,"event_inbox":1,"intake_asset":1,"intake_record":1,"resume":1,"resume_version":1} |
| 2 | s6s7-stage-advance | write | FIRST_RUN | PASS |  | {"event_inbox":1} |
| 3 | s7-screening-evaluate | read | FIRST_RUN | PASS |  | {} |
| 4 | s7-decision-screening | write | FIRST_RUN | PASS |  | {"decision":1,"event_inbox":1} |
| 5 | s7s8-stage-advance | write | FIRST_RUN | PASS |  | {"event_inbox":1} |
| 6 | s8-schedule-denied | negative-control | FIRST_RUN | PASS | FORBIDDEN/APPROVAL_NOT_GRANTED | {} |
| 7 | s8-schedule-allow-once | write | FIRST_RUN | PASS |  | {"business_task":1,"interview":1,"interviewer":2,"meeting":1,"meeting_binding":1} |
| 8 | s8-interview-get | read | FIRST_RUN | PASS |  | {} |
| 9 | s9-transcript-import | write | FIRST_RUN | PASS |  | {"interview_record":1,"transcript_artifact":1,"transcript_segment":11} |
| 10 | s9-transcript-read | read | FIRST_RUN | PASS |  | {} |
| 11 | s10-scorecard-denied | negative-control | FIRST_RUN | PASS | FORBIDDEN/APPROVAL_NOT_GRANTED | {} |
| 12 | s10-scorecard-allow-once | write | FIRST_RUN | PASS |  | {"event_inbox":1,"scorecard":1} |
| 13 | s10-scorecard-2 | write | FIRST_RUN | PASS |  | {"event_inbox":1,"scorecard":1} |
| 14 | s10-evaluation-summarize | read | FIRST_RUN | PASS |  | {} |
| 15 | s10-decision-stage | write | FIRST_RUN | PASS |  | {"decision":1,"event_inbox":1} |
| 16 | s10-stage-advance-after-decision | read | FIRST_RUN | PASS |  | {"event_inbox":2} |

## 负例（期望被拒 + 零写入）

| hop | id | result | code/reason | 实际拒绝路径 | row delta |
|---:|---|---|---|---|---|
| 6 | s8-schedule-denied | BLOCKED | FORBIDDEN/APPROVAL_NOT_GRANTED |  | {} |
| 11 | s10-scorecard-denied | BLOCKED | FORBIDDEN/APPROVAL_NOT_GRANTED | FORBIDDEN/APPROVAL_NOT_GRANTED | {} |

## 终态（DB 独立读回）

- application.current_stage_code = **S10**（终态断言：S10）
- application.rubric_version_id = 4facfb68-64ec-4500-b26a-7ff4db6c2f46
- decisions = 2（[{"decision_scope":"SCREENING","stage_code":"S7","n":1},{"decision_scope":"STAGE","stage_code":"S10","n":1}]）
- interviews = 1
- transcript artifacts = 1
- interview_record = 1
- scorecards = 2（SUBMITTED 现行 = 2）
- v_application_stage_consistency 违规：本申请 0 行 / 全租户 0 行（0 行 = 合规）
- stage / pin 审计事件：["application.current_stage_code.changed:S6->S7","application.current_stage_code.changed:S7->S8","application.current_stage_code.changed:S8->S9","application.current_stage_code.changed:S9->S10"]

## acceptance

- all_hops_pass=true
- stage_s10=true
- submitted_scorecards_ge_1=true
- consistency_view_zero_violations=true
- negative_controls_blocked=true
- **ok=true**

> 数据全部为合成 fixture（R4 provenance=FIXTURE）；写只经产品工具 execute()，本 harness 不手工 UPDATE 业务行。
