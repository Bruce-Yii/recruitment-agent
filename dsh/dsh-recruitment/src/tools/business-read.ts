// Agent 一等业务读工具（只读）：`recruitment_application_get` / `recruitment_material_read`。
//
// 为什么需要它们（2026-11-16 产品/业务 FAIL，`work/review/2026-11-16-notion-acceptance/14-PRODUCT-BUSINESS-VERDICT.md`）：
//   真实 HR 场景里 Agent 要"读申请 → 读材料 → 读岗位 rubric → 给评估"。当时没有一等的申请/材料读工具，
//   Agent 只能下沉到 shell / psql / 读源码 / 直接找文件 —— 在真实招聘环境里这是权限/租户/合规红线，
//   而且 2 轮 42 步 3.3M tokens 只是为了"看一眼业务事实"。这两个工具把这条链路收回到产品面：
//     * 一次调用拿全一条申请的**业务事实**（申请人 / 岗位 / 阶段 / 材料摘要 / 面试与评估摘要 / 决策摘要）；
//     * 一次调用拿一份**受控材料**（结构摘要 + 定位器 + 哈希；业务必需时给受控文本片段）；
//     * 只读（`begin transaction read only`，写语句直接 25006）、结构化、每个事实带来源 id。
//
// R1 复用（不新造轮子）：
//   * 租户合成声明（R4 三维标签）→ `candidate-get.ts::resolveTenantProvenance`（六个工具共用同一判定；
//     本文件只把 connection 轴换成读库工具的既有解释，见 `ReadToolLabels`）；
//   * HARD/SOFT issue 口径 → `src/db/material.ts::isHardIssue / hardIssueCodes`；
//   * 材料文件解析（allowed_roots + basename+byteSize 预筛 + sha256 确认）→
//     `src/runtime/task-context.ts::resolveMaterialPath`（P0-3 已落地的唯一实现，含预算与缓存）；
//   * 文本/多格式读取 → `src/document/readers/index.ts::readDocumentDetailed`
//     （内部再校验 allowed_roots，返回 `asset_sha256` 证据；PDF/DOCX/RTF/PNG/JPEG 同一入口）。
//   * 岗位/Rubric 的**完整**事实（JD 正文、版本列表、R-VAL 可执行性、absence 归因）仍归
//     `recruitment_job_get`；面试/转写的**逐场**事实仍归 `recruitment_interview_get` /
//     `recruitment_transcript_read`。本文件的返回里只有**摘要 + 指针 + next_tools**，不复制它们的判定规则。
//
// 诚实点（不许省）：
//   1. PII 最小化：联系方式默认脱敏（`include_contacts=true` 才给原文，且输出里 `visible` 明确）；
//      受保护属性（年龄/性别/婚育/籍贯）**根本不读** —— `resume_version.parsed_fields` 的白名单投影
//      （`src/db/material.ts::projectParsedFields`）本来就不落这些。
//   2. 不编造：查不到就 `NOT_FOUND`（带 reason_code），绝不回退样例数据；材料文件找不到时
//      `text.available=false` + 闭集 reason_code，不把"没读到"说成"文件里没有"。
//   3. 只读：整段查询在只读事务里，靠数据库强制而不是"源码里没写 INSERT"的自觉。
//   4. 两个哈希分开说：`source_asset_sha256` 是**原件字节**哈希（材料文件按它定位/校验），
//      `content_sha256` 是产品自己解析投影的摘要 —— 混用会让"材料 sha 真实"这句话失去意义。
//   5. R4 三维标签：`provenance` 由 `resolveTenantProvenance` 按这次调用的租户事实算（演示租户 ⇒ FIXTURE）；
//      `trigger=MANUAL`；`connection=CONNECTED` 按**读库工具**的既有解释（"直连业务库"，
//      `contracts/tenant-provenance.md` §1 的 job_get/interview_get/transcript_read 同一口径；
//      该轴"同一维度两种解释"是契约已记录的已知未决，本文件不代决）。
//
// 2026-11-16 新文件（task-75）。`src/index.ts` 接线由 W0 落，本文件只导出工厂。

import { parseArgs, toParameterSchema } from './args.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { buildThreeAxisLabels } from './candidate-get.ts'
import { hardIssueCodes, type MaterialIssue } from '../db/material.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import type { ResolvedConverterConfig } from './converter.ts'
import { readDocumentDetailed, isDocumentReadError } from '../document/readers/index.ts'
// O14：必交面评进度的**唯一**派生实现（与 interview_get 共用同一份；不许两处各写一套）。
import { deriveRequiredScorecardProgress } from './scorecard-progress.ts'
import {
  resolveMaterialPath,
  type MaterialPathReason,
} from '../runtime/task-context.ts'

/** 两个工具名（index.ts 与测试都按名字找）。 */
export const APPLICATION_GET_TOOL = 'recruitment_application_get'
export const MATERIAL_READ_TOOL = 'recruitment_material_read'
/** 读工具契约版本（`output.contract_version` 里的值；与 job_get/interview_get 同一形态）。 */
export const CONTRACT_VERSION = '1.0.0'

/**
 * 本文件两个读工具的三维标签。
 *
 * 与 `candidate-get.ts::ThreeAxisLabels` 的区别只在 `connection`：`candidate_get` 的契约写
 * `NOT_CONNECTED`，而 `job_get` / `interview_get` / `transcript_read` 的契约把这一轴解释为
 * "直连业务库 ⇒ `CONNECTED`"（`contracts/tenant-provenance.md` §1，该轴的两种解释是契约里
 * 已记录的已知未决 §7.4）。本文件是**读库工具**，按读工具那一半的既有口径取 `CONNECTED`；
 * `provenance` 仍复用同一份判定实现 `resolveTenantProvenance`（六个工具共用，不各写一份）。
 */
export interface ReadToolLabels {
  readonly provenance: 'LIVE' | 'FIXTURE'
  readonly trigger: 'MANUAL'
  readonly connection: 'CONNECTED'
}

/**
 * 造本文件两个工具的三维标签（`provenance` 按**这次调用**的租户事实算，不写死）。
 *
 * 复用 `candidate-get.ts::buildThreeAxisLabels` 的同一份判定实现（`tenant-provenance.md` §2.1
 * 要求单一实现）；只把 `connection` 换成读库工具那一半的既有解释 `CONNECTED`（见 `ReadToolLabels`）。
 * @param client - 只读事务内客户端。
 * @param tenantId - 租户（只来自插件配置）。
 * @returns 三维标签。
 */
export async function buildReadToolLabels(
  client: DatabaseClient,
  tenantId: string,
): Promise<ReadToolLabels> {
  const shared = await buildThreeAxisLabels(client, tenantId)
  return {
    provenance: shared.provenance,
    // 模型/人在会话里调用；本工具不被事件驱动。
    trigger: 'MANUAL',
    // 读库工具的既有解释：直连业务库（见本类型注释）。
    connection: 'CONNECTED',
  }
}

// ---------------------------------------------------------------------------
//  通用小工具（只做投影，不引入新规则）
// ---------------------------------------------------------------------------

/** `timestamptz` → ISO-8601；空值省略（输出 schema 没有 null）。 */
function iso(value: Date | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** pg 的 int8/bigint 以字符串返回；统一转 number。 */
function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

/** 未知值当对象取；不是对象返回 null（`parsed_fields` 是 jsonb，不能假设形状）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 未知值当数组取；不是数组返回空数组。 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 未知值当非空字符串取；否则 undefined（缺键而不是空串，二者含义不同）。 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 未知值当有限数字取；否则 undefined。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 邮箱脱敏：保留首字母与域名。
 *
 * 与 `candidate-get.ts:259-264` 的规则**逐字相同**（那边没有导出，本 lane 写范围不允许改它；
 * W0 收口时可抽成共享 helper —— 抽之前两边必须保持同一输出，规则改动要同步）。
 * @param email - 原始邮箱；空串原样返回。
 * @returns 脱敏后的邮箱。
 */
function maskEmail(email: string): string {
  if (email === '') return ''
  const at = email.indexOf('@')
  if (at <= 0) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/**
 * 手机号脱敏：保留前 3 位与后 4 位（规则同 `candidate-get.ts:270-276`）。
 * @param phone - 原始号码；空串原样返回。
 * @returns 脱敏后的号码。
 */
function maskPhone(phone: string): string {
  if (phone === '') return ''
  const digits = phone.replace(/[^0-9]/g, '')
  if (digits.length < 8) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/**
 * 材料正文里的联系方式再脱敏一层（TEXT 模式用）。
 *
 * 为什么还要做：材料原文里可能夹着手机号/邮箱（页眉、自述）；TEXT 模式的用途是"给评估看
 * 工作/教育内容"，不是"把候选人联系方式给模型"。这条只影响**返回给模型的片段**，
 * 不改变落库事实、也不影响哈希校验（校验在原始字节上做）。
 * @param text - 原文片段。
 * @returns 替换掉邮箱与长数字串后的片段。
 */
export function redactContactPatterns(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (match) => maskEmail(match))
    // 手机号/座机：只认"1[3-9]xxxxxxxxx"或带 + 的国际号，且**不碰日期区间**（`2019-03 - 2021-06`
    // 这类 12 位数字串在上一版会被误当成手机号，把工作经历时间改坏）。
    .replace(/(?<![\d./-])(?:1[3-9]\d{9})(?![\d./-])/g, (match) => maskPhone(match))
    .replace(/(?<![\d./-])\+\d{6,15}(?![\d./-])/g, (match) => maskPhone(match))
}

// ---------------------------------------------------------------------------
//  recruitment_application_get
// ---------------------------------------------------------------------------

/** 阶段闭集（`db/migrations/0004_stage_catalog.sql` 的 S6–S10，与 UI 一致）。 */
const STAGE_CODES: readonly string[] = ['S6', 'S7', 'S8', 'S9', 'S10']
/** resume_version 的 parse_status 域（ck_resume_version_status，6 值；输出 schema 必须覆盖整个域，否则域内值会让整次调用失败）。 */
const RESUME_PARSE_STATUSES: readonly string[] = ['PENDING', 'PARSING', 'PARSED', 'PARTIAL', 'FAILED', 'NEEDS_REVIEW']
/** 申请生命周期闭集（`ck_application_lifecycle_status`）。 */
const LIFECYCLE_STATUSES: readonly string[] = ['ACTIVE', 'ON_HOLD', 'WITHDRAWN', 'CLOSED']

/** `recruitment_application_get` 入参。 */
const APPLICATION_GET_PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Application id, UUID text form. Returns that one application. '
      + 'Mutually exclusive with job_id / stage_code / lifecycle_status.',
  },
  job_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Only for a list: keep applications of that job (UUID text form).',
  },
  stage_code: {
    kind: 'string',
    values: STAGE_CODES,
    description: 'Only for a list: keep applications currently at that stage (S6..S10).',
  },
  lifecycle_status: {
    kind: 'string',
    values: LIFECYCLE_STATUSES,
    description: 'Only for a list: keep applications in that lifecycle status.',
  },
  limit: {
    kind: 'integer',
    min: 1,
    max: 50,
    description: 'Only for a list: maximum applications to return (1..50, default 10). '
      + 'Ordered by applied_at desc. Ignored for a single-application query.',
  },
  include_contacts: {
    kind: 'boolean',
    description: 'When true, return the candidate email/phone in clear text (PII). Defaults to false, '
      + 'which masks both. Protected attributes (age/gender/marital status/native place) are never read.',
  },
}

/** 一条申请 + 家族事实的数据库行（只取回显要用的列）。 */
interface ApplicationRow {
  readonly id: string
  readonly current_stage_code: string
  readonly lifecycle_status: string
  readonly record_version: number
  readonly applied_at: Date | null
  readonly stage_entered_at: Date | null
  readonly candidate_id: string
  readonly display_name: string
  readonly identity_status: string
  readonly normalized_email: string | null
  readonly normalized_phone: string | null
  readonly job_id: string
  readonly job_code: string | null
  readonly job_title: string | null
  readonly job_status: string | null
  readonly job_version_id: string
  readonly current_job_version_id: string | null
  readonly current_rubric_version_id: string | null
  readonly pinned_rubric_version_id: string | null
  readonly resume_version_id: string | null
}

/** 材料行（resume_version + 原件 asset 的只读投影）。 */
interface MaterialRow {
  readonly id: string
  readonly resume_id: string | null
  readonly version_no: number
  readonly content_sha256: string | null
  readonly source_asset_sha256: string | null
  readonly parser_name: string | null
  readonly parser_version: string | null
  readonly parse_status: string
  readonly parse_error: string | null
  readonly parsed_fields: unknown
  readonly asset_id: string | null
  readonly file_name: string | null
  readonly mime_type: string | null
  readonly byte_size: string | null
  readonly asset_sha256: string | null
  readonly storage_ref: string | null
  readonly validation_status: string | null
}

