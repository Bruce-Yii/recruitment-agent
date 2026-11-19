// 复合确认计划 —— 纯函数层（无 DB / 网络 I/O）。
//
// D-159：一次指令里的多个「业务决定 / 对外写」合并成一张确认卡：全量预检 →
// 人点一次 → 按顺序执行、逐条回报。本文件只负责：解析原始计划、结构预检、
// 人话摘要、确定性指纹；不连库、不改状态、不 import 任何 db/ 模块。
// 仅 import node:crypto 做确定性 sha256。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'

/** 允许的原子动作闭集（顺序固定，测试按此断言不许悄悄扩集）。 */
export const COMPOUND_ACTIONS = ['screening_decide', 'candidate_constraint', 'interview_schedule'] as const
export type CompoundAction = typeof COMPOUND_ACTIONS[number]

/** 单个步骤：0-based 序号 + 动作 + 去掉 action 键的 args 浅拷贝。 */
export interface ParsedStep {
  readonly step: number
  readonly action: CompoundAction
  readonly args: Record<string, unknown>
}

/** 解析成功后的计划。 */
export interface CompoundPlan {
  readonly steps: readonly ParsedStep[]
  readonly confirmation_text: string
  readonly preview_only: boolean
}

/** 解析结果：成功带 plan；失败带稳定 reason_code 与人话 message。 */
export type ParseOutcome =
  | { readonly ok: true; readonly plan: CompoundPlan }
  | { readonly ok: false; readonly code: 'UNSUPPORTED_STEP' | 'INVALID_ARGS'; readonly reason_code: string; readonly message: string; readonly step?: number }

/** 结构预检的单步结果。 */
export interface StepPreflight {
  readonly step: number
  readonly action: CompoundAction
  readonly ok: boolean
  readonly blocked_reason: string
}

/** 确认卡上给人看的三句话。 */
export interface StepSummary {
  readonly will_do: string
  readonly affects: string
  readonly on_failure: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const MAX_STEPS = 50
const MAX_CONSTRAINT_TEXT = 500

const SCREENING_RESULTS: readonly string[] = ['PASS', 'HOLD', 'REJECT']
const CONSTRAINT_KINDS: readonly string[] = ['PIN', 'HANDOFF']
const CONSTRAINT_SOURCES: readonly string[] = ['CHAT', 'WEIXIN', 'PHONE', 'OTHER']
const SCHEDULE_INTENTS: readonly string[] = ['CREATE', 'RESCHEDULE', 'CANCEL', 'WITHDRAW_INTERVIEWER']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function invalid(reason_code: string, message: string): ParseOutcome {
  return { ok: false, code: 'INVALID_ARGS', reason_code, message }
}

/**
 * 解析原始复合计划。检查顺序固定，错误码稳定：
 *   1. raw 必须是非 null / 非数组对象；
 *   2. steps 必须是 1..50 的非空数组；
 *   3. confirmation_text 字段必须是字符串（缺失 → MISSING_CONFIRMATION_TEXT；
 *      preview_only:false 时不能为空 → EMPTY_CONFIRMATION_TEXT）；
 *   4. preview_only 必须是 boolean（缺省 false）；
 *   5. 逐步：step 必须是对象且 action 为字符串，未知 action 一律
 *      UNSUPPORTED_STEP（preview_only=true 也一样）。
 */
export function parseCompoundPlan(raw: unknown): ParseOutcome {
  if (!isPlainObject(raw)) {
    return invalid('TYPE_MISMATCH', '计划必须是一个对象')
  }
  const obj = raw as Record<string, unknown>

  const stepsRaw = obj.steps
  if (!Array.isArray(stepsRaw)) {
    return invalid('STEPS_NOT_ARRAY', '步骤列表必须是一个数组')
  }
  if (stepsRaw.length < 1 || stepsRaw.length > MAX_STEPS) {
    return invalid('STEPS_OUT_OF_RANGE', `步骤数必须在 1..${MAX_STEPS} 之间`)
  }

  if (!Object.prototype.hasOwnProperty.call(obj, 'confirmation_text')) {
    return invalid('MISSING_CONFIRMATION_TEXT', '缺少确认文案')
  }
  const confirmationText = obj.confirmation_text
  if (typeof confirmationText !== 'string') {
    return invalid('CONFIRMATION_TEXT_TYPE', '确认文案必须是字符串')
  }

  let previewOnly = false
  if (Object.prototype.hasOwnProperty.call(obj, 'preview_only')) {
    if (typeof obj.preview_only !== 'boolean') {
      return invalid('PREVIEW_ONLY_TYPE', 'preview_only 必须是布尔值')
    }
    previewOnly = obj.preview_only
  }
  // preview_only:true 允许空文案；否则必须非空。
  if (!previewOnly && confirmationText.trim().length === 0) {
    return invalid('EMPTY_CONFIRMATION_TEXT', '确认文案不能为空')
  }

  const steps: ParsedStep[] = []
  for (let i = 0; i < stepsRaw.length; i += 1) {
    const rawStep = stepsRaw[i]
    if (!isPlainObject(rawStep)) {
      return invalid('STEP_TYPE_MISMATCH', `第 ${i} 步必须是一个对象`)
    }
    const action = rawStep.action
    if (typeof action !== 'string') {
      return invalid('STEP_ACTION_MISSING', `第 ${i} 步缺少字符串动作`)
    }
    if (!(COMPOUND_ACTIONS as readonly string[]).includes(action)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_STEP',
        reason_code: 'UNSUPPORTED_STEP',
        message: `第 ${i} 步的动作 ${action} 暂不支持`,
        step: i,
      }
    }
    const args: Record<string, unknown> = {}
    for (const key of Object.keys(rawStep)) {
      if (key !== 'action') args[key] = rawStep[key]
    }
    steps.push({ step: i, action: action as CompoundAction, args })
  }

