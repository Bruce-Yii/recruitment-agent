// criterion_override 的 DB 读/写适配器。
//
// 职责边界：
//   * 纯参数校验在 src/domain/criterion-override.ts（parseCriterionOverrideArgs）；
//   * 身份 gate（resolveWriteActor / DEMO_ACTOR_UNMAPPED）由写工具层负责 ——
//     本适配器只接受**已经解析好的** actor_id 与 tenant_id 参数，不读配置、不读 session。
//   * 本适配器所有写操作都跑在调用方的事务里（工具用 withActor 包），
//     只读函数跑在 withReadOnly 的事务里；自己不开/提交事务。
//   * 错误统一抛 RecruitmentToolError，顶层 code 只取 CLOSED set 内的
//     INVALID_ARGS / NOT_FOUND；具体机检码放 detail JSON 的 reason_code。
import type { DatabaseClient } from './pool.ts'
import { isIdempotentSameState, sha256Text, type HumanState } from '../domain/criterion-override.ts'
import { RecruitmentToolError } from '../tools/errors.ts'

/** pg 读出来的 timestamptz：pg 默认给 Date（改了 type parser 时可能是 string）。 */
export type PgTimestamp = Date | string

/** criterion_override 的一行（全部列）。 */
export interface CriterionOverrideRow {
  readonly id: string
  readonly tenant_id: string
  readonly application_id: string
  readonly rubric_version_id: string
  readonly criterion_key: string
  readonly human_state: HumanState
  readonly note: string | null
  readonly actor_id: string
  readonly confirmation_method: string
  readonly confirmation_text_sha256: string
  readonly superseded_by_override_id: string | null
  readonly record_version: number
  readonly created_at: PgTimestamp
  readonly updated_at: PgTimestamp
}

/** recordOverride 的入参（哈希由调用方用 sha256Text 算好）。 */
export interface RecordOverrideParams {
  readonly tenant_id: string
  readonly application_id: string
  /**
   * 仅供调用方转述；**实际写入值由本适配器从 application.rubric_version_id（钉住版本）派生**。
   * 故意可选：Agent 入参里根本没有 rubric_version_id（服务端派生字段），工具层不应伪造一个传进来。
   */
  readonly rubric_version_id?: string
  readonly criterion_key: string
  readonly human_state: HumanState
  readonly note?: string | null
  readonly actor_id: string
  readonly confirmation_text_sha256: string
  /** 原文只在调用方内存里，用来对比当前行哈希；不落库。 */
  readonly confirmation_text: string
}

export interface CriterionValidationOk {
  readonly ok: true
  readonly rubric_version_id: string
}

export interface CriterionValidationErr {
  readonly ok: false
  readonly reason_code: 'APPLICATION_NOT_FOUND' | 'NO_PINNED_RUBRIC' | 'CRITERION_NOT_IN_RUBRIC'
}

export type CriterionValidation = CriterionValidationOk | CriterionValidationErr

/** 一条 rubric dimension 的最小形状（只看 key）。 */
interface RubricDimension {
  readonly key?: unknown
}

/**
 * 校验 criterion_key 是否属于申请钉住的 rubric 版本。
 *
 * 顺序：application.rubric_version_id（钉住值）→ rubric_version.dimensions（jsonb）→
 * dimensions 必须是数组，且至少一个元素对象的 key === criterionKey。
 * 注意：不按 job.current_rubric_version_id 回退 —— 配置变了也不移动历史事实。
 * @param client - 调用方事务里的 DB client。
 */
export async function validateCriterionInPinnedRubric(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  criterionKey: string,
): Promise<CriterionValidation> {
  const appRows = await client.query<{ rubric_version_id: string | null }>(
    `select rubric_version_id from recruitment.application
      where tenant_id = $1 and id = $2`,
    [tenantId, applicationId],
  )
  const pinned = appRows.rows[0]?.rubric_version_id
  if (appRows.rows.length === 0) return { ok: false, reason_code: 'APPLICATION_NOT_FOUND' }
  if (pinned === null || pinned === undefined) return { ok: false, reason_code: 'NO_PINNED_RUBRIC' }

  const rubricRows = await client.query<{ dimensions: unknown }>(
    `select dimensions from recruitment.rubric_version
      where tenant_id = $1 and id = $2`,
    [tenantId, pinned],
  )
  const dimensions = rubricRows.rows[0]?.dimensions
  if (rubricRows.rows.length === 0 || dimensions === null || dimensions === undefined) {
    return { ok: false, reason_code: 'CRITERION_NOT_IN_RUBRIC' }
  }

  // pg 对 jsonb 默认返回已解析的 JS 值；也容忍调用方配置了字符串 parser。
  let parsed: unknown = dimensions
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return { ok: false, reason_code: 'CRITERION_NOT_IN_RUBRIC' }
    }
  }
  if (!Array.isArray(parsed)) return { ok: false, reason_code: 'CRITERION_NOT_IN_RUBRIC' }

  const found = parsed.some((dimension: unknown): boolean => {
    if (typeof dimension !== 'object' || dimension === null) return false
    return (dimension as RubricDimension).key === criterionKey
  })
  if (!found) return { ok: false, reason_code: 'CRITERION_NOT_IN_RUBRIC' }
  return { ok: true, rubric_version_id: pinned }
}

