// 岗位线（S3）写工具的集成测：**连真库 ra_s6s7**，每个用例都在回滚事务里跑。
//
// 为什么必须连真库（R3）：版本不可变（`trg_rubric_version_immutable`）、重复 code
// （`uq_job_code` 的 23505）、审批状态机（`fn_approval_guard` / `fn_row_guard`）都是
// **数据库强制**的事实；用内存夹具"测"这些等于自己实现一遍规则再自己判自己对。
//
// 为什么不在集成测里调 `createJobGetTool`：`job_get` 自己开连接池、读**已提交**数据，
// 在回滚事务里看不到本事务未提交的行（会误报 NOT_FOUND）。所以这里只断言本事务内的
// 行与哈希；读回证据由 `manual/job-line/read-back.mjs` 对**已提交**数据做。
import test from 'node:test'
import assert from 'node:assert/strict'

import { digestOf } from '../../src/tools/contract.ts'
import {
  createJobInTransaction,
  decideRubricApprovalInTransaction,
  updateJobInTransaction,
} from '../../src/tools/job-create.ts'
import {
  DEMO_DEPARTMENT,
  HR_ACTOR,
  TENANT,
  createTestPool,
  errorBody,
  inRolledBackTx,
  testDatabaseConfig,
  uniqueSuffix,
} from './db.ts'

const cfg = testDatabaseConfig()
const pool = createTestPool(cfg)

test.after(async () => {
  await pool.end()
})

/** 一条 criterion 的输入形（只有 6 个键；写侧负责 normalize 成 9 键）。 */
const CRITERIA_V1 = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.5, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月', kind: 'MUST_HAVE', weight: 0.5, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
]

/** 与 v1 内容不同（权重不同 → hash 不同）的第二版标准。 */
const CRITERIA_V2 = [
  { key: 'work_exists', label: '有工作经历', kind: 'MUST_HAVE', weight: 0.7, field: 'work_experience', operator: 'EXISTS', value: true },
  { key: 'months_gte36', label: '至少 36 个月', kind: 'MUST_HAVE', weight: 0.3, field: 'timeline.covered_months_closed', operator: 'GTE', value: 36 },
]

/** 本次运行唯一的岗位 code（`^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`）。 */
function jobCode(): string {
  return `S3-${uniqueSuffix()}`
}

/** 本租户之外的另一个租户（只用于租户隔离断言；不需要在库里存在）。 */
const OTHER_TENANT = '22222222-2222-4222-8222-000000000001'

async function selectRows(client: Parameters<Parameters<typeof inRolledBackTx>[1]>[0], sql: string, params: readonly unknown[]) {
  const result = await client.query(sql, [...params])
  return result.rows as Record<string, unknown>[]
}

