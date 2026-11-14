// DocumentContent 的机械校验层。
//
// 风格对齐 `structure/validate.ts`：**纯函数、不抛异常、一次收集全部违反项**。
// 输入是 unknown（故意），输出是 { valid, violations[], stats }：
//   * `valid === (hard violation 数 === 0)`；soft violation 只记录；
//   * 每条 violation 带 `path`，能定位到具体字段（`blocks[3].locator.page`）；
//   * 任何一条 hard 都意味着这份 content **不得**进入质量 Gate 之后的下游。
//
// 判什么、不判什么：
//   * 判形状 / 枚举 / 封闭键集 / 定位合法性 / 跨字段自相矛盾（机械规则）；
//   * **不判**文字内容是否正确（那属于质量 Gate 与人工对照，U2 的范围）；
//   * **不判** issue 的业务严重度是否合适（那由 issue policy 决定，见 map-converter.ts）；
//   * 不读文件、不联网、不取当前时间 —— 同一份输入永远同一份输出。
//
// 三条跨字段红线（对应 docs/19 §5 NO-GO「任一来源失败且静默变为 complete」）：
//   1. `completeness === "complete"` 但 issues 里有 HARD → 自相矛盾；
//   2. `completeness === "complete"` 但 `needs_visual === true` → 自相矛盾；
//   3. `media_type` 与 locator kind 不匹配 → 证据指错了类型（PDF 页码长在 DOCX 上）。

import type { BBox, DocumentContent, EvidenceLocator } from './types.ts'
import {
  BLOCK_KINDS,
  COMPLETENESS_STATES,
  DOCUMENT_BLOCK_KEYS,
  DOCUMENT_CONTENT_KEYS,
  DOCUMENT_ISSUE_KEYS,
  DOCUMENT_LINK_KEYS,
  DOCUMENT_TABLE_KEYS,
  DOCX_LOCATOR_KEYS,
  IMAGE_LOCATOR_KEYS,
  ISSUE_SEVERITIES,
  MEDIA_TYPES,
  PDF_LOCATOR_KEYS,
  PROVENANCES,
  RTF_LOCATOR_KEYS,
  SUGGESTED_ACTIONS,
  SUPPORTED_SCHEMA_VERSIONS,
} from './types.ts'

/** 违反项 code 闭合集合（新增校验规则必须在这里登记）。 */
export type ViolationCode =
  | 'ROOT_NOT_OBJECT'
  | 'UNEXPECTED_KEY'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'ASSET_SHA_INVALID'
  | 'MEDIA_TYPE_UNSUPPORTED'
  | 'COMPLETENESS_INVALID'
  | 'BLOCKS_NOT_ARRAY'
  | 'BLOCK_NOT_OBJECT'
  | 'BLOCK_ID_INVALID'
  | 'BLOCK_ID_DUPLICATED'
  | 'BLOCK_KIND_INVALID'
  | 'BLOCK_TEXT_EMPTY'
  | 'BLOCK_ORDER_INVALID'
  | 'BLOCK_ORDER_DUPLICATED'
  | 'BLOCK_ORDER_NOT_ASCENDING'
  | 'LOCATOR_MISSING'
  | 'LOCATOR_INVALID'
  | 'LOCATOR_MEDIA_MISMATCH'
  | 'LINK_INVALID'
  | 'LINK_LOCATOR_INVALID'
  | 'PROVENANCE_INVALID'
  | 'NEEDS_VISUAL_INVALID'
  | 'ISSUES_NOT_ARRAY'
  | 'ISSUE_NOT_OBJECT'
  | 'ISSUE_CODE_INVALID'
  | 'ISSUE_MESSAGE_INVALID'
  | 'ISSUE_SEVERITY_INVALID'
  | 'ISSUE_RETRYABLE_INVALID'
  | 'ISSUE_ACTION_INVALID'
  | 'ISSUE_LOCATOR_INVALID'
  | 'ELAPSED_INVALID'
  | 'COMPLETENESS_CONTRADICTS_ISSUES'
  | 'COMPLETENESS_CONTRADICTS_VISUAL'
  | 'TEXT_EMPTY_WITH_BLOCKS'

