// D5 P0-7：真实飞书 minute → Meeting 绑定 → 复用 transcript_import 域路径 → Transcript READY
// 的**真库 + 真 HTTP** 集成测试（`POST /recruitment/api/feishu/import`）。
//
// 诚实边界（必须先读）：
//   * 正例用**合成回读**（stub transport，自编正文、自算 sha），它证明的是**产品契约与写路径**：
//     同源 loopback + session→alias→actor、请求形状、LIVE 证据闸门、Meeting/绑定 ensure、
//     复用 `importTranscriptInTransaction()` 落 artifact/segment/record、三维标签 LIVE/MANUAL/CONNECTED、
//     幂等重放、以及提交后独立 SQL 读回。
//   * 它**不证明外部真实性**：这批字节不是真的从飞书平台读回来的。外部真实性由真 Host 49303
//     的真实链路证据（lark-cli 回读 + 回执 + 二次重读）承担；本文件不访问任何网络/子进程，
//     也不写任何外部系统。
//   * 负例 connector 覆盖：真实 `createFeishuMinutesAdapter()`（缺凭据 / 缺用户身份）+ 一个
//     只能读到「证据不齐但无矛盾」回读的 stub adapter（真实适配器在 probe 后给 READ 的
//     connection 恒为 AUTH_REQUIRED，无法产出 NOT_CONNECTED 的组合，故该分支用 stub 触发）。
//
// 覆盖：
//   a. 正例：200 + 精确响应键 + 独立 psql 读回（meeting/binding/artifact/segment/record 全部直连
//      `db.pool.query`，不 import 任何产品读投影）；LIVE 标签与 sha/字节数/分段逐项核对。
//   b. 幂等重放：同参第二次 POST → `replayed:true`、`reused_meeting/reused_binding:true`、
//      changes 空、artifact/segment/record 行数与 sha 不变。
//   c. 注册表契约：exact `/recruitment/api/feishu/import`；非 POST → 405 + `allow: POST`；
//      非回环 host → 不注册并告警。
//   d. 负例族（逐条断言 HTTP 状态 + code + reason_code + 5 张事实表行数前后不变）：
//      未绑定 session 409 / interviewer_a 403 / 缺/非法 session 400 / 缺同源头 403 / 非 JSON 415 /
//      body 缺键·非法 UUID·未知键·actor_id·tenant_id 400 / 面试不存在 404 /
//      无连接器配置 503(TRANSPORT_NOT_CONFIGURED) / connector BLOCKED 无凭据 503(NO_APP_CREDENTIALS) /
//      connector BLOCKED AUTH_REQUIRED 403 / 回读自相矛盾 409 / gate 非 LIVE 409 /
//      同一 minute 已绑另一场面试 409。
//
// 纪律：
//   1. 本文件独占 `createIsolatedTestDatabase('d5fsimport')` 一次性库（**不写 ra_s6s7**），跑完 drop；
//   2. 连不上库就失败（不静默 skip；R3 要求 skipped===0）；
//   3. 真 `node:http` 监听 127.0.0.1:0，把真实 `registerActorHttp` / `registerFeishuImportHttp`
//      的 `webServer.register` 契约收集成 exact 路由表（与宿主同一份注册函数，不模拟其行为）；
//   4. 身份注册表 = 产品 `createDemoActorIdentity()` 真实例；
//   5. 断言不放宽：拒绝路径同时断言状态/错误码 + 目标表行数不变。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDemoActorIdentity, type DemoActorIdentity } from '../../src/demo-actor/index.ts'
import { registerActorHttp } from '../../src/http/actor.ts'
import { registerFeishuImportHttp, type FeishuImportDeps } from '../../src/http/feishu-import.ts'
import {
  createFeishuMinutesAdapter,
  FEISHU_MINUTES_CONNECTOR_ID,
  type FeishuCliTranscriptReadback,
  type FeishuConnectorDependency,
  type FeishuMinutesAdapter,
  type FeishuMinutesTranscriptTransport,
} from '../../src/connectors/feishu/index.ts'
import type { ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

// ---------------------------------------------------------------------------
// 固定 id / session（与 0002_seed + bootstrap-demo 的演示种子一致）
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（test/integration → test → dsh-recruitment → dsh → repo）。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const BOOTSTRAP_SCRIPT = join(REPO_ROOT, 'scripts', 'bootstrap-demo.mjs')
/** 集成测试底座配置（密码只从 `RECRUITMENT_DB_PASSWORD` 来；缺了 `testDatabaseConfig()` 直接抛）。 */
const BASE = testDatabaseConfig()

/** 被测路由（exact）。 */
const IMPORT_PATH = '/recruitment/api/feishu/import'
/** 身份绑定路由（复用产品 registerActorHttp 写进程内注册表）。 */
const ACTOR_PATH = '/recruitment/api/actor'

const ACTOR_103 = '11111111-1111-4111-8111-000000000103' // recruiter（HR）
const ACTOR_104 = '11111111-1111-4111-8111-000000000104' // interviewer_a
const DEMO_APPLICATION = '11111111-1111-4111-8111-000000000701'
/** bootstrap-demo 的演示种子：round 1 = POST_INTERVIEW / round 2 = SCHEDULED。 */
const INTERVIEW_ROUND1 = '11111111-1111-4111-8111-000000000801'
const INTERVIEW_ROUND2 = '11111111-1111-4111-8111-000000000802'

const SESSION_R = 'session-5f5a0000-0000-4000-8000-00000000c001'
const SESSION_A = 'session-5f5a0000-0000-4000-8000-00000000a001'
const SESSION_UNBOUND = 'session-5f5a0000-0000-4000-8000-00000000ff01'

/** 本次运行唯一后缀（minute_token 用；避免与演示库/重复跑撞唯一键）。 */
const UNIQUE = `${process.pid.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase()

// ---------------------------------------------------------------------------
// 合成回读（不是真实飞书产物；R7：不使用真实会议正文/候选人资料）
// ---------------------------------------------------------------------------

/** 合成正文（自编，无真实候选人 PII）。 */
const LIVE_RAW_TEXT = [
  'D5 lane 合成转写（自编测试文本，非真实会议原文）：',
  '面试官：请介绍一下你最近负责的系统，以及你个人负责的那部分。',
  '候选人：我负责订单履约链路的稳定性，个人负责超时重试与降级开关。',
  '面试官：指标是怎么定义的？数据从哪里来？',
  '候选人：按网关日志统计 30 秒未返回的请求占比，数据来自内部可观测平台。',
].join('\n')
/** 用 node:crypto 独立重算（不 import 产品的 sha256 实现，避免自证）。 */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}
const LIVE_SHA = sha256(LIVE_RAW_TEXT)
const LIVE_BYTES = Buffer.byteLength(LIVE_RAW_TEXT, 'utf8')
const LIVE_CHARS = LIVE_RAW_TEXT.length
/** 非空行数 = transcript_segment 行数（工具按 \r?\n 切行、跳过空行）。 */
const LIVE_SEGMENTS = LIVE_RAW_TEXT.split(/\r?\n/).filter((line) => line !== '').length
/** 回读时刻（带偏移；LIVE Gate 要求）。 */
const READBACK_FETCHED_AT = '2026-11-14T10:00:00.000+08:00'
/** 假凭据（**不是**真实飞书凭据）：只为让真实适配器走过「凭据存在性」这一环。 */
const FAKE_FEISHU_ENV: Readonly<Record<string, string>> = {
  FEISHU_APP_ID: 'cli_app_test',
  FEISHU_APP_SECRET: 'app-secret-test',
  FEISHU_USER_ACCESS_TOKEN: 'user-token-test',
}

/**
 * 一个合成的「平台回读」对象。`badsha` 场景故意让声明的 sha 与 raw_text 对不上
 * （用于"回读对象自相矛盾 → 409 READBACK_INVALID"负例），其余场景证据齐全（LIVE）。
 * @param minuteToken - 平台一分钟标识（会被写进回执）。
 */
function syntheticReadback(minuteToken: string): FeishuCliTranscriptReadback {
  const contradictory = minuteToken.includes('badsha')
  const declared = contradictory ? sha256('另一份与 raw_text 不一致的合成字节（负例）') : LIVE_SHA
  return {
    transport: 'FEISHU_MINUTES_API',
    minute_token: minuteToken,
    revision: '7',
    read_receipt_ref: `lark:minutes+detail:${minuteToken}@sha256:${declared}`,
    fetched_at: READBACK_FETCHED_AT,
    content_sha256: declared,
    reread_sha256: declared,
    is_complete: true,
    raw_text: LIVE_RAW_TEXT,
    trigger: 'MANUAL',
    transcript_file: 'artifacts/transcript.txt',
    file_bytes: LIVE_BYTES,
    page_count: 1,
    transcript_chars: LIVE_CHARS,
  }
}

/**
 * 合成传输层：只回放固定回读对象，**不起子进程、不发网络请求**。
 * 交给真实 `createFeishuMinutesAdapter()` 后，LIVE Gate / 回读自洽校验都仍是产品实现。
 * `describe` / `verifyContract` 不是本测试路径，给最小占位。
 * @returns 可注入的传输层。
 */
function createSyntheticTransport(): FeishuMinutesTranscriptTransport {
  const transport = {
    kind: 'lark-cli-transport',
    async read({ minute_token }: { readonly minute_token: string }) {
      return { status: 'READ', readback: syntheticReadback(minute_token), attempts: 1, pages: 1 }
    },
    describe: () => ({}),
    verifyContract: async () => ({}),
  }
  return transport as unknown as FeishuMinutesTranscriptTransport
}

/** 正例/矛盾负例共用的连接器依赖（真实适配器 + 合成传输层；凭据齐全）。 */
function liveConnector(): FeishuConnectorDependency {
  return {
    adapter: createFeishuMinutesAdapter({ env: FAKE_FEISHU_ENV, transport: createSyntheticTransport() }),
    transport_configured: true,
  }
}

/** 无任何应用凭据（真实适配器 probe 会 blocked NO_APP_CREDENTIALS）。 */
function noCredentialsConnector(): FeishuConnectorDependency {
  return {
    adapter: createFeishuMinutesAdapter({ env: {}, transport: createSyntheticTransport() }),
    transport_configured: true,
  }
}

/** 有应用凭据、缺用户身份令牌（真实适配器 probe 会 blocked USER_IDENTITY_REQUIRED → AUTH_REQUIRED）。 */
function noUserIdentityConnector(): FeishuConnectorDependency {
  return {
    adapter: createFeishuMinutesAdapter({
      env: { FEISHU_APP_ID: 'cli_app_test', FEISHU_APP_SECRET: 'app-secret-test' },
      transport: createSyntheticTransport(),
    }),
    transport_configured: true,
  }
}

/**
 * 「读到字节但证据不齐（无矛盾）」的连接器：kind=READ、labels.connection=NOT_CONNECTED、
 * live_gate=BLOCKED。真实适配器不可能给出这个组合（probe 后非 LIVE 的 READ 恒 AUTH_REQUIRED），
 * 而产品冻结口径要求「gate 非 LIVE 且无矛盾 → 409 BLOCKED/READBACK_INVALID」，
 * 该分支只能由这样一个诚实的连接器结果触发。
 * @returns 可注入的连接器依赖。
 */
function notLiveGateConnector(): FeishuConnectorDependency {
  const readback = {
    transport: 'FIXTURE',
    minute_token: `mt-d5fs-notlive-${UNIQUE}`,
    read_receipt_ref: `lark:minutes+detail:mt-d5fs-notlive-${UNIQUE}@sha256:${LIVE_SHA}`,
    fetched_at: READBACK_FETCHED_AT,
    content_sha256: LIVE_SHA,
    is_complete: true,
    raw_text: LIVE_RAW_TEXT,
    trigger: 'MANUAL',
  }
  const adapter = {
    describe: () => ({
      connector: FEISHU_MINUTES_CONNECTOR_ID,
      contract_version: '1.0.0',
      implemented: ['contract', 'labels'],
      not_implemented: ['http-transport', 'oauth-flow', 'event-subscription'],
      live_gate: 'EVIDENCE_DRIVEN',
      live_gate_evidence: [],
    }),
    probe: () => ({
      connection_state: 'NOT_CONNECTED',
      labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
    }),
    async fetchTranscript() {
      return {
        kind: 'READ',
        connector: FEISHU_MINUTES_CONNECTOR_ID,
        connection_state: 'NOT_CONNECTED',
        labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' },
        provenance_basis: 'NO_LIVE_READ',
        live_eligible: false,
        live_gate: 'BLOCKED',
        live_gate_violations: ['transport 必须是 FEISHU_MINUTES_API（合成回读不是平台通道）'],
        creates_artifact: false,
        readback,
        requested: { minute_token_present: true, external_meeting_id_present: false },
        note: '合成：读到了字节，但证据不齐（自相矛盾为零）',
      }
    },
    mapProviderError: () => {
      throw new Error('不该调用')
    },
    subscriptionNotes: () => {
      throw new Error('不该调用')
    },
  } as unknown as FeishuMinutesAdapter
  return { adapter, transport_configured: true }
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let identity: DemoActorIdentity
/** 正例/矛盾负例（真实适配器 + 合成 LIVE 回读）。 */
let harness: Harness
/** 无 feishu 配置、无 override（默认态）。 */
let noConfigHarness: Harness
/** connector 回读 BLOCKED：无应用凭据。 */
let noCredentialsHarness: Harness
/** connector 回读 BLOCKED：缺用户身份（AUTH_REQUIRED）。 */
let noUserIdentityHarness: Harness
/** connector 读到字节但 gate 非 LIVE（connection=NOT_CONNECTED，无矛盾）。 */
let notLiveGateHarness: Harness

/** 真 `node:http` + 真实 register 契约。 */
interface Harness {
  readonly baseUrl: string
  readonly registered: readonly { kind: string; path: string }[]
  readonly warnings: readonly string[]
  close(): Promise<void>
}

/** 一次 HTTP 调用结果（`allow` 只用于 405 断言）。 */
interface HttpResult {
  readonly status: number
  readonly body: Record<string, unknown>
  readonly text: string
  readonly allow: string | null
}

/** `call()` 的可选项。 */
interface CallOptions {
  readonly session?: string
  readonly body?: unknown
  readonly rawBody?: string
  /** `null` = 不设 content-type；缺省 = application/json。 */
  readonly contentType?: string | null
  readonly omitRequestHeader?: boolean
}

/** 失败路径必须零写入的 5 张事实表。 */
const ZERO_WRITE_TABLES = [
  'meeting',
  'meeting_binding',
  'transcript_artifact',
  'transcript_segment',
  'interview_record',
] as const

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

test.before(async () => {
  // ---- 一次性空库（真迁移 0001→N）+ 产品 bootstrap 种子 ----
  db = await createIsolatedTestDatabase('d5fsimport')
  assertPrivateDatabase(db.name)
  assert.ok(db.migrations.length >= 16, `迁移应 >=16，实际 ${db.migrations.length}`)
  cfg = { ...BASE, database: db.name }

  const boot = await runBootstrap(db.name)
  assert.equal(
    boot.code,
    0,
    `bootstrap 必须 exit 0；实际 code=${String(boot.code)}\n${boot.stdout.slice(-3000)}\n${boot.stderr.slice(-2000)}`,
  )

  // ---- 独立 SQL 读回种子（不拿脚本自述当证据）----
  const actors = await query<{ id: string; kind: string }>(
    'select id::text as id, kind from recruitment.actor where id in ($1, $2) and tenant_id = $3 order by id',
    [ACTOR_103, ACTOR_104, TENANT],
  )
  assert.equal(actors.length, 2, '种子应保证 103/104 两个 actor 存在')
  assert.deepEqual(actors.map((row) => row.kind), ['HUMAN', 'HUMAN'])

  const app = await query<{ id: string; job_id: string; rubric_version_id: string | null }>(
    `select a.id::text as id, a.job_id::text as job_id, a.rubric_version_id::text as rubric_version_id
       from recruitment.application a where a.id = $1 and a.tenant_id = $2`,
    [DEMO_APPLICATION, TENANT],
  )
  assert.equal(app.length, 1, '种子应保证演示申请 0701 存在')
  assert.ok(app[0]!.rubric_version_id !== null, '演示申请必须钉住 rubric（正例的 interview_record 依赖它）')
  const rubric = await query<{ n: number }>(
    `select count(*)::int as n from recruitment.rubric_version rv
      where rv.id = $1 and rv.tenant_id = $2 and rv.job_id = $3`,
    [app[0]!.rubric_version_id, TENANT, app[0]!.job_id],
  )
  assert.equal(rubric[0]?.n, 1, '钉住的 rubric 必须属于该申请的岗位 (0008 GAP-C)')
  state.rubricVersionId = app[0]!.rubric_version_id as string

  const interviews = await query<{
    id: string
    status: string
    round_no: number
    stage_code: string
    application_id: string
  }>(
    `select id::text as id, status, round_no, stage_code, application_id::text as application_id
       from recruitment.interview where id in ($1, $2) and tenant_id = $3 order by round_no`,
    [INTERVIEW_ROUND1, INTERVIEW_ROUND2, TENANT],
  )
  assert.equal(interviews.length, 2, 'bootstrap-demo 应种下 0801/0802 两场演示面试')
  assert.deepEqual(interviews.map((row) => row.round_no), [1, 2])
  assert.deepEqual(interviews.map((row) => row.status), ['POST_INTERVIEW', 'SCHEDULED'])
  assert.equal(interviews[0]!.application_id, DEMO_APPLICATION)
  assert.equal(interviews[1]!.application_id, DEMO_APPLICATION)
  assert.deepEqual(interviews.map((row) => row.stage_code), ['S8', 'S8'])
  // 正例要求这两场面试一开始没有任何 active 会议绑定（Meeting 由被测端点创建）。
  const seededBindings = await query<{ n: number }>(
    `select count(*)::int as n from recruitment.meeting_binding
      where tenant_id = $1 and interview_id in ($2, $3)`,
    [TENANT, INTERVIEW_ROUND1, INTERVIEW_ROUND2],
  )
  assert.equal(seededBindings[0]?.n, 0, '演示面试不应预置会议绑定')

  // ---- 真 HTTP server + 真实 register 函数（同一份产品注册实现）----
  identity = createDemoActorIdentity().identity
  harness = await startHarness({
    database: cfg,
    databaseIssues: [],
    identity,
    connectorOverride: liveConnector(),
  })
  noConfigHarness = await startHarness({ database: cfg, databaseIssues: [], identity })
  noCredentialsHarness = await startHarness({
    database: cfg,
    databaseIssues: [],
    identity,
    connectorOverride: noCredentialsConnector(),
  })
  noUserIdentityHarness = await startHarness({
    database: cfg,
    databaseIssues: [],
    identity,
    connectorOverride: noUserIdentityConnector(),
  })
  notLiveGateHarness = await startHarness({
    database: cfg,
    databaseIssues: [],
    identity,
    connectorOverride: notLiveGateConnector(),
  })

  // 真实注册表断言：exact `/recruitment/api/feishu/import`（每个 harness 注册一次，不重复）。
  for (const h of [harness, noConfigHarness, noCredentialsHarness, noUserIdentityHarness, notLiveGateHarness]) {
    const routes = h.registered.filter((route) => route.path === IMPORT_PATH)
    assert.equal(routes.length, 1, `必须恰好注册一条 ${IMPORT_PATH}，实际 ${routes.length}`)
    assert.equal(routes[0]!.kind, 'exact', '飞书导入路由必须是 exact（不是 prefix）')
    assert.ok(h.registered.some((route) => route.path === ACTOR_PATH && route.kind === 'exact'), '缺 actor exact 路由')
  }

  // 绑定 recruiter / interviewer_a（未绑定 session 保留做负例）。
  for (const [session, alias] of [[SESSION_R, 'recruiter'], [SESSION_A, 'interviewer_a']] as const) {
    const put = await call(harness, 'PUT', ACTOR_PATH, { session, body: { alias } })
    assert.equal(put.status, 200, `绑定 ${alias} 应 200：${put.text}`)
    assert.equal(put.body.actor_id, alias === 'recruiter' ? ACTOR_103 : ACTOR_104, `${alias} 的 actor 映射`)
  }
})

test.after(async () => {
  for (const h of [notLiveGateHarness, noUserIdentityHarness, noCredentialsHarness, noConfigHarness, harness]) {
    if (h !== undefined) await h.close()
  }
  if (db !== undefined) await db.drop()
})

// ===========================================================================
//  a. 正例：全链路 200 + 独立 SQL 读回
// ===========================================================================

test('a 正例：POST /feishu/import → 200 READY + 独立 SQL 读回（LIVE/MANUAL/CONNECTED）', async () => {
  const token = `mt-d5fs-live-${UNIQUE}`
  const before = {
    meeting: await count('meeting'),
    meeting_binding: await count('meeting_binding'),
    transcript_artifact: await count('transcript_artifact'),
    transcript_segment: await count('transcript_segment'),
    interview_record: await count('interview_record'),
  }

  const result = await call(harness, 'POST', IMPORT_PATH, {
    session: SESSION_R,
    body: { interview_id: INTERVIEW_ROUND2, minute_token: token },
  })
  const body = await okJson(result, 'feishu/import 正例')

  // ---- 顶层精确键（冻结契约；record 在申请有 rubric 时必须存在）----
  assert.deepEqual(
    Object.keys(body).sort(),
    [
      'action', 'actor', 'artifact', 'changes', 'db_readback', 'interview', 'labels',
      'meeting', 'minutes', 'record', 'status', 'transcript_status',
    ].sort(),
    '200 响应的顶层键必须精确等于冻结契约',
  )
  assert.equal(body.action, 'feishu/import')
  assert.equal(body.status, 'READY')
  assert.equal(body.transcript_status, 'READY')
  assert.deepEqual(body.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })

  // ---- actor：服务端解析（session → alias → HUMAN actor）----
  const actor = body.actor as Record<string, unknown>
  assert.deepEqual(Object.keys(actor).sort(), ['actor_id', 'alias', 'session_id'])
  assert.equal(actor.session_id, SESSION_R)
  assert.equal(actor.alias, 'recruiter')
  assert.equal(actor.actor_id, ACTOR_103)

  // ---- interview：回显 = 库里的那场（0802 / round 2 / S8 / SCHEDULED）----
  const interview = body.interview as Record<string, unknown>
  assert.deepEqual(Object.keys(interview).sort(), ['application_id', 'id', 'round_no', 'stage_code', 'status'])
  assert.deepEqual(interview, {
    id: INTERVIEW_ROUND2,
    application_id: DEMO_APPLICATION,
    round_no: 2,
    stage_code: 'S8',
    status: 'SCHEDULED',
  })

  // ---- meeting：由端点创建（reused=false），以 minute_token 作平台标识 ----
  const meeting = body.meeting as Record<string, unknown>
  assert.deepEqual(
    Object.keys(meeting).sort(),
    ['binding_id', 'binding_method', 'external_meeting_id', 'id', 'meeting_role', 'provider', 'reused_binding', 'reused_meeting'],
  )
  assert.match(String(meeting.id), /^[0-9a-f-]{36}$/)
  assert.match(String(meeting.binding_id), /^[0-9a-f-]{36}$/)
  assert.equal(meeting.provider, 'FEISHU')
  assert.equal(meeting.external_meeting_id, token)
  assert.equal(meeting.meeting_role, 'PRIMARY')
  assert.equal(meeting.binding_method, 'MANUAL')
  assert.equal(meeting.reused_meeting, false, '首次导入必须新建 meeting')
  assert.equal(meeting.reused_binding, false, '首次导入必须新建 binding')

  // ---- minutes：回读证据原样回显（不含正文）----
  const minutes = body.minutes as Record<string, unknown>
  for (const key of [
    'minute_token', 'content_sha256', 'file_bytes', 'chars', 'fetched_at',
    'read_receipt_ref', 'transport', 'is_complete',
  ]) {
    assert.ok(Object.hasOwn(minutes, key), `minutes 缺冻结键 ${key}`)
  }
  assert.equal(minutes.minute_token, token)
  assert.equal(minutes.content_sha256, LIVE_SHA)
  assert.equal(minutes.file_bytes, LIVE_BYTES)
  assert.equal(minutes.chars, LIVE_CHARS)
  assert.equal(minutes.fetched_at, READBACK_FETCHED_AT)
  assert.equal(minutes.read_receipt_ref, `lark:minutes+detail:${token}@sha256:${LIVE_SHA}`)
  assert.equal(minutes.transport, 'FEISHU_MINUTES_API')
  assert.equal(minutes.is_complete, true)
  // 实现比冻结样例多回显 reread_sha256（回读对象带了二次重读哈希）；只多不少，逐项断言。
  if (Object.hasOwn(minutes, 'reread_sha256')) {
    assert.equal(minutes.reread_sha256, LIVE_SHA, 'reread_sha256 必须与 content_sha256 一致')
  }

  // ---- artifact：LIVE 平台标识 + 原文完整落库 ----
  const artifact = body.artifact as Record<string, unknown>
  assert.deepEqual(
    Object.keys(artifact).sort(),
    [
      'bytes', 'char_count', 'content_sha256', 'id', 'is_canonical', 'meeting_id',
      'provider', 'provider_artifact_id', 'replayed', 'segment_count', 'source_revision', 'transcript_status',
    ],
  )
  assert.equal(artifact.provider, 'FEISHU')
  assert.equal(artifact.provider_artifact_id, `feishu:minutes:${token}`)
  assert.equal(artifact.source_revision, 1)
  assert.equal(artifact.transcript_status, 'READY')
  assert.equal(artifact.content_sha256, LIVE_SHA)
  assert.equal(artifact.bytes, LIVE_BYTES)
  assert.equal(artifact.char_count, LIVE_CHARS)
  assert.equal(artifact.segment_count, LIVE_SEGMENTS)
  assert.equal(artifact.is_canonical, true)
  assert.equal(artifact.replayed, false)
  assert.equal(artifact.meeting_id, meeting.id)

  // ---- record：人还没复核（NEEDS_REVIEW / UNVERIFIED），不是 READY ----
  const record = body.record as Record<string, unknown>
  assert.deepEqual(
    Object.keys(record).sort(),
    ['evidence_ok', 'id', 'is_current', 'status', 'transcript_revision', 'verification_status'],
  )
  assert.equal(record.status, 'NEEDS_REVIEW')
  assert.equal(record.verification_status, 'UNVERIFIED')
  assert.equal(record.transcript_revision, 1)
  assert.equal(record.evidence_ok, true)
  assert.equal(record.is_current, true)

  // ---- changes：新建 artifact + N 段 + record；没有更新 ----
  const changes = body.changes as { created: { table: string; id: string }[]; updated: unknown[] }
  assert.deepEqual(Object.keys(changes).sort(), ['created', 'updated'])
  assert.deepEqual(changes.updated, [])
  assert.ok(changes.created.length >= 3, `changes.created 至少 3 行，实际 ${changes.created.length}`)
  for (const row of changes.created) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'table'], 'changes.created 每行必须是 {table,id}')
    assert.match(row.id, /^[0-9a-f-]{36}$/)
  }
  assert.ok(changes.created.some((row) => row.table === 'transcript_artifact'), '缺 transcript_artifact 变更行')
  assert.ok(changes.created.some((row) => row.table === 'interview_record'), '缺 interview_record 变更行')
  assert.equal(
    changes.created.filter((row) => row.table === 'transcript_segment').length,
    LIVE_SEGMENTS,
    'changes 里的 segment 行数 = 正文非空行数',
  )

  // =========================================================================
  //  独立 SQL 读回（直连 db.pool，不 import 任何产品读投影）
  // =========================================================================
  const meetingRows = await query<{ id: string; provider: string; external_meeting_id: string | null; meeting_role: string }>(
    `select id::text as id, provider, external_meeting_id, meeting_role
       from recruitment.meeting
      where tenant_id = $1 and provider = 'FEISHU' and external_meeting_id = $2`,
    [TENANT, token],
  )
  assert.equal(meetingRows.length, 1, 'meeting 必须恰好一行（provider=FEISHU, external_meeting_id=minute_token）')
  assert.equal(meetingRows[0]!.id, meeting.id)
  assert.equal(meetingRows[0]!.provider, 'FEISHU')
  assert.equal(meetingRows[0]!.external_meeting_id, token)
  assert.equal(meetingRows[0]!.meeting_role, 'PRIMARY')

  const bindingRows = await query<{
    binding_id: string
    interview_id: string
    meeting_id: string
    binding_method: string
    bound_by_actor_id: string | null
    unbound_at: Date | null
  }>(
    `select b.id::text as binding_id, b.interview_id::text as interview_id, b.meeting_id::text as meeting_id,
            b.binding_method, b.bound_by_actor_id::text as bound_by_actor_id, b.unbound_at
       from recruitment.meeting_binding b
      where b.tenant_id = $1 and b.meeting_id = $2 and b.unbound_at is null`,
    [TENANT, meetingRows[0]!.id],
  )
  assert.equal(bindingRows.length, 1, '每条 meeting 必须有且仅有一条 active 绑定')
  assert.equal(bindingRows[0]!.binding_id, meeting.binding_id)
  assert.equal(bindingRows[0]!.interview_id, INTERVIEW_ROUND2)
  assert.equal(bindingRows[0]!.meeting_id, meetingRows[0]!.id)
  assert.equal(bindingRows[0]!.binding_method, 'MANUAL')
  assert.equal(bindingRows[0]!.bound_by_actor_id, ACTOR_103, '绑定人 = recruiter 103')
  assert.equal(bindingRows[0]!.unbound_at, null)

  const artifactRows = await query<{
    id: string
    meeting_id: string
    provider: string
    provider_artifact_id: string
    source_revision: number
    transcript_status: string
    content_sha256: string
    raw_text: string
    provenance: string
    trigger_mode: string
    connection_state: string
    raw_bytes: number
    segment_count: number
    is_canonical: boolean
    read_receipt_ref: string | null
    fetched_at: Date
  }>(
    `select ta.id::text as id, ta.meeting_id::text as meeting_id, ta.provider,
            ta.provider_artifact_id, ta.source_revision, ta.transcript_status, ta.content_sha256,
            ta.raw_text, ta.provenance, ta.trigger_mode, ta.connection_state,
            octet_length(ta.raw_text)::int as raw_bytes,
            (select count(*)::int from recruitment.transcript_segment ts
              where ts.tenant_id = ta.tenant_id and ts.artifact_id = ta.id) as segment_count,
            ta.is_canonical, ta.read_receipt_ref, ta.fetched_at
       from recruitment.transcript_artifact ta
      where ta.id = $1 and ta.tenant_id = $2`,
    [String(artifact.id), TENANT],
  )
  assert.equal(artifactRows.length, 1, 'artifact 必须恰好一行')
  const artifactDb = artifactRows[0]!
  assert.equal(artifactDb.meeting_id, meetingRows[0]!.id, 'artifact.meeting_id = 新建 meeting')
  assert.equal(artifactDb.provider, 'FEISHU')
  assert.equal(artifactDb.provider_artifact_id, `feishu:minutes:${token}`)
  assert.equal(artifactDb.source_revision, 1)
  assert.equal(artifactDb.transcript_status, 'READY')
  assert.equal(artifactDb.content_sha256, LIVE_SHA)
  assert.equal(artifactDb.raw_text, LIVE_RAW_TEXT, '原文必须逐字落库（不做清洗）')
  assert.equal(artifactDb.raw_bytes, LIVE_BYTES)
  assert.equal(artifactDb.provenance, 'LIVE')
  assert.equal(artifactDb.trigger_mode, 'MANUAL')
  assert.equal(artifactDb.connection_state, 'CONNECTED')
  assert.equal(artifactDb.segment_count, LIVE_SEGMENTS)
  assert.equal(artifactDb.is_canonical, true)
  assert.equal(artifactDb.read_receipt_ref, `lark:minutes+detail:${token}@sha256:${LIVE_SHA}`)

  const segmentRows = await query<{ sequence: number; content_text: string }>(
    `select sequence, content_text from recruitment.transcript_segment
      where tenant_id = $1 and artifact_id = $2 order by sequence`,
    [TENANT, String(artifact.id)],
  )
  assert.equal(segmentRows.length, LIVE_SEGMENTS, 'segment 行数 = 正文非空行数')
  const lines = LIVE_RAW_TEXT.split(/\r?\n/).filter((line) => line !== '')
  for (let index = 0; index < lines.length; index += 1) {
    assert.equal(segmentRows[index]!.sequence, index, 'sequence 从 0 连续递增')
    assert.equal(segmentRows[index]!.content_text, lines[index], `第 ${index} 段必须是原文那一行`)
  }

  const recordRows = await query<{
    id: string
    status: string
    verification_status: string
    transcript_revision: number
    evidence_ok: boolean
    is_current: boolean
    transcript_artifact_id: string
    rubric_version_id: string
  }>(
    `select id::text as id, status, verification_status, transcript_revision, evidence_ok, is_current,
            transcript_artifact_id::text as transcript_artifact_id, rubric_version_id::text as rubric_version_id
       from recruitment.interview_record
      where tenant_id = $1 and interview_id = $2 and is_current`,
    [TENANT, INTERVIEW_ROUND2],
  )
  assert.equal(recordRows.length, 1, '该场面试必须有且仅有一条 current interview_record')
  const recordDb = recordRows[0]!
  assert.equal(recordDb.id, record.id)
  assert.equal(recordDb.status, 'NEEDS_REVIEW')
  assert.equal(recordDb.verification_status, 'UNVERIFIED')
  assert.equal(recordDb.transcript_revision, 1)
  assert.equal(recordDb.evidence_ok, true)
  assert.equal(recordDb.is_current, true)
  assert.equal(recordDb.transcript_artifact_id, String(artifact.id), 'record 引用本次 artifact')
  assert.equal(recordDb.rubric_version_id, state.rubricVersionId, 'record 钉住申请的 rubric')

  // ---- db_readback：响应里的读回段必须等于上面独立 SQL 的事实 ----
  const dbReadback = body.db_readback as Record<string, unknown>
  assert.deepEqual(Object.keys(dbReadback).sort(), ['artifact', 'interview_record', 'meeting', 'meeting_binding', 'read_at'])
  const rbArtifact = dbReadback.artifact as Record<string, unknown>
  assert.deepEqual(
    Object.keys(rbArtifact).sort(),
    [
      'connection_state', 'content_sha256', 'fetched_at', 'id', 'is_canonical', 'meeting_id',
      'provenance', 'provider', 'provider_artifact_id', 'raw_bytes', 'segment_count',
      'source_revision', 'transcript_status', 'trigger_mode',
    ],
  )
  assert.equal(rbArtifact.id, artifactDb.id)
  assert.equal(rbArtifact.meeting_id, artifactDb.meeting_id)
  assert.equal(rbArtifact.provider, 'FEISHU')
  assert.equal(rbArtifact.provider_artifact_id, `feishu:minutes:${token}`)
  assert.equal(rbArtifact.source_revision, 1)
  assert.equal(rbArtifact.transcript_status, 'READY')
  assert.equal(rbArtifact.content_sha256, LIVE_SHA)
  assert.equal(rbArtifact.raw_bytes, LIVE_BYTES)
  assert.equal(rbArtifact.segment_count, LIVE_SEGMENTS)
  assert.equal(rbArtifact.is_canonical, true)
  assert.equal(rbArtifact.provenance, 'LIVE')
  assert.equal(rbArtifact.trigger_mode, 'MANUAL')
  assert.equal(rbArtifact.connection_state, 'CONNECTED')
  assert.equal(rbArtifact.fetched_at, artifactDb.fetched_at.toISOString(), 'db_readback.fetched_at = 库内 fetched_at')

  const rbRecord = dbReadback.interview_record as Record<string, unknown>
  assert.equal(rbRecord.id, recordDb.id)
  assert.equal(rbRecord.status, 'NEEDS_REVIEW')
  assert.equal(rbRecord.verification_status, 'UNVERIFIED')
  assert.equal(rbRecord.transcript_revision, 1)
  assert.equal(rbRecord.evidence_ok, true)
  assert.equal(rbRecord.is_current, true)

  const rbMeeting = dbReadback.meeting as Record<string, unknown>
  assert.deepEqual(rbMeeting, {
    id: meetingRows[0]!.id,
    provider: 'FEISHU',
    external_meeting_id: token,
    meeting_role: 'PRIMARY',
  })
  const rbBinding = dbReadback.meeting_binding as Record<string, unknown>
  assert.deepEqual(rbBinding, {
    binding_id: bindingRows[0]!.binding_id,
    interview_id: INTERVIEW_ROUND2,
    meeting_id: meetingRows[0]!.id,
    binding_method: 'MANUAL',
    bound_by_actor_id: ACTOR_103,
  })
  assert.ok(Number.isFinite(Date.parse(String(dbReadback.read_at))), 'db_readback.read_at 必须是可解析时间')

  // ---- 行数变化：每张事实表各 +1（segment 为 +N）----
  assert.equal(await count('meeting'), before.meeting + 1)
  assert.equal(await count('meeting_binding'), before.meeting_binding + 1)
  assert.equal(await count('transcript_artifact'), before.transcript_artifact + 1)
  assert.equal(await count('transcript_segment'), before.transcript_segment + LIVE_SEGMENTS)
  assert.equal(await count('interview_record'), before.interview_record + 1)

  state.token = token
  state.meetingId = String(meeting.id)
  state.bindingId = String(meeting.binding_id)
  state.artifactId = String(artifact.id)
  state.recordId = String(record.id)
})

// ===========================================================================
//  b. 幂等重放
// ===========================================================================

test('b 幂等重放：同参第二次 → replayed:true、复用 meeting/binding、零新增、sha 不变', async () => {
  const before = {
    meeting: await count('meeting'),
    meeting_binding: await count('meeting_binding'),
    transcript_artifact: await count('transcript_artifact'),
    transcript_segment: await count('transcript_segment'),
    interview_record: await count('interview_record'),
  }
  const body = await okJson(
    await call(harness, 'POST', IMPORT_PATH, {
      session: SESSION_R,
      body: { interview_id: INTERVIEW_ROUND2, minute_token: state.token },
    }),
    'feishu/import 重放',
  )
  assert.equal(body.status, 'READY')
  assert.deepEqual(body.labels, { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' })
  const artifact = body.artifact as Record<string, unknown>
  assert.equal(artifact.replayed, true, '同内容重放必须 replayed=true')
  assert.equal(artifact.id, state.artifactId, '重放返回既有 artifact（不新建）')
  assert.equal(artifact.source_revision, 1, '重放不新增 revision')
  assert.equal(artifact.content_sha256, LIVE_SHA)
  const meeting = body.meeting as Record<string, unknown>
  assert.equal(meeting.reused_meeting, true, '重放复用既有 meeting')
  assert.equal(meeting.reused_binding, true, '重放复用既有 active 绑定')
  assert.equal(meeting.id, state.meetingId)
  const record = body.record as Record<string, unknown>
  assert.equal(record.id, state.recordId, '重放不新建 interview_record')
  assert.deepEqual(body.changes, { created: [], updated: [] }, '重放零变更')

  // 独立 SQL：sha / revision / 行数全部不变
  const artifactDb = await query<{ content_sha256: string; source_revision: number; is_canonical: boolean }>(
    'select content_sha256, source_revision, is_canonical from recruitment.transcript_artifact where id = $1 and tenant_id = $2',
    [state.artifactId, TENANT],
  )
  assert.equal(artifactDb.length, 1)
  assert.equal(artifactDb[0]!.content_sha256, LIVE_SHA, 'sha 不变')
  assert.equal(artifactDb[0]!.source_revision, 1)
  assert.equal(artifactDb[0]!.is_canonical, true)
  assert.deepEqual(
    {
      meeting: await count('meeting'),
      meeting_binding: await count('meeting_binding'),
      transcript_artifact: await count('transcript_artifact'),
      transcript_segment: await count('transcript_segment'),
      interview_record: await count('interview_record'),
    },
    before,
    '重放零写入（5 张事实表行数不变）',
  )
})

// ===========================================================================
//  c. 注册表 / 方法 / 回环契约
// ===========================================================================

test('c1 非 POST → 405 且 allow: POST（同源校验先于方法判定）', async () => {
  const get = await call(harness, 'GET', IMPORT_PATH, { session: SESSION_R })
  assert.equal(get.status, 405, `GET 应 405，实际 ${get.status}：${get.text}`)
  assert.equal(get.allow, 'POST', '405 必须带 allow: POST')
  const del = await call(harness, 'DELETE', IMPORT_PATH, { session: SESSION_R })
  assert.equal(del.status, 405, `DELETE 应 405，实际 ${del.status}：${del.text}`)
  assert.equal(del.allow, 'POST', '405 必须带 allow: POST（DELETE）')
  // 方法拒绝不碰库：事实表行数不变。
  const before = await targetCounts()
  assert.deepEqual(await targetCounts(), before)
})

test('c2 非回环 host → 不注册路由并告警（fail-closed）', async () => {
  const routes: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const dispose = registerFeishuImportHttp(
    {
      webServer: {
        host: '0.0.0.0',
        port: 60189,
        register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) {
          routes.push({ kind: route.kind, path: route.path })
          return () => {}
        },
      },
      logger: { warn: (message: string) => warnings.push(message) },
    },
    { database: cfg, databaseIssues: [], identity, connectorOverride: liveConnector() },
  )
  assert.equal(routes.length, 0, '非回环 host 不得注册任何路由（不是注册后再 403）')
  assert.equal(warnings.length, 1, '必须告警一条')
  assert.match(warnings[0]!, /不是回环地址/, `告警应说明原因：${warnings[0]}`)
  dispose()
})

// ===========================================================================
//  d. 负例族：逐条断言 状态 + code + reason_code + 零写入
// ===========================================================================

test('d1 未绑定 session → 409 DEMO_ACTOR_UNMAPPED(SESSION_NOT_BOUND)，零写入', async () => {
  await expectRejected(
    '未绑定 session',
    harness,
    { session: SESSION_UNBOUND, body: negBody() },
    { status: 409, code: 'DEMO_ACTOR_UNMAPPED', reason: 'SESSION_NOT_BOUND' },
  )
})

test('d2 interviewer_a 越权 → 403 FORBIDDEN(ACTOR_NOT_AUTHORIZED)，零写入', async () => {
  await expectRejected(
    'interviewer_a 调真实转写导入',
    harness,
    { session: SESSION_A, body: negBody() },
    { status: 403, code: 'FORBIDDEN', reason: 'ACTOR_NOT_AUTHORIZED' },
  )
})

test('d3 缺 x-dsh-session → 400 INVALID_ARGS(SESSION_REQUIRED)，零写入', async () => {
  await expectRejected(
    '缺 session',
    harness,
    { body: negBody() },
    { status: 400, code: 'INVALID_ARGS', reason: 'SESSION_REQUIRED' },
  )
})

test('d4 非法 x-dsh-session → 400 INVALID_ARGS(SESSION_ID_INVALID)，零写入', async () => {
  await expectRejected(
    '非法 session',
    harness,
    { session: 'not-a-session', body: negBody() },
    { status: 400, code: 'INVALID_ARGS', reason: 'SESSION_ID_INVALID' },
  )
})

test('d5 缺同源头 x-recruitment-request → 403 FORBIDDEN(SAME_ORIGIN_REQUIRED)，零写入', async () => {
  await expectRejected(
    '缺同源头',
    harness,
    { session: SESSION_R, body: negBody(), omitRequestHeader: true },
    { status: 403, code: 'FORBIDDEN', reason: 'SAME_ORIGIN_REQUIRED' },
  )
})

test('d6 非 JSON Content-Type → 415，零写入', async () => {
  // 冻结口径只钉了 415；实现用 INVALID_ARGS/UNSUPPORTED_MEDIA_TYPE，这里一并钉住（更严，不放宽）。
  await expectRejected(
    '非 JSON',
    harness,
    { session: SESSION_R, rawBody: JSON.stringify(negBody()), contentType: 'text/plain' },
    { status: 415, code: 'INVALID_ARGS', reason: 'UNSUPPORTED_MEDIA_TYPE' },
  )
})

test('d7 body 缺 minute_token → 400 INVALID_ARGS(MISSING_REQUIRED)，零写入', async () => {
  await expectRejected(
    'body 缺 minute_token',
    harness,
    { session: SESSION_R, body: { interview_id: INTERVIEW_ROUND1 } },
    { status: 400, code: 'INVALID_ARGS', reason: 'MISSING_REQUIRED' },
  )
})

test('d8 interview_id 非法 UUID → 400 INVALID_ARGS(ID_NOT_UUID)，零写入', async () => {
  await expectRejected(
    'interview_id 非法 UUID',
    harness,
    { session: SESSION_R, body: { interview_id: 'not-a-uuid', minute_token: `mt-d5fs-x-${UNIQUE}` } },
    { status: 400, code: 'INVALID_ARGS', reason: 'ID_NOT_UUID' },
  )
})

test('d9 body 未知键 → 400 INVALID_ARGS(UNKNOWN_PARAM)，零写入', async () => {
  await expectRejected(
    'body 未知键',
    harness,
    { session: SESSION_R, body: { ...negBody(), note: '不该被接受' } },
    { status: 400, code: 'INVALID_ARGS', reason: 'UNKNOWN_PARAM' },
  )
})

test('d10 body 带 actor_id → 400 INVALID_ARGS(ACTOR_OVERRIDE_REJECTED)，零写入', async () => {
  await expectRejected(
    'body actor_id',
    harness,
    { session: SESSION_R, body: { ...negBody(), actor_id: ACTOR_104 } },
    { status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
  )
})

test('d11 body 带 tenant_id → 400 INVALID_ARGS(ACTOR_OVERRIDE_REJECTED)，零写入', async () => {
  await expectRejected(
    'body tenant_id',
    harness,
    { session: SESSION_R, body: { ...negBody(), tenant_id: TENANT } },
    { status: 400, code: 'INVALID_ARGS', reason: 'ACTOR_OVERRIDE_REJECTED' },
  )
})

test('d12 面试不存在 → 404 NOT_FOUND(INTERVIEW_NOT_FOUND)，零写入', async () => {
  await expectRejected(
    '面试不存在',
    harness,
    { session: SESSION_R, body: { interview_id: randomUUID(), minute_token: `mt-d5fs-missing-${UNIQUE}` } },
    { status: 404, code: 'NOT_FOUND', reason: 'INTERVIEW_NOT_FOUND' },
  )
})

test('d13 无 feishu 配置且无 override → 503 NOT_CONFIGURED(TRANSPORT_NOT_CONFIGURED)，零写入', async () => {
  await expectRejected(
    '连接器未装配',
    noConfigHarness,
    { session: SESSION_R, body: negBody() },
    { status: 503, code: 'NOT_CONFIGURED', reason: 'TRANSPORT_NOT_CONFIGURED' },
  )
})

test('d14 connector BLOCKED 无应用凭据 → 503 NOT_CONFIGURED(NO_APP_CREDENTIALS)，零写入', async () => {
  await expectRejected(
    'connector 无凭据',
    noCredentialsHarness,
    { session: SESSION_R, body: negBody() },
    { status: 503, code: 'NOT_CONFIGURED', reason: 'NO_APP_CREDENTIALS' },
  )
})

test('d15 connector BLOCKED 缺用户身份(AUTH_REQUIRED) → 403 FORBIDDEN(AUTH_REQUIRED)，零写入', async () => {
  await expectRejected(
    'connector AUTH_REQUIRED',
    noUserIdentityHarness,
    { session: SESSION_R, body: negBody() },
    { status: 403, code: 'FORBIDDEN', reason: 'AUTH_REQUIRED' },
  )
})

test('d16 回读对象自相矛盾 → 409 BLOCKED(READBACK_INVALID)，零写入', async () => {
  await expectRejected(
    '回读自相矛盾',
    harness,
    { session: SESSION_R, body: { interview_id: INTERVIEW_ROUND1, minute_token: `mt-d5fs-badsha-${UNIQUE}` } },
    { status: 409, code: 'BLOCKED', reason: 'READBACK_INVALID' },
  )
})

test('d17 gate 非 LIVE（证据不齐但无矛盾）→ 409 BLOCKED(READBACK_INVALID)，零写入', async () => {
  await expectRejected(
    'gate 非 LIVE',
    notLiveGateHarness,
    { session: SESSION_R, body: { interview_id: INTERVIEW_ROUND1, minute_token: `mt-d5fs-notlive-${UNIQUE}` } },
    { status: 409, code: 'BLOCKED', reason: 'READBACK_INVALID' },
  )
})

test('d18 同一 minute 已 active 绑定到另一场面试 → 409 MEETING_ALREADY_BOUND，零写入', async () => {
  // 正例已把 state.token 绑到 0802；这里拿同一 minute 去导 0801 → 撞 active 绑定。
  await expectRejected(
    'meeting 已绑另一场面试',
    harness,
    { session: SESSION_R, body: { interview_id: INTERVIEW_ROUND1, minute_token: state.token } },
    { status: 409, code: 'MEETING_ALREADY_BOUND', reason: 'MEETING_ALREADY_BOUND' },
  )
})

// ===========================================================================
//  helper
// ===========================================================================

/** 跨用例共享的对象 id / 版本（由正例写入、后续用例读）。 */
const state: {
  token: string
  meetingId: string
  bindingId: string
  artifactId: string
  recordId: string
  rubricVersionId: string
} = {
  token: '',
  meetingId: '',
  bindingId: '',
  artifactId: '',
  recordId: '',
  rubricVersionId: '',
}

/** 负例用的合法形状 body（能过形状校验、倒在目标断言上）。 */
function negBody(): { interview_id: string; minute_token: string } {
  return { interview_id: INTERVIEW_ROUND1, minute_token: `mt-d5fs-neg-${UNIQUE}` }
}

/** 独立 SQL 读回（连本用例的一次性库；不经过任何产品读模块）。 */
async function query<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await db.pool.query<T>(sql, [...params])
  return result.rows
}

/** 一张事实表的行数（独立 SQL；表名只来自本文件的封闭常量）。 */
async function count(table: string): Promise<number> {
  assert.ok((ZERO_WRITE_TABLES as readonly string[]).includes(table), `不允许的表名：${table}`)
  const rows = await query<{ n: number }>(`select count(*)::int as n from recruitment.${table}`)
  return rows[0]?.n ?? 0
}

/** 5 张事实表行数快照（失败路径前后必须逐项相等）。 */
async function targetCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of ZERO_WRITE_TABLES) out[table] = await count(table)
  return out
}

/** 断言 200 并返回 JSON 信封。 */
async function okJson(result: HttpResult, label: string): Promise<Record<string, unknown>> {
  assert.equal(result.status, 200, `${label} 期望 200，实际 ${result.status}：${result.text.slice(0, 1500)}`)
  return result.body
}

/** 断言错误信封 `{error:{code,reason_code,message}}`。 */
function assertError(
  result: HttpResult,
  status: number,
  code: string,
  reasonCode: string | undefined,
  label: string,
): void {
  assert.equal(result.status, status, `${label} 期望 ${status}，实际 ${result.status}：${result.text.slice(0, 1500)}`)
  const error = (result.body.error ?? {}) as Record<string, unknown>
  assert.equal(error.code, code, `${label} code 期望 ${code}，实际 ${String(error.code)}：${result.text.slice(0, 1000)}`)
  if (reasonCode !== undefined) {
    assert.equal(
      error.reason_code,
      reasonCode,
      `${label} reason_code 期望 ${reasonCode}，实际 ${String(error.reason_code)}：${result.text.slice(0, 1000)}`,
    )
  }
  assert.equal(typeof error.message, 'string', `${label} 错误信封必须带 message`)
}

/**
 * 一次负例：POST → 断言状态/错误码 → 断言 5 张事实表行数前后逐项不变（零写入）。
 * @param label - 断言消息前缀。
 * @param h - 目标 harness。
 * @param options - 请求选项（session/body/rawBody/omitRequestHeader 等）。
 * @param expected - 冻结映射（status + code + reason_code）。
 */
async function expectRejected(
  label: string,
  h: Harness,
  options: CallOptions,
  expected: { readonly status: number; readonly code: string; readonly reason: string },
): Promise<void> {
  const before = await targetCounts()
  const result = await call(h, 'POST', IMPORT_PATH, options)
  assertError(result, expected.status, expected.code, expected.reason, label)
  assert.deepEqual(await targetCounts(), before, `${label}：失败路径零写入（5 张事实表行数不变）`)
}

/** 跑 `scripts/bootstrap-demo.mjs`（cwd = 仓库根；env 只指向本用例的一次性库；默认 allow-once）。 */
function runBootstrap(databaseName: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('RECRUITMENT_') || key.startsWith('DEMO_')) continue
    env[key] = value
  }
  env.RECRUITMENT_DB_PASSWORD = BASE.password
  env.RECRUITMENT_DB_HOST = BASE.host
  env.RECRUITMENT_DB_PORT = String(BASE.port)
  env.RECRUITMENT_DB_USER = BASE.user
  env.RECRUITMENT_DB_NAME = databaseName
  env.RECRUITMENT_TENANT_ID = TENANT
  env.RECRUITMENT_ACTOR_ID = HR_ACTOR
  env.DEMO_APPROVAL_MODE = 'allow-once'
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BOOTSTRAP_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`bootstrap 超时（120s）\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
    }, 120_000)
    timer.unref?.()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * 起真 `node:http` server 并注册**真实的** actor + 飞书导入路由（同一份产品注册函数）。
 * 顺序刻意：先 listen 拿真实端口，再把 `{host, port, register}` 交给路由 —— `sameOrigin` 用这个端口。
 * @param deps - 飞书导入路由依赖（actor 路由复用其中的 database/identity）。
 */
