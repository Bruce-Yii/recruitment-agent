// 招聘工作区（W2）**视图模型层**：把只读 HTTP 投影归一化成"可渲染、无脏值"的形状。
//
// 硬约束（`work/d5/w2/CONTRACT.md` §3 / `work/d5/CLIENT-CONTRACT.md`）：
//   1. 纯函数：**不 import react、不碰 DOM**，可被 `node --test` 直接覆盖；
//   2. 坏类型一律降级（'' / 0 / [] / null），视图里永不出现 NaN / undefined / [object Object]；
//   3. **同一事项只出现一次**：申请的下一步只从 `progress.next_step` 出（`ApplicationRowView.nextStep` /
//      `ApplicationDetailView.nextStep` 各一份，详情页不渲染行内结论）；岗位的下一步只从 `job.next_step` 出。
//      详情页因此**不重复**提供 `nextStep` 的第二份副本（`application` 头部类型里根本没有该字段）；
//   4. 写动作归一化成 `{key,label,available,seam,pending,reasonText}`：`available=false` 必须带 pending 文案，
//      客户端据此只渲染禁用按钮，绝不伪造可用。
//
// 这里**不判断业务真相**（阶段、结论、下一步全部来自服务端投影）；本文件只做"安全形状 + 展示口径"。

import {
  bool,
  count,
  formatBytes,
  formatDateTime,
  initial,
  items,
  joinTexts,
  numberOrNull,
  oneOf,
  preview,
  record,
  shortSha,
  stringList,
  text,
  type ChipTone,
} from './format.ts'

// =====================================================================
//  常量：封闭枚举的中文展示口径（不创造新业务值）
// =====================================================================

/** 写动作的封闭集（与 `src/http/recruiting.ts` 的 `RecruitingActionKey` 一一对应）。 */
export const ACTION_KEYS = [
  'screening_decide',
  'interview_schedule',
  'transcript_import',
  'stage_advance',
  'decision_record',
  'rubric_approve',
  'recruiting_settings_write',
] as const

/** 动作按钮文案（键不存在时退化成动作键本身，不丢信息）。 */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  screening_decide: '记录初筛结论',
  interview_schedule: '安排面试',
  transcript_import: '导入 / 关联 Transcript',
  stage_advance: '推进阶段',
  decision_record: '记录招聘决策',
  rubric_approve: '批准 Rubric',
  recruiting_settings_write: '保存招聘设置',
}

/** 后端 pending 机器码 → 给人看的原因（未知码原样显示，不吞掉）。 */
const PENDING_REASON_TEXT: Readonly<Record<string, string>> = {
  ACTION_SEAM_NOT_WIRED: '后端 action seam 尚未接线（宿主接线点未提供）',
  ACTION_SEAM_MISSING: '服务端声明可用但没有给出 seam 路径（fail-closed）',
  NOT_IMPLEMENTED: '后端写路径尚未实现',
}

/** 阶段码 → 默认中文名（`stage_catalog` 缺失时的展示兜底；权威标签仍以服务端 catalog 为准）。 */
const DEFAULT_STAGE_LABELS: Readonly<Record<string, string>> = {
  S1: '招聘需求发现',
  S2: '招聘需求创建与审批',
  S3: '岗位 / JD / Rubric 设计',
  S4: '岗位发布',
  S5: '人才获取',
  S6: '简历接入与处理',
  S7: '初筛',
  S8: '面试规划与排期',
  S9: '面试执行与材料获取',
  S10: '综合评价与招聘决策',
  S11: 'Offer 与入职交接',
  S12: '人才沉淀与复盘',
}

/** 阶段顺序（排序用；未知阶段排最后）。 */
const STAGE_ORDER: Readonly<Record<string, number>> = {
  S1: 1,
  S2: 2,
  S3: 3,
  S4: 4,
  S5: 5,
  S6: 6,
  S7: 7,
  S8: 8,
  S9: 9,
  S10: 10,
  S11: 11,
  S12: 12,
}

/** 阶段色档（只表"当前阶段"这一事实，不代表结论）。 */
const STAGE_TONES: Readonly<Record<string, ChipTone>> = {
  S6: 'blue',
  S7: 'amber',
  S8: 'blue',
  S9: 'blue',
  S10: 'amber',
  S11: 'gray',
  S12: 'gray',
}

/** `application.lifecycle_status` 枚举（0001_init.sql:880）→ 中文 + 色档。 */
const LIFECYCLE_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: '进行中',
  ON_HOLD: '已暂缓',
  WITHDRAWN: '候选人撤回',
  CLOSED: '已关闭',
}
const LIFECYCLE_TONES: Readonly<Record<string, ChipTone>> = {
  ACTIVE: 'green',
  ON_HOLD: 'amber',
  WITHDRAWN: 'gray',
  CLOSED: 'gray',
}

/** `job.status` 枚举（0001_init.sql:529）→ 中文 + 色档。 */
const JOB_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: '草案',
  PENDING_REVIEW: '待审批',
  APPROVED: '已批准',
  OPEN: '招聘中',
  PAUSED: '已暂停',
  CLOSED: '已关闭',
  ARCHIVED: '已归档',
}
const JOB_STATUS_TONES: Readonly<Record<string, ChipTone>> = {
  DRAFT: 'gray',
  PENDING_REVIEW: 'amber',
  APPROVED: 'blue',
  OPEN: 'green',
  PAUSED: 'amber',
  CLOSED: 'gray',
  ARCHIVED: 'gray',
}

/**
 * 岗位展示排序权重（纯客户端口径，不改服务端）：
 * `OPEN`(0) > `DRAFT`/`PENDING_REVIEW`(1) > `PAUSED`(2) > 未知(8) > `CLOSED`/`ARCHIVED`(9)。
 * 未知状态放在 `PAUSED` 之后、终态之前，避免一个脏 status 被顶到第一位。
 */
const JOB_STATUS_SORT_RANK: Readonly<Record<string, number>> = {
  OPEN: 0,
  DRAFT: 1,
  PENDING_REVIEW: 1,
  PAUSED: 2,
  CLOSED: 9,
  ARCHIVED: 9,
}

/** 一个岗位状态的排序权重（未知状态 → 8）。 */
export function jobSortRank(status: string): number {
  return JOB_STATUS_SORT_RANK[status] ?? 8
}

