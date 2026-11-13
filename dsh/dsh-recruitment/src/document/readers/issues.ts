// issue 构造函数：把「严重级别 / 可重试 / 建议动作」的写法收敛到一处。
//
// 类型来自 canonical 契约 `src/document/contracts/`（U0），本文件不再声明第二套。
// severity 语义（docs/19 §2.2 第 5 条）：HARD = 原文遗漏 / 顺序不可靠 / URI 丢失
// 或凭空生成 / 证据对不上等，未解除不得把结果当可信内容继续。SOFT 只记录已读出
// 事实里的解释性信息。converter 的 issue 严重度不在这里判断 —— 那是
// `contracts/map-converter.ts` 的映射（与 converter/src/issues.py 对齐）的事。

import type {
  DocumentIssue,
  EvidenceLocator,
  IssueSeverity,
  SuggestedAction,
} from '../contracts/index.ts'

export function makeIssue(
  code: string,
  message: string,
  severity: IssueSeverity,
  suggestedAction: SuggestedAction,
  retryable = false,
  locator?: EvidenceLocator,
): DocumentIssue {
  return locator === undefined
    ? { code, message, severity, retryable, suggested_action: suggestedAction }
    : { code, message, locator, severity, retryable, suggested_action: suggestedAction }
}

export function hardIssue(
  code: string,
  message: string,
  suggestedAction: SuggestedAction = 'human_review',
  locator?: EvidenceLocator,
  retryable = false,
): DocumentIssue {
  return makeIssue(code, message, 'HARD', suggestedAction, retryable, locator)
}
