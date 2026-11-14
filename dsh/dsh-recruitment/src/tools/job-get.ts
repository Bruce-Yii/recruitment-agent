// recruitment_job_get —— 查一个岗位 + 它此刻适用的 Rubric 版本（只读，直连 PG）。
//
// 为什么必须查库（Issue #1 §3 的验收硬指标）：旧版是 stub，给真实 UUID 会回
// `job "…" not found; known stub ids: job_0001, job_0002`，等于让 fixture 冒充工具面。
// 本文件只发 SELECT：读路径包在 `withReadOnly()` 的只读事务里，写语句会被数据库
// 直接拒成 `25006 read_only_sql_transaction`，不是"源码里没写 INSERT"这种自觉。
//
// 契约：`contracts/job-screening/tool-contracts.md` §2（**取代** `CONTRACT.md` §5 的
// stub 版工具面：入参从 `rubric_version: string` 改成 integer/uuid 两种，`stub` 字段删除，
// `provenance` 变成计算值）。与 §2 冲突时以该文件为准。
//
// 三个"不"（`tool-contracts.md` §0）：
//   1. 不落决策、不写 `decision`；
//   2. 不钉 `application.rubric_version_id`（钉版本是写侧的动作）；
//   3. 不接受模型传入的 tenant_id / actor_id（`parseContractArgs` 会直接拒）。
//
// 缺标准不报错：`job_get` 是**描述世界**的工具。"这个岗位还没有 Rubric" 是一条
// 可被查出来的事实（`rubric_absence`），不是异常。拒绝执行是 `evaluate` 的职责。

import { parseContractArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { checkAsOf, contractError } from './contract.ts'
import { validateDimensions } from './screening-evaluate.ts'
// R4：`provenance` 的唯一判定实现（`contracts/tenant-provenance.md` §2）。
// 本工具**只读本产品业务库**，所以"读到了行"不等于"数据是真的"：演示租户的行同样真的在库里。
import { resolveTenantProvenance } from './candidate-get.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'

const TOOL_NAME = 'recruitment_job_get'
const CONTRACT_VERSION = '1.0.0'

/** 入参（`tool-contracts.md` §2.1）。 */
const PARAMS: ParamMap = {
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Job (requisition) id, UUID text form (e.g. 11111111-1111-4111-8111-000000000401). '
      + 'Stub ids such as "job_0001" are rejected with INVALID_ARGS(ID_NOT_UUID).',
  },
  rubric_version_no: {
    kind: 'integer',
    min: 1,
    max: 1000,
    description: 'Select this rubric version number (1-based). Mutually exclusive with rubric_version_id. '
      + 'Omit both to get the CURRENT version — i.e. the one job.current_rubric_version_id points at '
      + '(D-21/D-48), which is NOT necessarily the highest approved version_no.',
  },
  rubric_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Select this rubric version by id. Mutually exclusive with rubric_version_no.',
  },
  as_of: {
    kind: 'string',
    maxLength: 40,
    description: 'ISO-8601 timestamp WITH an offset (e.g. 2026-11-13T00:00:00+08:00), not in the future. '
      + 'Decides which rubric version counts as current/approved. Defaults to the server clock.',
  },
}

/** `job` 行（只取本工具要展示的列）。 */
interface JobRow {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly department_id: string
  readonly requisition_id: string | null
  readonly current_job_version_id: string | null
  /**
   * D-21 的显式"当前 rubric"指针：**"当前"只由它说话，不是 `max(version_no)`**（D-48：
   * 指针为空 = 没有当前版本，不回退推导）。
   */
  readonly current_rubric_version_id: string | null
  readonly record_version: number
  readonly status_changed_at: string | Date
}

/** `job_version` 行。 */
interface JobVersionRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly approved_by_approval_id: string | null
}

/** `rubric_version` 行。 */
interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly dimensions: readonly unknown[]
  readonly created_at: string | Date
  readonly approved_by_approval_id: string | null
  readonly created_by_actor_id: string | null
}

