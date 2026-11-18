// 企业自建配置（tenant-config）的领域实现：角色 / 招聘团队 / 流水线模板。
//
// 一句话：**配置是数据，不是代码**。本文件不写死任何一家企业的组织或流程，
// 只提供"企业自己建"的那三条最小写路径 + 读路径，并把该拦的东西**服务端**拦住。
//
// 权威来源：
//   * 用户裁决（2026-11-14）：每个企业情况都不一样，把通用后端做好，企业自己创建。
//   * `docs/03-domain-and-runtime.md` §1 配置类对象：User / Role、Pipeline Template、
//     Stage、Interview Template（Stage Activity Template 与 Offer / Talent Pool 仍缓做，
//     `db/verify.sql:311-315` 的 DEFERRED 行不变）。
//   * `docs/03-domain-and-runtime.md` §2：「模板更新不应静默改写已开始的招聘申请；
//     应明确选择继续沿用旧版本或迁移到新版本」→ 流水线阶段引用的是
//     **interview_template_version 的具体版本**，不是 code。
//
// 结构由 `db/migrations/0014_tenant_config.sql` 建立（本文件不建表、不改 schema）：
//   * `recruitment.role` 扩列：permission_scopes / description / is_active /
//     record_version / updated_at / created_by_actor_id；
//   * `recruitment.hiring_team` + `hiring_team_member`；
//   * `recruitment.pipeline_template` + `pipeline_template_stage` +
//     `pipeline_template_stage_template`。
//
// ── 四条实现纪律（对应本 lane 的验收）─────────────────────────────────
//
//  1. **校验全部在服务端**（不靠模型自觉）：
//       · 权限范围取自 `PERMISSION_SCOPES` 封闭集（9 个能力码），并拒绝重复；
//         DB 侧还有 `ck_role_permission_scopes`（0014 §1.1）同一份判定式；
//       · 阶段码必须已存在于本租户 `stage_catalog`（DB 复合外键 + 本文件预检，
//         两者都有：预检给**可执行的错误**，外键保证**并发下也不会漏**）；
//       · 阶段引用的面试模板必须已存在且同租户；
//       · 团队成员的 actor 必须存在、同租户、且 `kind='HUMAN'`
//         （DB 用复合外键 (actor_id, tenant_id, actor_kind→'HUMAN') 物理保证，
//          本文件预检给出"哪个 actor 不行、为什么"）；
//       · 租户隔离：**每个查询都带 tenant_id**，跨租户一律 `NOT_FOUND`
//         （不区分"不存在"和"不是你的"，避免探测）。
//
//  2. **版本并发控制**：所有更新拿 `expected_record_version`。
//       `select … for update` 串行化 + `where record_version = $expected`，
//       0 行 → 先判存在性：不存在 = `NOT_FOUND`，存在 = `VERSION_CONFLICT`。
//       **不 last-write-wins、不自动重读重试**（把"重读后再决定"交回调用方）。
//       `record_version` 由 `recruitment.fn_touch()`（0014 §4）自增，
//       调用方**不许手写**（手写 = 重复自增，版本对不上）。
//
//  3. **幂等**：同 (tenant, code) 的 create 若内容完全一致 → 返回
//       `status='UNCHANGED'` 且**零 UPDATE**（record_version 不动）；内容不同 →
//       `ALREADY_EXISTS`（明确报错，而不是悄悄覆盖企业的配置）。
//       同参数 update 不产生任何 UPDATE。
//
//  4. **删除是软关闭**：0014 给 5 张新表挂了 `fn_block_delete`，
//       本文件永远不发 DELETE；"移除"一律 `is_active = false`（保留历史与引用）。
//
// ── 错误（`Error: <CODE>: <compact-json>`，与 stage-advance 同一手法）─────
//   `src/tools/errors.ts` 的 `RecruitmentErrorCode` 联合里没有本 lane 需要的
//   `VERSION_CONFLICT` / `INVALID_REFERENCE` / `ALREADY_EXISTS`，而该文件属于
//   既有工具层（本 lane 不改）。因此沿用 `src/domain/stage-advance.ts:309` 的
//   既有先例：局部构造 `RecruitmentToolError(code as never, canonicalJson(body))`，
//   message 仍是单行 `<CODE>: <json>`，模型与日志看到同一份。
//
// 不做什么（刻意的边界，见 contracts/tenant-config/tool-contracts.md §0）：
//   * 不做权限**判定**（不实现 RBAC 求值）：本文件只存"角色能碰到哪类动作"，
//     谁能不能做某事的判定不在 v1.0 范围；
//   * 不做组织架构（department 已存在，本文件只**引用**它，不建/不改部门）；
//   * 不做 actor 的创建（identity 线与 0002 种子负责）；
//   * 不做流水线**应用**（把某条 application 切到某个模板实例）= Pipeline Instance，
//     仍是 `application.current_stage_code` 的现状（`db/verify.sql:312` MAPPED）；
//   * 不做阶段活动模板（Stage Activity Template，`verify.sql:315` 仍 DEFERRED）；
//   * 不做模板版本链（role/team/pipeline 本体只保留 record_version + 软关闭，
//     不建 revision 表；要审计历史请用 event/audit 线，不在本文件发明第二套历史）。

import { canonicalJson } from '../tools/contract.ts'
import { RecruitmentToolError } from '../tools/errors.ts'
import type { DatabaseClient } from '../db/pool.ts'

// =====================================================================
//  封闭集（服务端校验的唯一真相；DB 侧 0014 有同一份 CHECK）
// =====================================================================

/**
 * 角色**能力码**（封闭集，9 个）。
 *
 * 刻意粗粒度：方向明确要求"不要把复杂权限矩阵铺开"。这里只回答"这个角色能碰到
 * 哪一类业务动作"，不回答"能不能看某一条某个部门的记录"。
 * 加码 = 改 0014 的 CHECK + 本数组 + 契约，三处同改；不要只改一处（那会静默漂移）。
 */
export const PERMISSION_SCOPES = [
  'CONFIG_ADMIN',
  'JOB_READ',
  'JOB_WRITE',
  'APPLICATION_READ',
  'APPLICATION_WRITE',
  'INTERVIEW_READ',
  'INTERVIEW_WRITE',
  'SCORECARD_SUBMIT',
  'DECISION_RECORD',
] as const

/** 一个能力码。 */
export type PermissionScope = (typeof PERMISSION_SCOPES)[number]

/**
 * 团队成员在**这个团队里**承担的角色（封闭集，5 个）。
 *
 * 与 `recruitment.role` 分开：role 是租户级的"岗位角色"（可被 actor_role 授权），
 * team_role 是"这个招聘小组里你干什么"。同一个人可以既是 INTERVIEWER 又在这个
 * 小组里当 COORDINATOR。
 */
export const TEAM_ROLES = [
  'HIRING_MANAGER',
  'RECRUITER',
  'COORDINATOR',
  'INTERVIEWER',
  'APPROVER',
] as const

/** 团队成员角色码。 */
export type TeamRole = (typeof TEAM_ROLES)[number]

/** 写路径的结论（三态封闭集；`UNCHANGED` = 幂等命中，**零写**）。 */
export type WriteStatus = 'CREATED' | 'UNCHANGED' | 'UPDATED'

/** `role.code` / `hiring_team.code` / `pipeline_template.code` 的形状（与 0014 的 CHECK 同一条正则）。 */
const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/

/** UUID 文本（与 `src/tools/contract.ts` 的 `isUuid` 同一形状；本文件不 import 它以免循环依赖放大）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// =====================================================================
//  出参形状（工具层照抄；**没有 null** —— DSH 校验器不支持 type 数组，缺省即省略键）
//
// ⚠️ 时间列（created_at / updated_at / added_at）在**视图**里是 ISO-8601 文本，
// 不是 `Date`。`pg` 对 `timestamptz` 的默认解析结果是一个 `Date` 对象，它
// `typeof === 'object'`、不是普通对象——DSH 的工具注册表把这种值判为
// "value is not lossless JSON" 而**整次调用拒收**（2026-11-14 E1–E4 审计 F-1：
// `recruitment_config_role` 能跑但模型拿不到结果）。行→视图的转换是全文件唯一的
// 序列化点（{@link toIsoTimestamp}）；不许把 `Date` 透传到出参，也不许在工具出口
// 用 `JSON.parse(JSON.stringify())` 兜底（那会连类型信息一起丢掉、掩盖真正的产出点）。
// =====================================================================

/** 角色的只读视图。 */
export interface RoleView {
  readonly role_id: string
  readonly code: string
  readonly name: string
  /** 描述；没有就省略这个键。 */
  readonly description?: string
  /** 权限范围（已去重、已按字典序排序 —— 集合语义，顺序不是信息）。 */
  readonly permission_scopes: readonly string[]
  readonly is_active: boolean
  readonly record_version: number
  /** 创建人 actor id；种子行或未记录时省略。 */
  readonly created_by_actor_id?: string
  readonly created_at: string
  readonly updated_at: string
}

/** 团队成员的一行。 */
export interface TeamMemberView {
  readonly actor_id: string
  readonly display_name: string
  readonly team_role: TeamRole
  readonly is_active: boolean
  readonly added_at: string
}

/** 招聘团队的只读视图。 */
export interface TeamView {
  readonly team_id: string
  readonly code: string
  readonly name: string
  readonly department_id: string
  readonly department_name: string
  readonly description?: string
  readonly is_active: boolean
  readonly record_version: number
  /** 成员（默认只给在用成员；`includeInactive` 由调用方决定）。 */
  readonly members: readonly TeamMemberView[]
  readonly created_at: string
  readonly updated_at: string
}

/** 阶段引用的一个面试模板版本。 */
export interface InterviewTemplateRefView {
  readonly interview_template_version_id: string
  readonly template_code: string
  readonly version_no: number
  readonly is_required: boolean
}

/** 流水线模板里的一步。 */
export interface PipelineStageView {
  readonly stage_id: string
  /** 阶段码（`S1`–`S12` 之类；必须在 `stage_catalog` 里）。 */
  readonly stage_code: string
  /** 阶段名（来自 `stage_catalog.name`，给 HR 直接读）。 */
  readonly stage_name: string
  /** 这份流程里的第几步（1..100；与目录的 sort_order 不是同一个轴）。 */
  readonly sort_order: number
  /** 这一步引用的面试模板版本（0..N）。 */
  readonly interview_templates: readonly InterviewTemplateRefView[]
}

/** 流水线模板的只读视图。 */
export interface PipelineTemplateView {
  readonly pipeline_template_id: string
  readonly code: string
  readonly name: string
  readonly description?: string
  readonly is_active: boolean
  readonly record_version: number
  /** 按 `sort_order` 升序（顺序即流程，不排序 = 让调用方猜）。 */
  readonly stages: readonly PipelineStageView[]
  readonly created_at: string
  readonly updated_at: string
}

/** 一次 create 的结论（幂等命中时 `status='UNCHANGED'` 且库里零写）。 */
export interface CreateResult<T> {
  readonly status: 'CREATED' | 'UNCHANGED'
  readonly value: T
}

/**
 * 一次 update 的结论：`UNCHANGED` = 参数与库里完全一致 → **零 UPDATE**
 * （这条是幂等的可机检口径：record_version 不动、updated_at 不动）。
 */
