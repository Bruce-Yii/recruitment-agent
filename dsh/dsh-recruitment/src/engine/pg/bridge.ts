// 同步 PG 桥的主线程端（本 lane 自写，非 vendor）。
//
// 用法：`const pg = new SyncPg(config); const { rows } = pg.call('select 1')` —— 同步返回。
//
// 三条必须写死的代价（验收要求，不许写成"性能可接受"）：
//   1. 每次 `call` 都阻塞宿主事件循环一次真实 PG 往返（本机实测 ≈0.45ms/次，见 VENDORED.md 的实测数字）。
//   2. 单条语句超过 `statementTimeoutMs`（默认 5000ms）会被 PG 取消；超过客户端兜底超时
//      （statement + 5s）则本层判定 worker 失联、终止 worker 并抛错 —— 绝不静默返回空结果。
//   3. worker 崩溃/被杀时，正在进行的事务随连接一起消失：调用方（Store.atomic）会抛错，命令失败而不是"半成功"。
import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'

/** 一座同步 PG 桥的连接参数。 */
export interface SyncPgConfig {
  readonly host: string
  readonly port: number
  readonly user: string
  readonly database: string
  readonly password: string
  /** 服务端 statement_timeout（毫秒）。同步桥阻塞事件循环，这个值必须小。 */
  readonly statementTimeoutMs?: number
  /** 服务端 lock_timeout（毫秒）。 */
  readonly lockTimeoutMs?: number
  readonly applicationName?: string
}

/** 一次同步调用的结果，形状对齐 `pg` 的 `QueryResult` 中本层用到的字段。 */
export interface SyncPgResult { rows: Record<string, unknown>[]; rowCount: number }

/** 同步桥的状态；`error` 表示 worker 已失联，下一层应把命令当作失败处理。 */
export type SyncPgState = 'starting' | 'ready' | 'error' | 'closed'

const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000
const DEFAULT_LOCK_TIMEOUT_MS = 3_000
const CLIENT_TIMEOUT_GRACE_MS = 5_000

export class SyncPg {
  private worker: Worker | undefined
  private channel: MessagePort | undefined
  private nextId = 0
  private readonly config: Required<SyncPgConfig>
  private _state: SyncPgState = 'starting'
  /** 最近一次失败的诊断文本，供健康上报。 */
  lastError: string | undefined

  constructor(config: SyncPgConfig) {
    this.config = {
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      password: config.password,
      statementTimeoutMs: config.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
      lockTimeoutMs: config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      applicationName: config.applicationName ?? 'dsh-recruitment-engine',
    } as Required<SyncPgConfig>
  }

  get state(): SyncPgState { return this._state }

  /** 启动（或重启）worker；`restart` 只在 worker 失联后由 `call` 自动触发。 */
  private start(): void {
    if (this.worker) return
    const { port1, port2 } = new MessageChannel()
    this.channel = port1
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: {
        channel: port2,
        host: this.config.host,
        portNumber: this.config.port,
        user: this.config.user,
        database: this.config.database,
        password: this.config.password,
        statementTimeoutMs: this.config.statementTimeoutMs,
        lockTimeoutMs: this.config.lockTimeoutMs,
        applicationName: this.config.applicationName,
      },
      transferList: [port2],
      name: 'engine-pg-bridge',
    })
    this._state = 'ready'
    // exit 事件在主线程阻塞期间不会被派发，但它仍用于「空闲时崩溃」的可见性：把状态改成 error。
    this.worker.on('exit', code => {
      this.worker = undefined
      this.channel?.close()
      this.channel = undefined
      if (this._state !== 'closed') { this._state = 'error'; this.lastError = `PG bridge worker exited with code ${code}` }
    })
    this.worker.on('error', error => { this._state = 'error'; this.lastError = String(error) })
    this.worker.unref()
  }

  /**
   * 同步执行一条语句。
   * @param sql - 语句；`?` 占位符由调用方（Store.db）换算成 `$n`，这里只转发。
   * @param params - 绑定参数。
   * @throws 当语句超过服务端超时、或超过客户端兜底超时（此时 worker 被终止并标记 error）。
   */
  call(sql: string, params: readonly unknown[] = []): SyncPgResult {
    if (this._state === 'closed') throw new Error('The PG bridge is closed')
    this.start()
    const channel = this.channel
    if (!channel) throw new Error('The PG bridge has no channel')
    const id = ++this.nextId
    const sab = new SharedArrayBuffer(4)
    const flag = new Int32Array(sab)
    // 先读 flag 再发请求：worker 可能在 postMessage 之后、Atomics.wait 之前就回包并递增 flag，
    // 若此时才读 seen，会把"已经到达"的那次递增当成基线，从而一直等到超时。
    let seen = Atomics.load(flag, 0)
    channel.postMessage({ id, sql, params, sab })
    const deadline = Date.now() + this.config.statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS
    for (;;) {
      const message = this.findReply(id)
      if (message) {
        if (message.error) {
          if (message.fatal) { this.fail(message.error); throw new Error(this.lastError) }
          throw new Error(message.error)
        }
        this._state = 'ready'
        return { rows: (message.rows ?? []) as Record<string, unknown>[], rowCount: Number(message.rowCount ?? 0) }
      }
      const advanced = Atomics.load(flag, 0)
      if (advanced > seen) { seen = advanced; continue }
      const remaining = deadline - Date.now()
      if (remaining <= 0) { this.fail(`PG bridge call timed out after ${this.config.statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS}ms`); throw new Error(this.lastError) }
      Atomics.wait(flag, 0, seen, remaining)
    }
  }

  /** 从端口取出匹配 `id` 的回包；不匹配的（例如启动握手）丢弃。 */
  private findReply(id: number): { id: number; rows?: unknown[]; rowCount?: number; error?: string; fatal?: boolean } | undefined {
    for (let attempt = 0; attempt < 1024; attempt++) {
      const received = this.channel ? receiveMessageOnPort(this.channel) : undefined
      if (!received) return undefined
      const message = received.message as { id?: number; rows?: unknown[]; rowCount?: number; error?: string; fatal?: boolean } | undefined
      if (message && message.id === id) return message as { id: number; rows?: unknown[]; rowCount?: number; error?: string; fatal?: boolean }
    }
    return undefined
  }

  /** 标记失联并终止 worker；下一次 `call` 会重新拉起一个（事务语义随旧连接一起丢失，由调用方失败）。 */
  private fail(detail: string): void {
    this._state = 'error'
    this.lastError = detail
    const worker = this.worker
    this.worker = undefined
    this.channel?.close()
    this.channel = undefined
    if (worker) void worker.terminate()
  }

  /** 关闭桥：先让 worker 自己结束连接，再终止线程。 */
  close(): void {
    if (this._state === 'closed') return
    const channel = this.channel
    const worker = this.worker
    this._state = 'closed'
    this.worker = undefined
    this.channel = undefined
    try { channel?.postMessage({ id: 0, sql: '__close__', params: [] }) } catch { /* 通道已断 */ }
    channel?.close()
    if (worker) void worker.terminate()
  }
}

/** 供测试与健康上报读取的一句话说明。 */
export const syncPgCost = (): string => 'Every call blocks the host event loop for one real PG round trip; a call over '
  + `${DEFAULT_STATEMENT_TIMEOUT_MS}ms statement timeout is cancelled, and over ${DEFAULT_STATEMENT_TIMEOUT_MS + CLIENT_TIMEOUT_GRACE_MS}ms kills the bridge.`
