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
  JOB_RUBRIC_APPROVE_TOOL,
  approveRubricInTransaction,
  createJobRubricApproveTool,
  makeApprovalRequest,
} from '../../src/tools/job-rubric-approve.ts'
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

/** 一条 criterion 的输入形（只有实际给出的键；写侧负责投影到封闭 9 键子集，缺省键省略）。 */
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

    // 输出回显的是**规范化后的诚实形状**：机械型只有 key/label/kind/weight/field/operator/value，
    // 没给的 question/notes **不补 null**（判断型则相反：没有 field/operator/value 键）。
    assert.equal(value.rubric?.criteria.length, 2)
    for (const criterion of value.rubric?.criteria ?? []) {
      assert.deepEqual(
        Object.keys(criterion as Record<string, unknown>).sort(),
        ['field', 'key', 'kind', 'label', 'operator', 'value', 'weight'],
      )
      assert.equal(Object.hasOwn(criterion as Record<string, unknown>, 'question'), false)
      assert.equal(Object.hasOwn(criterion as Record<string, unknown>, 'notes'), false)
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

// ---------------------------------------------------------------------------
//  ⑧–⑭ rubric 批准入口（`recruitment_job_rubric_approve`，docs/23 N7）
//      真实库上验证：PENDING→APPROVED、current 指针、D-79 闸门零写入、幂等、错误面。
// ---------------------------------------------------------------------------

/** `inRolledBackTx` 里的事务客户端类型（避免在辅助函数里重复长类型）。 */
type TxClient = Parameters<Parameters<typeof inRolledBackTx>[1]>[0]

/** 一次批准调用前后的可比较快照（零写入断言靠它）。 */
interface ApproveSnapshot {
  readonly pointer: string | null
  readonly jobRecordVersion: number
  readonly approvalStatus: string | undefined
  readonly approvalDecisionBy: string | null
  readonly approvalRecordVersion: number | undefined
  readonly approveEvents: number
}

/**
 * 取岗位指针 / record_version / 审批状态 / 本工具的审计事件条数。
 * @param client - 事务内客户端。
 * @param jobId - 岗位 id。
 * @param rubricId - rubric 版本 id（审计事件按 source_object_id 过滤）。
 */
async function approveSnapshot(client: TxClient, jobId: string, rubricId: string): Promise<ApproveSnapshot> {
  const jobRows = await selectRows(client,
    'select current_rubric_version_id, record_version from recruitment.job where id = $1', [jobId])
  const job = jobRows[0] as Record<string, unknown>
  const approvalRows = await selectRows(client,
    `select a.status, a.decision_by_actor_id, a.record_version
       from recruitment.approval a
       join recruitment.rubric_version r on r.id = a.resource_id and r.tenant_id = a.tenant_id
      where r.job_id = $1 and a.resource_id = $2
      order by a.created_at, a.id`, [jobId, rubricId])
  const approval = approvalRows[0] as Record<string, unknown> | undefined
  const eventRows = await selectRows(client,
    `select count(*)::int as n from recruitment.event_inbox
      where tenant_id = $1 and event_type = 'job.rubric_version.approved' and source_object_id = $2`,
    [TENANT, rubricId])
  return {
    pointer: (job.current_rubric_version_id as string | null) ?? null,
    jobRecordVersion: job.record_version as number,
    approvalStatus: approval?.status as string | undefined,
    approvalDecisionBy: (approval?.decision_by_actor_id as string | null) ?? null,
    approvalRecordVersion: approval?.record_version as number | undefined,
    approveEvents: eventRows[0]?.n as number,
  }
}

/** 计数器版 allow：既返回 `allowed-once`，又能断言"到底有没有打扰人"。 */
function countingAllow(): { approve: () => Promise<'allowed-once'>; calls: () => number } {
  let calls = 0
  return {
    approve: async () => {
      calls += 1
      return 'allowed-once' as const
    },
    calls: () => calls,
  }
}

/** 断言"零写入"：快照逐字段不变。 */
function assertApproveNoWrites(before: ApproveSnapshot, after: ApproveSnapshot, label: string): void {
  assert.deepEqual(after, before, `${label}：批准被拒时不得有任何写入`)
}

test('⑧ 批准正向：PENDING→APPROVED、责任人=HUMAN actor、current 指针指向该版本、两条审计事件', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（rubric 批准正向）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const approvalId = created.rubric?.approval.approval_id as string
    const before = await approveSnapshot(client, jobId, rubricId)
    assert.equal(before.pointer, null, '新建岗位的 current 指针必须为空（D-21 的合法初始态）')
    assert.equal(before.approvalStatus, 'PENDING')
    assert.equal(before.approveEvents, 0)

    const allow = countingAllow()
    const value = await approveRubricInTransaction(client, cfg, {
      job_id: jobId,
      rubric_version_id: rubricId,
      reason: 'S3 集成测试：标准已对齐',
    }, allow.approve)

    assert.equal(allow.calls(), 1, '写库前必须恰好问人一次（D-79）')
    assert.equal(value.tool, JOB_RUBRIC_APPROVE_TOOL)
    assert.equal(value.outcome, 'APPROVED')
    assert.equal(value.replayed, false)
    assert.deepEqual(value.gate, { requested: true, result: 'allowed-once' })
    assert.deepEqual(value.labels, { provenance: 'FIXTURE', trigger: 'MANUAL', connection: 'NOT_CONNECTED' })
    assert.equal(value.rubric.version_id, rubricId)
    assert.equal(value.rubric.is_approved, true)
    assert.equal(value.rubric.is_current, true)
    assert.equal(value.approval.approval_id, approvalId)
    assert.equal(value.approval.status, 'APPROVED')
    assert.equal(value.approval.decided_by_actor_id, HR_ACTOR)
    assert.equal(value.approval.canonical_payload_hash, created.rubric?.payload_hash)
    assert.equal(value.job.current_rubric_version_id, rubricId)
    // 首次批准时旧指针是 NULL → previous 键必须**省略**（不许 null）。
    assert.equal(Object.hasOwn(value.job, 'previous_current_rubric_version_id'), false)
    assert.equal(value.changes.written, true)
    assert.deepEqual(value.changes.tables, ['approval', 'job', 'event_inbox'])
    assert.equal(value.changes.event_ids.length, 1)
    assert.equal(value.next_action.kind, 'READ_BACK')

    const after = await approveSnapshot(client, jobId, rubricId)
    assert.equal(after.pointer, rubricId, '批准后 current 指针必须指向已批准版本')
    assert.ok(after.jobRecordVersion > before.jobRecordVersion, '指针变更由 fn_row_guard 自增 record_version')
    assert.equal(value.job.record_version, after.jobRecordVersion, '输出里的 record_version 必须是 RETURNING 的真实值')
    assert.equal(after.approvalStatus, 'APPROVED')
    assert.equal(after.approvalDecisionBy, HR_ACTOR)
    assert.ok((after.approvalRecordVersion as number) > (before.approvalRecordVersion as number))
    assert.equal(after.approveEvents, 1, '本工具必须恰好写一条 job.rubric_version.approved 事件')

    // 审计证据 1：批准迁移由 fn_row_guard 写（approval.status_source_event_id 可回查）。
    const triggerEvents = await selectRows(client,
      `select event_id, payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'approval.status.changed' and source_object_id = $2`,
      [TENANT, approvalId])
    assert.equal(triggerEvents.length, 1)
    const triggerPayload = triggerEvents[0]?.payload as Record<string, unknown>
    assert.equal(triggerPayload.from, 'PENDING')
    assert.equal(triggerPayload.to, 'APPROVED')
    assert.equal(triggerPayload.actor_id, HR_ACTOR)
    const approvalRows = await selectRows(client,
      'select status_source_event_id from recruitment.approval where id = $1', [approvalId])
    assert.equal(approvalRows[0]?.status_source_event_id, triggerEvents[0]?.event_id)

    // 审计证据 2：本工具写的内部事件（含 previous→current 指针与责任人）。
    const ourEvents = await selectRows(client,
      `select event_id, payload from recruitment.event_inbox
        where tenant_id = $1 and event_type = 'job.rubric_version.approved' and source_object_id = $2`,
      [TENANT, rubricId])
    assert.equal(ourEvents.length, 1)
    assert.equal(ourEvents[0]?.event_id, value.changes.event_ids[0])
    const payload = ourEvents[0]?.payload as Record<string, unknown>
    assert.equal(payload.job_id, jobId)
    assert.equal(payload.rubric_version_id, rubricId)
    assert.equal(payload.approval_id, approvalId)
    assert.equal(payload.approved_by_actor_id, HR_ACTOR)
    assert.equal(payload.previous_current_rubric_version_id, null)
    assert.equal(payload.current_rubric_version_id, rubricId)
    assert.equal(payload.pointer_changed, true)
    assert.equal(payload.outcome, 'APPROVED')
    assert.equal(payload.source, JOB_RUBRIC_APPROVE_TOOL)
    assert.equal(payload.reason, 'S3 集成测试：标准已对齐')

    // J-1：rubric_version 行仍不可变/未改（approval 只存在于 approval 行与 hash 绑定）。
    const rubricRows = await selectRows(client,
      'select payload_hash, approved_by_approval_id from recruitment.rubric_version where id = $1', [rubricId])
    assert.equal(rubricRows[0]?.approved_by_approval_id, null, '旧指针列永远留空（J-1 不变量）')
    assert.equal(rubricRows[0]?.payload_hash, created.rubric?.payload_hash)
  })
})

