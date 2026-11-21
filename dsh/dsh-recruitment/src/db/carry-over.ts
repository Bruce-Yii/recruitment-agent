// 跨岗携带历史（AT-1/2/3）的可复用 DB 逻辑。
//
// 本文件只做三件事，全部收在一处，避免写工具里散落 SQL：
//   1. `parseCarryOverRefs()`  —— 模型入参 `carry_over_refs` 的严格**形状**校验（不碰库）；
//   2. `validateCarryOverRefs()` —— 在**已有事务里**校验源/目标申请与每个 ref 的归属；
//   3. `insertCarryOverRefs()`  —— 只 INSERT `application_carry_over`，幂等靠库级唯一键。
//
// AT-1（旧申请一行不改）：本文件**没有**任何 UPDATE / DELETE，也没有对源申请的写语句；
//   源申请只读（loadApplication），唯一写入是 append-only 的 carry_over 行。
// AT-2（同候选人 / 同租户 / 源≠目标）：工具层在这里 fail-closed，0018 的
//   `trg_application_carry_over_same_candidate` 是第二道防线。
// AT-3（幂等）：`insert ... on conflict (...) do nothing`，返回的 inserted 是**真实插入行数**。
//
// actor 只能来自配置/事务 GUC（调用方把 `cfg.database.actor_id` 传进来），
//   **永远不接受模型入参**；模型参数 schema 里没有 actor 键（args.ts 也会拒）。

import { contractError, isUuid } from '../tools/contract.ts'
import type { DatabaseClient } from './pool.ts'

/** ref_kind 闭集（与 0018 的 `ck_carry_over_ref_kind` 逐字一致）。 */
export const CARRY_OVER_REF_KINDS = ['SCORECARD', 'TRANSCRIPT', 'DECISION'] as const

/** 一种被携带的引用类型。 */
export type CarryOverRefKind = (typeof CARRY_OVER_REF_KINDS)[number]

/** 一条被携带的引用（工具入参的形状，已校验）。 */
export interface CarryOverRef {
  readonly source_application_id: string
  readonly ref_kind: CarryOverRefKind
  readonly ref_id: string
}

/** 元素允许的键（字典序，用于"恰好这三个键"的比较）。 */
const REF_KEYS = ['ref_id', 'ref_kind', 'source_application_id'] as const

/** 普通对象判定（数组 / null 不算）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格解析可选入参 `carry_over_refs`。
 *
 * 形状：数组（给了才校验）；每个元素是**恰好**三个键 `{source_application_id, ref_kind, ref_id}`
 * 的普通对象；两个 id 是 UUID 文本；`ref_kind` 在闭集里。任何多键/少键/类型不符都 INVALID_ARGS。
 * @param raw - 模型给的原始值（`undefined` = 没传 ⇒ 返回 `undefined`，现有行为逐字不变）。
 * @returns 归一化后的引用数组；`undefined` 表示调用方未携带该参数。
 * @throws RecruitmentToolError - INVALID_ARGS（reason_code 以 CARRY_OVER_ 开头）。
 */
