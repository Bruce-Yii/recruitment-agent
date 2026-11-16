// recruitment_config_team —— 企业自建**招聘团队**的唯一写入口。
//
// 形状权威：`contracts/tenant-config/tool-contracts.md`（下称 TC）。
// 领域实现：`src/domain/tenant-config.ts`（校验 / 幂等 / 版本并发，全部在那儿）。
// 本文件只做胶水：入参收窄 + 按 `operation` 分派 + 事务/身份 + R4 标签 + 渲染。
//
// 与团队相关的三条**服务端**校验（都不靠模型自觉）：
//   1. `department_id` 必须是本租户**已存在**的部门（DB 复合外键 + 领域预检）；
//   2. 每个成员 actor 必须存在、同租户、且 `kind='HUMAN'`
//      （DB：COMPOSITE FK (actor_id, tenant_id, actor_kind='HUMAN') → actor(id, tenant_id, kind)）；
//   3. 同一团队里同一个 actor 只能有一条**在用**成员记录（部分唯一索引；软关闭后可重入）。
//
// 成员变更的版本语义（刻意与流水线的"聚合版本"不同，TC §6 有对照表）：
//   团队本体的 `record_version` 只管 name / description / department / is_active；
//   加/移成员**不动**团队版本 —— 成员是"关系行"（与 0001 的 actor_role 同一粒度），
//   各自带 is_active 与 created_at。流水线的阶段结构则是模板本体的一部分，所以
//   add_stage 会让模板 record_version +1。两者不是同一个粒度，不强行统一。
//
// 它 **不** 做什么（TC §0）：
//   * 不建 actor / 部门（只引用已存在的）；
//   * 不发 DELETE（移除成员 = is_active=false，团队退场 = is_active=false）；
//   * 不做权限判定（team_role 只是"在这个小组里干什么"的标签）。

import { parseContractArgs, toParameterSchema } from './args.ts'
import { machineArgumentLines, type MachineArgument } from './render-ref.ts'
import type { ParamMap } from './args.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import {
  closePool,
  createPool,
  withActor,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'
import {
  TEAM_ROLES,
  addTeamMember,
  createTeam,
  getTeam,
  listTeams,
  removeTeamMember,
  updateTeam,
  type TeamView,
} from '../domain/tenant-config.ts'
import {
  TEAM_SCHEMA,
  STATUS_SCHEMA,
  LABELS_SCHEMA,
  labelsLine,
  renderTeam,
  type ConfigStatus,
} from './config-shared.ts'

/** 工具名（`test/` 与总控注册时都按这个名字找）。 */
export const CONFIG_TEAM_TOOL_NAME = 'recruitment_config_team'

/** 出参契约版本（TC §4：形状变了就要 +1）。 */
const CONTRACT_VERSION = '1.0.0'

/** 本工具的动作封闭集（服务端分派的后端；模型不能自创动作）。 */
export const TEAM_OPERATIONS = ['create', 'update', 'add_member', 'remove_member', 'list', 'get'] as const

/** 一个动作。 */
type TeamOperation = (typeof TEAM_OPERATIONS)[number]

// =====================================================================
//  入参
// =====================================================================

