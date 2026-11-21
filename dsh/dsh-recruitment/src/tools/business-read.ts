// Agent 一等业务读工具（只读）：`recruitment_application_get` / `recruitment_material_read`。
//
// 为什么需要它们（2026-11-16 产品/业务 FAIL，`work/review/2026-11-16-notion-acceptance/14-PRODUCT-BUSINESS-VERDICT.md`）：
//   真实 HR 场景里 Agent 要"读申请 → 读材料 → 读岗位 rubric → 给评估"。当时没有一等的申请/材料读工具，
//   Agent 只能下沉到 shell / psql / 读源码 / 直接找文件 —— 在真实招聘环境里这是权限/租户/合规红线，
//   而且 2 轮 42 步 3.3M tokens 只是为了"看一眼业务事实"。这两个工具把这条链路收回到产品面：
//     * 一次调用拿全一条申请的**业务事实**（申请人 / 岗位 / 阶段 / 材料摘要 / 面试与评估摘要 / 决策摘要）；
//       D-141 ① 起 rubric 块额外给 criteria 摘要（key/label/kind/weight，≤8 条）—— 判断
//       "这条路能不能跑"不必再调 `recruitment_job_get`（question/notes 全文仍归它）；
//     * 一次调用拿一份**受控材料**（结构摘要 + 定位器 + 哈希；TEXT 模式给**可定位的逐字引文**：
//       D-110 的 locator_kind + page/paragraph/line/offset + 逐字 quote + 原件 sha256 校验结论，
//       不是"整篇原文倾倒"）；
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
// D-141 ⑧：引文定位器按 D-110 的联合类型标注（`pdf_page_bbox` / `rtf_paragraph` /
// `docx_part_paragraph` / `text_line_offset`），类型直接取文档契约的唯一来源，不另立一套。
import type { DocumentBlock, DocumentContent } from '../document/contracts/index.ts'
// O14：必交面评进度的**唯一**派生实现（与 interview_get 共用同一份；不许两处各写一套）。
import { deriveRequiredScorecardProgress } from './scorecard-progress.ts'
import {
  resolveMaterialPath,
  type MaterialPathReason,
} from '../runtime/task-context.ts'
// D-（人工纠偏读投影）：当前 override 行 + human/effective 状态口径，均复用领域/DB 的单一实现。
import { effectiveState, type HumanState } from '../domain/criterion-override.ts'
import {
  readOverridesForApplications,
  type CriterionOverrideRow,
} from '../db/criterion-override.ts'
// 候选人约束读投影（碎片约束置顶 + 下一轮交接提醒）：复用 db/domain 的单一实现。
import {
  readPinsForCandidates,
  readHandoffsForInterviews,
  UNPIN_TOMBSTONE_TEXT,
  type CandidateConstraintRow,
} from '../db/candidate-constraint.ts'
import {
  CONSTRAINT_SOURCES,
  toPinProjection,
  toHandoffProjection,
  type PinProjection,
  type HandoffProjection,
} from '../domain/candidate-constraint.ts'

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

/**
 * 候选人姓名的**唯一归一化口径**（O20）。
 *
 * 为什么必须只有一份：模型可能用"候选人张样例"这种真实说法来找申请，而库里的
 * `candidate.display_name` 会有大小写与多余空白的差异。入参校验、SQL 参数、输出回显、
 * NOT_FOUND 文案若各写一套规则，迟早出现"回显说 A、查的是 B、报错说 C"。
 *
 * 规则：连续空白折叠为一个空格 + 去首尾空白 + 转小写（SQL 侧对 `lower(display_name)`
 * 做同样的空白折叠后 `strpos` 包含匹配）。
 * @param value - 模型/调用方给的姓名（可为多段空白）。
 * @returns 归一化后的姓名；全空白时返回空串（调用方负责拒绝）。
 */
