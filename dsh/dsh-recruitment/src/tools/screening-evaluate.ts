// recruitment_screening_evaluate —— S7「初筛评估」（**只读**）。
//
// 形状与语义逐条照 `contracts/job-screening/tool-contracts.md`（下称 TC）与
// `contracts/job-screening/screening-rules.md`（下称 SR）。版本解析照
// `contracts/job-screening/job-rubric-rules.md`（下称 JR）。
//
// 只读是怎么保证的（不是自我声称）：
//   1. **数据库层**：整个评估跑在 `begin transaction read only` 里（`src/db/pool.ts`
//      的 `withReadOnly`），任何写语句直接 25006；
//   2. **源码层**：本文件不出现 INSERT / UPDATE / DELETE（`test/unit/screening-readonly.test.ts` 静态断言）；
//   3. **语义层**：不产 `decision`、不钉 `rubric_version_id`、不改 `business_task`
//      （`tool-contracts.md` §0 的"四个永远不做"）。
//
// 输出里**没有 null**：DSH 校验器不支持 `type` 数组（`dsh-tools/lib/types/json-schema.js:245`），
// `string | null` 无法表达，写 null 会让整次调用 `INVALID_TOOL_OUTPUT`（2026-11-13 真实事故）。
// 契约里画成 `null` 的字段一律改为**省略键**；对 `tri_state` 这类"必须区分"的字段，
// 用 `outcome='NEEDS_JUDGMENT'` 这一一对应的伴随字段消歧（SR §3.1 已经要求两者同时出现）。

import { parseContractArgs, toParameterSchema, type ParamMap } from './args.ts'
import {
  canonicalJson,
  checkAsOf,
  contractError,
  digestOf,
  type ContractErrorCode,
} from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { closePool, createPool, withReadOnly, type DatabaseClient, type ResolvedDatabaseConfig } from '../db/pool.ts'
import { hardIssueCodes, type MaterialIssue } from '../db/material.ts'

const TOOL_NAME = 'recruitment_screening_evaluate'
const CONTRACT_VERSION = '1.0.0'
/** 本次执行做了几条阻断检查（SR §6.2 HQ-1…HQ-7）。恒为 7，缺了就等于无法证明检查发生过。 */
const HUMAN_QUEUE_CHECKS = 7

const PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description: 'Application id (UUID). The evaluation target is an application, not a candidate x job pair.',
  },
  resume_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description:
      'Optional material version override (UUID). Must belong to the same candidate as the application, '
      + 'otherwise INVALID_ARGS(RESUME_NOT_BELONG_TO_CANDIDATE).',
  },
  rubric_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description:
      'Optional rubric version override (UUID) = what_if. When it differs from the pinned version the '
      + 'output carries rubric.what_if=true and must not be used to write a decision.',
  },
  as_of: {
    kind: 'string',
    maxLength: 40,
    description:
      'ISO-8601 timestamp WITH timezone offset (e.g. 2026-11-13T00:00:00+08:00). Must not be later than '
      + 'the server clock. When omitted the output omits as_of (no wall-clock fields are ever emitted).',
  },
}

/** `reason.code` 封闭表（SR §7.3）：12 条 + BONUS 一族 + 4 条 GATE。 */
const REASON_CODES = [
  'MUST_HAVE_SATISFIED', 'MUST_HAVE_UNSATISFIED', 'MUST_HAVE_MISSING',
  'MUST_HAVE_UNREADABLE', 'MUST_HAVE_INDETERMINATE', 'MUST_HAVE_NEEDS_JUDGMENT',
  'DISQUALIFIER_TRIGGERED', 'DISQUALIFIER_CLEAR', 'DISQUALIFIER_MISSING',
  'DISQUALIFIER_UNREADABLE', 'DISQUALIFIER_INDETERMINATE', 'DISQUALIFIER_NEEDS_JUDGMENT',
  'BONUS_SATISFIED', 'BONUS_UNSATISFIED', 'BONUS_MISSING',
  'BONUS_UNREADABLE', 'BONUS_INDETERMINATE', 'BONUS_NEEDS_JUDGMENT',
  'GATE_JOB_CLOSED', 'GATE_JOB_ARCHIVED', 'GATE_JOB_NOT_OPEN', 'GATE_APPLICATION_NOT_ACTIVE',
] as const

const FAILURE_CLASSES = ['HARD_PASS', 'HARD_FAIL', 'NOT_PROVEN', 'UNREADABLE', 'INDETERMINATE', 'JUDGMENT', 'GATE'] as const
const OUTCOMES = ['SATISFIED', 'UNSATISFIED', 'TRIGGERED', 'CLEAR', 'MISSING', 'UNREADABLE', 'INDETERMINATE', 'NEEDS_JUDGMENT'] as const
const KINDS = ['MUST_HAVE', 'NICE_TO_HAVE', 'DISQUALIFIER'] as const
const TRI_STATES = ['present', 'absent', 'unreadable'] as const
const BOUNDS = ['EXACT', 'LOWER_BOUND', 'UNAVAILABLE'] as const
const HUMAN_ACTIONS = [
  'NONE', 'CONFIRM_DECISION', 'REVIEW_MISSING_FIELDS', 'REVIEW_UNREADABLE',
  'REVIEW_INDETERMINATE', 'ANSWER_JUDGMENT', 'RESOLVE_BLOCKER',
] as const
const WARNING_CODES = [
  'APPLICATION_ON_HOLD', 'JOB_PAUSED', 'FIELD_STATE_UNDECLARED', 'ABSENT_DOWNGRADED',
  'SCREENING_INDEX_INCONSISTENT', 'EVIDENCE_SHA_MISMATCH', 'RUBRIC_PIN_REQUIRED', 'WHAT_IF_EVALUATION',
] as const

/** 一条证据（SR §8.2：present 时 page≥1 + bbox 四元组 + source_asset_sha256 齐全）。 */
interface ScreenEvidence {
  readonly resume_version_id: string
  readonly source_asset_sha256: string
  readonly page: number
  readonly bbox: readonly number[]
  readonly block: number
  readonly quote: string
  readonly provenance: string
}

/** 一条 reason / bonus_signal（共用同一形状，SR §8.1）。 */
interface ScreenReason {
  readonly code: string
  readonly failure_class: string
  readonly criterion_key?: string
  readonly kind?: string
  readonly outcome?: string
  readonly field?: string
  readonly tri_state?: string
  readonly bounds?: string
  readonly expected?: {
    readonly operator?: string
    readonly value_integer?: number
    readonly value_boolean?: boolean
    readonly unit?: string
  }
  readonly observed?: { readonly value?: number; readonly lower_bound?: number }
  readonly evidence: readonly ScreenEvidence[]
  readonly absence?: {
    readonly document_sha256: string
    readonly page_count: number
    readonly completeness: string
    readonly searched_scopes: readonly string[]
    readonly basis: string
    readonly hard_issue_count: number
  }
  readonly issue_codes: readonly string[]
  readonly question?: string
  readonly notes?: string
  readonly message: string
}

/** 一条 warning（SR §7.3 的封闭表）。 */
interface ScreenWarning {
  readonly code: string
  readonly message: string
  readonly ref?: unknown
}

/** 规范输出（TC §3.2 的完整形状，null 全部改为省略键）。 */
interface EvaluateValue {
  readonly tool: string
  readonly contract_version: string
  readonly status: 'OK'
  readonly advisory: true
  readonly read_only: true
  readonly labels: { readonly provenance: string; readonly trigger: string; readonly connection: string }
  readonly as_of?: string
  readonly application: {
    readonly id: string
    readonly job_id: string
    readonly candidate_id: string
    readonly job_version_id: string
    readonly rubric_version_id?: string
    readonly lifecycle_status: string
    readonly current_stage_code: string
    readonly stage_blocked_reason?: string
    readonly record_version: number
  }
  readonly job: { readonly id: string; readonly title: string; readonly status: string }
  readonly resume_version: {
    readonly id: string
    readonly version_no: number
    readonly parse_status: string
    readonly source_asset_sha256: string
    readonly content_sha256: string
    readonly parser_name: string
    readonly parser_version: string
    readonly page_count: number
    readonly hard_issue_count: number
  }
  readonly rubric: {
    readonly version_id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly is_current: boolean
    readonly is_approved: boolean
    readonly resolution: string
    readonly what_if: boolean
    readonly rubric_pin_required: boolean
    readonly criteria_count: number
  }
  readonly preconditions: {
    readonly human_queue_checked: number
    readonly human_queue_clear: boolean
    readonly material_bound: boolean
    readonly material_ready: boolean
    readonly rubric_approved: boolean
  }
  readonly verdict: 'PASS' | 'FAIL' | 'NEEDS_REVIEW'
  readonly verdict_summary: string
  readonly criteria_evaluated: boolean
  readonly required_human_action: string
  readonly reasons: readonly ScreenReason[]
  readonly bonus_signals: readonly ScreenReason[]
  readonly warnings: readonly ScreenWarning[]
  readonly snapshot: {
    readonly application_record_version: number
    readonly resume_version_id: string
    readonly resume_content_sha256: string
    readonly rubric_version_id: string
    readonly rubric_payload_hash: string
  }
  readonly prior_screening?: {
    readonly decision_id: string
    readonly result: string
    /** 从 `decision.basis_refs` 里回读（`decision` 表没有这一列）；取不到就省略。 */
    readonly rubric_version_id?: string
    readonly decided_at: string
  }
  readonly evaluation_digest: string
}

const EVIDENCE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    resume_version_id: { type: 'string' },
    source_asset_sha256: { type: 'string' },
    page: { type: 'integer' },
    bbox: { type: 'array', items: { type: 'number' } },
    block: { type: 'integer' },
    quote: { type: 'string' },
    provenance: { type: 'string' },
  },
  required: ['resume_version_id', 'source_asset_sha256', 'page', 'bbox', 'block', 'quote', 'provenance'],
  additionalProperties: false,
}

const REASON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...REASON_CODES] },
    failure_class: { type: 'string', enum: [...FAILURE_CLASSES] },
    criterion_key: { type: 'string' },
    kind: { type: 'string', enum: [...KINDS] },
    outcome: { type: 'string', enum: [...OUTCOMES] },
    field: { type: 'string' },
    tri_state: { type: 'string', enum: [...TRI_STATES] },
    bounds: { type: 'string', enum: [...BOUNDS] },
    expected: {
      type: 'object',
      properties: {
        operator: { type: 'string' },
        value_integer: { type: 'integer' },
        value_boolean: { type: 'boolean' },
        unit: { type: 'string' },
      },
      additionalProperties: false,
    },
    observed: {
      type: 'object',
      properties: {
        value: { type: 'integer' },
        lower_bound: { type: 'integer' },
      },
      additionalProperties: false,
    },
    evidence: { type: 'array', items: EVIDENCE_SCHEMA },
    absence: {
      type: 'object',
      properties: {
        document_sha256: { type: 'string' },
        page_count: { type: 'integer' },
        completeness: { type: 'string' },
        searched_scopes: { type: 'array', items: { type: 'string' } },
        basis: { type: 'string' },
        hard_issue_count: { type: 'integer' },
      },
      required: ['document_sha256', 'page_count', 'completeness', 'searched_scopes', 'basis', 'hard_issue_count'],
      additionalProperties: false,
    },
    issue_codes: { type: 'array', items: { type: 'string' } },
    question: { type: 'string' },
    notes: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['code', 'failure_class', 'evidence', 'issue_codes', 'message'],
  additionalProperties: false,
}

