// `recruitment_application_get` / `recruitment_material_read` 的集成矩阵（**连真库 ra_s6s7**，
// 每个用例结束 ROLLBACK，不污染共享库）。
//
// 2026-11-16（task-75）：这两个工具是产品/业务 FAIL 的修复 —— Agent 不再需要 shell/psql/源码绕路
// 去读"申请/材料/岗位/rubric"。本文件证明的是**业务事实与边界**，不是"函数能跑"：
//   1. 真库读回：申请 → 候选人 → 岗位 → 钉住 rubric → 材料 → 面试/转写/面评/决策摘要；
//   2. 列表筛选：job_id / stage_code / lifecycle_status / limit；
//   3. PII 最小化：默认脱敏、include_contacts 才给原文、材料 quote 对联系方式默认不回显；
//   4. 材料：两个哈希分开（source_asset_sha256 = 原件字节；content_sha256 = 解析投影）、
//      结构摘要/定位器真实、TEXT 模式在文件不可达时 fail-closed（available=false + 闭集 reason）；
//   5. 反证：未知 id / 越界筛选组合 / 非 UUID / 无材料申请 → 明确错误码，不编造；
//   6. 只读：`withReadOnly` 的事务里写语句被数据库直接拒（25006）；
//   7. 逐根材料定位：一个根把预算用光不会把另一个根里的材料误报成"不存在"。
//
// 纪律：夹具一律在 `inRolledBackTx` 里直接 INSERT；工具核心函数（`readApplicationValue` /
// `readMaterialValue`）在同一事务里读，保证看得到夹具；不写 ra_s6s7。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  APPLICATION_GET_TOOL,
  MATERIAL_READ_TOOL,
  createApplicationGetTool,
  createMaterialReadTool,
  createBusinessReadTools,
  parseApplicationGetArgs,
  parseMaterialReadArgs,
  readApplicationValue,
  readMaterialValue,
  resolveMaterialPathAcrossRoots,
  summarizeParsedFields,
  unconfiguredBusinessReadTools,
} from '../../src/tools/business-read.ts'
import type { ResolvedConverterConfig } from '../../src/tools/converter.ts'
import { withReadOnly } from '../../src/db/pool.ts'
import {
  TENANT,
  createTestPool,
  inRolledBackTx,
  parsedFields,
  seedScenario,
  testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

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
 * 造一份完整夹具：job → job_version → rubric(+approval) → candidate → 材料 → application。
 * @param client - 事务连接。
 * @param options - 覆盖项（透传 `seedScenario`；dimensions 由本文件固定，不再重复传）。
 * @returns 夹具 id 集合。
 */
async function seed(
  client: Parameters<Parameters<typeof inRolledBackTx>[1]>[0],
  options: Omit<Parameters<typeof seedScenario>[1], 'dimensions'> = {},
) {
  return await seedScenario(client, {
    dimensions: DIMENSIONS,
    fields: parsedFields(),
    ...options,
  })
}

/** sha256 形状的 64 位 hex（与测试底座的 hex64 一致的口径）。 */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
//  application_get
// ---------------------------------------------------------------------------

test('application_get：真库读回一条申请（申请人/岗位/阶段/rubric 指针/材料/决策摘要）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const value = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })

    assert.equal(value.tool, APPLICATION_GET_TOOL)
    assert.equal(value.tool_kind, 'READ_ONLY')
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' })
    assert.deepEqual(value.query.mode, 'ONE')
    assert.equal(value.query.matched, 1)

    const application = value.applications[0]
    assert.equal(application.application_id, scenario.applicationId)
    assert.equal(application.stage_code, 'S7')
    assert.equal(application.lifecycle_status, 'ACTIVE')
    assert.equal(application.record_version, 1)

    // 候选人：姓名是业务必需（不改写）；联系方式默认脱敏。
    assert.equal(application.candidate.candidate_id, scenario.candidateId)
    assert.match(application.candidate.display_name, /^测试候选人-/)
    assert.equal(application.candidate.identity_status, 'ACTIVE')
    assert.equal(application.candidate.contacts.visible, false)
    // 夹具候选人本来没有邮箱/手机：空值原样返回（不编造），visible=false。
    assert.deepEqual(application.candidate.contacts, { visible: false, email: '', phone: '' })

    // 岗位：code/title 真读；rubric 钉住版本 = application.rubric_version_id。
    assert.equal(application.job.job_id, scenario.jobId)
    assert.match(application.job.code, /^T-/)
    assert.equal(application.job.title, '集成测试岗位')
    assert.equal(application.job.status, 'OPEN')
    assert.ok(application.rubric !== undefined)
    assert.equal(application.rubric.rubric_version_id, scenario.rubricId)
    assert.equal(application.rubric.version_no, 1)
    assert.equal(application.rubric.source, 'APPLICATION_PIN')
    assert.equal(application.rubric.approved, true)
    assert.equal(application.rubric.criteria_count, 2)
    assert.match(application.rubric.payload_hash ?? '', /^[0-9a-f]{64}$/)

    // 材料：parse_status/页数/hard issue；原件 sha 与 product 解析投影 sha 分开。
    assert.ok(application.material !== undefined)
    assert.equal(application.material.resume_version_id, scenario.resumeVersionId)
    assert.equal(application.material.parse_status, 'PARSED')
    assert.equal(application.material.pages, 1)
    assert.equal(application.material.hard_issue_codes.length, 0)
    assert.ok(application.material.asset !== undefined)
    assert.equal(application.material.asset.file_name, 'test.pdf')
    assert.match(application.material.asset.sha256, /^[0-9a-f]{64}$/)
    assert.notEqual(application.material.source_asset_sha256, application.material.content_sha256)

    // 家族事实：没有面试/转写/面评/决策时如实计数 0（不编造）。
    // O14：`evaluations` 的口径改为「跨轮必交面评汇总」（与 interview_get 同一派生函数），
    // 旧键保留、数值改为同一真值；新键显式说明这是跨轮合计（本断言随之改为新形状 —— 收紧，不是放宽）。
    assert.deepEqual(application.interviews, { count: 0, items: [] })
    assert.deepEqual(application.transcripts, { count: 0, ready_count: 0 })
    assert.deepEqual(application.evaluations, {
      scorecard_count: 0,
      submitted_count: 0,
      scorecards_required_total: 0,
      scorecards_submitted_total: 0,
      scorecards_waived_total: 0,
      scorecards_pending_total: 0,
    })
    assert.deepEqual(application.decisions, { count: 0 })

    // 下一步建议只指向产品工具（避免下沉到 shell/psql）。
    assert.ok(value.next_tools.some((item) => item.name === MATERIAL_READ_TOOL))
    assert.ok(value.next_tools.some((item) => item.name === 'recruitment_job_get'))
  })
})