export interface UpdateResult<T> {
  readonly status: 'UPDATED' | 'UNCHANGED'
  readonly value: T
}

// =====================================================================
//  入参
// =====================================================================

/** 建角色。 */
export interface CreateRoleInput {
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly description?: string
  /** 至少 1 个（新建角色必须有能碰到的东西；空集合只在历史种子里合法）。 */
  readonly permissionScopes: readonly string[]
  readonly createdByActorId?: string
}

/** 改角色（`code` 不可改 —— 改 code 等于换一个角色）。 */
export interface UpdateRoleInput {
  readonly tenantId: string
  readonly roleId: string
  readonly expectedRecordVersion: number
  readonly name?: string
  /** 传 `null` = 清空描述（与"不传"区分）。 */
  readonly description?: string | null
  readonly permissionScopes?: readonly string[]
  readonly isActive?: boolean
}

/** 读角色列表。 */
export interface ListRolesInput {
  readonly tenantId: string
  readonly includeInactive?: boolean
}

/** 读单个角色。 */
export interface GetRoleInput {
  readonly tenantId: string
  readonly roleId: string
}

/** 建团队（可一次带上成员）。 */
export interface CreateTeamInput {
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly departmentId: string
  readonly description?: string
  /** 成员的 actor id（去重；每个都必须存在、同租户、kind='HUMAN'）。 */
  readonly memberActorIds?: readonly string[]
  /** 这些成员在这个团队里的角色；缺省 `RECRUITER`。 */
  readonly memberTeamRole?: string
  readonly createdByActorId?: string
}

/** 改团队。 */
export interface UpdateTeamInput {
  readonly tenantId: string
  readonly teamId: string
  readonly expectedRecordVersion: number
  readonly name?: string
  readonly description?: string | null
  readonly departmentId?: string
  readonly isActive?: boolean
}

/** 加一个团队成员。 */
export interface AddTeamMemberInput {
  readonly tenantId: string
  readonly teamId: string
  readonly actorId: string
  readonly teamRole?: string
  readonly addedByActorId?: string
}

/** 移除一个团队成员（软关闭，不发 DELETE）。 */
export interface RemoveTeamMemberInput {
  readonly tenantId: string
  readonly teamId: string
  readonly actorId: string
}

/** 读团队列表。 */
export interface ListTeamsInput {
  readonly tenantId: string
  readonly includeInactive?: boolean
  readonly includeInactiveMembers?: boolean
}

/** 读单个团队。 */
export interface GetTeamInput {
  readonly tenantId: string
  readonly teamId: string
  readonly includeInactiveMembers?: boolean
}

/** 建流水线模板。 */
export interface CreatePipelineInput {
  readonly tenantId: string
  readonly code: string
  readonly name: string
  readonly description?: string
  readonly createdByActorId?: string
}

/** 改流水线模板本体。 */
export interface UpdatePipelineInput {
  readonly tenantId: string
  readonly pipelineTemplateId: string
  readonly expectedRecordVersion: number
  readonly name?: string
  readonly description?: string | null
  readonly isActive?: boolean
}

/** 给流水线加一步（可同时挂上这一步要用的面试模板版本）。 */
export interface AddPipelineStageInput {
  readonly tenantId: string
  readonly pipelineTemplateId: string
  readonly stageCode: string
  /** 不传 = 追加到末尾（max + 1）。 */
  readonly sortOrder?: number
  readonly expectedRecordVersion: number
  readonly interviewTemplateVersionIds?: readonly string[]
  /** 这些模板是否必需（缺省 true）。 */
  readonly isRequired?: boolean
}

/** 给已有阶段挂一个面试模板版本。 */
export interface AddStageTemplateInput {
  readonly tenantId: string
  readonly stageId: string
  readonly interviewTemplateVersionId: string
  readonly isRequired?: boolean
  readonly expectedRecordVersion: number
}

/** 读流水线列表。 */
export interface ListPipelinesInput {
  readonly tenantId: string
  readonly includeInactive?: boolean
}

/** 读单个流水线。 */
export interface GetPipelineInput {
  readonly tenantId: string
  readonly pipelineTemplateId: string
}

// =====================================================================
//  错误
// =====================================================================

/** 本文件允许抛出的错误码（其余一律是库/宿主异常，原样上抛）。 */
export type TenantConfigErrorCode =
  | 'INVALID_ARGS'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_REFERENCE'
  | 'ALREADY_EXISTS'
  | 'INVARIANT_VIOLATION'

/**
 * 造一个 `Error: <CODE>: <compact-json>` 形态的工具错误。
 * @param code - 稳定错误码。
 * @param reasonCode - 该码下的封闭取值（机检口径）。
 * @param message - 一句中文说明（不含 PII）。
 * @param detail - 结构化明细；没有就省略键（契约禁止用 null 占位）。
 * @returns 可直接 throw 的错误实例。
 */
export function configError(
  code: TenantConfigErrorCode,
  reasonCode: string,
  message: string,
  detail?: Record<string, unknown>,
): RecruitmentToolError {
  const body: Record<string, unknown> = { code, reason_code: reasonCode, message }
  if (detail !== undefined) body.detail = detail
  // `errors.ts` 的联合是既有封闭集（本 lane 不改它）→ 运行期 code 就是传入值。
  // 先例：src/domain/stage-advance.ts:309 的 stageError 同一手法。
  return new RecruitmentToolError(code as never, canonicalJson(body))
}

/** 这是不是"唯一键冲突"（并发下的第二次 create / 重复引用）？ */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/** 这是不是"外键/检查约束"失败（本文件的预检在并发下漏掉时的兜底）？ */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503'
}

/** 这是不是并发修改类错误（REPEATABLE READ / SERIALIZABLE 的 40001、死锁 40P01）？ */
function isConcurrentUpdateError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === '40001' || code === '40P01'
}

// =====================================================================
//  纯校验（导出以便单测；工具层与本文件都用同一份 → 不会两套规则）
// =====================================================================

/**
 * 校验并归一化权限范围：必须是数组、元素全在封闭集内、**去重后按字典序排序**。
 *
 * 为什么归一化成排序数组：权限是**集合**。不归一化的话，
 * `["JOB_READ","JOB_WRITE"]` 与 `["JOB_WRITE","JOB_READ"]` 会被幂等判定当成
 * "内容不同" → 同一条 create 重放会报 ALREADY_EXISTS（幂等失效）。
 * @param value - 模型/调用方给的值。
 * @param options.requireNonEmpty - 是否要求至少 1 个（新建角色 = true；更新 = false）。
 * @returns 归一化后的数组（可能是空数组）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（含逐条 reason_code）。
 */
export function normalizePermissionScopes(
  value: unknown,
  options: { readonly requireNonEmpty: boolean },
): string[] {
  if (!Array.isArray(value)) {
    throw configError('INVALID_ARGS', 'PERMISSION_SCOPES_NOT_ARRAY', 'permission_scopes 必须是字符串数组。')
  }
  const out = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      throw configError('INVALID_ARGS', 'PERMISSION_SCOPE_NOT_STRING', 'permission_scopes 的每个元素都必须是字符串。')
    }
    if (!(PERMISSION_SCOPES as readonly string[]).includes(item)) {
      throw configError('INVALID_ARGS', 'PERMISSION_SCOPE_UNKNOWN', `未知的权限范围：${item}（封闭集见 PERMISSION_SCOPES）。`, {
        allowed: [...PERMISSION_SCOPES],
      })
    }
    out.add(item)
  }
  if (options.requireNonEmpty && out.size === 0) {
    throw configError(
      'INVALID_ARGS',
      'PERMISSION_SCOPES_EMPTY',
      '新建角色至少要给 1 个权限范围（空集合只对历史种子行合法；要把角色清空请用 update）。',
    )
  }
  return [...out].sort()
}

/**
 * 校验一个 UUID 数组并去重（排序后返回，让"集合相同"与输入顺序无关）。
 *
 * 为什么排序：团队成员的幂等判定比的是"集合"，不排序的话
 * `[A,B]` 与 `[B,A]` 会被当成内容不同 → 同一条 create 重放报 ALREADY_EXISTS。
 * @param value - 调用方给的值；`undefined` 当作空数组。
 * @param field - 字段名（拼进错误）。
 * @returns UUID 数组（已小写、已去重、已排序）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（不是数组 / 含非字符串 / 非 UUID）。
 */
export function normalizeUuidList(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw configError('INVALID_ARGS', 'UUID_LIST_NOT_ARRAY',
      `${field} 必须是字符串数组（每个元素是一个 UUID）。`, { field })
  }
  const out = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_RE.test(item)) {
      throw configError('INVALID_ARGS', 'UUID_LIST_ELEMENT_NOT_UUID',
        `${field} 的每个元素都必须是 UUID 文本。`,
        { field, value: typeof item === 'string' ? item : typeof item })
    }
    out.add(item.toLowerCase())
  }
  return [...out].sort()
}

/**
 * 团队成员的 actor id 数组校验（语义化别名，规则见 {@link normalizeUuidList}）。
 * @param value - 调用方给的值；`undefined` 当作空数组。
 * @returns actor id 数组（已小写、去重、排序）。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function normalizeActorIds(value: unknown): string[] {
  return normalizeUuidList(value, 'member_actor_ids')
}

/**
 * 校验一个 UUID 文本。
 * @param value - 调用方给的值。
 * @param field - 字段名（用于错误路径）。
 * @returns 小写 UUID 文本。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw configError('INVALID_ARGS', 'ID_NOT_UUID', `${field} 必须是 UUID 文本。`, { field })
  }
  return value.toLowerCase()
}

/**
 * 校验 `expected_record_version`（乐观并发的前置条件）。
 * @param value - 调用方给的值。
 * @returns 整数版本号（>= 1）。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function requireRecordVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw configError('INVALID_ARGS', 'EXPECTED_RECORD_VERSION_INVALID',
      'expected_record_version 必须是 >= 1 的整数（先 get 一次拿到当前 record_version）。')
  }
  return value
}

/**
 * 校验配置的 code（`^[A-Z][A-Z0-9_]{1,40}$`，与 0014 的 CHECK 同一条正则）。
 * @param value - 调用方给的值。
 * @returns 原样返回。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function requireCode(value: unknown): string {
  if (typeof value !== 'string' || !CODE_RE.test(value)) {
    throw configError('INVALID_ARGS', 'CODE_FORMAT_INVALID',
      'code 必须是 2–41 个字符的大写标识（字母开头，只允许 A-Z 0-9 _），例如 HIRING_TEAM_APAC。',
      { value: typeof value === 'string' ? value : typeof value })
  }
  return value
}

/**
 * 校验名称（去首尾空白后 1–200 字符）。
 * @param value - 调用方给的值。
 * @param field - 字段名。
 * @returns 去空白后的名称。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function requireName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw configError('INVALID_ARGS', `${field.toUpperCase()}_NOT_STRING`, `${field} 必须是字符串。`)
  }
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw configError('INVALID_ARGS', `${field.toUpperCase()}_LENGTH`, `${field} 长度必须是 1–200（去首尾空白后）。`)
  }
  return trimmed
}

/**
 * 校验描述（可选；`null` = 显式清空，`undefined` = 不传）。
 * @param value - 调用方给的值。
 * @returns `undefined`（不传）/ `null`（清空）/ 去空白后的文本。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function optionalDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw configError('INVALID_ARGS', 'DESCRIPTION_NOT_STRING', 'description 必须是字符串或省略。')
  }
  const trimmed = value.trim()
  if (trimmed.length < 1 || trimmed.length > 1000) {
    throw configError('INVALID_ARGS', 'DESCRIPTION_LENGTH', 'description 长度必须是 1–1000（去首尾空白后），清空请显式传 null。')
  }
  return trimmed
}

/**
 * 校验团队成员角色码（封闭集 `TEAM_ROLES`）。
 * @param value - 调用方给的值（`undefined` 用缺省值）。
 * @param fallback - 缺省值。
 * @returns 角色码。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function requireTeamRole(value: unknown, fallback: TeamRole): TeamRole {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'string' || !(TEAM_ROLES as readonly string[]).includes(candidate)) {
    throw configError('INVALID_ARGS', 'TEAM_ROLE_UNKNOWN',
      `team_role 必须是封闭集之一：${TEAM_ROLES.join(', ')}。`)
  }
  return candidate as TeamRole
}

// =====================================================================
//  行形状 + 映射
// =====================================================================

/**
 * 库里的时间列：`pg` 对 `timestamptz` 的默认解析结果是 `Date`，测试替身可能给字符串。
 * 行接口必须照着**运行时**的真实类型写（写 `string` 是在说谎，编译器也拦不住）。
 */
