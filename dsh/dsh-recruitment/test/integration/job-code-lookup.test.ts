// D-141 第 6 条：`recruitment_job_get` 支持按 `code` / `title` **包含匹配**查询岗位（真库）。
//
// 口径（一条条对应任务书的验收点）：
//   1. 三个选择器 `job_id` / `code` / `title` 必须**恰好给一个**（0 个 → MISSING_REQUIRED，
//      多个 → MUTUALLY_EXCLUSIVE）；`code`/`title` 归一化后为空必须**明确拒绝**（TYPE_MISMATCH）；
//   2. 归一化口径：`REPLACE(chr(12288)) → BTRIM → LOWER`，库值在 SQL 侧归一化、查询串在 JS 侧；
//   3. 包含判定是**字面量子串**（`position`，不是 LIKE）：`%` / `_` 不得成为通配符；
//   4. 0 命中 = `NOT_FOUND / JOB_NOT_FOUND`（不是空列表），且零写入；
//   5. 多命中 = `needs_human_choice=true` + `next_tools=[]`（不替人挑），顺序确定；
//   6. 单查（`job_id`）输出**与改前同形同值**：与 `readJobValue()` 深比相等，NOT_FOUND 行为不变；
//   7. output schema：根 `oneOf` 两分支、两个分支各自封闭、`required ⊆ properties`（本地小校验器，
//      **不 import 宿主**）；根**不能**带 `type`（DSH 校验器拒 "cannot declare both type and oneOf"，
//      实测见 work/d5/decision-stage/B-job-code/REPORT.md）。
//
// 库纪律（照 test/integration/job-close-action.test.ts）：
//   * 独占 `createIsolatedTestDatabase('jobcode')` 一次性空库（0001→0016 全量重放），**不写** `ra_s6s7`；
//   * `assertPrivateDatabase` 守卫 + `after` 里 `drop()`；连不上库直接**失败**（不静默 skip）；
//   * 断言只信**独立 SQL 读回**（不拿产品代码给自己作证；唯一例外是 §6 的 readJobValue 回归）。
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'

import { createJobGetTool, readJobValue } from '../../src/tools/job-get.ts'
import type { DatabaseClient, ResolvedDatabaseConfig } from '../../src/db/pool.ts'
import {
  DEMO_DEPARTMENT,
  DEMO_JOB,
  HR_ACTOR,
  TENANT,
  assertPrivateDatabase,
  createIsolatedTestDatabase,
  errorBody,
  seedScenario,
  testDatabaseConfig,
  type IsolatedTestDatabase,
} from './db.ts'

/** 集成测试底座配置（密码只从环境变量来；缺了 `testDatabaseConfig()` 直接抛）。 */
const BASE = testDatabaseConfig()

/** 固定的 `as_of`（过去时刻；LOOKUP 只回显它，不参与筛选）。 */
const AS_OF = '2026-11-13T00:00:00+08:00'

/** 合法 UUID、但库里不存在（NOT_FOUND 反证用；固定值保证可重复）。 */
const MISSING_JOB_ID = '11111111-1111-4111-8111-0000000000ff'

/** `seedScenario` 需要能 digest 的 rubric 维度（权重和 = 1，R-VAL）。 */
const DIMENSIONS = [
  {
    key: 'work_exists',
    label: '有工作经历',
    kind: 'MUST_HAVE',
    weight: 1,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
  },
]

/** 本文件的三条夹具岗位（A/B 走 seedScenario 拿完整的 rubric/审批链；C 是"没有 rubric"的岗位）。 */
interface Fixtures {
  readonly aJobId: string
  readonly aJobVersionId: string
  readonly aRubricId: string
  readonly bJobId: string
  readonly bRubricId: string
  readonly cJobId: string
}

let db: IsolatedTestDatabase
let cfg: ResolvedDatabaseConfig
let tool: ReturnType<typeof createJobGetTool>
let fixtures: Fixtures

before(async () => {
  db = await createIsolatedTestDatabase('jobcode')
  assertPrivateDatabase(db.name)
  cfg = { ...BASE, database: db.name }

  const client = await db.pool.connect()
  try {
    await client.query('begin')
    // 夹具 INSERT 的 `fn_row_guard` 状态迁移要能确定 actor（与 withActor 的 SET LOCAL 同义）。
    await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])

    // A：自造的完整岗位（有已批准 rubric 且 current 指针指向它）——job_id 单查回归用。
    // 编码不能撞 0002_seed 的演示岗位 DEMO-BE-001（`uq_job_code` 是 (tenant_id, code) 唯一）。
    const a = await seedScenario(client, { dimensions: DIMENSIONS })
    await client.query('update recruitment.job set code = $2, title = $3 where id = $1', [
      a.jobId, 'BE-PLATFORM-001', '平台工程师（含完整 rubric）',
    ])

    // B：小写编码 + 标题里含**全角空格**（U+3000）：用来证明"库值侧归一化"真的发生。
    const b = await seedScenario(client, { dimensions: DIMENSIONS })
    await client.query('update recruitment.job set code = $2, title = $3 where id = $1', [
      b.jobId, 'demo-be-002', '后端\u3000工程师（演示）',
    ])

    // C：没有任何 job_version / rubric_version ⇒ current_rubric_version_no 必须是 null。
    const c = await client.query<{ id: string }>(
      `insert into recruitment.job (tenant_id, department_id, code, title, status)
       values ($1, $2, $3, $4, 'OPEN') returning id`,
      [TENANT, DEMO_DEPARTMENT, 'SRE-003', '站点可靠性工程师'],
    )
    const cJobId = c.rows[0]?.id
    assert.ok(typeof cJobId === 'string', '夹具 C 必须拿到 job id')

    await client.query('commit')
    fixtures = {
      aJobId: a.jobId,
      aJobVersionId: a.jobVersionId,
      aRubricId: a.rubricId,
      bJobId: b.jobId,
      bRubricId: b.rubricId,
      cJobId,
    }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  tool = createJobGetTool(cfg)
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  小工具：调用 / 读回 / 本地 schema 校验
// ---------------------------------------------------------------------------

/** 调一次工具并断言返回对象（LOOKUP 或 JOB_DETAIL 都是对象根）。 */
async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return await tool.execute(args) as Record<string, unknown>
}

