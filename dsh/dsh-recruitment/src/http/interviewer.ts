// 宿主侧**只读** HTTP 路由 + read model：Interviewer Workspace（W3-A）。
//
// 端点（契约 `work/d5/w3/W3-CONTRACT.md` §1）：
//   GET /recruitment/api/interviewer/overview?alias=<alias>[&interview_id=<uuid>]
//
// 六条边界（每条都对应一种真实的失败方式，所以写在这里而不是散在代码里）：
//
//   1. **只读**：读路径跑在 `withReadOnly()`（`begin transaction read only`）里，任何写语句会被
//      PG 以 25006 拒绝 —— "只读"是数据库强制的，不是"本文件没写 INSERT"这种自觉。
//      `readInterviewerWorkspace()` 自己不建池、不开事务（由调用方给事务内 client）。
//   2. **同源**：复用 `overview.ts::sameOrigin()`（loopback + `x-recruitment-request: 1` + Origin
//      同源）。非回环监听时**不注册**路由（fail-closed）：宁可面板读不到，也不把业务投影挂到
//      网络可达的地址上。
//   3. **身份来源单一**：actor 只来自 W1 的 `SessionActorRegistry`（`X-DSH-Session` → alias →
//      actor_id，经 `InterviewerSessionActorResolver` 这个窄口进入）。本文件**不**实现第二套
//      alias→actor 映射；客户端任何 `actor_id`/`tenant_id`（query 或 header）在**碰 DB 之前** 400。
//   4. **复用而非重写**（R1）：`transcript.state/reason_code` 必须调
//      `interview-get.ts::readInterviewValue()`（`contracts/interview/transcript-rules.md` §4 TR-D
//      的唯一实现）；`labels.provenance` 必须调 `candidate-get.ts::resolveTenantProvenance()`
//      （R4 / `contracts/tenant-provenance.md` §2 的唯一判定）。本文件没有第二套 TR-D SQL，
//      也没有第二套 provenance 判定 —— 两份实现迟早会漂移（C-4）。
//   5. **隐私：只看得到自己的面评**。一场面试有多个面试官时，`readInterviewValue()` 返回的是
//      **所有人**的当前面评（它服务的是 HR/Agent 视角）。本文件只取
//      `interviewers[].actor_id === 我` 的那一行：别人的面评内容、状态、是否存在都不进响应，
//      也不进 `issues`。「其他面试官的主观评分与私人备注默认不展示」是产品语义，不是可选项。
//   6. **不猜**：申请钉住的 rubric 不属于该申请岗位 → rubric 置空 + `issues` 说明（不挑一个
//      "看起来对"的版本）；没有模板但有 rubric 维度 → `source='JOB_RUBRIC'`（标注来源，绝不
//      把 rubric 维度冒充面试简报原文）；库读失败 → 抛错由 HTTP 层映射 5xx（**不得**伪装成空列表）。
//
// 出参类型是本文件冻结的契约（§1.4）：**既有字段名逐字一致、不增删**；task-50 只做加法——
// `interviews[]` 每个元素新增 `round_focus` / `effective_rubric`（W3b 消费），其余块不变。
// 客户端 `src/client/interviewer/**`
// 只用 `import type` 引用它们，不会把服务端代码打进浏览器产物。
//
// W3b（轮次重点）：`interviews[]` 的元素在既有 `brief`/`rubric` 之外**新增两个键**
// （`brief`/`rubric` 形状不动，向后兼容）：
//   · `round_focus`      —— 本轮重点（模板 objective/briefing.summary/focus/questions/feedback_form）；
//     没有可套用的轮次配置时**如实降级** `source='JOB_BASE', available=false` + 中文 `reason`，
//     绝不把岗位 rubric 维度或岗位名冒充成"本轮重点"。
//   · `effective_rubric` —— 面评真正可提交的 rubric 投影：维度宇宙**恒为申请钉住的岗位 rubric**
//     （D-89/SC-13 的提交键集不变），轮次配置只能标记 focus/must_cover 与覆盖显示权重；
//     模板声明的 rubric 版本与申请钉住版本冲突时**不混用**（回显 + reason + issue）。
//   三条守卫（跨岗位 / 轮次不符 / 模板无内容）降级到 JOB_BASE 并写清原因，绝不"猜一个看起来对"。
//
// 单测所需的**纯**辅助函数（不碰 DB，故单独导出；见 `test/unit/interviewer-overview.test.ts`）：
//   · `parseInterviewerQuery(url)` —— §1.1 的 query 形状（未知参数 / 缺 alias / 非 UUID）
//   · `requireSessionId(req)`      —— §1.1 的 `X-DSH-Session` 形状（缺失 / 超长 / 重复）
//   · `toInterviewRow({value, extension, actorId})` —— 一个面试元素的行映射（含自己的面评提取、
//     brief/materials/rubric 的降级路径、rubric 越界的 issue、round_focus/effective_rubric 的组装）
//   · `buildRoundFocus(facts)` / `buildEffectiveRubric(facts)` / `collectRoundIssues(facts)` ——
//     W3b 的两个块与轮次侧 issue 的唯一构造函数（recruiting.ts 复用同一份，不写第二套）
//   · `deriveCounts(rows)`         —— §1.4 的六个计数（服务端算，客户端不重算）
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { resolveTenantProvenance } from '../tools/candidate-get.ts'
import { contractError, isUuid } from '../tools/contract.ts'
import {
  readInterviewValue,
  type InterviewValue,
  type MeetingBindingState,
  type TranscriptReasonCode,
  type TranscriptState,
} from '../tools/interview-get.ts'
// 同源校验只许有一份实现（overview 路由与本路由必须同口径）；overview 未导出错误映射，
// 那部分在本文件下半部分按同一张表重写（见 `STATUS_BY_CODE` 的说明）。
import { sameOrigin } from './overview.ts'
// 候选人约束读投影（碎片约束置顶 + 下一轮交接提醒）：复用 db/domain 单一实现。
import {
  readPinsForCandidates,
  readHandoffsForInterviews,
  UNPIN_TOMBSTONE_TEXT,
  type CandidateConstraintRow,
} from '../db/candidate-constraint.ts'
import {
  toPinProjection,
  toHandoffProjection,
  type PinProjection,
  type HandoffProjection,
} from '../domain/candidate-constraint.ts'

// =====================================================================
//  契约常量
// =====================================================================

/** §1.4 的契约版本（冻结字符串，客户端按它做版本兼容）。 */
const CONTRACT_VERSION = 'interviewer-workspace 1.0.0'
/** 每个列表的上限（§1.3：默认 20，**不可**由 HTTP 入参放大）。 */
const DEFAULT_SECTION_LIMIT = 20
/**
 * 路由前缀。
 *
 * 契约 §1.1 写的是 `kind:'prefix', path:'/recruitment/api'`（与 overview 同一挂法）。
 * 但宿主 `webServer.register()` 对**重复的 (kind, path) 直接抛错**
 * （`@deepseek-ai/dsh-host-webserver` 的 `register` 文档："Duplicate (kind, path) throws"），
 * 而 `/recruitment/api` 已被 `overview.ts` 注册 —— 再注册同一前缀会让本插件整个 inject 失败。
 * 宿主路由匹配是「exact 优先，其次最长前缀」，所以本路由注册在更长的前缀上，
 * **对外 URL 与契约逐字相同**：`GET /recruitment/api/interviewer/overview`。
 * （W2 的 recruiting 路由出于同一原因注册在 `/recruitment/api/recruiting`。）
 */
const ROUTE_PREFIX = '/recruitment/api/interviewer'
/** 端点路径（§1.1）。 */
const OVERVIEW_PATH = `${ROUTE_PREFIX}/overview`
/**
 * Session 身份头（Gate 0 实测浏览器可从 `localStorage['dsh.sessions.current']` 拿到；
 * W0 的 shell 用它作为绑定键）。
 */
const SESSION_HEADER = 'x-dsh-session'
/** §1.1：session id 超过 200 字 → 400（绑定键不可能那么长）。 */
const MAX_SESSION_ID_LENGTH = 200
/** 客户端**不许**覆盖的身份头（命中即 400，且不碰 DB）。 */
const ACTOR_OVERRIDE_HEADERS = ['x-recruitment-actor', 'x-recruitment-tenant'] as const
/** §1.1：只允许 `alias`（必填）与 `interview_id`（可选 UUID）两个 query 参数。 */
const ALLOWED_PARAMS = ['alias', 'interview_id'] as const
/** 响应绝不缓存（读的是真实业务状态，缓存会让"刚提交的面评"看不见）。 */
const NO_STORE = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const
/** §1.4：`counts.open_interview_total` 只排除这三个终态（其余状态都算"未终结"）。 */
const CLOSED_INTERVIEW_STATUSES: ReadonlySet<string> = new Set(['DECIDED', 'CANCELLED', 'NO_SHOW'])
/** §1.4：本场面试的授权依据恒为"我是这场面试登记过的面试官"。 */
const MATERIALS_AUTHORIZATION = 'INTERVIEW_ASSIGNMENT' as const
/** 文件头第 2 条：非回环地址不注册路由。 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1'])

// =====================================================================
//   §1.2 身份解析端口（W1 的 SessionActorRegistry 只经这个窄口进入）
// =====================================================================

/**
 * 一条 session → actor 的绑定（只读快照）。
 *
 * 为什么把 alias 与 actor_id 放在同一条记录里：两者必须来自**同一个**绑定事实；
 * 分开解析会出现"alias 是 A、actor 是 B"的裂缝，而 W3 的所有过滤都按 actor_id 做。
 */
export interface InterviewerActorBinding {
  readonly session_id: string
  readonly alias: string
  /** HUMAN actor UUID（来自服务端受管配置/种子；浏览器永远不提交 UUID）。 */
  readonly actor_id: string
  readonly display_name?: string
}

/**
 * 身份解析端口（构造注入；**不注入 = 一律 409**，fail-closed）。
 *
 * 为什么是接口而不是 import W1 的 registry：W3 不许依赖 W1 的模块图（W1 由 W0 接线），
 * 而且这样本文件的单测可以在**不碰 DB**的情况下穷举 409/403 分支。
 */
export interface InterviewerSessionActorResolver {
  resolve(sessionId: string): InterviewerActorBinding | undefined | null
}

// =====================================================================
//  §1.4 响应形状（冻结；**既有字段**逐字一致；task-50 加法扩展 `round_focus`/`effective_rubric`）
// =====================================================================

/** 工作台身份（`actor` 块）。 */
export interface InterviewerWorkspaceActor {
  readonly alias: string
  readonly actor_id: string
  /** 以库里的 `actor.display_name` 为准（两个来源不一致时不编造）。 */
  readonly display_name: string
  /** 角色**标签**（`actor_role`，D-33：标签不参与归属判定）；没有角色时是空数组。 */
  readonly roles: readonly string[]
}

/** `session` 块：这份视图是哪个 DSH Session 读出来的（客户端据此判断是不是过期视图）。 */
export interface InterviewerWorkspaceSession {
  readonly session_id: string
}

/** 三维标签（R4）：provenance 由库判定，trigger/connection 由本投影的性质决定。 */
export interface InterviewerWorkspaceLabels {
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly trigger: 'MANUAL'
  readonly connection: 'CONNECTED'
}

/** §1.4 的六个计数（服务端算；无数据时是 0，不是 `undefined`/`NaN`）。 */
export interface InterviewerCounts {
  readonly assigned_total: number
  /** status ∉ {DECIDED, CANCELLED, NO_SHOW}。 */
  readonly open_interview_total: number
  /** `required_scorecard` 且 scorecard.state ∈ {NONE, PENDING}。 */
  readonly pending_scorecard_total: number
  readonly submitted_scorecard_total: number
  /** transcript.state === 'READY'。 */
  readonly transcript_ready_total: number
  /** transcript.state === 'MISSING'（"还在等"的 PENDING 不算缺失，TR-D3）。 */
  readonly transcript_missing_total: number
}

/** 候选人（业务对象，不是系统用户 —— 只给展示名，不给联系方式）。 */
export interface InterviewerCandidate {
  readonly candidate_id: string
  readonly display_name: string
}

/** 岗位（`code`/`title` 只来自库）。 */
export interface InterviewerJob {
  readonly job_id: string
  readonly code: string
  readonly title: string
}

/** 简报里的一个考察重点。 */
export interface InterviewerBriefFocus {
  readonly key: string
  readonly label: string
  readonly weight: number
}

/** 简报来源的封闭集：TEMPLATE（有面试模板）/ JOB_RUBRIC（只有 rubric 维度）/ NONE。 */
export type InterviewerBriefSource = 'TEMPLATE' | 'JOB_RUBRIC' | 'NONE'

/**
 * `brief` 块（§1.4）。
 *
 * `source` 是**诚实标注**：`JOB_RUBRIC` 时 `focus` 来自申请钉住的 rubric 维度、
 * `questions` 恒空 —— 绝不能把 rubric 维度当成"面试模板原文"（那是编造）。
 */
export interface InterviewerBrief {
  readonly available: boolean
  readonly source: InterviewerBriefSource
  readonly objective: string | null
  readonly briefing: string | null
  readonly focus: readonly InterviewerBriefFocus[]
  readonly questions: readonly string[]
  readonly template_version_id: string | null
  readonly template_payload_hash: string | null
  /** 只在 `source='NONE'` 时非空：为什么没有简报（不猜业务原因）。 */
  readonly reason: string | null
}

/**
 * 面试官简报里的候选人约束（docs/34 §2「碎片约束置顶 + 下一轮交接提醒」）。
 *
 * 加法键：既有 `brief`/`rubric`/`round_focus` 等形状不动。只投影文本/来源/作者/时间，
 * 不吐任何内部 id；`handoff` 是本轮 interview 对应的**上一轮留的**提醒（最多一条）。
 */
export interface InterviewerCandidateConstraints {
  readonly pins: readonly PinProjection[]
  readonly handoff: HandoffProjection | null
}

/** rubric 的一个维度（`question` 恒定存在，没有时是 null —— 形状冻结）。 */
export interface InterviewerRubricDimension {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  readonly question: string | null
}

/** `rubric` 块（申请钉住的 rubric 版本；不属于该申请岗位时整个块是 null）。 */
export interface InterviewerRubric {
  readonly rubric_version_id: string
  readonly job_id: string
  readonly payload_hash: string
  readonly dimensions: readonly InterviewerRubricDimension[]
}

/**
 * 轮次重点的一个考察维度（§1.4 `round_focus.focus_dimensions` 元素）。
 *
 * `in_rubric=false` 表示模板声明了一个岗位 rubric 里没有的维度：**只展示，不进面评提交键集**
 * （`effective_rubric.dimensions` 的宇宙恒为岗位 rubric，见 `buildEffectiveRubric`）。
 */
export interface RoundFocusDimension {
  readonly key: string
  readonly label: string
  /** 模板给了数值 weight 就用模板；缺省回退到岗位 rubric 同名维度，再缺省 0。 */
  readonly weight: number
  /** `focus_attributes` 元素 `required===true` 或 `must_cover===true`。 */
  readonly required: boolean
  readonly in_rubric: boolean
}

/** 一条建议问题（§1.4 `round_focus.questions` 元素）；`key` 只在模板元素自带非空 key 时非 null。 */
export interface RoundFocusQuestion {
  readonly key: string | null
  readonly text: string
}

/** 评分表字段（`round_focus.scorecard_fields` 与 `effective_rubric.scorecard.fields` 同形）。 */
export interface RoundFocusScorecardField {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly required: boolean
}

/**
 * `round_focus` 块（§1.4，W3b）：本场面试**这一轮**的重点。
 *
 * `source` 是诚实标注：只有从 `interview_template_version` 真正套用出轮次内容时才是
 * `ROUND_CONFIG`；否则 `JOB_BASE`（`available=false` + `reason` 说明为什么不能声称本轮重点）。
 * 已绑定但不可套用的模板身份（id/version/hash）仍如实回显 —— 那是"绑过哪个模板"的事实。
 */
export interface RoundFocus {
  readonly available: boolean
  readonly source: 'ROUND_CONFIG' | 'JOB_BASE'
  readonly round_no: number
  readonly template_version_id: string | null
  readonly template_version_no: number | null
  readonly template_payload_hash: string | null
  readonly title: string | null
  readonly description: string | null
  readonly focus_dimensions: readonly RoundFocusDimension[]
  readonly questions: readonly RoundFocusQuestion[]
  readonly scorecard_fields: readonly RoundFocusScorecardField[]
  readonly reason: string | null
}

/** `effective_rubric.dimensions` 的一个维度（**宇宙恒为申请钉住的岗位 rubric**）。 */
export interface EffectiveRubricDimension {
  readonly key: string
  readonly label: string
  readonly kind: string
  readonly weight: number
  /** D-89/SC-13：面评必答，恒 true。 */
  readonly required: boolean
  /** 本轮重点（focus_attributes 命中同名 key；JOB_BASE 时恒 false）。 */
  readonly focus: boolean
  /** 本轮必覆盖（focus_attributes 元素 required/must_cover===true）。 */
  readonly must_cover: boolean
  /** 该维度是否被轮次配置标记过（标记过 = ROUND_OVERRIDE）。 */
  readonly origin: 'JOB_BASE' | 'ROUND_OVERRIDE'
  readonly question: string | null
}

/** `effective_rubric.scorecard`：评分表口径（scale 来自 feedback_form，fields 恒 = 维度映射）。 */
export interface EffectiveRubricScorecard {
  readonly scale: { readonly min: number; readonly max: number } | null
  readonly fields: readonly RoundFocusScorecardField[]
}

