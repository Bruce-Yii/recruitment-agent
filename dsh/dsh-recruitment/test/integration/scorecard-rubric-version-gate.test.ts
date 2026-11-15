// SC-11 的两道闸：**面评绑的 rubric 版本 ≠ 申请最终钉的版本**时不得静默混用。
//
// 缺陷路径（独立复核窗口实测，本文件逐段复刻；**不是**重新论证）：
//   intake（岗位还没有已批准 rubric → 申请不钉）
//   → interview_schedule（排期）
//   → scorecard_submit 显式传 rubric V1（代码允许，只有 warning RUBRIC_EXPLICIT_NOT_PINNED）
//   → 岗位批准 V2（job_update 造 V2 + PENDING → job_rubric_approve 人批准，指针指 V2）
//   → stage_advance 补钉 V2
// 修前：① 补钉不检查该申请已有的面评 → V1 的面评被**静默**算进绑 V2 的汇总/决策。
// 修后：
//   ① `stage-advance.pinCurrentRubric` 在补钉前发现"已有现存面评绑在别的版本上"
//      → 拒绝补钉（`INVARIANT_VIOLATION(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)`），**零写入**；
//   ② 即使有人强行绕过补钉（直接改库），`evaluation_summarize` 也会把版本不一致的面评
//      剔出汇总并报 `warnings: SCORECARD_RUBRIC_MISMATCH`，`decision_record` 直接拒绝
//      （`EVIDENCE_INSUFFICIENT(SCORECARD_RUBRIC_MISMATCH)`）。
//
// 另一个实测：补钉的 UPDATE 会不会撞 `fn_row_guard`（见文件末尾 §3）。
//
// 全部用例连真库 `ra_s6s7`，每个用例结束 ROLLBACK（`inRolledBackTx`）。
import test from 'node:test'
import assert from 'node:assert/strict'

import { observeIdentity, type StrongId } from '../../src/db/identity.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import { advanceApplicationStage, readStageBlockedView } from '../../src/domain/stage-advance.ts'
import { intakeInTransaction, type IntakeMaterial } from '../../src/tools/application-intake.ts'
import { confirmationTextSha256, recordDecisionInTransaction } from '../../src/tools/decision-record.ts'
import { computeEvaluationSummaryIn } from '../../src/tools/evaluation-summarize.ts'
import { scheduleInTransaction } from '../../src/tools/interview-schedule.ts'
import { createJobInTransaction, updateJobInTransaction } from '../../src/tools/job-create.ts'
import { approveRubricInTransaction } from '../../src/tools/job-rubric-approve.ts'
import { submitScorecardInTransaction } from '../../src/tools/scorecard-submit.ts'
import {
  createTestPool,
  DEMO_DEPARTMENT,
  errorBody,
  hex64,
  HR_ACTOR,
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

/** 服务端"现在"（固定，避免 as_of / 排期时间随真实时钟漂移）。 */
const NOW = Date.now()
/** 汇总/决策的 as_of（不晚于 NOW）。 */
const AS_OF = new Date(NOW - 60 * 60 * 1000).toISOString()
/**
 * 排期时刻：2031 年之后 + 每次进程随机偏移。
 *
 * 不写死具体时段：本文件连共享真库，别的 lane 可能恰好在同一时段、同一面试官建了面试，
 * 那样测到的是"库里那一刻有没有空位"而不是本文件要测的东西（`interview-schedule.test.ts` 同款处理）。
 */
const SLOT_BASE_MS = Date.parse('2031-01-01T10:00:00+08:00') + Math.floor(Math.random() * 300 * 24 * 60) * 60_000
const START = new Date(SLOT_BASE_MS).toISOString()

/** D.79 人工闸门替身：一律放行一次（本文件测的是闸门之后的业务校验，不是闸门本身）。 */
const allowOnce = async (): Promise<'allowed-once'> => 'allowed-once'

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
  const sha = hex64(`sc-rubric-${uniqueSuffix()}`)
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
  const tail = String(1000 + (Number.parseInt(hex64(`sc-phone-${uniqueSuffix()}`).slice(0, 6), 16) % 9000))
  return `136 0000 ${tail}`
}

/**
 * 两个版本的 rubric **维度键完全相同**、只改标签/问题（这正是缺陷的危险形态：
 * 读侧只比键，键一样就"看起来兼容"，V1 的票会被静默算进 V2）。
 */
const CRITERIA_V1 = [
  {
    key: 'backend_depth',
    label: '后端工程深度',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: '做过哪些高并发后端系统？怎么验证容量？',
  },
  {
    key: 'async_pipeline',
    label: '异步/队列流水线经验',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: '消息重试与幂等怎么保证？',
  },
]
const CRITERIA_V2 = [
  {
    key: 'backend_depth',
    label: '后端工程深度（v2 口径）',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: 'v2：请给出一条可复现的容量压测结论。',
  },
  {
    key: 'async_pipeline',
    label: '异步/队列流水线经验（v2 口径）',
    kind: 'MUST_HAVE',
    weight: 0.5,
    question: 'v2：请说明乱序/重复投递下的幂等边界。',
  },
]
const DIMENSION_KEYS = ['backend_depth', 'async_pipeline'] as const

