// 宿主侧只读 HTTP 路由：Recruiting Workspace（W2）的 read model。
//
// 端点（全部挂在**独立前缀** `/recruitment/api/recruiting` 下；不与 W0 的
// `/recruitment/api` 前缀冲突——宿主 webServer 对同 (kind,path) 重复注册会抛错，
// 而路由表是「最长前缀优先」，因此本文件的注册不会覆盖也不会被覆盖）：
//
//   GET /recruitment/api/recruiting/overview            岗位/申请列表 + 设置摘要 + 计数
//   GET /recruitment/api/recruiting/applications/:id    单个申请详情（材料/证据/时间线）
//   GET /recruitment/api/recruiting/jobs/:id            单个岗位详情（版本/rubric/申请）
//
// 硬约束：
//   · 只读：所有查询跑在 `withReadOnly`（`begin transaction read only`）里，任何写会被 PG 25006 拒绝；
//   · 同一源：`sameOrigin()`（loopback + `x-recruitment-request: 1` + Origin 同源）；非回环不注册；
//   · 身份只来自插件配置（`ResolvedDatabaseConfig.tenant_id`），客户端任何 actor/tenant 覆盖参数 → 400；
//   · 复用既有表/查询：不新建事实表、不新建第二套业务事实（阶段、结论全部读库）；
//   · 不返回凭据/超范围 PII：不返回 `storage_ref`（机器路径）、不返回简历里的邮箱/电话原值、不返回 transcript 原文。
//
// 出参**类型是本文件冻结的契约**（W2 客户端 `src/client/recruiting/**` 只用 `import type` 引用它们，
// 不会把服务端代码打进浏览器产物）。实现函数体见文件后半部分。
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
// O8（产品视角复核）：批准状态只能由 `approval` 行判（`approved_by_approval_id` 恒 null）。
// 判据只在 `db/approval.ts` 里实现一份，本文件两处 SQL 复用同一片段，禁止再各写一遍。
import { effectiveApprovalExistsSql } from '../db/approval.ts'
// 候选人星标（0021）：只读投影取 application_star 最新一行；表不存在（旧库 < 0021）时为空，不当 false 假值。
import { findLatestStarsForApplications } from '../db/application-star.ts'
// W3b：轮次重点的判定**只有一份实现**（interviewer.ts 的 `buildRoundFocus`）。招聘方视角
// 只展示 `round_focus`（不展示 effective_rubric），但降级/守卫语义必须与面试官视角逐字一致，
// 否则同一场面试在两个视图里会给出不同的"本轮重点"（C-4）。
import { buildRoundFocus, type RoundFocus, type RoundRubricFacts } from './interviewer.ts'

// =====================================================================
//  冻结出参类型（recruiting-overview 1.0.0）
// =====================================================================

/** 三维标签（R4）：只读投影永远是 LIVE / MANUAL / CONNECTED。 */
export interface ThreeDimLabels {
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly trigger: 'EVENT' | 'MANUAL'
  readonly connection: 'CONNECTED' | 'NOT_CONNECTED' | 'AUTH_REQUIRED'
}

/** 写动作的封闭集：只允许通过后端 action seam 执行，客户端不得直连数据库。 */
export type RecruitingActionKey =
  | 'screening_decide'
  | 'interview_schedule'
  | 'transcript_import'
  | 'stage_advance'
  | 'decision_record'
  | 'rubric_approve'
  | 'recruiting_settings_write'

/** 一个写动作在当前部署下是否可用（不可用时客户端必须禁用按钮并显示 pending 原因）。 */
export interface RecruitingActionCapability {
  readonly available: boolean
  /** 可用的后端 seam 路径（同源相对路径）；不可用时为 null。 */
  readonly seam: string | null
  /** 不可用的原因（机器码）；可用时为 null。 */
  readonly pending: string | null
}

/** 顶部计数（全部来自库的聚合，不做前端推断）。 */
export interface RecruitingCounts {
  readonly jobs_total: number
  readonly jobs_open: number
  readonly applications_total: number
  readonly applications_active: number
  readonly applications_by_stage: Readonly<Record<string, number>>
  readonly awaiting_screening: number
  readonly interviewing: number
  readonly awaiting_decision: number
  readonly interviews_scheduled: number
  readonly scorecards_required_total: number
  readonly scorecards_submitted_total: number
  readonly transcripts_ready: number
  readonly transcripts_pending: number
}

/** 岗位卡（列表 + 详情共用）。 */
export interface JobCard {
  readonly job_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly department_name: string | null
  readonly created_at: string | null
  readonly status_changed_at: string | null
  readonly version_no: number | null
  readonly rubric: {
    readonly rubric_version_id: string
    readonly version_no: number
    readonly approved: boolean
    readonly dimension_count: number
  } | null
  readonly postings: ReadonlyArray<{
    readonly posting_id: string
    readonly channel_name: string | null
    readonly status: string
    readonly external_url: string | null
  }>
  readonly application_counts: {
    readonly total: number
    readonly active: number
    readonly by_stage: Readonly<Record<string, number>>
  }
  /** 业务结论 + 下一步（默认显示，不让用户自己推断）。 */
  readonly next_step: { readonly code: string; readonly label: string }
}

/** 简历材料与解析摘要（不返回 storage_ref、不返回邮箱/电话原值）。 */
export interface MaterialSummary {
  readonly resume_version_id: string
  readonly resume_id: string
  readonly asset_id: string
  readonly file_name: string
  readonly mime_type: string | null
  readonly byte_size: number
  readonly sha256: string
  readonly source_asset_sha256: string
  /** `intake_asset.sha256` 与 `resume_version.source_asset_sha256` 是否一致（不一致=来源可疑，UI 要显示）。 */
  readonly source_hash_aligned: boolean
  readonly validation_status: string
  readonly parse_status: string
  readonly parser_name: string
  readonly parser_version: string
  readonly page_count: number | null
  /** 字段状态表：`{name:'present', education:'present', ...}`（只给 state，不给 PII 原值）。 */
  readonly field_states: Readonly<Record<string, string>>
  readonly entry_counts: { readonly work: number; readonly education: number }
  readonly evidence_count: number
}

/** 初筛机器证据（来自 decision.basis_refs 的 SCREENING_EVALUATION 分片）。 */
export interface ScreeningEvaluationEvidence {
  readonly verdict: string | null
  readonly provenance: 'LIVE' | 'FIXTURE' | null
  readonly criteria_evaluated: boolean | null
  readonly evaluation_digest: string | null
  readonly resume_version_id: string | null
  readonly rubric_version_id: string | null
  readonly resume_content_sha256: string | null
}

/** 初筛结论（decision_scope=SCREENING 的当前有效决定）。 */
export interface ScreeningSummary {
  readonly decision_id: string
  readonly result: string
  readonly stage_code: string | null
  readonly reason: string
  readonly decided_at: string | null
  readonly decided_by_actor_id: string | null
  readonly decided_by_display_name: string | null
  readonly rubric_version_id: string | null
  readonly basis_kinds: ReadonlyArray<string>
  readonly evaluation: ScreeningEvaluationEvidence | null
}

/**
 * 自动初筛**建议**（上传简历后由只读评估工具产出，落在 business_task.result_ref）。
 *
 * 与 `ScreeningSummary`（人工决定的 decision 投影）**严格分开**：
 *   * 这里没有 `decision_id` / `result` / `decided_at` 等决定字段；
 *   * `advisory=true` + `advisory_note` 明确"这是建议，不是决定"；
 *   * `material_sha256` 是上传落盘时的原文 hash（result_ref 原文的一部分）。
 *
 * 读模型在 `loadApplicationCards` 里按 `business_refs` 里的 APPLICATION 引用定位该任务并解析。
 */
export interface AutoScreeningSummaryView {
  readonly material_sha256: string
  readonly verdict: string
  readonly verdict_summary: string
  readonly required_human_action: string
  readonly rubric_version_id: string
  readonly evaluation_digest: string
  readonly reasons: ReadonlyArray<{
    readonly code: string
    readonly criterion_key: string
    readonly tri_state: string
    readonly outcome: string
    readonly message: string
  }>
  readonly advisory: true
  readonly advisory_note: string
}

/** 已提交面评摘要（不展示其他面试官的主观明细给招聘方以外的视图；这里是招聘方视图，给结论）。 */
export interface ScorecardSummary {
  readonly scorecard_id: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly interviewer_display_name: string
  readonly status: string
  readonly overall: string | null
  readonly revision_no: number
  readonly submitted_at: string | null
}

/** Transcript 状态（只给状态/计数，不给原文——R7：不把转写正文带进投影）。 */
export interface TranscriptSummary {
  readonly state: 'READY' | 'PROCESSING' | 'NOT_READY' | 'FAILED' | 'MISSING'
  readonly artifact_id: string | null
  readonly transcript_status: string | null
  readonly provenance: 'LIVE' | 'FIXTURE' | null
  readonly trigger_mode: 'EVENT' | 'MANUAL' | null
  readonly connection_state: string | null
  readonly is_complete: boolean
  readonly is_canonical: boolean
  readonly segment_count: number
  readonly interview_record: {
    readonly interview_record_id: string
    readonly status: string
    readonly verification_status: string
    readonly evidence_ok: boolean
    readonly is_current: boolean
    readonly chunk_coverage: number | null
  } | null
}

/** 面试官分配（含其本人面评状态）。 */
export interface InterviewerAssignment {
  readonly interviewer_row_id: string
  readonly actor_id: string
  readonly display_name: string
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  readonly scorecard_due_at: string | null
  readonly scorecard: ScorecardSummary | null
}

/** 一轮面试（排期/状态/面试官/面评/转写，四个独立分支各给各的）。 */
export interface InterviewSummary {
  readonly interview_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly scheduled_start_at: string | null
  readonly scheduled_end_at: string | null
  readonly timezone: string
  /** 本场面试行的乐观锁版本（`interview.record_version`，按行不是按申请）。 */
  readonly record_version: number
  readonly interviewers: ReadonlyArray<InterviewerAssignment>
  readonly scorecards: {
    readonly required_total: number
    readonly submitted: number
    readonly missing_total: number
    readonly overdue: number
  }
  /**
   * W3b：本轮重点（与面试官视角**同名同形**，复用 `interviewer.ts::buildRoundFocus`）。
   * 无可用轮次配置时 `source='JOB_BASE', available=false` + `reason`（不猜本轮重点）。
   */
  readonly round_focus: RoundFocus
  readonly transcript: TranscriptSummary
}

/** 决策卡（含历史与是否当前有效）。 */
export interface DecisionSummary {
  readonly decision_id: string
  readonly decision_scope: string
  readonly stage_code: string | null
  readonly result: string
  readonly reason: string
  readonly decided_at: string | null
  readonly decided_by_actor_id: string | null
  readonly decided_by_display_name: string | null
  readonly is_current: boolean
  readonly superseded_by_decision_id: string | null
  readonly basis_kinds: ReadonlyArray<string>
}

/** 申请卡（列表 + 详情共用）。 */
export interface ApplicationCard {
  readonly application_id: string
  readonly candidate: { readonly candidate_id: string; readonly display_name: string }
  readonly job: { readonly job_id: string; readonly code: string; readonly title: string }
  /**
   * W2b 只读追加：申请**钉住**的 rubric 版本 id（`application.rubric_version_id`）。
   * 不是 job.current 指针；null = 该申请没有钉住 rubric（不猜一个"看起来对"的版本）。
   */
  readonly rubric_version_id: string | null
  /**
   * 申请钉住的 rubric 版本摘要（只读派生；null = 没有钉住）。
   * 与 `JobCard.rubric`（岗位**当前**指针）是两个不同事实，客户端必须分开标注（O8/O13）。
   */
  readonly rubric: {
    readonly version_no: number
    readonly approved: boolean
  } | null
  readonly lifecycle_status: string
  readonly current_stage_code: string
  readonly stage_entered_at: string | null
  readonly applied_at: string | null
  readonly stage_blocked_reason: string | null
  readonly record_version: number
  readonly material: MaterialSummary | null
  readonly screening: ScreeningSummary | null
  /**
   * 自动初筛建议（只读评估，非决定）。无对应 business_task.result_ref 时为 null。
   * 与 `screening`（人工决定）是两个不同事实：HR 不点"发起初筛评估"也应能看到这里。
   */
  readonly auto_screening: AutoScreeningSummaryView | null
  readonly interviews: ReadonlyArray<InterviewSummary>
  readonly decisions: ReadonlyArray<DecisionSummary>
  /** 候选人级约束（置顶 / 上一轮交接）；表不存在（旧库 < 0019）时为空数组，不报错。 */
  readonly constraints: ReadonlyArray<{ readonly kind: string; readonly text: string; readonly source: string; readonly from_previous_round: boolean }>
  /** 候选人星标（主推标记）：application_star 最新一行的 starred；无行 = false（只读派生，不改其它字段）。 */
  readonly starred: boolean
  readonly progress: {
    readonly scorecards_required: number
    readonly scorecards_submitted: number
    readonly transcript_state: TranscriptSummary['state']
    /** 默认显示的业务结论 + 下一步（同一事项只出现一次）。 */
    readonly next_step: {
      readonly code: string
      readonly label: string
      readonly kind: 'INFO' | 'HUMAN_ACTION' | 'WAIT'
    }
  }
}

/** 招聘设置入口数据（只读；设置页本身不在 W2 范围，入口可用性如实标注）。 */
export interface SettingsSnapshot {
  readonly stage_catalog: {
    readonly version_no: number
    readonly effective_from: string
    readonly stages: ReadonlyArray<{
      readonly code: string
      readonly label: string
      readonly kind: string
      readonly order: number
      readonly in_v1_scope: boolean
    }>
  } | null
  readonly configs: ReadonlyArray<{
    readonly config_key: string
    readonly scope: string
    readonly scope_id: string | null
    readonly version_no: number
    readonly effective_from: string
    readonly effective_to: string | null
    readonly payload_keys: ReadonlyArray<string>
  }>
  readonly departments: ReadonlyArray<{ readonly department_id: string; readonly name: string }>
  readonly hiring_teams: ReadonlyArray<{
    readonly team_id: string
    readonly code: string
    readonly name: string
    readonly department_name: string | null
    readonly members: ReadonlyArray<{
      readonly actor_id: string
      readonly display_name: string
      readonly team_role: string
      readonly actor_kind: string
    }>
  }>
  /** 设置入口：`available=false` 表示设置写路径（W1/W0）尚未接入，UI 只能显示只读数据。 */
  readonly entry: { readonly available: boolean; readonly href: string | null; readonly note: string }
}

/** `GET /recruitment/api/recruiting/overview` 的响应。 */
export interface RecruitingOverview {
  readonly contract_version: string
  readonly configured: boolean
  readonly issues: ReadonlyArray<string>
  readonly evaluated_at: string
  readonly actor: { readonly actor_id: string; readonly display_name: string; readonly roles: ReadonlyArray<string> }
  readonly labels: ThreeDimLabels
  readonly counts: RecruitingCounts
  readonly jobs: ReadonlyArray<JobCard>
  readonly applications: ReadonlyArray<ApplicationCard>
  readonly settings: SettingsSnapshot
  readonly actions: Readonly<Record<RecruitingActionKey, RecruitingActionCapability>>
}

/** 简历详情里的逐字段摘要（`value_preview` 只给非 PII 字段的可读值）。 */
export interface ResumeFieldView {
  readonly key: string
  readonly state: string
  readonly provenance: string | null
  readonly entry_count: number | null
  /** 非 PII 字段的可读预览（education/work 给首条摘要）；PII 字段（email/phone）恒为 null。 */
  readonly value_preview: string | null
}

/** 简历证据条目（引用式：页码 + 短引文；不含 PII 字段的值）。 */
export interface ResumeEvidenceSample {
  readonly field: string
  readonly page: number | null
  readonly quote: string
  readonly block: number | null
}

/** 申请详情的简历段。 */
export interface ResumeDetail {
  readonly material: MaterialSummary
  readonly fields: ReadonlyArray<ResumeFieldView>
  readonly work_entries: ReadonlyArray<{
    readonly company: string | null
    readonly title: string | null
    readonly start: string | null
    readonly end: string | null
  }>
  readonly education_entries: ReadonlyArray<{
    readonly text: string | null
    readonly start: string | null
    readonly end: string | null
  }>
  readonly evidence_samples: ReadonlyArray<ResumeEvidenceSample>
}

/** 初筛证据段（决策时的 rubric 维度快照 + basis 分片的安全投影）。 */
export interface ScreeningEvidenceDetail {
  readonly decision: ScreeningSummary | null
  readonly rubric: {
    readonly rubric_version_id: string
    readonly version_no: number
    /** W2b 只读追加：与 `rubric_version.payload_hash` 逐字一致（决策依据 RUBRIC_VERSION 需要）。 */
    readonly payload_hash: string
    readonly dimensions: ReadonlyArray<{
      readonly key: string
      readonly kind: string
      readonly label: string
      readonly weight: number | null
      readonly operator: string | null
      readonly value: unknown
      readonly question: string | null
    }>
  } | null
  readonly basis: ReadonlyArray<{ readonly kind: string; readonly detail: Readonly<Record<string, unknown>> }>
}

