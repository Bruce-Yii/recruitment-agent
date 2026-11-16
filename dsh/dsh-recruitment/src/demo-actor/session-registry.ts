// DSH Session → Demo Actor alias 的**进程内**绑定表（W1 Demo Actor 契约 §2）。
//
// 为什么是进程内：DSH 宿主进程就是"当前这次本地演示"的唯一事实源；浏览器刷新只重建
// 客户端状态，不重建 Host，所以绑定放在插件进程内、由 `PUT /recruitment/api/actor` 写入。
// 约束（冻结口径）：
//   * **不落库、不落文件**（避免把 demo 身份写进业务数据 / 机器磁盘）；
//   * **有界**（默认 1000 条，超出丢最旧）：宿主进程是长期存活的，不能无界增长；
//   * session id 只接受 `session-<uuid>` 或裸 `<uuid>`（大小写不敏感），统一规范成
//     `session-<lowercase uuid>`；其它形态一律拒绝（`INVALID_ARGS`）。
//
// 注意：服务端重启后注册表为空 = **未绑定 = fail-closed**（`GET /actor` 返 409，
// 工具写路径抛 `DEMO_ACTOR_UNMAPPED`）；浏览器刷新时客户端重新 PUT 一次即可恢复。

import { ACTOR_UNBOUND_HUMAN_HINT, RecruitmentToolError } from '../tools/errors.ts'
import { isUuidText } from '../db/pool.ts'
import { parseDemoActorAlias, type DemoActorAlias } from './alias.ts'

/** 受控传递当前 DSH Session ID 的请求头（小写；Host/HTTP 层按大小写不敏感读取）。 */
export const DEMO_SESSION_HEADER = 'x-dsh-session'

/** 注册表容量上限（冻结口径：默认 1000，超出丢最旧）。 */
const DEFAULT_MAX_ENTRIES = 1000

/** 规范 session id 时允许的前缀（`session-<uuid>` 形态）。 */
const SESSION_PREFIX = 'session-'

/** 一条 session → alias 绑定。 */
export interface SessionActorBinding {
  /** 规范形态的 session id：`session-<lowercase uuid>`。 */
  readonly session_id: string
  /** 该 session 选定的受控 alias。 */
  readonly alias: DemoActorAlias
  /** 绑定时刻（ISO-8601；来自可注入的 `now`，测试可钉死）。 */
  readonly bound_at: string
  /**
   * 显示名快照（可选；W3/设置页需要，不参与任何授权判定）。
   * 由 `PUT /recruitment/api/actor` 从 DB 读到后随 `bind` 一起存入；拿不到就省略。
   */
  readonly display_name?: string
}

/** `SessionActorRegistry` 的可选构造参数。 */
export interface SessionActorRegistryOptions {
  /** 容量上限（正整数；非法值取默认 1000）。超出上限时丢**最旧**的绑定。 */
  readonly maxEntries?: number
  /** 时钟（毫秒；测试注入确定性时间）。默认 `Date.now`。 */
  readonly now?: () => number
}

/**
 * 归一化一个 session id。
 * @param value - 任意值（浏览器 localStorage 值、`exec.agent.id`、请求头）。
 * @returns `session-<lowercase uuid>`；不是合法 session 时为 `null`。
 */
export function normalizeSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const bare = trimmed.toLowerCase().startsWith(SESSION_PREFIX)
    ? trimmed.slice(SESSION_PREFIX.length)
    : trimmed
  if (!isUuidText(bare)) return null
  return `${SESSION_PREFIX}${bare.toLowerCase()}`
}

/**
 * 进程内、有界的 session → alias 注册表（单实例由 `src/index.ts` 装配后共享给工具与 HTTP）。
 */
export class SessionActorRegistry {
  /** 插入顺序 = 年龄顺序（Map 保序）：第一个 key 就是最旧的一条。 */
  readonly #bindings = new Map<string, SessionActorBinding>()
  readonly #maxEntries: number
  readonly #now: () => number

  /**
   * @param options - `{maxEntries?, now?}`；两者都可缺省（1000 / `Date.now`）。
   */
  constructor(options: SessionActorRegistryOptions = {}) {
    this.#maxEntries = normalizeMaxEntries(options.maxEntries)
    this.#now = options.now ?? Date.now
  }

  /** 当前绑定条数。 */
  get size(): number {
    return this.#bindings.size
  }

