# v4 独立整页 · PR #10 合入后的 15 步复验证据（2026-11-20）

## 结论

- **PR #10 已合入 `feat/unified-document-intake`**（merge commit `af0fef5`），内容是前端任务 10：`src/app` 3 个文件、5 个 tsc 错误修复（`prefetchCanvasPath` 补 fetcher；删死字段 `nextStep.conclusion`）。
- 合入后：`npx tsc --noEmit` = **0 错**；`npx tsdown` 双入口通过（`lib/app.js` 已重建并随 merge 提交）；15 步 `--fresh` 独立复跑 = **15/15 PASS**；三屏真悬停验证 = **3/3**（每次悬停触发 200 只读 GET，无 `fetcher is not a function`）。
- 本目录是该次**合并后**的权威证据（PR #10 之前的历史证据在 `evidence/fullpage-v4-15step-20261120/`）。

## 运行

```
$env:RECRUITMENT_DB_PASSWORD = '123456'
node work/d5/fullpage/run-v4.mjs --fresh --port 49347 --out work/d5/fullpage/lead-verify-pr10
```

- HEAD `af0fef5`，`2026-11-20T23:09:34+08:00`，FRESH 库 `ra_fresh_e2e_hic_1514ny`（已 drop），Host 49347 / Chrome CDP 9222，1440×900。
- 悬停探针：`node work/d5/fullpage/probe-hover-pr10.mjs`（同 `--fresh` 底座；只读 GET；结果 `hover-probe.json`）。

## 本目录内容

| 路径 | 说明 |
|---|---|
| `runbook-result.json` | 15 步逐条结果（verdict/reason/keyText/extra/证据相对路径） |
| `PASS-FAIL-TABLE.md` | 15 行逐条判据 + 证据文件 |
| `audit-result.json` | 证据审计器（hard 0 / soft 3 / leaks 0） |
| `gates.txt` | 合并后机检（tsc 0、tsdown、server-typecheck、runtime-budget、entry-reachability、client-contract-check、term-lint） |
| `hover-probe.json` + `hover/*.png` | 队列/岗位/人才库三屏真悬停（各 200 GET；无 fetcher TypeError） |
| `evidence/Sxx-*` | 逐步 1440×900 截图 + 页面 innerText + psql SELECT-only 读回 |

## 证到了什么 / 没证什么

**证到**：PR #10 合入后，v4 整页 15 步仍 15/15；写动作真的落库并刷新可见；S15 真并发 200×1+409×1 且 `record_version` 仅 +1；S10 缺面评 disabled 零写入；悬停预取从"运行时 TypeError"变为真实 200 请求。

**没证**：产品负责人本人手点抽检（仍是 CDP 驱动）；对话桥（503，本任务不依赖）；8 条无界面写能力；390 窄屏（不作要求）；全量测试套件（非合并轮，未跑）。

## 清理

一次性库已 drop、profile 副本已删、token 已删、Chrome profile 已删、49347/9222 释放；`49351` 人工预览 Host 全程未触碰。
