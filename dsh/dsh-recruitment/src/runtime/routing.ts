// 事件 → 业务对象 → Task 的**确定性路由规则**（纯函数，不碰数据库）。
//
// 来源：Notion `04` §10「两条事件处理路径不能混为一谈」：
//   * 确定性事件路径：已知类型（resume_received / transcript_ready /
//     scorecard_submitted / application_stage_entered）直接按事件类型 + 业务状态
//     执行，不需要每个事件都先让模型判断"要不要接单"；
//   * 语义准入路径：自然语言 / 未明确指向业务动作的信号，先过**确定性 Gate**，
//     再由 Router / Assessor 判断意图、重复性和是否需要人确认。
//
// 本文件只负责"确定性地把事件落到哪个 Task 类型 / 哪个业务对象"；真正的
// 语义判断不在这里伪造——语义事件只落一个 `ROUTER_TRIAGE` Task，且该 Task
// 不自动派发 Worker（见 task-runtime.ts 的 dispatch 过滤），等 Router 决定。
import { createHash } from 'node:crypto'
import { isUuidText } from '../db/pool.ts'
import type {
  BusinessObjectRef,
  BusinessObjectType,
  InboundEvent,
  RouteDecision,
} from './types.ts'

/** 路由模板：事件类型 → 任务类型 + 业务对象类型。 */
interface RouteTemplate {
  readonly taskType: string
  readonly title: string
  readonly priority: number
  readonly objectType: BusinessObjectType
  /** 从 payload 里按顺序找业务对象 id 的候选字段名。 */
  readonly idFields: readonly string[]
}

/**
 * 确定性事件表。
 *
 * 键是**规范化后的事件类型**（小写、`-` → `_`）；同一业务事实的多种命名
 * （平台原名 / 内部标准名）可以并列，但必须指向同一个模板，避免同一事件
 * 因为命名不同落成两个 Task。
 */
const DETERMINISTIC_ROUTES: Readonly<Record<string, RouteTemplate>> = {
  // S6 接入：新简历到达 → 解析 / 结构化（不是"让模型决定要不要解析"）
  'resume_received': {
    taskType: 'RESUME_PARSE', title: '解析新收到的简历', priority: 2,
    objectType: 'APPLICATION', idFields: ['application_id', 'business_object_id'],
  },
  'application_resume_received': {
    taskType: 'RESUME_PARSE', title: '解析新收到的简历', priority: 2,
    objectType: 'APPLICATION', idFields: ['application_id', 'business_object_id'],
  },
  'intake_resume_received': {
    taskType: 'RESUME_PARSE', title: '解析新收到的简历', priority: 2,
    objectType: 'APPLICATION', idFields: ['application_id', 'business_object_id'],
  },
  // S9 面试材料：转写就绪 → 拉取 / 标准化（事件回调里不做下载与 LLM）
  'transcript_ready': {
    taskType: 'TRANSCRIPT_FETCH', title: '拉取并标准化面试转写', priority: 2,
    objectType: 'TRANSCRIPT_ARTIFACT', idFields: ['transcript_artifact_id', 'artifact_id', 'business_object_id'],
  },
  'meeting_transcript_ready': {
    taskType: 'TRANSCRIPT_FETCH', title: '拉取并标准化面试转写', priority: 2,
    objectType: 'TRANSCRIPT_ARTIFACT', idFields: ['transcript_artifact_id', 'artifact_id', 'business_object_id'],
  },
  // S10 评价汇合：面评提交 → 汇总（每份 Scorecard 都触发一次汇合尝试）
  'scorecard_submitted': {
    taskType: 'EVALUATION_SYNTHESIZE', title: '汇总面试评价', priority: 3,
    objectType: 'INTERVIEW', idFields: ['interview_id', 'business_object_id'],
  },
  // 阶段进入 → 该阶段的确定性工作流（v1.0 只登记 Task，由 Worker 按类型执行）
  'application_stage_entered': {
    taskType: 'APPLICATION_STAGE_WORKFLOW', title: '推进申请阶段工作流', priority: 3,
    objectType: 'APPLICATION', idFields: ['application_id', 'business_object_id'],
  },
  // S8 排期完成 → 面试准备材料
  'interview_scheduled': {
    taskType: 'INTERVIEW_PREPARE', title: '准备面试材料', priority: 3,
    objectType: 'INTERVIEW', idFields: ['interview_id', 'business_object_id'],
  },
  // 候选人回复 → 跟进（语义内容是候选人写的，但"有回复要跟进"是确定性事实）
  'candidate_reply': {
    taskType: 'CANDIDATE_FOLLOWUP', title: '处理候选人回复', priority: 3,
    objectType: 'APPLICATION', idFields: ['application_id', 'business_object_id'],
  },
}