/** `effective_rubric.submission`：面评提交真正绑定的版本与键集（D-89/SC-13）。 */
export interface EffectiveRubricSubmission {
  readonly rubric_version_id: string
  readonly dimension_keys: readonly string[]
}

/**
 * `effective_rubric` 块（§1.4，W3b）：面评真正可提交的 rubric 投影。
 *
 * 三条不变量：
 *   · 维度宇宙恒 = **申请钉住的岗位 rubric**（顺序不变）——轮次配置只能标记 focus/must_cover
 *     与覆盖显示权重，**不换维度集合**（D-89/SC-13 的提交键集不变）；
 *   · 模板声明的 rubric 版本与申请钉住版本不一致时**不混用**：如实回显 + `reason` 说明；
 *   · 申请钉住的 rubric 越界/缺失时 `available=false` + `reason`，不猜版本（不抛错）。
 */
export interface EffectiveRubric {
  readonly available: boolean
  readonly source: 'JOB_BASE' | 'ROUND_OVERRIDE'
  readonly round_no: number
  readonly job_id: string
  readonly rubric_version_id: string
  readonly rubric_version_no: number
  readonly rubric_payload_hash: string
  readonly base_rubric_version_id: string | null
  readonly template_version_id: string | null
  readonly template_version_no: number | null
  readonly template_payload_hash: string | null
  readonly declared_round_rubric_version_id: string | null
  readonly dimensions: readonly EffectiveRubricDimension[]
  readonly scorecard: EffectiveRubricScorecard
  readonly submission: EffectiveRubricSubmission
  readonly reason: string | null
}

/** 授权材料里的一份简历版本（`fields` 是 `parsed_fields` **原样**，不裁剪、不编造）。 */
export interface InterviewerResumeMaterial {
  readonly resume_version_id: string
  readonly parse_status: string
  readonly parser_name: string
  readonly parser_version: string
  readonly content_sha256: string
  readonly fields: Readonly<Record<string, unknown>>
}

/** `materials` 块（候选人是业务对象，授权依据是"我是这场的面试官"）。 */
export interface InterviewerMaterials {
  readonly authorization: typeof MATERIALS_AUTHORIZATION
  readonly available: boolean
  /** 不可用时的机器原因（NO_MATERIAL_BOUND / PARSE_FAILED / NOT_PARSED）；可用时 null。 */
  readonly reason: string | null
  readonly resume: InterviewerResumeMaterial | null
}

/**
 * `transcript` 块（材料分支）。
 *
 * `state`/`reason_code`/`no_transcript` **原样来自** `readInterviewValue()`（TR-D 单一实现）；
 * `meeting_binding_state`/`meetings_total` 来自它的 `meeting_binding` 块（§1.5：直接取）。
 * `meetings_total` 就是**活跃绑定条数**（`meeting_binding.count`），不在本文件重算 M(i)。
 */
export interface InterviewerTranscript {
  readonly state: TranscriptState
  readonly reason_code: TranscriptReasonCode
  readonly no_transcript: boolean
  readonly meeting_binding_state: MeetingBindingState
  readonly meetings_total: number
}

/** scorecard 状态封闭集：NONE(未填) / PENDING(草稿) / SUBMITTED(已提交) / WAIVED(已豁免)。 */
export type InterviewerScorecardState = 'NONE' | 'PENDING' | 'SUBMITTED' | 'WAIVED'

/** `scorecard` 块（**只有我自己**这一行；别人的面评不存在于任何字段里）。 */
export interface InterviewerScorecard {
  readonly state: InterviewerScorecardState
  readonly scorecard_id: string | null
  readonly status: string | null
  readonly revision_no: number | null
  readonly record_version: number | null
  readonly submitted_at: string | null
  /** `scorecard.items.transcript_basis`（缺该键时是 `'UNKNOWN'`，TR-E2 的原值）。 */
  readonly transcript_basis: string | null
  readonly overall: string | null
}

/** `required_action` 封闭集。 */
export type InterviewerRequiredAction = 'SUBMIT_SCORECARD' | 'REVIEW_SCORECARD' | 'NONE'

// ---------------------------------------------------------------------
//  task-51：前置轮次摘要 + 本轮参考（冻结于 `work/d5/interviewer-brief/DESIGN.md` §1）
//
//  产品口径：当前这一轮的面试官只看**紧邻上一轮**的结构化事实（聊过哪些主题 / 上一轮怎么评的 /
//  哪些维度没覆盖），外加 2–4 条"可以重点了解什么 + 为什么值得问"。**参考不是指令**：不写
//  "必须问/应该问"，不排顺序；渲染文本遵守 D-141（无 UUID / 哈希 / snake_case 字段名 / 路径 /
//  枚举机器码）。形状是冻结契约，**既有字段一个都不动**，这里只做加法。
// ---------------------------------------------------------------------

/**
 * 前置轮次里一位面试官的面评结论（**不抄** `items[*].note` / `rationale` 原文）。
 */
export interface PriorRoundInterviewer {
  /** `actor.display_name` 原文；库里没有显示名 → `''`（不编造）。 */
  readonly display_name: string
  /** 该面试官**当前**面评（`superseded_by_scorecard_id is null`）的状态封闭集。 */
  readonly scorecard_state: 'NONE' | 'PENDING' | 'SUBMITTED' | 'WAIVED'
  readonly scorecard_submitted: boolean
  /** `scorecard.overall` 原值（ADVANCE/HOLD/REJECT）；未提交/无面评 → null。 */
  readonly conclusion: string | null
}

/** 前置轮次维度（岗位标准维度；`key` 只用于对齐/复核，客户端不渲染）。 */
export interface PriorRoundDimension {
  readonly key: string
  readonly label: string
  readonly weight: number
}

/** 未覆盖维度的原因码（可由 SQL + 面评 items 复核）。 */
export type PriorRoundUncoveredReason =
  | 'NO_SCORECARD'
  | 'NO_ITEMS'
  | 'NOT_RATED'
  | 'NOT_OBSERVED'
  | 'UNREADABLE'

/** 未被覆盖的维度 + 可复核的原因码。 */
export interface PriorRoundUncoveredDimension extends PriorRoundDimension {
  readonly reason: PriorRoundUncoveredReason
}

/** 已被覆盖的维度 + 该轮面评里的判定原值。 */
export interface PriorRoundCoveredDimension extends PriorRoundDimension {
  /** 只能是 MET / NOT_MET（只有这两种是"给了实质评分/判定"）。 */
  readonly assessment: 'MET' | 'NOT_MET'
  /** 1..5 的整数；面评没给（违反契约的脏数据）→ null。 */
  readonly score: number | null
}

/** 一场前置轮次的面试（一场面试一个元素；同一轮多场就多个元素）。 */
export interface PriorRound {
  readonly round_no: number
  readonly interview_id: string
  readonly status: string
  readonly slot_code: string
  readonly scheduled_start_at: string | null
  readonly interviewers: readonly PriorRoundInterviewer[]
  /** 该轮维度宇宙是否可用（= 申请钉住的岗位 rubric 可用）；false 时两个维度数组都是空。 */
  readonly dimensions_available: boolean
  readonly covered_dimensions: readonly PriorRoundCoveredDimension[]
  readonly uncovered_dimensions: readonly PriorRoundUncoveredDimension[]
}

/** 参考点的依据（结构化，可复核；不会被渲染成机器码以外的文本）。 */
export interface InterviewerReferencePointBasis {
  readonly kind: 'RUBRIC_DIMENSION' | 'PRIOR_GAP' | 'RESUME_HIGHLIGHT'
  /** RUBRIC_DIMENSION / PRIOR_GAP → 该维度 key；RESUME_HIGHLIGHT → `work_experience[<index>]`。 */
  readonly ref: string
}

/** 本轮的一条参考（面向面试官的两句中文；D-141：不含 UUID/哈希/字段名/路径/机器码）。 */
export interface InterviewerReferencePoint {
  readonly point: string
  readonly why: string
  readonly basis: InterviewerReferencePointBasis
}

/** `interviews[]` 的一个元素（§1.4）。 */
export interface InterviewerRow {
  readonly interview_id: string
  readonly application_id: string
  readonly candidate: InterviewerCandidate
  readonly job: InterviewerJob
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
  /**
   * 审计 REPORT.md §③：status='NO_SHOW' 时的"未出席 + 原因"事实（谁没来 / 原因 / 记录时刻 / 确认语 sha256）。
   * 直接透传 `readInterviewValue()` 的 no_show；非 NO_SHOW 或老数据没有该事件时整个键省略。
   */
  readonly no_show?: {
    readonly subject: string
    readonly reason: string
    readonly recorded_at: string
    readonly confirmation_text_sha256: string
  }
  readonly stage_code: string
  readonly scheduled_start_at: string | null
  readonly scheduled_end_at: string | null
  readonly timezone: string
  readonly record_version: number
  readonly role_in_interview: string
  readonly required_scorecard: boolean
  readonly scorecard_due_at: string | null
  readonly brief: InterviewerBrief
  readonly rubric: InterviewerRubric | null
  /** W3b（§1.4）：本轮重点；无可用轮次配置时 `JOB_BASE` 降级 + `reason`（不猜）。 */
  readonly round_focus: RoundFocus
  /** W3b（§1.4）：面评真正可提交的 rubric 投影（维度宇宙恒 = 申请钉住的岗位 rubric）。 */
  readonly effective_rubric: EffectiveRubric
  readonly materials: InterviewerMaterials
  readonly transcript: InterviewerTranscript
  readonly scorecard: InterviewerScorecard
  readonly required_action: InterviewerRequiredAction
  /**
   * task-51：同一申请下**紧邻上一轮**（`round_no = 本行 round_no - 1`）的面试事实；
   * 当前轮是 1 / 上一轮不存在 → `[]`（每行恒为数组，不是 `undefined`）。
   */
  readonly prior_rounds: readonly PriorRound[]
  /**
   * task-51：本轮 2–4 条「可以重点了解什么 + 为什么值得问」；可用池不足 2 条时如实少给，
   * 不编造（没有前置轮次时**不会**出现 PRIOR_GAP）。
   */
  readonly reference_points: readonly InterviewerReferencePoint[]
  /** docs/34 §2：候选人的置顶 PIN + 本轮 HANDOFF（上一轮留的追问）；恒给出，不改旧键形状。 */
  readonly candidate_constraints: InterviewerCandidateConstraints
}

/** 工作台投影响应（§1.4）。 */
export interface InterviewerOverview {
  readonly contract_version: string
  /** read model 只在"数据库已配置"时被调用（未配置由 HTTP 层 503 承担），故恒 true。 */
  readonly configured: boolean
  /** 服务端 `now()`（ISO 文本）；同时是 TR-D 的 `as_of`。 */
  readonly evaluated_at: string
  readonly actor: InterviewerWorkspaceActor
  readonly session: InterviewerWorkspaceSession
  readonly labels: InterviewerWorkspaceLabels
  readonly counts: InterviewerCounts
  readonly interviews: readonly InterviewerRow[]
  /** 非空时不代表失败：是"这条数据我没法诚实地填满"的说明（如 rubric 越界）。 */
  readonly issues: readonly string[]
}

// =====================================================================
//  §1.3 读入口的输入
// =====================================================================

/**
 * `readInterviewerWorkspace()` 的视图身份。
 *
 * `session_id` 是**可选**的增量字段（相对契约 §1.3 的 `{alias, actor_id, display_name}`）：
 * §1.4 的响应里有 `session.session_id`，但 read model 本身拿不到 session（它不是身份来源）。
 * HTTP 层把已解析绑定的 session 原样传进来，响应因此**说的是真话**；直接调用（集成测试/其它
 * 宿主适配）不传时是空串 —— 空串明确表示"这个调用没有 session 上下文"。
 */
export interface WorkspaceActor {
  readonly alias: string
  readonly actor_id: string
  readonly display_name: string
  readonly session_id?: string
}

/** `readInterviewerWorkspace()` 的可选参数。 */
export interface ReadInterviewerWorkspaceOptions {
  /** 只看这一场（仍是"我的分配"内的过滤；少了 → 403，见 §1.2）。 */
  readonly interviewId?: string
  /** 列表上限（默认 20，超过 20 一律按 20：契约不允许放大）。 */
  readonly sectionLimit?: number
}

// =====================================================================
//  SQL（全部 SELECT；由调用方的只读事务兜底）
// =====================================================================

/**
 * "我的面试"列表：**只按 `interviewer.actor_id = actor` 过滤**（按 Interview 分配，
 * 不按候选人/角色标签 —— `actor_role` 是标签，D-33/R-WB-4）。排序照 §1.3：
 * `scheduled_start_at desc nulls last, round_no, id`；`limit` 由参数给（≤20）。
 *
 * 只取 id：行的其余事实一律由 `readInterviewValue()`（单一真相）与 §1.5 的扩展 SQL 给，
 * 这里不重复读，避免"列表里的 status"和"详情里的 status"来自两次读取而打架。
 */
const MY_INTERVIEW_IDS_SQL = `
  select iv.id::text as interview_id
    from recruitment.interview iv
    join recruitment.interviewer ivr
      on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
   where iv.tenant_id = $1::uuid
     and ivr.actor_id = $2::uuid
     and ($3::uuid is null or iv.id = $3::uuid)
   order by iv.scheduled_start_at desc nulls last, iv.round_no asc, iv.id asc
   limit $4::int
`

/**
 * §1.5 的 per-interview 扩展：candidate / job / interview_template_version / rubric / resume，
 * 外加**我自己**那一条当前面评（`record_version`/`overall` 是 `readInterviewValue()` 不暴露的
 * 两个字段，但 §1.4 的形状要求它们；面评的"身份"仍以 `readInterviewValue()` 为准，
 * 这里只在 scorecard_id 相同时补这两个字段，见 `toInterviewRow`）。
 *
 * rubric 的 join 条件带 `rv.job_id = a.job_id`：只要钉住的版本不属于该申请的岗位就不 join
 * （于是 `rubric_version_id` 为 null），由 `toInterviewRow` 判定"钉住但不可用"并写 issue ——
 * **不猜**一个看起来对的版本（SC-11/SC-47 的同一条语义）。
 *
 * 模板侧除了展示用的 objective/focus/questions，还取 `job_id`/`round_no`/`rubric_version_id`
 * 三个**守卫列**：轮次配置只有在"岗位一致 + 轮次一致 + 至少贡献一项内容"时才可套用，否则由
 * `buildRoundFocus`/`buildEffectiveRubric` 降级到 JOB_BASE 并写清原因（不猜、不硬套）。
 */
const INTERVIEW_EXTENSION_SQL = `
  select iv.id::text                       as interview_id,
         a.id::text                        as application_id,
         a.candidate_id::text              as candidate_id,
         a.job_id::text                    as application_job_id,
         c.display_name                    as candidate_display_name,
         j.code                            as job_code,
         j.title                           as job_title,
         itv.id::text                      as template_version_id,
         itv.version_no                    as template_version_no,
         itv.round_no                      as template_round_no,
         itv.job_id::text                  as template_job_id,
         itv.objective                     as template_objective,
         itv.briefing ->> 'summary'         as template_briefing_summary,
         itv.focus_attributes              as template_focus,
         itv.question_templates            as template_questions,
         itv.feedback_form                 as template_feedback_form,
         itv.payload_hash                  as template_payload_hash,
         itv.rubric_version_id::text       as template_declared_rubric_version_id,
         a.rubric_version_id::text         as pinned_rubric_version_id,
         rv.id::text                       as rubric_version_id,
         rv.version_no                     as rubric_version_no,
         rv.payload_hash                   as rubric_payload_hash,
         rv.dimensions                     as rubric_dimensions,
         a.resume_version_id::text         as resume_version_id,
         rvv.parse_status                  as resume_parse_status,
         rvv.parser_name                   as resume_parser_name,
         rvv.parser_version                as resume_parser_version,
         rvv.content_sha256                as resume_content_sha256,
         rvv.parsed_fields                 as resume_parsed_fields,
         sc.id::text                       as scorecard_id,
         sc.record_version                 as scorecard_record_version,
         sc.overall                        as scorecard_overall
    from recruitment.interview iv
    join recruitment.application a
      on a.id = iv.application_id and a.tenant_id = iv.tenant_id
    join recruitment.candidate c
      on c.id = a.candidate_id and c.tenant_id = a.tenant_id
    join recruitment.job j
      on j.id = a.job_id and j.tenant_id = a.tenant_id
    join recruitment.interviewer ivr
      on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id and ivr.actor_id = $3::uuid
    left join recruitment.interview_template_version itv
      on itv.id = iv.interview_template_version_id and itv.tenant_id = iv.tenant_id
    left join recruitment.rubric_version rv
      on rv.id = a.rubric_version_id and rv.tenant_id = a.tenant_id and rv.job_id = a.job_id
    left join recruitment.resume_version rvv
      on rvv.id = a.resume_version_id and rvv.tenant_id = a.tenant_id
    left join recruitment.scorecard sc
      on sc.interview_id = iv.id and sc.tenant_id = iv.tenant_id
     and sc.interviewer_id = ivr.id and sc.superseded_by_scorecard_id is null
   where iv.tenant_id = $2::uuid and iv.id = $1::uuid
`

/** 视图身份（不存在 → 404 ACTOR_NOT_FOUND；不猜显示名）。 */
const ACTOR_SQL = `
  select ac.id::text as actor_id, ac.display_name as display_name
    from recruitment.actor ac
   where ac.id = $1::uuid and ac.tenant_id = $2::uuid
`