const PARAMS: ParamMap = {
  operation: {
    kind: 'string',
    required: true,
    values: [...TEAM_OPERATIONS],
    description: '动作（封闭集）：create / update / add_member / remove_member / list / get。',
  },
  code: {
    kind: 'string',
    maxLength: 41,
    description: '团队码（create 必填）：2–41 位大写标识（字母开头，只允许 A-Z 0-9 _），如 TEAM_APAC_RD。'
      + ' 创建后不可改。',
  },
  name: {
    kind: 'string',
    maxLength: 200,
    description: '团队名（create 必填；update 可选改）：1–200 字符。',
  },
  department_id: {
    kind: 'string',
    uuid: true,
    description: '所属部门（create 必填；update 可选改）：必须是本租户已存在的部门 id。',
  },
  description: {
    kind: 'string',
    maxLength: 1000,
    description: '描述（可选）：1–1000 字符。要清空已有描述请用 clear_description=true。',
  },
  clear_description: {
    kind: 'boolean',
    description: 'update 专用：true = 清空描述。',
  },
  is_active: {
    kind: 'boolean',
    description: 'update 专用：false = 软关闭这个团队（不物理删除；配置只允许退休）。',
  },
  member_actor_ids: {
    kind: 'string[]',
    description: 'create 可选：一次带上成员（每个元素是 actor id 的 UUID）。'
      + ' 服务端校验：存在、同租户、kind=HUMAN；重复 id 会被去重。',
  },
  member_team_role: {
    kind: 'string',
    values: [...TEAM_ROLES],
    description: 'create 时给 member_actor_ids 里那些人的团队角色（缺省 RECRUITER）。',
  },
  team_id: {
    kind: 'string',
    uuid: true,
    description: '团队 id（update / add_member / remove_member / get 必填）。',
  },
  expected_record_version: {
    kind: 'integer',
    min: 1,
    description: 'update 必填：调用方认为的当前团队版本（先 get 一次拿 record_version）。'
      + ' 不一致 → VERSION_CONFLICT 且零写入。add_member / remove_member 不需要它（成员是关系行）。',
  },
  member_actor_id: {
    kind: 'string',
    uuid: true,
    description: 'add_member / remove_member 必填：要加入/移出的 actor id。'
      + '（注意不叫 actor_id —— 那是执行身份保留键，入参里出现会被拒。）',
  },
  team_role: {
    kind: 'string',
    values: [...TEAM_ROLES],
    description: 'add_member 专用：这个成员在团队里的角色（缺省 RECRUITER）。',
  },
  include_inactive: {
    kind: 'boolean',
    description: 'list 专用：true = 连已软关闭的团队一起返回。',
  },
  include_inactive_members: {
    kind: 'boolean',
    description: 'list / get 专用：true = 连已移出的成员一起返回（含 is_active=false 的历史行）。',
  },
}

// =====================================================================
//  出参
// =====================================================================

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string' },
    contract_version: { type: 'string' },
    operation: { type: 'string', enum: [...TEAM_OPERATIONS] },
    status: STATUS_SCHEMA,
    team: TEAM_SCHEMA,
    teams: { type: 'array', items: TEAM_SCHEMA },
    labels: LABELS_SCHEMA,
  },
  required: ['tool', 'contract_version', 'operation', 'status', 'labels'],
  additionalProperties: false,
}

/** 本工具的规范输出值（`output.schema` 的 TS 影子）。 */
export interface ConfigTeamValue {
  readonly tool: string
  readonly contract_version: string
  readonly operation: TeamOperation
  readonly status: ConfigStatus
  readonly team?: TeamView
  readonly teams?: readonly TeamView[]
  readonly labels: ThreeAxisLabels
}

/**
 * 取一个动作必需的参数（缺了给可执行的错误，而不是让领域层报"格式不对"）。
 * @param args - 已解析的入参。
 * @param key - 参数名。
 * @returns 参数值（调用方按 T 断言）。
 * @throws RecruitmentToolError - `INVALID_ARGS`（`MISSING_REQUIRED_FOR_OPERATION`）。
 */
function requireArg<T>(args: Record<string, unknown>, key: string): T {
  const value = args[key]
  if (value === undefined) {
    throw new RecruitmentToolError('INVALID_ARGS', `MISSING_REQUIRED_FOR_OPERATION: 这个 operation 需要参数 "${key}"`)
  }
  return value as T
}

/**
 * 把"不传 / clear_description=true（清空）/ 传文本（替换）"三态翻译成领域入参。
 * @param args - 已解析的入参。
 * @returns `{}`（不动）或 `{description}`（`null` = 清空）。
 */
function descriptionArg(args: Record<string, unknown>): { description?: string | null } {
  if (args.clear_description === true) return { description: null }
  if (args.description === undefined) return {}
  return { description: args.description as string }
}

// =====================================================================
//  分派
// =====================================================================

/**
 * 按动作执行一次团队配置调用（**唯一**实现；测试直接按动作调它）。
 * @param config - 已解析的库配置（租户只从这里来）。
 * @param args - 已通过 schema + 服务端校验的入参。
 * @param writeActorId - 写动作的作者 actor（Demo Actor 解析结果；只读动作用不到）。
 * @returns 规范输出值。
 * @throws RecruitmentToolError - 领域层错误与 `NOT_CONFIGURED`。
 */
