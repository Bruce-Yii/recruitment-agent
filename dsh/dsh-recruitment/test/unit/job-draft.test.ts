// `recruitment_job_draft` 的**冻结接口单测**（不连库、不调模型）。
//
// 守什么（独立验收项，逐条可机检）：
//   1. 模板库 ≥5 个岗位族（覆盖 后端/前端/数据/产品/测试/运维），每族含职责/成功画像/
//      必备/加分/轮次+focus/评分表字段/rubric 维度，且模板维度单独就能通过 `validateDimensions`；
//   2. 一句人话需求 → 草案 JSON 完整（每个条目都有 reason + source），`missing_items` 用问题
//      文本问回未给的企业事实（部门/人数/级别/地点/薪酬/优先级/招聘原因…），**不编造具体值**；
//   3. 生成的 criteria 通过 `validateDimensions`、Σweight=1、至少 1 条 MUST_HAVE/DISQUALIFIER，
//      机械化字段只用 §6.3 白名单，判断型**没有** field/operator/value 键（不写 null）；
//   4. 同输入两次输出 JSON 逐字节一致（deterministic）；
//   5. 空白/超长 request_text、未知参数、tenant_id/actor_id、无法识别的岗位族一律 fail-closed；
//   6. 工具 parameters/output.schema 只用 DSH 支持的 schema 子集，happy 输出值无 null 且过值校验；
//      官方 `dsh-tools` 能加载时再用官方校验器验一遍（加载不到则用本地同子集检查器，不静默 skip）。
//
// 为什么不用静态 import 官方校验器：本包解析不到 `@deepseek-ai/dsh-tools`
// （CONTRACT.md §0 的实测 ERR_MODULE_NOT_FOUND），只能按 `$DSH_HOME` 路径动态加载，
// 与 `test/unit/job-create.test.ts` 的既有做法一致。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  CRITERION_KIND_VALUES,
  DRAFT_SOURCE_VALUES,
  JOB_DRAFT_CONTRACT_VERSION,
  JOB_TEMPLATE_LIBRARY,
  JobDraftError,
  buildJobDraft,
  confirmationBlock,
  parseJobDraftInput,
  toJobCreateArgs,
  toJobDescriptionMarkdown,
  toJobRequirementsMarkdown,
  toRubricDimensions,
  type JobDraft,
  type TemplateCriterion,
} from '../../src/domain/job-draft.ts'
import { validateDimensions } from '../../src/tools/screening-evaluate.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { JOB_DRAFT_TOOL, createJobDraftTool } from '../../src/tools/job-draft.ts'

/** 官方校验器的最小接口（`dsh-tools/lib/index.js` 的导出）。 */
interface OfficialSchemaTools {
  assertSupportedJsonSchema(schema: unknown): void
  validateJsonSchemaValue(schema: unknown, value: unknown, path?: string): string[]
}