/** Rubric 行（钉住版本 + 审批事实）。 */
interface RubricRow {
  readonly id: string
  readonly version_no: number
  readonly payload_hash: string | null
  readonly dimensions: unknown
  readonly approved: boolean
}
/** 面试行（摘要）。 */
interface InterviewRow {
  readonly id: string
  readonly application_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly scheduled_start_at: Date | null
}

/** 转写产物行（摘要）。 */
interface TranscriptRow {
  readonly application_id: string
  readonly id: string
  readonly transcript_status: string
  readonly provenance: string | null
  readonly connection_state: string | null
  readonly is_canonical: boolean
  readonly page_count: number | null
  readonly content_sha256: string | null
}

/** 面评行（摘要）。 */
interface ScorecardRow {
  readonly application_id: string
  readonly id: string
  /** 面评所属面试官（O14：与 `interviewer.required_scorecard` 同集合计数）。 */
  readonly interviewer_id: string
  readonly status: string
  readonly overall: string | null
  readonly submitted_at: Date | null
}

/** 面试官分配行（O14：必交面评的 required 只认这一张表，不认面评行数）。 */
interface InterviewerRow {
  readonly application_id: string
  readonly interviewer_id: string
  readonly required_scorecard: boolean
}

/** 决策行（摘要）。 */
interface DecisionRow {
  readonly application_id: string
  readonly id: string
  readonly decision_scope: string
  readonly stage_code: string
  readonly result: string
  readonly decided_at: Date | null
  readonly reason: string | null
  readonly superseded_by_decision_id: string | null
}

/** 输出：联系方式（永远带 visible，避免"看着像原文其实是脱敏"的误读）。 */
interface ContactsValue {
  readonly visible: boolean
  readonly email: string
  readonly phone: string
}

/** 输出：候选人摘要。 */
interface CandidateSummaryValue {
  readonly candidate_id: string
  readonly display_name: string
  readonly identity_status: string
  readonly contacts: ContactsValue
}

/** 输出：岗位摘要（JD 正文/版本列表归 `recruitment_job_get`，这里只给指针事实）。 */
interface JobSummaryValue {
  readonly job_id: string
  readonly code: string
  readonly title: string
  readonly status: string
  readonly current_job_version_id?: string
  readonly current_rubric_version_id?: string
  /** **申请钉住**的岗位版本（`application.job_version_id`，D-120）；与 job.current 指针是两件事。 */
  readonly version_id_pinned?: string
}

/** 输出：Rubric 钉住版本的**指针 + 摘要**（完整 criteria/可执行性归 job_get，见 next_tools）。 */
interface RubricSummaryValue {
  readonly rubric_version_id: string
  readonly version_no: number
  readonly source: 'APPLICATION_PIN' | 'JOB_CURRENT'
  readonly approved: boolean
  readonly criteria_count: number
  readonly payload_hash?: string
}

/**
 * 输出：评分标准（rubric）修复建议 —— **服务端按 approval 真值生成**（O12）。
 *
 * 为什么必须由服务端生成：A1 会话里 Agent 给 HR 的下一步写了「审批岗位的评分标准（v2）」，
 * 而 v2 当时早已 `APPROVED`；真正卡住的是申请钉住的 v1 未批准。Agent 只应转述这份真值，
 * 不应自己编"去审批谁"。
 */
interface RubricRemediationValue {
  /**
   * 封闭码：
   *   * `CONTINUE_WITH_PINNED`      —— 钉住版本已批准：按钉住版本继续；
   *   * `PINNED_VERSION_NOT_APPROVED` —— 钉住版本未批准（岗位当前版本可能已批准）：不得建议
   *        去审批已批准的版本；要按钉住版本继续，先批准钉住版本；
   *   * `APPROVE_PINNED_VERSION`   —— 钉住版本未批准且岗位没有已批准版本：先批准钉住版本；
   *   * `NO_RUBRIC_PINNED`         —— 申请没钉住、岗位当前版本已批准：推进阶段时补钉即可；
   *   * `NO_APPROVED_RUBRIC`       —— 申请没钉住且岗位没有已批准版本：先批准岗位的版本。
   */
  readonly code:
    | 'CONTINUE_WITH_PINNED'
    | 'PINNED_VERSION_NOT_APPROVED'
    | 'APPROVE_PINNED_VERSION'
    | 'NO_RUBRIC_PINNED'
    | 'NO_APPROVED_RUBRIC'
  /** 一句人话（Agent 直接转述；**不出现**"去审批已批准的版本"）。 */
  readonly message: string
  /** 申请钉住的版本（缺键 = 没钉住）。 */
  readonly pinned_rubric_version_id?: string
  readonly pinned_version_no?: number
  readonly pinned_approved?: boolean
  /** 岗位当前版本（`job.current_rubric_version_id`）。 */
  readonly job_current_rubric_version_id?: string
  readonly job_current_version_no?: number
  readonly job_current_approved?: boolean
  /** 是否存在"把申请重绑到已批准版本"的产品入口（当前服务端没有；如实报 false）。 */
  readonly rebind_action_available: boolean
}

/** 输出：材料摘要（明细文本归 `recruitment_material_read`）。 */
interface MaterialSummaryValue {
  readonly resume_version_id: string
  readonly parse_status: string
  readonly pages: number
  readonly issue_count: number
  readonly hard_issue_codes: string[]
  readonly source_asset_sha256?: string
  readonly content_sha256?: string
  readonly parser_name?: string
  /** 库登记原件 sha 与解析证据里的 source_sha256 是否一致（false = "读的字节 ≠ 登记原件"，重要异常）。 */
  readonly source_hash_aligned?: boolean
  readonly asset?: {
    readonly intake_asset_id: string
    readonly file_name: string
    readonly mime_type: string
    readonly byte_size: number
    readonly sha256: string
    readonly validation_status: string
  }
}

/** 输出：一场面试的摘要行。 */
interface InterviewItemValue {
  readonly interview_id: string
  readonly round_no: number
  readonly slot_code: string
  readonly stage_code: string
  readonly status: string
  readonly scheduled_start_at?: string
}

/** 输出：面试摘要。 */
interface InterviewsSummaryValue {
  readonly count: number
  readonly items: readonly InterviewItemValue[]
}

/** 输出：转写摘要（`selected` 是本次选出来的一条，但**是否 canonical 由 is_canonical 说**）。 */
interface TranscriptsSummaryValue {
  readonly count: number
  readonly ready_count: number
  readonly selected?: {
    readonly artifact_id: string
    readonly transcript_status: string
    readonly provenance: string
    readonly connection_state: string
    readonly page_count: number
    readonly is_canonical: boolean
  }
}

/**
 * 输出：评估（面评）摘要。
 *
 * O14：`scorecard_count` / `submitted_count` 是**旧键，保留**；数值改为与
 * `recruitment_interview_get` 同一口径（跨轮 required 汇总 / submitted 汇总）。
 * 新增 `scorecards_*_total` 让"这是跨轮合计、不是面评行数"这件事显式可读。
 */
interface EvaluationsSummaryValue {
  /** 旧键（保留，数值已改正）：必交面评的面试官总数（= `scorecards_required_total`）。 */
  readonly scorecard_count: number
  /** 旧键（保留，数值已改正）：其中已提交的份数（= `scorecards_submitted_total`）。 */
  readonly submitted_count: number
  /** 跨轮必交面评总数（`interviewer.required_scorecard=true` 的面试官数）。 */
  readonly scorecards_required_total: number
  /** 跨轮已提交份数（上述面试官当前面评 status=SUBMITTED）。 */
  readonly scorecards_submitted_total: number
  /** 跨轮已豁免份数（status=WAIVED）。 */
  readonly scorecards_waived_total: number
  /** 跨轮还差几份（required - submitted - waived）。 */
  readonly scorecards_pending_total: number
  readonly latest_overall?: string
}

/** 输出：最新决策摘要。 */
interface DecisionItemValue {
  readonly decision_id: string
  readonly scope: string
  readonly stage_code: string
  readonly result: string
  readonly is_current: boolean
  readonly decided_at?: string
  readonly reason?: string
}

/** 输出：决策摘要。 */
interface DecisionsSummaryValue {
  readonly count: number
  readonly latest?: DecisionItemValue
}

/** 输出：一条申请的完整摘要。 */
interface ApplicationValue {
  readonly application_id: string
  readonly stage_code: string
  readonly lifecycle_status: string
  readonly record_version: number
  readonly applied_at?: string
  readonly stage_entered_at?: string
  readonly candidate: CandidateSummaryValue
  readonly job: JobSummaryValue
  readonly rubric?: RubricSummaryValue
  readonly material?: MaterialSummaryValue
  readonly interviews: InterviewsSummaryValue
  readonly transcripts: TranscriptsSummaryValue
  readonly evaluations: EvaluationsSummaryValue
  /** O12：服务端按 approval 真值生成的 rubric 修复建议（Agent 转述，不自行编造）。 */
  readonly rubric_remediation: RubricRemediationValue
  readonly decisions: DecisionsSummaryValue
}

/** 输出：一次查询的入参回显。 */
interface ApplicationQueryValue {
  readonly mode: 'ONE' | 'LIST'
  readonly matched: number
  readonly limit: number
  readonly application_id?: string
  readonly job_id?: string
  readonly stage_code?: string
  readonly lifecycle_status?: string
}

/** `next_tools[]`：告诉 Agent 下一个该用哪个**产品**工具（而不是 shell/psql）。 */
interface NextToolValue {
  readonly name: string
  readonly reason: string
  readonly args_json: string
}

/** `recruitment_application_get` 的规范输出。 */
interface ApplicationGetValue {
  readonly tool: string
  readonly contract_version: string
  readonly tool_kind: 'READ_ONLY'
  readonly labels: ReadToolLabels
  readonly query: ApplicationQueryValue
  readonly applications: readonly ApplicationValue[]
  readonly next_tools: readonly NextToolValue[]
}

const CONTACTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    visible: { type: 'boolean', description: 'true ⇒ email/phone are the stored values; false ⇒ masked.' },
    email: { type: 'string' },
    phone: { type: 'string' },
  },
  required: ['visible', 'email', 'phone'],
  additionalProperties: false,
}

const LABELS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
    trigger: { type: 'string', enum: ['MANUAL'] },
    connection: { type: 'string', enum: ['CONNECTED'] },
  },
  required: ['provenance', 'trigger', 'connection'],
  additionalProperties: false,
}

