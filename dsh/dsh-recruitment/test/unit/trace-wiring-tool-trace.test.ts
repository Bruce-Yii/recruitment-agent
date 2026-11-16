// `src/tools/traced.ts`（工具调用留痕包装器）的 **接线机检（不连库）**：
//
//   1. 数据库未配置 ⇒ mapper 原样返回同一个工具引用（identity，不包 execute）；
//   2. 已配置 ⇒ 浅拷贝保留全部工具字段，只替换 execute；
//   3. execute 内**先**算 callRef 与 actor，再把 database/tool/args/exec/callRef/actorId
//      交给 record；返回值 = 记录结果的 `.value`；原工具只被执行一次；
//   4. callRef：`toolName:callId`；缺 callId ⇒ undefined（记录层用随机值）；
//      总长 >200 ⇒ 确定性 sha256 形式（两次调用相同、长度 ≤200）；
//   5. actor：已绑定 session ⇒ 该 alias 的 HUMAN actor；未绑定 / identity 缺省 ⇒ 回退 fallback 且不抛；
//      回退时**不**给 record 传 actorId（让 runTracedToolCall 用 database.actor_id 默认）；
//   6. 失败口径不被包装器改写：工具抛错 ⇒ 原错误对象原样抛出；
//      工具成功但记录失败 ⇒ `TRACE_RECORD_FAILED` 原样透传（不吞）。
//
// 所有 fake record 都在进程内执行，本文件不建立任何数据库连接（CFG 端口 1 未被监听）。
import test from 'node:test'
import assert from 'node:assert/strict'

import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { TracedToolCallOptions, TracedToolCallResult } from '../../src/domain/trace.ts'
import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/resolve.ts'
import type { ReadonlyToolDefinition } from '../../src/tools/definition.ts'
import {
  resolveTraceActorId,
  toolCallRefFor,
  withToolCallTrace,
} from '../../src/tools/traced.ts'

/**
 * 指向**未监听端口**的库配置：任何"真的想连库"的路径都会立刻连接失败。
 * 本文件的 record 全部是注入的 fake，所以用例通过 = 没有发生连接。
 */
const CFG = {
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  database: 'ra_trace_wiring_never_connect',
  password: 'unused-in-this-test',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
  statement_timeout_ms: 15_000,
  connect_timeout_ms: 2_000,
  max: 2,
} as ResolvedDatabaseConfig

/** 已绑定的 DSH session（`session-<uuid>`）。 */
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
/** 未绑定的 DSH session（形态合法，注册表里没有）。 */
const SESSION_UNBOUND = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** 工具返回值（用真实业务 id 形状，便于对照 record 收到的 args / value）。 */
const VALUE = {
  application_id: '11111111-1111-4111-8111-0000000007a1',
  outcome: 'SUCCEEDED',
}

/** 注入的 record 形状（与 `runTracedToolCall` 同签名）。 */
type RecordFn = (options: TracedToolCallOptions) => Promise<TracedToolCallResult>

/**
 * 造一个工具定义（只实现 `ReadonlyToolDefinition` 的字段）。
 * @param execute - 真正的工具执行体。
 * @returns 可直接交给 mapper 的工具定义。
 */
function makeTool(
  execute: (args: unknown, exec: unknown) => Promise<unknown>,
): ReadonlyToolDefinition {
  return {
    name: 'echo',
    description: '测试用工具：把 args 原样返回',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: () => [{ type: 'text', text: 'ok' }],
    },
    isConcurrencySafe: () => true,
    execute,
  }
}

/**
 * 造一个"诚实记账"的 fake record：先真的执行工具，再返回记录结果（成功态）。
 * @param seen - 收集每次收到的 options（用于断言调用顺序与参数）。
 * @returns record 函数。
 */
function succeedingRecord(seen: TracedToolCallOptions[]): RecordFn {
  return async (options) => {
    seen.push(options)
    const value = await options.tool.execute(options.args, options.exec)
    return {
      value,
      tool_call_id: `tool-call-${seen.length}`,
      correlation_id: 'corr-1',
      outcome: 'SUCCEEDED',
    }
  }
}

/**
 * 装配一个"已绑定 recruiter"的身份。
 * @returns 身份（`identity.actors.recruiter` 即该 alias 的 HUMAN actor UUID）。
 */
function boundIdentity(): DemoActorIdentity {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'recruiter')
  return identity
}

