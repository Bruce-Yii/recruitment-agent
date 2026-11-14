// Issue #1 §5 的**业务身份/幂等**矩阵（真库 ra_s6s7，每个用例结束 ROLLBACK）。
//
// 这一组测试守的是本轮的核心裁决（W0 §1.1/§1.2/§1.3），不看实现细节只看库里的行：
//   A 同文件重复投递同 Job        → 同一 ACTIVE Application（REUSED），无重复对象
//   B 不同 byte sha / 相同正文    → 同一 ACTIVE Application；新材料有自己的 resume_version
//   C 不同人相同模板/正文          → **不得**因 content hash 合并（两个 candidate / 两条 application）
//   D 同 Candidate 不同 Job        → 两条 Application（且版本可以 UNCHANGED）
//   E 已结束申请后显式再申请       → 合法的新 ACTIVE 周期，历史保留
//   F 并发接入                    → 第二个事务被事务级锁挡住，任何时刻不产生第二条 ACTIVE
//   H 先无结构化 → 再提交合格 structured → 追加新版本、可读回、旧事实保留
//   I 再提交同结构化              → structure_saved=false，不写行
//   K 结构化证据不成立            → 一行不写、旧事实不动
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyStructuredJson,
  intakeInTransaction,
  type IntakeMaterial,
} from '../../src/tools/application-intake.ts'
import { observeIdentity } from '../../src/db/identity.ts'
import type { ConverterOutput } from '../../src/tools/converter.ts'
import type { DatabaseClient } from '../../src/db/pool.ts'
import {
  createTestPool,
  DEMO_DEPARTMENT,
  DEMO_JOB,
  HR_ACTOR,
  hex64,
  inRolledBackTx,
  one,
  TENANT,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

// ---------------------------------------------------------------------------
//  夹具（全部合成，无真实个人资料）
// ---------------------------------------------------------------------------

/** 一份"模板正文"：用例 B/C 用它证明 content hash 相同不代表同一个人/同一条申请。 */
const TEMPLATE_TEXT = [
  '通用简历模板（合成样例，无真实个人资料）',
  '示例科技有限公司 后端工程师 2020.07 - 2023.06',
  '示例大学 计算机科学 本科 2016.09 - 2020.06',
].join('\n')

const EVIDENCE = [{ page: 1, bbox: [72, 100, 520, 120], block: 1, text: '联系方式：见简历正文' }]

/**
 * 造一份**已经过转换器**的材料（不读 PDF：身份结论只看 fields 的三态与来源）。
 * @param input.sha - 原件字节 sha（`intake_asset.sha256` / `resume_version.source_asset_sha256`）。
 * @param input.phone - 可读的手机号；不给就是 absent（身份只能靠 email）。
 * @param input.email - 可读的邮箱。
 * @param input.text - 正文（决定 `content_sha256`）。
 */
function material(input: {
  readonly sha: string
  readonly phone?: string
  readonly email?: string
  readonly text?: string
}): IntakeMaterial {
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '合成候选人', provenance: 'native_text', evidence: EVIDENCE },
    phone: input.phone === undefined
      ? { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] }
      : { state: 'present', value: input.phone, provenance: 'native_text', evidence: EVIDENCE },
    email: input.email === undefined
      ? { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] }
      : { state: 'present', value: input.email, provenance: 'native_text', evidence: EVIDENCE },
    work_experience: { state: 'present', provenance: 'native_text', evidence: EVIDENCE },
    education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
  }
  const eligible = [
    ...(input.phone === undefined ? [] : ['phone']),
    ...(input.email === undefined ? [] : ['email']),
  ]
  const observation = observeIdentity(fields as never, eligible)
  const output = {
    text: input.text ?? TEMPLATE_TEXT,
    chars: (input.text ?? TEMPLATE_TEXT).length,
    completeness: 'complete',
    issues: [],
    fields,
    timeline: { intervals: 1, closed_intervals: 1, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 36 },
    screening: { eligible_fields: eligible, blocked_fields: [], identity_merge_eligible: eligible },
    meta: { pages: 1, source_sha256: input.sha, backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  }
  return {
    real_path: 'C:/fake/application-identity.pdf',
    file_name: 'application-identity.pdf',
    byte_size: 2048,
    output: output as ConverterOutput,
    strong: observation.strong,
    blocked: observation.blocked,
    sha256: input.sha,
  }
}

