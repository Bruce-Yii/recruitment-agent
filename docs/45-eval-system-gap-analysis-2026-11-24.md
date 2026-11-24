# 45 · Eval V2 评测体系缺口独立审计（2026-11-24）

> **状态**：独立审计（总控），不是实现验收、不是产品验收。审计对象 = `main@acaccfbb`（PR #96/#97/#99–#101/#103–#107 合入后）。
> **证据口径**：只认仓库代码 `file:line`、CI run 记录、可复跑命令；不以实现者自述为证据。相关裁决：`docs/17` D-199（批次收口）、D-200（本审计结论与建议）、D-195/D-198（Eval/G3/飞书既有结论）。
> **一句话结论**：云端窗口把 Eval V2 从"66 判分器 + 3 适配器 + 手工 runner"推进到"P2–P6 真源提取 + CLI pass^k/readiness/L3 fail-closed + CI G0 门"，**方向正确但覆盖尚未到位**：CI 门是 contract 静态夹具、L3 无法真跑、没有 live 模型回路、Tier1/2 真实语料未进 CI；**不能据此宣称"评测体系完成"**。

---

## 1. 当前已有什么（盘点）

| 能力 | 证据（file:line） | 状态 |
|---|---|---|
| 66 个判分器（37 L1 + 22 L2 + 7 L3）注册、43 例 manifest（G0=11 / G1=24 / G2=8；Tier1=17 / Tier2=16 / Tier3=10） | `test/eval/corpus-manifest.json`；`v2-g0-runner.ts:51-56`；空 payload 0/66 的回归在 `v2-graders.test.ts` | ✅ 存在 |
| 语义红队（14 复验变体 + 原 17 变体全拦、合法对照 0 过拦） | `v2-redteam-l1/l2.test.ts`、`v2-graders-l1/l2.ts`；D-195 | ✅ 存在（残留 2 条 P2） |
| 真实适配器：converter→P1、agent-turn SSE→P6、PG 行数→P6 counts | `v2-real-adapters.ts:18-160`；CLI `run-eval-v2.mjs:20-25` 真实 import/调用 | ✅ 已接 CLI |
| P2–P5 / P6-08 / P6-09 从 PG17 自动提取 | `v2-pg-stage-extractor.ts`；`v2-funnel-driver.ts`；测试 `v2-pg-stage-extractor.test.ts`、`v2-funnel-driver.test.ts` | ✅ 有实现（依赖真实行） |
| CLI：contract/real 双模式、`--runs=K`（pass^k）、`--check-data`、`--l3` | `run-eval-v2.mjs:58-72, 386-476, 478-509` | ⚠️ 有参数，多数能力"半接通" |
| CI 新增 Eval V2 G0 门 | `.github/workflows/ci.yml:281-305` | ⚠️ 见 §3.1 |
| G3 三对真实护栏（确定性引用锚定等） | `src/domain/eval-telemetry.ts`；D-195 口径 B | ✅ 存在 |

## 2. 规格 vs 实现的覆盖矩阵（`docs/42`）

| 规格要求 | 实现/证据 | 判定 |
|---|---|---|
| **L1 确定性硬闸门**（66 graders、fail-closed） | 单测 + contract/real 均可跑；空 payload 0/66 | ✅ 判分器实现齐；但 **contract 输入的"真实度"不足**（见 §3.1） |
| **L2 轨迹/上下文不变量** | `v2-graiders-l2`、`v2-funnel-driver`、`v2-pg-stage-extractor` | ✅ 规则在；真实轨迹来源有限（见 §3.3） |
| **L3 主观裁判（LLM-as-Judge）** | `v2-l3-runner.ts:53-70` 只接受注入 invoker；CLI `run-eval-v2.mjs:492-509`；CI 强制 `L3_MODEL_NOT_CONFIGURED`（`ci.yml:300-303`） | ❌ **无法真执行** |
| **L4 稳定性（pass^k）** | CLI `--runs`；contract 重跑同一确定性 runner，real 模式直接复用同一 card（`run-eval-v2.mjs:464-476`） | ⚠️ 指标框架在，**当前无真实波动可测** |
| **Tier 1 私有语料 / Tier 2 外部基准** | manifest 17/16 例；`--check-data` 仅写 `data-readiness.json`（`run-eval-v2.mjs:478-486`）；CI 不校验 readiness | ❌ **未进 CI / 未参与门禁** |
| **G0 PR 快门** | 合同夹具 11 例 + passK + L3 必须未配置（`ci.yml:281-305`） | ⚠️ 是 contract smoke，**不是质量门** |
| **G1 模块定向门 / G2 发版全链门** | 无 CI 任务、无路径触发脚本；只有 `--gate` 参数 | ❌ 未实现 |
| **G3 上线后周度飞轮** | settings 展示 3 对护栏；无历史快照/趋势告警 | ⚠️ 只有"当前值"，无周度飞轮 |

