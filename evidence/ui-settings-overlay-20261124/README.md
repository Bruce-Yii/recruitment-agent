# UI 构建与设置页叠影验证（2026-11-24）

分支：`fix/ui-settings-overlay-build-20261124`（基线 `origin/main@317e094`，含 PR #97 的 SettingsView 位置修复）。
目的：重建 main 上已陈旧的前端构建产物（`lib/app.js` / `lib/client.js`），并在 1440 真机确认 `#/settings` 与队列不再叠影。

## 构建

```
cd dsh/dsh-recruitment
npx tsc --noEmit      # exit 0，0 错误
npx tsdown            # lib/client.js 0.59 kB (CJS) + lib/app.js 1.54 MB (ESM)
```

> `lib/app.css` **不是构建产物**：`tsdown.config.ts` 的 `cssInjectionPlugin` 在构建时把每个 CSS 文件变成注入模块（运行时写入 `<head>`，按文件独立标记），因此不生成 app.css。

## 1440 真机验证

- 隔离 Host：端口 49348，profile `rec-ui-build-20261124`（复制自 `rec-preview-pr`，插件 link 指向本分支 worktree，DB = 一次性库 `ra_ui_build_20261124`，25 迁移 + `db/verify.sql` VERIFY PASS）。
- 无头 Chrome：CDP 9228，窗口 1440x900；通过 `/recruitment/test?as=recruiter&next=/recruitment/app#/settings` 进入（preview 身份）。
- 探针：`probe-settings-overlay.mjs`（只读 DOM/截图，不 import 产品代码）。

### 断言（全部 PASS）

| 断言 | 结果 |
|---|---|
| viewport = 1440x900 | ✅ |
| `[data-testid="settings-page"]` 渲染 | ✅ |
| settings 路由下 `app-queue-view` / `app-queue-tabs` **不存在**（不再与队列同屏） | ✅ |
| settings 容器完整落在 `app-canvas` 内 | ✅ |
| settings 顶边在 `.canvas-head` 之下（不在 header/crumb-bar 里） | ✅ |
| header 不包含 settings 内容（crumb 仅「设置」） | ✅ |
| `#/queue` 只渲染队列、不含 settings | ✅ |

### DOM 关键值

- `settings-page` rect：`{x:662.8, y:90, w:642.4, h:413}`；`app-canvas` rect：`{x:528, y:0, w:912, h:900}`；`.canvas-head`：`{h:56}`。
- `settings-page` 的 `topElementAtSettingsCenter` = `settings-row-email`；`headerContainsSettings=false`。
- 队列路由：`app-queue-view=true`、`settings-page=false`。

### 截图（sha256）

- `settings-1440.png`（113,065 B）：`E489C1DD477F9323320A46A428CBDC9F3C0059E5905733CC38A9FFDBC1597BB5`
- `queue-1440.png`（88,771 B）：`3E2F9F98CCB8B0ACE83094EB36DFC3BC1247D6CB03330078CB407468F840B343`

## 复跑

1. 建干净库（0001→0025 + `db/verify.sql`），把 profile 的 database 指向它；
2. `start-host.ps1 -Profile <profile> -Port 49348 -DbPassword <pwd>` + `start-chrome.ps1 -CdpPort 9228 -Width 1440 -Height 900`；
3. `node probe-settings-overlay.mjs`（token 从 `%TEMP%\ra-pr-host-49348.token` 读取）。

证据文件：`probe-result.json`、`probe-run.log`、`host-stdout.log`、`host-stderr.log`、`db-verify.txt`、`bundle-info.txt`。