test('⑨ 幂等：同一版本重复批准 → NO_OP、replayed=true、不问人、零额外写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（rubric 批准幂等）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const first = await approveRubricInTransaction(
      client, cfg, { job_id: jobId, rubric_version_id: rubricId }, countingAllow().approve,
    )
    assert.equal(first.outcome, 'APPROVED')
    const before = await approveSnapshot(client, jobId, rubricId)

    const allow = countingAllow()
    const second = await approveRubricInTransaction(
      client, cfg, { job_id: jobId, rubric_version_id: rubricId }, allow.approve,
    )
    assert.equal(allow.calls(), 0, '纯重放不得打扰人（D-95）')
    assert.equal(second.outcome, 'NO_OP')
    assert.equal(second.replayed, true)
    assert.deepEqual(second.gate, { requested: false, result: 'not-required' })
    assert.equal(second.changes.written, false)
    assert.deepEqual(second.changes.tables, [])
    assert.deepEqual(second.changes.event_ids, [])
    assert.equal(second.approval.status, 'APPROVED')
    assert.equal(Object.hasOwn(second.job, 'previous_current_rubric_version_id'), false)

    const after = await approveSnapshot(client, jobId, rubricId)
    assertApproveNoWrites(before, after, 'NO_OP')
  })
})

test('⑩a 闸门拒绝（缺通道）：FORBIDDEN(APPROVAL_UNAVAILABLE)，审批/指针/事件零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（无 approval 通道）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const before = await approveSnapshot(client, jobId, rubricId)

    await assert.rejects(
      () => approveRubricInTransaction(client, cfg, { job_id: jobId, rubric_version_id: rubricId }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'APPROVAL_UNAVAILABLE')
        assert.deepEqual(body.detail, { approval: 'unavailable', tool: JOB_RUBRIC_APPROVE_TOOL })
        return true
      },
    )
    assertApproveNoWrites(before, await approveSnapshot(client, jobId, rubricId), '缺 approval 通道')
  })
})

