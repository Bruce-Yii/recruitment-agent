# 45 · Eval V2 评测体系：目的、框架与闭环（2026-11-25 重排）

> **状态**：总控裁决文档（`docs/17` **D-201**），取代 D-200 的“缺口优先”叙述，但保留其审计盘点作为**框架下的 closure backlog**。
> **对象**：`main@6477540`（PR #96/#97/#99–#101/#103–#108 合入后）。
> **一句话**：**先回答“评测为了什么”，再由此长出框架；框架正确后，闭环与缺口才有意义。** 当前框架骨架对，但实现把“夹具通过/CI 绿”当成了质量结论；S6 文件接入是项目里最接近正确做法的一块，应作为第一个参考切片。

---

## 0. 结论摘要

- 评测体系的目的不是给模型打分，是**给产品决策提供可复核的证据**：在真实招聘动作里，AI 的辅助是否让 HR/面试官更快做对判断，且没有越权、撒谎、丢事实；失败能否定位并回归。
- 由目的推出的框架 = **对象轴（业务动作）× 证据轴（L1–L6 + provenance）× 节奏轴（G0–G3）**，外加防 Goodhart 约束。
- 现有实现：**对象轴偏 payload、证据轴倒挂（L1/L6 强，L3/L4/live 弱）、节奏轴错位（G0 smoke 冒充质量门）**；评测覆盖未到位。
- 正确顺序：**先定对象清单与每格证据标准（S6 先行）→ 再修门禁语义 → 再补 live/L3/Tier1-2 → 最后做基线/飞轮**；先修 L3/CI 而不先定对象，等于给错误对象打分。
- S6 文件接入：早期 `docs/11/12/22` 的设计仍然正确，但验收报告是 2026-11-12 旧仓一次性执行，当前 CI 只有 compile；`docs/19` 契约只在未合入分支。S6 应作为框架的第一个 worked example，并恢复持续验收。

---

## 1. 评测体系为了什么

### 1.1 一句话目的

**在真实招聘的一天里，用可复核的证据回答：AI 是否只做辅助、且真的帮人做得更快更对；如果不行，是哪一环、什么证据、怎么回归。**

### 1.2 三层目的

| 层 | 要回答 | 不是 |
|---|---|---|
| **业务** | HR/面试官的真实职权有没有被尊重：筛、约、推、评、拍板仍由人做；AI 不越权、不替人决定、不索要材料 | 不是“Agent 能答多少题” |
| **产品** | 六个产品门 V1–V6 在真实动作里成立：上下文闭环、辅助不傻、人的闸门、外部事实诚实、看得见、可恢复 | 不是“43 例全过/66 判分器注册” |
| **工程** | 失败可发现、可归因、可回归；成本可接受（时间/模型/数据） | 不是“测试数/CI 绿/通过率” |

### 1.3 非目标（出现即跑偏）

- 模型排行榜 / 通用能力评分；
- 以判分器数量、用例数量、pass rate 作为进度或交付证明；
- 用 fixture/DB 投影冒充真实产品行为；
- 为了让门变绿而放宽断言或把 skipped 当 pass；
- 把 L3 主观裁判未配置当作“通过条件”。

---

## 2. 框架

### 2.1 主从关系（本轮拍板）

**评测对象以“业务动作闭环”为主，模型输出质量为辅。**
判分器、LLM-as-Judge、payload 断言都只是**证据工具**；它们不能替代“角色在真界面完成动作 + 结果写库并独立读回”这一层。

### 2.2 三条轴 + 一条约束

| 轴 | 回答 | 内容 |
|---|---|---|
| **对象轴** | 评谁、在什么动作、对什么对象 | S6 收简历 → S7 初筛 → S8 约面/给面试官参考 → S9 转写/独立面评 → S10 汇总/决策/复盘；每格绑定角色（HR/面试官）、业务对象、正常/失败边界 |
| **证据轴** | 凭什么算过 | L1 可达（真入口/真会话）→ L2 业务真相（独立 DB 读回）→ L3 外部事实（LIVE/FIXTURE、artifact、sha、回执）→ L4 人的判断（真界面真点）→ L5 反证（越权/错版本 fail-closed 且零写入）→ L6 机检；每份 artifact 必须标 provenance |
| **节奏轴** | 什么时候跑、跑多大 | **G0 contract smoke**（分钟级，只证明契约不炸，不产质量结论）→ **G1 slice gate**（改动影响的 S/P 切片，real 子集）→ **G2 release gate**（全量 + Tier1/2 + live 模型 + 已校准 L3 + pass^k + 反向指标）→ **G3 生产护栏**（周度成对指标） |
| **约束** | 防 Goodhart | 信息密度/最小原文锚定/可扫读上限、读不出误报率、TTFT/PDF P95；人的闸门不可绕过；失败零写入 |

