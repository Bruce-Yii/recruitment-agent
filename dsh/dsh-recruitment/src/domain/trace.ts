// 执行追溯链（execution trace chain）：**一个 correlation_id 串起一次执行的所有事实**。
//
// 为什么需要这一层（缺口是真实存在的，不是"再包一层"）：
//   迁移 0001 建了 event_inbox / business_task / task_attempt / agent_session /
//   durable_effect / decision，但（2026-11-14 实测 ra_s6s7）：
//     * event_inbox 62 行，correlation_id **全部为 NULL** —— 列存在，没有写入方填；
//     * task_attempt / agent_session / durable_effect **各 0 行**（没有写入方）；
//     * **没有 tool_call 表** —— "某次工具调用"这一环结构上就不存在；
//     * decision 只有 application_id + actor，没有 correlation、没有来源事件指针。
//   于是"Event → Business Task → Task Attempt → Agent Session → Tool Call →
//   Durable Effect → External Receipt → 人工决策"这条链**从来没有真的串起来过**。
//
// 本文件负责三件事（都不改既有 19 个工具，也不碰 engine / runtime）：
//   1. **记录**：`recordToolCall` / `runTracedToolCall` 把一次真实工具调用落成
//      `recruitment.tool_call` 行（工具名 / 业务引用 / 结果分类 / 耗时 / 摘要），
//      并从业务对象的既有 correlation 继承同一个链 ID。
//   2. **查询**：`loadTrace` 给一个业务对象 id（或 correlation_id），按时间返回完整
//      执行链：每环带 ring / id / at / actor / state / refs。
//   3. **完整性**：`checkTraceIntegrity` 检出断链（有 decision 但没有来源事件 / 没有
//      对应 tool call、有 effect 但没有 receipt、挂在业务对象上却不在同一条链……），
//      并区分"断链（有父无子 / 有子无父）"与"该环在本次路径上根本没产生（gap）"。
//
// 三条硬约束：
//   * **R7：绝不返回候选人正文**。事件只取 `payload->>'actor_id'` 这类元数据，
//     不 SELECT payload 全文；decision 不返回 reason；材料只出现 sha256 与 id。
//   * **不伪造**：查询只返回库里真实存在的行；缺环就是缺环（gap / breakpoint），
//     不会为了让链路"看起来通"合成一行。
//   * **只读查询**：loadTrace / checkTraceIntegrity 只发 SELECT；
//     写路径只有 recordToolCall（append-only 的 tool_call）。
//
// 与迁移 0013 的分工：
//   0013 负责"字段 + 从真实父子链接继承 correlation"（event→application→interview→
//   scorecard、application→decision、event|refs→task→attempt→session、refs→effect）；
//   本文件负责"工具调用这一环"的写入与"整条链"的读取/校验。
//
// 已知边界（不掩盖）：
//   * 迁移前的历史行 correlation_id 为 NULL（不回填，不伪造历史）→ 查询如实报
//     `CHAIN_CORRELATION_MISSING`，不会给旧数据编一个新链 ID。
//   * business_task / task_attempt / agent_session / durable_effect 目前**没有产品写入方**
//     （只有 interview_schedule 会写 business_task）；所以真实业务链上这几环是 gap，
//     不是 break。本文件的 schema 级测试（test/integration/trace-chain.test.ts）用
//     夹具证明"一旦有行，同一个 correlation 能串起来"，与真实业务链的证据分开记账。
import { createHash, randomUUID } from 'node:crypto'

import { canonicalJson } from '../tools/contract.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

// ---------------------------------------------------------------------------
//  公共类型
// ---------------------------------------------------------------------------

/** 追溯入口对象类型（给业务对象 id 就能查；也支持直接给 correlation_id）。 */
export type TraceObjectType =
  | 'APPLICATION'
  | 'DECISION'
  | 'BUSINESS_TASK'
  | 'EVENT'
  | 'TOOL_CALL'
  | 'DURABLE_EFFECT'
  | 'CORRELATION'

/** 执行链上的环（顺序即文档 docs/03 §8 的五类事实 + 人工决策）。 */
export type TraceRingType =
  | 'APPLICATION'
  | 'INTERVIEW'
  | 'EVENT'
  | 'BUSINESS_TASK'
  | 'TASK_ATTEMPT'
  | 'AGENT_SESSION'
  | 'TOOL_CALL'
  | 'DURABLE_EFFECT'
  | 'RECEIPT'
  | 'DECISION'

/** 一条业务引用（tool_call.business_refs / trace 输出的 refs 用同一形状）。 */
export interface BusinessRef {
  readonly kind: string
  readonly id: string
}

/** 时间线上一环。所有键都是元数据，**没有候选人正文**（R7）。 */
export interface TraceRing {
  readonly ring: TraceRingType
  readonly id: string
  /** ISO-8601；该环没有可用时间时为 undefined（输出层省略键，不用 null 占位）。 */
  readonly at?: string
  readonly actor_id?: string
  readonly state?: string
  /** 业务引用（只含对象 id / 类型 / 业务键）。 */
  readonly refs?: Readonly<Record<string, unknown>>
  /** false = 这一行挂在业务对象上，但 correlation 与链不符（断链证据）。 */
  readonly on_chain: boolean
}

/** 断链点：有父无子 / 有子无父 / 挂在对象上却不在链上。 */
export interface TraceBreakpoint {
  readonly code: string
  /** 断点位置，如 `EVENT→DECISION` / `DECISION` / `CHAIN`。 */
  readonly at: string
  readonly detail: string
  readonly ring_id?: string
  readonly expected?: string
  readonly actual?: string
}

/** 缺环（不是断链）：该环在本次路径上**没有产生任何行**。 */
export interface TraceGap {
  readonly ring: TraceRingType
  readonly code: 'RING_NOT_PRODUCED'
  readonly detail: string
}

export interface TraceIntegrity {
  readonly ok: boolean
  readonly checked_rings: number
  readonly breakpoints: readonly TraceBreakpoint[]
  readonly gaps: readonly TraceGap[]
}