/** 抛 INVALID_ARGS，detail 里带 reason_code（顶层 code 不越界）。 */
function invalidArgs(reasonCode: string, message: string): never {
  throw new RecruitmentToolError('INVALID_ARGS', JSON.stringify({ reason_code: reasonCode, message }))
}

/** 把校验失败映射成稳定 reason_code（工具层再映射成人话/合同码）。 */
function throwCriterionValidation(result: CriterionValidationErr): never {
  const messages: Record<CriterionValidationErr['reason_code'], string> = {
    APPLICATION_NOT_FOUND: '申请不存在',
    NO_PINNED_RUBRIC: '申请没有钉住 rubric 版本',
    CRITERION_NOT_IN_RUBRIC: 'criterion 不在申请钉住的 rubric 版本中',
  }
  invalidArgs(result.reason_code, messages[result.reason_code])
}

export interface RecordOverrideResult {
  /** 是否真的插入了新行（false = 幂等 no-op，没有写库）。 */
  readonly inserted: boolean
  /** 当前有效行 id（幂等时就是原行 id）。 */
  readonly override_id: string
  /** 被取代的旧行 id（幂等时为 null）。 */
  readonly superseded_id: string | null
}

/**
 * 记录一次人覆盖（append-only supersede）。
 *
 * 步骤：
 *   1. 校验 criterion 属于钉住 rubric（失败 → RecruitmentToolError）；
 *   2. 在事务里 `select ... for update` 找当前行（superseded_by_override_id is null）；
 *   3. 若三态 + note + 确认哈希都相同 → 幂等 no-op，零写入；
 *   4. 否则 INSERT 新行；若存在旧当前行，只更新它的 superseded_by_override_id
 *      指向新行（DB 的 fn_guard_columns 保证其它列一个字都改不了）。
 *
 * 调用方须保证 params.confirmation_text_sha256 === sha256Text(params.confirmation_text)；
 * 本函数用原文重算一次做防御性核对，防止调用方传错哈希。
 */
export async function recordOverride(
  client: DatabaseClient,
  params: RecordOverrideParams,
): Promise<RecordOverrideResult> {
  const validation = await validateCriterionInPinnedRubric(
    client, params.tenant_id, params.application_id, params.criterion_key,
  )
  if (!validation.ok) throwCriterionValidation(validation)

  // 防御性核对：哈希必须由原文算来（避免调用方把 AI 的哈希塞进来）。
  if (sha256Text(params.confirmation_text) !== params.confirmation_text_sha256) {
    invalidArgs('CONFIRMATION_HASH_MISMATCH', 'confirmation_text_sha256 与 confirmation_text 不一致')
  }

  const current = await client.query<CriterionOverrideRow>(
    `select * from recruitment.criterion_override
      where tenant_id = $1 and application_id = $2 and rubric_version_id = $3 and criterion_key = $4
        and superseded_by_override_id is null
      for update`,
    [params.tenant_id, params.application_id, validation.rubric_version_id, params.criterion_key],
  )
  const old = current.rows[0]

  if (old !== undefined
      && isIdempotentSameState(old.human_state, params.human_state, old.note, params.note)
      && old.confirmation_text_sha256 === params.confirmation_text_sha256) {
    return { inserted: false, override_id: old.id, superseded_id: null }
  }

  const inserted = await client.query<{ id: string }>(
    `insert into recruitment.criterion_override
       (tenant_id, application_id, rubric_version_id, criterion_key, human_state, note,
        actor_id, confirmation_method, confirmation_text_sha256)
     values ($1, $2, $3, $4, $5, $6, $7, 'IN_CHAT', $8)
     returning id`,
    [
      params.tenant_id, params.application_id, validation.rubric_version_id, params.criterion_key,
      params.human_state, params.note ?? null, params.actor_id, params.confirmation_text_sha256,
    ],
  )
  const newId = inserted.rows[0]?.id
  if (newId === undefined) throw new Error('insert into criterion_override returned no id')

  if (old !== undefined) {
    // 唯一允许 UPDATE 的业务列：superseded_by_override_id。
    // updated_at / record_version 是本行被"标记取代"的自身审计元数据，
    // fn_guard_columns 把它们视为触发器自身维护列而放行（见 0001_init.sql §0）。
    const supersede = await client.query(
      `update recruitment.criterion_override
          set superseded_by_override_id = $2,
              updated_at = now(),
              record_version = record_version + 1
        where tenant_id = $1 and id = $3`,
      [params.tenant_id, newId, old.id],
    )
    if (supersede.rowCount !== 1) {
      throw new Error(`supersede of criterion_override ${old.id} affected ${supersede.rowCount} rows`)
    }
  }

  return { inserted: true, override_id: newId, superseded_id: old?.id ?? null }
}