const APPLICATION_VALUE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    application_id: { type: 'string' },
    // 输出用 type:string 而不是闭集：DB 的 ck_application_stage_code 是正则（目录 S1..S12），把输出写成 S6-S10 闭集会让 S11/历史阶段整次调用 INVALID_TOOL_OUTPUT。入参过滤仍只接 S6-S10（v1.0 UI 的阶段）。
    stage_code: { type: 'string' },
    lifecycle_status: { type: 'string', enum: LIFECYCLE_STATUSES },
    record_version: { type: 'number' },
    applied_at: { type: 'string' },
    stage_entered_at: { type: 'string' },
    candidate: {
      type: 'object',
      properties: {
        candidate_id: { type: 'string' },
        display_name: { type: 'string' },
        identity_status: { type: 'string', enum: ['ACTIVE', 'MERGED'] },
        contacts: CONTACTS_SCHEMA,
      },
      required: ['candidate_id', 'display_name', 'identity_status', 'contacts'],
      additionalProperties: false,
    },
    job: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        code: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        current_job_version_id: { type: 'string' },
        current_rubric_version_id: { type: 'string' },
        version_id_pinned: { type: 'string' },
      },
      required: ['job_id', 'code', 'title', 'status'],
      additionalProperties: false,
    },
    rubric: {
      type: 'object',
      properties: {
        rubric_version_id: { type: 'string' },
        version_no: { type: 'number' },
        source: { type: 'string', enum: ['APPLICATION_PIN', 'JOB_CURRENT'] },
        approved: { type: 'boolean' },
        criteria_count: { type: 'number' },
        payload_hash: { type: 'string' },
      },
      required: ['rubric_version_id', 'version_no', 'source', 'approved', 'criteria_count'],
      additionalProperties: false,
    },
    material: {
      type: 'object',
      properties: {
        resume_version_id: { type: 'string' },
        parse_status: { type: 'string', enum: RESUME_PARSE_STATUSES },
        pages: { type: 'number' },
        issue_count: { type: 'number' },
        hard_issue_codes: { type: 'array', items: { type: 'string' } },
        source_asset_sha256: { type: 'string' },
        content_sha256: { type: 'string' },
        parser_name: { type: 'string' },
        source_hash_aligned: { type: 'boolean' },
        asset: {
          type: 'object',
          properties: {
            intake_asset_id: { type: 'string' },
            file_name: { type: 'string' },
            mime_type: { type: 'string' },
            byte_size: { type: 'number' },
            sha256: { type: 'string' },
            validation_status: { type: 'string' },
          },
          required: ['intake_asset_id', 'file_name', 'mime_type', 'byte_size', 'sha256', 'validation_status'],
          additionalProperties: false,
        },
      },
      required: ['resume_version_id', 'parse_status', 'pages', 'issue_count', 'hard_issue_codes'],
      additionalProperties: false,
    },
    interviews: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              interview_id: { type: 'string' },
              round_no: { type: 'number' },
              slot_code: { type: 'string' },
              stage_code: { type: 'string' },
              status: { type: 'string' },
              scheduled_start_at: { type: 'string' },
            },
            required: ['interview_id', 'round_no', 'slot_code', 'stage_code', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['count', 'items'],
      additionalProperties: false,
    },
    transcripts: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        ready_count: { type: 'number' },
        selected: {
          type: 'object',
          properties: {
            artifact_id: { type: 'string' },
            transcript_status: { type: 'string' },
            provenance: { type: 'string' },
            connection_state: { type: 'string' },
            page_count: { type: 'number' },
            is_canonical: { type: 'boolean' },
          },
          required: ['artifact_id', 'transcript_status', 'provenance', 'connection_state', 'page_count', 'is_canonical'],
          additionalProperties: false,
        },
      },
      required: ['count', 'ready_count'],
      additionalProperties: false,
    },
    evaluations: {
      type: 'object',
      properties: {
        // 旧键（保留；O14 起数值 = 跨轮 required / submitted 汇总，不再是"面评行数"）。
        scorecard_count: { type: 'number' },
        submitted_count: { type: 'number' },
        // O14 新增：让"跨轮合计"显式可读（与 interview_get 的 required_scorecards 同口径）。
        scorecards_required_total: { type: 'number' },
        scorecards_submitted_total: { type: 'number' },
        scorecards_waived_total: { type: 'number' },
        scorecards_pending_total: { type: 'number' },
        latest_overall: { type: 'string' },
      },
      required: [
        'scorecard_count', 'submitted_count',
        'scorecards_required_total', 'scorecards_submitted_total',
        'scorecards_waived_total', 'scorecards_pending_total',
      ],
      additionalProperties: false,
    },
    // O12：服务端按 approval 真值生成的 rubric 修复建议（封闭 code + 人话）。
    rubric_remediation: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          enum: [
            'CONTINUE_WITH_PINNED', 'PINNED_VERSION_NOT_APPROVED', 'APPROVE_PINNED_VERSION',
            'NO_RUBRIC_PINNED', 'NO_APPROVED_RUBRIC',
          ],
        },
        message: { type: 'string' },
        pinned_rubric_version_id: { type: 'string' },
        pinned_version_no: { type: 'number' },
        pinned_approved: { type: 'boolean' },
        job_current_rubric_version_id: { type: 'string' },
        job_current_version_no: { type: 'number' },
        job_current_approved: { type: 'boolean' },
        rebind_action_available: { type: 'boolean' },
      },
      required: ['code', 'message', 'rebind_action_available'],
      additionalProperties: false,
    },
    decisions: {
      type: 'object',
      properties: {
        count: { type: 'number' },
        latest: {
          type: 'object',
          properties: {
            decision_id: { type: 'string' },
            scope: { type: 'string' },
            stage_code: { type: 'string' },
            result: { type: 'string' },
            is_current: { type: 'boolean' },
            decided_at: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['decision_id', 'scope', 'stage_code', 'result', 'is_current'],
          additionalProperties: false,
        },
      },
      required: ['count'],
      additionalProperties: false,
    },
  },
  required: [
    'application_id', 'stage_code', 'lifecycle_status', 'record_version',
    'candidate', 'job', 'interviews', 'transcripts', 'evaluations', 'rubric_remediation', 'decisions',
  ],
  additionalProperties: false,
}

const APPLICATION_GET_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    tool_kind: { type: 'string', enum: ['READ_ONLY'] },
    labels: LABELS_SCHEMA,
    query: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ONE', 'LIST'] },
        matched: { type: 'number' },
        limit: { type: 'number' },
        application_id: { type: 'string' },
        job_id: { type: 'string' },
        stage_code: { type: 'string' },
        lifecycle_status: { type: 'string' },
      },
      required: ['mode', 'matched', 'limit'],
      additionalProperties: false,
    },
    applications: { type: 'array', items: APPLICATION_VALUE_SCHEMA },
    next_tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
          args_json: { type: 'string' },
        },
        required: ['name', 'reason', 'args_json'],
        additionalProperties: false,
      },
    },
  },
  required: ['tool', 'contract_version', 'tool_kind', 'labels', 'query', 'applications', 'next_tools'],
  additionalProperties: false,
}

/** `parsed_fields` 里的 issue 数组（`projectParsedFields` 已白名单成 `{code,message}`）。 */
function materialIssues(parsed: Record<string, unknown> | null): MaterialIssue[] {
  return asArray(parsed?.issues).map((item) => {
    const record = asRecord(item)
    return {
      code: asString(record?.code) ?? '',
      message: asString(record?.message) ?? '',
    }
  })
}

/** `parsed_fields.meta.pages`（缺失时 0，并在 issue 里如实反映）。 */
function materialPages(parsed: Record<string, unknown> | null): number {
  return asNumber(asRecord(parsed?.meta)?.pages) ?? 0
}

/**
 * 一次申请查询：单条（application_id）或列表（job_id/stage/lifecycle 至少一个）。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析的库配置（tenant_id 只从这里来）。
 * @param args - 已校验的入参。
 * @returns 行（按 applied_at desc）。
 */
async function queryApplicationRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<ApplicationRow[]> {
  const single = args.application_id as string | undefined
  const base = `select a.id, a.current_stage_code, a.lifecycle_status, a.record_version,
            a.applied_at, a.stage_entered_at,
            a.candidate_id, c.display_name, c.identity_status,
            c.normalized_email, c.normalized_phone,
            a.job_id, j.code as job_code, j.title as job_title, j.status as job_status,
            a.job_version_id, j.current_job_version_id, j.current_rubric_version_id,
            a.rubric_version_id as pinned_rubric_version_id, a.resume_version_id
       from recruitment.application a
       join recruitment.candidate c
         on c.id = a.candidate_id and c.tenant_id = a.tenant_id
       left join recruitment.job j
         on j.id = a.job_id and j.tenant_id = a.tenant_id
      where a.tenant_id = $1`
  if (single !== undefined) {
    const { rows } = await client.query<ApplicationRow>(`${base} and a.id = $2 limit 1`, [cfg.tenant_id, single])
    return rows
  }

  const conditions: string[] = []
  const params: unknown[] = [cfg.tenant_id]
  for (const [key, column] of [
    ['job_id', 'a.job_id'],
    ['stage_code', 'a.current_stage_code'],
    ['lifecycle_status', 'a.lifecycle_status'],
  ] as const) {
    const value = args[key] as string | undefined
    if (value === undefined) continue
    params.push(value)
    conditions.push(`${column} = $${params.length}`)
  }
  const limit = typeof args.limit === 'number' ? args.limit : 10
  params.push(limit)
  const where = conditions.length === 0 ? '' : ` and ${conditions.join(' and ')}`
  const { rows } = await client.query<ApplicationRow>(
    `${base}${where} order by a.applied_at desc, a.id limit $${params.length}`,
    params,
  )
  return rows
}

/** 材料行按 resume_version id 批量取（`= any($2::uuid[])`）。 */
async function queryMaterialRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  resumeVersionIds: readonly string[],
): Promise<MaterialRow[]> {
  if (resumeVersionIds.length === 0) return []
  const { rows } = await client.query<MaterialRow>(
    `select rv.id, rv.resume_id, rv.version_no, rv.content_sha256, rv.source_asset_sha256,
            rv.parser_name, rv.parser_version, rv.parse_status, rv.parse_error, rv.parsed_fields,
            ia.id as asset_id, ia.file_name, ia.mime_type, ia.byte_size,
            ia.sha256 as asset_sha256, ia.storage_ref, ia.validation_status
       from recruitment.resume_version rv
       left join recruitment.resume r
         on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       left join recruitment.intake_asset ia
         on ia.id = r.intake_asset_id and ia.tenant_id = rv.tenant_id
      where rv.tenant_id = $1 and rv.id = any($2::uuid[])`,
    [cfg.tenant_id, [...resumeVersionIds]],
  )
  return rows
}

/** Rubric 行（钉住版本 + 是否存在已批准审批）。 */
async function queryRubricRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rubricIds: readonly string[],
): Promise<RubricRow[]> {
  if (rubricIds.length === 0) return []
  const { rows } = await client.query<RubricRow>(
    // `approved` 的口径与 `job-get.ts::approvedAt()` **逐条一致**（`job-rubric-rules.md §4.2`：
    // 审批必须落在这一版上、未被取代、未过期、且版本已创建）。少一条就会把"已被取代/哈希不符/
    // 已过期"的审批说成"已批准" —— 那是下游会当真拿去用的错误。
    `select rv.id, rv.version_no, rv.payload_hash, rv.dimensions,
            (rv.created_at <= now()) and exists (
              select 1 from recruitment.approval ap
               where ap.tenant_id = rv.tenant_id
                 and ap.resource_type = 'RUBRIC_VERSION'
                 and ap.resource_id = rv.id
                 and ap.status = 'APPROVED'
                 and ap.canonical_payload_hash = rv.payload_hash
                 and ap.superseded_by_approval_id is null
                 and (ap.expires_at is null or ap.expires_at > now())
            ) as approved
       from recruitment.rubric_version rv
      where rv.tenant_id = $1 and rv.id = any($2::uuid[])`,
    [cfg.tenant_id, [...rubricIds]],
  )
  return rows
}

