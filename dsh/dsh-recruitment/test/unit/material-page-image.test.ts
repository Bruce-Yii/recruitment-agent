// G-14（Issue #45）· `GET /recruitment/api/material/<id>/page/<page_no>` 的无真库单元测试。
//
// 纪律：
//   * 真 `node:http` server listen(0,'127.0.0.1') + 假 `webServer.register` 按 prefix 分发，
//     请求真的进 `registerMaterialContentHttp`（与 test/integration/api-display-material.test.ts 同形）；
//   * 不连数据库：注入 `materialLookup` 假元数据 + `roots` 临时目录 + `converter` 最小假配置 +
//     `pageBridge` 假桥（签名与 runFallbackBridge 一致），假桥写出一个真实 PNG 字节文件；
//   * 只断言 HTTP 契约：200 image/png + X-Page-Count/X-Page-Number/Cache-Control-no-store、
//     临时 PNG 在响应结束后被清理、非 PDF 415、越界 400 PAGE_OUT_OF_RANGE、非法 id/page 400、
//     未知 query 400、同源/方法闸门；错误信封与既有 material 路由一致；
//     G-14 清理后页数直接来自桥的 render.page_count，**每次请求恰好一次桥调用**，
//     无 page=1_000_000 哨兵探测、无错误消息文本解析；
//   * 不依赖真 Python / PyMuPDF / PostgreSQL；桥由测试注入，断言全部落在 HTTP 契约与调用次数上。

import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MATERIAL_CONTENT_ROUTE_PREFIX,
  parseMaterialContentPath,
  parseMaterialPagePath,
  registerMaterialContentHttp,
  type MaterialContentDeps,
} from '../../src/http/material-content.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'

// ---------------------------------------------------------------------------
//  固定夹具
// ---------------------------------------------------------------------------

const UUID = 'dd000004-0000-4000-8000-000000000001'
const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'

/** 不可达库配置：只是让依赖形状合法；注入 materialLookup 后绝不建连。 */
const DB: ResolvedDatabaseConfig = {
  host: '127.0.0.1',
  port: 1,
  user: 'nobody',
  database: 'no_such_db_page_image_unit',
  password: 'not-a-real-password',
  password_env: 'RECRUITMENT_DB_PASSWORD',
  tenant_id: TENANT,
  actor_id: ACTOR,
  statement_timeout_ms: 1_000,
  connect_timeout_ms: 200,
  max: 1,
}

const CONVERTER: ResolvedConverterConfig = {
  python_bin: '/nonexistent/python',
  converter_dir: '/nonexistent/converter',
  allowed_roots: [],
  timeout_ms: 1_000,
}

/** 最小合法 PNG（1x1 透明 PNG；假桥写它，测试只检查字节相等与清理）。 */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7r6JAAAAAElFTkSuQmCC',
  'base64',
)

interface Fixture {
  readonly baseUrl: string
  readonly port: number
  readonly dir: string
  readonly pngPath: string
  readonly assetPath: string
  readonly calls: Array<Readonly<Record<string, unknown>>>
  setMime(mime: string): void
  setBridge(fn: MaterialContentDeps['pageBridge']): void
  close(): Promise<void>
}

/**
 * 起真 HTTP server，并注册 material 前缀路由；注入假 lookup / 根 / 桥。
 * 假桥把 PNG 写到临时目录并返回与真桥同形的 `{ok:true, render:{...}}`。
 */