## 3. P0 缺口（不修就不能宣称评测体系覆盖到位）

### 3.1 P0-1：CI 的 Eval V2 G0 门是"空转门"

- 门禁内容（`ci.yml:281-305`）：`run-eval-v2 --mode=contract --gate=G0 --runs=3 --check-data --l3`，然后断言 `totalCases>=11 && passedCount==totalCases && counterMetricsOk && passK==1 && l3.status=='L3_MODEL_NOT_CONFIGURED'`。
- 问题：
  1. **11 个 G0 案例的 artifact 是 `buildDefaultG0Artifact()` 的静态字面量**（`v2-g0-runner.ts:65-102`），不是真实 Agent 输出；但 manifest 里这些 case 标了 `data_tier=tier1_private_corpus`，卡片按 tier 统计会显示"Tier1 全过"。
  2. **`counterMetricsOk` 恒真**：CLI 从不传 `counterMetrics`（grep 无命中），`evaluateCounterMetrics(undefined)` 直接返回 `[]`（`evaluation-card.ts:90-96`），所以反向压制指标（TTFT/PDF P95/读不出膨胀/字数上限）根本没被检查。
  3. **`pass^k` 在 contract 模式是确定性的**（同一 `runEvalGateSuite` 跑 3 次）；real 模式更直接复用同一 card（`run-eval-v2.mjs:464-476`）——pass^k 目前不衡量真实模型波动。
  4. **`--check-data` 只写文件不参与断言**：CI 不检查 `corpus.status` / benchmark cache；Tier1/2 缺失照样绿。
  5. **门禁把 `L3_MODEL_NOT_CONFIGURED` 当通过条件**：一旦 L3 真正接通，CI 反而会红，门禁目标与评测目标相反。
- 结论：该门能证明"contract 契约没炸 + L3 保持 fail-closed"，**不能证明任何真实质量**。

### 3.2 P0-2：L3 裁判"名存实亡"

- `runL3AtomicJudge()` 在无注入 invoker 时恒返回 `L3_MODEL_NOT_CONFIGURED`；即使检测到 `RECRUITMENT_EVAL_MODEL_PROVIDER/MODEL`，也只返回"需由宿主运行时注入 L3ModelInvoker"（`v2-l3-runner.ts:56-70`）。
- 全仓没有任何地方实现/注入 `L3ModelInvoker`（grep 仅测试传入）；CLI `--l3` 只有**一条硬编码探针输入**（`run-eval-v2.mjs:492-500`），不是 43 例中的任何真实样本。
- 校准协议（κ/TNR、配平样本、A/B 互换）只有纯函数测试（`v2-l3-calibration.ts` / `v2-l3-g3.test.ts`），**没有真实校准数据集与一次真实校准报告**；`calibrationStatus` 在 CLI 里写死 `OBSERVATION_ONLY`。
- 后果：L3 标称的"主观质量（P2/P4/P5 文本忠实度、P3 参考语气）"实际没有被任何一次自动评测覆盖。

### 3.3 P0-3：没有 live 模型评测回路

- V2 CLI 只有 `contract` / `real` 两种模式（`run-eval-v2.mjs:75-80`）；`real` 是"读 capture bundle"，**不是"让被测模型真实回答再打分"**。
- 旧 V1 runner 有 `--mode=live`（`run-eval.mjs:165-220`，POST `/recruitment/agent/turn`，18 例，延迟/token 统计），但：① CI 不跑；② 与 V2 的 43 例/P1–P6 判分器完全没接；③ 该 runner 注释仍称 18 例，属遗留体系。
- 现在的 real SSE capture 用固定提示 `TURN_TEXT='请只回复"收到"，不要调用任何工具。'`（`capture-real-inputs.mjs:42`），产出 2 帧（delta+done）；P6-01/P6-05 的"真实轨迹"实际是一条极简回复，不能代表多轮/工具轨迹。
- 后果：**P2 建议话术、P3 参考语气、P4 草稿忠实度、P6 言行一致等真正依赖模型输出的判据，没有 live 证据**；现有证据是 DB 投影 + 静态 contract 夹具。