/** 面试行（摘要，按 (round_no, slot_code) 排序）。 */
async function queryInterviewRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<InterviewRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<InterviewRow>(
    `select i.id, i.application_id, i.round_no, i.slot_code, i.stage_code, i.status, i.scheduled_start_at
       from recruitment.interview i
      where i.tenant_id = $1 and i.application_id = any($2::uuid[])
      order by i.application_id, i.round_no, i.slot_code`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/** 转写产物行（摘要，经"面试 → 有效会议绑定 → 产物"取）。 */
async function queryTranscriptRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<TranscriptRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<TranscriptRow>(
    `select i.application_id, ta.id, ta.transcript_status, ta.provenance, ta.connection_state,
            ta.is_canonical, ta.page_count, ta.content_sha256
       from recruitment.transcript_artifact ta
       join recruitment.meeting_binding mb
         on mb.tenant_id = ta.tenant_id and mb.meeting_id = ta.meeting_id and mb.unbound_at is null
       join recruitment.interview i
         on i.id = mb.interview_id and i.tenant_id = mb.tenant_id
      where ta.tenant_id = $1 and i.application_id = any($2::uuid[])
      order by i.application_id, ta.fetched_at desc nulls last, ta.id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/** 面评分行（当前有效份：`superseded_by_scorecard_id is null`）。 */
async function queryScorecardRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<ScorecardRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<ScorecardRow>(
    `select i.application_id, s.id, s.interviewer_id, s.status, s.overall, s.submitted_at
       from recruitment.scorecard s
       join recruitment.interview i
         on i.id = s.interview_id and i.tenant_id = s.tenant_id
      where s.tenant_id = $1 and i.application_id = any($2::uuid[])
        and s.superseded_by_scorecard_id is null
      order by i.application_id, s.submitted_at desc nulls last, s.id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/**
 * 面试官分配行（跨轮一起取；O14）。
 *
 * 为什么要这张表：`evaluations` 的分母是"必交面评的面试官数"，它由
 * `interviewer.required_scorecard` 说话 —— 不是"已存在的 scorecard 行数"。
 * 分母/分子都与 `interview_get` 共用 `deriveRequiredScorecardProgress()`。
 */
async function queryInterviewerRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<InterviewerRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<InterviewerRow>(
    `select i.application_id, iv.id as interviewer_id, iv.required_scorecard
       from recruitment.interviewer iv
       join recruitment.interview i
         on i.id = iv.interview_id and i.tenant_id = iv.tenant_id
      where iv.tenant_id = $1 and i.application_id = any($2::uuid[])
      order by i.application_id, i.round_no, iv.id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/** 决策行（摘要，最新在前）。 */
async function queryDecisionRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<DecisionRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<DecisionRow>(
    `select d.application_id, d.id, d.decision_scope, d.stage_code, d.result, d.decided_at, d.reason,
            d.superseded_by_decision_id
       from recruitment.decision d
      where d.tenant_id = $1 and d.application_id = any($2::uuid[])
      order by d.application_id, d.decided_at desc nulls last, d.id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/**
 * 在**已有只读事务**里跑完整申请查询（`execute()` 与集成测试走同一条路径）。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析的库配置。
 * @param args - 已校验的入参。
 * @returns 规范输出值。
 */
export async function readApplicationValue(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<ApplicationGetValue> {
  const single = args.application_id as string | undefined
  const rows = await queryApplicationRows(client, cfg, args)
  if (single !== undefined && rows.length === 0) {
    throw new RecruitmentToolError(
      'NOT_FOUND',
      JSON.stringify({ reason_code: 'APPLICATION_NOT_FOUND', application_id: single }),
    )
  }

  const applicationIds = rows.map((row) => row.id)
  const resumeVersionIds = rows
    .map((row) => row.resume_version_id)
    .filter((value): value is string => value !== null)
  // 钉住版本 + 岗位当前版本都取：O12 的 remediation 要同时看两个版本的批准真值。
  const rubricIds = [...new Set(rows.flatMap((row) => [row.pinned_rubric_version_id, row.current_rubric_version_id])
    .filter((value): value is string => value !== null))]

  const [materials, rubrics, interviews, transcripts, scorecards, interviewers, decisions] = await Promise.all([
    queryMaterialRows(client, cfg, resumeVersionIds),
    queryRubricRows(client, cfg, rubricIds),
    queryInterviewRows(client, cfg, applicationIds),
    queryTranscriptRows(client, cfg, applicationIds),
    queryScorecardRows(client, cfg, applicationIds),
    queryInterviewerRows(client, cfg, applicationIds),
    queryDecisionRows(client, cfg, applicationIds),
  ])
  const materialById = new Map(materials.map((row) => [row.id, row]))
  const rubricById = new Map(rubrics.map((row) => [row.id, row]))
  const interviewsByApplication = groupBy(interviews, (row) => row.application_id)
  const transcriptsByApplication = groupBy(transcripts, (row) => row.application_id)
  const scorecardsByApplication = groupBy(scorecards, (row) => row.application_id)
  const interviewersByApplication = groupBy(interviewers, (row) => row.application_id)
  const decisionsByApplication = groupBy(decisions, (row) => row.application_id)

  const visible = args.include_contacts === true
  const labels = await buildReadToolLabels(client, cfg.tenant_id)

  const applications = rows.map((row) => toApplicationValue(
    row,
    materialById,
    rubricById,
    interviewsByApplication.get(row.id) ?? [],
    transcriptsByApplication.get(row.id) ?? [],
    scorecardsByApplication.get(row.id) ?? [],
    interviewersByApplication.get(row.id) ?? [],
    decisionsByApplication.get(row.id) ?? [],
    visible,
  ))

  return {
    tool: APPLICATION_GET_TOOL,
    contract_version: CONTRACT_VERSION,
    tool_kind: 'READ_ONLY',
    labels,
    query: buildApplicationQueryValue(args, applications.length),
    applications,
    next_tools: buildNextTools(rows, applications),
  }
}

/** 把一组行按 key 分组（保序）。 */
function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const bucket = map.get(key)
    if (bucket === undefined) map.set(key, [row])
    else bucket.push(row)
  }
  return map
}

/** 一次申请 → 输出形状（所有可缺键一律省略，不用 null）。 */
function toApplicationValue(
  row: ApplicationRow,
  materialById: ReadonlyMap<string, MaterialRow>,
  rubricById: ReadonlyMap<string, RubricRow>,
  interviews: readonly InterviewRow[],
  transcripts: readonly TranscriptRow[],
  scorecards: readonly ScorecardRow[],
  interviewers: readonly InterviewerRow[],
  decisions: readonly DecisionRow[],
  contactsVisible: boolean,
): ApplicationValue {
  const email = row.normalized_email ?? ''
  const phone = row.normalized_phone ?? ''
  const value: ApplicationValue = {
    application_id: row.id,
    stage_code: row.current_stage_code,
    lifecycle_status: row.lifecycle_status,
    record_version: row.record_version,
    ...optional('applied_at', iso(row.applied_at)),
    ...optional('stage_entered_at', iso(row.stage_entered_at)),
    candidate: {
      candidate_id: row.candidate_id,
      display_name: row.display_name,
      identity_status: row.identity_status,
      contacts: {
        visible: contactsVisible,
        email: contactsVisible ? email : maskEmail(email),
        phone: contactsVisible ? phone : maskPhone(phone),
      },
    },
    job: {
      job_id: row.job_id,
      code: row.job_code ?? '',
      title: row.job_title ?? '',
      status: row.job_status ?? '',
      ...optional('current_job_version_id', row.current_job_version_id ?? undefined),
      ...optional('current_rubric_version_id', row.current_rubric_version_id ?? undefined),
      ...optional('version_id_pinned', row.job_version_id),
    },
    interviews: {
      count: interviews.length,
      items: interviews.map((interview) => ({
        interview_id: interview.id,
        round_no: interview.round_no,
        slot_code: interview.slot_code,
        stage_code: interview.stage_code,
        status: interview.status,
        ...optional('scheduled_start_at', iso(interview.scheduled_start_at)),
      })),
    },
    transcripts: toTranscriptsSummary(transcripts),
    evaluations: toEvaluationsSummary(scorecards, interviewers),
    rubric_remediation: deriveRubricRemediation({
      pinned: row.pinned_rubric_version_id === null ? undefined : rubricById.get(row.pinned_rubric_version_id),
      current: row.current_rubric_version_id === null ? undefined : rubricById.get(row.current_rubric_version_id),
    }),
    decisions: toDecisionsSummary(decisions),
  }

  const rubricId = row.pinned_rubric_version_id ?? row.current_rubric_version_id
  const rubric = rubricId === null ? undefined : rubricById.get(rubricId)
  const material = row.resume_version_id === null ? undefined : materialById.get(row.resume_version_id)
  return {
    ...value,
    ...(rubric === undefined
      ? {}
      : {
        rubric: {
          rubric_version_id: rubric.id,
          version_no: rubric.version_no,
          source: row.pinned_rubric_version_id !== null ? 'APPLICATION_PIN' : 'JOB_CURRENT',
          approved: rubric.approved,
          criteria_count: asArray(rubric.dimensions).length,
          ...optional('payload_hash', rubric.payload_hash ?? undefined),
        } as const,
      }),
    ...(material === undefined ? {} : { material: toMaterialSummary(material) }),
  }
}

/**
 * 派生 rubric 修复建议所需的最小真值（完整 `RubricRow` 结构上满足它）。
 * 单独抽出来是为了让单测能直接构造事实、不必造一整行 rubric。
 */
export interface RubricRemediationFacts {
  readonly id: string
  readonly version_no: number
  readonly approved: boolean
}

/**
 * 按 approval 真值生成 rubric 修复建议（O12；纯函数，可单测）。
 *
 * 三条硬规则（对应 A1 会话里 Agent 编错的那一条）：
 *   1. **已批准的版本不得出现在"去审批"建议里**（v2 已批准就不再提它要审批）；
 *   2. 已钉住 v1（未批准）而岗位当前 v2 已批准时：如实说"没有重绑入口"，建议按钉住版本继续，
 *      且按钉住版本继续前需要先批准 **v1**；
 *   3. 没有任何已批准版本时才建议"先批准"，并且指向**钉住版本**（钉住优先）而不是岗位当前版本。
 * @param input.pinned - 申请钉住的 rubric 事实（`undefined` = 未钉住/行缺失）。
 * @param input.current - 岗位当前 rubric 事实（`job.current_rubric_version_id`）。
 * @returns 建议（封闭 code + 人话 + 真值字段）。
 */
export function deriveRubricRemediation(input: {
  readonly pinned: RubricRemediationFacts | undefined
  readonly current: RubricRemediationFacts | undefined
}): RubricRemediationValue {
  const { pinned, current } = input
  const rebind_action_available = false
  const facts = {
    rebind_action_available,
    ...(pinned === undefined
      ? {}
      : {
        pinned_rubric_version_id: pinned.id,
        pinned_version_no: pinned.version_no,
        pinned_approved: pinned.approved,
      }),
    ...(current === undefined
      ? {}
      : {
        job_current_rubric_version_id: current.id,
        job_current_version_no: current.version_no,
        job_current_approved: current.approved,
      }),
  } as const
  if (pinned !== undefined && pinned.approved) {
    return {
      ...facts,
      code: 'CONTINUE_WITH_PINNED',
      message: `申请钉住的评分标准 v${pinned.version_no} 已批准：按钉住版本继续，不需要再处理其它版本。`,
    }
  }
  if (pinned !== undefined) {
    if (current !== undefined && current.approved && current.id !== pinned.id) {
      return {
        ...facts,
        code: 'PINNED_VERSION_NOT_APPROVED',
        message:
          `申请钉住版本 v${pinned.version_no} 未批准；岗位当前版本 v${current.version_no} 已有生效批准。`
          + '当前没有"把申请重绑到已批准版本"的产品入口：按钉住版本继续，需要先由人批准 '
          + `v${pinned.version_no}（不要再处理已批准的 v${current.version_no}）。`,
      }
    }
    return {
      ...facts,
      code: 'APPROVE_PINNED_VERSION',
      message:
        `申请钉住版本 v${pinned.version_no} 未批准，岗位也没有已批准的版本：`
        + `先由人批准 v${pinned.version_no}，再按钉住版本继续。`,
    }
  }
  if (current !== undefined && current.approved) {
    return {
      ...facts,
      code: 'NO_RUBRIC_PINNED',
      message:
        `申请还没有钉住评分标准；岗位当前版本 v${current.version_no} 已批准。`
        + '推进阶段时会按当前版本补钉，不需要另行审批。',
    }
  }
  return {
    ...facts,
    code: 'NO_APPROVED_RUBRIC',
    message: current === undefined
      ? '申请还没有钉住评分标准，岗位也没有当前评分标准：先由人批准岗位的一个评分标准版本，再推进。'
      : `申请还没有钉住评分标准，岗位当前版本 v${current.version_no} 也未批准：先由人批准岗位的评分标准，再推进。`,
  }
}

/** 材料行 → 摘要（明细归 `recruitment_material_read`）。 */
function toMaterialSummary(row: MaterialRow): MaterialSummaryValue {
  const parsed = asRecord(row.parsed_fields)
  const hard = hardIssueCodes(materialIssues(parsed))
  return {
    resume_version_id: row.id,
    parse_status: row.parse_status,
    pages: materialPages(parsed),
    issue_count: materialIssues(parsed).length,
    hard_issue_codes: hard,
    ...optional('source_asset_sha256', row.source_asset_sha256 ?? undefined),
    ...optional('content_sha256', row.content_sha256 ?? undefined),
    ...optional('parser_name', row.parser_name ?? undefined),
    ...(asString(asRecord(asRecord(row.parsed_fields)?.meta)?.source_sha256) === undefined
      || row.asset_sha256 === null
      || row.source_asset_sha256 === null
      ? {}
      : {
        // 三个来源两两对齐：登记原件 sha（intake_asset.sha256）、产物钉住的原件 sha（resume_version.source_asset_sha256）、
        // 解析证据里的 source_sha256。任何一对不一致都值得报出来（不掩盖成"正常"）。
        source_hash_aligned:
          row.asset_sha256 === row.source_asset_sha256
          && asString(asRecord(asRecord(row.parsed_fields)?.meta)?.source_sha256) === row.asset_sha256,
      }),
    ...(row.asset_id === null
      ? {}
      : {
        asset: {
          intake_asset_id: row.asset_id,
          file_name: row.file_name ?? '',
          mime_type: row.mime_type ?? '',
          byte_size: toCount(row.byte_size),
          sha256: row.asset_sha256 ?? '',
          validation_status: row.validation_status ?? '',
        } as const,
      }),
  }
}

/** 转写摘要：计数 + 选中一条（**不把非 canonical 说成 canonical**；逐场明细归 interview_get / transcript_read）。 */
function toTranscriptsSummary(rows: readonly TranscriptRow[]): TranscriptsSummaryValue {
  const ready = rows.filter((row) => row.transcript_status === 'READY').length
  // 优先 canonical；没有 canonical 时退回最近一条，但 `is_canonical:false` 如实说它不是权威版本。
  const selected = rows.find((row) => row.is_canonical) ?? rows[0]
  return {
    count: rows.length,
    ready_count: ready,
    ...(selected === undefined
      ? {}
      : {
        selected: {
          artifact_id: selected.id,
          transcript_status: selected.transcript_status,
          provenance: selected.provenance ?? '',
          connection_state: selected.connection_state ?? '',
          page_count: selected.page_count ?? 0,
          is_canonical: selected.is_canonical,
        } as const,
      }),
  }
}

/**
 * 面评摘要（O14）：跨轮 required / submitted 汇总 + 最近一份 overall。
 *
 * 分母/分子都由 `deriveRequiredScorecardProgress()` 说话（与 `recruitment_interview_get`
 * 的 `evaluation.required_scorecards / submitted` 是同一份实现、同一集合）：
 *   * `scorecard_count` / `submitted_count` 是**旧键，保留但数值已改正**（曾是 `0/0`）；
 *   * `scorecards_*_total` 是显式的跨轮合计键，读的人不用再猜"这是面评行数还是必交份数"。
 * @param rows - 当前面评行（已过滤 superseded；只用来算 latest_overall）。
 * @param interviewers - 面试官分配行（跨轮；required 的唯一来源）。
 */
function toEvaluationsSummary(
  rows: readonly ScorecardRow[],
  interviewers: readonly InterviewerRow[],
): EvaluationsSummaryValue {
  const progress = deriveRequiredScorecardProgress(
    interviewers.map((row) => ({
      interviewer_id: row.interviewer_id,
      required_scorecard: row.required_scorecard,
    })),
    rows.map((row) => ({ interviewer_id: row.interviewer_id, status: row.status })),
  )
  const submitted = rows.filter((row) => row.status === 'SUBMITTED')
  const withOverall = submitted.find((row) => row.overall !== null)
  return {
    scorecard_count: progress.required,
    submitted_count: progress.submitted,
    scorecards_required_total: progress.required,
    scorecards_submitted_total: progress.submitted,
    scorecards_waived_total: progress.waived,
    scorecards_pending_total: progress.pending,
    ...(withOverall === undefined ? {} : { latest_overall: withOverall.overall as string }),
  }
}

/** 决策摘要：条数 + 最新一条（历史完整列表归决策投影/台账）。 */
function toDecisionsSummary(rows: readonly DecisionRow[]): DecisionsSummaryValue {
  const latest = rows[0]
  return {
    count: rows.length,
    ...(latest === undefined
      ? {}
      : {
        latest: {
          decision_id: latest.id,
          scope: latest.decision_scope,
          stage_code: latest.stage_code,
          result: latest.result,
          // 最新一条不等于"当前有效"：被更新的决策取代后 is_current=false（口径同 http/recruiting.ts 的 is_current）。
          is_current: latest.superseded_by_decision_id === null,
          ...optional('decided_at', iso(latest.decided_at)),
          ...optional('reason', latest.reason ?? undefined),
        } as const,
      }),
  }
}

/** 入参回显（`matched` = 本次返回条数）。 */
function buildApplicationQueryValue(
  args: Record<string, unknown>,
  matched: number,
): ApplicationQueryValue {
  const single = args.application_id as string | undefined
  return {
    mode: single === undefined ? 'LIST' : 'ONE',
    matched,
    limit: single === undefined ? (typeof args.limit === 'number' ? args.limit : 10) : 1,
    ...optional('application_id', single),
    ...optional('job_id', args.job_id as string | undefined),
    ...optional('stage_code', args.stage_code as string | undefined),
    ...optional('lifecycle_status', args.lifecycle_status as string | undefined),
  }
}

/** 只在该键有值时展开（输出 schema 没有 null，用"缺键"表达"没有"）。 */
function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string }
}

