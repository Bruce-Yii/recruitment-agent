// 执行上下文（DSH `exec`）→ Demo Actor 的严格解析。
//
// 唯一事实链：`exec.agent.id`（= DSH Agent Session ID，形如 `session-<uuid>`）
//   → `SessionActorRegistry` 里的 `session_id → alias` 绑定
//   → `DemoActorMap` 里的 `alias → HUMAN actor UUID`。
//
// 为什么这条链上**任何一环缺失都必须拒绝**（`DEMO_ACTOR_UNMAPPED`）：
//   写工具的数据库作者身份来自事务 GUC（`SET LOCAL recruitment.actor_id`），
//   如果这里静默回退到插件配置的 `database.actor_id`，浏览器选的 A/B 就变成了摆设 ——
//   两份面评会记到同一个作者头上，演示就"看起来通过"了。宁可 fail-closed。
//
// 读取顺序（冻结口径，前者优先）：
//   1. `exec.agent.id`              —— DSH 正常运行时的唯一来源（`ToolExecutionInput.agent`）
//   2. `exec.agent.sessionId`       —— 防御：不同宿主封装里可能是这个字段名
//   3. `exec.session_id`            —— 防御：测试/适配层直接塞 session id
//   4. `exec.headers['x-dsh-session']` —— 受控 header 兜底（`DEMO_SESSION_HEADER`）
// 任一来源取不到**合法** session 就继续往下找；四个都取不到 → `DEMO_ACTOR_UNMAPPED`。

import { RecruitmentToolError } from '../tools/errors.ts'
import {
  resolveDemoActorMap,
  type DemoActorAlias,
  type DemoActorMap,
  type DemoActorMapConfig,
} from './alias.ts'
import {
  DEMO_SESSION_HEADER,
  SessionActorRegistry,
  normalizeSessionId,
} from './session-registry.ts'

/** 一次装配好的 Demo Actor 身份：映射表 + 进程内 session 注册表（由 `src/index.ts` 持有单例）。 */
export interface DemoActorIdentity {
  /** alias → HUMAN actor UUID（缺省映射 or 插件配置覆盖后的结果）。 */
  readonly actors: DemoActorMap
  /** 进程内 session → alias 绑定表。 */
  readonly registry: SessionActorRegistry
}

/** `readExecSessionId` 命中的来源（前三个是防御性来源，产品路径是第一个）。 */
export type ExecSessionSource =
  | 'exec.agent.id'
  | 'exec.agent.sessionId'
  | 'exec.session_id'
  | 'exec.headers.x-dsh-session'

/** 一次成功解析的执行者（写工具用它设事务 GUC；输出里可带 `alias` 做可读回显）。 */
export interface ResolvedExecutionActor {
  /** 规范 session id：`session-<lowercase uuid>`。 */
  readonly session_id: string
  /** 该 session 选定的受控 alias。 */
  readonly alias: DemoActorAlias
  /** 该 alias 映射到的 HUMAN actor UUID（写工具唯一可用的作者身份）。 */
  readonly actor_id: string
  /** 本结果来自哪个 exec 字段（或 `'explicit.session_id'`）。 */
  readonly source: string
  /** 显示名快照（可选；注册表里有就带上，不参与判定）。 */
  readonly display_name?: string
}

/**
 * 从 DSH `exec` 里读出当前 Session ID。
 * @param exec - DSH 的 `ToolRunContext`（工具里类型是 `unknown`，这里按结构防御）。
 * @returns `{session_id, source}`；四个来源都取不到合法 session 时为 `undefined`。
 */
export function readExecSessionId(
  exec: unknown,
): { session_id: string; source: ExecSessionSource } | undefined {
  const record = asRecord(exec)
  if (record === undefined) return undefined
  const agent = asRecord(record.agent)
  const candidates: readonly (readonly [ExecSessionSource, unknown])[] = [
    ['exec.agent.id', agent?.id],
    ['exec.agent.sessionId', agent?.sessionId],
    ['exec.session_id', record.session_id],
    ['exec.headers.x-dsh-session', readHeader(record.headers, DEMO_SESSION_HEADER)],
  ]
  for (const [source, raw] of candidates) {
    const sessionId = normalizeSessionId(raw)
    if (sessionId !== null) return { session_id: sessionId, source }
  }
  return undefined
}

/**
 * 从执行上下文解析执行者（写工具的唯一入口）。
 * @param exec - DSH 的 `ToolRunContext`。
 * @param identity - 已装配的身份（映射表 + 注册表）。
 * @returns 解析结果（session / alias / actor / 来源 / 可选 display_name）。
 * @throws RecruitmentToolError - `DEMO_ACTOR_UNMAPPED`（取不到 session / 未绑定 / alias 无映射）。
 */
