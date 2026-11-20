// v4 整页对话桥（D-167 §4）：POST /recruitment/agent/turn → DSH 既有 agent/session 运行时。
//
// 不新建 Agent Runtime、不碰模型请求头：宿主 profile 已装配 `ctx.agents`（agent-loop 提供），
// 本文件只做四件事：
//   1) 用同一个 `rc_sid`（`session-<uuid>`）找/建 DSH Agent（工具身份仍走同一 registry）；
//   2) `agent.followup(createUserMessage 同形对象)` 投递用户消息；
//   3) 订阅 `agent/assistant-stream`（实时 token）与 `session/event`（tool/call|result、turn/end），
//      转成前端契约的 SSE：delta / tool / done / error；
//   4) 失败 fail-closed：桥/运行时不可用 → 503 AGENT_UNAVAILABLE（页面降级，业务按钮不受影响）。
//
// 安全：v1 对话只给**只读工具**（allow-list，见 CHAT_READ_TOOLS）；写操作仍必须走右侧工作台的
// 人点确认（D-167：对话里的确认卡是后续任务）。限制在 agent 创建时的 setup 里做，fail-closed。
//
// 边界：本文件不 import 任何 @deepseek-ai/dsh-* 运行时包（只 import type cordis / node 内置）：
// 插件按源码执行，宿主包不在插件的 node_modules 解析面内，API 以窄接口在运行时取。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { AppAgentTurnBridge } from './app-shell.ts'
import { normalizeUiAction, UI_DISPATCH_TOOL_NAME } from '../tools/ui-dispatch.ts'
import { INTERVIEW_FREE_SLOTS_TOOL_NAME } from '../tools/interview-free-slots.ts'

/** 桥需要的宿主最小面（Cordis Context 的窄化）。 */
export interface AgentTurnHost {
  get(name: string): unknown
  on(name: string, listener: (...args: unknown[]) => void): (() => boolean) | void
  logger?: { warn(message: string): void; info?(message: string): void }
}

export interface AgentTurnOptions {
  /** DSH 会话 cwd（绝对路径；缺省读 RECRUITMENT_WORKSPACE_ROOT 或进程 cwd）。 */
  readonly workspaceRoot?: string
}

/** 对话 v1 允许的工具（只读；用 allow-list，未知/写能力一律不可见）。 */
const CHAT_READ_TOOLS: readonly string[] = [
  'recruitment_candidate_get',
  'recruitment_application_get',
  'recruitment_interview_get',
  'recruitment_job_get',
  'recruitment_resume_read',
  'recruitment_material_read',
  'recruitment_transcript_read',
  'recruitment_trace_get',
  'recruitment_tasks_status',
  'recruitment_usage',
  'recruitment_structure_validate',
  'recruitment_resume_serialize',
  'recruitment_interview_record_verify',
  'recruitment_scorecard_form',
  'recruitment_document_read',
  'recruitment_page_image',
  'recruitment_evaluation_summarize',
  'recruitment_screening_evaluate',
  // 对话×画布统一交互（design/v4/chat-canvas-interaction-spec.md §3）：只读 UI 派发 + 只读查时段。
  UI_DISPATCH_TOOL_NAME,
  INTERVIEW_FREE_SLOTS_TOOL_NAME,
]

const TURN_TIMEOUT_MS = 10 * 60 * 1000
const MAX_BODY_BYTES = 1024 * 1024
const MAX_TEXT_CHARS = 8000
const PING_INTERVAL_MS = 15_000

interface DshAgent {
  readonly id: string
  readonly session: { readonly id: string }
  followup(message: unknown): void
}

interface DshAgentHandle {
  readonly agent: DshAgent
  dispose(): Promise<void>
}

interface DshAgentsService {
  get(id: string): DshAgent | undefined
  create(options: Record<string, unknown>): Promise<DshAgentHandle>
  resume?(options: Record<string, unknown>): Promise<DshAgentHandle>
}

interface ModelSelectionLike {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

interface DefaultModelLike {
  currentSelection(): ModelSelectionLike
}

interface ToolsServiceLike {
  definitions?(scope?: unknown): readonly { readonly name: string }[]
  restrict?(filter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }): unknown
}

