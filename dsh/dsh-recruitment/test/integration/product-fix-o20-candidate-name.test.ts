// O20 产品视角修复的集成证据：`recruitment_application_get` 支持"按候选人姓名查申请"。
//
// 为什么需要（product-review O20）：HR 的真实说法是"候选人张样例这次申请……"，不带 UUID。
// 修之前 Agent 找不到一等业务读入口，退化成文件搜索，最后请求 `plugin_manager` 的
// danger-full-access 审批。本文件证明的是**业务行为**，不是"函数能跑"：
//   1. 姓名子串命中 1 条 → `query.mode='LIST'`、回显归一化姓名、字段真值与夹具一致、
//      `needs_human_choice=false`、`next_tools` 仍指向产品工具（不掉到 shell/文件）；
//   2. 大小写/空白归一化 → display_name 形如 ` O18  Probe  Name `，用 `o18 probe name` 命中；
//   3. 0 命中 → `NOT_FOUND` / `CANDIDATE_NAME_NOT_FOUND` 人话，message **不提** shell/psql/
//      文件/命令，且 application/candidate 行数 before==after（零写入、不返回假数据）；
//   4. 多命中 → `needs_human_choice=true` 且 `next_tools=[]`（绝不替人挑一条）；
//   5. 入参校验（纯函数）与真工具路径（真连库、只读）。
//
// 纪律：夹具一律在 `inRolledBackTx` 里 INSERT/UPDATE（`seedScenario` + 改名），工具核心函数在
// 同一事务里读，测试库由 env `RECRUITMENT_TEST_DB` 指定（本 lane 用一次性库 ra_fix_rem_test）。
// 注意 `0002_seed` 自带 `演示候选人-张样例` 与其申请：本文件一律用独有名字，避免和种子行串味。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  APPLICATION_GET_TOOL,
  MATERIAL_READ_TOOL,
  createApplicationGetTool,
  normalizeCandidateName,
  parseApplicationGetArgs,
  readApplicationValue,
} from '../../src/tools/business-read.ts'
import { RecruitmentToolError } from '../../src/tools/errors.ts'
import {
  TENANT,
  createTestPool,
  errorBody,
  inRolledBackTx,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 事务内连接（与 `inRolledBackTx` 的回调同型）。 */
type TxClient = Parameters<Parameters<typeof inRolledBackTx>[1]>[0]

/** 两条真实形状的 rubric 维度（与 0002_seed 的机械条件同形；本文件只读它们，不重算规则）。 */
const DIMENSIONS = [
  {
    key: 'work_exists',
    kind: 'MUST_HAVE',
    field: 'work_experience',
    label: '有工作经历',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
  },
  {
    key: 'edu_exists',
    kind: 'MUST_HAVE',
    field: 'education',
    label: '有教育经历',
    value: true,
    weight: 0.5,
    operator: 'EXISTS',
  },
]

/**
 * 造一份完整夹具（job → job_version → rubric(+approval) → candidate → 材料 → application）。
 * @param client - 事务连接。
 * @returns 夹具 id 集合。
 */
async function seed(client: TxClient) {
  return await seedScenario(client, { dimensions: DIMENSIONS, fields: parsedFields() })
}

/**
 * 把夹具候选人的姓名改成业务里的真实说法（`seedScenario` 只写默认名）。
 * @param client - 事务连接。
 * @param candidateId - 候选人 id。
 * @param displayName - 新姓名（允许前后/连续空白，`ck_candidate_name` 只要求 btrim 非空）。
 */
async function renameCandidate(client: TxClient, candidateId: string, displayName: string): Promise<void> {
  await client.query('update recruitment.candidate set display_name = $1 where id = $2', [displayName, candidateId])
}

/**
 * 取一个 Promise 的拒绝原因（不依赖 `assert.rejects` 的返回值形态）。
 * @param fn - 期望抛错的调用。
 * @returns 抛出的错误。
 */
async function rejectionOf(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the call to reject, but it resolved')
}

/**
 * 库里的申请/候选人行数（O20 零写入断言用）。
 * @param client - 事务连接。
 * @returns 两张表的行数。
 */
async function rowCounts(client: TxClient): Promise<{ applications: number; candidates: number }> {
  const { rows } = await client.query<{ applications: number; candidates: number }>(
    `select (select count(*) from recruitment.application)::int as applications,
            (select count(*) from recruitment.candidate)::int as candidates`,
  )
  const row = rows[0]
  assert.ok(row !== undefined)
  return row
}

/** 给一条夹具再插一个"同名前缀"的候选人与申请（多命中场景；复用第一条的 job/rubric/材料）。 */
async function addSecondApplication(
  client: TxClient,
  first: Awaited<ReturnType<typeof seed>>,
  displayName: string,
): Promise<{ candidateId: string; applicationId: string }> {
  const candidateId = randomUUID()
  await client.query(
    `insert into recruitment.candidate (id, tenant_id, display_name, identity_status)
     values ($1, $2, $3, 'ACTIVE')`,
    [candidateId, TENANT, displayName],
  )
  const applicationId = randomUUID()
  await client.query(
    `insert into recruitment.application
       (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
        lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 'S7')`,
    [
      applicationId, TENANT, candidateId, first.jobId, first.jobVersionId,
      first.rubricId, first.resumeVersionId,
    ],
  )
  return { candidateId, applicationId }
}

// ---------------------------------------------------------------------------
//  1) 子串命中 1 条
// ---------------------------------------------------------------------------

test('O20：姓名子串命中 1 条 —— LIST 回显/字段真值/needs_human_choice=false/next_tools 非空', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const displayName = 'O20 子串候选人-唯一甲'
    await renameCandidate(client, scenario.candidateId, displayName)

    // 故意只给姓名的一部分（不是全等），证明是"包含匹配"而不是精确匹配。
    const value = await readApplicationValue(client, cfg, { candidate_name: '子串候选人-唯一甲' })

    assert.equal(value.tool, APPLICATION_GET_TOOL)
    assert.equal(value.query.mode, 'LIST')
    assert.equal(value.query.matched, 1)
    assert.equal(value.query.limit, 10)
    assert.equal(value.query.candidate_name, '子串候选人-唯一甲')
    assert.equal(value.needs_human_choice, false)
    assert.equal(value.applications.length, 1)

    const application = value.applications[0]
    assert.ok(application !== undefined)
    assert.equal(application.application_id, scenario.applicationId)
    assert.equal(application.candidate.candidate_id, scenario.candidateId)
    // 姓名按库里的事实回显（不做改写），命中是子串归一化后的结果。
    assert.equal(application.candidate.display_name, displayName)
    assert.equal(application.candidate.identity_status, 'ACTIVE')
    assert.match(application.job.code, /^T-/)
    assert.equal(application.job.title, '集成测试岗位')
    assert.equal(application.job.status, 'OPEN')
    assert.equal(application.stage_code, 'S7')
    assert.equal(application.lifecycle_status, 'ACTIVE')

    // 命中唯一一条时，下一步建议照旧指向产品工具（不掉到 shell/文件）。
    assert.ok(value.next_tools.some((item) => item.name === MATERIAL_READ_TOOL))

    const tool = createApplicationGetTool({ database: cfg })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    assert.match(text, /query: LIST matched=1 candidate_name=子串候选人-唯一甲/)
    assert.doesNotMatch(text, /needs human choice/)
  })
})

