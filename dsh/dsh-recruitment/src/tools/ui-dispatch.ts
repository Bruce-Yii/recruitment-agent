// recruitment_ui_dispatch —— 只读 UI 调度工具（不碰数据库、不写业务事实）。
//
// 为什么存在（design/v4/chat-canvas-interaction-spec.md §2/§3.1）：
// 后端 Agent 已经能真实回答招聘问题，但右侧画布无法响应；产品要求"单轨同源"——
// 快捷 pill 与手打一句话走同一条 `/recruitment/agent/turn` 链路，由 Agent 通过本工具
// 表达"要导航到哪 / 页内聚焦哪一块 / 建议用户点哪个动作"，服务端校验后转成 SSE
// `ui_action`，前端只消费、不针对单个按钮硬编码。
//
// 三层动作（严禁混用）：
//   * navigate       —— 明确的空间/对象切换（人才库、岗位、队列、某申请/某岗位）；
//   * focus_section  —— 当前档案/岗位内的对照阅读，保持页面不切走，滚动+短时高亮；
//   * suggest_action —— 可能触发写操作/表单弹窗的场景，在对话气泡里给建议按钮，**不自动弹窗**。
//
// 本工具**只校验并回显 UI 意图**，零写库、零外部读取；真正切画布由前端消费 SSE。
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'

/** 工具名（agent-turn.ts 的 SSE 派发按这个名字识别）。 */
export const UI_DISPATCH_TOOL_NAME = 'recruitment_ui_dispatch'
/** 契约版本。 */
export const UI_DISPATCH_CONTRACT_VERSION = '1.0.0'

export type UiActionType = 'navigate' | 'focus_section' | 'suggest_action'
export type UiRouteKind = 'queue' | 'jobs' | 'talent' | 'application' | 'job' | 'interviewer'
export type UiQueueFilter = 'all' | 'screening' | 'interviewing'
export type UiSectionKind = 'summary' | 'criteria' | 'resume' | 'interviews' | 'rubric' | 'candidates'
export type UiModalKind = 'schedule' | 'screening' | 'decision' | 'email' | 'transfer'

/** 校验后的 UI 动作（服务端原样下发给前端；前端不再猜字段）。 */
export interface UiActionPayload {
  readonly action: UiActionType
  readonly route?: UiRouteKind
  readonly target_id?: string
  readonly filter?: UiQueueFilter
  readonly section?: UiSectionKind
  readonly modal?: UiModalKind
  readonly label?: string
}

const ACTIONS: readonly UiActionType[] = ['navigate', 'focus_section', 'suggest_action']
const ROUTES: readonly UiRouteKind[] = ['queue', 'jobs', 'talent', 'application', 'job', 'interviewer']
const FILTERS: readonly UiQueueFilter[] = ['all', 'screening', 'interviewing']
const SECTIONS: readonly UiSectionKind[] = ['summary', 'criteria', 'resume', 'interviews', 'rubric', 'candidates']
const MODALS: readonly UiModalKind[] = ['schedule', 'screening', 'decision', 'email', 'transfer']

const PAYLOAD_KEYS = new Set(['action', 'route', 'target_id', 'filter', 'section', 'modal', 'label'])

function invalid(detail: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', detail)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('arguments 必须是对象')
  return value as Record<string, unknown>
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') invalid(`${key} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') invalid(`${key} 不能为空字符串`)
  return trimmed
}

/** target_id：只允许单段安全标识（UUID / 业务 id），拒绝相对路径与注入。 */
function validateTargetId(value: unknown, field = 'target_id'): string {
  if (typeof value !== 'string') invalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') invalid(`${field} 不能为空`)
  if (trimmed.length > 128) invalid(`${field} 过长（≤128）`)
  // 只允许字母数字与 - _ .：禁止 / \ # ? 空白 与 .. 路径注入。
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) || trimmed.includes('..')) {
    invalid(`${field} 只能是安全 id（不允许路径/相对路径/# 片段）`)
  }
  return trimmed
}

function validateLabel(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) invalid('suggest_action 必须给 label（按钮文案，≤24字）')
    return undefined
  }
  if (typeof value !== 'string') invalid('label 必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') invalid('label 不能为空')
  if ([...trimmed].length > 24) invalid('label 过长（≤24字）')
  return trimmed
}

