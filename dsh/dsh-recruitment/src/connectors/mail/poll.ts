// IMAP 后台定时轮询（Issue #25 / G-02）。
//
// 默认关闭：只有 env `RECRUITMENT_IMAP_POLL_INTERVAL_MS` 显式给出**正整数**才启动定时器；
// 未配置 / 非数字 / 0 / 负数 / 非整数 ⇒ 禁用（返回 null，不启动任何 timer，保既有回归）。
//
// 设计要点：
//   * `createImapPoller` 的 timer/clock/onTick 全部可注入 ⇒ 单测不碰真实网络、真实时钟。
//   * 单次执行互斥：tick 之间没有重叠（上一轮未结束则跳过本轮），避免并发写水位。
//   * 水位：由调用方注入 load/save（内存或持久化）；失败下一轮用旧水位重试，可恢复。
//   * start() 返回 stop()；stop() 清 timer、幂等，且等待在途 tick 结束（可 await）。
//   * 轮询本身不直连 IMAP/PG：每轮调用注入的 `runOnce(sinceUid)`（生产传 fetchAndIngest），
//     其返回的 `next_since_uid` 由 poller 持久化。

/** 显式开启轮询的环境变量名。 */
export const MAIL_POLL_INTERVAL_ENV = 'RECRUITMENT_IMAP_POLL_INTERVAL_MS'

/** 定时器接口（Node 的 setTimeout/clearTimeout 同形，测试可注入假实现）。 */
export interface PollTimer {
  readonly setTimeout: (fn: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

/** 可注入的异步互斥锁：runExclusive 内同一时刻只有一个执行体。 */
export interface MailAsyncLock {
  runExclusive<T>(fn: () => Promise<T>): Promise<T>
}

/** 内置互斥锁（按实例隔离）。 */
export function createMailLock(): MailAsyncLock {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    runExclusive<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn)
      tail = run.then(() => undefined, () => undefined)
      return run
    },
  }
}

/**
 * 解析轮询间隔（毫秒）。未配置/非正数/非整数 ⇒ 0（禁用）。
 * 暴露为纯函数便于单测与 `config.mail` 校验复用。
 */
export function resolvePollIntervalMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[MAIL_POLL_INTERVAL_ENV]
  if (typeof raw !== 'string' || raw.trim() === '') return 0
  const value = Number(raw.trim())
  if (!Number.isInteger(value) || value <= 0) return 0
  return value
}

/** 一轮轮询的结果（水位推进）。 */
export interface PollTickResult {
  readonly next_since_uid: number
  /** 本轮是否真的处理过（连接失败等场景为 false，水位不动）。 */
  readonly progressed: boolean
}

export interface ImapPollerDeps {
  /** 显式间隔（毫秒）；<=0 表示禁用——createImapPoller 返回 null。 */
  readonly intervalMs: number
  /** 执行一轮（生产 = fetchAndIngest 的薄封装）。 */
  readonly runOnce: (sinceUid: number) => Promise<PollTickResult>
  /** 读取当前水位（初始 0）。 */
  readonly loadWatermark: () => number | Promise<number>
  /** 持久化水位（失败不影响本轮结果，下轮用旧水位重试）。 */
  readonly saveWatermark: (uid: number) => void | Promise<void>
  /** 观测回调：错误/跳过原因（含 unmatched_reason），不含正文/PII。 */
  readonly onEvent?: (event: { type: string; reason?: string; error?: string }) => void
  /** 注入 timer（测试用假实现；不传走全局 setTimeout/clearTimeout）。 */
  readonly timer?: PollTimer
  /** 注入互斥锁（默认 createMailLock）。 */
  readonly lock?: MailAsyncLock
}

export interface ImapPoller {
  readonly start: () => void
  /** 停止（幂等）；返回 Promise 在在途 tick 结束后 resolve。 */
  readonly stop: () => Promise<void>
  readonly isRunning: () => boolean
  /** 手动触发一轮（仍受互斥锁保护；测试与运维可用）。 */
  readonly tick: () => Promise<void>
}

const DEFAULT_TIMER: PollTimer = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * 造轮询器。intervalMs<=0 ⇒ 返回 null（不启动、不建 timer、不跑 tick）。
 * 每次 tick 结束时用 setTimeout 排下一次，保证不会因单轮超时而堆叠。
 */
export function createImapPoller(deps: ImapPollerDeps): ImapPoller | null {
  if (!Number.isFinite(deps.intervalMs) || deps.intervalMs <= 0) return null

  const timer = deps.timer ?? DEFAULT_TIMER
  const lock = deps.lock ?? createMailLock()
  let running = false
  let stopped = true
  let handle: unknown = null
  let inFlight: Promise<void> = Promise.resolve()

  function scheduleNext(): void {
    if (!running) return
    handle = timer.setTimeout(() => { inFlight = tick() }, deps.intervalMs)
  }

  async function tick(): Promise<void> {
    const run = lock.runExclusive(async () => {
      let since: number
      try {
        const loaded = await deps.loadWatermark()
        since = Number.isFinite(loaded) && loaded >= 0 ? Math.floor(loaded) : 0
      } catch (error) {
        deps.onEvent?.({ type: 'WATERMARK_LOAD_FAILED', error: String(error) })
        since = 0
      }
      try {
        const result = await deps.runOnce(since)
        if (result.progressed && result.next_since_uid > since) {
          try {
            await deps.saveWatermark(result.next_since_uid)
          } catch (error) {
            // 持久化失败：下轮仍用旧水位重试（去重与 event_inbox 幂等兜底）。
            deps.onEvent?.({ type: 'WATERMARK_SAVE_FAILED', error: String(error) })
          }
        } else if (!result.progressed) {
          deps.onEvent?.({ type: 'TICK_NO_PROGRESS', reason: 'CONNECTION_OR_EMPTY' })
        }
      } catch (error) {
        // 单轮失败不杀死定时器：下周期继续（可恢复）。
        deps.onEvent?.({ type: 'TICK_FAILED', error: String(error) })
      }
    })
    inFlight = run
    try {
      await run
    } finally {
      if (running && !stopped) scheduleNext()
    }
  }

  return {
    start(): void {
      if (running) return
      running = true
      stopped = false
      scheduleNext()
    },
    stop(): Promise<void> {
      if (!running) return Promise.resolve()
      running = false
      stopped = true
      if (handle !== null) {
        timer.clearTimeout(handle)
        handle = null
      }
      return inFlight.then(() => undefined, () => undefined)
    },
    isRunning(): boolean { return running },
    tick(): Promise<void> { return tick() },
  }
}
