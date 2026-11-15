/**
 * task-78 / DESIGN §3.4 + §3.7 + §3.8：tracker / 硬闸门 / status 工具单测（种子 A 的核心）。
 *
 * 必须钉死（任务书）：
 *   1. `max_steps=1`：第 1 次放行、第 2 次拒绝，且第 2 次调用 steps **已计**（这一步不放行）；
 *   2. `max_steps=0` 配置非法 → issue + 回退默认 15；
 *   3. 边界等于阈值算 within（`<=`）；
 *   4. 非法阈值回退 + issues；
 *   5. handoff 文本含全部机检字面量；
 *   6. session 缺失 / session.id 空 → 放行（非 Agent 调用不建档）。
 *
 * 测试手段：fake `tools = { guard(fn), register(tool) }` + runtime 内部（不可枚举）`readUsage`
 * 注入，**不需要 cordis、不需要 DB**（fake tools 的 guard 返回值就是 DSH 的拒绝形态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIMITS,
  BudgetTracker,
  createBudgetStatusTool,
  evaluateToolCall,
  installBudgetGuard,
  resolveBudgetConfig,
  type BudgetGuardRuntime,
  type BudgetTokenBuckets,
  type BudgetUsageSource,
  type ResolvedBudgetConfig,
  type SessionUsageRead,
} from '../../src/budget/index.ts'

const HANDOFF_LITERALS = [
  'BUDGET_EXCEEDED_HANDOFF',
  'task_class=',
  'tokens=',
  'limit_tokens=',
  'steps=',
  'limit_steps=',
  'usage_source=',
  'HANDOFF_TO:',
  'SUGGESTION:',
  'STOP',
] as const

function bucketsOf(total: number): BudgetTokenBuckets {
  return { uncached_input: total, output: 0, cache_read: 0, cache_write: 0, total }
}

function usageOf(total: number, dshStep: number | null = null): SessionUsageRead {
  return { buckets: bucketsOf(total), source: 'session_projection.tokenUsage', dsh_step: dshStep }
}

const ZERO_USAGE: SessionUsageRead = Object.freeze({
  buckets: bucketsOf(0),
  source: 'unavailable' as BudgetUsageSource,
  dsh_step: null,
})

interface DenialShape {
  readonly reason: string
  readonly info: { readonly name: string; readonly code: string }
}

function denialOf(result: unknown): DenialShape {
  if (result === null || result === undefined || typeof result !== 'object') {
    assert.fail(`期望拒绝对象，实际=${String(result)}`)
  }
  return result as DenialShape
}

interface RegisteredTool {
  readonly name: string
  readonly description: string
  readonly parameters: { readonly type?: string; readonly required?: readonly string[]; readonly properties?: Record<string, unknown> }
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: unknown) => readonly { readonly type: 'text'; readonly text: string }[]
  }
  readonly isConcurrencySafe?: (args: unknown) => boolean
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>
}

function fakeTools(): {
  tools: { guard: (guard: (exec: unknown) => unknown) => unknown; register: (tool: unknown) => unknown }
  guards: Array<(exec: unknown) => unknown>
  registered: RegisteredTool[]
  counters: { guardDisposed: number; registerDisposed: number }
} {
  const guards: Array<(exec: unknown) => unknown> = []
  const registered: RegisteredTool[] = []
  const counters = { guardDisposed: 0, registerDisposed: 0 }
  return {
    tools: {
      guard(guard: (exec: unknown) => unknown) {
        guards.push(guard)
        return () => {
          counters.guardDisposed += 1
        }
      },
      register(tool: unknown) {
        registered.push(tool as RegisteredTool)
        return () => {
          counters.registerDisposed += 1
        }
      },
    },
    guards,
    registered,
    counters,
  }
}

/** 纯函数体测试用：runtime 公开面只有 tracker/config，内部 readUsage 不可枚举。 */
interface TestRuntime extends BudgetGuardRuntime {
  readonly readUsage: (session: unknown) => SessionUsageRead
}