  return { ok: true, plan: { steps, confirmation_text: confirmationText, preview_only: previewOnly } }
}

/** 结构预检：只判断字段是否齐全/形状合法，不查库、不判越权或冲突。 */
export function preflightShape(plan: CompoundPlan): readonly StepPreflight[] {
  return plan.steps.map((s) => {
    const a = s.args
    let reason = ''
    switch (s.action) {
      case 'screening_decide': {
        if (!isUuid(a.application_id)) {
          reason = '缺少合法的申请编号（应为 UUID）'
        } else if (!isNonEmptyString(a.result) || !SCREENING_RESULTS.includes(a.result)) {
          reason = '初筛结论必须是 PASS、HOLD 或 REJECT 之一'
        } else if (!isNonEmptyString(a.reason)) {
          reason = '必须附上非空的初筛理由'
        }
        break
      }
      case 'candidate_constraint': {
        if (!isUuid(a.application_id)) {
          reason = '缺少合法的申请编号（应为 UUID）'
        } else if (!isNonEmptyString(a.kind) || !CONSTRAINT_KINDS.includes(a.kind)) {
          reason = '约束种类必须是 PIN 或 HANDOFF 之一'
        } else if (!isNonEmptyString(a.text) || a.text.length > MAX_CONSTRAINT_TEXT) {
          reason = `约束内容不能为空且不得超过 ${MAX_CONSTRAINT_TEXT} 字`
        } else if (!isNonEmptyString(a.source) || !CONSTRAINT_SOURCES.includes(a.source)) {
          reason = '约束来源必须是 CHAT、WEIXIN、PHONE 或 OTHER 之一'
        } else if (a.kind === 'HANDOFF' && !isUuid(a.interview_id)) {
          reason = '交接提醒必须带合法的面试编号（UUID）'
        }
        break
      }
      case 'interview_schedule': {
        if (!isUuid(a.application_id)) {
          reason = '缺少合法的申请编号（应为 UUID）'
        } else {
          const intent = a.intent === undefined ? 'CREATE' : a.intent
          if (typeof intent !== 'string' || !SCHEDULE_INTENTS.includes(intent)) {
            reason = '面试操作意图必须是 CREATE、RESCHEDULE、CANCEL 或 WITHDRAW_INTERVIEWER 之一'
          } else {
            if (intent === 'CREATE' || intent === 'RESCHEDULE') {
              const start = a.scheduled_start_at
              const end = a.scheduled_end_at
              if (typeof start !== 'string' || !ISO_WITH_TZ_RE.test(start)) {
                reason = '缺少合法的开始时间（ISO-8601 带时区）'
              } else if (typeof end !== 'string' || !ISO_WITH_TZ_RE.test(end)) {
                reason = '缺少合法的结束时间（ISO-8601 带时区）'
              } else if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
                reason = '面试时间不是合法的时间点'
              } else if (Date.parse(start) >= Date.parse(end)) {
                reason = '面试开始时间必须早于结束时间'
              }
            }
            if (reason === '' && a.interviewer_actor_ids !== undefined) {
              if (!Array.isArray(a.interviewer_actor_ids) || !a.interviewer_actor_ids.every(isUuid)) {
                reason = '面试官编号列表必须是 UUID 数组'
              }
            }
          }
        }
        break
      }
    }
    return { step: s.step, action: s.action, ok: reason === '', blocked_reason: reason }
  })
}

/** 三步人话摘要：不含内部编号 / 哈希 / 字段名。 */
export function summarizeStep(step: ParsedStep): StepSummary {
  const onFailure = '若前置缺失或已被别人处理，这一步不会写库，整张确认卡会被拒绝，已成功的步骤保留且如实回报'
  switch (step.action) {
    case 'screening_decide': {
      const result = isNonEmptyString(step.args.result) ? step.args.result : '对应结论'
      return {
        will_do: `记录初筛结论 ${result} 并附上理由`,
        affects: '影响这名候选人在本岗位的申请与后续流转',
        on_failure: onFailure,
      }
    }
    case 'candidate_constraint': {
      const kind = step.args.kind === 'HANDOFF' ? '下一轮交接提醒' : '置顶约束'
      return {
        will_do: `为这名候选人添加一条${kind}`,
        affects: '影响面试官与招聘同事看到的候选人提醒与后续面试交接',
        on_failure: onFailure,
      }
    }
    case 'interview_schedule': {
      const intent = step.args.intent === undefined ? 'CREATE' : step.args.intent
      const verb = intent === 'CANCEL' ? '取消面试安排'
        : intent === 'RESCHEDULE' ? '改期面试安排'
          : intent === 'WITHDRAW_INTERVIEWER' ? '撤回面试官参与'
            : '创建面试安排'
      return {
        will_do: `为这名候选人${verb}`,
        affects: '影响候选人与面试官的日程通知以及本岗位的面试进度',
        on_failure: onFailure,
      }
    }
  }
}

/** 稳定序列化：对象键递归排序，数组保序。 */
function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableSerialize(obj[k])}`).join(',')}}`
}

/** 对确认文案 + 步骤（action/args）做确定性 sha256，返回 64 位 hex。 */
export function fingerprintOf(confirmation_text: string, steps: readonly ParsedStep[]): string {
  const payload = stableSerialize({
    confirmation_text,
    steps: steps.map((s) => ({ step: s.step, action: s.action, args: s.args })),
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
