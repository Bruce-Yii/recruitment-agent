# 工作台面板 · 验收记录（2026-11-14）

按 E1–E4 验收，不是按"测试绿"验收。本文件记录**三层同时刻对齐**的证据。

## 环境

| 项 | 值 |
|---|---|
| DSH_HOME | `D:\12412\dsh-home-ui-panel`（隔离，未碰 `D:\12412\dsh-home` 与 `profiles/desktop`） |
| 运行时 | `D:\12412\recruitment-runtime` 的 `@deepseek-ai/dsh` 0.2.2-rc.3 |
| profile | `recruitment`（`@recruitment/dsh-recruitment` bundle） |
| 端口 | 127.0.0.1:3080 |
| DB | `ra_s6s7`，tenant `11111111-1111-4111-8111-000000000001` |

## E1 端到端可达：路由注册点 + 一次真实调用

| 环节 | 位置 |
|---|---|
| 路由注册 | `src/http/overview.ts` → `registerOverviewHttp()`，`webServer.register({kind:'prefix', path:'/recruitment/api'})` |
| 插件接线 | `src/index.ts` → `ctx.inject(['webServer'], child => child.effect(() => registerOverviewHttp(...)))` |
| 浏览器入口 | 侧栏「待人工决定」→ main 面板（`src/client/index.tsx` 的 `ctx.slots.inject`） |

**`webServer` 是可选注入**（不是顶层 `inject`）：放进顶层会让 headless/tui 下整个插件不激活、
19 个工具一起消失。守卫测试：`test/unit/vision-fallback.test.ts`「webServer 是可选依赖…」。

## 三层对齐（同一时刻，2026-11-14 16:2x +0800）

### ① 浏览器 DOM（CDP，`temp/accept-panel.png`）

```text
待人工决定
下面这些申请在等一个真人做决定。
申请：11111111-1111-4111-8111-000000000701
阶段：S7
为什么等：S7 初筛：还没有人工作出的筛选决定（decision_scope=SCREENING 未记录）
待人工决定 1 条；在办申请 8 条。
按阶段：S7 1 条
刷新
```

### ② API（`GET /recruitment/api/overview`，带 `x-recruitment-request: 1` + 同源 Origin）

```json
{"configured":true,
 "pending":[{"application_id":"11111111-1111-4111-8111-000000000701","stage_code":"S7",
             "reason":"S7 初筛：还没有人工作出的筛选决定（decision_scope=SCREENING 未记录）"}],
 "counts":{"pending_total":1,
           "pending_by_stage":{"S7":1},
           "active_total":8,
           "active_by_stage":{"S6":6,"S7":1,"S9":1}}}
```

### ③ DB 直查（`psql`，与 `PENDING_SQL` 同语义）

```text
待人工：11111111-1111-4111-8111-000000000701 | S7     （恰好 1 条，id 与页面一致）
在办按阶段：S6|6   S7|1   S9|1                        （合计 8，与 active_total 一致）
decision 现状：STAGE|S10|1
```

**三层数字完全一致**：待人工 1、在办 8、阶段分布 S6=6/S7=1/S9=1。

## 未配置路径（fail-closed，不冒充空台账）

不带 `RECRUITMENT_DB_PASSWORD` 启动时：

```json
{"configured":false,"pending":[],"counts":{...全 0...},
 "issues":["environment variable RECRUITMENT_DB_PASSWORD is not set (the database password is only read from the environment)"]}
```

面板显示「数据库未配置，暂时读不到数据（缺少：…）」，**不是**「没有等你决定的事」。
两者必须可区分：前者是"我不知道"，后者是"确实没有"。

## 验收过程中发现并修掉的两个问题（测试抓不到）

1. **计数命名含糊**：`counts.by_stage` 是"待人工按阶段"，`active_applications` 是"在办总数"，
   没有 pending/active 前缀 → 连验收人本人都误读了一次。改为
   `pending_by_stage` / `active_total` / `active_by_stage`。
2. **算了不输出**：`ACTIVE_BY_STAGE_SQL` 查出了 S6=6/S7=1/S9=1，代码只取总和把明细丢掉。
   现在 `active_by_stage` 如实返回。

## 已知未达标（不算通过）

- **只能看，不能答**：面板能显示"这条申请在等 S7 决定"，但人无法在面板上做这个决定。
  按产品验收这是"可观测"不是"可操作"，要接 D-106 之后的 Attention 闸门才算完。
- 无轮询（只挂载时取一次 + 手动刷新）；闸门集合硬编码 S7/S10；每次请求新建短连接 pg Pool。
- 客户端无类型检查：`pnpm build` 只跑 tsdown 不做 tsc，类型契约只有浏览器运行时证明。
