#!/usr/bin/env node
// scripts/bootstrap-demo.mjs —— G5：干净库上的 demo 前置引导（只补"演示基线"，不改迁移）。
//
// 要解决的问题（现场事实）：全新库按名重放 db/migrations/0001..0015 后，`0002_seed.sql`
// 已插入演示岗位 DEMO-BE-001 + rubric v1，但**没有任何 approval 行**。按
// `contracts/job-screening/job-rubric-rules.md` §4.2，没有生效的 APPROVED = 未批准 =
// S7 `NO_APPROVED_RUBRIC`，所以干净库跑不了 demo（owner-g4 的 S6→S10 harness 预检同样 BLOCKED）。
//
// 本脚本的定位：**用产品工具链补齐 demo 前置**（不改 0002_seed、不加迁移）。它做五件事：
//   1. 只读预检：迁移台账版本、租户/actor（HUMAN + HR 角色）、按 code 找演示岗位；
//   2. 只读判定状态：NO_OP / APPROVE_PENDING / APPEND_RUBRIC / CREATE_JOB；
//   3. 非 NO_OP 时先过**一次**人机闸门替身（DEMO_APPROVAL_MODE），不是 allowed-once
//      就在**任何写之前**退出 3（零写入），之后写库只调产品工具 execute()；
//   4. 写后只读读回并核对：current 指针 == 目标 rubric、approval.status=APPROVED、
//      approval.canonical_payload_hash == rubric.payload_hash（未 supersede、未过期）。
//   5. **D5 W1 幂等演示种子**（`seed.demo_actors` / `seed.demo_interviews`）：在闸门之后、
//      幂等补齐「演示-面试官 B(…0105) + INTERVIEWER 角色」「Interview …0801/…0802 挂
//      application …0701」「802 上 A=104/B=105 两条 interviewer 行（required_scorecard=true）、
//      801 补 104」「802 上 103 无 interviewer 行（负例，只查不删）」。重跑零变更。
//
// 硬约束（与本文件的设计一一对应）：
//   * **业务写库只发生在产品工具的 execute() 里**：`recruitment_job_create` /
//     `recruitment_job_update` / `recruitment_job_rubric_approve`；
//     本脚本自己的读全部走 `db/pool.ts` 的 `withReadOnly()`（`begin transaction read only`，
//     库层强制只读，任何写语句会直接 25006）。
//     唯一例外是 §5 的演示种子：产品工具链里**没有**「建 actor / 授予角色 / 建固定 id 的
//     Interview / 写 interviewer 分配」的入口（interview-schedule 会自己生成 id 且带业务闸门），
//     所以种子用固定 id 的 `insert … on conflict do nothing` 直接写；它同样只在
//     闸门放行之后、单个 `withActor` 事务里执行（失败整体回滚），重跑 0 行变更。
//   * **密码只从环境变量读**：走产品 `resolveDatabaseConfig(config, env)`，密码既不在配置里，
//     也不进任何输出/异常（打印前统一 scrub）。
//   * **审批替身是唯一注入点**：`DEMO_APPROVAL_MODE` 只作为
//     `createJobRubricApproveTool(cfg, { approval })` 的 `deps.approval` 传入；
//     `deny` / `unavailable` 时替身返回 `rejected` / `unavailable`。
//
// demo rubric 口径来源：`dsh/dsh-recruitment/manual/apply-demo-rubric.mjs` 的 DIMENSIONS
// （三条 criteria：两条机械型 MUST_HAVE + 一条判断型 NICE_TO_HAVE）。本文件**内联**同一份口径
// 而不是 import 那个手写写库夹具——那个夹具由本脚本取代。
//
// 用法（仓库根，无必需参数）：
//   $env:RECRUITMENT_DB_PASSWORD='<本机口令>'; node scripts/bootstrap-demo.mjs
//   $env:DEMO_APPROVAL_MODE='deny'; node scripts/bootstrap-demo.mjs        # 负例：应 exit 3 且零写入
//
// 退出码：0 成功/NO_OP；1 其他失败（工具报错/读回不一致）；2 配置或迁移前置不满足；
//         3 审批被拒/不可用。
//
// 输出：逐步骤人读摘要 + 最后**一行** `BOOTSTRAP_RESULT: <单行 JSON>`（no-op/deny/失败同样输出）。
import {
  JOB_CREATE_TOOL,
  JOB_UPDATE_TOOL,
  createJobCreateTool,
  createJobUpdateTool,
} from '../dsh/dsh-recruitment/src/tools/job-create.ts'
import {
  JOB_RUBRIC_APPROVE_TOOL,
  createJobRubricApproveTool,
} from '../dsh/dsh-recruitment/src/tools/job-rubric-approve.ts'
import {
  closePool,
  createPool,
  resolveDatabaseConfig,
  withActor,
  withReadOnly,
} from '../dsh/dsh-recruitment/src/db/pool.ts'

const TOOL = 'bootstrap-demo'
/** 干净库至少要有这条迁移（按名重放 0001..0015）。 */
const REQUIRED_MIGRATION = '0015'
const DEFAULT_PASSWORD_ENV = 'RECRUITMENT_DB_PASSWORD'
const APPROVAL_MODES = ['allow-once', 'deny', 'unavailable']
/** seed 演示租户（0002_seed.sql）。 */
const DEMO_TENANT_ID = '11111111-1111-4111-8111-000000000001'
/** seed 演示 HR 专员（0002_seed.sql；kind=HUMAN，持有 HR_SPECIALIST 角色）。 */
const DEMO_ACTOR_ID = '11111111-1111-4111-8111-000000000103'
const DEMO_JOB_CODE = 'DEMO-BE-001'
const DEMO_JOB_TITLE = '后端工程师（演示）'
/** 批准是人的动作（D-79）：actor 必须是 HUMAN 且持有 HR 角色。 */
const REQUIRED_ACTOR_KIND = 'HUMAN'
const REQUIRED_ROLE_CODE = 'HR_SPECIALIST'
/** 闸门替身 request 的 reason（写明"人在放行 demo rubric"）。 */
const GATE_REASON = '演示引导：由人放行 demo rubric（bootstrap-demo 的人机闸门替身）'
/** 批准工具自己的 reason（≤500 字符）。 */
const APPROVE_REASON = '演示引导：为 demo 岗位放行已绑定 hash 的 rubric 版本'

// ---------------------------------------------------------------------------
//  D5 W1：固定 id 的演示种子（与 `work/d5/w1/CONTEXT.md` §1 一致；全部幂等）
// ---------------------------------------------------------------------------

