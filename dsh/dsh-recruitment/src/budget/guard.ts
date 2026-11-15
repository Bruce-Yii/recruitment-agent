// task-78 / DESIGN §3.7：工具调用硬闸门（DSH `tools.guard` 适配器 + 可单测的纯函数体）。
//
// 为什么用 `tools.guard` 而不是 prompt：DESIGN §1 现场取证 —— `ToolGuard` 在每次
// `tools/pre-execute` 监听之后、工具 body 之前被评估；返回 reason 即拒绝，且**没有 allow
// 结果**（拒绝不可被后续 listener 翻回）。这是单调硬闸门，能证明「拒绝 → 工具 body 从未执行 → 零写库」。
//
// 语义（冻结，单测钉死）：
//   1. 无 `exec.agent.session` → 放行（非 Agent 调用，如 Host Remote Action / 单测）；
//   2. `session.id` 为空 → 放行；
//   3. 先读一次真实 usage → 快照；`within=false` → `noteDenied` + 拒绝（**不增加 steps**）；
//   4. 否则 `noteAllowed`（steps 已含本次）→ **用同一份 usage 重算快照**；仍超限 → 拒绝
//      （这一次调用不放行，且 steps 已计 —— 语义：第 N 步达到上限后，第 N+1 步不放行）；
//   5. 拒绝形态 `{ reason: 交接文本, info: { name, code } }`，`code` 固定
//      `BUDGET_EXCEEDED_HANDOFF`（进 `tool/result.error.info`，结构化可机检）。
//
// 零 DB / 零网络 / 零文件；只读 DSH 内存态（usage）。
import { resolveBudgetConfig } from './config.ts'
import { BUDGET_EXCEEDED_HANDOFF, buildHandoffText } from './handoff.ts'
import { createBudgetStatusTool } from './status-tool.ts'
import { BudgetTracker } from './tracker.ts'
import { readSessionUsage, type SessionUsageRead } from './usage.ts'
import type { BudgetConfigIssues, BudgetSnapshot, ResolvedBudgetConfig } from './types.ts'

export interface BudgetGuardHooks {
  readonly onDeny?: (info: { session_id: string; tool: string; snapshot: BudgetSnapshot }) => void
}

/**
 * 闸门运行时（**公开类型只有两个字段，冻结**）。
 *
 * `installBudgetGuard` 会在该对象上挂一个**不可枚举**的内部 `readUsage(session)` 闭包，
 * 让 `evaluateToolCall` 的纯函数体在不接收 ctx 的前提下也能读到真实 usage；
 * 直接构造 `{ tracker, config }` 的调用方（单测）没有它时按 unavailable 0 处理。
 */
export interface BudgetGuardRuntime {
  readonly tracker: BudgetTracker
  readonly config: ResolvedBudgetConfig
}

type UsageReader = (session: unknown) => SessionUsageRead

interface BudgetGuardRuntimeInternal extends BudgetGuardRuntime {
  readonly readUsage?: UsageReader
}

interface GuardToolsShape {
  readonly guard?: (guard: (exec: unknown) => unknown) => unknown
  readonly register?: (tool: unknown) => unknown
}

interface ToolExecShape {
  readonly name?: unknown
  readonly agent?: { readonly id?: unknown; readonly session?: unknown } | null
}

interface ToolCallDenial {
  readonly reason: string
  readonly info: { readonly name: string; readonly code: string }
}

const EMPTY_USAGE: SessionUsageRead = Object.freeze({
  buckets: Object.freeze({ uncached_input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 }),
  source: 'unavailable',
  dsh_step: null,
})

function sessionIdOf(session: unknown): string {
  if (session === null || typeof session !== 'object') return ''
  const id = (session as { readonly id?: unknown }).id
  return typeof id === 'string' ? id.trim() : ''
}

function asExec(exec: unknown): { readonly name: string; readonly agent?: ToolExecShape['agent'] } {
  if (exec === null || typeof exec !== 'object') return { name: '' }
  const record = exec as ToolExecShape
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const agent = record.agent !== null && typeof record.agent === 'object' ? record.agent : undefined
  return { name, agent }
}

function usageReaderOf(runtime: BudgetGuardRuntime): UsageReader {
  const readUsage = (runtime as BudgetGuardRuntimeInternal).readUsage
  return typeof readUsage === 'function' ? readUsage : () => EMPTY_USAGE
}