/**
 * 读一个/多个申请的全部覆盖历史（含已被取代的旧行）。
 *
 * 只读：调用方应放在 withReadOnly 里。按 (application_id, created_at, id) 排序，
 * 保证时间线稳定、同一时刻按 uuid 排（读投影层据此还原链）。
 * @param client - 只读事务里的 DB client。
 * @param tenantId - 租户 id（强制过滤，防跨租户读）。
 * @param applicationIds - 申请 id 列表；空数组返回空数组（不发无意义的查询）。
 */
export async function readOverridesForApplications(
  client: DatabaseClient,
  tenantId: string,
  applicationIds: readonly string[],
): Promise<CriterionOverrideRow[]> {
  if (applicationIds.length === 0) return []
  const { rows } = await client.query<CriterionOverrideRow>(
    `select id, tenant_id, application_id, rubric_version_id, criterion_key, human_state,
            note, actor_id, confirmation_method, confirmation_text_sha256,
            superseded_by_override_id, record_version, created_at, updated_at
       from recruitment.criterion_override
      where tenant_id = $1 and application_id = any($2::uuid[])
      order by application_id, created_at, id`,
    [tenantId, [...applicationIds]],
  )
  return rows
}

/** 单申请版本的便捷封装（给只读工具用；签名与多行版一致，便于复用）。 */
export async function readOverridesForApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<CriterionOverrideRow[]> {
  return readOverridesForApplications(client, tenantId, [applicationId])
}

/**
 * 覆盖历史的时间线投影（可选便捷函数，供读投影层使用）。
 *
 * 每 (application_id, criterion_key) 只保留链尾（superseded_by_override_id is null）
 * 作为当前值，history 按 created_at 升序包含该 criterion 的全部行（含 AI 原判定
 * 位置——AI 原判定本身不在此表里，由读侧从 interview_record 单独取）。
 *
 * 时间用 ISO-8601 字符串（pg 的 Date 或 string 都转成 string），避免把 pg 驱动类型
 * 泄漏给 HTTP 渲染层。
 */
export interface CriterionOverrideProjection {
  readonly ai_state: null
  readonly human_state: HumanState | null
  readonly effective_state: string | null
  readonly override_note: string | null
  readonly overridden_at: string | null
  readonly history: readonly {
    readonly override_id: string
    readonly human_state: HumanState
    readonly note: string | null
    readonly actor_id: string
    readonly confirmation_method: string
    readonly overridden_at: string
    readonly superseded_by_override_id: string | null
  }[]
}

function iso(value: PgTimestamp): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

export function toOverrideProjection(
  rows: readonly CriterionOverrideRow[],
): Map<string, Map<string, CriterionOverrideProjection>> {
  const result = new Map<string, Map<string, CriterionOverrideProjection>>()
  const byKey = new Map<string, CriterionOverrideRow[]>()
  for (const row of rows) {
    const key = `${row.application_id}\u0000${row.criterion_key}`
    const bucket = byKey.get(key)
    if (bucket === undefined) byKey.set(key, [row])
    else bucket.push(row)
  }
  for (const [key, bucket] of byKey) {
    const sep = key.indexOf('\u0000')
    const applicationId = key.slice(0, sep)
    const criterionKey = key.slice(sep + 1)
    const sorted = [...bucket].sort((a, b) => {
      const ta = iso(a.created_at)
      const tb = iso(b.created_at)
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    const current = sorted.find((row) => row.superseded_by_override_id === null) ?? null
    let appMap = result.get(applicationId)
    if (appMap === undefined) {
      appMap = new Map<string, CriterionOverrideProjection>()
      result.set(applicationId, appMap)
    }
    appMap.set(criterionKey, {
      ai_state: null,
      human_state: current?.human_state ?? null,
      effective_state: current?.human_state ?? null,
      override_note: current?.note ?? null,
      overridden_at: current ? iso(current.created_at) : null,
      history: sorted.map((row) => ({
        override_id: row.id,
        human_state: row.human_state,
        note: row.note,
        actor_id: row.actor_id,
        confirmation_method: row.confirmation_method,
        overridden_at: iso(row.created_at),
        superseded_by_override_id: row.superseded_by_override_id,
      })),
    })
  }
  return result
}
