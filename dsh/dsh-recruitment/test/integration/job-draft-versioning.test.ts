// 岗位/Rubric 草案 → **现有版本化写入路径** 集成测（真库 ra_s6s7，每个用例都在回滚事务里跑）。
//
// 证明的缝隙点（R3 / D5 joblife A）：
//   1. `toJobCreateArgs(draft)` 的产物能被现有 `createJobInTransaction` 原样接受：
//      job / job_version(v1) / rubric_version(v1) / approval(PENDING) 四行真写进库；
//   2. 版本号 = 1、`rubric_version.payload_hash == digestOf(dimensions)`（R-VAL-14 的写侧一半）、
//      并且等于草案 criteria 的 canonical hash（草案 → 落库没有第二个 hash）；
//   3. 人类闸门未被 Agent 越过：approval 仍是 PENDING、`job.current_rubric_version_id` 仍为空、
//      `rubric_version.approved_by_approval_id` 永远为空（J-1 / §4.2 第 3 条）；
//   4. 草案生成本身**零写入**（生成前后四张表计数逐字段相等）；反例（篡改权重 / 受保护字段 /
//      `field:null`）在 domain 与 job_create 两层各自 fail-closed，且行数不变。
//
// 纪律：用 `inRolledBackTx`（REPEATABLE READ + 必然 ROLLBACK），**不提交**、不写 ra_s6s7 持久状态。
// 为什么不在集成测里调 `recruitment_job_get`：它自己开连接池读**已提交**数据，回滚事务里看不到本事务的行。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  JobDraftError,
  buildJobDraft,
  parseJobDraftInput,
  toJobCreateArgs,
  type JobDraft,
} from '../../src/domain/job-draft.ts'
import { digestOf } from '../../src/tools/contract.ts'
import { createJobInTransaction } from '../../src/tools/job-create.ts'
import { validateDimensions } from '../../src/tools/screening-evaluate.ts'
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

const SAMPLE_REQUEST = '我们要招一名后端工程师，做支付系统，最好有大厂经验'

/** 事务客户端类型（避免在辅助函数里重复长类型）。 */
type TxClient = Parameters<Parameters<typeof inRolledBackTx>[1]>[0]

/** 本次运行唯一的岗位 code（`^[A-Za-z0-9][A-Za-z0-9._-]{1,40}$`）。 */
function jobCode(prefix: string): string {
  return `${prefix}-${uniqueSuffix()}`.slice(0, 41)
}

/** 一份带部门上下文的输入（部门由"企业上下文"给出，不是草案编造）。 */
function draftInput() {
  return {
    request_text: SAMPLE_REQUEST,
    department_context: {
      department_id: DEMO_DEPARTMENT,
      department_name: '研发部（演示）',
    },
  }
}

/** 四张关键表的租户内行数（零写入断言靠它）。 */
interface TableCounts {
  job: number
  job_version: number
  rubric_version: number
  approval: number
}

/**
 * 读回本租户的四张表行数。
 * @param client - 事务内客户端。
 */
