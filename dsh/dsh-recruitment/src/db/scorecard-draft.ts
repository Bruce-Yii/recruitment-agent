// A4 面评草稿的 DB 适配器（append-only 版本行；**不自己开事务**）。
//
// 职责边界：
//   * 本模块只认已解析好的 tenant_id / interview_id / interviewer_id / interviewer_actor_id；
//     session→actor 绑定、本人面试官校验、"未提交"校验由 HTTP 层（src/http/scorecard-draft.ts）
//     在事务里先用只读查询完成（失败零写入）。
//   * 所有写操作跑在调用方的事务里（HTTP 用 withActor 包）；只读函数跑在只读事务里。
//   * 错误统一抛 RecruitmentToolError，顶层 code 用 INVALID_ARGS / NOT_FOUND / FORBIDDEN，
//     机检码放 detail JSON 的 reason_code（沿用 db/candidate-constraint.ts 的口径）。
//
// 表契约见 db/migrations/0022_scorecard_draft.sql：
//   * 每次保存 INSERT 一行（append-only，禁删 + 整行不可改）；
//   * record_version 由本模块按"当前最新版本 + 1"计算（不用序列，随版本行单调）；
//   * 同一 (interview_id, interviewer_actor_id) 取 created_at/record_version 最新一条为草稿。
//
// 32KB 上限两道：应用端按 JSON 文本 UTF-8 字节数校验（本文件），
// 库端 `ck_scorecard_draft_payload_size`（pg_column_size ≤ 32768）。
// ---------------------------------------------------------------------------
import type { DatabaseClient } from './pool.ts'
import { RecruitmentToolError } from '../tools/errors.ts'

/** payload 的文本字节上限（32KB）。 */
export const MAX_DRAFT_PAYLOAD_BYTES = 32 * 1024

/** 签名与库表一致的草稿行（jsonb 已由 pg 解析成 JS 值）。 */
export interface ScorecardDraftRow {
  readonly id: string
  readonly tenant_id: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly interviewer_actor_id: string
  readonly payload: Record<string, unknown>
  readonly record_version: number
  readonly created_at: Date | string
}

/** 草稿写参数（身份全部由服务端解析，不接受客户端传 actor/tenant）。 */
export interface SaveDraftParams {
  readonly tenant_id: string
  readonly interview_id: string
  readonly interviewer_id: string
  readonly interviewer_actor_id: string
  readonly payload: Record<string, unknown>
}

/** 草稿写结果（供 HTTP 层做独立读回）。 */
export interface SaveDraftResult {
  readonly draft_id: string
  readonly record_version: number
}

function invalidArgs(reasonCode: string, message: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: reasonCode, message }))
}

/**
 * 校验 payload 形状与大小（纯函数；不碰 DB）。
 *
 * 形状：`{ assessments?: {criterion_key: value}, note?: string }`。
 *   * assessments 必须是普通对象（不是数组/null），值不做类型限制（草稿是半成品）；
 *   * note 必须是字符串；
 *   * 未知顶层键一律拒（封闭契约，避免草稿变成另一个写库后门）；
 *   * JSON 文本 UTF-8 字节数 ≤ 32KB（超限 DRAFT_PAYLOAD_TOO_LARGE，零写入）。
 * @param payload - 已解析的 payload（普通对象）。
 * @returns 规范化副本（只含 assessments / note 两个已知键）。
 */
export function validateDraftPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    invalidArgs('DRAFT_PAYLOAD_TYPE', 'payload 必须是对象 {assessments?, note?}')
  }
  const raw = payload as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => key !== 'assessments' && key !== 'note').sort()
  if (unknown.length > 0) {
    invalidArgs('DRAFT_PAYLOAD_UNKNOWN_KEY', `payload 含未声明的键：${unknown.join(', ')}`)
  }
  const normalized: Record<string, unknown> = {}
  if (Object.hasOwn(raw, 'assessments')) {
    const assessments = raw.assessments
    if (typeof assessments !== 'object' || assessments === null || Array.isArray(assessments)) {
      invalidArgs('DRAFT_ASSESSMENTS_TYPE', 'payload.assessments 必须是对象 {criterion_key: value}')
    }
    normalized.assessments = { ...(assessments as Record<string, unknown>) }
  }
  if (Object.hasOwn(raw, 'note')) {
    if (typeof raw.note !== 'string') {
      invalidArgs('DRAFT_NOTE_TYPE', 'payload.note 必须是字符串')
    }
    normalized.note = raw.note as string
  }
  const bytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8')
  if (bytes > MAX_DRAFT_PAYLOAD_BYTES) {
    invalidArgs('DRAFT_PAYLOAD_TOO_LARGE', `payload 不得超过 ${MAX_DRAFT_PAYLOAD_BYTES} 字节（实际 ${bytes}）`)
  }
  return normalized
}

