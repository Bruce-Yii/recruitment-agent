// Issue #54 · 设置后端契约 × 真实 PostgreSQL（一次性隔离库）。
//
// 纪律：每个用例独占 `createIsolatedTestDatabase()` 建出的一次性库，脚本会在 after
// 里删库；所有落库事实都用**独立 SQL 读回**验证，不信函数返回值自述。
// 覆盖：
//   S1 六个键经 appendSettingVersion 落库（payload.value + version_no 递增），SQL 读回逐字段一致；
//   S2 POST /action/settings/write 真库写入 4 个新键，读回 payload 而非只信 HTTP 响应；
//   S3 GET /settings 真库读回六键时不标 defaults_applied（诚实区分"已配置"与"默认"）；
//   S4 GET /config/org 真库返回 active roles/hiring_teams/pipeline_templates + record_version；
//   S5 未绑定 session 对该路由 409 且零 DB 读（计数不变）。
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import {
  appendSettingVersion,
  readAllSettings,
  readSetting,
} from '../../src/db/settings.ts'
import {
  createPool,
  closePool,
  withActor,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../../src/db/pool.ts'
import {
  createPipeline,
  createTeam,
  WORKSPACE_SETTING_KEYS,
} from '../../src/domain/tenant-config.ts'
import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'
import {
  registerSettingsHttp,
  SETTINGS_PATHS,
  type SettingsHttpDeps,
} from '../../src/http/settings.ts'
import {
  createIsolatedTestDatabase,
  HR_ACTOR,
  TENANT,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

const SESSION = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UNBOUND = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'

interface Harness {
  readonly baseUrl: string
  readonly routes: Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>
  close(): Promise<void>
}

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let harness: Harness

async function startServer(deps: SettingsHttpDeps): Promise<Harness> {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    const handler = routes.get(path)
    if (handler === undefined) { res.writeHead(404); res.end(); return }
    Promise.resolve().then(() => handler(req, res)).catch(() => res.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  registerSettingsHttp(
    {
      webServer: {
        host: '127.0.0.1',
        port,
        register(route) {
          routes.set(route.path, route.handler)
          return () => { routes.delete(route.path) }
        },
      },
    },
    deps,
  )
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    routes,
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())) },
  }
}

async function call(path: string, options: { session?: string; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { 'x-recruitment-request': '1' }
  if (options.session !== undefined) headers['x-dsh-session'] = options.session
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: payload,
  })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try { body = JSON.parse(text) as Record<string, unknown> } catch { body = { raw: text } }
  return { status: response.status, body, text }
}

/** 直接 SQL 读当前生效 payload（不经 src/db/settings.ts 的白名单投影）。 */
async function sqlPayload(configKey: string): Promise<{ versionNo: number; payload: Record<string, unknown> } | null> {
  const pool = createPool(cfg)
  try {
    const { rows } = await pool.query<{ version_no: number; payload: Record<string, unknown> }>(
      `select version_no, payload from recruitment.business_config
        where tenant_id = $1::uuid and scope = 'ORGANIZATION' and scope_id is null
          and config_key = $2 and effective_to is null
        order by version_no desc limit 1`,
      [TENANT, configKey],
    )
    const row = rows[0]
    return row === undefined ? null : { versionNo: Number(row.version_no), payload: row.payload }
  } finally {
    await closePool(pool)
  }
}

before(async () => {
  db = await createIsolatedTestDatabase('settings54')
  cfg = { ...testDatabaseConfig(), database: db.name }
  // 在隔离库里造一条团队 + 一条流程模板（0014 不种企业数据，角色由 0002 种好）。
  const pool = createPool(cfg)
  try {
    await withActor(pool, HR_ACTOR, async (client) => {
      await createTeam(client, {
        tenantId: TENANT,
        code: 'TEAM_SETTINGS54',
        name: '设置契约测试团队',
        departmentId: '11111111-1111-4111-8111-000000000010',
        memberActorIds: [HR_ACTOR],
      })
      await createPipeline(client, {
        tenantId: TENANT,
        code: 'PIPELINE_SETTINGS54',
        name: '设置契约测试流程',
      })
    })
  } finally {
    await closePool(pool)
  }
  const { identity } = createDemoActorIdentity({ recruiter: HR_ACTOR })
  identity.registry.bind(SESSION, 'recruiter')
  harness = await startServer({
    database: cfg,
    databaseIssues: [],
    identity,
    mailConfig: {},
    mailEnv: {},
    feishuConfig: {},
    feishuEnv: {},
  })
})