export function normalizeCandidateName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** `recruitment_application_get` 入参。 */
const APPLICATION_GET_PARAMS: ParamMap = {
  application_id: {
    kind: 'string',
    uuid: true,
    maxLength: 36,
    description: 'Application id, UUID text form. Returns that one application. '
      + 'Mutually exclusive with candidate_name / job_id / stage_code / lifecycle_status.',
  },
  candidate_name: {
    kind: 'string',
    maxLength: 60,
    description: 'Only for a list: keep applications whose candidate display name contains this text. '
      + 'Containment match; case-insensitive and whitespace-insensitive (runs of whitespace collapse to one '
      + 'space; surrounding spaces are ignored). Use this when the human names a candidate without a UUID. '
      + 'Mutually exclusive with application_id. Multiple matches set needs_human_choice=true: ask the human '
      + 'which application to use, never pick one yourself.',
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

/** AT-1/2/3：跨岗携带历史行（append-only，源申请只读；一行 = 一次"从哪带到哪"的事实）。 */
export interface CarryOverRow {
  readonly application_id: string
  readonly source_application_id: string
  readonly ref_kind: string
  readonly ref_id: string
  readonly carried_by_actor_id: string
  readonly created_at: Date | string
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

/**
 * 一条 criterion 的**当前人工纠偏**行（从 `CriterionOverrideRow` 投影出的最小形状）。
 *
 * `human_state` 的原值域（`PRESENT`/`ABSENT`/`UNREADABLE`/null）由领域模块 `HumanState` 说话；
 * 这里不必再抄一份枚举。
 */
export interface CurrentOverride {
  readonly criterion_key: string
  readonly human_state: HumanState | null
  readonly note: string | null
  readonly created_at: Date | string
  readonly id: string
}

/**
 * 输出：Rubric 一条 criterion 的**摘要**（D-141 ①：只给判断"这条路能不能跑"所需的键，不给全文）。
 *
 * 人工纠偏读投影（五个新键 ADD-only，旧键一个不动）：
 *   * `ai_state`       —— AI 对该条的判断。**v1.0 库里没有任何 per-criterion AI 状态列**，恒为空串
 *                         （= 没有），字段只为前向兼容存在；**绝不编造数据**。
 *   * `human_state`    —— 当前 override 行的人判断；没有则空串。
 *   * `effective_state`—— `effectiveState(ai_state, human_state)`：人非空时人赢，否则 AI；两者都空则空串。
 *   * `override_note`  —— 当前 override 行的备注；没有则空串。
 *   * `overridden_at`  —— 当前 override 行 created_at 的 ISO；没有则空串。
 *
 * 为什么用空串而不是 null：DSH 的输出 schema 校验器**不支持 `type` 数组 / `type:'null'` / enum 里的 null**
 * （见 decision-record.ts 文件头偏差 7 与 `test/unit/output-schema.test.ts`）。为了保持
 * `additionalProperties:false` + 全部五键 required 的稳定形状，这里用空串表达"没有"，
 * 与既有 `optional()` 省略键的口径不同 —— 因为任务要求五键恒在、形状稳定。
 * TypeScript 侧仍用 `string` 标注（空串 ∈ string），语义在注释里说清。
 */
interface CriteriaSummaryItemValue {
  readonly key: string
  /** 人话标签（dimensions 里没有就不给，不编造）。 */
  readonly label?: string
  /** 封闭集合由 rubric 契约说话（MUST_HAVE / NICE_TO_HAVE / DISQUALIFIER）；这里只回显。 */
  readonly kind?: string
  readonly weight?: number
  /** AI 判断；v1.0 没有落库列，恒空串（= 没有）。 */
  readonly ai_state: string
  /** 当前人工纠偏状态（PRESENT/ABSENT/UNREADABLE）；没有则空串。 */
  readonly human_state: string
  /** 生效状态：human 赢，否则 ai；都无则空串。 */
  readonly effective_state: string
  /** 当前纠偏备注；没有则空串。 */
  readonly override_note: string
  /** 当前纠偏时间（ISO）；没有则空串。 */
  readonly overridden_at: string
}

/** 输出：Rubric 钉住版本的**指针 + 摘要**（完整 criteria/可执行性归 job_get，见 next_tools）。 */
interface RubricSummaryValue {
  readonly rubric_version_id: string
  readonly version_no: number
  readonly source: 'APPLICATION_PIN' | 'JOB_CURRENT'
  readonly approved: boolean
  readonly criteria_count: number
  /**
   * D-141 ①：前 8 条 criterion 的 key/label/kind/weight。
   *
   * 目的：Agent 判断"这条路能不能跑"（版本是否批准、有几条、哪几条、什么 kind）时
   * **不必再调一次 `recruitment_job_get`**；需要 question/notes 全文或 R-VAL 可执行性时仍调 job_get。
   * 这是**投影不是替代**：投影只读 `rubric_version.dimensions` 已有的四个键，不重算规则。
   */
  readonly criteria_summary: readonly CriteriaSummaryItemValue[]
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

/** 输出：一条携带历史（从哪个源申请、带了什么、谁带的、什么时候带的）。 */
export interface CarryOverItemValue {
  readonly source_application_id: string
  readonly ref_kind: string
  readonly ref_id: string
  readonly carried_by_actor_id: string
  readonly created_at: string
}

/** 输出：跨岗携带历史摘要（`count` 与 `items` 恒在；空时 count=0 / items=[]）。 */
export interface CarryOverValue {
  readonly count: number
  readonly items: readonly CarryOverItemValue[]
}

/**
 * 输出：一条 HANDOFF 交接提醒。复用领域投影的四字段 + `from_previous_round:true`，
 * 额外带一个**短号** `interview_ref`（不是 UUID —— 与其它读投影一致，结构化输出不吐内部 id）。
 */
export interface CandidateConstraintHandoffValue extends HandoffProjection {
  readonly interview_ref: string
}

/** 输出：候选人级约束读投影（置顶 PIN + 相关 HANDOFF；恒给出，空时数组为空）。 */
export interface CandidateConstraintsValue {
  readonly pins: readonly PinProjection[]
  readonly handoffs: readonly CandidateConstraintHandoffValue[]
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
  /** AT-1/2/3：跨岗携带历史（恒给出；空时 count=0 / items=[]，不省略块）。 */
  readonly carry_over: CarryOverValue
  /** 候选人级约束（碎片约束置顶 + 交接提醒；恒给出，空时 pins/handoffs 均为 []）。 */
  readonly constraints: CandidateConstraintsValue
}

/** 输出：一次查询的入参回显。 */
interface ApplicationQueryValue {
  readonly mode: 'ONE' | 'LIST'
  readonly matched: number
  readonly limit: number
  readonly application_id?: string
  /** O20：归一化后的姓名过滤（回显口径与 SQL/NOT_FOUND 共用 `normalizeCandidateName`）。 */
  readonly candidate_name?: string
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
  /**
   * O20：姓名查询命中多于一条时为 true —— 这是"必须问人"的闸门，Agent 不得自己挑一条。
   * 未给 candidate_name（或恰好命中一条）时为 false。
   */
  readonly needs_human_choice: boolean
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

/** AT-1/2/3：跨岗携带历史的紧凑输出 schema（恒在且形状封闭；空时用 0/[]，不用 null）。 */
const CARRY_OVER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    count: { type: 'number' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_application_id: { type: 'string' },
          ref_kind: { type: 'string', enum: ['SCORECARD', 'TRANSCRIPT', 'DECISION'] },
          ref_id: { type: 'string' },
          carried_by_actor_id: { type: 'string' },
          created_at: { type: 'string' },
        },
        required: ['source_application_id', 'ref_kind', 'ref_id', 'carried_by_actor_id', 'created_at'],
        additionalProperties: false,
      },
    },
  },
  required: ['count', 'items'],
  additionalProperties: false,
}

/** 候选人约束读投影的紧凑 schema（只有文本/来源/作者/时间 + 短号，没有任何内部 id）。 */
const CANDIDATE_CONSTRAINTS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pins: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          source: { type: 'string', enum: [...CONSTRAINT_SOURCES] },
          created_by: { type: 'string' },
          created_at: { type: 'string' },
        },
        required: ['text', 'source', 'created_by', 'created_at'],
        additionalProperties: false,
      },
    },
    handoffs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          source: { type: 'string', enum: [...CONSTRAINT_SOURCES] },
          created_by: { type: 'string' },
          created_at: { type: 'string' },
          from_previous_round: { type: 'boolean' },
          interview_ref: { type: 'string' },
        },
        required: ['text', 'source', 'created_by', 'created_at', 'from_previous_round', 'interview_ref'],
        additionalProperties: false,
      },
    },
  },
  required: ['pins', 'handoffs'],
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
        // D-141 ①：判断"这条路能不能跑"所需的 criteria 摘要（最多 8 条；全文仍归 job_get）。
        // 人工纠偏读投影：五个新键恒在（空串 = 没有），旧键一个不动。
        criteria_summary: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              kind: { type: 'string' },
              weight: { type: 'number' },
              ai_state: { type: 'string' },
              human_state: { type: 'string' },
              effective_state: { type: 'string' },
              override_note: { type: 'string' },
              overridden_at: { type: 'string' },
            },
            // 五键全部 required：形状稳定（值空串表示没有，不用 null / type 数组）。
            required: [
              'key', 'ai_state', 'human_state', 'effective_state', 'override_note', 'overridden_at',
            ],
            additionalProperties: false,
          },
        },
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
    carry_over: CARRY_OVER_SCHEMA,
    constraints: CANDIDATE_CONSTRAINTS_SCHEMA,
  },
  required: [
    'application_id', 'stage_code', 'lifecycle_status', 'record_version',
    'candidate', 'job', 'interviews', 'transcripts', 'evaluations', 'rubric_remediation', 'decisions',
    // 恒给出（空时 0/[]）：safe required —— 投影每次都写这个块，旧键一个不动。
    'carry_over',
    // 恒给出（空时 pins/handoffs=[]）：同上，safe required。
    'constraints',
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
        candidate_name: { type: 'string' },
        job_id: { type: 'string' },
        stage_code: { type: 'string' },
        lifecycle_status: { type: 'string' },
      },
      required: ['mode', 'matched', 'limit'],
      additionalProperties: false,
    },
    // O20：姓名查询多命中 ⇒ 必须问人（不得自己挑一条）。恒给出，不允许缺键。
    needs_human_choice: { type: 'boolean' },
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
  required: [
    'tool', 'contract_version', 'tool_kind', 'labels', 'query', 'needs_human_choice', 'applications', 'next_tools',
  ],
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
 * 一次申请查询：单条（application_id）或列表（candidate_name/job_id/stage/lifecycle 至少一个）。
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
  // O20：按候选人姓名包含匹配。`$n` 与 SQL 两侧都先做空白折叠：SQL 侧对 display_name
  // 做 `\s+ -> ' '`（TS 模板字符串里要写 `\\s`），入参侧由 `normalizeCandidateName` 折好，
  // 再统一 lower 比较 —— 大小写与多余空白都不影响命中。
  const candidateName = typeof args.candidate_name === 'string'
    ? normalizeCandidateName(args.candidate_name)
    : undefined
  if (candidateName !== undefined && candidateName !== '') {
    params.push(candidateName)
    conditions.push(`strpos(regexp_replace(lower(c.display_name), '\\s+', ' ', 'g'), $${params.length}) > 0`)
  }
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
 * AT-1/2/3：跨岗携带历史行（**一次查询取全部申请**，与其它家族事实同一口径）。
 *
 * 只读 `application_carry_over`（append-only 表），租户过滤 + `any($2::uuid[])` 与 queryInterviewRows 同形。
 */
