// candidate_constraint 的 DB 读/写适配器（append-only，不自己开事务）。
//
// 职责边界：
//   * 纯参数校验在 src/domain/candidate-constraint.ts（parseCandidateConstraintArgs）；
//   * 身份 gate（resolveWriteActor）由写工具层负责 —— 本适配器只接受已解析好的
//     tenant_id / created_by_actor_id，不读配置、不读 session；
//   * 所有写操作跑在调用方的事务里（工具用 withActor 包），只读函数跑在只读事务里；
//   * 错误统一抛 RecruitmentToolError，顶层 code 只用 INVALID_ARGS / NOT_FOUND，
//     具体机检码放 detail JSON 的 reason_code。
//
// SQL 一律带 tenant_id 过滤（STRUCT-07 防跨租户）。
// ---------------------------------------------------------------------------
import type { DatabaseClient } from './pool.ts'
import { isIdempotentPin, UNPIN_TOMBSTONE_TEXT, type CandidateConstraintRow, type ConstraintKind, type ConstraintSource } from '../domain/candidate-constraint.ts'
import { RecruitmentToolError } from '../tools/errors.ts'

/** 与领域层同一张行类型（re-export，调用方不必直接 import domain）。 */
export type { CandidateConstraintRow } from '../domain/candidate-constraint.ts'
/** 墓碑文本常量（读投影据此过滤）。 */
export { UNPIN_TOMBSTONE_TEXT }

/** 抛 INVALID_ARGS / NOT_FOUND，detail 里带 reason_code。 */
function invalidArgs(reasonCode: string, message: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: reasonCode, message }))
}
function notFound(reasonCode: string, message: string): never {
  throw new RecruitmentToolError('NOT_FOUND', JSON.stringify({ reason_code: reasonCode, message }))
}

/** recordConstraint 的入参。 */
export interface RecordConstraintParams {
  readonly tenant_id: string
  readonly candidate_id?: string
  readonly application_id?: string | null
  readonly kind: ConstraintKind
  readonly text: string
  readonly source: ConstraintSource
  readonly interview_id?: string | null
  readonly created_by_actor_id: string
}

export interface RecordConstraintResult {
  readonly inserted: boolean
  readonly constraint_id: string
  readonly superseded_id: string | null
}

/** recordUnpin 的入参（不带 kind；可选 text/source 用于定位目标 PIN）。 */
export interface RecordUnpinParams {
  readonly tenant_id: string
  readonly candidate_id?: string
  readonly application_id?: string | null
  /** 目标 PIN 文本；不给则 pin 该候选人最新一条。 */
  readonly text?: string
  /** 目标 PIN 来源；不给则不按来源过滤。 */
  readonly source?: ConstraintSource
  readonly created_by_actor_id: string
}

export interface RecordUnpinResult {
  readonly inserted: boolean
  readonly constraint_id: string
  readonly superseded_id: string | null
}

/**
 * 解析候选 id 并校验租户归属。
 *
 * 两条路径：
 *   1. 给 candidate_id：`select 1 from recruitment.candidate where tenant_id=$1 and id=$2`；
 *   2. 给 application_id：从 application 查 candidate_id（同样 tenant 过滤）。
 * 两者都给且解析结果不同 → INVALID_ARGS / CANDIDATE_MISMATCH（零写入）。
 * 都不存在/越权 → NOT_FOUND / CANDIDATE_NOT_FOUND | APPLICATION_NOT_FOUND。
 */
export async function resolveCandidateId(
  client: DatabaseClient,
  tenantId: string,
  params: { candidate_id?: string; application_id?: string | null },
): Promise<string> {
  let byCandidate: string | null = null
  let byApplication: string | null = null

  if (params.candidate_id !== undefined) {
    const rows = await client.query<{ id: string }>(
      `select id from recruitment.candidate where tenant_id = $1 and id = $2`,
      [tenantId, params.candidate_id],
    )
    if (rows.rows.length === 0) notFound('CANDIDATE_NOT_FOUND', '候选人不存在或不属于本租户')
    byCandidate = rows.rows[0].id
  }

  if (params.application_id !== undefined && params.application_id !== null) {
    const rows = await client.query<{ candidate_id: string }>(
      `select candidate_id from recruitment.application where tenant_id = $1 and id = $2`,
      [tenantId, params.application_id],
    )
    if (rows.rows.length === 0) notFound('APPLICATION_NOT_FOUND', '申请不存在或不属于本租户')
    byApplication = rows.rows[0].candidate_id
  }

  if (byCandidate !== null && byApplication !== null && byCandidate !== byApplication) {
    invalidArgs('CANDIDATE_MISMATCH', 'application_id 指向的候选人与 candidate_id 不一致')
  }
  const resolved = byCandidate ?? byApplication
  if (resolved === null) invalidArgs('MISSING_REQUIRED', 'candidate_id 与 application_id 至少给一个')
  return resolved
}

interface InterviewRow {
  readonly application_id: string | null
}