/**
 * 调一次工具并**期望失败**，返回解析后的契约错误体（`errorBody`）。
 * @param args - 入参。
 * @param label - 失败信息里的上下文。
 */
async function expectFailure(args: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
  try {
    await tool.execute(args)
  } catch (error) {
    return errorBody(error)
  }
  assert.fail(`${label}：期望抛契约错误，实际调用成功（${JSON.stringify(args)}）`)
}

/** 读一次独立 SQL 的行数快照（零写入断言口径）。 */
async function tableCounts(): Promise<{ readonly job: number; readonly application: number; readonly event_inbox: number }> {
  const result = await db.pool.query<{ job: number; application: number; event_inbox: number }>(
    `select
       (select count(*)::int from recruitment.job where tenant_id = $1) as job,
       (select count(*)::int from recruitment.application where tenant_id = $1) as application,
       (select count(*)::int from recruitment.event_inbox where tenant_id = $1) as event_inbox`,
    [TENANT],
  )
  const row = result.rows[0]
  assert.ok(row !== undefined, '行数快照必须有一行')
  return row
}

/** 独立 SQL：按同一归一化口径 + 同一排序取命中 job id（不经过产品代码）。 */
async function expectedLookupIds(by: 'code' | 'title', normalizedQuery: string): Promise<string[]> {
  const column = by === 'code' ? 'code' : 'title'
  const result = await db.pool.query<{ id: string }>(
    `select id from recruitment.job
      where tenant_id = $1
        and position($2 in lower(btrim(replace(${column}, chr(12288), ' ')))) > 0
      order by code asc, title asc, id asc`,
    [TENANT, normalizedQuery],
  )
  return result.rows.map((row) => row.id)
}

/** 取一份值的 matches（保持顺序）。 */
function matchesOf(value: Record<string, unknown>): Array<Record<string, unknown>> {
  const matches = value.matches
  assert.ok(Array.isArray(matches), '出口值的 matches 必须是数组')
  return matches as Array<Record<string, unknown>>
}

/** DETAIL 相对 D-141 改动前**新增**的 5 个恒有键。 */
const ADDED_KEYS = ['mode', 'matched', 'needs_human_choice', 'next_tools', 'matches'] as const

/**
 * 去掉新增的 5 个恒有键，得到"改前形状"的那份值。
 * @param value - DETAIL 出口值。
 * @returns 只含既有 9 键的值（用于与 `readJobValue()` 逐字段比对）。
 */
function stripAddedKeys(value: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value }
  for (const key of ADDED_KEYS) delete copy[key]
  return copy
}

/** render 的文本（工具契约：渲染出的所有 text 块）。 */
function renderText(value: Record<string, unknown>): string {
  return tool.output.render({}, value).map((block) => block.text).join('\n')
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const HASH64_RE = /[0-9a-f]{64}/i
const LONG_HEX_RE = /[0-9a-f]{32,}/i

/** DSH 强制子集的 schema 合法关键字（本地副本，**不 import 宿主**）。 */
const SUPPORTED_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * 本地 schema 子集校验（照 `dsh-tools` 的强制子集写一份**最小**实现）。
 * @param schema - 待检查节点。
 * @param path - 诊断路径。
 * @returns 违反项文本列表（空 = 通过）。
 */
function schemaViolations(schema: unknown, path = 'schema'): string[] {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    return [`${path} 不是对象`]
  }
  const node = schema as Record<string, unknown>
  const out: string[] = []
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) out.push(`${path}.${key} 不是受支持的关键字`)
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) out.push(`${path} 不能同时声明 type 与 oneOf（DSH 校验器拒）`)
  if (hasType) {
    if (Array.isArray(node.type)) out.push(`${path}.type 是数组（DSH 不支持）`)
    else if (typeof node.type !== 'string' || !SCHEMA_TYPES.has(node.type)) out.push(`${path}.type 非法`)
  }
  if (!hasType && !hasOneOf) out.push(`${path} 既没有 type 也没有 oneOf`)
  const properties = node.properties as Record<string, unknown> | undefined
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      out.push(`${path}.properties 不是对象`)
    } else {
      for (const [key, child] of Object.entries(properties)) {
        out.push(...schemaViolations(child, `${path}.properties.${key}`))
      }
    }
  }
  const required = node.required as unknown
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((key) => typeof key !== 'string')) {
      out.push(`${path}.required 必须是字符串数组`)
    } else {
      for (const key of required as string[]) {
        if (properties === undefined || !Object.hasOwn(properties, key)) {
          out.push(`${path}.required 里的 ${key} 不在 properties 里（required ⊆ properties 被破坏）`)
        }
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    out.push(`${path}.additionalProperties 必须是 boolean`)
  }
  if (Array.isArray(node.oneOf)) {
    if (node.oneOf.length < 2) out.push(`${path}.oneOf 必须至少 2 个分支`)
    node.oneOf.forEach((branch, index) => out.push(...schemaViolations(branch, `${path}.oneOf[${index}]`)))
  } else if (hasOneOf) {
    out.push(`${path}.oneOf 必须是数组`)
  }
  if (node.items !== undefined) out.push(...schemaViolations(node.items, `${path}.items`))
  return out
}