/** 语义准入的确定性 Gate 结果。 */
export interface SemanticGateResult {
  readonly admitted: boolean
  readonly reason: string
}

/**
 * 语义准入的确定性 Gate（**不是**模型判断）。
 *
 * 规则刻意保守：
 *   1. 只有 INTERNAL 信任级别的事件才允许进入语义准入（外部未验源文本不能
 *      直接生成工作）；
 *   2. 事件类型必须显式声明为语义候选（`semantic.*` / `router.*`），或者
 *      payload 带非空 `intent` 字段——"随便一个未知类型"不等于"语义候选"；
 *   3. 其余一律拒绝，并给出可读原因（落 `event_inbox.route_error`），
 *      让运维能看出是 Gate 拒了，而不是运行时坏了。
 * 通过 Gate 后仍只创建 `ROUTER_TRIAGE` 任务，由 Router（主 Agent）判断是否需要
 * 授权与 Mandate；本运行时不会自动把它派给 Worker。
 */
export class DefaultSemanticGate {
  admit(event: InboundEvent): SemanticGateResult {
    if (event.trustLevel !== 'INTERNAL') {
      return { admitted: false, reason: 'SEMANTIC_GATE_REJECTED: trust_level is not INTERNAL' }
    }
    const type = normalizeEventType(event.eventType)
    const declared = type.startsWith('semantic_') || type.startsWith('router_')
    const intent = typeof event.payload.intent === 'string' && event.payload.intent.trim() !== ''
    if (!declared && !intent) {
      return { admitted: false, reason: 'SEMANTIC_GATE_REJECTED: event type is not declared semantic and payload.intent is empty' }
    }
    return { admitted: true, reason: declared ? `declared semantic event (${type})` : 'payload.intent supplied' }
  }
}

/** 事件类型的规范化：小写、`-`/空格 → `_`，去掉首尾空白。 */
export function normalizeEventType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/** 稳定幂等键：有 provider 事件 ID 用它；没有则必须绑 source_object_id + 内容哈希。 */
export function idempotencyFor(event: InboundEvent): { key: string; source: 'PROVIDER_EVENT_ID' | 'FALLBACK_KEY' } {
  if (typeof event.providerEventId === 'string' && event.providerEventId.trim() !== '') {
    return {
      key: `${event.provider}:${event.providerEventId.trim()}`,
      source: 'PROVIDER_EVENT_ID',
    }
  }
  if (typeof event.sourceObjectId !== 'string' || event.sourceObjectId.trim() === '') {
    // 0001 的 ck_event_inbox_fallback_object：没有事件 ID 时必须绑真实对象 ID。
    throw new Error('INVALID_EVENT: providerEventId is absent and sourceObjectId is empty (fallback key must bind a real object)')
  }
  const hash = createHash('sha256').update(canonicalJson(event.payload)).digest('hex')
  return {
    key: `${event.provider}:fallback:${event.sourceObjectId.trim()}:${normalizeEventType(event.eventType)}:${hash}`,
    source: 'FALLBACK_KEY',
  }
}