test('database:null ⇒ mapper 原样返回同一个工具引用（不包 execute，也不调用 record）', () => {
  const tool = makeTool(async () => VALUE)
  const mapper = withToolCallTrace({ database: null })
  assert.equal(mapper(tool), tool, '未配置数据库时必须返回同一个引用')
  assert.equal(mapper(tool).execute, tool.execute, 'execute 不能被替换')

  // 即使注入了 record，也不能因为留痕把只读工具变红：没有 trace store 就是 identity。
  const mapperWithRecord = withToolCallTrace({
    database: null,
    record: async () => {
      throw new Error('database=null 时 record 绝不该被调用')
    },
  })
  assert.equal(mapperWithRecord(tool), tool)
})

test('属性保留：浅拷贝 + 只替换 execute（name/description/parameters/output/isConcurrencySafe 不变）', () => {
  const tool = makeTool(async () => VALUE)
  const wrapped = withToolCallTrace({ database: CFG, identity: boundIdentity() })(tool)

  assert.notEqual(wrapped, tool, '已配置数据库时必须返回包装对象')
  assert.equal(wrapped.name, tool.name)
  assert.equal(wrapped.description, tool.description)
  assert.equal(wrapped.parameters, tool.parameters)
  assert.equal(wrapped.output, tool.output)
  assert.equal(wrapped.isConcurrencySafe, tool.isConcurrencySafe)
  assert.deepEqual(Object.keys(wrapped), Object.keys(tool), '浅拷贝不应增删字段')
  assert.equal(typeof wrapped.execute, 'function')
  assert.notEqual(wrapped.execute, tool.execute, 'execute 必须是新的包装函数')
})

test('成功路径：先算 callRef/actor 再 record；原工具执行一次、返回值透传', async () => {
  const identity = boundIdentity()
  const exec = { callId: 'call-1', agent: { id: SESSION_A } }
  const args = { application_id: VALUE.application_id }
  let toolExecutions = 0
  let receivedArgs: unknown
  let receivedExec: unknown
  const tool = makeTool(async (toolArgs, toolExec) => {
    toolExecutions += 1
    receivedArgs = toolArgs
    receivedExec = toolExec
    return VALUE
  })
  const seen: TracedToolCallOptions[] = []
  const wrapped = withToolCallTrace({ database: CFG, identity, record: succeedingRecord(seen) })(tool)

  const value = await wrapped.execute(args, exec)

  assert.deepEqual(value, VALUE, '返回值必须是 record 结果的 .value')
  assert.equal(toolExecutions, 1, '原工具必须只被执行一次')
  assert.equal(seen.length, 1, 'record 必须被调用一次')
  const options = seen[0]!
  assert.equal(options.database, CFG)
  assert.equal(options.tool.name, 'echo')
  assert.equal(typeof options.tool.execute, 'function')
  assert.equal(options.args, args)
  assert.equal(options.exec, exec)
  assert.equal(options.callRef, 'echo:call-1', 'callRef = toolName:callId')
  assert.equal(options.actorId, identity.actors.recruiter, 'actorId = 绑定 alias 的 HUMAN actor')
  assert.equal(resolveTraceActorId(exec, identity, CFG.actor_id), identity.actors.recruiter)
  // 转发语义：record 调用 tool.execute 时，原工具收到的是同一次调用的 args / exec。
  assert.equal(receivedArgs, args)
  assert.equal(receivedExec, exec)
  // FK 事实（迁移 0013）：agent_session 目前 0 行，不许把宿主 session id 填进 agent_session_id。
  assert.equal(Object.hasOwn(options, 'agentSessionId'), false)
})

test('无 callId ⇒ toolCallRefFor 返回 undefined（记录层用随机值，重放会多一行）', () => {
  assert.equal(toolCallRefFor('echo', {}), undefined)
  assert.equal(toolCallRefFor('echo', { callId: '' }), undefined)
  assert.equal(toolCallRefFor('echo', { callId: '   ' }), undefined)
  assert.equal(toolCallRefFor('echo', { callId: 42 }), undefined)
  assert.equal(toolCallRefFor('echo', undefined), undefined)
  assert.equal(toolCallRefFor('echo', null), undefined)
  assert.equal(toolCallRefFor('echo', 'not-an-object'), undefined)
})

test('无 callId 时 wrapper 不给 record 传 callRef（让 runner 用随机幂等键）', async () => {
  const seen: TracedToolCallOptions[] = []
  const wrapped = withToolCallTrace({
    database: CFG,
    identity: boundIdentity(),
    record: succeedingRecord(seen),
  })(makeTool(async () => VALUE))

  await wrapped.execute({}, { agent: { id: SESSION_A } })
  assert.equal(seen[0]!.callRef, undefined)
  assert.equal(Object.hasOwn(seen[0]!, 'callRef'), false)
})

