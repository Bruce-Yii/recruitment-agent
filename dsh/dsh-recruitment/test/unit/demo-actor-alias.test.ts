// Demo Actor 的 alias 封闭集与 alias → actor UUID 映射解析（**不连库**）。
//
// 守的是 `work/d5/roles/CONTRACT.md` §1 的现行口径（2026-11-15 P0-4 把受控 alias 从三个扩到五个；
// 原 `work/d5/ACTOR-CONTRACT.md` §1 的"只有三个"是 W0/W1 冻结口径，被本条扩展取代）：
//   1. 受控 alias 恰好五个且顺序固定：
//      `recruiter` → `hiring_manager` → `approver` → `interviewer_a` → `interviewer_b`；
//      浏览器永远不提交 UUID、也不提交第六个 alias；
//   2. 缺省映射 = 0002_seed 的 103（recruiter）/ 102（HIRING_MANAGER）/ 101（ORG_ADMIN，审批人）
//      + 104（A）/ 105（B）；
//   3. 显式配置**只覆盖给了的 alias**；显式值非法时该 alias **不进 map**（fail-closed），
//      而不是静默回退默认值（配置写坏了必须能被看见）。
//   4. 新增 alias 不改变解析规则：封闭集来源只有 `DEMO_ACTOR_ALIASES`，`Recruiter`/`admin` 仍拒绝。
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
const HIRING_MANAGER = '11111111-1111-4111-8111-000000000102'
const APPROVER = '11111111-1111-4111-8111-000000000101'
const INTERVIEWER_A = '11111111-1111-4111-8111-000000000104'
const INTERVIEWER_B = '11111111-1111-4111-8111-000000000105'

/** P0-4 的五个受控 alias（顺序 = `DEMO_ACTOR_ALIASES` 的顺序）。 */
const EXPECTED_ALIASES = ['recruiter', 'hiring_manager', 'approver', 'interviewer_a', 'interviewer_b'] as const

/** 五个 alias 的缺省映射（大小写形态与 `DEFAULT_DEMO_ACTOR_MAP` 一致：小写键 / 小写 UUID）。 */
const EXPECTED_DEFAULT_MAP = {
  recruiter: RECRUITER,
  hiring_manager: HIRING_MANAGER,
  approver: APPROVER,
  interviewer_a: INTERVIEWER_A,
  interviewer_b: INTERVIEWER_B,
}

test('受控 alias 封闭集恰好五个，顺序稳定（recruiter → hiring_manager → approver → interviewer_a → interviewer_b）', () => {
  assert.deepEqual([...DEMO_ACTOR_ALIASES], [...EXPECTED_ALIASES])
  assert.equal(DEMO_ACTOR_ALIASES.length, 5, 'P0-4 起受控 alias 是五个，不是三个')
})

test('缺省映射 = 0002_seed 的 103 / 102 / 101 / 104 / 105（recruiter / hiring_manager / approver / A / B）', () => {
  assert.deepEqual({ ...DEFAULT_DEMO_ACTOR_MAP }, EXPECTED_DEFAULT_MAP)
  assert.equal(Object.isFrozen(DEFAULT_DEMO_ACTOR_MAP), true, '缺省映射不许被下游改写')
  // 键集合与封闭集必须一一对应（不许漏一个、也不许多一个）。
  assert.deepEqual(Object.keys(DEFAULT_DEMO_ACTOR_MAP).sort(), [...EXPECTED_ALIASES].sort())
  // 新增两个人的 UUID 必须是 HUMAN actor（0002_seed 既有账号），且与 recruiter/interviewer 不重复。
  assert.equal(DEFAULT_DEMO_ACTOR_MAP.hiring_manager, '11111111-1111-4111-8111-000000000102')
  assert.equal(DEFAULT_DEMO_ACTOR_MAP.approver, '11111111-1111-4111-8111-000000000101')
  assert.equal(new Set(Object.values(DEFAULT_DEMO_ACTOR_MAP)).size, 5, '五个 alias 必须映射到五个不同 actor')
})

test('isDemoActorAlias：只认五个小写字面量（大小写不归一、空白不归一）', () => {
  for (const alias of DEMO_ACTOR_ALIASES) assert.equal(isDemoActorAlias(alias), true, alias)
  // 新增的两个 alias 必须真的被封闭集接纳（防止"加了类型没加值"）。
  assert.equal(isDemoActorAlias('hiring_manager'), true)
  assert.equal(isDemoActorAlias('approver'), true)
  for (const bad of ['Recruiter', 'RECRUITER', 'recruiter ', ' recruiter', 'interviewer', 'interviewer_c', 'Hiring_Manager', 'Approver', 'approval', 'admin', 'system', undefined, null, 42, ['recruiter']]) {
    assert.equal(isDemoActorAlias(bad), false, String(bad))
  }
})

