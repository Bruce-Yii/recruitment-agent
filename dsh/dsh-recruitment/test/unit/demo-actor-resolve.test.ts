// exec（DSH ToolRunContext）→ session → alias → actor 的**严格**解析（不连库）。
//
// 守的是 `work/d5/ACTOR-CONTRACT.md` §3 与 `work/d5/w1/CONTEXT.md` §1：
//   1. 读取顺序 `exec.agent.id > exec.agent.sessionId > exec.session_id > exec.headers['x-dsh-session']`；
//   2. 任一来源取不到合法 session / session 未绑定 / alias 无映射 ⇒ `DEMO_ACTOR_UNMAPPED`；
//   3. **绝不回退** `config.actor_id`（本模块根本不接受"默认 actor"这个入参）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createDemoActorIdentity,
  readExecSessionId,
  resolveExecutionActor,
  resolveSessionActor,
} from '../../src/demo-actor/resolve.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION_A = `session-${UUID_A}`
const SESSION_B = `session-${UUID_B}`

const RECRUITER = '11111111-1111-4111-8111-000000000103'
// 2026-11-15 P0-4 扩展的两个 alias（`work/d5/roles/CONTRACT.md` §1）：0002_seed 既有 HUMAN 账号。
const HIRING_MANAGER = '11111111-1111-4111-8111-000000000102'
const APPROVER = '11111111-1111-4111-8111-000000000101'
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000105'

/** 断言一条 `DEMO_ACTOR_UNMAPPED`（可同时钉 reason_code）。 */
function assertUnmapped(error: unknown, reasonCode: string): true {
  assert.ok(error instanceof RecruitmentToolError, `期望 RecruitmentToolError，实际 ${String(error)}`)
  assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
  assert.match(error.message, new RegExp(reasonCode))
  return true
}

test('readExecSessionId：四个来源按冻结优先级命中，前者赢', () => {
  const all = readExecSessionId({
    agent: { id: SESSION_A, sessionId: SESSION_B },
    session_id: `session-${UUID_B}`,
    headers: { 'x-dsh-session': SESSION_B },
  })
  assert.deepEqual(all, { session_id: SESSION_A, source: 'exec.agent.id' })

  assert.deepEqual(
    readExecSessionId({ agent: { sessionId: SESSION_B }, session_id: SESSION_A }),
    { session_id: SESSION_B, source: 'exec.agent.sessionId' },
  )
  assert.deepEqual(
    readExecSessionId({ session_id: SESSION_A }),
    { session_id: SESSION_A, source: 'exec.session_id' },
  )
  assert.deepEqual(
    readExecSessionId({ headers: { 'x-dsh-session': SESSION_A } }),
    { session_id: SESSION_A, source: 'exec.headers.x-dsh-session' },
  )
})

test('readExecSessionId：高优先来源非法时继续往下找（不因坏字段整体失败）', () => {
  assert.deepEqual(
    readExecSessionId({ agent: { id: 'garbage', sessionId: SESSION_B } }),
    { session_id: SESSION_B, source: 'exec.agent.sessionId' },
  )
  assert.deepEqual(
    readExecSessionId({ agent: { id: 'garbage' }, session_id: SESSION_A }),
    { session_id: SESSION_A, source: 'exec.session_id' },
  )
  assert.deepEqual(
    readExecSessionId({ agent: 'garbage', session_id: 42, headers: { 'X-DSH-Session': SESSION_A } }),
    { session_id: SESSION_A, source: 'exec.headers.x-dsh-session' },
  )
})

test('readExecSessionId：裸 UUID 也归一成 session-<uuid>（大小写不敏感）', () => {
  assert.deepEqual(
    readExecSessionId({ agent: { id: UUID_A.toUpperCase() } }),
    { session_id: SESSION_A, source: 'exec.agent.id' },
  )
})

test('readExecSessionId：headers 支持普通对象（大小写不敏感）/ Headers / Map / 键值数组', () => {
  const shapes: unknown[] = [
    { 'x-dsh-session': SESSION_A },
    { 'X-DSH-Session': SESSION_A },
    new Headers({ 'x-dsh-session': SESSION_A }),
    new Map([['x-dsh-session', SESSION_A]]),
    [['X-DSH-Session', SESSION_A]],
  ]
  for (const headers of shapes) {
    assert.deepEqual(
      readExecSessionId({ headers }),
      { session_id: SESSION_A, source: 'exec.headers.x-dsh-session' },
      String(headers),
    )
  }
})

test('readExecSessionId：exec 不是对象 / 四个来源都没有 ⇒ undefined（由调用方 fail-closed）', () => {
  for (const exec of [undefined, null, 'session-x', 42, [], {}, { agent: {} }, { headers: {} }]) {
    assert.equal(readExecSessionId(exec), undefined, String(exec))
  }
})

test('resolveExecutionActor：已绑定 session + 默认映射 ⇒ 正确的 alias/actor/source', () => {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'interviewer_a')
  const actor = resolveExecutionActor({ agent: { id: SESSION_A } }, identity)
  assert.deepEqual(actor, {
    session_id: SESSION_A,
    alias: 'interviewer_a',
    actor_id: INTERVIEWER_A,
    source: 'exec.agent.id',
  })
  assert.equal(Object.hasOwn(actor, 'display_name'), false, '注册表里没有显示名就不带该键')
})

