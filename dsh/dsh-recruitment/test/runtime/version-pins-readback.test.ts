// D-120（任务书版本钉）· `readback.ts` 四个**只读**版本钉查询的真实库验收。
//
// 库纪律：`createRuntimeTestDatabase('vpin_rd')` 一次性空库（0001→0016 顺序重放，
// 跑完 DROP）；夹具在一个**真提交**事务里造（`withActor`：BEGIN → SET LOCAL actor →
// 造数 → COMMIT），因为产品读路径（`withReadOnly` 各开一条连接）只能看见已提交行。
//
// 守的是 D-120 的四条事实来源口径（不许从事件 payload 猜）：
//   ① application 行上的四个钉（job / job_version / rubric_version / resume_version）
//      + `resume_version.source_asset_sha256` 逐字一致；
//   ② job.current_* 只是**当前指针**，不是申请钉住值（同一岗位两者可不同）；
//   ③ INTAKE_RECORD → application 反查：恰 1 个候选才给 id；共用 resume_version 时
//      candidates>1 且 **applicationId=null（歧义不猜）**；无链 → 0；
//   ④ interview + 当前 interview_record（is_current）的 rubric/job/模板钉子；无当前
//      记录时两个 record 字段为 null。
// 另外：不存在的 id → null、tenant 过滤不是装饰、`RuntimeStore` 委托与 readback 同值。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { withActor } from '../../src/db/pool.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import {
  applicationLinkForIntakeRecord,
  applicationVersionPins,
  interviewVersionPins,
  jobVersionPointers,
} from '../../src/runtime/store/readback.ts'
import {
  DEMO_DEPARTMENT,
  HR_ACTOR,
  TENANT,
  hex64,
  one,
  seedScenario,
  uniqueSuffix,
  type Scenario,
} from '../integration/db.ts'
import {
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  createRuntimeTestDatabase,
  type RuntimeTestDatabase,
} from './db.ts'

/** 一份能被 `seedScenario` 接受的 Rubric（本文件不跑筛选，只为满足外键与 payload_hash）。 */
const DIMENSIONS = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months', label: '≥60 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 60 },
] as const

/** 一个合法但库里不存在的 UUID 租户：只用来证明 tenant 判等不是装饰。 */
const OTHER_TENANT = '99999999-9999-4999-8999-000000000001'

let db: RuntimeTestDatabase
let store: RuntimeStore
let fx: Fixtures

/** `before` 里一次性造好、真提交的夹具 id 集合（断言里逐字比对）。 */
interface Fixtures {
  readonly applicationId: string
  readonly jobId: string
  readonly jobVersionId: string
  readonly rubricId: string
  readonly resumeVersionId: string
  readonly intakeRecordId: string
  readonly unpinnedApplicationId: string
  readonly unpinnedJobId: string
  readonly unpinnedJobVersionId: string
  readonly unpinnedRubricId: string
  readonly emptyChainIntakeRecordId: string
  readonly sharedResumeVersionId: string
  readonly sharedApplicationId: string
  readonly secondApplicationId: string
  readonly ambiguousIntakeRecordId: string
  readonly noPointersJobId: string
  readonly interviewTemplateVersionId: string
  readonly interviewId: string
  readonly currentRecordRubricId: string
  readonly supersededRecordRubricId: string
  readonly bareInterviewId: string
}

before(async () => {
  db = await createRuntimeTestDatabase('vpin_rd')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  // 真提交：readback 的 `withReadOnly` 走另开的连接，未提交的行它们看不见。
  fx = await withActor(db.pool, RUNTIME_ACTOR, seedFixtures)
})

after(async () => {
  if (db !== undefined) await db.drop()
})

// ---------------------------------------------------------------------------
//  夹具（测试代码故意直接写库：工具端点不提供造夹具入口）
// ---------------------------------------------------------------------------

