// 宿主侧只读 HTTP 路由：**受控获取原件字节**（展示层「看得见原件」的唯一入口）。
//
// 端点（唯一一条；prefix 注册在 `/recruitment/api/material` 下）：
//
//   GET  /recruitment/api/material/<material_id>/content
//   HEAD /recruitment/api/material/<material_id>/content
//     `material_id` = `recruitment.intake_asset.id`（UUID 文本）——**不是** resume / 岗位 / 文件路径。
//     可选查询参数（白名单，未知参数 400）：`application_id`、`resume_version_id`（UUID 文本）。
//
// 为什么要有这个端点（业务问题，不是工程问题）：
//   工作台要展示「这份简历原件长什么样」，但 `intake_asset.storage_ref` 只有
//   `content-addressed:sha256:<sha>`，**库里没有路径**。把路径交给浏览器 = 把本机文件系统
//   暴露给页面；让前端自己扫盘 = 第二套定位规则。所以原件只能由服务端按「库里的
//   file_name + byte_size + sha256」在**部署配置的允许根**里定位后再流式送出。
//
// 六条硬约束（CONTRACT §0/§1）：
//   1. **同一源**：`Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>`，带
//      `x-recruitment-request: 1`，`Origin` 缺省或同源；判据**复用** `overview.ts::sameOrigin`
//      （不复制第二份）。非回环 host **不注册**并告警（fail-closed，宁可 404 也不挂到网络面）。
//   2. **只读**：所有 SQL 只走 `withReadOnly`（`begin transaction read only`），
//      任何失败路径零写入（数据库强制，不靠"源码里没写 INSERT"）。
//   3. **tenant 只来自插件配置**（`ResolvedDatabaseConfig.tenant_id`）；客户端任何
//      actor/tenant 覆盖参数/头 → 400，且**不碰 DB**。
//   4. **原件定位复用唯一实现** `src/runtime/task-context.ts::resolveMaterialPath`
//      （allowed roots 来自 `RECRUITMENT_ALLOWED_ROOT_*`，可用 `deps.roots` 注入）：
//      basename + byteSize 预筛 → sha256 确认 → 跳过符号链接 → 有预算上限。
//      本文件**不自写扫盘**、**不接受路径参数**；FOUND 后再 lstat 复核
//      （非符号链接 / 普通文件 / size 一致），防 TOCTOU 与缓存脏读。
//   5. **绝不泄漏本机绝对路径**：响应体、任何 header、错误 message、日志里都不出现
//      （定位失败只回 resolver 的 reason 闭集码，不回候选路径）。
//   6. **如实**：材料不存在 / 未绑定简历 / 定位失败都 404 且**不区分**跨租户
//      （不确认"别家租户有这条"）；归属校验不过 403（不泄漏"该 id 是否存在"）。
//
// 响应形状（CONTRACT §1.4–§1.6）：
//   200/206：`content-type`（mime_type，非法/缺失 → application/octet-stream）、
//            `content-disposition: inline` + RFC 5987 `filename*`（basename；ASCII fallback）、
//            `content-length`、`accept-ranges: bytes`、`cache-control: private, no-store`、
//            `x-content-type-options: nosniff`；单区间 `Range` → 206 + `content-range`；
//            不可满足 → 416 + `content-range: bytes */<size>` + JSON 错误体
//            `RANGE_NOT_SATISFIABLE`；HEAD → 同头无 body；正文走 `createReadStream`（不整份进内存）。
//   错误体固定 `{"error":{"code","reason_code","message","detail?"}}`，code 只取闭集
//   `INVALID_ARGS(400) / FORBIDDEN(403) / NOT_FOUND(404) / NOT_CONFIGURED(503) / INTERNAL(500)`。
//   `RANGE_NOT_SATISFIABLE` 的 HTTP 状态是 416（协议要求），code 仍落在闭集 `INVALID_ARGS`，
//   由 `reason_code` 精确表达（见 work/d5/api-display/A-material.md「字段」一节）。
//
// 依赖方向：本文件只 import `db/pool.ts`（连接/只读事务）、`runtime/task-context.ts`
// （定位唯一实现）、`tools/contract.ts::isUuid`（形状校验）、`http/overview.ts::sameOrigin`
// （同源判据唯一实现）；不 import `src/index.ts` / `src/http/recruiting.ts`，也不改它们。
import { createReadStream, lstatSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { materialRootsFromEnv, resolveMaterialPath } from '../runtime/task-context.ts'
import { resolveConverterConfig, type ResolvedConverterConfig } from '../tools/converter.ts'
import { runFallbackBridge } from '../tools/fallback-bridge.ts'
import { isUuid } from '../tools/contract.ts'
import { sameOrigin } from './overview.ts'

// =====================================================================
//  契约常量（形状是契约；改动必须先改 CONTRACT.md）
// =====================================================================

/** 本路由注册的**前缀**（prefix 注册；只在该前缀下接受 `<id>/content` 一种形状）。 */
export const MATERIAL_CONTENT_ROUTE_PREFIX = '/recruitment/api/material'

/** 端点契约版本（出参/行为形状变更必须升它）。 */
export const MATERIAL_CONTENT_CONTRACT_VERSION = '1.0.0'

/** 路径后缀：`<prefix>/<material_id>/content`。 */
const CONTENT_PATH_SUFFIX = '/content'

/**
 * G-14 路径中段：`/page/<page_no>`。逐页图端点只接受
 * `<prefix>/<material_id>/page/<page_no>` 这一种形状，page_no 为 1-based 正整数。
 */
const PAGE_PATH_MIDDLE = '/page/'

/** 查询参数白名单（只这两个；其余一律 400）。 */
const ALLOWED_QUERY_PARAMS = ['application_id', 'resume_version_id'] as const

/** 逐页图端点的查询白名单：在原件白名单之上只多一个 `dpi`（缺省 144）。 */
const ALLOWED_PAGE_QUERY_PARAMS = [...ALLOWED_QUERY_PARAMS, 'dpi'] as const

/** 逐页图默认渲染分辨率（契约 §2.2；page_image.py 默认 200，这里按产品契约固定 144）。 */
const DEFAULT_PAGE_DPI = 144

/** 客户端**不许**覆盖的身份参数/头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_QUERY = ['actor_id', 'tenant_id'] as const
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const

/** mime_type 非法/缺失时的回退（浏览器不能因为脏 mime 就把原件当 HTML 执行）。 */
const DEFAULT_CONTENT_TYPE = 'application/octet-stream'

/** 非文件响应（JSON 错误）的固定头：绝不缓存（读的是真实业务状态）。 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** 文件名在 header 里的最大长度（防超长 header；不截断 sha 之类的事实）。 */
const MAX_FILENAME_LENGTH = 120

/** RFC 7230 token 允许的字符（content-type 的 type/subtype 逐段校验）。 */
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/

/** 控制字符（header 注入的载体：CR/LF/NUL 等）——header 组装前一律剔除。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

// =====================================================================
//  依赖 / 宿主上下文（窄接口：插件包不依赖宿主 webServer 的类型）
// =====================================================================

/** 宿主 `webServer` 服务的最小面（只取注册、host、port）。 */
interface MaterialContentWebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文的窄接口（`webServer` 由 cordis 服务注入；`logger` 可选）。 */
export interface MaterialContentHostContext {
  readonly webServer: MaterialContentWebServerFace
  readonly logger?: { warn(message: string): void }
}

/** 路由依赖（库配置 + 未配置时的 issues + 可注入的允许根）。 */
export interface MaterialContentDeps {
  /** 已解析的库配置；`null` = 未配置（路由仍存在，但 503 NOT_CONFIGURED）。 */
  readonly database: ResolvedDatabaseConfig | null
  /** 未配置时缺失的配置项（只放配置键名，绝不放密码/路径）。 */
  readonly databaseIssues: readonly string[]
  /**
   * 允许根（材料定位用）。缺省 = 读 `RECRUITMENT_ALLOWED_ROOT_*`（与 converter 同一组 env）。
   * 生产不传；测试注入临时目录。
   */
  readonly roots?: () => readonly string[]
  /**
   * G-14 逐页图渲染所需的 converter 配置（python_bin / converter_dir / timeout）。
   * 缺省时按部署 env（RECRUITMENT_PYTHON_BIN / RECRUITMENT_CONVERTER_DIR /
   * RECRUITMENT_ALLOWED_ROOT_*）解析；`null` = 显式未配置（页面端点 503）。
   * 生产不传（与既有调用点兼容）；测试可注入最小假配置。
   */
  readonly converter?: ResolvedConverterConfig | null
  /**
   * G-14 桥接函数。缺省 = `runFallbackBridge`（真实调用 converter/fallback/page_image.py）。
   * 只为单元测试注入假桥；签名与真实桥一致，生产路径零分叉。
   */
  readonly pageBridge?: typeof runFallbackBridge
  /**
   * G-14 只读元数据查询的可注入接缝（测试用）。缺省 = 走 withReadOnly + 既有 readMaterialLookup。
   * 注入值必须保持同样的拒绝语义（不返回材料时不猜、不泄漏）；生产不传。
   */
  readonly materialLookup?: (materialId: string) => Promise<MaterialLookup>
}

// =====================================================================
//  纯函数：Range 解析 / Content-Disposition / Content-Type（可直接单测）
// =====================================================================

/**
 * 单区间 Range 的解析结果。
 *
 * - `FULL`：没有 Range / 语法不合法 / 多区间（RFC 7233：不认识的 Range **忽略**，回整份 200）；
 * - `PARTIAL`：可满足的单区间（含开区间 `a-` 与后缀区间 `-n`），回 206；
 * - `UNSATISFIABLE`：语法合法但落在资源外（`a >= size`、`-0`），回 416。
 */
export type ByteRange =
  | { readonly kind: 'FULL' }
  | { readonly kind: 'PARTIAL'; readonly start: number; readonly end: number }
  | { readonly kind: 'UNSATISFIABLE' }

/**
 * 解析 `Range: bytes=...`（**只支持单区间**；多区间按 RFC 忽略 → 整份 200）。
 *
 * 语义刻意保守：语法不合法一律 `FULL`（RFC 7233 §3.1「invalid Range 必须忽略」），
 * 只有"语法合法但不可满足"才 416——否则一个 `Range: bytes=abc` 会把正常下载变成 416。
 * @param header - `req.headers.range` 原值（缺省 = 没有 Range）。
 * @param size - 资源总字节数（必须 > 0）。
 * @returns {@link ByteRange}。
 */
export function parseByteRange(header: string | undefined | null, size: number): ByteRange {
  if (typeof header !== 'string') return { kind: 'FULL' }
  const matched = /^bytes=(.*)$/i.exec(header.trim())
  if (matched === null) return { kind: 'FULL' }
  const spec = (matched[1] ?? '').trim()
  // 多区间（`bytes=0-1,4-5`）：不实现 multipart/byteranges，按 RFC 忽略整个 Range。
  if (spec.includes(',')) return { kind: 'FULL' }
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (parts === null) return { kind: 'FULL' }
  const rawStart = parts[1] ?? ''
  const rawEnd = parts[2] ?? ''
  if (rawStart === '' && rawEnd === '') return { kind: 'FULL' }
  if (!Number.isSafeInteger(size) || size <= 0) return { kind: 'UNSATISFIABLE' }

  if (rawStart === '') {
    // 后缀区间 `bytes=-n`：最后 n 个字节。
    //   · n <= 0（含 `-0`）→ 不可满足（416）；
    //   · n 比资源还长 → 按 RFC 7233「整份」退化成 0-(size-1)（仍是有内容的 206）。
    const suffixLength = Number(rawEnd)
    if (suffixLength <= 0) return { kind: 'UNSATISFIABLE' }
    if (!Number.isSafeInteger(suffixLength) || suffixLength >= size) {
      return { kind: 'PARTIAL', start: 0, end: size - 1 }
    }
    return { kind: 'PARTIAL', start: size - suffixLength, end: size - 1 }
  }

  const start = Number(rawStart)
  // 纯数字但超出安全整数 ⇒ 一定 >= size ⇒ 不可满足（不是"忽略"）。
  if (!Number.isSafeInteger(start)) return { kind: 'UNSATISFIABLE' }
  if (start >= size) return { kind: 'UNSATISFIABLE' }
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  // `last-byte-pos < first-byte-pos` = 语法非法 → 忽略（不是 416）。
  if (Number.isSafeInteger(end) && end < start) return { kind: 'FULL' }
  // last-byte-pos 超出资源 → 截到 size-1（RFC 7233：服务器可以缩短）。
  return { kind: 'PARTIAL', start, end: Number.isSafeInteger(end) ? Math.min(end, size - 1) : size - 1 }
}

/** 目标文件的 basename（兼容 `/` 与 `\`，跨平台一致；与 task-context 同一语义）。 */
function materialBaseName(fileName: string): string {
  const flat = fileName.replace(/\\/g, '/')
  return flat.slice(flat.lastIndexOf('/') + 1)
}

/**
 * RFC 5987 的百分号编码（`filename*=UTF-8''<pct>` 的值）。
 *
 * 只保留 attr-char（RFC 5987 §3.2.1），其余按 UTF-8 字节 `%XX`（大写）；这样 header 里
 * 不可能出现 CR/LF/空格/引号，也就不可能被注入第二个 header。
 * @param value - 已 sanitize 的文件名。
 */
function encodeRfc5987(value: string): string {
  const attrChar = /[A-Za-z0-9!#$&+\-.^_`|~]/
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte)
    out += attrChar.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/**
 * 组装 `content-disposition: inline`（RFC 6266 + RFC 5987）。
 *
 * 纪律：只用 **basename**（去掉客户端/DB 里的路径片段）、剔除控制字符与引号
 * （header 注入）、ASCII fallback 用 `filename="..."`、UTF-8 原值用 `filename*=`。
 * @param fileName - `intake_asset.file_name`（可能含路径片段/非 ASCII/控制字符）。
 * @returns 完整的 Content-Disposition 头值。
 */
export function contentDispositionInline(fileName: string): string {
  const base = materialBaseName(fileName).replace(CONTROL_CHARS, '').replace(/["\\]/g, '').trim()
  const name = base === '' ? 'material' : base.slice(0, MAX_FILENAME_LENGTH)
  // ASCII fallback：非可打印 ASCII 一律 `_`（老浏览器只认这一段）。
  const ascii = name.replace(/[^\x20-\x7e]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

/**
 * 规范化 `content-type`：只认 `type/subtype` 形状，其余（缺失/带 CRLF/奇怪串）回退
 * `application/octet-stream`。**绝不**把 DB 里的原值直接塞进 header。
 * @param mimeType - `intake_asset.mime_type`（可空）。
 * @returns 可安全写入 header 的 media type。
 */
export function contentTypeFor(mimeType: string | null | undefined): string {
  if (typeof mimeType !== 'string') return DEFAULT_CONTENT_TYPE
  const bare = (mimeType.split(';')[0] ?? '').replace(CONTROL_CHARS, '').trim().toLowerCase()
  return MEDIA_TYPE_PATTERN.test(bare) ? bare : DEFAULT_CONTENT_TYPE
}

/**
 * 从 pathname 里取出 material_id（只接受 `<prefix>/<uuid>/content` 这一种形状）。
 * @param pathname - `new URL(req.url, base).pathname`。
 * @returns `OK` + 小写 UUID / `INVALID`（形状像但 id 非法 → 400）/ `NOT_FOUND`（不是本端点 → 404）。
 */
export function parseMaterialContentPath(
  pathname: string,
): { readonly kind: 'OK'; readonly materialId: string } | { readonly kind: 'INVALID' } | { readonly kind: 'NOT_FOUND' } {
  const prefix = `${MATERIAL_CONTENT_ROUTE_PREFIX}/`
  if (!pathname.startsWith(prefix) || !pathname.endsWith(CONTENT_PATH_SUFFIX)) return { kind: 'NOT_FOUND' }
  const middle = pathname.slice(prefix.length, pathname.length - CONTENT_PATH_SUFFIX.length)
  // 多余层级（`<id>/extra/content`）不是本端点的形状：400（而不是去 decode 一段路径）。
  if (middle === '' || middle.includes('/')) return { kind: 'INVALID' }
  let decoded: string
  try {
    decoded = decodeURIComponent(middle)
  } catch {
    return { kind: 'INVALID' }
  }
  // 编码穿越（`..%2F..%2Fetc`）解码后含 `/`；非 UUID 一律 400，绝不进 DB/磁盘。
  if (!isUuid(decoded)) return { kind: 'INVALID' }
  return { kind: 'OK', materialId: decoded.toLowerCase() }
}

/**
 * G-14：从 pathname 里取 material_id 与 1-based page_no（只接受
 * `<prefix>/<uuid>/page/<positive-int>` 一种形状）。
 *
 * 纪律与 {@link parseMaterialContentPath} 相同：只 decode 中段 UUID，page_no 只认
 * 纯十进制正整数（拒绝 `+1` / `01` / `1.0` / 超安全整数 / 编码穿越），绝不把
 * 路径片段送进 resolver 或 DB。
 */
export function parseMaterialPagePath(pathname: string):
  | { readonly kind: 'OK'; readonly materialId: string; readonly pageNo: number }
  | { readonly kind: 'INVALID' }
  | { readonly kind: 'NOT_FOUND' } {
  const prefix = `${MATERIAL_CONTENT_ROUTE_PREFIX}/`
  if (!pathname.startsWith(prefix)) return { kind: 'NOT_FOUND' }
  const rest = pathname.slice(prefix.length)
  const marker = rest.indexOf(PAGE_PATH_MIDDLE)
  if (marker < 0) return { kind: 'NOT_FOUND' }
  const materialPart = rest.slice(0, marker)
  if (materialPart === '' || materialPart.includes('/')) return { kind: 'INVALID' }
  const pageAndExtra = rest.slice(marker + PAGE_PATH_MIDDLE.length)
  if (pageAndExtra.includes('/')) return { kind: 'INVALID' }
  let decoded: string
  try {
    decoded = decodeURIComponent(materialPart)
  } catch {
    return { kind: 'INVALID' }
  }
  if (!isUuid(decoded)) return { kind: 'INVALID' }
  const rawPage = pageAndExtra
  if (!/^[1-9][0-9]*$/.test(rawPage)) return { kind: 'INVALID' }
  const pageNo = Number(rawPage)
  if (!Number.isSafeInteger(pageNo) || pageNo < 1) return { kind: 'INVALID' }
  return { kind: 'OK', materialId: decoded.toLowerCase(), pageNo }
}

// =====================================================================
//  错误信封（闭集 code；message 里绝不出现本机绝对路径）
// =====================================================================

/** 一个可被本路由直接返回的问题（状态码 + 闭集 code + reason_code + detail）。 */
interface MaterialContentProblem {
  /** HTTP 状态码；`code` 仍取闭集（416 只有 `content-range` + reason_code 精确表达）。 */
  readonly status: number
  readonly code: 'INVALID_ARGS' | 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_CONFIGURED' | 'INTERNAL'
  readonly reason_code: string
  readonly message: string
  readonly detail?: Readonly<Record<string, unknown>>
}

/** 构造一个 {@link MaterialContentProblem}（少写重复对象）。 */
function problem(
  status: number,
  code: MaterialContentProblem['code'],
  reasonCode: string,
  message: string,
  detail?: Readonly<Record<string, unknown>>,
): MaterialContentProblem {
  return { status, code, reason_code: reasonCode, message, ...(detail === undefined ? {} : { detail }) }
}

/** 写 JSON 错误体（固定 no-store；额外头可选，例如 416 的 `content-range`）。 */
function sendProblem(
  res: ServerResponse,
  value: MaterialContentProblem,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(value.status, { ...JSON_HEADERS, ...extraHeaders })
  res.end(JSON.stringify({
    error: {
      code: value.code,
      reason_code: value.reason_code,
      message: value.message,
      ...(value.detail === undefined ? {} : { detail: value.detail }),
    },
  }))
}

// =====================================================================
//  DB（全部 SELECT；只跑在 withReadOnly 的只读事务里）
// =====================================================================

/** `intake_asset` 的一行（byte_size 是 bigint：pg 返回字符串，用前必须 Number()）。 */
interface MaterialAssetRow {
  readonly asset_id: string
  readonly file_name: string
  readonly mime_type: string | null
  readonly byte_size: string | number
  readonly sha256: string
  readonly storage_ref: string
  readonly validation_status: string
}

/** 材料行（同租户）。**注意**：`storage_ref` 只有 `content-addressed:sha256:<sha>`，没有路径。 */
const ASSET_SQL = `
  select ia.id::text        as asset_id,
         ia.file_name       as file_name,
         ia.mime_type       as mime_type,
         ia.byte_size       as byte_size,
         ia.sha256          as sha256,
         ia.storage_ref     as storage_ref,
         ia.validation_status as validation_status
    from recruitment.intake_asset ia
   where ia.tenant_id = $1::uuid
     and ia.id = $2::uuid
`

/** 该 asset 是否至少被一条同租户 `resume` 引用（未绑定 → 不提供原件，fail-closed）。 */
const RESUME_BOUND_SQL = `
  select r.id::text as resume_id
    from recruitment.resume r
   where r.tenant_id = $1::uuid
     and r.intake_asset_id = $2::uuid
   limit 1
`

/** 该 asset 经 `resume → resume_version` 关联到的版本行（可选用于归属校验）。 */
const ASSET_RESUME_VERSION_SQL = `
  select rv.id::text as resume_version_id
    from recruitment.resume r
    join recruitment.resume_version rv
      on rv.resume_id = r.id and rv.tenant_id = r.tenant_id
   where r.tenant_id = $1::uuid
     and r.intake_asset_id = $2::uuid
     and rv.id = $3::uuid
`

/** 申请行（只取归属校验需要的两列；不读业务正文）。 */
const APPLICATION_LINK_SQL = `
  select a.id::text                    as application_id,
         a.resume_version_id::text     as resume_version_id
    from recruitment.application a
   where a.tenant_id = $1::uuid
     and a.id = $2::uuid
`

/** 查询结果：OK = 可继续定位；REJECT = 直接按契约返回（不抛异常，保持事务干净结束）。 */
type MaterialLookup =
  | { readonly kind: 'OK'; readonly asset: MaterialAssetRow }
  | { readonly kind: 'REJECT'; readonly problem: MaterialContentProblem }

/**
 * 查材料并做归属校验（**只读**；接收事务内 client，不自己建池/开事务）。
 *
 * 顺序固定（CONTRACT §1.2 的 1→2→3）：
 *   1. asset 同租户存在？否 → 404 `MATERIAL_NOT_FOUND`（**不区分**跨租户）；
 *   2. 至少被一条同租户 resume 引用？否 → 404 `MATERIAL_ORIGINAL_UNBOUND`；
 *   3. 给了 `application_id` / `resume_version_id` → 按 resume→resume_version→application
 *      关联校验；不匹配 → 403（不泄漏该 id 是否存在）。
 * @param client - 只读事务内连接。
 * @param cfg - 已解析配置（tenant 只从这里来）。
 * @param materialId - 已校验的 UUID。
 * @param applicationId - 可选归属校验用申请 id。
 * @param resumeVersionId - 可选归属校验用简历版本 id。
 * @returns 材料行或契约化拒绝。
 */
async function readMaterialLookup(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  materialId: string,
  applicationId: string | null,
  resumeVersionId: string | null,
): Promise<MaterialLookup> {
  const tenantId = cfg.tenant_id

  const assetResult = await client.query<MaterialAssetRow>(ASSET_SQL, [tenantId, materialId])
  const asset = assetResult.rows[0]
  if (asset === undefined) {
    return {
      kind: 'REJECT',
      problem: problem(404, 'NOT_FOUND', 'MATERIAL_NOT_FOUND', '材料不存在（或不属于当前租户）', { material_id: materialId }),
    }
  }

  const boundResult = await client.query<{ resume_id: string }>(RESUME_BOUND_SQL, [tenantId, materialId])
  if (boundResult.rows.length === 0) {
    return {
      kind: 'REJECT',
      problem: problem(
        404,
        'NOT_FOUND',
        'MATERIAL_ORIGINAL_UNBOUND',
        '该材料没有被任何简历引用，拒绝提供原件（先完成入库绑定）',
        { material_id: materialId },
      ),
    }
  }

  if (applicationId !== null) {
    const applicationResult = await client.query<{ application_id: string; resume_version_id: string | null }>(
      APPLICATION_LINK_SQL,
      [tenantId, applicationId],
    )
    const application = applicationResult.rows[0]
    if (application === undefined || application.resume_version_id === null) {
      return {
        kind: 'REJECT',
        problem: problem(
          403,
          'FORBIDDEN',
          'MATERIAL_NOT_LINKED_TO_APPLICATION',
          '该材料不属于这个申请（归属校验不通过）',
          { material_id: materialId, application_id: applicationId },
        ),
      }
    }
    const linked = await client.query<{ resume_version_id: string }>(ASSET_RESUME_VERSION_SQL, [
      tenantId,
      materialId,
      application.resume_version_id,
    ])
    if (linked.rows.length === 0) {
      return {
        kind: 'REJECT',
        problem: problem(
          403,
          'FORBIDDEN',
          'MATERIAL_NOT_LINKED_TO_APPLICATION',
          '该材料不属于这个申请（归属校验不通过）',
          { material_id: materialId, application_id: applicationId },
        ),
      }
    }
  }

  if (resumeVersionId !== null) {
    const linked = await client.query<{ resume_version_id: string }>(ASSET_RESUME_VERSION_SQL, [
      tenantId,
      materialId,
      resumeVersionId,
    ])
    if (linked.rows.length === 0) {
      return {
        kind: 'REJECT',
        problem: problem(
          403,
          'FORBIDDEN',
          'MATERIAL_NOT_LINKED_TO_RESUME_VERSION',
          '该材料不属于这个简历版本（归属校验不通过）',
          { material_id: materialId, resume_version_id: resumeVersionId },
        ),
      }
    }
  }

  return { kind: 'OK', asset }
}

// =====================================================================
//  HTTP 处理器
// =====================================================================

/** `webServer.host` 是否回环地址（非回环一律不注册）。 */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

/**
 * 找客户端覆盖身份的企图（query `actor_id`/`tenant_id` + 头 `x-recruitment-actor`/`-tenant`）。
 * **不碰 DB**：命中即 400。
 * @param req - node 请求（只读 headers）。
 * @param url - 解析后的 URL。
 */
function findActorOverrides(req: Pick<IncomingMessage, 'headers'>, url: URL): string[] {
  const found: string[] = []
  for (const key of ACTOR_OVERRIDE_QUERY) {
    if (url.searchParams.has(key)) found.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) found.push(`header.${key}`)
  }
  return found
}

/**
 * G-14 converter 配置解析：生产不注入时从部署 env 读，与 `cordis.patch.yml` 同一组变量名。
 * 只取绝对路径；缺任何一项即返回 null（页面端点回 503 NOT_CONFIGURED，fail-closed）。
 */
function converterConfigFor(deps: MaterialContentDeps): ResolvedConverterConfig | null {
  if (deps.converter !== undefined) return deps.converter
  const env = process.env
  const result = resolveConverterConfig({
    python_bin: '${RECRUITMENT_PYTHON_BIN}',
    converter_dir: '${RECRUITMENT_CONVERTER_DIR}',
    allowed_roots: materialRootsFromEnv(env),
    timeout_ms: 60_000,
  }, env)
  return result.resolved
}

/**
 * 非 PDF 判定：mime_type 是权威事实——只要给了合法 mime 且不是 application/pdf 就 415；
 * 只有 mime 缺失/非法（回退成 application/octet-stream）时才退而看 .pdf 后缀。
 */
function isPdfMaterial(asset: MaterialAssetRow): boolean {
  const mime = contentTypeFor(asset.mime_type)
  const declared = typeof asset.mime_type === 'string' && MEDIA_TYPE_PATTERN.test(
    (asset.mime_type.split(';')[0] ?? '').replace(CONTROL_CHARS, '').trim().toLowerCase(),
  )
  if (declared) return mime === 'application/pdf'
  return /\.pdf$/i.test(materialBaseName(asset.file_name))
}

/**
 * 桥返回 → page_count（只接受正整数）。
 *
 * G-14 清理后 page_image.py / fallback_bridge.py 原生带 `render.page_count`
 * （来自 `fitz.Document.page_count`）。这里**只读**它：不再以 page=1_000_000
 * 的哨兵渲染触发 `page_out_of_range`、也不解析错误消息文本。缺字段/形状不对
 * 就 fail-closed（500 PAGE_COUNT_UNKNOWN），绝不猜页数、绝不第二次调桥。
 */
function pageCountFromBridge(response: Readonly<Record<string, unknown>>): number | null {
  const render = response.render
  if (typeof render !== 'object' || render === null || Array.isArray(render)) return null
  const value = (render as Record<string, unknown>).page_count
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 删除桥产物（只删 page_image.py 命名的单文件，绝不删目录/任意路径）。 */
function discardPng(imagePath: string): void {
  try {
    if (/^page-\d+@\d+dpi\.png$/.test(materialBaseName(imagePath))) rmSync(imagePath, { force: true })
  } catch {
    // 清理失败不改变响应（零写入契约不受影响）。
  }
}

/**
 * G-14：把 PNG 送出响应，并**在响应体 finished / close / error 时清理临时 PNG**。
 *
 * 只删桥返回的 image_path 指向的那一个临时文件（page_image.py 只产生这一个文件，
 * 不清理整个目录，避免碰到同一目录里别人的产物）。路径先经 basename 校验：
 * 只允许系统 temp 下 `page-*.png` 形态，绝不按外部输入删任意路径。
 */
function streamPngAndCleanup(res: ServerResponse, imagePath: string, headers: Record<string, string>): void {
  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    discardPng(imagePath)
  }
  res.once('finish', cleanup)
  res.once('close', cleanup)
  res.once('error', cleanup)
  const stream = createReadStream(imagePath)
  stream.on('error', () => {
    if (!res.headersSent) {
      sendProblem(res, problem(500, 'INTERNAL', 'PAGE_IMAGE_READ_FAILED', '逐页图读取失败（零写入）'))
    } else {
      res.destroy()
    }
    cleanup()
  })
  if (res.headersSent) {
    stream.destroy()
    return
  }
  res.writeHead(200, headers)
  // 头发出后 open 还没到也无所谓：pipe 会等；错误由上面的 handler 统一 destroy。
  stream.pipe(res)
}

/**
 * 处理一次 `GET /recruitment/api/material/<id>/page/<page_no>`（G-14）。
 *
 * 复用与 `/content` 完全相同的约束链：sameOrigin → 方法 → 路径 → 身份覆盖 →
 * 查询白名单 → DB 配置 → withReadOnly 归属 → resolveMaterialPath → lstat 复核，
 * 之后才走 runFallbackBridge（唯一渲染实现 page_image.py）。任何失败路径零写入、
 * 不回本机绝对路径，错误信封与既有 material 路由一致。
 */
async function handleMaterialPageImage(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MaterialContentDeps,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // ---- 1. 同源（judgement 唯一实现：overview.ts::sameOrigin）----
  if (!sameOrigin(req, port)) {
    sendProblem(
      res,
      problem(
        403,
        'FORBIDDEN',
        'SAME_ORIGIN_REQUIRED',
        '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
      ),
    )
    return
  }

  // ---- 2. 方法：只有 GET（HEAD 留给 /content）----
  if (req.method !== 'GET') {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(405, { allow: 'GET', ...JSON_HEADERS })
    res.end()
    return
  }

  // ---- 3. 路径形状 ----
  const route = parseMaterialPagePath(url.pathname)
  if (route.kind === 'NOT_FOUND') {
    sendProblem(res, problem(404, 'NOT_FOUND', 'ROUTE_NOT_FOUND', '本前缀下逐页图端点是 /page/<page_no>'))
    return
  }
  if (route.kind === 'INVALID') {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'PAGE_PATH_INVALID', 'material_id 必须是 UUID，page_no 必须是 1-based 正整数'))
    return
  }

  // ---- 4. 身份覆盖（与 /content 同一判据）----
  const overrides = findActorOverrides(req, url)
  if (overrides.length > 0) {
    sendProblem(
      res,
      problem(
        400,
        'INVALID_ARGS',
        'ACTOR_OVERRIDE_REJECTED',
        'actor/tenant 只来自插件配置，不接受客户端传入（D-33 / IR-M4d）',
        { rejected: overrides },
      ),
    )
    return
  }

  // ---- 5. 查询参数白名单 + 形状 ----
  const unknownParams = [...url.searchParams.keys()].filter(
    (key) => !(ALLOWED_PAGE_QUERY_PARAMS as readonly string[]).includes(key),
  )
  if (unknownParams.length > 0) {
    sendProblem(
      res,
      problem(
        400,
        'INVALID_ARGS',
        'UNKNOWN_PARAM',
        `未声明的查询参数 "${unknownParams[0]}"（允许：${ALLOWED_PAGE_QUERY_PARAMS.join(', ')}）`,
        { unknown: unknownParams, allowed: [...ALLOWED_PAGE_QUERY_PARAMS] },
      ),
    )
    return
  }
  const applicationId = url.searchParams.get('application_id')
  const resumeVersionId = url.searchParams.get('resume_version_id')
  if (applicationId !== null && !isUuid(applicationId)) {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID 文本', { field: 'application_id' }))
    return
  }
  if (resumeVersionId !== null && !isUuid(resumeVersionId)) {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'resume_version_id 必须是 UUID 文本', { field: 'resume_version_id' }))
    return
  }
  const rawDpi = url.searchParams.get('dpi')
  let dpi = DEFAULT_PAGE_DPI
  if (rawDpi !== null) {
    if (!/^[1-9][0-9]*$/.test(rawDpi)) {
      sendProblem(res, problem(400, 'INVALID_ARGS', 'DPI_INVALID', 'dpi 必须是正整数'))
      return
    }
    dpi = Number(rawDpi)
    if (!Number.isSafeInteger(dpi) || dpi < 50 || dpi > 600) {
      sendProblem(res, problem(400, 'INVALID_ARGS', 'DPI_INVALID', 'dpi 超出范围（50..600）'))
      return
    }
  }

  // ---- 6. 渲染配置：缺失就 503（不猜 python 路径）----
  const converter = converterConfigFor(deps)
  if (converter === null) {
    sendProblem(
      res,
      problem(503, 'NOT_CONFIGURED', 'PAGE_RENDERER_NOT_CONFIGURED', '逐页图渲染未配置（缺 python_bin / converter_dir / allowed_roots）'),
    )
    return
  }

  // ---- 7. 只读元数据（复用 /content 的归属校验与 withReadOnly）----
  const database = deps.database
  if (database === null) {
    sendProblem(
      res,
      problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，取不到材料原件', { issues: [...deps.databaseIssues] }),
    )
    return
  }
  let lookup: MaterialLookup
  if (deps.materialLookup !== undefined) {
    try {
      lookup = await deps.materialLookup(route.materialId)
    } catch {
      sendProblem(res, problem(500, 'INTERNAL', 'DB_READ_FAILED', '读取材料元数据失败'))
      return
    }
  } else {
    const pool = createPool(database)
    try {
      lookup = await withReadOnly(pool, (client) =>
        readMaterialLookup(client, database, route.materialId, applicationId, resumeVersionId))
    } catch {
      sendProblem(res, problem(500, 'INTERNAL', 'DB_READ_FAILED', '读取材料元数据失败'))
      return
    } finally {
      await closePool(pool)
    }
  }
  if (lookup.kind === 'REJECT') {
    sendProblem(res, lookup.problem)
    return
  }
  const asset = lookup.asset

  // ---- 8. 非 PDF：415（诚实降级，不叫渲染器猜格式）----
  if (!isPdfMaterial(asset)) {
    sendProblem(res, problem(415, 'INVALID_ARGS', 'UNSUPPORTED_FORMAT', '该格式暂不支持逐页图预览，可下载原件或查看结构化原文'))
    return
  }

  // ---- 9. 定位（唯一实现）+ lstat 复核（与 /content 完全同构）----
  const byteSize = Number(asset.byte_size)
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    sendProblem(res, problem(500, 'INTERNAL', 'MATERIAL_BYTE_SIZE_INVALID', '材料的 byte_size 非法（数据不一致）'))
    return
  }
  const roots = deps.roots === undefined ? undefined : deps.roots()
  const resolution = resolveMaterialPath(
    { fileName: asset.file_name, byteSize, sha256: asset.sha256 },
    roots === undefined ? {} : { roots },
  )
  if (resolution.path === null) {
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: resolution.reason,
      }),
    )
    return
  }
  const filePath = resolution.path
  let located: ReturnType<typeof lstatSync>
  try {
    located = lstatSync(filePath)
  } catch {
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: 'NOT_FOUND_IN_ALLOWED_ROOTS',
      }),
    )
    return
  }
  if (located.isSymbolicLink() || !located.isFile() || located.size !== byteSize) {
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: 'NOT_FOUND_IN_ALLOWED_ROOTS',
      }),
    )
    return
  }

  // ---- 10. 调桥渲染（零重写：converter/fallback/page_image.py）----
  const bridge = deps.pageBridge ?? runFallbackBridge
  let response: Record<string, unknown>
  try {
    response = await bridge(converter, { op: 'page-image', pdf: filePath, page: route.pageNo, dpi })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendProblem(res, problem(500, 'INTERNAL', 'PAGE_RENDER_FAILED', '逐页图渲染失败', { reason: message.slice(0, 200) }))
    return
  }
  if (response.ok !== true) {
    const code = typeof response.code === 'string' ? response.code : 'render_failed'
    if (code === 'page_out_of_range' || code === 'page_invalid') {
      sendProblem(
        res,
        problem(400, 'INVALID_ARGS', 'PAGE_OUT_OF_RANGE', '页码超出该 PDF 的总页数', { page_no: route.pageNo }),
      )
    } else {
      sendProblem(res, problem(500, 'INTERNAL', 'PAGE_RENDER_FAILED', '逐页图渲染失败', { reason: code }))
    }
    return
  }

  const render = response.render as Record<string, unknown>
  const imagePath = typeof render.image_path === 'string' ? render.image_path : ''
  if (imagePath === '') {
    sendProblem(res, problem(500, 'INTERNAL', 'PAGE_IMAGE_MISSING', '渲染没有给出图片文件'))
    return
  }

  // X-Page-Count：只读桥原生的 render.page_count（fitz.Document.page_count）。
  // 不再发第二次 page=1_000_000 哨兵渲染、不再解析 page_out_of_range 消息文本：
  // 那既浪费一次子进程 + 光栅化，又把 HTTP 契约绑死在 Python 错误消息的字面量上。
  // 桥没带页数就诚实 fail-closed（500），清理刚写出的 PNG，不猜、不重试。
  const pageCount = pageCountFromBridge(response)
  if (pageCount === null) {
    discardPng(imagePath)
    sendProblem(res, problem(500, 'INTERNAL', 'PAGE_COUNT_UNKNOWN', '无法确定 PDF 总页数'))
    return
  }
  if (route.pageNo > pageCount) {
    discardPng(imagePath)
    sendProblem(
      res,
      problem(400, 'INVALID_ARGS', 'PAGE_OUT_OF_RANGE', '页码超出该 PDF 的总页数', { page_no: route.pageNo }),
    )
    return
  }

  // ---- 11. 200 image/png + 契约头；响应体结束即清理临时 PNG ----
  streamPngAndCleanup(res, imagePath, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-page-count': String(pageCount),
    'x-page-number': String(route.pageNo),
  })
}

