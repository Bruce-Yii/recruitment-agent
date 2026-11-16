// recruitment_interview_record_verify —— S9 记录线的**人类核验入口**（D-B 修复）。
//
// 为什么必须有这个工具（缺陷是被独立复跑实测确认的）：
//   `recruitment_transcript_import` 落 interview_record 时写的是**确定性中性记录**
//   （`status='NEEDS_REVIEW'` / `verification_status='UNVERIFIED'`，见 TR-C6 / TR-D2），
//   而 `contracts/evaluation/decision-rules.md` 的 **DC-23** 要求"引用 INTERVIEW_RECORD
//   作决策依据"必须 `status='READY' ∧ verification_status='VERIFIED'`（库层
//   `ck_interview_record_ready` 也是这条）。此前全仓**没有任何产品工具**能写出
//   `VERIFIED`：`evaluation_summarize` 只能给 `record.state='NOT_READY'` +
//   `warning RECORD_NOT_READY`，S10 决策引不了 `INTERVIEW_RECORD`（Golden Path 的
//   basis 里确实没有它）。本工具补的就是"人核验过"这一步的产品入口。
//
// 五条不可协商的规则：
//
//   1. **核验是人的动作，Agent 不许自己核**（AGENTS.md §1.1"人类闸门不可绕过"；
//      `docs/20 §2`；D-79）。
//      进入任何写库之前必须过 `ctx.approval`（DSH 自带 seam，fail-closed）：
//      只有宿主收到人的 `allowed-once` 才继续；`unavailable` / `rejected` /
//      `cancelled` / 120s 超时 → `FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED)`，
//      **一行不写**。决定者必须是本租户 `kind='HUMAN'` 的 actor。
//     与 `recruitment_job_rubric_approve` 同一模式（同一个 120s 上限常量、同一个
//      四值封闭集）；只是工具名与 reason 不同，所以本文件自带 request/require 两个
//      薄函数（不复制策略值，公共常量从 job-rubric-approve 复用）。
//
//   2. **合法前置才准推进，否则结构化拒绝 + 零写入**（不是"带警告地标 VERIFIED"）：
//      record 必须是**当前行**（`is_current`；`evaluation_summarize` 只读当前行）；
//      必须引用一版**可用**的转写：artifact 行存在且同租户（`fk_interview_record_artifact`
//      没带 tenant_id，G-5 → 写侧自己校验）、`transcript_status='READY'`、
//      `is_complete=true`、`has_more=false`、原文非空、**片段数 > 0**、且该 artifact
//      所属会议确实绑过这场面试；
//      record 自己的证据索引（`sections.basis` / `sections.citations`）必须逐条落地
//      到真实片段（引了不存在的序号 = 证据链断了，不许核过）；
//      最后，record 钉的 rubric 版本必须仍是申请当前钉住的那一版（否则核过的记录会
//      把旧标准的面评证据带进决策，与 SC-11 同一精神）。
//
//   3. **状态机以库为准**（`0001_init.sql:1182-1232`）：
//      合法源态**只有** `NEEDS_REVIEW/UNVERIFIED`；目标态 `READY/VERIFIED` 是库层
//      唯一自洽组合（`ck_interview_record_ready: status<>'READY' or verification_status='VERIFIED'`，
//      `0001:L1228`），所以一次 UPDATE 同时改两列，**绝不**为了过测试改迁移。
//      其它状态（PENDING/PROCESSING/PARTIAL/FAILED，或 READY 但 UNVERIFIED 这种库允许
//      但业务上矛盾的脏行）→ `INVALID_ARGS(STATUS_NOT_VERIFIABLE)`，零写入。
//      状态迁移本身由 `fn_row_guard('status')`（`0001:L1750`）审计：自动写
//      `interview_record.status.changed`（`normalizer_version='schema/0001'`）、
//      回填 `status_source_event_id`、`record_version + 1`、`status_changed_by_actor_id`
//      取事务 GUC（`withActor` 已 SET LOCAL）。
//
//   4. **幂等：重复核验零写入、不产生第二条审计、不重复 +版本**（D-95 同一精神）：
//      已经是 `READY/VERIFIED` → `outcome='NO_OP'`、`replayed=true`、**不问人**、
//      不发 UPDATE、不写事件（`record_version` 与事件条数都不变）。
//      非当前行即使已 READY 也**不**回 NO_OP：它不能作为决策依据，核它没有意义 →
//      `INVALID_ARGS(RECORD_NOT_CURRENT)`。
//
//   5. **审计一条工具事件**：核验成功写一条 `event_inbox` 事件
//      `interview.record.verified`（名字必须在 `src/runtime/event-types.ts` 登记，
//      否则路由会把它当未登记信号走语义 Gate —— 2026-11-14 修过的"假接线"坑）。
//      payload 记 record / interview / application / artifact+revision / 两条状态轴
//      的 from→to / 核验人 / 片元数 / artifact 内容哈希 / 闸门结论 / 可选 reason。
//      幂等键每次唯一（内部事实），去重靠上面的 NO_OP 分支而不是事件键。
//
// 事务边界（与既有写工具同一条技术债 D-101）：业务校验 → 问人 → 写库都在一个事务里，
// 等人期间连接 idle in transaction，由 `db/pool.ts` 的 300s 服务端上限兜底。
// 门禁不提前到业务校验之前：注定失败的调用（记录不存在 / 前置不满足）不得先弹窗打扰人。
//
// 输出 schema 只用 DSH 子集（`test/unit/output-schema.test.ts` 口径）：**无 type 数组、
// 无 `type:'null'`、值里无 null** —— 可缺的键（`artifact` / `verified_*`）直接省略。

import { randomUUID } from 'node:crypto'

