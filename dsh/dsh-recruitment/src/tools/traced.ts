// 工具调用留痕（trace wiring）：在**工具注册处**包一层，把每次真实调用落成
// `recruitment.tool_call` 一行（写路径复用 `src/domain/trace.ts`，本文件不重写记录逻辑）。
//
// 为什么包在注册处，而不是改 30 个工具：
//   * 工具本体不认识追溯层，也不应该认识——trace.ts 的既有约定是"记录发生在调用之后，
//     用工具**自己返回的**业务 id 去反查同一条 correlation"，记的是外部可观察的真实调用；
//   * 30 个工具各写一遍 = 30 份会漂移的重复实现，而且以后新增工具一定会漏；
//   * 注册处（`src/index.ts` 注册工具时套 `withToolCallTrace(...)`）是唯一收口：
//     工具定义本身（name / description / parameters / output / isConcurrencySafe）一个字不改，
//     包装器只做**浅拷贝 + 只替换 execute**。
//
// append-only 与"崩溃边界"（已知边界，不掩盖）：
//   tool_call 是**单行**表（迁移 0013：update/delete 触发器直接拒绝），没有 STARTED / ENDED
//   两行。因此一次调用**只在结束时落一行**：开始时刻只在内存里取时间戳（由
//   `runTracedToolCall` 的 `startedAt` 持有），进程崩溃 / 被 kill 在这一行写入之前 =
//   **库里没有这次调用的痕迹**。这是已知边界，不是"稍后补"；我们**不**谎称存在 started 行，
//   也不伪造一行 NOT_RUN 假装记录完整。
//
// 失败口径（沿用 trace.ts 的既有语义，本包装器**不 catch、不改写、不放宽**）：
//   * 工具失败 → `runTracedToolCall` 先落 outcome=FAILED（带 error_code），再把**原错误原样
//     抛出**（不吞、不改 message / code）；
//   * 工具成功但记录失败 → 抛 `TRACE_RECORD_FAILED`（宁可红，也不要"调用发生了但没有记录"）。
//   本文件只负责把 `record(...)` 的返回值 `.value` 交回去、让错误照原样冒到调用方。
//
// 数据库未配置（`deps.database === null`）时的取舍：
//   没有 trace store 就记不了，此时 mapper **原样返回同一个工具引用**（identity，不包
//   execute）。理由：留痕是**附加**能力，不能让本来不依赖数据库的只读工具因为"没配
//   trace 库"而失败；同理也不会退化成"静默不记但假装记了"——调用方从 database=null
//   就能知道没有留痕。
//
// correlation 的来源（不伪造业务关联）：
//   `runTracedToolCall` 在记录事务里从工具返回值的 business_refs 反查既有业务对象：反查到就
//   **继承**同一个 correlation_id（同一条执行链）；没有业务引用 / 反查不到就**新开一条链**
//   （randomUUID）。本包装器不猜业务 id、不合成关联，也不把 session id 当成业务归属。
//
// 关于 agent_session_id：**不填**。迁移 0013 的 fk_tool_call_session 指向
//   `recruitment.agent_session (id, tenant_id)`，而该表当前**没有产品写入方（0 行）**；
//   把 `exec.agent.id`（宿主 session id）写进 agent_session_id 会直接撞 FK。session id 属于
//   宿主执行上下文，不是 agent_session 行的 id。
import { createHash } from 'node:crypto'

import type { ResolvedDatabaseConfig } from '../db/pool.ts'
import {
  runTracedToolCall,
  type TracedToolCallOptions,
  type TracedToolCallResult,
} from '../domain/trace.ts'
import {
  readExecSessionId,
  resolveSessionActor,
  type DemoActorIdentity,
} from '../demo-actor/resolve.ts'
import type { ReadonlyToolDefinition } from './definition.ts'

/**
 * `call_ref` 的数据库上限：迁移 0013 `ck_tool_call_ref check (length(btrim(call_ref)) between 1 and 200)`。
 * 工具名另有 `ck_tool_call_name`（1..120），所以 sha256 兜底形式
 * `${toolName}:sha256:<hex64>` 最长 120 + 8 + 64 = 192，不会反向超限。
 */
const MAX_CALL_REF_LENGTH = 200

/** 包装器依赖（由注册处装配；产品路径不传 `record`）。 */
export interface ToolCallTraceDeps {
  /** 已解析的库配置；`null` = 数据库未配置（此时 mapper 原样返回工具）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** Demo Actor 身份（可选；缺省 = 全部按数据库配置里的 actor 记账）。 */
  readonly identity?: DemoActorIdentity
  /** 测试注入点：默认 = `runTracedToolCall`；产品路径不传。 */
  readonly record?: (options: TracedToolCallOptions) => Promise<TracedToolCallResult>
}

/**
 * 造一个"注册时套一层"的 mapper。
 * @param deps - 库配置 + 身份 + 可选记录注入点。
 * @returns `tool => tool`（数据库未配置）或 `tool => {...tool, execute: 包装后的 execute}`。
 */
