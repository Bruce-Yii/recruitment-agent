// 异步简历上传的**真库 + 真 HTTP** 集成测试（owner-upload-async lane）。
//
// 真实度纪律（AGENTS.md R2/R3/R5/L2/L5）：
//   1. 一次性 PostgreSQL 库（重放 0001→0019 全量迁移），用完 DROP；
//   2. 真 `node:http` server + `registerIntakeUploadHttp` 注册的 exact 路由 + `fetch` 原始字节体；
//   3. 断言只信**独立 SQL 读回**（直接用 pg pool，不 import 产品 DAO 自证）；
//   4. 每个负例同时断言「HTTP 拒绝码」+「6 张业务表行数前后不变」；
//   5. 202 的 <2s 断言证明不等待解析；终态轮询有明确上限，不写死解析耗时；
//   6. 缺 PG 口令 / converter 环境时**显式 skip 并标注原因**，绝不冒充全绿。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerIntakeUploadHttp, UPLOAD_PATH, type IntakeUploadDeps } from '../../src/http/intake-upload.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'
import { CONVERTER_DIR, PYTHON_BIN } from '../helpers/paths.ts'

// ---------------------------------------------------------------------------
//  环境探测（skip 必须诚实：跳过就是跳过，不能算通过）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, '..', '..', 'manual', 'golden-path', 'fixtures', 'synthetic-resume-golden-path.pdf')

/** PG 配置不可用时的跳过原因（不写密码、不写密钥）。 */
function pgSkipReason(): string | false {
  try {
    testDatabaseConfig()
    return false
  } catch (error) {
    return `一次性 PG 库不可用（环境变量/口令缺失）：${error instanceof Error ? error.message.slice(0, 160) : String(error)}`
  }
}
const SKIP_PG = pgSkipReason()

/** converter 环境不可用时只跳过"解析成功"用例；拒绝路径与终态失败仍可跑。 */
const CONVERTER_SKIP: string | false = PYTHON_BIN === undefined
  ? '找不到 Python 解释器（RECRUITMENT_PYTHON / python3 / python），跳过需要真转换器的用例'
  : false

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_UNBOUND = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const JOB_ID = '11111111-1111-4111-8111-000000000401' // 0002_seed 的 DEMO_JOB
const TABLES = [
  'business_task', 'event_inbox', 'intake_asset', 'resume_version', 'application', 'candidate',
] as const

// ---------------------------------------------------------------------------
//  共享夹具（一次性库 + 真 HTTP）
// ---------------------------------------------------------------------------

interface UploadServer {
  readonly baseUrl: string
  readonly port: number
  readonly registered: readonly string[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

let db: IsolatedTestDatabase
let server: UploadServer
let deps: IntakeUploadDeps
let allowedRoot: string

/** 整个文件只建一次库 / 一个 server（负例按顺序串行，快照对比稳定）。 */
test.before(async () => {
  if (SKIP_PG !== false) return
  db = await createIsolatedTestDatabase('intakeupload')
  assertPrivateDatabase(db.name)

  // 落地根：OS 临时目录下的一次性子目录（DB 层要求绝对路径，且必须 strict-inside）。
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  allowedRoot = await mkdtemp(join(tmpdir(), 'ra-upload-test-'))

  const base = testDatabaseConfig()
  deps = {
    database: { ...base, database: db.name },
    databaseIssues: [],
    converter: PYTHON_BIN === undefined ? null : {
      python_bin: PYTHON_BIN,
      converter_dir: process.env.RECRUITMENT_CONVERTER_DIR ?? CONVERTER_DIR,
      allowed_roots: [allowedRoot],
      timeout_ms: 180_000,
    } as ResolvedConverterConfig,
    identity: createDemoActorIdentity().identity,
  }
  deps.identity.registry.bind(SESSION, 'recruiter')

  server = await startUploadServer(deps)
})

test.after(async () => {
  if (server !== undefined) await server.close()
  if (allowedRoot !== undefined) {
    const { rm } = await import('node:fs/promises')
    await rm(allowedRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  if (db !== undefined) await db.drop()
})

/** 真 node:http：先 listen 拿端口，再注册 exact 路由（sameOrigin 依赖真实 port）。 */
async function startUploadServer(d: IntakeUploadDeps): Promise<UploadServer> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: string[] = []
  const warnings: string[] = []
  const http: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(path)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'exact route only' } }))
      return
    }
    Promise.resolve().then(() => handler(req, res)).catch(() => {
      try { res.destroy() } catch { /* 连接已坏 */ }
    })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo
  const dispose = registerIntakeUploadHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          registered.push(`${route.kind} ${route.path}`)
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
      logger: { warn(m: string) { warnings.push(m) } },
    },
    d,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    registered,
    warnings,
    async close(): Promise<void> {
      dispose()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------
//  HTTP / SQL helper
// ---------------------------------------------------------------------------

interface HttpResult {
  readonly status: number
  readonly text: string
  readonly json: Record<string, unknown>
}

/** 一次真 POST：body 是原始字节（ArrayBuffer），不是 JSON / multipart。 */
async function postUpload(options: {
  readonly body: Buffer
  readonly contentType?: string
  readonly fileName?: string
  readonly session?: string
  readonly path?: string
  readonly headers?: Record<string, string>
} = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/pdf',
    'x-file-name': options.fileName ?? encodeURIComponent('resume.pdf'),
    'x-recruitment-request': '1',
    ...(options.session === undefined ? {} : { 'x-dsh-session': options.session }),
    ...(options.headers ?? {}),
  }
  const body = options.body ?? readFileSync(FIXTURE)
  // 默认带 job_id：简历必须挂岗位，路由的 job_id 必填是对的；负例失败原因仍由各自头/体决定。
  const path = options.path ?? `${UPLOAD_PATH}?job_id=${JOB_ID}`
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: new Uint8Array(body),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) as Record<string, unknown> } catch { json = { raw: text } }
  return { status: response.status, text, json }
}