import {
  collectArgViolations,
  toParameterSchema,
  type ParamMap,
} from './args.ts'
import { contractError } from './contract.ts'
import type { ReadonlyToolDefinition, TextBlock } from './definition.ts'
import { RecruitmentToolError } from './errors.ts'
import { buildThreeAxisLabels, type ThreeAxisLabels } from './candidate-get.ts'
import { mapDatabaseError } from './job-create.ts'
import {
  APPROVAL_TIMEOUT_MS,
  type ApprovalDecision,
  type ApprovalRequester,
} from './job-rubric-approve.ts'
import { machineArgumentLines, shortHash, shortRef } from './render-ref.ts'
import {
  closePool,
  createPool,
  withActor,
  type DatabaseClient,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
// 事件名只从注册表取（`src/runtime/event-types.ts`）；机检测试会扫发射点。
import { EVENT_TYPES } from '../runtime/event-types.ts'
import { resolveWriteActor, type ToolActorDeps } from '../demo-actor/tool-actor.ts'

/** 工具名（模型可见，冻结；沿用 `recruitment_*` 命名）。 */
export const INTERVIEW_RECORD_VERIFY_TOOL = 'recruitment_interview_record_verify'
/** 输出契约版本（S9 转写线同一基线）。 */
export const CONTRACT_VERSION = '1.0.0'

/** 人工核验等待上限（毫秒）：与 `recruitment_job_rubric_approve` 同一策略值（D-101），复用同常量。 */
export const VERIFY_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUT_MS

/** 合法源态（唯一）：由 `transcript_import` 建出的中性记录。 */
export const VERIFIABLE_FROM = {
  status: 'NEEDS_REVIEW',
  verification_status: 'UNVERIFIED',
} as const

/** 目标态（库层 `ck_interview_record_ready` 唯一自洽组合）。 */
export const VERIFIED_TO = {
  status: 'READY',
  verification_status: 'VERIFIED',
} as const

/** `reason` 上界（人工备注；只进审计事件 payload，不落业务列）。 */
const MAX_REASON_CHARS = 500

// ---------------------------------------------------------------------------
//  入参（封闭对象根；tenant_id / actor_id 不接受）
// ---------------------------------------------------------------------------

const PARAMS: ParamMap = {
  interview_record_id: {
    kind: 'string',
    required: true,
    uuid: true,
    maxLength: 36,
    description:
      'Interview record id (UUID) to verify. Take record.id from recruitment_transcript_import '
      + '(or recruitment_transcript_read). Must belong to the configured tenant and must be the '
      + 'CURRENT row of that interview.',
  },
  reason: {
    kind: 'string',
    maxLength: MAX_REASON_CHARS,
    description:
      'Optional human note (1..500 characters) recorded on the audit event. '
      + 'Omit when there is nothing to say. It never changes the record content.',
  },
}

/** 已校验的入参。 */
export interface VerifyArgs {
  readonly interview_record_id: string
  readonly reason: string | undefined
}

/**
 * 校验并归一化入参（纯函数：不连库；`execute()` 与事务核心共用同一份）。
 * @param raw - 模型给的 arguments。
 * @returns 只含已声明键的入参。
 * @throws RecruitmentToolError - `INVALID_ARGS`（未知键/缺必填/非 UUID/超长）。
 */
export function parseVerifyArgs(raw: unknown): VerifyArgs {
  const { parsed, violations } = collectArgViolations(PARAMS, raw)
  if (violations.length === 0) {
    return {
      interview_record_id: parsed.interview_record_id as string,
      reason: parsed.reason as string | undefined,
    }
  }
  const first = violations[0] as { reason: string; path: string; message: string }
  throw contractError('INVALID_ARGS', {
    reason_code: first.reason,
    message: '参数不合法，逐条见 detail.violations',
    detail: {
      allowed: Object.keys(PARAMS),
      violations: violations.map((entry) => ({
        reason_code: entry.reason,
        path: entry.path,
        message: entry.message,
      })),
    },
  })
}

// ---------------------------------------------------------------------------
//  D-79 人机闸门（approval seam；与 job_rubric_approve 同一封闭集与同一超时策略）
// ---------------------------------------------------------------------------

/** 本文件的依赖：approval / identity 都是可选第二组依赖（approval 缺省 = 一律拒绝）。 */
export interface InterviewRecordVerifyDeps extends ToolActorDeps {
  /** DSH `ctx.approval` 的窄接口。缺省 = 一律拒绝（headless 恒 fail closed）。 */
  readonly approval?: ApprovalRequester
}

/**
 * 让"等宿主批准"与"等 timeoutMs"赛跑。超时返回哨兵；不等待原 promise。
 * （与 `job-rubric-approve.ts` 的 raceApproval 同语义；超时后晚到的 Allow 不采纳。）
 * @param request - 宿主的批准 promise。
 * @param timeoutMs - 等待上限（毫秒）。
 * @returns 宿主结果或 `'timeout'`。
 */
async function raceApproval(request: Promise<string>, timeoutMs: number): Promise<string | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把 approval 依赖包成"可等待的批准结果"。**缺依赖 = `unavailable`**（fail closed）。
 * 结果不在封闭集内时不猜，按 `unavailable` 处理；超时归 `'timeout'`。
 * @param approval - 依赖里的 approval 服务（可缺省）。
 * @param exec - 执行上下文（`agent` / `signal` 透传给宿主）。
 * @param timeoutMs - 等待上限（默认 120s；测试注入更短的值）。
 * @returns 一个返回 `ApprovalDecision` 的函数。
 */
export function makeVerifyApprovalRequest(
  approval: ApprovalRequester | undefined,
  exec: { readonly agent?: unknown; readonly signal?: AbortSignal } | undefined,
  timeoutMs: number = VERIFY_APPROVAL_TIMEOUT_MS,
): () => Promise<ApprovalDecision> {
  return async (): Promise<ApprovalDecision> => {
    if (approval === undefined) return 'unavailable'
    const pending = approval.request({
      agent: exec?.agent,
      toolName: INTERVIEW_RECORD_VERIFY_TOOL,
      reason: '面试记录核验是人的动作（D-B / D-79）：请确认这份面试记录的证据链确实核验通过，'
        + '并把它的状态推进为 READY/VERIFIED。',
      signal: exec?.signal,
    })
    const raw = await raceApproval(pending, timeoutMs)
    if (raw === 'timeout') {
      // 超时后宿主才点的 Allow：**不采纳**（事务已回滚，写不了库）；仍挂空 handler 防未处理拒绝。
      pending.then(() => undefined, () => undefined)
      return 'timeout'
    }
    if (raw === 'allowed-once' || raw === 'rejected' || raw === 'cancelled' || raw === 'unavailable') return raw
    return 'unavailable'
  }
}

/**
 * 写库前最后一关：**只有 `allowed-once` 放行**；其余一律 `FORBIDDEN`。
 * @param outcome - 闸门结果。
 * @throws RecruitmentToolError - `FORBIDDEN` + `APPROVAL_UNAVAILABLE` / `APPROVAL_NOT_GRANTED`。
 */
export function requireVerifyApprovalGranted(outcome: ApprovalDecision): void {
  if (outcome === 'allowed-once') return
  const unavailable = outcome === 'unavailable'
  const timedOut = outcome === 'timeout'
  throw contractError('FORBIDDEN', {
    reason_code: unavailable ? 'APPROVAL_UNAVAILABLE' : 'APPROVAL_NOT_GRANTED',
    message: unavailable
      ? '没有可用的核验通道（headless 无 answerer）：面试记录核验被拒绝（D-79，fail closed）'
      : timedOut
        ? `等待人工核验超时（${VERIFY_APPROVAL_TIMEOUT_MS / 1000} 秒）：面试记录核验被拒绝（D-79，fail closed）`
        : '人工没有批准这次面试记录核验（D-79）',
    detail: { approval: outcome, tool: INTERVIEW_RECORD_VERIFY_TOOL },
  })
}

// ---------------------------------------------------------------------------
//  纯函数：状态分类 / sections 证据解析 / 前置校验
// ---------------------------------------------------------------------------

/** 记录的状态轴（只取本文件用到的列）。 */
export interface RecordStateFacts {
  readonly id: string
  readonly status: string
  readonly verification_status: string
  readonly is_current: boolean
}

/** 状态分类的结论：幂等 / 可核验 / 拒绝。 */
export type RecordStateVerdict =
  | { readonly kind: 'IDEMPOTENT' }
  | { readonly kind: 'VERIFIABLE' }
  | {
      readonly kind: 'REFUSED'
      readonly code: 'INVALID_ARGS'
      readonly reason_code: 'RECORD_NOT_CURRENT' | 'STATUS_NOT_VERIFIABLE'
      readonly message: string
      readonly detail: Record<string, unknown>
    }

/**
 * 判定当前状态能否推进（纯函数，`0001` 的状态机口径逐条实现）。
 *
 * 顺序即语义：**先判当前行**（非当前行没有决策价值），再判幂等，最后才允许推进。
 * @param record - 记录的两条状态轴 + 是否当前行。
 * @returns 分类结论；`REFUSED` 带结构化理由（调用方直接抛）。
 */
export function classifyRecordState(record: RecordStateFacts): RecordStateVerdict {
  if (record.is_current !== true) {
    return {
      kind: 'REFUSED',
      code: 'INVALID_ARGS',
      reason_code: 'RECORD_NOT_CURRENT',
      message: '这条面试记录不是该面试的当前记录（is_current=false）：'
        + '核验它不会影响任何决策依据（evaluation_summarize 只读 is_current）；'
        + '请核验当前那条，本次没有写任何行',
      detail: { interview_record_id: record.id, status: record.status, verification_status: record.verification_status },
    }
  }
  if (record.status === VERIFIED_TO.status && record.verification_status === VERIFIED_TO.verification_status) {
    return { kind: 'IDEMPOTENT' }
  }
  if (record.status === VERIFIABLE_FROM.status && record.verification_status === VERIFIABLE_FROM.verification_status) {
    return { kind: 'VERIFIABLE' }
  }
  return {
    kind: 'REFUSED',
    code: 'INVALID_ARGS',
    reason_code: 'STATUS_NOT_VERIFIABLE',
    message: '该记录的状态不在"可核验"的源态上，不能推到 READY/VERIFIED（状态机以库为准，本次没有写任何行）',
    detail: {
      interview_record_id: record.id,
      status: record.status,
      verification_status: record.verification_status,
      verifiable_from: { ...VERIFIABLE_FROM },
      verified_to: { ...VERIFIED_TO },
    },
  }
}

/** `sections` 证据索引解析结果。 */
export type SectionsEvidence =
  | {
      readonly ok: true
      /** `sections.basis`（记录自述它依据哪一版 artifact）。 */
      readonly basis: { readonly artifact_id: unknown; readonly revision: unknown }
      /** `sections.citations[]` 的片段序号（只认 `kind='SEGMENT'`）。 */
      readonly citation_sequences: readonly number[]
    }
  | {
      readonly ok: false
      readonly code: 'BLOCKED_BY_REVIEW'
      readonly reason_code: 'SECTIONS_INVALID' | 'SECTIONS_NO_CITATIONS'
      readonly message: string
      readonly detail: Record<string, unknown>
    }

/**
 * 解析 `interview_record.sections` 的证据索引（纯函数）。
 *
 * 只做结构判定；"引用的片段真的存在吗"由调用方查库后用
 * {@link evaluateRecordVerification} 判定（纯函数也便于单测）。
 * @param sections - jsonb 列（pg 给对象；兼容字符串）。
 * @returns 解析结果或结构化拒绝。
 */
export function parseSectionsEvidence(sections: unknown): SectionsEvidence {
  let parsed: unknown = sections
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return {
        ok: false,
        code: 'BLOCKED_BY_REVIEW',
        reason_code: 'SECTIONS_INVALID',
        message: 'interview_record.sections 不是可解析的 JSON 对象，无法核对证据索引（本次没有写任何行）',
        detail: { sections_type: 'string' },
      }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'SECTIONS_INVALID',
      message: 'interview_record.sections 不是 JSON 对象，无法核对证据索引（本次没有写任何行）',
      detail: { sections_type: typeof parsed },
    }
  }
  const record = parsed as Record<string, unknown>
  const basis = record.basis
  if (typeof basis !== 'object' || basis === null || Array.isArray(basis)) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'SECTIONS_INVALID',
      message: 'sections.basis 缺失：记录没有自述它依据哪一版转写，证据链不可核验（本次没有写任何行）',
      detail: { sections_keys: Object.keys(record).sort() },
    }
  }
  const basisRecord = basis as Record<string, unknown>
  const citations = record.citations
  if (!Array.isArray(citations) || citations.length === 0) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'SECTIONS_NO_CITATIONS',
      message: 'sections.citations 为空：没有一条证据指回转写片段，这样的记录不能作为决策依据（本次没有写任何行）',
      detail: { citation_count: Array.isArray(citations) ? citations.length : 0 },
    }
  }
  const sequences: number[] = []
  for (const [index, citation] of citations.entries()) {
    if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) {
      return {
        ok: false,
        code: 'BLOCKED_BY_REVIEW',
        reason_code: 'SECTIONS_INVALID',
        message: 'sections.citations 的元素不是对象（本次没有写任何行）',
        detail: { citation_index: index },
      }
    }
    const entry = citation as Record<string, unknown>
    if (entry.kind !== 'SEGMENT') {
      return {
        ok: false,
        code: 'BLOCKED_BY_REVIEW',
        reason_code: 'SECTIONS_INVALID',
        message: 'sections.citations 只接受 kind=SEGMENT 的片段引用（本次没有写任何行）',
        detail: { citation_index: index, kind: typeof entry.kind === 'string' ? entry.kind : '' },
      }
    }
    const sequence = entry.sequence
    if (typeof sequence !== 'number' || !Number.isInteger(sequence) || sequence < 0) {
      return {
        ok: false,
        code: 'BLOCKED_BY_REVIEW',
        reason_code: 'SECTIONS_INVALID',
        message: 'sections.citations[].sequence 必须是非负整数（本次没有写任何行）',
        detail: { citation_index: index },
      }
    }
    if (!sequences.includes(sequence)) sequences.push(sequence)
  }
  return {
    ok: true,
    basis: { artifact_id: basisRecord.artifact_id, revision: basisRecord.revision },
    citation_sequences: sequences,
  }
}