/** 一条违反项。`severity` 用 hard / soft，与 `structure/validate.ts` 同口径。 */
export interface DocumentViolation {
  readonly code: ViolationCode
  readonly severity: 'hard' | 'soft'
  readonly message: string
  /** 位置，如 `blocks[2].locator.page` / `issues[0].severity`。 */
  readonly path: string
  /** 相关块的 block_id（能定位时给）。 */
  readonly block_id?: string
}

/** 校验统计（给报告与断言用）。 */
export interface DocumentContentStats {
  readonly blocks: number
  readonly links: number
  readonly issues: number
  /** content 自己声明的 HARD issue 数（不是 violation 数）。 */
  readonly hard_issues: number
  readonly soft_issues: number
  readonly violations_hard: number
  readonly violations_soft: number
  /** 通过形状检查的 media_type；不合法时为 null。 */
  readonly media_type: string | null
}

/** 校验结果。 */
export interface DocumentContentValidation {
  /** 没有 hard violation。 */
  readonly valid: boolean
  /** 全部违反项（hard + soft）。 */
  readonly violations: readonly DocumentViolation[]
  readonly stats: DocumentContentStats
}

interface Context {
  readonly violations: DocumentViolation[]
  readonly seenBlockIds: Map<string, string>
  readonly seenOrders: Map<number, string>
  mediaType: string | null
  blocks: number
  links: number
  issues: number
  hardIssues: number
  softIssues: number
  /** content 的 completeness（只在校验器确认枚举合法后记录，供跨字段红线用）。 */
  completeness: string | null
  needsVisual: boolean | null
}

/** 普通对象（数组 / null 都不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串。 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** 有限数字。 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 非负整数。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/** 消息里展示一个值，避免 [object Object]。 */
function showValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return Array.isArray(value) ? 'array' : 'object'
}

/** 记一条 hard violation。 */
function pushHard(
  ctx: Context,
  code: ViolationCode,
  message: string,
  path: string,
  blockId?: string,
): void {
  ctx.violations.push(
    blockId === undefined ? { code, severity: 'hard', message, path } : { code, severity: 'hard', message, path, block_id: blockId },
  )
}

/** 记一条 soft violation。 */
function pushSoft(
  ctx: Context,
  code: ViolationCode,
  message: string,
  path: string,
  blockId?: string,
): void {
  ctx.violations.push(
    blockId === undefined ? { code, severity: 'soft', message, path } : { code, severity: 'soft', message, path, block_id: blockId },
  )
}

/**
 * 契约里的对象都是封闭键集（与 docs/19 的最小类型一致）：表外键一律拒绝。
 * **不静默忽略** —— 静默忽略会让一份「校验通过」的内容其实有没被检查过的字段。
 */
function checkAllowedKeys(
  ctx: Context,
  path: string,
  raw: Record<string, unknown>,
  allowed: readonly string[],
  subject: string,
): void {
  for (const key of Object.keys(raw).sort()) {
    if (allowed.includes(key)) continue
    pushHard(
      ctx,
      'UNEXPECTED_KEY',
      `${subject} ${path} carries key ${JSON.stringify(key)}, which the contract does not allow (allowed: ${allowed.join(', ')})`,
      `${path}.${key}`,
    )
  }
}

/** 校验 bbox：恰好 4 个有限数，且不反转（允许零面积）。 */
function checkBBox(ctx: Context, raw: unknown, path: string): BBox | null {
  if (!Array.isArray(raw)) {
    pushHard(ctx, 'LOCATOR_INVALID', `${path} bbox must be an array of 4 finite numbers`, path)
    return null
  }
  if (raw.length !== 4) {
    pushHard(
      ctx,
      'LOCATOR_INVALID',
      `${path} bbox must have exactly 4 numbers, got ${raw.length}`,
      path,
    )
    return null
  }
  for (let i = 0; i < 4; i += 1) {
    if (!isFiniteNumber(raw[i])) {
      pushHard(ctx, 'LOCATOR_INVALID', `${path} bbox[${i}] must be a finite number, got ${showValue(raw[i])}`, `${path}[${i}]`)
      return null
    }
  }
  const [x0, y0, x1, y1] = raw as [number, number, number, number]
  if (x1 < x0 || y1 < y0) {
    pushHard(
      ctx,
      'LOCATOR_INVALID',
      `${path} bbox [${x0}, ${y0}, ${x1}, ${y1}] is inverted; expected [x0, y0, x1, y1] with x0 <= x1 and y0 <= y1`,
      path,
    )
    return null
  }
  return [x0, y0, x1, y1]
}