function makeRuntime(
  config: ResolvedBudgetConfig,
  readUsage: (session: unknown) => SessionUsageRead,
): TestRuntime {
  const runtime: BudgetGuardRuntime = { tracker: new BudgetTracker({ config }), config }
  Object.defineProperty(runtime, 'readUsage', { value: readUsage, enumerable: false, configurable: true })
  return runtime as TestRuntime
}

function agentExec(name: string, sessionId = 'session-1'): unknown {
  return { name, agent: { id: 'agent-1', session: { id: sessionId } } }
}

// —— §3.4 tracker ——

test('tracker：AUTO 按首次命中的业务工具分类；未命中用 default_class；configured 固定', () => {
  const tracker = new BudgetTracker({ config: resolveBudgetConfig({}, {}) })
  assert.equal(tracker.taskClassOf('s0'), 'SCREENING')
  assert.equal(tracker.snapshot('s0', ZERO_USAGE).task_class_source, 'auto')

  tracker.noteAllowed('s1', 'record_human_decision')
  assert.equal(tracker.taskClassOf('s1'), 'DECISION')
  assert.equal(tracker.snapshot('s1', ZERO_USAGE).task_class_source, 'auto')
  assert.deepEqual({ ...tracker.snapshot('s1', ZERO_USAGE).limits }, { ...DEFAULT_LIMITS.DECISION })

  tracker.noteAllowed('s2', 'recruitment_trace_get')
  assert.equal(tracker.taskClassOf('s2'), 'SCREENING')

  const configured = new BudgetTracker({ config: resolveBudgetConfig({ task_class: 'DECISION' }, {}) })
  assert.equal(configured.taskClassOf('x'), 'DECISION')
  assert.equal(configured.snapshot('x', ZERO_USAGE).task_class_source, 'configured')
})

test('tracker：AUTO 分类 = 首个命中 tool_class_map 的业务工具（含自定义覆盖）', () => {
  const custom = new BudgetTracker({
    config: resolveBudgetConfig({ tool_class_map: { custom_decision_tool: 'DECISION' } }, {}),
  })
  custom.noteAllowed('s', 'recruitment_trace_get') // 未命中：仍用 default_class
  assert.equal(custom.taskClassOf('s'), 'SCREENING')
  custom.noteAllowed('s', 'custom_decision_tool')
  assert.equal(custom.taskClassOf('s'), 'DECISION')
  assert.equal(custom.snapshot('s', ZERO_USAGE).task_class_source, 'auto')
})

test('tracker：noteAllowed 计步/计数/last_tool；noteDenied 不计步、不改 last_tool；reset/sessions', () => {
  const tracker = new BudgetTracker({ config: resolveBudgetConfig({}, {}) })
  tracker.noteAllowed('s', 'recruitment_job_get')
  tracker.noteAllowed('s', 'recruitment_job_get')
  const snapshot = tracker.snapshot('s', usageOf(5))
  assert.equal(snapshot.steps, 2)
  assert.deepEqual(snapshot.tools_used, { recruitment_job_get: 2 })
  assert.equal(snapshot.last_tool, 'recruitment_job_get')

  tracker.noteDenied('s', 'record_human_decision')
  const afterDeny = tracker.snapshot('s', usageOf(5))
  assert.equal(afterDeny.steps, 2)
  assert.equal(afterDeny.last_tool, 'recruitment_job_get')
  assert.deepEqual(afterDeny.tools_used, { recruitment_job_get: 2 })

  assert.deepEqual(tracker.sessions(), ['s'])
  tracker.reset('s')
  assert.deepEqual(tracker.sessions(), [])
  assert.equal(tracker.snapshot('s', ZERO_USAGE).steps, 0)
})

// —— §3.7 闸门语义 ——

