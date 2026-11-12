// recruitment_application_intake —— S6「简历接入」：本地 PDF → 候选人 → 申请。
//
// **这是本包里唯一会写库的工具。** 写入路径与只读工具刻意分开文件，便于静态扫描
// （`test/unit/screening-readonly.test.ts` 只对 S7 源码断言"无写语句"）。
//
// 一次调用做六件事，全部在**一个** `withActor` 事务里：
//   1. 读 PDF（复用 `src/tools/converter.ts` 的 `runConverter`，不重复实现）
//   2. 身份观察：只认 phone / email 的规范化精确相等，**姓名不参与判定**
//      （`docs/16-design-rationale.md` §8「D-46→D-52 身份规则简化到三条」）
//   3. 幂等：同一 `(sha256, job_id)` 已经有 application 就原样返回，`created=false`
//   4. 落 Intake 三层 + `resume` + `resume_version`（`parsed_fields` 白名单投影）
//   5. 找到就复用候选人，找不到才新建（`identity_status='ACTIVE'`）
//   6. 建 `application`，阶段 `S6`（`stage_catalog` 口径；阶段推进到 S7 是人工/写侧动作）
//
// 三条红线（违反任一条这次交付即不通过）：
//   * **读不出 ≠ 新人/重复**：phone/email 都不可自动时返回 `BLOCKED_BY_REVIEW`，
//     一条行都不写（`contracts/identity/identity-resolution-rules.md` IR-G1/G2/G3、IR-C9）。
//   * **关联 ≠ 合并**：命中已有档案只建 `application`，绝不写 `candidate_merge`
//     （IR §12-①、IR §5.4 D9）。
//   * **actor 只能来自配置**，用 `SET LOCAL`（`withActor`），不接受模型传入
//     （`tool-contracts.md` §0 第 4 条、D-18）。

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { contractError, type ContractErrorCode } from './contract.ts'
import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  assertReadablePdf,
  ConverterPathError,
  runConverter,
  type ConverterOutput,
  type ResolvedConverterConfig,
} from './converter.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { matchByStrongIds, observeIdentity, type CandidateHit, type ConverterFieldEntry, type StrongId } from '../db/identity.ts'
import {
  hardIssueCodes,
  mapParseStatus,
  projectParsedFields,
  type MaterialIssue,
} from '../db/material.ts'

const TOOL_NAME = 'recruitment_application_intake'
const CONTRACT_VERSION = '1.0.0'

const PARAMS: ParamMap = {
  path: {
    kind: 'string',
    required: true,
    maxLength: 1024,
    description:
      'Absolute path of a local resume PDF. Must exist and must be inside the configured '
      + 'allowed_roots (fail-closed: any other path is rejected with FORBIDDEN).',
  },
  job_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Target job id, UUID text form (e.g. 11111111-1111-4111-8111-000000000401).',
  },
}

/** 一条块级证据（**不带原文**：输出里不打印手机号/邮箱）。 */
interface EvidenceRef {
  readonly field: string
  readonly page: number
  readonly bbox: readonly number[]
  readonly block: number
}