export function parseCarryOverRefs(raw: unknown): CarryOverRef[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw contractError('INVALID_ARGS', {
      reason_code: 'CARRY_OVER_REFS_INVALID',
      message: 'carry_over_refs 必须是数组',
      detail: { path: 'carry_over_refs' },
    })
  }
  const out: CarryOverRef[] = []
  for (const [index, item] of raw.entries()) {
    const path = `carry_over_refs[${index}]`
    if (!isPlainObject(item)) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_REF_INVALID',
        message: `${path} 必须是普通对象`,
        detail: { path },
      })
    }
    const keys = Object.keys(item).sort()
    const exactKeys = keys.length === REF_KEYS.length
      && keys.every((key, position) => key === (REF_KEYS[position] as string))
    if (!exactKeys) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_REF_INVALID',
        message: `${path} 必须恰好只有 source_application_id / ref_kind / ref_id 三个键`,
        detail: { path, keys },
      })
    }
    const source = item.source_application_id
    if (!isUuid(source)) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_REF_INVALID',
        message: `${path}.source_application_id 必须是 UUID 文本`,
        detail: { path: `${path}.source_application_id` },
      })
    }
    const kind = item.ref_kind
    if (typeof kind !== 'string' || !(CARRY_OVER_REF_KINDS as readonly string[]).includes(kind)) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_REF_INVALID',
        message: `${path}.ref_kind 必须是 ${CARRY_OVER_REF_KINDS.join(' / ')} 之一`,
        detail: { path: `${path}.ref_kind`, allowed: [...CARRY_OVER_REF_KINDS] },
      })
    }
    const refId = item.ref_id
    if (!isUuid(refId)) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_REF_INVALID',
        message: `${path}.ref_id 必须是 UUID 文本`,
        detail: { path: `${path}.ref_id` },
      })
    }
    // 统一小写：UUID 比较本身大小写不敏感，归一化后幂等去重的判定也确定。
    out.push({
      source_application_id: source.toLowerCase(),
      ref_kind: kind as CarryOverRefKind,
      ref_id: refId.toLowerCase(),
    })
  }
  return out
}

/** 一条申请在本租户内的身份（只需要 id + candidate_id）。 */
interface ApplicationIdentity {
  readonly id: string
  readonly candidate_id: string
}

/** 读申请（**只读**；租户过滤保证跨租户查不到 ⇒ 由调用方 fail-closed）。 */
async function loadApplication(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
): Promise<ApplicationIdentity | null> {
  const { rows } = await client.query<ApplicationIdentity>(
    `select a.id, a.candidate_id
       from recruitment.application a
      where a.tenant_id = $1 and a.id = $2`,
    [tenantId, applicationId],
  )
  return rows[0] ?? null
}

/** ref 是否真的属于源申请（按 ref_kind 分三表，join 口径与读投影一致）。 */
async function refBelongsToSource(
  client: DatabaseClient,
  tenantId: string,
  ref: CarryOverRef,
): Promise<boolean> {
  let sql: string
  if (ref.ref_kind === 'SCORECARD') {
    sql = `select 1 as one
             from recruitment.scorecard s
             join recruitment.interview i
               on i.id = s.interview_id and i.tenant_id = s.tenant_id
            where s.tenant_id = $1 and s.id = $2 and i.application_id = $3
            limit 1`
  } else if (ref.ref_kind === 'TRANSCRIPT') {
    // 与 business-read.ts::queryTranscriptRows 同一条可达路径：面试 → 有效会议绑定 → 产物。
    sql = `select 1 as one
             from recruitment.transcript_artifact ta
             join recruitment.meeting_binding mb
               on mb.tenant_id = ta.tenant_id and mb.meeting_id = ta.meeting_id and mb.unbound_at is null
             join recruitment.interview i
               on i.id = mb.interview_id and i.tenant_id = mb.tenant_id
            where ta.tenant_id = $1 and ta.id = $2 and i.application_id = $3
            limit 1`
  } else {
    sql = `select 1 as one
             from recruitment.decision d
            where d.tenant_id = $1 and d.id = $2 and d.application_id = $3
            limit 1`
  }
  const { rows } = await client.query<{ one: number }>(sql, [tenantId, ref.ref_id, ref.source_application_id])
  return rows.length > 0
}

/**
 * 在**已有事务**里校验全部 carry_over 引用；任何一条不合法就抛错，
 * 由外层 `withActor` 把整笔事务回滚（包括这次 intake 的其它写入）。
 *
 * 顺序即规则：
 *   1. 目标申请（ensureActiveApplication 返回的那一条）必须在同一租户；
 *   2. 每个 ref 的源申请必须在同一租户；
 *   3. 源 ≠ 目标（库级 `ck_carry_over_distinct_application` 的第二道防线）；
 *   4. 源、目标必须同候选人（AT-2；库级 trigger 是第二道防线）；
 *   5. ref 必须真的属于源申请（按 ref_kind 逐表 join）。
 *
 * 全部校验通过后才由 `insertCarryOverRefs()` 写库（零写入的负例由事务回滚保证）。
 * @param client - 事务内客户端。
 * @param tenantId - 租户（只来自配置）。
 * @param targetApplicationId - 目标申请 id（`ensureActiveApplication()` 的返回值）。
 * @param refs - 已通过 `parseCarryOverRefs()` 的引用。
 */
