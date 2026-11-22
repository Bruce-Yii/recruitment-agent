# Wave 3 底座收紧与全链总验（2026-11-23）

基线：`origin/main 7695243`。纯取证分支；**零产品代码改动、未合并 main**。

## 结果总览

| 项 | 结果 |
|---|---|
| 干净库 0001→0024 + `db/verify.sql` | **PASS**（24 迁移，VERIFY PASS / BOOKING-STRUCT PASS） |
| 全量 `node test/run-all.mjs --test-concurrency=1` | **PASS**：3008 tests / 3004 pass / 0 fail / **4 skipped** / 0 cancelled |
| 390×844 公开预约页 | **14/15 checks PASS**；1 个真实产品发现：确认按钮高 **42px < 44px** |
| 1440×900 一镜到底全链 | **PASS 9/9**（FAIL 0 / BLOCKED 0） |

## 1. 干净库全量

- DB：一次性 `ra_evidence_clean_20261122`；24 个迁移全部 exit 0，台账 24 行。
- `db/verify.sql` exit 0：`VERIFY PASS`、`BOOKING-STRUCT PASS`。
- 全量测试首次 7 red 仅因环境变量缺 `RECRUITMENT_PYTHON`（`config.python_bin must be absolute`）；补齐 `RECRUITMENT_PYTHON` + `RECRUITMENT_PYTHON_BIN` + `RECRUITMENT_CONVERTER_DIR` 后 **0 fail**；两次原始日志均保留。
- 4 个 skip 均逐条具名（真实语料、上传 DB 成功/幂等、无 FS seam 的 standing skip），无静默丢弃。

证据：`runall-mobile/run-all-summary.json`、`run-all-full-rerun.log`、`run-all-full-first.log`、`verify-full.log`、`migration-apply.log`。

## 2. 390×844 移动端

- 真实 HR 邀约（3 时段，Asia/Shanghai，45 分钟）→ 无登录公开页；无横向溢出（scrollWidth=390=innerWidth）。
- 标题/轮次/时长/时区/3 个时段可见；点第 1 个时段 → 「已确认」，按钮全部 disabled；interview 6→7，invite `CONSUMED|0|<interview>`。
- **唯一 FAIL（真实产品发现）**：三个「确认此时段」按钮 `324×42 CSS px`，高度低于 44px 触控目标；根因 `src/http/booking-invite.ts` CSS `padding:11px 16px + font-size:14px`。本 lane 未改产品代码，留待裁决。

截图：`mobile-booking-390.png`、`mobile-booking-390-confirmed.png`；测量与 DOM：`mobile-booking.json`。

## 3. 1440 一镜到底全链（9/9 PASS）

新建 OPEN 岗（AI 草案 + 自定义维度）→ 批准标准 → 上传真 PDF 自动初筛（decision 0→0）→ 人工纠偏（criterion_override 0→1）→ 自助预约免登录确认（interview 6→7）→ 导入转写自动 2 份面评草稿（scorecard_draft 0→2，scorecard=0）→ 面试官提交 2 份面评（scorecard 0→2，facts READY）→ 终审 FINAL decision +1（stage S10）→ 展开追责时间线（49 条真实动作/操作人；零 UUID / 零完整 sha256 / 零「证据」）。

每步都有独立 psql 读回和 1440 截图（`01`…`08-trace`）；`full-chain-result.json` 含完整 extras。

### 诚实说明
- 跑前 `lib/app.js` 是陈旧构建（不包含新岗位 AI 草案 UI）；脚本用**同 HEAD 源码**重新 `tsdown`，跑后恢复构建产物，未改产品源码。
- 转写导入需要 meeting binding；仅在一次性库用 psql 补齐合成 meeting/binding（fixture），转写正文和 scorecard_draft 均由真实 UI POST 写入（200），未伪造草稿。
- 真实 UI 为面试官 A/B 各生成 1 份草稿（+2）；验收按“≥1 且无提交面评”判定，符合契约。
- 前 7 次尝试全部保留在 `full-chain/attempt-*` 供审计；最终结果以顶层文件为准。

## 文件

- `runall-mobile/`：全量测试、迁移/verify、390 移动端证据
- `full-chain/`：9 张 1440 截图、每步 DB/UI 文本、`probe-full-chain.mjs`、尝试归档
