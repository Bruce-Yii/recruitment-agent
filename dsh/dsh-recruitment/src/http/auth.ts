// 生产登录的独立页面 + API（Issue #61 / D-178）。
//
//   GET  /recruitment/login                       独立整页（暖纸色，零 DSH chrome）
//   GET  /recruitment/login/assets/login.js|css   页面静态资源
//   POST /recruitment/api/auth/login              {username,password,role?} → 200 + 会话 cookie
//   POST /recruitment/api/auth/logout             撤销会话 + 清 cookie（旧 cookie 立即 401）
//
// 只在 `RECRUITMENT_AUTH_MODE=production` 时由 index.ts 注册；preview 模式本模块
// 完全不接线，旧测试身份与 15 步行为一字不改。
// 口令只走 scrypt 校验；会话落库（token 只存 sha256），Host 重启后 cookie 仍有效。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyPassword } from '../auth/credentials.ts'
import {
  findAuthUser,
  findAuthSession,
  insertAuthSession,
  revokeAuthSession,
  AUTH_SESSION_TTL_HOURS,
} from '../db/auth.ts'
import type { DemoActorIdentity } from '../demo-actor/index.ts'
import type { ResolvedDatabaseConfig } from '../db/pool.ts'

const LOGIN_PATH = '/recruitment/login'
const LOGIN_ASSETS_PREFIX = '/recruitment/login/assets/'
const LOGIN_PATH_API = '/recruitment/api/auth/login'
const LOGOUT_PATH_API = '/recruitment/api/auth/logout'

/** 生产会话 cookie（HttpOnly，JS 读不到）；rc_sid 是浏览器侧已有的可读 sid cookie。 */
export const AUTH_COOKIE = 'rc_auth'
export const SID_COOKIE = 'rc_sid'

const NO_STORE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(MODULE_DIR, '..', '..')

/** 允许登录的 alias（与 auth_user 表 CHECK 一致）。 */
const ALLOWED_ROLES = ['recruiter', 'interviewer_a', 'interviewer_b'] as const

interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface AuthHostContext {
  readonly webServer: WebServerFace
}

export interface AuthHttpDeps {
  readonly database: ResolvedDatabaseConfig | null
  readonly identity: DemoActorIdentity
}

interface LoginResult {
  readonly sid: string
  readonly bound: boolean
  readonly alias: string | null
  readonly actor_id: string | null
  readonly display_name: string
  readonly roles: readonly string[]
}

function json(res: ServerResponse, status: number, value: unknown, headers?: Record<string, string | string[]>): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { ...NO_STORE, 'content-type': 'application/json; charset=utf-8', ...(headers ?? {}) })
  res.end(JSON.stringify(value))
}

function text(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { ...NO_STORE, 'content-type': contentType })
  res.end(body)
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

/** 判断当前请求是否经 HTTPS 或反向代理 HTTPS 接入（决定是否追加 Cookie Secure 标记）。 */
export function isHttpsRequest(req: IncomingMessage): boolean {
  const xfProto = req.headers['x-forwarded-proto']
  const proto = Array.isArray(xfProto) ? xfProto[0] : xfProto
  if (typeof proto === 'string' && proto.split(',')[0]?.trim().toLowerCase() === 'https') return true
  return Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted)
}