/** 演示种子所在的租户（0002_seed）。 */
// （DEMO_TENANT_ID 已在上方定义，这里复用。）
/** 演示部门（0002_seed：研发部（演示））。 */
const DEMO_DEPARTMENT_ID = '11111111-1111-4111-8111-000000000010'
/** 演示面试官 B（本步补齐；HUMAN，display_name = 演示-面试官 B）。 */
const DEMO_INTERVIEWER_B_ID = '11111111-1111-4111-8111-000000000105'
/** 演示面试官 A（0002_seed 的 …0104）。 */
const DEMO_INTERVIEWER_A_ID = '11111111-1111-4111-8111-000000000104'
/** 演示 recruiter / HR 专员（0002_seed 的 …0103）——必须是 802 上的**未分配负例**。 */
const DEMO_RECRUITER_ID = '11111111-1111-4111-8111-000000000103'
/** 演示招聘负责人（0002_seed 的 …0102；role 授予的 granted_by）。 */
const DEMO_HIRING_MANAGER_ID = '11111111-1111-4111-8111-000000000102'
/** INTERVIEWER 角色（0002_seed 的 …0204）。 */
const DEMO_ROLE_INTERVIEWER_ID = '11111111-1111-4111-8111-000000000204'
/** …0105 的 INTERVIEWER 授予行 id（固定 id，幂等）。 */
const DEMO_ACTOR_ROLE_B_ID = '11111111-1111-4111-8111-000000000305'
/** 演示申请（0002_seed 的 …0701）。 */
const DEMO_APPLICATION_ID = '11111111-1111-4111-8111-000000000701'
/** 演示第 1 轮面试（已发生：POST_INTERVIEW）。 */
const DEMO_INTERVIEW_ROUND1_ID = '11111111-1111-4111-8111-000000000801'
/** 演示第 2 轮面试（已排期：SCHEDULED；A/B 各交一份面评的那一场）。 */
const DEMO_INTERVIEW_ROUND2_ID = '11111111-1111-4111-8111-000000000802'
/** 固定排期时间（UTC，与演示库 ra_s6s7 的 …0801/…0802 对齐）：重跑不漂移。 */
const DEMO_ROUND1_START = '2026-11-12T06:00:00.000Z' // 2026-11-12 14:00 +08
const DEMO_ROUND1_END = '2026-11-12T07:00:00.000Z'
const DEMO_ROUND2_START = '2026-11-20T06:00:00.000Z' // 2026-11-20 14:00 +08
const DEMO_ROUND2_END = '2026-11-20T07:00:00.000Z'
/** 面试所属阶段：`interview.stage_code` 有外键指向 `stage_catalog`，只能用目录里的 S8。 */
const DEMO_INTERVIEW_STAGE_CODE = 'S8'

/**
 * demo rubric 的三条 criteria（与 `manual/apply-demo-rubric.mjs` 的 DIMENSIONS 同口径）。
 * 键封闭在 9 键内；两条机械型 MUST_HAVE（work_experience/education EXISTS true）+ 一条判断型
 * NICE_TO_HAVE（question，机器不判）；weight 用二进制可精确表示的数，Σ 精确 = 1（R-VAL-6）。
 */
const DEMO_CRITERIA = [
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

/** CREATE_JOB 分支用的合成演示 JD（明确标注演示，不伪造真实招聘信息）。 */
const DEMO_JD = {
  description_md: '# 后端工程师（演示岗位）\n\n演示用 JD，非真实招聘信息'
    + '（bootstrap-demo 在缺演示岗位的库上补建它，仅用于跑通 S6→S10）。',
  requirements_md: '- 3 年以上后端开发经验（演示样例）\n- 熟悉 PostgreSQL 与消息队列（演示样例）',
}

// 只读 SQL：本脚本只会执行这三类 select（全部在 read only 事务里）。
const SQL_JOB_BY_CODE = `select id, code, title, status, current_rubric_version_id, record_version
   from recruitment.job
  where tenant_id = $1 and code = $2
  order by created_at, id`
const SQL_JOB_BY_ID = `select id, code, title, status, current_rubric_version_id, record_version
   from recruitment.job
  where tenant_id = $1 and id = $2`
const SQL_RUBRIC_BY_ID = `select id, version_no, payload_hash
   from recruitment.rubric_version
  where tenant_id = $1 and job_id = $2 and id = $3`
const SQL_LATEST_RUBRIC = `select id, version_no, payload_hash
   from recruitment.rubric_version
  where tenant_id = $1 and job_id = $2
  order by version_no desc
  limit 1`
const SQL_APPROVALS = `select id, status, payload_schema_version, canonical_payload_hash,
         decision_by_actor_id, decided_at, record_version, expires_at,
         superseded_by_approval_id, created_at
   from recruitment.approval
  where tenant_id = $1 and resource_type = 'RUBRIC_VERSION' and resource_id = $2
  order by created_at desc, id desc`
const SQL_MIGRATION_LATEST = `select max(version) as version from recruitment.schema_migration`
const SQL_ACTOR_ROLES = `select a.id, a.kind, a.tenant_id,
         coalesce(array_agg(r.code order by r.code) filter (where r.code is not null), '{}') as roles
   from recruitment.actor a
   left join recruitment.actor_role ar on ar.tenant_id = a.tenant_id and ar.actor_id = a.id
   left join recruitment.role r on r.tenant_id = a.tenant_id and r.id = ar.role_id
  where a.id = $1 and a.tenant_id = $2
  group by a.id, a.kind, a.tenant_id`

// ---- D5 W1 演示种子用到的读写 SQL（读在同一个写事务里；写全部幂等）----------------

/** 演示申请是否存在（种子前置；缺了就是迁移/种子没跑全，属配置前置不满足）。 */
const SQL_APPLICATION_EXISTS = `select id from recruitment.application
  where id = $1 and tenant_id = $2`

/** 演示面试官 B（…0105）是否存在。 */
const SQL_ACTOR_EXISTS = `select id, kind, display_name from recruitment.actor
  where id = $1 and tenant_id = $2`

/** 105 的 INTERVIEWER 角色是否已生效（授予后复核）。 */
const SQL_ACTOR_ROLE_ACTIVE = `select count(*)::int as n from recruitment.actor_role
  where tenant_id = $1 and actor_id = $2 and role_id = $3 and revoked_at is null`

/** 两个演示 Interview 是否存在（按固定 id）。 */
const SQL_INTERVIEW_BY_ID = `select id, status from recruitment.interview
  where id = $1 and tenant_id = $2`

/** 802 上 103 的 interviewer 行（负例：只查，绝不删）。 */
const SQL_INTERVIEWER_NEGATIVE = `select count(*)::int as n from recruitment.interviewer
  where tenant_id = $1 and interview_id = $2 and actor_id = $3`

/** 一条 interviewer 行是否已存在（用于区分 INSERTED / UPDATED；不看 required_scorecard 值）。 */
const SQL_INTERVIEWER_EXISTS = `select count(*)::int as n from recruitment.interviewer
  where tenant_id = $1 and interview_id = $2 and actor_id = $3`

const SQL_INSERT_ACTOR_105 = `insert into recruitment.actor
  (id, tenant_id, kind, display_name, primary_email, department_id)
  values ($1, $2, 'HUMAN', '演示-面试官 B', 'demo.interviewer.b@demo-recruitment.test', $3)
  on conflict do nothing
  returning id`

const SQL_INSERT_ACTOR_ROLE_105 = `insert into recruitment.actor_role
  (id, tenant_id, actor_id, role_id, granted_by_actor_id)
  values ($1, $2, $3, $4, $5)
  on conflict do nothing
  returning id`

const SQL_INSERT_INTERVIEW = `insert into recruitment.interview
  (id, tenant_id, application_id, round_no, slot_code, stage_code, status,
   scheduled_start_at, scheduled_end_at)
  values ($1, $2, $3, $4, 'DEFAULT', $5, $6, $7, $8)
  on conflict (id) do nothing
  returning id`

/**
 * 幂等 upsert 一条 interviewer 行：已存在且 `required_scorecard` 已是 true → **0 行变更**
 * （`where … is distinct from`），这样"重跑零变更"是 0 行 UPDATE 而不是"同样的值再写一遍"。
 */
const SQL_UPSERT_INTERVIEWER = `insert into recruitment.interviewer
  (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
  values ($1, $2, $3, 'INTERVIEWER', true)
  on conflict (interview_id, actor_id) do update
     set required_scorecard = excluded.required_scorecard
   where recruitment.interviewer.required_scorecard is distinct from excluded.required_scorecard
  returning id`

/** 「补 104 到 801（若不存在）」用：已存在就**一行都不改**（不覆盖他人已有行）。 */
const SQL_ENSURE_INTERVIEWER = `insert into recruitment.interviewer
  (tenant_id, interview_id, actor_id, role_in_interview, required_scorecard)
  values ($1, $2, $3, 'INTERVIEWER', true)
  on conflict (interview_id, actor_id) do nothing
  returning id`

/** 当前进程里已知的敏感值（打印前统一替换，绝不落进日志）。 */
const secrets = []

/**
 * 从环境变量读配置（密码只交给 `resolveDatabaseConfig`，本函数不碰它）。
 * @param env - 环境变量表。
 * @returns `{ config, mode, issues }`；`issues` 非空表示配置不满足。
 */
function readEnvConfig(env) {
  const issues = []
  const host = envText(env, 'RECRUITMENT_DB_HOST', '127.0.0.1')
  const user = envText(env, 'RECRUITMENT_DB_USER', 'postgres')
  const database = envText(env, 'RECRUITMENT_DB_NAME', 'ra_s6s7')
  const tenantId = envText(env, 'RECRUITMENT_TENANT_ID', DEMO_TENANT_ID)
  const actorId = envText(env, 'RECRUITMENT_ACTOR_ID', DEMO_ACTOR_ID)

  let port
  const portText = envText(env, 'RECRUITMENT_DB_PORT', '')
  if (portText !== '') {
    const parsed = Number(portText)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
      issues.push('RECRUITMENT_DB_PORT must be an integer in 1..65535')
    } else {
      port = parsed
    }
  }

  const mode = envText(env, 'DEMO_APPROVAL_MODE', 'allow-once')
  if (!APPROVAL_MODES.includes(mode)) {
    issues.push(`DEMO_APPROVAL_MODE must be one of ${APPROVAL_MODES.join('|')} (got ${JSON.stringify(mode)})`)
  }

  const config = {
    host,
    user,
    database,
    password_env: DEFAULT_PASSWORD_ENV,
    tenant_id: tenantId,
    actor_id: actorId,
    max: 2,
    // 默认 5432 照样显式给（与 resolveDatabaseConfig 的默认值一致；输出里不出现 null）。
    port: port ?? 5432,
  }
  return {
    config,
    mode,
    issues,
    jobCode: envText(env, 'DEMO_JOB_CODE', DEMO_JOB_CODE),
    jobTitle: envText(env, 'DEMO_JOB_TITLE', DEMO_JOB_TITLE),
  }
}