type TimestampColumn = string | Date

/**
 * 时间列 → ISO-8601 文本（出参里唯一允许的时间形态）。
 *
 * 为什么必须在**行→视图这一步**做：`Date` 不是普通 JSON 对象，DSH 的工具注册表
 * 直接判 `value is not lossless JSON` 并拒收整次调用（审计 F-1 的真实报错）。
 * `JSON.stringify` 恰好会调用 `Date#toJSON` 吐出字符串，所以"序列化不报错"的测试
 * 抓不到它——但值本身已经不是 JSON 数据了，依赖它的下游（schema 校验/会话日志/
 * 事件流）行为由宿主决定，不能赌。
 *
 * 语义与 S7/S8/S10 各工具里既有的 `iso()` 一致（字符串输入先按 ISO 解析再归一，
 * 解析不了就原样返回），这样三处 config 工具与其它工具输出同一种时间文本。
 * @param value - 行里的时间列（`Date` 或字符串）。
 * @returns ISO-8601 文本（`Z` 结尾）。
 */
export function toIsoTimestamp(value: TimestampColumn): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

interface RoleRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly description: string | null
  readonly permission_scopes: readonly string[]
  readonly is_active: boolean
  readonly record_version: number
  readonly created_by_actor_id: string | null
  readonly created_at: TimestampColumn
  readonly updated_at: TimestampColumn
}

interface TeamRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly department_id: string
  readonly department_name: string
  readonly description: string | null
  readonly is_active: boolean
  readonly record_version: number
  readonly created_at: TimestampColumn
  readonly updated_at: TimestampColumn
}

interface TeamMemberRow {
  readonly actor_id: string
  readonly display_name: string
  readonly team_role: string
  readonly is_active: boolean
  readonly added_at: TimestampColumn
}

interface PipelineRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly description: string | null
  readonly is_active: boolean
  readonly record_version: number
  readonly created_at: TimestampColumn
  readonly updated_at: TimestampColumn
}

interface StageRow {
  readonly id: string
  readonly pipeline_template_id: string
  readonly stage_code: string
  readonly stage_name: string
  readonly sort_order: number
}

interface StageTemplateRow {
  readonly stage_id: string
  readonly interview_template_version_id: string
  readonly template_code: string
  readonly version_no: number
  readonly is_required: boolean
}

/** ROLE 的 select 列（三处 select 共用，避免漂移）。 */
const ROLE_COLUMNS = `id, code, name, description, permission_scopes, is_active,
                      record_version, created_by_actor_id, created_at, updated_at`

/** TEAM 的 select 列（带部门名）。 */
const TEAM_COLUMNS = `t.id, t.code, t.name, t.department_id,
                      d.name as department_name, t.description, t.is_active,
                      t.record_version, t.created_at, t.updated_at`

/** PIPELINE 的 select 列。 */
const PIPELINE_COLUMNS = `id, code, name, description, is_active,
                          record_version, created_at, updated_at`

/**
 * 行 → 视图（角色）。`permission_scopes` 从库里读出来可能是任意顺序（历史行），
 * 统一排序后返回，保证同一条数据每次渲染都一样。
 * @param row - 库里的行。
 * @returns 角色视图。
 */
function toRoleView(row: RoleRow): RoleView {
  const scopes = [...new Set(row.permission_scopes)].sort()
  return {
    role_id: row.id,
    code: row.code,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    permission_scopes: scopes,
    is_active: row.is_active,
    record_version: row.record_version,
    ...(row.created_by_actor_id === null ? {} : { created_by_actor_id: row.created_by_actor_id }),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  }
}

/**
 * 行 → 视图（团队）。成员列表由调用方单独查好传入。
 * @param row - 团队行。
 * @param members - 成员行。
 * @returns 团队视图。
 */
function toTeamView(row: TeamRow, members: readonly TeamMemberRow[]): TeamView {
  return {
    team_id: row.id,
    code: row.code,
    name: row.name,
    department_id: row.department_id,
    department_name: row.department_name,
    ...(row.description === null ? {} : { description: row.description }),
    is_active: row.is_active,
    record_version: row.record_version,
    members: members.map((m): TeamMemberView => ({
      actor_id: m.actor_id,
      display_name: m.display_name,
      team_role: m.team_role as TeamRole,
      is_active: m.is_active,
      added_at: toIsoTimestamp(m.added_at),
    })),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  }
}

/**
 * 行 → 视图（流水线）。阶段与模板引用由调用方查好传入。
 * @param row - 流水线行。
 * @param stages - 阶段行（已按 sort_order 排序）。
 * @param refs - 阶段 → 模板引用。
 * @returns 流水线视图。
 */
function toPipelineView(
  row: PipelineRow,
  stages: readonly StageRow[],
  refs: readonly StageTemplateRow[],
): PipelineTemplateView {
  const byStage = new Map<string, InterviewTemplateRefView[]>()
  for (const ref of refs) {
    const list = byStage.get(ref.stage_id) ?? []
    list.push({
      interview_template_version_id: ref.interview_template_version_id,
      template_code: ref.template_code,
      version_no: ref.version_no,
      is_required: ref.is_required,
    })
    byStage.set(ref.stage_id, list)
  }
  return {
    pipeline_template_id: row.id,
    code: row.code,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    is_active: row.is_active,
    record_version: row.record_version,
    stages: stages.map((s): PipelineStageView => ({
      stage_id: s.id,
      stage_code: s.stage_code,
      stage_name: s.stage_name,
      sort_order: s.sort_order,
      interview_templates: byStage.get(s.id) ?? [],
    })),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  }
}

// =====================================================================
//  共享读取
// =====================================================================

/**
 * 读一个角色（可加行锁）。**永远带 tenant_id**：跨租户 = 不存在。
 * @param client - 调用方事务内的连接。
 * @param tenantId - 租户。
 * @param roleId - 角色 id。
 * @param lock - 是否 `for update`（写路径 true）。
 * @returns 角色行；不存在返回 `null`（由调用方决定抛 NOT_FOUND 还是 ALREADY_EXISTS 语义）。
 */
async function readRoleRow(
  client: DatabaseClient,
  tenantId: string,
  roleId: string,
  lock: boolean,
): Promise<RoleRow | null> {
  const { rows } = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS} from recruitment.role
      where id = $1 and tenant_id = $2${lock ? ' for update' : ''}`,
    [roleId, tenantId],
  )
  return rows[0] ?? null
}

/**
 * 按 code 读一个角色（可加行锁）。create 的幂等判定就用它。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param code - 角色 code。
 * @param lock - 是否 `for update`。
 * @returns 角色行；没有返回 `null`。
 */
async function readRoleRowByCode(
  client: DatabaseClient,
  tenantId: string,
  code: string,
  lock: boolean,
): Promise<RoleRow | null> {
  const { rows } = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS} from recruitment.role
      where tenant_id = $1 and code = $2${lock ? ' for update' : ''}`,
    [tenantId, code],
  )
  return rows[0] ?? null
}

/**
 * 读团队的成员行（带显示名）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param teamIds - 团队 id 列表（空数组直接返回空）。
 * @param includeInactive - 是否包含已移除成员。
 * @returns 团队 id → 成员行数组。
 */
async function readTeamMembers(
  client: DatabaseClient,
  tenantId: string,
  teamIds: readonly string[],
  includeInactive: boolean,
): Promise<Map<string, TeamMemberRow[]>> {
  const out = new Map<string, TeamMemberRow[]>()
  if (teamIds.length === 0) return out
  const { rows } = await client.query<TeamMemberRow & { team_id: string }>(
    `select m.team_id, m.actor_id, a.display_name, m.team_role, m.is_active,
            m.created_at as added_at
       from recruitment.hiring_team_member m
       join recruitment.actor a
         on a.id = m.actor_id and a.tenant_id = m.tenant_id
      where m.tenant_id = $1
        and m.team_id = any($2::uuid[])
        ${includeInactive ? '' : 'and m.is_active'}
      order by m.team_id, m.created_at, m.actor_id`,
    [tenantId, [...teamIds]],
  )
  for (const row of rows) {
    const list = out.get(row.team_id) ?? []
    list.push(row)
    out.set(row.team_id, list)
  }
  return out
}

/**
 * 读流水线模板的阶段 + 模板引用（两个查询，避免 N+1）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param pipelineIds - 流水线 id 列表。
 * @returns `{stagesByPipeline, refs}`。
 */
async function readPipelineStructure(
  client: DatabaseClient,
  tenantId: string,
  pipelineIds: readonly string[],
): Promise<{ stagesByPipeline: Map<string, StageRow[]>; refs: StageTemplateRow[] }> {
  const stagesByPipeline = new Map<string, StageRow[]>()
  if (pipelineIds.length === 0) return { stagesByPipeline, refs: [] }

  const { rows: stages } = await client.query<StageRow>(
    `select s.id, s.pipeline_template_id, s.stage_code, c.name as stage_name, s.sort_order
       from recruitment.pipeline_template_stage s
       join recruitment.stage_catalog c
         on c.tenant_id = s.tenant_id and c.code = s.stage_code
      where s.tenant_id = $1 and s.pipeline_template_id = any($2::uuid[])
      order by s.pipeline_template_id, s.sort_order`,
    [tenantId, [...pipelineIds]],
  )
  for (const stage of stages) {
    const list = stagesByPipeline.get(stage.pipeline_template_id) ?? []
    list.push(stage)
    stagesByPipeline.set(stage.pipeline_template_id, list)
  }

  const stageIds = stages.map((s) => s.id)
  if (stageIds.length === 0) return { stagesByPipeline, refs: [] }

  const { rows: refs } = await client.query<StageTemplateRow>(
    `select r.stage_id, r.interview_template_version_id, r.is_required,
            v.template_code, v.version_no
       from recruitment.pipeline_template_stage_template r
       join recruitment.interview_template_version v
         on v.id = r.interview_template_version_id and v.tenant_id = r.tenant_id
      where r.tenant_id = $1 and r.stage_id = any($2::uuid[])
      order by r.stage_id, v.template_code, v.version_no`,
    [tenantId, stageIds],
  )
  return { stagesByPipeline, refs }
}

