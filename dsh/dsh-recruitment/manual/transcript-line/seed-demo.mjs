// S9 转写线 · 演示夹具（手工联调，不是单测）。
//
// 作用：造一条**自包含、可重复执行**的 S9 前置链：
//   job → job_version → rubric_version → candidate → application
//       → interview（第 1 轮 / DEFAULT / S9 / POST_INTERVIEW）
//       → meeting（provider=FEISHU，仅登记平台会议标识，**不代表已连接飞书**）
//       → meeting_binding（binding_method=MANUAL，bound_by_actor_id=HR）
//
// 为什么需要它：S8（排期）工具不在本 lane 的文件所有权内，而 transcript_artifact
// 必须有 meeting（NOT NULL + FK），所以演示以外科方式直接写库造前置。**这不是**
// 产品路径：真实产品里 interview/meeting/binding 由 S8 的 recruitment_interview_schedule 写
// （contracts/interview/tool-contracts.md §0）。本文件在回传里如实标注为夹具。
//
// 幂等：按业务键查找，存在就复用，不存在才插入；重复执行不会新增重复对象。
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/transcript-line/seed-demo.mjs
import pg from 'pg'
import { mkdir, writeFile } from 'node:fs/promises'

import { resolveDatabaseConfig } from '../../src/db/pool.ts'

const DEMO = {
  jobCode: 'S9-TR-DEMO',
  jobTitle: 'S9 转写线演示岗位（合成）',
  candidateName: 'S9 演示候选人（合成）',
  departmentId: '11111111-1111-4111-8111-000000000010',
  provider: 'FEISHU',
  /**
   * 维度真值的来源申请（S6→S7 演示申请 …0701）。**不硬编码任何维度键**：
   * 演示夹具的 rubric pin 已由 `scripts/bootstrap-demo.mjs` 的 O3 纠偏（干净库 = v2
   * `work_exists/edu_exists/team_lead`）；本脚本从库里读这条申请钉住的 rubric 的 dimensions，
   * 再复制到 S9 演示岗位自己的 rubric（面试记录要求 rubric 属于申请的岗位）。
   */
  rubricSourceApplicationId: '11111111-1111-4111-8111-000000000701',
  // `--round N` 可造第二轮（用于“干净的一次导入”证据，同时不影响第 1 轮的 revision 证据）。
  roundNo: (() => {
    const index = process.argv.indexOf('--round')
    const value = index >= 0 ? Number(process.argv[index + 1]) : 1
    return Number.isInteger(value) && value >= 1 && value <= 20 ? value : 1
  })(),
}
const MEETING_EXTERNAL_ID = DEMO.roundNo === 1
  ? 'feishu-demo-meeting-s9'
  : `feishu-demo-meeting-s9-r${DEMO.roundNo}`

/** 键按码点排序、无空白的 JSON（与 src/tools/contract.ts 的 canonicalJson 同规则）。 */
function canonicalJson(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const { createHash } = await import('node:crypto')
const digest = (value) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')

function config() {
  const { resolved, issues } = resolveDatabaseConfig({
    host: process.env.RECRUITMENT_TEST_DB_HOST ?? '127.0.0.1',
    port: Number(process.env.RECRUITMENT_TEST_DB_PORT ?? 5432),
    user: process.env.RECRUITMENT_TEST_DB_USER ?? 'postgres',
    database: process.env.RECRUITMENT_TEST_DB ?? 'ra_s6s7',
    tenant_id: '11111111-1111-4111-8111-000000000001',
    actor_id: '11111111-1111-4111-8111-000000000103',
  }, process.env)
  if (resolved === null) {
    console.error(`[seed] 数据库配置不完整：${issues.join('; ')}`)
    console.error('[seed] 先设 $env:RECRUITMENT_DB_PASSWORD（密码只从环境变量读）')
    process.exit(2)
  }
  return resolved
}

const cfg = config()
const pool = new pg.Pool({
  host: cfg.host, port: cfg.port, user: cfg.user, database: cfg.database,
  password: cfg.password, max: 2, application_name: 's9-transcript-seed',
})

/** 跑一条 returning 单列并取值。 */
async function one(client, sql, params) {
  const { rows } = await client.query(sql, params)
  const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0]
  if (typeof value !== 'string') throw new Error(`[seed] no row: ${sql.slice(0, 80)}`)
  return value
}