// ---------------------------------------------------------------------------
//  2) 大小写 / 空白归一化
// ---------------------------------------------------------------------------

test('O20：大小写与空白归一化 —— ` O18  Probe  Name ` 用 `o18 probe name` 命中', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const displayName = ' O18  Probe  Name '
    await renameCandidate(client, scenario.candidateId, displayName)

    // 纯函数口径先钉住：折叠连续空白 + 去首尾 + 小写。
    assert.equal(normalizeCandidateName(' \t O18   Probe  Name \n '), 'o18 probe name')

    const value = await readApplicationValue(client, cfg, { candidate_name: 'o18 probe name' })
    assert.equal(value.query.mode, 'LIST')
    assert.equal(value.query.matched, 1)
    assert.equal(value.query.candidate_name, 'o18 probe name')
    assert.equal(value.needs_human_choice, false)
    assert.equal(value.applications[0]?.candidate.display_name, displayName)

    // 反向也成立：模型给大小写混排 + 多余空白的说法，归一化后照样命中，回显是同一个归一化值。
    const messy = await readApplicationValue(client, cfg, { candidate_name: '  O18   Probe   Name  ' })
    assert.equal(messy.query.matched, 1)
    assert.equal(messy.query.candidate_name, 'o18 probe name')
    assert.equal(messy.applications[0]?.application_id, scenario.applicationId)
  })
})

