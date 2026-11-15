// task-78 / DESIGN §3.8：只读状态工具 `recruitment_budget_status`。
//
// 默认**不注册**（`config.budget.status_tool` 默认 false：D-128.2 权威工具数 = 30，
// 默认开会让权威数字变 31）；验证 profile 可单独开启。
//
// 只读、无 DB、无文件、无网络：输出是本进程内存里的预算快照 + 逐键配置来源 + issues。
// 依赖面只有 `../tools/definition.ts` 的**类型**（纯类型文件，无副作用），不 import DB 层。
import type { ReadonlyToolDefinition, TextBlock } from '../tools/definition.ts'
import type { BudgetGuardRuntime } from './guard.ts'
import type { BudgetSnapshot, BudgetUsageSource } from './types.ts'
import type { SessionUsageRead } from './usage.ts'

/** 本插件注册的工具定义形状（与 `src/tools/definition.ts` 同一份契约）。 */
export type ToolDefinitionLike = ReadonlyToolDefinition

const TOOL_NAME = 'recruitment_budget_status'

const ZERO_USAGE: SessionUsageRead = Object.freeze({
  buckets: Object.freeze({ uncached_input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 }),
  source: 'unavailable' as BudgetUsageSource,
  dsh_step: null,
})

const PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {},
  description: '无入参。',
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'sessions', 'limits', 'sources', 'issues'],
  properties: {
    ok: {
      type: 'boolean',
      description: '配置解析 issues 为空时为 true（false = 有 fail-closed 降级，逐条见 issues）。',
    },
    sessions: {
      type: 'array',
      description: '本进程内活跃会话的预算快照（只读事实）。',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['session_id', 'task_class', 'tokens', 'steps', 'limits', 'usage_source', 'within'],
        properties: {
          session_id: { type: 'string' },
          task_class: { type: 'string', enum: ['SCREENING', 'DECISION'] },
          task_class_source: { type: 'string', enum: ['auto', 'configured'] },
          tokens: {
            type: 'object',
            additionalProperties: true,
            required: ['uncached_input', 'output', 'cache_read', 'cache_write', 'total'],
            properties: {
              uncached_input: { type: 'number' },
              output: { type: 'number' },
              cache_read: { type: 'number' },
              cache_write: { type: 'number' },
              total: { type: 'number' },
            },
          },
          steps: { type: 'number', description: '本闸门放行过的工具调用数。' },
          dsh_step: { description: 'tokenUsage.last.step（number 或 null）。' },
          limits: {
            type: 'object',
            additionalProperties: true,
            required: ['max_tokens', 'max_steps'],
            properties: { max_tokens: { type: 'number' }, max_steps: { type: 'number' } },
          },
          usage_source: {
            type: 'string',
            enum: ['session_projection.tokenUsage', 'tokenMeter.measure', 'unavailable'],
          },
          last_tool: { description: '最近一次被放行的工具名（string 或 null）。' },
          tools_used: { type: 'object', additionalProperties: true },
          over: { type: 'array', items: { type: 'object', additionalProperties: true } },
          within: { type: 'boolean' },
        },
      },
    },
    limits: {
      type: 'object',
      additionalProperties: true,
      description: '按任务类的额度：{ SCREENING: {max_tokens,max_steps}, DECISION: {...} }。',
    },
    sources: { type: 'object', additionalProperties: true, description: '逐键来源：profile | env | default。' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['key', 'message'],
        properties: { key: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 把 `readUsage(sessionId)` 的未知返回值归一成一份可判定的 usage（非法 → unavailable 0）。 */
function normalizeUsage(read: unknown): SessionUsageRead {
  if (read === null || typeof read !== 'object') return ZERO_USAGE
  const record = read as { buckets?: unknown; source?: unknown; dsh_step?: unknown }
  const buckets = record.buckets
  if (buckets === null || typeof buckets !== 'object') return ZERO_USAGE
  const bucketRecord = buckets as Record<string, unknown>
  const uncachedInput = readCount(bucketRecord.uncached_input)
  const output = readCount(bucketRecord.output)
  const cacheRead = readCount(bucketRecord.cache_read)
  const cacheWrite = readCount(bucketRecord.cache_write)
  const declaredTotal = readCount(bucketRecord.total)
  const summed = uncachedInput + output + cacheRead + cacheWrite
  const source: BudgetUsageSource =
    record.source === 'session_projection.tokenUsage' || record.source === 'tokenMeter.measure'
      ? record.source
      : 'unavailable'
  const step = record.dsh_step
  return {
    buckets: {
      uncached_input: uncachedInput,
      output,
      cache_read: cacheRead,
      cache_write: cacheWrite,
      // 兜底路径（tokenMeter.measure）只有 total 单值，Σ四桶=0，此时用声明值。
      total: declaredTotal > 0 ? declaredTotal : summed,
    },
    source,
    dsh_step: typeof step === 'number' && Number.isFinite(step) ? step : null,
  }
}

function render(_args: unknown, value: unknown): readonly TextBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * 构造只读状态工具定义（DESIGN §3.8）。
 *
 * @param runtime - 闸门运行时（tracker + 解析后的配置）；只读使用。
 * @param readUsage - 按 session_id 取最近一次 usage 读取结果（由 `installBudgetGuard` 注入；
 *   无缓存时返回 undefined 即可，工具会按 unavailable 0 处理，绝不伪造）。
 * @returns 可直接 `ctx.tools.register(...)` 的工具定义（不在此注册，注册由 guard 负责）。
 */
export function createBudgetStatusTool(
  runtime: BudgetGuardRuntime,
  readUsage: (sessionId: string) => unknown,
): ToolDefinitionLike {
  return {
    name: TOOL_NAME,
    description:
      '只读预算状态：列出本进程内活跃 HR 会话的预算快照（任务类 / 阈值 / 已放行步数 / 真实 usage 来源）、'
      + '逐键配置来源（profile | env | default）与配置 issues。不读库、不写任何东西。',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render,
    },
    isConcurrencySafe: () => true,
    async execute(_args: unknown, _exec: unknown): Promise<unknown> {
      const config = runtime.config
      const sessions: BudgetSnapshot[] = []
      for (const sessionId of runtime.tracker.sessions()) {
        let read: unknown
        try {
          read = readUsage(sessionId)
        } catch {
          read = undefined
        }
        sessions.push(runtime.tracker.snapshot(sessionId, normalizeUsage(read)))
      }
      return {
        ok: config.issues.length === 0,
        sessions,
        limits: config.limits,
        sources: config.sources,
        issues: config.issues.map((issue) => ({ key: issue.key, message: issue.message })),
      }
    },
  }
}