/**
 * 读一个团队（带成员）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param teamId - 团队 id。
 * @param lock - 是否 `for update`。
 * @returns 团队视图或 `null`。
 */
async function readTeamView(
  client: DatabaseClient,
  tenantId: string,
  teamId: string,
  lock: boolean,
  includeInactiveMembers = false,
): Promise<TeamView | null> {
  const { rows } = await client.query<TeamRow>(
    `select ${TEAM_COLUMNS}
       from recruitment.hiring_team t
       join recruitment.department d on d.id = t.department_id and d.tenant_id = t.tenant_id
      where t.id = $1 and t.tenant_id = $2${lock ? ' for update of t' : ''}`,
    [teamId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) return null
  const members = await readTeamMembers(client, tenantId, [teamId], includeInactiveMembers)
  return toTeamView(row, members.get(teamId) ?? [])
}

/**
 * 读一个流水线模板（带阶段与模板引用）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param pipelineId - 流水线 id。
 * @param lock - 是否 `for update`。
 * @returns 流水线视图或 `null`。
 */
async function readPipelineView(
  client: DatabaseClient,
  tenantId: string,
  pipelineId: string,
  lock: boolean,
): Promise<PipelineTemplateView | null> {
  const { rows } = await client.query<PipelineRow>(
    `select ${PIPELINE_COLUMNS} from recruitment.pipeline_template
      where id = $1 and tenant_id = $2${lock ? ' for update' : ''}`,
    [pipelineId, tenantId],
  )
  const row = rows[0]
  if (row === undefined) return null
  const { stagesByPipeline, refs } = await readPipelineStructure(client, tenantId, [pipelineId])
  return toPipelineView(row, stagesByPipeline.get(pipelineId) ?? [], refs)
}

/**
 * 校验部门存在且属于本租户（团队归属的引用完整性预检）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param departmentId - 部门 id。
 * @throws RecruitmentToolError - `INVALID_REFERENCE`（DEPARTMENT_NOT_FOUND）。
 */
async function assertDepartmentExists(
  client: DatabaseClient,
  tenantId: string,
  departmentId: string,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    'select id from recruitment.department where id = $1 and tenant_id = $2',
    [departmentId, tenantId],
  )
  if (rows[0] === undefined) {
    throw configError('INVALID_REFERENCE', 'DEPARTMENT_NOT_FOUND',
      'department_id 指向的部门不存在或不属于当前租户：团队必须挂在本租户已存在的部门下。',
      { department_id: departmentId })
  }
}

/**
 * 校验一批 actor 存在、同租户、且 kind='HUMAN'。
 *
 * 这是"成员的 actor 必须存在且 kind='HUMAN'"的**服务端**判定（DB 侧 0014 的
 * 复合外键 (actor_id, tenant_id, actor_kind→'HUMAN') 是并发下的物理兜底）。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param actorIds - 待校验的 actor id。
 * @throws RecruitmentToolError - `INVALID_REFERENCE`（ACTORS_NOT_FOUND / ACTOR_NOT_HUMAN）。
 */
async function assertHumanActors(
  client: DatabaseClient,
  tenantId: string,
  actorIds: readonly string[],
): Promise<void> {
  if (actorIds.length === 0) return
  const { rows } = await client.query<{ id: string; kind: string }>(
    'select id, kind from recruitment.actor where tenant_id = $1 and id = any($2::uuid[])',
    [tenantId, [...actorIds]],
  )
  const found = new Map(rows.map((r) => [r.id, r.kind]))
  const missing = actorIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw configError('INVALID_REFERENCE', 'ACTORS_NOT_FOUND',
      '成员列表里有 actor 不存在或不属于当前租户：团队只能加入本租户已存在的账号。',
      { missing_actor_ids: missing })
  }
  const notHuman = actorIds
    .filter((id) => found.get(id) !== 'HUMAN')
    .map((id) => ({ actor_id: id, kind: found.get(id) ?? 'MISSING' }))
  if (notHuman.length > 0) {
    throw configError('INVALID_REFERENCE', 'ACTOR_NOT_HUMAN',
      "团队成员的 actor 必须是 kind='HUMAN'：SYSTEM / AGENT_WORKER 账号不能成为招聘团队成员。",
      { actors: notHuman })
  }
}

/**
 * 校验阶段码存在于本租户 `stage_catalog`。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param stageCode - 阶段码。
 * @throws RecruitmentToolError - `INVALID_REFERENCE`（STAGE_CODE_UNKNOWN，附可用阶段码）。
 */
async function assertStageCodeExists(
  client: DatabaseClient,
  tenantId: string,
  stageCode: string,
): Promise<void> {
  const { rows } = await client.query<{ code: string }>(
    'select code from recruitment.stage_catalog where tenant_id = $1 and code = $2',
    [tenantId, stageCode],
  )
  if (rows[0] !== undefined) return
  // 给"可执行的错误"：把本租户现存的阶段码一起返回，模型不必猜。
  const { rows: available } = await client.query<{ code: string }>(
    'select code from recruitment.stage_catalog where tenant_id = $1 order by sort_order',
    [tenantId],
  )
  throw configError('INVALID_REFERENCE', 'STAGE_CODE_UNKNOWN',
    'stage_code 不在本租户的 stage_catalog 里：流水线的阶段必须引用已存在的阶段目录行。',
    { stage_code: stageCode, available_stage_codes: available.map((r) => r.code) })
}

/**
 * 校验一批面试模板版本存在且同租户。
 * @param client - 事务内连接。
 * @param tenantId - 租户。
 * @param templateVersionIds - `interview_template_version.id` 列表。
 * @throws RecruitmentToolError - `INVALID_REFERENCE`（TEMPLATE_VERSION_NOT_FOUND）。
 */
async function assertTemplateVersionsExist(
  client: DatabaseClient,
  tenantId: string,
  templateVersionIds: readonly string[],
): Promise<void> {
  if (templateVersionIds.length === 0) return
  const { rows } = await client.query<{ id: string }>(
    'select id from recruitment.interview_template_version where tenant_id = $1 and id = any($2::uuid[])',
    [tenantId, [...templateVersionIds]],
  )
  const found = new Set(rows.map((r) => r.id))
  const missing = templateVersionIds.filter((id) => !found.has(id))
  if (missing.length > 0) {
    throw configError('INVALID_REFERENCE', 'TEMPLATE_VERSION_NOT_FOUND',
      '阶段引用的面试模板版本不存在或不属于当前租户：阶段只能引用已存在的 interview_template_version。',
      { missing_interview_template_version_ids: missing })
  }
}

/**
 * 包一层并发错误映射：REPEATABLE READ / SERIALIZABLE 的 40001 与 40P01 死锁
 * 都意味着"你读到的已经过期"，统一成 `VERSION_CONFLICT`（正确反应是重读）。
 * @param error - 任意异常。
 * @param what - 出错对象的中文名（拼进 message）。
 * @param id - 对象 id（拼进 detail）。
 * @throws RecruitmentToolError - 并发类 → `VERSION_CONFLICT`；其余原样抛。
 */
function rethrowConcurrent(error: unknown, what: string, id: string): never {
  if (isConcurrentUpdateError(error)) {
    throw configError('VERSION_CONFLICT', 'CONCURRENT_UPDATE',
      `并发修改：另一个事务先改了这条${what}。本次调用已整体回滚，请重读后再决定。`, { id })
  }
  throw error
}

// =====================================================================
//  角色（role template）
// =====================================================================

/**
 * 建一个角色（幂等：同 code 同内容 → `UNCHANGED` + 零 UPDATE）。
 *
 * 校验（服务端）：code 形状、name 长度、description 长度、权限范围封闭集 + 非空。
 * 幂等键：`(tenant_id, code)`（0014 的 `uq_role_code` 是既有约束）。
 * @param client - 调用方事务内的连接（actor 已 `SET LOCAL recruitment.actor_id`）。
 * @param input - 见 {@link CreateRoleInput}。
 * @returns `{status, value}`；`status='CREATED'` 时 value 是新行，`UNCHANGED` 时是既有行。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `ALREADY_EXISTS`。
 */
export async function createRole(
  client: DatabaseClient,
  input: CreateRoleInput,
): Promise<CreateResult<RoleView>> {
  const code = requireCode(input.code)
  const name = requireName(input.name, 'name')
  const description = optionalDescription(input.description) ?? null
  const scopes = normalizePermissionScopes(input.permissionScopes, { requireNonEmpty: true })
  const createdBy = input.createdByActorId === undefined
    ? null
    : requireUuid(input.createdByActorId, 'created_by_actor_id')

  const existing = await readRoleRowByCode(client, input.tenantId, code, true)
  if (existing !== null) {
    const same = existing.name === name
      && (existing.description ?? null) === description
      && [...new Set(existing.permission_scopes)].sort().join(',') === scopes.join(',')
      && existing.is_active
    if (same) return { status: 'UNCHANGED', value: toRoleView(existing) }
    throw configError('ALREADY_EXISTS', 'ROLE_CODE_TAKEN',
      '这个 code 已被本租户的另一个角色占用，且内容不同：改内容请用 update（带 expected_record_version），不要重复 create。',
      { role_id: existing.id, record_version: existing.record_version, code })
  }

  try {
    const { rows } = await client.query<RoleRow>(
      `insert into recruitment.role
         (tenant_id, code, name, description, permission_scopes, created_by_actor_id)
       values ($1, $2, $3, $4, $5::jsonb, $6)
       returning ${ROLE_COLUMNS}`,
      [input.tenantId, code, name, description, JSON.stringify(scopes), createdBy],
    )
    const row = rows[0]
    if (row === undefined) {
      throw configError('INVARIANT_VIOLATION', 'ROLE_INSERT_NO_ROW', '插入角色没有返回行。', { code })
    }
    return { status: 'CREATED', value: toRoleView(row) }
  } catch (error) {
    // 并发下两个 create 同时通过上面的 select：唯一键只会让一个成功。
    //
    // 注意：唯一键冲突会让**整个事务进入 aborted 状态**（PG 的 25P02），所以这里
    // **不能**再"重读一次让输的一方返回 UNCHANGED" —— 那条 SELECT 一定失败，
    // 还会把真正的原因盖成 "current transaction is aborted"。正确做法是如实报
    // ALREADY_EXISTS 并让调用方在**新事务**里 get 一次看现状。
    if (isUniqueViolation(error)) {
      throw configError('ALREADY_EXISTS', 'ROLE_CODE_RACE',
        '同一个 code 的角色被并发创建了（内容可能不同）：请在新事务里 get 一次确认现状。', { code })
    }
    rethrowConcurrent(error, '角色', code)
  }
}

/**
 * 改一个角色（版本并发控制；同参数 = 零 UPDATE + `UNCHANGED`）。
 *
 * `code` 不可改：改 code 等于换一个角色（引用方全部会指向"看起来还在但语义变了"
 * 的行）。要换 code 就新建一个角色并软关闭旧的。
 * @param client - 事务内连接。
 * @param input - 见 {@link UpdateRoleInput}。
 * @returns 更新后的角色视图。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `VERSION_CONFLICT`。
 */