test('① 建岗位 + criteria：job/job_version/rubric_version/approval 四行都在，approval=PENDING，R-VAL-14 hash 对得上', async () => {
  await inRolledBackTx(pool, async (client) => {
    const title = 'S3 集成岗位（带标准）'
    const value = await createJobInTransaction(client, cfg, {
      title,
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      description_md: 'S3 集成测试 JD v1',
      criteria: CRITERIA_V1,
    })
    assert.equal(value.outcome, 'CREATED')
    assert.equal(value.contract_version, '1.0.0')
    assert.equal(value.tool, 'recruitment_job_create')
    // R4（`contracts/tenant-provenance.md`）：ra_s6s7 是 0002_seed 的演示租户（合成数据）⇒ FIXTURE；
    // 岗位写工具不接任何外部系统 ⇒ connection=NOT_CONNECTED（不许再写死 LIVE/CONNECTED）。
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.equal(value.department.id, DEMO_DEPARTMENT)

    const jobRows = await selectRows(client,
      `select id, code, title, status, department_id, requisition_id, current_job_version_id, record_version
         from recruitment.job where id = $1 and tenant_id = $2`, [value.job.id, TENANT])
    assert.equal(jobRows.length, 1, 'job 行必须存在')
    const job = jobRows[0] as Record<string, unknown>
    assert.equal(job.code, value.job.code)
    assert.equal(job.title, title)
    assert.equal(job.status, 'DRAFT')
    assert.equal(job.current_job_version_id, value.job_version.id)
    assert.equal(job.requisition_id, null)

    const jobVersionRows = await selectRows(client,
      `select id, job_id, version_no, description_md, requirements_md, payload_hash, approved_by_approval_id
         from recruitment.job_version where job_id = $1 order by version_no`, [value.job.id])
    assert.equal(jobVersionRows.length, 1)
    const jobVersion = jobVersionRows[0] as Record<string, unknown>
    assert.equal(jobVersion.version_no, 1)
    assert.equal(jobVersion.description_md, 'S3 集成测试 JD v1')
    assert.equal(jobVersion.requirements_md, null)
    // SPEC §3 第 5 步：hash = digestOf({description_md, requirements_md})，含 null
    assert.equal(jobVersion.payload_hash, digestOf({ description_md: 'S3 集成测试 JD v1', requirements_md: null }))
    assert.equal(jobVersion.approved_by_approval_id, null)

    const rubricRows = await selectRows(client,
      `select id, job_id, version_no, dimensions, payload_hash, approved_by_approval_id
         from recruitment.rubric_version where job_id = $1 order by version_no`, [value.job.id])
    assert.equal(rubricRows.length, 1)
    const rubric = rubricRows[0] as Record<string, unknown>
    assert.equal(rubric.version_no, 1)
    // R-VAL-14：payload_hash = sha256(canonical_json(dimensions))，JSONB 往返后仍一致
    assert.equal(rubric.payload_hash, digestOf(rubric.dimensions))
    assert.equal(rubric.payload_hash, value.rubric?.payload_hash)
    // 旧指针始终留空（SPEC §1 第 2 条）
    assert.equal(rubric.approved_by_approval_id, null)

    const approvalRows = await selectRows(client,
      `select a.id, a.resource_type, a.resource_id, a.resource_record_version,
              a.payload_schema_version, a.canonical_payload_hash, a.status,
              a.requested_by_actor_id, a.decision_by_actor_id, a.decided_at
         from recruitment.approval a
         join recruitment.rubric_version r on r.id = a.resource_id and r.tenant_id = a.tenant_id
        where r.job_id = $1`, [value.job.id])
    assert.equal(approvalRows.length, 1, '必须恰好一条 approval')
    const approval = approvalRows[0] as Record<string, unknown>
    assert.equal(approval.resource_type, 'RUBRIC_VERSION')
    assert.equal(approval.resource_id, rubric.id)
    assert.equal(approval.resource_record_version, 1)
    assert.equal(approval.payload_schema_version, 1)
    assert.equal(approval.canonical_payload_hash, rubric.payload_hash)
    assert.equal(approval.status, 'PENDING', 'Agent 只能写 PENDING，不能替人批准')
    assert.equal(approval.requested_by_actor_id, HR_ACTOR)
    assert.equal(approval.decision_by_actor_id, null)
    assert.equal(approval.decided_at, null)

    // 输出回显的是规范化后的 9 键（逐字回显，不吞键）
    assert.equal(value.rubric?.criteria.length, 2)
    for (const criterion of value.rubric?.criteria ?? []) {
      assert.deepEqual(
        Object.keys(criterion as Record<string, unknown>).sort(),
        ['field', 'key', 'kind', 'label', 'notes', 'operator', 'question', 'value', 'weight'],
      )
    }
    assert.equal(value.rubric?.is_approved, false)
    assert.equal(value.rubric?.approval.status, 'PENDING')
    assert.equal(value.rubric?.approval.approval_id, approval.id)
    assert.equal(value.next_action.kind, 'APPROVE_RUBRIC')
    assert.equal(value.next_action.job_id, value.job.id)
    assert.equal(value.next_action.verify_with, 'recruitment_job_get')
  })
})

