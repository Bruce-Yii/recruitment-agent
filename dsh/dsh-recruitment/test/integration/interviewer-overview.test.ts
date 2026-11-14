// Interviewer Workspace（W3-A）read model 的**真库**集成测试。
//
// 纪律（`test/integration/db.ts` 的三条 + 本 lane 任务书）：
//   1. 每个用例都在自己的事务里跑并一律 ROLLBACK —— 不污染 `ra_s6s7`；
//   2. 连不上库就**失败**（不静默 skip；R3 要求 skipped === 0 才算绿）；
//   3. 断言只针对**本文件造出来的夹具 id**；共享库里还有 W1/W3 Owner 的演示行
//      （实测 104 已有 6 条 interviewer、105 已有 2 条），所以
//      · "哪些行"用**独立 SQL 读回**对齐（不是硬编码条数），
//      · "计数"用返回行**重新按契约公式推导**再比对（counts 与行一致）；
//   4. 时间相关判定不 mock 时钟：用**已过去**的 `scheduled_*` 控制
//      （MISSING/NO_MEETING_BOUND、READY），用**未来**的 `scheduled_end_at` 控制
//      PENDING/WAITING（"还没到等待窗"）。
//
// 夹具（五场面试，覆盖 §3-A 的七组断言）：
//   · IV_T        104 独占：带 interview_template_version + PRIMARY 会议 + canonical READY 产物
//                 + 104 的 SUBMITTED 面评 → brief=TEMPLATE / transcript=READY / scorecard=SUBMITTED
//   · IV_R        104 独占：无模板但有 rubric；简历 parse_status=FAILED；**不绑会议** + 已过点
//                 → brief=JOB_RUBRIC / materials=PARSE_FAILED / transcript=MISSING/NO_MEETING_BOUND
//   · IV_SHARED   104 + 105 共同：104 SUBMITTED、105 PENDING（两份不同 id 的面评）
//                 → 证明"两人状态不同且互不可见"
//   · IV_105      105 独占：无 rubric、无材料、绑了会议但**没有产物**且结束时间在未来
//                 → brief=NONE / materials=NO_MATERIAL_BOUND / transcript=PENDING/WAITING
//   · IV_MISMATCH … **没有这一场**：契约 §1.5 的"rubric 不属于该申请岗位"在本库造不出来 ——
//     复合外键 `fk_application_rubric_job` 会让"钉住别的岗位的 rubric"直接 23503。
//     该降级分支由单测 `toInterviewRow`（假扩展行）覆盖；真库只证明正常路径不产生 issue。
//   · IV_CANCELLED 104 独占：终态面试（CANCELLED）→ 仍在分配列表里，但不计入 open 计数
//   另外：临时新建一个没有任何 interviewer 行的 actor（未分配基线）、
//   以及给 102（HIRING_MANAGER 角色、不是 INTERVIEWER 标签）插一条 interviewer 行，
//   证明"我的面试"只按 `interviewer.actor_id` 过滤、与角色标签无关。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import {
  readInterviewerWorkspace,
  type InterviewerOverview,
  type InterviewerRow,
} from '../../src/http/interviewer.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  errorBody,
  hex64,
  inRolledBackTx,
  one,
  seedScenario,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const CFG = testDatabaseConfig()
const POOL = createTestPool(CFG)

after(async () => {
  await POOL.end()
})

/** `0002_seed.sql` 的演示身份：102 = 招聘负责人（HIRING_MANAGER），103 = HR，104/105 = 面试官。 */
const ACTOR_102 = '11111111-1111-4111-8111-000000000102'
const ACTOR_104 = '11111111-1111-4111-8111-000000000104'
const ACTOR_105 = '11111111-1111-4111-8111-000000000105'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'