export async function updateRole(
  client: DatabaseClient,
  input: UpdateRoleInput,
): Promise<UpdateResult<RoleView>> {
  const roleId = requireUuid(input.roleId, 'role_id')
  const expected = requireRecordVersion(input.expectedRecordVersion)
  const hasAnyChange = input.name !== undefined || input.description !== undefined
    || input.permissionScopes !== undefined || input.isActive !== undefined
  if (!hasAnyChange) {
    throw configError('INVALID_ARGS', 'NO_CHANGES_REQUESTED',
      'update 至少要改一个字段（name / description / permission_scopes / is_active）。')
  }

  const current = await readRoleRow(client, input.tenantId, roleId, true)
  if (current === null) {
    throw configError('NOT_FOUND', 'ROLE_NOT_FOUND', '角色不存在，或不属于当前租户。', { role_id: roleId })
  }
  if (current.record_version !== expected) {
    throw configError('VERSION_CONFLICT', 'ROLE_RECORD_VERSION_MISMATCH',
      '角色已被别人改过：record_version 与 expected_record_version 不一致，本调用零写入。',
      { role_id: roleId, expected_record_version: expected, actual_record_version: current.record_version })
  }

  const nextName = input.name === undefined ? current.name : requireName(input.name, 'name')
  const nextDescription = input.description === undefined
    ? current.description
    : optionalDescription(input.description) ?? null
  const nextScopes = input.permissionScopes === undefined
    ? [...new Set(current.permission_scopes)].sort()
    : normalizePermissionScopes(input.permissionScopes, { requireNonEmpty: false })
  const nextActive = input.isActive === undefined ? current.is_active : input.isActive

  const identical = nextName === current.name
    && (nextDescription ?? null) === (current.description ?? null)
    && nextScopes.join(',') === [...new Set(current.permission_scopes)].sort().join(',')
    && nextActive === current.is_active
  if (identical) return { status: 'UNCHANGED', value: toRoleView(current) }  // 零 UPDATE：幂等

  const sets: string[] = []
  const params: unknown[] = [roleId, input.tenantId]
  // SET 的参数从 $3 起占位；WHERE 里的 record_version 必须是**最后一个**占位符。
  // （写死 $3 会与第一个 SET 参数撞号——实测 PG 报"提供了5个参数，但要求4个"。）
  const push = (column: string, value: unknown): void => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (nextName !== current.name) push('name', nextName)
  if ((nextDescription ?? null) !== (current.description ?? null)) push('description', nextDescription)
  if (nextScopes.join(',') !== [...new Set(current.permission_scopes)].sort().join(',')) {
    push('permission_scopes', JSON.stringify(nextScopes))
  }
  if (nextActive !== current.is_active) push('is_active', nextActive)
  // record_version / updated_at 由 fn_touch 自增，**不许手写**。

  try {
    const { rows } = await client.query<RoleRow>(
      `update recruitment.role set ${sets.join(', ')}
        where id = $1 and tenant_id = $2 and record_version = $${params.length + 1}
        returning ${ROLE_COLUMNS}`,
      [...params, expected],
    )
    const row = rows[0]
    if (row === undefined) {
      // 行锁在手还 0 行 = 别人在我们读之后、写之前提交过（或版本号被绕过）。
      throw configError('VERSION_CONFLICT', 'ROLE_RECORD_VERSION_MISMATCH',
        '更新 0 行：角色的 record_version 与 expected_record_version 不一致（并发修改）。',
        { role_id: roleId, expected_record_version: expected })
    }
    return { status: 'UPDATED', value: toRoleView(row) }
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    rethrowConcurrent(error, '角色', roleId)
  }
}

/**
 * 列出本租户的角色（按 code 排序，结果稳定）。
 * @param client - 连接（可来自只读事务）。
 * @param input - `{tenantId, includeInactive?}`。
 * @returns 角色视图数组。
 */
export async function listRoles(
  client: DatabaseClient,
  input: ListRolesInput,
): Promise<RoleView[]> {
  const { rows } = await client.query<RoleRow>(
    `select ${ROLE_COLUMNS} from recruitment.role
      where tenant_id = $1 ${input.includeInactive === true ? '' : 'and is_active'}
      order by code`,
    [input.tenantId],
  )
  return rows.map(toRoleView)
}

/**
 * 读一个角色。
 * @param client - 连接。
 * @param input - `{tenantId, roleId}`。
 * @returns 角色视图。
 * @throws RecruitmentToolError - `NOT_FOUND`。
 */
export async function getRole(
  client: DatabaseClient,
  input: GetRoleInput,
): Promise<RoleView> {
  const roleId = requireUuid(input.roleId, 'role_id')
  const row = await readRoleRow(client, input.tenantId, roleId, false)
  if (row === null) {
    throw configError('NOT_FOUND', 'ROLE_NOT_FOUND', '角色不存在，或不属于当前租户。', { role_id: roleId })
  }
  return toRoleView(row)
}

// =====================================================================
//  招聘团队（hiring team）
// =====================================================================

/**
 * 建一个招聘团队（幂等：同 code 且团队本体 + 在用成员集合一致 → `UNCHANGED`）。
 *
 * 服务端校验：code/name/description、部门存在且同租户、每个成员 actor 存在且
 * `kind='HUMAN'`（DB 侧还有复合外键物理保证）。
 * @param client - 调用方事务内的连接。
 * @param input - 见 {@link CreateTeamInput}。
 * @returns `{status, value}`。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `INVALID_REFERENCE` / `ALREADY_EXISTS`。
 */
export async function createTeam(
  client: DatabaseClient,
  input: CreateTeamInput,
): Promise<CreateResult<TeamView>> {
  const code = requireCode(input.code)
  const name = requireName(input.name, 'name')
  const departmentId = requireUuid(input.departmentId, 'department_id')
  const description = optionalDescription(input.description) ?? null
  const memberRole = requireTeamRole(input.memberTeamRole, 'RECRUITER')
  const actorIds = normalizeActorIds(input.memberActorIds)
  const createdBy = input.createdByActorId === undefined
    ? null
    : requireUuid(input.createdByActorId, 'created_by_actor_id')

  await assertDepartmentExists(client, input.tenantId, departmentId)
  await assertHumanActors(client, input.tenantId, actorIds)

  const { rows: existingRows } = await client.query<TeamRow>(
    `select ${TEAM_COLUMNS}
       from recruitment.hiring_team t
       join recruitment.department d on d.id = t.department_id and d.tenant_id = t.tenant_id
      where t.tenant_id = $1 and t.code = $2
      for update of t`,
    [input.tenantId, code],
  )
  const existing = existingRows[0]
  if (existing !== undefined) {
    const members = (await readTeamMembers(client, input.tenantId, [existing.id], false))
      .get(existing.id) ?? []
    const existingSet = members
      .filter((m) => m.is_active)
      .map((m) => `${m.actor_id}:${m.team_role}`)
      .sort()
      .join(',')
    const wantedSet = actorIds.map((id) => `${id}:${memberRole}`).sort().join(',')
    const same = existing.name === name
      && existing.department_id === departmentId
      && (existing.description ?? null) === description
      && existing.is_active
      && existingSet === wantedSet
    if (same) return { status: 'UNCHANGED', value: toTeamView(existing, members) }
    throw configError('ALREADY_EXISTS', 'TEAM_CODE_TAKEN',
      '这个 code 已被本租户的另一个团队占用，且内容/成员不同：改团队请用 update，成员请用 add_member/remove_member。',
      { team_id: existing.id, record_version: existing.record_version, code })
  }

  try {
    const { rows } = await client.query<{ id: string }>(
      `insert into recruitment.hiring_team
         (tenant_id, code, name, department_id, description, created_by_actor_id)
       values ($1, $2, $3, $4, $5, $6)
       returning id`,
      [input.tenantId, code, name, departmentId, description, createdBy],
    )
    const teamId = rows[0]?.id
    if (teamId === undefined) {
      throw configError('INVARIANT_VIOLATION', 'TEAM_INSERT_NO_ROW', '插入团队没有返回行。', { code })
    }
    if (actorIds.length > 0) {
      await client.query(
        `insert into recruitment.hiring_team_member
           (tenant_id, team_id, actor_id, team_role, added_by_actor_id)
         select $1, $2, m.actor_id, $4, $5 from unnest($3::uuid[]) as m(actor_id)`,
        [input.tenantId, teamId, actorIds, memberRole, createdBy],
      )
    }
    const view = await readTeamView(client, input.tenantId, teamId, false)
    if (view === null) {
      throw configError('INVARIANT_VIOLATION', 'TEAM_INSERT_NOT_VISIBLE', '刚插入的团队读不回来。', { team_id: teamId })
    }
    return { status: 'CREATED', value: view }
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    // 并发 create / 成员外键在预检之后被破坏 → 都按"引用/唯一键"报，不静默
    if (isUniqueViolation(error)) {
      throw configError('ALREADY_EXISTS', 'TEAM_CODE_RACE',
        '同一个 code 的团队被并发创建了：先 get 一次确认现状。', { code })
    }
    if (isForeignKeyViolation(error)) {
      throw configError('INVALID_REFERENCE', 'TEAM_REFERENCE_BROKEN',
        '团队的部门或成员 actor 在写入瞬间不再合法（并发删除/改 kind）：请重读后重试。', { code })
    }
    rethrowConcurrent(error, '团队', code)
  }
}

/**
 * 改一个团队（版本并发控制）。
 * @param client - 事务内连接。
 * @param input - 见 {@link UpdateTeamInput}。
 * @returns 更新后的团队视图。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `VERSION_CONFLICT` / `INVALID_REFERENCE`。
 */
