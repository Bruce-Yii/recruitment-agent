// =============================================================================
// 独立整页 v4 入口（D-167）—— 产品自己的整页界面，不带 DSH 客户端外壳。
//
// 提供：
//   GET  /recruitment/app                    整页 HTML（100% 视口，无宿主侧栏）
//   GET  /recruitment/app/assets/<file>      静态资源（app.js / app.css）
//   GET  /recruitment/app/session            当前 sid / 身份（只读徽标用）
//   POST /recruitment/app/session/actor      测试/调试用身份绑定（仅 loopback；正式 UI 不出现切换器）
//   GET  /recruitment/test?as=<alias>&next=  测试入口：绑定身份后 302 到整页
//   POST /recruitment/agent/turn             对话/Agent SSE（桥未接线时 503 AGENT_UNAVAILABLE）
//
// 边界：与会话相关的身份仍走**同一个** `DemoActorIdentity.registry`（与工具、写动作共享），
// 不新建第二套身份系统；页面通过 `X-DSH-Session` 头发同一个 sid。
// =============================================================================

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import type { DemoActorAlias, DemoActorIdentity } from '../demo-actor/resolve.ts'

/** 宿主侧用到的 `webServer` 最小面。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文。 */
export interface AppShellHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 对话/Agent 桥：由 index 按能力注入；缺省时对话路由返回 503。 */
export interface AppAgentTurnBridge {
  handleTurn(req: IncomingMessage, res: ServerResponse, sid: string): Promise<void> | void
}

/** 依赖。 */
export interface AppShellDeps {
  /** 与工具/写动作共享的身份单例。 */
  readonly identity: DemoActorIdentity
  /** 对话桥；`null`/缺省 = Agent 不可用（页面显示降级提示，业务按钮不受影响）。 */
  readonly agentTurn?: AppAgentTurnBridge | null
  /** 静态资源目录（缺省 = 插件根下 `lib/`）。 */
  readonly assetsDir?: string
}

const APP_PATH = '/recruitment/app'
const APP_SESSION_PATH = '/recruitment/app/session'
const APP_ACTOR_PATH = '/recruitment/app/session/actor'
const APP_ASSETS_PREFIX = '/recruitment/app/assets/'
const TEST_PATH = '/recruitment/test'
const AGENT_TURN_PATH = '/recruitment/agent/turn'

const SID_COOKIE = 'rc_sid'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(MODULE_DIR, '..', '..')

/** 受控 alias 集合（与 `DemoActorIdentity.actors` 一致；从这里读，不硬编码新别称）。 */
function isKnownAlias(identity: DemoActorIdentity, alias: string): alias is DemoActorAlias {
  return Object.hasOwn(identity.actors, alias)
}

/** alias → 角色标签（只用于整页顶部只读徽标）。 */
function rolesOf(alias: string): readonly string[] {
  if (alias === 'recruiter') return ['RECRUITER', 'HR_SPECIALIST']
  if (alias === 'interviewer_a' || alias === 'interviewer_b') return ['INTERVIEWER']
  return []
}

const ALIAS_LABEL: Readonly<Record<string, string>> = {
  recruiter: '招聘负责人',
  interviewer_a: '面试官 A',
  interviewer_b: '面试官 B',
}

/** 会话 id 规范：`session-<lowercase uuid>`。 */
function normalizeSid(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (trimmed === '') return null
  const bare = trimmed.startsWith('session-') ? trimmed.slice('session-'.length) : trimmed
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(bare)) return null
  return `session-${bare.toLowerCase()}`
}

function newSid(): string {
  return `session-${randomUUID()}`
}

function readCookie(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie
  if (raw === undefined) return ''
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(index + 1).trim())
    } catch {
      return ''
    }
  }
  return ''
}

