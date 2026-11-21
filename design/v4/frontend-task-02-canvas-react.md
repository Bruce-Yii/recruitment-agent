# 前端任务书 02 · 把 v4 右画布实现成 DSH 插件视图（React + TS）

> 收件人：前端实现窗口（**云端**：只能读本仓库，不能在本机执行命令）。
> 发件人：总控。日期：2026-11-19。
> 前置：任务 01 已通过（`design/v4/task-01/`，改前改后截图 SHA256 相同）。
> **仓库里已备好你需要的一切**：真实接口样例、设计变量、挂载契约——见 `design/v4/contracts/`。

---

## 0. 红线

1. **视觉严格按 `design/v4/contracts/design-tokens.md`**（变量名与色值逐字用，不许近似）。
2. **不新增按钮/开关**；不显示内部 UUID / 字段名 / 哈希 / 协议词。
3. 数据只用 `design/v4/contracts/api-samples/` 里**真实存在**的接口；形状对不上就**写进报告**，不要猜。
4. 不做聊天/流式（后续由底座接管）；不碰 `src/client/index.tsx` 的注册链路（除非报告里申请）。

---

## 1. 这一轮做什么

在插件里实现 **v4 的右画布**（候选人页 + 岗位页），挂进现有面板。

1. 新建 `dsh/dsh-recruitment/src/client/canvas/`：
   - `CanvasRoute.tsx` —— 入口：按 `route` 渲染候选人页 / 岗位页 / 空态；
   - `CandidatePage.tsx` —— 档案头、逐条对照（绿/黄/红）、简历分段与原位高亮、初筛依据、时间线、面试轮次；
   - `JobPage.tsx` —— 岗位信息、标准版本、维度列表、候选人漏斗；
   - `bits/` —— 小件：阶段进度条、标签、空态、加载态、错误态（都要有，**空着不是设计**）；
   - `canvas.css` —— 只放本模块用到的样式，变量沿用 `design-tokens.md`。
2. 数据：读 `contracts/api-samples/application-detail.json`、`job-detail.json` 的**真实字段**，经由宿主只读路由取数（`contracts/client-plugin-contract.md` §2）。
3. 接进现有面板：工作台列表点一条 → 画布打开；画布顶部有返回。**不新增侧栏项**。
4. 空态与错误态必须写人话：
   - 没有简历 → "还没有简历原件"；
   - 没有转写 → "还没有转写"；
   - 接口失败 → 一句人话 + 可否重试，**不许把错误码抛给用户**。

---

## 2. 不要做的

| 不做 | 原因 |
|---|---|
| 聊天、流式、审批弹窗 | 底座现成，后续接 |
| 新增侧栏项/顶部按钮 | 低频动作走对话 |
| 改工作台列表的现有视觉 | 任务 01 已验收 |
| 猜字段 / 造接口 | 形状以 `api-samples` 为准 |

---

## 3. 交付（zip，保持仓库相对路径）

```
dsh/dsh-recruitment/src/client/canvas/*.tsx
dsh/dsh-recruitment/src/client/canvas/bits/*.tsx
dsh/dsh-recruitment/src/client/canvas/canvas.css
dsh/dsh-recruitment/src/client/normalize-canvas.ts   # 纯函数：接口 JSON → 视图模型（可单测）
CANVAS-NOTES.md
```

`CANVAS-NOTES.md` 必须写：
1. 每个 v4 元素 → 对应组件/字段的映射表；
2. 哪些字段 `api-samples` 里**没有**、你怎么处理的（占位/隐藏/写"待补"）；
3. 你**没法本地自测**的部分，如实写"未自测"，不要编造结果；
4. `normalize-canvas.ts` 的输入输出示例（贴一段样例 JSON → 视图模型）。

---

## 4. 我这边的验收（不用你做）

1. `npx tsc --noEmit`（客户端配置）+ `npx tsdown` 构建必须过；
2. `normalize-canvas.ts` 的纯函数单测（用 `api-samples` 真实 JSON 当输入）；
3. 真 Host + 真库起会话，浏览器截图 1440/390，对照 `design-tokens.md` 逐项核（颜色、204/56、动效存在）；
4. 负例：接口 500 / 空数据 / 无转写 → 人话空态，不崩、不漏 id；
5. 任何一项不过即退回，**不接受"看起来差不多"**。
