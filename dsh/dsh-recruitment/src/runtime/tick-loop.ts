// Tick 循环：把 `router.tick()` 从"HTTP 手动触发"变成"进程存活期间自动派发"。为什么用 PG
// 会话级 advisory lock：多个插件实例同时装配同一套事件运行时会并发 tick，在 `SKIP LOCKED`
// 上互相抢 Task；锁挂在**专用连接**上，连接一断锁随会话释放，不需要心跳。为什么永不抛：
// tick 是后台能力，一次 DB 抖动不该打崩插件生命周期；异常只写 health + 节流 warn。
/** 锁键：SQL 里用 hashtext($1) 参数化，不拼字符串。 */
export const TICK_LOCK_KEY = 'recruitment:tick'
/** 最小连接面：pg.Pool / pg.PoolClient 结构上满足（不 import pg 类型）。 */
export interface TickLockConnection {
  query(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }>
  release(): void
  on?(event: 'error', listener: (error: Error) => void): unknown
}
/** 最小连接池面 / 日志面（宿主 logger 缺失时调用方传 no-op）。 */
export interface TickLockPool { connect(): Promise<TickLockConnection> }
export interface TickLoopLogger { warn(message: string): void }
/** 启动参数。 */
export interface TickLoopOptions {
  readonly pool: TickLockPool
  readonly router: { tick(signal: AbortSignal): Promise<unknown> }
  readonly intervalMs: number // 毫秒；调用方已校验，实现防御性取 Math.max(50, Math.trunc(intervalMs))
  readonly logger?: TickLoopLogger
  readonly lockKey?: string // 默认 TICK_LOCK_KEY
}
/** 可观察健康度（snapshot 每次返回新的冻结副本，调用方拿不到内部可变对象）。 */
export interface TickLoopHealth {
  readonly started: boolean; readonly lockHeld: boolean
  readonly ticks: number                    // 完成的 tick 数（成功+失败都算）
  readonly failures: number
  readonly skippedOverlaps: number          // tick 未结束又到点 → 跳过（防重入证据）
  readonly lastTickStartedAt: string | null; readonly lastTickFinishedAt: string | null // ISO
  readonly lastError: string | null         // 截断 300 字
  readonly lockKey: string
  readonly reason: 'LOCK_NOT_ACQUIRED' | 'POOL_CONNECT_FAILED' | 'DISPOSED' | null
}
/** 句柄：snapshot 返回冻结副本；dispose 幂等、永不抛。 */
export interface TickLoop { snapshot(): TickLoopHealth; dispose(): Promise<void> }
/** `'<name>: <message>'` 截断 300 字：health 里存可读原因，不存整个堆栈。 */
function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : `${typeof error}: ${String(error)}`).slice(0, 300)
}
/** 没启动成功的句柄：health 固定"没在派发"，dispose no-op（没持锁就绝不多发 unlock）。 */
function inertLoop(lockKey: string, reason: 'LOCK_NOT_ACQUIRED' | 'POOL_CONNECT_FAILED'): TickLoop {
  const snapshot = (): TickLoopHealth => Object.freeze({
    started: false, lockHeld: false, ticks: 0, failures: 0, skippedOverlaps: 0,
    lastTickStartedAt: null, lastTickFinishedAt: null, lastError: null, lockKey, reason,
  })
  return { snapshot, dispose: async () => {} }
}
/** 启动自动 tick：专用连接抢 advisory lock → 立即 tick 一次 → setInterval 周期 tick；永不抛。 */
export async function startTickLoop(options: TickLoopOptions): Promise<TickLoop> {
  const lockKey = options.lockKey ?? TICK_LOCK_KEY, controller = new AbortController()
  const state: { -readonly [K in keyof TickLoopHealth]: TickLoopHealth[K] } = {
    started: false, lockHeld: false, ticks: 0, failures: 0, skippedOverlaps: 0,
    lastTickStartedAt: null, lastTickFinishedAt: null, lastError: null, lockKey, reason: null,
  }
  // logger.warn 是注入的、不受控；包装后"永不抛"才真的成立（日志失败不影响调度）。
  const warn = (message: string): void => { try { options.logger?.warn(message) } catch { /* 日志失败不影响调度 */ } }
  const snapshot = (): TickLoopHealth => Object.freeze({ ...state })
  let client: TickLockConnection
  try { client = await options.pool.connect() } catch (error) {
    warn(`recruitment: tick 循环拿不到数据库连接，本实例不派发（lock=${lockKey}）：${errorText(error)}`)
    return inertLoop(lockKey, 'POOL_CONNECT_FAILED')
  }
  let locked = false
  try {
    const result = await client.query('select pg_try_advisory_lock(hashtext($1)) as locked', [lockKey])
    locked = result.rows[0]?.locked === true
  } catch (error) {
    // 抢锁查询失败按"没抢到"：本实例确实没持锁，必须 release，不能带着未知状态往下走。
    warn(`recruitment: tick 抢锁查询失败，本实例不派发（lock=${lockKey}）：${errorText(error)}`)
    client.release(); return inertLoop(lockKey, 'LOCK_NOT_ACQUIRED')
  }
  if (!locked) {
    // 另一个实例在派发是**正常状态**，不是错误：让路即可；warn 恰好一次便于排障。
    warn(`recruitment: 另一个实例持有 tick 锁，本实例不派发（lock=${lockKey}）`)
    client.release(); return inertLoop(lockKey, 'LOCK_NOT_ACQUIRED')
  }
  state.started = true; state.lockHeld = true
  // 连接 error 不冒泡到进程：记 health + warn，循环继续（还能不能用由下次 tick 回答）。
  client.on?.('error', (error: Error) => {
    state.lastError = errorText(error)
    warn(`recruitment: tick 专用连接 error（lock=${lockKey}）：${state.lastError}`)
  })
  const intervalMs = Math.max(50, Math.trunc(options.intervalMs) || 50)
  let inFlight: Promise<void> | null = null, timer: ReturnType<typeof setInterval> | null = null, disposing: Promise<void> | null = null
  const runTick = async (): Promise<void> => {
    // 防重入：同步检查（到赋值之间没有 await），并发 tick 永不超过 1 个。
    if (inFlight !== null) { state.skippedOverlaps += 1; return }
    if (controller.signal.aborted) return
    state.lastTickStartedAt = new Date().toISOString()
    const current = (async () => {
      try { await options.router.tick(controller.signal) } catch (error) {
        state.failures += 1; state.lastError = errorText(error)
        // 每 2s 刷一次没有信息量：只在第一次和每 30 次说一次。
        if (state.failures === 1 || state.failures % 30 === 0) warn(`recruitment: tick 失败（lock=${lockKey}，累计 ${state.failures} 次）：${state.lastError}`)
      } finally { state.ticks += 1; state.lastTickFinishedAt = new Date().toISOString() }
    })()
    inFlight = current
    try { await current } finally { inFlight = null }
  }
  // 启动即跑一次（不让新实例空等一个周期）。**不 unref**：真实例进程靠这个 timer 存活。
  void runTick()
  timer = setInterval(() => { void runTick() }, intervalMs)
  const dispose = async (): Promise<void> => {
    if (disposing !== null) return disposing
    disposing = (async () => {
      if (timer !== null) { clearInterval(timer); timer = null }
      controller.abort()
      if (inFlight !== null) { try { await inFlight } catch { /* runTick 自己吞了 */ } }
      try { await client.query('select pg_advisory_unlock(hashtext($1))', [lockKey]) } catch (error) {
        // 连接已断时 PG 会随会话释放锁，所以只 warn，不阻断释放连接。
        warn(`recruitment: tick 锁释放失败（lock=${lockKey}，连接断开时 PG 会随会话释放）：${errorText(error)}`)
      }
      client.release() // 恰好一次；重复 dispose 被上面的 disposing 挡住
      state.started = false; state.lockHeld = false; state.reason = 'DISPOSED'
    })()
    return disposing
  }
  return { snapshot, dispose }
}