/** 转写处理运行（只给状态与分片计数，不给正文）。 */
export interface TranscriptRunSummary {
  readonly run_id: string
  readonly artifact_id: string
  readonly status: string
  readonly chunk_total: number
  readonly chunk_succeeded: number
  readonly chunk_failed: number
  readonly model_id: string | null
}

/** 时间线上的一条已发生事实（派生自既有表，不是新事实表）。 */
export interface TimelineEntry {
  readonly at: string
  readonly kind:
    | 'APPLIED'
    | 'INTAKE'
    | 'SCREENING_DECISION'
    | 'INTERVIEW_SCHEDULED'
    | 'TRANSCRIPT_FETCHED'
    | 'INTERVIEW_RECORD'
    | 'SCORECARD_SUBMITTED'
    | 'DECISION'
  readonly label: string
  readonly ref_id: string | null
}

/** `GET /recruitment/api/recruiting/applications/:id` 的响应。 */
export interface ApplicationDetailResponse {
  readonly contract_version: string
  readonly evaluated_at: string
  readonly actor: RecruitingOverview['actor']
  readonly labels: ThreeDimLabels
  readonly application: ApplicationCard
  readonly resume: ResumeDetail | null
  readonly screening_evidence: ScreeningEvidenceDetail
  readonly transcript_runs: ReadonlyArray<TranscriptRunSummary>
  readonly timeline: ReadonlyArray<TimelineEntry>
  readonly actions: Readonly<Record<RecruitingActionKey, RecruitingActionCapability>>
}

/** `GET /recruitment/api/recruiting/jobs/:id` 的响应。 */
export interface JobDetailResponse {
  readonly contract_version: string
  readonly evaluated_at: string
  readonly actor: RecruitingOverview['actor']
  readonly labels: ThreeDimLabels
  readonly job: JobCard
  readonly description_md: string | null
  readonly requirements_md: string | null
  readonly versions: ReadonlyArray<{
    readonly job_version_id: string
    readonly version_no: number
    readonly payload_hash: string
    readonly created_at: string | null
    readonly approved: boolean
  }>
  readonly rubric: ScreeningEvidenceDetail['rubric']
  readonly applications: ReadonlyArray<ApplicationCard>
  readonly actions: Readonly<Record<RecruitingActionKey, RecruitingActionCapability>>
}

// =====================================================================
//  HTTP 层（实现由 W2 子代理 A 完成；签名冻结）
// =====================================================================

/** 宿主侧用到的最小 `webServer` 面（与 `overview.ts` 一致，避免依赖宿主包类型）。 */
interface WebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文的窄接口。 */
export interface RecruitingHostContext {
  readonly webServer: WebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * 写动作 seam 的接线表：只由 **宿主接线点**（`src/index.ts`，W0 独占）声明，
 * 本文件不猜、不探测。缺省 = 全部不可用（按钮禁用 + pending 原因）。
 *
 * 键 = 动作；值 = 同源相对路径（例如 W1 落地后的 `/recruitment/api/action/screening/decide`）。
 */
export type RecruitingActionSeams = Partial<Readonly<Record<RecruitingActionKey, string>>>

/** 注册选项。 */
export interface RegisterRecruitingHttpOptions {
  /** 可用的后端 action seam（缺省空 = 所有写按钮禁用，禁止假写）。 */
  readonly actionSeams?: RecruitingActionSeams
}

/** 契约版本（出参首字段；客户端用它判形态）。 */
export const RECRUITING_CONTRACT_VERSION = 'recruiting-overview 1.0.0'
/** 路由前缀（**独立前缀**，最长前缀优先，不与 `/recruitment/api` 冲突）。 */
export const RECRUITING_ROUTE_PREFIX = '/recruitment/api/recruiting'

/** 未配置数据库时的 overview（形状与正常路径一致，读数全 0 / 空，并列出 issues）。 */
export function unconfiguredRecruitingOverview(issues: readonly string[]): RecruitingOverview {
  return {
    contract_version: RECRUITING_CONTRACT_VERSION,
    configured: false,
    issues: [...issues],
    evaluated_at: new Date().toISOString(),
    actor: { actor_id: '', display_name: '', roles: [] },
    labels: { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: {
      jobs_total: 0,
      jobs_open: 0,
      applications_total: 0,
      applications_active: 0,
      applications_by_stage: {},
      awaiting_screening: 0,
      interviewing: 0,
      awaiting_decision: 0,
      interviews_scheduled: 0,
      scorecards_required_total: 0,
      scorecards_submitted_total: 0,
      transcripts_ready: 0,
      transcripts_pending: 0,
    },
    jobs: [],
    applications: [],
    settings: {
      stage_catalog: null,
      configs: [],
      departments: [],
      hiring_teams: [],
      entry: { available: false, href: null, note: '数据库未配置，设置数据不可读' },
    },
    actions: actionCapabilities({}),
  }
}

/**
 * 由 seam 接线表算出每个动作的可用性（**唯一**判定点；实现与 UI 都读这里）。
 * @param seams - W0 接线声明的 seam 路径表。
 * @returns 每个动作的 available/seam/pending。
 */
export function actionCapabilities(
  seams: RecruitingActionSeams,
): Readonly<Record<RecruitingActionKey, RecruitingActionCapability>> {
  const keys: readonly RecruitingActionKey[] = [
    'screening_decide',
    'interview_schedule',
    'transcript_import',
    'stage_advance',
    'decision_record',
    'rubric_approve',
    'recruiting_settings_write',
  ]
  const out = {} as Record<RecruitingActionKey, RecruitingActionCapability>
  for (const key of keys) {
    const seam = seams[key]
    out[key] = seam === undefined || seam === ''
      ? { available: false, seam: null, pending: 'ACTION_SEAM_NOT_WIRED' }
      : { available: true, seam, pending: null }
  }
  return out
}

/** 内部：投影计算的公共上下文（`actionSeams` 只影响响应里的 `actions` 可用性，不影响任何业务读数）。 */
export interface RecruitingProjectionInput {
  readonly database: ResolvedDatabaseConfig
  readonly client: DatabaseClient
  readonly actionSeams?: RecruitingActionSeams
}

// =====================================================================
//  实现（W2-A）：只读投影
//
//  纪律（work/d5/w2/CONTRACT.md §2）：
//    · 每个投影段一条 SELECT，全部跑在调用方给的 client 上（生产路径由
//      `withReadOnly` 保证 `begin transaction read only`，任何写语句会被 PG 25006 拒绝）；
//    · 派生量只来自库事实：缺失 → `null` / `''` / `0` / `[]`，**不编造**；
//    · PII 红线：不返回 `storage_ref`、不返回邮箱/电话原值、不返回转写正文/segment 正文、
//      不返回 `raw_payload`；`field_states` 只给 state，`value_preview` 对 PII 恒 null，
//      `quote` ≤120 字符且跳过 email/phone 字段；
//    · 同一条业务事实在出参里只出现一次：`progress.next_step` 是每个申请的唯一下一步结论。
// =====================================================================

/** 岗位/申请列表上限（契约 §5；不可由入参调整）。 */
const JOB_LIST_LIMIT = 200
const APPLICATION_LIST_LIMIT = 200
/** 详情内证据样本上限（契约 §5）。 */
const EVIDENCE_SAMPLE_LIMIT = 12
/** 证据 quote 最大长度（契约 §2）。 */
const QUOTE_MAX_LENGTH = 120
/** 非 PII 字段 `value_preview` 最大长度（契约 §2）。 */
const PREVIEW_MAX_LENGTH = 80

/**
 * PII 字段名（小写、去空白后比较）。这些字段：
 *   · `field_states` 只给 state；
 *   · `ResumeFieldView.value_preview` 恒 null；
 *   · `evidence_samples` 跳过（契约 §2：`quote` 只用于简历证据定位，且跳过 email/phone）。
 */
const PII_FIELD_KEYS: ReadonlySet<string> = new Set([
  'email', 'phone', 'mobile', 'tel', 'telephone', 'contact',
  'emailaddress', 'phonenumber', 'normalizedemail', 'normalizedphone',
])

/** basis_refs 安全投影时**永不带出**的键（凭据 / 原文 / 机器路径）。 */
const DENIED_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'storage_ref', 'storage_key', 'raw_payload', 'raw_text', 'content_text',
  'raw_source_ref', 'read_receipt_ref', 'next_cursor',
])

/** 三维标签（R4）：只读投影永远是 LIVE / MANUAL / CONNECTED。 */
const RECRUITING_LABELS: ThreeDimLabels = { provenance: 'LIVE', trigger: 'MANUAL', connection: 'CONNECTED' }

/** 申请下一步的固定文案（契约 §2 的封闭 code 表 + 补充 code，见 `deriveApplicationNextStep`）。 */
const APPLICATION_NEXT_STEP_LABELS: Readonly<Record<string, string>> = {
  WAIT_MATERIAL_INTAKE: '等待材料接入：该申请还没有可读的简历材料',
  MATERIAL_PARSE_FAILED: '材料解析失败：需要人工补齐或重新上传简历',
  // O12：申请钉住的评分标准未批准时，真实下一步是先处理标准（人点了"记录初筛结论"也做不了）。
  RESOLVE_RUBRIC_STANDARD: '先处理评分标准：申请钉住的评分标准版本尚未批准，批准前无法记录初筛结论',
  PROVIDE_SCREENING_DECISION: '等待初筛决定：材料已就绪，还没有人工作出筛选结论',
  SCHEDULE_INTERVIEW: '安排面试：初筛已有结论，还没有排期面试',
  ADVANCE_STAGE: '推进阶段：初筛结论已记录，等待推进到下一阶段',
  PREPARE_INTERVIEW: '准备面试：面试已排期或即将排期，需要准备',
  WAIT_SCORECARDS: '等待面评：面试已结束，仍有必填面评未提交',
  PROVIDE_DECISION: '等待录用决策：已到 S10，还没有人工作出阶段/最终决定',
  CLOSED: '已结束：该申请不在办（lifecycle_status 非 ACTIVE）',
  IN_PROGRESS: '等待流程推进：本阶段事实已记录，等待流程或人工推进到下一阶段',
}

/** 岗位级下一步文案（岗位卡用；code 由申请聚合或岗位状态决定）。 */
const JOB_NEXT_STEP_LABELS: Readonly<Record<string, string>> = {
  WAIT_MATERIAL_INTAKE: '岗位下有申请等待材料接入',
  MATERIAL_PARSE_FAILED: '岗位下有申请材料解析失败，需要人工处理',
  RESOLVE_RUBRIC_STANDARD: '岗位下有申请的评分标准版本尚未批准，需要先处理评分标准',
  PROVIDE_SCREENING_DECISION: '岗位下有申请等待初筛决定',
  SCHEDULE_INTERVIEW: '岗位下有申请等待安排面试',
  ADVANCE_STAGE: '岗位下申请等待阶段推进',
  PREPARE_INTERVIEW: '岗位下有面试待准备或排期',
  WAIT_SCORECARDS: '岗位下有面试等待面评提交',
  PROVIDE_DECISION: '岗位下有申请等待录用决策',
  CLOSED: '岗位已结束',
  IN_PROGRESS: '岗位下申请在流程中，等待流程推进',
  JOB_DRAFT: '岗位为草稿：待完善 JD / Rubric 并提交审批',
  JOB_PAUSED: '岗位已暂停',
  WAITING_APPLICATIONS: '岗位开放中，暂无申请',
}

/** 下一步 code 的稳定优先级（只用于岗位聚合：先 HUMAN_ACTION，再 WAIT，再 INFO）。 */
const NEXT_STEP_PRIORITY: readonly string[] = [
  'MATERIAL_PARSE_FAILED', 'RESOLVE_RUBRIC_STANDARD', 'PROVIDE_SCREENING_DECISION', 'PROVIDE_DECISION',
  'SCHEDULE_INTERVIEW', 'ADVANCE_STAGE',
  'WAIT_MATERIAL_INTAKE', 'WAIT_SCORECARDS',
  'PREPARE_INTERVIEW', 'IN_PROGRESS', 'CLOSED',
]

/** kind 的紧急度排序（用于岗位聚合）。 */
const KIND_RANK: Readonly<Record<string, number>> = { HUMAN_ACTION: 0, WAIT: 1, INFO: 2 }

/** 下一步结论（申请级带 kind，岗位级只有 code+label）。 */
export interface RecruitingNextStep {
  readonly code: string
  readonly label: string
  readonly kind: 'INFO' | 'HUMAN_ACTION' | 'WAIT'
}

// ---------------------------------------------------------------------
//  纯派生函数（不碰 DB；单测直接覆盖）
// ---------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asIntOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.trunc(parsed)
  }
  return null
}

/** 把 pg 的 timestamptz（Date / ISO 文本）转 ISO 文本；无效返回 null。 */
function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 字段名是否 PII（`Email` / `phone` / ` normalized_email ` 都算）。 */
export function isPiiField(field: unknown): boolean {
  if (typeof field !== 'string') return false
  const normalized = field.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (normalized === '') return false
  if (PII_FIELD_KEYS.has(normalized)) return true
  return /\b(email|phone|mobile)\b/i.test(field)
}

/**
 * 证据引文：只接受字符串、压平空白、≤`max` 字符；空/非法 → null（不编造）。
 * @param value - 原始 quote。
 * @param max - 最大长度（默认 120）。
 * @returns 可展示的短引文，或 null。
 */
export function truncateQuote(value: unknown, max: number = QUOTE_MAX_LENGTH): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return null
  return collapsed.length > max ? collapsed.slice(0, max) : collapsed
}

/**
 * 非 PII 字段的可读预览（PII 恒 null）：字符串截断到 `max`，数字/布尔转文本，其它 null。
 * @param field - 字段名（PII 判定用）。
 * @param value - 原始值。
 * @param max - 最大长度（默认 80）。
 * @returns 预览文本，或 null。
 */
export function previewOf(field: string, value: unknown, max: number = PREVIEW_MAX_LENGTH): string | null {
  if (isPiiField(field)) return null
  if (typeof value === 'string') return truncateQuote(value, max)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

/** `parsed_fields.fields.<key>` 对象（只认对象）。 */
function parsedField(parsedFields: unknown, key: string): Record<string, unknown> | null {
  if (!isPlainObject(parsedFields) || !isPlainObject(parsedFields.fields)) return null
  const field = parsedFields.fields[key]
  return isPlainObject(field) ? field : null
}

/** `parsed_fields.fields.<key>.entries` 数组（只认数组）。 */
function parsedFieldEntries(parsedFields: unknown, key: string): unknown[] {
  const field = parsedField(parsedFields, key)
  if (field === null) return []
  return asArray(field.entries)
}

/**
 * 字段状态表 `{name:'present', ...}`：只给 state，**不给值**（PII 红线）。
 * @param parsedFields - `resume_version.parsed_fields`。
 * @returns 字段名 → state；坏形状返回 `{}`。
 */
export function deriveFieldStates(parsedFields: unknown): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  if (!isPlainObject(parsedFields) || !isPlainObject(parsedFields.fields)) return out
  for (const [key, raw] of Object.entries(parsedFields.fields)) {
    if (!isPlainObject(raw)) continue
    const state = asNonEmptyString(raw.state)
    if (state !== null) out[key] = state
  }
  return out
}

/**
 * `entry_counts`：work/education 的条目数。优先 `entry_count`，其次 entries 数组长度，缺失 0。
 * @param parsedFields - `resume_version.parsed_fields`。
 * @returns 两个计数（非负整数）。
 */
export function deriveEntryCounts(parsedFields: unknown): { readonly work: number; readonly education: number } {
  const countOf = (key: string): number => {
    const field = parsedField(parsedFields, key)
    if (field === null) return 0
    const declared = asIntOrNull(field.entry_count)
    if (declared !== null && declared >= 0) return declared
    return asArray(field.entries).length
  }
  return { work: countOf('work_experience'), education: countOf('education') }
}

/** 页数：`parsed_fields.meta.pages`（无效 → null）。 */
export function derivePageCount(parsedFields: unknown): number | null {
  if (!isPlainObject(parsedFields) || !isPlainObject(parsedFields.meta)) return null
  const pages = asIntOrNull(parsedFields.meta.pages)
  return pages !== null && pages >= 0 ? pages : null
}

/** `{year, month}` → `YYYY-MM`（月缺省只给 `YYYY`；非法 → null）。 */
function formatYearMonth(value: unknown): string | null {
  if (!isPlainObject(value)) return null
  const year = asIntOrNull(value.year)
  if (year === null) return null
  const month = asIntOrNull(value.month)
  if (month === null || month < 1 || month > 12) return String(year)
  return `${year}-${String(month).padStart(2, '0')}`
}

/** 条目第一条日期区间（`entries[0].dates[0]`）。 */
function firstDateOf(entry: Record<string, unknown>): Record<string, unknown> | null {
  const dates = asArray(entry.dates)
  const first = dates[0]
  return isPlainObject(first) ? first : null
}

