// D-120 版本钉 · **真库**集成测试（一次性空库，0001→0016 重放）。
//
// 守的是产品负责人钉死的口径：Agent **不能因为"没给外部数据"就不做能力**；
// 版本钉必须从业务事实根源（application / job / interview 行）取，取不到 → UNKNOWN，禁止猜。
//
// 这一条用**真提交**的夹具（不是事务里 ROLLBACK）+ 真 `RuntimeStore` 只读查询：
//   真事件行（`resume.intake.received`，payload 只有 sha256）→ intake 链
//   （intake_record → intake_asset → resume → resume_version → application）
//   → `business_task`（RESUME_PARSE / business_refs=[INTAKE_RECORD] / description 指回事件）
//   → `createStoreTaskContextSource(store).load(WorkerTaskRequest)` → 渲染任务书。
//
// 断言两层：
//   ① 任务书 `3) VERSION PINS` 的 job / rubric / resume_version 三个钉**非 UNKNOWN**，
//      且逐字等于**独立 SQL 读回**的 application / job_version / rubric_version / resume_version id；
//   ② application 优先于 job.current_*：夹具故意把 job.current_* 指到另外两个版本行，
//      任务书必须仍渲染申请钉住值（降级值不得冒充申请钉）。
// 负例：只有 intake_record + event、**没有** application 链 → job/rubric 如实 UNKNOWN。
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { DatabaseClient } from '../../src/db/pool.ts'
import { EVENT_TYPES } from '../../src/runtime/event-types.ts'
import { RuntimeStore } from '../../src/runtime/store.ts'
import {
  buildWorkerPrompt,
  createStoreTaskContextSource,
  TASK_CONTEXT_SECTIONS,
} from '../../src/runtime/task-context.ts'
import type { WorkerTaskRequest } from '../../src/runtime/types.ts'
import { hex64, one, seedScenario } from '../integration/db.ts'
import {
  createRuntimeTestDatabase,
  RUNTIME_ACTOR,
  RUNTIME_TENANT,
  type RuntimeTestDatabase,
} from './db.ts'

/** 合法的 rubric dimensions（seedScenario 会自己算 payload_hash）。 */
const RUBRIC_DIMENSIONS = [{ key: 'skill', label: '技能' }]
/** 任务书投影里的占位工作目录（不是本机真实路径）。 */
const WORKSPACE_DIR = 'D:/work/runtime/vpin-src'

let db: RuntimeTestDatabase
let store: RuntimeStore

/** 正例夹具（真提交后读回的 id；断言用它比对）。 */
interface PinnedFixture {
  readonly applicationId: string
  readonly candidateId: string
  readonly jobId: string
  readonly jobVersionId: string
  readonly rubricId: string
  readonly resumeVersionId: string
  readonly resumeSha256: string
  readonly intakeRecordId: string
  readonly eventId: string
  readonly taskId: string
  /** 故意与申请钉不同的 job.current_*（证明"申请钉优先"）。 */
  readonly currentJobVersionId: string
  readonly currentRubricVersionId: string
}

let pinned: PinnedFixture

before(async () => {
  db = await createRuntimeTestDatabase('vpin_src')
  store = new RuntimeStore({ pool: db.pool, tenantId: RUNTIME_TENANT, actorId: RUNTIME_ACTOR })
  pinned = await createPinnedFixture()
})

after(async () => {
  if (db !== undefined) await db.drop()
})

/**
 * 在**真提交**的事务里造夹具（`SET LOCAL` 用 set_config(..., true) 的等价写法）。
 * @param fn - 事务体。
 * @returns 事务体返回值（commit 之后）。
 */
async function commitOnce<T>(fn: (client: DatabaseClient) => Promise<T>): Promise<T> {
  const client = await db.pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [RUNTIME_ACTOR])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** 一条与 `application-intake.ts` 的 `upsertIntakeEvent` 同形的真实事件行。 */