test('max_steps=1：第 1 次放行、第 2 次拒绝，且第 2 次 steps 已计（该次不放行）', () => {
  const config = resolveBudgetConfig(
    { task_class: 'SCREENING', SCREENING_MAX_STEPS: 1, SCREENING_MAX_TOKENS: 1000 },
    {},
  )
  const runtime = makeRuntime(config, () => usageOf(10))
  assert.equal(evaluateToolCall({ runtime, exec: agentExec('recruitment_resume_read'), tools: {} }), undefined)

  const denied = denialOf(
    evaluateToolCall({ runtime, exec: agentExec('recruitment_resume_read'), tools: {} }),
  )
  assert.equal(denied.info.name, 'BUDGET_EXCEEDED_HANDOFF')
  assert.equal(denied.info.code, 'BUDGET_EXCEEDED_HANDOFF')
  assert.match(denied.reason, /^BUDGET_EXCEEDED_HANDOFF\n/)
  assert.match(denied.reason, /steps=2 limit_steps=1/)
  for (const literal of HANDOFF_LITERALS) assert.ok(denied.reason.includes(literal), `缺少 ${literal}`)

  // steps 已计（含被拒绝的这一次），over 只报 steps
  const snapshot = runtime.tracker.snapshot('session-1', usageOf(10))
  assert.equal(snapshot.steps, 2)
  assert.equal(snapshot.within, false)
  assert.deepEqual(snapshot.over, [{ dimension: 'steps', used: 2, limit: 1 }])
})

test('边界：等于阈值算 within（tokens=limit / steps=limit 都放行）', () => {
  const config = resolveBudgetConfig(
    { task_class: 'SCREENING', SCREENING_MAX_TOKENS: 10, SCREENING_MAX_STEPS: 1 },
    {},
  )
  const runtime = makeRuntime(config, () => usageOf(10))
  assert.equal(evaluateToolCall({ runtime, exec: agentExec('recruitment_job_get'), tools: {} }), undefined)
  const snapshot = runtime.tracker.snapshot('session-1', usageOf(10))
  assert.equal(snapshot.steps, 1)
  assert.equal(snapshot.tokens.total, 10)
  assert.equal(snapshot.within, true)
  assert.deepEqual(snapshot.over, [])
})

test('调用前已超限：拒绝且 steps 不增加（noteDenied 不计步）', () => {
  const config = resolveBudgetConfig(
    { task_class: 'SCREENING', SCREENING_MAX_TOKENS: 10, SCREENING_MAX_STEPS: 5 },
    {},
  )
  const runtime = makeRuntime(config, () => usageOf(11))
  const denied = denialOf(evaluateToolCall({ runtime, exec: agentExec('recruitment_resume_read'), tools: {} }))
  assert.match(denied.reason, /tokens=11 limit_tokens=10/)
  assert.match(denied.reason, /last_tool=null/)

  const snapshot = runtime.tracker.snapshot('session-1', usageOf(11))
  assert.equal(snapshot.steps, 0)
  assert.deepEqual(snapshot.over, [{ dimension: 'tokens', used: 11, limit: 10 }])
  assert.deepEqual(snapshot.tools_used, {})
})

test('max_steps=0 配置非法：issue + 回退默认 15；第 15 次放行、第 16 次拒绝', () => {
  const config = resolveBudgetConfig(
    { task_class: 'SCREENING', SCREENING_MAX_STEPS: 0, SCREENING_MAX_TOKENS: 1000 },
    {},
  )
  assert.equal(config.limits.SCREENING.max_steps, 15)
  assert.ok(config.issues.some((issue) => issue.key === 'SCREENING_MAX_STEPS'))

  const runtime = makeRuntime(config, () => usageOf(0))
  for (let call = 1; call <= 15; call += 1) {
    assert.equal(
      evaluateToolCall({ runtime, exec: agentExec(`tool_${call}`), tools: {} }),
      undefined,
      `第 ${call} 次调用应放行`,
    )
  }
  const denied = denialOf(evaluateToolCall({ runtime, exec: agentExec('tool_16'), tools: {} }))
  assert.match(denied.reason, /steps=16 limit_steps=15/)
})