/** `created_at` 的时间戳（非法/缺失 → 0，老岗位排后面）。 */
function createdAtValue(job: JobView): number {
  const parsed = Date.parse(job.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 岗位展示排序（**纯函数**）：
 * 1. 状态优先级（OPEN 优先，归档/关闭最后）；
 * 2. 同优先级按 `application_counts.total` 降序（演示主岗位排前面）；
 * 3. 再按 `created_at` 降序（新的在前；缺失/非法时间排最后）。
 * 排序稳定：三者都相等时保持服务端原顺序。
 */
export function sortJobViews(jobs: ReadonlyArray<JobView>): JobView[] {
  return [...jobs].sort((left, right) => {
    const rank = jobSortRank(left.status) - jobSortRank(right.status)
    if (rank !== 0) return rank
    const total = right.applicationCounts.total - left.applicationCounts.total
    if (total !== 0) return total
    return createdAtValue(right) - createdAtValue(left)
  })
}

/**
 * 右侧岗位侧栏分组：`active` = OPEN + DRAFT（"正在招聘"里不堆归档岗位）；
 * `archived` = 其余（PAUSED / CLOSED / ARCHIVED / 未知状态），由组件放进折叠区。
 */
export function splitSidebarJobs(jobs: ReadonlyArray<JobView>): {
  readonly active: JobView[]
  readonly archived: JobView[]
} {
  const active: JobView[] = []
  const archived: JobView[] = []
  for (const job of jobs) {
    if (job.status === 'OPEN' || job.status === 'DRAFT') active.push(job)
    else archived.push(job)
  }
  return { active, archived }
}

/** `resume_version.parse_status` 枚举（0001_init.sql:826）→ 中文 + 色档。 */
const PARSE_LABELS: Readonly<Record<string, string>> = {
  PENDING: '等待解析',
  PARSING: '解析中',
  PARSED: '解析完成',
  PARTIAL: '部分解析',
  FAILED: '解析失败',
  NEEDS_REVIEW: '待人工复核',
}
const PARSE_TONES: Readonly<Record<string, ChipTone>> = {
  PENDING: 'gray',
  PARSING: 'blue',
  PARSED: 'green',
  PARTIAL: 'amber',
  FAILED: 'red',
  NEEDS_REVIEW: 'amber',
}

/** `intake_asset.validation_status` 枚举（0001_init.sql:716）→ 中文 + 色档。 */
const VALIDATION_LABELS: Readonly<Record<string, string>> = {
  PENDING: '待校验',
  VALID: '校验通过',
  INVALID: '校验失败',
}
const VALIDATION_TONES: Readonly<Record<string, ChipTone>> = {
  PENDING: 'amber',
  VALID: 'green',
  INVALID: 'red',
}

/** `decision.result` 枚举（0001_init.sql:1354）→ 中文 + 色档。 */
const DECISION_RESULT_LABELS: Readonly<Record<string, string>> = {
  ADVANCE: '通过',
  HOLD: '暂缓',
  REJECT: '不通过',
  WITHDRAW: '撤回',
  HIRED: '录用',
}
const DECISION_RESULT_TONES: Readonly<Record<string, ChipTone>> = {
  ADVANCE: 'green',
  HOLD: 'amber',
  REJECT: 'red',
  WITHDRAW: 'gray',
  HIRED: 'green',
}

/** `decision.decision_scope` 枚举（0001_init.sql:1353）→ 中文。 */
const DECISION_SCOPE_LABELS: Readonly<Record<string, string>> = {
  SCREENING: '初筛',
  STAGE: '阶段',
  FINAL: '最终',
}

/** `interview.status` 枚举（0001_init.sql:959）→ 中文 + 色档（**只表排期，不推断转写/面评**）。 */
const INTERVIEW_STATUS_LABELS: Readonly<Record<string, string>> = {
  SCHEDULED: '已排期',
  IN_PROGRESS: '进行中',
  POST_INTERVIEW: '面试后',
  EVALUATION_READY: '评价就绪',
  DECIDED: '已决策',
  RESCHEDULED: '已改期',
  CANCELLED: '已取消',
  NO_SHOW: '未出席',
}
const INTERVIEW_STATUS_TONES: Readonly<Record<string, ChipTone>> = {
  SCHEDULED: 'blue',
  IN_PROGRESS: 'blue',
  POST_INTERVIEW: 'amber',
  EVALUATION_READY: 'green',
  DECIDED: 'green',
  RESCHEDULED: 'amber',
  CANCELLED: 'gray',
  NO_SHOW: 'red',
}

/** `scorecard.status` 枚举（0001_init.sql:1310）→ 中文 + 色档。 */
const SCORECARD_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: '待提交',
  SUBMITTED: '已提交',
  WAIVED: '已豁免',
}
const SCORECARD_STATUS_TONES: Readonly<Record<string, ChipTone>> = {
  PENDING: 'amber',
  SUBMITTED: 'green',
  WAIVED: 'gray',
}

/** `scorecard.overall` 枚举（面评契约）→ 中文 + 色档。 */
const OVERALL_LABELS: Readonly<Record<string, string>> = {
  ADVANCE: '建议推进',
  HOLD: '暂缓',
  REJECT: '不建议推进',
}
const OVERALL_TONES: Readonly<Record<string, ChipTone>> = {
  ADVANCE: 'green',
  HOLD: 'amber',
  REJECT: 'red',
}

/** `transcript_artifact.transcript_status` 枚举（0001_init.sql:1092）→ 中文 + 色档。 */
const TRANSCRIPT_STATUS_LABELS: Readonly<Record<string, string>> = {
  DISCOVERED: '已发现',
  FETCHING: '获取中',
  PARTIAL: '部分获取',
  READY: '已就绪',
  WAITING_EXTERNAL: '等待外部',
  RETRYABLE_FAILED: '可重试失败',
  AUTH_REQUIRED: '需要授权',
  NEEDS_LINKING: '待关联',
}
const TRANSCRIPT_STATUS_TONES: Readonly<Record<string, ChipTone>> = {
  DISCOVERED: 'gray',
  FETCHING: 'blue',
  PARTIAL: 'amber',
  READY: 'green',
  WAITING_EXTERNAL: 'amber',
  RETRYABLE_FAILED: 'red',
  AUTH_REQUIRED: 'red',
  NEEDS_LINKING: 'amber',
}

/** `TranscriptSummary.state` → 中文 + 色档（客户端消费的稳定枚举）。 */
const TRANSCRIPT_STATE_LABELS: Readonly<Record<string, string>> = {
  READY: '已就绪',
  PROCESSING: '处理中',
  NOT_READY: '未就绪',
  FAILED: '失败',
  MISSING: '缺失',
}
const TRANSCRIPT_STATE_TONES: Readonly<Record<string, ChipTone>> = {
  READY: 'green',
  PROCESSING: 'blue',
  NOT_READY: 'amber',
  FAILED: 'red',
  MISSING: 'gray',
}

/** 时间线 `kind` → 中文。 */
const TIMELINE_KIND_LABELS: Readonly<Record<string, string>> = {
  APPLIED: '提交申请',
  INTAKE: '简历接入',
  SCREENING_DECISION: '初筛结论',
  INTERVIEW_SCHEDULED: '面试排期',
  TRANSCRIPT_FETCHED: 'Transcript 获取',
  INTERVIEW_RECORD: '面试记录',
  SCORECARD_SUBMITTED: '面评提交',
  DECISION: '招聘决策',
}

/** 面试记录的 `status` / `verification_status` 只给原文（没有客户端枚举口径时不翻译）。 */

// =====================================================================
//  类型：视图模型
// =====================================================================

/** 一个写动作的展示形状（`available=false` 时 `pendingText` 必有值）。 */
export interface ActionView {
  /** 动作键（稳定，DOM 上用于 `data-testid="action-<key>"`）。 */
  readonly key: string
  /** 按钮文案。 */
  readonly label: string
  /** 是否可用（**唯一**判定点：服务端 `actions[key].available`，且 seam 非空）。 */
  readonly available: boolean
  /** 可用的后端 seam 路径；不可用时为 ''。 */
  readonly seam: string
  /** 不可用的机器码；可用时为 ''。 */
  readonly pending: string
  /** 给人看的 pending 文案：「待后端接入（pending: <code>）」。 */
  readonly pendingText: string
  /** pending 原因的人话解释（未知码原样保留）。 */
  readonly reasonText: string
}

/** 业务结论 + 下一步（同一视图里只出现一次的"主结论"）。 */
export interface NextStepView {
  /** 机器码（如 `PROVIDE_SCREENING_DECISION`）；缺失为 ''。 */
  readonly code: string
  /** 服务端给的文案；缺失为 ''。 */
  readonly label: string
  /** `INFO` / `HUMAN_ACTION` / `WAIT`；未知为 ''。 */
  readonly kind: string
  /** 人话 kind（进展 / 需要人工处理 / 等待中；未知为 ''）。 */
  readonly kindLabel: string
  /** chip 色档。 */
  readonly tone: ChipTone
  /** 是否有下一步信息（否则渲染"服务端未提供下一步"）。 */
  readonly hasStep: boolean
}

/** 三维标签（R4）的展示形状。 */
export interface ThreeDimView {
  readonly provenance: string
  readonly trigger: string
  readonly connection: string
  readonly provenanceTone: ChipTone
  readonly triggerTone: ChipTone
  readonly connectionTone: ChipTone
  readonly rows: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string; readonly tone: ChipTone }>
}

/** 简历材料与解析摘要（PII 红线：只有 field state，没有邮箱/电话原值）。 */
export interface MaterialView {
  readonly resumeVersionId: string
  readonly resumeId: string
  readonly assetId: string
  readonly fileName: string
  readonly mimeType: string
  readonly byteSize: number
  readonly byteSizeText: string
  readonly sha256: string
  readonly sha256Text: string
  readonly sourceSha256Text: string
  readonly hashAligned: boolean
  readonly validationStatus: string
  readonly validationLabel: string
  readonly validationTone: ChipTone
  readonly parseStatus: string
  readonly parseLabel: string
  readonly parseTone: ChipTone
  readonly parser: string
  readonly parserVersion: string
  readonly pageCount: number | null
  readonly pageCountText: string
  readonly fieldStates: ReadonlyArray<{ readonly key: string; readonly state: string }>
  readonly entryCounts: { readonly work: number; readonly education: number }
  readonly evidenceCount: number
}

/** 初筛机器证据（basis_refs 里的 SCREENING_EVALUATION 分片）。 */
export interface ScreeningEvaluationView {
  readonly verdict: string
  readonly provenance: string
  readonly provenanceTone: ChipTone
  readonly criteriaEvaluated: boolean | null
  readonly evaluationDigest: string
  readonly evaluationDigestText: string
  readonly resumeVersionId: string
  readonly rubricVersionId: string
}

/** 初筛结论（decision_scope='SCREENING' 的当前有效决定）。 */
export interface ScreeningView {
  readonly decisionId: string
  readonly result: string
  readonly resultLabel: string
  readonly resultTone: ChipTone
  readonly stageCode: string
  readonly stageLabel: string
  readonly reason: string
  readonly decidedAt: string
  readonly decidedAtText: string
  readonly decidedBy: string
  readonly rubricVersionId: string
  readonly basisKinds: readonly string[]
  readonly evaluation: ScreeningEvaluationView | null
}

/** 一条简历字段摘要。 */
export interface ResumeFieldView {
  readonly key: string
  readonly state: string
  readonly provenance: string
  readonly entryCount: number | null
  readonly valuePreview: string
}

/** 简历证据条目（页码 + 短引文；不含 PII 字段值）。 */
export interface ResumeEvidenceView {
  readonly field: string
  readonly page: number | null
  readonly quote: string
  readonly block: number | null
}

/** 申请详情里的简历段。 */
export interface ResumeView {
  readonly material: MaterialView
  readonly fields: ReadonlyArray<ResumeFieldView>
  readonly workEntries: ReadonlyArray<{
    readonly company: string
    readonly title: string
    readonly start: string
    readonly end: string
  }>
  readonly educationEntries: ReadonlyArray<{
    readonly text: string
    readonly start: string
    readonly end: string
  }>
  readonly evidenceSamples: ReadonlyArray<ResumeEvidenceView>
}