async function insertIntakeEvent(
  client: DatabaseClient,
  sha256: string,
  seed: string,
): Promise<string> {
  return one(client, `insert into recruitment.event_inbox
      (tenant_id, provider, provider_event_id, event_type, schema_version,
       occurred_at, received_at, recorded_at, idempotency_key, idempotency_source,
       source_object_id, payload, trust_level, normalized_event_type, normalizer_version)
    values ($1, 'internal', null, $2, 1,
            now(), now(), now(), $3, 'FALLBACK_KEY',
            $4, $5::jsonb, 'INTERNAL', $2, 'intake/1.0.0')
    returning event_id::text`, [
    RUNTIME_TENANT,
    EVENT_TYPES.RESUME_INTAKE_RECEIVED,
    `resume.intake:${seed}`,
    sha256,
    JSON.stringify({ sha256, file_name: `resume-${seed}.pdf`, pages: 2, source_kind: 'LOCAL_FILE' }),
  ])
}

/** 一条 RESUME_PARSE 的 business_task（列与 `store/events.ts` 的创建行同形）。 */
async function insertResumeParseTask(
  client: DatabaseClient,
  input: {
    readonly intakeRecordId: string
    readonly eventId: string
    readonly description: string
    readonly seed: string
  },
): Promise<string> {
  return one(client, `insert into recruitment.business_task
      (tenant_id, task_type, business_refs, title, description, priority,
       trigger_event_id, created_by_actor_id, idempotency_key, status, next_run_at)
    values ($1, 'RESUME_PARSE', $2::jsonb, '解析简历', $3, 3,
            $4, $5, $6, 'PENDING', now())
    returning id::text`, [
    RUNTIME_TENANT,
    JSON.stringify([{ type: 'INTAKE_RECORD', id: input.intakeRecordId }]),
    input.description,
    input.eventId,
    RUNTIME_ACTOR,
    `task:RESUME_PARSE:INTAKE_RECORD:${input.seed}`,
  ])
}

/** 把 worker 投影拼出来（与 `task-runtime.ts` 的 WorkerTaskRequest 字段一致）。 */
function makeRequest(input: {
  readonly taskId: string
  readonly title: string
  readonly description: string
  readonly intakeRecordId: string
}): WorkerTaskRequest {
  return {
    taskId: input.taskId,
    attemptId: randomUUID(),
    attemptNo: 1,
    taskType: 'RESUME_PARSE',
    title: input.title,
    description: input.description,
    businessRefs: [{ type: 'INTAKE_RECORD', id: input.intakeRecordId }],
    prompt: '',
    resumeSessionId: null,
    workspaceDir: WORKSPACE_DIR,
  }
}

/** 取任务书里的某一段（start 标题 → end 标题之前）。 */
function section(prompt: string, start: string, end: string): string {
  const from = prompt.indexOf(start)
  assert.ok(from >= 0, `prompt is missing section: ${start}`)
  const to = prompt.indexOf(end, from + start.length)
  assert.ok(to > from, `prompt is missing section: ${end}`)
  return prompt.slice(from, to)
}

/**
 * 正例夹具：application 四钉齐全，且故意让 job.current_* 指向另外两个版本行。
 * @returns 真提交后可用的 id 集合。
 */
