# Wave 2.5 批次联调（2026-11-23 · #38 + #39 + PR #37）

## PR

| PR | Head | 内容 |
|---|---|---|
| **#38** https://github.com/Bruce-Yii/recruitment-agent/pull/38 | `ee145f1` | 只读历史人才再发现工具 + 岗位召回路由 |
| **#39** https://github.com/Bruce-Yii/recruitment-agent/pull/39 | `c23f5ed` | 候选人级跨投递去重提示（只读） |
| **#37** https://github.com/Bruce-Yii/recruitment-agent/pull/37 | `6d15ac2` | G-08 纠偏 UI + G-11 横向对比；清除临时白名单 + 新增只读路由分类 |

联调分支：latest main `f282158` + #38 + #39 + #37。

## 门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.43MB）
- `server-typecheck`：0/0
- `runtime-budget`：5051/5051
- `entry-reachability`：PASS，**WHITELIST=[]**（candidate-dedup GET 归入 READ_ONLY_ROUTES，不占白名单）
- `client-contract-check`、`term-lint`：PASS
- 全量 unit：**2118 tests / 2114 pass / 0 fail / 4 既有 skip**
- `run-v4.mjs --fresh --port 49347`：**15/15 PASS**，审计 hard 0

## 1440 真机

### ① 标准纠偏
- 候选人页 `canvas-criterion-override-work_exists` → 确认弹窗 → 填写确认原话 → 提交；
- 页面绿字「已记录…人工纠偏并同步落库」；
- psql：`criterion_override` **0→1**；`event_inbox` 的 `criterion.override.recorded` **0→1**。
- 证据：`01-criterion-override-1440.png`

### ② 多候选人横向对比
- 岗位候选人池勾选 2 人 → `canvas-batch-compare-open` → `canvas-compare-modal`；
- 弹窗按岗位 Rubric 维度并排展示两位候选人（当前阶段/工作经历/教育经历/带团队等），有复制摘要按钮。
- 证据：`02-batch-compare-1440.png`

### ③ 诊断
- `x-recruitment-agent-diag: 1`：**19 个只读工具 / 0 写工具**；
- 含 `recruitment_talent_rediscovery`；无任何写工具。
- 机器读数见 `e2e-result.json`。

## 只读接口结构

- 人才再发现：见 `talent-rediscovery-readonly.md`
  `GET /recruitment/api/recruiting/jobs/:jobId/rediscovery`
- 候选人去重：见 `candidate-dedup-readonly.md`
  `GET /recruitment/api/recruiting/applications/:applicationId/duplicates`

## 备注

- 候选人去重目前只有只读接口，前端未挂载展示；`entry-reachability` 已将其归为只读路由（不占白名单）。
- 人才再发现工具只读、无打分/排名；排序按命中历史条件数 + 最近活跃时间，human-readable 不含百分比。
- 两个更长 prefix 路由都已回退既有详情读模型，未吞候选人页/岗位页详情（E2E 已验证候选人页与对比弹窗可正常加载）。
- PR #37 额外提交 `6d15ac2`：把 candidate-dedup GET 路由加入 `READ_ONLY_ROUTES`，确保 `WHITELIST=[]` 仍 PASS。

未合并 main；等待总控按 **#38 → #39 → #37** 合入并关闭 #35/#36。
