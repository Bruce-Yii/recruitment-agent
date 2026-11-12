// 新工具（S6/S7）共用的「契约层」小工具：
//   * 错误消息格式 `Error: <CODE>: <compact-json>`（`tool-contracts.md` §1.2）
//   * 规范化 JSON（键序字典序、单行、无空白）——`evaluation_digest` / `reasons_digest` 都依赖它
//   * UUID 判定（`tool-contracts.md` §1.1 第 8 条）
//   * `as_of` 判定（ISO-8601 带偏移、不得晚于服务端 now）
//
// 为什么错误走 message 而不是 `error.info`：本包无法 import `HarnessError`
// （`CONTRACT.md` §0 的实测 ERR_MODULE_NOT_FOUND），DSH 只对 `HarnessError` 保留
// 结构化 info。所以把 code + reason_code 写成单行 JSON 塞进 message，
// 让模型与日志看到同一份、且能被 `JSON.parse` 的稳定结构。
import { createHash } from 'node:crypto'

import { RecruitmentToolError, type RecruitmentErrorCode } from './errors.ts'

/**
 * 键按 Unicode 码点升序、无空白的 JSON。数组顺序保持原样（顺序有意义）。
 * 数字用 `JSON.stringify` 的最简十进制，不做额外归一化。
 * @param value - 任意 JSON 值。
 * @returns 单行 JSON 文本。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  throw new TypeError(`canonicalJson: unsupported type ${typeof value}`)
}

/**
 * `sha256(canonicalJson(value))`，小写 hex。
 * @param value - 任意 JSON 值。
 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** 契约错误里能出现的 code（封闭集：`tool-contracts.md` §3.4 + S6 的身份结论）。 */
export type ContractErrorCode = Extract<
  RecruitmentErrorCode,
  'INVALID_ARGS' | 'NOT_FOUND' | 'BLOCKED_BY_REVIEW' | 'NO_RUBRIC' | 'FORBIDDEN' | 'READER_FAILED' | 'NOT_CONFIGURED'
>

/** 构造一次契约错误的 detail（`blocking_items[]` / `violations[]` / `allowed[]` …）。 */
export interface ContractErrorParts {
  /** 该 code 下的封闭枚举取值。 */
  readonly reason_code: string
  /** 一句给人看的中文说明。 */
  readonly message: string
  /** 结构化明细；没有就省略这个键（契约禁止用 null 占位）。 */
  readonly detail?: unknown
}

/**
 * 造一个 `Error: <CODE>: <compact-json>` 形态的工具错误。
 * @param code - 稳定错误码（同时是消息前缀）。
 * @param parts - `reason_code` / `message` / 可选 `detail`。
 * @returns 可直接 `throw` 的错误实例。
 */
export function contractError(code: ContractErrorCode, parts: ContractErrorParts): RecruitmentToolError {
  const body: Record<string, unknown> = {
    code,
    reason_code: parts.reason_code,
    message: parts.message,
  }
  if (parts.detail !== undefined) body.detail = parts.detail
  return new RecruitmentToolError(code, canonicalJson(body))
}

/** 一个候选人的强标识命中（`matched_by` 的取值）。 */
export type MatchedBy = 'phone' | 'email'

const ISO_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * 校验 `as_of`：ISO-8601 且**带**时区偏移（`Z` 或 `±HH:MM`），且不得晚于 `nowMs`。
 * @param value - 模型传入的字符串。
 * @param nowMs - 服务端当前时刻（毫秒）。
 * @returns `{ok:true}`，或 `{ok:false, reason_code, message}`；`reason_code` 取 `AS_OF_*`。
 */
export function checkAsOf(
  value: string,
  nowMs: number,
): { ok: true } | { ok: false; reason_code: 'AS_OF_FORMAT' | 'AS_OF_IN_FUTURE'; message: string } {
  if (!ISO_WITH_OFFSET_RE.test(value)) {
    return {
      ok: false,
      reason_code: 'AS_OF_FORMAT',
      message: 'as_of 必须是带时区偏移的 ISO-8601 时间（如 2026-11-13T00:00:00+08:00）',
    }
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason_code: 'AS_OF_FORMAT', message: 'as_of 不是可解析的时间' }
  }
  if (parsed > nowMs) {
    return { ok: false, reason_code: 'AS_OF_IN_FUTURE', message: 'as_of 不得晚于服务端当前时间' }
  }
  return { ok: true }
}

/** UUID 文本正则（小写或大写都收，比较前统一小写）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 是合法 UUID 文本？ */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}