/**
 * 本地值校验（type / enum / const / required / additionalProperties:false / items / oneOf 恰好命中一个）。
 * @param schema - 声明式 schema。
 * @param value - 待校验值。
 * @param path - 诊断路径。
 * @returns 违反项文本列表（空 = 通过）。
 */
function valueViolations(schema: unknown, value: unknown, path = 'value'): string[] {
  const node = schema as Record<string, unknown>
  const out: string[] = []
  if (Array.isArray(node.oneOf)) {
    const hits = (node.oneOf as unknown[]).filter((branch) => valueViolations(branch, value, path).length === 0)
    if (hits.length !== 1) out.push(`${path} oneOf 必须恰好命中一个分支（命中 ${hits.length} 个）`)
    return out
  }
  const type = node.type as string | undefined
  switch (type) {
    case 'null': if (value !== null) out.push(`${path} 必须是 null`); return out
    case 'string': if (typeof value !== 'string') out.push(`${path} 必须是 string`); break
    case 'integer': if (typeof value !== 'number' || !Number.isInteger(value)) out.push(`${path} 必须是 integer`); break
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path} 必须是 number`); break
    case 'boolean': if (typeof value !== 'boolean') out.push(`${path} 必须是 boolean`); break
    case 'array': if (!Array.isArray(value)) out.push(`${path} 必须是 array`); break
    case 'object':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        out.push(`${path} 必须是 object`)
        return out
      }
      break
    default: break
  }
  if (Array.isArray(node.enum) && !(node.enum as unknown[]).includes(value)) {
    out.push(`${path} 不在 enum 里：${JSON.stringify(value)}`)
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) out.push(`${path} 必须等于 ${JSON.stringify(node.const)}`)
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
        if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} 是未声明的键（additionalProperties:false）`)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (Object.hasOwn(properties, key)) out.push(...valueViolations(properties[key], child, `${path}.${key}`))
    }
  }
  return out
}

// ---------------------------------------------------------------------------
//  1. code 精确大小写 → 命中 1 条；status / current_rubric_version_no 与独立 SQL 一致
// ---------------------------------------------------------------------------

test('1) code 精确大小写命中 1 条：status / current_rubric_version_no 与独立 SQL 一致', async () => {
  // `DEMO-BE-001` 是 0002_seed 的演示岗位（status=OPEN，current_rubric_version_id 为空）。
  const value = await call({ code: 'DEMO-BE-001', as_of: AS_OF })
  assert.equal(value.tool, 'recruitment_job_get')
  assert.equal(value.contract_version, '1.0.0')
  assert.equal(value.mode, 'LOOKUP')
  assert.equal(value.matched, 1)
  assert.equal(value.needs_human_choice, false)
  assert.equal(value.as_of, AS_OF)
  assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' })
  // LOOKUP 没有读"某一个岗位的完整内容"：这些键是显式 null / 空数组（不是省键）。
  assert.equal(value.job, null)
  assert.equal(value.job_version, null)
  assert.equal(value.rubric, null)
  assert.equal(value.rubric_absence, null)
  assert.deepEqual(value.rubric_versions, [])

  const matches = matchesOf(value)
  assert.equal(matches.length, 1)
  const match = matches[0] as Record<string, unknown>
  assert.equal(match.job_id, DEMO_JOB)
  assert.equal(match.code, 'DEMO-BE-001')
  assert.equal(match.title, '后端工程师（演示）')
  assert.equal(match.status, 'OPEN')

  // 独立 SQL 读回：current_rubric_version_no 必须就是指针指向的版本号（不是 max(version_no) 推导）。
  const expected = await db.pool.query<{ version_no: number | null; status: string }>(
    `select rv.version_no, j.status
       from recruitment.job j
       left join recruitment.rubric_version rv
         on rv.id = j.current_rubric_version_id and rv.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2`,
    [DEMO_JOB, TENANT],
  )
  assert.equal(expected.rows[0]?.version_no, match.current_rubric_version_no)
  assert.equal(expected.rows[0]?.status, match.status)
  // 0004 迁移把演示岗位的 current 指针回填到 rubric v1 ⇒ 照实给版本号（不是 max() 推导）。
  assert.equal(match.current_rubric_version_no, 1)

  // 指针为空的岗位（自造 C：没有任何 rubric_version）⇒ 照实给 null，而不是省键或猜一个版本。
  const noRubric = await call({ code: 'SRE-003', as_of: AS_OF })
  const noRubricMatch = matchesOf(noRubric)[0] as Record<string, unknown>
  assert.equal(noRubricMatch.job_id, fixtures.cJobId)
  assert.equal(noRubricMatch.current_rubric_version_no, null)

  // 指针非空的另一条（自造岗位 A）：current_rubric_version_no 必须等于独立 SQL 的 version_no。
  const pointed = await call({ code: 'BE-PLATFORM-001', as_of: AS_OF })
  const pointedMatch = matchesOf(pointed)[0] as Record<string, unknown>
  const pointedExpected = await db.pool.query<{ version_no: number | null }>(
    `select rv.version_no
       from recruitment.job j
       left join recruitment.rubric_version rv
         on rv.id = j.current_rubric_version_id and rv.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2`,
    [fixtures.aJobId, TENANT],
  )
  assert.equal(pointedMatch.current_rubric_version_no, pointedExpected.rows[0]?.version_no)
  assert.equal(pointedMatch.current_rubric_version_no, 1)

  // 单命中的下一跳：按 job_id 读完整 JD / rubric（args_json 是 JSON 字符串）。
  const nextTools = value.next_tools as Array<Record<string, unknown>>
  assert.equal(nextTools.length, 1)
  assert.equal(nextTools[0]?.name, 'recruitment_job_get')
  assert.deepEqual(JSON.parse(String(nextTools[0]?.args_json)), { job_id: DEMO_JOB })
})