async function createPinnedFixture(): Promise<PinnedFixture> {
  const seed = randomUUID().slice(0, 8)
  return commitOnce(async (client) => {
    const scenario = await seedScenario(client, { dimensions: RUBRIC_DIMENSIONS })
    // seedScenario 造的 intake 链（用 resume_version 反查，不猜 id）。
    const chain = await client.query<{ intake_record_id: string; resume_sha256: string }>(
      `select ir.id::text as intake_record_id, rv.source_asset_sha256 as resume_sha256
         from recruitment.resume_version rv
         join recruitment.resume r
           on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
         join recruitment.intake_asset ia
           on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
         join recruitment.intake_record ir
           on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
        where rv.tenant_id = $1 and rv.id = $2`,
      [RUNTIME_TENANT, scenario.resumeVersionId],
    )
    const chainRow = chain.rows[0]
    assert.ok(chainRow !== undefined, 'seedScenario did not create the intake chain')
    const intakeRecordId = chainRow.intake_record_id
    const resumeSha256 = chainRow.resume_sha256

    // 真事件行：payload 只有 sha256（与生产 intake 事件同形）。
    const eventId = await insertIntakeEvent(client, resumeSha256, seed)
    // 事件行不可改（trg_event_inbox_immutable）；把 seed 的 intake_record 指到这条真实事件上。
    await client.query(
      `update recruitment.intake_record set event_id = $2
        where tenant_id = $1 and id = $3`,
      [RUNTIME_TENANT, eventId, intakeRecordId],
    )

    // 故意把 job.current_* 换成**另外**两个版本行：若实现偷看 current_* 就会露馅。
    const currentJobVersionId = await one(client, `insert into recruitment.job_version
        (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
      values ($1, $2, 2, '测试 JD v2（current 指针）', $3, $4) returning id::text`, [
      RUNTIME_TENANT, scenario.jobId, hex64(`vpin-jv2-${seed}`), RUNTIME_ACTOR,
    ])
    const currentRubricVersionId = await one(client, `insert into recruitment.rubric_version
        (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
      values ($1, $2, 2, $3::jsonb, $4, $5) returning id::text`, [
      RUNTIME_TENANT,
      scenario.jobId,
      JSON.stringify(RUBRIC_DIMENSIONS),
      hex64(`vpin-rub2-${seed}`),
      RUNTIME_ACTOR,
    ])
    await client.query(
      `update recruitment.job
          set current_job_version_id = $2, current_rubric_version_id = $3
        where tenant_id = $1 and id = $4`,
      [RUNTIME_TENANT, currentJobVersionId, currentRubricVersionId, scenario.jobId],
    )

    const description = `deterministic event ${EVENT_TYPES.RESUME_INTAKE_RECEIVED} (event ${eventId})`
    const taskId = await insertResumeParseTask(client, {
      intakeRecordId,
      eventId,
      description,
      seed: `${seed}-pinned`,
    })

    return {
      applicationId: scenario.applicationId,
      candidateId: scenario.candidateId,
      jobId: scenario.jobId,
      jobVersionId: scenario.jobVersionId,
      rubricId: scenario.rubricId,
      resumeVersionId: scenario.resumeVersionId,
      resumeSha256,
      intakeRecordId,
      eventId,
      taskId,
      currentJobVersionId,
      currentRubricVersionId,
    }
  })
}

/** 独立 SQL 读回 application 的四钉（不经过产品读层）。 */
async function readApplicationPins(applicationId: string): Promise<{
  jobId: string
  jobVersionId: string
  rubricVersionId: string
  resumeVersionId: string
  resumeSha256: string
}> {
  const { rows } = await db.pool.query<Record<string, string>>(
    `select a.job_id::text as job_id, a.job_version_id::text as job_version_id,
            a.rubric_version_id::text as rubric_version_id,
            a.resume_version_id::text as resume_version_id,
            rv.source_asset_sha256 as resume_sha256
       from recruitment.application a
       join recruitment.resume_version rv
         on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.id = $2`,
    [RUNTIME_TENANT, applicationId],
  )
  const row = rows[0]
  assert.ok(row !== undefined, 'independent readback found no application row')
  return {
    jobId: row.job_id,
    jobVersionId: row.job_version_id,
    rubricVersionId: row.rubric_version_id,
    resumeVersionId: row.resume_version_id,
    resumeSha256: row.resume_sha256,
  }
}

