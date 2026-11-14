// 事件 → 业务对象 → Task 的**确定性路由规则**（纯函数，不碰数据库）。
//
// 来源：Notion `04` §10「两条事件处理路径不能混为一谈」：
//   * 确定性事件路径：已登记为 `DETERMINISTIC` 的事件类型（见 `event-types.ts`）
//     直接按事件类型 + 业务状态执行，不需要每个事件都先让模型判断"要不要接单"；
//   * 语义准入路径：自然语言 / 未明确指向业务动作的信号，先过**确定性 Gate**，
//     再由 Router / Assessor 判断意图、重复性和是否需要人确认。
//
// ⚠️ 本文件**不再**手抄第二份事件名表（2026-11-14 的缺陷就出在这里：路由表写的是
// `resume_received` 这类**没有发射方**的旧名，而工具发的是 `resume.intake.received`，
// 于是 40 条真实事件全部被语义 Gate 拒掉）。确定性路由表与显式忽略表都由
// `EVENT_TYPE_REGISTRY` **派生**：登记表是唯一权威，这里只负责"把登记翻译成结论"。
//
// 本文件只负责"确定性地把事件落到哪个 Task 类型 / 哪个业务对象"；真正的语义判断
// 不在这里伪造——语义事件只落一个 `ROUTER_TRIAGE` Task，且该 Task 不自动派发
// Worker（见 task-runtime.ts 的 dispatch 过滤），等 Router 决定。
import { createHash } from 'node:crypto'
import { isUuidText } from '../db/pool.ts'
import {
  EVENT_TYPE_REGISTRY,
  eventTypeRegistration,
  normalizeEventType,
} from './event-types.ts'
import type {
  BusinessObjectRef,
  BusinessObjectType,
  InboundEvent,
  RouteDecision,
} from './types.ts'

/** 路由模板：事件类型 → 任务类型 + 业务对象类型。 */
export interface RouteTemplate {
  readonly taskType: string
  readonly title: string
  readonly priority: number
  readonly objectType: BusinessObjectType
  /** 从 payload 里按顺序找业务对象 id 的候选字段名。 */
  readonly idFields: readonly string[]
  /** payload 里没有对象 id 时，按事件行事实反查的对象类型（当前只有 INTAKE_RECORD）。 */
  readonly byEventRow: 'INTAKE_RECORD' | null
}

/**
 * 确定性事件表（**从注册表派生，不手抄**）。
 *
 * 键是规范化后的事件类型（小写、`-` → `_`）；每个 `DETERMINISTIC` 登记项恰好一个键。
 * 想加一个确定性事件类型 → 去 `event-types.ts` 登记，不要在这里加字符串。
 */
export const DETERMINISTIC_ROUTES: Readonly<Record<string, RouteTemplate>> = buildDeterministicRoutes()

function buildDeterministicRoutes(): Record<string, RouteTemplate> {
  const routes: Record<string, RouteTemplate> = {}
  for (const definition of EVENT_TYPE_REGISTRY) {
    if (definition.routing.kind !== 'DETERMINISTIC') continue
    const { routing } = definition
    routes[normalizeEventType(definition.type)] = {
      taskType: routing.taskType,
      title: routing.title,
      priority: routing.priority,
      objectType: routing.object.type,
      idFields: routing.object.fields,
      byEventRow: routing.object.byEventRow,
    }
  }
  return routes
}

/** 语义准入的确定性 Gate 结果。 */
export interface SemanticGateResult {
  readonly admitted: boolean
  readonly reason: string
}

/**
 * 语义准入的确定性 Gate（**不是**模型判断）。
 *
 * 规则刻意保守（本次修复一个字都没放宽）：
 *   1. 只有 INTERNAL 信任级别的事件才允许进入语义准入（外部未验源文本不能
 *      直接生成工作）；
 *   2. 事件类型必须显式声明为语义候选（`semantic.*` / `router.*`），或者
 *      payload 带非空 `intent` 字段——"随便一个未知类型"不等于"语义候选"；
 *   3. 其余一律拒绝，并给出可读原因（落 `event_inbox.route_error`），
 *      让运维能看出是 Gate 拒了，而不是运行时坏了。
 * 通过 Gate 后仍只创建 `ROUTER_TRIAGE` 任务，由 Router（主 Agent）判断是否需要
 * 授权与 Mandate；本运行时不会自动把它派给 Worker。
 *
 * **已登记的类型不经过这个 Gate**：它们要么被确定性路由，要么被显式登记为 IGNORED
 * （带原因）。因此"已知事件落到语义 Gate"不再是可能路径——那正是旧缺陷的隐身方式。
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
export { normalizeEventType } from './event-types.ts'

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
 * @param resolvedObject - 调用方按**事件行事实**解析出的业务对象（payload 里没有 id 时用；
 *   例如 `resume.intake.received` → `intake_record.event_id`）。**不猜**：没解析到就传 null。
 * @returns 确定性路由 / 语义准入 / 忽略。
 */
export function decideRoute(
  event: InboundEvent,
  gate: DefaultSemanticGate = new DefaultSemanticGate(),
  resolvedObject: BusinessObjectRef | null = null,
): RouteDecision {
  const type = normalizeEventType(event.eventType)
  const registration = eventTypeRegistration(type)

  // ① 已登记：登记表已经裁决过，不再问 Gate。
  if (registration !== null) {
    if (registration.routing.kind === 'IGNORED') {
      return { kind: 'ignored', reason: `REGISTERED_IGNORED: ${registration.routing.reason}` }
    }
    const template = DETERMINISTIC_ROUTES[type]
    if (template === undefined) {
      // 不可达：DETERMINISTIC_ROUTES 由同一份注册表派生。
      throw new Error(`ROUTE_TABLE_OUT_OF_SYNC: ${type} is registered DETERMINISTIC but has no route template`)
    }
    const businessObject = resolveBusinessObject(event, template.objectType, template.idFields)
      ?? (template.byEventRow === null ? null : resolvedObject)
    if (businessObject === null) {
      const looked = template.byEventRow === null
        ? ''
        : `; event-row lookup ${template.byEventRow} also found no object for this event`
      return {
        kind: 'ignored',
        reason: `BUSINESS_OBJECT_NOT_FOUND: deterministic event ${type} carries no valid ${template.objectType} id`
          + ` (looked for ${template.idFields.join(', ')}${looked})`,
      }
    }
    if (businessObject.type !== template.objectType) {
      // 防"解析到 A 却按 B 建任务"：类型必须与登记一致。
      return {
        kind: 'ignored',
        reason: `BUSINESS_OBJECT_TYPE_MISMATCH: deterministic event ${type} needs ${template.objectType} but resolved ${businessObject.type}`,
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

  // ② 未登记：外部未知信号走语义准入 Gate（准入规则未放宽）。
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
