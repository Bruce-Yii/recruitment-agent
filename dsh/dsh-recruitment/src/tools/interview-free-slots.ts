// recruitment_interview_free_slots —— 只读查询“面试官交集空闲时段”的 DSH 工具。
//
// 与 HTTP `GET /recruitment/api/action/interview/free-slots` 共用同一份实现
// （`computeInterviewFreeSlots` / `parseQuery`，`src/http/interview-slots.ts`），
// 不复制槽位/时区/日历读取逻辑；不写库、不猜时段：
//   * 日历读不到 → 如实 `unsatisfied` 原因 + 空 slots；
//   * 面试官没有飞书绑定 → `NO_CALENDAR_BINDING`；
//   * 只有真的读到忙闲的参与人才参与交集。
//
// 用途（对话桥场景）：用户说“帮我查下一轮可约时段”时，Agent 先用 interview_get 拿面试官
// actor_id，再调本工具；拿到真实时段后由 Agent 决定是否 `recruitment_ui_dispatch(suggest_action)`。
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  computeInterviewFreeSlots,
  INTERVIEW_SLOTS_CONTRACT,
  parseQuery,
  SlotsHttpProblem,
  type InterviewFreeSlotsResponse,
  type InterviewSlotsCoreDeps,
  type ParsedQuery,
} from '../http/interview-slots.ts'

export const INTERVIEW_FREE_SLOTS_TOOL_NAME = 'recruitment_interview_free_slots'
const CONTRACT_VERSION = '1.0.0'
const MAX_INTERVIEWERS = 8
const REASON_TEXT = INTERVIEW_SLOTS_CONTRACT.reasonText

interface FreeSlotsToolArgs {
  readonly application_id?: string
  readonly interviewer_actor_ids: readonly string[]
  readonly days: number
  readonly duration_minutes: number
  readonly timezone: string
}

function invalid(detail: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', detail)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('arguments 必须是对象')
  return value as Record<string, unknown>
}

/** 归一化工具入参 → 复用 HTTP 路由同一份 `parseQuery` 校验。 */
function normalizeArgs(raw: unknown): ParsedQuery {
  const record = asRecord(raw)
  const idsRaw = record.interviewer_actor_ids
  if (!Array.isArray(idsRaw) || idsRaw.length === 0 || idsRaw.length > MAX_INTERVIEWERS) {
    invalid(`interviewer_actor_ids 要给 1..${MAX_INTERVIEWERS} 个 UUID`)
  }
  const ids = idsRaw.map((id) => {
    if (typeof id !== 'string') invalid('interviewer_actor_ids 每项必须是字符串')
    return id.trim()
  })
  const url = new URL('http://localhost/')
  if (record.application_id !== undefined) {
    if (typeof record.application_id !== 'string' || record.application_id.trim() === '') invalid('application_id 必须是非空字符串')
    url.searchParams.set('application_id', record.application_id.trim())
  }
  url.searchParams.set('interviewer_actor_ids', ids.join(','))
  for (const key of ['days', 'duration_minutes'] as const) {
    const value = record[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value)) invalid(`${key} 必须是整数`)
    url.searchParams.set(key, String(value))
  }
  if (record.timezone !== undefined) {
    if (typeof record.timezone !== 'string' || record.timezone.trim() === '') invalid('timezone 必须是非空字符串')
    url.searchParams.set('timezone', record.timezone.trim())
  }
  return parseQuery(url, { requireApplicationId: false })
}

function humanReason(reason: string): string {
  return REASON_TEXT[reason] ?? '暂时无法判断这位面试官的空闲'
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tool', 'contract_version', 'status', 'read_only',
    'application_id', 'interviewer_actor_ids', 'days', 'duration_minutes', 'timezone',
    'slots', 'proposed', 'unsatisfied', 'labels',
  ],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean' },
    application_id: { type: 'string' },
    interviewer_actor_ids: { type: 'array', items: { type: 'string' } },
    days: { type: 'integer' },
    duration_minutes: { type: 'integer' },
    timezone: { type: 'string' },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'busy_conflicts', 'source'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          busy_conflicts: { type: 'integer' },
          source: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        },
      },
    },
    proposed: { type: 'integer' },
    unsatisfied: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['interviewer_actor_id', 'reason'],
        properties: { interviewer_actor_id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
    labels: {
      type: 'object',
      additionalProperties: false,
      required: ['provenance', 'trigger', 'connection'],
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'AUTH_REQUIRED', 'NOT_CONNECTED'] },
      },
    },
  },
}

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['interviewer_actor_ids'],
  properties: {
    interviewer_actor_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Interviewer actor UUIDs (from interview_get); 1..8 unique UUIDs.',
    },
    application_id: {
      type: 'string',
      description: 'Optional application UUID for context; not used to invent candidate availability.',
    },
    days: {
      type: 'integer',
      description: 'Look-ahead days (1..14, default 5).',
    },
    duration_minutes: {
      type: 'integer',
      description: 'Slot length in minutes (15..180, default 45).',
    },
    timezone: {
      type: 'string',
      description: 'IANA timezone (default Asia/Shanghai).',
    },
  },
}