/**
 * 读一个非空环境变量；未设置或空白 → 默认值。
 * @param env - 环境变量表。
 * @param key - 变量名。
 * @param fallback - 默认值。
 */
function envText(env, key, fallback) {
  const raw = env[key]
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  return trimmed === '' ? fallback : trimmed
}

/**
 * 造审批替身（唯一注入点）。每次 request 都记一条，供 JSON 输出。
 * `allow-once` → 每次都 `allowed-once`（工具内部还会再走一次它自己的 seam，同一个注入点）；
 * `deny` → `rejected`；`unavailable` → `unavailable`。
 * @param mode - `DEMO_APPROVAL_MODE` 的取值。
 */
function createApprovalStub(mode) {
  const requests = []
  const approval = {
    async request(req) {
      const result = mode === 'deny' ? 'rejected' : mode === 'unavailable' ? 'unavailable' : 'allowed-once'
      requests.push({
        seq: requests.length + 1,
        tool_name: typeof req === 'object' && req !== null && typeof req.toolName === 'string' ? req.toolName : null,
        reason: typeof req === 'object' && req !== null && typeof req.reason === 'string' ? req.reason : null,
        result,
      })
      return result
    },
  }
  return { approval, requests }
}

/** `timestamptz` 列 → ISO 文本（null 原样返回）。 */
function isoOf(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : String(value)
}

/** 审批行归一化成输出用形状（列名保持库口径，时间为 ISO）。 */
function toApprovalRow(row) {
  return {
    approval_id: row.id,
    status: row.status,
    payload_schema_version: row.payload_schema_version,
    canonical_payload_hash: row.canonical_payload_hash,
    decided_by_actor_id: row.decision_by_actor_id ?? null,
    decided_at: isoOf(row.decided_at),
    record_version: row.record_version,
    expires_at: isoOf(row.expires_at),
    superseded_by_approval_id: row.superseded_by_approval_id ?? null,
  }
}

/**
 * 一个审批行此刻是否"生效的 APPROVED 且 hash 与 rubric 对齐"（与 approve 工具同一判据：
 * status=APPROVED、未 supersede、未过期、canonical_payload_hash == rubric.payload_hash）。
 * @param row - 归一化审批行。
 * @param rubric - 绑定的 rubric 版本行。
 * @param nowMs - 当前时刻（毫秒）。
 */
function isEffectiveApproved(row, rubric, nowMs) {
  if (row.status !== 'APPROVED') return false
  if (row.superseded_by_approval_id !== null) return false
  if (row.expires_at !== null) {
    const expires = Date.parse(row.expires_at)
    if (!Number.isFinite(expires) || expires <= nowMs) return false
  }
  return row.canonical_payload_hash === rubric.payload_hash
}

/**
 * 只读取一次库内事实（岗位 / current 指针指向的 rubric 及其审批 / 最新 rubric 及其审批）。
 * @param pool - 连接池。
 * @param cfg - 已解析配置。
 * @param code - 演示岗位 code。
 */
async function loadSnapshot(pool, cfg, code) {
  return withReadOnly(pool, async (client) => {
    const jobs = (await client.query(SQL_JOB_BY_CODE, [cfg.tenant_id, code])).rows
    const job = jobs[0] ?? null
    if (job === null) {
      return { job: null, job_count: jobs.length, pointer_rubric: null, pointer_approvals: [], latest_rubric: null, latest_approvals: [] }
    }
    let pointerRubric = null
    let pointerApprovals = []
    if (job.current_rubric_version_id !== null) {
      pointerRubric = (await client.query(SQL_RUBRIC_BY_ID, [
        cfg.tenant_id, job.id, job.current_rubric_version_id,
      ])).rows[0] ?? null
      if (pointerRubric !== null) {
        pointerApprovals = (await client.query(SQL_APPROVALS, [cfg.tenant_id, pointerRubric.id]))
          .rows.map(toApprovalRow)
      }
    }
    const latestRubric = (await client.query(SQL_LATEST_RUBRIC, [cfg.tenant_id, job.id])).rows[0] ?? null
    const latestApprovals = latestRubric !== null && (pointerRubric === null || latestRubric.id !== pointerRubric.id)
      ? (await client.query(SQL_APPROVALS, [cfg.tenant_id, latestRubric.id])).rows.map(toApprovalRow)
      : pointerApprovals
    return {
      job: {
        id: job.id,
        code: job.code,
        title: job.title,
        status: job.status,
        current_rubric_version_id: job.current_rubric_version_id,
        record_version: job.record_version,
      },
      job_count: jobs.length,
      pointer_rubric: pointerRubric,
      pointer_approvals: pointerApprovals,
      latest_rubric: latestRubric,
      latest_approvals: latestApprovals,
    }
  })
}