/** 稳定 JSON：对象键排序、数组保序（只用于哈希，不用于展示）。 */
export function canonicalJson(value: unknown): string {
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk)
    if (item !== null && typeof item === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(item as Record<string, unknown>).sort()) {
        out[key] = walk((item as Record<string, unknown>)[key])
      }
      return out
    }
    return item
  }
  return JSON.stringify(walk(value))
}

/**
 * 从 payload 里解析业务对象；解析不出返回 `null`（不猜、不编造 ID）。
 * 显式的 `business_object_type` + `business_object_id` 优先于按类型的字段名。
 */
export function resolveBusinessObject(
  event: InboundEvent,
  objectType: BusinessObjectType,
  idFields: readonly string[],
): BusinessObjectRef | null {
  const explicitType = event.payload.business_object_type
  const explicitId = event.payload.business_object_id
  if (explicitType === objectType && typeof explicitId === 'string' && isUuidText(explicitId)) {
    return { type: objectType, id: explicitId }
  }
  for (const field of idFields) {
    const value = event.payload[field]
    if (typeof value === 'string' && isUuidText(value)) return { type: objectType, id: value }
  }
  if (typeof event.sourceObjectId === 'string' && isUuidText(event.sourceObjectId)) {
    return { type: objectType, id: event.sourceObjectId }
  }
  return null
}

/**
 * 决定一个事件走哪条路径。
 * @param event - 已通过 envelope 校验的事件。
 * @param gate - 语义准入 Gate（默认 `DefaultSemanticGate`）。
 * @returns 确定性路由 / 语义准入 / 忽略。
 */
export function decideRoute(event: InboundEvent, gate: DefaultSemanticGate = new DefaultSemanticGate()): RouteDecision {
  const type = normalizeEventType(event.eventType)
  const template = DETERMINISTIC_ROUTES[type]
  if (template !== undefined) {
    const businessObject = resolveBusinessObject(event, template.objectType, template.idFields)
    if (businessObject === null) {
      return {
        kind: 'ignored',
        reason: `BUSINESS_OBJECT_NOT_FOUND: deterministic event ${type} carries no valid ${template.objectType} id (looked for ${template.idFields.join(', ')})`,
      }
    }
    return {
      kind: 'deterministic',
      taskType: template.taskType,
      taskTitle: template.title,
      priority: template.priority,
      businessObject,
    }
  }
  const verdict = gate.admit(event)
  if (!verdict.admitted) return { kind: 'ignored', reason: verdict.reason }
  return {
    kind: 'semantic',
    taskType: 'ROUTER_TRIAGE',
    taskTitle: 'Router 语义准入：判断是否需要创建业务任务',
    priority: 4,
    reason: verdict.reason,
  }
}

/**
 * Business Task 的稳定幂等键。
 *
 * 确定性路径按**业务对象 + 任务类型**稳定：同一申请的第二份简历到达时唤醒同一个
 * 解析 Task，而不是每份简历建一个（Notion §10「同一个 Event 可以更新既有 Task」）。
 * 语义路径按事件：每个候选事件一条 Triage Task，是否合并由 Router 决定。
 */
export function taskIdempotencyKey(decision: RouteDecision, eventId: string): string {
  if (decision.kind === 'deterministic') {
    return `task:${decision.taskType}:${decision.businessObject.type}:${decision.businessObject.id}`
  }
  if (decision.kind === 'semantic') return `task:ROUTER_TRIAGE:event:${eventId}`
  throw new Error(`no task for ignored event: ${decision.reason}`)
}

/** 哪些 Task 类型由 Router 自己判断、**不自动派发 Worker**（语义准入的边界）。 */
export const ROUTER_ONLY_TASK_TYPES: readonly string[] = ['ROUTER_TRIAGE']

/** 测试/证据可注册额外的确定性路由（生产不接受模型输入构造的规则）。 */
export function withExtraRoutes(
  routes: Readonly<Record<string, RouteTemplate>>,
): Readonly<Record<string, RouteTemplate>> {
  return { ...DETERMINISTIC_ROUTES, ...routes }
}