/** DSH 安装位置：优先 `$DSH_HOME`（与 job-create.test.ts / harness.manual.mjs 一致）。 */
const ISOLATED_HOME = process.env.DSH_HOME ?? 'D:\\12412\\dsh-home'
const OFFICIAL_TOOLS_PATH = join(ISOLATED_HOME, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

let official: OfficialSchemaTools | undefined
try {
  official = (await import(pathToFileURL(OFFICIAL_TOOLS_PATH).href)) as unknown as OfficialSchemaTools
} catch {
  official = undefined
  console.warn(`[job-draft.test] 官方 dsh-tools 未加载（${OFFICIAL_TOOLS_PATH}），改用本地同子集检查器`)
}

/** DSH 支持的约束关键字（`json-schema.js` 的 CONTRACT + annotations）。 */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

/** 本工具用到的 JSON Schema 基础类型（**故意不含 null**：可缺省键必须省略键，不写 null）。 */
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean'])

/** 本插件会把来源写成这 6 个枚举值。 */
const SOURCE_SET: ReadonlySet<string> = new Set(DRAFT_SOURCE_VALUES)

/** §6.3 白名单字段（机械化判定只允许这些）。 */
const WHITELIST_FIELDS: ReadonlySet<string> = new Set([
  'timeline.covered_months_closed',
  'work_experience.entry_count',
  'education.entry_count',
  'work_experience',
  'education',
])

/** 与工具契约一致的 job_create 入参键集（toJobCreateArgs 只许产出这些键）。 */
const JOB_CREATE_ARG_KEYS: ReadonlySet<string> = new Set([
  'title', 'code', 'department_id', 'department_name', 'description_md', 'requirements_md', 'status', 'criteria',
])

const SAMPLE_REQUEST = '我们要招一名后端工程师，做支付系统，最好有大厂经验'
const DEMO_DEPARTMENT = '11111111-1111-4111-8111-000000000010'

/** 从契约错误里取回 JSON 体（消息形态 `<CODE>: <compact-json>`）。 */
function errorBody(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  const json = index >= 0 ? message.slice(index + 2) : message
  return JSON.parse(json) as Record<string, unknown>
}

/**
 * 深扫 schema：返回所有违规（子集外关键字 / type 数组 / type:'null' / required 不在 properties）。
 * @param schema - 待检查的原始 JSON Schema 节点。
 * @param path - 诊断路径。
 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  const out: string[] = []
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  const type = node.type
  if (Array.isArray(type)) out.push(`${path}.type 是数组（DSH 不支持 type 数组）`)
  else if (typeof type === 'string') {
    if (!SCHEMA_TYPES.has(type)) out.push(`${path}.type=${type} 不是本工具使用的类型（含 type:'null'？必须用省略键）`)
  } else if (!hasOneOf) {
    out.push(`${path}.type 缺失`)
  }
  if (hasOneOf) {
    const oneOf = node.oneOf
    if (!Array.isArray(oneOf) || oneOf.length < 2) out.push(`${path}.oneOf 必须是至少 2 个分支的数组`)
    else oneOf.forEach((branch, index) => out.push(...schemaViolations(branch, `${path}.oneOf[${index}]`)))
  }
  const properties = node.properties as Record<string, unknown> | undefined
  const required = node.required as string[] | undefined
  if (required !== undefined) {
    for (const key of required) {
      if (properties === undefined || !Object.hasOwn(properties, key)) {
        out.push(`${path}.required 里有未声明的键 ${key}`)
      }
    }
  }
  if (properties !== undefined) {
    for (const [key, child] of Object.entries(properties)) out.push(...schemaViolations(child, `${path}.${key}`))
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/**
 * 深扫值：类型 / enum / required / additionalProperties:false / items / oneOf。
 * @param schema - schema 节点。
 * @param value - 待校验的值。
 * @param path - 诊断路径。
 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return [`${path} schema 不是对象`]
  const node = schema as Record<string, unknown>
  if (Array.isArray(node.oneOf)) {
    const results = (node.oneOf as unknown[]).map((branch) => valueViolations(branch, value, path))
    const passing = results.filter((violations) => violations.length === 0).length
    if (passing === 1) return []
    if (passing > 1) return [`${path} 同时匹配 ${passing} 个 oneOf 分支`]
    return results.flat().slice(0, 2)
  }
  const type = node.type as string | undefined
  const typeOk = (): boolean => {
    switch (type) {
      case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value)
      case 'array': return Array.isArray(value)
      case 'string': return typeof value === 'string'
      case 'integer': return typeof value === 'number' && Number.isInteger(value)
      case 'number': return typeof value === 'number' && Number.isFinite(value)
      case 'boolean': return typeof value === 'boolean'
      default: return true
    }
  }
  const out: string[] = []
  if (!typeOk()) return [`${path} 类型不符（期望 ${type}）`]
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (type === 'array' && node.items !== undefined) {
    ;(value as unknown[]).forEach((item, index) => out.push(...valueViolations(node.items, item, `${path}[${index}]`)))
  }
  if (type === 'object') {
    const record = value as Record<string, unknown>
    const properties = (node.properties ?? {}) as Record<string, unknown>
    for (const key of (node.required ?? []) as string[]) {
      if (!Object.hasOwn(record, key)) out.push(`${path}.${key} 缺失（required）`)
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是未声明的键`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

/** 深扫值：返回所有为 null 的路径（输出里不允许 null——缺省一律省略键）。 */
function nullPaths(value: unknown, path = 'value'): string[] {
  if (value === null) return [path]
  if (Array.isArray(value)) return value.flatMap((item, index) => nullPaths(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => nullPaths(child, `${path}.${key}`))
  }
  return []
}

/** 把模板维度剥成 criterion 对象（用于验证"模板维度本身就能过 R-VAL"）。 */
function criterionFromTemplate(dimension: TemplateCriterion): Record<string, unknown> {
  const base: Record<string, unknown> = {
    key: dimension.key,
    label: dimension.label,
    kind: dimension.kind,
    weight: dimension.weight,
    notes: dimension.notes,
  }
  if (dimension.field !== undefined) {
    base.field = dimension.field
    base.operator = dimension.operator
    base.value = dimension.value
  } else {
    base.question = dimension.question
  }
  return base
}

/**
 * 断言一份 criteria 满足 §6.2/§6.3/§6.5 的全部硬约束（独立于实现的机器检查）。
 * @param criteria - 待检查的 criterion 数组。
 */
function assertCriteriaValid(criteria: readonly Record<string, unknown>[]): void {
  assert.deepEqual(validateDimensions(criteria), [], '必须通过 validateDimensions（R-VAL-1..13）')
  assert.ok(criteria.length >= 1 && criteria.length <= 50, 'criteria 长度 1..50')
  const sum = criteria.reduce((total, criterion) => total + (criterion.weight as number), 0)
  assert.ok(Math.abs(sum - 1) <= 1e-6, `Σweight 必须为 1（实际 ${sum}）`)
  let deciding = 0
  for (const criterion of criteria) {
    assert.ok(CRITERION_KIND_VALUES.includes(criterion.kind as (typeof CRITERION_KIND_VALUES)[number]))
    if (criterion.kind !== 'NICE_TO_HAVE') deciding += 1
    if (Object.hasOwn(criterion, 'field')) {
      assert.equal(typeof criterion.field, 'string')
      assert.ok(WHITELIST_FIELDS.has(criterion.field as string), `机械字段必须在 §6.3 白名单：${String(criterion.field)}`)
      assert.equal(Object.hasOwn(criterion, 'question'), false, '机械型不得有 question 键')
      assert.ok(['EXISTS', 'GTE', 'LTE'].includes(criterion.operator as string))
      if (criterion.operator === 'EXISTS') assert.equal(criterion.value, true, 'EXISTS 的 value 必须为 true')
      else assert.ok(Number.isInteger(criterion.value), 'GTE/LTE 的 value 必须是整数')
    } else {
      assert.equal(Object.hasOwn(criterion, 'operator'), false, '判断型不得有 operator 键')
      assert.equal(Object.hasOwn(criterion, 'value'), false, '判断型不得有 value 键')
      assert.equal(typeof criterion.question, 'string')
      assert.ok((criterion.question as string).trim().length >= 1, '判断型必须有 question')
    }
  }
  assert.ok(deciding >= 1, '至少 1 条 MUST_HAVE 或 DISQUALIFIER（R-VAL-13）')
  assert.equal(JSON.stringify(criteria).includes('null'), false, 'criteria 里不允许 null 占位')
}

/** 断言草案的每个条目都带 reason + source（覆盖职责/画像/必备/加分/轮次/评分字段/维度理由）。 */
function assertSourced(draft: JobDraft): void {
  const textItems = [
    ...draft.job.responsibilities,
    ...draft.job.success_profile,
    ...draft.job.must_have,
    ...draft.job.nice_to_have,
  ]
  assert.ok(textItems.length > 0)
  for (const item of textItems) {
    assert.ok(item.text.trim().length > 0)
    assert.ok(item.reason.trim().length > 0, `「${item.text}」必须有 reason`)
    assert.ok(SOURCE_SET.has(item.source), `未知来源：${item.source}`)
  }
  for (const round of draft.job.rounds) {
    assert.ok(round.name.trim().length > 0)
    assert.ok(round.focus.length > 0)
    assert.ok(round.reason.trim().length > 0)
    assert.ok(SOURCE_SET.has(round.source))
  }
  for (const field of draft.rubric_draft.scorecard_fields) {
    assert.ok(field.reason.trim().length > 0)
    assert.ok(SOURCE_SET.has(field.source))
  }
  for (const rationale of draft.rubric_draft.rationale) {
    assert.ok(rationale.reason.trim().length > 0)
    assert.ok(SOURCE_SET.has(rationale.source))
  }
}

// ---------------------------------------------------------------------------
//  ① 模板库
// ---------------------------------------------------------------------------

test('① 模板库：≥5 个岗位族覆盖 后端/前端/数据/产品/测试/运维，每族内容完整且维度自带可过 R-VAL 的形状', () => {
  assert.ok(JOB_TEMPLATE_LIBRARY.length >= 5, `模板族必须 ≥5（实际 ${JOB_TEMPLATE_LIBRARY.length}）`)
  const families = JOB_TEMPLATE_LIBRARY.map((template) => template.family)
  for (const required of ['后端', '前端', '数据', '产品', '测试', '运维']) {
    assert.ok(families.includes(required), `缺少岗位族：${required}`)
  }
  const ids = new Set(JOB_TEMPLATE_LIBRARY.map((template) => template.template_id))
  assert.equal(ids.size, JOB_TEMPLATE_LIBRARY.length, 'template_id 必须唯一')
  for (const template of JOB_TEMPLATE_LIBRARY) {
    assert.match(template.template_id, /^[a-z][a-z0-9_]{1,40}$/)
    assert.ok(template.keywords.length >= 2)
    assert.ok(template.responsibilities.length >= 3, `${template.template_id} 职责太少`)
    assert.ok(template.success_profile.length >= 2, `${template.template_id} 成功画像太少`)
    assert.ok(template.must_have.length >= 2, `${template.template_id} 必备太少`)
    assert.ok(template.nice_to_have.length >= 2, `${template.template_id} 加分太少`)
    assert.ok(template.rounds.length >= 3, `${template.template_id} 轮次太少`)
    assert.ok(template.scorecard_fields.length >= 4, `${template.template_id} 评分表字段太少`)
    assert.ok(template.rubric_dimensions.length >= 4, `${template.template_id} rubric 维度太少`)
    const dimensionKeys = new Set(template.rubric_dimensions.map((dimension) => dimension.key))
    for (const round of template.rounds) {
      assert.ok(round.focus.length >= 1, `${template.template_id}/${round.name} 缺 focus`)
      assert.ok(round.reason.trim().length > 0)
      for (const key of round.criteria_keys) {
        assert.ok(dimensionKeys.has(key), `${template.template_id}/${round.name} 引用了不存在的维度 ${key}`)
      }
    }
    for (const field of template.scorecard_fields) assert.ok(field.reason.trim().length > 0)
    for (const dimension of template.rubric_dimensions) {
      assert.ok(dimension.reason.trim().length > 0, `${template.template_id}/${dimension.key} 缺 reason`)
      assert.equal(dimension.source, 'TEMPLATE_LIBRARY')
      assert.ok(Array.isArray(dimension.match_tags))
    }
    // 模板维度单独过 R-VAL（证明"模板库默认值本身就是合法标准"，而不是靠生成阶段掩盖）
    assertCriteriaValid(template.rubric_dimensions.map(criterionFromTemplate))
  }
})

// ---------------------------------------------------------------------------
//  ② 一句人话需求 → 完整草案 + missing_items
// ---------------------------------------------------------------------------

test('② 一句需求 → 草案 JSON 完整、每条有 reason/source、missing_items 问回未给的企业事实', () => {
  const draft = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  assert.equal(draft.status, 'OK')
  assert.equal(draft.read_only, true)
  assert.equal(draft.zero_write, true)
  assert.equal(draft.template.template_id, 'backend_engineer')
  assert.equal(draft.template.family, '后端')
  assert.equal(draft.template.source, 'TEMPLATE_LIBRARY')
  assert.ok(draft.template.reason.trim().length > 0)
  assert.equal(draft.job.title, '后端工程师')
  assert.equal(draft.job.title_source, 'USER_INPUT')
  // 用户原话里的业务方向（"做支付系统"）作为 USER_INPUT 的上下文，不是企业事实推断
  assert.equal(draft.job.domain_context?.value, '支付系统')
  assert.equal(draft.job.domain_context?.source, 'USER_INPUT')
  assertSourced(draft)
  assert.ok(draft.job.responsibilities.length >= 4)
  assert.ok(draft.job.success_profile.length >= 3)
  assert.ok(draft.job.must_have.length >= 3)
  assert.ok(draft.job.nice_to_have.length >= 3)
  assert.ok(draft.job.rounds.length >= 4, '模板轮次 + 默认 HR 面')
  assert.ok(draft.job.rounds.some((round) => round.source === 'DEFAULT_SUGGESTION'))
  assert.ok(draft.rubric_draft.criteria.length >= 4)
  assert.equal(draft.rubric_draft.rationale.length, draft.rubric_draft.criteria.length, '维度理由必须 1:1')
  assert.deepEqual(
    draft.rubric_draft.rationale.map((entry) => entry.criterion_key),
    draft.rubric_draft.criteria.map((criterion) => criterion.key),
  )
  assertCriteriaValid(draft.rubric_draft.criteria)
  assert.equal(draft.rubric_draft.weight_sum, draft.rubric_draft.criteria.reduce(
    (sum, criterion) => sum + (criterion.weight as number), 0,
  ))

  const missingFields = draft.missing_items.map((item) => item.field)
  for (const requiredField of ['department', 'headcount', 'level', 'location', 'salary', 'priority', 'recruitment_reason']) {
    assert.ok(missingFields.includes(requiredField), `missing_items 必须包含 ${requiredField}`)
  }
  for (const item of draft.missing_items) {
    assert.ok(item.question.trim().length >= 2, `${item.field} 必须带可直接问用户的问题`)
    assert.ok(item.why.trim().length > 0)
    assert.equal(item.source, 'MISSING')
    assert.equal(typeof item.blocking, 'boolean')
  }
  assert.equal(draft.missing_items.find((item) => item.field === 'department')?.blocking, true)
  assert.deepEqual(draft.confirmation, confirmationBlock())
  assert.deepEqual(draft.confirmation, {
    required: true,
    status: 'PENDING_HUMAN_CONFIRMATION',
    next: ['recruitment_job_create', 'recruitment_job_rubric_approve'],
    note: '确认/修改必须由人完成',
  })
})

// ---------------------------------------------------------------------------
//  ③ 不编造企业事实
// ---------------------------------------------------------------------------

test('③ 未给部门/人数/薪酬/级别/地点/优先级/招聘原因时，草案里不得出现这些具体事实值', () => {
  const draft = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  for (const field of ['department', 'headcount', 'level', 'location', 'salary', 'budget', 'priority', 'recruitment_reason']) {
    assert.equal(Object.hasOwn(draft.job, field), false, `未给 ${field} 时必须省略键（不是 null、更不是编造值）`)
  }
  // 只扫"事实/标准"部分（missing_items 的 question 是**问句**，允许带格式示例，不是草案事实）
  const serialized = JSON.stringify({
    template: draft.template,
    job: draft.job,
    rubric_draft: draft.rubric_draft,
  })
  for (const invented of ['研发部', '上海', '北京', '深圳', 'P6', '30K', '50K', '急招', '离职', '替换', '20K']) {
    assert.equal(serialized.includes(invented), false, `草案里不得出现未被输入的具体企业事实：${invented}`)
  }

  // 给了上下文：只出现在对应事实块里，来源标 DEPARTMENT_CONTEXT，且缺失项被移除
  const withContext = buildJobDraft(parseJobDraftInput({
    request_text: SAMPLE_REQUEST,
    department_context: {
      department_id: DEMO_DEPARTMENT,
      department_name: '研发部（演示）',
      headcount: 2,
      location: '上海',
      level: 'P6',
      salary_range: '30K-50K',
      priority: 'P0',
      recruitment_reason: '替换离职',
    },
  }))
  assert.equal(withContext.job.department?.department_id, DEMO_DEPARTMENT)
  assert.equal(withContext.job.department?.value, '研发部（演示）')
  assert.equal(withContext.job.department?.source, 'DEPARTMENT_CONTEXT')
  assert.equal(withContext.job.headcount?.value, 2)
  assert.equal(withContext.job.headcount?.source, 'DEPARTMENT_CONTEXT')
  assert.equal(withContext.job.location?.value, '上海')
  assert.equal(withContext.job.level?.value, 'P6')
  assert.equal(withContext.job.salary?.value, '30K-50K')
  assert.equal(withContext.job.priority?.value, 'P0')
  assert.equal(withContext.job.recruitment_reason?.value, '替换离职')
  for (const field of ['department', 'headcount', 'level', 'location', 'salary', 'priority', 'recruitment_reason']) {
    assert.equal(withContext.missing_items.some((item) => item.field === field), false, `${field} 已给就不该再问`)
  }
  // 部门 id 优先：job_create 不接受 id 与名称同时出现
  const args = toJobCreateArgs(withContext)
  assert.equal(args.department_id, DEMO_DEPARTMENT)
  assert.equal(Object.hasOwn(args, 'department_name'), false)
  const argsWithout = toJobCreateArgs(draft)
  assert.equal(Object.hasOwn(argsWithout, 'department_id'), false, '未给部门时必须省略 department_id')
  assert.equal(Object.hasOwn(argsWithout, 'department_name'), false)
})

test('③b 用户明说的事实进入草案：人数/职级/城市/薪酬/优先级/招聘原因/年限/学历/业务方向', () => {
  const draft = buildJobDraft(parseJobDraftInput({
    request_text: '招 2 名高级后端工程师，做支付系统，5年以上经验，本科以上，上海，薪资 30K-50K，急招，替换离职',
  }))
  assert.equal(draft.job.headcount?.value, 2)
  assert.equal(draft.job.headcount?.source, 'USER_INPUT')
  assert.equal(draft.job.title, '高级后端工程师')
  assert.equal(draft.job.level?.value, '高级')
  assert.equal(draft.job.location?.value, '上海')
  assert.equal(draft.job.salary?.value, '30K-50K')
  assert.equal(draft.job.priority?.value, '急招')
  assert.equal(draft.job.recruitment_reason?.value, '替换')
  assert.equal(draft.job.domain_context?.value, '支付系统')
  // 年限来自用户原话 → 机械维度按 5 年 = 60 个月（§6.3 的单位）
  const months = draft.rubric_draft.criteria.find((criterion) => criterion.key === 'months_of_experience')
  assert.ok(months !== undefined)
  assert.equal(months?.field, 'timeline.covered_months_closed')
  assert.equal(months?.value, 60)
  const monthsRationale = draft.rubric_draft.rationale.find((entry) => entry.criterion_key === 'months_of_experience')
  assert.equal(monthsRationale?.source, 'USER_INPUT')
  // 学历来自用户原话 → 判断型，label/question 按用户口径
  const education = draft.rubric_draft.criteria.find((criterion) => criterion.key === 'education_level')
  assert.equal(education?.label, '本科及以上学历')
  assert.equal(Object.hasOwn(education as Record<string, unknown>, 'field'), false)
  const educationRationale = draft.rubric_draft.rationale.find((entry) => entry.criterion_key === 'education_level')
  assert.equal(educationRationale?.source, 'USER_INPUT')
  // 已给的事实不再问；预算仍未给所以仍然问
  const missingFields = draft.missing_items.map((item) => item.field)
  for (const given of ['headcount', 'level', 'location', 'salary', 'priority', 'recruitment_reason']) {
    assert.equal(missingFields.includes(given), false, `${given} 已给，不应出现在 missing_items`)
  }
  assert.ok(missingFields.includes('department'))
  assert.ok(missingFields.includes('budget'))
  assertCriteriaValid(draft.rubric_draft.criteria)
})

// ---------------------------------------------------------------------------
//  ④ criteria 直接可喂 job_create
// ---------------------------------------------------------------------------

test('④ toRubricDimensions / toJobCreateArgs：criteria 过 R-VAL、Σweight=1、机械白名单、可直接喂 job_create', () => {
  const draft = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  assertCriteriaValid(draft.rubric_draft.criteria)
  const dimensions = toRubricDimensions(draft)
  assert.deepEqual(dimensions, draft.rubric_draft.criteria)
  assertCriteriaValid(dimensions)

  const args = toJobCreateArgs(draft)
  for (const key of Object.keys(args)) {
    assert.ok(JOB_CREATE_ARG_KEYS.has(key), `toJobCreateArgs 产出了 job_create 不认识的键：${key}`)
  }
  assert.equal(args.status, 'DRAFT')
  assert.equal(args.title, draft.job.title)
  assert.ok(args.description_md.length > 0 && args.description_md.length <= 20_000)
  assert.ok(args.requirements_md.length > 0 && args.requirements_md.length <= 20_000)
  assertCriteriaValid(args.criteria)
  assert.deepEqual(validateDimensions(args.criteria), [])
  // 机械型/判断型的可选键集合必须"缺席而不是 null"
  for (const criterion of args.criteria) {
    const record = criterion as Record<string, unknown>
    assert.equal(Object.values(record).includes(null), false, 'criterion 的值不得为 null')
  }
  const md = toJobDescriptionMarkdown(draft)
  assert.ok(md.includes('待人类确认'))
  assert.ok(md.includes('确认/修改必须由人完成'))
  assert.ok(md.includes('recruitment_job_create'))
  assert.ok(toJobRequirementsMarkdown(draft).includes('待明确项（未给即不编造）'))
  assert.ok(toJobRequirementsMarkdown(draft).length > 0)
})

// ---------------------------------------------------------------------------
//  ⑤ deterministic
// ---------------------------------------------------------------------------

test('⑤ deterministic：同输入两次输出 JSON 逐字节一致（含上下文/历史/补充的完整输入）', () => {
  const rawInput = {
    request_text: SAMPLE_REQUEST,
    recruiter_supplement: '候选人要有支付或金融经验，最好带过团队',
    department_context: { department_id: DEMO_DEPARTMENT, location: '上海' },
    historical_jobs: [{ title: '后端工程师（支付）', code: 'BE-001', status: 'CLOSED' }],
    historical_rubrics: [{ version_no: 2, dimensions: [{ key: 'months_of_experience' }] }],
  }
  const first = buildJobDraft(parseJobDraftInput(rawInput))
  const second = buildJobDraft(parseJobDraftInput(rawInput))
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同输入两次输出必须逐字节一致')
  assert.equal(digestOf(first), digestOf(second))
  assert.equal(digestOf(first.rubric_draft.criteria), digestOf(second.rubric_draft.criteria))
  assert.equal(JSON.stringify(toJobCreateArgs(first)), JSON.stringify(toJobCreateArgs(second)))
  // 简单输入同样 deterministic
  const simpleA = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  const simpleB = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  assert.equal(JSON.stringify(simpleA), JSON.stringify(simpleB))
  assert.equal(digestOf(simpleA), digestOf(simpleB))
})

// ---------------------------------------------------------------------------
//  ⑥ 模板选择 + fail-closed
// ---------------------------------------------------------------------------

test('⑥ 模板选择：文本匹配/显式指定；无法识别的岗位族与未知模板一律 fail-closed', () => {
  const frontend = buildJobDraft(parseJobDraftInput({ request_text: '招一名前端工程师，做官网' }))
  assert.equal(frontend.template.template_id, 'frontend_engineer')
  assert.equal(frontend.job.title, '前端工程师')

  const explicit = buildJobDraft(parseJobDraftInput({
    request_text: '招一名前端工程师，做官网',
    template_id: 'backend_engineer',
  }))
  assert.equal(explicit.template.template_id, 'backend_engineer', '显式 template_id 优先于文本匹配')

  try {
    buildJobDraft(parseJobDraftInput({ request_text: '招一名保洁员，负责打扫卫生' }))
    assert.fail('无法识别岗位族时必须抛错，不能猜一个模板继续')
  } catch (error) {
    assert.ok(error instanceof JobDraftError)
    assert.equal(error.reason_code, 'TEMPLATE_UNRESOLVED')
    const detail = error.detail as Record<string, unknown>
    assert.ok(Array.isArray(detail.available_template_ids))
    assert.ok((detail.available_template_ids as unknown[]).length >= 5)
  }

  try {
    parseJobDraftInput({ request_text: '招后端', template_id: 'no_such_template' })
    assert.fail('未知 template_id 必须抛错')
  } catch (error) {
    assert.ok(error instanceof JobDraftError)
    assert.equal(error.reason_code, 'TEMPLATE_ID_UNKNOWN')
  }
})

test('⑥b 模板库 6 族逐个都能生成合法草案（标题标模板建议、缺失项问回类型）', () => {
  for (const template of JOB_TEMPLATE_LIBRARY) {
    const draft = buildJobDraft(parseJobDraftInput({
      request_text: '招聘这个岗位的人',
      template_id: template.template_id,
    }))
    assert.equal(draft.template.template_id, template.template_id)
    assert.equal(draft.template.family, template.family)
    assertCriteriaValid(draft.rubric_draft.criteria)
    assert.ok(draft.rubric_draft.criteria.length >= 5)
    assert.ok(draft.job.rounds.length >= 4)
    assert.ok(draft.rubric_draft.scorecard_fields.length >= 5)
    assert.equal(draft.job.title, template.label)
    assert.equal(draft.job.title_source, 'TEMPLATE_LIBRARY')
    assert.ok(draft.missing_items.some((item) => item.field === 'title'))
    for (const round of draft.job.rounds) assert.ok(round.focus.length > 0)
    assert.doesNotThrow(() => toJobCreateArgs(draft))
  }
})

// ---------------------------------------------------------------------------
//  ⑦ 非法入参
// ---------------------------------------------------------------------------

test('⑦ 拒绝：空白/超长/非字符串 request_text、未知参数、tenant_id/actor_id（domain + tool 两层）', () => {
  const reasonOf = (fn: () => unknown): string => {
    try {
      fn()
    } catch (error) {
      assert.ok(error instanceof JobDraftError, 'domain 层必须抛 JobDraftError')
      return error.reason_code
    }
    assert.fail('expected JobDraftError')
  }
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: '   ' })), 'REQUEST_TEXT_EMPTY')
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: 'x'.repeat(2001) })), 'REQUEST_TEXT_TOO_LONG')
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: 123 })), 'REQUEST_TEXT_TYPE')
  assert.equal(reasonOf(() => parseJobDraftInput({})), 'REQUEST_TEXT_MISSING')
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: SAMPLE_REQUEST, surprise: 1 })), 'UNKNOWN_PARAM')
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: SAMPLE_REQUEST, tenant_id: 't' })), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  assert.equal(reasonOf(() => parseJobDraftInput({ request_text: SAMPLE_REQUEST, actor_id: 'a' })), 'TENANT_OR_ACTOR_NOT_ALLOWED')
  assert.equal(reasonOf(() => parseJobDraftInput({
    request_text: SAMPLE_REQUEST,
    department_context: { nope: 1 },
  })), 'CONTEXT_UNKNOWN_KEY')
  assert.equal(reasonOf(() => parseJobDraftInput({
    request_text: SAMPLE_REQUEST,
    department_context: { department_id: 'not-a-uuid' },
  })), 'CONTEXT_VALUE_INVALID')
  assert.equal(reasonOf(() => parseJobDraftInput({
    request_text: SAMPLE_REQUEST,
    historical_jobs: [{ title: 'ok', extra: true }],
  })), 'HISTORY_UNKNOWN_KEY')

  // tool 层：同一批入参映射成 `INVALID_ARGS` 契约错误（消息体可 JSON.parse）
  const tool = createJobDraftTool()
  return (async () => {
    await assert.rejects(() => tool.execute({ request_text: '  ' }, {}), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'REQUEST_TEXT_EMPTY')
      return true
    })
    await assert.rejects(() => tool.execute({}, {}), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'REQUEST_TEXT_MISSING')
      return true
    })
    await assert.rejects(() => tool.execute({ request_text: 'x'.repeat(2001) }, {}), (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'REQUEST_TEXT_TOO_LONG')
      return true
    })
  })()
})