/**
 * HANDOFF 校验：interview_id 非空、属于本租户，且与解析出的候选人同链。
 *
 * 若 params.application_id 给了，要求 interview.application_id === params.application_id；
 * 若没给 application_id，则 interview.application_id 反推候选，要求其 candidate_id
 * 与 resolveCandidateId 的结果一致。
 */
async function resolveHandoffChain(
  client: DatabaseClient,
  tenantId: string,
  interviewId: string | null | undefined,
  candidateId: string,
  applicationId: string | null | undefined,
): Promise<{ application_id: string }> {
  if (interviewId === undefined || interviewId === null || interviewId === '') {
    invalidArgs('MISSING_REQUIRED', 'HANDOFF 必须给 interview_id')
  }
  // recruitment.interview 只有 application_id，没有 candidate_id（0001_init.sql）。
  // 候选链必须经 application 反推，不能在 interview 上查不存在的列（SQLSTATE 42703）。
  const rows = await client.query<InterviewRow>(
    `select application_id from recruitment.interview where tenant_id = $1 and id = $2`,
    [tenantId, interviewId],
  )
  if (rows.rows.length === 0) notFound('INTERVIEW_NOT_FOUND', '面试不存在或不属于本租户')
  const row = rows.rows[0]
  if (row.application_id === null) invalidArgs('INTERVIEW_NO_APPLICATION', 'interview 没有关联申请')

  if (applicationId !== undefined && applicationId !== null) {
    if (row.application_id !== applicationId) {
      invalidArgs('INTERVIEW_APPLICATION_MISMATCH', 'interview 不属于给定的 application_id')
    }
  } else {
    // 没给 application_id：从 interview.application_id 反查候选人再比对。
    const appRows = await client.query<{ candidate_id: string }>(
      `select candidate_id from recruitment.application where tenant_id = $1 and id = $2`,
      [tenantId, row.application_id],
    )
    if (appRows.rows.length === 0) notFound('APPLICATION_NOT_FOUND', '面试关联的申请不存在或不属于本租户')
    if (appRows.rows[0].candidate_id !== candidateId) {
      invalidArgs('INTERVIEW_CANDIDATE_MISMATCH', 'interview 对应的候选人与目标候选人不一致')
    }
  }
  return { application_id: row.application_id as string }
}