test('非法阈值回退默认 + issues（tokens 非数字）', () => {
  const config = resolveBudgetConfig({ SCREENING_MAX_TOKENS: 'abc' }, {})
  assert.equal(config.limits.SCREENING.max_tokens, 100000)
  assert.ok(config.issues.length >= 1)
  assert.equal(config.sources.SCREENING_MAX_TOKENS, 'default')
})

test('session 缺失 / session.id 为空 → 放行，且不建档、不计步（非 Agent 调用）', () => {
  const runtime = makeRuntime(resolveBudgetConfig({}, {}), () => usageOf(999999))
  const execs: readonly unknown[] = [
    undefined,
    null,
    {},
    { name: 'x' },
    { name: 'x', agent: null },
    { name: 'x', agent: {} },
    { name: 'x', agent: { session: null } },
    { name: 'x', agent: { session: {} } },
    { name: 'x', agent: { session: { id: '' } } },
    { name: 'x', agent: { session: { id: '   ' } } },
  ]
  for (const exec of execs) {
    assert.equal(evaluateToolCall({ runtime, exec, tools: {} }), undefined, `exec=${JSON.stringify(exec)}`)
  }
  assert.deepEqual(runtime.tracker.sessions(), [])
})

test('runtime 无内部 readUsage：按 unavailable 0 判定（不抛、不伪造用量）', () => {
  const config = resolveBudgetConfig({}, {})
  const tracker = new BudgetTracker({ config })
  const runtime: BudgetGuardRuntime = { tracker, config }
  assert.equal(evaluateToolCall({ runtime, exec: agentExec('recruitment_job_get'), tools: {} }), undefined)
  const snapshot = tracker.snapshot('session-1', ZERO_USAGE)
  assert.equal(snapshot.steps, 1)
  assert.equal(snapshot.usage_source, 'unavailable')
  // 公开面没有内部闭包字段
  assert.deepEqual(Object.keys(makeRuntime(config, () => ZERO_USAGE)), ['tracker', 'config'])
})

test('hooks.onDeny：收到 session/tool/快照；回调抛错不影响拒绝', () => {
  const config = resolveBudgetConfig({ task_class: 'SCREENING', SCREENING_MAX_STEPS: 1 }, {})
  const runtime = makeRuntime(config, () => usageOf(0))
  evaluateToolCall({ runtime, exec: agentExec('recruitment_job_get'), tools: {} })

  const seen: Array<{ session_id: string; tool: string; snapshot: { within: boolean; steps: number } }> = []
  const denied = denialOf(
    evaluateToolCall({
      runtime,
      exec: agentExec('recruitment_job_get'),
      tools: {},
      hooks: { onDeny: (info) => seen.push(info as unknown as (typeof seen)[number]) },
    }),
  )
  assert.equal(denied.info.code, 'BUDGET_EXCEEDED_HANDOFF')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.session_id, 'session-1')
  assert.equal(seen[0]!.tool, 'recruitment_job_get')
  assert.equal(seen[0]!.snapshot.within, false)
  assert.equal(seen[0]!.snapshot.steps, 2)

  const stillDenied = denialOf(
    evaluateToolCall({
      runtime,
      exec: agentExec('recruitment_job_get'),
      tools: {},
      hooks: {
        onDeny: () => {
          throw new Error('observer boom')
        },
      },
    }),
  )
  assert.equal(stillDenied.info.code, 'BUDGET_EXCEEDED_HANDOFF')
})

// —— §3.7 installBudgetGuard ——

test('installBudgetGuard：无 ctx.tools → 不抛 + TOOLS issue + no-op dispose（幂等）', () => {
  for (const ctx of [null, undefined, {}, { tools: null }, { tools: 'nope' }]) {
    const installed = installBudgetGuard(ctx, {}, {})
    assert.ok(
      installed.config.issues.some((issue) => issue.key === 'TOOLS'),
      `ctx=${JSON.stringify(ctx)} 应有 TOOLS issue`,
    )
    installed.dispose()
    installed.dispose()
  }
})