/** 第二岗位（用例 D）：有 job_version 指针，否则 intake 会拒绝（application.job_version_id 非空）。 */
async function makeJob(client: DatabaseClient): Promise<string> {
  const suffix = uniqueSuffix()
  const jobId = await one(client, `insert into recruitment.job
      (tenant_id, department_id, code, title, status)
      values ($1, $2, $3, '身份矩阵第二岗位', 'OPEN') returning id`, [
    TENANT, DEMO_DEPARTMENT, `ID-${suffix}`.slice(0, 40),
  ])
  const versionId = await one(client, `insert into recruitment.job_version
      (tenant_id, job_id, version_no, description_md, payload_hash, created_by_actor_id)
      values ($1, $2, 1, '第二岗位 JD', $3, $4) returning id`, [
    TENANT, jobId, hex64(`jv${suffix}`), HR_ACTOR,
  ])
  await client.query('update recruitment.job set current_job_version_id = $2 where id = $1', [jobId, versionId])
  return jobId
}

async function count(client: DatabaseClient, sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: string }>(sql, [...params])
  return Number(rows[0]?.n ?? '0')
}

/** 该候选人名下的 (application 数, ACTIVE 数)。 */
async function applicationCounts(
  client: DatabaseClient,
  candidateId: string,
  jobId: string,
): Promise<{ total: number; active: number }> {
  const total = await count(
    client,
    'select count(*) as n from recruitment.application where tenant_id = $1 and candidate_id = $2 and job_id = $3',
    [TENANT, candidateId, jobId],
  )
  const active = await count(
    client,
    `select count(*) as n from recruitment.application
      where tenant_id = $1 and candidate_id = $2 and job_id = $3 and lifecycle_status = 'ACTIVE'`,
    [TENANT, candidateId, jobId],
  )
  return { total, active }
}

/** 读到申请当前的 `resume_version_id`。 */
async function applicationPointer(client: DatabaseClient, applicationId: string): Promise<string | null> {
  const { rows } = await client.query<{ resume_version_id: string | null }>(
    'select resume_version_id from recruitment.application where id = $1',
    [applicationId],
  )
  return rows[0]?.resume_version_id ?? null
}