/**
 * 校验并归一化 UI 动作（工具 execute 与 SSE 派发共用同一份规则）。
 * @param raw - 模型给的 arguments。
 * @returns 已校验 payload；非法输入抛 `RecruitmentToolError('INVALID_ARGS')`。
 */
export function normalizeUiAction(raw: unknown): UiActionPayload {
  const record = asRecord(raw)
  for (const key of Object.keys(record)) {
    if (!PAYLOAD_KEYS.has(key)) invalid(`未知参数 ${key}（只允许 action/route/target_id/filter/section/modal/label）`)
  }
  const action = record.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    invalid('action 必须是 navigate / focus_section / suggest_action 之一')
  }
  const typedAction = action as UiActionType
  const label = validateLabel(record.label, typedAction === 'suggest_action')

  if (typedAction === 'navigate') {
    const route = record.route
    if (typeof route !== 'string' || !(ROUTES as readonly string[]).includes(route)) {
      invalid('navigate 必须给合法 route（queue/jobs/talent/application/job/interviewer）')
    }
    const typedRoute = route as UiRouteKind
    if (record.section !== undefined || record.modal !== undefined) invalid('navigate 不得携带 section/modal（动作严禁混用）')
    const filter = record.filter
    if (filter !== undefined) {
      if (typeof filter !== 'string' || !(FILTERS as readonly string[]).includes(filter)) {
        invalid('filter 必须是 all / screening / interviewing')
      }
      if (typedRoute !== 'queue') invalid('filter 只允许与 route=queue 一起使用')
    }
    let targetId: string | undefined
    if (typedRoute === 'application' || typedRoute === 'job') {
      targetId = validateTargetId(record.target_id)
    } else if (record.target_id !== undefined) {
      invalid('只有 route=application|job 才允许 target_id')
    }
    return {
      action: 'navigate',
      route: typedRoute,
      ...(targetId === undefined ? {} : { target_id: targetId }),
      ...(filter === undefined ? {} : { filter: filter as UiQueueFilter }),
      ...(label === undefined ? {} : { label }),
    }
  }

  if (typedAction === 'focus_section') {
    const section = record.section
    if (typeof section !== 'string' || !(SECTIONS as readonly string[]).includes(section)) {
      invalid('focus_section 必须给合法 section（summary/criteria/resume/interviews/rubric/candidates）')
    }
    if (record.route !== undefined || record.target_id !== undefined || record.filter !== undefined || record.modal !== undefined) {
      invalid('focus_section 不得携带 route/target_id/filter/modal（动作严禁混用）')
    }
    return {
      action: 'focus_section',
      section: section as UiSectionKind,
      ...(label === undefined ? {} : { label }),
    }
  }

  // suggest_action：对话气泡里的建议按钮；绝不自动弹窗。
  const modal = record.modal
  if (modal !== undefined && (typeof modal !== 'string' || !(MODALS as readonly string[]).includes(modal))) {
    invalid('modal 必须是 schedule / screening / decision / email / transfer')
  }
  const route = record.route
  if (route !== undefined && (typeof route !== 'string' || !(ROUTES as readonly string[]).includes(route))) {
    invalid('suggest_action 的 route 必须是合法 route')
  }
  if (modal === undefined && route === undefined) invalid('suggest_action 必须给 modal 或 route 至少一个')
  if (record.section !== undefined || record.filter !== undefined) invalid('suggest_action 不得携带 section/filter')
  let targetId: string | undefined
  if (route === 'application' || route === 'job') {
    targetId = validateTargetId(record.target_id)
  } else if (record.target_id !== undefined) {
    invalid('只有 route=application|job 才允许 target_id')
  }
  return {
    action: 'suggest_action',
    ...(route === undefined ? {} : { route: route as UiRouteKind }),
    ...(targetId === undefined ? {} : { target_id: targetId }),
    ...(modal === undefined ? {} : { modal: modal as UiModalKind }),
    label: label as string,
  }
}