function headerSid(req: IncomingMessage): string {
  const raw = req.headers['x-dsh-session']
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function hostAllowed(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function loopbackOnly(req: IncomingMessage, port: number): boolean {
  if (!hostAllowed(req, port)) return false
  if (req.headers['x-recruitment-request'] !== '1') return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return false
  }
  return true
}

/** 读 JSON body（上限 1MB；整页只发小对象）。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be object')
  return parsed as Record<string, unknown>
}

/** 定位静态资源文件；拒绝路径穿越。 */
function resolveAsset(assetsDir: string, name: string): string | null {
  if (name === '' || name.includes('..') || name.includes('/') || name.includes('\\')) return null
  const full = normalize(join(assetsDir, name))
  if (!full.startsWith(normalize(assetsDir) + sep)) return null
  return existsSync(full) ? full : null
}

/**
 * 注册整页 v4 的入口路由。
 * @param ctx - 宿主上下文（窄接口）。
 * @param deps - 身份单例 + 可选对话桥。
 * @returns 路由释放器。
 */
export function registerAppShell(ctx: AppShellHostContext, deps: AppShellDeps): () => void {
  const port = ctx.webServer.port ?? 0
  const candidateDirs = [
    deps.assetsDir,
    join(PLUGIN_ROOT, 'lib'),
    join(process.cwd(), 'lib'),
    join(process.cwd(), 'dsh', 'dsh-recruitment', 'lib'),
  ].filter((dir): dir is string => typeof dir === 'string' && dir !== '')
  const assetsDir = candidateDirs.find((dir) => existsSync(join(dir, 'app.js'))) ?? join(PLUGIN_ROOT, 'lib')
  const appJs = join(assetsDir, 'app.js')
  const appCss = join(assetsDir, 'app.css')

  /** 解析或新建 sid，并在需要时回写 cookie。 */
  const ensureSid = (req: IncomingMessage, res: ServerResponse): string => {
    const fromHeader = normalizeSid(headerSid(req))
    const fromCookie = normalizeSid(readCookie(req, SID_COOKIE))
    const sid = fromHeader ?? fromCookie ?? newSid()
    if (fromCookie !== sid) {
      res.setHeader('set-cookie', `${SID_COOKIE}=${encodeURIComponent(sid)}; Path=/; SameSite=Lax`)
    }
    return sid
  }

  const sessionHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'loopback only' } })
      return
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    const sid = ensureSid(req, res)
    const binding = deps.identity.registry.get(sid)
    if (binding === undefined) {
      json(res, 200, { sid, bound: false, alias: null, actor_id: null, display_name: '', roles: [] })
      return
    }
    const alias = String(binding.alias)
    json(res, 200, {
      sid,
      bound: true,
      alias,
      actor_id: deps.identity.actors[binding.alias] ?? null,
      display_name: binding.display_name ?? ALIAS_LABEL[alias] ?? alias,
      roles: rolesOf(alias),
    })
  }

  const bindActor = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackOnly(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch {
      json(res, 400, { error: { code: 'INVALID_ARGS', message: '请求体必须是 JSON 对象' } })
      return
    }
    const aliasRaw = typeof body.alias === 'string' ? body.alias.trim() : ''
    if (!isKnownAlias(deps.identity, aliasRaw)) {
      json(res, 400, {
        error: { code: 'INVALID_ARGS', reason_code: 'UNKNOWN_ALIAS', message: '未知的演示身份别名', detail: { alias: aliasRaw } },
      })
      return
    }
    const sid = ensureSid(req, res)
    const binding = deps.identity.registry.bind(sid, aliasRaw, { display_name: ALIAS_LABEL[aliasRaw] })
    json(res, 200, {
      sid,
      bound: true,
      alias: aliasRaw,
      actor_id: deps.identity.actors[aliasRaw] ?? null,
      display_name: binding.display_name ?? ALIAS_LABEL[aliasRaw] ?? aliasRaw,
      roles: rolesOf(aliasRaw),
    })
  }

  const testHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'loopback only' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const aliasRaw = (url.searchParams.get('as') ?? 'recruiter').trim()
    if (!isKnownAlias(deps.identity, aliasRaw)) {
      json(res, 400, { error: { code: 'INVALID_ARGS', message: '未知的演示身份别名', detail: { alias: aliasRaw } } })
      return
    }
    const sid = newSid()
    deps.identity.registry.bind(sid, aliasRaw, { display_name: ALIAS_LABEL[aliasRaw] })
    const nextRaw = url.searchParams.get('next') ?? APP_PATH
    const next = nextRaw.startsWith('/recruitment/') ? nextRaw : APP_PATH
    res.writeHead(302, {
      location: next,
      'set-cookie': `${SID_COOKIE}=${encodeURIComponent(sid)}; Path=/; SameSite=Lax`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  const appHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'loopback only' } })
      return
    }
    const sid = ensureSid(req, res)
    if (!existsSync(appJs)) {
      text(
        res,
        503,
        '<!doctype html><meta charset="utf-8"><title>Recruitment OS</title><p>整页前端还没有构建（缺少 lib/app.js）。请先在本地运行 <code>npx tsdown</code>。</p>',
        'text/html; charset=utf-8',
      )
      return
    }
    const cssLink = existsSync(appCss) ? '<link rel="stylesheet" href="/recruitment/app/assets/app.css">' : ''
    void sid
    text(
      res,
      200,
      [
        '<!doctype html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
        '<title>Recruitment OS</title>',
        cssLink,
        '</head>',
        '<body>',
        '<div id="root"></div>',
        '<script type="module" src="/recruitment/app/assets/app.js"></script>',
        '</body>',
        '</html>',
      ].join(''),
      'text/html; charset=utf-8',
    )
  }

  const assetHandler = (req: IncomingMessage, res: ServerResponse): void => {
    if (!hostAllowed(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'loopback only' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const name = decodeURIComponent(url.pathname.slice(APP_ASSETS_PREFIX.length))
    const file = resolveAsset(assetsDir, name)
    if (file === null) {
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'asset not found' } })
      return
    }
    const contentType = file.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : file.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream'
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    res.end(readFileSync(file))
  }

  const agentHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!loopbackOnly(req, port)) {
      json(res, 403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const sid = normalizeSid(headerSid(req)) ?? normalizeSid(readCookie(req, SID_COOKIE)) ?? newSid()
    const bridge = deps.agentTurn
    if (bridge === undefined || bridge === null) {
      json(res, 503, {
        error: {
          code: 'AGENT_UNAVAILABLE',
          reason_code: 'AGENT_BRIDGE_NOT_CONFIGURED',
          message: '对话暂时不可用，右侧工作台操作不受影响。',
        },
      })
      return
    }
    await bridge.handleTurn(req, res, sid)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: APP_PATH, handler: appHandler }),
    ctx.webServer.register({ kind: 'prefix', path: APP_ASSETS_PREFIX, handler: assetHandler }),
    ctx.webServer.register({ kind: 'exact', path: `${APP_ASSETS_PREFIX}app.js`, handler: assetHandler }),
    ctx.webServer.register({ kind: 'exact', path: `${APP_ASSETS_PREFIX}app.css`, handler: assetHandler }),
    ctx.webServer.register({ kind: 'exact', path: APP_SESSION_PATH, handler: sessionHandler }),
    ctx.webServer.register({ kind: 'exact', path: APP_ACTOR_PATH, handler: bindActor }),
    ctx.webServer.register({ kind: 'exact', path: TEST_PATH, handler: testHandler }),
    ctx.webServer.register({ kind: 'exact', path: AGENT_TURN_PATH, handler: agentHandler }),
  ]
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }
}
