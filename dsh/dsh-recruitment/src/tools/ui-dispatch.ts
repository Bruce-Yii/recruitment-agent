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

export type UiActionType = 'navigate' | 'focus_section' | 'suggest_action' | 'propose_write'
export type UiRouteKind = 'queue' | 'jobs' | 'talent' | 'application' | 'job' | 'interviewer'
export type UiQueueFilter = 'all' | 'screening' | 'interviewing'
export type UiSectionKind = 'summary' | 'criteria' | 'resume' | 'interviews' | 'rubric' | 'candidates'
export type UiModalKind = 'schedule' | 'screening' | 'decision' | 'email' | 'transfer'

/** 对话内确认卡支持的高频单步写意图（仅提草稿，绝不落库）。 */
export type UiWriteIntent =
  | 'screening_decide'
  | 'stage_advance'
  | 'candidate_constraint'
  | 'interview_schedule'
  | 'decision_record'

/** 确认卡事实摘要的一行（人话键值，禁止 UUID/机器码）。 */
export interface UiWriteSummaryItem {
  readonly label: string
  readonly value: string
}

/** 各 intent 的业务参数（由现有前端写合同消费）。 */
export interface UiWritePayload {
  readonly decision?: 'PASS' | 'REJECT'
  readonly rationale?: string
  readonly target_stage?: string
  readonly constraint_kind?: 'PIN' | 'HANDOFF'
  readonly constraint_text?: string
  readonly round_number?: number
  readonly interviewer_id?: string
  readonly scheduled_start?: string
  readonly scheduled_end?: string
  readonly timezone?: string
  readonly final_outcome?: 'HIRE' | 'REJECT' | 'HOLD'
}

/** 一份待真人点击确认的写动作草稿。 */
export interface UiWriteProposal {
  readonly intent: UiWriteIntent
  readonly application_id: string
  readonly title: string
  readonly tone?: 'default' | 'danger'
  readonly summary: readonly UiWriteSummaryItem[]
  readonly fallback_modal?: UiModalKind
  readonly payload: UiWritePayload
}

/** 校验后的 UI 动作（服务端原样下发给前端；前端不再猜字段）。 */
export interface UiActionPayload {
  readonly action: UiActionType
  readonly route?: UiRouteKind
  readonly target_id?: string
  readonly filter?: UiQueueFilter
  readonly section?: UiSectionKind
  readonly modal?: UiModalKind
  readonly label?: string
  readonly proposal?: UiWriteProposal
}

const ACTIONS: readonly UiActionType[] = ['navigate', 'focus_section', 'suggest_action', 'propose_write']
const ROUTES: readonly UiRouteKind[] = ['queue', 'jobs', 'talent', 'application', 'job', 'interviewer']
const FILTERS: readonly UiQueueFilter[] = ['all', 'screening', 'interviewing']
const SECTIONS: readonly UiSectionKind[] = ['summary', 'criteria', 'resume', 'interviews', 'rubric', 'candidates']
const MODALS: readonly UiModalKind[] = ['schedule', 'screening', 'decision', 'email', 'transfer']
const WRITE_INTENTS: readonly UiWriteIntent[] = [
  'screening_decide', 'stage_advance', 'candidate_constraint', 'interview_schedule', 'decision_record',
]
const TONES: readonly NonNullable<UiWriteProposal['tone']>[] = ['default', 'danger']
const WRITE_PAYLOAD_KEYS: Readonly<Record<UiWriteIntent, readonly string[]>> = {
  screening_decide: ['decision', 'rationale'],
  stage_advance: ['target_stage'],
  candidate_constraint: ['constraint_kind', 'constraint_text'],
  interview_schedule: ['round_number', 'interviewer_id', 'scheduled_start', 'scheduled_end', 'timezone'],
  decision_record: ['final_outcome'],
}

