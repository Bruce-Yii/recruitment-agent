// 只读工具：`recruitment_trace_get` —— 给一个业务对象 id，返回它的完整执行追溯链。
//
// 这是 `src/domain/trace.ts` 的 DSH 工具外壳（本文件不含任何追溯逻辑，避免两份实现）。
//
// **注册状态：尚未注册。** 总控的约束是"src/tools/trace*.ts 新文件可以写，但注册要先问"，
// 而注册点 `src/index.ts` 不在本 lane 的写范围内。因此本文件只提供工厂函数：
//   `createTraceGetTool(database)` / `unconfiguredTraceGetTool(issues)`
// 由总控批准后，在 `src/index.ts` 里照 `createScreeningEvaluateTool` 的同一模式接一行即可。
//
// 输入只有一个业务对象（或一条 correlation_id），输出是时间线 + 断链报告：
//   * `rings[]` 每环带 ring / id / at / actor / state / refs（**没有正文**，R7）；
//   * `integrity.breakpoints[]` = 断链（有子无父 / 有父无子 / 挂在对象上却不在同一条链）；
//   * `integrity.gaps[]` = 该环在本次路径上没产生行（不是断链，是产品还没有写入方）。
//
// 只读性由 `withReadOnly` 保证：`begin transaction read only` 下任何写语句会直接
// `25006 read_only_sql_transaction`，不是"源码里没写 INSERT"这种自觉。
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabasePool,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { loadTrace, TraceQueryError, type TraceObjectType, type TraceResult } from '../domain/trace.ts'
import { RecruitmentToolError } from './errors.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
// render 口径 helper（O1 残留修复轮）：人读正文只放业务标识 / 短号，内部编号不下发（见 render-ref.ts 文件头）。
import { shortHash, shortRef } from './render-ref.ts'

const TOOL_NAME = 'recruitment_trace_get'

const OBJECT_TYPES: readonly TraceObjectType[] = [
  'APPLICATION',
  'DECISION',
  'BUSINESS_TASK',
  'EVENT',
  'TOOL_CALL',
  'DURABLE_EFFECT',
  'CORRELATION',
]

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['object_type', 'object_id'],
  properties: {
    object_type: {
      type: 'string',
      enum: [...OBJECT_TYPES],
      description:
        '追溯入口类型：APPLICATION / DECISION / BUSINESS_TASK / EVENT / TOOL_CALL / DURABLE_EFFECT，'
        + '或 CORRELATION（此时 object_id 直接是 correlation_id）。',
    },
    object_id: {
      type: 'string',
      description: '对象 id（UUID）。CORRELATION 时是 correlation_id（UUID）。',
    },
  },
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['tool', 'contract_version', 'status', 'object', 'rings', 'counts', 'integrity', 'redaction'],
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    read_only: { type: 'boolean' },
    object: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: { type: { type: 'string' }, id: { type: 'string' } },
    },
    correlation_id: { type: 'string' },
    legacy_without_correlation: { type: 'boolean' },
    rings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ring', 'id', 'on_chain'],
        properties: {
          ring: { type: 'string' },
          id: { type: 'string' },
          at: { type: 'string' },
          actor_id: { type: 'string' },
          state: { type: 'string' },
          refs: { type: 'object', additionalProperties: true },
          on_chain: { type: 'boolean' },
        },
      },
    },
    counts: { type: 'object', additionalProperties: true },
    integrity: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'checked_rings', 'breakpoints', 'gaps'],
      properties: {
        ok: { type: 'boolean' },
        checked_rings: { type: 'integer' },
        breakpoints: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'at', 'detail'],
            properties: {
              code: { type: 'string' },
              at: { type: 'string' },
              detail: { type: 'string' },
              ring_id: { type: 'string' },
              expected: { type: 'string' },
              actual: { type: 'string' },
            },
          },
        },
        gaps: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['ring', 'code', 'detail'],
            properties: {
              ring: { type: 'string' },
              code: { type: 'string' },
              detail: { type: 'string' },
            },
          },
        },
      },
    },
    redaction: {
      type: 'object',
      additionalProperties: false,
      required: ['candidate_text_included', 'payload_included', 'note'],
      properties: {
        candidate_text_included: { type: 'boolean' },
        payload_included: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
  },
}

/** 去掉 null / undefined（DSH 输出校验器不支持 null；缺省靠省略键表达）。 */
function stripNulls(value: unknown): unknown {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) return value.map(stripNulls).filter((item) => item !== undefined)
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNulls(child)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return out
  }
  return value
}

function asUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text : undefined
}

