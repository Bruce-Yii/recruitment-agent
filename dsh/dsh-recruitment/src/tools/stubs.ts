// Stub 数据（全部为合成样例，不含任何真实候选人资料 —— 铁律 R7）。
//
// 标注口径按 R4 三维正交：
//   provenance = FIXTURE     数据是造的，不是读来的
//   connection = NOT_CONNECTED 这些工具不连接数据库 / 不连接任何外部系统
//   trigger    = 不适用      由模型在会话中调用（Tool 调用，不是事件触发）
//
// 本文件只有常量：无 fs、无 net、无 DB 句柄、无 Date.now()。
// 时间戳写成固定字符串，保证同一入参永远返回同一结果（可复现）。

/** 所有 stub 输出共用的 provenance 值。 */
export const STUB_PROVENANCE = 'FIXTURE'

/** 简历块类型闭集。 */
export type ResumeBlockType = 'contact' | 'summary' | 'experience' | 'education' | 'skill'

/** 简历块类型清单（用于参数 enum）。 */
export const RESUME_BLOCK_TYPES: readonly ResumeBlockType[] = [
  'contact',
  'summary',
  'experience',
  'education',
  'skill',
]

/** 一个简历内容块。 */
export interface ResumeBlock {
  /** 在该简历内的稳定序号（从 0 开始，过滤后不重排）。 */
  readonly index: number
  /** 块类型。 */
  readonly type: ResumeBlockType
  /** 来源页码（1 起）。 */
  readonly page: number
  /** 块正文。 */
  readonly text: string
  /** 该块是否需要人工复核（OCR 来源一律 true，见 docs/09 §7.4）。 */
  readonly review_required: boolean
}

/** 一份简历的解析结果。 */
export interface ResumeRecord {
  readonly resume_id: string
  readonly file_name: string
  readonly media_type: string
  readonly pages: number
  readonly extraction: 'TEXT_LAYER' | 'OCR'
  readonly blocks: readonly ResumeBlock[]
}

/** 简历 stub 库。 */
export const RESUME_STUBS: Readonly<Record<string, ResumeRecord>> = {
  resume_0001: {
    resume_id: 'resume_0001',
    file_name: 'synthetic-text.pdf',
    media_type: 'application/pdf',
    pages: 2,
    extraction: 'TEXT_LAYER',
    blocks: [
      {
        index: 0,
        type: 'contact',
        page: 1,
        text: '张示例 / zhang.example@example.test / 138-0000-1234 / 上海',
        review_required: false,
      },
      {
        index: 1,
        type: 'summary',
        page: 1,
        text: '6 年后端经验，主语言 Go / Python，做过招聘域的任务队列与回调投递。',
        review_required: false,
      },
      {
        index: 2,
        type: 'experience',
        page: 1,
        text: '2021-2025 某示例科技 / 后端工程师：负责简历解析流水线与外部事件接入。',
        review_required: false,
      },
      {
        index: 3,
        type: 'experience',
        page: 2,
        text: '2019-2021 某示例网络 / 初级后端：维护内部求职者库与权限。',
        review_required: false,
      },
      {
        index: 4,
        type: 'education',
        page: 2,
        text: '2015-2019 示例大学 / 计算机科学与技术 / 本科',
        review_required: false,
      },
      {
        index: 5,
        type: 'skill',
        page: 2,
        text: 'Go, Python, PostgreSQL, 消息队列, 基本前端',
        review_required: false,
      },
    ],
  },
  resume_0002: {
    resume_id: 'resume_0002',
    file_name: 'synthetic-scan.pdf',
    media_type: 'application/pdf',
    pages: 1,
    extraction: 'OCR',
    blocks: [
      {
        index: 0,
        type: 'contact',
        page: 1,
        text: '李样例 / li.example@example.test / 139-0000-5678',
        review_required: true,
      },
      {
        index: 1,
        type: 'summary',
        page: 1,
        text: '4 年数据分析经验，熟悉指标体系与实验设计。',
        review_required: true,
      },
      {
        index: 2,
        type: 'skill',
        page: 1,
        text: 'SQL, Python, 数据可视化',
        review_required: true,
      },
    ],
  },
}

/** 候选人状态闭集。 */
export type CandidateStatus = 'ACTIVE' | 'ARCHIVED'

/** 候选人状态清单（用于输出 enum）。 */
export const CANDIDATE_STATUSES: readonly CandidateStatus[] = ['ACTIVE', 'ARCHIVED']

