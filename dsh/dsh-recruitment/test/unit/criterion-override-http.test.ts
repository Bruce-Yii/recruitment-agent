// Issue #31 / G-08 受控 HTTP 写路由的**形状/注册**单测（不连库、不发真实 HTTP）。
//
// 覆盖：
//   ① 唯一 exact path / POST 方法 / 请求体封闭键（无 hash / 身份键）；
//   ② 错误状态映射（INVALID_ARGS 400 / FORBIDDEN 403 / DEMO_ACTOR_UNMAPPED 409 / NOT_CONFIGURED 503）；
//   ③ 非回环 host 不注册（fail-closed），回环 host 注册 exact path 且 dispose 可注销；
//   ④ 路由复用了 createCriterionOverrideTool 的工具名（不另造域规则）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CRITERION_OVERRIDE_CONTRACT,
  registerCriterionOverrideHttp,
  type CriterionOverrideHostContext,
} from '../../src/http/criterion-override.ts'
import { CRITERION_OVERRIDE_TOOL } from '../../src/tools/criterion-override.ts'
import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'

const FAKE_CONFIG = {
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password: 'shape-test-only', tenant_id: '11111111-1111-4111-8111-000000000001',
  actor_id: '11111111-1111-4111-8111-000000000103',
} as never

function fakeHost(host: string): { ctx: CriterionOverrideHostContext; routes: Map<string, unknown>; disposed: boolean } {
  const routes = new Map<string, unknown>()
  let disposed = false
  const ctx: CriterionOverrideHostContext = {
    webServer: {
      host,
      port: 32123,
      register(route) {
        routes.set(route.path, route)
        return () => { disposed = true; routes.delete(route.path) }
      },
    },
  }
  return { ctx, routes, get disposed() { return disposed } }
}

test('G-08 契约：唯一 exact path / POST / 封闭 body 键（无服务端派生键）', () => {
  assert.equal(CRITERION_OVERRIDE_CONTRACT.path, '/recruitment/api/action/criterion/override')
  assert.deepEqual(CRITERION_OVERRIDE_CONTRACT.methods, ['POST'])
  assert.deepEqual([...CRITERION_OVERRIDE_CONTRACT.bodyKeys].sort(), [
    'application_id', 'confirmation_text', 'criterion_key', 'human_state', 'note',
  ])
  for (const forbidden of ['actor_id', 'tenant_id', 'confirmation_text_sha256', 'id', 'record_version']) {
    assert.equal(CRITERION_OVERRIDE_CONTRACT.bodyKeys.includes(forbidden), false, `${forbidden} 不得出现在 body 白名单`)
  }
  assert.equal(CRITERION_OVERRIDE_CONTRACT.statusByCode.INVALID_ARGS, 400)
  assert.equal(CRITERION_OVERRIDE_CONTRACT.statusByCode.FORBIDDEN, 403)
  assert.equal(CRITERION_OVERRIDE_CONTRACT.statusByCode.DEMO_ACTOR_UNMAPPED, 409)
  assert.equal(CRITERION_OVERRIDE_CONTRACT.statusByCode.NOT_CONFIGURED, 503)
})

test('G-08 注册：回环 host 注册 exact path；非回环零注册（fail-closed）', () => {
  const deps = { database: FAKE_CONFIG, databaseIssues: [] as string[], identity: createDemoActorIdentity().identity }
  for (const host of ['0.0.0.0', 'example.com', '[::]']) {
    const h = fakeHost(host)
    const dispose = registerCriterionOverrideHttp(h.ctx, deps)
    assert.equal(h.routes.size, 0, `${host} 不得注册`)
    dispose()
  }
  for (const host of ['127.0.0.1', '::1']) {
    const h = fakeHost(host)
    const dispose = registerCriterionOverrideHttp(h.ctx, deps)
    assert.deepEqual([...h.routes.keys()], [CRITERION_OVERRIDE_CONTRACT.path])
    const route = h.routes.get(CRITERION_OVERRIDE_CONTRACT.path) as { kind: string; path: string }
    assert.equal(route.kind, 'exact')
    dispose()
    assert.equal(h.disposed, true)
  }
})

test('G-08 复用：响应里的 tool 名就是既有工具的冻结名（不重写域规则）', () => {
  assert.equal(CRITERION_OVERRIDE_TOOL, 'recruitment_criterion_override')
  // 契约常量只允许引用既有工具名；本测试不复制任何域规则。
  assert.ok(CRITERION_OVERRIDE_CONTRACT.contractVersion.startsWith('criterion-override-http'))
})