/** 造全部夹具（在一个事务里调用；返回的 id 即库里已提交行的 id）。 */
async function seedFixtures(client: DatabaseClient): Promise<Fixtures> {
  // ① 完整申请链：job → job_version → rubric → 材料链（event/intake/asset/resume）→ application
  const base = await seedScenario(client, { dimensions: DIMENSIONS })
  const intakeRecordId = await intakeRecordIdOf(client, base.resumeVersionId)

  // ② 申请**没钉** rubric / 简历（job.current_* 仍会被 seedScenario 指向已批准 rubric）
  const unpinned = await seedScenario(client, { dimensions: DIMENSIONS, pinRubric: false, bindMaterial: false })
  const emptyChainIntakeRecordId = await intakeRecordIdOf(client, unpinned.resumeVersionId)

  // ③ 两条申请共用同一 resume_version（同一份材料被多条申请引用）→ 反查必须报歧义
  const shared = await seedScenario(client, { dimensions: DIMENSIONS })
  const ambiguousIntakeRecordId = await intakeRecordIdOf(client, shared.resumeVersionId)
  const secondApplicationId = await insertApplicationForScenario(client, shared)

  // ④ 没有任何版本指针的岗位（两个 current_* 都是 null）
  const noPointersJobId = await one(client, `insert into recruitment.job
      (tenant_id, department_id, code, title, status)
      values ($1, $2, $3, '无版本指针岗位', 'OPEN') returning id`,
  [TENANT, DEMO_DEPARTMENT, `T-${uniqueSuffix()}`])

  // ⑤ 面试：模板版本 + 一条被取代的记录（rubric v1）+ 一条当前记录（同岗位 rubric v2）
  const interviewTemplateVersionId = await insertInterviewTemplateVersion(client, base.jobId, base.rubricId)
  const supersededRecordRubricId = base.rubricId
  const currentRecordRubricId = await insertRubricVersion(client, base.jobId, 2)
  const interviewId = await insertInterview(client, {
    applicationId: base.applicationId, templateVersionId: interviewTemplateVersionId, roundNo: 1,
  })
  const artifactId = await insertTranscriptArtifact(client)
  await insertInterviewRecord(client, {
    interviewId, artifactId, rubricVersionId: supersededRecordRubricId, jobId: base.jobId, isCurrent: false,
  })
  await insertInterviewRecord(client, {
    interviewId, artifactId, rubricVersionId: currentRecordRubricId, jobId: base.jobId, isCurrent: true,
  })

  // ⑥ 同一申请的第二场面试：没有 interview_record，也没有模板版本
  const bareInterviewId = await insertInterview(client, {
    applicationId: base.applicationId, templateVersionId: null, roundNo: 2,
  })

  return {
    applicationId: base.applicationId,
    jobId: base.jobId,
    jobVersionId: base.jobVersionId,
    rubricId: base.rubricId,
    resumeVersionId: base.resumeVersionId,
    intakeRecordId,
    unpinnedApplicationId: unpinned.applicationId,
    unpinnedJobId: unpinned.jobId,
    unpinnedJobVersionId: unpinned.jobVersionId,
    unpinnedRubricId: unpinned.rubricId,
    emptyChainIntakeRecordId,
    sharedResumeVersionId: shared.resumeVersionId,
    sharedApplicationId: shared.applicationId,
    secondApplicationId,
    ambiguousIntakeRecordId,
    noPointersJobId,
    interviewTemplateVersionId,
    interviewId,
    currentRecordRubricId,
    supersededRecordRubricId,
    bareInterviewId,
  }
}

/** 一份申请链的 `intake_record` id（`seedScenario` 返回 id 集合里不含它，按物理链读回）。 */
async function intakeRecordIdOf(client: DatabaseClient, resumeVersionId: string): Promise<string> {
  return one(client, `select ir.id::text as id
        from recruitment.intake_record ir
        join recruitment.intake_asset ia
          on ia.intake_record_id = ir.id and ia.tenant_id = ir.tenant_id
        join recruitment.resume r
          on r.intake_asset_id = ia.id and r.tenant_id = ia.tenant_id
        join recruitment.resume_version rv
          on rv.resume_id = r.id and rv.tenant_id = r.tenant_id
       where rv.tenant_id = $1 and rv.id = $2`, [TENANT, resumeVersionId])
}

/** 用**另一个候选人**再建一条申请，钉住同一个 resume_version（制造真实歧义）。 */
async function insertApplicationForScenario(client: DatabaseClient, scenario: Scenario): Promise<string> {
  const candidateId = await one(client, `insert into recruitment.candidate (tenant_id, display_name)
      values ($1, $2) returning id`, [TENANT, `版本钉候选人-${uniqueSuffix()}`])
  return one(client, `insert into recruitment.application
      (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, resume_version_id,
       lifecycle_status, current_stage_code)
      values ($1, $2, $3, $4, $5, $6, 'ACTIVE', 'S7') returning id`,
  [TENANT, candidateId, scenario.jobId, scenario.jobVersionId, scenario.rubricId, scenario.resumeVersionId])
}