/** 独立 SQL（不走产品 DAO）：只连一次性库。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 6 张表的行数快照（L5 零写入反证）。 */
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of TABLES) {
    const rows = await query<{ n: string }>(`select count(*)::text as n from recruitment.${table}`)
    out[table] = Number(rows[0]?.n ?? '0')
  }
  return out
}

/** 与一次上传相关的任务行（重复任务反证用）。 */
interface RelatedTaskRow {
  readonly id: string
  readonly task_type: string
  readonly idempotency_key: string
  readonly trigger_event_id: string | null
}
interface TaskRow {
  id: string
  status: string
  error_code: string | null
  error_summary: string | null
}

async function taskRow(taskId: string): Promise<TaskRow | undefined> {
  const rows = await query<TaskRow>(
    `select id::text as id, status, error_code, error_summary
       from recruitment.business_task where tenant_id = $1 and id = $2`,
    [TENANT, taskId],
  )
  return rows[0]
}

/** 有界轮询（不写死耗时）：等到 SUCCEEDED/FAILED 或超时。 */
async function waitTerminal(taskId: string, timeoutMs = 60_000): Promise<TaskRow> {
  const deadline = Date.now() + timeoutMs
  let last: TaskRow | undefined
  while (Date.now() < deadline) {
    last = await taskRow(taskId)
    if (last !== undefined && ['SUCCEEDED', 'FAILED'].includes(last.status)) return last
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`任务 ${taskId} 在 ${timeoutMs}ms 内未到终态（最后状态 ${JSON.stringify(last)}）`)
}

/**
 * 用 node:http 原生 request 覆盖 Host（fetch/undici 禁止改 Host，必须用底层 API）。
 * 目的：构造"非回环 Host"负例，证明 sameOrigin 门真的按 Host 拒绝。
 */
async function postWithHost(host: string, body: Buffer, sameOrigin = true): Promise<HttpResult> {
  const { request } = await import('node:http')
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request(`${server.baseUrl}${UPLOAD_PATH}?job_id=${JOB_ID}`, {
      method: 'POST',
      headers: {
        host,
        'content-type': 'application/pdf',
        'x-file-name': encodeURIComponent('resume.pdf'),
        ...(sameOrigin ? { 'x-recruitment-request': '1' } : {}),
        'x-dsh-session': SESSION,
        'content-length': body.length,
      },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => {
        let json: Record<string, unknown> = {}
        try { json = JSON.parse(text) as Record<string, unknown> } catch { json = { raw: text } }
        resolve({ status: res.statusCode ?? 0, text, json })
      })
    })
    req.once('error', reject)
    req.end(body)
  })
}

// ---------------------------------------------------------------------------
//  用例 0（不依赖 PG）：真 HTTP + 假依赖，证明闸门在碰 DB 之前 fail-closed
// ---------------------------------------------------------------------------

