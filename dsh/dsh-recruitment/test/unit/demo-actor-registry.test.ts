// session → alias 进程内注册表（**不连库、不落盘**）。
//
// 守的是 `work/d5/w1/CONTEXT.md` §1 的冻结口径：
//   * `normalizeSessionId` 接受 `session-<uuid>` 或裸 `<uuid>`（大小写不敏感），
//     统一成 `session-<lowercase uuid>`；其它形态一律 `null`；
//   * 注册表**有界**（默认 1000，超出丢最旧）、**幂等 bind**（同 session+同 alias 不刷新 bound_at）、
//     `require` 未绑定 ⇒ `DEMO_ACTOR_UNMAPPED`；
//   * `display_name` 是可选快照（owner-d5-w1 2026-11-15 的接口增量）：bind 第三参数写入、
//     get/require/list 原样返回。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEMO_SESSION_HEADER,
  SessionActorRegistry,
  normalizeSessionId,
} from '../../src/demo-actor/session-registry.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION_A = `session-${UUID_A}`
const SESSION_B = `session-${UUID_B}`
/** 钉死时钟：`bound_at` 必须可预测（否则断言只能靠正则）。 */
const NOW_MS = Date.parse('2026-11-15T00:00:00.000Z')
const NOW_ISO = new Date(NOW_MS).toISOString()

test('DEMO_SESSION_HEADER 固定为 x-dsh-session（HTTP 层与 exec 兜底共用同一常量）', () => {
  assert.equal(DEMO_SESSION_HEADER, 'x-dsh-session')
})

test('normalizeSessionId：接受 session-<uuid> / 裸 UUID，大小写不敏感，输出统一小写', () => {
  assert.equal(normalizeSessionId(SESSION_A), SESSION_A)
  assert.equal(normalizeSessionId(UUID_A), SESSION_A, '裸 UUID 补 session- 前缀')
  assert.equal(normalizeSessionId(`SESSION-${UUID_A.toUpperCase()}`), SESSION_A)
  assert.equal(normalizeSessionId(UUID_A.toUpperCase()), SESSION_A)
  assert.equal(normalizeSessionId(`  ${SESSION_A}  `), SESSION_A, '首尾空白裁剪')
})

test('normalizeSessionId：非法形态一律 null（不猜、不补前缀）', () => {
  for (const bad of [
    '',
    '   ',
    'session-',
    'session',
    'session-not-a-uuid',
    `${SESSION_A}x`,
    `session-session-${UUID_A}`,
    '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaaa',
    undefined,
    null,
    42,
    { id: UUID_A },
  ]) {
    assert.equal(normalizeSessionId(bad), null, String(bad))
  }
})

test('bind：非法 session / 非法 alias 抛 INVALID_ARGS；合法绑定返回规范形态与 ISO bound_at', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  const binding = registry.bind(JSON.parse(JSON.stringify(SESSION_A)) as string, 'interviewer_a')
  assert.deepEqual(binding, {
    session_id: SESSION_A,
    alias: 'interviewer_a',
    bound_at: NOW_ISO,
  })
  assert.equal(registry.size, 1)

  assert.throws(() => registry.bind('session-nope', 'recruiter'), (error: unknown) => {
    assert.ok(error instanceof RecruitmentToolError)
    assert.equal(error.code, 'INVALID_ARGS')
    assert.match(error.message, /SESSION_ID_INVALID/)
    return true
  })
  assert.throws(() => registry.bind(SESSION_A, 'admin' as never), (error: unknown) => {
    assert.ok(error instanceof RecruitmentToolError)
    assert.equal(error.code, 'INVALID_ARGS')
    assert.match(error.message, /UNKNOWN_ACTOR_ALIAS/)
    return true
  })
  assert.equal(registry.size, 1, '失败的 bind 一行都不留')
})

test('get：任意输入形态先归一（裸 UUID / 大写 / 空白都能命中）；未绑定返回 undefined', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  registry.bind(SESSION_A, 'recruiter')
  assert.equal(registry.get(SESSION_A)?.alias, 'recruiter')
  assert.equal(registry.get(UUID_A)?.session_id, SESSION_A)
  assert.equal(registry.get(`  ${UUID_A.toUpperCase()}  `)?.alias, 'recruiter')
  assert.equal(registry.get(SESSION_B), undefined)
  assert.equal(registry.get('nope'), undefined)
})

test('bind 幂等：同 session + 同 alias 重复绑定不刷新 bound_at、不新增条目', () => {
  let now = NOW_MS
  const registry = new SessionActorRegistry({ now: () => now })
  const first = registry.bind(SESSION_A, 'interviewer_a')
  now += 60_000
  const second = registry.bind(UUID_A.toUpperCase(), 'interviewer_a')
  assert.equal(second, first, '幂等 bind 返回同一个绑定对象')
  assert.equal(second.bound_at, NOW_ISO, 'bound_at 不被第二次 PUT 刷新')
  assert.equal(registry.size, 1)
})

test('bind 重绑：换 alias ⇒ 覆盖旧绑定、bound_at 刷新、条目仍只有一条', () => {
  let now = NOW_MS
  const registry = new SessionActorRegistry({ now: () => now })
  registry.bind(SESSION_A, 'recruiter')
  now += 5_000
  const rebound = registry.bind(SESSION_A, 'interviewer_b')
  assert.equal(rebound.alias, 'interviewer_b')
  assert.equal(rebound.bound_at, new Date(NOW_MS + 5_000).toISOString())
  assert.equal(registry.size, 1)
  assert.equal(registry.get(SESSION_A)?.alias, 'interviewer_b')
})