test('⑩b 闸门拒绝（rejected / timeout）：FORBIDDEN(APPROVAL_NOT_GRANTED)，零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（人工拒绝）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const before = await approveSnapshot(client, jobId, rubricId)

    // 人在宿主里点了 Reject。
    await assert.rejects(
      () => approveRubricInTransaction(
        client, cfg, { job_id: jobId, rubric_version_id: rubricId }, async () => 'rejected',
      ),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'APPROVAL_NOT_GRANTED')
        assert.deepEqual(body.detail, { approval: 'rejected', tool: JOB_RUBRIC_APPROVE_TOOL })
        return true
      },
    )
    assertApproveNoWrites(before, await approveSnapshot(client, jobId, rubricId), 'approval=rejected')

    // 宿主永远不回答：注入 25ms 超时（生产 120s）→ 按 cancelled 判，仍然零写入。
    const approve = makeApprovalRequest(
      { request: () => new Promise<string>(() => undefined) },
      undefined,
      25,
    )
    await assert.rejects(
      () => approveRubricInTransaction(client, cfg, { job_id: jobId, rubric_version_id: rubricId }, approve),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'FORBIDDEN')
        assert.equal(body.reason_code, 'APPROVAL_NOT_GRANTED')
        assert.deepEqual(body.detail, { approval: 'timeout', tool: JOB_RUBRIC_APPROVE_TOOL })
        return true
      },
    )
    assertApproveNoWrites(before, await approveSnapshot(client, jobId, rubricId), 'approval=timeout')
  })
})