/** 前置校验的输入（全部来自库，纯数据，便于单测）。 */
export interface VerificationFacts {
  readonly record: {
    readonly id: string
    readonly interview_id: string
    readonly transcript_artifact_id: string
    readonly transcript_revision: number
    readonly rubric_version_id: string
    readonly evidence_ok: boolean
    readonly sections: unknown
  }
  /** 命中的 artifact（同租户 + 同 revision）；缺失 = null。 */
  readonly artifact: {
    readonly id: string
    readonly meeting_id: string
    readonly source_revision: number
    readonly transcript_status: string
    readonly is_complete: boolean
    readonly has_more: boolean
    readonly char_count: number
    readonly segment_count: number
  } | null
  /** 申请当前钉住的 rubric 版本（可为空 = 没钉）。 */
  readonly application_rubric_version_id: string | null
  /** 该 artifact 所属会议是否绑过这场面试（`meeting_binding` 任一历史记录）。 */
  readonly artifact_bound_to_interview: boolean
  /** `sections.citations` 里那些**查不到**的片段序号（由调用方查库算出）。 */
  readonly missing_citation_sequences: readonly number[]
}

/** 前置校验的拒绝结论（带结构化理由）。 */
export interface VerificationRefusal {
  readonly ok: false
  readonly code: 'BLOCKED_BY_REVIEW' | 'NOT_FOUND'
  readonly reason_code: string
  readonly message: string
  readonly detail: Record<string, unknown>
}

/**
 * 前置校验（纯函数）：只有**证据链完整**时才允许核验。
 *
 * 逐条对应文件头的规则 2；顺序从"最外层事实"到"最细证据"，拒绝时 detail 写清是哪一环。
 * 不合法 → 返回 `VerificationRefusal`，调用方抛错，**零写入**。
 * @param facts - 库读回的事实（见 {@link VerificationFacts}）。
 * @returns `{ok:true}` 或结构化拒绝。
 */