/**
 * 复核读回：job + 目标 rubric + 该 rubric 的全部审批行（**独立于工具返回值**）。
 * @param pool - 连接池。
 * @param cfg - 已解析配置。
 * @param jobId - 岗位 id。
 * @param rubricId - 目标 rubric 版本 id。
 */
async function readbackTarget(pool, cfg, jobId, rubricId) {
  return withReadOnly(pool, async (client) => {
    const job = (await client.query(SQL_JOB_BY_ID, [cfg.tenant_id, jobId])).rows[0] ?? null
    if (job === null) return { job: null, rubric: null, approvals: [] }
    const rubric = (await client.query(SQL_RUBRIC_BY_ID, [cfg.tenant_id, jobId, rubricId])).rows[0] ?? null
    const approvals = rubric === null
      ? []
      : (await client.query(SQL_APPROVALS, [cfg.tenant_id, rubric.id])).rows.map(toApprovalRow)
    return {
      job: {
        id: job.id,
        code: job.code,
        title: job.title,
        status: job.status,
        current_rubric_version_id: job.current_rubric_version_id,
        record_version: job.record_version,
      },
      rubric,
      approvals,
    }
  })
}

/**
 * 状态判定（**全部只读**）：与 approve 工具的 NO_OP 判据同源，避免"工具会 NO_OP、脚本却想写"。
 * @param snapshot - `loadSnapshot()` 的返回。
 * @param nowMs - 当前时刻（毫秒）。
 * @returns `{ state, target }`；`state ∈ NO_OP|APPROVE_PENDING|APPEND_RUBRIC|CREATE_JOB`。
 */
function decideState(snapshot, nowMs) {
  if (snapshot.job === null) return { state: 'CREATE_JOB', target: null }
  const pointerRubric = snapshot.pointer_rubric
  if (snapshot.job.current_rubric_version_id !== null
    && pointerRubric !== null
    && snapshot.pointer_approvals.some((row) => isEffectiveApproved(row, pointerRubric, nowMs))) {
    return { state: 'NO_OP', target: pointerRubric }
  }
  const latest = snapshot.latest_rubric
  if (latest !== null) {
    const pending = snapshot.latest_approvals.filter((row) => row.status === 'PENDING'
      && row.payload_schema_version === 1
      && row.canonical_payload_hash === latest.payload_hash)
    if (pending.length > 0) return { state: 'APPROVE_PENDING', target: latest }
  }
  return { state: 'APPEND_RUBRIC', target: null }
}

/** 从快照里挑"最该展示的审批行"（生效 APPROVED > 待批 > 最新一行）。 */
function pickApproval(approvals, rubric, nowMs) {
  if (approvals.length === 0) return null
  const effective = approvals.find((row) => isEffectiveApproved(row, rubric, nowMs))
  if (effective !== undefined) return effective
  const pending = approvals.find((row) => row.status === 'PENDING')
  return pending ?? approvals[0]
}

/** 把一个可打印值 scrub 掉已知敏感值。 */
function scrub(value) {
  let text = typeof value === 'string' ? value : String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret !== '') {
      text = text.split(secret).join('***')
    }
  }
  return text
}

/** 异常 → `{ name, message, code }`（不含 stack，避免把连接细节带进日志）。 */
function errorInfo(error) {
  const err = error instanceof Error ? error : new Error(String(error))
  const code = typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : null
  return { name: err.name, message: scrub(err.message), code }
}

/** 前置不满足（配置/迁移/身份）：由 `run()` 转成 outcome=FAILED、exit 2。 */
class PrerequisiteError extends Error {
  constructor(issues) {
    super(issues.join('; '))
    this.name = 'PrerequisiteError'
    this.issues = issues
  }
}

/**
 * 迁移台账预检：最新版本 ≥ 0015（`0015_runtime_cutover`）。
 * @param pool - 连接池。
 */
async function preflightMigration(pool) {
  let latest
  try {
    latest = await withReadOnly(pool, async (client) => {
      const row = (await client.query(SQL_MIGRATION_LATEST)).rows[0]
      return row === undefined || row.version === null ? null : String(row.version)
    })
  } catch (error) {
    const info = errorInfo(error)
    if (info.code === '42P01') {
      throw new PrerequisiteError([
        'recruitment.schema_migration 不存在：先按名排序重放 db/migrations/0001..0015',
      ])
    }
    throw new PrerequisiteError([`迁移预检读库失败：${info.message}`])
  }
  const prefix = latest === null ? 0 : Number(latest.slice(0, 4))
  const ok = Number.isInteger(prefix) && prefix >= Number(REQUIRED_MIGRATION)
  if (!ok) {
    throw new PrerequisiteError([
      `迁移台账最新版本是 ${latest === null ? '（空）' : latest}，`
        + `本脚本要求 ≥ ${REQUIRED_MIGRATION}：先按名排序重放 db/migrations/0001..0015`,
    ])
  }
  return { latest, required: REQUIRED_MIGRATION, ok }
}

/**
 * 身份预检：actor 属于本租户、kind=HUMAN、持有 HR 角色（D-79：批准是人的动作）。
 * @param pool - 连接池。
 * @param cfg - 已解析配置。
 */
async function preflightActor(pool, cfg) {
  const row = await withReadOnly(pool, async (client) => {
    const rows = (await client.query(SQL_ACTOR_ROLES, [cfg.actor_id, cfg.tenant_id])).rows
    return rows[0] ?? null
  })
  if (row === null) {
    throw new PrerequisiteError([
      `actor ${cfg.actor_id} 不存在或不属于租户 ${cfg.tenant_id}（RECRUITMENT_ACTOR_ID / RECRUITMENT_TENANT_ID）`,
    ])
  }
  const roles = Array.isArray(row.roles) ? row.roles.map((code) => String(code)) : []
  const issues = []
  if (row.kind !== REQUIRED_ACTOR_KIND) {
    issues.push(`actor ${cfg.actor_id} 的 kind 是 ${row.kind}，rubric 批准只允许 ${REQUIRED_ACTOR_KIND}（D-79）`)
  }
  if (!roles.includes(REQUIRED_ROLE_CODE)) {
    issues.push(`actor ${cfg.actor_id} 没有 ${REQUIRED_ROLE_CODE} 角色（现有：${roles.join(',') || '无'}）`)
  }
  if (issues.length > 0) throw new PrerequisiteError(issues)
  return { actor_id: cfg.actor_id, kind: row.kind, roles, ok: true }
}

/**
 * D5 W1 幂等演示种子（`seed.demo_actors` / `seed.demo_interviews`）。
 *
 * 口径（`work/d5/w1/CONTEXT.md` §1、`work/d5/ACTOR-CONTRACT.md` §5）：
 *   * 105 = HUMAN「演示-面试官 B」+ INTERVIEWER 角色（`…0204` 授予 `…0105`，granted_by `…0102`）；
 *   * `…0801`（round 1 / POST_INTERVIEW）/ `…0802`（round 2 / SCHEDULED）挂在 application `…0701`；
 *   * 802 上 A=`…0104`、B=`…0105` 两条 interviewer 行（`required_scorecard=true`，upsert 收敛）；
 *   * 801 补 `…0104`（若不存在；存在即不动）；
 *   * 802 上 `…0103` 必须**没有** interviewer 行（未分配负例；只查不删，出现就记 issue）。
 *
 * 幂等：全部 `on conflict do nothing` / `do update … where 值真的不同`，重跑 **0 行变更**；
 * 只有真的 INSERT/UPDATE 时才把步骤名写进 `report.write_steps`。
 * 调用位置：`run()` 里**闸门放行之后**（deny 路径在此之前已返回 3），单事务执行；
 * 任何一步失败整体回滚，不会留下半个种子。
 * @param pool - 连接池。
 * @param cfg - 已解析配置（tenant / actor 只从这里来）。
 * @returns `{ demo_actor, demo_interviews, negative, write_steps, issues, written }`。
 */