// ---------------------------------------------------------------------------
//  2. 小写前缀包含 / 中文包含
// ---------------------------------------------------------------------------

test('2) 小写前缀包含 + 中文包含都能命中（大小写不敏感、code/title 不互相串）', async () => {
  // 小写精确（大小写归一化的最小反证）：只命中演示岗位 DEMO-BE-001，不会因为大小写不同而 miss。
  const lowercase = await call({ code: 'demo-be-001', as_of: AS_OF })
  assert.equal(lowercase.matched, 1)
  assert.equal(matchesOf(lowercase)[0]?.job_id, DEMO_JOB)

  // 前缀包含：'demo-be' 同时命中演示岗位（大写）与自造岗位 B（小写）。
  const prefix = await call({ code: 'demo-be', as_of: AS_OF })
  assert.equal(prefix.mode, 'LOOKUP')
  assert.equal(prefix.matched, 2)
  assert.deepEqual(
    matchesOf(prefix).map((match) => match.code),
    ['DEMO-BE-001', 'demo-be-002'],
  )

  // 中文包含：'后端' 命中演示岗位与 B 的标题。
  const chineseContains = await call({ title: '后端', as_of: AS_OF })
  assert.equal(chineseContains.matched, 2)
  const ids = matchesOf(chineseContains).map((match) => match.job_id)
  assert.deepEqual(new Set(ids), new Set([DEMO_JOB, fixtures.bJobId]))

  // '后端工程师' 只命中演示岗位（B 的标题在全角空格处断开）：code 匹配不会串到 title、反之亦然。
  const byTitle = await call({ title: '后端工程师', as_of: AS_OF })
  assert.equal(byTitle.matched, 1)
  assert.equal(matchesOf(byTitle)[0]?.job_id, DEMO_JOB)

  // 反证 code/title 不互相串：code 片段不应命中 title 查询。
  const noCrossMatch = await call({ title: 'demo-be', as_of: AS_OF }).catch((error: unknown) => errorBody(error))
  assert.equal(noCrossMatch.code, 'NOT_FOUND')
  assert.equal(noCrossMatch.reason_code, 'JOB_NOT_FOUND')
})

// ---------------------------------------------------------------------------
//  3. 全角空格归一化（库值侧 + 查询串侧，同一口径）
// ---------------------------------------------------------------------------

test('3) 全角空格归一化：库值含 U+3000 / 查询串含 U+3000 都能命中', async () => {
  // 前置：夹具 B 的标题里**确实**是全角空格（否则本用例测不到 SQL 侧归一化）。
  const stored = await db.pool.query<{ title: string }>(
    'select title from recruitment.job where id = $1 and tenant_id = $2',
    [fixtures.bJobId, TENANT],
  )
  assert.ok(stored.rows[0]?.title.includes('\u3000'), '夹具 B 的标题必须含全角空格 U+3000')

  // 半角空格查询 → 命中 B：靠的是 **SQL 侧** `replace(col, chr(12288), ' ')` 把库值的全角空格变成半角。
  const halfWidth = await call({ title: '后端 工程师', as_of: AS_OF })
  assert.equal(halfWidth.matched, 1)
  assert.equal(matchesOf(halfWidth)[0]?.job_id, fixtures.bJobId)

  // 全角空格查询 → 命中 B：靠的是 **JS 侧** 归一化把查询串的全角空格变成半角。
  const fullWidth = await call({ title: '后端\u3000工程师', as_of: AS_OF })
  assert.equal(fullWidth.matched, 1)
  assert.equal(matchesOf(fullWidth)[0]?.job_id, fixtures.bJobId)

  // 首尾空白同样归一化（trim 后再做包含匹配）。
  const padded = await call({ code: '  demo-be-001\t', as_of: AS_OF })
  assert.equal(padded.matched, 1)
  assert.equal(matchesOf(padded)[0]?.job_id, DEMO_JOB)
})