test('callId 使总长 >200 ⇒ 确定性 sha256 形式（两次调用相同、长度 ≤200；200 边界仍是明文）', () => {
  const tooLong = 'c'.repeat(196) // 'echo:' 5 + 196 = 201 > 200
  const first = toolCallRefFor('echo', { callId: tooLong })
  assert.ok(first !== undefined)
  const second = toolCallRefFor('echo', { callId: tooLong })
  assert.equal(second, first, '同一 callId 的 ref 必须确定性一致（重放仍幂等）')
  assert.match(first, /^echo:sha256:[0-9a-f]{64}$/)
  assert.ok(first.length <= 200, `call_ref 不能超表约束，实际 ${first.length}`)

  // 边界：恰好 200 仍是 `toolName:callId` 明文形式。
  const exact = toolCallRefFor('echo', { callId: 'c'.repeat(195) })
  assert.equal(exact, `echo:${'c'.repeat(195)}`)
  assert.equal(exact?.length, 200)

  // 不同 callId 不能撞成同一个 ref。
  const other = toolCallRefFor('echo', { callId: 'c'.repeat(197) })
  assert.ok(other !== undefined)
  assert.notEqual(other, first)
})

test('identity 未绑定 session ⇒ actor 回退 fallback（不抛），且不把回退值当"真实 actor"传给 record', async () => {
  const identity = boundIdentity()
  const exec = { callId: 'call-2', agent: { id: SESSION_UNBOUND } }

  // 公开 API：任何解析异常都吞掉回退，读工具不因身份未绑定而失败。
  assert.equal(resolveTraceActorId(exec, identity, CFG.actor_id), CFG.actor_id)
  // identity 缺省：直接 fallback（既有默认 actor，不伪造执行者）。
  assert.equal(resolveTraceActorId(exec, undefined, CFG.actor_id), CFG.actor_id)

  const seen: TracedToolCallOptions[] = []
  const wrapped = withToolCallTrace({
    database: CFG,
    identity,
    record: succeedingRecord(seen),
  })(makeTool(async () => VALUE))

  await wrapped.execute({}, exec)
  assert.equal(seen[0]!.actorId, undefined, '解析不到真实 actor 时省略 actorId，交给 database.actor_id 默认')
  assert.equal(Object.hasOwn(seen[0]!, 'actorId'), false)
})

test('工具抛错 ⇒ wrapper 原样抛出同一错误对象（不吞、不改 message / code）', async () => {
  const identity = boundIdentity()
  const failure = Object.assign(new Error('boom'), { code: 'SOME_TOOL_CODE' })
  const tool = makeTool(async () => {
    throw failure
  })
  // 镜像 runTracedToolCall：fake 内部先真的执行工具（让它抛），自己不 catch、不改写。
  const record: RecordFn = async (options) => {
    const value = await options.tool.execute(options.args, options.exec)
    return { value, tool_call_id: 'tool-call-x', correlation_id: 'corr-x', outcome: 'SUCCEEDED' }
  }
  const wrapped = withToolCallTrace({ database: CFG, identity, record })(tool)

  await assert.rejects(
    () => wrapped.execute({}, { callId: 'call-3', agent: { id: SESSION_A } }),
    (error: unknown) => {
      assert.equal(error, failure, '必须是同一个错误对象')
      assert.equal((error as Error).message, 'boom')
      assert.equal((error as { code?: string }).code, 'SOME_TOOL_CODE')
      return true
    },
  )
})

test('工具成功但记录失败 ⇒ wrapper 透传 TRACE_RECORD_FAILED（不吞记录失败）', async () => {
  const identity = boundIdentity()
  let toolExecutions = 0
  const tool = makeTool(async () => {
    toolExecutions += 1
    return VALUE
  })
  const recordFailure = new Error('TRACE_RECORD_FAILED: 工具 echo 调用成功但 tool_call 记录失败：注入的写库失败')
  // 工具确实成功执行；记录阶段失败（与 runTracedToolCall 的成功+记录失败分支一致）。
  const record: RecordFn = async (options) => {
    await options.tool.execute(options.args, options.exec)
    throw recordFailure
  }
  const wrapped = withToolCallTrace({ database: CFG, identity, record })(tool)

  await assert.rejects(
    () => wrapped.execute({}, { callId: 'call-4', agent: { id: SESSION_A } }),
    (error: unknown) => {
      assert.equal(error, recordFailure, '记录失败必须原样透传')
      assert.match((error as Error).message, /TRACE_RECORD_FAILED/)
      return true
    },
  )
  assert.equal(toolExecutions, 1, '工具确实执行过一次，证明不是被工具错误短路')
})