/** 读一条 `resume_version` 的关键列（含 jsonb 里的结构化标记）。 */
async function readVersion(
  client: DatabaseClient,
  id: string,
): Promise<{
  version_no: number
  source_asset_sha256: string
  content_sha256: string
  parsed_fields: Record<string, any>
  evidence: Record<string, any>[]
}> {
  const { rows } = await client.query<{
    version_no: number
    source_asset_sha256: string
    content_sha256: string
    parsed_fields: Record<string, any>
    evidence: Record<string, any>[]
  }>(
    `select version_no, source_asset_sha256, content_sha256, parsed_fields, evidence
       from recruitment.resume_version where id = $1`,
    [id],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('resume_version row missing')
  return row
}

// ---------------------------------------------------------------------------
//  A：同文件重复投递同 Job
// ---------------------------------------------------------------------------

test('用例 A：同一文件重复投递同一 Job → 同一 ACTIVE Application（CREATED → REUSED），无重复对象', async () => {
  await inRolledBackTx(pool, async (client) => {
    const m = material({ sha: hex64(`A${uniqueSuffix()}`), phone: '13900010001' })

    const first = await intakeInTransaction(client, cfg, m, DEMO_JOB)
    assert.equal(first.application_action, 'CREATED')
    assert.equal(first.created, true, '兼容键必须与 application_action 一致')
    assert.equal(first.structure_saved, false, '本次没有结构化结果')
    assert.equal(first.resume_version_action, 'APPENDED')
    assert.equal(first.resume_version_no, 1)

    const second = await intakeInTransaction(client, cfg, m, DEMO_JOB)
    assert.equal(second.application_action, 'REUSED')
    assert.equal(second.structure_saved, false)
    assert.equal(second.resume_version_action, 'UNCHANGED')
    assert.equal(second.idempotent_replay, true)
    assert.equal(second.application_id, first.application_id)
    assert.equal(second.resume_version_id, first.resume_version_id)
    assert.equal(second.resume_version_no, 1)

    const counts = await applicationCounts(client, first.candidate_id, DEMO_JOB)
    assert.deepEqual(counts, { total: 1, active: 1 }, '同一 (candidate, job) 只能有一条 ACTIVE')
    assert.equal(
      await count(client, 'select count(*) as n from recruitment.resume_version where resume_id = $1', [first.resume_id]),
      1,
      '重复投递不得新增版本',
    )
    assert.equal(
      await count(client, 'select count(*) as n from recruitment.intake_asset where tenant_id = $1 and sha256 = $2', [TENANT, m.sha256]),
      1,
      '同一份原件只登记一次资产',
    )
  })
})

// ---------------------------------------------------------------------------
//  B：不同 byte sha / 相同正文
// ---------------------------------------------------------------------------

test('用例 B：不同 pdf 字节 sha、相同正文、同一经证据确认的 Candidate + Job → 同一 ACTIVE Application；新材料有独立 resume_version', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const m1 = material({ sha: hex64(`B1${suffix}`), phone: '13900020001', text: TEMPLATE_TEXT })
    const m2 = material({ sha: hex64(`B2${suffix}`), phone: '13900020001', text: TEMPLATE_TEXT })
    assert.notEqual(m1.sha256, m2.sha256)

    const first = await intakeInTransaction(client, cfg, m1, DEMO_JOB)
    const second = await intakeInTransaction(client, cfg, m2, DEMO_JOB)

    assert.equal(first.application_action, 'CREATED')
    assert.equal(second.application_action, 'REUSED', '申请身份是 (candidate, job, ACTIVE)，不是 file sha')
    assert.equal(second.candidate_id, first.candidate_id)
    assert.equal(second.application_id, first.application_id)
    // 新材料必须有自己的版本（可追踪），且指针前移。
    assert.equal(second.resume_version_action, 'APPENDED')
    assert.notEqual(second.resume_version_id, first.resume_version_id)

    assert.deepEqual(await applicationCounts(client, first.candidate_id, DEMO_JOB), { total: 1, active: 1 })

    const v1 = await readVersion(client, first.resume_version_id)
    const v2 = await readVersion(client, second.resume_version_id)
    assert.notEqual(v1.source_asset_sha256, v2.source_asset_sha256, '原件不同：字节 sha 必须不同')
    assert.equal(v1.content_sha256, v2.content_sha256, '正文相同：内容 sha 相同（所以它不能当申请身份）')
    assert.equal(await applicationPointer(client, first.application_id), second.resume_version_id)

    const versions = await count(
      client,
      `select count(*) as n from recruitment.resume_version rv
         join recruitment.resume r on r.id = rv.resume_id
        where r.candidate_id = $1`,
      [first.candidate_id],
    )
    assert.equal(versions, 2, '新材料要有一条自己的版本')
  })
})

// ---------------------------------------------------------------------------
//  C：不同人相同模板 / 正文 —— 本轮最容易做错的一条
// ---------------------------------------------------------------------------