/** 角色**标签**（D-33：只作展示，不参与任何归属判定）。 */
const ACTOR_ROLES_SQL = `
  select r.code as code
    from recruitment.actor_role ar
    join recruitment.role r on r.id = ar.role_id and r.tenant_id = ar.tenant_id
   where ar.actor_id = $1::uuid and ar.tenant_id = $2::uuid and ar.revoked_at is null
   order by r.code asc
`

/**
 * task-51：**紧邻上一轮**的批量读取（一条 SELECT，只读）。
 *
 * 入参是三个同长数组（当前面试 id / 申请 id / 当前轮次）：`$1` 只用于把结果映射回当前行，
 * 真正的过滤是 `(application_id, round_no = 当前轮 - 1)`。`round_no > 1` 在 CTE 里先挡掉
 * （第 1 轮没有"上一轮"）。
 *
 * 一次取回三样事实（面试行 + interviewer 行 + **当前**面评）：
 *   · 面试行：`status` / `slot_code` / `scheduled_start_at`（按 `slot_code asc, id asc` 排序）；
 *   · interviewer 行 + `actor.display_name`（没有显示名时是 null，由 builder 落成 `''`）；
 *   · 每人当前面评（`superseded_by_scorecard_id is null`）的 `status` / `overall` / `items`。
 *
 * **只取判定需要的东西**：`items` 用来逐维读 `assessment`/`score`；`note`/`rationale` 在 SQL 层
 * 就不进结果（不抄主观评语），builder 也只读 `assessment`/`score` 两个键。
 *
 * 注意 join 顺序：interviewer 用 `left join`（一场面试可能还没有登记面试官行），
 * scorecard 再 `left join` 到 interviewer 上 —— 没有面评时 `sc.*` 全是 null（→ state NONE）。
 */
const PRIOR_ROUND_SQL = `
  with current_rows as (
    select cur.interview_id, cur.application_id, cur.round_no
      from unnest($1::uuid[], $2::uuid[], $3::int[])
        as cur(interview_id, application_id, round_no)
     where cur.round_no > 1
  )
  select cur.interview_id::text            as current_interview_id,
         iv.id::text                       as prior_interview_id,
         iv.round_no                       as prior_round_no,
         iv.status                         as prior_status,
         iv.slot_code                      as prior_slot_code,
         iv.scheduled_start_at             as prior_scheduled_start_at,
         ivr.id::text                      as interviewer_row_id,
         ivr.actor_id::text                as interviewer_actor_id,
         ac.display_name                   as interviewer_display_name,
         sc.id::text                       as scorecard_id,
         sc.status                         as scorecard_status,
         sc.overall                        as scorecard_overall,
         sc.items                          as scorecard_items
    from current_rows cur
    join recruitment.interview iv
      on iv.tenant_id = $4::uuid
     and iv.application_id = cur.application_id
     and iv.round_no = cur.round_no - 1
    left join recruitment.interviewer ivr
      on ivr.interview_id = iv.id and ivr.tenant_id = iv.tenant_id
    left join recruitment.actor ac
      on ac.id = ivr.actor_id and ac.tenant_id = ivr.tenant_id
    left join recruitment.scorecard sc
      on sc.interview_id = iv.id
     and sc.tenant_id = iv.tenant_id
     and sc.interviewer_id = ivr.id
     and sc.superseded_by_scorecard_id is null
   order by cur.interview_id asc, iv.slot_code asc, iv.id asc, ivr.actor_id asc, ivr.id asc
`

// =====================================================================
//  §1.5 扩展行的类型（SQL 别名逐字对应；单测直接喂假行）
// =====================================================================

/** `INTERVIEW_EXTENSION_SQL` 的一行（jsonb 已由 pg 解析成 JS 值）。 */
export interface InterviewExtensionRow {
  readonly interview_id: string
  /** docs/34 §2：申请 id / 候选人 id（用来批量取候选约束）；旧单测假行可缺，故可选。 */
  readonly application_id?: string | null
  readonly candidate_id?: string | null
  readonly application_job_id: string
  readonly candidate_display_name: string
  readonly job_code: string
  readonly job_title: string
  readonly template_version_id: string | null
  /**
   * W3b 新增的模板守卫/评分表列。**全部可选**：旧的单测假行不含这些键，
   * `buildRoundFocus`/`buildEffectiveRubric` 必须容错 `undefined`（job/round 未知 → 不阻断）。
   */
  readonly template_version_no?: number | null
  readonly template_round_no?: number | null
  readonly template_job_id?: string | null
  readonly template_objective: string | null
  readonly template_briefing_summary: string | null
  readonly template_focus: unknown
  readonly template_questions: unknown
  readonly template_feedback_form?: unknown
  readonly template_payload_hash: string | null
  readonly template_declared_rubric_version_id?: string | null
  readonly pinned_rubric_version_id: string | null
  readonly rubric_version_id: string | null
  readonly rubric_version_no?: number | null
  readonly rubric_payload_hash: string | null
  readonly rubric_dimensions: unknown
  readonly resume_version_id: string | null
  readonly resume_parse_status: string | null
  readonly resume_parser_name: string | null
  readonly resume_parser_version: string | null
  readonly resume_content_sha256: string | null
  readonly resume_parsed_fields: unknown
  readonly scorecard_id: string | null
  readonly scorecard_record_version: number | null
  readonly scorecard_overall: string | null
}

/**
 * `PRIOR_ROUND_SQL` 的一行（SQL 别名逐字对应；jsonb 已由 pg 解析成 JS 值）。
 *
 * 一场前置轮次 × 一位面试官 = 一行；同一人最多一条**当前**面评（库上有
 * `uq_scorecard_current` 部分唯一索引），所以这里不会出现两条当前面评。
 * `interviewer_*` / `scorecard_*` 为 null = 这一场还没有面试官行 / 该面试官还没有面评。
 */
export interface PriorRoundRow {
  /** 当前行（= 我正在看的那一场）的面试 id；用来把批量结果映射回 `toInterviewRow`。 */
  readonly current_interview_id: string
  readonly prior_interview_id: string
  readonly prior_round_no: number
  readonly prior_status: string
  readonly prior_slot_code: string
  readonly prior_scheduled_start_at: Date | string | null
  readonly interviewer_row_id: string | null
  readonly interviewer_actor_id: string | null
  readonly interviewer_display_name: string | null
  readonly scorecard_id: string | null
  readonly scorecard_status: string | null
  readonly scorecard_overall: string | null
  readonly scorecard_items: unknown
}

// =====================================================================
//  小工具（严格类型防御：库里的 jsonb 是外部输入，形状不能假设）
// =====================================================================

/** 一个 JSON 对象？ */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串 → 原值；其余（含空串/数字） → null。 */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 有限数字 → 原值；否则 fallback（jsonb 里的 weight 可能是字符串/缺失）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 整数列 → number；pg 的 `integer` 已是 number，这里只挡住 undefined。 */
function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
}

/** 整数列 → number；缺失/脏值 → null（`template_round_no` 未知时不能当成 0 去比较）。 */
function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

/** 有限数字 → number；否则 null（weight / scale 用：jsonb 可能是字符串）。 */
function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `timestamptz`（pg 给 Date，测试可能给字符串）→ ISO 文本；无效 → null。 */
function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** 数组或空数组（jsonb 列可能被脏数据写成非数组）。 */
function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * rubric 维度 → §1.4 的 `{key,label,kind,weight,question}`（顺序 = rubric 里的顺序）。
 *
 * 为什么要求 `key` 是非空字符串：客户端拿它当渲染键与提交键（D-89 的键只来自服务端），
 * 没有 key 的维度既不能显示也不能提交，只能跳过（不猜、不补一个假键）。
 */
function rubricDimensionsOf(value: unknown): InterviewerRubricDimension[] {
  const out: InterviewerRubricDimension[] = []
  for (const raw of asArray(value)) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key)
    if (key === null) continue
    out.push({
      key,
      label: text(raw.label) ?? key,
      kind: text(raw.kind) ?? '',
      weight: numberOr(raw.weight, 0),
      question: text(raw.question),
    })
  }
  return out
}

/**
 * 简报里的考察重点：期望 `{key,label,weight}`（与 rubric 维度同形的子集）。
 * 缺 `key` 的元素跳过（同上：没有键就没法渲染/引用）。
 */
function briefFocusOf(value: unknown): InterviewerBriefFocus[] {
  const out: InterviewerBriefFocus[] = []
  for (const raw of asArray(value)) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key)
    if (key === null) continue
    out.push({ key, label: text(raw.label) ?? key, weight: numberOr(raw.weight, 0) })
  }
  return out
}

/**
 * 建议问题"文本化"：`question_templates` 可能是字符串数组、也可能是 `{question|text|template}` 数组。
 * 取不到文本的元素跳过（不把 JSON 字符串化当问题展示）。
 */
function questionTextsOf(value: unknown): string[] {
  const out: string[] = []
  for (const raw of asArray(value)) {
    if (typeof raw === 'string') {
      const direct = text(raw)
      if (direct !== null) out.push(direct)
      continue
    }
    if (!isPlainObject(raw)) continue
    const candidate = text(raw.question) ?? text(raw.text) ?? text(raw.template)
    if (candidate !== null) out.push(candidate)
  }
  return out
}

// =====================================================================
//  §1.4 各块的构造（纯函数；`toInterviewRow` 是它们唯一的组合点）
// =====================================================================

// ---------------------------------------------------------------------
//  W3b：round_focus / effective_rubric（轮次重点 + 面评 Rubric 投影）
// ---------------------------------------------------------------------

/**
 * `buildRoundFocus` / `buildEffectiveRubric` / `collectRoundIssues` 的共同输入。
 *
 * 为什么归一：interviewer（面试官视角）与 recruiting（招聘方视角）的 SQL 各自起别名，但
 * "模板能不能套用"必须**只有一套判定**；归一后两侧共用 `evaluateRoundConfig`，永远不会
 * 各写一套守卫（C-4：两份实现迟早会漂移）。
 */
export interface RoundRubricFacts {
  /** `interview.round_no`（本场面试的轮次）。 */
  readonly round_no: number
  /** `application.job_id`（申请岗位；已知时才参与跨岗位守卫）。 */
  readonly application_job_id: string | null
  readonly template_version_id: string | null
  readonly template_version_no: number | null
  readonly template_round_no: number | null
  readonly template_job_id: string | null
  readonly template_objective: string | null
  readonly template_briefing_summary: string | null
  readonly template_focus: unknown
  readonly template_questions: unknown
  readonly template_feedback_form: unknown
  readonly template_payload_hash: string | null
  readonly template_declared_rubric_version_id: string | null
  readonly pinned_rubric_version_id: string | null
  readonly rubric_version_id: string | null
  readonly rubric_version_no: number | null
  readonly rubric_payload_hash: string | null
  readonly rubric_dimensions: unknown
}

/** `focus_attributes` 的一个可用元素（解析后；只保留有 `key` 的）。 */
interface ParsedFocusAttribute {
  readonly key: string
  readonly label: string | null
  readonly weight: number | null
  readonly required: boolean
}

/**
 * `focus_attributes` 容错解析：元素可为 `{key,label,weight,required?/must_cover?}`，也可只给
 * `{key}`/`{label}`；**没有 key 的跳过**（不能渲染/不能命中 rubric 的不硬造），同 key 只保留首个。
 */
function focusAttributesOf(value: unknown): ParsedFocusAttribute[] {
  const out: ParsedFocusAttribute[] = []
  const seen = new Set<string>()
  for (const raw of asArray(value)) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key)
    if (key === null || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      label: text(raw.label),
      weight: finiteNumberOrNull(raw.weight),
      // 契约原文：`required` 只认 boolean `required===true` 或 `must_cover===true`（两者是 OR）。
      required: raw.required === true || raw.must_cover === true,
    })
  }
  return out
}

/** `question_templates` 容错解析：字符串 / `{question|text|template}` / 带 key 的对象。 */
function roundQuestionsOf(value: unknown): RoundFocusQuestion[] {
  const out: RoundFocusQuestion[] = []
  for (const raw of asArray(value)) {
    if (typeof raw === 'string') {
      const direct = text(raw)
      if (direct !== null) out.push({ key: null, text: direct })
      continue
    }
    if (!isPlainObject(raw)) continue
    const candidate = text(raw.question) ?? text(raw.text) ?? text(raw.template)
    if (candidate === null) continue
    out.push({ key: text(raw.key), text: candidate })
  }
  return out
}

/** `feedback_form.fields`（数组）→ 评分表字段；`key` 缺失/非字符串的元素跳过。 */
function scorecardFieldsOf(value: unknown): RoundFocusScorecardField[] {
  const out: RoundFocusScorecardField[] = []
  for (const raw of asArray(value)) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key)
    if (key === null) continue
    out.push({ key, label: text(raw.label) ?? key, kind: text(raw.kind) ?? '', required: raw.required === true })
  }
  return out
}

/** `feedback_form.dimensions`（对象/数组）→ 评分表字段的容错投影（只在没有 fields 数组时兜底）。 */
function scorecardFieldsFromDimensions(value: unknown): RoundFocusScorecardField[] {
  const out: RoundFocusScorecardField[] = []
  if (isPlainObject(value)) {
    for (const [key, raw] of Object.entries(value)) {
      const label = isPlainObject(raw) ? text(raw.label) ?? key : key
      const kind = isPlainObject(raw) ? text(raw.kind) ?? '' : ''
      out.push({ key, label, kind, required: isPlainObject(raw) && raw.required === true })
    }
    return out
  }
  for (const raw of asArray(value)) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key) ?? text(raw.name) ?? text(raw.id)
    if (key === null) continue
    out.push({ key, label: text(raw.label) ?? key, kind: text(raw.kind) ?? '', required: raw.required === true })
  }
  return out
}

/** `round_focus.scorecard_fields`：优先 fields 数组，其次 dimensions 投影，都没有 → `[]`（不造）。 */
function roundScorecardFieldsOf(form: Readonly<Record<string, unknown>> | null): RoundFocusScorecardField[] {
  if (form === null) return []
  if (Array.isArray(form.fields)) return scorecardFieldsOf(form.fields)
  return scorecardFieldsFromDimensions(form.dimensions)
}

/** `feedback_form.scale` / `{min_score,max_score}` → `{min,max}`（两者都是有限数字才给）。 */
function scaleOf(
  form: Readonly<Record<string, unknown>> | null,
): { readonly min: number; readonly max: number } | null {
  if (form === null) return null
  const rawScale = form.scale
  if (isPlainObject(rawScale)) {
    const min = finiteNumberOrNull(rawScale.min)
    const max = finiteNumberOrNull(rawScale.max)
    if (min !== null && max !== null) return { min, max }
  }
  if (Array.isArray(rawScale) && rawScale.length >= 2) {
    const min = finiteNumberOrNull(rawScale[0])
    const max = finiteNumberOrNull(rawScale[1])
    if (min !== null && max !== null) return { min, max }
  }
  const min = finiteNumberOrNull(form.min_score)
  const max = finiteNumberOrNull(form.max_score)
  if (min !== null && max !== null) return { min, max }
  return null
}

/** `feedback_form.fields` 里同名 key 的 kind/required 覆盖（只有显式给了才覆盖）。 */
interface ScorecardFieldOverride {
  readonly kind: string | null
  readonly required: boolean | null
}

function scorecardFieldOverridesOf(
  form: Readonly<Record<string, unknown>> | null,
): ReadonlyMap<string, ScorecardFieldOverride> {
  const out = new Map<string, ScorecardFieldOverride>()
  if (form === null || !Array.isArray(form.fields)) return out
  for (const raw of form.fields) {
    if (!isPlainObject(raw)) continue
    const key = text(raw.key)
    if (key === null) continue
    out.set(key, {
      kind: text(raw.kind),
      required: typeof raw.required === 'boolean' ? raw.required : null,
    })
  }
  return out
}

/** `evaluateRoundConfig` 的唯一判定结果（两个 builder 与 issues 的唯一判定点）。 */
interface RoundConfigEvaluation {
  /** 绑定了模板行（扩展 SQL 的 `template_version_id` 非空 = join 成功）。 */
  readonly bound: boolean
  /** job/round 守卫通过（不匹配 → 不可套用；未知 → 不阻断，见下）。 */
  readonly compatible: boolean
  /** 模板至少贡献一项轮次内容（objective/briefing.summary/focus/questions/feedback_form）。 */
  readonly hasContent: boolean
  /** 真正可套用：`bound ∧ compatible ∧ hasContent`。 */
  readonly available: boolean
  readonly roundNo: number
  readonly templateVersionId: string | null
  readonly templateVersionNo: number | null
  readonly templatePayloadHash: string | null
  readonly objective: string | null
  readonly description: string | null
  readonly focusAttributes: readonly ParsedFocusAttribute[]
  readonly questions: readonly RoundFocusQuestion[]
  readonly scorecardFields: readonly RoundFocusScorecardField[]
  readonly feedbackForm: Readonly<Record<string, unknown>> | null
  /** 不可套用的原因（可套用时 null）。 */
  readonly reason: string | null
  /** job/round 不匹配的 issue（已写明事实；interview id 前缀由 `toInterviewRow` 加）。 */
  readonly mismatchIssues: readonly string[]
}

/**
 * 「轮次模板能否套用」的唯一判定（requirement 2 + 6 的单点实现）。
 *
 * 可套用 = 绑定到模板行 ∧ 岗位一致 ∧ 轮次一致 ∧ 至少贡献一项轮次内容。
 * **未知不阻断**：`template_job_id`/`template_round_no` 为 null（旧数据/旧假行没有这两列）时按
 * "未知"处理，不能因此把模板拒掉 —— 否则旧行为会变（新增列不得改变缺列路径的语义）。
 */