export async function updateTeam(
  client: DatabaseClient,
  input: UpdateTeamInput,
): Promise<UpdateResult<TeamView>> {
  const teamId = requireUuid(input.teamId, 'team_id')
  const expected = requireRecordVersion(input.expectedRecordVersion)
  const hasAnyChange = input.name !== undefined || input.description !== undefined
    || input.departmentId !== undefined || input.isActive !== undefined
  if (!hasAnyChange) {
    throw configError('INVALID_ARGS', 'NO_CHANGES_REQUESTED',
      'update 至少要改一个字段（name / description / department_id / is_active）。')
  }

  const current = await readTeamView(client, input.tenantId, teamId, true)
  if (current === null) {
    throw configError('NOT_FOUND', 'TEAM_NOT_FOUND', '团队不存在，或不属于当前租户。', { team_id: teamId })
  }
  if (current.record_version !== expected) {
    throw configError('VERSION_CONFLICT', 'TEAM_RECORD_VERSION_MISMATCH',
      '团队已被别人改过：record_version 与 expected_record_version 不一致，本调用零写入。',
      { team_id: teamId, expected_record_version: expected, actual_record_version: current.record_version })
  }

  const nextName = input.name === undefined ? current.name : requireName(input.name, 'name')
  const nextDescription = input.description === undefined
    ? (current.description ?? null)
    : optionalDescription(input.description) ?? null
  const nextDepartment = input.departmentId === undefined
    ? current.department_id
    : requireUuid(input.departmentId, 'department_id')
  const nextActive = input.isActive === undefined ? current.is_active : input.isActive

  if (nextDepartment !== current.department_id) {
    await assertDepartmentExists(client, input.tenantId, nextDepartment)
  }

  const identical = nextName === current.name
    && nextDescription === (current.description ?? null)
    && nextDepartment === current.department_id
    && nextActive === current.is_active
  if (identical) return { status: 'UNCHANGED', value: current }  // 零 UPDATE：幂等

  const sets: string[] = []
  const params: unknown[] = [teamId, input.tenantId]
  const push = (column: string, value: unknown): void => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (nextName !== current.name) push('name', nextName)
  if (nextDescription !== (current.description ?? null)) push('description', nextDescription)
  if (nextDepartment !== current.department_id) push('department_id', nextDepartment)
  if (nextActive !== current.is_active) push('is_active', nextActive)

  try {
    const { rows } = await client.query<{ id: string }>(
      `update recruitment.hiring_team set ${sets.join(', ')}
        where id = $1 and tenant_id = $2 and record_version = $${params.length + 1}
        returning id`,
      [...params, expected],
    )
    if (rows[0] === undefined) {
      throw configError('VERSION_CONFLICT', 'TEAM_RECORD_VERSION_MISMATCH',
        '更新 0 行：团队的 record_version 与 expected_record_version 不一致（并发修改）。',
        { team_id: teamId, expected_record_version: expected })
    }
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    if (isForeignKeyViolation(error)) {
      throw configError('INVALID_REFERENCE', 'TEAM_REFERENCE_BROKEN',
        'department_id 在写入瞬间不再合法（并发删除）：请重读后重试。', { team_id: teamId })
    }
    rethrowConcurrent(error, '团队', teamId)
  }

  const updated = await readTeamView(client, input.tenantId, teamId, false)
  if (updated === null) {
    throw configError('INVARIANT_VIOLATION', 'TEAM_VANISHED', '更新后团队读不回来。', { team_id: teamId })
  }
  return { status: 'UPDATED', value: updated }
}

/**
 * 加一个团队成员（软关闭后可重新加入；重复加入同角色 = `UNCHANGED`）。
 * @param client - 事务内连接。
 * @param input - 见 {@link AddTeamMemberInput}。
 * @returns `{status, value}`（value 是更新后的团队视图）。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `INVALID_REFERENCE` / `ALREADY_EXISTS`。
 */