export function evaluateRecordVerification(facts: VerificationFacts): { ok: true } | VerificationRefusal {
  const { record, artifact } = facts
  if (artifact === null) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      reason_code: 'TRANSCRIPT_ARTIFACT_NOT_FOUND',
      message: '记录引用的转写产物（artifact + revision）在本租户下不存在：'
        + '证据链的起点缺失，不能核验（本次没有写任何行）',
      detail: {
        interview_record_id: record.id,
        transcript_artifact_id: record.transcript_artifact_id,
        transcript_revision: record.transcript_revision,
      },
    }
  }
  if (artifact.source_revision !== record.transcript_revision) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'ARTIFACT_REVISION_MISMATCH',
      message: '命中的 artifact 修订号与记录引用的修订号不一致：证据链自相矛盾（本次没有写任何行）',
      detail: { record_revision: record.transcript_revision, artifact_revision: artifact.source_revision },
    }
  }
  if (artifact.transcript_status !== 'READY') {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_NOT_READY',
      message: `转写产物还不是 READY（transcript_status=${artifact.transcript_status}）：`
        + '结构化记录的依据还不成立，不能核验（本次没有写任何行）',
      detail: { transcript_artifact_id: artifact.id, transcript_status: artifact.transcript_status },
    }
  }
  if (artifact.is_complete !== true) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_INCOMPLETE',
      message: '转写产物 is_complete=false：原文未取齐，核验不能成立（本次没有写任何行）',
      detail: { transcript_artifact_id: artifact.id },
    }
  }
  if (artifact.has_more === true) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_HAS_MORE',
      message: '转写产物 has_more=true（还有分页未取）：按 TR-C9 应先用新 revision 取完整，'
        + '不能核验这份未取完的产物（本次没有写任何行）',
      detail: { transcript_artifact_id: artifact.id },
    }
  }
  if (artifact.char_count <= 0) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_EMPTY',
      message: '转写产物原文为空：空内容不能作为结构化记录的依据（P-2；本次没有写任何行）',
      detail: { transcript_artifact_id: artifact.id, char_count: artifact.char_count },
    }
  }
  if (artifact.segment_count <= 0) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_NO_SEGMENTS',
      message: '转写产物没有任何片段（segment_count=0）：记录不可能有可核的证据（本次没有写任何行）',
      detail: { transcript_artifact_id: artifact.id, segment_count: artifact.segment_count },
    }
  }
  if (facts.artifact_bound_to_interview !== true) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'TRANSCRIPT_NOT_BOUND',
      message: '该转写产物所属会议没有绑过这场面试（meeting_binding 无记录）：'
        + '来源与对象对不上，不能核验（本次没有写任何行）',
      detail: {
        transcript_artifact_id: artifact.id,
        meeting_id: artifact.meeting_id,
        interview_id: record.interview_id,
      },
    }
  }
  if (record.evidence_ok !== true) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'EVIDENCE_OK_FALSE',
      message: '记录自己的 evidence_ok=false：写入方当时就没能证明证据可用，人不能替它补这个结论（本次没有写任何行）',
      detail: { interview_record_id: record.id },
    }
  }
  const sections = parseSectionsEvidence(record.sections)
  if (sections.ok === false) return sections
  if (sections.basis.artifact_id !== record.transcript_artifact_id) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'SECTIONS_BASIS_MISMATCH',
      message: 'sections.basis.artifact_id 与记录引用的 artifact 不一致：证据索引指错了产物（本次没有写任何行）',
      detail: {
        basis_artifact_id: typeof sections.basis.artifact_id === 'string' ? sections.basis.artifact_id : '',
        transcript_artifact_id: record.transcript_artifact_id,
      },
    }
  }
  if (sections.basis.revision !== record.transcript_revision) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'SECTIONS_BASIS_MISMATCH',
      message: 'sections.basis.revision 与记录引用的修订号不一致：证据索引指错了版本（本次没有写任何行）',
      detail: { basis_revision: sections.basis.revision, transcript_revision: record.transcript_revision },
    }
  }
  if (facts.missing_citation_sequences.length > 0) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'CITATION_SEGMENT_MISSING',
      message: 'sections.citations 引用了 0 条以上不存在的转写片段：证据链断了，不能核验（本次没有写任何行）',
      detail: {
        transcript_artifact_id: artifact.id,
        missing_sequences: [...facts.missing_citation_sequences],
        missing_count: facts.missing_citation_sequences.length,
      },
    }
  }
  if (facts.application_rubric_version_id !== record.rubric_version_id) {
    return {
      ok: false,
      code: 'BLOCKED_BY_REVIEW',
      reason_code: 'RECORD_RUBRIC_STALE',
      message: '记录钉的 rubric 版本不是申请当前钉住的那一版：核过它会把旧标准下的证据带进决策'
        + '（与 SC-11 同一精神）；本次没有写任何行',
      detail: {
        interview_record_id: record.id,
        record_rubric_version_id: record.rubric_version_id,
        application_rubric_version_id: facts.application_rubric_version_id === null
          ? ''
          : facts.application_rubric_version_id,
        application_rubric_pinned: facts.application_rubric_version_id !== null,
      },
    }
  }
  return { ok: true }
}

/** 把拒绝结论变成契约错误（`Error: <CODE>: <compact-json>`）。 */
export function refusalError(refusal: VerificationRefusal): RecruitmentToolError {
  return contractError(refusal.code, {
    reason_code: refusal.reason_code,
    message: refusal.message,
    detail: refusal.detail,
  })
}

// ---------------------------------------------------------------------------
//  输出 schema（只用 DSH 子集；可缺的键省略，不写 null）
// ---------------------------------------------------------------------------

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [INTERVIEW_RECORD_VERIFY_TOOL] },
    contract_version: { type: 'string' },
    labels: {
      type: 'object',
      properties: {
        provenance: { type: 'string', enum: ['LIVE', 'FIXTURE'] },
        trigger: { type: 'string', enum: ['MANUAL'] },
        connection: { type: 'string', enum: ['NOT_CONNECTED'] },
      },
      required: ['provenance', 'trigger', 'connection'],
      additionalProperties: false,
    },
    outcome: { type: 'string', enum: ['VERIFIED', 'NO_OP'] },
    replayed: { type: 'boolean' },
    gate: {
      type: 'object',
      properties: {
        requested: { type: 'boolean' },
        result: { type: 'string', enum: ['allowed-once', 'not-required'] },
      },
      required: ['requested', 'result'],
      additionalProperties: false,
    },
    record: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        interview_id: { type: 'string' },
        application_id: { type: 'string' },
        status: { type: 'string', enum: [VERIFIED_TO.status] },
        verification_status: { type: 'string', enum: [VERIFIED_TO.verification_status] },
        record_version: { type: 'integer' },
        is_current: { type: 'boolean', enum: [true] },
        evidence_ok: { type: 'boolean' },
        transcript_revision: { type: 'integer' },
        previous_status: { type: 'string' },
        previous_verification_status: { type: 'string' },
        verified_at: { type: 'string' },
        verified_by_actor_id: { type: 'string' },
        verified_by_actor_kind: { type: 'string' },
      },
      required: [
        'id', 'interview_id', 'application_id', 'status', 'verification_status',
        'record_version', 'is_current', 'evidence_ok', 'transcript_revision',
        'previous_status', 'previous_verification_status',
      ],
      additionalProperties: false,
    },
    artifact: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        source_revision: { type: 'integer' },
        transcript_status: { type: 'string', enum: ['READY'] },
        segment_count: { type: 'integer' },
        is_complete: { type: 'boolean' },
        has_more: { type: 'boolean' },
        content_sha256: { type: 'string' },
      },
      required: ['id', 'source_revision', 'transcript_status', 'segment_count', 'is_complete', 'has_more'],
      additionalProperties: false,
    },
    changes: {
      type: 'object',
      properties: {
        written: { type: 'boolean' },
        tables: { type: 'array', items: { type: 'string' } },
        event_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['written', 'tables', 'event_ids'],
      additionalProperties: false,
    },
    next_action: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['READ_BACK'] },
        interview_record_id: { type: 'string' },
        verify_with: { type: 'string', enum: ['recruitment_transcript_read'] },
      },
      required: ['kind', 'interview_record_id', 'verify_with'],
      additionalProperties: false,
    },
  },
  required: [
    'tool', 'contract_version', 'labels', 'outcome', 'replayed', 'gate',
    'record', 'changes', 'next_action',
  ],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------
//  出参值
// ---------------------------------------------------------------------------

