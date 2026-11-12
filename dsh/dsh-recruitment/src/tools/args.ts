// 参数契约 + 严格入参校验。
//
// 为什么不是官方的 defineTool：本插件通过 `dsh plugin add link:` 装进 profile 后
// 由宿主按包名 import，实测无法解析 `@deepseek-ai/dsh-tools`
// （ERR_MODULE_NOT_FOUND，见 CONTRACT.md §0）。官方文档允许直接注册原始
// ToolDefinition，并明确「直接注册的原始 JSON Schema 工具自行负责输入校验」
// （docs/subsystems/tools.zh.md §统一 JSON 值 schema DSL）。
//
// 所以这里做两件事：
//   1. 用官方 ParameterSchemaSpec 的同一套词汇（string/integer/boolean/array +
//      required + enum + items）生成模型可见的原始 JSON Schema；
//   2. 自己执行校验，并且比 defineTool 的隐式开放根更严：显式
//      additionalProperties:false，未知参数一律拒绝
//      （docs/09-dsh-plugin-architecture.md §2-A「严格 input schema（拒绝未知字段）」）。
//
// 只使用官方「已强制执行的原始 JSON Schema 子集」里的关键字
// （type/properties/required/additionalProperties/items/enum/description）。
// 长度、上下界、非空字符串这些子集表达不了的约束写在 description 里，并由本文件
// 的 checkValue() 在 execute 入口强制——与 docs/cookbook/adding-a-tool.zh.md
// 「你仍需手动检查 schema DSL 无法表达的约束，并以 ToolArgsError 拒绝」一致。
//
// 两套呈现（同一份校验）：
//   * `parseArgs()`     —— CONTRACT.md §2.2 的散文消息（stub 三工具用）。
//   * `parseContractArgs()` —— tool-contracts.md §1.2 的 `Error: <CODE>: <json>`
//     （S6/S7 两工具用）。两者共用 `collectArgViolations()`，不复制规则。
//
// `tool-contracts.md` §1.1 第 8 条（id 必须是 UUID 文本）与 §0 第 4 条
// （不接受模型传入 tenant_id / actor_id）在本文件里以 `uuid` 标记与
// `IDENTITY_KEYS` 实现。

import { contractError, isUuid } from './contract.ts'
import { RecruitmentToolError } from './errors.ts'

/** 参数种类。数组只支持字符串数组（本插件唯一需要的形态）。 */
export type ParamKind = 'string' | 'integer' | 'boolean' | 'string[]'

/** 一个参数的声明。 */
export interface ParamSpec {
  /** 参数种类。 */
  readonly kind: ParamKind
  /** 模型可见说明（含子集表达不了的约束，如长度/上下界）。 */
  readonly description: string
  /** 是否必填。缺省为可选。 */
  readonly required?: boolean
  /** 闭集取值（enum）；对 string[] 作用于每个元素。 */
  readonly values?: readonly string[]
  /** integer 的闭区间下界。 */
  readonly min?: number
  /** integer 的闭区间上界。 */
  readonly max?: number
  /** string 的最大长度。 */
  readonly maxLength?: number
  /** string 必须是 UUID 文本（`tool-contracts.md` §1.1 第 8 条）。 */
  readonly uuid?: boolean
}

/** 参数名 -> 声明。 */
export interface ParamMap {
  readonly [key: string]: ParamSpec
}

/** 一条违反项的分类（`tool-contracts.md` §2.5 / §3.4 的 `reason_code` 封闭集）。 */
export type ArgViolationReason =
  | 'UNKNOWN_PARAM'
  | 'TYPE_MISMATCH'
  | 'MISSING_REQUIRED'
  | 'OUT_OF_RANGE'
  | 'MUTUALLY_EXCLUSIVE'
  | 'ID_NOT_UUID'
  | 'AS_OF_FORMAT'
  | 'AS_OF_IN_FUTURE'
  | 'TENANT_OR_ACTOR_NOT_ALLOWED'

/** 一条结构化违反项。 */
export interface ArgViolation {
  readonly reason: ArgViolationReason
  /** 违反的参数路径（`job_id` / `block_types[1]` / `arguments`）。 */
  readonly path: string
  /** 与 CONTRACT.md §2.2 逐字一致的散文消息（旧格式仍靠它）。 */
  readonly message: string
}

/**
 * 把一份参数声明编译成模型可见的 JSON Schema 属性节点。
 * @param spec - 参数声明。
 * @returns 原始 JSON Schema 节点（仅用受支持的子集关键字）。
 */
function propertySchema(spec: ParamSpec): Record<string, unknown> {
  if (spec.kind === 'string[]') {
    const items: Record<string, unknown> = { type: 'string' }
    if (spec.values !== undefined) items.enum = [...spec.values]
    return { type: 'array', description: spec.description, items }
  }
  const node: Record<string, unknown> = { type: spec.kind, description: spec.description }
  if (spec.values !== undefined) node.enum = [...spec.values]
  return node
}

/**
 * 编译整张参数表（隐式对象根，显式关闭额外字段）。
 * @param specs - 参数表。
 * @returns 对象根的原始 JSON Schema。
 */