/** 一条面评（已提交 / 待提交 / 已豁免）。 */
export interface ScorecardView {
  readonly id: string
  readonly interviewId: string
  readonly interviewerId: string
  readonly interviewerName: string
  readonly status: string
  readonly statusLabel: string
  readonly statusTone: ChipTone
  readonly overall: string
  readonly overallLabel: string
  readonly overallTone: ChipTone
  readonly revisionNo: number
  readonly submittedAt: string
  readonly submittedAtText: string
}

/** 面试官分配（含其本人面评状态）。 */
export interface InterviewerView {
  readonly id: string
  readonly actorId: string
  readonly displayName: string
  readonly roleInInterview: string
  readonly required: boolean
  readonly dueAt: string
  readonly dueAtText: string
  readonly scorecard: ScorecardView | null
}

/** Transcript 状态（只给状态/计数，不给正文）。 */
export interface TranscriptView {
  readonly state: string
  readonly stateLabel: string
  readonly stateTone: ChipTone
  readonly artifactId: string
  readonly artifactIdText: string
  readonly transcriptStatus: string
  readonly transcriptStatusLabel: string
  readonly transcriptStatusTone: ChipTone
  readonly provenance: string
  readonly triggerMode: string
  readonly connectionState: string
  readonly labels: ThreeDimView
  readonly isComplete: boolean
  readonly isCanonical: boolean
  readonly segmentCount: number
  readonly record: {
    readonly id: string
    readonly status: string
    readonly verificationStatus: string
    readonly evidenceOk: boolean
    readonly isCurrent: boolean
    readonly chunkCoverage: number | null
    readonly chunkCoverageText: string
  } | null
}

/** 一轮面试（排期 / 面试官 / 面评 / 转写四个独立分支各给各的）。 */
export interface InterviewView {
  readonly id: string
  readonly roundNo: number
  readonly slotCode: string
  readonly stageCode: string
  readonly stageLabel: string
  readonly status: string
  readonly statusLabel: string
  readonly statusTone: ChipTone
  readonly scheduledStartAt: string
  readonly scheduledStartText: string
  readonly scheduledEndAt: string
  readonly scheduledEndText: string
  readonly timezone: string
  readonly interviewers: ReadonlyArray<InterviewerView>
  readonly scorecards: {
    readonly required: number
    readonly submitted: number
    readonly missing: number
    readonly overdue: number
    readonly summaryText: string
    readonly tone: ChipTone
  }
  readonly transcript: TranscriptView
}

/** 决策卡（含历史与是否当前有效）。 */
export interface DecisionView {
  readonly id: string
  readonly scope: string
  readonly scopeLabel: string
  readonly stageCode: string
  readonly stageLabel: string
  readonly result: string
  readonly resultLabel: string
  readonly resultTone: ChipTone
  readonly reason: string
  readonly decidedAt: string
  readonly decidedAtText: string
  readonly decidedBy: string
  readonly isCurrent: boolean
  readonly supersededBy: string
  readonly basisKinds: readonly string[]
}

/** 时间线一条事实。 */
export interface TimelineEntryView {
  readonly at: string
  readonly atText: string
  readonly kind: string
  readonly kindLabel: string
  readonly label: string
  readonly refId: string
}

/** 一条 Transcript 处理运行摘要。 */
export interface TranscriptRunView {
  readonly runId: string
  readonly artifactId: string
  readonly artifactIdText: string
  readonly status: string
  readonly chunkTotal: number
  readonly chunkSucceeded: number
  readonly chunkFailed: number
  readonly modelId: string
}

/** 申请头部（行与详情共用；**不含**下一步，避免同一结论出现两次）。 */
export interface ApplicationHeaderView {
  readonly id: string
  readonly rowKey: string
  readonly candidateId: string
  readonly candidateName: string
  readonly candidateInitial: string
  readonly jobId: string
  readonly jobCode: string
  readonly jobTitle: string
  readonly lifecycleStatus: string
  readonly lifecycleLabel: string
  readonly lifecycleTone: ChipTone
  readonly stageCode: string
  readonly stageLabel: string
  readonly stageTone: ChipTone
  readonly stageEnteredAt: string
  readonly stageEnteredAtText: string
  readonly appliedAt: string
  readonly appliedAtText: string
  readonly stageBlockedReason: string
  readonly recordVersion: number
}

/** 面评进度（服务端聚合，客户端不重算业务数）。 */
export interface ScorecardProgressView {
  readonly required: number
  readonly submitted: number
  readonly summaryText: string
  readonly tone: ChipTone
}

/** 申请列表行：头部 + 事实摘要 + **唯一一份**下一步。 */
export interface ApplicationRowView extends ApplicationHeaderView {
  readonly material: MaterialView | null
  readonly materialSummary: string
  readonly materialTone: ChipTone
  readonly screening: ScreeningView | null
  readonly screeningSummary: string
  readonly screeningTone: ChipTone
  readonly interviews: ReadonlyArray<InterviewView>
  readonly interviewRoundCount: number
  readonly interviewSummary: string
  readonly interviewTone: ChipTone
  readonly scorecardProgress: ScorecardProgressView
  readonly transcriptSummary: string
  readonly transcriptTone: ChipTone
  readonly nextStep: NextStepView
  readonly filterKind: 'screening' | 'interviewing' | 'other'
}

/** 设置快照里的阶段目录项。 */
export interface StageCatalogStageView {
  readonly code: string
  readonly label: string
  readonly kind: string
  readonly order: number
  readonly inV1Scope: boolean
}

/** 设置快照（只读）。 */
export interface SettingsView {
  readonly stageCatalog: {
    readonly versionNo: number
    readonly effectiveFrom: string
    readonly effectiveFromText: string
    readonly stages: ReadonlyArray<StageCatalogStageView>
  } | null
  readonly configs: ReadonlyArray<{
    readonly configKey: string
    readonly scope: string
    readonly scopeId: string
    readonly versionNo: number
    readonly effectiveFrom: string
    readonly effectiveFromText: string
    readonly effectiveTo: string
    readonly effectiveToText: string
    readonly payloadKeys: readonly string[]
    readonly payloadKeyCount: number
  }>
  readonly departments: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly hiringTeams: ReadonlyArray<{
    readonly id: string
    readonly code: string
    readonly name: string
    readonly departmentName: string
    readonly members: ReadonlyArray<{
      readonly actorId: string
      readonly displayName: string
      readonly teamRole: string
      readonly actorKind: string
    }>
  }>
  readonly entry: { readonly available: boolean; readonly href: string; readonly note: string }
}

/** 岗位卡（列表 + 详情共用）。 */
export interface JobView {
  readonly id: string
  readonly rowKey: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly statusLabel: string
  readonly statusTone: ChipTone
  readonly departmentName: string
  readonly createdAt: string
  readonly createdAtText: string
  readonly statusChangedAt: string
  readonly statusChangedAtText: string
  readonly versionNo: number | null
  readonly versionText: string
  readonly rubric: {
    readonly versionNo: number
    readonly approved: boolean
    readonly dimensionCount: number
    readonly summaryText: string
    readonly tone: ChipTone
  } | null
  readonly postings: ReadonlyArray<{
    readonly id: string
    readonly channelName: string
    readonly status: string
    readonly statusLabel: string
    readonly tone: ChipTone
    readonly externalUrl: string
  }>
  readonly applicationCounts: {
    readonly total: number
    readonly active: number
    readonly byStage: ReadonlyArray<{ readonly code: string; readonly label: string; readonly count: number }>
  }
  /** 岗位级业务结论 + 下一步（只在岗位头卡出现一次）。 */
  readonly nextStep: NextStepView
}

/** `GET /recruitment/api/recruiting/overview` 的视图模型。 */
export interface RecruitingOverviewView {
  readonly contractVersion: string
  readonly configured: boolean
  readonly issues: readonly string[]
  readonly evaluatedAt: string
  readonly evaluatedAtText: string
  readonly actor: {
    readonly actorId: string
    readonly displayName: string
    readonly roles: readonly string[]
  }
  readonly labels: ThreeDimView
  readonly counts: {
    readonly jobsTotal: number
    readonly jobsOpen: number
    readonly applicationsTotal: number
    readonly applicationsActive: number
    readonly awaitingScreening: number
    readonly interviewing: number
    readonly awaitingDecision: number
    readonly interviewsScheduled: number
    readonly scorecardsRequiredTotal: number
    readonly scorecardsSubmittedTotal: number
    readonly transcriptsReady: number
    readonly transcriptsPending: number
    readonly byStage: ReadonlyArray<{ readonly code: string; readonly label: string; readonly count: number }>
  }
  readonly jobs: ReadonlyArray<JobView>
  readonly applications: ReadonlyArray<ApplicationRowView>
  readonly settings: SettingsView
  readonly actions: Readonly<Record<string, ActionView>>
  /** 写动作按契约顺序排好的稳定列表（渲染顺序用它）。 */
  readonly actionList: ReadonlyArray<ActionView>
  /** 下一步按 kind 的聚合计数（aside 只显示计数，不重复逐条结论）。 */
  readonly nextStepTotals: {
    readonly info: number
    readonly human: number
    readonly wait: number
    readonly missing: number
  }
}