export interface TraceResult {
  readonly object: { readonly type: TraceObjectType; readonly id: string }
  readonly correlation_id?: string
  readonly legacy_without_correlation: boolean
  readonly rings: readonly TraceRing[]
  readonly counts: Readonly<Record<string, number>>
  readonly integrity: TraceIntegrity
  /** R7 自证：这份结果里没有任何正文。 */
  readonly redaction: {
    readonly candidate_text_included: false
    readonly payload_included: false
    readonly note: string
  }
}

/** 追溯的输入。 */
export interface TraceInput {
  readonly tenantId: string
  readonly objectType: TraceObjectType
  readonly objectId: string
}

// ---------------------------------------------------------------------------
//  内部行类型
// ---------------------------------------------------------------------------

interface ApplicationRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly current_stage_code: string
  readonly lifecycle_status: string
  readonly created_at: Date
}

interface InterviewRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly application_id: string
  readonly status: string
  readonly created_at: Date
}

interface EventRow {
  readonly event_id: string
  readonly correlation_id: string | null
  readonly causation_id: string | null
  readonly event_type: string
  readonly provider: string
  readonly trust_level: string
  readonly received_at: Date
  readonly recorded_at: Date
  readonly source_object_id: string | null
  readonly actor_id: string | null
}

interface TaskRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly task_type: string
  readonly status: string
  readonly business_refs: unknown
  readonly created_by_actor_id: string | null
  readonly created_at: Date
}

interface AttemptRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly task_id: string
  readonly status: string
  readonly worker_type: string
  readonly worker_id: string
  readonly claimed_at: Date
  readonly ended_at: Date | null
}

interface SessionRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly task_id: string | null
  readonly attempt_id: string | null
  readonly status: string
  readonly model_route: string
  readonly started_at: Date
  readonly ended_at: Date | null
}

interface ToolCallRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly call_ref: string
  readonly tool_name: string
  readonly outcome: string
  readonly error_code: string | null
  readonly actor_id: string | null
  readonly business_refs: unknown
  readonly started_at: Date
  readonly ended_at: Date | null
  readonly duration_ms: string | number | null
}

interface EffectRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly effect_type: string
  readonly status: string
  readonly sent_at: Date | null
  readonly confirmed_at: Date | null
  readonly last_readback_at: Date | null
  readonly readback_state: string | null
  readonly receipt_ref: string | null
  readonly external_id: string | null
  readonly business_refs: unknown
  readonly created_at: Date
}

interface DecisionRow {
  readonly id: string
  readonly correlation_id: string | null
  readonly application_id: string
  readonly interview_id: string | null
  readonly decision_scope: string
  readonly stage_code: string | null
  readonly result: string
  readonly decided_by_actor_id: string
  readonly decided_at: Date
  readonly causation_event_id: string | null
}

/** 挂在业务对象上（FK / business_refs）但 correlation 与链不符的行。 */
interface OffChainRow {
  readonly ring: TraceRingType
  readonly id: string
  readonly correlation_id: string | null
  readonly at: Date | null
  readonly state: string | null
  readonly via: string
}

/** 完整性检查的输入（纯数据，便于单测不连库）。 */
export interface TraceModel {
  readonly correlationId: string | null
  readonly applications: readonly ApplicationRow[]
  readonly interviews: readonly InterviewRow[]
  readonly events: readonly EventRow[]
  readonly tasks: readonly TaskRow[]
  readonly attempts: readonly AttemptRow[]
  readonly sessions: readonly SessionRow[]
  readonly toolCalls: readonly ToolCallRow[]
  readonly effects: readonly EffectRow[]
  readonly decisions: readonly DecisionRow[]
  readonly offChain: readonly OffChainRow[]
  readonly danglingRefs: readonly { readonly toolCallId: string; readonly kind: string; readonly id: string }[]
}

const RING_ORDER: Readonly<Record<TraceRingType, number>> = {
  APPLICATION: 0,
  EVENT: 10,
  INTERVIEW: 15,
  BUSINESS_TASK: 20,
  TASK_ATTEMPT: 21,
  AGENT_SESSION: 22,
  TOOL_CALL: 23,
  DURABLE_EFFECT: 24,
  RECEIPT: 25,
  DECISION: 30,
}

/** "该环没有行"时的如实说明（不是断链，是本轮路径没有产生）。 */
const GAP_NOTES: Readonly<Record<TraceRingType, string>> = {
  APPLICATION: '追溯入口本身就是申请（不会缺）',
  INTERVIEW: '该申请还没有面试（S8 未发生）',
  EVENT: '该链上没有事件行（不应该发生：correlation 由事件/申请生成）',
  BUSINESS_TASK: '该路径没有创建 Business Task（只有 interview_schedule 会写 business_task）',
  TASK_ATTEMPT: '没有 task_attempt 的写入方（当前产品无 Attempt 领取/执行路径）',
  AGENT_SESSION: '没有 agent_session 的写入方（当前产品无 Session 落库路径）',
  TOOL_CALL: '该链上没有记录工具调用（工具调用记录适配器未被调用）',
  DURABLE_EFFECT: '该路径没有外部副作用（intake / screening / decision 都不对外写）',
  RECEIPT: '没有 Durable Effect 就没有外部回执',
  DECISION: '该申请还没有人工决策',
}

const GAP_RINGS: readonly TraceRingType[] = [
  'BUSINESS_TASK',
  'TASK_ATTEMPT',
  'AGENT_SESSION',
  'TOOL_CALL',
  'DURABLE_EFFECT',
  'RECEIPT',
  'DECISION',
]

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

function toIso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

function asBusinessRefs(value: unknown): BusinessRef[] {
  if (!Array.isArray(value)) return []
  const refs: BusinessRef[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const kind = record.kind
    const id = record.id
    if (typeof kind === 'string' && typeof id === 'string' && id !== '') refs.push({ kind, id })
  }
  return refs
}

