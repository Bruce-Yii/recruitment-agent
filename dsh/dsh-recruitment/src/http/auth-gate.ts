// 生产模式的总闸门（Issue #61 / D-178）。
//
// 只给 `ctx.inject(['webServer'], child => …)` 里的 **child** 装一层 webServer 影子对象：
//   * 后续每个模块都用 `child as unknown as XHostContext` 注册路由，因此所有
//     `/recruitment/*` 路由都会经过这里，统一获得「未认证 → 401 / app → 登录页」语义；
//   * 底层 DSH webServer 服务本身没有被改写（只在 child 上做属性遮蔽），dispose 时还原；
//   * preview 模式完全不安装（零开销、零行为变化）。
//
// 覆盖清单：
//   白名单：登录页 / 静态资源 / 登录/退出 API / 候选人公开预约页与 API。
//   /recruitment/test：直接注册返回 404 的处理器（物理 404，不再有演示身份入口）。
//   /recruitment/app：未登录 302 → /recruitment/login?next=…。
//   其他 /recruitment/*：未登录 401 JSON；已登录则重新绑定 DB 会话身份（Host 重启仍有效）。

import type { IncomingMessage, ServerResponse } from 'node:http'

import { resolveAuthRequest, type AuthHttpDeps } from './auth.ts'
import type { ResolvedDatabaseConfig } from '../db/pool.ts'

export type AuthMode = 'preview' | 'production'

interface RouteSpec {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebServerLike {
  readonly host: string
  readonly port: number | undefined
  register(route: RouteSpec): () => void
}

const PUBLIC_EXACT = new Set([
  '/recruitment/login',
  '/recruitment/login/assets/login.js',
  '/recruitment/login/assets/login.css',
  '/recruitment/api/auth/login',
  '/recruitment/api/auth/logout',
])
const PUBLIC_PREFIXES = [
  '/recruitment/login/assets/',
  '/recruitment/api/public/book',
  '/recruitment/book',
] as const

/** 解析 auth mode；缺省 preview；任何非法值都 fail-closed 到 preview（保持旧行为）。 */
export function resolveAuthMode(raw: string | undefined): AuthMode {
  return raw === 'production' ? 'production' : 'preview'
}

function isPublicRoute(route: RouteSpec): boolean {
  if (PUBLIC_EXACT.has(route.path)) return true
  return PUBLIC_PREFIXES.some((prefix) => route.path === prefix || route.path.startsWith(`${prefix}/`) || route.path.startsWith(prefix))
}

function isUnderRecruitment(path: string): boolean {
  return path === '/recruitment' || path.startsWith('/recruitment/')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * 在 child 上下文安装生产 auth 闸门。
 * @param child - `ctx.inject(['webServer'], child)` 的 child（必须是可扩展对象）。
 * @param mode - 认证模式；preview 时不安装。
 * @param database - 服务端库配置（null 时所有受限路由 503 语义由登录模块处理，这里仍返回 401）。
 * @param deps - 与登录路由共享的身份依赖（用于重新绑定 session→alias）。
 * @returns 还原函数（preview 时是空函数）。
 */
export function installAuthGate(
  child: object,
  mode: AuthMode,
  database: ResolvedDatabaseConfig | null,
  deps: AuthHttpDeps,
): () => void {
  if (mode !== 'production') return () => {}
  const target = child as { webServer?: WebServerLike }
  const original = target.webServer
  if (original === undefined) return () => {}
  const descriptor = Object.getOwnPropertyDescriptor(child, 'webServer')

  const wrapped: WebServerLike = {
    get host() { return original.host },
    get port() { return original.port },
    register(route: RouteSpec): () => void {
      // 演示身份入口：生产模式物理 404（仍然注册一条明确 404 的处理器，
      // 这样真实宿主与测试用 Map 分发器都有一致的可观察行为）。
      if (route.path === '/recruitment/test') {
        return original.register({
          kind: 'exact',
          path: '/recruitment/test',
          handler(_req, res) {
            json(res, 404, { error: { code: 'NOT_FOUND', message: '测试身份入口在生产模式不可用' } })
          },
        })
      }
      if (!isUnderRecruitment(route.path) || isPublicRoute(route)) {
        return original.register(route)
      }
      const guarded: RouteSpec = {
        kind: route.kind,
        path: route.path,
        handler(req, res): void {
          void (async () => {
            let authenticated = false
            try {
              const info = await resolveAuthRequest(database, deps, req)
              authenticated = info !== null
              if (info !== null && req.headers['x-dsh-session'] === undefined) {
                req.headers['x-dsh-session'] = info.sid
              }
            } catch {
              authenticated = false
            }
            if (!authenticated) {
              if (route.path === '/recruitment/app' && req.method === 'GET') {
                const next = encodeURIComponent('/recruitment/app')
                res.writeHead(302, {
                  location: `/recruitment/login?next=${next}`,
                  'cache-control': 'no-store',
                })
                res.end()
                return
              }
              json(res, 401, {
                error: {
                  code: 'UNAUTHENTICATED',
                  message: '请先登录招聘工作台',
                },
              })
              return
            }
            await route.handler(req, res)
          })().catch(() => json(res, 500, { error: { code: 'INTERNAL', message: '服务暂时不可用' } }))
        },
      }
      return original.register(guarded)
    },
  }

  Object.defineProperty(child, 'webServer', {
    configurable: true,
    enumerable: true,
    get: () => wrapped,
  })
  return () => {
    if (descriptor === undefined) {
      delete (child as { webServer?: WebServerLike }).webServer
    } else {
      Object.defineProperty(child, 'webServer', descriptor)
    }
  }
}