/** 面评 items（键集必须恰好覆盖 rubric 维度 + 保留键 transcript_basis）。 */
function itemsForV1(): Record<string, unknown> {
  const items: Record<string, unknown> = { transcript_basis: 'NO_TRANSCRIPT' }
  for (const key of DIMENSION_KEYS) {
    items[key] = { assessment: 'MET', score: 4, note: `${key} 的现场观察记录`, evidence: [] }
  }
  return items
}

/** 读申请的关键事实（零写入断言用）。 */
async function appRow(client: DatabaseClient, applicationId: string): Promise<{
  rubric_version_id: string | null
  current_stage_code: string
  record_version: number
}> {
  const row = (await client.query<{
    rubric_version_id: string | null
    current_stage_code: string
    record_version: number
  }>(
    `select rubric_version_id, current_stage_code, record_version
       from recruitment.application where tenant_id = $1 and id = $2`,
    [TENANT, applicationId],
  )).rows[0]
  assert.ok(row !== undefined, '申请必须存在')
  return row as { rubric_version_id: string | null; current_stage_code: string; record_version: number }
}

/** 数一条 SQL 的整数结果。 */
async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const value = (await client.query<{ n: number }>(sql, [...params])).rows[0]?.n
  assert.equal(typeof value, 'number', `count 查询没有返回数字：${sql.slice(0, 60)}`)
  return value as number
}

/** 断言一次调用抛契约错误，并返回错误体。 */
async function rejection(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await promise
  } catch (error) {
    return errorBody(error)
  }
  assert.fail('期望抛契约错误，但调用成功了')
}

/** 本文件独有的"岗位 + 两版 rubric + 材料 + 面试 + 面评"路径句柄。 */
interface ConstructedPath {
  readonly jobId: string
  readonly rubrics: { readonly v1: string; readonly v2: string }
  readonly applicationId: string
  readonly interviewId: string
  readonly scorecardId: string
}

/**
 * 走**真实工具链**构造缺陷路径（全部在同一事务里，调用方负责 ROLLBACK）：
 *   job_create(带 V1 criteria，只有 PENDING 审批)
 *   → intake（申请建在 S6，rubric 留空）
 *   → interview_schedule（CREATE）
 *   → scorecard_submit（显式 rubric_version_id=V1）
 *   → job_update（造 V2）+ job_rubric_approve（人批准 V2，指针指 V2）
 * 返回时：申请仍未钉 rubric，岗位 current = V2，且已有一份绑 V1 的现行面评。
 * @param client - 事务内连接（actor 已 SET LOCAL）。
 * @returns 路径上的关键 id。
 */
async function constructMismatchPath(client: DatabaseClient): Promise<ConstructedPath> {
  const jobValue = await createJobInTransaction(client, cfg, {
    title: 'SC-11 集成岗位',
    code: `SC11-${uniqueSuffix()}`,
    department_id: DEMO_DEPARTMENT,
    description_md: 'SC-11 集成测试 JD',
    criteria: CRITERIA_V1,
  })
  const jobId = jobValue.job.id
  const v1 = jobValue.rubric?.version_id
  assert.ok(v1 !== undefined, 'job_create 必须造出 rubric v1')
  assert.equal(
    (await client.query<{ current_rubric_version_id: string | null }>(
      'select current_rubric_version_id from recruitment.job where id = $1 and tenant_id = $2',
      [jobId, TENANT],
    )).rows[0]?.current_rubric_version_id,
    null,
    '只有 PENDING 审批 → 岗位没有 current rubric（申请不会被 intake 钉住）',
  )

  // --- intake：申请不钉 rubric（岗位此刻没有已批准版本）---
  const intake = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), jobId)
  assert.equal(intake.application_action, 'CREATED')
  const applicationId = intake.application_id
  const appAfterIntake = await appRow(client, applicationId)
  assert.equal(appAfterIntake.rubric_version_id, null, 'intake 阶段申请必须不钉 rubric')
  assert.equal(appAfterIntake.current_stage_code, 'S6')

  // --- S8 排期（真实工具；面试官就是执行账号，便于随后以同一身份交面评）---
  const scheduled = await scheduleInTransaction(client, cfg, {
    intent: 'CREATE',
    idempotency_key: `sc11-schedule-${uniqueSuffix()}`,
    application_id: applicationId,
    round_no: 1,
    interviewers: [{ actor_id: HR_ACTOR }],
    scheduled_start_at: START,
    duration_minutes: 60,
  }, NOW, allowOnce)
  const created = (scheduled.changes as { created: { table: string; id: string }[] }).created
  const interviewId = created.find((change) => change.table === 'interview')?.id
  assert.ok(interviewId !== undefined, '排期必须创建 interview 行')

  // --- scorecard_submit 显式传 V1（缺陷的前置：代码允许，只有 warning）---
  const submitted = await submitScorecardInTransaction(client, cfg, {
    interview_id: interviewId,
    rubric_version_id: v1,
    items: itemsForV1(),
    overall: 'HOLD',
    idempotency_key: `sc11-scorecard-${uniqueSuffix()}`,
  }, NOW, allowOnce)
  const scorecard = submitted.scorecard as Record<string, unknown>
  assert.equal(scorecard.rubric_version_id, v1, '面评必须真的绑在 V1 上')
  assert.equal(scorecard.rubric_resolution, 'EXPLICIT_VERSION_ID', '这是"显式版本"路径，不是申请钉住')
  const warningCodes = (submitted.warnings as { code: string }[]).map((warning) => warning.code)
  assert.ok(warningCodes.includes('RUBRIC_EXPLICIT_NOT_PINNED'), '写侧只给了 warning —— 这正是缺陷入口')
  const scorecardId = String(scorecard.id)

  // --- 岗位批准 V2（真实工具：job_update 造 V2 + PENDING → job_rubric_approve 人批准）---
  const jobUpdated = await updateJobInTransaction(client, cfg, { job_id: jobId, criteria: CRITERIA_V2 })
  const v2 = jobUpdated.rubric?.version_id
  assert.ok(v2 !== undefined, 'job_update 必须造出 rubric v2')
  assert.notEqual(v2, v1, 'V1 / V2 必须是两个版本')
  const v1Keys = ((await client.query<{ dimensions: { key: string }[] }>(
    'select dimensions from recruitment.rubric_version where tenant_id = $1 and id = $2',
    [TENANT, v1],
  )).rows[0]?.dimensions ?? []).map((dimension) => dimension.key).sort()
  const v2Keys = ((await client.query<{ dimensions: { key: string }[] }>(
    'select dimensions from recruitment.rubric_version where tenant_id = $1 and id = $2',
    [TENANT, v2],
  )).rows[0]?.dimensions ?? []).map((dimension) => dimension.key).sort()
  assert.deepEqual(v2Keys, v1Keys, '两版维度键相同 —— 修前读侧会"看起来兼容"地静默混用')

  const approved = await approveRubricInTransaction(client, cfg, { job_id: jobId, rubric_version_id: v2 }, allowOnce)
  assert.equal(approved.outcome, 'APPROVED')
  assert.equal(approved.job.current_rubric_version_id, v2, '批准 V2 后岗位 current 必须指向 V2')

  return { jobId, rubrics: { v1, v2 }, applicationId, interviewId, scorecardId }
}

