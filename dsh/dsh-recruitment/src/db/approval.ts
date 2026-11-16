// 审批生效判定（**唯一口径**）。
//
// 为什么必须集中在一处（2026-11-16 产品视角复核 O8 的真实事故）：
//   `rubric_version` / `job_version` 都是**不可变表**（`trg_*_immutable`，J-1/J-5），
//   所以 `approved_by_approval_id` 永远保持 null（`job-rubric-approve.ts` §2 已写明）。
//   "已批准"的**唯一**判据是 `approval` 行：
//     status = 'APPROVED' ∧ canonical_payload_hash = 资源自身 payload_hash
//     ∧ superseded_by_approval_id is null ∧（expires_at is null or expires_at > now()）
//   （`contracts/job-screening/job-rubric-rules.md` §2.2 的权威列清单同口径）。
//   历史 bug：`recruiting.ts` 用 `(rv.approved_by_approval_id is not null)` 判批准 →
//   恒为 false → 工作台把"已批准"的 rubric v2 显示成"未批准"（HR 看到的不等于真的）。
//   本模块就是"同一份判定"的落点：读侧与写侧都从这里取，禁止再各写一遍 SQL。
import type { DatabaseClient } from './pool.ts'

/** 允许被审批的资源类型（封闭集，来自 `ck_approval_resource_type`）。 */
const APPROVAL_RESOURCE_TYPES = ['RUBRIC_VERSION', 'JOB_VERSION'] as const

/** 被审批的资源类型。 */
export type ApprovalResourceType = (typeof APPROVAL_RESOURCE_TYPES)[number]

/** SQL 别名白名单（别名只来自本仓代码常量，仍然校验，避免任何拼接注入面）。 */
const SQL_ALIAS = /^[a-z][a-z0-9_]{0,30}$/

/**
 * "该资源存在生效的 APPROVED 审批"的 EXISTS 片段。
 *
 * 调用方保证 `resourceAlias` 指向的表暴露 `id` / `tenant_id` / `payload_hash` 三列
 * （`rubric_version` 与 `job_version` 都有；这是把 hash 一起比对的必要条件）。
 *
 * @param params - 资源类型与两个表别名。
 * @returns 可直接拼进 `where` 的 `exists (...)` 片段。
 * @throws Error - 别名或资源类型不合法（编程错误，不是运行时数据问题）。
 */
export function effectiveApprovalExistsSql(params: {
  readonly resourceType: ApprovalResourceType
  /** 被审批资源的表别名（如 `rv` / `jv`）。 */
  readonly resourceAlias: string
  /** `approval` 的表别名（默认 `ap`）。 */
  readonly approvalAlias?: string
}): string {
  const resource = params.resourceAlias
  const approval = params.approvalAlias ?? 'ap'
  if (!SQL_ALIAS.test(resource) || !SQL_ALIAS.test(approval)) {
    throw new Error(`effectiveApprovalExistsSql: 非法 SQL 别名（resource=${resource} approval=${approval}）`)
  }
  if (!(APPROVAL_RESOURCE_TYPES as ReadonlyArray<string>).includes(params.resourceType)) {
    throw new Error(`effectiveApprovalExistsSql: 未知 resource_type ${String(params.resourceType)}`)
  }
  return `exists (
    select 1 from recruitment.approval ${approval}
     where ${approval}.tenant_id = ${resource}.tenant_id
       and ${approval}.resource_type = '${params.resourceType}'
       and ${approval}.resource_id = ${resource}.id
       and ${approval}.status = 'APPROVED'
       and ${approval}.canonical_payload_hash = ${resource}.payload_hash
       and ${approval}.superseded_by_approval_id is null
       and (${approval}.expires_at is null or ${approval}.expires_at > now())
  )`
}

/**
 * 单个 rubric 版本此刻是否"已批准"（只读；与 `application-intake.ts` 的
 * `resolvePinnableRubricVersion` 同一判据的只读子集）。
 *
 * @param client - 只读/读写事务内的客户端。
 * @param tenantId - 租户 id。
 * @param rubricVersionId - 要判定的 rubric 版本 id。
 * @returns 有生效 APPROVED 审批 → true；否则 false（含"该 id 不存在"）。
 */
export async function isRubricVersionApproved(
  client: DatabaseClient,
  tenantId: string,
  rubricVersionId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ approved: boolean }>(
    `select ${effectiveApprovalExistsSql({ resourceType: 'RUBRIC_VERSION', resourceAlias: 'rv' })} as approved
       from recruitment.rubric_version rv
      where rv.tenant_id = $1::uuid and rv.id = $2::uuid`,
    [tenantId, rubricVersionId],
  )
  return rows[0]?.approved === true
}