// ---------------------------------------------------------------------------
//  4. 0 命中 → NOT_FOUND / JOB_NOT_FOUND，且零写入
// ---------------------------------------------------------------------------

test('4) 0 命中 → NOT_FOUND / JOB_NOT_FOUND（人话 message，不含 shell/文件/psql），零写入', async () => {
  const before = await tableCounts()
  const body = await expectFailure({ code: 'ZZZ-NOT-A-JOB', as_of: AS_OF }, 'code 0 命中')
  const after = await tableCounts()

  assert.equal(body.code, 'NOT_FOUND')
  assert.equal(body.reason_code, 'JOB_NOT_FOUND')
  assert.deepEqual(body.detail, {
    query: { by: 'code', value: 'ZZZ-NOT-A-JOB', normalized: 'zzz-not-a-job' },
  })
  const message = String(body.message)
  assert.match(message, /没有找到岗位/)
  assert.ok(message.includes('ZZZ-NOT-A-JOB'), `message 应回显查询片段（人话）：${message}`)
  assert.equal(/psql|shell|bash|命令行|文件路径/i.test(message), false, `message 不得提 shell/文件/psql：${message}`)
  // 0 命中是"查不到"而不是"写失败"：三张表行数前后全等。
  assert.deepEqual(after, before, '0 命中查询必须是零写入（job/application/event_inbox 行数不变）')

  // title 的 0 命中同样是 NOT_FOUND（且 detail 的 by 是 'title'）。
  const titleBody = await expectFailure({ title: '不存在的标题片段', as_of: AS_OF }, 'title 0 命中')
  assert.equal(titleBody.code, 'NOT_FOUND')
  assert.equal(titleBody.reason_code, 'JOB_NOT_FOUND')
  assert.deepEqual(titleBody.detail, {
    query: { by: 'title', value: '不存在的标题片段', normalized: '不存在的标题片段' },
  })
  assert.deepEqual(await tableCounts(), before, 'title 0 命中同样零写入')
})

// ---------------------------------------------------------------------------
//  5. 多命中：不替人挑 + 顺序确定 + render 不泄露完整 id
// ---------------------------------------------------------------------------

test('5) 多命中 → matched>=2 / needs_human_choice=true / next_tools=[]，顺序确定（与独立 SQL 一致）', async () => {
  const before = await tableCounts()
  const first = await call({ code: 'demo-be', as_of: AS_OF })
  const second = await call({ code: 'demo-be', as_of: AS_OF })
  const after = await tableCounts()

  assert.equal(first.mode, 'LOOKUP')
  assert.ok(Number(first.matched) >= 2, `多命中 matched 必须 >= 2，实际 ${String(first.matched)}`)
  assert.equal(first.needs_human_choice, true)
  assert.deepEqual(first.next_tools, [], '多命中不许给 next_tools（不替人挑）')
  // 确定性：同一查询两次结果完全一致。
  assert.deepEqual(second, first, '同一查询两次必须返回同一个值（确定性）')

  // 顺序确定：与独立 SQL 的 `order by code asc, title asc, id asc` 逐行一致。
  const expectedIds = await expectedLookupIds('code', 'demo-be')
  assert.deepEqual(matchesOf(first).map((match) => match.job_id), expectedIds)
  assert.ok(expectedIds.length >= 2)

  // 多命中也是零写入。
  assert.deepEqual(after, before, 'LOOKUP 多命中必须是零写入')
})

// ---------------------------------------------------------------------------
//  6. 负例：缺参 / 互斥 / 归一化后为空 / rubric 参数配 code —— 对应 reason_code + 零写入
// ---------------------------------------------------------------------------