const WARNING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...WARNING_CODES] },
    message: { type: 'string' },
    ref: {
      type: 'object',
      properties: { field: { type: 'string' }, source: { type: 'string' } },
      additionalProperties: false,
    },
  },
  required: ['code', 'message'],
  additionalProperties: false,
}

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    status: { type: 'string', enum: ['OK'] },
    advisory: { type: 'boolean', enum: [true] },
    read_only: { type: 'boolean', enum: [true] },
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
    application: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        job_id: { type: 'string' },
        candidate_id: { type: 'string' },
        job_version_id: { type: 'string' },
        rubric_version_id: { type: 'string' },
        lifecycle_status: { type: 'string' },
        current_stage_code: { type: 'string' },
        stage_blocked_reason: { type: 'string' },
        record_version: { type: 'integer' },
      },
      required: ['id', 'job_id', 'candidate_id', 'job_version_id', 'lifecycle_status', 'current_stage_code', 'record_version'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } },
      required: ['id', 'title', 'status'],
      additionalProperties: false,
    },
    resume_version: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version_no: { type: 'integer' },
        parse_status: { type: 'string' },
        source_asset_sha256: { type: 'string' },
        content_sha256: { type: 'string' },
        parser_name: { type: 'string' },
        parser_version: { type: 'string' },
        page_count: { type: 'integer' },
        hard_issue_count: { type: 'integer' },
      },
      required: ['id', 'version_no', 'parse_status', 'source_asset_sha256', 'content_sha256', 'parser_name', 'parser_version', 'page_count', 'hard_issue_count'],
      additionalProperties: false,
    },
    rubric: {
      type: 'object',
      properties: {
        version_id: { type: 'string' },
        version_no: { type: 'integer' },
        payload_hash: { type: 'string' },
        is_current: { type: 'boolean' },
        is_approved: { type: 'boolean' },
        resolution: {
          type: 'string',
          enum: ['ARGUMENT', 'APPLICATION_PINNED', 'JOB_CURRENT'],
        },
        what_if: { type: 'boolean' },
        rubric_pin_required: { type: 'boolean' },
        criteria_count: { type: 'integer' },
      },
      required: ['version_id', 'version_no', 'payload_hash', 'is_current', 'is_approved', 'resolution', 'what_if', 'rubric_pin_required', 'criteria_count'],
      additionalProperties: false,
    },
    preconditions: {
      type: 'object',
      properties: {
        human_queue_checked: { type: 'integer' },
        human_queue_clear: { type: 'boolean' },
        material_bound: { type: 'boolean' },
        material_ready: { type: 'boolean' },
        rubric_approved: { type: 'boolean' },
      },
      required: ['human_queue_checked', 'human_queue_clear', 'material_bound', 'material_ready', 'rubric_approved'],
      additionalProperties: false,
    },
    verdict: { type: 'string', enum: ['PASS', 'FAIL', 'NEEDS_REVIEW'] },
    verdict_summary: { type: 'string' },
    criteria_evaluated: { type: 'boolean' },
    required_human_action: { type: 'string', enum: [...HUMAN_ACTIONS] },
    reasons: { type: 'array', items: REASON_SCHEMA },
    bonus_signals: { type: 'array', items: REASON_SCHEMA },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    snapshot: {
      type: 'object',
      properties: {
        application_record_version: { type: 'integer' },
        resume_version_id: { type: 'string' },
        resume_content_sha256: { type: 'string' },
        rubric_version_id: { type: 'string' },
        rubric_payload_hash: { type: 'string' },
      },
      required: ['application_record_version', 'resume_version_id', 'resume_content_sha256', 'rubric_version_id', 'rubric_payload_hash'],
      additionalProperties: false,
    },
    prior_screening: {
      type: 'object',
      properties: {
        decision_id: { type: 'string' },
        result: { type: 'string' },
        rubric_version_id: { type: 'string' },
        decided_at: { type: 'string' },
      },
      required: ['decision_id', 'result', 'decided_at'],
      additionalProperties: false,
    },
    evaluation_digest: { type: 'string' },
  },
  required: [
    'tool', 'contract_version', 'status', 'advisory', 'read_only', 'labels', 'application', 'job',
    'resume_version', 'rubric', 'preconditions', 'verdict', 'verdict_summary', 'criteria_evaluated',
    'required_human_action', 'reasons', 'bonus_signals', 'warnings', 'snapshot', 'evaluation_digest',
  ],
  additionalProperties: false,
}

// =====================================================================
//  数据库行形状
// =====================================================================

interface ApplicationRow {
  readonly id: string
  readonly candidate_id: string
  readonly job_id: string
  readonly job_version_id: string
  readonly rubric_version_id: string | null
  readonly resume_version_id: string | null
  readonly lifecycle_status: string
  readonly current_stage_code: string
  readonly stage_blocked_reason: string | null
  readonly record_version: number
  readonly job_title: string
  readonly job_status: string
  readonly job_code: string
}

interface ResumeVersionRow {
  readonly id: string
  readonly version_no: number
  readonly parse_status: string
  readonly source_asset_sha256: string
  readonly content_sha256: string
  readonly parser_name: string
  readonly parser_version: string
  readonly parsed_fields: Record<string, unknown>
  readonly evidence: readonly unknown[]
  readonly resume_candidate_id: string | null
  readonly intake_asset_id: string | null
  readonly asset_validation_status: string | null
  readonly intake_record_id: string | null
  readonly intake_record_status: string | null
  readonly event_provider: string | null
}

interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string
  readonly dimensions: readonly unknown[]
  readonly created_at: string | Date
  readonly job_id: string
}

interface ApprovalRow {
  readonly status: string
  readonly payload_schema_version: number
  readonly canonical_payload_hash: string
  readonly expires_at: string | Date | null
  readonly superseded_by_approval_id: string | null
  readonly resource_id: string
}

/** 一条 criterion（JR §6.1 的 9 个键，键封闭）。 */
interface Criterion {
  readonly key: string
  readonly label: string
  readonly kind: 'MUST_HAVE' | 'NICE_TO_HAVE' | 'DISQUALIFIER'
  readonly weight: number
  readonly field?: string
  readonly operator?: 'EXISTS' | 'GTE' | 'LTE'
  readonly value?: boolean | number
  readonly question?: string
  readonly notes?: string
}

const CRITERION_KEYS: ReadonlySet<string> = new Set([
  'key', 'label', 'kind', 'weight', 'field', 'operator', 'value', 'question', 'notes',
])

/** 可机械判定的字段白名单（JR §6.3，封闭）。 */
const BOOLEAN_FIELDS: ReadonlySet<string> = new Set(['work_experience', 'education'])
const INTEGER_FIELDS: ReadonlySet<string> = new Set([
  'timeline.covered_months_closed', 'work_experience.entry_count', 'education.entry_count',
])

/** 一期统计（供 verdict_summary 与 counts 使用）。 */
interface Tally {
  mustHave: number
  mustSatisfied: number
  mustUnsatisfied: number
  mustUncertain: number
  disqTriggered: number
  disqClear: number
  disqUncertain: number
}

/**
 * 判断型 / 机械型 criterion 的求值产物。
 */
interface CriterionResult {
  readonly reason: ScreenReason
  readonly uncertain: boolean
  readonly unsatisfied: boolean
  readonly satisfied: boolean
  readonly triggered: boolean
  readonly cleared: boolean
  readonly outcome: string
}

/** 评估上下文：一次调用的所有只读输入（导出供单测构造假上下文，不连库）。 */
export interface EvalContext {
  readonly client: DatabaseClient
  readonly cfg: ResolvedDatabaseConfig
  readonly app: ApplicationRow
  readonly rv: ResumeVersionRow
  readonly asOfIso: string
  readonly warnings: ScreenWarning[]
  readonly parsed: {
    readonly fields: Record<string, ConverterStateEntry | undefined>
    readonly timeline?: Record<string, unknown>
    readonly issues: readonly MaterialIssue[]
    readonly screening?: { eligible_fields?: readonly string[]; blocked_fields?: readonly { field?: string; reason?: string }[] }
    readonly meta?: { pages?: number }
  }
  readonly hardIssueCount: number
  readonly absentTrustworthy: boolean
}

export interface ConverterStateEntry {
  readonly state?: string
  readonly value?: string | number | boolean | null
  readonly reason?: string
  readonly provenance?: string
  /** 三态是谁给的：缺省 = converter；`agent_structured` = agent 结构化覆写（S6 写入）。 */
  readonly state_source?: string
  /** 被覆写前 converter 给的原始三态（D-29 要求两者同时保留，否则看不出是否升级过）。 */
  readonly converter_state?: string
  readonly entry_count?: number
  /** agent 结构化结果引用的 block id（升序）；用于把证据限定在字段自己引用的块上。 */
  readonly block_ids?: readonly number[]
  /** agent 有证据但缺 page/bbox，S6 已标记可回查（不得静默当成"没有证据"）。 */
  readonly evidence_unlocatable?: boolean
  readonly evidence?: readonly {
    readonly page?: number
    readonly bbox?: readonly number[]
    readonly block?: number
    /** agent 块 id（converter 证据没有这个键）。 */
    readonly block_id?: number
    readonly text?: string
    readonly source?: string
    readonly source_asset_sha256?: string
  }[]
  /** agent 的全部证据（含缺坐标的）；只在说明"为什么降级"时读。 */
  readonly agent_evidence?: readonly {
    readonly block_id?: number
    readonly block_no?: number
    readonly page?: number | null
    readonly bbox?: readonly number[] | null
    readonly quote?: string
  }[]
}

// =====================================================================
//  读路径
// =====================================================================

async function loadApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationRow> {
  const { rows } = await client.query<ApplicationRow>(
    `select a.id, a.candidate_id, a.job_id, a.job_version_id, a.rubric_version_id,
            a.resume_version_id, a.lifecycle_status, a.current_stage_code,
            a.stage_blocked_reason, a.record_version,
            j.title as job_title, j.status as job_status, j.code as job_code
       from recruitment.application a
       join recruitment.job j on j.id = a.job_id and j.tenant_id = a.tenant_id
      where a.id = $1 and a.tenant_id = $2`,
    [applicationId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'APPLICATION_NOT_FOUND',
      message: '该租户下没有这个申请',
      detail: { application_id: applicationId, tenant_id: tenantId },
    })
  }
  return row
}