/**
 * 工作经历条目（company/title/start/end）。只读已解析事实；open-ended 的 end = null。
 * @param parsedFields - `resume_version.parsed_fields`。
 * @returns 条目数组（坏形状 → `[]`）。
 */
export function deriveWorkEntries(parsedFields: unknown): ResumeDetail['work_entries'] {
  const out: Array<{ company: string | null; title: string | null; start: string | null; end: string | null }> = []
  for (const raw of parsedFieldEntries(parsedFields, 'work_experience')) {
    if (!isPlainObject(raw)) continue
    const date = firstDateOf(raw)
    out.push({
      company: asNonEmptyString(raw.company),
      title: asNonEmptyString(raw.title),
      start: date === null ? null : formatYearMonth(date.start),
      end: date === null ? null : formatYearMonth(date.end),
    })
  }
  return out
}

/**
 * 教育经历条目（text = 条目 header/text；start/end 同上）。
 * @param parsedFields - `resume_version.parsed_fields`。
 * @returns 条目数组（坏形状 → `[]`）。
 */
export function deriveEducationEntries(parsedFields: unknown): ResumeDetail['education_entries'] {
  const out: Array<{ text: string | null; start: string | null; end: string | null }> = []
  for (const raw of parsedFieldEntries(parsedFields, 'education')) {
    if (!isPlainObject(raw)) continue
    const date = firstDateOf(raw)
    out.push({
      text: asNonEmptyString(raw.header_text) ?? asNonEmptyString(raw.text),
      start: date === null ? null : formatYearMonth(date.start),
      end: date === null ? null : formatYearMonth(date.end),
    })
  }
  return out
}

/** 首条条目的可读摘要（education/work 的预览来源；非这两个字段回退到 value）。 */
function firstEntryPreview(field: Record<string, unknown>): string | null {
  const entries = asArray(field.entries)
  for (const raw of entries) {
    if (!isPlainObject(raw)) continue
    const text = asNonEmptyString(raw.header_text) ?? asNonEmptyString(raw.text)
    if (text !== null) return truncateQuote(text, PREVIEW_MAX_LENGTH)
  }
  return null
}

/**
 * 逐字段视图（`ResumeFieldView`）：只给 state/provenance/entry_count 与**非 PII** 的 value_preview。
 * @param parsedFields - `resume_version.parsed_fields`。
 * @returns 字段视图数组（无 state 的字段跳过，不猜）。
 */
export function deriveResumeFields(parsedFields: unknown): ResumeFieldView[] {
  if (!isPlainObject(parsedFields) || !isPlainObject(parsedFields.fields)) return []
  const out: ResumeFieldView[] = []
  for (const [key, raw] of Object.entries(parsedFields.fields)) {
    if (!isPlainObject(raw)) continue
    const state = asNonEmptyString(raw.state)
    if (state === null) continue
    const entries = asArray(raw.entries)
    const declared = asIntOrNull(raw.entry_count)
    const entryCount = declared !== null && declared >= 0 ? declared : (entries.length > 0 ? entries.length : null)
    const entryPreview = firstEntryPreview(raw)
    const valuePreview = isPiiField(key)
      ? null
      : entryPreview ?? previewOf(key, raw.value)
    out.push({
      key,
      state,
      provenance: asNonEmptyString(raw.provenance),
      entry_count: entryCount,
      value_preview: valuePreview,
    })
  }
  return out
}

/**
 * 简历证据样本：只保留 `<field, page, quote, block>`；跳过 PII 字段；quote ≤120 字符；
 * 最多 `limit` 条（契约 §5：≤12）。坏形状 / 缺 quote 的条目跳过（不编造）。
 * @param evidence - `resume_version.evidence`（jsonb）。
 * @param limit - 最多返回条数（默认 12）。
 * @returns 证据样本数组。
 */
export function deriveEvidenceSamples(evidence: unknown, limit: number = EVIDENCE_SAMPLE_LIMIT): ResumeEvidenceSample[] {
  const out: ResumeEvidenceSample[] = []
  for (const raw of asArray(evidence)) {
    if (out.length >= limit) break
    if (!isPlainObject(raw)) continue
    const field = asNonEmptyString(raw.field)
    if (field === null || isPiiField(field)) continue
    const quote = truncateQuote(raw.quote)
    if (quote === null) continue
    out.push({
      field,
      page: asIntOrNull(raw.page),
      quote,
      block: asIntOrNull(raw.block),
    })
  }
  return out
}

/** `intake_asset.sha256` 与 `resume_version.source_asset_sha256` 是否一致（缺一边 = false）。 */
export function deriveSourceHashAligned(assetSha256: unknown, sourceSha256: unknown): boolean {
  return typeof assetSha256 === 'string' && assetSha256 !== ''
    && typeof sourceSha256 === 'string' && sourceSha256 !== ''
    && assetSha256 === sourceSha256
}

/** basis_refs 的 kind 列表（保持库内顺序；去重）。 */
export function deriveBasisKinds(basisRefs: unknown): ReadonlyArray<string> {
  const out: string[] = []
  for (const raw of asArray(basisRefs)) {
    if (!isPlainObject(raw)) continue
    const kind = asNonEmptyString(raw.kind)
    if (kind !== null && !out.includes(kind)) out.push(kind)
  }
  return out
}

/**
 * `SCREENING_EVALUATION` 分片的安全投影（找不到 → null；provenance 只认 LIVE/FIXTURE，不谎报）。
 * @param basisRefs - `decision.basis_refs`（jsonb）。
 * @returns 初筛机器证据，或 null。
 */
export function deriveScreeningEvaluation(basisRefs: unknown): ScreeningEvaluationEvidence | null {
  for (const raw of asArray(basisRefs)) {
    if (!isPlainObject(raw) || raw.kind !== 'SCREENING_EVALUATION') continue
    const provenance = raw.provenance === 'LIVE' || raw.provenance === 'FIXTURE' ? raw.provenance : null
    return {
      verdict: asNonEmptyString(raw.verdict),
      provenance,
      criteria_evaluated: typeof raw.criteria_evaluated === 'boolean' ? raw.criteria_evaluated : null,
      evaluation_digest: asNonEmptyString(raw.evaluation_digest),
      resume_version_id: asNonEmptyString(raw.resume_version_id),
      rubric_version_id: asNonEmptyString(raw.rubric_version_id),
      resume_content_sha256: asNonEmptyString(raw.resume_content_sha256),
    }
  }
  return null
}

/**
 * 初筛用的 rubric 版本：`RUBRIC_VERSION` 分片 id → `SCREENING_EVALUATION.rubric_version_id` → 申请钉住的 rubric。
 * @param basisRefs - `decision.basis_refs`。
 * @param fallback - 申请 `rubric_version_id`（可为 null）。
 * @returns rubric 版本 id，或 null。
 */
export function deriveScreeningRubricVersionId(basisRefs: unknown, fallback: string | null): string | null {
  for (const raw of asArray(basisRefs)) {
    if (!isPlainObject(raw) || raw.kind !== 'RUBRIC_VERSION') continue
    const id = asNonEmptyString(raw.id)
    if (id !== null) return id
  }
  const evaluation = deriveScreeningEvaluation(basisRefs)
  return evaluation?.rubric_version_id ?? fallback
}

/** 转写状态映射（封闭枚举；未知字符串 → NOT_READY，**绝不**升级成 READY）。 */
export function transcriptStateOf(transcriptStatus: unknown): TranscriptSummary['state'] {
  const status = asNonEmptyString(transcriptStatus)
  if (status === null) return 'MISSING'
  switch (status) {
    case 'READY':
      return 'READY'
    case 'DISCOVERED':
    case 'FETCHING':
    case 'PARTIAL':
      return 'PROCESSING'
    case 'RETRYABLE_FAILED':
      return 'FAILED'
    case 'WAITING_EXTERNAL':
    case 'AUTH_REQUIRED':
    case 'NEEDS_LINKING':
      return 'NOT_READY'
    default:
      return 'NOT_READY'
  }
}

/** 申请级转写结论：优先「离可推进最近」的状态（READY > PROCESSING > NOT_READY > FAILED > MISSING）。 */
export function aggregateTranscriptState(states: ReadonlyArray<TranscriptSummary['state']>): TranscriptSummary['state'] {
  const rank: TranscriptSummary['state'][] = ['READY', 'PROCESSING', 'NOT_READY', 'FAILED', 'MISSING']
  let best: TranscriptSummary['state'] = 'MISSING'
  for (const state of states) {
    if (rank.indexOf(state) !== -1 && rank.indexOf(state) < rank.indexOf(best)) best = state
  }
  return best
}

/** 申请「下一步」的判定事实（全部来自库；由 `buildApplicationCard` 组装）。 */
export interface ApplicationGateFacts {
  readonly lifecycle_status: string
  readonly current_stage_code: string
  readonly has_material: boolean
  readonly parse_status: string | null
  readonly has_current_screening_decision: boolean
  /**
   * 当前有效 SCREENING 决策的 `result`（`ADVANCE` / `HOLD` / `REJECT` / `WITHDRAW`；没有决策 → `null`）。
   *
   * 2026-11-16（D-141③ 后续裁决）：旧逻辑只看"有没有 SCREENING 决策"、不看 result，会把
   * **已被拒绝**的申请显示成"安排面试"。`REJECT` = 这条申请已结束 → 下一步必须是"无（已结束）"。
   */
  readonly screening_decision_result?: string | null
  readonly has_scheduled_interview: boolean
  readonly has_post_interview_scorecard_gap: boolean
  readonly has_current_stage_decision: boolean
  /**
   * O12：申请钉住的 rubric 版本是否已批准（`true`/`false`；`null`/缺省 = 没钉住或未知）。
   * 只用来把"等待初筛决定"这种点不动的结论换成真值：未批准的标准下，初筛决定做不了。
   */
  readonly pinned_rubric_approved?: boolean | null
  /** 申请钉住的 rubric 版本号（仅用于文案与排障；判定只认 `pinned_rubric_approved`）。 */
  readonly pinned_rubric_version_no?: number | null
}

/**
 * 申请级下一步（契约 §2 的封闭 code 表 + Owner 2026-11-15 补充的 `SCHEDULE_INTERVIEW`；
 * **终态优先**，否则 `CLOSED` 分支不可达）。
 *
 * 判定顺序（越靠前越优先，保证同一申请只给出一条结论）：
 *   1. `lifecycle_status` 非 ACTIVE → `CLOSED`
 *   2. current SCREENING 决定 `result='REJECT'` → `CLOSED`（2026-11-16：初筛未通过 = 这条申请已结束；
 *      旧逻辑不看 result，会把 REJECT 的申请显示成"安排面试"）
 *   3. 无 material（`resume_version_id` 为空 / 资产行缺失）→ `WAIT_MATERIAL_INTAKE`
 *   4. `parse_status='FAILED'` → `MATERIAL_PARSE_FAILED`
 *   5. `current_stage_code='S7'` 且无 SCREENING 当前决定 → `PROVIDE_SCREENING_DECISION`
 *   6. 有 `status='SCHEDULED'` 的面试 → `PREPARE_INTERVIEW`
 *   7. 面试 `POST_INTERVIEW` 且 required 面评未齐 → `WAIT_SCORECARDS`
 *   8. `current_stage_code='S10'` 且无当前 STAGE/FINAL 决定 → `PROVIDE_DECISION`
 *   9. 已有 SCREENING 当前决定、但还没有 SCHEDULED 面试，且停在 S7/S8/S9 → `SCHEDULE_INTERVIEW`
 *      （Owner 口径：这类申请的下一步是"安排面试"，不能被"进行中"藏起来）
 *  10. 已有 SCREENING 当前决定、但还没有 SCHEDULED 面试、且**仍停在 S6** → `ADVANCE_STAGE`
 *      （Owner 2026-11-15 拍板：库事实是"初筛结论已记录但阶段指针没推进"，唯一可执行的下一步是推进阶段）
 *  11. 契约未列出的库事实（S6 材料已就绪但初筛未做 / S8 无面试）复用同语义 code：
 *      S6 → `PROVIDE_SCREENING_DECISION`；S8 → `PREPARE_INTERVIEW`
 *  12. 其余在办申请 → `IN_PROGRESS`（**最终兜底**；只用于没有任何可执行下一步的中间态）
 * @param facts - 库事实。
 * @returns 下一步结论（code/label/kind）。
 */
export function deriveApplicationNextStep(facts: ApplicationGateFacts): RecruitingNextStep {
  const nextStep = (code: string, kind: RecruitingNextStep['kind']): RecruitingNextStep => ({
    code,
    label: APPLICATION_NEXT_STEP_LABELS[code] ?? code,
    kind,
  })
  if (facts.lifecycle_status !== 'ACTIVE') return nextStep('CLOSED', 'INFO')
  // 2026-11-16（D-141③ 后续裁决）：current SCREENING 决定 = REJECT ⇒ 这条申请已结束（不再安排面试）。
  // 新数据里 lifecycle 已由决策同事务收口为 CLOSED（上面那条就命中）；这里兜住历史数据
  // （决策已 REJECT 但 lifecycle 仍是 ACTIVE 的旧行），不让工作台把它当在办。
  if (facts.has_current_screening_decision && facts.screening_decision_result === 'REJECT') {
    return nextStep('CLOSED', 'INFO')
  }
  if (!facts.has_material) return nextStep('WAIT_MATERIAL_INTAKE', 'WAIT')
  if (facts.parse_status === 'FAILED') return nextStep('MATERIAL_PARSE_FAILED', 'HUMAN_ACTION')
  // O12：申请钉住的评分标准未批准时，"等待初筛决定"是误导（人点了也做不了）。
  // 只有明确知道未批准（=== false）才切换；未知/缺省保持原判定，不猜。
  if (
    (facts.current_stage_code === 'S6' || facts.current_stage_code === 'S7')
    && !facts.has_current_screening_decision
    && facts.pinned_rubric_approved === false
  ) {
    return nextStep('RESOLVE_RUBRIC_STANDARD', 'HUMAN_ACTION')
  }
  if (facts.current_stage_code === 'S7' && !facts.has_current_screening_decision) {
    return nextStep('PROVIDE_SCREENING_DECISION', 'HUMAN_ACTION')
  }
  if (facts.has_scheduled_interview) return nextStep('PREPARE_INTERVIEW', 'INFO')
  if (facts.has_post_interview_scorecard_gap) return nextStep('WAIT_SCORECARDS', 'WAIT')
  if (facts.current_stage_code === 'S10' && !facts.has_current_stage_decision) {
    return nextStep('PROVIDE_DECISION', 'HUMAN_ACTION')
  }
  // 初筛已有结论、还没排期，且已进入面试阶段（S7/S8/S9）：下一步是安排面试。
  if (
    facts.has_current_screening_decision
    && !facts.has_scheduled_interview
    && ['S7', 'S8', 'S9'].includes(facts.current_stage_code)
  ) {
    return nextStep('SCHEDULE_INTERVIEW', 'HUMAN_ACTION')
  }
  // Owner 2026-11-15 拍板：初筛结论已记录但阶段指针还停在 S6 → 唯一能做的下一步是推进阶段。
  if (
    facts.current_stage_code === 'S6'
    && facts.has_current_screening_decision
    && !facts.has_scheduled_interview
    && !facts.has_post_interview_scorecard_gap
  ) {
    return nextStep('ADVANCE_STAGE', 'HUMAN_ACTION')
  }
  if (facts.current_stage_code === 'S6' && !facts.has_current_screening_decision) {
    return nextStep('PROVIDE_SCREENING_DECISION', 'HUMAN_ACTION')
  }
  if (facts.current_stage_code === 'S8') return nextStep('PREPARE_INTERVIEW', 'INFO')
  return nextStep('IN_PROGRESS', 'INFO')
}

/** 岗位级下一步的输入（库事实 + 该岗位下已投影的申请下一步）。 */
export interface JobNextStepFacts {
  readonly status: string
  readonly application_next_steps: ReadonlyArray<RecruitingNextStep>
}

/**
 * 岗位级下一步：岗位状态给出岗位自身待办；否则聚合该岗位下申请的下一步（最紧急的一条）。
 * @param facts - 岗位状态 + 申请下一步列表。
 * @returns `{code,label}`（岗位卡用；不含 kind）。
 */
export function deriveJobNextStep(facts: JobNextStepFacts): { readonly code: string; readonly label: string } {
  const pick = (code: string): { readonly code: string; readonly label: string } => ({
    code,
    label: JOB_NEXT_STEP_LABELS[code] ?? code,
  })
  if (facts.status === 'CLOSED' || facts.status === 'ARCHIVED') return pick('CLOSED')
  if (facts.application_next_steps.length === 0) {
    if (facts.status === 'DRAFT' || facts.status === 'PENDING_REVIEW') return pick('JOB_DRAFT')
    if (facts.status === 'PAUSED') return pick('JOB_PAUSED')
    return pick('WAITING_APPLICATIONS')
  }
  const ranked = [...facts.application_next_steps].sort((left, right) => {
    const byKind = (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9)
    if (byKind !== 0) return byKind
    const byPriority = NEXT_STEP_PRIORITY.indexOf(left.code) - NEXT_STEP_PRIORITY.indexOf(right.code)
    if (byPriority !== 0) return byPriority
    return left.code < right.code ? -1 : left.code > right.code ? 1 : 0
  })
  const top = ranked[0]
  return top === undefined ? pick('IN_PROGRESS') : pick(top.code)
}