after(async () => {
  if (harness !== undefined) await harness.close()
  if (db !== undefined) await db.drop()
})

describe('Issue #54 · 真库写入与读回', () => {
  const values: Record<string, unknown> = {
    agent_silent_delegation: false,
    sla_thresholds: { screening_hours: 12, scorecard_hours: 36 },
    auto_screening_enabled: false,
    auto_scorecard_draft_enabled: false,
    scorecard_reminder_policy: {
      enabled: true, overdue_hours: 72, max_reminders: 5, channel: 'feishu',
      quiet_hours: { start: '20:00', end: '09:00' },
    },
    booking_invite_defaults: { expires_hours: 168, default_duration_min: 90 },
  }

  test('S1 六键经 appendSettingVersion 追加版本，独立 SQL 读回 payload 逐字段一致', async () => {
    assert.equal(WORKSPACE_SETTING_KEYS.length, 6)
    const pool = createPool(cfg)
    try {
      for (const key of WORKSPACE_SETTING_KEYS) {
        await withActor(pool, HR_ACTOR, (client) =>
          appendSettingVersion(client, {
            tenantId: TENANT,
            configKey: key,
            value: values[key],
            actorId: HR_ACTOR,
            confirmationTextSha256: 'a'.repeat(64),
          }),
        )
      }
    } finally {
      await closePool(pool)
    }
    for (const key of WORKSPACE_SETTING_KEYS) {
      const row = await sqlPayload(key)
      assert.ok(row !== null, `${key} 必须在库里有生效行`)
      assert.equal(row.versionNo, 1)
      assert.deepEqual(row.payload.value, values[key], `${key} payload.value 必须与写入一致`)
      assert.equal(row.payload.confirmation_text_sha256, 'a'.repeat(64))
      assert.equal(row.payload.updated_by_actor_id, HR_ACTOR)
      assert.equal(row.payload.changed_from, null)
    }
  })

  test('S2 同一键再次 append → version_no=2，旧版本仍可从版本链读出（append-only）', async () => {
    const pool = createPool(cfg)
    try {
      await withActor(pool, HR_ACTOR, (client) =>
        appendSettingVersion(client, {
          tenantId: TENANT,
          configKey: 'scorecard_reminder_policy',
          value: { enabled: false, overdue_hours: 24, max_reminders: 1, channel: 'email' },
          actorId: HR_ACTOR,
          confirmationTextSha256: 'b'.repeat(64),
        }),
      )
    } finally {
      await closePool(pool)
    }
    const row = await sqlPayload('scorecard_reminder_policy')
    assert.ok(row !== null)
    assert.equal(row.versionNo, 2)
    // 既有 appendSettingVersion 不封顶旧行，changed_from 在当前实现里恒为 null；
    // 这里只验证审计字段由服务端写入、版本链确实 append-only。
    assert.equal(row.payload.changed_from, null)
    assert.deepEqual(row.payload.value, { enabled: false, overdue_hours: 24, max_reminders: 1, channel: 'email' })
    assert.equal(row.payload.confirmation_text_sha256, 'b'.repeat(64))
    const history = await (async () => {
      const p = createPool(cfg)
      try {
        return (await p.query<{ version_no: number }>(
          `select version_no from recruitment.business_config
            where tenant_id = $1::uuid and config_key = 'scorecard_reminder_policy' order by version_no`,
          [TENANT],
        )).rows.map((r) => Number(r.version_no))
      } finally { await closePool(p) }
    })()
    assert.deepEqual(history, [1, 2], '绝不 UPDATE 旧行')
  })

  test('S3 GET /settings 真库读回六键 → defaults_applied 为空数组（没有撒谎说用了默认）', async () => {
    const result = await call(SETTINGS_PATHS.read, { session: SESSION, method: 'GET' })
    assert.equal(result.status, 200, result.text)
    assert.deepEqual(result.body.defaults_applied, [])
    // S2 覆盖了催交策略，其余键仍是 S1 写的值。
    assert.equal((result.body.settings as Record<string, unknown>).auto_screening_enabled, false)
    assert.equal((result.body.settings as Record<string, unknown>).auto_scorecard_draft_enabled, false)
    assert.deepEqual((result.body.settings as Record<string, unknown>).booking_invite_defaults,
      { expires_hours: 168, default_duration_min: 90 })
    assert.deepEqual((result.body.settings as Record<string, unknown>).scorecard_reminder_policy,
      { enabled: false, overdue_hours: 24, max_reminders: 1, channel: 'email' })
  })

  test('S4 POST /settings/write 真库写入 booking_invite_defaults，独立 SQL 读回', async () => {
    const value = { expires_hours: 48, default_duration_min: 45 }
    const result = await call(SETTINGS_PATHS.write, {
      session: SESSION,
      body: { key: 'booking_invite_defaults', value, confirmation_text: '确认调整预约默认值' },
    })
    assert.equal(result.status, 200, result.text)
    assert.equal(result.body.key, 'booking_invite_defaults')
    assert.equal(result.body.version_no, 2)
    const row = await sqlPayload('booking_invite_defaults')
    assert.ok(row !== null)
    assert.deepEqual(row.payload.value, value)
    assert.equal(row.versionNo, 2)
    // 独立只读视图读回也一致。
    const pool = createPool(cfg)
    try {
      const view = await withReadOnly(pool, (client) => readSetting(client, TENANT, 'booking_invite_defaults'))
      assert.deepEqual(view?.value, value)
    } finally { await closePool(pool) }
  })

  test('S5 POST 非法值 → 400 且行数/版本不动（真库零写入）', async () => {
    const before = await sqlPayload('auto_screening_enabled')
    const result = await call(SETTINGS_PATHS.write, {
      session: SESSION,
      body: { key: 'auto_screening_enabled', value: 'false', confirmation_text: '确认修改' },
    })
    assert.equal(result.status, 400, result.text)
    const after = await sqlPayload('auto_screening_enabled')
    assert.deepEqual(after, before)
  })

  test('S6 GET /config/org 真库返回 active 角色 / 团队 / 流程模板 + record_version', async () => {
    const result = await call(SETTINGS_PATHS.configOrg, { session: SESSION, method: 'GET' })
    assert.equal(result.status, 200, result.text)
    const roles = result.body.roles as { code: string; is_active: boolean; record_version: number }[]
    const teams = result.body.hiring_teams as { code: string; is_active: boolean; record_version: number }[]
    const pipelines = result.body.pipeline_templates as { code: string; is_active: boolean; record_version: number }[]
    assert.ok(roles.length > 0 && roles.every((r) => r.is_active))
    assert.deepEqual(teams.map((t) => t.code), ['TEAM_SETTINGS54'])
    assert.deepEqual(pipelines.map((p) => p.code), ['PIPELINE_SETTINGS54'])
    for (const row of [...roles, ...teams, ...pipelines]) {
      assert.ok(Number.isInteger(row.record_version) && row.record_version >= 1)
    }
    assert.equal(typeof result.body.record_version, 'number')
    assert.ok((result.body.record_version as number) >= 1)
  })

  test('S7 未绑定 session 访问 /config/org → 409 且真库零读（业务行数不变）', async () => {
    const before = await sqlPayload('booking_invite_defaults')
    const result = await call(SETTINGS_PATHS.configOrg, { session: UNBOUND, method: 'GET' })
    assert.equal(result.status, 409, result.text)
    const error = result.body.error as Record<string, unknown>
    assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
    assert.equal(error.reason_code, 'SESSION_NOT_BOUND')
    const after = await sqlPayload('booking_invite_defaults')
    assert.deepEqual(after, before)
  })

  test('S8 readAllSettings 真库只读投影含全部六键，无内部字段', async () => {
    const pool = createPool(cfg)
    try {
      const rows = await withReadOnly(pool, (client) =>
        readAllSettings(client, TENANT, WORKSPACE_SETTING_KEYS))
      assert.deepEqual(rows.map((r) => r.config_key).sort(), [...WORKSPACE_SETTING_KEYS].sort())
      for (const row of rows) {
        assert.deepEqual(Object.keys(row).sort(), ['config_key', 'effective_from', 'value', 'version_no'])
      }
    } finally { await closePool(pool) }
  })
})