test('installBudgetGuard：ctx.tools 存在但 guard 不可用 → TOOLS_GUARD issue（不抛）', () => {
  const noGuard = installBudgetGuard({ tools: {} }, {}, {})
  assert.ok(noGuard.config.issues.some((issue) => issue.key === 'TOOLS_GUARD'))
  assert.match(
    noGuard.config.issues.find((issue) => issue.key === 'TOOLS_GUARD')!.message,
    /预算闸门未注册/,
  )
  noGuard.dispose()

  const throwing = installBudgetGuard(
    {
      tools: {
        guard: () => {
          throw new Error('cannot register')
        },
      },
    },
    {},
    {},
  )
  const issue = throwing.config.issues.find((entry) => entry.key === 'TOOLS_GUARD')
  assert.ok(issue !== undefined)
  assert.match(issue!.message, /注册失败/)
  throwing.dispose()
})

test('installBudgetGuard：status_tool=true 但 ctx.tools.register 不可用 → TOOLS_REGISTER issue（不抛）', () => {
  const installed = installBudgetGuard(
    { tools: { guard: () => () => undefined } },
    { status_tool: true },
    {},
  )
  assert.ok(installed.config.issues.some((issue) => issue.key === 'TOOLS_REGISTER'))
  installed.dispose()
})

test('installBudgetGuard：注册硬闸门；status_tool=false 默认不注册；dispose 幂等释放', () => {
  const fake = fakeTools()
  const installed = installBudgetGuard(
    { tools: fake.tools },
    { task_class: 'SCREENING', SCREENING_MAX_STEPS: 2, SCREENING_MAX_TOKENS: 1000 },
    {},
  )
  assert.equal(fake.guards.length, 1)
  assert.equal(fake.registered.length, 0)

  const guard = fake.guards[0]!
  assert.equal(guard(agentExec('a')), undefined)
  assert.equal(guard(agentExec('b')), undefined)
  const denied = denialOf(guard(agentExec('c')))
  assert.equal(denied.info.code, 'BUDGET_EXCEEDED_HANDOFF')
  assert.match(denied.reason, /steps=3 limit_steps=2/)

  installed.dispose()
  installed.dispose()
  assert.equal(fake.counters.guardDisposed, 1)
  assert.equal(fake.counters.registerDisposed, 0)
})