/** 给 Agent 的下一步**产品工具**建议（避免它下沉到 shell/psql）。 */
function buildNextTools(
  rows: readonly ApplicationRow[],
  applications: readonly ApplicationValue[],
): readonly NextToolValue[] {
  const hints: NextToolValue[] = []
  const first = applications[0]
  if (first === undefined) return hints
  if (first.material !== undefined) {
    hints.push({
      name: MATERIAL_READ_TOOL,
      reason: 'Read the bound material (structure summary, locators, verified sha256; TEXT mode only when the '
        + 'business task needs the source text). Do not read resume files with shell/file tools.',
      args_json: JSON.stringify({ application_id: first.application_id, mode: 'SUMMARY' }),
    })
  }
  hints.push({
    name: 'recruitment_job_get',
    reason: 'Full job description + every rubric criterion with R-VAL executability and absence reasons '
      + '(this tool only projects the pinned rubric pointer).',
    args_json: JSON.stringify({ job_id: first.job.job_id }),
  })
  if (first.interviews.count > 0) {
    hints.push({
      name: 'recruitment_interview_get',
      reason: 'Per-interview facts: interviewers, meeting binding, transcript state, scorecard blockers.',
      args_json: JSON.stringify({ application_id: first.application_id }),
    })
  }
  const firstInterview = first.interviews.items[0]
  if (first.transcripts.count > 0 && firstInterview !== undefined) {
    hints.push({
      name: 'recruitment_transcript_read',
      reason: 'Transcript status projection for one interview (READY/NEEDS_REVIEW + reason_code, no raw text).',
      // transcript_read 的必填入参是 interview_id，不接受 application_id（传错会 INVALID_ARGS）。
      args_json: JSON.stringify({ interview_id: firstInterview.interview_id }),
    })
  }
  if (rows.length > 1) {
    hints.push({
      name: 'recruitment_screening_evaluate',
      reason: 'Run the read-only S7 screening evaluation for one application (evidence-backed, never writes).',
      args_json: JSON.stringify({ application_id: first.application_id }),
    })
  }
  return hints
}

/**
 * 校验 `/` 归一化 `recruitment_application_get` 的入参（纯函数；execute 与测试同口径）。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参。
 */
export function parseApplicationGetArgs(raw: unknown): Record<string, unknown> {
  const args = parseArgs(APPLICATION_GET_PARAMS, raw)
  const single = args.application_id as string | undefined
  const filters = (['job_id', 'stage_code', 'lifecycle_status'] as const)
    .filter((key) => args[key] !== undefined)
  if (single === undefined && filters.length === 0) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: 'MISSING_FILTER',
        message: 'pass application_id, or at least one of job_id / stage_code / lifecycle_status',
      }),
    )
  }
  if (single !== undefined && filters.length > 0) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: 'MUTUALLY_EXCLUSIVE',
        message: 'application_id cannot be combined with job_id / stage_code / lifecycle_status',
        detail: { unexpected: filters },
      }),
    )
  }
  return args
}