/** 校验入参（工具自己负责，不用宿主校验器）。 */
function parseArgs(rawArgs: unknown): { objectType: TraceObjectType; objectId: string } {
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: 'ARGS_NOT_OBJECT' }))
  }
  const record = rawArgs as Record<string, unknown>
  const objectType = record.object_type
  if (typeof objectType !== 'string' || !(OBJECT_TYPES as readonly string[]).includes(objectType)) {
    throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({
      reason_code: 'OBJECT_TYPE_INVALID',
      allowed: OBJECT_TYPES,
      received: String(objectType ?? ''),
    }))
  }
  const objectId = asUuid(record.object_id)
  if (objectId === undefined) {
    throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: 'OBJECT_ID_NOT_UUID' }))
  }
  return { objectType: objectType as TraceObjectType, objectId }
}

/** 环类型 → 人读业务名（render 的人读正文讲业务，不讲内部编号）。 */
const RING_LABELS: Readonly<Record<string, string>> = {
  APPLICATION: '申请',
  INTERVIEW: '面试',
  EVENT: '事件',
  BUSINESS_TASK: '业务任务',
  TASK_ATTEMPT: '任务尝试',
  AGENT_SESSION: 'Agent 会话',
  TOOL_CALL: '工具调用',
  DURABLE_EFFECT: '外部副作用',
  RECEIPT: '外部回执',
  DECISION: '人工决策',
}

/** 追溯入口类型 → 人读业务名（`object_type` 也是模型能从入参回读的业务说法）。 */
const OBJECT_TYPE_LABELS: Readonly<Record<string, string>> = {
  ...RING_LABELS,
  CORRELATION: '执行链',
}

/** `counts` 的固定展示顺序（与 `src/domain/trace.ts` 的环顺序一致）。 */
const TRACE_RING_ORDER: readonly string[] = [
  'APPLICATION', 'INTERVIEW', 'EVENT', 'BUSINESS_TASK', 'TASK_ATTEMPT',
  'AGENT_SESSION', 'TOOL_CALL', 'DURABLE_EFFECT', 'RECEIPT', 'DECISION',
]

/**
 * 把文本里残留的完整内部编号换成短号。
 *
 * 为什么需要它：断链 `detail` 是 `src/domain/trace.ts` 拼的，里面**直接带完整 UUID**
 * （`LINKED_ROW_OFF_CHAIN` 的 `decision.application_id=<UUID>`、`TOOL_CALL_DANGLING_REF`
 * 的引用 id），原样打印就等于把内部编号念给 HR。这里只改呈现，事实一句不少。
 * @param text - 可能是 detail / message 的自由文本。
 * @returns 完整 UUID → `…末4位`；32+ 连续 hex → `前8位…`。
 */
function shortIdsInText(text: string): string {
  return text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}/gi,
    (match) => (match.includes('-') ? shortRef(match) : shortHash(match)),
  )
}

/** `unknown` 值 → 可打印文本（缺省给 `—`，不用 null 占位，与出参 schema 的口径一致）。 */
function textOf(value: unknown, missing = '—'): string {
  return typeof value === 'string' && value !== '' ? value : missing
}

