// recruitment_config_pipeline —— 企业自建**流水线模板**的唯一写入口。
//
// 形状权威：`contracts/tenant-config/tool-contracts.md`（下称 TC）。
// 领域实现：`src/domain/tenant-config.ts`（校验 / 幂等 / 版本并发，全部在那儿）。
//
// 为什么"阶段"是独立动作（add_stage）而不是 create 时的数组参数：
//   本仓工具入参只支持标量 / 字符串数组（`src/tools/args.ts` 的 `ParamKind`），
//   DSH 的严格入参 schema 会拒掉嵌套对象；把阶段压成 `"S6@1"` 这种字符串编码，
//   等于让服务端校验退化成解析文本（"校验必须服务端做"就变成解析器自觉）。
//   每加一步 = 一次独立的、带 `expected_record_version` 的写 —— 并发下不会
//   两个人同时改结构而互相覆盖。
//
// 两条**服务端**引用校验（都不靠模型自觉）：
//   1. `stage_code` 必须已存在于本租户 `stage_catalog`（领域预检给"可用阶段码"清单
//      + DB 复合外键 (tenant_id, stage_code) → stage_catalog(tenant_id, code) 兜底）；
//   2. 阶段引用的面试模板必须是**已存在的具体版本**（`interview_template_version.id`，
//      不是 template_code）——docs/03 §2："模板更新不应静默改写已开始的招聘申请"，
//      钉版本才不会改版即静默改流程；DB 复合外键兜底。
//
// 版本语义（TC §6）：阶段结构是模板本体的组成部分 → add_stage / add_stage_template
// 都会让模板 `record_version` +1。这不是"顺手加一"，而是让"模板结构变了"成为
// 可被乐观并发看见的事实（两个人同时加阶段，后一个拿旧版本号会被拒）。
//
// 它 **不** 做什么（TC §0）：
//   * 不把模板应用到任何 application（Pipeline Instance 仍是 application.current_stage_code）；
//   * 不建/改 stage_catalog（阶段目录是另一条线，0004）；
//   * 不建面试模板（interview_template_version 由面试线产出，本工具只**引用**）；
//   * 不发 DELETE / 不重排已有阶段（顺序改动会静默改写"第几步"，留给后续显式的 op）。

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
  addPipelineStage,
  addStageTemplate,
  createPipeline,
  getPipeline,
  listPipelines,
  updatePipeline,
  type PipelineTemplateView,
} from '../domain/tenant-config.ts'
import {
  PIPELINE_SCHEMA,
  STATUS_SCHEMA,
  LABELS_SCHEMA,
  labelsLine,
  renderPipeline,
  type ConfigStatus,
} from './config-shared.ts'

/** 工具名（`test/` 与总控注册时都按这个名字找）。 */
export const CONFIG_PIPELINE_TOOL_NAME = 'recruitment_config_pipeline'

/** 出参契约版本（TC §4：形状变了就要 +1）。 */
const CONTRACT_VERSION = '1.0.0'

/** 本工具的动作封闭集（服务端分派的后端；模型不能自创动作）。 */
export const PIPELINE_OPERATIONS = [
  'create',
  'update',
  'add_stage',
  'add_stage_template',
  'list',
  'get',
] as const

/** 一个动作。 */
type PipelineOperation = (typeof PIPELINE_OPERATIONS)[number]

// =====================================================================
//  入参
// =====================================================================

