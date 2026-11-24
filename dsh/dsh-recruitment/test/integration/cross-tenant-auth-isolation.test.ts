// P1-4 补强：PG17 真库跨租户认证会话隔离集成测试。
// 验证：租户 A 签发的有效 rc_auth token 与账号，在配置为租户 B 的服务实例下必须完全隔离（读/查/撤销均不得越权）。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'

import { findAuthSession, findAuthUser, insertAuthSession, revokeAuthSession } from '../../src/db/auth.ts'
import { createIsolatedTestDatabase, testDatabaseConfig, type IsolatedTestDatabase } from './db.ts'

let db: IsolatedTestDatabase

before(async () => {
  db = await createIsolatedTestDatabase('cross_tenant_auth')
})

after(async () => {
  if (db !== undefined) await db.drop()
})

test('PG17 跨租户认证隔离：租户 A 的有效 rc_auth 会话与账号绝不能在租户 B 生效或被撤销', async () => {
  const baseCfg = testDatabaseConfig()
  const tenantA = baseCfg.tenant_id
  const tenantB = '22222222-2222-4222-8222-000000000002'

  const cfgA = { ...baseCfg, database: db.name, tenant_id: tenantA }
  const cfgB = { ...baseCfg, database: db.name, tenant_id: tenantB }

  const userA = await findAuthUser(cfgA, 'recruiter')
  assert.ok(userA !== null, '0025 种子账号 recruiter 应存在于 Tenant A')
  assert.equal(await findAuthUser(cfgB, 'recruiter'), null, 'Tenant B 绝不能查到 Tenant A 的账号')

  const issued = await insertAuthSession(cfgA, userA)
  const sessionInA = await findAuthSession(cfgA, issued.token)
  assert.ok(sessionInA !== null, 'Tenant A 自身应能识别自己签发的会话')
  assert.equal(sessionInA.username, 'recruiter')

  const sessionInB = await findAuthSession(cfgB, issued.token)
  assert.equal(sessionInB, null, 'Tenant A 的会话 token 绝不能在 Tenant B 被识别')

  // 跨租户撤销隔离：Tenant B 尝试撤销同一 token，不得影响 Tenant A 的有效会话
  await revokeAuthSession(cfgB, issued.token)
  const sessionInAAfterBRevoke = await findAuthSession(cfgA, issued.token)
  assert.ok(sessionInAAfterBRevoke !== null, 'Tenant B 的撤销请求绝不能吊销 Tenant A 的有效会话')
})