test('application_get：列表筛选（job_id / stage_code / lifecycle_status / limit）与回显', async () => {
  await inRolledBackTx(pool, async (client) => {
    const first = await seed(client)
    // 同一岗位的第二条申请：直接插夹具（seedScenario 会为给定 jobId 再插一个 version_no=1 的
    // job_version，撞 uq_job_version；这里复用第一条的版本行）。
    const secondCandidateId = randomUUID()
    await client.query(
      `insert into recruitment.candidate (id, tenant_id, display_name, identity_status)
       values ($1, $2, '列表筛选候选人（合成）', 'ACTIVE')`,
      [secondCandidateId, TENANT],
    )
    const secondApplicationId = randomUUID()
    await client.query(
      `insert into recruitment.application
         (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
          lifecycle_status, current_stage_code)
       values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 'S7')`,
      [
        secondApplicationId, TENANT, secondCandidateId, first.jobId, first.jobVersionId,
        first.rubricId, first.resumeVersionId,
      ],
    )

    const byJob = await readApplicationValue(client, cfg, { job_id: first.jobId })
    assert.equal(byJob.query.mode, 'LIST')
    assert.equal(byJob.query.matched, 2)
    assert.deepEqual(
      byJob.applications.map((item) => item.application_id).sort(),
      [first.applicationId, secondApplicationId].sort(),
    )

    const byStage = await readApplicationValue(client, cfg, { job_id: first.jobId, stage_code: 'S7' })
    assert.equal(byStage.query.matched, 2)

    const byLifecycle = await readApplicationValue(client, cfg, { job_id: first.jobId, lifecycle_status: 'CLOSED' })
    assert.equal(byLifecycle.query.matched, 0)

    const limited = await readApplicationValue(client, cfg, { job_id: first.jobId, limit: 1 })
    assert.equal(limited.query.limit, 1)
    assert.equal(limited.applications.length, 1)
  })
})