export async function validateCarryOverRefs(
  client: DatabaseClient,
  tenantId: string,
  targetApplicationId: string,
  refs: readonly CarryOverRef[],
): Promise<void> {
  if (refs.length === 0) return
  const target = await loadApplication(client, tenantId, targetApplicationId)
  if (target === null) {
    throw contractError('NOT_FOUND', {
      reason_code: 'CARRY_OVER_TARGET_NOT_FOUND',
      message: '携带历史的目标申请不在本租户下',
      detail: { application_id: targetApplicationId, tenant_id: tenantId },
    })
  }
  const sources = new Map<string, ApplicationIdentity>()
  for (const ref of refs) {
    let source = sources.get(ref.source_application_id)
    if (source === undefined) {
      const loaded = await loadApplication(client, tenantId, ref.source_application_id)
      if (loaded === null) {
        throw contractError('NOT_FOUND', {
          reason_code: 'CARRY_OVER_REF_NOT_FOUND',
          message: '携带历史的源申请不在本租户下（跨租户或不存在）',
          detail: { source_application_id: ref.source_application_id, ref_kind: ref.ref_kind, ref_id: ref.ref_id },
        })
      }
      sources.set(loaded.id, loaded)
      source = loaded
    }
    if (source.id === target.id) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_SOURCE_IS_TARGET',
        message: '携带历史的源申请与目标申请不能是同一条',
        detail: { application_id: target.id },
      })
    }
    if (source.candidate_id !== target.candidate_id) {
      throw contractError('INVALID_ARGS', {
        reason_code: 'CARRY_OVER_CANDIDATE_MISMATCH',
        message: 'AT-2：跨岗携带历史只允许同一候选人的申请之间',
        detail: {
          target_application_id: target.id,
          target_candidate_id: target.candidate_id,
          source_application_id: source.id,
          source_candidate_id: source.candidate_id,
        },
      })
    }
    if (!(await refBelongsToSource(client, tenantId, ref))) {
      throw contractError('NOT_FOUND', {
        reason_code: 'CARRY_OVER_REF_NOT_FOUND',
        message: '该引用不属于源申请（按 ref_kind 逐表校验）',
        detail: {
          source_application_id: ref.source_application_id,
          ref_kind: ref.ref_kind,
          ref_id: ref.ref_id,
        },
      })
    }
  }
}

/**
 * 只 INSERT `application_carry_over`，不改任何旧申请（AT-1）。
 *
 * 幂等：唯一键 `uq_application_carry_over_ref` + `on conflict ... do nothing`，
 * 同一 (源, 目标, ref) 重复提交不会产生第二行，也不报错。
 * @param actorId - **写 actor**（调用方传 `cfg.database.actor_id`，由 withActor GUC 解析而来），
 *   绝不接受模型入参。
 * @returns 真正插入的行数（被 on conflict 吞掉的重复提交不计）。
 */
export async function insertCarryOverRefs(
  client: DatabaseClient,
  tenantId: string,
  applicationId: string,
  refs: readonly CarryOverRef[],
  actorId: string,
): Promise<number> {
  let inserted = 0
  for (const ref of refs) {
    const { rows } = await client.query<{ id: string }>(
      `insert into recruitment.application_carry_over
         (tenant_id, application_id, source_application_id, ref_kind, ref_id, carried_by_actor_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id, application_id, source_application_id, ref_kind, ref_id) do nothing
       returning id`,
      [tenantId, applicationId, ref.source_application_id, ref.ref_kind, ref.ref_id, actorId],
    )
    inserted += rows.length
  }
  return inserted
}
