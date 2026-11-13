// S10 评价线 · 演示夹具（S8/S9 侧的输入，**不是** S10 工具的写路径）。
//
// 为什么直接写库：本轮的 S8（interview）/ S9（transcript）由别的 lane 负责，
// 仓库里**还没有**任何 interview / interviewer / transcript 行（2026-11-13 实测）。
// 为了在"两个隔离演示身份各交一份面评 → 汇总 → 人工决策"这条链上做真实读回，
// 这里按 S8/S9 契约的**列语义**造假数据行——它们是"人工导入的转写 + 人工登记的面试"，
// 也就是 docs/20 允许的个人开发者降级路径，**不冒充 Feishu LIVE**（provenance=FIXTURE、
// connection_state=NOT_CONNECTED、trigger_mode=MANUAL 全部显式写死）。
//
// 幂等：重复跑不新增行（固定 UUID + ON CONFLICT DO NOTHING / DO UPDATE）。
//
// 用法（PowerShell）：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/evaluation-line/seed-demo.mjs
import pg from 'pg'

const TENANT = '11111111-1111-4111-8111-000000000001'
const ACTOR_HR = '11111111-1111-4111-8111-000000000103'
const ACTOR_X = '11111111-1111-4111-8111-000000000105'
const ACTOR_Y = '11111111-1111-4111-8111-000000000106'
const ACTOR_AGENT = '11111111-1111-4111-8111-0000000001a0'
const APPLICATION = '11111111-1111-4111-8111-000000000701'
const RUBRIC_V1 = '11111111-1111-4111-8111-000000000403'
const INTERVIEW = '11111111-1111-4111-8111-000000000801'
const MEETING = '11111111-1111-4111-8111-000000000901'
const ARTIFACT = '11111111-1111-4111-8111-000000000a01'

/** 人工导入的转写原文（合成内容，无真实个人资料；R7）。 */
const SEGMENTS = [
  { seq: 0, speaker: 'SPEAKER_A', label: '面试官X', start: 0, end: 8000,
    text: '请讲一下你做过的高并发下单链路，分片键是怎么选的？' },
  { seq: 1, speaker: 'SPEAKER_B', label: '候选人', start: 8000, end: 42000,
    text: '订单表按用户 ID 分成 64 片，热点商家单独做了一张路由表，写入走路由表再落到具体分片。' },
  { seq: 2, speaker: 'SPEAKER_A', label: '面试官X', start: 42000, end: 61000,
    text: '如果要做容量估算，峰值 QPS 你会怎么算？' },
  { seq: 3, speaker: 'SPEAKER_A', label: '面试官X', start: 61000, end: 96000,
    text: '追问两次后候选人回答"主要靠加机器"，没有给出估算过程。' },
  { seq: 4, speaker: 'SPEAKER_C', label: '面试官Y', start: 96000, end: 132000,
    text: '异步任务的重试与幂等你们怎么保证的？' },
  { seq: 5, speaker: 'SPEAKER_B', label: '候选人', start: 132000, end: 175000,
    text: '用消息队列重试三次，幂等靠业务唯一键加去重表，失败进死信队列等人工处理。' },
  { seq: 6, speaker: 'SPEAKER_C', label: '面试官Y', start: 175000, end: 198000,
    text: '前端这块你实际写过什么？' },
  { seq: 7, speaker: 'SPEAKER_B', label: '候选人', start: 198000, end: 223000,
    text: '只写过一些简单的管理后台页面，复杂交互没怎么碰。' },
]

const RAW_TEXT = SEGMENTS.map((s) => `[${s.start}-${s.end}] ${s.label}: ${s.text}`).join('\n')

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('需要环境变量 RECRUITMENT_DB_PASSWORD（密码不写进任何文件）')
  process.exit(2)
}

const pool = new pg.Pool({
  host: '127.0.0.1', port: 5432, user: 'postgres', database: 'ra_s6s7',
  password, max: 2, application_name: 'evaluation-line-seed',
})