async function loadResumeVersion(
  client: DatabaseClient,
  tenantId: string,
  resumeVersionId: string,
): Promise<ResumeVersionRow> {
  const { rows } = await client.query<ResumeVersionRow>(
    `select rv.id, rv.version_no, rv.parse_status, rv.source_asset_sha256, rv.content_sha256,
            rv.parser_name, rv.parser_version, rv.parsed_fields, rv.evidence,
            r.candidate_id as resume_candidate_id,
            ia.id as intake_asset_id, ia.validation_status as asset_validation_status,
            ir.id as intake_record_id, ir.status as intake_record_status,
            ev.provider as event_provider
       from recruitment.resume_version rv
       left join recruitment.resume r
              on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       left join recruitment.intake_asset ia
              on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       left join recruitment.intake_record ir
              on ir.id = ia.intake_record_id and ir.tenant_id = ia.tenant_id
       left join recruitment.event_inbox ev
              on ev.event_id = ir.event_id and ev.tenant_id = ir.tenant_id
      where rv.id = $1 and rv.tenant_id = $2`,
    [resumeVersionId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'RESUME_VERSION_NOT_FOUND',
      message: '该租户下没有这个材料版本',
      detail: { resume_version_id: resumeVersionId },
    })
  }
  return row
}

async function loadRubricVersions(
  client: DatabaseClient,
  tenantId: string,
  jobId: string,
): Promise<{ versions: RubricRow[]; approvals: Map<string, ApprovalRow[]> }> {
  const versions = await client.query<RubricRow>(
    `select id, version_no, payload_hash, dimensions, created_at, job_id
       from recruitment.rubric_version
      where tenant_id = $1 and job_id = $2
      order by version_no`,
    [tenantId, jobId],
  )
  const approvals = await client.query<ApprovalRow>(
    `select resource_id, status, payload_schema_version, canonical_payload_hash,
            expires_at, superseded_by_approval_id
       from recruitment.approval
      where tenant_id = $1 and resource_type = 'RUBRIC_VERSION'`,
    [tenantId],
  )
  const byRubric = new Map<string, ApprovalRow[]>()
  for (const row of approvals.rows) {
    const list = byRubric.get(row.resource_id)
    if (list === undefined) byRubric.set(row.resource_id, [row])
    else list.push(row)
  }
  return { versions: versions.rows, approvals: byRubric }
}

/** `timestamptz` 可能是 pg 给的 `Date`，也可能是测试造的字符串：统一取毫秒。 */
function toMs(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN
  if (value instanceof Date) return value.getTime()
  return Date.parse(value)
}

/**
 * JR §4.2 `approved(v, as_of)`。
 * @param version - 待判版本。
 * @param approvals - 该版本的审批行（可能多条）。
 * @param asOfIso - 判定基准时刻。
 */
function approvedAt(version: RubricRow, approvals: readonly ApprovalRow[], asOfIso: string): ApprovalRow | null {
  const asOf = Date.parse(asOfIso)
  if (!Number.isFinite(asOf) || toMs(version.created_at) > asOf) return null
  for (const approval of approvals) {
    if (approval.status !== 'APPROVED') continue
    if (approval.resource_id !== version.id) continue
    if (approval.canonical_payload_hash !== version.payload_hash) continue
    if (approval.superseded_by_approval_id !== null) continue
    const expiresAt = toMs(approval.expires_at)
    if (Number.isFinite(expiresAt) && expiresAt <= asOf) continue
    return approval
  }
  return null
}

/** 审批状态的人类可读标签（只用于 `NO_APPROVED_RUBRIC` 的 detail）。 */
function approvalLabel(approvals: readonly ApprovalRow[], version: RubricRow, asOfIso: string): string {
  if (approvedAt(version, approvals, asOfIso) !== null) return 'APPROVED'
  if (approvals.length === 0) return 'NO_APPROVAL'
  const asOf = Date.parse(asOfIso)
  for (const approval of approvals) {
    if (approval.resource_id !== version.id) continue
    if (approval.canonical_payload_hash !== version.payload_hash) return 'HASH_MISMATCH'
    if (approval.status === 'APPROVED' && approval.superseded_by_approval_id !== null) return 'SUPERSEDED'
    const expiresAt = toMs(approval.expires_at)
    if (approval.status === 'APPROVED' && Number.isFinite(expiresAt) && expiresAt <= asOf) return 'EXPIRED'
    return approval.status
  }
  return 'NO_APPROVAL'
}

// =====================================================================
//  阻断检查（SR §6.2 HQ-1…HQ-7）
// =====================================================================

interface BlockingItem {
  readonly code: string
  readonly family: string
  readonly ref_kind: string
  readonly ref_id: string
  readonly task_id?: string
  readonly task_type?: string
  readonly field?: string
  readonly reason?: string
}

/**
 * 跑完 HQ-1…HQ-7，返回全部命中项（顺序 = HQ 编号）。
 * **不静默跳过**：命中即整次评估不出任何 criterion 结果（SR §6.3 第 3 条）。
 */
async function collectBlockingItems(
  client: DatabaseClient,
  tenantId: string,
  app: ApplicationRow,
  rv: ResumeVersionRow,
  materialBound: boolean,
): Promise<BlockingItem[]> {
  const items: BlockingItem[] = []

  // HQ-1：有人在等（business_refs 命中 application / candidate / resume_version）。
  const tasks = await client.query<{ id: string; task_type: string; ref_kind: string; ref_id: string }>(
    `select t.id, t.task_type, ref->>'kind' as ref_kind, ref->>'id' as ref_id
       from recruitment.business_task t
       cross join lateral jsonb_array_elements(t.business_refs) as ref
      where t.tenant_id = $1
        and t.status = 'WAITING_HUMAN'
        and ref->>'kind' in ('APPLICATION', 'CANDIDATE', 'RESUME_VERSION')
        and (
          (ref->>'kind' = 'APPLICATION' and ref->>'id' = $2)
          or (ref->>'kind' = 'CANDIDATE' and ref->>'id' = $3)
          or (ref->>'kind' = 'RESUME_VERSION' and ref->>'id' = $4)
        )
      order by t.created_at`,
    [tenantId, app.id, app.candidate_id, rv.id],
  )
  for (const row of tasks.rows) {
    items.push({
      code: 'HUMAN_TASK_WAITING',
      family: 'HUMAN_QUEUE',
      ref_kind: row.ref_kind,
      ref_id: row.ref_id,
      task_id: row.id,
      task_type: row.task_type,
    })
  }

  // HQ-2 / HQ-4 / HQ-5：材料解析状态。
  if (rv.parse_status === 'NEEDS_REVIEW') {
    items.push({
      code: 'PARSE_NEEDS_REVIEW', family: 'HUMAN_QUEUE', ref_kind: 'RESUME_VERSION', ref_id: rv.id,
    })
  }
  if (rv.parse_status === 'FAILED') {
    items.push({
      code: 'MATERIAL_PARSE_FAILED', family: 'MATERIAL', ref_kind: 'RESUME_VERSION', ref_id: rv.id,
    })
  }
  if (rv.parse_status === 'PENDING' || rv.parse_status === 'PARSING') {
    items.push({
      code: 'MATERIAL_NOT_READY', family: 'MATERIAL', ref_kind: 'RESUME_VERSION', ref_id: rv.id,
    })
  }

  // HQ-3：收件记录待人工。
  if (rv.intake_record_status === 'NEEDS_REVIEW' && rv.intake_record_id !== null) {
    items.push({
      code: 'INTAKE_NEEDS_REVIEW', family: 'HUMAN_QUEUE', ref_kind: 'INTAKE_RECORD', ref_id: rv.intake_record_id,
    })
  }

  // HQ-6：申请没绑材料且入参也没给。
  if (!materialBound) {
    items.push({
      code: 'MATERIAL_NOT_BOUND', family: 'MATERIAL', ref_kind: 'APPLICATION', ref_id: app.id,
    })
  }

  // HQ-7：原件校验失败。
  if (rv.asset_validation_status === 'INVALID' && rv.intake_asset_id !== null) {
    items.push({
      code: 'INTAKE_ASSET_INVALID', family: 'MATERIAL', ref_kind: 'INTAKE_ASSET', ref_id: rv.intake_asset_id,
    })
  }

  return items
}

// =====================================================================
//  Rubric 结构校验（JR §6.2 R-VAL-1…13）
// =====================================================================

interface RuleViolation {
  readonly rule: string
  readonly reason_code: string
  readonly path: string
  readonly got?: unknown
}

/**
 * R-VAL-1…13（只看 `dimensions`，不碰审批）。任一违反 → `NO_RUBRIC/RUBRIC_INVALID`。
 * @param dimensions - `rubric_version.dimensions`。
 */