/**
 * 计算下一个版本号（纯函数；供单测直接覆盖边界）。
 * @param current - 当前最新版本号（无草稿时 0）。
 * @returns 当前 + 1；非法当前值（非正整数）按 0 处理。
 */
export function nextDraftVersion(current: number | null | undefined): number {
  const base = typeof current === 'number' && Number.isInteger(current) && current >= 1 ? current : 0
  return base + 1
}

/**
 * 当前草稿（只读；调用方应放在 withReadOnly 里）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（服务端配置）。
 * @param interviewId - 面试 id。
 * @param interviewerActorId - 面试官 actor id（契约的"谁"）。
 * @returns 最新一行；没有草稿时 null。
 */
export async function readDraft(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  interviewerActorId: string,
): Promise<ScorecardDraftRow | null> {
  const { rows } = await client.query<ScorecardDraftRow>(
    `select id::text, tenant_id::text, interview_id::text, interviewer_id::text,
            interviewer_actor_id::text, payload, record_version, created_at
       from recruitment.scorecard_draft
      where tenant_id = $1 and interview_id = $2 and interviewer_actor_id = $3
      order by created_at desc, record_version desc, id desc
      limit 1`,
    [tenantId, interviewId, interviewerActorId],
  )
  return rows[0] ?? null
}

/**
 * 追加一行草稿版本（调用方须在 withActor 事务里；失败由事务整体回滚 = 零写入）。
 *
 * `select ... for update` 锁住当前最新版本行（若存在），避免并发保存产生相同版本号；
 * 行级锁 + append-only 保证同一面试官连续保存 = 版本严格 +1。
 * @param client - 事务内客户端。
 * @param params - 已校验的写参数（payload 须先过 validateDraftPayload）。
 * @returns `{draft_id, record_version}`（读回由 HTTP 层独立再做）。
 */
export async function saveDraft(client: DatabaseClient, params: SaveDraftParams): Promise<SaveDraftResult> {
  const current = await client.query<{ record_version: number }>(
    `select record_version
       from recruitment.scorecard_draft
      where tenant_id = $1 and interview_id = $2 and interviewer_actor_id = $3
      order by record_version desc, created_at desc, id desc
      limit 1
      for update`,
    [params.tenant_id, params.interview_id, params.interviewer_actor_id],
  )
  const version = nextDraftVersion(current.rows[0]?.record_version)
  const inserted = await client.query<{ id: string; record_version: number }>(
    `insert into recruitment.scorecard_draft
        (tenant_id, interview_id, interviewer_id, interviewer_actor_id, payload, record_version)
      values ($1, $2, $3, $4, $5::jsonb, $6)
      returning id::text as id, record_version`,
    [
      params.tenant_id, params.interview_id, params.interviewer_id, params.interviewer_actor_id,
      JSON.stringify(params.payload), version,
    ],
  )
  const row = inserted.rows[0]
  if (row === undefined) throw new Error('insert into scorecard_draft returned no row')
  return { draft_id: row.id, record_version: row.record_version }
}

/**
 * "草稿必须是未提交状态"的只读守卫（调用方须在事务里、写之前跑）。
 *
 * 规则：当前面评（`superseded_by_scorecard_id is null`）status ∈ {SUBMITTED, WAIVED}
 * → FORBIDDEN / SCORECARD_ALREADY_SUBMITTED（零写入）。
 * PENDING / 没有面评行都允许写草稿（草稿本来就是提交前的半成品）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户。
 * @param interviewId - 面试 id。
 * @param interviewerId - 面试官行 id（scorecard.interviewer_id 同口径）。
 */
export async function assertDraftWritable(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string,
  interviewerId: string,
): Promise<void> {
  const { rows } = await client.query<{ status: string }>(
    `select status
       from recruitment.scorecard
      where tenant_id = $1 and interview_id = $2 and interviewer_id = $3
        and superseded_by_scorecard_id is null`,
    [tenantId, interviewId, interviewerId],
  )
  const status = rows[0]?.status
  if (status === 'SUBMITTED' || status === 'WAIVED') {
    throw new RecruitmentToolError(
      'FORBIDDEN',
      JSON.stringify({
        reason_code: 'SCORECARD_ALREADY_SUBMITTED',
        message: '该场面试的面评已提交/已豁免，不允许再写草稿（草稿只存在于提交之前）',
      }),
    )
  }
}