// =====================================================================
//  1. 完整路径：stage_advance 补钉被 ① 拒绝（零写入）
// =====================================================================

test('完整路径：intake(无rubric) → 排期 → 面评显式 V1 → 批准 V2 → stage_advance 补钉被拒 RUBRIC_PIN_CONFLICT_WITH_SCORECARD（零写入）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const path = await constructMismatchPath(client)
    const before = await appRow(client, path.applicationId)
    const pinnedEventSql = `select count(*)::int as n from recruitment.event_inbox
       where tenant_id = $1 and event_type = 'application.rubric_version.pinned'
         and source_object_id = $2`
    const stageEventSql = `select count(*)::int as n from recruitment.event_inbox
       where tenant_id = $1 and event_type = 'application.current_stage_code.changed'
         and source_object_id = $2`
    const pinnedEventsBefore = await count(client, pinnedEventSql, [TENANT, path.applicationId])
    const stageEventsBefore = await count(client, stageEventSql, [TENANT, path.applicationId])

    const body = await rejection(advanceApplicationStage(client, {
      tenantId: TENANT,
      applicationId: path.applicationId,
    }))
    assert.equal(body.code, 'INVARIANT_VIOLATION', `错误体：${JSON.stringify(body)}`)
    assert.equal(body.reason_code, 'RUBRIC_PIN_CONFLICT_WITH_SCORECARD')
    // 真实输出（复核窗口要的"被拒的错误码与 detail"）。
    console.log(`  [gate ① stage_advance] ${String(body.code)}(${String(body.reason_code)})`
      + ` detail=${JSON.stringify(body.detail)}`)
    const detail = body.detail as Record<string, unknown>
    assert.equal(detail.pin_target_rubric_version_id, path.rubrics.v2, 'detail 必须有待钉版本（V2）')
    assert.deepEqual(detail.conflicting_rubric_version_ids, [path.rubrics.v1], 'detail 必须有冲突版本（V1）')
    assert.equal(detail.conflicting_scorecard_count, 1, 'detail 必须有冲突面评数')
    assert.deepEqual(detail.conflicting_scorecard_ids, [path.scorecardId])

    // 零写入：申请未钉、阶段未动、版本未涨；没有补钉事件、没有阶段迁移事件。
    const after = await appRow(client, path.applicationId)
    assert.deepEqual(after, before, '拒绝补钉必须零写入（rubric_version_id / 阶段 / record_version 全不变）')
    assert.equal(after.rubric_version_id, null)
    assert.equal(after.current_stage_code, 'S6')
    assert.equal(await count(client, pinnedEventSql, [TENANT, path.applicationId]), pinnedEventsBefore)
    assert.equal(await count(client, stageEventSql, [TENANT, path.applicationId]), stageEventsBefore)
  })
})

test('对照：同一路径但**没有**面评时，stage_advance 正常补钉 V2 并推进到 S7（闸门只挡真冲突）', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 只走到"岗位批准 V2"，不交面评：补钉应当成功。
    const jobValue = await createJobInTransaction(client, cfg, {
      title: 'SC-11 对照岗位',
      code: `SC11-OK-${uniqueSuffix()}`,
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = jobValue.job.id
    const intake = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), jobId)
    const app = await appRow(client, intake.application_id)
    assert.equal(app.rubric_version_id, null)
    const jobUpdated = await updateJobInTransaction(client, cfg, { job_id: jobId, criteria: CRITERIA_V2 })
    const v2 = jobUpdated.rubric?.version_id
    assert.ok(v2 !== undefined)
    await approveRubricInTransaction(client, cfg, { job_id: jobId, rubric_version_id: v2 }, allowOnce)

    const result = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: intake.application_id })
    assert.equal(result.status, 'ADVANCED')
    assert.equal(result.stage_code, 'S7')
    const after = await appRow(client, intake.application_id)
    assert.equal(after.rubric_version_id, v2)
    assert.equal(after.current_stage_code, 'S7')
    assert.equal(after.record_version, app.record_version + 2, '补钉 +1、阶段迁移 +1（fn_row_guard 维护）')
  })
})

