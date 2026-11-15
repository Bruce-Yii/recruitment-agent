// D5 P0-4 角色 → 视图矩阵（纯函数层）。
//
// 依据：Notion 02 §04「多角色入口与工作视图」（六角色默认首页）、`work/d5/roles/CONTRACT.md` §1/§2。
//
// 冻结口径：
//   * 本文件只回答「这个 Demo Actor alias 在界面上应该看到哪些视图、默认落在哪个视图」；
//   * **视图矩阵是展示口径，不是认证/授权系统**。真实授权在服务端 Host Action
//     （`src/http/actions.ts` 的 `ACTION_ALLOWED_ALIASES = ['recruiter']`）：
//     非授权 alias 的写动作会被服务端以 403 `ACTOR_NOT_AUTHORIZED` 拒绝且零写入；
//   * 非授权 alias **不静默换身份**：界面必须显示精确原因，由人显式切换为 Recruiter 身份；
//   * 未知 alias 一律 fail-closed（返回 `null` / `[]` / 非空阻断原因），不猜、不归一、不回退默认身份。
//
// 本文件是纯函数层：不导入任何框架或组件、不触达浏览器全局与存储、不发任何网络请求，
// 可被 `node --test` 直接 import（`test/unit/role-views.test.ts` 含机器守卫）。

/** 受控 Demo Actor alias 封闭集；顺序 = 顶部选择器的展示顺序。 */
const DEMO_ACTOR_ALIASES = ['recruiter', 'hiring_manager', 'approver', 'interviewer_a', 'interviewer_b'] as const

/**
 * 一个受控 Demo Actor alias。
 *
 * 与 `work/d5/ACTOR-CONTRACT.md` §1 同源：浏览器只提交 alias、永远不提交 actor UUID。
 * 其中 `hiring_manager`（…0102）与 `approver`（…0101）是本 lane 新扩展的两个演示身份。
 */
export type DemoActorAlias = (typeof DEMO_ACTOR_ALIASES)[number]

/** 产品工作视图键：与 shell 的视图 tab、以及各 workspace 组件一一对应。 */
export type WorkViewKey = 'recruiting' | 'interviewer' | 'hiring' | 'approvals'

/** Demo Actor 在种子库里的 DB 角色码（`db/migrations/0002_seed.sql` 的 101–105 演示账号）。 */
export type DemoActorRole = 'HR_SPECIALIST' | 'HIRING_MANAGER' | 'ORG_ADMIN' | 'INTERVIEWER'

/**
 * 一个 alias 的展示档案（冻结接口，见 `work/d5/roles/CONTRACT.md` §2）。
 *
 * 这些字段只服务于「界面怎么展示」，不构成授权依据：
 * `canExecuteWriteActions` 只是把服务端的真实授权结果提前告知界面，服务端仍是唯一裁决者。
 */
export interface AliasProfile {
  /** 受控 alias 自身（与 `DEMO_ACTOR_PROFILES` 的键一致）。 */
  readonly alias: DemoActorAlias
  /** 选择器文案，如 `'招聘负责人（Hiring Manager）'`。 */
  readonly label: string
  /** 种子库里的 DB 角色码。 */
  readonly role: DemoActorRole
  /** 展示用角色文案，如 `'HIRING_MANAGER · 招聘负责人'`。 */
  readonly roleLabel: string
  /** 该 alias 的默认视图（alias 切换后若无更好选择就落在这里）。 */
  readonly defaultView: WorkViewKey
  /** 该 alias 被授权看到的视图集合（顺序即 tab 顺序，只做展示）。 */
  readonly allowedViews: readonly WorkViewKey[]
  /** 是否具备 Host Action 写授权（**仅 `recruiter` 为 `true`**；服务端是唯一裁决者）。 */
  readonly canExecuteWriteActions: boolean
  /** 非空 = 服务端会以 403 拒绝的精确原因；`canExecuteWriteActions` 为 `true` 时为空串。 */
  readonly writeBlockedReason: string
}

/** 招聘负责人 / 审批人的通用阻断原因：Host Action 写授权只给 recruiter（服务端事实）。 */
const HOST_ACTION_RECRUITER_ONLY =
  'Host Action 写授权仅限 recruiter（服务端将以 403 ACTOR_NOT_AUTHORIZED 拒绝，零写入）；如需执行，请显式切换为 Recruiter 身份（不会静默换身份）。'

/** 面试官的阻断原因：本人面评走 W1 scorecard submit，招聘类写动作仍会被 403。 */
const INTERVIEWER_WRITE_BLOCKED_REASON =
  '面试官写动作仅本人 Scorecard（W1 scorecard submit）；招聘类写动作会被服务端以 403 ACTOR_NOT_AUTHORIZED 拒绝、零写入；如需执行招聘写动作，请显式切换为 Recruiter 身份（不会静默换身份）。'