function evaluateRoundConfig(facts: RoundRubricFacts): RoundConfigEvaluation {
  const roundNo = integerOrNull(facts.round_no) ?? 0
  const templateVersionId = text(facts.template_version_id)
  const bound = templateVersionId !== null
  const templateJobId = text(facts.template_job_id)
  const applicationJobId = text(facts.application_job_id)
  const jobMismatch = templateJobId !== null && applicationJobId !== null && templateJobId !== applicationJobId
  const templateRoundNo = integerOrNull(facts.template_round_no)
  const roundMismatch = bound && templateRoundNo !== null && templateRoundNo !== roundNo
  const compatible = bound && !jobMismatch && !roundMismatch

  const objective = text(facts.template_objective)
  const description = text(facts.template_briefing_summary)
  const focusAttributes = focusAttributesOf(facts.template_focus)
  const questions = roundQuestionsOf(facts.template_questions)
  const feedbackForm = isPlainObject(facts.template_feedback_form)
    && Object.keys(facts.template_feedback_form).length > 0
    ? facts.template_feedback_form
    : null
  const scorecardFields = roundScorecardFieldsOf(feedbackForm)
  const hasContent = objective !== null || description !== null
    || focusAttributes.length > 0 || questions.length > 0 || feedbackForm !== null
  const available = bound && compatible && hasContent

  const mismatchIssues: string[] = []
  if (bound && jobMismatch) {
    mismatchIssues.push(
      `轮次模板 ${templateVersionId} 的 job_id ${templateJobId} 与申请岗位 ${applicationJobId} 不一致，`
      + '不套用该轮次配置（降级到岗位 Rubric 底座 JOB_BASE）',
    )
  }
  if (bound && roundMismatch) {
    mismatchIssues.push(
      `轮次模板 ${templateVersionId} 的 round_no=${templateRoundNo} 与本场面试轮次 ${roundNo} 不一致，`
      + '不套用该轮次配置（降级到岗位 Rubric 底座 JOB_BASE）',
    )
  }

  let reason: string | null = null
  if (!bound) {
    reason = '本场面试没有绑定可用的轮次模板，无法声称本轮重点；已如实降级到岗位 Rubric 底座（JOB_BASE）'
  } else if (jobMismatch || roundMismatch) {
    const parts: string[] = []
    if (jobMismatch) parts.push(`job_id ${templateJobId} 与申请岗位 ${applicationJobId} 不一致`)
    if (roundMismatch) parts.push(`round_no=${templateRoundNo} 与本场面试轮次 ${roundNo} 不一致`)
    reason = `轮次模板 ${templateVersionId} 的 ${parts.join('、')}，`
      + '不套用该轮次配置；已如实降级到岗位 Rubric 底座（JOB_BASE）'
  } else if (!hasContent) {
    reason = `本场面试已绑定轮次模板 ${templateVersionId}，但该模板未配置任何轮次重点`
      + '（objective / briefing.summary / focus_attributes / question_templates / feedback_form 全空），'
      + '无法声称本轮重点；已如实降级到岗位 Rubric 底座（JOB_BASE）'
  }

  return {
    bound,
    compatible,
    hasContent,
    available,
    roundNo,
    templateVersionId,
    templateVersionNo: integerOrNull(facts.template_version_no),
    templatePayloadHash: text(facts.template_payload_hash),
    objective,
    description,
    focusAttributes,
    questions,
    scorecardFields,
    feedbackForm,
    reason,
    mismatchIssues,
  }
}

/**
 * 构造 §1.4 的 `round_focus` 块（纯函数；不碰 DB）。
 *
 * 三态：
 *   · 可套用 → `available:true, source:'ROUND_CONFIG'`，title/description/focus/questions/
 *     scorecard_fields 全部来自模板；
 *   · 绑定但不可套用 / 未绑定 → `available:false, source:'JOB_BASE'`，内容数组全空、
 *     title/description 为 null、`reason` 写明为什么不能声称本轮重点；
 *   · 已绑定的模板身份（id/version/hash）无论可套用与否都**如实回显**（那是"绑过哪个模板"的事实）。
 *
 * @param facts - 归一后的轮次/模板/rubric 事实。
 * @returns §1.4 的 `round_focus` 块。
 */
export function buildRoundFocus(facts: RoundRubricFacts): RoundFocus {
  const evaluation = evaluateRoundConfig(facts)
  const baseDimensions = rubricDimensionsOf(facts.rubric_dimensions)
  const baseByKey = new Map(baseDimensions.map((dimension) => [dimension.key, dimension]))
  const identity = {
    template_version_id: evaluation.templateVersionId,
    template_version_no: evaluation.templateVersionNo,
    template_payload_hash: evaluation.templatePayloadHash,
  } as const
  if (!evaluation.available) {
    return {
      available: false,
      source: 'JOB_BASE',
      round_no: evaluation.roundNo,
      ...identity,
      title: null,
      description: null,
      focus_dimensions: [],
      questions: [],
      scorecard_fields: [],
      reason: evaluation.reason,
    }
  }
  return {
    available: true,
    source: 'ROUND_CONFIG',
    round_no: evaluation.roundNo,
    ...identity,
    title: evaluation.objective,
    description: evaluation.description,
    focus_dimensions: evaluation.focusAttributes.map((attribute) => {
      const base = baseByKey.get(attribute.key)
      return {
        key: attribute.key,
        label: attribute.label ?? base?.label ?? attribute.key,
        weight: attribute.weight ?? base?.weight ?? 0,
        required: attribute.required,
        in_rubric: base !== undefined,
      }
    }),
    questions: evaluation.questions,
    scorecard_fields: evaluation.scorecardFields,
    reason: null,
  }
}

/** 申请钉住的岗位 rubric 不可用时的中文原因（不猜版本；写清是哪一种缺失）。 */
function baseRubricUnavailableReason(pinnedId: string | null, joinedId: string | null): string {
  if (pinnedId !== null && joinedId === null) {
    return `申请钉住的 rubric 版本 ${pinnedId} 不可用（不属于该申请的岗位或已不存在），`
      + '服务端不猜版本，无法给出面评提交的维度键集'
  }
  if (joinedId !== null) {
    return `申请钉住的 rubric 版本 ${joinedId} 没有任何可用维度，无法给出面评提交的维度键集`
  }
  return '这场面试的申请没有钉住可用的岗位 rubric 版本，无法给出面评提交的维度键集（不猜版本）'
}

/**
 * 构造 §1.4 的 `effective_rubric` 块（纯函数；不碰 DB）。
 *
 * 三条不变量：
 *   1. **维度宇宙恒 = 申请钉住的岗位 rubric**（顺序 = rubric 顺序），轮次配置只能标记
 *      focus/must_cover、覆盖显示权重；**不换维度集合**（D-89/SC-13 的提交键集不变）；
 *   2. `source` 只按"轮次配置是否真正可套用"判定：可套用 = `ROUND_OVERRIDE`，否则 `JOB_BASE`；
 *   3. 模板声明的 rubric 版本与申请钉住版本不一致 → **不混用**：维度仍取岗位底座，
 *      `reason`（以及 `collectRoundIssues` 的 issue）写明冲突；钉住 rubric 不可用时
 *      `available:false` + `reason`（不抛错、不猜版本）。
 *
 * @param facts - 归一后的轮次/模板/rubric 事实。
 * @returns §1.4 的 `effective_rubric` 块。
 */
export function buildEffectiveRubric(facts: RoundRubricFacts): EffectiveRubric {
  const evaluation = evaluateRoundConfig(facts)
  const pinnedId = text(facts.pinned_rubric_version_id)
  const joinedId = text(facts.rubric_version_id)
  const baseDimensions = joinedId === null ? [] : rubricDimensionsOf(facts.rubric_dimensions)
  const declaredId = text(facts.template_declared_rubric_version_id)
  const jobId = text(facts.application_job_id) ?? ''
  const identity = {
    template_version_id: evaluation.templateVersionId,
    template_version_no: evaluation.templateVersionNo,
    template_payload_hash: evaluation.templatePayloadHash,
  } as const

  if (joinedId === null || baseDimensions.length === 0) {
    return {
      available: false,
      source: 'JOB_BASE',
      round_no: evaluation.roundNo,
      job_id: jobId,
      rubric_version_id: '',
      rubric_version_no: 0,
      rubric_payload_hash: '',
      base_rubric_version_id: null,
      ...identity,
      declared_round_rubric_version_id: declaredId,
      dimensions: [],
      scorecard: { scale: null, fields: [] },
      submission: { rubric_version_id: '', dimension_keys: [] },
      reason: baseRubricUnavailableReason(pinnedId, joinedId),
    }
  }

  // 只有轮次配置**真正可套用**时，focus/must_cover 标记才成立；不可套用（跨岗位/轮次不符/
  // 模板空）时整份 schema 是 JOB_BASE：不能让"不套用的模板"仍然把维度标成本轮重点。
  const focusByKey = evaluation.available
    ? new Map(evaluation.focusAttributes.map((attribute) => [attribute.key, attribute]))
    : new Map<string, ParsedFocusAttribute>()
  const noOverrides = new Map<string, ScorecardFieldOverride>()
  const overrides = evaluation.available ? scorecardFieldOverridesOf(evaluation.feedbackForm) : noOverrides
  const dimensions: EffectiveRubricDimension[] = baseDimensions.map((dimension) => {
    const focus = focusByKey.get(dimension.key)
    return {
      key: dimension.key,
      label: dimension.label,
      kind: dimension.kind,
      // 轮次配置只允许覆盖**显示权重**（focus_attributes 同名 key 有数值 weight 时）。
      weight: focus?.weight ?? dimension.weight,
      required: true,
      focus: focus !== undefined,
      must_cover: focus?.required === true,
      origin: focus !== undefined ? 'ROUND_OVERRIDE' : 'JOB_BASE',
      question: dimension.question,
    }
  })
  const fields: RoundFocusScorecardField[] = dimensions.map((dimension) => {
    const override = overrides.get(dimension.key)
    return {
      key: dimension.key,
      label: dimension.label,
      // 评分表字段的 kind 是"字段类型"（DIMENSION），不是 rubric 维度的 MUST_HAVE/NICE_TO_HAVE。
      kind: override?.kind ?? 'DIMENSION',
      required: override?.required ?? true,
    }
  })
  const conflictReason = evaluation.available && declaredId !== null && pinnedId !== null && declaredId !== pinnedId
    ? `轮次模板 ${evaluation.templateVersionId ?? ''} 声明的 rubric 版本 ${declaredId} `
      + `与申请钉住的岗位 rubric 版本 ${pinnedId} 不一致，服务端不混用两者，维度仍取岗位底座 ${pinnedId}`
    : null

  return {
    available: true,
    source: evaluation.available ? 'ROUND_OVERRIDE' : 'JOB_BASE',
    round_no: evaluation.roundNo,
    job_id: jobId,
    rubric_version_id: joinedId,
    rubric_version_no: integerOr(facts.rubric_version_no, 0),
    rubric_payload_hash: text(facts.rubric_payload_hash) ?? '',
    base_rubric_version_id: joinedId,
    ...identity,
    declared_round_rubric_version_id: declaredId,
    dimensions,
    scorecard: { scale: evaluation.available ? scaleOf(evaluation.feedbackForm) : null, fields },
    submission: { rubric_version_id: joinedId, dimension_keys: baseDimensions.map((dimension) => dimension.key) },
    reason: conflictReason,
  }
}

/**
 * 轮次/模板侧必须写进 overview `issues` 的四类事实（正常路径 0 条）：
 *
 *   · 模板 job 与申请岗位不一致（不套用）；
 *   · 模板 round_no 与本场轮次不一致（不套用）；
 *   · 本轮重点维度不在申请钉住的岗位 rubric 中（只展示，不进面评提交键集）；
 *   · 模板声明的 rubric 版本与申请钉住版本冲突（不混用，维度仍取岗位底座）。
 *
 * 只在**岗位 rubric 可用**时判定"维度越界"：rubric 本身不可用时根因已由 rubric 侧 issue/reason
 * 说明，再逐条报"不在 rubric 中"只是噪声（且那句断言本身就依赖 rubric 可用）。
 *
 * @param facts - 归一后的轮次/模板/rubric 事实。
 * @returns 该行应追加的 issue（中文；interview id 前缀由调用方加）。
 */
export function collectRoundIssues(facts: RoundRubricFacts): readonly string[] {
  const evaluation = evaluateRoundConfig(facts)
  const issues: string[] = []
  if (evaluation.bound && !evaluation.compatible) issues.push(...evaluation.mismatchIssues)
  if (!evaluation.available) return issues

  const baseDimensions = rubricDimensionsOf(facts.rubric_dimensions)
  if (baseDimensions.length > 0) {
    const baseKeys = new Set(baseDimensions.map((dimension) => dimension.key))
    const outside = evaluation.focusAttributes
      .filter((attribute) => !baseKeys.has(attribute.key))
      .map((attribute) => attribute.key)
    if (outside.length > 0) {
      issues.push(
        `本轮重点维度 ${outside.join('、')} 不在申请钉住的岗位 rubric 中，`
        + '面评提交键集不含这些维度（只展示，不写入 effective_rubric.dimensions）',
      )
    }
  }
  const declaredId = text(facts.template_declared_rubric_version_id)
  const pinnedId = text(facts.pinned_rubric_version_id)
  if (declaredId !== null && pinnedId !== null && declaredId !== pinnedId) {
    issues.push(
      `轮次模板 ${evaluation.templateVersionId ?? ''} 声明的 rubric 版本 ${declaredId} `
      + `与申请钉住的岗位 rubric 版本 ${pinnedId} 不一致，服务端不混用两者，维度仍取岗位底座 ${pinnedId}`,
    )
  }
  return issues
}

/**
 * 把扩展行归一成 `RoundRubricFacts`（两个 builder 的共同输入）。
 *
 * `roundNo` 必须单独传：轮次在 `readInterviewValue()`（`interview.round_no`）里，
 * 不在 §1.5 扩展行里。
 *
 * @param extension - §1.5 的扩展行（新列为可选，旧假行缺列也不崩）。
 * @param roundNo - 本场面试的轮次。
 * @returns 归一后的 facts。
 */
export function roundFactsOf(extension: InterviewExtensionRow, roundNo: number): RoundRubricFacts {
  return {
    round_no: roundNo,
    application_job_id: text(extension.application_job_id),
    template_version_id: text(extension.template_version_id),
    template_version_no: integerOrNull(extension.template_version_no),
    template_round_no: integerOrNull(extension.template_round_no),
    template_job_id: text(extension.template_job_id),
    template_objective: text(extension.template_objective),
    template_briefing_summary: text(extension.template_briefing_summary),
    template_focus: extension.template_focus,
    template_questions: extension.template_questions,
    template_feedback_form: extension.template_feedback_form,
    template_payload_hash: text(extension.template_payload_hash),
    template_declared_rubric_version_id: text(extension.template_declared_rubric_version_id),
    pinned_rubric_version_id: text(extension.pinned_rubric_version_id),
    rubric_version_id: text(extension.rubric_version_id),
    rubric_version_no: integerOrNull(extension.rubric_version_no),
    rubric_payload_hash: text(extension.rubric_payload_hash),
    rubric_dimensions: extension.rubric_dimensions,
  }
}

// ---------------------------------------------------------------------
//  task-51：prior_rounds / reference_points（纯函数；`toInterviewRow` 是唯一组合点）
// ---------------------------------------------------------------------

/** `buildPriorRounds` 的输入（归一后的本行事实 + 紧邻上一轮的 SQL 行）。 */
export interface PriorRoundFacts {
  /** 本行的 `interview.round_no`（来自 `readInterviewValue()`）。 */
  readonly round_no: number
  /** 维度宇宙是否可用：= 本行 `effective_rubric.available`。 */
  readonly dimensions_available: boolean
  /** 维度宇宙 = 本行 `effective_rubric.dimensions` 的 `key/label/weight`（顺序不变）。 */
  readonly dimensions: readonly PriorRoundDimension[]
  /** `PRIOR_ROUND_SQL` 的行（SQL 已按 `slot_code asc, id asc` 排好；这里按出现顺序分组）。 */
  readonly rows: readonly PriorRoundRow[]
}

/** 逐维覆盖判定的 covered 结果（内部用；只有它进 `covered_dimensions`）。 */
interface DimensionCoverage {
  readonly kind: 'COVERED'
  readonly assessment: 'MET' | 'NOT_MET'
  readonly score: number | null
}

/** 逐维覆盖判定的 uncovered 结果（内部用；进 `uncovered_dimensions`）。 */
interface DimensionGap {
  readonly kind: 'UNCOVERED'
  readonly reason: PriorRoundUncoveredReason
}

/**
 * 面评分值：只有 1..5 的**整数**才是分值（面评契约允许的范围）；字符串/小数/越界/缺失
 * → null（"面评没给分"，不四舍五入、不猜）。
 * @param value - `items[dimension_key].score` 原值。
 * @returns 1..5 整数或 null。
 */
function rubricScoreOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5 ? value : null
}

