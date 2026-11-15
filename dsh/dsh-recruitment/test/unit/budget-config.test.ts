/**
 * task-78 / DESIGN §3.2：预算配置解析单测（种子 A）。
 *
 * 钉死的事（对应任务书「配置 raw 形状」+ DESIGN §3.2 语义要点）：
 *   1. 默认值 = DECISION 200000/25、SCREENING 100000/15；`task_class=AUTO`、`default_class=SCREENING`、
 *      `status_tool=false`（D-128.2 工具数=30）、`handoff_owner=null`、`issues` 为空数组（永不为 null）；
 *   2. 逐键来源 `sources`：profile 显式值 → `RECRUITMENT_BUDGET_<CANONICAL_KEY>` → 默认，三态如实记录；
 *   3. `${ENV_NAME}` 模板按 env 展开（数字字符串才接受），未定义 / 非数字 → issue + 回退默认 + sources=default；
 *   4. 非法值（负数 / 0 / 非数字 / NaN / Infinity）→ issue + 回退默认；`max_steps=0` 同样非法；
 *   5. 未知 `task_class` → issue + AUTO；未知 `default_class` → issue + SCREENING；
 *   6. `tool_class_map` 与默认映射 **merge**（不是替换），非法值 issue + 忽略；
 *   7. `handoff.owner` 非空字符串才生效，非法类型 issue + 忽略；
 *   8. issue 文案只点名 env 变量，**不回显注入值**；env 缺省时用 `process.env`（与 converter 同约定）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_LIMITS,
  DEFAULT_TOOL_CLASS_MAP,
  expandBudgetEnvValue,
  resolveBudgetConfig,
  type BudgetConfigIssues,
} from '../../src/budget/index.ts'

const CANONICAL_SOURCE_KEYS = [
  'DECISION_MAX_TOKENS',
  'DECISION_MAX_STEPS',
  'SCREENING_MAX_TOKENS',
  'SCREENING_MAX_STEPS',
  'TASK_CLASS',
  'DEFAULT_CLASS',
  'ENABLED',
  'STATUS_TOOL',
  'HANDOFF_OWNER',
  'TOOL_CLASS_MAP',
] as const

function issuesOf(config: ReturnType<typeof resolveBudgetConfig>, key: string): readonly BudgetConfigIssues[] {
  return config.issues.filter((issue) => issue.key === key)
}

test('默认值：四键额度 + AUTO/SCREENING + status_tool=false + handoff_owner=null + issues=[]', () => {
  const config = resolveBudgetConfig(undefined, {})
  assert.deepEqual(config.limits, {
    DECISION: { max_tokens: 200000, max_steps: 25 },
    SCREENING: { max_tokens: 100000, max_steps: 15 },
  })
  assert.equal(config.task_class, 'AUTO')
  assert.equal(config.default_class, 'SCREENING')
  assert.equal(config.status_tool, false)
  assert.equal(config.enabled, true)
  assert.equal(config.handoff_owner, null)
  assert.ok(Array.isArray(config.issues))
  assert.equal(config.issues.length, 0)
  assert.deepEqual({ ...config.sources }, Object.fromEntries(CANONICAL_SOURCE_KEYS.map((key) => [key, 'default'])))
  // 默认工具→类映射与冻结清单一致（merge 的底座）
  assert.deepEqual({ ...config.tool_class_map }, { ...DEFAULT_TOOL_CLASS_MAP })
  assert.deepEqual({ ...DEFAULT_LIMITS.DECISION }, { max_tokens: 200000, max_steps: 25 })
  assert.deepEqual({ ...DEFAULT_LIMITS.SCREENING }, { max_tokens: 100000, max_steps: 15 })
})

test('raw 非对象（undefined / null / 字符串 / 数组）按全默认处理，不抛异常', () => {
  for (const raw of [undefined, null, 'budget', 42, [] as unknown[]]) {
    const config = resolveBudgetConfig(raw, {})
    assert.equal(config.limits.DECISION.max_tokens, 200000, `raw=${String(raw)}`)
    assert.equal(config.issues.length, 0, `raw=${String(raw)}`)
  }
})

test('profile 显式值优先（数字 / 数字字符串 / ${ENV} 模板），sources 逐键 = profile', () => {
  const config = resolveBudgetConfig(
    {
      DECISION_MAX_TOKENS: 250000,
      DECISION_MAX_STEPS: '30',
      SCREENING_MAX_TOKENS: '${SCREENING_TOKENS}',
      SCREENING_MAX_STEPS: 12,
    },
    { SCREENING_TOKENS: '120000' },
  )
  assert.deepEqual(config.limits, {
    DECISION: { max_tokens: 250000, max_steps: 30 },
    SCREENING: { max_tokens: 120000, max_steps: 12 },
  })
  assert.equal(config.sources.DECISION_MAX_TOKENS, 'profile')
  assert.equal(config.sources.DECISION_MAX_STEPS, 'profile')
  assert.equal(config.sources.SCREENING_MAX_TOKENS, 'profile')
  assert.equal(config.sources.SCREENING_MAX_STEPS, 'profile')
  assert.equal(config.issues.length, 0)
})

test('profile 缺省时 env RECRUITMENT_BUDGET_<CANONICAL_KEY> 生效，sources = env', () => {
  const config = resolveBudgetConfig(
    {},
    {
      RECRUITMENT_BUDGET_DECISION_MAX_TOKENS: '300000',
      RECRUITMENT_BUDGET_SCREENING_MAX_STEPS: '7',
    },
  )
  assert.equal(config.limits.DECISION.max_tokens, 300000)
  assert.equal(config.limits.SCREENING.max_steps, 7)
  assert.equal(config.sources.DECISION_MAX_TOKENS, 'env')
  assert.equal(config.sources.SCREENING_MAX_STEPS, 'env')
  assert.equal(config.sources.DECISION_MAX_STEPS, 'default')
  assert.equal(config.sources.SCREENING_MAX_TOKENS, 'default')
  assert.equal(config.issues.length, 0)
})

test('profile 显式值压过 env（env 只在键缺省时生效）', () => {
  const config = resolveBudgetConfig(
    { SCREENING_MAX_TOKENS: 50 },
    { RECRUITMENT_BUDGET_SCREENING_MAX_TOKENS: '99' },
  )
  assert.equal(config.limits.SCREENING.max_tokens, 50)
  assert.equal(config.sources.SCREENING_MAX_TOKENS, 'profile')
})

test('${ENV} 模板：变量未定义 / 空串 → issue + 回退默认 + sources=default', () => {
  for (const envValue of [undefined, '   ']) {
    const env = envValue === undefined ? {} : { MISSING_TOKENS: envValue }
    const config = resolveBudgetConfig({ DECISION_MAX_TOKENS: '${MISSING_TOKENS}' }, env)
    assert.equal(config.limits.DECISION.max_tokens, 200000)
    assert.equal(config.sources.DECISION_MAX_TOKENS, 'default')
    const issues = issuesOf(config, 'DECISION_MAX_TOKENS')
    assert.equal(issues.length, 1)
    assert.match(issues[0]!.message, /MISSING_TOKENS/)
  }
})

test('${ENV} 模板：env 值非数字 / 0 / 负数 → issue + 回退默认；issue 不回显注入值', () => {
  for (const envValue of ['abc', '0', '-3', 'NaN']) {
    const config = resolveBudgetConfig(
      { DECISION_MAX_STEPS: '${BAD_STEPS}' },
      { BAD_STEPS: envValue },
    )
    assert.equal(config.limits.DECISION.max_steps, 25, `env=${envValue}`)
    assert.equal(config.sources.DECISION_MAX_STEPS, 'default', `env=${envValue}`)
    const issues = issuesOf(config, 'DECISION_MAX_STEPS')
    assert.equal(issues.length, 1, `env=${envValue}`)
    assert.match(issues[0]!.message, /BAD_STEPS/)
    // issue 文案只点名变量，不回显注入值（0 / NaN 会与通用说明里的字样重合，用独特值验证）
    if (envValue === 'abc' || envValue === '-3') {
      assert.ok(!issues[0]!.message.includes(envValue), `issue 不得回显 env 值 ${envValue}`)
    }
  }
})

test('非法 profile 值 → issue + 回退默认 + sources=default（负数/0/非数字/NaN/Infinity）', () => {
  const invalidValues: readonly unknown[] = [-5, 0, 'abc', '12abc', '', '   ', Number.NaN, Number.POSITIVE_INFINITY]
  for (const invalid of invalidValues) {
    const config = resolveBudgetConfig({ SCREENING_MAX_TOKENS: invalid }, {})
    assert.equal(config.limits.SCREENING.max_tokens, 100000, `value=${String(invalid)}`)
    assert.equal(config.sources.SCREENING_MAX_TOKENS, 'default', `value=${String(invalid)}`)
    assert.equal(issuesOf(config, 'SCREENING_MAX_TOKENS').length, 1, `value=${String(invalid)}`)
  }
})

test('max_steps=0 非法（要「立刻停」用 1），回退默认 25/15', () => {
  const config = resolveBudgetConfig({ DECISION_MAX_STEPS: 0, SCREENING_MAX_STEPS: 0 }, {})
  assert.equal(config.limits.DECISION.max_steps, 25)
  assert.equal(config.limits.SCREENING.max_steps, 15)
  assert.equal(issuesOf(config, 'DECISION_MAX_STEPS').length, 1)
  assert.equal(issuesOf(config, 'SCREENING_MAX_STEPS').length, 1)
  assert.match(issuesOf(config, 'DECISION_MAX_STEPS')[0]!.message, /max_steps/)
})

test('显式 null = 未设置：不报 issue，走 env / 默认', () => {
  const config = resolveBudgetConfig({ SCREENING_MAX_TOKENS: null }, {})
  assert.equal(config.limits.SCREENING.max_tokens, 100000)
  assert.equal(config.sources.SCREENING_MAX_TOKENS, 'default')
  assert.equal(config.issues.length, 0)
})

test('task_class：AUTO / SCREENING / DECISION 合法；大小写不敏感；未知字符串 → issue + AUTO', () => {
  assert.equal(resolveBudgetConfig({ task_class: 'AUTO' }, {}).task_class, 'AUTO')
  assert.equal(resolveBudgetConfig({ task_class: 'decision' }, {}).task_class, 'DECISION')
  assert.equal(resolveBudgetConfig({ task_class: 'SCREENING' }, {}).task_class, 'SCREENING')

  const bogus = resolveBudgetConfig({ task_class: 'DEEP_THINKING' }, {})
  assert.equal(bogus.task_class, 'AUTO')
  assert.equal(bogus.sources.TASK_CLASS, 'default')
  assert.equal(issuesOf(bogus, 'TASK_CLASS').length, 1)

  const numeric = resolveBudgetConfig({ task_class: 7 }, {})
  assert.equal(numeric.task_class, 'AUTO')
  assert.equal(issuesOf(numeric, 'TASK_CLASS').length, 1)
})

test('task_class / default_class / status_tool / handoff_owner 的 env 兜底', () => {
  const config = resolveBudgetConfig(
    {},
    {
      RECRUITMENT_BUDGET_TASK_CLASS: 'DECISION',
      RECRUITMENT_BUDGET_DEFAULT_CLASS: 'DECISION',
      RECRUITMENT_BUDGET_STATUS_TOOL: '1',
      RECRUITMENT_BUDGET_HANDOFF_OWNER: '招聘负责人-李',
    },
  )
  assert.equal(config.task_class, 'DECISION')
  assert.equal(config.default_class, 'DECISION')
  assert.equal(config.status_tool, true)
  assert.equal(config.handoff_owner, '招聘负责人-李')
  assert.equal(config.sources.TASK_CLASS, 'env')
  assert.equal(config.sources.DEFAULT_CLASS, 'env')
  assert.equal(config.sources.STATUS_TOOL, 'env')
  assert.equal(config.sources.HANDOFF_OWNER, 'env')
})

test('default_class 未知值 → issue + SCREENING', () => {
  const config = resolveBudgetConfig({ default_class: 'MAYBE' }, {})
  assert.equal(config.default_class, 'SCREENING')
  assert.equal(issuesOf(config, 'DEFAULT_CLASS').length, 1)
  assert.equal(config.sources.DEFAULT_CLASS, 'default')
})

test('status_tool：默认 false；true / "true" 可开；非法值 → issue + false', () => {
  assert.equal(resolveBudgetConfig({}, {}).status_tool, false)
  assert.equal(resolveBudgetConfig({ status_tool: true }, {}).status_tool, true)
  assert.equal(resolveBudgetConfig({ status_tool: 'true' }, {}).status_tool, true)
  assert.equal(resolveBudgetConfig({ status_tool: 'false' }, {}).status_tool, false)

  const invalid = resolveBudgetConfig({ status_tool: 'maybe' }, {})
  assert.equal(invalid.status_tool, false)
  assert.equal(invalid.sources.STATUS_TOOL, 'default')
  assert.equal(issuesOf(invalid, 'STATUS_TOOL').length, 1)
})

test('enabled：默认 true；显式 false/true；任何非布尔（含字符串）→ issue + 回退 true', () => {
  const dflt = resolveBudgetConfig({}, {})
  assert.equal(dflt.enabled, true)
  assert.equal(dflt.sources.ENABLED, 'default')

  const off = resolveBudgetConfig({ enabled: false }, {})
  assert.equal(off.enabled, false)
  assert.equal(off.sources.ENABLED, 'profile')
  assert.equal(off.issues.length, 0)

  const on = resolveBudgetConfig({ enabled: true }, {})
  assert.equal(on.enabled, true)
  assert.equal(on.sources.ENABLED, 'profile')
  assert.equal(on.issues.length, 0)

  // profile 只接受布尔：字符串 'true'/'false'、数字、null、对象全部非法 → issue + 回退 true
  for (const invalid of ['false', 'true', 0, 1, 'yes', null, {}]) {
    const config = resolveBudgetConfig({ enabled: invalid }, {})
    assert.equal(config.enabled, true, `enabled=${JSON.stringify(invalid)} 应回退 true`)
    assert.equal(config.sources.ENABLED, 'default', `enabled=${JSON.stringify(invalid)}`)
    const issues = issuesOf(config, 'ENABLED')
    assert.equal(issues.length, 1, `enabled=${JSON.stringify(invalid)}`)
    assert.match(issues[0]!.message, /回退 true/)
  }
})

test('enabled 的 env 兜底：字符串布尔可注入；无法解析 → issue + true；profile 压过 env', () => {
  const off = resolveBudgetConfig({}, { RECRUITMENT_BUDGET_ENABLED: 'false' })
  assert.equal(off.enabled, false)
  assert.equal(off.sources.ENABLED, 'env')

  const on = resolveBudgetConfig({}, { RECRUITMENT_BUDGET_ENABLED: '1' })
  assert.equal(on.enabled, true)
  assert.equal(on.sources.ENABLED, 'env')

  const bogus = resolveBudgetConfig({}, { RECRUITMENT_BUDGET_ENABLED: 'maybe' })
  assert.equal(bogus.enabled, true)
  assert.equal(bogus.sources.ENABLED, 'default')
  assert.equal(issuesOf(bogus, 'ENABLED').length, 1)

  const overridden = resolveBudgetConfig({ enabled: false }, { RECRUITMENT_BUDGET_ENABLED: 'true' })
  assert.equal(overridden.enabled, false)
  assert.equal(overridden.sources.ENABLED, 'profile')
})

test('handoff.owner：非空字符串才生效；null/空串 = 不覆盖；非法类型 → issue + 忽略', () => {
  assert.equal(resolveBudgetConfig({ handoff: { owner: '  张三  ' } }, {}).handoff_owner, '张三')
  assert.equal(resolveBudgetConfig({ handoff: { owner: null } }, {}).handoff_owner, null)
  assert.equal(resolveBudgetConfig({ handoff: { owner: '   ' } }, {}).handoff_owner, null)

  const invalid = resolveBudgetConfig({ handoff: { owner: 123 } }, {})
  assert.equal(invalid.handoff_owner, null)
  assert.equal(issuesOf(invalid, 'HANDOFF_OWNER').length, 1)

  // 扁平 handoff_owner 是同义注入面（脚本 / 单测）
  assert.equal(resolveBudgetConfig({ handoff_owner: '李四' }, {}).handoff_owner, '李四')
})

test('tool_class_map 与默认映射 merge：覆盖单键、保留其余默认；未知类 → issue + 忽略', () => {
  const merged = resolveBudgetConfig(
    { tool_class_map: { recruitment_resume_read: 'DECISION', recruitment_trace_get: 'SCREENING' } },
    {},
  )
  assert.equal(merged.tool_class_map.recruitment_resume_read, 'DECISION')
  assert.equal(merged.tool_class_map.recruitment_trace_get, 'SCREENING')
  assert.equal(merged.tool_class_map.recruitment_screening_evaluate, 'SCREENING')
  assert.equal(merged.tool_class_map.record_human_decision, 'DECISION')
  assert.equal(merged.sources.TOOL_CLASS_MAP, 'profile')
  assert.equal(merged.issues.length, 0)

  const ignored = resolveBudgetConfig({ tool_class_map: { recruitment_resume_read: 'BOGUS' } }, {})
  assert.equal(ignored.tool_class_map.recruitment_resume_read, 'SCREENING')
  assert.equal(issuesOf(ignored, 'TOOL_CLASS_MAP').length, 1)

  const notObject = resolveBudgetConfig({ tool_class_map: 'nope' }, {})
  assert.equal(notObject.sources.TOOL_CLASS_MAP, 'default')
  assert.equal(issuesOf(notObject, 'TOOL_CLASS_MAP').length, 1)
  assert.equal(notObject.tool_class_map.record_human_decision, 'DECISION')

  const empty = resolveBudgetConfig({ tool_class_map: {} }, {})
  assert.equal(empty.sources.TOOL_CLASS_MAP, 'profile')
  assert.deepEqual({ ...empty.tool_class_map }, { ...DEFAULT_TOOL_CLASS_MAP })
})

test('issues 永不为 null（含全部非法输入的最坏情况）', () => {
  const config = resolveBudgetConfig(
    {
      DECISION_MAX_TOKENS: -1,
      DECISION_MAX_STEPS: 'x',
      SCREENING_MAX_TOKENS: Number.NaN,
      SCREENING_MAX_STEPS: 0,
      task_class: '?',
      default_class: '?',
      enabled: 'true',
      status_tool: '?',
      handoff: { owner: 1 },
      tool_class_map: { a: '?' },
    },
    {},
  )
  assert.ok(Array.isArray(config.issues))
  assert.equal(config.issues.length, 10)
  for (const issue of config.issues) {
    assert.equal(typeof issue.key, 'string')
    assert.equal(typeof issue.message, 'string')
    assert.ok(issue.message.length > 0)
  }
})

test('expandBudgetEnvValue：模板展开只接受数字字符串；非模板返回 undefined 且不报 issue', () => {
  const issues: BudgetConfigIssues[] = []
  assert.equal(expandBudgetEnvValue('${FOO}', 'K', { FOO: '42' }, issues), 42)
  assert.equal(expandBudgetEnvValue('${FOO}', 'K', { FOO: ' 42 ' }, issues), 42)
  assert.equal(expandBudgetEnvValue('${FOO}', 'K', { FOO: '42.5' }, issues), 42.5)
  assert.equal(issues.length, 0)

  // 非模板：普通数字字符串 / 数字 / 字符串内插值都不展开（由调用方走数字解析）
  assert.equal(expandBudgetEnvValue('42', 'K', {}, issues), undefined)
  assert.equal(expandBudgetEnvValue(42, 'K', {}, issues), undefined)
  assert.equal(expandBudgetEnvValue('${FOO}-suffix', 'K', { FOO: '42' }, issues), undefined)
  assert.equal(issues.length, 0)

  assert.equal(expandBudgetEnvValue('${FOO}', 'K', {}, issues), undefined)
  assert.equal(expandBudgetEnvValue('${FOO}', 'K', { FOO: 'abc' }, issues), undefined)
  assert.equal(expandBudgetEnvValue('${FOO}', 'K', { FOO: '0' }, issues), undefined)
  assert.equal(issues.length, 3)
  assert.ok(issues.every((issue) => issue.key === 'K'))
})

test('不传 env 时默认读 process.env（与 src/tools/converter.ts 同一约定）', () => {
  const envName = 'RECRUITMENT_BUDGET_SCREENING_MAX_STEPS'
  const previous = process.env[envName]
  process.env[envName] = '9'
  try {
    const config = resolveBudgetConfig({})
    assert.equal(config.limits.SCREENING.max_steps, 9)
    assert.equal(config.sources.SCREENING_MAX_STEPS, 'env')
  } finally {
    if (previous === undefined) delete process.env[envName]
    else process.env[envName] = previous
  }
})
