// recruitment_config_role —— 企业自建**角色模板**的唯一写入口。
//
// 形状权威：`contracts/tenant-config/tool-contracts.md`（下称 TC）。
// 领域实现：`src/domain/tenant-config.ts`（校验 / 幂等 / 版本并发，全部在那儿）。
// 本文件只做四件胶水：
//   1. 入参收窄 + 按 `operation` 分派（create / update / list / get）；
//   2. 事务与身份：写路径 `withActor`（BEGIN + SET LOCAL recruitment.actor_id），
//      只读路径 `withReadOnly`（`begin transaction read only` —— 只读是**数据库强制**的，
//      不是"源码里没写 INSERT"这种自觉）；
//   3. 出参：领域结果 + R4 三维标签（走 buildThreeAxisLabels 这一份实现）；
//   4. 配置不完整时**仍然注册同一个工具名**，调用返回 NOT_CONFIGURED 并列出缺什么。
//
// ⚠️ 为什么不叫 recruitment_config_role_create / _update / _list / _get：
//   本仓 22 个工具都是"一工具一动作"，但角色配置有 4 个动作、团队 6 个、流水线 6 个，
//   全拆开是 16 个工具名（总控注册表会膨胀 3 倍，而每个都只是同一张表的不同
//   侧面）。任务书允许"一个工具的多种 operation"。**分派在服务端做**：
//   `operation` 是封闭集，未列出的动作直接 INVALID_ARGS，不存在"模型自己发明动作"。
//   若总控要求回到一工具一动作，本文件的 `runRoleOperation` 已按动作拆好，
//   包一层薄 wrapper 即可（不需要改 domain）。
//
// 它 **不** 做什么（TC §0）：
//   * 不做权限判定（不实现 RBAC 求值）——只存"这个角色能碰到哪类动作"；
//   * 不建/改 actor（团队成员必须是已存在的 kind='HUMAN' 账号，创建账号不在这里）；
//   * 不发 DELETE（配置只软关闭 `is_active=false`）；
//   * 不 last-write-wins（版本不一致 → VERSION_CONFLICT，把"重读"交回调用方）。

import { parseContractArgs, toParameterSchema } from './args.ts'
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
  PERMISSION_SCOPES,
  createRole,
  getRole,
  listRoles,
  updateRole,
  type RoleView,
} from '../domain/tenant-config.ts'
import {
  CONFIG_STATUSES,
  LABELS_SCHEMA,
  ROLE_SCHEMA,
  STATUS_SCHEMA,
  labelsLine,
  renderRole,
  type ConfigStatus,
} from './config-shared.ts'

/** 工具名（`test/` 与总控注册时都按这个名字找）。 */
export const CONFIG_ROLE_TOOL_NAME = 'recruitment_config_role'

/** 出参契约版本（TC §4：形状变了就要 +1）。 */
const CONTRACT_VERSION = '1.0.0'

/** 本工具的动作封闭集（服务端分派的后端；模型不能自创动作）。 */
export const ROLE_OPERATIONS = ['create', 'update', 'list', 'get'] as const

/** 一个动作。 */
type RoleOperation = (typeof ROLE_OPERATIONS)[number]

// =====================================================================
//  入参
// =====================================================================

const PARAMS: ParamMap = {
  operation: {
    kind: 'string',
    required: true,
    values: [...ROLE_OPERATIONS],
    description: '动作（封闭集）：create / update / list / get。每个动作需要的其它参数见各字段说明。',
  },
  code: {
    kind: 'string',
    maxLength: 41,
    description: '角色码（create 必填）：2–41 位大写标识（字母开头，只允许 A-Z 0-9 _），如 HIRING_MANAGER。'
      + ' 创建后不可改（改 code = 换一个角色）。',
  },
  name: {
    kind: 'string',
    maxLength: 200,
    description: '角色名（create 必填；update 可选改）：1–200 字符。',
  },
  description: {
    kind: 'string',
    maxLength: 1000,
    description: '描述（可选）：1–1000 字符。要清空已有描述请用 clear_description=true（不能用空字符串）。',
  },
  clear_description: {
    kind: 'boolean',
    description: 'update 专用：true = 清空描述（与"不传 description"区分）。',
  },
  permission_scopes: {
    kind: 'string[]',
    values: [...PERMISSION_SCOPES],
    description: '权限范围（create 必填、至少 1 个；update 可改为空数组）：封闭集 '
      + `${PERMISSION_SCOPES.join(' / ')}；服务端会拒绝集合外的值和重复项。`,
  },
  role_id: {
    kind: 'string',
    uuid: true,
    description: '角色 id（update / get 必填）。',
  },
  expected_record_version: {
    kind: 'integer',
    min: 1,
    description: 'update 必填：调用方认为的当前版本（先 get 一次拿 record_version）。'
      + ' 不一致 → VERSION_CONFLICT 且零写入。',
  },
  include_inactive: {
    kind: 'boolean',
    description: 'list 专用：true = 连已软关闭的角色一起返回（缺省只返回在用角色）。',
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
    operation: { type: 'string', enum: [...ROLE_OPERATIONS] },
    status: STATUS_SCHEMA,
    role: ROLE_SCHEMA,
    roles: { type: 'array', items: ROLE_SCHEMA },
    labels: LABELS_SCHEMA,
  },
  required: ['tool', 'contract_version', 'operation', 'status', 'labels'],
  additionalProperties: false,
}