describe('createStoreTaskContextSource + real RuntimeStore (fresh DB)', () => {
  test('INTAKE chain → application pins: job/rubric/resume_version all pinned and equal to DB rows', async () => {
    const request = makeRequest({
      taskId: pinned.taskId,
      title: '解析简历',
      description: `deterministic event ${EVENT_TYPES.RESUME_INTAKE_RECEIVED} (event ${pinned.eventId})`,
      intakeRecordId: pinned.intakeRecordId,
    })
    const facts = await createStoreTaskContextSource(store).load(request)
    assert.ok(facts !== null, 'store-backed source must return facts')

    // ---- 独立 SQL 读回（psql 等价；不 import 产品读层） ----
    const dbPins = await readApplicationPins(pinned.applicationId)
    assert.equal(dbPins.jobId, pinned.jobId)
    assert.equal(dbPins.jobVersionId, pinned.jobVersionId)
    assert.equal(dbPins.rubricVersionId, pinned.rubricId)
    assert.equal(dbPins.resumeVersionId, pinned.resumeVersionId)
    assert.equal(dbPins.resumeSha256, pinned.resumeSha256)

    // ---- 事实包：申请钉住值，逐字等于库里的行 ----
    assert.deepEqual(facts.version_pins.job, { id: dbPins.jobId, version: dbPins.jobVersionId })
    assert.deepEqual(facts.version_pins.rubric, {
      id: dbPins.rubricVersionId,
      version: dbPins.rubricVersionId,
    })
    assert.deepEqual(facts.version_pins.resume, {
      sha256: dbPins.resumeSha256,
      version_id: dbPins.resumeVersionId,
    })
    assert.deepEqual(facts.version_pins.application, { id: pinned.applicationId })
    const source = facts.evidence_locators.find(
      (locator) => locator.kind === 'version_pin_source' && locator.ref === pinned.applicationId,
    )
    assert.ok(source !== undefined, 'missing D-120 application pin source locator')

    // ---- 渲染：3) VERSION PINS 三钉非 UNKNOWN 且逐字等于库里 id ----
    const prompt = buildWorkerPrompt(request, facts)
    const pinsSection = section(prompt, TASK_CONTEXT_SECTIONS.versionPins, TASK_CONTEXT_SECTIONS.evidenceLocators)
    const expectedLines = [
      `- job: ${dbPins.jobId} @ version ${dbPins.jobVersionId}`,
      `- rubric: ${dbPins.rubricVersionId} @ version ${dbPins.rubricVersionId}`,
      `- resume: sha256=${dbPins.resumeSha256}, resume_version_id=${dbPins.resumeVersionId}`,
    ]
    for (const line of expectedLines) {
      assert.ok(pinsSection.includes(line), `VERSION PINS is missing: ${line}\n---\n${pinsSection}`)
    }
    // 渲染出的三钉行本身不得出现 UNKNOWN（逐行读回，不是只看子串存在）
    const pinLines = pinsSection
      .split('\n')
      .filter((line) => /^- (job|rubric|resume):/.test(line))
    assert.equal(pinLines.length, 3, `expected exactly 3 pin lines, got: ${JSON.stringify(pinLines)}`)
    for (const line of pinLines) {
      assert.equal(line.includes('UNKNOWN'), false, `pin line degraded to UNKNOWN: ${line}`)
    }
    for (const id of [pinned.jobId, pinned.jobVersionId, pinned.rubricId, pinned.resumeVersionId, pinned.applicationId]) {
      assert.ok(pinsSection.includes(id), `VERSION PINS does not render ${id}\n---\n${pinsSection}`)
    }
    assert.match(pinsSection, new RegExp(`- application: ${pinned.applicationId}`))
    // 申请钉优先：job.current_* 的降级值不得出现在任务书里（哪怕它确实是"现在"）
    assert.equal(
      prompt.includes(pinned.currentJobVersionId),
      false,
      'task prompt leaked job.current_job_version_id instead of the application pin',
    )
    assert.equal(
      prompt.includes(pinned.currentRubricVersionId),
      false,
      'task prompt leaked job.current_rubric_version_id instead of the application pin',
    )
    // 这三个"缺钉 UNKNOWN"文案不得出现（abort 判据：旧契约不回退）
    for (const unknown of ['job pin: UNKNOWN', 'rubric pin: UNKNOWN', 'resume pin: UNKNOWN']) {
      assert.equal(prompt.includes(unknown), false, `unexpected pin unknown: ${unknown}`)
    }

    // ---- 证据：真实渲染的 VERSION PINS 段（owner 复核用） ----
    console.log('\n===== RENDERED VERSION PINS (DB fixture, real RuntimeStore) =====')
    console.log(pinsSection.trim())
    console.log('===== END RENDERED VERSION PINS =====\n')
  })

  test('an INTAKE_RECORD without an application chain keeps job/rubric UNKNOWN (no guessing)', async () => {
    const seed = randomUUID().slice(0, 8)
    const negative = await commitOnce(async (client) => {
      const sha2 = hex64(`vpin-negative-${seed}`)
      const eventId = await insertIntakeEvent(client, sha2, `${seed}-neg`)
      // 只有 intake_record + event，没有 intake_asset / resume / resume_version / application。
      const intakeRecordId = await one(client, `insert into recruitment.intake_record
          (tenant_id, event_id, subject, status)
        values ($1, $2, '无申请链材料（D-120 负例）', 'RESOLVED') returning id::text`, [
        RUNTIME_TENANT, eventId,
      ])
      const description = `deterministic event ${EVENT_TYPES.RESUME_INTAKE_RECEIVED} (event ${eventId})`
      const taskId = await insertResumeParseTask(client, {
        intakeRecordId,
        eventId,
        description,
        seed: `${seed}-negative`,
      })
      return { intakeRecordId, eventId, taskId, description, sha2 }
    })

    const request = makeRequest({
      taskId: negative.taskId,
      title: '解析简历',
      description: negative.description,
      intakeRecordId: negative.intakeRecordId,
    })
    const facts = await createStoreTaskContextSource(store).load(request)
    assert.ok(facts !== null)

    // 禁止猜：没有 application 钉就不许有 job/rubric 钉（连 job.current 降级也没有 job 可查）。
    assert.equal(facts.version_pins.job, undefined)
    assert.equal(facts.version_pins.rubric, undefined)
    assert.equal(facts.version_pins.application, undefined)
    // resume 只沿用事件 payload 的原件哈希（不带 resume_version_id）。
    assert.deepEqual(facts.version_pins.resume, { sha256: negative.sha2 })
    assert.match(
      facts.unknowns.join('\n'),
      new RegExp(`no application is linked to intake_record ${negative.intakeRecordId} \\(resume chain empty\\)`),
    )

    const prompt = buildWorkerPrompt(request, facts)
    const pinsSection = section(prompt, TASK_CONTEXT_SECTIONS.versionPins, TASK_CONTEXT_SECTIONS.evidenceLocators)
    assert.ok(pinsSection.includes('- job: UNKNOWN'), `negative case invented a job pin:\n${pinsSection}`)
    assert.ok(pinsSection.includes('- rubric: UNKNOWN'), `negative case invented a rubric pin:\n${pinsSection}`)
    assert.ok(pinsSection.includes(`- resume: sha256=${negative.sha2}`))
    assert.equal(pinsSection.includes('resume_version_id='), false, 'no resume_version_id may be invented')
    // 不得泄漏正例夹具的钉（另一个任务的业务事实）
    for (const id of [pinned.applicationId, pinned.jobId, pinned.jobVersionId, pinned.rubricId, pinned.resumeVersionId]) {
      assert.equal(prompt.includes(id), false, `negative task leaked another task's pin ${id}`)
    }
    assert.match(prompt, /no application is linked to intake_record/)
  })
})