### 2.3 框架规则（门禁必须遵守）

1. **证据等级匹配**：低层证据（contract/fixture）不得支撑高层结论（产品可用）；G0 只能叫 smoke。
2. **跳过不是通过**：corpus/live/L3 未配置必须显式 `SKIPPED/BLOCKED`，不得计 pass，也不得作为绿门条件。
3. **失败必须可归因**：任一失败要能落到“哪个 S/P 切片、哪条证据、哪个角色动作”。
4. **成本预算**：G0 ≤2 分钟、G1 3–8 分钟、G2 15–30 分钟；超预算先砍范围，不砍证据等级。
5. **不新增拍脑袋指标**：所有指标必须来自真实动作或明确的负例；G3 只做成对护栏（D-196 口径）。

---

## 3. S6 文件接入：第一个参考切片（worked example）

### 3.1 对象与业务闭环

`Source Event → Intake Record → Intake Asset → Resume Version → Candidate / Application → S7 可引用`

业务边界（真实高频，必须进评测）：
- 一封转发邮件含三份简历 → **3 条独立 Intake Record**；
- 重复投递/重复推送 → 复用同一 Candidate/Application，不重复建档；
- 扫描件/图片件 → 判“读不出来”，**不得伪造正文、不得自动合并**；
- OCR/agent_read 抽出的姓名/电话/邮箱 → **不得驱动自动候选人合并**；
- 同名不同人 → 不猜，给人选；
- 多版本冲突 → 显式化，不静默覆盖；
- 平台噪声/页眉页脚 → 排除，不污染字段；
- 幂等重放 → 同输入不产生重复业务行。

### 3.2 证据标准（沿用早期设计，不重造）

- `docs/11`：**A 保真**（页覆盖、逐页字符 Counter、顺序可信、链接不猜、坏字形不进正文）、**B 诚实**（页字符过少/无文本/加密/损坏必须报 code，不得静默）、**C 稳定**（幂等、原件 sha 不变、超时报 issue）、**D 下游可用**（字段可回指 page+bbox、provenance 逐块标注、OCR/agent_read 身份字段不进自动合并）。
- `docs/12`：五层故障注入——可检验 → 可观测 → 模型兜底 → 人工兜底 → 系统治理；**每层验收 = 注入已知失败，验证在哪层被发现、以什么形态、能否被接住**。
- 证据形态：机检 + 人工读原件双轨；**所有 HARD issue 必读**；人工抽读 ≥20%；语料身份 = sha256（原件不入库）；坏语料进 quarantine 并记账。
- 历史验收报告（`converter/reports/acceptance.md`，2026-11-12）：84 份/553 页，13/13 通过、0 failed、0 skipped；553/553 页字符恒等式；0 凭空 URI；0 坏字形进正文；扫描件识别 100%；两次批跑 byte-identical；34/84 带 HARD 是“读不全就说读不全”的诚实结果；人工读原件 42.9%；2 项 BLOCKED 能力明列。

### 3.3 S6 的门（按节奏轴落位）

| 门 | 内容 | 证据 |
|---|---|---|
| **G0 smoke** | `converter/tests` 单测 + 契约/映射测试（不碰真实语料也可跑） | passed/failed/skipped 明确；skipped 不算过 |
| **G1 slice real** | 改动 converter/解析/接入时跑：真实语料子集 + 接入业务用例（多简历拆分、去重、幂等、读不出不合并） | 机检 + DB 读回（intake_asset/resume_version/application） |
| **G2 release** | 全量 84 份语料 + 人工抽读 + HARD 全读 + 按载体分层门槛 | 验收报告 + sha256 清单 + 基线 Diff |
| **G3 prod** | 解析 HARD 率、人工补录率、自动合并异常率等成对护栏 | 周度快照，不刷单向指标 |