/** 申请阶段闭集。 */
export type ApplicationStage = 'APPLIED' | 'SCREENING' | 'INTERVIEW' | 'OFFER' | 'REJECTED'

/** 申请阶段清单（用于输出 enum）。 */
export const APPLICATION_STAGES: readonly ApplicationStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'REJECTED',
]

/** 一条候选人-岗位申请关系。 */
export interface ApplicationLink {
  readonly application_id: string
  readonly job_id: string
  readonly stage: ApplicationStage
}

/** 一个候选人档案。 */
export interface CandidateRecord {
  readonly candidate_id: string
  readonly display_name: string
  readonly status: CandidateStatus
  readonly email: string
  readonly phone: string
  readonly applications: readonly ApplicationLink[]
}

/** 候选人 stub 库。 */
export const CANDIDATE_STUBS: Readonly<Record<string, CandidateRecord>> = {
  candidate_0001: {
    candidate_id: 'candidate_0001',
    display_name: '张示例',
    status: 'ACTIVE',
    email: 'zhang.example@example.test',
    phone: '138-0000-1234',
    applications: [
      { application_id: 'application_0001', job_id: 'job_0001', stage: 'SCREENING' },
      { application_id: 'application_0002', job_id: 'job_0002', stage: 'APPLIED' },
    ],
  },
  candidate_0002: {
    candidate_id: 'candidate_0002',
    display_name: '李样例',
    status: 'ARCHIVED',
    email: 'li.example@example.test',
    phone: '139-0000-5678',
    applications: [{ application_id: 'application_0003', job_id: 'job_0002', stage: 'REJECTED' }],
  },
}

/** 岗位状态闭集。 */
export type JobStatus = 'OPEN' | 'PAUSED' | 'CLOSED'

/** 岗位状态清单（用于输出 enum）。 */
export const JOB_STATUSES: readonly JobStatus[] = ['OPEN', 'PAUSED', 'CLOSED']

/** Rubric 条目性质闭集。 */
export type CriterionKind = 'MUST_HAVE' | 'NICE_TO_HAVE' | 'DISQUALIFIER'

/** Rubric 条目性质清单（用于输出 enum）。 */
export const CRITERION_KINDS: readonly CriterionKind[] = [
  'MUST_HAVE',
  'NICE_TO_HAVE',
  'DISQUALIFIER',
]

/** 一条 Rubric 判据。 */
export interface Criterion {
  readonly key: string
  readonly label: string
  readonly kind: CriterionKind
  /** 权重，同一版本内求和为 1。 */
  readonly weight: number
}

/** 一个岗位及其 Rubric 版本。 */
export interface JobRecord {
  readonly job_id: string
  readonly title: string
  readonly status: JobStatus
  readonly location: string
  /** 当前生效版本。 */
  readonly current_rubric_version: string
  /** 版本号 -> 判据列表。 */
  readonly rubrics: Readonly<Record<string, readonly Criterion[]>>
}

/** 岗位 stub 库。 */
export const JOB_STUBS: Readonly<Record<string, JobRecord>> = {
  job_0001: {
    job_id: 'job_0001',
    title: '后端工程师（示例）',
    status: 'OPEN',
    location: '上海',
    current_rubric_version: 'v1',
    rubrics: {
      v1: [
        { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.5 },
        { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
        { key: 'frontend_basics', label: '基本前端能力', kind: 'NICE_TO_HAVE', weight: 0.2 },
      ],
      v2: [
        { key: 'backend_depth', label: '后端工程深度', kind: 'MUST_HAVE', weight: 0.45 },
        { key: 'async_pipeline', label: '异步/队列流水线经验', kind: 'MUST_HAVE', weight: 0.3 },
        { key: 'observability', label: '可观测性实践', kind: 'NICE_TO_HAVE', weight: 0.25 },
      ],
    },
  },
  job_0002: {
    job_id: 'job_0002',
    title: '数据平台工程师（示例）',
    status: 'PAUSED',
    location: '远程',
    current_rubric_version: 'v1',
    rubrics: {
      v1: [
        { key: 'sql_depth', label: 'SQL 与数仓建模', kind: 'MUST_HAVE', weight: 0.6 },
        { key: 'pipeline_ops', label: '数据管道运维', kind: 'NICE_TO_HAVE', weight: 0.4 },
      ],
    },
  },
}