test('parseDemoActorAlias：五个合法值原样返回；非法抛 INVALID_ARGS(UNKNOWN_ACTOR_ALIAS) 且 allowed 列出五个', () => {
  for (const alias of EXPECTED_ALIASES) assert.equal(parseDemoActorAlias(alias), alias)
  assert.equal(parseDemoActorAlias('hiring_manager'), 'hiring_manager')
  assert.equal(parseDemoActorAlias('approver'), 'approver')
  for (const bad of ['Recruiter', 'Hiring_Manager', 'Approver', 'interviewer_c', 'admin', '', null, 7]) {
    assert.throws(
      () => parseDemoActorAlias(bad),
      (error: unknown) => {
        assert.ok(error instanceof RecruitmentToolError)
        assert.equal(error.code, 'INVALID_ARGS')
        assert.match(error.message, /UNKNOWN_ACTOR_ALIAS/)
        for (const alias of EXPECTED_ALIASES) {
          assert.match(error.message, new RegExp(`"${alias}"`), `allowed 列表必须含 ${alias}：${error.message}`)
        }
        // 错误详情里的 allowed 数组必须与封闭集逐项一致（顺序也一致）。
        const detail = JSON.parse(error.message.slice('INVALID_ARGS: '.length)) as { allowed: string[] }
        assert.deepEqual(detail.allowed, [...EXPECTED_ALIASES])
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
    assert.deepEqual({ ...map }, EXPECTED_DEFAULT_MAP)
    assert.deepEqual(Object.keys(map).sort(), [...EXPECTED_ALIASES].sort(), '缺省键集合必须是五个 alias')
    assert.equal(Object.isFrozen(map), true)
  }
})

test('resolveDemoActorMap：显式配置只覆盖给了的 alias（其余仍取默认）', () => {
  const override = '22222222-2222-4222-8222-22222222222a'
  const { map, issues } = resolveDemoActorMap({ interviewer_a: override })
  assert.deepEqual(issues, [])
  assert.deepEqual({ ...map }, {
    ...EXPECTED_DEFAULT_MAP,
    interviewer_a: override,
  })
})

test('resolveDemoActorMap：显式覆盖 hiring_manager / approver（新增 alias 与既有 alias 同等生效）', () => {
  const hmOverride = '33333333-3333-4333-8333-33333333333c'
  const approverOverride = '44444444-4444-4444-8444-44444444444d'
  const { map, issues } = resolveDemoActorMap({
    hiring_manager: hmOverride,
    approver: approverOverride,
  })
  assert.deepEqual(issues, [])
  assert.equal(map.hiring_manager, hmOverride)
  assert.equal(map.approver, approverOverride)
  // 未覆盖的三个仍是缺省（显式只覆盖给了的 alias）。
  assert.equal(map.recruiter, RECRUITER)
  assert.equal(map.interviewer_a, INTERVIEWER_A)
  assert.equal(map.interviewer_b, INTERVIEWER_B)
})

test('resolveDemoActorMap：显式 UUID 统一小写（大小写不敏感；DB 里是 text 形态）', () => {
  const upper = '22222222-2222-4222-8222-22222222222B'
  const { map, issues } = resolveDemoActorMap({ interviewer_b: upper })
  assert.deepEqual(issues, [])
  assert.equal(map.interviewer_b, upper.toLowerCase())

  // 新增 alias 同样走同一套归一（不是特例）。
  const upperApprover = '44444444-4444-4444-8444-44444444444D'
  const approver = resolveDemoActorMap({ approver: upperApprover })
  assert.deepEqual(approver.issues, [])
  assert.equal(approver.map.approver, upperApprover.toLowerCase())
})

test('resolveDemoActorMap：显式值非法 ⇒ issue + 该 alias 不进 map（不回退默认、fail-closed）', () => {
  const { map, issues } = resolveDemoActorMap({ interviewer_b: 'not-a-uuid' })
  assert.equal(issues.length, 1)
  assert.match(issues[0] as string, /demo_actor_map\.interviewer_b/)
  assert.equal(Object.hasOwn(map, 'interviewer_b'), false, '非法显式值不许回退默认 105')
  assert.equal(map.recruiter, RECRUITER)
  assert.equal(map.interviewer_a, INTERVIEWER_A)
  // 新增 alias 同样不许回退默认。
  assert.equal(map.hiring_manager, HIRING_MANAGER)

  const brokenHiringManager = resolveDemoActorMap({ hiring_manager: 'not-a-uuid' })
  assert.equal(brokenHiringManager.issues.length, 1)
  assert.match(brokenHiringManager.issues[0] as string, /demo_actor_map\.hiring_manager/)
  assert.equal(Object.hasOwn(brokenHiringManager.map, 'hiring_manager'), false)

  const brokenApprover = resolveDemoActorMap({ approver: 'not-a-uuid' })
  assert.equal(brokenApprover.issues.length, 1)
  assert.match(brokenApprover.issues[0] as string, /demo_actor_map\.approver/)
  assert.equal(Object.hasOwn(brokenApprover.map, 'approver'), false)
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
  assert.deepEqual(Object.keys(map).sort(), [...EXPECTED_ALIASES].sort())
  assert.equal(Object.hasOwn(map, 'admin'), false)
})
