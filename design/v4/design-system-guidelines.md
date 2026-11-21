# Recruitment OS v4 · 设计方法论与审美红线（Design System Guidelines）

> **定位**：本文件是将定稿原型 `design/v4/recruitment_os.html` 与全程演进台账 `design/evolution-ledger.md` 浓缩后的**可执行设计宪法**。任何新接手的前端/产品窗口在修改 `src/app/**` 或 `src/client/canvas/**` 之前，**必须先通读本文件**，并与 `design/v4/chat-canvas-interaction-spec.md`、`design/v4/contracts/design-tokens.md` 联合遵守。

---

## 1. 核心审美定调：暖纸编辑感决策工作台

Recruitment OS **不是**传统 SaaS 后台表格/仪表盘，而是**“暖纸编辑感决策工作台”**。

- **秩序来源**：用**留白、字号层级、字重对比、1px 极细分隔线**建立层次，而不是用卡片套卡片、投影和彩色胶囊堆砌。
- **信息克制**：画布默认只呈现当前决策所需的最小事实集；低频动作与长历史默认折叠或收进弹窗，保持呼吸感。
- **定稿基准**：所有像素级细节以 `design/v4/recruitment_os.html`（1440×900）为唯一视觉参考，严禁脱离原型退化为后台表单风。

---

## 2. 三层暖纸材质与色彩纪律

所有色值严格引用 `design/v4/contracts/design-tokens.md`，禁止自造近似色：

| 层级 | Token | 色值（Light） | 唯一职责 |
|---|---|---|---|
| **底层导航轨** | `--rail` | `#F3F2EE` | 左侧 204px（折叠 56px）空间导航栏 |
| **中间暖纸层** | `--paper` | `#F9F8F5` | 中间 324px Agent 对话栏、行 hover 滑行底色、轻提示/摘录块 |
| **主画布白纸层** | `--surface` | `#FFFFFF` | 右侧决策画布主底色、输入框、居中确认弹窗 |

- **禁止二次套壳**：在 `--surface` 白底画布上，区块之间用 `1px solid var(--line-soft)` 和 `32px–36px` 间距分隔，**不要给区块外再包带边框和投影的圆角卡片**。投影（`--shadow-card` / `--shadow-modal`）只允许用于悬浮对话输入框与居中确认弹窗。
- **语义色克制使用**：`--ink (#191918)` 主文字、`--text (#42423F)` 正文、`--muted (#787772)` 次要信息、`--soft (#A6A59E)` 弱提示；`--iris`（进行中/联动高亮）、`--green`（达标/通过）、`--amber`（待核实/注意）、`--red`（超时/置顶约束/风险）仅用于关键状态点睛，不铺满大面积色块。

---

## 3. 三层渐进壳与 56px 单一地平线

- **空间布局（1440×900 基准）**：左 Rail `204px`（可折叠至 `56px` 图标轨）+ 中 Chat `324px`（可拖拽调宽/折叠）+ 右 Canvas `1fr`（正文 `max-width: 820px`，对话折叠时放宽至 `920px`）。
- **56px 单一顶栏地平线**：三栏顶栏高度严格统一为 `56px`，底边分隔线水平贯通；画布区**严禁出现双层顶栏**。
  - 队列顶栏使用 `.canvas-tabs`（文字 + 底部 `2px` 黑线指示器，如「等你拍板 N」）。
  - 详情顶栏使用面包屑 + 极轻无底事实元信息 + 身份徽标。
- **唯一产品入口（D-178 / D-181）**：独立整页 `/recruitment/app`；旧 DSH 侧栏壳（`RecruitmentShell` / `recruiting-workspace`）已退役，不得重新引入。

---

## 4. 排版密度与组件克制规范

- **字体与数字**：无衬线栈 `'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', sans-serif`（**原型不使用衬线体**，编辑感来自字重与留白）；一切计数/时间/版本号必须加 `.num`（`tabular-nums`）。
- **字号与留白基准**：
  - 基础正文 `14px / 1.55`；候选人姓名大标题 `24px / 700 / letter-spacing: -.03em`；区块标题 `15px / 650`；简历/提炼正文 `13.5px / 1.78`。
  - 画布内边距 `34px 48px 72px`，区块间距 `32px–36px`。
- **Signature Gliding Hover 列表（`.clean-row`）**：默认平铺无框，仅保留 `1px solid var(--line-soft)` 底线；hover 时外扩 `padding-inline: 12px; margin-inline: -8px` 并透出 `--paper` 底色。
- **状态与标签降噪规则**：
  - 列表右侧状态（`.cr-status`）：**纯色无底文字**，禁止套灰底或彩底胶囊。
  - 顶栏事实标签（`.ros-fact-chip`，来源/触发/连接）：**无底轻文字**，禁止与身份徽标挤成一排胶囊。
  - 仅**候选人头部置顶约束/交接标签（`.ros-pin-tag`）**与**轻量筛选/快捷词 pill** 使用圆角胶囊。

---

## 5. 交互、数据诚实与工程红线

1. **对话 × 画布单轨同源（见 `chat-canvas-interaction-spec.md`）**：
   - 所有对话与快捷词统一走 `POST /recruitment/agent/turn` → SSE `event: ui_action`（`navigate` / `focus_section` / `suggest_action`）。
   - **禁止前端硬编码拦截快捷词切页或自动弹出写操作弹窗**；写操作由气泡建议按钮交给人主动点击确认。
2. **写链路唯一合同（`client-contract-check`）**：
   - 所有标准写操作必须复用 `src/client/recruiting/actions.ts` 的 `build*` + `postActionSeam` / `postDecisionRecordFacade` / `postJobCreate` 等，禁止在画布组件中手拼写请求。
3. **事实诚实与文案洁癖（`term-lint`）**：
   - 界面不暴露机器码、UUID、内部路由或中英斜杠原值（如 `初筛 / Screening` 必须清洗为 `初筛`）。
   - 严禁出现 `term-lint` 禁忌词与“材料不全/缺件免责”类工程话术。
   - 服务端未提供的字段（如 HC 配额、推荐来源、静默代办流）绝不编造假数据；正式会话身份只读绑定，不提供前端角色切换下拉。

---

## 6. 反模式黑名单（评审一票否决）

- ❌ 在白底画布里恢复 4 格 KPI 数据卡片条（必须用 `.editorial-stats` 行内统计）
- ❌ 给队列/人才库状态或顶栏元信息加厚重灰底/彩底圆角胶囊
- ❌ 破坏 56px 顶栏地平线或叠加双层顶栏
- ❌ 在白底画布内给每个模块加白底阴影边框卡片
- ❌ 硬编码对话快捷词切页、自动弹写弹窗或手拼 `fetch(POST)`
- ❌ 未经对比 `recruitment_os.html` 自由发挥新色值或后台表格风

---

## 7. 变更验收标准（防审美漂移）

任何涉及 `src/app/**` 或 `src/client/canvas/**` 的改动，合并前必须满足：
1. 对照 `design/v4/recruitment_os.html` 与本文件逐项自检；
2. 静态与构建门禁全绿：`npx tsc --noEmit`（0）、`npx tsdown`（双入口）、`client-contract-check`、`term-lint`；
3. 本地总控提供 `1440×900` 并排对比截图（左实际产品、右定稿原型）及 `run-v4.mjs --fresh` 15/15 无回归记录。