// ---------------------------------------------------------------------------
//  ⑧ 历史只作参考
// ---------------------------------------------------------------------------

test('⑧ 历史岗位/Rubric：只作参考（HISTORY），不静默合并进草案维度', () => {
  const withoutHistory = buildJobDraft(parseJobDraftInput({ request_text: SAMPLE_REQUEST }))
  assert.equal(Object.hasOwn(withoutHistory, 'history'), false, '没有历史输入时 history 键必须省略')

  const draft = buildJobDraft(parseJobDraftInput({
    request_text: SAMPLE_REQUEST,
    historical_jobs: [{ title: '后端工程师（支付）', code: 'BE-001', status: 'CLOSED' }],
    historical_rubrics: [{ version_no: 2, dimensions: [{ key: 'old_dimension' }] }],
  }))
  assert.ok(draft.history !== undefined)
  assert.equal(draft.history.matched_jobs.length, 1)
  assert.match(draft.history.matched_jobs[0]?.matched_because ?? '', /后端/)
  assert.equal(draft.history.matched_jobs[0]?.source, 'HISTORY')
  assert.equal(draft.history.matched_jobs[0]?.code, 'BE-001')
  assert.deepEqual(draft.history.reference_rubrics[0]?.dimension_keys, ['old_dimension'])
  assert.equal(draft.history.reference_rubrics[0]?.source, 'HISTORY')
  assert.equal(draft.history.reference_rubrics[0]?.version_no, 2)
  assert.ok(draft.history.reason.trim().length > 0)
  assert.equal(
    draft.rubric_draft.criteria.some((criterion) => criterion.key === 'old_dimension'),
    false,
    '历史标准不得静默合并（避免继承过期口径）',
  )
  // 历史不影响 criteria（与无历史版本一致），证明"只参考"
  assert.equal(digestOf(draft.rubric_draft.criteria), digestOf(withoutHistory.rubric_draft.criteria))
})