/** media_type → 允许的 locator kind。 */
function allowedLocatorKinds(mediaType: string | null): readonly string[] {
  if (mediaType === 'application/pdf') return ['pdf']
  if (mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return ['docx']
  if (mediaType === 'application/rtf') return ['rtf']
  if (mediaType === 'image/png' || mediaType === 'image/jpeg') return ['image']
  return []
}

/**
 * 校验一个 locator。
 * @returns 合法时返回规范化对象；不合法返回 null（已记 violation）。
 */
function checkLocator(
  ctx: Context,
  raw: unknown,
  path: string,
  code: 'LOCATOR_INVALID' | 'ISSUE_LOCATOR_INVALID' | 'LINK_LOCATOR_INVALID' = 'LOCATOR_INVALID',
): EvidenceLocator | null {
  if (raw === undefined || raw === null) {
    pushHard(ctx, 'LOCATOR_MISSING', `${path} is required by the contract`, path)
    return null
  }
  if (!isPlainObject(raw)) {
    pushHard(ctx, code, `${path} must be an object with a "kind" discriminator`, path)
    return null
  }
  const kind = raw.kind
  if (kind !== 'pdf' && kind !== 'docx' && kind !== 'image' && kind !== 'rtf') {
    pushHard(ctx, code, `${path} kind must be one of pdf / docx / image / rtf, got ${showValue(kind)}`, `${path}.kind`)
    return null
  }

  if (kind === 'pdf') {
    checkAllowedKeys(ctx, path, raw, PDF_LOCATOR_KEYS, 'locator')
    if (!isNonNegativeInteger(raw.page)) {
      pushHard(ctx, code, `${path} page must be a non-negative integer, got ${showValue(raw.page)}`, `${path}.page`)
      return null
    }
    if (raw.page < 1) {
      // page 0 是「读取器没报页码」的哨兵（types.ts LOCATOR_PAGE_UNKNOWN）：
      // 宁可判非法，也不编一个真实页码。
      pushHard(
        ctx,
        code,
        `${path} page must be >= 1 (1-based); 0 means the reader did not report a page, which is not valid evidence`,
        `${path}.page`,
      )
      return null
    }
    if (raw.block_id !== undefined && !isNonEmptyString(raw.block_id)) {
      pushHard(ctx, code, `${path} block_id must be a non-empty string when present`, `${path}.block_id`)
      return null
    }
    if (raw.bbox === undefined) return { kind: 'pdf', page: raw.page }
    const bbox = checkBBox(ctx, raw.bbox, `${path}.bbox`)
    if (bbox === null) return null
    return raw.block_id === undefined
      ? { kind: 'pdf', page: raw.page, bbox }
      : { kind: 'pdf', page: raw.page, bbox, block_id: raw.block_id }
  }

  if (kind === 'docx') {
    checkAllowedKeys(ctx, path, raw, DOCX_LOCATOR_KEYS, 'locator')
    if (!isNonEmptyString(raw.part)) {
      pushHard(ctx, code, `${path} part must be a non-empty string (e.g. "word/document.xml")`, `${path}.part`)
      return null
    }
    for (const key of ['paragraph_id', 'table_id'] as const) {
      if (raw[key] !== undefined && !isNonEmptyString(raw[key])) {
        pushHard(ctx, code, `${path} ${key} must be a non-empty string when present`, `${path}.${key}`)
        return null
      }
    }
    for (const key of ['row', 'cell'] as const) {
      if (raw[key] !== undefined && !isNonNegativeInteger(raw[key])) {
        pushHard(ctx, code, `${path} ${key} must be a non-negative integer when present`, `${path}.${key}`)
        return null
      }
    }
    if ((raw.row !== undefined || raw.cell !== undefined) && raw.table_id === undefined) {
      pushHard(
        ctx,
        code,
        `${path} gives row/cell without table_id; a cell cannot be located without its table`,
        path,
      )
      return null
    }
    const out: Record<string, unknown> = { kind: 'docx', part: raw.part }
    for (const key of ['paragraph_id', 'table_id', 'row', 'cell']) {
      if (raw[key] !== undefined) out[key] = raw[key]
    }
    return out as unknown as EvidenceLocator
  }

  if (kind === 'rtf') {
    checkAllowedKeys(ctx, path, raw, RTF_LOCATOR_KEYS, 'locator')
    if (raw.paragraph === undefined && raw.page === undefined) {
      pushHard(
        ctx,
        code,
        `${path} RTF locator needs at least one of paragraph / page; neither given means no evidence at all`,
        path,
      )
      return null
    }
    if (raw.paragraph !== undefined && !isNonNegativeInteger(raw.paragraph)) {
      pushHard(
        ctx,
        code,
        `${path} paragraph must be a non-negative integer (0-based reader block index), got ${showValue(raw.paragraph)}`,
        `${path}.paragraph`,
      )
      return null
    }
    const out: { kind: 'rtf', paragraph?: number, page?: number } = { kind: 'rtf' }
    if (raw.paragraph !== undefined) out.paragraph = raw.paragraph
    if (raw.page === undefined) return out
    if (!isNonNegativeInteger(raw.page)) {
      pushHard(ctx, code, `${path} page must be a non-negative integer, got ${showValue(raw.page)}`, `${path}.page`)
      return null
    }
    if (raw.page < 1) {
      // 同 PDF 口径：0 = 读取器没报页码的哨兵，宁可判非法也不编一个真实页码。
      pushHard(
        ctx,
        code,
        `${path} page must be >= 1 (1-based); 0 means the reader did not report a page, which is not valid evidence`,
        `${path}.page`,
      )
      return null
    }
    out.page = raw.page
    return out
  }

  // kind === 'image'
  checkAllowedKeys(ctx, path, raw, IMAGE_LOCATOR_KEYS, 'locator')
  if (raw.frame !== undefined && !isNonNegativeInteger(raw.frame)) {
    pushHard(ctx, code, `${path} frame must be a non-negative integer when present`, `${path}.frame`)
    return null
  }
  if (raw.bbox === undefined) {
    return raw.frame === undefined ? { kind: 'image' } : { kind: 'image', frame: raw.frame }
  }
  const bbox = checkBBox(ctx, raw.bbox, `${path}.bbox`)
  if (bbox === null) return null
  const out: Record<string, unknown> = { kind: 'image', bbox }
  if (raw.frame !== undefined) out.frame = raw.frame
  return out as unknown as EvidenceLocator
}

/** 校验一条链接。 */
function checkLink(ctx: Context, path: string, raw: unknown): void {
  ctx.links += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'LINK_INVALID', `link ${path} must be an object ({ text, href })`, path)
    return
  }
  checkAllowedKeys(ctx, path, raw, DOCUMENT_LINK_KEYS, 'link')
  if (!isNonEmptyString(raw.text)) {
    pushHard(ctx, 'LINK_INVALID', `link ${path} text must be a non-empty string`, `${path}.text`)
    return
  }
  if (!isNonEmptyString(raw.href)) {
    pushHard(ctx, 'LINK_INVALID', `link ${path} href must be a non-empty string`, `${path}.href`)
    return
  }
  if (raw.locator !== undefined && raw.locator !== null) {
    checkLocator(ctx, raw.locator, `${path}.locator`, 'LINK_LOCATOR_INVALID')
  }
}