test('② 未给 criteria：只有 job + job_version，无 rubric/approval；JD 用标题占位', async () => {
  await inRolledBackTx(pool, async (client) => {
    const title = 'S3 集成岗位（无标准）'
    const value = await createJobInTransaction(client, cfg, {
      title,
      code: jobCode(),
      // 按名称解析部门（大小写不敏感精确匹配，SPEC §3）
      department_name: '研发部（演示）',
    })
    assert.equal(value.outcome, 'CREATED')
    assert.equal(value.department.id, DEMO_DEPARTMENT)
    assert.equal(value.rubric, null, '未给 criteria 时 rubric 必须是 null')
    assert.equal(value.job_version.jd_source, 'TITLE_PLACEHOLDER')
    assert.equal(value.job_version.description_md, title)
    assert.equal(value.job_version.requirements_md, null)
    assert.equal(value.job_version.payload_hash, digestOf({ description_md: title, requirements_md: null }))
    assert.equal(value.next_action.kind, 'READ_BACK')
    assert.equal(value.next_action.approval_id, null)

    const jobVersionCount = await selectRows(client,
      'select count(*)::int as n from recruitment.job_version where job_id = $1', [value.job.id])
    assert.equal(jobVersionCount[0]?.n, 1)
    const rubricCount = await selectRows(client,
      'select count(*)::int as n from recruitment.rubric_version where job_id = $1', [value.job.id])
    assert.equal(rubricCount[0]?.n, 0, '没有 criteria 就不该有 rubric_version')
    const approvalCount = await selectRows(client,
      `select count(*)::int as n from recruitment.approval a
         join recruitment.rubric_version r on r.id = a.resource_id where r.job_id = $1`, [value.job.id])
    assert.equal(approvalCount[0]?.n, 0, '没有 criteria 就不该有 approval')
  })
})

test('③ 重复 code：捕获 DUPLICATE_JOB_CODE，detail.sqlstate 是真 SQLSTATE 23505', async () => {
  await inRolledBackTx(pool, async (client) => {
    const code = jobCode()
    const first = await createJobInTransaction(client, cfg, { title: 'S3 重复 code 第一个', code })
    assert.equal(first.outcome, 'CREATED')

    // 在**同一事务**里再插一次：唯一索引立刻报 23505（不需要等提交）。
    await assert.rejects(
      () => createJobInTransaction(client, cfg, { title: 'S3 重复 code 第二个', code }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'DUPLICATE_JOB_CODE')
        const detail = body.detail as Record<string, unknown>
        assert.equal(detail.sqlstate, '23505')
        assert.equal(detail.constraint, 'uq_job_code')
        return true
      },
    )
  })
})