### 3.4 S6 现状：设计对，闭环断

- **设计仍在**：`docs/11`（2026-11-12）、`docs/12`（2026-11-12）、`docs/22 §G` 仍是对的做法；`converter/corpus/manifest.jsonl`、quarantine、13 项清单、验收报告都在。
- **闭环断了**：
  1. 验收报告是旧仓 `recruitment-os/converter` 的 2026-11-12 一次性执行；当前 main **没有重跑过 84 份语料验收**；CI `converter (acceptance tests, needs corpus)` 默认跳过（`ci.yml:79-100`），只有 compile 是绿的。
  2. **权威契约缺位**：`docs/17` D-85 称 `DocumentContent`（docs/19）为解析层唯一权威，但 `docs/19-unified-resume-understanding-implementation.md` 只在未合入分支（`6178772` 不是 main 祖先），当前 `docs/` 树没有该文件。
  3. **没有并入 Eval V2**：43 例里文件接入只有 P1-01 一个 converter 案例；S6 的业务闭环（拆分/去重/不合并/幂等/版本冲突）没有进 EvaluationCard、G0–G3。
  4. `docs/22 §二` 自己列的 7 个“没做好”（兜底链路断、归因不足、发现≫解决、DOCX 文本框、真实语料没跑、判据与真实分布失配、读不出错误不可诊断）没有一次“当前 main 重新审计”。

### 3.5 S6 的 closure 清单

1. 恢复受控 corpus acceptance（定时/手动 runner + `CORPUS_AVAILABLE`），报告带 sha256/日期/基线 Diff；**跳过显式，不算绿**。
2. 恢复或正式 supersede `docs/19`，让 `DocumentContent` 权威在 main 可见；`docs/42/45` 引用 `docs/11/12/22`。
3. 把 S6 业务闭环用例加入 Eval V2（多简历拆分、重复投递、读不出不合并、OCR 身份字段、版本冲突、幂等）。
4. 把 S6 接进 G0/G1/G2/G3（按 §3.3）；先做 G1 real 子集，再扩 G2。
5. 用 `docs/11` 13 项 + `docs/12` 五层故障注入作为 S6 的证据模板，**不要另造一套**。

---

## 4. 其余切片可执行验收单（S7–S10 + P6，一页收口版）

> **统一口径**：`fixture` / `contract_smoke` 仅用于 **G0 契约冒烟**（证明接口/规则不炸），**绝不作为产品质量通过结论**；任何切片要算“真实通过”，必须同时具备 **L2 独立 DB 读回 + L4 真界面点击（或 LIVE 标签）+ L5 越权/失败零写入反例**。