/** 校验一个块。 */
function checkBlock(ctx: Context, path: string, raw: unknown): void {
  ctx.blocks += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'BLOCK_NOT_OBJECT', `block ${path} must be an object`, path)
    return
  }
  checkAllowedKeys(ctx, path, raw, DOCUMENT_BLOCK_KEYS, 'block')

  // block_id：非空且全篇唯一。
  let blockId: string | null = null
  if (!isNonEmptyString(raw.block_id)) {
    pushHard(ctx, 'BLOCK_ID_INVALID', `block ${path} block_id must be a non-empty string`, `${path}.block_id`)
  } else {
    blockId = raw.block_id
    const first = ctx.seenBlockIds.get(blockId)
    if (first !== undefined) {
      pushHard(
        ctx,
        'BLOCK_ID_DUPLICATED',
        `block ${path} reuses block_id ${JSON.stringify(blockId)} (first at ${first}); block ids must be unique`,
        `${path}.block_id`,
        blockId,
      )
    } else {
      ctx.seenBlockIds.set(blockId, path)
    }
  }

  // kind：封闭枚举。
  if (typeof raw.kind !== 'string' || !(BLOCK_KINDS as readonly string[]).includes(raw.kind)) {
    pushHard(
      ctx,
      'BLOCK_KIND_INVALID',
      `block ${path} kind ${showValue(raw.kind)} is not one of: ${BLOCK_KINDS.join(', ')}`,
      `${path}.kind`,
      blockId ?? undefined,
    )
  }

  // text：必须存在且是字符串；空字符串只记 soft（空块可疑但不是非法）。
  if (typeof raw.text !== 'string') {
    pushHard(ctx, 'INVALID_FIELD', `block ${path} text must be a string, got ${showValue(raw.text)}`, `${path}.text`, blockId ?? undefined)
  } else if (raw.text.trim() === '') {
    pushSoft(
      ctx,
      'BLOCK_TEXT_EMPTY',
      `block ${path} text is empty; an empty block carries no evidence and is usually a read defect`,
      `${path}.text`,
      blockId ?? undefined,
    )
  }

  // order：整数、非负、唯一、严格递增（阅读顺序必须是一个确定的全序）。
  if (!isNonNegativeInteger(raw.order)) {
    pushHard(
      ctx,
      'BLOCK_ORDER_INVALID',
      `block ${path} order must be a non-negative integer, got ${showValue(raw.order)}`,
      `${path}.order`,
      blockId ?? undefined,
    )
  } else {
    const first = ctx.seenOrders.get(raw.order)
    if (first !== undefined) {
      pushHard(
        ctx,
        'BLOCK_ORDER_DUPLICATED',
        `block ${path} reuses order ${raw.order} (first at ${first}); reading order must be unique`,
        `${path}.order`,
        blockId ?? undefined,
      )
    } else {
      ctx.seenOrders.set(raw.order, path)
    }
  }

  // locator：必填，且 kind 必须与 media_type 一致（证据指错类型 = 无效证据）。
  const locator = checkLocator(ctx, raw.locator, `${path}.locator`)
  if (locator !== null && ctx.mediaType !== null) {
    const allowed = allowedLocatorKinds(ctx.mediaType)
    if (!allowed.includes(locator.kind)) {
      pushHard(
        ctx,
        'LOCATOR_MEDIA_MISMATCH',
        `block ${path} locator kind ${JSON.stringify(locator.kind)} cannot locate media_type ${JSON.stringify(ctx.mediaType)}; allowed: ${allowed.join(', ')}`,
        `${path}.locator.kind`,
        blockId ?? undefined,
      )
    }
  }

  // provenance：封闭枚举（OCR / 模型读出的文字不许标 native_text —— 但「标的对不对」
  // 是质量 Gate 的活，本层只判取值是否在集合内）。
  if (typeof raw.provenance !== 'string' || !(PROVENANCES as readonly string[]).includes(raw.provenance)) {
    pushHard(
      ctx,
      'PROVENANCE_INVALID',
      `block ${path} provenance ${showValue(raw.provenance)} is not one of: ${PROVENANCES.join(', ')}`,
      `${path}.provenance`,
      blockId ?? undefined,
    )
  }

  // links：可选；给了就必须是数组，每项都要合法。
  if (raw.links !== undefined && raw.links !== null) {
    if (!Array.isArray(raw.links)) {
      pushHard(ctx, 'LINK_INVALID', `block ${path} links must be an array`, `${path}.links`, blockId ?? undefined)
    } else {
      for (let i = 0; i < raw.links.length; i += 1) {
        checkLink(ctx, `${path}.links[${i}]`, raw.links[i])
      }
    }
  }
}

