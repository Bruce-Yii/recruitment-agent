# 客户端挂载契约（DSH 插件视图）

> 参考实现（照抄即可）：`dsh/dsh-recruitment/src/client/index.tsx`（99 行，含注释说明）。
> 构建：`cd dsh/dsh-recruitment && npx tsdown` → 产物 `lib/client.js`（`package.json` 的 `exports["./client"]` 指向它）。
> **改完必须重新构建并提交 `lib/client.js`**（仓库把产物一起入库，见历史提交）。

## 1. 一个面板怎么挂进 DSH

两层注册，缺一层用户就看不到：

```ts
export const inject = ['slots']          // 声明需要宿主的槽位服务

const PANEL_ID = 'recruitment-workbench' // 侧栏 id 与中央面板 key 必须相同

export function apply(ctx) {
  // 中央主区：keyed 槽位
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({}) },
      MyPanel as ComponentType<never>,
    ),
  )
  // 侧栏图标：list 槽位，id 与 key 相同，label 是侧栏文案
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: '招聘工作台' },
      MyIcon as ComponentType<never>,
    ),
  )
}
```

要点：
- **不 import DSH 的类型包**：把用到的槽位接口在本文件里收窄声明（参考实现这么做的原因见其注释），避免跟着 DSH 版本改类型；
- 侧栏图标用 `currentColor`，跟随宿主明暗主题，**不许自造配色**；
- 客户端**不许直连数据库**：唯一数据来源是宿主只读 HTTP 路由。

## 2. 数据从哪来

| 数据 | 来源 |
|---|---|
| 工作台计数/待办 | `GET /recruitment/api/overview`（样例 `contracts/api-samples/overview.json`） |
| 画布 | `GET /recruitment/api/recruiting/applications/:id`（样例 `application-detail.json`） |
| 岗位页 | `GET /recruitment/api/recruiting/jobs/:id`（样例 `job-detail.json`） |
| 设置 | `GET /recruitment/api/settings`（样例 `settings.json`） |
| 写操作 | 一律走 `POST /recruitment/api/action/**`，**必须由人点**（确认卡），客户端不做静默写 |

请求要求：同源 + 带 `x-recruitment-request: 1`；身份由宿主 cookie 决定，**前端不传 actor**。

## 3. 边界（违反即退回）

1. 不改 `src/client/index.tsx` 的注册链路（除非加新面板，且需总控批准）；
2. 不新增按钮/开关；低频动作走对话；
3. 不显示内部 id / 字段名 / 哈希 / 协议词；
4. 视觉严格按 `design-tokens.md`；
5. 交付前必须能通过 `npx tsdown` 构建（产物 `lib/client.js` 一起交）。