async function seedDemoData(pool, cfg) {
  const tenantId = cfg.tenant_id
  const report = {
    demo_actor: null,
    demo_interviews: null,
    negative: null,
    write_steps: [],
    issues: [],
  }
  await withActor(pool, cfg.actor_id, async (client) => {
    // ---- 0 前置：演示申请必须存在（0002_seed）----
    const application = await client.query(SQL_APPLICATION_EXISTS, [DEMO_APPLICATION_ID, tenantId])
    if (application.rows.length === 0) {
      throw new PrerequisiteError([
        `演示申请 ${DEMO_APPLICATION_ID} 不存在：先按名重放 db/migrations（含 0002_seed）`,
      ])
    }

    // ---- 1 seed.demo_actors：105（HUMAN）+ INTERVIEWER 角色 ----
    const existingActor = await client.query(SQL_ACTOR_EXISTS, [DEMO_INTERVIEWER_B_ID, tenantId])
    const actorInsert = await client.query(SQL_INSERT_ACTOR_105, [
      DEMO_INTERVIEWER_B_ID, tenantId, DEMO_DEPARTMENT_ID,
    ])
    const actorInserted = (actorInsert.rowCount ?? 0) > 0
    const roleInsert = await client.query(SQL_INSERT_ACTOR_ROLE_105, [
      DEMO_ACTOR_ROLE_B_ID, tenantId, DEMO_INTERVIEWER_B_ID, DEMO_ROLE_INTERVIEWER_ID, DEMO_HIRING_MANAGER_ID,
    ])
    const roleInserted = (roleInsert.rowCount ?? 0) > 0
    // 授予后复核：INSERT 被"别的唯一键"吞掉时要能被看见，不能静默当成功。
    const roleActive = await client.query(SQL_ACTOR_ROLE_ACTIVE, [
      tenantId, DEMO_INTERVIEWER_B_ID, DEMO_ROLE_INTERVIEWER_ID,
    ])
    if ((roleActive.rows[0]?.n ?? 0) === 0) {
      throw new Error('seed.demo_actors: 授予后复核失败（105 仍没有生效的 INTERVIEWER 角色）')
    }
    // 105 已存在时**不修改**已有 display_name；输出里记录库里真实值以便对账。
    const actorRow = existingActor.rows[0] ?? { kind: 'HUMAN', display_name: '演示-面试官 B' }
    report.demo_actor = {
      actor_id: DEMO_INTERVIEWER_B_ID,
      actor: actorInserted ? 'INSERTED' : 'PRESENT',
      kind: actorRow.kind,
      display_name: actorRow.display_name,
      actor_role_id: DEMO_ACTOR_ROLE_B_ID,
      actor_role: roleInserted ? 'GRANTED' : 'PRESENT',
      role_code: 'INTERVIEWER',
      verified: true,
    }
    if (actorInserted || roleInserted) report.write_steps.push('seed.demo_actors')

    // ---- 2 seed.demo_interviews：801 / 802 挂 0701（固定 id；已存在不改）----
    const interviews = []
    for (const spec of [
      {
        id: DEMO_INTERVIEW_ROUND1_ID, round: 1, status: 'POST_INTERVIEW',
        start: DEMO_ROUND1_START, end: DEMO_ROUND1_END,
      },
      {
        id: DEMO_INTERVIEW_ROUND2_ID, round: 2, status: 'SCHEDULED',
        start: DEMO_ROUND2_START, end: DEMO_ROUND2_END,
      },
    ]) {
      const existing = await client.query(SQL_INTERVIEW_BY_ID, [spec.id, tenantId])
      if (existing.rows.length > 0) {
        // 已存在：保留库里的现状（不把别人的状态/排期改回去）。
        interviews.push({
          interview_id: spec.id, round_no: spec.round, state: 'PRESENT', status: existing.rows[0].status,
        })
        continue
      }
      const inserted = await client.query(SQL_INSERT_INTERVIEW, [
        spec.id, tenantId, DEMO_APPLICATION_ID, spec.round, DEMO_INTERVIEW_STAGE_CODE, spec.status, spec.start, spec.end,
      ])
      interviews.push({
        interview_id: spec.id,
        round_no: spec.round,
        state: (inserted.rowCount ?? 0) > 0 ? 'INSERTED' : 'PRESENT',
        status: spec.status,
      })
      if ((inserted.rowCount ?? 0) > 0) report.write_steps.push('seed.demo_interviews')
    }

    // ---- 3 802：A/B 两条 interviewer 行（upsert 收敛；已是 true 则 0 行变更）----
    const interviewers = []
    for (const actorId of [DEMO_INTERVIEWER_A_ID, DEMO_INTERVIEWER_B_ID]) {
      const before = await client.query(SQL_INTERVIEWER_EXISTS, [
        tenantId, DEMO_INTERVIEW_ROUND2_ID, actorId,
      ])
      const upserted = await client.query(SQL_UPSERT_INTERVIEWER, [
        tenantId, DEMO_INTERVIEW_ROUND2_ID, actorId,
      ])
      const changed = (upserted.rowCount ?? 0) > 0
      const state = changed ? ((before.rows[0]?.n ?? 0) > 0 ? 'UPDATED' : 'INSERTED') : 'PRESENT'
      interviewers.push({
        interview_id: DEMO_INTERVIEW_ROUND2_ID, actor_id: actorId, required_scorecard: true, state,
      })
      if (changed) report.write_steps.push('seed.demo_interviews')
    }
    // ---- 4 801 补 104（若不存在；存在即 0 行变更）----
    const round1Interviewer = await client.query(SQL_ENSURE_INTERVIEWER, [
      tenantId, DEMO_INTERVIEW_ROUND1_ID, DEMO_INTERVIEWER_A_ID,
    ])
    interviewers.push({
      interview_id: DEMO_INTERVIEW_ROUND1_ID,
      actor_id: DEMO_INTERVIEWER_A_ID,
      required_scorecard: true,
      state: (round1Interviewer.rowCount ?? 0) > 0 ? 'INSERTED' : 'PRESENT',
    })
    if ((round1Interviewer.rowCount ?? 0) > 0) report.write_steps.push('seed.demo_interviews')

    // ---- 5 负例：802 上 103 不得有 interviewer 行（只查不删）----
    const negative = await client.query(SQL_INTERVIEWER_NEGATIVE, [
      tenantId, DEMO_INTERVIEW_ROUND2_ID, DEMO_RECRUITER_ID,
    ])
    const negativeCount = negative.rows[0]?.n ?? 0
    if (negativeCount > 0) {
      report.issues.push(
        `seed.demo_interviews: 802 上存在 ${negativeCount} 行 103 的 interviewer 分配（未分配负例要求 0 行）；`
          + '按约定不删任何数据，请人工确认演示库',
      )
    }
    report.negative = {
      interview_id: DEMO_INTERVIEW_ROUND2_ID,
      actor_id: DEMO_RECRUITER_ID,
      interviewer_rows: negativeCount,
      ok: negativeCount === 0,
    }
    report.demo_interviews = {
      application_id: DEMO_APPLICATION_ID,
      interviews,
      interviewers,
    }
  })
  report.write_steps = [...new Set(report.write_steps)]
  report.written = report.write_steps.length > 0
  return report
}