/** `approval` 行（判 `approved(v, as_of)` 只需要这几列）。 */
interface ApprovalRow {
  readonly resource_id: string
  readonly status: string
  readonly canonical_payload_hash: string
  readonly expires_at: string | Date | null
  readonly superseded_by_approval_id: string | null
}

/** 输出里的 rubric 块（`tool-contracts.md` §2.2）。 */
interface RubricValue {
  readonly version_id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly is_current: boolean
  readonly is_approved: boolean
  readonly approved_by_approval_id: string | null
  readonly created_by_actor_id: string | null
  readonly created_at: string
  readonly resolution: 'EXPLICIT_VERSION_NO' | 'EXPLICIT_VERSION_ID' | 'JOB_CURRENT'
  readonly criteria: readonly unknown[]
  readonly criteria_count: number
  readonly must_have_count: number
  readonly nice_to_have_count: number
  readonly disqualifier_count: number
  readonly executable: boolean
}

/** 输出规范值。 */
interface JobGetValue {
  readonly tool: string
  readonly contract_version: string
  readonly labels: {
    readonly provenance: 'LIVE' | 'FIXTURE'
    readonly trigger: 'MANUAL'
    readonly connection: 'CONNECTED' | 'NOT_CONNECTED'
  }
  readonly as_of: string
  readonly job: {
    readonly id: string
    readonly code: string
    readonly title: string
    readonly status: string
    readonly department_id: string
    readonly requisition_id: string | null
    readonly current_job_version_id: string | null
    readonly record_version: number
    readonly status_changed_at: string
  }
  readonly job_version: {
    readonly id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly description_md: string | null
    readonly requirements_md: string | null
    readonly approved_by_approval_id: string | null
  } | null
  readonly rubric: RubricValue | null
  readonly rubric_absence: {
    readonly code: 'NO_RUBRIC_AT_ALL' | 'NO_APPROVED_RUBRIC' | 'RUBRIC_INVALID'
    readonly message: string
    readonly violations: readonly unknown[]
  } | null
  readonly rubric_versions: readonly {
    readonly version_no: number
    readonly version_id: string
    readonly is_current: boolean
    readonly is_approved: boolean
    readonly created_at: string
  }[]
}

/** 规范输出 schema（只用官方强制子集：type/oneOf/properties/required/additionalProperties/items/enum/const）。 */
/** 可空对象的 schema 片段（官方子集没有 type 数组，用 oneOf 表达 null）。 */
const NULLABLE_OBJECT = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({
  oneOf: [
    { type: 'object', properties, required: [...required], additionalProperties: false },
    { type: 'null' },
  ],
})

/** 可空字符串（数据库允许 NULL 的列）。 */
const NULLABLE_STRING: Record<string, unknown> = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
}

const CRITERION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: "One criterion echoed verbatim from rubric_version.dimensions (keys are closed by the rubric contract).",
}

const VIOLATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  description: 'One R-VAL structural violation from the rubric contract.',
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['CONNECTED', 'NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    as_of: { type: 'string' },
    job: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        department_id: { type: 'string' },
        requisition_id: NULLABLE_STRING,
        current_job_version_id: NULLABLE_STRING,
        record_version: { type: 'integer' },
        status_changed_at: { type: 'string' },
      },
      required: [
        'id', 'code', 'title', 'status', 'department_id', 'requisition_id',
        'current_job_version_id', 'record_version', 'status_changed_at',
      ],
      additionalProperties: false,
    },
    job_version: NULLABLE_OBJECT({
      id: { type: 'string' },
      version_no: { type: 'integer' },
      payload_hash: { type: 'string' },
      description_md: NULLABLE_STRING,
      requirements_md: NULLABLE_STRING,
      approved_by_approval_id: NULLABLE_STRING,
    }, ['id', 'version_no', 'payload_hash', 'description_md', 'requirements_md', 'approved_by_approval_id']),
    rubric: NULLABLE_OBJECT({
      version_id: { type: 'string' },
      version_no: { type: 'integer' },
      payload_hash: { type: 'string' },
      is_current: { type: 'boolean' },
      is_approved: { type: 'boolean' },
      approved_by_approval_id: NULLABLE_STRING,
      created_by_actor_id: NULLABLE_STRING,
      created_at: { type: 'string' },
      resolution: { type: 'string', enum: ['EXPLICIT_VERSION_NO', 'EXPLICIT_VERSION_ID', 'JOB_CURRENT'] },
      criteria: { type: 'array', items: CRITERION_SCHEMA },
      criteria_count: { type: 'integer' },
      must_have_count: { type: 'integer' },
      nice_to_have_count: { type: 'integer' },
      disqualifier_count: { type: 'integer' },
      executable: { type: 'boolean' },
    }, [
      'version_id', 'version_no', 'payload_hash', 'is_current', 'is_approved',
      'approved_by_approval_id', 'created_by_actor_id', 'created_at', 'resolution',
      'criteria', 'criteria_count', 'must_have_count', 'nice_to_have_count',
      'disqualifier_count', 'executable',
    ]),
    rubric_absence: NULLABLE_OBJECT({
      code: { type: 'string', enum: ['NO_RUBRIC_AT_ALL', 'NO_APPROVED_RUBRIC', 'RUBRIC_INVALID'] },
      message: { type: 'string' },
      violations: { type: 'array', items: VIOLATION_SCHEMA },
    }, ['code', 'message', 'violations']),
    rubric_versions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          version_no: { type: 'integer' },
          version_id: { type: 'string' },
          is_current: { type: 'boolean' },
          is_approved: { type: 'boolean' },
          created_at: { type: 'string' },
        },
        required: ['version_no', 'version_id', 'is_current', 'is_approved', 'created_at'],
        additionalProperties: false,
      },
    },
  },
  required: ['tool', 'contract_version', 'labels', 'as_of', 'job', 'job_version', 'rubric', 'rubric_absence', 'rubric_versions'],
  additionalProperties: false,
}

/** `timestamptz` 可能是 pg 给的 `Date`，也可能是测试造的字符串。 */
function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}

/** 必填时间列 → ISO 文本。 */
function iso(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** 可空时间列 → ISO 文本或 null。 */
function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value)
}

/**
 * JR §4.2 `approved(v, as_of)`：版本存在、已批准、hash 对得上、未被取代、未过期。
 * 从这里**不**读 `rubric_version.approved_by_approval_id`——那是可空指针，不保证
 * 指向的审批是 APPROVED，也不保证 hash 一致（`job-rubric-rules.md` §4.2 第 3 条）。
 */
function approvedAt(version: RubricRow, approvals: readonly ApprovalRow[], asOfIso: string): ApprovalRow | null {
  const asOf = Date.parse(asOfIso)
  if (!Number.isFinite(asOf) || toMs(version.created_at) > asOf) return null
  for (const approval of approvals) {
    if (approval.resource_id !== version.id) continue
    if (approval.status !== 'APPROVED') continue
    if (approval.canonical_payload_hash !== version.payload_hash) continue
    if (approval.superseded_by_approval_id !== null) continue
    const expiresAt = toMs(approval.expires_at)
    if (Number.isFinite(expiresAt) && expiresAt <= asOf) continue
    return approval
  }
  return null
}