test('④ 更新：v2 job_version + v2 rubric + 新 PENDING approval；旧 v1 行不变；指针指向 v2；同内容重试 UNCHANGED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（更新）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      description_md: 'S3 集成测试 JD v1',
      criteria: CRITERIA_V1,
    })
    assert.equal(created.outcome, 'CREATED')
    const jobId = created.job.id

    // 更新前快照：v1 的 dimensions/payload_hash 一个字节都不许变
    const beforeRows = await selectRows(client,
      `select id, version_no, dimensions, payload_hash from recruitment.rubric_version
        where job_id = $1 order by version_no`, [jobId])
    assert.equal(beforeRows.length, 1)
    const v1Before = beforeRows[0] as Record<string, unknown>
    const jobVersionBefore = await selectRows(client,
      'select id, version_no, payload_hash from recruitment.job_version where job_id = $1', [jobId])
    const jv1Before = jobVersionBefore[0] as Record<string, unknown>

    const updated = await updateJobInTransaction(client, cfg, {
      job_id: jobId,
      description_md: 'S3 集成测试 JD v2（内容已变）',
      criteria: CRITERIA_V2,
    })
    assert.equal(updated.outcome, 'UPDATED')
    assert.equal(updated.job_version.version_no, 2)
    assert.equal(updated.rubric?.version_no, 2)
    assert.equal(updated.rubric?.approval.status, 'PENDING')
    assert.equal(updated.rubric?.is_approved, false)

    // 新版本行：v2 job_version / v2 rubric / 新 approval
    const jobVersionsAfter = await selectRows(client,
      `select id, version_no, description_md, payload_hash from recruitment.job_version
        where job_id = $1 order by version_no`, [jobId])
    assert.deepEqual(jobVersionsAfter.map((row) => row.version_no), [1, 2])
    assert.equal(jobVersionsAfter[0]?.id, jv1Before.id, '旧 job_version 行 id 不变（不 UPDATE 旧行）')
    assert.equal(jobVersionsAfter[0]?.payload_hash, jv1Before.payload_hash, '旧 job_version hash 不变')
    assert.equal(jobVersionsAfter[1]?.description_md, 'S3 集成测试 JD v2（内容已变）')

    const rubricsAfter = await selectRows(client,
      `select id, version_no, dimensions, payload_hash from recruitment.rubric_version
        where job_id = $1 order by version_no`, [jobId])
    assert.deepEqual(rubricsAfter.map((row) => row.version_no), [1, 2])
    const v1After = rubricsAfter[0] as Record<string, unknown>
    assert.equal(v1After.id, v1Before.id)
    assert.deepEqual(v1After.dimensions, v1Before.dimensions, '旧 rubric dimensions 不得被改')
    assert.equal(v1After.payload_hash, v1Before.payload_hash, '旧 rubric hash 不得被改')
    assert.equal(digestOf(rubricsAfter[1]?.dimensions), rubricsAfter[1]?.payload_hash)

    // job 指针指向 v2；approval 变成两条（v1 旧批准保持 + v2 新 PENDING）
    const jobRows = await selectRows(client,
      'select current_job_version_id, record_version from recruitment.job where id = $1', [jobId])
    assert.equal(jobRows[0]?.current_job_version_id, updated.job_version.id)
    const approvals = await selectRows(client,
      `select a.id, a.status, a.resource_id, a.canonical_payload_hash from recruitment.approval a
         join recruitment.rubric_version r on r.id = a.resource_id and r.tenant_id = a.tenant_id
        where r.job_id = $1 order by a.created_at, a.id`, [jobId])
    assert.equal(approvals.length, 2)
    const pendingApproval = approvals.find((row) => row.id === updated.rubric?.approval.approval_id)
    assert.ok(pendingApproval !== undefined)
    assert.equal(pendingApproval?.status, 'PENDING')
    assert.equal(pendingApproval?.resource_id, updated.rubric?.version_id)
    assert.equal(pendingApproval?.canonical_payload_hash, updated.rubric?.payload_hash)

    // 幂等：内容完全相同的第二次更新 → UNCHANGED，且不再产生新行
    const again = await updateJobInTransaction(client, cfg, {
      job_id: jobId,
      description_md: 'S3 集成测试 JD v2（内容已变）',
      criteria: CRITERIA_V2,
    })
    assert.equal(again.outcome, 'UNCHANGED')
    const counts = await selectRows(client,
      `select
         (select count(*)::int from recruitment.job_version where job_id = $1) as job_versions,
         (select count(*)::int from recruitment.rubric_version where job_id = $1) as rubrics,
         (select count(*)::int from recruitment.approval a
            join recruitment.rubric_version r on r.id = a.resource_id where r.job_id = $1) as approvals`,
      [jobId])
    assert.deepEqual(counts[0], { job_versions: 2, rubrics: 2, approvals: 2 })
  })
})