/** 未知 alias 的视图集合（复用同一个冻结空数组，避免每次分配）。 */
const EMPTY_VIEWS: readonly WorkViewKey[] = Object.freeze([])

/** 视图键 → 界面文案（与既有 shell 的 tab 文案一致）。 */
const VIEW_LABELS: Readonly<Record<WorkViewKey, string>> = Object.freeze({
  recruiting: '招聘工作台',
  interviewer: '面试官工作台',
  hiring: '招聘负责人工作台',
  approvals: '审批工作台',
})

/**
 * 5 个 Demo Actor 的展示档案 = `work/d5/roles/CONTRACT.md` §1 矩阵的唯一实现。
 *
 * 冻结：外层、每个档案、以及 `allowedViews` 都 `Object.freeze`，防止界面层误改写矩阵。
 */
export const DEMO_ACTOR_PROFILES: Readonly<Record<DemoActorAlias, AliasProfile>> = Object.freeze({
  recruiter: Object.freeze({
    alias: 'recruiter',
    label: 'Recruiter（HR 专员）',
    role: 'HR_SPECIALIST',
    roleLabel: 'HR_SPECIALIST · HR 专员',
    defaultView: 'recruiting',
    allowedViews: Object.freeze(['recruiting', 'interviewer', 'hiring', 'approvals'] as WorkViewKey[]),
    canExecuteWriteActions: true,
    writeBlockedReason: '',
  }),
  hiring_manager: Object.freeze({
    alias: 'hiring_manager',
    label: '招聘负责人（Hiring Manager）',
    role: 'HIRING_MANAGER',
    roleLabel: 'HIRING_MANAGER · 招聘负责人',
    defaultView: 'hiring',
    allowedViews: Object.freeze(['hiring', 'approvals'] as WorkViewKey[]),
    canExecuteWriteActions: false,
    writeBlockedReason: HOST_ACTION_RECRUITER_ONLY,
  }),
  approver: Object.freeze({
    alias: 'approver',
    label: '审批人（企业管理员）',
    role: 'ORG_ADMIN',
    roleLabel: 'ORG_ADMIN · 企业管理员',
    defaultView: 'approvals',
    allowedViews: Object.freeze(['approvals', 'hiring'] as WorkViewKey[]),
    canExecuteWriteActions: false,
    writeBlockedReason: HOST_ACTION_RECRUITER_ONLY,
  }),
  interviewer_a: Object.freeze({
    alias: 'interviewer_a',
    label: 'Interviewer A',
    role: 'INTERVIEWER',
    roleLabel: 'INTERVIEWER · 面试官',
    defaultView: 'interviewer',
    allowedViews: Object.freeze(['interviewer'] as WorkViewKey[]),
    canExecuteWriteActions: false,
    writeBlockedReason: INTERVIEWER_WRITE_BLOCKED_REASON,
  }),
  interviewer_b: Object.freeze({
    alias: 'interviewer_b',
    label: 'Interviewer B',
    role: 'INTERVIEWER',
    roleLabel: 'INTERVIEWER · 面试官',
    defaultView: 'interviewer',
    allowedViews: Object.freeze(['interviewer'] as WorkViewKey[]),
    canExecuteWriteActions: false,
    writeBlockedReason: INTERVIEWER_WRITE_BLOCKED_REASON,
  }),
})

/**
 * 顶部 Demo Actor 选择器的选项（顺序 = `DEMO_ACTOR_ALIASES` 的顺序）。
 *
 * 与 `DEMO_ACTOR_PROFILES` 同源取 `label`，避免两处文案漂移。
 */
export const DEMO_ACTOR_OPTIONS: readonly { readonly value: DemoActorAlias; readonly label: string }[] = Object.freeze(
  DEMO_ACTOR_ALIASES.map(
    (alias): { readonly value: DemoActorAlias; readonly label: string } =>
      Object.freeze({ value: alias, label: DEMO_ACTOR_PROFILES[alias].label }),
  ),
)

/**
 * 是不是 5 个受控 alias 之一（**区分大小写、不裁剪空白**：alias 是封闭集，不做归一）。
 * @param value - 任意值（来自 HTTP / 存储 / 测试）。
 * @returns 是受控 alias 时为 `true`。
 */
export function isDemoActorAliasValue(value: unknown): value is DemoActorAlias {
  return typeof value === 'string' && Object.hasOwn(DEMO_ACTOR_PROFILES, value)
}

/**
 * 解析一个 alias 的展示档案。
 * @param alias - 任意字符串 / `null` / `undefined`（未知 alias 是正常输入，不抛错）。
 * @returns 档案；未知 / 缺省 → `null`（**不猜、不回退 recruiter**）。
 */
export function profileForAlias(alias: string | null | undefined): AliasProfile | null {
  if (alias === null || alias === undefined) return null
  if (!isDemoActorAliasValue(alias)) return null
  return DEMO_ACTOR_PROFILES[alias]
}