// ---------------------------------------------------------------------------
//  ⑨ 工具定义：schema 子集 / 输出值 / 只读性 / render
// ---------------------------------------------------------------------------

test('⑨ 工具定义：parameters 封闭根、output.schema 只用 DSH 子集（无 type:null）、只读可并行', () => {
  const tool = createJobDraftTool()
  assert.equal(tool.name, JOB_DRAFT_TOOL)
  assert.ok(tool.description.length > 0)
  const parameters = tool.parameters as Record<string, unknown>
  assert.equal(parameters.type, 'object')
  assert.equal(parameters.additionalProperties, false)
  assert.deepEqual(parameters.required, ['request_text'])
  assert.deepEqual(schemaViolations(parameters), [])
  const templateIds = (parameters.properties as Record<string, Record<string, unknown>>).template_id?.enum as string[]
  assert.deepEqual(templateIds, JOB_TEMPLATE_LIBRARY.map((template) => template.template_id))
  assert.deepEqual(schemaViolations(tool.output.schema), [])
  assert.equal(tool.isConcurrencySafe?.({}), true)
  if (official !== undefined) {
    official.assertSupportedJsonSchema(parameters)
    official.assertSupportedJsonSchema(tool.output.schema)
  }
})

test('⑨b 工具 happy 输出：无 null、过 output schema 值校验、带 tool/contract_version/确认闸门', async () => {
  const tool = createJobDraftTool()
  const value = await tool.execute({ request_text: SAMPLE_REQUEST }, {}) as Record<string, unknown>
  assert.equal(value.tool, JOB_DRAFT_TOOL)
  assert.equal(value.contract_version, JOB_DRAFT_CONTRACT_VERSION)
  assert.equal(value.read_only, true)
  assert.equal(value.zero_write, true)
  assert.equal(value.status, 'OK')
  assert.deepEqual(nullPaths(value), [], '输出值里不允许 null（缺省一律省略键）')
  assert.deepEqual(valueViolations(tool.output.schema, value), [])
  if (official !== undefined) {
    assert.deepEqual(official.validateJsonSchemaValue(tool.output.schema, value), [])
  }
  const job = value.job as Record<string, unknown>
  assert.equal(Object.hasOwn(job, 'department'), false)
  const rubric = value.rubric_draft as Record<string, unknown>
  assert.equal(Array.isArray(rubric.criteria), true)
  assert.equal((value.confirmation as Record<string, unknown>).status, 'PENDING_HUMAN_CONFIRMATION')

  // 带历史/上下文的另一份输出也必须过 schema
  const rich = await tool.execute({
    request_text: SAMPLE_REQUEST,
    recruiter_supplement: '最好带过团队',
    department_context: { department_id: DEMO_DEPARTMENT, headcount: 2 },
    historical_jobs: [{ title: '后端工程师（支付）' }],
    historical_rubrics: [{ version_no: 1, dimensions: [{ key: 'backend_skill' }] }],
  }, {}) as Record<string, unknown>
  assert.deepEqual(nullPaths(rich), [])
  assert.deepEqual(valueViolations(tool.output.schema, rich), [])
  if (official !== undefined) {
    assert.deepEqual(official.validateJsonSchemaValue(tool.output.schema, rich), [])
  }
})

test('⑨c render：包含确认闸门（PENDING_HUMAN_CONFIRMATION / 确认修改必须由人完成）与缺失项问题', async () => {
  const tool = createJobDraftTool()
  const value = await tool.execute({ request_text: SAMPLE_REQUEST }, {})
  const blocks = tool.output.render({ request_text: SAMPLE_REQUEST }, value)
  assert.ok(blocks.length >= 1)
  const text = blocks.map((block) => block.text).join('\n')
  assert.ok(text.includes('PENDING_HUMAN_CONFIRMATION'))
  assert.ok(text.includes('确认/修改必须由人完成'))
  assert.ok(text.includes('待人类确认'))
  assert.ok(text.includes('recruitment_job_create'))
  assert.ok(text.includes('recruitment_job_rubric_approve'))
  assert.ok(text.includes('部门归属'), '缺失项问题必须出现在渲染里')
})