### 3.4 P0-4：真实数据未参与门禁，real 覆盖率低

- Tier1/2 共 33/43 例，但 CI 环境没有 `RECRUITMENT_CORPUS_ROOT`、`work/eval-cache/` 也不在仓库；CI 只"检查 readiness 文件存在与否"（实际连断言都没有）。
- `--mode=real` 的最大真实源覆盖是 9/43（`run-eval-v2.mjs:298-370`：P1-01、P2-01、P3-01、P4-06、P5-01、P6-01、P6-05、P6-08、P6-09）；而 `capture-real-inputs.mjs` 新建的一次性库只有 0001→0025 种子，不产生 interview/scorecard/decision 全漏斗，因此 **fresh capture 实际通常只有 P1 + P6（约 3 例）**，P2–P5/P6-08/09 的 `stages/*.json` 为空。
- 真实漏斗提取（#107）自身有测试，但测试是用**手写 SQL fixture** 构造漏斗（`v2-pg-stage-extractor.test.ts:113-170`），不是由产品真实动作产生；作为工程测试合理，但不能当"真实闭环"证据。

## 4. P1 缺口（覆盖有，但不足/易误读）

1. **real 覆盖不足**：最多 9/43、常态约 3/43；P1 只有 1 例，P2–P5 各 1 例；无失败/边界样本进入 real 运行。
2. **pass^k 语义错位**：contract 下测确定性代码；real 下复用同一结果；只有 live 模式多跑才有意义（见 §3.3）。
3. **反向压制指标未采集**：`counterMetrics` 只在单测里构造，CLI/CI 不计算 TTFT、PDF 解析+初筛 P95、读不出膨胀率、字数上限（`v2-types.ts:88-104`；`evaluation-card.ts:90-115`）。
4. **无基线 Diff**：`EvaluationCard` 支持 `baseline`（`evaluation-card.ts:28-77, 158-180`），但 CLI 不加载上一版卡片；无回归趋势。
5. **G1/G2 未进 CI**：没有路径触发（改 converter/skill/agent-turn 跑受影响的 P 子集），没有发版前 43 例 + Tier1/2 + 已校准 L3 + pass^3 的任务。
6. **L3 提示词未入库锁版**：judgeVersion 由调用方字符串传入，prompt 在 `v2-l3-runner.ts:41-51` 代码里拼；无 prompt hash/registry/变更记录，不满足 `docs/42 §5.3` "裁判 Prompt 版本入库锁定"。
7. **校准集缺失**：Tier B 标注集（含好例/坏例配平、acceptable_bands、must_catch_points）不存在于仓库/CI；κ/TNR 无法真算。
8. **红队只有确定性规则**：14/17 变体由字符串/结构规则拦截；无 live 模型下的注入/言行对抗运行（E-15/16/17/18 旧 live 用例未接 V2）。
9. **P2–P5 的"真实适配"是 DB 投影，不是模型输出**：extractor 从 screening/decision/transcript/scorecard 行重建 artifact；这能验证"落库事实与判分器链路"，但不能验证"模型回答文本是否说人话/越权/三段结构"。
10. **采集器不驱动产品**：`capture-real-inputs.mjs` 只读 DB（`captureStagesFromPg:385-433`），未跑 S6–S10 真动作；15 步剧本（`docs/37`）与 Eval 仍然分离。

## 5. P2 缺口（质量与可维护性）

1. L3 的原文锚定用 `sourceMaterial.includes(quote)` 简单子串（`v2-l3-runner.ts:76`），未校验唯一性/最小长度/位置，A/B 互换只比 verdict，不足以替代 κ 校准。
2. 阈值与文案硬编码（`DEFAULT_COUNTER_METRICS_THRESHOLDS`），无配置版本/按阶段覆盖。
3. `data-readiness.json` 的状态不 gate、不趋势；`CACHE_MISSING` 与 `READY` 在 CI 中无区别。
4. contract 模式下 manifest 的 tier 标签会进入卡片 `byDataTier` 统计；只看卡片容易把"静态夹具"误读成"Tier1 真实结果"（虽 `executionMode=contract_smoke` 有标注，但报告消费方未必看）。
5. 旧 V1 runner（18 例 live）与 V2 体系并存，无迁移/废止计划；CI 只跑 V2 G0。
6. G3 只有 settings 当前值，无周度快照/趋势/告警（`docs/42 §6` 的"周度飞轮"未实现）。
7. 本批 #96–#107 的产品验收状态未独立复核；`docs/17`/`docs/44`/`docs/40` 已由 D-199/D-200 补齐，但仍缺真机/独立 readback。