function renderTrace(value: unknown): readonly TextBlock[] {
  const v = value as Record<string, unknown>
  const object = (v.object ?? {}) as Record<string, unknown>
  const rings = Array.isArray(v.rings) ? (v.rings as Record<string, unknown>[]) : []
  const integrity = (v.integrity ?? {}) as Record<string, unknown>
  const breakpoints = Array.isArray(integrity.breakpoints) ? (integrity.breakpoints as Record<string, unknown>[]) : []
  const gaps = Array.isArray(integrity.gaps) ? (integrity.gaps as Record<string, unknown>[]) : []
  const counts = (v.counts ?? {}) as Record<string, unknown>
  // O1 残留修复：人读正文只给**业务标识**（环类型 / 阶段状态 / 事件类型）与**短号**。
  // 完整 UUID 与 64hex 一个都不出现；本工具是只读诊断，环上的编号也不是任何已注册工具的入参
  // （event / business_task / task_attempt / agent_session / tool_call / durable_effect 都没有下游工具），
  // 因此**不设** machine arguments 区 —— 下游要的 application_id / interview_id 走
  // `business_read` 的 next tools 区 / `interview_get` 的 machine arguments 区，不从追溯链里发现。
  const entryType = String(object.type ?? '?')
  const entryLabel = OBJECT_TYPE_LABELS[entryType] ?? entryType
  const chainRef = typeof v.correlation_id === 'string' && v.correlation_id !== ''
    ? shortRef(v.correlation_id)
    : '（缺失：历史行没有链 ID，不伪造）'
  const countParts = TRACE_RING_ORDER
    .filter((ring) => typeof counts[ring] === 'number' && (counts[ring] as number) > 0)
    .map((ring) => `${RING_LABELS[ring] ?? ring} ${String(counts[ring])}`)
  const lines = [
    `${String(v.tool)} ${String(v.contract_version)} status=${String(v.status)} read_only=${String(v.read_only)}`,
    `追溯入口：${entryLabel}(${entryType}) ${shortRef(textOf(object.id))}`
      + ` · 链 ${chainRef}`
      + ` · 环 ${rings.length} 条`
      + ` · 完整性 ${integrity.ok === true ? 'OK（无断链）' : `BROKEN（断点 ${breakpoints.length} 处）`}`,
    `计数：${countParts.length === 0 ? '各环都没有行' : countParts.join(' · ')}`,
  ]
  for (const ring of rings) {
    const ringCode = String(ring.ring ?? '?')
    lines.push(`  ${textOf(ring.at, '(无时间)')}  ${RING_LABELS[ringCode] ?? ringCode}(${ringCode})`
      + ` ${shortRef(textOf(ring.id))}`
      + `${ring.on_chain === false ? '  [OFF-CHAIN：挂在本对象上但不在同一链]' : ''}`
      + `  state=${textOf(ring.state, '-')}`
      + `${typeof ring.actor_id === 'string' && ring.actor_id !== '' ? `  actor=${shortRef(ring.actor_id)}` : ''}`)
  }
  if (breakpoints.length > 0) {
    lines.push(`断点(${breakpoints.length})：有证据但接不上（完整性 BROKEN）`)
    for (const item of breakpoints) {
      lines.push(`  ${textOf(item.at, '?')} ${textOf(item.code, '?')}: ${shortIdsInText(textOf(item.detail, ''))}`
        + `${typeof item.ring_id === 'string' && item.ring_id !== '' ? `  （相关环 ${shortRef(item.ring_id)}）` : ''}`)
    }
  }
  if (gaps.length > 0) {
    lines.push(`缺环(${gaps.length})：该环在本次路径上没有产生行（不是断链）`)
    for (const item of gaps) {
      const ringCode = String(item.ring ?? '?')
      lines.push(`  ${RING_LABELS[ringCode] ?? ringCode}(${ringCode}) ${textOf(item.code, 'RING_NOT_PRODUCED')}: `
        + shortIdsInText(textOf(item.detail, '')))
    }
  }
  lines.push('redaction: 只含类型 / 时间 / actor / 状态；不含候选人正文、payload、决策理由原文（R7）')
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 造一次调用的执行体：**每次调用新建连接池、结束关闭**（与其它工具一致：
 * 工具调用是短事务，不让空闲 socket 挂住宿主事件循环）。
 */
function makeExecute(database: ResolvedDatabaseConfig) {
  return async (rawArgs: unknown): Promise<unknown> => {
    const { objectType, objectId } = parseArgs(rawArgs)
    const pool: DatabasePool = createPool(database)
    try {
      const result: TraceResult = await withReadOnly(pool, async (client) => (
        loadTrace(client, { tenantId: database.tenant_id, objectType, objectId })
      ))
      return stripNulls({
        tool: TOOL_NAME,
        contract_version: '1.0.0',
        status: 'OK',
        read_only: true,
        object: result.object,
        correlation_id: result.correlation_id,
        legacy_without_correlation: result.legacy_without_correlation,
        rings: result.rings,
        counts: result.counts,
        integrity: result.integrity,
        redaction: result.redaction,
      })
    } catch (error) {
      if (error instanceof TraceQueryError) {
        throw new RecruitmentToolError(error.code, JSON.stringify({
          reason_code: error.code === 'NOT_FOUND' ? 'TRACE_OBJECT_NOT_FOUND' : 'TRACE_OBJECT_TYPE_INVALID',
          message: error.message,
          object_type: objectType,
          object_id: objectId,
        }))
      }
      throw error
    } finally {
      await closePool(pool).catch(() => undefined)
    }
  }
}

/**
 * 造一个绑定数据库配置的追溯工具（只读）。
 * @param database - 已解析的数据库配置（tenant 只从这里来，不接受模型入参）。
 */
export function createTraceGetTool(database: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  const execute = makeExecute(database)
  return {
    name: TOOL_NAME,
    description:
      'Read-only execution trace for ONE business object (application / decision / business task / event / '
      + 'tool call / durable effect / correlation id). Returns a time-ordered chain of execution facts '
      + '(event → business task → task attempt → agent session → tool call → durable effect → receipt → human decision), '
      + 'each ring with id / type / time / actor / state, plus an integrity report: breakpoints are real breaks '
      + '(a decision with no source event or no tool call, an effect with no receipt, a row linked to the object but '
      + 'outside the chain), gaps are rings this path never produced. It never returns candidate text, payloads, '
      + 'transcripts or decision reasons (redaction). It reads only, never writes.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => renderTrace(value) },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      return execute(rawArgs)
    },
  }
}

/** 数据库配置不完整时的兜底工具：**照常注册**，调用时返回 NOT_CONFIGURED 并列出缺什么。 */
export function unconfiguredTraceGetTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Read-only execution trace for one business object. NOT CONFIGURED here: the database config is incomplete, '
      + 'so this tool refuses instead of returning fake data.',
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: (_args: unknown, value: unknown) => renderTrace(value) },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', JSON.stringify({
        reason_code: 'DATABASE_NOT_CONFIGURED',
        issues: [...issues],
      }))
    },
  }
}
