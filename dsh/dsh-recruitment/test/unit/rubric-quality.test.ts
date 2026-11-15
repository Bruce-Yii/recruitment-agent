// Rubric 质量门槛的纯逻辑矩阵（**不连库**）。
//
// 事故背景（2026-11-15，task-77，已验收 FAIL）：岗位「后端工程师」的 JD 要求 =
// 「后端开发经验；能读懂并落实接口契约。」，rubric 却只有两条机械条件
// （`work_exists` = work_experience EXISTS、`edu_exists` = education EXISTS），
// 于是 `recruitment_screening_evaluate` 返回 `verdict=PASS`，Agent 只能说"机械 PASS、业务 HOLD"。
//
// 这个文件锁的是 `assessRubricQuality()` 的**判定口径**（纯函数、确定性、无 LLM）：
//   a. 本事故原样 → QUALITY_WARNING + 三条 reason + 2 条 uncovered + 2 条建议维度；
//   b. 好 rubric（judgment 维度覆盖两个 JD 条款）→ OK，**不误报**；
//   c. 无 JD 文本 → jd_requirements_checked=false（不猜），纯机械仍然告警但不出 JD reason；
//   d. 机械条件含 timeline GTE（有界限量，不是"存在性"）+ judgment 维度 → 不因"机械"告警，
//      且 GTE 不满足 `existence_only` 口径；
//   e. 确定性：同一输入两次调用 deepEqual；
//   f. `field: null` 与"键缺失"同义（R-VAL 口径）——不能被算成机械维度；
//   g. JD 条款切分 / 覆盖词面口径 / 建议维度上限（启发式边界，锁定可复核性）。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assessRubricQuality,
  jdContentTokens,
  splitJdClauses,
  type RubricQuality,
} from '../../src/tools/screening-evaluate.ts'

/** 本事故原样的两条机械维度（`question: null` 是库里的真实形状）。 */
const INCIDENT_DIMENSIONS: readonly Record<string, unknown>[] = [
  {
    key: 'work_exists',
    kind: 'MUST_HAVE',
    field: 'work_experience',
    label: '简历中存在可分割的工作经历条目',
    notes: 'EXISTS 判的是 state=present（读到了），不是"这个人有工作经历"',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
    question: null,
  },
  {
    key: 'edu_exists',
    kind: 'MUST_HAVE',
    field: 'education',
    label: '简历中存在可分割的教育经历条目',
    notes: 'state=absent → MISSING；state=unreadable → UNREADABLE',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
    question: null,
  },
]

/** 本事故的 JD 原文（`job_version.requirements_md`，真实库值）。 */
const INCIDENT_REQUIREMENTS = '后端开发经验；能读懂并落实接口契约。'
/** 同一个 job_version 的 `description_md`（真实库值；requirements 存在时**不得**被使用）。 */
const INCIDENT_DESCRIPTION = '演示岗位：用于证明 S6→S7 的 SCREENING 决策能在仓库内被重跑出来（合成数据）。'

/** 一条覆盖 JD 的判断型维度（`field` 缺失 = 判断型）。 */
function judgmentCriterion(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: '请结合材料回答',
    ...overrides,
  }
}

/** 好 rubric：两条 judgment 维度，label/question 覆盖 JD 的两条要求。 */
const GOOD_DIMENSIONS: readonly Record<string, unknown>[] = [
  judgmentCriterion({ key: 'backend_experience', label: '后端开发经验', question: '候选人是否有可核实的后端开发经验？' }),
  judgmentCriterion({ key: 'api_contract', label: '能读懂并落实接口契约', question: '候选人是否能读懂并落实接口契约？' }),
]

/** 质量结论的 reason code 列表（顺序敏感）。 */
function codesOf(quality: RubricQuality): string[] {
  return quality.reasons.map((reason) => reason.code)
}