test('6) 负例 4 类 → INVALID_ARGS 对应 reason_code，且零写入', async () => {
  const before = await tableCounts()

  // (a) 一个都没给 → MISSING_REQUIRED（message 列出 allowed 选择器）。
  const missing = await expectFailure({ as_of: AS_OF }, '缺参')
  assert.equal(missing.code, 'INVALID_ARGS')
  assert.equal(missing.reason_code, 'MISSING_REQUIRED')
  assert.deepEqual((missing.detail as Record<string, unknown>).allowed, ['job_id', 'code', 'title'])
  assert.match(String(missing.message), /job_id \/ code \/ title/)

  // (b) 给多于一个 → MUTUALLY_EXCLUSIVE，detail 带 given。
  const exclusive = await expectFailure({ job_id: fixtures.aJobId, code: 'DEMO' }, '两个选择器')
  assert.equal(exclusive.code, 'INVALID_ARGS')
  assert.equal(exclusive.reason_code, 'MUTUALLY_EXCLUSIVE')
  assert.deepEqual((exclusive.detail as Record<string, unknown>).given, {
    job_id: fixtures.aJobId,
    code: 'DEMO',
  })

  // (c) 归一化后为空 → TYPE_MISMATCH（明确拒绝，不静默当"没给"）。
  const blankCode = await expectFailure({ code: '   ' }, 'code 空白')
  assert.equal(blankCode.code, 'INVALID_ARGS')
  assert.equal(blankCode.reason_code, 'TYPE_MISMATCH')
  assert.deepEqual(blankCode.detail, { param: 'code', value: '   ', normalized: '' })
  const blankTitle = await expectFailure({ title: '\u3000\u3000' }, 'title 全角空白')
  assert.equal(blankTitle.code, 'INVALID_ARGS')
  assert.equal(blankTitle.reason_code, 'TYPE_MISMATCH')

  // (d) rubric_version_no 与 code 同给 → MUTUALLY_EXCLUSIVE（不静默忽略）。
  const rubricWithCode = await expectFailure(
    { code: 'DEMO-BE', rubric_version_no: 1, as_of: AS_OF },
    'rubric_version_no + code',
  )
  assert.equal(rubricWithCode.code, 'INVALID_ARGS')
  assert.equal(rubricWithCode.reason_code, 'MUTUALLY_EXCLUSIVE')
  assert.deepEqual((rubricWithCode.detail as Record<string, unknown>).given, {
    code: 'DEMO-BE',
    rubric_version_no: 1,
  })

  // 既有单查行为不回归：非 UUID 的 job_id 仍是 INVALID_ARGS / ID_NOT_UUID。
  const badId = await expectFailure({ job_id: 'job_0001' }, 'job_id 非 UUID')
  assert.equal(badId.code, 'INVALID_ARGS')
  assert.equal(badId.reason_code, 'ID_NOT_UUID')

  assert.deepEqual(await tableCounts(), before, '所有负例都必须零写入')
})

// ---------------------------------------------------------------------------
//  7. job_id 回归：与 readJobValue 同值、形状不变、NOT_FOUND 行为不变
// ---------------------------------------------------------------------------

test('7) job_id 回归：既有字段与 readJobValue() 逐字段相等、形状不变、新增 5 键恒有、NOT_FOUND 行为不变', async () => {
  const nowIso = new Date().toISOString()
  const viaTool = await call({ job_id: fixtures.aJobId, as_of: nowIso })

  const client: DatabaseClient = await db.pool.connect()
  try {
    const viaFunction = await readJobValue(client, cfg, { job_id: fixtures.aJobId }, nowIso)
    // 既有字段（去掉新增的 5 个恒有键）必须与 readJobValue 的输出**逐字段相同**。
    assert.deepEqual(stripAddedKeys(viaTool), viaFunction, 'DETAIL 的既有字段必须与改前（readJobValue）同值')
  } finally {
    client.release()
  }

  // 改后形状：既有 9 键 + 新增 5 键，一个不多一个不少。
  assert.deepEqual(Object.keys(viaTool).sort(), [
    'as_of', 'contract_version', 'job', 'job_version', 'labels', 'matched', 'matches', 'mode',
    'needs_human_choice', 'next_tools', 'rubric', 'rubric_absence', 'rubric_versions', 'tool',
  ])
  assert.equal(viaTool.mode, 'DETAIL')
  assert.equal(viaTool.matched, 1)
  assert.equal(viaTool.needs_human_choice, false)
  assert.deepEqual(viaTool.next_tools, [], 'DETAIL 不需要"下一跳 job_get"（自己就是）')

  const job = viaTool.job as Record<string, unknown>
  assert.equal(job.id, fixtures.aJobId)
  assert.equal(job.code, 'BE-PLATFORM-001')
  assert.equal(job.title, '平台工程师（含完整 rubric）')
  assert.equal(job.status, 'OPEN')

  const rubric = viaTool.rubric as Record<string, unknown>
  assert.equal(rubric.version_id, fixtures.aRubricId)
  assert.equal(rubric.resolution, 'JOB_CURRENT')
  assert.equal(rubric.is_current, true)
  assert.equal(rubric.is_approved, true)
  const versions = viaTool.rubric_versions as Array<Record<string, unknown>>
  assert.equal(versions.length, 1)
  assert.equal(versions[0]?.version_id, fixtures.aRubricId)
  assert.equal(versions[0]?.is_current, true)
  assert.equal(viaTool.rubric_absence, null)

  // DETAIL 的 matches 是本岗位一行摘要，current_rubric_version_no 与指针一致。
  assert.deepEqual(matchesOf(viaTool), [{
    job_id: fixtures.aJobId,
    code: 'BE-PLATFORM-001',
    title: '平台工程师（含完整 rubric）',
    status: 'OPEN',
    current_rubric_version_no: 1,
  }])

  // 同一个岗位：job_id 单查与 code 查找必须指向同一个 job_id。
  const byCode = await call({ code: 'BE-PLATFORM-001', as_of: AS_OF })
  assert.equal(matchesOf(byCode)[0]?.job_id, job.id)

  // NOT_FOUND 行为不变：detail 里仍是 job_id。
  const notFound = await expectFailure({ job_id: MISSING_JOB_ID }, 'job_id 不存在')
  assert.equal(notFound.code, 'NOT_FOUND')
  assert.equal(notFound.reason_code, 'JOB_NOT_FOUND')
  assert.deepEqual(notFound.detail, { job_id: MISSING_JOB_ID })
})

