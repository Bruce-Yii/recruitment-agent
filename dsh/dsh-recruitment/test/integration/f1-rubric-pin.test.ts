// F1（申请钉住 rubric 版本）的集成矩阵 —— **真库 ra_s6s7**，每个用例结束回滚。
//
// 修前的现场（2026-11-14）：`application.rubric_version_id` 没有任何工具写，
// 于是 S7/S10 的 `decision_record` / `evaluation_summarize` 永远 `RUBRIC_VERSION_NOT_FOUND`
// （`decision-record.ts:2856`），Golden Path 在 S7 断掉。
//
// 本文件钉住三件事（三处缺一不可）：
//   1. **写侧**：intake 新建申请时，若岗位 `current_rubric_version_id` 非空且**此刻已批准**，
//      就把该版本写进 `application.rubric_version_id`；没有已批准版本时留空、不报错。
//   2. **读侧**：`screening_evaluate` 的 `JOB_CURRENT` 只认 `job.current_rubric_version_id`
//      （D-21/D-48），不按 `max(version_no)` 取 —— 什么叫"当前"只有一个答案。
//   3. **补钉**：申请已存在但没钉、之后岗位批准了 rubric 时，`stage_advance` 的 T1
//      在同一事务里补钉（带审计事件）后推进；只读视图不写库。
import test from 'node:test'
import assert from 'node:assert/strict'

import { observeIdentity, type StrongId } from '../../src/db/identity.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import { advanceApplicationStage, readStageBlockedView } from '../../src/domain/stage-advance.ts'
import { evaluateInTransaction } from '../../src/tools/screening-evaluate.ts'
import { intakeInTransaction, type IntakeMaterial } from '../../src/tools/application-intake.ts'
import { digestOf } from '../../src/tools/contract.ts'
import {
  createTestPool,
  DEMO_JOB,
  HR_ACTOR,
  hex64,
  inRolledBackTx,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

const DIMS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 1, field: 'work_experience', operator: 'EXISTS', value: true },
]

/**
 * 造一份可落库的材料（身份结论只看 phone/email 的三态与来源；不读 PDF）。
 * @param phone - 唯一手机号（每次现造，避免命中库里已有档案）。
 */
function makeMaterial(phone: string): IntakeMaterial {
  const evidence = [{ page: 1, bbox: [72, 100, 500, 120], block: 1, text: '联系我' }]
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '测试候选人', provenance: 'native_text', evidence },
    phone: { state: 'present', value: phone, provenance: 'native_text', evidence },
    email: { state: 'absent', provenance: 'native_text', evidence: [] },
    work_experience: { state: 'present', provenance: 'native_text', evidence },
    education: { state: 'absent', provenance: 'native_text', evidence: [] },
  }
  const eligible = ['phone', 'email']
  const observation = observeIdentity(fields as never, eligible)
  const sha = hex64(`f1-${uniqueSuffix()}`)
  return {
    real_path: 'C:/fake/resume.pdf',
    file_name: 'resume.pdf',
    byte_size: 2048,
    output: {
      text: 'x'.repeat(1200),
      chars: 1200,
      completeness: 'complete',
      issues: [],
      fields,
      timeline: { covered_months_closed: 74, open_ended_intervals: 0, year_only_intervals: 0 },
      screening: { eligible_fields: eligible, identity_merge_eligible: eligible },
      meta: { pages: 1, source_sha256: sha, backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
    } as IntakeMaterial['output'],
    strong: observation.strong as StrongId[],
    blocked: observation.blocked,
    sha256: sha,
  }
}

/** 每次现造一个不会撞库里已有档案的手机号。 */
function freshPhone(): string {
  const tail = String(1000 + (Number.parseInt(hex64(`f1-phone-${uniqueSuffix()}`).slice(0, 6), 16) % 9000))
  return `137 0000 ${tail}`
}

/** 写一条已生效的批准并（可选）把 job 的 current 指针指过去 —— 复刻 job_rubric_approve 的库级效果。 */
async function approveAndPoint(client: DatabaseClient, jobId: string, rubricId: string): Promise<string> {
  const payloadHash = (await client.query<{ payload_hash: string }>(
    'select payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
    [TENANT, rubricId],
  )).rows[0]?.payload_hash
  assert.ok(payloadHash !== undefined, '夹具必须有 rubric_version 行')
  await client.query(
    `insert into recruitment.approval
       (tenant_id, resource_type, resource_id, resource_record_version, payload_schema_version,
        canonical_payload_hash, status, requested_by_actor_id, decision_by_actor_id, decided_at, reason)
     values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'APPROVED', $4, $4, now(), 'F1 集成测试批准')`,
    [TENANT, rubricId, payloadHash, HR_ACTOR],
  )
  await client.query(
    'update recruitment.job set current_rubric_version_id = $2 where tenant_id = $1 and id = $3',
    [TENANT, rubricId, jobId],
  )
  return payloadHash
}

