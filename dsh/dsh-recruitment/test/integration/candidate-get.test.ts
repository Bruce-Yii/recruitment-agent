// `recruitment_candidate_get` 的集成矩阵（**连真库 ra_s6s7**，每个用例结束 ROLLBACK）。
//
// 2026-11-14：这个工具从 fixture stub 改成真库读，本文件是"真的查了库"的证据。
//
// 覆盖：
//   1. 真库读回：自建候选人 + 一条申请 → 字段逐个对；
//   2. 联系方式默认脱敏、include_contacts=true 才给原文；
//   3. 租户隔离：同一个 id 换个租户 → NOT_FOUND（不是"查到了别人的"）；
//   4. 未找到 → CANDIDATE_NOT_FOUND；非 UUID → NOT_A_UUID（在起连接池之前就拒）；
//   5. MERGED 且有指向 → 输出 merged_into_candidate_id。
//
// 纪律：夹具一律在 `inRolledBackTx` 里直接 INSERT，结束 ROLLBACK，不污染 ra_s6s7。
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { readCandidateValue, createCandidateGetTool, unconfiguredCandidateGetTool } from '../../src/tools/candidate-get.ts'
import {
  DEMO_JOB,
  TENANT,
  createTestPool,
  inRolledBackTx,
  testDatabaseConfig,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

/** 演示岗位 401 的 job_version / rubric_version（0002_seed 建的）。 */
const DEMO_JOB_VERSION = '11111111-1111-4111-8111-000000000402'
const DEMO_RUBRIC_VERSION = '11111111-1111-4111-8111-000000000403'

/**
 * 插一个只属于本用例的候选人 + 一条申请。
 * @param client - 事务连接。
 * @param overrides - 需要覆盖的候选人字段。
 * @returns 候选人 id 与申请 id。
 */
async function insertCandidate(
  client: Parameters<Parameters<typeof inRolledBackTx>[1]>[0],
  overrides: Record<string, unknown> = {},
): Promise<{ candidateId: string; applicationId: string; email: string; phone: string }> {
  const candidateId = randomUUID()
  const applicationId = randomUUID()
  // 库里对 ACTIVE 候选人邮箱/手机有唯一索引（uq_candidate_active_email / _phone），
  // 夹具必须每次唯一，否则第二个用例就 23505。
  const compact = candidateId.replace(/-/g, '')
  const email = String(overrides.normalized_email ?? `cand.${compact.slice(0, 10)}@example.com`)
  // 手机号必须全是数字（ck_candidate_phone_normalized），所以从 UUID 的十六进制字符映射成数字。
  const digits = Array.from(compact.slice(0, 8)).map((c) => String(c.charCodeAt(0) % 10)).join('')
  const phone = String(overrides.normalized_phone ?? `138${digits}`)
  await client.query(
    `insert into recruitment.candidate
       (id, tenant_id, display_name, normalized_email, normalized_phone, identity_status, merged_into_candidate_id)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      candidateId,
      TENANT,
      overrides.display_name ?? '测试候选人（合成）',
      email,
      phone,
      overrides.identity_status ?? 'ACTIVE',
      overrides.merged_into_candidate_id ?? null,
    ],
  )
  await client.query(
    `insert into recruitment.application
       (id, tenant_id, candidate_id, job_id, job_version_id, rubric_version_id, current_stage_code)
     values ($1, $2, $3, $4, $5, $6, 'S7')`,
    [applicationId, TENANT, candidateId, DEMO_JOB, DEMO_JOB_VERSION, DEMO_RUBRIC_VERSION],
  )
  return { candidateId, applicationId, email, phone }
}

test('candidate_get：真库读回（姓名/状态/申请/岗位 code 与 title）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { candidateId, applicationId } = await insertCandidate(client)
    const value = await readCandidateValue(client, cfg, { candidate_id: candidateId })

    assert.equal(value.candidate_id, candidateId)
    assert.equal(value.display_name, '测试候选人（合成）')
    assert.equal(value.identity_status, 'ACTIVE')
    assert.equal(value.source, 'DATABASE')
    assert.equal(value.record_version, 1)
    assert.equal(value.applications.length, 1)
    assert.equal(value.applications[0].application_id, applicationId)
    assert.equal(value.applications[0].job_id, DEMO_JOB)
    assert.equal(value.applications[0].job_code, 'DEMO-BE-001')
    assert.equal(value.applications[0].job_title, '后端工程师（演示）')
    assert.equal(value.applications[0].stage_code, 'S7')
    assert.equal(value.applications[0].lifecycle_status, 'ACTIVE')
  })
})

test('candidate_get：联系方式默认脱敏，include_contacts=true 才给原文', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { candidateId, email, phone } = await insertCandidate(client)
    const last4 = phone.slice(-4)

    const masked = await readCandidateValue(client, cfg, { candidate_id: candidateId })
    assert.equal(masked.contacts.visible, false)
    // 首字母 + 域名保留；中间打码
    assert.equal(masked.contacts.email, `c***@example.com`)
    // 前 3 位 + 后 4 位保留
    assert.equal(masked.contacts.phone, `138****${last4}`)
    assert.notEqual(masked.contacts.email, email)
    assert.notEqual(masked.contacts.phone, phone)

    const full = await readCandidateValue(client, cfg, {
      candidate_id: candidateId,
      include_contacts: true,
    })
    assert.equal(full.contacts.visible, true)
    assert.equal(full.contacts.email, email)
    assert.equal(full.contacts.phone, phone)
  })
})

test('candidate_get：租户隔离（同 id 换租户 → NOT_FOUND）', async () => {
  await inRolledBackTx(pool, async (client) => {
    const { candidateId } = await insertCandidate(client)
    const otherTenant = { ...cfg, tenant_id: '11111111-1111-4111-8111-000000000002' }
    await assert.rejects(
      () => readCandidateValue(client, otherTenant, { candidate_id: candidateId }),
      /CANDIDATE_NOT_FOUND/,
    )
  })
})

test('candidate_get：MERGED 且指向另一行 → 输出 merged_into_candidate_id', async () => {
  await inRolledBackTx(pool, async (client) => {
    const target = await insertCandidate(client, { display_name: '被合并的目标' })
    // ck_candidate_merged_fields：MERGED 必须同时有 merged_into_candidate_id 和 merge_id，
    // 而 merge_id 有 FK 指向 candidate_merge —— 所以先插合并记录，再把候选人标成 MERGED。
    const merged = await insertCandidate(client, { display_name: '被合并的人' })
    const mergeId = randomUUID()
    await client.query(
      `insert into recruitment.candidate_merge
         (id, tenant_id, surviving_candidate_id, merged_candidate_id, match_basis, auto_merged, decided_at)
       values ($1, $2, $3, $4, '{"basis":"TEST_FIXTURE"}'::jsonb, true, now())`,
      [mergeId, TENANT, target.candidateId, merged.candidateId],
    )
    await client.query(
      `update recruitment.candidate
          set identity_status = 'MERGED', merged_into_candidate_id = $1, merge_id = $2
        where id = $3 and tenant_id = $4`,
      [target.candidateId, mergeId, merged.candidateId, TENANT],
    )

    const value = await readCandidateValue(client, cfg, { candidate_id: merged.candidateId })
    assert.equal(value.identity_status, 'MERGED')
    assert.equal(value.merged_into_candidate_id, target.candidateId)
  })
})

test('candidate_get：未知 id → NOT_FOUND，不退回样例数据', async () => {
  await inRolledBackTx(pool, async (client) => {
    await assert.rejects(
      () => readCandidateValue(client, cfg, { candidate_id: randomUUID() }),
      /CANDIDATE_NOT_FOUND/,
    )
  })
})

test('candidate_get：非 UUID 在起连接池之前就被拒', async () => {
  // 用一份"假"配置：如果校验在连接池之后，这里会连库失败而不是 INVALID_ARGS。
  const tool = createCandidateGetTool({ ...cfg, port: 1 })
  await assert.rejects(() => tool.execute({ candidate_id: 'candidate_0001' }), /NOT_A_UUID/)
  await assert.rejects(() => tool.execute({}), /candidate_id/)
})

test('candidate_get：未配置时注册同一个工具名，调用报 NOT_CONFIGURED', async () => {
  const tool = unconfiguredCandidateGetTool(['database.password_env'])
  assert.equal(tool.name, 'recruitment_candidate_get')
  await assert.rejects(() => tool.execute({ candidate_id: randomUUID() }), /NOT_CONFIGURED/)
})

test.after(async () => {
  await pool.end()
})