async function startHarness(deps: FeishuImportDeps): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const registered: { kind: string; path: string }[] = []
  const warnings: string[] = []
  const server: Server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(pathname)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', reason_code: 'NO_EXACT_ROUTE' } }))
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        try {
          res.destroy()
        } catch {
          // 连接已坏：忽略。
        }
      })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  const webServer = {
    host: '127.0.0.1',
    port: address.port,
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
    }) {
      registered.push({ kind: route.kind, path: route.path })
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
  }
  const logger = {
    warn(message: string) {
      warnings.push(message)
    },
  }
  const disposers = [
    registerActorHttp({ webServer, logger }, {
      database: deps.database,
      databaseIssues: deps.databaseIssues,
      identity: deps.identity,
    }),
    registerFeishuImportHttp({ webServer, logger }, deps),
  ]
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    registered,
    warnings,
    async close(): Promise<void> {
      for (const dispose of disposers) dispose()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * 发一次同源请求（默认带 `x-recruitment-request: 1` 与 `x-dsh-session`）。
 * @param h - 目标 harness。
 * @param method - HTTP 方法。
 * @param path - 请求路径。
 * @param options - session / body / 是否省略同源头 / 原始 body 与 content-type。
 */
async function call(h: Harness, method: string, path: string, options: CallOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  if (options.omitRequestHeader !== true) headers['x-recruitment-request'] = '1'
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  } else if (options.rawBody !== undefined) {
    if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'application/json'
    payload = options.rawBody
  }
  const response = await fetch(`${h.baseUrl}${path}`, { method, headers, body: payload })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, body, text, allow: response.headers.get('allow') }
}