// =====================================================================
//  1a'. 阴性对照（合法路径不误伤）：有面评、但版本与申请最终 pin **一致**
// =====================================================================

test('阴性对照（合法路径不误伤）：面评绑 V1、岗位批准/申请最终也钉 V1 → stage_advance 正常补钉并推进到 S7', async () => {
  await inRolledBackTx(pool, async (client) => {
    // 真实工具链，只把"最终批准哪一版"换成面评实际使用的 V1：
    //   job_create(V1, PENDING) → intake（无 pin）→ 排期 → 面评显式 V1 → 批准 V1 → stage_advance
    const jobValue = await createJobInTransaction(client, cfg, {
      title: 'SC-11 合法路径岗位',
      code: `SC11-SAME-${uniqueSuffix()}`,
      department_id: DEMO_DEPARTMENT,
      description_md: 'SC-11 合法路径 JD',
      criteria: CRITERIA_V1,
    })
    const jobId = jobValue.job.id
    const v1 = jobValue.rubric?.version_id
    assert.ok(v1 !== undefined, 'job_create 必须造出 rubric v1')
    assert.equal(
      (await client.query<{ current_rubric_version_id: string | null }>(
        'select current_rubric_version_id from recruitment.job where id = $1 and tenant_id = $2',
        [jobId, TENANT],
      )).rows[0]?.current_rubric_version_id,
      null,
      '只有 PENDING 审批 → 申请不会被 intake 钉住',
    )

    const intake = await intakeInTransaction(client, cfg, makeMaterial(freshPhone()), jobId)
    const appAfterIntake = await appRow(client, intake.application_id)
    assert.equal(appAfterIntake.rubric_version_id, null, 'intake 阶段申请不钉 rubric')

    const scheduled = await scheduleInTransaction(client, cfg, {
      intent: 'CREATE',
      idempotency_key: `sc11-same-schedule-${uniqueSuffix()}`,
      application_id: intake.application_id,
      round_no: 1,
      interviewers: [{ actor_id: HR_ACTOR }],
      scheduled_start_at: START,
      duration_minutes: 60,
    }, NOW, allowOnce)
    const interviewId = (scheduled.changes as { created: { table: string; id: string }[] }).created
      .find((change) => change.table === 'interview')?.id
    assert.ok(interviewId !== undefined, '排期必须创建 interview 行')

    // 面评显式绑 V1（此时申请还没 pin：这是契约允许的 SC-10 路径）。
    const submitted = await submitScorecardInTransaction(client, cfg, {
      interview_id: interviewId,
      rubric_version_id: v1,
      items: itemsForV1(),
      overall: 'HOLD',
      idempotency_key: `sc11-same-scorecard-${uniqueSuffix()}`,
    }, NOW, allowOnce)
    const scorecard = submitted.scorecard as Record<string, unknown>
    assert.equal(scorecard.rubric_version_id, v1, '面评绑 V1')

    // 关键差异：岗位批准的是**同一版 V1**（不是错配用例里的 V2）→ 版本一致，属合法路径。
    const approved = await approveRubricInTransaction(client, cfg, { job_id: jobId, rubric_version_id: v1 }, allowOnce)
    assert.equal(approved.outcome, 'APPROVED')
    assert.equal(approved.job.current_rubric_version_id, v1, '岗位 current 指针 = V1')

    const before = await appRow(client, intake.application_id)
    assert.equal(before.rubric_version_id, null)
    // 不得报 RUBRIC_PIN_CONFLICT_WITH_SCORECARD：调用能正常返回（抛错会让本用例直接失败）。
    const result = await advanceApplicationStage(client, { tenantId: TENANT, applicationId: intake.application_id })
    console.log(`  [合法路径 V1==V1] status=${result.status} stage=${result.stage_code}`
      + ` transitions=${JSON.stringify(result.transitions)} record_version=${before.record_version}→${result.record_version}`)

    assert.equal(result.status, 'ADVANCED', '版本一致的面评不得触发冲突闸')
    assert.equal(result.stage_code, 'S7')
    assert.deepEqual(result.transitions, [{ from: 'S6', to: 'S7' }])

    const after = await appRow(client, intake.application_id)
    assert.equal(after.current_stage_code, 'S7', 'current_stage_code 必须真的变了')
    assert.notEqual(after.current_stage_code, before.current_stage_code)
    assert.equal(after.rubric_version_id, v1, '补钉写的就是面评实际使用的 V1')
    assert.equal(after.record_version, before.record_version + 2, '补钉 +1、阶段迁移 +1（fn_row_guard 维护）')

    // 补钉审计：恰好 1 条，值 = V1（合法路径也留痕）。
    const pinnedEvents = (await client.query<{ payload: Record<string, unknown> }>(
      `select payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'application.rubric_version.pinned' and source_object_id = $2`,
      [TENANT, intake.application_id],
    )).rows
    assert.equal(pinnedEvents.length, 1)
    assert.equal(pinnedEvents[0]?.payload.rubric_version_id, v1)
    // 阶段迁移事件也恰好 1 条（真的推了，不是"返回 ADVANCED 但没写库"）。
    assert.equal(await count(client,
      `select count(*)::int as n from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'application.current_stage_code.changed' and source_object_id = $2`,
      [TENANT, intake.application_id]), 1)
  })
})

