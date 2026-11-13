# 验收证据索引（Lane C · DSH Agent 产品接口 + Job 工具 + Web 交付）

本目录放**可复跑**的验收产物。两份证据各自回答一个问题，不能互相替代：

| 目录 | 回答什么 | 入口 |
|---|---|---|
| `20261113-171419/` | **只给一句自然语言目标**，Agent 能否自己走完 S6→S7，且**不读源码** | `manual/natural-language-acceptance.py` |
| `web-gate-20261113-173745/` | 同样的结果在**真实 DSH Web profile** 里能否看见、刷新后是否还在 | `manual/web-gate-*.mjs` |

## 1) 自然语言验收（headless）

```powershell
cd D:\12412\dsh工作区\projects\recruitment-agent\dsh\dsh-recruitment
$env:RECRUITMENT_DB_PASSWORD='123456'
D:\Python3.12.9\python.exe manual\natural-language-acceptance.py `
  --pdf C:\Users\12412\AppData\Local\Temp\recruitment-r7-synthetic\synthetic-resume-text-2.pdf
```

- `--session <id|jsonl.zstd>` 只分析已有会话，不重跑。
- 判定 24 项，硬指标：`read src/tools/*.ts` 次数 = 0、`read evidence/*.md` 次数 = 0、
  `grep/glob` 进入插件 `src/` 次数 = 0；另外检查 skill 被加载、五个业务工具都被调用、
  最终报告三态齐全且不泄漏内部实现词。
- 2026-11-13 17:14 那次：24/24 PASS，源码读取 **0** 次，耗时 34s。

## 2) Web Gate（真实 `dsh --profile recruitment`）

见 `web-gate-20261113-173745/README.md`。要点：HTTP 200 + 浏览器渲染出会话正文与截图 +
刷新后同一结果；会话是**从 Web 输入框**发起的，`session-web.txt` 第 1 条是 `skill` 调用。

## 3) 岗位工具直连（可选，快速）

```powershell
node manual\job-get-live.mjs 11111111-1111-4111-8111-000000000401
```

会打印 `recruitment_job_get` 的 `tool/result` 原文（真实 PG）与 6 个负例的错误原文。
