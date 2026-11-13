// U2 质量层入口。对外只有：稳定 code 表、判定器、三条不变量的可执行断言。

export type {
  Assessment,
  AssessmentAction,
  AssessmentFacts,
  AssessmentIssue,
  AttributionBasis,
  AttributionConfidence,
  Completeness,
  DocumentContentLike,
  EvidenceLocator,
  EvidenceState,
  ExperienceAttribution,
  FieldPresence,
  IssueSeverity,
  MediaType,
  NormalizedBlock,
  NormalizedContent,
  Provenance,
  RawIssue,
  ReaderFacts,
  SuggestedAction,
} from './types.ts'

export type { CodeLookup, IssueCodeSpec, IssueOrigin } from './issue-codes.ts'
export {
  CONVERTER_ISSUE_CODES,
  DOCUMENT_ISSUE_CODES,
  LAYOUT_ONLY_ISSUE_CODES,
  UNREGISTERED_ISSUE_SPEC,
  knownIssueCodes,
  lookupIssueCode,
  stricterSeverity,
} from './issue-codes.ts'

export type { DocumentIssueCode } from './issue-codes.ts'

export {
  countUnreadableMarkers,
  locatorKey,
  locatorPage,
  nonWhitespaceChars,
  normalizeContent,
  normalizeLocator,
} from './normalize.ts'

export {
  DOCUMENT_LEVEL_UNREAD,
  VERIFIED_PROVENANCE,
  attributeExperienceRows,
  attributionDetail,
  blockLocatorKeys,
  buildIssue,
  checkCharFidelity,
  checkCompletenessExplained,
  checkContract,
  checkCoverage,
  checkCrossBlockAttribution,
  checkProvenance,
  checkReadingOrder,
  checkUris,
  checkUnreadableGlyphs,
  hasDateRange,
  hasIdentityTokens,
  hasOrgToken,
  hasRoleToken,
  hasSubjectText,
  isAnchorBlock,
  subjectTextOf,
} from './checks.ts'
export type { CheckContext } from './checks.ts'

export {
  assess,
  canProceedToStructure,
  evidenceState,
  fieldPresence,
  isBlocked,
  mayConcludeAbsence,
} from './assess.ts'

export { readerFactsFromSourceMeta } from './source-facts.ts'