// =====================================================================
//  1b. 只读视图：同一冲突必须被结构化报成 BLOCKED（不是"只是没钉 rubric"）
// =====================================================================

test('只读视图：补钉会撞 V1 面评时报 BLOCKED(RUBRIC_PIN_CONFLICT_WITH_SCORECARD)，带 owner_role + next_action_code，且零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const path = await constructMismatchPath(client)
    const before = await appRow(client, path.applicationId)

    const view = await readStageBlockedView(client, { tenantId: TENANT, applicationId: path.applicationId })
    const blockerText = view.blockers.map((blocker) => `${blocker.kind}:${blocker.code}`).join(' ; ')
    console.log(`  [stage view] status=${view.status} blockers=${blockerText}`
      + ` next_action=${view.next_action.code} owner=${view.owner.role}`)

    assert.equal(view.status, 'BLOCKED')
    assert.equal(view.blocked, true)
    const blocker = view.blockers.find((item) => item.code === 'RUBRIC_PIN_CONFLICT_WITH_SCORECARD')
    assert.ok(blocker !== undefined, `视图必须报冲突码；实际 ${blockerText}`)
    assert.equal(blocker.kind, 'BLOCKER')
    assert.equal(blocker.owner_role, 'JOB_HIRING_MANAGER', '结构化拒绝必须带 owner_role')
    assert.equal(blocker.next_action_code, 'RESOLVE_RUBRIC_PIN_CONFLICT', '结构化拒绝必须带 next_action_code')
    assert.equal(view.owner.role, 'JOB_HIRING_MANAGER')
    assert.equal(view.next_action.code, 'RESOLVE_RUBRIC_PIN_CONFLICT')
    // 不再用含糊的 RUBRIC_NOT_PINNED 盖住"补钉必然被拒"这个事实。
    assert.equal(view.blockers.some((item) => item.code === 'RUBRIC_NOT_PINNED'), false)

    // 只读视图一条写都不发。
    assert.deepEqual(await appRow(client, path.applicationId), before)
  })
})

