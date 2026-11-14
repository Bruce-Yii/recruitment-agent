// DSH Worker Session 启动器（真实执行路径）。
//
// 为什么用 `dsh --profile <worker> --json` 子进程，而不是在插件进程里直接
// `ctx.agents.create()`：
//   1. **独立 Session / 独立进程**：Worker 的模型循环、工具执行崩溃或被 kill
//      都不会带走 Router 进程；这正是"Session 是可替换的计算上下文"需要的边界。
//   2. headless profile 的驱动就是 DSH 官方 `dsh-agent` / `dsh-agent-loop` /
//      `dsh-session` 组合（见 `@deepseek-ai/dsh-headless` 的 cordis.patch.yml：
//      "direct driver creates a fresh Agent, or adopts the exact Session the flag
//      names, through the core registry and prints its durable result"）。
//   3. `--json` 把 `sessionId`、turn/step 状态和 final 结果输出为 NDJSON；
//      `--session-id` 可以续跑同一个持久化 Session（长任务跨会话）。
//
// 进程内 API（研究结论，记录在这里供后续替换实现）：
//   `ctx.agents.create({ sessionId, meta, agentOptions })` → `AgentHandle`；
//   `handle.agent.followup({ content, source })` 驱动一轮；
//   `handle.agent.whenIdle()` 等它空闲；`await handle.dispose()` 收尾。
//   参考 `@deepseek-ai/dsh-agent` README「Create or resume an agent / Drive an
//   agent's conversation」。本 lane 选择子进程实现是为了让"Router 进程"与
//   "Worker 进程"真正分离，且不把插件依赖扩到 agent-loop。
//
// ⚠️ 输出捕获不用管道（stdio: 'pipe'）：在受限 Windows 环境里命名管道可能被
//    拒绝；这里把 stdout/stderr 直接写到临时文件 fd，读文件解析 NDJSON。
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeError } from './errors.ts'
import { buildWorkerPrompt, loadTaskContextFacts } from './task-context.ts'
import type { TaskContextSource } from './task-context.ts'
import type { TaskErrorClass, WorkerLauncher, WorkerOutcome, WorkerTaskRequest } from './types.ts'

// 任务书渲染已下沉到 task-context.ts（G2：业务上下文 / 版本钉 / 证据 locator / UNKNOWNS）。
// 这里保留同名导出，`src/runtime/index.ts` 的 re-export 与既有调用点不需要改。
export {
  buildTaskContext,
  buildWorkerPrompt,
  createStoreTaskContextSource,
  extractRequestFacts,
  loadTaskContextFacts,
  parseTriggerEvent,
  renderTaskContextPrompt,
  TASK_CONTEXT_SECTIONS,
} from './task-context.ts'
export type {
  LoadedTaskContext,
  TaskContext,
  TaskContextBusinessObject,
  TaskContextEventFacts,
  TaskContextEvidenceLocator,
  TaskContextFacts,
  TaskContextReader,
  TaskContextSource,
  TaskContextToolHint,
  TaskContextVersionPins,
  TaskIdentity,
  TriggerEventFact,
} from './task-context.ts'

/** DSH headless Worker 的配置。 */
export interface DshWorkerConfig {
  /** profile 名（必须包含可用的模型路由；本 lane 证据用 `rec-worker-probe`）。 */
  readonly profile: string
  /** node 可执行文件；默认 `process.execPath`。 */
  readonly nodeBin?: string
  /** `@deepseek-ai/dsh` 的 `lib/bin.js` 绝对路径；默认从 `$DSH_INSTALL_DIR/lib/bin.js` 取。 */
  readonly dshBin?: string
  /** 传给子进程的 `DSH_HOME`；缺省继承当前进程。 */
  readonly dshHome?: string
  /** 工作目录；默认当前进程 cwd。 */
  readonly cwd?: string
  /** 权限预设；默认 `workspace-write`（危险动作必须显式配置成 danger-full-access）。 */
  readonly permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** 单次执行超时（毫秒），默认 180000。 */
  readonly timeoutMs?: number
  /** 写进 `agent_session.runtime_version` 的版本标签（配置给出，不猜）。 */
  readonly runtimeVersion: string
  /** 写进 `agent_session.model_route` 的模型路由标签（配置给出，不猜）。 */
  readonly modelRoute: string
  /** 额外环境变量（合并到继承环境之上；不要在这里放密码，用宿主凭据存储）。 */
  readonly env?: Readonly<Record<string, string>>
  /**
   * 可选业务事实源（生产传 `createStoreTaskContextSource(store)`，见 router.ts 装配）。
   * 只影响任务书的**事实**部分；读不到时降级为 request-only + UNKNOWNS，绝不阻断派发。
   */
  readonly taskContext?: TaskContextSource
}