test('⑤ 批准：APPROVE → APPROVED（责任人=actor）；再批一次 APPROVAL_NOT_PENDING；REJECT 缺 reason → REASON_REQUIRED', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（审批）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const approvalId = created.rubric?.approval.approval_id as string
    assert.equal(typeof approvalId, 'string')

    const decided = await decideRubricApprovalInTransaction(client, cfg, {
      approval_id: approvalId,
      decision: 'APPROVE',
    })
    assert.equal(decided.approval_id, approvalId)
    assert.equal(decided.status, 'APPROVED')
    assert.equal(decided.resource_type, 'RUBRIC_VERSION')
    assert.equal(decided.resource_id, created.rubric?.version_id)
    assert.equal(decided.job_id, created.job.id)
    assert.equal(decided.rubric_version_no, 1)
    assert.equal(decided.canonical_payload_hash, created.rubric?.payload_hash)
    assert.equal(decided.decided_by_actor_id, HR_ACTOR)
    assert.ok(Number.isFinite(Date.parse(decided.decided_at)))
    assert.ok(decided.record_version >= 2, '决定后 record_version 必须自增')

    const rows = await selectRows(client,
      `select status, decision_by_actor_id, decided_at, reason, record_version
         from recruitment.approval where id = $1`, [approvalId])
    assert.equal(rows[0]?.status, 'APPROVED')
    assert.equal(rows[0]?.decision_by_actor_id, HR_ACTOR)
    assert.ok(rows[0]?.decided_at instanceof Date || typeof rows[0]?.decided_at === 'string')

    // 重复批准 → APPROVAL_NOT_PENDING（不是二次写入）
    await assert.rejects(
      () => decideRubricApprovalInTransaction(client, cfg, { approval_id: approvalId, decision: 'APPROVE' }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'APPROVAL_NOT_PENDING')
        return true
      },
    )

    // REJECT 缺 reason → REASON_REQUIRED（在一条新的 PENDING 审批上）
    const forReject = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（拒绝缺理由）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    await assert.rejects(
      () => decideRubricApprovalInTransaction(client, cfg, {
        approval_id: forReject.rubric?.approval.approval_id as string,
        decision: 'REJECT',
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'REASON_REQUIRED')
        return true
      },
    )
  })
})

test('⑥ 租户隔离：另一个 tenant_id 的 cfg 调 update → JOB_NOT_FOUND；调 approval → APPROVAL_NOT_FOUND', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（租户隔离）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    // 只换 tenant_id 会先被"actor 不在该租户"的 fail-closed 检查挡住（FORBIDDEN），
    // 那样证明不了 job/approval 查询真的按 tenant 过滤。所以先在事务里建第二个租户
    // 与其自己的 HUMAN actor，再拿它去越权。
    const otherActorId = '22222222-2222-4222-8222-000000000103'
    await client.query(
      'insert into recruitment.organization (id, name) values ($1, $2)',
      [OTHER_TENANT, '第二演示租户（集成测试）'],
    )
    await client.query(
      `insert into recruitment.actor (id, tenant_id, kind, display_name)
       values ($1, $2, 'HUMAN', $3)`,
      [otherActorId, OTHER_TENANT, '第二租户 HR'],
    )
    const otherCfg = { ...cfg, tenant_id: OTHER_TENANT, actor_id: otherActorId }

    await assert.rejects(
      () => updateJobInTransaction(client, otherCfg, { job_id: created.job.id, title: '越权更新' }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'JOB_NOT_FOUND')
        return true
      },
    )

    await assert.rejects(
      () => decideRubricApprovalInTransaction(client, otherCfg, {
        approval_id: created.rubric?.approval.approval_id as string,
        decision: 'APPROVE',
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'APPROVAL_NOT_FOUND')
        return true
      },
    )
  })
})

test('⑦ J-1 库级兜底：直接 UPDATE rubric_version.dimensions 被数据库拒绝为 23514，旧行不变', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（版本不可变）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const rubricId = created.rubric?.version_id as string
    const before = await selectRows(client,
      'select dimensions, payload_hash from recruitment.rubric_version where id = $1', [rubricId])

    // 用 savepoint 隔离失败语句：证明"被拒"之后旧行仍然原样存在。
    await client.query('savepoint sp_rubric_immutable')
    await assert.rejects(
      () => client.query(
        `update recruitment.rubric_version set dimensions = $2::jsonb where id = $1`,
        [rubricId, JSON.stringify([{ key: 'tampered', label: '被改过', kind: 'MUST_HAVE', weight: 1 }])],
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, '23514', '必须是 check 违反（J-1 / fn_guard_columns）')
        return true
      },
    )
    await client.query('rollback to savepoint sp_rubric_immutable')

    const after = await selectRows(client,
      'select dimensions, payload_hash from recruitment.rubric_version where id = $1', [rubricId])
    assert.deepEqual(after[0]?.dimensions, before[0]?.dimensions)
    assert.equal(after[0]?.payload_hash, before[0]?.payload_hash)
  })
})