// ---------------------------------------------------------------------
//  SQL（全部 SELECT；参数：$1 = tenant_id，其余见注释）
// ---------------------------------------------------------------------

/** 执行 actor（只来自插件配置；不存在 → 500，不猜一个 display_name）。 */
const ACTOR_SQL = `
  select a.id::text as actor_id, a.display_name as display_name
    from recruitment.actor a
   where a.id = $1::uuid and a.tenant_id = $2::uuid
`

/** actor 的角色标签（D-33：标签，不参与归属判定）。 */
const ROLES_SQL = `
  select r.code as code
    from recruitment.actor_role ar
    join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
   where ar.actor_id = $1::uuid and ar.tenant_id = $2::uuid and ar.revoked_at is null
   order by r.code asc
`

/**
 * 岗位行（列表 + 详情共用）：当前 job_version 摘要 + 当前 rubric 摘要 + 部门名。
 * $2 = job id（null = 全部）；$3 = limit。
 */
const JOB_ROWS_SQL = `
  select j.id::text                       as job_id,
         j.code                           as code,
         j.title                          as title,
         j.status                         as status,
         j.created_at                     as created_at,
         j.status_changed_at              as status_changed_at,
         d.name                           as department_name,
         jv.version_no                    as current_version_no,
         jv.payload_hash                  as current_version_payload_hash,
         jv.description_md                as description_md,
         jv.requirements_md               as requirements_md,
         rv.id::text                      as rubric_version_id,
         rv.version_no                    as rubric_version_no,
         -- 批准 = 该版本有生效的 APPROVED 审批（不是 approved_by_approval_id；见 db/approval.ts）。
         (${effectiveApprovalExistsSql({
           resourceType: 'RUBRIC_VERSION',
           resourceAlias: 'rv',
           approvalAlias: 'ap_rubric',
         })}) as rubric_approved,
         case when jsonb_typeof(rv.dimensions) = 'array' then jsonb_array_length(rv.dimensions) else 0 end
           as rubric_dimension_count
    from recruitment.job j
    left join recruitment.department d
      on d.id = j.department_id and d.tenant_id = j.tenant_id
    left join recruitment.job_version jv
      on jv.id = j.current_job_version_id and jv.tenant_id = j.tenant_id
    left join recruitment.rubric_version rv
      on rv.id = j.current_rubric_version_id and rv.tenant_id = j.tenant_id
   where j.tenant_id = $1
     and ($2::uuid is null or j.id = $2::uuid)
   order by j.created_at desc, j.id asc
   limit $3
`

/** 岗位投放（`job_posting` + `acquisition_channel`）。$2 = job id（null = 全部）。 */
const JOB_POSTINGS_SQL = `
  select jp.job_id::text as job_id,
         jp.id::text      as posting_id,
         ac.name          as channel_name,
         jp.status        as status,
         jp.external_url  as external_url
    from recruitment.job_posting jp
    left join recruitment.acquisition_channel ac
      on ac.id = jp.channel_id and ac.tenant_id = jp.tenant_id
   where jp.tenant_id = $1
     and ($2::uuid is null or jp.job_id = $2::uuid)
   order by jp.created_at asc, jp.id asc
`

/** 岗位申请聚合（每阶段一行；total/active 需要在代码里求和）。$2 = job id（null = 全部）。 */
const JOB_APPLICATION_AGG_SQL = `
  select a.job_id::text           as job_id,
         a.current_stage_code     as stage_code,
         count(*)::int            as n,
         count(*) filter (where a.lifecycle_status = 'ACTIVE')::int as active_n
    from recruitment.application a
   where a.tenant_id = $1
     and ($2::uuid is null or a.job_id = $2::uuid)
   group by a.job_id, a.current_stage_code
   order by a.job_id asc, a.current_stage_code asc
`

/**
 * 申请行（列表 + 详情共用）：申请 + 候选人 + 岗位 + 材料（含 parsed_fields/evidence，供投影派生）。
 * $2 = application id（null = 全部）；$3 = job id（null = 全部）；$4 = limit。
 */
const APPLICATION_ROWS_SQL = `
  select a.id::text                       as application_id,
         a.lifecycle_status               as lifecycle_status,
         a.current_stage_code             as current_stage_code,
         a.stage_entered_at               as stage_entered_at,
         a.applied_at                     as applied_at,
         a.stage_blocked_reason           as stage_blocked_reason,
         a.record_version                 as record_version,
         a.rubric_version_id::text        as application_rubric_version_id,
         -- 申请钉住版本的**版本号与批准真值**（O8/O13：与"岗位当前 rubric"分开两个标签）。
         arv.version_no                   as application_rubric_version_no,
         (${effectiveApprovalExistsSql({
           resourceType: 'RUBRIC_VERSION',
           resourceAlias: 'arv',
           approvalAlias: 'ap_arv',
         })}) as application_rubric_approved,
         c.id::text                       as candidate_id,
         c.display_name                   as candidate_display_name,
         j.id::text                       as job_id,
         j.code                           as job_code,
         j.title                          as job_title,
         rv.id::text                      as resume_version_id,
         rv.resume_id::text               as resume_id,
         rv.parse_status                  as parse_status,
         rv.parser_name                   as parser_name,
         rv.parser_version                as parser_version,
         rv.source_asset_sha256           as source_asset_sha256,
         rv.parsed_fields                 as parsed_fields,
         rv.evidence                      as evidence,
         rv.created_at                    as resume_version_created_at,
         ia.id::text                      as asset_id,
         ia.file_name                     as file_name,
         ia.mime_type                     as mime_type,
         ia.byte_size                     as byte_size,
         ia.sha256                        as asset_sha256,
         ia.validation_status             as validation_status
    from recruitment.application a
    join recruitment.candidate c
      on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment.job j
      on j.id = a.job_id and j.tenant_id = a.tenant_id
    -- 申请钉住的 rubric 版本（只读派生：版本号 + 批准真值；不新建事实）。
    left join recruitment.rubric_version arv
      on arv.id = a.rubric_version_id and arv.tenant_id = a.tenant_id
    left join recruitment.resume_version rv
      on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
    left join recruitment.resume r
      on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
    left join recruitment.intake_asset ia
      on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
   where a.tenant_id = $1
     and ($2::uuid is null or a.id = $2::uuid)
     and ($3::uuid is null or a.job_id = $3::uuid)
   order by a.applied_at desc, a.id asc
   limit $4
`

/**
 * 自动初筛建议（G-01 / Issue #24）：按 `business_refs` 里的 APPLICATION 引用定位上传任务，
 * 读回 `result_ref`（JSON 文本：`{ material_sha256, auto_screening }`）。
 *
 * 只读，不改任何事实；只取最近一条（按 created_at desc），避免历史重复任务造成歧义。
 * `business_refs` 是 JSONB，用 `jsonb_array_elements` 展平后按 kind+id 精确匹配。
 */
const AUTO_SCREENING_SQL = `
  select t.application_id::text as application_id,
         t.result_ref as result_ref
    from (
      select b.id::text as id,
             b.result_ref as result_ref,
             b.created_at as created_at,
             ref->>'id' as application_id
        from recruitment.business_task b
        cross join lateral jsonb_array_elements(b.business_refs) as ref
       where b.tenant_id = $1
         and b.task_type = 'RESUME_PARSE'
         and ref->>'kind' = 'APPLICATION'
         and ref->>'id' = any($2::text[])
    ) t
   where t.result_ref is not null
   order by t.application_id asc, t.created_at desc, t.id desc
 `

/** 当前有效的 SCREENING 决定（`superseded_by_decision_id is null`；带申请人钉住的 rubric 作为兜底）。 */
const SCREENING_DECISIONS_SQL = `
  select d.id::text                        as decision_id,
         d.application_id::text            as application_id,
         d.result                          as result,
         d.stage_code                      as stage_code,
         d.reason                          as reason,
         d.decided_at                      as decided_at,
         d.decided_by_actor_id::text       as decided_by_actor_id,
         actor.display_name                as decided_by_display_name,
         d.basis_refs                      as basis_refs,
         a.rubric_version_id::text         as application_rubric_version_id
    from recruitment.decision d
    join recruitment.application a
      on a.id = d.application_id and a.tenant_id = d.tenant_id
    left join recruitment.actor actor
      on actor.id = d.decided_by_actor_id and actor.tenant_id = d.tenant_id
   where d.tenant_id = $1
     and d.application_id = any($2::uuid[])
     and d.decision_scope = 'SCREENING'
     and d.superseded_by_decision_id is null
   order by d.decided_at desc, d.id asc
`

/** 全部决定（含历史；`is_current` 由 `superseded_by_decision_id is null` 派生）。 */
const DECISIONS_SQL = `
  select d.id::text                        as decision_id,
         d.application_id::text            as application_id,
         d.decision_scope                  as decision_scope,
         d.stage_code                      as stage_code,
         d.result                          as result,
         d.reason                          as reason,
         d.decided_at                      as decided_at,
         d.decided_by_actor_id::text       as decided_by_actor_id,
         actor.display_name                as decided_by_display_name,
         d.superseded_by_decision_id::text as superseded_by_decision_id,
         d.basis_refs                      as basis_refs
    from recruitment.decision d
    left join recruitment.actor actor
      on actor.id = d.decided_by_actor_id and actor.tenant_id = d.tenant_id
   where d.tenant_id = $1
     and d.application_id = any($2::uuid[])
   order by d.decided_at desc, d.id asc
`

/**
 * 面试（每申请全量；按排期时间升序）。
 *
 * W3b：除了面试本身，还取**轮次重点**需要的三组事实（别名逐字对应
 * `interviewer.ts::RoundRubricFacts`，于是可以直接复用同一个 `buildRoundFocus`）：
 *   · `interview_template_version`：模板身份/轮次/内容/声明的 rubric 版本；
 *   · `application`：申请岗位（跨岗位守卫）与钉住的 rubric 版本；
 *   · `rubric_version`：钉住的岗位 rubric（带 `rv.job_id = a.job_id` 守卫，越界即不 join，
 *     与 interviewer.ts 的 §1.5 扩展 SQL 同一条纪律 —— 不猜一个"看起来对"的版本）。
 */
const INTERVIEWS_SQL = `
  select i.id::text                       as interview_id,
         i.application_id::text           as application_id,
         i.round_no                       as round_no,
         i.slot_code                      as slot_code,
         i.stage_code                     as stage_code,
         i.status                         as status,
         i.scheduled_start_at             as scheduled_start_at,
         i.scheduled_end_at               as scheduled_end_at,
         i.timezone                       as timezone,
         i.record_version                 as record_version,
         i.created_at                     as created_at,
         a.job_id::text                   as application_job_id,
         itv.id::text                     as template_version_id,
         itv.version_no                   as template_version_no,
         itv.round_no                     as template_round_no,
         itv.job_id::text                 as template_job_id,
         itv.objective                    as template_objective,
         itv.briefing ->> 'summary'       as template_briefing_summary,
         itv.focus_attributes             as template_focus,
         itv.question_templates           as template_questions,
         itv.feedback_form                as template_feedback_form,
         itv.payload_hash                 as template_payload_hash,
         itv.rubric_version_id::text      as template_declared_rubric_version_id,
         a.rubric_version_id::text         as pinned_rubric_version_id,
         rv.id::text                      as rubric_version_id,
         rv.version_no                    as rubric_version_no,
         rv.payload_hash                  as rubric_payload_hash,
         rv.dimensions                    as rubric_dimensions
    from recruitment.interview i
    left join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
    left join recruitment.interview_template_version itv
      on itv.id = i.interview_template_version_id and itv.tenant_id = i.tenant_id
    left join recruitment.rubric_version rv
      on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id and rv.job_id = a.job_id
   where i.tenant_id = $1
     and i.application_id = any($2::uuid[])
   order by i.scheduled_start_at asc nulls last, i.id asc
`

/** 面试官分配（带 actor display_name；`role_in_interview` 只作展示）。 */
const INTERVIEWERS_SQL = `
  select ivr.id::text              as interviewer_row_id,
         ivr.interview_id::text    as interview_id,
         ivr.actor_id::text        as actor_id,
         coalesce(actor.display_name, '') as display_name,
         ivr.role_in_interview     as role_in_interview,
         ivr.required_scorecard    as required_scorecard,
         ivr.scorecard_due_at      as scorecard_due_at,
         ivr.created_at            as created_at
    from recruitment.interviewer ivr
    left join recruitment.actor actor
      on actor.id = ivr.actor_id and actor.tenant_id = ivr.tenant_id
   where ivr.tenant_id = $1
     and ivr.interview_id = any($2::uuid[])
   order by ivr.created_at asc, ivr.id asc
`

/** 当前有效面评（`superseded_by_scorecard_id is null`）。 */
const SCORECARDS_SQL = `
  select sc.id::text             as scorecard_id,
         sc.interview_id::text   as interview_id,
         sc.interviewer_id::text as interviewer_id,
         sc.status               as status,
         sc.overall              as overall,
         sc.revision_no          as revision_no,
         sc.submitted_at         as submitted_at
    from recruitment.scorecard sc
   where sc.tenant_id = $1
     and sc.interview_id = any($2::uuid[])
     and sc.superseded_by_scorecard_id is null
   order by sc.submitted_at asc nulls last, sc.id asc
`

/**
 * 转写候选（每个 interview 的两条关联路径）：
 *   · 记录路径：`interview_record.transcript_artifact_id`（契约优先；`is_current` 优先选）；
 *   · 会议路径：`meeting_binding`（`unbound_at is null`）→ `meeting` → `transcript_artifact`
 *     （没有 record 时才用）。
 * 只给状态/计数，不碰 `raw_text` / `transcript_segment.content_text`。
 */
const TRANSCRIPT_CANDIDATES_SQL = `
  with record_candidates as (
    select ir.interview_id                as interview_id,
           'RECORD'::text                 as source,
           ir.id                          as interview_record_id,
           ir.transcript_artifact_id      as artifact_id,
           ir.status                      as record_status,
           ir.verification_status         as verification_status,
           ir.evidence_ok                 as evidence_ok,
           ir.is_current                  as record_is_current,
           ir.chunk_coverage              as chunk_coverage,
           ir.created_at                  as record_created_at
      from recruitment.interview_record ir
     where ir.tenant_id = $1
       and ir.interview_id = any($2::uuid[])
  ),
  meeting_candidates as (
    select mb.interview_id                as interview_id,
           'MEETING'::text                as source,
           null::uuid                     as interview_record_id,
           ta.id                          as artifact_id,
           null::text                     as record_status,
           null::text                     as verification_status,
           null::boolean                  as evidence_ok,
           null::boolean                  as record_is_current,
           null::numeric                  as chunk_coverage,
           null::timestamptz              as record_created_at
      from recruitment.meeting_binding mb
      join recruitment.transcript_artifact ta
        on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
     where mb.tenant_id = $1
       and mb.interview_id = any($2::uuid[])
       and mb.unbound_at is null
  ),
  candidates as (
    select * from record_candidates
    union all
    select * from meeting_candidates
  )
  select c.interview_id::text            as interview_id,
         c.source                        as source,
         c.interview_record_id::text     as interview_record_id,
         c.record_status                 as record_status,
         c.verification_status           as verification_status,
         c.evidence_ok                   as evidence_ok,
         c.record_is_current             as record_is_current,
         c.chunk_coverage                as chunk_coverage,
         c.record_created_at             as record_created_at,
         ta.id::text                     as artifact_id,
         ta.transcript_status            as transcript_status,
         ta.provenance                   as provenance,
         ta.trigger_mode                 as trigger_mode,
         ta.connection_state             as connection_state,
         ta.is_complete                  as is_complete,
         ta.is_canonical                 as is_canonical,
         ta.created_at                   as artifact_created_at,
         ta.fetched_at                   as fetched_at,
         (select count(*)::int
            from recruitment.transcript_segment ts
           where ts.artifact_id = ta.id and ts.tenant_id = ta.tenant_id) as segment_count
    from candidates c
    join recruitment.transcript_artifact ta
      on ta.id = c.artifact_id and ta.tenant_id = $1
   order by c.interview_id asc, ta.is_canonical desc,
            coalesce(ta.fetched_at, ta.created_at) desc, ta.id asc
`

