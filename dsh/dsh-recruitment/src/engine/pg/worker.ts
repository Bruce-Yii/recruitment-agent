// 同步 PG 桥的 worker 端（本 lane 自写，非 vendor）。
//
// 为什么存在：引擎的 `Repositories` 端口是**同步**的（`atomic<T>(work: () => T): T`），而 `pg` 只有异步 API。
// 主线程用 Atomics.wait 阻塞等待，worker 线程独占一条 pg 连接执行语句；这样对外仍是同步方法，
// 但每次调用都是真实 PG 往返，且 BEGIN/COMMIT/SAVEPOINT 可以跨多次同步调用保持（连接由本 worker 独占）。
//
// 回报约定：每条请求都带一个 SharedArrayBuffer；worker 先 postMessage 回包，再 Atomics.add + notify，
// 主线程只在 flag 递增后才去取消息 —— 所以**任何**返回路径（成功、SQL 报错、连接致命错误）都必须 notify，
// 否则主线程会阻塞到超时（这是 bridge.ts 客户端超时存在的理由）。
import { parentPort, workerData, type MessagePort } from 'node:worker_threads'
import pg from 'pg'

/** 主线程传来的连接参数（password 只在内存里，不写日志）。 */
interface WorkerConfig {
  readonly channel: MessagePort
  readonly host: string
  readonly portNumber: number
  readonly user: string
  readonly database: string
  readonly password: string
  readonly statementTimeoutMs: number
  readonly lockTimeoutMs: number
  readonly applicationName: string
}

interface Request { readonly id: number; readonly sql: string; readonly params: readonly unknown[]; readonly sab: SharedArrayBuffer }
interface Reply { readonly id: number; readonly rows?: unknown[]; readonly rowCount?: number; readonly error?: string; readonly fatal?: boolean }

const config = workerData as WorkerConfig
const channel = config.channel

/** 把错误压成一条可诊断文本（不带凭据）。 */
const describe = (error: unknown): string => error instanceof Error ? `${error.name}: ${error.message}` : String(error)

/** 回包并唤醒主线程：两个动作的顺序不能反，主线程醒来时必须已经有消息可取。 */
function reply(message: Reply, sab: SharedArrayBuffer): void {
  channel.postMessage(message)
  const flag = new Int32Array(sab)
  Atomics.add(flag, 0, 1)
  Atomics.notify(flag, 0, 1)
}

let client: pg.Client | undefined

/** 建立唯一连接并下发超时设置；同步桥阻塞宿主事件循环，所以服务端硬上限必须小。 */
async function connect(): Promise<void> {
  client = new pg.Client({
    host: config.host,
    port: config.portNumber,
    user: config.user,
    database: config.database,
    password: config.password,
    application_name: config.applicationName,
    statement_timeout: config.statementTimeoutMs,
    connectionTimeoutMillis: 10_000,
  })
  await client.connect()
  await client.query(`set lock_timeout = ${Math.max(1, Math.trunc(config.lockTimeoutMs))}`)
  await client.query(`set idle_in_transaction_session_timeout = ${Math.max(1000, Math.trunc(config.statementTimeoutMs))}`)
}

async function main(): Promise<void> {
  const ready = connect()
  // 先挂一个 no-op catch：连接失败可能早于第一条请求到达，否则会变成 unhandled rejection；
  // 真正的错误仍在下面的 `await ready` 里抛出并通过 reply() 唤醒主线程。
  ready.catch(() => {})
  for (;;) {
    const request = await new Promise<Request>(resolve => channel.once('message', resolve))
    if (request.sql === '__close__') break
    try {
      await ready
      if (!client) throw new Error('The PG bridge is not connected')
      const result = await client.query(request.sql, request.params as unknown[])
      reply({ id: request.id, rows: result.rows, rowCount: result.rowCount ?? 0 }, request.sab)
    } catch (error) {
      const fatal = !client || /Connection terminated|ECONNRESET|not queryable|connection error|password authentication failed/i.test(describe(error))
      reply({ id: request.id, error: describe(error), fatal }, request.sab)
      if (fatal) { try { await client?.end() } catch { /* 连接已坏 */ } channel.close(); process.exit(1) }
    }
  }
  try { await client?.end() } catch { /* 关闭时的取消不掩盖正常退出 */ }
  channel.close()
}

void main().catch((error: unknown) => {
  // 启动阶段失败：把原因回传给 **正在等待的那条** 请求，避免主线程无限阻塞。
  const pending = { error: describe(error), fatal: true }
  channel.postMessage({ id: -1, ...pending } satisfies Reply)
  channel.close()
  process.exit(1)
})

parentPort?.on('close', () => { void client?.end().catch(() => {}) })