test('无 DB 也可验证：真 HTTP 下越界/未绑定/错类型/坏文件名/缺 job_id 均在碰库前拒绝', async () => {
  const fakeDeps: IntakeUploadDeps = {
    database: null,
    databaseIssues: ['FAKE: no database in this gate test'],
    converter: null,
    identity: createDemoActorIdentity().identity,
  }
  fakeDeps.identity.registry.bind(SESSION, 'recruiter')
  const gateServer = await startUploadServer(fakeDeps)
  try {
    assert.deepEqual(gateServer.registered, [`exact ${UPLOAD_PATH}`])

    const bytes = readFileSync(FIXTURE)
    const base = `http://127.0.0.1:${gateServer.port}${UPLOAD_PATH}`
    const send = async (headers: Record<string, string>, path = base): Promise<HttpResult> => {
      const response = await fetch(path, { method: 'POST', headers, body: new Uint8Array(bytes) })
      const text = await response.text()
      let json: Record<string, unknown> = {}
      try { json = JSON.parse(text) as Record<string, unknown> } catch { json = { raw: text } }
      return { status: response.status, text, json }
    }
    const good = {
      'content-type': 'application/pdf',
      'x-file-name': encodeURIComponent('resume.pdf'),
      'x-recruitment-request': '1',
      'x-dsh-session': SESSION,
    }

    // 缺同源头 → 403（先于 NOT_CONFIGURED）
    const missingHeader: Record<string, string> = { ...good }
    delete missingHeader['x-recruitment-request']
    const forbidden = await send(missingHeader)
    assert.equal(forbidden.status, 403, forbidden.text)

    // 未绑定 session → 409（先于 NOT_CONFIGURED）
    const unbound = await send({ ...good, 'x-dsh-session': SESSION_UNBOUND })
    assert.equal(unbound.status, 409, unbound.text)

    // 错 content-type → 415
    const wrongType = await send({ ...good, 'content-type': 'text/plain' })
    assert.equal(wrongType.status, 415, wrongType.text)

    // 路径穿越文件名 → 400
    const traversal = await send({ ...good, 'x-file-name': encodeURIComponent('../evil.pdf') })
    assert.equal(traversal.status, 400, traversal.text)

    // 缺 job_id → 400（同样先于 NOT_CONFIGURED，证明 gate 顺序正确）
    const missingJob = await send(good)
    assert.equal(missingJob.status, 400, missingJob.text)
    const error = missingJob.json.error as Record<string, unknown>
    assert.equal(error.code, 'INVALID_ARGS')
    assert.equal(error.reason_code, 'MISSING_REQUIRED')

    // 全部闸门都过 → 才轮到 NOT_CONFIGURED（假依赖无 DB），不是 200 / 不是静默写入。
    const withJob = await send(good, `${base}?job_id=${JOB_ID}`)
    assert.equal(withJob.status, 503, withJob.text)

    // 非回环 host 不注册路由（fail-closed）
    const warned: string[] = []
    let registrations = 0
    const dispose = registerIntakeUploadHttp(
      {
        webServer: {
          host: '0.0.0.0',
          port: 49347,
          register() { registrations += 1; return () => {} },
        },
        logger: { warn(m: string) { warned.push(m) } },
      },
      fakeDeps,
    )
    dispose()
    assert.equal(registrations, 0, '非回环地址不得注册上传路由')
    assert.ok(warned.length > 0, '非回环地址必须告警')
  } finally {
    await gateServer.close()
  }
})

// ---------------------------------------------------------------------------
//  用例 1：路由只注册一条 exact；成功 202 且不等解析
// ---------------------------------------------------------------------------