// ---------------------------------------------------------------------------
//  3) 0 命中：人话 NOT_FOUND + 零写入
// ---------------------------------------------------------------------------

test('O20：0 命中 → NOT_FOUND/CANDIDATE_NAME_NOT_FOUND，人话且不提 shell/psql/文件/命令，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 先造一份"存在的同租户数据"，确保 0 命中不是因为库是空的（也不是因为租户不对）。
    await seed(client)
    const before = await rowCounts(client)

    const error = await rejectionOf(() => readApplicationValue(client, cfg, { candidate_name: '绝无此人XYZ' }))
    assert.ok(error instanceof RecruitmentToolError, '必须是工具契约错误（不是 SQL/连接错误）')
    assert.equal((error as RecruitmentToolError).code, 'NOT_FOUND')
    assert.match(error.message, /^NOT_FOUND: /)

    const body = errorBody(error)
    assert.equal(body.reason_code, 'CANDIDATE_NAME_NOT_FOUND')
    // NOT_FOUND 文案里的姓名与 SQL/回显同一份归一化口径（小写）。
    assert.equal(body.candidate_name, '绝无此人xyz')
    assert.match(String(body.message), /没有找到姓名包含/)
    assert.match(String(body.message), /绝无此人xyz/)
    // 关键产品约束：坏建议会诱发 shell/文件搜索（这正是 O20 的成因），所以一个字都不许出现。
    assert.doesNotMatch(String(body.message), /shell|psql|文件|命令/i)
    assert.doesNotMatch(error.message, /shell|psql|文件|命令/i)

    const after = await rowCounts(client)
    assert.deepEqual(after, before, '按姓名查 0 命中必须零写入')
  })
})

// ---------------------------------------------------------------------------
//  4) 多命中：必须问人
// ---------------------------------------------------------------------------

test('O20：多命中 → needs_human_choice=true 且 next_tools=[]（不替人挑一条）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const first = await seed(client)
    await renameCandidate(client, first.candidateId, 'O20 多命中-甲乙')
    const second = await addSecondApplication(client, first, 'O20 多命中-丙丁')

    const value = await readApplicationValue(client, cfg, { candidate_name: '多命中' })
    assert.equal(value.query.mode, 'LIST')
    assert.equal(value.query.matched, 2)
    assert.equal(value.query.candidate_name, '多命中')
    assert.equal(value.applications.length, 2)
    // 系统不替人做选择：没有 next_tools 的暗示，Agent 必须先问 HR。
    assert.equal(value.needs_human_choice, true)
    assert.deepEqual(value.next_tools, [])
    assert.deepEqual(
      value.applications.map((item) => item.application_id).sort(),
      [first.applicationId, second.applicationId].sort(),
    )
    assert.deepEqual(
      value.applications.map((item) => item.candidate.display_name).sort(),
      ['O20 多命中-丙丁', 'O20 多命中-甲乙'].sort(),
    )

    const tool = createApplicationGetTool({ database: cfg })
    const text = tool.output.render({}, value).map((block) => block.text).join('\n')
    assert.match(text, /needs human choice: 2 applications match candidate "多命中"/)
    assert.match(text, /do not pick one automatically/)
    // 没有 next_tools 渲染块：不给"拿第一条去读材料/看岗位"的暗示。
    assert.doesNotMatch(text, /next tools \(use these, not shell\/psql\)/)
  })
})

// ---------------------------------------------------------------------------
//  5) 入参校验（纯函数，不连库）
// ---------------------------------------------------------------------------

