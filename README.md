# recruitment-agent

**把散落在简历、面试官脑子里、聊天记录里的招聘上下文，按「人」串起来；用 Agent 把它变成人一眼能看懂的东西；判断权永远在人手里。**

它不是招聘平台、不是人事系统、不是沟通工具、不是流程引擎。

- **产品说明（这是什么 / 给谁用 / 现在能做什么 / 不做什么）** → [`docs/26`](docs/26-product-introduction.md)
- **产品认知与验收口径（唯一权威）** → [`docs/24`](docs/24-product-framework-v2.md)
- **接手交接（场景 / 判断框架 / 踩坑 / 地图）** → [`docs/25`](docs/25-lead-handoff.md)
- **前端审美与设计方法论（新窗口改 UI 必读）** → [`design/v4/design-system-guidelines.md`](design/v4/design-system-guidelines.md)（原型：[`design/v4/recruitment_os.html`](design/v4/recruitment_os.html)）

---

> **当前主干基线（2026-11-22）**：独立整页 `/recruitment/app`（v4 暖纸工作台，旧侧栏已退役 D-181）；对话 Agent 为严格只读（19 只读 / 0 写工具，支持 `navigate / focus_section / suggest_action / propose_write` 单轨联动）；Wave 1 / 2 / 2.5 已合入 `main`（建岗草案与审批/关岗、上传自动初筛摘要、IMAP 定时轮询分岗、转写自动生成待核对面评草稿、人工逐条纠偏、多候选人横向对比、历史人才再发现与候选人级去重提示）。全景竞品基准见 [`docs/39`](docs/39-recruiting-lifecycle-and-competitive-benchmark.md)，缺口路线图见 [`docs/40`](docs/40-lifecycle-gap-roadmap.md)。

## 0. 工程底座（看代码的人从这里开始）

招聘 Agent。**底座重置在 DSH（DeepSeek Harness）Web 版上**，招聘语义与验收标准原样继承。
本仓库只装"已经证明过的资产"，不装旧自研栈、不装 git 历史。

> **基线（2026-11-17）**：`main` = `feat/unified-document-intake` = `8cade0d`（tag `v1.0-dev-2026-11-17`）。
> 主干已与现行线合并、树完全一致；日常开发在 `feat/unified-document-intake`，里程碑合 `main`。
> 主干合并前的那条旧线保存在 tag `archive/main-pre-merge-2026-11-17`（历史可查，文件树以现行为准）。

---

## 1. 底座与核心

| 层 | 内容 |
|---|---|
| **底座** | **DSH（DeepSeek Harness）Web 版**。Web 与桌面**只是 UI 面不同，内核一致**（同一套运行时 / 插件 / 工具 / 会话 / 权限）。产品能力按 DSH 内核语义实现，UI 面按 Web 形态演进，桌面形态不构成第二套内核 |
| **核心** | **招聘语义**：五事实分离（业务 / 事件 / 任务 / 执行 / 副作用）· 状态机 · 不变量（Agent 不拥有不变量、人类闸门不可绕过、外部能力必须诚实标注） |
| **验收** | **E1–E4 + 分层验收**（见 §3） |