/** 入参规范输出。 */
interface IntakeValue {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  readonly created: boolean
  readonly candidate_created: boolean
  readonly idempotent_replay: boolean
  readonly candidate_id: string
  readonly application_id: string
  readonly matched_by: string
  readonly resume_id: string
  readonly resume_version_id: string
  readonly intake_record_id: string
  readonly intake_asset_id: string
  readonly event_id: string
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly labels: {
    readonly provenance: string
    readonly trigger: string
    readonly connection: string
    readonly source_kind: string
    readonly event_provider: string
  }
  readonly source: {
    readonly file_name: string
    readonly sha256: string
    readonly pages: number
    readonly byte_size: number
    readonly completeness: string
    readonly parse_status: string
    readonly hard_issue_count: number
  }
  readonly identity: {
    readonly strong_ids: readonly string[]
    readonly blocked_fields: readonly { readonly field: string; readonly reason: string }[]
    readonly evidence: readonly EvidenceRef[]
  }
  readonly job: { readonly id: string; readonly code: string; readonly title: string; readonly status: string }
  readonly application: {
    readonly job_id: string
    readonly job_version_id: string
    readonly stage_code: string
    readonly lifecycle_status: string
    readonly record_version: number
  }
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    created: { type: 'boolean' },
    candidate_created: { type: 'boolean' },
    idempotent_replay: { type: 'boolean' },
    candidate_id: { type: 'string' },
    application_id: { type: 'string' },
    matched_by: { type: 'string' },
    resume_id: { type: 'string' },
    resume_version_id: { type: 'string' },
    intake_record_id: { type: 'string' },
    intake_asset_id: { type: 'string' },
    event_id: { type: 'string' },
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string' },
        trigger: { type: 'string' },
        connection: { type: 'string' },
        source_kind: { type: 'string' },
        event_provider: { type: 'string' },
      },
      required: ['provenance', 'trigger', 'connection', 'source_kind', 'event_provider'],
      additionalProperties: false,
    },
    source: {
      type: 'object',
      properties: {
        file_name: { type: 'string' },
        sha256: { type: 'string' },
        pages: { type: 'integer' },
        byte_size: { type: 'integer' },
        completeness: { type: 'string' },
        parse_status: { type: 'string' },
        hard_issue_count: { type: 'integer' },
      },
      required: ['file_name', 'sha256', 'pages', 'byte_size', 'completeness', 'parse_status', 'hard_issue_count'],
      additionalProperties: false,
    },
    identity: {
      type: 'object',
      properties: {
        strong_ids: { type: 'array', items: { type: 'string' } },
        blocked_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: { field: { type: 'string' }, reason: { type: 'string' } },
            required: ['field', 'reason'],
            additionalProperties: false,
          },
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              page: { type: 'integer' },
              bbox: { type: 'array', items: { type: 'number' } },
              block: { type: 'integer' },
            },
            required: ['field', 'page', 'bbox', 'block'],
            additionalProperties: false,
          },
        },
      },
      required: ['strong_ids', 'blocked_fields', 'evidence'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['id', 'code', 'title', 'status'],
      additionalProperties: false,
    },
    application: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        job_version_id: { type: 'string' },
        stage_code: { type: 'string' },
        lifecycle_status: { type: 'string' },
        record_version: { type: 'integer' },
      },
      required: ['job_id', 'job_version_id', 'stage_code', 'lifecycle_status', 'record_version'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'status', 'created', 'candidate_created', 'idempotent_replay',
    'candidate_id', 'application_id', 'matched_by', 'resume_id', 'resume_version_id',
    'intake_record_id', 'intake_asset_id', 'event_id', 'provenance', 'labels', 'source',
    'identity', 'job', 'application',
  ],
  additionalProperties: false,
}

/** 一次调用的工具级配置（两段都已解析成功）。 */
export interface IntakeToolConfig {
  readonly converter: ResolvedConverterConfig
  readonly database: ResolvedDatabaseConfig
}

/** 身份结论：要么可自动关联/新建，要么拒绝（fail-closed）。 */
type IdentityDecision =
  | { readonly kind: 'CREATE_CANDIDATE' }
  | { readonly kind: 'LINK_EXISTING'; readonly hit: CandidateHit }
  | { readonly kind: 'REVIEW'; readonly reason_code: string; readonly message: string; readonly detail: unknown }

/**
 * 纯判定：给定观察结果与命中集，得身份结论（顺序即规则，首个命中即返回）。
 *
 * **本 lane 只有三档**（见文件头）：无命中 → 新建；恰好一条 → 关联；其余 → 人工。
 * 姓名不参与，所以 IR 的 `WEAK_MATCH` / `MERGE_CONFLICT_ID_NAME` / `NAME_UNVERIFIED`
 * 三档在本实现里**不存在**（这是 D-46/D-52 的简化，不是遗漏）。
 * @param strong - 可自动的强标识。
 * @param hits - 同租户命中集（已解析到存活档）。
 */