/**
 * 把演示种子的结果写进 steps（重跑时同样输出，用 `state=PRESENT` 证明"零变更"）。
 * @param addStep - `run()` 里的步骤登记函数。
 * @param seed - `seedDemoData()` 的返回。
 */
function addSeedSteps(addStep, seed) {
  const actor = seed.demo_actor
  addStep('seed.demo_actors', null,
    `actor_105=${actor.actor} kind=${actor.kind} display_name=${actor.display_name}`
      + ` actor_role_0305=${actor.actor_role} role=${actor.role_code} verified=${actor.verified}`,
    { ok: actor.verified === true })
  const interviews = seed.demo_interviews.interviews
    .map((row) => `${row.round_no}:${row.interview_id}(${row.state},status=${row.status})`)
    .join(' ')
  const interviewers = seed.demo_interviews.interviewers
    .map((row) => `${row.actor_id}@${row.interview_id}(${row.state},required=${row.required_scorecard})`)
    .join(' ')
  addStep('seed.demo_interviews', null,
    `application=${seed.demo_interviews.application_id} interviews=[${interviews}] interviewers=[${interviewers}]`,
    { ok: true })
  addStep('seed.demo_interviews.negative', null,
    `802 上 103 的 interviewer 行=${seed.negative.interviewer_rows}（要求 0，只查不删）ok=${seed.negative.ok}`,
    { ok: seed.negative.ok })
  for (const issue of seed.issues) addStep('seed.issue', null, issue, { ok: false })
}

/**
 * 组装 `BOOTSTRAP_RESULT` 的单行 JSON（所有键始终存在；拿不到的值用 null，不编造）。
 * @param input - 汇总字段。
 */
function makeResult(input) {
  const {
    cfg, config, tenantId, actorId, mode, outcome, exitCode, state,
    job, rubric, approval, approvalOutcome, pointer, gate, writes, steps,
    migration, actorInfo, issues, error, seed,
  } = input
  const database = cfg === null ? (config.database ?? null) : cfg.database
  return {
    tool: TOOL,
    outcome,
    exit_code: exitCode,
    state,
    database,
    database_host: cfg === null ? (config.host ?? null) : cfg.host,
    database_port: cfg === null ? (config.port ?? null) : cfg.port,
    database_user: cfg === null ? (config.user ?? null) : cfg.user,
    tenant_id: tenantId,
    actor_id: actorId,
    approval_mode: mode,
    job,
    rubric,
    approval: approval === null
      ? null
      : { ...approval, outcome: approvalOutcome },
    pointer,
    gate,
    writes,
    steps,
    // D5 W1 幂等演示种子快照（steps 里也有明细；配置失败/被拒路径为 null）。
    seed: seed ?? null,
    migration: migration ?? null,
    actor: actorInfo ?? null,
    ...(issues === undefined ? {} : { issues: [...issues] }),
    ...(error === undefined ? {} : { error }),
  }
}

/**
 * 打印人读摘要 + 最后一行机器可读 `BOOTSTRAP_RESULT`，并设置退出码。
 * @param result - `makeResult()` 的返回。
 * @param header - 首行（库/租户/actor/模式）。
 */
function emit(result, header) {
  const lines = [`${TOOL} · ${header}`]
  for (const step of result.steps) {
    const tool = step.tool === null ? '' : ` ${step.tool}`
    lines.push(`[${step.index}] ${step.step}${tool} | ${step.summary}`)
  }
  if (Array.isArray(result.issues) && result.issues.length > 0) {
    for (const issue of result.issues) lines.push(`issue: ${issue}`)
  }
  if (result.error !== undefined && result.error !== null) {
    lines.push(`error: ${result.error.name}: ${result.error.message}`)
  }
  lines.push(`outcome=${result.outcome} exit_code=${result.exit_code}`
    + ` writes=${result.writes.written ? result.writes.steps.join(',') : 'none (zero rows)'}`)
  process.stdout.write(`${lines.map((line) => scrub(line)).join('\n')}\n`)
  const json = JSON.stringify(result, (_key, value) => (typeof value === 'string' ? scrub(value) : value))
  process.stdout.write(`BOOTSTRAP_RESULT: ${json}\n`)
  process.exitCode = result.exit_code
}

/**
 * 主流程。返回 `{ result, header }`（不直接退出），由调用方统一 emit。
 * @param env - 环境变量表。
 */