/**
 * `current(job, as_of)`：**只认 `job.current_rubric_version_id` 这个显式指针**（D-21 / D-48）。
 *
 * 为什么不再按 `max(version_no)` 推导：批准 v2 不等于把 v3 顶成当前，回滚到 v1 也只能
 * 靠指针表达。按最大值取会让"回滚"这个业务动作在只读侧完全看不见，并且和写侧
 * （`recruitment_job_rubric_approve` 维护指针）说出两个不同的"当前"。
 *
 * 指针为空 / 指向的版本不属于该岗位 → `undefined`（= 没有当前版本，**不回退**）。
 * **注意**：这里只回答"哪一版被指针指着"，不回答"它是否已批准" —— 那是
 * {@link approvedAt} 的事，两个事实分开报（`is_current` / `is_approved`）。
 * @param versions - 该岗位的全部 rubric 版本。
 * @param currentRubricVersionId - `job.current_rubric_version_id`。
 * @returns 指针指向的版本；没有则 `undefined`。
 */
function pickCurrent(
  versions: readonly RubricRow[],
  currentRubricVersionId: string | null,
): RubricRow | undefined {
  if (currentRubricVersionId === null) return undefined
  return versions.find((version) => version.id === currentRubricVersionId)
}

/** 统计 criterion 的 kind 分布；任何结构问题留给 `validateDimensions`。 */
function countKinds(criteria: readonly unknown[]): { must: number; nice: number; disq: number } {
  let must = 0
  let nice = 0
  let disq = 0
  for (const raw of criteria) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const kind = (raw as Record<string, unknown>).kind
    if (kind === 'MUST_HAVE') must += 1
    else if (kind === 'NICE_TO_HAVE') nice += 1
    else if (kind === 'DISQUALIFIER') disq += 1
  }
  return { must, nice, disq }
}

/** 按 §2.2 组装一条 rubric；`executable` 是 R-VAL-1..13 的结论，不吞掉 violations。 */
function rubricValue(
  resolved: RubricRow,
  current: RubricRow | undefined,
  approvals: readonly ApprovalRow[],
  asOfIso: string,
  resolution: RubricValue['resolution'],
): RubricValue {
  const violations = validateDimensions(resolved.dimensions)
  const counts = countKinds(resolved.dimensions)
  return {
    version_id: resolved.id,
    version_no: resolved.version_no,
    payload_hash: resolved.payload_hash,
    is_current: current !== undefined && current.id === resolved.id,
    is_approved: approvedAt(resolved, approvals, asOfIso) !== null,
    approved_by_approval_id: resolved.approved_by_approval_id,
    created_by_actor_id: resolved.created_by_actor_id,
    created_at: iso(resolved.created_at),
    resolution,
    criteria: resolved.dimensions,
    criteria_count: resolved.dimensions.length,
    must_have_count: counts.must,
    nice_to_have_count: counts.nice,
    disqualifier_count: counts.disq,
    executable: violations.length === 0,
  }
}

/** 契约错误 detail 里的已知版本号（升序）。 */
function knownVersionNos(versions: readonly RubricRow[]): readonly number[] {
  return versions.map((version) => version.version_no)
}

/**
 * 本工具出口的三维标签（R4，`contracts/tenant-provenance.md` §2 / §3）。
 *
 * `provenance` **只能**由 {@link resolveTenantProvenance} 按**这次调用**的租户事实算：
 * 演示租户 / 缺声明 / 有合成标记 ⇒ `FIXTURE`。`trigger` 与 `connection` 与它正交：
 * 本工具不被事件驱动（`MANUAL`），`connection` 按其工具契约解释为"直连业务库"（`CONNECTED`）。
 * @param provenance - 本次调用算出的数据真假（`LIVE` 只在有正面证据时出现）。
 * @returns 三轴标签对象（每次调用新建，不共享可变常量）。
 */
function jobGetLabels(provenance: 'LIVE' | 'FIXTURE'): JobGetValue['labels'] {
  return {
    provenance,
    trigger: 'MANUAL',
    connection: 'CONNECTED',
  }
}

/**
 * 在只读事务里跑完整查询 + 解析。
 * @param client - 只读事务内的客户端。
 * @param cfg - 已解析的数据库配置（tenant_id 只从这里来）。
 * @param args - 已校验的入参。
 * @param asOfIso - 本次判定的基准时刻（入参或服务端 now）。
 */