export function decideIdentity(strong: readonly StrongId[], hits: readonly CandidateHit[]): IdentityDecision {
  const usable = strong.filter((id) => !id.region_ambiguous)
  if (usable.length === 0) {
    const ambiguous = strong.filter((id) => id.region_ambiguous)
    if (ambiguous.length > 0) {
      return {
        kind: 'REVIEW',
        reason_code: 'REGION_AMBIGUOUS_PHONE',
        message: '简历里只有无国际前缀的本地号码，规范化后无法确定国别/地区，不得据此判新人或重复',
        detail: {
          blocking_items: ambiguous.map((id) => ({
            code: 'REGION_AMBIGUOUS_PHONE',
            family: 'MATERIAL',
            field: id.field,
            reason: 'region_ambiguous',
          })),
        },
      }
    }
    return {
      kind: 'REVIEW',
      reason_code: 'MATERIAL_ATTRIBUTION_UNKNOWN',
      message: '简历里的 phone / email 都没有读出可用值，无法判定这份材料属于谁；不得据此判"新人"或"重复"',
      detail: {
        blocking_items: strong.length === 0
          ? [{ code: 'MATERIAL_ATTRIBUTION_UNKNOWN', family: 'MATERIAL', field: 'phone,email' }]
          : [],
      },
    }
  }
  const distinctCandidates = [...new Set(hits.map((hit) => hit.candidate_id))]
  if (distinctCandidates.length === 0) return { kind: 'CREATE_CANDIDATE' }
  if (distinctCandidates.length === 1) return { kind: 'LINK_EXISTING', hit: hits[0] as CandidateHit }
  // ≥2 条不同档案：交叉印证（D5）属于"合并"决策，必须由 SYSTEM/HUMAN + candidate_merge 完成，
  // 本工具**不合并**（IR-M5 / IR-F12）。
  return {
    kind: 'REVIEW',
    reason_code: 'MULTIPLE_STRONG_MATCH',
    message: '本次材料的 phone 与 email 分别命中不同档案；合并必须走人工/系统合并流程，本工具不合并',
    detail: {
      blocking_items: hits.map((hit) => ({
        code: 'MULTIPLE_STRONG_MATCH',
        family: 'HUMAN_QUEUE',
        ref_kind: 'CANDIDATE',
        ref_id: hit.candidate_id,
        field: hit.field,
      })),
    },
  }
}

/** 一次 intake 的中间上下文（纯数据，便于测试复用）。 */
export interface IntakeMaterial {
  readonly real_path: string
  readonly file_name: string
  readonly byte_size: number
  readonly output: ConverterOutput
  readonly strong: readonly StrongId[]
  readonly blocked: readonly { readonly field: string; readonly reason: string }[]
  readonly sha256: string
}

/**
 * 把 converter 结果整理成待落库的材料（纯函数，除了 `statSync` 的字节数）。
 * @param realPath - 已通过 allowed_roots 校验的真实路径。
 * @param output - converter 输出。
 */
export function buildMaterial(realPath: string, output: ConverterOutput): IntakeMaterial {
  const fields = (output.fields ?? {}) as Readonly<Record<string, ConverterFieldEntry>>
  const observation = observeIdentity(fields, output.screening?.identity_merge_eligible)
  const sha = output.meta?.source_sha256 ?? ''
  if (sha === '') {
    throw contractError('READER_FAILED', {
      reason_code: 'READER_NO_SOURCE_HASH',
      message: 'converter 没有给出 source_sha256，无法建立内容寻址的材料引用',
    })
  }
  const name = realPath.split(/[\\/]/).pop() ?? realPath
  return {
    real_path: realPath,
    file_name: name,
    byte_size: statSync(realPath).size,
    output,
    strong: observation.strong,
    blocked: observation.blocked,
    sha256: sha,
  }
}

interface JobRow {
  readonly id: string
  readonly tenant_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_job_version_id: string | null
}

/**
 * 在一个**已开启并已设置 actor** 的事务里完成一次 intake。
 *
 * 单独导出是为了让集成测试把它放进"必回滚事务"里跑（幂等、身份匹配都要真库）。
 * @param client - 事务内客户端。
 * @param cfg - 已解析配置（租户与 actor 从这里来）。
 * @param material - `buildMaterial()` 的结果。
 * @param jobId - 目标岗位 id。
 * @returns 规范输出值。
 */