const PARAMS: ParamMap = {
  operation: {
    kind: 'string',
    required: true,
    values: [...PIPELINE_OPERATIONS],
    description: '动作（封闭集）：create / update / add_stage / add_stage_template / list / get。',
  },
  code: {
    kind: 'string',
    maxLength: 41,
    description: '模板码（create 必填）：2–41 位大写标识（字母开头，只允许 A-Z 0-9 _），如 PIPELINE_ENG_STD。'
      + ' 创建后不可改。',
  },
  name: {
    kind: 'string',
    maxLength: 200,
    description: '模板名（create 必填；update 可选改）：1–200 字符。',
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
    description: 'update 专用：false = 软关闭这个流水线模板（不物理删除）。',
  },
  pipeline_template_id: {
    kind: 'string',
    uuid: true,
    description: '流水线模板 id（update / add_stage / get 必填）。',
  },
  expected_record_version: {
    kind: 'integer',
    min: 1,
    description: 'update / add_stage / add_stage_template 必填：调用方认为的当前模板版本'
      + '（先 get/create 拿 record_version）。不一致 → VERSION_CONFLICT 且零写入。',
  },
  stage_code: {
    kind: 'string',
    maxLength: 41,
    description: 'add_stage 必填：阶段码，必须已存在于本租户的 stage_catalog（如 S6）。',
  },
  sort_order: {
    kind: 'integer',
    min: 1,
    max: 100,
    description: 'add_stage 可选：这份流程里的第几步（1–100）；不传 = 追加到末尾。',
  },
  interview_template_version_ids: {
    kind: 'string[]',
    description: 'add_stage 可选：这一步要用的面试模板版本 id 列表'
      + '（interview_template_version.id 的 UUID；必须已存在且同租户）。',
  },
  is_required: {
    kind: 'boolean',
    description: 'add_stage / add_stage_template 可选：这些面试模板是否必需（缺省 true）。',
  },
  stage_id: {
    kind: 'string',
    uuid: true,
    description: 'add_stage_template 必填：要挂模板的那一步的 stage_id（pipeline_template_stage.id）。',
  },
  interview_template_version_id: {
    kind: 'string',
    uuid: true,
    description: 'add_stage_template 必填：要挂的面试模板版本 id（必须已存在且同租户）。',
  },
  include_inactive: {
    kind: 'boolean',
    description: 'list 专用：true = 连已软关闭的模板一起返回。',
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
    operation: { type: 'string', enum: [...PIPELINE_OPERATIONS] },
    status: STATUS_SCHEMA,
    pipeline: PIPELINE_SCHEMA,
    pipelines: { type: 'array', items: PIPELINE_SCHEMA },
    labels: LABELS_SCHEMA,
  },
  required: ['tool', 'contract_version', 'operation', 'status', 'labels'],
  additionalProperties: false,
}

/** 本工具的规范输出值（`output.schema` 的 TS 影子）。 */
export interface ConfigPipelineValue {
  readonly tool: string
  readonly contract_version: string
  readonly operation: PipelineOperation
  readonly status: ConfigStatus
  readonly pipeline?: PipelineTemplateView
  readonly pipelines?: readonly PipelineTemplateView[]
  readonly labels: ThreeAxisLabels
}

/**
 * 取一个动作必需的参数（缺了给可执行的错误）。
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
 * 按动作执行一次流水线模板配置调用（**唯一**实现；测试直接按动作调它）。
 * @param config - 已解析的库配置（租户只从这里来）。
 * @param args - 已通过 schema + 服务端校验的入参。
 * @param writeActorId - 写动作的作者 actor（Demo Actor 解析结果；只读动作用不到）。
 * @returns 规范输出值。
 * @throws RecruitmentToolError - 领域层错误与 `NOT_CONFIGURED`。
 */