| 切片 | 角色 × 业务动作（对象） | L2 独立 DB 读回真凭据 | L4 真操作 / L3 外部实证 | L5 失败/越权/读不出边界（必拦且零写入） | 门禁落位 |
|---|---|---|---|---|---|
| **S7 初筛** | HR 用**已批准**岗标核对材料 → 产三态 + 纠偏 + 人确认（`application` + `rubric_version` + `criterion_override`） | `criterion_override` 记有 `actor_id` 与确认文本 sha256；未拍板前不新增 `SCREENING` decision | 真界面点“确认/纠偏”；每条 `有对应` 可回指原文；建议后明确“这是建议，不是决定” | 缺原文强行写 `有对应`、拿 `读不出来` 当 `没有对应`、或未批准岗标直接开筛 → 必拦且零写入 | G0 smoke / G1 slice / G2 real+L3 |
| **S8 约面/参考** | HR 查面试官忙闲并生成**本轮参考**（`interview` + `interviewer` + `candidate_constraint`） | `interview` 落库且带时区；未确认前不发出真实日历邀请 | 日历读回带 `LIVE/CONNECTED`（D-198）；参考只列岗标未覆盖项、无指令语气 | 冲突时段、`FIXTURE` 冒充 `LIVE`、参考里泄露上一轮评分或越权直接拉会 → 必拦 | G0 smoke / G1 calendar / G2 live |
| **S9 转写/面评** | 飞书妙记回读或手工导入 + 面试官写独立面评（`transcript_artifact` + `interview_record` + `scorecard_draft` + `scorecard`） | `transcript_artifact` 带 `provenance/trigger_mode/connection_state` + `content_sha256`；未核验时 `interview_record` 锁死 `NEEDS_REVIEW/UNVERIFIED` | 真界面刷新不丢草稿；未提交草稿不进汇总；回读失败不假装已连接 | 未核验转写冒充 `READY/VERIFIED`、A 面试官偷看 B 未交面评、草稿算成已提交 → 必拦 | G0 smoke / G1 intake+draft / G2 live+L3 |
| **S10 汇总/决策/复盘** | 汇总各方事实与缺席情况 → 人拍板 → 半年后按旧岗标回溯（`decision` + `undo_log`） | `decision` 必带 `decided_by_actor_id/decided_at/reason/basis_refs`；改绑用旧 `rubric_version_id` 不重写历史 | 真界面拍板与撤回；冲突面评保留双方原话不站队；缺面评醒目标出且**不折算 0 分** | 输出直接下“建议录用/淘汰”结论、用新版岗标倒推旧决定、或对外泄露 UUID/SHA → 必拦 | G0 smoke / G1 decision / G2 real+L3 |
| **横切 P6** | 对话与画布联动、言行一致（`chat_thread` + `business_task` + `durable_effect`） | `durable_effect` / `task_attempt` 与页面状态一致 | `agent/turn` SSE 轨迹与回复对账；写操作只发 `propose_write` 等人点 | 没调工具/没落库却口头宣称“已创建/已改好”（Halluci-Action）→ 必拦且零写库 | G0 smoke / G1 SSE / G2 live multi-turn |

---

## 5. 现状对照：框架三处错位

### 5.1 错位

1. **对象错位**：大量评测给 payload/artifact 打分（contract 夹具、DB 投影），不是“角色×动作”的真实闭环；S6 被隔离在 converter 测试里，S7–S10 没有显式对象清单。
2. **证据错位**：L1/L6 强，L3（真主观裁判）、L4（真人真点）、live 运行几乎为空；CI 用 11 个静态夹具当质量证据（`ci.yml:281-305`），`counterMetricsOk` 恒真（CLI 不传 counterMetrics），`pass^k` 在 contract 下确定性、real 下复用同一 card。
3. **节奏错位**：G0 smoke 被当质量门；`L3_MODEL_NOT_CONFIGURED` 被当通过条件；G1/G2 未接；Tier1/2 真实语料未进 CI（`--check-data` 只写文件不 gate）；real 覆盖最大 9/43、fresh capture 约 3 例。

### 5.2 D-200 盘点保留为 closure backlog

| 原级别 | 内容（不重复展开） | 在框架里的位置 |
|---|---|---|
| P0-1 | CI G0 门空转（静态 11 例、counterMetrics 恒真、pass^k 确定性、强制 L3 未配置） | 节奏轴/证据轴错位 → Phase 2 |
| P0-2 | L3 无可注入 invoker、CLI 仅硬编码探针、无真实校准集 | 证据轴缺 L3 → Phase 3 |
| P0-3 | V2 CLI live 回路：MVP 已落地（P6-01/P6-05，2/43，见 D-202）；全 43 例/其余切片 live 仍未覆盖 | 证据轴缺 live / L4 → Phase 3 继续 |
| P0-4 | Tier1/2 未进 CI；real 覆盖低；采集器不驱动 S6–S10 | 数据轴/对象轴 → Phase 3 |
| P1/P2 | real 覆盖、pass^k、counter metrics、baseline、G1/G2/G3、prompt 版本、红队 live、DB 投影、旧 runner、tier 标签、docs 债 | 按切片并入 Phase 2–4 |

---

## 6. 闭环顺序（先框架，后缺口）

### Phase 1 · 定对象与证据标准（纯文档，已收口）

- [x] S6 参考切片（本文 §3）；
- [x] S7/S8/S9/S10 + P6 一页可执行切片验收单（本文 §4）；
- [x] 每个切片的“通过证据”清单（L2 DB 读回 + L4 真点/LIVE 标签 + L5 反例）；
- [x] 明确“`fixture` / `contract_smoke` 仅用于 G0 smoke，不代表产品真实质量”。
- **完成标准**：任何人拿到 §3 与 §4 表格，能直接对照 DB 与界面判断这一格算不算过。