/** `GET /recruitment/api/recruiting/applications/:id` 的视图模型。 */
export interface ApplicationDetailView {
  readonly contractVersion: string
  readonly evaluatedAt: string
  readonly evaluatedAtText: string
  readonly actor: {
    readonly actorId: string
    readonly displayName: string
    readonly roles: readonly string[]
  }
  readonly labels: ThreeDimView
  readonly header: ApplicationHeaderView
  /** 申请级业务结论 + 下一步（详情页**唯一**一份；头部类型里没有该字段）。 */
  readonly nextStep: NextStepView
  readonly material: MaterialView | null
  readonly resume: ResumeView | null
  readonly screeningEvidence: {
    readonly decision: ScreeningView | null
    readonly rubric: {
      readonly versionNo: number
      readonly approved: boolean
      readonly dimensions: ReadonlyArray<{
        readonly key: string
        readonly kind: string
        readonly label: string
        readonly weight: number | null
        readonly operator: string
        readonly valuePreview: string
        readonly question: string
      }>
    } | null
    readonly basis: ReadonlyArray<{ readonly kind: string; readonly detailText: string }>
  }
  readonly interviews: ReadonlyArray<InterviewView>
  readonly scorecardProgress: ScorecardProgressView
  readonly transcriptSummary: string
  readonly transcriptTone: ChipTone
  readonly transcriptRuns: ReadonlyArray<TranscriptRunView>
  readonly decisions: ReadonlyArray<DecisionView>
  readonly timeline: ReadonlyArray<TimelineEntryView>
  readonly actions: Readonly<Record<string, ActionView>>
  readonly actionList: ReadonlyArray<ActionView>
}

/** `GET /recruitment/api/recruiting/jobs/:id` 的视图模型。 */
export interface JobDetailView {
  readonly contractVersion: string
  readonly evaluatedAt: string
  readonly evaluatedAtText: string
  readonly labels: ThreeDimView
  readonly job: JobView
  readonly descriptionMd: string
  readonly requirementsMd: string
  readonly versions: ReadonlyArray<{
    readonly id: string
    readonly versionNo: number
    readonly payloadHash: string
    readonly payloadHashText: string
    readonly createdAt: string
    readonly createdAtText: string
    readonly approved: boolean
  }>
  readonly rubric: {
    readonly versionNo: number
    readonly approved: boolean
    readonly dimensions: ReadonlyArray<{
      readonly key: string
      readonly kind: string
      readonly label: string
      readonly weight: number | null
      readonly operator: string
      readonly valuePreview: string
      readonly question: string
    }>
  } | null
  readonly applications: ReadonlyArray<ApplicationRowView>
  readonly actions: Readonly<Record<string, ActionView>>
  readonly actionList: ReadonlyArray<ActionView>
}

/** 阶段目录上下文（`stage_catalog` → 阶段标签）。 */
interface StageContext {
  readonly labels: Readonly<Record<string, string>>
  readonly order: Readonly<Record<string, number>>
}

// =====================================================================
//  基础构造
// =====================================================================

/** 阶段中文名：服务端 catalog 优先，其次内置兜底，最后原样返回码。 */
export function stageLabelOf(code: string, context?: StageContext): string {
  if (code === '') return '未提供阶段'
  const fromCatalog = context?.labels[code]
  if (fromCatalog !== undefined && fromCatalog !== '') return fromCatalog
  return DEFAULT_STAGE_LABELS[code] ?? code
}

/** 阶段排序权重。 */
function stageOrderOf(code: string, context?: StageContext): number {
  return context?.order[code] ?? STAGE_ORDER[code] ?? 999
}

/** 归一化 `next_step`；缺字段/坏类型降级为空（`hasStep=false`）。 */
export function normalizeNextStep(value: unknown): NextStepView {
  const raw = record(value)
  const code = text(raw.code)
  const label = text(raw.label)
  const kind = oneOf(raw.kind, ['INFO', 'HUMAN_ACTION', 'WAIT'])
  const kindLabel = kind === 'HUMAN_ACTION' ? '需要人工处理' : kind === 'WAIT' ? '等待中' : kind === 'INFO' ? '进展' : ''
  const tone: ChipTone =
    code === 'CLOSED'
      ? 'gray'
      : kind === 'HUMAN_ACTION'
        ? 'amber'
        : kind === 'WAIT'
          ? 'amber'
          : kind === 'INFO'
            ? 'blue'
            : 'gray'
  return { code, label, kind, kindLabel, tone, hasStep: code !== '' || label !== '' }
}

/** 三维标签的展示口径（`LIVE`/`FIXTURE` 等原值直接带出，不翻译、不合并）。 */
export function normalizeThreeDimLabels(value: unknown): ThreeDimView {
  const raw = record(value)
  const provenance = text(raw.provenance)
  const trigger = text(raw.trigger)
  const connection = text(raw.connection)
  const provenanceTone: ChipTone = provenance === 'LIVE' ? 'green' : provenance === 'FIXTURE' ? 'amber' : 'gray'
  const triggerTone: ChipTone = trigger === 'EVENT' ? 'blue' : trigger === 'MANUAL' ? 'amber' : 'gray'
  const connectionTone: ChipTone =
    connection === 'CONNECTED' ? 'green' : connection === 'AUTH_REQUIRED' ? 'red' : connection === 'NOT_CONNECTED' ? 'gray' : 'gray'
  return {
    provenance,
    trigger,
    connection,
    provenanceTone,
    triggerTone,
    connectionTone,
    rows: [
      { key: 'provenance', label: '数据来源', value: provenance, tone: provenanceTone },
      { key: 'trigger', label: '触发方式', value: trigger, tone: triggerTone },
      { key: 'connection', label: '连接状态', value: connection, tone: connectionTone },
    ],
  }
}

/** 归一化一个写动作：`available` 只在服务端明确 true **且** 给了 seam 时才为 true（fail-closed）。 */
export function normalizeAction(key: string, value: unknown): ActionView {
  const raw = record(value)
  const seam = text(raw.seam)
  const declaredAvailable = bool(raw.available)
  const pending = text(raw.pending)
  const available = declaredAvailable && seam !== ''
  const reasonCode = available ? '' : (pending !== '' ? pending : declaredAvailable ? 'ACTION_SEAM_MISSING' : 'ACTION_SEAM_NOT_WIRED')
  return {
    key,
    label: ACTION_LABELS[key] ?? key,
    available,
    seam,
    pending: reasonCode,
    pendingText: reasonCode === '' ? '' : `待后端接入（pending: ${reasonCode}）`,
    reasonText: reasonCode === '' ? '' : (PENDING_REASON_TEXT[reasonCode] ?? '后端写路径未接入'),
  }
}

/** 归一化整张动作表（未知键忽略、缺键按不可用渲染，保证按钮集合稳定）。 */
export function normalizeActions(value: unknown): {
  readonly byKey: Readonly<Record<string, ActionView>>
  readonly list: ReadonlyArray<ActionView>
} {
  const raw = record(value)
  const byKey: Record<string, ActionView> = {}
  for (const key of ACTION_KEYS) byKey[key] = normalizeAction(key, raw[key])
  for (const [key, actionValue] of Object.entries(raw)) {
    if (byKey[key] !== undefined) continue
    const normalized = normalizeAction(key, actionValue)
    byKey[key] = normalized
  }
  const list = ACTION_KEYS.map((key) => byKey[key]).filter((action): action is ActionView => action !== undefined)
  return { byKey, list }
}

/** 归一化简历材料摘要；null / 坏类型 → null（不伪造材料）。 */
export function normalizeMaterial(value: unknown): MaterialView | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const fileName = text(raw.file_name)
  const resumeVersionId = text(raw.resume_version_id)
  const sha256 = text(raw.sha256)
  if (fileName === '' && resumeVersionId === '' && sha256 === '') return null
  const parseStatus = oneOf(raw.parse_status, ['PENDING', 'PARSING', 'PARSED', 'PARTIAL', 'FAILED', 'NEEDS_REVIEW']) || text(raw.parse_status)
  const validationStatus =
    oneOf(raw.validation_status, ['PENDING', 'VALID', 'INVALID']) || text(raw.validation_status)
  const pageCount = numberOrNull(raw.page_count)
  const fieldStatesRaw = record(raw.field_states)
  const fieldStates: { key: string; state: string }[] = []
  for (const key of Object.keys(fieldStatesRaw)) {
    const state = text(fieldStatesRaw[key])
    if (state !== '') fieldStates.push({ key, state })
  }
  const entryCountsRaw = record(raw.entry_counts)
  return {
    resumeVersionId,
    resumeId: text(raw.resume_id),
    assetId: text(raw.asset_id),
    fileName,
    mimeType: text(raw.mime_type),
    byteSize: count(raw.byte_size),
    byteSizeText: formatBytes(raw.byte_size),
    sha256,
    sha256Text: shortSha(sha256),
    sourceSha256Text: shortSha(raw.source_asset_sha256),
    hashAligned: bool(raw.source_hash_aligned),
    validationStatus,
    validationLabel: VALIDATION_LABELS[validationStatus] ?? (validationStatus !== '' ? validationStatus : '校验状态未知'),
    validationTone: VALIDATION_TONES[validationStatus] ?? 'gray',
    parseStatus,
    parseLabel: PARSE_LABELS[parseStatus] ?? (parseStatus !== '' ? parseStatus : '解析状态未知'),
    parseTone: PARSE_TONES[parseStatus] ?? 'gray',
    parser: text(raw.parser_name),
    parserVersion: text(raw.parser_version),
    pageCount,
    pageCountText: pageCount === null ? '' : `${String(pageCount)} 页`,
    fieldStates,
    entryCounts: { work: count(entryCountsRaw.work), education: count(entryCountsRaw.education) },
    evidenceCount: count(raw.evidence_count),
  }
}