/** 转写处理运行（只给状态与分片计数，不给正文/分片清单）。 */
const TRANSCRIPT_RUNS_SQL = `
  select tpr.id::text            as run_id,
         tpr.artifact_id::text   as artifact_id,
         tpr.status              as status,
         tpr.chunk_total         as chunk_total,
         tpr.chunk_succeeded     as chunk_succeeded,
         tpr.chunk_failed        as chunk_failed,
         tpr.model_id            as model_id
    from recruitment.transcript_processing_run tpr
   where tpr.tenant_id = $1
     and tpr.artifact_id = any($2::uuid[])
   order by tpr.created_at asc, tpr.id asc
`

/** rubric 版本维度（初筛证据段 / 岗位详情的 rubric 快照）。$2 = rubric version id。 */
const RUBRIC_DIMENSIONS_SQL = `
  select rv.id::text       as rubric_version_id,
         rv.version_no     as version_no,
         rv.payload_hash   as payload_hash,
         rv.dimensions     as dimensions
    from recruitment.rubric_version rv
   where rv.id = $1::uuid and rv.tenant_id = $2::uuid
`

/**
 * 岗位最新一条 rubric_version（`version_no DESC`）。
 *
 * 只用于**详情读模型**的回退：新岗位可能已有 rubric_version 行，但 `job.current_rubric_version_id`
 * 还是 null（例如 job_create 只写了 job_version 指针，rubric 仍在 PENDING 审批）。此时详情必须
 * 能返回 pending 版本供“批准标准”按钮使用；批准真值仍由 approval 行判，**不得**把该版本标成已批准。
 *
 * $1 = job id，$2 = tenant id。
 */
const JOB_LATEST_RUBRIC_SQL = `
  select rv.id::text       as rubric_version_id,
         rv.version_no     as version_no,
         rv.payload_hash   as payload_hash,
         rv.dimensions     as dimensions
    from recruitment.rubric_version rv
   where rv.job_id = $1::uuid and rv.tenant_id = $2::uuid
   order by rv.version_no desc, rv.id desc
   limit 1
`

/** 岗位版本历史（详情用）。$2 = job id。 */
const JOB_VERSIONS_SQL = `
  select jv.id::text     as job_version_id,
         jv.version_no   as version_no,
         jv.payload_hash as payload_hash,
         jv.created_at    as created_at,
         -- 与 rubric 同口径：JOB_VERSION 的批准也只能由生效 APPROVED 审批判（O8）。
         (${effectiveApprovalExistsSql({
           resourceType: 'JOB_VERSION',
           resourceAlias: 'jv',
           approvalAlias: 'ap_jv',
         })}) as approved
    from recruitment.job_version jv
   where jv.tenant_id = $1 and jv.job_id = $2::uuid
   order by jv.version_no desc, jv.id asc
`

/** 时间线（详情用）：从既有表派生，不新建事实表；只给时间/种类/短标签/引用 id。$2 = application id。 */
const TIMELINE_SQL = `
  select e.at::timestamptz as at, e.kind as kind, e.label as label, e.ref_id as ref_id
    from (
      select a.applied_at as at, 'APPLIED'::text as kind,
             '申请已提交'::text as label, a.id::text as ref_id
        from recruitment.application a
       where a.tenant_id = $1 and a.id = $2::uuid
      union all
      select rv.created_at, 'INTAKE',
             '简历材料已接入并解析（' || rv.parse_status || '）', ia.id::text
        from recruitment.application a
        join recruitment.resume_version rv
          on rv.id = a.resume_version_id and rv.tenant_id = a.tenant_id
        join recruitment.resume r
          on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
        join recruitment.intake_asset ia
          on ia.id = r.intake_asset_id and ia.tenant_id = r.tenant_id
       where a.tenant_id = $1 and a.id = $2::uuid
      union all
      select d.decided_at, 'SCREENING_DECISION',
             '初筛决定：' || d.result || '（' || d.decision_scope || '）', d.id::text
        from recruitment.decision d
       where d.tenant_id = $1 and d.application_id = $2::uuid
         and d.decision_scope = 'SCREENING'
      union all
      select i.created_at, 'INTERVIEW_SCHEDULED',
             '面试已排期（第 ' || i.round_no || ' 轮）', i.id::text
        from recruitment.interview i
       where i.tenant_id = $1 and i.application_id = $2::uuid
      union all
      select coalesce(ta.fetched_at, ta.created_at), 'TRANSCRIPT_FETCHED',
             '转写已获取（' || ta.transcript_status || '）', ta.id::text
        from recruitment.interview i
        join recruitment.meeting_binding mb
          on mb.interview_id = i.id and mb.tenant_id = i.tenant_id and mb.unbound_at is null
        join recruitment.transcript_artifact ta
          on ta.meeting_id = mb.meeting_id and ta.tenant_id = mb.tenant_id
       where i.tenant_id = $1 and i.application_id = $2::uuid
      union all
      select coalesce(ta.fetched_at, ta.created_at), 'TRANSCRIPT_FETCHED',
             '转写已获取（' || ta.transcript_status || '）', ta.id::text
        from recruitment.interview_record ir
        join recruitment.transcript_artifact ta
          on ta.id = ir.transcript_artifact_id and ta.tenant_id = ir.tenant_id
       where ir.tenant_id = $1
         and ir.interview_id in (
               select i.id from recruitment.interview i
                where i.tenant_id = $1 and i.application_id = $2::uuid)
      union all
      select ir.created_at, 'INTERVIEW_RECORD',
             '面试记录已生成（' || ir.status || '）', ir.id::text
        from recruitment.interview_record ir
       where ir.tenant_id = $1
         and ir.interview_id in (
               select i.id from recruitment.interview i
                where i.tenant_id = $1 and i.application_id = $2::uuid)
      union all
      select sc.submitted_at, 'SCORECARD_SUBMITTED',
             '面评已提交（' || sc.status || '）', sc.id::text
        from recruitment.scorecard sc
       where sc.tenant_id = $1 and sc.submitted_at is not null
         and sc.interview_id in (
               select i.id from recruitment.interview i
                where i.tenant_id = $1 and i.application_id = $2::uuid)
      union all
      select d.decided_at, 'DECISION',
             '决策：' || d.decision_scope || '/' || coalesce(d.stage_code, '-') || ' → ' || d.result,
             d.id::text
        from recruitment.decision d
       where d.tenant_id = $1 and d.application_id = $2::uuid
    ) e
   order by e.at desc, e.kind asc, e.ref_id asc
`

/** 当前生效的业务配置（`effective_to is null`）。 */
const BUSINESS_CONFIG_SQL = `
  select bc.config_key              as config_key,
         bc.scope                   as scope,
         bc.scope_id::text          as scope_id,
         bc.version_no              as version_no,
         bc.payload                 as payload,
         bc.effective_from          as effective_from,
         bc.effective_to            as effective_to
    from recruitment.business_config bc
   where bc.tenant_id = $1 and bc.effective_to is null
   order by bc.config_key asc, bc.version_no desc
`

/** 部门（设置摘要）。 */
const DEPARTMENTS_SQL = `
  select d.id::text as department_id, d.name as name
    from recruitment.department d
   where d.tenant_id = $1
   order by d.name asc, d.id asc
`

/** 招聘团队（设置摘要）。 */
const HIRING_TEAMS_SQL = `
  select t.id::text as team_id, t.code as code, t.name as name, d.name as department_name
    from recruitment.hiring_team t
    left join recruitment.department d
      on d.id = t.department_id and d.tenant_id = t.tenant_id
   where t.tenant_id = $1
   order by t.code asc, t.id asc
`

/** 招聘团队成员（设置摘要）。$2 = team ids。 */
const HIRING_TEAM_MEMBERS_SQL = `
  select m.team_id::text          as team_id,
         m.actor_id::text         as actor_id,
         coalesce(a.display_name, '') as display_name,
         m.team_role              as team_role,
         m.actor_kind             as actor_kind
    from recruitment.hiring_team_member m
    left join recruitment.actor a
      on a.id = m.actor_id and a.tenant_id = m.tenant_id
   where m.tenant_id = $1
     and m.team_id = any($2::uuid[])
     and m.is_active
   order by m.created_at asc, m.id asc
`

/** 计数：岗位总数 / OPEN 数。 */
const JOBS_COUNT_SQL = `
  select count(*)::int as total,
         count(*) filter (where status = 'OPEN')::int as open_total
    from recruitment.job
   where tenant_id = $1
`

/** 计数：申请总数 / 在办数（按阶段分档另查）。 */
const APPLICATIONS_COUNT_SQL = `
  select count(*)::int as total,
         count(*) filter (where lifecycle_status = 'ACTIVE')::int as active_total
    from recruitment.application
   where tenant_id = $1
`

/** 计数：申请按当前阶段分档（全部申请）。 */
const APPLICATIONS_BY_STAGE_SQL = `
  select a.current_stage_code as stage_code, count(*)::int as n
    from recruitment.application a
   where a.tenant_id = $1
   group by a.current_stage_code
   order by a.current_stage_code asc
`

/** 计数：在办且还没有当前有效 SCREENING 决定的申请（= 「等初筛决定」的库事实）。 */
const AWAITING_SCREENING_SQL = `
  select count(*)::int as n
    from recruitment.application a
   where a.tenant_id = $1
     and a.lifecycle_status = 'ACTIVE'
     and not exists (
           select 1 from recruitment.decision d
            where d.tenant_id = a.tenant_id and d.application_id = a.id
              and d.decision_scope = 'SCREENING'
              and d.superseded_by_decision_id is null)
`

/** 计数：在办且存在未结束面试的申请（「在面试中」的库事实）。 */
const INTERVIEWING_SQL = `
  select count(distinct i.application_id)::int as n
    from recruitment.interview i
    join recruitment.application a
      on a.id = i.application_id and a.tenant_id = i.tenant_id
   where i.tenant_id = $1
     and a.lifecycle_status = 'ACTIVE'
     and i.status not in ('CANCELLED', 'DECIDED')
`

/** 计数：在办、停在 S10 且还没有当前有效 STAGE/FINAL 决定的申请。 */
const AWAITING_DECISION_SQL = `
  select count(*)::int as n
    from recruitment.application a
   where a.tenant_id = $1
     and a.lifecycle_status = 'ACTIVE'
     and a.current_stage_code = 'S10'
     and not exists (
           select 1 from recruitment.decision d
            where d.tenant_id = a.tenant_id and d.application_id = a.id
              and d.stage_code = 'S10'
              and d.decision_scope in ('STAGE', 'FINAL')
              and d.superseded_by_decision_id is null)
`

/** 计数：已排期面试数（`interview.status='SCHEDULED'`）。 */
const INTERVIEWS_SCHEDULED_SQL = `
  select count(*)::int as n
    from recruitment.interview i
   where i.tenant_id = $1 and i.status = 'SCHEDULED'
`

/** 计数：required 面评总数 / 其中已提交（当前有效 SUBMITTED）数。 */
const SCORECARD_COUNTS_SQL = `
  select count(*) filter (where ivr.required_scorecard)::int as required_total,
         count(*) filter (
           where ivr.required_scorecard
             and exists (
                   select 1 from recruitment.scorecard sc
                    where sc.tenant_id = ivr.tenant_id
                      and sc.interview_id = ivr.interview_id
                      and sc.interviewer_id = ivr.id
                      and sc.superseded_by_scorecard_id is null
                      and sc.status = 'SUBMITTED'))::int as submitted_total
    from recruitment.interviewer ivr
   where ivr.tenant_id = $1
`

/** 计数：canonical READY 转写数（可用）/ 处理中未就绪的转写数。 */
const TRANSCRIPT_COUNTS_SQL = `
  select count(*) filter (where ta.is_canonical and ta.transcript_status = 'READY')::int as ready_total,
         count(*) filter (where ta.transcript_status in ('DISCOVERED', 'FETCHING', 'PARTIAL'))::int as pending_total
    from recruitment.transcript_artifact ta
   where ta.tenant_id = $1
`

// ---------------------------------------------------------------------
//  行类型（pg 结果；timestamptz 是 Date，jsonb 是已解析对象）
// ---------------------------------------------------------------------

interface JobRow {
  job_id: string
  code: string
  title: string
  status: string
  created_at: Date | string | null
  status_changed_at: Date | string | null
  department_name: string | null
  current_version_no: number | null
  current_version_payload_hash: string | null
  description_md: string | null
  requirements_md: string | null
  rubric_version_id: string | null
  rubric_version_no: number | null
  rubric_approved: boolean | null
  rubric_dimension_count: number | null
}

interface JobPostingRow {
  job_id: string
  posting_id: string
  channel_name: string | null
  status: string
  external_url: string | null
}

interface JobApplicationAggRow {
  job_id: string
  stage_code: string
  n: number
  active_n: number
}

interface ApplicationRow {
  application_id: string
  lifecycle_status: string
  current_stage_code: string
  stage_entered_at: Date | string | null
  applied_at: Date | string | null
  stage_blocked_reason: string | null
  record_version: number
  application_rubric_version_id: string | null
  /** 申请钉住 rubric 的版本号（O13：与"岗位当前 rubric"分开标注；null = 没钉住）。 */
  application_rubric_version_no: number | null
  /** 申请钉住 rubric 此刻是否已批准（O8：approval 行真值）。 */
  application_rubric_approved: boolean
  candidate_id: string
  candidate_display_name: string
  job_id: string
  job_code: string
  job_title: string
  resume_version_id: string | null
  resume_id: string | null
  parse_status: string | null
  parser_name: string | null
  parser_version: string | null
  source_asset_sha256: string | null
  parsed_fields: unknown
  evidence: unknown
  resume_version_created_at: Date | string | null
  asset_id: string | null
  file_name: string | null
  mime_type: string | null
  byte_size: string | number | null
  asset_sha256: string | null
  validation_status: string | null
}

interface ScreeningDecisionRow {
  decision_id: string
  application_id: string
  result: string
  stage_code: string | null
  reason: string
  decided_at: Date | string | null
  decided_by_actor_id: string | null
  decided_by_display_name: string | null
  basis_refs: unknown
  application_rubric_version_id: string | null
}

interface DecisionRow {
  decision_id: string
  application_id: string
  decision_scope: string
  stage_code: string | null
  result: string
  reason: string
  decided_at: Date | string | null
  decided_by_actor_id: string | null
  decided_by_display_name: string | null
  superseded_by_decision_id: string | null
  basis_refs: unknown
}

/**
 * `INTERVIEWS_SQL` 的一行。
 *
 * W3b：继承 `RoundRubricFacts`（`round_no` 与模板/rubric 列都来自这条 SQL），这样
 * `mapInterviewSummary` 可以直接把行交给 `buildRoundFocus`，两侧判定不可能漂移。
 */
interface InterviewRow extends RoundRubricFacts {
  interview_id: string
  application_id: string
  slot_code: string
  stage_code: string
  status: string
  scheduled_start_at: Date | string | null
  scheduled_end_at: Date | string | null
  timezone: string
  record_version: number
  created_at: Date | string | null
}

interface InterviewerRow {
  interviewer_row_id: string
  interview_id: string
  actor_id: string
  display_name: string
  role_in_interview: string
  required_scorecard: boolean
  scorecard_due_at: Date | string | null
  created_at: Date | string | null
}

interface ScorecardRow {
  scorecard_id: string
  interview_id: string
  interviewer_id: string
  status: string
  overall: string | null
  revision_no: number
  submitted_at: Date | string | null
}

interface TranscriptCandidateRow {
  interview_id: string
  source: 'RECORD' | 'MEETING' | string
  interview_record_id: string | null
  record_status: string | null
  verification_status: string | null
  evidence_ok: boolean | null
  record_is_current: boolean | null
  chunk_coverage: string | number | null
  record_created_at: Date | string | null
  artifact_id: string
  transcript_status: string
  provenance: string
  trigger_mode: string
  connection_state: string
  is_complete: boolean
  is_canonical: boolean
  artifact_created_at: Date | string | null
  fetched_at: Date | string | null
  segment_count: number
}

interface TranscriptRunRow {
  run_id: string
  artifact_id: string
  status: string
  chunk_total: number
  chunk_succeeded: number
  chunk_failed: number
  model_id: string | null
}

interface RubricDimensionRow {
  rubric_version_id: string
  version_no: number
  /** W2b：决策 facts 需要与库值逐字一致的 rubric payload_hash（只读追加）。 */
  payload_hash: string
  dimensions: unknown
}

interface JobVersionRow {
  job_version_id: string
  version_no: number
  payload_hash: string
  created_at: Date | string | null
  approved: boolean
}

interface TimelineRow {
  at: Date | string | null
  kind: TimelineEntry['kind']
  label: string
  ref_id: string | null
}

interface BusinessConfigRow {
  config_key: string
  scope: string
  scope_id: string | null
  version_no: number
  payload: unknown
  effective_from: Date | string | null
  effective_to: Date | string | null
}

/** 只读上下文（一次请求内传递；不含密码）。 */
interface ReadContext {
  readonly client: DatabaseClient
  readonly tenant_id: string
  readonly evaluated_at: string
}

// ---------------------------------------------------------------------
//  映射（纯行 → 出参）
// ---------------------------------------------------------------------

