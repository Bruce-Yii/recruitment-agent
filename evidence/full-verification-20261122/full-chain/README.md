# Lane2b · 1440×900 One-Shot Full-Chain Evidence (task-17)

## Run status

**PASS — 9/9 milestones green** (`overall_pass: true`, `FAIL: 0`, `BLOCKED: 0`).

| Field | Value |
|---|---|
| Branch / HEAD | `evidence/full-verification-chain` @ `7695243` (verified by script before launch) |
| Mode | FRESH — one-shot disposable DB + one-shot profile + Chrome 1440×900 |
| DB | `ra_fresh_e2e_di0_35byqx` (created by `fresh-lib.mjs`, dropped in `finally`) |
| Host / port | `http://127.0.0.1:49349` (stopped in `finally`) |
| Chrome | CDP 9222, `1440×900` (killed in `finally`; temp profile removed) |
| Driver script | `work/d5/fullpage/probe-full-chain.mjs` |
| Result JSON | `full-chain-result.json` |
| Date | 2026-11-23 (Asia/Singapore) |

## Milestones (all PASS)

| Milestone | Screenshot | DB readback | Independent psql fact |
|---|---|---|---|
| 01 新建 OPEN 岗位（AI 草案 + 自定义维度） | `01-job-created.png` | `01-db.txt` | job status `OPEN`; AI draft notice + custom criterion row added |
| 01b 批准岗位评分标准 | `01b-rubric-approved.png` | `01b-db.txt` | rubric version approved (`approval.status=APPROVED`) |
| 02 上传真实 PDF + 自动初筛 | `02-auto-screening.png` | `02-db.txt` | `decision=0` before and after (auto screening must not write a decision); `canvas-auto-screening` visible |
| 03 人工纠偏 + 初筛结论 | `03-criterion-override.png` | `03-db.txt` | `criterion_override 0→1`; SCREENING `decision 0→1` (real UI, needed for stage ladder) |
| 04 发候选人自助选时段 + 免登录确认 | `04-booking-confirmed.png` | `04-db.txt` | `interview 6→7` (+1) after public `/recruitment/book/<token>` slot confirm |
| 05 导入转写 → 自动面评草稿 | `05-scorecard-draft.png` | `05-db.txt` | `scorecard_draft 0→2` (one per interviewer), `scorecard=0`; transcript POST status 200 |
| 06 面试官提交独立面评 | `06-scorecard.png` | `06-db.txt` | `scorecard 0→2`; `decision/facts` probe READY / state COMPUTED |
| 07 记录正式终审决策 | `07-decision.png` | `07-db.txt` | FINAL `decision 0→1` (total decisions 1→2 incl. SCREENING); stage reached `S10` via real UI |
| 08 展开追责时间线 | `08-trace.png` | `08-db.txt` | `canvas-decision-trace-list` expanded, 49 real actions/actors |

Each milestone also has a `<id>-ui.txt` capturing full page innerText, verdict, reason, and captured UI state. `full-chain-result.json` contains per-step psql head counts, full extras (including captured fetch writes, binding log, stage-advance trace), and machine checks.

## Machine checks (step 08)

`canvas-decision-trace-list` innerText (3843 chars) was checked:

- `zero_uuid: true` — no UUID leaked
- `zero_full_sha256: true` — no full 64-hex digest leaked
- `zero_证据: true` — no 「证据」 engineering term
- `has_person: true`, `has_action: true` — real actors (系统记录 / 招聘负责人 / 面试官) and human-readable actions (收到简历 / 记录人工纠偏 / 初筛通过 / …)

## Honest notes

- **Bundle rebuild**: the checked-in `dsh/dsh-recruitment/lib/app.js` artifact at HEAD 7695243 was stale (last built at PR #12) and did not contain the new-job AI-draft / custom-criterion UI required by step 1. Before the run, `lib/app.js` and `lib/client.js` were regenerated from the *current source at the same HEAD* with `tsdown` (build artifacts only; no product source edited). After the successful run they were **restored from backup** (`*.orig-fullchain`) so the final worktree has no product-code changes. The run used the real UI of HEAD 7695243 source.
- **Meeting binding**: Wave2's transcript-import precondition requires an active PRIMARY meeting binding. On the disposable DB only, synthetic meetings/bindings were seeded with psql for each interview (single interview id parsed from the real UI POST on a retry); this is fixture setup, not a fabricated transcript/draft. The transcript itself and the `scorecard_draft` rows were written by the real UI POST (status 200).
- **Two drafts**: the real UI created 2 drafts (A and B) for the round-1 transcript; the verdict accepts `>= +1` with no submitted scorecard, as required.
- **Prior attempts** are retained under `attempt-*/` for audit: `attempt-1-stale-bundle` (stale bundle blocker, exact `INVALID_ARGS/RUBRIC_INVALID`), `attempt-2-runtime-bug`, `attempt-3-partial`, `attempt-4-partial`, `attempt-5-partial`, `attempt-6-partial`, `attempt-7-nearly-green`. Only the final top-level files are the authoritative result.
- Cleanup verified after the run: host port `49349` and CDP `9222` free, one-time token file removed, disposable DB dropped by `FRESH.cleanup()`, Chrome process killed and temp profile removed.
- No commits, pushes, checkouts, stashes, or product source edits were made by this lane.

## Reproduce

```
cd D:\12412\DshWorktrees\recruitment-agent\wave3-evidence-chain
$env:RECRUITMENT_DB_PASSWORD='123456'
node work/d5/fullpage/probe-full-chain.mjs
```