async function run(env) {
  const { config, mode, issues: envIssues, jobCode, jobTitle } = readEnvConfig(env)
  const resolved = resolveDatabaseConfig(config, env)
  const issues = [...envIssues, ...resolved.issues]
  const tenantId = resolved.resolved === null ? String(config.tenant_id ?? '') : resolved.resolved.tenant_id
  const actorId = resolved.resolved === null ? String(config.actor_id ?? '') : resolved.resolved.actor_id
  const header = `database=${config.database} tenant=${tenantId} actor=${actorId} approval_mode=${mode}`

  const steps = []
  const writes = []
  const ctx = {
    steps,
    writes,
    gateRequests: [],
    gateRequested: false,
    gateResult: 'not-required',
    snapshot: null,
    jobCode,
    target: null,
    createValue: null,
    updateValue: null,
    approveValue: null,
    migration: null,
    actorInfo: null,
    seed: null,
    seedIssues: [],
  }
  const addStep = (step, tool, summary, fields = {}) => {
    const entry = { index: steps.length + 1, step, tool, summary, ...fields }
    steps.push(entry)
    return entry
  }

  if (issues.length > 0) {
    // 配置不满足：不建连、不读写、exit 2（密码只以**变量名**出现在 issues 里）。
    return {
      header,
      result: makeResult({
        cfg: null,
        config,
        tenantId,
        actorId,
        mode,
        outcome: 'FAILED',
        exitCode: 2,
        state: null,
        job: null,
        rubric: null,
        approval: null,
        approvalOutcome: null,
        pointer: { before: null, after: null, aligned: false },
        gate: { requested: false, result: 'not-required', requests: [] },
        writes: { written: false, steps: [] },
        steps,
        issues,
        error: { name: 'PrerequisiteError', message: '配置不满足（见 issues），未连接数据库、零写入' },
      }),
    }
  }
  const cfg = resolved.resolved
  secrets.push(cfg.password)

  let pool = null
  try {
    pool = createPool(cfg)

    // ---- 1 只读预检：迁移台账 + 身份 ----
    ctx.migration = await preflightMigration(pool)
    addStep('preflight.migration', null, `latest=${ctx.migration.latest} ok=true`, { ok: true })
    ctx.actorInfo = await preflightActor(pool, cfg)
    addStep('preflight.actor', null,
      `kind=${ctx.actorInfo.kind} roles=[${ctx.actorInfo.roles.join(',')}] ok=true`, { ok: true })

    // ---- 2 只读读取现状并判定状态 ----
    ctx.snapshot = await loadSnapshot(pool, cfg, jobCode)
    const before = ctx.snapshot.job === null ? null : ctx.snapshot.job.current_rubric_version_id
    const nowMs = Date.now()
    const decision = decideState(ctx.snapshot, nowMs)
    ctx.state = decision.state
    ctx.target = decision.target
    const snapshotJob = ctx.snapshot.job
    addStep('lookup.job', null,
      snapshotJob === null
        ? `code=${jobCode} found=false`
        : `code=${snapshotJob.code} found=true id=${snapshotJob.id} status=${snapshotJob.status}`
          + ` current_rubric_version_id=${snapshotJob.current_rubric_version_id ?? 'none'}`
          + ` record_version=${snapshotJob.record_version}`,
      { ok: true, job_count: ctx.snapshot.job_count })
    addStep('plan', null,
      `state=${ctx.state} target=${ctx.target === null ? 'pending-tool-result' : `${ctx.target.id} (v${ctx.target.version_no})`}`,
      { ok: true })

    // ---- 3 非 NO_OP：任何写之前先过闸门替身（只此一个注入点） ----
    const gate = createApprovalStub(mode)
    ctx.gate = gate
    if (ctx.state !== 'NO_OP') {
      ctx.gateRequested = true
      const first = await gate.approval.request({ toolName: JOB_RUBRIC_APPROVE_TOOL, reason: GATE_REASON })
      ctx.gateResult = first
      ctx.gateRequests = gate.requests
      addStep('gate.pre-write', JOB_RUBRIC_APPROVE_TOOL,
        `result=${first} (requests=${gate.requests.length})`, { ok: first === 'allowed-once' })
      if (first !== 'allowed-once') {
        // 被拒/不可用：不调用任何写工具 → 零写入。
        return {
          header,
          result: await finishReadOnlyOutcome({
            pool, cfg, tenantId, actorId, mode, ctx, before,
            outcome: 'DENIED', exitCode: 3,
          }),
        }
      }
    } else {
      addStep('gate.pre-write', null, 'skipped (state=NO_OP：不问人、零写入)', { ok: true })
    }

    // ---- 3.6 D5 W1 幂等演示种子（闸门之后；deny 已在上面返回 3，零写入）----
    ctx.seed = await seedDemoData(pool, cfg)
    addSeedSteps(addStep, ctx.seed)
    writes.push(...ctx.seed.write_steps)
    ctx.seedIssues = [...ctx.seed.issues]

    // ---- 3.5 纯重放：NO_OP 到此为止（不调任何工具、零写入、exit 0） ----
    if (ctx.state === 'NO_OP') {
      return {
        header,
        result: await finishReadOnlyOutcome({
          pool, cfg, tenantId, actorId, mode, ctx, before,
          outcome: 'NO_OP', exitCode: 0,
        }),
      }
    }

    // ---- 4 执行（写库只发生在产品工具的 execute() 里） ----
    let jobId = snapshotJob === null ? null : snapshotJob.id
    if (ctx.state === 'CREATE_JOB') {
      const createTool = createJobCreateTool(cfg)
      ctx.createValue = await createTool.execute({
        title: jobTitle,
        code: jobCode,
        status: 'OPEN',
        description_md: DEMO_JD.description_md,
        requirements_md: DEMO_JD.requirements_md,
        criteria: DEMO_CRITERIA,
      })
      jobId = readPath(ctx.createValue, ['job', 'id'])
      const rubricId = readPath(ctx.createValue, ['rubric', 'version_id'])
      if (typeof jobId !== 'string' || typeof rubricId !== 'string') {
        throw new Error(`${JOB_CREATE_TOOL} 返回缺 job.id / rubric.version_id：${JSON.stringify(ctx.createValue)}`)
      }
      writes.push(JOB_CREATE_TOOL)
      ctx.target = { id: rubricId, version_no: readPath(ctx.createValue, ['rubric', 'version_no']), payload_hash: readPath(ctx.createValue, ['rubric', 'payload_hash']) }
      addStep('tool.job_create', JOB_CREATE_TOOL,
        `outcome=${readPath(ctx.createValue, ['outcome'])} job.id=${jobId}`
          + ` rubric.version_id=${rubricId} rubric.version_no=${ctx.target.version_no}`
          + ` rubric.payload_hash=${ctx.target.payload_hash}`
          + ` approval.status=${readPath(ctx.createValue, ['rubric', 'approval', 'status']) ?? 'none'}`,
        { ok: true })
    } else if (ctx.state === 'APPEND_RUBRIC') {
      const updateTool = createJobUpdateTool(cfg)
      ctx.updateValue = await updateTool.execute({ job_id: jobId, criteria: DEMO_CRITERIA })
      const outcome = readPath(ctx.updateValue, ['outcome'])
      const rubricId = readPath(ctx.updateValue, ['rubric', 'version_id'])
      if (typeof rubricId !== 'string') {
        throw new Error(`${JOB_UPDATE_TOOL} 返回缺 rubric.version_id（criteria 未生效）：${JSON.stringify(ctx.updateValue)}`)
      }
      if (outcome === 'UPDATED') writes.push(JOB_UPDATE_TOOL)
      ctx.target = {
        id: rubricId,
        version_no: readPath(ctx.updateValue, ['rubric', 'version_no']),
        payload_hash: readPath(ctx.updateValue, ['rubric', 'payload_hash']),
      }
      addStep('tool.job_update', JOB_UPDATE_TOOL,
        `outcome=${outcome} rubric.version_id=${rubricId} rubric.version_no=${ctx.target.version_no}`
          + ` rubric.payload_hash=${ctx.target.payload_hash}`
          + ` rubric.is_approved=${readPath(ctx.updateValue, ['rubric', 'is_approved'])}`
          + ` approval.status=${readPath(ctx.updateValue, ['rubric', 'approval', 'status']) ?? 'none'}`,
        { ok: true })
    } else {
      ctx.target = ctx.snapshot.latest_rubric
      addStep('plan.target', null,
        `state=APPROVE_PENDING 复用待批 rubric v${ctx.target.version_no} id=${ctx.target.id}`, { ok: true })
    }

    const targetId = ctx.target === null ? null : ctx.target.id
    if (typeof targetId !== 'string') throw new Error('内部错误：没有可批准的目标 rubric 版本')

    // ---- 5 产品批准入口（同一个替身作为 deps.approval；工具内部会再走一次自己的 seam） ----
    const approveTool = createJobRubricApproveTool(cfg, { approval: gate.approval })
    ctx.approveValue = await approveTool.execute({
      job_id: jobId,
      rubric_version_id: targetId,
      reason: APPROVE_REASON,
    })
    if (readPath(ctx.approveValue, ['changes', 'written']) === true) writes.push(JOB_RUBRIC_APPROVE_TOOL)
    ctx.gateRequests = gate.requests
    const gateToolRequest = gate.requests.length >= 2 ? gate.requests[1] : null
    if (gateToolRequest !== null) {
      addStep('gate.tool', JOB_RUBRIC_APPROVE_TOOL,
        `result=${gateToolRequest.result} (requests=${gate.requests.length})`, { ok: gateToolRequest.result === 'allowed-once' })
    }
    const previousPointer = readPath(ctx.approveValue, ['job', 'previous_current_rubric_version_id'])
    addStep('tool.rubric_approve', JOB_RUBRIC_APPROVE_TOOL,
      `outcome=${readPath(ctx.approveValue, ['outcome'])} replayed=${readPath(ctx.approveValue, ['replayed'])}`
        + ` approval.approval_id=${readPath(ctx.approveValue, ['approval', 'approval_id'])}`
        + ` approval.status=${readPath(ctx.approveValue, ['approval', 'status'])}`
        + ` approval.canonical_payload_hash=${readPath(ctx.approveValue, ['approval', 'canonical_payload_hash'])}`
        + ` current_rubric_version_id=${previousPointer ?? before ?? 'none'}->${readPath(ctx.approveValue, ['job', 'current_rubric_version_id'])}`,
      { ok: true })

    // ---- 6 写后只读读回 + 一致性核对 ----
    const readback = await readbackTarget(pool, cfg, jobId, targetId)
    const alignment = verifyAlignment(readback, targetId, nowMs)
    addStep('readback', null,
      `job.current_rubric_version_id=${readback.job === null ? 'none' : readback.job.current_rubric_version_id}`
        + ` target=${targetId} pointer_ok=${alignment.pointer_ok}`
        + ` approval.status=${alignment.approval === null ? 'none' : alignment.approval.status}`
        + ` hash_match=${alignment.hash_match} effective=${alignment.effective}`
        + ` ok=${alignment.ok}`,
      { ok: alignment.ok })

    const outcome = alignment.ok ? 'BOOTSTRAPPED' : 'FAILED'
    const exitCode = alignment.ok ? 0 : 1
    const resultIssues = [...ctx.seedIssues]
    if (!alignment.ok) {
      resultIssues.push(
        `读回不一致：pointer_ok=${alignment.pointer_ok} approval_effective=${alignment.effective}`
          + ` hash_match=${alignment.hash_match}`,
      )
    }
    return {
      header,
      result: makeResult({
        cfg,
        config,
        tenantId,
        actorId,
        mode,
        outcome,
        exitCode,
        state: ctx.state,
        job: readback.job === null ? null : {
          ...readback.job,
          ref: `recruitment.job/${readback.job.code}`,
        },
        rubric: readback.rubric === null ? null : {
          version_id: readback.rubric.id,
          version_no: readback.rubric.version_no,
          payload_hash: readback.rubric.payload_hash,
          ref: `recruitment.rubric_version/v${readback.rubric.version_no}`,
        },
        approval: alignment.approval,
        approvalOutcome: readPath(ctx.approveValue, ['outcome']) ?? null,
        pointer: {
          before,
          after: readback.job === null ? null : readback.job.current_rubric_version_id,
          aligned: alignment.pointer_ok,
        },
        gate: gateBlock(ctx),
        writes: { written: writes.length > 0, steps: [...writes] },
        steps,
        seed: ctx.seed,
        migration: ctx.migration,
        actorInfo: ctx.actorInfo,
        ...(resultIssues.length === 0 ? {} : { issues: resultIssues }),
      }),
    }
  } catch (error) {
    const info = errorInfo(error)
    // 连接/密码/库不存在等按"配置前置不满足"归 exit 2；其余按 1。
    const prerequisiteCodes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '28P01', '3D000', '42P01'])
    const isPrerequisite = error instanceof PrerequisiteError || (info.code !== null && prerequisiteCodes.has(info.code))
    const issues = [
      ...(error instanceof PrerequisiteError ? error.issues : []),
      ...(ctx.seedIssues ?? []),
    ]
    const errorResult = makeResult({
      cfg,
      config,
      tenantId,
      actorId,
      mode,
      outcome: 'FAILED',
      exitCode: isPrerequisite ? 2 : 1,
      state: ctx.state ?? null,
      job: null,
      rubric: null,
      approval: null,
      approvalOutcome: null,
      pointer: { before: ctx.snapshot?.job?.current_rubric_version_id ?? null, after: null, aligned: false },
      gate: gateBlock(ctx),
      writes: { written: writes.length > 0, steps: [...writes] },
      steps,
      seed: ctx.seed,
      migration: ctx.migration,
      actorInfo: ctx.actorInfo,
      ...(issues.length === 0 ? {} : { issues }),
      error: info,
    })
    return { header, result: errorResult }
  } finally {
    if (pool !== null) await closePool(pool)
  }
}