test('application_get：PII —— 默认脱敏，include_contacts=true 才给原文', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    // 夹具的候选人没有邮箱/手机（`seedScenario` 只写 display_name），先补两个强标识。
    const compact = scenario.candidateId.replace(/-/g, '')
    const email = `app.${compact.slice(0, 8)}@example.com`
    await client.query(
      `update recruitment.candidate set normalized_email = $1, normalized_phone = $2 where id = $3`,
      [email, `139${compact.slice(0, 8).replace(/[a-f]/g, '1')}`, scenario.candidateId],
    )

    const masked = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })
    assert.equal(masked.applications[0].candidate.contacts.visible, false)
    assert.notEqual(masked.applications[0].candidate.contacts.email, email)
    assert.match(masked.applications[0].candidate.contacts.email, /^a\*\*\*@example\.com$/)

    const full = await readApplicationValue(client, cfg, {
      application_id: scenario.applicationId,
      include_contacts: true,
    })
    assert.equal(full.applications[0].candidate.contacts.visible, true)
    assert.equal(full.applications[0].candidate.contacts.email, email)
  })
})

test('application_get：rubric 未批准时如实 approved=false（不回退"看起来已批准"）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client, { approve: false, pinRubric: true })
    const value = await readApplicationValue(client, cfg, { application_id: scenario.applicationId })
    assert.ok(value.applications[0].rubric !== undefined)
    assert.equal(value.applications[0].rubric.approved, false)
  })
})

test('application_get：未知 id → NOT_FOUND（APPLICATION_NOT_FOUND），不退回样例数据', async () => {
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      () => readApplicationValue(client, cfg, { application_id: randomUUID() }),
      /APPLICATION_NOT_FOUND/,
    )
  })
})

test('application_get：租户隔离（同 id 换租户 → NOT_FOUND）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const otherTenant = { ...cfg, tenant_id: '11111111-1111-4111-8111-000000000002' }
    await assert.rejects(
      () => readApplicationValue(client, otherTenant, { application_id: scenario.applicationId }),
      /APPLICATION_NOT_FOUND/,
    )
  })
})

test('application_get：入参校验（缺筛选 / 互斥 / 非 UUID 在起连接池之前拒）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    // 纯函数校验：同步抛错（不建连）。
    assert.throws(() => parseApplicationGetArgs({}), /MISSING_FILTER/)
    assert.throws(
      () => parseApplicationGetArgs({ application_id: scenario.applicationId, stage_code: 'S7' }),
      /MUTUALLY_EXCLUSIVE/,
    )
    assert.throws(() => parseApplicationGetArgs({ job_id: 'not-a-uuid' }), /INVALID_ARGS/)
    // 用一份连不上的配置：如果 UUID 校验在起池之后，这里会是连接错误而不是 INVALID_ARGS。
    const tool = createApplicationGetTool({ database: { ...cfg, port: 1 } })
    await assert.rejects(() => tool.execute({ application_id: 'application_0001' }), /INVALID_ARGS/)
    await assert.rejects(() => tool.execute({}), /MISSING_FILTER/)
  })
})

// ---------------------------------------------------------------------------
//  material_read
// ---------------------------------------------------------------------------