const client = await pool.connect()
let failed = false
try {
  await client.query('begin')
  await client.query("select set_config('recruitment.actor_id', $1, true)", [ACTOR_HR])

  // 1) 演示身份（两个隔离的 HUMAN 面试官 + 一个非人类 actor，用于负例）
  const actors = [
    [ACTOR_X, '演示-面试官X', 'HUMAN'],
    [ACTOR_Y, '演示-面试官Y', 'HUMAN'],
    [ACTOR_AGENT, '演示-评价Agent（非人类）', 'AGENT_WORKER'],
  ]
  for (const [id, displayName, kind] of actors) {
    await client.query(`insert into recruitment.actor (id, tenant_id, kind, display_name)
      values ($1, $2, $3, $4) on conflict (id) do update set display_name = excluded.display_name`, [
      id, TENANT, kind, displayName,
    ])
  }

  // 2) 申请必须钉住 rubric v1（面评分项来源），否则面评会 RUBRIC_UNRESOLVED
  const { rows: appRows } = await client.query(
    'select rubric_version_id, job_id from recruitment.application where id = $1 and tenant_id = $2',
    [APPLICATION, TENANT],
  )
  if (appRows.length === 0) throw new Error(`application ${APPLICATION} 不存在`)
  if (appRows[0].rubric_version_id === null) {
    await client.query('update recruitment.application set rubric_version_id = $2 where id = $1', [APPLICATION, RUBRIC_V1])
  } else if (appRows[0].rubric_version_id !== RUBRIC_V1) {
    throw new Error(`application 钉住的 rubric 不是 v1（${appRows[0].rubric_version_id}），本演示脚本不覆盖已有钉版`)
  }

  // 3) 面试（S8 语义：一轮一场，POST_INTERVIEW）
  await client.query(`insert into recruitment.interview
      (id, tenant_id, application_id, round_no, slot_code, stage_code, status,
       scheduled_start_at, scheduled_end_at, timezone)
      values ($1, $2, $3, 1, 'DEFAULT', 'S8', 'POST_INTERVIEW',
              timestamptz '2026-11-12 14:00:00+08', timestamptz '2026-11-12 15:00:00+08', 'Asia/Shanghai')
      on conflict (id) do nothing`, [INTERVIEW, TENANT, APPLICATION])

  // 4) 面试官登记：X/Y 必交（逾期时间早于 as_of），Agent 旁听且不要求面评
  const interviewers = [
    [ACTOR_X, 'INTERVIEWER', true, '2026-11-12 12:00:00+08'],
    [ACTOR_Y, 'INTERVIEWER', true, '2026-11-12 12:00:00+08'],
    [ACTOR_AGENT, 'OBSERVER', false, null],
  ]
  for (const [actorId, role, required, due] of interviewers) {
    await client.query(`insert into recruitment.interviewer
        (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard, scorecard_due_at)
        values ($1, $2, $3, $4, $5, $6::timestamptz)
        on conflict (interview_id, actor_id) do update
          set role_in_interview = excluded.role_in_interview,
              required_scorecard = excluded.required_scorecard,
              scorecard_due_at = excluded.scorecard_due_at`, [
      TENANT, INTERVIEW, actorId, role, required, due,
    ])
  }

  // 5) 会议 + 绑定（人工绑定，MANUAL）
  await client.query(`insert into recruitment.meeting
      (id, tenant_id, provider, account_scope, external_meeting_id, meeting_role, actual_start_at, actual_end_at)
      values ($1, $2, 'manual_import', 'local-demo', 'manual-demo-2026-11-12', 'PRIMARY',
              timestamptz '2026-11-12 14:00:00+08', timestamptz '2026-11-12 15:01:00+08')
      on conflict (id) do nothing`, [MEETING, TENANT])
  const { rows: bindRows } = await client.query(
    'select id from recruitment.meeting_binding where interview_id = $1 and meeting_id = $2 and unbound_at is null',
    [INTERVIEW, MEETING],
  )
  if (bindRows.length === 0) {
    await client.query(`insert into recruitment.meeting_binding
        (tenant_id, meeting_id, interview_id, binding_method, bound_by_actor_id)
        values ($1, $2, $3, 'MANUAL', $4)`, [TENANT, MEETING, INTERVIEW, ACTOR_HR])
  }

  // 6) 转写产物：人工导入、FIXTURE、NOT_CONNECTED、MANUAL、READY、canonical
  const { rows: shaRows } = await client.query(
    "select encode(sha256(convert_to($1, 'UTF8')), 'hex') as sha", [RAW_TEXT],
  )
  await client.query(`insert into recruitment.transcript_artifact
      (id, tenant_id, meeting_id, provider, provider_artifact_id, source_revision, variant_type, language,
       transcript_status, provenance, trigger_mode, connection_state, fetched_at, last_readback_at,
       content_sha256, page_count, has_more, is_complete, raw_text, is_canonical, canonical_selected_by_actor_id)
      values ($1, $2, $3, 'manual_import', 'manual-demo-transcript-1', 1, 'ORIGINAL', 'zh-CN',
              'READY', 'FIXTURE', 'MANUAL', 'NOT_CONNECTED', null, null,
              $4, 1, false, true, $5, true, $6)
      on conflict (id) do update
        set transcript_status = 'READY', is_complete = true, content_sha256 = excluded.content_sha256,
            raw_text = excluded.raw_text, is_canonical = true,
            canonical_selected_by_actor_id = excluded.canonical_selected_by_actor_id`, [
    ARTIFACT, TENANT, MEETING, shaRows[0].sha, RAW_TEXT, ACTOR_HR,
  ])
  for (const segment of SEGMENTS) {
    await client.query(`insert into recruitment.transcript_segment
        (tenant_id, artifact_id, provider_segment_id, sequence, speaker_ref, speaker_label,
         start_ms, end_ms, content_text)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        on conflict (artifact_id, sequence) do update
          set speaker_label = excluded.speaker_label, content_text = excluded.content_text,
              start_ms = excluded.start_ms, end_ms = excluded.end_ms`, [
      TENANT, ARTIFACT, `manual-${segment.seq}`, segment.seq, segment.speaker, segment.label,
      segment.start, segment.end, segment.text,
    ])
  }

  await client.query('commit')
  console.log(JSON.stringify({
    ok: true,
    tenant_id: TENANT,
    application_id: APPLICATION,
    interview_id: INTERVIEW,
    meeting_id: MEETING,
    transcript_artifact_id: ARTIFACT,
    rubric_version_id: RUBRIC_V1,
    actors: { hr: ACTOR_HR, interviewer_x: ACTOR_X, interviewer_y: ACTOR_Y, agent: ACTOR_AGENT },
    transcript_state: 'READY',
    note: 'S8/S9 侧夹具：人工导入转写 + 人工绑定会议；provenance=FIXTURE / connection=NOT_CONNECTED / trigger=MANUAL',
  }, null, 2))
} catch (error) {
  failed = true
  await client.query('rollback').catch(() => {})
  console.error('seed failed:', error?.message ?? String(error))
} finally {
  client.release()
  await pool.end()
}
process.exitCode = failed ? 1 : 0
