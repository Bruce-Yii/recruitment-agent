// Issue #55 — deterministic eval fixture (model-agnostic).
//
// 两个面：
//   1. `buildEvalFixture()` —— 纯数据夹具（零 IO、零随机、零时间抖动）。18 例 golden cases
//      和 L1/L2 graders 都只吃这份确定性数据，所以 `--mode=deterministic` 完全离线可复现。
//   2. `seedEvalDatabase()` —— 用 `createIsolatedTestDatabase()` 建一次性空库，把同一份
//      确定性事实落进真 PG17，返回关键表行数快照（供 DB-backed 验收与“0 写工具 → 行数零变化”
//      的独立复核）。**只在有 RECRUITMENT_DB_PASSWORD 且显式调用时连库**；deterministic runner
//      不调用它，避免把 eval 变成“必须有库才跑得起来”。
//
// 覆盖：S6–S10 全链路 + MERGED 历史同联系方式记录 + 人工标准纠偏 + 超时未交面评 +
// 转写片段 + 空库态 + 连接器未配置态。所有 id 为固定 UUID 形状常量（写在夹具里是**数据**，
// 不是给 HR 看的文案；grader 的“零 UUID 泄露”只检查 Agent 输出文本/UI 人话字段）。
import { createIsolatedTestDatabase, TENANT, HR_ACTOR, DEMO_DEPARTMENT, hex64, type IsolatedTestDatabase } from '../integration/db.ts'

/** 固定锚点 UUID（确定性；仅用于夹具内部引用）。 */
export const EVAL_IDS = {
  jobBackend: '22222222-2222-4222-8222-000000000401',
  jobBackendVersion: '22222222-2222-4222-8222-000000000402',
  jobBackendRubric: '22222222-2222-4222-8222-000000000403',
  jobNew: '22222222-2222-4222-8222-000000000411',
  jobNewVersion: '22222222-2222-4222-8222-000000000412',
  jobNewRubric: '22222222-2222-4222-8222-000000000413',
  candidateZhang: '22222222-2222-4222-8222-000000000501',
  candidateLi: '22222222-2222-4222-8222-000000000502',
  candidateWang: '22222222-2222-4222-8222-000000000503',
  candidateMerged: '22222222-2222-4222-8222-000000000504',
  applicationZhang: '22222222-2222-4222-8222-000000000601',
  applicationLi: '22222222-2222-4222-8222-000000000602',
  applicationWang: '22222222-2222-4222-8222-000000000603',
  applicationMerged: '22222222-2222-4222-8222-000000000604',
  applicationFinalA: '22222222-2222-4222-8222-000000000605',
  applicationFinalB: '22222222-2222-4222-8222-000000000606',
  applicationFinalC: '22222222-2222-4222-8222-000000000607',
  interviewWangRound2: '22222222-2222-4222-8222-000000000701',
  transcriptWang: '22222222-2222-4222-8222-000000000702',
  scorecardOverdue: '22222222-2222-4222-8222-000000000703',
  interviewerA: '22222222-2222-4222-8222-000000000801',
  interviewerB: '22222222-2222-4222-8222-000000000802',
} as const

/** 固定时间点（确定性；不取 now()）。 */
export const EVAL_TIME = {
  overdueDueAt: '2026-11-20T10:00:00.000Z',
  asOf: '2026-11-23T00:00:00.000Z',
  slotStart: '2026-11-24T14:00:00+08:00',
  slotEnd: '2026-11-24T15:00:00+08:00',
} as const

export interface EvalCandidateRow {
  readonly id: string
  readonly name: string
  readonly phone: string
  readonly email: string
  readonly identityStatus: 'ACTIVE' | 'MERGED'
  readonly mergedInto?: string
}

export interface EvalApplicationRow {
  readonly id: string
  readonly candidateId: string
  readonly jobId: string
  readonly stage: string
  readonly screeningVerdict?: 'PASS' | 'FAIL'
  readonly screeningReason?: string
  readonly sourceQuote?: string
}

export interface EvalScorecardRow {
  readonly interviewId: string
  readonly applicationId: string
  readonly interviewer: string
  readonly dueAt: string
  readonly submitted: boolean
}

export interface EvalFixture {
  readonly tenantId: string
  readonly actorId: string
  readonly jobs: readonly { readonly id: string; readonly code: string; readonly title: string; readonly rubricId: string }[]
  readonly candidates: readonly EvalCandidateRow[]
  readonly applications: readonly EvalApplicationRow[]
  readonly overrides: readonly { readonly applicationId: string; readonly criterion: string; readonly reason: string; readonly actor: string }[]
  readonly scorecards: readonly EvalScorecardRow[]
  readonly transcriptSegments: readonly { readonly interviewId: string; readonly speaker: string; readonly text: string }[]
  readonly connector: { readonly feishuCalendar: 'NOT_CONFIGURED' | 'CONNECTED' }
  /** 关键表行数阴影（deterministic 的“PG 行数零变化”判据）。 */
  readonly tableCounts: Readonly<Record<string, number>>
  /** 空库态（E-13）的独立阴影。 */
  readonly emptyTableCounts: Readonly<Record<string, number>>
}