test('material_read：SUMMARY —— 哈希/结构摘要/定位器/脱敏全部来自真库事实', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 用**真实产品投影形状**的 parsed_fields：工作经历在 `entries[]` 里带 header_text/header_blocks/dates。
    const baseFields = parsedFields() as Record<string, unknown>
    const scenario = await seed(client, {
      fields: {
        ...baseFields,
        fields: {
          ...(baseFields.fields as Record<string, unknown>),
          work_experience: {
            state: 'present',
            value: null,
            provenance: 'native_text',
            entry_count: 1,
            evidence: [{ page: 1, bbox: [72, 248, 523, 271.2], block: 9, text: '2019.03 - 至今 某某科技 后端工程师' }],
            entries: [{
              index: 0,
              section: 'work_experience',
              header_text: '2019.03 - 至今  某某科技  后端工程师',
              header_blocks: [{ page: 1, bbox: [72, 248, 523, 271.2], block: 9, text: '2019.03 - 至今  某某科技  后端工程师' }],
              dates: [{ raw: '2019.03 - 至今', open_ended: true }],
            }],
          },
        },
      },
    })
    const value = await readMaterialValue(client, cfg, { application_id: scenario.applicationId }, undefined)

    assert.equal(value.tool, MATERIAL_READ_TOOL)
    assert.deepEqual(value.query, {
      mode: 'SUMMARY',
      source: 'APPLICATION',
      application_id: scenario.applicationId,
      resume_version_id: scenario.resumeVersionId,
    })
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'CONNECTED' })

    assert.equal(value.material.meta.resume_version_id, scenario.resumeVersionId)
    assert.equal(value.material.meta.parse_status, 'PARSED')
    assert.equal(value.material.meta.pages, 1)
    // 夹具的 parsed_fields.meta 只有 pages（合成夹具没写 reader 后端）：空串如实回显，不编造。 
    assert.equal(value.material.meta.reader_backend, '')

    // 两个哈希必须分开：source_asset_sha256 = 原件字节；content_sha256 = 解析投影。
    assert.match(value.material.meta.source_asset_sha256 ?? '', /^[0-9a-f]{64}$/)
    assert.match(value.material.meta.content_sha256 ?? '', /^[0-9a-f]{64}$/)
    assert.notEqual(value.material.meta.source_asset_sha256, value.material.meta.content_sha256)
    // 夹具的 parsed_fields.meta 没有 source_sha256（合成夹具只写 pages）：键省略而不是编造一个值。
    // 真实数据上它与 source_asset_sha256 相等的证据在 `work/d5/product-read/` 的真库冒烟里。
    assert.equal(value.material.meta.parsed_source_sha256, undefined)

    // 原件事实：文件名/大小/sha/校验状态/引用种类。
    assert.ok(value.material.asset !== undefined)
    assert.equal(value.material.asset.file_name, 'test.pdf')
    assert.equal(value.material.asset.mime_type, 'application/pdf')
    assert.equal(value.material.asset.byte_size, 1024)
    assert.equal(value.material.asset.sha256, value.material.meta.source_asset_sha256)
    assert.equal(value.material.asset.validation_status, 'VALID')
    assert.equal(value.material.asset.storage_ref_kind, 'OTHER')

    // 结构：5 个白名单字段各有 state；工作/教育经历带原文行 + 定位器。
    const states = Object.fromEntries(
      value.material.structure.field_locators.map((item) => [item.field, item.state]),
    )
    assert.deepEqual(states, {
      name: 'present',
      phone: 'absent',
      email: 'absent',
      work_experience: 'present',
      education: 'absent',
    })
    const work = value.material.structure.entries.find((item) => item.field === 'work_experience')
    assert.ok(work !== undefined)
    assert.match(work.header_text, /某某科技/)
    assert.equal(work.page, 1)
    assert.deepEqual(work.bbox, [72, 248, 523, 271.2])
    assert.equal(work.dates_raw, '2019.03 - 至今')
    assert.equal(value.material.structure.issues.hard_count, 0)
    assert.deepEqual(value.material.structure.issues.hard_codes, [])

    // TEXT 未请求：available=false + NOT_REQUESTED，且不返回 excerpt。
    assert.deepEqual(value.text, {
      mode: 'SUMMARY',
      available: false,
      reason_code: 'NOT_REQUESTED',
      source_chars: 0,
      excerpt_chars: 0,
      truncated: false,
    })
  })
})