/** `recruitment_application_get` 的模型可见 render。 */
function renderApplicationGet(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as ApplicationGetValue
  const lines: string[] = [
    `${v.tool} read-only (${v.contract_version}) labels=${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`,
    `query: ${v.query.mode} matched=${v.query.matched}${v.query.application_id === undefined ? '' : ` application_id=${v.query.application_id}`}`,
  ]
  for (const application of v.applications) {
    lines.push(
      `application ${application.application_id} @ ${application.stage_code} `
        + `(${application.lifecycle_status}, record_version=${application.record_version})`,
      `  candidate: ${application.candidate.candidate_id} / ${application.candidate.display_name} `
        + `(${application.candidate.identity_status}) contacts=${application.candidate.contacts.email} `
        + `${application.candidate.contacts.phone} (visible=${String(application.candidate.contacts.visible)})`,
      `  job: ${application.job.job_id} ${application.job.code} ${application.job.title} `
        + `status=${application.job.status}`,
    )
    if (application.rubric !== undefined) {
      lines.push(
        `  rubric: ${application.rubric.rubric_version_id} v${application.rubric.version_no} `
          + `(source=${application.rubric.source}, approved=${String(application.rubric.approved)}, `
          + `criteria=${application.rubric.criteria_count})`,
      )
    } else {
      lines.push('  rubric: (none pinned; call recruitment_job_get to see why)')
    }
    if (application.material !== undefined) {
      const asset = application.material.asset
      lines.push(
        `  material: resume_version=${application.material.resume_version_id} `
          + `parse_status=${application.material.parse_status} pages=${application.material.pages} `
          + `hard_issues=${application.material.hard_issue_codes.length}`,
        asset === undefined
          ? '    asset: (none linked)'
          : `    asset: ${asset.intake_asset_id} ${asset.file_name} ${asset.byte_size}B `
            + `sha256=${asset.sha256} (${asset.validation_status})`,
      )
    } else {
      lines.push('  material: (none bound to this application)')
    }
    lines.push(
      `  interviews: ${application.interviews.count} `
        + `[${application.interviews.items.map((item) => `R${item.round_no}/${item.status}`).join(', ')}]`,
      `  transcripts: ${application.transcripts.count} (READY ${application.transcripts.ready_count})`,
      // O14：合计口径显式可读（不再只给一个会被读成"面评行数"的 0/0）。
      `  evaluations: ${application.evaluations.scorecards_submitted_total}/`
        + `${application.evaluations.scorecards_required_total} submitted `
        + `(across rounds: required=${application.evaluations.scorecards_required_total}, `
        + `submitted=${application.evaluations.scorecards_submitted_total}, `
        + `waived=${application.evaluations.scorecards_waived_total}, `
        + `pending=${application.evaluations.scorecards_pending_total})`,
      // O12：服务端算好的修复建议（Agent 只转述，不自己编"去审批谁"）。
      `  rubric remediation: ${application.rubric_remediation.code} — ${application.rubric_remediation.message}`,
      `  decisions: ${application.decisions.count}`
        + (application.decisions.latest === undefined
          ? ''
          : ` (latest ${application.decisions.latest.scope}/${application.decisions.latest.result} `
            + `@ ${application.decisions.latest.stage_code})`),
    )
  }
  if (v.next_tools.length > 0) {
    lines.push('next tools (use these, not shell/psql):')
    for (const hint of v.next_tools) lines.push(`  ${hint.name} ${hint.args_json} — ${hint.reason}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

// ---------------------------------------------------------------------------
//  recruitment_material_read
// ---------------------------------------------------------------------------

/** 材料读取模式。 */
const MATERIAL_MODES: readonly string[] = ['SUMMARY', 'TEXT']

/** `recruitment_material_read` 入参。 */
const MATERIAL_READ_PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Application id, UUID text form: read the material it pins '
      + '(`application.resume_version_id`). Mutually exclusive with resume_version_id.',
  },
  resume_version_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Resume version id, UUID text form: read that exact material row. '
      + 'Mutually exclusive with application_id.',
  },
  mode: {
    kind: 'string',
    values: MATERIAL_MODES,
    description: 'SUMMARY (default): structure summary + locators + hashes, no source text. '
      + 'TEXT: additionally return a bounded, contact-redacted excerpt of the source document '
      + '(only when a review truly needs the wording).',
  },
  max_chars: {
    kind: 'integer',
    min: 200,
    max: 8000,
    description: 'TEXT mode only: maximum excerpt characters (200..8000, default 2000).',
  },
  include_contacts: {
    kind: 'boolean',
    description: 'When true, return parsed email/phone in clear text (PII). Defaults to false, which masks both.',
  },
}

/** 材料读取的核心事实行（resume_version + 原件 asset）。 */
interface MaterialReadRow extends MaterialRow {
  readonly tenant_id: string
}

/** 输出：一个字段/段落的定位器（来源 id + 原文片段 quote 由调用方决定是否给）。 */
interface FieldLocatorValue {
  readonly field: string
  readonly state: string
  readonly entry_count: number
  readonly page?: number
  readonly bbox?: number[]
  readonly quote?: string
}

/** 输出：一条工作/教育经历（原文行 + 定位器）。 */
interface MaterialEntryValue {
  readonly field: string
  readonly index: number
  readonly header_text: string
  readonly page?: number
  readonly bbox?: number[]
  readonly dates_raw?: string
}

/** 输出：时间线摘要。 */
interface TimelineValue {
  readonly intervals: number
  readonly closed_intervals: number
  readonly open_ended_intervals: number
  readonly covered_months_closed: number
}

/** 输出：筛选可用性摘要（converter 的字段级结论，不重算规则）。 */
interface ScreeningValue {
  readonly eligible_fields: string[]
  readonly blocked_fields: readonly { readonly field: string; readonly reason: string }[]
}

/** 输出：issue 摘要。 */
interface IssueSummaryValue {
  readonly count: number
  readonly hard_count: number
  readonly hard_codes: string[]
  readonly codes: string[]
}

/** 输出：结构摘要。 */
interface StructureValue {
  readonly field_locators: readonly FieldLocatorValue[]
  readonly entries: readonly MaterialEntryValue[]
  readonly issues: IssueSummaryValue
  readonly timeline?: TimelineValue
  readonly screening?: ScreeningValue
}

/** 输出：材料元信息。 */
interface MaterialMetaValue {
  readonly resume_version_id: string
  readonly version_no: number
  readonly parse_status: string
  readonly pages: number
  readonly reader_backend: string
  readonly reader_version: string
  readonly source_asset_sha256?: string
  readonly content_sha256?: string
  readonly parsed_source_sha256?: string
  readonly parser_name?: string
}

/** 输出：原件事实。 */
interface AssetValue {
  readonly intake_asset_id: string
  readonly file_name: string
  readonly mime_type: string
  readonly byte_size: number
  readonly sha256: string
  readonly validation_status: string
  readonly storage_ref_kind: string
}

/** TEXT 模式的闭集 reason_code（`available=true` 时恒为 `OK`）。 */
type TextReasonCode =
  | 'OK'
  | 'NOT_REQUESTED'
  | 'CONVERTER_NOT_CONFIGURED'
  | 'NO_ALLOWED_ROOTS'
  | 'NOT_FOUND_IN_ALLOWED_ROOTS'
  | 'SEARCH_BUDGET_EXCEEDED'
  | 'ASSET_MISSING'
  | 'ASSET_INVALID'
  | 'READER_FAILED'
  | 'HASH_MISMATCH'

const TEXT_REASON_CODES: readonly TextReasonCode[] = [
  'OK', 'NOT_REQUESTED', 'CONVERTER_NOT_CONFIGURED', 'NO_ALLOWED_ROOTS',
  'NOT_FOUND_IN_ALLOWED_ROOTS', 'SEARCH_BUDGET_EXCEEDED', 'ASSET_MISSING', 'ASSET_INVALID',
  'READER_FAILED', 'HASH_MISMATCH',
]

/** 输出：受控文本片段事实。 */
interface TextValue {
  readonly mode: 'SUMMARY' | 'TEXT'
  readonly available: boolean
  readonly reason_code: TextReasonCode
  /** 全文字符数（不是片段长度）；片段长度见 excerpt_chars。 */
  readonly source_chars: number
  /** 实际返回的片段字符数（未返回片段 = 0）。 */
  readonly excerpt_chars: number
  readonly truncated: boolean
  readonly excerpt?: string
  readonly media_type?: string
  readonly reader_id?: string
  readonly asset_sha256_verified?: boolean
}

/** `recruitment_material_read` 的规范输出。 */
interface MaterialReadValue {
  readonly tool: string
  readonly contract_version: string
  readonly tool_kind: 'READ_ONLY'
  readonly labels: ReadToolLabels
  readonly query: {
    readonly mode: 'SUMMARY' | 'TEXT'
    readonly source: 'APPLICATION' | 'RESUME_VERSION'
    readonly application_id?: string
    readonly resume_version_id?: string
  }
  readonly material: {
    readonly meta: MaterialMetaValue
    readonly asset?: AssetValue
    readonly structure: StructureValue
    readonly contacts: ContactsValue
  }
  readonly text: TextValue
  readonly next_tools: readonly NextToolValue[]
}

const MATERIAL_LOCATOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    state: { type: 'string', enum: ['present', 'absent', 'unreadable'] },
    entry_count: { type: 'number' },
    page: { type: 'number' },
    bbox: { type: 'array', items: { type: 'number' } },
    quote: { type: 'string' },
  },
  required: ['field', 'state', 'entry_count'],
  additionalProperties: false,
}

const MATERIAL_ENTRY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    field: { type: 'string' },
    index: { type: 'number' },
    header_text: { type: 'string' },
    page: { type: 'number' },
    bbox: { type: 'array', items: { type: 'number' } },
    dates_raw: { type: 'string' },
  },
  required: ['field', 'index', 'header_text'],
  additionalProperties: false,
}

const MATERIAL_READ_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    tool_kind: { type: 'string', enum: ['READ_ONLY'] },
    labels: LABELS_SCHEMA,
    query: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['SUMMARY', 'TEXT'] },
        source: { type: 'string', enum: ['APPLICATION', 'RESUME_VERSION'] },
        application_id: { type: 'string' },
        resume_version_id: { type: 'string' },
      },
      required: ['mode', 'source'],
      additionalProperties: false,
    },
    material: {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          properties: {
            resume_version_id: { type: 'string' },
            version_no: { type: 'number' },
            parse_status: { type: 'string', enum: RESUME_PARSE_STATUSES },
            pages: { type: 'number' },
            reader_backend: { type: 'string' },
            reader_version: { type: 'string' },
            source_asset_sha256: { type: 'string' },
            content_sha256: { type: 'string' },
            parsed_source_sha256: { type: 'string' },
            parser_name: { type: 'string' },
          },
          required: ['resume_version_id', 'version_no', 'parse_status', 'pages', 'reader_backend', 'reader_version'],
          additionalProperties: false,
        },
        asset: {
          type: 'object',
          properties: {
            intake_asset_id: { type: 'string' },
            file_name: { type: 'string' },
            mime_type: { type: 'string' },
            byte_size: { type: 'number' },
            sha256: { type: 'string' },
            validation_status: { type: 'string' },
            storage_ref_kind: { type: 'string' },
          },
          required: [
            'intake_asset_id', 'file_name', 'mime_type', 'byte_size', 'sha256', 'validation_status',
            'storage_ref_kind',
          ],
          additionalProperties: false,
        },
        structure: {
          type: 'object',
          properties: {
            field_locators: { type: 'array', items: MATERIAL_LOCATOR_SCHEMA },
            entries: { type: 'array', items: MATERIAL_ENTRY_SCHEMA },
            issues: {
              type: 'object',
              properties: {
                count: { type: 'number' },
                hard_count: { type: 'number' },
                hard_codes: { type: 'array', items: { type: 'string' } },
                codes: { type: 'array', items: { type: 'string' } },
              },
              required: ['count', 'hard_count', 'hard_codes', 'codes'],
              additionalProperties: false,
            },
            timeline: {
              type: 'object',
              properties: {
                intervals: { type: 'number' },
                closed_intervals: { type: 'number' },
                open_ended_intervals: { type: 'number' },
                covered_months_closed: { type: 'number' },
              },
              required: ['intervals', 'closed_intervals', 'open_ended_intervals', 'covered_months_closed'],
              additionalProperties: false,
            },
            screening: {
              type: 'object',
              properties: {
                eligible_fields: { type: 'array', items: { type: 'string' } },
                blocked_fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { field: { type: 'string' }, reason: { type: 'string' } },
                    required: ['field', 'reason'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['eligible_fields', 'blocked_fields'],
              additionalProperties: false,
            },
          },
          required: ['field_locators', 'entries', 'issues'],
          additionalProperties: false,
        },
        contacts: CONTACTS_SCHEMA,
      },
      required: ['meta', 'structure', 'contacts'],
      additionalProperties: false,
    },
    text: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['SUMMARY', 'TEXT'] },
        available: { type: 'boolean' },
        reason_code: { type: 'string', enum: TEXT_REASON_CODES },
        source_chars: { type: 'number' },
        excerpt_chars: { type: 'number' },
        truncated: { type: 'boolean' },
        excerpt: { type: 'string' },
        media_type: { type: 'string' },
        reader_id: { type: 'string' },
        asset_sha256_verified: { type: 'boolean' },
      },
      required: ['mode', 'available', 'reason_code', 'source_chars', 'excerpt_chars', 'truncated'],
      additionalProperties: false,
    },
    next_tools: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          reason: { type: 'string' },
          args_json: { type: 'string' },
        },
        required: ['name', 'reason', 'args_json'],
        additionalProperties: false,
      },
    },
  },
  required: ['tool', 'contract_version', 'tool_kind', 'labels', 'query', 'material', 'text', 'next_tools'],
  additionalProperties: false,
}

/** 材料字段名（`resume-read.ts:41` 的同一集合；该常量未导出，改动要同步）。 */
const MATERIAL_FIELD_NAMES = ['name', 'phone', 'email', 'work_experience', 'education'] as const
/** 材料字段名 → 是否属于联系方式（默认脱敏；quote 默认不给）。 */
const CONTACT_FIELDS = new Set<string>(['phone', 'email'])

/** 从 evidence[0] 取定位器（page/bbox/quote），缺失返回空对象。 */
function evidenceOf(entry: Record<string, unknown> | null): {
  readonly page?: number
  readonly bbox?: number[]
  readonly quote?: string
} {
  const evidence = asRecord(asArray(entry?.evidence)[0])
  if (evidence === null) return {}
  const page = asNumber(evidence.page)
  const bbox = asArray(evidence.bbox)
    .map((value) => asNumber(value))
    .filter((value): value is number => value !== undefined)
  const quote = asString(evidence.text)
  return {
    ...(page === undefined ? {} : { page }),
    ...(bbox.length === 0 ? {} : { bbox }),
    ...(quote === undefined ? {} : { quote }),
  }
}

/**
 * `parsed_fields` → 结构摘要（只投影白名单里的四个子树；不读 protected，也不猜）。
 * @param parsed - `resume_version.parsed_fields`。
 * @param contactsVisible - 是否允许返回联系方式原文。
 * @returns 结构摘要。
 */
export function summarizeParsedFields(
  parsed: Record<string, unknown> | null,
  contactsVisible: boolean,
): {
  readonly structure: StructureValue
  readonly contacts: { readonly email: string; readonly phone: string }
} {
  const fields = asRecord(parsed?.fields) ?? {}
  const locators: FieldLocatorValue[] = []
  const entries: MaterialEntryValue[] = []
  for (const field of MATERIAL_FIELD_NAMES) {
    const entry = asRecord(fields[field])
    if (entry === null) {
      locators.push({ field, state: 'unreadable', entry_count: 0 })
      continue
    }
    const state = asString(entry.state) ?? 'unreadable'
    const fieldEntries = asArray(entry.entries)
    const locator = evidenceOf(entry)
    const isContact = CONTACT_FIELDS.has(field)
    locators.push({
      field,
      state,
      entry_count: fieldEntries.length > 0 ? fieldEntries.length : (asNumber(entry.entry_count) ?? 0),
      ...(locator.page === undefined ? {} : { page: locator.page }),
      ...(locator.bbox === undefined ? {} : { bbox: locator.bbox }),
      // quote 是原文片段：联系方式字段在未显式放行时不回显（避免"脱敏了却给了原文"）。
      ...(locator.quote === undefined || (isContact && !contactsVisible)
        ? {}
        : { quote: redactContactPatterns(locator.quote) }),
    })
    for (const [index, raw] of fieldEntries.entries()) {
      const item = asRecord(raw)
      if (item === null) continue
      // 工作/教育经历的业务内容就是 header_text（公司/学校/职位/日期那一行）；
      // 它不是联系方式，是评估必需的事实。
      const header = asString(item.header_text)
      if (header === undefined) continue
      const itemEvidence = asRecord(asArray(item.header_blocks)[0])
      const page = asNumber(itemEvidence?.page) ?? asNumber(item.page)
      const bbox = asArray(itemEvidence?.bbox ?? item.bbox)
        .map((value) => asNumber(value))
        .filter((value): value is number => value !== undefined)
      const date = asRecord(asArray(item.dates)[0])
      const datesRaw = asString(date?.raw)
      entries.push({
        field,
        index,
        header_text: isContact && !contactsVisible ? '***' : redactContactPatterns(header),
        ...(page === undefined ? {} : { page }),
        ...(bbox.length === 0 ? {} : { bbox }),
        ...(datesRaw === undefined ? {} : { dates_raw: datesRaw }),
      })
    }
    // 兼容单条经历被解析成 `value` 字符串（没有 `entries[]`）的投影：把它作为唯一一条经历回显，
    // 定位器用该字段的 evidence。否则"有内容但 entries 为空"会让 Agent 以为没读到经历。
    const valueText = asString(entry.value)
    if (
      fieldEntries.length === 0
      && valueText !== undefined
      && (field === 'work_experience' || field === 'education')
    ) {
      entries.push({
        field,
        index: 0,
        header_text: valueText,
        ...(locator.page === undefined ? {} : { page: locator.page }),
        ...(locator.bbox === undefined ? {} : { bbox: locator.bbox }),
      })
    }
  }

  const issues = materialIssues(parsed)
  const hard = hardIssueCodes(issues)
  const codes: string[] = []
  for (const issue of issues) {
    const code = issue.code ?? ''
    if (code !== '' && !codes.includes(code)) codes.push(code)
  }

  const timelineRecord = asRecord(parsed?.timeline)
  const timeline: TimelineValue | undefined = timelineRecord === null
    ? undefined
    : {
      intervals: asNumber(timelineRecord.intervals) ?? 0,
      closed_intervals: asNumber(timelineRecord.closed_intervals) ?? 0,
      open_ended_intervals: asNumber(timelineRecord.open_ended_intervals) ?? 0,
      covered_months_closed: asNumber(timelineRecord.covered_months_closed) ?? 0,
    }

  const screeningRecord = asRecord(parsed?.screening)
  const screening: ScreeningValue | undefined = screeningRecord === null
    ? undefined
    : {
      eligible_fields: asArray(screeningRecord.eligible_fields)
        .map((value) => asString(value))
        .filter((value): value is string => value !== undefined),
      blocked_fields: asArray(screeningRecord.blocked_fields).flatMap((raw) => {
        const item = asRecord(raw)
        const field = asString(item?.field)
        if (field === undefined) return []
        return [{ field, reason: asString(item?.reason) ?? '' }]
      }),
    }

  const emailValue = asString(asRecord(fields.email)?.value) ?? ''
  const phoneValue = asString(asRecord(fields.phone)?.value) ?? ''
  return {
    structure: {
      field_locators: locators,
      entries,
      issues: {
        count: issues.length,
        hard_count: hard.length,
        hard_codes: hard,
        codes,
      },
      ...(timeline === undefined ? {} : { timeline }),
      ...(screening === undefined ? {} : { screening }),
    },
    contacts: {
      email: contactsVisible ? emailValue : maskEmail(emailValue),
      phone: contactsVisible ? phoneValue : maskPhone(phoneValue),
    },
  }
}

/** 从 `storage_ref` 取"引用种类"（`content-addressed:sha256:<sha>` → `CONTENT_ADDRESSED`）。 */
function storageRefKind(storageRef: string | null): string {
  if (storageRef === null || storageRef === '') return 'NONE'
  if (storageRef.startsWith('content-addressed:')) return 'CONTENT_ADDRESSED'
  return 'OTHER'
}

/** 材料行 → 输出（SUMMARY 部分；TEXT 部分由调用方填）。 */
function toMaterialReadValue(
  row: MaterialReadRow,
  contactsVisible: boolean,
  labels: ReadToolLabels,
  mode: 'SUMMARY' | 'TEXT',
  source: 'APPLICATION' | 'RESUME_VERSION',
  queryIds: { readonly application_id?: string; readonly resume_version_id?: string },
): MaterialReadValue {
  const parsed = asRecord(row.parsed_fields)
  const meta = asRecord(parsed?.meta)
  const summary = summarizeParsedFields(parsed, contactsVisible)
  return {
    tool: MATERIAL_READ_TOOL,
    contract_version: CONTRACT_VERSION,
    tool_kind: 'READ_ONLY',
    labels,
    query: { mode, source, ...queryIds },
    material: {
      meta: {
        resume_version_id: row.id,
        version_no: row.version_no,
        parse_status: row.parse_status,
        pages: materialPages(parsed),
        reader_backend: asString(meta?.backend) ?? '',
        reader_version: asString(meta?.reader_version) ?? '',
        ...optional('source_asset_sha256', row.source_asset_sha256 ?? undefined),
        ...optional('content_sha256', row.content_sha256 ?? undefined),
        ...optional('parsed_source_sha256', asString(meta?.source_sha256)),
        ...optional('parser_name', row.parser_name ?? undefined),
      },
      ...(row.asset_id === null
        ? {}
        : {
          asset: {
            intake_asset_id: row.asset_id,
            file_name: row.file_name ?? '',
            mime_type: row.mime_type ?? '',
            byte_size: toCount(row.byte_size),
            sha256: row.asset_sha256 ?? '',
            validation_status: row.validation_status ?? '',
            storage_ref_kind: storageRefKind(row.storage_ref),
          } as const,
        }),
      structure: summary.structure,
      contacts: {
        visible: contactsVisible,
        email: summary.contacts.email,
        phone: summary.contacts.phone,
      },
    },
    text: {
      mode,
      available: false,
      reason_code: mode === 'TEXT' ? 'READER_FAILED' : 'NOT_REQUESTED',
      source_chars: 0,
      excerpt_chars: 0,
      truncated: false,
    },
    next_tools: [],
  }
}

/** 时长/预算：TEXT 摘录上限之外不再往模型塞正文。 */
const DEFAULT_MAX_CHARS = 2_000

/**
 * TEXT 模式：定位原件（allowed_roots + sha256）→ 受控读取 → 有界摘录。
 *
 * 纪律：定位只用 `resolveMaterialPath`（预算 + 缓存 + 根内校验）；读取只用
 * `readDocumentDetailed`（内部再验 allowed_roots，并给出原件 `asset_sha256`）；
 * 两者任一不成立就 `available=false` + 闭集 reason_code，**绝不**返回"看起来正常"的片段。
 * @param row - 材料行（含原件事实）。
 * @param converter - converter 配置（未配置时 TEXT 不可用，如实报 CONVERTER_NOT_CONFIGURED）。
 * @param maxChars - 摘录上限。
 * @returns `text` 输出块。
 */
async function readMaterialText(
  row: MaterialReadRow,
  converter: ResolvedConverterConfig | undefined,
  maxChars: number,
): Promise<TextValue> {
  const base: TextValue = {
    mode: 'TEXT',
    available: false,
    reason_code: 'READER_FAILED',
    source_chars: 0,
    excerpt_chars: 0,
    truncated: false,
  }
  const expectedSha = row.source_asset_sha256 ?? row.asset_sha256
  if (row.asset_id === null || expectedSha === null || row.file_name === null) {
    return { ...base, reason_code: 'ASSET_MISSING' }
  }
  if (row.validation_status !== null && row.validation_status !== 'VALID') {
    return { ...base, reason_code: 'ASSET_INVALID' }
  }
  if (converter === undefined) return { ...base, reason_code: 'CONVERTER_NOT_CONFIGURED' }

  const resolved = resolveMaterialPathAcrossRoots(
    { fileName: row.file_name, byteSize: toCount(row.byte_size), sha256: expectedSha },
    converter.allowed_roots,
  )
  if (resolved.path === null) {
    return { ...base, reason_code: textReasonFromMaterialReason(resolved.reason) }
  }

  try {
    const outcome = await readDocumentDetailed(resolved.path, converter)
    const content = outcome.content
    // 原件哈希必须与库里钉住的值一致：不一致说明"读到的不是这份材料"，绝不返回正文。
    if (content.asset_sha256 !== expectedSha) {
      return { ...base, reason_code: 'HASH_MISMATCH' }
    }
    const fullText = content.text
    // 先按上限切片再脱敏：`truncated` 只回答"原文是否比给我的片段长"，
    // 不能被脱敏导致的长度变化污染（否则一份短材料也会被说成"被截断"）。
    const rawExcerpt = fullText.slice(0, maxChars)
    const excerpt = redactContactPatterns(rawExcerpt)
    return {
      mode: 'TEXT',
      available: true,
      reason_code: 'OK',
      source_chars: fullText.length,
      excerpt_chars: excerpt.length,
      truncated: fullText.length > rawExcerpt.length,
      excerpt,
      media_type: content.media_type,
      reader_id: content.reader_id,
      asset_sha256_verified: true,
    }
  } catch (error) {
    const reason = isDocumentReadError(error) && error.code === 'FORBIDDEN'
      ? 'NOT_FOUND_IN_ALLOWED_ROOTS'
      : 'READER_FAILED'
    return { ...base, reason_code: reason }
  }
}

/** 材料定位 reason 闭集 → TEXT reason 闭集。 */
function textReasonFromMaterialReason(reason: MaterialPathReason): TextReasonCode {
  switch (reason) {
    case 'NO_ALLOWED_ROOTS':
      return 'NO_ALLOWED_ROOTS'
    case 'NOT_FOUND_IN_ALLOWED_ROOTS':
      return 'NOT_FOUND_IN_ALLOWED_ROOTS'
    case 'SEARCH_BUDGET_EXCEEDED':
      return 'SEARCH_BUDGET_EXCEEDED'
    case 'FOUND':
      // FOUND 却拿到 null 只可能是调用方 bug；按"读失败"如实报，不假装 AVAILABLE。
      return 'READER_FAILED'
    default:
      return 'READER_FAILED'
  }
}

/**
 * 在多个允许根里定位材料：**逐根**调用 `resolveMaterialPath`（配置顺序），命中即停。
 *
 * 为什么不一次传全部根：那个实现的预算是**跨根共享**的（按排序后的根顺序 BFS，总条目 ≤100k）。
 * 本机 `CodexWorkspace` 目录树很大，排在前面的根会先把预算用光，导致后面的根里明明有的材料被
 * 报成 `SEARCH_BUDGET_EXCEEDED`（task-75 冒烟实测：同一份 PDF 在 orchestration 根里 FOUND，
 * 三根一起传却是 BUDGET_EXCEEDED）。逐根调用让每个根各自受同一预算约束、互不饿死，
 * 同时保留它的全部纪律（绝对路径、跳符号链接、basename+byteSize 预筛、sha256 确认、缓存、不读 cwd）。
 * 这是**组合**既有实现，不复制它的规则；不改进 `resolveMaterialPath` 本身（那个文件不在本 lane 写范围）。
 * @param input - 材料事实（文件名/字节数/期望 sha256）。
 * @param roots - 允许根（配置顺序）。
 * @returns `{path, reason}`；全都没命中时按"最诚实的失败原因"汇总。
 */
export function resolveMaterialPathAcrossRoots(
  input: { readonly fileName: string; readonly byteSize: number; readonly sha256: string },
  roots: readonly string[],
): { path: string | null; reason: MaterialPathReason } {
  if (roots.length === 0) return { path: null, reason: 'NO_ALLOWED_ROOTS' }
  let sawNotFound = false
  let sawBudget = false
  for (const root of roots) {
    const attempt = resolveMaterialPath(input, { roots: [root] })
    if (attempt.path !== null) return attempt
    if (attempt.reason === 'SEARCH_BUDGET_EXCEEDED') sawBudget = true
    if (attempt.reason === 'NOT_FOUND_IN_ALLOWED_ROOTS') sawNotFound = true
  }
  // 预算用光 ≠ 不存在：只要有一个根没搜完，就如实报预算而不是"文件不存在"。
  if (sawBudget) return { path: null, reason: 'SEARCH_BUDGET_EXCEEDED' }
  if (sawNotFound) return { path: null, reason: 'NOT_FOUND_IN_ALLOWED_ROOTS' }
  return { path: null, reason: 'NO_ALLOWED_ROOTS' }
}

/** 按 id 取一条材料行（application 或 resume_version 入口）。 */
async function queryMaterialReadRow(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
): Promise<{
  row: MaterialReadRow
  source: 'APPLICATION' | 'RESUME_VERSION'
  resumeVersionId: string
  /** 只有走 application 入口时才知道它属于哪个岗位（给 next_tools 的 job_get 用）。 */
  jobId?: string
}> {
  const applicationId = args.application_id as string | undefined
  const resumeVersionId = args.resume_version_id as string | undefined
  let targetResumeVersionId = resumeVersionId
  let jobId: string | undefined
  if (applicationId !== undefined) {
    const { rows } = await client.query<{ resume_version_id: string | null; job_id: string }>(
      `select resume_version_id, job_id from recruitment.application
        where tenant_id = $1 and id = $2`,
      [cfg.tenant_id, applicationId],
    )
    const application = rows[0]
    if (application === undefined) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        JSON.stringify({ reason_code: 'APPLICATION_NOT_FOUND', application_id: applicationId }),
      )
    }
    if (application.resume_version_id === null) {
      throw new RecruitmentToolError(
        'NOT_FOUND',
        JSON.stringify({ reason_code: 'APPLICATION_HAS_NO_MATERIAL', application_id: applicationId }),
      )
    }
    targetResumeVersionId = application.resume_version_id
    jobId = application.job_id
  }
  if (targetResumeVersionId === undefined) {
    // parseArgs 已保证至少一个（这里只是类型收窄；不静默兜底）。
    throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: 'MISSING_ID' }))
  }
  const { rows } = await client.query<MaterialReadRow>(
    `select rv.id, rv.tenant_id, rv.resume_id, rv.version_no, rv.content_sha256, rv.source_asset_sha256,
            rv.parser_name, rv.parser_version, rv.parse_status, rv.parse_error, rv.parsed_fields,
            ia.id as asset_id, ia.file_name, ia.mime_type, ia.byte_size,
            ia.sha256 as asset_sha256, ia.storage_ref, ia.validation_status
       from recruitment.resume_version rv
       left join recruitment.resume r
         on r.id = rv.resume_id and r.tenant_id = rv.tenant_id
       left join recruitment.intake_asset ia
         on ia.id = r.intake_asset_id and ia.tenant_id = rv.tenant_id
      where rv.tenant_id = $1 and rv.id = $2`,
    [cfg.tenant_id, targetResumeVersionId],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new RecruitmentToolError(
      'NOT_FOUND',
      JSON.stringify({ reason_code: 'RESUME_VERSION_NOT_FOUND', resume_version_id: targetResumeVersionId }),
    )
  }
  return {
    row,
    source: applicationId === undefined ? 'RESUME_VERSION' : 'APPLICATION',
    resumeVersionId: targetResumeVersionId,
    ...(jobId === undefined ? {} : { jobId }),
  }
}

/**
 * 在**已有只读事务**里读一份受控材料（`execute()` 与集成测试同一条路径）。
 * @param client - 只读事务内客户端。
 * @param cfg - 已解析的库配置。
 * @param args - 已校验的入参。
 * @param converter - converter 配置（TEXT 必需；SUMMARY 可为 undefined）。
 * @returns 规范输出值。
 */
export async function readMaterialValue(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  converter: ResolvedConverterConfig | undefined,
): Promise<MaterialReadValue> {
  const mode = (args.mode as 'SUMMARY' | 'TEXT' | undefined) ?? 'SUMMARY'
  const contactsVisible = args.include_contacts === true
  const { row, source, resumeVersionId, jobId } = await queryMaterialReadRow(client, cfg, args)
  const labels = await buildReadToolLabels(client, cfg.tenant_id)
  const value = toMaterialReadValue(row, contactsVisible, labels, mode, source, {
    ...(args.application_id === undefined ? {} : { application_id: args.application_id as string }),
    resume_version_id: resumeVersionId,
  })
  const text = mode === 'TEXT'
    ? await readMaterialText(row, converter, typeof args.max_chars === 'number' ? args.max_chars : DEFAULT_MAX_CHARS)
    : value.text
  // next_tools 的 args 必须能被目标工具**真解析**通过（job_get 必填 job_id；application_get 不收
  // resume_version_id；transcript_read 必填 interview_id）。取不到就少推一条，别给必失败的建议。
  const nextTools: NextToolValue[] = []
  if (jobId !== undefined) {
    nextTools.push({
      name: 'recruitment_job_get',
      reason: 'Compare this material against the full rubric criteria (job description + R-VAL executability).',
      args_json: JSON.stringify({ job_id: jobId }),
    })
  }
  if (args.application_id !== undefined) {
    nextTools.push({
      name: 'recruitment_screening_evaluate',
      reason: 'Evaluate the application against the pinned rubric (read-only, evidence-backed).',
      args_json: JSON.stringify({ application_id: args.application_id as string }),
    })
  }
  return { ...value, labels, text, next_tools: nextTools }
}

/** `recruitment_material_read` 的模型可见 render。 */
function renderMaterialRead(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as MaterialReadValue
  const meta = v.material.meta
  const lines: string[] = [
    `${v.tool} read-only (${v.contract_version}) labels=${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`,
    `query: ${v.query.mode} from ${v.query.source} resume_version=${meta.resume_version_id}`,
    `material: parse_status=${meta.parse_status} pages=${meta.pages} reader=${meta.reader_backend}@${meta.reader_version}`,
  ]
  if (v.material.asset !== undefined) {
    const asset = v.material.asset
    lines.push(
      `  asset: ${asset.intake_asset_id} ${asset.file_name} ${asset.byte_size}B sha256=${asset.sha256} `
        + `(${asset.validation_status}, ref=${asset.storage_ref_kind})`,
    )
  } else {
    lines.push('  asset: (none linked: the material row has no intake_asset)')
  }
  lines.push(
    `  hashes: source_asset_sha256=${meta.source_asset_sha256 ?? ''} content_sha256=${meta.content_sha256 ?? ''}`,
    `  contacts: email=${v.material.contacts.email} phone=${v.material.contacts.phone} `
      + `(visible=${String(v.material.contacts.visible)})`,
    `  field_locators: ${v.material.structure.field_locators.map((item) => `${item.field}=${item.state}`).join(', ')}`,
    `  entries: ${v.material.structure.entries.length} (work/education header lines with locators)`,
    `  issues: ${v.material.structure.issues.count} (hard ${v.material.structure.issues.hard_count}: `
      + `${v.material.structure.issues.hard_codes.join(',') || 'none'})`,
  )
  if (v.material.structure.timeline !== undefined) {
    const t = v.material.structure.timeline
    lines.push(`  timeline: ${t.intervals} intervals, ${t.covered_months_closed} covered months (closed)`)
  }
  lines.push(`text (${v.text.mode}): available=${String(v.text.available)} reason=${v.text.reason_code} `
    + `source_chars=${v.text.source_chars} excerpt_chars=${v.text.excerpt_chars} truncated=${String(v.text.truncated)}`)
  if (v.text.excerpt !== undefined) {
    lines.push('--- source excerpt (contact-redacted, verified sha256) ---', v.text.excerpt, '--- end excerpt ---')
  }
  for (const hint of v.next_tools) lines.push(`next: ${hint.name} ${hint.args_json} — ${hint.reason}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 校验 `/` 归一化 `recruitment_material_read` 的入参（纯函数）。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参。
 */
export function parseMaterialReadArgs(raw: unknown): Record<string, unknown> {
  const args = parseArgs(MATERIAL_READ_PARAMS, raw)
  const hasApplication = args.application_id !== undefined
  const hasResumeVersion = args.resume_version_id !== undefined
  if (hasApplication === hasResumeVersion) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: hasApplication ? 'MUTUALLY_EXCLUSIVE' : 'MISSING_ID',
        message: 'pass exactly one of application_id / resume_version_id',
      }),
    )
  }
  if (args.mode === 'TEXT' && args.max_chars !== undefined) {
    // 参数校验已限 200..8000；这里保留分支说明 TEXT 之外的 max_chars 被忽略（不报错，回显 mode）。
    return args
  }
  return args
}