async function appRow(client: DatabaseClient, applicationId: string): Promise<{
  rubric_version_id: string | null
  current_stage_code: string
  record_version: number
}> {
  const row = (await client.query<{ rubric_version_id: string | null; current_stage_code: string; record_version: number }>(
    'select rubric_version_id, current_stage_code, record_version from recruitment.application where tenant_id = $1 and id = $2',
    [TENANT, applicationId],
  )).rows[0]
  assert.ok(row !== undefined, '申请必须存在')
  return row as { rubric_version_id: string | null; current_stage_code: string; record_version: number }
}

async function jobPointer(client: DatabaseClient, jobId: string): Promise<string | null> {
  return (await client.query<{ current_rubric_version_id: string | null }>(
    'select current_rubric_version_id from recruitment.job where tenant_id = $1 and id = $2',
    [TENANT, jobId],
  )).rows[0]?.current_rubric_version_id ?? null
}

// =====================================================================
//  1. 写侧：intake 新建申请时钉住岗位当前已批准的版本
// =====================================================================

test('F1 写侧：岗位有已批准的 current → 新建申请时写入同一个 rubric_version_id', async () => {
  await inRolledBackTx(pool, async (client) => {
    // DEMO_JOB 的 current 指针由 0004 迁移回填（v2），审批在 0002 seed 里已是 APPROVED。
    const pointer = await jobPointer(client, DEMO_JOB)
    assert.ok(pointer !== null, '演示岗位必须有 current rubric 指针（0004 回填）')

    const result = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), DEMO_JOB)
    assert.equal(result.application_action, 'CREATED')
    const app = await appRow(client, result.application_id)
    assert.equal(app.rubric_version_id, pointer, 'intake 新建申请必须钉住 job.current_rubric_version_id')
    assert.equal(app.current_stage_code, 'S6')
  })
})

test('F1 写侧：岗位没有已批准 rubric → intake 照样成功，但 rubric_version_id 留空（不阻塞接入）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // approve:false ⇒ 只有 PENDING 审批；指针为空（没有"当前版本"）。
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false })
    assert.equal(await jobPointer(client, scenario.jobId), null)

    const result = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), scenario.jobId)
    assert.equal(result.application_action, 'CREATED', '没有 rubric 不许挡住接简历')
    const app = await appRow(client, result.application_id)
    assert.equal(app.rubric_version_id, null, '没有已批准版本时留空')
  })
})

test('F1 写侧：指针指向的版本**未批准** → 仍留空（指针不是批准证明）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false })
    // 指针非空但版本只有 PENDING 审批：这正是"批准状态只能靠 approval 判"的边界。
    await client.query(
      'update recruitment.job set current_rubric_version_id = $2 where tenant_id = $1 and id = $3',
      [TENANT, scenario.rubricId, scenario.jobId],
    )
    assert.equal(await jobPointer(client, scenario.jobId), scenario.rubricId)

    const result = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), scenario.jobId)
    const app = await appRow(client, result.application_id)
    assert.equal(app.rubric_version_id, null, '未批准的版本不得被钉住')
  })
})

// =====================================================================
//  2. 读侧：JOB_CURRENT 只认指针（不是 max(version_no)）
// =====================================================================

test('F1 读侧：job.current 指向 v1、v2 也已批准 → screening_evaluate 的 JOB_CURRENT 用 v1', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, pinRubric: false })
    // 造 v2：approved，但指针仍指 v1（v2 是直接插的，没走 job_rubric_approve）。
    const v2Hash = digestOf(DIMS)
    const v2 = (await client.query<{ id: string }>(
      `insert into recruitment.rubric_version
         (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
       values ($1, $2, 2, $3::jsonb, $4, $5) returning id`,
      [TENANT, scenario.jobId, JSON.stringify(DIMS), v2Hash, HR_ACTOR],
    )).rows[0]?.id
    assert.ok(v2 !== undefined)
    await client.query(
      `insert into recruitment.approval
         (tenant_id, resource_type, resource_id, resource_record_version, payload_schema_version,
          canonical_payload_hash, status, requested_by_actor_id, decision_by_actor_id, decided_at, reason)
       values ($1, 'RUBRIC_VERSION', $2, 1, 1, $3, 'APPROVED', $4, $4, now(), 'F1 v2')`,
      [TENANT, v2, v2Hash, HR_ACTOR],
    )

    const value = await evaluateInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now())
    const rubric = value.rubric as { version_id: string; version_no: number; resolution: string }
    assert.equal(rubric.resolution, 'JOB_CURRENT')
    assert.equal(rubric.version_id, scenario.rubricId, 'current = 指针指向的 v1')
    assert.equal(rubric.version_no, 1, '不是 max(version_no)=2')
    assert.notEqual(rubric.version_id, v2)
  })
})