test('installBudgetGuard：真读 ctx.sessionProjections（四桶）→ 第二次调用因 tokens 超限被拒', () => {
  let reads = 0
  const stateOf = () => {
    reads += 1
    // 第 1 次调用：90000 tokens（在 100000 内）；第 2 次：110000（超限）
    const outputTokens = reads === 1 ? 30000 : 50000
    return {
      totals: { uncachedInputTokens: 60000, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
      last: { turn: reads === 1 ? 1 : 2, step: reads === 1 ? 4 : 8, buckets: {} },
    }
  }
  const fake = fakeTools()
  const installed = installBudgetGuard(
    { tools: fake.tools, sessionProjections: { stateOf } },
    { task_class: 'SCREENING', SCREENING_MAX_TOKENS: 100000, SCREENING_MAX_STEPS: 15 },
    {},
  )
  const guard = fake.guards[0]!

  assert.equal(guard(agentExec('recruitment_resume_read')), undefined)
  const denied = denialOf(guard(agentExec('recruitment_resume_read')))
  assert.match(denied.reason, /tokens=110000 limit_tokens=100000/)
  assert.match(denied.reason, /usage_source=session_projection\.tokenUsage/)
  assert.match(denied.reason, /dsh_step=8/)

  const usage: SessionUsageRead = {
    buckets: { uncached_input: 60000, output: 50000, cache_read: 0, cache_write: 0, total: 110000 },
    source: 'session_projection.tokenUsage',
    dsh_step: 8,
  }
  const snapshot = installed.tracker.snapshot('session-1', usage)
  assert.equal(snapshot.steps, 1) // 第二次被拒，不计步
  assert.deepEqual(snapshot.over, [{ dimension: 'tokens', used: 110000, limit: 100000 }])
})

test('installBudgetGuard：status_tool=true → 注册 recruitment_budget_status 且只读输出', async () => {
  const fake = fakeTools()
  const installed = installBudgetGuard(
    { tools: fake.tools },
    { task_class: 'SCREENING', SCREENING_MAX_STEPS: 5, SCREENING_MAX_TOKENS: 1000, status_tool: true },
    {},
  )
  assert.equal(fake.registered.length, 1)
  const tool = fake.registered[0]!
  assert.equal(tool.name, 'recruitment_budget_status')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, [])
  assert.equal(tool.isConcurrencySafe?.({}), true)

  fake.guards[0]!(agentExec('recruitment_job_get'))
  const value = (await tool.execute({}, {})) as {
    ok: boolean
    sessions: Array<{ session_id: string; steps: number; usage_source: string }>
    limits: unknown
    sources: unknown
    issues: unknown[]
  }
  assert.equal(value.ok, true)
  assert.equal(value.sessions.length, 1)
  assert.equal(value.sessions[0]!.session_id, 'session-1')
  assert.equal(value.sessions[0]!.steps, 1)
  assert.equal(value.sessions[0]!.usage_source, 'unavailable') // ctx 无计量服务：如实标注
  assert.deepEqual(value.limits, installed.config.limits)
  assert.deepEqual(value.sources, installed.config.sources)
  assert.deepEqual(value.issues, [])

  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0]!.type, 'text')
  assert.match(rendered[0]!.text, /"ok": true/)

  installed.dispose()
  installed.dispose()
  assert.equal(fake.counters.guardDisposed, 1)
  assert.equal(fake.counters.registerDisposed, 1)
})

test('enabled=false：不注册 guard、不注册 status 工具、不追加 issue、dispose 幂等 no-op', () => {
  const fake = fakeTools()
  const installed = installBudgetGuard(
    { tools: fake.tools },
    { enabled: false, status_tool: true, task_class: 'SCREENING', SCREENING_MAX_STEPS: 1 },
    {},
  )
  assert.equal(installed.config.enabled, false)
  assert.equal(installed.config.sources.ENABLED, 'profile')
  assert.equal(fake.guards.length, 0)
  assert.equal(fake.registered.length, 0)
  // 显式关闭不是错误：issues 不得追加任何条目
  assert.deepEqual(installed.config.issues, [])

  installed.dispose()
  installed.dispose()
  assert.equal(fake.counters.guardDisposed, 0)
  assert.equal(fake.counters.registerDisposed, 0)

  // 无 ctx.tools 时也不因「关闭」而报 TOOLS issue
  const noTools = installBudgetGuard(null, { enabled: false }, {})
  assert.equal(noTools.config.enabled, false)
  assert.deepEqual(noTools.config.issues, [])
  noTools.dispose()
})

