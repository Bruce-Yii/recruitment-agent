// 演示夹具（手工跑，不是迁移、不是测试）：给 demo 岗位加一版**已批准**的 Rubric v2。
//
// 为什么需要它：`0002_seed.sql` 只有 rubric v1，且没有 `approval` 行。
// 按 `job-rubric-rules.md` §4.2，没有审批行 = 未批准 = `NO_RUBRIC/NO_APPROVED_RUBRIC`，
// 所以种子数据下 S7 只能走到"拒绝执行"。为了让真实 headless 能跑出一个**真的 verdict**，
// 必须有一版通过 R-VAL-1..14 且被批准的标准。
//
// 它**不写** candidate / application / decision，只写 rubric_version + approval + 岗位的
// current_rubric_version_id 指针，因此不会掩盖 S6 的行为。
//
// 幂等：固定 UUID + `on conflict do nothing`；`payload_hash` 用**与工具同一份**
// `digestOf(canonicalJson(dimensions))` 算，保证 R-VAL-14 一定对得上。
//
// 用法：
//   $env:RECRUITMENT_DB_PASSWORD='123456'
//   node manual/apply-demo-rubric.mjs
import pg from 'pg'
import { digestOf } from '../src/tools/contract.ts'

const TENANT = '11111111-1111-4111-8111-000000000001'
const JOB = '11111111-1111-4111-8111-000000000401'
const RUBRIC_V2 = '11111111-1111-4111-8111-000000000404'
const APPROVAL = '11111111-1111-4111-8111-000000000801'
const HR_ACTOR = '11111111-1111-4111-8111-000000000103'

// 三条 criterion：两条机械型 MUST_HAVE + 一条判断型 NICE_TO_HAVE。
// weight 用二进制可精确表示的数，Σ=1 不会有 1e-16 级误差（R-VAL-6）。
const DIMENSIONS = [
  {
    key: 'work_exists',
    label: '简历中存在可分割的工作经历条目',
    kind: 'MUST_HAVE',
    weight: 0.5,
    field: 'work_experience',
    operator: 'EXISTS',
    value: true,
    notes: 'EXISTS 判的是 state=present（读到了），不是"这个人有工作经历"',
  },
  {
    key: 'edu_exists',
    label: '简历中存在可分割的教育经历条目',
    kind: 'MUST_HAVE',
    weight: 0.25,
    field: 'education',
    operator: 'EXISTS',
    value: true,
    notes: 'state=absent → MISSING；state=unreadable → UNREADABLE',
  },
  {
    key: 'team_lead',
    label: '有带团队经验',
    kind: 'NICE_TO_HAVE',
    weight: 0.25,
    question: '是否有 ≥1 年、≥3 人的直接带团队经历？',
    notes: '判断型：机器不判，只进 bonus_signals',
  },
]

const password = process.env.RECRUITMENT_DB_PASSWORD
if (password === undefined || password === '') {
  console.error('RECRUITMENT_DB_PASSWORD is required')
  process.exit(2)
}

const payloadHash = digestOf(DIMENSIONS)
const client = new pg.Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  database: 'ra_s6s7',
  password,
  application_name: 'dsh-recruitment-demo-fixture',
})

await client.connect()
try {
  await client.query('begin')
  const insertedRubric = await client.query(
    `insert into recruitment.rubric_version
       (id, tenant_id, job_id, version_no, dimensions, payload_hash, created_by_actor_id)
     values ($1, $2, $3, 2, $4::jsonb, $5, $6)
     on conflict (id) do nothing
     returning id`,
    [RUBRIC_V2, TENANT, JOB, JSON.stringify(DIMENSIONS), payloadHash, HR_ACTOR],
  )
  const insertedApproval = await client.query(
    `insert into recruitment.approval
       (id, tenant_id, resource_type, resource_id, resource_record_version,
        payload_schema_version, canonical_payload_hash, status,
        requested_by_actor_id, decision_by_actor_id, decided_at, reason)
     values ($1, $2, 'RUBRIC_VERSION', $3, 1, 1, $4, 'APPROVED', $5, $6, now(),
             '演示夹具：让 S7 能对一个已批准的标准做真实评估')
     on conflict (id) do nothing
     returning id`,
    [APPROVAL, TENANT, RUBRIC_V2, payloadHash, HR_ACTOR, HR_ACTOR],
  )
  // 岗位当前 rubric 指针（0004 加的列；本工具不依赖它，但保持与库内一致）
  await client.query(
    `update recruitment.job set current_rubric_version_id = $3
      where id = $1 and tenant_id = $2`,
    [JOB, TENANT, RUBRIC_V2],
  )
  await client.query('commit')
  console.log(JSON.stringify({
    rubric_version_id: RUBRIC_V2,
    approval_id: APPROVAL,
    payload_hash: payloadHash,
    rubric_inserted: insertedRubric.rowCount === 1,
    approval_inserted: insertedApproval.rowCount === 1,
  }, null, 2))
} catch (error) {
  await client.query('rollback')
  console.error('fixture failed:', error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
