// `recruitment_config_*` 三个工具共用的**契约碎片**（schema 片段 + 渲染）。
//
// 为什么单独一个文件：三个工具的出参里有一半形状完全相同（labels、role、team、
// pipeline 的嵌套结构），复制三份就一定会有一份漂移。这里只放"形状与渲染"，
// 不放任何业务判定——判定全在 `src/domain/tenant-config.ts`（单一实现）。
//
// 文件命名落在本 lane 的写范围 `src/tools/config-*.ts` 内（config-shared.ts）。
//
// DSH 出参 schema 只支持受支持的子集（type/properties/required/additionalProperties/
// items/enum/description），**没有 type 数组、没有 type:'null'** —— 所以所有
// "可能没有"的字段一律**省略键**，不用 null 占位（与 stage-advance / screening 同一约定）。

import type { ThreeAxisLabels } from './candidate-get.ts'
import type {
  InterviewTemplateRefView,
  PipelineStageView,
  PipelineTemplateView,
  RoleView,
  TeamMemberView,
  TeamView,
} from '../domain/tenant-config.ts'

// =====================================================================
//  出参状态（封闭集）
// =====================================================================

/**
 * 三个配置工具共用的 `status` 封闭集。
 *
 *   * `CREATED`   —— 新建成功（create / add_member）
 *   * `UNCHANGED` —— 幂等命中：库里已有完全一致的内容，**本调用零写**
 *   * `UPDATED`   —— 真的改了（update / remove_member / add_stage / add_stage_template）
 *   * `OK`        —— 只读操作（get / list）
 */
export const CONFIG_STATUSES = ['CREATED', 'UNCHANGED', 'UPDATED', 'OK'] as const

/** 一次配置调用的结论码。 */
export type ConfigStatus = (typeof CONFIG_STATUSES)[number]

/** `status` 的 schema 节点（三个工具共用）。 */
export const STATUS_SCHEMA: Record<string, unknown> = {
  type: 'string',
  enum: [...CONFIG_STATUSES],
  description: 'CREATED（新建）/ UNCHANGED（幂等命中，零写）/ UPDATED（已改）/ OK（只读）',
}

// =====================================================================
//  R4 三维标签（走**同一份**判定实现 buildThreeAxisLabels，不在本文件另写）
// =====================================================================

/**
 * labels 的 schema 节点。
 *
 * 三维正交（`db/migrations` 之外的 R4 铁律）：provenance 回答"数据真假"、
 * trigger 回答"谁触发"、connection 回答"产品能不能自己读外部系统"。
 * 本组工具是**内部配置**：trigger 恒 MANUAL、connection 恒 NOT_CONNECTED；
 * provenance 由租户事实判定（演示租户 = FIXTURE），不写死 'LIVE'
 * （`test/unit/label-honesty.test.ts` 就是这条的机检）。
 */
export const LABELS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'], description: '数据真假：演示租户 = FIXTURE' },
    trigger: { type: 'string', enum: ['MANUAL'], description: '怎么触发的：本组工具只由人/模型显式调用' },
    connection: { type: 'string', enum: ['NOT_CONNECTED'], description: '本组工具不接任何外部系统' },
  },
  required: ['provenance', 'trigger', 'connection'],
  additionalProperties: false,
}

/**
 * 渲染一行 R4 标签。
 * @param labels - 三维标签。
 * @returns 一行文本。
 */
export function labelsLine(labels: ThreeAxisLabels): string {
  return `  labels: provenance=${labels.provenance} trigger=${labels.trigger} connection=${labels.connection}`
}

// =====================================================================
//  角色
// =====================================================================

/** 角色视图的 schema 节点。 */
export const ROLE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    role_id: { type: 'string', description: '角色 id（UUID）' },
    code: { type: 'string', description: '角色码（不可改；改 code = 换一个角色）' },
    name: { type: 'string' },
    description: { type: 'string', description: '描述；没有就省略此键' },
    permission_scopes: {
      type: 'array',
      items: { type: 'string' },
      description: '权限范围（已去重、已排序的集合）；至少 1 个（历史种子行可能是空数组）',
    },
    is_active: { type: 'boolean', description: 'false = 已软关闭（配置不物理删除）' },
    record_version: { type: 'integer', description: '乐观并发版本（更新时回传 expected_record_version）' },
    created_by_actor_id: { type: 'string', description: '创建人 actor id；未记录时省略' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['role_id', 'code', 'name', 'permission_scopes', 'is_active', 'record_version', 'created_at', 'updated_at'],
  additionalProperties: false,
}

/**
 * 渲染一个角色（2 行）。
 * @param role - 角色视图。
 * @returns 文本行。
 */
export function renderRole(role: RoleView): string[] {
  // O1 残留：人读正文只给业务标识（code / name）；role_id 完整值由 tools 的
  // machine arguments 区承载（模型要拿它调 update/get）。
  return [
    `  role code=${role.code} name=${role.name}`
      + ` record_version=${role.record_version}${role.is_active ? '' : ' (inactive)'}`,
    `    permission_scopes: ${role.permission_scopes.length === 0 ? '(none)' : role.permission_scopes.join(', ')}`
      + `${role.description === undefined ? '' : ` · ${role.description}`}`,
  ]
}

// =====================================================================
//  团队
// =====================================================================

