// D5 P0-4 角色 → 视图矩阵的单元守卫（**不连库、不碰浏览器**）。
//
// 守的是 `work/d5/roles/CONTRACT.md` §1 矩阵与 §2 冻结接口：
//   1. 5 个 alias 的 role/label/defaultView/allowedViews/写授权逐条相等；
//   2. 负例：面试官看不到 recruiting/hiring/approvals，招聘负责人看不到 recruiting（HR 专属）；
//   3. alias 切换的视图落点（仍允许则保持、否则回落默认、未知 alias 不猜）；
//   4. 写授权只在 recruiter；阻断原因是可展示的精确人话（含服务端错误码与切换指引）；
//   5. 机器守卫：`role-views.ts` 是纯函数层——不含网络 / 存储 / 框架 / 浏览器全局调用；
//   6. 选择器选项顺序稳定、label 非空且与档案同源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEMO_ACTOR_OPTIONS,
  DEMO_ACTOR_PROFILES,
  allowedViewsFor,
  canSeeView,
  defaultViewFor,
  isDemoActorAliasValue,
  isWriteAuthorizedAlias,
  profileForAlias,
  resolveViewForAlias,
  viewLabel,
  writeBlockedReasonFor,
  type DemoActorAlias,
  type DemoActorRole,
  type WorkViewKey,
} from '../../src/client/shell/role-views.ts'

const ALL_VIEWS: readonly WorkViewKey[] = ['recruiting', 'interviewer', 'hiring', 'approvals']
const ALL_ALIASES: readonly DemoActorAlias[] = ['recruiter', 'hiring_manager', 'approver', 'interviewer_a', 'interviewer_b']

/** `work/d5/roles/CONTRACT.md` §1 矩阵的逐条投影（测试侧独立写死，不从实现反推）。 */
interface ExpectedProfile {
  readonly alias: DemoActorAlias
  readonly role: DemoActorRole
  readonly label: string
  readonly defaultView: WorkViewKey
  readonly allowedViews: readonly WorkViewKey[]
  readonly canExecuteWriteActions: boolean
}

const EXPECTED: readonly ExpectedProfile[] = [
  {
    alias: 'recruiter',
    role: 'HR_SPECIALIST',
    label: 'Recruiter（HR 专员）',
    defaultView: 'recruiting',
    allowedViews: ['recruiting', 'interviewer', 'hiring', 'approvals'],
    canExecuteWriteActions: true,
  },
  {
    alias: 'hiring_manager',
    role: 'HIRING_MANAGER',
    label: '招聘负责人（Hiring Manager）',
    defaultView: 'hiring',
    allowedViews: ['hiring', 'approvals'],
    canExecuteWriteActions: false,
  },
  {
    alias: 'approver',
    role: 'ORG_ADMIN',
    label: '审批人（企业管理员）',
    defaultView: 'approvals',
    allowedViews: ['approvals', 'hiring'],
    canExecuteWriteActions: false,
  },
  {
    alias: 'interviewer_a',
    role: 'INTERVIEWER',
    label: 'Interviewer A',
    defaultView: 'interviewer',
    allowedViews: ['interviewer'],
    canExecuteWriteActions: false,
  },
  {
    alias: 'interviewer_b',
    role: 'INTERVIEWER',
    label: 'Interviewer B',
    defaultView: 'interviewer',
    allowedViews: ['interviewer'],
    canExecuteWriteActions: false,
  },
]

/** 已知 alias 的期望档案（找不到就是测试数据写错了）。 */
function expected(alias: DemoActorAlias): ExpectedProfile {
  const found = EXPECTED.find((row) => row.alias === alias)
  assert.ok(found !== undefined, `EXPECTED 缺 ${alias}`)
  return found
}

const SOURCE_URL = new URL('../../src/client/shell/role-views.ts', import.meta.url)