// =====================================================================
//  2. 强行绕过补钉：summarize / decision 必须被 ② 拒绝（不静默混用）
// =====================================================================
test('强行绕过补钉后：summarize 剔除 V1 面评并报 SCORECARD_RUBRIC_MISMATCH；decision 拒绝 SCORECARD_RUBRIC_MISMATCH', async () => {
  await inRolledBackTx(pool, async (client) => {
    const path = await constructMismatchPath(client)

    // 强行绕过 ①（模拟另一条写路径/人工修数据）：直接把申请钉到 V2。
    const bypassed = (await client.query<{ record_version: number }>(
      `update recruitment.application
          set rubric_version_id = $3
        where tenant_id = $1 and id = $2 and rubric_version_id is null
        returning record_version`,
      [TENANT, path.applicationId, path.rubrics.v2],
    )).rows[0]
    assert.ok(bypassed !== undefined, '绕过 UPDATE 必须命中（申请此前未钉）')
    // DC-07 阶段闸门（task-71）：STAGE/FINAL 决策要求申请当前阶段 S10；本用例要测的是
    // SC-11 的错配闸门，所以先把申请推进到 S10（事务内 GUC actor 已由 inRolledBackTx 设好）。
    await client.query(
      "update recruitment.application set current_stage_code = 'S10' where tenant_id = $1 and id = $2",
      [TENANT, path.applicationId],
    )

    // ---- ②-a 汇总：该条不进汇总，且必须能被调用方看见 ----
    const summary = await computeEvaluationSummaryIn(client, cfg, {
      application_id: path.applicationId,
      decision_scope: 'STAGE',
      interview_id: path.interviewId,
      as_of: AS_OF,
    }, NOW) as unknown as Record<string, unknown>
    const warnings = summary.warnings as { code: string; detail?: Record<string, unknown> }[]
    console.log(`  [summarize] warnings=${JSON.stringify(warnings.map((warning) => warning.code))}`
      + ` coverage=${JSON.stringify(summary.coverage)} tally=${JSON.stringify(summary.tally)}`)
    const mismatch = warnings.find((warning) => warning.code === 'SCORECARD_RUBRIC_MISMATCH')
    assert.ok(mismatch !== undefined, `必须报 SCORECARD_RUBRIC_MISMATCH；实际 warnings=${JSON.stringify(warnings.map((w) => w.code))}`)
    const mismatchDetail = mismatch.detail as Record<string, unknown>
    assert.equal(mismatchDetail.application_rubric_version_id, path.rubrics.v2)
    assert.equal(mismatchDetail.mismatched_count, 1)
    const listed = mismatchDetail.scorecards as Record<string, unknown>[]
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.scorecard_id, path.scorecardId)
    assert.equal(listed[0]?.rubric_version_id, path.rubrics.v1)
    assert.equal(listed[0]?.status, 'SUBMITTED')

    // 该条不进汇总：submitted=0、tally 全 0、aggregation 不计算、snapshot 不含它。
    const coverage = summary.coverage as Record<string, number>
    assert.equal(coverage.submitted, 0, '版本不一致的面评不得计入 submitted')
    assert.equal(coverage.required_total, 1)
    assert.equal(coverage.missing, 1, '必填面评被剔除后必须落进 missing（不等于"没交"，但绝不静默）')
    const tally = summary.tally as Record<string, number>
    assert.deepEqual(tally, { advance: 0, hold: 0, reject: 0, waived: 0 })
    const aggregation = summary.aggregation as Record<string, unknown>
    assert.equal(aggregation.method, 'NOT_COMPUTED')
    assert.equal((summary.snapshot as Record<string, unknown>).rubric_version_id, path.rubrics.v2)
    assert.deepEqual((summary.snapshot as Record<string, unknown>).scorecard_ids, [], 'V1 面评不得进入 V2 汇总的 snapshot')
    assert.equal(summary.ready_for_decision, false)
    assert.deepEqual(summary.permitted_results, ['HOLD', 'WITHDRAW'], '缺面板时只剩安全方向')

    // ---- ②-b 决策：直接拒绝（同一错误码），零写入 ----
    const decisionRowsBefore = await count(client, `select count(*)::int as n from recruitment.decision
       where tenant_id = $1 and application_id = $2`, [TENANT, path.applicationId])
    const reason = '按 SC-11 复核：本场面评绑的是旧版标准，不能用它做决策'
    const basisRefs: Record<string, unknown>[] = [
      { kind: 'SUMMARY', summary_digest: String(summary.summary_digest) },
      {
        kind: 'RUBRIC_VERSION',
        id: path.rubrics.v2,
        payload_hash: String((await client.query<{ payload_hash: string }>(
          'select payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
          [TENANT, path.rubrics.v2],
        )).rows[0]?.payload_hash),
      },
      { kind: 'AUTHORITY', actor_id: HR_ACTOR, is_hiring_manager: false },
      {
        kind: 'SCORECARD',
        id: path.scorecardId,
        overall: 'HOLD',
        transcript_basis: 'NO_TRANSCRIPT',
        transcript_state: 'NO_TRANSCRIPT',
        rubric_version_id: path.rubrics.v1,
      },
    ]
    const decisionArgs: Record<string, unknown> = {
      application_id: path.applicationId,
      decision_scope: 'STAGE',
      interview_id: path.interviewId,
      as_of: AS_OF,
      result: 'ADVANCE',
      reason,
      basis_refs: basisRefs,
      summary_digest: String(summary.summary_digest),
      human_confirmation: {
        confirmed_by_actor_id: HR_ACTOR,
        confirmed_at: new Date(NOW - 60 * 1000).toISOString(),
        confirmation_method: 'IN_APP_CONFIRM',
        confirmation_text_sha256: confirmationTextSha256({
          result: 'ADVANCE',
          reason,
          override_rationale: null,
          basis_refs: basisRefs,
        }),
      },
    }
    const decisionBody = await rejection(recordDecisionInTransaction(
      client, cfg, decisionArgs, NOW, allowOnce,
    ))
    assert.equal(decisionBody.code, 'EVIDENCE_INSUFFICIENT', `错误体：${JSON.stringify(decisionBody)}`)
    assert.equal(decisionBody.reason_code, 'SCORECARD_RUBRIC_MISMATCH')
    console.log(`  [gate ② decision_record] ${String(decisionBody.code)}(${String(decisionBody.reason_code)})`
      + ` detail=${JSON.stringify(decisionBody.detail)}`)
    const decisionDetail = decisionBody.detail as Record<string, unknown>
    assert.equal(decisionDetail.application_rubric_version_id, path.rubrics.v2)
    assert.equal(decisionDetail.mismatched_count, 1)
    assert.equal((decisionDetail.scorecards as Record<string, unknown>[])[0]?.scorecard_id, path.scorecardId)

    // 零写入：一条决策行都没有，也没有 decision.record 事件。
    assert.equal(await count(client, `select count(*)::int as n from recruitment.decision
       where tenant_id = $1 and application_id = $2`, [TENANT, path.applicationId]), decisionRowsBefore)
    assert.equal(await count(client, `select count(*)::int as n from recruitment.event_inbox
       where tenant_id = $1 and event_type = 'decision.record' and payload->>'application_id' = $2`,
    [TENANT, path.applicationId]), 0)
  })
})

// =====================================================================
//  2b. 阴性对照（止血动作不被一刀切）：版本错配时 HOLD / WITHDRAW 必须仍可用
//
//     产品语义：SC-11 的错配闸门只挡"拿错配面板做正式结论"（ADVANCE/REJECT），
//     **不挡止血动作**——候选人可以撤回（WITHDRAW），招聘侧可以"暂不决定"（HOLD）。
//     这两项在 decision-rules §4.2.1 里本来就不受"缺面评/零面评"影响；版本错配同理。
// =====================================================================

/** 强行绕过补钉（模拟另一条写路径 / 人工修数据）：只改 `rubric_version_id`，仍走 `fn_row_guard`。 */
async function forcePinRubric(
  client: DatabaseClient,
  applicationId: string,
  rubricVersionId: string,
): Promise<void> {
  const row = (await client.query<{ record_version: number }>(
    `update recruitment.application
        set rubric_version_id = $3
      where tenant_id = $1 and id = $2 and rubric_version_id is null
      returning record_version`,
    [TENANT, applicationId, rubricVersionId],
  )).rows[0]
  assert.ok(row !== undefined, '绕过 UPDATE 必须命中（申请此前未钉）')
}