/**
 * 构造只读“面试官交集空闲时段”工具。
 * @param deps - 日历连接器依赖（不含身份；工具不读 Session）。
 * @returns 可注册的 ReadonlyToolDefinition。
 */
export function createInterviewFreeSlotsTool(deps: InterviewSlotsCoreDeps): ReadonlyToolDefinition {
  return {
    name: INTERVIEW_FREE_SLOTS_TOOL_NAME,
    description:
      'Read-only intersection of interviewers free calendar slots (same source as the v4 schedule dialog). '
      + 'Use it before suggesting an interview time. It never invents slots: when the Feishu calendar is not '
      + 'configured/authorized or an interviewer has no calendar binding, it returns empty slots plus honest '
      + 'reasons and labels (connection=NOT_CONNECTED/AUTH_REQUIRED). Provide interviewer_actor_ids from '
      + 'recruitment_interview_get; optional days (1..14), duration_minutes (15..180), timezone (IANA).',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args: unknown, value: unknown): readonly TextBlock[] => {
        const result = value as (InterviewFreeSlotsResponse & { interviewer_actor_ids?: readonly string[] }) | null
        if (result === null || result === undefined) return [{ type: 'text', text: '没有查到可约时段。' }]
        const lines: string[] = []
        if (result.slots.length === 0) {
          lines.push('当前没有可用的共同空闲时段（如实返回，没有编造时段）。')
        } else {
          lines.push(`共同空闲时段（${result.slots.length} 个）：`)
          for (const slot of result.slots.slice(0, 5)) {
            const start = slot.start.slice(0, 16).replace('T', ' ')
            const end = slot.end.slice(11, 16)
            lines.push(`- ${start}–${end}（${slot.source}）`)
          }
        }
        if (result.unsatisfied.length > 0) {
          const grouped = new Map<string, number>()
          for (const item of result.unsatisfied) grouped.set(item.reason, (grouped.get(item.reason) ?? 0) + 1)
          const parts = [...grouped.entries()].map(([reason, count]) => `${count} 位：${humanReason(reason)}`)
          lines.push(`没算进去的面试官：${parts.join('；')}`)
        }
        lines.push(`标签：${result.labels.provenance}/${result.labels.trigger}/${result.labels.connection}`)
        if (result.labels.connection !== 'CONNECTED') {
          lines.push('说明：日历未完全连通，以上时段不是 LIVE 读回的完整交集；不要当成确定可约。')
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args: unknown): Promise<unknown> => {
      let query: ParsedQuery
      try {
        query = normalizeArgs(args)
      } catch (error) {
        if (error instanceof SlotsHttpProblem) {
          throw new RecruitmentToolError('INVALID_ARGS', extractProblemMessage(error))
        }
        throw error
      }
      let result: InterviewFreeSlotsResponse
      try {
        result = await computeInterviewFreeSlots(deps, query)
      } catch (error) {
        if (error instanceof SlotsHttpProblem) {
          throw new RecruitmentToolError('INVALID_ARGS', extractProblemMessage(error))
        }
        throw error
      }
      return {
        tool: INTERVIEW_FREE_SLOTS_TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        status: 'OK',
        read_only: true,
        application_id: query.application_id,
        interviewer_actor_ids: query.interviewer_actor_ids,
        days: query.days,
        duration_minutes: query.duration_minutes,
        timezone: query.timezone,
        slots: result.slots,
        proposed: result.proposed,
        unsatisfied: result.unsatisfied,
        labels: result.labels,
      }
    },
  }
}

/** 从 HTTP 问题信封里取出人话 message（tool 层只回传 message，不暴露 status）。 */
function extractProblemMessage(error: SlotsHttpProblem): string {
  const body = error.body as { error?: { message?: unknown } } | null
  const message = body?.error?.message
  return typeof message === 'string' && message.length > 0 ? message : '空闲时段参数不合法'
}