/** 同岗位的第二个 rubric 版本（版本号 > 1 才不撞 `uq_rubric_version`）。 */
async function insertRubricVersion(client: DatabaseClient, jobId: string, versionNo: number): Promise<string> {
  return one(client, `insert into recruitment.rubric_version
      (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
      values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
  [TENANT, jobId, versionNo, JSON.stringify(DIMENSIONS), hex64(`vpin-rubric-${uniqueSuffix()}`), HR_ACTOR])
}

/** 面试模板版本（`interview.interview_template_version_id` 的来源）。 */
async function insertInterviewTemplateVersion(
  client: DatabaseClient, jobId: string, rubricVersionId: string,
): Promise<string> {
  return one(client, `insert into recruitment.interview_template_version
      (tenant_id, job_id, template_code, round_no, version_no, payload_hash, rubric_version_id)
      values ($1, $2, $3, 1, 1, $4, $5) returning id`,
  [TENANT, jobId, `VP${uniqueSuffix().toUpperCase()}`, hex64(`vpin-template-${uniqueSuffix()}`), rubricVersionId])
}

/** 直接 INSERT 一场面试（SCHEDULED 必须有 `scheduled_start_at`）。 */
async function insertInterview(client: DatabaseClient, input: {
  readonly applicationId: string
  readonly templateVersionId: string | null
  readonly roundNo: number
}): Promise<string> {
  return one(client, `insert into recruitment.interview
      (tenant_id, application_id, interview_template_version_id, round_no, slot_code,
       stage_code, status, scheduled_start_at, status_changed_by_actor_id)
      values ($1, $2, $3, $4, 'DEFAULT', 'S8', 'SCHEDULED', now(), $5) returning id`,
  [TENANT, input.applicationId, input.templateVersionId, input.roundNo, HR_ACTOR])
}

/** 造 meeting + transcript_artifact（`interview_record` 的外键是 (artifact id, source_revision)）。 */
async function insertTranscriptArtifact(client: DatabaseClient): Promise<string> {
  const suffix = uniqueSuffix()
  const meetingId = await one(client, `insert into recruitment.meeting
      (tenant_id, provider, external_meeting_id, meeting_role)
      values ($1, 'FEISHU', $2, 'PRIMARY') returning id`, [TENANT, `vpin_meeting_${suffix}`])
  return one(client, `insert into recruitment.transcript_artifact
      (tenant_id, meeting_id, provider, provider_artifact_id, provenance, trigger_mode,
       connection_state, raw_text)
      values ($1, $2, 'feishu', $3, 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', '版本钉测试转写') returning id`,
  [TENANT, meetingId, `vpin_artifact_${suffix}`])
}

/** 直接 INSERT 一条面评记录（`job_id` 显式给：0008 触发器要求等于 interview→application.job_id）。 */
async function insertInterviewRecord(client: DatabaseClient, input: {
  readonly interviewId: string
  readonly artifactId: string
  readonly rubricVersionId: string
  readonly jobId: string
  readonly isCurrent: boolean
}): Promise<string> {
  return one(client, `insert into recruitment.interview_record
      (tenant_id, interview_id, transcript_artifact_id, transcript_revision, rubric_version_id,
       prompt_version, model_id, job_id, is_current)
      values ($1, $2, $3, 1, $4, 'vpin-prompt/1.0.0', 'vpin-model', $5, $6) returning id`,
  [TENANT, input.interviewId, input.artifactId, input.rubricVersionId, input.jobId, input.isCurrent])
}

// ---------------------------------------------------------------------------
//  **独立读回**（不 import 产品代码；只读 SQL，证明断言不是拿返回值自证）
// ---------------------------------------------------------------------------

/** 单列多行读回。 */
async function column(sql: string, params: readonly unknown[]): Promise<string[]> {
  const { rows } = await db.pool.query<Record<string, string>>(sql, [...params])
  return rows.map((row) => String(Object.values(row)[0]))
}

/** 单值读回（0 行 / 多行都是夹具或 SQL 写错了，直接失败）。 */
async function scalar(sql: string, params: readonly unknown[]): Promise<string> {
  const values = await column(sql, params)
  if (values.length !== 1) throw new Error(`expected exactly 1 row, got ${values.length}: ${sql.slice(0, 60)}`)
  return String(values[0])
}

// ---------------------------------------------------------------------------
//  验收
// ---------------------------------------------------------------------------

describe('D-120 版本钉只读查询（fresh 空库 + 真提交夹具）', () => {
  test('applicationVersionPins：四钉逐字取自 application 行，resumeSha256 = resume_version.source_asset_sha256', async () => {
    // 独立读回原件哈希（不经产品代码）：它必须与返回值**逐字一致**。
    const shaFromDb = await scalar(
      `select source_asset_sha256 as sha from recruitment.resume_version
        where tenant_id = $1 and id = $2`,
      [RUNTIME_TENANT, fx.resumeVersionId],
    )
    assert.match(shaFromDb, /^[0-9a-f]{64}$/)
    assert.deepEqual(await applicationVersionPins(db.pool, RUNTIME_TENANT, fx.applicationId), {
      applicationId: fx.applicationId,
      jobId: fx.jobId,
      jobVersionId: fx.jobVersionId,
      rubricVersionId: fx.rubricId,
      resumeVersionId: fx.resumeVersionId,
      resumeSha256: shaFromDb,
    })
  })

  test('申请没钉 rubric/简历时如实给 null；job.current_* 非空也不同值（当前指针 ≠ 申请钉住值）', async () => {
    assert.deepEqual(await applicationVersionPins(db.pool, RUNTIME_TENANT, fx.unpinnedApplicationId), {
      applicationId: fx.unpinnedApplicationId,
      jobId: fx.unpinnedJobId,
      jobVersionId: fx.unpinnedJobVersionId,
      rubricVersionId: null,
      resumeVersionId: null,
      resumeSha256: null,
    })
    // seedScenario 把已批准 rubric 写进 job.current_*：这就是"降级来源"，不能冒充申请钉。
    assert.deepEqual(await jobVersionPointers(db.pool, RUNTIME_TENANT, fx.unpinnedJobId), {
      jobId: fx.unpinnedJobId,
      currentJobVersionId: fx.unpinnedJobVersionId,
      currentRubricVersionId: fx.unpinnedRubricId,
    })
  })

  test('jobVersionPointers：current_job_version_id / current_rubric_version_id 逐字一致；无版本岗位两个都为 null', async () => {
    assert.deepEqual(await jobVersionPointers(db.pool, RUNTIME_TENANT, fx.jobId), {
      jobId: fx.jobId,
      currentJobVersionId: fx.jobVersionId,
      currentRubricVersionId: fx.rubricId,
    })
    assert.deepEqual(await jobVersionPointers(db.pool, RUNTIME_TENANT, fx.noPointersJobId), {
      jobId: fx.noPointersJobId,
      currentJobVersionId: null,
      currentRubricVersionId: null,
    })
  })

  test('applicationLinkForIntakeRecord：唯一候选给 applicationId；共用 resume_version → candidates>1 且不猜；无链 → 0', async () => {
    assert.deepEqual(
      await applicationLinkForIntakeRecord(db.pool, RUNTIME_TENANT, fx.intakeRecordId),
      { applicationId: fx.applicationId, candidates: 1 },
    )

    // 歧义来自库里的真实状态：这份 resume_version 确实被两条申请共用。
    const linkedApplicationIds = await column(
      `select a.id::text as id from recruitment.application a
        where a.tenant_id = $1 and a.resume_version_id = $2
        order by a.applied_at, a.id`,
      [RUNTIME_TENANT, fx.sharedResumeVersionId],
    )
    assert.deepEqual(linkedApplicationIds.sort(), [fx.sharedApplicationId, fx.secondApplicationId].sort())
    assert.deepEqual(
      await applicationLinkForIntakeRecord(db.pool, RUNTIME_TENANT, fx.ambiguousIntakeRecordId),
      { applicationId: null, candidates: 2 },
    )

    // 材料链在，但没有申请引用这份 resume_version（申请没绑材料）→ 0，不是"猜一个"。
    assert.deepEqual(
      await applicationLinkForIntakeRecord(db.pool, RUNTIME_TENANT, fx.emptyChainIntakeRecordId),
      { applicationId: null, candidates: 0 },
    )
  })

  test('interviewVersionPins：当前 interview_record 的 rubric/job 逐字一致，非当前记录不参与', async () => {
    const templateFromDb = await scalar(
      `select interview_template_version_id::text as id from recruitment.interview
        where tenant_id = $1 and id = $2`,
      [RUNTIME_TENANT, fx.interviewId],
    )
    assert.deepEqual(await interviewVersionPins(db.pool, RUNTIME_TENANT, fx.interviewId), {
      interviewId: fx.interviewId,
      applicationId: fx.applicationId,
      interviewTemplateVersionId: templateFromDb,
      interviewRecordRubricVersionId: fx.currentRecordRubricId,
      interviewRecordJobId: fx.jobId,
    })
    // 两条记录都在：当前那条是 v2，被取代那条是 v1（证明取的是 is_current 而不是第一条）。
    assert.deepEqual(
      await column(
        `select rubric_version_id::text as id from recruitment.interview_record
          where tenant_id = $1 and interview_id = $2 and is_current`,
        [RUNTIME_TENANT, fx.interviewId],
      ),
      [fx.currentRecordRubricId],
    )
    assert.deepEqual(
      await column(
        `select rubric_version_id::text as id from recruitment.interview_record
          where tenant_id = $1 and interview_id = $2 and not is_current`,
        [RUNTIME_TENANT, fx.interviewId],
      ),
      [fx.supersededRecordRubricId],
    )
    assert.notEqual(fx.currentRecordRubricId, fx.supersededRecordRubricId)
  })

  test('interviewVersionPins：没有 interview_record 时两个 record 字段为 null（模板也如实 null）', async () => {
    assert.deepEqual(await interviewVersionPins(db.pool, RUNTIME_TENANT, fx.bareInterviewId), {
      interviewId: fx.bareInterviewId,
      applicationId: fx.applicationId,
      interviewTemplateVersionId: null,
      interviewRecordRubricVersionId: null,
      interviewRecordJobId: null,
    })
  })

  test('不存在的 id → null / 0（不抛错、不拿相近行顶替）', async () => {
    const missingId = randomUUID()
    assert.equal(await applicationVersionPins(db.pool, RUNTIME_TENANT, missingId), null)
    assert.equal(await jobVersionPointers(db.pool, RUNTIME_TENANT, missingId), null)
    assert.equal(await interviewVersionPins(db.pool, RUNTIME_TENANT, missingId), null)
    assert.deepEqual(
      await applicationLinkForIntakeRecord(db.pool, RUNTIME_TENANT, missingId),
      { applicationId: null, candidates: 0 },
    )
  })

  test('tenant 过滤：换一个租户 id 读不到同一批行', async () => {
    assert.equal(await applicationVersionPins(db.pool, OTHER_TENANT, fx.applicationId), null)
    assert.equal(await jobVersionPointers(db.pool, OTHER_TENANT, fx.jobId), null)
    assert.equal(await interviewVersionPins(db.pool, OTHER_TENANT, fx.interviewId), null)
    assert.deepEqual(
      await applicationLinkForIntakeRecord(db.pool, OTHER_TENANT, fx.intakeRecordId),
      { applicationId: null, candidates: 0 },
    )
  })

  test('RuntimeStore 四个委托与 readback 同值（B 的端口接的就是这里）', async () => {
    assert.deepEqual(
      await store.applicationVersionPins(fx.applicationId),
      await applicationVersionPins(db.pool, RUNTIME_TENANT, fx.applicationId),
    )
    assert.deepEqual(
      await store.jobVersionPointers(fx.jobId),
      await jobVersionPointers(db.pool, RUNTIME_TENANT, fx.jobId),
    )
    assert.deepEqual(
      await store.applicationLinkForIntakeRecord(fx.intakeRecordId),
      await applicationLinkForIntakeRecord(db.pool, RUNTIME_TENANT, fx.intakeRecordId),
    )
    assert.deepEqual(
      await store.interviewVersionPins(fx.interviewId),
      await interviewVersionPins(db.pool, RUNTIME_TENANT, fx.interviewId),
    )
  })
})