export function buildLoginCookieHeaders(secure: boolean, token: string, sid: string): string[] {
  const maxAge = AUTH_SESSION_TTL_HOURS * 60 * 60
  const sec = secure ? '; Secure' : ''
  return [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${sec}`,
    `${SID_COOKIE}=${encodeURIComponent(sid)}; Path=/; SameSite=Lax; Max-Age=${maxAge}${sec}`,
  ]
}

export function buildClearCookieHeaders(secure: boolean): string[] {
  const sec = secure ? '; Secure' : ''
  return [
    `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${sec}`,
    `${SID_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${sec}`,
  ]
}

function setLoginCookies(req: IncomingMessage, token: string, sid: string): string[] {
  return buildLoginCookieHeaders(isHttpsRequest(req), token, sid)
}

function clearLoginCookies(req: IncomingMessage): string[] {
  return buildClearCookieHeaders(isHttpsRequest(req))
}

/** 受控角色标签（与 rolesOf 对齐：面试官只拿到 INTERVIEWER）。 */
function rolesOf(alias: string): readonly string[] {
  if (alias === 'recruiter') return ['RECRUITER', 'HR_SPECIALIST']
  if (alias === 'interviewer_a' || alias === 'interviewer_b') return ['INTERVIEWER']
  return []
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be object')
  return parsed as Record<string, unknown>
}

/** 登录成功后把 alias 绑定到**进程内**身份注册表（与写工具/写 HTTP 共享同一个 registry）。 */
function bindAlias(deps: AuthHttpDeps, sid: string, alias: string, displayName: string): LoginResult {
  const known = (ALLOWED_ROLES as readonly string[]).includes(alias)
  if (known) deps.identity.registry.bind(sid, alias as (typeof ALLOWED_ROLES)[number], { display_name: displayName })
  return {
    sid,
    bound: known,
    alias: known ? alias : null,
    actor_id: known ? deps.identity.actors[alias as (typeof ALLOWED_ROLES)[number]] ?? null : null,
    display_name: displayName,
    roles: known ? rolesOf(alias) : [],
  }
}

/** 从 cookie 恢复身份；任何一步失败都返回 null（调用方回 401）。 */
export async function resolveAuthRequest(
  database: ResolvedDatabaseConfig | null,
  deps: AuthHttpDeps,
  req: IncomingMessage,
): Promise<LoginResult | null> {
  if (database === null) return null
  const token = readCookie(req, AUTH_COOKIE)
  if (token === '') return null
  const session = await findAuthSession(database, token)
  if (session === null) return null
  // 每次请求都重新绑定：Host 重启后进程内 registry 清空，DB 会话仍是权威事实。
  return bindAlias(deps, session.session_id, session.alias, session.display_name)
}

async function handleLogin(deps: AuthHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', ...NO_STORE })
    res.end()
    return
  }
  if (deps.database === null) {
    json(res, 503, { error: { code: 'NOT_CONFIGURED', message: '数据库未配置，生产登录不可用' } })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await readJsonBody(req)
  } catch {
    json(res, 400, { error: { code: 'INVALID_ARGS', message: '请求体必须是合法 JSON 对象' } })
    return
  }
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (username === '' || password === '') {
    json(res, 400, { error: { code: 'INVALID_ARGS', reason_code: 'MISSING_CREDENTIALS', message: '请输入用户名和密码' } })
    return
  }
  const user = await findAuthUser(deps.database, username)
  // 用户不存在与口令错误都回同一个 401，避免枚举用户名；口令只在服务端校验，永不回显。
  if (user === null || !verifyPassword(password, user.password_hash)) {
    json(res, 401, {
      error: { code: 'UNAUTHENTICATED', reason_code: 'BAD_CREDENTIALS', message: '用户名或密码不正确' },
    })
    return
  }
  // role? 只是显式声明期望角色；与实际账号角色不符时拒绝，防止越权切换身份。
  if (body.role !== undefined && body.role !== null && body.role !== '' && body.role !== user.alias) {
    json(res, 403, {
      error: { code: 'FORBIDDEN', reason_code: 'ROLE_MISMATCH', message: '该账号不具有所请求的角色' },
    })
    return
  }
  const issued = await insertAuthSession(deps.database, user)
  const result = bindAlias(deps, issued.sessionId, issued.alias, issued.displayName)
  json(res, 200, result, { 'set-cookie': setLoginCookies(req, issued.token, issued.sessionId) })
}

async function handleLogout(deps: AuthHttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST', ...NO_STORE })
    res.end()
    return
  }
  const token = readCookie(req, AUTH_COOKIE)
  if (deps.database !== null && token !== '') await revokeAuthSession(deps.database, token)
  // 无论 cookie 是否有效都回 200（幂等），但旧 cookie 已被撤销 → 下一次请求必 401。
  json(res, 200, { ok: true }, { 'set-cookie': clearLoginCookies(req) })
}

function loginPageHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<title>登录 · Recruitment OS</title>',
    '<link rel="stylesheet" href="/recruitment/login/assets/login.css">',
    '</head>',
    '<body>',
    '<main class="login-paper" data-testid="login-page">',
    '  <section class="login-intro">',
    '    <div class="login-brand"><span class="login-brand-dot"></span>Recruitment OS</div>',
    '    <h1>把招聘的每一步<br>放回你的掌控。</h1>',
    '    <p>候选人、岗位与面试决策，在同一个工作台里安静地流动。</p>',
    '    <div class="login-quiet">独立产品入口 · 安全会话</div>',
    '  </section>',
    '  <section class="login-form-side">',
    '    <div class="login-card">',
    '      <h2>登录工作台</h2>',
    '      <p class="login-sub">请使用企业分配的账号继续</p>',
    '      <form id="auth-login-form" data-testid="login-form">',
    '        <label class="login-field"><span>用户名</span><input name="username" data-testid="login-username" autocomplete="username" required></label>',
    '        <label class="login-field"><span>密码</span><input name="password" type="password" data-testid="login-password" autocomplete="current-password" required></label>',
    '        <div class="login-error" id="auth-login-error" role="alert" data-testid="login-error" hidden></div>',
    '        <button type="submit" class="login-submit" data-testid="login-submit">登录</button>',
    '      </form>',
    '      <div class="login-foot">登录即表示你同意仅按公司授权范围使用本工作台。</div>',
    '    </div>',
    '  </section>',
    '</main>',
    '<script type="module" src="/recruitment/login/assets/login.js"></script>',
    '</body>',
    '</html>',
  ].join('')
}

function serveLoginAsset(name: string, res: ServerResponse): void {
  const dir = join(PLUGIN_ROOT, 'lib')
  const file = join(dir, name)
  if (name !== 'login.js' && name !== 'login.css') {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'asset not found' } })
    return
  }
  if (!existsSync(file)) {
    // 构建产物缺失时给出最小可用内联实现，保证页面本身不依赖 tsdown 才能登录。
    if (name === 'login.js') {
      text(res, 200, LOGIN_INLINE_JS, 'text/javascript; charset=utf-8')
    } else {
      text(res, 200, LOGIN_INLINE_CSS, 'text/css; charset=utf-8')
    }
    return
  }
  text(res, 200, readFileSync(file, 'utf8'), name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8')
}

/** 构建产物缺失时的兜底脚本（真实构建会以 src/app/login.ts 覆盖）。 */
const LOGIN_INLINE_JS = `
const form = document.getElementById('auth-login-form');
const errorBox = document.getElementById('auth-login-error');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
  const data = new FormData(form);
  const submit = form.querySelector('button[type=submit]');
  if (submit) submit.disabled = true;
  try {
    const res = await fetch('/recruitment/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-recruitment-request': '1' },
      body: JSON.stringify({ username: String(data.get('username') || ''), password: String(data.get('password') || '') }),
    });
    if (!res.ok) {
      let msg = '登录失败，请稍后重试。';
      try { const p = await res.json(); msg = p?.error?.message || msg; } catch {}
      if (errorBox) { errorBox.textContent = msg; errorBox.hidden = false; }
      return;
    }
    const next = new URLSearchParams(location.search).get('next');
    location.replace(next && next.startsWith('/recruitment/') ? next : '/recruitment/app');
  } catch {
    if (errorBox) { errorBox.textContent = '网络暂时不可用，请重试。'; errorBox.hidden = false; }
  } finally { if (submit) submit.disabled = false; }
});
`

/** 暖纸色独立登录页样式（零 DSH chrome；内联兜底，构建产物优先）。 */
const LOGIN_INLINE_CSS = `
:root{color-scheme:light;--paper:#f7f3ea;--ink:#25221c;--muted:#6f685c;--line:#ddd4c3;--accent:#8a5a32}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:var(--paper);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.login-paper{min-height:100vh;display:grid;grid-template-columns:1.1fr .9fr;gap:0}
.login-intro{padding:12vh 8vw;display:flex;flex-direction:column;justify-content:center;border-right:1px solid var(--line)}
.login-brand{font-weight:700;letter-spacing:.02em;display:flex;align-items:center;gap:10px;margin-bottom:48px}
.login-brand-dot{width:18px;height:18px;border-radius:6px;background:var(--accent);display:inline-block;transform:rotate(15deg)}
.login-intro h1{font-size:clamp(30px,4vw,52px);line-height:1.25;margin:0 0 20px;font-weight:650}
.login-intro p{color:var(--muted);font-size:16px;line-height:1.8;max-width:420px;margin:0}
.login-quiet{margin-top:72px;color:var(--muted);font-size:13px;letter-spacing:.08em}
.login-form-side{display:flex;align-items:center;justify-content:center;padding:8vh 6vw}
.login-card{width:100%;max-width:380px;background:#fffdf8;border:1px solid var(--line);border-radius:18px;padding:42px 38px;box-shadow:0 18px 50px rgba(80,60,30,.06)}
.login-card h2{font-size:24px;margin:0 0 6px}.login-sub{color:var(--muted);font-size:13px;margin:0 0 28px}
.login-field{display:block;margin-bottom:18px}.login-field span{display:block;font-size:13px;margin-bottom:8px;color:var(--muted)}
.login-field input{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fffefa;font-size:15px;color:var(--ink);outline:none}
.login-field input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(138,90,50,.1)}
.login-submit{width:100%;padding:13px;border:0;border-radius:10px;background:var(--ink);color:#fff;font-size:15px;cursor:pointer;margin-top:6px}
.login-submit:disabled{opacity:.6;cursor:wait}.login-error{color:#a03a2a;background:#fbeae6;border:1px solid #f0cdc4;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:14px}
.login-foot{color:var(--muted);font-size:11px;line-height:1.6;margin-top:24px;text-align:center}
@media(max-width:900px){.login-paper{grid-template-columns:1fr}.login-intro{border-right:0;padding:8vh 8vw 3vh}.login-form-side{padding:3vh 8vw 8vh}}
`

/**
 * 注册生产登录路由。只在 production 模式调用。
 * @returns 注销函数。
 */
export function registerAuthHttp(ctx: AuthHostContext, deps: AuthHttpDeps): () => void {
  const disposers = [
    ctx.webServer.register({
      kind: 'exact',
      path: LOGIN_PATH,
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', ...NO_STORE })
          res.end()
          return
        }
        text(res, 200, loginPageHtml(), 'text/html; charset=utf-8')
      },
    }),
    ctx.webServer.register({
      kind: 'prefix',
      path: LOGIN_ASSETS_PREFIX,
      handler(req, res) {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const name = decodeURIComponent(url.pathname.slice(LOGIN_ASSETS_PREFIX.length))
        serveLoginAsset(name, res)
      },
    }),
    ctx.webServer.register({ kind: 'exact', path: `${LOGIN_ASSETS_PREFIX}login.js`, handler(req, res) { serveLoginAsset('login.js', res) } }),
    ctx.webServer.register({ kind: 'exact', path: `${LOGIN_ASSETS_PREFIX}login.css`, handler(req, res) { serveLoginAsset('login.css', res) } }),
    ctx.webServer.register({ kind: 'exact', path: LOGIN_PATH_API, handler: (req, res) => {
      handleLogin(deps, req, res).catch(() => json(res, 500, { error: { code: 'INTERNAL', message: '登录服务暂时不可用' } }))
    } }),
    ctx.webServer.register({ kind: 'exact', path: LOGOUT_PATH_API, handler: (req, res) => {
      handleLogout(deps, req, res).catch(() => json(res, 500, { error: { code: 'INTERNAL', message: '退出服务暂时不可用' } }))
    } }),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}