test('⑪ 业务校验失败（版本不存在 / 跨岗位版本 / 岗位不存在）→ 不去问人、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（错误面）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const before = await approveSnapshot(client, jobId, rubricId)
    const allow = countingAllow()

    // (a) 该岗位下没有这个版本（UUID 合法但库里没有）。
    await assert.rejects(
      () => approveRubricInTransaction(client, cfg, {
        job_id: jobId,
        rubric_version_id: '00000000-0000-4000-8000-0000000000aa',
      }, allow.approve),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'RUBRIC_VERSION_NOT_FOUND')
        const detail = body.detail as Record<string, unknown>
        assert.deepEqual(detail.known_version_nos, [1])
        return true
      },
    )

    // (b) 版本属于**另一个**岗位 → 同一错误码（0005：版本不得跨 job 引用）。
    const other = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（另一个岗位的版本）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    await assert.rejects(
      () => approveRubricInTransaction(client, cfg, {
        job_id: jobId,
        rubric_version_id: other.rubric?.version_id as string,
      }, allow.approve),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'RUBRIC_VERSION_NOT_FOUND')
        return true
      },
    )

    // (c) 岗位不存在。
    await assert.rejects(
      () => approveRubricInTransaction(client, cfg, {
        job_id: '00000000-0000-4000-8000-0000000000bb',
        rubric_version_id: rubricId,
      }, allow.approve),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'NOT_FOUND')
        assert.equal(body.reason_code, 'JOB_NOT_FOUND')
        return true
      },
    )

    assert.equal(allow.calls(), 0, '注定失败的调用不得先弹窗打扰人')
    assertApproveNoWrites(before, await approveSnapshot(client, jobId, rubricId), '业务校验失败')
  })
})