interface StreamPayloadLike {
  readonly agent?: { readonly id?: string }
  readonly frame?: { readonly type?: string; readonly chunk?: { readonly type?: string; readonly text?: string } }
}

interface SessionLike {
  readonly id?: string
}

interface SessionEventLike {
  readonly type?: string
  readonly data?: Record<string, unknown>
}

function isAgentsService(value: unknown): value is DshAgentsService {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<DshAgentsService>
  return typeof candidate.get === 'function' && typeof candidate.create === 'function'
}

/** 在 agent 创建时把工具面收敛到只读 allow-list（fail-closed：只放行已知只读名）。 */
function restrictChatTools(agentCtx: unknown): void {
  const tools = (agentCtx as { tools?: unknown } | null)?.tools as ToolsServiceLike | undefined
  if (tools === undefined || typeof tools.definitions !== 'function' || typeof tools.restrict !== 'function') {
    throw new Error('对话 Agent 无法读取工具注册表，拒绝创建可写对话 Agent')
  }
  const known = new Set(tools.definitions().map((d) => String(d.name)))
  const allow = CHAT_READ_TOOLS.filter((name) => known.has(name))
  if (allow.length === 0) throw new Error('对话 Agent 没有可用的只读招聘工具，拒绝创建')
  tools.restrict({ allow })
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be object')
  return parsed as Record<string, unknown>
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    try { res.end() } catch { /* ignore */ }
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 从 tool/content 里取一小段人话摘要（SSE tool 事件只用于展示状态）。 */
function summarizeContent(value: unknown): string {
  try {
    const blocks = Array.isArray(value) ? value : []
    const texts = blocks
      .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
        ? String((block as { text: string }).text)
        : ''))
      .filter((t) => t.length > 0)
    const joined = texts.join(' ').trim()
    return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined
  } catch {
    return ''
  }
}

export interface AppAgentTurnBridgeWithDispose extends AppAgentTurnBridge {
  dispose(): Promise<void>
}

/**
 * 创建对话桥。宿主缺少 `agents` 服务时仍返回桥，但每个回合 fail-closed 返回 503。
 * @param host - Cordis Context 的窄化面（get/on/logger）。
 * @param options - cwd 等可选装配项。
 * @returns 实现 AppAgentTurnBridge 的桥（含 dispose，供插件卸载时回收 AgentHandle）。
 */