export async function intakeInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  material: IntakeMaterial,
  jobId: string,
): Promise<IntakeValue> {
  const tenantId = cfg.tenant_id

  // 0) 配置里的 actor 必须真的存在且属于该租户：否则"责任人"是一个不存在的 uuid。
  const actor = await client.query<{ kind: string }>(
    'select kind from recruitment.actor where id = $1 and tenant_id = $2',
    [cfg.actor_id, tenantId],
  )
  if (actor.rows.length === 0) {
    throw contractError('FORBIDDEN', {
      reason_code: 'ACTOR_NOT_IN_TENANT',
      message: '配置里的 database.actor_id 在该租户下不存在；写库会留下无法追溯的责任人',
      detail: { actor_id: cfg.actor_id, tenant_id: tenantId },
    })
  }

  // 1) 串行化同一 (材料, 岗位) 的并发调用，避免两个事务都"没查到"然后各插一条。
  await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `intake:${tenantId}:${material.sha256}:${jobId}`,
  ])

  // 2) 幂等：同一 (sha256, job_id) 已有申请 → 原样返回，created=false。
  const replay = await client.query<{
    application_id: string
    candidate_id: string
    resume_version_id: string
    resume_id: string
    intake_record_id: string
    intake_asset_id: string
    event_id: string
    stage_code: string
    lifecycle_status: string
    record_version: number
    job_version_id: string
  }>(
    `select a.id as application_id, a.candidate_id, a.resume_version_id,
            a.current_stage_code as stage_code, a.lifecycle_status, a.record_version,
            a.job_version_id,
            rv.id as resume_version_id, rv.resume_id,
            ia.id as intake_asset_id, ir.id as intake_record_id, ir.event_id
       from recruitment.application a
       join recruitment.resume_version rv
         on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
       join recruitment.resume r on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       join recruitment.intake_asset ia on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       join recruitment.intake_record ir on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
       join recruitment.candidate c on c.id = a.candidate_id and c.tenant_id = a.tenant_id
      where a.tenant_id = $1 and a.job_id = $2 and rv.source_asset_sha256 = $3
      order by a.created_at
      limit 1`,
    [tenantId, jobId, material.sha256],
  )
  const existing = replay.rows[0]
  const job = await loadJob(client, tenantId, jobId)
  if (existing !== undefined) {
    return assemble({
      cfg,
      material,
      job,
      created: false,
      candidateCreated: false,
      idempotentReplay: true,
      candidateId: existing.candidate_id,
      applicationId: existing.application_id,
      matchedBy: 'existing',
      resumeId: existing.resume_id,
      resumeVersionId: existing.resume_version_id,
      intakeRecordId: existing.intake_record_id,
      intakeAssetId: existing.intake_asset_id,
      eventId: existing.event_id,
      stageCode: existing.stage_code,
      lifecycleStatus: existing.lifecycle_status,
      recordVersion: existing.record_version,
      jobVersionId: existing.job_version_id,
    })
  }

  // 3) 身份结论。命中不到就新建，命中一条就复用，其余一律拒绝（一条行都不写）。
  const hits = await matchByStrongIds(client, tenantId, material.strong)
  const decision = decideIdentity(material.strong, hits)
  if (decision.kind === 'REVIEW') {
    throw contractError('BLOCKED_BY_REVIEW', {
      reason_code: decision.reason_code,
      message: decision.message,
      detail: { job_id: jobId, ...(decision.detail as Record<string, unknown>) },
    })
  }

  const parse = mapParseStatus(material.output.completeness, material.output.chars, material.output.issues)
  const hard = hardIssueCodes(material.output.issues as readonly MaterialIssue[] | undefined)

  // 4) Intake 三层 + resume + resume_version。
  const eventId = await upsertIntakeEvent(client, tenantId, material)
  const intakeRecordId = await insertIntakeRecord(client, tenantId, eventId, material)
  const intakeAssetId = await insertIntakeAsset(client, tenantId, intakeRecordId, material)

  let candidateId: string
  let candidateCreated: boolean
  if (decision.kind === 'LINK_EXISTING') {
    candidateId = decision.hit.candidate_id
    candidateCreated = false
  } else {
    candidateId = await insertCandidate(client, tenantId, material)
    candidateCreated = true
  }

  const resumeId = await insertResume(client, tenantId, candidateId, intakeAssetId)
  const projection = projectParsedFields(material.output)
  const resumeVersionId = await insertResumeVersion(client, tenantId, {
    resumeId,
    material,
    parseStatus: parse.status,
    parseError: parse.parse_error,
    parsedFields: projection as unknown as Record<string, unknown>,
  })

  // 5) 申请（阶段 S6 = Intake；推进到 S7 是写侧动作，不由本工具代做）。
  if (job.current_job_version_id === null) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_VERSION_NOT_FOUND',
      message: '该岗位还没有 job_version（application.job_version_id 是 NOT NULL）',
      detail: { job_id: jobId },
    })
  }
  const application = await client.query<{ id: string; record_version: number }>(
    `insert into recruitment.application
       (tenant_id, candidate_id, job_id, job_version_id, resume_version_id,
        lifecycle_status, current_stage_code)
     values ($1, $2, $3, $4, $5, 'ACTIVE', 'S6')
     returning id, record_version`,
    [tenantId, candidateId, jobId, job.current_job_version_id, resumeVersionId],
  )
  const applicationRow = application.rows[0]
  if (applicationRow === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'application insert returned no row')
  }

  return assemble({
    cfg,
    material,
    job,
    created: true,
    candidateCreated,
    idempotentReplay: false,
    candidateId,
    applicationId: applicationRow.id,
    matchedBy: decision.kind === 'LINK_EXISTING'
      ? [...new Set(hits.map((hit) => hit.field))].sort().join('+')
      : 'created',
    resumeId,
    resumeVersionId,
    intakeRecordId,
    intakeAssetId,
    eventId,
    stageCode: 'S6',
    lifecycleStatus: 'ACTIVE',
    recordVersion: applicationRow.record_version,
    jobVersionId: job.current_job_version_id,
  })
}