test('⑫ 批准已批准版本（CLI 遗留的陈旧指针）：CURRENT_UPDATED 补指针；再调一次 → NO_OP', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（CLI 已批准但指针未维护）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const approvalId = created.rubric?.approval.approval_id as string

    // 模拟既有 CLI（`manual/job-line/approve-rubric.mjs`）：只批 approval，**不动指针**。
    const cli = await decideRubricApprovalInTransaction(client, cfg, {
      approval_id: approvalId,
      decision: 'APPROVE',
    })
    const before = await approveSnapshot(client, jobId, rubricId)
    assert.equal(before.pointer, null, 'CLI 批准不维护 current 指针 —— 这正是 N7 的断点')
    assert.equal(before.approvalStatus, 'APPROVED')
    assert.equal(before.approveEvents, 0, 'CLI 批准不写本工具的审计事件')

    const allow = countingAllow()
    const repaired = await approveRubricInTransaction(
      client, cfg, { job_id: jobId, rubric_version_id: rubricId }, allow.approve,
    )
    assert.equal(allow.calls(), 1, '补指针会改业务可见状态，必须过闸门')
    assert.equal(repaired.outcome, 'CURRENT_UPDATED')
    assert.equal(repaired.replayed, true)
    assert.deepEqual(repaired.gate, { requested: true, result: 'allowed-once' })
    assert.equal(repaired.job.current_rubric_version_id, rubricId)
    assert.equal(Object.hasOwn(repaired.job, 'previous_current_rubric_version_id'), false)
    assert.deepEqual(repaired.changes.tables, ['job', 'event_inbox'], '已批准 → 不再写 approval 行')
    assert.equal(repaired.approval.decided_by_actor_id, HR_ACTOR)
    assert.equal(repaired.approval.record_version, cli.record_version, '补指针不得改 approval 行')

    const after = await approveSnapshot(client, jobId, rubricId)
    assert.equal(after.pointer, rubricId)
    assert.equal(after.approveEvents, 1, '补指针必须留一条审计事件')

    // 再调一次：批准已生效 + 指针已对齐 → 纯 NO_OP。
    const secondAllow = countingAllow()
    const noop = await approveRubricInTransaction(
      client, cfg, { job_id: jobId, rubric_version_id: rubricId }, secondAllow.approve,
    )
    assert.equal(secondAllow.calls(), 0)
    assert.equal(noop.outcome, 'NO_OP')
    assert.equal(noop.replayed, true)
    assert.deepEqual(noop.changes, { written: false, tables: [], event_ids: [] })
    assertApproveNoWrites(after, await approveSnapshot(client, jobId, rubricId), 'CURRENT_UPDATED 后的 NO_OP')
  })
})

test('⑬ 批准被拒版本：INVALID_ARGS(APPROVAL_NOT_PENDING)，不打扰人、零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const created = await createJobInTransaction(client, cfg, {
      title: 'S3 集成岗位（已拒绝的审批）',
      code: jobCode(),
      department_id: DEMO_DEPARTMENT,
      criteria: CRITERIA_V1,
    })
    const jobId = created.job.id
    const rubricId = created.rubric?.version_id as string
    const approvalId = created.rubric?.approval.approval_id as string
    await decideRubricApprovalInTransaction(client, cfg, {
      approval_id: approvalId,
      decision: 'REJECT',
      reason: 'S3 集成测试：标准与岗位不符',
    })
    const before = await approveSnapshot(client, jobId, rubricId)
    const allow = countingAllow()

    await assert.rejects(
      () => approveRubricInTransaction(
        client, cfg, { job_id: jobId, rubric_version_id: rubricId }, allow.approve,
      ),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'APPROVAL_NOT_PENDING')
        assert.equal((body.detail as Record<string, unknown>).status, 'REJECTED')
        return true
      },
    )
    assert.equal(allow.calls(), 0, '已拒的审批不得再弹窗')
    assertApproveNoWrites(before, await approveSnapshot(client, jobId, rubricId), '已拒版本')
  })
})

test('⑭ 工具对象 execute() 入口（真实配置）：走到事务核心并把契约错误原样抛出（零写入）', async () => {
  let gateCalls = 0
  const tool = createJobRubricApproveTool(cfg, {
    approval: {
      async request(): Promise<string> {
        gateCalls += 1
        return 'rejected'
      },
    },
  })
  assert.equal(tool.name, JOB_RUBRIC_APPROVE_TOOL)
  await assert.rejects(
    () => tool.execute({
      job_id: '00000000-0000-4000-8000-0000000000cc',
      rubric_version_id: '00000000-0000-4000-8000-0000000000dd',
    }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'NOT_FOUND')
      assert.equal(body.reason_code, 'JOB_NOT_FOUND')
      return true
    },
  )
  assert.equal(gateCalls, 0, '业务校验就拒了，不得去问人（D-79 之前的所有校验）')

  // 参数层负例也在 execute 入口就拒（不连库）。
  await assert.rejects(
    () => tool.execute({ job_id: 'job_0001', rubric_version_id: '00000000-0000-4000-8000-0000000000dd' }, {}),
    (error: unknown) => {
      const body = errorBody(error)
      assert.equal(body.code, 'INVALID_ARGS')
      assert.equal(body.reason_code, 'ID_NOT_UUID')
      return true
    },
  )
})