/** 与演示 rubric v1 同形的三个维度（`0002_seed.sql` §5）。 */
const DIMENSIONS = [
  { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
  { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
  { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
] as const

/**
 * 确保演示身份 105（面试官 B）存在。
 *
 * 为什么必须由测试自己造：`0002_seed.sql` 只种了 101–104 四个 actor；105 是 `bootstrap-demo.mjs`
 * 在**本地演示库**补的。CI 的 plugin job 用全新库（0001→0016 + seed），没有 105 ——
 * 之前把"本地库已有 105"当作前提，fresh DB 上整组测试会因 `fk_interviewer_actor` 失败。
 * 这里在**本用例的回滚事务里**幂等补齐（已存在则跳过；ROLLBACK 后不留痕），测试因此自包含。
 * @param client - 回滚事务内的连接。
 */
async function ensureActor105(client: DatabaseClient): Promise<void> {
  await client.query(
    `insert into recruitment.actor (id, tenant_id, kind, display_name)
     values ($1, $2, 'HUMAN', '集成测试-面试官B')
     on conflict (id) do nothing`,
    [ACTOR_105, TENANT],
  )
}

/** 简历里"已解析字段"的夹具（断言 materials.fields 原样回传）。 */
const PARSED_FIELDS = {
  fields: {
    name: { state: 'present', value: '夹具候选人' },
    work_experience: { state: 'present', entry_count: 2 },
  },
  timeline: { intervals: 2, covered_months_closed: 60 },
} as const

/** 夹具 id 集合（断言只看这些 id）。 */
interface Fixture {
  readonly ivTemplate: string
  readonly ivRubricOnly: string
  readonly ivShared: string
  readonly ivNoRubric: string
  /** 终态面试（CANCELLED）：证明 `open_interview_total` 只排除终态，与 pending 桶无关。 */
  readonly ivCancelled: string
  readonly templateId: string
  readonly templateObjective: string
  readonly templateBriefing: string
  readonly scorecard104Template: string
  readonly scorecard104Shared: string
  readonly scorecard105Shared: string
  readonly jobRubricOnlyId: string
  readonly unassignedActorId: string
}

// ---------------------------------------------------------------------------
//  夹具构造（故意直接写库：工具端点不提供造夹具的入口）
// ---------------------------------------------------------------------------

async function addInterview(
  client: DatabaseClient,
  applicationId: string,
  options: {
    roundNo?: number
    slotCode?: string
    status?: string
    /** 相对 `now()` 的 interval 文本；**负数 = 已过去**（不 mock 时钟）。 */
    startOffset?: string
    templateVersionId?: string | null
  } = {},
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interview
       (tenant_id, application_id, interview_template_version_id, round_no, slot_code, status,
        scheduled_start_at, scheduled_end_at, timezone)
     values ($1, $2, $3, $4, $5, $6,
             now() + ($7::text)::interval, now() + ($7::text)::interval + interval '1 hour', 'Asia/Shanghai')
     returning id`,
    [
      TENANT,
      applicationId,
      options.templateVersionId ?? null,
      options.roundNo ?? 1,
      options.slotCode ?? 'DEFAULT',
      options.status ?? 'POST_INTERVIEW',
      options.startOffset ?? '-3 days',
    ],
  )
}

async function addInterviewer(
  client: DatabaseClient,
  interviewId: string,
  actorId: string,
  requiredScorecard = true,
): Promise<string> {
  return one(
    client,
    `insert into recruitment.interviewer (tenant_id, interview_id, actor_id, required_scorecard)
     values ($1, $2, $3, $4) returning id`,
    [TENANT, interviewId, actorId, requiredScorecard],
  )
}

/**
 * 造一条当前面评（`superseded_by_scorecard_id is null`）。
 *
 * SUBMITTED 必须带 `submitted_at` + `items`（`ck_scorecard_submitted`）；PENDING 两者都可以空。
 * 终态 INSERT 需要事务内有 actor（`trg_scorecard_terminal_actor_guard`）——
 * `inRolledBackTx` 已 `set_config('recruitment.actor_id', HR_ACTOR)`。
 */
async function addScorecard(
  client: DatabaseClient,
  input: {
    interviewId: string
    interviewerId: string
    rubricVersionId: string
    status: 'PENDING' | 'SUBMITTED'
    items: Record<string, unknown>
    overall?: string
  },
): Promise<string> {
  return one(
    client,
    `insert into recruitment.scorecard
       (tenant_id, interview_id, interviewer_id, rubric_version_id, revision_no, status,
        submitted_at, items, overall, payload_hash)
     values ($1, $2, $3, $4, 1, $5,
             case when $5 = 'SUBMITTED' then now() - interval '2 days' else null end,
             $6::jsonb, $7, $8)
     returning id`,
    [
      TENANT,
      input.interviewId,
      input.interviewerId,
      input.rubricVersionId,
      input.status,
      JSON.stringify(input.items),
      input.status === 'SUBMITTED' ? (input.overall ?? 'ADVANCE') : null,
      hex64(`sc${uniqueSuffix()}`),
    ],
  )
}

/** 造一个 interview_template_version（objective/briefing.summary/focus/question_templates 全有值）。 */
async function addTemplateVersion(client: DatabaseClient, jobId: string): Promise<string> {
  const suffix = uniqueSuffix()
  const objective = `验证第 ${suffix} 场面试的目标`
  const briefing = '本场聚焦分片设计与消息重放（夹具简短）'
  return one(
    client,
    `insert into recruitment.interview_template_version
       (tenant_id, job_id, template_code, round_no, version_no, objective, briefing,
        focus_attributes, question_templates, feedback_form, payload_hash, created_by_actor_id)
     values ($1, $2, $3, 1, 1, $4, $5::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, $8, $9)
     returning id`,
    [
      TENANT,
      jobId,
      `IT_${suffix.toUpperCase().replace(/[^A-Z0-9_]/g, '')}`,
      objective,
      JSON.stringify({ summary: briefing }),
      JSON.stringify([{ key: 'backend_depth', label: '后端工程深度', weight: 0.5 }]),
      JSON.stringify(['讲讲你设计过的分片方案', { question: '遇到过消息重放吗？' }]),
      hex64(`itv${suffix}`),
      HR_ACTOR,
    ],
  )
}

/** 绑一场 PRIMARY 会议（不建产物）：用于 PENDING/WAITING 与 BOUND_ACTIVE。 */
async function bindMeeting(client: DatabaseClient, interviewId: string, actualStartOffset: string): Promise<string> {
  const meetingId = await one(
    client,
    `insert into recruitment.meeting
       (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
     values ($1, 'fixture', $2, 'PRIMARY', now() + ($3::text)::interval,
             now() + ($3::text)::interval + interval '1 hour')
     returning id`,
    [TENANT, `ext-${uniqueSuffix()}`, actualStartOffset],
  )
  await client.query(
    `insert into recruitment.meeting_binding
       (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
     values ($1, $2, $3, 'SCHEDULED', $4)`,
    [TENANT, meetingId, interviewId, HR_ACTOR],
  )
  return meetingId
}

/**
 * 绑一场 PRIMARY 会议 + 一条 canonical READY 产物（`is_complete=true`、正文非空）。
 *
 * 正文非空是必须的：`readInterviewValue()` 用 `length(raw_text)` 判 `ARTIFACT_EMPTY`
 * （D-96/TR-F4：状态 READY 不等于有内容）—— 空正文会派生成 PARTIAL，不是 READY。
 */
async function bindMeetingWithReadyArtifact(client: DatabaseClient, interviewId: string): Promise<string> {
  const meetingId = await bindMeeting(client, interviewId, '-3 days')
  await one(
    client,
    `insert into recruitment.transcript_artifact
       (tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type,
        transcript_status, provenance, trigger_mode, connection_state, fetched_at,
        content_sha256, is_complete, raw_text, is_canonical, status_changed_at)
     values ($1, $2, 'fixture', $3, 1, 'ORIGINAL', 'READY', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', now(),
             $4, true, $5, true, now())
     returning id`,
    [
      TENANT,
      meetingId,
      `artifact-${uniqueSuffix()}`,
      hex64(`artifact${uniqueSuffix()}`),
      '集成测试夹具正文（不是真实会议内容；只用于证明 READY 派生链路）',
    ],
  )
  return meetingId
}

/**
 * 一次性造齐夹具（在调用方事务里；结束时随事务回滚）。
 * @param client - 回滚事务内的连接。
 * @returns 夹具 id / 模板原文 / 临时 actor。
 */
async function seedFixture(client: DatabaseClient): Promise<Fixture> {
  // fresh 库（CI 只有 0001→0016 + seed）没有 105：先幂等补齐（事务内，随 ROLLBACK 消失）。
  await ensureActor105(client)

  // ---- APP1：有 rubric + 已解析简历（IV_T / IV_SHARED 都用它）----
  const app1 = await seedScenario(client, { dimensions: [...DIMENSIONS], fields: PARSED_FIELDS })
  const templateId = await addTemplateVersion(client, app1.jobId)
  const templateObjective = (
    await client.query<{ objective: string; briefing: Record<string, unknown> }>(
      'select objective, briefing from recruitment.interview_template_version where id = $1',
      [templateId],
    )
  ).rows[0]!

  const ivTemplate = await addInterview(client, app1.applicationId, {
    roundNo: 1,
    slotCode: 'DEFAULT',
    templateVersionId: templateId,
    startOffset: '-3 days',
  })
  const interviewer104Template = await addInterviewer(client, ivTemplate, ACTOR_104)
  const scorecard104Template = await addScorecard(client, {
    interviewId: ivTemplate,
    interviewerId: interviewer104Template,
    rubricVersionId: app1.rubricId,
    status: 'SUBMITTED',
    items: { transcript_basis: 'TRANSCRIPT', backend_depth: { assessment: 'MET', score: 4 } },
    overall: 'ADVANCE',
  })
  await bindMeetingWithReadyArtifact(client, ivTemplate)

  // ---- APP2：简历解析失败（IV_R：JOB_RUBRIC + PARSE_FAILED）----
  const app2 = await seedScenario(client, {
    dimensions: [...DIMENSIONS],
    fields: { fields: { name: { state: 'absent' } } },
    parseStatus: 'FAILED',
    parseError: '集成测试：PDF 无可提取文本',
  })
  const ivRubricOnly = await addInterview(client, app2.applicationId, { roundNo: 1, startOffset: '-2 days' })
  await addInterviewer(client, ivRubricOnly, ACTOR_104)
  // 102 的角色标签是 HIRING_MANAGER（不是 INTERVIEWER）：也要能看到这一场 —— 证明过滤只看
  // `interviewer.actor_id`，与 actor_role 标签无关（D-33 / R-WB-4 同构）。
  await addInterviewer(client, ivRubricOnly, ACTOR_102)

  // ---- APP1 的第二场：104 + 105 共同；两份不同 id 的当前面评 ----
  const ivShared = await addInterview(client, app1.applicationId, { roundNo: 2, slotCode: 'DEFAULT', startOffset: '-1 day' })
  const interviewer104Shared = await addInterviewer(client, ivShared, ACTOR_104)
  const interviewer105Shared = await addInterviewer(client, ivShared, ACTOR_105)
  const scorecard104Shared = await addScorecard(client, {
    interviewId: ivShared,
    interviewerId: interviewer104Shared,
    rubricVersionId: app1.rubricId,
    status: 'SUBMITTED',
    items: { transcript_basis: 'NO_TRANSCRIPT', backend_depth: { assessment: 'MET', score: 3 } },
    overall: 'HOLD',
  })
  const scorecard105Shared = await addScorecard(client, {
    interviewId: ivShared,
    interviewerId: interviewer105Shared,
    rubricVersionId: app1.rubricId,
    status: 'PENDING',
    items: { transcript_basis: 'UNKNOWN', async_pipeline: { assessment: 'NOT_OBSERVED' } },
  })

  // ---- APP3：无 rubric、无材料（IV_105：brief=NONE / NO_MATERIAL_BOUND / PENDING 转写）----
  const app3 = await seedScenario(client, {
    dimensions: [...DIMENSIONS],
    pinRubric: false,
    bindMaterial: false,
  })
  const ivNoRubric = await addInterview(client, app3.applicationId, { roundNo: 1, startOffset: '2 days' })
  await addInterviewer(client, ivNoRubric, ACTOR_105)
  // 绑了会议但没有产物 + 结束时间在未来 ⇒ TR-D 序 7 PENDING/WAITING（不依赖当前时刻：窗口两天后）。
  await bindMeeting(client, ivNoRubric, '2 days')

  // ---- APP4：一场**终态**面试（CANCELLED）：counts 的 open_interview_total 只排除终态 ----
  //
  // 注意：契约 §1.5 的"rubric 不属于该申请岗位 → null + issues"这一支**造不出来**：
  // 库上有复合外键 `fk_application_rubric_job`（application(tenant_id, rubric_version_id, job_id)
  // → rubric_version(tenant_id, id, job_id)），钉一个别的岗位的 rubric 会被 23503 直接拒。
  // 所以该分支只在单测里用假扩展行覆盖（`toInterviewRow`：pinned 有、rubric 行 join 不上）。
  const app4 = await seedScenario(client, { dimensions: [...DIMENSIONS], fields: PARSED_FIELDS })
  const ivCancelled = await addInterview(client, app4.applicationId, {
    roundNo: 1,
    startOffset: '-5 days',
    status: 'CANCELLED',
  })
  await addInterviewer(client, ivCancelled, ACTOR_104)

  // ---- 未分配基线：一个全新的 HUMAN actor，没有任何 interviewer 行 ----
  const unassignedActorId = await one(
    client,
    `insert into recruitment.actor (tenant_id, kind, display_name)
     values ($1, 'HUMAN', $2) returning id`,
    [TENANT, `集成测试-未分配-${uniqueSuffix()}`],
  )

  return {
    ivTemplate,
    ivRubricOnly,
    ivShared,
    ivNoRubric,
    ivCancelled,
    templateId,
    templateObjective: templateObjective.objective,
    templateBriefing: String((templateObjective.briefing as Record<string, unknown>).summary),
    scorecard104Template,
    scorecard104Shared,
    scorecard105Shared,
    jobRubricOnlyId: app2.jobId,
    unassignedActorId,
  }
}

// ---------------------------------------------------------------------------
//  独立读回 / 断言辅助（不复用生产代码里的谓词）
// ---------------------------------------------------------------------------

/** 独立 SQL 读回"我的面试"应有顺序（与 §1.3 的 order/limit 同规则，用来交叉验证列表）。 */
async function expectedInterviewIds(client: DatabaseClient, actorId: string): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `select iv.id::text as id
       from recruitment.interview iv
       join recruitment.interviewer ivr
         on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
      where iv.tenant_id = $1::uuid and ivr.actor_id = $2::uuid
      order by iv.scheduled_start_at desc nulls last, iv.round_no asc, iv.id asc
      limit 20`,
    [TENANT, actorId],
  )
  return rows.map((row) => row.id)
}

/** 契约 §1.4 的六个计数（测试侧**独立**重算，用来证明"counts 与行一致"）。 */
function expectedCounts(rows: readonly InterviewerRow[]): InterviewerOverview['counts'] {
  const closed = new Set(['DECIDED', 'CANCELLED', 'NO_SHOW'])
  return {
    assigned_total: rows.length,
    open_interview_total: rows.filter((row) => !closed.has(row.status)).length,
    pending_scorecard_total: rows.filter(
      (row) => row.required_scorecard && (row.scorecard.state === 'NONE' || row.scorecard.state === 'PENDING'),
    ).length,
    submitted_scorecard_total: rows.filter((row) => row.scorecard.state === 'SUBMITTED').length,
    transcript_ready_total: rows.filter((row) => row.transcript.state === 'READY').length,
    transcript_missing_total: rows.filter((row) => row.transcript.state === 'MISSING').length,
  }
}

/** 断言一份投影的自洽性：contract_version / counts 与行一致 / evaluated_at 可解析 / session。 */
function assertProjectionShape(overview: InterviewerOverview, actorId: string, sessionId: string): void {
  assert.equal(overview.contract_version, 'interviewer-workspace 1.0.0')
  assert.equal(overview.configured, true)
  assert.equal(overview.actor.actor_id, actorId)
  assert.equal(overview.session.session_id, sessionId)
  assert.ok(Number.isFinite(Date.parse(overview.evaluated_at)), `evaluated_at 必须是可解析的 ISO 时间：${overview.evaluated_at}`)
  // counts 是服务端算的，但必须与返回的行逐项一致（客户端不重算的前提）。
  assert.deepEqual(overview.counts, expectedCounts(overview.interviews))
  assert.equal(overview.counts.assigned_total, overview.interviews.length)
  // 演示租户（stage_catalog.demo=true）只能是 FIXTURE —— 下面的用例会独立读回这条事实。
  assert.deepEqual(overview.labels, {
    provenance: 'FIXTURE',
    trigger: 'MANUAL',
    connection: 'CONNECTED',
  })
}

function rowById(overview: InterviewerOverview, interviewId: string): InterviewerRow | undefined {
  return overview.interviews.find((row) => row.interview_id === interviewId)
}

// =====================================================================
//  A/B 分配差异 + 角色标签无关 + 列表与独立 SQL 读回一致
// =====================================================================

test('104 / 105 各自只看到自己的分配；私有面试交集为空；102 因 interviewer 行而看到（与角色标签无关）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)

    // 同一个 client 上的查询是串行排队的：这里逐个 await，避免把"排队"当并发。
    const overview104 = await readInterviewerWorkspace(client, CFG, { alias: 'interviewer_a', actor_id: ACTOR_104, display_name: '忽略', session_id: 'session-it-a' })
    const overview105 = await readInterviewerWorkspace(client, CFG, { alias: 'interviewer_b', actor_id: ACTOR_105, display_name: '忽略', session_id: 'session-it-b' })
    const overview102 = await readInterviewerWorkspace(client, CFG, { alias: 'recruiter', actor_id: ACTOR_102, display_name: '忽略', session_id: 'session-it-c' })

    assertProjectionShape(overview104, ACTOR_104, 'session-it-a')
    assertProjectionShape(overview105, ACTOR_105, 'session-it-b')

    // 列表 = 独立 SQL 读回（同一过滤/排序规则；共享库里的历史演示行也一并对上）。
    assert.deepEqual(overview104.interviews.map((row) => row.interview_id), await expectedInterviewIds(client, ACTOR_104))
    assert.deepEqual(overview105.interviews.map((row) => row.interview_id), await expectedInterviewIds(client, ACTOR_105))

    // 104 的私有夹具都在，105 的私有夹具都不在（反之亦然）——这就是"A/B 分配差异"。
    const ids104 = new Set(overview104.interviews.map((row) => row.interview_id))
    const ids105 = new Set(overview105.interviews.map((row) => row.interview_id))
    for (const id of [fixture.ivTemplate, fixture.ivRubricOnly, fixture.ivCancelled, fixture.ivShared]) {
      assert.equal(ids104.has(id), true, `104 的列表应含 ${id}`)
    }
    for (const id of [fixture.ivNoRubric, fixture.ivShared]) {
      assert.equal(ids105.has(id), true, `105 的列表应含 ${id}`)
    }
    for (const id of [fixture.ivTemplate, fixture.ivRubricOnly, fixture.ivCancelled]) {
      assert.equal(ids105.has(id), false, `105 不得看到 104 的私有面试 ${id}`)
    }
    for (const id of [fixture.ivNoRubric]) {
      assert.equal(ids104.has(id), false, `104 不得看到 105 的私有面试 ${id}`)
    }

    // 两人私有夹具集合的交集必须为空；共同可见的只有显式共享的那一场。
    const private104 = [fixture.ivTemplate, fixture.ivRubricOnly, fixture.ivCancelled]
    const private105 = [fixture.ivNoRubric]
    const overlap = private104.filter((id) => private105.includes(id))
    assert.deepEqual(overlap, [], `私有分配不得重叠：${overlap.join(',')}`)
    const sharedOverlap = [...ids104].filter((id) => ids105.has(id) && [fixture.ivShared].includes(id))
    assert.deepEqual(sharedOverlap, [fixture.ivShared], '夹具里只有 IV_SHARED 是两人共同可见的')

    // 102 的角色标签是 HIRING_MANAGER（并非 INTERVIEWER），但它是 IV_R 的登记面试官 → 看得到。
    assert.equal(overview102.interviews.some((row) => row.interview_id === fixture.ivRubricOnly), true)
    // 反过来：105 没有 INTERVIEWER 角色标签（演示种子只给 104）也照样看得到自己的分配。
    const roles105 = (
      await client.query<{ code: string }>(
        `select r.code from recruitment.actor_role ar
           join recruitment.role r on r.id = ar.role_id
          where ar.actor_id = $1 and ar.revoked_at is null`,
        [ACTOR_105],
      )
    ).rows.map((row) => row.code)
    assert.deepEqual(overview105.actor.roles, roles105, 'roles 是 actor_role 标签的原样回显')

    // 角色标签是库里的原样值（104 = INTERVIEWER），不是本文件编造的。
    const roles104 = (
      await client.query<{ code: string }>(
        `select r.code from recruitment.actor_role ar
           join recruitment.role r on r.id = ar.role_id
          where ar.actor_id = $1 and ar.revoked_at is null
          order by r.code`,
        [ACTOR_104],
      )
    ).rows.map((row) => row.code)
    assert.deepEqual(overview104.actor.roles, roles104)
  })
})

// =====================================================================
//  未分配 / 空库：interviews=[] + 全 0（不是错误）；越权 403 零行
// =====================================================================

test('未分配的 actor → interviews:[] + 全 0 计数；拿别人的 interview_id → 403 ACTOR_NOT_INTERVIEWER', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)

    const unassigned = await readInterviewerWorkspace(client, CFG, {
      alias: 'recruiter',
      actor_id: fixture.unassignedActorId,
      display_name: '未分配',
      session_id: 'session-it-unassigned',
    })
    assert.deepEqual(unassigned.interviews, [], '未分配 → 空列表（不是错误）')
    assert.deepEqual(unassigned.counts, {
      assigned_total: 0,
      open_interview_total: 0,
      pending_scorecard_total: 0,
      submitted_scorecard_total: 0,
      transcript_ready_total: 0,
      transcript_missing_total: 0,
    })
    assert.deepEqual(unassigned.issues, [])

    // 越权：未分配的 actor 指定 104 的一场 → 403，且**没有任何行**被返回（只有错误）。
    await assert.rejects(
      readInterviewerWorkspace(client, CFG, {
        alias: 'recruiter',
        actor_id: fixture.unassignedActorId,
        display_name: '未分配',
      }, { interviewId: fixture.ivTemplate }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'ACTOR_NOT_INTERVIEWER')
        return true
      },
    )

    // 105 拿 104 的私有面试同样 403（存在的、别人的、不存在的都回同一个码，不探测）。
    await assert.rejects(
      readInterviewerWorkspace(client, CFG, { alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B' }, {
        interviewId: fixture.ivTemplate,
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'ACTOR_NOT_INTERVIEWER')
        return true
      },
    )

    // 自己的（且只这一场）→ 一行；counts 也按这一行算（自洽）。
    const only = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a',
      actor_id: ACTOR_104,
      display_name: 'A',
      session_id: 'session-it-single',
    }, { interviewId: fixture.ivTemplate })
    assert.deepEqual(only.interviews.map((row) => row.interview_id), [fixture.ivTemplate])
    assert.equal(only.counts.assigned_total, 1)
    assert.deepEqual(only.counts, expectedCounts(only.interviews))
  })
})

// =====================================================================
//  transcript：三种状态（READY / MISSING / PENDING）都来自 readInterviewValue（TR-D）
// =====================================================================

test('transcript：READY / MISSING(NO_MEETING_BOUND) / PENDING(WAITING) 三态，时间关系由夹具排期控制', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const overview104 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A',
    })
    const overview105 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B',
    })

    // ① 绑了 PRIMARY 会议 + canonical READY 产物（正文非空）→ READY/CANONICAL_STATUS
    const ready = rowById(overview104, fixture.ivTemplate)
    assert.ok(ready, 'IV_T 必须在 104 的列表里')
    assert.deepEqual(ready.transcript, {
      state: 'READY',
      reason_code: 'CANONICAL_STATUS',
      no_transcript: false,
      meeting_binding_state: 'BOUND_ACTIVE',
      meetings_total: 1,
    })

    // ② 没绑会议 + 已过开始时间 → MISSING/NO_MEETING_BOUND（TR-D 序 1）
    const missing = rowById(overview104, fixture.ivRubricOnly)
    assert.ok(missing, 'IV_R 必须在 104 的列表里')
    assert.deepEqual(missing.transcript, {
      state: 'MISSING',
      reason_code: 'NO_MEETING_BOUND',
      no_transcript: true,
      meeting_binding_state: 'UNBOUND',
      meetings_total: 0,
    })

    // ③ 绑了会议、没有产物、结束时间在未来 → PENDING/WAITING（TR-D 序 7，还没到等待窗）
    const pending = rowById(overview105, fixture.ivNoRubric)
    assert.ok(pending, 'IV_105 必须在 105 的列表里')
    assert.deepEqual(pending.transcript, {
      state: 'PENDING',
      reason_code: 'WAITING',
      no_transcript: true,
      meeting_binding_state: 'BOUND_ACTIVE',
      meetings_total: 1,
    })

    // 三种状态同时存在 ⇒ 计数分桶能区分它们（ready 只数 READY，missing 只数 MISSING）。
    assert.equal(overview104.counts.transcript_ready_total, expectedCounts(overview104.interviews).transcript_ready_total)
    assert.ok(overview104.counts.transcript_ready_total >= 1, '至少 IV_T 是 READY')
    assert.ok(overview104.counts.transcript_missing_total >= 1, '至少 IV_R 是 MISSING')
  })
})

// =====================================================================
//  scorecard：两人状态不同且互不可见（隐私）
// =====================================================================

test('scorecard：同一场面试 104=SUBMITTED / 105=PENDING；双方的响应里都只有自己的 scorecard id', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const overview104 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A',
    })
    const overview105 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B',
    })

    const mine104 = rowById(overview104, fixture.ivShared)
    const mine105 = rowById(overview105, fixture.ivShared)
    assert.ok(mine104, 'IV_SHARED 必须在 104 的列表里')
    assert.ok(mine105, 'IV_SHARED 必须在 105 的列表里')

    // 同一场面试，两个人的面评状态不同：104 已提交，105 还是草稿。
    assert.equal(mine104.scorecard.state, 'SUBMITTED')
    assert.equal(mine104.scorecard.scorecard_id, fixture.scorecard104Shared)
    assert.equal(mine104.scorecard.status, 'SUBMITTED')
    assert.equal(mine104.scorecard.overall, 'HOLD')
    assert.equal(mine104.scorecard.transcript_basis, 'NO_TRANSCRIPT')
    assert.equal(mine104.required_action, 'REVIEW_SCORECARD')

    assert.equal(mine105.scorecard.state, 'PENDING')
    assert.equal(mine105.scorecard.scorecard_id, fixture.scorecard105Shared)
    assert.equal(mine105.scorecard.status, 'PENDING')
    assert.equal(mine105.scorecard.overall, null, 'PENDING 面评没有 overall')
    assert.equal(mine105.required_action, 'SUBMIT_SCORECARD')

    // 互不可见：谁的 JSON 里都不得出现另一个人的面评 id。
    const json104 = JSON.stringify(overview104)
    const json105 = JSON.stringify(overview105)
    assert.equal(json104.includes(fixture.scorecard105Shared), false, '104 的响应不得出现 105 的面评 id')
    assert.equal(json105.includes(fixture.scorecard104Shared), false, '105 的响应不得出现 104 的面评 id')
    assert.equal(json104.includes(ACTOR_105), false, '104 的响应不得出现 105 的 actor id')
    assert.equal(json105.includes(ACTOR_104), false, '105 的响应不得出现 104 的 actor id')

    // 另一个人的面评行确实存在（不是"两个人其实都没有"）：独立 SQL 读回 count。
    const sharedRows = (
      await client.query<{ n: number }>(
        'select count(*)::int as n from recruitment.scorecard where interview_id = $1 and superseded_by_scorecard_id is null',
        [fixture.ivShared],
      )
    ).rows[0]?.n
    assert.equal(sharedRows, 2, 'IV_SHARED 上确实有两份当前面评 —— 隐私断言才有意义')

    // IV_T 上 104 的面评是 SUBMITTED；IV_R 上没有面评 → NONE + 待提交。
    assert.equal(rowById(overview104, fixture.ivTemplate)?.scorecard.scorecard_id, fixture.scorecard104Template)
    const none = rowById(overview104, fixture.ivRubricOnly)
    assert.ok(none)
    assert.equal(none.scorecard.state, 'NONE')
    assert.equal(none.required_action, 'SUBMIT_SCORECARD')
    assert.equal(none.scorecard.record_version, null)
  })
})

// =====================================================================
//  brief：TEMPLATE / JOB_RUBRIC / NONE 三种 source
// =====================================================================

test('brief：模板 → TEMPLATE；只有 rubric → JOB_RUBRIC（objective=job.title，questions=[]）；都没有 → NONE + reason', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const overview104 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A',
    })
    const overview105 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B',
    })

    // ① 有模板行 → TEMPLATE（objective/briefing.summary/focus/questions/版本 id/哈希全部来自模板）
    const template = rowById(overview104, fixture.ivTemplate)
    assert.ok(template)
    assert.equal(template.brief.available, true)
    assert.equal(template.brief.source, 'TEMPLATE')
    assert.equal(template.brief.objective, fixture.templateObjective)
    assert.equal(template.brief.briefing, fixture.templateBriefing)
    assert.deepEqual(template.brief.focus, [{ key: 'backend_depth', label: '后端工程深度', weight: 0.5 }])
    assert.deepEqual(template.brief.questions, ['讲讲你设计过的分片方案', '遇到过消息重放吗？'])
    assert.equal(template.brief.template_version_id, fixture.templateId)
    assert.match(template.brief.template_payload_hash ?? '', /^[0-9a-f]{64}$/)
    assert.equal(template.brief.reason, null)

    // ② 无模板 + 有 rubric 维度 → JOB_RUBRIC（objective 退到岗位名；briefing/questions 不得伪造）
    const rubricOnly = rowById(overview104, fixture.ivRubricOnly)
    assert.ok(rubricOnly)
    const jobTitle = (
      await client.query<{ title: string }>('select title from recruitment.job where id = $1', [fixture.jobRubricOnlyId])
    ).rows[0]!.title
    assert.equal(rubricOnly.brief.source, 'JOB_RUBRIC')
    assert.equal(rubricOnly.brief.available, true)
    assert.equal(rubricOnly.brief.objective, jobTitle)
    assert.equal(rubricOnly.brief.briefing, null, '没有模板就不能有简报原文')
    assert.deepEqual(rubricOnly.brief.questions, [], 'rubric 维度不得冒充模板的问题')
    assert.deepEqual(
      rubricOnly.brief.focus,
      DIMENSIONS.map((dimension) => ({ key: dimension.key, label: dimension.label, weight: dimension.weight })),
    )
    assert.equal(rubricOnly.brief.template_version_id, null)
    assert.equal(rubricOnly.brief.template_payload_hash, null)
    assert.equal(rubricOnly.brief.reason, null)

    // ③ 无模板 + 无 rubric → NONE + reason（写清为什么没有简报）
    const noneBrief = rowById(overview105, fixture.ivNoRubric)
    assert.ok(noneBrief)
    assert.equal(noneBrief.brief.available, false)
    assert.equal(noneBrief.brief.source, 'NONE')
    assert.equal(noneBrief.brief.objective, null)
    assert.deepEqual(noneBrief.brief.focus, [])
    assert.deepEqual(noneBrief.brief.questions, [])
    assert.ok(typeof noneBrief.brief.reason === 'string' && noneBrief.brief.reason.length > 0)
    assert.equal(noneBrief.rubric, null)
  })
})

// =====================================================================
//  materials 三条路径 + rubric 正常回显 + 终态不计入 open
// =====================================================================

test('materials 三条路径；rubric 回显申请钉住的版本；终态面试不计入 open_interview_total', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const overview104 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A',
    })
    const overview105 = await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B',
    })

    // ① 已解析 → available:true + parsed_fields 原样
    const available = rowById(overview104, fixture.ivTemplate)
    assert.ok(available)
    assert.equal(available.materials.authorization, 'INTERVIEW_ASSIGNMENT')
    assert.equal(available.materials.available, true)
    assert.equal(available.materials.reason, null)
    assert.deepEqual(available.materials.resume?.fields, PARSED_FIELDS)
    assert.equal(available.materials.resume?.parse_status, 'PARSED')
    assert.equal(available.materials.resume?.parser_name, 'pymupdf')

    // ② 简历解析失败 → PARSE_FAILED（元数据在，字段为空，不把半成品当已解析）
    const failed = rowById(overview104, fixture.ivRubricOnly)
    assert.ok(failed)
    assert.equal(failed.materials.available, false)
    assert.equal(failed.materials.reason, 'PARSE_FAILED')
    assert.equal(failed.materials.resume?.parse_status, 'FAILED')
    assert.deepEqual(failed.materials.resume?.fields, {})

    // ③ 未绑定简历 → NO_MATERIAL_BOUND + resume=null
    const unbound = rowById(overview105, fixture.ivNoRubric)
    assert.ok(unbound)
    assert.equal(unbound.materials.available, false)
    assert.equal(unbound.materials.reason, 'NO_MATERIAL_BOUND')
    assert.equal(unbound.materials.resume, null)

    // ④ rubric 回显 = 申请钉住的那个版本，且 job_id 就是申请的岗位（不猜、不换版本）。
    const pinned = (
      await client.query<{ rubric_version_id: string }>(
        'select rubric_version_id::text as rubric_version_id from recruitment.application where id = $1',
        [(
          await client.query<{ application_id: string }>(
            'select application_id::text as application_id from recruitment.interview where id = $1',
            [fixture.ivTemplate],
          )
        ).rows[0]!.application_id],
      )
    ).rows[0]!.rubric_version_id
    assert.equal(available.rubric?.rubric_version_id, pinned)
    assert.equal(available.rubric?.job_id, available.job.job_id)
    assert.equal(available.rubric?.payload_hash?.length, 64)
    assert.deepEqual(
      available.rubric?.dimensions.map((dimension) => dimension.key),
      DIMENSIONS.map((dimension) => dimension.key),
    )
    assert.equal(rowById(overview104, fixture.ivRubricOnly)?.rubric?.job_id, fixture.jobRubricOnlyId)

    // ⑤ issues 只写"我没法诚实地填满"的事，且**必须写明是哪一场**。
    //    §1.5 的 rubric 越界分支在本库造不出来（复合外键 fk_application_rubric_job 直接拒），
    //    该分支由单测覆盖；这里断言正常路径不产生噪声 issue。
    assert.deepEqual(overview104.issues, [])
    assert.deepEqual(overview105.issues, [])

    // ⑥ 终态 CANCELLED：不进 open_interview_total，但仍是"我的分配"（assigned_total 含它）。
    const cancelled = rowById(overview104, fixture.ivCancelled)
    assert.ok(cancelled, 'CANCELLED 的面试仍在我的分配列表里')
    assert.equal(cancelled.status, 'CANCELLED')
    const statuses = overview104.interviews.map((row) => row.status)
    assert.equal(statuses.filter((status) => status === 'CANCELLED').length >= 1, true)
    // 独立重算：open = 全部行 - DECIDED/CANCELLED/NO_SHOW。
    assert.equal(
      overview104.counts.open_interview_total,
      statuses.filter((status) => !['DECIDED', 'CANCELLED', 'NO_SHOW'].includes(status)).length,
    )
    assert.equal(
      overview104.counts.open_interview_total < overview104.counts.assigned_total,
      true,
      '夹具里至少有一条终态面试，open 必须严格小于 assigned',
    )
  })
})

// =====================================================================
//  只读：整个读路径都是 SELECT（数据库层强制）
// =====================================================================

test('只读：readInterviewerWorkspace 不产生任何写（事务仍可继续 + 行数不变）', async () => {
  await inRolledBackTx(POOL, async (client) => {
    const fixture = await seedFixture(client)
    const countRows = async (): Promise<string> => {
      const { rows } = await client.query<{ n: string }>(
        `select (select count(*) from recruitment.scorecard)::text
             || '/' || (select count(*) from recruitment.interview)::text
             || '/' || (select count(*) from recruitment.interviewer)::text as n`,
      )
      return rows[0]!.n
    }
    const before = await countRows()
    await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_a', actor_id: ACTOR_104, display_name: 'A',
    })
    await readInterviewerWorkspace(client, CFG, {
      alias: 'interviewer_b', actor_id: ACTOR_105, display_name: 'B',
    })
    assert.equal(await countRows(), before, '读模型不得写任何行')
    // 事务仍然可用（没有把连接打成 aborted 状态）。
    assert.equal((await client.query<{ ok: number }>('select 1 as ok')).rows[0]!.ok, 1)
    assert.ok(fixture.ivTemplate.length > 0)
  })
})