export function validateDimensions(dimensions: readonly unknown[]): RuleViolation[] {
  const violations: RuleViolation[] = []
  if (!Array.isArray(dimensions) || dimensions.length < 1 || dimensions.length > 50) {
    violations.push({ rule: 'R-VAL-1', reason_code: 'DIMENSIONS_SHAPE', path: 'dimensions' })
    return violations
  }
  const seenKeys = new Set<string>()
  let weightSum = 0
  let deciding = 0
  dimensions.forEach((raw, index) => {
    const path = `dimensions[${index}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      violations.push({ rule: 'R-VAL-2', reason_code: 'CRITERION_NOT_OBJECT', path })
      return
    }
    const criterion = raw as Record<string, unknown>
    for (const key of Object.keys(criterion)) {
      if (!CRITERION_KEYS.has(key)) {
        violations.push({ rule: 'R-VAL-2', reason_code: 'CRITERION_UNKNOWN_KEY', path: `${path}.${key}`, got: key })
      }
    }
    const key = criterion.key
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(key)) {
      violations.push({ rule: 'R-VAL-3', reason_code: 'CRITERION_KEY', path: `${path}.key`, got: key })
    } else if (seenKeys.has(key)) {
      violations.push({ rule: 'R-VAL-3', reason_code: 'CRITERION_KEY', path: `${path}.key`, got: key })
    } else {
      seenKeys.add(key)
    }
    const label = criterion.label
    if (typeof label !== 'string' || label.trim().length < 1 || label.trim().length > 200) {
      violations.push({ rule: 'R-VAL-4', reason_code: 'CRITERION_LABEL', path: `${path}.label` })
    }
    const kind = criterion.kind
    if (kind !== 'MUST_HAVE' && kind !== 'NICE_TO_HAVE' && kind !== 'DISQUALIFIER') {
      violations.push({ rule: 'R-VAL-5', reason_code: 'CRITERION_KIND', path: `${path}.kind`, got: kind })
    } else if (kind !== 'NICE_TO_HAVE') {
      deciding += 1
    }
    const weight = criterion.weight
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1) {
      violations.push({ rule: 'R-VAL-6', reason_code: 'WEIGHT_RANGE', path: `${path}.weight`, got: weight })
    } else {
      weightSum += weight
    }
    const hasField = criterion.field !== undefined && criterion.field !== null
    const hasOperator = criterion.operator !== undefined && criterion.operator !== null
    const hasValue = criterion.value !== undefined && criterion.value !== null
    if ((hasField && (!hasOperator || !hasValue)) || (!hasField && (hasOperator || hasValue))) {
      violations.push({ rule: 'R-VAL-7', reason_code: 'CRITERION_PARTIAL', path })
    }
    if (hasField) {
      const field = criterion.field
      if (typeof field !== 'string' || (!BOOLEAN_FIELDS.has(field) && !INTEGER_FIELDS.has(field))) {
        const isProtected = typeof field === 'string' && (field.startsWith('protected.') || ['name', 'phone', 'email'].includes(field))
        violations.push({
          rule: 'R-VAL-8',
          reason_code: isProtected ? 'PROTECTED_ATTRIBUTE_IN_CRITERIA' : 'CRITERION_FIELD',
          path: `${path}.field`,
          got: field,
        })
      }
    }
    if (hasOperator && criterion.operator !== 'EXISTS' && criterion.operator !== 'GTE' && criterion.operator !== 'LTE') {
      violations.push({ rule: 'R-VAL-9', reason_code: 'CRITERION_OPERATOR', path: `${path}.operator`, got: criterion.operator })
    }
    if (hasField && hasOperator) {
      const field = criterion.field as string
      const booleanField = BOOLEAN_FIELDS.has(field)
      if (booleanField && criterion.operator !== 'EXISTS') {
        violations.push({ rule: 'R-VAL-10', reason_code: 'CRITERION_TYPE', path: `${path}.operator`, got: criterion.operator })
      }
      if (!booleanField && criterion.operator === 'EXISTS') {
        violations.push({ rule: 'R-VAL-10', reason_code: 'CRITERION_TYPE', path: `${path}.operator`, got: criterion.operator })
      }
    }
    if (hasValue && hasOperator) {
      if (criterion.operator === 'EXISTS' && criterion.value !== true) {
        violations.push({ rule: 'R-VAL-11', reason_code: 'CRITERION_VALUE', path: `${path}.value`, got: criterion.value })
      }
      if ((criterion.operator === 'GTE' || criterion.operator === 'LTE')
        && (typeof criterion.value !== 'number' || !Number.isInteger(criterion.value))) {
        violations.push({ rule: 'R-VAL-11', reason_code: 'CRITERION_VALUE', path: `${path}.value`, got: criterion.value })
      }
    }
    if (!hasField) {
      const question = criterion.question
      if (typeof question !== 'string' || question.trim().length < 1 || question.trim().length > 500) {
        violations.push({ rule: 'R-VAL-12', reason_code: 'CRITERION_QUESTION', path: `${path}.question` })
      }
    }
  })
  if (Math.abs(weightSum - 1) > 1e-6) {
    violations.push({ rule: 'R-VAL-6', reason_code: 'WEIGHT_SUM', path: 'dimensions', got: weightSum })
  }
  if (deciding === 0) {
    violations.push({ rule: 'R-VAL-13', reason_code: 'NO_DECIDING_CRITERIA', path: 'dimensions' })
  }
  return violations
}

// =====================================================================
//  criterion 求值（SR §3 / §4）
// =====================================================================

/** 三态 + 该字段的取值（有界量另带 bounds）。 */
interface FieldFact {
  readonly tri_state: 'present' | 'absent' | 'unreadable'
  readonly bounds?: 'EXACT' | 'LOWER_BOUND' | 'UNAVAILABLE'
  readonly value?: number
  readonly lower_bound?: number
  readonly issue_codes: readonly string[]
  readonly evidence: readonly ScreenEvidence[]
}

function addWarning(warnings: ScreenWarning[], warning: ScreenWarning): void {
  const signature = `${warning.code}|${canonicalJson(warning.ref ?? {})}`
  if (warnings.some((w) => `${w.code}|${canonicalJson(w.ref ?? {})}` === signature)) return
  warnings.push(warning)
}

/**
 * 读一个字段的三态（SR §3.2）。**不得自造三态**：`parsed_fields.fields` 里没有就 `unreadable`。
 * @param ctx - 评估上下文。
 * @param field - criterion 的 `field`。
 */
function resolveFieldFact(ctx: EvalContext, field: string): FieldFact {
  if (field.startsWith('timeline.')) return resolveTimelineFact(ctx, field)
  const root = field.split('.')[0] as string
  const entry = ctx.parsed.fields[root]
  const state = entry?.state
  const scan = evidenceFor(ctx, entry)
  if (state !== 'present' && state !== 'absent' && state !== 'unreadable') {
    addWarning(ctx.warnings, {
      code: 'FIELD_STATE_UNDECLARED',
      message: `${root} 在 parsed_fields 里没有三态，按 unreadable 处理（不推定 absent）`,
      ref: { field: root, source: 'parsed_fields.fields' },
    })
    return { tri_state: 'unreadable', issue_codes: ['field_state_undeclared'], evidence: [] }
  }
  checkScreeningIndex(ctx, root, state, entry)
  if (state === 'present' && scan.evidence.length === 0) {
    // SR §8.2：present 必须有 ≥1 条 page+bbox+sha256 齐全的证据，否则等于没读出。
    // 但**不得静默降级**：agent 升级过的字段必须说明"哪几个 block、缺了什么坐标"，
    // 否则人只看到 unreadable，会误以为原文真的读不出。
    return {
      tri_state: 'unreadable',
      issue_codes: evidenceGapCodes(entry, scan),
      evidence: [],
    }
  }
  const adjusted = adjustAbsent(ctx, root, state)
  const numeric = entry?.entry_count
  return {
    tri_state: adjusted.state,
    ...(adjusted.state === 'present' && typeof numeric === 'number' ? { value: numeric } : {}),
    issue_codes: adjusted.state === 'unreadable'
      ? [typeof entry?.reason === 'string' && entry.reason !== '' ? entry.reason : 'field_unreadable']
      : adjusted.state === 'present'
        ? scan.issue_codes
        : [],
    evidence: adjusted.state === 'present' ? scan.evidence : [],
  }
}

/**
 * `timeline.*` 的三态与 bounds（SR §4.2.2 / §4.2.3）。
 *
 * **单一事实来源（Issue #1 §1.4）**：时间线只能来自当前有效版本的同一批字段。
 * converter 的 `timeline` 是在 converter 的 `fields` 上算出来的；一旦 agent 把
 * `work_experience` 从 `unreadable/absent` 升级成 `present`，这份 timeline 就不是
 * 同一份事实了——继续用它会产生**虚假的 FAIL**（例如旧值 0 个月 + GTE 60 → UNSATISFIED）。
 * 这种情况下不猜、不改写 converter 索引，只把量标为不可用（UNAVAILABLE → 未确认）。
 *
 * `covered_months_closed` 只是**闭区间下界**，直接比大小会系统性误杀在岗候选人。
 */
function resolveTimelineFact(ctx: EvalContext, field: string): FieldFact {
  const workEntry = ctx.parsed.fields.work_experience
  const workState = workEntry?.state
  const timeline = ctx.parsed.timeline
  const months = timeline?.covered_months_closed
  const openEnded = timeline?.open_ended_intervals
  const yearOnly = timeline?.year_only_intervals
  const inversion = ctx.parsed.issues.some((issue) => issue.code === 'resume_timeline_inversion')
  const usable = typeof months === 'number' && Number.isInteger(months)

  // 字段被 agent 升级过：旧 timeline 与有效字段不是同一版本的事实 → 不派生、不猜。
  if (workState === 'present' && upgradedByAgent(workEntry)) {
    return {
      tri_state: 'present',
      bounds: 'UNAVAILABLE',
      issue_codes: [
        'timeline_unconfirmed:work_experience_upgraded_by_agent',
        usable
          ? `converter_timeline_ignored:covered_months_closed=${months as number}`
          : 'converter_timeline_missing',
      ],
      evidence: [],
    }
  }

  if (workState !== 'present' || !usable) {
    const absent = workState === 'absent'
    return {
      tri_state: absent ? 'absent' : 'unreadable',
      bounds: 'UNAVAILABLE',
      issue_codes: absent ? ['work_experience_absent'] : [`timeline_unavailable:work_experience_${workState ?? 'undeclared'}`],
      evidence: [],
    }
  }
  const scan = evidenceFor(ctx, workEntry)
  if (scan.evidence.length === 0) {
    // 字段 present，但支撑它的证据不可定位 → 时间线也不可信（不是"没有工作经历"）。
    return {
      tri_state: 'present',
      bounds: 'UNAVAILABLE',
      issue_codes: [
        'timeline_unconfirmed:work_experience_evidence_unlocatable',
        ...evidenceGapCodes(workEntry, scan),
      ],
      evidence: [],
    }
  }
  const exact = openEnded === 0 && yearOnly === 0 && !inversion
  if (exact) return { tri_state: 'present', bounds: 'EXACT', value: months, evidence: scan.evidence, issue_codes: [] }
  return {
    tri_state: 'present',
    bounds: 'LOWER_BOUND',
    lower_bound: months,
    evidence: scan.evidence,
    issue_codes: [],
  }
}

/**
 * 字段的三态是不是被 agent 结构化**覆盖**过（升级或降级都算；键名沿用 "upgraded"）。
 *
 * `converter_state` 是 S6 在覆写时保留的原值（D-29）；缺它就保守地当作覆盖过，
 * 因为"不知道原值"不能当成"原值一样"。
 * @param entry - 有效版本的字段条目。
 */
function upgradedByAgent(entry: ConverterStateEntry | undefined): boolean {
  if (entry === undefined) return false
  const agentSourced = entry.state_source === 'agent_structured' || entry.provenance === 'agent_read'
  if (!agentSourced) return false
  if (typeof entry.converter_state !== 'string') return true
  return entry.converter_state !== entry.state
}

/** 证据为什么不够：逐条写清 block_ids 与缺的坐标，供 reason.message 直接展示。 */
function evidenceGapCodes(entry: ConverterStateEntry | undefined, scan: EvidenceScan): string[] {
  const codes = ['evidence_missing', ...scan.issue_codes]
  const agentTotal = entry?.agent_evidence?.length ?? 0
  if (agentTotal > 0) {
    const located = (entry?.agent_evidence ?? []).filter((item) => (
      typeof item.page === 'number' && item.page >= 1
      && Array.isArray(item.bbox) && item.bbox.length === 4
      && item.bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
    )).length
    codes.push(`agent_evidence_total:${agentTotal}`, `agent_evidence_with_page_and_bbox:${located}`)
  }
  if (entry?.evidence_unlocatable === true) codes.push('evidence_unlocatable')
  const blockIds = Array.isArray(entry?.block_ids) ? entry.block_ids : []
  if (blockIds.length > 0) codes.push(`field_block_ids:${blockIds.join(',')}`)
  if (upgradedByAgent(entry)) codes.push('field_upgraded_by_agent:state_from_agent_structured')
  return [...new Set(codes)]
}

/** SR §3.2 第 3 条：`eligible_fields` / `blocked_fields` 与 `fields[*].state` 必须自洽。 */
function checkScreeningIndex(
  ctx: EvalContext,
  root: string,
  state: string,
  entry: ConverterStateEntry | undefined,
): void {
  const eligible = ctx.parsed.screening?.eligible_fields
  if (eligible === undefined) return
  const isEligible = eligible.includes(root)
  if ((state === 'present') !== isEligible) {
    const upgraded = upgradedByAgent(entry)
    addWarning(ctx.warnings, {
      code: 'SCREENING_INDEX_INCONSISTENT',
      message: upgraded
        ? `${root} 的旧 converter 索引（${isEligible ? 'eligible' : 'blocked'}）与 agent 覆盖后的 state=${state} 不一致；`
          + '已按有效字段读取并忽略旧索引，结论不受旧索引影响'
        : `${root} 的 state 与 screening 索引不一致；以 fields[${root}].state 为准`,
      ref: { field: root, source: upgraded ? 'screening.eligible_fields(old)' : 'screening.eligible_fields' },
    })
  }
}

/**
 * SR §3.3：材料没读完时，上游给的 `absent` 不可信 → 降级为 `unreadable`。
 * 判定口径：`parse_status ∈ {PARSED, PARTIAL}` 且 **HARD issue 数为 0** 才可信。
 */
function adjustAbsent(
  ctx: EvalContext,
  root: string,
  state: 'present' | 'absent' | 'unreadable',
): { state: 'present' | 'absent' | 'unreadable'; reason?: string } {
  if (state !== 'absent') return { state }
  if (ctx.absentTrustworthy) return { state }
  addWarning(ctx.warnings, {
    code: 'ABSENT_DOWNGRADED',
    message: `材料 parse_status=${ctx.rv.parse_status} 且有 ${ctx.hardIssueCount} 个 HARD issue，`
      + `上游给的 absent 已降级为 unreadable`,
    ref: { field: root, source: 'parsed_fields.fields.state' },
  })
  return { state: 'unreadable', reason: 'document_not_fully_read' }
}

/** 证据扫描结果：可用证据 + 被剔除的原因（原因进 reason.issue_codes，不静默丢）。 */
interface EvidenceScan {
  readonly evidence: ScreenEvidence[]
  readonly issue_codes: readonly string[]
}

/**
 * 取字段的证据条目（SR §8.2 / TC §5.3 第 4 条）。
 *
 * 三道闸门，全部**显式记录原因**：
 *   1. agent 证据引用的 `block_id` 必须落在该字段自己的 `block_ids` 里；
 *   2. `page ≥ 1` 且 `bbox` 是 4 个有限数（缺一个就不算可定位）；
 *   3. `source_asset_sha256` 必须与当前材料一致。
 * @param ctx - 评估上下文。
 * @param entry - 有效版本的字段条目。
 */
function evidenceFor(ctx: EvalContext, entry: ConverterStateEntry | undefined): EvidenceScan {
  const out: ScreenEvidence[] = []
  const codes: string[] = []
  const fieldBlockIds = Array.isArray(entry?.block_ids) ? entry.block_ids : []
  let agentWithoutCoords = 0
  for (const item of entry?.evidence ?? []) {
    const agentSourced = item.source === 'agent_structured' || typeof item.block_id === 'number'
    if (agentSourced && typeof item.block_id === 'number' && fieldBlockIds.length > 0
      && !fieldBlockIds.includes(item.block_id)) {
      codes.push(`evidence_block_id_not_in_field_block_ids:${item.block_id}`)
      continue
    }
    const page = typeof item.page === 'number' ? item.page : 0
    const bbox = (item.bbox ?? []).map((n) => (typeof n === 'number' ? n : Number.NaN))
    if (page < 1 || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(n))) {
      if (agentSourced) agentWithoutCoords += 1
      continue
    }
    const declared = item.source_asset_sha256
    if (typeof declared === 'string' && declared !== '' && declared !== ctx.rv.source_asset_sha256) {
      addWarning(ctx.warnings, {
        code: 'EVIDENCE_SHA_MISMATCH',
        message: '证据里的 source_asset_sha256 与材料不一致，该证据不可信',
        ref: { field: 'evidence' },
      })
      continue
    }
    out.push({
      resume_version_id: ctx.rv.id,
      source_asset_sha256: ctx.rv.source_asset_sha256,
      page,
      bbox,
      block: typeof item.block === 'number' ? item.block : -1,
      quote: typeof item.text === 'string' ? item.text : '',
      provenance: typeof entry?.provenance === 'string' ? entry.provenance : 'unknown',
    })
  }
  if (agentWithoutCoords > 0) codes.push(`agent_evidence_without_page_or_bbox:${agentWithoutCoords}`)
  return { evidence: out, issue_codes: [...new Set(codes)] }
}

/** `kind` + `outcome` → `reason.code`（SR §7.3 的封闭表）。 */
function codeOf(kind: string, outcome: string): string {
  const prefix = kind === 'MUST_HAVE' ? 'MUST_HAVE' : kind === 'DISQUALIFIER' ? 'DISQUALIFIER' : 'BONUS'
  return `${prefix}_${outcome}`
}

/** `outcome` → `failure_class`（SR §7.3）。 */
function failureClassOf(outcome: string): string {
  switch (outcome) {
    case 'SATISFIED':
    case 'CLEAR':
      return 'HARD_PASS'
    case 'UNSATISFIED':
    case 'TRIGGERED':
      return 'HARD_FAIL'
    case 'MISSING':
      return 'NOT_PROVEN'
    case 'UNREADABLE':
      return 'UNREADABLE'
    case 'INDETERMINATE':
      return 'INDETERMINATE'
    default:
      return 'JUDGMENT'
  }
}

/** 一条 `expected`（不出现 null；`boolean` 与 `integer` 分两个键，因为 DSH 不支持 oneOf 混合标量）。 */
function expectedOf(criterion: Criterion): ScreenReason['expected'] | undefined {
  const operator = criterion.operator
  if (operator === undefined) return undefined
  const out: { operator?: string; value_integer?: number; value_boolean?: boolean; unit?: string } = { operator }
  if (typeof criterion.value === 'boolean') {
    out.value_boolean = criterion.value
  } else if (typeof criterion.value === 'number') {
    out.value_integer = criterion.value
    if (criterion.field === 'timeline.covered_months_closed') out.unit = 'MONTH'
    else if (criterion.field?.endsWith('.entry_count') === true) out.unit = 'ENTRY'
  }
  return out
}

/**
 * 求一条 criterion（SR §4）。判断型永远 `NEEDS_JUDGMENT`，永不导致 FAIL/PASS。
 * @param ctx - 评估上下文。
 * @param criterion - criterion 对象。
 * @param index - 在 `dimensions` 里的下标（只用于 message）。
 */
export function evaluateCriterion(ctx: EvalContext, criterion: Criterion, index: number): CriterionResult {
  const kind = criterion.kind
  const base = {
    criterion_key: criterion.key,
    kind,
    ...(criterion.field === undefined ? {} : { field: criterion.field }),
  }
    if (criterion.field === undefined) {
    // 判断型：无机械三态，tri_state 省略（contract 里写 null），由 outcome 一一对应消歧。
    const expected = expectedOf(criterion)
    const reason: ScreenReason = {
      code: codeOf(kind, 'NEEDS_JUDGMENT'),
      failure_class: 'JUDGMENT',
      ...base,
      outcome: 'NEEDS_JUDGMENT',
      ...(expected === undefined ? {} : { expected }),
      evidence: [],
      issue_codes: [],
      ...(criterion.question === undefined ? {} : { question: criterion.question }),
      ...(criterion.notes === undefined ? {} : { notes: criterion.notes }),
      message: `这条要求机器判不了（第 ${index + 1} 条），需要人回答 rubric 里的原问句`,
    }
    return { reason, uncertain: kind !== 'NICE_TO_HAVE', unsatisfied: false, satisfied: false, triggered: false, cleared: false, outcome: 'NEEDS_JUDGMENT' }
  }

  const fact = resolveFieldFact(ctx, criterion.field)
  const operator = criterion.operator as 'EXISTS' | 'GTE' | 'LTE'
  const expected = expectedOf(criterion)
  const evidence = fact.tri_state === 'present' ? fact.evidence : []

  let outcome: string
  let message: string
  const observed: { value?: number; lower_bound?: number } = {}
  if (fact.tri_state === 'absent') {
    outcome = 'MISSING'
    message = `原文确实没有提到 ${criterion.field}（材料已读完、无 HARD issue）`
  } else if (fact.tri_state === 'unreadable') {
    outcome = 'UNREADABLE'
    const codes = fact.issue_codes.join(', ')
    // 只有"字段本身 present、但证据不可定位"这一族才换措辞；`field_state_undeclared` 不是。
    const evidenceGap = fact.issue_codes.some((code) => (
      code === 'evidence_missing'
      || code.startsWith('evidence_')
      || code.startsWith('agent_evidence_')
      || code.startsWith('field_block_ids')
      || code.startsWith('field_upgraded_by_agent')
    ))
    message = evidenceGap
      ? `${criterion.field} 的有效字段状态是 present，但没有可定位的证据（${codes}）；按未确认处理，不得据此判定不满足`
      : `${criterion.field} 有原文但读不出（issue: ${codes}）；不得据此判定不满足`
  } else if (operator === 'EXISTS') {
    outcome = 'SATISFIED'
    message = `${criterion.field} 已读出（state=present）`
  } else {
    const isTimeline = criterion.field.startsWith('timeline.')
    const bounds = fact.bounds ?? (isTimeline ? 'UNAVAILABLE' : 'EXACT')
    const value = typeof fact.value === 'number' ? fact.value : Number.NaN
    const lower = typeof fact.lower_bound === 'number' ? fact.lower_bound : value
    if (!isTimeline) {
      if (!Number.isInteger(value)) {
        // 读到了 state，但这个量在 parsed_fields 里不存在（例如 entry_count 尚未发布）
        // ⇒ SR §3.4「present 但量不可比」→ INDETERMINATE，**不得**判不满足。
        outcome = 'INDETERMINATE'
        message = `${criterion.field} 的分量在 parsed_fields 里没有可复算的整数值，无法比较`
      } else {
        observed.value = value
        const target = criterion.value as number
        const hit = operator === 'GTE' ? value >= target : value <= target
        outcome = hit ? 'SATISFIED' : 'UNSATISFIED'
        message = `已复算 ${criterion.field}=${value}，要求 ${operator} ${target}`
      }
    } else if (bounds === 'EXACT') {
      observed.value = value
      const target = criterion.value as number
      const hit = operator === 'GTE' ? value >= target : value <= target
      outcome = hit ? 'SATISFIED' : 'UNSATISFIED'
      message = `闭区间已覆盖 ${value} 个月，要求 ${operator} ${target}`
    } else if (bounds === 'LOWER_BOUND') {
      observed.lower_bound = lower
      const target = criterion.value as number
      if (operator === 'GTE') {
        // 下界够 ⇒ 成立；不够 ⇒ 不知道（**不得**判不满足）。
        outcome = lower >= target ? 'SATISFIED' : 'INDETERMINATE'
        message = lower >= target
          ? `闭区间下界已覆盖 ${lower} 个月（≥${target}），即使开放区间不计入也已满足`
          : `闭区间只覆盖 ${lower} 个月（<${target}），但材料含开放区间/年粒度区间，总量未知`
      } else {
        outcome = lower > target ? 'UNSATISFIED' : 'INDETERMINATE'
        message = lower > target
          ? `闭区间下界已达 ${lower} 个月（>${target}），反证成立`
          : `闭区间只覆盖 ${lower} 个月，无法判断总量是否 ≤${target}`
      }
    } else {
      outcome = 'UNREADABLE'
      // 有效字段本身是 present，但这份版本没有可复算的时间线：**未确认**，不是"读不出这个人"。
      message = `${criterion.field} 的时间线未确认（${fact.issue_codes.join('; ')}）；`
        + '不据此判定满足或不满足'
    }
  }

  const finalOutcome = kind === 'DISQUALIFIER'
    ? (outcome === 'SATISFIED' ? 'TRIGGERED' : outcome === 'UNSATISFIED' ? 'CLEAR' : outcome)
    : outcome

  const reason: ScreenReason = {
    code: codeOf(kind, finalOutcome),
    failure_class: failureClassOf(finalOutcome),
    ...base,
    outcome: finalOutcome,
    tri_state: fact.tri_state,
    ...(fact.bounds === undefined ? {} : { bounds: fact.bounds }),
    expected,
    ...(Object.keys(observed).length === 0 ? {} : { observed }),
    evidence,
    ...(fact.tri_state === 'absent'
      ? {
        absence: {
          document_sha256: ctx.rv.source_asset_sha256,
          page_count: typeof ctx.parsed.meta?.pages === 'number' ? ctx.parsed.meta.pages : 0,
          completeness: 'complete',
          searched_scopes: [criterion.field],
          basis: `parsed_fields.fields.${criterion.field.split('.')[0] as string}.state=absent`,
          hard_issue_count: ctx.hardIssueCount,
        },
      }
      : {}),
    issue_codes: fact.tri_state === 'absent' ? [] : fact.issue_codes,
    ...(criterion.question === undefined ? {} : { question: criterion.question }),
    ...(criterion.notes === undefined ? {} : { notes: criterion.notes }),
    message,
  }
  const uncertain = ['MISSING', 'UNREADABLE', 'INDETERMINATE', 'NEEDS_JUDGMENT'].includes(finalOutcome)
  return {
    reason,
    uncertain,
    unsatisfied: finalOutcome === 'UNSATISFIED',
    satisfied: finalOutcome === 'SATISFIED',
    triggered: finalOutcome === 'TRIGGERED',
    cleared: finalOutcome === 'CLEAR',
    outcome: finalOutcome,
  }
}

// =====================================================================
//  主流程
// =====================================================================

/**
 * 把 `parsed_fields` 拆成 S7 需要的四块（白名单：fields / timeline / issues / screening / meta）。
 *
 * **单一事实来源**：`screening` 里保留的是 converter 原索引，**只用于诊断 warning**
 * （SR §3.2 的自洽检查）；任何 outcome / verdict 都不读它——eligibility 由
 * `fields[*].state` 在读取时派生。`timeline` 是否可用由 `resolveTimelineFact()`
 * 按"是否被 agent 升级过"判定（旧 timeline 不得污染升级后的字段）。
 * @param raw - `resume_version.parsed_fields`。
 */
function readParsedFields(raw: Record<string, unknown>): EvalContext['parsed'] {
  const fields = (typeof raw.fields === 'object' && raw.fields !== null ? raw.fields : {}) as Record<string, ConverterStateEntry | undefined>
  const issues = Array.isArray(raw.issues) ? (raw.issues as readonly MaterialIssue[]) : []
  const timeline = typeof raw.timeline === 'object' && raw.timeline !== null ? (raw.timeline as Record<string, unknown>) : undefined
  const screening = typeof raw.screening === 'object' && raw.screening !== null
    ? (raw.screening as { eligible_fields?: readonly string[]; blocked_fields?: readonly { field?: string; reason?: string }[] })
    : undefined
  const meta = typeof raw.meta === 'object' && raw.meta !== null ? (raw.meta as { pages?: number }) : undefined
  return { fields, issues, ...(timeline === undefined ? {} : { timeline }), ...(screening === undefined ? {} : { screening }), ...(meta === undefined ? {} : { meta }) }
}

/**
 * 只读事务里完成一次评估。单独导出是为了让集成测试在"必回滚事务"里跑判定矩阵。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析配置（租户与 actor 从这里来，不接受入参覆盖）。
 * @param args - 已通过 `parseContractArgs` 的入参。
 * @param nowMs - 服务端当前毫秒（`as_of` 的"不得晚于"基准；输出里不出现）。
 */
export async function evaluateInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  nowMs: number,
): Promise<EvaluateValue> {
  const tenantId = cfg.tenant_id
  const applicationId = args.application_id as string
  const asOfArg = typeof args.as_of === 'string' ? args.as_of : undefined
  const asOfIso = asOfArg ?? new Date(nowMs).toISOString()
  const warnings: ScreenWarning[] = []

  const app = await loadApplication(client, tenantId, applicationId)

  // ---- 材料绑定（HQ-6 的前置；入参优先，绝不"自动挑最新简历"）----
  const requestedRv = typeof args.resume_version_id === 'string' ? args.resume_version_id : undefined
  const materialBound = requestedRv !== undefined || app.resume_version_id !== null
  if (!materialBound) {
    throw contractError('BLOCKED_BY_REVIEW', {
      reason_code: 'MATERIAL_NOT_BOUND',
      message: '该申请没有绑定材料，且入参没有指定材料版本；筛选不得对此出结论',
      detail: {
        application_id: app.id,
        human_queue_checked: HUMAN_QUEUE_CHECKS,
        blocking_items: [
          { code: 'MATERIAL_NOT_BOUND', family: 'MATERIAL', ref_kind: 'APPLICATION', ref_id: app.id },
        ],
      },
    })
  }
  const rv = await loadResumeVersion(client, tenantId, (requestedRv ?? app.resume_version_id) as string)

  // ---- 材料归属（TC §3.1 第 1 条）----
  if (requestedRv !== undefined && requestedRv !== app.resume_version_id) {
    if (rv.resume_candidate_id === null) {
      throw contractError('BLOCKED_BY_REVIEW', {
        reason_code: 'MATERIAL_ATTRIBUTION_UNKNOWN',
        message: '入参指定的材料版本没有归属候选人，无法确认它属于该申请的人',
        detail: {
          application_id: app.id,
          human_queue_checked: HUMAN_QUEUE_CHECKS,
          blocking_items: [
            {
              code: 'MATERIAL_ATTRIBUTION_UNKNOWN',
              family: 'MATERIAL',
              ref_kind: 'RESUME_VERSION',
              ref_id: rv.id,
            },
          ],
        },
      })
    }
    if (rv.resume_candidate_id !== app.candidate_id) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'RESUME_NOT_BELONG_TO_CANDIDATE',
        message: '入参指定的材料版本属于另一个候选人',
        detail: {
          application_id: app.id,
          application_candidate_id: app.candidate_id,
          resume_version_id: rv.id,
          resume_candidate_id: rv.resume_candidate_id,
        },
      })
    }
  }

  // ---- HQ-1…HQ-7（一条命中即拒绝出结论）----
  const blocking = await collectBlockingItems(client, tenantId, app, rv, materialBound)
  if (blocking.length > 0) {
    const first = blocking[0] as BlockingItem
    throw contractError('BLOCKED_BY_REVIEW', {
      reason_code: first.code === 'MATERIAL_NOT_BOUND' ? 'MATERIAL_NOT_BOUND' : first.code,
      message: BLOCKING_MESSAGES[first.code] ?? '存在未处理的人工队列项或材料未就绪，筛选不得越过它出结论',
      detail: {
        application_id: app.id,
        resume_version_id: rv.id,
        human_queue_checked: HUMAN_QUEUE_CHECKS,
        blocking_items: blocking,
      },
    })
  }

  // ---- Rubric 解析（JR §4.3）----
  const { versions, approvals } = await loadRubricVersions(client, tenantId, app.job_id)
  const currentVersion = pickCurrent(versions, approvals, asOfIso)
  const requestedRubric = typeof args.rubric_version_id === 'string' ? args.rubric_version_id : undefined
  let resolution: 'ARGUMENT' | 'APPLICATION_PINNED' | 'JOB_CURRENT'
  let resolved: RubricRow | undefined
  if (requestedRubric !== undefined) {
    resolution = 'ARGUMENT'
    resolved = versions.find((v) => v.id === requestedRubric)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: '该岗位下没有入参指定的 Rubric 版本',
        detail: { job_id: app.job_id, rubric_version_id: requestedRubric, known_version_nos: versions.map((v) => v.version_no) },
      })
    }
  } else if (app.rubric_version_id !== null) {
    resolution = 'APPLICATION_PINNED'
    resolved = versions.find((v) => v.id === app.rubric_version_id)
    if (resolved === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'RUBRIC_VERSION_NOT_FOUND',
        message: '申请钉住的 Rubric 版本不在该岗位下（或已不存在）',
        detail: { job_id: app.job_id, rubric_version_id: app.rubric_version_id },
      })
    }
  } else {
    resolution = 'JOB_CURRENT'
    if (versions.length === 0) {
      throw contractError('NO_RUBRIC', {
        reason_code: 'NO_RUBRIC_AT_ALL',
        message: '该岗位还没有任何 Rubric 版本',
        detail: { job_id: app.job_id },
      })
    }
    resolved = currentVersion
    if (resolved === undefined) {
      throw contractError('NO_RUBRIC', {
        reason_code: 'NO_APPROVED_RUBRIC',
        message: '该岗位有 Rubric 版本，但没有一版在 as_of 时刻处于已批准状态',
        detail: {
          job_id: app.job_id,
          versions: versions.map((v) => ({
            version_no: v.version_no,
            status: approvalLabel(approvals.get(v.id) ?? [], v, asOfIso),
          })),
        },
      })
    }
  }

  // 钉住的版本也必须属于本岗位（0005 已用复合外键保证，这里仍显式判一次）。
  if (resolved.job_id !== app.job_id) {
    throw contractError('NO_RUBRIC', {
      reason_code: 'RUBRIC_JOB_MISMATCH',
      message: '该 Rubric 版本属于另一个岗位',
      detail: { application_job_id: app.job_id, rubric_job_id: resolved.job_id, rubric_version_id: resolved.id },
    })
  }

  const rubricApprovals = approvals.get(resolved.id) ?? []
  const approval = approvedAt(resolved, rubricApprovals, asOfIso)
  if (approval === null) {
    throw contractError('NO_RUBRIC', {
      reason_code: 'NO_APPROVED_RUBRIC',
      message: '该 Rubric 版本在 as_of 时刻没有处于已批准状态的审批（JR §4.2）',
      detail: {
        job_id: app.job_id,
        rubric_version_id: resolved.id,
        version_no: resolved.version_no,
        status: approvalLabel(rubricApprovals, resolved, asOfIso),
      },
    })
  }
  if (approval.payload_schema_version !== 1) {
    throw contractError('NO_RUBRIC', {
      reason_code: 'UNSUPPORTED_PAYLOAD_SCHEMA_VERSION',
      message: '审批绑定的 payload_schema_version 不是 1，本工具不支持',
      detail: { got: approval.payload_schema_version },
    })
  }

  const violations = validateDimensions(resolved.dimensions)
  if (violations.length > 0) {
    throw contractError('NO_RUBRIC', {
      reason_code: 'RUBRIC_INVALID',
      message: '该 Rubric 版本没有通过 R-VAL-1..13，不可执行',
      detail: { rubric_version_id: resolved.id, violations },
    })
  }
  const computedHash = digestOf(resolved.dimensions)
  if (computedHash !== resolved.payload_hash) {
    throw contractError('NO_RUBRIC', {
      reason_code: 'RUBRIC_INVALID',
      message: 'payload_hash 与 dimensions 的规范化哈希不一致（R-VAL-14）',
      detail: {
        rubric_version_id: resolved.id,
        violations: [{
          rule: 'R-VAL-14',
          reason_code: 'RUBRIC_HASH_MISMATCH',
          path: 'payload_hash',
          got: resolved.payload_hash,
          expected: computedHash,
        }],
      },
    })
  }

  const rubric = resolved
  const whatIf = resolution === 'ARGUMENT' && rubric.id !== app.rubric_version_id
  const rubricPinRequired = resolution === 'JOB_CURRENT'
  if (rubricPinRequired) {
    addWarning(warnings, {
      code: 'RUBRIC_PIN_REQUIRED',
      message: '本次按 JOB_CURRENT 解析；写侧落 decision 前必须先钉 rubric_version_id',
    })
  }
  if (whatIf) {
    addWarning(warnings, {
      code: 'WHAT_IF_EVALUATION',
      message: 'what_if=true 的评估结论不得用于写 decision',
    })
  }
  if (app.lifecycle_status === 'ON_HOLD') {
    addWarning(warnings, { code: 'APPLICATION_ON_HOLD', message: '申请处于 ON_HOLD（暂缓是流程动作，不是标准失效）' })
  }
  if (app.job_status === 'PAUSED') {
    addWarning(warnings, { code: 'JOB_PAUSED', message: '岗位已暂停；暂停不冻结在途申请' })
  }

  const parsed = readParsedFields(rv.parsed_fields as Record<string, unknown>)
  const hardIssueCount = hardIssueCodes(parsed.issues).length
  const absentTrustworthy = ['PARSED', 'PARTIAL'].includes(rv.parse_status) && hardIssueCount === 0
  const ctx: EvalContext = {
    client,
    cfg,
    app,
    rv,
    asOfIso,
    warnings,
    parsed,
    hardIssueCount,
    absentTrustworthy,
  }

  const prior = await client.query<{ id: string; result: string; rubric_version_id: string | null; decided_at: Date }>(
    // `decision` 表**没有** rubric_version_id 列（`tool-contracts.md` §3.7 / SR P-3）：
    // 唯一的版本指针在 `basis_refs[]` 里（库只校验它是 array，`0001_init.sql:1358`）。
    // 所以这里从 basis_refs 里取 kind='RUBRIC_VERSION' 的第一项；取不到就省略这个键。
    `select d.id, d.result, d.decided_at,
            (select b->>'id'
               from jsonb_array_elements(d.basis_refs) as b
              where b->>'kind' = 'RUBRIC_VERSION'
              limit 1) as rubric_version_id
       from recruitment.decision d
      where d.tenant_id = $1 and d.application_id = $2
        and d.decision_scope = 'SCREENING' and d.superseded_by_decision_id is null
      order by d.decided_at desc
      limit 1`,
    [tenantId, app.id],
  )

  const snapshot = {
    application_record_version: app.record_version,
    resume_version_id: rv.id,
    resume_content_sha256: rv.content_sha256,
    rubric_version_id: rubric.id,
    rubric_payload_hash: rubric.payload_hash,
  }

  // ---- STEP 1 门禁（业务状态 → NEEDS_REVIEW，不是错误码；JR §7.1）----
  const gate = gateReason(app)
  if (gate !== undefined) {
    const reasons = gate.map((code) => ({
      code,
      failure_class: 'GATE',
      evidence: [] as readonly ScreenEvidence[],
      issue_codes: [] as readonly string[],
      message: GATE_MESSAGES[code] ?? '岗位/申请状态不允许产生自动结论',
    }))
    const summary = `门禁命中 ${reasons.map((r) => r.code).join(', ')}：本次不评估任何 criterion`
    return finish({
      prior: prior.rows[0],
      value: {
        tool: TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        status: 'OK',
        advisory: true,
        read_only: true,
        labels: {
          provenance: rv.event_provider !== null && rv.event_provider !== 'internal' ? 'LIVE' : 'FIXTURE',
          trigger: 'MANUAL',
          connection: 'CONNECTED',
        },
        ...(asOfArg === undefined ? {} : { as_of: asOfArg }),
        application: applicationBlock(app),
        job: { id: app.job_id, title: app.job_title, status: app.job_status },
        resume_version: resumeVersionBlock(rv, hardIssueCount),
        rubric: rubricBlock(rubric, currentVersion, resolution, whatIf, rubricPinRequired),
        preconditions: {
          human_queue_checked: HUMAN_QUEUE_CHECKS,
          human_queue_clear: true,
          material_bound: true,
          material_ready: ['PARSED', 'PARTIAL'].includes(rv.parse_status),
          rubric_approved: true,
        },
        verdict: 'NEEDS_REVIEW',
        verdict_summary: summary,
        criteria_evaluated: false,
        required_human_action: 'RESOLVE_BLOCKER',
        reasons,
        bonus_signals: [],
        warnings,
        snapshot,
        evaluation_digest: digestOf({
          args, resolved_ids: { application_id: app.id, resume_version_id: rv.id, rubric_version_id: rubric.id },
          rubric_payload_hash: rubric.payload_hash, resume_content_sha256: rv.content_sha256,
          verdict: 'NEEDS_REVIEW', reasons,
        }),
      },
    })
  }

  // ---- STEP 2 逐 criterion ----
  const criteria = rubric.dimensions as unknown as Criterion[]
  const reasons: ScreenReason[] = []
  const bonus: ScreenReason[] = []
  const tally: Tally = {
    mustHave: 0, mustSatisfied: 0, mustUnsatisfied: 0, mustUncertain: 0,
    disqTriggered: 0, disqClear: 0, disqUncertain: 0,
  }
  let anyUnsatisfied = false
  let anyTriggered = false
  let mustUncertain = false
  let disqUncertain = false
  criteria.forEach((criterion, index) => {
    const result = evaluateCriterion(ctx, criterion, index)
    if (criterion.kind === 'NICE_TO_HAVE') {
      bonus.push(result.reason)
      return
    }
    reasons.push(result.reason)
    if (criterion.kind === 'MUST_HAVE') {
      tally.mustHave += 1
      if (result.satisfied) tally.mustSatisfied += 1
      if (result.unsatisfied) tally.mustUnsatisfied += 1
      if (result.uncertain) tally.mustUncertain += 1
      if (result.unsatisfied) anyUnsatisfied = true
      if (result.uncertain) mustUncertain = true
    } else {
      if (result.triggered) tally.disqTriggered += 1
      if (result.cleared) tally.disqClear += 1
      if (result.uncertain) tally.disqUncertain += 1
      if (result.triggered) anyTriggered = true
      if (result.uncertain) disqUncertain = true
    }
  })

  // ---- STEP 3/4/5 ----
  let verdict: 'PASS' | 'FAIL' | 'NEEDS_REVIEW'
  if (anyUnsatisfied || anyTriggered) verdict = 'FAIL'
  else if (mustUncertain || disqUncertain) verdict = 'NEEDS_REVIEW'
  else verdict = 'PASS'

  const summary = buildSummary(verdict, tally, reasons)
  const humanAction = pickHumanAction(verdict, reasons)

  return finish({
    prior: prior.rows[0],
    value: {
      tool: TOOL_NAME,
      contract_version: CONTRACT_VERSION,
      status: 'OK',
      advisory: true,
      read_only: true,
      labels: {
        provenance: rv.event_provider !== null && rv.event_provider !== 'internal' ? 'LIVE' : 'FIXTURE',
        trigger: 'MANUAL',
        connection: 'CONNECTED',
      },
      ...(asOfArg === undefined ? {} : { as_of: asOfArg }),
      application: applicationBlock(app),
      job: { id: app.job_id, title: app.job_title, status: app.job_status },
      resume_version: resumeVersionBlock(rv, hardIssueCount),
      rubric: rubricBlock(rubric, currentVersion, resolution, whatIf, rubricPinRequired),
      preconditions: {
        human_queue_checked: HUMAN_QUEUE_CHECKS,
        human_queue_clear: true,
        material_bound: true,
        material_ready: ['PARSED', 'PARTIAL'].includes(rv.parse_status),
        rubric_approved: true,
      },
      verdict,
      verdict_summary: summary,
      criteria_evaluated: true,
      required_human_action: humanAction,
      reasons,
      bonus_signals: bonus,
      warnings,
      snapshot,
      evaluation_digest: digestOf({
        args, resolved_ids: { application_id: app.id, resume_version_id: rv.id, rubric_version_id: rubric.id },
        rubric_payload_hash: rubric.payload_hash, resume_content_sha256: rv.content_sha256,
        verdict, reasons,
      }),
    },
  })
}

const BLOCKING_MESSAGES: Record<string, string> = {
  HUMAN_TASK_WAITING: '该候选人有一条待人工处理的任务，筛选不得越过它出结论',
  PARSE_NEEDS_REVIEW: '材料解析状态是 NEEDS_REVIEW，需要人先看完，筛选不得越过它',
  INTAKE_NEEDS_REVIEW: '收件记录待人工处理，筛选不得越过它',
  MATERIAL_PARSE_FAILED: '材料解析失败，没有可用的正文',
  MATERIAL_NOT_READY: '材料还在解析中（PENDING/PARSING）',
  MATERIAL_NOT_BOUND: '申请没有绑定材料',
  INTAKE_ASSET_INVALID: '原件校验失败（validation_status=INVALID）',
  MATERIAL_ATTRIBUTION_UNKNOWN: '材料归属未知',
}

const GATE_MESSAGES: Record<string, string> = {
  GATE_JOB_CLOSED: '岗位已关闭：不再对这个岗位的任何申请产生自动建议（JR §7.2）',
  GATE_JOB_ARCHIVED: '岗位已归档：仅查询，不产生自动建议',
  GATE_JOB_NOT_OPEN: '岗位尚未开放（DRAFT/PENDING_REVIEW/APPROVED），不该有在途申请',
  GATE_APPLICATION_NOT_ACTIVE: '申请已撤回或已关闭',
}

/** JR §7.1 的处理矩阵：命中即返回 GATE reason 列表（最多 2 条）。 */
function gateReason(app: ApplicationRow): string[] | undefined {
  const out: string[] = []
  if (app.job_status === 'CLOSED') out.push('GATE_JOB_CLOSED')
  else if (app.job_status === 'ARCHIVED') out.push('GATE_JOB_ARCHIVED')
  else if (['DRAFT', 'PENDING_REVIEW', 'APPROVED'].includes(app.job_status)) out.push('GATE_JOB_NOT_OPEN')
  if (['WITHDRAWN', 'CLOSED'].includes(app.lifecycle_status)) out.push('GATE_APPLICATION_NOT_ACTIVE')
  return out.length === 0 ? undefined : out
}

/** `current(job, as_of)`：已批准版本里 version_no 最大者（JR §4.2）。 */
function pickCurrent(
  versions: readonly RubricRow[],
  approvals: Map<string, ApprovalRow[]>,
  asOfIso: string,
): RubricRow | undefined {
  let best: RubricRow | undefined
  for (const version of versions) {
    if (approvedAt(version, approvals.get(version.id) ?? [], asOfIso) === null) continue
    if (best === undefined || version.version_no > best.version_no) best = version
  }
  return best
}

function applicationBlock(app: ApplicationRow): EvaluateValue['application'] {
  return {
    id: app.id,
    job_id: app.job_id,
    candidate_id: app.candidate_id,
    job_version_id: app.job_version_id,
    ...(app.rubric_version_id === null ? {} : { rubric_version_id: app.rubric_version_id }),
    lifecycle_status: app.lifecycle_status,
    current_stage_code: app.current_stage_code,
    ...(app.stage_blocked_reason === null ? {} : { stage_blocked_reason: app.stage_blocked_reason }),
    record_version: app.record_version,
  }
}

function resumeVersionBlock(rv: ResumeVersionRow, hardIssueCount: number): EvaluateValue['resume_version'] {
  const parsed = (rv.parsed_fields ?? {}) as { meta?: { pages?: number } }
  return {
    id: rv.id,
    version_no: rv.version_no,
    parse_status: rv.parse_status,
    source_asset_sha256: rv.source_asset_sha256,
    content_sha256: rv.content_sha256,
    parser_name: rv.parser_name,
    parser_version: rv.parser_version,
    page_count: typeof parsed.meta?.pages === 'number' ? parsed.meta.pages : 0,
    hard_issue_count: hardIssueCount,
  }
}

function rubricBlock(
  rubric: RubricRow,
  current: RubricRow | undefined,
  resolution: 'ARGUMENT' | 'APPLICATION_PINNED' | 'JOB_CURRENT',
  whatIf: boolean,
  pinRequired: boolean,
): EvaluateValue['rubric'] {
  return {
    version_id: rubric.id,
    version_no: rubric.version_no,
    payload_hash: rubric.payload_hash,
    is_current: current !== undefined && current.id === rubric.id,
    is_approved: true,
    resolution,
    what_if: whatIf,
    rubric_pin_required: pinRequired,
    criteria_count: rubric.dimensions.length,
  }
}

/**
 * 单行中文摘要，由**固定模板**生成（不含时钟/随机）。只供展示；
 * 判定以 `verdict` + `reasons[]` 为准（TC §3.3）。
 */
function buildSummary(verdict: string, tally: Tally, reasons: readonly ScreenReason[]): string {
  const hard = `${tally.mustHave} 条硬性条件：${tally.mustSatisfied} 满足 / ${tally.mustUnsatisfied} 反证 / ${tally.mustUncertain} 不确定`
  const disq = `${tally.disqTriggered} 条排除条件命中`
  if (verdict === 'FAIL') {
    const failed = reasons.filter((r) => r.failure_class === 'HARD_FAIL').map((r) => r.criterion_key ?? r.code)
    return `${hard}；${disq} → 建议拒绝（依据：${failed.join(', ')}）`
  }
  if (verdict === 'PASS') return `${hard}；${disq} → 建议通过（全部硬性条件满足、排除条件均未命中）`
  const uncertain = reasons
    .filter((r) => ['MISSING', 'UNREADABLE', 'INDETERMINATE', 'NEEDS_JUDGMENT'].includes(r.outcome ?? ''))
    .map((r) => `${r.criterion_key ?? r.code}:${r.outcome}`)
  return `${hard}；${disq} → 需人工复核（${uncertain.join(', ')}）`
}

/** `required_human_action`（SR §9）：PASS/FAIL 只需确认；NEEDS_REVIEW 按优先级取最大。 */
function pickHumanAction(verdict: string, reasons: readonly ScreenReason[]): string {
  if (verdict === 'PASS' || verdict === 'FAIL') return 'CONFIRM_DECISION'
  const outcomes = new Set(reasons.map((r) => r.outcome ?? ''))
  if (outcomes.has('NEEDS_JUDGMENT')) return 'ANSWER_JUDGMENT'
  if (reasons.some((r) => r.outcome === 'UNREADABLE')) return 'REVIEW_UNREADABLE'
  if (reasons.some((r) => r.outcome === 'INDETERMINATE')) return 'REVIEW_INDETERMINATE'
  if (reasons.some((r) => r.outcome === 'MISSING')) return 'REVIEW_MISSING_FIELDS'
  return 'CONFIRM_DECISION'
}

/** 收尾：补 `prior_screening`（只读回显，不比较、不评价）。 */
function finish(input: {
  readonly prior: { id: string; result: string; rubric_version_id: string | null; decided_at: Date | string } | undefined
  readonly value: EvaluateValue
}): EvaluateValue {
  if (input.prior === undefined) return input.value
  const decidedAt = input.prior.decided_at instanceof Date
    ? input.prior.decided_at.toISOString()
    : String(input.prior.decided_at)
  const prior = {
    decision_id: input.prior.id,
    result: input.prior.result,
    ...(input.prior.rubric_version_id === null || input.prior.rubric_version_id === ''
      ? {}
      : { rubric_version_id: input.prior.rubric_version_id }),
    decided_at: decidedAt,
  }
  return { ...input.value, prior_screening: prior }
}

/** 把 pg 的约束/权限错误翻译成契约错误（不把 SQLSTATE 直接抛给模型）。 */
function translateDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : 'unknown database error'
  throw contractError('READER_FAILED', {
    reason_code: 'DATABASE_FAILED',
    message: '读取业务库失败',
    detail: { error: message.slice(0, 300) },
  })
}

/**
 * 造一个绑定配置的只读评估工具。
 * @param cfg - 已解析的 database 配置。
 */
export function createScreeningEvaluateTool(cfg: ResolvedDatabaseConfig): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S7 advisory screening evaluation for ONE application (read-only, advisory=true, never writes a decision). '
      + 'Reads the pinned material + rubric, runs the 7 human-queue/material blocking checks, evaluates the '
      + 'rubric criteria with three-state fields (present/absent/unreadable), and returns PASS | FAIL | NEEDS_REVIEW '
      + 'with page/bbox/sha256 evidence. Runs inside a read-only transaction. '
      + 'Errors are BLOCKED_BY_REVIEW / NO_RUBRIC / NOT_FOUND / INVALID_ARGS with reason_code.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as EvaluateValue
        const lines = [
          `${v.tool} ${v.contract_version} status=${v.status} advisory=${String(v.advisory)} read_only=${String(v.read_only)}`,
          `labels: provenance=${v.labels.provenance} trigger=${v.labels.trigger} connection=${v.labels.connection}`,
          `application ${v.application.id} stage=${v.application.current_stage_code} `
            + `lifecycle=${v.application.lifecycle_status} rv=${v.application.record_version}`,
          `job ${v.job.title} [${v.job.status}]`,
          `resume_version v${v.resume_version.version_no} parse_status=${v.resume_version.parse_status} `
            + `hard_issues=${v.resume_version.hard_issue_count} pages=${v.resume_version.page_count}`,
          `rubric v${v.rubric.version_no} resolution=${v.rubric.resolution} what_if=${String(v.rubric.what_if)} `
            + `criteria=${v.rubric.criteria_count}`,
          `preconditions: human_queue_checked=${v.preconditions.human_queue_checked} `
            + `material_ready=${String(v.preconditions.material_ready)}`,
          `verdict: ${v.verdict} (criteria_evaluated=${String(v.criteria_evaluated)}, `
            + `required_human_action=${v.required_human_action})`,
          `summary: ${v.verdict_summary}`,
        ]
        for (const reason of v.reasons) {
          lines.push(`  [${reason.code}] ${reason.criterion_key ?? '-'}`
            + `${reason.field === undefined ? '' : ` field=${reason.field}`}`
            + `${reason.tri_state === undefined ? '' : ` tri_state=${reason.tri_state}`}`
            + ` evidence=${reason.evidence.length} — ${reason.message}`)
        }
        for (const signal of v.bonus_signals) {
          lines.push(`  bonus [${signal.code}] ${signal.criterion_key ?? '-'} — ${signal.message}`)
        }
        for (const warning of v.warnings) lines.push(`  warning ${warning.code}: ${warning.message}`)
        lines.push(`snapshot: app_rv=${v.snapshot.application_record_version} `
          + `resume_version_id=${v.snapshot.resume_version_id} `
          + `rubric_version_id=${v.snapshot.rubric_version_id}`)
        lines.push(`evaluation_digest=${v.evaluation_digest}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      const nowMs = Date.now()
      if (typeof args.as_of === 'string') {
        const checked = checkAsOf(args.as_of, nowMs)
        if (checked.ok !== true) {
          throw contractError('INVALID_ARGS', {
            reason_code: checked.reason_code,
            message: checked.message,
            detail: { as_of: args.as_of },
          })
        }
      }
      const pool = createPool(cfg)
      try {
        return await withReadOnly(pool, async (client) => {
          try {
            return await evaluateInTransaction(client, cfg, args, nowMs)
          } catch (error) {
            if (error instanceof Error && error.name === 'RecruitmentToolError') throw error
            if (isDatabaseFailure(error)) translateDbError(error)
            throw error
          }
        })
      } finally {
        await closePool(pool)
      }
    },
  }
}

/** pg 的错误都是 `Error` 且带一个数字 `code`；用这个特征区分"库失败"与"我们的契约错误"。 */
function isDatabaseFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    && /^[0-9A-Z]{5}$/.test((error as { code: string }).code)
}

/**
 * 配置不完整时用的替身：注册同名工具，调用即 `NOT_CONFIGURED`。
 * @param issues - 缺哪些配置。
 */
export function unconfiguredScreeningEvaluateTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: TOOL_NAME,
    description:
      'S7 advisory screening evaluation. Currently NOT CONFIGURED: the plugin config is missing database '
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
        message: '数据库配置不完整，S7 评估不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}
