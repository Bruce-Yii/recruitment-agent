// `resolveDatabaseConfig`：配置解析的三条硬约束（不连库）。
//
// 这一层值得单测的原因：它是"密码只从环境变量读"与"配置不全不假装能用"的唯一实现点。
// 一旦这里静默放宽（比如给个默认密码、或把 port 默认成错误的库），S6 会往
// 一个不存在的库写、S7 会对着空结果出 PASS —— 两者都不会报错。
import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveDatabaseConfig, isUuidText } from '../../src/db/pool.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR = '11111111-1111-4111-8111-000000000103'

/** 一份完整配置（密码在环境变量里）。 */
function fullConfig() {
  return {
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    database: 'ra_s6s7',
    tenant_id: TENANT,
    actor_id: ACTOR,
  }
}

test('完整配置 + 环境变量有密码 → resolved 非空，密码来自环境变量', () => {
  const { resolved, issues } = resolveDatabaseConfig(fullConfig(), { RECRUITMENT_DB_PASSWORD: 's3cret' })
  assert.deepEqual(issues, [])
  assert.ok(resolved)
  assert.equal(resolved.password, 's3cret')
  assert.equal(resolved.password_env, 'RECRUITMENT_DB_PASSWORD')
  assert.equal(resolved.statement_timeout_ms, 15000)
  assert.equal(resolved.connect_timeout_ms, 10000)
  assert.equal(resolved.max, 2)
})

test('密码缺失 → resolved=null，issue 只提变量名、绝不回显密码值', () => {
  const { resolved, issues } = resolveDatabaseConfig(fullConfig(), {})
  assert.equal(resolved, null)
  assert.equal(issues.length, 1)
  assert.match(issues[0] ?? '', /RECRUITMENT_DB_PASSWORD/)
})

test('password_env 可改名；改名后原变量不再被读', () => {
  const config = { ...fullConfig(), password_env: 'RA_PW' }
  assert.ok(resolveDatabaseConfig(config, { RA_PW: 'x' }).resolved)
  const missing = resolveDatabaseConfig(config, { RECRUITMENT_DB_PASSWORD: 'x' })
  assert.equal(missing.resolved, null)
  assert.match(missing.issues[0] ?? '', /RA_PW/)
})

test('缺字段逐条列出（一次性给全，不是遇到第一条就返回）', () => {
  const { resolved, issues } = resolveDatabaseConfig({}, {})
  assert.equal(resolved, null)
  assert.equal(issues.length, 6)
  assert.ok(issues.some((i) => i.includes('host')))
  assert.ok(issues.some((i) => i.includes('user')))
  assert.ok(issues.some((i) => i.includes('database')))
  assert.ok(issues.some((i) => i.includes('tenant_id')))
  assert.ok(issues.some((i) => i.includes('actor_id')))
})

test('tenant_id / actor_id 必须是 UUID（模型不可自报，配置写错必须显式失败）', () => {
  const { resolved, issues } = resolveDatabaseConfig(
    { ...fullConfig(), tenant_id: 'demo-tenant', actor_id: 'job_0001' },
    { RECRUITMENT_DB_PASSWORD: 'x' },
  )
  assert.equal(resolved, null)
  assert.equal(issues.filter((i) => i.includes('must be a UUID')).length, 2)
})

test('port 越界被拒；缺省给 5432', () => {
  const bad = resolveDatabaseConfig({ ...fullConfig(), port: 70000 }, { RECRUITMENT_DB_PASSWORD: 'x' })
  assert.equal(bad.resolved, null)
  assert.match(bad.issues.join(' '), /port/)
  const noPort = { ...fullConfig() }
  delete noPort.port
  const { resolved } = resolveDatabaseConfig(noPort, { RECRUITMENT_DB_PASSWORD: 'x' })
  assert.equal(resolved?.port, 5432)
})

test('配置里的字符串空白会被 trim，不会变成"看起来有值"的空串', () => {
  const { resolved } = resolveDatabaseConfig(
    { ...fullConfig(), host: '  ', user: ' postgres ' },
    { RECRUITMENT_DB_PASSWORD: 'x' },
  )
  assert.equal(resolved, null)
  const ok = resolveDatabaseConfig({ ...fullConfig(), user: ' postgres ' }, { RECRUITMENT_DB_PASSWORD: 'x' })
  assert.equal(ok.resolved?.user, 'postgres')
})

test('isUuidText：只认 8-4-4-4-12', () => {
  assert.equal(isUuidText(TENANT), true)
  assert.equal(isUuidText('job_0001'), false)
  assert.equal(isUuidText('11111111-1111-4111-8111-00000000000'), false)
  assert.equal(isUuidText(undefined), false)
})
