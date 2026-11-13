# 第一次真实写入决策：`decisions` 从 0 → 1（2026-11-14，D-95 生效后）

**目的**：证明 D-95（人只决策一次）落地后，**不需要任何 approval 点击**，决策就能真的落库；
同时证明整条 S10 的判定链（汇总 → 依据 → 决策）在真实数据库上跑得通。

---

## 1. 人做了什么决策

在对话里，Agent 提议"用真实数据跑一遍 S6→S10，把 `decisions` 从 0 变成 1"，人回答：

> **1同意**

这就是 D-95 说的"人只做一次决策"：**人说完，Agent 直接执行**，没有再弹任何确认。
这句话被**逐字**写进 `human_confirmation.confirmation_text`，并连同 `result/reason/basis_refs`
一起算进 `confirmation_text_sha256`。

## 2. 执行顺序（DC-16/DC-34：不得拿旧汇总做新决定）

```
1) recruitment_evaluation_summarize（只读）→ 用同一个 as_of 现算
   summary_digest = 686a94472ef6b2e60f03214697df9a7c4d3b92effd412e10cbd5e16cd944ca94
   coverage = {required_total:2, submitted:2, missing:0, completion_ratio:1}
   tally = {advance:2}   consensus = UNANIMOUS_ADVANCE
2) 用现算结果重建 basis_refs 里那条 SUMMARY（旧 digest 会被 SUMMARY_STALE 拒掉——实测过一次）
3) recruitment_decision_record（IN_CHAT，**故意不传 approval**）
```

第一次尝试用旧 `decision-args.json` 里的 digest，被正确拒绝：

```
INVALID_ARGS: {"reason_code":"SUMMARY_STALE",
  "expected":"c7da137b7d0ed0a9…","provided":"f687d22768f85379…",
  "message":"summary_digest 不是本次重算的值（不得拿旧汇总做新决定，DC-16/DC-34）"}
```

→ 这条负例证明"汇总不能复用"是真拦住的，不是纸面规则。

## 3. 结果（工具返回，原文）

```json
{
 "tool": "recruitment_decision_record",
 "contract_version": "2.0.0",
 "status": "OK",
 "replayed": false,
 "labels": { "provenance": "FIXTURE", "trigger": "MANUAL", "connection": "CONNECTED" },
 "decision": {
  "id": "57455e37-215c-4a00-a939-17449d5811f5",
  "application_id": "11111111-1111-4111-8111-000000000701",
  "interview_id": "11111111-1111-4111-8111-000000000801",
  "decision_scope": "STAGE",
  "stage_code": "S10",
  "result": "ADVANCE",
  "decided_by_actor_id": "11111111-1111-4111-8111-000000000103",
  "decided_at": "2026-11-13T18:37:55.002Z",
  "record_version": 1
 }
}
```

## 4. DB 读回（psql 直查，不是工具自述）

```
=== recruitment.decision ===
57455e37-215c-4a00-a939-17449d5811f5|…701|…801|STAGE|S10|ADVANCE|…103|1|t   ← is_current=true

=== recruitment.event_inbox（人怎么授权的）===
decision.record | IN_CHAT | 1同意 | ADVANCE | S10

=== 计数 ===
1
```

**四个关键点全部成立**：
1. `decided_by_actor_id = …103`（HUMAN，来自配置，不是模型传的）；
2. `stage_code = S10`；
3. `record_version = 1` 且 `superseded_by_decision_id IS NULL`（当前有效决策）；
4. 内部事件里**逐字记着人说的话**（`IN_CHAT` / `1同意`）——事后可与会话日志对账。

## 5. 诚实标注

| 项 | 值 | 说明 |
|---|---|---|
| 业务数据 | **FIXTURE** | 演示申请/面试/两份面评是 `seed-demo` 造的合成数据 |
| 代码执行 | **真** | 真连 `ra_s6s7`、真跑质量判定与哈希、真写库 |
| 触发 | **MANUAL** | 我手工执行，不是事件自动摄取 |
| 连接 | **CONNECTED** | 数据库真实可写 |
| 人的决策 | **真** | "1同意"是产品负责人在对话里的原话 |

**没有夸大的地方**：这是"用合成业务数据跑通真实写入"，不是"真实招聘决策"。

## 6. 复现

```powershell
cd dsh/dsh-recruitment
node work/run-decision-inchat.mjs     # 脚本副本见本目录
```