const PAYLOAD_KEYS = new Set(['action', 'route', 'target_id', 'filter', 'section', 'modal', 'label', 'proposal'])
const PROPOSAL_KEYS = new Set(['intent', 'application_id', 'title', 'tone', 'summary', 'fallback_modal', 'payload'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function codePointLength(value: string): number {
  return [...value].length
}

/** 禁止把 UUID / 长 hex / 全大写机器码塞进给人看的标题/摘要。 */
function rejectMachineText(value: string, field: string): void {
  if (UUID_RE.test(value) || /[0-9a-f]{32,}/i.test(value) || /^[A-Z][A-Z0-9_]{2,}$/.test(value)) {
    invalid(`${field} 不能是 UUID/机器码（只写人话）`)
  }
}

function requireText(value: unknown, field: string, maxCodePoints: number): string {
  if (typeof value !== 'string') invalid(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (trimmed === '') invalid(`${field} 不能为空`)
  if (codePointLength(trimmed) > maxCodePoints) invalid(`${field} 过长（≤${maxCodePoints}字）`)
  return trimmed
}

function optionalText(value: unknown, field: string, maxCodePoints: number): string | undefined {
  if (value === undefined) return undefined
  return requireText(value, field, maxCodePoints)
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value.trim())) invalid(`${field} 必须是合法 UUID`)
  return value.trim()
}

function validateSummary(raw: unknown): readonly UiWriteSummaryItem[] {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 4) invalid('proposal.summary 必须是 2..4 条')
  const out: UiWriteSummaryItem[] = []
  for (const item of raw) {
    const record = asRecord(item)
    for (const key of Object.keys(record)) {
      if (key !== 'label' && key !== 'value') invalid(`proposal.summary 不允许字段 ${key}`)
    }
    const label = requireText(record.label, 'proposal.summary.label', 12)
    const value = requireText(record.value, 'proposal.summary.value', 48)
    rejectMachineText(label, 'proposal.summary.label')
    rejectMachineText(value, 'proposal.summary.value')
    out.push({ label, value })
  }
  return out
}

function isOffsetIso(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false
  return Number.isFinite(Date.parse(value))
}

function validateWritePayload(raw: unknown, intent: UiWriteIntent): UiWritePayload {
  const record = asRecord(raw)
  const allowed = new Set(WRITE_PAYLOAD_KEYS[intent])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalid(`proposal.payload 不允许字段 ${key}（intent=${intent}）`)
  }

  if (intent === 'screening_decide') {
    if (record.decision !== 'PASS' && record.decision !== 'REJECT') invalid('screening_decide.decision 必须是 PASS 或 REJECT')
    return {
      decision: record.decision,
      ...(optionalText(record.rationale, 'proposal.payload.rationale', 500) === undefined
        ? {}
        : { rationale: optionalText(record.rationale, 'proposal.payload.rationale', 500) as string }),
    }
  }
  if (intent === 'stage_advance') {
    const target = requireText(record.target_stage, 'stage_advance.target_stage', 64)
    rejectMachineText(target, 'stage_advance.target_stage')
    return { target_stage: target }
  }
  if (intent === 'candidate_constraint') {
    if (record.constraint_kind !== 'PIN' && record.constraint_kind !== 'HANDOFF') {
      invalid('candidate_constraint.constraint_kind 必须是 PIN 或 HANDOFF')
    }
    const text = requireText(record.constraint_text, 'candidate_constraint.constraint_text', 500)
    return { constraint_kind: record.constraint_kind, constraint_text: text }
  }
  if (intent === 'interview_schedule') {
    const interviewerId = requireUuid(record.interviewer_id, 'interview_schedule.interviewer_id')
    const start = requireText(record.scheduled_start, 'interview_schedule.scheduled_start', 64)
    const end = requireText(record.scheduled_end, 'interview_schedule.scheduled_end', 64)
    if (!isOffsetIso(start)) invalid('interview_schedule.scheduled_start 必须是带时区偏移的 ISO-8601')
    if (!isOffsetIso(end)) invalid('interview_schedule.scheduled_end 必须是带时区偏移的 ISO-8601')
    if (Date.parse(start) >= Date.parse(end)) invalid('interview_schedule.scheduled_end 必须晚于 scheduled_start')
    let roundNumber: number | undefined
    if (record.round_number !== undefined) {
      if (typeof record.round_number !== 'number' || !Number.isInteger(record.round_number) || record.round_number < 1 || record.round_number > 20) {
        invalid('interview_schedule.round_number 必须是 1..20 的整数')
      }
      roundNumber = record.round_number
    }
    let timezone: string | undefined
    if (record.timezone !== undefined) {
      timezone = requireText(record.timezone, 'interview_schedule.timezone', 64)
      try {
        new Intl.DateTimeFormat(undefined, { timeZone: timezone })
      } catch {
        invalid('interview_schedule.timezone 必须是合法 IANA 时区')
      }
    }
    return {
      interviewer_id: interviewerId,
      scheduled_start: start,
      scheduled_end: end,
      ...(roundNumber === undefined ? {} : { round_number: roundNumber }),
      ...(timezone === undefined ? {} : { timezone }),
    }
  }
  if (record.final_outcome !== 'HIRE' && record.final_outcome !== 'REJECT' && record.final_outcome !== 'HOLD') {
    invalid('decision_record.final_outcome 必须是 HIRE / REJECT / HOLD')
  }
  return { final_outcome: record.final_outcome }
}