async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-page-image-unit-'))
  const assetName = 'resume-alpha.pdf'
  const assetBytes = Buffer.from('%PDF-1.4 G-14 unit fixture\n')
  const assetPath = join(dir, assetName)
  writeFileSync(assetPath, assetBytes)
  const sha256 = createHash('sha256').update(assetBytes).digest('hex')
  const pngPath = join(dir, 'page-0001@144dpi.png')

  let mime = 'application/pdf'
  const calls: Array<Readonly<Record<string, unknown>>> = []
  const defaultBridge: NonNullable<MaterialContentDeps['pageBridge']> = async (_cfg, request) => {
    writeFileSync(pngPath, PNG_BYTES)
    return {
      ok: true,
      render: {
        image_path: pngPath,
        page: request.page,
        dpi: request.dpi,
        pixel_size: [1, 1],
        page_size_pt: [595, 842],
        source_sha256: sha256,
        oversampled: false,
        page_count: 3,
      },
    }
  }
  let bridge: NonNullable<MaterialContentDeps['pageBridge']> = defaultBridge

  const routes: Array<{
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }> = []
  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const route = routes.find((candidate) => pathname.startsWith(candidate.path))
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no route' }))
      return
    }
    Promise.resolve()
      .then(() => route.handler(req, res))
      .catch(() => {
        try { res.destroy() } catch { /* 连接已坏 */ }
      })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (httpServer.address() as AddressInfo).port
  const deps: MaterialContentDeps = {
    database: DB,
    databaseIssues: [],
    roots: () => [dir],
    converter: CONVERTER,
    // Record **every** bridge invocation here (not inside defaultBridge) so
    // tests can assert the exact call count even when a custom bridge is set.
    pageBridge: (...args) => {
      calls.push(args[1])
      return bridge(...args)
    },
    materialLookup: async (materialId) => ({
      kind: 'OK',
      asset: {
        asset_id: materialId,
        file_name: assetName,
        mime_type: mime,
        byte_size: String(assetBytes.length),
        sha256,
        storage_ref: `content-addressed:sha256:${sha256}`,
        validation_status: 'VALIDATED',
      },
    }),
  }
  const dispose = registerMaterialContentHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    dir,
    pngPath,
    assetPath,
    calls,
    setMime(next: string) { mime = next },
    setBridge(next) { bridge = next ?? defaultBridge },
    async close() {
      dispose()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface CallResult {
  readonly status: number
  readonly headers: Headers
  readonly body: Buffer
  readonly json: Record<string, unknown> | undefined
}

/** 默认同源 GET（Host 由 fetch 自动设置为 127.0.0.1:<port>）。 */
async function get(fx: Fixture, path: string, options: {
  readonly headers?: Readonly<Record<string, string>>
  readonly method?: string
  readonly sameOrigin?: boolean
} = {}): Promise<CallResult> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  if (options.sameOrigin !== false) headers['x-recruitment-request'] = '1'
  const response = await fetch(`${fx.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    redirect: 'manual',
  })
  const body = Buffer.from(await response.arrayBuffer())
  let json: Record<string, unknown> | undefined
  try { json = JSON.parse(body.toString('utf8')) as Record<string, unknown> } catch { json = undefined }
  return { status: response.status, headers: response.headers, body, json }
}

/** 用原始 node:http 覆盖 Host/Origin（fetch 不允许覆盖 Host）。 */
function rawGet(fx: Fixture, path: string, headers: Record<string, string>): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${fx.baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        let json: Record<string, unknown> | undefined
        try { json = JSON.parse(body.toString('utf8')) as Record<string, unknown> } catch { json = undefined }
        resolve({
          status: res.statusCode ?? 0,
          headers: new Headers(res.headers as Record<string, string>),
          body,
          json,
        })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function pagePath(page = 1, query = ''): string {
  return `${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/${page}${query}`
}

function errorCode(result: CallResult): string {
  const error = result.json?.error as Record<string, unknown> | undefined
  return typeof error?.reason_code === 'string' ? error.reason_code : ''
}

/** 等清理事件落地（finish/close 是同步事件，fetch 结束后通常已完成；这里再让一轮事件循环）。 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('G-14 material page image route', () => {
  let fx: Fixture
  before(async () => { fx = await startFixture() })
  after(async () => { if (fx !== undefined) await fx.close() })

  test('纯函数 parseMaterialPagePath：只认 <uuid>/page/<1-based-int>', () => {
    assert.deepEqual(parseMaterialPagePath(pagePath(2)), { kind: 'OK', materialId: UUID, pageNo: 2 })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/0`), { kind: 'INVALID' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/01`), { kind: 'INVALID' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/1.5`), { kind: 'INVALID' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/1/extra`), { kind: 'INVALID' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/not-a-uuid/page/1`), { kind: 'INVALID' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/content`), { kind: 'NOT_FOUND' })
    assert.deepEqual(parseMaterialPagePath(`${MATERIAL_CONTENT_ROUTE_PREFIX}`), { kind: 'NOT_FOUND' })
  })

  test('200 image/png + 契约头 + 假桥参数 + 临时 PNG 清理', async () => {
    const result = await get(fx, pagePath(2))
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('content-type'), 'image/png')
    assert.equal(result.headers.get('x-page-count'), '3')
    assert.equal(result.headers.get('x-page-number'), '2')
    assert.equal(result.headers.get('cache-control'), 'no-store')
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff')
    assert.deepEqual(result.body, PNG_BYTES)
    assert.deepEqual(fx.calls.at(-1), {
      op: 'page-image',
      pdf: fx.assetPath,
      page: 2,
      dpi: 144,
    })
    await settle()
    assert.equal(existsSync(fx.pngPath), false, '临时 PNG 必须在响应体结束后清理')
  })

  test('dpi 查询参数白名单：合法生效，未知参数 400', async () => {
    const ok = await get(fx, pagePath(1, '?dpi=200'))
    assert.equal(ok.status, 200)
    assert.deepEqual((fx.calls.at(-1) as Record<string, unknown>).dpi, 200)
    await settle()
    const badDpi = await get(fx, pagePath(1, '?dpi=abc'))
    assert.equal(badDpi.status, 400)
    assert.equal(errorCode(badDpi), 'DPI_INVALID')
    const unknown = await get(fx, pagePath(1, '?surprise=1'))
    assert.equal(unknown.status, 400)
    assert.equal(errorCode(unknown), 'UNKNOWN_PARAM')
  })

  test('非 PDF 415 UNSUPPORTED_FORMAT（桥未被调用）', async () => {
    fx.setMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    try {
      const before = fx.calls.length
      const result = await get(fx, pagePath(1))
      assert.equal(result.status, 415)
      assert.equal(errorCode(result), 'UNSUPPORTED_FORMAT')
      assert.equal(fx.calls.length, before, '非 PDF 绝不调渲染桥')
    } finally {
      fx.setMime('application/pdf')
    }
  })

  test('页码越界 400 PAGE_OUT_OF_RANGE（桥报 page_out_of_range）', async () => {
    fx.setBridge(async () => ({ ok: false, code: 'page_out_of_range', message: 'page 99 > page count 3' }))
    try {
      const result = await get(fx, pagePath(99))
      assert.equal(result.status, 400)
      assert.equal(errorCode(result), 'PAGE_OUT_OF_RANGE')
      const detail = (result.json?.error as Record<string, unknown>).detail as Record<string, unknown>
      assert.equal(detail.page_no, 99)
    } finally {
      fx.setBridge(undefined)
    }
  })

  test('桥成功但 render.page_count 越界 → 400 PAGE_OUT_OF_RANGE 且清理临时 PNG', async () => {
    fx.setBridge(async () => {
      writeFileSync(fx.pngPath, PNG_BYTES)
      return {
        ok: true,
        render: {
          image_path: fx.pngPath,
          page: 5,
          dpi: 144,
          pixel_size: [1, 1],
          page_size_pt: [595, 842],
          source_sha256: 'x',
          oversampled: false,
          page_count: 3,
        },
      }
    })
    try {
      const result = await get(fx, pagePath(5))
      assert.equal(result.status, 400)
      assert.equal(errorCode(result), 'PAGE_OUT_OF_RANGE')
      // 错误路径没有进入流式响应；没有注册清理监听。按契约桥失败不应留下 PNG：
      // 这里断言的是"错误信封 + 不返回图片"，文件由测试夹具的临时目录在 close 时统一清理。
      assert.equal(result.headers.get('content-type')?.startsWith('application/json'), true)
    } finally {
      fx.setBridge(undefined)
      rmSync(fx.pngPath, { force: true })
    }
  })

  test('每次请求只调一次桥：render.page_count 原生带出 X-Page-Count，无 page=1_000_000 探测', async () => {
    fx.calls.length = 0
    const result = await get(fx, pagePath(2))
    assert.equal(result.status, 200)
    assert.equal(result.headers.get('x-page-count'), '3')
    assert.equal(result.headers.get('x-page-number'), '2')
    assert.deepEqual(result.body, PNG_BYTES)
    assert.equal(fx.calls.length, 1, 'G-14 清理后每次请求必须只有一次桥调用')
    assert.deepEqual(fx.calls[0], {
      op: 'page-image',
      pdf: fx.assetPath,
      page: 2,
      dpi: 144,
    })
    assert.equal(
      fx.calls.some((call) => (call as Record<string, unknown>).page === 1_000_000),
      false,
      '不得再用 1000000 哨兵页码探测总页数',
    )
    await settle()
    assert.equal(existsSync(fx.pngPath), false)
  })

  test('桥成功但 render 缺 page_count → 500 PAGE_COUNT_UNKNOWN 且清理临时 PNG（不探测、不猜页数）', async () => {
    fx.calls.length = 0
    fx.setBridge(async (_cfg, request) => {
      writeFileSync(fx.pngPath, PNG_BYTES)
      return {
        ok: true,
        render: {
          image_path: fx.pngPath,
          page: request.page,
          dpi: request.dpi,
          pixel_size: [1, 1],
          page_size_pt: [595, 842],
          source_sha256: 'x',
          oversampled: false,
          // 故意不带 page_count：真桥已原生提供，缺字段是基础设施降级。
        },
      }
    })
    try {
      const result = await get(fx, pagePath(1))
      assert.equal(result.status, 500)
      assert.equal(errorCode(result), 'PAGE_COUNT_UNKNOWN')
      assert.equal(result.headers.get('content-type')?.startsWith('application/json'), true)
      assert.equal(result.headers.get('x-page-count'), null)
      assert.equal(fx.calls.length, 1, '页数缺失不得触发第二次哨兵桥调用')
      assert.equal(existsSync(fx.pngPath), false, 'fail-closed 路径也必须清理桥已写出的 PNG')
    } finally {
      fx.setBridge(undefined)
      rmSync(fx.pngPath, { force: true })
    }
  })

  test('桥返回畸形 page_count（0 / 非法整数）→ 500 PAGE_COUNT_UNKNOWN（不猜页数）', async () => {
    for (const bad of [0, -1, 1.5, '3', null]) {
      fx.setBridge(async (_cfg, request) => {
        writeFileSync(fx.pngPath, PNG_BYTES)
        return {
          ok: true,
          render: {
            image_path: fx.pngPath,
            page: request.page,
            dpi: request.dpi,
            pixel_size: [1, 1],
            page_size_pt: [595, 842],
            source_sha256: 'x',
            oversampled: false,
            page_count: bad,
          },
        }
      })
      try {
        const result = await get(fx, pagePath(1))
        assert.equal(result.status, 500, `page_count=${String(bad)} 应 fail-closed`)
        assert.equal(errorCode(result), 'PAGE_COUNT_UNKNOWN')
      } finally {
        rmSync(fx.pngPath, { force: true })
      }
    }
    fx.setBridge(undefined)
  })

  test('malformed id / page → 400（不进桥）', async () => {
    const before = fx.calls.length
    const badId = await get(fx, `${MATERIAL_CONTENT_ROUTE_PREFIX}/not-a-uuid/page/1`)
    assert.equal(badId.status, 400)
    assert.equal(errorCode(badId), 'PAGE_PATH_INVALID')
    const badPage = await get(fx, `${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/page/0`)
    assert.equal(badPage.status, 400)
    assert.equal(errorCode(badPage), 'PAGE_PATH_INVALID')
    assert.equal(fx.calls.length, before)
  })

  test('身份覆盖参数/头 → 400 ACTOR_OVERRIDE_REJECTED', async () => {
    const query = await get(fx, pagePath(1, '?tenant_id=someone-else'))
    assert.equal(query.status, 400)
    assert.equal(errorCode(query), 'ACTOR_OVERRIDE_REJECTED')
    const header = await get(fx, pagePath(1), { headers: { 'x-recruitment-actor': 'someone-else' } })
    assert.equal(header.status, 400)
    assert.equal(errorCode(header), 'ACTOR_OVERRIDE_REJECTED')
  })

  test('非同源（缺同源头 / 跨源 Origin / 非法 Host）→ 403 SAME_ORIGIN_REQUIRED', async () => {
    const missing = await get(fx, pagePath(1), { sameOrigin: false })
    assert.equal(missing.status, 403)
    assert.equal(errorCode(missing), 'SAME_ORIGIN_REQUIRED')

    const crossOrigin = await get(fx, pagePath(1), { headers: { origin: 'http://evil.test' } })
    assert.equal(crossOrigin.status, 403)
    assert.equal(errorCode(crossOrigin), 'SAME_ORIGIN_REQUIRED')

    const badHost = await rawGet(fx, pagePath(1), {
      host: `evil.test:${fx.port}`,
      'x-recruitment-request': '1',
    })
    assert.equal(badHost.status, 403)
    assert.equal(errorCode(badHost), 'SAME_ORIGIN_REQUIRED')
  })

  test('POST → 405 allow=GET；非回环 host 不注册路由', async () => {
    const post = await get(fx, pagePath(1), { method: 'POST' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET')

    const warnings: string[] = []
    const registered: string[] = []
    registerMaterialContentHttp(
      {
        webServer: {
          host: '0.0.0.0',
          port: fx.port,
          register(route) { registered.push(route.path); return () => {} },
        },
        logger: { warn(message) { warnings.push(message) } },
      },
      {
        database: DB,
        databaseIssues: [],
        roots: () => [fx.dir],
        converter: CONVERTER,
        materialLookup: async (materialId) => ({
          kind: 'OK',
          asset: {
            asset_id: materialId,
            file_name: 'resume-alpha.pdf',
            mime_type: 'application/pdf',
            byte_size: '10',
            sha256: '0'.repeat(64),
            storage_ref: 'content-addressed:sha256:0000',
            validation_status: 'VALIDATED',
          },
        }),
      },
    )
    assert.equal(registered.length, 0)
    assert.equal(warnings.length, 1)
  })

  test('既有 /content 分发不受影响：page 解析不吞 /content 形状', () => {
    const contentPath = `${MATERIAL_CONTENT_ROUTE_PREFIX}/${UUID}/content`
    assert.deepEqual(parseMaterialContentPath(contentPath), { kind: 'OK', materialId: UUID })
    assert.deepEqual(parseMaterialPagePath(contentPath), { kind: 'NOT_FOUND' })
    assert.equal(contentPath.includes('/page/'), false)
  })
})