/** 材料摘要的一行文案（`profile` 等坏类型不会撑爆行）。 */
export function materialSummaryOf(material: MaterialView | null): { readonly summary: string; readonly tone: ChipTone } {
  if (material === null) return { summary: '未关联材料', tone: 'gray' }
  return { summary: joinTexts([material.parseLabel, material.pageCountText]), tone: material.parseTone }
}

/** 归一化初筛证据分片。 */
function normalizeScreeningEvaluation(value: unknown): ScreeningEvaluationView | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const verdict = text(raw.verdict)
  const provenance = text(raw.provenance)
  const digest = text(raw.evaluation_digest)
  const criteriaEvaluated =
    typeof raw.criteria_evaluated === 'boolean' ? raw.criteria_evaluated : null
  const resumeVersionId = text(raw.resume_version_id)
  const rubricVersionId = text(raw.rubric_version_id)
  if (verdict === '' && provenance === '' && digest === '' && resumeVersionId === '' && rubricVersionId === '') return null
  return {
    verdict,
    provenance,
    provenanceTone: provenance === 'LIVE' ? 'green' : provenance === 'FIXTURE' ? 'amber' : 'gray',
    criteriaEvaluated,
    evaluationDigest: digest,
    evaluationDigestText: shortSha(digest),
    resumeVersionId,
    rubricVersionId,
  }
}

/** 归一化初筛结论。 */
export function normalizeScreening(value: unknown, context?: StageContext): ScreeningView | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const decisionId = text(raw.decision_id)
  const result = text(raw.result)
  const reason = text(raw.reason)
  if (decisionId === '' && result === '' && reason === '') return null
  const stageCode = text(raw.stage_code)
  return {
    decisionId,
    result,
    resultLabel: DECISION_RESULT_LABELS[result] ?? (result !== '' ? result : '结论未知'),
    resultTone: DECISION_RESULT_TONES[result] ?? 'gray',
    stageCode,
    stageLabel: stageCode === '' ? '' : stageLabelOf(stageCode, context),
    reason,
    decidedAt: text(raw.decided_at),
    decidedAtText: formatDateTime(raw.decided_at),
    decidedBy: text(raw.decided_by_display_name),
    rubricVersionId: text(raw.rubric_version_id),
    basisKinds: stringList(raw.basis_kinds),
    evaluation: normalizeScreeningEvaluation(raw.evaluation),
  }
}

/** 初筛结论的一行文案。 */
export function screeningSummaryOf(screening: ScreeningView | null): { readonly summary: string; readonly tone: ChipTone } {
  if (screening === null) return { summary: '未初筛', tone: 'gray' }
  return { summary: screening.resultLabel, tone: screening.resultTone }
}

/** 归一化一条面评。 */
function normalizeScorecard(value: unknown): ScorecardView | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const id = text(raw.scorecard_id)
  const status = text(raw.status)
  if (id === '' && status === '') return null
  const overall = text(raw.overall)
  return {
    id,
    interviewId: text(raw.interview_id),
    interviewerId: text(raw.interviewer_id),
    interviewerName: text(raw.interviewer_display_name),
    status,
    statusLabel: SCORECARD_STATUS_LABELS[status] ?? (status !== '' ? status : '状态未知'),
    statusTone: SCORECARD_STATUS_TONES[status] ?? 'gray',
    overall,
    overallLabel: OVERALL_LABELS[overall] ?? (overall !== '' ? overall : ''),
    overallTone: OVERALL_TONES[overall] ?? 'gray',
    revisionNo: count(raw.revision_no),
    submittedAt: text(raw.submitted_at),
    submittedAtText: formatDateTime(raw.submitted_at),
  }
}

/** 归一化面试官分配。 */
function normalizeInterviewer(value: unknown): InterviewerView | null {
  const raw = record(value)
  const id = text(raw.interviewer_row_id)
  const actorId = text(raw.actor_id)
  const displayName = text(raw.display_name)
  if (id === '' && actorId === '' && displayName === '') return null
  return {
    id,
    actorId,
    displayName,
    roleInInterview: text(raw.role_in_interview),
    required: bool(raw.required_scorecard),
    dueAt: text(raw.scorecard_due_at),
    dueAtText: formatDateTime(raw.scorecard_due_at),
    scorecard: normalizeScorecard(raw.scorecard),
  }
}

/** 归一化 Transcript 状态（`state` 与 `artifact_id` 的组合由服务端保证，这里只如实透传）。 */
export function normalizeTranscript(value: unknown): TranscriptView {
  const raw = record(value)
  const state = oneOf(raw.state, ['READY', 'PROCESSING', 'NOT_READY', 'FAILED', 'MISSING'])
  const transcriptStatus = text(raw.transcript_status)
  const recordRaw = raw.interview_record
  const interviewRecord =
    recordRaw === null || recordRaw === undefined
      ? null
      : (() => {
          const entry = record(recordRaw)
          const id = text(entry.interview_record_id)
          if (id === '' && text(entry.status) === '') return null
          const chunkCoverage = numberOrNull(entry.chunk_coverage)
          return {
            id,
            status: text(entry.status),
            verificationStatus: text(entry.verification_status),
            evidenceOk: bool(entry.evidence_ok),
            isCurrent: bool(entry.is_current),
            chunkCoverage,
            chunkCoverageText: chunkCoverage === null ? '' : `${String(Math.round(chunkCoverage * 100))}%`,
          }
        })()
  return {
    state,
    stateLabel: TRANSCRIPT_STATE_LABELS[state] ?? '未提供',
    stateTone: TRANSCRIPT_STATE_TONES[state] ?? 'gray',
    artifactId: text(raw.artifact_id),
    artifactIdText: shortSha(raw.artifact_id),
    transcriptStatus,
    transcriptStatusLabel:
      TRANSCRIPT_STATUS_LABELS[transcriptStatus] ?? (transcriptStatus !== '' ? transcriptStatus : ''),
    transcriptStatusTone: TRANSCRIPT_STATUS_TONES[transcriptStatus] ?? 'gray',
    provenance: text(raw.provenance),
    triggerMode: text(raw.trigger_mode),
    connectionState: text(raw.connection_state),
    labels: normalizeThreeDimLabels({
      provenance: raw.provenance,
      trigger: raw.trigger_mode,
      connection: raw.connection_state,
    }),
    isComplete: bool(raw.is_complete),
    isCanonical: bool(raw.is_canonical),
    segmentCount: count(raw.segment_count),
    record: interviewRecord,
  }
}

/** 归一化一轮面试（四个独立分支各归各的，不用排期状态推断面评/转写）。 */
export function normalizeInterview(value: unknown, context?: StageContext): InterviewView | null {
  const raw = record(value)
  const id = text(raw.interview_id)
  const roundNo = count(raw.round_no)
  const slotCode = text(raw.slot_code)
  if (id === '' && roundNo === 0 && slotCode === '') return null
  const status = oneOf(raw.status, [
    'SCHEDULED',
    'IN_PROGRESS',
    'POST_INTERVIEW',
    'EVALUATION_READY',
    'DECIDED',
    'RESCHEDULED',
    'CANCELLED',
    'NO_SHOW',
  ]) || text(raw.status)
  const interviewersRaw = items(raw.interviewers)
  const interviewers: InterviewerView[] = []
  for (const item of interviewersRaw) {
    const interviewer = normalizeInterviewer(item)
    if (interviewer !== null) interviewers.push(interviewer)
  }
  const scorecardsRaw = record(raw.scorecards)
  const required = count(scorecardsRaw.required_total)
  const submitted = count(scorecardsRaw.submitted)
  const missing = count(scorecardsRaw.missing_total)
  const overdue = count(scorecardsRaw.overdue)
  const complete = required > 0 && submitted >= required
  return {
    id,
    roundNo,
    slotCode,
    stageCode: text(raw.stage_code),
    stageLabel: text(raw.stage_code) === '' ? '' : stageLabelOf(text(raw.stage_code), context),
    status,
    statusLabel: INTERVIEW_STATUS_LABELS[status] ?? (status !== '' ? status : '状态未知'),
    statusTone: INTERVIEW_STATUS_TONES[status] ?? 'gray',
    scheduledStartAt: text(raw.scheduled_start_at),
    scheduledStartText: formatDateTime(raw.scheduled_start_at),
    scheduledEndAt: text(raw.scheduled_end_at),
    scheduledEndText: formatDateTime(raw.scheduled_end_at),
    timezone: text(raw.timezone),
    interviewers,
    scorecards: {
      required,
      submitted,
      missing,
      overdue,
      summaryText: required === 0 ? '无需面评' : `已提交 ${String(submitted)}/${String(required)}`,
      tone: required === 0 ? 'gray' : complete ? 'green' : overdue > 0 ? 'red' : 'amber',
    },
    transcript: normalizeTranscript(raw.transcript),
  }
}