async function loadJob(client: DatabaseClient, tenantId: string, jobId: string): Promise<JobRow> {
  const { rows } = await client.query<JobRow>(
    `select id, tenant_id, code, title, status, current_job_version_id
       from recruitment.job where id = $1 and tenant_id = $2`,
    [jobId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'JOB_NOT_FOUND',
      message: '该租户下没有这个岗位',
      detail: { job_id: jobId, tenant_id: tenantId },
    })
  }
  return row
}

/** 内部事件：材料到达。同一材料在同一租户只记一条（`uq_event_inbox_idempotency`）。 */
async function upsertIntakeEvent(
  client: DatabaseClient,
  tenantId: string,
  material: IntakeMaterial,
): Promise<string> {
  const idempotencyKey = `resume.intake:${material.sha256}`
  const inserted = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, event_type, schema_version, occurred_at, received_at, recorded_at,
        idempotency_key, idempotency_source, source_object_id, payload, trust_level,
        normalized_event_type, normalizer_version)
     values ($1, 'internal', 'resume.intake.received', 1, now(), now(), now(),
             $2, 'FALLBACK_KEY', $3, $4::jsonb, 'INTERNAL', 'resume.intake.received', 'intake/1.0.0')
     on conflict (tenant_id, idempotency_key) do nothing
     returning event_id`,
    [
      tenantId,
      idempotencyKey,
      material.sha256,
      JSON.stringify({
        sha256: material.sha256,
        file_name: material.file_name,
        pages: material.output.meta?.pages ?? 0,
        source_kind: 'LOCAL_FILE',
      }),
    ],
  )
  const fresh = inserted.rows[0]
  if (fresh !== undefined) return fresh.event_id
  const found = await client.query<{ event_id: string }>(
    'select event_id from recruitment.event_inbox where tenant_id = $1 and idempotency_key = $2',
    [tenantId, idempotencyKey],
  )
  const row = found.rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'event_inbox row vanished during intake')
  return row.event_id
}

async function insertIntakeRecord(
  client: DatabaseClient,
  tenantId: string,
  eventId: string,
  material: IntakeMaterial,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.intake_record
       (tenant_id, event_id, sender_ref, subject, status)
     values ($1, $2, $3, $4, 'RESOLVED')
     returning id`,
    [tenantId, eventId, 'local-file', `简历接入：${material.file_name}`.slice(0, 500)],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'intake_record insert returned no row')
  return row.id
}

