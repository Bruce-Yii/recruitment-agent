# Web Gate 证据（S6→S7 在真实 `dsh --profile recruitment` 页面里可见，刷新后仍在）

| 项 | 值 |
|---|---|
| 时间 | 2026-11-13 17:35–17:38 (+08) |
| 入口 | `dsh --profile recruitment --no-open --port 49324`（真实 Web profile） |
| 浏览器 | 本机 Edge 157 headless + CDP（`manual/web-gate-*.mjs`），不是 curl 冒充页面 |
| 会话 | `session-880b848d-6596-4438-aab1-bd610acb8900`（cwd = `...\projects\recruitment-os`） |
| 输入 | **Web 输入框里手打的一句自然语言目标**（`goal-web2.txt`，见会话 `user/message`） |
| 结果 | 新建申请 `e1a393a5-…`、结构化已保存、初筛 PASS、3 条待人工（各带证据/责任人/下一步） |

## 证据文件

- `http.txt` —— `GET /?token=…` 真实 HTTP 状态（token 已脱敏）
- `web-body-before-refresh.txt` / `web-page-before-refresh.png` —— 跑完后的页面正文与截图
- `web-body-after-refresh.txt` / `web-page-after-refresh.png` —— **刷新后**的页面正文与截图（与刷新前逐字相同长度/标记）
- `session-web.txt` —— 会话日志里抽出的 `tool/call`、`tool/result` 与最终回答原文；
  第 1 条工具调用是 `skill {"name":"recruitment-s6-s7"}`，证明 Web 侧也加载了 skill（不是裸模型）
- `db-readback.txt` —— PG 读回：申请在 S6、`resume_version.parsed_fields->'structured'` 非空

## 复现（两步）

```powershell
# 1) 起真实 Web profile（密码只从环境变量来）
cd D:\12412\dsh工作区\projects\recruitment-agent
$env:RECRUITMENT_DB_PASSWORD='123456'
dsh --profile recruitment --no-open --port 49324

# 2) 另开一个终端：用 CDP 在页面里输入目标、等待跑完、刷新再抓
cd dsh\dsh-recruitment
node manual\web-gate-capture.mjs <输出目录> 9558
```

## 边界（必须写清楚，否则等于把文本冒充成工作台）

- **这是真页面**：HTTP 200 的 shell + 浏览器渲染的会话正文 + 截图；不是把 headless stdout 当交付。
- **不是前端新功能**：没有写任何 UI 代码；用的是 DSH Web 现有的会话视图与工具卡片。
- **工作区限制**：Web 会话必须落在**已注册工作区**里（本次用 `recruitment-os`）。
  `recruitment-agent` 没有注册进 GUI 的工作区表，无法在侧栏里点开——这是宿主现状，不是本 lane 改的。
- **skill 生效位置**：`@deepseek-ai/dsh-web-app` 把宿主层 `skill-filesystem` / `tool-skill` 关了
  （"presets own local discovery"）。本 lane 在 **profile 用户层**把 `skill-filesystem` 重新打开并加
  `customSkillDirs`（见 `profiles/recruitment/cordis.patch.yml`），package 层只管 headless。
  不改 DSH 源码、不改 preset。