## 6. 优化方向（建议优先级，待产品负责人拍板）

1. **拆门并修正语义（先做）**：把 CI 的 `Eval V2 G0 gate` 明确改名为 `contract smoke`；新增真正的 `quality gate`（可在 main 合并后/发版前跑）——real/live + Tier1/2 + 已校准 L3；门禁不再要求 `L3_MODEL_NOT_CONFIGURED`，而是允许"未配置（显式跳过）"或"已执行且 GATE_ELIGIBLE"，两者之外 fail。
2. **接通 L3**：实现宿主侧 `L3ModelInvoker`（复用当前模型路由，不写死模型名）；prompt 文本入库 + hash + 版本；用 Tier B 校准集跑 κ/TNR，输出校准报告；未过门槛保持 `OBSERVATION_ONLY` 且不阻塞 G2。
3. **给 V2 CLI 加 live 模式**：复用旧 runner 的 `/recruitment/agent/turn` 调用；跑 P1–P6 的真实问法（含 E-15/16/17/18 对抗），采集 TTFT/token/工具轨迹/DB counts 前后值；pass^k 只在 live 多跑上计算。
4. **真实数据门**：`--require-data` 或 G2 专用任务，强制 `RECRUITMENT_CORPUS_ROOT` 与 `work/eval-cache/` READY；CI 只允许在显式声明"无数据、跑 contract smoke"时跳过。
5. **端到端采集**：新增"跑一遍 S6–S10（或 15 步）→ 从 PG 提取 stages → 生成 capture"的驱动脚本，替代"手写 SQL fixture 当真实证据"；测试 fixture 保留在单测。
6. **反向压制指标接入**：live/real 运行计算 counter metrics 并传入卡片；让 `counterMetricsOk` 真正参与门禁。
7. **基线/趋势**：卡片落 `evidence/eval-baselines/` 或 artifact，CLI 增加 `--baseline`，CI 输出 newlyRegressed/newlyFixed。
8. **G1/G2/G3 飞轮**：CI 路径触发 G1 子集；发版任务 G2 全量；G3 周度快照入库/入看板（不新增拍脑袋指标）。
9. **红队 live 化**：把 14/17 变体 + 提示注入 + 言行一致（Halluci-Action）搬进 live 模型运行；确定性测试保留为快检。
10. **报告诚实化**：每张卡片显式列 `executionMode` + 每个 case 的 artifact provenance（LIVE/FIXTURE），tier 统计只在 real/live 数据上展示。

## 7. 本次审计证据与方法

- 代码：`dsh/dsh-recruitment/test/eval/**`（38 个文件）、`.github/workflows/ci.yml:281-305`、`src/domain/eval-telemetry.ts`。
- CI：PR #107 修复后 run `45419157624` 5/5 绿；main `acaccfbb` run `45420027569` 5/5 绿（converter acceptance 条件跳过）。
- 复跑：`cd dsh/dsh-recruitment && npx tsc --noEmit`（0）；`node --test test/eval/*.test.ts` 需 DB 环境（`v2-pg-stage-extractor.test.ts` 依赖 `RECRUITMENT_DB_PASSWORD`），无 env 时该文件 fail——这本身也说明 eval 套件对 DB 环境有隐式依赖。
- 未做：live 模型调用（L3 未配置）、Tier1 私有语料、真机 15 步；这些是 §3 的缺口本身，不是审计省略。

## 8. 结论

- **覆盖到位程度**：工程底座与确定性判分器已经较完整（66 graders、语义红队、fail-closed、真实 adapter 接线、PG 提取、CI smoke）；但**产品级 eval 仍未成立**——没有 live 模型、没有 L3、没有真实语料门、CI 门是 contract smoke。
- **下一步**：按 §6 的 1–5 先补，再谈"Eval V2 完成"；在这些 P0 关闭前，任何"评测体系已覆盖/已通过"的说法都不成立。