test('cordis effect 语义回归：install 不注销；effect 登记 cleanup 后第 2 次仍 deny；执行 cleanup 才注销', () => {
  const fake = fakeTools()
  const cleanups: Array<() => void> = []
  // 真实 cordis 语义：effect(execute) **立即执行** execute，登记其返回的 cleanup；
  // 这里返回 `() => cleanup()` 供测试模拟 scope 销毁（**不是** effect:(fn)=>fn() 的假实现）。
  const ctx = {
    tools: fake.tools,
    effect: (execute: () => () => void): (() => void) => {
      const cleanup = execute()
      cleanups.push(cleanup)
      return () => cleanup()
    },
  }

  const installed = installBudgetGuard(
    ctx,
    { task_class: 'SCREENING', SCREENING_MAX_STEPS: 1, SCREENING_MAX_TOKENS: 1000 },
    {},
  )

  // A) 装完立即检查：guard 已注册且**未**注销（防「装完即卸」回归）
  assert.equal(fake.guards.length, 1)
  assert.equal(fake.counters.guardDisposed, 0)

  // 接线 patch 同形：把 dispose 挂到 ctx.effect；登记动作本身不得触发 dispose
  const disposeFromEffect = ctx.effect(() => installed.dispose)
  assert.equal(cleanups.length, 1)
  assert.equal(fake.counters.guardDisposed, 0)

  // B) effect 登记后闸门仍生效：第 2 次工具调用被 deny
  const guard = fake.guards[0]!
  assert.equal(guard(agentExec('a')), undefined)
  const denied = denialOf(guard(agentExec('b')))
  assert.equal(denied.info.code, 'BUDGET_EXCEEDED_HANDOFF')
  assert.match(denied.reason, /steps=2 limit_steps=1/)

  // C) 只有执行 effect 登记的 cleanup 才注销 guard；重复 dispose 幂等
  disposeFromEffect()
  assert.equal(fake.counters.guardDisposed, 1)
  installed.dispose()
  assert.equal(fake.counters.guardDisposed, 1)
})

// —— §3.8 status 工具（独立构造） ——

test('status 工具：readUsage 正常 → 快照带真实 usage；异常 → unavailable；配置 issues → ok=false', async () => {
  const config = resolveBudgetConfig({ SCREENING_MAX_STEPS: 0 }, {})
  assert.ok(config.issues.length >= 1)
  const tracker = new BudgetTracker({ config })
  tracker.noteAllowed('s1', 'recruitment_job_get')

  const tool = createBudgetStatusTool({ tracker, config }, () => usageOf(42, 3))
  const value = (await tool.execute({}, {})) as {
    ok: boolean
    sessions: Array<{
      session_id: string
      task_class: string
      tokens: { total: number }
      dsh_step: number | null
      steps: number
      usage_source: string
    }>
  }
  assert.equal(value.ok, false) // 有 fail-closed issue
  assert.equal(value.sessions.length, 1)
  assert.equal(value.sessions[0]!.session_id, 's1')
  assert.equal(value.sessions[0]!.task_class, 'SCREENING')
  assert.equal(value.sessions[0]!.tokens.total, 42)
  assert.equal(value.sessions[0]!.dsh_step, 3)
  assert.equal(value.sessions[0]!.steps, 1)
  assert.equal(value.sessions[0]!.usage_source, 'session_projection.tokenUsage')

  const throwing = createBudgetStatusTool({ tracker, config }, () => {
    throw new Error('boom')
  })
  const degraded = (await throwing.execute({}, {})) as { sessions: Array<{ usage_source: string; tokens: { total: number } }> }
  assert.equal(degraded.sessions[0]!.usage_source, 'unavailable')
  assert.equal(degraded.sessions[0]!.tokens.total, 0)

  const garbage = createBudgetStatusTool({ tracker, config }, () => 'not-a-usage')
  const garbageValue = (await garbage.execute({}, {})) as { sessions: Array<{ usage_source: string }> }
  assert.equal(garbageValue.sessions[0]!.usage_source, 'unavailable')
})

test('status 工具：无活跃会话 → sessions=[] 且 payload 形态固定（ok/sessions/limits/sources/issues）', async () => {
  const config = resolveBudgetConfig({}, {})
  const tracker = new BudgetTracker({ config })
  const tool = createBudgetStatusTool({ tracker, config }, () => ZERO_USAGE)
  const value = (await tool.execute({}, {})) as Record<string, unknown>
  assert.deepEqual(Object.keys(value).sort(), ['issues', 'limits', 'ok', 'sessions', 'sources'])
  assert.deepEqual(value.sessions, [])
  assert.equal(value.ok, true)
  assert.deepEqual(value.issues, [])
})