test('用例 C：不同人、相同模板正文 → 不得因 content hash 合并（两个 Candidate、两条 Application）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const suffix = uniqueSuffix()
    const person1 = material({ sha: hex64(`C1${suffix}`), phone: '13900030001', text: TEMPLATE_TEXT })
    const person2 = material({ sha: hex64(`C2${suffix}`), phone: '13900030002', text: TEMPLATE_TEXT })

    const first = await intakeInTransaction(client, cfg, person1, DEMO_JOB)
    const second = await intakeInTransaction(client, cfg, person2, DEMO_JOB)

    assert.equal(first.application_action, 'CREATED')
    assert.equal(second.application_action, 'CREATED', '不同人 → 不同的申请周期')
    assert.notEqual(second.candidate_id, first.candidate_id, '不同人绝不能被合并成一个 candidate')
    assert.notEqual(second.application_id, first.application_id)

    // 关键证据：两条材料的内容 sha 逐字相同，但人/申请都不同。
    const v1 = await readVersion(client, first.resume_version_id)
    const v2 = await readVersion(client, second.resume_version_id)
    assert.equal(v1.content_sha256, v2.content_sha256, '这是"同正文"的证明')
    assert.notEqual(v1.source_asset_sha256, v2.source_asset_sha256)

    // 两条 application 都 ACTIVE，且各自只一条。
    assert.deepEqual(await applicationCounts(client, first.candidate_id, DEMO_JOB), { total: 1, active: 1 })
    assert.deepEqual(await applicationCounts(client, second.candidate_id, DEMO_JOB), { total: 1, active: 1 })

    // 关联 ≠ 合并：本用例涉及的两个人之间一条 candidate_merge 都不许出现。
    // 只数这两个 candidate（不是整表）：共享库里别的测试/别的 lane 的合并行与本用例无关。
    assert.equal(
      await count(client, `select count(*) as n from recruitment.candidate_merge
         where tenant_id = $1
           and (surviving_candidate_id = any($2::uuid[]) or merged_candidate_id = any($2::uuid[]))`, [
        TENANT, [first.candidate_id, second.candidate_id],
      ]),
      0,
      '身份只认强标识 + 证据；同正文不构成合并理由',
    )
    assert.equal(
      await count(client, `select count(*) as n from recruitment.candidate where tenant_id = $1 and normalized_phone in ($2, $3)`, [
        TENANT, '+8613900030001', '+8613900030002',
      ]),
      2,
      '两个规范化手机号各自一个 candidate',
    )
  })
})

// ---------------------------------------------------------------------------
//  D：同一 Candidate 不同 Job
// ---------------------------------------------------------------------------

test('用例 D：同一 Candidate 不同 Job → 两条 Application（版本可以 UNCHANGED，三个状态互不牵连）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const secondJob = await makeJob(client)
    const m = material({ sha: hex64(`D${uniqueSuffix()}`), phone: '13900040001' })

    const first = await intakeInTransaction(client, cfg, m, DEMO_JOB)
    const second = await intakeInTransaction(client, cfg, m, secondJob)

    assert.equal(first.application_action, 'CREATED')
    assert.equal(second.application_action, 'CREATED', '不同岗位是独立申请')
    assert.equal(second.candidate_id, first.candidate_id, '同一个自然人')
    assert.notEqual(second.application_id, first.application_id)
    // 这是"三个状态彼此独立"的关键组合：新建申请 + 版本无变化 + 没有结构化保存。
    assert.equal(second.resume_version_action, 'UNCHANGED')
    assert.equal(second.structure_saved, false)
    assert.equal(second.resume_version_id, first.resume_version_id, '同一份材料复用同一条版本')
    assert.equal(second.application.job_id, secondJob)

    assert.deepEqual(await applicationCounts(client, first.candidate_id, DEMO_JOB), { total: 1, active: 1 })
    assert.deepEqual(await applicationCounts(client, first.candidate_id, secondJob), { total: 1, active: 1 })
    assert.equal(
      await count(client, 'select count(*) as n from recruitment.resume_version where resume_id = $1', [first.resume_id]),
      1,
      '换岗位不得复制版本行',
    )
  })
})

// ---------------------------------------------------------------------------
//  E：已结束申请后显式再申请
// ---------------------------------------------------------------------------

