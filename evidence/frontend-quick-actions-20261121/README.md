# 快捷图标“点了不切画布”取证（2026-11-21）

产品负责人指出：定稿原型里，左侧对话框的快捷 pill 点击后右侧画布会切换；当前 v4 点击只发消息、画布不动。

## 取证结果（真机，预览 Host 49351，1440）

- 页面：`#/application/11111111-1111-4111-8111-000000000701`（候选人画布）
- 点击 pill：「对比岗位评分标准」
- 结果：
  - `location.hash` **仍为** `#/application/…0701`（未切到岗位画布）
  - 右栏仍是候选人画布
  - 对话流出现用户消息「对比岗位评分标准」+「正在思考并读取最新数据…」
- 结论：**当前实现 = 把 pill 当聊天问题发送（`ChatPanel.tsx:272 onClick → sendText`），没有本地画布动作**。
- 原型对照：`design/v4/recruitment_os.html:854-855` pill → `handleCommand`；`executeParsedCommand` 的“对比”分支（`:1788-1790`）直接 `space='jobs'; jobTab='compare'`，右栏立刻切换。

## 文件

- `probe-result.json`：机器可读结果（hash before/after、chat 文本、点击的 pill）。
- `before-click-1440.png`：点击前候选人画布截图。
- 复跑：`node work/d5/fullpage/probe-quick-actions-49351.mjs`（work/ 不入库；需预览 Host 49351 在跑）。

## 修复

见 `design/v4/frontend-task-11-chat-quick-actions.md`（前端任务；先本地动作、再照常问 Agent）。