export function resolveExecutionActor(
  exec: unknown,
  identity: DemoActorIdentity,
): ResolvedExecutionActor {
  const observed = readExecSessionId(exec)
  if (observed === undefined) {
    throw unmapped('SESSION_SOURCE_MISSING', {
      sources: ['exec.agent.id', 'exec.agent.sessionId', 'exec.session_id', 'exec.headers.x-dsh-session'],
    })
  }
  return resolveBoundSession(identity, observed.session_id, observed.source)
}

/**
 * 从**显式** session id 解析执行者（Host Remote Action 用：`X-DSH-Session` header
 * 已经过 `normalizeSessionId` 校验后传进来；这里再做一次归一与绑定查找）。
 * @param identity - 已装配的身份。
 * @param sessionId - 原始 session id（`session-<uuid>` 或裸 UUID）。
 * @returns 解析结果（`source='explicit.session_id'`）。
 * @throws RecruitmentToolError - `DEMO_ACTOR_UNMAPPED`（形态非法 / 未绑定 / alias 无映射）。
 */
export function resolveSessionActor(
  identity: DemoActorIdentity,
  sessionId: unknown,
): ResolvedExecutionActor {
  const normalized = normalizeSessionId(sessionId)
  if (normalized === null) {
    throw unmapped('SESSION_ID_INVALID', { session_id: printable(sessionId) })
  }
  return resolveBoundSession(identity, normalized, 'explicit.session_id')
}

/**
 * 装配身份（`src/index.ts` 调用一次，工具与 HTTP 共享同一个实例）。
 * @param config - 插件配置的 `demo_actor_map`（缺省 = `DEFAULT_DEMO_ACTOR_MAP`）。
 * @returns `{identity, issues}`：`issues` 来自配置里非法的 alias 映射（合法 alias 仍可用）。
 */
export function createDemoActorIdentity(
  config?: DemoActorMapConfig,
): { identity: DemoActorIdentity; issues: readonly string[] } {
  const { map, issues } = resolveDemoActorMap(config)
  return {
    identity: { actors: map, registry: new SessionActorRegistry() },
    issues,
  }
}

/**
 * 共用的一步：session 必须已绑定，且 alias 必须有 actor 映射。
 * @param identity - 已装配的身份。
 * @param sessionId - 已归一的 session id。
 * @param source - 本结果的来源标记。
 * @returns 解析结果。
 */
function resolveBoundSession(
  identity: DemoActorIdentity,
  sessionId: string,
  source: string,
): ResolvedExecutionActor {
  const binding = identity.registry.require(sessionId)
  const actorId = identity.actors[binding.alias]
  if (actorId === undefined) {
    throw unmapped('ALIAS_NOT_MAPPED', { alias: binding.alias, session_id: sessionId })
  }
  return {
    session_id: sessionId,
    alias: binding.alias,
    actor_id: actorId,
    source,
    ...(binding.display_name === undefined ? {} : { display_name: binding.display_name }),
  }
}

/**
 * 把 `unknown` 收窄成普通对象（数组/null 不算对象）。
 * @param value - 任意值。
 * @returns 对象或 `undefined`。
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 从 `exec.headers` 里按大小写不敏感取一个 header。
 *
 * DSH 的 `ToolRunContext` 目前没有 `headers` 字段，这里只为两件事存在：
 * ① Host Remote Action / 适配层把 session 放进受控 header 的防御路径；
 * ② 单元测试用普通对象构造 exec。
 * 支持 `Headers` / `Map` / 普通对象 / `[key, value]` 数组四种形态。
 * @param headers - `exec.headers`（任意形态）。
 * @param name - 小写 header 名。
 * @returns header 值；没有时 `undefined`。
 */
function readHeader(headers: unknown, name: string): unknown {
  if (headers === undefined || headers === null) return undefined
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].toLowerCase() === name) {
        return pair[1]
      }
    }
    return undefined
  }
  if (typeof headers === 'object') {
    const gettable = headers as { get?: unknown }
    if (typeof gettable.get === 'function') {
      try {
        const value = (gettable.get as (key: string) => unknown).call(headers, name)
        if (value !== undefined && value !== null) return value
      } catch {
        // 不是 Headers/Map：继续按普通对象找。
      }
    }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === name) return (headers as Record<string, unknown>)[key]
    }
  }
  return undefined
}

/**
 * 造一条 `DEMO_ACTOR_UNMAPPED` 错误（detail 是紧凑 JSON：reason_code + 上下文）。
 * @param reasonCode - 机器可判的原因码。
 * @param detail - 附加上下文（不含任何 secret）。
 * @returns 可抛的错误实例。
 */
function unmapped(reasonCode: string, detail: Record<string, unknown>): RecruitmentToolError {
  return new RecruitmentToolError('DEMO_ACTOR_UNMAPPED', JSON.stringify({ reason_code: reasonCode, ...detail }))
}

/**
 * 把任意值压成一段可安全写进错误信息的短文本。
 * @param value - 任意值。
 * @returns 最多 64 字符的描述。
 */
function printable(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value.length <= 64 ? value : `${value.slice(0, 64)}…`
  return `[${typeof value}]`
}