test('用例 E：已结束（WITHDRAWN）后再投 → 合法的新的 ACTIVE 周期，历史行保留', async () => {
  await inRolledBackTx(pool, async (client) => {
    const m = material({ sha: hex64(`E${uniqueSuffix()}`), phone: '13900050001' })
    const first = await intakeInTransaction(client, cfg, m, DEMO_JOB)
    assert.equal(first.application_action, 'CREATED')

    // 结束这个周期（写侧动作由人/系统执行，这里模拟）。
    await client.query(
      `update recruitment.application set lifecycle_status = 'WITHDRAWN' where id = $1`,
      [first.application_id],
    )

    const second = await intakeInTransaction(client, cfg, m, DEMO_JOB)
    assert.equal(second.application_action, 'CREATED', '上一周期结束后允许建立新的 ACTIVE 周期')
    assert.notEqual(second.application_id, first.application_id)
    assert.equal(second.resume_version_action, 'UNCHANGED', '同一材料不复制版本')

    const counts = await applicationCounts(client, first.candidate_id, DEMO_JOB)
    assert.deepEqual(counts, { total: 2, active: 1 }, '历史保留，但 ACTIVE 只有一条')

    const old = await client.query<{ lifecycle_status: string; resume_version_id: string }>(
      'select lifecycle_status, resume_version_id from recruitment.application where id = $1',
      [first.application_id],
    )
    assert.equal(old.rows[0]?.lifecycle_status, 'WITHDRAWN')
    assert.equal(old.rows[0]?.resume_version_id, first.resume_version_id, '旧周期的材料指针不得被改写')
  })
})

// ---------------------------------------------------------------------------
//  F：并发接入
// ---------------------------------------------------------------------------

test('用例 F：并发接入同一 (candidate, job) → 第二个事务被 (candidate, job) 锁挡住，全程只有一条 ACTIVE', async () => {
  // 共享夹具只能用**已提交**的种子数据（0002_seed）：两个连接看不到对方未提交的行，
  // 而测试纪律要求"跑完即回滚 ⇒ 不许为了并发测试往库里提交新行"。
  // 种子候选人 `…0601` 同时有 phone/email，两条材料各只带一个强标识 ⇒ 身份锁的 key 不同，
  // 因此这里**只有** (candidate, job) 申请锁能挡住第二个事务。
  const SEED_CANDIDATE = '11111111-1111-4111-8111-000000000601'
  const a = await pool.connect()
  const b = await pool.connect()
  try {
    await a.query('begin')
    await a.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])
    await b.query('begin')
    await b.query("select set_config('recruitment.actor_id', $1, true)", [HR_ACTOR])

    const byPhone = material({ sha: hex64(`F1${uniqueSuffix()}`), phone: '138 0000 0000' })
    const byEmail = material({ sha: hex64(`F2${uniqueSuffix()}`), email: 'zhang.sample@demo-recruitment.test' })
    assert.equal(byPhone.strong.length, 1)
    assert.equal(byEmail.strong.length, 1)
    assert.notEqual(byPhone.strong[0]?.field, byEmail.strong[0]?.field, '两条材料靠不同强标识命中同一个人')

    const first = await intakeInTransaction(a as unknown as DatabaseClient, cfg, byPhone, DEMO_JOB)
    assert.equal(first.candidate_id, SEED_CANDIDATE)
    assert.equal(first.application_action, 'REUSED', '种子里该候选人已有 DEMO_JOB 的 ACTIVE 申请')
    assert.equal(first.resume_version_action, 'APPENDED')
    const lockedApplicationId = first.application_id

    // B 的另一半：不 await，让它去撞锁。
    const pending = intakeInTransaction(b as unknown as DatabaseClient, cfg, byEmail, DEMO_JOB)

    // 真证据：B 的后端进程此刻在等锁（不是"跑得慢"）。
    let wait: { wait_event_type: string | null; wait_event: string | null } | undefined
    for (let i = 0; i < 80 && wait?.wait_event_type !== 'Lock'; i += 1) {
      const { rows } = await a.query<{ wait_event_type: string | null; wait_event: string | null }>(
        'select wait_event_type, wait_event from pg_stat_activity where pid = $1',
        [b.processID],
      )
      wait = rows[0]
      if (wait?.wait_event_type === 'Lock') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(wait?.wait_event_type, 'Lock', `第二个事务必须在等锁，实际 wait_event=${JSON.stringify(wait)}`)
    assert.ok(
      wait?.wait_event === null || ['advisory', 'transactionid'].includes(String(wait?.wait_event)),
      `等的是锁，实际 wait_event=${String(wait?.wait_event)}`,
    )

    // A 回滚后 B 才继续：两条并发接入被排成一条一条，不会出现第二条 ACTIVE。
    await a.query('rollback')
    const second = await pending
    assert.equal(second.application_action, 'REUSED')
    assert.equal(second.candidate_id, SEED_CANDIDATE)
    assert.equal(second.application_id, lockedApplicationId, '并发下仍然复用同一条申请')
    assert.deepEqual(
      await applicationCounts(b as unknown as DatabaseClient, SEED_CANDIDATE, DEMO_JOB),
      { total: 1, active: 1 },
    )
    await b.query('rollback')
  } finally {
    a.release()
    b.release()
  }
})