/** Worker 最终回包的 JSON 形状（模型必须输出这一个对象）。 */
interface WorkerResultJson {
  readonly state?: unknown
  readonly summary?: unknown
  readonly result_ref?: unknown
  readonly error_code?: unknown
  readonly error_class?: unknown
  readonly retryable?: unknown
}

const RESULT_STATES = new Set(['succeeded', 'failed', 'waiting', 'blocked'])

/** 从可能带 markdown 围栏的文本里截取第一个 JSON 对象。 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, '').trim()
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(stripped.slice(start, end + 1))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** 把模型的 JSON 回包映射成 WorkerOutcome 的字段（不伪造成功）。 */
function normalizeResult(json: Record<string, unknown>): {
  readonly state: WorkerOutcome['state']
  readonly summary: string
  readonly resultRef: string | null
  readonly errorCode: string | null
  readonly retryable: boolean
} | null {
  const rawState = typeof json.state === 'string' ? json.state.trim().toLowerCase() : ''
  if (!RESULT_STATES.has(rawState)) return null
  const state = rawState as WorkerOutcome['state']
  const summary = typeof json.summary === 'string' && json.summary.trim() !== ''
    ? json.summary.trim()
    : `${state} (worker returned no summary)`
  const resultRef = typeof json.result_ref === 'string' && json.result_ref.trim() !== '' ? json.result_ref.trim() : null
  const errorCode = typeof json.error_code === 'string' && json.error_code.trim() !== '' ? json.error_code.trim() : null
  const retryable = json.retryable === true
  return { state, summary, resultRef, errorCode, retryable }
}

/** 错误的可重试性分类（DSH 的 stable error code）。 */
function classifyRuntimeError(code: string | null, message: string): { retryable: boolean; errorClass: WorkerOutcome['errorClass'] } {
  const upper = `${code ?? ''} ${message}`.toUpperCase()
  if (upper.includes('QUOTA') || upper.includes('RATE_LIMIT') || upper.includes('TRANSPORT') || upper.includes('TIMEOUT')) {
    return { retryable: true, errorClass: 'TRANSIENT' }
  }
  if (upper.includes('MISSING_CREDENTIAL') || upper.includes('AUTH') || upper.includes('INVALID_CREDENTIAL')) {
    return { retryable: false, errorClass: 'AUTH_REQUIRED' }
  }
  if (upper.includes('INVALID_REQUEST') || upper.includes('UNKNOWN_MODEL')) {
    return { retryable: false, errorClass: 'INVALID_INPUT' }
  }
  return { retryable: true, errorClass: 'UNKNOWN_OUTCOME' }
}

/** Worker 进程退出事实（NDJSON 解析后）。 */
export interface WorkerExitFacts {
  readonly exitCode: number | null
  readonly signal: string | null
  /** `final` 事件（有 = 进程把话说完；没有 = 中途没了）。 */
  readonly final: Record<string, unknown> | null
}

/** 子进程退出分类的结果（直接喂给 WorkerOutcome 的三个字段）。 */
export interface WorkerExitClassification {
  readonly errorCode: string | null
  readonly errorClass: TaskErrorClass | null
  readonly retryable: boolean
}

/**
 * 子进程退出 / 无 final 的分类（纯函数，便于单测）。
 *
 * 为什么必须区分 `WORKER_LOST`：
 *   `store.finishAttempt` 只有 `outcomeState='failed' && errorClass='WORKER_LOST'`
 *   才把 `agent_session` 标成 LOST（计算上下文真的没了）。子进程被 kill / 非零退出
 *   属于"会话丢失"，不是普通可重试错误；混成 TRANSIENT 会让 session 状态长期失真。
 *   exit=0 但没有 final 仍保持既有的 `WORKER_NO_FINAL`（口径不变）。
 * @param exit - 退出码 / signal / final 事件。
 * @returns 错误码 + 错误类别 + 是否可重试（有 final 时三者为空/ false，交由 final 决定）。
 */
export function classifyWorkerExit(exit: WorkerExitFacts): WorkerExitClassification {
  if (exit.final !== null) return { errorCode: null, errorClass: null, retryable: false }
  const killed = exit.signal !== null || (exit.exitCode !== null && exit.exitCode !== 0)
  if (killed) return { errorCode: 'WORKER_LOST', errorClass: 'WORKER_LOST', retryable: true }
  return { errorCode: 'WORKER_NO_FINAL', errorClass: 'TRANSIENT', retryable: true }
}