/** INSERT 一行约束，返回新 id。 */
async function insertConstraint(
  client: DatabaseClient,
  params: {
    readonly tenant_id: string
    readonly candidate_id: string
    readonly kind: ConstraintKind
    readonly text: string
    readonly source: ConstraintSource
    readonly application_id: string | null
    readonly interview_id: string | null
    readonly created_by_actor_id: string
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.candidate_constraint
        (tenant_id, candidate_id, kind, text, source, application_id, interview_id, created_by_actor_id)
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning id`,
    [
      params.tenant_id, params.candidate_id, params.kind, params.text, params.source,
      params.application_id, params.interview_id, params.created_by_actor_id,
    ],
  )
  const id = inserted.rows[0]?.id
  if (id === undefined) throw new Error('insert into candidate_constraint returned no id')
  return id
}

/**
 * 记录一条 PIN / HANDOFF 约束（append-only supersede 语义）。
 *
 * 步骤：
 *   1. resolveCandidateId（失败零写入）；
 *   2. HANDOFF 时校验 interview 与候选同租户同链；
 *   3. PIN 幂等：`select ... for update` 找同 (tenant, candidate, kind='PIN', text, source)
 *      且 superseded is null 的当前行；命中 → 零写入返回；
 *   4. INSERT 一行；不同 text/source 的 PIN 是不同约束，多条并存（不 supersede）。
 *
 * 注意：本函数不做 supersede——supersede 仅由 recordUnpin（UNPIN）触发。
 * 调用方须在 withActor 事务里调用。
 */
export async function recordConstraint(
  client: DatabaseClient,
  params: RecordConstraintParams,
): Promise<RecordConstraintResult> {
  const candidateId = await resolveCandidateId(client, params.tenant_id, params)

  let applicationId: string | null = params.application_id ?? null
  let interviewId: string | null = params.interview_id ?? null
  if (params.kind === 'HANDOFF') {
    const chain = await resolveHandoffChain(client, params.tenant_id, interviewId, candidateId, applicationId)
    applicationId = chain.application_id
  }

  if (params.kind === 'PIN') {
    const current = await client.query<CandidateConstraintRow>(
      `select * from recruitment.candidate_constraint
        where tenant_id = $1 and candidate_id = $2 and kind = 'PIN'
          and text = $3 and source = $4
          and superseded_by_constraint_id is null
        for update`,
      [params.tenant_id, candidateId, params.text, params.source],
    )
    const old = current.rows[0]
    if (old !== undefined && isIdempotentPin(old.text, params.text, old.source, params.source)) {
      return { inserted: false, constraint_id: old.id, superseded_id: null }
    }
  }

  const newId = await insertConstraint(client, {
    tenant_id: params.tenant_id,
    candidate_id: candidateId,
    kind: params.kind,
    text: params.text,
    source: params.source,
    application_id: applicationId,
    interview_id: interviewId,
    created_by_actor_id: params.created_by_actor_id,
  })
  return { inserted: true, constraint_id: newId, superseded_id: null }
}

/**
 * UNPIN：不直接改业务列（禁 UPDATE 业务列），而是 append-only 墓碑方案。
 *
 *   1. resolveCandidateId；
 *   2. 找目标 PIN（candidate + 可选 text/source；无 text 时取最新一条）；
 *      找不到 → NOT_FOUND / PIN_NOT_FOUND（零写入）；
 *   3. INSERT 一行墓碑（kind='PIN'、text=UNPIN_TOMBSTONE_TEXT、source=入参或 OTHER、
 *      superseded 留空）—— 墓碑自身 append-only；
 *   4. 把目标 PIN 的 superseded_by_constraint_id 指向墓碑 + record_version+1
 *      （fn_guard_columns 白名单允许的唯一 UPDATE）。
 *
 * 读投影过滤掉 superseded 非空的旧行，以及 text===UNPIN_TOMBSTONE_TEXT 的墓碑行，
 * 于是该 PIN 不再置顶，且全部历史仍可查。调用方须在 withActor 事务里调用。
 */
export async function recordUnpin(
  client: DatabaseClient,
  params: RecordUnpinParams,
): Promise<RecordUnpinResult> {
  const candidateId = await resolveCandidateId(client, params.tenant_id, params)

  const conditions = [
    'tenant_id = $1', 'candidate_id = $2', "kind = 'PIN'", 'superseded_by_constraint_id is null',
  ]
  const values: unknown[] = [params.tenant_id, candidateId]
  if (params.text !== undefined && params.text !== '') {
    values.push(params.text)
    conditions.push(`text = $${values.length}`)
  }
  if (params.source !== undefined) {
    values.push(params.source)
    conditions.push(`source = $${values.length}`)
  }
  const targets = await client.query<CandidateConstraintRow>(
    `select * from recruitment.candidate_constraint
      where ${conditions.join(' and ')}
      order by created_at desc, id desc
      for update`,
    values,
  )
  const target = targets.rows[0]
  if (target === undefined) notFound('PIN_NOT_FOUND', '没有可取消置顶的 PIN 约束')

  const tombstoneId = await insertConstraint(client, {
    tenant_id: params.tenant_id,
    candidate_id: candidateId,
    kind: 'PIN',
    text: UNPIN_TOMBSTONE_TEXT,
    source: params.source ?? 'OTHER',
    application_id: params.application_id ?? null,
    interview_id: null,
    created_by_actor_id: params.created_by_actor_id,
  })

  const supersede = await client.query(
    `update recruitment.candidate_constraint
        set superseded_by_constraint_id = $2,
            record_version = record_version + 1
      where tenant_id = $1 and id = $3`,
    [params.tenant_id, tombstoneId, target.id],
  )
  if (supersede.rowCount !== 1) {
    throw new Error(`supersede of candidate_constraint ${target.id} affected ${supersede.rowCount} rows`)
  }
  return { inserted: true, constraint_id: tombstoneId, superseded_id: target.id }
}

/**
 * 读某候选人的当前 PIN 行（含墓碑，由读投影过滤）。空数组短路。
 * 纯读，调用方应放在 withReadOnly 里。
 */
export async function readPinsForCandidates(
  client: DatabaseClient,
  tenantId: string,
  candidateIds: readonly string[],
): Promise<CandidateConstraintRow[]> {
  if (candidateIds.length === 0) return []
  const { rows } = await client.query<CandidateConstraintRow>(
    `select id, tenant_id, candidate_id, kind, text, source, application_id, interview_id,
            created_by_actor_id, created_at, superseded_by_constraint_id, record_version
       from recruitment.candidate_constraint
      where tenant_id = $1 and candidate_id = any($2::uuid[]) and kind = 'PIN'
        and superseded_by_constraint_id is null
      order by candidate_id, created_at, id`,
    [tenantId, [...candidateIds]],
  )
  return rows
}

/**
 * 读某面试的当前 HANDOFF 行。空数组短路。
 * 纯读，调用方应放在 withReadOnly 里。
 */
export async function readHandoffsForInterviews(
  client: DatabaseClient,
  tenantId: string,
  interviewIds: readonly string[],
): Promise<CandidateConstraintRow[]> {
  if (interviewIds.length === 0) return []
  const { rows } = await client.query<CandidateConstraintRow>(
    `select id, tenant_id, candidate_id, kind, text, source, application_id, interview_id,
            created_by_actor_id, created_at, superseded_by_constraint_id, record_version
       from recruitment.candidate_constraint
      where tenant_id = $1 and interview_id = any($2::uuid[]) and kind = 'HANDOFF'
        and superseded_by_constraint_id is null
      order by interview_id, created_at, id`,
    [tenantId, [...interviewIds]],
  )
  return rows
}
