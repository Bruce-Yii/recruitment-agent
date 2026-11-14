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

function renderTrace(value: unknown): readonly TextBlock[] {
  const v = value as Record<string, unknown>
  const object = (v.object ?? {}) as Record<string, unknown>
  const rings = Array.isArray(v.rings) ? (v.rings as Record<string, unknown>[]) : []
  const integrity = (v.integrity ?? {}) as Record<string, unknown>
  const breakpoints = Array.isArray(integrity.breakpoints) ? (integrity.breakpoints as Record<string, unknown>[]) : []
  const gaps = Array.isArray(integrity.gaps) ? (integrity.gaps as Record<string, unknown>[]) : []
  const counts = (v.counts ?? {}) as Record<string, unknown>
  const lines = [
    `${String(v.tool)} ${String(v.contract_version)} status=${String(v.status)} reason=chain:${String(object.type)}:${String(object.id)}`,
    `correlation_id=${String(v.correlation_id ?? '（缺失）')} rings=${rings.length} integrity=${integrity.ok === true ? 'OK' : 'BROKEN'}`,
    `counts=${JSON.stringify(counts)}`,
  ]
  for (const ring of rings) {
    lines.push(`  ${String(ring.at ?? '(无时间)')}  ${String(ring.ring)}  ${String(ring.id)}`
      + `${ring.on_chain === false ? '  [OFF-CHAIN]' : ''}  state=${String(ring.state ?? '-')}`
      + `${ring.actor_id === undefined ? '' : `  actor=${String(ring.actor_id)}`}`)
  }
  if (breakpoints.length > 0) {
    lines.push(`breakpoints(${breakpoints.length})`)
    for (const item of breakpoints) lines.push(`  ${String(item.at)} ${String(item.code)}: ${String(item.detail)}`)
  }
  if (gaps.length > 0) {
    lines.push(`gaps(${gaps.length})`)
    for (const item of gaps) lines.push(`  ${String(item.ring)} RING_NOT_PRODUCED: ${String(item.detail)}`)
  }
  lines.push('redaction: 只含 id / 类型 / 时间 / actor / 状态；不含候选人正文、payload、决策理由原文（R7）')
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