async function main() {
  const client = await pool.connect()
  try {
    await client.query('begin')
    await client.query("select set_config('recruitment.actor_id', $1, true)", [cfg.actor_id])

    // 1. job（code 唯一）
    let jobId = (await client.query(
      'select id from recruitment.job where tenant_id = $1 and code = $2', [cfg.tenant_id, DEMO.jobCode],
    )).rows[0]?.id
    if (jobId === undefined) {
      jobId = await one(client, `insert into recruitment.job
          (tenant_id, department_id, code, title, status)
          values ($1, $2, $3, $4, 'OPEN') returning id`, [
        cfg.tenant_id, DEMO.departmentId, DEMO.jobCode, DEMO.jobTitle,
      ])
    }

    // 2. job_version v1
    let jobVersionId = (await client.query(
      'select id from recruitment.job_version where tenant_id = $1 and job_id = $2 and version_no = 1',
      [cfg.tenant_id, jobId],
    )).rows[0]?.id
    if (jobVersionId === undefined) {
      jobVersionId = await one(client, `insert into recruitment.job_version
          (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
          values ($1, $2, 1, $3, $4, $5) returning id`, [
        cfg.tenant_id, jobId, 'S9 转写线演示 JD（合成，不含真实岗位信息）', digest({ job: DEMO.jobCode, v: 1 }), cfg.actor_id,
      ])
    }
    await client.query('update recruitment.job set current_job_version_id = $2 where id = $1 and tenant_id = $3', [
      jobId, jobVersionId, cfg.tenant_id,
    ])

    // 3. rubric_version v1（维度键**从库里读真值**，不硬编码）
    //    S9 演示岗位自己需要一条 rubric（interview_record → rubric 的 job 一致性检查），
    //    所以把演示申请钉住的 rubric 的 dimensions **原样复制**成该岗位的 v1，
    //    而不是在 manual 脚本里另编一套会过期的 v1 键（旧做法：backend_depth/system_design/communication）。
    const pinned = (await client.query(
      `select a.rubric_version_id::text as rubric_version_id, rv.version_no, rv.dimensions
         from recruitment.application a
         join recruitment.rubric_version rv
           on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id
        where a.id = $1 and a.tenant_id = $2`,
      [DEMO.rubricSourceApplicationId, cfg.tenant_id],
    )).rows[0]
    if (pinned === undefined) {
      throw new Error(
        `[seed] 演示申请 ${DEMO.rubricSourceApplicationId} 没有钉住 rubric：先跑 scripts/bootstrap-demo.mjs，`
        + '本脚本不硬编码维度键（D-110 演示夹具已换 pin）。',
      )
    }
    const dimensions = pinned.dimensions
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      throw new Error(`[seed] 演示申请钉住的 rubric ${pinned.rubric_version_id} 没有 dimensions`)
    }
    const expectedDimensionKeys = dimensions.map((dimension) => dimension.key)
    const existingRubric = (await client.query(
      'select id, dimensions from recruitment.rubric_version where tenant_id = $1 and job_id = $2 and version_no = 1',
      [cfg.tenant_id, jobId],
    )).rows[0]
    let rubricId = existingRubric?.id
    if (existingRubric !== undefined) {
      const existingKeys = Array.isArray(existingRubric.dimensions)
        ? existingRubric.dimensions.map((dimension) => dimension.key)
        : []
      if (JSON.stringify(existingKeys) !== JSON.stringify(expectedDimensionKeys)) {
        throw new Error(
          `[seed] 已存在的 S9 演示 rubric 维度键（${existingKeys.join(',') || '空'}）`
          + ` 与演示申请钉住 rubric 的真值（${expectedDimensionKeys.join(',')}）不一致；`
          + '一次性演示库请先清理该岗位/rubric，拒绝静默复用过期夹具（rubric_version 不可 UPDATE）。',
        )
      }
      rubricId = existingRubric.id
    }
    if (rubricId === undefined) {
      rubricId = await one(client, `insert into recruitment.rubric_version
          (tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
          values ($1, $2, 1, $3::jsonb, $4, $5) returning id`, [
        cfg.tenant_id, jobId, JSON.stringify(dimensions), digest(dimensions), cfg.actor_id,
      ])
    }

    // 4. candidate（合成；按 display_name 复用）
    let candidateId = (await client.query(
      `select id from recruitment.candidate where tenant_id = $1 and display_name = $2
         and identity_status = 'ACTIVE' order by created_at limit 1`,
      [cfg.tenant_id, DEMO.candidateName],
    )).rows[0]?.id
    if (candidateId === undefined) {
      candidateId = await one(client, `insert into recruitment.candidate
          (tenant_id, display_name, identity_status) values ($1, $2, 'ACTIVE') returning id`, [
        cfg.tenant_id, DEMO.candidateName,
      ])
    }

    // 5. application（同一 (candidate, job) 只能有一条 ACTIVE，0009 的部分唯一索引）
    let applicationId = (await client.query(
      `select id from recruitment.application where tenant_id = $1 and candidate_id = $2
         and job_id = $3 and lifecycle_status = 'ACTIVE' limit 1`,
      [cfg.tenant_id, candidateId, jobId],
    )).rows[0]?.id
    if (applicationId === undefined) {
      applicationId = await one(client, `insert into recruitment.application
          (tenant_id, candidate_id, job_id, job_version_id, rubric_version_id,
           lifecycle_status, current_stage_code)
          values ($1, $2, $3, $4, $5, 'ACTIVE', 'S9') returning id`, [
        cfg.tenant_id, candidateId, jobId, jobVersionId, rubricId,
      ])
    } else {
      // 复用旧行时只补空引用（不覆盖已有事实）
      await client.query(`update recruitment.application
          set rubric_version_id = coalesce(rubric_version_id, $2),
              job_version_id   = coalesce(job_version_id, $3)
        where id = $1 and tenant_id = $4`, [applicationId, rubricId, jobVersionId, cfg.tenant_id])
    }

    // 6. interview（(application, round_no, slot_code) 唯一）
    let interviewId = (await client.query(
      `select id from recruitment.interview where tenant_id = $1 and application_id = $2
         and round_no = $3 and slot_code = 'DEFAULT'`,
      [cfg.tenant_id, applicationId, DEMO.roundNo],
    )).rows[0]?.id
    if (interviewId === undefined) {
      interviewId = await one(client, `insert into recruitment.interview
          (tenant_id, application_id, round_no, slot_code, stage_code, status,
           scheduled_start_at, scheduled_end_at, timezone)
          values ($1, $2, $3, 'DEFAULT', 'S9', 'POST_INTERVIEW',
                  now() - interval '3 hours', now() - interval '2 hours', 'Asia/Shanghai')
          returning id`, [cfg.tenant_id, applicationId, DEMO.roundNo])
    }

    // 7. meeting（(tenant, provider, external_meeting_id) 唯一；只是本地登记平台标识）
    let meetingId = (await client.query(
      `select id from recruitment.meeting where tenant_id = $1 and provider = $2
         and external_meeting_id = $3`,
      [cfg.tenant_id, DEMO.provider, MEETING_EXTERNAL_ID],
    )).rows[0]?.id
    if (meetingId === undefined) {
      meetingId = await one(client, `insert into recruitment.meeting
          (tenant_id, provider, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
          values ($1, $2, $3, 'PRIMARY', now() - interval '3 hours', now() - interval '2 hours')
          returning id`, [cfg.tenant_id, DEMO.provider, MEETING_EXTERNAL_ID])
    } else {
      await client.query(`update recruitment.meeting
          set meeting_role = 'PRIMARY',
              actual_start_at = coalesce(actual_start_at, now() - interval '3 hours'),
              actual_end_at   = coalesce(actual_end_at,   now() - interval '2 hours')
        where id = $1 and tenant_id = $2`, [meetingId, cfg.tenant_id])
    }

    // 8. meeting_binding（同一 meeting 只能有一条 active；MANUAL 必须有人）
    let bindingId = (await client.query(
      `select id from recruitment.meeting_binding
        where tenant_id = $1 and meeting_id = $2 and unbound_at is null`,
      [cfg.tenant_id, meetingId],
    )).rows[0]?.id
    if (bindingId === undefined) {
      const boundTo = (await client.query(
        `select interview_id from recruitment.meeting_binding
          where tenant_id = $1 and meeting_id = $2 and unbound_at is null`, [cfg.tenant_id, meetingId],
      )).rows[0]?.interview_id
      if (boundTo !== undefined) {
        throw new Error(`[seed] meeting ${meetingId} 已绑到另一场面试 ${boundTo}，拒绝改绑`)
      }
      bindingId = await one(client, `insert into recruitment.meeting_binding
          (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
          values ($1, $2, $3, 'MANUAL', $4) returning id`, [
        cfg.tenant_id, meetingId, interviewId, cfg.actor_id,
      ])
    } else {
      const boundTo = (await client.query(
        'select interview_id from recruitment.meeting_binding where id = $1', [bindingId],
      )).rows[0]?.interview_id
      if (boundTo !== interviewId) {
        throw new Error(`[seed] meeting ${meetingId} 的 active binding 指向 ${boundTo}，不是本演示面试 ${interviewId}`)
      }
    }

    await client.query('commit')
    // 把夹具 id 落成证据文件（后续 run-import / readback 不用重算业务键）。
    const evidenceDir = new URL('./evidence/', import.meta.url)
    await mkdir(evidenceDir, { recursive: true })
    const summary = {
      seeded: true,
      tenant_id: cfg.tenant_id,
      actor_id: cfg.actor_id,
      job_id: jobId,
      job_version_id: jobVersionId,
      rubric_version_id: rubricId,
      rubric_source: {
        application_id: DEMO.rubricSourceApplicationId,
        rubric_version_id: pinned.rubric_version_id,
        version_no: pinned.version_no,
        dimension_keys: expectedDimensionKeys,
        note: '维度从库里读（不硬编码版本键）；S9 演示岗位需要自己的 rubric 以满足 interview_record 的 job 一致性',
      },
      candidate_id: candidateId,
      application_id: applicationId,
      interview_id: interviewId,
      interview_round_no: DEMO.roundNo,
      meeting_id: meetingId,
      meeting_binding_id: bindingId,
      meeting: { provider: DEMO.provider, external_meeting_id: MEETING_EXTERNAL_ID, meeting_role: 'PRIMARY' },
      note: 'S8 排期工具不在本 lane；interview/meeting/binding 是手工夹具，不是产品写路径',
    }
    console.log(JSON.stringify(summary, null, 2))
    await writeFile(new URL('./evidence/seed.json', import.meta.url), JSON.stringify(summary, null, 2), 'utf8')
    console.log('[seed] 证据写入 manual/transcript-line/evidence/seed.json')
  } catch (error) {
    await client.query('rollback').catch(() => {})
    console.error('[seed] 失败：', error.message)
    process.exitCode = 1
  } finally {
    client.release()
    await pool.end()
  }
}

await main()
