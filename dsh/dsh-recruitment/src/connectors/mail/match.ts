// 自动分岗：邮件主题/正文 → 在招岗位（Issue #25 / G-02）。
//
// 口径（fail-closed，绝不乱挂）：
//   1. 只认 `status === 'OPEN'` 的岗位为「在招」。其余（DRAFT/PENDING_REVIEW/APPROVED/
//      PAUSED/CLOSED/ARCHIVED）一律不作为候选。
//   2. 精确岗位编码优先：从主题/正文抽出候选 token，与 `job.code` 做大小写不敏感的
//      **精确**相等比较（`DEMO-BE-001`、`JOB-20261114-77CD5B` 这类格式）。
//      多封邮件里出现多个**不同**且都能命中在招岗位的编码 → 多义，跳过。
//   3. 没有编码命中时，才做标题匹配：规范化的岗位标题在主题/正文中作为连续子串出现，
//      且**唯一**命中一个在招岗位才算命中；0 个 = 未命中，≥2 个 = 多义。
//   4. 所有未命中/多义都返回稳定的 `unmatched_reason` 供观测，不抛异常、不猜岗位。
//
// 本文件是纯函数：不连库、不连网络、不读 env。

/** 岗位候选（从 recruitment.job 投影出的最小字段）。 */
export interface MailJobCandidate {
  readonly id: string
  readonly code: string
  readonly title: string
  /** 只有 OPEN 才是「在招」。 */
  readonly status: string
}

export type JobMatchResult =
  | { readonly matched: true; readonly job_id: string; readonly strategy: 'EXACT_CODE' | 'UNIQUE_TITLE' }
  | {
      readonly matched: false
      readonly unmatched_reason:
        | 'NO_OPEN_JOBS'
        | 'NO_CODE_OR_TITLE_MATCH'
        | 'AMBIGUOUS_CODE'
        | 'AMBIGUOUS_TITLE'
        | 'INVALID_JOB'
    }

/** 从 job 行投影出候选；id/code/title 非空的 OPEN 岗位才有效。 */
export function toJobCandidates(rows: readonly {
  id?: unknown
  code?: unknown
  title?: unknown
  status?: unknown
}[]): readonly MailJobCandidate[] {
  return rows
    .filter((row) => row !== null && typeof row === 'object' && row.status === 'OPEN')
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id.trim() : '',
      code: typeof row.code === 'string' ? row.code.trim() : '',
      title: typeof row.title === 'string' ? row.title.trim() : '',
      status: 'OPEN',
    }))
    .filter((row) => row.id !== '' && (row.code !== '' || row.title !== ''))
}

/**
 * 提取可能的岗位编码 token。格式：`[A-Za-z0-9]` 开头、含至少一段数字、允许 `-`/`_`/`.`，
 * 长度 4..64；用非字母数字边界切开，避免把中文/长句整段当编码。
 *
 * 例子：`DEMO-BE-001`、`JOB-20261114-77CD5B`、`job_abc123`。
 */
export function extractJobCodeTokens(text: string): readonly string[] {
  if (typeof text !== 'string' || text === '') return []
  const matches = text.match(/[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)+/g) ?? []
  return [...new Set(matches.map((token) => token.trim()).filter((token) => token.length >= 4 && token.length <= 64))]
}

/** 规范化标题：去空白/大小写/标点差异，只保留字母数字（中文保留）。 */
export function normalizeJobTitle(value: string): string {
  if (typeof value !== 'string') return ''
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * 解析邮件归属岗位。
 *
 * @param subject 邮件主题（envelope.subject + parsed.summary.subject 合并更好）
 * @param body 正文摘要（parsed.summary.text_summary / message.text）
 * @param jobs 在招岗位候选（应先按租户查询且只取 OPEN）
 */
export function resolveJobForMail(
  subject: string,
  body: string,
  jobs: readonly MailJobCandidate[],
): JobMatchResult {
  const valid = jobs.filter((job) => typeof job.id === 'string' && job.id !== '' && job.status === 'OPEN')
  if (valid.length === 0) return { matched: false, unmatched_reason: 'NO_OPEN_JOBS' }

  const text = `${subject}\n${body}`
  const upper = text.toUpperCase()

  // ① 精确编码优先：分别按每个 token 做整词等值匹配（不是子串），避免
  //    `JOB-123` 命中 `JOB-1234`。用 token 边界（非 [A-Z0-9_-]）保护两侧。
  const codeHits = new Map<string, MailJobCandidate>()
  for (const token of extractJobCodeTokens(text)) {
    const target = token.toUpperCase()
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const wholeWord = new RegExp(`(^|[^A-Z0-9_-])${escaped}([^A-Z0-9_-]|$)`, 'i')
    if (!wholeWord.test(upper)) continue
    for (const job of valid) {
      if (job.code !== '' && job.code.toUpperCase() === target) codeHits.set(job.id, job)
    }
  }
  if (codeHits.size === 1) {
    const job = [...codeHits.values()][0]!
    return { matched: true, job_id: job.id, strategy: 'EXACT_CODE' }
  }
  if (codeHits.size > 1) return { matched: false, unmatched_reason: 'AMBIGUOUS_CODE' }

  // ② 唯一标题匹配：规范化后的标题必须非空，且在规范化后的 主题+正文 中连续出现。
  const normalizedText = normalizeJobTitle(text)
  const titleHits = new Map<string, MailJobCandidate>()
  for (const job of valid) {
    const title = normalizeJobTitle(job.title)
    if (title.length === 0 || normalizedText.length === 0) continue
    if (normalizedText.includes(title)) titleHits.set(job.id, job)
  }
  if (titleHits.size === 1) {
    const job = [...titleHits.values()][0]!
    return { matched: true, job_id: job.id, strategy: 'UNIQUE_TITLE' }
  }
  if (titleHits.size > 1) return { matched: false, unmatched_reason: 'AMBIGUOUS_TITLE' }
  return { matched: false, unmatched_reason: 'NO_CODE_OR_TITLE_MATCH' }
}
