// 批量初筛不通过（SCREENING / REJECT）的**编排**层。
//
// 本文件不复制任何决策逻辑、不写决策 SQL、不算 summary / basis / hash。
// 唯一写入口是高层工具 `createRecordHumanDecisionTool`（`src/tools/record-human-decision.ts`）：
// 每个申请一次独立 `execute` = 一个独立连接池 / 独立事务（STEP 0→7 全闸门 + 同事务派生
// S6→S7 + ACTIVE→CLOSED + 既有 decision.record 事件），部分失败不回滚已成功项。
//
// HTTP 闸门（loopback / sameOrigin / session→actor / 越权 / confirmation sha256）由 Owner 的
// `src/http/batch-undo.ts` 在调用本函数之前完成；本文件只做业务编排。
//
// 幂等：先只读查同一 (tenant, application) 是否已有 current 的 SCREENING/REJECT 决策且 reason 相同，
// 命中则直接产出 ok=true + reason_code='ALREADY_DECIDED_IDEMPOTENT'（真正零写入，不调工具）；
// 竞态下工具抛 ALREADY_DECIDED 时再查一次，同 reason/result 视为幂等成功，否则失败。
import { isUuid } from '../tools/contract.ts'
import { createRecordHumanDecisionTool } from '../tools/record-human-decision.ts'
import type { ReadonlyToolDefinition } from '../tools/definition.ts'
import { RecruitmentToolError } from '../tools/errors.ts'
import {
  closePool,
  createPool,
  withReadOnly,
  type ResolvedDatabaseConfig,
} from '../db/pool.ts'
import type { DemoActorIdentity } from '../demo-actor/index.ts'

/** 单条结果（HTTP 返回契约逐字）。 */
export interface BatchRejectItemResult {
  readonly application_id: string
  readonly ok: boolean
  readonly reason_code?: string
  readonly message?: string
  readonly decision_id?: string   // 成功时新决策 id（写后读回）
}
export interface BatchRejectResult {
  readonly results: readonly BatchRejectItemResult[]
  readonly succeeded: number
  readonly failed: number
}

/** 批量上限 / 文本上限（与 UI 与高层工具口径一致：reason ≤500 严于领域 4000；text ≤2000）。 */
const MAX_ITEMS = 50
const REASON_MAX = 500
const CONFIRMATION_TEXT_MAX = 2000

/** 带稳定 code 的普通 Error（Owner 映射成 HTTP 400）。 */
class InvalidArgsError extends Error {
  readonly code = 'INVALID_ARGS'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidArgsError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 入参形状校验（纯函数，不碰库）。1..50 个 application_id（UUID）、reason 必填 ≤500、
 * confirmation_text 必填 1..2000。
 * 抛普通 Error，带 `code` 字段 'INVALID_ARGS' 与 message；Owner 再映射成 HTTP 400。
 */
export function parseBatchRejectInput(body: Record<string, unknown>): {
  readonly application_ids: readonly string[]
  readonly reason: string
  readonly confirmation_text: string
} {
  if (!isPlainObject(body)) {
    throw new InvalidArgsError('请求体必须是 JSON 对象')
  }
  const ids = body.application_ids
  if (!Array.isArray(ids)) {
    throw new InvalidArgsError('application_ids 必须是数组')
  }
  if (ids.length < 1 || ids.length > MAX_ITEMS) {
    throw new InvalidArgsError(`application_ids 必须有 1..${MAX_ITEMS} 个`)
  }
  for (const [index, id] of ids.entries()) {
    if (!isUuid(id)) {
      throw new InvalidArgsError(`application_ids[${index}] 必须是 UUID`)
    }
  }
  const reason = body.reason
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new InvalidArgsError('reason 必须是非空字符串')
  }
  if (reason.length > REASON_MAX) {
    throw new InvalidArgsError(`reason 最多 ${REASON_MAX} 字符`)
  }
  const confirmationText = body.confirmation_text
  if (typeof confirmationText !== 'string' || confirmationText.trim() === '') {
    throw new InvalidArgsError('confirmation_text 必须是非空字符串')
  }
  if (confirmationText.length > CONFIRMATION_TEXT_MAX) {
    throw new InvalidArgsError(`confirmation_text 最多 ${CONFIRMATION_TEXT_MAX} 字符`)
  }
  return {
    application_ids: ids as string[],
    reason,
    confirmation_text: confirmationText,
  }
}