/** 一次核验的结果。 */
export interface InterviewRecordVerifyValue {
  readonly tool: typeof INTERVIEW_RECORD_VERIFY_TOOL
  readonly contract_version: string
  readonly labels: ThreeAxisLabels
  readonly outcome: 'VERIFIED' | 'NO_OP'
  readonly replayed: boolean
  readonly gate: { readonly requested: boolean; readonly result: 'allowed-once' | 'not-required' }
  readonly record: {
    readonly id: string
    readonly interview_id: string
    readonly application_id: string
    readonly status: typeof VERIFIED_TO.status
    readonly verification_status: typeof VERIFIED_TO.verification_status
    readonly record_version: number
    readonly is_current: true
    readonly evidence_ok: boolean
    readonly transcript_revision: number
    readonly previous_status: string
    readonly previous_verification_status: string
    readonly verified_at?: string
    readonly verified_by_actor_id?: string
    readonly verified_by_actor_kind?: string
  }
  readonly artifact?: {
    readonly id: string
    readonly source_revision: number
    readonly transcript_status: 'READY'
    readonly segment_count: number
    readonly is_complete: boolean
    readonly has_more: boolean
    readonly content_sha256?: string
  }
  readonly changes: {
    readonly written: boolean
    readonly tables: readonly string[]
    readonly event_ids: readonly string[]
  }
  readonly next_action: {
    readonly kind: 'READ_BACK'
    readonly interview_record_id: string
    readonly verify_with: 'recruitment_transcript_read'
  }
}

// ---------------------------------------------------------------------------
//  数据库行形状
// ---------------------------------------------------------------------------

interface ActorRow {
  readonly kind: string
}

/** 记录 + 面试 + 申请的关键列（全部同租户）。 */
interface RecordRow {
  readonly id: string
  readonly interview_id: string
  readonly application_id: string
  readonly transcript_artifact_id: string
  readonly transcript_revision: number
  readonly rubric_version_id: string
  readonly status: string
  readonly verification_status: string
  readonly evidence_ok: boolean
  readonly is_current: boolean
  readonly record_version: number
  readonly sections: unknown
  readonly status_changed_at: string | Date | null
  readonly status_changed_by_actor_id: string | null
  readonly application_rubric_version_id: string | null
  readonly verified_by_actor_kind: string | null
}

interface ArtifactRow {
  readonly id: string
  readonly meeting_id: string
  readonly source_revision: number
  readonly transcript_status: string
  readonly is_complete: boolean
  readonly has_more: boolean
  readonly content_sha256: string | null
  readonly char_count: string | number
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------

/** `timestamptz` / Date → ISO-8601（缺省 undefined，输出里省略键）。 */
function iso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

/** 只在值存在时写键（缺省靠省略键，不用 null 占位）。 */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value
}

/** pg 的 int8 以字符串返回；计数统一转数字。 */
function toCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0
  return typeof value === 'number' ? value : Number(value)
}

/** 从执行上下文里取 `agent` / `signal`（DSH 的 `exec` 是 unknown）。 */
function readExecContext(exec: unknown): { agent?: unknown; signal?: AbortSignal } | undefined {
  if (typeof exec !== 'object' || exec === null || Array.isArray(exec)) return undefined
  const record = exec as { agent?: unknown; signal?: unknown }
  return {
    ...(record.agent === undefined ? {} : { agent: record.agent }),
    ...(record.signal instanceof AbortSignal ? { signal: record.signal } : {}),
  }
}

// ---------------------------------------------------------------------------
//  事务核心
// ---------------------------------------------------------------------------

/**
 * 在**调用方给的事务**里核验一条面试记录（单独导出：集成测试在必回滚事务里直调）。
 *
 * 顺序（全部业务校验 → 人机闸门 → 第一行写入）：
 *   1. 入参形状（纯函数，最早就拒，不连库）；
 *   2. 决定者必须是本租户的 **HUMAN**（D-79：Agent/SYSTEM 不能替人核验）；
 *   3. 锁住记录行（`for update`），状态分类：
 *      已是 READY/VERIFIED → `NO_OP`（不问人、零写入）；其它非法源态 → 拒绝；
 *   4. 读回 artifact + 片段数 + 片段存在性 + 会议绑定 + 申请钉住的 rubric；
 *   5. 前置校验（{@link evaluateRecordVerification}）不过 → 抛结构化错误，零写入；
 *   6. 闸门：`allowed-once` 才继续（120s 超时 / 缺通道 / 拒绝 → 抛错，零写入）；
 *   7. 一次 UPDATE 把两条状态轴推到 READY/VERIFIED（触发器补审计列与事件）；
 *   8. 写工具事件 `interview.record.verified`（幂等键每次唯一；NO_OP 不到这里）。
 * @param client - 事务内客户端（`withActor` 已 `SET LOCAL recruitment.actor_id`）。
 * @param cfg - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param rawArgs - 模型给的 arguments（本函数自己再校验一次，保证测试直调也安全）。
 * @param approve - 人机闸门；**缺省 = `unavailable` = 一律拒绝**（fail closed）。
 * @returns 契约出参。
 */