/** 校验一条 issue。 */
function checkIssue(ctx: Context, path: string, raw: unknown): void {
  ctx.issues += 1
  if (!isPlainObject(raw)) {
    pushHard(ctx, 'ISSUE_NOT_OBJECT', `issue ${path} must be an object`, path)
    return
  }
  checkAllowedKeys(ctx, path, raw, DOCUMENT_ISSUE_KEYS, 'issue')
  if (!isNonEmptyString(raw.code)) {
    pushHard(ctx, 'ISSUE_CODE_INVALID', `issue ${path} code must be a non-empty string`, `${path}.code`)
  }
  if (typeof raw.message !== 'string' || raw.message.trim() === '') {
    pushHard(ctx, 'ISSUE_MESSAGE_INVALID', `issue ${path} message must be a non-empty string`, `${path}.message`)
  }
  if (typeof raw.severity !== 'string' || !(ISSUE_SEVERITIES as readonly string[]).includes(raw.severity)) {
    pushHard(
      ctx,
      'ISSUE_SEVERITY_INVALID',
      `issue ${path} severity ${showValue(raw.severity)} is not one of: ${ISSUE_SEVERITIES.join(', ')} (uppercase is mandated by the contract)`,
      `${path}.severity`,
    )
  } else if (raw.severity === 'HARD') {
    ctx.hardIssues += 1
  } else {
    ctx.softIssues += 1
  }
  if (typeof raw.retryable !== 'boolean') {
    pushHard(ctx, 'ISSUE_RETRYABLE_INVALID', `issue ${path} retryable must be a boolean, got ${showValue(raw.retryable)}`, `${path}.retryable`)
  }
  if (typeof raw.suggested_action !== 'string' || !(SUGGESTED_ACTIONS as readonly string[]).includes(raw.suggested_action)) {
    pushHard(
      ctx,
      'ISSUE_ACTION_INVALID',
      `issue ${path} suggested_action ${showValue(raw.suggested_action)} is not one of: ${SUGGESTED_ACTIONS.join(', ')}`,
      `${path}.suggested_action`,
    )
  }
  if (raw.locator !== undefined && raw.locator !== null) {
    checkLocator(ctx, raw.locator, `${path}.locator`, 'ISSUE_LOCATOR_INVALID')
  }
}