// ---------------------------------------------------------------------------
//  H / I / K：结构化版本（本 lane 必交的 readback 场景）
// ---------------------------------------------------------------------------

/**
 * 带文本层的合成简历（块文本与 `structured_json` 的 block 引用一一对应）。
 *
 * 联系方式**每次现造**：`candidate` 上有 `uq_candidate_active_phone/email` 部分唯一索引，
 * 而 `node --test` 会让各测试文件并行跑；用固定字面量会与别的文件撞唯一键
 * （真实事故：`zhang.example@example.test` 与 `application-intake-structured.test.ts` 撞车）。
 */
interface VersionedFixture {
  readonly sha: string
  readonly phone: string
  readonly email: string
  readonly blocks: readonly Record<string, unknown>[]
}

function versionedFixture(seed: string): VersionedFixture {
  const suffix = uniqueSuffix()
  const digits = String(Number.parseInt(hex64(`phone-${suffix}`).slice(0, 8), 16) % 100_000_000).padStart(8, '0')
  const phone = `139${digits}`
  const email = `zhang.${suffix}@example.test`
  return {
    sha: hex64(`${seed}${suffix}`),
    phone,
    email,
    blocks: [
      { kind: 'paragraph', text: '张示例', location: { page: 1, bbox: [72, 100, 300, 120] }, provenance: 'native_text' },
      { kind: 'paragraph', text: `电话：${phone}  邮箱：${email}`, location: { page: 1, bbox: [72, 130, 520, 150] }, provenance: 'native_text' },
      { kind: 'paragraph', text: '示例科技有限公司 后端工程师 2020.07 - 2023.06', location: { page: 1, bbox: [72, 200, 520, 220] }, provenance: 'native_text' },
    ],
  }
}