> **本仓库不含旧自研栈。** 旧仓库的 `apps/`、`packages/`、旧 `docs/`、`.env`、全部 git 历史**均未搬运**。
> 旧仓库 [`Bruce-Yii/Recruitment-OS`](https://github.com/Bruce-Yii/Recruitment-OS) 已冻结，**仅作只读参考**：不从这里提交、不再开 PR、不改 Issue。

---

## 2. 目录结构

```
docs/        22 份文档。2026-11-14 从旧仓库 work/handoff/*.md 搬运为底，此后持续更新；现行权威是 24（产品认知与验收口径）+ 25（总控交接）：
             01 业务链路 / 02 架构 / 03 领域与运行时 / 04 连接器 / 05 产品要求 /
             06 治理与现状 / 07 PRD / 08 运行手册 / 09 DSH 插件落位 /
             10 复用转换层 / 11 PDF 验收标准 / 12 分层验收
             + 04-scenario-plain-language.md（人话版场景）+ README.md（索引，先读它）
converter/   PDF 读取器（已验收的资产）：src/ 实现、corpus/ 清单、reports/ 结果
             · TASK-BRIEF.md 任务书 · FALLBACK-PLAN.md 降级方案
dsh/         DSH 侧补丁：dsh-pdf-fix/（PATCH.md 说明改了什么、为什么）
work/        决策台账与验收报告目录（见 work/README.md）
```

---

## 3. 验收标准（不可协商）

**E1–E4 四条硬规则**

| # | 规则 | 含义 |
|---|---|---|
| **E1** | 端到端可达 | 每个 PASS 必须给出从**运行入口**（HTTP 路由或 Worker）到事实的一条可执行路径：命令 + 真实输出 + DB 读回 + 路由注册 `file:line` |
| **E2** | skip 计入 | 必须报 `passed / failed / skipped` 三个数；`skipped > 0` **禁止**宣称全绿 |
| **E3** | 证据必须存在 | 被引用的 fixture / manifest / 报告必须在所指修订处**真实存在** |
| **E4** | 未接线不得通过 | 从运行入口不可达的 handler / adapter / service 是 `BLOCKED`，不是 PASS |

**分层验收**：可检验 / 可观测 / 模型兜底 / 人工兜底 / 系统治理 —— 每层要能在故障注入下说清"哪层兜住了、账平不平"（判据见 `docs/12-layer-acceptance.md`）。

配套铁律：外部能力标签三维正交（`provenance` LIVE/FIXTURE · `trigger` EVENT/MANUAL · `connection` CONNECTED/NOT_CONNECTED/AUTH_REQUIRED），**禁止**用 Fixture 冒充 LIVE。

---

## 4. 怎么跑 converter

`converter/src` 是包内模块，**在 `converter/` 目录下以 `-m` 运行**（不要 `python src/cli.py`）。依赖 PyMuPDF。

```powershell
cd converter
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install pymupdf

# 读一份 PDF，输出完整 JSON（带坐标证据 / 三态字段 / issues）
python -m src.cli .\path\to\resume.pdf --indent 2

# 只看摘要（completeness / 页数 / issue 分级 / 字段三态）
python -m src.cli .\path\to\resume.pdf --summary

# 写到文件；默认 50s 超时，超时记 reader_timeout 且不留半截正文
python -m src.cli .\path\to\resume.pdf --output out.json --timeout 50
```

```bash
# 批量：按 corpus/manifest.jsonl + corpus/synthetic/synthetic-manifest.jsonl 跑
cd converter
python -m src.batch_run --out reports/corpus-results.jsonl
```

**语料说明**：`corpus/manifest.jsonl` 里的原始简历 PDF **不入库**（且禁止入库），其中的 `path` 是旧机器绝对路径。
本仓库内批量跑前需按新环境重建 manifest；`corpus/synthetic/*.pdf` 是合成难例，体积大已被排除，可用 `corpus/build_synthetic.py` 重建。
单份读取（`src.cli`）不依赖任何 manifest。

> 读取器只读原件、不写原件目录；抽不出来的字段给 `partial` + issue，**不猜、不 OCR 造事实**。

---

## 5. 边界

- 本仓库**不含**：旧 `apps/`、`packages/`、旧 `docs/`、`.env` 或任何凭据、任何真实简历 PDF 原件、旧仓库 git 历史。
- 不修改旧仓库 `Recruitment-OS` 的任何内容，不向它开 PR / 改 Issue。
- 不使用真实候选人资料；真实外部产物只存 ID / 哈希 / 脱敏摘要。
- 依据与冲突裁决见 `docs/06-governance-and-current-state.md`；`docs/` 内文档互相冲突时按批准时间裁决。
