# Wave 2.5 UI 挂载验收（PR #41 + 修复 PR #42，2026-11-23）

## 结论

**通过**。PR #41 的两块 UI 在 1440 真机可见、数据来自真实只读接口、无分数/排名；但验收中发现并修复了 3 个会直接影响用户可见性的问题（见 §4）。

- PR #41：https://github.com/Bruce-Yii/recruitment-agent/pull/41（head `b4d48d7`）
- 依赖修复 PR #42：https://github.com/Bruce-Yii/recruitment-agent/pull/42（head `e0fa7a8`）
- 联调基线：`origin/main cf83b63` + #42 + #41
- 未合并 main。

## 1. 门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.44MB）
- `server-typecheck`：0/0
- `runtime-budget`：5051/5051
- `entry-reachability`：PASS，**WHITELIST=[]**
- `client-contract-check`：PASS
- `term-lint`：PASS
- 全量 unit：**2118 tests / 2114 pass / 0 fail / 4 既有 skip**
- 15 步：**15/15 PASS**，audit **hard 0**（soft 3 均为既有 keyText 软告警）

## 2. 场景 ①：岗位页历史人才再发现

- 一次性干净库，新建一个无投递的 OPEN 岗位（默认 Rubric：工作经历 + 核心胜任力）；
- 岗位页底部出现 `canvas-job-rediscovery`，展示 3 位跨岗位历史候选人；
- 每条只展示历史事实（历史岗位 / 曾进二面 / 当前岗位要求），标题明确「仅按历史事实召回（不评分、不排名）」；
- 无百分比、无匹配度、无排序分数；接口 200。
- 截图：`01-job-rediscovery-1440.png`

## 3. 场景 ②：候选人页重复投递提示

- 数据库有「已合并历史候选人 + 同手机号 + 同邮箱 + 历史申请」；
- 候选人页出现 `canvas-candidate-duplicates`：
  `疑似同人历史投递（2 条）…（同手机号、同邮箱 +86 138****0000）查看…`
- 手机/邮箱均为掩码，不出现原文；原因使用中文（不再泄露 `SAME_*` 机器码）；
- 点击「查看」成功切到重复投递对应的申请页（hash 变化）。
- 截图：`02-candidate-duplicates-1440.png`

> 说明：库表对 `ACTIVE` 候选人的手机/邮箱有部分唯一索引，两个「活跃」候选人不可能同手机/同邮箱。本场景使用 **MERGED 历史候选人** 构造同联系方式，这是 G-10 最真实的历史重复场景；如果产品要覆盖“两个活跃候选人同手机号”，需要先立数据模型裁决。

## 4. 验收中发现并修复的问题

1. **路由 prefix 尾斜杠**（PR #42，`e0fa7a8`）
   - 宿主匹配 `pathname.startsWith(prefix + '/')`；注册 `/jobs/`、`/applications/` 永不命中，请求回落到 recruiting 主前缀并 400 `ID_MISSING`。
   - 修复：注册 prefix 去尾斜杠，解析常量保留尾斜杠。
2. **Canvas fetcher 缺 `X-DSH-Session`**（PR #41，`58f81d1`）
   - 两个新 GET 接口要求 session；CanvasRoute 默认 fetcher 未带该头，UI 静默空态。
   - 修复：App 向 CanvasRoute 注入 `fetchAppJson(path, session.sid)`。
3. **重复原因机器码直出**（PR #41，`b4d48d7`）
   - 前端只映射了不存在的 `SAME_NAME_AND_HISTORY`，真实 `SAME_HISTORY_ARCHIVE` 等被原样展示。
   - 修复：映射 `SAME_PHONE / SAME_EMAIL / SAME_NAME_SAME_CHANNEL / SAME_HISTORY_ARCHIVE`。

## 5. 证据文件

- `e2e-result.json`：两场景的 API 状态、页面文本、点击跳转
- `regression-15step-result.json` + `regression-15step-audit.json`
- `build-static-gates.txt`
- `01-job-rediscovery-1440.png`、`02-candidate-duplicates-1440.png`

## 6. 合入建议

**#42 → PR #41**。两处修复都是 UI 可见性的前置条件；只合 #41 会把“区块永远空态”带上 main。
