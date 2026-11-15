// 岗位 / Rubric 草案生成 —— **纯函数领域服务**（D5 joblife / task-51 A）。
//
// 三条不可协商的边界（独立验收项，任一条不成立即不算交付）：
//   1. **纯函数**：不连库、不发网络请求、不调模型、不读时间/随机数。同输入两次输出逐字节一致。
//   2. **不编造企业事实**：部门 / 人数 / 职级 / 地点 / 薪酬 / 预算 / 优先级 / 招聘原因没给就进
//      `missing_items`（带可直接问用户的问题文本），草案里**不出现**具体值；模板内容一律标
//      `TEMPLATE_LIBRARY`，用户原话标 `USER_INPUT`，部门/企业上下文标 `DEPARTMENT_CONTEXT`。
//   3. **可执行**：`rubric_draft.criteria` 必须满足 `contracts/job-screening/job-rubric-rules.md`
//      §6.2 的 `R-VAL-1..13`（复用 `validateDimensions`，不复制规则），Σweight=1（≤1e-6），
//      至少 1 条 `MUST_HAVE` 或 `DISQUALIFIER`；机械化字段只能用 §6.3 白名单
//      （`timeline.covered_months_closed` / `work_experience.entry_count` / `education.entry_count`
//      / `work_experience` / `education`），学历/行业/软技能一律判断型（`question`，且**没有**
//      `field`/`operator`/`value` 键，不写 `null`——见 §6.1 的单一裁决）。
//
// 人确认闸门：草案只产出 `confirmation.status='PENDING_HUMAN_CONFIRMATION'`，**零写入**；
// 建岗位 / 批标准仍必须由人走 `recruitment_job_create` / `recruitment_job_rubric_approve`。
//
// 为什么 domain 层 import `src/tools/screening-evaluate.ts::validateDimensions`：
// R-VAL 的**唯一实现**在那里（写入侧 `job-create.ts` 与读取侧 `screening-evaluate.ts` 共用它）。
// 在草案层复制一份规则 = 两套口径，迟早漂移；这里只调用、并把它返回的 violation 原样带进错误 detail。

import { validateDimensions } from '../tools/screening-evaluate.ts'

/** 草案契约版本（与工具输出 `contract_version` 同值）。 */
export const JOB_DRAFT_CONTRACT_VERSION = '1.0.0'

/** `request_text` 的最大长度（超出 → `INVALID_ARGS / REQUEST_TEXT_TOO_LONG`）。 */
export const MAX_REQUEST_TEXT_CHARS = 2000
/** `recruiter_supplement` 的最大长度。 */
export const MAX_SUPPLEMENT_CHARS = 2000
/** 历史输入最多条数（防止输出爆炸）。 */
export const MAX_HISTORY_ITEMS = 20
/** JD / 需求正文长度上限（与 `recruitment_job_create` 的 20000 一致）。 */
const MAX_JD_CHARS = 20_000

// ---------------------------------------------------------------------------
//  来源枚举（每条内容都必须说清"从哪来"，这是本服务的核心诚实性约束）
// ---------------------------------------------------------------------------

/** 来源枚举（封闭集；与工具 output schema 的 enum 同源）。 */
export const DRAFT_SOURCE_VALUES = [
  'USER_INPUT', // 用户原话（request_text / recruiter_supplement）
  'DEPARTMENT_CONTEXT', // 调用方给的企业/部门上下文
  'HISTORY', // 历史岗位 / 历史 Rubric（只作参考，不自动合并）
  'TEMPLATE_LIBRARY', // 代码内置模板库
  'DEFAULT_SUGGESTION', // 系统默认建议（跨岗位族的通用做法）
  'MISSING', // 缺失事实：只能提问，不能编造
] as const

/** 来源取值。 */
export type DraftSource = (typeof DRAFT_SOURCE_VALUES)[number]

/** criterion 的 kind（与 `CONTRACT.md` §5 / R-VAL-5 完全一致，不得新增）。 */
export const CRITERION_KIND_VALUES = ['MUST_HAVE', 'NICE_TO_HAVE', 'DISQUALIFIER'] as const

/** criterion 的 kind 取值。 */
export type CriterionKind = (typeof CRITERION_KIND_VALUES)[number]

/** criterion 的 operator（R-VAL-9 封闭集）。 */
export const CRITERION_OPERATOR_VALUES = ['EXISTS', 'GTE', 'LTE'] as const

/** criterion 的 operator 取值。 */
export type CriterionOperator = (typeof CRITERION_OPERATOR_VALUES)[number]

/** §6.3 白名单：数值型字段（可配 GTE / LTE）。 */
export const INTEGER_FIELD_VALUES = [
  'timeline.covered_months_closed',
  'work_experience.entry_count',
  'education.entry_count',
] as const

/** §6.3 白名单：布尔型字段（只能配 EXISTS，value 必须为 true）。 */
export const BOOLEAN_FIELD_VALUES = ['work_experience', 'education'] as const

// ---------------------------------------------------------------------------
//  错误
// ---------------------------------------------------------------------------

/** 草案层错误码（封闭集；tool 层统一映射成 `INVALID_ARGS`）。 */
export type JobDraftErrorReason =
  | 'ARGUMENTS_NOT_OBJECT'
  | 'UNKNOWN_PARAM'
  | 'TENANT_OR_ACTOR_NOT_ALLOWED'
  | 'REQUEST_TEXT_MISSING'
  | 'REQUEST_TEXT_TYPE'
  | 'REQUEST_TEXT_EMPTY'
  | 'REQUEST_TEXT_TOO_LONG'
  | 'SUPPLEMENT_TYPE'
  | 'SUPPLEMENT_TOO_LONG'
  | 'TEMPLATE_ID_TYPE'
  | 'TEMPLATE_ID_UNKNOWN'
  | 'TEMPLATE_UNRESOLVED'
  | 'CONTEXT_NOT_OBJECT'
  | 'CONTEXT_UNKNOWN_KEY'
  | 'CONTEXT_VALUE_INVALID'
  | 'HISTORY_NOT_ARRAY'
  | 'HISTORY_TOO_LARGE'
  | 'HISTORY_ITEM_INVALID'
  | 'HISTORY_UNKNOWN_KEY'
  | 'CRITERIA_INVALID'
  | 'JD_TOO_LONG'

/**
 * 草案领域错误。tool 层把它映射成 `Error: INVALID_ARGS: {...}`（`contractError`），
 * 这样模型/日志看到的仍是同一套 `<CODE>: <compact-json>` 风格。
 */
export class JobDraftError extends Error {
  /** 稳定错误码（与 tool-contracts 的顶层 code 对齐）。 */
  readonly code = 'INVALID_ARGS' as const
  /** 该 code 下的封闭 reason_code。 */
  readonly reason_code: JobDraftErrorReason
  /** 结构化明细（violations / allowed / 字段名等）；没有就省略这个键。 */
  readonly detail?: Record<string, unknown>

  /**
   * @param reason_code - 封闭 reason_code。
   * @param message - 一句给人看的说明。
   * @param detail - 可选结构化明细（不得用 null 占位）。
   */
  constructor(reason_code: JobDraftErrorReason, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'JobDraftError'
    this.reason_code = reason_code
    if (detail !== undefined) this.detail = detail
  }
}

// ---------------------------------------------------------------------------
//  输入类型（parseJobDraftInput 的产物；buildJobDraft 只接受这个形状）
// ---------------------------------------------------------------------------

/** 企业 / 部门上下文（调用方已掌握的事实；可缺）。 */
export interface DepartmentContext {
  /** 部门 UUID（有就优先用 id，避免重名歧义）。 */
  readonly department_id?: string
  /** 部门名称（1..200）。 */
  readonly department_name?: string
  /** 企业已定的工作地点。 */
  readonly location?: string
  /** 企业已定的职级 / 级别口径（如 P6、资深）。 */
  readonly level?: string
  /** 企业已定的薪酬区间（原样字符串）。 */
  readonly salary_range?: string
  /** 企业已定的人力预算。 */
  readonly budget?: string
  /** 计划招聘人数（1..10000）。 */
  readonly headcount?: number
  /** 招聘优先级（原样字符串，如 P0 / 急招）。 */
  readonly priority?: string
  /** 招聘原因（替换离职 / 新增编制 …）。 */
  readonly recruitment_reason?: string
}

/** 历史岗位（调用方从库里读出的摘要；只作参考）。 */
export interface HistoricalJob {
  readonly job_id?: string
  readonly title: string
  readonly code?: string
  readonly status?: string
  readonly department_name?: string
}

/** 历史 Rubric 的一条维度摘要（只取 key/label/kind/weight，不取判定逻辑）。 */
export interface HistoricalRubricDimension {
  readonly key: string
  readonly label?: string
  readonly kind?: CriterionKind
  readonly weight?: number
}

/** 历史 Rubric 版本摘要（只作参考，不自动合并）。 */
export interface HistoricalRubric {
  readonly job_id?: string
  readonly version_no?: number
  readonly dimensions?: readonly HistoricalRubricDimension[]
}

/** `buildJobDraft` 的入参（**已校验**的规范化形状）。 */
export interface JobDraftInput {
  /** 人话需求（必填，trim 后 1..2000）。 */
  readonly request_text: string
  /** 招聘人员补充说明（可选，≤2000）。 */
  readonly recruiter_supplement?: string
  /** 指定模板 id（可选；给了就必须在模板库里）。 */
  readonly template_id?: string
  /** 企业/部门上下文（可选）。 */
  readonly department_context?: DepartmentContext
  /** 历史岗位（可选）。 */
  readonly historical_jobs?: readonly HistoricalJob[]
  /** 历史 Rubric（可选）。 */
  readonly historical_rubrics?: readonly HistoricalRubric[]
}

// ---------------------------------------------------------------------------
//  模板库（代码内置结构；6 个岗位族，覆盖 后端/前端/数据/产品/测试/运维）
// ---------------------------------------------------------------------------

/**
 * 模板维度：criterion 的 9 键子集 + 模板元数据（reason / source / match_tags）。
 * `match_tags` 只用于把**用户原话**绑定到既有维度，不参与任何判定。
 */
export interface TemplateCriterion {
  readonly key: string
  readonly label: string
  readonly kind: CriterionKind
  readonly weight: number
  readonly field?: (typeof INTEGER_FIELD_VALUES)[number] | (typeof BOOLEAN_FIELD_VALUES)[number]
  readonly operator?: CriterionOperator
  readonly value?: boolean | number
  readonly question?: string
  readonly notes: string
  readonly reason: string
  readonly source: 'TEMPLATE_LIBRARY'
  readonly match_tags: readonly string[]
}

/** 模板里的一段文字（职责 / 成功画像 / 必备 / 加分）。 */
export interface TemplateTextItem {
  readonly text: string
  readonly reason: string
}

/** 模板轮次（每轮必须有 focus 与理由）。 */
export interface TemplateRound {
  readonly name: string
  readonly focus: readonly string[]
  /** 这一轮重点考察的 rubric 维度 key（必须存在，`validateDimensions` 之外的自检保证）。 */
  readonly criteria_keys: readonly string[]
  readonly reason: string
}

/** 模板评分表字段。 */
export interface TemplateScorecardField {
  readonly key: string
  readonly label: string
  readonly type: 'SCORE_1_5' | 'TEXT'
  readonly reason: string
}

/** 一个岗位族模板。 */
export interface JobTemplate {
  readonly template_id: string
  readonly family: string
  readonly label: string
  /** 选模板用的角色词（不是企业事实；命中即"这句话在说这个岗位族"）。 */
  readonly keywords: readonly string[]
  readonly responsibilities: readonly TemplateTextItem[]
  readonly success_profile: readonly TemplateTextItem[]
  readonly must_have: readonly TemplateTextItem[]
  readonly nice_to_have: readonly TemplateTextItem[]
  readonly rounds: readonly TemplateRound[]
  readonly scorecard_fields: readonly TemplateScorecardField[]
  readonly rubric_dimensions: readonly TemplateCriterion[]
}

/**
 * 代码内置模板库（≥5 个岗位族；每个含职责 / 成功画像 / 必备 / 加分 / 轮次+focus /
 * 评分表字段 / rubric 维度草案）。
 *
 * 模板内容是**行业通用做法**，不是任何一家企业的既定事实：所有条目在输出里都标
 * `TEMPLATE_LIBRARY`，并且每条必备/加分/学历/年限都会进 `missing_items` 请人确认。
 */