test('O20：入参校验 —— 互斥 / 缺筛选 / 空白姓名 / 与 job_id 组合允许', () => {
  const applicationId = randomUUID()
  const jobId = randomUUID()

  // candidate_name 与 application_id 互斥（单条 vs 列表，不能混）。
  assert.throws(
    () => parseApplicationGetArgs({ application_id: applicationId, candidate_name: '张样例' }),
    /MUTUALLY_EXCLUSIVE/,
  )
  // 一个过滤条件都没有 → MISSING_FILTER，且 message 明确列出 candidate_name。
  assert.throws(() => parseApplicationGetArgs({}), /MISSING_FILTER[\s\S]*candidate_name/)
  // 归一化后为空（空白串/空串）→ INVALID_ARGS + CANDIDATE_NAME_EMPTY（不能当成"没给筛选项"）。
  assert.throws(() => parseApplicationGetArgs({ candidate_name: '   ' }), /CANDIDATE_NAME_EMPTY/)
  assert.throws(() => parseApplicationGetArgs({ candidate_name: ' \t\n ' }), /CANDIDATE_NAME_EMPTY/)
  assert.throws(() => parseApplicationGetArgs({ candidate_name: '' }), /CANDIDATE_NAME_EMPTY/)

  // 允许的组合：candidate_name 与 job_id/stage/lifecycle 是 AND；返回归一化值。
  assert.deepEqual(
    parseApplicationGetArgs({ candidate_name: '  O18   Probe  Name ', job_id: jobId }),
    { candidate_name: 'o18 probe name', job_id: jobId },
  )
  assert.deepEqual(parseApplicationGetArgs({ candidate_name: '张样例' }), { candidate_name: '张样例' })
})

// ---------------------------------------------------------------------------
//  6) 真工具路径：真连库、只读、拒绝不存在的姓名
// ---------------------------------------------------------------------------

test('O20：真工具路径 execute({candidate_name}) 真连库只读，未知姓名拒绝 NOT_FOUND', async () => {
  const tool = createApplicationGetTool({ database: cfg })
  // 不经过 readApplicationValue 直调：证明模型看到的那条入口（execute）也走同一套校验与错误。
  const error = await rejectionOf(() => tool.execute({ candidate_name: '绝无此人XYZ' }, {}))
  assert.ok(error instanceof RecruitmentToolError)
  assert.equal((error as RecruitmentToolError).code, 'NOT_FOUND')
  assert.match(error.message, /CANDIDATE_NAME_NOT_FOUND/)
  assert.equal(errorBody(error).reason_code, 'CANDIDATE_NAME_NOT_FOUND')
})

// ---------------------------------------------------------------------------
//  7) 形状 / 可发现性：参数、输出 schema 封闭根、描述
// ---------------------------------------------------------------------------

test('O20：参数与输出 schema —— candidate_name 可传、根封闭、needs_human_choice 必填、描述可发现', () => {
  const tool = createApplicationGetTool({ database: cfg })

  const parameters = tool.parameters as {
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: unknown
  }
  assert.equal(parameters.additionalProperties, false)
  const candidateParam = parameters.properties.candidate_name
  assert.ok(candidateParam !== undefined, '参数 schema 必须声明 candidate_name')
  assert.equal(candidateParam.type, 'string')
  assert.equal(typeof candidateParam.description, 'string')
  // 大小写/空白不敏感、只用于列表 —— 这些都是模型必须读到的约束。
  assert.match(String(candidateParam.description), /case-insensitive/)
  assert.match(String(candidateParam.description), /whitespace/)
  assert.match(String(candidateParam.description), /list/)
  assert.match(String(candidateParam.description), /needs_human_choice/)
  assert.ok(!parameters.required.includes('candidate_name'), 'candidate_name 必须是可选参数')

  const root = tool.output.schema as {
    properties: Record<string, Record<string, unknown>>
    required: string[]
    additionalProperties: unknown
  }
  assert.equal(root.additionalProperties, false)
  assert.ok(root.required.includes('needs_human_choice'), 'needs_human_choice 必须进 required')
  assert.deepEqual(root.properties.needs_human_choice, { type: 'boolean' })
  const query = root.properties.query as {
    properties: Record<string, Record<string, unknown>>
    additionalProperties: unknown
  }
  assert.equal(query.additionalProperties, false)
  assert.deepEqual(query.properties.candidate_name, { type: 'string' })

  // 工具描述（模型可见）是 O20 的可发现性关键：必须说清"怎么用 / 多命中要问人 / 0 命中别去搜文件"。
  assert.match(tool.description, /candidate_name/)
  assert.match(tool.description, /case-insensitive/)
  assert.match(tool.description, /needs_human_choice=true/)
  assert.match(tool.description, /CANDIDATE_NAME_NOT_FOUND/)
  assert.match(tool.description, /do not fall back to shell/)
})