/** 人话描述（仅供工具 render；前端只用结构化 payload）。 */
function describeAction(payload: UiActionPayload): string {
  if (payload.action === 'navigate') {
    if (payload.route === 'application' || payload.route === 'job') {
      return `导航到${payload.route === 'application' ? '候选人档案' : '岗位详情'}（${payload.target_id}）`
    }
    const routeName = payload.route === 'queue' ? '今日待办' : payload.route === 'jobs' ? '在招岗位' : payload.route === 'talent' ? '人才库' : '面试官视图'
    const filterName = payload.filter === 'screening' ? '，只看待初筛' : payload.filter === 'interviewing' ? '，只看面试中' : ''
    return `导航到${routeName}${filterName}`
  }
  if (payload.action === 'focus_section') {
    const sectionName = {
      summary: '当前状态与提炼', criteria: '岗位标准对照', resume: '简历原文摘录',
      interviews: '面试推进', rubric: '评分标准', candidates: '候选人池',
    }[payload.section ?? 'summary']
    return `页内聚焦到「${sectionName}」`
  }
  const target = payload.modal === 'schedule' ? '面试排期' : payload.modal === 'screening' ? '初筛结论'
    : payload.modal === 'decision' ? '正式决策' : payload.modal === 'email' ? '发邮件' : payload.modal === 'transfer' ? '跨岗调剂' : '目标页面'
  return `建议动作「${payload.label ?? ''}」→ ${target}`
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'contract_version', 'status', 'read_only', 'ui_action'],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean' },
    ui_action: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        route: { type: 'string', enum: [...ROUTES] },
        target_id: { type: 'string' },
        filter: { type: 'string', enum: [...FILTERS] },
        section: { type: 'string', enum: [...SECTIONS] },
        modal: { type: 'string', enum: [...MODALS] },
        label: { type: 'string' },
      },
    },
  },
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [...ACTIONS],
      description:
        'navigate = 明确的空间/对象切换（人才库/岗位/队列/某申请/某岗位）；'
        + 'focus_section = 当前档案内对照阅读，保持页面不切走；'
        + 'suggest_action = 需要用户再点一下的动作（查完时段去约面、总结完去初筛/决策），绝不自动弹窗。',
    },
    route: {
      type: 'string',
      enum: [...ROUTES],
      description: 'navigate/suggest_action 的目标空间；application/job 时必须给 target_id；interviewer 仅面试官身份可用。',
    },
    target_id: {
      type: 'string',
      description: 'route=application 时为 application_id；route=job 时为 job_id。只允许安全 id，禁止路径/#。',
    },
    filter: {
      type: 'string',
      enum: [...FILTERS],
      description: '仅 route=queue 时可用：all / screening（待初筛）/ interviewing（面试中）。',
    },
    section: {
      type: 'string',
      enum: [...SECTIONS],
      description: 'focus_section 必填：summary / criteria（岗位标准对照）/ resume（简历原文）/ interviews / rubric（岗位评分标准）/ candidates。',
    },
    modal: {
      type: 'string',
      enum: [...MODALS],
      description: 'suggest_action 建议唤起的弹窗：schedule / screening / decision / email / transfer。',
    },
    label: {
      type: 'string',
      description: '给用户看的简短中文说明/按钮文案，≤24 字；suggest_action 必填，其余可选。',
    },
  },
}

/**
 * 构造只读 UI 调度工具。
 * @returns 可注册的 ReadonlyToolDefinition（零依赖、零副作用）。
 */
export function createUiDispatchTool(): ReadonlyToolDefinition {
  return {
    name: UI_DISPATCH_TOOL_NAME,
    description:
      'Read-only UI dispatch for the v4 workspace canvas. Use it when the human asks to open/switch a space '
      + '(navigate), to compare/read a section on the current record (focus_section), or after a read-only answer '
      + 'when the next step may write and should stay a human click (suggest_action). '
      + 'navigate switches the right canvas; focus_section scrolls+highlights within the current page; '
      + 'suggest_action renders a suggested button in the chat bubble and NEVER opens a modal automatically. '
      + 'Rules: navigate needs route (and target_id for application/job); focus_section needs section; '
      + 'suggest_action needs label plus modal or route. Do not use it for business writes or data changes.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): readonly TextBlock[] => {
        const payload = (value as { ui_action?: UiActionPayload } | null)?.ui_action
        return [{ type: 'text', text: payload === undefined ? 'UI 动作已校验。' : `UI 动作已校验：${describeAction(payload)}` }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args: unknown): Promise<unknown> => {
      const uiAction = normalizeUiAction(args)
      return {
        tool: UI_DISPATCH_TOOL_NAME,
        contract_version: UI_DISPATCH_CONTRACT_VERSION,
        status: 'OK',
        read_only: true,
        ui_action: uiAction,
      }
    },
  }
}