export async function addTeamMember(
  client: DatabaseClient,
  input: AddTeamMemberInput,
): Promise<CreateResult<TeamView>> {
  const teamId = requireUuid(input.teamId, 'team_id')
  const actorId = requireUuid(input.actorId, 'actor_id')
  const teamRole = requireTeamRole(input.teamRole, 'RECRUITER')
  const addedBy = input.addedByActorId === undefined
    ? null
    : requireUuid(input.addedByActorId, 'added_by_actor_id')

  const team = await readTeamView(client, input.tenantId, teamId, true)
  if (team === null) {
    throw configError('NOT_FOUND', 'TEAM_NOT_FOUND', '团队不存在，或不属于当前租户。', { team_id: teamId })
  }
  await assertHumanActors(client, input.tenantId, [actorId])

  const active = team.members.find((m) => m.actor_id === actorId && m.is_active)
  if (active !== undefined) {
    if (active.team_role === teamRole) return { status: 'UNCHANGED', value: team }
    throw configError('ALREADY_EXISTS', 'TEAM_MEMBER_ROLE_DIFFERS',
      '这个 actor 已经是本团队的在用成员，但 team_role 不同：先用 remove_member 移除，再按新角色重新加入。',
      { team_id: teamId, actor_id: actorId, current_team_role: active.team_role })
  }

  try {
    await client.query(
      `insert into recruitment.hiring_team_member
         (tenant_id, team_id, actor_id, team_role, added_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [input.tenantId, teamId, actorId, teamRole, addedBy],
    )
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    if (isUniqueViolation(error)) {
      // 并发重复加入：唯一键冲突已让事务 aborted（25P02），不能再重读 ——
      // 如实报 ALREADY_EXISTS；调用方在新事务里 get 会看到"已经有一条在用成员"。
      throw configError('ALREADY_EXISTS', 'TEAM_MEMBER_RACE',
        '这个 actor 的成员关系被并发创建了：请在新事务里 get 一次团队确认现状。',
        { team_id: teamId, actor_id: actorId })
    }
    if (isForeignKeyViolation(error)) {
      throw configError('INVALID_REFERENCE', 'TEAM_MEMBER_REFERENCE_BROKEN',
        'actor 在写入瞬间不再合法（并发删除或 kind 改成非 HUMAN）：请重读后重试。',
        { team_id: teamId, actor_id: actorId })
    }
    rethrowConcurrent(error, '团队成员', teamId)
  }

  const after = await readTeamView(client, input.tenantId, teamId, false)
  if (after === null) {
    throw configError('INVARIANT_VIOLATION', 'TEAM_VANISHED', '加入成员后团队读不回来。', { team_id: teamId })
  }
  return { status: 'CREATED', value: after }
}

/**
 * 移除一个团队成员（**软关闭**：`is_active = false`，不发 DELETE）。
 * @param client - 事务内连接。
 * @param input - `{tenantId, teamId, actorId}`。
 * @returns `{status, value}`；`UNCHANGED` = 本来就不是在用成员（幂等）。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND`。
 */
export async function removeTeamMember(
  client: DatabaseClient,
  input: RemoveTeamMemberInput,
): Promise<UpdateResult<TeamView>> {
  const teamId = requireUuid(input.teamId, 'team_id')
  const actorId = requireUuid(input.actorId, 'actor_id')

  // 这里要看**全部**成员（含已软关闭的）：才分得清"之前移除过，所以幂等"与
  // "从来没加入过，调用方假设错了"。
  const team = await readTeamView(client, input.tenantId, teamId, true, true)
  if (team === null) {
    throw configError('NOT_FOUND', 'TEAM_NOT_FOUND', '团队不存在，或不属于当前租户。', { team_id: teamId })
  }
  const active = team.members.find((m) => m.actor_id === actorId && m.is_active)
  if (active === undefined) {
    // 从没加入过 → 明确报错（不是幂等成功：调用方的假设错了）
    const everMember = team.members.some((m) => m.actor_id === actorId)
    if (!everMember) {
      throw configError('NOT_FOUND', 'TEAM_MEMBER_NOT_FOUND',
        '这个 actor 从来不是本团队的成员。', { team_id: teamId, actor_id: actorId })
    }
    return { status: 'UNCHANGED', value: await readTeamView(client, input.tenantId, teamId, false) ?? team }
  }

  await client.query(
    `update recruitment.hiring_team_member set is_active = false
      where tenant_id = $1 and team_id = $2 and actor_id = $3 and is_active`,
    [input.tenantId, teamId, actorId],
  )
  const after = await readTeamView(client, input.tenantId, teamId, false)
  if (after === null) {
    throw configError('INVARIANT_VIOLATION', 'TEAM_VANISHED', '移除成员后团队读不回来。', { team_id: teamId })
  }
  return { status: 'UPDATED', value: after }
}

/**
 * 列出本租户的团队（按 code 排序）。
 * @param client - 连接。
 * @param input - `{tenantId, includeInactive?, includeInactiveMembers?}`。
 * @returns 团队视图数组（每个都带成员）。
 */
export async function listTeams(
  client: DatabaseClient,
  input: ListTeamsInput,
): Promise<TeamView[]> {
  const { rows } = await client.query<TeamRow>(
    `select ${TEAM_COLUMNS}
       from recruitment.hiring_team t
       join recruitment.department d on d.id = t.department_id and d.tenant_id = t.tenant_id
      where t.tenant_id = $1 ${input.includeInactive === true ? '' : 'and t.is_active'}
      order by t.code`,
    [input.tenantId],
  )
  if (rows.length === 0) return []
  const byTeam = await readTeamMembers(
    client, input.tenantId, rows.map((r) => r.id), input.includeInactiveMembers === true,
  )
  return rows.map((row) => toTeamView(row, byTeam.get(row.id) ?? []))
}

/**
 * 读一个团队。
 * @param client - 连接。
 * @param input - `{tenantId, teamId, includeInactiveMembers?}`。
 * @returns 团队视图。
 * @throws RecruitmentToolError - `NOT_FOUND`。
 */
export async function getTeam(
  client: DatabaseClient,
  input: GetTeamInput,
): Promise<TeamView> {
  const teamId = requireUuid(input.teamId, 'team_id')
  const view = await readTeamView(client, input.tenantId, teamId, false, input.includeInactiveMembers === true)
  if (view === null) {
    throw configError('NOT_FOUND', 'TEAM_NOT_FOUND', '团队不存在，或不属于当前租户。', { team_id: teamId })
  }
  return view
}

// =====================================================================
//  流水线模板（pipeline template）
// =====================================================================

/**
 * 建一个流水线模板（幂等：同 code 同内容 → `UNCHANGED`）。
 *
 * 新建时**没有任何阶段**（阶段各自加：`addPipelineStage`）。刻意不把"阶段数组"
 * 塞进入参：本仓工具入参只支持标量/字符串数组（`src/tools/args.ts` 的
 * `ParamKind`），嵌套对象会被"严格入参"拒掉；而把阶段压成 `"S6@1"` 这种字符串
 * 编码会让服务端校验退化成解析文本 —— 每加一步是一条独立的、可版本控制的写。
 * @param client - 事务内连接。
 * @param input - 见 {@link CreatePipelineInput}。
 * @returns `{status, value}`。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `ALREADY_EXISTS`。
 */
export async function createPipeline(
  client: DatabaseClient,
  input: CreatePipelineInput,
): Promise<CreateResult<PipelineTemplateView>> {
  const code = requireCode(input.code)
  const name = requireName(input.name, 'name')
  const description = optionalDescription(input.description) ?? null
  const createdBy = input.createdByActorId === undefined
    ? null
    : requireUuid(input.createdByActorId, 'created_by_actor_id')

  const { rows: existingRows } = await client.query<PipelineRow>(
    `select ${PIPELINE_COLUMNS} from recruitment.pipeline_template
      where tenant_id = $1 and code = $2 for update`,
    [input.tenantId, code],
  )
  const existing = existingRows[0]
  if (existing !== undefined) {
    const same = existing.name === name
      && (existing.description ?? null) === description
      && existing.is_active
    if (same) {
      const { stagesByPipeline, refs } = await readPipelineStructure(client, input.tenantId, [existing.id])
      return { status: 'UNCHANGED', value: toPipelineView(existing, stagesByPipeline.get(existing.id) ?? [], refs) }
    }
    throw configError('ALREADY_EXISTS', 'PIPELINE_CODE_TAKEN',
      '这个 code 已被本租户的另一个流水线模板占用，且内容不同：改内容请用 update，加阶段请用 add_stage。',
      { pipeline_template_id: existing.id, record_version: existing.record_version, code })
  }

  try {
    const { rows } = await client.query<PipelineRow>(
      `insert into recruitment.pipeline_template
         (tenant_id, code, name, description, created_by_actor_id)
       values ($1, $2, $3, $4, $5)
       returning ${PIPELINE_COLUMNS}`,
      [input.tenantId, code, name, description, createdBy],
    )
    const row = rows[0]
    if (row === undefined) {
      throw configError('INVARIANT_VIOLATION', 'PIPELINE_INSERT_NO_ROW', '插入流水线模板没有返回行。', { code })
    }
    return { status: 'CREATED', value: toPipelineView(row, [], []) }
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    if (isUniqueViolation(error)) {
      throw configError('ALREADY_EXISTS', 'PIPELINE_CODE_RACE',
        '同一个 code 的流水线模板被并发创建了：先 get 一次确认现状。', { code })
    }
    rethrowConcurrent(error, '流水线模板', code)
  }
}

/**
 * 改一个流水线模板的本体（版本并发控制；阶段结构改动走 add_stage）。
 * @param client - 事务内连接。
 * @param input - 见 {@link UpdatePipelineInput}。
 * @returns 更新后的流水线视图。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `VERSION_CONFLICT`。
 */
export async function updatePipeline(
  client: DatabaseClient,
  input: UpdatePipelineInput,
): Promise<UpdateResult<PipelineTemplateView>> {
  const pipelineId = requireUuid(input.pipelineTemplateId, 'pipeline_template_id')
  const expected = requireRecordVersion(input.expectedRecordVersion)
  const hasAnyChange = input.name !== undefined || input.description !== undefined
    || input.isActive !== undefined
  if (!hasAnyChange) {
    throw configError('INVALID_ARGS', 'NO_CHANGES_REQUESTED',
      'update 至少要改一个字段（name / description / is_active）。')
  }

  const current = await readPipelineView(client, input.tenantId, pipelineId, true)
  if (current === null) {
    throw configError('NOT_FOUND', 'PIPELINE_NOT_FOUND',
      '流水线模板不存在，或不属于当前租户。', { pipeline_template_id: pipelineId })
  }
  if (current.record_version !== expected) {
    throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
      '流水线模板已被别人改过：record_version 与 expected_record_version 不一致，本调用零写入。',
      { pipeline_template_id: pipelineId, expected_record_version: expected, actual_record_version: current.record_version })
  }

  const nextName = input.name === undefined ? current.name : requireName(input.name, 'name')
  const nextDescription = input.description === undefined
    ? (current.description ?? null)
    : optionalDescription(input.description) ?? null
  const nextActive = input.isActive === undefined ? current.is_active : input.isActive

  if (nextName === current.name && nextDescription === (current.description ?? null) && nextActive === current.is_active) {
    return { status: 'UNCHANGED', value: current }  // 零 UPDATE：幂等
  }

  const sets: string[] = []
  const params: unknown[] = [pipelineId, input.tenantId]
  const push = (column: string, value: unknown): void => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (nextName !== current.name) push('name', nextName)
  if (nextDescription !== (current.description ?? null)) push('description', nextDescription)
  if (nextActive !== current.is_active) push('is_active', nextActive)

  try {
    const { rows } = await client.query<{ id: string }>(
      `update recruitment.pipeline_template set ${sets.join(', ')}
        where id = $1 and tenant_id = $2 and record_version = $${params.length + 1}
        returning id`,
      [...params, expected],
    )
    if (rows[0] === undefined) {
      throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
        '更新 0 行：流水线模板的 record_version 与 expected_record_version 不一致（并发修改）。',
        { pipeline_template_id: pipelineId, expected_record_version: expected })
    }
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    rethrowConcurrent(error, '流水线模板', pipelineId)
  }

  const updated = await readPipelineView(client, input.tenantId, pipelineId, false)
  if (updated === null) {
    throw configError('INVARIANT_VIOLATION', 'PIPELINE_VANISHED', '更新后流水线模板读不回来。',
      { pipeline_template_id: pipelineId })
  }
  return { status: 'UPDATED', value: updated }
}

/**
 * 给流水线模板加一步（阶段必须已在 `stage_catalog`；引用模板必须已存在）。
 *
 * 这是一次**聚合写**：阶段插入 + 模板引用插入 + 模板本体 `record_version` +1
 * （阶段结构是模板的组成部分，所以版本挂在模板上；成员关系则挂在成员行上，
 * 两者不是同一个粒度，见 contracts/tenant-config/tool-contracts.md §6）。
 * @param client - 事务内连接。
 * @param input - 见 {@link AddPipelineStageInput}。
 * @returns 更新后的流水线视图（`record_version` 已 +1）。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `VERSION_CONFLICT` /
 *   `INVALID_REFERENCE` / `ALREADY_EXISTS`。
 */
export async function addPipelineStage(
  client: DatabaseClient,
  input: AddPipelineStageInput,
): Promise<PipelineTemplateView> {
  const pipelineId = requireUuid(input.pipelineTemplateId, 'pipeline_template_id')
  const expected = requireRecordVersion(input.expectedRecordVersion)
  if (typeof input.stageCode !== 'string' || input.stageCode.trim() === '') {
    throw configError('INVALID_ARGS', 'STAGE_CODE_REQUIRED', 'stage_code 必填（例如 S6）。')
  }
  const stageCode = input.stageCode.trim()
  if (input.sortOrder !== undefined && (!Number.isInteger(input.sortOrder) || input.sortOrder < 1 || input.sortOrder > 100)) {
    throw configError('INVALID_ARGS', 'SORT_ORDER_INVALID', 'sort_order 必须是 1–100 的整数。')
  }
  const templateIds = normalizeUuidList(input.interviewTemplateVersionIds, 'interview_template_version_ids')
  const isRequired = input.isRequired === undefined ? true : input.isRequired

  const current = await readPipelineView(client, input.tenantId, pipelineId, true)
  if (current === null) {
    throw configError('NOT_FOUND', 'PIPELINE_NOT_FOUND',
      '流水线模板不存在，或不属于当前租户。', { pipeline_template_id: pipelineId })
  }
  if (current.record_version !== expected) {
    throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
      '流水线模板已被别人改过：record_version 与 expected_record_version 不一致，本调用零写入。',
      { pipeline_template_id: pipelineId, expected_record_version: expected, actual_record_version: current.record_version })
  }

  // 服务端引用校验（DB 复合外键是并发兜底）
  await assertStageCodeExists(client, input.tenantId, stageCode)
  await assertTemplateVersionsExist(client, input.tenantId, templateIds)

  const sortOrder = input.sortOrder
    ?? (current.stages.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1)
  if (sortOrder > 100) {
    throw configError('INVALID_ARGS', 'SORT_ORDER_EXHAUSTED',
      '这份模板的阶段序号已用满（1–100）：先确认是否真的要这么多步。',
      { pipeline_template_id: pipelineId })
  }

  let stageId: string
  try {
    const { rows } = await client.query<{ id: string }>(
      `insert into recruitment.pipeline_template_stage
         (tenant_id, pipeline_template_id, stage_code, sort_order)
       values ($1, $2, $3, $4)
       returning id`,
      [input.tenantId, pipelineId, stageCode, sortOrder],
    )
    const id = rows[0]?.id
    if (id === undefined) {
      throw configError('INVARIANT_VIOLATION', 'STAGE_INSERT_NO_ROW', '插入阶段没有返回行。', { stage_code: stageCode })
    }
    stageId = id
  } catch (error) {
    if (error instanceof RecruitmentToolError) throw error
    if (isUniqueViolation(error)) {
      const dupCode = current.stages.some((s) => s.stage_code === stageCode)
      const dupOrder = current.stages.some((s) => s.sort_order === sortOrder)
      throw configError('ALREADY_EXISTS', 'PIPELINE_STAGE_EXISTS',
        dupCode
          ? '这份模板里已经有这个阶段码了（同一阶段不能出现两次：否则"现在第几阶段"无法回答）。'
          : dupOrder
            ? '这个 sort_order 已被这份模板的另一步占用。'
            : '阶段插入撞上唯一键（并发修改）。',
        { pipeline_template_id: pipelineId, stage_code: stageCode, sort_order: sortOrder })
    }
    if (isForeignKeyViolation(error)) {
      throw configError('INVALID_REFERENCE', 'STAGE_CODE_UNKNOWN',
        'stage_code 在写入瞬间不在本租户的 stage_catalog 里：请重读 stage_catalog 后重试。',
        { stage_code: stageCode })
    }
    rethrowConcurrent(error, '流水线模板', pipelineId)
  }

  if (templateIds.length > 0) {
    try {
      await client.query(
        `insert into recruitment.pipeline_template_stage_template
           (tenant_id, stage_id, interview_template_version_id, is_required)
         select $1, $2, t.id, $4 from unnest($3::uuid[]) as t(id)`,
        [input.tenantId, stageId, templateIds, isRequired],
      )
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw configError('INVALID_REFERENCE', 'TEMPLATE_VERSION_NOT_FOUND',
          '引用的面试模板版本在写入瞬间不存在（并发删除）：请重读后重试。',
          { interview_template_version_ids: templateIds })
      }
      if (isUniqueViolation(error)) {
        throw configError('ALREADY_EXISTS', 'STAGE_TEMPLATE_DUPLICATED',
          '同一个面试模板版本在这条阶段上重复引用。', { stage_id: stageId })
      }
      rethrowConcurrent(error, '阶段模板引用', stageId)
    }
  }

  // 聚合版本 +1：阶段结构变了，模板本体的 record_version 必须反映出来。
  // 不写 record_version（fn_touch 自增）；只 touch updated_at。
  const { rows: bumped } = await client.query<{ record_version: number }>(
    `update recruitment.pipeline_template set updated_at = now()
      where id = $1 and tenant_id = $2 and record_version = $3
      returning record_version`,
    [pipelineId, input.tenantId, expected],
  )
  if (bumped[0] === undefined) {
    throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
      '补阶段后模板版本未推进（并发修改）：本次调用整体回滚。',
      { pipeline_template_id: pipelineId, expected_record_version: expected })
  }

  const updated = await readPipelineView(client, input.tenantId, pipelineId, false)
  if (updated === null) {
    throw configError('INVARIANT_VIOLATION', 'PIPELINE_VANISHED', '加阶段后流水线模板读不回来。',
      { pipeline_template_id: pipelineId })
  }
  return updated
}

/**
 * 给已有阶段挂一个面试模板版本（聚合版本同样 +1）。
 * @param client - 事务内连接。
 * @param input - 见 {@link AddStageTemplateInput}。
 * @returns 更新后的流水线视图。
 * @throws RecruitmentToolError - `INVALID_ARGS` / `NOT_FOUND` / `VERSION_CONFLICT` /
 *   `INVALID_REFERENCE` / `ALREADY_EXISTS`。
 */