export function withToolCallTrace(
  deps: ToolCallTraceDeps,
): (tool: ReadonlyToolDefinition) => ReadonlyToolDefinition {
  const database = deps.database
  if (database === null) {
    // 没有 trace store 就不能记：原样返回**同一个引用**，绝不包一层假装会记。
    return (tool) => tool
  }
  const identity = deps.identity
  const record = deps.record ?? runTracedToolCall
  return (tool) => ({
    // 浅拷贝保留全部字段（name / description / parameters / output / isConcurrencySafe…），
    // 只替换 execute；读工具因此仍是同样的参数校验、同样的输出声明。
    ...tool,
    execute: async (args: unknown, exec: unknown): Promise<unknown> => {
      // 顺序是硬要求：先取"调用开始时"的幂等键与执行者身份，再把执行交给记录适配器。
      const callRef = toolCallRefFor(tool.name, exec)
      const actorId = tryResolveTraceActorId(exec, identity)
      const result = await record({
        database,
        // 只把 name + execute 交给记录层：不 import 任何工具模块（避免循环依赖），
        // 也不让记录层接触工具定义里的其它字段。
        tool: {
          name: tool.name,
          execute: (innerArgs, innerExec) => tool.execute(innerArgs, innerExec),
        },
        args,
        exec,
        ...(callRef === undefined ? {} : { callRef }),
        // 只有能从 exec 解析出**真实** actor 时才显式给；否则省略，让 runTracedToolCall
        // 走 database.actor_id 这个既有默认（不伪造执行者）。
        ...(actorId === undefined ? {} : { actorId }),
      })
      // 失败口径已在 runTracedToolCall 内处理：能走到这里就是成功，错误不在这里 catch。
      return result.value
    },
  })
}

/**
 * 一次调用的幂等键 `call_ref`。
 *
 * 口径：
 *   * `exec.callId` 是合法非空字符串 → `toolName + ':' + callId`；
 *   * 该串总长超过 200（表约束）→ 确定性的 `${toolName}:sha256:<hex64>`（同一 callId
 *     重放仍得到同一个 ref，幂等不破）；
 *   * 没有 callId → `undefined`：交给 `runTracedToolCall` 用 `toolName:randomUUID()`。
 *     此时**重放会多一行**——这是调用方的责任（宿主是否稳定给 callId），本文件不替它编 id。
 * @param toolName - 工具名（进 ref 前缀，便于按工具排查）。
 * @param exec - DSH `ToolRunContext`（按结构防御，任意形态都不抛）。
 * @returns call_ref；没有可用 callId 时 `undefined`。
 */
export function toolCallRefFor(toolName: string, exec: unknown): string | undefined {
  const callId = readCallId(exec)
  if (callId === undefined) return undefined
  const plain = `${toolName}:${callId}`
  if (plain.length <= MAX_CALL_REF_LENGTH) return plain
  // 超长时用 sha256 收窄：输入 = 明文 candidate（确定性），两次调用得到同一个 ref。
  const digest = createHash('sha256').update(plain, 'utf8').digest('hex')
  return `${toolName}:sha256:${digest}`
}

/**
 * 解析这次调用的**记账 actor**（供只读工具与排障使用）。
 *
 * 口径：
 *   * `identity === undefined` → fallback（数据库配置里的 `actor_id`，既有默认）；
 *   * 否则 `readExecSessionId(exec)` 取 session → `resolveSessionActor(identity, session)`
 *     取 `actor_id`；
 *   * **任何异常都吞掉回退 fallback**：读工具不该因为身份未绑定而失败；写工具自己会在
 *     开事务前 fail-closed（`DEMO_ACTOR_UNMAPPED`），不靠这里把关。
 *   * **不**把 session id 写进 `agent_session_id`（见文件头 FK 说明）。
 * @param exec - DSH `ToolRunContext`。
 * @param identity - 已装配的身份（可选）。
 * @param fallbackActorId - 解析不出真实 actor 时使用的既有默认 actor。
 * @returns 一个非空 actor id（最差情况 = fallback）。
 */
export function resolveTraceActorId(
  exec: unknown,
  identity: DemoActorIdentity | undefined,
  fallbackActorId: string,
): string {
  return tryResolveTraceActorId(exec, identity) ?? fallbackActorId
}

// ---------------------------------------------------------------------------
//  内部小工具
// ---------------------------------------------------------------------------

/**
 * 尝试解析**真实**执行者（解析不出返回 `undefined`，绝不抛）。
 * @param exec - DSH `ToolRunContext`。
 * @param identity - 已装配的身份（可选）。
 * @returns 绑定的 HUMAN actor id；无身份 / 无 session / 未绑定 / alias 无映射 → `undefined`。
 */
function tryResolveTraceActorId(
  exec: unknown,
  identity: DemoActorIdentity | undefined,
): string | undefined {
  if (identity === undefined) return undefined
  try {
    const observed = readExecSessionId(exec)
    if (observed === undefined) return undefined
    const resolved = resolveSessionActor(identity, observed.session_id)
    const actorId = typeof resolved.actor_id === 'string' ? resolved.actor_id.trim() : ''
    return actorId === '' ? undefined : actorId
  } catch {
    // 身份未绑定 / session 形态非法：读工具照常执行，记账退回既有默认 actor。
    // （写工具会在自己的事务前 fail-closed，这里吞掉不会放宽任何写闸门。）
    return undefined
  }
}

/**
 * 从 `exec.callId` 读幂等键（DSH `ToolRunContext.callId` 是 branded string）。
 * @param exec - 任意形态的执行上下文。
 * @returns 非空字符串 callId；缺失 / 空白 / 非字符串 → `undefined`。
 */
function readCallId(exec: unknown): string | undefined {
  const record = asRecord(exec)
  const raw = record?.callId
  if (typeof raw !== 'string') return undefined
  return raw.trim() === '' ? undefined : raw
}

/**
 * 把 `unknown` 收窄成普通对象（数组 / null 不算对象）。
 * @param value - 任意值。
 * @returns 对象或 `undefined`。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