/** 从服务端进度聚合出"面评进度"（不重算业务数）。 */
export function buildScorecardProgress(value: unknown): ScorecardProgressView {
  const raw = record(value)
  const required = count(raw.scorecards_required)
  const submitted = count(raw.scorecards_submitted)
  const complete = required > 0 && submitted >= required
  return {
    required,
    submitted,
    summaryText: required === 0 ? '无需面评' : `已提交 ${String(submitted)}/${String(required)}`,
    tone: required === 0 ? 'gray' : complete ? 'green' : 'amber',
  }
}

/** 面试轮次与状态的一行文案。 */
export function interviewSummaryOf(interviews: readonly InterviewView[]): {
  readonly rounds: number
  readonly summary: string
  readonly tone: ChipTone
} {
  const rounds = interviews.length
  if (rounds === 0) return { rounds, summary: '未排期', tone: 'gray' }
  let tone: ChipTone = 'gray'
  for (const interview of interviews) {
    const candidate: ChipTone =
      interview.status === 'SCHEDULED' || interview.status === 'IN_PROGRESS'
        ? 'blue'
        : interview.status === 'POST_INTERVIEW' || interview.status === 'RESCHEDULED'
          ? 'amber'
          : interview.status === 'EVALUATION_READY' || interview.status === 'DECIDED'
            ? 'green'
            : interview.status === 'NO_SHOW'
              ? 'red'
              : 'gray'
    // 取"最需要注意"的色档：red > amber > blue > green > gray。
    const rank: Record<ChipTone, number> = { red: 4, amber: 3, blue: 2, green: 1, gray: 0 }
    if (rank[candidate] > rank[tone]) tone = candidate
  }
  const last = interviews[interviews.length - 1]
  return { rounds, summary: `${String(rounds)} 轮${last !== undefined ? ` · ${last.statusLabel}` : ''}`, tone }
}

/** 转写状态一行文案（来自服务端 `progress.transcript_state`）。 */
export function transcriptSummaryOf(value: unknown): { readonly summary: string; readonly tone: ChipTone } {
  const state = oneOf(value, ['READY', 'PROCESSING', 'NOT_READY', 'FAILED', 'MISSING'])
  if (state === '') return { summary: '状态未知', tone: 'gray' }
  return { summary: TRANSCRIPT_STATE_LABELS[state] ?? state, tone: TRANSCRIPT_STATE_TONES[state] ?? 'gray' }
}

/** 归一化决策。 */
export function normalizeDecision(value: unknown, context?: StageContext): DecisionView | null {
  const raw = record(value)
  const id = text(raw.decision_id)
  const result = text(raw.result)
  const reason = text(raw.reason)
  if (id === '' && result === '' && reason === '') return null
  const scope = text(raw.decision_scope)
  const stageCode = text(raw.stage_code)
  return {
    id,
    scope,
    scopeLabel: DECISION_SCOPE_LABELS[scope] ?? (scope !== '' ? scope : ''),
    stageCode,
    stageLabel: stageCode === '' ? '' : stageLabelOf(stageCode, context),
    result,
    resultLabel: DECISION_RESULT_LABELS[result] ?? (result !== '' ? result : '结论未知'),
    resultTone: DECISION_RESULT_TONES[result] ?? 'gray',
    reason,
    decidedAt: text(raw.decided_at),
    decidedAtText: formatDateTime(raw.decided_at),
    decidedBy: text(raw.decided_by_display_name),
    isCurrent: bool(raw.is_current),
    supersededBy: text(raw.superseded_by_decision_id),
    basisKinds: stringList(raw.basis_kinds),
  }
}

/** 归一化时间线一条。 */
export function normalizeTimelineEntry(value: unknown): TimelineEntryView | null {
  const raw = record(value)
  const at = text(raw.at)
  const kind = text(raw.kind)
  const label = text(raw.label)
  if (at === '' && kind === '' && label === '') return null
  return {
    at,
    atText: formatDateTime(at),
    kind,
    kindLabel: TIMELINE_KIND_LABELS[kind] ?? (kind !== '' ? kind : ''),
    label,
    refId: text(raw.ref_id),
  }
}

/** 申请头部（行 / 详情共用；**不含下一步**）。 */
export function buildApplicationHeader(value: unknown, context?: StageContext): ApplicationHeaderView {
  const raw = record(value)
  const candidate = record(raw.candidate)
  const job = record(raw.job)
  const id = text(raw.application_id)
  const lifecycleStatus = oneOf(raw.lifecycle_status, ['ACTIVE', 'ON_HOLD', 'WITHDRAWN', 'CLOSED']) || text(raw.lifecycle_status)
  const stageCode = text(raw.current_stage_code)
  const candidateName = text(candidate.display_name)
  return {
    id,
    rowKey: id !== '' ? id : `application-${text(job.job_id)}-${String(count(raw.record_version))}`,
    candidateId: text(candidate.candidate_id),
    candidateName: candidateName !== '' ? candidateName : '（服务端未提供候选人姓名）',
    candidateInitial: initial(candidateName),
    jobId: text(job.job_id),
    jobCode: text(job.code),
    jobTitle: text(job.title) !== '' ? text(job.title) : '（服务端未提供岗位名称）',
    lifecycleStatus,
    lifecycleLabel: LIFECYCLE_LABELS[lifecycleStatus] ?? (lifecycleStatus !== '' ? lifecycleStatus : '状态未知'),
    lifecycleTone: LIFECYCLE_TONES[lifecycleStatus] ?? 'gray',
    stageCode,
    stageLabel: stageLabelOf(stageCode, context),
    stageTone: STAGE_TONES[stageCode] ?? 'gray',
    stageEnteredAt: text(raw.stage_entered_at),
    stageEnteredAtText: formatDateTime(raw.stage_entered_at),
    appliedAt: text(raw.applied_at),
    appliedAtText: formatDateTime(raw.applied_at),
    stageBlockedReason: text(raw.stage_blocked_reason),
    recordVersion: count(raw.record_version),
  }
}

/** 面试列表（详情与行共用同一套归一化）。 */
export function buildInterviews(value: unknown, context?: StageContext): InterviewView[] {
  const out: InterviewView[] = []
  for (const item of items(value)) {
    const interview = normalizeInterview(item, context)
    if (interview !== null) out.push(interview)
  }
  return out
}

/** 申请列表行（唯一一份下一步来自 `progress.next_step`）。 */
export function buildApplicationRow(value: unknown, context?: StageContext): ApplicationRowView {
  const raw = record(value)
  const header = buildApplicationHeader(raw, context)
  const material = normalizeMaterial(raw.material)
  const materialSummary = materialSummaryOf(material)
  const screening = normalizeScreening(raw.screening, context)
  const screeningSummary = screeningSummaryOf(screening)
  const interviews = buildInterviews(raw.interviews, context)
  const interviewSummary = interviewSummaryOf(interviews)
  const progress = record(raw.progress)
  const scorecardProgress = buildScorecardProgress(progress)
  const transcriptSummary = transcriptSummaryOf(progress.transcript_state)
  const nextStep = normalizeNextStep(progress.next_step)
  const filterKind: ApplicationRowView['filterKind'] =
    nextStep.code === 'PROVIDE_SCREENING_DECISION' || header.stageCode === 'S7'
      ? 'screening'
      : nextStep.code === 'PREPARE_INTERVIEW' ||
          nextStep.code === 'WAIT_SCORECARDS' ||
          header.stageCode === 'S8' ||
          header.stageCode === 'S9'
        ? 'interviewing'
        : 'other'
  return {
    ...header,
    material,
    materialSummary: materialSummary.summary,
    materialTone: materialSummary.tone,
    screening,
    screeningSummary: screeningSummary.summary,
    screeningTone: screeningSummary.tone,
    interviews,
    interviewRoundCount: interviewSummary.rounds,
    interviewSummary: interviewSummary.summary,
    interviewTone: interviewSummary.tone,
    scorecardProgress,
    transcriptSummary: transcriptSummary.summary,
    transcriptTone: transcriptSummary.tone,
    nextStep,
    filterKind,
  }
}

/** 申请行列表；非对象元素直接丢弃（`null` / 字符串不是申请）。 */
export function buildApplicationRows(value: unknown, context?: StageContext): ApplicationRowView[] {
  const out: ApplicationRowView[] = []
  for (const item of items(value)) {
    if (Object.keys(record(item)).length === 0) continue
    out.push(buildApplicationRow(item, context))
  }
  return out
}

