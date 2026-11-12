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
}

/** 参数名 -> 声明。 */
export interface ParamMap {
  readonly [key: string]: ParamSpec
}

/**
 * 把一个参数声明编译成模型可见的 JSON Schema 属性节点。
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

/**
 * 单个参数的取值校验，违反项追加到 violations。
 * @param key - 参数名。
 * @param spec - 参数声明。
 * @param value - 模型给的取值。
 * @param violations - 违反项收集器（原地追加）。
 */
function checkValue(key: string, spec: ParamSpec, value: unknown, violations: string[]): void {
  if (spec.kind === 'string') {
    if (typeof value !== 'string') {
      violations.push(`"${key}" must be a string`)
      return
    }
    if (value.length === 0) {
      violations.push(`"${key}" must be a non-empty string`)
      return
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      violations.push(`"${key}" must be at most ${spec.maxLength} characters`)
    }
    if (spec.values !== undefined && !spec.values.includes(value)) {
      violations.push(`"${key}" must be one of: ${spec.values.join(', ')}`)
    }
    return
  }
  if (spec.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      violations.push(`"${key}" must be an integer`)
      return
    }
    if (spec.min !== undefined && value < spec.min) violations.push(`"${key}" must be >= ${spec.min}`)
    if (spec.max !== undefined && value > spec.max) violations.push(`"${key}" must be <= ${spec.max}`)
    return
  }
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') violations.push(`"${key}" must be a boolean`)
    return
  }
  // string[]
  if (!Array.isArray(value)) {
    violations.push(`"${key}" must be an array of strings`)
    return
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      violations.push(`"${key}[${index}]" must be a string`)
      continue
    }
    if (spec.values !== undefined && !spec.values.includes(item)) {
      violations.push(`"${key}[${index}]" must be one of: ${spec.values.join(', ')}`)
    }
  }
}

/**
 * 校验并归一化模型入参：未知参数、类型不符、越界、缺必填一律拒绝。
 * @param specs - 参数表。
 * @param raw - 模型给的 arguments（执行器已做过无损 JSON 快照）。
 * @returns 只含已声明键的入参对象。
 * @throws RecruitmentToolError - 任一条违反即抛 INVALID_ARGS，列出全部违反项。
 */
export function parseArgs(specs: ParamMap, raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RecruitmentToolError('INVALID_ARGS', 'arguments must be a JSON object')
  }
  const input = raw as Record<string, unknown>
  const violations: string[] = []
  for (const key of Object.keys(input).sort()) {
    if (!Object.hasOwn(specs, key)) {
      violations.push(`unknown parameter "${key}" (allowed: ${Object.keys(specs).join(', ')})`)
    }
  }
  const parsed: Record<string, unknown> = {}
  for (const key of Object.keys(specs)) {
    const spec = specs[key] as ParamSpec
    const value = input[key]
    if (value === undefined) {
      if (spec.required === true) violations.push(`missing required parameter "${key}"`)
      continue
    }
    checkValue(key, spec, value, violations)
    parsed[key] = value
  }
  if (violations.length > 0) {
    throw new RecruitmentToolError('INVALID_ARGS', violations.join('; '))
  }
  return parsed
}