test('a. 本事故：两条 EXISTS + JD 两条款 → QUALITY_WARNING（三条 reason + 2 条建议维度）', () => {
  const quality = assessRubricQuality({
    dimensions: INCIDENT_DIMENSIONS,
    requirementsMd: INCIDENT_REQUIREMENTS,
    descriptionMd: INCIDENT_DESCRIPTION,
  })

  assert.equal(quality.status, 'QUALITY_WARNING')
  // 顺序固定（封闭表 + 条款顺序）：先"纯机械"，再"只判存在性"，最后"JD 未覆盖"。
  assert.deepEqual(codesOf(quality), [
    'ALL_CRITERIA_MECHANICAL',
    'EXISTENCE_ONLY',
    'JD_REQUIREMENTS_UNCOVERED',
  ])
  // 计数口径：`field != null` = 机械维度（null 与缺失同义）。
  assert.equal(quality.mechanical_dimension_count, 2)
  assert.equal(quality.judgment_dimension_count, 0)
  assert.equal(quality.deciding_criteria_count, 2)
  assert.equal(quality.existence_only, true)
  // JD 侧：requirements_md 优先（不是 description_md），2 条要求都没被 rubric 覆盖。
  assert.equal(quality.jd_requirements_checked, true)
  assert.equal(quality.jd_requirement_count, 2)
  assert.equal(quality.uncovered_requirements.length, 2)
  assert.deepEqual(quality.uncovered_requirements.map((item) => item.requirement), [
    '后端开发经验',
    '能读懂并落实接口契约',
  ])
  // 建议维度 = 每条 uncovered 一条（只建议、不写库、weight 只能由人定）。
  assert.deepEqual(quality.uncovered_requirements.map((item) => item.suggested_dimension.key), ['jd_core_1', 'jd_core_2'])
  const first = quality.uncovered_requirements[0]?.suggested_dimension
  assert.deepEqual(first, {
    key: 'jd_core_1',
    label: '后端开发经验',
    kind: 'MUST_HAVE',
    question: '候选人是否满足 JD 要求「后端开发经验」？请结合材料给出判断与证据。',
    weight_hint: '需人工确定（rubric 维度和 Σweight=1 只能由人批准）',
  })
  // source 只可能是这两条路径之一，且这里必须是 REQUIREMENTS_MD。
  for (const item of quality.uncovered_requirements) assert.equal(item.source, 'REQUIREMENTS_MD')
  // 人必须判断；输出是 advisory，不是自动改标准。
  assert.equal(quality.human_judgment_required, true)
  assert.equal(quality.advisory, true)
  assert.equal(quality.note, '质量门槛只提示，不自动修改 rubric 标准；建议维度需人批准后才能写入')
})

test('b. 好 rubric：judgment 维度覆盖两个 JD 条款 → OK、reasons 为空（不误报）', () => {
  const quality = assessRubricQuality({
    dimensions: GOOD_DIMENSIONS,
    requirementsMd: INCIDENT_REQUIREMENTS,
    descriptionMd: INCIDENT_DESCRIPTION,
  })

  assert.equal(quality.status, 'OK')
  assert.deepEqual(quality.reasons, [])
  // 防误报：整个结论里不该出现 QUALITY_WARNING（否则 Agent 会把它当告警）。
  assert.equal(JSON.stringify(quality).includes('QUALITY_WARNING'), false)
  assert.equal(quality.mechanical_dimension_count, 0)
  assert.equal(quality.judgment_dimension_count, 2)
  assert.equal(quality.existence_only, false)
  assert.equal(quality.jd_requirements_checked, true)
  assert.equal(quality.jd_requirement_count, 2)
  assert.deepEqual(quality.uncovered_requirements, [])
  assert.equal(quality.human_judgment_required, false)
})

test('c. 无 JD 文本：jd_requirements_checked=false（不猜）；纯机械仍告警但不出 JD reason', () => {
  const quality = assessRubricQuality({
    dimensions: INCIDENT_DIMENSIONS,
    requirementsMd: '',
    descriptionMd: '',
  })

  assert.equal(quality.jd_requirements_checked, false, '两段 JD 都空 ⇒ 没检查，不猜')
  assert.equal(quality.jd_requirement_count, 0)
  assert.deepEqual(quality.uncovered_requirements, [])
  // 纯机械这一条**不依赖 JD**：仍然必须告警。
  assert.equal(quality.status, 'QUALITY_WARNING')
  assert.deepEqual(codesOf(quality), ['ALL_CRITERIA_MECHANICAL', 'EXISTENCE_ONLY'])
  assert.equal(codesOf(quality).includes('JD_REQUIREMENTS_UNCOVERED'), false)

  // 缺省（不传 JD 字段）与传空串等价。
  const omitted = assessRubricQuality({ dimensions: INCIDENT_DIMENSIONS })
  assert.equal(omitted.jd_requirements_checked, false)
  assert.deepEqual(codesOf(omitted), ['ALL_CRITERIA_MECHANICAL', 'EXISTENCE_ONLY'])
})