/** 岗位卡。 */
export function buildJob(value: unknown, context?: StageContext): JobView {
  const raw = record(value)
  const rubricRaw = record(raw.rubric)
  const rubricVersionId = text(rubricRaw.rubric_version_id)
  const rubric =
    rubricVersionId === '' && count(rubricRaw.version_no) === 0 && count(rubricRaw.dimension_count) === 0
      ? null
      : {
          versionNo: count(rubricRaw.version_no),
          approved: bool(rubricRaw.approved),
          dimensionCount: count(rubricRaw.dimension_count),
          summaryText: joinTexts([
            `Rubric r${String(count(rubricRaw.version_no))}`,
            `${String(count(rubricRaw.dimension_count))} 个维度`,
            bool(rubricRaw.approved) ? '已批准' : '未批准',
          ]),
          tone: (bool(rubricRaw.approved) ? 'green' : 'amber') as ChipTone,
        }
  const postingsRaw = items(raw.postings)
  const postings: JobView['postings'][number][] = []
  for (const item of postingsRaw) {
    const entry = record(item)
    const status = text(entry.status)
    postings.push({
      id: text(entry.posting_id),
      channelName: text(entry.channel_name),
      status,
      statusLabel: status !== '' ? status : '状态未知',
      tone: status === 'PUBLISHED' || status === 'ACTIVE' ? 'green' : status === 'CLOSED' ? 'gray' : 'gray',
      externalUrl: text(entry.external_url),
    })
  }
  const countsRaw = record(raw.application_counts)
  const byStageRaw = record(countsRaw.by_stage)
  const byStage = Object.keys(byStageRaw)
    .map((code) => ({ code, label: stageLabelOf(code, context), count: count(byStageRaw[code]) }))
    .sort((left, right) => stageOrderOf(left.code, context) - stageOrderOf(right.code, context))
  const status = oneOf(raw.status, ['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'OPEN', 'PAUSED', 'CLOSED', 'ARCHIVED']) || text(raw.status)
  const versionNo = numberOrNull(raw.version_no)
  const title = text(raw.title)
  const code = text(raw.code)
  const id = text(raw.job_id)
  return {
    id,
    rowKey: id !== '' ? id : `job-${code}`,
    code,
    // 真实数据里存在 title 为空串的岗位（演示库 JOB-20261114-77CD5B）：
    // 空 title 回退 `code`，两者都空才显示占位文案——界面不出现裸 `""`。
    title: title !== '' ? title : code !== '' ? code : '（服务端未提供岗位名称）',
    status,
    statusLabel: JOB_STATUS_LABELS[status] ?? (status !== '' ? status : '状态未知'),
    statusTone: JOB_STATUS_TONES[status] ?? 'gray',
    departmentName: text(raw.department_name),
    createdAt: text(raw.created_at),
    createdAtText: formatDateTime(raw.created_at),
    statusChangedAt: text(raw.status_changed_at),
    statusChangedAtText: formatDateTime(raw.status_changed_at),
    versionNo,
    versionText: versionNo === null ? '' : `r${String(versionNo)}`,
    rubric,
    postings,
    applicationCounts: {
      total: count(countsRaw.total),
      active: count(countsRaw.active),
      byStage,
    },
    nextStep: normalizeNextStep(raw.next_step),
  }
}

/** 设置快照（只读）。 */
export function normalizeSettings(value: unknown, context?: StageContext): SettingsView {
  const raw = record(value)
  const catalogRaw = raw.stage_catalog
  let stageCatalog: SettingsView['stageCatalog'] = null
  if (catalogRaw !== null && catalogRaw !== undefined) {
    const entry = record(catalogRaw)
    const stagesRaw = items(entry.stages)
    const stages: StageCatalogStageView[] = []
    for (const item of stagesRaw) {
      const stage = record(item)
      const code = text(stage.code)
      if (code === '') continue
      stages.push({
        code,
        label: text(stage.label) !== '' ? text(stage.label) : stageLabelOf(code, context),
        kind: text(stage.kind),
        order: count(stage.order),
        inV1Scope: bool(stage.in_v1_scope),
      })
    }
    stageCatalog = {
      versionNo: count(entry.version_no),
      effectiveFrom: text(entry.effective_from),
      effectiveFromText: formatDateTime(entry.effective_from),
      stages,
    }
  }
  const configsRaw = items(raw.configs)
  const configs: SettingsView['configs'][number][] = []
  for (const item of configsRaw) {
    const entry = record(item)
    const payloadKeys = stringList(entry.payload_keys)
    configs.push({
      configKey: text(entry.config_key),
      scope: text(entry.scope),
      scopeId: text(entry.scope_id),
      versionNo: count(entry.version_no),
      effectiveFrom: text(entry.effective_from),
      effectiveFromText: formatDateTime(entry.effective_from),
      effectiveTo: text(entry.effective_to),
      effectiveToText: formatDateTime(entry.effective_to),
      payloadKeys,
      payloadKeyCount: payloadKeys.length,
    })
  }
  const departments: SettingsView['departments'][number][] = []
  for (const item of items(raw.departments)) {
    const entry = record(item)
    const id = text(entry.department_id)
    const name = text(entry.name)
    if (id === '' && name === '') continue
    departments.push({ id, name })
  }
  const hiringTeams: SettingsView['hiringTeams'][number][] = []
  for (const item of items(raw.hiring_teams)) {
    const entry = record(item)
    const teamId = text(entry.team_id)
    const membersRaw = items(entry.members)
    const members: SettingsView['hiringTeams'][number]['members'][number][] = []
    for (const memberItem of membersRaw) {
      const member = record(memberItem)
      const actorId = text(member.actor_id)
      const displayName = text(member.display_name)
      if (actorId === '' && displayName === '') continue
      members.push({
        actorId,
        displayName: displayName !== '' ? displayName : '（未提供姓名）',
        teamRole: text(member.team_role),
        actorKind: text(member.actor_kind),
      })
    }
    hiringTeams.push({
      id: teamId,
      code: text(entry.code),
      name: text(entry.name),
      departmentName: text(entry.department_name),
      members,
    })
  }
  const entryRaw = record(raw.entry)
  return {
    stageCatalog,
    configs,
    departments,
    hiringTeams,
    entry: {
      available: bool(entryRaw.available),
      href: text(entryRaw.href),
      note: text(entryRaw.note),
    },
  }
}

/** 从阶段目录构造阶段上下文（标签 / 顺序都以服务端为准）。 */
function stageContextOf(settingsRaw: unknown): StageContext {
  const settings = record(settingsRaw)
  const catalog = record(settings.stage_catalog)
  const labels: Record<string, string> = {}
  const order: Record<string, number> = {}
  for (const item of items(catalog.stages)) {
    const stage = record(item)
    const code = text(stage.code)
    if (code === '') continue
    const label = text(stage.label)
    if (label !== '') labels[code] = label
    const sortOrder = count(stage.order)
    if (sortOrder > 0) order[code] = sortOrder
  }
  return { labels, order }
}

/** 阶段计数表 → 稳定排序数组（空阶段码直接丢弃，不渲染"未提供阶段 · N"这种假分组）。 */
function byStageRows(value: unknown, context: StageContext): { code: string; label: string; count: number }[] {
  const raw = record(value)
  return Object.keys(raw)
    .filter((code) => code.trim() !== '')
    .map((code) => ({ code, label: stageLabelOf(code, context), count: count(raw[code]) }))
    .sort((left, right) => stageOrderOf(left.code, context) - stageOrderOf(right.code, context))
}

/** overview 的下一步聚合（用于 aside 的计数，不重复逐条结论）。 */
export function summarizeNextSteps(
  rows: ReadonlyArray<{ readonly nextStep: NextStepView }>,
): { info: number; human: number; wait: number; missing: number } {
  let info = 0
  let human = 0
  let wait = 0
  let missing = 0
  for (const row of rows) {
    if (!row.nextStep.hasStep) missing += 1
    else if (row.nextStep.kind === 'HUMAN_ACTION') human += 1
    else if (row.nextStep.kind === 'WAIT') wait += 1
    else info += 1
  }
  return { info, human, wait, missing }
}

// =====================================================================
//  顶层归一化
// =====================================================================

/** 归一化 `GET /recruitment/api/recruiting/overview` 响应（坏类型只降级，不抛错）。 */
export function normalizeOverviewView(value: unknown): RecruitingOverviewView {
  const raw = record(value)
  const context = stageContextOf(raw.settings)
  const countsRaw = record(raw.counts)
  const actorRaw = record(raw.actor)
  const settings = normalizeSettings(raw.settings, context)
  const actions = normalizeActions(raw.actions)
  const applications = buildApplicationRows(raw.applications, context)
  const jobsRaw = items(raw.jobs)
  const jobs: JobView[] = []
  for (const item of jobsRaw) {
    if (Object.keys(record(item)).length === 0) continue
    jobs.push(buildJob(item, context))
  }
  // 展示顺序 = 默认选中顺序：OPEN 且申请最多的岗位排第一（演示主岗位不会被归档空岗位挤掉）。
  const sortedJobs = sortJobViews(jobs)
  return {
    contractVersion: text(raw.contract_version),
    configured: bool(raw.configured),
    issues: stringList(raw.issues),
    evaluatedAt: text(raw.evaluated_at),
    evaluatedAtText: formatDateTime(raw.evaluated_at),
    actor: {
      actorId: text(actorRaw.actor_id),
      displayName: text(actorRaw.display_name),
      roles: stringList(actorRaw.roles),
    },
    labels: normalizeThreeDimLabels(raw.labels),
    counts: {
      jobsTotal: count(countsRaw.jobs_total),
      jobsOpen: count(countsRaw.jobs_open),
      applicationsTotal: count(countsRaw.applications_total),
      applicationsActive: count(countsRaw.applications_active),
      awaitingScreening: count(countsRaw.awaiting_screening),
      interviewing: count(countsRaw.interviewing),
      awaitingDecision: count(countsRaw.awaiting_decision),
      interviewsScheduled: count(countsRaw.interviews_scheduled),
      scorecardsRequiredTotal: count(countsRaw.scorecards_required_total),
      scorecardsSubmittedTotal: count(countsRaw.scorecards_submitted_total),
      transcriptsReady: count(countsRaw.transcripts_ready),
      transcriptsPending: count(countsRaw.transcripts_pending),
      byStage: byStageRows(countsRaw.applications_by_stage, context),
    },
    jobs: sortedJobs,
    applications,
    settings,
    actions: actions.byKey,
    actionList: actions.list,
    nextStepTotals: summarizeNextSteps(applications),
  }
}

/** 归一化申请详情里的简历段。 */
function normalizeResumeDetail(value: unknown): ResumeView | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const material = normalizeMaterial(raw.material)
  if (material === null) return null
  const fields: ResumeFieldView[] = []
  for (const item of items(raw.fields)) {
    const entry = record(item)
    const key = text(entry.key) !== '' ? text(entry.key) : text(entry.field)
    if (key === '') continue
    fields.push({
      key,
      state: text(entry.state),
      provenance: text(entry.provenance),
      entryCount: numberOrNull(entry.entry_count),
      valuePreview: text(entry.value_preview),
    })
  }
  const workEntries: ResumeView['workEntries'][number][] = []
  for (const item of items(raw.work_entries)) {
    const entry = record(item)
    workEntries.push({
      company: text(entry.company),
      title: text(entry.title),
      start: text(entry.start),
      end: text(entry.end),
    })
  }
  const educationEntries: ResumeView['educationEntries'][number][] = []
  for (const item of items(raw.education_entries)) {
    const entry = record(item)
    educationEntries.push({ text: text(entry.text), start: text(entry.start), end: text(entry.end) })
  }
  const evidenceSamples: ResumeEvidenceView[] = []
  for (const item of items(raw.evidence_samples)) {
    const entry = record(item)
    const quote = text(entry.quote)
    if (quote === '') continue
    evidenceSamples.push({
      field: text(entry.field),
      page: numberOrNull(entry.page),
      quote,
      block: numberOrNull(entry.block),
    })
  }
  return { material, fields, workEntries, educationEntries, evidenceSamples }
}

/** 归一化 rubric 维度（详情用）。 */
function normalizeRubricDimensions(value: unknown): {
  versionNo: number
  approved: boolean
  dimensions: {
    key: string
    kind: string
    label: string
    weight: number | null
    operator: string
    valuePreview: string
    question: string
  }[]
} | null {
  if (value === null || value === undefined) return null
  const raw = record(value)
  const versionNo = count(raw.version_no)
  const approved = bool(raw.approved)
  const dimensions: {
    key: string
    kind: string
    label: string
    weight: number | null
    operator: string
    valuePreview: string
    question: string
  }[] = []
  for (const item of items(raw.dimensions)) {
    const entry = record(item)
    const key = text(entry.key)
    if (key === '') continue
    dimensions.push({
      key,
      kind: text(entry.kind),
      label: text(entry.label) !== '' ? text(entry.label) : key,
      weight: numberOrNull(entry.weight),
      operator: text(entry.operator),
      valuePreview: preview(entry.value),
      question: text(entry.question),
    })
  }
  if (versionNo === 0 && dimensions.length === 0) return null
  return { versionNo, approved, dimensions }
}

/** 归一化申请详情（`GET .../applications/:id`）。 */
export function normalizeApplicationDetail(value: unknown): ApplicationDetailView {
  const raw = record(value)
  const applicationRaw = record(raw.application)
  const header = buildApplicationHeader(applicationRaw)
  const progress = record(applicationRaw.progress)
  const interviews = buildInterviews(applicationRaw.interviews)
  const transcriptSummary = transcriptSummaryOf(progress.transcript_state)
  const actions = normalizeActions(raw.actions)
  const screeningEvidenceRaw = record(raw.screening_evidence)
  const decision = normalizeScreening(screeningEvidenceRaw.decision)
  const rubric = normalizeRubricDimensions(screeningEvidenceRaw.rubric)
  const basis: { kind: string; detailText: string }[] = []
  for (const item of items(screeningEvidenceRaw.basis)) {
    const entry = record(item)
    const kind = text(entry.kind)
    if (kind === '') continue
    basis.push({ kind, detailText: preview(entry.detail) })
  }
  const transcriptRuns: TranscriptRunView[] = []
  for (const item of items(raw.transcript_runs)) {
    const entry = record(item)
    const runId = text(entry.run_id)
    const artifactId = text(entry.artifact_id)
    if (runId === '' && artifactId === '') continue
    transcriptRuns.push({
      runId,
      artifactId,
      artifactIdText: shortSha(artifactId),
      status: text(entry.status),
      chunkTotal: count(entry.chunk_total),
      chunkSucceeded: count(entry.chunk_succeeded),
      chunkFailed: count(entry.chunk_failed),
      modelId: text(entry.model_id),
    })
  }
  const decisions: DecisionView[] = []
  for (const item of items(applicationRaw.decisions)) {
    const normalized = normalizeDecision(item)
    if (normalized !== null) decisions.push(normalized)
  }
  const timeline: TimelineEntryView[] = []
  for (const item of items(raw.timeline)) {
    const normalized = normalizeTimelineEntry(item)
    if (normalized !== null) timeline.push(normalized)
  }
  const actorRaw = record(raw.actor)
  return {
    contractVersion: text(raw.contract_version),
    evaluatedAt: text(raw.evaluated_at),
    evaluatedAtText: formatDateTime(raw.evaluated_at),
    actor: {
      actorId: text(actorRaw.actor_id),
      displayName: text(actorRaw.display_name),
      roles: stringList(actorRaw.roles),
    },
    labels: normalizeThreeDimLabels(raw.labels),
    header,
    nextStep: normalizeNextStep(progress.next_step),
    material: normalizeMaterial(applicationRaw.material),
    resume: normalizeResumeDetail(raw.resume),
    screeningEvidence: { decision, rubric, basis },
    interviews,
    scorecardProgress: buildScorecardProgress(progress),
    transcriptSummary: transcriptSummary.summary,
    transcriptTone: transcriptSummary.tone,
    transcriptRuns,
    decisions,
    timeline,
    actions: actions.byKey,
    actionList: actions.list,
  }
}

/** 归一化岗位详情（`GET .../jobs/:id`）。 */
export function normalizeJobDetail(value: unknown): JobDetailView {
  const raw = record(value)
  const job = buildJob(raw.job)
  const versions: JobDetailView['versions'][number][] = []
  for (const item of items(raw.versions)) {
    const entry = record(item)
    const id = text(entry.job_version_id)
    const versionNo = count(entry.version_no)
    if (id === '' && versionNo === 0) continue
    const payloadHash = text(entry.payload_hash)
    versions.push({
      id,
      versionNo,
      payloadHash,
      payloadHashText: shortSha(payloadHash),
      createdAt: text(entry.created_at),
      createdAtText: formatDateTime(entry.created_at),
      approved: bool(entry.approved),
    })
  }
  const rubricRaw = normalizeRubricDimensions(raw.rubric)
  // 岗位详情里的 rubric 段不带 approved（`ScreeningEvidenceDetail['rubric']`），
  // 是否批准是 `JobCard.rubric.approved` 的事实，这里从 job 卡合并，不另造。
  const rubric =
    rubricRaw === null
      ? null
      : { ...rubricRaw, approved: rubricRaw.approved || (job.rubric?.approved ?? false) }
  const applications = buildApplicationRows(raw.applications)
  const actions = normalizeActions(raw.actions)
  return {
    contractVersion: text(raw.contract_version),
    evaluatedAt: text(raw.evaluated_at),
    evaluatedAtText: formatDateTime(raw.evaluated_at),
    labels: normalizeThreeDimLabels(raw.labels),
    job,
    descriptionMd: text(raw.description_md),
    requirementsMd: text(raw.requirements_md),
    versions,
    rubric,
    applications,
    actions: actions.byKey,
    actionList: actions.list,
  }
}

/** 便于测试/调试：把视图模型里所有"下一步"文案收集出来（同一事项只应出现一次）。
 * 注意：`nextStep` 对象里的 `code`/`label` 各算一次；调用方通常分别计数。 */
export function collectNextSteps(view: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    const entry = node as Record<string, unknown>
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'nextStep') {
        const step = record(child)
        const label = text(step.label)
        if (label !== '') out.push(label)
        const code = text(step.code)
        if (code !== '') out.push(code)
        continue
      }
      visit(child)
    }
  }
  visit(view)
  return out
}