// ---------------------------------------------------------------------------
//  工具工厂 / 只读查询接缝（便于纯逻辑注入 stub；默认走真实高层工具与真库）
// ---------------------------------------------------------------------------

/** 编排所需的最小工具面（与 `ReadonlyToolDefinition` 对齐）。 */
export interface DecisionToolLike {
  readonly name: string
  readonly execute: (args: unknown, exec: unknown) => Promise<unknown>
}

export type BatchRejectToolFactory = (toolDeps: {
  readonly database: ResolvedDatabaseConfig
  readonly identity: DemoActorIdentity
}) => DecisionToolLike

/** 默认工厂：唯一允许的写入口 = 高层决策工具。 */
const DEFAULT_TOOL_FACTORY: BatchRejectToolFactory = (toolDeps) =>
  createRecordHumanDecisionTool(toolDeps) as ReadonlyToolDefinition as DecisionToolLike

/** 查一条 current 的 SCREENING/REJECT 决策 id（reason 相同才返回）。纯只读、参数化、租户隔离。 */
type IdempotentLookup = (applicationId: string, reason: string) => Promise<string | undefined>

const CURRENT_REJECT_SQL = `
  select d.id::text as decision_id
    from recruitment.decision d
   where d.tenant_id = $1::uuid
     and d.application_id = $2::uuid
     and d.decision_scope = 'SCREENING'
     and d.result = 'REJECT'
     and d.reason = $3::text
     and d.superseded_by_decision_id is null
   order by d.decided_at desc, d.id desc
   limit 1
`

async function lookupCurrentReject(
  database: ResolvedDatabaseConfig,
  applicationId: string,
  reason: string,
): Promise<string | undefined> {
  const pool = createPool(database)
  try {
    return await withReadOnly(pool, async (client) => {
      const rows = await client.query<{ decision_id: string }>(CURRENT_REJECT_SQL, [
        database.tenant_id,
        applicationId,
        reason,
      ])
      return rows.rows[0]?.decision_id
    })
  } finally {
    await closePool(pool)
  }
}

// ---------------------------------------------------------------------------
//  错误信封解析（`CODE: {compact-json}`）
// ---------------------------------------------------------------------------

interface ParsedToolError {
  readonly code: string
  readonly reason_code: string
  readonly message: string
}

/** 从 RecruitmentToolError / Error / 任意值里抽 code / reason_code / message，不吞细节。 */
export function parseToolError(error: unknown): ParsedToolError {
  const raw = error instanceof Error ? error.message : String(error)
  const match = /^([A-Z][A-Z0-9_]*):\s*(\{[\s\S]*\})\s*$/.exec(raw)
  if (match !== null) {
    const code = match[1] ?? 'UNKNOWN'
    try {
      const body = JSON.parse(match[2] ?? '{}') as Record<string, unknown>
      const reasonCode = typeof body.reason_code === 'string' && body.reason_code !== ''
        ? body.reason_code
        : code
      const message = typeof body.message === 'string' && body.message !== ''
        ? body.message
        : raw
      return { code, reason_code: reasonCode, message }
    } catch {
      return { code, reason_code: code, message: raw }
    }
  }
  if (error instanceof RecruitmentToolError) {
    return { code: error.code, reason_code: error.code, message: raw }
  }
  return { code: 'UNKNOWN', reason_code: 'UNKNOWN', message: raw }
}

/** 工具出参 → 新决策 id（写后读回值；拿不到就不算成功）。 */
function decisionIdFromOutput(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined
  const decision = value.decision
  if (!isPlainObject(decision)) return undefined
  const id = decision.id
  return typeof id === 'string' && isUuid(id) ? id : undefined
}

// ---------------------------------------------------------------------------
//  批量执行
// ---------------------------------------------------------------------------

/**
 * 批量执行：逐条调用 `createRecordHumanDecisionTool(...).execute(...)`，每条独立工具调用（独立池/独立事务）。
 * 部分失败绝不回滚已成功的；单条失败按错误信封抽 reason_code + 人话 message。
 * `actor` 用 `execOf` 形状 `{agent:{id:session_id}, headers:{'x-dsh-session':session_id}}`（与 http/actions.ts 一致）。
 * 每条 `human_confirmation.text` 用**同一句 confirmation_text**（即人的原话，覆盖整批），
 * confirmed_at 用服务端 nowIso。
 */