/**
 * 该维度在**所有 SUBMITTED 面评**里被怎么评的（DESIGN §1.1 第 4 条的唯一实现）。
 *
 * 判定顺序（全部可由 `scorecard.items` 复核）：
 *   1. 没有 SUBMITTED 面评 → `NO_SCORECARD`（PENDING 草稿**不算**证据）；
 *   2. 所有 SUBMITTED 面评的 `items` 都不是对象 → `NO_ITEMS`（脏数据，读不到分项）；
 *   3. 所有 SUBMITTED 面评里都缺该维度键 → `NOT_RATED`；
 *   4. 有该键：任一面评 `MET`/`NOT_MET` → covered（union；按面评顺序取**第一条**，
 *      **不调和**多人分歧）；`score` 只在 1..5 整数时给出；
 *   5. 否则：任一面评 `NOT_OBSERVED` → `NOT_OBSERVED`；其余（`UNREADABLE` / 键值不是对象 /
 *      `assessment` 是契约外的脏值）→ `UNREADABLE`（读不到就当没覆盖，不推测）。
 *
 * @param dimensionKey - 岗位标准维度 key。
 * @param submittedItems - 该场面试**所有** `status='SUBMITTED'` 面评的 `items` 原值。
 * @returns covered（含 assessment/score）或 uncovered（含原因码）。
 */
function assessDimension(
  dimensionKey: string,
  submittedItems: readonly unknown[],
): DimensionCoverage | DimensionGap {
  if (submittedItems.length === 0) return { kind: 'UNCOVERED', reason: 'NO_SCORECARD' }
  const readable = submittedItems.filter(isPlainObject)
  if (readable.length === 0) return { kind: 'UNCOVERED', reason: 'NO_ITEMS' }
  const entries = readable
    .filter((items) => Object.hasOwn(items, dimensionKey))
    .map((items) => items[dimensionKey])
  if (entries.length === 0) return { kind: 'UNCOVERED', reason: 'NOT_RATED' }
  let sawNotObserved = false
  for (const entry of entries) {
    // 键在但值不是对象（脏数据）：读不到 assessment，按 UNREADABLE 兜住（见函数尾）。
    if (!isPlainObject(entry)) continue
    const assessment = entry.assessment
    if (assessment === 'MET' || assessment === 'NOT_MET') {
      return { kind: 'COVERED', assessment, score: rubricScoreOf(entry.score) }
    }
    if (assessment === 'NOT_OBSERVED') sawNotObserved = true
  }
  return { kind: 'UNCOVERED', reason: sawNotObserved ? 'NOT_OBSERVED' : 'UNREADABLE' }
}

/**
 * 构造 §1 的 `prior_rounds`（纯函数；不碰 DB）。
 *
 * 三条硬规则（DESIGN §1.1）：
 *   1. 只看**紧邻上一轮**（`round_no = 当前轮 - 1`）、同一申请；当前轮 1 → `[]`；
 *   2. 维度宇宙 = 本行 `effective_rubric.dimensions`；`dimensions_available=false` 时
 *      **两个数组都空、不判定覆盖**（不推测）；
 *   3. 覆盖证据只认 `status='SUBMITTED'` 的面评；草稿不算；多位面试官按 union。
 *
 * 一场面试 = 一个元素（同一轮多场就是多个元素，按 SQL 的 `slot_code asc, id asc` 顺序）。
 *
 * @param facts - 本行轮次/维度宇宙 + 上一轮的 SQL 行。
 * @returns `prior_rounds`（每行都是数组；没有前置轮次时 `[]`）。
 */
export function buildPriorRounds(facts: PriorRoundFacts): readonly PriorRound[] {
  const currentRound = integerOrNull(facts.round_no)
  // 第 1 轮没有"上一轮"：一条 prior_round 都不返回（DESIGN §1.1 第 1 条 / 负例①）。
  if (currentRound === null || currentRound <= 1) return []
  const expectedRound = currentRound - 1
  // 维度宇宙不可用 → 两个数组都空（不判定覆盖）；只在可用时把宇宙映射成投影形状。
  const universe: PriorRoundDimension[] = facts.dimensions_available
    ? facts.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
    }))
    : []

  // 按"前置面试"分组，保持 SQL 给出的顺序（同一场的行相邻；多场按 slot_code/id）。
  const groups = new Map<string, PriorRoundRow[]>()
  const order: string[] = []
  for (const row of facts.rows) {
    const priorId = text(row.prior_interview_id)
    if (priorId === null) continue
    // SQL 已按 `application_id + round_no = 当前轮 - 1` 过滤；这里再挡一次误传的行，
    // 免得把"更早的轮次"当成紧邻上一轮（DESIGN：只看紧邻上一轮）。
    if (integerOrNull(row.prior_round_no) !== expectedRound) continue
    const group = groups.get(priorId)
    if (group === undefined) {
      groups.set(priorId, [row])
      order.push(priorId)
    } else {
      group.push(row)
    }
  }

  const rounds: PriorRound[] = []
  for (const priorId of order) {
    const rows = groups.get(priorId)
    if (rows === undefined || rows.length === 0) continue
    const header = rows[0]
    const interviewers: PriorRoundInterviewer[] = []
    /** 该场面试**所有** SUBMITTED 面评的 items（草稿/豁免/无面评都不进来）。 */
    const submittedItems: unknown[] = []
    for (const row of rows) {
      // `left join` 产生的空行：这一场还没有登记面试官行（没有"人"，也没有面评事实）。
      if (text(row.interviewer_row_id) === null) continue
      const state = scorecardStateOf(text(row.scorecard_status) ?? undefined)
      interviewers.push({
        display_name: text(row.interviewer_display_name) ?? '',
        scorecard_state: state,
        scorecard_submitted: state === 'SUBMITTED',
        // 未提交/无面评不显示结论（DESIGN §1.1 第 3 条）。
        conclusion: state === 'SUBMITTED' ? text(row.scorecard_overall) : null,
      })
      if (state === 'SUBMITTED') submittedItems.push(row.scorecard_items)
    }

    const covered: PriorRoundCoveredDimension[] = []
    const uncovered: PriorRoundUncoveredDimension[] = []
    for (const dimension of universe) {
      const verdict = assessDimension(dimension.key, submittedItems)
      if (verdict.kind === 'COVERED') {
        covered.push({
          key: dimension.key,
          label: dimension.label,
          weight: dimension.weight,
          assessment: verdict.assessment,
          score: verdict.score,
        })
      } else {
        uncovered.push({
          key: dimension.key,
          label: dimension.label,
          weight: dimension.weight,
          reason: verdict.reason,
        })
      }
    }

    rounds.push({
      round_no: integerOr(header.prior_round_no, expectedRound),
      interview_id: priorId,
      status: text(header.prior_status) ?? '',
      slot_code: text(header.prior_slot_code) ?? '',
      scheduled_start_at: isoOrNull(header.prior_scheduled_start_at),
      interviewers,
      dimensions_available: facts.dimensions_available,
      covered_dimensions: covered,
      uncovered_dimensions: uncovered,
    })
  }
  return rounds
}

/** `buildReferencePoints` 需要的本行维度事实（`effective_rubric.dimensions` 的结构子集）。 */
export interface ReferencePointDimension {
  readonly key: string
  readonly label: string
  readonly weight: number
  readonly focus: boolean
  readonly must_cover: boolean
}

/** `buildReferencePoints` 的输入。 */
export interface ReferencePointFacts {
  /** `buildPriorRounds()` 的结果（只含紧邻上一轮）。 */
  readonly prior_rounds: readonly PriorRound[]
  /** 本轮维度宇宙（顺序 = `effective_rubric.dimensions` 顺序）；不可用时是空数组。 */
  readonly dimensions: readonly ReferencePointDimension[]
  /** `materials.resume?.fields`（解析失败/未解析时调用方给 null：不读半成品）。 */
  readonly resume_fields: unknown
}

/** 参考点上限（DESIGN §1.2：目标 2–4 条，超过 4 条一律截断）。 */
const REFERENCE_POINT_LIMIT = 4
/** `PRIOR_GAP` 上限（DESIGN §1.2 第 1 条：最多 2 条）。 */
const PRIOR_GAP_LIMIT = 2
/** `RESUME_HIGHLIGHT` 上限（DESIGN §1.2 第 3 条：最多 1 条）。 */
const RESUME_HIGHLIGHT_LIMIT = 1

/**
 * 原因码 → 中文（`PRIOR_GAP.why` 的 `<原因中文>`，DESIGN §1.2）。
 * 只陈述"上一轮为什么没给出这一维的评价"，不推测原因、不含机器码。
 */
const UNCOVERED_REASON_TEXT: Readonly<Record<PriorRoundUncoveredReason, string>> = {
  NO_SCORECARD: '上一轮没有提交的面评',
  NO_ITEMS: '上一轮面评的分项读不到',
  NOT_RATED: '上一轮的面评里没有这一维',
  NOT_OBSERVED: '上一轮没有观察到这一维',
  UNREADABLE: '上一轮读不出这一维的依据',
}

/**
 * D-141 的**渲染文本**禁令（`point`/`why` 只允许面向面试官的中文；**结构化字段**才放机器码）。
 *
 * 每条禁令一个正则，命中多项时返回所有命中码（去重、顺序固定）：
 *   · `UUID` / `64HEX` / `LONG_HEX`：标识符与哈希不外露；
 *   · `SNAKE_CASE`：字段名（如 `backend_depth`）不给人看；
 *   · `PATH`：`src/http/x.ts` 这类 ASCII 路径；中文标签里的「异步/队列」不算（`/` 两侧
 *     必须都是 ASCII token）；
 *   · `MACHINE_CODE`：`ADVANCE`/`MET`/`NOT_OBSERVED` 这类枚举码只活在结构化字段里；
 *   · `INSTRUCTIONAL_WORDING`：参考不是指令（「必须/应该/务必/一定要/按顺序/先问…再问」）。
 */
const FORBIDDEN_RENDER_TEXT: readonly { readonly code: string; readonly pattern: RegExp }[] = [
  { code: 'UUID', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu },
  { code: '64HEX', pattern: /(?:^|[^0-9a-f])[0-9a-f]{64}(?![0-9a-f])/iu },
  { code: 'LONG_HEX', pattern: /(?:^|[^0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/iu },
  { code: 'SNAKE_CASE', pattern: /(?:^|[^A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/u },
  { code: 'PATH', pattern: /(?:^|[^A-Za-z0-9_.-])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?![A-Za-z0-9_.-])/u },
  {
    code: 'MACHINE_CODE',
    pattern: /(?:^|[^A-Za-z0-9_])(?:ADVANCE|HOLD|REJECT|MET|NOT_MET|NOT_OBSERVED|UNREADABLE|PENDING|SUBMITTED|WAIVED|NO_SCORECARD|NO_ITEMS|NOT_RATED|ROUND_CONFIG|ROUND_OVERRIDE|JOB_BASE|PRIOR_GAP|RUBRIC_DIMENSION|RESUME_HIGHLIGHT)(?![A-Za-z0-9_])/u,
  },
  { code: 'INSTRUCTIONAL_WORDING', pattern: /必须|应该|务必|一定要|按顺序|先问[^。]*再问/u },
]

/**
 * 一段**渲染文本**命中的 D-141 禁令（空数组 = 合规）。纯函数，单测直接穷举。
 * @param value - 准备写进 `point`/`why` 的文本。
 * @returns 命中的禁令码（去重、固定顺序；空数组 = 可以渲染）。
 */
export function renderTextViolations(value: string): readonly string[] {
  const hits: string[] = []
  for (const rule of FORBIDDEN_RENDER_TEXT) {
    if (rule.pattern.test(value) && !hits.includes(rule.code)) hits.push(rule.code)
  }
  return hits
}

/**
 * 紧邻上一轮里**真正没覆盖**的维度（round 级 union，按维度顺序）。
 *
 * 为什么按"轮"而不是按"场"聚合：DESIGN §1 的前置轮次是"轮"（同一轮可能有多场面试），
 * 某一维只要在**任一场**的 SUBMITTED 面评里被评过，就算这一轮覆盖了（与多位面试官 union 的
 * 同一条语义）；否则才算 gap。多个元素都判"未覆盖"时，原因取**第一个**元素的（确定性）。
 *
 * @param priorRounds - `buildPriorRounds()` 的结果。
 * @param universe - 本轮维度宇宙（顺序 = 覆盖判定/渲染顺序）。
 * @returns gap 维度（最多由调用方截断；没有可用轮次时 `[]`）。
 */
function priorRoundGaps(
  priorRounds: readonly PriorRound[],
  universe: readonly PriorRoundDimension[],
): PriorRoundUncoveredDimension[] {
  if (!priorRounds.some((round) => round.dimensions_available)) return []
  const coveredKeys = new Set<string>()
  const reasonByKey = new Map<string, PriorRoundUncoveredReason>()
  for (const round of priorRounds) {
    for (const dimension of round.covered_dimensions) coveredKeys.add(dimension.key)
    for (const dimension of round.uncovered_dimensions) {
      if (!reasonByKey.has(dimension.key)) reasonByKey.set(dimension.key, dimension.reason)
    }
  }
  const gaps: PriorRoundUncoveredDimension[] = []
  for (const dimension of universe) {
    if (coveredKeys.has(dimension.key)) continue
    const reason = reasonByKey.get(dimension.key)
    // available 的轮次里每个维度必在 covered 或 uncovered 之一；缺了就是数据不自洽，不当 gap。
    if (reason === undefined) continue
    gaps.push({ key: dimension.key, label: dimension.label, weight: dimension.weight, reason })
  }
  return gaps
}

/** 一条"没展开"的简历经历（`header_text` 只有一行，公司/职位都没拆出来）。 */
interface UnexpandedExperience {
  readonly ref: string
  readonly header_text: string
}

/**
 * 简历里**没有展开**的经历（DESIGN §1.2 第 3 条）：
 * `parsed_fields.fields.work_experience.entries[]` 里 `header_text` 非空、且 `title`、`company`
 * 都为空（结构化没拆开 = 只有一行摘要）。`ref` 用 `entries[]` 的**数组下标**（0 起）。
 * 脏 jsonb 一律容错：不是对象/不是数组 → 空数组（不抛错、不编造）。
 *
 * @param resumeFields - `materials.resume?.fields`（原始 `parsed_fields`，注意还要进一层 `.fields`）。
 * @returns 未展开经历（顺序 = `entries[]` 顺序；调用方截断到 1 条）。
 */
function unexpandedExperienceEntries(resumeFields: unknown): UnexpandedExperience[] {
  const out: UnexpandedExperience[] = []
  if (!isPlainObject(resumeFields)) return out
  const parsedFields = resumeFields.fields
  if (!isPlainObject(parsedFields)) return out
  const workExperience = parsedFields.work_experience
  if (!isPlainObject(workExperience)) return out
  const entries = asArray(workExperience.entries)
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!isPlainObject(entry)) continue
    const headerText = text(entry.header_text)
    if (headerText === null) continue
    // `title`/`company` 只要有一个非空，就说明这段经历已经拆开过（不是"只有一行摘要"）。
    if (text(entry.title) !== null || text(entry.company) !== null) continue
    out.push({ ref: `work_experience[${index}]`, header_text: headerText })
  }
  return out
}

/** 权重降序、同权重保持原顺序（显式稳定排序，不依赖引擎对 `sort` 稳定性的保证）。 */
function sortByWeightDescending(
  dimensions: readonly ReferencePointDimension[],
): ReferencePointDimension[] {
  return dimensions
    .map((dimension, index) => ({ dimension, index }))
    .sort((left, right) => right.dimension.weight - left.dimension.weight || left.index - right.index)
    .map((entry) => entry.dimension)
}

/** `RESUME_HIGHLIGHT.why`（DESIGN §1.2 逐字口径；唯一一份，写死在这里不让拼写漂移）。 */
const RESUME_HIGHLIGHT_WHY = '材料里这段经历只有一行摘要，没有写具体做法；可以参考它了解真实的技术选择。'

/** `PRIOR_GAP.point`（DESIGN §1.2 逐字口径）。 */
function priorGapPointOf(gap: PriorRoundUncoveredDimension): string {
  return `上一轮没有覆盖到「${gap.label}」`
}

/** `PRIOR_GAP.why`（DESIGN §1.2 逐字口径；`<原因中文>` 来自 `UNCOVERED_REASON_TEXT`）。 */
function priorGapWhyOf(gap: PriorRoundUncoveredDimension): string {
  return `岗位标准里有这一条（权重 ${gap.weight}），但上一轮的面评没有给出这一维的评价`
    + `（${UNCOVERED_REASON_TEXT[gap.reason]}）。这一轮可以自己确认一下。`
}

/** `RESUME_HIGHLIGHT.point`（DESIGN §1.2 逐字口径）。 */
function resumeHighlightPointOf(experience: UnexpandedExperience): string {
  return `简历里有一段没有展开的经历：${experience.header_text}`
}

/** `RUBRIC_DIMENSION.point`（DESIGN §1.2 逐字口径）。 */
function rubricDimensionPointOf(dimension: ReferencePointDimension): string {
  return `可以重点了解「${dimension.label}」`
}

/**
 * `RUBRIC_DIMENSION.why`（DESIGN §1.2 的两个逐字分支）：
 * 本轮重点 → "轮次配置把它标为重点"；否则（无重点按权重回退）→ "权重较高，前面还没有证据"。
 */
function rubricDimensionWhyOf(dimension: ReferencePointDimension, isFocused: boolean): string {
  return isFocused
    ? `岗位标准里有这一条（权重 ${dimension.weight}），本轮轮次配置把它标为重点。`
    : `岗位标准里这一条权重较高（${dimension.weight}），前面的轮次还没有聊到这一条，材料里也没有对应的原文。`
}

/**
 * 构造 §1 的 `reference_points`（纯函数、确定性、2–4 条；DESIGN §1.2 **v2** 逐字口径）。
 *
 * 池子顺序固定（展示顺序不变）：`PRIOR_GAP`（≤2）→ `RUBRIC_DIMENSION`（focus/must_cover；
 * 一个都没有时按 `weight desc`，同权重保持原顺序）→ `RESUME_HIGHLIGHT`（≤1），总上限 4 条。
 *
 * 两条 v2 规则（2026-11-16 Owner 冻结）：
 *   1. **维度 key 是跨 kind 的去重命名空间**：同一维度已经作为 PRIOR_GAP 出现，就不再出
 *      RUBRIC_DIMENSION —— 否则面试官会看到「上一轮没覆盖到「X」」+「可以重点了解「X」」两条
 *      重复内容。`RESUME_HIGHLIGHT` 不在维度命名空间里，用自己的 `ref` 去重。
 *   2. **给简历留一个名额**：若简历里存在**可用**的未展开经历（文案也过 D-141），维度类
 *      （PRIOR_GAP + RUBRIC_DIMENSION）最多 3 条，第 4 条留给 RESUME_HIGHLIGHT；没有可用简历
 *      条目时维度类可以填满 4 条（简历不存在/不可用时不让名额空转）。
 *
 * 其余不变量：可用池不足 2 条时**如实少给**（不编造）；无前置轮次时一条 `PRIOR_GAP` 都没有；
 * 任何一条的 `point`/`why` 命中 D-141 禁令（例如 rubric 标签里写了 snake_case 字段名）→
 * **跳过该条**（宁缺不脏），不影响其它条与其它字段。
 *
 * @param facts - 前置轮次 + 本轮维度宇宙 + 简历字段。
 * @returns 参考点（顺序 = 池子顺序；最多 4 条）。
 */
export function buildReferencePoints(facts: ReferencePointFacts): readonly InterviewerReferencePoint[] {
  const points: InterviewerReferencePoint[] = []
  const renderable = (point: string, why: string): boolean =>
    renderTextViolations(point).length === 0 && renderTextViolations(why).length === 0

  // 简历候选先算（它决定维度类要不要让出第 4 个名额）；"可用"= 文案也过 D-141，
  // 否则留出来的名额会空转（宁可让维度类填满 4 条）。
  const resumeHighlights = unexpandedExperienceEntries(facts.resume_fields)
    .slice(0, RESUME_HIGHLIGHT_LIMIT)
    .filter((experience) => renderable(resumeHighlightPointOf(experience), RESUME_HIGHLIGHT_WHY))
  // DESIGN §1.2 v2：有可用简历条目 → 维度类最多 3 条（第 4 条留给简历）；没有 → 维度类填满 4。
  const dimensionBudget = resumeHighlights.length > 0
    ? REFERENCE_POINT_LIMIT - RESUME_HIGHLIGHT_LIMIT
    : REFERENCE_POINT_LIMIT

  // 维度命名空间：PRIOR_GAP 与 RUBRIC_DIMENSION 共用（同一维度只出一条）。
  const dimensionKeys = new Set<string>()
  const pushDimension = (
    point: string,
    why: string,
    basis: InterviewerReferencePointBasis,
    dimensionKey: string,
  ): void => {
    if (points.length >= dimensionBudget) return
    if (dimensionKeys.has(dimensionKey)) return
    if (!renderable(point, why)) return
    dimensionKeys.add(dimensionKey)
    points.push({ point, why, basis })
  }

  const universe: PriorRoundDimension[] = facts.dimensions.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    weight: dimension.weight,
  }))

  // ---- 1) PRIOR_GAP：紧邻上一轮没覆盖到的维度（按维度顺序，最多 2 条）----
  for (const gap of priorRoundGaps(facts.prior_rounds, universe).slice(0, PRIOR_GAP_LIMIT)) {
    pushDimension(priorGapPointOf(gap), priorGapWhyOf(gap), { kind: 'PRIOR_GAP', ref: gap.key }, gap.key)
  }

  // ---- 2) RUBRIC_DIMENSION：本轮重点；没有重点时按权重（已出过 PRIOR_GAP 的维度跳过）----
  const focused = facts.dimensions.filter((dimension) => dimension.focus || dimension.must_cover)
  const pool = focused.length > 0 ? [...focused] : sortByWeightDescending(facts.dimensions)
  const focusedKeys = new Set(focused.map((dimension) => dimension.key))
  for (const dimension of pool) {
    pushDimension(
      rubricDimensionPointOf(dimension),
      rubricDimensionWhyOf(dimension, focusedKeys.has(dimension.key)),
      { kind: 'RUBRIC_DIMENSION', ref: dimension.key },
      dimension.key,
    )
  }

  // ---- 3) RESUME_HIGHLIGHT：简历里未展开的经历（最多 1 条；用自己的 ref 去重）----
  const resumeRefs = new Set<string>()
  for (const experience of resumeHighlights) {
    if (points.length >= REFERENCE_POINT_LIMIT) break
    if (resumeRefs.has(experience.ref)) continue
    resumeRefs.add(experience.ref)
    points.push({
      point: resumeHighlightPointOf(experience),
      why: RESUME_HIGHLIGHT_WHY,
      basis: { kind: 'RESUME_HIGHLIGHT', ref: experience.ref },
    })
  }

  return points
}