test('上传路由只注册一条 exact path；合法 PDF → 202 + task_id + RUNNING，<2s 返回', { skip: SKIP_PG }, async () => {
  assert.deepEqual(server.registered, [`exact ${UPLOAD_PATH}`], '不得扩大 HTTP 暴露面')

  const bytes = readFileSync(FIXTURE)
  const before = await counts()
  const started = Date.now()
  const result = await postUpload({ body: bytes, session: SESSION })
  const elapsed = Date.now() - started
  assert.equal(result.status, 202, `合法上传应 202：${result.text}`)
  assert.equal(result.json.status, 'RUNNING')
  assert.equal(typeof result.json.task_id, 'string')
  assert.match(String(result.json.task_id), /^[0-9a-f-]{36}$/i)
  assert.equal(elapsed < 2000, true, `202 必须在 2s 内返回（实际 ${elapsed}ms），不得等待解析`)

  // 同步阶段只应新增 event_inbox + business_task（L2 独立读回）。
  const after = await counts()
  assert.equal(after.business_task, before.business_task + 1, '同步阶段必须建一条任务')
  assert.equal(after.event_inbox, before.event_inbox + 1, '同步阶段必须建一条收件事件')
  assert.equal(after.application, before.application, '202 时不得已经写入申请（那是后台的事）')
  assert.equal(after.resume_version, before.resume_version, '202 时不得已经写入简历版本')
  assert.equal(after.intake_asset, before.intake_asset)

  // 后台终态：有 converter 时期望解析成功入库；否则只要终态失败带人话即可（诚实记录）。
  const terminal = await waitTerminal(String(result.json.task_id))
  assert.ok(['SUCCEEDED', 'FAILED'].includes(terminal.status))
  if (terminal.status === 'FAILED') {
    assert.ok(terminal.error_code !== null && terminal.error_code !== '', 'FAILED 必须有 error_code')
    assert.ok((terminal.error_summary ?? '').length > 0, 'FAILED 必须有人话原因')
  }
})

// ---------------------------------------------------------------------------
//  用例 2：解析成功时 application / resume_version 真的出现（converter 可用才跑）
// ---------------------------------------------------------------------------