export function createAppAgentTurnBridge(
  host: AgentTurnHost,
  options: AgentTurnOptions = {},
): AppAgentTurnBridgeWithDispose {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.env.RECRUITMENT_WORKSPACE_ROOT ?? process.cwd())
  const handles = new Map<string, DshAgentHandle>()
  const creating = new Map<string, Promise<DshAgent>>()
  const activeTurns = new Set<string>()

  const agentsService = (): DshAgentsService | undefined => {
    try {
      const value = host.get('agents')
      return isAgentsService(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  const modelSelection = (): ModelSelectionLike | undefined => {
    try {
      const service = host.get('agentDefaultModel') as DefaultModelLike | undefined
      if (service === undefined || typeof service.currentSelection !== 'function') return undefined
      const selection = service.currentSelection()
      return selection.provider && selection.model ? selection : undefined
    } catch {
      return undefined
    }
  }

  async function ensureAgent(sid: string): Promise<DshAgent> {
    const service = agentsService()
    if (service === undefined) throw new Error('AGENT_RUNTIME_UNAVAILABLE')
    const live = service.get(sid)
    if (live !== undefined) return live
    const pending = creating.get(sid)
    if (pending !== undefined) return pending
    const promise = (async () => {
      mkdirSync(workspaceRoot, { recursive: true })
      const selection = modelSelection()
      const agentOptions = selection === undefined
        ? undefined
        : {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          }
      const base = {
        sessionId: sid,
        meta: { cwd: workspaceRoot },
        setup: (agentCtx: unknown) => restrictChatTools(agentCtx),
        ...(agentOptions === undefined ? {} : { agentOptions }),
      }
      let handle: DshAgentHandle
      try {
        handle = await service.create(base)
      } catch (error) {
        // 同一 sid 的会话被持久化后重启宿主：create 冲突 → resume 已持久化会话。
        if (typeof service.resume !== 'function') throw error
        handle = await service.resume({
          resumeSessionId: sid,
          setup: (agentCtx: unknown) => restrictChatTools(agentCtx),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
      }
      handles.set(sid, handle)
      // 诊断：把本对话 Agent 实际可见的工具名写进 Host 日志（不含参数/业务数据，便于验收工具面）。
      try {
        const agentCtx = (handle.agent as { ctx?: { tools?: ToolsServiceLike } }).ctx
        const names = (agentCtx?.tools?.definitions?.() ?? []).map((definition) => String(definition.name))
        host.logger?.info?.(`recruitment agent-turn: session=${sid} tools=[${names.sort().join(',')}]`)
      } catch { /* 诊断失败不影响对话 */ }
      return handle.agent
    })().finally(() => creating.delete(sid))
    creating.set(sid, promise)
    return promise
  }

  return {
    async handleTurn(req: IncomingMessage, res: ServerResponse, sid: string): Promise<void> {
      const service = agentsService()
      if (service === undefined) {
        writeJson(res, 503, {
          error: {
            code: 'AGENT_UNAVAILABLE',
            reason_code: 'AGENT_RUNTIME_UNAVAILABLE',
            message: '对话暂时不可用，右侧工作台操作不受影响。',
          },
        })
        return
      }
      if (activeTurns.has(sid)) {
        writeJson(res, 409, {
          error: { code: 'AGENT_BUSY', reason_code: 'TURN_IN_PROGRESS', message: '上一条消息还在处理，请稍后再试。' },
        })
        return
      }
      let body: Record<string, unknown>
      try {
        body = await readJsonBody(req)
      } catch (error) {
        writeJson(res, 400, { error: { code: 'INVALID_ARGS', message: `请求体不合法：${String(error)}` } })
        return
      }
      const rawText = typeof body.text === 'string' ? body.text.trim() : ''
      if (rawText.length === 0) {
        writeJson(res, 400, { error: { code: 'INVALID_ARGS', message: '消息不能为空。' } })
        return
      }
      if (rawText.length > MAX_TEXT_CHARS) {
        writeJson(res, 400, { error: { code: 'INVALID_ARGS', message: `消息过长（上限 ${MAX_TEXT_CHARS} 字）。` } })
        return
      }
      const context = typeof body.context === 'object' && body.context !== null ? (body.context as Record<string, unknown>) : {}
      const contextLine = [`当前页面：${typeof context.route === 'string' ? context.route : '未知'}`]
      if (typeof context.application_id === 'string') contextLine.push(`当前申请：${context.application_id}`)
      if (typeof context.job_id === 'string') contextLine.push(`当前岗位：${context.job_id}`)
      const text = `${contextLine.join('；')}\n${rawText}`
      const diag = String(req.headers['x-recruitment-agent-diag'] ?? '') === '1'

      activeTurns.add(sid)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()

      const turnListeners = new Set<() => boolean | void>()
      let finished = false
      let pingTimer: ReturnType<typeof setInterval> | undefined
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined

      const send = (event: string, data: unknown): void => {
        if (finished) return
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { /* ignore */ }
      }
      const closeAll = (): void => {
        for (const disposer of turnListeners) {
          try { disposer() } catch { /* ignore */ }
        }
        turnListeners.clear()
        if (pingTimer !== undefined) {
          clearInterval(pingTimer)
          pingTimer = undefined
        }
        if (timeoutTimer !== undefined) {
          clearTimeout(timeoutTimer)
          timeoutTimer = undefined
        }
      }
      const finish = (): void => {
        if (finished) return
        finished = true
        closeAll()
        activeTurns.delete(sid)
        try { res.end() } catch { /* ignore */ }
      }
      const fail = (code: string, message: string): void => {
        if (finished) return
        send('error', { code, message })
        finish()
      }

      try {
        const agent = await ensureAgent(sid)
        const toolNames = new Map<string, string>()
        const toolArgs = new Map<string, unknown>()
        let usage: unknown

        const onStream = (...args: unknown[]): void => {
          const payload = args[0] as StreamPayloadLike | undefined
          if (payload?.agent?.id !== sid) return
          const frame = payload.frame
          if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta' && typeof frame.chunk.text === 'string') {
            send('delta', { text: frame.chunk.text })
          }
        }
        const onSessionEvent = (...args: unknown[]): void => {
          const session = args[0] as SessionLike | undefined
          const event = args[1] as SessionEventLike | undefined
          if (session?.id !== sid || event === undefined) return
          const data = event.data ?? {}
          if (event.type === 'tool/call') {
            const callId = String(data.callId ?? '')
            const name = String(data.name ?? 'tool')
            toolNames.set(callId, name)
            let input: unknown = data.arguments
            if (typeof data.arguments === 'string') {
              try { input = JSON.parse(data.arguments) } catch { input = data.arguments }
            }
            toolArgs.set(callId, input)
            send('tool', { name, status: 'start', input })
            return
          }
          if (event.type === 'tool/result') {
            const message = (data.message ?? {}) as { toolCallId?: unknown; isError?: unknown; content?: unknown }
            const callId = String(message.toolCallId ?? '')
            const name = toolNames.get(callId) ?? 'tool'
            const failed = message.isError === true
            const errorInfo = (data.error ?? {}) as { code?: unknown; reason?: unknown }
            send('tool', {
              name,
              status: failed ? 'error' : 'ok',
              result: summarizeContent(message.content),
              ...(failed
                ? { message: [errorInfo.code, errorInfo.reason].filter((x) => typeof x === 'string').join('：') }
                : {}),
            })
            // 统一交互 §3.2：UI 派发工具成功 → 额外下发一条 ui_action（前端据此切画布/聚焦/建议按钮）。
            if (name === UI_DISPATCH_TOOL_NAME && !failed) {
              const rawArgs = toolArgs.get(callId)
              if (rawArgs !== undefined) {
                try {
                  send('ui_action', normalizeUiAction(rawArgs))
                } catch {
                  // 工具侧校验通过才会成功；这里再校验失败说明参数被上游篡改 → 不下发（fail-closed）。
                }
              }
            }
            return
          }
          if (event.type === 'assistant/message') {
            if (data.usage !== undefined) usage = data.usage
            return
          }
          if (event.type === 'request/header' && diag) {
            // 验收诊断（仅显式 header 请求）：本轮模型实际可见的工具清单。正常 UI 不请求、不下发。
            const header = (data.header ?? {}) as { tools?: unknown }
            const names = [...JSON.stringify(header.tools ?? []).matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1])
            if (names.length > 0) send('diag', { kind: 'tools', tools: names })
            return
          }
          if (event.type === 'turn/end') {
            const reason = (data.reason ?? {}) as { kind?: string; error?: { code?: unknown; message?: unknown } }
            if (reason.kind === 'aborted') {
              fail('AGENT_ABORTED', '本轮对话已中止。')
              return
            }
            if (reason.kind === 'error') {
              fail(
                typeof reason.error?.code === 'string' ? reason.error.code : 'AGENT_ERROR',
                typeof reason.error?.message === 'string' ? reason.error.message : 'Assistant 本轮失败，请重试。',
              )
              return
            }
            send('done', { turn_id: String(data.turn ?? ''), ...(usage === undefined ? {} : { usage }) })
            finish()
          }
        }

        const disposeStream = host.on('agent/assistant-stream', onStream)
        if (typeof disposeStream === 'function') turnListeners.add(disposeStream)
        const disposeSession = host.on('session/event', onSessionEvent)
        if (typeof disposeSession === 'function') turnListeners.add(disposeSession)

        pingTimer = setInterval(() => {
          if (!finished) {
            try { res.write(': ping\n\n') } catch { /* ignore */ }
          }
        }, PING_INTERVAL_MS)
        timeoutTimer = setTimeout(() => fail('AGENT_TIMEOUT', '对话处理超时，请重试。'), TURN_TIMEOUT_MS)

        req.on('close', () => {
          // 客户端断开：结束本回合 SSE（不取消上游 turn：DSH 会话会继续把结果写进 session log）。
          if (!finished) finish()
        })

        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        fail('AGENT_TURN_FAILED', `对话启动失败：${message.slice(0, 200)}`)
      }
    },
    async dispose(): Promise<void> {
      for (const handle of handles.values()) {
        try { await handle.dispose() } catch { /* ignore */ }
      }
      handles.clear()
    },
  }
}