async function insertIntakeAsset(
  client: DatabaseClient,
  tenantId: string,
  intakeRecordId: string,
  material: IntakeMaterial,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.intake_asset
       (tenant_id, intake_record_id, file_name, mime_type, byte_size, sha256, storage_ref, validation_status)
     values ($1, $2, $3, 'application/pdf', $4, $5, $6, 'VALID')
     returning id`,
    [
      tenantId,
      intakeRecordId,
      material.file_name,
      material.byte_size,
      material.sha256,
      // 不把本机绝对路径写进库：材料是内容寻址的，原件不复制、不搬动（R7 最小化留存）。
      `content-addressed:sha256:${material.sha256}`,
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'intake_asset insert returned no row')
  return row.id
}

/**
 * 新建候选人。
 *
 * `display_name` 只是**展示标签**，从 converter 的 name 字段取；取不到就落一个
 * 内容寻址的占位名。姓名**不参与**任何身份判定（D-46/D-52），所以占位名不会
 * 影响"这份材料是谁"的结论。
 */
async function insertCandidate(
  client: DatabaseClient,
  tenantId: string,
  material: IntakeMaterial,
): Promise<string> {
  const nameEntry = material.output.fields?.name
  const name = typeof nameEntry?.value === 'string' && nameEntry.value.trim() !== ''
    ? nameEntry.value.trim().slice(0, 200)
    : `待确认候选人-${material.sha256.slice(0, 8)}`
  const phone = material.strong.find((id) => id.field === 'phone' && !id.region_ambiguous)
  const email = material.strong.find((id) => id.field === 'email')
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.candidate
       (tenant_id, display_name, normalized_email, normalized_phone, identity_status)
     values ($1, $2, $3, $4, 'ACTIVE')
     returning id`,
    [tenantId, name, email?.norm ?? null, phone?.norm ?? null],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'candidate insert returned no row')
  return row.id
}