test('require：未绑定 / 形态非法 ⇒ DEMO_ACTOR_UNMAPPED（fail-closed，不回退任何默认 actor）', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  assert.throws(() => registry.require(SESSION_A), (error: unknown) => {
    assert.ok(error instanceof RecruitmentToolError)
    assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
    assert.match(error.message, /SESSION_NOT_BOUND/)
    return true
  })
  assert.throws(() => registry.require('not-a-session'), (error: unknown) => {
    assert.ok(error instanceof RecruitmentToolError)
    assert.equal(error.code, 'DEMO_ACTOR_UNMAPPED')
    assert.match(error.message, /SESSION_ID_INVALID/)
    return true
  })
})

test('unbind / clear / list / size：解除与清空，list 按绑定先后（旧 → 新）给副本', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  assert.equal(registry.unbind(SESSION_A), false, '未绑定 unbind 返回 false')
  registry.bind(SESSION_A, 'recruiter')
  registry.bind(SESSION_B, 'interviewer_a')
  assert.equal(registry.size, 2)
  assert.deepEqual(registry.list().map((binding) => binding.alias), ['recruiter', 'interviewer_a'])
  assert.equal(registry.unbind(UUID_B), true, '裸 UUID 也能解除')
  assert.equal(registry.unbind(UUID_B), false, '重复解除返回 false')
  assert.equal(registry.size, 1)
  assert.deepEqual(registry.list().map((binding) => binding.session_id), [SESSION_A])
  registry.clear()
  assert.equal(registry.size, 0)
  assert.deepEqual(registry.list(), [])
})

test('有界：maxEntries=2 时绑第 3 个 session 丢最旧；重绑算"最新"', () => {
  const registry = new SessionActorRegistry({ maxEntries: 2, now: () => NOW_MS })
  const a = `session-${UUID_A}`
  const b = `session-${UUID_B}`
  const c = 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  registry.bind(a, 'recruiter')
  registry.bind(b, 'interviewer_a')
  registry.bind(c, 'interviewer_b')
  assert.equal(registry.size, 2)
  assert.equal(registry.get(a), undefined, '最旧的 a 被淘汰')
  assert.ok(registry.get(b) !== undefined)
  assert.ok(registry.get(c) !== undefined)

  // 重绑 b（换 alias）⇒ b 变成最新；再绑 d ⇒ 淘汰不再是 b 的旧位置以外的"最旧"。
  registry.bind(b, 'recruiter')
  const d = 'session-dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  registry.bind(d, 'recruiter')
  assert.equal(registry.size, 2)
  assert.ok(registry.get(b) !== undefined, '重绑后 b 被移到队尾，不再是最旧')
  assert.equal(registry.get(c), undefined, '原来的 c 变成最旧被淘汰')
})

test('有界：缺省上限 1000（第 1001 个淘汰最旧）', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  const sessionAt = (index: number): string =>
    `session-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  for (let index = 0; index <= 1000; index += 1) registry.bind(sessionAt(index), 'recruiter')
  assert.equal(registry.size, 1000)
  assert.equal(registry.get(sessionAt(0)), undefined, '最旧的一条被淘汰')
  assert.ok(registry.get(sessionAt(1000)) !== undefined)
})

test('非法 maxEntries 取默认上限（配置写坏不影响注册表构造）', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    const registry = new SessionActorRegistry({ maxEntries: bad, now: () => NOW_MS })
    for (let index = 0; index <= 1000; index += 1) {
      registry.bind(`session-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'recruiter')
    }
    assert.equal(registry.size, 1000, String(bad))
  }
})

test('display_name（owner 接口增量）：bind 第三参数写入 / 覆盖；缺省省略；get/require/list 原样返回', () => {
  const registry = new SessionActorRegistry({ now: () => NOW_MS })
  const withName = registry.bind(SESSION_A, 'interviewer_a', { display_name: '演示-面试官 A' })
  assert.equal(withName.display_name, '演示-面试官 A')
  assert.equal(registry.get(SESSION_A)?.display_name, '演示-面试官 A')
  assert.equal(registry.require(SESSION_A).display_name, '演示-面试官 A')
  assert.equal(registry.list()[0]?.display_name, '演示-面试官 A')

  // 同 alias 不传 display_name ⇒ 幂等返回旧绑定（快照保留）。
  assert.equal(registry.bind(SESSION_A, 'interviewer_a').display_name, '演示-面试官 A')

  // 同 alias 传新 display_name ⇒ 覆盖旧值。
  const renamed = registry.bind(SESSION_A, 'interviewer_a', { display_name: '演示-面试官 A（改名）' })
  assert.equal(renamed.display_name, '演示-面试官 A（改名）')
  assert.equal(registry.get(SESSION_A)?.display_name, '演示-面试官 A（改名）')

  // 换 alias 且不传 display_name ⇒ 旧显示名不许跟着串到新身份上（省略该键）。
  const rebound = registry.bind(SESSION_A, 'interviewer_b')
  assert.equal(Object.hasOwn(rebound, 'display_name'), false)

  // 空白 display_name 视为"没给"。
  const blank = registry.bind(SESSION_B, 'recruiter', { display_name: '   ' })
  assert.equal(Object.hasOwn(blank, 'display_name'), false)
})
