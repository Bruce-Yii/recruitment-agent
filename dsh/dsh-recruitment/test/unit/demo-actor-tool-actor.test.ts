// `resolveWriteActor`：写工具的"用哪个 actor 写"适配层（不连库）。
//
// 两条分支必须泾渭分明：
//   * identity 已装配（产品路径）⇒ 严格解析，失败抛 `DEMO_ACTOR_UNMAPPED`；
//   * identity 未装配（仅既有单测/集成测试兼容）⇒ legacy=true 用 `config.actor_id`，
//     并在实现里写明"这不是产品语义、不得回退"。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoActorIdentity } from '../../src/demo-actor/resolve.ts'
import { resolveWriteActor } from '../../src/demo-actor/tool-actor.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_A = `session-${UUID_A}`
const CONFIG_ACTOR = '11111111-1111-4111-8111-000000000103'
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'

test('identity 未装配（legacy 分支）：原样用 legacyActorId，resolved=null、legacy=true；exec 是什么都不看', () => {
  for (const exec of [undefined, null, {}, { agent: { id: SESSION_A } }]) {
    const resolution = resolveWriteActor(exec, undefined, CONFIG_ACTOR)
    assert.deepEqual(resolution, { actor_id: CONFIG_ACTOR, resolved: null, legacy: true })
  }
})

test('identity 已装配 + 已绑定：严格解析结果（actor_id / resolved / legacy=false）', () => {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'interviewer_a', { display_name: '演示-面试官 A' })
  const resolution = resolveWriteActor({ agent: { id: SESSION_A } }, identity, CONFIG_ACTOR)
  assert.equal(resolution.legacy, false)
  assert.equal(resolution.actor_id, INTERVIEWER_A)
  assert.notEqual(resolution.actor_id, CONFIG_ACTOR, '绝不回退 config.actor_id')
  assert.deepEqual(resolution.resolved, {
    session_id: SESSION_A,
    alias: 'interviewer_a',
    actor_id: INTERVIEWER_A,
    source: 'exec.agent.id',
    display_name: '演示-面试官 A',
  })
})

test('identity 已装配但缺 session / 未绑定 ⇒ 抛 DEMO_ACTOR_UNMAPPED（而不是 legacy 回退）', () => {
  const { identity } = createDemoActorIdentity()
  for (const exec of [undefined, {}, { agent: {} }]) {
    assert.throws(
      () => resolveWriteActor(exec, identity, CONFIG_ACTOR),
      (error: unknown) => {
        assert.ok(error instanceof RecruitmentToolError)
        assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
        assert.match(error.message, /SESSION_SOURCE_MISSING/)
        return true
      },
      String(exec),
    )
  }
  assert.throws(
    () => resolveWriteActor({ agent: { id: SESSION_A } }, identity, CONFIG_ACTOR),
    (error: unknown) => {
      assert.ok(error instanceof RecruitmentToolError)
      assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
      assert.match(error.message, /SESSION_NOT_BOUND/)
      return true
    },
  )
})

test('identity 已装配但 alias 无映射 ⇒ DEMO_ACTOR_UNMAPPED(ALIAS_NOT_MAPPED)，同样不回退', () => {
  const { identity } = createDemoActorIdentity({ recruiter: 'broken' })
  identity.registry.bind(SESSION_A, 'recruiter')
  assert.throws(
    () => resolveWriteActor({ agent: { id: SESSION_A } }, identity, CONFIG_ACTOR),
    (error: unknown) => {
      assert.ok(error instanceof RecruitmentToolError)
      assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
      assert.match(error.message, /ALIAS_NOT_MAPPED/)
      return true
    },
  )
})
