// 运行时 HTTP 入口（宿主侧，回环 + 同源，默认不注册）。
//
// 为什么需要它：R2「接线铁律」要求能力从**运行中的入口**可达，不能只被单测调用。
// 两个端点分工：
//   POST /recruitment/runtime/events  投递一个外部事件（幂等）
//   POST /recruitment/runtime/tick    处理待路由事件 + 派发一个 Task 到独立 Worker Session
// 读回端点：
//   GET  /recruitment/runtime/tasks/:id   三层身份投影（Task/Attempt/Session/Wakeup）
//   GET  /recruitment/runtime/tasks       最近任务列表
//   GET  /recruitment/runtime/health      事件/任务/尝试/会话计数 + 事件处置健康度（G10）
//
// 安全边界：只允许本机回环 + 同源请求头；非回环监听**不注册**（fail closed）。
// 路由是否注册由 `config.runtime.enabled === true` 决定（见 src/index.ts）。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sameOrigin } from '../http/overview.ts'
import { EventRuntime, validateInboundEvent } from './event-runtime.ts'
import type { Router } from './router.ts'
import type { RuntimeStore } from './store.ts'
import type { InboundEvent, TickReceipt } from './types.ts'
import type { TaskRuntime } from './task-runtime.ts'

/** 宿主 `webServer` 的最小面（与 http/overview.ts 一致，避免依赖宿主包类型）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 运行时 HTTP 的宿主上下文。 */
export interface RuntimeHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 注册入口需要的东西。 */
export interface RuntimeHttpOptions {
  readonly store: RuntimeStore
  readonly router: Router
  readonly events: EventRuntime
  readonly tasks: TaskRuntime
  /** 单次 tick 的硬超时（毫秒）。默认 10 分钟（Worker 自己的超时更短）。 */
  readonly tickTimeoutMs?: number
}

const ROUTE_PREFIX = '/recruitment/runtime'
/**
 * 未挂处置 sink 时的 `disposition` 段：**形状与已挂时完全一致**，读数全 null。
 *
 * 为什么不能填 0：0 是"库事实为零"，null 是"这条读数不存在"。用 0 冒充会让
 * 运维把"没接线"读成"处置做得很干净"——那正是 G10 要消灭的假读数。
 */
const DISPOSITION_SINK_NOT_ATTACHED = {
  available: false,
  reason: 'DISPOSITION_SINK_NOT_ATTACHED',
  events_total: null,
  events_internal_audit: null,
  events_in_scope: null,
  events_disposed: null,
  events_disposed_in_scope: null,
  events_undisposed: null,
  events_undisposed_oldest_wait_seconds: null,
  events_undisposed_oldest_received_at: null,
  write_failures: 0,
  last_write_error: null,
} as const

/** health 的 `disposition` 段：库事实照抄，未挂 sink 时如实报 available=false。 */
async function dispositionSnapshot(events: EventRuntime): Promise<Record<string, unknown>> {
  const report = await events.dispositionHealth()
  if (report === null) return { ...DISPOSITION_SINK_NOT_ATTACHED }
  return {
    available: true,
    events_total: report.eventsTotal,
    events_internal_audit: report.eventsInternalAudit,
    events_in_scope: report.eventsInScope,
    events_disposed: report.eventsDisposed,
    events_disposed_in_scope: report.eventsDisposedInScope,
    events_undisposed: report.eventsUndisposed,
    events_undisposed_oldest_wait_seconds: report.eventsUndisposedOldestWaitSeconds,
    events_undisposed_oldest_received_at: report.eventsUndisposedOldestReceivedAt,
    write_failures: report.writeFailures,
    last_write_error: report.lastWriteError,
  }
}

const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** 请求体上限：事件 payload 不允许把大文件塞进 HTTP 入口（大文件走 payload_ref）。 */
const MAX_BODY_BYTES = 1024 * 1024