/**
 * 处理一次 `GET|HEAD /recruitment/api/material/<id>/content`。
 *
 * 校验顺序（每一步都在下一资源之前；DB 未配置在参数校验之后，形状错误仍回 400）：
 * sameOrigin → 方法 → 路径形状 → 身份覆盖 → 查询白名单/形状 → DB 配置 → DB 归属 → 定位 → 复核 → 响应。
 * @param req - node 请求。
 * @param res - node 响应。
 * @param deps - 路由依赖。
 * @param port - 本机 Web 监听端口（sameOrigin 用）。
 */
async function handleMaterialContent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MaterialContentDeps,
  port: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // ---- 0. G-14 分发：同一前缀下 `/page/<page_no>` 走逐页图端点，其它原样走 /content ----
  if (url.pathname.startsWith(`${MATERIAL_CONTENT_ROUTE_PREFIX}/`)
      && url.pathname.includes(PAGE_PATH_MIDDLE)) {
    await handleMaterialPageImage(req, res, deps, port)
    return
  }

  // ---- 1. 同源（判据复用 overview.ts::sameOrigin，不复制第二份）----
  if (!sameOrigin(req, port)) {
    sendProblem(
      res,
      problem(
        403,
        'FORBIDDEN',
        'SAME_ORIGIN_REQUIRED',
        '只接受同源 loopback 请求（Host=127.0.0.1/localhost:<port>，x-recruitment-request: 1）',
      ),
    )
    return
  }

  // ---- 2. 方法（GET/HEAD；其余 405 + allow）----
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(405, { allow: 'GET, HEAD', ...JSON_HEADERS })
    res.end()
    return
  }

  // ---- 3. 路径形状（只认 `<prefix>/<uuid>/content`）----
  const route = parseMaterialContentPath(url.pathname)
  if (route.kind === 'NOT_FOUND') {
    sendProblem(res, problem(404, 'NOT_FOUND', 'ROUTE_NOT_FOUND', '本前缀下只有 /recruitment/api/material/<material_id>/content'))
    return
  }
  if (route.kind === 'INVALID') {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'MATERIAL_ID_INVALID', 'material_id 必须是 UUID 文本'))
    return
  }
  const materialId = route.materialId

  // ---- 4. 身份覆盖（tenant/actor 只来自插件配置）----
  const overrides = findActorOverrides(req, url)
  if (overrides.length > 0) {
    sendProblem(
      res,
      problem(
        400,
        'INVALID_ARGS',
        'ACTOR_OVERRIDE_REJECTED',
        'actor/tenant 只来自插件配置，不接受客户端传入（D-33 / IR-M4d）',
        { rejected: overrides },
      ),
    )
    return
  }

  // ---- 5. 查询参数白名单 + 形状 ----
  const unknownParams = [...url.searchParams.keys()].filter(
    (key) => !(ALLOWED_QUERY_PARAMS as readonly string[]).includes(key),
  )
  if (unknownParams.length > 0) {
    sendProblem(
      res,
      problem(
        400,
        'INVALID_ARGS',
        'UNKNOWN_PARAM',
        `未声明的查询参数 "${unknownParams[0]}"（允许：${ALLOWED_QUERY_PARAMS.join(', ')}）`,
        { unknown: unknownParams, allowed: [...ALLOWED_QUERY_PARAMS] },
      ),
    )
    return
  }
  const applicationId = url.searchParams.get('application_id')
  const resumeVersionId = url.searchParams.get('resume_version_id')
  if (applicationId !== null && !isUuid(applicationId)) {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'application_id 必须是 UUID 文本', { field: 'application_id' }))
    return
  }
  if (resumeVersionId !== null && !isUuid(resumeVersionId)) {
    sendProblem(res, problem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'resume_version_id 必须是 UUID 文本', { field: 'resume_version_id' }))
    return
  }

  // ---- 6. 未配置：503（不假装成功、不猜库）----
  const database = deps.database
  if (database === null) {
    sendProblem(
      res,
      problem(503, 'NOT_CONFIGURED', 'NOT_CONFIGURED', '数据库未配置，取不到材料原件', { issues: [...deps.databaseIssues] }),
    )
    return
  }

  // ---- 7. 只读查库（withReadOnly：任何写都会被 PG 25006 拒绝）----
  const pool = createPool(database)
  let lookup: MaterialLookup
  try {
    lookup = await withReadOnly(pool, (client) =>
      readMaterialLookup(client, database, materialId, applicationId, resumeVersionId))
  } catch {
    // 不把驱动错误原文回给客户端（里面可能有连接串/内部细节）；失败不写库。
    sendProblem(res, problem(500, 'INTERNAL', 'DB_READ_FAILED', '读取材料元数据失败'))
    return
  } finally {
    await closePool(pool)
  }
  if (lookup.kind === 'REJECT') {
    sendProblem(res, lookup.problem)
    return
  }
  const asset = lookup.asset

  const byteSize = Number(asset.byte_size)
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    // 库层 CHECK 已保证 >0；走到这里说明数据坏了：如实 500，不猜大小。
    sendProblem(res, problem(500, 'INTERNAL', 'MATERIAL_BYTE_SIZE_INVALID', '材料的 byte_size 非法（数据不一致）'))
    return
  }

  // ---- 8. 原件定位：**复用唯一实现**（不自写扫盘、不接受路径参数）----
  const roots = deps.roots === undefined ? undefined : deps.roots()
  const resolution = resolveMaterialPath(
    { fileName: asset.file_name, byteSize, sha256: asset.sha256 },
    roots === undefined ? {} : { roots },
  )
  if (resolution.path === null) {
    // detail 只放 resolver 的 reason 闭集码；**不放**候选路径/根目录。
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: resolution.reason,
      }),
    )
    return
  }

  // ---- 9. FOUND 后复核（非符号链接 / 普通文件 / size 一致）：防 TOCTOU 与缓存脏读 ----
  const filePath = resolution.path
  let located: ReturnType<typeof lstatSync>
  try {
    located = lstatSync(filePath)
  } catch {
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: 'NOT_FOUND_IN_ALLOWED_ROOTS',
      }),
    )
    return
  }
  if (located.isSymbolicLink() || !located.isFile() || located.size !== byteSize) {
    sendProblem(
      res,
      problem(404, 'NOT_FOUND', 'MATERIAL_ORIGINAL_NOT_LOCATED', '原件不在允许根里（或超出检索预算），拒绝提供', {
        reason: 'NOT_FOUND_IN_ALLOWED_ROOTS',
      }),
    )
    return
  }

  // ---- 10. 响应头（mime / disposition 都经过 sanitize，不可能带出路径或注入 header）----
  const commonHeaders: Record<string, string> = {
    'content-type': contentTypeFor(asset.mime_type),
    'content-disposition': contentDispositionInline(asset.file_name),
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  }

  const range = parseByteRange(req.headers.range, byteSize)
  if (range.kind === 'UNSATISFIABLE') {
    // 协议要求 416 + `content-range: bytes */<size>`；code 仍落闭集，reason_code 精确表达。
    sendProblem(
      res,
      problem(416, 'INVALID_ARGS', 'RANGE_NOT_SATISFIABLE', 'Range 超出资源范围', {
        size: byteSize,
      }),
      { 'content-range': `bytes */${byteSize}` },
    )
    return
  }

  const partial = range.kind === 'PARTIAL'
  const status = partial ? 206 : 200
  const start = partial ? range.start : 0
  const end = partial ? range.end : byteSize - 1
  const headers: Record<string, string> = {
    ...commonHeaders,
    'content-length': String(end - start + 1),
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${byteSize}` } : {}),
  }

  if (req.method === 'HEAD') {
    res.writeHead(status, headers)
    res.end()
    return
  }

  // ---- 11. 流式送出（不整份进内存）；读流错误在头发送前映射 500，已发送则 destroy ----
  const stream = createReadStream(filePath, { start, end })
  try {
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
  } catch {
    stream.destroy()
    sendProblem(res, problem(500, 'INTERNAL', 'MATERIAL_READ_FAILED', '读取原件失败（零写入）'))
    return
  }
  stream.on('error', () => {
    // 头已发出：不能改状态码，只能把连接废掉，让客户端知道传输不完整。
    res.destroy()
  })
  res.writeHead(status, headers)
  stream.pipe(res)
}

/**
 * 注册 material 原件路由；返回 disposer（插件卸载即注销）。
 *
 * 非回环监听时**不注册**并告警：fail-closed——宁可面板取不到原件，
 * 也不把「按哈希在允许根里取字节」的能力挂到一个网络可达的地址上。
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param deps - 路由依赖（库配置 + issues + 可注入允许根）。
 * @returns 注销函数。
 */
export function registerMaterialContentHttp(ctx: MaterialContentHostContext, deps: MaterialContentDeps): () => void {
  const { webServer } = ctx
  if (!isLoopbackHost(webServer.host)) {
    ctx.logger?.warn(`recruitment: material-content 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const handler = (req: IncomingMessage, res: ServerResponse): Promise<void> =>
    handleMaterialContent(req, res, deps, port).catch(() => {
      // 兜底：任何未映射异常都不能把堆栈/路径写回客户端。
      // 头已发出（例如流开始后出错）时**绝不能再 writeHead**（ERR_HTTP_HEADERS_SENT 会抛给宿主），
      // 只能把连接废掉，让客户端知道传输不完整。
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendProblem(res, problem(500, 'INTERNAL', 'UNEXPECTED', '材料请求处理失败'))
    })

  return webServer.register({ kind: 'prefix', path: MATERIAL_CONTENT_ROUTE_PREFIX, handler })
}