async function runPipelineOperation(
  config: ResolvedDatabaseConfig,
  args: Record<string, unknown>,
  writeActorId: string = config.actor_id,
): Promise<ConfigPipelineValue> {
  const operation = args.operation as PipelineOperation
  const pool = createPool(config)
  try {
    if (operation === 'list' || operation === 'get') {
      return await withReadOnly(pool, async (client) => {
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        if (operation === 'list') {
          const pipelines = await listPipelines(client, {
            tenantId: config.tenant_id,
            includeInactive: args.include_inactive === true,
          })
          return {
            tool: CONFIG_PIPELINE_TOOL_NAME,
            contract_version: CONTRACT_VERSION,
            operation,
            status: 'OK' as const,
            pipelines,
            labels,
          }
        }
        const pipeline = await getPipeline(client, {
          tenantId: config.tenant_id,
          pipelineTemplateId: requireArg<string>(args, 'pipeline_template_id'),
        })
        return {
          tool: CONFIG_PIPELINE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: 'OK' as const,
          pipeline,
          labels,
        }
      })
    }

    if (operation === 'create') {
      return await withActor(pool, writeActorId, async (client) => {
        const created = await createPipeline(client, {
          tenantId: config.tenant_id,
          code: requireArg<string>(args, 'code'),
          name: requireArg<string>(args, 'name'),
          ...(args.description === undefined ? {} : { description: args.description as string }),
          createdByActorId: writeActorId,
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_PIPELINE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: created.status,
          pipeline: created.value,
          labels,
        }
      })
    }

    if (operation === 'add_stage') {
      return await withActor(pool, writeActorId, async (client) => {
        const pipeline = await addPipelineStage(client, {
          tenantId: config.tenant_id,
          pipelineTemplateId: requireArg<string>(args, 'pipeline_template_id'),
          stageCode: requireArg<string>(args, 'stage_code'),
          ...(args.sort_order === undefined ? {} : { sortOrder: args.sort_order as number }),
          expectedRecordVersion: requireArg<number>(args, 'expected_record_version'),
          ...(args.interview_template_version_ids === undefined
            ? {}
            : { interviewTemplateVersionIds: args.interview_template_version_ids as readonly string[] }),
          ...(args.is_required === undefined ? {} : { isRequired: args.is_required as boolean }),
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_PIPELINE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: 'UPDATED' as const,
          pipeline,
          labels,
        }
      })
    }

    if (operation === 'add_stage_template') {
      return await withActor(pool, writeActorId, async (client) => {
        const pipeline = await addStageTemplate(client, {
          tenantId: config.tenant_id,
          stageId: requireArg<string>(args, 'stage_id'),
          interviewTemplateVersionId: requireArg<string>(args, 'interview_template_version_id'),
          expectedRecordVersion: requireArg<number>(args, 'expected_record_version'),
          ...(args.is_required === undefined ? {} : { isRequired: args.is_required as boolean }),
        })
        const labels = await buildThreeAxisLabels(client, config.tenant_id)
        return {
          tool: CONFIG_PIPELINE_TOOL_NAME,
          contract_version: CONTRACT_VERSION,
          operation,
          status: 'UPDATED' as const,
          pipeline,
          labels,
        }
      })
    }

    // operation === 'update'
    return await withActor(pool, writeActorId, async (client) => {
      const updated = await updatePipeline(client, {
        tenantId: config.tenant_id,
        pipelineTemplateId: requireArg<string>(args, 'pipeline_template_id'),
        expectedRecordVersion: requireArg<number>(args, 'expected_record_version'),
        ...(args.name === undefined ? {} : { name: args.name as string }),
        ...descriptionArg(args),
        ...(args.is_active === undefined ? {} : { isActive: args.is_active as boolean }),
      })
      const labels = await buildThreeAxisLabels(client, config.tenant_id)
      return {
        tool: CONFIG_PIPELINE_TOOL_NAME,
        contract_version: CONTRACT_VERSION,
        operation,
        status: updated.status,
        pipeline: updated.value,
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
  'Create / update / read a TENANT-DEFINED pipeline template (企业自建流水线模板): an ordered list of',
  'stages, where each stage may reference existing interview-template VERSIONS.',
  'Why stages are added one by one: the tool argument surface is flat (no nested objects), so',
  'add_stage is its own version-checked write instead of an encoded string blob.',
  'Operation is a closed enum; per-operation required args:',
  '  create { code, name [, description] }   (new templates start with ZERO stages)',
  '  update { pipeline_template_id, expected_record_version [, name] [, description',
  '           | clear_description=true] [, is_active] }',
  '  add_stage { pipeline_template_id, stage_code, expected_record_version',
  '              [, sort_order] [, interview_template_version_ids] [, is_required] }',
  '  add_stage_template { stage_id, interview_template_version_id, expected_record_version [, is_required] }',
  '  get { pipeline_template_id }',
  '  list { [, include_inactive] }',
  'Server-side validation (never trust the model): stage_code must already exist in THIS tenant\'s',
  'stage_catalog (the error lists the available codes); every referenced interview template version must',
  'exist and belong to THIS tenant; a stage cannot appear twice in the same template; sort_order must be',
  '1-100 and unique inside the template. The database enforces the same references with composite FKs.',
  'Version semantics: the stage structure is PART of the template, so add_stage and add_stage_template bump',
  'the template record_version by 1 (your next call must pass the new value). update MUST pass',
  'expected_record_version; mismatch -> VERSION_CONFLICT with zero writes.',
  'Idempotency: create with identical (code,name,description) -> status=UNCHANGED, zero writes; same code',
  'with different content -> ALREADY_EXISTS. update with identical parameters -> UNCHANGED, zero UPDATE.',
  'add_stage is NOT idempotent by content: adding the same stage twice returns ALREADY_EXISTS (one stage',
  'code per template, because otherwise "which stage is the application on" has no answer).',
  'Tenant isolation: every read/write is scoped to the tenant from plugin config; another tenant\'s',
  'template/stage is reported as NOT_FOUND.',
  'It does NOT apply a template to any application (Pipeline Instance is still',
  'application.current_stage_code), does NOT create stage codes or interview templates, and never deletes',
  'rows (retire with is_active=false).',
  'Errors: INVALID_ARGS, NOT_FOUND, VERSION_CONFLICT, INVALID_REFERENCE, ALREADY_EXISTS, NOT_CONFIGURED.',
].join(' ')

/**
 * 造真实的流水线模板配置工具。
 * @param config - 已解析的库配置（模型无法传入租户/actor）。
 * @param deps - 可选依赖：`identity` 由 `src/index.ts` 装配（产品路径）；缺省 = 测试兼容。
 * @returns 工具定义。
 */
export function createConfigPipelineTool(
  config: ResolvedDatabaseConfig,
  deps: ToolActorDeps = {},
): ReadonlyToolDefinition {
  return {
    name: CONFIG_PIPELINE_TOOL_NAME,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args: unknown, value: unknown): readonly TextBlock[] {
        const v = value as ConfigPipelineValue
        const lines: string[] = [
          `${v.tool} ${v.contract_version}: ${v.operation} -> ${v.status}`,
        ]
        if (v.pipeline !== undefined) lines.push(...renderPipeline(v.pipeline))
        if (v.pipelines !== undefined) {
          if (v.pipelines.length === 0) lines.push('  pipelines: (none)')
          for (const pipeline of v.pipelines) lines.push(...renderPipeline(pipeline))
        }
        lines.push(labelsLine(v.labels))
        // 机器参数区：pipeline_template_id / stage_id / interview_template_version_id 是
        // update / add_stage / 挂模板的入参，模型只能从本工具发现它们。
        const pipelines = [...(v.pipeline === undefined ? [] : [v.pipeline]), ...(v.pipelines ?? [])]
        const machineArguments: MachineArgument[] = []
        for (const pipeline of pipelines) {
          machineArguments.push({ key: `pipeline_template_id(code=${pipeline.code})`, value: pipeline.pipeline_template_id })
          for (const stage of pipeline.stages) {
            machineArguments.push({ key: `stage_id(pipeline=${pipeline.code},${stage.stage_code})`, value: stage.stage_id })
            for (const ref of stage.interview_templates) {
              machineArguments.push({
                key: `interview_template_version_id(${stage.stage_code},${ref.template_code},v${ref.version_no})`,
                value: ref.interview_template_version_id,
              })
            }
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
      const operation = args.operation as PipelineOperation
      const isWrite = operation !== 'list' && operation !== 'get'
      const writeActor = isWrite ? resolveWriteActor(exec, deps.identity, config.actor_id) : undefined
      return await runPipelineOperation(config, args, writeActor?.actor_id)
    },
  }
}

/**
 * 配置不完整时的替身：注册同一个工具名，调用即报 NOT_CONFIGURED（列出缺什么）。
 * @param issues - 缺失的配置项。
 * @returns 调用即抛错的工具定义。
 */
export function unconfiguredConfigPipelineTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: CONFIG_PIPELINE_TOOL_NAME,
    description:
      'Create / update / read a tenant-defined pipeline template (企业自建流水线模板) with ordered stages '
      + `and interview-template references. Currently NOT CONFIGURED: ${issues.join('; ')}. `
      + 'Calls return NOT_CONFIGURED.',
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${CONFIG_PIPELINE_TOOL_NAME} is not configured: ${issues.join('; ')}` }]
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
