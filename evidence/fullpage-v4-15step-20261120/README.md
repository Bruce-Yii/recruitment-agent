# 独立整页 v4 · 15 步真点验收证据（2026-11-20）

> **后续**：PR #10（v4 前端 5 个 tsc 错误修复）合入 `af0fef5` 后，已在合并态独立复跑并另存权威证据：`evidence/fullpage-v4-15step-pr10-20261120/`。本目录保留为合并前基线（HEAD `e7a5284`）。

## 结论

- **15/15 PASS**（`--fresh`：一次性库 + 确定性数据集 + 独立 Chrome/Host）。
- 本目录是**总控独立复跑**的证据（不是交付方自述）：`2026-11-20 22:40:24 +08:00`，HEAD `e7a5284`，分支 `feat/unified-document-intake`。
- 交付方（Owner lane）同代码另跑一次：`2026-11-20 22:34:13 +08:00`，同样 **15/15 PASS**（快照见 `work/d5/fullpage/owner-run-2231/`，work/ 不入库）。
- 证据审计器（纯 node、零依赖）独立复核：**硬检查 0 失败**，软告警 3 条（均为 keyText 是 DB/HTTP 摘要而非页面文本，属预期），脱敏泄漏 0。

## 运行环境与命令

```
# 仓库根；Node 24；Chrome 由脚本经 CDP 9222 启动
$env:RECRUITMENT_DB_PASSWORD = '123456'
node work/d5/fullpage/run-v4.mjs --fresh --port 49347 --out work/d5/fullpage/lead-verify
```

- Host 端口 `49347`（§13.6 lane 端口 49347–49352；`49351` 是人工预览 Host，脚本显式排除；`49352` 曾被无关进程当作临时源端口占用，见 docs/17 D-169）。
- `--fresh` 由 `work/d5/fullpage/fresh-lib.mjs` 建一次性库（`ra_fresh_e2e_*`）+ 一次性 profile 副本 + 确定性数据集（候选人 T / A=…104 / B=…105；S12 隔离数据集），跑完**删库、删 profile 副本、删 token、删 Chrome profile、校验端口释放**。
- 复跑脚本在 `work/d5/fullpage/run-v4.mjs` + `fresh-lib.mjs`（按项目纪律 `work/` 不入库；本目录不保存含机器路径的脚本副本）。
- 判据映射：`work/d5/fullpage/TESTID-MAP.md`；testid 契约：`dsh/dsh-recruitment/src/app/TESTID-MANIFEST.md`。

## 本目录内容

| 路径 | 说明 |
|---|---|
| `runbook-result.json` | 15 步逐条结果（verdict/reason/keyText/extra/证据相对路径） |
| `PASS-FAIL-TABLE.md` | 逐条 PASS/FAIL + 判据 + 证据文件（人读版） |
| `audit-result.json` | 证据审计器输出（硬检查/软告警/脱敏扫描） |
| `gates.txt` | 本轮机检结果（tsc 已知红：5 条 v4 前端类型错，见 `design/v4/frontend-fixes-20261120.md`） |
| `evidence/Sxx-ui.png` | 1440×900 真机截图（CDP Page.captureScreenshot） |
| `evidence/Sxx-ui.txt` | 当步页面 innerText + verdict/reason + extra |
| `evidence/Sxx-db.txt` | psql 独立读回（SELECT-only，不 import 产品代码） |
| `evidence/S08-DRAFT-OWNER.txt` | S8 草稿归属的独立 psql 读回 |

## 证到了什么 / 没证什么

**证到**：在 v4 独立整页（`/recruitment/app`，无 DSH 外壳）上，由 CDP 真点完成 15 步；每步同时有「界面元素/文本 + 截图 + psql 读回」；写动作真的落库（decision/interview/interviewer/scorecard/scorecard_draft/event_inbox 行变化），且刷新后仍在；S15 真并发恰好 200×1 + 409×1、`record_version` 仅 +1；S10 缺面评拦截为 disabled 且零写入；S13 重复决策 total|current 仍 1|1。

**没证**：① 产品负责人本人手点抽检（R9 的"真人"这一层仍由 CDP 驱动）；② 8 条无界面写能力（compound/config/email authorize/feishu import 等，基线未变）；③ 对话桥（`/recruitment/agent/turn` 仍 503 降级，本 15 步不依赖）；④ 390 窄屏（D-168 口径：桌面 Web，不作要求）；⑤ 全量测试套件（本轮不是合并，未跑）。

## 已知机检红项（不掩盖）

`npx tsc --noEmit` = **5 个错误**，全部在 v4 前端 `src/app/**`（`prefetchCanvasPath` 单参调用 ×3、`nextStep.conclusion` 类型缺失 ×2）。这是把 `src/app/**` 真正纳入类型检查后暴露的既有缺陷（此前 app 不被任何 tsconfig 覆盖），已按 D-168 交前端，明细见 `design/v4/frontend-fixes-20261120.md`；前端修完前不满足合并门。