/**
 * brief（§1.5）：三态**只看两个事实**——有没有模板行、有没有可用的 rubric 维度。
 *
 *   · 有模板行 → `TEMPLATE`：objective/briefing(survey 的 `summary`)/focus/questions 全部取自模板；
 *   · 无模板 + 有 rubric 维度 → `JOB_RUBRIC`：`objective=job.title`、`focus=rubric 维度`、
 *     `briefing=null`、`questions=[]`（**标注来源，不冒充面试简报原文**）；
 *   · 都没有 → `NONE` + `reason`（写清为什么没有简报）。
 *
 * @param input - 已读出的扩展行 + 该申请的有效 rubric（越界时传 null）。
 * @returns §1.4 的 `brief` 块（`source` 如实标注来源；`NONE` 时 `reason` 写明原因）。
 */
function buildBrief(input: {
  readonly extension: InterviewExtensionRow
  readonly rubric: InterviewerRubric | null
  /** 本场面试的轮次（`readInterviewValue()` 的 `round_no`）；用于模板轮次守卫。 */
  readonly roundNo: number
}): InterviewerBrief {
  const { extension, rubric, roundNo } = input
  const templateVersionId = text(extension.template_version_id)
  const evaluation = evaluateRoundConfig(roundFactsOf(extension, roundNo))
  if (templateVersionId !== null && evaluation.compatible) {
    return {
      available: true,
      source: 'TEMPLATE',
      objective: text(extension.template_objective),
      // `briefing->>'summary'`：先取文本再字符串化（整块 jsonb 直接 stringify 会带上结构噪声）。
      briefing: text(extension.template_briefing_summary),
      focus: briefFocusOf(extension.template_focus),
      questions: questionTextsOf(extension.template_questions),
      template_version_id: templateVersionId,
      template_payload_hash: text(extension.template_payload_hash),
      reason: null,
    }
  }

  // 绑定了模板但**不可套用**（跨岗位 / 轮次不符）：模板原文一律不展示 ——
  // 否则"别的岗位/别的轮次"的 focus/问题会从 brief 泄露（与 round_focus/effective_rubric 同一条纪律）。
  // 简报降级到岗位 rubric 维度（有）或 NONE（没有），reason 写明模板为什么被拒。
  if (templateVersionId !== null && !evaluation.compatible) {
    const rejected = evaluation.reason
      ?? `绑定的轮次模板 ${templateVersionId} 不可套用，简报已降级`
    if (rubric !== null && rubric.dimensions.length > 0) {
      return {
        available: true,
        source: 'JOB_RUBRIC',
        objective: text(extension.job_title),
        briefing: null,
        focus: rubric.dimensions.map((dimension) => ({
          key: dimension.key,
          label: dimension.label,
          weight: dimension.weight,
        })),
        questions: [],
        template_version_id: null,
        template_payload_hash: null,
        reason: rejected,
      }
    }
    return {
      available: false,
      source: 'NONE',
      objective: null,
      briefing: null,
      focus: [],
      questions: [],
      template_version_id: null,
      template_payload_hash: null,
      reason: rejected,
    }
  }

  if (rubric !== null && rubric.dimensions.length > 0) {
    return {
      available: true,
      source: 'JOB_RUBRIC',
      // 没有模板就没有"本轮目标/简报原文"：目标退到岗位名（这是岗位事实，不是编造的简报）。
      objective: text(extension.job_title),
      briefing: null,
      focus: rubric.dimensions.map((dimension) => ({
        key: dimension.key,
        label: dimension.label,
        weight: dimension.weight,
      })),
      questions: [],
      template_version_id: null,
      template_payload_hash: null,
      reason: null,
    }
  }

  const pinned = text(extension.pinned_rubric_version_id)
  let reason: string
  if (pinned !== null && rubric === null) {
    reason = '申请的 rubric 版本不属于该申请岗位（或已不存在），服务端不猜版本，因此没有可展示的简报'
  } else if (rubric !== null) {
    reason = '申请钉住的 rubric 版本没有任何维度，无法给出考察重点'
  } else {
    reason = '本场面试没有绑定面试模板，申请也没有钉住可用的 rubric 版本（没有简报可展示）'
  }
  return {
    available: false,
    source: 'NONE',
    objective: null,
    briefing: null,
    focus: [],
    questions: [],
    template_version_id: null,
    template_payload_hash: null,
    reason,
  }
}

/**
 * rubric 块（§1.5）：申请钉住且**属于该申请岗位**才给；否则 null（不挑一个看起来对的版本）。
 *
 * @param extension - 扩展行（rubric 的 join 已带 `rv.job_id = a.job_id`）。
 * @returns rubric 块或 null。
 */
function buildRubric(extension: InterviewExtensionRow): InterviewerRubric | null {
  const pinned = text(extension.pinned_rubric_version_id)
  const rubricId = text(extension.rubric_version_id)
  if (pinned === null || rubricId === null) return null
  return {
    rubric_version_id: rubricId,
    job_id: text(extension.application_job_id) ?? '',
    payload_hash: text(extension.rubric_payload_hash) ?? '',
    dimensions: rubricDimensionsOf(extension.rubric_dimensions),
  }
}

/**
 * materials 块（§1.5）：`resume_version_id` 为空 → NO_MATERIAL_BOUND；`parse_status='FAILED'`
 * → PARSE_FAILED；其余 → `available:true` + `parsed_fields` 原样。
 *
 * 为什么把 `PENDING/PARSING` 也判成不可用（`NOT_PARSED`）：还**没有**解析结果时给
 * `available:true, fields:{}` 等于说"材料可用但字段是空的"，那是把"没读到"说成"读到了"。
 * 这个原因码在契约 §1.4 的注释里已经列出（`NO_MATERIAL_BOUND / NOT_PARSED / …`）。
 */
function buildMaterials(extension: InterviewExtensionRow): InterviewerMaterials {
  const resumeVersionId = text(extension.resume_version_id)
  if (resumeVersionId === null) {
    return {
      authorization: MATERIALS_AUTHORIZATION,
      available: false,
      reason: 'NO_MATERIAL_BOUND',
      resume: null,
    }
  }
  const parseStatus = text(extension.resume_parse_status) ?? 'UNKNOWN'
  const resume: InterviewerResumeMaterial = {
    resume_version_id: resumeVersionId,
    parse_status: parseStatus,
    parser_name: text(extension.resume_parser_name) ?? '',
    parser_version: text(extension.resume_parser_version) ?? '',
    content_sha256: text(extension.resume_content_sha256) ?? '',
    // 解析失败/未完成时不给字段（`parsed_fields` 可能是半成品，展示它等于编造"已解析"）。
    fields: parseStatus === 'FAILED' || parseStatus === 'PENDING' || parseStatus === 'PARSING'
      ? {}
      : isPlainObject(extension.resume_parsed_fields) ? extension.resume_parsed_fields : {},
  }
  if (parseStatus === 'FAILED') {
    return { authorization: MATERIALS_AUTHORIZATION, available: false, reason: 'PARSE_FAILED', resume }
  }
  if (parseStatus === 'PENDING' || parseStatus === 'PARSING') {
    return { authorization: MATERIALS_AUTHORIZATION, available: false, reason: 'NOT_PARSED', resume }
  }
  return { authorization: MATERIALS_AUTHORIZATION, available: true, reason: null, resume }
}

/** DB 的 scorecard.status（封闭集 PENDING/SUBMITTED/WAIVED）→ §1.4 的 state。 */
function scorecardStateOf(status: string | undefined): InterviewerScorecardState {
  if (status === 'SUBMITTED') return 'SUBMITTED'
  if (status === 'WAIVED') return 'WAIVED'
  // `PENDING` 与"理论上不存在的其它值"都算草稿：DB 的 ck_scorecard_status 已把取值封闭成三个。
  if (status === 'PENDING') return 'PENDING'
  return 'NONE'
}

/** `required_action`（§1.4 的封闭集）：已提交 → 复核；已豁免 → 无事；其余按是否必填。 */
function requiredActionOf(
  state: InterviewerScorecardState,
  requiredScorecard: boolean,
): InterviewerRequiredAction {
  if (state === 'SUBMITTED') return 'REVIEW_SCORECARD'
  if (state === 'WAIVED') return 'NONE'
  return requiredScorecard ? 'SUBMIT_SCORECARD' : 'NONE'
}

/** `toInterviewRow` 的输入（单测直接构造假 `InterviewValue` + 假扩展行）。 */
export interface ToInterviewRowInput {
  /** `readInterviewValue()` 的规范值（**含所有面试官**的当前面评；本函数只取自己那一行）。 */
  readonly value: InterviewValue
  /** §1.5 的扩展行（candidate/job/rubric/template/resume + 我自己的面评两个附加列）。 */
  readonly extension: InterviewExtensionRow
  /** 我的 actor id（从绑定来；只用于在 `interviewers[]` 里定位自己）。 */
  readonly actorId: string
  /**
   * task-51：**紧邻上一轮**的 SQL 行（本行子集；`readInterviewerWorkspace()` 用一条批量
   * SELECT 取回后按 `current_interview_id` 分组）。缺省 `[]` = 没有前置轮次事实，
   * 此时 `prior_rounds: []`、`reference_points` 里不会出现 `PRIOR_GAP`（旧调用方行为不变）。
   */
  readonly priorRoundRows?: readonly PriorRoundRow[]
  /**
   * docs/34 §2：本行的候选约束（批量读后按 interview/candidate 分组）。缺省 = 没有约束，
   * `candidate_constraints` 落成 `{pins:[], handoff:null}`（旧调用方行为不变）。
   */
  readonly candidateConstraints?: InterviewerCandidateConstraints
}

/** `toInterviewRow` 的输出：一行 + 该行本身带出的 issue（rubric 越界）。 */
export interface ToInterviewRowResult {
  readonly row: InterviewerRow
  readonly issues: readonly string[]
}

/**
 * 把一个面试映射成 §1.4 的元素（**纯函数**，不碰 DB）。
 *
 * 三处必须说清的行为：
 *   1. **只看得到自己的面评**：`value.interviewers` 里找 `actor_id === 我`，只用那一行的
 *      `scorecard`；别人的面评即使存在也不会被读到，更不会进 issue/日志。
 *      找不到自己那一行 = 数据在两次读取之间变了（我不再是这场的面试官）→ `NOT_FOUND`
 *      （不猜一个"空面评"把它说成"未填"）。
 *   2. `record_version`/`overall` 是 `readInterviewValue()` 不暴露的字段，从扩展行补；
 *      但**只有 scorecard_id 相同**时才补（两次读取若看到不同的当前面评，宁可回 null，
 *      也不把 A 行的 record_version 挂到 B 行上）。
 *   3. rubric 越界（钉住了版本但不属于该申请岗位）→ rubric 置空 + 一条 issue（不猜版本）。
 *   4. 轮次侧（W3b）：`round_focus` / `effective_rubric` 由同目录的纯函数组装；跨岗位/轮次不符/
 *      本轮重点维度越界/模板声明 rubric 冲突各自写成一条 issue（正常路径 0 条）。
 *
 * @param input - `readInterviewValue()` 的值 + 扩展行 + 我的 actor id。
 * @returns 行 + issues。
 * @throws RecruitmentToolError - `NOT_FOUND(INTERVIEWER_ROW_MISSING)`（不再是我的面试）。
 */