async function queryCarryOverRows(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<CarryOverRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<CarryOverRow>(
    `select application_id, source_application_id, ref_kind, ref_id, carried_by_actor_id, created_at
       from recruitment.application_carry_over
      where tenant_id = $1 and application_id = any($2::uuid[])
      order by application_id, created_at, source_application_id, ref_kind, ref_id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows
}

/** 本批申请下的面试 id（只读；tenant 过滤 + any($2::uuid[])，与 queryInterviewRows 同口径）。 */
async function queryInterviewIdsForApplications(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  applicationIds: readonly string[],
): Promise<string[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<{ id: string }>(
    `select id from recruitment.interview
      where tenant_id = $1 and application_id = any($2::uuid[])
      order by application_id, id`,
    [cfg.tenant_id, [...applicationIds]],
  )
  return rows.map((row) => row.id)
}

/**
 * 候选约束行 → 读投影（纯函数，可单测）。
 *
 * 复用领域层 `toPinProjection` / `toHandoffProjection`（单一实现：过滤 superseded / 墓碑、
 * 排序、只投影四字段）。这里只额外给每条 HANDOFF 挂一个 interview 短号 `interview_ref`
 * ——结构化输出不吐 UUID。墓碑行双保险再过滤一次（领域投影已过滤）。
 * 注意：HANDOFF 排序由领域投影按 created_at 升序给出，这里按同一顺序逐条附上原行的
 * interview_id 短号（同刻多行也稳定：领域投影用 id 做次级排序，但 id 不进输出）。
 * @param pinRows - 该候选人的 PIN 行（含墓碑，投影层过滤）。
 * @param handoffRows - 该申请各 interview 的 HANDOFF 行。
 */
export function toCandidateConstraintsValue(
  pinRows: readonly CandidateConstraintRow[],
  handoffRows: readonly CandidateConstraintRow[],
): CandidateConstraintsValue {
  const pins = toPinProjection(pinRows.filter((row) => row.text !== UNPIN_TOMBSTONE_TEXT))
  // 与 toHandoffProjection 同口径（created_at 升序、同刻按 id）排序后，逐条取 interview 短号。
  const orderedHandoffRows = handoffRows.slice().sort((a, b) => {
    const ta = a.created_at instanceof Date ? a.created_at.getTime() : new Date(a.created_at).getTime()
    const tb = b.created_at instanceof Date ? b.created_at.getTime() : new Date(b.created_at).getTime()
    return ta - tb || String(a.id).localeCompare(String(b.id))
  })
  const handoffs = toHandoffProjection(orderedHandoffRows).map((item, index) => ({
    ...item,
    // HANDOFF 行必带 interview_id（PIN 行才允许 null）；投影与 orderedHandoffRows 同源同序。
    // 非空断言只补类型（编译期擦除），`?.`/`??` 与短号逻辑一行未动。
    interview_ref: shortRef((orderedHandoffRows[index]?.interview_id ?? null)!),
  }))
  return { pins, handoffs }
}

/**
 * 携带历史行 → 输出摘要（纯函数，可单测）。空数组 ⇒ `{count:0, items:[]}`（块不省略）。
 */
export function toCarryOverSummary(rows: readonly CarryOverRow[]): CarryOverValue {
  return {
    count: rows.length,
    items: rows.map((row) => ({
      source_application_id: row.source_application_id,
      ref_kind: row.ref_kind,
      ref_id: row.ref_id,
      carried_by_actor_id: row.carried_by_actor_id,
      // created_at 是 NOT NULL；iso() 万一给 undefined 时用空串，保证输出没有 null（DSH 校验器不支持）。
      created_at: iso(row.created_at) ?? '',
    })),
  }
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
  // O20：姓名过滤的归一化值只算一次（SQL 参数、输出回显、NOT_FOUND 文案共用）。
  const candidateName = typeof args.candidate_name === 'string'
    ? normalizeCandidateName(args.candidate_name)
    : undefined
  const rows = await queryApplicationRows(client, cfg, args)
  if (single !== undefined && rows.length === 0) {
    throw new RecruitmentToolError(
      'NOT_FOUND',
      JSON.stringify({ reason_code: 'APPLICATION_NOT_FOUND', application_id: single }),
    )
  }
  // O20：按姓名查但一条都没有 —— 明确告诉人"没找到这个名字的申请"，不给 shell/文件降级建议，
  // 也绝不返回样例数据。这里只影响"姓名过滤"的列表查询；job/stage/lifecycle 的空列表语义不变。
  if (single === undefined && candidateName !== undefined && rows.length === 0) {
    throw new RecruitmentToolError(
      'NOT_FOUND',
      JSON.stringify({
        reason_code: 'CANDIDATE_NAME_NOT_FOUND',
        candidate_name: candidateName,
        message: `没有找到姓名包含“${candidateName}”的申请。`,
      }),
    )
  }

  const applicationIds = rows.map((row) => row.id)
  const resumeVersionIds = rows
    .map((row) => row.resume_version_id)
    .filter((value): value is string => value !== null)
  // 钉住版本 + 岗位当前版本都取：O12 的 remediation 要同时看两个版本的批准真值。
  const rubricIds = [...new Set(rows.flatMap((row) => [row.pinned_rubric_version_id, row.current_rubric_version_id])
    .filter((value): value is string => value !== null))]

  // 候选人约束读投影：按候选 id 批量取 PIN，按本批申请下的 interview id 批量取 HANDOFF。
  // 只发一次查询（与其余家族事实同口径），墓碑行由领域投影函数过滤。
  const candidateIds = [...new Set(rows.map((row) => row.candidate_id))]
  const [materials, rubrics, interviews, transcripts, scorecards, interviewers, decisions, overrides, carryOver, pins, handoffs] = await Promise.all([
    queryMaterialRows(client, cfg, resumeVersionIds),
    queryRubricRows(client, cfg, rubricIds),
    queryInterviewRows(client, cfg, applicationIds),
    queryTranscriptRows(client, cfg, applicationIds),
    queryScorecardRows(client, cfg, applicationIds),
    queryInterviewerRows(client, cfg, applicationIds),
    queryDecisionRows(client, cfg, applicationIds),
    // 人工纠偏读投影（SELECT-only；full history，调用方只取 current 行）。
    readOverridesForApplications(client, cfg.tenant_id, applicationIds),
    // AT-1/2/3：跨岗携带历史（一次查询取全部申请，按 application_id 分组后挂回去）。
    queryCarryOverRows(client, cfg, applicationIds),
    readPinsForCandidates(client, cfg.tenant_id, candidateIds),
    // 本批申请下的面试 id（一次查询；与 queryInterviewRows 的 tenant 过滤一致）。
    queryInterviewIdsForApplications(client, cfg, applicationIds)
      .then((ids) => readHandoffsForInterviews(client, cfg.tenant_id, ids)),
  ])
  const materialById = new Map(materials.map((row) => [row.id, row]))
  const rubricById = new Map(rubrics.map((row) => [row.id, row]))
  const interviewsByApplication = groupBy(interviews, (row) => row.application_id)
  const transcriptsByApplication = groupBy(transcripts, (row) => row.application_id)
  const scorecardsByApplication = groupBy(scorecards, (row) => row.application_id)
  const interviewersByApplication = groupBy(interviewers, (row) => row.application_id)
  const decisionsByApplication = groupBy(decisions, (row) => row.application_id)
  const currentOverridesByApplication = buildCurrentOverrides(overrides)
  const carryOverByApplication = groupBy(carryOver, (row) => row.application_id)

  // 候选人约束：pins 按 candidate_id、handoffs 按 interview_id→application_id 分组。
  const pinsByCandidate = groupBy(pins, (row) => row.candidate_id)
  const applicationIdByInterview = new Map(interviews.map((row) => [row.id, row.application_id]))
  const handoffsByApplication = new Map<string, CandidateConstraintRow[]>()
  for (const row of handoffs) {
    const applicationId = row.interview_id === null ? undefined : applicationIdByInterview.get(row.interview_id)
    if (applicationId === undefined) continue
    const bucket = handoffsByApplication.get(applicationId)
    if (bucket === undefined) handoffsByApplication.set(applicationId, [row])
    else bucket.push(row)
  }

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
    currentOverridesByApplication.get(row.id) ?? new Map<string, CurrentOverride>(),
    carryOverByApplication.get(row.id) ?? [],
    toCandidateConstraintsValue(
      pinsByCandidate.get(row.candidate_id) ?? [],
      handoffsByApplication.get(row.id) ?? [],
    ),
    visible,
  ))

  // O20：姓名查询命中多条 = 人必须选（不能替人挑"第一条"）。此时 next_tools 必须为空：
  // 任何"拿第一条去读材料/看岗位"的建议都是在暗示可以自作主张。
  const needsHumanChoice = candidateName !== undefined && applications.length > 1

  return {
    tool: APPLICATION_GET_TOOL,
    contract_version: CONTRACT_VERSION,
    tool_kind: 'READ_ONLY',
    labels,
    query: buildApplicationQueryValue(args, applications.length),
    needs_human_choice: needsHumanChoice,
    applications,
    next_tools: needsHumanChoice ? [] : buildNextTools(rows, applications),
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

/**
 * 纠偏全史 → `application_id → criterion_key → 当前行`（确定性）。
 *
 * 只取 `superseded_by_override_id === null` 的 current 行；若同一 (application, criterion) 出现
 * 多条 current（数据库约束理论上阻止，但防御性处理），按 `created_at` 再 `id` 倒序取最新一条，
 * 不抛错。rubric_version 不参与键：一次申请只会钉一版，纠偏的 key 属于那一版。
 */
export function buildCurrentOverrides(
  rows: readonly CriterionOverrideRow[],
): Map<string, Map<string, CurrentOverride>> {
  const byApplication = new Map<string, Map<string, CurrentOverride>>()
  const candidates = rows.filter((row) => row.superseded_by_override_id === null)
  // 先按 created_at/id 升序排，后面同 key 覆盖后写即得到"最新"那条。
  candidates.sort((a, b) => {
    const aTime = a.created_at instanceof Date ? a.created_at.getTime() : new Date(a.created_at).getTime()
    const bTime = b.created_at instanceof Date ? b.created_at.getTime() : new Date(b.created_at).getTime()
    return aTime - bTime || String(a.id).localeCompare(String(b.id))
  })
  for (const row of candidates) {
    let byKey = byApplication.get(row.application_id)
    if (byKey === undefined) {
      byKey = new Map<string, CurrentOverride>()
      byApplication.set(row.application_id, byKey)
    }
    byKey.set(row.criterion_key, {
      criterion_key: row.criterion_key,
      human_state: row.human_state as HumanState | null,
      note: row.note,
      created_at: row.created_at,
      id: row.id,
    })
  }
  return byApplication
}

/** 一次申请 → 输出形状（所有可缺键一律省略，不用 null）。 */
export function toApplicationValue(
  row: ApplicationRow,
  materialById: ReadonlyMap<string, MaterialRow>,
  rubricById: ReadonlyMap<string, RubricRow>,
  interviews: readonly InterviewRow[],
  transcripts: readonly TranscriptRow[],
  scorecards: readonly ScorecardRow[],
  interviewers: readonly InterviewerRow[],
  decisions: readonly DecisionRow[],
  currentOverrides: ReadonlyMap<string, CurrentOverride>,
  carryOver: readonly CarryOverRow[],
  constraints: CandidateConstraintsValue,
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
    carry_over: toCarryOverSummary(carryOver),
    constraints,
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
          // 传本申请的 current override 映射；criteria_summary 仍只取前 8 条（见函数注释）。
          criteria_summary: summarizeRubricCriteria(rubric.dimensions, 8, currentOverrides).criteria_summary,
          ...optional('payload_hash', rubric.payload_hash ?? undefined),
        } as const,
      }),
    ...(material === undefined ? {} : { material: toMaterialSummary(material) }),
  }
}

/**
 * rubric `dimensions` → Agent 判断所需的 criteria 摘要（D-141 ①；纯函数，可单测）。
 *
 * 四条纪律：
 *   1. **只投影已存在的四个键**（key/label/kind/weight），绝不带 question/notes 全文，
 *      也不重算 R-VAL 可执行性 —— 那是 `recruitment_job_get` 的职责（读工具按事实来源分权）；
 *   2. 最多 8 条，但 `criteria_count` 永远是**真实总数**（截断不是隐瞒，缺的键不编造）。
 *      人工纠偏也遵循同一截断：第 9 条以后的 override 不会出现在摘要里（与既有行为一致）；
 *   3. 结构不合法（不是对象 / key 不是字符串）的条目**跳过**，不占摘要位、不伪造 key；
 *   4. `overrides` 省略时五个新键恒为空串（旧单测的默认行为完全不变）；给了映射才填值。
 *
 * AI per-criterion 状态：v1.0 的库里**没有任何表/列持久化 AI 对单条标准的判断**
 * （`screening_evaluation` 存整份评估摘要，不是逐条状态），所以 `ai_state` 恒空串；
 * 不编造数据，字段只为前向兼容存在。将来若落库，在调用方把值传进来即可。
 * @param dimensions - `rubric_version.dimensions`（jsonb，不能假设形状）。
 * @param maxItems - 摘要最多几条（默认 8）。
 * @param overrides - 可选：`criterion_key → 当前 override 行`；未提供时五个新键全空串。
 * @returns `{ criteria_summary, criteria_count }`。
 */
export function summarizeRubricCriteria(
  dimensions: unknown,
  maxItems = 8,
  overrides?: ReadonlyMap<string, CurrentOverride>,
): { criteria_summary: readonly CriteriaSummaryItemValue[]; criteria_count: number } {
  const list = asArray(dimensions)
  const summary: CriteriaSummaryItemValue[] = []
  for (const raw of list) {
    if (summary.length >= maxItems) break
    const record = asRecord(raw)
    if (record === null) continue
    const key = asString(record.key)
    if (key === undefined) continue
    const label = asString(record.label)
    const kind = asString(record.kind)
    const weight = asNumber(record.weight)
    // ai_state：v1.0 没有 AI 逐条状态列，恒 null（→ 空串）；不编造。
    const aiState: string | null = null
    const current = overrides?.get(key)
    // CurrentOverride.human_state 已是 HumanState | null，但用类型守卫收窄，
    // 防止将来有人放宽类型时把任意字符串塞进 effectiveState 的闭集入参。
    const rawHuman = current?.human_state ?? null
    const humanState: HumanState | null =
      rawHuman === 'PRESENT' || rawHuman === 'ABSENT' || rawHuman === 'UNREADABLE' ? rawHuman : null
    const effective = effectiveState(aiState, humanState)
    summary.push({
      key,
      ...(label === undefined ? {} : { label }),
      ...(kind === undefined ? {} : { kind }),
      ...(weight === undefined ? {} : { weight }),
      // 只有显式传了 overrides 映射才展开五个新键：toApplicationValue 恒传（哪怕是空 Map），
      // 直接调用（既有单测）不传 → 旧形状逐字不变。
      ...(overrides === undefined
        ? {}
        : {
          ai_state: aiState ?? '',
          human_state: humanState ?? '',
          effective_state: effective ?? '',
          override_note: current?.note ?? '',
          overridden_at: current === undefined ? '' : iso(current.created_at) ?? '',
        }),
    } as CriteriaSummaryItemValue)
  }
  return { criteria_summary: summary, criteria_count: list.length }
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
  const candidateName = typeof args.candidate_name === 'string'
    ? normalizeCandidateName(args.candidate_name)
    : undefined
  return {
    mode: single === undefined ? 'LIST' : 'ONE',
    matched,
    limit: single === undefined ? (typeof args.limit === 'number' ? args.limit : 10) : 1,
    ...optional('application_id', single),
    ...optional('candidate_name', candidateName),
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
    reason: 'Only when you need the full criterion text (question/notes), the JD body, or R-VAL executability / '
      + 'absence reasons: application_get already gives each pinned criterion\'s key/label/kind/weight.',
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
 *
 * O20：`candidate_name` 在这里就归一化（trim + 空白折叠 + 小写），并把"归一化后为空"当成
 * 明确的 `CANDIDATE_NAME_EMPTY` 拒掉 —— 否则一个全空白姓名会被误报成 `MISSING_FILTER`，
 * 或（更糟）在 SQL 里退化成"匹配所有候选人"。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参（`candidate_name` 为归一化值）。
 */
export function parseApplicationGetArgs(raw: unknown): Record<string, unknown> {
  // 空串 `''` 会被 parseArgs 的通用非空校验先拒（仍是 INVALID_ARGS），这里让
  // `'' / '   ' / ' \t '` 三种都得到同一个 CANDIDATE_NAME_EMPTY 口径。
  const rawRecord = asRecord(raw)
  const rawCandidateName = rawRecord?.candidate_name
  if (typeof rawCandidateName === 'string' && normalizeCandidateName(rawCandidateName) === '') {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: 'CANDIDATE_NAME_EMPTY',
        message: 'candidate_name has no visible characters after trimming whitespace; '
          + 'pass the candidate name as the human said it (for example "张三").',
      }),
    )
  }
  const args = parseArgs(APPLICATION_GET_PARAMS, raw)
  if (typeof args.candidate_name === 'string') {
    args.candidate_name = normalizeCandidateName(args.candidate_name)
  }
  const single = args.application_id as string | undefined
  const filters = (['candidate_name', 'job_id', 'stage_code', 'lifecycle_status'] as const)
    .filter((key) => args[key] !== undefined)
  if (single === undefined && filters.length === 0) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: 'MISSING_FILTER',
        message: 'pass application_id, or at least one of candidate_name / job_id / stage_code / lifecycle_status',
      }),
    )
  }
  if (single !== undefined && filters.length > 0) {
    throw new RecruitmentToolError(
      'INVALID_ARGS',
      JSON.stringify({
        reason_code: 'MUTUALLY_EXCLUSIVE',
        message: 'application_id cannot be combined with candidate_name / job_id / stage_code / lifecycle_status',
        detail: { unexpected: filters },
      }),
    )
  }
  return args
}

/**
 * render 用短号：只取 id 末 4 位（`…0701`）。完整 id 仍在结构化值里；
 * render 正文不给完整 UUID —— O1：模型会把 render 里的 UUID 原样写给 HR。
 */
function shortRef(id: string): string {
  return id.length <= 4 ? id : `…${id.slice(-4)}`
}

/** render 用短 hash：前 8 位 + `…`（与 `job_get` render 的 `hash=aba19e40…` 同口径）。 */
function shortHash(hash: string): string {
  return hash.length <= 8 ? hash : `${hash.slice(0, 8)}…`
}

/** 材料字段名 → 人话（只用于 render；结构化键仍是 name/phone/...）。 */
const MATERIAL_FIELD_LABELS: Readonly<Record<string, string>> = {
  name: '姓名',
  phone: '电话',
  email: '邮箱',
  work_experience: '工作经历',
  education: '教育经历',
}

/**
 * 字段三态 → 事实陈述（O1：`name=absent` 不能被写成"请 HR 补录/更新结构化结果"）。
 * absent/unreadable 都只陈述材料事实，不给任何"下一步"指令。
 */
function materialFieldFact(state: string): string {
  if (state === 'present') return '已从这份材料里读到'
  if (state === 'absent') return '未能从这份材料里读出来（材料事实）'
  return '这份材料里写了，但这次没读出来（材料事实）'
}

/** `recruitment_application_get` 的模型可见 render。 */
function renderApplicationGet(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as ApplicationGetValue
  const candidateNamePart = v.query.candidate_name === undefined
    ? ''
    : ` candidate_name=${v.query.candidate_name}`
  // O1：query 行不回显完整 UUID（结构化 query.application_id 仍是完整值）。
  const applicationIdPart = v.query.application_id === undefined
    ? ''
    : ` 申请=${shortRef(v.query.application_id)}`
  const lines: string[] = [
    `${v.tool} read-only (${v.contract_version}) labels=${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`,
    `query: ${v.query.mode} matched=${v.query.matched}${applicationIdPart}${candidateNamePart}`,
  ]
  // O20：多命中必须问人。这行是给模型看的最后一道明示（结构上 next_tools 也已清空）。
  if (v.needs_human_choice) {
    lines.push(
      `needs human choice: ${v.query.matched} applications match candidate `
        + `"${v.query.candidate_name ?? ''}"; ask the human which one — do not pick one automatically`,
    )
  }
  for (const application of v.applications) {
    // O1：申请行给业务标识（候选人显示名 + 岗位 + 阶段）；只有显示名为空才退回短号。
    const displayName = application.candidate.display_name.trim()
    const applicationLine = displayName === ''
      ? `申请 ${shortRef(application.application_id)} · ${application.job.code} ${application.job.title} `
        + `· 阶段 ${application.stage_code}（${application.lifecycle_status}, record_version=${application.record_version}）`
      : `申请：${displayName} · ${application.job.code} ${application.job.title} `
        + `· 阶段 ${application.stage_code}（${application.lifecycle_status}, record_version=${application.record_version}）`
    lines.push(
      applicationLine,
      // O1：候选人行不给 candidate_id（UUID）；结构化 application.candidate 仍保留完整值。
      `  候选人：${displayName === '' ? '（显示名未录入）' : displayName} `
        + `identity_status=${application.candidate.identity_status} contacts=${application.candidate.contacts.email} `
        + `${application.candidate.contacts.phone} (visible=${String(application.candidate.contacts.visible)})`,
      `  岗位：${application.job.code} ${application.job.title} status=${application.job.status}`,
    )
    if (application.rubric !== undefined) {
      // O1：版本号给人话，UUID 只留短号（结构化 rubric.rubric_version_id 仍是完整值）。
      lines.push(
        `  rubric: v${application.rubric.version_no} (source=${application.rubric.source}, `
          + `approved=${String(application.rubric.approved)}, criteria=${application.rubric.criteria_count}, `
          + `版本号 ${shortRef(application.rubric.rubric_version_id)})`,
      )
      // D-141 ①：criteria 摘要（key/kind/weight，最多 8 条）—— 判断"这条路能不能跑"不必再调 job_get；
      // question/notes 全文仍归 recruitment_job_get。
      const summary = application.rubric.criteria_summary ?? []
      if (summary.length > 0) {
        const parts = summary.map((item) => {
          const kind = item.kind === undefined ? '' : ` [${item.kind}]`
          const weight = item.weight === undefined ? '' : ` w=${item.weight}`
          const label = item.label === undefined ? '' : ` ${item.label}`
          return `${item.key}${kind}${weight}${label}`
        })
        const truncated = application.rubric.criteria_count > summary.length
          ? ` …(+${application.rubric.criteria_count - summary.length} more)`
          : ''
        lines.push(`    criteria: ${parts.join('; ')}${truncated}`)
      }
    } else {
      lines.push('  rubric: (none pinned; call recruitment_job_get to see why)')
    }
    if (application.material !== undefined) {
      const asset = application.material.asset
      lines.push(
        `  material: resume_version=${shortRef(application.material.resume_version_id)} `
          + `parse_status=${application.material.parse_status} pages=${application.material.pages} `
          + `hard_issues=${application.material.hard_issue_codes.length}`,
        asset === undefined
          ? '    asset: (none linked)'
          : `    asset: ${shortRef(asset.intake_asset_id)} ${asset.file_name} ${asset.byte_size}B `
            + `sha256=${shortHash(asset.sha256)} (${asset.validation_status})`,
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
      // AT-1/2/3：从哪些申请带了什么（短号，不给完整 UUID；完整值仍在结构化 carry_over.items）。
      `  carry_over: ${application.carry_over?.count ?? 0} [${(application.carry_over?.items ?? [])
        .map((item) => `R${item.ref_kind} from ${shortRef(item.source_application_id)}`).join(', ')}]`,
      // 候选人约束：只给计数短摘要（不吐完整 id / 文本全文；全文在结构化 constraints.*）。
      `  constraints: ${application.constraints?.pins.length ?? 0} 条置顶 / `
        + `${application.constraints?.handoffs.length ?? 0} 条交接`,
    )
  }
  if (v.next_tools.length > 0) {
    // 机器参数区：模型要原样复制 args 才能调下游工具；但 id/hash 只给工具看，不给 HR 看。
    lines.push('next tools (machine arguments — copy verbatim into tool calls; never show ids or hashes to the human):')
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
      + 'TEXT: additionally return bounded, contact-redacted, LOCATABLE verbatim citations of the source '
      + 'document (each with locator_kind + page/paragraph/line/offset + the verbatim quote + the verified '
      + 'pinned source sha256). If the original bytes are readable but no locatable quote can be produced, '
      + 'text.reason_code is MATERIAL_ORIGINAL_NOT_LOCATED instead of pretending success.',
  },
  max_chars: {
    kind: 'integer',
    min: 200,
    max: 8000,
    description: 'TEXT mode only: maximum total characters of the returned citations (200..8000, default 2000).',
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
  /**
   * 原文读到了，但**做不出可定位的逐字引文**（读取器没给可用的块/定位器，或全部可引用块都因
   * 联系方式脱敏被剔除）。语义 = "没拿到可复核的原文证据"，**绝不**把它标成 `OK` 假成功。
   */
  | 'MATERIAL_ORIGINAL_NOT_LOCATED'

const TEXT_REASON_CODES: readonly TextReasonCode[] = [
  'OK', 'NOT_REQUESTED', 'CONVERTER_NOT_CONFIGURED', 'NO_ALLOWED_ROOTS',
  'NOT_FOUND_IN_ALLOWED_ROOTS', 'SEARCH_BUDGET_EXCEEDED', 'ASSET_MISSING', 'ASSET_INVALID',
  'READER_FAILED', 'HASH_MISMATCH', 'MATERIAL_ORIGINAL_NOT_LOCATED',
]

/**
 * 引文定位器种类（**D-110 的联合类型**，逐字取 `contracts/identity/identity-resolution-rules.md` §定位器联合类型）：
 *   * `pdf_page_bbox`         PDF：page（+ bbox）
 *   * `docx_part_paragraph`   DOCX 段落：part + paragraph_id（paragraph 数值从 `pN` 解析，0-based）
 *   * `docx_part_table_row`   DOCX 表格单元格：part + table_id + row（+ cell）
 *   * `rtf_paragraph`         RTF：paragraph（0-based 读取器块序号；读取器给了 page 才带）
 *   * `text_line_offset`      无结构定位器时的纯文本兜底：line（1-based 全文行号）+ offset（0-based 字符偏移）
 */
type CitationLocatorKind =
  | 'pdf_page_bbox'
  | 'docx_part_paragraph'
  | 'docx_part_table_row'
  | 'rtf_paragraph'
  | 'text_line_offset'

/**
 * 输出：一条**可定位的逐字引文**（D-141 ⑧ + D-110）。
 *
 * 三条件都成立才会产出（否则整条不产出，绝不假成功）：
 *   1. 原文可核：`source_sha256` = 本次实际读到的原件字节 sha256，且与库里钉住的期望值一致
 *      （调用方在 `buildMaterialTextValue` 里先比对，不一致直接 `HASH_MISMATCH`）；
 *   2. 定位唯一：`locator_kind` + 对应字段由**读取器自己的块定位器**原样投影（不重算、不猜）；
 *      需要 `text_line_offset` 兜底时，只接受 quote 在全文**唯一命中**（多处命中 → 不产出，禁止取第一条）；
 *   3. 原句逐字命中：`quote` 就是读取器该块的**原文文本**（未做任何改写/归一化）；
 *      含联系方式的块**整块跳过**（脱敏会破坏逐字性，所以宁可不给引文）。
 */
interface TextCitationValue {
  /** 1-based，按阅读顺序（读取器块的 `order`）编号。 */
  readonly seq: number
  readonly locator_kind: CitationLocatorKind
  /** `LOCATOR_UNIQUE+…` = 由读取器定位器唯一确定；`QUOTE_UNIQUE+…` = 无结构定位器时由 quote 唯一命中反推。 */
  readonly verification_method:
    | 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE'
    | 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE'
  readonly source_sha256: string
  readonly quote: string
  readonly quote_chars: number
  /** quote 因 `max_chars` 预算被截断（是原文前缀，仍是逐字子串）。 */
  readonly quote_truncated: boolean
  /**
   * 同一句在**全文**里出现多处（>1）。此时结构定位器仍唯一（page/paragraph/block_id），
   * 但 quote 本身不足以唯一定位 → 不输出 line/offset，交由下游按 D-110 判歧义强度。
   */
  readonly quote_multi_hit: boolean
  readonly block_id?: string
  readonly page?: number
  readonly bbox?: number[]
  readonly part?: string
  readonly paragraph?: number
  readonly paragraph_id?: string
  readonly table_id?: string
  readonly row?: number
  readonly cell?: number
  /** 1-based 全文行号（仅在 quote 全文唯一命中时给出）。 */
  readonly line?: number
  /** 0-based 全文字符偏移（仅在 quote 全文唯一命中时给出）。 */
  readonly offset?: number
}

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
  /**
   * TEXT 模式下的有界正文 = 各条引文的 quote 以换行拼接（总长 ≤ max_chars）；
   * 引文为空时不返回（不拿"整篇原文"冒充可定位证据）。
   */
  readonly excerpt?: string
  readonly media_type?: string
  readonly reader_id?: string
  readonly asset_sha256_verified?: boolean
  /** 可定位逐字引文（按阅读顺序，最多受 max_chars 预算约束）。 */
  readonly citations?: readonly TextCitationValue[]
  readonly citation_count?: number
  /** 有结构定位器但 quote 全文多处命中的引文条数（D-110：下游按歧义强度处理）。 */
  readonly multi_hit_citation_count?: number
  /** 因为没有可用定位器、且 quote 不能唯一命中而被**整条丢弃**的候选块数（禁止取第一条）。 */
  readonly ambiguous_citation_count?: number
  /** 因为含联系方式（脱敏会破坏逐字性）而被整块跳过的块数。 */
  readonly omitted_contact_blocks?: number
  /** 是否因 `max_chars` 预算而少给了引文（原文比这次返回的长）。 */
  readonly citations_truncated?: boolean
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
        // D-141 ⑧：可定位逐字引文（每条带 D-110 的 locator_kind + 定位值 + 逐字 quote + 原件 sha256）。
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              seq: { type: 'number' },
              locator_kind: {
                type: 'string',
                enum: [
                  'pdf_page_bbox', 'docx_part_paragraph', 'docx_part_table_row',
                  'rtf_paragraph', 'text_line_offset',
                ],
              },
              verification_method: {
                type: 'string',
                enum: ['LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE', 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE'],
              },
              source_sha256: { type: 'string' },
              quote: { type: 'string' },
              quote_chars: { type: 'number' },
              quote_truncated: { type: 'boolean' },
              quote_multi_hit: { type: 'boolean' },
              block_id: { type: 'string' },
              page: { type: 'number' },
              bbox: { type: 'array', items: { type: 'number' } },
              part: { type: 'string' },
              paragraph: { type: 'number' },
              paragraph_id: { type: 'string' },
              table_id: { type: 'string' },
              row: { type: 'number' },
              cell: { type: 'number' },
              line: { type: 'number' },
              offset: { type: 'number' },
            },
            required: [
              'seq', 'locator_kind', 'verification_method', 'source_sha256',
              'quote', 'quote_chars', 'quote_truncated', 'quote_multi_hit',
            ],
            additionalProperties: false,
          },
        },
        citation_count: { type: 'number' },
        multi_hit_citation_count: { type: 'number' },
        ambiguous_citation_count: { type: 'number' },
        omitted_contact_blocks: { type: 'number' },
        citations_truncated: { type: 'boolean' },
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

/** 时长/预算：TEXT 引文总字符上限（`max_chars` 的默认值）。 */
const DEFAULT_MAX_CHARS = 2_000

/** 把 DOCX 的 paragraph_id（`p12`）解析成数值（0-based；解析不了就不给 `paragraph`，不猜）。 */
function docxParagraphIndex(paragraphId: string | undefined): number | undefined {
  if (paragraphId === undefined) return undefined
  const match = /^p(\d+)$/.exec(paragraphId)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** 一个块在输出里可用的定位器（不可用 = 没有可复核定位，返回 null）。 */
function citationLocatorOf(block: DocumentBlock): {
  readonly locator_kind: CitationLocatorKind
  readonly page?: number
  readonly bbox?: number[]
  readonly part?: string
  readonly paragraph?: number
  readonly paragraph_id?: string
  readonly table_id?: string
  readonly row?: number
  readonly cell?: number
} | null {
  const locator = block.locator
  switch (locator.kind) {
    case 'pdf': {
      // 契约要求 PDF 定位 page ≥ 1；哨兵 0（读取器没给页码）不能拿来当引文定位。
      if (!Number.isInteger(locator.page) || locator.page < 1) return null
      return {
        locator_kind: 'pdf_page_bbox',
        page: locator.page,
        ...(locator.bbox === undefined ? {} : { bbox: [...locator.bbox] }),
      }
    }
    case 'rtf': {
      if (locator.paragraph === undefined) return null
      return {
        locator_kind: 'rtf_paragraph',
        paragraph: locator.paragraph,
        ...(locator.page === undefined ? {} : { page: locator.page }),
      }
    }
    case 'docx': {
      if (locator.table_id !== undefined) {
        return {
          locator_kind: 'docx_part_table_row',
          part: locator.part,
          table_id: locator.table_id,
          ...(locator.row === undefined ? {} : { row: locator.row }),
          ...(locator.cell === undefined ? {} : { cell: locator.cell }),
        }
      }
      if (locator.paragraph_id === undefined) return null
      const paragraph = docxParagraphIndex(locator.paragraph_id)
      return {
        locator_kind: 'docx_part_paragraph',
        part: locator.part,
        paragraph_id: locator.paragraph_id,
        ...(paragraph === undefined ? {} : { paragraph }),
      }
    }
    case 'image':
      // 图片块没有可逐字复核的文本层；不伪造引文（OCR 文字也不得标成 native_text）。
      return null
    default:
      return null
  }
}

/** 统计 needle 在 haystack 里出现的次数（逐字、非语义；用于 D-110 的"唯一命中"判定）。 */
function countLiteralOccurrences(haystack: string, needle: string): number {
  if (needle === '' || haystack === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return count
    count += 1
    from = at + 1
  }
}

/** 1-based 全文行号（按 `\n` 计；offset 之前的换行数 + 1）。 */
function lineAt(text: string, offset: number): number {
  let line = 1
  const end = Math.min(offset, text.length)
  for (let index = 0; index < end; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * `DocumentContent` → TEXT 模式的**可定位逐字引文**（纯函数；单测直接喂内容，不碰文件/库）。
 *
 * 为什么这样切（D-141 ⑧ + D-110）：
 *   * 业务复核要的是"第 N 页/第 N 行：'原句…'"，不是"整篇原文"——所以按读取器**块**产出引文，
 *     每块一条，带它自己的定位器；`max_chars` 是**引文总字符上限**（含分隔符），绝不整篇灌给模型；
 *   * 原句逐字：`quote` 就是块的原文文本；含联系方式的块整块跳过（脱敏会破坏逐字性，宁可不给）；
 *   * 定位唯一：结构定位器由读取器给（pdf page / rtf paragraph / docx part+paragraph），
 *     没有结构定位器时只接受 quote **全文唯一命中**的兜底；多处命中且无结构定位器 → 整条丢弃
 *     （D-110：命中多处 = 歧义，禁止取第一条）；
 *   * 拿不到就如实报：一条引文都产不出 → `available=false` + `MATERIAL_ORIGINAL_NOT_LOCATED`，
 *     不拿 excerpt 冒充成功。
 * @param content - 读取器产物（blocks 带定位器；text 是读取器全文）。
 * @param expectedSha - 库里钉住的原件 sha256（与 `content.asset_sha256` 不一致 = 读到的不是这份材料）。
 * @param maxChars - 引文总字符上限（含引文之间的换行分隔符）。
 * @returns `TextValue`（TEXT 模式）。
 */
export function buildMaterialTextValue(
  content: Pick<DocumentContent, 'text' | 'blocks' | 'asset_sha256' | 'media_type' | 'reader_id'>,
  expectedSha: string,
  maxChars: number,
): TextValue {
  const empty: TextValue = {
    mode: 'TEXT',
    available: false,
    reason_code: 'MATERIAL_ORIGINAL_NOT_LOCATED',
    source_chars: content.text.length,
    excerpt_chars: 0,
    truncated: false,
  }
  // 原件哈希必须与库里钉住的值一致：不一致说明"读到的不是这份材料"，绝不返回正文。
  if (content.asset_sha256 !== expectedSha) {
    return { ...empty, reason_code: 'HASH_MISMATCH' }
  }

  const budget = Math.max(1, maxChars)
  const blocks = [...content.blocks].sort((left, right) => left.order - right.order)
  const citations: TextCitationValue[] = []
  const excerptParts: string[] = []
  let used = 0
  let omittedContactBlocks = 0
  let ambiguousCitations = 0
  let citationsTruncated = false

  for (const block of blocks) {
    const quoteSource = block.text
    if (quoteSource.trim() === '') continue
    // 联系方式块整块跳过：引文必须逐字，脱敏后的字符串就不再是原文。
    if (redactContactPatterns(quoteSource) !== quoteSource) {
      omittedContactBlocks += 1
      continue
    }
    const locator = citationLocatorOf(block)
    const occurrences = countLiteralOccurrences(content.text, quoteSource)
    const uniqueOffset = occurrences === 1 ? content.text.indexOf(quoteSource) : undefined
    // 没有结构定位器时必须靠 quote 唯一命中；多处命中 = 歧义 → 整条丢弃（禁止取第一条）。
    if (locator === null && uniqueOffset === undefined) {
      ambiguousCitations += 1
      continue
    }
    let quote = quoteSource
    let quoteTruncated = false
    const separator = citations.length === 0 ? 0 : 1
    if (used + separator + quote.length > budget) {
      if (citations.length === 0) {
        // 第一条就超预算：按预结算截断（仍是原文前缀，仍是逐字子串），并如实标 truncated。
        const room = budget - used - separator
        if (room <= 0) {
          citationsTruncated = true
          break
        }
        quote = quote.slice(0, room)
        quoteTruncated = true
      } else {
        citationsTruncated = true
        break
      }
    }
    used += separator + quote.length
    excerptParts.push(quote)
    const resolvedLocator = locator === null
      ? { locator_kind: 'text_line_offset' as const }
      : locator
    citations.push({
      seq: citations.length + 1,
      locator_kind: resolvedLocator.locator_kind,
      verification_method: locator === null
        ? 'QUOTE_UNIQUE+SHA256+LITERAL_QUOTE'
        : 'LOCATOR_UNIQUE+SHA256+LITERAL_QUOTE',
      source_sha256: content.asset_sha256,
      quote,
      quote_chars: quote.length,
      quote_truncated: quoteTruncated,
      quote_multi_hit: occurrences > 1,
      ...(block.block_id === undefined ? {} : { block_id: block.block_id }),
      ...(resolvedLocator.page === undefined ? {} : { page: resolvedLocator.page }),
      ...(resolvedLocator.bbox === undefined ? {} : { bbox: resolvedLocator.bbox }),
      ...(resolvedLocator.part === undefined ? {} : { part: resolvedLocator.part }),
      ...(resolvedLocator.paragraph === undefined ? {} : { paragraph: resolvedLocator.paragraph }),
      ...(resolvedLocator.paragraph_id === undefined ? {} : { paragraph_id: resolvedLocator.paragraph_id }),
      ...(resolvedLocator.table_id === undefined ? {} : { table_id: resolvedLocator.table_id }),
      ...(resolvedLocator.row === undefined ? {} : { row: resolvedLocator.row }),
      ...(resolvedLocator.cell === undefined ? {} : { cell: resolvedLocator.cell }),
      // line/offset 只在 quote 全文唯一命中时给：多处命中时它们会变成"指向第一条"的假定位。
      ...(uniqueOffset === undefined ? {} : { offset: uniqueOffset, line: lineAt(content.text, uniqueOffset) }),
    })
  }

  if (citations.length === 0) {
    return {
      ...empty,
      // 读到了原文（块/全文都可能非空），但没有一条能定位 → 按"没拿到可复核原文"如实报。
      ...(omittedContactBlocks === 0 ? {} : { omitted_contact_blocks: omittedContactBlocks }),
      ...(ambiguousCitations === 0 ? {} : { ambiguous_citation_count: ambiguousCitations }),
    }
  }

  const excerpt = excerptParts.join('\n')
  const multiHit = citations.filter((citation) => citation.quote_multi_hit).length
  return {
    mode: 'TEXT',
    available: true,
    reason_code: 'OK',
    source_chars: content.text.length,
    excerpt_chars: excerpt.length,
    truncated: citationsTruncated || citations.some((citation) => citation.quote_truncated),
    excerpt,
    media_type: content.media_type,
    reader_id: content.reader_id,
    asset_sha256_verified: true,
    citations,
    citation_count: citations.length,
    ...(multiHit === 0 ? {} : { multi_hit_citation_count: multiHit }),
    ...(ambiguousCitations === 0 ? {} : { ambiguous_citation_count: ambiguousCitations }),
    ...(omittedContactBlocks === 0 ? {} : { omitted_contact_blocks: omittedContactBlocks }),
    ...(citationsTruncated ? { citations_truncated: true } : {}),
  }
}

/**
 * TEXT 模式：定位原件（allowed_roots + sha256）→ 受控读取 → 有界**可定位引文**。
 *
 * 纪律：定位只用 `resolveMaterialPath`（预算 + 缓存 + 根内校验）；读取只用
 * `readDocumentDetailed`（内部再验 allowed_roots，并给出原件 `asset_sha256`）；
 * 两者任一不成立就 `available=false` + 闭集 reason_code，**绝不**返回"看起来正常"的片段。
 * 判据一律在 `buildMaterialTextValue()`（纯函数，可单测）：哈希不符 → HASH_MISMATCH；
 * 读取成功但产不出可定位引文 → MATERIAL_ORIGINAL_NOT_LOCATED（不拿 excerpt 冒充成功）。
 * @param row - 材料行（含原件事实）。
 * @param converter - converter 配置（未配置时 TEXT 不可用，如实报 CONVERTER_NOT_CONFIGURED）。
 * @param maxChars - 引文总字符上限。
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
    return buildMaterialTextValue(outcome.content, expectedSha, maxChars)
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
    // O1：resume_version 只留短号（结构化 query.resume_version_id 仍是完整值）。
    `query: ${v.query.mode} from ${v.query.source} resume_version=${shortRef(meta.resume_version_id)}`,
    `material: parse_status=${meta.parse_status} pages=${meta.pages} reader=${meta.reader_backend}@${meta.reader_version}`,
  ]
  if (v.material.asset !== undefined) {
    const asset = v.material.asset
    lines.push(
      `  asset: ${shortRef(asset.intake_asset_id)} ${asset.file_name} ${asset.byte_size}B `
        + `sha256=${shortHash(asset.sha256)} (${asset.validation_status}, ref=${asset.storage_ref_kind})`,
    )
  } else {
    lines.push('  asset: (none linked: the material row has no intake_asset)')
  }
  lines.push(
    `  hashes: source_asset_sha256=${shortHash(meta.source_asset_sha256 ?? '')} `
      + `content_sha256=${shortHash(meta.content_sha256 ?? '')}`,
    `  contacts: email=${v.material.contacts.email} phone=${v.material.contacts.phone} `
      + `(visible=${String(v.material.contacts.visible)})`,
    // O1：字段三态改成"材料事实"陈述（不写成"请 HR 补录/更新结构化结果"）；结构化 field_locators 不变。
    `  材料字段：${v.material.structure.field_locators
      .map((item) => `${MATERIAL_FIELD_LABELS[item.field] ?? item.field}：${materialFieldFact(item.state)}`)
      .join('；')}`,
    `  entries: ${v.material.structure.entries.length} (work/education header lines with locators)`,
    `  issues: ${v.material.structure.issues.count} (hard ${v.material.structure.issues.hard_count}: `
      + `${v.material.structure.issues.hard_codes.join(',') || 'none'})`,
  )
  if (v.material.structure.timeline !== undefined) {
    const t = v.material.structure.timeline
    lines.push(`  timeline: ${t.intervals} intervals, ${t.covered_months_closed} covered months (closed)`)
  }
  lines.push(`text (${v.text.mode}): available=${String(v.text.available)} reason=${v.text.reason_code} `
    + `source_chars=${v.text.source_chars} excerpt_chars=${v.text.excerpt_chars} truncated=${String(v.text.truncated)}`
    + (v.text.citation_count === undefined ? '' : ` citations=${v.text.citation_count}`)
    + (v.text.asset_sha256_verified === true ? ' sha256_verified=true' : ''))
  const citations = v.text.citations ?? []
  if (citations.length > 0) {
    // D-141 ⑧：模型可见的**可定位逐字引文**；render 不给完整 sha/id（O1），结构化值里才有。
    lines.push('--- source citations (verbatim, contact-redacted; verified against the pinned source sha256) ---')
    for (const citation of citations) {
      const where: string[] = []
      if (citation.page !== undefined) where.push(`page ${citation.page}`)
      if (citation.paragraph !== undefined) where.push(`paragraph ${citation.paragraph}`)
      // O1：paragraph_id / table_id 是读取器块的内部 id（新实现里是完整 UUID），人读正文只给短号；
      // 完整值仍在结构化 `text.citations[]` 里（下游按 D-110 定位要用）。人类可读的
      // `paragraph` 数值（0-based）与 row/cell/line/offset 照旧给全。
      if (citation.paragraph_id !== undefined) where.push(`paragraph_id ${shortRef(citation.paragraph_id)}`)
      if (citation.table_id !== undefined) {
        where.push(`table ${shortRef(citation.table_id)} row ${citation.row ?? '?'} cell ${citation.cell ?? '?'}`)
      }
      if (citation.line !== undefined) where.push(`line ${citation.line}`)
      if (citation.offset !== undefined) where.push(`offset ${citation.offset}`)
      const flags = [
        ...(citation.quote_truncated ? ['TRUNCATED'] : []),
        ...(citation.quote_multi_hit ? ['MULTI_HIT(quote appears more than once)'] : []),
      ].join(', ')
      lines.push(
        `  [${citation.seq}] ${citation.locator_kind} ${where.join(' · ')} — 「${citation.quote}」`
          + (flags === '' ? '' : ` (${flags})`),
      )
    }
    lines.push('--- end citations ---')
  } else if (v.text.excerpt !== undefined) {
    // 兼容：没有引文但有正文（旧形状）时仍给单段正文；新实现只在有引文时给 excerpt。
    lines.push('--- source excerpt (contact-redacted, verified sha256) ---', v.text.excerpt, '--- end excerpt ---')
  }
  if (v.text.available === false && v.text.reason_code === 'MATERIAL_ORIGINAL_NOT_LOCATED') {
    lines.push(
      'note: the original bytes were readable, but no locatable verbatim quote could be produced '
        + '(no usable reader block locator, or all quotable blocks contain contact details). '
        + 'Report this as MATERIAL_ORIGINAL_NOT_LOCATED — do not claim a page/line you do not have.',
    )
  }
  if (v.next_tools.length > 0) {
    // 机器参数区：模型要原样复制 args 才能调下游工具；但 id/hash 只给工具看，不给 HR 看。
    lines.push('next (machine arguments — copy verbatim into tool calls; never show ids or hashes to the human):')
    for (const hint of v.next_tools) lines.push(`  ${hint.name} ${hint.args_json} — ${hint.reason}`)
  }
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
      + 'job code/title/status, pinned rubric version pointer (approved flag, criteria count, '
      + 'criteria key/label/kind/weight summary — enough to judge whether screening can proceed, payload hash), '
      + 'material summary (resume_version, parse_status, pages, hard issue codes, source file sha256), '
      + 'interviews, transcript counts, scorecard counts and the latest decision. Every block carries its '
      + 'source id; missing facts are omitted, never invented; an unknown application_id returns NOT_FOUND. '
      // O20：可发现性靠这段 —— HR 说"候选人张样例这次申请"时模型必须想到用 candidate_name，而不是去搜文件。
      + 'When the human names a candidate instead of giving a UUID, pass candidate_name to find applications by '
      + 'display name: containment match, case-insensitive and whitespace-insensitive, list mode only. '
      + 'Multiple matches return needs_human_choice=true with an empty next_tools — you MUST ask the human which '
      + 'application to use and never pick one automatically. Zero matches return NOT_FOUND / '
      + 'CANDIDATE_NAME_NOT_FOUND; in that case do not fall back to shell, file or database searches — ask the '
      + 'human to confirm the name or give the application id directly. '
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
      + 'mode=SUMMARY (default) returns no source text; mode=TEXT additionally returns bounded '
      + '(max_chars total, default 2000), contact-redacted, LOCATABLE verbatim citations: every citation carries '
      + 'a D-110 locator_kind (pdf_page_bbox / docx_part_paragraph / docx_part_table_row / rtf_paragraph / '
      + 'text_line_offset), its page/paragraph/line/offset values, the verbatim quote, and the pinned source '
      + 'sha256 it was verified against. That is what a business review quotes as "page N / line N: the exact '
      + 'sentence". If the original bytes are found and hash-verified but no locatable quote can be produced, '
      + 'text.available is false with reason_code MATERIAL_ORIGINAL_NOT_LOCATED (never a fake success). '
      + 'Never search the filesystem or read the resume with shell/file tools.'
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