function mapMaterialSummary(row: ApplicationRow): MaterialSummary | null {
  // 契约：`application.resume_version_id` 为空或资产行缺失 = 无 material。
  if (row.resume_version_id === null || row.asset_id === null || row.file_name === null) return null
  const byteSize = asIntOrNull(row.byte_size) ?? 0
  return {
    resume_version_id: row.resume_version_id,
    resume_id: row.resume_id ?? '',
    asset_id: row.asset_id,
    file_name: row.file_name,
    mime_type: row.mime_type,
    byte_size: byteSize,
    sha256: row.asset_sha256 ?? '',
    source_asset_sha256: row.source_asset_sha256 ?? '',
    source_hash_aligned: deriveSourceHashAligned(row.asset_sha256, row.source_asset_sha256),
    validation_status: row.validation_status ?? '',
    parse_status: row.parse_status ?? '',
    parser_name: row.parser_name ?? '',
    parser_version: row.parser_version ?? '',
    page_count: derivePageCount(row.parsed_fields),
    field_states: deriveFieldStates(row.parsed_fields),
    entry_counts: deriveEntryCounts(row.parsed_fields),
    evidence_count: asArray(row.evidence).length,
  }
}

function mapScreeningDecision(row: ScreeningDecisionRow): ScreeningSummary {
  const basisKinds = deriveBasisKinds(row.basis_refs)
  return {
    decision_id: row.decision_id,
    result: row.result,
    stage_code: asNonEmptyString(row.stage_code),
    reason: row.reason,
    decided_at: asIsoOrNull(row.decided_at),
    decided_by_actor_id: asNonEmptyString(row.decided_by_actor_id),
    decided_by_display_name: asNonEmptyString(row.decided_by_display_name),
    rubric_version_id: deriveScreeningRubricVersionId(row.basis_refs, row.application_rubric_version_id),
    basis_kinds: basisKinds,
    evaluation: deriveScreeningEvaluation(row.basis_refs),
  }
}

/**
 * 解析 `business_task.result_ref` 里的 JSON 文本为自动初筛建议。
 * 任何解析失败 / 缺少 `auto_screening` 分片 → 返回 null（诚实：没有就没有，不猜）。
 * `material_sha256` 缺省回退空串，但只要有 auto_screening 分片就保留其余字段。
 */
export function mapAutoScreeningResultRef(
  resultRef: unknown,
  fallbackSha256: string,
): AutoScreeningSummaryView | null {
  if (typeof resultRef !== 'string' || resultRef === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(resultRef)
  } catch {
    // 老任务 result_ref 是裸 sha256（非 JSON）——没有建议，返回 null。
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const raw = root.auto_screening
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const reasons: Array<AutoScreeningSummaryView['reasons'][number]> = []
  for (const item of Array.isArray(obj.reasons) ? obj.reasons : []) {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    reasons.push({
      code: text(r.code),
      criterion_key: text(r.criterion_key),
      tri_state: text(r.tri_state),
      outcome: text(r.outcome),
      message: text(r.message),
    })
  }
  return {
    material_sha256: text(root.material_sha256) || fallbackSha256,
    verdict: text(obj.verdict),
    verdict_summary: text(obj.verdict_summary),
    required_human_action: text(obj.required_human_action),
    rubric_version_id: text(obj.rubric_version_id),
    evaluation_digest: text(obj.evaluation_digest),
    reasons,
    advisory: true,
    advisory_note: text(obj.advisory_note)
      || '这是只读评估给出的建议，不是录用决定；请由招聘团队成员确认。',
  }
}

function mapDecisionRow(row: DecisionRow): DecisionSummary {
  return {
    decision_id: row.decision_id,
    decision_scope: row.decision_scope,
    stage_code: asNonEmptyString(row.stage_code),
    result: row.result,
    reason: row.reason,
    decided_at: asIsoOrNull(row.decided_at),
    decided_by_actor_id: asNonEmptyString(row.decided_by_actor_id),
    decided_by_display_name: asNonEmptyString(row.decided_by_display_name),
    is_current: row.superseded_by_decision_id === null,
    superseded_by_decision_id: asNonEmptyString(row.superseded_by_decision_id),
    basis_kinds: deriveBasisKinds(row.basis_refs),
  }
}

function mapScorecardRow(row: ScorecardRow): ScorecardSummary {
  return {
    scorecard_id: row.scorecard_id,
    interview_id: row.interview_id,
    interviewer_id: row.interviewer_id,
    interviewer_display_name: '',
    status: row.status,
    overall: asNonEmptyString(row.overall),
    revision_no: asIntOrNull(row.revision_no) ?? 1,
    submitted_at: asIsoOrNull(row.submitted_at),
  }
}

/** 选一条转写候选：记录路径优先（`is_current` → 最新），没有记录才用会议路径（canonical → 最新）。 */
function pickTranscriptCandidate(rows: ReadonlyArray<TranscriptCandidateRow>): TranscriptCandidateRow | null {
  const recordRows = rows.filter((row) => row.source === 'RECORD')
  if (recordRows.length > 0) {
    const sorted = [...recordRows].sort((left, right) => {
      const leftCurrent = left.record_is_current === true ? 0 : 1
      const rightCurrent = right.record_is_current === true ? 0 : 1
      if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent
      const leftAt = Date.parse(String(left.record_created_at ?? ''))
      const rightAt = Date.parse(String(right.record_created_at ?? ''))
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
      if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? -1 : 1
      return String(left.interview_record_id).localeCompare(String(right.interview_record_id))
    })
    return sorted[0] ?? null
  }
  const meetingRows = rows.filter((row) => row.source === 'MEETING')
  if (meetingRows.length > 0) {
    const sorted = [...meetingRows].sort((left, right) => {
      const byCanonical = (right.is_canonical ? 1 : 0) - (left.is_canonical ? 1 : 0)
      if (byCanonical !== 0) return byCanonical
      const leftAt = Date.parse(String(left.fetched_at ?? left.artifact_created_at ?? ''))
      const rightAt = Date.parse(String(right.fetched_at ?? right.artifact_created_at ?? ''))
      if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return rightAt - leftAt
      return left.artifact_id.localeCompare(right.artifact_id)
    })
    return sorted[0] ?? null
  }
  return null
}

function mapTranscriptSummary(rows: ReadonlyArray<TranscriptCandidateRow>): TranscriptSummary {
  const chosen = pickTranscriptCandidate(rows)
  if (chosen === null) {
    return {
      state: 'MISSING',
      artifact_id: null,
      transcript_status: null,
      provenance: null,
      trigger_mode: null,
      connection_state: null,
      is_complete: false,
      is_canonical: false,
      segment_count: 0,
      interview_record: null,
    }
  }
  const provenance = chosen.provenance === 'LIVE' || chosen.provenance === 'FIXTURE' ? chosen.provenance : null
  const trigger = chosen.trigger_mode === 'EVENT' || chosen.trigger_mode === 'MANUAL' ? chosen.trigger_mode : null
  return {
    state: transcriptStateOf(chosen.transcript_status),
    artifact_id: chosen.artifact_id,
    transcript_status: asNonEmptyString(chosen.transcript_status),
    provenance,
    trigger_mode: trigger,
    connection_state: asNonEmptyString(chosen.connection_state),
    is_complete: chosen.is_complete === true,
    is_canonical: chosen.is_canonical === true,
    segment_count: asIntOrNull(chosen.segment_count) ?? 0,
    interview_record: chosen.source === 'RECORD' && chosen.interview_record_id !== null
      ? {
          interview_record_id: chosen.interview_record_id,
          status: chosen.record_status ?? '',
          verification_status: chosen.verification_status ?? '',
          evidence_ok: chosen.evidence_ok === true,
          is_current: chosen.record_is_current === true,
          chunk_coverage: asIntOrNull(chosen.chunk_coverage),
        }
      : null,
  }
}

/** 由行构造一轮面试（含面试官/面评/转写三个独立分支）。 */
function mapInterviewSummary(
  interview: InterviewRow,
  interviewers: ReadonlyArray<InterviewerRow>,
  scorecards: ReadonlyMap<string, ScorecardRow>,
  transcriptRows: ReadonlyArray<TranscriptCandidateRow>,
  nowMs: number,
): InterviewSummary {
  const assignments: InterviewerAssignment[] = interviewers.map((row) => {
    const scorecardRow = scorecards.get(row.interviewer_row_id)
    const scorecard = scorecardRow === undefined
      ? null
      : { ...mapScorecardRow(scorecardRow), interviewer_display_name: row.display_name }
    return {
      interviewer_row_id: row.interviewer_row_id,
      actor_id: row.actor_id,
      display_name: row.display_name,
      role_in_interview: row.role_in_interview,
      required_scorecard: row.required_scorecard === true,
      scorecard_due_at: asIsoOrNull(row.scorecard_due_at),
      scorecard,
    }
  })
  const required = assignments.filter((row) => row.required_scorecard)
  const submitted = required.filter((row) => row.scorecard?.status === 'SUBMITTED')
  const overdue = required.filter((row) => {
    if (row.scorecard?.status === 'SUBMITTED') return false
    const dueIso = row.scorecard_due_at
    if (dueIso === null) return false
    const dueMs = Date.parse(dueIso)
    return Number.isFinite(dueMs) && dueMs < nowMs
  })
  return {
    interview_id: interview.interview_id,
    round_no: asIntOrNull(interview.round_no) ?? 0,
    slot_code: interview.slot_code,
    stage_code: interview.stage_code,
    status: interview.status,
    scheduled_start_at: asIsoOrNull(interview.scheduled_start_at),
    scheduled_end_at: asIsoOrNull(interview.scheduled_end_at),
    timezone: interview.timezone,
    record_version: asIntOrNull(interview.record_version) ?? 0,
    interviewers: assignments,
    scorecards: {
      required_total: required.length,
      submitted: submitted.length,
      missing_total: Math.max(0, required.length - submitted.length),
      overdue: overdue.length,
    },
    // W3b：与面试官视角**同一份判定**（跨岗位/轮次不符/模板空 → JOB_BASE + reason，不猜）。
    round_focus: buildRoundFocus(interview),
    transcript: mapTranscriptSummary(transcriptRows),
  }
}

// ---------------------------------------------------------------------
//  读库：application cards（overview / application detail / job detail 共用一条路径）
// ---------------------------------------------------------------------

interface ApplicationCardBundle {
  readonly cards: ApplicationCard[]
  readonly rows: ReadonlyMap<string, ApplicationRow>
}

/**
 * 读一批申请卡（≤`limit`）。所有派生量来自库事实；`next_step` 由 `deriveApplicationNextStep` 唯一判定。
 * @param ctx - 只读上下文。
 * @param options - 过滤（application id / job id）与 limit。
 * @returns 卡片 + 原始行（详情段复用，避免同一事实算两次）。
 */
async function loadApplicationCards(
  ctx: ReadContext,
  options: { readonly applicationId?: string; readonly jobId?: string; readonly limit: number },
): Promise<ApplicationCardBundle> {
  const { client, tenant_id: tenantId, evaluated_at: evaluatedAt } = ctx
  const limit = Math.max(1, Math.trunc(options.limit))
  const applicationRows = await client.query<ApplicationRow>(APPLICATION_ROWS_SQL, [
    tenantId,
    options.applicationId ?? null,
    options.jobId ?? null,
    limit,
  ])
  const rows = applicationRows.rows
  if (rows.length === 0) return { cards: [], rows: new Map() }
  const applicationIds = rows.map((row) => row.application_id)
  const rowsById = new Map(rows.map((row) => [row.application_id, row]))

  // 注意：一个 PoolClient = 一条连接，多条 query 必须**串行**（pg 8.23 起并发 query 会告警，
  // pg@9 会移除该行为）。这里不用 Promise.all，避免"一条连接上并发查询"。
  const screeningResult = await client.query<ScreeningDecisionRow>(SCREENING_DECISIONS_SQL, [tenantId, applicationIds])
  const decisionResult = await client.query<DecisionRow>(DECISIONS_SQL, [tenantId, applicationIds])
  const interviewResult = await client.query<InterviewRow>(INTERVIEWS_SQL, [tenantId, applicationIds])
  // 自动初筛建议：按 business_refs 的 APPLICATION 引用定位 result_ref（只读、非 decision）。
  const autoScreeningResult = await client.query<{ application_id: string; result_ref: string | null }>(
    AUTO_SCREENING_SQL, [tenantId, applicationIds],
  )
  const interviewIds = interviewResult.rows.map((row) => row.interview_id)

  const interviewerRows: InterviewerRow[] = interviewIds.length === 0
    ? []
    : (await client.query<InterviewerRow>(INTERVIEWERS_SQL, [tenantId, interviewIds])).rows
  const scorecardRows: ScorecardRow[] = interviewIds.length === 0
    ? []
    : (await client.query<ScorecardRow>(SCORECARDS_SQL, [tenantId, interviewIds])).rows
  // 候选人约束（迁移 0019）。旧库（< 0019）没有这张表：用 to_regclass 探测后跳过，不让读接口整体失败。
  const hasConstraintTable = (await client.query<{ present: string | null }>(
    "select to_regclass('recruitment.candidate_constraint')::text as present",
  )).rows[0]?.present !== null
  const constraintRows = hasConstraintTable
    ? (await client.query<{ candidate_id: string; kind: string; text: string; source: string }>(
        `select candidate_id::text as candidate_id, kind, text, source
           from recruitment.candidate_constraint
          where tenant_id = $1 and candidate_id = any($2::uuid[]) and superseded_by_constraint_id is null
          order by created_at desc`,
        [tenantId, rows.map((row) => row.candidate_id)],
      )).rows
    : []
  // 候选人星标（迁移 0021）：取每个申请最新一行 starred；表不存在（旧库 < 0021）时跳过，
  // 无行 = false（不造默认行）。与候选人约束同款 to_regclass 探测，不让读接口整体失败。
  const hasStarTable = (await client.query<{ present: string | null }>(
    "select to_regclass('recruitment.application_star')::text as present",
  )).rows[0]?.present !== null
  const starsByApplication = hasStarTable
    ? await findLatestStarsForApplications(client, tenantId, applicationIds)
    : new Map<string, boolean>()
  const transcriptRows: TranscriptCandidateRow[] = interviewIds.length === 0
    ? []
    : (await client.query<TranscriptCandidateRow>(TRANSCRIPT_CANDIDATES_SQL, [tenantId, interviewIds])).rows

  const constraintsByCandidate = new Map<string, Array<{ kind: string; text: string; source: string; from_previous_round: boolean }>>()
  for (const row of constraintRows) {
    const list = constraintsByCandidate.get(row.candidate_id) ?? []
    list.push({ kind: row.kind, text: row.text, source: row.source, from_previous_round: row.kind === 'HANDOFF' })
    constraintsByCandidate.set(row.candidate_id, list)
  }
  const screeningByApplication = new Map<string, ScreeningSummary>()
  for (const row of screeningResult.rows) {
    if (!screeningByApplication.has(row.application_id)) screeningByApplication.set(row.application_id, mapScreeningDecision(row))
  }
  const autoScreeningByApplication = new Map<string, AutoScreeningSummaryView>()
  for (const row of autoScreeningResult.rows) {
    if (autoScreeningByApplication.has(row.application_id)) continue
    const summary = mapAutoScreeningResultRef(row.result_ref, '')
    if (summary !== null) autoScreeningByApplication.set(row.application_id, summary)
  }
  const decisionsByApplication = new Map<string, DecisionSummary[]>()
  for (const row of decisionResult.rows) {
    const list = decisionsByApplication.get(row.application_id) ?? []
    list.push(mapDecisionRow(row))
    decisionsByApplication.set(row.application_id, list)
  }
  const interviewersByInterview = new Map<string, InterviewerRow[]>()
  for (const row of interviewerRows) {
    const list = interviewersByInterview.get(row.interview_id) ?? []
    list.push(row)
    interviewersByInterview.set(row.interview_id, list)
  }
  const scorecardsByInterviewer = new Map<string, ScorecardRow>()
  for (const row of scorecardRows) {
    if (!scorecardsByInterviewer.has(row.interviewer_id)) scorecardsByInterviewer.set(row.interviewer_id, row)
  }
  const transcriptByInterview = new Map<string, TranscriptCandidateRow[]>()
  for (const row of transcriptRows) {
    const list = transcriptByInterview.get(row.interview_id) ?? []
    list.push(row)
    transcriptByInterview.set(row.interview_id, list)
  }

  const nowMs = Date.parse(evaluatedAt)
  const interviewsByApplication = new Map<string, InterviewSummary[]>()
  for (const row of interviewResult.rows) {
    const summary = mapInterviewSummary(
      row,
      interviewersByInterview.get(row.interview_id) ?? [],
      scorecardsByInterviewer,
      transcriptByInterview.get(row.interview_id) ?? [],
      Number.isFinite(nowMs) ? nowMs : Date.now(),
    )
    const list = interviewsByApplication.get(row.application_id) ?? []
    list.push(summary)
    interviewsByApplication.set(row.application_id, list)
  }

  const cards: ApplicationCard[] = []
  for (const row of rows) {
    const material = mapMaterialSummary(row)
    const screening = screeningByApplication.get(row.application_id) ?? null
    const decisions = decisionsByApplication.get(row.application_id) ?? []
    const interviews = interviewsByApplication.get(row.application_id) ?? []
    const scorecardsRequired = interviews.reduce((sum, item) => sum + item.scorecards.required_total, 0)
    const scorecardsSubmitted = interviews.reduce((sum, item) => sum + item.scorecards.submitted, 0)
    const nextStep = deriveApplicationNextStep({
      lifecycle_status: row.lifecycle_status,
      current_stage_code: row.current_stage_code,
      has_material: material !== null,
      parse_status: material === null ? null : material.parse_status,
      has_current_screening_decision: screening !== null,
      screening_decision_result: screening === null ? null : screening.result,
      has_scheduled_interview: interviews.some((item) => item.status === 'SCHEDULED'),
      has_post_interview_scorecard_gap: interviews.some(
        (item) => item.status === 'POST_INTERVIEW' && item.scorecards.missing_total > 0,
      ),
      has_current_stage_decision: decisions.some(
        (item) => item.is_current && item.stage_code === 'S10'
          && (item.decision_scope === 'STAGE' || item.decision_scope === 'FINAL'),
      ),
      // O12：钉住版本的批准真值（没钉住 → null；不把"没钉住"当成"未批准"）。
      pinned_rubric_approved: row.application_rubric_version_id === null
        ? null
        : row.application_rubric_approved === true,
      pinned_rubric_version_no: row.application_rubric_version_no,
    })
    cards.push({
      application_id: row.application_id,
      candidate: {
        candidate_id: row.candidate_id,
        display_name: row.candidate_display_name,
      },
      job: {
        job_id: row.job_id,
        code: row.job_code,
        title: row.job_title,
      },
      lifecycle_status: row.lifecycle_status,
      current_stage_code: row.current_stage_code,
      rubric_version_id: row.application_rubric_version_id,
      rubric: row.application_rubric_version_id === null || row.application_rubric_version_no === null
        ? null
        : {
            version_no: row.application_rubric_version_no,
            approved: row.application_rubric_approved === true,
          },
      stage_entered_at: asIsoOrNull(row.stage_entered_at),
      applied_at: asIsoOrNull(row.applied_at),
      stage_blocked_reason: asNonEmptyString(row.stage_blocked_reason),
      record_version: asIntOrNull(row.record_version) ?? 0,
      material,
      screening,
      auto_screening: autoScreeningByApplication.get(row.application_id) ?? null,
      interviews,
      decisions,
      constraints: constraintsByCandidate.get(row.candidate_id) ?? [],
      starred: starsByApplication.get(row.application_id) ?? false,
      progress: {
        scorecards_required: scorecardsRequired,
        scorecards_submitted: scorecardsSubmitted,
        transcript_state: aggregateTranscriptState(interviews.map((item) => item.transcript.state)),
        next_step: nextStep,
      },
    })
  }
  return { cards, rows: rowsById }
}

// ---------------------------------------------------------------------
//  读库：岗位
// ---------------------------------------------------------------------

interface JobApplicationCounts {
  readonly total: number
  readonly active: number
  readonly by_stage: Readonly<Record<string, number>>
}

function mapJobCard(
  row: JobRow,
  postings: ReadonlyArray<JobPostingRow>,
  counts: JobApplicationCounts,
  nextStep: { readonly code: string; readonly label: string },
): JobCard {
  const rubric = row.rubric_version_id === null
    ? null
    : {
        rubric_version_id: row.rubric_version_id,
        version_no: asIntOrNull(row.rubric_version_no) ?? 0,
        approved: row.rubric_approved === true,
        dimension_count: asIntOrNull(row.rubric_dimension_count) ?? 0,
      }
  return {
    job_id: row.job_id,
    code: row.code,
    title: row.title,
    status: row.status,
    department_name: asNonEmptyString(row.department_name),
    created_at: asIsoOrNull(row.created_at),
    status_changed_at: asIsoOrNull(row.status_changed_at),
    version_no: asIntOrNull(row.current_version_no),
    rubric,
    postings: postings.map((posting) => ({
      posting_id: posting.posting_id,
      channel_name: asNonEmptyString(posting.channel_name),
      status: posting.status,
      external_url: asNonEmptyString(posting.external_url),
    })),
    application_counts: counts,
    next_step: nextStep,
  }
}

function emptyJobCounts(): JobApplicationCounts {
  return { total: 0, active: 0, by_stage: {} }
}

function aggregateJobCounts(rows: ReadonlyArray<JobApplicationAggRow>): Map<string, JobApplicationCounts> {
  const out = new Map<string, JobApplicationCounts>()
  for (const row of rows) {
    const current = out.get(row.job_id) ?? { total: 0, active: 0, by_stage: {} as Record<string, number> }
    const byStage: Record<string, number> = { ...current.by_stage }
    const n = asIntOrNull(row.n) ?? 0
    const active = asIntOrNull(row.active_n) ?? 0
    byStage[row.stage_code] = (byStage[row.stage_code] ?? 0) + n
    out.set(row.job_id, {
      total: current.total + n,
      active: current.active + active,
      by_stage: byStage,
    })
  }
  return out
}

function groupPostings(rows: ReadonlyArray<JobPostingRow>): Map<string, JobPostingRow[]> {
  const out = new Map<string, JobPostingRow[]>()
  for (const row of rows) {
    const list = out.get(row.job_id) ?? []
    list.push(row)
    out.set(row.job_id, list)
  }
  return out
}

/**
 * 读岗位卡（列表/详情共用）。岗位级 `next_step` 由该岗位下已投影申请的下一步聚合而来：
 * 调用方**先**投影申请卡并把 `nextStepsByJob` 传进来（否则这里会再读一遍申请，产生重复查询）。
 * @param ctx - 只读上下文。
 * @param options - job id 过滤（null = 列表）、limit、已算好的申请下一步。
 * @returns 岗位卡数组 + 原始行（详情段复用）。
 */
async function loadJobCards(
  ctx: ReadContext,
  options: {
    readonly jobId?: string
    readonly limit: number
    readonly nextStepsByJob?: ReadonlyMap<string, ReadonlyArray<RecruitingNextStep>>
  },
): Promise<{ readonly cards: JobCard[]; readonly rows: ReadonlyMap<string, JobRow> }> {
  const { client, tenant_id: tenantId } = ctx
  const jobId = options.jobId ?? null
  const jobResult = await client.query<JobRow>(JOB_ROWS_SQL, [tenantId, jobId, Math.max(1, Math.trunc(options.limit))])
  if (jobResult.rows.length === 0) return { cards: [], rows: new Map() }
  const postingResult = await client.query<JobPostingRow>(JOB_POSTINGS_SQL, [tenantId, jobId])
  const aggregateResult = await client.query<JobApplicationAggRow>(JOB_APPLICATION_AGG_SQL, [tenantId, jobId])
  const postingsByJob = groupPostings(postingResult.rows)
  const countsByJob = aggregateJobCounts(aggregateResult.rows)
  let nextStepsByJob = options.nextStepsByJob
  if (nextStepsByJob === undefined) {
    const cardBundle = await loadApplicationCards(ctx, { jobId: jobId ?? undefined, limit: APPLICATION_LIST_LIMIT })
    const derived = new Map<string, RecruitingNextStep[]>()
    for (const card of cardBundle.cards) {
      const list = derived.get(card.job.job_id) ?? []
      list.push(card.progress.next_step)
      derived.set(card.job.job_id, list)
    }
    nextStepsByJob = derived
  }
  const cards = jobResult.rows.map((row) => mapJobCard(
    row,
    postingsByJob.get(row.job_id) ?? [],
    countsByJob.get(row.job_id) ?? emptyJobCounts(),
    deriveJobNextStep({
      status: row.status,
      application_next_steps: [...(nextStepsByJob?.get(row.job_id) ?? [])],
    }),
  ))
  return { cards, rows: new Map(jobResult.rows.map((row) => [row.job_id, row])) }
}

/** 申请卡 → 按岗位聚合下一步（岗位级 `next_step` 的唯一来源）。 */
function nextStepsByJobOf(cards: ReadonlyArray<ApplicationCard>): Map<string, RecruitingNextStep[]> {
  const out = new Map<string, RecruitingNextStep[]>()
  for (const card of cards) {
    const list = out.get(card.job.job_id) ?? []
    list.push(card.progress.next_step)
    out.set(card.job.job_id, list)
  }
  return out
}

// ---------------------------------------------------------------------
//  读库：设置 / 计数 / 详情段
// ---------------------------------------------------------------------

/** jsonb dimensions → 出参维度（顺序 = rubric 顺序；只保留契约字段）。 */
function rubricDimensionSpecsFrom(dimensions: unknown): ReadonlyArray<{
  readonly key: string
  readonly kind: string
  readonly label: string
  readonly weight: number | null
  readonly operator: string | null
  readonly value: unknown
  readonly question: string | null
}> {
  const out: Array<{
    key: string
    kind: string
    label: string
    weight: number | null
    operator: string | null
    value: unknown
    question: string | null
  }> = []
  for (const raw of asArray(dimensions)) {
    if (!isPlainObject(raw)) continue
    const key = asNonEmptyString(raw.key)
    if (key === null) continue
    out.push({
      key,
      kind: asNonEmptyString(raw.kind) ?? '',
      label: asNonEmptyString(raw.label) ?? key,
      weight: typeof raw.weight === 'number' && Number.isFinite(raw.weight) ? raw.weight : null,
      operator: asNonEmptyString(raw.operator),
      value: raw.value ?? null,
      question: asNonEmptyString(raw.question),
    })
  }
  return out
}

/** basis 分片的安全投影：只保留标量；凭据/原文/机器路径键一律丢弃。 */
function safeBasisDetail(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isPlainObject(value)) return out
  for (const [key, raw] of Object.entries(value)) {
    if (DENIED_DETAIL_KEYS.has(key) || isPiiField(key)) continue
    if (raw === null || typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw
      continue
    }
    if (Array.isArray(raw) && raw.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      out[key] = [...raw]
    }
  }
  return out
}