test('material_read：PII —— 联系方式默认脱敏；材料 quote 对联系方式默认不回显', async () => {
  await inRolledBackTx(pool, async (client) => {
    const evidence = [{ page: 1, bbox: [1, 2, 3, 4], block: 1, text: '13800001111 与 cand@example.com' }]
    const scenario = await seed(client, {
      fields: {
        ...parsedFields(),
        fields: {
          ...(parsedFields().fields as Record<string, unknown>),
          phone: { state: 'present', value: '13800001111', provenance: 'native_text', evidence },
          email: { state: 'present', value: 'cand@example.com', provenance: 'native_text', evidence },
        },
      },
    })

    const masked = await readMaterialValue(client, cfg, { application_id: scenario.applicationId }, undefined)
    assert.equal(masked.material.contacts.visible, false)
    assert.notEqual(masked.material.contacts.phone, '13800001111')
    assert.notEqual(masked.material.contacts.email, 'cand@example.com')
    const phoneLocator = masked.material.structure.field_locators.find((item) => item.field === 'phone')
    assert.ok(phoneLocator !== undefined)
    assert.equal(phoneLocator.quote, undefined)

    const full = await readMaterialValue(
      client,
      cfg,
      { application_id: scenario.applicationId, include_contacts: true },
      undefined,
    )
    assert.equal(full.material.contacts.visible, true)
    assert.equal(full.material.contacts.phone, '13800001111')
    assert.equal(full.material.contacts.email, 'cand@example.com')
    const fullLocator = full.material.structure.field_locators.find((item) => item.field === 'phone')
    // quote 里的联系方式**永远**再脱敏一层（include_contacts 只放行 contacts 值，不放行引文里的号码）：
    // 这样"材料引文"不能成为绕过 PII 开关的旁路。
    assert.match(fullLocator?.quote ?? '', /138\*{4}1111/)
    assert.doesNotMatch(fullLocator?.quote ?? '', /13800001111/)
  })
})

test('material_read：TEXT 模式 —— converter 未配置时如实 CONVERTER_NOT_CONFIGURED（不假装读了）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const value = await readMaterialValue(
      client,
      cfg,
      { application_id: scenario.applicationId, mode: 'TEXT' },
      undefined,
    )
    assert.equal(value.text.mode, 'TEXT')
    assert.equal(value.text.available, false)
    assert.equal(value.text.reason_code, 'CONVERTER_NOT_CONFIGURED')
    assert.equal(value.text.excerpt, undefined)
  })
})