// ---------------------------------------------------------------------------
//  8. output schema 形状机检（本地小校验器，不 import 宿主）
// ---------------------------------------------------------------------------

test('8) output.schema：封闭根对象、既有消费面 labels 仍在、新增 5 键封闭、job 可空', () => {
  const schema = tool.output.schema as Record<string, unknown>

  // 根：统一封闭对象（DETAIL / LOOKUP 共用），**不是**根 oneOf ——
  // 既有断言 `test/unit/label-honesty.test.ts` 直接消费 `properties.labels` + 根 required 里的 'labels'。
  assert.equal(schema.type, 'object', '根必须是 object（DETAIL/LOOKUP 共用一个封闭根）')
  assert.equal(schema.additionalProperties, false, '根必须封闭（additionalProperties:false）')
  assert.equal(Object.hasOwn(schema, 'oneOf'), false, '根不再是 oneOf（既有消费面要求 properties.labels）')
  const properties = schema.properties as Record<string, unknown>
  assert.ok(typeof properties === 'object' && properties !== null, '根必须有 properties')
  const required = schema.required as string[]
  assert.ok(Array.isArray(required))

  // 既有消费面（label-honesty.test.ts 直接读它）：labels 必须在 properties 与 required 里。
  assert.ok(Object.hasOwn(properties, 'labels'), '根 properties.labels 必须存在（既有消费面）')
  assert.ok(required.includes('labels'), '根 required 必须含 labels（既有消费面）')
  const labels = properties.labels as Record<string, unknown>
  assert.deepEqual(labels.required, ['provenance', 'trigger', 'connection'])
  assert.deepEqual((labels.properties as Record<string, unknown>).trigger, { type: 'string', enum: ['MANUAL'] })

  // 既有 9 个键一个不少；新增 5 个恒有键也都在 required 里。
  for (const key of [
    'tool', 'contract_version', 'labels', 'as_of', 'job', 'job_version', 'rubric', 'rubric_absence', 'rubric_versions',
  ]) {
    assert.ok(required.includes(key), `既有键 ${key} 必须仍在 required 里`)
    assert.ok(Object.hasOwn(properties, key), `既有键 ${key} 必须仍在 properties 里`)
  }
  for (const key of ['mode', 'matched', 'needs_human_choice', 'next_tools', 'matches']) {
    assert.ok(required.includes(key), `新增恒有键 ${key} 必须在 required 里`)
    assert.ok(Object.hasOwn(properties, key), `新增恒有键 ${key} 必须在 properties 里`)
  }
  // required ⊆ properties，且整棵树在本地子集内。
  for (const key of required) assert.ok(Object.hasOwn(properties, key), `required.${key} 必须声明在 properties 里`)
  assert.deepEqual(schemaViolations(schema), [], '根 schema 必须在本地区间子集内')

  // job 从"必填对象"改成"可空 oneOf"：对象分支与改前**逐字一致**，仍在 required 里。
  const job = properties.job as Record<string, unknown>
  const jobBranches = job.oneOf as Array<Record<string, unknown>>
  assert.equal(jobBranches.length, 2)
  assert.deepEqual(jobBranches[1], { type: 'null' })
  const jobObject = jobBranches[0] as Record<string, unknown>
  assert.equal(jobObject.type, 'object')
  assert.equal(jobObject.additionalProperties, false)
  assert.deepEqual(jobObject.required, [
    'id', 'code', 'title', 'status', 'department_id', 'requisition_id',
    'current_job_version_id', 'record_version', 'status_changed_at',
  ])
  assert.ok(required.includes('job'), 'job 仍在 required 里（DETAIL 恒给对象、LOOKUP 恒给 null）')

  // 新字段形状。
  assert.deepEqual(properties.mode, { type: 'string', enum: ['DETAIL', 'LOOKUP'] })
  assert.deepEqual(properties.matched, { type: 'integer' })
  assert.deepEqual(properties.needs_human_choice, { type: 'boolean' })
  const nextTools = properties.next_tools as Record<string, unknown>
  const nextToolItem = nextTools.items as Record<string, unknown>
  assert.equal(nextToolItem.type, 'object')
  assert.equal(nextToolItem.additionalProperties, false)
  assert.deepEqual(nextToolItem.required, ['name', 'reason', 'args_json'])
  const matches = properties.matches as Record<string, unknown>
  const matchItem = matches.items as Record<string, unknown>
  assert.equal(matchItem.type, 'object')
  assert.equal(matchItem.additionalProperties, false)
  assert.deepEqual(matchItem.required, ['job_id', 'code', 'title', 'status', 'current_rubric_version_no'])
  // current_rubric_version_no 可空（指针为空/查不到照实给 null）。
  assert.deepEqual((matchItem.properties as Record<string, unknown>).current_rubric_version_no, {
    oneOf: [{ type: 'integer' }, { type: 'null' }],
  })

  // 值级：两种模式的值都必须过本地校验（required 齐全、无未声明键、可空字段合法）。
  const jobObjectSample = {
    id: fixtures.aJobId,
    code: 'DEMO-BE-001',
    title: '后端工程师（演示）',
    status: 'OPEN',
    department_id: DEMO_DEPARTMENT,
    requisition_id: null,
    current_job_version_id: fixtures.aJobVersionId,
    record_version: 1,
    status_changed_at: AS_OF,
  }
  const matchSample = {
    job_id: fixtures.aJobId,
    code: 'DEMO-BE-001',
    title: '后端工程师（演示）',
    status: 'OPEN',
    current_rubric_version_no: 1,
  }
  const detailSample = {
    tool: 'recruitment_job_get',
    contract_version: '1.0.0',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    as_of: AS_OF,
    mode: 'DETAIL',
    matched: 1,
    needs_human_choice: false,
    next_tools: [],
    matches: [matchSample],
    job: jobObjectSample,
    job_version: null,
    rubric: null,
    rubric_absence: { code: 'NO_RUBRIC_AT_ALL', message: 'x', violations: [] },
    rubric_versions: [],
  }
  const lookupSample = {
    tool: 'recruitment_job_get',
    contract_version: '1.0.0',
    labels: { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' },
    as_of: AS_OF,
    mode: 'LOOKUP',
    matched: 1,
    needs_human_choice: false,
    next_tools: [{ name: 'recruitment_job_get', reason: 'r', args_json: '{"job_id":"x"}' }],
    matches: [matchSample],
    job: null,
    job_version: null,
    rubric: null,
    rubric_absence: null,
    rubric_versions: [],
  }
  assert.deepEqual(valueViolations(schema, detailSample), [], 'DETAIL 样本必须过本地 schema 校验')
  assert.deepEqual(valueViolations(schema, lookupSample), [], 'LOOKUP 样本必须过本地 schema 校验')
  // 可空版本号的两个取值都要合法（指针为空 / 有当前版本）。
  assert.deepEqual(
    valueViolations(schema, { ...lookupSample, matches: [{ ...matchSample, current_rubric_version_no: null }] }),
    [],
  )

  // 反证：少 required 键 / 多未声明键 / mode 越界都必须被本地值校验抓到。
  const missing = { ...lookupSample } as Record<string, unknown>
  delete missing.matches
  assert.notDeepEqual(valueViolations(schema, missing), [], '少 required 键必须被抓到')
  assert.notDeepEqual(valueViolations(schema, { ...lookupSample, payload_hash: 'x' }), [], '多未声明键必须被抓到')
  assert.notDeepEqual(valueViolations(schema, { ...lookupSample, mode: 'SEARCH' }), [], 'mode 越界必须被抓到')
})

// ---------------------------------------------------------------------------
//  9. LOOKUP 的 render：人读正文只给业务标识 / 短号，完整 job_id 只在 machine arguments 区
// ---------------------------------------------------------------------------

test('9) LOOKUP render：人读正文零完整 UUID/64hex，完整 job_id 只在 machine arguments 区', async () => {
  const single = await call({ code: 'DEMO-BE-001', as_of: AS_OF })
  const singleText = renderText(single)
  assert.match(singleText, /岗位查询：命中 1 个岗位/)
  assert.ok(singleText.includes('DEMO-BE-001'), '人读正文必须给岗位 code')
  assert.ok(singleText.includes('后端工程师（演示）'), '人读正文必须给岗位标题')
  assert.ok(singleText.includes(`…${DEMO_JOB.slice(-4)}`), '人读正文必须给短号（UUID 末 4 位）')

  const headerIndex = singleText.indexOf('machine arguments')
  assert.ok(headerIndex > 0, '单命中必须给 machine arguments 机器参数区（模型要复制 job_id）')
  assert.match(singleText.slice(headerIndex), /never show ids or hashes to the human/)
  const human = singleText.slice(0, headerIndex)
  for (const [kind, re] of [['完整 UUID', UUID_RE], ['完整 64hex', HASH64_RE], ['32+ 连续 hex', LONG_HEX_RE]] as const) {
    assert.equal(re.test(human), false, `人读正文不得出现${kind}：\n${human}`)
  }
  assert.ok(singleText.slice(headerIndex).includes(`job_id=${DEMO_JOB}`), '完整 job_id 必须出现在机器参数区')

  // 多命中：仍不替人挑（正文明示"必须让 HR 选定一个"），两个 job_id 都只出现在机器参数区。
  const multi = await call({ code: 'demo-be', as_of: AS_OF })
  const multiText = renderText(multi)
  assert.match(multiText, /命中多个岗位：必须让 HR 选定一个/)
  assert.deepEqual(multi.next_tools, [], '多命中不替人挑：next_tools 必须是空数组')
  const multiHeader = multiText.indexOf('machine arguments')
  assert.ok(multiHeader > 0)
  const multiHuman = multiText.slice(0, multiHeader)
  assert.equal(UUID_RE.test(multiHuman), false, `多命中人读正文不得出现完整 UUID：\n${multiHuman}`)
  const multiMachine = multiText.slice(multiHeader)
  for (const match of matchesOf(multi)) {
    assert.ok(multiMachine.includes(`job_id=${String(match.job_id)}`), '每个命中都必须能在机器参数区被复制')
  }
})