/**
 * 造一次决策入参（含人工确认 hash）：`basis_refs` 引申请钉住的 V2 + 那条错配的 V1 面评。
 * @param client - 事务内连接。
 * @param path - 构造好的缺陷路径。
 * @param summary - 本次汇总（取 `summary_digest`）。
 * @param result - `HOLD` / `WITHDRAW`（止血动作）。
 * @returns 可直接交给 `recordDecisionInTransaction` 的入参。
 */
async function decisionArgsFor(
  client: DatabaseClient,
  path: ConstructedPath,
  summary: Record<string, unknown>,
  result: 'HOLD' | 'WITHDRAW',
): Promise<Record<string, unknown>> {
  const reason = `SC-11 复核：本场面评绑的是旧版标准（${path.rubrics.v1}），本轮只做止血动作（${result}）`
  const pinnedPayloadHash = String((await client.query<{ payload_hash: string }>(
    'select payload_hash from recruitment.rubric_version where tenant_id = $1 and id = $2',
    [TENANT, path.rubrics.v2],
  )).rows[0]?.payload_hash)
  const basisRefs: Record<string, unknown>[] = [
    { kind: 'SUMMARY', summary_digest: String(summary.summary_digest) },
    { kind: 'RUBRIC_VERSION', id: path.rubrics.v2, payload_hash: pinnedPayloadHash },
    { kind: 'AUTHORITY', actor_id: HR_ACTOR, is_hiring_manager: false },
    {
      kind: 'SCORECARD',
      id: path.scorecardId,
      overall: 'HOLD',
      transcript_basis: 'NO_TRANSCRIPT',
      transcript_state: 'NO_TRANSCRIPT',
      rubric_version_id: path.rubrics.v1,
    },
  ]
  return {
    application_id: path.applicationId,
    decision_scope: 'STAGE',
    interview_id: path.interviewId,
    as_of: AS_OF,
    result,
    reason,
    basis_refs: basisRefs,
    summary_digest: String(summary.summary_digest),
    human_confirmation: {
      confirmed_by_actor_id: HR_ACTOR,
      confirmed_at: new Date(NOW - 60 * 1000).toISOString(),
      confirmation_method: 'IN_APP_CONFIRM',
      confirmation_text_sha256: confirmationTextSha256({
        result,
        reason,
        override_rationale: null,
        basis_refs: basisRefs,
      }),
    },
  }
}

test('阴性对照（止血动作不被一刀切）：版本错配时 summarize 的 permitted_results 仍含 HOLD 与 WITHDRAW', async () => {
  await inRolledBackTx(pool, async (client) => {
    const path = await constructMismatchPath(client)
    await forcePinRubric(client, path.applicationId, path.rubrics.v2)
    const summary = await computeEvaluationSummaryIn(client, cfg, {
      application_id: path.applicationId,
      decision_scope: 'STAGE',
      interview_id: path.interviewId,
      as_of: AS_OF,
    }, NOW) as unknown as Record<string, unknown>
    const permitted = summary.permitted_results as string[]
    console.log(`  [permitted under mismatch] ${JSON.stringify(permitted)}`)
    assert.ok(permitted.includes('HOLD'), `HOLD 必须仍被允许（止血动作）；实际 ${JSON.stringify(permitted)}`)
    assert.ok(permitted.includes('WITHDRAW'), `WITHDRAW 必须仍被允许（候选人可撤回）；实际 ${JSON.stringify(permitted)}`)
  })
})

test('阴性对照（止血动作不被一刀切）：版本错配时用 HOLD 提交决策**必须成功落库**', async () => {
  await inRolledBackTx(pool, async (client) => {
    const path = await constructMismatchPath(client)
    await forcePinRubric(client, path.applicationId, path.rubrics.v2)
    // DC-07 阶段闸门（task-71）：止血动作用例也必须先到 S10（否则拿到的是 STAGE_NOT_S10，
    // 测不到"错配只挡正式结论、不挡 HOLD"这条产品语义）。
    await client.query(
      "update recruitment.application set current_stage_code = 'S10' where tenant_id = $1 and id = $2",
      [TENANT, path.applicationId],
    )
    const summary = await computeEvaluationSummaryIn(client, cfg, {
      application_id: path.applicationId,
      decision_scope: 'STAGE',
      interview_id: path.interviewId,
      as_of: AS_OF,
    }, NOW) as unknown as Record<string, unknown>
    const args = await decisionArgsFor(client, path, summary, 'HOLD')

    let outcome: Record<string, unknown> | undefined
    let failure: Record<string, unknown> | undefined
    try {
      outcome = await recordDecisionInTransaction(client, cfg, args, NOW, allowOnce) as unknown as Record<string, unknown>
    } catch (error) {
      failure = errorBody(error)
    }
    // 产品语义：错配闸门只挡 ADVANCE/REJECT，不挡"暂不决定"；被挡死就是缺口（不得改测试迁就）。
    assert.equal(
      failure,
      undefined,
      '版本错配时 HOLD 必须能落库（闸门只挡正式结论，不挡止血动作）；实际被挡：'
        + JSON.stringify(failure),
    )
    console.log(`  [HOLD under mismatch] status=${String(outcome?.status)}`
      + ` result=${String((outcome?.decision as Record<string, unknown> | undefined)?.result)}`)
    assert.equal(outcome?.status, 'OK')
    const decision = outcome?.decision as Record<string, unknown> | undefined
    assert.equal(decision?.result, 'HOLD')
    assert.equal(await count(client,
      `select count(*)::int as n from recruitment.decision
        where tenant_id = $1 and application_id = $2 and decision_scope = 'STAGE'
          and superseded_by_decision_id is null`,
      [TENANT, path.applicationId]), 1, 'HOLD 必须真的写入一行 current 决策')
  })
})