/**
 * 校验一份 propose_write 草稿（绝不落库；参数不全一律 INVALID_ARGS）。
 * @param raw - 模型给的 proposal。
 * @returns 已校验的 UiWriteProposal。
 */
export function validateWriteProposal(raw: unknown): UiWriteProposal {
  const record = asRecord(raw)
  for (const key of Object.keys(record)) {
    if (!PROPOSAL_KEYS.has(key)) invalid(`proposal 不允许字段 ${key}`)
  }
  const intentRaw = record.intent
  if (typeof intentRaw !== 'string' || !(WRITE_INTENTS as readonly string[]).includes(intentRaw)) {
    invalid('proposal.intent 必须是 screening_decide / stage_advance / candidate_constraint / interview_schedule / decision_record 之一')
  }
  const intent = intentRaw as UiWriteIntent
  const applicationId = requireUuid(record.application_id, 'proposal.application_id')
  const title = requireText(record.title, 'proposal.title', 24)
  rejectMachineText(title, 'proposal.title')
  const summary = validateSummary(record.summary)
  const payload = validateWritePayload(record.payload, intent)
  let tone: UiWriteProposal['tone']
  if (record.tone !== undefined) {
    if (typeof record.tone !== 'string' || !(TONES as readonly string[]).includes(record.tone)) {
      invalid('proposal.tone 必须是 default 或 danger')
    }
    tone = record.tone as UiWriteProposal['tone']
  }
  let fallbackModal: UiModalKind | undefined
  if (record.fallback_modal !== undefined) {
    if (typeof record.fallback_modal !== 'string' || !(MODALS as readonly string[]).includes(record.fallback_modal)) {
      invalid('proposal.fallback_modal 必须是 schedule / screening / decision / email / transfer')
    }
    fallbackModal = record.fallback_modal as UiModalKind
  }
  return {
    intent,
    application_id: applicationId,
    title,
    ...(tone === undefined ? {} : { tone }),
    summary,
    ...(fallbackModal === undefined ? {} : { fallback_modal: fallbackModal }),
    payload,
  }
}

/**
 * 校验并归一化 UI 动作（工具 execute 与 SSE 派发共用同一份规则）。
 * @param raw - 模型给的 arguments。
 * @returns 已校验 payload；非法输入抛 `RecruitmentToolError('INVALID_ARGS')`。
 */