test('§1 矩阵逐条相等：5 个 alias 的 role/label/defaultView/allowedViews/写授权', () => {
  assert.deepEqual(Object.keys(DEMO_ACTOR_PROFILES).sort(), [...ALL_ALIASES].sort(), '档案键必须恰好是 5 个受控 alias')

  for (const row of EXPECTED) {
    const profile = DEMO_ACTOR_PROFILES[row.alias]
    assert.equal(profile.alias, row.alias, `${row.alias}: alias 自描述`)
    assert.equal(profile.role, row.role, `${row.alias}: DB 角色`)
    assert.equal(profile.label, row.label, `${row.alias}: 选择器文案`)
    assert.equal(profile.roleLabel.startsWith(`${row.role} · `), true, `${row.alias}: roleLabel 含角色码`)
    assert.ok(profile.roleLabel.length > `${row.role} · `.length, `${row.alias}: roleLabel 含中文角色`)
    assert.equal(profile.defaultView, row.defaultView, `${row.alias}: 默认视图`)
    assert.deepEqual([...profile.allowedViews], [...row.allowedViews], `${row.alias}: 可见视图（顺序即 tab 顺序）`)
    assert.equal(profile.canExecuteWriteActions, row.canExecuteWriteActions, `${row.alias}: 写授权`)

    // 三个便捷函数必须与档案同口径，不许各写一套。
    assert.equal(defaultViewFor(row.alias), row.defaultView, `${row.alias}: defaultViewFor`)
    assert.deepEqual([...allowedViewsFor(row.alias)], [...row.allowedViews], `${row.alias}: allowedViewsFor`)
    assert.equal(profileForAlias(row.alias), profile, `${row.alias}: profileForAlias 返回同一档案`)
  }

  // 写阻断原因：有授权为空，无授权必须非空且写明服务端错误码。
  assert.equal(DEMO_ACTOR_PROFILES.recruiter.writeBlockedReason, '')
  for (const alias of ['hiring_manager', 'approver', 'interviewer_a', 'interviewer_b'] as const) {
    const reason = DEMO_ACTOR_PROFILES[alias].writeBlockedReason
    assert.ok(reason.length > 0, `${alias}: 非授权 alias 的 writeBlockedReason 不许为空`)
    assert.ok(reason.includes('ACTOR_NOT_AUTHORIZED'), `${alias}: 必须写明服务端错误码 ACTOR_NOT_AUTHORIZED`)
    assert.ok(reason.includes('零写入'), `${alias}: 必须写明零写入`)
    assert.ok(reason.includes('Recruiter'), `${alias}: 必须给出显式切换指引`)
  }
  // 面试官口径：本人面评走 W1 scorecard submit（与招聘写动作区分开）。
  for (const alias of ['interviewer_a', 'interviewer_b'] as const) {
    const reason = DEMO_ACTOR_PROFILES[alias].writeBlockedReason
    assert.match(reason, /Scorecard/)
    assert.match(reason, /W1 scorecard submit/)
  }
})

test('§1 负例：面试官看不到 recruiting/hiring/approvals，招聘负责人看不到 recruiting', () => {
  for (const alias of ['interviewer_a', 'interviewer_b'] as const) {
    for (const view of ['recruiting', 'hiring', 'approvals'] as const) {
      assert.equal(canSeeView(alias, view), false, `${alias} 不许看到 ${view}`)
    }
    assert.equal(canSeeView(alias, 'interviewer'), true, `${alias} 必须看到 interviewer`)
  }
  assert.equal(canSeeView('hiring_manager', 'recruiting'), false, '招聘负责人看不到 HR 专属的招聘工作台')
  assert.equal(canSeeView('hiring_manager', 'hiring'), true)
  assert.equal(canSeeView('hiring_manager', 'approvals'), true)
  assert.equal(canSeeView('approver', 'recruiting'), false)
  assert.equal(canSeeView('approver', 'interviewer'), false)
  assert.equal(canSeeView('approver', 'approvals'), true)
  assert.equal(canSeeView('approver', 'hiring'), true)
  // recruiter 是唯一全视图身份。
  for (const view of ALL_VIEWS) assert.equal(canSeeView('recruiter', view), true, `recruiter 应能看到 ${view}`)

  // 全矩阵一致性：canSeeView 必须等价于 allowedViewsFor（含未知 alias）。
  for (const alias of [...ALL_ALIASES, 'ghost', '', 'Recruiter', null, undefined]) {
    const allowed = alias === null || alias === undefined || !isDemoActorAliasValue(alias) ? [] : expected(alias).allowedViews
    for (const view of ALL_VIEWS) {
      assert.equal(canSeeView(alias, view), allowed.includes(view), `${String(alias)} / ${view}`)
    }
  }
})