/**
 * 校验一份 DocumentContent。
 * @param input - 未校验的内容（故意收 unknown）。
 * @returns valid / violations / stats；**永不抛异常**。
 */
export function validateDocumentContent(input: unknown): DocumentContentValidation {
  const ctx: Context = {
    violations: [],
    seenBlockIds: new Map<string, string>(),
    seenOrders: new Map<number, string>(),
    mediaType: null,
    blocks: 0,
    links: 0,
    issues: 0,
    hardIssues: 0,
    softIssues: 0,
    completeness: null,
    needsVisual: null,
  }

  if (!isPlainObject(input)) {
    pushHard(ctx, 'ROOT_NOT_OBJECT', `document content must be an object, got ${showValue(input)}`, 'content')
    return finish(ctx)
  }

  checkAllowedKeys(ctx, 'content', input, DOCUMENT_CONTENT_KEYS, 'content')

  // schema_version：必须存在、被支持（不猜结构）。
  if (input.schema_version === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.schema_version is required', 'schema_version')
  } else if (typeof input.schema_version !== 'string' || input.schema_version === '') {
    pushHard(ctx, 'INVALID_FIELD', `content.schema_version must be a non-empty string, got ${showValue(input.schema_version)}`, 'schema_version')
  } else if (!(SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(input.schema_version)) {
    pushHard(
      ctx,
      'SCHEMA_VERSION_UNSUPPORTED',
      `content.schema_version ${JSON.stringify(input.schema_version)} is not supported (accepted: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`,
      'schema_version',
    )
  }

  // asset_sha256：原件指纹，必须能指回原件。
  if (input.asset_sha256 === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.asset_sha256 is required', 'asset_sha256')
  } else if (typeof input.asset_sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(input.asset_sha256)) {
    pushHard(
      ctx,
      'ASSET_SHA_INVALID',
      `content.asset_sha256 must be 64 hex characters, got ${showValue(input.asset_sha256)}`,
      'asset_sha256',
    )
  }

  // media_type：封闭枚举（也是 locator 合法性的判据）。
  if (input.media_type === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.media_type is required', 'media_type')
  } else if (typeof input.media_type !== 'string' || !(MEDIA_TYPES as readonly string[]).includes(input.media_type)) {
    pushHard(
      ctx,
      'MEDIA_TYPE_UNSUPPORTED',
      `content.media_type ${showValue(input.media_type)} is not one of: ${MEDIA_TYPES.join(', ')}`,
      'media_type',
    )
  } else {
    ctx.mediaType = input.media_type
  }

  // reader_id / reader_version：谁读的必须可追溯。
  for (const key of ['reader_id', 'reader_version'] as const) {
    if (input[key] === undefined) {
      pushHard(ctx, 'MISSING_FIELD', `content.${key} is required`, key)
    } else if (!isNonEmptyString(input[key])) {
      pushHard(ctx, 'INVALID_FIELD', `content.${key} must be a non-empty string, got ${showValue(input[key])}`, key)
    }
  }
  if (input.reader_profile !== undefined && !isNonEmptyString(input.reader_profile)) {
    pushHard(ctx, 'INVALID_FIELD', `content.reader_profile must be a non-empty string when present, got ${showValue(input.reader_profile)}`, 'reader_profile')
  }

  if (input.text === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.text is required', 'text')
  } else if (typeof input.text !== 'string') {
    pushHard(ctx, 'INVALID_FIELD', `content.text must be a string, got ${showValue(input.text)}`, 'text')
  }

  // blocks：数组、逐块校验。
  if (input.blocks === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.blocks is required (an empty array is valid)', 'blocks')
  } else if (!Array.isArray(input.blocks)) {
    pushHard(ctx, 'BLOCKS_NOT_ARRAY', `content.blocks must be an array, got ${showValue(input.blocks)}`, 'blocks')
  } else {
    let previousOrder: number | null = null
    for (let i = 0; i < input.blocks.length; i += 1) {
      const path = `blocks[${i}]`
      checkBlock(ctx, path, input.blocks[i])
      const order = isPlainObject(input.blocks[i]) ? (input.blocks[i] as Record<string, unknown>).order : undefined
      if (isNonNegativeInteger(order)) {
        if (previousOrder !== null && order <= previousOrder) {
          pushHard(
            ctx,
            'BLOCK_ORDER_NOT_ASCENDING',
            `${path}.order ${order} does not increase over the previous block's order ${previousOrder}; blocks must be stored in reading order`,
            `${path}.order`,
          )
        }
        previousOrder = order
      }
    }
    // text 与 blocks 的自洽（soft：读取器可以不拼 text，但空 text + 有内容是可复现的缺陷信号）。
    if (typeof input.text === 'string' && input.text.trim() === '' && input.blocks.length > 0) {
      pushSoft(
        ctx,
        'TEXT_EMPTY_WITH_BLOCKS',
        `content.text is empty but ${input.blocks.length} block(s) carry text; downstream consumers must read blocks, not text`,
        'text',
      )
    }
  }

  // completeness：三态。
  if (input.completeness === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.completeness is required', 'completeness')
  } else if (typeof input.completeness !== 'string' || !(COMPLETENESS_STATES as readonly string[]).includes(input.completeness)) {
    pushHard(
      ctx,
      'COMPLETENESS_INVALID',
      `content.completeness ${showValue(input.completeness)} is not one of: ${COMPLETENESS_STATES.join(', ')}`,
      'completeness',
    )
  } else {
    ctx.completeness = input.completeness
  }

  // needs_visual：布尔。
  if (input.needs_visual === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.needs_visual is required', 'needs_visual')
  } else if (typeof input.needs_visual !== 'boolean') {
    pushHard(ctx, 'NEEDS_VISUAL_INVALID', `content.needs_visual must be a boolean, got ${showValue(input.needs_visual)}`, 'needs_visual')
  } else {
    ctx.needsVisual = input.needs_visual
  }

  // issues：数组、逐条校验（severity 大写枚举是硬约束）。
  if (input.issues === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.issues is required (an empty array is valid)', 'issues')
  } else if (!Array.isArray(input.issues)) {
    pushHard(ctx, 'ISSUES_NOT_ARRAY', `content.issues must be an array, got ${showValue(input.issues)}`, 'issues')
  } else {
    for (let i = 0; i < input.issues.length; i += 1) checkIssue(ctx, `issues[${i}]`, input.issues[i])
  }

  // tables：可选；出现时逐表校验（与正文同源的结构化视图，不得伪造坐标/单元格）。
  if (input.tables !== undefined) {
    if (!Array.isArray(input.tables)) {
      pushHard(ctx, 'INVALID_FIELD', `content.tables must be an array, got ${showValue(input.tables)}`, 'tables')
    } else {
      for (let i = 0; i < input.tables.length; i += 1) {
        const table: unknown = input.tables[i]
        const path = `tables[${i}]`
        if (!isPlainObject(table)) {
          pushHard(ctx, 'INVALID_FIELD', `${path} must be an object, got ${showValue(table)}`, path)
          continue
        }
        checkAllowedKeys(ctx, path, table, DOCUMENT_TABLE_KEYS, 'table')
        if (typeof table.page !== 'number' || !Number.isInteger(table.page) || table.page < 1) {
          pushHard(ctx, 'INVALID_FIELD', `${path}.page must be a 1-based integer, got ${showValue(table.page)}`, `${path}.page`)
        }
        const bbox = table.bbox
        if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => !isFiniteNumber(value))) {
          pushHard(ctx, 'INVALID_FIELD', `${path}.bbox must be four finite numbers, got ${showValue(bbox)}`, `${path}.bbox`)
        }
        for (const key of ['row_count', 'col_count'] as const) {
          if (typeof table[key] !== 'number' || !Number.isInteger(table[key]) || table[key] < 0) {
            pushHard(ctx, 'INVALID_FIELD', `${path}.${key} must be a non-negative integer, got ${showValue(table[key])}`, `${path}.${key}`)
          }
        }
        if (typeof table.header_external !== 'boolean') {
          pushHard(ctx, 'INVALID_FIELD', `${path}.header_external must be a boolean, got ${showValue(table.header_external)}`, `${path}.header_external`)
        }
        if (!Array.isArray(table.cells) || table.cells.some((row) => !Array.isArray(row) || row.some((cell) => typeof cell !== 'string'))) {
          pushHard(ctx, 'INVALID_FIELD', `${path}.cells must be a string[][] (empty cell = ""), got ${showValue(table.cells)}`, `${path}.cells`)
        }
        if (table.provenance !== 'native_text') {
          pushHard(ctx, 'INVALID_FIELD', `${path}.provenance must be "native_text", got ${showValue(table.provenance)}`, `${path}.provenance`)
        }
        if (!isNonEmptyString(table.source)) {
          pushHard(ctx, 'INVALID_FIELD', `${path}.source must be a non-empty string, got ${showValue(table.source)}`, `${path}.source`)
        }
      }
    }
  }

  // elapsed_ms：非负有限数；0 = 没测（见 types.ts）。
  if (input.elapsed_ms === undefined) {
    pushHard(ctx, 'MISSING_FIELD', 'content.elapsed_ms is required', 'elapsed_ms')
  } else if (!isFiniteNumber(input.elapsed_ms) || input.elapsed_ms < 0) {
    pushHard(ctx, 'ELAPSED_INVALID', `content.elapsed_ms must be a non-negative finite number, got ${showValue(input.elapsed_ms)}`, 'elapsed_ms')
  }

  // 跨字段红线：complete 不得与「还有 HARD issue」/「还有未读视觉内容」并存。
  if (ctx.completeness === 'complete' && ctx.hardIssues > 0) {
    pushHard(
      ctx,
      'COMPLETENESS_CONTRADICTS_ISSUES',
      `content claims completeness "complete" while carrying ${ctx.hardIssues} HARD issue(s); an unresolved HARD issue means the read is not complete`,
      'completeness',
    )
  }
  if (ctx.completeness === 'complete' && ctx.needsVisual === true) {
    pushHard(
      ctx,
      'COMPLETENESS_CONTRADICTS_VISUAL',
      'content claims completeness "complete" while needs_visual is true; unread visual content means the read is not complete',
      'completeness',
    )
  }

  return finish(ctx)
}

/** 汇总结果。 */
function finish(ctx: Context): DocumentContentValidation {
  const violationsHard = ctx.violations.filter((v) => v.severity === 'hard').length
  return {
    valid: violationsHard === 0,
    violations: ctx.violations,
    stats: {
      blocks: ctx.blocks,
      links: ctx.links,
      issues: ctx.issues,
      hard_issues: ctx.hardIssues,
      soft_issues: ctx.softIssues,
      violations_hard: violationsHard,
      violations_soft: ctx.violations.length - violationsHard,
      media_type: ctx.mediaType,
    },
  }
}

/**
 * 把违反项渲染成一行一条的文本（给 CLI / 日志 / 报告用；不参与判定）。
 * @param validation - validateDocumentContent 的结果。
 */
export function formatViolations(validation: DocumentContentValidation): string {
  if (validation.violations.length === 0) return 'ok: no violations'
  return validation.violations
    .map((v) => `${v.severity.toUpperCase()} ${v.code} ${v.path}: ${v.message}`)
    .join('\n')
}

/** 供类型消费者使用的窄化断言（只在测试/工具里用；校验器本身不抛）。 */
export function isDocumentContent(value: unknown): value is DocumentContent {
  return validateDocumentContent(value).valid
}