export async function runBatchReject(deps: {
  readonly database: ResolvedDatabaseConfig
  readonly identity: DemoActorIdentity
  readonly session_id: string
  readonly actor_id: string
  readonly now_ms?: number
  /** 测试接缝：缺省 `createRecordHumanDecisionTool`。 */
  readonly toolFactory?: BatchRejectToolFactory
  /** 测试接缝：缺省真库只读查询（幂等预检）。 */
  readonly findIdempotent?: IdempotentLookup
}, input: {
  readonly application_ids: readonly string[]
  readonly reason: string
  readonly confirmation_text: string
}): Promise<BatchRejectResult> {
  const nowMs = typeof deps.now_ms === 'number' ? deps.now_ms : Date.now()
  const confirmedAt = new Date(nowMs).toISOString()
  const factory = deps.toolFactory ?? DEFAULT_TOOL_FACTORY
  const lookup: IdempotentLookup = deps.findIdempotent
    ?? ((applicationId, reason) => lookupCurrentReject(deps.database, applicationId, reason))
  const tool = factory({ database: deps.database, identity: deps.identity })
  const exec = {
    agent: { id: deps.session_id },
    headers: { 'x-dsh-session': deps.session_id },
  }

  const results: BatchRejectItemResult[] = []
  for (const applicationId of input.application_ids) {
    results.push(await runOne())
    // 单条编排（闭包捕获当前 applicationId）。
    async function runOne(): Promise<BatchRejectItemResult> {
      // ---- 幂等预检：同 (申请, reason) 已有 current REJECT → 零写入直接成功 ----
      try {
        const existing = await lookup(applicationId, input.reason)
        if (existing !== undefined) {
          return {
            application_id: applicationId,
            ok: true,
            reason_code: 'ALREADY_DECIDED_IDEMPOTENT',
            decision_id: existing,
          }
        }
      } catch (error) {
        // 预检失败不静默吞掉：如实作为这一条失败（绝不因为查不到就贸然写库）。
        const parsed = parseToolError(error)
        return {
          application_id: applicationId,
          ok: false,
          reason_code: parsed.reason_code,
          message: `幂等预检失败：${parsed.message}`,
        }
      }

      // ---- 调用高层工具（IN_CHAT：无 approval 闸门；人已确认）----
      const args = {
        application_id: applicationId,
        decision_scope: 'SCREENING',
        result: 'REJECT',
        reason: input.reason,
        human_confirmation: {
          confirmed_at: confirmedAt,
          method: 'IN_CHAT',
          text: input.confirmation_text,
        },
      }
      try {
        const output = await tool.execute(args, exec)
        const decisionId = decisionIdFromOutput(output)
        if (decisionId === undefined) {
          return {
            application_id: applicationId,
            ok: false,
            reason_code: 'READBACK_MISSING',
            message: '工具返回里没有可复核的 decision id',
          }
        }
        return { application_id: applicationId, ok: true, decision_id: decisionId }
      } catch (error) {
        const parsed = parseToolError(error)
        // 竞态幂等：工具报 ALREADY_DECIDED —— 再查一次，同 reason/result 视为幂等成功。
        if (parsed.code === 'ALREADY_DECIDED' || parsed.reason_code === 'SCOPE_ALREADY_DECIDED') {
          try {
            const existing = await lookup(applicationId, input.reason)
            if (existing !== undefined) {
              return {
                application_id: applicationId,
                ok: true,
                reason_code: 'ALREADY_DECIDED_IDEMPOTENT',
                decision_id: existing,
              }
            }
          } catch {
            // 再查也失败 → 落到下方失败分支，保留原 ALREADY_DECIDED 细节。
          }
        }
        return {
          application_id: applicationId,
          ok: false,
          reason_code: parsed.reason_code,
          message: parsed.message,
        }
      }
    }
  }

  const succeeded = results.filter((item) => item.ok).length
  return {
    results,
    succeeded,
    failed: results.length - succeeded,
  }
}