export async function verifyInterviewRecordInTransaction(
  client: DatabaseClient,
  cfg: ResolvedDatabaseConfig,
  rawArgs: unknown,
  approve?: () => Promise<ApprovalDecision>,
): Promise<InterviewRecordVerifyValue> {
  const args = parseVerifyArgs(rawArgs)
  const tenantId = cfg.tenant_id

  try {
    // 1. 决定者必须是本租户的 HUMAN（先于弹窗，注定失败的调用不打扰人）。
    const actorResult = await client.query<ActorRow>(
      'select kind from recruitment.actor where id = $1 and tenant_id = $2',
      [cfg.actor_id, tenantId],
    )
    const actor = actorResult.rows[0]
    if (actor === undefined) {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_IN_TENANT',
        message: `actor ${cfg.actor_id} 不存在或不属于租户 ${tenantId}`,
        detail: { actor_id: cfg.actor_id, tenant_id: tenantId },
      })
    }
    if (actor.kind !== 'HUMAN') {
      throw contractError('FORBIDDEN', {
        reason_code: 'ACTOR_NOT_HUMAN',
        message: `actor ${cfg.actor_id} 的 kind 是 ${actor.kind}，面试记录核验只允许 HUMAN`,
        detail: { actor_id: cfg.actor_id, kind: actor.kind },
      })
    }

    // 2. 锁住记录行（并发核验/并发写入必须串行；锁住后才能安全判状态）。
    const recordResult = await client.query<RecordRow>(
      `select r.id, r.interview_id, r.transcript_artifact_id, r.transcript_revision, r.rubric_version_id,
              r.status, r.verification_status, r.evidence_ok, r.is_current, r.record_version,
              r.sections, r.status_changed_at, r.status_changed_by_actor_id,
              i.application_id,
              a.rubric_version_id as application_rubric_version_id,
              sa.kind as verified_by_actor_kind
         from recruitment.interview_record r
         join recruitment.interview i
           on i.id = r.interview_id and i.tenant_id = r.tenant_id
         join recruitment.application a
           on a.id = i.application_id and a.tenant_id = i.tenant_id
         left join recruitment.actor sa
           on sa.id = r.status_changed_by_actor_id and sa.tenant_id = r.tenant_id
        where r.tenant_id = $1 and r.id = $2
        for update of r`,
      [tenantId, args.interview_record_id],
    )
    const record = recordResult.rows[0]
    if (record === undefined) {
      throw contractError('NOT_FOUND', {
        reason_code: 'INTERVIEW_RECORD_NOT_FOUND',
        message: `该租户下没有面试记录 ${args.interview_record_id}`,
        detail: { interview_record_id: args.interview_record_id },
      })
    }

    // 3. 状态分类：幂等 / 可核验 / 拒绝（状态机以库为准）。
    const state = classifyRecordState({
      id: record.id,
      status: record.status,
      verification_status: record.verification_status,
      is_current: record.is_current,
    })
    if (state.kind === 'REFUSED') {
      throw contractError(state.code, {
        reason_code: state.reason_code,
        message: state.message,
        detail: state.detail,
      })
    }

    // 与本次输出无关但两条路径都要回显的 artifact / 片段事实。
    const artifactResult = await client.query<ArtifactRow>(
      `select id, meeting_id, source_revision, transcript_status, is_complete, has_more,
              content_sha256, coalesce(length(raw_text), 0) as char_count
         from recruitment.transcript_artifact
        where tenant_id = $1 and id = $2 and source_revision = $3`,
      [tenantId, record.transcript_artifact_id, record.transcript_revision],
    )
    const artifactRow = artifactResult.rows[0]
    let segmentCount = 0
    let bound = false
    let missingCitations: number[] = []
    if (artifactRow !== undefined) {
      const segmentResult = await client.query<{ segment_count: number | string }>(
        'select count(*)::int as segment_count from recruitment.transcript_segment where tenant_id = $1 and artifact_id = $2',
        [tenantId, artifactRow.id],
      )
      segmentCount = toCount(segmentResult.rows[0]?.segment_count)
      const bindingResult = await client.query<{ bound: boolean }>(
        `select exists(
           select 1 from recruitment.meeting_binding
            where tenant_id = $1 and meeting_id = $2 and interview_id = $3
         ) as bound`,
        [tenantId, artifactRow.meeting_id, record.interview_id],
      )
      bound = bindingResult.rows[0]?.bound === true
      const sections = parseSectionsEvidence(record.sections)
      if (sections.ok) {
        const present = await client.query<{ sequence: number }>(
          `select sequence from recruitment.transcript_segment
            where tenant_id = $1 and artifact_id = $2 and sequence = any($3::int[])`,
          [tenantId, artifactRow.id, [...sections.citation_sequences]],
        )
        const found = new Set(present.rows.map((row) => row.sequence))
        missingCitations = sections.citation_sequences.filter((sequence) => !found.has(sequence))
      }
    }

    const labels = await buildThreeAxisLabels(client, tenantId)

    // 4a. 幂等：已是 READY/VERIFIED → NO_OP（不问人、零写入、不发第二事件）。
    if (state.kind === 'IDEMPOTENT') {
      return buildVerifiedValue({
        labels,
        outcome: 'NO_OP',
        record,
        recordVersion: record.record_version,
        recordStatus: VERIFIED_TO.status,
        recordVerification: VERIFIED_TO.verification_status,
        previousStatus: record.status,
        previousVerification: record.verification_status,
        verifiedAt: iso(record.status_changed_at),
        verifiedBy: record.status_changed_by_actor_id ?? undefined,
        verifiedByKind: record.verified_by_actor_kind ?? undefined,
        artifact: artifactRow === undefined ? undefined : { row: artifactRow, segmentCount },
        evidenceOk: record.evidence_ok,
        gate: { requested: false, result: 'not-required' },
        changes: { written: false, tables: [], event_ids: [] },
      })
    }

    // 4b. 前置校验：证据链任一环不成立 → 结构化拒绝，零写入。
    const refusal = evaluateRecordVerification({
      record: {
        id: record.id,
        interview_id: record.interview_id,
        transcript_artifact_id: record.transcript_artifact_id,
        transcript_revision: record.transcript_revision,
        rubric_version_id: record.rubric_version_id,
        evidence_ok: record.evidence_ok,
        sections: record.sections,
      },
      artifact: artifactRow === undefined
        ? null
        : {
            id: artifactRow.id,
            meeting_id: artifactRow.meeting_id,
            source_revision: artifactRow.source_revision,
            transcript_status: artifactRow.transcript_status,
            is_complete: artifactRow.is_complete,
            has_more: artifactRow.has_more,
            char_count: toCount(artifactRow.char_count),
            segment_count: segmentCount,
          },
      application_rubric_version_id: record.application_rubric_version_id,
      artifact_bound_to_interview: bound,
      missing_citation_sequences: missingCitations,
    })
    if (refusal.ok === false) throw refusalError(refusal)
    // 走到这里前置校验已通过（artifact 必存在）；仍显式判空，不做不安全断言。
    if (artifactRow === undefined) {
      throw new RecruitmentToolError('READER_FAILED', 'artifact vanished between evidence checks')
    }

    // 5. D-79 人机闸门：业务校验全部通过，但仍在第一行写入之前。
    const gateOutcome: ApprovalDecision = approve === undefined ? 'unavailable' : await approve()
    requireVerifyApprovalGranted(gateOutcome)

    // 6. 一次 UPDATE 推两条状态轴（CHECK 只在最终行上判：READY 必须配 VERIFIED）。
    const updated = await client.query<{
      record_version: number
      status_changed_at: Date
      status_source_event_id: string
    }>(
      `update recruitment.interview_record
          set status = $3,
              verification_status = $4
        where tenant_id = $1
          and id = $2
          and is_current
          and status = $5
          and verification_status = $6
        returning record_version, status_changed_at, status_source_event_id`,
      [
        tenantId,
        record.id,
        VERIFIED_TO.status,
        VERIFIED_TO.verification_status,
        VERIFIABLE_FROM.status,
        VERIFIABLE_FROM.verification_status,
      ],
    )
    const updatedRow = updated.rows[0]
    if (updatedRow === undefined) {
      // 行已在本事务里被 for update 锁住，理论上不可能；仍显式失败，不猜一个状态。
      throw contractError('INVALID_ARGS', {
        reason_code: 'RECORD_CHANGED',
        message: '记录在核验过程中被并发改动，本次没有写成任何状态（请重读后再核验）',
        detail: { interview_record_id: record.id },
      })
    }

    // 7. 审计事件（只在真的发生状态迁移时）。
    const verifiedAt = iso(updatedRow.status_changed_at) ?? new Date().toISOString()
    const eventId = await insertRecordVerifiedEvent(client, {
      tenantId,
      applicationId: record.application_id,
      record,
      artifact: artifactRow,
      segmentCount,
      verifiedBy: cfg.actor_id,
      verifiedAt,
      sourceStatusEventId: updatedRow.status_source_event_id,
      reason: args.reason,
    })

    return buildVerifiedValue({
      labels,
      outcome: 'VERIFIED',
      record,
      recordVersion: updatedRow.record_version,
      recordStatus: VERIFIED_TO.status,
      recordVerification: VERIFIED_TO.verification_status,
      previousStatus: record.status,
      previousVerification: record.verification_status,
      verifiedAt,
      verifiedBy: cfg.actor_id,
      verifiedByKind: 'HUMAN',
      artifact: { row: artifactRow, segmentCount },
      evidenceOk: true,
      gate: { requested: true, result: 'allowed-once' },
      changes: { written: true, tables: ['interview_record', 'event_inbox'], event_ids: [eventId] },
    })
  } catch (error) {
    // 只映射当前错误，不在 catch 里补查询（25P02：事务已被终止）。
    throw mapDatabaseError(error)
  }
}

/**
 * 写一条内部审计事件（`event_inbox`）。**只在真的发生状态迁移时调用**：
 * `NO_OP` 分支在它之前返回，因此重复核验不会产生第二条事件。
 *
 * 幂等键每次唯一：`record-verify:<uuid>`（内部事实，去重靠 `NO_OP` 分支，而不是事件键）。
 * 事件类型必须已在 `src/runtime/event-types.ts` 登记（未登记会落到语义 Gate）。
 * @param client - 事务内客户端。
 * @param input - 事件字段。
 * @returns 新事件 id。
 */