test('F1 读侧：指针为空 → JOB_CURRENT 报 NO_RUBRIC(NO_APPROVED_RUBRIC)，不回退到 max(version_no)', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false, pinRubric: false })
    await assert.rejects(
      evaluateInTransaction(client, cfg, { application_id: scenario.applicationId }, Date.now()),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /NO_APPROVED_RUBRIC/)
        return true
      },
    )
  })
})

// =====================================================================
//  3. 补钉：申请没钉 + 之后岗位批准 → stage_advance 同一事务补钉后推进
// =====================================================================

test('F1 补钉：申请先建（无 rubric）→ 岗位批准 → stage_advance 补钉 + S7 + 审计事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false, pinRubric: false, bindMaterial: true })
    await client.query("update recruitment.application set current_stage_code = 'S6' where tenant_id = $1 and id = $2", [
      TENANT, scenario.applicationId,
    ])
    const before = await appRow(client, scenario.applicationId)
    assert.equal(before.rubric_version_id, null)

    // 岗位现在批准了（复刻 job_rubric_approve 的库级效果：APPROVED + 指针）。
    await approveAndPoint(client, scenario.jobId, scenario.rubricId)

    const result = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: scenario.applicationId })
    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S7')
    assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])

    const after = await appRow(client, scenario.applicationId)
    assert.equal(after.rubric_version_id, scenario.rubricId, '补钉必须写进 application.rubric_version_id')
    assert.equal(after.record_version, before.record_version + 2, '补钉 +1、阶段迁移 +1（都由 fn_row_guard 维护）')

    // 审计：一条内部事件，绑定申请 + actor + 新值。
    const events = (await client.query<{ event_type: string; source_object_id: string | null; payload: Record<string, unknown> }>(
      `select event_type, source_object_id, payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'application.rubric_version.pinned' and source_object_id = $2`,
      [TENANT, scenario.applicationId],
    )).rows
    assert.equal(events.length, 1, '补钉必须留一条审计事件（同一事务）')
    assert.equal(events[0]?.payload.rubric_version_id, scenario.rubricId)
    assert.equal(events[0]?.payload.actor_id, HR_ACTOR, '审计记的是执行账号')
    assert.equal(events[0]?.payload.from, null, '补钉前是"没有值"')

    // 幂等：再调一次 → NO_OP，零写入、补钉事件不重复。
    const second = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: scenario.applicationId })
    assert.equal(second.status, 'NO_OP')
    const after2 = await appRow(client, scenario.applicationId)
    assert.equal(after2.record_version, after.record_version, '第二次不得写库')
    assert.equal((
      await client.query<{ n: string }>(
        `select count(*) as n from recruitment.event_inbox
          where tenant_id = $1 and event_type = 'application.rubric_version.pinned' and source_object_id = $2`,
        [TENANT, scenario.applicationId],
      )
    ).rows[0]?.n, '1', '补钉事件不得重复')
  })
})

test('F1 补钉：岗位仍无已批准 current → BLOCKED(RUBRIC_NOT_PINNED)，零写入、无补钉事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false, pinRubric: false })
    await client.query("update recruitment.application set current_stage_code = 'S6' where tenant_id = $1 and id = $2", [
      TENANT, scenario.applicationId,
    ])
    const before = await appRow(client, scenario.applicationId)
    const result = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: scenario.applicationId })
    assert.equal(result.status, 'BLOCKED')
    assert.deepEqual(result.blockers.map((b) => b.code), ['RUBRIC_NOT_PINNED'])
    const after = await appRow(client, scenario.applicationId)
    assert.deepEqual(after, before, 'BLOCKED 必须零写入')
    assert.equal((
      await client.query<{ n: string }>(
        `select count(*) as n from recruitment.event_inbox
          where tenant_id = $1 and event_type = 'application.rubric_version.pinned'
            and source_object_id = $2`,
        [TENANT, scenario.applicationId],
      )
    ).rows[0]?.n, '0', '没有写入就不许有补钉审计事件')
  })
})

test('F1 只读视图：可补钉的情形也不写库（视图只报告当前事实）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: DIMS, approve: false, pinRubric: false })
    await client.query("update recruitment.application set current_stage_code = 'S6' where tenant_id = $1 and id = $2", [
      TENANT, scenario.applicationId,
    ])
    await approveAndPoint(client, scenario.jobId, scenario.rubricId)
    const before = await appRow(client, scenario.applicationId)

    const view = await readStageBlockedView(client, { tenantId: TENANT, applicationId: scenario.applicationId })
    assert.equal(view.blockers[0]?.code, 'RUBRIC_NOT_PINNED', '视图回答"库里现在缺什么"')
    const after = await appRow(client, scenario.applicationId)
    assert.deepEqual(after, before, '只读视图一条写都不发（含补钉与审计事件）')
  })
})