/**
 * 一份**完全确定性**的 eval 事实阴影。两次调用返回结构相等的对象。
 * 不读环境变量、不读当前时间、不连数据库。
 */
export function buildEvalFixture(): EvalFixture {
  const jobs = [
    { id: EVAL_IDS.jobBackend, code: 'BE-CORE', title: '后端工程师（高并发）', rubricId: EVAL_IDS.jobBackendRubric },
    { id: EVAL_IDS.jobNew, code: 'BE-NEW', title: '新业务后端岗', rubricId: EVAL_IDS.jobNewRubric },
  ]
  const candidates: EvalCandidateRow[] = [
    { id: EVAL_IDS.candidateZhang, name: '张三', phone: '+8613800000001', email: 'zhangsan@example.com', identityStatus: 'ACTIVE' },
    { id: EVAL_IDS.candidateLi, name: '李四', phone: '+8613800000002', email: 'lisi@example.com', identityStatus: 'ACTIVE' },
    { id: EVAL_IDS.candidateWang, name: '王五', phone: '+8613800000003', email: 'wangwu@example.com', identityStatus: 'ACTIVE' },
    {
      id: EVAL_IDS.candidateMerged,
      name: '张三（历史投递）',
      phone: '+8613800000001',
      email: 'zhangsan@example.com',
      identityStatus: 'MERGED',
      mergedInto: EVAL_IDS.candidateZhang,
    },
  ]
  const applications: EvalApplicationRow[] = [
    {
      id: EVAL_IDS.applicationZhang,
      candidateId: EVAL_IDS.candidateZhang,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S7',
      screeningVerdict: 'FAIL',
      screeningReason: '项目经历未覆盖高并发场景要求',
      sourceQuote: '负责内部管理系统 CRUD 接口开发，日请求量不足百次',
    },
    {
      id: EVAL_IDS.applicationLi,
      candidateId: EVAL_IDS.candidateLi,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S7',
      screeningVerdict: 'PASS',
    },
    {
      id: EVAL_IDS.applicationWang,
      candidateId: EVAL_IDS.candidateWang,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S8',
      screeningVerdict: 'PASS',
    },
    {
      id: EVAL_IDS.applicationMerged,
      candidateId: EVAL_IDS.candidateMerged,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S7',
      screeningVerdict: 'FAIL',
      screeningReason: '历史记录：缺少大规模系统经验',
    },
    {
      id: EVAL_IDS.applicationFinalA,
      candidateId: EVAL_IDS.candidateZhang,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S10',
      screeningVerdict: 'PASS',
    },
    {
      id: EVAL_IDS.applicationFinalB,
      candidateId: EVAL_IDS.candidateLi,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S10',
      screeningVerdict: 'PASS',
    },
    {
      id: EVAL_IDS.applicationFinalC,
      candidateId: EVAL_IDS.candidateWang,
      jobId: EVAL_IDS.jobBackend,
      stage: 'S10',
      screeningVerdict: 'PASS',
    },
  ]
  const overrides = [
    {
      applicationId: EVAL_IDS.applicationLi,
      criterion: '项目经验',
      reason: '候选人补充了高并发项目说明，人工复核后调整结论',
      actor: '招聘负责人',
    },
  ]
  const scorecards: EvalScorecardRow[] = [
    {
      interviewId: EVAL_IDS.interviewWangRound2,
      applicationId: EVAL_IDS.applicationWang,
      interviewer: '面试官甲',
      dueAt: EVAL_TIME.overdueDueAt,
      submitted: false,
    },
  ]
  const transcriptSegments = [
    {
      interviewId: EVAL_IDS.interviewWangRound2,
      speaker: '面试官',
      text: '请讲一下你怎么做分布式事务的补偿。',
    },
    {
      interviewId: EVAL_IDS.interviewWangRound2,
      speaker: '候选人',
      text: '我们用本地消息表加定时对账，先保证最终一致，失败时按幂等键重试。',
    },
  ]
  const tableCounts: Record<string, number> = {
    job: 2,
    job_version: 2,
    rubric_version: 2,
    candidate: 4,
    application: 7,
    resume_version: 4,
    criterion_override: 1,
    interview: 1,
    transcript_segment: 2,
    scorecard: 1,
    decision_record: 0,
    audit_event: 3,
    booking_invite: 0,
  }
  const emptyTableCounts: Record<string, number> = Object.fromEntries(
    Object.keys(tableCounts).map((key) => [key, 0]),
  )
  return {
    tenantId: TENANT,
    actorId: HR_ACTOR,
    jobs,
    candidates,
    applications,
    overrides,
    scorecards,
    transcriptSegments,
    connector: { feishuCalendar: 'NOT_CONFIGURED' },
    tableCounts,
    emptyTableCounts,
  }
}

