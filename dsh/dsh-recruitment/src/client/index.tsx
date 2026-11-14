// 浏览器半部分入口：把「待人工决定」工作台注册成 DSH 的侧栏图标 + main 面板。
//
// 这是本产品 UI 的第一行客户端代码，形状照抄已验证的原型
// `dsh-superagent-prototype/src/client/index.tsx`（同为 DSH 0.2.x 的 slots 契约）：
//   - `ctx.slots.inject('main', …)`   把面板挂进中央 main 槽（keyed，key 即面板 id）
//   - `ctx.slots.inject('sidebar.panellist', …)` 把图标挂进侧栏面板列表（list，id 与 key 相同）
// 侧栏点击 → `layout.selectPanel(id)` → 中央按同名 key 渲染本面板。
//
// 本文件只做注册；渲染在 `Workbench.tsx`，取数在 `use-overview.ts`——
// 之后替换视觉版只动 Workbench，注册链路不动。
//
// 客户端不许直连数据库：面板唯一的数据来源是宿主只读路由
// `GET /recruitment/api/overview`（`src/http/overview.ts`）。

import type { ComponentType } from 'react'
import { RecruitmentShell } from './shell/RecruitmentShell.tsx'

/** 需要 cordis 客户端服务：槽位注册表（由 browser renderer 提供）。 */
export const inject = ['slots']

/** 面板 id：侧栏列表 id 与 main 面板 key 必须是同一个值，否则点图标打不开面板。 */
const PANEL_ID = 'recruitment-workbench'

/**
 * 槽位服务的窄接口（只声明本文件用到的两个方法）。
 *
 * 为什么不 import `@deepseek-ai/dsh-client-ui-slots` 的类型：那份类型由 DSH 安装提供，
 * 而插件包本身不依赖 DSH 的 npm 包（宿主代码直接跑 src，客户端产物只 require
 * 浏览器模块表里的 react）。类型面收窄到这里，插件就不会因为 DSH 版本的类型变动而
 * 连构建都过不去；真接口不匹配会在浏览器运行时立刻报错，不会静默失效。
 */
interface SlotRegistrationOptions {
  readonly name: string
  readonly [option: string]: unknown
}

interface SlotsService {
  /** 等到名为 `slot` 的槽位被宿主声明后再执行注册；返回 disposer。 */
  inject(slot: string, register: () => () => void): void
  /** 往已声明的槽位登记一个组件；返回 disposer。 */
  register(options: SlotRegistrationOptions, component: ComponentType<never>): () => void
}

/** 客户端 cordis 上下文（本插件只用到 slots）。 */
interface ClientContext {
  readonly slots: SlotsService
}

/** 侧栏图标的 owner props（`sidebar.panellist` 提供 size / active）。 */
interface PanelIconProps {
  readonly size: number
  readonly active?: boolean
}

/**
 * 侧栏图标：一个带指针的圆（"待处理"语义），线色用 `currentColor`，
 * 因此跟随宿主的明暗主题，不自己造一套颜色。
 * @param props - 宿主给的尺寸。
 * @returns 图标 SVG。
 */
function PanelIcon({ size }: PanelIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8.5v4l2.5 1.5" />
    </svg>
  )
}

/**
 * 注册面板与侧栏图标。
 * @param ctx - 客户端上下文。
 */
export function apply(ctx: ClientContext): void {
  // 中央面板：keyed 槽位，key 就是面板 id。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, inject: () => ({}) },
      RecruitmentShell as ComponentType<never>,
    ),
  )
  // 侧栏条目：list 槽位，id 与 main 的 key 相同；label 决定侧栏文案。
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: '招聘工作台' },
      PanelIcon as unknown as ComponentType<never>,
    ),
  )
}
