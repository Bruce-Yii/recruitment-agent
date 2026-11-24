// P1-4 补强：PG17 真库跨租户认证会话隔离集成测试。
// 验证：租户 A 签发的有效 rc_auth token，在配置为租户 B 的服务实例下必须返回 null / 401，零跨租户越权读取。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { findAuthSession, insertAuthSession } from '../../src/db/auth.ts'
import { createIsolatedTestDatabase, testDatabaseConfig, type IsolatedTestDatabase } from './db.ts'

let db: IsolatedTestDatabase

before(async () => {
  db = await createIsolatedTestDatabase('cross_tenant_auth')
})

after(async () => {
  if (db !== undefined) await db.drop()
})

test('PG17 跨租户认证隔离：租户 A 的有效 rc_auth 会话绝不能在租户 B 生效', async () => {
  const baseCfg = testDatabaseConfig()
  const tenantA = baseCfg.tenant_id
  const tenantB = '22222222-2222-4222-8222-000000000002'

  // 在隔离库中创建第二个真实组织（Tenant B）
  await db.pool.query(
    `insert into recruitment.organization (id, name, slug) values ($1::uuid, 'Tenant B Org', 'tenant-b-org') on conflict (id) do nothing`,
    [tenantB],
  )

  const cfgA = { ...baseCfg, database: db.name, tenant_id: tenantA }
  const cfgB = { ...baseCfg, database: db.name, tenant_id: tenantB }

  const userRes = await db.pool.query<{ id: string }>(
    `select id::text as id from recruitment.auth_user where tenant_id = $1::uuid and username = 'recruiter' limit 1`,
    [tenantA],
  )
  const userIdA = userRes.rows[0]?.id
  assert.ok(userIdA, '0025 种子账号 recruiter 应存在于 Tenant A')

  const issued = await insertAuthSession(cfgA, userIdA)
  const sessionInA = await findAuthSession(cfgA, issued.token)
  assert.ok(sessionInA !== null, 'Tenant A 自身应能识别自己签发的会话')
  assert.equal(sessionInA?.username, 'recruiter')

  const sessionInB = await findAuthSession(cfgB, issued.token)
  assert.equal(sessionInB, null, 'Tenant A 的会话 token 绝不能在 Tenant B 被识别')
})