/**
 * 读回一致性核对（**不看工具返回值，只看库**）。
 * @param readback - `readbackTarget()` 的返回。
 * @param targetId - 目标 rubric 版本 id。
 * @param nowMs - 当前时刻（毫秒）。
 */
function verifyAlignment(readback, targetId, nowMs) {
  const rubric = readback.rubric
  const pointerOk = readback.job !== null && readback.job.current_rubric_version_id === targetId && rubric !== null
  let approval = null
  let hashMatch = false
  let effective = false
  if (rubric !== null) {
    approval = readback.approvals.find((row) => isEffectiveApproved(row, rubric, nowMs)) ?? null
    hashMatch = readback.approvals.some((row) => row.status === 'APPROVED'
      && row.canonical_payload_hash === rubric.payload_hash)
    effective = approval !== null
  }
  return {
    pointer_ok: pointerOk,
    hash_match: hashMatch,
    effective,
    approval,
    ok: pointerOk && approval !== null && hashMatch,
  }
}

/**
 * DENIED / NO_OP 等"未写成功"分支：只读读回当前事实，填 `status` 等输出字段。
 * @param input - 上下文。
 */
async function finishReadOnlyOutcome(input) {
  const { pool, cfg, tenantId, actorId, mode, ctx, before, outcome, exitCode } = input
  const snapshot = await loadSnapshot(pool, cfg, ctx.jobCode)
  const job = snapshot.job
  const showRubric = snapshot.pointer_rubric ?? snapshot.latest_rubric
  const nowMs = Date.now()
  const approval = showRubric === null
    ? null
    : pickApproval(
      snapshot.pointer_rubric !== null && showRubric.id === snapshot.pointer_rubric.id
        ? snapshot.pointer_approvals
        : snapshot.latest_approvals,
      showRubric,
      nowMs,
    )
  const after = job === null ? null : job.current_rubric_version_id
  // aligned 的判据与写后读回一致：指针指向它 **且** 它是生效的已批准版本（未批准 = 未对齐）。
  const aligned = after !== null
    && showRubric !== null
    && after === showRubric.id
    && approval !== null
    && isEffectiveApproved(approval, showRubric, nowMs)
  return makeResult({
    cfg,
    config: { database: cfg.database, host: cfg.host, port: cfg.port, user: cfg.user },
    tenantId,
    actorId,
    mode,
    outcome,
    exitCode,
    state: ctx.state,
    job: job === null ? null : { ...job, ref: `recruitment.job/${job.code}` },
    rubric: showRubric === null ? null : {
      version_id: showRubric.id,
      version_no: showRubric.version_no,
      payload_hash: showRubric.payload_hash,
      ref: `recruitment.rubric_version/v${showRubric.version_no}`,
    },
    approval,
    approvalOutcome: outcome === 'NO_OP' ? 'NO_OP' : 'NOT_DECIDED',
    pointer: {
      before,
      after,
      aligned,
    },
    gate: gateBlock(ctx),
    writes: { written: ctx.writes.length > 0, steps: [...ctx.writes] },
    steps: ctx.steps,
    seed: ctx.seed ?? null,
    migration: ctx.migration,
    actorInfo: ctx.actorInfo,
    ...(ctx.seedIssues.length === 0 ? {} : { issues: [...ctx.seedIssues] }),
  })
}

/** gate 输出块（requested/result/requests）。 */
function gateBlock(ctx) {
  return {
    requested: ctx.gateRequested === true,
    result: ctx.gateResult ?? 'not-required',
    requests: ctx.gate?.requests ?? [],
  }
}

/** 从工具返回值里按路径读一个值（缺失返回 undefined，不抛）。 */
function readPath(value, path) {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = current[key]
  }
  return current
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------
const { result, header } = await run(process.env)
emit(result, header)