  /**
   * 绑定（或重绑）一个 session。
   *
   * 幂等语义：同 session + 同 alias + 不带新 display_name ⇒ 原样返回旧绑定（`bound_at` 不变）；
   * 其余情况（换 alias、带了新的 display_name）⇒ 覆盖旧绑定（`bound_at` 刷新，新值是"最新"的）。
   * @param sessionId - 原始 session id（`session-<uuid>` 或裸 UUID）。
   * @param alias - 受控 alias（运行时会再校验一次：`Recruiter` 之类非法值 → `INVALID_ARGS`）。
   * @param extra - 可选附加信息（目前只有 `display_name`；缺省 = 不写该键）。
   * @returns 当前的绑定。
   * @throws RecruitmentToolError - `INVALID_ARGS`（session 形态非法 / alias 非法）。
   */
  bind(
    sessionId: string,
    alias: DemoActorAlias,
    extra?: { readonly display_name?: string },
  ): SessionActorBinding {
    const key = requireSessionKey(sessionId)
    const parsedAlias = parseDemoActorAlias(alias)
    const existing = this.#bindings.get(key)
    const requestedDisplayName = extra?.display_name
    if (
      existing !== undefined
      && existing.alias === parsedAlias
      && (requestedDisplayName === undefined || requestedDisplayName === existing.display_name)
    ) {
      return existing
    }
    const displayName = requestedDisplayName === undefined || requestedDisplayName.trim() === ''
      ? undefined
      : requestedDisplayName
    const binding: SessionActorBinding = {
      session_id: key,
      alias: parsedAlias,
      bound_at: new Date(this.#now()).toISOString(),
      ...(displayName === undefined ? {} : { display_name: displayName }),
    }
    // 重绑要先删再插，才能让"最新绑定"排到队尾（容量淘汰按插入顺序）。
    this.#bindings.delete(key)
    this.#bindings.set(key, binding)
    this.#evictOverflow()
    return binding
  }

  /**
   * 读一个 session 的绑定。
   * @param sessionId - 原始 session id。
   * @returns 绑定；未绑定 / 形态非法时为 `undefined`。
   */
  get(sessionId: string): SessionActorBinding | undefined {
    const key = normalizeSessionId(sessionId)
    return key === null ? undefined : this.#bindings.get(key)
  }

  /**
   * 读一个 session 的绑定，**未绑定即拒绝**（写工具与 HTTP 的 fail-closed 入口）。
   * @param sessionId - 原始 session id。
   * @returns 绑定。
   * @throws RecruitmentToolError - `DEMO_ACTOR_UNMAPPED`（未绑定 / session 形态非法）。
   */
  require(sessionId: string): SessionActorBinding {
    const key = normalizeSessionId(sessionId)
    if (key === null) {
      throw unmapped('SESSION_ID_INVALID', { session_id: printable(sessionId) })
    }
    const binding = this.#bindings.get(key)
    if (binding === undefined) {
      throw unmapped('SESSION_NOT_BOUND', { session_id: key })
    }
    return binding
  }

  /**
   * 解除绑定。
   * @param sessionId - 原始 session id。
   * @returns 真的删掉了一条时为 `true`。
   */
  unbind(sessionId: string): boolean {
    const key = normalizeSessionId(sessionId)
    return key === null ? false : this.#bindings.delete(key)
  }

  /**
   * 全部绑定（按绑定先后，旧 → 新）；返回副本，调用方改它不影响注册表。
   * @returns 绑定列表。
   */
  list(): readonly SessionActorBinding[] {
    return [...this.#bindings.values()]
  }

  /** 清空（测试 / Host 重启语义）。 */
  clear(): void {
    this.#bindings.clear()
  }

  /** 超出容量时丢最旧（Map 的第一个 key）。 */
  #evictOverflow(): void {
    while (this.#bindings.size > this.#maxEntries) {
      const oldest = this.#bindings.keys().next()
      if (oldest.done === true) return
      this.#bindings.delete(oldest.value)
    }
  }
}

/**
 * 把 session id 规范成可做 key 的形态；非法即抛。
 * @param value - 任意值。
 * @returns 规范 session id。
 */
function requireSessionKey(value: unknown): string {
  const normalized = normalizeSessionId(value)
  if (normalized === null) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({ reason_code: 'SESSION_ID_INVALID', session_id: printable(value) }),
    )
  }
  return normalized
}

/**
 * 造一条 `DEMO_ACTOR_UNMAPPED` 错误（detail 是紧凑 JSON：reason_code + 上下文 + 人话引导）。
 *
 * O4：机检字段原样保留；`message` 是给 HR/模型看的一句引导（HTTP `errorResponse` 会抬到 body.message）。
 * @param reasonCode - 机器可判的原因码。
 * @param detail - 附加上下文（不含任何 secret）。
 * @returns 可抛的错误实例。
 */
function unmapped(reasonCode: string, detail: Record<string, unknown>): RecruitmentToolError {
  return new RecruitmentToolError('DEMO_ACTOR_UNMAPPED', JSON.stringify({
    reason_code: reasonCode,
    // tool 侧向后兼容：session_id / alias 仍在顶层；message 是给人/模型看的一句引导。
    ...detail,
    message: ACTOR_UNBOUND_HUMAN_HINT,
    // HTTP 各 `errorResponse` 只抬 code / reason_code / message / detail；同一份机检上下文再放进
    // detail，浏览器/排障侧仍能按原字段定位是哪个 session（不丢证据）。
    detail: { ...detail },
  }))
}

/**
 * 容量上限校验：只接受正整数，其它一律取默认值（配置写坏不应该让注册表无法构造）。
 * @param value - 配置值。
 * @returns 实际使用的上限。
 */
function normalizeMaxEntries(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ENTRIES
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