/** 本工具的规范输出值（`output.schema` 的 TS 影子）。 */
export interface ConfigRoleValue {
  readonly tool: string
  readonly contract_version: string
  readonly operation: RoleOperation
  readonly status: ConfigStatus
  readonly role?: RoleView
  readonly roles?: readonly RoleView[]
  readonly labels: ThreeAxisLabels
}

// =====================================================================
//  分派
// =====================================================================

/**
 * 按动作执行一次配置调用（**唯一**的写/读实现，测试直接按动作调它）。
 * @param config - 已解析的库配置（租户只从这里来，模型无法传入）。
 * @param args - 已通过 schema + 服务端校验的入参。
 * @param writeActorId - 写动作的作者 actor（Demo Actor 解析结果；只读动作用不到）。
 * @returns 规范输出值。
 * @throws RecruitmentToolError - 领域层错误（`INVALID_ARGS` / `NOT_FOUND` /
 *   `VERSION_CONFLICT` / `ALREADY_EXISTS` / `INVALID_REFERENCE`）与 `NOT_CONFIGURED`。
 */
async function runRoleOperation(
  config: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  writeActorId: string = config.actor_id,
): Promise<ConfigRoleValue> {
  const operation = args.operation as RoleOperation
  const pool = createPool(config)
  try {
    if (operation === 'list' || operation === 'get') {
      // 只读事务：`begin transaction read only` 让"只读"成为数据库强制性质。
      return await withReadOnly(pool, async (client) => {
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        if (operation === 'list') {
          const roles = await listRoles(client, {
            tenantId: config.tenant_id,
            includeInactive: args.include_inactive === true,
          })
          return {
            tool: CONFIG_ROLE_TOOL_NAME,
            contract_version: CONTRACT_VERSION,
            operation,
            status: 'OK' as const,
            roles,
            labels,
          }
        }
        const role = await getRole(client, {
          tenantId: config.tenant_id,
          roleId: requireArg<string>(args, 'role_id'),
        })
        return {
          tool: CONFIG_ROLE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: 'OK' as const,
          role,
          labels,
        }
      })
    }

    if (operation === 'create') {
      return await withActor(pool, writeActorId, async (client) => {
        const created = await createRole(client, {
          tenantId: config.tenant_id,
          code: requireArg<string>(args, 'code'),
          name: requireArg<string>(args, 'name'),
          ...(args.description === undefined ? {} : { description: args.description as string }),
          // create 时 permission_scopes 必填：缺了直接在这里拒绝（不靠数据库默认 '[]'）
          permissionScopes: requireArg<readonly string[]>(args, 'permission_scopes'),
          createdByActorId: writeActorId,
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_ROLE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: created.status,
          role: created.value,
          labels,
        }
      })
    }

    // operation === 'update'
    return await withActor(pool, writeActorId, async (client) => {
      const updated = await updateRole(client, {
        tenantId: config.tenant_id,
        roleId: requireArg<string>(args, 'role_id'),
        expectedRecordVersion: requireArg<number>(args, 'expected_record_version'),
        ...(args.name === undefined ? {} : { name: args.name as string }),
        // 三态：不传（不动）/ clear_description=true（清空）/ 传了文本（替换）
        ...(args.clear_description === true
          ? { description: null }
          : args.description === undefined ? {} : { description: args.description as string }),
        ...(args.permission_scopes === undefined
          ? {}
          : { permissionScopes: args.permission_scopes as readonly string[] }),
      })
      const labels = await buildThreeAxisLabels(client, config.tenant_id)
      return {
        tool: CONFIG_ROLE_TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        operation,
        status: updated.status,
        role: updated.value,
        labels,
      }
    })
  } finally {
    await closePool(pool)
  }
}

/**
 * 取一个动作必需的参数（缺了给可执行的错误，而不是让领域层报"格式不对"）。
 * @param args - 已解析的入参。
 * @param key - 参数名。
 * @returns 参数值。
 * @throws RecruitmentToolError - `INVALID_ARGS`（`MISSING_REQUIRED_FOR_OPERATION`）。
 */
function requireArg<T>(args: Record<string, unknown>, key: string): T {
  const value = args[key]
  if (value === undefined) {
    throw new RecruitmentToolError('INVALID_ARGS', `MISSING_REQUIRED_FOR_OPERATION: 这个 operation 需要参数 "${key}"`)
  }
  return value as T
}

// =====================================================================
//  工具定义
// =====================================================================

/** 模型可见说明（每条边界都必须在这里出现，否则模型会自己发明语义）。 */
const DESCRIPTION = [
  'Create / update / read a TENANT-DEFINED role template (企业自建角色).',
  'A role = code + name + description + permission_scopes (a closed set of coarse capability codes:',
  `${PERMISSION_SCOPES.join(' / ')}).`,
  'Operation is a closed enum; per-operation required args:',
  '  create { code, name, permission_scopes(>=1) [, description] }',
  '  update { role_id, expected_record_version [, name] [, description | clear_description=true] [, permission_scopes] }',
  '  get    { role_id }',
  '  list   { [, include_inactive] }',
  'Server-side validation (never trust the model): code format ^[A-Z][A-Z0-9_]{1,40}$, name 1-200,',
  'description 1-1000, permission_scopes must be members of the closed set and are de-duplicated + sorted.',
  'Idempotency: create with an identical (code,name,description,permission_scopes) returns',
  'status=UNCHANGED and writes NOTHING (record_version unchanged); the same code with DIFFERENT content',
  'returns ALREADY_EXISTS (use update, never silently overwrite tenant config). update with parameters',
  'identical to the stored row returns status=UNCHANGED with zero UPDATE.',
  'Optimistic concurrency: update MUST pass expected_record_version; mismatch -> VERSION_CONFLICT',
  '(zero writes). No last-write-wins, no auto retry.',
  'Tenant isolation: every read/write is scoped to the tenant from plugin config; another tenant\'s role',
  'is invisible and reported as NOT_FOUND.',
  'It does NOT evaluate permissions (no RBAC engine), does NOT create actors, and never deletes rows',
  '(retire with is_active=false).',
  'Errors: INVALID_ARGS, NOT_FOUND, VERSION_CONFLICT, ALREADY_EXISTS, NOT_CONFIGURED.',
].join(' ')

/**
 * 造真实的角色配置工具。
 * @param config - 已解析的库配置（模型无法传入租户/actor）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 * @returns 工具定义。
 */
export function createConfigRoleTool(
  config: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: CONFIG_ROLE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ConfigRoleValue
        const lines: string[] = [
          `${v.tool} ${v.contract_version}: ${v.operation} -> ${v.status}`,
        ]
        if (v.role !== undefined) lines.push(...renderRole(v.role))
        if (v.roles !== undefined) {
          if (v.roles.length === 0) lines.push('  roles: (none)')
          for (const role of v.roles) lines.push(...renderRole(role))
        }
        lines.push(labelsLine(v.labels))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    // 写路径（create/update）不允许与兄弟调用并行；list/get 由内部事务隔离。
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      const args = parseContractArgs(PARAMS, rawArgs)
      // list/get 是只读动作：不要求 actor；create/update 先把写身份解析出来（失败即零写入）。
      const operation = args.operation as RoleOperation
      const isWrite = operation === 'create' || operation === 'update'
      const writeActor = isWrite ? resolveWriteActor(exec, deps.identity, config.actor_id) : undefined
      return await runRoleOperation(config, args, writeActor?.actor_id)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED（列出缺什么）。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredConfigRoleTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: CONFIG_ROLE_TOOL_NAME,
    description:
      'Create / update / read a tenant-defined role template (企业自建角色). '
      + `Currently NOT CONFIGURED: ${issues.join('; ')}. Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${CONFIG_ROLE_TOOL_NAME} is not configured: ${issues.join('; ')}` }]
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

/** 出参状态封闭集（导出给测试核对 schema 没被放宽）。 */
export const CONFIG_ROLE_STATUSES = CONFIG_STATUSES