/** 回环判据：只接受 127.0.0.1 / ::1。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/** 读取 JSON 请求体（有上限；超限/非法 JSON 直接 400，不做宽容解析）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text) as unknown
}

/** 构造 InboundEvent（HTTP 体只允许事件字段；tenantId 必须与运行时租户一致）。 */
function inboundFromBody(body: unknown, tenantId: string): InboundEvent {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('request body must be a JSON object')
  }
  const raw = body as Record<string, unknown>
  const payload = raw.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a JSON object')
  }
  return validateInboundEvent({
    tenantId: typeof raw.tenantId === 'string' ? raw.tenantId : tenantId,
    provider: String(raw.provider ?? ''),
    providerEventId: typeof raw.providerEventId === 'string' ? raw.providerEventId : null,
    eventType: String(raw.eventType ?? ''),
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined,
    occurredAt: typeof raw.occurredAt === 'string' ? raw.occurredAt : null,
    payload: payload as Record<string, unknown>,
    sourceObjectId: typeof raw.sourceObjectId === 'string' ? raw.sourceObjectId : null,
    payloadRef: typeof raw.payloadRef === 'string' ? raw.payloadRef : null,
    trustLevel: raw.trustLevel === 'INTERNAL' ? 'INTERNAL' : 'UNTRUSTED_EXTERNAL',
    correlationId: typeof raw.correlationId === 'string' ? raw.correlationId : null,
    causationId: typeof raw.causationId === 'string' ? raw.causationId : null,
  }, tenantId)
}

/**
 * 注册运行时路由。
 * @param ctx - 宿主上下文。
 * @param options - 已装配的运行时。
 * @returns 注销函数（插件卸载即注销）。
 */
export function registerRuntimeHttp(ctx: RuntimeHostContext, options: RuntimeHttpOptions): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: 运行时路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const tickTimeoutMs = options.tickTimeoutMs ?? 10 * 60_000

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    if (!path.startsWith(ROUTE_PREFIX)) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (!sameOrigin(req, webServer.port ?? 0)) {
      json(res, 403, {
        error: 'same-origin loopback request required',
        hint: 'send header x-recruitment-request: 1 from the local web page; this endpoint is not open to other origins',
      })
      return
    }

    try {
      if (path === `${ROUTE_PREFIX}/events` && req.method === 'POST') {
        const body = await readJsonBody(req)
        const event = inboundFromBody(body, options.store.tenant)
        const result = await options.router.submit(event)
        json(res, 200, result)
        return
      }
      if (path === `${ROUTE_PREFIX}/tick` && req.method === 'POST') {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), tickTimeoutMs)
        try {
          const receipt = await options.router.tick(controller.signal)
          json(res, 200, receipt satisfies TickReceipt)
        } finally {
          clearTimeout(timer)
        }
        return
      }
      if (path === `${ROUTE_PREFIX}/health` && req.method === 'GET') {
        // counts 一个键都不动（既有消费者零影响）；disposition 是**追加**字段。
        json(res, 200, {
          ok: true,
          counts: await options.router.counts(),
          disposition: await dispositionSnapshot(options.events),
        })
        return
      }
      if (path === `${ROUTE_PREFIX}/tasks` && req.method === 'GET') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? '20') || 20))
        json(res, 200, { tasks: await options.store.listTasks(limit) })
        return
      }
      if (path.startsWith(`${ROUTE_PREFIX}/messages/`) && req.method === 'GET') {
        const messageId = decodeURIComponent(path.slice(`${ROUTE_PREFIX}/messages/`.length))
        if (messageId === '') {
          json(res, 400, { error: 'message id is required' })
          return
        }
        const receipt = await options.store.readMessageReceipt(messageId)
        if (receipt === null) {
          json(res, 404, { error: 'receipt not found', message_id: messageId })
          return
        }
        json(res, 200, { message_id: messageId, receipt })
        return
      }
      if (path.startsWith(`${ROUTE_PREFIX}/tasks/`) && req.method === 'GET') {
        const taskId = path.slice(`${ROUTE_PREFIX}/tasks/`.length)
        if (taskId === '') {
          json(res, 400, { error: 'task id is required' })
          return
        }
        const view = await options.tasks.read(taskId)
        if (view === null) {
          json(res, 404, { error: 'task not found', task_id: taskId })
          return
        }
        json(res, 200, view)
        return
      }
      if (path === `${ROUTE_PREFIX}/events/pending` && req.method === 'POST') {
        const results = await options.events.processPending()
        json(res, 200, { processed: results })
        return
      }
      res.writeHead(405, { allow: 'GET, POST', ...NO_STORE })
      res.end()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 失败必须可解释：不把异常说成"没有任务"。
      json(res, 500, { error: message })
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