async function runTeamOperation(
  config: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  writeActorId: string = config.actor_id,
): Promise<ConfigTeamValue> {
  const operation = args.operation as TeamOperation
  const pool = createPool(config)
  try {
    if (operation === 'list' || operation === 'get') {
      return await withReadOnly(pool, async (client) => {
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        const includeInactiveMembers = args.include_inactive_members === true
        if (operation === 'list') {
          const teams = await listTeams(client, {
            tenantId: config.tenant_id,
            includeInactive: args.include_inactive === true,
            includeInactiveMembers,
          })
          return {
            tool: CONFIG_TEAM_TOOL_NAME,
            contract_version: CONTRACT_VERSION,
            operation,
            status: 'OK' as const,
            teams,
            labels,
          }
        }
        const team = await getTeam(client, {
          tenantId: config.tenant_id,
          teamId: requireArg<string>(args, 'team_id'),
          includeInactiveMembers,
        })
        return {
          tool: CONFIG_TEAM_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: 'OK' as const,
          team,
          labels,
        }
      })
    }

    if (operation === 'create') {
      return await withActor(pool, writeActorId, async (client) => {
        const created = await createTeam(client, {
          tenantId: config.tenant_id,
          code: requireArg<string>(args, 'code'),
          name: requireArg<string>(args, 'name'),
          departmentId: requireArg<string>(args, 'department_id'),
          ...(args.description === undefined ? {} : { description: args.description as string }),
          ...(args.member_actor_ids === undefined
            ? {}
            : { memberActorIds: args.member_actor_ids as readonly string[] }),
          ...(args.member_team_role === undefined ? {} : { memberTeamRole: args.member_team_role as string }),
          createdByActorId: writeActorId,
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_TEAM_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: created.status,
          team: created.value,
          labels,
        }
      })
    }

    if (operation === 'add_member') {
      return await withActor(pool, writeActorId, async (client) => {
        const added = await addTeamMember(client, {
          tenantId: config.tenant_id,
          teamId: requireArg<string>(args, 'team_id'),
          actorId: requireArg<string>(args, 'member_actor_id'),
          ...(args.team_role === undefined ? {} : { teamRole: args.team_role as string }),
          addedByActorId: writeActorId,
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_TEAM_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: added.status,
          team: added.value,
          labels,
        }
      })
    }

    if (operation === 'remove_member') {
      return await withActor(pool, writeActorId, async (client) => {
        const removed = await removeTeamMember(client, {
          tenantId: config.tenant_id,
          teamId: requireArg<string>(args, 'team_id'),
          actorId: requireArg<string>(args, 'member_actor_id'),
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_TEAM_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: removed.status,
          team: removed.value,
          labels,
        }
      })
    }

    // operation === 'update'
    return await withActor(pool, writeActorId, async (client) => {
      const updated = await updateTeam(client, {
        tenantId: config.tenant_id,
        teamId: requireArg<string>(args, 'team_id'),
        expectedRecordVersion: requireArg<number>(args, 'expected_record_version'),
        ...(args.name === undefined ? {} : { name: args.name as string }),
        ...descriptionArg(args),
        ...(args.department_id === undefined ? {} : { departmentId: args.department_id as string }),
        ...(args.is_active === undefined ? {} : { isActive: args.is_active as boolean }),
      })
      const labels = await buildThreeAxisLabels(client, config.tenant_id)
      return {
        tool: CONFIG_TEAM_TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        operation,
        status: updated.status,
        team: updated.value,
        labels,
      }
    })
  } finally {
    await closePool(pool)
  }
}

// =====================================================================
//  工具定义
// =====================================================================

/** 模型可见说明（每条边界都必须在这里出现）。 */
const DESCRIPTION = [
  'Create / update / read a TENANT-DEFINED hiring team (企业自建招聘团队), including its members.',
  'A team = code + name + department_id + optional description + members (actor + team_role).',
  `team_role is a closed set: ${TEAM_ROLES.join(' / ')}.`,
  'Operation is a closed enum; per-operation required args:',
  '  create { code, name, department_id [, description] [, member_actor_ids] [, member_team_role] }',
  '  update { team_id, expected_record_version [, name] [, description | clear_description=true]',
  '           [, department_id] [, is_active] }',
  '  add_member { team_id, member_actor_id [, team_role] }',
  '  remove_member { team_id, member_actor_id }',
  '  get { team_id [, include_inactive_members] }',
  '  list { [, include_inactive] [, include_inactive_members] }',
  'Server-side validation (never trust the model): department_id must be an existing department of THIS',
  'tenant; every member actor must exist, belong to this tenant, and have kind=HUMAN (SYSTEM /',
  'AGENT_WORKER accounts cannot be hiring-team members — enforced by a composite FK in the database too);',
  'code format ^[A-Z][A-Z0-9_]{1,40}$; name 1-200.',
  'Idempotency: create with identical content AND the same active member set returns status=UNCHANGED',
  '(zero writes); same code with different content returns ALREADY_EXISTS. add_member twice -> UNCHANGED.',
  'remove_member is a SOFT close (is_active=false, history kept); removing someone who was never a member',
  'returns NOT_FOUND; re-adding after removal is allowed and creates a new active membership row.',
  'Optimistic concurrency: update MUST pass expected_record_version; mismatch -> VERSION_CONFLICT.',
  'Member add/remove does NOT change the team record_version (members are relation rows, like actor_role);',
  'use update only for name/description/department/is_active.',
  'Tenant isolation: every read/write is scoped to the tenant from plugin config; another tenant\'s team is',
  'reported as NOT_FOUND.',
  'It does NOT create actors or departments and never deletes rows.',
  'Errors: INVALID_ARGS, NOT_FOUND, VERSION_CONFLICT, INVALID_REFERENCE, ALREADY_EXISTS, NOT_CONFIGURED.',
].join(' ')

/**
 * 造真实的招聘团队配置工具。
 * @param config - 已解析的库配置（模型无法传入租户/actor）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 * @returns 工具定义。
 */
export function createConfigTeamTool(
  config: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: CONFIG_TEAM_TOOL_NAME,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ConfigTeamValue
        const lines: string[] = [
          `${v.tool} ${v.contract_version}: ${v.operation} -> ${v.status}`,
        ]
        if (v.team !== undefined) lines.push(...renderTeam(v.team))
        if (v.teams !== undefined) {
          if (v.teams.length === 0) lines.push('  teams: (none)')
          for (const team of v.teams) lines.push(...renderTeam(team))
        }
        lines.push(labelsLine(v.labels))
        // 机器参数区：team_id / department_id / member_actor_id 是 update 与成员增删的入参，
        // 模型只能从本工具发现它们。
        const teams = [...(v.team === undefined ? [] : [v.team]), ...(v.teams ?? [])]
        const machineArguments: MachineArgument[] = []
        for (const team of teams) {
          machineArguments.push({ key: `team_id(code=${team.code})`, value: team.team_id })
          machineArguments.push({ key: `department_id(team=${team.code})`, value: team.department_id })
          for (const member of team.members) {
            machineArguments.push({ key: `member_actor_id(team=${team.code},${member.display_name})`, value: member.actor_id })
          }
        }
        lines.push(...machineArgumentLines(machineArguments))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      // list/get 是只读动作：不要求 actor；其余动作先把写身份解析出来（失败即零写入）。
      const operation = args.operation as TeamOperation
      const isWrite = operation !== 'list' && operation !== 'get'
      const writeActor = isWrite ? resolveWriteActor(exec, deps.identity, config.actor_id) : undefined
      return await runTeamOperation(config, args, writeActor?.actor_id)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED（列出缺什么）。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredConfigTeamTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: CONFIG_TEAM_TOOL_NAME,
    description:
      'Create / update / read a tenant-defined hiring team (企业自建招聘团队) with members. '
      + `Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${CONFIG_TEAM_TOOL_NAME} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw new RecruitmentToolError('NOT_CONFIGURED', issues.join('; '))
    },
  }
}