### Phase 2 · 修门禁语义（不依赖真实语料，CI smoke 已修）

- [x] CI 的 `Eval V2 G0 gate` 改名为 **`Eval V2 G0 contract smoke (non-quality)`**，只证明契约与 fail-closed；
- [x] 删除“`L3_MODEL_NOT_CONFIGURED` 当通过”的误导断言，未配置时明确输出 `SKIPPED/UNCONFIGURED (not counted as quality pass)`；
- [ ] `--check-data` 的 readiness 强制卡住 G2 release 门（待 Phase 3 真语料环境接入）；
- [x] 未配置项在 CI 日志中显式标出 `SKIPPED/UNCONFIGURED`，不计入质量 pass。
- **完成标准**：CI 绿不再被误读为质量结论，下一步直接用真简历 + 真模型跑产品闭环。

### Phase 3 · 补证据能力（按切片，不按全局）

- [ ] L3 invoker + prompt 入库 + Tier B 校准（κ/TNR）；
- [x] V2 CLI live 模式 MVP（P6-01/P6-05 真 Host 跑通；`--runs=K` 真 POST pass^k、TTFT/token；全 43 例待扩展，见 D-202）；
- [ ] Tier1/2 数据门与 `--require-data`；
- [ ] S6 端到端采集（S6–S10 真动作→PG 快照），替代手写 SQL fixture；
- [x] TTFT counter metrics 已进 live 卡片（TTFT 违约时 `counterMetricsOk=false`）；其余反向指标待扩展。
- **完成标准**：每个切片的 G2 证据能同时给出“真模型 + 真数据 + 真 UI/DB”。

### Phase 4 · 持续飞轮

- [ ] baseline/趋势（卡片落盘、Diff、回归告警）；
- [ ] G1 路径触发、G2 发版任务、G3 周度快照；
- [ ] 红队 live 化、S6 定时 corpus acceptance、S7–S10 真实语料回归。
- **完成标准**：评测能回答“这次改动让哪个切片变好/变坏”，而不是只报通过率。

---

## 7. 防 Goodhart 与边界

- 强制反向指标：信息密度/最小原文锚定/30 秒可扫读、读不出误报率、TTFT/PDF P95；不得只报质量不报成本。
- 人的闸门不可绕过：任何评测不得用 fixture 证明“人点过了”；L4 必须真界面真点。
- 不新增拍脑袋指标；G3 只做成对护栏（D-196）。
- 不因“保测试/保绿”放宽断言；跳过不算过（R3）。
- 真实语料/简历/会议原文不触碰（R7）；语料身份用 sha256，原件不入库。

---

## 8. 证据与复跑

- 早期 S6 设计：`docs/11-pdf-acceptance-criteria.md`、`docs/12-layer-acceptance.md`、`docs/22-resume-layer-audit.md §G`；语料定义 `converter/corpus/README.md`；报告 `converter/reports/acceptance.md`（2026-11-12，旧仓执行）。
- 契约历史：`docs/19-unified-resume-understanding-implementation.md`（仅未合入分支 `6178772`）。
- 当前 Eval V2：`test/eval/**`（43 例 manifest：G0=11/G1=24/G2=8；Tier1=17/Tier2=16/Tier3=10）、`.github/workflows/ci.yml:281-305`、`run-eval-v2.mjs`。
- CI：PR #107 修复后 run `45419157624` 绿；main `acaccfbb` run `45420027569` 绿；文档 PR #108 run `45433084141` 绿。
- 本文件是框架裁决与闭环计划，不是实现验收；未跑 live 模型、未接触 Tier1 私有语料。

---

## 9. 待拍事项

1. Phase 1 的 S7/S9/S10 切片卡优先级（建议 S10 先于 S7：决策/追溯是产品最敏感处）。
2. Phase 2 是否允许在 CI 里保留“L3 未配置”的显式跳过分支（建议允许，但必须 `SKIPPED` 且不计 pass）。
3. Phase 3 的 live 模型运行放在本机 Host 还是受控 CI runner（涉及成本/凭据，需另定）。
4. S6 corpus acceptance 的持续运行方式（本机定时/受控 runner/发布前手动）。