export function normalizeUiAction(raw: unknown): UiActionPayload {
  const record = asRecord(raw)
  for (const key of Object.keys(record)) {
    if (!PAYLOAD_KEYS.has(key)) {
      invalid(`未知参数 ${key}（只允许 action/route/target_id/filter/section/modal/label/proposal）`)
    }
  }
  const action = record.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    invalid('action 必须是 navigate / focus_section / suggest_action / propose_write 之一')
  }
  const typedAction = action as UiActionType
  const label = validateLabel(record.label, typedAction === 'suggest_action')

  if (typedAction !== 'propose_write' && record.proposal !== undefined) {
    invalid('只有 action=propose_write 才允许 proposal（动作严禁混用）')
  }
  if (typedAction === 'propose_write') {
    if (
      record.route !== undefined || record.target_id !== undefined || record.filter !== undefined ||
      record.section !== undefined || record.modal !== undefined
    ) {
      invalid('propose_write 不得携带 route/target_id/filter/section/modal')
    }
    return {
      action: 'propose_write',
      ...(label === undefined ? {} : { label }),
      proposal: validateWriteProposal(record.proposal),
    }
  }

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
  if (payload.action === 'propose_write') {
    return `待确认：${payload.proposal?.title ?? '写操作草稿'}（真人点击后才执行，不落库）`
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
        proposal: {
          type: 'object',
          additionalProperties: false,
          required: ['intent', 'application_id', 'title', 'summary', 'payload'],
          properties: {
            intent: { type: 'string', enum: [...WRITE_INTENTS] },
            application_id: { type: 'string' },
            title: { type: 'string' },
            tone: { type: 'string', enum: [...TONES] },
            summary: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'value'],
                properties: {
                  label: { type: 'string' },
                  value: { type: 'string' },
                },
              },
            },
            fallback_modal: { type: 'string', enum: [...MODALS] },
            payload: { type: 'object', description: 'per-intent business fields (validated fail-closed)' },
          },
        },
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
        + 'suggest_action = 需要用户再点一下的动作（查完时段去约面、总结完去初筛/决策），绝不自动弹窗；'
        + 'propose_write = 参数齐全的高频单步写动作草稿，前端渲染对话内确认卡，真人点击前绝不落库；参数不全时退回 suggest_action。',
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
    proposal: {
      type: 'object',
      additionalProperties: false,
      required: ['intent', 'application_id', 'title', 'summary', 'payload'],
      description:
        '仅 action=propose_write：待真人确认的写动作草稿。参数必须来自真实查询；缺对象/面评/时段等参数时不要伪造，改用 suggest_action。',
      properties: {
        intent: {
          type: 'string',
          enum: [...WRITE_INTENTS],
          description: 'screening_decide / stage_advance / candidate_constraint / interview_schedule / decision_record。',
        },
        application_id: { type: 'string', description: '真实 application UUID（不得伪造）。' },
        title: { type: 'string', description: '≤24 字中文标题，如「确认初筛通过」。' },
        tone: { type: 'string', enum: [...TONES], description: '淘汰/不通过用 danger，其余 default。' },
        summary: {
          type: 'array',
          description: '2..4 条人话键值；label ≤12 字、value ≤48 字，禁止 UUID/机器码。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'value'],
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        fallback_modal: { type: 'string', enum: [...MODALS], description: '「在弹窗微调」对应的既有居中弹窗。' },
        payload: {
          type: 'object',
          additionalProperties: false,
          description: '按 intent 给必填业务字段（服务端会逐个校验）。',
          properties: {
            decision: { type: 'string', enum: ['PASS', 'REJECT'] },
            rationale: { type: 'string' },
            target_stage: { type: 'string' },
            constraint_kind: { type: 'string', enum: ['PIN', 'HANDOFF'] },
            constraint_text: { type: 'string' },
            round_number: { type: 'integer' },
            interviewer_id: { type: 'string' },
            scheduled_start: { type: 'string' },
            scheduled_end: { type: 'string' },
            timezone: { type: 'string' },
            final_outcome: { type: 'string', enum: ['HIRE', 'REJECT', 'HOLD'] },
          },
        },
      },
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
      + '(navigate), to compare/read a section on the current record (focus_section), when the next step may write '
      + 'and should stay a human click (suggest_action), or when a high-frequency single-step write has every '
      + 'required parameter from real data (propose_write). '
      + 'navigate switches the right canvas; focus_section scrolls+highlights within the current page; '
      + 'suggest_action renders a suggested button in the chat bubble and NEVER opens a modal automatically; '
      + 'propose_write renders an inline confirmation card and NEVER writes by itself — the human must click. '
      + 'Rules: navigate needs route (and target_id for application/job); focus_section needs section; '
      + 'suggest_action needs label plus modal or route; propose_write needs proposal with intent/application_id/'
      + 'title/summary(2..4)/payload, and per-intent fields. '
      + 'When the human asks for one of the five high-frequency actions (add a pin/handoff reminder, pass/reject '
      + 'screening, advance stage, schedule an interview at an already-known time, or record a final decision) '
      + 'and you have the real application_id plus the required business values, call propose_write instead of '
      + 'replying that you lack write capability: propose_write is only a draft for human confirmation and does '
      + 'not write by itself. '
      + 'If the object id, interviewer, or exact time is missing, fall back to suggest_action instead of inventing '
      + 'values. For decision_record, still use propose_write even when scorecards are missing: the inline card '
      + 'shows the blocker honestly and disables confirmation. Do not use it for business writes or data changes.',
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