/** 转换器口径：name/phone/email 可读，work_experience 读不出（交给结构化升级）。 */
function versionedMaterial(fixture: VersionedFixture): IntakeMaterial {
  const evidence = (block: number, text: string) => [{ page: 1, bbox: [72, block * 100, 520, block * 100 + 20], block, text }]
  const fields: Record<string, unknown> = {
    name: { state: 'present', value: '张示例', provenance: 'native_text', evidence: evidence(1, '张示例') },
    phone: { state: 'present', value: fixture.phone, provenance: 'native_text', evidence: evidence(2, `电话：${fixture.phone}`) },
    email: { state: 'present', value: fixture.email, provenance: 'native_text', evidence: evidence(2, `邮箱：${fixture.email}`) },
    work_experience: { state: 'unreadable', reason: 'entries_not_segmentable', provenance: 'native_text', evidence: [] },
    education: { state: 'absent', reason: 'not_mentioned', provenance: 'native_text', evidence: [] },
  }
  const eligible = ['name', 'phone', 'email']
  const observation = observeIdentity(fields as never, eligible)
  const output = {
    text: fixture.blocks.map((block) => String(block.text)).join('\n'),
    chars: 120,
    completeness: 'complete',
    issues: [],
    blocks: [...fixture.blocks],
    fields,
    timeline: { intervals: 1, closed_intervals: 1, open_ended_intervals: 0, year_only_intervals: 0, covered_months_closed: 36 },
    screening: { eligible_fields: ['name', 'work_experience'], blocked_fields: [], identity_merge_eligible: eligible },
    meta: { pages: 1, source_sha256: fixture.sha, backend: 'pymupdf/1.28.0', reader_version: '1.0.0' },
  }
  return {
    real_path: 'C:/fake/versioned.pdf',
    file_name: 'versioned.pdf',
    byte_size: 4096,
    output: output as ConverterOutput,
    strong: observation.strong,
    blocked: observation.blocked,
    sha256: fixture.sha,
  }
}

/** 与上面 PDF 的 block index 对应的结构化结果（work_experience 由 unreadable 升级为 present）。 */
function structuredDoc(fixture: VersionedFixture): Record<string, unknown> {
  return {
    prompt_version: '1.0.0',
    schema_version: '1.0.0',
    block_count: 3,
    sections: [
      { label: 'contact', block_ids: ['1', '2'] },
      { label: 'work_experience', block_ids: ['3'] },
    ],
    fields: {
      name: { state: 'present', value: '张示例', block_ids: ['1'] },
      phone: { state: 'present', value: fixture.phone, block_ids: ['2'] },
      email: { state: 'present', value: fixture.email, block_ids: ['2'] },
      work_experience: {
        state: 'present',
        block_ids: ['3'],
        value: [
          {
            company: { value: '示例科技有限公司', block_ids: ['3'] },
            title: { value: '后端工程师', block_ids: ['3'] },
            start: { value: '2020.07', block_ids: ['3'] },
            end: { value: '2023.06', block_ids: ['3'] },
            block_ids: ['3'],
            attribution: 'single_block',
          },
        ],
      },
      education: { state: 'absent', reason: 'not_mentioned', block_ids: [] },
    },
  }
}