// ---------------------------------------------------------------------------
//  工厂（index.ts 接线由 W0 落；本文件只导出工厂）
// ---------------------------------------------------------------------------

/** 业务读工具依赖（DB 必需；converter 只在 material_read 的 TEXT 模式需要）。 */
export interface BusinessReadDeps {
  readonly database: ResolvedDatabaseConfig
  readonly converter?: ResolvedConverterConfig
  /** converter 缺配置时的 issue（用于如实告诉模型"为什么 TEXT 不可用"）。 */
  readonly converterIssues?: readonly string[]
}

/** 造"数据库没配置"的替身：工具照常注册，调用即报 NOT_CONFIGURED 并列出缺什么。 */
function unconfiguredReadTool(
  toolName: string,
  summary: string,
  issues: readonly string[],
): ReadonlyToolDefinition {
  return {
    name: toolName,
    description: `${summary} Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${toolName} is not configured: ${issues.join('; ')}` }]
      },
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', `${toolName} is not configured: ${issues.join('; ')}`)
    },
  }
}

/**
 * 造 `recruitment_application_get`（真查 PG，只读）。
 * @param deps - 依赖（租户只从 deps.database 来，模型无法传入）。
 * @returns 工具定义。
 */
export function createApplicationGetTool(deps: BusinessReadDeps): ReadonlyToolDefinition {
  return {
    name: APPLICATION_GET_TOOL,
    description:
      'READ-ONLY. Get one recruitment application (or a filtered list) with everything a recruiter needs to '
      + 'reason about it without touching the database: candidate (contacts masked unless include_contacts), '
      + 'job code/title/status, pinned rubric version pointer (approved flag, criteria count, payload hash), '
      + 'material summary (resume_version, parse_status, pages, hard issue codes, source file sha256), '
      + 'interviews, transcript counts, scorecard counts and the latest decision. Every block carries its '
      + 'source id; missing facts are omitted, never invented; an unknown application_id returns NOT_FOUND. '
      + 'This tool only projects the pinned rubric pointer — call recruitment_job_get for the full criteria/JD, '
      + 'recruitment_material_read for the material itself, and recruitment_interview_get for per-interview '
      + 'facts. Never use shell, psql or source-code reads to obtain recruitment facts. '
      + 'labels.provenance is FIXTURE unless the tenant is explicitly declared non-synthetic; trigger=MANUAL; '
      + 'connection=CONNECTED means a direct business-DB read.',
    parameters: toParameterSchema(APPLICATION_GET_PARAMS),
    output: { schema: APPLICATION_GET_OUTPUT_SCHEMA, render: renderApplicationGet },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseApplicationGetArgs(rawArgs)
      const pool = createPool(deps.database)
      try {
        return await withReadOnly(pool, async (client) => readApplicationValue(client, deps.database, args))
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 造 `recruitment_material_read`（真查 PG + 受控文件读取，只读）。
 * @param deps - 依赖（converter 可缺；缺了 TEXT 模式如实报 CONVERTER_NOT_CONFIGURED）。
 * @returns 工具定义。
 */
export function createMaterialReadTool(deps: BusinessReadDeps): ReadonlyToolDefinition {
  const converterNote = deps.converter === undefined
    ? ' Text extraction is NOT CONFIGURED in this deployment (structure summary and hashes still work).'
    : ''
  return {
    name: MATERIAL_READ_TOOL,
    description:
      'READ-ONLY. Read the controlled material of one application (or one resume_version): parse status, '
      + 'pages, parser, the two distinct hashes (source_asset_sha256 = original file bytes, content_sha256 = '
      + 'parsed projection), the linked intake asset (file name/size/sha256/validation), field states with '
      + 'page/bbox locators, work/education header lines, issues (hard codes), timeline and screening '
      + 'eligibility. Contacts are masked unless include_contacts is true; protected attributes are never read. '
      + 'mode=SUMMARY (default) returns no source text; mode=TEXT additionally returns a bounded '
      + '(max_chars, default 2000), contact-redacted excerpt, but only when the original bytes are found inside '
      + 'the configured allowed_roots AND their sha256 matches the pinned value — otherwise text.available is '
      + 'false with a closed reason_code. Never search the filesystem or read the resume with shell/file tools.'
      + converterNote,
    parameters: toParameterSchema(MATERIAL_READ_PARAMS),
    output: { schema: MATERIAL_READ_OUTPUT_SCHEMA, render: renderMaterialRead },
    isConcurrencySafe(): boolean {
      return true
    },
    async execute(rawArgs: unknown): Promise<unknown> {
      const args = parseMaterialReadArgs(rawArgs)
      const pool = createPool(deps.database)
      try {
        return await withReadOnly(
          pool,
          async (client) => readMaterialValue(client, deps.database, args, deps.converter),
        )
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 一次装配两个业务读工具（index.ts 只需一次调用）。
 * @param deps - 依赖。
 * @returns 两个工具定义（顺序固定：application_get、material_read）。
 */
export function createBusinessReadTools(deps: BusinessReadDeps): readonly ReadonlyToolDefinition[] {
  return [createApplicationGetTool(deps), createMaterialReadTool(deps)]
}

/**
 * 数据库没配置时的替身（两个工具都注册，调用即 NOT_CONFIGURED；不消失、不返回假数据）。
 * @param issues - 缺失的配置项。
 * @param converterIssues - converter 侧的 issues（只影响 TEXT，不阻止注册）。
 * @returns 两个替身工具定义。
 */
export function unconfiguredBusinessReadTools(
  issues: readonly string[],
  converterIssues: readonly string[] = [],
): readonly ReadonlyToolDefinition[] {
  const textNote = converterIssues.length === 0 ? '' : ` (also converter issues: ${converterIssues.join('; ')})`
  return [
    unconfiguredReadTool(
      APPLICATION_GET_TOOL,
      'Read one recruitment application with candidate/job/rubric-pointer/material/interview/evaluation/decision '
        + 'summary from the business database.',
      issues,
    ),
    unconfiguredReadTool(
      MATERIAL_READ_TOOL,
      'Read one controlled application material (structure summary, locators, hashes; optional bounded text).',
      [...issues, ...(converterIssues.length === 0 ? [] : [`converter: ${textNote}`])],
    ),
  ]
}

