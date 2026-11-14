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
// 出参类型是本文件冻结的契约（§1.4，字段名逐字一致，不增删）。客户端 `src/client/interviewer/**`
// 只用 `import type` 引用它们，不会把服务端代码打进浏览器产物。
//
// 单测所需的**纯**辅助函数（不碰 DB，故单独导出；见 `test/unit/interviewer-overview.test.ts`）：
//   · `parseInterviewerQuery(url)` —— §1.1 的 query 形状（未知参数 / 缺 alias / 非 UUID）
//   · `requireSessionId(req)`      —— §1.1 的 `X-DSH-Session` 形状（缺失 / 超长 / 重复）
//   · `toInterviewRow({value, extension, actorId})` —— 一个面试元素的行映射（含自己的面评提取、
//     brief/materials/rubric 的降级路径、rubric 越界的 issue）
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
//  §1.4 响应形状（冻结；字段名逐字一致，不增删）
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

/** `interviews[]` 的一个元素（§1.4）。 */
export interface InterviewerRow {
  readonly interview_id: string
  readonly application_id: string
  readonly candidate: InterviewerCandidate
  readonly job: InterviewerJob
  readonly round_no: number
  readonly slot_code: string
  readonly status: string
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
  readonly materials: InterviewerMaterials
  readonly transcript: InterviewerTranscript
  readonly scorecard: InterviewerScorecard
  readonly required_action: InterviewerRequiredAction
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
 */
const INTERVIEW_EXTENSION_SQL = `
  select iv.id::text                       as interview_id,
         a.job_id::text                    as application_job_id,
         c.display_name                    as candidate_display_name,
         j.code                            as job_code,
         j.title                           as job_title,
         itv.id::text                      as template_version_id,
         itv.objective                     as template_objective,
         itv.briefing ->> 'summary'         as template_briefing_summary,
         itv.focus_attributes              as template_focus,
         itv.question_templates            as template_questions,
         itv.payload_hash                  as template_payload_hash,
         a.rubric_version_id::text         as pinned_rubric_version_id,
         rv.id::text                       as rubric_version_id,
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

// =====================================================================
//  §1.5 扩展行的类型（SQL 别名逐字对应；单测直接喂假行）
// =====================================================================

/** `INTERVIEW_EXTENSION_SQL` 的一行（jsonb 已由 pg 解析成 JS 值）。 */
export interface InterviewExtensionRow {
  readonly interview_id: string
  readonly application_job_id: string
  readonly candidate_display_name: string
  readonly job_code: string
  readonly job_title: string
  readonly template_version_id: string | null
  readonly template_objective: string | null
  readonly template_briefing_summary: string | null
  readonly template_focus: unknown
  readonly template_questions: unknown
  readonly template_payload_hash: string | null
  readonly pinned_rubric_version_id: string | null
  readonly rubric_version_id: string | null
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
}): InterviewerBrief {
  const { extension, rubric } = input
  const templateVersionId = text(extension.template_version_id)
  if (templateVersionId !== null) {
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

  const current = mine.scorecard
  const state = scorecardStateOf(current?.status)
  // 只有两次读取指向同一条面评时才补 record_version/overall（否则回 null，不混行）。
  const sameScorecard = current !== undefined && text(extension.scorecard_id) === current.scorecard_id

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
      stage_code: value.stage_code,
      scheduled_start_at: value.scheduled_start_at ?? null,
      scheduled_end_at: value.scheduled_end_at ?? null,
      timezone: value.timezone,
      record_version: value.record_version,
      role_in_interview: mine.role_in_interview,
      required_scorecard: mine.required_scorecard,
      scorecard_due_at: mine.scorecard_due_at ?? null,
      brief: buildBrief({ extension, rubric }),
      rubric,
      materials: buildMaterials(extension),
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
    const mapped = toInterviewRow({ value, extension, actorId: actor.actor_id })
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