test('用例 H/I：先无结构化 → 再同材料提交合格 structured → 新版本落库可读回；再提交同结构化 → structure_saved=false', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fixture = versionedFixture('H')
    const plain = versionedMaterial(fixture)

    // ① 先 intake，无结构化。
    const first = await intakeInTransaction(client, cfg, plain, DEMO_JOB)
    assert.equal(first.application_action, 'CREATED')
    assert.equal(first.structure_saved, false)
    assert.equal(first.resume_version_action, 'APPENDED')
    assert.equal(first.resume_version_no, 1)
    const v1Before = await readVersion(client, first.resume_version_id)
    assert.equal(Object.hasOwn(v1Before.parsed_fields, 'structured'), false)
    assert.equal(v1Before.parsed_fields.fields.work_experience.state, 'unreadable')
    const v1EvidenceBefore = JSON.stringify(v1Before.evidence)

    // ② 同一材料 + 通过证据校验的结构化结果 → 追加 v2，并显式指向它。
    const structured = applyStructuredJson(versionedMaterial(fixture), JSON.stringify(structuredDoc(fixture)), DEMO_JOB)
    const second = await intakeInTransaction(client, cfg, structured, DEMO_JOB)
    assert.equal(second.application_action, 'REUSED', '同一 (candidate, job, ACTIVE) 复用申请')
    assert.equal(second.structure_saved, true)
    assert.equal(second.resume_version_action, 'APPENDED')
    assert.equal(second.resume_version_no, 2)
    assert.equal(second.resume_id, first.resume_id, '同一 resume 上递增版本号')
    assert.notEqual(second.resume_version_id, first.resume_version_id)
    assert.equal(await applicationPointer(client, first.application_id), second.resume_version_id)

    // 新版本可读回：结构化标记 + 升级后的字段 + 块级证据。
    const v2 = await readVersion(client, second.resume_version_id)
    assert.equal(v2.version_no, 2)
    assert.equal(v2.parsed_fields.structured.source, 'agent_structured')
    assert.equal(v2.parsed_fields.structured.validated, true)
    assert.equal(v2.parsed_fields.fields.work_experience.state, 'present')
    assert.equal(v2.parsed_fields.fields.work_experience.state_source, 'agent_structured')
    assert.equal(v2.parsed_fields.fields.work_experience.converter_state, 'unreadable')
    assert.equal(v2.parsed_fields.fields.work_experience.entry_count, 1)
    const agentEvidence = v2.evidence.filter((item) => item.source === 'agent_structured')
    assert.ok(agentEvidence.length >= 4)
    const workEvidence = agentEvidence.find((item) => item.field === 'work_experience' && item.block_id === 3)
    assert.ok(workEvidence !== undefined)
    assert.equal(workEvidence.page, 1)
    assert.match(String(workEvidence.quote), /示例科技有限公司/)

    // 旧事实不动：v1 逐字未改（jsonb 也不许被 UPDATE）。
    const v1After = await readVersion(client, first.resume_version_id)
    assert.equal(JSON.stringify(v1After.parsed_fields), JSON.stringify(v1Before.parsed_fields))
    assert.equal(JSON.stringify(v1After.evidence), v1EvidenceBefore)
    assert.equal(Object.hasOwn(v1After.parsed_fields, 'structured'), false)

    // ③ 再提交同一份结构化结果 → structure_saved=false，且不写行。
    const third = await intakeInTransaction(client, cfg, structured, DEMO_JOB)
    assert.equal(third.application_action, 'REUSED')
    assert.equal(third.structure_saved, false)
    assert.equal(third.resume_version_action, 'UNCHANGED')
    assert.equal(third.resume_version_id, second.resume_version_id)
    assert.equal(third.resume_version_no, 2)
    assert.equal(third.idempotent_replay, true)
    assert.equal(
      await count(client, 'select count(*) as n from recruitment.resume_version where resume_id = $1', [first.resume_id]),
      2,
      '幂等重放不得新增版本',
    )
  })
})

test('用例 K：结构化证据不成立 → 一行不写，旧版本与申请指针都不动', async () => {
  await inRolledBackTx(pool, async (client) => {
    const fixture = versionedFixture('K')
    const first = await intakeInTransaction(client, cfg, versionedMaterial(fixture), DEMO_JOB)

    const before = {
      versions: await count(client, 'select count(*) as n from recruitment.resume_version where resume_id = $1', [first.resume_id]),
      assets: await count(client, 'select count(*) as n from recruitment.intake_asset where tenant_id = $1', [TENANT]),
      pointer: await applicationPointer(client, first.application_id),
    }

    // 假设引用：值在原文里不存在（模型编造）→ validate 拒绝，事务根本不会开。
    const fake = structuredDoc(fixture) as Record<string, any>
    fake.fields.phone = { state: 'present', value: '139 1111 2222', block_ids: ['2'] }
    assert.throws(
      () => applyStructuredJson(versionedMaterial(fixture), JSON.stringify(fake), DEMO_JOB),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'BLOCKED_BY_REVIEW')
        assert.match((error as Error).message, /STRUCTURED_REJECTED/)
        return true
      },
    )

    const after = {
      versions: await count(client, 'select count(*) as n from recruitment.resume_version where resume_id = $1', [first.resume_id]),
      assets: await count(client, 'select count(*) as n from recruitment.intake_asset where tenant_id = $1', [TENANT]),
      pointer: await applicationPointer(client, first.application_id),
    }
    assert.deepEqual(after, before, '被拒的结构化结果不得污染库（不写行、不改指针）')
  })
})