// =====================================================================
//  3. fn_row_guard 实测：补钉的 UPDATE 会不会撞触发器？
// =====================================================================

test('fn_row_guard 实测：补钉 UPDATE 经过 application 的触发器，record_version 恰好 +1；状态未变 → 触发器不写审计事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const scenario = await seedScenario(client, { dimensions: CRITERIA_V1, approve: true, pinRubric: false })

    // 3.1 先看 application 上到底挂了哪些触发器（库目录是唯一事实来源）。
    const triggers = (await client.query<{ tgname: string; fn: string }>(
      `select t.tgname, p.proname as fn
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_proc p on p.oid = t.tgfoid
        where n.nspname = 'recruitment' and c.relname = 'application' and not t.tgisinternal
        order by t.tgname`,
    )).rows
    const triggerText = triggers.map((trigger) => `${trigger.tgname} → ${trigger.fn}`).join(' ; ')
    // 真实输出（供复核窗口核对：补钉 UPDATE 必然经过前两个 fn_row_guard 触发器）。
    console.log(`  [fn_row_guard] application 触发器：${triggerText}`)
    const guardTriggers = triggers.filter((trigger) => trigger.fn === 'fn_row_guard')
    assert.equal(guardTriggers.length, 2, 'application 上有两个 fn_row_guard（lifecycle_status / current_stage_code）')

    const before = (await client.query<{
      rubric_version_id: string | null
      record_version: number
      status_changed_at: string | null
      stage_changed_at: string | null
      updated_at: string
    }>(
      `select rubric_version_id, record_version, status_changed_at, stage_changed_at, updated_at
         from recruitment.application where tenant_id = $1 and id = $2`,
      [TENANT, scenario.applicationId],
    )).rows[0]
    assert.ok(before !== undefined)
    assert.equal(before.rubric_version_id, null)
    const eventsBefore = await count(client,
      'select count(*)::int as n from recruitment.event_inbox where tenant_id = $1', [TENANT])

    // 3.2 跑**与 pinCurrentRubric 同形的**条件 UPDATE（只改 rubric_version_id）。
    const updated = (await client.query<{ record_version: number }>(
      `update recruitment.application
          set rubric_version_id = $3
        where id = $1 and tenant_id = $2 and rubric_version_id is null
        returning record_version`,
      [scenario.applicationId, TENANT, scenario.rubricId],
    )).rows[0]
    assert.ok(updated !== undefined, '条件 UPDATE 必须命中')

    const after = (await client.query<{
      rubric_version_id: string | null
      record_version: number
      status_changed_at: string | null
      stage_changed_at: string | null
      updated_at: string
    }>(
      `select rubric_version_id, record_version, status_changed_at, stage_changed_at, updated_at
         from recruitment.application where tenant_id = $1 and id = $2`,
      [TENANT, scenario.applicationId],
    )).rows[0]
    assert.ok(after !== undefined)
    const eventsAfter = await count(client,
      'select count(*)::int as n from recruitment.event_inbox where tenant_id = $1', [TENANT])

    /** 时间列按**值**比较（pg 返回 Date 对象，`===` 比较的是引用）。 */
    const sameInstant = (left: string | Date | null, right: string | Date | null): boolean => {
      if (left === null || right === null) return left === right
      return new Date(left).getTime() === new Date(right).getTime()
    }
    // 3.3 真实输出（复核窗口要的三问：经触发器？写审计？版本 +1？）
    console.log(`  [fn_row_guard] 补钉 UPDATE: record_version ${before.record_version} → ${updated.record_version}（RETURNING）→ 读回 ${after.record_version}`)
    console.log(`  [fn_row_guard] event_inbox 行数：${eventsBefore} → ${eventsAfter}（差 ${eventsAfter - eventsBefore}）`)
    console.log(`  [fn_row_guard] status_changed_at 未变=${sameInstant(before.status_changed_at, after.status_changed_at)},`
      + ` stage_changed_at 未变=${sameInstant(before.stage_changed_at, after.stage_changed_at)}`)

    assert.equal(after.rubric_version_id, scenario.rubricId, '补钉值必须落库')
    assert.equal(after.record_version, before.record_version + 1, 'record_version 恰好 +1（两个守卫都从 old 计算，不会 +2）')
    assert.equal(updated.record_version, after.record_version, 'RETURNING 就是读回值，不手写 record_version')
    assert.ok(sameInstant(before.status_changed_at, after.status_changed_at), '状态未迁移 → 不许动 status_changed_at')
    assert.ok(sameInstant(before.stage_changed_at, after.stage_changed_at), '阶段未迁移 → 不许动 stage_changed_at')
    assert.equal(eventsAfter, eventsBefore, '状态未变 → fn_row_guard 不写 event_inbox（补钉审计由应用层单独写）')
  })
})