/** 从工具返回值里收集业务引用（只认已知键名 + UUID 形状，避免把普通字符串当引用）。 */
export function collectBusinessRefs(value: unknown, maxDepth = 5): BusinessRef[] {
  const found = new Map<string, BusinessRef>()
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const keyToKind: Readonly<Record<string, string>> = {
    application_id: 'APPLICATION',
    decision_id: 'DECISION',
    interview_id: 'INTERVIEW',
    business_task_id: 'BUSINESS_TASK',
    task_id: 'BUSINESS_TASK',
    attempt_id: 'TASK_ATTEMPT',
    agent_session_id: 'AGENT_SESSION',
    correlation_id: 'CORRELATION',
  }
  const parentToKind: Readonly<Record<string, string>> = {
    decision: 'DECISION',
    application: 'APPLICATION',
    interview: 'INTERVIEW',
    business_task: 'BUSINESS_TASK',
    task: 'BUSINESS_TASK',
    attempt: 'TASK_ATTEMPT',
    agent_session: 'AGENT_SESSION',
    tool_call: 'TOOL_CALL',
    durable_effect: 'DURABLE_EFFECT',
  }
  const visit = (node: unknown, depth: number, parentKey: string | undefined): void => {
    if (depth > maxDepth || node === null || node === undefined) return
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 50)) visit(item, depth + 1, parentKey)
      return
    }
    if (typeof node !== 'object') return
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (typeof child === 'string' && uuidRe.test(child)) {
        const kind = keyToKind[key] ?? (key === 'id' && parentKey !== undefined ? parentToKind[parentKey] : undefined)
        if (kind !== undefined) found.set(`${kind}:${child}`, { kind, id: child })
      }
      visit(child, depth + 1, key)
    }
  }
  visit(value, 0, undefined)
  return [...found.values()]
}

/** sha256(canonicalJson(v))；非 JSON 值退化成 String(v) 后再哈希（绝不落原文）。 */
export function safeDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined
  let text: string
  try {
    text = canonicalJson(value)
  } catch {
    try {
      text = String(value)
    } catch {
      return undefined
    }
  }
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
//  1. 查询：给对象 id / correlation id，返回整条链
// ---------------------------------------------------------------------------

/** 追溯失败（对象不存在 / 类型不合法）。工具层翻成契约错误。 */
export class TraceQueryError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID_ARGS'

  constructor(code: 'NOT_FOUND' | 'INVALID_ARGS', message: string) {
    super(message)
    this.name = 'TraceQueryError'
    this.code = code
  }
}