test('resolveExecutionActor：注册表里的 display_name 原样带出（owner 接口增量）', () => {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'interviewer_b', { display_name: '演示-面试官 B' })
  const actor = resolveExecutionActor({ agent: { id: SESSION_A } }, identity)
  assert.equal(actor.display_name, '演示-面试官 B')
  assert.equal(actor.actor_id, INTERVIEWER_B)
})

test('五个 alias 映射到 103/102/101/104/105（A/B 是两个不同 HUMAN；hiring_manager/approver 是 102/101）', () => {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'recruiter')
  identity.registry.bind(SESSION_B, 'interviewer_a')
  const third = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  identity.registry.bind(third, 'interviewer_b')
  // P0-4 新增的两个 alias 走同一条解析链（不特例、不回退 config.actor_id）。
  const fourth = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  identity.registry.bind(fourth, 'hiring_manager')
  const fifth = 'session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  identity.registry.bind(fifth, 'approver')
  assert.equal(resolveExecutionActor({ agent: { id: SESSION_A } }, identity).actor_id, RECRUITER)
  assert.equal(resolveExecutionActor({ agent: { id: SESSION_B } }, identity).actor_id, INTERVIEWER_A)
  assert.equal(resolveExecutionActor({ agent: { id: third } }, identity).actor_id, INTERVIEWER_B)
  assert.equal(resolveExecutionActor({ agent: { id: fourth } }, identity).actor_id, HIRING_MANAGER)
  assert.equal(resolveExecutionActor({ agent: { id: fifth } }, identity).actor_id, APPROVER)
})

test('resolveExecutionActor：exec 里没有任何 session ⇒ DEMO_ACTOR_UNMAPPED(SESSION_SOURCE_MISSING)', () => {
  const { identity } = createDemoActorIdentity()
  for (const exec of [undefined, {}, { agent: {} }, { session_id: 'garbage' }]) {
    assert.throws(
      () => resolveExecutionActor(exec, identity),
      (error: unknown) => assertUnmapped(error, 'SESSION_SOURCE_MISSING'),
      String(exec),
    )
  }
})

test('resolveExecutionActor：session 未绑定 ⇒ DEMO_ACTOR_UNMAPPED(SESSION_NOT_BOUND)，绝不猜 actor', () => {
  const { identity } = createDemoActorIdentity()
  assert.throws(
    () => resolveExecutionActor({ agent: { id: SESSION_A } }, identity),
    (error: unknown) => assertUnmapped(error, 'SESSION_NOT_BOUND'),
  )
})

test('resolveExecutionActor：alias 没有配置映射 ⇒ DEMO_ACTOR_UNMAPPED(ALIAS_NOT_MAPPED)（配置坏 = 拒绝写）', () => {
  const { identity, issues } = createDemoActorIdentity({ interviewer_b: 'not-a-uuid' })
  assert.equal(issues.length, 1, '非法显式映射必须被报出来')
  identity.registry.bind(SESSION_B, 'interviewer_b')
  assert.throws(
    () => resolveExecutionActor({ agent: { id: SESSION_B } }, identity),
    (error: unknown) => assertUnmapped(error, 'ALIAS_NOT_MAPPED'),
  )
})

test('resolveSessionActor：显式 session（Host Remote Action 用）⇒ source=explicit.session_id', () => {
  const { identity } = createDemoActorIdentity()
  identity.registry.bind(SESSION_A, 'recruiter')
  assert.deepEqual(resolveSessionActor(identity, SESSION_A), {
    session_id: SESSION_A,
    alias: 'recruiter',
    actor_id: RECRUITER,
    source: 'explicit.session_id',
  })
  // 裸 UUID / 大写同样归一。
  assert.equal(resolveSessionActor(identity, UUID_A.toUpperCase()).session_id, SESSION_A)

  // display_name 是 owner 的接口增量：显式路径也要带出（能拿到就带上）。
  identity.registry.bind(SESSION_B, 'interviewer_b', { display_name: '演示-面试官 B' })
  assert.equal(resolveSessionActor(identity, SESSION_B).display_name, '演示-面试官 B')
})

test('resolveSessionActor：未绑定 ⇒ SESSION_NOT_BOUND；形态非法 ⇒ SESSION_ID_INVALID（都是 DEMO_ACTOR_UNMAPPED）', () => {
  const { identity } = createDemoActorIdentity()
  assert.throws(
    () => resolveSessionActor(identity, SESSION_A),
    (error: unknown) => assertUnmapped(error, 'SESSION_NOT_BOUND'),
  )
  assert.throws(
    () => resolveSessionActor(identity, 'not-a-session'),
    (error: unknown) => assertUnmapped(error, 'SESSION_ID_INVALID'),
  )
})

test('createDemoActorIdentity：默认零 issues、注册表为空、两个实例互不共享', () => {
  const first = createDemoActorIdentity()
  const second = createDemoActorIdentity()
  assert.deepEqual(first.issues, [])
  assert.equal(first.identity.registry.size, 0)
  first.identity.registry.bind(SESSION_A, 'recruiter')
  assert.equal(first.identity.registry.size, 1)
  assert.equal(second.identity.registry.size, 0, '身份实例之间不共享注册表')
  assert.equal(second.identity.actors.recruiter, RECRUITER)
})