/**
 * 该 alias 被授权看到的视图（顺序即 tab 顺序）。
 * @param alias - 任意 alias。
 * @returns 视图数组；未知 / 缺省 → `[]`（空 = 看不到任何视图，fail-closed）。
 */
export function allowedViewsFor(alias: string | null | undefined): readonly WorkViewKey[] {
  return profileForAlias(alias)?.allowedViews ?? EMPTY_VIEWS
}

/**
 * 该 alias 的默认视图。
 * @param alias - 任意 alias。
 * @returns 默认视图；未知 / 缺省 → `null`。
 */
export function defaultViewFor(alias: string | null | undefined): WorkViewKey | null {
  return profileForAlias(alias)?.defaultView ?? null
}

/**
 * 该 alias 能否看到某个视图（与 `allowedViewsFor` 的判定完全一致，不另起一套规则）。
 * @param alias - 任意 alias。
 * @param view - 视图键。
 * @returns 允许看到时为 `true`；未知 alias 一律 `false`。
 */
export function canSeeView(alias: string | null | undefined, view: WorkViewKey): boolean {
  return allowedViewsFor(alias).includes(view)
}

/**
 * 视图的界面文案。
 * @param view - 视图键。
 * @returns 文案；未知视图键（运行期越界）→ `''`（不编造文案）。
 */
export function viewLabel(view: WorkViewKey): string {
  return (VIEW_LABELS as Readonly<Record<string, string>>)[view] ?? ''
}

/**
 * alias 切换后该落到哪个视图。
 *
 * 规则（冻结）：
 *   * 当前视图仍在该 alias 的授权集合内 → 保持（避免切换身份把人的上下文打断）；
 *   * 当前视图不被允许（含 `null`）→ 回落 `defaultView`；
 *   * alias 未知 → `null`（界面应显示「未绑定」，而不是猜一个视图）。
 * @param current - 切换前的视图（`null` = 还没有选择）。
 * @param alias - 新 alias。
 * @returns 目标视图或 `null`。
 */
export function resolveViewForAlias(current: WorkViewKey | null, alias: string | null | undefined): WorkViewKey | null {
  const profile = profileForAlias(alias)
  if (profile === null) return null
  if (current !== null && profile.allowedViews.includes(current)) return current
  return profile.defaultView
}

/**
 * 该 alias 是否具备 Host Action 写授权（**仅 recruiter**；服务端仍是唯一裁决者）。
 * @param alias - 任意 alias。
 * @returns 有授权时为 `true`；未知 / 缺省 → `false`（fail-closed）。
 */
export function isWriteAuthorizedAlias(alias: string | null | undefined): boolean {
  return profileForAlias(alias)?.canExecuteWriteActions === true
}

/**
 * 写动作被阻断的精确原因（供界面直接展示，不静默失败）。
 *
 * 三种情况（冻结）：
 *   1. 有写授权的 alias（仅 `recruiter`）→ `''`（可以执行）；
 *   2. 未知 / 缺省 alias → 「未绑定 Demo Actor，写动作 fail-closed」+ 服务端错误码 + 动作名；
 *   3. 已知但非授权 alias → 含 alias、动作名、`ACTOR_NOT_AUTHORIZED` 与「切换为 Recruiter 身份」。
 * @param alias - 当前 alias。
 * @param actionLabel - 人读的动作名（如 `'批准 Rubric'`）；空串按 `'写动作'` 展示。
 * @returns 阻断原因；空串 = 有授权。
 */
export function writeBlockedReasonFor(alias: string | null | undefined, actionLabel: string): string {
  const profile = profileForAlias(alias)
  const action = actionName(actionLabel)
  if (profile === null) {
    return `未绑定 Demo Actor，写动作 fail-closed：「${action}」不会发送到服务端（未绑定 = 403 ACTOR_NOT_AUTHORIZED / DEMO_ACTOR_UNMAPPED、零写入）；请先在顶部选择受控 Demo Actor。`
  }
  if (profile.canExecuteWriteActions) return ''
  return `「${action}」被阻断：当前 Demo Actor 为 ${profile.alias}（${profile.label}），Host Action 写授权只给 recruiter——服务端将以 403 ACTOR_NOT_AUTHORIZED 拒绝且零写入；如需执行该动作，请显式切换为 Recruiter 身份（不会静默换身份）。`
}

/**
 * 把动作名压成可展示文本（空 / 非字符串 → `'写动作'`：界面不能出现「被阻断：」这种半句话）。
 * @param actionLabel - 任意动作名。
 * @returns 非空动作名。
 */
function actionName(actionLabel: string): string {
  const text = typeof actionLabel === 'string' ? actionLabel.trim() : ''
  return text.length > 0 ? text : '写动作'
}
