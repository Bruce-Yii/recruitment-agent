// Demo Actor 的 alias 封闭集与 alias → actor UUID 映射解析（**不连库**）。
//
// 守的是 `work/d5/ACTOR-CONTRACT.md` §1 与 `work/d5/w1/CONTEXT.md` §1 的冻结口径：
//   1. 受控 alias 只有三个（`recruiter` / `interviewer_a` / `interviewer_b`），
//      浏览器永远不提交 UUID、也不提交第四个 alias；
//   2. 缺省映射 = 0002_seed 的 103（recruiter）/ 104（A）/ 105（B）；
//   3. 显式配置**只覆盖给了的 alias**；显式值非法时该 alias **不进 map**（fail-closed），
//      而不是静默回退默认值（配置写坏了必须能被看见）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DEMO_ACTOR_MAP,
  DEMO_ACTOR_ALIASES,
  isDemoActorAlias,
  parseDemoActorAlias,
  resolveDemoActorMap,
  type DemoActorMapConfig,
} from '../../src/demo-actor/alias.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'

const RECRUITER = '11111111-1111-4111-8111-000000000103'
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000105'

test('受控 alias 封闭集恰好三个，顺序稳定（recruiter → interviewer_a → interviewer_b）', () => {
  assert.deepEqual([...DEMO_ACTOR_ALIASES], ['recruiter', 'interviewer_a', 'interviewer_b'])
})

test('缺省映射 = 0002_seed 的 103 / 104 / 105（recruiter / A / B）', () => {
  assert.deepEqual({ ...DEFAULT_DEMO_ACTOR_MAP }, {
    recruiter: RECRUITER,
    interviewer_a: INTERVIEWER_A,
    interviewer_b: INTERVIEWER_B,
  })
  assert.equal(Object.isFrozen(DEFAULT_DEMO_ACTOR_MAP), true, '缺省映射不许被下游改写')
})

test('isDemoActorAlias：只认三个小写字面量（大小写不归一、空白不归一）', () => {
  for (const alias of DEMO_ACTOR_ALIASES) assert.equal(isDemoActorAlias(alias), true, alias)
  for (const bad of ['Recruiter', 'RECRUITER', 'recruiter ', ' recruiter', 'interviewer', 'interviewer_c', '', 'admin', 'system', undefined, null, 42, ['recruiter']]) {
    assert.equal(isDemoActorAlias(bad), false, String(bad))
  }
})

test('parseDemoActorAlias：合法原样返回；非法抛 INVALID_ARGS(UNKNOWN_ACTOR_ALIAS) 且列出允许集', () => {
  assert.equal(parseDemoActorAlias('interviewer_b'), 'interviewer_b')
  for (const bad of ['Recruiter', 'interviewer_c', '', null, 7]) {
    assert.throws(
      () => parseDemoActorAlias(bad),
      (error: unknown) => {
        assert.ok(error instanceof RecruitmentToolError)
        assert.equal(error.code, 'INVALID_ARGS')
        assert.match(error.message, /UNKNOWN_ACTOR_ALIAS/)
        assert.match(error.message, /recruiter/)
        assert.match(error.message, /interviewer_a/)
        assert.match(error.message, /interviewer_b/)
        return true
      },
      String(bad),
    )
  }
})

test('resolveDemoActorMap：缺省（undefined / 空对象）取 DEFAULT_DEMO_ACTOR_MAP，零 issues', () => {
  for (const config of [undefined, {} as DemoActorMapConfig]) {
    const { map, issues } = resolveDemoActorMap(config)
    assert.deepEqual(issues, [])
    assert.deepEqual({ ...map }, {
      recruiter: RECRUITER,
      interviewer_a: INTERVIEWER_A,
      interviewer_b: INTERVIEWER_B,
    })
    assert.equal(Object.isFrozen(map), true)
  }
})

test('resolveDemoActorMap：显式配置只覆盖给了的 alias（其余仍取默认）', () => {
  const override = '22222222-2222-4222-8222-22222222222a'
  const { map, issues } = resolveDemoActorMap({ interviewer_a: override })
  assert.deepEqual(issues, [])
  assert.deepEqual({ ...map }, {
    recruiter: RECRUITER,
    interviewer_a: override,
    interviewer_b: INTERVIEWER_B,
  })
})

test('resolveDemoActorMap：显式 UUID 统一小写（大小写不敏感；DB 里是 text 形态）', () => {
  const upper = '22222222-2222-4222-8222-22222222222B'
  const { map, issues } = resolveDemoActorMap({ interviewer_b: upper })
  assert.deepEqual(issues, [])
  assert.equal(map.interviewer_b, upper.toLowerCase())
})

test('resolveDemoActorMap：显式值非法 ⇒ issue + 该 alias 不进 map（不回退默认、fail-closed）', () => {
  const { map, issues } = resolveDemoActorMap({ interviewer_b: 'not-a-uuid' })
  assert.equal(issues.length, 1)
  assert.match(issues[0] as string, /demo_actor_map\.interviewer_b/)
  assert.equal(Object.hasOwn(map, 'interviewer_b'), false, '非法显式值不许回退默认 105')
  assert.equal(map.recruiter, RECRUITER)
  assert.equal(map.interviewer_a, INTERVIEWER_A)
})

test('resolveDemoActorMap：空串 / 非字符串分量 ⇒ issue + 该 alias 不进 map', () => {
  const empty = resolveDemoActorMap({ recruiter: '   ' })
  assert.equal(empty.issues.length, 1)
  assert.equal(Object.hasOwn(empty.map, 'recruiter'), false)

  // YAML/环境变量可能给出非字符串：运行时按 unknown 校验（TS 类型只是声明）。
  const nonString = resolveDemoActorMap({ recruiter: 42 as unknown as string })
  assert.equal(nonString.issues.length, 1)
  assert.match(nonString.issues[0] as string, /UUID string/)
  assert.equal(Object.hasOwn(nonString.map, 'recruiter'), false)
})

test('resolveDemoActorMap：值首尾空白会被裁掉（配置排版容错），非法字符仍拒绝', () => {
  const padded = `  ${INTERVIEWER_A}  `
  const ok = resolveDemoActorMap({ interviewer_a: padded })
  assert.deepEqual(ok.issues, [])
  assert.equal(ok.map.interviewer_a, INTERVIEWER_A)

  const bad = resolveDemoActorMap({ interviewer_a: `  ${INTERVIEWER_A}x  ` })
  assert.equal(bad.issues.length, 1)
  assert.equal(Object.hasOwn(bad.map, 'interviewer_a'), false)
})

test('resolveDemoActorMap：配置里的未知键被忽略（不静默改名、不混进 map）', () => {
  const raw = { admin: RECRUITER } as unknown as DemoActorMapConfig
  const { map, issues } = resolveDemoActorMap(raw)
  assert.deepEqual(issues, [])
  assert.deepEqual(Object.keys(map).sort(), ['interviewer_a', 'interviewer_b', 'recruiter'])
  assert.equal(Object.hasOwn(map, 'admin'), false)
})