test('d. 机械条件含 timeline GTE + judgment 维度覆盖 JD → 不因"机械"告警', () => {
  const dimensions = [
    {
      key: 'months',
      label: '≥60 个月后端经验',
      kind: 'MUST_HAVE',
      weight: 0.5,
      field: 'timeline.covered_months_closed',
      operator: 'GTE',
      value: 60,
    },
    judgmentCriterion({ key: 'api_contract', label: '能读懂并落实接口契约' }),
    judgmentCriterion({ key: 'backend_experience', label: '后端开发经验' }),
  ]
  const quality = assessRubricQuality({ dimensions, requirementsMd: INCIDENT_REQUIREMENTS })
  assert.equal(quality.mechanical_dimension_count, 1)
  assert.equal(quality.judgment_dimension_count, 2)
  assert.equal(quality.status, 'OK')
  assert.deepEqual(quality.reasons, [])
  assert.equal(quality.uncovered_requirements.length, 0)
  // GTE 不是"存在性"：existence_only 必须为 false（否则会误报 EXISTENCE_ONLY）。
  assert.equal(quality.existence_only, false)

  // 反证：把两条 judgment 维度拿掉，只剩 GTE 机械条件 → 纯机械告警（但**不是** EXISTENCE_ONLY）。
  const mechanicalOnly = assessRubricQuality({ dimensions: [dimensions[0]], requirementsMd: INCIDENT_REQUIREMENTS })
  assert.equal(mechanicalOnly.status, 'QUALITY_WARNING')
  assert.equal(mechanicalOnly.existence_only, false)
  assert.deepEqual(codesOf(mechanicalOnly), [
    'ALL_CRITERIA_MECHANICAL',
    'JD_REQUIREMENTS_UNCOVERED',
  ])
})

test('e. 确定性：同一输入两次调用 deepEqual（无时钟、无随机、无 LLM）', () => {
  const input = {
    dimensions: INCIDENT_DIMENSIONS,
    requirementsMd: INCIDENT_REQUIREMENTS,
    descriptionMd: INCIDENT_DESCRIPTION,
  }
  assert.deepEqual(assessRubricQuality(input), assessRubricQuality(input))
  // 顺序也必须确定：uncovered / 建议 key 都按 JD 条款顺序。
  const first = assessRubricQuality(input)
  const second = assessRubricQuality(input)
  assert.deepEqual(first.uncovered_requirements.map((i) => i.requirement), second.uncovered_requirements.map((i) => i.requirement))
})

test('f. R-VAL 口径：`field: null` 与"键缺失"同义（都算判断型，不算机械）', () => {
  const dimensions = [
    // 历史行形状：判断型准则有 field 键但值是 null。
    { key: 'bachelor', label: '本科及以上', kind: 'MUST_HAVE', weight: 0.5, field: null, operator: null, value: null, question: '是否本科及以上？' },
    // 当前形状：判断型准则**没有** field 键。
    judgmentCriterion({ key: 'backend_experience', label: '后端开发经验' }),
  ]
  const quality = assessRubricQuality({ dimensions, requirementsMd: '后端开发经验' })
  assert.equal(quality.mechanical_dimension_count, 0, 'field:null 不得被算成机械维度')
  assert.equal(quality.judgment_dimension_count, 2)
  assert.equal(quality.status, 'OK', '有判断维度就不该因"纯机械"告警')
  assert.equal(quality.existence_only, false, '判断型维度没有 EXISTS 口径')
})