/** 团队成员的 schema 节点。 */
export const TEAM_MEMBER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    actor_id: { type: 'string' },
    display_name: { type: 'string' },
    team_role: {
      type: 'string',
      enum: ['HIRING_MANAGER', 'RECRUITER', 'COORDINATOR', 'INTERVIEWER', 'APPROVER'],
    },
    is_active: { type: 'boolean', description: 'false = 已移出团队（软关闭，保留历史）' },
    added_at: { type: 'string' },
  },
  required: ['actor_id', 'display_name', 'team_role', 'is_active', 'added_at'],
  additionalProperties: false,
}

/** 团队视图的 schema 节点。 */
export const TEAM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    team_id: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    department_id: { type: 'string', description: '所属部门（团队必须挂在已存在的部门下）' },
    department_name: { type: 'string' },
    description: { type: 'string', description: '描述；没有就省略此键' },
    is_active: { type: 'boolean' },
    record_version: { type: 'integer' },
    members: { type: 'array', items: TEAM_MEMBER_SCHEMA },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['team_id', 'code', 'name', 'department_id', 'department_name', 'is_active', 'record_version', 'members', 'created_at', 'updated_at'],
  additionalProperties: false,
}

/**
 * 渲染一个团队（1 行头 + 每成员 1 行）。
 * @param team - 团队视图。
 * @returns 文本行。
 */
export function renderTeam(team: TeamView): string[] {
  // O1 残留：只给业务标识（code / name / 部门名 / 成员显示名）；完整 id 由 config 工具的
  // machine arguments 区承载。
  const lines = [
    `  team code=${team.code} name=${team.name}`
      + ` department=${team.department_name}`
      + ` record_version=${team.record_version}${team.is_active ? '' : ' (inactive)'}`,
  ]
  if (team.members.length === 0) lines.push('    members: (none)')
  for (const member of team.members) lines.push(memberLine(member))
  return lines
}

/**
 * 渲染一个团队成员。
 * @param member - 成员视图。
 * @returns 一行文本。
 */
function memberLine(member: TeamMemberView): string {
  return `    member ${member.display_name} team_role=${member.team_role}`
    + `${member.is_active ? '' : ' (removed)'}`
}

// =====================================================================
//  流水线模板
// =====================================================================

/** 阶段引用的面试模板版本 schema。 */
export const INTERVIEW_TEMPLATE_REF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    interview_template_version_id: { type: 'string', description: 'interview_template_version.id（钉的是具体版本）' },
    template_code: { type: 'string' },
    version_no: { type: 'integer' },
    is_required: { type: 'boolean' },
  },
  required: ['interview_template_version_id', 'template_code', 'version_no', 'is_required'],
  additionalProperties: false,
}

/** 流水线阶段 schema。 */
export const PIPELINE_STAGE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    stage_id: { type: 'string' },
    stage_code: { type: 'string', description: '阶段码：必须是本租户 stage_catalog 里已存在的 code' },
    stage_name: { type: 'string', description: '阶段名（来自 stage_catalog）' },
    sort_order: { type: 'integer', description: '这份流程里的第几步（与目录的 sort_order 不同轴）' },
    interview_templates: { type: 'array', items: INTERVIEW_TEMPLATE_REF_SCHEMA },
  },
  required: ['stage_id', 'stage_code', 'stage_name', 'sort_order', 'interview_templates'],
  additionalProperties: false,
}

/** 流水线模板视图的 schema 节点。 */
export const PIPELINE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pipeline_template_id: { type: 'string' },
    code: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string', description: '描述；没有就省略此键' },
    is_active: { type: 'boolean' },
    record_version: {
      type: 'integer',
      description: '模板本体的聚合版本：加/删阶段与阶段挂模板都会 +1（结构是模板的组成部分）',
    },
    stages: { type: 'array', items: PIPELINE_STAGE_SCHEMA },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
  },
  required: ['pipeline_template_id', 'code', 'name', 'is_active', 'record_version', 'stages', 'created_at', 'updated_at'],
  additionalProperties: false,
}

/**
 * 渲染一个流水线模板（1 行头 + 每阶段 1 行 + 每阶段模板引用 1 行）。
 * @param pipeline - 流水线视图。
 * @returns 文本行。
 */
export function renderPipeline(pipeline: PipelineTemplateView): string[] {
  // O1 残留：只给业务标识（code / name / 阶段码+名 / 模板码+版本）；完整 id 由 config 工具的
  // machine arguments 区承载。
  const lines = [
    `  pipeline code=${pipeline.code} name=${pipeline.name}`
      + ` record_version=${pipeline.record_version}${pipeline.is_active ? '' : ' (inactive)'}`,
  ]
  if (pipeline.stages.length === 0) lines.push('    stages: (none)')
  for (const stage of pipeline.stages) {
    lines.push(`    stage ${stage.sort_order}. ${stage.stage_code} (${stage.stage_name})`)
    if (stage.interview_templates.length === 0) {
      lines.push('      interview_templates: (none)')
    } else {
      for (const ref of stage.interview_templates) lines.push(refLine(ref))
    }
  }
  return lines
}

/**
 * 渲染一条"阶段 → 面试模板版本"引用。
 * @param ref - 引用视图。
 * @returns 一行文本。
 */
function refLine(ref: InterviewTemplateRefView): string {
  return `      interview_template ${ref.template_code} v${ref.version_no}`
    + `${ref.is_required ? ' (required)' : ' (optional)'}`
}

/**
 * 渲染一个阶段（用于 add_stage 的回显片段）。
 * @param stage - 阶段视图。
 * @returns 一行文本。
 */
export function renderStage(stage: PipelineStageView): string {
  return `  stage ${stage.sort_order}. ${stage.stage_code} (${stage.stage_name})`
}