/**
 * 设置摘要（stage_catalog + 当前配置 + 部门 + 招聘团队 + 设置入口可用性）。
 * @param ctx - 只读上下文。
 * @param actions - 已算好的动作能力（设置入口的 available/href 只从这里来）。
 * @returns SettingsSnapshot。
 */
async function loadSettings(
  ctx: ReadContext,
  actions: Readonly<Record<RecruitingActionKey, RecruitingActionCapability>>,
): Promise<SettingsSnapshot> {
  const { client, tenant_id: tenantId } = ctx
  const configResult = await client.query<BusinessConfigRow>(BUSINESS_CONFIG_SQL, [tenantId])
  const departmentResult = await client.query<{ department_id: string; name: string }>(DEPARTMENTS_SQL, [tenantId])
  const teamResult = await client.query<{ team_id: string; code: string; name: string; department_name: string | null }>(
    HIRING_TEAMS_SQL,
    [tenantId],
  )

  // 每个 config_key 取最高 version_no（同一 key 只出现一次，同一条事实只出现一次）。
  const currentConfigs: BusinessConfigRow[] = []
  const seenKeys = new Set<string>()
  for (const row of configResult.rows) {
    if (seenKeys.has(row.config_key)) continue
    seenKeys.add(row.config_key)
    currentConfigs.push(row)
  }

  let stageCatalog: SettingsSnapshot['stage_catalog'] = null
  for (const row of currentConfigs) {
    if (row.config_key !== 'stage_catalog' || !isPlainObject(row.payload)) continue
    const rawStages = asArray(row.payload.stages)
    const stages: Array<{ code: string; label: string; kind: string; order: number; in_v1_scope: boolean }> = []
    for (const raw of rawStages) {
      if (!isPlainObject(raw)) continue
      const code = asNonEmptyString(raw.code)
      if (code === null) continue
      stages.push({
        code,
        label: asNonEmptyString(raw.name) ?? code,
        kind: asNonEmptyString(raw.kind) ?? '',
        order: asIntOrNull(raw.order) ?? stages.length + 1,
        in_v1_scope: raw.in_v1_scope === true,
      })
    }
    stageCatalog = {
      version_no: asIntOrNull(row.version_no) ?? 0,
      effective_from: asIsoOrNull(row.effective_from) ?? '',
      stages,
    }
    break
  }

  const teamIds = teamResult.rows.map((row) => row.team_id)
  const memberResult = teamIds.length === 0
    ? { rows: [] as Array<{ team_id: string; actor_id: string; display_name: string; team_role: string; actor_kind: string }> }
    : await client.query<{ team_id: string; actor_id: string; display_name: string; team_role: string; actor_kind: string }>(
        HIRING_TEAM_MEMBERS_SQL,
        [tenantId, teamIds],
      )
  const membersByTeam = new Map<string, Array<{ actor_id: string; display_name: string; team_role: string; actor_kind: string }>>()
  for (const row of memberResult.rows) {
    const list = membersByTeam.get(row.team_id) ?? []
    list.push({
      actor_id: row.actor_id,
      display_name: row.display_name,
      team_role: row.team_role,
      actor_kind: row.actor_kind,
    })
    membersByTeam.set(row.team_id, list)
  }

  const settingsAction = actions.recruiting_settings_write
  return {
    stage_catalog: stageCatalog,
    configs: currentConfigs.map((row) => ({
      config_key: row.config_key,
      scope: row.scope,
      scope_id: asNonEmptyString(row.scope_id),
      version_no: asIntOrNull(row.version_no) ?? 0,
      effective_from: asIsoOrNull(row.effective_from) ?? '',
      effective_to: asIsoOrNull(row.effective_to),
      payload_keys: isPlainObject(row.payload) ? Object.keys(row.payload).sort() : [],
    })),
    departments: departmentResult.rows.map((row) => ({ department_id: row.department_id, name: row.name })),
    hiring_teams: teamResult.rows.map((row) => ({
      team_id: row.team_id,
      code: row.code,
      name: row.name,
      department_name: asNonEmptyString(row.department_name),
      members: membersByTeam.get(row.team_id) ?? [],
    })),
    entry: settingsAction.available
      ? { available: true, href: settingsAction.seam, note: '设置写入口已接线（seam 见 href）' }
      : { available: false, href: null, note: '待后端接入：ACTION_SEAM_NOT_WIRED（当前只读）' },
  }
}

/**
 * 顶部计数（全部为库内聚合；每个计数都有独立 SELECT，见各 SQL 注释）。
 * @param ctx - 只读上下文。
 * @returns 计数（无数据 → 0 / 空对象）。
 */
async function loadCounts(ctx: ReadContext): Promise<RecruitingCounts> {
  const { client, tenant_id: tenantId } = ctx
  const jobsResult = await client.query<{ total: number; open_total: number }>(JOBS_COUNT_SQL, [tenantId])
  const applicationsResult = await client.query<{ total: number; active_total: number }>(APPLICATIONS_COUNT_SQL, [tenantId])
  const byStageResult = await client.query<{ stage_code: string; n: number }>(APPLICATIONS_BY_STAGE_SQL, [tenantId])
  const awaitingScreeningResult = await client.query<{ n: number }>(AWAITING_SCREENING_SQL, [tenantId])
  const interviewingResult = await client.query<{ n: number }>(INTERVIEWING_SQL, [tenantId])
  const awaitingDecisionResult = await client.query<{ n: number }>(AWAITING_DECISION_SQL, [tenantId])
  const scheduledResult = await client.query<{ n: number }>(INTERVIEWS_SCHEDULED_SQL, [tenantId])
  const scorecardResult = await client.query<{ required_total: number; submitted_total: number }>(SCORECARD_COUNTS_SQL, [tenantId])
  const transcriptResult = await client.query<{ ready_total: number; pending_total: number }>(TRANSCRIPT_COUNTS_SQL, [tenantId])
  const byStage: Record<string, number> = {}
  for (const row of byStageResult.rows) byStage[row.stage_code] = asIntOrNull(row.n) ?? 0
  const jobs = jobsResult.rows[0]
  const applications = applicationsResult.rows[0]
  const scorecards = scorecardResult.rows[0]
  const transcripts = transcriptResult.rows[0]
  return {
    jobs_total: asIntOrNull(jobs?.total) ?? 0,
    jobs_open: asIntOrNull(jobs?.open_total) ?? 0,
    applications_total: asIntOrNull(applications?.total) ?? 0,
    applications_active: asIntOrNull(applications?.active_total) ?? 0,
    applications_by_stage: byStage,
    awaiting_screening: asIntOrNull(awaitingScreeningResult.rows[0]?.n) ?? 0,
    interviewing: asIntOrNull(interviewingResult.rows[0]?.n) ?? 0,
    awaiting_decision: asIntOrNull(awaitingDecisionResult.rows[0]?.n) ?? 0,
    interviews_scheduled: asIntOrNull(scheduledResult.rows[0]?.n) ?? 0,
    scorecards_required_total: asIntOrNull(scorecards?.required_total) ?? 0,
    scorecards_submitted_total: asIntOrNull(scorecards?.submitted_total) ?? 0,
    transcripts_ready: asIntOrNull(transcripts?.ready_total) ?? 0,
    transcripts_pending: asIntOrNull(transcripts?.pending_total) ?? 0,
  }
}