export async function addStageTemplate(
  client: DatabaseClient,
  input: AddStageTemplateInput,
): Promise<PipelineTemplateView> {
  const stageId = requireUuid(input.stageId, 'stage_id')
  const templateVersionId = requireUuid(input.interviewTemplateVersionId, 'interview_template_version_id')
  const expected = requireRecordVersion(input.expectedRecordVersion)
  const isRequired = input.isRequired === undefined ? true : input.isRequired

  const { rows: stageRows } = await client.query<{ pipeline_template_id: string }>(
    'select pipeline_template_id from recruitment.pipeline_template_stage where id = $1 and tenant_id = $2',
    [stageId, input.tenantId],
  )
  const pipelineId = stageRows[0]?.pipeline_template_id
  if (pipelineId === undefined) {
    throw configError('NOT_FOUND', 'PIPELINE_STAGE_NOT_FOUND',
      '阶段不存在，或不属于当前租户。', { stage_id: stageId })
  }

  const current = await readPipelineView(client, input.tenantId, pipelineId, true)
  if (current === null) {
    throw configError('NOT_FOUND', 'PIPELINE_NOT_FOUND',
      '流水线模板不存在，或不属于当前租户。', { pipeline_template_id: pipelineId })
  }
  if (current.record_version !== expected) {
    throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
      '流水线模板已被别人改过：record_version 与 expected_record_version 不一致，本调用零写入。',
      { pipeline_template_id: pipelineId, expected_record_version: expected, actual_record_version: current.record_version })
  }

  await assertTemplateVersionsExist(client, input.tenantId, [templateVersionId])

  try {
    await client.query(
      `insert into recruitment.pipeline_template_stage_template
         (tenant_id, stage_id, interview_template_version_id, is_required)
       values ($1, $2, $3, $4)`,
      [input.tenantId, stageId, templateVersionId, isRequired],
    )
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw configError('ALREADY_EXISTS', 'STAGE_TEMPLATE_DUPLICATED',
        '这条阶段已经引用过这个面试模板版本了。', { stage_id: stageId, interview_template_version_id: templateVersionId })
    }
    if (isForeignKeyViolation(error)) {
      throw configError('INVALID_REFERENCE', 'TEMPLATE_VERSION_NOT_FOUND',
        '引用的面试模板版本在写入瞬间不存在（并发删除）：请重读后重试。',
        { interview_template_version_id: templateVersionId })
    }
    rethrowConcurrent(error, '阶段模板引用', stageId)
  }

  const { rows: bumped } = await client.query<{ record_version: number }>(
    `update recruitment.pipeline_template set updated_at = now()
      where id = $1 and tenant_id = $2 and record_version = $3
      returning record_version`,
    [pipelineId, input.tenantId, expected],
  )
  if (bumped[0] === undefined) {
    throw configError('VERSION_CONFLICT', 'PIPELINE_RECORD_VERSION_MISMATCH',
      '挂模板后模板版本未推进（并发修改）：本次调用整体回滚。',
      { pipeline_template_id: pipelineId, expected_record_version: expected })
  }

  const updated = await readPipelineView(client, input.tenantId, pipelineId, false)
  if (updated === null) {
    throw configError('INVARIANT_VIOLATION', 'PIPELINE_VANISHED', '挂模板后流水线模板读不回来。',
      { pipeline_template_id: pipelineId })
  }
  return updated
}

/**
 * 列出本租户的流水线模板（按 code 排序，每个都带阶段）。
 * @param client - 连接。
 * @param input - `{tenantId, includeInactive?}`。
 * @returns 流水线视图数组。
 */
export async function listPipelines(
  client: DatabaseClient,
  input: ListPipelinesInput,
): Promise<PipelineTemplateView[]> {
  const { rows } = await client.query<PipelineRow>(
    `select ${PIPELINE_COLUMNS} from recruitment.pipeline_template
      where tenant_id = $1 ${input.includeInactive === true ? '' : 'and is_active'}
      order by code`,
    [input.tenantId],
  )
  if (rows.length === 0) return []
  const { stagesByPipeline, refs } = await readPipelineStructure(
    client, input.tenantId, rows.map((r) => r.id),
  )
  return rows.map((row) => toPipelineView(row, stagesByPipeline.get(row.id) ?? [], refs))
}

/**
 * 读一个流水线模板。
 * @param client - 连接。
 * @param input - `{tenantId, pipelineTemplateId}`。
 * @returns 流水线视图。
 * @throws RecruitmentToolError - `NOT_FOUND`。
 */
export async function getPipeline(
  client: DatabaseClient,
  input: GetPipelineInput,
): Promise<PipelineTemplateView> {
  const pipelineId = requireUuid(input.pipelineTemplateId, 'pipeline_template_id')
  const view = await readPipelineView(client, input.tenantId, pipelineId, false)
  if (view === null) {
    throw configError('NOT_FOUND', 'PIPELINE_NOT_FOUND',
      '流水线模板不存在，或不属于当前租户。', { pipeline_template_id: pipelineId })
  }
  return view
}

// =====================================================================
//  工作空间设置（docs/34 §二.2-5；docs/24 配置产品化 D-112）
//
//  三组设置全部落在既有 `recruitment.business_config`（追加版本表，config_key
//  自由正则），**不新建表、不加迁移、不新增工具**。本节只放**纯校验函数**，
//  供 HTTP 写入口（Host Action）与读取投影共用同一份规则（服务端真相，不靠前端）。
//
//  口径：
//   * 外部连接状态（邮箱 / 飞书日历 / 飞书妙记）——**只读展示**，值来自现有
//     配置解析（resolveMailConfig / resolveFeishuConnector），缺配置 = NOT_CONFIGURED；
//     它**没有可写的 config_key**，本文件不为它提供校验函数（不能假装已连接）。
//   * agent_silent_delegation —— 布尔开关，严格 boolean。
//   * sla_thresholds —— 对象：screening_hours / scorecard_hours，整数 1..720（含）。
// =====================================================================

/** 可写设置的 config_key 封闭集（外部连接状态只读，不在此列）。 */
export const WORKSPACE_SETTING_KEYS = ['agent_silent_delegation', 'sla_thresholds'] as const
/** 一个可写设置键。 */
export type WorkspaceSettingKey = (typeof WORKSPACE_SETTING_KEYS)[number]

/** SLA 阈值字段名封闭集。 */
export const SLA_THRESHOLD_FIELDS = ['screening_hours', 'scorecard_hours'] as const
/** SLA 阈值（校验后的形状）。 */
export interface SlaThresholds {
  readonly screening_hours: number
  readonly scorecard_hours: number
}

/** SLA 小时数闭区间（含端点）：1 小时 .. 720 小时（30 天）。 */
export const SLA_HOURS_MIN = 1
export const SLA_HOURS_MAX = 720

/** 人工确认原话长度上限（与 `http/email-send.ts` 的 confirmation_text 同口径）。 */
export const SETTINGS_CONFIRMATION_TEXT_MAX = 2000

/**
 * 判断一个字符串是不是可写设置键。
 * @param value - 任意值。
 */
export function isWorkspaceSettingKey(value: unknown): value is WorkspaceSettingKey {
  return typeof value === 'string' && (WORKSPACE_SETTING_KEYS as readonly string[]).includes(value)
}

/**
 * 校验 `agent_silent_delegation`（严格布尔；`true`/`false` 之外的任何值都拒）。
 * @param value - 调用方给的值。
 * @returns 布尔值。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function validateSilentDelegation(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw configError('INVALID_ARGS', 'SILENT_DELEGATION_NOT_BOOLEAN',
      'agent_silent_delegation 必须是布尔值（true / false）。',
      { got: typeof value === 'string' ? value.slice(0, 40) : typeof value })
  }
  return value
}

/**
 * 校验 SLA 小时数（整数，闭区间 [1, 720]）。
 * @param value - 调用方给的值。
 * @param field - 字段名（拼进 reason_code / 错误）。
 * @returns 整数小时数。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
function validateSlaHours(value: unknown, field: 'screening_hours' | 'scorecard_hours'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw configError('INVALID_ARGS', `${field.toUpperCase()}_NOT_INTEGER`,
      `${field} 必须是整数小时数。`, { field, got: typeof value })
  }
  if (value < SLA_HOURS_MIN || value > SLA_HOURS_MAX) {
    throw configError('INVALID_ARGS', `${field.toUpperCase()}_OUT_OF_RANGE`,
      `${field} 必须在 ${SLA_HOURS_MIN}..${SLA_HOURS_MAX} 之间（含）。`,
      { field, min: SLA_HOURS_MIN, max: SLA_HOURS_MAX, got: value })
  }
  return value
}

/**
 * 校验并归一化 `sla_thresholds`：顶层必须是对象；两个字段**都必须给**、都是整数且在范围内；
 * 拒绝未知键（防止悄悄塞进别的阈值）。
 * @param value - 调用方给的值。
 * @returns 归一化后的 `{screening_hours, scorecard_hours}`。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function validateSlaThresholds(value: unknown): SlaThresholds {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError('INVALID_ARGS', 'SLA_THRESHOLDS_NOT_OBJECT', 'sla_thresholds 必须是对象。')
  }
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !(SLA_THRESHOLD_FIELDS as readonly string[]).includes(key)).sort()
  if (unknown.length > 0) {
    throw configError('INVALID_ARGS', 'SLA_THRESHOLDS_UNKNOWN_FIELD',
      `sla_thresholds 不接受未知字段：${unknown.join(', ')}。`, { unknown })
  }
  const missing = SLA_THRESHOLD_FIELDS.filter((key) => !Object.hasOwn(raw, key))
  if (missing.length > 0) {
    throw configError('INVALID_ARGS', 'SLA_THRESHOLDS_MISSING_FIELD',
      `sla_thresholds 缺必填字段：${missing.join(', ')}。`, { missing: [...missing] })
  }
  return {
    screening_hours: validateSlaHours(raw.screening_hours, 'screening_hours'),
    scorecard_hours: validateSlaHours(raw.scorecard_hours, 'scorecard_hours'),
  }
}

/**
 * 按 key 校验一条设置值（写入口的唯一校验入口）。
 * @param key - 可写设置键。
 * @param value - 调用方给的值。
 * @returns 归一化后的 payload 值（可直接塞进 business_config.payload 的 `value` 字段）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（含未知 key）。
 */
export function validateWorkspaceSettingValue(key: unknown, value: unknown): boolean | SlaThresholds {
  if (!isWorkspaceSettingKey(key)) {
    throw configError('INVALID_ARGS', 'SETTING_KEY_UNKNOWN',
      `未知或只读的设置键：${typeof key === 'string' ? key : typeof key}（可写：${WORKSPACE_SETTING_KEYS.join(', ')}）。`,
      { allowed: [...WORKSPACE_SETTING_KEYS] })
  }
  return key === 'agent_silent_delegation' ? validateSilentDelegation(value) : validateSlaThresholds(value)
}

/**
 * 校验人工确认原话（`confirmation_text`）：1..2000 非空字符串。
 * 哈希由服务端算（调用方只给原话，不许传哈希）。
 * @param value - 调用方给的值。
 * @returns 去首尾空白后的原话。
 * @throws RecruitmentToolError - `INVALID_ARGS`。
 */
export function validateConfirmationText(value: unknown): string {
  if (typeof value !== 'string') {
    throw configError('INVALID_ARGS', 'CONFIRMATION_TEXT_NOT_STRING', 'confirmation_text 必须是字符串（人的确认原话）。')
  }
  const trimmed = value.trim()
  if (trimmed.length < 1 || value.length > SETTINGS_CONFIRMATION_TEXT_MAX) {
    throw configError('INVALID_ARGS', 'CONFIRMATION_TEXT_LENGTH',
      `confirmation_text 必须是去空白后非空、且不超过 ${SETTINGS_CONFIRMATION_TEXT_MAX} 字符。`)
  }
  return trimmed
}