test('未知 / null / undefined alias：profileForAlias → null、allowedViewsFor → []、defaultViewFor → null（不猜）', () => {
  for (const unknown of ['ghost', '', 'Recruiter', 'RECRUITER', 'recruiter ', ' recruiter', 'interviewer', 'admin', null, undefined]) {
    assert.equal(profileForAlias(unknown), null, `profileForAlias(${String(unknown)})`)
    assert.deepEqual([...allowedViewsFor(unknown)], [], `allowedViewsFor(${String(unknown)})`)
    assert.equal(defaultViewFor(unknown), null, `defaultViewFor(${String(unknown)})`)
    assert.equal(isWriteAuthorizedAlias(unknown), false, `isWriteAuthorizedAlias(${String(unknown)})`)
    for (const view of ALL_VIEWS) assert.equal(canSeeView(unknown, view), false, `canSeeView(${String(unknown)}, ${view})`)
  }
  // alias 封闭集判定：区分大小写、不裁剪空白、不认非字符串。
  for (const alias of ALL_ALIASES) assert.equal(isDemoActorAliasValue(alias), true, alias)
  for (const bad of ['Recruiter', 'APPROVER', 'approver ', '', undefined, null, 42, ['recruiter'], {}]) {
    assert.equal(isDemoActorAliasValue(bad), false, String(bad))
  }
})

test('viewLabel：4 个视图的界面文案逐字一致', () => {
  assert.deepEqual(
    ALL_VIEWS.map((view) => [view, viewLabel(view)]),
    [
      ['recruiting', '招聘工作台'],
      ['interviewer', '面试官工作台'],
      ['hiring', '招聘负责人工作台'],
      ['approvals', '审批工作台'],
    ],
  )
  // 运行期越界视图键不编造文案（不抛错、返回空串）。
  assert.equal(viewLabel('bogus' as WorkViewKey), '')
})

test('resolveViewForAlias：仍允许则保持、不被允许回落默认、未知 alias → null', () => {
  // 仍允许 → 保持（含"从 approver 切 recruiter"这种跨身份但当前视图仍授权的场景）。
  assert.equal(resolveViewForAlias('hiring', 'hiring_manager'), 'hiring')
  assert.equal(resolveViewForAlias('approvals', 'approver'), 'approvals')
  assert.equal(resolveViewForAlias('approvals', 'recruiter'), 'approvals')
  assert.equal(resolveViewForAlias('interviewer', 'recruiter'), 'interviewer')

  // 不被允许 → 回落该 alias 的默认视图。
  assert.equal(resolveViewForAlias('recruiting', 'interviewer_a'), 'interviewer')
  assert.equal(resolveViewForAlias('recruiting', 'interviewer_b'), 'interviewer')
  assert.equal(resolveViewForAlias('interviewer', 'approver'), 'approvals')
  assert.equal(resolveViewForAlias('interviewer', 'hiring_manager'), 'hiring')
  assert.equal(resolveViewForAlias('recruiting', 'approver'), 'approvals')
  assert.equal(resolveViewForAlias('recruiting', 'hiring_manager'), 'hiring')

  // 当前为空 → 默认视图。
  assert.equal(resolveViewForAlias(null, 'recruiter'), 'recruiting')
  assert.equal(resolveViewForAlias(null, 'hiring_manager'), 'hiring')
  assert.equal(resolveViewForAlias(null, 'approver'), 'approvals')
  assert.equal(resolveViewForAlias(null, 'interviewer_a'), 'interviewer')

  // 未知 alias → null（不猜任何视图）。
  assert.equal(resolveViewForAlias(null, 'ghost'), null)
  assert.equal(resolveViewForAlias('hiring', null), null)
  assert.equal(resolveViewForAlias('hiring', undefined), null)
  assert.equal(resolveViewForAlias('hiring', ''), null)

  // 运行期越界的当前视图不被当成"允许"（回落默认）。
  assert.equal(resolveViewForAlias('bogus' as WorkViewKey, 'recruiter'), 'recruiting')
})