export const JOB_TEMPLATE_LIBRARY: readonly JobTemplate[] = [
  {
    template_id: 'backend_engineer',
    family: '后端',
    label: '后端工程师',
    keywords: ['后端', '服务端', 'backend', '后端开发', '服务端开发'],
    responsibilities: [
      { text: '负责核心业务后端服务的设计、开发、上线与维护', reason: '后端岗位族的通用职责（模板库）' },
      { text: '设计并维护接口、数据模型与关键业务流程', reason: '后端岗位族的通用职责（模板库）' },
      { text: '保障线上服务稳定性：监控、告警、故障定位与复盘', reason: '后端岗位族的通用职责（模板库）' },
      { text: '参与技术方案评审与代码评审，沉淀团队工程规范', reason: '后端岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立负责一个服务模块的完整交付（设计→上线→复盘）', reason: '以"可独立交付"作为成功画像的可观察标准（模板库）' },
      { text: '线上问题能独立定位并给出可复用的改进，不需要长期盯人', reason: '稳定性责任的可观察标准（模板库）' },
      { text: '与产品/前端/测试形成稳定协作节奏，需求交付可预测', reason: '跨角色协作的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '熟悉至少一门主流后端语言（如 Java / Go / Python），能写出可维护的服务代码', reason: '后端岗位族的基础必备项（模板库）' },
      { text: '有可验证的后端服务开发经历（能说明负责过的服务、职责与技术栈）', reason: '必备项必须可核验（模板库）' },
      { text: '具备基础的数据模型与接口设计能力', reason: '后端岗位族的基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有高并发或分布式系统的设计/演进经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
      { text: '有可查证的开源贡献', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '技术初面（编码与基础）',
        focus: ['编码能力（现场或离线题）', '语言与计算机基础', '调试与问题定位'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'backend_skill'],
        reason: '第一轮先验证基础能力与经历真实性（模板库）',
      },
      {
        name: '技术复面（系统设计与项目深挖）',
        focus: ['项目职责与产出核实', '系统设计取舍', '数据模型与接口设计'],
        criteria_keys: ['backend_skill', 'database_design', 'work_history_present', 'months_of_experience'],
        reason: '第二轮验证深度与设计能力，项目深挖用于核对经历真实性（模板库）',
      },
      {
        name: '交叉面（协作与工程规范）',
        focus: ['跨角色协作方式', '工程规范与代码评审', '风险与质量意识'],
        criteria_keys: ['database_design', 'big_company_experience'],
        reason: '交叉面覆盖协作与工程习惯（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'coding', label: '编码能力', type: 'SCORE_1_5', reason: '后端岗位族评分表字段（模板库）' },
      { key: 'system_design', label: '系统设计', type: 'SCORE_1_5', reason: '后端岗位族评分表字段（模板库）' },
      { key: 'engineering', label: '工程规范与质量意识', type: 'SCORE_1_5', reason: '后端岗位族评分表字段（模板库）' },
      { key: 'ownership', label: '责任担当与推进', type: 'SCORE_1_5', reason: '后端岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '后端岗位族模板默认：3 年以上相关经验（可由人修改）',
        source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.15,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"（§6.3 的 EXISTS 语义），不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'backend_skill', label: '具备可验证的后端服务开发经验', kind: 'MUST_HAVE', weight: 0.25,
        question: '候选人是否具备可验证的后端服务开发经验（能说明具体服务、职责与技术栈）？',
        notes: '判断型：技术与经历匹配由人判断，不做关键词命中',
        reason: '后端岗位族核心能力，模板默认；不可机械化', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'database_design', label: '具备数据模型/接口设计经验', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否具备数据库表结构或接口设计经验？',
        notes: '判断型：设计能力的判断由面评人给出',
        reason: '后端岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把"公司名"做成机械化筛选（会变成身份/背景筛选）',
        reason: '后端岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
  {
    template_id: 'frontend_engineer',
    family: '前端',
    label: '前端工程师',
    keywords: ['前端', 'frontend', 'web前端', '前端开发'],
    responsibilities: [
      { text: '负责业务前端页面的设计、开发与上线，对交互与体验负责', reason: '前端岗位族的通用职责（模板库）' },
      { text: '维护前端工程链路（构建、发布、监控）与公共组件', reason: '前端岗位族的通用职责（模板库）' },
      { text: '与产品/设计/后端协作，把需求拆成可交付的前端方案', reason: '前端岗位族的通用职责（模板库）' },
      { text: '关注页面性能与可访问性，持续优化用户体验', reason: '前端岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立负责一个业务页面或模块的完整交付', reason: '以"可独立交付"作为成功画像（模板库）' },
      { text: '能把设计稿落成稳定页面，并主动处理性能与兼容性问题', reason: '前端质量的可观察标准（模板库）' },
      { text: '与设计/后端建立稳定的联调与发布节奏', reason: '跨角色协作的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '熟悉 JavaScript/TypeScript 与至少一个主流前端框架（如 React / Vue）', reason: '前端岗位族基础必备项（模板库）' },
      { text: '有可验证的前端项目经历（能说明页面复杂度、职责与产出）', reason: '必备项必须可核验（模板库）' },
      { text: '具备基本的工程化能力（构建、调试、发布流程）', reason: '前端岗位族基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有前端性能优化或可访问性实践经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '技术初面（前端基础与编码）',
        focus: ['JavaScript/浏览器基础', '编码与调试', '项目经历核实'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'frontend_skill'],
        reason: '第一轮验证基础与经历真实性（模板库）',
      },
      {
        name: '技术复面（工程化与设计）',
        focus: ['框架原理与工程化', '组件与状态设计', '性能与质量'],
        criteria_keys: ['frontend_skill', 'engineering_practices', 'months_of_experience'],
        reason: '第二轮验证工程化与方案设计能力（模板库）',
      },
      {
        name: '交叉面（产品理解与协作）',
        focus: ['需求理解与拆解', '与设计/后端协作', '交付节奏'],
        criteria_keys: ['engineering_practices', 'big_company_experience'],
        reason: '交叉面覆盖协作与产品理解（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'coding', label: '编码与前端基础', type: 'SCORE_1_5', reason: '前端岗位族评分表字段（模板库）' },
      { key: 'engineering', label: '工程化能力', type: 'SCORE_1_5', reason: '前端岗位族评分表字段（模板库）' },
      { key: 'product_sense', label: '产品与体验理解', type: 'SCORE_1_5', reason: '前端岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '前端岗位族模板默认：3 年以上相关经验（可由人修改）', source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.1,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"，不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'frontend_skill', label: '具备可验证的前端开发能力', kind: 'MUST_HAVE', weight: 0.3,
        question: '候选人是否具备可验证的前端开发能力（能说明页面复杂度、职责与技术栈）？',
        notes: '判断型：前端能力由面评人判断，不做关键词命中',
        reason: '前端岗位族核心能力（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'engineering_practices', label: '具备前端工程化实践', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否具备构建、发布、调试等前端工程化实践？',
        notes: '判断型：工程化程度由人判断',
        reason: '前端岗位族必备项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把公司名做成机械化筛选',
        reason: '前端岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.1,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
  {
    template_id: 'data_engineer',
    family: '数据',
    label: '数据工程师',
    keywords: ['数据', '数据分析', '数据开发', '数仓', '数据工程', 'bi'],
    responsibilities: [
      { text: '负责业务数据链路的建设与维护（采集、清洗、建模、产出）', reason: '数据岗位族的通用职责（模板库）' },
      { text: '设计并维护指标口径与数据模型，保证数据可解释可复用', reason: '数据岗位族的通用职责（模板库）' },
      { text: '为业务方提供可靠的数据支持与自助分析能力', reason: '数据岗位族的通用职责（模板库）' },
      { text: '保障数据质量：校验、监控、异常归因与修复', reason: '数据岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立交付一条业务数据链路或指标体系', reason: '以"可独立交付"作为成功画像（模板库）' },
      { text: '业务方能自助取数，口径争议显著减少', reason: '数据质量与可用性的可观察标准（模板库）' },
      { text: '数据问题能在承诺时间内定位并给出根因', reason: '数据责任的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '熟练使用 SQL，能独立完成取数、对账与口径核对', reason: '数据岗位族基础必备项（模板库）' },
      { text: '有可验证的数据开发/分析经历（能说明链路、口径与产出）', reason: '必备项必须可核验（模板库）' },
      { text: '具备基础的数据建模能力（维度/指标/分层）', reason: '数据岗位族基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有数仓/湖仓或实时数据链路经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '技术初面（SQL 与数据基础）',
        focus: ['SQL 能力（现场或离线）', '数据模型基础', '项目经历核实'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'data_skill'],
        reason: '第一轮验证基础与经历真实性（模板库）',
      },
      {
        name: '技术复面（建模与链路）',
        focus: ['数仓/指标建模', '数据链路与质量保障', '性能与成本'],
        criteria_keys: ['data_skill', 'sql_modeling', 'months_of_experience'],
        reason: '第二轮验证建模与链路能力（模板库）',
      },
      {
        name: '业务面（理解与协作）',
        focus: ['业务理解与需求拆解', '与业务方协作方式', '数据结果的可解释性'],
        criteria_keys: ['sql_modeling', 'big_company_experience'],
        reason: '业务面覆盖理解与协作（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'sql', label: 'SQL 与数据处理', type: 'SCORE_1_5', reason: '数据岗位族评分表字段（模板库）' },
      { key: 'modeling', label: '数据建模', type: 'SCORE_1_5', reason: '数据岗位族评分表字段（模板库）' },
      { key: 'business', label: '业务理解', type: 'SCORE_1_5', reason: '数据岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '数据岗位族模板默认：3 年以上相关经验（可由人修改）', source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.1,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"，不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'data_skill', label: '具备可验证的数据开发/分析能力', kind: 'MUST_HAVE', weight: 0.3,
        question: '候选人是否具备可验证的数据开发或数据分析能力（能说明链路、口径与产出）？',
        notes: '判断型：数据能力由面评人判断',
        reason: '数据岗位族核心能力（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'sql_modeling', label: '具备数据建模能力', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否具备维度/指标/分层的数据建模能力？',
        notes: '判断型：建模能力由人判断',
        reason: '数据岗位族必备项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把公司名做成机械化筛选',
        reason: '数据岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.1,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
  {
    template_id: 'product_manager',
    family: '产品',
    label: '产品经理',
    keywords: ['产品', '产品经理', 'pm'],
    responsibilities: [
      { text: '负责业务方向的需求调研、方案设计与版本落地', reason: '产品岗位族的通用职责（模板库）' },
      { text: '与研发/设计/运营协作，推动方案按期交付并复盘结果', reason: '产品岗位族的通用职责（模板库）' },
      { text: '维护需求优先级与路线图，做清晰的取舍与沟通', reason: '产品岗位族的通用职责（模板库）' },
      { text: '用数据与用户反馈验证判断，持续迭代方案', reason: '产品岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立负责一个业务方向的需求与版本节奏', reason: '以"可独立负责"作为成功画像（模板库）' },
      { text: '方案落地后有可量化的结果或明确的经验复盘', reason: '产品结果的可观察标准（模板库）' },
      { text: '与研发/设计/运营形成稳定的协作与决策机制', reason: '跨角色协作的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '有可验证的产品需求设计与版本落地经历（能说明背景、方案与结果）', reason: '产品岗位族基础必备项（模板库）' },
      { text: '具备需求拆解与优先级取舍能力', reason: '产品岗位族基础必备项（模板库）' },
      { text: '能用数据或用户反馈验证方案效果', reason: '产品岗位族基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有从 0 到 1 或快速增长业务的产品经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '产品初面（案例与需求拆解）',
        focus: ['案例讲述与背景澄清', '需求拆解与优先级', '项目经历核实'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'product_skill'],
        reason: '第一轮验证产品基本功与经历真实性（模板库）',
      },
      {
        name: '产品复面（策略与取舍）',
        focus: ['业务理解与策略', '关键取舍与风险', '结果与复盘'],
        criteria_keys: ['product_skill', 'data_driven', 'months_of_experience'],
        reason: '第二轮验证判断力与结果意识（模板库）',
      },
      {
        name: '交叉面（协作与推动）',
        focus: ['跨团队推动方式', '与研发/设计的协作', '冲突处理'],
        criteria_keys: ['data_driven', 'big_company_experience'],
        reason: '交叉面覆盖协作与推动能力（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'requirement', label: '需求分析', type: 'SCORE_1_5', reason: '产品岗位族评分表字段（模板库）' },
      { key: 'solution', label: '方案设计', type: 'SCORE_1_5', reason: '产品岗位族评分表字段（模板库）' },
      { key: 'result', label: '数据与结果', type: 'SCORE_1_5', reason: '产品岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '产品岗位族模板默认：3 年以上相关经验（可由人修改）', source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.1,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"，不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'product_skill', label: '具备可验证的产品能力', kind: 'MUST_HAVE', weight: 0.3,
        question: '候选人是否具备可验证的产品能力（能说明负责过的需求、方案与结果）？',
        notes: '判断型：产品能力由面评人判断',
        reason: '产品岗位族核心能力（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'data_driven', label: '具备数据驱动的判断能力', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否能用数据或用户反馈验证自己的产品判断？',
        notes: '判断型：判断质量由人评估',
        reason: '产品岗位族必备项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把公司名做成机械化筛选',
        reason: '产品岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.1,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
  {
    template_id: 'qa_engineer',
    family: '测试',
    label: '测试工程师',
    keywords: ['测试', '测试工程师', '测试开发', 'qa', '质量保障'],
    responsibilities: [
      { text: '负责业务版本的质量保障：测试设计、执行与发布把关', reason: '测试岗位族的通用职责（模板库）' },
      { text: '设计并维护用例与测试数据，保证可回归、可复用', reason: '测试岗位族的通用职责（模板库）' },
      { text: '推动问题闭环：缺陷跟踪、根因分析与改进', reason: '测试岗位族的通用职责（模板库）' },
      { text: '建设或使用自动化测试，提升回归效率', reason: '测试岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立负责一个业务版本的质量把关', reason: '以"可独立负责"作为成功画像（模板库）' },
      { text: '关键缺陷能在发布前被拦截，且回归成本可控', reason: '质量结果的可观察标准（模板库）' },
      { text: '与研发/产品形成稳定的问题闭环机制', reason: '跨角色协作的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '有可验证的测试设计与执行经历（能说明范围、策略与产出）', reason: '测试岗位族基础必备项（模板库）' },
      { text: '能独立设计覆盖关键路径的测试用例', reason: '测试岗位族基础必备项（模板库）' },
      { text: '具备缺陷定位与问题闭环能力', reason: '测试岗位族基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有自动化/性能测试经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '技术初面（测试基础与用例设计）',
        focus: ['测试用例设计', '测试基础与问题定位', '项目经历核实'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'testing_skill'],
        reason: '第一轮验证测试基本功与经历真实性（模板库）',
      },
      {
        name: '技术复面（自动化与质量体系）',
        focus: ['自动化测试实践', '质量流程与度量', '风险识别'],
        criteria_keys: ['testing_skill', 'automation', 'months_of_experience'],
        reason: '第二轮验证工程化与质量体系建设能力（模板库）',
      },
      {
        name: '交叉面（协作与质量意识）',
        focus: ['与研发/产品协作', '发布把关与风险沟通', '质量文化'],
        criteria_keys: ['automation', 'big_company_experience'],
        reason: '交叉面覆盖协作与质量意识（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'test_design', label: '测试设计与执行', type: 'SCORE_1_5', reason: '测试岗位族评分表字段（模板库）' },
      { key: 'automation', label: '自动化与工程能力', type: 'SCORE_1_5', reason: '测试岗位族评分表字段（模板库）' },
      { key: 'quality_awareness', label: '质量意识与风险沟通', type: 'SCORE_1_5', reason: '测试岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '测试岗位族模板默认：3 年以上相关经验（可由人修改）', source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.1,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"，不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'testing_skill', label: '具备可验证的测试能力', kind: 'MUST_HAVE', weight: 0.3,
        question: '候选人是否具备可验证的测试设计与执行能力（能说明范围、策略与产出）？',
        notes: '判断型：测试能力由面评人判断',
        reason: '测试岗位族核心能力（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'automation', label: '具备自动化测试实践', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否有自动化测试的设计或落地经验？',
        notes: '判断型：自动化程度由人判断',
        reason: '测试岗位族必备项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把公司名做成机械化筛选',
        reason: '测试岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.1,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
  {
    template_id: 'devops_engineer',
    family: '运维',
    label: '运维/SRE 工程师',
    keywords: ['运维', 'sre', 'devops', '系统运维', '基础设施'],
    responsibilities: [
      { text: '负责业务系统的部署、监控、容量与稳定性', reason: '运维岗位族的通用职责（模板库）' },
      { text: '建设与维护 CI/CD、配置与基础设施自动化', reason: '运维岗位族的通用职责（模板库）' },
      { text: '处理线上故障并推动根因修复与演练', reason: '运维岗位族的通用职责（模板库）' },
      { text: '参与容量规划与成本优化，保障可扩展性', reason: '运维岗位族的通用职责（模板库）' },
    ],
    success_profile: [
      { text: '入职 6 个月内能独立负责一个业务系统的稳定性与发布链路', reason: '以"可独立负责"作为成功画像（模板库）' },
      { text: '故障恢复时间与重复故障率有可观察的改善', reason: '稳定性结果的可观察标准（模板库）' },
      { text: '研发能自助使用发布与监控能力，运维不成为瓶颈', reason: '平台化能力的可观察标准（模板库）' },
    ],
    must_have: [
      { text: '熟悉 Linux 与网络基础，能独立排查系统层问题', reason: '运维岗位族基础必备项（模板库）' },
      { text: '有可验证的部署/监控/故障处理经历', reason: '必备项必须可核验（模板库）' },
      { text: '具备脚本或自动化能力（Shell/Python 等）', reason: '运维岗位族基础必备项（模板库）' },
    ],
    nice_to_have: [
      { text: '有容器/K8s 或云平台实践经验', reason: '加分项（模板库）' },
      { text: '有知名互联网/大型科技公司经历', reason: '加分项（模板库）' },
    ],
    rounds: [
      {
        name: '技术初面（系统与网络基础）',
        focus: ['Linux 与网络基础', '故障排查思路', '项目经历核实'],
        criteria_keys: ['months_of_experience', 'work_history_present', 'linux_networking'],
        reason: '第一轮验证系统基础与经历真实性（模板库）',
      },
      {
        name: '技术复面（稳定性与自动化）',
        focus: ['稳定性建设与演练', '自动化/平台化', '容量与成本'],
        criteria_keys: ['linux_networking', 'reliability_practice', 'months_of_experience'],
        reason: '第二轮验证稳定性工程能力（模板库）',
      },
      {
        name: '交叉面（协作与风险沟通）',
        focus: ['与研发协作方式', '变更与风险管理', '故障沟通'],
        criteria_keys: ['reliability_practice', 'big_company_experience'],
        reason: '交叉面覆盖协作与风险沟通（模板库）',
      },
    ],
    scorecard_fields: [
      { key: 'systems', label: '系统与网络基础', type: 'SCORE_1_5', reason: '运维岗位族评分表字段（模板库）' },
      { key: 'reliability', label: '稳定性与故障处理', type: 'SCORE_1_5', reason: '运维岗位族评分表字段（模板库）' },
      { key: 'automation', label: '自动化与平台化', type: 'SCORE_1_5', reason: '运维岗位族评分表字段（模板库）' },
      { key: 'summary', label: '综合评价', type: 'TEXT', reason: '所有岗位都需要一段综合结论（模板库）' },
    ],
    rubric_dimensions: [
      {
        key: 'months_of_experience', label: '相关工作经验 ≥ 3 年', kind: 'MUST_HAVE', weight: 0.25,
        field: 'timeline.covered_months_closed', operator: 'GTE', value: 36,
        notes: '按时间线可复算（5 年 = 60 个月）；年限来自模板默认，需人确认',
        reason: '运维岗位族模板默认：3 年以上相关经验（可由人修改）', source: 'TEMPLATE_LIBRARY', match_tags: ['年限', '年经验', '工作经验'],
      },
      {
        key: 'work_history_present', label: '有可分割的工作经历', kind: 'MUST_HAVE', weight: 0.1,
        field: 'work_experience', operator: 'EXISTS', value: true,
        notes: '只证明"简历里读到了工作经历条目"，不代表经历质量',
        reason: '筛选需要可核对的经历载体（机械字段白名单）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'linux_networking', label: '具备 Linux 与网络排障能力', kind: 'MUST_HAVE', weight: 0.3,
        question: '候选人是否具备 Linux 与网络基础、并能独立排查系统层问题？',
        notes: '判断型：系统能力由面评人判断',
        reason: '运维岗位族核心能力（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'reliability_practice', label: '具备稳定性建设实践', kind: 'MUST_HAVE', weight: 0.15,
        question: '候选人是否有监控、容量、故障演练等稳定性建设经验？',
        notes: '判断型：稳定性工程深度由人判断',
        reason: '运维岗位族必备项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: [],
      },
      {
        key: 'big_company_experience', label: '有知名互联网/大型科技公司经历', kind: 'NICE_TO_HAVE', weight: 0.1,
        question: '候选人是否有知名互联网或大型科技公司的工作经历？',
        notes: '判断型：不把公司名做成机械化筛选',
        reason: '运维岗位族加分项（模板库）', source: 'TEMPLATE_LIBRARY', match_tags: ['大厂', '知名', '头部'],
      },
      {
        key: 'education_level', label: '本科及以上学历', kind: 'MUST_HAVE', weight: 0.1,
        question: '候选人是否具备本科及以上学历？',
        notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        reason: '模板默认学历口径（本科及以上），需企业确认', source: 'TEMPLATE_LIBRARY', match_tags: ['本科', '硕士', '博士', '学历'],
      },
    ],
  },
]

// ---------------------------------------------------------------------------
//  用户原话 → 既有维度 / 新增判断型维度 的确定性映射
// ---------------------------------------------------------------------------

/** 用户补充要求（模板库未覆盖时）可派生出的判断型维度；**绝不**派生机械判定。 */
interface DerivedJudgmentRule {
  readonly tags: readonly string[]
  readonly key: string
  readonly label: string
  readonly question: string
  readonly notes: string
}

const DERIVED_JUDGMENT_RULES: readonly DerivedJudgmentRule[] = [
  {
    tags: ['高并发', '分布式'],
    key: 'distributed_systems',
    label: '有高并发/分布式系统经验',
    question: '候选人是否有高并发或分布式系统的设计与演进经验？',
    notes: '判断型：由用户补充要求派生，判定口径需人确认',
  },
  {
    tags: ['团队管理', '带团队', '管理经验', 'leader'],
    key: 'leadership',
    label: '有团队管理经验',
    question: '候选人是否有直接管理团队的经历（可说明团队规模与时长）？',
    notes: '判断型：由用户补充要求派生，判定口径需人确认',
  },
  {
    tags: ['英语', '英文'],
    key: 'english_skill',
    label: '具备工作场景英语能力',
    question: '候选人是否具备工作场景的英语沟通能力？',
    notes: '判断型：由用户补充要求派生，判定口径需人确认',
  },
  {
    tags: ['开源'],
    key: 'open_source',
    label: '有可查证的开源贡献',
    question: '候选人是否有可查证的开源项目贡献？',
    notes: '判断型：由用户补充要求派生，判定口径需人确认',
  },
  {
    tags: ['支付', '金融', '电商', 'saas', '社交', '医疗', '教育'],
    key: 'domain_experience',
    label: '有目标行业/业务领域经验',
    question: '候选人是否有与目标行业或业务领域相关的经验？',
    notes: '判断型：由用户补充要求派生，判定口径需人确认',
  },
]

// ---------------------------------------------------------------------------
//  文本提取（全部是保守的正则；只认"用户明说了"的事实，不推断）
// ---------------------------------------------------------------------------

/** 城市清单（保守：只认清单内的城市名；清单外不推断地点）。 */
const CITY_LIST: readonly string[] = [
  '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州',
  '长沙', '郑州', '重庆', '天津', '青岛', '合肥', '厦门', '福州', '济南', '东莞',
  '珠海', '香港', '新加坡', '远程',
]

/** 需要忽略的"泛化部门词"（不是真实部门名，不能当企业事实）。 */
const GENERIC_DEPARTMENT_WORDS: readonly string[] = [
  '业务部门', '相关部门', '该部门', '用人部门', '各部门', '部门', '团队', '业务团队', '跨部门',
]

/** 年份下限模式：group1 一律是"下限年数"。 */
const YEARS_PATTERNS: readonly RegExp[] = [
  /(\d{1,2})\s*[-~～—至]\s*\d{1,2}\s*年(?:以上)?(?:的)?(?:相关)?(?:工作)?经验/,
  /(?:至少|不少于|不低于)\s*(\d{1,2})\s*年(?:以上)?(?:的)?(?:相关)?(?:工作)?经验/,
  /(\d{1,2})\s*年(?:以上|及以上)\s*(?:的)?(?:相关)?(?:工作)?经验/,
  /(\d{1,2})\s*年(?:以上|及以上)/,
]

/** "经验不限 / 应届" 模式。 */
const EXPERIENCE_UNLIMITED_RE = /(经验不限|不限经验|应届生|应届|无经验要求)/

/** 学历模式（按包含关系取最先出现的词）。 */
const EDUCATION_WORDS: readonly string[] = ['博士', '硕士', '本科', '大专']

/** "学历不限" 模式。 */
const EDUCATION_UNLIMITED_RE = /(学历不限|不限学历)/

/** 薪酬区间模式（按顺序取第一个命中；value 是用户原话片段，不改写）。 */
const SALARY_PATTERNS: readonly RegExp[] = [
  /(?:月薪|年薪|薪资|薪酬|待遇)\s*[:：]?\s*((?:\d+(?:\.\d+)?\s*[kK万])(?:\s*[-~～—至]\s*\d+(?:\.\d+)?\s*[kK万])?(?:\s*[×xX*]\s*\d{1,2}\s*薪)?)/,
  /(\d+(?:\.\d+)?\s*[kK]\s*[-~～—至]\s*\d+(?:\.\d+)?\s*[kK])/,
  /(\d+(?:\.\d+)?\s*万\s*[-~～—至]\s*\d+(?:\.\d+)?\s*万)/,
  /(\d{1,3}\s*[-~～—至]\s*\d{1,3}\s*[kK])/,
  /(\d+(?:\.\d+)?\s*[kK])/,
  /(\d+(?:\.\d+)?\s*万)/,
]

/** 人数模式（只认"数字+名/人/位"或 hc/headcount）。 */
const HEADCOUNT_PATTERNS: readonly RegExp[] = [
  /(\d{1,3})\s*(?:名|人|位)/,
  /(?:hc|headcount)\s*[:：]?\s*(\d{1,3})/i,
]

/** 优先级模式（保守：不把"…优先"的加分项当优先级）。 */
const PRIORITY_RE = /(急招|紧急招聘|最高优先级|高优先级|P0|P1)/i

/** 招聘原因模式（取用户原话片段，不解释成别的词）。 */
const RECRUITMENT_REASON_PATTERNS: readonly RegExp[] = [
  /(离职|替换|替补|补招)/,
  /(业务扩张|扩张|扩编|新增编制|新增岗位|新业务)/,
]

/** 工作地点：城市清单里最早出现的那个。 */
const DOMAIN_RE = /(?:做|负责|建设|搭建|承接|支持|从事)[\s，,]{0,3}([\u4e00-\u9fa5A-Za-z0-9]{2,30}?)(系统|平台|业务|产品线|方向|项目)/

/** 部门名（必须带组织后缀；泛化词会被过滤）。 */
const DEPARTMENT_RE = /([\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:事业部|部门|中心|团队|部))/

/** 职级模式（P/M/L 序列 + 常见中文级别词；"负责人"不进，避免与项目负责人混淆）。 */
const LEVEL_CODE_RE = /(P\d{1,2}|M\d{1,2}|L\d(?:\.\d)?)/i
const LEVEL_WORD_RE = /(高级|资深|初级|中级|专家|总监)/

/** 标题里的级别前缀（如"高级后端工程师"）。 */
const LEVEL_PREFIX_RE = /(高级|资深|初级|中级|专家|总监)\s*(后端|前端|数据|产品|测试|运维)/

/** 加分项原话模式。 */
const NICE_PATTERNS: readonly RegExp[] = [
  /(?:最好|优先考虑|希望)(?:是|有|能|会|具备)?\s*([\u4e00-\u9fa5A-Za-z0-9+#/.]{2,30})/,
  /([\u4e00-\u9fa5A-Za-z0-9+#/.]{2,30}?)(?:者)?优先/,
  /加分(?:项)?\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9+#/.]{2,30})/,
]

/** 必备项原话模式。 */
const MUST_PATTERNS: readonly RegExp[] = [
  /(?:必须|务必)(?:要|具备|有|是)?\s*([\u4e00-\u9fa5A-Za-z0-9+#/.]{2,30})/,
  /(?:要求|需要)(?:具备|有|熟悉|精通)?\s*([\u4e00-\u9fa5A-Za-z0-9+#/.]{2,30})/,
]

/** criterion key 的封闭正则（R-VAL-3）。 */
const CRITERION_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/
/** criterion kind 的封闭集。 */
const CRITERION_KIND_SET: ReadonlySet<string> = new Set(CRITERION_KIND_VALUES)
/** operator 的封闭集。 */
const CRITERION_OPERATOR_SET: ReadonlySet<string> = new Set(CRITERION_OPERATOR_VALUES)
/** 白名单字段（§6.3 A + B）。 */
const WHITELIST_FIELD_SET: ReadonlySet<string> = new Set([
  ...INTEGER_FIELD_VALUES,
  ...BOOLEAN_FIELD_VALUES,
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 是否是普通 JSON 对象（不是数组 / null）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 关键字命中（英文关键字按词边界，中文按包含）。 */
function keywordHit(text: string, keyword: string): boolean {
  if (/^[a-z0-9]+$/i.test(keyword)) {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(text)
  }
  return text.includes(keyword)
}

/** 取第一个命中模式的 group1（都不命中返回 undefined）。 */
function firstGroup(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match !== null && typeof match[1] === 'string' && match[1].trim() !== '') return match[1].trim()
  }
  return undefined
}

/** 把原话片段清理成"要求文本"（去首尾标点与常见动词前缀）。 */
function normalizeRequirementText(raw: string): string {
  let text = raw.trim().replace(/^[，,。；;、:：\s]+/, '').replace(/[，,。；;、:：\s]+$/, '')
  text = text.replace(/^(?:有|具备|熟悉|精通|能|会)/, '')
  return text.trim()
}

// ---------------------------------------------------------------------------
//  输入解析（工具层边界校验的 domain 侧唯一实现）
// ---------------------------------------------------------------------------

const ROOT_KEYS: readonly string[] = [
  'request_text', 'recruiter_supplement', 'template_id', 'department_context', 'historical_jobs', 'historical_rubrics',
]
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['tenant_id', 'actor_id'])
const CONTEXT_KEYS: readonly string[] = [
  'department_id', 'department_name', 'location', 'level', 'salary_range', 'budget', 'headcount',
  'priority', 'recruitment_reason',
]
const HISTORY_JOB_KEYS: readonly string[] = ['job_id', 'title', 'code', 'status', 'department_name']
const HISTORY_RUBRIC_KEYS: readonly string[] = ['job_id', 'version_no', 'dimensions']
const HISTORY_DIMENSION_KEYS: readonly string[] = ['key', 'label', 'kind', 'weight']

/** 短字符串字段的上限（用于上下文与历史摘要）。 */
function readShortString(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new JobDraftError('CONTEXT_VALUE_INVALID', `${field} 必须是字符串`, { field, got_type: typeof value })
  }
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > maxLength) {
    throw new JobDraftError('CONTEXT_VALUE_INVALID', `${field} 超过 ${maxLength} 字符`, { field, length: trimmed.length })
  }
  return trimmed
}

/**
 * 校验并归一化模型入参（**封闭键集**：未知键一律拒绝，`tenant_id` / `actor_id` 明确禁止）。
 * @param raw - 模型给的 arguments（未校验）。
 * @returns 规范化后的 `JobDraftInput`。
 * @throws JobDraftError - 任一违反即抛（tool 层映射成 `INVALID_ARGS`）。
 */
export function parseJobDraftInput(raw: unknown): JobDraftInput {
  if (!isPlainObject(raw)) {
    throw new JobDraftError('ARGUMENTS_NOT_OBJECT', 'arguments 必须是 JSON 对象')
  }
  const unknownKeys = Object.keys(raw).filter((key) => !ROOT_KEYS.includes(key)).sort()
  if (unknownKeys.length > 0) {
    const identity = unknownKeys.filter((key) => IDENTITY_KEYS.has(key))
    if (identity.length > 0) {
      throw new JobDraftError('TENANT_OR_ACTOR_NOT_ALLOWED', 'tenant_id / actor_id 不接受模型传入（身份只来自宿主会话）', {
        rejected_keys: identity,
      })
    }
    throw new JobDraftError('UNKNOWN_PARAM', `未知参数：${unknownKeys.join(', ')}`, {
      unknown_keys: unknownKeys,
      allowed: [...ROOT_KEYS],
    })
  }

  // request_text：必填、非空、≤2000（trim 后计）。
  if (raw.request_text === undefined) {
    throw new JobDraftError('REQUEST_TEXT_MISSING', '缺少必填参数 request_text（一句人话需求）')
  }
  if (typeof raw.request_text !== 'string') {
    throw new JobDraftError('REQUEST_TEXT_TYPE', 'request_text 必须是字符串', { got_type: typeof raw.request_text })
  }
  if (raw.request_text.trim() === '') {
    throw new JobDraftError('REQUEST_TEXT_EMPTY', 'request_text 不能是空白（至少要说明要招什么岗位）')
  }
  if (raw.request_text.length > MAX_REQUEST_TEXT_CHARS) {
    throw new JobDraftError('REQUEST_TEXT_TOO_LONG', `request_text 超过 ${MAX_REQUEST_TEXT_CHARS} 字符`, {
      length: raw.request_text.length,
      max: MAX_REQUEST_TEXT_CHARS,
    })
  }

  // recruiter_supplement：可选。
  let supplement: string | undefined
  if (raw.recruiter_supplement !== undefined) {
    if (typeof raw.recruiter_supplement !== 'string') {
      throw new JobDraftError('SUPPLEMENT_TYPE', 'recruiter_supplement 必须是字符串', {
        got_type: typeof raw.recruiter_supplement,
      })
    }
    if (raw.recruiter_supplement.length > MAX_SUPPLEMENT_CHARS) {
      throw new JobDraftError('SUPPLEMENT_TOO_LONG', `recruiter_supplement 超过 ${MAX_SUPPLEMENT_CHARS} 字符`, {
        length: raw.recruiter_supplement.length,
        max: MAX_SUPPLEMENT_CHARS,
      })
    }
    const trimmed = raw.recruiter_supplement.trim()
    if (trimmed !== '') supplement = trimmed
  }

  // template_id：可选；给了就必须在模板库里（fail-closed，不猜）。
  let templateId: string | undefined
  if (raw.template_id !== undefined) {
    if (typeof raw.template_id !== 'string') {
      throw new JobDraftError('TEMPLATE_ID_TYPE', 'template_id 必须是字符串', { got_type: typeof raw.template_id })
    }
    const trimmed = raw.template_id.trim()
    if (trimmed !== '') {
      if (!JOB_TEMPLATE_LIBRARY.some((template) => template.template_id === trimmed)) {
        throw new JobDraftError('TEMPLATE_ID_UNKNOWN', `未知模板：${trimmed}`, {
          template_id: trimmed,
          available_template_ids: JOB_TEMPLATE_LIBRARY.map((template) => template.template_id),
        })
      }
      templateId = trimmed
    }
  }

  // department_context：可选、封闭键集。
  let context: DepartmentContext | undefined
  if (raw.department_context !== undefined) {
    if (!isPlainObject(raw.department_context)) {
      throw new JobDraftError('CONTEXT_NOT_OBJECT', 'department_context 必须是 JSON 对象')
    }
    const unknown = Object.keys(raw.department_context).filter((key) => !CONTEXT_KEYS.includes(key)).sort()
    if (unknown.length > 0) {
      throw new JobDraftError('CONTEXT_UNKNOWN_KEY', `department_context 有未知键：${unknown.join(', ')}`, {
        unknown_keys: unknown,
        allowed: [...CONTEXT_KEYS],
      })
    }
    const source = raw.department_context
    const departmentId = source.department_id
    if (departmentId !== undefined && (typeof departmentId !== 'string' || !UUID_RE.test(departmentId))) {
      throw new JobDraftError('CONTEXT_VALUE_INVALID', 'department_context.department_id 必须是 UUID', {
        field: 'department_context.department_id',
      })
    }
    let headcount: number | undefined
    if (source.headcount !== undefined) {
      if (typeof source.headcount !== 'number' || !Number.isInteger(source.headcount)
        || source.headcount < 1 || source.headcount > 10_000) {
        throw new JobDraftError('CONTEXT_VALUE_INVALID', 'department_context.headcount 必须是 1..10000 的整数', {
          field: 'department_context.headcount',
        })
      }
      headcount = source.headcount
    }
    const parsed: DepartmentContext = {
      ...(departmentId === undefined ? {} : { department_id: departmentId }),
      ...(readShortString(source.department_name, 'department_context.department_name', 200) === undefined
        ? {} : { department_name: readShortString(source.department_name, 'department_context.department_name', 200) as string }),
      ...(readShortString(source.location, 'department_context.location', 200) === undefined
        ? {} : { location: readShortString(source.location, 'department_context.location', 200) as string }),
      ...(readShortString(source.level, 'department_context.level', 200) === undefined
        ? {} : { level: readShortString(source.level, 'department_context.level', 200) as string }),
      ...(readShortString(source.salary_range, 'department_context.salary_range', 200) === undefined
        ? {} : { salary_range: readShortString(source.salary_range, 'department_context.salary_range', 200) as string }),
      ...(readShortString(source.budget, 'department_context.budget', 200) === undefined
        ? {} : { budget: readShortString(source.budget, 'department_context.budget', 200) as string }),
      ...(headcount === undefined ? {} : { headcount }),
      ...(readShortString(source.priority, 'department_context.priority', 200) === undefined
        ? {} : { priority: readShortString(source.priority, 'department_context.priority', 200) as string }),
      ...(readShortString(source.recruitment_reason, 'department_context.recruitment_reason', 200) === undefined
        ? {} : { recruitment_reason: readShortString(source.recruitment_reason, 'department_context.recruitment_reason', 200) as string }),
    }
    if (Object.keys(parsed).length > 0) context = parsed
  }

  // historical_jobs：可选、≤20 条、标题必填。
  let historicalJobs: HistoricalJob[] | undefined
  if (raw.historical_jobs !== undefined) {
    if (!Array.isArray(raw.historical_jobs)) {
      throw new JobDraftError('HISTORY_NOT_ARRAY', 'historical_jobs 必须是数组')
    }
    if (raw.historical_jobs.length > MAX_HISTORY_ITEMS) {
      throw new JobDraftError('HISTORY_TOO_LARGE', `historical_jobs 最多 ${MAX_HISTORY_ITEMS} 条`, {
        max: MAX_HISTORY_ITEMS,
      })
    }
    historicalJobs = raw.historical_jobs.map((item, index) => {
      if (!isPlainObject(item)) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_jobs[${index}] 必须是对象`, { index })
      }
      const unknown = Object.keys(item).filter((key) => !HISTORY_JOB_KEYS.includes(key)).sort()
      if (unknown.length > 0) {
        throw new JobDraftError('HISTORY_UNKNOWN_KEY', `historical_jobs[${index}] 有未知键：${unknown.join(', ')}`, {
          index,
          unknown_keys: unknown,
          allowed: [...HISTORY_JOB_KEYS],
        })
      }
      const title = item.title
      if (typeof title !== 'string' || title.trim() === '' || title.trim().length > 200) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_jobs[${index}].title 必须是 1..200 字符`, { index })
      }
      const jobId = item.job_id
      if (jobId !== undefined && (typeof jobId !== 'string' || !UUID_RE.test(jobId))) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_jobs[${index}].job_id 必须是 UUID`, { index })
      }
      const readOptional = (key: 'code' | 'status' | 'department_name'): string | undefined => {
        const value = item[key]
        if (value === undefined) return undefined
        if (typeof value !== 'string' || value.trim() === '' || value.trim().length > 200) {
          throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_jobs[${index}].${key} 必须是 1..200 字符`, { index })
        }
        return value.trim()
      }
      return {
        title: title.trim(),
        ...(jobId === undefined ? {} : { job_id: jobId }),
        ...(readOptional('code') === undefined ? {} : { code: readOptional('code') as string }),
        ...(readOptional('status') === undefined ? {} : { status: readOptional('status') as string }),
        ...(readOptional('department_name') === undefined
          ? {} : { department_name: readOptional('department_name') as string }),
      }
    })
  }

  // historical_rubrics：可选、只取维度摘要（key/label/kind/weight）。
  let historicalRubrics: HistoricalRubric[] | undefined
  if (raw.historical_rubrics !== undefined) {
    if (!Array.isArray(raw.historical_rubrics)) {
      throw new JobDraftError('HISTORY_NOT_ARRAY', 'historical_rubrics 必须是数组')
    }
    if (raw.historical_rubrics.length > MAX_HISTORY_ITEMS) {
      throw new JobDraftError('HISTORY_TOO_LARGE', `historical_rubrics 最多 ${MAX_HISTORY_ITEMS} 条`, {
        max: MAX_HISTORY_ITEMS,
      })
    }
    historicalRubrics = raw.historical_rubrics.map((item, index) => {
      if (!isPlainObject(item)) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}] 必须是对象`, { index })
      }
      const unknown = Object.keys(item).filter((key) => !HISTORY_RUBRIC_KEYS.includes(key)).sort()
      if (unknown.length > 0) {
        throw new JobDraftError('HISTORY_UNKNOWN_KEY', `historical_rubrics[${index}] 有未知键：${unknown.join(', ')}`, {
          index,
          unknown_keys: unknown,
          allowed: [...HISTORY_RUBRIC_KEYS],
        })
      }
      const jobId = item.job_id
      if (jobId !== undefined && (typeof jobId !== 'string' || !UUID_RE.test(jobId))) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].job_id 必须是 UUID`, { index })
      }
      const versionNo = item.version_no
      if (versionNo !== undefined && (typeof versionNo !== 'number' || !Number.isInteger(versionNo) || versionNo < 1)) {
        throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].version_no 必须是 ≥1 的整数`, { index })
      }
      let dimensions: HistoricalRubricDimension[] | undefined
      if (item.dimensions !== undefined) {
        if (!Array.isArray(item.dimensions) || item.dimensions.length === 0 || item.dimensions.length > 50) {
          throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions 必须是 1..50 元素的数组`, { index })
        }
        dimensions = item.dimensions.map((dim, dimIndex) => {
          if (!isPlainObject(dim)) {
            throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions[${dimIndex}] 必须是对象`, { index, dimIndex })
          }
          const dimUnknown = Object.keys(dim).filter((key) => !HISTORY_DIMENSION_KEYS.includes(key)).sort()
          if (dimUnknown.length > 0) {
            throw new JobDraftError('HISTORY_UNKNOWN_KEY', `historical_rubrics[${index}].dimensions[${dimIndex}] 有未知键`, {
              index,
              dimIndex,
              unknown_keys: dimUnknown,
              allowed: [...HISTORY_DIMENSION_KEYS],
            })
          }
          const key = dim.key
          if (typeof key !== 'string' || !CRITERION_KEY_RE.test(key)) {
            throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions[${dimIndex}].key 不合法`, { index, dimIndex })
          }
          const label = dim.label
          if (label !== undefined && (typeof label !== 'string' || label.trim() === '' || label.trim().length > 200)) {
            throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions[${dimIndex}].label 必须是 1..200 字符`, { index, dimIndex })
          }
          const kind = dim.kind
          if (kind !== undefined && (typeof kind !== 'string' || !CRITERION_KIND_SET.has(kind))) {
            throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions[${dimIndex}].kind 不合法`, { index, dimIndex })
          }
          const weight = dim.weight
          if (weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 1)) {
            throw new JobDraftError('HISTORY_ITEM_INVALID', `historical_rubrics[${index}].dimensions[${dimIndex}].weight 必须是 0..1 的数`, { index, dimIndex })
          }
          return {
            key,
            ...(label === undefined ? {} : { label: label.trim() }),
            ...(kind === undefined ? {} : { kind: kind as CriterionKind }),
            ...(weight === undefined ? {} : { weight }),
          }
        })
      }
      return {
        ...(jobId === undefined ? {} : { job_id: jobId }),
        ...(versionNo === undefined ? {} : { version_no: versionNo }),
        ...(dimensions === undefined ? {} : { dimensions }),
      }
    })
    if (historicalRubrics.length === 0) historicalRubrics = undefined
  }

  return {
    request_text: raw.request_text,
    ...(supplement === undefined ? {} : { recruiter_supplement: supplement }),
    ...(templateId === undefined ? {} : { template_id: templateId }),
    ...(context === undefined ? {} : { department_context: context }),
    ...(historicalJobs === undefined || historicalJobs.length === 0 ? {} : { historical_jobs: historicalJobs }),
    ...(historicalRubrics === undefined ? {} : { historical_rubrics: historicalRubrics }),
  }
}

// ---------------------------------------------------------------------------
//  提取结果（内部结构）
// ---------------------------------------------------------------------------

interface ExtractedFact {
  readonly value: string
  readonly quote: string
}

interface ExtractedDepartmentFact {
  readonly value?: string
  readonly department_id?: string
  readonly quote: string
}

interface ExtractedFacts {
  readonly title: string
  readonly title_source: 'USER_INPUT' | 'TEMPLATE_LIBRARY'
  readonly department?: ExtractedDepartmentFact
  readonly headcount?: { readonly value: number; readonly quote: string }
  readonly level?: ExtractedFact
  readonly location?: ExtractedFact
  readonly salary?: ExtractedFact
  readonly budget?: ExtractedFact
  readonly priority?: ExtractedFact
  readonly recruitment_reason?: ExtractedFact
  readonly domain?: ExtractedFact
  readonly years?: { readonly value: number; readonly quote: string }
  readonly education?: ExtractedFact
  readonly experience_unlimited: boolean
  readonly education_unlimited: boolean
  readonly user_must: readonly { readonly text: string; readonly quote: string }[]
  readonly user_nice: readonly { readonly text: string; readonly quote: string }[]
  readonly warnings: readonly { readonly code: string; readonly message: string }[]
}

/** 从一段用户文字里找领域上下文（如"做支付系统"）。 */
function extractDomain(text: string): ExtractedFact | undefined {
  const match = DOMAIN_RE.exec(text)
  if (match === null) return undefined
  const value = `${match[1] ?? ''}${match[2] ?? ''}`.trim()
  if (value.length < 2) return undefined
  return { value, quote: match[0].trim() }
}

/** 从文字里找部门名（带组织后缀；泛化词丢弃）。 */
function extractDepartment(text: string): ExtractedFact | undefined {
  for (const match of text.matchAll(new RegExp(DEPARTMENT_RE.source, 'g'))) {
    const raw = (match[0] ?? '').trim()
    if (raw === '') continue
    const value = raw.replace(/^(?:加入|入职|归属|属于|在|到)/, '')
    if (value.length < 2 || value.length > 30) continue
    if (GENERIC_DEPARTMENT_WORDS.includes(value)) continue
    return { value, quote: raw }
  }
  return undefined
}

/** 从文字里找工作地点（城市清单里最早出现的一个）。 */
function extractLocation(text: string): ExtractedFact | undefined {
  let best: { readonly city: string; readonly index: number } | undefined
  for (const city of CITY_LIST) {
    const index = text.indexOf(city)
    if (index >= 0 && (best === undefined || index < best.index)) best = { city, index }
  }
  if (best === undefined) return undefined
  return { value: best.city, quote: best.city }
}

/** 从文字里找职级（先认 P/M/L 序列，再认中文级别词）。 */
function extractLevel(text: string): ExtractedFact | undefined {
  const code = LEVEL_CODE_RE.exec(text)
  if (code !== null) return { value: (code[1] ?? '').toUpperCase(), quote: code[0] }
  const word = LEVEL_WORD_RE.exec(text)
  if (word !== null) return { value: word[1] ?? '', quote: word[0] }
  return undefined
}

/** 从文字里找薪酬区间（取第一处命中模式的原话片段）。 */
function extractSalary(text: string): ExtractedFact | undefined {
  const value = firstGroup(SALARY_PATTERNS, text)
  if (value === undefined) return undefined
  return { value, quote: value }
}

/** 从文字里找预算（必须有具体数字，否则不当作预算事实）。 */
function extractBudget(text: string): ExtractedFact | undefined {
  const match = /(?:预算|人力预算|年度预算)\s*[:：]?\s*([^，。；;,\n]{1,30})/.exec(text)
  if (match === null) return undefined
  const value = (match[1] ?? '').trim()
  if (value === '' || !/\d/.test(value)) return undefined
  return { value, quote: match[0].trim() }
}

/** 从文字里找优先级。 */
function extractPriority(text: string): ExtractedFact | undefined {
  const match = PRIORITY_RE.exec(text)
  if (match === null) return undefined
  return { value: match[1] ?? match[0], quote: match[0] }
}

/** 从文字里找招聘原因（保留用户原话片段）。 */
function extractRecruitmentReason(text: string): ExtractedFact | undefined {
  for (const pattern of RECRUITMENT_REASON_PATTERNS) {
    const match = pattern.exec(text)
    if (match !== null) return { value: match[1] ?? match[0], quote: match[0] }
  }
  return undefined
}

/** 从文字里找人数（1..10000）。 */
function extractHeadcount(text: string): { value: number; quote: string } | undefined {
  const raw = firstGroup(HEADCOUNT_PATTERNS, text)
  if (raw === undefined) return undefined
  const value = Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < 1 || value > 10_000) return undefined
  return { value, quote: `${raw}${text.includes(`${raw}名`) ? '名' : ''}` }
}

/** 从文字里找经验年限（取下限）。 */
function extractYears(text: string): { value: number; quote: string } | undefined {
  for (const pattern of YEARS_PATTERNS) {
    const match = pattern.exec(text)
    if (match === null) continue
    const value = Number.parseInt(match[1] ?? '', 10)
    if (!Number.isInteger(value) || value < 0 || value > 50) continue
    return { value, quote: match[0].trim() }
  }
  return undefined
}

/** 从文字里找学历要求（先判"学历不限"，再取最先出现的学历词）。 */
function extractEducation(text: string): { value: string; quote: string } | undefined {
  let best: { readonly word: string; readonly index: number } | undefined
  for (const word of EDUCATION_WORDS) {
    const index = text.indexOf(word)
    if (index >= 0 && (best === undefined || index < best.index)) best = { word, index }
  }
  if (best === undefined) return undefined
  return { value: best.word, quote: best.word }
}

/** 原话模式命中（去重后返回）。 */
function extractPhrases(patterns: readonly RegExp[], text: string, exclude: (value: string) => boolean): { text: string; quote: string }[] {
  const out: { text: string; quote: string }[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match === null) continue
    const quote = (match[0] ?? '').trim()
    const textValue = normalizeRequirementText(match[1] ?? '')
    if (textValue.length < 2 || textValue.length > 30) continue
    if (exclude(textValue)) continue
    if (seen.has(textValue)) continue
    seen.add(textValue)
    out.push({ text: textValue, quote })
  }
  return out
}

/** 上下文事实的"来源说明"。 */
const CONTEXT_REASON_SUFFIX = '来自调用方提供的 department_context（企业/部门上下文）；草案不推断'

/**
 * 把用户文字 + 上下文合并成事实集合。
 * 上下文优先（更权威），冲突进 warnings（不静默择一）。
 */
function extractFacts(input: JobDraftInput, template: JobTemplate): ExtractedFacts {
  const requestText = input.request_text.trim()
  const supplement = input.recruiter_supplement ?? ''
  const text = supplement === '' ? requestText : `${requestText}\n${supplement}`
  const context = input.department_context
  const warnings: { code: string; message: string }[] = []

  const textDepartment = extractDepartment(text)
  const contextDepartment: ExtractedDepartmentFact | undefined = context !== undefined
    && (context.department_id !== undefined || context.department_name !== undefined)
    ? {
      ...(context.department_name === undefined ? {} : { value: context.department_name }),
      ...(context.department_id === undefined ? {} : { department_id: context.department_id }),
      quote: 'department_context',
    }
    : undefined
  let department: ExtractedDepartmentFact | undefined
  if (contextDepartment !== undefined && textDepartment !== undefined
    && contextDepartment.value !== undefined && contextDepartment.value !== textDepartment.value) {
    warnings.push({
      code: 'FACT_CONFLICT',
      message: `部门名称冲突：department_context 给「${contextDepartment.value}」，用户原话是「${textDepartment.value}」；按上下文优先，需人确认`,
    })
  }
  department = contextDepartment ?? (textDepartment === undefined ? undefined : {
    value: textDepartment.value,
    quote: textDepartment.quote,
  })

  const pick = (
    field: string,
    contextValue: string | undefined,
    textValue: ExtractedFact | undefined,
  ): ExtractedFact | undefined => {
    if (contextValue !== undefined && textValue !== undefined && contextValue !== textValue.value) {
      warnings.push({
        code: 'FACT_CONFLICT',
        message: `${field} 冲突：department_context 给「${contextValue}」，用户原话是「${textValue.value}」；按上下文优先，需人确认`,
      })
    }
    if (contextValue !== undefined) return { value: contextValue, quote: 'department_context' }
    return textValue
  }

  const headcountContext = context?.headcount
  const headcountText = extractHeadcount(text)
  const headcount = headcountContext !== undefined
    ? { value: headcountContext, quote: 'department_context' }
    : headcountText

  const years = extractYears(text)
  const education = extractEducation(text)
  const experienceUnlimited = EXPERIENCE_UNLIMITED_RE.test(text)
  const educationUnlimited = EDUCATION_UNLIMITED_RE.test(text)

  const excludeRequirement = (value: string): boolean =>
    YEARS_PATTERNS.some((pattern) => pattern.test(value))
    || EDUCATION_WORDS.some((word) => value.includes(word))

  const userNice = extractPhrases(NICE_PATTERNS, text, excludeRequirement)
  const userMust = extractPhrases(MUST_PATTERNS, text, excludeRequirement)

  // 标题：用户明确写了岗位名称（模板 label）→ USER_INPUT；只命中角色词 → 模板建议。
  const levelPrefix = LEVEL_PREFIX_RE.exec(text)
  let title = template.label
  let titleSource: 'USER_INPUT' | 'TEMPLATE_LIBRARY' = 'TEMPLATE_LIBRARY'
  if (levelPrefix !== null) {
    title = `${levelPrefix[1] ?? ''}${template.label}`
    titleSource = 'USER_INPUT'
  } else if (text.includes(template.label)) {
    titleSource = 'USER_INPUT'
  }
  if (titleSource === 'TEMPLATE_LIBRARY') {
    warnings.push({
      code: 'TITLE_SUGGESTED_BY_TEMPLATE',
      message: `用户没有明确岗位名称，按模板建议「${template.label}」；对外发布前必须由人确认`,
    })
  }

  return {
    title,
    title_source: titleSource,
    ...(department === undefined ? {} : { department }),
    ...(headcount === undefined ? {} : { headcount }),
    ...(pick('level', context?.level, extractLevel(text)) === undefined
      ? {} : { level: pick('level', context?.level, extractLevel(text)) as ExtractedFact }),
    ...(pick('location', context?.location, extractLocation(text)) === undefined
      ? {} : { location: pick('location', context?.location, extractLocation(text)) as ExtractedFact }),
    ...(pick('salary', context?.salary_range, extractSalary(text)) === undefined
      ? {} : { salary: pick('salary', context?.salary_range, extractSalary(text)) as ExtractedFact }),
    ...(pick('budget', context?.budget, extractBudget(text)) === undefined
      ? {} : { budget: pick('budget', context?.budget, extractBudget(text)) as ExtractedFact }),
    ...(pick('priority', context?.priority, extractPriority(text)) === undefined
      ? {} : { priority: pick('priority', context?.priority, extractPriority(text)) as ExtractedFact }),
    ...(pick('recruitment_reason', context?.recruitment_reason, extractRecruitmentReason(text)) === undefined
      ? {} : { recruitment_reason: pick('recruitment_reason', context?.recruitment_reason, extractRecruitmentReason(text)) as ExtractedFact }),
    ...(extractDomain(text) === undefined ? {} : { domain: extractDomain(text) as ExtractedFact }),
    ...(years === undefined ? {} : { years }),
    ...(education === undefined ? {} : { education: { value: education.value, quote: education.quote } }),
    experience_unlimited: experienceUnlimited,
    education_unlimited: educationUnlimited,
    user_must: userMust,
    user_nice: userNice,
    warnings,
  }
}

// ---------------------------------------------------------------------------
//  模板选择（确定性：分数最高者；同分取库中靠前者；零命中 → fail-closed）
// ---------------------------------------------------------------------------

interface TemplateSelection {
  readonly template: JobTemplate
  readonly matched_keywords: readonly string[]
  readonly explicit: boolean
}

/**
 * 选模板：`template_id` 显式指定优先；否则按角色词命中数选，零命中直接报错（不猜）。
 * @param templateId - 可选显式模板 id（parseJobDraftInput 已校验存在）。
 * @param text - 用户文字（request + supplement）。
 */
function selectTemplate(templateId: string | undefined, text: string): TemplateSelection {
  if (templateId !== undefined) {
    const explicit = JOB_TEMPLATE_LIBRARY.find((template) => template.template_id === templateId)
    if (explicit === undefined) {
      throw new JobDraftError('TEMPLATE_ID_UNKNOWN', `未知模板：${templateId}`, {
        template_id: templateId,
        available_template_ids: JOB_TEMPLATE_LIBRARY.map((template) => template.template_id),
      })
    }
    return { template: explicit, matched_keywords: [], explicit: true }
  }
  let best: { readonly template: JobTemplate; readonly hits: string[]; readonly score: number } | undefined
  for (const template of JOB_TEMPLATE_LIBRARY) {
    const hits = template.keywords.filter((keyword) => keywordHit(text, keyword))
    let score = hits.length
    if (text.includes(template.label)) score += 2
    if (best === undefined || score > best.score) best = { template, hits, score }
  }
  if (best === undefined || best.score === 0) {
    throw new JobDraftError(
      'TEMPLATE_UNRESOLVED',
      '无法从需求里确定岗位族（没有命中任何模板关键词；请补充岗位名称或显式给 template_id）',
      {
        available_template_ids: JOB_TEMPLATE_LIBRARY.map((template) => template.template_id),
        available_families: JOB_TEMPLATE_LIBRARY.map((template) => template.family),
      },
    )
  }
  return { template: best.template, matched_keywords: best.hits, explicit: false }
}

// ---------------------------------------------------------------------------
//  criterion / 权重（integer basis points，保证 Σweight 精确可复现）
// ---------------------------------------------------------------------------

interface MutableCriterionCore {
  key: string
  label: string
  kind: CriterionKind
  field?: string
  operator?: CriterionOperator
  value?: boolean | number
  question?: string
  notes?: string
}

interface PlannedDimension {
  readonly criterion: MutableCriterionCore
  bp: number
  reason: string
  source: DraftSource
  readonly match_tags: readonly string[]
}

/**
 * 把 bp 归一化到 10000（整数），返回新数组；差量按顺序 1 bp 分配，确定性、无浮点漂移。
 * @param bps - 原始 bp（正数）。
 */
function rescaleBasisPoints(bps: readonly number[]): number[] {
  const total = bps.reduce((sum, value) => sum + value, 0)
  if (bps.length === 0 || total <= 0) {
    throw new JobDraftError('CRITERIA_INVALID', '内部错误：维度权重合计为 0，无法归一化')
  }
  const scaled = bps.map((bp) => Math.max(1, Math.round((bp * 10_000) / total)))
  let diff = 10_000 - scaled.reduce((sum, value) => sum + value, 0)
  let guard = 0
  let index = 0
  while (diff !== 0) {
    guard += 1
    if (guard > 100_000) throw new JobDraftError('CRITERIA_INVALID', '内部错误：权重归一化无法收敛')
    const cursor = index % scaled.length
    if (diff > 0) {
      scaled[cursor] = (scaled[cursor] ?? 0) + 1
      diff -= 1
    } else if ((scaled[cursor] ?? 0) > 1) {
      scaled[cursor] = (scaled[cursor] ?? 1) - 1
      diff += 1
    }
    index += 1
  }
  return scaled
}

/** 按固定 9 键顺序造一个 criterion 对象（缺省键省略，不写 null）。 */
function makeCriterion(core: MutableCriterionCore, weight: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: core.key,
    label: core.label,
    kind: core.kind,
    weight,
  }
  if (core.field !== undefined) {
    out.field = core.field
    out.operator = core.operator
    out.value = core.value
  } else if (core.question !== undefined) {
    out.question = core.question
  }
  if (core.notes !== undefined) out.notes = core.notes
  return out
}

/** 维度是否覆盖该 criterion（round_focus 补齐用）。 */
function educationCriterionKeys(criteria: readonly Record<string, unknown>[]): string[] {
  return criteria
    .filter((criterion) => {
      const label = criterion.label
      return typeof label === 'string' && label.includes('学历')
    })
    .map((criterion) => criterion.key as string)
}

// ---------------------------------------------------------------------------
//  buildJobDraft
// ---------------------------------------------------------------------------

/** 草案里一条带来源的文本条目（职责 / 成功画像 / 必备 / 加分）。 */
export interface SourcedTextItem {
  readonly text: string
  readonly reason: string
  readonly source: DraftSource
}

/** 一个事实块（值 + 来源 + 理由）。 */
export interface FactBlock<T> {
  readonly value: T
  readonly source: DraftSource
  readonly reason: string
}

/** 部门事实块（可以只给 id、不给名称）。 */
export interface DepartmentFactBlock {
  readonly value?: string
  readonly department_id?: string
  readonly source: DraftSource
  readonly reason: string
}

/** 轮次（含每轮 focus 与理由）。 */
export interface DraftRound {
  readonly name: string
  readonly focus: readonly string[]
  readonly reason: string
  readonly source: DraftSource
}

/** 评分表字段。 */
export interface DraftScorecardField {
  readonly key: string
  readonly label: string
  readonly type: 'SCORE_1_5' | 'TEXT'
  readonly reason: string
  readonly source: DraftSource
}

/** 一条维度的理由（与 criterion 按 key 一一对应）。 */
export interface CriterionRationale {
  readonly criterion_key: string
  readonly reason: string
  readonly source: DraftSource
}

/** 每轮考察点（把 criteria key 绑到轮次）。 */
export interface DraftRoundFocus {
  readonly round: string
  readonly criteria_keys: readonly string[]
  readonly reason: string
  readonly source: DraftSource
}

/** Rubric 草案。 */
export interface RubricDraft {
  /** 纯 criterion 数组（严格 9 键子集；可直接作为 `recruitment_job_create` 的 `criteria`）。 */
  readonly criteria: readonly Record<string, unknown>[]
  /** 与 criteria 逐一对应的理由（criterion_key 对齐）。 */
  readonly rationale: readonly CriterionRationale[]
  /** 硬性门槛索引。 */
  readonly hard_gates: {
    readonly must_have_keys: readonly string[]
    readonly disqualifier_keys: readonly string[]
  }
  /** 每轮考察点。 */
  readonly round_focus: readonly DraftRoundFocus[]
  /** 评分表字段。 */
  readonly scorecard_fields: readonly DraftScorecardField[]
  /** 权重合计（数值自检；应等于 1，误差 ≤1e-6）。 */
  readonly weight_sum: number
}

/** 一条缺失事实（必须带可直接问用户的问题文本）。 */
export interface MissingItem {
  readonly field: string
  readonly question: string
  readonly why: string
  readonly source: 'MISSING'
  readonly blocking: boolean
}

/** 一条系统警告（不阻止产出，但必须显式暴露）。 */
export interface DraftWarning {
  readonly code: string
  readonly message: string
}

/** 模板引用。 */
export interface TemplateRef {
  readonly template_id: string
  readonly family: string
  readonly label: string
  readonly reason: string
  readonly source: 'TEMPLATE_LIBRARY'
}

/** 历史参考块（只有调用方给了历史时出现）。 */
export interface HistoryBlock {
  readonly matched_jobs: readonly {
    readonly title: string
    readonly matched_because: string
    readonly source: 'HISTORY'
    readonly code?: string
    readonly status?: string
  }[]
  readonly reference_rubrics: readonly {
    readonly dimension_keys: readonly string[]
    readonly note: string
    readonly source: 'HISTORY'
    readonly version_no?: number
    readonly job_id?: string
  }[]
  readonly reason: string
}

/** 人确认闸门块（**固定形状**，独立验收项）。 */
export interface ConfirmationBlock {
  readonly required: true
  readonly status: 'PENDING_HUMAN_CONFIRMATION'
  readonly next: readonly ['recruitment_job_create', 'recruitment_job_rubric_approve']
  readonly note: '确认/修改必须由人完成'
}

/** 岗位草案（工具输出的业务内容；tool 层再加 tool/contract_version 两个键）。 */
export interface JobDraft {
  readonly read_only: true
  readonly zero_write: true
  readonly status: 'OK'
  readonly template: TemplateRef
  readonly job: {
    readonly title: string
    readonly title_source: 'USER_INPUT' | 'TEMPLATE_LIBRARY'
    readonly responsibilities: readonly SourcedTextItem[]
    readonly success_profile: readonly SourcedTextItem[]
    readonly must_have: readonly SourcedTextItem[]
    readonly nice_to_have: readonly SourcedTextItem[]
    readonly rounds: readonly DraftRound[]
    readonly department?: DepartmentFactBlock
    readonly headcount?: FactBlock<number>
    readonly level?: FactBlock<string>
    readonly location?: FactBlock<string>
    readonly salary?: FactBlock<string>
    readonly budget?: FactBlock<string>
    readonly priority?: FactBlock<string>
    readonly recruitment_reason?: FactBlock<string>
    readonly domain_context?: FactBlock<string>
  }
  readonly rubric_draft: RubricDraft
  readonly missing_items: readonly MissingItem[]
  readonly warnings: readonly DraftWarning[]
  readonly history?: HistoryBlock
  readonly confirmation: ConfirmationBlock
}

/** 人确认闸门（导出给测试与上层复用；构造是纯函数地返回同一对象）。 */
export function confirmationBlock(): ConfirmationBlock {
  return {
    required: true,
    status: 'PENDING_HUMAN_CONFIRMATION',
    next: ['recruitment_job_create', 'recruitment_job_rubric_approve'],
    note: '确认/修改必须由人完成',
  }
}

/**
 * 从一句人话需求生成岗位草案 + Rubric 草案。**纯函数**：不读写任何外部状态。
 * @param input - 已校验的 `JobDraftInput`（见 `parseJobDraftInput`）。
 * @returns 岗位草案（含每项 reason/source、缺失项、人确认闸门）。
 * @throws JobDraftError - 模板无法确定 / 内部 rubric 不合法时抛（fail-closed，不产出假草案）。
 */
export function buildJobDraft(input: JobDraftInput): JobDraft {
  const requestText = input.request_text.trim()
  if (requestText === '') {
    throw new JobDraftError('REQUEST_TEXT_EMPTY', 'request_text 不能是空白')
  }
  const combined = input.recruiter_supplement === undefined
    ? requestText
    : `${requestText}\n${input.recruiter_supplement}`
  const selection = selectTemplate(input.template_id, combined)
  const template = selection.template
  const facts = extractFacts(input, template)
  const warnings: DraftWarning[] = [...facts.warnings]

  // --- 1) 维度计划：模板默认 → 用户事实覆盖 → 用户补充派生 → 归一化权重 ---
  const planned: PlannedDimension[] = template.rubric_dimensions.map((dimension) => ({
    criterion: stripTemplateMeta(dimension),
    bp: Math.round(dimension.weight * 10_000),
    reason: dimension.reason,
    source: 'TEMPLATE_LIBRARY',
    match_tags: dimension.match_tags,
  }))

  // 1a) 经验年限。
  const monthsIndex = planned.findIndex((entry) => entry.criterion.field === 'timeline.covered_months_closed')
  if (facts.experience_unlimited) {
    if (monthsIndex >= 0) {
      planned.splice(monthsIndex, 1)
      warnings.push({
        code: 'EXPERIENCE_REQUIREMENT_DROPPED',
        message: '用户表示经验不限/应届：已移除模板默认的年限硬性维度（可在确认时加回）',
      })
    }
  } else if (facts.years !== undefined) {
    const months = facts.years.value * 12
    const label = `相关工作经验 ≥ ${facts.years.value} 年`
    const reason = `用户原话「${facts.years.quote}」：要求 ${facts.years.value} 年以上经验，按 §6.3 白名单换算为 ${months} 个月（GTE ${months}）`
    if (monthsIndex >= 0) {
      const target = planned[monthsIndex]
      if (target !== undefined) {
        target.criterion.label = label
        target.criterion.value = months
        target.criterion.notes = '按时间线可复算；年限来自用户明说，口径需人确认'
        target.reason = reason
        target.source = 'USER_INPUT'
      }
    } else {
      planned.push({
        criterion: {
          key: 'years_of_experience',
          label,
          kind: 'MUST_HAVE',
          field: 'timeline.covered_months_closed',
          operator: 'GTE',
          value: months,
          notes: '按时间线可复算；年限来自用户明说，口径需人确认',
        },
        bp: 2500,
        reason,
        source: 'USER_INPUT',
        match_tags: [],
      })
    }
  }

  // 1b) 学历。
  const eduIndex = planned.findIndex((entry) => entry.criterion.key === 'education_level'
    || (entry.criterion.question ?? '').includes('学历'))
  if (facts.education_unlimited) {
    if (eduIndex >= 0) {
      planned.splice(eduIndex, 1)
      warnings.push({
        code: 'EDUCATION_REQUIREMENT_DROPPED',
        message: '用户表示学历不限：已移除模板默认的学历维度（可在确认时加回）',
      })
    }
  } else if (facts.education !== undefined) {
    const value = facts.education.value
    const label = `${value}及以上学历`
    const question = `候选人是否具备${value}及以上学历？`
    const reason = `用户原话「${facts.education.quote}」：要求 ${value}及以上学历（判断型，学历不在 §6.3 机械字段白名单内）`
    if (eduIndex >= 0) {
      const target = planned[eduIndex]
      if (target !== undefined) {
        target.criterion.label = label
        target.criterion.question = question
        target.reason = reason
        target.source = 'USER_INPUT'
      }
    } else {
      planned.push({
        criterion: {
          key: 'education_level',
          label,
          kind: 'MUST_HAVE',
          question,
          notes: '学历不在机械字段白名单内，只能人判（§6.3）',
        },
        bp: 1500,
        reason,
        source: 'USER_INPUT',
        match_tags: [],
      })
    }
  }

  // 1c) 用户补充要求：先绑定模板既有维度（match_tags），再尝试派生判断型维度。
  const userRequirements: { text: string; quote: string; kind: 'MUST_HAVE' | 'NICE_TO_HAVE' }[] = [
    ...facts.user_must.map((item) => ({ ...item, kind: 'MUST_HAVE' as const })),
    ...facts.user_nice.map((item) => ({ ...item, kind: 'NICE_TO_HAVE' as const })),
  ]
  for (const requirement of userRequirements) {
    const lowered = requirement.text.toLowerCase()
    let matched = false
    for (const entry of planned) {
      if (entry.match_tags.length === 0) continue
      const hit = entry.match_tags.find((tag) => lowered.includes(tag.toLowerCase()))
      if (hit === undefined) continue
      entry.reason = `用户原话「${requirement.quote}」命中该维度（模板标签：${hit}）；判定口径与权重需人确认`
      entry.source = 'USER_INPUT'
      matched = true
      break
    }
    if (matched) continue
    const rule = DERIVED_JUDGMENT_RULES.find((candidate) => candidate.tags.some((tag) => lowered.includes(tag.toLowerCase())))
    if (rule === undefined) {
      warnings.push({
        code: 'USER_REQUIREMENT_NOT_SCORED',
        message: `用户要求「${requirement.text}」未能映射到评分维度（不改写成机械判定）；请在确认时人工补充维度或删除该要求`,
      })
      continue
    }
    const existing = planned.find((entry) => entry.criterion.key === rule.key)
    if (existing !== undefined) {
      existing.reason = `用户原话「${requirement.quote}」：${requirement.text}`
      existing.source = 'USER_INPUT'
      continue
    }
    planned.push({
      criterion: {
        key: rule.key,
        label: rule.label,
        kind: requirement.kind,
        question: rule.question,
        notes: rule.notes,
      },
      bp: requirement.kind === 'MUST_HAVE' ? 1500 : 1000,
      reason: `用户原话「${requirement.quote}」：${requirement.text}（判断型，需人确认口径）`,
      source: 'USER_INPUT',
      match_tags: [],
    })
  }

  // 1d) 归一化权重 → 生成 criterion 数组（Σweight 与 1 的差 ≤1e-6）。
  const bps = rescaleBasisPoints(planned.map((entry) => entry.bp))
  const criteria = planned.map((entry, index) => makeCriterion(entry.criterion, (bps[index] ?? 0) / 10_000))
  const violations = validateDimensions(criteria)
  if (violations.length > 0) {
    throw new JobDraftError('CRITERIA_INVALID', '生成的 Rubric 草案没有通过 R-VAL-1..13（这是内部缺陷，不允许产出）', {
      violations: violations.map((violation) => ({
        rule: violation.rule,
        reason_code: violation.reason_code,
        path: violation.path,
      })),
    })
  }
  const weightSum = criteria.reduce((sum, criterion) => sum + (criterion.weight as number), 0)
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new JobDraftError('CRITERIA_INVALID', '生成的 Rubric 草案权重合计不为 1', { weight_sum: weightSum })
  }
  const rationale: CriterionRationale[] = planned.map((entry) => ({
    criterion_key: entry.criterion.key,
    reason: entry.reason,
    source: entry.source,
  }))
  const hardGates = {
    must_have_keys: criteria.filter((criterion) => criterion.kind === 'MUST_HAVE').map((criterion) => criterion.key as string),
    disqualifier_keys: criteria.filter((criterion) => criterion.kind === 'DISQUALIFIER').map((criterion) => criterion.key as string),
  }

  // --- 2) 轮次 + 每轮考察点（criteria key 绑定；未覆盖的维度确定性补齐）---
  const rounds: DraftRound[] = template.rounds.map((round) => ({
    name: round.name,
    focus: [...round.focus],
    reason: round.reason,
    source: 'TEMPLATE_LIBRARY',
  }))
  rounds.push({
    name: 'HR 面（动机与期望）',
    focus: ['求职动机与稳定性', '薪酬与到岗期望', '背景信息核对（合规范围内）'],
    reason: '系统默认建议：模板未覆盖 HR 面，动机/期望/稳定性需人确认',
    source: 'DEFAULT_SUGGESTION',
  })
  const roundFocus: DraftRoundFocus[] = template.rounds.map((round) => ({
    round: round.name,
    criteria_keys: [...round.criteria_keys],
    reason: round.reason,
    source: 'TEMPLATE_LIBRARY',
  }))
  roundFocus.push({
    round: 'HR 面（动机与期望）',
    criteria_keys: educationCriterionKeys(criteria),
    reason: '系统默认建议：HR 面核对学历等材料口径（判断型，需人确认）',
    source: 'DEFAULT_SUGGESTION',
  })
  const covered = new Set(roundFocus.flatMap((entry) => entry.criteria_keys))
  const uncovered = criteria
    .map((criterion) => criterion.key as string)
    .filter((key) => !covered.has(key))
  if (uncovered.length > 0) {
    roundFocus.push({
      round: '补充考察（确定性补齐）',
      criteria_keys: uncovered,
      reason: '用户补充要求派生出的维度未被模板轮次覆盖：由确定性规则补齐，需人在确认时指定考察轮次',
      source: 'DEFAULT_SUGGESTION',
    })
  }

  // --- 3) 评分表字段（模板 + 跨岗位族默认项）---
  const scorecardFields: DraftScorecardField[] = template.scorecard_fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    reason: field.reason,
    source: 'TEMPLATE_LIBRARY',
  }))
  scorecardFields.push({
    key: 'collaboration_culture',
    label: '协作与价值观（综合）',
    type: 'SCORE_1_5',
    reason: '系统默认建议：所有岗位都建议评估协作与价值观，口径由人确认',
    source: 'DEFAULT_SUGGESTION',
  })

  // --- 4) 岗位文本（模板 + 用户原话）---
  const toItem = (item: TemplateTextItem): SourcedTextItem => ({
    text: item.text,
    reason: item.reason,
    source: 'TEMPLATE_LIBRARY',
  })
  const responsibilities: SourcedTextItem[] = template.responsibilities.map(toItem)
  if (facts.domain !== undefined) {
    responsibilities.push({
      text: `负责「${facts.domain.value}」方向的业务开发与交付（方向来自用户原话）`,
      reason: `用户原话「${facts.domain.quote}」；具体职责边界需人确认`,
      source: 'USER_INPUT',
    })
  }
  const userMustItems: SourcedTextItem[] = facts.user_must.map((item) => ({
    text: item.text,
    reason: `用户原话「${item.quote}」`,
    source: 'USER_INPUT',
  }))
  const userNiceItems: SourcedTextItem[] = facts.user_nice.map((item) => ({
    text: item.text,
    reason: `用户原话「${item.quote}」`,
    source: 'USER_INPUT',
  }))

  // --- 5) 事实块（只在有来源时出现；没有就进 missing_items，绝不编造）---
  const userReason = (quote: string): string => `用户原话「${quote}」`
  const factBlock = (fact: ExtractedFact, fromContext: boolean): FactBlock<string> => ({
    value: fact.value,
    source: fromContext ? 'DEPARTMENT_CONTEXT' : 'USER_INPUT',
    reason: fromContext ? CONTEXT_REASON_SUFFIX : userReason(fact.quote),
  })

  const departmentBlock: DepartmentFactBlock | undefined = facts.department === undefined
    ? undefined
    : {
      ...(facts.department.value === undefined ? {} : { value: facts.department.value }),
      ...(facts.department.department_id === undefined ? {} : { department_id: facts.department.department_id }),
      source: facts.department.quote === 'department_context' ? 'DEPARTMENT_CONTEXT' : 'USER_INPUT',
      reason: facts.department.quote === 'department_context' ? CONTEXT_REASON_SUFFIX : userReason(facts.department.quote),
    }

  const job: JobDraft['job'] = {
    title: facts.title,
    title_source: facts.title_source,
    responsibilities,
    success_profile: template.success_profile.map(toItem),
    must_have: [...template.must_have.map(toItem), ...userMustItems],
    nice_to_have: [...template.nice_to_have.map(toItem), ...userNiceItems],
    rounds,
    ...(departmentBlock === undefined ? {} : { department: departmentBlock }),
    ...(facts.headcount === undefined ? {} : {
      headcount: {
        value: facts.headcount.value,
        source: facts.headcount.quote === 'department_context' ? 'DEPARTMENT_CONTEXT' : 'USER_INPUT',
        reason: facts.headcount.quote === 'department_context' ? CONTEXT_REASON_SUFFIX : userReason(facts.headcount.quote),
      } satisfies FactBlock<number>,
    }),
    ...(facts.level === undefined ? {} : { level: factBlock(facts.level, facts.level.quote === 'department_context') }),
    ...(facts.location === undefined ? {} : { location: factBlock(facts.location, facts.location.quote === 'department_context') }),
    ...(facts.salary === undefined ? {} : { salary: factBlock(facts.salary, facts.salary.quote === 'department_context') }),
    ...(facts.budget === undefined ? {} : { budget: factBlock(facts.budget, facts.budget.quote === 'department_context') }),
    ...(facts.priority === undefined ? {} : { priority: factBlock(facts.priority, facts.priority.quote === 'department_context') }),
    ...(facts.recruitment_reason === undefined ? {} : {
      recruitment_reason: factBlock(facts.recruitment_reason, facts.recruitment_reason.quote === 'department_context'),
    }),
    ...(facts.domain === undefined ? {} : {
      domain_context: { value: facts.domain.value, source: 'USER_INPUT', reason: userReason(facts.domain.quote) },
    }),
  }

  // --- 6) 缺失项（带可直接问用户的问题；blocking 只对"创建前必须确认"的事实为 true）---
  const missing: MissingItem[] = []
  if (departmentBlock === undefined) {
    missing.push({
      field: 'department',
      question: '这个岗位的部门归属是什么？（部门名称或部门 UUID，例如「研发部」）',
      why: '岗位必须归属到一个真实部门；系统不得替你指定组织归属',
      source: 'MISSING',
      blocking: true,
    })
  }
  if (facts.headcount === undefined) {
    missing.push({
      field: 'headcount',
      question: '本次计划招聘几名？（填数字）',
      why: '编制影响招聘节奏与审批口径；未给就不推算',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.level === undefined) {
    missing.push({
      field: 'level',
      question: '这个岗位的职级/级别是什么？（如 P6、高级、资深）',
      why: '职级影响薪酬带宽与面试标准；未给不推断',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.location === undefined) {
    missing.push({
      field: 'location',
      question: '工作地点在哪里？（远程也请明确）',
      why: '地点是候选人的硬约束；未给不推断',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.salary === undefined) {
    missing.push({
      field: 'salary',
      question: '该岗位的薪酬区间是多少？',
      why: '薪酬未给时不得编造；对外 JD 与谈薪都需要企业确认',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.budget === undefined) {
    missing.push({
      field: 'budget',
      question: '该岗位的人力预算/年度预算区间是多少？',
      why: '预算未知时不能假设；PRD §4.1 要求提取预算',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.priority === undefined) {
    missing.push({
      field: 'priority',
      question: '这个岗位的招聘优先级/紧急程度是什么？（如 P0 急招、P1）',
      why: '优先级影响排序与资源投入；未给不推断',
      source: 'MISSING',
      blocking: false,
    })
  }
  if (facts.recruitment_reason === undefined) {
    missing.push({
      field: 'recruitment_reason',
      question: '为什么要招这个岗位？（新增编制 / 替换离职 / 业务扩张）',
      why: '招聘原因决定审批口径与成功标准；未给不推断',
      source: 'MISSING',
      blocking: false,
    })
  }
  missing.push({
    field: 'goal',
    question: '候选人入职后 6–12 个月要达成的业务目标是什么？',
    why: '成功画像与评分标准需要可验证的目标；模板只能给通用画像',
    source: 'MISSING',
    blocking: false,
  })
  if (facts.title_source === 'TEMPLATE_LIBRARY') {
    missing.push({
      field: 'title',
      question: `岗位名称确认为「${facts.title}」吗？如需调整请直接改。`,
      why: '模板只给建议名称；对外发布前需人确认',
      source: 'MISSING',
      blocking: false,
    })
  }
  const educationRationale = rationale.find((entry) => entry.criterion_key === 'education_level')
  if (educationRationale !== undefined && educationRationale.source === 'TEMPLATE_LIBRARY') {
    const educationCriterion = criteria.find((criterion) => criterion.key === 'education_level')
    const educationLabel = typeof educationCriterion?.label === 'string' ? educationCriterion.label : '本科及以上学历'
    missing.push({
      field: 'education_requirement',
      question: `学历要求按「${educationLabel}」执行吗？`,
      why: '学历是模板默认口径（未经企业确认），且只能人判',
      source: 'MISSING',
      blocking: false,
    })
  }
  const experienceRationale = rationale.find((entry) => entry.criterion_key === 'months_of_experience'
    || entry.criterion_key === 'years_of_experience')
  if (experienceRationale !== undefined && experienceRationale.source === 'TEMPLATE_LIBRARY') {
    const experienceCriterion = criteria.find((criterion) => criterion.key === experienceRationale.criterion_key)
    const months = typeof experienceCriterion?.value === 'number' ? experienceCriterion.value : 36
    const years = Math.max(1, Math.round(months / 12))
    missing.push({
      field: 'experience_requirement',
      question: `经验年限按「${years} 年以上」执行吗？`,
      why: '年限是模板默认口径（未经企业确认），改口径只需换值',
      source: 'MISSING',
      blocking: false,
    })
  }

  // --- 7) 历史参考（只对照，不合并）---
  const history = buildHistory(input, template)

  return {
    read_only: true,
    zero_write: true,
    status: 'OK',
    template: {
      template_id: template.template_id,
      family: template.family,
      label: template.label,
      reason: selection.explicit
        ? '调用方显式指定 template_id'
        : `用户需求命中模板关键词：${selection.matched_keywords.join('、')}（模板库选择，需人确认）`,
      source: 'TEMPLATE_LIBRARY',
    },
    job,
    rubric_draft: {
      criteria,
      rationale,
      hard_gates: hardGates,
      round_focus: roundFocus,
      scorecard_fields: scorecardFields,
      weight_sum: weightSum,
    },
    missing_items: missing,
    warnings: warnings.map((warning) => ({ code: warning.code, message: warning.message })),
    ...(history === undefined ? {} : { history }),
    confirmation: confirmationBlock(),
  }
}

/** 把模板维度剥掉元数据（reason/source/match_tags），得到 criterion 核心。 */
function stripTemplateMeta(dimension: TemplateCriterion): MutableCriterionCore {
  return {
    key: dimension.key,
    label: dimension.label,
    kind: dimension.kind,
    ...(dimension.field === undefined ? {} : { field: dimension.field }),
    ...(dimension.operator === undefined ? {} : { operator: dimension.operator }),
    ...(dimension.value === undefined ? {} : { value: dimension.value }),
    ...(dimension.question === undefined ? {} : { question: dimension.question }),
    notes: dimension.notes,
  }
}

/** 组装历史参考块（无历史输入时返回 undefined，键整个省略）。 */
function buildHistory(input: JobDraftInput, template: JobTemplate): HistoryBlock | undefined {
  const jobs = input.historical_jobs ?? []
  const rubrics = input.historical_rubrics ?? []
  if (jobs.length === 0 && rubrics.length === 0) return undefined
  const matchedJobs: {
    title: string
    matched_because: string
    source: 'HISTORY'
    code?: string
    status?: string
  }[] = []
  for (const job of jobs) {
    const hit = template.keywords.find((keyword) => keywordHit(job.title, keyword))
    if (hit === undefined) continue
    matchedJobs.push({
      title: job.title,
      matched_because: `标题命中模板关键词：${hit}`,
      source: 'HISTORY',
      ...(job.code === undefined ? {} : { code: job.code }),
      ...(job.status === undefined ? {} : { status: job.status }),
    })
  }
  const referenceRubrics: HistoryBlock['reference_rubrics'] = rubrics.map((rubric) => {
    const keys = (rubric.dimensions ?? []).map((dimension) => dimension.key)
    return {
      dimension_keys: [...new Set(keys)],
      note: '仅作参考：历史标准未合并进本草案（避免静默继承过期口径）',
      source: 'HISTORY',
      ...(rubric.version_no === undefined ? {} : { version_no: rubric.version_no }),
      ...(rubric.job_id === undefined ? {} : { job_id: rubric.job_id }),
    }
  })
  return {
    matched_jobs: matchedJobs,
    reference_rubrics: referenceRubrics,
    reason: '调用方提供了历史岗位/Rubric：只用于对照，不改变本草案的维度与权重（模板库与用户原话优先）',
  }
}

// ---------------------------------------------------------------------------
//  草案 → 现有 job_create 入参（草案与版本化写入路径之间唯一的桥）
// ---------------------------------------------------------------------------

/** `recruitment_job_create` 的入参形状（本服务只会产这个子集）。 */
export interface JobCreateArgs {
  readonly title: string
  readonly department_id?: string
  readonly department_name?: string
  readonly description_md: string
  readonly requirements_md: string
  readonly status: 'DRAFT'
  readonly criteria: readonly Record<string, unknown>[]
}

/**
 * 取 Rubric 草案的纯 criterion 数组（浅拷贝；可直接作为 job_create 的 criteria）。
 * @param draft - 岗位草案。
 */
export function toRubricDimensions(draft: JobDraft): readonly Record<string, unknown>[] {
  return draft.rubric_draft.criteria.map((criterion) => ({ ...criterion }))
}

/**
 * 把草案映射到现有 `recruitment_job_create` 的入参。
 *
 * 三个只能在这里做的保证：
 *   1. 部门只输出一个键（有 id 用 id、否则用名称），避免 job_create 的 MUTUALLY_EXCLUSIVE；
 *   2. JD/需求正文各 ≤20000（job_create 的上限），超了直接报错而不是截断；
 *   3. criteria 再过一遍 `validateDimensions`——草案层已经验过，这里是**写入前的最后一道闸**，
 *      不通过就抛错（绝不把不合 R-VAL 的标准交给版本化路径）。
 * @param draft - 岗位草案。
 * @returns 可直接传给 `createJobInTransaction` / `recruitment_job_create` 的参数。
 * @throws JobDraftError - 标题/正文超限或 criteria 不合法时抛。
 */
export function toJobCreateArgs(draft: JobDraft): JobCreateArgs {
  const title = draft.job.title.trim()
  if (title.length < 1 || title.length > 200) {
    throw new JobDraftError('CRITERIA_INVALID', '岗位名称必须在 1..200 字符之间', { length: title.length })
  }
  const description = toJobDescriptionMarkdown(draft)
  const requirements = toJobRequirementsMarkdown(draft)
  if (description.length > MAX_JD_CHARS || requirements.length > MAX_JD_CHARS) {
    throw new JobDraftError('JD_TOO_LONG', `JD 正文超过 ${MAX_JD_CHARS} 字符`, {
      description_length: description.length,
      requirements_length: requirements.length,
      max: MAX_JD_CHARS,
    })
  }
  const criteria = toRubricDimensions(draft)
  const violations = validateDimensions(criteria)
  if (violations.length > 0) {
    throw new JobDraftError('CRITERIA_INVALID', '草案 criteria 没有通过 R-VAL-1..13，拒绝映射到 job_create', {
      violations: violations.map((violation) => ({
        rule: violation.rule,
        reason_code: violation.reason_code,
        path: violation.path,
      })),
    })
  }
  const department = draft.job.department
  // 有 id 用 id（避免重名歧义），否则用名称；job_create 不接受两者同时出现（MUTUALLY_EXCLUSIVE）。
  const departmentId = department?.department_id
  const departmentName = department?.value
  return {
    title,
    ...(departmentId === undefined ? {} : { department_id: departmentId }),
    ...(departmentId !== undefined || departmentName === undefined
      ? {} : { department_name: departmentName }),
    description_md: description,
    requirements_md: requirements,
    status: 'DRAFT',
    criteria,
  }
}

// ---------------------------------------------------------------------------
//  草案 → markdown（JD 正文 / 需求正文；来源与待确认项必须显式标出）
// ---------------------------------------------------------------------------

/** 来源的中文标签（markdown 里给人看）。 */
function sourceLabel(source: DraftSource): string {
  switch (source) {
    case 'USER_INPUT': return '用户原话'
    case 'DEPARTMENT_CONTEXT': return '企业/部门上下文'
    case 'HISTORY': return '历史参考'
    case 'TEMPLATE_LIBRARY': return '模板库'
    case 'DEFAULT_SUGGESTION': return '系统默认建议'
    case 'MISSING': return '缺失待确认'
    default: return String(source)
  }
}

/** 渲染"有值 / 待确认"的一行事实。 */
function factLine(label: string, fact: FactBlock<unknown> | DepartmentFactBlock | undefined): string {
  if (fact === undefined) return `- ${label}：未提供，待确认（见「待人类确认清单」）`
  const shown = 'value' in fact && typeof fact.value !== 'undefined'
    ? String(fact.value)
    : '（已提供 department_id，未提供显示名称）'
  return `- ${label}：${shown}（来源：${sourceLabel(fact.source)}；${fact.reason}）`
}

/** 渲染 markdown 列表（带来源与理由）。 */
function renderSourcedItems(items: readonly SourcedTextItem[]): string[] {
  if (items.length === 0) return ['- （无）']
  return items.map((item) => `- ${item.text}（来源：${sourceLabel(item.source)}；理由：${item.reason}）`)
}

/**
 * 把草案渲染成 JD 正文（markdown）。**不含任何时间戳/随机**（保证同输入逐字节一致）。
 * @param draft - 岗位草案。
 * @returns JD markdown（≤20000 字符由 `toJobCreateArgs` 再校验）。
 */
export function toJobDescriptionMarkdown(draft: JobDraft): string {
  const lines: string[] = []
  lines.push(`# ${draft.job.title}（草案 · 待人类确认）`)
  lines.push('')
  lines.push('> 本 JD 由 `recruitment_job_draft` 生成，**未经人类确认不得对外发布**；草案生成零写入。')
  lines.push(`> 模板：${draft.template.template_id}（${draft.template.family} / ${draft.template.label}，来源：模板库）`)
  lines.push(`> 契约：job-draft ${JOB_DRAFT_CONTRACT_VERSION}；Rubric 草案可直接作为 \`recruitment_job_create\` 的 criteria。`)
  lines.push('')
  lines.push('## 一、招聘原因与业务上下文')
  lines.push(factLine('招聘原因', draft.job.recruitment_reason))
  lines.push(factLine('业务方向', draft.job.domain_context))
  lines.push('')
  lines.push('## 二、岗位职责')
  lines.push(...renderSourcedItems(draft.job.responsibilities))
  lines.push('')
  lines.push('## 三、成功画像')
  lines.push(...renderSourcedItems(draft.job.success_profile))
  lines.push('')
  lines.push('## 四、必备条件')
  lines.push(...renderSourcedItems(draft.job.must_have))
  lines.push('')
  lines.push('## 五、加分项')
  lines.push(...renderSourcedItems(draft.job.nice_to_have))
  lines.push('')
  lines.push('## 六、面试流程与每轮考察点')
  const rationaleByKey = new Map(draft.rubric_draft.rationale.map((entry) => [entry.criterion_key, entry]))
  for (const [index, round] of draft.job.rounds.entries()) {
    lines.push(`### ${index + 1}. ${round.name}（来源：${sourceLabel(round.source)}）`)
    lines.push(`- 理由：${round.reason}`)
    for (const focus of round.focus) lines.push(`- 重点：${focus}`)
    const focusEntry = draft.rubric_draft.round_focus.find((entry) => entry.round === round.name)
    if (focusEntry !== undefined && focusEntry.criteria_keys.length > 0) {
      lines.push(`- 考察维度：${focusEntry.criteria_keys.join('、')}`)
    }
  }
  lines.push('')
  lines.push('## 七、工作地点、职级、薪酬与编制')
  lines.push(factLine('工作地点', draft.job.location))
  lines.push(factLine('职级/级别', draft.job.level))
  lines.push(factLine('薪酬区间', draft.job.salary))
  lines.push(factLine('人力预算', draft.job.budget))
  lines.push(factLine('招聘人数', draft.job.headcount))
  lines.push(factLine('招聘优先级', draft.job.priority))
  lines.push('')
  lines.push('## 八、部门归属')
  lines.push(factLine('部门', draft.job.department))
  lines.push('')
  lines.push('## 九、Rubric 草案（筛选标准，待人类批准）')
  lines.push(`- 维度数：${draft.rubric_draft.criteria.length}；权重合计：${draft.rubric_draft.weight_sum}`)
  for (const criterion of draft.rubric_draft.criteria) {
    const key = String(criterion.key)
    const rationale = rationaleByKey.get(key)
    const kind = String(criterion.kind)
    const weight = String(criterion.weight)
    const sourceText = rationale === undefined ? '' : `；来源：${sourceLabel(rationale.source)}；理由：${rationale.reason}`
    if (typeof criterion.field === 'string') {
      lines.push(`- [${kind}] ${String(criterion.label)}（key=${key}，weight=${weight}；机械判定：${criterion.field} ${String(criterion.operator)} ${String(criterion.value)}${sourceText}）`)
    } else {
      lines.push(`- [${kind}] ${String(criterion.label)}（key=${key}，weight=${weight}；需人判：${String(criterion.question ?? '')}${sourceText}）`)
    }
  }
  lines.push('')
  lines.push('## 十、待人类确认清单')
  if (draft.missing_items.length === 0) {
    lines.push('- （无缺失项）')
  } else {
    for (const item of draft.missing_items) {
      const blocking = item.blocking ? '【创建前必须确认】' : ''
      lines.push(`- [ ] ${blocking}${item.question}（字段：${item.field}；原因：${item.why}）`)
    }
  }
  lines.push('')
  lines.push('## 十一、边界声明')
  lines.push('- 本草案零写入：不建岗位、不写标准、不批准任何东西。')
  lines.push('- 确认/修改必须由人完成：确认后由人调用 `recruitment_job_create`；标准必须由人走 `recruitment_job_rubric_approve`。')
  lines.push('- 机械化字段只用 §6.3 白名单（年限/工作经历条目数/教育经历条目数/有工作经历/有教育经历）；学历、行业、软技能一律判断型。')
  return lines.join('\n')
}

/**
 * 把草案渲染成"任职要求"正文（markdown）。
 * @param draft - 岗位草案。
 * @returns 任职要求 markdown。
 */
export function toJobRequirementsMarkdown(draft: JobDraft): string {
  const lines: string[] = []
  lines.push(`# ${draft.job.title} · 任职要求（草案 · 待人类确认）`)
  lines.push('')
  lines.push('## 必备条件')
  lines.push(...renderSourcedItems(draft.job.must_have))
  lines.push('')
  lines.push('## 加分项')
  lines.push(...renderSourcedItems(draft.job.nice_to_have))
  lines.push('')
  lines.push('## 评分表字段')
  for (const field of draft.rubric_draft.scorecard_fields) {
    lines.push(`- ${field.label}（key=${field.key}，类型=${field.type}；来源：${sourceLabel(field.source)}；理由：${field.reason}）`)
  }
  lines.push('')
  lines.push('## 筛选标准（Rubric 草案，待人类批准）')
  const rationaleByKey = new Map(draft.rubric_draft.rationale.map((entry) => [entry.criterion_key, entry]))
  for (const criterion of draft.rubric_draft.criteria) {
    const key = String(criterion.key)
    const rationale = rationaleByKey.get(key)
    lines.push(`- [${String(criterion.kind)}] ${String(criterion.label)}（key=${key}，weight=${String(criterion.weight)}）`
      + (rationale === undefined ? '' : `（来源：${sourceLabel(rationale.source)}；理由：${rationale.reason}）`))
  }
  lines.push('')
  lines.push('## 待明确项（未给即不编造）')
  for (const item of draft.missing_items) {
    lines.push(`- ${item.question}（字段：${item.field}）`)
  }
  if (draft.missing_items.length === 0) lines.push('- （无）')
  lines.push('')
  lines.push('> 本文件是草案：确认/修改必须由人完成；生成过程零写入。')
  return lines.join('\n')
}