test('material_read：TEXT 模式 —— 文件不在 allowed_roots 内时 fail-closed（NOT_FOUND_IN_ALLOWED_ROOTS）', async () => {
  const root = mkdtempSync(join(tmpdir(), `bizread-roots-${process.pid}-`))
  try {
    await inRolledBackTx(pool, async (client) => {
      const scenario = await seed(client)
      const converter: ResolvedConverterConfig = {
        python_bin: process.execPath, // 不会被执行：文件定位在起读取器之前就失败
        converter_dir: root,
        allowed_roots: [root],
        timeout_ms: 5_000,
      }
      const value = await readMaterialValue(
        client,
        cfg,
        { application_id: scenario.applicationId, mode: 'TEXT' },
        converter,
      )
      assert.equal(value.text.available, false)
      assert.equal(value.text.reason_code, 'NOT_FOUND_IN_ALLOWED_ROOTS')
      assert.equal(value.text.excerpt, undefined)
      assert.equal(value.text.asset_sha256_verified, undefined)
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('material_read：按 resume_version_id 读、无材料申请、未知版本 → 明确错误码', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seed(client)
    const byVersion = await readMaterialValue(
      client,
      cfg,
      { resume_version_id: scenario.resumeVersionId },
      undefined,
    )
    assert.equal(byVersion.query.source, 'RESUME_VERSION')
    assert.equal(byVersion.query.resume_version_id, scenario.resumeVersionId)
    assert.equal(byVersion.material.meta.resume_version_id, scenario.resumeVersionId)

    const noMaterial = await seed(client, { bindMaterial: false })
    await assert.rejects(
      () => readMaterialValue(client, cfg, { application_id: noMaterial.applicationId }, undefined),
      /APPLICATION_HAS_NO_MATERIAL/,
    )
    await assert.rejects(
      () => readMaterialValue(client, cfg, { resume_version_id: randomUUID() }, undefined),
      /RESUME_VERSION_NOT_FOUND/,
    )
    await assert.rejects(
      () => readMaterialValue(client, cfg, { application_id: randomUUID() }, undefined),
      /APPLICATION_NOT_FOUND/,
    )
  })
})

test('material_read：入参校验（必须二选一、非 UUID 在起连接池之前拒）', async () => {
  // 纯函数校验：同步抛错（不建连）。
  assert.throws(() => parseMaterialReadArgs({}), /MISSING_ID/)
  assert.throws(
    () => parseMaterialReadArgs({ application_id: randomUUID(), resume_version_id: randomUUID() }),
    /MUTUALLY_EXCLUSIVE/,
  )
  assert.throws(() => parseMaterialReadArgs({ resume_version_id: 'resume_0001' }), /INVALID_ARGS/)
  assert.throws(
    () => parseMaterialReadArgs({ application_id: randomUUID(), mode: 'FULL_TEXT' }),
    /INVALID_ARGS/,
  )
  const tool = createMaterialReadTool({ database: { ...cfg, port: 1 } })
  await assert.rejects(() => tool.execute({ application_id: 'application_0001' }), /INVALID_ARGS/)
  await assert.rejects(() => tool.execute({}), /MISSING_ID/)
})

// ---------------------------------------------------------------------------
//  材料定位（逐根）+ PII 纯函数 + 只读证明
// ---------------------------------------------------------------------------

test('resolveMaterialPathAcrossRoots：前面的根把预算用光也不影响后面根里真实存在的材料', () => {
  const rootA = mkdtempSync(join(tmpdir(), `bizread-a-${process.pid}-`))
  const rootB = mkdtempSync(join(tmpdir(), `bizread-b-${process.pid}-`))
  try {
    const fileName = 'material-probe.pdf'
    const bytes = 'synthetic material bytes for task-75'
    writeFileSync(join(rootB, fileName), bytes, 'utf8')
    const sha = sha256Of(bytes)
    const input = { fileName, byteSize: Buffer.byteLength(bytes), sha256: sha }

    // 根 B 单独能找到。
    assert.equal(resolveMaterialPathAcrossRoots(input, [rootB]).reason, 'FOUND')
    // 两个根按顺序：A 找不到 → 继续 B（不是"一次传两根让 A 的预算饿死 B"）。
    const both = resolveMaterialPathAcrossRoots(input, [rootA, rootB])
    assert.equal(both.reason, 'FOUND')
    assert.equal(both.path, join(rootB, fileName))
    // 没有允许根 → NO_ALLOWED_ROOTS（不回落 cwd/env）。
    assert.deepEqual(resolveMaterialPathAcrossRoots(input, []), { path: null, reason: 'NO_ALLOWED_ROOTS' })
    // 文件名对但 sha 不同 → NOT_FOUND_IN_ALLOWED_ROOTS（不按文件名冒充命中）。
    const wrongSha = resolveMaterialPathAcrossRoots({ ...input, sha256: 'f'.repeat(64) }, [rootB])
    assert.deepEqual(wrongSha, { path: null, reason: 'NOT_FOUND_IN_ALLOWED_ROOTS' })
    // 名字不匹配 → 不命中（换一份新字节，避免 sha→path 缓存把这个键先命中）。
    const otherBytes = 'another synthetic material body for task-75'
    writeFileSync(join(rootB, 'another.pdf'), otherBytes, 'utf8')
    assert.equal(
      resolveMaterialPathAcrossRoots(
        { fileName: 'missing.pdf', byteSize: Buffer.byteLength(otherBytes), sha256: sha256Of(otherBytes) },
        [rootB],
      ).reason,
      'NOT_FOUND_IN_ALLOWED_ROOTS',
    )
  } finally {
    rmSync(rootA, { recursive: true, force: true })
    rmSync(rootB, { recursive: true, force: true })
  }
})

test('summarizeParsedFields：只认白名单字段，不读 protected，不把缺状态当 absent', () => {
  const summary = summarizeParsedFields({
    fields: {
      name: { state: 'present', value: '示例甲', evidence: [] },
      phone: { state: 'present', value: '13800001111', evidence: [{ page: 1, bbox: [1, 2, 3, 4], text: '13800001111' }] },
      email: { state: 'present', value: 'a@b.com', evidence: [{ page: 1, text: 'a@b.com' }] },
      // 受保护属性如果被塞进 parsed_fields，也不会被投影出来（白名单之外）。
      birth_date: { state: 'present', value: '2000-01-01', evidence: [] },
      gender: { state: 'present', value: '女', evidence: [] },
    },
    timeline: { intervals: 1, closed_intervals: 1, open_ended_intervals: 0, covered_months_closed: 12 },
    issues: [{ code: 'pdf_reading_order_unverified', message: '阅读顺序未验证' }],
  }, false)

  const fields = summary.structure.field_locators.map((item) => item.field)
  assert.deepEqual(fields, ['name', 'phone', 'email', 'work_experience', 'education'])
  assert.ok(!fields.includes('birth_date'))
  assert.ok(!fields.includes('gender'))
  // 缺状态的字段按 unreadable（不是 absent：没读到 ≠ 没有）。
  const work = summary.structure.field_locators.find((item) => item.field === 'work_experience')
  assert.equal(work?.state, 'unreadable')
  // 联系方式脱敏；email/phone 的 quote 默认不回显。
  assert.notEqual(summary.contacts.phone, '13800001111')
  assert.notEqual(summary.contacts.email, 'a@b.com')
  assert.equal(summary.structure.field_locators.find((item) => item.field === 'phone')?.quote, undefined)
  // HARD issue 口径来自 db/material.ts（未知 code 按 HARD 的保守判定）。
  assert.equal(summary.structure.issues.hard_count, 1)
  assert.deepEqual(summary.structure.issues.hard_codes, ['pdf_reading_order_unverified'])
  assert.deepEqual(summary.structure.timeline, {
    intervals: 1,
    closed_intervals: 1,
    open_ended_intervals: 0,
    covered_months_closed: 12,
  })
})

test('只读：withReadOnly 的事务里写语句被数据库直接拒（25006），这是工具的只读保证来源', async () => {
  await assert.rejects(
    () => withReadOnly(pool, async (client) => {
      await client.query(
        `insert into recruitment.business_config (tenant_id, scope, config_key, version_no, payload)
         values ($1, 'ORGANIZATION', 'task75_readonly_probe', 1, '{}'::jsonb)`,
        [TENANT],
      )
    }),
    (error: unknown) => {
      const code = (error as { code?: string }).code ?? ''
      assert.equal(code, '25006')
      return true
    },
  )
})

test('工厂与未配置替身：名字固定、依赖注入形状稳定（W0 接 index.ts 用）', async () => {
  const tools = createBusinessReadTools({ database: cfg })
  assert.deepEqual(tools.map((tool) => tool.name), [APPLICATION_GET_TOOL, MATERIAL_READ_TOOL])
  assert.deepEqual(tools.map((tool) => typeof tool.execute), ['function', 'function'])
  assert.equal(tools[0]?.isConcurrencySafe?.({}), true)
  assert.equal(tools[1]?.isConcurrencySafe?.({}), true)

  const unconfigured = unconfiguredBusinessReadTools(['database.password_env'], ['converter.python_bin'])
  assert.deepEqual(unconfigured.map((tool) => tool.name), [APPLICATION_GET_TOOL, MATERIAL_READ_TOOL])
  await assert.rejects(() => unconfigured[0]?.execute({}), /NOT_CONFIGURED/)
  await assert.rejects(() => unconfigured[1]?.execute({}), /NOT_CONFIGURED/)
})

test.after(async () => {
  await pool.end()
})