async function insertRecordVerifiedEvent(
  client: DatabaseClient,
  input: {
    readonly tenantId: string
    readonly applicationId: string
    readonly record: RecordRow
    readonly artifact: ArtifactRow
    readonly segmentCount: number
    readonly verifiedBy: string
    readonly verifiedAt: string
    readonly sourceStatusEventId: string
    readonly reason: string | undefined
  },
): Promise<string> {
  const payload = {
    interview_record_id: input.record.id,
    interview_id: input.record.interview_id,
    application_id: input.applicationId,
    transcript_artifact_id: input.record.transcript_artifact_id,
    transcript_revision: input.record.transcript_revision,
    rubric_version_id: input.record.rubric_version_id,
    status_from: input.record.status,
    status_to: VERIFIED_TO.status,
    verification_from: input.record.verification_status,
    verification_to: VERIFIED_TO.verification_status,
    verified_by_actor_id: input.verifiedBy,
    verified_at: input.verifiedAt,
    segment_count: input.segmentCount,
    // 状态迁移由 fn_row_guard 审计；这里指向它写的那条事件，便于两条证据串起来。
    status_source_event_id: input.sourceStatusEventId,
    gate: { requested: true, result: 'allowed-once' },
    source: INTERVIEW_RECORD_VERIFY_TOOL,
    ...(input.artifact.content_sha256 === null ? {} : { artifact_content_sha256: input.artifact.content_sha256 }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  }
  const { rows } = await client.query<{ event_id: string }>(
    `insert into recruitment.event_inbox
       (tenant_id, provider, provider_event_id, event_type, schema_version,
        occurred_at, received_at, recorded_at, correlation_id, causation_id,
        idempotency_key, idempotency_source, source_object_id,
        payload_ref, payload, trust_level, normalized_event_type, normalizer_version)
     values ($1, 'internal', null, '${EVENT_TYPES.INTERVIEW_RECORD_VERIFIED}', 1,
             now(), now(), now(), null, null,
             $2, 'FALLBACK_KEY', $3,
             null, $4::jsonb, 'INTERNAL', '${EVENT_TYPES.INTERVIEW_RECORD_VERIFIED}', 'schema/0001')
     returning event_id`,
    [
      input.tenantId,
      `record-verify:${randomUUID()}`,
      input.record.id,
      JSON.stringify(payload),
    ],
  )
  const row = rows[0]
  if (row === undefined) {
    throw new RecruitmentToolError('READER_FAILED', 'event_inbox insert returned no row')
  }
  return row.event_id
}

/** 装配出参（两条 outcome 同形；可缺的键直接省略，不写 null）。 */
function buildVerifiedValue(input: {
  readonly labels: ThreeAxisLabels
  readonly outcome: 'VERIFIED' | 'NO_OP'
  readonly record: RecordRow
  readonly recordVersion: number
  readonly recordStatus: typeof VERIFIED_TO.status
  readonly recordVerification: typeof VERIFIED_TO.verification_status
  readonly previousStatus: string
  readonly previousVerification: string
  readonly verifiedAt: string | undefined
  readonly verifiedBy: string | undefined
  readonly verifiedByKind: string | undefined
  readonly artifact: { readonly row: ArtifactRow; readonly segmentCount: number } | undefined
  /** 该行真实的 `evidence_ok`（NO_OP 时如实回显，不替它断言）。 */
  readonly evidenceOk: boolean
  readonly gate: InterviewRecordVerifyValue['gate']
  readonly changes: InterviewRecordVerifyValue['changes']
}): InterviewRecordVerifyValue {
  const record: Record<string, unknown> = {
    id: input.record.id,
    interview_id: input.record.interview_id,
    application_id: input.record.application_id,
    status: input.recordStatus,
    verification_status: input.recordVerification,
    record_version: input.recordVersion,
    is_current: true,
    evidence_ok: input.evidenceOk,
    transcript_revision: input.record.transcript_revision,
    previous_status: input.previousStatus,
    previous_verification_status: input.previousVerification,
  }
  put(record, 'verified_at', input.verifiedAt)
  put(record, 'verified_by_actor_id', input.verifiedBy)
  put(record, 'verified_by_actor_kind', input.verifiedByKind)
  const value: InterviewRecordVerifyValue = {
    tool: INTERVIEW_RECORD_VERIFY_TOOL,
    contract_version: CONTRACT_VERSION,
    labels: input.labels,
    outcome: input.outcome,
    replayed: input.outcome === 'NO_OP',
    gate: input.gate,
    record: record as unknown as InterviewRecordVerifyValue['record'],
    changes: input.changes,
    next_action: {
      kind: 'READ_BACK',
      interview_record_id: input.record.id,
      verify_with: 'recruitment_transcript_read',
    },
  }
  if (input.artifact === undefined) return value
  const artifact: Record<string, unknown> = {
    id: input.artifact.row.id,
    source_revision: input.artifact.row.source_revision,
    transcript_status: input.artifact.row.transcript_status,
    segment_count: input.artifact.segmentCount,
    is_complete: input.artifact.row.is_complete,
    has_more: input.artifact.row.has_more,
  }
  put(artifact, 'content_sha256', input.artifact.row.content_sha256 ?? undefined)
  return { ...value, artifact: artifact as unknown as InterviewRecordVerifyValue['artifact'] }
}

// ---------------------------------------------------------------------------
//  模型可见说明
// ---------------------------------------------------------------------------

const DESCRIPTION = [
  'Verify ONE current interview record as a HUMAN action and move it from '
    + 'NEEDS_REVIEW/UNVERIFIED to READY/VERIFIED (the D-B gap: before this tool no product entry '
    + 'could ever write verification_status=VERIFIED, so evaluation_summarize always answered '
    + 'record.state=NOT_READY + warning RECORD_NOT_READY and a decision could NOT cite '
    + 'INTERVIEW_RECORD as basis per DC-23).',
  '',
  'D-79 HUMAN GATE (why an agent cannot verify by itself)',
  '- Before ANY write the tool asks the host for human approval (ctx.approval). Only an explicit '
    + 'human "allowed-once" continues; rejected / cancelled / unavailable / 120s timeout => '
    + 'FORBIDDEN(APPROVAL_UNAVAILABLE|APPROVAL_NOT_GRANTED) and NOTHING is written.',
  '- The deciding actor must be a HUMAN actor of this tenant (ACTOR_NOT_HUMAN otherwise).',
  '- Call this tool only when the user explicitly asks to verify this interview record. Never '
    + 'describe a record as READY/VERIFIED before this tool returns outcome=VERIFIED / NO_OP.',
  '',
  'PRECONDITIONS (all checked BEFORE the human gate; failure => structured refusal + nothing written)',
  '- The record must be the CURRENT row (is_current=true); superseded rows are never verifiable.',
  '- The record must be in the only legal source state NEEDS_REVIEW/UNVERIFIED. Any other state '
    + '(PENDING/PROCESSING/PARTIAL/FAILED, or READY+UNVERIFIED dirty rows) => INVALID_ARGS(STATUS_NOT_VERIFIABLE).',
  '- The referenced transcript artifact revision must exist in this tenant, have '
    + 'transcript_status=READY, is_complete=true, has_more=false, non-empty raw text and '
    + 'segment_count > 0; its meeting must have been bound to this interview.',
  '- The record evidence index (sections.basis + sections.citations) must point at this exact '
    + 'artifact revision and every cited SEGMENT sequence must exist in transcript_segment.',
  '- The record rubric_version_id must still equal application.rubric_version_id (a stale rubric '
    + 'would smuggle evidence produced under another standard into a decision, same spirit as SC-11).',
  '',
  'IDEMPOTENCY',
  '- Already READY/VERIFIED => outcome=NO_OP, replayed=true, the human is NOT asked and NOTHING is '
    + 'written (no second audit event, record_version unchanged).',
  '- This call performed the transition => outcome=VERIFIED, replayed=false; exactly one audit '
    + 'event interview.record.verified is written, and the database trigger fn_row_guard also audits '
    + 'the status transition (interview_record.status.changed, status_source_event_id).',
  '',
  'INPUTS',
  '- interview_record_id: UUID of the record (record.id from recruitment_transcript_import / '
    + 'recruitment_transcript_read).',
  '- reason: optional human note (1..500 characters) recorded on the audit event only.',
  '- tenant_id / actor_id are never accepted from the model: identity comes from the execution context.',
  '',
  'FAILURES (closed set)',
  '- INVALID_ARGS: bad arguments, RECORD_NOT_CURRENT, STATUS_NOT_VERIFIABLE, RECORD_CHANGED.',
  '- NOT_FOUND: INTERVIEW_RECORD_NOT_FOUND, TRANSCRIPT_ARTIFACT_NOT_FOUND.',
  '- BLOCKED_BY_REVIEW: TRANSCRIPT_NOT_READY / TRANSCRIPT_INCOMPLETE / TRANSCRIPT_HAS_MORE / '
    + 'TRANSCRIPT_EMPTY / TRANSCRIPT_NO_SEGMENTS / TRANSCRIPT_NOT_BOUND / ARTIFACT_REVISION_MISMATCH / '
    + 'EVIDENCE_OK_FALSE / SECTIONS_INVALID / SECTIONS_NO_CITATIONS / SECTIONS_BASIS_MISMATCH / '
    + 'CITATION_SEGMENT_MISSING / RECORD_RUBRIC_STALE.',
  '- FORBIDDEN: ACTOR_NOT_IN_TENANT, ACTOR_NOT_HUMAN, APPROVAL_UNAVAILABLE, APPROVAL_NOT_GRANTED.',
  '',
  'Verify the result with recruitment_transcript_read (record.status / verification_status) or '
    + 'recruitment_evaluation_summarize (record.state=READY, no RECORD_NOT_READY warning).',
].join('\n')

/**
 * 造真实的面试记录核验工具（写路径；`isConcurrencySafe=false`）。
 * @param database - 已解析的库配置（tenant/actor 只从这里来，模型无法传入）。
 * @param deps - 可选依赖；`approval` 缺省时写库一律被拒（D-79 fail closed）；
 *   `identity` 由 `src/index.ts` 装配（产品路径），缺省 = 仅测试兼容的 legacy actor。
 */
export function createInterviewRecordVerifyTool(
  database: ResolvedDatabaseConfig,
  deps: InterviewRecordVerifyDeps = {},
): ReadonlyToolDefinition {
  return {
    name: INTERVIEW_RECORD_VERIFY_TOOL,
    description: DESCRIPTION,
    parameters: toParameterSchema(PARAMS),
    output: { schema: OUTPUT_SCHEMA, render: renderVerifyValue },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(rawArgs: unknown, exec: unknown): Promise<unknown> {
      // 写身份先于建连解析：identity 已装配时缺失映射在此 fail-closed（零写入）。
      const writeActor = resolveWriteActor(exec, deps.identity, database.actor_id)
      // 核验人（`verified_by_actor_id`）与 GUC 共用同一作者（Demo Actor 解析结果）。
      const writeConfig: ResolvedDatabaseConfig = { ...database, actor_id: writeActor.actor_id }
      // 参数级失败必须在**建连之前**抛（INVALID_ARGS 不该先占一个连接）。
      parseVerifyArgs(rawArgs)
      const approve = makeVerifyApprovalRequest(deps.approval, readExecContext(exec))
      const pool = createPool(database)
      try {
        return await withActor(
          pool,
          writeActor.actor_id,
          async (client) => verifyInterviewRecordInTransaction(client, writeConfig, rawArgs, approve),
        )
      } catch (error) {
        throw mapDatabaseError(error)
      } finally {
        await closePool(pool)
      }
    },
  }
}

/**
 * 配置不完整时用的替身：注册同名工具，调用即 `NOT_CONFIGURED`（schema 仍是同一个封闭对象）。
 * @param issues - 缺哪些配置（值里永远不含密码）。
 */
export function unconfiguredInterviewRecordVerifyTool(issues: readonly string[]): ReadonlyToolDefinition {
  return {
    name: INTERVIEW_RECORD_VERIFY_TOOL,
    description: `${DESCRIPTION}\n\nCurrently NOT CONFIGURED: the plugin config is missing database `
      + `settings (or the database password environment variable). Calls return NOT_CONFIGURED.`,
    parameters: toParameterSchema(PARAMS),
    output: {
      schema: OUTPUT_SCHEMA,
      render(): readonly TextBlock[] {
        return [{ type: 'text', text: `${INTERVIEW_RECORD_VERIFY_TOOL} is not configured: ${issues.join('; ')}` }]
      },
    },
    isConcurrencySafe(): boolean {
      return false
    },
    async execute(): Promise<unknown> {
      throw contractError('NOT_CONFIGURED', {
        reason_code: 'PLUGIN_NOT_CONFIGURED',
        message: '数据库配置不完整，面试记录核验不可用',
        detail: { issues: [...issues] },
      })
    },
  }
}

/**
 * 渲染模型可见文本（核验结果 + 两条状态轴 + 证据位点 + 读回命令）。
 * 签名必须是 `(args, value)`：DSH 运行时按两参调用 `output.render`。
 * @param _args - 本次调用的入口（渲染不依赖它）。
 * @param value - 本工具的规范输出值。
 */
function renderVerifyValue(_args: unknown, value: unknown): readonly TextBlock[] {
  const v = value as InterviewRecordVerifyValue
  const labels = v.labels === undefined
    ? 'LABELS_MISSING'
    : `${v.labels.provenance}/${v.labels.trigger}/${v.labels.connection}`
  const artifact = v.artifact === undefined
    ? 'artifact=unavailable'
    : `artifact ${shortRef(v.artifact.id)} rev=${v.artifact.source_revision}`
      + ` segments=${v.artifact.segment_count} sha=${v.artifact.content_sha256 === undefined
        ? 'n/a'
        : shortHash(v.artifact.content_sha256)}`
  // 核验人写"角色 + 短号"：完整 actor id 对人没有信息量，只会被原样念出来。
  const verifiedBy = v.record.verified_by_actor_id === undefined
    ? 'unknown'
    : `${v.record.verified_by_actor_kind ?? 'actor'} ${shortRef(v.record.verified_by_actor_id)}`
  const verifiedAt = v.record.verified_at === undefined ? 'unknown' : v.record.verified_at
  // O1 残留：人读正文只给业务标识（状态 / 轮次 / 条数）与短号；完整 UUID 只进末尾的
  // machine arguments 区（模型要复制才能调 transcript_read 读回本场转写）。
  const lines: string[] = [
    `${v.outcome.toLowerCase()} interview record ${shortRef(v.record.id)} (labels: ${labels})`,
    `  record: ${v.record.previous_status}/${v.record.previous_verification_status}`
      + ` -> ${v.record.status}/${v.record.verification_status}`
      + `  record_version=${v.record.record_version}  transcript_revision=${v.record.transcript_revision}`,
    `  面试 ${shortRef(v.record.interview_id)}  申请 ${shortRef(v.record.application_id)}`,
    `  ${artifact}`,
    `  核验人 ${verifiedBy}  核验时间 ${verifiedAt}`,
    `  replayed=${String(v.replayed)}  gate: requested=${String(v.gate.requested)} result=${v.gate.result}`,
    `  changes: written=${String(v.changes.written)} tables=[${v.changes.tables.join(', ')}] `
      + `事件=[${v.changes.event_ids.map((eventId) => shortRef(eventId)).join(', ')}]`,
    `next: ${v.next_action.verify_with}(interview_id=${shortRef(v.record.interview_id)}) `
      + `读回本场转写（完整入参见下）`,
  ]
  // machine arguments：`interview_id` 是 recruitment_transcript_read 的必填入参（读回本场转写），
  // `artifact_id` 用它钉住"人核验过的那一版"（transcript_read 的可选入参）；完整值只允许放这里。
  lines.push(...machineArgumentLines([
    { key: 'interview_id', value: v.record.interview_id },
    ...(v.artifact === undefined ? [] : [{ key: 'artifact_id', value: v.artifact.id }]),
  ]))
  return [{ type: 'text', text: lines.join('\n') }]
}