export function toInterviewRow(input: ToInterviewRowInput): ToInterviewRowResult {
  const { value, extension, actorId } = input
  const mine = value.interviewers.find((row) => row.actor_id === actorId)
  if (mine === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'INTERVIEWER_ROW_MISSING',
      message: '这场面试的面试官列表里已经没有当前 actor（数据在两次读取之间变化，不猜面评状态）',
      detail: { interview_id: value.id, actor_id: actorId },
    })
  }

  const issues: string[] = []
  const pinned = text(extension.pinned_rubric_version_id)
  const rubric = buildRubric(extension)
  if (pinned !== null && rubric === null) {
    // 钉住了但 join 不上：要么不属于该申请岗位，要么该版本已不存在 —— 两者都只能如实置空。
    issues.push(
      `面试 ${value.id}：申请钉住的 rubric 版本 ${pinned} 不属于该申请的岗位`
      + ` ${text(extension.application_job_id) ?? '?'}（或已不存在），rubric 已置空，不猜版本`,
    )
  }

  // W3b：轮次重点 + 面评 Rubric 投影（模板不可套用 → JOB_BASE + reason；不猜、不硬套）。
  const roundFacts = roundFactsOf(extension, value.round_no)
  const roundFocus = buildRoundFocus(roundFacts)
  const effectiveRubric = buildEffectiveRubric(roundFacts)
  // issue 必须指明是哪一场（overview 是多行聚合，没有 id 的 issue 无法定位）。
  for (const roundIssue of collectRoundIssues(roundFacts)) {
    issues.push(`面试 ${value.id}：${roundIssue}`)
  }

  const current = mine.scorecard
  const state = scorecardStateOf(current?.status)
  // 只有两次读取指向同一条面评时才补 record_version/overall（否则回 null，不混行）。
  const sameScorecard = current !== undefined && text(extension.scorecard_id) === current.scorecard_id

  // task-51：两块加法（`materials` 先构造一次，简历参考点只读**同一份**已暴露字段，
  // 未解析/解析失败时 fields 是 {} → 不会从半成品里编造"未展开经历"）。
  const materials = buildMaterials(extension)
  const priorRounds = buildPriorRounds({
    round_no: value.round_no,
    dimensions_available: effectiveRubric.available,
    // 维度宇宙恒 = 本行 `effective_rubric.dimensions`（同一申请各轮一致；不可用时为空）。
    dimensions: effectiveRubric.dimensions.map((dimension) => ({
      key: dimension.key,
      label: dimension.label,
      weight: dimension.weight,
    })),
    rows: input.priorRoundRows ?? [],
  })
  const referencePoints = buildReferencePoints({
    prior_rounds: priorRounds,
    dimensions: effectiveRubric.dimensions,
    resume_fields: materials.resume?.fields ?? null,
  })

  // docs/34 §2：候选约束（纯投影，缺行 → pins:[]/handoff:null）。有人在上一轮留了交接提醒时，
  // 把"上一轮留给本轮的追问：{text}"追加进 brief.questions（形状不变；只在有 handoff 时加，
  // 旧调用方/旧断言的 questions 内容不变）。不吐完整 UUID。
  const candidateConstraints: InterviewerCandidateConstraints = input.candidateConstraints ?? {
    pins: [],
    handoff: null,
  }
  const baseBrief = buildBrief({ extension, rubric, roundNo: value.round_no })
  const brief: InterviewerBrief = candidateConstraints.handoff === null
    ? baseBrief
    : {
      ...baseBrief,
      questions: [...baseBrief.questions, `上一轮留给本轮的追问：${candidateConstraints.handoff.text}`],
    }

  return {
    row: {
      interview_id: value.id,
      application_id: value.application_id,
      candidate: {
        candidate_id: value.candidate_id,
        display_name: text(extension.candidate_display_name) ?? '',
      },
      job: {
        job_id: value.job_id,
        code: text(extension.job_code) ?? '',
        title: text(extension.job_title) ?? '',
      },
      round_no: value.round_no,
      slot_code: value.slot_code,
      status: value.status,
      ...(value.no_show === undefined ? {} : { no_show: value.no_show }),
      stage_code: value.stage_code,
      scheduled_start_at: value.scheduled_start_at ?? null,
      scheduled_end_at: value.scheduled_end_at ?? null,
      timezone: value.timezone,
      record_version: value.record_version,
      role_in_interview: mine.role_in_interview,
      required_scorecard: mine.required_scorecard,
      scorecard_due_at: mine.scorecard_due_at ?? null,
      brief,
      rubric,
      round_focus: roundFocus,
      effective_rubric: effectiveRubric,
      materials,
      transcript: {
        // §1.5：直接取 readInterviewValue() 的 transcript 与 meeting_binding（禁止另写 TR-D）。
        state: value.transcript.state,
        reason_code: value.transcript.reason_code,
        no_transcript: value.transcript.no_transcript,
        meeting_binding_state: value.meeting_binding.state,
        meetings_total: value.meeting_binding.count,
      },
      scorecard: {
        state,
        scorecard_id: current?.scorecard_id ?? null,
        status: current?.status ?? null,
        revision_no: current?.revision_no ?? null,
        record_version: sameScorecard ? integerOr(extension.scorecard_record_version, 0) : null,
        submitted_at: current?.submitted_at ?? null,
        transcript_basis: current?.transcript_basis ?? null,
        overall: sameScorecard ? text(extension.scorecard_overall) : null,
      },
      required_action: requiredActionOf(state, mine.required_scorecard),
      prior_rounds: priorRounds,
      reference_points: referencePoints,
      candidate_constraints: candidateConstraints,
    },
    issues,
  }
}

/**
 * §1.4 的六个计数（**服务端算**；客户端 `deriveWorkspaceStats` 不重算）。
 *
 * 三个口径说明：
 *   · `pending_scorecard_total` 只数 `required_scorecard` 的行（可选面评不算"待提交"，
 *     否则"我该做什么"里会混进不必做的事）；
 *   · `open_interview_total` 只排除 DECIDED/CANCELLED/NO_SHOW（其余状态都还没终结）；
 *   · `transcript_missing_total` 只数 `MISSING`。`PENDING/PARTIAL/AUTH_REQUIRED/...` 既不是
 *     "就绪"也不是"缺失"（TR-D3：`MISSING` 是终态判定），所以不塞进这两个桶里。
 *
 * @param rows - 本次返回的面试行（`interview_id` 过滤时就是那一行）。
 * @returns 六个非负整数。
 */
export function deriveCounts(rows: readonly InterviewerRow[]): InterviewerCounts {
  let open = 0
  let pending = 0
  let submitted = 0
  let ready = 0
  let missing = 0
  for (const row of rows) {
    if (!CLOSED_INTERVIEW_STATUSES.has(row.status)) open += 1
    if (
      row.required_scorecard
      && (row.scorecard.state === 'NONE' || row.scorecard.state === 'PENDING')
    ) {
      pending += 1
    }
    if (row.scorecard.state === 'SUBMITTED') submitted += 1
    if (row.transcript.state === 'READY') ready += 1
    if (row.transcript.state === 'MISSING') missing += 1
  }
  return {
    assigned_total: rows.length,
    open_interview_total: open,
    pending_scorecard_total: pending,
    submitted_scorecard_total: submitted,
    transcript_ready_total: ready,
    transcript_missing_total: missing,
  }
}

// =====================================================================
//  §1.3 读入口（纯：不建池、不开事务；只发 SELECT）
// =====================================================================

/** `sectionLimit` 归一：缺省 20；给多少都不许超过 20（契约不允许放大），下限 1。 */
function normalizeSectionLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_SECTION_LIMIT
  const value = Math.trunc(raw)
  if (!Number.isFinite(value)) return DEFAULT_SECTION_LIMIT
  return Math.max(1, Math.min(value, DEFAULT_SECTION_LIMIT))
}

/** 一条"我的面试"已读到的事实（扩展行 + `readInterviewValue()` 的值），批量前置轮次查询的输入。 */
export interface InterviewerFact {
  readonly interviewId: string
  readonly value: InterviewValue
  readonly extension: InterviewExtensionRow
}

/**
 * 一条 SELECT 取回**所有**当前行的紧邻上一轮事实，并按当前面试 id 分组。
 *
 * 只有 `round_no > 1` 的行参与（第 1 轮没有上一轮；也不必为它发查询）。返回的 Map 缺省即
 * "没有前置轮次"，`toInterviewRow` 会把它落成 `prior_rounds: []`（不是 `undefined`）。
 *
 * @param client - 只读事务内的连接（本函数只发 SELECT）。
 * @param tenantId - 租户（只从配置来）。
 * @param facts - 当前行（扩展行 + 规范值）。
 * @returns 当前面试 id → 上一轮的 SQL 行（顺序 = SQL 的 `slot_code asc, id asc`）。
 */
async function loadPriorRoundRows(
  client: DatabaseClient,
  tenantId: string,
  facts: readonly InterviewerFact[],
): Promise<ReadonlyMap<string, readonly PriorRoundRow[]>> {
  const grouped = new Map<string, PriorRoundRow[]>()
  const candidates = facts.filter((fact) => fact.value.round_no > 1)
  if (candidates.length === 0) return grouped
  const result = await client.query<PriorRoundRow>(PRIOR_ROUND_SQL, [
    candidates.map((fact) => fact.interviewId),
    candidates.map((fact) => fact.value.application_id),
    candidates.map((fact) => fact.value.round_no),
    tenantId,
  ])
  for (const row of result.rows) {
    const currentId = text(row.current_interview_id)
    if (currentId === null) continue
    const rows = grouped.get(currentId)
    if (rows === undefined) grouped.set(currentId, [row])
    else rows.push(row)
  }
  return grouped
}

/**
 * 旧库兼容：迁移 0019 之前没有 `recruitment.candidate_constraint` 表，
 * 直接 `select ... from recruitment.candidate_constraint` 会让整个面试官读接口 500。
 * 用 `to_regclass` 探测一次（tenant 无关；不存在返回 null，不抛 42P01）。
 * 真 DB 错误仍上抛，由 HTTP 层映射 5xx —— 不把所有错都吞成"表不存在"。
 */
const CANDIDATE_CONSTRAINT_TABLE_SQL =
  `select to_regclass('recruitment.candidate_constraint') is not null as exists`

/** 导出的纯判定：给探测结果行，决定约束读链路是否可用（便于单测旧库分支）。 */
export function candidateConstraintTableExists(row: unknown): boolean {
  if (typeof row !== 'object' || row === null) return false
  const value = (row as Record<string, unknown>).exists
  return value === true || value === 't' || value === '1'
}

/**
 * 一次只读探测：表不存在 → false（跳过约束读，不失败）；DB 错误 → 上抛。
 * 每次 `loadCandidateConstraints` 只调一次，不是每行都探测。
 */
async function probeCandidateConstraintTable(client: DatabaseClient): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(CANDIDATE_CONSTRAINT_TABLE_SQL)
  return candidateConstraintTableExists(rows[0])
}

/**
 * docs/34 §2：批量读取候选约束（两条 SELECT，均 tenant 过滤），按 interview id 分组投影。
 *
 *   * PIN 按候选人 id 取（同一候选人可能被多场面试共享 → 每场都挂同一份投影）；
 *   * HANDOFF 按本批 interview id 取，只取本轮 interview 自己那一条（最多一条）。
 *
 * 旧库（< 0019）没有 candidate_constraint 表：探测为 false 时返回空 map，
 * 每行 `candidate_constraints = {pins:[], handoff:null}`（读接口不整体失败）。
 *
 * 墓碑行由领域投影 `toPinProjection` 过滤；这里再 `filter(text !== UNPIN_TOMBSTONE_TEXT)` 双保险。
 * @param client - 只读事务内连接。
 * @param tenantId - 租户（只从配置来）。
 * @param facts - 当前行（扩展行 + 规范值）。
 * @returns interview id → 候选约束投影。
 */
export async function loadCandidateConstraints(
  client: DatabaseClient,
  tenantId: string,
  facts: readonly InterviewerFact[],
): Promise<ReadonlyMap<string, InterviewerCandidateConstraints>> {
  const result = new Map<string, InterviewerCandidateConstraints>()
  if (facts.length === 0) return result

  // 旧库兼容：只探测一次；表不存在 → 空 map（每行由 toInterviewRow 落成空约束），不读约束。
  if (!(await probeCandidateConstraintTable(client))) return result

  const candidateIds = [...new Set(
    facts.map((fact) => fact.extension.candidate_id).filter((id): id is string => typeof id === 'string' && id !== ''),
  )]
  const interviewIds = facts.map((fact) => fact.interviewId)

  const [pinRows, handoffRows] = await Promise.all([
    readPinsForCandidates(client, tenantId, candidateIds),
    readHandoffsForInterviews(client, tenantId, interviewIds),
  ])

  const pinsByCandidate = groupCandidateConstraintRows(pinRows, (row) => row.candidate_id)
  const handoffsByInterview = groupCandidateConstraintRows(handoffRows, (row) => row.interview_id ?? '')
  const candidateIdByInterview = new Map(
    facts.map((fact) => [fact.interviewId, text(fact.extension.candidate_id)]),
  )

  for (const fact of facts) {
    const candidateId = candidateIdByInterview.get(fact.interviewId)
    const pinRowsForCandidate = candidateId === null || candidateId === undefined
      ? []
      : pinsByCandidate.get(candidateId) ?? []
    const pins = toPinProjection(pinRowsForCandidate.filter((row) => row.text !== UNPIN_TOMBSTONE_TEXT))
    const handoffRowsForInterview = handoffsByInterview.get(fact.interviewId) ?? []
    const handoffProjections = toHandoffProjection(handoffRowsForInterview)
    result.set(fact.interviewId, {
      pins,
      // 本轮 interview 对应的上一轮提醒最多一条（取时间最早的一条，稳定）。
      handoff: handoffProjections[0] ?? null,
    })
  }
  return result
}

/** 按 key 把候选约束行分组（保序）。 */
function groupCandidateConstraintRows(
  rows: readonly CandidateConstraintRow[],
  keyOf: (row: CandidateConstraintRow) => string,
): Map<string, CandidateConstraintRow[]> {
  const map = new Map<string, CandidateConstraintRow[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [row])
    else bucket.push(row)
  }
  return map
}

/**
 * 读取当前 actor 的面试官工作台投影（**只读**；接收事务内 client，不自己建池/开事务）。
 *
 * 调用顺序（每一步都 fail-closed）：
 *   1. 服务端 `now()` → `evaluated_at`（同时是 TR-D 的 `as_of`）；
 *   2. actor 行 + 角色标签（actor 不在该租户 → 404 `ACTOR_NOT_FOUND`，不透传 DB 错误）；
 *   3. "我的面试"（只按 `interviewer.actor_id` 过滤）→ 每行 1 条 §1.5 扩展 SQL +
 *      `readInterviewValue()`（TR-D 单一实现）；
 *   4. `labels.provenance` 走 `resolveTenantProvenance()`（R4 单一判定）。
 *
 * task-51（加法）：紧邻上一轮的事实用**一条**批量 SELECT（`PRIOR_ROUND_SQL`）取回，投影成
 * 每行的 `prior_rounds` + `reference_points`（纯函数 `buildPriorRounds`/`buildReferencePoints`）。
 * 前置轮次的授权依据是"我是**当前这一轮**的面试官"（`MY_INTERVIEW_IDS_SQL` 不变），
 * 未分配仍是既有 403 且零行；全部 SELECT，没有新增写路径。
 *
 * W3b 的降级语义（每一行独立判定，**不猜**）：
 *   · `round_focus` 只有在"模板 job 一致 + round_no 一致 + 至少贡献一项内容"时才是
 *     `ROUND_CONFIG`；跨岗位/轮次不符/模板空 → `JOB_BASE`（`available=false` + 中文 reason）；
 *   · `effective_rubric` 的维度宇宙恒 = 申请钉住的岗位 rubric（轮次配置只标记 focus/must_cover
 *     与覆盖显示权重）；模板声明别的 rubric 版本 → 不混用（回显 + reason + issue）；
 *   · 钉住的 rubric 越界（join 不上）→ `rubric=null` + `effective_rubric.available=false` + issue，
 *     **不抛错**（与既有行为一致）。
 *
 * 给了 `options.interviewId` 但那一场不在我的分配里 → `FORBIDDEN(ACTOR_NOT_INTERVIEWER)`，
 * **零行返回**（不确认那场面试是否存在于别人的名下）。
 *
 * @param client - 只读事务内的连接（生产由 `withReadOnly` 提供；测试给回滚事务）。
 * @param cfg - 已解析配置（tenant 只从这里来，不接受入参覆盖）。
 * @param actor - 已绑定的视图身份（只来自 W1 的 resolver；`actor_id` 是唯一过滤依据）。
 * @param options - `interviewId`（只看一场）/ `sectionLimit`（≤20）。
 * @returns §1.4 的投影；未分配/空库 → `interviews: []` + 全 0 计数（不是错误）。
 * @throws RecruitmentToolError - `NOT_FOUND(ACTOR_NOT_FOUND)` / `FORBIDDEN(ACTOR_NOT_INTERVIEWER)`
 *   / `NOT_FOUND(INTERVIEWER_ROW_MISSING)`；DB 读失败原样上抛（由 HTTP 层映射 5xx）。
 */