async function resolveRootCorrelation(
  client: DatabaseClient,
  input: TraceInput,
): Promise<{ correlationId: string | null; objectFound: boolean; applicationIds: string[] }> {
  const { tenantId, objectType, objectId } = input
  switch (objectType) {
    case 'CORRELATION':
      return { correlationId: objectId, objectFound: true, applicationIds: [] }
    case 'APPLICATION': {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        'select correlation_id from recruitment.application where id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [objectId] }
    }
    case 'DECISION': {
      const { rows } = await client.query<{ correlation_id: string | null; application_id: string }>(
        'select correlation_id, application_id from recruitment.decision where id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [row.application_id] }
    }
    case 'BUSINESS_TASK': {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        'select correlation_id from recruitment.business_task where id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [] }
    }
    case 'EVENT': {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        'select correlation_id from recruitment.event_inbox where event_id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [] }
    }
    case 'TOOL_CALL': {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        'select correlation_id from recruitment.tool_call where id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [] }
    }
    case 'DURABLE_EFFECT': {
      const { rows } = await client.query<{ correlation_id: string | null }>(
        'select correlation_id from recruitment.durable_effect where id = $1 and tenant_id = $2',
        [objectId, tenantId],
      )
      const row = rows[0]
      return row === undefined
        ? { correlationId: null, objectFound: false, applicationIds: [] }
        : { correlationId: row.correlation_id, objectFound: true, applicationIds: [] }
    }
    default:
      throw new TraceQueryError('INVALID_ARGS', `不支持的追溯对象类型：${String(objectType)}`)
  }
}

/**
 * 读出整条链的模型（只发 SELECT）。
 * @param client - 事务内客户端（调用方负责只读事务）。
 * @param input - 租户 + 对象类型 + 对象 id。
 */
export async function loadTraceModel(client: DatabaseClient, input: TraceInput): Promise<{
  readonly model: TraceModel
  readonly object: { readonly type: TraceObjectType; readonly id: string }
}> {
  const root = await resolveRootCorrelation(client, input)
  if (!root.objectFound) {
    throw new TraceQueryError('NOT_FOUND', `该租户下没有 ${input.objectType} ${input.objectId}`)
  }
  const c = root.correlationId
  const tenant = input.tenantId
  const empty = c === null

  const applications = empty ? [] : (await client.query<ApplicationRow>(
    `select id, correlation_id, current_stage_code, lifecycle_status, created_at
       from recruitment.application
      where tenant_id = $1 and correlation_id = $2
      order by created_at`,
    [tenant, c],
  )).rows

  const interviews = empty ? [] : (await client.query<InterviewRow>(
    `select id, correlation_id, application_id, status, created_at
       from recruitment.interview
      where tenant_id = $1 and correlation_id = $2
      order by created_at`,
    [tenant, c],
  )).rows

  // R7：**不 SELECT payload 全文**，只取内部事件的 actor_id 这类元数据。
  const events = empty ? [] : (await client.query<EventRow>(
    `select event_id, correlation_id, causation_id, event_type, provider, trust_level,
            received_at, recorded_at, source_object_id,
            case when jsonb_typeof(payload) = 'object' then payload ->> 'actor_id' end as actor_id
       from recruitment.event_inbox
      where tenant_id = $1 and correlation_id = $2
      order by recorded_at, event_id
      limit 500`,
    [tenant, c],
  )).rows

  const tasks = empty ? [] : (await client.query<TaskRow>(
    `select id, correlation_id, task_type, status, business_refs, created_by_actor_id, created_at
       from recruitment.business_task
      where tenant_id = $1 and correlation_id = $2
      order by created_at`,
    [tenant, c],
  )).rows

  const attempts = empty ? [] : (await client.query<AttemptRow>(
    `select id, correlation_id, task_id, status, worker_type, worker_id, claimed_at, ended_at
       from recruitment.task_attempt
      where tenant_id = $1 and correlation_id = $2
      order by claimed_at`,
    [tenant, c],
  )).rows

  const sessions = empty ? [] : (await client.query<SessionRow>(
    `select id, correlation_id, task_id, attempt_id, status, model_route, started_at, ended_at
       from recruitment.agent_session
      where tenant_id = $1 and correlation_id = $2
      order by started_at`,
    [tenant, c],
  )).rows

  const toolCalls = empty ? [] : (await client.query<ToolCallRow>(
    `select id, correlation_id, call_ref, tool_name, outcome, error_code, actor_id,
            business_refs, started_at, ended_at, duration_ms
       from recruitment.tool_call
      where tenant_id = $1 and correlation_id = $2
      order by started_at, id`,
    [tenant, c],
  )).rows

  const effects = empty ? [] : (await client.query<EffectRow>(
    `select id, correlation_id, effect_type, status, sent_at, confirmed_at, last_readback_at,
            readback_state, receipt_ref, external_id, business_refs, created_at
       from recruitment.durable_effect
      where tenant_id = $1 and correlation_id = $2
      order by created_at`,
    [tenant, c],
  )).rows

  // R7：不返回 decision.reason（人工理由可能含候选人信息），只返回结构化结果。
  const decisions = empty ? [] : (await client.query<DecisionRow>(
    `select id, correlation_id, application_id, interview_id, decision_scope, stage_code,
            result, decided_by_actor_id, decided_at, causation_event_id
       from recruitment.decision
      where tenant_id = $1 and correlation_id = $2
      order by decided_at`,
    [tenant, c],
  )).rows

  // 挂在业务对象上、但 correlation 与链不符的行（断链证据；只对申请入口做，避免全库扫）。
  const offChain: OffChainRow[] = []
  if (!empty && root.applicationIds.length > 0) {
    const appIds = root.applicationIds
    for (const row of (await client.query<DecisionRow>(
      `select id, correlation_id, application_id, interview_id, decision_scope, stage_code,
              result, decided_by_actor_id, decided_at, causation_event_id
         from recruitment.decision
        where tenant_id = $1 and application_id = any($2::uuid[])
          and correlation_id is distinct from $3
        order by decided_at`,
      [tenant, appIds, c],
    )).rows) {
      offChain.push({
        ring: 'DECISION',
        id: row.id,
        correlation_id: row.correlation_id,
        at: row.decided_at,
        state: `${row.decision_scope}:${row.stage_code ?? '-'}:${row.result}`,
        via: `decision.application_id=${row.application_id}`,
      })
    }
    for (const row of (await client.query<InterviewRow>(
      `select id, correlation_id, application_id, status, created_at
         from recruitment.interview
        where tenant_id = $1 and application_id = any($2::uuid[])
          and correlation_id is distinct from $3
        order by created_at`,
      [tenant, appIds, c],
    )).rows) {
      offChain.push({
        ring: 'INTERVIEW', id: row.id, correlation_id: row.correlation_id,
        at: row.created_at, state: row.status, via: `interview.application_id=${row.application_id}`,
      })
    }
    // 材料链根事件：申请 → resume_version → resume → asset → record → event。
    for (const row of (await client.query<EventRow>(
      `select e.event_id, e.correlation_id, e.causation_id, e.event_type, e.provider, e.trust_level,
              e.received_at, e.recorded_at, e.source_object_id,
              case when jsonb_typeof(e.payload) = 'object' then e.payload ->> 'actor_id' end as actor_id
         from recruitment.application a
         join recruitment.resume_version rv
           on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
         join recruitment.resume r
           on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
         join recruitment.intake_asset ia
           on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
         join recruitment.intake_record ir
           on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
         join recruitment.event_inbox e
           on e.event_id = ir.event_id and e.tenant_id = ir.tenant_id
        where a.tenant_id = $1 and a.id = any($2::uuid[])
          and e.correlation_id is distinct from $3
        order by e.recorded_at`,
      [tenant, appIds, c],
    )).rows) {
      offChain.push({
        ring: 'EVENT', id: row.event_id, correlation_id: row.correlation_id,
        at: row.recorded_at, state: row.event_type, via: 'application.resume_version 材料链',
      })
    }
    // 工具调用：business_refs 指向该申请、但不在同一条链上。
    for (const row of (await client.query<ToolCallRow>(
      `select id, correlation_id, call_ref, tool_name, outcome, error_code, actor_id,
              business_refs, started_at, ended_at, duration_ms
         from recruitment.tool_call
        where tenant_id = $1 and correlation_id is distinct from $2
          and business_refs @> $3::jsonb
        order by started_at`,
      [tenant, c, JSON.stringify(appIds.map((id) => ({ kind: 'APPLICATION', id })))],
    )).rows) {
      offChain.push({
        ring: 'TOOL_CALL', id: row.id, correlation_id: row.correlation_id,
        at: row.started_at, state: row.outcome, via: 'tool_call.business_refs APPLICATION',
      })
    }
  }

  // tool_call 的业务引用是否指向真实存在的对象（悬挂引用 = 断链）。
  const danglingRefs: { toolCallId: string; kind: string; id: string }[] = []
  for (const call of toolCalls) {
    for (const ref of asBusinessRefs(call.business_refs)) {
      if (ref.kind === 'CORRELATION') continue
      const sql = {
        APPLICATION: 'select 1 from recruitment.application where id = $1 and tenant_id = $2',
        DECISION: 'select 1 from recruitment.decision where id = $1 and tenant_id = $2',
        INTERVIEW: 'select 1 from recruitment.interview where id = $1 and tenant_id = $2',
        BUSINESS_TASK: 'select 1 from recruitment.business_task where id = $1 and tenant_id = $2',
        TASK_ATTEMPT: 'select 1 from recruitment.task_attempt where id = $1 and tenant_id = $2',
        AGENT_SESSION: 'select 1 from recruitment.agent_session where id = $1 and tenant_id = $2',
        TOOL_CALL: 'select 1 from recruitment.tool_call where id = $1 and tenant_id = $2',
        DURABLE_EFFECT: 'select 1 from recruitment.durable_effect where id = $1 and tenant_id = $2',
      }[ref.kind]
      if (sql === undefined) continue
      const { rowCount } = await client.query(sql, [ref.id, tenant])
      if ((rowCount ?? 0) === 0) danglingRefs.push({ toolCallId: call.id, kind: ref.kind, id: ref.id })
    }
  }

  return {
    object: { type: input.objectType, id: input.objectId },
    model: {
      correlationId: c,
      applications,
      interviews,
      events,
      tasks,
      attempts,
      sessions,
      toolCalls,
      effects,
      decisions,
      offChain,
      danglingRefs,
    },
  }
}

// ---------------------------------------------------------------------------
//  2. 完整性检查（纯函数：单测不需要库）
// ---------------------------------------------------------------------------

/**
 * 检出断链。
 *
 * 判定口径（刻意区分"断"与"缺"）：
 *   * breakpoint = **两环之间有证据但接不上**：有子无父、有父无子、挂在对象上却不在同一条链、
 *     引用指向不存在的行。OK=false。
 *   * gap = 该环在本次路径上**一行都没有**（产品还没有写入方 / 本轮没发生）。OK 不受影响。
 * @param model - loadTraceModel 读出的数据（或单测构造的等价数据）。
 */
export function checkTraceIntegrity(model: TraceModel): TraceIntegrity {
  const breakpoints: TraceBreakpoint[] = []
  const gaps: TraceGap[] = []
  const eventIds = new Set(model.events.map((row) => row.event_id))
  const taskIds = new Set(model.tasks.map((row) => row.id))
  const applicationIds = new Set(model.applications.map((row) => row.id))

  if (model.correlationId === null) {
    breakpoints.push({
      code: 'CHAIN_CORRELATION_MISSING',
      at: 'CHAIN',
      detail: '该业务对象没有 correlation_id（迁移前的历史行）——追溯链无法成立，不伪造链 ID',
    })
  }

  for (const row of model.offChain) {
    breakpoints.push({
      code: 'LINKED_ROW_OFF_CHAIN',
      at: `${row.ring}→CHAIN`,
      detail: `${row.ring} ${row.id} 通过 ${row.via} 挂在本对象上，但 correlation 与本链不一致`,
      ring_id: row.id,
      ...(model.correlationId === null ? {} : { expected: model.correlationId }),
      ...(row.correlation_id === null ? {} : { actual: row.correlation_id }),
    })
  }

  for (const decision of model.decisions) {
    if (decision.causation_event_id === null || !eventIds.has(decision.causation_event_id)) {
      breakpoints.push({
        code: 'DECISION_WITHOUT_CAUSE_EVENT',
        at: 'EVENT→DECISION',
        detail: '这一环有人工决策，但找不到它的来源事件（decision.record 事件缺链）',
        ring_id: decision.id,
      })
    }
    // "有 decision 但找不到对应的 tool call"：判定口径 = 链上没有任何 tool_call 的
    // business_refs 直接指向这条 decision。只认直接引用（REF kind=DECISION, id=decision.id），
    // 因为同一申请可能有多条决策，按 application_id 猜会把后一条决策"继承"到前一条的调用上。
    const hasToolCall = model.toolCalls.some((call) =>
      asBusinessRefs(call.business_refs).some((ref) => ref.kind === 'DECISION' && ref.id === decision.id))
    if (!hasToolCall) {
      breakpoints.push({
        code: 'DECISION_WITHOUT_TOOL_CALL',
        at: 'TOOL_CALL→DECISION',
        detail: '这一环有人工决策，但链上找不到产生它的工具调用（可能是绕过工具直接写库）',
        ring_id: decision.id,
      })
    }
  }

  for (const effect of model.effects) {
    const hasReceipt = effect.receipt_ref !== null || effect.external_id !== null
      || (effect.confirmed_at !== null && effect.readback_state === 'MATCH')
    if (effect.status === 'CONFIRMED' && !hasReceipt) {
      breakpoints.push({
        code: 'EFFECT_WITHOUT_RECEIPT',
        at: 'EFFECT→RECEIPT',
        detail: 'Durable Effect 已 CONFIRMED，但没有 receipt_ref / external_id 可以证明外部真的完成',
        ring_id: effect.id,
      })
    }
  }

  for (const call of model.toolCalls) {
    const refs = asBusinessRefs(call.business_refs)
    if (refs.length === 0) {
      breakpoints.push({
        code: 'TOOL_CALL_WITHOUT_BUSINESS_REF',
        at: 'TOOL_CALL',
        detail: '工具调用没有业务引用，无法归到任何业务对象上',
        ring_id: call.id,
      })
    }
  }
  for (const ref of model.danglingRefs) {
    breakpoints.push({
      code: 'TOOL_CALL_DANGLING_REF',
      at: 'TOOL_CALL→BUSINESS',
      detail: `工具调用的业务引用指向不存在的行：${ref.kind} ${ref.id}`,
      ring_id: ref.toolCallId,
    })
  }

  for (const session of model.sessions) {
    if (session.task_id === null && session.attempt_id === null) {
      breakpoints.push({
        code: 'AGENT_SESSION_UNATTRIBUTED',
        at: 'AGENT_SESSION',
        detail: 'Agent Session 既不属于 Task 也不属于 Attempt（执行归属丢失）',
        ring_id: session.id,
      })
    } else if (session.task_id !== null && !taskIds.has(session.task_id) && model.tasks.length > 0) {
      breakpoints.push({
        code: 'AGENT_SESSION_TASK_OFF_CHAIN',
        at: 'BUSINESS_TASK→AGENT_SESSION',
        detail: 'Agent Session 指向的 Task 不在本链上',
        ring_id: session.id,
      })
    }
  }

  for (const attempt of model.attempts) {
    if (model.tasks.length > 0 && !taskIds.has(attempt.task_id)) {
      breakpoints.push({
        code: 'ATTEMPT_TASK_OFF_CHAIN',
        at: 'BUSINESS_TASK→TASK_ATTEMPT',
        detail: 'Task Attempt 指向的 Task 不在本链上',
        ring_id: attempt.id,
      })
    }
  }

  // 申请入口：链上必须能定位到申请（否则"从业务对象追溯"断了根）。
  if (model.applications.length === 0 && applicationIds.size === 0 && model.decisions.length > 0) {
    for (const decision of model.decisions) {
      if (!applicationIds.has(decision.application_id)) {
        breakpoints.push({
          code: 'DECISION_APPLICATION_OFF_CHAIN',
          at: 'APPLICATION→DECISION',
          detail: '决策指向的申请不在本链上（申请行 correlation 缺失或不同）',
          ring_id: decision.id,
        })
      }
    }
  }

  const counts: Record<string, number> = {
    APPLICATION: model.applications.length,
    INTERVIEW: model.interviews.length,
    EVENT: model.events.length,
    BUSINESS_TASK: model.tasks.length,
    TASK_ATTEMPT: model.attempts.length,
    AGENT_SESSION: model.sessions.length,
    TOOL_CALL: model.toolCalls.length,
    DURABLE_EFFECT: model.effects.length,
    RECEIPT: model.effects.filter((effect) => effect.receipt_ref !== null || effect.external_id !== null).length,
    DECISION: model.decisions.length,
  }
  for (const ring of GAP_RINGS) {
    if ((counts[ring] ?? 0) === 0) {
      gaps.push({ ring, code: 'RING_NOT_PRODUCED', detail: GAP_NOTES[ring] })
    }
  }

  return {
    ok: breakpoints.length === 0,
    checked_rings: Object.values(counts).reduce((sum, n) => sum + n, 0),
    breakpoints,
    gaps,
  }
}

// ---------------------------------------------------------------------------
//  3. 时间线（rings）+ 查询入口
// ---------------------------------------------------------------------------

/** 把模型摊平成按时间排序的环列表。 */
export function buildRings(model: TraceModel): TraceRing[] {
  const rings: TraceRing[] = []
  for (const row of model.applications) {
    rings.push({
      ring: 'APPLICATION', id: row.id, at: toIso(row.created_at),
      state: `${row.current_stage_code}/${row.lifecycle_status}`,
      refs: { current_stage_code: row.current_stage_code, lifecycle_status: row.lifecycle_status },
      on_chain: true,
    })
  }
  for (const row of model.interviews) {
    rings.push({ ring: 'INTERVIEW', id: row.id, at: toIso(row.created_at), state: row.status, refs: { application_id: row.application_id }, on_chain: true })
  }
  for (const row of model.events) {
    const refs: Record<string, unknown> = { provider: row.provider, trust_level: row.trust_level }
    if (row.source_object_id !== null) refs.source_object_id = row.source_object_id
    if (row.causation_id !== null) refs.causation_id = row.causation_id
    rings.push({
      ring: 'EVENT', id: row.event_id, at: toIso(row.recorded_at),
      ...(row.actor_id === null ? {} : { actor_id: row.actor_id }),
      state: row.event_type, refs, on_chain: true,
    })
  }
  for (const row of model.tasks) {
    rings.push({
      ring: 'BUSINESS_TASK', id: row.id, at: toIso(row.created_at),
      ...(row.created_by_actor_id === null ? {} : { actor_id: row.created_by_actor_id }),
      state: row.status, refs: { task_type: row.task_type, business_refs: asBusinessRefs(row.business_refs) }, on_chain: true,
    })
  }
  for (const row of model.attempts) {
    rings.push({
      ring: 'TASK_ATTEMPT', id: row.id, at: toIso(row.claimed_at), state: row.status,
      refs: { task_id: row.task_id, worker_type: row.worker_type, worker_id: row.worker_id }, on_chain: true,
    })
  }
  for (const row of model.sessions) {
    const refs: Record<string, unknown> = { model_route: row.model_route }
    if (row.task_id !== null) refs.task_id = row.task_id
    if (row.attempt_id !== null) refs.attempt_id = row.attempt_id
    rings.push({ ring: 'AGENT_SESSION', id: row.id, at: toIso(row.started_at), state: row.status, refs, on_chain: true })
  }
  for (const row of model.toolCalls) {
    const refs: Record<string, unknown> = { tool_name: row.tool_name, call_ref: row.call_ref, business_refs: asBusinessRefs(row.business_refs) }
    if (row.error_code !== null) refs.error_code = row.error_code
    if (row.duration_ms !== null) refs.duration_ms = Number(row.duration_ms)
    if (row.ended_at !== null) refs.ended_at = toIso(row.ended_at)
    rings.push({
      ring: 'TOOL_CALL', id: row.id, at: toIso(row.started_at),
      ...(row.actor_id === null ? {} : { actor_id: row.actor_id }),
      state: row.outcome, refs, on_chain: true,
    })
  }
  for (const row of model.effects) {
    const refs: Record<string, unknown> = { effect_type: row.effect_type, business_refs: asBusinessRefs(row.business_refs) }
    if (row.readback_state !== null) refs.readback_state = row.readback_state
    if (row.sent_at !== null) refs.sent_at = toIso(row.sent_at)
    rings.push({ ring: 'DURABLE_EFFECT', id: row.id, at: toIso(row.created_at), state: row.status, refs, on_chain: true })
    const receiptId = row.receipt_ref ?? row.external_id
    if (receiptId !== null) {
      rings.push({
        ring: 'RECEIPT', id: receiptId,
        at: toIso(row.confirmed_at ?? row.last_readback_at),
        state: row.readback_state ?? (row.confirmed_at === null ? 'NOT_CONFIRMED' : 'CONFIRMED'),
        refs: { effect_id: row.id, basis: row.receipt_ref === null ? 'external_id' : 'receipt_ref' },
        on_chain: true,
      })
    }
  }
  for (const row of model.decisions) {
    const refs: Record<string, unknown> = { decision_scope: row.decision_scope, application_id: row.application_id }
    if (row.stage_code !== null) refs.stage_code = row.stage_code
    if (row.causation_event_id !== null) refs.causation_event_id = row.causation_event_id
    if (row.interview_id !== null) refs.interview_id = row.interview_id
    rings.push({
      ring: 'DECISION', id: row.id, at: toIso(row.decided_at),
      actor_id: row.decided_by_actor_id, state: row.result, refs, on_chain: true,
    })
  }
  for (const row of model.offChain) {
    rings.push({
      ring: row.ring, id: row.id, at: toIso(row.at),
      ...(row.state === null ? {} : { state: row.state }),
      refs: { via: row.via, ...(row.correlation_id === null ? {} : { actual_correlation_id: row.correlation_id }) },
      on_chain: false,
    })
  }
  return rings.sort((a, b) => {
    const at = a.at ?? ''
    const bt = b.at ?? ''
    if (at !== bt) return at < bt ? -1 : 1
    const ringDiff = RING_ORDER[a.ring] - RING_ORDER[b.ring]
    if (ringDiff !== 0) return ringDiff
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 查询结果（loadTrace 的返回 = 环列表 + 完整性 + R7 自证）。 */
export async function loadTrace(client: DatabaseClient, input: TraceInput): Promise<TraceResult> {
  const { model, object } = await loadTraceModel(client, input)
  const integrity = checkTraceIntegrity(model)
  const counts: Record<string, number> = {}
  for (const ring of ['APPLICATION', 'INTERVIEW', 'EVENT', 'BUSINESS_TASK', 'TASK_ATTEMPT', 'AGENT_SESSION',
    'TOOL_CALL', 'DURABLE_EFFECT', 'RECEIPT', 'DECISION'] as TraceRingType[]) {
    counts[ring] = ring === 'RECEIPT'
      // receipt 是 durable_effect 上的回执列（receipt_ref / external_id），不是独立表。
      ? model.effects.filter((effect) => effect.receipt_ref !== null || effect.external_id !== null).length
      : model[{
        APPLICATION: 'applications', INTERVIEW: 'interviews', EVENT: 'events', BUSINESS_TASK: 'tasks',
        TASK_ATTEMPT: 'attempts', AGENT_SESSION: 'sessions', TOOL_CALL: 'toolCalls',
        DURABLE_EFFECT: 'effects', DECISION: 'decisions',
      }[ring] as 'applications' | 'interviews' | 'events' | 'tasks' | 'attempts' | 'sessions' | 'toolCalls' | 'effects' | 'decisions'].length
  }
  return {
    object,
    ...(model.correlationId === null ? {} : { correlation_id: model.correlationId }),
    legacy_without_correlation: model.correlationId === null,
    rings: buildRings(model),
    counts,
    integrity,
    redaction: {
      candidate_text_included: false,
      payload_included: false,
      note: '只返回 id / 类型 / 时间 / actor / 状态 / 业务键；不返回 payload、简历原文、转写、候选人姓名、决策理由原文（R7）',
    },
  }
}

/** 只读事务里查一次（工具/CLI 用）。 */
export async function getTrace(pool: DatabasePool, input: TraceInput): Promise<TraceResult> {
  const client = await pool.connect()
  try {
    await client.query('begin transaction read only')
    const result = await loadTrace(client, input)
    await client.query('commit')
    return result
  } catch (error) {
    try {
      await client.query('rollback')
    } catch {
      // 保留第一个错误。
    }
    throw error
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------------
//  4. 记录：一次真实工具调用 → 一行 tool_call
// ---------------------------------------------------------------------------

/** 一次工具调用的记录输入（`recordToolCall` 用）。 */
export interface ToolCallRecordInput {
  readonly tenantId: string
  /** 幂等键：同一 callRef 只落一行（重放不重复记）。 */
  readonly callRef: string
  readonly toolName: string
  readonly correlationId: string
  readonly businessRefs: readonly BusinessRef[]
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'NOT_RUN' | 'UNKNOWN'
  readonly actorId?: string
  readonly agentSessionId?: string
  readonly taskId?: string
  readonly attemptId?: string
  readonly argsDigest?: string
  readonly resultDigest?: string
  readonly errorCode?: string
  readonly startedAt: Date
  readonly endedAt?: Date
  readonly durationMs?: number
}

/**
 * 写一条工具调用记录（append-only）。幂等：`(tenant_id, call_ref)` 已存在时返回已有 id。
 * @param client - 事务内客户端（调用方负责 actor 身份与提交）。
 * @param input - 调用记录。
 * @returns `tool_call.id`。
 */
export async function recordToolCall(client: DatabaseClient, input: ToolCallRecordInput): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.tool_call
       (tenant_id, call_ref, tool_name, correlation_id, actor_id, agent_session_id, task_id, attempt_id,
        business_refs, args_digest, result_digest, outcome, error_code, started_at, ended_at, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)
     on conflict (tenant_id, call_ref) do nothing
     returning id`,
    [
      input.tenantId, input.callRef, input.toolName, input.correlationId,
      input.actorId ?? null, input.agentSessionId ?? null, input.taskId ?? null, input.attemptId ?? null,
      JSON.stringify(input.businessRefs), input.argsDigest ?? null, input.resultDigest ?? null,
      input.outcome, input.errorCode ?? null, input.startedAt,
      input.endedAt ?? null, input.durationMs ?? null,
    ],
  )
  const fresh = rows[0]
  if (fresh !== undefined) return fresh.id
  const existing = await client.query<{ id: string }>(
    'select id from recruitment.tool_call where tenant_id = $1 and call_ref = $2',
    [input.tenantId, input.callRef],
  )
  const row = existing.rows[0]
  if (row === undefined) throw new Error('recordToolCall: 冲突回读不到已有行')
  return row.id
}

/**
 * 从业务引用反查 correlation（优先 APPLICATION → DECISION → INTERVIEW → 其它）。
 *
 * 记录适配器与事务内测试都用它：工具返回的业务 id → 同一事务里已落库的业务对象 →
 * 它所属的那条链。查不到就返回 null（调用方决定是"新开一条链"还是"报断链"）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param refs - 业务引用（来自工具返回值）。
 */
export async function resolveCorrelationForRefs(
  client: DatabaseClient,
  tenantId: string,
  refs: readonly BusinessRef[],
): Promise<string | null> {
  const order = ['APPLICATION', 'DECISION', 'INTERVIEW', 'BUSINESS_TASK', 'TASK_ATTEMPT', 'AGENT_SESSION']
  const queries: Readonly<Record<string, string>> = {
    APPLICATION: 'select correlation_id from recruitment.application where id = $1 and tenant_id = $2',
    DECISION: 'select correlation_id from recruitment.decision where id = $1 and tenant_id = $2',
    BUSINESS_TASK: 'select correlation_id from recruitment.business_task where id = $1 and tenant_id = $2',
    TASK_ATTEMPT: 'select correlation_id from recruitment.task_attempt where id = $1 and tenant_id = $2',
    AGENT_SESSION: 'select correlation_id from recruitment.agent_session where id = $1 and tenant_id = $2',
    INTERVIEW: `select a.correlation_id
                  from recruitment.interview i
                  join recruitment.application a on a.id = i.application_id and a.tenant_id = i.tenant_id
                 where i.id = $1 and i.tenant_id = $2`,
  }
  for (const kind of order) {
    for (const ref of refs) {
      if (ref.kind !== kind) continue
      const sql = queries[kind]
      if (sql === undefined) continue
      const { rows } = await client.query<{ correlation_id: string | null }>(sql, [ref.id, tenantId])
      const value = rows[0]?.correlation_id
      if (typeof value === 'string' && value !== '') return value
    }
  }
  return null
}

/** `runTracedToolCall` 的配置。 */
export interface TracedToolCallOptions {
  readonly database: ResolvedDatabaseConfig
  /** 真实工具定义（只用 name + execute；不 import 任何工具模块，避免循环依赖）。 */
  readonly tool: { readonly name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }
  readonly args: unknown
  readonly exec?: unknown
  /** 调用方幂等键；缺省用 `toolName:randomUUID()`（重放会多一行，这是调用方的责任）。 */
  readonly callRef?: string
  /** 记录归属 actor；缺省用数据库配置里的 actor。 */
  readonly actorId?: string
  readonly agentSessionId?: string
  readonly taskId?: string
  readonly attemptId?: string
}

/** 一次被追踪的工具调用结果。 */
export interface TracedToolCallResult {
  readonly value: unknown
  readonly tool_call_id: string
  readonly correlation_id: string
  readonly outcome: 'SUCCEEDED' | 'FAILED'
}

/**
 * 执行一次真实工具调用并把它落成 `tool_call` 行。
 *
 * 为什么是"包一层"而不是改 19 个工具：工具不认识追溯层（也不应该认识）；
 * 记录发生在**调用之后**，用工具自己返回的业务 id 去反查同一条 correlation，
 * 所以记录的是外部可观察的真实调用，不是推测。
 *
 * 工具失败时：先落一行 outcome=FAILED 的调用记录，再把原错误原样抛出
 * （不吞错、不改错误语义）。工具成功但记录失败：抛 `TRACE_RECORD_FAILED`
 * （宁可红，也不要"调用发生了但没有记录"）。
 * @param options - 工具 + 参数 + 数据库配置。
 * @returns 工具返回值 + tool_call id + correlation id。
 */
export async function runTracedToolCall(options: TracedToolCallOptions): Promise<TracedToolCallResult> {
  const { database } = options
  const callRef = options.callRef ?? `${options.tool.name}:${randomUUID()}`
  const startedAt = new Date()
  const startedMs = Date.now()
  let value: unknown
  let failure: unknown
  let outcome: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'
  try {
    value = await options.tool.execute(options.args, options.exec)
  } catch (error) {
    outcome = 'FAILED'
    failure = error
  }
  const endedAt = new Date()
  const businessRefs = collectBusinessRefs(value)
  const errorCode = outcome === 'FAILED'
    ? (typeof (failure as { code?: unknown })?.code === 'string' ? String((failure as { code: string }).code) : 'TOOL_ERROR')
    : undefined
  const pool = createPool(database)
  let recorded: { id: string; correlationId: string }
  try {
    recorded = await withActor(pool, options.actorId ?? database.actor_id, async (client) => {
      const inherited = await resolveCorrelationForRefs(client, database.tenant_id, businessRefs)
      const correlationId = inherited ?? randomUUID()
      const id = await recordToolCall(client, {
        tenantId: database.tenant_id,
        callRef,
        toolName: options.tool.name,
        correlationId,
        businessRefs: businessRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        outcome,
        actorId: options.actorId ?? database.actor_id,
        ...(options.agentSessionId === undefined ? {} : { agentSessionId: options.agentSessionId }),
        ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
        ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
        argsDigest: safeDigest(options.args),
        resultDigest: safeDigest(value),
        ...(errorCode === undefined ? {} : { errorCode }),
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
      })
      return { id, correlationId }
    })
  } catch (recordError) {
    await closePool(pool).catch(() => undefined)
    if (failure !== undefined) throw failure
    throw new Error(`TRACE_RECORD_FAILED: 工具 ${options.tool.name} 调用成功但 tool_call 记录失败：${String(recordError)}`)
  } finally {
    await closePool(pool).catch(() => undefined)
  }
  if (failure !== undefined) throw failure
  return { value, tool_call_id: recorded.id, correlation_id: recorded.correlationId, outcome }
}