export function toParameterSchema(specs: ParamMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const key of Object.keys(specs)) {
    const spec = specs[key] as ParamSpec
    properties[key] = propertySchema(spec)
    if (spec.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 模型永远不能自报的两个身份键（`tool-contracts.md` §0 第 4 条）。 */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['tenant_id', 'actor_id'])

function push(
  violations: ArgViolation[],
  reason: ArgViolationReason,
  path: string,
  message: string,
): void {
  violations.push({ reason, path, message })
}

/**
 * 单个参数的取值校验，违反项追加到 violations。
 * @param key - 参数名。
 * @param spec - 参数声明。
 * @param value - 模型给的取值。
 * @param violations - 违反项收集器（原地追加）。
 */
function checkValue(key: string, spec: ParamSpec, value: unknown, violations: ArgViolation[]): void {
  if (spec.kind === 'string') {
    if (typeof value !== 'string') {
      push(violations, 'TYPE_MISMATCH', key, `"${key}" must be a string`)
      return
    }
    if (value.length === 0) {
      push(violations, 'TYPE_MISMATCH', key, `"${key}" must be a non-empty string`)
      return
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      push(violations, 'OUT_OF_RANGE', key, `"${key}" must be at most ${spec.maxLength} characters`)
    }
    if (spec.uuid === true && !isUuid(value)) {
      push(violations, 'ID_NOT_UUID', key, `"${key}" must be a UUID`)
    }
    if (spec.values !== undefined && !spec.values.includes(value)) {
      push(violations, 'OUT_OF_RANGE', key, `"${key}" must be one of: ${spec.values.join(', ')}`)
    }
    return
  }
  if (spec.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      push(violations, 'TYPE_MISMATCH', key, `"${key}" must be an integer`)
      return
    }
    if (spec.min !== undefined && value < spec.min) {
      push(violations, 'OUT_OF_RANGE', key, `"${key}" must be >= ${spec.min}`)
    }
    if (spec.max !== undefined && value > spec.max) {
      push(violations, 'OUT_OF_RANGE', key, `"${key}" must be <= ${spec.max}`)
    }
    return
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') push(violations, 'TYPE_MISMATCH', key, `"${key}" must be a boolean`)
    return
  }
  // string[]
  if (!Array.isArray(value)) {
    push(violations, 'TYPE_MISMATCH', key, `"${key}" must be an array of strings`)
    return
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      push(violations, 'TYPE_MISMATCH', `${key}[${index}]`, `"${key}[${index}]" must be a string`)
      continue
    }
    if (spec.values !== undefined && !spec.values.includes(item)) {
      push(violations, 'OUT_OF_RANGE', `${key}[${index}]`, `"${key}[${index}]" must be one of: ${spec.values.join(', ')}`)
    }
  }
}

/**
 * 收集全部违反项（不抛错）。收集顺序与 `parseArgs` 的历史行为一致：
 * 先未知键（按字典序），再按参数声明顺序。
 * @param specs - 参数表。
 * @param raw - 模型给的 arguments。
 * @returns `{ parsed, violations }`；`violations` 为空表示通过。
 */
export function collectArgViolations(
  specs: ParamMap,
  raw: unknown,
): { parsed: Record<string, unknown>; violations: ArgViolation[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      parsed: {},
      violations: [
        { reason: 'TYPE_MISMATCH', path: 'arguments', message: 'arguments must be a JSON object' },
      ],
    }
  }
  const input = raw as Record<string, unknown>
  const violations: ArgViolation[] = []
  const allowed = Object.keys(specs).join(', ')
  for (const key of Object.keys(input).sort()) {
    if (!Object.hasOwn(specs, key)) {
      push(
        violations,
        IDENTITY_KEYS.has(key) ? 'TENANT_OR_ACTOR_NOT_ALLOWED' : 'UNKNOWN_PARAM',
        key,
        `unknown parameter "${key}" (allowed: ${allowed})`,
      )
    }
  }
  const parsed: Record<string, unknown> = {}
  for (const key of Object.keys(specs)) {
    const spec = specs[key] as ParamSpec
    const value = input[key]
    if (value === undefined) {
      if (spec.required === true) {
        push(violations, 'MISSING_REQUIRED', key, `missing required parameter "${key}"`)
      }
      continue
    }
    checkValue(key, spec, value, violations)
    parsed[key] = value
  }
  return { parsed, violations }
}

/**
 * 校验并归一化模型入参：未知参数、类型不符、越界、缺必填一律拒绝。
 * @param specs - 参数表。
 * @param raw - 模型给的 arguments（执行器已做过无损 JSON 快照）。
 * @returns 只含已声明键的入参对象。
 * @throws RecruitmentToolError - 任一条违反即抛 INVALID_ARGS，列出全部违反项。
 */
export function parseArgs(specs: ParamMap, raw: unknown): Record<string, unknown> {
  const { parsed, violations } = collectArgViolations(specs, raw)
  if (violations.length > 0) {
    throw new RecruitmentToolError('INVALID_ARGS', violations.map((v) => v.message).join('; '))
  }
  return parsed
}

/**
 * 契约版校验：违反项以 `Error: INVALID_ARGS: {...,"detail":{"violations":[...]}}` 抛出
 * （`tool-contracts.md` §1.2）。第一条违反项的 `reason` 同时作为顶层 `reason_code`。
 * @param specs - 参数表。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参对象。
 */
export function parseContractArgs(specs: ParamMap, raw: unknown): Record<string, unknown> {
  const { parsed, violations } = collectArgViolations(specs, raw)
  if (violations.length === 0) return parsed
  const first = violations[0] as ArgViolation
  throw contractError('INVALID_ARGS', {
    reason_code: first.reason,
    message: '参数不合法，逐条见 detail.violations',
    detail: {
      allowed: Object.keys(specs),
      violations: violations.map((v) => ({ reason_code: v.reason, path: v.path, message: v.message })),
    },
  })
}