async function queryJob(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  asOfIso: string,
): Promise<JobGetValue> {
  const jobId = args.job_id as string
  const jobResult = await client.query<JobRow>(
    `select id, code, title, status, department_id, requisition_id, current_job_version_id,
            current_rubric_version_id, record_version, status_changed_at
       from recruitment.job
      where id = $1 and tenant_id = $2`,
    [jobId, cfg.tenant_id],
  )
  const job = jobResult.rows[0]
  if (job === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_NOT_FOUND',
      message: `该租户下没有岗位 ${jobId}`,
      detail: { job_id: jobId },
    })
  }

  // R4：provenance 反映**这次调用**的数据来源，不写死 `LIVE`。
  // 只读业务库 ⇒ 数据真假取决于该租户是否被显式声明为非合成（演示租户一律 FIXTURE）。
  const provenance = await resolveTenantProvenance(client, cfg.tenant_id)

  let jobVersion: JobVersionRow | undefined
  if (job.current_job_version_id !== null) {
    const versionResult = await client.query<JobVersionRow>(
      `select id, version_no, payload_hash, description_md, requirements_md, approved_by_approval_id
         from recruitment.job_version
        where id = $1 and tenant_id = $2`,
      [job.current_job_version_id, cfg.tenant_id],
    )
    jobVersion = versionResult.rows[0]
  }

  const rubricResult = await client.query<RubricRow>(
    `select id, version_no, payload_hash, dimensions, created_at,
            approved_by_approval_id, created_by_actor_id
       from recruitment.rubric_version
      where tenant_id = $1 and job_id = $2
      order by version_no`,
    [cfg.tenant_id, job.id],
  )
  const versions = rubricResult.rows

  // 只取本岗位 rubric 的审批行，避免把全租户审批读进内存。
  const approvalResult = await client.query<ApprovalRow>(
    `select a.resource_id, a.status, a.canonical_payload_hash, a.expires_at,
            a.superseded_by_approval_id
       from recruitment.approval a
       join recruitment.rubric_version r
         on r.id = a.resource_id and r.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.resource_type = 'RUBRIC_VERSION' and r.job_id = $2`,
    [cfg.tenant_id, job.id],
  )
  const approvals = approvalResult.rows

  const current = pickCurrent(versions, job.current_rubric_version_id)
  const currentOrNull = current === undefined ? null : current
  const requestedNo = args.rubric_version_no as number | undefined
  const requestedId = args.rubric_version_id as string | undefined

  let resolution: RubricValue['resolution']
  let resolved: RubricRow | undefined
  if (requestedId !== undefined) {
    resolution = 'EXPLICIT_VERSION_ID'
    resolved = versions.find((version) => version.id === requestedId)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `岗位 ${jobId} 下没有该 Rubric 版本 id`,
        detail: { job_id: jobId, rubric_version_id: requestedId, known_version_nos: knownVersionNos(versions) },
      })
    }
  } else if (requestedNo !== undefined) {
    resolution = 'EXPLICIT_VERSION_NO'
    resolved = versions.find((version) => version.version_no === requestedNo)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: `岗位 ${jobId} 下没有 Rubric v${requestedNo}`,
        detail: { job_id: jobId, requested_version_no: requestedNo, known_version_nos: knownVersionNos(versions) },
      })
    }
  } else {
    resolution = 'JOB_CURRENT'
    if (versions.length === 0) {
      return {
        tool: TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        labels: jobGetLabels(provenance),
        as_of: asOfIso,
        job: {
          id: job.id,
          code: job.code,
          title: job.title,
          status: job.status,
          department_id: job.department_id,
          requisition_id: job.requisition_id,
          current_job_version_id: job.current_job_version_id,
          record_version: job.record_version,
          status_changed_at: iso(job.status_changed_at),
        },
        job_version: jobVersion === undefined ? null : {
          id: jobVersion.id,
          version_no: jobVersion.version_no,
          payload_hash: jobVersion.payload_hash,
          description_md: jobVersion.description_md,
          requirements_md: jobVersion.requirements_md,
          approved_by_approval_id: jobVersion.approved_by_approval_id,
        },
        rubric: null,
        rubric_absence: {
          code: 'NO_RUBRIC_AT_ALL',
          message: `岗位 ${jobId} 还没有任何 Rubric 版本`,
          violations: [],
        },
        rubric_versions: versions.map((version) => ({
          version_no: version.version_no,
          version_id: version.id,
          is_current: false,
          is_approved: approvedAt(version, approvals, asOfIso) !== null,
          created_at: iso(version.created_at),
        })),
      }
    }
    // current() 只认指针；JOB_CURRENT 还要"指针指向的版本在 as_of 已批准" + "可执行"（R-VAL）。
    // 三个事实分开报，别把"没有指针"说成"没有审批"。
    if (current === undefined) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'NO_APPROVED_RUBRIC',
        message: job.current_rubric_version_id === null
          ? `岗位 ${jobId} 有 ${versions.length} 个 Rubric 版本，但 job.current_rubric_version_id 为空：`
            + '没有"当前版本"（D-21/D-48：当前只由该指针表达，不回退到 max(version_no)）'
          : `岗位 ${jobId} 的 job.current_rubric_version_id=${job.current_rubric_version_id} 不属于该岗位的 Rubric 版本`,
        violations: [],
      })
    }
    if (approvedAt(current, approvals, asOfIso) === null) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'NO_APPROVED_RUBRIC',
        message: `岗位当前 Rubric v${current.version_no}（指针指向的版本）在 ${asOfIso} 时刻没有处于已批准状态的审批`,
        violations: [],
      })
    }
    const currentViolations = validateDimensions(current.dimensions)
    if (currentViolations.length > 0) {
      return absenceValue(job, jobVersion, versions, approvals, asOfIso, provenance, {
        code: 'RUBRIC_INVALID',
        message: `当前 Rubric v${current.version_no} 没有通过 R-VAL-1..13，不可执行`,
        violations: currentViolations,
      })
    }
    resolved = current
  }

  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    labels: jobGetLabels(provenance),
    as_of: asOfIso,
    job: {
      id: job.id,
      code: job.code,
      title: job.title,
      status: job.status,
      department_id: job.department_id,
      requisition_id: job.requisition_id,
      current_job_version_id: job.current_job_version_id,
      record_version: job.record_version,
      status_changed_at: iso(job.status_changed_at),
    },
    job_version: jobVersion === undefined ? null : {
      id: jobVersion.id,
      version_no: jobVersion.version_no,
      payload_hash: jobVersion.payload_hash,
      description_md: jobVersion.description_md,
      requirements_md: jobVersion.requirements_md,
      approved_by_approval_id: jobVersion.approved_by_approval_id,
    },
    rubric: rubricValue(resolved, currentOrNull ?? undefined, approvals, asOfIso, resolution),
    rubric_absence: null,
    rubric_versions: versions.map((version) => ({
      version_no: version.version_no,
      version_id: version.id,
      is_current: current !== undefined && current.id === version.id,
      is_approved: approvedAt(version, approvals, asOfIso) !== null,
      created_at: iso(version.created_at),
    })),
  }
}

