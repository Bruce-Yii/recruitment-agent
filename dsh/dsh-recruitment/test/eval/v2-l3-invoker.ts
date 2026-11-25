// Eval V2 Phase 3 — 可注入的真实 L3 裁判 invoker（对齐 docs/45 Phase 3；不改产品代码/CI）。
//
// 纪律：
//   1. 只认本任务的新 env 键，绝不从 RECRUITMENT_EVAL_MODEL_PROVIDER 等旧变量偷补；
//   2. fail-closed：配置缺失 → configured:false + reason；判决 JSON 非法 → L3_JUDGE_BAD_JSON；
//   3. 任何错误信息都不携带 apiKey（统一经 redact 处理）；
//   4. 只负责“取回原子判决”，A/B 位置互换与原文锚定仍由 v2-l3-runner.ts 负责。
import type { L3ModelInvoker, L3ModelRawDecision } from './v2-l3-runner.ts'

export type L3InvokerBackend = 'openai_compatible' | 'host_agent'

export interface L3InvokerConfig {
  readonly backend: L3InvokerBackend
  /** openai: http(s)://host/v1 ; host_agent: http://127.0.0.1:49349 */
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
  /** host_agent 必填（x-dsh-session） */
  readonly session?: string
  readonly timeoutMs?: number
}

const BACKENDS: readonly string[] = ['openai_compatible', 'host_agent']
const DEFAULT_TIMEOUT_MS = 60_000

function trimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** 从本任务专属 env 键读取配置；不读任何旧变量，缺项即未配置。 */
export function readL3InvokerConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly configured: boolean
  readonly config?: L3InvokerConfig
  readonly reason?: string
} {
  const backend = trimmed(env, 'RECRUITMENT_EVAL_L3_BACKEND')
  if (!backend || !BACKENDS.includes(backend)) {
    return {
      configured: false,
      reason: 'RECRUITMENT_EVAL_L3_BACKEND 缺失或非法（仅支持 openai_compatible / host_agent）。',
    }
  }
  const baseUrl = trimmed(env, 'RECRUITMENT_EVAL_L3_BASE_URL')
  if (!baseUrl || !isValidHttpUrl(baseUrl)) {
    return { configured: false, reason: 'RECRUITMENT_EVAL_L3_BASE_URL 缺失或不是合法 http(s) URL。' }
  }
  const model = trimmed(env, 'RECRUITMENT_EVAL_L3_MODEL')
  if (!model) {
    return { configured: false, reason: 'RECRUITMENT_EVAL_L3_MODEL 缺失或为空。' }
  }
  const session = trimmed(env, 'RECRUITMENT_EVAL_L3_SESSION')
  if (backend === 'host_agent' && !session) {
    return { configured: false, reason: 'host_agent 后端必须配置 RECRUITMENT_EVAL_L3_SESSION（x-dsh-session）。' }
  }
  const timeoutRaw = trimmed(env, 'RECRUITMENT_EVAL_L3_TIMEOUT_MS')
  let timeoutMs: number | undefined
  if (timeoutRaw !== undefined) {
    timeoutMs = Number(timeoutRaw)
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return { configured: false, reason: 'RECRUITMENT_EVAL_L3_TIMEOUT_MS 必须是正整数毫秒。' }
    }
  }
  const apiKey = trimmed(env, 'RECRUITMENT_EVAL_L3_API_KEY')
  return {
    configured: true,
    config: {
      backend: backend as L3InvokerBackend,
      baseUrl,
      model,
      ...(apiKey ? { apiKey } : {}),
      ...(session ? { session } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  }
}

export class L3InvokerError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'L3InvokerError'
    this.code = code
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从模型回答中截取第一个完整 JSON 对象（允许 ```json 代码块与前后解释文字；括号内字符串安全）。 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 校验并归一化模型判决；小于 4 字的引用在此处接受，由 runner 做原文锚定拦截。 */
function parseJudgeDecision(raw: string): L3ModelRawDecision {
  const json = extractJsonObject(raw)
  if (!json) throw new L3InvokerError('L3_JUDGE_BAD_JSON', '模型回答中未找到 JSON 对象')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new L3InvokerError('L3_JUDGE_BAD_JSON', '模型回答中的 JSON 解析失败')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new L3InvokerError('L3_JUDGE_BAD_JSON', '模型回答必须是 JSON 对象')
  }
  const obj = parsed as Record<string, unknown>
  if (obj.verdict !== 'pass' && obj.verdict !== 'fail') {
    throw new L3InvokerError('L3_JUDGE_BAD_JSON', 'verdict 必须是 pass 或 fail')
  }
  if (typeof obj.citedSourceQuote !== 'string' || obj.citedSourceQuote.trim() === '') {
    throw new L3InvokerError('L3_JUDGE_BAD_JSON', 'citedSourceQuote 必须是非空字符串')
  }
  if (obj.rationale !== undefined && typeof obj.rationale !== 'string') {
    throw new L3InvokerError('L3_JUDGE_BAD_JSON', 'rationale 必须是字符串')
  }
  return {
    verdict: obj.verdict,
    citedSourceQuote: obj.citedSourceQuote,
    rationale: typeof obj.rationale === 'string' ? obj.rationale : '',
  }
}

/** 解析单个 SSE 块，只取 delta 帧的 text（支持 data 内嵌 event 字段与心跳注释行）。 */
function parseSseDeltaBlock(block: string): string {
  let event = 'message'
  const dataLines: string[] = []
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return ''
  try {
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
    const embedded = typeof data.event === 'string' ? data.event : undefined
    const effective = event === 'message' && embedded ? embedded : event
    return effective === 'delta' && typeof data.text === 'string' ? data.text : ''
  } catch {
    return ''
  }
}

/** 自行实现的轻量 SSE delta 拼接（不 import v2-live-runner.ts 的私有函数）。 */
async function readSseDeltaText(response: Response): Promise<string> {
  if (!response.body) throw new L3InvokerError('L3_JUDGE_SSE_EMPTY', 'host_agent 响应无 SSE body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ''
      for (const block of blocks) text += parseSseDeltaBlock(block)
    }
    if (buffer.trim() !== '') text += parseSseDeltaBlock(buffer)
  } finally {
    reader.releaseLock()
  }
  if (text.trim() === '') throw new L3InvokerError('L3_JUDGE_SSE_NO_CONTENT', 'host_agent 未返回任何非空 delta')
  return text
}

export function createL3Invoker(
  config: L3InvokerConfig,
  deps?: { readonly fetchImpl?: typeof fetch },
): L3ModelInvoker {
  if (!config || !BACKENDS.includes(config.backend)) {
    throw new L3InvokerError('L3_JUDGE_BAD_CONFIG', 'backend 缺失或非法')
  }
  if (!config.baseUrl?.trim() || !isValidHttpUrl(config.baseUrl)) {
    throw new L3InvokerError('L3_JUDGE_BAD_CONFIG', 'baseUrl 缺失或非法')
  }
  if (!config.model?.trim()) {
    throw new L3InvokerError('L3_JUDGE_BAD_CONFIG', 'model 缺失或为空')
  }
  if (config.backend === 'host_agent' && !config.session?.trim()) {
    throw new L3InvokerError('L3_JUDGE_BAD_CONFIG', 'host_agent 必须提供 session')
  }
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new L3InvokerError('L3_JUDGE_BAD_CONFIG', 'timeoutMs 必须是正整数毫秒')
  }
  const fetchImpl = deps?.fetchImpl ?? globalThis.fetch
  const apiKey = config.apiKey ?? ''
  const base = config.baseUrl.replace(/\/+$/, '')
  const redact = (error: L3InvokerError): L3InvokerError =>
    new L3InvokerError(
      error.code,
      apiKey ? error.message.split(apiKey).join('[REDACTED]') : error.message,
    )
  const httpError = async (response: Response, scope: string): Promise<L3InvokerError> => {
    let snippet = ''
    try {
      snippet = (await response.text()).slice(0, 300)
    } catch {
      // 响应体不可读时只报状态码
    }
    return new L3InvokerError('L3_JUDGE_HTTP_ERROR', `${scope} HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`)
  }

  return async (prompt: string): Promise<L3ModelRawDecision> => {
    try {
      let raw: string
      if (config.backend === 'openai_compatible') {
        const response = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            response_format: { type: 'json_object' },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw await httpError(response, 'chat/completions')
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          throw new L3InvokerError('L3_JUDGE_BAD_JSON', 'chat/completions 响应不是合法 JSON')
        }
        const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          throw new L3InvokerError('L3_JUDGE_BAD_JSON', '响应缺少 choices[0].message.content 字符串')
        }
        raw = content
      } else {
        const response = await fetchImpl(`${base}/recruitment/agent/turn`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dsh-session': config.session!,
            'x-recruitment-request': '1',
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ text: prompt, context: { route: '#' } }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!response.ok) throw await httpError(response, 'agent/turn')
        raw = await readSseDeltaText(response)
      }
      return parseJudgeDecision(raw)
    } catch (error) {
      if (error instanceof L3InvokerError) throw redact(error)
      throw redact(new L3InvokerError('L3_JUDGE_HTTP_ERROR', `L3 裁判调用失败：${asMessage(error)}`))
    }
  }
}