function denial(snapshot: BudgetSnapshot, config: ResolvedBudgetConfig): ToolCallDenial {
  return {
    reason: buildHandoffText({ snapshot, config }),
    // 结构化错误身份：进 tool/result.error.info，供下游机检（DESIGN §3.7 第 5 条）。
    info: { name: BUDGET_EXCEEDED_HANDOFF, code: BUDGET_EXCEEDED_HANDOFF },
  }
}

function notifyDeny(
  hooks: BudgetGuardHooks | undefined,
  info: { session_id: string; tool: string; snapshot: BudgetSnapshot },
): void {
  if (hooks === undefined || typeof hooks.onDeny !== 'function') return
  try {
    hooks.onDeny(info)
  } catch {
    // 观测回调不能影响闸门判定
  }
}

/**
 * 纯函数式闸门体（便于单测，不依赖 cordis）。
 *
 * @returns `undefined` = 放行；`{ reason, info }` = 拒绝（`info.code` 固定 `'BUDGET_EXCEEDED_HANDOFF'`）。
 */
export function evaluateToolCall(input: {
  readonly runtime: BudgetGuardRuntime
  readonly exec: unknown // { name, agent?: { id, session } }
  readonly tools: unknown // { guard(fn): dispose }
  readonly hooks?: BudgetGuardHooks
}): string | ToolCallDenial | undefined {
  const exec = asExec(input.exec)
  const session = exec.agent?.session
  // 1) 非 Agent 调用（无 session）→ 放行：闸门只管 Agent 的工具调用。
  if (session === undefined || session === null) return undefined
  const sessionId = sessionIdOf(session)
  // 2) 无法标识会话 → 放行（不猜会话、不做跨会话共享预算池）。
  if (sessionId === '') return undefined

  const toolName = exec.name === '' ? 'unknown_tool' : exec.name
  const runtime = input.runtime
  const tracker = runtime.tracker

  let usage: SessionUsageRead
  try {
    usage = usageReaderOf(runtime)(session)
  } catch {
    usage = EMPTY_USAGE // 读 usage 失败不阻断判定（降级为 0 用量，如实 source=unavailable）
  }

  // 3) 调用前快照：已超限 → 拒绝本次（不计步）。
  const before = tracker.snapshot(sessionId, usage)
  if (!before.within) {
    tracker.noteDenied(sessionId, toolName)
    const payload = { session_id: sessionId, tool: toolName, snapshot: before }
    notifyDeny(input.hooks, payload)
    return denial(before, runtime.config)
  }

  // 4) 放行当且仅当「本次计入后 steps <= max_steps 且 tokens <= max_tokens」。
  tracker.noteAllowed(sessionId, toolName)
  const after = tracker.snapshot(sessionId, usage)
  if (!after.within) {
    // 这一次调用本身被拒绝（不执行 body、零写），但 steps 已计。
    tracker.noteDenied(sessionId, toolName)
    const payload = { session_id: sessionId, tool: toolName, snapshot: after }
    notifyDeny(input.hooks, payload)
    return denial(after, runtime.config)
  }
  return undefined
}

function toolsOf(ctx: unknown): GuardToolsShape | undefined {
  if (ctx === null || typeof ctx !== 'object') return undefined
  const tools = (ctx as { readonly tools?: unknown }).tools
  if (tools === null || typeof tools !== 'object') return undefined
  return tools as GuardToolsShape
}