/**
 * 在**已有事务**里跑完整查询（测试与生产走同一条 `queryJob` 路径，标签也因此同源）。
 *
 * 给集成测试一个能落在回滚事务里的入口：`createJobGetTool().execute` 自己开池，
 * 看不到事务内造的夹具；而 R4 要证明"标签随租户事实变"，必须能在同一事务里
 * 造一个**被显式声明为非合成**的租户再读一遍。
 * @param client - 事务内客户端。
 * @param config - 已解析的数据库配置（`tenant_id` 只从这里来）。
 * @param args - **已校验**的入参（校验在 `execute` 的入参层，与 `queryJob` 同口径）。
 * @param asOfIso - 本次判定的基准时刻。
 * @returns 规范输出值（`labels.provenance` 由 `resolveTenantProvenance` 算出）。
 */
export async function readJobValue(
  client: DatabaseClient,
  config: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  asOfIso: string,
): Promise<JobGetValue> {
  return queryJob(client, config, args, asOfIso)
}

/**
 * 构造 `rubric` 为 null 的返回值（`rubric_absence` 恰有一个非 null，见 §2.3）。
 * @param provenance - 本次调用按租户事实算出的数据真假（R4；不许写死）。
 */
function absenceValue(
  job: JobRow,
  jobVersion: JobVersionRow | undefined,
  versions: readonly RubricRow[],
  approvals: readonly ApprovalRow[],
  asOfIso: string,
  provenance: 'LIVE' | 'FIXTURE',
  absence: JobGetValue['rubric_absence'],
): JobGetValue {
  const current = pickCurrent(versions, job.current_rubric_version_id)
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    labels: jobGetLabels(provenance),
    as_of: asOfIso,
    job: {
      id: job.id,
      code: job.code,
      title: job.title,
      status: job.status,
      department_id: job.department_id,
      requisition_id: job.requisition_id,
      current_job_version_id: job.current_job_version_id,
      record_version: job.record_version,
      status_changed_at: iso(job.status_changed_at),
    },
    job_version: jobVersion === undefined ? null : {
      id: jobVersion.id,
      version_no: jobVersion.version_no,
      payload_hash: jobVersion.payload_hash,
      description_md: jobVersion.description_md,
      requirements_md: jobVersion.requirements_md,
      approved_by_approval_id: jobVersion.approved_by_approval_id,
    },
    rubric: null,
    rubric_absence: absence,
    rubric_versions: versions.map((version) => ({
      version_no: version.version_no,
      version_id: version.id,
      is_current: current !== undefined && current.id === version.id,
      is_approved: approvedAt(version, approvals, asOfIso) !== null,
      created_at: iso(version.created_at),
    })),
  }
}