/** 取确定性表名→行数快照（深拷贝，避免被 grader 误改）。 */
export function fixtureCounts(fixture: EvalFixture, empty = false): Record<string, number> {
  return { ...(empty ? fixture.emptyTableCounts : fixture.tableCounts) }
}

export interface SeededEvalDatabase {
  readonly database: IsolatedTestDatabase
  readonly countsBefore: Record<string, number>
  countsAfter(): Promise<Record<string, number>>
}

const COUNT_TABLES = [
  'job', 'job_version', 'rubric_version', 'candidate', 'application',
  'resume_version', 'criterion_override', 'interview', 'transcript_segment',
  'scorecard', 'decision_record', 'audit_event', 'booking_invite',
] as const

async function readCounts(pool: IsolatedTestDatabase['pool']): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of COUNT_TABLES) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from recruitment.${table}`,
    )
    out[table] = Number(rows[0]?.n ?? '0')
  }
  return out
}

/**
 * 真 PG 的一次性夹具（**显式调用才连库**）。复用 `createIsolatedTestDatabase()`：
 * 库名并发安全、迁移 0001→N 全量重放、结束 drop，不碰共享 ra_s6s7。
 * 使用固定 UUID 与固定内容，跨次运行可重复。
 */
export async function seedEvalDatabase(label = 'eval_fixture'): Promise<SeededEvalDatabase> {
  const database = await createIsolatedTestDatabase(label)
  try {
    const client = await database.pool.connect()
    try {
      const fixture = buildEvalFixture()
      await client.query('begin')
      await client.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])

      for (const job of fixture.jobs) {
        await client.query(`insert into recruitment.department (id, tenant_id, name)
          values ($1, $2, $3) on conflict do nothing`, [DEMO_DEPARTMENT, TENANT, '研发中心'])
        await client.query(`insert into recruitment.job
          (id, tenant_id, department_id, code, title, status)
          values ($1, $2, $3, $4, $5, 'OPEN') on conflict do nothing`,
        [job.id, TENANT, DEMO_DEPARTMENT, job.code, job.title])
        const versionId = job.id === EVAL_IDS.jobBackend ? EVAL_IDS.jobBackendVersion : EVAL_IDS.jobNewVersion
        await client.query(`insert into recruitment.job_version
          (id, tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
          values ($1, $2, $3, 1, $4, $5, $6) on conflict do nothing`,
        [versionId, TENANT, job.id, `${job.title} 岗位职责与要求`, hex64(`jv-${job.code}`), HR_ACTOR])
        await client.query('update recruitment.job set current_job_version_id = $2 where id = $1',
          [job.id, versionId])
        await client.query(`insert into recruitment.rubric_version
          (id, tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
          values ($1, $2, $3, 1, $4::jsonb, $5, $6) on conflict do nothing`,
        [job.rubricId, TENANT, job.id, JSON.stringify([{ key: '项目经验', weight: 1 }]),
          hex64(`rubric-${job.code}`), HR_ACTOR])
        await client.query('update recruitment.job set current_rubric_version_id = $2 where id = $1',
          [job.id, job.rubricId])
      }

      for (const candidate of fixture.candidates) {
        if (candidate.identityStatus === 'MERGED') continue
        await client.query(`insert into recruitment.candidate
          (id, tenant_id, display_name, normalized_email, normalized_phone, identity_status)
          values ($1, $2, $3, $4, $5, 'ACTIVE') on conflict do nothing`,
        [candidate.id, TENANT, candidate.name, candidate.email, candidate.phone])
      }

      for (const application of fixture.applications) {
        const candidateId = application.candidateId === EVAL_IDS.candidateMerged
          ? EVAL_IDS.candidateZhang : application.candidateId
        const job = fixture.jobs.find((j) => j.id === application.jobId) ?? fixture.jobs[0]!
        const versionId = job.id === EVAL_IDS.jobBackend ? EVAL_IDS.jobBackendVersion : EVAL_IDS.jobNewVersion
        await client.query(`insert into recruitment.application
          (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id,
           lifecycle_status, current_stage_code)
          values ($1, $2, $3, $4, $5, $6, 'ACTIVE', $7) on conflict do nothing`,
        [application.id, TENANT, candidateId, job.id, versionId, job.rubricId, application.stage])
      }

      await client.query('commit')
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
    const countsBefore = await readCounts(database.pool)
    return {
      database,
      countsBefore,
      countsAfter: () => readCounts(database.pool),
    }
  } catch (error) {
    await database.drop().catch(() => {})
    throw error
  }
}

/** 仅供 DB-backed 验收：确认用的是一次性库而不是共享库。 */
export function assertEvalPrivateDatabase(name: string): void {
  if (!name.startsWith('ra_eval')) {
    throw new Error(`eval 夹具必须落在一次性库（ra_eval*），实际 ${name}`)
  }
}