async function insertResume(
  client: DatabaseClient,
  tenantId: string,
  candidateId: string,
  intakeAssetId: string,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.resume (tenant_id, candidate_id, intake_asset_id)
     values ($1, $2, $3)
     returning id`,
    [tenantId, candidateId, intakeAssetId],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'resume insert returned no row')
  return row.id
}

async function insertResumeVersion(
  client: DatabaseClient,
  tenantId: string,
  input: {
    readonly resumeId: string
    readonly material: IntakeMaterial
    readonly parseStatus: string
    readonly parseError: string | undefined
    readonly parsedFields: Record<string, unknown>
  },
): Promise<string> {
  const pages = input.material.output.meta?.pages
  const { rows } = await client.query<{ id: string }>(
    `insert into recruitment.resume_version
       (tenant_id, resume_id, version_no, source_asset_sha256, content_sha256,
        parser_name, parser_version, parse_status, parse_error, parsed_fields, evidence)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
     returning id`,
    [
      tenantId,
      input.resumeId,
      input.material.sha256,
      sha256OfText(input.material.output.text ?? ''),
      backendName(input.material.output.meta?.backend),
      readerVersion(input.material.output.meta?.reader_version),
      input.parseStatus,
      // ck_resume_version_error：FAILED 必须有非空 parse_error；其余状态留空。
      input.parseStatus === 'FAILED' ? (input.parseError ?? 'pdf_no_text') : null,
      JSON.stringify(input.parsedFields),
      JSON.stringify(evidenceArray(input.material.output, pages ?? 0)),
    ],
  )
  const row = rows[0]
  if (row === undefined) throw new RecruitmentToolError('READER_FAILED', 'resume_version insert returned no row')
  return row.id
}

/** `parser_name` 只要 backend 的名字部分（`pymupdf/1.28.0` → `pymupdf`）。 */
function backendName(backend: string | undefined): string {
  if (typeof backend !== 'string' || backend === '') return 'pymupdf'
  const head = backend.split('/')[0]
  return head === '' ? 'pymupdf' : head
}

function readerVersion(version: string | undefined): string {
  return typeof version === 'string' && version !== '' ? version : 'unknown'
}

/**
 * 落 `resume_version.evidence`：converter 给出的字段级坐标（**不含原文以外的推断**）。
 * `quote` 保留原文片段（S7 的 `reason.quote` 只能来自原文），但 S6 的输出不打印它。
 */
function evidenceArray(output: ConverterOutput, pages: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const sha = output.meta?.source_sha256 ?? ''
  for (const [field, entry] of Object.entries(output.fields ?? {})) {
    for (const item of entry?.evidence ?? []) {
      out.push({
        field,
        page: typeof item.page === 'number' ? item.page : 0,
        bbox: (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : 0)),
        block: typeof item.block === 'number' ? item.block : -1,
        quote: typeof item.text === 'string' ? item.text : '',
        source_asset_sha256: sha,
        page_count: pages,
      })
    }
  }
  return out
}

/** 内容哈希：用于 `resume_version.content_sha256`（正文文本的 sha256）。 */
function sha256OfText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 组装规范输出（唯一出口，保证 schema 与 null-free 约束只实现一次）。 */
function assemble(input: {
  readonly cfg: ResolvedDatabaseConfig
  readonly material: IntakeMaterial
  readonly job: JobRow
  readonly created: boolean
  readonly candidateCreated: boolean
  readonly idempotentReplay: boolean
  readonly candidateId: string
  readonly applicationId: string
  readonly matchedBy: string
  readonly resumeId: string
  readonly resumeVersionId: string
  readonly intakeRecordId: string
  readonly intakeAssetId: string
  readonly eventId: string
  readonly stageCode: string
  readonly lifecycleStatus: string
  readonly recordVersion: number
  readonly jobVersionId: string
}): IntakeValue {
  const hard = hardIssueCodes(input.material.output.issues as readonly MaterialIssue[] | undefined)
  const parse = mapParseStatus(
    input.material.output.completeness,
    input.material.output.chars,
    input.material.output.issues,
  )
  return {
    tool: TOOL_NAME,
    contract_version: CONTRACT_VERSION,
    status: 'OK',
    created: input.created,
    candidate_created: input.candidateCreated,
    idempotent_replay: input.idempotentReplay,
    candidate_id: input.candidateId,
    application_id: input.applicationId,
    matched_by: input.matchedBy,
    resume_id: input.resumeId,
    resume_version_id: input.resumeVersionId,
    intake_record_id: input.intakeRecordId,
    intake_asset_id: input.intakeAssetId,
    event_id: input.eventId,
    // R4：材料来自本机文件、事件由本系统内部产生（provider='internal'）⇒ FIXTURE。
    // 不因"读的是真文件"就贴 LIVE：LIVE 的定义是"能从外部 provider 的真实链路追到"
    // （`tool-contracts.md` §1.4），本工具没有外部链路。
    provenance: 'FIXTURE',
    labels: {
      provenance: 'FIXTURE',
      trigger: 'MANUAL',
      connection: 'CONNECTED',
      source_kind: 'LOCAL_FILE',
      event_provider: 'internal',
    },
    source: {
      file_name: input.material.file_name,
      sha256: input.material.sha256,
      pages: typeof input.material.output.meta?.pages === 'number' ? input.material.output.meta.pages : 0,
      byte_size: input.material.byte_size,
      completeness: input.material.output.completeness ?? 'unverified',
      parse_status: parse.status,
      hard_issue_count: hard.length,
    },
    identity: {
      strong_ids: [...new Set(input.material.strong.map((id) => id.field))].sort(),
      blocked_fields: input.material.blocked.map((b) => ({ field: b.field, reason: b.reason })),
      evidence: input.material.strong.flatMap((id) =>
        id.evidence.map((e) => ({ field: id.field, page: e.page, bbox: e.bbox, block: e.block })),
      ),
    },
    job: {
      id: input.job.id,
      code: input.job.code,
      title: input.job.title,
      status: input.job.status,
    },
    application: {
      job_id: input.job.id,
      job_version_id: input.jobVersionId,
      stage_code: input.stageCode,
      lifecycle_status: input.lifecycleStatus,
      record_version: input.recordVersion,
    },
  }
}

/** 路径/读取层的失败 → 契约错误（消息里不出现手机号/邮箱/正文）。 */
function toPathError(error: unknown): never {
  if (error instanceof ConverterPathError) {
    const code: ContractErrorCode = error.code === 'FORBIDDEN'
      ? 'FORBIDDEN'
      : error.code === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : 'INVALID_ARGS'
    throw contractError(code, {
      reason_code: error.code === 'FORBIDDEN'
        ? 'PATH_OUTSIDE_ALLOWED_ROOTS'
        : error.code === 'NOT_FOUND'
          ? 'FILE_NOT_FOUND'
          : 'PATH_INVALID',
      message: error.message,
    })
  }
  throw error
}

/**
 * 造一个绑定配置的 intake 工具。
 * @param cfg - 已解析的 converter + database 配置。
 */
export function createApplicationIntakeTool(cfg: IntakeToolConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S6 resume intake. Reads one local resume PDF, resolves the candidate by exact normalized '
      + 'phone/email only (names are never used for identity), and creates the application at stage S6. '
      + 'Idempotent per (sha256, job_id): a second call returns the same ids with created=false. '
      + 'If phone and email are both unreadable it refuses with BLOCKED_BY_REVIEW and writes nothing. '
      + 'It never merges candidates. Writes only through SET LOCAL recruitment.actor_id.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as IntakeValue
        const lines = [
          `intake: ${v.created ? 'created' : 'replayed'} application ${v.application_id}`,
          `candidate ${v.candidate_id} (${v.candidate_created ? 'new' : 'existing'}, matched_by=${v.matched_by})`,
          `job ${v.job.code} [${v.job.status}] stage=${v.application.stage_code} lifecycle=${v.application.lifecycle_status}`,
          `source: ${v.source.file_name} pages=${v.source.pages} bytes=${v.source.byte_size}`,
          `sha256=${v.source.sha256}`,
          `parse_status=${v.source.parse_status} completeness=${v.source.completeness} hard_issues=${v.source.hard_issue_count}`,
          `identity strong_ids=[${v.identity.strong_ids.join(', ')}] `
            + `evidence=${v.identity.evidence.length} blocked=[${v.identity.blocked_fields.map((b) => `${b.field}:${b.reason}`).join(', ')}]`,
          `labels: provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      const requested = args.path as string
      if (isAbsolute(requested) === false) {
        throw contractError('INVALID_ARGS', {
          reason_code: 'PATH_INVALID',
          message: 'path 必须是绝对路径',
          detail: { path: requested },
        })
      }
      let realPath: string
      try {
        realPath = assertReadablePdf(requested, cfg.converter)
      } catch (error) {
        toPathError(error)
      }
      let output: ConverterOutput
      try {
        output = await runConverter(cfg.converter, realPath)
      } catch (error) {
        throw contractError('READER_FAILED', {
          reason_code: 'CONVERTER_FAILED',
          message: 'converter 子进程读取失败（PDF 损坏/加密/超时）',
          detail: { error: error instanceof Error ? error.message.slice(0, 300) : 'unknown' },
        })
      }
      const material = buildMaterial(realPath, output)
      const pool = createPool(cfg.database)
      try {
        return await withActor(pool, cfg.database.actor_id, async (client) =>
          intakeInTransaction(client, cfg.database, material, args.job_id as string))
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 配置不完整时用的替身：注册同一个工具名，调用即 `NOT_CONFIGURED`。
 * 与 `src/index.ts` 里 `unconfiguredResumeReadTool` 同一做法：让模型看见"为什么不能用"，
 * 而不是看不见工具或看到假数据。
 * @param issues - 缺哪些配置。
 */
export function unconfiguredApplicationIntakeTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S6 resume intake. Currently NOT CONFIGURED: the plugin config is missing converter or database '
      + 'settings (or the database password environment variable). Calls return NOT_CONFIGURED.',
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
        message: '数据库或 converter 配置不完整，S6 接入不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