/** 读一个 rubric 版本（不存在 → null，不编造）。 */
async function loadRubric(ctx: ReadContext, rubricVersionId: string | null): Promise<ScreeningEvidenceDetail['rubric']> {
  if (rubricVersionId === null) return null
  const result = await ctx.client.query<RubricDimensionRow>(RUBRIC_DIMENSIONS_SQL, [
    rubricVersionId,
    ctx.tenant_id,
  ])
  const row = result.rows[0]
  if (row === undefined) return null
  return rubricDetailFromRow(row)
}

/**
 * 岗位最新一条 rubric_version（详情回退；不存在 → null）。
 *
 * 这里只读库，不做任何审批推断：返回的详情对象没有 `approved` 字段，调用方必须把
 * `job.rubric.approved` 保持 false（批准真值只由 approval 行决定）。
 */
async function loadLatestRubricForJob(
  ctx: ReadContext,
  jobId: string,
): Promise<ScreeningEvidenceDetail['rubric']> {
  const result = await ctx.client.query<RubricDimensionRow>(JOB_LATEST_RUBRIC_SQL, [jobId, ctx.tenant_id])
  const row = result.rows[0]
  if (row === undefined) return null
  return rubricDetailFromRow(row)
}

/** rubric 行 → 详情 rubric 段（统一映射，避免两处字段漂移）。 */
function rubricDetailFromRow(row: RubricDimensionRow): NonNullable<ScreeningEvidenceDetail['rubric']> {
  return {
    rubric_version_id: row.rubric_version_id,
    version_no: asIntOrNull(row.version_no) ?? 0,
    payload_hash: row.payload_hash,
    dimensions: rubricDimensionSpecsFrom(row.dimensions),
  }
}

/** 申请详情的简历段（只从已读行派生；无 material → null）。 */
function buildResumeDetail(row: ApplicationRow, material: MaterialSummary): ResumeDetail {
  return {
    material,
    fields: deriveResumeFields(row.parsed_fields),
    work_entries: deriveWorkEntries(row.parsed_fields),
    education_entries: deriveEducationEntries(row.parsed_fields),
    evidence_samples: deriveEvidenceSamples(row.evidence, EVIDENCE_SAMPLE_LIMIT),
  }
}

/** 转写处理运行（按申请的 interview 的 artifact 精确查；没有 artifact → []）。 */
async function loadTranscriptRuns(
  ctx: ReadContext,
  cards: ReadonlyArray<ApplicationCard>,
): Promise<TranscriptRunSummary[]> {
  const artifactIds = new Set<string>()
  for (const card of cards) {
    for (const interview of card.interviews) {
      if (interview.transcript.artifact_id !== null) artifactIds.add(interview.transcript.artifact_id)
    }
  }
  if (artifactIds.size === 0) return []
  const result = await ctx.client.query<TranscriptRunRow>(TRANSCRIPT_RUNS_SQL, [ctx.tenant_id, [...artifactIds]])
  return result.rows.map((row) => ({
    run_id: row.run_id,
    artifact_id: row.artifact_id,
    status: row.status,
    chunk_total: asIntOrNull(row.chunk_total) ?? 0,
    chunk_succeeded: asIntOrNull(row.chunk_succeeded) ?? 0,
    chunk_failed: asIntOrNull(row.chunk_failed) ?? 0,
    model_id: asNonEmptyString(row.model_id),
  }))
}

/** 时间线（同一条事实按 kind+ref_id 去重，只保留最新一条）。 */
async function loadTimeline(ctx: ReadContext, applicationId: string): Promise<TimelineEntry[]> {
  const result = await ctx.client.query<TimelineRow>(TIMELINE_SQL, [ctx.tenant_id, applicationId])
  const seen = new Set<string>()
  const out: TimelineEntry[] = []
  for (const row of result.rows) {
    const at = asIsoOrNull(row.at)
    if (at === null) continue
    const refId = asNonEmptyString(row.ref_id)
    const key = `${row.kind}:${refId ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ at, kind: row.kind, label: row.label, ref_id: refId })
  }
  return out
}

/** 初筛证据段（decision 的 rubric 快照 + basis 安全投影；无决定时给申请钉住的 rubric）。 */
async function loadScreeningEvidence(
  ctx: ReadContext,
  row: ApplicationRow,
  screening: ScreeningSummary | null,
): Promise<ScreeningEvidenceDetail> {
  const rubricVersionId = screening?.rubric_version_id ?? row.application_rubric_version_id
  const rubric = await loadRubric(ctx, rubricVersionId)
  const basis: Array<{ kind: string; detail: Record<string, unknown> }> = []
  if (screening !== null) {
    // 当前 SCREENING 决定的 basis_refs（只投影标量，丢弃凭据/原文/机器路径）。
    const decisionResult = await ctx.client.query<{ basis_refs: unknown }>(
      'select d.basis_refs as basis_refs from recruitment.decision d where d.id = $1::uuid and d.tenant_id = $2::uuid',
      [screening.decision_id, ctx.tenant_id],
    )
    for (const raw of asArray(decisionResult.rows[0]?.basis_refs)) {
      if (!isPlainObject(raw)) continue
      const kind = asNonEmptyString(raw.kind) ?? ''
      basis.push({ kind, detail: safeBasisDetail(raw) })
    }
  }
  return { decision: screening, rubric, basis }
}

/** 读 actor + 角色（配置 apply 到真实行；不存在 → 抛错）。 */
async function readActor(
  client: DatabaseClient,
  tenantId: string,
  actorId: string,
): Promise<RecruitingOverview['actor']> {
  const actorResult = await client.query<{ actor_id: string; display_name: string }>(ACTOR_SQL, [actorId, tenantId])
  const actor = actorResult.rows[0]
  if (actor === undefined) {
    throw new Error(`配置的 actor ${actorId} 不在租户 ${tenantId} 下（actor 只来自插件配置）`)
  }
  const roleResult = await client.query<{ code: string }>(ROLES_SQL, [actorId, tenantId])
  return {
    actor_id: actor.actor_id,
    display_name: actor.display_name,
    roles: roleResult.rows.map((row) => row.code),
  }
}

/** 本次读库时间（evaluated_at）。 */
async function readNowIso(client: DatabaseClient): Promise<string> {
  const result = await client.query<{ now_ts: Date | string }>('select now() as now_ts')
  return asIsoOrNull(result.rows[0]?.now_ts) ?? new Date().toISOString()
}

/** UUID 形态判断（详情 id 非法 = 不存在，走 NOT_FOUND；路由层另有 400 校验）。 */
function isUuidText(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

// ---------------------------------------------------------------------
//  三个只读入口（签名冻结；实现见上）
// ---------------------------------------------------------------------

/** 读取 overview 投影（岗位/申请列表 + 计数 + 设置摘要 + 动作可用性）。 */
export async function readRecruitingOverview(
  input: RecruitingProjectionInput,
): Promise<RecruitingOverview> {
  const ctx: ReadContext = {
    client: input.client,
    tenant_id: input.database.tenant_id,
    evaluated_at: await readNowIso(input.client),
  }
  const actor = await readActor(input.client, ctx.tenant_id, input.database.actor_id)
  const actions = actionCapabilities(input.actionSeams ?? {})
  // 一条连接上的 query 必须串行：申请卡 → 计数 → 设置 → 岗位（岗位级 next_step 依赖申请卡）。
  const cardBundle = await loadApplicationCards(ctx, { limit: APPLICATION_LIST_LIMIT })
  const counts = await loadCounts(ctx)
  const settings = await loadSettings(ctx, actions)
  const jobBundle = await loadJobCards(ctx, {
    limit: JOB_LIST_LIMIT,
    nextStepsByJob: nextStepsByJobOf(cardBundle.cards),
  })
  return {
    contract_version: RECRUITING_CONTRACT_VERSION,
    configured: true,
    issues: [],
    evaluated_at: ctx.evaluated_at,
    actor,
    labels: RECRUITING_LABELS,
    counts,
    jobs: jobBundle.cards,
    applications: cardBundle.cards,
    settings,
    actions,
  }
}

/** 读取单个申请详情（申请卡 + 简历段 + 初筛证据 + 转写运行 + 时间线）。 */
export async function readApplicationDetail(
  input: RecruitingProjectionInput,
  applicationId: string,
): Promise<ApplicationDetailResponse> {
  const ctx: ReadContext = {
    client: input.client,
    tenant_id: input.database.tenant_id,
    evaluated_at: await readNowIso(input.client),
  }
  if (!isUuidText(applicationId)) {
    throw new Error(`NOT_FOUND: application ${applicationId} 不存在`)
  }
  const actor = await readActor(input.client, ctx.tenant_id, input.database.actor_id)
  const actions = actionCapabilities(input.actionSeams ?? {})
  const bundle = await loadApplicationCards(ctx, { applicationId, limit: 1 })
  const card = bundle.cards[0]
  // 用卡片回填的 id 取原始行（请求可能给大写 UUID；SQL 已归一，但 Map 的键是库内小写形态）。
  const row = card === undefined ? undefined : bundle.rows.get(card.application_id)
  if (card === undefined || row === undefined) {
    throw new Error(`NOT_FOUND: application ${applicationId} 不存在`)
  }
  const screeningEvidence = await loadScreeningEvidence(ctx, row, card.screening)
  const transcriptRuns = await loadTranscriptRuns(ctx, [card])
  const timeline = await loadTimeline(ctx, applicationId)
  return {
    contract_version: RECRUITING_CONTRACT_VERSION,
    evaluated_at: ctx.evaluated_at,
    actor,
    labels: RECRUITING_LABELS,
    application: card,
    resume: card.material === null ? null : buildResumeDetail(row, card.material),
    screening_evidence: screeningEvidence,
    transcript_runs: transcriptRuns,
    timeline,
    actions,
  }
}

/** 读取单个岗位详情（岗位卡 + JD + 版本 + rubric + 该岗位申请卡）。 */
export async function readJobDetail(
  input: RecruitingProjectionInput,
  jobId: string,
): Promise<JobDetailResponse> {
  const ctx: ReadContext = {
    client: input.client,
    tenant_id: input.database.tenant_id,
    evaluated_at: await readNowIso(input.client),
  }
  if (!isUuidText(jobId)) {
    throw new Error(`NOT_FOUND: job ${jobId} 不存在`)
  }
  const actor = await readActor(input.client, ctx.tenant_id, input.database.actor_id)
  const actions = actionCapabilities(input.actionSeams ?? {})
  // 申请卡只读一遍：既作为详情返回，也用于聚合岗位级 next_step。
  const applicationBundle = await loadApplicationCards(ctx, { jobId, limit: APPLICATION_LIST_LIMIT })
  const versionResult = await input.client.query<JobVersionRow>(JOB_VERSIONS_SQL, [ctx.tenant_id, jobId])
  const jobBundle = await loadJobCards(ctx, {
    jobId,
    limit: 1,
    nextStepsByJob: nextStepsByJobOf(applicationBundle.cards),
  })
  const jobCard = jobBundle.cards[0]
  // 用卡片回填的 id 取原始行（请求可能给大写 UUID；Map 的键是库内小写形态）。
  const jobRow = jobCard === undefined ? undefined : jobBundle.rows.get(jobCard.job_id)
  if (jobCard === undefined) {
    throw new Error(`NOT_FOUND: job ${jobId} 不存在`)
  }
  // 当前 job_version 的 JD 正文（只在详情返回；列表卡不带）。
  // 新岗位可能还没有 current rubric 指针：此时回退到该 job 最新一条 rubric_version（pending）。
  // 回退只补 version id/version_no/criteria，`job.rubric.approved` 必须保持 false；
  // 是否真的批准仍由 approval 行判定，不能因为“有版本”就标成已批准。
  const currentRubricVersionId = jobRow?.rubric_version_id ?? null
  const pendingRubric = currentRubricVersionId === null
    ? await loadLatestRubricForJob(ctx, jobId)
    : null
  const rubric = pendingRubric ?? await loadRubric(ctx, currentRubricVersionId)
  const job = pendingRubric !== null && jobCard.rubric === null
    ? {
        ...jobCard,
        rubric: {
          rubric_version_id: pendingRubric.rubric_version_id,
          version_no: pendingRubric.version_no,
          approved: false,
          dimension_count: pendingRubric.dimensions.length,
        },
      }
    : jobCard
  return {
    contract_version: RECRUITING_CONTRACT_VERSION,
    evaluated_at: ctx.evaluated_at,
    actor,
    labels: RECRUITING_LABELS,
    job,
    description_md: asNonEmptyString(jobRow?.description_md),
    requirements_md: asNonEmptyString(jobRow?.requirements_md),
    versions: versionResult.rows.map((row) => ({
      job_version_id: row.job_version_id,
      version_no: asIntOrNull(row.version_no) ?? 0,
      payload_hash: row.payload_hash,
      created_at: asIsoOrNull(row.created_at),
      approved: row.approved === true,
    })),
    rubric,
    applications: applicationBundle.cards,
    actions,
  }
}

/**
 * 注册 Recruiting Workspace 只读路由；返回 disposer。
 *
 * 非回环监听时**不注册**（fail closed）。数据库未配置时 overview 返回
 * `unconfiguredRecruitingOverview(issues)`、详情返回 503。
 * @param ctx - 宿主上下文（含 webServer）。
 * @param database - 已解析数据库配置；null = 未配置。
 * @param issues - 未配置时缺失的配置项。
 * @param options - 写动作 seam 接线（缺省全部禁用）。
 * @returns 注销函数。
 */
export function registerRecruitingHttp(
  ctx: RecruitingHostContext,
  database: ResolvedDatabaseConfig | null,
  issues: readonly string[],
  options: RegisterRecruitingHttpOptions = {},
): () => void {
  const { webServer } = ctx
  if (webServer.host !== '127.0.0.1' && webServer.host !== '::1') {
    ctx.logger?.warn(`recruitment: Recruiting Workspace 路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const seams = options.actionSeams ?? {}
  const port = webServer.port ?? 0

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(JSON.stringify(value))
    }
    // 同源校验：与 overview.ts 同一口径（Host 命中本机端口 + x-recruitment-request:1 + Origin 同源）。
    const host = req.headers.host
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      json(403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    if (req.headers['x-recruitment-request'] !== '1') {
      json(403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${host}`) {
      json(403, { error: { code: 'FORBIDDEN', message: 'same-origin loopback request required' } })
      return
    }
    for (const key of ['actor_id', 'tenant_id'] as const) {
      if (url.searchParams.has(key)) {
        json(400, {
          error: {
            code: 'INVALID_ARGS',
            reason_code: 'ACTOR_OVERRIDE_REJECTED',
            message: 'actor/tenant 只来自插件配置，不接受客户端传入（D-33 / IR-M4d）',
          },
        })
        return
      }
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' })
      res.end()
      return
    }
    try {
      if (path === `${RECRUITING_ROUTE_PREFIX}/overview`) {
        if (database === null) {
          json(200, unconfiguredRecruitingOverview(issues))
          return
        }
        const pool = createPool(database)
        try {
          json(200, await withReadOnly(pool, (client) => readRecruitingOverview({ database, client, actionSeams: seams })))
        } finally {
          await closePool(pool)
        }
        return
      }
      const applicationPrefix = `${RECRUITING_ROUTE_PREFIX}/applications/`
      const jobPrefix = `${RECRUITING_ROUTE_PREFIX}/jobs/`
      const isApplication = path.startsWith(applicationPrefix)
      const isJob = path.startsWith(jobPrefix)
      if (isApplication || isJob) {
        const id = decodeURIComponent(path.slice((isApplication ? applicationPrefix : jobPrefix).length))
        if (id === '' || id.includes('/')) {
          json(400, { error: { code: 'INVALID_ARGS', reason_code: 'ID_MISSING', message: 'id 缺省或非法' } })
          return
        }
        if (database === null) {
          json(503, { error: { code: 'NOT_CONFIGURED', reason_code: 'NOT_CONFIGURED', message: '数据库未配置' } })
          return
        }
        const pool = createPool(database)
        try {
          if (isApplication) {
            json(200, await withReadOnly(pool, (client) => readApplicationDetail({ database, client, actionSeams: seams }, id)))
          } else {
            json(200, await withReadOnly(pool, (client) => readJobDetail({ database, client, actionSeams: seams }, id)))
          }
        } finally {
          await closePool(pool)
        }
        return
      }
      json(404, { error: { code: 'NOT_FOUND', message: 'not found' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('NOT_FOUND:')) {
        json(404, { error: { code: 'NOT_FOUND', message } })
        return
      }
      json(500, { error: { code: 'INTERNAL', message } })
    }
  }

  return webServer.register({ kind: 'prefix', path: RECRUITING_ROUTE_PREFIX, handler })
}