export async function readInterviewerWorkspace(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  actor: WorkspaceActor,
  options: ReadInterviewerWorkspaceOptions = {},
): Promise<InterviewerOverview> {
  const tenantId = cfg.tenant_id
  const limit = normalizeSectionLimit(options.sectionLimit)

  const nowRow = await client.query<{ now_ts: Date | string }>('select now() as now_ts')
  const evaluatedAt = isoOrNull(nowRow.rows[0]?.now_ts) ?? new Date().toISOString()

  // ---- 视图身份：actor 行 + 角色标签（404 优先于 403：身份本身不成立时不该谈分配）----
  const actorRow = (await client.query<{ actor_id: string; display_name: string }>(ACTOR_SQL, [
    actor.actor_id,
    tenantId,
  ])).rows[0]
  if (actorRow === undefined) {
    throw contractError('NOT_FOUND', {
      reason_code: 'ACTOR_NOT_FOUND',
      message: '绑定的 actor 不在该租户下（alias→actor 只来自服务端受管配置）',
      detail: { actor_id: actor.actor_id },
    })
  }
  const roleRows = await client.query<{ code: string }>(ACTOR_ROLES_SQL, [actor.actor_id, tenantId])

  // ---- 我的面试（按 Interview 分配过滤；不按角色标签）----
  const idRows = await client.query<{ interview_id: string }>(MY_INTERVIEW_IDS_SQL, [
    tenantId,
    actor.actor_id,
    options.interviewId ?? null,
    limit,
  ])
  if (options.interviewId !== undefined && idRows.rows.length === 0) {
    // 不先查"这场面试是否存在"：存在的、别人的、不存在的都回同一个 403，避免探测。
    throw contractError('FORBIDDEN', {
      reason_code: 'ACTOR_NOT_INTERVIEWER',
      message: '这场面试不在你的分配里（只看得到分配给你的面试，零行返回）',
      detail: { interview_id: options.interviewId },
    })
  }

  const interviews: InterviewerRow[] = []
  const issues: string[] = []
  // 先取每场的扩展行 + 规范值（顺序与 idRows 一致）；上一轮的事实需要"申请 + 轮次"才能批量查，
  // 所以先收集、再发**一条** `PRIOR_ROUND_SQL`（只读），最后逐行映射（行为不变）。
  const found: InterviewerFact[] = []
  for (const idRow of idRows.rows) {
    const extension = (await client.query<InterviewExtensionRow>(INTERVIEW_EXTENSION_SQL, [
      idRow.interview_id,
      tenantId,
      actor.actor_id,
    ])).rows[0]
    if (extension === undefined) {
      // 列表说"是我的"、扩展说"不是"：同一事务内本不该发生（并发删除才会），如实报错。
      throw contractError('NOT_FOUND', {
        reason_code: 'INTERVIEWER_ROW_MISSING',
        message: '这场面试的面试官行在两次读取之间消失（不猜结果）',
        detail: { interview_id: idRow.interview_id, actor_id: actor.actor_id },
      })
    }
    const value = await readInterviewValue(client, tenantId, idRow.interview_id, evaluatedAt)
    found.push({ interviewId: idRow.interview_id, value, extension })
  }

  // task-51：紧邻上一轮（同一申请、round_no = 当前轮 - 1），一条批量 SELECT 取回后按当前面试分组。
  const priorRowsByInterview = await loadPriorRoundRows(client, tenantId, found)
  // docs/34 §2：候选约束（置顶 PIN + 本轮 HANDOFF），两条批量 SELECT 后按面试分组。
  const constraintsByInterview = await loadCandidateConstraints(client, tenantId, found)

  for (const fact of found) {
    const mapped = toInterviewRow({
      value: fact.value,
      extension: fact.extension,
      actorId: actor.actor_id,
      priorRoundRows: priorRowsByInterview.get(fact.interviewId) ?? [],
      candidateConstraints: constraintsByInterview.get(fact.interviewId),
    })
    interviews.push(mapped.row)
    issues.push(...mapped.issues)
  }

  // R4：provenance 反映**这次读取**的数据来源（演示租户的行同样真的在库里 —— 那不是 LIVE 的证据）。
  const provenance = await resolveTenantProvenance(client, tenantId)

  return {
    contract_version: CONTRACT_VERSION,
    configured: true,
    evaluated_at: evaluatedAt,
    actor: {
      alias: actor.alias,
      actor_id: actorRow.actor_id,
      // 展示名以库里的行为准：resolver 给的 display_name 只是提示，两个来源不一致时不编造。
      display_name: actorRow.display_name,
      roles: roleRows.rows.map((row) => row.code),
    },
    session: { session_id: actor.session_id ?? '' },
    labels: { provenance, trigger: 'MANUAL', connection: 'CONNECTED' },
    counts: deriveCounts(interviews),
    interviews,
    issues,
  }
}

// =====================================================================
//  HTTP 层
// =====================================================================

/** 用一条连接池读投影（HTTP 路径专用：建池 → 只读事务 → 关池）。 */
async function readOverviewFromDatabase(
  database: ResolvedDatabaseConfig,
  actor: WorkspaceActor,
  options: ReadInterviewerWorkspaceOptions,
): Promise<InterviewerOverview> {
  const pool = createPool(database)
  try {
    return await withReadOnly(pool, async (client) => readInterviewerWorkspace(client, database, actor, options))
  } finally {
    // 每次调用关池：工具/路由都是短事务，不让空闲 socket 挂住宿主事件循环。
    await closePool(pool)
  }
}

/** 写一个 JSON 响应（固定 no-store + nosniff）。 */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, NO_STORE)
  res.end(JSON.stringify(value))
}

/**
 * 契约错误的 HTTP 映射（与 `overview.ts::STATUS_BY_CODE` 同口径：同一张表、同一批状态码）。
 *
 * 为什么在本文件重写一份而不是 import：`overview.ts` 里这张表与 `errorResponse()` 都是
 * 文件私有的（W3-A 的写范围不允许改 `overview.ts`），而错误响应形状必须与它逐字一致
 * （客户端只有一套 `parseHttpError`）。
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_ARGS: 400,
  NOT_FOUND: 404,
  INTERVIEWER_MISMATCH: 403,
  FORBIDDEN: 403,
  ALIAS_MISMATCH: 403,
  DEMO_ACTOR_UNMAPPED: 409,
  ALREADY_SUBMITTED: 409,
  VERSION_CONFLICT: 409,
  EVIDENCE_INSUFFICIENT: 422,
  DB_CONSTRAINT_VIOLATION: 500,
  NOT_CONFIGURED: 503,
}

/** 一个可直接写回给浏览器的 HTTP 问题（状态码 + 已成型错误体）。 */
export class InterviewerHttpProblem extends Error {
  readonly status: number
  readonly body: { readonly error: Record<string, unknown> }

  constructor(status: number, error: Record<string, unknown>) {
    super(`HTTP ${status} ${typeof error.code === 'string' ? error.code : ''}`)
    this.name = 'InterviewerHttpProblem'
    this.status = status
    this.body = { error }
  }
}

/** 造一条 `InterviewerHttpProblem`（`detail` 只在有时出现，禁止用 null 占位）。 */
function httpProblem(
  status: number,
  code: string,
  reasonCode: string,
  message: string,
  detail?: unknown,
): InterviewerHttpProblem {
  const error: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) error.detail = detail
  return new InterviewerHttpProblem(status, error)
}

/**
 * 把任意错误翻成 HTTP 状态 + `{error:{code,reason_code,message,detail?}}`。
 *
 * 优先解析产品错误消息形态 `CODE: <compact-json>`（`RecruitmentToolError` 的既有格式）；
 * 解析不了就按 `.code`/`INTERNAL` 兜底，**绝不**把读失败说成 200/空列表。
 */
function toErrorResponse(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
  const message = error instanceof Error ? error.message : String(error)
  const index = message.indexOf(': ')
  if (index > 0) {
    const prefix = message.slice(0, index)
    try {
      const parsed = JSON.parse(message.slice(index + 2)) as Record<string, unknown>
      const code = typeof parsed.code === 'string' && parsed.code !== '' ? parsed.code : prefix
      const body: Record<string, unknown> = { code }
      if (typeof parsed.reason_code === 'string' && parsed.reason_code !== '') body.reason_code = parsed.reason_code
      body.message = typeof parsed.message === 'string' && parsed.message !== '' ? parsed.message : message
      if (parsed.detail !== undefined) body.detail = parsed.detail
      return { status: STATUS_BY_CODE[code] ?? 500, body: { error: body } }
    } catch {
      // 不是产品错误形态：下面按最小形状兜底。
    }
  }
  const code = typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'INTERNAL'
  return { status: STATUS_BY_CODE[code] ?? 500, body: { error: { code, reason_code: 'UNEXPECTED', message } } }
}

/** 客户端试图覆盖身份的参数/头（命中即 400，且**不碰 DB**）。 */
function findActorOverride(req: Pick<IncomingMessage, 'headers'>, url: URL): string[] {
  const found: string[] = []
  for (const key of ['actor_id', 'tenant_id'] as const) {
    if (url.searchParams.has(key)) found.push(`query.${key}`)
  }
  for (const key of ACTOR_OVERRIDE_HEADERS) {
    if (req.headers[key] !== undefined) found.push(`header.${key}`)
  }
  return found
}

/**
 * 解析并校验查询参数（§1.1；**纯函数**，单测直接喂 `new URL(...)`）。
 *
 * 只允许 `alias`（必填）与 `interview_id`（可选 UUID）：
 *   · 出现其它参数 → 400 `INVALID_ARGS(UNKNOWN_PARAM)`（多一个参数就多一条未声明的读路径）；
 *   · 缺/空 `alias` → 400 `MISSING_REQUIRED`；
 *   · `interview_id` 不是 UUID 文本 → 400 `ID_NOT_UUID`。
 *
 * 注意：这里**不校验** alias 是否在受控三个别名里 —— alias→actor 的唯一权威是 W1 的
 * `SessionActorRegistry`（契约 §1.2），本文件只负责"和绑定比对"，不建第二套别名目录。
 *
 * @param url - 请求 URL（含 searchParams）。
 * @returns `{ alias, interviewId? }`。
 * @throws InterviewerHttpProblem - 400（reason_code 见上）。
 */
export function parseInterviewerQuery(url: URL): { readonly alias: string; readonly interviewId?: string } {
  const unknown = [...url.searchParams.keys()].filter((key) => !(ALLOWED_PARAMS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'UNKNOWN_PARAM',
      `未声明的查询参数 "${unknown[0]}"（允许：${ALLOWED_PARAMS.join(', ')}）`,
      { unknown: [...new Set(unknown)], allowed: [...ALLOWED_PARAMS] },
    )
  }
  const alias = (url.searchParams.get('alias') ?? '').trim()
  if (alias === '') {
    throw httpProblem(400, 'INVALID_ARGS', 'MISSING_REQUIRED', '缺必填查询参数 alias', {
      missing: ['alias'],
    })
  }
  const interviewIdRaw = url.searchParams.get('interview_id')
  if (interviewIdRaw === null) return { alias }
  const interviewId = interviewIdRaw.trim()
  if (interviewId === '' || !isUuid(interviewId)) {
    throw httpProblem(400, 'INVALID_ARGS', 'ID_NOT_UUID', 'interview_id 必须是 UUID 文本', {
      field: 'interview_id',
    })
  }
  return { alias, interviewId }
}

/**
 * 读取并校验 `X-DSH-Session`（§1.1；**纯函数**）。
 *
 * 它是**绑定键**，不是凭据：缺失 → 400 `SESSION_HEADER_REQUIRED`；重复/超 200 字 →
 * 400 `SESSION_HEADER_INVALID`。返回值不做规范化（绑定键必须与浏览器 PUT 时逐字一致）。
 *
 * @param req - 只读 headers 的请求对象。
 * @returns session id 原文。
 * @throws InterviewerHttpProblem - 400（reason_code 见上）。
 */
export function requireSessionId(req: Pick<IncomingMessage, 'headers'>): string {
  const raw = req.headers[SESSION_HEADER]
  if (raw === undefined) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'SESSION_HEADER_REQUIRED',
      '缺少 X-DSH-Session 请求头（身份绑定键只能由浏览器页面带来）',
    )
  }
  if (Array.isArray(raw)) {
    throw httpProblem(400, 'INVALID_ARGS', 'SESSION_HEADER_INVALID', 'X-DSH-Session 只能出现一次', {
      count: raw.length,
    })
  }
  if (raw.trim() === '') {
    throw httpProblem(400, 'INVALID_ARGS', 'SESSION_HEADER_REQUIRED', 'X-DSH-Session 不能是空串')
  }
  if (raw.length > MAX_SESSION_ID_LENGTH) {
    throw httpProblem(
      400,
      'INVALID_ARGS',
      'SESSION_HEADER_INVALID',
      `X-DSH-Session 不得超过 ${MAX_SESSION_ID_LENGTH} 字`,
      { length: raw.length },
    )
  }
  return raw
}

/**
 * 宿主侧用到的 `webServer` 最小面（只取注册、host、port）。
 *
 * 与 `overview.ts` 里同名私有接口**结构一致**；本文件另起一个名字是为了让 W0 的接线代码
 * 可以同时 import 两个 HostContext 类型而不撞名（两者靠结构兼容，不需要同一个类型名）。
 */
export interface InterviewerWebServerFace {
  readonly host: string
  readonly port: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 宿主上下文的窄接口（`webServer` 由 cordis 服务注入；`logger` 可选）。 */
export interface InterviewerHostContext {
  readonly webServer: InterviewerWebServerFace
  readonly logger?: { warn(message: string): void }
}

/**
 * 注册面试官工作台路由；返回 disposer（插件卸载即注销）。
 *
 * 判定顺序（**能拒就拒，且全部在碰 DB 之前**）：
 *
 *   1. 非回环监听 → **不注册** + `logger.warn`（fail-closed，不是 403 之后还挂着）；
 *   2. same-origin（Host/标记头/Origin）→ 403；
 *   3. 客户端身份覆盖（query/header）→ 400 `ACTOR_OVERRIDE_REJECTED`；
 *   4. 方法 ≠ GET → 405 + `allow: 'GET'`；
 *   5. query 形状（未知参数 / 缺 alias / 非 UUID）→ 400；
 *   6. `X-DSH-Session` 形状 → 400；
 *   7. resolver 未注入或返回空 → 409 `DEMO_ACTOR_UNMAPPED/SESSION_NOT_BOUND`；
 *   8. query alias ≠ 绑定 alias → 403 `ALIAS_MISMATCH/SESSION_ALIAS_MISMATCH`；
 *   9. `database === null` → 503 `NOT_CONFIGURED`（`detail.issues` 说明缺什么，不含密码）；
 *  10. 读库（只读事务）；读失败 → 5xx（不伪装成空列表）。
 *
 * @param ctx - 宿主上下文（含 webServer 服务）。
 * @param database - 已解析的数据库配置；`null` 表示未配置（路由仍注册，返回 503）。
 * @param resolver - W1 的 session→actor 解析端口；未注入 = 一律 409。
 * @param issues - 未配置时缺失的配置项（原样进 503 的 `detail.issues`）。
 * @returns 注销函数。
 */
export function registerInterviewerHttp(
  ctx: InterviewerHostContext,
  database: ResolvedDatabaseConfig | null,
  resolver: InterviewerSessionActorResolver | undefined,
  issues: readonly string[] = [],
): () => void {
  const { webServer } = ctx
  if (!LOOPBACK_HOSTS.has(webServer.host)) {
    // 与 overview 同一条纪律：非回环就干脆不挂，避免把业务投影暴露到网络可达地址上。
    ctx.logger?.warn(`recruitment: 面试官工作台路由未注册——webServer.host=${webServer.host} 不是回环地址`)
    return () => {}
  }
  const port = webServer.port ?? 0

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!sameOrigin(req, port)) {
      json(res, 403, { error: 'same-origin loopback request required' })
      return
    }
    if (url.pathname !== OVERVIEW_PATH) {
      // 本前缀下只有这一个端点（新增端点必须回契约 §1.1 追加，不在实现里悄悄加）。
      json(res, 404, { error: 'not found' })
      return
    }
    try {
      // ---- 3 身份只能来自服务端绑定：任何客户端覆盖企图在碰 DB 之前拒掉 ----
      const overrides = findActorOverride(req, url)
      if (overrides.length > 0) {
        throw httpProblem(
          400,
          'INVALID_ARGS',
          'ACTOR_OVERRIDE_REJECTED',
          'actor/tenant 只来自服务端绑定，不接受客户端传入（D-33 / IR-M4d）',
          { rejected: overrides },
        )
      }
      // ---- 4 方法 ----
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET', ...NO_STORE })
        res.end()
        return
      }
      // ---- 5 参数 ----
      const query = parseInterviewerQuery(url)
      // ---- 6 session ----
      const sessionId = requireSessionId(req)
      // ---- 7 resolver（未注入 / 未绑定都 fail-closed 409）----
      if (resolver === undefined) {
        throw httpProblem(
          409,
          'DEMO_ACTOR_UNMAPPED',
          'SESSION_NOT_BOUND',
          '当前 Session 尚未绑定演示身份（fail-closed）：先在顶部选择身份',
        )
      }
      const binding = resolver.resolve(sessionId)
      if (binding === undefined || binding === null) {
        throw httpProblem(
          409,
          'DEMO_ACTOR_UNMAPPED',
          'SESSION_NOT_BOUND',
          '当前 Session 尚未绑定演示身份（fail-closed）：先在顶部选择身份',
          { session_id: sessionId },
        )
      }
      // ---- 8 alias 必须等于绑定 alias（不许用别人的 alias 读别人的分配）----
      if (query.alias !== binding.alias) {
        throw httpProblem(
          403,
          'ALIAS_MISMATCH',
          'SESSION_ALIAS_MISMATCH',
          'query alias 与当前 Session 绑定的身份不一致（身份只能由服务端绑定决定）',
          { requested_alias: query.alias },
        )
      }
      // ---- 9 数据库未配置 → 503（形状给 issues，仍然不假装空数据）----
      if (database === null) {
        throw httpProblem(
          503,
          'NOT_CONFIGURED',
          'NOT_CONFIGURED',
          '数据库未配置，读不到面试官工作台',
          { issues: [...issues] },
        )
      }
      // ---- 10 读库（只读事务；失败原样上抛，由 catch 映射 5xx）----
      const overview = await readOverviewFromDatabase(
        database,
        {
          alias: binding.alias,
          actor_id: binding.actor_id,
          display_name: binding.display_name ?? '',
          // session 不是身份来源，只是"这份视图属于哪个会话"的回显（§1.4 的 session 块）。
          session_id: binding.session_id,
        },
        query.interviewId === undefined ? {} : { interviewId: query.interviewId },
      )
      json(res, 200, overview)
    } catch (error) {
      if (error instanceof InterviewerHttpProblem) {
        json(res, error.status, error.body)
        return
      }
      // 读库失败必须可解释：浏览器显示错误，而不是显示"没有面试"（那是把故障说成空）。
      const { status, body } = toErrorResponse(error)
      json(res, status, body)
    }
  }

  return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}
