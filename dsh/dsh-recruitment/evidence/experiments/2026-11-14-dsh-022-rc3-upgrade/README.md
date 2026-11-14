# 底座升级：DSH `0.2.2-rc.1` → `0.2.2-rc.3`（2026-11-14）

**触发**：用户说"dsh 发新版了"。
**结论**：产品底座已升到 **`0.2.2-rc.3`**（与桌面端同版），招聘插件 18 个工具在真浏览器里**照常可用**，无需改一行代码。

---

## 1. 版本事实（现场查的，不是听说）

| 来源 | 版本 |
|---|---|
| npm `dist-tags.latest` | `0.2.2-rc.1` |
| npm `dist-tags.next` | **`0.2.2-rc.3`** |
| npm 版本列表末 3 个 | `0.2.2-rc.1` / `0.2.2-rc.2` / `0.2.2-rc.3` |
| **桌面端**（已自动更新） | **`0.2.2-rc.3`**（`DeepSeek Harness.exe` 写入时间 2026-11-13 15:30） |
| 我们的产品底座（升级前） | `0.2.2-rc.1` |

注意 `latest` 还停在 rc.1、新版只在 `next` 上——**桌面端已经吃到 rc.3 了**，所以"跟桌面同版"就得跟到 rc.3。

## 2. 升级动作

```powershell
cd D:\12412\recruitment-runtime
npm install @deepseek-ai/dsh@0.2.2-rc.3 --registry https://registry.npmmirror.com
# added 29 / removed 11 / changed 368 packages in 2m
D:\12412\recruitment-runtime\node_modules\.bin\dsh.cmd --version
# 0.2.2-rc.3
```

**全局 CLI 与桌面端都没动**（还是各自原样）。

## 3. 升级指南：读了，且逐条对过我们的面

rc.3 的 npm 包**现在自带 `docs/` 和 `src/`**（rc.2 的发布说明："npm 安装与桌面端随附对应版本的源码和文档"），
所以安装包内的升级指南可以直接读（**外部 npm 包内路径，按设计不入库**）。

索引里的版本段：

```
## v0.2.2-rc.1     ← rc.1 → rc.2 的破坏性变更，19 条
## v0.2.2-alpha.3
...
（没有 v0.2.2-rc.2 段 ⇒ rc.2 → rc.3 无破坏性变更）
```

**19 条逐条对我们的使用面**（我们只用：`ctx.tools.register` + 原始 `ToolDefinition`、`ctx.approval`、
`cordis.patch.yml` 的 insert/skill 配置，**没有 client 半部分**）：

| 指南条目 | 影响我们？ |
|---|---|
| account-notification-fields / account-remote-provider | ❌ 不用账号通知 |
| archive-worktrees / forge-* | ❌ 不用 Forge / 工作树 |
| attachment-error-codes | ❌ 不用附件错误类型 |
| cua-* / terminal-* | ❌ 不用 CUA / 终端 |
| dsh-doc-skill | ❌ 不是 Creator 模式 |
| plugin-update-method（`BundleInfo.update`） | ❌ 不做插件市场 |
| runtime-context-reminders | ❌ 不写会话事件 |
| session-append-overloads | ❌ 不替换 `Session.append` |
| subagent-interrupt-default | ❌ 不用 subagent 中断 |
| web-search-billing | ❌ 不用搜索计费 |
| window-drag-regions（client 浮层） | ❌ 没有 client 浮层 |

→ **没有一条命中。** 另外 Node 最低版本升到 `>=24.9`，本机 `v24.16.0` 满足。

## 4. 浏览器验证（真跑，不是"应该没事"）

DSH `0.2.2-rc.3` + 隔离 home（`D:\12412\dsh-home-recruitment`）+ 产品 profile：

| 用例 | 结果 |
|---|---|
| `recruitment_job_get` → `792a10f9…` | ✅ `title: 后端工程师 / status: DRAFT`，`VERIFY_EXIT=0` |
| `recruitment_candidate_get` → `…601` | ✅ `display_name: 演示候选人-张样例`，`VERIFY_EXIT=0` |

rc.3 的会话里还能看到新增的上下文注入（`runtime-context` / `skill-catalog` / `time-context`），
这是 rc.2 的"运行时上下文提醒"特性，**不影响工具调用**。

## 5. 以后的升级流程（写下来，别再靠记忆）

```powershell
# 1) 看新版：npm dist-tags（注意 latest 可能落后，next 才是新的）
npm view @deepseek-ai/dsh dist-tags --json
# 2) 看桌面端版本，决定是否对齐
(Get-Item 'D:\12412\DeepSeek Harness\DeepSeek Harness.exe').VersionInfo.FileVersion
# 3) 读升级指南：索引 → 只看命中我们使用面的 guide
#    <runtime>\node_modules\@deepseek-ai\dsh\docs\upgrade-guide\README.md
# 4) 装到项目目录（不碰全局）
npm install @deepseek-ai/dsh@<version> --prefix D:\12412\recruitment-runtime
# 5) 浏览器验证两条：job_get + candidate_get（脚本见 2026-11-14-dsh-022-base/）
# 6) 记录到本目录 + docs/17 台账
```

**纪律**：升级只升项目目录里的副本；`DSH_HOME` 仍用产品自己的；验证不过就回滚到上一个版本号。