/** 运行时问题也进 `config.issues`（DESIGN §3.7：「ctx 无 tools → 记 issue 并返回 no-op」）。 */
function recordIssue(config: ResolvedBudgetConfig, key: string, message: string): void {
  const issues = config.issues as BudgetConfigIssues[]
  if (Array.isArray(issues)) issues.push({ key, message })
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/** 兼容 cordis 的两种 dispose 形态（函数 / `{ dispose() }` / 无返回值）。 */
function pushDisposer(disposers: Array<() => void>, disposer: unknown): void {
  if (typeof disposer === 'function') {
    disposers.push(disposer as () => void)
    return
  }
  if (disposer !== null && typeof disposer === 'object') {
    const maybe = disposer as { readonly dispose?: unknown }
    if (typeof maybe.dispose === 'function') {
      const target = disposer as { dispose: () => void }
      disposers.push(() => target.dispose())
    }
  }
}

/**
 * cordis 适配器：注册硬闸门（+ 可选只读 status 工具）。
 *
 * @param ctx - DSH 插件上下文；`ctx.tools.guard(fn)` 是硬闸门注册点。
 * @param rawConfig - profile 的 `config.budget` 段（扁平记录，见 config.ts 顶部）。
 * @param env - 环境变量表；缺省用 `process.env`。
 * @returns 解析后的配置 + tracker + 幂等 `dispose()`（同时释放 guard 与 status 注册）。
 *
 * `config.enabled === false` → 不注册任何东西、不追加 issue、dispose 为 no-op（显式关闭 ≠ 错误）。
 * `ctx.tools` 不存在时不抛异常：记一条 issue，返回 no-op dispose（宿主可继续启动并如实报告降级）。
 */
export function installBudgetGuard(
  ctx: unknown,
  rawConfig?: unknown,
  env?: Readonly<Record<string, string | undefined>>,
): {
  readonly config: ResolvedBudgetConfig
  readonly tracker: BudgetTracker
  readonly dispose: () => void
} {
  const config = resolveBudgetConfig(rawConfig, env)
  const tracker = new BudgetTracker({ config })

  // 显式关闭（`enabled: false`，lead 2026-11-16 裁决）：**不是错误**——
  // 不注册 guard、不注册 status 工具、不追加任何 issue，dispose 是幂等 no-op。
  // 注意：这里必须在 tool 能力探测**之前**返回，避免「关闭」被误报成 TOOLS/GUARD issue。
  if (config.enabled === false) {
    return { config, tracker, dispose: () => undefined }
  }

  /** session_id → 最近一次真实读取结果（仅 status 工具用；不构成第二份计量状态）。 */
  const lastUsageBySession = new Map<string, SessionUsageRead>()

  const readUsage: UsageReader = (session) => {
    const read = readSessionUsage(ctx, session)
    const sessionId = sessionIdOf(session)
    if (sessionId !== '') lastUsageBySession.set(sessionId, read)
    return read
  }

  const runtime: BudgetGuardRuntime = { tracker, config }
  // 内部读 usage 闭包：不可枚举 → 不会被 spread / JSON 序列化带出去，也不改公开类型。
  Object.defineProperty(runtime, 'readUsage', {
    value: readUsage,
    enumerable: false,
    writable: false,
    configurable: true,
  })

  const tools = toolsOf(ctx)
  if (tools === undefined) {
    recordIssue(
      config,
      'TOOLS',
      'ctx.tools 不可用：预算闸门未注册（dispose 为 no-op）；本会话不会拦截工具调用',
    )
    return { config, tracker, dispose: () => {} }
  }

  const disposers: Array<() => void> = []

  if (typeof tools.guard === 'function') {
    try {
      pushDisposer(disposers, tools.guard((exec: unknown) => evaluateToolCall({ runtime, exec, tools })))
    } catch (error) {
      recordIssue(
        config,
        'TOOLS_GUARD',
        `ctx.tools.guard 注册失败：${describeError(error)}；预算闸门未生效（零写无法证明）`,
      )
    }
  } else {
    recordIssue(config, 'TOOLS_GUARD', 'ctx.tools.guard 不可用：预算闸门未注册（零写无法证明）')
  }

  if (config.status_tool === true) {
    if (typeof tools.register === 'function') {
      try {
        const tool = createBudgetStatusTool(
          runtime,
          (sessionId: string) => lastUsageBySession.get(sessionId) ?? EMPTY_USAGE,
        )
        pushDisposer(disposers, tools.register(tool))
      } catch (error) {
        recordIssue(
          config,
          'TOOLS_REGISTER',
          `recruitment_budget_status 注册失败：${describeError(error)}；状态工具不可用`,
        )
      }
    } else {
      recordIssue(config, 'TOOLS_REGISTER', 'ctx.tools.register 不可用：recruitment_budget_status 未注册')
    }
  }

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    while (disposers.length > 0) {
      const disposer = disposers.pop()
      if (disposer === undefined) continue
      try {
        disposer()
      } catch {
        // dispose 幂等：单个 disposer 失败不影响其余；重复调用安全（disposed 已置位）
      }
    }
  }

  return { config, tracker, dispose }
}