/**
 * 通过 `dsh --profile <worker> --json` 创建并驱动一个独立 Worker Session。
 *
 * 进程模型：Router 进程 spawn node + dsh bin，parameter 为 profile/权限/任务；
 * stdout+stderr 落到临时文件；进程退出后解析 NDJSON，取 `final` 事件里的
 * sessionId 与模型回包。超时/取消会 kill 子进程并返回可重试失败（不会伪造成
 * 成功，也不会把 Task 丢掉——Task 状态由调用方落库）。
 */
export class DshHeadlessWorkerLauncher implements WorkerLauncher {
  readonly runtimeKind = 'DSH'
  readonly runtimeVersion: string
  readonly modelRoute: string
  private readonly config: DshWorkerConfig

  /**
   * @param config - Worker profile / 路径 / 超时 / 版本标签。
   */
  constructor(config: DshWorkerConfig) {
    this.config = config
    this.runtimeVersion = config.runtimeVersion
    this.modelRoute = config.modelRoute
  }

  /**
   * 解析可执行命令；缺配置时**明确失败**，不退化成一个假执行器。
   * @returns node 可执行文件 + dsh bin 的绝对路径。
   */
  resolveCommand(): { nodeBin: string; dshBin: string } {
    const nodeBin = this.config.nodeBin ?? process.execPath
    const fromEnv = typeof process.env.DSH_INSTALL_DIR === 'string' && process.env.DSH_INSTALL_DIR.trim() !== ''
      ? join(process.env.DSH_INSTALL_DIR, 'lib', 'bin.js')
      : null
    const dshBin = this.config.dshBin ?? fromEnv
    if (dshBin === null || dshBin.trim() === '') {
      throw new RuntimeError(
        'WORKER_RUNTIME_NOT_CONFIGURED',
        'set runtime.dsh_bin (or $DSH_INSTALL_DIR) to the @deepseek-ai/dsh package root so a Worker Session can be created',
      )
    }
    return { nodeBin, dshBin }
  }

  /**
   * 在一个独立 DSH Session 里执行任务。
   * @param request - Router 给出的任务书。
   * @param signal - 取消信号。
   * @returns 归一化结果；执行失败返回 `state='failed'`，配置错误才抛出。
   */
  async execute(request: WorkerTaskRequest, signal: AbortSignal): Promise<WorkerOutcome> {
    const { nodeBin, dshBin } = this.resolveCommand()
    const started = Date.now()
    const dir = mkdtempSync(join(tmpdir(), 'rec-dsh-worker-'))
    const outPath = join(dir, 'session.ndjson')
    const outFd = openSync(outPath, 'w')
    // 业务事实可选：读不到就降级（facts=null + context_source_unavailable 进 UNKNOWNS），
    // 绝不阻断派发，也绝不假装读到了事实。
    const { facts, contextError } = await loadTaskContextFacts(this.config.taskContext, request)
    const prompt = buildWorkerPrompt(request, facts, contextError)
    const permission = this.config.permissionMode ?? 'workspace-write'
    const args = [
      dshBin,
      '--profile', this.config.profile,
      '--json',
      '--permission-mode', permission,
    ]
    if (request.resumeSessionId !== null) args.push('--session-id', request.resumeSessionId)
    args.push(prompt)

    const env: NodeJS.ProcessEnv = { ...process.env, ...(this.config.env ?? {}) }
    if (this.config.dshHome !== undefined) env.DSH_HOME = this.config.dshHome

    let child: ChildProcess
    try {
      child = spawn(nodeBin, args, {
        cwd: this.config.cwd ?? process.cwd(),
        env,
        // 不用管道：stdout/stderr 直接写同一个文件描述符，受限环境也能捕获。
        stdio: ['ignore', outFd, outFd],
        windowsHide: true,
      })
    } catch (error) {
      closeSync(outFd)
      throw new RuntimeError('WORKER_SPAWN_FAILED', error instanceof Error ? error.message : String(error))
    }

    const timeoutMs = this.config.timeoutMs ?? 180_000
    let timedOut = false
    let aborted = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const onAbort = (): void => {
      aborted = true
      child.kill('SIGKILL')
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('error', () => resolve({ code: null, signal: null }))
      child.once('close', (code, sig) => resolve({ code, signal: sig }))
    })
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    closeSync(outFd)

    let text = ''
    try {
      text = readFileSync(outPath, 'utf8')
    } catch {
      text = ''
    }
    const durationMs = Date.now() - started
    const { sessionId, final } = parseWorkerEvents(text)