test('g. 启发式边界：条款切分 / 内容 token / 建议维度上限（可复核的确定性）', () => {
  // 切分：换行、中文/英文分号、句号、项目符号、数字编号；trim + 去空 + 去重。
  assert.deepEqual(
    splitJdClauses('后端开发经验；\n- 能读懂并落实接口契约。\n1. 熟悉 PostgreSQL;后端开发经验'),
    ['后端开发经验', '能读懂并落实接口契约', '熟悉 PostgreSQL'],
  )
  assert.deepEqual(splitJdClauses(''), [])
  assert.deepEqual(splitJdClauses(null), [])
  assert.deepEqual(splitJdClauses(undefined), [])
  // 上限 20 条（防止离谱输入撑爆输出）。
  assert.equal(splitJdClauses(Array.from({ length: 30 }, (_, i) => `要求${i}`).join('；')).length, 20)

  // 内容 token：汉字 2-gram + 英文小写（长度 ≥3）+ 小停用词表（"经验"被滤掉）。
  const tokens = jdContentTokens('后端开发经验 PostgreSQL')
  assert.ok(tokens.includes('后端'))
  assert.ok(tokens.includes('开发'))
  assert.equal(tokens.includes('经验'), false, '通用词"经验"必须在停用词表里')
  assert.ok(tokens.includes('postgresql'))
  // 英文词长度 <3 直接丢弃（`SQL`→sql 保留，`ab` 丢弃）。
  const shortEnglish = jdContentTokens('SQL ab')
  assert.ok(shortEnglish.includes('sql'))
  assert.equal(shortEnglish.includes('ab'), false, '长度 <3 的英文词不是内容词')
  assert.deepEqual(jdContentTokens('经验'), [], '整条只是套话 ⇒ 没有内容 token')
  assert.deepEqual(jdContentTokens(''), [])

  // 建议维度上限 5 条（每条 uncovered 一条草案；真实总数写在 reason.message 里）。
  const many = Array.from({ length: 8 }, (_, i) => `要求条款${i}能力`)
  const quality = assessRubricQuality({
    dimensions: INCIDENT_DIMENSIONS,
    requirementsMd: many.join('；'),
  })
  assert.equal(quality.jd_requirement_count, 8)
  assert.equal(quality.uncovered_requirements.length, 5, '建议维度最多 5 条')
  const jdReason = quality.reasons.find((reason) => reason.code === 'JD_REQUIREMENTS_UNCOVERED')
  assert.ok(jdReason !== undefined)
  assert.match(jdReason.message, /JD 有 8 条要求没有出现在 rubric/)
})

test('g2. 覆盖是词面匹配（不是语义）：同义改写会漏报——启发式的已知边界写在这里', () => {
  // rubric 用"服务端研发背景"表达同一个意思，但 2-gram 与 JD 的"后端开发经验"没有交集 ⇒ 判 uncovered。
  // 这是**已知误报**，不是 bug 修掉的理由（修它就要引入语义模型，违反"确定性、无 LLM、无新依赖"）。
  const dimensions = [judgmentCriterion({ key: 'server_side', label: '服务端研发背景' })]
  const quality = assessRubricQuality({ dimensions, requirementsMd: '后端开发经验' })
  assert.equal(quality.status, 'QUALITY_WARNING')
  assert.deepEqual(quality.uncovered_requirements.map((item) => item.requirement), ['后端开发经验'])
})

test('g3. 无任何维度的退化输入：不崩、不猜（R-VAL-13 会在上游把这种 rubric 拒成 RUBRIC_INVALID）', () => {
  const quality = assessRubricQuality({ dimensions: [], requirementsMd: INCIDENT_REQUIREMENTS })
  // 没有机械维度 ⇒ 不触发"纯机械"；但 JD 要求一条都没被覆盖 ⇒ 仍然告警（这是**只读提示**，不是判定）。
  assert.equal(quality.status, 'QUALITY_WARNING')
  assert.deepEqual(codesOf(quality), ['JD_REQUIREMENTS_UNCOVERED'])
  assert.equal(quality.mechanical_dimension_count, 0)
  assert.equal(quality.judgment_dimension_count, 0)
  assert.equal(quality.deciding_criteria_count, 0)
  assert.equal(quality.existence_only, false, '没有决定性维度 ⇒ 不算 existence_only（不虚空成立）')
  assert.equal(quality.uncovered_requirements.length, 2)
})
