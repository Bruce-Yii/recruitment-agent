# Wave 3 批次联调（G-09 / G-14 / G-15）

基线：`origin/main c7cf0c9` + PR #49 + PR #50 + PR #51 + PR #48。未合并 main。

## PR

| PR | Head | 内容 |
|---|---|---|
| **#49** https://github.com/Bruce-Yii/recruitment-agent/pull/49 | `6aa7ee8` | G-14 原件逐页 PNG |
| **#50** https://github.com/Bruce-Yii/recruitment-agent/pull/50 | `3f13745` | G-15 追责时间线 |
| **#51** https://github.com/Bruce-Yii/recruitment-agent/pull/51 | `202300f` | G-09 候选人自助预约 |
| **#48** https://github.com/Bruce-Yii/recruitment-agent/pull/48 | `3052a01` | Wave3 前端挂载（含 3 个修复） |

## 1. 底线门禁（全 PASS）

- `npx tsc --noEmit`：0
- `npx tsdown`：双入口（lib/app.js 1.45MB）
- `server-typecheck`：PASS（0 / 上限 0）
- `runtime-budget`：PASS（5051/5051）
- `entry-reachability`：PASS，**WHITELIST=[]**（trace 归入 READ_ONLY_ROUTES；booking 公开路由 runtime 拼接，扫描器不提取）
- `client-contract-check`：PASS
- `term-lint`：PASS
- 全量 unit：**2148 tests / 2144 pass / 0 fail / 4 既有 skip**
- 迁移：干净库 **24 个迁移** + `db/verify.sql` exit 0，`VERIFY PASS`、`BOOKING-STRUCT PASS`
- 15 步：**15/15 PASS**，audit **hard 0**（soft 3 均为既有 keyText 软告警）

## 2. 1440 产品级正反例

### G-14 真 PDF 渲染
岗位漏斗上传真实 PDF → 候选人页「原件预览」→ `canvas-original-page-img` 加载成功（`naturalWidth > 0`），页码显示 `第 1 / 2 页`；`下载 / 查看原件` 保留。
- 截图：`01-original-page-1440.png`

### G-15 追责时间线
执行一次真人「纠偏」后展开 `canvas-decision-trace`：
- 时间线含真实动作「记录人工纠偏」与操作人「招聘负责人」；
- `零 UUID / 零完整 sha256 / 零「证据」`（机检通过）；
- 另含「收到简历」「任务状态更新」「提交申请」等真实流转。
- 截图：`02-decision-trace-1440.png`

### G-09 自助预约正例
- HR 排期弹窗切「发候选人自助选时段」，填写 3 个时段，生成 `booking_url`；
- 清空宿主 session cookie 后打开 `/recruitment/book/<token>`：暖纸单列，仅见岗位/轮次/时长/时段/状态；
- 页面正文机检：**零简历、零评估、零 UUID**，3 个可选时段；
- 候选人点第 2 个时段：页面显示「已确认」；
- 独立 psql：`interview` **2 → 3**；`booking_invite` 行 `CONSUMED|1|true`。
- 截图：`03-self-book-link-1440.png`、`04-public-booking-page-1440.png`、`05-public-booking-confirmed-1440.png`

### G-09 负例
- 篡改非白名单时段（slot_index=99）→ **400**，interview 行数不变（2）；
  - 说明：API 只接受 `slot_index`（服务端白名单校验），不存在客户端传时间；无效索引即非白名单请求，返回 `SLOT_INDEX_INVALID` 400 且零写入。
- 同一令牌重提 → **409 BOOKING_ALREADY_CONFIRMED**，interview 行数保持 3；
- 伪造/过期路径由服务端测试覆盖 404/410 零写入。

## 3. 联调中发现并修复

1. **PR48 语法错误**：`scheduleIntent` 的 useState 调用被中间插入的 invite 状态声明截断，`tsc` 直接失败；`slotStart` 未定义。已修（`da0c330`）。
2. **PR48 时段结束时间错误**：用 `toISOString().slice(0,16)`（UTC 墙钟）再交给 `toOffsetIso`，10:00 时段被写成 03:00，服务端正确返回 `SLOT_DURATION_MISMATCH`。改为本地墙钟 +60 分钟（`3052a01`）。
3. **PR48 面试官重复**：`defaultActors` 按轮次拼接，同一面试官可重复，服务端 `DUPLICATE_INTERVIEWER` 400；已去重（`1c71712`）。
4. **PR51 CSP 阻断确认**：公开页 CSP `default-src 'none'` 同时阻断 `connect-src`，浏览器内确认按钮的 fetch 被静默拦截（Node 测试看不出来）。加 `connect-src 'self'`（`202300f`）。
5. **PR50 生产 loader 签名错误**：`loadTrace(client, tenant, 'APPLICATION', id)` 实际签名是 `loadTrace(client, TraceInput)`；单测注入了 loader 所以未暴露，`server-typecheck` 抓到。已修（`6eddaae`）。
6. **PR50 事件标题太泛**：所有 EVENT 都显示「收到流程事件」；对已知事件类型映射为「记录人工纠偏 / 完成初筛评估 / 记录初筛结论 / 收到简历 / 任务状态更新」，普通人话可读（`3f13745`）。

## 4. 已知边界（如实）

- **G-14 页数**：当前 `fallback_bridge.py` 的 `_op_page_image` 不返回 `page_count`；PR49 通过同一 bridge 以超大页码探测总页数（每次成功渲染会多一次子进程调用）。若 bridge 后续返回 `render.page_count`，会直接使用，建议后续清理。
- **G-09 负例语义**：产品契约里的「篡改非白名单时段」在 API 上映射为非法 `slot_index`；本次以 99 验证 400 零写入，另由服务端单测覆盖白名单拒绝/过期/伪造。
- 公开预约页在本地 loopback 注册；生产公开域需另有部署裁决（本批不涉及）。

## 5. 证据文件

- `e2e-result.json`（G-14/G-15/G-09 的页面文本、自然宽、psql 行数、负例状态）
- `regression-15step-result.json` + `regression-15step-audit.json`
- `build-static-gates.txt`
- `migration-verify.json`
- 5 张 1440 截图
