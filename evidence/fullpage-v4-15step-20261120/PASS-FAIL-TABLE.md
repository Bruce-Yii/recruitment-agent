# v4 独立整页 · 15 步逐条 PASS/FAIL（总控独立复跑）

- 运行时：`2026-11-20T22:40:24+08:00` · HEAD `e7a5284` · `--fresh` · Host 49347 · Chrome CDP 9222 · 1440×900
- 结果：**PASS 15 / FAIL 0 / BLOCKED 0**
- 证据：本目录 `evidence/`（每步 ui.png + ui.txt + db.txt；psql 全部 SELECT-only，不 import 产品代码）
- 审计：`audit-result.json`（硬检查 0 失败；软告警 3 条均为 keyText 摘要与页面文本不同源，非失败）

| # | 步骤 | 判定 | 判据（可证伪） | 证据 |
|---|---|---|---|---|
| S1 | HR 打开工作台看今天待办 | PASS | `app-queue-view` 可见；「今日待办/待推进候选人/待初筛/面试中/待决策」齐现；无工程信息；**无开发身份 select、无旧壳「招聘工作台」文案**；只读徽标可见；pathname=`/recruitment/app`、视口 1440×900（D-167） | `evidence/S01-ui.png`、`S01-ui.txt`、`S01-db.txt` |
| S2 | 新简历进来（拖入/邮件）等待解析 | PASS | 真点画布「上传简历」+ CDP 向 `[data-testid=v4-canvas-route] input[type=file]` 注入合成 PDF；fetch 观测 `POST /intake/upload`=**202** 且返回 task_id；psql 读回 `business_task` Δ≥1（同步）、后台 `intake_asset` Δ=1（异步，辅助） | `evidence/S02-ui.png`、`S02-ui.txt`、`S02-db.txt` |
| S3 | 打开申请逐条看岗位标准 + 点开原文 | PASS | 队列行 `app-queue-item-*` 真点进入画布（`v4-canvas-route`）；「岗位标准对照」「简历原文摘录」「已匹配/待核实」可见；真点 `.ros-crit-item`（有带团队经验）后出现 `.active`（联动） | `evidence/S03-ui.png`、`S03-ui.txt`、`S03-db.txt` |
| S4 | HR 下初筛结论并确认（人工纠偏） | PASS | 初筛弹窗真点结果 pill「通过」且 `active`；填「初筛判断理由 / 人工纠偏说明」；提交；psql `decision` Δ=+1（SCREENING/ADVANCE，actor=…103） | `evidence/S04-ui.png`、`S04-ui.txt`、`S04-db.txt` |
| S5 | 约一面：选面试官 → 看空闲 → 提交 | PASS | 排期弹窗 CREATE 模式；面试官编号输入 + 手填时间（日历不可用按人话降级）；提交后 `interview` 新增，且新场 `interviewer.actor_id=…104` | `evidence/S05-ui.png`、`S05-ui.txt`、`S05-db.txt` |
| S6 | 候选人改期：只改同一场，不新建 | PASS | 真点 `schedule-mode-reschedule` + 新时间；psql 提交前后：**同 interview id、record_version 1→2、时间=新值** | `evidence/S06-ui.png`、`S06-ui.txt`、`S06-db.txt` |
| S7 | 面试官 A 看前简报 | PASS | 身份切 `interviewer_a` 自动进 `#/interviewer`；`app-interviewer-view` + `interviewer-row[data-interview-id]`；「本轮面试简报 / 前面几轮发生了什么 / 这一轮可以参考」齐现 | `evidence/S07-ui.png`、`S07-ui.txt`、`S07-db.txt` |
| S8 | 面后速记：中途刷新不丢、草稿落库 | PASS | 真填 `quick-notes-textarea`；**保留 rc_sid 刷新**（`sid_preserved_across_refresh=true`）后速记仍在；psql `scorecard_draft.interviewer_actor_id` 仅属面试官 A（…104） | `evidence/S08-ui.png`、`S08-ui.txt`、`S08-db.txt`、`S08-DRAFT-OWNER.txt` |
| S9 | 面试官 A 提交独立面评（只见自己的） | PASS | 详情层明示「只显示你本人的面评」；真点 `submit-scorecard`；psql `scorecard` Δ=+1 | `evidence/S09-ui.png`、`S09-ui.txt`、`S09-db.txt` |
| S10 | B 未交面评时 HR 尝试终审（应被拦） | PASS | 决策弹窗人话「还缺 …的面评，暂时不能提交录用决策」；`canvas-modal-submit` **disabled**；psql `decision` 行数不变（零写入） | `evidence/S10-ui.png`、`S10-ui.txt`、`S10-db.txt` |
| S11 | 面试官 B 补交独立面评 | PASS | `fresh('interviewer_b')` → B 视角「待提交面评」→ 真点提交；psql `scorecard` Δ=+1 | `evidence/S11-ui.png`、`S11-ui.txt`、`S11-db.txt` |
| S12 | HR 终审决策，刷新后仍在 | PASS | 隔离数据集 A(R1)/B(R2) 两轮面评真点提交；`decision-facts` probe=READY、evaluation_summary COMPUTED（coverage 2/2）；真点「终审决策→通过→理由→提交」；psql `decision(FINAL) current=1`、`scorecard=2`；刷新后仍在 | `evidence/S12-ui.png`、`S12-ui.txt`、`S12-db.txt` |
| S13 | 同一条重复提交决策（应提示已处理过） | PASS | 重复提交 → 界面「已处理过，不会重复写入」；psql `decision(FINAL) total\|current = 1\|1`（无新增、无 supersede） | `evidence/S13-ui.png`、`S13-ui.txt`、`S13-db.txt` |
| S14 | 候选人放鸽子 → 记「未出席」 | PASS | 真点 `canvas-action-no-show` → 候选人未出席 + 原因 + 确认原话 → 提交；psql `interview.status=NO_SHOW`、record_version+1 | `evidence/S14-ui.png`、`S14-ui.txt`、`S14-db.txt` |
| S15 | 两人同时改同一场排期 | PASS | 真并发两个同版本 RESCHEDULE：**200×1 + 409×1**（VERSION_CONFLICT / STALE_RECORD_VERSION）；psql `record_version` 1→2（仅 +1）；UI 另见「这条刚被别人改过，请刷新」 | `evidence/S15-ui.png`、`S15-ui.txt`、`S15-db.txt` |

## 备注

- S2 的 `intake_asset` 是**后台解析**写，不是 HTTP 同步写；同步证据用 `business_task` + 202。曾在旧壳被 UI 错误文案「上传…」掩盖过假 PASS（D-163 类），本轮已改为同步事实判据。
- S8 的草稿作用域含 sessionId；测试入口 `/recruitment/test` 每次 `newSid()`，因此 S8 刷新必须直连 `/recruitment/app` 保留 `rc_sid`，否则会误判“刷新丢草稿”。
- S4/S5/S6/S13 本轮相对旧脚本**收紧**了断言（真点结果 pill/面试官归属/同 id+version+1/精确重复文案+total 不变），不是放宽。