test('写授权：仅 recruiter 可执行；阻断原因含 alias / 动作名 / ACTOR_NOT_AUTHORIZED / Recruiter', () => {
  for (const row of EXPECTED) {
    assert.equal(isWriteAuthorizedAlias(row.alias), row.canExecuteWriteActions, `${row.alias}: isWriteAuthorizedAlias`)
  }
  assert.equal(writeBlockedReasonFor('recruiter', '批准 Rubric'), '', 'recruiter 不应被阻断')
  assert.equal(writeBlockedReasonFor('recruiter', ''), '', 'recruiter 空动作名也不阻断')

  const approver = writeBlockedReasonFor('approver', '批准 Rubric')
  assert.ok(approver.includes('approver'), '阻断原因含 alias')
  assert.ok(approver.includes('批准 Rubric'), '阻断原因含动作名')
  assert.ok(approver.includes('ACTOR_NOT_AUTHORIZED'), '阻断原因含服务端错误码')
  assert.ok(approver.includes('Recruiter'), '阻断原因含 "Recruiter" 切换指引')
  assert.ok(approver.includes('切换为 Recruiter 身份'), '阻断原因含「切换为 Recruiter 身份」完整指引')
  assert.match(approver, /403/)
  assert.match(approver, /零写入/)

  for (const alias of ['hiring_manager', 'interviewer_a', 'interviewer_b'] as const) {
    const reason = writeBlockedReasonFor(alias, '批准备选人')
    assert.ok(reason.includes(alias), `${alias}: 含 alias`)
    assert.ok(reason.includes('批准备选人'), `${alias}: 含动作名`)
    assert.ok(reason.includes('ACTOR_NOT_AUTHORIZED'), `${alias}: 含 ACTOR_NOT_AUTHORIZED`)
    assert.ok(reason.includes('Recruiter'), `${alias}: 含 Recruiter`)
  }

  // 未知 / 未绑定 alias：fail-closed 文案（仍要给出服务端错误码与动作名）。
  for (const unknown of ['ghost', '', null, undefined]) {
    const reason = writeBlockedReasonFor(unknown, '批准 Rubric')
    assert.ok(reason.length > 0, `${String(unknown)}: 未知 alias 阻断原因非空`)
    assert.ok(reason.includes('未绑定 Demo Actor，写动作 fail-closed'), `${String(unknown)}: 未绑定 fail-closed 文案`)
    assert.ok(reason.includes('ACTOR_NOT_AUTHORIZED'), `${String(unknown)}: 含 ACTOR_NOT_AUTHORIZED`)
    assert.ok(reason.includes('批准 Rubric'), `${String(unknown)}: 含动作名`)
  }

  // 空动作名不产生「被阻断：」半句话。
  assert.ok(writeBlockedReasonFor('approver', '   ').includes('写动作'))
})

test('选择器选项：顺序稳定（recruiter → hiring_manager → approver → interviewer_a → interviewer_b），label 非空且与档案同源', () => {
  assert.deepEqual(DEMO_ACTOR_OPTIONS.map((option) => option.value), [...ALL_ALIASES])
  for (const option of DEMO_ACTOR_OPTIONS) {
    assert.equal(option.label, DEMO_ACTOR_PROFILES[option.value].label, `${option.value}: label 与档案同源`)
    assert.ok(option.label.trim().length > 0, `${option.value}: label 非空`)
  }
  assert.deepEqual(DEMO_ACTOR_OPTIONS.map((option) => option.label), [
    'Recruiter（HR 专员）',
    '招聘负责人（Hiring Manager）',
    '审批人（企业管理员）',
    'Interviewer A',
    'Interviewer B',
  ])
})

test('档案冻结：界面层不能改写视图矩阵', () => {
  assert.equal(Object.isFrozen(DEMO_ACTOR_PROFILES), true)
  assert.equal(Object.isFrozen(DEMO_ACTOR_OPTIONS), true)
  for (const alias of ALL_ALIASES) {
    assert.equal(Object.isFrozen(DEMO_ACTOR_PROFILES[alias]), true, `${alias}: 档案冻结`)
    assert.equal(Object.isFrozen(DEMO_ACTOR_PROFILES[alias].allowedViews), true, `${alias}: allowedViews 冻结`)
  }
})

test('纯函数守卫：role-views.ts 不含网络 / 存储 / 框架 / 浏览器全局调用，且零 import', () => {
  const source = readFileSync(SOURCE_URL, 'utf8')
  assert.ok(source.length > 0, '源码必须可读且非空')
  for (const banned of ['fetch(', 'localStorage', 'react', 'window.']) {
    assert.equal(source.includes(banned), false, `role-views.ts 是纯函数层，不许出现 ${banned}`)
  }
  // 自包含：不 import 任何模块（类型全部本文件声明）。
  assert.equal(/^\s*import\s/m.test(source), false, 'role-views.ts 不许 import 任何模块')
})