async function tableCounts(client: TxClient): Promise<TableCounts> {
  const { rows } = await client.query<TableCounts>(
    `select
       (select count(*)::int from recruitment.job where tenant_id = $1) as job,
       (select count(*)::int from recruitment.job_version where tenant_id = $1) as job_version,
       (select count(*)::int from recruitment.rubric_version where tenant_id = $1) as rubric_version,
       (select count(*)::int from recruitment.approval where tenant_id = $1) as approval`,
    [TENANT],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('tableCounts returned no row')
  return row
}

/** 读一组行（只用于断言，不改数据）。 */
async function selectRows(client: TxClient, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const result = await client.query(sql, [...params])
  return result.rows as Record<string, unknown>[]
}

test('① 草案 → createJobInTransaction：job/job_version(v1)/rubric_version(v1)/approval(PENDING) 真写并读回', async () => {
  await inRolledBackTx(pool, async (client) => {
    const before = await tableCounts(client)

    // 同输入两次生成的草案必须逐字节一致（deterministic），且生成过程零写入。
    const draft = buildJobDraft(parseJobDraftInput(draftInput()))
    const again = buildJobDraft(parseJobDraftInput(draftInput()))
    assert.equal(JSON.stringify(draft), JSON.stringify(again), '同输入两次草案必须逐字节一致')
    const afterDraft = await tableCounts(client)
    assert.deepEqual(afterDraft, before, '草案生成必须零写入（四张表行数不变）')

    // 草案 → job_create 入参：criteria 已过 R-VAL，部门只给 id（不与名称同时出现）。
    const args = toJobCreateArgs(draft)
    assert.equal(args.status, 'DRAFT')
    assert.equal(args.department_id, DEMO_DEPARTMENT)
    assert.equal(Object.hasOwn(args, 'department_name'), false)
    assert.deepEqual(validateDimensions(args.criteria), [])
    assert.equal(JSON.stringify(args.criteria).includes('null'), false)

    const code = jobCode('DRAFT')
    const value = await createJobInTransaction(client, cfg, { ...args, code })
    assert.equal(value.outcome, 'CREATED')
    assert.equal(value.tool, 'recruitment_job_create')
    assert.equal(value.department.id, DEMO_DEPARTMENT)
    const createdJobVersionId = value.job_version?.id
    assert.equal(typeof createdJobVersionId, 'string', 'CREATED 必须带 job_version')

    // ---- job 行 ----
    const jobRows = await selectRows(client,
      `select id, code, title, status, department_id, current_job_version_id, current_rubric_version_id, record_version
         from recruitment.job where id = $1 and tenant_id = $2`, [value.job.id, TENANT])
    assert.equal(jobRows.length, 1, 'job 行必须存在')
    const job = jobRows[0] as Record<string, unknown>
    assert.equal(job.code, code)
    assert.equal(job.title, draft.job.title)
    assert.equal(job.status, 'DRAFT', '草案只建议 DRAFT，不擅自 OPEN')
    assert.equal(job.department_id, DEMO_DEPARTMENT)
    assert.equal(job.current_job_version_id, createdJobVersionId)
    assert.equal(job.current_rubric_version_id, null, '审批未通过 → current rubric 指针必须为空（D-21/D-48）')

    // ---- job_version v1（JD 正文来自草案，逐字读回）----
    const jobVersionRows = await selectRows(client,
      `select id, version_no, description_md, requirements_md, payload_hash, approved_by_approval_id
         from recruitment.job_version where job_id = $1 order by version_no`, [value.job.id])
    assert.equal(jobVersionRows.length, 1)
    const jobVersion = jobVersionRows[0] as Record<string, unknown>
    assert.equal(jobVersion.version_no, 1, '草案 → 首个 job_version 必须是 v1')
    assert.equal(jobVersion.description_md, args.description_md)
    assert.equal(jobVersion.requirements_md, args.requirements_md)
    assert.equal(jobVersion.payload_hash, digestOf({
      description_md: args.description_md,
      requirements_md: args.requirements_md,
    }))
    assert.equal(jobVersion.approved_by_approval_id, null, '批准状态只能由 approval 行的 EXISTS 判（J-1）')

    // ---- rubric_version v1：hash 必须是 digestOf(dimensions)，且等于草案 criteria 的 hash ----
    const rubricRows = await selectRows(client,
      `select id, version_no, dimensions, payload_hash, approved_by_approval_id
         from recruitment.rubric_version where job_id = $1 order by version_no`, [value.job.id])
    assert.equal(rubricRows.length, 1)
    const rubric = rubricRows[0] as Record<string, unknown>
    assert.equal(rubric.version_no, 1, '草案 → 首个 rubric_version 必须是 v1')
    assert.equal(rubric.payload_hash, digestOf(rubric.dimensions), 'R-VAL-14：payload_hash 必须等于 sha256(canonical_json(dimensions))')
    assert.equal(rubric.payload_hash, digestOf(args.criteria), '草案 criteria 与落库 dimensions 必须是同一个 hash（没有第二个版本口径）')
    assert.equal(rubric.payload_hash, value.rubric?.payload_hash)
    assert.equal(rubric.approved_by_approval_id, null)
    // JSONB 往返后 criteria 内容不变（键序由 jsonb 归一化，deepEqual 不看键序）
    assert.deepEqual(rubric.dimensions, args.criteria)
    assert.deepEqual(value.rubric?.criteria, args.criteria)

    // ---- approval：只可能是 PENDING（Agent 没有替人批准）----
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
    assert.equal(approval.canonical_payload_hash, rubric.payload_hash, '审批绑定的是 canonical_payload_hash（R-VAL-14）')
    assert.equal(approval.status, 'PENDING', '人类闸门尚未通过：approval 只能是 PENDING')
    assert.equal(approval.requested_by_actor_id, HR_ACTOR)
    assert.equal(approval.decision_by_actor_id, null, '没有人类决定者 = 没有被批准')
    assert.equal(approval.decided_at, null)
    assert.equal(value.rubric?.is_approved, false)
    assert.equal(value.rubric?.approval?.status, 'PENDING')
    assert.equal(value.next_action.kind, 'APPROVE_RUBRIC', '下一步只能是"请人批准标准"')

    // ---- 零写入基线 → 真写：四张表各 +1 ----
    const afterCreate = await tableCounts(client)
    assert.deepEqual(afterCreate, {
      job: before.job + 1,
      job_version: before.job_version + 1,
      rubric_version: before.rubric_version + 1,
      approval: before.approval + 1,
    })
  })
})

test('② 人类闸门：草案只产 PENDING_HUMAN_CONFIRMATION，写入后仍不会被 Agent 批准/设为 current', async () => {
  await inRolledBackTx(pool, async (client) => {
    const draft = buildJobDraft(parseJobDraftInput(draftInput()))
    assert.deepEqual(draft.confirmation, {
      required: true,
      status: 'PENDING_HUMAN_CONFIRMATION',
      next: ['recruitment_job_create', 'recruitment_job_rubric_approve'],
      note: '确认/修改必须由人完成',
    })
    assert.equal(draft.read_only, true)
    assert.equal(draft.zero_write, true)

    const args = toJobCreateArgs(draft)
    const value = await createJobInTransaction(client, cfg, { ...args, code: jobCode('GATE') })

    const rubricRows = await selectRows(client,
      'select id, payload_hash from recruitment.rubric_version where job_id = $1', [value.job.id])
    const rubricId = rubricRows[0]?.id as string
    const jobRows = await selectRows(client,
      'select current_rubric_version_id, record_version from recruitment.job where id = $1', [value.job.id])
    const afterRows = await selectRows(client,
      `select status, decision_by_actor_id from recruitment.approval a
         join recruitment.rubric_version r on r.id = a.resource_id
        where r.job_id = $1`, [value.job.id])
    assert.equal(jobRows[0]?.current_rubric_version_id, null, '没有人类批准 → current 指针保持为空')
    assert.equal(afterRows[0]?.status, 'PENDING')
    assert.equal(afterRows[0]?.decision_by_actor_id, null)
    assert.equal(typeof rubricId, 'string')

    // 草案侧没有任何"批准/改状态"入口：同一份草案再次生成，结果只是文本，不产生库变化。
    const snapshot = await tableCounts(client)
    const second = buildJobDraft(parseJobDraftInput(draftInput()))
    assert.equal(JSON.stringify(second), JSON.stringify(draft))
    assert.deepEqual(await tableCounts(client), snapshot, '重复生成草案不得写库')
  })
})

test('③ 反证（L5）：篡改权重 / 受保护字段 / field:null 在两层 fail-closed，且目标表零写入', async () => {
  await inRolledBackTx(pool, async (client) => {
    const draft = buildJobDraft(parseJobDraftInput(draftInput()))
    const before = await tableCounts(client)

    // (a) 篡改 weight（Σ=1.9）：domain 层的最后一道闸先拒（不产出可写入的 args）。
    const tampered: JobDraft = {
      ...draft,
      rubric_draft: {
        ...draft.rubric_draft,
        criteria: draft.rubric_draft.criteria.map((criterion, index) => index === 0
          ? { ...criterion, weight: 1.9 }
          : criterion),
      },
    }
    assert.throws(
      () => toJobCreateArgs(tampered),
      (error: unknown) => {
        assert.ok(error instanceof JobDraftError)
        assert.equal(error.reason_code, 'CRITERIA_INVALID')
        const detail = error.detail as Record<string, unknown>
        assert.ok(Array.isArray(detail.violations) && (detail.violations as unknown[]).length > 0)
        return true
      },
      '篡改权重的草案不得映射成 job_create 入参',
    )

    // (b) 绕过 domain 直接把坏 criteria 喂现有写路径：job_create 的 R-VAL 闸必须拒绝。
    await assert.rejects(
      () => createJobInTransaction(client, cfg, {
        title: '草案反例（权重和不为 1）',
        code: jobCode('BAD'),
        department_id: DEMO_DEPARTMENT,
        description_md: '反例 JD',
        criteria: tampered.rubric_draft.criteria as readonly unknown[],
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'RUBRIC_INVALID')
        const detail = body.detail as Record<string, unknown>
        assert.ok(Array.isArray(detail.violations) && (detail.violations as unknown[]).length > 0)
        return true
      },
      '现有 job_create 必须拒绝不合 R-VAL 的 criteria',
    )

    // (c) 受保护属性（name）不能进标准：PROTECTED_ATTRIBUTE_IN_CRITERIA。
    await assert.rejects(
      () => createJobInTransaction(client, cfg, {
        title: '草案反例（受保护属性）',
        code: jobCode('PROT'),
        department_id: DEMO_DEPARTMENT,
        description_md: '反例 JD',
        criteria: [{
          key: 'name_field', label: '姓名', kind: 'MUST_HAVE', weight: 1,
          field: 'name', operator: 'EXISTS', value: true,
        }],
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'RUBRIC_INVALID')
        const codes = (body.detail as Record<string, unknown>).violations as { reason_code?: string }[]
        assert.ok(codes.some((violation) => violation.reason_code === 'PROTECTED_ATTRIBUTE_IN_CRITERIA'))
        return true
      },
    )

    // (d) `field: null` 这种旧写法（判断型占位）不得静默通过：归一化后缺 question → RUBRIC_INVALID。
    await assert.rejects(
      () => createJobInTransaction(client, cfg, {
        title: '草案反例（field:null）',
        code: jobCode('NULLF'),
        department_id: DEMO_DEPARTMENT,
        description_md: '反例 JD',
        criteria: [{
          key: 'judgment_null_field', label: '判断型但写了 null', kind: 'MUST_HAVE', weight: 1,
          field: null, operator: null, value: null, question: null, notes: null,
        }],
      }),
      (error: unknown) => {
        const body = errorBody(error)
        assert.equal(body.code, 'INVALID_ARGS')
        assert.equal(body.reason_code, 'RUBRIC_INVALID')
        return true
      },
      'null 占位不得被当成合法判断型（§6.1 的单一裁决）',
    )

    // 四次拒绝之后：目标表零写入。
    assert.deepEqual(await tableCounts(client), before, '所有反例必须零写入')
  })
})