test('解析成功：后台任务 SUCCEEDED，application + resume_version 行落库可读回', { skip: SKIP_PG || CONVERTER_SKIP }, async () => {
  const before = await counts()
  const result = await postUpload({
    // 唯一字节：同 sha256 的再次上传会被内容寻址去重（那是正确行为），不能拿来证明“解析入库”。
    body: Buffer.concat([readFileSync(FIXTURE), Buffer.from(`\n% upload-${randomUUID()}\n`, 'utf8')]),
    session: SESSION,
    fileName: encodeURIComponent('golden-path.pdf'),
  })
  assert.equal(result.status, 202, result.text)
  const taskId = String(result.json.task_id)
  const terminal = await waitTerminal(taskId)
  if (terminal.status === 'FAILED') {
    // 环境有 Python 但转换器仍跑不通时，明确失败而不是伪造入库证据。
    assert.ok((terminal.error_summary ?? '').length > 0)
    throw new Error(`converter 环境存在但解析失败（不能算通过）：${terminal.error_code} ${terminal.error_summary}`)
  }
  assert.equal(terminal.status, 'SUCCEEDED')

  // 重复任务反证：一次上传 + 解析完成后，与该 intake 相关的 business_task 必须只有 1 条。
  // 若 router 之后又用 intake_record_id 键建了第二条，这里会红；红时把两条的
  // idempotency_key / task_type / created_by_actor_id 抄进报告交总控裁决，不许自行放宽断言。
  const eventId = String(result.json.event_id ?? '')
  const relatedTasks = await query<RelatedTaskRow>(
    `select id::text as id, task_type, idempotency_key, trigger_event_id::text as trigger_event_id
       from recruitment.business_task
      where tenant_id = $1 and (id = $2 or trigger_event_id = $3::uuid)
      order by created_at`,
    [TENANT, taskId, eventId],
  )
  assert.equal(
    relatedTasks.length,
    1,
    `一次上传只能建一条 RESUME_PARSE 任务（实际 ${relatedTasks.length} 条）：${JSON.stringify(relatedTasks)}`,
  )

  const after = await counts()
  // 真实语义：同一个人再传简历 → **复用原申请**、只追加一条简历版本（申请数不变是正确行为，不是漏入库）。
  assert.equal(after.resume_version, before.resume_version + 1, `解析成功必须新增一条简历版本：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  assert.ok(after.application >= before.application, `申请数不应减少：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
  assert.ok(after.application <= before.application + 1, `一次上传最多新增一条申请（不许重复建）：before=${JSON.stringify(before)} after=${JSON.stringify(after)}`)
})

// ---------------------------------------------------------------------------
//  用例 3：负例矩阵 —— 拒绝 + 六表零写入
// ---------------------------------------------------------------------------

interface NegativeCase {
  readonly label: string
  readonly status: number
  readonly code: string
  run(): Promise<HttpResult>
}

test('负例矩阵：越界/未绑定/超限/错类型/路径穿越 → 拒绝且六表行数完全不变', { skip: SKIP_PG }, async () => {
  const bigBody = Buffer.alloc(20 * 1024 * 1024 + 1, 0x41)
  const cases: readonly NegativeCase[] = [
    {
      label: '未绑定 session',
      status: 409,
      code: 'DEMO_ACTOR_UNMAPPED',
      run: () => postUpload({ session: SESSION_UNBOUND }),
    },
    {
      label: '缺失同源头 x-recruitment-request',
      status: 403,
      code: 'FORBIDDEN',
      run: () => postWithHost(`127.0.0.1:${server.port}`, readFileSync(FIXTURE), false),
    },
    {
      label: '非回环 Host',
      status: 403,
      code: 'FORBIDDEN',
      run: () => postWithHost(`evil.example:${server.port}`, readFileSync(FIXTURE)),
    },
    {
      label: '超过 20MiB',
      status: 413,
      code: 'FILE_TOO_LARGE',
      // getActualCode 在断言里处理：实现用 reason_code 或 code 承载具体码。
      run: () => postUpload({ session: SESSION, body: bigBody }),
    },
    {
      label: '不支持的 content-type',
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      run: () => postUpload({ session: SESSION, contentType: 'text/plain' }),
    },
    {
      label: '文件名路径穿越 ../evil.pdf',
      status: 400,
      code: 'INVALID_FILE_NAME',
      run: () => postUpload({ session: SESSION, fileName: encodeURIComponent('../evil.pdf') }),
    },
  ]

  for (const item of cases) {
    const before = await counts()
    const result = await item.run()
    assert.equal(result.status, item.status, `${item.label}：状态应为 ${item.status}，实际 ${result.status}：${result.text}`)
    const error = result.json.error as Record<string, unknown> | undefined
    assert.ok(error !== undefined, `${item.label}：必须是封闭错误信封：${result.text}`)
    const actualCode = error.code === 'INVALID_ARGS'
      ? error.reason_code
      : error.code === 'FORBIDDEN' ? error.reason_code : error.code
    // 超过 20MiB 的实现把码放在 reason_code（code 可能是 INVALID_ARGS 或 FILE_TOO_LARGE）；
    // 两种都接，但绝不接"200 + 静默写入"。
    assert.ok(
      actualCode === item.code || error.code === item.code || error.reason_code === item.code,
      `${item.label}：错误码应为 ${item.code}，实际 ${result.text}`,
    )
    const after = await counts()
    assert.deepEqual(after, before, `${item.label}：被拒路径必须六表零写入`)
  }
})

// ---------------------------------------------------------------------------
//  用例 4：坏字节 → 终态 FAILED + 人话，且绝不假报"已入库"
// ---------------------------------------------------------------------------

test('失败终态：非 PDF 字节 → FAILED + error_code + 人话原因，且无对应 application 行', { skip: SKIP_PG }, async () => {
  const badBytes = Buffer.from('%PDF-1.4\nthis is not a real pdf\n', 'utf8')
  const before = await counts()
  const result = await postUpload({ body: badBytes, session: SESSION, fileName: encodeURIComponent('broken.pdf') })
  assert.equal(result.status, 202, `坏字节也必须同步 202（失败在后台）：${result.text}`)
  const taskId = String(result.json.task_id)
  const terminal = await waitTerminal(taskId)
  assert.equal(terminal.status, 'FAILED', `坏字节的终态必须是 FAILED，实际 ${terminal.status}`)
  assert.ok(terminal.error_code !== null && terminal.error_code !== '', 'FAILED 必须带 error_code')
  assert.match(String(terminal.error_summary), /解析失败|无法读取|未入库/, '失败原因必须是人话且不得假报入库')

  // 独立读回：不能出现"已入库"的任务描述，也不能为这份坏字节建申请。
  const descriptions = await query<{ description: string }>(
    'select description from recruitment.business_task where id = $1',
    [taskId],
  )
  assert.equal(descriptions.some((row) => /已入库/.test(row.description)), false, 'FAILED 任务不得出现"已入库"')
  const after = await counts()
  assert.equal(after.application, before.application, '坏字节解析失败不得新增 application 行')
  assert.equal(after.resume_version, before.resume_version, '坏字节解析失败不得新增 resume_version 行')
})
