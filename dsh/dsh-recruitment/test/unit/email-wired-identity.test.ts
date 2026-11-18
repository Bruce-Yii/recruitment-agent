// 回归证据：邮件写工具的 "wired identity" 必须是 ToolActorDeps 包装对象。
//
// 背景（owner-typecheck-cleanup 发现的真 bug）：src/index.ts 曾把裸 DemoActorIdentity
// 传给 createWiredEmailFetchTool({ identity })，而 email-fetch.ts 把它原样透传给
// createEmailFetchTool 的 deps.identity，最终 orchestrator.ts:540 读的是
// `deps.identity?.identity` —— 裸对象没有 .identity，于是 resolveWriteActor 收到 undefined，
// 静默回退到 cfg.database.actor_id（legacy 分支），真人 session 绑定被绕过。
//
// 本测试逐层复刻真实装配链（index → email-fetch deps → orchestrator 读取），证明：
//   1) 包装对象（修后的形状）下，写身份来自 session 绑定的 alias，两个不同 session 不同，
//      且绝不等于 legacy actor；
//   2) 反证：旧形状（裸 identity）会让 orchestrator 读到 undefined 并回退 cfg.actor_id。
// 无真库 / 无真网络，只跑身份解析纯函数。
import test from 'node:test'
import assert from 'node:assert/strict'

import { createDemoActorIdentity } from '../../src/demo-actor/index.ts'
import { resolveWriteActor, type ToolActorDeps } from '../../src/demo-actor/tool-actor.ts'

// cfg.database.actor_id 故意选一个与所有 demo alias 都不同的 UUID，才能区分"回退"与"session 身份"。
const LEGACY_ACTOR_ID = '22222222-2222-4222-8222-222222222222'
const SESSION_A = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_B = 'session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function setup(): {
  /** src/index.ts 修后传给 createWiredEmailFetchTool 的 identity 值 */
  wired: ToolActorDeps
  execFor: (session: string) => unknown
} {
  const identity = createDemoActorIdentity().identity
  identity.registry.bind(SESSION_A, 'recruiter')
  identity.registry.bind(SESSION_B, 'interviewer_a')
  return {
    // 与 src/index.ts:1080 修后一致：identity: { identity: actorIdentity }
    wired: { identity },
    execFor: (session: string) => ({ agent: { id: session } }),
  }
}

/** 复刻 orchestrator.ts:540 的读取：FetchAndIngestDeps.identity 是 ToolActorDeps，取它的 .identity。 */
function orchestratorReads(wired: ToolActorDeps) {
  return wired?.identity
}

test('修后形状：写身份来自 session 绑定，两个 alias 不同且不回退 cfg.actor_id', () => {
  const { wired, execFor } = setup()
  const a = resolveWriteActor(execFor(SESSION_A), orchestratorReads(wired), LEGACY_ACTOR_ID)
  const b = resolveWriteActor(execFor(SESSION_B), orchestratorReads(wired), LEGACY_ACTOR_ID)

  assert.equal(a.legacy, false)
  assert.equal(b.legacy, false)
  assert.notEqual(a.actor_id, LEGACY_ACTOR_ID, 'session A 的写身份不得回退到 cfg.actor_id')
  assert.notEqual(b.actor_id, LEGACY_ACTOR_ID, 'session B 的写身份不得回退到 cfg.actor_id')
  assert.notEqual(a.actor_id, b.actor_id, '不同 alias 绑定必须得到不同写身份')
})

test('反证：修前把裸 DemoActorIdentity 传进去，orchestrator 读到 undefined 并回退 legacy', () => {
  const { wired, execFor } = setup()
  // 模拟修前运行时：裸 DemoActorIdentity 被塞进 wired 的位置（TS 会拒绝，这里只做反证）。
  const bareAsWrapper = wired.identity as unknown as ToolActorDeps
  const wrong = resolveWriteActor(execFor(SESSION_A), orchestratorReads(bareAsWrapper), LEGACY_ACTOR_ID)

  assert.equal(wrong.legacy, true, '旧形状无法解析 session 身份，只能回退')
  assert.equal(wrong.actor_id, LEGACY_ACTOR_ID, '回退目标正是 cfg.database.actor_id')
})