    if (timedOut || aborted) {
      return {
        state: 'failed',
        summary: timedOut
          ? `worker session exceeded ${timeoutMs}ms and was killed`
          : 'worker session was cancelled',
        resultRef: null,
        errorCode: timedOut ? 'WORKER_TIMEOUT' : 'WORKER_CANCELLED',
        errorClass: 'TRANSIENT',
        retryable: true,
        retryAfter: null,
        runtimeSessionId: sessionId,
        runtimeVersion: this.runtimeVersion,
        modelRoute: this.modelRoute,
        durationMs,
        rawOutputRef: outPath,
      }
    }

    if (final === null) {
      // 子进程被 kill / 非零退出 = 计算上下文丢失（errorClass WORKER_LOST），
      // 让 store.finishAttempt 把 agent_session 标 LOST；exit=0 无 final 保持旧口径。
      const classified = classifyWorkerExit({ exitCode: exit.code, signal: exit.signal, final })
      return {
        state: 'failed',
        summary: classified.errorCode === 'WORKER_LOST'
          ? `worker session was lost before it produced a final event (exit=${String(exit.code)}, signal=${String(exit.signal)})`
          : `worker produced no final event (exit=${String(exit.code)})`,
        resultRef: null,
        errorCode: classified.errorCode ?? 'WORKER_NO_FINAL',
        errorClass: classified.errorClass ?? 'TRANSIENT',
        retryable: classified.retryable,
        retryAfter: null,
        runtimeSessionId: sessionId,
        runtimeVersion: this.runtimeVersion,
        modelRoute: this.modelRoute,
        durationMs,
        rawOutputRef: outPath,
      }
    }

    const reason = final.reason !== null && typeof final.reason === 'object'
      ? final.reason as Record<string, unknown>
      : {}
    const kind = typeof reason.kind === 'string' ? reason.kind : 'unknown'
    if (kind !== 'completed') {
      const error = reason.error !== null && typeof reason.error === 'object'
        ? reason.error as Record<string, unknown>
        : {}
      const code = typeof error.code === 'string' ? error.code : `WORKER_REASON_${kind.toUpperCase()}`
      const message = typeof error.message === 'string' ? error.message : JSON.stringify(reason).slice(0, 500)
      const classified = classifyRuntimeError(code, message)
      return {
        state: 'failed',
        summary: message.slice(0, 1000),
        resultRef: null,
        errorCode: code,
        errorClass: classified.errorClass,
        retryable: classified.retryable,
        retryAfter: null,
        runtimeSessionId: sessionId,
        runtimeVersion: this.runtimeVersion,
        modelRoute: this.modelRoute,
        durationMs,
        rawOutputRef: outPath,
      }
    }

    const finalText = typeof final.text === 'string' ? final.text : ''
    const json = extractJsonObject(finalText)
    const normalized = json === null ? null : normalizeResult(json)
    if (normalized === null) {
      return {
        state: 'failed',
        summary: `worker final message is not the required JSON result: ${finalText.slice(0, 500)}`,
        resultRef: null,
        errorCode: 'WORKER_RESULT_UNPARSEABLE',
        errorClass: 'TRANSIENT',
        retryable: true,
        retryAfter: null,
        runtimeSessionId: sessionId,
        runtimeVersion: this.runtimeVersion,
        modelRoute: this.modelRoute,
        durationMs,
        rawOutputRef: outPath,
      }
    }
    const errorClass = normalized.state === 'failed' && !normalized.retryable ? 'PERMANENT' : null
    return {
      state: normalized.state,
      summary: normalized.summary,
      resultRef: normalized.resultRef,
      errorCode: normalized.errorCode,
      errorClass: normalized.state === 'failed' ? (errorClass ?? 'TRANSIENT') : null,
      retryable: normalized.retryable,
      retryAfter: null,
      runtimeSessionId: sessionId,
      runtimeVersion: this.runtimeVersion,
      modelRoute: this.modelRoute,
      durationMs,
      rawOutputRef: outPath,
    }
  }
}

/** 从 NDJSON 里取 sessionId 和 final 事件（非 JSON 行直接跳过）。 */
export function parseWorkerEvents(text: string): {
  readonly sessionId: string | null
  readonly final: Record<string, unknown> | null
} {
  let sessionId: string | null = null
  let final: Record<string, unknown> | null = null
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== 'object') continue
    const event = parsed as Record<string, unknown>
    if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
    if (event.type === 'final') {
      final = event
      if (typeof event.sessionId === 'string') sessionId = event.sessionId
    }
  }
  return { sessionId, final }
}