/** 一条 criterion 的模型可见行（§2.6 的正例格式）。 */
function criterionLine(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return '    ?  (malformed criterion)'
  const criterion = raw as Record<string, unknown>
  const key = typeof criterion.key === 'string' ? criterion.key : '?'
  const kind = typeof criterion.kind === 'string' ? criterion.kind : '?'
  const weight = typeof criterion.weight === 'number' ? String(criterion.weight) : '?'
  const label = typeof criterion.label === 'string' ? ` — ${criterion.label}` : ''
  const evidence = typeof criterion.field === 'string'
    ? `${criterion.field} ${typeof criterion.operator === 'string' ? criterion.operator : '?'} ${JSON.stringify(criterion.value)}`
    : typeof criterion.question === 'string'
      ? `(judgment) ${JSON.stringify(criterion.question)}`
      : '(no field, no question)'
  return `    ${key}  [${kind}]  w=${weight}  ${evidence}${label}`
}

/**
 * 造一个"数据库没配置"的替身：工具照常注册，调用时报 NOT_CONFIGURED 并列出缺什么。
 * 这比让工具消失更好——模型能看到"为什么查不了"，而不是以为工具不存在。
 */
export function unconfiguredJobGetTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one job (requisition) and its rubric from the business database. Currently NOT CONFIGURED: '
      + 'the plugin config is missing database settings (or the database password environment variable). '
      + 'Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，岗位查询不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/**
 * 造真实的岗位查询工具。
 * @param config - 已解析的数据库配置（tenant_id 只从这里来，模型无法传入）。
 */
export function createJobGetTool(config: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'Get one job (requisition) and the rubric version that applies at a given time, read straight from the '
      + 'business database (labels: provenance is computed from the tenant\'s synthetic marker — FIXTURE for demo/'
      + 'undeclared tenants, LIVE only when the tenant is explicitly declared non-synthetic; trigger=MANUAL, '
      + 'connection=CONNECTED means "direct business DB read"). job_id must be a UUID. Returns the job row, its '
      + 'current job_version (JD text), the resolved rubric with every criterion echoed verbatim, all rubric '
      + 'version numbers with is_current/is_approved, and rubric_absence when the job has no approved rubric '
      + '(this tool reports absence instead of failing). Omit rubric_version_no/rubric_version_id to get the '
      + 'current approved version; pin a version by passing one of them (they are mutually exclusive). '
      + 'Use rubric.version_id when a downstream step must reference the exact rubric. Read-only.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as JobGetValue
        const labels = `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
        const lines: string[] = [
          `job ${v.job.code} ${v.job.title} [${v.job.status}]  (labels: ${labels})`,
          `  job_id=${v.job.id}  record_version=${v.job.record_version}  `
            + `department_id=${v.job.department_id}  requisition_id=${v.job.requisition_id ?? 'null'}`,
        ]
        if (v.job_version === null) {
          lines.push('job_version: none (job.current_job_version_id is null)')
        } else {
          lines.push(
            `job_version v${v.job_version.version_no}  hash=${v.job_version.payload_hash.slice(0, 8)}…  `
            + `approved_by_approval_id=${v.job_version.approved_by_approval_id ?? 'null'}`,
          )
          if (v.job_version.description_md !== null) {
            lines.push(`  description_md: ${v.job_version.description_md}`)
          }
          if (v.job_version.requirements_md !== null) {
            lines.push(`  requirements_md: ${v.job_version.requirements_md}`)
          }
        }
        if (v.rubric === null) {
          const absence = v.rubric_absence
          lines.push(`rubric: none (${absence === null ? 'unknown' : absence.code}) — ${absence === null ? '' : absence.message}`)
          for (const violation of absence === null ? [] : absence.violations) {
            const record = violation as Record<string, unknown>
            lines.push(`  VIOLATION ${String(record.rule)} ${String(record.reason_code)} @ ${String(record.path)}`)
          }
        } else {
          lines.push(
            `rubric v${v.rubric.version_no} (is_current=${String(v.rubric.is_current)}, `
            + `is_approved=${String(v.rubric.is_approved)}, resolution=${v.rubric.resolution}, `
            + `executable=${String(v.rubric.executable)}, version_id=${v.rubric.version_id})`,
          )
          for (const criterion of v.rubric.criteria) lines.push(criterionLine(criterion))
        }
        lines.push(
          `versions: ${v.rubric_versions
            .map((version) => `v${version.version_no}(is_current=${String(version.is_current)}, `
              + `is_approved=${String(version.is_approved)})`)
            .join(', ') || 'none'}`,
        )
        lines.push(`as_of ${v.as_of}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      if (args.rubric_version_no !== undefined && args.rubric_version_id !== undefined) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'MUTUALLY_EXCLUSIVE',
          message: 'rubric_version_no 与 rubric_version_id 只能给一个',
          detail: {
            given: { rubric_version_no: args.rubric_version_no, rubric_version_id: args.rubric_version_id },
          },
        })
      }
      const nowMs = Date.now()
      const requestedAsOf = typeof args.as_of === 'string' ? args.as_of : undefined
      if (requestedAsOf !== undefined) {
        const checked = checkAsOf(requestedAsOf, nowMs)
        if (checked.ok !== true) {
          throw contractError('INVALID_ARGS', {
            reason_code: checked.reason_code,
            message: checked.message,
            detail: { as_of: requestedAsOf },
          })
        }
      }
      const asOfIso = requestedAsOf ?? new Date(nowMs).toISOString()

      const pool = createPool(config)
      try {
        return await withReadOnly(pool, async (client) => queryJob(client, config, args, asOfIso))
      } finally {
        await closePool(pool)
      }
    },
  }
}

